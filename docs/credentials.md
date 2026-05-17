# Anthropic credentials (Workload Identity Federation)

> Not to be confused with [Anthropic Vaults](vaults.md), which store per-end-user MCP OAuth credentials inside Anthropic's platform. This doc is about how the pipeline obtains its own Anthropic credential — the token the pipeline uses to talk to Anthropic in the first place.
>
> **Important context:** the credential the pipeline uses is bound to a single Anthropic [Workspace](workspaces.md). The agent will be created in that workspace. If you ship to multiple environments (staging vs prod), provision a separate federation rule per workspace and wire each one to the matching GitHub Environment. Read [docs/workspaces.md](workspaces.md) before configuring this for production.

The pipeline authenticates to Anthropic using **Workload Identity Federation (WIF)** — the workflow's GitHub OIDC token is exchanged for a short-lived Anthropic access token bound to a service account. No long-lived `ANTHROPIC_API_KEY` ever sits in the repo.

## One-time setup in the Anthropic Console

> **Guided setup:** [`scripts/bootstrap.sh`](../scripts/bootstrap.sh) walks you through the Console steps below in order, collects each ID you create (validating prefix shapes so typos fail early), and then runs the `gh variable set` commands to wire everything into your GitHub repo. Anthropic's WIF management endpoints aren't on the public Admin API yet, so the script doesn't create the Anthropic-side resources for you — but it does ensure you don't get the GitHub variables wrong.

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

## Variables to set in the repo

| Variable                       | Scope                  | Source                                                                                                                   |
| ------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `ANTHROPIC_ORGANIZATION_ID`    | repo-level             | the org UUID, Settings → Organization in the Console                                                                     |
| `ANTHROPIC_SERVICE_ACCOUNT_ID` | repo-level             | `svac_…` from step 1                                                                                                     |
| `ANTHROPIC_FEDERATION_RULE_ID` | **environment-scoped** | `fdrl_…` for the matching Workspace's rule                                                                               |
| `ANTHROPIC_WORKSPACE_ID`       | **environment-scoped** | `wrkspc_…` from Settings → Workspaces in the Console — required when the federation rule targets a non-default Workspace |

All variables are configured under **Settings → Secrets and variables → Actions → Variables**. The pipeline workflows all have `id-token: write` permission and read these vars; once they're set, the composite action runs the OIDC flow:

```
GitHub Actions JWT  →  POST /v1/oauth/token (jwt-bearer grant)  →  sk-ant-oat01-… token
```

The token is exported as masked `ANTHROPIC_AUTH_TOKEN`; the pipeline's API client (`scripts/lib/managed-agents-api.ts`) sends it as `Authorization: Bearer …`.

> Reference: [Anthropic — Workload Identity Federation](https://platform.claude.com/docs/en/build-with-claude/workload-identity-federation), [GitHub Actions provider guide](https://platform.claude.com/docs/en/build-with-claude/wif-providers/github-actions).

## Why WIF

- No static key in the repo means nothing to leak, rotate, or scrub from logs.
- Tokens expire in minutes, not never.
- Each token is bound to one service account in one Workspace; cross-Workspace mistakes get caught at exchange time, not at runtime.
- Audit log shows which workflow run minted which token.

The trade-off: setup is a few clicks more than dropping a static key into Secrets, and rule-misconfiguration can grant unintended access (e.g. `subject_prefix: repo:OWNER/*` matches every repo in the org including PR runs from forks). Match as narrowly as your workload allows.

## Per-environment isolation

Use [GitHub Environments](https://docs.github.com/en/actions/deployment/targeting-different-environments) (`staging`, `production`) and scope `ANTHROPIC_FEDERATION_RULE_ID` and `ANTHROPIC_WORKSPACE_ID` per environment so a token minted for staging cannot reach production. The deploy workflow binds to a GitHub Environment via `environment: ${{ github.event.inputs.environment || 'staging' }}` (in `deploy.yaml`), so the env-scoped vars resolve automatically — staging runs target the staging workspace, production runs target the production workspace.

## Auditing

- The token exchange step is wrapped in `::group::` so log review is easy.
- The access token is masked via `::add-mask::` before being written to `$GITHUB_ENV`.
- Required reviewers on the `production` environment force two-person approval for prod deploys.
- The JWT's claims (issuer, audience, subject, repository, ref, environment) are logged before exchange so rule-match misses are self-diagnosing.
