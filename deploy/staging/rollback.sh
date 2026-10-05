#!/usr/bin/env bash
# Return to the previous release's images. Migrations are additive and stay
# applied (deployment §4), so no schema rollback is needed or attempted.
#   sudo bash deploy/staging/rollback.sh
. "$(dirname "$0")/lib.sh"
load_env
previous="$(cat "$STAGING_DIR/.release.previous" 2>/dev/null || true)"
[ -n "$previous" ] || die "no previous release recorded"
for image in api iot-gateway rider-web staff-web; do
  docker image inspect "captain-$image:$previous" >/dev/null 2>&1 || die "image captain-$image:$previous is missing"
done
current="$(current_tag)"
export CAPTAIN_TAG="$previous"
log "rolling back ${current:-?} -> $previous"
compose up -d --remove-orphans
wait_healthy api 36 || die "API not ready after rollback"
printf '%s\n' "$previous" > "$STAGING_DIR/.release"
[ -n "$current" ] && printf '%s\n' "$current" > "$STAGING_DIR/.release.previous"
printf '%s %s rollback\n' "$(date -u +%FT%TZ)" "$previous" >> "$STAGING_DIR/releases.log"
log "rolled back to $previous"
