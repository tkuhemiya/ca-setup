#!/usr/bin/env node
// Adds to each Cloud Agent trace in Langfuse what the hooks can't send: a "Run details" span with the
// run's prompt and final message, which automation ran (review, fix, ...) and on which repo, and, with a
// Cursor Admin API key (Enterprise only), a "Run usage" generation with the run's tokens and cost.
//
// Each span id is written exactly once. Langfuse v4 keeps every write to an id but doesn't reliably show
// the latest, so rewriting a span (ours or the plugin's) can flip back to an older version. A span that
// already exists means that step is done, so later passes skip it. Needs Node 20.6+, no packages.
//
//   node --env-file=.env observability/enrich.mjs [--since 6h] [--dry-run] [--usage-file <path>] [--environment <name>]
//
// --usage-file reads usage events from a saved Admin API response instead of calling the API,
// for testing the cost path without an Enterprise key (see fixtures/; use it with --dry-run).

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { parseArgs } from "node:util";

const ROOT = new URL("../", import.meta.url).pathname;
const CURSOR_API = "https://api.cursor.com";
const DETAILS = "Run details";
const USAGE = "Run usage";
// Cursor aggregates usage events hourly, so a run's usage can arrive in pieces. "Run usage" is written
// once and never corrected, so wait until the run has been finished this long before writing it.
const USAGE_SETTLE_MS = 2 * 3_600_000;

const { values: flags } = parseArgs({
  options: {
    since: { type: "string", default: "6h" },
    "dry-run": { type: "boolean" },
    "usage-file": { type: "string" },
    environment: { type: "string" },
  },
});

