#!/usr/bin/env bash
#
# Guided setup for Anthropic Workload Identity Federation + GitHub repo
# variable wiring. Designed to be run from a workstation (NOT from CI).
#
# Anthropic does not currently expose service-account / OIDC-issuer /
# federation-rule management on the public Admin API — these resources
# are created through the Console UI. This script walks you through that
# in the right order, collects the IDs you create at each step, validates
# their prefix shapes so typos fail early, and then runs the
# `gh variable set` calls to wire them into your GitHub repo's
# Variables and per-environment Variables.
#
# Re-runnable: every input is just collection + validation + variable
# setting, no destructive mutations on the Anthropic side.

set -euo pipefail

GITHUB_OIDC_ISSUER_URL="https://token.actions.githubusercontent.com"

# ─── deps ──────────────────────────────────────────────────────────────
if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh CLI is required (https://cli.github.com/)" >&2
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "error: \`gh auth login\` first" >&2
  exit 1
fi

# ─── repo detection ────────────────────────────────────────────────────
detect_repo() {
  if [[ -n "${GITHUB_REPO:-}" ]]; then echo "$GITHUB_REPO"; return; fi
  local v
  v=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)
  if [[ -n "$v" ]]; then echo "$v"; return; fi
  local url
  url=$(git config --get remote.origin.url 2>/dev/null || true)
  if [[ "$url" =~ github\.com[:/]([^/]+)/([^/]+?)(\.git)?$ ]]; then
    echo "${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
  fi
}

DEFAULT_REPO="$(detect_repo)"

# ─── prompts + validation ──────────────────────────────────────────────
prompt() {
  local var="$1" msg="$2" default="${3:-}" value
  if [[ -n "$default" ]]; then
    read -r -p "$msg [$default]: " value
    value="${value:-$default}"
  else
    read -r -p "$msg: " value
  fi
  printf -v "$var" '%s' "$value"
}

require_prefix() {
  # require_prefix VAR_NAME EXPECTED_PREFIX HUMAN_HINT
  local name="$1" prefix="$2" hint="$3"
  local val="${!name}"
  if [[ -z "$val" ]]; then
    echo "error: $name is required ($hint)" >&2
    exit 1
  fi
  if [[ "$val" != "$prefix"* ]]; then
    echo "error: $name should start with '$prefix' (got '$val'). $hint" >&2
    exit 1
  fi
}

