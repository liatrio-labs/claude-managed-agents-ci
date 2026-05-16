# Anthropic credential providers

> Not to be confused with [Anthropic Vaults](vaults.md), which store per-end-user MCP OAuth credentials inside Anthropic's platform. This doc is about how the pipeline obtains its own Anthropic credential — the token the pipeline uses to talk to Anthropic in the first place.
>
> **Important context:** the credential the pipeline uses is bound to a single Anthropic [Workspace](workspaces.md). The agent will be created in that workspace. If you ship to multiple environments (staging vs prod), provision a separate credential per workspace and wire each one to the matching GitHub Environment. Read [docs/workspaces.md](workspaces.md) before configuring this for production.

The `claude-managed-agents-pipeline` composite action provisions credentials at job start. The strongest path is **Workload Identity Federation** — the workflow's GitHub OIDC token is exchanged for a short-lived Anthropic access token bound to a service account, and no long-lived `ANTHROPIC_API_KEY` ever sits in the repo. The action also still supports several static-key paths (GitHub Secrets, AWS Secrets Manager, HashiCorp Vault, Azure Key Vault, 1Password, LastPass) for environments that aren't ready to federate.

You select a provider per-environment with the `SECRET_PROVIDER` repo variable (or per-workflow input):

```
SECRET_PROVIDER = anthropic-wif | github | aws | vault | azure | 1password | lastpass
```

Required variables for each provider are below. All variables marked `vars.*` are configured under **Settings → Secrets and variables → Actions → Variables**. Only `OP_SERVICE_ACCOUNT_TOKEN` (1Password) and `LASTPASS_*` (LastPass) live in **Secrets** because those providers can't accept OIDC.

## 0. Anthropic Workload Identity Federation (recommended)

The keyless path. Anthropic verifies a GitHub OIDC token signed by `https://token.actions.githubusercontent.com`, matches it against a federation rule you registered, and mints a `sk-ant-oat01-…` access token bound to a service account in your org. The token lasts `token_lifetime_seconds` (default 3600) and is scoped to one Workspace.

