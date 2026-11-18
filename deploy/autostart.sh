#!/bin/bash
# Lässt den Leitstand auf dem Mac (launchd) oder unter Linux (systemd --user) dauerhaft laufen: Start bei der Anmeldung, Neustart nach Absturz.
#   deploy/autostart.sh install     einrichten und starten
#   deploy/autostart.sh uninstall   stoppen und entfernen
set -euo pipefail

LABEL="de.leitstand.arbeit"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="gui/$(id -u)"

if [ "$(uname -s)" = Linux ]; then
  UNIT="$HOME/.config/systemd/user/leitstand-arbeit.service"
  case "${1:-}" in
    install)
      mkdir -p "$(dirname "$UNIT")"
      cat > "$UNIT" <<EOF
[Unit]
Description=Leitstand (Arbeitsversion)

[Service]
WorkingDirectory=$ROOT
ExecStart=$(command -v node) $ROOT/server.js
Environment=PATH=$(dirname "$(command -v copilot || echo /usr/local/bin/copilot)"):$(dirname "$(command -v node)"):/usr/local/bin:/usr/bin:/bin
Restart=always

[Install]
WantedBy=default.target
EOF
      systemctl --user daemon-reload && systemctl --user enable --now leitstand-arbeit
      echo "Leitstand läuft dauerhaft: http://127.0.0.1:4747" ;;
    uninstall) systemctl --user disable --now leitstand-arbeit || true; rm -f "$UNIT"; echo "Autostart entfernt." ;;
    *) echo "Aufruf: $0 install | uninstall" >&2; exit 2 ;;
  esac
  exit 0
fi

case "${1:-}" in
  install)
    NODE="$(command -v node)"
    COPILOT_DIR="$(dirname "$(command -v copilot || echo /usr/local/bin/copilot)")"
    mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/data"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$ROOT/server.js</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$COPILOT_DIR:$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$ROOT/data/leitstand.log</string>
  <key>StandardErrorPath</key><string>$ROOT/data/leitstand.log</string>
</dict>
</plist>
EOF
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "Leitstand läuft dauerhaft: http://127.0.0.1:4747 (Protokoll: $ROOT/data/leitstand.log)"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Autostart entfernt. Von Hand starten: npm start"
    ;;
  *)
    echo "Aufruf: $0 install | uninstall" >&2
    exit 2
    ;;
esac
