#!/usr/bin/env bash
# First-time server setup for the Captain STAGING stack.
#   sudo bash deploy/staging/setup.sh
# Installs Docker (Ubuntu/Debian) if missing, creates deploy/staging/.env with
# generated secrets (mode 600, never printed). Safe to run again.
. "$(dirname "$0")/lib.sh"

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  command -v apt-get >/dev/null 2>&1 || die "install Docker Engine + Compose v2 for this OS, then re-run"
  log "installing Docker from the distribution packages"
  apt-get update -qq
  apt-get install -y -qq docker.io docker-compose-v2 git openssl ca-certificates >/dev/null
  systemctl enable --now docker
fi
command -v openssl >/dev/null 2>&1 || die "openssl is required"

umask 077
if [ ! -f "$ENV_FILE" ]; then
  cp "$STAGING_DIR/env.example" "$ENV_FILE"
  log "created $ENV_FILE"
fi
chmod 600 "$ENV_FILE"
for name in POSTGRES_PASSWORD API_DB_PASSWORD AUTH_SECRET INTERNAL_API_TOKEN; do
  if grep -qE "^${name}=$" "$ENV_FILE"; then
    sed -i "s|^${name}=$|${name}=$(openssl rand -hex 32)|" "$ENV_FILE"
    log "generated $name"
  fi
done

missing=()
for name in ACME_EMAIL SMTP_USER SMTP_PASSWORD; do
  grep -qE "^${name}=.+" "$ENV_FILE" || missing+=("$name")
done
if [ ${#missing[@]} -gt 0 ]; then
  log "next: edit $ENV_FILE on this server and fill in: ${missing[*]}"
  log "      (e.g. sudo nano $ENV_FILE), then run: sudo bash deploy/staging/deploy.sh origin/<branch>"
else
  log "ready: sudo bash deploy/staging/deploy.sh origin/<branch>"
fi
