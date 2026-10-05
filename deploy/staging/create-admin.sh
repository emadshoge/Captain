#!/usr/bin/env bash
# Create the first staff administrator (there is no public staff sign-up).
#   sudo bash deploy/staging/create-admin.sh you@example.com "Your Name"
# They sign in at https://$STAFF_HOST with an email code, then enrol TOTP.
. "$(dirname "$0")/lib.sh"
email=${1:-}; name=${2:-}
[ -n "$email" ] && [ -n "$name" ] || die 'usage: create-admin.sh <email> "<name>"'
load_env
export CAPTAIN_TAG="$(current_tag)"
[ -n "$CAPTAIN_TAG" ] || die "deploy first (deploy.sh)"
compose run --rm staff create --email "$email" --name "$name" --role admin --reason "staging administrator (create-admin.sh)"
