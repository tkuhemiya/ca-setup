#!/usr/bin/env node
// Seeds Langfuse with dummy traces shaped like the Cursor plugin's, plus a matching fake usage file,
// to try enrich.mjs at volume. Traces go to their own Langfuse environment (default "dummy"), so
// dashboards filtered to real environments don't show them. Each trace points at a real Cursor run id
// taken from existing traces, so enrich.mjs's Cursor lookups work as they would for real runs.
//
//   node --env-file=.env observability/fixtures/seed-dummy.mjs [--runs 50] [--environment dummy] [--usage-out <path>]
//   node --env-file=.env observability/enrich.mjs --environment dummy --since 2d --usage-file <path>

import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: flags } = parseArgs({
  options: {
    runs: { type: "string", default: "50" },
    environment: { type: "string", default: "dummy" },
    "usage-out": { type: "string", default: "/tmp/ca-setup-dummy-usage.json" },
  },
});

const env = process.env;
const auth = `Basic ${Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString("base64")}`;
const hex = (bytes) => randomBytes(bytes).toString("hex");
const nanos = (ms) => String(ms * 1_000_000);
const attr = (key, value) => ({ key, value: { stringValue: typeof value === "string" ? value : JSON.stringify(value) } });
const random = (min, max) => Math.round(min + Math.random() * (max - min));

async function langfuse(path, init = {}) {
  const response = await fetch(env.LANGFUSE_BASE_URL + path, {
    ...init,
    headers: { Authorization: auth, "Content-Type": "application/json", "x-langfuse-ingestion-version": "4" },
  });
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

// Real run ids from the plugin's traces of the last week.
const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
const { data } = await langfuse(`/api/public/v2/observations?type=AGENT&environment=cloud-agent&fromStartTime=${since}&limit=100&fields=core,metadata`);
const runIds = [...new Set(data.map((o) => o.metadata?.["cursor.conversation_id"]).filter((id) => id?.startsWith("bc-")))];
if (runIds.length === 0) throw new Error("No real Cursor traces in the last week to borrow run ids from");

const count = Number(flags.runs);
const model = "cursor-grok-4.6-medium";
const spans = [];
for (let i = 0; i < count; i++) {
  // Spread over the last day, all finished more than 2 hours ago so their usage counts as settled.
  const start = Date.now() - 3 * 3_600_000 - Math.floor((i / count) * 21 * 3_600_000);
  const end = start + random(30, 180) * 1000;
  const traceId = hex(16);
  const rootId = hex(8);
  const runId = runIds[i % runIds.length];
  const span = (name, type, from, to, extra = [], parent = rootId) => ({
    traceId,
    spanId: hex(8),
    ...(parent ? { parentSpanId: parent } : {}),
    name,
    kind: 1,
    startTimeUnixNano: nanos(from),
    endTimeUnixNano: nanos(to),
    attributes: [attr("langfuse.observation.type", type), attr("langfuse.environment", flags.environment), ...extra],
  });

  spans.push({ ...span("Cursor Turn", "agent", start, end, [attr("langfuse.observation.metadata.cursor.conversation_id", runId), attr("langfuse.observation.metadata.cursor.model", model)], null), spanId: rootId });
  spans.push(span("LLM", "generation", start, end, [attr("langfuse.observation.model.name", model)]));
  for (const [t, tool] of ["Read", "Grep", "Shell"].entries()) {
    const toolStart = start + (t + 1) * 5000;
    spans.push(span(tool, "tool", toolStart, toolStart + random(200, 2000), [attr("langfuse.observation.input", { dummy: true, tool })]));
  }
}

for (let i = 0; i < spans.length; i += 500) {
  const body = { resourceSpans: [{ resource: { attributes: [attr("service.name", "ca-setup-seed")] }, scopeSpans: [{ scope: { name: "ca-setup-seed" }, spans: spans.slice(i, i + 500) }] }] };
  await langfuse("/api/public/otel/v1/traces", { method: "POST", body: JSON.stringify(body) });
}

// Fake usage events in the Admin API's shape, one run's worth per borrowed run id.
const usageEvents = runIds.map((cloudAgentId) => {
  const input = random(20_000, 120_000);
  const cents = Math.round(random(5, 40)) / 10;
  return {
    timestamp: String(Date.now() - 3 * 3_600_000),
    cloudAgentId,
    automationId: "dummy",
    conversationId: cloudAgentId,
    model: "grok-4.6",
    isTokenBasedCall: true,
    tokenUsage: { inputTokens: input, outputTokens: random(1_000, 6_000), cacheReadTokens: Math.round(input * 0.6), cacheWriteTokens: 0, totalCents: cents },
    chargedCents: cents,
  };
});
writeFileSync(flags["usage-out"], JSON.stringify({ usageEvents }, null, 2));

console.log(`seeded ${count} dummy traces (${spans.length} spans) in environment "${flags.environment}", borrowing ${runIds.length} real run ids`);
console.log(`fake usage written to ${flags["usage-out"]}`);
