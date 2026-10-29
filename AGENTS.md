# Notes for coding agents

This file covers what the code can't tell you: why the setup looks the way it does, what the Cursor and Langfuse platforms actually do (not what their docs say), and what state the live resources are in. Read the code for everything else.

Facts below were verified on 2026-10-29 against Cursor's Environments API (beta), the `cursor/cursor` Terraform provider 0.8, and Langfuse's Cursor plugin at commit `a36d39a`. Platforms move fast. If something here contradicts what you observe, trust the observation and update this file.

## Ask before touching live resources

`sync.mjs` and `terraform apply` change a real Cursor account. The workflows they create answer `!review` and `!fix` comments on real GitHub repos, and `!fix` pushes commits. Don't run either without the owner's go-ahead. `sync.mjs --dry-run` and `terraform plan` are safe.

## Design decisions

### Two halves, one file between them

`environments/` (what an agent runs in) and `automations/` (what an agent does) stay separate. The owner pushed back hard on an earlier draft that merged them by repo. They change for different reasons and at different times. The only link is `environments/ids.json`. Don't make either side read the other's files.

Environments live in a Node script, not Terraform, because the provider has no environment resource. If a later provider version adds one, moving environments into Terraform is worth raising with the owner. Don't just do it.

### Explicit Terraform, no clever discovery

An earlier version found repos with `fileset()` and `for_each` and fell back to shared prompts when a repo had none. The owner rejected it as hard to read. The rules now:

- Each repo lists its automations by hand in `automations/repos/<owner>/<repo>/main.tf`.
- Every module call names its prompt file. No fallback logic.
- The owner wants control over which repos get which automation. Some repos will get only some automations.

The repetition between repo files is deliberate. Don't refactor it into loops or maps.

Repo folders are Terraform modules because Terraform only loads `.tf` files from the root directory. The owner chose folder-per-repo over flat `repo.<name>.tf` files in the root, because flat files get hard to navigate past ten or so repos. The `../../../workflows/...` module sources are the price for that, and it's accepted.

The environments side does discover repos by folder. That asymmetry is fine, because there's no choice to make there: a repo with an `environment.json` gets an environment.

### Fail loud on missing environment ids

Repo modules index `var.environment_ids[local.repo]` directly instead of using `lookup()` with a default. A repo missing from `ids.json` should stop `terraform plan`. Falling back to Cursor's default environment would run agents without the toolchain and without Langfuse tracing, and nobody would notice.

### Same paths on both sides

Both halves use `repos/<owner>/<repo>/`. The `github.com/` level from the original layout was dropped, because every repo is on GitHub.

### Langfuse is layered on centrally

Tracing is added by `sync.mjs` from `environments/shared/`, so target repos never contain Cursor or Langfuse files. Keeping all agent setup in this repo is the whole point of the project. Don't solve problems by committing `.cursor/environment.json` or `.cursor/hooks.json` into a target repo, even though Cursor and Langfuse both document that route.

Related choices:

- `install.sh` (at build time) and `langfuse-start.sh` (at boot) both write the hooks into the checkout's `.cursor/` and hide that folder with `.git/info/exclude`, not `.gitignore`. Running both doesn't register the hooks twice. Keys only go in at boot, because runtime secrets aren't available during the build. That stops a `!fix` agent from committing the hooks or the keys file to the target repo.
- Langfuse setup must never stop an agent. That's why `start` joins the shared and repo steps with `;` while `install` uses `&&`.
- The Langfuse keys go up as `runtime_secret`, which Cursor redacts from agent output. The other Langfuse settings are plain env vars on purpose.
- The Langfuse project is in the Japan region. Keys only work against `https://jp.cloud.langfuse.com`.

### Prompts

Review prompts are per repo because a useful review needs to know the stack: workspace layout, lint commands, what breaks across packages. The fix prompt is shared, because the fixing agent finds the project's commands itself. Review prompts tell the agent not to modify files and not to invent issues. Keep both rules in new review prompts.

## Platform behaviour you can't see in the code

