#!/usr/bin/env bash
#
# One-shot bootstrap for Anthropic Workload Identity Federation, designed
# to be run from a workstation (NOT from CI — it needs an Admin API key,
# which has org-wide power). Re-runnable: every step checks for existing
# resources before creating.
#
# What it does:
#   1. Validates an Anthropic Admin API key (prompted, read silently).
#   2. Lists workspaces — you pick the staging + production ones by name.
#   3. Creates (or reuses) one CI service account, adds it to both workspaces.
#   4. Creates (or reuses) a GitHub Actions OIDC issuer in the org.
#   5. Creates one federation rule per workspace, scoped to this repo.
#   6. Prints the final IDs and the `gh variable set` commands to wire
#      them into the GitHub repo (or runs them for you if `gh` is logged in).
#
# Field names match the Console walkthrough in docs/credentials.md. If
# Anthropic renames a field, the `jq -e` check at that step will error
# with a clear message of what's missing.

set -euo pipefail

ANTHROPIC_API_BASE="${ANTHROPIC_API_BASE:-https://api.anthropic.com}"
GITHUB_OIDC_ISSUER_URL="https://token.actions.githubusercontent.com"
DEFAULT_SA_NAME="${SA_NAME:-claude-managed-agents-ci}"
DEFAULT_REPO="${GITHUB_REPO:-liatrio-labs/claude-managed-agents-ci}"

# ─── deps ──────────────────────────────────────────────────────────────
for cmd in curl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: $cmd is required" >&2
    exit 1
  fi
done

HAS_GH=0
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  HAS_GH=1
fi

# ─── prompts ───────────────────────────────────────────────────────────
prompt() {
  local var="$1" msg="$2" default="${3:-}"
  local value
  if [ -n "$default" ]; then
    read -r -p "$msg [$default]: " value
    value="${value:-$default}"
  else
    read -r -p "$msg: " value
  fi
  printf -v "$var" '%s' "$value"
}

prompt_secret() {
  local var="$1" msg="$2" value
  read -r -s -p "$msg: " value
  echo
  printf -v "$var" '%s' "$value"
}

echo "─── Anthropic WIF bootstrap ─────────────────────────────────────"
echo "This sets up Workload Identity Federation for:"
echo "  repo:        $DEFAULT_REPO"
echo "  service acct: $DEFAULT_SA_NAME"
echo
echo "You will need an Anthropic Admin API key (Settings → API keys →"
echo "Admin keys in the Console). It is NOT stored anywhere by this"
echo "script and is only used for the duration of this run."
echo

prompt GITHUB_REPO "GitHub repo (owner/name)" "$DEFAULT_REPO"
prompt SA_NAME    "Service account name" "$DEFAULT_SA_NAME"
prompt_secret ADMIN_KEY "Anthropic Admin API key (sk-ant-…)"

if [[ -z "$ADMIN_KEY" || "$ADMIN_KEY" != sk-ant-* ]]; then
  echo "error: admin key must start with 'sk-ant-'" >&2
  exit 1
fi

# ─── helpers ───────────────────────────────────────────────────────────
api() {
  # api METHOD PATH [JSON_BODY]
  local method="$1" path="$2" body="${3:-}"
  local url="$ANTHROPIC_API_BASE$path"
  local resp http_code
  if [ -n "$body" ]; then
    resp=$(curl -sS -w "\n__HTTP__%{http_code}" -X "$method" "$url" \
      -H "X-Api-Key: $ADMIN_KEY" \
      -H "anthropic-version: 2023-06-01" \
      -H "content-type: application/json" \
      --data "$body")
  else
    resp=$(curl -sS -w "\n__HTTP__%{http_code}" -X "$method" "$url" \
      -H "X-Api-Key: $ADMIN_KEY" \
      -H "anthropic-version: 2023-06-01")
  fi
  http_code=$(echo "$resp" | awk -F'__HTTP__' '/__HTTP__/{print $2}')
  local body_out
  body_out=$(echo "$resp" | sed '$ d')
  if [[ "$http_code" -ge 400 ]]; then
    echo "error: $method $path returned HTTP $http_code" >&2
    echo "$body_out" >&2
    exit 1
  fi
  echo "$body_out"
}

require_field() {
  # require_field JSON FIELD CONTEXT
  local json="$1" field="$2" ctx="$3"
  if ! echo "$json" | jq -e ".$field" >/dev/null 2>&1; then
    echo "error: response from $ctx is missing field '$field'" >&2
    echo "Got:" >&2
    echo "$json" | jq . >&2
    echo "Hint: the Anthropic Admin API may have renamed this field. Adjust the script and re-run." >&2
    exit 1
  fi
  echo "$json" | jq -r ".$field"
}

