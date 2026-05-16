# Anthropic Vaults — per-end-user MCP OAuth credentials

> **Heads up:** "Vaults" in the Claude Managed Agents API is **not** the same as the infra secret vault that holds your `ANTHROPIC_API_KEY`. See [docs/credentials.md](credentials.md) for the latter. This doc covers Anthropic-managed Vaults, used at session runtime.

[Vaults](https://platform.claude.com/docs/en/managed-agents/vaults) store OAuth credentials for MCP servers your agent connects to, on behalf of one of your end-users. Anthropic refreshes the access token for you. You reference vaults at session creation via `vault_ids: [...]`.

A vault holds one or more **credentials**. Each credential is bound to exactly one `mcp_server_url`. Two credential types:

- `mcp_oauth` — full OAuth 2.0 with refresh; pass `access_token`, `expires_at`, and a `refresh` block (token endpoint, client id/secret, refresh token).
- `static_bearer` — a fixed bearer token (API key, PAT) — no refresh.

## When you'd add this to the pipeline

You typically create a vault **per end-user**, when they OAuth-connect a third-party app from your product. That happens outside CI — usually a webhook or an OAuth callback in your product. Pipeline involvement:

1. Your product backend creates the vault with `POST /v1/vaults` and a credential with `POST /v1/vaults/{id}/credentials`.
2. When you start a session for that user, your runtime code passes `vault_ids: [vault_id]` on `POST /v1/sessions`.
3. Anthropic injects the right token into MCP requests at session runtime.

This pipeline does not bake user-vault provisioning into CI because vault membership maps to your end-users, not your release process. Two places where the pipeline could touch vaults:

- **Test fixture vaults.** A long-lived vault with a `static_bearer` to a sandbox MCP, referenced by session-mode evals when an agent's tool surface depends on MCP. Set `EVAL_VAULT_IDS` in the `agents:evals --mode=session` invocation and extend `scripts/run-evals.ts` to pass it through to `sessions.create`.
- **Rotation jobs.** A scheduled workflow that calls `POST /v1/vaults/{vault_id}/credentials/{cred_id}` to rotate the secret and `expires_at`. Out of scope for the initial pipeline.

## Sketch — adding a test vault

1. Provision once (manually or via a one-off script):

   ```bash
   curl -fsSL https://api.anthropic.com/v1/vaults \
     -H "x-api-key: $ANTHROPIC_API_KEY" \
     -H "anthropic-version: 2023-06-01" \
     -H "anthropic-beta: managed-agents-2026-04-01" \
     -H "content-type: application/json" \
     -d '{"display_name": "ci-fixtures", "metadata": {"role": "test"}}'
   # → vlt_…

   curl -fsSL https://api.anthropic.com/v1/vaults/vlt_…/credentials \
     -H "x-api-key: $ANTHROPIC_API_KEY" \
     -H "anthropic-version: 2023-06-01" \
     -H "anthropic-beta: managed-agents-2026-04-01" \
     -H "content-type: application/json" \
     -d '{
       "display_name": "Test Linear",
       "auth": {
         "type": "static_bearer",
         "mcp_server_url": "https://mcp.linear.app/mcp",
         "token": "lin_api_test_…"
       }
     }'
   ```

2. Store the vault id (not the secret — that's already inside Anthropic) as a repo variable, e.g. `EVAL_VAULT_IDS=vlt_…,vlt_…`.

3. Extend `scripts/run-evals.ts` `runSession()`:

   ```ts
   vault_ids: process.env.EVAL_VAULT_IDS?.split(',').filter(Boolean),
   ```

## Limits and gotchas

- One active credential per `mcp_server_url` per vault. Trying to add a second returns 409 — archive the old one first.
- 20 credentials per vault max (matches the MCP-server-per-agent ceiling).
- Secret fields (`token`, `access_token`, `refresh_token`, `client_secret`) are **write-only**. Don't expect to read them back.
- A bad token surfaces as an MCP auth error during the session — it does not block session creation.
- Workspace-scoped: anyone with API key access can use any vault to authorize an agent. To revoke, archive or delete the vault.
