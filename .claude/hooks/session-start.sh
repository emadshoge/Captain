#!/usr/bin/env bash
# SessionStart hook: prepares Claude Code cloud sessions (synchronous).
set -euo pipefail

if [[ "${CLAUDE_CODE_REMOTE:-}" != "true" ]]; then
  exit 0
fi

if ! bash "$CLAUDE_PROJECT_DIR/scripts/cloud-setup.sh" >&2; then
  echo "Captain cloud setup failed. See the [cloud-setup] output above; fix and re-run: bash scripts/cloud-setup.sh" >&2
  exit 1
fi
