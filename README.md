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

## Before changing anything

Read [AGENTS.md](AGENTS.md). It records why the setup looks the way it does and the platform behaviour we had to discover the hard way.
