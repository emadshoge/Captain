#!/usr/bin/env bash
# Reproducible setup for Claude Code cloud sessions (also safe to run by hand).
#   1. verify Node.js and pnpm versions
#   2. install dependencies exactly from pnpm-lock.yaml
#   3. start the isolated local PostgreSQL 16 cluster and wait until ready
#   4. apply migrations + labelled dev fixtures to the LOCAL development database only
#   5. export session variables (when run from the SessionStart hook)
# Idempotent: re-running reuses the cluster and installed packages.
# Never seeds, resets or migrates any non-local database.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

step=""
on_error() {
  local code=$?
  echo "[cloud-setup] FAILED during step: ${step:-unknown} (exit $code)" >&2
  echo "[cloud-setup] Re-run with: bash scripts/cloud-setup.sh" >&2
  exit "$code"
}
trap on_error ERR
run_step() { step="$1"; echo "[cloud-setup] ==> $1"; }

run_step "safety checks"
case "${APP_ENV:-}" in
  staging | production)
    echo "[cloud-setup] refusing to run with APP_ENV=$APP_ENV" >&2
    exit 1
    ;;
esac

run_step "toolchain versions"
required_node="22.12.0"
node_version="$(node -p 'process.versions.node')"
node -e "
  const [a,b,c]=process.versions.node.split('.').map(Number);
  const [x,y,z]='$required_node'.split('.').map(Number);
  const ok = a===x ? (b>y || (b===y && c>=z)) : false;
  process.exit(ok ? 0 : 1);
" || { echo "[cloud-setup] Node.js 22 (>= $required_node) required, found $node_version" >&2; false; }
required_pnpm="$(node -p "require('./package.json').packageManager.split('@')[1]")"
if ! command -v pnpm >/dev/null || [[ "$(pnpm --version)" != "$required_pnpm" ]]; then
  echo "[cloud-setup] pnpm $required_pnpm required; activating via corepack"
  corepack enable >/dev/null 2>&1 || true
  corepack prepare "pnpm@$required_pnpm" --activate
fi
echo "[cloud-setup] node $node_version, pnpm $(pnpm --version)"

run_step "install dependencies from lockfile"
pnpm install --frozen-lockfile --prefer-offline

run_step "start local PostgreSQL 16"
bash scripts/db-local.sh start

run_step "migrate local development database"
# Built from the local cluster's settings, never from an inherited DATABASE_URL.
local_db_url="$(bash scripts/db-local.sh env | sed -n 's/^DATABASE_URL=//p')"
APP_ENV=development DATABASE_URL="$local_db_url" pnpm --silent --filter @captain/db run db:migrate

run_step "load development fixtures (local dev database only)"
# Labelled DEV FIXTURE data + simulated scooters; refuses non-development envs.
APP_ENV=development DATABASE_URL="$local_db_url" pnpm --silent --filter @captain/db run db:fixtures

run_step "export session environment"
if [[ -n "${CLAUDE_ENV_FILE:-}" ]]; then
  {
    echo "export APP_ENV=development"
    bash scripts/db-local.sh env | sed 's/^/export /'
    # Development-only simulated providers (refused in production by the config guard).
    echo "export OTP_SMS_PROVIDER=log_only"
    echo "export OTP_EMAIL_PROVIDER=log_only"
    echo "export COOKIE_SECURE=false"
    echo "export STAFF_MFA_REQUIRED=false"
    echo "export NEXT_TELEMETRY_DISABLED=1"
    echo "export EXPO_NO_TELEMETRY=1"
  } >>"$CLAUDE_ENV_FILE"
  echo "[cloud-setup] wrote session variables to CLAUDE_ENV_FILE"
fi

step=""
echo "[cloud-setup] OK"
