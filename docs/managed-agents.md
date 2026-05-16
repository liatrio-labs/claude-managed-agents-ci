# How this pipeline maps to Claude Managed Agents

[Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) is Anthropic's managed harness for running Claude as an autonomous agent. This pipeline is built around its primitives — every concept in the docs has a corresponding artifact in the repo.

All API calls use the beta header **`anthropic-beta: managed-agents-2026-04-01`** (set by `scripts/lib/managed-agents-api.ts`).

> **Workspace scoping note:** every agent / environment / session / vault you create lives in the [Anthropic Workspace](workspaces.md) of the credential that created it. There is no `workspace_id` parameter on `POST /v1/agents` — it is implicit in the credential. Make sure the WIF federation rule your CI job uses targets the workspace you actually want to ship to. See [docs/workspaces.md](workspaces.md) for the full story.

## Concept ↔ repo artifact

| Anthropic primitive                                                                                                  | Where it lives in this repo                                                                                                                                                       | What manages it                                                                                          |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Agent** — versioned config of `name`, `model`, `system`, `tools`, `mcp_servers`, `skills`, `metadata`              | `agents/<id>/agent.yaml` (whole file; the `agent` block holds the API-shape fields, with the system prompt either inline at `agent.system` or referenced via `agent.system_path`) | `scripts/deploy.ts` syncs to `POST /v1/agents` (create) or `POST /v1/agents/{id}` (update → new version) |
| **Environment** — cloud container template with `packages` + `networking`                                            | `agents/<id>/agent.yaml` (block: `environment`)                                                                                                                                   | `scripts/deploy.ts` syncs to `POST /v1/environments`                                                     |
| **Session** — running agent instance referencing an agent + environment                                              | `scripts/run-evals.ts` and `scripts/prompt-injection-test.ts` with `--mode=session`                                                                                               | `POST /v1/sessions` + `POST /v1/sessions/{id}/events`                                                    |
| **Events** — `user.message`, `user.interrupt`, plus emitted `assistant.message`, `tool.use`, `tool.result`, `status` | Session-mode evals and red-team runs                                                                                                                                              | `scripts/lib/managed-agents-api.ts` (`sessions.events.send/list`, `extractAssistantText`)                |
| **Vaults** — per-end-user MCP OAuth credentials managed by Anthropic (token refresh handled for you)                 | Documented in `docs/vaults.md` (operator-managed, not committed)                                                                                                                  | Out-of-band setup via `POST /v1/vaults` and `POST /v1/vaults/{id}/credentials`                           |
| **Beta header**                                                                                                      | `MANAGED_AGENTS_BETA` constant, applied automatically                                                                                                                             | `scripts/lib/managed-agents-api.ts`                                                                      |

## What gets deployed and when

`scripts/deploy.ts`:

1. Reads `agents/<id>/agent.yaml`.
2. **Environment:** if `platform.<DEPLOY_ENV>.managed_environment_id` is unset, calls `POST /v1/environments` with the `environment` block; the returned id is written back to the config. Environments are not versioned — to roll a config change, change the environment `name` (must be unique) so a fresh one is created.
3. **Agent:**
   - If `platform.<DEPLOY_ENV>.managed_agent_id` is unset, `POST /v1/agents` with `name`, `model`, `system` (inline from `agent.system` or loaded from `agent.system_path`), `tools`, `mcp_servers`, `skills`, plus `metadata` enriched with three keys prefixed by `PIPELINE_METADATA_PREFIX` (default `pipeline.`): `…deploy_env`, `…git_sha`, `…repo_id`. Override the prefix per-org without code changes.
   - Otherwise, `GET /v1/agents/{id}` to read the live `version`, then `POST /v1/agents/{id}` with that version + the desired fields. The API auto-bumps the version, or returns the same version unchanged when nothing diffs (the docs call this "no-op detection").
4. Writes the new `id` and `version` back to `platform.<DEPLOY_ENV>.managed_agent_id` / `platform.<DEPLOY_ENV>.managed_agent_version`. The staging job commits this back to the branch automatically. Each deploy environment (staging, production, …) has its own block because each uses a different Anthropic Workspace and resources don't cross workspace boundaries — see [docs/workspaces.md](workspaces.md). YAML comments are preserved across writes (the loader uses Document-aware editing, not full re-serialization).

