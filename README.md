# Claude Managed Agents Pipeline

Production-grade GitHub Actions pipeline for repositories that ship [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview). Every change to a system prompt, tool list, environment, or eval suite gets reviewed, evaluated, red-teamed, and cost-checked before it ships. Deploys speak the real Managed Agents API (beta `managed-agents-2026-04-01`) with versioned agents, environments, and post-deploy session-mode verification.

## Features

**Agent authoring**

- Single-file YAML source of truth — [`agent.yaml`](agents/example-agent/agent.yaml) is `model`, `tools`, `mcp_servers`, `skills`, `system` (inline or `system_path`), `environment` (cloud sandbox: packages + networking), and CI knobs in one place
- [JSON Schema](schema/agent.schema.json) validation — typo + shape errors caught locally before any CI run
- Per-deploy-environment platform IDs (`platform.staging.*`, `platform.production.*`) auto-tracked and committed back

**PR review (every change)**

- **Agent diff** — sticky PR comment with config diff, system-prompt diff, optional LLM behavioral summary, and the predicted version bump per environment ([agent-diff.yaml](.github/workflows/agent-diff.yaml))
- **AI prompt review** — Claude Opus grades each changed prompt on a 7-dimension rubric (clarity, instruction quality, tool discipline, safety, injection resistance, cost efficiency, testability) and compares to the cached `main` baseline ([prompt-review.yaml](.github/workflows/prompt-review.yaml))
- **Behavioral evals** — `golden.jsonl` cases run through each agent, LLM-as-judge scores them, baseline regression detection blocks merges ([agent-eval.yaml](.github/workflows/agent-eval.yaml))
- **Cost budget** — token + USD regression check on `cost-probes.jsonl`; fails on >20% cost or >15% input-token regression vs cached main ([cost-budget.yaml](.github/workflows/cost-budget.yaml))
- **Static prompt lint** — no-API structural checks (length, sections, anti-patterns)
- **Standard CI** — lint, Prettier format check, typecheck, unit tests, build ([ci.yaml](.github/workflows/ci.yaml))

**Security**

- **Prompt-injection red team** — per-agent breach-rate gate via `injection.jsonl` cases ([security.yaml](.github/workflows/security.yaml)) — strict signals (any echo of the malicious payload counts as a breach), backed by a _Refuse abstractly_ prompt rule that tells agents not to quote attacker text in their refusals
- **GitHub Secret Protection** — native push protection + alerting, enabled at the repo level (no in-workflow scanner needed)
- **OSV vulnerability scan** — pnpm-lock and other manifests
- **CodeQL (JS/TS)** — runs as the GitHub-managed `CodeQL` workflow with `actions: read` permission for telemetry
- **Dependency review** on PRs (license + vulnerability gate)
- **Skip predicate on Dependabot PRs** — agent-behavior workflows (red-team, evals, prompt-review, agent-diff, cost-budget) don't run for `dependabot[bot]` since dep updates don't change agent behavior and Dependabot PRs don't have access to `secrets.ANTHROPIC_API_KEY`. CI + OSV + dep-review + CodeQL still run.

**Deploy and promote**

- **Auto-deploy to staging** on push to `main` ([deploy.yaml](.github/workflows/deploy.yaml))
- **Manual promotion to production** via `workflow_dispatch`, gated by GitHub Environment required-reviewers
- **Session-mode smoke evals** after deploy — exercises the live Managed Agents runtime via real `/v1/sessions`, pinned to the just-shipped version (`MIN_PASS_RATE=0.85` staging / `0.95` production)
- **Auto-rollback** on production smoke-eval failure
- **Manual rollback** to a numeric version or `previous` via `workflow_dispatch`
- **Append-only versioning** — every deploy creates a new immutable version on Anthropic's side; rollbacks produce a new version that mirrors the target
- See the [deploy + promote map](docs/deploy-and-promote.md) for the full flow

**Operations**

