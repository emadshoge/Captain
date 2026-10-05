# Shared helpers for the staging scripts. Never print secret values: only
# variable NAMES appear in messages.
set -euo pipefail

STAGING_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$STAGING_DIR/../.." && pwd)"
ENV_FILE="$STAGING_DIR/.env"
COMPOSE_FILE="$STAGING_DIR/compose.yaml"
BACKUP_DIR="$STAGING_DIR/backups"

log() { printf '[captain-staging] %s\n' "$*"; }
die() { printf '[captain-staging] ERROR: %s\n' "$*" >&2; exit 1; }

REQUIRED_VARS=(RIDER_HOST API_HOST STAFF_HOST ACME_EMAIL POSTGRES_PASSWORD API_DB_PASSWORD
  AUTH_SECRET INTERNAL_API_TOKEN SMTP_HOST SMTP_USER SMTP_PASSWORD EMAIL_FROM
  RIDE_BILLING_CUTOFF RIDE_END_CONFIRMATION RIDE_PARKING_POLICY)

load_env() {
  [ -f "$ENV_FILE" ] || die "missing $ENV_FILE — run setup.sh first"
  # Read KEY=VALUE lines literally (never `source`: values may contain
  # spaces, <, $ …). Surrounding single or double quotes are removed, as
  # Docker Compose does.
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || die "bad line in $ENV_FILE (expected KEY=VALUE)"
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then value=${BASH_REMATCH[1]}; fi
    export "$key=$value"
  done < "$ENV_FILE"
  local missing=()
  for name in "${REQUIRED_VARS[@]}"; do
    [ -n "${!name:-}" ] || missing+=("$name")
  done
  [ ${#missing[@]} -eq 0 ] || die "set these in $ENV_FILE: ${missing[*]}"
}

compose() {
  docker compose -p captain-staging -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

current_tag() { cat "$STAGING_DIR/.release" 2>/dev/null || true; }

wait_healthy() {
  local service=$1 tries=${2:-60} id status
  for _ in $(seq 1 "$tries"); do
    id="$(compose ps -q "$service")"
    status="$( [ -n "$id" ] && docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo starting)"
    [ "$status" = healthy ] && return 0
    sleep 5
  done
  return 1
}

backup_database() {
  local label=$1 file
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  file="$BACKUP_DIR/captain-$(date -u +%Y%m%dT%H%M%SZ)-$label.dump"
  compose exec -T postgres pg_dump -U captain_owner -d captain --format=custom > "$file"
  chmod 600 "$file"
  # Keep the 14 most recent backups.
  ls -1t "$BACKUP_DIR"/captain-*.dump 2>/dev/null | tail -n +15 | xargs -r rm -f --
  printf '%s' "$file"
}

# Release already-built images tagged $1 (label $2): database up, backup,
# migrations, runtime user, services up, readiness, release record.
# SERVICES (optional) limits which long-running services start.
release() {
  local previous
  export CAPTAIN_TAG="$1"
  compose up -d postgres
  wait_healthy postgres || die "postgres did not become healthy"

  if compose exec -T postgres psql -U captain_owner -d captain -tAc "select to_regclass('drizzle.__drizzle_migrations') is not null" | grep -q t; then
    log "backup before migrating: $(backup_database "pre-$1")"
  fi

  log "running migrations"
  compose run --rm migrate

  # Runtime login user: member of the least-privilege captain_app role. The
  # password is sent on stdin (not argv) and never printed.
  log "ensuring runtime database user"
  [[ "$API_DB_PASSWORD" =~ ^[A-Za-z0-9]+$ ]] || die "API_DB_PASSWORD must be letters/digits only"
  compose exec -T postgres psql -q -v ON_ERROR_STOP=1 -U captain_owner -d captain >/dev/null <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'captain_api') THEN
    CREATE ROLE captain_api LOGIN IN ROLE captain_app;
  END IF;
END \$\$;
ALTER ROLE captain_api WITH LOGIN PASSWORD '$API_DB_PASSWORD';
GRANT captain_app TO captain_api;
SQL

  previous="$(current_tag)"
  log "starting services"
  # shellcheck disable=SC2086 # SERVICES is a space-separated list
  compose up -d --remove-orphans ${SERVICES:-}
  wait_healthy api 36 || { compose logs --tail=50 api; die "API not ready; previous release: ${previous:-none} (rollback.sh)"; }
  [ -n "$previous" ] && [ "$previous" != "$1" ] && printf '%s\n' "$previous" > "$STAGING_DIR/.release.previous"
  printf '%s\n' "$1" > "$STAGING_DIR/.release"
  printf '%s %s %s\n' "$(date -u +%FT%TZ)" "$1" "$2" >> "$STAGING_DIR/releases.log"
}
