# How we evaluated observability for Cursor Cloud Agents

Draft, 2026-10-31. This records what we tried, what we measured and what we decided. Platform facts behind each point are in [AGENTS.md](../AGENTS.md).

## The problem

The Langfuse Cursor plugin traces every `!review` and `!fix` run, but the traces are mostly empty: no prompt, no replies, no tokens, no cost, and tool outputs recorded as null. Filling them in needed `enrich.mjs`, a job that patches extra spans onto the plugin's traces. We wanted to know whether a different platform, a Cursor feature or a different design would fix that properly.

## What we checked

### 1. Other self-hostable platforms

| Platform | Licence | Self-hosting | Fit |
|---|---|---|---|
| Langfuse | MIT core (owned by ClickHouse) | Postgres, ClickHouse, Redis, S3 | Already in use, has a Cursor plugin, OTLP ingest |
| Arize Phoenix | ELv2 | One container, lightest of the set | Good fallback; uses OpenInference attribute names |
| Opik | Apache-2.0 | Heavy stack | No advantage over Langfuse here |
| Laminar | Apache-2.0 | Moderate | No advantage over Langfuse here |
| SigNoz | MIT core | ClickHouse based | General APM, weaker LLM views |
| MLflow | Apache-2.0 | Light | Tracing is secondary to experiment tracking |
| Helicone | Apache-2.0 | Proxy | Doesn't apply: we can't route Cursor's model calls through a proxy |

**Finding:** the gaps aren't Langfuse's fault. Every platform receives only what Cursor sends, and Cursor's hooks don't send the missing data. Switching platform would fix nothing.

**Decision:** stay on Langfuse. Phoenix is the option if we later want lighter self-hosting.

### 2. Cursor's hooks

- In Cloud Agents, `stop` fires without token fields, and `beforeSubmitPrompt`, `afterAgentResponse` and `afterAgentThought` never fire.
- The `stop` payload does carry the agent id, run id, model and status.
- The local CLI (`agent -p`) fires a different set of hooks, so local runs can't test cloud behaviour.

**Finding:** no hook, ours or Langfuse's, can see the prompt, replies or usage.

### 3. Cursor's plugin system

Plugins package rules, skills, MCP servers and hooks. They add no data and no completion webhook.

**Finding:** doesn't help.

### 4. Cursor's API

With the personal Pro key:

- `GET /v1/agents/<id>/runs/<run id>/stream` replays the whole run: thinking, text, every tool call with arguments and results, and timings. It expires about a day after the run.
- `GET /v1/agents/<id>/usage` gives tokens and cost per run.
- `GET /v0/agents/<id>/conversation` gives the prompt and messages, and still works a month later.
- None of them names the model, and automation runs aren't listed, so run ids and model come from the hook.

**Finding:** everything missing is available from the API.

### 5. Exporter trial (`export.mjs`)

We built one full trace per run from the API and wrote it to the `agent-runs` environment.

- 5 real runs exported; cost by automation matched Cursor (Ambulink review $0.73 over 2 runs, Ambulink fix $0.26, typst review $0.19, typst fix $0.19).
- A second pass wrote nothing, so runs aren't duplicated.
- Usage is final about 1 minute after a run ends. A `!review` at 15:25 stayed unchanged for 28+ minutes after that.
- Lessons: Langfuse v4 merges re-sent ids unpredictably, so each trace is written once, and trace attributes go on every span.

### 6. Enterprise OTLP export

Enterprise can export logs and metrics (with tokens, model and optional conversation content) over OTLP. It sends no traces, and it's an admin setting, so a plugin can't add or expose it.

**Finding:** useful at work as an extra source, not a replacement.

### 7. Building the trace inside the run

A probe environment (`agents-test-probe`) logged every hook event on a real cloud run.

- No transcript exists on the machine.
- Each run gets a fresh machine.
- A detached process started from `stop` was still alive 10, 30, 60 and 120 seconds later, long enough for usage to settle.

**Finding:** technically possible, but only with a Cursor key on the agent's machine.

### 8. Key risk

