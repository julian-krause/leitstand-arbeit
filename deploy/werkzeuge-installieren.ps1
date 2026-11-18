# Installiert, was die Agenten unter Windows brauchen (PowerShell, ohne Admin). Gefahrlos wiederholbar.
$ErrorActionPreference = 'Continue'
function Ok($t) { Write-Host "  OK $t" -ForegroundColor Green }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host "Node 20+ fehlt: winget install OpenJS.NodeJS.LTS"; exit 1 }
if (-not (Get-Command copilot -ErrorAction SilentlyContinue)) { npm install -g @github/copilot }; Ok "GitHub Copilot CLI (danach einmal: copilot -> /login)"
if (-not (Get-Command agent-browser -ErrorAction SilentlyContinue)) { npm install -g agent-browser }; agent-browser install | Out-Null; Ok "agent-browser mit Chrome"
if (-not (Get-Command uvx -ErrorAction SilentlyContinue)) { powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex" }; Ok "uv/uvx (Jira & Confluence, Computer Use)"
Write-Host "Fertig. Start: deploy\start-windows.cmd -> http://127.0.0.1:4747"
