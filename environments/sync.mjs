#!/usr/bin/env node
// Creates or updates a Cursor Cloud Agent environment for every repos/<owner>/<repo>/Dockerfile,
// sets the Langfuse secrets, starts a build, and records the environment ids in ids.json
// (read by automations/main.tf). Safe to re-run. Needs Node 20.6+, no packages.
//
//   node --env-file=.env environments/sync.mjs [owner/repo] [--dry-run] [--no-build]

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

const API = "https://api.cursor.com";
const ROOT = new URL("./", import.meta.url).pathname;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: { "dry-run": { type: "boolean" }, "no-build": { type: "boolean" } },
});
const only = positionals[0];

const readText = (path) => readFileSync(ROOT + path, "utf8");
const readJson = (path) => JSON.parse(readText(path));

const langfuse = readJson("shared/langfuse.json");

const secrets = [
  // Runtime secrets are redacted from agent output; plain env vars are not.
  { name: "LANGFUSE_PUBLIC_KEY", value: process.env.LANGFUSE_PUBLIC_KEY, type: "runtime_secret" },
  { name: "LANGFUSE_SECRET_KEY", value: process.env.LANGFUSE_SECRET_KEY, type: "runtime_secret" },
  ...Object.entries(langfuse.env).map(([name, value]) => ({ name, value, type: "environment_variable" })),
];

// "owner/repo" for every repos/ folder holding a Dockerfile.
function repoNames() {
  return readdirSync(ROOT + "repos", { recursive: true })
    .filter((path) => path.endsWith("/Dockerfile"))
    .map((path) => dirname(path))
    .filter((repo) => !only || repo === only);
}

// An inline Dockerfile can't COPY, so the Langfuse hook CLI and start script are added as layers.
function dockerfile(repo) {
  const startScript = Buffer.from(readText("shared/langfuse-start.sh")).toString("base64");
  return [
    readText(`repos/${repo}/Dockerfile`).trimEnd(),
    `RUN sudo npm install -g @langfuse/cursor-observability-plugin`,
    `RUN echo ${startScript} | base64 -d | sudo tee /usr/local/bin/langfuse-start.sh > /dev/null \\`,
    ` && sudo chmod +x /usr/local/bin/langfuse-start.sh`,
    ``,
  ].join("\n");
}

// Optional repos/<owner>/<repo>/environment.json adds repo-specific install, terminals, ...
function environmentJson(repo) {
  const path = `repos/${repo}/environment.json`;
  const extras = existsSync(ROOT + path) ? readJson(path) : {};
  return JSON.stringify({
    ...extras,
    start: "bash /usr/local/bin/langfuse-start.sh",
    egressAllowlist: [langfuse.host],
    build: { dockerfileContents: dockerfile(repo) },
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
  const { items = [] } = await api("GET", `/v1/environments?owner=team&query=${encodeURIComponent(name)}`);
  const existing = items.find((environment) => environment.name === name);

  if (existing) {
    await api("PATCH", `/v1/environments/${existing.id}`, { name, environmentJson });
    return existing.id;
  }
  const created = await api("POST", "/v1/environments", {
    owner: "team",
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
