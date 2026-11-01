#!/usr/bin/env node
// Builds one complete trace per finished Cloud Agent run in our environments from Cursor's API, and sends
// it over OTLP. The run stream has the prompt, every model call (thinking and text), every tool call with
// its arguments and result, and real timestamps. The usage endpoint has the run's tokens and cost. Both
// work with a personal key on the Pro plan. The hooks plugin is still needed, but only to learn the run ids.
//
// Cursor keeps a run's stream for about a day (seen on 2026-10-30: there after 15 hours, gone after 36),
// so run this at least every few hours. A run found after that gets a smaller trace from the conversation
// endpoint (prompt, messages, usage, no tool calls). Each trace is written once, when the run has settled,
// and never updated. Needs Node 20.6+, no packages.
//
//   node --env-file=.env observability/export.mjs [--since 12h] [--settle 60m] [--environment agent-runs] [--dry-run]
//
// With --run, it exports one run and nothing else, for a `stop` hook on the agent's own machine. The hook
// payload names the run (`conversation_id` is the agent id, `generation_id` the run id) and its model, so
// there's no discovery and no dedupe. It waits for the run's usage to appear, which takes about a minute.
//
//   node observability/export.mjs --run <agent id>:<run id> --model <model> [--repo owner/repo]

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { parseArgs } from "node:util";

const ROOT = new URL("../", import.meta.url).pathname;
const CURSOR_API = "https://api.cursor.com";
const ROOT_NAME = "Cursor run";
const MAX_CHARS = 20_000; // per text field, same cap the plugin used
const DONE = new Set(["FINISHED", "ERROR", "CANCELLED", "EXPIRED"]);

const { values: flags } = parseArgs({
  options: {
    since: { type: "string", default: "12h" },
    // How long after a run ends before its usage is trusted. Unverified: usage was complete on runs a
    // day old, but nobody has checked how soon after the run it is final.
    settle: { type: "string", default: "60m" },
    environment: { type: "string", default: "agent-runs" },
    "dry-run": { type: "boolean" },
    run: { type: "string" },
    model: { type: "string" },
    repo: { type: "string" },
    // How long --run waits for usage before writing the trace without it.
    "usage-wait": { type: "string", default: "10m" },
  },
});

const env = process.env;
for (const key of ["CURSOR_TOKEN", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL"]) {
  if (!env[key]) throw new Error(`Missing ${key} (see .env.example)`);
}

function durationMs(text) {
  const match = /^(\d+)([mhd])$/.exec(text);
  if (!match) throw new Error(`Durations look like 30m, 2h or 1d, not ${text}`);
  return Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
}

// Cursor rate-limits bursts with 429, so wait and retry those.
async function request(url, { auth, method = "GET", body, headers = {} }) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      method,
      headers: { Authorization: auth, "Content-Type": "application/json", ...headers },
      body: body && JSON.stringify(body),
    });
    if (response.status === 429 && attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, Number(response.headers.get("retry-after") || 2 ** attempt) * 1000));
      continue;
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${url} -> ${response.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }
}

const cursorAuth = `Bearer ${env.CURSOR_TOKEN}`;
const langfuseAuth = `Basic ${Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString("base64")}`;
const cursorApi = (path) => request(CURSOR_API + path, { auth: cursorAuth });

// The run's events, replayed from the start. The connection can stay open after `done`, so stop reading there.
// Returns undefined once Cursor has dropped the stream (410 stream_expired).
async function runEvents(agentId, runId) {
  const response = await fetch(`${CURSOR_API}/v1/agents/${agentId}/runs/${runId}/stream`, {
    headers: { Authorization: cursorAuth, Accept: "text/event-stream" },
    signal: AbortSignal.timeout(120_000),
  });
  if (response.status === 410) return undefined;
  if (!response.ok) throw new Error(`stream ${runId} -> ${response.status} ${(await response.text()).slice(0, 300)}`);

  let text = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    text += decoder.decode(chunk, { stream: true });
    if (/^event: done$/m.test(text)) break;
  }
  // Event ids are "<unix ms>-<n>", which gives every event its time.
  return text
    .split("\n\n")
    .map((block) => Object.fromEntries(block.split("\n").map((line) => [line.slice(0, line.indexOf(": ")), line.slice(line.indexOf(": ") + 2)])))
    .filter((event) => event.id && event.data)
    .map((event) => ({ type: event.event, ms: Number(event.id.split("-")[0]), data: JSON.parse(event.data) }));
}