> Reference: [Anthropic — Workload Identity Federation](https://platform.claude.com/docs/en/build-with-claude/workload-identity-federation), [GitHub Actions provider guide](https://platform.claude.com/docs/en/build-with-claude/wif-providers/github-actions).

### One-time setup in the Anthropic Console

1. **Service account** — Settings → Service accounts → Create. Name it after your CI workload (e.g. `liatrio-labs-ci-workflows`). Add it to each Workspace it will operate in (staging, production) under that workspace's Members tab.

2. **Federation issuer** — Settings → Workload identity → Issuers → Create.
   - Name: `github-actions`
   - Issuer URL: `https://token.actions.githubusercontent.com`
   - JWKS source: `discovery`

3. **One federation rule per Workspace** — Settings → Workload identity → Federation rules → Create. The form has **separate fields** for each match condition; paste only the listed value into each, do not paste the whole table into a single input. Typical staging rule:

   | UI field                                | Value to paste (only this string)                                            |
   | --------------------------------------- | ---------------------------------------------------------------------------- |
   | Name                                    | `gha-staging`                                                                |
   | Issuer                                  | `github-actions`                                                             |
   | **Subject prefix**                      | `repo:OWNER/REPO:` (prefix-matched against the JWT's full `sub` — see below) |
   | **Audience**                            | `https://api.anthropic.com`                                                  |
   | **Claims** (key/value, separate inputs) | key `repository_owner`, value `OWNER`                                        |
   | Target service account                  | the SA from step 1                                                           |
   | Workspace                               | staging                                                                      |
   | OAuth scope                             | `workspace:developer`                                                        |
   | Token lifetime                          | `3600`                                                                       |

   **What goes in `Subject prefix`** — a prefix that matches the JWT's `sub` claim. For a `push` to `main`, GitHub puts `sub = repo:OWNER/REPO:ref:refs/heads/main`; for an environment-gated deploy, `sub = repo:OWNER/REPO:environment:<name>`. Two safe shapes:
   - `repo:OWNER/REPO:` — matches every event from this repo. Convenient for staging where many workflows hit the same workspace.
   - `repo:OWNER/REPO:environment:production` — matches only the production-environment-gated deploy. Use this for the production rule so other workflows can't mint prod tokens.

   Note each rule's ID (`fdrl_…`).

### Variables to set in the repo

| Variable                       | Scope                           | Source                                                                                                                   |
| ------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `SECRET_PROVIDER`              | repo-level (or per-environment) | literal `anthropic-wif`                                                                                                  |
| `ANTHROPIC_ORGANIZATION_ID`    | repo-level                      | the org UUID, Settings → Organization in the Console                                                                     |
| `ANTHROPIC_SERVICE_ACCOUNT_ID` | repo-level                      | `svac_…` from step 1                                                                                                     |
| `ANTHROPIC_FEDERATION_RULE_ID` | **environment-scoped**          | `fdrl_…` for the matching Workspace's rule                                                                               |
| `ANTHROPIC_WORKSPACE_ID`       | **environment-scoped**          | `wrkspc_…` from Settings → Workspaces in the Console — required when the federation rule targets a non-default Workspace |

The pipeline workflows (`deploy.yaml`, `agent-eval.yaml`, etc.) all have `id-token: write` permission and read these vars; once they're set, the action runs the OIDC flow:

```
GitHub Actions JWT  →  POST /v1/oauth/token (jwt-bearer grant)  →  sk-ant-oat01-… token
```

The token is exported as masked `ANTHROPIC_AUTH_TOKEN`; the pipeline's API client (`scripts/lib/managed-agents-api.ts`) sends it as `Authorization: Bearer …`.

### Migration from a static key

While both work side-by-side, the SDK precedence puts `ANTHROPIC_API_KEY` above `ANTHROPIC_AUTH_TOKEN` (so a leftover static key would silently shadow WIF). Migration order:

1. Configure WIF as above; set `vars.SECRET_PROVIDER=anthropic-wif`.
2. Run a workflow and confirm the action's "Acquired Anthropic access token" log line appears.
3. **Remove** the `secrets.ANTHROPIC_API_KEY` repo/environment secret.
4. Revoke the old static API key in the Anthropic Console (Settings → API keys).

### Why prefer this

- No static key in the repo means nothing to leak, rotate, or scrub from logs.
- Tokens expire in minutes, not never.
- Each token is bound to one service account in one Workspace; cross-Workspace mistakes get caught at exchange time, not at runtime.
- Audit log shows which workflow run minted which token.

The trade-off: setup is a few clicks more than dropping a static key into Secrets, and rule-misconfiguration can grant unintended access (e.g. `subject_prefix: repo:OWNER/*` matches every repo in the org including PR runs from forks). Match as narrowly as your workload allows.

## 1. AWS Secrets Manager (recommended)

Create an IAM role trusted by GitHub OIDC. Trust policy condition:

```json
{
  "StringLike": {
    "token.actions.githubusercontent.com:sub": "repo:your-org/your-repo:environment:production"
  }
}
```

Variables:

| Name              | Example                                              |
| ----------------- | ---------------------------------------------------- |
| `SECRET_PROVIDER` | `aws`                                                |
| `AWS_ROLE_ARN`    | `arn:aws:iam::123456789012:role/gh-claude-agents-ci` |
| `AWS_REGION`      | `us-east-1`                                          |
| `AWS_SECRET_ID`   | `claude/managed-agents/staging`                      |

The secret in Secrets Manager must be JSON, e.g.:

```json
{ "ANTHROPIC_API_KEY": "sk-...", "VERCEL_TOKEN": "..." }
```

Each key becomes a masked env var in the job.

## 2. HashiCorp Vault (JWT auth)

Variables:

| Name                 | Example                                   |
| -------------------- | ----------------------------------------- |
| `SECRET_PROVIDER`    | `vault`                                   |
| `VAULT_URL`          | `https://vault.internal.example.com:8200` |
| `VAULT_ROLE`         | `gh-claude-agents`                        |
| `VAULT_SECRET_PATHS` | (newline list, see below)                 |

`VAULT_SECRET_PATHS` follows the [`hashicorp/vault-action`](https://github.com/hashicorp/vault-action) format:

```
secret/data/claude/agents anthropic_api_key | ANTHROPIC_API_KEY ;
secret/data/deploy        vercel_token       | VERCEL_TOKEN ;
```

## 3. Azure Key Vault

| Name                    | Example                   |
| ----------------------- | ------------------------- |
| `SECRET_PROVIDER`       | `azure`                   |
| `AZURE_CLIENT_ID`       | (federated app client id) |
| `AZURE_TENANT_ID`       | tenant guid               |
| `AZURE_SUBSCRIPTION_ID` | subscription guid         |
| `AZURE_KEYVAULT_NAME`   | `kv-claude-agents-prod`   |
| `AZURE_SECRET_NAMES`    | (newline list, see below) |

`AZURE_SECRET_NAMES`:

```
ANTHROPIC_API_KEY=anthropic-api-key
VERCEL_TOKEN=vercel-token
```

## 4. 1Password Service Account

Required secret:

- `OP_SERVICE_ACCOUNT_TOKEN` — service account token (Settings → Secrets)

Required vars:

| Name              | Example                                       |
| ----------------- | --------------------------------------------- |
| `SECRET_PROVIDER` | `1password`                                   |
| `OP_SECRET_REFS`  | (newline list of `ENV=op://vault/item/field`) |

```
ANTHROPIC_API_KEY=op://Engineering/Anthropic API/credential
VERCEL_TOKEN=op://Engineering/Vercel CI/token
```

## 5. GitHub Secrets (default)

`SECRET_PROVIDER=github` is the default. The caller workflow passes `github-secrets-json` — a JSON object containing only the keys the action needs (typically just `ANTHROPIC_API_KEY`). The action then injects each of those keys as a masked env var. Suitable for getting started; for production prefer one of the OIDC-backed options above so you don't keep long-lived API keys in repo settings.

> Earlier revisions of this pipeline passed `toJSON(secrets)` (every repo secret) — that was changed to a per-key allow-list to avoid broadcasting unrelated secrets (e.g. tokens for other tools in the same org) into every CI job's env.

## 6. LastPass (CLI; static credentials)

LastPass does not support OIDC, so this is a **static-credential** path — the same risk tier as the GitHub fallback. The composite installs `lpass`, logs in non-interactively with the master password, and resolves each requested item.

Required secrets:

| Secret              | Notes                                                            |
| ------------------- | ---------------------------------------------------------------- |
| `LASTPASS_USERNAME` | LastPass account email (passed in via the `lp-username` input)   |
| `LASTPASS_PASSWORD` | LastPass master password (passed in via the `lp-password` input) |

Required vars:

| Name              | Example                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| `SECRET_PROVIDER` | `lastpass`                                                                |
| `LP_SECRET_REFS`  | newline list of `ENV_NAME=Folder/Item` mappings (`lpass show --password`) |

Example caller wiring:

```yaml
- uses: ./.github/actions/claude-managed-agents-pipeline
  with:
    secret-provider: lastpass
    lp-username: ${{ secrets.LASTPASS_USERNAME }}
    lp-password: ${{ secrets.LASTPASS_PASSWORD }}
    lp-secret-refs: |
      ANTHROPIC_API_KEY=Engineering/Anthropic API
      VERCEL_TOKEN=Engineering/Vercel CI
```

Recommendations if you must use this:

- Use a **service account** (not a real human's vault) with a hardened master password and IP allowlisting in the LastPass admin console.
- Restrict the runner to GitHub-hosted IP ranges via LastPass policies.
- Rotate the master password regularly. There is no native short-lived-credential story.
- The composite logs out at the end of the step (`lpass logout --force`) so the in-runner session does not persist. The master password value is masked in logs.

## Required env vars after vault loads

Whatever vault you pick, the job must expose an Anthropic credential. With WIF the credential is `ANTHROPIC_AUTH_TOKEN` (a short-lived Bearer token); with all static-key paths it is `ANTHROPIC_API_KEY`.

| Env var                    | Set by                                                     | Used by                                            |
| -------------------------- | ---------------------------------------------------------- | -------------------------------------------------- |
| `ANTHROPIC_AUTH_TOKEN`     | WIF path — set automatically by the composite action       | all pipeline scripts (preferred over API key)      |
| `ANTHROPIC_API_KEY`        | static-key paths (GitHub Secrets, AWS, Vault, Azure, etc.) | all pipeline scripts (fallback when no auth token) |
| `VERCEL_TOKEN`             | your secret provider                                       | deploy (only if any agent uses `runtime: vercel`)  |
| `OP_SERVICE_ACCOUNT_TOKEN` | GitHub Secrets                                             | only when using 1Password                          |

The pipeline's API client (`scripts/lib/managed-agents-api.ts`) prefers `ANTHROPIC_AUTH_TOKEN` (WIF Bearer) over `ANTHROPIC_API_KEY`. At least one must be present or the script will exit with an error.

## Per-environment isolation

Use [GitHub Environments](https://docs.github.com/en/actions/deployment/targeting-different-environments) (`staging`, `production`) and scope your vault credentials per environment so a compromised staging token cannot reach production. The deploy workflow binds to a GitHub Environment via `environment: ${{ github.event.inputs.environment || 'staging' }}` (in `deploy.yaml`), so `secrets.ANTHROPIC_API_KEY` and any provider-specific `vars.*` you've scoped per environment resolve automatically — staging runs see staging-only secrets, production runs see production-only secrets.

## Auditing

- Every job step that fetches a secret group is wrapped in `::group::` so log review is easy.
- All secret values are masked via `::add-mask::` before being written to `$GITHUB_ENV`.
- Required reviewers on the `production` environment force two-person approval for prod deploys.
