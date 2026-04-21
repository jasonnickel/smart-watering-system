#!/usr/bin/env bash
# Taproot - Auto Update from GitHub main
# Runs on a systemd timer (taproot-update.timer). Polls origin, pulls if
# behind, runs npm install if dependencies changed, restarts services whose
# source files changed. Safe to re-run; no-op when already current.
#
# Log to journal via systemd; no extra log file.

set -euo pipefail

readonly REPO_DIR="${TAPROOT_REPO_DIR:-/opt/smart-water}"
readonly BRANCH="${TAPROOT_BRANCH:-main}"

cd "$REPO_DIR"

git fetch origin "$BRANCH" --quiet

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

echo "taproot-update: pulling $LOCAL -> $REMOTE"

# What changed?
CHANGED=$(git diff --name-only "$LOCAL" "$REMOTE" || true)

# Fast-forward only; refuse if the branch has diverged locally
if ! git pull --ff-only origin "$BRANCH"; then
  echo "taproot-update: ff-only pull failed - local branch diverged. Manual fix needed." >&2
  exit 1
fi

# Install deps if package.json or lockfile changed
if echo "$CHANGED" | grep -qE '^(package\.json|package-lock\.json)$'; then
  echo "taproot-update: dependencies changed - reinstalling"
  npm install --production --silent
fi

# Restart the web service when its sources (routes, pages, static assets)
# or shared libraries change. Decision cycles run via systemd timer so they
# don't need restarting; they'll pick up new code on the next fire.
if echo "$CHANGED" | grep -qE '^(src/web/|src/public/|src/charts\.js|src/config\.js|src/db/|src/api/|src/core/|src/ai/|src/web-runtime\.js|src/env\.js|src/log\.js|src/time\.js|src/paths\.js|src/summary\.js|src/status-page\.js)'; then
  echo "taproot-update: restarting taproot-web.service"
  systemctl restart taproot-web.service || true
fi

echo "taproot-update: now at $(git rev-parse --short HEAD)"