// Prompt text -> which automation it belongs to, read from the prompt files in automations/.
// repos/<owner>/<repo>/review.md -> { kind: "review", repo }; prompts/fix.md -> { kind: "fix" }.
function promptIndex() {
  const index = new Map();
  for (const folder of ["automations/repos", "automations/prompts"]) {
    // On an agent's machine only this folder is installed, so there are no prompt files to match.
    if (!existsSync(ROOT + folder)) continue;
    for (const path of readdirSync(ROOT + folder, { recursive: true })) {
      if (!path.endsWith(".md")) continue;
      const repo = folder.endsWith("repos") ? dirname(path) : undefined;
      index.set(readFileSync(`${ROOT}${folder}/${path}`, "utf8").trim(), { kind: basename(path, ".md"), repo });
    }
  }
  return index;
}

// Model calls ("steps") with their thinking and text, and the tool calls made in each.
function steps(events) {
  const all = [];
  const calls = new Map();
  let step;
  for (const { type, ms, data } of events) {
    if (type !== "interaction_update") continue;
    if (data.type === "step-started") {
      step = { start: ms, end: ms, thinking: "", text: "", tools: [] };
      all.push(step);
    } else if (!step) {
      continue;
    } else if (data.type === "thinking-delta") {
      step.thinking += data.text;
    } else if (data.type === "text-delta") {
      step.text += data.text;
    } else if (data.type === "step-completed") {
      step.end = ms;
    } else if (data.type === "tool-call-started") {
      const call = { start: ms, end: ms, ...data.toolCall };
      calls.set(data.callId, call);
      step.tools.push(call);
    } else if (data.type === "tool-call-completed") {
      Object.assign(calls.get(data.callId) ?? {}, { end: ms, ...data.toolCall });
    }
  }
  return all;
}