const env = process.env;
for (const key of ["CURSOR_TOKEN", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL"]) {
  if (!env[key]) throw new Error(`Missing ${key} (see .env.example)`);
}

function sinceMs(text) {
  const match = /^(\d+)([mhd])$/.exec(text);
  if (!match) throw new Error(`--since takes e.g. 30m, 2h or 1d, not ${text}`);
  return Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
}

async function request(url, { auth, method = "GET", body, headers = {} }) {
  const response = await fetch(url, {
    method,
    headers: { Authorization: auth, "Content-Type": "application/json", ...headers },
    body: body && JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const basic = (user, password = "") => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
const cursorApi = (path) => request(CURSOR_API + path, { auth: `Bearer ${env.CURSOR_TOKEN}` });
const langfuseAuth = basic(env.LANGFUSE_PUBLIC_KEY, env.LANGFUSE_SECRET_KEY);

// Every page of a Langfuse v2 observations query.
async function observations(params) {
  const all = [];
  let cursor;
  do {
    const query = new URLSearchParams({ limit: "100", fields: "core,basic,metadata,io,model,usage", ...params });
    if (cursor) query.set("cursor", cursor);
    const page = await request(`${env.LANGFUSE_BASE_URL}/api/public/v2/observations?${query}`, { auth: langfuseAuth });
    all.push(...page.data);
    cursor = page.meta?.cursor;
  } while (cursor);
  // Right after a re-send, Langfuse lists the same id once per write until it merges them.
  return [...new Map(all.map((o) => [o.id, o])).values()];
}

// Prompt text -> which automation it belongs to, read from the prompt files in automations/.
// repos/<owner>/<repo>/review.md -> { kind: "review", repo }; prompts/fix.md -> { kind: "fix" }.
function promptIndex() {
  const index = new Map();
  for (const folder of ["automations/repos", "automations/prompts"]) {
    for (const path of readdirSync(ROOT + folder, { recursive: true })) {
      if (!path.endsWith(".md")) continue;
      const repo = folder.endsWith("repos") ? dirname(path) : undefined;
      index.set(readFileSync(`${ROOT}${folder}/${path}`, "utf8").trim(), { kind: basename(path, ".md"), repo });
    }
  }
  return index;
}

// Usage events for every automation run in the window, from the Admin API (Enterprise) or a saved file.
async function usageEvents(from, to) {
  if (flags["usage-file"]) return JSON.parse(readFileSync(flags["usage-file"], "utf8")).usageEvents;
  if (!env.CURSOR_ADMIN_API_KEY) return [];

  const events = [];
  for (let page = 1; ; page++) {
    const body = { startDate: from.getTime(), endDate: to.getTime(), automationId: "*", page, pageSize: 1000 };
    const response = await request(`${CURSOR_API}/teams/filtered-usage-events`, {
      auth: basic(env.CURSOR_ADMIN_API_KEY),
      method: "POST",
      body,
    });
    events.push(...response.usageEvents);
    if (!response.pagination?.hasNextPage) return events;
  }
}

// One total per run. Grouping by run id rather than conversation id keeps subagent calls in the run.
function usageByRun(events) {
  const totals = new Map();
  for (const event of events) {
    if (!event.cloudAgentId) continue;
    const total = totals.get(event.cloudAgentId) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cents: 0 };
    const tokens = event.tokenUsage ?? {};
    total.input += tokens.inputTokens ?? 0;
    total.output += tokens.outputTokens ?? 0;
    total.cacheRead += tokens.cacheReadTokens ?? 0;
    total.cacheWrite += tokens.cacheWriteTokens ?? 0;
    total.cents += event.chargedCents ?? 0;
    totals.set(event.cloudAgentId, total);
  }
  return totals;
}

async function describeRun(runId, prompts) {
  const [agent, conversation] = await Promise.all([cursorApi(`/v0/agents/${runId}`), cursorApi(`/v0/agents/${runId}/conversation`)]);
  const prompt = conversation.messages.find((m) => m.type === "user_message")?.text ?? "";
  const finalMessage = conversation.messages.findLast((m) => m.type === "assistant_message")?.text ?? "";
  const automation = prompts.get(prompt.trim());
  const repo = automation?.repo ?? agent.source.repository.replace(/^(https:\/\/)?github\.com\//, "");
  // A prompt that matches no file is an agent started by hand in one of our environments.
  return { url: agent.target.url, prompt, finalMessage, kind: automation?.kind ?? "manual", repo };
}

const attribute = (key, value) =>
  Array.isArray(value)
    ? { key, value: { arrayValue: { values: value.map((v) => ({ stringValue: String(v) })) } } }
    : { key, value: { stringValue: typeof value === "string" ? value : JSON.stringify(value) } };

const nanos = (iso) => String(Date.parse(iso) * 1_000_000);
// Same derivation the plugin uses for its own span ids, with our own labels.
const spanIdFor = (traceId, label) => createHash("sha256").update(`${traceId}:${label}`).digest("hex").slice(0, 16);

// A child span of the plugin's root span, at the root's start time so it sorts first in the trace.
function childSpan(root, name, attributes) {
  return {
    resource: { attributes: [attribute("service.name", "ca-setup-enrich")] },
    scopeSpans: [
      {
        scope: { name: "ca-setup-enrich" },
        spans: [
          {
            traceId: root.traceId,
            spanId: spanIdFor(root.traceId, name),
            parentSpanId: root.id,
            name,
            kind: 1,
            startTimeUnixNano: nanos(root.startTime),
            endTimeUnixNano: nanos(root.startTime),
            // Same environment as the run, so environment filters in Langfuse keep them together.
            attributes: root.environment ? [...attributes, attribute("langfuse.environment", root.environment)] : attributes,
          },
        ],
      },
    ],
  };
}

const detailsSpan = (root, run) =>
  childSpan(root, DETAILS, [
    attribute("langfuse.observation.type", "span"),
    attribute("langfuse.observation.input", run.prompt),
    attribute("langfuse.observation.output", run.finalMessage),
    attribute("langfuse.trace.tags", [...pluginTags, run.kind, run.repo]),
    attribute("langfuse.observation.metadata.automation", run.kind),
    attribute("langfuse.observation.metadata.repo", run.repo),
    attribute("langfuse.observation.metadata.cursor_run_url", run.url),
  ]);

// Named after the model the plugin recorded, so the cost lands on the same row in Langfuse dashboards.
const usageSpan = (root, usage) =>
  childSpan(root, USAGE, [
    attribute("langfuse.observation.type", "generation"),
    attribute("langfuse.observation.model.name", root.metadata["cursor.model"] ?? "unknown"),
    attribute("langfuse.observation.usage_details", {
      input: Math.max(0, usage.input - usage.cacheRead - usage.cacheWrite),
      output: usage.output,
      cache_read_input_tokens: usage.cacheRead,
      cache_creation_input_tokens: usage.cacheWrite,
      total: usage.input + usage.output,
    }),
    attribute("langfuse.observation.cost_details", { total: usage.cents / 100 }),
  ]);

// The plugin tags every trace `cursor` plus LANGFUSE_TAGS; keep those when adding ours.
const pluginTags = ["cursor", ...JSON.parse(readFileSync(`${ROOT}environments/shared/langfuse.json`, "utf8")).LANGFUSE_TAGS.split(",")];

const to = new Date();
const from = new Date(to.getTime() - sinceMs(flags.since));
const prompts = promptIndex();
const usage = usageByRun(await usageEvents(from, to));
// --environment limits the job to one Langfuse environment, e.g. to test against seeded dummy traces.
const window = { fromStartTime: from.toISOString(), ...(flags.environment ? { environment: flags.environment } : {}) };
const roots = (await observations({ type: "AGENT", ...window })).filter((o) => o.metadata?.["cursor.conversation_id"]?.startsWith("bc-"));

// Which of our spans each trace already has. Not filtered by environment: spans written before they
// carried one are stored under "default", and a missed match here means writing a span twice.
const written = new Set();
for (const name of [DETAILS, USAGE]) {
  for (const span of await observations({ name, fromStartTime: window.fromStartTime })) written.add(`${span.traceId}:${name}`);
}

// Each Cursor call takes about 1.5 s, so fetch several runs at once.
async function inParallel(items, limit, work) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const resourceSpans = [];
await inParallel(roots, 8, async (root) => {
  const runId = root.metadata["cursor.conversation_id"];
  const runUsage = usage.get(runId);
  const needsDetails = !written.has(`${root.traceId}:${DETAILS}`);
  const settled = Date.now() - Date.parse(root.endTime ?? root.startTime) > USAGE_SETTLE_MS;
  const needsUsage = runUsage && settled && !written.has(`${root.traceId}:${USAGE}`);

  if (needsDetails) {
    const run = await describeRun(runId, prompts);
    resourceSpans.push(detailsSpan(root, run));
    console.log(`${runId}: ${run.kind} on ${run.repo}`);
  }
  if (needsUsage) {
    resourceSpans.push(usageSpan(root, runUsage));
    console.log(`${runId}: ${runUsage.input + runUsage.output} tokens, $${(runUsage.cents / 100).toFixed(2)}`);
  }
});

const traced = new Set(roots.map((root) => root.metadata["cursor.conversation_id"]));
for (const runId of usage.keys()) {
  if (!traced.has(runId)) console.log(`${runId}: has usage but no trace in Langfuse, skipped`);
}

if (resourceSpans.length === 0) {
  console.log("nothing to enrich");
} else if (flags["dry-run"]) {
  console.log(JSON.stringify({ resourceSpans }, null, 2)); // the exact body a real run would POST
} else {
  // Batches keep each request small when a pass covers many runs.
  for (let i = 0; i < resourceSpans.length; i += 100) {
    await request(`${env.LANGFUSE_BASE_URL}/api/public/otel/v1/traces`, {
      auth: langfuseAuth,
      method: "POST",
      headers: { "x-langfuse-ingestion-version": "4" }, // without it, data can take up to 10 minutes to appear
      body: { resourceSpans: resourceSpans.slice(i, i + 100) },
    });
  }
  console.log(`wrote ${resourceSpans.length} span(s)`);
}
