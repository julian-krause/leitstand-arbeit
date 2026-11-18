#!/bin/bash
# Installiert, was die Agenten auf einem Mac oder unter Linux brauchen. Lässt sich gefahrlos wiederholen.
set -u
ok() { printf '  ✓ %s\n' "$1"; }
command -v node >/dev/null || { echo "Node 20+ fehlt: https://nodejs.org"; exit 1; }
command -v copilot >/dev/null || npm install -g @github/copilot; ok "GitHub Copilot CLI (danach einmal: copilot → /login)"
command -v agent-browser >/dev/null || npm install -g agent-browser; agent-browser install >/dev/null 2>&1; ok "agent-browser mit Chrome"
command -v uvx >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh; ok "uv/uvx (für Jira & Confluence: mcp-atlassian)"
if [ "$(uname -s)" = Darwin ]; then
  npx -y @steipete/peekaboo --version >/dev/null 2>&1 && ok "Peekaboo (Computer Use)"
  echo "  → Systemeinstellungen → Datenschutz & Sicherheit: Bildschirmaufnahme und Bedienungshilfen für dein Terminal (bzw. node) erlauben."
fi
echo "Fertig. Start: npm start → http://127.0.0.1:4747"
