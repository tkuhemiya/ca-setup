# Notes for coding agents

This file covers what the code can't tell you: why the setup looks the way it does, what the Cursor and Langfuse platforms actually do (not what their docs say), and what state the live resources are in. Read the code for everything else.

Facts below were verified on 2026-10-29 against Cursor's Environments API (beta), the `cursor/cursor` Terraform provider 0.8, and Langfuse's Cursor plugin at commit `a36d39a`. Platforms move fast. If something here contradicts what you observe, trust the observation and update this file.

## Ask before touching live resources

`scripts/sync-environments.mjs` and `terraform apply` change a real Cursor account. The workflows they create answer `!review` and `!fix` comments on real GitHub repos, and `!fix` pushes commits. Don't run either without the owner's go-ahead. `sync-environments.mjs --plan` and `terraform plan` only read, so they are safe.

## Bitbucket Cloud is supported, not only GitHub

Work repos are on Bitbucket Cloud. Don't tell the owner that cloud agents or automations are GitHub only. Cursor's docs, read 2026-11-16, say otherwise:

- **What's supported.** Cloud agents and automation source control triggers work with GitHub, GitLab and Bitbucket Cloud (`bitbucket.org`). Bitbucket Cloud is in public beta. Sources: `https://cursor.com/docs/integrations/bitbucket.md` and the "Source control triggers" section of `https://cursor.com/docs/cloud-agent/automations.md`.
- **Bitbucket Server and Data Center** get Bugbot only. They have no cloud agents and no automation triggers.
- **Triggers on Bitbucket Cloud.** Draft opened, pull request opened, pushed, merged and approved, push to branch, and comment added. Comment added fires on top-level pull request comments only, which covers `!review` and `!fix`. There is no label trigger and no inline review-comment trigger. CI completed is GitHub only.
- **Setup.** A Bitbucket workspace admin installs the Cursor app (it's a Forge app), and a Cursor team admin links it to the team. Each person also connects their own Bitbucket account in the Cursor dashboard. A Cursor team uses one Bitbucket workspace at a time.
- **Who acts.** Clones, pushes, commits and new pull requests happen as the connected Bitbucket user. Progress comments come from the Cursor app.
- **Repo URLs.** The APIs take the URL as it appears on the host, such as `https://bitbucket.org/<workspace>/<repo>`. `GET /v1/repositories` lists GitHub repos only, so a Bitbucket repo missing from it proves nothing.

Agents get this wrong because the Terraform provider's docs describe every git trigger's `repos` as "GitHub repos to watch". The provider's source is wider than its docs. Versions 0.8.0 and 0.9.0 name `bitbucket.org` as a known host, test `bitbucket.org/<workspace>/<repo>` targets, and pass repo strings to the server as written. Write Bitbucket repos with the host, because a bare `owner/repo` reads as GitHub.

Not checked yet:

- Nothing in this setup has run against a Bitbucket repo. The host now comes from `settings.json`: sync builds `https://<host>/<owner>/<repo>`, and `modules/automation` writes `<host>/<owner>/<repo>` in triggers for any host but GitHub. Both were only planned against GitHub repos.
- Whether triggers fire with personal connections alone, before the workspace app is installed.
- Which Bitbucket user an automation pushes as when a service account key created it.

## Design decisions

### Automation first, one workflow per repo

The layout changed on 2026-11-16. The owner found the old one, a folder per repo that listed its automations, the wrong way round: an automation is the thing you write, and repos are where it runs.

- Each automation is one `.tf` file in the root (`review.tf`, `fix.tf`) with one `modules/automation` block. It lists its repos by folder name.
- The module creates one Cursor workflow per repo with `for_each`. A workflow has one `environment_public_id`, and each repo has its own environment, so one workflow can't serve two repos' environments.
- `instructions` is a list of markdown files joined into the prompt. `{repo}` in a path becomes the repo's folder name, so a shared automation can still carry per-repo text. A missing file fails the plan. There is no fallback.
- The trigger, model and tools are inputs of the module. Only what `review` and `fix` use has been applied live. The `label`, `cron` and `webhook` triggers and the `approve` and `memory` tools passed `terraform plan` in a throwaway copy and nothing more.
- The owner controls which repos get which automation through each automation's `repos` list.

An earlier version discovered repos with `fileset()` and fell back to shared prompts, and the owner rejected it as hard to read. The `for_each` here is different: it runs over a list written by hand. Don't add discovery or fallbacks.

`moved.tf` maps the four workflows from their old addresses, so the first apply updates them in place and keeps their ids. A replaced workflow gets a new id, and a webhook workflow would get a new URL and key.

### One automation across repos without the module

Cursor can also do this inside one workflow. Leave `environment_public_id` unset, list several repos in the trigger, and Cursor picks the environment from the repo the event came from. Its docs give the order (`https://cursor.com/docs/cloud-agent/setup.md`, "Environment resolution order", read 2026-11-16): a personal saved environment, then a team saved environment, then `.cursor/environment.json` in the repo. The owner has seen this work. It isn't tested from this setup.

The module doesn't use it, for three reasons:

- A repo with no saved environment would run on Cursor's default image with no toolchain and no tracing, and nothing would fail.
- A repo can have more than one saved environment, and a person's own environment wins over the team's.
- One workflow has one prompt, so per-repo instructions would go.

Use it when one run has to work across repos. The docs call that a multi-repo environment: one environment that lists several repos.

### Two tools, one file between them

Environments are managed by `scripts/sync-environments.mjs`, because the provider has no environment resource. Workflows are managed by Terraform. If a later provider version adds an environment resource, raise it with the owner. Don't just move them.

- Sync reads `settings.json`, `repos/*/environment.json`, `tracing/` and the two exporter scripts in `observability/`. It never reads a `.tf` file or an instruction file.
- Terraform reads the `.tf` files, the instruction files and `ids.json`. It never reads an `environment.json`.
- `ids.json` is the only link. Sync writes it on every run, plan or not: folder name to `{ id, host, repo }`. Git ignores it.

`ids.json` is not state. Sync finds each environment in Cursor by name and gets the same id back, so a lost `ids.json` is rewritten by the next run. Terraform state is different: it is the only record of which workflow is which.

The owner once rejected merging the two sides by repo. They accepted this layout because the folders group by what you edit (a repo's machine, an automation), and the two tools still share nothing but `ids.json`.

### Fail loud on missing environment ids

The module indexes `local.environments[each.key]` directly. A repo missing from `ids.json` stops `terraform plan`. Don't use `lookup()` with a default, for the reasons under "One automation across repos without the module".

In a plan, an environment that doesn't exist yet gets the id `pending`, so a pull request that adds a repo can still be planned. The real sync replaces it before the apply.

### One environment per repo, for automations only

`repos/<repo>/environment.json` describes one environment, named `automation-<owner>-<repo>`. The name is unchanged from the old layout, so the two existing environments keep their ids.

The folder name is the repo name. The owner and host come from `settings.json`, because at work every repo is in one Bitbucket workspace. A repo under another owner sets `"repo": "owner/name"` in its `environment.json`.

Until 2026-11-16 sync also kept a keyless `agents-<owner>-<repo>` environment for people. The owner dropped that: this repo sets up environments for automations only. The two `agents-` environments still exist in Cursor and nothing manages them. Check one thing before deleting them: with only the `automation-` environment saved for a repo, an agent a person starts on that repo may resolve to it, with tracing on and the Cursor key on the machine. Its run would be labelled `manual`.

`"tracing": false` in an `environment.json` leaves out the stop hook and the Cursor and Langfuse keys. It defaults to on.

### Variables and secrets

Both live in `environment.json`:

- `variables` is an object of plain values. They are committed and Cursor doesn't redact them.
- `secrets` is a list of names. The repo holds no values. Sync reads each value from its own environment, from a variable named `<FOLDER>_<NAME>` in upper case with other characters turned into `_`. `DATABASE_URL` in `repos/typst-editor` comes from `TYPST_EDITOR_DATABASE_URL`. In CI that is a secured variable. On a laptop it is a line in `.env`.

Sync deletes every variable on an environment that no file asks for, so the files are the whole truth. Don't set variables in the dashboard. A missing value stops sync before it changes anything, and it lists every missing name at once.

### Sync changes only what differs

For each folder, sync reads what Cursor has and compares:

- It patches the environment only when the generated `environmentJson` differs from the saved one. Cursor stores the string as sent (checked 2026-11-16: `start` and two of three `install` parts were identical to what the script generates, and the third differed because `export.mjs` had changed since the last sync).
- It sends every variable on every run, because Cursor never returns a value.
- It starts a build when the config changed, or a variable name was added or removed. `--build <repo>` forces one. Use it after a failed build, and after giving an existing secret a new value: agents only get a changed value from a build made after the change.
- `--plan` does the reads and prints the result without changing anything. It needs only `CURSOR_TOKEN`.
- It reports any `automation-` environment that has no folder. It never deletes an environment.

The "nothing changed, no build" path has only been reasoned from those reads. No live sync has run since this was written.

### Traces come from a `stop` hook, not the Langfuse plugin

Automation environments no longer install Langfuse's Cursor plugin. Its hooks never get the prompt, replies, tokens or cost in cloud runs, and running it beside the exporter wrote a second, thinner trace per run (`Cursor Turn`, with one `LLM` span covering the whole turn) into the same Langfuse environment. Checked 2026-11-12: three runs each had both traces.

The replacement is two scripts that sync copies to `~/.agent-trace/` at build time:

- `observability/stop-hook.mjs` is the hook. Cursor calls it when a run ends, with the run id and model. It starts the exporter in its own session and answers at once, so it can't hold up the agent.
- `observability/export.mjs` fetches that run from Cursor's API and writes the full trace to Langfuse. It's the same file people run from a laptop with `--since`.

Choices around it:

- The hook is registered in `.cursor/hooks.json` in the build snapshot (`tracing/install.sh`), not in a Cursor plugin. Plugin-bundled hooks never fired in a cloud run when tried on 2026-11-11. The file exists only on the cloud machine, and `.git/info/exclude` hides it, so it never reaches the target repo or a developer's checkout. Don't commit `.cursor/hooks.json` into a target repo.
- The Cursor key is on the agent machine, as a `runtime_secret` (`CURSOR_TOKEN`), because the exporter reads the run back from Cursor's API. A personal key has Admin scope, so on the owner's Pro plan it can read every conversation and start billed agents, and both target repos are public. The owner accepted that for testing. On Enterprise the setup should use a read-only key. Check it can read `/stream`, `/usage` and `/conversation` and gets 403 on `POST /v1/agents` before relying on it.
- The exporter labels a run from the last line of its prompt. `modules/automation` ends every prompt with `<!-- automation: <name> -->`, and a prompt without that line is labelled `manual`. Until 2026-11-16 the build copied the prompt files to the machine and the exporter compared whole prompts, which stops working once a prompt is several files joined. Runs from before the marker are labelled `manual` if they are exported again. The marker has not been through a live run yet.
- `langfuse-start.sh` runs at boot and saves the keys to `~/.agent-trace/env.json`, in case hooks don't inherit runtime secrets. Whether they do is unchecked. It never stops an agent, so `start` joins the shared and repo steps with `;` while `install` uses `&&`.
- The keys go up as `runtime_secret`, which Cursor redacts from agent output. The other settings (`langfuse.json`) are plain env vars on purpose.
- The Langfuse project is in the Japan region. Keys only work against `https://jp.cloud.langfuse.com`.
- Everything lives in this repo. Don't solve problems by committing `.cursor/environment.json` or `.cursor/hooks.json` into a target repo, even though Cursor and Langfuse both document that route.

### What the exporter writes

One trace per run in the Langfuse environment `cloud-agent` (set in `langfuse.json`), made from the run's event stream and its usage:

- A `Cursor run` root with the prompt and the final message.
- One `Model call` generation per model call, with its thinking and text, the time to the first token, and the tools it called as children. The stream has no marker for a model call. A call is the events between two closers, `tool-requests-listed` (it asked for tools) and `turn-ended` (it answered). Its start is when its input was ready: the last tool result, or the run start for the first call. Tool calls group by the `call-<uuid>` prefix of their id, and the groups arrive in the same order as the calls that asked for tools. `tool_call` events also include calls the typed events leave out, such as the built-in `get_mcp_tools`.
- Each `Model call` shows no tokens or cost of its own, on purpose, because Cursor reports them per run. Its input is only what's new to it: the prompt for the first call, the previous call's tool results for the rest. Cursor doesn't expose the full context it was sent. Its output is the thinking and text as plain text. A JSON-string output showed blank in Langfuse's preview (2026-11-12).
- A `Run usage` generation with no length, at the end of the run, holding the run's tokens, cost and model. Cursor reports usage per run only, so this is the one place the total goes. Langfuse kept no tokens or cost on the root span (tried 2026-11-12: it stored the values as plain metadata and left cost null), and putting the total on one model call made that call look like it cost the whole run.
- Per-call cost isn't available on Pro. The Admin API's `filtered-usage-events` (Enterprise) may return one event per call, which could fill each `Model call`. Untested, because it needs an Enterprise key. Before building on it, dump the events for one `cloudAgentId` and check they line up one to one with the model calls.

### Enrichment runs outside the agent

`observability/enrich.mjs` was written for the Langfuse plugin's traces, which lack the prompt, replies and tokens. Automation environments no longer install the plugin, so it has nothing to enrich there, and neither does the exporter's `--since` mode, which also finds run ids from plugin traces. `--run`, used by the stop hook, doesn't. It's a third, separate part that changes nothing in either tool.

As of 2026-11-16 `enrich.mjs` doesn't run. It reads `LANGFUSE_TAGS` from `langfuse.json`, which lost that setting when the plugin was removed, and it reads prompt files from folders that no longer exist. It was left as it is. Ask the owner whether to delete it or repair it before spending time on it. The notes below describe how it worked.

- It decides review vs fix by matching the run's prompt text against the prompt files in `automations/`. That needs no per-repo config and works without Terraform state, so it can run anywhere the repo is checked out. A prompt that matches no file is tagged `manual`.
- It writes its own child spans under the plugin's root span: "Run details" (prompt, final message, review/fix, repo, run link) and, once usage exists, a "Run usage" generation with tokens and cost. "Run usage" uses the model name the plugin recorded, so cost lands on the same dashboard row.
- "Run usage" waits until the run has been finished for two hours. Cursor reports usage in hourly buckets, and a cost written from a partial bucket could never be corrected. That's why the default `--since` is 6 hours: settled runs must still be inside the window.
- Every span id is written exactly once, and an existing span means that step is done. Don't "update" spans. Langfuse v4 keeps every write to an id but doesn't reliably show the latest: on 2026-10-30 a re-sent plugin root showed the new content for about 15 seconds, then went back to the plugin's version and stayed there. This applies to the plugin's spans too, so the job can't fill in the trace's own input, output or cost columns. Those come only from the root span, which the plugin owns. The prompt and final message live on "Run details" instead.
- `observability/fixtures/seed-dummy.mjs` seeds plugin-shaped traces into a separate Langfuse environment (`dummy`) with a matching fake usage file, for testing the job at volume. Point the job at them with `--environment dummy`. The 2026-10-30 seed is still there: 50 traces, about 1 second each on the first pass and 2 seconds for a pass with nothing to do. Langfuse's API can't delete them.
- The four traces from 2026-10-29 also carry an older "Cursor run details" span from the first version of the job. It can't be removed, and it does no harm.
- The cost path (Admin API) is written to the documented response shape but has never run against the real API, because the owner's plan is Pro. Test it at work with `--dry-run` first. `--dry-run` prints the exact request body.

### Prompts

Review prompts are per repo (`repos/<repo>/review.md`) because a useful review needs to know the stack: workspace layout, lint commands, what breaks across packages. The fix prompt is shared (`instructions/fix.md`), because the fixing agent finds the project's commands itself. Review prompts tell the agent not to modify files and not to invent issues. Keep both rules in new review prompts.

## Platform behaviour you can't see in the code

- **Inline Dockerfiles are gated.** `build.dockerfileContents` fails the build with `dockerfile_contents_not_enabled` on this account. That's why environments use Cursor's default image plus `install`. The default image already has Node 22+ through nvm, `sudo` without a password, and a global npm prefix that installs without sudo.
- **`egressAllowlist` replaces network access instead of adding to it.** Setting it to the Langfuse host blocked npm, and every install failed. Leave it out unless you list every host the build needs.
- **Cursor re-quotes `install` and `start`.** A command with escaped quotes fails with nothing but `install_failed`. That's why sync sends every command base64-wrapped. Keep that wrapping.
- **The Langfuse plugin isn't on npm.** Langfuse's docs say `npm install -g @langfuse/cursor-observability-plugin`, which returns 404. `install.sh` installed a GitHub tarball pinned to a commit while the plugin was in use. A tarball skips the package's `prepack` step, which needs pnpm, and the repo commits its built `dist/`, so nothing compiles. To upgrade, first check whether npm has it (`npm view @langfuse/cursor-observability-plugin`). If not, bump the commit hash.
- **The provider can't store an empty allowlist.** With provider 0.8, `user_allowlist = []` comes back from the API as `null`. Terraform then reports "inconsistent result after apply" and taints the workflow. Use `null` for "anyone".
- **Workflows without a model run on an expensive default.** Unset, Cursor assigned `grok-4.7-high-fast`. The owner chose Grok 4.6 with medium effort, non-fast, for every automation. Most models default to their fast and high-effort variants, so the module's default model sets every parameter.
- **Parameter names differ between models.** Grok 4.6 calls it `effort`, Grok 4.7 calls it `reasoning_effort`, and Composer 2.5 has only `fast`. The provider has no model-list data source. `GET https://api.cursor.com/v1/models` returns each model's canonical id, parameters and default variant. Use the canonical id, because the server rewrites aliases like `composer`, which shows up as a diff.
- **`max_mode` must be `true`.** Max mode is Cursor's long-context variant, such as Grok 4.7's 500k context. Grok 4.6 and Composer 2.5 have no max-mode variant, so `true` changes nothing for them. Leaving it unset makes the apply report "inconsistent result", because the server always reports it back as `true`. Setting it to `false` fails the plan with "not supported by the server yet".
- **Team environments need a key on a Cursor team.** A personal key gets a 400 error for owner `team`. Service accounts are Enterprise-only. Cursor documents no way to transfer personal resources to a service account, so switching means re-running sync and apply with the new key, then deleting the old resources.
- **Service accounts need the team-level GitHub app.** A personal GitHub connection isn't enough. Both GitHub owners (`AmbuLink-CS-55` and `tkuhemiya`) need the app installed.
- **Register hooks at build time, not in `start`.** Cursor's `start` runs alongside the agent, so a hooks file written there can arrive after the agent has already read `.cursor/hooks.json`. On 2026-10-29 the two `!review` runs, the first runs after a rebuild, sent no traces, while the two `!fix` runs 11 minutes later did. Both kinds read and write files, so the difference wasn't the work they did. `tracing/install.sh` now writes the hooks file during the build, so it's in the snapshot before any agent starts. That fixed it for the plugin's hooks: after the next rebuild, the first runs were two `!review`s and both were traced. It applies to the stop hook too. Don't move hook registration back into `start`. Don't read the plugin README's "hooks start only once the agent has a writable environment" as "read-only runs aren't traced" either. That was an earlier wrong guess. To check whether a run happened at all, look on the PR for a `cursor[bot]` review with `CURSOR_AUTOMATION_ID` in the body, or call `GET https://api.cursor.com/v0/agents/<run id>/conversation`.
- **Traces have no tokens, cost, prompt or replies, and no setting changes that.** Checked 2026-10-30. In Cloud Agents, `stop` fires without the token fields the plugin reads, and `beforeSubmitPrompt`, `afterAgentResponse` and `afterAgentThought` never fire, even though Cursor's hooks docs list them as supported. Cursor staff confirmed the same gap for non-interactive CLI runs on the forum (August 2026) and gave no timeline. The plugin has no option for this; it records only what the hooks send. Writing our own hook doesn't help either, because it would get the same payloads. Two sources fill the gap. `GET https://api.cursor.com/v0/agents/<id>/conversation` returns the prompt and the agent's messages, and works with a personal key. `POST https://api.cursor.com/teams/filtered-usage-events` (Admin API) returns per-call tokens and cost by conversation id, but Cursor lists the Admin API for Enterprise teams only. Our personal key gets 401 "Invalid Team API Key" even though the dashboard shows its scope as "Admin": that scope covers the user's own resources, not the team Admin API. The v1 agent API fills the rest with a personal key on Pro, see the next point. Each trace's `cursor.conversation_id` metadata is the Cursor run id, so the two can be joined. Going the other way, the Langfuse trace id is `sha256("cursor:<run id>:1")`, first 32 hex characters (verified against two traces). The usage events endpoint can also list runs without knowing their ids: filter with `automationId: "*"`, and each event carries `cloudAgentId` (the run id) and `automationId`. Cursor aggregates usage events hourly. Langfuse's legacy `/api/public/ingestion` endpoint shuts down on Langfuse Cloud on 2026-11-16, so write enrichments through OpenTelemetry (`/api/public/otel/v1/traces`) and scores through `/api/public/scores`. Even with tokens, Langfuse has no price for model names like `cursor-grok-4.6-medium` unless someone adds a custom model definition.
- **The v1 agent API has the whole run, including tokens and cost.** Checked 2026-10-30 with the personal Pro key. `GET /v1/agents/<id>/usage` returns tokens and cost per run (`rawCostCents` is the model cost, `chargedCents` what was billed, 0 inside the plan's allowance). Its `inputTokens` excludes cache reads, unlike the Admin API's. `GET /v1/agents/<id>/runs/<run id>/stream` replays the finished run as server-sent events: thinking, text, every tool call with arguments and result, and step boundaries. Event ids are `<unix ms>-<n>`, so every event has a time. The stream doesn't always close after its `done` event, so stop reading there. It was still there 15 hours after a run and gone (410 `stream_expired`) after 36. Neither endpoint names the model, but every hook payload does, and the plugin's root span keeps it as `cursor.model`. `GET /v1/agents` and its `prUrl` filter don't list automation runs, so the run ids also come from the plugin's traces, or from the `RUN_ID:` comment in the `cursor[bot]` PR review. Cursor offers no completion webhook for automations, and its plugin system only packages rules, skills, MCP servers and hooks, so it adds no new data. `GET /v0/agents/<id>/conversation` and the usage endpoint still answered for runs a month old. Cursor answers bursts of calls with 429. `observability/export.mjs` builds full traces from these endpoints.
- **How `export.mjs` writes to Langfuse.** Checked 2026-10-30 against real writes.
  - Each run's trace id includes the environment name, so a test export can never reuse a real trace's ids. Writing the same ids into a second environment left one trace in one environment and another trace duplicated across both.
  - Trace name, tags, session and metadata go on every span, not only the root. Langfuse v4 filters and groups each observation by its own copy, so with them on the root alone the cost, which sits on a model call, couldn't be grouped by automation or repo.
  - `GET /v1/agents/<id>/runs` leaves out each run's final message (`result`). Only `GET /v1/agents/<id>/runs/<run id>` returns it.
  - Real traces go to the `agent-runs` environment. `cloud-agent-api` and `cursor-runs` hold test writes of the same five runs from 2026-10-30, some merged across both. Langfuse can't delete them, so filter them out.
- **Langfuse's v1 read endpoints already return 410.** `GET /api/public/traces`, `/sessions` and `/metrics` answered 410 on 2026-10-30 with a notice that they're removed on 2026-11-16. Read through `/api/public/v2/observations` and `/api/public/v2/metrics`. In v2 metrics the only views are `observations` and the score views, trace fields are dimensions like `traceName` and `tags`, and high-cardinality dimensions such as `sessionId` need `config.row_limit` and a descending `orderBy`.
- **The local CLI fires different hooks from a cloud run.** In `agent -p` (CLI 2026.10.16) `sessionStart`, `sessionEnd` and `afterAgentThought` fired and `stop` didn't, the reverse of the cloud. Its run ids aren't `bc-` ids, so the v1 agent API can't look them up. Local runs can test a hook's code, not cloud behaviour. `agent worker` runs a personal "My Machines" cloud worker without Enterprise, which may give real cloud runs on this machine; untested.
- **What a cloud run's machine looks like at `stop`.** Probed 2026-10-30 in a separate test environment, `agents-test-probe` (typst-editor only, not used by any workflow), with a hook on every event. The run was marked FINISHED in the API one second before `stop` fired. The `stop` payload carries `conversation_id` (the `bc-` agent id), `generation_id` (the run id), `model`, `status` and `cursor_version` 1.0.0, with `transcript_path` and `user_email` null. No transcript file exists anywhere under the home folder, `/tmp` or `/var/tmp`, so a hook can't build the trace from disk. Each run gets a fresh machine (uptime 19 seconds at `stop`). A process started from the `stop` hook with `setsid` kept running and sent heartbeats 10, 30, 60, 120, 300 and 600 seconds after `stop`, long enough to wait the roughly 1 minute usage needs. The machine has an undocumented `CURSOR_AGENT_SOCKET` variable; nothing here uses it. Tool hooks do fire in cloud runs (`preToolUse`, `postToolUse`, `beforeShellExecution`, `afterShellExecution`, `beforeReadFile`), so the plugin's null tool outputs probably come from a payload field name it doesn't expect; a probe logging a full `postToolUse` payload would confirm it.
- **A `stop` hook can export its own run.** Tested 2026-10-31 in `agents-test-probe` with `observability/stop-hook.mjs`, the Cursor key as a runtime secret, and Langfuse environment `hook-test`. The hook starts `export.mjs --run <agent id>:<run id>` with `setsid` and returns at once. The run finished at 14:57:26 UTC, and the full trace was in Langfuse by 14:58:47: prompt, final message, thinking and text per model call, tool calls with output, tokens and cost. `start` also saves the secrets to `~/.agent-trace/env.json`, in case hooks don't inherit them; whether they do is unchecked. Labelling runs `review` or `fix` was confirmed 2026-11-11 in a live `!review` on `tkuhemiya/typst-editor`, with the older method of matching prompt files.
- **Subagents are `task` tool calls with their conversation attached.** Tested 2026-11-08. In the parent's stream, a subagent's `tool-call-completed` event holds `result.value.conversationSteps` (thinking with times, tool calls with results, messages) and the subagent's own `agentId`. It all arrives when the subagent finishes, not while it runs. `/v0/agents/<subagent id>/conversation` answers, `/usage` for a subagent id is empty, and tokens and cost exist only as the parent run's total. `export.mjs` doesn't read any of this yet. The stream also works on a run that is still running, so spans can be written live. Details are in `observability/EVALUATION.md`, section 10.
- **Review and fix traces look identical in Langfuse.** Both use the same environment, so they get the same tags and metadata. Telling them apart needs the run's prompt, from the conversation endpoint above.
- **Re-running sync is safe.** It finds the environment by name, so the id stays the same. A failed build never replaces the active one, so agents keep using the last good build.
- **`GET /v1/environments/{id}` leaves out `environmentJson`.** Checked 2026-11-16 on both environments with the personal key, although the docs list the field. `GET /v1/environments/{id}/history` returns it on the event marked `current: true`, which was the first event both times.
- **Cursor starts builds on its own.** The build list on 2026-11-16 showed `RECURRING` builds on most days for `typst-editor`, each after new commits. One sync on 2026-11-12 led to three builds there (`MANUAL` from the API, then `RECURRING` and `CONFIG_CHANGE` a minute later), and to only the `MANUAL` one on `Ambulink-Main`. Don't count on a config change starting a build.

## Debugging builds

The API has no build-log endpoint. A failed build only returns a code such as `install_failed`. The logs are in the Cursor dashboard under Environments, then Builds, so ask the owner to check there first.

Without dashboard access, the method that worked was a pass/fail search. Patch the environment's `install` to one small base64-wrapped command, start a build, and read the status. Each build takes about a minute, and you can run one per environment in parallel. Re-sync afterwards to restore the real config.

When polling, expect `GET .../builds/{id}` to return an empty body or 404 for a few seconds after the build starts. Treat that as still running.

## Current state (2026-11-16)

- Everything was created with the owner's personal Cursor key ("terraform setup", Pro plan, expires 2027-04-27; sync and apply fail after that), with `CURSOR_ENVIRONMENT_OWNER=personal`. The owner is testing on Pro and expects to run this on Enterprise later, with repos on Bitbucket Cloud.
- The new layout is written and planned, not applied. Cursor still has what the old layout made: the `automation-` and `agents-` environments for each repo, and four workflows named "PR review (...)" and "PR fix (...)".
- `sync-environments.mjs --plan` on 2026-11-16 found both `automation-` environments by their old ids and reported an update and a build for each. The build drops the prompt files and installs the newer `export.mjs`.
- `terraform plan` on 2026-11-16 showed 0 to add, 4 to change, 0 to destroy, with all four workflows moved to their new addresses. The changes are the new names and the marker line on each prompt.
- The plan also showed that "PR fix (AmbuLink-CS-55/Ambulink-Main)" was edited in the dashboard: its prompt is "Telll me what your memory says", memory is on, and it has no environment. An apply puts it back to what the files say. Check with the owner before applying.
- Run sync before the apply. The new exporter reads the marker, and the old one on the machines compares whole prompts, so applying first labels every run `manual` until the build finishes.
- Terraform state is local (`terraform.tfstate` in the root, gitignored). A second person running `apply` would create duplicate workflows. CI needs a remote backend first. Bitbucket has nowhere suitable to keep it, so it needs S3, GCS, Azure Blob or HCP Terraform. No backend is chosen and no pipeline is written.
- The review workflows have the `executor` MCP attached by name. The fix workflows don't, on purpose: the owner only attached it to see whether attaching works. The provider can attach a registered MCP but can't register one.
- `!review` and `!fix` both worked on both repos under the old layout (tested on typst-editor #3 and Ambulink-Main #41). `!fix` pushes to the PR branch and replies with a PR review. The stop-hook export has run live only on `tkuhemiya/typst-editor`.
- Test environments in Langfuse that can't be deleted: `hook-test`, `hook-test-2`, `hook-test-3`, `hook-test-4`, `hook-test-5` (the last holds the current trace shape), plus the older ones listed above. Filter them out.

## Writing style

The owner edits docs and prompts for plain, direct language. Use sentence-case headings, no em dashes and no filler. Say what something does rather than how it feels.
