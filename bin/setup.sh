#!/bin/bash
# agentmux setup. Install prerequisites and configure.
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
DIM='\033[2m'
RESET='\033[0m'

ok()   { echo -e "  ${GREEN}✓${RESET} $1"; }
fail() { echo -e "  ${RED}✗${RESET} $1"; }
dim()  { echo -e "  ${DIM}$1${RESET}"; }

echo "agentmux setup"
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
  TMUX_V=$(tmux -V | awk '{print $2}')
  TMUX_MAJOR=$(printf '%s' "$TMUX_V" | sed -E 's/^([0-9]+).*/\1/')
  TMUX_MINOR=$(printf '%s' "$TMUX_V" | sed -E 's/^[0-9]+\.([0-9]+).*/\1/')
  if [[ "$TMUX_MAJOR" -gt 3 || ( "$TMUX_MAJOR" -eq 3 && "$TMUX_MINOR" -ge 2 ) ]]; then
    ok "tmux $TMUX_V"
  else
    fail "tmux $TMUX_V (need 3.2+ for safe bracketed paste)"
    MISSING=1
  fi
else
  fail "tmux not found"
  install_pkg tmux || { dim "Install: apt install tmux / brew install tmux"; MISSING=1; }
fi

# Coding engines. AMUX needs at least one, not one particular vendor.
ENGINES=()
command -v claude &>/dev/null && ENGINES+=("Claude Code")
command -v codex &>/dev/null && ENGINES+=("Codex")
if command -v kimi &>/dev/null || command -v kimi-code &>/dev/null \
  || [[ -x "$HOME/.kimi-code/bin/kimi" ]]; then
  ENGINES+=("Kimi Code")
fi
if [[ "${#ENGINES[@]}" -gt 0 ]]; then
  ok "Coding engine: $(IFS=', '; echo "${ENGINES[*]}")"
else
  fail "No supported coding-agent CLI found (Claude Code, Codex, or Kimi Code)"
  dim "Install at least one engine, then re-run setup"
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

CONFIG_HOME="${AMUX_CONFIG_HOME:-$HOME/.agentmux}"
ENV_FILE="${AMUX_DISCORD_ENV:-$CONFIG_HOME/.env}"
YAML_FILE="${AGENTMUX_YAML:-$CONFIG_HOME/agentmux.yaml}"
mkdir -p "$CONFIG_HOME"
chmod 700 "$CONFIG_HOME"

if [[ ! -f "$ENV_FILE" ]]; then
  mkdir -p "$(dirname "$ENV_FILE")"
  cp .env.example "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo ""
  echo "  Created $ENV_FILE. Add DISCORD_TOKEN if you want the Discord bridge:"
  dim "  nano $ENV_FILE"
else
  ok "$ENV_FILE exists"
  if grep -q '^DISCORD_TOKEN=$' "$ENV_FILE" 2>/dev/null; then
    dim "Discord bridge disabled (DISCORD_TOKEN is empty)"
  else
    ok "DISCORD_TOKEN set"
  fi
fi

if [[ ! -f "$YAML_FILE" ]]; then
  mkdir -p "$(dirname "$YAML_FILE")"
  cp agentmux.yaml.example "$YAML_FILE"
  chmod 600 "$YAML_FILE"
  echo ""
  echo "  Created $YAML_FILE, add your projects (and a server ID for Discord):"
  dim "  nano $YAML_FILE"
else
  ok "$YAML_FILE exists"
fi

# --- CLIs ---

echo ""
echo "Installing agentmux CLIs..."
if [[ "${AMUX_SETUP_SKIP_CLI_INSTALL:-0}" == "1" ]]; then
  dim "CLI install skipped by AMUX_SETUP_SKIP_CLI_INSTALL"
else
  MASTER_SHA="$(git rev-parse refs/remotes/origin/master)"
  if node bin/install-release.mjs --repo "$SCRIPT_DIR" --sha "$MASTER_SHA"; then
    ok "amux, ax, amux-suggest and overlap-gate CLIs from $MASTER_SHA"
  else
    fail "immutable agentmux release install failed"
    exit 1
  fi
fi

# --- Done ---

echo ""
echo -e "${GREEN}Ready!${RESET}"
echo "  1. Edit $YAML_FILE with your projects"
echo "  2. For Discord: add DISCORD_TOKEN and guild, then run npm run dev"
echo "  3. Type /sync in Discord to create channels"
echo "  4. Without Discord, use the installed amux CLI directly"
