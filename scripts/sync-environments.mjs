#!/usr/bin/env node
// Makes Cursor's Cloud Agent environments match repos/<repo>/environment.json: one environment per folder, with
// its variables and secrets. It reads what Cursor has and changes only what differs, so it is safe to re-run.
// It also writes ids.json, where the Terraform module finds each repo's environment. Needs Node 20.6+, no packages.
//
//   node --env-file=.env scripts/sync-environments.mjs [--plan] [--build <repo>]...
//
//   --plan          Change nothing. Print what a sync would do and write ids.json.
//   --build <repo>  Build this repo's environment even when nothing changed. Use it after a failed build, or
//                   after giving an existing secret a new value. Repeatable.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const API = "https://api.cursor.com";
// "team" needs a key on a Cursor team (e.g. a service account); "personal" works for any key.
const OWNER = process.env.CURSOR_ENVIRONMENT_OWNER || "team";
const ROOT = new URL("../", import.meta.url).pathname;

const { values: flags } = parseArgs({
  options: { plan: { type: "boolean" }, build: { type: "string", multiple: true, default: [] } },
});

const readText = (path) => readFileSync(ROOT + path, "utf8");
const readJson = (path) => JSON.parse(readText(path));

// { host, workspace }: where the repos live. The workspace is the GitHub user or org, or the Bitbucket workspace.
// A repo in another workspace names itself in its environment.json.
const settings = readJson("settings.json");

// Runtime secrets are redacted from agent output; plain env vars are not. A secret's value comes from the
// variable `from` in this process's environment: a CI secured variable, or a line in .env.
const secret = (name, from) => ({ name, type: "runtime_secret", value: process.env[from], from });
const plain = (name, value) => ({ name, type: "environment_variable", value: String(value) });

// Commands are sent base64-wrapped: Cursor re-quotes them, which breaks commands containing quotes.
const base64 = (text) => Buffer.from(text).toString("base64");
const inline = (script) => `echo ${base64(script)} | base64 -d | bash`;

// A repo's install/start is a string or an array of lines; lines run as one script that stops at the first failure.
const script = (own) => (Array.isArray(own) ? ["set -euo pipefail", ...own].join("\n") : own);

// What a traced environment gets on top of the repo's own setup. The stop hook and the exporter it starts are
// copied to the agent's machine, tracing/install.sh registers the hook, and the exporter needs these keys.
const tracing = {
  variables: [
    secret("CURSOR_TOKEN", "CURSOR_TOKEN"),
    secret("LANGFUSE_PUBLIC_KEY", "LANGFUSE_PUBLIC_KEY"),
    secret("LANGFUSE_SECRET_KEY", "LANGFUSE_SECRET_KEY"),
    ...Object.entries(readJson("tracing/langfuse.json")).map(([name, value]) => plain(name, value)),
  ],
  install: [
    inline(
      [
        'mkdir -p "$HOME/.agent-trace"',
        ...["export.mjs", "stop-hook.mjs"].map((file) => `echo ${base64(readText(`observability/${file}`))} | base64 -d > "$HOME/.agent-trace/${file}"`),
      ].join("\n"),
    ),
    inline(readText("tracing/install.sh")),
  ],
  start: inline(readText("tracing/langfuse-start.sh")),
};

// What one repos/<folder>/environment.json asks Cursor for. Fields this script doesn't know go to Cursor as they are.
function wanted(folder) {
  const { repo = `${settings.workspace}/${folder}`, install, start, variables = {}, secrets = [], tracing: traced = true, ...rest } = readJson(
    `repos/${folder}/environment.json`,
  );
  const own = { install: install && inline(script(install)), start: start && inline(script(start)) };
  const prefix = folder.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const all = [
    ...(traced ? tracing.variables : []),
    ...Object.entries(variables).map(([name, value]) => plain(name, value)),
    ...secrets.map((name) => secret(name, `${prefix}_${name}`)),
  ];
  const names = all.map((variable) => variable.name);
  const repeated = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
  if (repeated.length) {
    throw new Error(
      `repos/${folder}/environment.json sets ${repeated.join(", ")} more than once. With tracing on, sync sets ${tracing.variables.map((variable) => variable.name).join(", ")} itself.`,
    );
  }
  return {
    folder,
    repo,
    name: `automation-${repo.replace("/", "-")}`,
    environmentJson: JSON.stringify({
      ...rest,
      // A failed step fails the build. In start, saving the keys must never stop the repo's own command.
      install: traced ? [...tracing.install, own.install].filter(Boolean).join(" && ") : own.install,
      start: traced ? [tracing.start, own.start].filter(Boolean).join("; ") : own.start,
    }),
    variables: all,
  };
}

