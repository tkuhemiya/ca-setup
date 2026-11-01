# Observability for Cursor automations: proposal notes

Draft, 2026-10-31. Background for a work proposal. It records how we got here, what agent observability is for, and how far it gets us towards prompt and model evaluation. The platform comparison and test results are in [EVALUATION.md](EVALUATION.md).

Langfuse terms below are quoted from the Langfuse docs (langfuse.com/docs, data model, evaluation core concepts, agent graphs and prompt management pages, read 2026-10-31).

## The journey in short

1. **Started with the Langfuse Cursor plugin.** Every `!review` and `!fix` run produced a trace, but with no prompt, replies, tokens or cost.
2. **Patched it with `enrich.mjs`.** It added the missing data as extra spans afterwards. It worked, but it was fragile, and Langfuse v4 doesn't reliably show re-sent spans.
3. **Looked at other platforms.** Phoenix, Opik, Laminar, SigNoz, MLflow and Helicone all receive only what Cursor sends, so switching wouldn't help.
4. **Checked Cursor's hooks and plugin system.** Cloud runs don't send the data to hooks, and plugins only package hooks, rules, skills and MCP servers.
5. **Found the data in Cursor's v1 agent API.** It has the full run: prompt, thinking, text, every tool call and result, timings, tokens and cost. `export.mjs` turns it into one trace per run, and that's verified on real runs.
6. **Tested building the trace inside the run.** It's possible, but it needs an Admin-scope Cursor key on a machine that public PR content can steer. Rejected.
7. **Decision:** a small `stop` hook tells an outside service "run X finished", and that service holds the key and exports the trace. An hourly export job catches anything missed.

## What we really care about

Agent observability isn't about collecting everything. For automations that review and fix PRs, these are the questions it has to answer, roughly in order of value.

| Question | Why it matters | What answers it |
|---|---|---|
| Did the run happen, and did it finish? | Silent failures mean a PR got no review | Trace per run, status |
| What did it cost, per automation, repo and model? | Agents can be expensive, and the default model was | `usage_details` and `cost_details` on each generation, grouped by tags |
| How long did it take, and where did the time go? | Slow reviews arrive after humans have already looked | Observation timings |
| What did the agent actually do? | Debugging a bad review or a wrong fix | Tool observations with input and output, the agent's text |
| Was the output any good? | The whole point; the other questions just make this one answerable | **Scores**, which observability alone doesn't produce |
| Is it getting better or worse after a prompt or model change? | Changes are otherwise made on gut feel | Scores split by prompt version and model |

The first four come from tracing. The last two need evaluation on top.

## How the data maps to Langfuse

- **Trace:** "a single request or operation". For us, one automation run.
- **Observations:** "the individual steps of your application: LLM calls, tool calls, retrieval steps, and so on". For us:
  - one `agent` observation as the root, with the prompt as input and the final message as output;
  - one `generation` per model call, carrying the model name, tokens and cost;
  - one `tool` observation per tool call.
- **Session:** "used to group traces that are part of the same user interaction". We use the Cursor agent id, so follow-up runs on the same agent group together.
- **Environment:** "Separate data from different deployment contexts like `production`, `staging`, or `development`". Real traces go to `agent-runs`; test writes stay in their own environments.
- **Tags:** "Flexible labels to categorize traces by feature, API endpoint, or workflow". We use `cursor`, the automation kind (review or fix) and the repo.
- **Metadata:** "Flexible key-value store for custom information". It holds the automation and repo.
- **Agent graphs:** a "visual representation of complex AI agent workflows". Langfuse draws one when a trace has "an observation with any observation type except `span`, `event`, or `generation`". Our `agent` and `tool` observations qualify, so each run gets a graph without extra work.

## Will this help with prompt and model evaluation?

Partly. Observability gives you the material to evaluate. It doesn't do the evaluation for you.

### What it gives directly, with no extra work

- **Cost, tokens and latency per prompt and per model.** This is exact, because it comes from Cursor's usage endpoint. Comparing Grok 4.6 against Composer 2.5 on cost and speed is a dashboard filter.
- **Every input and output, kept.** That's the raw material for any quality judgement later.
- **Failure and behaviour patterns.** Examples: runs that loop on tool calls, reviews that never read the diff, fixes that edit unrelated files. You find these by reading traces.

### What it doesn't give: quality

Langfuse records quality as **scores**: "Langfuse's universal data object for storing evaluation results". Every score has "a name, a value, and a data type (NUMERIC, CATEGORICAL, BOOLEAN, or TEXT)". Nothing in our setup creates scores yet. Without them, "is the new prompt better?" can only be answered by reading runs one by one.

