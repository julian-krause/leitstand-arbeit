@echo off
rem Startet den Leitstand unter Windows. Voraussetzung: Node 20+ und GitHub Copilot CLI (npm install -g @github/copilot), einmal "copilot" starten und /login.
cd /d "%~dp0.."
node server.js
