# Workspaces — where your agents live

> Validated against the Anthropic Admin API docs at [platform.claude.com](https://platform.claude.com/docs/en/api/admin-api/workspaces) (2026 spec). Field names below are quoted from the documented schemas.

A **Workspace** at [platform.claude.com](https://platform.claude.com) is a unit of resource scoping inside your Anthropic organization. Every credential is scoped to exactly one workspace; every Managed Agent, Environment, Session, and Vault you create lives in the workspace of the token that created it. This is the single most important fact for operating this pipeline correctly: **the WIF token your CI job mints determines which workspace receives the agent.**

If you're running this pipeline against more than one environment (staging vs production, or per-team workspaces), you need a separate workspace per environment, with a separate Workload Identity Federation rule per workspace, wired to the right GitHub Environment via env-scoped `vars.ANTHROPIC_FEDERATION_RULE_ID` and `vars.ANTHROPIC_WORKSPACE_ID`. See [docs/credentials.md](credentials.md).

## The objects

Three objects matter:

### Workspace

An isolated container for resources. Documented at `POST /v1/organizations/workspaces` (admin endpoint).

| Field                                   | Meaning                                                                                        |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `id`                                    | Workspace ID (e.g. `wrkspc_…`).                                                                |
| `name`                                  | Display name.                                                                                  |
| `display_color`                         | Hex color used in the Anthropic Console.                                                       |
| `data_residency.workspace_geo`          | Geographic region for stored workspace data. **Immutable after creation.** Defaults to `"us"`. |
| `data_residency.allowed_inference_geos` | List of geos requests are allowed to run in (or `"unrestricted"`).                             |
| `data_residency.default_inference_geo`  | Geo applied when a request omits it. Defaults to `"global"`.                                   |
| `archived_at`                           | RFC 3339 timestamp or `null`. Archived workspaces are read-only.                               |
| `created_at`                            | RFC 3339 timestamp.                                                                            |
| `type`                                  | Always `"workspace"`.                                                                          |

Every Anthropic organization has a **default workspace**. You can create more — e.g. one per environment or per team — via the console UI or the admin API. Workspace `name` does not have to be unique across the org but should be for sanity.

### API Key (`type: "api_key"`)

The credential the pipeline uses to talk to the Messages API and the Managed Agents API. Documented at `GET /v1/organizations/api_keys` (admin endpoint).

| Field              | Meaning                                                                            |
| ------------------ | ---------------------------------------------------------------------------------- |
| `id`               | API key ID (e.g. `apikey_…`).                                                      |
| `name`             | Human-readable label.                                                              |
| `partial_key_hint` | Redacted preview (e.g. `sk-ant-a…123`).                                            |
| `status`           | `"active"`, `"inactive"`, `"archived"`, or `"expired"`.                            |
| `expires_at`       | RFC 3339 timestamp or `null` for non-expiring.                                     |
| `created_by`       | Actor (`{ id, type }`) that minted the key.                                        |
| `workspace_id`     | **The workspace this key is scoped to.** `null` means the org's default workspace. |

The key's workspace is fixed at creation. You cannot move a key between workspaces — mint a new one in the target workspace and rotate.

### Workspace Member

People (or service identities) who can act inside a workspace. Documented at `GET /v1/organizations/workspaces/{workspace_id}/members`.

Five roles are defined verbatim in the API spec:

| Role                             | Typical use                                                               |
| -------------------------------- | ------------------------------------------------------------------------- |
| `workspace_user`                 | Read-only access for non-builders.                                        |
| `workspace_developer`            | Build and operate agents/sessions inside the workspace.                   |
| `workspace_restricted_developer` | Build but with reduced surface (e.g. limited spend, fewer admin actions). |
| `workspace_admin`                | Manage members and workspace settings.                                    |
| `workspace_billing`              | View and manage spend/usage.                                              |

The exact action matrix per role is the platform's call — confirm the current behavior in the console before relying on a specific permission.

## How this maps to the pipeline

Two things this pipeline cares about:

1. **Where agents are created.** When `scripts/deploy.ts` runs `POST /v1/agents` or `POST /v1/environments`, those resources land in the workspace targeted by the WIF token. So:

   ```
   GitHub Environment "staging"  → ANTHROPIC_FEDERATION_RULE_ID (staging rule) → Staging Workspace
                                 → deploy.ts creates agent in:                   Staging Workspace
   GitHub Environment "production" → ANTHROPIC_FEDERATION_RULE_ID (prod rule)  → Production Workspace
                                   → deploy.ts creates agent in:                  Production Workspace
   ```

2. **Where eval traffic goes.** `scripts/run-evals.ts --mode=session` and `scripts/prompt-injection-test.ts --mode=session` create sessions against `platform.managed_agent_id`. That ID is opaque, but the token used must be scoped to **the same workspace as that agent**, otherwise the call will fail. The pipeline writes the agent ID back to `agent.yaml` after deploy — anyone running session-mode evals against that ID needs a token for the matching workspace.

The composite [`claude-managed-agents-pipeline` action](../.github/actions/claude-managed-agents-pipeline/action.yaml) doesn't _enforce_ this — it exchanges the GitHub OIDC token for whatever workspace the env-scoped `ANTHROPIC_FEDERATION_RULE_ID` points at. You're responsible for wiring the right rule to the right GitHub Environment.

## Recommended layout

For a real production setup we recommend three workspaces per project:

| Workspace           | Purpose                                                            | Who has access                        |
| ------------------- | ------------------------------------------------------------------ | ------------------------------------- |
| `<project>-dev`     | Engineers iterate freely, no SLA, low spend cap.                   | Developers, on-call.                  |
| `<project>-staging` | CI deploys land here on `main`; session-mode smoke evals run here. | CI, platform team.                    |
| `<project>-prod`    | Real user traffic. Required-reviewer environment in GitHub.        | CI (with approval), on-call, billing. |

Create **one Workload Identity Federation rule per workspace** (`gha-staging`, `gha-prod`, etc.) targeting a shared service account, and wire each rule to the matching GitHub Environment via env-scoped `vars.ANTHROPIC_FEDERATION_RULE_ID` and `vars.ANTHROPIC_WORKSPACE_ID`. Because the deploy workflow binds to a GitHub Environment (`environment: ${{ github.event.inputs.environment || 'staging' }}` in `deploy.yaml`), those vars resolve per-environment automatically — staging runs mint a token for the staging workspace, production runs mint a token for the production workspace.

## Two kinds of API keys

|                            | WIF access token                                                                                                       | Admin API key                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Header**                 | `Authorization: Bearer sk-ant-oat01-…`                                                                                 | `X-Api-Key: $ANTHROPIC_ADMIN_API_KEY`                                   |
| **Used for**               | Messages API, Managed Agents API (`/v1/agents`, `/v1/sessions`, `/v1/environments`, `/v1/vaults`)                      | Admin API (`/v1/organizations/...`) — workspace, member, key management |
| **Scope**                  | One workspace; expires within minutes                                                                                  | Org-wide                                                                |
| **Used by this pipeline?** | Yes — every `claude-managed-agents-pipeline` job mints one via Workload Identity Federation as `ANTHROPIC_AUTH_TOKEN`  | No (this pipeline does not auto-create workspaces or members)           |

This pipeline does **not** require an admin key. If you want to script workspace and member creation, that's a separate one-time chore against the admin API; we recommend doing it in Terraform / OpenTofu rather than in CI so the org-level state has a clear reviewer.

## Data residency

Set when you create the workspace and **immutable** afterwards. If you operate under regional data-handling rules (EU GDPR, certain enterprise contracts), set `workspace_geo` and `allowed_inference_geos` at creation time. You can't change them later — you'd have to recreate the workspace and re-provision agents inside it.

## Spend & rate limits

Spend caps and tier-based rate limits are enforced **per organization** (per the [Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview)). Spend can also be capped per-workspace via the Anthropic console. Two practical implications:

- A runaway eval loop in your dev workspace will eat from the same org-level spend cap as production. Set per-workspace limits to contain blast radius.
- The Managed Agents endpoints carry their own per-org limits: 300 rpm on creates (agents/sessions/environments/vaults), 600 rpm on reads. Multiple workspaces share these.

## Console vs. API

You can do almost everything in either place:

- **Console** (`platform.claude.com` → Settings → Workspaces) — easiest for one-off setup. Create the workspace, mint a key, add members.
- **Admin API** — required for automation. Documented under `/v1/organizations/workspaces`, `/v1/organizations/workspaces/{id}/members`, `/v1/organizations/api_keys`. Needs an admin API key.

For the initial setup of this pipeline, console clicks are fine. If you're managing more than ~3 workspaces, script it.

## What this pipeline does NOT do

- It does not create or delete workspaces.
- It does not create or delete API keys.
- It does not manage workspace membership.
- It does not move existing agents between workspaces (not currently possible — re-create them in the target workspace).

All of the above are intentional: they're org-level state changes that should pass through your normal change-management process, not happen as a side effect of a CI run.

## Sanity checklist when something looks off

- ❓ "Deploy succeeded but I don't see the agent in the console." → You're looking at the wrong workspace. Check the console's workspace switcher; cross-reference the API key's `workspace_id`.
- ❓ "Session-mode eval fails with 404 on the agent ID." → The CI job is using a token scoped to a different workspace than the one the agent lives in. Re-check `vars.ANTHROPIC_FEDERATION_RULE_ID` and `vars.ANTHROPIC_WORKSPACE_ID` on that GitHub Environment.
- ❓ "PRs land agents in the wrong workspace." → A workflow is missing the env-scoped `ANTHROPIC_FEDERATION_RULE_ID` / `ANTHROPIC_WORKSPACE_ID` override, or both environments share the same rule. Make sure `staging` and `production` GitHub Environments each have their own values.
- ❓ "Quota error after a noisy day." → Rate / spend limits are org-wide. Check the console for org-level usage; consider per-workspace caps.
