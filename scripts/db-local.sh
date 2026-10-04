#!/usr/bin/env bash
# Local, isolated PostgreSQL 16 cluster for development and tests in cloud
# sessions. Never touches any other server.
#
#   scripts/db-local.sh start    # idempotent: init if needed, start if stopped, wait until ready
#   scripts/db-local.sh stop
#   scripts/db-local.sh status
#   scripts/db-local.sh env      # print connection variables (no secrets: local trust auth)
#
# Settings (env): CAPTAIN_PG_DIR (default /var/tmp/captain-pg16),
# CAPTAIN_PG_PORT (default 54329), PG_BIN (default: auto-detect PostgreSQL 16).
set -euo pipefail

PG_DIR="${CAPTAIN_PG_DIR:-/var/tmp/captain-pg16}"
PG_PORT="${CAPTAIN_PG_PORT:-54329}"
PG_USER="captain"
DATA_DIR="$PG_DIR/data"
SOCKET_DIR="$PG_DIR/run"
LOG_FILE="$PG_DIR/postgres.log"
DATABASES=(captain_dev captain_test)
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { echo "[db-local] $*"; }
fail() { echo "[db-local] ERROR: $*" >&2; exit 1; }

case "${APP_ENV:-}" in
  staging | production) fail "refusing to run with APP_ENV=$APP_ENV (local development only)" ;;
esac

find_pg_bin() {
  if [[ -n "${PG_BIN:-}" ]]; then echo "$PG_BIN"; return; fi
  for dir in /usr/lib/postgresql/16/bin /usr/local/pgsql/bin; do
    [[ -x "$dir/postgres" ]] && { echo "$dir"; return; }
  done
  return 1
}
PG_BIN="$(find_pg_bin)" ||
  fail "PostgreSQL 16 server binaries not found. Install the 'postgresql-16' package (apt-get install -y postgresql-16) or set PG_BIN."
"$PG_BIN/postgres" --version | grep -q ' 16\.' ||
  fail "expected PostgreSQL 16 at $PG_BIN, found: $("$PG_BIN/postgres" --version)"

# Database files must live outside the repository (checked before creating anything).
PG_DIR_REAL="$(realpath -m "$PG_DIR")"
REPO_REAL="$(realpath "$REPO_ROOT")"
case "$PG_DIR_REAL/" in
  "$REPO_REAL"/*) fail "CAPTAIN_PG_DIR ($PG_DIR_REAL) must be outside the repository" ;;
esac
mkdir -p "$PG_DIR"

# PostgreSQL refuses to run as root. When root, run server tools as the
# 'postgres' OS user (created by the postgresql package).
if [[ "$(id -u)" == "0" ]]; then
  id postgres >/dev/null 2>&1 || fail "running as root but OS user 'postgres' does not exist"
  RUN_AS=(runuser -u postgres --)
  chown postgres:postgres "$PG_DIR"
else
  RUN_AS=()
fi
chmod 0755 "$PG_DIR"

pg() { "${RUN_AS[@]}" "$@"; }
is_running() { pg "$PG_BIN/pg_ctl" -D "$DATA_DIR" status >/dev/null 2>&1; }

wait_ready() {
  for _ in $(seq 1 30); do
    if "$PG_BIN/pg_isready" -q -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" -d postgres; then return 0; fi
    sleep 1
  done
  return 1
}

start() {
  if [[ ! -f "$DATA_DIR/PG_VERSION" ]]; then
    log "initializing cluster in $DATA_DIR"
    pg mkdir -p "$DATA_DIR" "$SOCKET_DIR"
    # trust auth is acceptable only because the server listens on 127.0.0.1
    # and a private socket directory inside this throwaway container.
    pg "$PG_BIN/initdb" -D "$DATA_DIR" -U "$PG_USER" --auth=trust --encoding=UTF8 \
      --locale=C.UTF-8 --no-instructions >"$PG_DIR/initdb.log" 2>&1 ||
      fail "initdb failed; see $PG_DIR/initdb.log"
  else
    log "reusing existing cluster in $DATA_DIR"
  fi
  pg mkdir -p "$SOCKET_DIR"

  if is_running; then
    log "server already running"
  else
    log "starting server on 127.0.0.1:$PG_PORT"
    if ! pg "$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" -w -t 30 \
      -o "-p $PG_PORT -k $SOCKET_DIR -c listen_addresses=127.0.0.1" start >/dev/null; then
      echo "---- last lines of $LOG_FILE ----" >&2
      tail -n 20 "$LOG_FILE" >&2 || true
      fail "server failed to start"
    fi
  fi

  wait_ready || fail "server not accepting connections on 127.0.0.1:$PG_PORT after 30s"

  for db in "${DATABASES[@]}"; do
    exists="$(psql -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" -d postgres -Atc \
      "select 1 from pg_database where datname = '$db'")"
    if [[ "$exists" != "1" ]]; then
      log "creating database $db"
      psql -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" -d postgres -qc "create database $db" >/dev/null
    fi
  done
  log "ready: $(psql -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" -d postgres -Atc 'show server_version')"
}

stop() {
  if is_running; then
    pg "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m fast -w stop >/dev/null
    log "stopped"
  else
    log "not running"
  fi
}

status() {
  if is_running && "$PG_BIN/pg_isready" -q -h 127.0.0.1 -p "$PG_PORT"; then
    log "running and ready on 127.0.0.1:$PG_PORT (data: $DATA_DIR)"
  else
    log "not running"
    return 3
  fi
}

print_env() {
  cat <<ENV
DATABASE_URL=postgres://$PG_USER@127.0.0.1:$PG_PORT/captain_dev
TEST_DATABASE_ADMIN_URL=postgres://$PG_USER@127.0.0.1:$PG_PORT/postgres
ENV
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  env) print_env ;;
  *) echo "usage: $0 {start|stop|status|env}" >&2; exit 2 ;;
esac
