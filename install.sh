#!/usr/bin/env bash
# Kompl one-line installer for Mac / Linux / WSL / Git Bash on Windows.
#
# Usage (the friendly path):
#   curl -fsSL https://raw.githubusercontent.com/tuirk/Kompl/main/install.sh | bash
#
# Usage (download and inspect first — recommended for security-conscious users):
#   curl -fsSLO https://raw.githubusercontent.com/tuirk/Kompl/main/install.sh
#   less install.sh
#   bash install.sh
#
# Optional argument: target directory name (defaults to "kompl"):
#   bash install.sh my-kompl

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BOLD='\033[1m'
RESET='\033[0m'

ok()   { printf "  ${GREEN}\xe2\x9c\x93${RESET} %s\n" "$1"; }
warn() { printf "  ${YELLOW}!${RESET} %s\n" "$1"; }
fail() { printf "  ${RED}\xe2\x9c\x97${RESET} %s\n" "$1"; exit 1; }

printf "\n${BOLD}Kompl — installer${RESET}\n\n"

# ── OS detect ───────────────────────────────────────────────────────────────
case "$(uname -s)" in
  Linux*)               OS=linux ;;
  Darwin*)              OS=mac ;;
  MINGW*|MSYS*|CYGWIN*) OS=windows-bash ;;
  *) fail "Unsupported OS: $(uname -s). Use install.ps1 on native Windows PowerShell." ;;
esac
ok "OS: $OS"

# ── Docker ──────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  case "$OS" in
    mac|windows-bash) fail "Docker not installed. Install Docker Desktop: https://www.docker.com/products/docker-desktop/" ;;
    linux)            fail "Docker not installed. Install Docker Engine + Compose plugin: https://docs.docker.com/engine/install/" ;;
  esac
fi
if ! docker info >/dev/null 2>&1; then
  fail "Docker is installed but not running. Start Docker Desktop (or 'sudo systemctl start docker' on Linux), then re-run."
fi
ok "Docker running"

if ! docker compose version >/dev/null 2>&1; then
  fail "Docker Compose v2 not available. Install the compose plugin: https://docs.docker.com/compose/install/"
fi
ok "Docker Compose v2"

# ── Node.js ─────────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  printf "\n"
  warn "Node.js not installed. Install Node 24 first:"
  case "$OS" in
    mac)          printf "    %s\n" "brew install node@24    # or download from https://nodejs.org/" ;;
    linux)        printf "    %s\n" "Use nvm (https://github.com/nvm-sh/nvm) and run: nvm install 24" ;;
    windows-bash) printf "    %s\n" "winget install OpenJS.NodeJS    # in PowerShell, or download https://nodejs.org/" ;;
  esac
  exit 1
fi

NODE_RAW=$(node --version)
NODE_MAJOR=$(printf "%s" "$NODE_RAW" | sed 's/v\([0-9]*\).*/\1/')
if [ "${NODE_MAJOR:-0}" -lt 24 ]; then
  fail "Node ≥ 24 required (you have $NODE_RAW). Upgrade via nvm or your installer, then re-run."
fi
ok "Node $NODE_RAW"

# ── Disk & RAM ──────────────────────────────────────────────────────────────
DISK_MB=$(df -m . 2>/dev/null | awk 'NR==2 {print $4}' || echo 0)
if [ -n "${DISK_MB:-}" ] && [ "$DISK_MB" -gt 0 ]; then
  if [ "$DISK_MB" -lt 5120 ]; then
    warn "Low disk space: $((DISK_MB / 1024)) GB free here. Recommended: 5 GB+ for Docker images."
  else
    ok "Disk: $((DISK_MB / 1024)) GB free"
  fi
fi

RAM_MB=0
case "$OS" in
  linux)
    RAM_MB=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
    ;;
  mac)
    RAM_MB=$(($(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1024 / 1024))
    ;;
esac
if [ "$RAM_MB" -gt 0 ]; then
  if [ "$RAM_MB" -lt 4096 ]; then
    warn "Low RAM: $((RAM_MB / 1024)) GB. Kompl needs ~4 GB; expect slowness or container OOMs."
  else
    ok "RAM: $((RAM_MB / 1024)) GB"
  fi
fi

# ── Clone ───────────────────────────────────────────────────────────────────
TARGET="${1:-kompl}"
if [ -e "$TARGET" ]; then
  fail "'$TARGET' already exists. Pass a different name: bash install.sh my-kompl"
fi

printf "\n  Cloning into ./%s ...\n" "$TARGET"
if ! git clone --depth=1 https://github.com/tuirk/Kompl.git "$TARGET" >/dev/null 2>&1; then
  fail "git clone failed. Is git installed? Network OK?"
fi
ok "Cloned"

# ── Hand off to setup.js ────────────────────────────────────────────────────
cd "$TARGET"
printf "\n  Handing off to setup.js (interactive — needs your Gemini + Firecrawl API keys and a deployment-mode choice).\n\n"
exec node setup.js
