#!/bin/bash
# Agentus setup — install prerequisites and configure
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
DIM='\033[2m'
RESET='\033[0m'

ok()   { echo -e "  ${GREEN}✓${RESET} $1"; }
fail() { echo -e "  ${RED}✗${RESET} $1"; }
dim()  { echo -e "  ${DIM}$1${RESET}"; }

echo "Agentus setup"
echo ""

# --- Detect package manager ---

if command -v apt-get &>/dev/null; then
  PM="apt"
elif command -v brew &>/dev/null; then
  PM="brew"
elif command -v pacman &>/dev/null; then
  PM="pacman"
else
  PM=""
fi

install_pkg() {
  local name="$1"
  if [[ -n "$PM" ]]; then
    echo ""
    read -rp "  Install $name via $PM? [Y/n] " answer
    if [[ "${answer:-y}" =~ ^[Yy]$ ]]; then
      case "$PM" in
        apt)    sudo apt-get install -y "$name" ;;
        brew)   brew install "$name" ;;
        pacman) sudo pacman -S --noconfirm "$name" ;;
      esac
      return $?
    fi
  fi
  return 1
}

# --- Check prerequisites ---

echo "Checking prerequisites..."

MISSING=0

# Node.js
if command -v node &>/dev/null; then
  NODE_V=$(node -v | sed 's/v//')
  NODE_MAJOR=$(echo "$NODE_V" | cut -d. -f1)
  if [[ "$NODE_MAJOR" -ge 20 ]]; then
    ok "Node.js $NODE_V"
  else
    fail "Node.js $NODE_V (need 20+)"
    MISSING=1
  fi
else
  fail "Node.js not found"
  dim "Install: https://nodejs.org or nvm"
  MISSING=1
fi

# tmux
if command -v tmux &>/dev/null; then
  ok "tmux $(tmux -V | awk '{print $2}')"
else
  fail "tmux not found"
  install_pkg tmux || { dim "Install: apt install tmux / brew install tmux"; MISSING=1; }
fi

# yq
if command -v yq &>/dev/null; then
  ok "yq"
else
  fail "yq not found"
  install_pkg yq || { dim "Install: apt install yq / brew install yq"; MISSING=1; }
fi

# jq
if command -v jq &>/dev/null; then
  ok "jq"
else
  fail "jq not found"
  install_pkg jq || { dim "Install: apt install jq / brew install jq"; MISSING=1; }
fi

# Claude Code
if command -v claude &>/dev/null; then
  ok "Claude Code"
else
  fail "Claude Code not found"
  dim "Install: npm install -g @anthropic-ai/claude-code"
  MISSING=1
fi

if [[ "$MISSING" -gt 0 ]]; then
  echo ""
  echo "Install missing tools above, then re-run this script."
  exit 1
fi

# --- npm install ---

echo ""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

if [[ ! -d node_modules ]]; then
  echo "Installing npm dependencies..."
  npm install
else
  ok "npm dependencies"
fi

# --- Config files ---

echo ""
echo "Checking config..."

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo ""
  echo "  Created .env — add your DISCORD_TOKEN:"
  dim "  nano .env"
else
  ok ".env exists"
  if grep -q '^DISCORD_TOKEN=$' .env 2>/dev/null; then
    fail "DISCORD_TOKEN is empty in .env"
  else
    ok "DISCORD_TOKEN set"
  fi
fi

if [[ ! -f agents.yaml ]]; then
  cp agents.yaml.example agents.yaml
  echo ""
  echo "  Created agents.yaml — configure your agents:"
  dim "  nano agents.yaml"
else
  ok "agents.yaml exists"
fi

# --- Done ---

echo ""
echo -e "${GREEN}Ready!${RESET} Run: npm run dev"
