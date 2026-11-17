# ca-setup

Cursor Cloud Agent setup for our repos: the machine each agent runs on, and the automations that start agents.

| Path | What it holds |
|---|---|
| `repos/<repo>/` | One folder per repo. `environment.json` describes the agent's machine. Prompt text about the repo goes here too. |
| `review.tf`, `fix.tf` | One file per automation. Each lists the repos it runs on. |
| `instructions/` | Prompt text shared between repos. |
| `modules/automation/` | Turns one automation into one Cursor workflow per repo. |
| `scripts/sync-environments.mjs` | Creates and updates the environments in Cursor. The Terraform provider can't. |
| `settings.json` | The host and workspace the repos live under. |
| `tracing/`, `observability/` | Send each run's trace to Langfuse. |

Two tools apply the files. `sync-environments.mjs` manages environments and writes `ids.json`. Terraform manages workflows and reads `ids.json` to find each repo's environment.

## Apply the setup

Both tools change a real Cursor account. Plan first.

```sh
cp .env.example .env                                         # fill in the keys
node --env-file=.env scripts/sync-environments.mjs --plan    # reads only
set -a && . ./.env && set +a                                 # Terraform reads CURSOR_TOKEN
terraform init && terraform plan

node --env-file=.env scripts/sync-environments.mjs           # then wait for the builds
terraform apply
```

Run sync before `terraform apply`. The apply needs the environment ids, and the exporter on the machines must be current before prompts change.

## Add a repo

1. Create `repos/<repo>/environment.json`. Name the folder after the repo.
   ```json
   {
     "install": [
       "npm install -g bun",
       "bun install --frozen-lockfile"
     ]
   }
   ```
2. Run sync and wait for the build to succeed.
3. Add the folder name to `repos` in each automation that runs on the repo.
4. If an automation's `instructions` has a `{repo}` path, such as `repos/{repo}/review.md`, create that file for the new repo.
5. Run `terraform apply`.

## Add an automation

Create `<name>.tf` in the root with one module block, then run `terraform apply`.

```hcl
module "review" {
  source       = "./modules/automation"
  name         = "review"
  description  = "Reviews the PR when someone comments !review."
  repos        = ["Ambulink-Main", "typst-editor"]
  trigger      = { comment = "!review" }
  tools        = { mcp = ["executor"], inline_comments = false }
  instructions = ["repos/{repo}/review.md"]
}
```

Each repo in `repos` gets its own workflow, named `review (<workspace>/<repo>)`, running in that repo's environment.

| Input | Value |
|---|---|
| `name` | Short name. It labels the workflow and the run's trace in Langfuse. |
| `description` | Shown in the Cursor dashboard. |
| `repos` | Folder names under `repos/`. |
| `trigger` | Set one of `comment` (text in a pull request comment), `label` (a label added to a pull request, GitHub only), `cron` (a schedule), or `webhook = true`. `allowed_users` limits who can start it. |
| `model` | `{ id, params }`. Defaults to Grok 4.6, medium effort, not fast. |
| `tools` | `mcp` (names of MCP servers registered in Cursor), `pr_comment` (on by default), `inline_comments`, `approve`, `memory`. |
| `instructions` | Markdown files joined in order into the prompt. Paths start at the repo root. `{repo}` becomes the repo's folder name. |

A `cron` or `webhook` automation still runs once per repo. Each repo's webhook has its own URL and key, shown in the Cursor dashboard.

## Fields of `environment.json`

| Field | Value |
|---|---|
| `install`, `start` | A command, or a list of lines that run as one script. `install` runs at build time and must be safe to run twice. `start` runs when an agent boots. |
| `variables` | Plain values, such as `{"NODE_ENV": "test"}`. They are committed. |
| `secrets` | A list of names, such as `["DATABASE_URL"]`. Sync reads each value from the variable `<REPO>_<NAME>` in its own environment, for example `TYPST_EDITOR_DATABASE_URL`. Set it as a secured variable in CI, or in `.env` on a laptop. Cursor redacts secrets from agent output. |
| `tracing` | `false` leaves out the stop hook and the Cursor and Langfuse keys. Defaults to `true`. |
| `repo` | `<workspace>/<name>`, when the repo is not `<workspace in settings.json>/<folder name>`. |

Any other field from [Cursor's environment.json](https://cursor.com/docs/cloud-agent/setup) is sent to Cursor as it is.

With tracing on, sync sets `CURSOR_TOKEN`, the `LANGFUSE_*` names and `AGENT_TRACE_ENVIRONMENT` itself, so a repo can't reuse those names.

## How sync behaves

Sync finds each environment by name (`automation-<workspace>-<repo>`), reads what Cursor has, and changes only what differs. Running it again never creates a duplicate.

- **Variables.** Sync sends every variable on every run, because Cursor never returns a value. It deletes any variable that no file asks for, so set variables in the files and not in the dashboard.
- **Builds.** Sync starts a build when the environment's commands changed, or a variable was added or removed. A build that fails is discarded, and agents keep using the last good build.
- **`--build <repo>`.** Forces a build. Use it after a failed build, and after giving an existing secret a new value.
- **`--plan`.** Prints what a sync would do and changes nothing. It needs only `CURSOR_TOKEN`.
- **`ids.json`.** Sync rewrites it on every run, plan or not. Git ignores it. Losing it costs nothing.
- **Deleted folders.** Sync reports an environment whose folder is gone. It never deletes one.

## Enrich traces in Langfuse

`enrich.mjs` doesn't run at the moment. It was written for the Langfuse plugin's traces and still reads settings and folders that are gone. See [AGENTS.md](AGENTS.md) before using it.

Cloud Agent hooks don't send each run's prompt, final message or token counts. `observability/enrich.mjs` adds them afterwards from Cursor's API, plus which automation ran on which repo:

```sh
node --env-file=.env observability/enrich.mjs            # enrich runs traced in the last 6 hours
node --env-file=.env observability/enrich.mjs --dry-run  # print the request body, don't write
```

Run it hourly. Each pass skips what earlier passes wrote. Run details appear on the first pass after a run. Cost waits until the run has been finished for two hours, because Cursor reports usage in hourly buckets and a cost written early could be incomplete. That's why the default window is 6 hours. If the job was down for longer, catch up once with a bigger `--since`, such as `--since 2d`.

Tokens and cost need a Cursor Admin API key (`CURSOR_ADMIN_API_KEY`), which only Enterprise teams can create. To try the cost step without one, pass `--usage-file observability/fixtures/usage-events.sample.json` together with `--dry-run`. The sample holds made-up numbers against a real run id, so don't run it without `--dry-run`.

## Full traces from Cursor's API (trial)

`observability/export.mjs` builds a complete trace for each run from Cursor's v1 agent API: the prompt, each model call with its thinking and text, each tool call with arguments and results, real timings, and tokens and cost. It works with a personal key on the Pro plan. The traces go into a separate Langfuse environment (`agent-runs`), so the plugin's traces are unchanged. Each run is written once; later passes skip runs that already have a trace.

```sh
node --env-file=.env observability/export.mjs --dry-run   # print each run's OTLP body, don't write
```

Cursor drops a run's event stream after about a day, so run it at least every few hours. A run found later gets a smaller trace: prompt, messages and usage, without tool calls. The run ids and model names come from the plugin's traces, because Cursor's API lists neither for automation runs.

## Before changing anything

Read [AGENTS.md](AGENTS.md). It records why the setup looks the way it does and the platform behaviour we had to discover the hard way.
