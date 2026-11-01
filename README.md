# ca-setup

Cursor Cloud Agent setup for our repos, in two independent halves:

- `environments/`: what an agent runs in (toolchain, dependencies, Langfuse tracing).
- `automations/`: what an agent does (PR review on `!review`, PR fix on `!fix`), managed with Terraform.

They connect through one file: `environments/ids.json`. `sync.mjs` writes it and Terraform reads it.

## Run it

```sh
cp .env.example .env    # fill in the keys
node --env-file=.env environments/sync.mjs
cd automations && terraform init && terraform apply
```

`sync.mjs` options: `[owner/repo]` to sync one repo, `--dry-run` to print the environment JSON without calling the API, `--no-build` to update without starting a build.

## Add a repo

1. Create `environments/repos/<owner>/<repo>/environment.json`. Any field from [Cursor's environment.json](https://cursor.com/docs/cloud-agent/setup) works. `install` and `start` accept a string or an array of lines:
   ```json
   {
     "install": [
       "npm install -g bun",
       "bun install --frozen-lockfile"
     ]
   }
   ```
2. Run `sync.mjs` and wait for the build to succeed.
3. Create `automations/repos/<owner>/<repo>/main.tf` listing the automations the repo runs, plus its prompts. Copy an existing repo folder as a starting point.
4. Add a `module` block for the repo to `automations/main.tf`, then `terraform apply`.

## How re-running sync behaves

`sync.mjs` finds each environment by name (`agents-<owner>-<repo>`) and updates it in place, so re-running never creates duplicates and the id in `ids.json` stays the same. Each run starts a new build of that environment:

- A build that succeeds becomes the active one.
- A build that fails is discarded, and agents keep using the last good build.
- Builds re-run `install`, so `install` must be safe to run twice.

Use `--no-build` when only secrets changed, or `[owner/repo]` to rebuild one repo.

## Enrich traces in Langfuse

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