Cursor keys only come with Admin scope. A key on the machine can read every conversation on the account, start billed agents that push code, and change environment scripts. `runtime_secret` only hides the value from output. Both repos are public and anyone can trigger the workflows, so one prompt injection in a PR could leak the key.

**Finding:** keep Cursor keys off agent machines.

### 9. Other write-ups and repos (read in depth 2026-10-31)

Sources:

- the Langfuse Cursor integration page and the ClickHouse blog post;
- the source of `langfuse/cursor-observability-plugin` (including its `docs/ANALYSIS.md`), `007gzs/cursor-langfuse`, `cursor/sdk-bridge` (protobuf contract) and the published `@cursor/sdk` 1.2.0 package;
- `cursor/cookbook` (hooks example and the self-hosted lab) and `cursor/community-plugins`.

We also re-checked a saved run stream and our probe data against what we found.

#### Things we can use now

1. **The run stream has per-step output token counts, and `export.mjs` ignores them.** The stream carries `token-delta` events (`{"tokens": n}`). For review run `run-aec8a2bd` the sum per step was 3364, 1801, 1121, 3987, 1484, 1430, 1857, 6137, 1446, 1407, 440 and 185.
   - The total is 24,659, but Cursor's usage endpoint reports 8,957 output tokens for the run. So the deltas aren't billed tokens, probably because they include thinking that isn't billed the same way.
   - They're still a fair measure of which step did the most work. We can spread the run's real cost across model calls in proportion, marked as an estimate, instead of putting it all on the last call.
2. **The stream has timings and model-call ids we don't record yet.** `thinking-completed` has `thinkingDurationMs`, `step-completed` has `stepDurationMs`, and each tool call has a `modelCallId`, which groups tool calls under the model call that asked for them. The SDK also defines `summary-started` and `summary-completed`, the context compaction events.
3. **A finished run reports `durationMs` and `git.branches`.** The pull request link (`prUrl`) is in `git.branches` when there is one. Per the SDK contract, `RunResult` also has `model`, `usage` and `error_code`/`error_message`, but our real run response had no `model` or `usage`. So the model still has to come from the hook.
4. **Tool hooks do fire in cloud runs.** The probe counted `preToolUse` 3, `postToolUse` 3, `beforeShellExecution` 1, `afterShellExecution` 1 and `beforeReadFile` 1 before `stop`.
   - The plugin reads tool output from `tool_output` (`postToolUse`), `output` (`afterShellExecution`) or `result_json` (`afterMCPExecution`).
   - Our plugin traces show tool output as null. So Cursor probably names that field differently in cloud payloads.
   - One more probe that logs a full `postToolUse` payload would tell us whether the plugin is fixable with a one-line change. That would still leave no prompt, replies or tokens.
5. **The machine lives longer than we measured.** Probe heartbeats arrived at 300 and 600 seconds after `stop` as well, so at least 10 minutes.
6. **A `stop` hook can make the agent do one more step.** The cookbook's `update-skills-on-stop.mjs` returns `followup_message` with `loop_limit: 1`. We could use that to ask the agent for a short self-assessment (for example "confidence: high/medium/low, files reviewed") and record it as a score. It costs one extra model call per run, and the agent grading itself is weak evidence.

#### What the plugin's own design notes confirm

`docs/ANALYSIS.md` in the Langfuse plugin repo is the most useful document we found. It says:

- in Cloud Agents only project and team hooks run, with no `sessionStart`/`sessionEnd` and no MCP hooks, and "hooks are off during early read-only turns";
- the transcript "has no timestamps, no tool results, no token usage and no message ids", and the CLI's `transcript_path` is null;
- per-model-call token usage doesn't exist in Cursor; usage is per turn, on `stop`, "and only in recent builds" (undocumented `input_tokens` and `output_tokens`), and our cloud `stop` payload had neither;
- Langfuse's OTLP endpoint "accepts traces only; `/v1/metrics` is a no-op and `/v1/logs` does not exist", so **Cursor's Enterprise OpenTelemetry export (metrics and logs) can't be sent to Langfuse directly**; it needs a collector and a metrics backend;
- no Langfuse model definition matches `cursor-grok-4.6-medium`, so cost only appears when ingested, as `export.mjs` does;
- `CURSOR_CODE_REMOTE` marks remote workspaces, and the plugin doesn't read it.