## Sessions — used at eval time, not deploy time

There is no "deploy" of a session — sessions are the runtime. The pipeline uses sessions for **post-deploy verification** (`agents:evals --mode=session` and `agents:injection-test --mode=session`):

1. `POST /v1/sessions` with the agent ID **pinned to `managed_agent_version`** (so you're testing the version you just shipped, not whatever's latest):
   ```json
   { "agent": { "type": "agent", "id": "agt_…", "version": 7 }, "environment_id": "env_…" }
   ```
2. `POST /v1/sessions/{id}/events` with `{ "type": "user.message", "content": [{ "type": "text", "text": "<case input>" }] }`.
3. Poll `GET /v1/sessions/{id}` until status is `idle` or `terminated`.
4. `GET /v1/sessions/{id}/events`, scan for `assistant.message`, hand the text to the judge.
5. `DELETE /v1/sessions/{id}` to clean up.

PR-time evals use `--mode=messages` (the simple Messages API with the agent's `system` and `model`) because session creation has real provisioning cost and tools the PR doesn't always need to exercise.

## Rollback semantics

Anthropic's agent versions are append-only — there is no delete or reset. Rollback in this pipeline means:

```
GET  /v1/agents/{id}/versions/{N}        # read snapshot of target version
POST /v1/agents/{id}                     # re-apply with that snapshot's fields
                                         # → produces version M (where M > current),
                                         #   whose contents mirror N
```

Trigger via `workflow_dispatch` on `deploy.yaml` with `rollback_to_version: <N>` (or `previous` to take current − 1). The auto-rollback job in `deploy.yaml` uses `previous` after a failed production verification.

## Vaults vs infra secrets — two different things

This is the single most confusing point in the system, so it's called out explicitly:

|                          | Anthropic **Vaults**                                                                                | Pipeline credentials                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **What's stored**        | OAuth credentials for MCP servers, scoped per end-user                                              | The short-lived `ANTHROPIC_AUTH_TOKEN` that lets CI call the Anthropic API                                            |
| **Who manages it**       | Anthropic (token refresh, expiry, etc.)                                                             | GitHub OIDC + Anthropic Workload Identity Federation (no static key in the repo)                                      |
| **API**                  | `POST /v1/vaults`, `POST /v1/vaults/{id}/credentials`, referenced via `vault_ids` on session create | `POST /v1/oauth/token` (jwt-bearer exchange), invoked at job start by `.github/actions/claude-managed-agents-pipeline` |
| **When it's minted**     | Once per end-user, when they OAuth-connect a third-party MCP                                        | Every CI job that calls Claude — tokens expire within minutes                                                         |
| **Pipeline touches it?** | Documented in `docs/vaults.md`; pipeline can pass `vault_ids` to sessions if needed                 | Yes — the composite action exchanges the GitHub OIDC token for `ANTHROPIC_AUTH_TOKEN` at job start                    |

## Tool shapes

`tools[]` accepts API objects, not strings. The example agent uses the pre-built toolset:

```json
{ "type": "agent_toolset_20260401" }
```

To grant only specific built-ins, list them as `{ "type": "bash" }`, `{ "type": "web_search" }`, etc. MCP tools live under `mcp_servers[]`. Custom tools follow the standard tool-use schema. See [Tools](https://platform.claude.com/docs/en/managed-agents/tools).

## Networking

The example uses `networking.type: "limited"` with an explicit `allowed_hosts` list. The docs recommend this for production and the static prompt linter doesn't enforce it, but you should — `unrestricted` is fine for prototyping but is an unbounded data-egress surface in production.

## Things this pipeline doesn't try to do (yet)

- **Streaming events** — `extractAssistantText` reads completed events after the session goes idle. For interactive UIs, use the SSE stream documented in [Events and streaming](https://platform.claude.com/docs/en/managed-agents/events-and-streaming).
- **Tool confirmations** — the default permission policy is `always_allow`. Production agents that touch real systems should swap to a confirm-on-use policy and the eval harness would need to auto-approve or reject confirmations.
- **Multi-agent / `callable_agents`** — research preview only; the schema accepts the field but the pipeline doesn't exercise it.
- **Outcomes** — research preview; left to the operator to wire in.