# ─── 1. Pick workspaces ────────────────────────────────────────────────
echo
echo "─── 1/5  Discover workspaces ────────────────────────────────────"
WORKSPACES_JSON=$(api GET /v1/organizations/workspaces)
echo "Available workspaces:"
echo "$WORKSPACES_JSON" | jq -r '.data[] | "  - \(.name)  (\(.id))"'
echo

prompt STAGING_WS_NAME "Workspace name for STAGING"
prompt PROD_WS_NAME    "Workspace name for PRODUCTION"

STAGING_WS_ID=$(echo "$WORKSPACES_JSON" | jq -r --arg n "$STAGING_WS_NAME" '.data[] | select(.name==$n) | .id')
PROD_WS_ID=$(echo "$WORKSPACES_JSON" | jq -r --arg n "$PROD_WS_NAME"    '.data[] | select(.name==$n) | .id')

if [[ -z "$STAGING_WS_ID" || -z "$PROD_WS_ID" ]]; then
  echo "error: could not find both workspaces by name. Check spelling." >&2
  exit 1
fi
echo "  staging:    $STAGING_WS_ID"
echo "  production: $PROD_WS_ID"

# ─── 2. Service account (idempotent) ──────────────────────────────────
echo
echo "─── 2/5  Service account ────────────────────────────────────────"
SAS_JSON=$(api GET /v1/organizations/service_accounts)
SA_ID=$(echo "$SAS_JSON" | jq -r --arg n "$SA_NAME" '.data[]? | select(.name==$n) | .id' | head -1)

if [[ -n "$SA_ID" ]]; then
  echo "  exists: $SA_ID"
else
  CREATE_SA=$(api POST /v1/organizations/service_accounts \
    "$(jq -n --arg n "$SA_NAME" '{name:$n}')")
  SA_ID=$(require_field "$CREATE_SA" id "service account create")
  echo "  created: $SA_ID"
fi

# Org UUID — needed for the WIF exchange call from CI. Anthropic exposes
# this on org-level admin endpoints. We pull it from the workspaces list,
# which carries `organization_id` on each entry.
ORG_ID=$(echo "$WORKSPACES_JSON" | jq -r '.data[0].organization_id // empty')
if [[ -z "$ORG_ID" ]]; then
  echo "warning: organization_id not present on workspace records — set vars.ANTHROPIC_ORGANIZATION_ID manually from Settings → Organization in the Console." >&2
fi

# ─── 3. OIDC issuer (idempotent) ──────────────────────────────────────
echo
echo "─── 3/5  GitHub Actions OIDC issuer ─────────────────────────────"
ISSUERS_JSON=$(api GET /v1/organizations/workload_identity/issuers)
ISSUER_ID=$(echo "$ISSUERS_JSON" | jq -r \
  --arg u "$GITHUB_OIDC_ISSUER_URL" \
  '.data[]? | select(.issuer_url==$u) | .id' | head -1)

if [[ -n "$ISSUER_ID" ]]; then
  echo "  exists: $ISSUER_ID"
else
  CREATE_ISSUER=$(api POST /v1/organizations/workload_identity/issuers \
    "$(jq -n \
      --arg name "github-actions" \
      --arg url "$GITHUB_OIDC_ISSUER_URL" \
      '{name:$name, issuer_url:$url, jwks_source:"discovery"}')")
  ISSUER_ID=$(require_field "$CREATE_ISSUER" id "issuer create")
  echo "  created: $ISSUER_ID"
fi

# ─── 4. Federation rules (one per workspace) ──────────────────────────
echo
echo "─── 4/5  Federation rules ───────────────────────────────────────"

create_rule() {
  # create_rule WORKSPACE_ID ENV_NAME SUBJECT_PREFIX
  local ws_id="$1" env="$2" subject_prefix="$3"
  local rule_name="gha-$env"
  local rules
  rules=$(api GET /v1/organizations/workload_identity/federation_rules)
  local existing
  existing=$(echo "$rules" | jq -r \
    --arg n "$rule_name" --arg ws "$ws_id" \
    '.data[]? | select(.name==$n and .workspace_id==$ws) | .id' | head -1)
  if [[ -n "$existing" ]]; then
    echo "  $env: exists ($existing)"
    echo "$existing"
    return
  fi
  local body
  body=$(jq -n \
    --arg name "$rule_name" \
    --arg issuer "$ISSUER_ID" \
    --arg sub "$subject_prefix" \
    --arg aud "https://api.anthropic.com" \
    --arg sa "$SA_ID" \
    --arg ws "$ws_id" \
    --arg scope "workspace:developer" \
    '{name:$name, issuer_id:$issuer, subject_prefix:$sub, audience:$aud,
      service_account_id:$sa, workspace_id:$ws,
      oauth_scope:$scope, token_lifetime_seconds:3600}')
  local created
  created=$(api POST /v1/organizations/workload_identity/federation_rules "$body")
  local id
  id=$(require_field "$created" id "federation rule create ($env)")
  echo "  $env: created ($id)"
  echo "$id"
}

