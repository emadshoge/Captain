#!/usr/bin/env bash
# CI smoke test of this kit with images already built and tagged $1 (e.g.
# "ci"): validates the Caddyfile (no certificates requested), then runs the
# real release() from lib.sh against the compose stack without Caddy and
# checks the API, worker and gateway. Uses throwaway generated secrets.
#   bash deploy/staging/ci-smoke.sh ci
. "$(dirname "$0")/lib.sh"
tag=${1:?image tag}
[ ! -f "$ENV_FILE" ] || die "$ENV_FILE exists; refusing to overwrite (CI only)"

umask 077
# Only now (the file did not exist before) is it safe to delete it on exit.
trap 'compose down -v --remove-orphans >/dev/null 2>&1 || true; rm -f "$ENV_FILE" "$STAGING_DIR"/.release* "$STAGING_DIR/releases.log"' EXIT
sed -e 's/^RIDER_HOST=.*/RIDER_HOST=rider.ci.invalid/' \
  -e 's/^API_HOST=.*/API_HOST=api.ci.invalid/' \
  -e 's/^STAFF_HOST=.*/STAFF_HOST=staff.ci.invalid/' \
  -e 's/^ACME_EMAIL=$/ACME_EMAIL=ci@example.invalid/' \
  -e 's/^SMTP_HOST=.*/SMTP_HOST=smtp.ci.invalid/' \
  -e 's/^SMTP_USER=$/SMTP_USER=ci/' -e 's/^SMTP_PASSWORD=$/SMTP_PASSWORD=ci/' \
  "$STAGING_DIR/env.example" > "$ENV_FILE"
for name in POSTGRES_PASSWORD API_DB_PASSWORD AUTH_SECRET INTERNAL_API_TOKEN; do
  sed -i "s|^${name}=$|${name}=$(openssl rand -hex 32)|" "$ENV_FILE"
done
load_env

for f in "$STAGING_DIR"/*.sh; do bash -n "$f"; done
docker run --rm -e RIDER_HOST -e API_HOST -e STAFF_HOST -e ACME_EMAIL \
  -v "$STAGING_DIR/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2 \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
log "Caddyfile valid"

SERVICES="api worker gateway rider-web staff-web" release "$tag" ci
# Second release of the same tag: exercises the backup-before-migrate path.
SERVICES="api worker gateway rider-web staff-web" release "$tag" ci-again
ls "$BACKUP_DIR"/captain-*-pre-"$tag".dump >/dev/null || die "no pre-migration backup"
log "pre-migration backup written"

for service in worker gateway rider-web staff-web; do
  [ "$(docker inspect -f '{{.State.Running}}' "$(compose ps -q "$service")")" = true ] || {
    compose logs --tail=50 "$service"
    die "$service is not running"
  }
done
compose exec -T api node -e "fetch('http://127.0.0.1:3000/ready').then(async r=>{console.log(await r.text());process.exit(r.ok?0:1)})"
compose exec -T postgres psql -U captain_owner -d captain -tAc \
  "select pg_has_role('captain_api','captain_app','member') and not rolsuper from pg_roles where rolname='captain_api'" | grep -q t ||
  die "captain_api is not a plain captain_app member"
# The gateway authenticates to the API with the internal token.
sleep 5
compose logs gateway 2>&1 | grep -qiE '401|unauthor' && die "gateway is not authorised"
rm -rf "$BACKUP_DIR"
log "staging kit smoke test passed"
