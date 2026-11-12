#!/usr/bin/env node
// Creates or updates a Cursor Cloud Agent environment for every repos/<owner>/<repo>/environment.json,
// sets the Langfuse secrets, starts a build, and records the environment ids in ids.json
// (read by automations/main.tf). Safe to re-run. Needs Node 20.6+, no packages.
//
//   node --env-file=.env environments/sync.mjs [owner/repo] [--dry-run] [--no-build]

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

const API = "https://api.cursor.com";
// "team" needs a key on a Cursor team (e.g. a service account); "personal" works for any key.
const OWNER = process.env.CURSOR_ENVIRONMENT_OWNER || "team";
const ROOT = new URL("./", import.meta.url).pathname;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: { "dry-run": { type: "boolean" }, "no-build": { type: "boolean" } },
});
const only = positionals[0];

const readText = (path) => readFileSync(ROOT + path, "utf8");
const readJson = (path) => JSON.parse(readText(path));

// Plain env vars for the exporter; the keys come from .env as runtime secrets.
const langfuseEnv = readJson("shared/langfuse.json");

const secrets = [
  // Runtime secrets are redacted from agent output; plain env vars are not.
  { name: "CURSOR_TOKEN", value: process.env.CURSOR_TOKEN, type: "runtime_secret" },
  { name: "LANGFUSE_PUBLIC_KEY", value: process.env.LANGFUSE_PUBLIC_KEY, type: "runtime_secret" },
  { name: "LANGFUSE_SECRET_KEY", value: process.env.LANGFUSE_SECRET_KEY, type: "runtime_secret" },
  ...Object.entries(langfuseEnv).map(([name, value]) => ({ name, value, type: "environment_variable" })),
];

// "owner/repo" for every repos/ folder holding an environment.json.
function repoNames() {
  return readdirSync(ROOT + "repos", { recursive: true })
    .filter((path) => path.endsWith("/environment.json"))
    .map((path) => dirname(path))
    .filter((repo) => !only || repo === only);
}

// The exporter and the stop hook run on the agent's machine. These two scripts are the only files read from
// observability/; install.sh registers the stop hook.
const repoText = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const agentTraceFiles = [
  ["observability/export.mjs", "$HOME/.agent-trace/export.mjs"],
  ["observability/stop-hook.mjs", "$HOME/.agent-trace/stop-hook.mjs"],
];
// The exporter labels a run as review or fix by matching its prompt against these files, so the build copies
// them to ~/automations/ (the exporter reads them from its parent folder, which is $HOME there).
const promptFiles = ["automations/prompts", "automations/repos"].flatMap((folder) =>
  readdirSync(new URL(`../${folder}`, import.meta.url), { recursive: true })
    .filter((path) => path.endsWith(".md"))
    .map((path) => [`${folder}/${path}`, `$HOME/${folder}/${path}`]),
);
const agentTraceInstall = () =>
  inline(
    [
      'mkdir -p "$HOME/.agent-trace"',
      ...agentTraceFiles.map(([file, target]) => `echo ${Buffer.from(repoText(file)).toString("base64")} | base64 -d > "${target}"`),
      ...promptFiles.map(([file, target]) => `mkdir -p "$(dirname "${target}")" && echo ${Buffer.from(repoText(file)).toString("base64")} | base64 -d > "${target}"`),
    ].join("\n"),
  );

// Commands are sent base64-wrapped: Cursor re-quotes them, which breaks commands containing quotes.
const inline = (script) => `echo ${Buffer.from(script).toString("base64")} | base64 -d | bash`;

// A repo's install/start is a string or an array of lines; lines run as one script that stops at the first failure.
const script = (own) => (Array.isArray(own) ? ["set -euo pipefail", ...own].join("\n") : own);

// Runs the shared script, then the repo's own commands (if any) as a separate step.
const withShared = (sharedScript, own, separator) =>
  [inline(readText(sharedScript)), own && inline(script(own))].filter(Boolean).join(separator);