async function api(method, path, body) {
  const response = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${process.env.CURSOR_TOKEN}`, "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const folders = readdirSync(ROOT + "repos")
  .filter((folder) => existsSync(`${ROOT}repos/${folder}/environment.json`))
  .sort();
const environments = folders.map(wanted);

// A plan sends no values, so it needs only the key that reads the API.
const needed = ["CURSOR_TOKEN", ...(flags.plan ? [] : environments.flatMap((environment) => environment.variables).map((variable) => variable.from))];
const problems = [
  ...[...new Set(needed)].filter((name) => name && !process.env[name]).map((name) => `${name} is not set`),
  ...flags.build.filter((folder) => !folders.includes(folder)).map((folder) => `--build ${folder}: there is no repos/${folder}/environment.json`),
];
if (problems.length) throw new Error(`Can't sync:\n  ${problems.join("\n  ")}\nSecrets come from CI variables or .env (see .env.example).`);

const ids = {};
for (const want of environments) {
  const found = await api("GET", `/v1/environments?owner=${OWNER}&query=${encodeURIComponent(want.name)}`);
  const existing = found.items?.find((environment) => environment.name === want.name);
  // GET /v1/environments/{id} left environmentJson out when tried (2026-11-16). The history's current event has it.
  const saved = existing && (await api("GET", `/v1/environments/${existing.id}/history`)).items.find((event) => event.current)?.environmentJson;
  // Cursor never returns a value, only names and types, so a changed value can't be seen from here.
  const has = existing ? ((await api("GET", `/v1/environments/${existing.id}/secrets`)).items ?? []) : [];

  const config = !existing ? "create" : saved === want.environmentJson ? "unchanged" : "update";
  const added = want.variables.filter((variable) => !has.some((other) => other.name === variable.name && other.type === variable.type)).map((variable) => variable.name);
  const removed = has.map((other) => other.name).filter((name) => !want.variables.some((variable) => variable.name === name));
  // Agents get a changed variable only from a build made after the change.
  const build = config !== "unchanged" || added.length > 0 || removed.length > 0 || flags.build.includes(want.folder);

  console.log(`\n${want.name} (repos/${want.folder})`);
  console.log(`  environment: ${config}`);
  console.log(`  variables: ${want.variables.length}${added.length ? `, adding ${added.join(", ")}` : ""}${removed.length ? `, removing ${removed.join(", ")}` : ""}`);
  console.log(`  build: ${build ? "yes" : "no"}`);

  let id = existing?.id;
  if (!flags.plan) {
    if (config === "create") {
      const created = await api("POST", "/v1/environments", {
        owner: OWNER,
        name: want.name,
        repos: [{ url: `https://${settings.host}/${want.repo}` }],
        environmentJson: want.environmentJson,
      });
      id = created.id;
    }
    if (config === "update") await api("PATCH", `/v1/environments/${id}`, { environmentJson: want.environmentJson });
    for (const { name, type, value } of want.variables) await api("PUT", `/v1/environments/${id}/secrets/${name}`, { value, type });
    for (const name of removed) await api("DELETE", `/v1/environments/${id}/secrets/${name}`);
    if (build) console.log(`  build started: ${(await api("POST", `/v1/environments/${id}/builds`)).id}`);
  }
  // In a plan, an environment that doesn't exist yet has no id. Terraform shows "pending" until the real sync.
  ids[want.folder] = { id: id ?? "pending", host: settings.host, repo: want.repo };
}
writeFileSync(ROOT + "ids.json", JSON.stringify(ids, null, 2) + "\n");

// An environment whose folder was deleted stays in Cursor. Report it; deleting it is a person's call.
const managed = new Set(environments.map((environment) => environment.name));
let cursor;
do {
  const page = await api("GET", `/v1/environments?owner=${OWNER}&query=automation-&limit=100${cursor ? `&cursor=${cursor}` : ""}`);
  for (const environment of page.items ?? []) {
    if (environment.name?.startsWith("automation-") && !managed.has(environment.name)) {
      console.log(`\n${environment.name} (${environment.id}) has no folder in repos/. Delete it in the Cursor dashboard if it's no longer used.`);
    }
  }
  cursor = page.nextCursor;
} while (cursor);

console.log(flags.plan ? "\nPlan only. Nothing was changed." : "\nDone.");