const clip = (value) => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}… [${text.length - MAX_CHARS} more chars]` : text;
};

const attribute = (key, value) =>
  Array.isArray(value)
    ? { key, value: { arrayValue: { values: value.map((v) => ({ stringValue: String(v) })) } } }
    : typeof value === "number"
      ? { key, value: { intValue: String(value) } }
      : { key, value: { stringValue: typeof value === "string" ? value : JSON.stringify(value) } };

const attributes = (object) => Object.entries(object).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => attribute(k, v));
const nanos = (ms) => String(ms * 1_000_000);
const hash = (text, length) => createHash("sha256").update(text).digest("hex").slice(0, length);
// Includes the environment, so a test export can never reuse a real trace's ids: Langfuse keeps both
// writes to an id and shows either. Also differs from the plugin's sha256("cursor:<run id>:1").
const traceIdFor = (runId) => hash(`cursor-run:${flags.environment}:${runId}`, 32);

// One run as OTLP spans. Attributes use Langfuse's names plus the OTel GenAI ones (gen_ai.*), so the
// same body works for other OTLP backends.
function runSpans({ agent, run, repo, model, prompt, steps, source, usage, prompts }) {
  const traceId = traceIdFor(run.id);
  const spanId = (label) => hash(`${traceId}:${label}`, 16);
  const rootId = spanId("root");
  const automation = prompts.get(prompt.trim());
  // A prompt that matches no file is an agent started by hand in one of our environments.
  const kind = automation?.kind ?? "manual";
  const start = Date.parse(run.createdAt);
  const end = start + (run.durationMs ?? Date.parse(run.updatedAt) - start);
  // Langfuse v4 filters and groups each observation by its own copy of these, so every span carries
  // them. On the root alone, the cost (which sits on a model call) can't be grouped by automation or repo.
  const traceAttributes = {
    "langfuse.environment": flags.environment,
    "langfuse.trace.name": `${kind} ${repo}`,
    "langfuse.session.id": agent.id,
    "langfuse.trace.tags": ["cursor", kind, repo],
    "langfuse.trace.metadata.automation": kind,
    "langfuse.trace.metadata.repo": repo,
  };
  const span = (id, parent, name, from, to, attrs, error) => ({
    traceId,
    spanId: id,
    ...(parent ? { parentSpanId: parent } : {}),
    name,
    kind: 1,
    startTimeUnixNano: nanos(from),
    endTimeUnixNano: nanos(Math.max(from, to)),
    attributes: attributes({ ...traceAttributes, ...attrs }),
    ...(error ? { status: { code: 2, message: error } } : {}),
  });

  const spans = [
    span(rootId, undefined, ROOT_NAME, start, end, {
      "langfuse.observation.type": "agent",
      "langfuse.trace.input": clip(prompt),
      "langfuse.trace.output": clip(run.result ?? ""),
      "langfuse.observation.input": clip(prompt),
      "langfuse.observation.output": clip(run.result ?? ""),
      "langfuse.trace.metadata.status": run.status,
      "langfuse.trace.metadata.cursor_run_id": run.id,
      "langfuse.trace.metadata.cursor_run_url": agent.url,
      "langfuse.trace.metadata.charged_cents": usage?.cost?.chargedCents,
      "langfuse.trace.metadata.source": source,
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": kind,
    }, run.status === "FINISHED" ? undefined : run.status),
  ];

  steps.forEach((step, i) => {
    const stepId = spanId(`step:${i}`);
    // Cursor reports usage per run, not per model call, so the run total goes on the last call.
    const last = i === steps.length - 1 && usage;
    spans.push(
      span(stepId, rootId, step.name ?? `Model call ${i + 1}`, step.start, step.end, {
        "langfuse.observation.type": "generation",
        "langfuse.observation.model.name": model,
        "gen_ai.request.model": model,
        "langfuse.observation.output": clip(step.thinking ? { thinking: step.thinking, text: step.text } : step.text),
        "langfuse.observation.metadata.tool_calls": step.tools.length,
        "gen_ai.operation.name": "chat",
        ...(last
          ? {
              "langfuse.observation.metadata.usage_scope": "run",
              "langfuse.observation.usage_details": {
                input: usage.usage.inputTokens,
                output: usage.usage.outputTokens,
                cache_read_input_tokens: usage.usage.cacheReadTokens,
                cache_creation_input_tokens: usage.usage.cacheWriteTokens,
                total: usage.usage.totalTokens,
              },
              // rawCostCents is the model cost; chargedCents is what was billed (0 inside the plan's allowance).
              "langfuse.observation.cost_details": { total: usage.cost.rawCostCents / 100 },
              "gen_ai.usage.input_tokens": usage.usage.inputTokens,
              "gen_ai.usage.output_tokens": usage.usage.outputTokens,
            }
          : {}),
      }),
    );
    step.tools.forEach((call, j) => {
      const name = call.type === "mcp" ? `${call.args?.providerIdentifier}: ${call.args?.toolName}` : call.type;
      const failed = call.result?.status && call.result.status !== "success";
      spans.push(
        span(spanId(`tool:${i}:${j}`), stepId, name, call.start, call.end, {
          "langfuse.observation.type": "tool",
          "langfuse.observation.input": clip(call.args),
          "langfuse.observation.output": clip(call.result?.value ?? call.result),
          ...(failed ? { "langfuse.observation.level": "ERROR" } : {}),
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": name,
        }, failed ? call.result.status : undefined),
      );
    });
  });

  return { kind, traceId, spans };
}

// Every page of a Langfuse v2 observations query.
async function observations(params) {
  const all = [];
  let cursor;
  do {
    const query = new URLSearchParams({ limit: "100", ...params });
    if (cursor) query.set("cursor", cursor);
    const page = await request(`${env.LANGFUSE_BASE_URL}/api/public/v2/observations?${query}`, { auth: langfuseAuth });
    all.push(...page.data);
    cursor = page.meta?.cursor;
  } while (cursor);
  return all;
}

// Automation runs don't appear in GET /v1/agents, so run ids come from the hooks plugin's traces
// (cursor.conversation_id on its root span), as does the model, which Cursor's API doesn't report.
// Returns the runs in our environments that have settled.
async function finishedRuns(from, settledBefore) {
  const repoByEnvironment = new Map(Object.entries(JSON.parse(readFileSync(`${ROOT}environments/ids.json`, "utf8"))).map(([repo, id]) => [id, repo]));
  const roots = await observations({ type: "AGENT", environment: "cloud-agent", fromStartTime: new Date(from).toISOString(), fields: "core,metadata" });
  const modelByAgent = new Map(roots.map((o) => [o.metadata?.["cursor.conversation_id"], o.metadata?.["cursor.model"]]).filter(([id]) => id?.startsWith("bc-")));
  const found = [];
  for (const [agentId, model] of modelByAgent) {
    const agent = await cursorApi(`/v1/agents/${agentId}`);
    const repo = repoByEnvironment.get(agent.env?.id);
    if (!repo) continue;
    for (const { id, status, updatedAt } of (await cursorApi(`/v1/agents/${agentId}/runs`)).items) {
      // List items leave out the run's final message (`result`), so fetch each settled run in full.
      if (DONE.has(status) && Date.parse(updatedAt) <= settledBefore) found.push({ agent, run: await cursorApi(`/v1/agents/${agentId}/runs/${id}`), repo, model });
    }
  }
  return found;
}

// What's left once the stream has expired: the prompt and the agent's messages, which Cursor keeps for
// weeks, as one model call spanning the run. No tool calls and no per-call timings. The conversation
// covers every run of the agent; automations start one run per agent.
async function fromConversation(agent, run) {
  const { messages } = await cursorApi(`/v0/agents/${agent.id}/conversation`);
  const start = Date.parse(run.createdAt);
  const text = messages.filter((m) => m.type === "assistant_message").map((m) => m.text).join("\n\n");
  return {
    prompt: messages.find((m) => m.type === "user_message")?.text ?? "",
    steps: [{ name: "Model calls", start, end: start + (run.durationMs ?? 0), thinking: "", text, tools: [] }],
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const runUsage = async (agentId, runId) => (await cursorApi(`/v1/agents/${agentId}/usage?runId=${runId}`)).runs?.find((r) => r.id === runId);

// One named run, for the `stop` hook. The run is marked finished about a second before `stop` fires.
// Usage shows up about a minute later and doesn't change after that, so wait until two reads 30 seconds
// apart agree.
async function namedRun(spec) {
  const [agentId, runId] = spec.split(":");
  if (!agentId?.startsWith("bc-") || !runId) throw new Error(`--run looks like bc-<id>:run-<id>, not ${spec}`);
  const deadline = Date.now() + durationMs(flags["usage-wait"]);
  let run = await cursorApi(`/v1/agents/${agentId}/runs/${runId}`);
  while (!DONE.has(run.status) && Date.now() < deadline) {
    await sleep(10_000);
    run = await cursorApi(`/v1/agents/${agentId}/runs/${runId}`);
  }
  let usage;
  for (let previous; Date.now() < deadline; previous = usage) {
    await sleep(30_000);
    usage = await runUsage(agentId, runId);
    if (usage && previous && JSON.stringify(usage) === JSON.stringify(previous)) break;
  }
  const agent = await cursorApi(`/v1/agents/${agentId}`);
  const repo = flags.repo ?? agent.repos?.[0]?.url?.replace(/^https:\/\/github\.com\//, "") ?? "unknown";
  return { agent, run, repo, model: flags.model, usage };
}

const now = Date.now();
const from = now - durationMs(flags.since);
const prompts = promptIndex();
const runs = flags.run ? [await namedRun(flags.run)] : await finishedRuns(from, now - durationMs(flags.settle));
// Trace ids that already have our root span, so each run is written once. Runs can start before the
// window, so look a day further back. A named run is written once by construction: `stop` fires once.
const exported = flags.run
  ? new Set()
  : new Set(
      (await observations({ name: ROOT_NAME, environment: flags.environment, fromStartTime: new Date(from - 86_400_000).toISOString(), fields: "core" })).map((o) => o.traceId),
    );

for (const { agent, run, repo, model, usage: known } of runs) {
  if (exported.has(traceIdFor(run.id))) continue;
  const events = await runEvents(agent.id, run.id);
  const content = events
    ? { source: "stream", prompt: events.find((e) => e.data.type === "user-message-appended")?.data.userMessage.text ?? "", steps: steps(events) }
    : { source: "conversation", ...(await fromConversation(agent, run)) };
  const usage = known ?? (await runUsage(agent.id, run.id));
  const { kind, spans } = runSpans({ agent, run, repo, model, usage, prompts, ...content });
  const body = { resourceSpans: [{ resource: { attributes: attributes({ "service.name": "ca-setup-export" }) }, scopeSpans: [{ scope: { name: "ca-setup-export" }, spans }] }] };
  const cost = usage ? `, ${usage.usage.totalTokens} tokens, $${(usage.cost.rawCostCents / 100).toFixed(2)}` : ", no usage";
  console.log(`${run.id}: ${kind} on ${repo}, ${spans.length} spans from the ${content.source}${cost}`);

  if (flags["dry-run"]) {
    console.log(JSON.stringify(body, null, 2)); // the exact body a real run would POST
    continue;
  }
  await request(`${env.LANGFUSE_BASE_URL}/api/public/otel/v1/traces`, {
    auth: langfuseAuth,
    method: "POST",
    headers: { "x-langfuse-ingestion-version": "4" }, // without it, data can take up to 10 minutes to appear
    body,
  });
}
if (runs.length === 0) console.log("no finished runs in the window");
