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

// Plain env vars for the Langfuse hooks; the keys come from .env as runtime secrets.
const langfuseEnv = readJson("shared/langfuse.json");

const secrets = [
  // Runtime secrets are redacted from agent output; plain env vars are not.
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

// Commands are sent base64-wrapped: Cursor re-quotes them, which breaks commands containing quotes.
const inline = (script) => `echo ${Buffer.from(script).toString("base64")} | base64 -d | bash`;

// Runs the shared script, then the repo's own commands (if any) as a separate step.
const withShared = (sharedScript, own, separator) =>
  [inline(readText(sharedScript)), own && inline(own)].filter(Boolean).join(separator);

// repos/<owner>/<repo>/environment.json is sent as-is, with the shared setup run before its commands.
function environmentJson(repo) {
  const { install, start, ...rest } = readJson(`repos/${repo}/environment.json`);
  return JSON.stringify({
    ...rest,
    install: withShared("shared/install.sh", install, " && "), // build fails if either fails
    start: withShared("shared/langfuse-start.sh", start, "; "), // Langfuse setup never blocks the repo's start
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

async function syncRepo(repo) {
  console.log(`\n${repo}`);

  const id = await upsertEnvironment(`agents-${repo.replace("/", "-")}`, `https://github.com/${repo}`, environmentJson(repo));
  console.log(`  environment id: ${id}`);

  for (const { name, value, type } of secrets) {
    await api("PUT", `/v1/environments/${id}/secrets/${name}`, { value, type });
  }
  console.log(`  ${secrets.length} secrets set`);

  if (!flags["no-build"]) {
    const build = await api("POST", `/v1/environments/${id}/builds`);
    console.log(`  build started: ${build.id}`);
  }
  return id;
}

if (flags["dry-run"]) {
  const [first] = repoNames();
  console.log("Would sync:", repoNames().join(", "));
  console.log(`\nenvironmentJson for ${first}:`, JSON.stringify(JSON.parse(environmentJson(first)), null, 2));
  process.exit(0);
}

for (const key of ["CURSOR_TOKEN", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"]) {
  if (!process.env[key]) throw new Error(`Missing ${key} (see .env.example)`);
}

// Merge, so syncing a single repo keeps the other ids.
const ids = existsSync(ROOT + "ids.json") ? readJson("ids.json") : {};
for (const repo of repoNames()) {
  ids[repo] = await syncRepo(repo);
  writeFileSync(ROOT + "ids.json", JSON.stringify(ids, Object.keys(ids).sort(), 2) + "\n");
}