require_uuid() {
  local name="$1" val="${!name}"
  if [[ ! "$val" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
    echo "error: $name should be a UUID (got '$val')" >&2
    exit 1
  fi
}

# ─── intro ─────────────────────────────────────────────────────────────
cat <<'EOF'
─── Anthropic WIF setup ─────────────────────────────────────────

This script walks you through creating the Anthropic-side resources
in the Console (service account, OIDC issuer, federation rules) and
then wires the resulting IDs into your GitHub repo as Variables.

Console URL: https://platform.claude.com

Have two tabs ready: the Anthropic Console and this terminal.

EOF

prompt GITHUB_REPO "GitHub repo (owner/name)" "$DEFAULT_REPO"
if [[ -z "$GITHUB_REPO" || "$GITHUB_REPO" != */* ]]; then
  echo "error: repo must be in 'owner/name' form (e.g. acme/my-agents)" >&2
  exit 1
fi
echo "Target repo: $GITHUB_REPO"
echo

# ─── 1. Organization ID ────────────────────────────────────────────────
cat <<'EOF'
─── 1/5  Organization ID ─────────────────────────────────────────

Anthropic Console → Settings → Organization.
Copy the UUID at the top of the page (no prefix, just the UUID).

EOF
prompt ORG_ID "Organization ID (UUID)"
require_uuid ORG_ID

# ─── 2. Service Account ────────────────────────────────────────────────
cat <<'EOF'

─── 2/5  Service Account ────────────────────────────────────────

Console → Settings → Service accounts → Create.
  - Name: pick something descriptive (e.g. "ci-managed-agents")
  - Add the service account to BOTH workspaces (staging + production)
    via each workspace's Members tab.

Copy the resulting svac_… ID.

EOF
prompt SA_ID "Service account ID (svac_…)"
require_prefix SA_ID "svac_" "Settings → Service accounts → the one you created"

# ─── 3. OIDC Issuer ────────────────────────────────────────────────────
cat <<EOF

─── 3/5  GitHub Actions OIDC Issuer ─────────────────────────────

Console → Settings → Workload identity → Issuers → Create.
  - Name:        github-actions
  - Issuer URL:  $GITHUB_OIDC_ISSUER_URL
  - JWKS source: discovery

You don't need to write the issuer ID to GitHub — it's only used
when creating federation rules in the next step. (If you've already
created an issuer for this repo, reuse it.)

EOF
read -r -p "Press enter once the issuer is created (or already exists)..."

# ─── 4. Federation Rules ───────────────────────────────────────────────
cat <<EOF

─── 4/5  Federation Rules (one per workspace) ───────────────────

Console → Settings → Workload identity → Federation rules → Create.

You need TWO rules — one for staging, one for production.

  Both rules:
    Issuer:                <the github-actions issuer from step 3>
    Audience (match):      https://api.anthropic.com
    Target service account: $SA_ID
    OAuth scope:           workspace:developer
    Token lifetime:        3600

  Staging rule:
    Name:                  gha-staging   (or similar)
    Subject prefix:        repo:$GITHUB_REPO:
    Workspace:             <your staging workspace>

  Production rule:
    Name:                  gha-production
    Subject prefix:        repo:$GITHUB_REPO:environment:production
    Workspace:             <your production workspace>

The production rule's tighter subject_prefix means only deploys gated
by the GitHub 'production' Environment can mint prod tokens.

EOF

prompt STAGING_WS_ID    "Staging workspace ID (wrkspc_…)"
require_prefix STAGING_WS_ID "wrkspc_" "Settings → Workspaces"
prompt STAGING_RULE_ID  "Staging federation rule ID (fdrl_…)"
require_prefix STAGING_RULE_ID "fdrl_" "Settings → Workload identity → Federation rules"

prompt PROD_WS_ID       "Production workspace ID (wrkspc_…)"
require_prefix PROD_WS_ID "wrkspc_" "Settings → Workspaces"
prompt PROD_RULE_ID     "Production federation rule ID (fdrl_…)"
require_prefix PROD_RULE_ID "fdrl_" "Settings → Workload identity → Federation rules"

if [[ "$STAGING_WS_ID" == "$PROD_WS_ID" ]]; then
  echo "warning: staging and production workspace IDs are the same — that means a 'prod' deploy will land in the staging workspace. Probably not what you want." >&2
fi
if [[ "$STAGING_RULE_ID" == "$PROD_RULE_ID" ]]; then
  echo "error: staging and production federation rule IDs are the same — each workspace needs its own rule." >&2
  exit 1
fi

# ─── 5. Wire GitHub Variables ──────────────────────────────────────────
cat <<EOF

─── 5/5  GitHub repo Variables ──────────────────────────────────

About to set the following in $GITHUB_REPO:

  Repo-level Variables:
    ANTHROPIC_ORGANIZATION_ID    = $ORG_ID
    ANTHROPIC_SERVICE_ACCOUNT_ID = $SA_ID

  Environment 'staging' Variables:
    ANTHROPIC_FEDERATION_RULE_ID = $STAGING_RULE_ID
    ANTHROPIC_WORKSPACE_ID       = $STAGING_WS_ID

  Environment 'production' Variables:
    ANTHROPIC_FEDERATION_RULE_ID = $PROD_RULE_ID
    ANTHROPIC_WORKSPACE_ID       = $PROD_WS_ID

EOF

read -r -p "Apply these now via gh CLI? [y/N]: " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo
  echo "Skipped. Copy-pasteable commands:"
  cat <<EOF
gh variable set ANTHROPIC_ORGANIZATION_ID    --repo $GITHUB_REPO --body "$ORG_ID"
gh variable set ANTHROPIC_SERVICE_ACCOUNT_ID --repo $GITHUB_REPO --body "$SA_ID"
gh variable set ANTHROPIC_FEDERATION_RULE_ID --repo $GITHUB_REPO --env staging    --body "$STAGING_RULE_ID"
gh variable set ANTHROPIC_WORKSPACE_ID       --repo $GITHUB_REPO --env staging    --body "$STAGING_WS_ID"
gh variable set ANTHROPIC_FEDERATION_RULE_ID --repo $GITHUB_REPO --env production --body "$PROD_RULE_ID"
gh variable set ANTHROPIC_WORKSPACE_ID       --repo $GITHUB_REPO --env production --body "$PROD_WS_ID"
EOF
  exit 0
fi

gh variable set ANTHROPIC_ORGANIZATION_ID    --repo "$GITHUB_REPO" --body "$ORG_ID"
gh variable set ANTHROPIC_SERVICE_ACCOUNT_ID --repo "$GITHUB_REPO" --body "$SA_ID"
gh variable set ANTHROPIC_FEDERATION_RULE_ID --repo "$GITHUB_REPO" --env staging    --body "$STAGING_RULE_ID"
gh variable set ANTHROPIC_WORKSPACE_ID       --repo "$GITHUB_REPO" --env staging    --body "$STAGING_WS_ID"
gh variable set ANTHROPIC_FEDERATION_RULE_ID --repo "$GITHUB_REPO" --env production --body "$PROD_RULE_ID"
gh variable set ANTHROPIC_WORKSPACE_ID       --repo "$GITHUB_REPO" --env production --body "$PROD_WS_ID"

echo
echo "✓ GitHub variables set."
echo
echo "Next: trigger a workflow (e.g. workflow_dispatch on Deploy with"
echo "environment=staging) to verify the OIDC token exchange works."
echo "If it fails, the composite action's WIF step logs the JWT claims"
echo "and HTTP error body so 401s are self-diagnosing."
