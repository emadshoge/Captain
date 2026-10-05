#!/usr/bin/env bash
# Build and release a git ref to the Captain STAGING stack.
#   sudo bash deploy/staging/deploy.sh origin/claude/rider-ui-design
# Steps: fetch + check out the ref (detached), build the four images tagged
# with the commit, back up the database, run migrations, (re)create the
# runtime database user, start/replace all services, check readiness.
. "$(dirname "$0")/lib.sh"

# The whole body is a function so bash has parsed it completely before the
# checkout below can replace this file on disk.
main() {
  ref=${1:-}
  [ -n "$ref" ] || die "usage: deploy.sh <git ref>, e.g. origin/claude/rider-ui-design"
  load_env

  cd "$REPO_DIR"
  [ -z "$(git status --porcelain --untracked-files=no)" ] || die "the server checkout has local changes; refusing to deploy"
  log "fetching from origin"
  git fetch --quiet origin
  sha="$(git rev-parse --verify "$ref^{commit}")" || die "unknown ref: $ref"
  git cat-file -e "$sha:deploy/staging/compose.yaml" 2>/dev/null ||
    die "$ref does not contain deploy/staging (it predates the staging kit); deploy a ref that includes it"
  tag="${sha:0:12}"
  # Keep running this script's own version even if the ref changes it.
  git -c advice.detachedHead=false checkout --quiet --detach "$sha"
  log "deploying $ref ($tag)"

  log "building images (first build takes several minutes)"
  docker build -q -f docker/node-service.Dockerfile --build-arg APP=api -t "captain-api:$tag" . >/dev/null
  docker build -q -f docker/node-service.Dockerfile --build-arg APP=iot-gateway -t "captain-iot-gateway:$tag" . >/dev/null
  for app in rider-web staff-web; do
    docker build -q -f docker/web.Dockerfile --build-arg APP="$app" \
      --build-arg NEXT_PUBLIC_API_URL="https://$API_HOST" -t "captain-$app:$tag" . >/dev/null
  done

  release "$tag" "$ref"

  if curl -fsS -o /dev/null --max-time 20 "https://$API_HOST/ready"; then
    log "public check ok: https://$API_HOST/ready"
  else
    log "warning: https://$API_HOST/ready not reachable yet (DNS or certificate still pending?)"
  fi
  log "released $tag — rider: https://$RIDER_HOST  staff: https://$STAFF_HOST"
}

main "$@"
