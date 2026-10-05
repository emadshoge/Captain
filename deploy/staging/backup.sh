#!/usr/bin/env bash
# On-demand database backup (custom format, mode 600, last 14 kept).
#   sudo bash deploy/staging/backup.sh
# Restore drill: docs/runbooks.md R9 (always into a NEW database).
. "$(dirname "$0")/lib.sh"
load_env
export CAPTAIN_TAG="$(current_tag)"
[ -n "$CAPTAIN_TAG" ] || die "nothing deployed yet"
log "backup written: $(backup_database manual)"