- **Anthropic Workload Identity Federation** — keyless authentication via GitHub OIDC. The workflow's identity token is exchanged at `POST /v1/oauth/token` for a short-lived `sk-ant-oat01-…` access token bound to an Anthropic service account; no static `ANTHROPIC_API_KEY` ever sits in the repo. Default-off, opt in by setting `vars.SECRET_PROVIDER=anthropic-wif`. ([credentials.md](docs/credentials.md))
- **Multi-provider secret loading (when not federating)** — GitHub Secrets (default fallback), AWS Secrets Manager, HashiCorp Vault, Azure Key Vault, 1Password, LastPass
- **OIDC-first** where supported (AWS / Azure / Vault) — no long-lived cloud creds in CI
- **Per-secret allow-list** — each workflow passes only the keys it needs (`{"ANTHROPIC_API_KEY": "${{ secrets.ANTHROPIC_API_KEY }}"}`), not `toJSON(secrets)`, so unrelated repo secrets aren't broadcast as env vars on every job
- **Per-Anthropic-Workspace key scoping** — each GitHub Environment binds to a different Workspace, so staging and production deploys never cross ([workspaces.md](docs/workspaces.md))
- **Anthropic Vault** support for per-end-user MCP OAuth credentials at session create time ([vaults.md](docs/vaults.md))
- **Cleanup workflow** — `Cleanup orphans` (`workflow_dispatch`, dry-run by default) lists and optionally archives Managed Agents / Environments in a Workspace that don't match `agent.yaml`'s `platform.<env>.*` IDs. Same logic available locally as `pnpm agents:cleanup`.
- All workflows run on `ubuntu-latest`; the action relies on Node + corepack already preinstalled (no extra setup steps)

This repo is a **reference implementation** — two working agents under [`agents/`](agents/) plus the full set of CI workflows wired to them. Fork or copy and adapt:

