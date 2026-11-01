# Cursor API reference

Verified 2026-10-31. Cursor's API changes often, so check a field against the live response or the OpenAPI spec before you build on it.

## How to read this

Each fact has a source tag:

- **[docs]** Cursor's published docs, as fetched on 2026-10-31. The fetch tool summarized the pages, so check exact field names in the OpenAPI spec before coding against them.
- **[live]** A read-only GET made with this repo's personal key on 2026-10-31. Nothing was written.
- **[repo]** Code in this repo calls it. The file is named.
- **[observed]** Seen in use by this project and recorded in `AGENTS.md`. Not in the published docs.

Sections marked **not retrieved** are the gaps listed at the end.

## Contents

1. [API families](#1-api-families)
2. [Base URL, authentication, and keys](#2-base-url-authentication-and-keys)
3. [Errors](#3-errors)
4. [Pagination and rate limits](#4-pagination-and-rate-limits)
5. [Cloud Agents API v1](#5-cloud-agents-api-v1)
6. [Cloud Agents API v0 (legacy)](#6-cloud-agents-api-v0-legacy)
7. [Admin API](#7-admin-api)
8. [Organization API](#8-organization-api)
9. [Analytics API](#9-analytics-api)
10. [AI Code Tracking API](#10-ai-code-tracking-api)
11. [Bugbot API](#11-bugbot-api)
12. [Origin API](#12-origin-api)
13. [Automations (private interface)](#13-automations-private-interface)
14. [Behaviour that is not in the docs](#14-behaviour-that-is-not-in-the-docs)
15. [Gaps](#15-gaps)

---

## 1. API families

| Family | Base | Auth | Plan limits | Used in this repo |
|---|---|---|---|---|
| Cloud Agents v1 | `https://api.cursor.com/v1` | Basic or Bearer | Personal keys work on Pro **[live]** | `sync.mjs`, `observability/export.mjs`, `enrich.mjs` |
| Cloud Agents v0 (legacy) | `https://api.cursor.com/v0` | Basic or Bearer | Personal keys work **[live]** | `export.mjs`, `enrich.mjs` |
| Admin API | `https://api.cursor.com/teams/...` | Basic, team admin key | Some routes Enterprise only **[docs]** | `enrich.mjs` (usage events) |
| Organization API | `https://api.cursor.com/organizations/...` | Basic, organization key | Organization admin | Terraform provider (groups) |
| Analytics API | `https://api.cursor.com/analytics/...` | Basic, `admin:*` or `read:*` | Enterprise only **[docs]** | No |
| AI Code Tracking API | `https://api.cursor.com/analytics/ai-code/...` | Basic | Enterprise, alpha **[docs]** | No |
| Bugbot API | `https://api.cursor.com/bugbot/...` and `/analytics/team/bugbot-reviews` | Basic | Enterprise **[docs]** | No |
| Origin API | `https://api.cursor.com/v1/origin`, and `https://origin.cursor.com` for Git | Bearer (Origin tokens) | Not stated | Terraform provider (repos, rulesets, grants) |
| Automations | `https://api2.cursor.sh` (Connect RPC) | Cursor token | Not public | Terraform provider |

The Cloud Agents v1 API is in public beta and may change before general availability **[docs]**.

---

## 2. Base URL, authentication, and keys

### Base URL

All REST families use `https://api.cursor.com`. Paths begin with a version (`/v1`, `/v0`) or a family name (`/teams`, `/analytics`, `/organizations`, `/bugbot`).

### Authentication

Two methods, used by different families:

| Method | How | Families |
|---|---|---|
| HTTP Basic | API key as the username, empty password: `curl -u "$KEY:"` | Admin, Organization, Analytics, AI Code Tracking, Bugbot. Also accepted by Cloud Agents. |
| Bearer | `Authorization: Bearer $KEY` | Cloud Agents. Origin uses its own tokens (section 12). |

Both work for Cloud Agents. This repo uses Bearer **[repo]** (`sync.mjs`, `export.mjs`).

### Key types

| Key | Source | Use |
|---|---|---|
| User API key | Dashboard, API Keys (`https://cursor.com/dashboard/api`) **[docs]** | Cloud Agents for that user's resources. Carries the `admin` scope but only over the user's own resources **[observed]**. |
| Service account key | Enterprise **[observed]** | Automation. Builds and sub-tokens need the `agent` scope **[docs]**. |
| Team admin key | Dashboard **[docs]** | Admin, Analytics, AI Code Tracking, Bugbot. A personal key gets `401 Invalid Team API Key` on team routes **[observed]**. |
| Organization key | Dashboard **[docs]** | Organization routes only. |
| Origin token | Origin CLI or app **[docs]** | Origin only. Cursor API keys are not valid here. |
| `crsr_` and `key_` keys | Provider accepts both and exchanges them for a session token **[repo]** (Terraform provider README) | Automations (section 13). |

Not accepted by the Cloud Agents API **[docs]**: team API keys, automation webhook keys, and any key starting with `grok_` (returns `403 key_not_supported`).

### Scopes

Admin, Organization, and Analytics keys carry scopes:

| Scope | Covers |
|---|---|
| `admin:*` | Everything below. Required to trigger Bugbot reviews and to start Grok Bot operations. |
| `read:*` | Reads on analytics and Bugbot review analytics. |
| `members:read`, `members:*` | Organization members and groups. |
| `usage:*` | Organization usage routes. |
| `models:read`, `models:*` | Model access routes. |
| `auditlogs:read` | Organization audit logs. |
| `agent` | Cloud Agents. Builds, sub-tokens, and service account keys. |

Writes need the `*` form. `read:*` on a write returns `401` **[docs]**.

### Keys with no read-only option

Personal API keys come with Admin scope only. A key on an agent's machine can read every agent conversation on the account, start billed agents, and change environment scripts. Keep Cursor keys off agent machines **[observed]**.

---

## 3. Errors

Three body shapes appear. Check the status first, then the body.

| Shape | Seen on | Example |
|---|---|---|
| `{"code": "error", "message": "..."}` | Cloud Agents v1 `401`; Admin `401`; Organization | `{"code":"error","message":"Invalid User API Key"}` **[live]** |
| `{"error": {"code": "...", "message": "..."}}` | Cloud Agents v1 `404`, `Error` schema (also `helpUrl`, `provider`, `environmentId`) | `{"error":{"code":"agent_not_found","message":"Agent not found"}}` **[live]** |
| `{"error": "..."}` or `{"outcome": "error", "message": "..."}` | Some legacy Admin routes; Bugbot trigger `400` | Varies by route **[docs]** |

### Status codes and named errors

| Status | Named codes (from docs) |
|---|---|
| 400 | `validation_error` (also: steer body with extra fields, unknown pool name, unsupported `hostingType`) |
| 401 | `unauthorized` (missing scope); `Invalid User API Key` |
| 403 | `feature_unavailable` (steer on an unsupported account), `team_admin_required`, `user_required`, `repository_access`, `team_membership_required`, `personal_secrets_disabled`, `key_not_supported` |
| 404 | `agent_not_found`, `environment_not_found`, `build_not_found`, `run_not_found`, `secret_not_found` |
| 409 | `agent_busy` (run already active), `agent_id_conflict`, `run_not_cancellable`, `environment_name_conflict`, `environment_repo_edit_blocked`, `repo_file_environment_locked`, `secret_name_ambiguous`, `secret_name_conflict`, `secret_scope_conflict`, `secret_limit_reached` |
| 410 | `stream_expired` (stream past retention; response includes `X-Cursor-Stream-Retention-Seconds`). Read the run state instead. |
| 429 | `rate_limit_exceeded` (too many requests, or too many builds in progress). Headers include `Retry-After`. |
| 500 | Generic internal error |
| 503 | `upstream_error`. A build may have started. Check the build list before retrying. |

---

## 4. Pagination and rate limits

### Pagination

Cloud Agents and Organization use cursors:

- Request `cursor` and `limit`.
- Response returns `items` and `nextCursor`.
- `nextCursor` is omitted on the last page for agents, runs, and environments. For secrets it is `null`.
- Send the same filters with each cursor.

Admin and Analytics use `page` (1-indexed) and `pageSize`. Admin's default page size varies by route; Analytics caps `pageSize` at 500 (by-user) or 250 (Bugbot).

### Rate limits

Cloud Agents does not publish numbers, only "standard rate limiting". `429 rate_limit_exceeded` is returned in bursts **[observed]**. Build starts are the one endpoint named with a 429 **[docs]**.

| Family | Limit | Source |
|---|---|---|
| Admin, per team | 20/min: audit logs, daily usage, directory groups (per route), model access, Grok Bot (per endpoint); 60/min: filtered usage events; 250/min: user spend limit; 50/min: remove member; 20/min: bulk spend limits (preview), billing group writes | [docs] |
| Organization | 20/min: usage routes, model access, groups per org; 120/min: Grok Bot operations GET | [docs] |
| Analytics, team-level | 100/min per team | [docs] |
| Analytics, by-user | 50/min per team | [docs] |
| Analytics, `conversation-insights` | 20/min | [docs] (API overview; conflicts with the 100/min team-level figure) |
| Bugbot trigger | 30/min per team; 10/min more for dry runs | [docs] |
| Origin | `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Used`, `X-RateLimit-Reset`; Git has a separate budget (`X-RateLimit-Resource: git`) | [docs] |

Admin and Organization `429` responses include `Retry-After: 60`. Retry only after that delay. Do not retry a build start automatically on `503` or `429` **[docs]**.

---

## 5. Cloud Agents API v1

Base: `https://api.cursor.com/v1`. Public beta **[docs]**.

Endpoint paths and methods below are from the docs and the OpenAPI spec. Field-level details come from the endpoint docs unless tagged.

### 5.1 Agents

An agent is durable. Each prompt you send creates a run on that agent.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/agents` | Create an agent and queue its first run. Returns `201` with `agent` and `run`. |
| `GET` | `/v1/agents` | List agents, newest first. |
| `GET` | `/v1/agents/{id}` | Get agent metadata. Use `latestRunId` for run state. |
| `DELETE` | `/v1/agents/{id}` | Delete permanently. Irreversible. Returns `{id}`. |
| `POST` | `/v1/agents/{id}/archive` | Archive. Idempotent. Returns `{id}`. |
| `POST` | `/v1/agents/{id}/unarchive` | Unarchive. Idempotent. Returns `{id}`. |

**`POST /v1/agents` body (`CreateAgentRequest`)**

| Field | Type | Notes |
|---|---|---|
| `prompt` | object | Required. `text` (required), `images` (max 5). |
| `model` | object | `id` (required), `params` (array of `{id, value}`). |
| `name` | string | 1 to 100 characters. |
| `agentId` | string | `bc-<uuid>`. Idempotency key. A conflict returns `409 agent_id_conflict`. Not combinable with `envVars`. |
| `env` | object | `type` (required): `cloud`, `pool`, or `machine`. `name` names the pool or machine. |
| `repos` | array | Max 500. Each has `url` (required), `startingRef`, `prUrl`. |
| `workOnCurrentBranch` | boolean | Default `false`. |
| `autoCreatePR` | boolean | Default `false`. |
| `skipReviewerRequest` | boolean | Default `false`. |
| `envVars` | object | Max 50 entries. Values 1 to 4,096 bytes. |
| `mcpServers` | array | Max 50. See MCP server shapes below. |
| `customSubagents` | array | Max 20. Each has `name` (1 to 100), `description` (1 to 1,000), `prompt` (1 to 8,192), `model` (`inherit`, a string, or a `ModelRef`). |
| `mode` | string | `agent` (default) or `plan`. |

**Image shape**: `data` (base64, max 15 MB) or `url`, exactly one. `mimeType` is PNG, JPEG, GIF, or WebP. `dimension` is `{width, height}`, both at least 1.

**MCP server shapes**

- Stdio: `{name, command (required), type: "stdio", args[], env{}}`
- Remote: `{name, url (required), type: "http" | "sse", headers{}, auth}`. `auth` has `CLIENT_ID` (required), `CLIENT_SECRET`, `scopes[]`.

**Response (`CreateAgentResponse`)**: `agent` and `run`.

**Agent object**

| Field | Notes |
|---|---|
| `id` | `bc-<uuid>` |
| `name`, `status`, `env`, `url`, `createdAt`, `updatedAt`, `latestRunId` | `status` is `ACTIVE`, `IDLE`, or `ARCHIVED` in the endpoint docs. The OpenAPI `AgentSummary` lists only `ACTIVE` and `ARCHIVED`. |
| `repos`, `workOnCurrentBranch`, `autoCreatePR`, `skipReviewerRequest`, `customSubagents` | Echoed from create. |
| `openAsCursorGithubApp` | Seen in responses **[live]**, not in the published schema. |

**`GET /v1/agents` query**: `limit` (1 to 100, default 20), `cursor`, `prUrl` (URI), `includeArchived` (default `true`). Returns `{items, nextCursor}`.

Observed: `GET /v1/agents` does not list automation runs **[observed]**.

### 5.2 Runs

A run is one prompt's work on an agent.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/agents/{id}/runs` | Send a follow-up, or steer a live run. |
| `GET` | `/v1/agents/{id}/runs` | List runs, newest first. |
| `GET` | `/v1/agents/{id}/runs/{runId}` | Get one run, including `result`. |
| `POST` | `/v1/agents/{id}/runs/{runId}/cancel` | Cancel a run. Terminal. Returns `{id}`. |
| `GET` | `/v1/agents/{id}/runs/{runId}/stream` | Stream the run (section 5.3). |

**`POST .../runs` body** is one of two shapes. Both use `additionalProperties: false`.

- Follow-up (`FollowupRunRequest`): `prompt` (required), `model`, `mcpServers`, `envVars`, `mode`. Returns `201` with `{run}`.
- Steer (`SteerRunRequest`): `prompt` and `delivery: "steer"` only. Any other field returns `400 validation_error`. Returns `202` with `delivery: "steered"` (plus `runId`) or `delivery: "queued"`.

A follow-up while a run is active returns `409 agent_busy`. A follow-up to a subagent returns `400`. A steer on an account without the feature returns `403 feature_unavailable`.

**Run object**

| Field | Notes |
|---|---|
| `id` | `run-<uuid>` |
| `agentId` | |
| `status` | `CREATING`, `RUNNING`, `WAITING_FOR_BACKGROUND_WORK`, `FINISHED`, `ERROR`, `CANCELLED`, `EXPIRED` |
| `createdAt`, `updatedAt` | ISO 8601 |
| `durationMs` | Integer, 0 or more |
| `result` | Final message text. The list endpoint omits it; the single-run endpoint returns it **[observed]**. |
| `git.branches[]` | `{repoUrl, branch, prUrl}`. Belongs to the agent, not the run. |

**`GET .../runs` query**: `limit` (1 to 100, default 20), `cursor`.

**Cancel**: `409 run_not_cancellable` if the run already ended.

### 5.3 Streaming

`GET /v1/agents/{id}/runs/{runId}/stream` returns server-sent events. Send `Accept: text/event-stream`.

- Resume with `Last-Event-ID`. An invalid id returns `400 invalid_last_event_id`.
- An expired stream returns `410 stream_expired`.

**Events**

| Event | Data |
|---|---|
| `status` | `runId`, `status` |
| `assistant` | `text` |
| `thinking` | `text` |
| `tool_call` | `callId`, `name`, `status` (`running` or `completed`), `args`, `result`, `truncated` (`{args, result}` booleans) |
| `interaction_update` | Not detailed |
| `heartbeat` | Keep-alive |
| `result` | `runId`, `status`, `text`, `durationMs`, `git` |
| `error` | `code`, `message` |
| `done` | End of run |

**[observed]** Event ids look like `<unix ms>-<n>`, so each event has a timestamp. The stream does not always close after `done`, so stop reading there. A stream was still there 15 hours after its run and returned `410` at 36 hours.

### 5.4 Usage

`GET /v1/agents/{id}/usage`, with optional `runId` (unknown id returns `404 run_not_found`).

**Response**

- `totalUsage`: `{inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, totalTokens}`
- `runs[]`: `{id, usageUuid, usage}`, where `usage` has the same token fields.

**[observed]** Each run's cost appears as `rawCostCents` (model cost) and `chargedCents` (billed, 0 inside the plan allowance). These fields are not in the published schema. `inputTokens` here excludes cache reads, unlike the Admin API.

**[observed]** Usage is reported in hourly buckets, so a partial hour can change later.

### 5.5 Artifacts

Artifacts are files an agent writes under `artifacts/`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/agents/{id}/artifacts` | List. Returns `{items: [{path, sizeBytes, updatedAt}]}`, max 100. |
| `GET` | `/v1/agents/{id}/artifacts/download?path=...` | Returns `{url, expiresAt}`. `url` is a presigned S3 link valid 15 minutes. `path` is required and must be under `artifacts/`. |

### 5.6 Environments

An environment defines how an agent's machine is built and started. Its `environmentJson` is a string.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/environments` | Create. Returns `201`. |
| `GET` | `/v1/environments` | List. |
| `GET` | `/v1/environments/{id}` | Get, including `environmentJson`, `buildSettings`, `repoFile`, `versionId`. |
| `PATCH` | `/v1/environments/{id}` | Update. Returns `204`. |
| `DELETE` | `/v1/environments/{id}` | Delete. Irreversible. |
| `GET` | `/v1/environments/{id}/history` | Config history. |
| `GET` | `/v1/environments/{id}/builds` | List builds. |
| `POST` | `/v1/environments/{id}/builds` | Start a build. Returns `202`. |
| `GET` | `/v1/environments/{id}/builds/{buildId}` | Get a build. |
| `GET` | `/v1/environments/{id}/builds/active` | Get the active build. |

**`POST /v1/environments` body**: `owner` (`personal` or `team`, required), `name` (1 to 255, required), `repos` (required, max 500, each `{url}`), `environmentJson` (string, required). Name conflicts return `409 environment_name_conflict`.

**`GET /v1/environments` query**: `query` (1 to 255 characters), `owner`, `named` (boolean), `repo` (repeatable, max 100), `userId`, `limit` (1 to 100, default 20), `cursor`.

**`PATCH` body** (at least one field, all optional): `name`, `environmentJson`, `repos` (requires `environmentJson`), `buildSettings` (send alone). Repo changes apply only to multi-repo environments. Blocked changes return `409 environment_repo_edit_blocked` or `repo_file_environment_locked`.

**Build settings**

| Field | Values |
|---|---|
| `pullLatestCode` | `when_stale`, `never`, `always` |
| `stalenessThresholdHours` | 0 to 8,760, nullable |
| `installTimeoutMinutes` | 5 to 300, nullable |

**Start a build** (`POST .../builds`): optional body `{draft: boolean (default false), refs: [{repoUrl, ref}]}`. Returns `202` with `{id, environmentId}`. A build id has the form `bld-YYYYMMDD-<uuid>`. Returns `429 rate_limit_exceeded` when rate limited.

**Build object**

| Field | Values or notes |
|---|---|
| `status` | `IN_PROGRESS`, `SUCCEEDED`, `FAILED`, `CANCELLED`, `SKIPPED` |
| `trigger` | `RECURRING`, `CONFIG_CHANGE`, `MANUAL` |
| `source` | `SYSTEM`, `WEBSITE`, `API`, `AGENT` |
| `draft` | boolean |
| `requestedRefs`, `repoCommits` | `{repoUrl, ref}` and `{repoUrl, commitSha}` |
| `failure` | `{type: INSTALL_FAILED or TERMINAL_FAILURE, code}` |
| `snapshotState` | `ACTIVE`, `REAP_REQUESTED`, `DELETED` |
| `createdAt`, `updatedAt`, `completedAt` | ISO 8601 |

**[observed]** Failure codes seen: `install_failed`, `dockerfile_contents_not_enabled`. Inline Dockerfiles (`build.dockerfileContents`) are gated on this account. Cursor re-quotes `install` and `start` strings, so wrap commands in base64 (see `environments/sync.mjs`). A failed build never replaces the active one. Right after a build starts, `GET .../builds/{id}` can return an empty body or `404` for a few seconds **[observed]**.

**`environmentJson` network setting**: `egressAllowlist` replaces network access rather than adding to it **[observed]**. Leave it out unless you list every host a build needs.

### 5.7 Secrets

Secret values are never returned. Secret versions carry `id` (`secv_...`), `name`, `type`, `repos`, and `createdAt`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/secrets` | List by scope. Query: `scope` (`team`, `user`, `members`, `environment`), `environmentId`, `name`, `repo`, `limit` (1 to 100, default 100), `cursor`. Items include `owner`. |
| `GET` | `/v1/environments/{id}/secrets` | List an environment's secrets. `nextCursor` is always `null`. |
| `PUT` | `/v1/environments/{id}/secrets/{name}` | Set. `201` created, `200` changed. Query `id` optional for disambiguation. |
| `DELETE` | `/v1/environments/{id}/secrets/{name}` | Delete. Returns `{name}`. |
| `GET` | `/v1/team/secrets` | List team secrets. `limit` (1 to 100), `cursor`. |
| `PUT` | `/v1/team/secrets/{name}` | Set a team secret. |
| `DELETE` | `/v1/team/secrets/{name}` | Delete a team secret. |
| `PUT` | `/v1/me/secrets/{name}` | Set a personal secret. `403 personal_secrets_disabled` if the team turned them off. |
| `DELETE` | `/v1/me/secrets/{name}` | Delete a personal secret. |

**Set body**: `value` (1 to 4,096 bytes, required), `type` (`runtime_secret` or `environment_variable`, required), `repos` (max 100). Build secrets (`build_secret`) return `400 validation_error` on this route.

**Secret types**

- `runtime_secret`: redacted from agent output. Set this for keys.
- `environment_variable`: plain. Not redacted.
- `build_secret`: not set through the environment or team routes (`400`). Not available when hooks run **[observed]**.

**[observed]** Set environment secrets with `runtime_secret` for keys and `environment_variable` for config. Re-syncing an environment keeps its id.

### 5.8 Sub-tokens

`POST /v1/sub-tokens` mints a one-hour token that acts as a team member. Body: exactly one of `forUserEmail` (string) or `forUserId` (integer, 1 or more). Returns `accessToken`, `expiresAt`, `userId`, `teamId`. The token cannot mint tokens or refresh itself. Requires an agent-scoped team service account key **[docs]**.

### 5.9 Models

`GET /v1/models` returns `{items: [...]}`. Each item has:

- `id`: canonical model id, for example `grok-4.6`, `composer-2.5`, `claude-opus-5-5`
- `displayName`
- `aliases`: other names the server maps to this id. For example `composer-2.5` has `composer`, `composer-latest`, `composer-2-5`.
- `variants[]`: `{displayName, isDefault, description?, params: [{id, value}]}`. A variant is one combination of parameter values.
- `parameters[]` (OpenAPI spec): `{id, values[]}`. Listed in the spec **[docs]**; absent on the first item sampled **[live]**.

**[live]** Returned 47 models on 2026-10-31. Parameter names differ by model: `grok-4.6` uses `effort` and `fast`; `grok-4.7` uses `context`, `reasoning_effort`, and `fast`; `composer-2.5` uses `fast` only.

**[observed]** Use the canonical `id` in workflows. The server rewrites an alias (`composer`) to its canonical id, which shows up as a diff in Terraform. Most models default to a fast, high-effort variant, so set every parameter explicitly **[repo]** (`automations/workflows/*/main.tf`).

`GET /v0/models` returns `{models: [string]}`, the legacy list **[live]**.

### 5.10 Repositories

`GET /v1/repositories` returns `{items: [{url}]}`. It returned 64 repositories in one response with no `nextCursor` **[live]**.

### 5.11 Current user

`GET /v1/me` returns the key's owner **[live]**:

- `apiKeyName`, `userId`, `createdAt`, `userEmail`, `userFirstName`. The spec also lists `userLastName`.

Use it to check which account a key belongs to.

### 5.12 Workers and pools

**Not retrieved.** The docs say pool and worker endpoints keep the `private-workers` name, that pools stay registered after their last worker disconnects, and that there is a "List Pending Pool Requests" endpoint. The pages cut off before their paths and schemas. See section 15.

---

## 6. Cloud Agents API v0 (legacy)

The docs keep a v0 reference. Its paths below come from `repo` code, live GETs, and a third-party mirror of the v0 list. The POST and DELETE routes are **third-party only**, not checked against Cursor's own docs.

| Method | Path | Status |
|---|---|---|
| `GET` | `/v0/me` | **[live]** Returns `{apiKeyName, createdAt, userEmail}`. |
| `GET` | `/v0/models` | **[live]** Returns `{models: [string]}`. |
| `GET` | `/v0/repositories` | **[live]** Returns `{repositories: [{owner, name, repository}]}`. |
| `GET` | `/v0/agents` | **[live]** Returns `{agents, nextCursor}`. Items: `id`, `status`, `source`, `target`, `name`, `createdAt`, `linesAdded`, `linesRemoved`, `filesChanged`. |
| `GET` | `/v0/agents/{id}` | **[repo]** `enrich.mjs` reads the agent. Shape not captured. |
| `GET` | `/v0/agents/{id}/conversation` | **[repo]** `export.mjs` reads `messages` from the response. **[observed]** Returns the prompt and the agent's messages; answered for runs a month old, works with a personal key. |
| `POST` | `/v0/agents` | Third-party only. |
| `DELETE` | `/v0/agents/{id}` | Third-party only. |
| `POST` | `/v0/agents/{id}/followup` | Third-party only. |
| `POST` | `/v0/agents/{id}/stop` | Third-party only. |

Prefer v1 for new work. v1 gives run state, streaming, usage, and per-run results. v0 gives conversation text.

---

## 7. Admin API

Base: `https://api.cursor.com`. Auth: Basic, team admin key. Bearer is not documented for this family **[docs]**. Scopes are listed where the docs give them.

**Pagination**: most list routes take `page` (1-indexed) and `pageSize`. Grok Bot list routes take `limit` and `cursor`.

**Error bodies**: `{"error": "..."}` on some legacy routes, `{"outcome": "error", "message": "..."}` on spend limits, and `{"code", "message"}` on model access and Grok Bot. Rate limits return `429` with `Retry-After: 60`.

### 7.1 Members and spend

| Method | Path | Request | Response |
|---|---|---|---|
| `GET` | `/teams/members` | none | `teamMembers[]`: `id` (`user_...`), `name`, `email`, `role`, `isRemoved` |
| `GET` | `/teams/audit-logs` | `startTime`, `endTime` (default 7 days ago and now), `eventTypes` (comma list), `search`, `page` (default 1), `pageSize` (1 to 500, default 100), `users` (emails or user ids). Max 30-day range. | `events[]` (oldest first): `event_id`, `timestamp`, `ip_address`, `user_email`, `event_type`, `application_type`, `event_data`; `pagination`, `params` |
| `POST` | `/teams/daily-usage-data` | `startDate`, `endDate` (epoch ms, required), `page`, `pageSize`. Max 30 days. Without both page fields, returns only active users. | `data[]` per user per day (lines, applies, accepts, tab, requests, `mostUsedModel`, `clientVersion`, and similar); `period`; `pagination` when paginated. Request counts are raw events, not billable units. |
| `POST` | `/teams/spend` | `searchTerm`, `sortBy` (`amount`, `date`, `user`; default `date`), `sortDirection` (`asc`, `desc`; default `desc`), `page`, `pageSize` | `teamMemberSpend[]`: `userId`, `name`, `email`, `role`, `spendCents`, `overallSpendCents`, `fastPremiumRequests`, `hardLimitOverrideDollars`, `monthlyLimitDollars`, `effectivePerUserLimitDollars`; `subscriptionCycleStart`, `totalMembers`, `totalPages` |
| `POST` | `/teams/filtered-usage-events` | `startDate`, `endDate` (epoch ms, inclusive), `userId`, `email`, `serviceAccountId`, `cloudAgentId` (`*` for all), `automationId` (`*` for all), `hostingType` (`CLOUD`, `SELF_HOSTED`, `SELF_HOSTED_POOL`, `SELF_HOSTED_MACHINE`; other values return `400`), `page` (default 1), `pageSize` (default 100, max 1,000). Filters combine with AND. | `usageEvents[]` (includes `chargedCents`, `requestsCosts`, `tokenUsage`, `cursorTokenFee`), `totalUsageEventsCount`, `pagination`, `period`. Sum `chargedCents` to reconcile with `/teams/spend`. |

**[observed]** `/teams/filtered-usage-events` returns `401 Invalid Team API Key` with a personal key, even when the dashboard shows Admin scope. The scope covers the user's own resources, not the team Admin API **[observed]**. This repo's `enrich.mjs` calls it with `automationId: "*"`.

### 7.2 Spend limits and membership (Enterprise)

| Method | Path | Request | Response |
|---|---|---|---|
| `POST` | `/teams/user-spend-limit` | `userEmail` (required), `spendLimitDollars` (integer, or `null` to clear; required) | `outcome`, `message` |
| `POST` | `/teams/user-spend-limits` (preview) | `updates[]` (1 to 100 items, each `userEmail`, `spendLimitDollars`) | `requestedCount`, `updatedCount`, `unchangedCount`, `failedCount`, `results[]` (`userEmail`, `status`: `updated`, `unchanged`, or `failed`, `error`). Invalid input, duplicates, or more than 100 updates return `400` and apply nothing. `403` if the team is not enabled. |
| `POST` | `/teams/remove-member` | exactly one of `userId` or `email` | `success`, `userId`, `hasBillingCycleUsage`. Cannot leave zero paid members or zero admins. |

### 7.3 Repo blocklists

| Method | Path | Request | Response |
|---|---|---|---|
| `GET` | `/settings/repo-blocklists/repos` | none | `repos[]`: `id`, `url`, `patterns` |
| `POST` | `/settings/repo-blocklists/repos/upsert` | `repos[]`: `url`, `patterns`. Replaces patterns for the repos given. | `repos[]` |
| `DELETE` | `/settings/repo-blocklists/repos/:repoId` | none | `204` |

### 7.4 Team directory groups (`team_group_...` ids)

Reads need `read:*`; writes need `admin:*`. `admin:*` covers both. Writes with `read:*` return `401`. SCIM-synced groups reject manual membership changes with `400`.

| Method | Path | Request | Response |
|---|---|---|---|
| `GET` | `/teams/directory-groups` | `page` (default 1), `pageSize` (default 50, max 200) | `groups[]`, `pagination` |
| `GET` | `/teams/directory-groups/:groupId` | `:groupId` as `id` or `grp_` `publicId` | `group` |
| `POST` | `/teams/directory-groups` | `name` (required, unique among active groups) | `201`, `group` |
| `PATCH` | `/teams/directory-groups/:groupId` | `name`; `monthlySpendingLimitDollars` (0 to 2,147,483,647); `clearMonthlySpendingLimitDollars` (boolean). At least one field. Do not set and clear the limit together. | `group` |
| `DELETE` | `/teams/directory-groups/:groupId` | Group must be empty with no SCIM mapping | `204` |
| `GET` | `/teams/directory-groups/:groupId/members` | `page`, `pageSize` (default 50, max 200) | `members[]` (`userId`, `name`, `email`, `joinedAt`), `pagination` |
| `POST` | `/teams/directory-groups/:groupId/members/bulk-add` | `userIds[]` (max 100, `user_` prefix) | `addedCount` |
| `POST` | `/teams/directory-groups/:groupId/members/bulk-remove` | `userIds[]` (max 100) | `removedCount` |

Writes take only the `team_group_...` id. Reads also accept `grp_`.

### 7.5 Billing groups (`group_...` ids)

| Method | Path | Request | Response |
|---|---|---|---|
| `GET` | `/teams/groups` | `billingCycle` (ISO date) | `groups[]`, `unassignedGroup`, `billingCycle` |
| `GET` | `/teams/groups/:groupId` | `billingCycle` | `group`: `currentMembers`, `formerMembers`, `dailySpend` |
| `POST` | `/teams/groups` | `name` (required), `type` (default `BILLING`) | `group` |
| `PATCH` | `/teams/groups/:groupId` | one of `name` or `directoryGroupId` (string or null) per request | `group` |
| `DELETE` | `/teams/groups/:groupId` | none. History moves to Unassigned. | `204` |
| `POST` | `/teams/groups/:groupId/members` | `userIds[]`. Users must be on the team and in no other group. | |
| `DELETE` | `/teams/groups/:groupId/members` | `userIds[]`. Members move to Unassigned. | |

SCIM-synced billing groups cannot change through the API.

### 7.6 Model access (preview)

Reads need `models:read`; writes need `models:*`. `admin:*` covers both. Provider and model routes return `409` unless the team's state is `custom`.

| Method | Path | Request | Response |
|---|---|---|---|
| `GET` | `/teams/model-access/configuration` | none | `teamId`, `state` (`unrestricted`, `custom`, or `legacy`), `newProviderDefault`, `newModelDefault` |
| `PUT` | `/teams/model-access/configuration` | either `state: "unrestricted"`, or `newProviderDefault` and `newModelDefault` (`enabled` or `disabled`) | Same as GET |
| `GET` | `/teams/model-access/providers` | none | `providers[]` with nested `models[]` and `parameters[]` |
| `PUT` | `/teams/model-access/providers/:provider` | `enabled` (required) | Provider |
| `GET` | `/teams/model-access/providers/:provider/models` | none | `models[]` with `parameters[]` |
| `PUT` | `/teams/model-access/providers/:provider/models/:model` | `enabled` (required); optional `parameters` map of `{allowedValues: string[] or null, defaultValue: string or null}` | `id`, `displayName`, `enabled`, `provider`, `parameters[]` |

Each parameter has `id`, `displayName`, `supportedValues`, `allowedValues`, `configuredDefaultValue`, and `catalogDefaultValue`. Unknown ids, empty `allowedValues`, or defaults outside `allowedValues` return `400`.

### 7.7 Grok Bot

Reads need `read:*` or `admin:*`. Writes need `admin:*`. Grok Bot routes share a 20/min per-endpoint limit.

| Method | Path | Request | Response / notes |
|---|---|---|---|
| `POST` | `/grok-bot/enable` | none | `204`. First enable on an eligible Enterprise team starts a trial. |
| `POST` | `/grok-bot/disable` | none | `204`. `403` on Teams plans. |
| `GET` | `/grok-bot/capabilities` | none | `enabled`, `cloudAgents`, `templateSharing` (`all`, `team_only`, `none`, or null), `actionRecording`, `localExecution` (`never`, `ask`, `always`, or null), `localEgressAllowed` |
| `PATCH` | `/grok-bot/capabilities` | any field except `enabled` (`400` if sent); at least one | capabilities |
| `GET` | `/grok-bot/auto-review` | none | `enforced`, `rules` (`allow[]`, `block[]`) |
| `PUT` | `/grok-bot/auto-review` | `enforced` (required), `rules` (each list up to 20 items, 1,000 characters each) | policy. Empty lists keep stored rules if the team cannot set them. |
| `GET` | `/grok-bot/access` | none | `mode` (`all` or `limited`), `groups[]` (`id`, `name`) |
| `PUT` | `/grok-bot/access` | `mode` (required); `groupIds` (1 to 100, required when `limited`, omitted for `all`) | access |
| `GET` | `/grok-bot/network` | none | `egressMode` (`unset`, `allow_all`, `default_with_network_settings`, `network_settings_only`), `allowlist[]`, `locked` |
| `PUT` | `/grok-bot/network` | `egressMode`, `allowlist` (up to 500 entries, 1 to 253 characters), `locked` (all required) | policy. `403` on Teams. |
| `GET` | `/grok-bot/team-rules` | `limit` (default 50, max 100), `cursor` | `teamRules[]`, `nextCursor` |
| `POST` | `/grok-bot/team-rules` | `name` (1 to 255), `content` (1 to 30,000), `enabled` (all required) | `201`, `teamRule`. Max 50 rules. |
| `PATCH` | `/grok-bot/team-rules/:id` | any of `name`, `content`, `enabled`; at least one | `teamRule`. `404` if missing. |
| `DELETE` | `/grok-bot/team-rules/:id` | none | `204` |
| `GET` | `/grok-bot/setup-manifests` | `limit` (default 50, max 100), `cursor` | `manifests[]`, `nextCursor` |
| `PUT` | `/grok-bot/setup-manifests/:manifestId` | `scripts[]` (each `id`, `setup`, optional `check`). Max 100 manifests. | `manifest`. `409` if changed mid-request. |
| `DELETE` | `/grok-bot/setup-manifests/:manifestId` | none | `204` |

---

## 8. Organization API

Base: `https://api.cursor.com`. Auth: Basic, organization key as the username, empty password. Team keys do not work here **[docs]**.

**Errors**: `{"code": "error", "message": "..."}`. The team-memberships sync `404` returns `{"error": "..."}`. Group routes return `429` with `Retry-After: 60`.

**Scopes**: `members:read`, `members:*`, `usage:*`, `models:read`, `models:*`, `auditlogs:read`, `admin:*`. `admin:*` covers every route. The docs also mention `read:*` in the model access section, but it is missing from the scope table.

### 8.1 Members

| Method | Path | Request | Response |
|---|---|---|---|
| `GET` | `/organizations/members` | `page` (default 1), `pageSize` (max 200), `teamId`, `userId` (numeric or `user_...`) | `members[]`: `id`, `email`, `name`, `organizationRole` (`admin` or `member`), `teams[]` (`teamId`, `teamRole`); `pagination` |
| `POST` | `/organizations/team-memberships/sync` | `organizationId` (required), `users[]` (1 to 500). Each user has `userId` and exactly one of `teamIds` (max 100, the full set to reconcile to) or `destinationTeamId`. | `results[]` (`userId`, `teamIds`, `destinationTeamId`, `status`, `errorMessage`), `successCount`, `errorCount`. Row failures return `200`. The target user must already be in the organization. |

### 8.2 Usage (hourly data, poll at most once an hour, 20/min)

| Method | Path | Request | Response |
|---|---|---|---|
| `POST` | `/organizations/pooled-usage` | `organizationId` | `pool` (`limitCents`, `usedCents`, `remainingCents`, `contractStartDate`, `contractEndDate`), `teams[]` (`teamId`, `usedCents`, optional `budgetLimitCents`). Money is in cents. |
| `POST` | `/organizations/filtered-usage-events` | `organizationId`, `teamIds`, `startDate` and `endDate` (epoch ms, inclusive), `userId`, `email`, `serviceAccountId`, `page` (default 1), `pageSize` (default 10) | `usageEvents[]` (each tagged with `teamId`, plus `chargedCents`, optional `cursorTokenFee`), `totalUsageEventsCount`, `pagination`, `period` |
| `POST` | `/organizations/daily-usage-data` | `organizationId`, `startDate` (default 7 days ago), `endDate` (default now), `teamIds` (max 100), `page`, `pageSize` (1 to 1,000, default 1,000), `userEmail` (one or comma-separated; `userEmails` also accepted). Max 30 days. | `data[]` per user per day (with `teamId`), `period`, `pagination` (`totalUsers`) |
| `POST` | `/organizations/spend` | `organizationId`, `teamIds` (max 100), `sortBy` (`email`, `name`, `spendCents`; default `email`), `sortDirection` (default `asc`), `page`, `pageSize` (1 to 1,000, default 100) | `teamMemberSpend[]` (`userId`, `teamId`, `name`, `email`, `role`, `spendCents`), `totalMembers`, `totalPages`, `period` |

### 8.3 Model access (preview)

Reads need `models:read`, writes need `models:*`. Limit 20/min. Writes log `team_settings` audit events. Routes return `409` while a team is `unrestricted` or `legacy`. Bulk routes return `200` even when some rows fail, and are not rolled back.

| Method | Path | Request | Response |
|---|---|---|---|
| `GET` | `/organizations/teams/model-access/configuration` | `page`, `pageSize`, `teamIds` (comma list) | `teams[]` (`teamId`, `teamName`, `state`, `newProviderDefault`, `newModelDefault`, or `errorMessage`), `pagination` |
| `GET` | `/organizations/teams/{teamId}/model-access/configuration` | | Team configuration |
| `PUT` | `/organizations/teams/{teamId}/model-access/configuration` | `state` (`unrestricted` clears), `newProviderDefault` and `newModelDefault` (`enabled` or `disabled`, required for custom policies) | |
| `PUT` | `/organizations/teams/model-access/configuration` | `teamIds` (required, max 100), plus `state`, `newProviderDefault`, `newModelDefault` | `results[]` (`teamId`, `status`, `errorMessage`), `successCount`, `errorCount` |
| `GET` | `/organizations/teams/{teamId}/model-access/providers` | | Providers and models, with `parameters` |
| `PUT` | `/organizations/teams/{teamId}/model-access/providers/{provider}` | `enabled` (required) | |
| `PUT` | `/organizations/teams/{teamId}/model-access/providers/{provider}/models/{model}` | `enabled` (required), `parameters` (optional map; `null` clears a restriction or restores the default) | |
| `PUT` | `/organizations/teams/model-access/providers/{provider}` | `enabled` (required), `teamIds` (required, max 100) | |
| `PUT` | `/organizations/teams/model-access/providers/{provider}/models/{model}` | `enabled` (required), `teamIds` (required, max 100), `parameters` (optional) | |

### 8.4 Audit logs

| Method | Path | Request | Response |
|---|---|---|---|
| `GET` | `/organizations/audit-logs` | `startTime` (default 7 days ago), `endTime` (default now), `eventTypes`, `search` (matches `user_email`, `event_type`, `event_id`; not `event_data`), `users` (up to 100), `teamId`, `page`, `pageSize` (1 to 500, default 100). Max 30 days. Oldest first. | `events[]` (`event_id`, `timestamp`, `team_id`, `ip_address`, `user_email`, `user_id`, `event_type`, `application_type`, `event_data`), `pagination`, `params` |

### 8.5 Organization groups

Needs `members:*`. Limit 20/min per organization. Group ids use `g_`. `publicId` uses `grp_`.

| Method | Path | Request | Response |
|---|---|---|---|
| `GET` | `/organizations/groups` | `page`, `pageSize` (default 50, max 200), `name` (exact match; no match returns empty) | `groups[]` (`id`, `publicId`, `name`, `memberCount`, `monthlySpendingLimitDollars`, `createdAt`, `updatedAt`), `pagination` |
| `GET` | `/organizations/groups/{groupId}` | | `group` |
| `POST` | `/organizations/groups` | `name` (required, unique, trimmed) | `201`, `group` |
| `PATCH` | `/organizations/groups/{groupId}` | `name`, `monthlySpendingLimitDollars` (0 to 2,147,483,647), `clearMonthlySpendingLimitDollars` (cannot combine with setting a limit) | `group` |
| `DELETE` | `/organizations/groups/{groupId}` | Group must be empty with no SCIM mapping | `204` |
| `GET` | `/organizations/groups/{groupId}/members` | `page`, `pageSize` (default 50, max 200) | `members[]` (`userId`, `name`, `email`, `joinedAt`), `pagination` |
| `POST` | `/organizations/groups/{groupId}/members/bulk-add` | `userIds` (`user_...`, max 100) | `addedCount` |
| `POST` | `/organizations/groups/{groupId}/members/bulk-remove` | `userIds` (max 100) | `removedCount` |

The Terraform provider resolves `group_name` through `GET /organizations/groups?name=...`, sent with Basic auth and the organization key **[repo]** (Terraform provider README).

### 8.6 Grok Bot computers

Needs `admin:*`. Team must be linked to the organization. One operation runs per team at a time.

| Method | Path | Request | Response |
|---|---|---|---|
| `POST` | `/organizations/teams/{teamId}/grok-bot/operations` | `action` (`recreate_vm`, `terminate_vm`, `delete_vm_and_data`, `delete_grok_bot_data`), `userIds` (1 to 25,000; max 1,000 for `delete_vm_and_data`, 100 for `delete_grok_bot_data`), `operationId` (UUID you generate, reuse to retry safely). Limit 20/min. | `202` with `operationId`. `409` with `code`, `message`, `runningOperationId` if one is running. |
| `GET` | `/organizations/teams/{teamId}/grok-bot/operations/{operationId}` | `limit` (1 to 1,000, default 100), `cursor`. Limit 120/min. | `operationId`, `action`, `state` (`running`, `succeeded`, `partially_succeeded`, `failed`), `counts`, `items[]` (`userId`, `state`, `reason`; `null` above 1,000 members), `itemsTruncated`, `nextCursor` |
| `GET` | `/organizations/teams/{teamId}/grok-bot/operations/latest` | Same as above | Running or most recent operation. `404` if none. |

---

## 9. Analytics API

Base: `https://api.cursor.com`. Enterprise only **[docs]**. All endpoints use `GET`. Auth: Basic. Most need `admin:*`; Bugbot review analytics need `read:*`.

**Shared query parameters**

| Parameter | Default | Notes |
|---|---|---|
| `startDate` | 7 days ago | `YYYY-MM-DD` (recommended), ISO 8601, `now`, `today`, `yesterday`, or `<n>d`. Time is ignored. |
| `endDate` | today | Same formats. |
| `users` | none | Comma list of emails or `user_` ids. |

Max range 30 days. With no dates, the range is the last 7 days.

**Response envelope**: team-level returns `{data, params}`, and `params.metric` names the metric. Paginated routes add `pagination` (`page`, `pageSize`, `totalUsers` or `totalItems`, `totalPages`, `hasNextPage`, `hasPreviousPage`).

**Caching**: ETag. Send the stored ETag as `If-None-Match`. The docs give no cache duration, despite a 900-second figure in the API overview.

**Errors**: `401` on `/analytics/team/conversation-insights` when the team disabled conversation insights. `429` with `{"error": "Too Many Requests", "message": "Rate limit exceeded. Please try again later."}`.

### 9.1 Team-level endpoints (`/analytics/team/{name}`)

| Path | Metric | Extra parameters | Item fields |
|---|---|---|---|
| `/agent-edits` | `agent-edits` | none | `event_date`, `total_suggested_diffs`, `total_accepted_diffs`, `total_rejected_diffs`, `total_green_lines_accepted`, `total_red_lines_accepted`, `total_green_lines_rejected`, `total_red_lines_rejected`, `total_green_lines_suggested`, `total_red_lines_suggested`, `total_lines_suggested`, `total_lines_accepted` |
| `/tabs` | `tabs` | none | `event_date`, `total_suggestions`, `total_accepts`, `total_rejects`, plus the same line fields as agent-edits |
| `/dau` | `dau` | none | `date`, `dau`, `cli_dau`, `cloud_agent_dau`, `bugbot_dau`. Active means at least one AI feature used. |
| `/client-versions` | `client-versions` | none | `event_date`, `client_version`, `user_count`, `percentage` (fraction). Uses each user's latest version per day. |
| `/models` | `models` | none | `date`, `model_breakdown` (keyed by model name, each with `messages`, `users`) |
| `/top-file-extensions` | `top-files` | none | `event_date`, `file_extension`, `total_files`, `total_accepts`, `total_rejects`, `total_lines_suggested`, `total_lines_accepted`, `total_lines_rejected`. Top 5 per day. |
| `/mcp` | `mcp` | none | `event_date`, `tool_name`, `mcp_server_name`, `usage` |
| `/commands` | `commands` | none | `event_date`, `command_name`, `usage` |
| `/plans` | `plans` | none | `event_date`, `model`, `usage`. `default` means Auto. |
| `/skills` | `skills` | none | `event_date`, `skill_name`, `usage` |
| `/ask-mode` | `ask-mode` | none | `event_date`, `model`, `usage` |
| `/leaderboard` | `leaderboard` | `page` (default 1), `pageSize` (default 10, max 500) | `tab_leaderboard` and `agent_leaderboard`, each `{data[], total_users}`. Fields include `email`, `user_id`, `total_accepts`, `total_lines_accepted`, `total_lines_suggested`, `line_acceptance_ratio`, `rank`. Default rank is combined lines accepted. |
| `/conversation-insights` | `conversation-insights` | `include` (required): `intents`, `complexity`, `categories`, `guidanceLevels`, `workTypes`. Repeat or comma-separate. | Only the requested slices, each with `distribution` and `timeSeries`. Aggregate only. Enterprise with insights enabled. |
| `/bugbot` | `bugbot` | `prState` (`merged` default or `all`), `repo`, `page`, `pageSize` (default 100, max 250) | `repo`, `pr_number`, `timestamp`, `reviews`, `issues{total, by_severity}`, `issues_resolved{total, by_severity}` |
| `/bugbot-reviews` | `bugbot-reviews` | `repo`, `prNumber`, `page`, `pageSize` (default 100, max 250), `dryRun` (`true` for dry runs only, `false` for posted only). `read:*`. | One item per completed review. See section 11. |

### 9.2 By-user endpoints (`/analytics/by-user/{metric}`)

Metrics: `agent-edits`, `tabs`, `models`, `top-file-extensions`, `client-versions`, `mcp`, `commands`, `plans`, `skills`, `ask-mode`. Same item fields as the team routes.

Extra parameters: `page` (default 1), `pageSize` (default 100, max 500), `users` (limits pagination to these users).

Response: `data` is an object keyed by user email, `pagination` (`page`, `pageSize`, `totalUsers`, `totalPages`, `hasNextPage`, `hasPreviousPage`), and `params` with `userMappings: [{id, email}]`.

Rate limit: 50/min per team.

---

## 10. AI Code Tracking API

Base: `https://api.cursor.com`. Enterprise only, **alpha**: response shapes may change **[docs]**. Auth: Basic. All endpoints use `GET`.

Metrics cover only the git repository at the workspace root. Multi-root workspaces are not supported.

**Common parameters**: `startDate` (ISO date, `now`, or relative days such as `7d`; default 7 days ago), `endDate` (default `now`), `page` (default 1), `pageSize` (default 100, max 1,000), `user` (email, `user_` id, or numeric id).

| Method | Path | Notes | Response |
|---|---|---|---|
| `GET` | `/analytics/ai-code/commits` | Per-commit line attribution. Paginated. | `items[]`, `totalCount`, `page`, `pageSize`. Each item: `commitHash`, `userId`, `userEmail`, `repoName`, `branchName`, `isPrimaryBranch`, `commitSource` (`ide`, `cli`, `cloud`), `totalLinesAdded`, `totalLinesDeleted`, `tabLinesAdded`, `tabLinesDeleted`, `composerLinesAdded`, `composerLinesDeleted`, `nonAiLinesAdded`, `nonAiLinesDeleted`, `message`, `commitTs`, `createdAt` |
| `GET` | `/analytics/ai-code/commits.csv` | Streamed in pages of 10,000. No `page` param. | CSV with the same fields in snake_case (`commit_hash`, `user_email`, `tab_lines_added`, ...) |
| `GET` | `/analytics/ai-code/changes` | Accepted AI changes, grouped by a deterministic `changeId`. Paginated. | `items[]`: `changeId`, `userId`, `userEmail`, `source` (`TAB` or `COMPOSER`), `model`, `totalLinesAdded`, `totalLinesDeleted`, `createdAt`, `metadata[]` (`fileName` may be omitted in privacy mode, `fileExtension`, `linesAdded`, `linesDeleted`) |
| `GET` | `/analytics/ai-code/changes.csv` | Streamed. No `page` param. | CSV; `metadata_json` holds the metadata array as a string |
| `GET` | `/analytics/ai-code/commits/:commitHash` | Alpha, select users. `commitHash` can be a comma list. Optional `branch`. | `commits[]` (`commitHash`, `commitSource`, `rangeAnnotations[]` with `filePath` and `groups[]`); `conversations[]` (`id`, `title`, `tldr`, `overview`, `summaryBullets`) |

Notes from the docs:

- `group` fields in commit details: `conversationId`, `model`, `operationType`, `ranges[]` (`start`, `end`).
- Commit hashes are not guaranteed unique. Amended commits can appear twice. `commitTs` stays the same after an amend; `createdAt` is ingestion time.
- TAB means accepted inline completions. COMPOSER means accepted diffs from agent edits.
- Privacy mode can drop fields such as `fileName`.

The docs say nothing on error bodies, caching, or rate limits for these routes.

---

## 11. Bugbot API

Base: `https://api.cursor.com`. Enterprise **[docs]**. Auth: Basic.

### 11.1 Trigger a review

`POST /bugbot/review`. Scope `admin:*`. Limit 30/min per team, plus 10/min for dry runs.

| Field | Type | Required | Notes |
|---|---|---|---|
| `prUrl` | string | yes | GitHub pull request or GitLab merge request URL |
| `dryRun` | boolean | no | `true` runs the analysis and stores findings without posting. Default `false`. Dry runs are billed. |

**Response**: `outcome` (`"success"` when queued), `message` (`"Bugbot review queued"` or `"Bugbot dry-run review queued"`), `request_id` (save it to find the review later), `dry_run`.

**Errors**: `400` with `{"outcome": "error", "message": "..."}`, for example when Bugbot is disabled for the repo.

### 11.2 Review analytics

`GET /analytics/team/bugbot-reviews`. Scope `read:*`. Returns posted and dry-run reviews.

| Query | Default | Notes |
|---|---|---|
| `startDate`, `endDate` | 7 days ago, now | Analytics date formats |
| `repo` | none | `host/owner/repo`. Protocol and `.git` optional. |
| `prNumber` | none | |
| `page` | 1 | |
| `pageSize` | 100 | Max 250 |
| `dryRun` | none | `true` dry runs only, `false` posted only |

**Response**: `data[]`, `pagination`, `params`.

Each `data` item: `request_id`, `timestamp`, `repo`, `repo_node_id` (nullable), `pr_number` (nullable), `commit_sha` (nullable), `bugs_found`, `cost_cents` (nullable, null when not billed separately), `dry_run`, `publication_status` (`posted` or `dry_run`), `bugs[]`.

Each `bugs` item: `comment_id` and `resolution_status` (null on dry runs), `severity` (nullable). Dry runs also return `title`, `description`, and `locations[]` (`file`, `start_line`, `end_line`).

**Flow**: trigger, save `request_id`, then poll analytics with `repo` and `prNumber` until the item appears. Results can lag.

---

## 12. Origin API

Origin hosts repositories. Auth is Bearer with Origin tokens, not Cursor API keys **[docs]**.

### Base URLs

- REST: `https://api.cursor.com/v1/origin`
- Git over HTTPS: `https://origin.cursor.com/{owner}/{repo}.git`. The legacy `/git/` path also works for clone.

### Credentials

| Credential | Format | How | Used for |
|---|---|---|---|
| App JWT | EdDSA JWT | Signed locally with an Ed25519 key registered in app settings. `kid` and `iss` are the app id, `aud` is `origin-apps`, lifetime about 5 minutes. | App operations, installation tokens, webhook recovery |
| Installation token | `oit_...` | `POST /app/installations/{installationId}/access_tokens` with an app JWT. Expires at most 15 minutes, never after the JWT. | Repo calls, pull requests, check runs, Git |
| User access token | short-lived | Exchanged from a personal key by the Origin CLI (`origin auth login` or `CURSOR_API_KEY`) | `origin api` |

Installation tokens can narrow with `scopes` and `repositoryIds`. Empty or omitted arrays inherit the full grant. Uninstalling the app invalidates the token early.

### Endpoints documented

| Method | Path | Auth | Response |
|---|---|---|---|
| `GET` | `/v1/origin/repos/{owner}/{repo}` | Bearer | Repo, including `cloneUrl`, `defaultBranch`, `visibility` |
| `POST` | `/app/installations/{installationId}/access_tokens` | App JWT | `expiresAt` and the token |
| `GET` | `/v1/origin/.well-known/openid-configuration` | none | `issuer`, `jwks_uri`, `id_token_signing_alg_values_supported` (`EdDSA`) |
| `GET` | `/v1/origin/keys` | none | Active Ed25519 JWKs. `Cache-Control: public, max-age=600, stale-if-error=600`. |

Referenced but not detailed in the docs I could reach: create repo, list installation repositories (returns `cloneUrl`), the scopes reference (`repository:contents:read`, `repository:contents:write`), installation receipts, mirrored repos, and user-token acting.

The Terraform provider reads repos with `GET /v1/origin/repos/{owner}/{name}`, and manages rulesets and grants with the same token **[repo]** (Terraform provider README). The README says the public Origin API can create and read repositories but has no update or delete.

### Git over HTTPS

- Clone, fetch, pull: need `repository:contents:read`.
- Push: needs `repository:contents:write` and an eligible owner plan, else `403`. Mirrored repos reject pushes with `403`.
- Auth: HTTP Basic, username `x-access-token`, password the installation token. Bearer is rejected.

### Errors

- `401`: token revoked by uninstalling or deleting the app. Do not retry with the same token.
- `403`: push to an ineligible owner or to a mirror.
- `429`: budget exhausted. Headers `Retry-After`, `X-RateLimit-Reset`.

Webhook signatures carry no key id. Try each active key, cache JWKS for 10 minutes, and refresh when no key verifies (keys rotate weekly).

---

## 13. Automations (private interface)

Cursor's **Automations** (`cursor_platform_workflow`) have no public REST reference. The Terraform provider talks to them over **Connect RPC** at `CURSOR_ENDPOINT` (default `https://api2.cursor.sh`) **[repo]**. This section is what the provider and this repo show. It is not a documented API, and nothing here probes it.

Resource fields used in this repo's workflows **[repo]** (`automations/workflows/*/main.tf`):

| Field | Notes |
|---|---|
| `name`, `description`, `prompt` | |
| `environment_public_id` | Environment to run in. `null` uses the repo default. |
| `model_selection` | `model_id`, `max_mode` (must be `true`), `parameters[]` (`{id, value}`) |
| `trigger` | `git_pull_request` with `repos`, `pr_action` (`commented`), `comment_contains` (`!review` or `!fix`), `ignore_draft_prs`. Also `user_allowlist` (`null` means anyone). |
| `action` | `pr_comment` with `allow_inline_comments` |

Trigger types in the provider: `git_pull_request`, `git_push`, `git_ci_completed`, `cron`, `slack`, `linear`, `webhook`, `microsoft_teams`, `microsoft_teams_channel_created`.

Action types: `pr_comment`, `git_pr`, `request_reviewers`, `mcp`, `slack`, `read_slack`, `microsoft_teams`, `read_microsoft_teams`.

Provider behaviour **[repo]**: an empty `user_allowlist` comes back as `null`, so use `null` for "anyone". `max_mode` is always reported as `true`. Leaving it unset fails the apply, and setting it to `false` fails the plan.

Cursor's Connect RPC contract is not documented here. Use the provider source to change it.

---

## 14. Behaviour that is not in the docs

These come from this project's runs and are recorded in `AGENTS.md` in more detail.

- **Traces without tokens or prompts.** Cloud runs send `stop` without token fields. `beforeSubmitPrompt`, `afterAgentResponse`, and `afterAgentThought` never fire in cloud runs, even though hooks docs list them **[observed, 2026-10-30]**. Get the prompt and messages from `GET /v0/agents/{id}/conversation`, and tokens and cost from `GET /v1/agents/{id}/usage`.
- **Machine at `stop`.** Each run gets a new machine. No transcript file exists on disk. A process started from a hook with `setsid` keeps running after `stop` **[observed]**.
- **Local CLI differs.** `agent -p` fires `sessionStart`, `sessionEnd`, and `afterAgentThought`, not `stop`. Its run ids are not `bc-` ids and the v1 API cannot look them up **[observed]**.
- **Run ids for automations.** `GET /v1/agents` and its `prUrl` filter do not list automation runs. Get run ids from the traces, or from the `RUN_ID:` line in the `cursor[bot]` PR review **[observed]**.
- **No completion webhook.** Cursor offers no completion webhook for automations **[observed]**.
- **Hourly usage.** Usage events are aggregated per hour, so a run's cost can change within the hour **[observed]**.
- **Models.** Canonical ids only. Aliases are rewritten by the server **[observed]**.
- **Team keys on personal resources.** Creating team environments needs a key on a Cursor team. A personal key gets `400` for owner `team` **[observed]**. Service accounts are Enterprise only. Cursor has no transfer for personal resources **[observed]**.
- **Service accounts need the team-level GitHub app.** Both GitHub owners need the app installed **[observed]**.
- **Bursts return 429** on v1 reads **[observed]**.

---

## 15. Gaps

Items I could not verify, and how to close each one.

| Gap | Why | How to close |
|---|---|---|
| Workers and pools endpoints (pool requests, workers, machines) | The published endpoints page cut off after "Worker Tokens" in both fetches | Read `https://cursor.com/docs/cloud-agent/api/endpoints` in a browser, or the OpenAPI at `/docs-static/cloud-agents-openapi.yaml` past the `POST /v1/environments` 409 response |
| OpenAPI tail | Summarized fetch stopped at about 100,000 characters of 146,000 | Read the file directly |
| v0 POST, DELETE, and `/v0/agents/{id}` shapes | Only a third-party mirror lists them | Read the legacy v0 reference or test with a throwaway agent |
| Organization API key scopes beyond the table | The docs mention `read:*` without listing it | Confirm with a read call |
| Origin endpoint reference | The docs pages linked from the auth page returned 404 to fetch | Use the Origin docs index at `https://cursor.com/docs/api/origin/llms.txt` in a browser |
| Analytics `conversation-insights` rate limit | The API overview says 20/min; the analytics page says 100/min team-level | Test against the endpoint |
| Usage response cost fields (`rawCostCents`, `chargedCents`) | Seen in responses but absent from the published schema | Confirm with Cursor before relying on them |

Live checks in this document are read-only GETs with this repo's personal key. Nothing was created, changed, or deleted.