Ways to add scores, from cheapest to most effort:

1. **Outcome signals from GitHub, via the API.** These are the most honest scores for our case, because they measure what happened. Examples:
   - was the `!fix` commit kept or reverted;
   - did the PR merge;
   - were the review comments resolved or dismissed.
   Langfuse supports this as scores via API/SDK.
2. **Human annotation.** Annotation queues let people "review and rate traces manually". A thumbs-up or thumbs-down on each review is enough to start.
3. **LLM-as-a-Judge, as online evaluation.** "Use an LLM to evaluate outputs based on custom criteria". Online evaluation "scores live traces to catch issues in real traffic" by matching incoming observations with a rule. Example criteria: did the review flag real issues, did it invent any. This needs the full output, which only the export pipeline provides.
4. **Offline evaluation with datasets and experiments.** A dataset is "a collection of test cases (dataset items)", and an experiment "runs your application against a dataset and evaluates the outputs". For us:
   - a dataset item would be a PR with known issues;
   - the task would be starting a Cursor agent on it through the API with a given prompt and model.
   This is the only way to compare prompts or models fairly on the same inputs. It's also the most work, because each experiment run starts real, billed agents.

### Prompt versions

Langfuse prompt management can "Link prompts to traces to analyze performance by prompt version". Our prompts live in this repo and go to Cursor through Terraform, not through Langfuse prompt management, so that link doesn't exist out of the box. The cheap fix is to record the prompt file's git commit in each trace's metadata. Scores and cost can then be split by prompt version without moving prompts into Langfuse.

### By how much

| Evaluation need | Plugin only | With the export pipeline | Plus scores |
|---|---|---|---|
| Cost and latency by model or prompt | None | Full | Full |
| Debug a single bad run | Tool names only | Full | Full |
| Spot behaviour patterns | Hardly | Yes, by reading traces | Yes, and filterable |
| Say whether prompt B beats prompt A | No | Only by reading many runs | Yes, on live traffic |
| Fair model comparison on the same inputs | No | No | Yes, with datasets and experiments |

In short, the export pipeline takes us from "we can see that runs happened" to "we can see everything a run did and what it cost". Quality comparison needs scores on top. Outcome scores from GitHub plus a small LLM-as-a-Judge are the best value next step.

## What Langfuse offers us

Checked against the Langfuse docs and the self-hosting pricing page on 2026-10-31.

| Feature | What Langfuse says | What it does for us | Status |
|---|---|---|---|
| Tracing with typed observations | Observations are "the individual steps of your application" | One readable trace per run, with model calls and tool calls | Working (`export.mjs`) |
| Agent graphs | "Visual representation of complex AI agent workflows" | A graph of each run's steps for free, because we use `agent` and `tool` observations | Working |
| Token and cost tracking | "Ingested values take priority over inferred ones" | We ingest Cursor's real cost, so names like `cursor-grok-4.6-medium` need no custom model definition | Working |
| Custom dashboards | "Select what to measure (count, latency, cost, scores, etc.)" and "Group by user, model, time, trace name, etc." | Cost and latency per automation, repo and model, plus the curated "Latency, Cost" dashboards | Available, not set up |
| Metrics API | "Programmatic access via the Metrics API" | Weekly cost reports without opening the UI (use `/api/public/v2/metrics`) | Tested |
| Scores via API/SDK | "Scores are Langfuse's universal data object for storing evaluation results" | Where GitHub outcomes (merged, reverted, comments resolved) would go | Not built |
| Human annotation queues | "Review and rate traces manually" | The team rates a sample of reviews | Not set up |
| LLM-as-a-Judge | "an LLM is used to assess the quality of outputs produced by another LLM application" | Automatic quality score on each review or fix | Not set up |
| Datasets and experiments | "An experiment runs your application against a dataset and evaluates the outputs" | Fair prompt or model comparisons on past PRs | Not built; each run starts billed Cursor agents |
| Prompt management | "Link prompts to traces to analyze performance by prompt version" | Prompts live in Terraform instead, so we'd record the git commit in metadata | Not used, on purpose |
| Playground | Listed in all plans | Try prompt wording against a model; it can't run a Cursor agent, so it's of little use here | Not relevant |

Notes on the evaluation features:

- **LLM-as-a-Judge needs an "LLM Connection".** That's our own model API key, which Langfuse calls for each evaluation. Langfuse estimates "$0.01-0.10 per assessment" and suggests "using sampling to evaluate a percentage of traces".
- **Score observations, not traces.** "Observation-level evaluators are the recommended target for live production data". Trace-level evaluators "are deprecated", and on Langfuse Cloud they stop producing results after 2026-11-16. Target our root `agent` observation with the "Is Root Observation" filter, and narrow it with tags (review or fix, repo).
- **Scores show up everywhere.** Dashboards and LLM-as-a-Judge both work with scores, so once outcome scores exist, quality can be charted by model and prompt version next to cost.

### Self-hosted, free or paid

Per Langfuse's self-hosting pricing page, the free MIT version includes:

- LLM-as-judge evaluators, human annotation queues and datasets;
- experiments, via both the SDK and the UI;
- custom dashboards, prompt versioning and the playground;
- Enterprise SSO and organization-level RBAC.

Only these are paid Enterprise features:

- project-level RBAC;
- audit logs;
- data retention management;
- protected deployment labels.

Nothing in our plan needs a paid Langfuse licence. Audit logs or retention rules may matter at work if traces contain code or customer data.

## Doing this at work

Work uses Bitbucket, not GitHub. A Forge app would take months of IT approval, and Bitbucket limits API calls to roughly 1000 requests an hour.

### Outcome scores from Bitbucket without an app

Use a scheduled job with a normal access token, not an app.

1. **Collect.** Once a day, for each repo with automations, list the pull requests updated since the last pass. Each page returns up to 50 pull requests, so a quiet repo costs one or two requests.
2. **Fetch.** Only for pull requests that had an agent run, fetch the comments and commits.
3. **Write scores.** Write the results as Langfuse scores on that run's trace.

Example numbers: with 10 repos and 30 agent runs a day, one pass costs about 10 list requests plus 2 or 3 per run, so roughly 100 requests a day against a 1000-an-hour limit.

To join a pull request to a trace, use the run id. The review already posts it in its comment (`RUN_ID:`), so the job reads it back from Bitbucket.

Possible scores:

| Score | Type | How to measure |
|---|---|---|
| `pr_merged` | BOOLEAN | Pull request state is merged |
| `fix_kept` | BOOLEAN | The agent's commit is still in the merged branch |
| `review_comments_resolved` | NUMERIC | Share of the agent's comments marked resolved, if Bitbucket's API returns it; check first |
| `human_reply` | BOOLEAN | Someone replied to the agent's comment |

Bitbucket webhooks are an alternative. They're a repo setting, not an app, but they need repo admin rights and an endpoint Bitbucket can reach. The daily job needs neither.

### Annotation queues

Annotation queues are part of the Langfuse web app, under evaluation, and come with free self-hosting. People open a queue, read each trace and fill in score fields defined in advance, such as "useful review: yes/no". Nothing needs to be built.

### Experiments when agents change things

Re-running a review or fix agent for an experiment would post comments or push commits. Ways to avoid that:

- **Judge real runs instead of re-running.** Run LLM-as-a-Judge and outcome scores on production traffic, then compare before and after a prompt or model change. This isn't a side-by-side test, but it costs nothing extra and has no side effects. Start here.
- **Run experiments on a mirror repo.** Copy past pull requests into a sandbox repo nobody watches. Comments and pushes land there and harm nothing. Judge the review text and the fix diff.
- **Output-only prompt variant.** Add a suffix telling the agent to return its review as the final message instead of posting it. The final message is captured in the trace. The catch is that the prompt under test is no longer exactly the production prompt.

Full experiments are only worth it for a big decision, such as switching the default model.

## Suggested phases for the proposal

1. **Tracing:** the `stop` hook, the outside exporter and the hourly backstop. Gives cost, latency and full run detail.
2. **Outcome scores:** a job that writes GitHub outcomes as scores onto each run's trace.
3. **Online LLM-as-a-Judge** on review outputs, plus an annotation queue for spot checks.
4. **Datasets and experiments,** once there's a real prompt or model decision to make. Build the dataset from past PRs where the outcome is known.

## Constraints to state up front

- Cursor keys are Admin-scope only, so they never go on agent machines.
- Cursor's run stream expires about a day after a run, so the exporter must run at least daily or the trace loses its tool calls.
- Enterprise adds an OTLP export of logs and metrics, including tokens and model. It has no traces, and it complements this pipeline rather than replacing it. Langfuse's OTLP endpoint accepts traces only, so that export needs its own collector and metrics backend.
- Self-hosted Cloud Agent workers hold a service account key in the same container the agent works in. Test whether agents can read it before relying on self-hosting for key isolation.
- Langfuse's v1 read API is removed on 2026-11-16, so any tooling must use the v2 endpoints.