- [`example-agent`](agents/example-agent/agent.yaml) — minimal scaffold (support triage with no live tool calls)
- [`ai-news-digest`](agents/ai-news-digest/agent.yaml) — real research agent that uses `web_search` + `web_fetch` and serves as an end-to-end smoke test of the pipeline (see [Smoke test](#smoke-testing-the-pipeline))

## What it does

| Workflow                                                     | Trigger                    | What it gates on                                                                                                                                                                                                            |
| ------------------------------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`ci.yaml`](.github/workflows/ci.yaml)                       | every PR + main            | lint, format, typecheck, unit tests, build, static prompt lint                                                                                                                                                              |
| [`agent-diff.yaml`](.github/workflows/agent-diff.yaml)       | PR touching agents/        | sticky PR comment showing exactly what changes per agent — config diff, system-prompt diff, behavioral summary, predicted version bump per environment                                                                      |
| [`prompt-review.yaml`](.github/workflows/prompt-review.yaml) | PR touching prompts        | Claude Opus reviews every changed `system` prompt against a 7-dimension rubric, compares to baseline, comments                                                                                                              |
| [`agent-eval.yaml`](.github/workflows/agent-eval.yaml)       | PR + main + manual         | runs `golden.jsonl` cases through each agent (Messages API by default; `--mode=session` for full Managed Agents runtime), LLM-as-judge, blocks regression vs cached main baseline                                           |
| [`security.yaml`](.github/workflows/security.yaml)           | PR + main + weekly         | OSV, dependency-review, **prompt-injection red team** with a per-agent breach-rate gate. Native secret scanning + push protection are enabled separately at the repo level; CodeQL runs in its own GitHub-managed workflow. |
| [`cost-budget.yaml`](.github/workflows/cost-budget.yaml)     | PR touching prompts/agents | runs cost probes, tracks token + USD spend, fails on >20% cost or >15% input-token regression vs main                                                                                                                       |
| [`deploy.yaml`](.github/workflows/deploy.yaml)               | merge → main, manual prod  | syncs each agent to `POST /v1/agents` (versioned) + `POST /v1/environments`; smoke evals run as **real sessions** against the just-shipped version; auto-rollback on prod failure                                           |

All workflows share one internal composite action — [`.github/actions/claude-managed-agents-pipeline/action.yaml`](.github/actions/claude-managed-agents-pipeline/action.yaml) — that provisions `ANTHROPIC_API_KEY` from your chosen secret provider. Defaults to **GitHub Secrets**; also supports Anthropic Workload Identity Federation (`anthropic-wif`), AWS Secrets Manager, HashiCorp Vault, Azure Key Vault, 1Password, and LastPass. OIDC-first where the provider supports it. The action is consumed locally via a relative path (`./.github/actions/...`) and is not published as a standalone Marketplace action — fork or copy this repo to use it.

## Workspaces — where your agents live

Before you ship anything, understand how Anthropic scopes resources. Every resource this pipeline creates (Managed Agents, Environments, Sessions, Vaults) lives in an Anthropic **Workspace**, and every credential is bound to a specific workspace.

- **Static API key path** — each `ANTHROPIC_API_KEY` belongs to exactly one workspace; the workspace is implicit in the key.
- **WIF path** — the workspace is explicit: each federation rule targets one workspace, and `ANTHROPIC_WORKSPACE_ID` (`wrkspc_…`) must be set per GitHub Environment so the pipeline sends the right `workspace_id` when exchanging the OIDC token.

In either case:

```
GitHub Environment "staging"    → credential (API key or WIF token) → Staging Workspace
                                → deploy.ts creates agent in:         Staging Workspace

GitHub Environment "production" → credential (API key or WIF token) → Production Workspace
                                → deploy.ts creates agent in:         Production Workspace
```

If you mix credentials across environments you'll deploy to the wrong workspace and not notice until session-mode evals start failing with 404s on the agent ID.

### Strongly recommended layout

| Workspace           | Purpose                                              | Where its API key lives                          |
| ------------------- | ---------------------------------------------------- | ------------------------------------------------ |
| `<project>-dev`     | Engineers iterate locally; relaxed spend cap.        | Developer-managed (e.g. their own .env)          |
| `<project>-staging` | CI lands agents here on every merge to `main`.       | Provisioned to GitHub Environment **staging**    |
| `<project>-prod`    | Real user traffic. Required-reviewer GH Environment. | Provisioned to GitHub Environment **production** |

Each workspace gets its own API key with `name` matching the workspace (`<project>-staging-ci`, etc.). The pipeline's per-environment workflow vars (e.g. `vars.AWS_SECRET_ID_STAGING` vs `vars.AWS_SECRET_ID_PROD`) make sure each `deploy.yaml` invocation pulls the right key for its environment.

### Workspace roles (verbatim from the Admin API)

The Anthropic Admin API recognizes five workspace roles:

| Role                             | Typical use                                                      |
| -------------------------------- | ---------------------------------------------------------------- |
| `workspace_admin`                | Manage members and workspace settings.                           |
| `workspace_developer`            | Build and operate agents/sessions inside the workspace.          |
| `workspace_restricted_developer` | Build with reduced surface (limited spend, fewer admin actions). |
| `workspace_user`                 | Read-only access for non-builders.                               |
| `workspace_billing`              | View and manage spend/usage.                                     |

Service identities used by CI typically need `workspace_developer`. CI does **not** need `workspace_admin` — this pipeline never tries to manage members or other workspace-level state.

### Two kinds of API keys

|                        | Regular API key (what CI uses)                                                   | Admin API key                                               |
| ---------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Header                 | `x-api-key: sk-ant-…`                                                            | `X-Api-Key: $ANTHROPIC_ADMIN_API_KEY`                       |
| For                    | Messages API, Managed Agents API                                                 | `/v1/organizations/*` (workspace + member + key management) |
| Scope                  | One workspace                                                                    | Org-wide                                                    |
| Used by this pipeline? | **Yes** — provisioned by `claude-managed-agents-pipeline` as `ANTHROPIC_API_KEY` | No                                                          |

This pipeline never asks for an admin key. Workspace and member provisioning is org-level state — handle it in the Anthropic Console at [platform.claude.com](https://platform.claude.com/) or in Terraform/OpenTofu, not as a CI side effect.

### Data residency

Workspace data residency is set at creation and is **immutable**:

- `workspace_geo` — region for stored workspace data (default `"us"`)
- `allowed_inference_geos` — geos requests may run in (default `"unrestricted"`)
- `default_inference_geo` — geo applied when a request omits it (default `"global"`)

If you have regional data-handling requirements (EU GDPR, government, etc.), pin these at workspace creation. Changing them later means recreating the workspace and re-provisioning every agent inside it.

### One-time setup checklist

1. In the Anthropic Console at [platform.claude.com](https://platform.claude.com/) → **Settings** → **Workspaces**, create one workspace per environment you want to ship to (typical: dev, staging, production).

2. **Recommended path — Workload Identity Federation** (no static keys):
   - Settings → Service accounts → Create one service account for CI (e.g. `<your-org>-ci-workflows`). Add it to each workspace's Members tab.
   - Settings → Workload identity → Issuers → Create with `https://token.actions.githubusercontent.com` and JWKS source `discovery`.
   - Settings → Workload identity → Federation rules → Create one rule per workspace, matching `subject_prefix: repo:OWNER/REPO:` (tighter for production: `…:environment:production`) targeted at the SA.
   - In the GitHub repo: set `vars.SECRET_PROVIDER=anthropic-wif`, `vars.ANTHROPIC_ORGANIZATION_ID`, `vars.ANTHROPIC_SERVICE_ACCOUNT_ID`, and per-environment `vars.ANTHROPIC_FEDERATION_RULE_ID` and `vars.ANTHROPIC_WORKSPACE_ID` (`wrkspc_…`).
   - Full walkthrough: [docs/credentials.md](docs/credentials.md#0-anthropic-workload-identity-federation-recommended).

   **Alternative path — static API keys**: For each workspace, mint an API key (Settings → API Keys with the workspace selected) and store it under per-environment names in your [secret provider](docs/credentials.md). The pipeline auto-falls-back to this path if `SECRET_PROVIDER` is unset or `=github`.

3. Confirm by running `pnpm agents:deploy` against staging and watching the console: the new agent should appear in the staging workspace, not production or default.

Full reference: [docs/workspaces.md](docs/workspaces.md). Endpoint paths, fields, and role names are quoted from the Admin API spec.

## Concept mapping (Anthropic API → repo)

For the full breakdown see [docs/managed-agents.md](docs/managed-agents.md).

| Anthropic primitive                               | Repo artifact                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Agent** (`POST /v1/agents`, versioned)          | `agents/<id>/agent.yaml` (`agent` block; `system` inline or via `system_path`) |
| **Environment** (`POST /v1/environments`)         | `agents/<id>/agent.yaml` (`environment` block)                                 |
| **Session** (`POST /v1/sessions` + events)        | `--mode=session` runs in `run-evals.ts` and `prompt-injection-test.ts`         |
| **Vault** (per-user MCP OAuth, Anthropic-managed) | Operator-managed; see [docs/vaults.md](docs/vaults.md)                         |
| **Beta header** `managed-agents-2026-04-01`       | Set automatically by `scripts/lib/managed-agents-api.ts`                       |

## What is "an agent" in this repo?

**An agent IS a directory under `agents/`.** The directory name is the agent's repo-local id. Inside, [`agent.yaml`](agents/example-agent/agent.yaml) is the source of truth — model, tools, environment, system prompt, and CI knobs all live in that one file.

```
agents/<id>/                    ← THIS is the agent
  agent.yaml                    ← single source of truth (model, tools, env, system prompt, metadata)
  system-prompt.md              ← optional; only needed if agent.system_path points to a separate file
  evals/
    golden.jsonl                ← behavioral evals (LLM-as-judge)
    injection.jsonl             ← prompt-injection red-team cases
    cost-probes.jsonl           ← cost regression probes
```

Pick one or the other for the system prompt — never both:

```yaml
# Inline (good when the prompt fits comfortably in one file):
agent:
  system: |
    # Role
    You are …

# OR by reference (good for very long prompts you want to review on their own):
agent:
  system_path: ./system-prompt.md
```

The repo can hold a single agent or many — drop another directory under `agents/` and CI picks it up automatically.

The `platform` block at the bottom of agent.yaml is filled in automatically per deploy environment. Don't edit it by hand:

```yaml
platform:
  staging:
    managed_agent_id: agt_xxx # written by deploy.ts after first staging sync
    managed_agent_version: 7
    managed_environment_id: env_yyy
  production:
    managed_agent_id: agt_zzz # different workspace → different IDs
    managed_agent_version: 3
    managed_environment_id: env_www
```

Each top-level key under `platform:` is a deploy environment name. Different environments use API keys from different Anthropic Workspaces (per [docs/workspaces.md](docs/workspaces.md)) and resources don't cross workspace boundaries — that's why the IDs are tracked separately.

## What reviewers see on a PR

Every PR that touches `agents/` gets a sticky comment from [`agent-diff.yaml`](.github/workflows/agent-diff.yaml) summarizing exactly what will change for each agent when the PR merges. It includes:

- **Behavioral summary** (LLM, optional) — 1–3 bullets describing the practical effect of the change. Lead with the most consequential thing.
- **Config diff** — model bump, tools added/removed, mcp_servers added/removed, environment name/networking/packages, metadata.
- **Prompt diff** — line-level unified diff of the actual system prompt, resolved through `system_path` if applicable. Collapsible.
- **On next deploy** — predicted version bump per environment based on each environment's currently-recorded `managed_agent_version`. Flags when an environment block change forces a new environment to be created.

You can run the same locally:

```bash
BASE_REF=main pnpm agents:diff   # uses local working tree against main
```

Reviewers should read this comment before approving. It's the closest thing to a "what's actually different about this version" digest you can get.

## Repo layout

```
.github/
  workflows/                    # ci, agent-diff, prompt-review, agent-eval, security,
                                # cost-budget, deploy, release
  actions/claude-managed-agents-pipeline/         # composite: Node + pnpm + secret provider
agents/
  example-agent/                # → see "What is an agent" above
schema/
  agent.schema.json             # JSON Schema describing agent.yaml
scripts/
  lib/
    config.ts                   # YAML loader + Zod schema + makeAnthropicClient (honors AGENTS_ROOT)
    managed-agents-api.ts       # thin client for /v1/agents, /v1/environments, /v1/sessions
    utils.ts                    # shared pmap (bounded parallel map) and loadJSONL
  list-agents.ts                # matrix discovery
  lint-prompts.ts               # static prompt lint (no model calls)
  review-system-prompts.ts      # AI prompt review against rubric (Messages API)
  run-evals.ts                  # golden eval runner (--mode=messages | --mode=session)
  prompt-injection-test.ts      # red-team runner
  diff-agents.ts                # per-PR agent change report (config + prompt diff + LLM summary)
  cost-budget-check.ts          # token/cost regression
  deploy.ts                     # syncs agent + environment to Managed Agents API
docs/
  managed-agents.md             # how this pipeline maps to the Anthropic API
  vaults.md                     # Anthropic per-user MCP OAuth vaults
  credentials.md                # infra secret providers (where ANTHROPIC_API_KEY lives)
```

## Adding an agent

1. `mkdir agents/<id>` and create `agent.yaml` matching [schema/agent.schema.json](schema/agent.schema.json) — fill in `agent.name`, `agent.model`, `agent.tools`, `agent.system` (or `agent.system_path`), and `environment.config`. Use [`agents/example-agent/agent.yaml`](agents/example-agent/agent.yaml) as a template.
2. Add cases to `evals/golden.jsonl`, `evals/injection.jsonl`, and `evals/cost-probes.jsonl` (5+ each is a reasonable starting bar).
3. Open a PR. Static lint, prompt review, evals, injection sweep, and cost diff all comment back.
4. Merge. The staging deploy job calls `POST /v1/agents` + `POST /v1/environments`, runs **session-mode** smoke evals against the fresh version, and commits the returned `managed_agent_id` / `managed_agent_version` / `managed_environment_id` back to the file.
5. To promote to prod, run `deploy.yaml` via `workflow_dispatch` with `environment: production`.

## Smoke-testing the pipeline

[`agents/ai-news-digest`](agents/ai-news-digest/agent.yaml) exists specifically to verify the whole pipeline end-to-end against the live Managed Agents API. It uses the pre-built `agent_toolset_20260401` (which includes `web_search` and `web_fetch`) inside an environment with unrestricted networking, so a session-mode run actually hits the open web and produces a real digest.

```bash
export ANTHROPIC_API_KEY=sk-...
export DEPLOY_ENV=staging

# 1) Cheap, no-tools sanity check (just the prompt vs the Messages API)
pnpm agents:evals --agent=ai-news-digest --mode=messages

# 2) Token + cost regression probe (also Messages API)
pnpm agents:cost-budget

# 3) Real end-to-end run: deploy creates the agent + environment, then
#    session-mode evals exercise web_search + web_fetch against the live API
pnpm agents:deploy
pnpm agents:evals --agent=ai-news-digest --mode=session

# 4) Red-team the deployed version
pnpm agents:injection-test --agent=ai-news-digest --mode=session
```

After step 3, [`agents/ai-news-digest/agent.yaml`](agents/ai-news-digest/agent.yaml) will have its `platform.managed_agent_id`, `platform.managed_agent_version`, and `platform.managed_environment_id` filled in — that round-trip confirms the deploy script wrote back correctly. After step 4, the breach rate per category lands in `.eval-results/injection/`. If everything clears the configured thresholds, the pipeline is verified.

## Quality gates (tunable)

Set these as repo variables:

| Variable                        | Default | Effect                                                                                                                                                                    |
| ------------------------------- | ------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MIN_PROMPT_QUALITY_SCORE`      |    `75` | min overall score from the AI prompt reviewer                                                                                                                             |
| `MAX_PROMPT_QUALITY_REGRESSION` |     `5` | max points the reviewer score may drop vs baseline                                                                                                                        |
| `MIN_PASS_RATE`                 |   `0.9` | min eval pass rate per agent (PR-time evals only — deploy smoke evals are hardcoded `0.85` staging / `0.95` production in [`deploy.yaml`](.github/workflows/deploy.yaml)) |
| `MAX_REGRESSION_PCT`            |  `0.05` | max pass-rate drop vs cached main baseline                                                                                                                                |
| `MAX_BREACH_RATE`               |  `0.05` | max prompt-injection breach rate across agents                                                                                                                            |
| `MAX_COST_INCREASE_PCT`         |  `0.20` | max USD-cost regression on cost probes                                                                                                                                    |
| `MAX_INPUT_TOKEN_INCREASE_PCT`  |  `0.15` | max input-token regression on cost probes                                                                                                                                 |

## Two kinds of "vault" — keep them straight

This pipeline uses both, and they are unrelated:

- **Anthropic Vaults** — per-end-user OAuth credentials for MCP servers, managed by Anthropic. Token refresh handled for you. Reference at session creation via `vault_ids`. See [docs/vaults.md](docs/vaults.md).
- **Infra secret providers** — where the pipeline gets its own `ANTHROPIC_API_KEY` so it can call the API in the first place. AWS Secrets Manager, HashiCorp Vault, Azure Key Vault, 1Password, or GitHub Secrets. Configured via the `secret-provider` input on `claude-managed-agents-pipeline`. See [docs/credentials.md](docs/credentials.md).

## Local development

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm agents:lint-prompts                                                        # static checks (no API calls)
ANTHROPIC_API_KEY=... pnpm agents:evals --mode=messages                         # PR-style behavioral evals
ANTHROPIC_API_KEY=... pnpm agents:injection-test                                # red-team a local agent
ANTHROPIC_API_KEY=... DEPLOY_ENV=staging pnpm agents:deploy                     # sync agent + env to staging workspace
ANTHROPIC_API_KEY=... DEPLOY_ENV=staging pnpm agents:evals --mode=session       # post-deploy: real Sessions
ANTHROPIC_API_KEY=... DEPLOY_ENV=staging pnpm agents:cleanup                    # dry-run: list orphaned workspace resources
ANTHROPIC_API_KEY=... DEPLOY_ENV=staging pnpm agents:cleanup --apply            # archive orphans
```

## Deploy + rollback

> **Visual map:** [docs/deploy-and-promote.md](docs/deploy-and-promote.md) — diagrams of the staging deploy, the production promotion, and rollback paths, plus a deploy controls cheat sheet and troubleshooting table.

`scripts/deploy.ts` is idempotent and version-aware:

- First run for an agent → `POST /v1/agents` + `POST /v1/environments`, write IDs back to `agent.yaml`.
- Subsequent runs → `GET /v1/agents/{id}` for current version, `POST /v1/agents/{id}` with that version + the desired fields. The API auto-bumps the version, or returns the same version unchanged on a no-op.
- `ROLLBACK_TO_VERSION=<N>` (or `previous`) → fetches version N's snapshot and re-applies it as a new update; produces a fresh version that mirrors N. Versions are append-only.

Triggered by:

- Push to `main` → staging sync + session-mode smoke evals + commit IDs back. Staging smoke evals are `continue-on-error` since the resources are already created in the workspace by the time evals run; production keeps the gate and auto-rolls-back on smoke-eval failure.
- `workflow_dispatch` with `environment: production` → prod sync + post-deploy session-mode verification (gated by required-reviewer policy on the `production` GitHub Environment).
- `workflow_dispatch` with `rollback_to_version: <N>` (or `previous`) → version rollback only, no environment changes.

Failure-handling: the `Commit platform IDs back` step runs `if: success() || failure()` so partial state from a mid-deploy crash is always pushed to `main`. Without that, the next deploy reads NULL IDs and creates fresh resources, orphaning the previous ones.

### Cleaning up orphaned workspace resources

If a deploy ever ends up creating duplicates anyway (e.g., before this fix existed, or after a manual intervention that bypassed the auto-commit-back):

- **From CI**: trigger the `Cleanup orphans` workflow via `workflow_dispatch`. Choose the environment (staging or production), leave `apply` as `false` for a dry-run, then re-run with `apply=true`. Reads each `agents/<id>/agent.yaml`'s `platform.<env>.*` IDs as the source of truth, lists everything carrying this pipeline's `pipeline.repo_id` metadata, and archives whatever the workspace has but `agent.yaml` doesn't reference.
- **Locally**: `ANTHROPIC_API_KEY=… DEPLOY_ENV=staging pnpm agents:cleanup` (dry-run) then `--apply`. Anthropic's API has no delete; archive is the canonical retire — archived resources stop showing up in `list`, but old IDs stay queryable.

## Required GitHub setup

1. Add **Environments** named `staging` and `production`. On `production`, require reviewers and protect from non-`main` refs.
2. Configure your Anthropic credential provider:
   - **Recommended (Workload Identity Federation):** create the federation issuer + service account + per-workspace federation rules in the Anthropic Console, then set `vars.SECRET_PROVIDER=anthropic-wif`, `vars.ANTHROPIC_ORGANIZATION_ID`, `vars.ANTHROPIC_SERVICE_ACCOUNT_ID`, and per-environment `vars.ANTHROPIC_FEDERATION_RULE_ID`. No `ANTHROPIC_API_KEY` secret needed.
   - **Alternative (static API key):** leave `SECRET_PROVIDER` unset (or `=github`) and store `ANTHROPIC_API_KEY` per-environment as a GitHub secret, or wire one of the AWS / Vault / Azure / 1Password / LastPass paths. See [docs/credentials.md](docs/credentials.md).
3. Mark these jobs as required status checks on `main`: `CI success`, `Security summary`, `Analyze (actions)` (CodeQL). The path-conditional jobs (`Agent Diff / diff`, `System Prompt Review / review`, `Cost Budget / budget`, `Agent Evals / Comment results`) are real signals on PRs that touch `agents/**` but should not be required — making them required would block PRs that don't touch agents (since the workflow won't run, no check appears).
4. Provision a fine-grained PAT for the deploy auto-commit-back step. Repository: this repo only. Permission: **Contents: read and write** (nothing else). Store as repo-level secret `PIPELINE_PUSH_TOKEN`. The deploy workflow uses it to push the `chore(deploy): record managed agent IDs` commit back to `main` — required because branch protection blocks the default `GITHUB_TOKEN` even when the user is an admin.
