---
name: review-agent-runs
description: Review and evaluate Cursor Cloud Agent automation runs (PR review and fix) using Langfuse traces and Cursor's agent API. Use when asked to look at agent runs, find expensive or failing runs, compare prompts or models, explain what an agent did, or score run quality.
---

# Review agent runs

Use this to answer questions about Cursor automation runs: what happened, what it cost, whether it was any good, and what to change. Read data only. Never start, cancel or edit agents, and never write to Langfuse unless the user asks for it.

## Sources

There are two, and you usually need both.

| Need | Source |
|---|---|
| Find runs, filter by automation, repo, model, time | Langfuse |
| Cost, tokens, latency totals and dashboards | Langfuse (traces written by `observability/export.mjs`) |
| The full run: prompt, thinking, text, every tool call with arguments and results | Langfuse trace, or Cursor's run stream if the trace is missing |
| Billed tokens and cost for one run, authoritative | Cursor `GET /v1/agents/<agent id>/usage` |
| Prompt and messages for runs older than a day | Cursor `GET /v0/agents/<agent id>/conversation` |
| Outcome (merged, fix kept, comments resolved) | The code host (GitHub here, Bitbucket at work) |

## Langfuse

- Base URL and keys come from `.env`: `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`. Basic auth with public key as user, secret key as password.
- Read with v2 only: `GET /api/public/v2/observations` and `GET /api/public/v2/metrics`. The v1 endpoints (`/api/public/traces`, `/sessions`, `/metrics`) return 410.
- Pass `fields=core,basic` to get names; add `io` for input and output. `core` alone leaves names empty.
- Environments:
  - `agent-runs`: full traces from `export.mjs`. Use this.
  - `default` / the plugin's environment: the Langfuse plugin's traces. They have run ids and model names but no prompt, replies, tokens or cost, and tool outputs are null.
  - `cloud-agent-api`, `cursor-runs`, `probe`, `dummy`: test data. Always exclude.
- Trace shape in `agent-runs`:
  - one root `agent` observation named `Cursor run`, with the prompt as input and the final message as output;
  - one generation per model call (`Model call N`), with the run's total usage and cost on the last one;
  - tool observations named after the tool (`<provider>: <tool>` for MCP).
- Every observation carries the trace name, tags (`cursor`, `review` or `fix`, repo) and session (the Cursor agent id). Group and filter on those.
- In v2 metrics the views are `observations` and the score views. High-cardinality dimensions such as `sessionId` need `config.row_limit` and a descending `orderBy`.

## Cursor API

- Key in `.env` as `CURSOR_TOKEN`, sent as `Authorization: Bearer <key>`. It's an Admin-scope key: read-only use is up to you.
- `GET /v1/agents/<agent id>/runs/<run id>` returns status, `durationMs`, `result` (final message) and `git.branches` (with `prUrl` when there is one). The runs list leaves `result` out.
- `GET /v1/agents/<agent id>/runs/<run id>/stream` replays the run as server-sent events. Stop reading at `event: done`, because the connection may not close. The stream expires about a day after the run (410 `stream_expired`). Useful `interaction_update` types:
  - `step-started` and `step-completed` (with `stepDurationMs`);
  - `thinking-delta` and `thinking-completed` (with `thinkingDurationMs`), and `text-delta`;
  - `tool-call-started` and `tool-call-completed`, which carry `modelCallId`, args and result;
  - `token-delta`, a streamed token count, not billed tokens (one run summed to 2.75x its billed output), so use it only to compare steps;
  - `user-message-appended` and `turn-ended`.
- `GET /v1/agents/<agent id>/usage` gives `inputTokens` (excludes cache reads), `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `rawCostCents` (model cost) and `chargedCents` (billed; 0 inside the plan). It's final about 1 minute after a run ends.
- Cursor answers bursts with 429. Space calls out and retry with backoff.
- `GET /v1/agents` doesn't list automation runs. Get agent and run ids from Langfuse traces or from the `RUN_ID:` line in the bot's PR comment.

## How to work

1. **Scope the question.** Pin down which automation, repo, model and time window. Default to the last 7 days in `agent-runs`.
2. **Get the overview from metrics first.** Count, cost and latency grouped by trace name, tag and model. Don't pull every trace.
3. **Pick runs to read.** The most expensive, the slowest, failures, and a few normal ones for contrast.
4. **Read each picked run in full.** Note:
   - the files read, and whether the same file was read more than once;
   - shell commands, and whether any were retried after failing;
   - how many steps it took, and where the time and output tokens went;
   - whether a review read the diff before commenting;
   - whether a fix touched files outside the problem.
5. **Judge the output against the prompt.** Use the rubric below. Quote the run's own text as evidence.
6. **Check the outcome** on the code host when it matters: was the PR merged, was the fix commit kept, did anyone reply to or resolve the comments.
7. **Report findings with run links and numbers, then concrete changes.** Changes can be a prompt line, a project rule, a model switch, or a tool restriction. For each one, say what it should change and how to check it worked (cost per run, steps per run, a score).

## Rubric

Score each run 1 to 3 per line and quote evidence. Keep the scores separate; don't average them into one number.

**Review runs**
- **Grounded:** every issue points to a real file and line in the diff. Invented issues score 1.
- **Useful:** the issues are ones a senior reviewer would raise, most serious first.
- **Followed the prompt:** stayed read-only, kept to the requested format, named the touched workspaces.
- **Efficient:** no repeated reads or aimless searching, with steps proportional to the size of the diff.

**Fix runs**
- **Correct:** the change fixes what was asked, judged from the diff and any tests run.
- **Contained:** no unrelated edits.
- **Verified:** it ran the project's lint or tests before pushing.
- **Efficient:** as for reviews.

## Pitfalls

- Langfuse v4 keeps every write to an observation id but may show an old one. Never "fix" a trace by re-sending it, and don't write the same ids into a second environment.
- The plugin's traces and `export.mjs` traces describe the same run with different trace ids. Don't count both.
- Model names like `cursor-grok-4.6-medium` have no Langfuse price. Cost exists only where it was ingested from Cursor.
- `chargedCents` of 0 means the run was covered by the plan, not that it was free. Compare runs on `rawCostCents`.
- One judged run proves nothing. Before recommending a change, look at enough runs to see a pattern, and say how many you read.
