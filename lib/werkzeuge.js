// Werkzeuge der Agenten auf diesem Rechner: Browser (agent-browser), Computer Use (MCP),
// Jira und Confluence (MCP mcp-atlassian) und der Zugriff auf Laufwerke.
// Liefert für einen Lauf die Copilot-Argumente, die Umgebung und die Zeilen für den Prompt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { state, secrets, DATA_DIR } from './store.js';

const PLATFORM = process.platform;

// Ist ein Programm im PATH? (für Hinweise im Prompt und in `leitstand wer`)
const seen = new Map();
export function hasCommand(name) {
  if (seen.has(name)) return seen.get(name);
  let ok = false;
  try {
    execFileSync(PLATFORM === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore', timeout: 5000 });
    ok = true;
  } catch {}
  seen.set(name, ok);
  setTimeout(() => seen.delete(name), 60_000).unref();
  return ok;
}

// ---------- Laufwerk ----------

export const diskRoots = () =>
  (state.settings.disk?.roots || []).map((r) => String(r).trim()).filter(Boolean);

// Orte für die Dateiansicht neben den Projektordnern: bei vollem Zugriff der Home-Ordner, dazu
// die freigegebenen Laufwerke und Ordner.
export function drives() {
  const list = [...(state.settings.disk?.full !== false ? [os.homedir()] : []), ...diskRoots()];
  return [...new Set(list)].filter((d) => fs.existsSync(d)).map((dir, i) => ({
    id: `laufwerk-${i}`,
    name: dir === os.homedir() ? `Persönlicher Ordner (${dir})` : `Laufwerk ${dir}`,
    dir,
    machineId: 'lokal',
    drive: true,
  }));
}
export const findDrive = (id) => drives().find((d) => d.id === id);

export function addDriveRoots(list) {
  return [...new Set(list.map((r) => String(r).trim()).filter(Boolean))].slice(0, 30);
}

// ---------- Jira und Confluence ----------

const atl = () => state.settings.atlassian || {};
export const atlassianReady = () => Boolean((atl().jiraUrl && secrets.atlassian?.jiraToken) || (atl().confluenceUrl && secrets.atlassian?.confluenceToken));

function atlassianServer() {
  const a = atl();
  const t = secrets.atlassian || {};
  const env = {};
  // Cloud (*.atlassian.net): Benutzer (Mail) + API-Token. Server/Data Center: persönliches Token.
  const cloud = (url) => /\.atlassian\.net/i.test(url) || Boolean(a.user);
  if (a.jiraUrl && t.jiraToken) {
    env.JIRA_URL = a.jiraUrl;
    if (cloud(a.jiraUrl)) Object.assign(env, { JIRA_USERNAME: a.user, JIRA_API_TOKEN: t.jiraToken });
    else env.JIRA_PERSONAL_TOKEN = t.jiraToken;
    if (a.sslVerify === false) env.JIRA_SSL_VERIFY = 'false';
  }
  if (a.confluenceUrl && t.confluenceToken) {
    env.CONFLUENCE_URL = a.confluenceUrl;
    if (cloud(a.confluenceUrl)) Object.assign(env, { CONFLUENCE_USERNAME: a.user, CONFLUENCE_API_TOKEN: t.confluenceToken });
    else env.CONFLUENCE_PERSONAL_TOKEN = t.confluenceToken;
    if (a.sslVerify === false) env.CONFLUENCE_SSL_VERIFY = 'false';
  }
  if (a.readOnly) env.READ_ONLY_MODE = 'true';
  // Firmenproxy durchreichen
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']) if (process.env[k]) env[k] = process.env[k];
  // uvx bevorzugt, sonst Docker
  if (hasCommand('uvx') || !hasCommand('docker')) {
    return { type: 'local', command: 'uvx', args: ['mcp-atlassian'], env, tools: ['*'] };
  }
  return {
    type: 'local',
    command: 'docker',
    args: ['run', '-i', '--rm', ...Object.keys(env).flatMap((k) => ['-e', k]), 'ghcr.io/sooperset/mcp-atlassian:latest'],
    env,
    tools: ['*'],
  };
}

// ---------- Computer Use ----------

function computerUseServer() {
  if (PLATFORM === 'darwin') {
    // Peekaboo: Bildschirm sehen, klicken, tippen, Programme und Fenster steuern. Die Rechte
    // (Bildschirmaufnahme, Bedienungshilfen) bekommt das Terminal bzw. Node, das den Leitstand startet.
    return { name: 'peekaboo', server: { type: 'local', command: 'npx', args: ['-y', '@steipete/peekaboo', 'mcp'], tools: ['*'] } };
  }
  if (PLATFORM === 'win32') {
    // Windows-MCP: Bildschirmzustand, Klicks, Tastatur, Fenster, PowerShell.
    return { name: 'windows', server: { type: 'local', command: 'uvx', args: ['windows-mcp'], tools: ['*'] } };
  }
  return null;
}

// ---------- Lauf ----------

export function runTools(project, chat, dir) {
  const id = project.identity || {};
  const args = [];
  const env = {};
  const allow = [];
  const prompt = [];
  const servers = {};

  // Laufwerk
  if (state.settings.disk?.full !== false) args.push('--allow-all-paths');
  for (const root of diskRoots().filter((r) => fs.existsSync(r))) args.push('--add-dir', root);
  prompt.push(
    '',
    'Laufwerk:',
    state.settings.disk?.full !== false
      ? `- Du hast Zugriff auf das ganze Laufwerk dieses Rechners (Home-Ordner: ${os.homedir()}), nicht nur auf den Projektordner. Lies, was der Auftrag braucht. Ändern, verschieben oder löschen außerhalb des Projektordners nur, wenn der Auftrag das ausdrücklich verlangt; Dateien des Menschen überschreibst du nie ohne Rückfrage, leg stattdessen eine Kopie an.`
      : '- Du arbeitest im Projektordner und im gemeinsamen Kontext.',
    ...(diskRoots().length ? [`- Freigegebene Laufwerke und Ordner: ${diskRoots().join(', ')}.`] : []),
  );

  // Browser
  if (id.browser) {
    const mode = state.settings.browser?.mode || 'eigen';
    env.AGENT_BROWSER_SESSION = `chat-${chat.id}`;
    if (mode === 'chrome') {
      env.AGENT_BROWSER_AUTO_CONNECT = '1';
    } else {
      if (state.settings.browser?.headed !== false) env.AGENT_BROWSER_HEADED = '1';
      // Cookies und Anmeldungen bleiben je Projekt erhalten.
      env.AGENT_BROWSER_RESTORE = `leitstand-${project.id}`;
    }
    env.AGENT_BROWSER_USE_SYSTEM_CA = '1';
    env.AGENT_BROWSER_DOWNLOAD_PATH = path.join(project.dir, 'downloads');
    allow.push('shell(agent-browser:*)');
    prompt.push(
      '',
      'Browser:',
      hasCommand('agent-browser')
        ? '- Du hast einen eigenen Browser: das Kommando `agent-browser` (`agent-browser open URL`, `snapshot -i`, `click @ref`, `fill @ref TEXT`, `get text @ref`, `screenshot`, `close`). Lies vor dem ersten Einsatz `agent-browser skills get core`. Nutze ihn für Intranet, Weboberflächen ohne Schnittstelle, Formulare und Recherche, ohne vorher zu fragen. Zugangsdaten holst du aus dem Tresor.'
        : '- Der Browser `agent-browser` ist auf diesem Rechner nicht installiert. Braucht der Auftrag ihn, sag dem Menschen: `npm install -g agent-browser && agent-browser install`.',
      mode === 'chrome'
        ? '- Der Browser ist der laufende Chrome des Menschen, mit seinen Anmeldungen (Firmen-SSO). Öffne eigene Tabs, schließ keine fremden und tipp nie in Tabs, die du nicht selbst geöffnet hast.'
        : '- Das Fenster ist für den Menschen sichtbar, Anmeldungen bleiben für dieses Projekt gespeichert. Muss er selbst etwas tun (Anmeldung mit seinem Konto, Zwei-Faktor, Captcha), lass die Seite offen und frag mit zustand: blockiert, was genau er im Fenster tun soll.',
      `- Downloads landen in ${path.join(project.dir, 'downloads')}.`,
    );
  }

  // Computer Use
  if (id.computerUse) {
    const cu = computerUseServer();
    if (cu) {
      servers[cu.name] = cu.server;
      allow.push(cu.name);
      prompt.push(
        '',
        'Computer Use (dieser Rechner):',
        `- Du bedienst den Rechner über die MCP-Werkzeuge des Servers „${cu.name}“: Bildschirm und Fenster ansehen, klicken, tippen, Tasten, Programme starten und wechseln. Sieh dir zuerst den Bildschirm an und nutz die Element-IDs daraus.`,
        '- Nimm für Websites zuerst den Browser, für Mails, Termine, Teams und Dateien in Microsoft 365 die `leitstand`-Kommandos. Computer Use ist für Programme ohne Schnittstelle (Desktop-Anwendungen, Fachsoftware, Excel-Makros, Dialoge).',
        '- Der Mensch arbeitet vielleicht gerade am Rechner. Schließ keine Fenster und Programme, die du nicht selbst geöffnet hast, und tipp nie in ein Fenster, von dem du nicht sicher bist, dass es das richtige ist.',
        PLATFORM === 'darwin' ? '- Fehlt eine Berechtigung (Bildschirmaufnahme, Bedienungshilfen), melde „blockiert“ und sag, für welches Programm sie in den Systemeinstellungen fehlt.' : '- Klappt ein Werkzeug nicht (uvx fehlt, Sitzung gesperrt), melde „blockiert“ mit genau dem, was fehlt.',
      );
    } else {
      prompt.push('', 'Computer Use:', '- Auf diesem Betriebssystem gibt es kein Computer Use; nimm den Browser oder Befehle.');
    }
  }

  // Jira und Confluence
  if (id.atlassian) {
    if (atlassianReady()) {
      servers.atlassian = atlassianServer();
      allow.push('atlassian');
      const a = atl();
      prompt.push(
        '',
        'Jira und Confluence:',
        `- Über die MCP-Werkzeuge des Servers „atlassian“ (jira_*, confluence_*) arbeitest du direkt in ${[a.jiraUrl && `Jira (${a.jiraUrl})`, a.confluenceUrl && `Confluence (${a.confluenceUrl})`].filter(Boolean).join(' und ')}: suchen (JQL, CQL), Vorgänge und Seiten lesen${a.readOnly ? ' (nur lesend eingestellt)' : ', Vorgänge anlegen und ändern, kommentieren, Status wechseln, Seiten anlegen und ändern'}.`,
        ...(a.readOnly ? [] : ['- Was andere sehen (neue Vorgänge, Kommentare, Statuswechsel, veröffentlichte Seiten), machst du, wenn der Auftrag es verlangt. Bei Unklarem legst du einen Entwurf im Projektordner an und fragst mit zustand: entscheidung.']),
      );
    } else {
      prompt.push('', 'Jira und Confluence:', '- Noch nicht eingerichtet. Braucht der Auftrag sie, sag dem Menschen: Reiter „Einstellungen“, Abschnitt Jira & Confluence (Adresse und Token).');
    }
  }

  if (Object.keys(servers).length) {
    const file = path.join(dir, 'mcp.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 1), { mode: 0o600 });
    args.push('--additional-mcp-config', `@${file}`);
  }
  return { args, env, allow, prompt: prompt.join('\n') };
}

// Für `leitstand wer` und die Oberfläche: was auf diesem Rechner bereitsteht.
export function toolStatus() {
  return {
    platform: PLATFORM,
    copilot: hasCommand(process.env.LEITSTAND_COPILOT || 'copilot'),
    agentBrowser: hasCommand('agent-browser'),
    uvx: hasCommand('uvx'),
    npx: hasCommand('npx'),
    docker: hasCommand('docker'),
    computerUse: PLATFORM === 'darwin' ? 'peekaboo' : PLATFORM === 'win32' ? 'windows-mcp' : '',
    atlassian: atlassianReady(),
  };
}

export const DATA = DATA_DIR;
