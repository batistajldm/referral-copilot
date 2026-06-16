#!/usr/bin/env bash
# Anti-cold-start warm-up for Referral Copilot.
# Pings all four auto-suspending resources so the first judge interaction is warm.
# Usage:  ./docs/warmup.sh        (run from the referral-copilot project root)
set -uo pipefail

PROFILE="${DATABRICKS_PROFILE:-DEFAULT}"
APP_URL="https://referral-copilot-2878696955147552.aws.databricksapps.com"
WAREHOUSE_ID="36fdbb817fccbd3b"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; }

echo "== Referral Copilot warm-up (profile: $PROFILE) =="

# Bearer token for the deployed app's API routes.
TOKEN="$(databricks auth token --profile "$PROFILE" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])' 2>/dev/null)"
if [ -z "${TOKEN:-}" ]; then
  fail "could not get auth token (check: databricks auth token --profile $PROFILE)"
fi

echo "[1/4] App compute (root)"
code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$APP_URL/")"
[ "$code" = "200" ] && ok "app responded 200" || warn "app returned HTTP $code (may still be waking)"

echo "[2/4] SQL Warehouse $WAREHOUSE_ID (SELECT 1)"
wh="$(databricks api post /api/2.0/sql/statements --profile "$PROFILE" \
  --json "{\"warehouse_id\":\"$WAREHOUSE_ID\",\"statement\":\"SELECT 1\",\"wait_timeout\":\"50s\"}" 2>/dev/null \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status",{}).get("state","?"))' 2>/dev/null)"
[ "$wh" = "SUCCEEDED" ] && ok "warehouse query SUCCEEDED (warm)" || warn "warehouse state: ${wh:-unknown}"

echo "[3/4] Model Serving (POST /api/parse-query)"
parse="$(curl -s -X POST "$APP_URL/api/parse-query" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"q":"dialysis near Jaipur"}' )"
echo "$parse" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("    ->",d)' 2>/dev/null \
  && ok "serving parsed query (warm)" || warn "parse response: $parse"

echo "[4/4] Lakebase (GET /api/shortlist)"
sl_code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$APP_URL/api/shortlist")"
[ "$sl_code" = "200" ] && ok "shortlist responded 200 (Lakebase warm)" || warn "shortlist HTTP $sl_code"

echo "== done. Re-run ~5 min before presenting. =="