- **Inline Dockerfiles are gated.** `build.dockerfileContents` fails the build with `dockerfile_contents_not_enabled` on this account. That's why environments use Cursor's default image plus `install`. The default image already has Node 22+ through nvm, `sudo` without a password, and a global npm prefix that installs without sudo.
- **`egressAllowlist` replaces network access instead of adding to it.** Setting it to the Langfuse host blocked npm, and every install failed. Leave it out unless you list every host the build needs.
- **Cursor re-quotes `install` and `start`.** A command with escaped quotes fails with nothing but `install_failed`. That's why `sync.mjs` sends every command base64-wrapped. Keep that wrapping.
- **The Langfuse plugin isn't on npm.** Langfuse's docs say `npm install -g @langfuse/cursor-observability-plugin`, which returns 404. `shared/install.sh` installs a GitHub tarball pinned to a commit. A tarball skips the package's `prepack` step, which needs pnpm, and the repo commits its built `dist/`, so nothing compiles. To upgrade, first check whether npm has it (`npm view @langfuse/cursor-observability-plugin`). If not, bump the commit hash.
- **The provider can't store an empty allowlist.** With provider 0.8, `user_allowlist = []` comes back from the API as `null`. Terraform then reports "inconsistent result after apply" and taints the workflow. Use `null` for "anyone".
- **Workflows without a model run on an expensive default.** Unset, Cursor assigned `grok-4.7-high-fast`. The owner chose Grok 4.6 with medium effort, non-fast, for every automation. Most models default to their fast and high-effort variants, so the workflow modules set every parameter explicitly.
- **Parameter names differ between models.** Grok 4.6 calls it `effort`, Grok 4.7 calls it `reasoning_effort`, and Composer 2.5 has only `fast`. The provider has no model-list data source. `GET https://api.cursor.com/v1/models` returns each model's canonical id, parameters and default variant. Use the canonical id, because the server rewrites aliases like `composer`, which shows up as a diff.
- **`max_mode` must be `true`.** Max mode is Cursor's long-context variant, such as Grok 4.7's 500k context. Grok 4.6 and Composer 2.5 have no max-mode variant, so `true` changes nothing for them. Leaving it unset makes the apply report "inconsistent result", because the server always reports it back as `true`. Setting it to `false` fails the plan with "not supported by the server yet".
- **Team environments need a key on a Cursor team.** A personal key gets a 400 error for owner `team`. Service accounts are Enterprise-only. Cursor documents no way to transfer personal resources to a service account, so switching means re-running sync and apply with the new key, then deleting the old resources.
- **Service accounts need the team-level GitHub app.** A personal GitHub connection isn't enough. Both GitHub owners (`AmbuLink-CS-55` and `tkuhemiya`) need the app installed.
- **Register hooks at build time, not in `start`.** Cursor's `start` runs alongside the agent, so a hooks file written there can arrive after the agent has already read `.cursor/hooks.json`. On 2026-10-29 the two `!review` runs, the first runs after a rebuild, sent no traces, while the two `!fix` runs 11 minutes later did. Both kinds read and write files, so the difference wasn't the work they did. `shared/install.sh` now writes the hooks file during the build, so it's in the snapshot before any agent starts. That fixed it: after the next rebuild, the first runs were two `!review`s and both were traced. Don't move hook registration back into `start`. Don't read the plugin README's "hooks start only once the agent has a writable environment" as "read-only runs aren't traced" either. That was an earlier wrong guess. To check whether a run happened at all, look on the PR for a `cursor[bot]` review with `CURSOR_AUTOMATION_ID` in the body, or call `GET https://api.cursor.com/v0/agents/<run id>/conversation`.
- **Traces have no tokens, cost, prompt or replies, and no setting changes that.** Checked 2026-10-30. In Cloud Agents, `stop` fires without the token fields the plugin reads, and `beforeSubmitPrompt`, `afterAgentResponse` and `afterAgentThought` never fire, even though Cursor's hooks docs list them as supported. Cursor staff confirmed the same gap for non-interactive CLI runs on the forum (August 2026) and gave no timeline. The plugin has no option for this; it records only what the hooks send. Two sources fill the gap. `GET https://api.cursor.com/v0/agents/<id>/conversation` returns the prompt and the agent's messages, and works with a personal key. `POST https://api.cursor.com/teams/filtered-usage-events` (Admin API) returns per-call tokens and cost by conversation id, but needs a team admin key: a personal key gets 401 "Invalid Team API Key". Each trace's `cursor.conversation_id` metadata is the Cursor run id, so the two can be joined. Even with tokens, Langfuse has no price for model names like `cursor-grok-4.6-medium` unless someone adds a custom model definition.
- **Review and fix traces look identical in Langfuse.** Both use the same environment, so they get the same tags and metadata. Telling them apart needs the run's prompt, from the conversation endpoint above.
- **Re-running sync is safe.** It finds the environment by name and patches it, so the id stays the same. Each run starts a build. A failed build never replaces the active one, so agents keep using the last good build.

## Debugging builds

The API has no build-log endpoint. A failed build only returns a code such as `install_failed`. The logs are in the Cursor dashboard under Environments, then Builds, so ask the owner to check there first.

Without dashboard access, the method that worked was a pass/fail search. Patch the environment's `install` to one small base64-wrapped command, start a build, and read the status. Each build takes about a minute, and you can run one per environment in parallel. Re-sync afterwards to restore the real config.

When polling, expect `GET .../builds/{id}` to return an empty body or 404 for a few seconds after the build starts. Treat that as still running.

## Current state (2026-10-29)

- Everything was created with the owner's personal Cursor key, with `CURSOR_ENVIRONMENT_OWNER=personal`. Both environment builds succeeded, and all four workflows are applied.
- Terraform state is local (`automations/terraform.tfstate`, gitignored). A second person running `apply` would create duplicate workflows. It needs a remote backend before anyone else uses this.
- `!review` and `!fix` both work on both repos (tested on typst-editor #3 and Ambulink-Main #41). `!fix` pushes to the PR branch and replies with a PR review. Langfuse gets a trace for every run of both automations, without token counts.

## Writing style

The owner edits docs and prompts for plain, direct language. Use sentence-case headings, no em dashes and no filler. Say what something does rather than how it feels.
