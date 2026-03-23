#!/usr/bin/env bash
set -euo pipefail

# Taproot - Deployment Script
# Run on the homelab server to install systemd units and set up the environment.
#
# Usage: ./install.sh [--dry-run]

readonly DRY_RUN="${1:-}"
readonly SERVICE_DIR="/etc/systemd/system"
readonly SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
readonly PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
readonly ENV_DIR="$HOME/.taproot"

log() { echo "[taproot-install] $1"; }

run() {
  if [[ "$DRY_RUN" == "--dry-run" ]]; then
    log "DRY RUN: $*"
  else
    "$@"
  fi
}

# Create .env directory
if [[ ! -d "$ENV_DIR" ]]; then
  log "Creating $ENV_DIR"
  run mkdir -p "$ENV_DIR"
fi

if [[ ! -f "$ENV_DIR/.env" ]]; then
  log "Copying .env.example to $ENV_DIR/.env - EDIT THIS FILE WITH YOUR API KEYS"
  run cp "$PROJECT_DIR/.env.example" "$ENV_DIR/.env"
  run chmod 600 "$ENV_DIR/.env"
fi

# Install Node.js dependencies
log "Installing Node.js dependencies"
run npm --prefix "$PROJECT_DIR" install --production

# Copy systemd units
log "Installing systemd units"
for unit in \
  smart-water.service \
  smart-water.timer \
  smart-water-watchdog.service \
  smart-water-watchdog.timer \
  smart-water-summary.service \
  smart-water-summary.timer
do
  run sudo cp "$SCRIPT_DIR/$unit" "$SERVICE_DIR/$unit"
done

# Reload and enable timers
log "Enabling systemd timers"
run sudo systemctl daemon-reload
run sudo systemctl enable --now smart-water.timer
run sudo systemctl enable --now smart-water-watchdog.timer
run sudo systemctl enable --now smart-water-summary.timer

log "Installation complete!"
log ""
log "Next steps:"
log "  1. Edit $ENV_DIR/.env with your API keys"
log "  2. Test: node $PROJECT_DIR/src/cli.js run --shadow"
log "  3. Check status: node $PROJECT_DIR/src/cli.js status"
log "  4. View irrigation logs: journalctl -u smart-water -f"
log "  5. View summary logs: journalctl -u smart-water-summary -f"
log "  6. When ready, remove SHADOW_MODE=true from .env"