# Staging matches every event from this repo (broad — convenient for the
# many workflows that hit staging). Production only matches deploys gated
# by the `production` GitHub Environment.
STAGING_RULE_ID=$(create_rule "$STAGING_WS_ID" "staging" \
  "repo:$GITHUB_REPO:" | tail -1)
PROD_RULE_ID=$(create_rule "$PROD_WS_ID" "production" \
  "repo:$GITHUB_REPO:environment:production" | tail -1)

# ─── 5. Print / apply GitHub vars ─────────────────────────────────────
echo
echo "─── 5/5  GitHub repo variables ──────────────────────────────────"
cat <<EOF

Set these in $GITHUB_REPO:

  Repo-level vars:
    ANTHROPIC_ORGANIZATION_ID    = ${ORG_ID:-<paste from Settings → Organization>}
    ANTHROPIC_SERVICE_ACCOUNT_ID = $SA_ID

  Environment 'staging' vars:
    ANTHROPIC_FEDERATION_RULE_ID = $STAGING_RULE_ID
    ANTHROPIC_WORKSPACE_ID       = $STAGING_WS_ID

  Environment 'production' vars:
    ANTHROPIC_FEDERATION_RULE_ID = $PROD_RULE_ID
    ANTHROPIC_WORKSPACE_ID       = $PROD_WS_ID

Commands to apply (gh CLI):

  gh variable set ANTHROPIC_ORGANIZATION_ID    --repo $GITHUB_REPO --body "$ORG_ID"
  gh variable set ANTHROPIC_SERVICE_ACCOUNT_ID --repo $GITHUB_REPO --body "$SA_ID"
  gh variable set ANTHROPIC_FEDERATION_RULE_ID --repo $GITHUB_REPO --env staging    --body "$STAGING_RULE_ID"
  gh variable set ANTHROPIC_WORKSPACE_ID       --repo $GITHUB_REPO --env staging    --body "$STAGING_WS_ID"
  gh variable set ANTHROPIC_FEDERATION_RULE_ID --repo $GITHUB_REPO --env production --body "$PROD_RULE_ID"
  gh variable set ANTHROPIC_WORKSPACE_ID       --repo $GITHUB_REPO --env production --body "$PROD_WS_ID"

EOF

if [[ "$HAS_GH" -eq 1 ]]; then
  read -r -p "Run those gh commands now? [y/N]: " run_gh
  if [[ "$run_gh" =~ ^[Yy]$ ]]; then
    [[ -n "${ORG_ID:-}" ]] && gh variable set ANTHROPIC_ORGANIZATION_ID --repo "$GITHUB_REPO" --body "$ORG_ID"
    gh variable set ANTHROPIC_SERVICE_ACCOUNT_ID --repo "$GITHUB_REPO" --body "$SA_ID"
    gh variable set ANTHROPIC_FEDERATION_RULE_ID --repo "$GITHUB_REPO" --env staging    --body "$STAGING_RULE_ID"
    gh variable set ANTHROPIC_WORKSPACE_ID       --repo "$GITHUB_REPO" --env staging    --body "$STAGING_WS_ID"
    gh variable set ANTHROPIC_FEDERATION_RULE_ID --repo "$GITHUB_REPO" --env production --body "$PROD_RULE_ID"
    gh variable set ANTHROPIC_WORKSPACE_ID       --repo "$GITHUB_REPO" --env production --body "$PROD_WS_ID"
    echo "✓ GitHub vars set."
  fi
else
  echo "(gh CLI not installed or not logged in — copy the commands above)"
fi

echo
echo "Done. Next: trigger a workflow (e.g. workflow_dispatch on the"
echo "Deploy workflow with environment=staging) to verify the token"
echo "exchange works. The Anthropic WIF step in the composite action"
echo "logs the JWT claims and exchange status to make 401s self-diagnosing."