// Two environments per repo. automation-<repo> runs the automations: the stop hook that exports each run to
// Langfuse, and the Cursor key. agents-<repo> is for people: only the repo's own commands, with no keys on the machine.
// repos/<owner>/<repo>/environment.json holds the repo's own commands for both.
function environmentJson(repo, automation) {
  const { install, start, ...rest } = readJson(`repos/${repo}/environment.json`);
  if (!automation) return JSON.stringify({ ...rest, install: install && inline(script(install)), start: start && inline(script(start)) });
  return JSON.stringify({
    ...rest,
    install: [agentTraceInstall(), withShared("shared/install.sh", install, " && ")].join(" && "), // build fails if any fails
    start: withShared("shared/langfuse-start.sh", start, "; "), // saving the keys never blocks the repo's start
  });
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

async function upsertEnvironment(name, repoUrl, environmentJson) {
  const { items = [] } = await api("GET", `/v1/environments?owner=${OWNER}&query=${encodeURIComponent(name)}`);
  const existing = items.find((environment) => environment.name === name);

  if (existing) {
    await api("PATCH", `/v1/environments/${existing.id}`, { name, environmentJson });
    return existing.id;
  }
  const created = await api("POST", "/v1/environments", {
    owner: OWNER,
    name,
    repos: [{ url: repoUrl }],
    environmentJson,
  });
  return created.id;
}

// Settings of the Langfuse plugin, which automation environments no longer install. Removed from both kinds.
const retiredNames = ["LANGFUSE_TRACING_ENVIRONMENT", "LANGFUSE_TAGS", "LANGFUSE_CURSOR_CAPTURE_TOOL_OUTPUT", "LANGFUSE_CURSOR_CAPTURE_FILE_CONTENT", "LANGFUSE_CURSOR_MAX_CHARS"];
// Keys and settings from earlier syncs, removed from agents- environments.
const staleNames = [...secrets.map((secret) => secret.name), ...retiredNames];

async function deleteSecret(id, name) {
  try {
    await api("DELETE", `/v1/environments/${id}/secrets/${name}`);
  } catch (error) {
    if (!error.message.includes(" 404 ")) throw error;
  }
}

async function syncRepo(repo, automation) {
  const name = `${automation ? "automation" : "agents"}-${repo.replace("/", "-")}`;
  console.log(`\n${name}`);

  const id = await upsertEnvironment(name, `https://github.com/${repo}`, environmentJson(repo, automation));
  console.log(`  environment id: ${id}`);

  if (automation) {
    for (const { name: secretName, value, type } of secrets) {
      await api("PUT", `/v1/environments/${id}/secrets/${secretName}`, { value, type });
    }
    for (const secretName of retiredNames) await deleteSecret(id, secretName);
    console.log(`  ${secrets.length} secrets set`);
  } else {
    for (const secretName of staleNames) await deleteSecret(id, secretName);
    console.log("  keys removed");
  }

  if (!flags["no-build"]) {
    const build = await api("POST", `/v1/environments/${id}/builds`);
    console.log(`  build started: ${build.id}`);
  }
  return id;
}

if (flags["dry-run"]) {
  const [first] = repoNames();
  console.log("Would sync:", repoNames().join(", "));
  console.log(`\nautomation-${first} environmentJson:`, JSON.stringify(JSON.parse(environmentJson(first, true)), null, 2));
  console.log(`\nagents-${first} environmentJson:`, JSON.stringify(JSON.parse(environmentJson(first, false)), null, 2));
  process.exit(0);
}

for (const key of ["CURSOR_TOKEN", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"]) {
  if (!process.env[key]) throw new Error(`Missing ${key} (see .env.example)`);
}

// Merge, so syncing a single repo keeps the other ids. ids.json holds the automation- environments only.
const ids = existsSync(ROOT + "ids.json") ? readJson("ids.json") : {};
for (const repo of repoNames()) {
  await syncRepo(repo, false);
  ids[repo] = await syncRepo(repo, true);
  writeFileSync(ROOT + "ids.json", JSON.stringify(ids, Object.keys(ids).sort(), 2) + "\n");
}
