# Use this pipeline from another repo

This repository ships one consumable artifact: the
[`claude-managed-agents-pipeline`](../.github/actions/claude-managed-agents-pipeline/action.yaml)
composite action, published to the GitHub Marketplace. It handles the
secret-provisioning side of the pipeline — pulling `ANTHROPIC_API_KEY` (and
any other infra secrets) from your chosen vault and exporting them as masked
env vars — so any workflow can run the pipeline's pnpm scripts against the
right Anthropic Workspace.

The recommended consumption pattern is **call the action from your own
workflows**. The reference workflows under [`.github/workflows/`](../.github/workflows/)
are intended as a working example you can copy verbatim or adapt — but you
don't have to fork the repo to use the action itself.

## Option 1 — Use the action from your own workflows

### With Workload Identity Federation (recommended; no static key)

```yaml
# .github/workflows/agents.yaml in your repo
name: Agents

on: [pull_request, push]

permissions:
  contents: read
  id-token: write # required for Anthropic WIF (GitHub OIDC token)

jobs:
  evals:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: OWNER/REPO/.github/actions/claude-managed-agents-pipeline@v1
        with:
          secret-provider: anthropic-wif
          anthropic-organization-id: ${{ vars.ANTHROPIC_ORGANIZATION_ID }}
          anthropic-service-account-id: ${{ vars.ANTHROPIC_SERVICE_ACCOUNT_ID }}
          anthropic-federation-rule-id: ${{ vars.ANTHROPIC_FEDERATION_RULE_ID }}
      - run: # your own steps; ANTHROPIC_AUTH_TOKEN is now in the env
```

You'll need the federation issuer + service account + rule set up in the
Anthropic Console first — see [credentials.md](credentials.md#0-anthropic-workload-identity-federation-recommended).

### With a static GitHub Secret (fallback)

```yaml
jobs:
  evals:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: OWNER/REPO/.github/actions/claude-managed-agents-pipeline@v1
        with:
          # `secret-provider` defaults to `github`. To switch (aws / vault /
          # azure / 1password / lastpass), see docs/credentials.md.
          # Pass only the keys the action needs — broadcasting toJSON(secrets)
          # exports every repo secret as an env var on every job.
          github-secrets-json: '{"ANTHROPIC_API_KEY": "${{ secrets.ANTHROPIC_API_KEY }}"}'
      - run: # your own steps; ANTHROPIC_API_KEY is now in the env
```

The action only handles bootstrap — credential loading, plus a single
`corepack enable pnpm && pnpm install` against the pipeline's pnpm-lock. It
does **not** run any pipeline scripts on your behalf; you call them yourself
in subsequent steps. That keeps your workflows in your repo, where you can
diff and review them, while the credential-handling stays centrally
maintained.

## Option 2 — Fork or copy the reference implementation

If you want the whole pipeline (workflows, scripts, schema, tests) instead of
just the action, fork or copy the relevant pieces:

- `.github/workflows/*.yaml` — the reference workflows
- `.github/actions/claude-managed-agents-pipeline/` — the action itself
- `scripts/` — the TS implementations behind each `pnpm agents:*` command
- `schema/agent.schema.json` — the JSON Schema for `agent.yaml`

Then replace `agents/` with your own agent directories. Each agent is a
directory under `agents/` containing an `agent.yaml` matching
[`schema/agent.schema.json`](../schema/agent.schema.json).

This path means you own the whole pipeline — you'll merge upstream changes
yourself. Use it when you need to deviate substantially from the reference
implementation.

## Required layout (either option)

```
your-repo/
└── agents/
    └── <agent-id>/                # the directory IS the agent
        ├── agent.yaml             # source of truth (matches schema/agent.schema.json)
        ├── system-prompt.md       # optional — only if agent.system_path points at it
        └── evals/
            ├── golden.jsonl
            ├── injection.jsonl
            └── cost-probes.jsonl
```

## Required permissions

Most workflows need `contents: read` and `pull-requests: write` (for sticky
PR comments via [`marocchino/sticky-pull-request-comment@v2`](https://github.com/marocchino/sticky-pull-request-comment)).
`deploy.yaml` needs `contents: write` so it can commit the returned
`managed_agent_id` and version back to the agent's `agent.yaml`. If you use
the AWS / Azure / Vault paths in the action, the job also needs
`id-token: write` so OIDC token exchange can run — see the commented hint
above the `permissions:` block in each reference workflow.

## Caveats

- The action expects Node + corepack on the runner. `ubuntu-latest` has both
  preinstalled; other runner images may not.
- Eval baselines (cached on the repo side) are keyed by branch name. Renaming
  your default branch will invalidate them once.
- The `Commit platform IDs back` step in `deploy.yaml` pushes via the
  workflow's `GITHUB_TOKEN`; protected branches will reject it. Either remove
  that step and commit IDs by hand, or use a PAT with the right scopes via
  `secrets.PIPELINE_PUSH_TOKEN` (extend the workflow accordingly).