#### Self-hosted Cloud Agents (cookbook lab)

Useful for work, but not the clean answer I suggested earlier.

- Workers need a **service account key** (Enterprise only) in the worker container's environment (`CURSOR_API_KEY`). The agent works in that same container (`--worker-dir /workspace`). Unless Cursor strips the variable before starting agent processes, the agent can read it. **Correction:** self-hosting doesn't by itself keep the key out of the agent's reach. That needs testing, or a separate exporter container.
- Each worker serves Prometheus `/metrics`, including `cursor_self_hosted_worker_session_ends_total{reason=...}`, with reasons `session_error`, `connection_timeout` and `session_aborted`. That's reliability data our setup doesn't have today.
- Workers connect outbound only, so egress can be restricted, which narrows what a leaked key could reach.
- "The worker CLI does not always emit detailed per-job logs at the default log level", so worker logs don't replace traces.

#### SDK and bridge

`@cursor/sdk` 1.2.0 calls the same `/v1` endpoints we already use. It adds no new data, but it would make the exporter simpler:

- `ObserveRun` "replays recorded events from the beginning (or from a resume offset) and then follows the live run if it is still executing". An outside service told "run X started" could stream the run live instead of waiting for it to finish.
- `WaitLiveRun` blocks until a run ends, so there's no polling.
- `UsageCost` is documented as "eventually consistent after a run ends", which matches the roughly 1 minute we measured.
- `CloudAgentOptions.metadata` sets caller tags on API-created agents (not automations).
- There are no webhooks.

#### Not useful

- **`007gzs/cursor-langfuse`:** it's built on `beforeSubmitPrompt`, `afterAgentResponse` and `afterAgentThought`, which don't fire in cloud runs. Its code says context tokens from `preCompact` are "the only token-related fields Cursor exposes today".
- **`cursor/community-plugins`:** it's the cursor.directory website. The catalogue lives in its database, and there's nothing about observability in the repo.
- **The cookbook's other hooks:** prompt guards and model blocking, not observability.

#### From the ClickHouse post: how teams use this

They show the loop worth copying:
1. Find expensive turns.
2. Spot patterns (the agent re-reading the same files, or retrying a shell command until it succeeds).
3. Add a project rule.
4. Build a dataset from real prompts.
5. Run an evaluator for task completion.
6. Compare cost and latency next to scores.

"The rule shipped because cost dropped and completion held." Two tools are mentioned:
- the Langfuse skill and CLI, which let an agent query traces ("List this week's most expensive Cursor turns and what they have in common");
- `langfuse/experiment-action`, a GitHub Action that "fails the job when a score violates your threshold".

**Finding:** still no way to get the prompt, replies or usage into a cloud hook. Cursor's agent API, read from outside the agent, stays the source. The stream holds more than we use.

## Options compared

| Option | Full traces | Key on agent machine | Moving parts |
|---|---|---|---|
| A. Plugin only | No | No | Least |
| A+. Plugin plus `enrich.mjs` | Partial, patched on | No | Hourly job |
| B. Hook signals "run finished" to an outside service that exports | Yes, within minutes | No | Hook plus service (e.g. GitHub Action) |
| C. Hourly `export.mjs` job | Yes, up to an hour late | No | Hourly job |
| D. Hook exports from inside the run | Yes, within minutes | **Yes, Admin key** | Hook only |

## Decision

Go with **B**: our own small `stop` hook sends only the run id and model to an outside service, which holds the Cursor key and runs the export. Run **C** as a backstop for any signal that gets lost. Once that works, replace the Langfuse plugin with our hook and remove `enrich.mjs`.

## Open items

- Choose the outside service and how the hook authenticates to it without carrying a Cursor key.
- Delete or reuse the `agents-test-probe` environment.
- Filter out the test environments `cloud-agent-api`, `cursor-runs`, `probe` and `dummy` in Langfuse.
