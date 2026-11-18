// Leitstand: führt viele Claude-Code-Agenten über eine Oberfläche statt über Terminals.
// Keine Abhängigkeiten. Start: node server.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {
  state, secrets, ROOT, DATA_DIR, CONTEXT_DIR, PORT, AGENT_PORT, publicState, saveNow, saveSecrets, changed, chatChanged,
  addClient, id, findChat, findProject, findMachine, httpError, readRaw,
} from './lib/store.js';
import {
  removeFinishedChildren, removeChild, pickModel,
  sendMessage, stopRun, stopAll, newChat, pump, interruptRun,
} from './lib/runs.js';
import { MEETING_PREFIX } from './lib/agent.js';
import { listPages, readPage, writePage } from './lib/pages.js';
import { agentApi, decideVaultRequest } from './lib/identity.js';
import { loginState, startLogin, logout, decideFreigabe } from './lib/m365.js';
import { loginById, createLogin, updateLogin, deleteLogin, totpCode } from './lib/vault.js';
import { overview, listDir, resolveInProject, FILE_TYPES } from './lib/files.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
const HOST = '127.0.0.1';
const SNOOZE_MS = 60 * 60 * 1000;
const MODES = ['selbststaendig', 'vorsichtig', 'autonom'];
// Modell und Aufwand: Namen wie bei `copilot --model`; leer heißt Vorgabe.
const choiceOf = (body) => {
  try {
    return pickModel({ model: body.model, effort: body.effort });
  } catch {
    return {};
  }
};

// ---------- Aktionen aus der Warteschlange ----------

function chatAction(chat, body) {
  const attention = chat.attention || {};
  switch (body.action) {
    case 'approve': {
      const option = typeof body.option === 'string' ? body.option.trim() : '';
      sendMessage(
        chat,
        option ? `Entscheidung: ${option}. Setz das um.` : 'Freigegeben. Mach mit dem nächsten Schritt weiter.',
        option ? `Entscheidung: ${option}` : 'Freigegeben',
      );
      return;
    }
    case 'allow': {
      const project = findProject(chat.projectId);
      const requests = attention.requests || [];
      if (project.mode === 'vorsichtig') {
        // Im vorsichtigen Modus gilt die Erlaubnis ab dann für das ganze Projekt.
        const patterns = requests.flatMap((r) => r.patterns);
        project.allow = [...new Set([...(project.allow || []), ...patterns])];
        changed('projects');
        sendMessage(
          chat,
          `Die Erlaubnis ist erteilt (${patterns.join(', ')}). Führ den abgelehnten Schritt jetzt aus und mach weiter.`,
          `Erlaubt: ${patterns.join(', ')}`,
        );
      } else {
        // Sonst gilt sie genau für diese Schritte in diesem Chat.
        const list = requests.map((r) => `- ${r.tool}${r.detail ? `: ${r.detail}` : ''}`).join('\n');
        sendMessage(
          chat,
          `Ich gebe genau diese Schritte ausdrücklich frei:\n${list}\nFühr sie jetzt aus und mach weiter.`,
          `Freigegeben:\n${list}`,
        );
      }
      return;
    }
    case 'deny':
      sendMessage(chat, 'Diese Erlaubnis bekommst du nicht. Finde einen anderen Weg oder sag mir, was dir fehlt.', 'Erlaubnis abgelehnt');
      return;
    case 'send-approve':
    case 'send-deny': {
      // Ausgehende Nachrichten (Outlook, Teams): einzeln oder alle offenen dieses Chats.
      const approve = body.action === 'send-approve';
      const ids = body.freigabeId ? [body.freigabeId] : attention.freigaben || [];
      const list = state.freigaben.filter((f) => ids.includes(f.id) && f.chatId === chat.id && f.status === 'wartet');
      if (!list.length) throw httpError(400, 'Hier wartet keine Nachricht mehr.');
      return Promise.all(list.map((f) => decideFreigabe(f, approve)));
    }
    case 'vault-approve':
    case 'vault-deny':
      decideVaultRequest(chat, body.action === 'vault-approve');
      return;
    case 'handoff-done':
      if (attention.kind !== 'uebergabe') throw httpError(400, 'Hier wartet keine Übergabe.');
      sendMessage(
        chat,
        `Ich habe das selbst erledigt: ${attention.frage}\nPrüf den Stand und mach weiter. Versuch den erledigten Schritt nicht noch einmal selbst.`,
        'Selbst erledigt',
      );
      return;
    case 'retry':
      sendMessage(chat, 'Der letzte Lauf ist abgebrochen. Prüf den Stand und mach dort weiter.', 'Nochmal versuchen');
      return;
    case 'snooze':
      chat.snoozeUntil = Date.now() + SNOOZE_MS;
      chatChanged(chat);
      return;
    case 'done':
      chat.status = 'done';
      chat.attention = null;
      chat.snoozeUntil = null;
      chatChanged(chat);
      return;
    case 'archive':
      stopRun(chat);
      chat.status = 'archived';
      chat.attention = null;
      chat.queued = null;
      chatChanged(chat);
      // Mit dem Auftrag verschwinden auch seine (jetzt beendeten) Teilaufträge aus der Liste.
      removeFinishedChildren(chat, 'mensch');
      return;
    case 'remove-children':
      // Knopf „Beendete Teilaufträge entfernen“: nur beendete, laufende bleiben stehen.
      removeFinishedChildren(chat, 'mensch');
      return;
    case 'remove':
      // Einen einzelnen beendeten Teilauftrag entfernen.
      if (!chat.parentId || !removeChild(chat, 'mensch')) throw httpError(409, 'Nur beendete Teilaufträge lassen sich entfernen. Stopp ihn zuerst.');
      return;
    case 'interrupt':
      interruptRun(chat, typeof body.text === 'string' ? body.text.slice(0, 20000) : '');
      return;
    case 'stop':
      stopRun(chat);
      return;
    default:
      throw httpError(400, 'Unbekannte Aktion');
  }
}

// ---------- Schnittstelle der Oberfläche ----------

const expandHome = (dir) => (dir.startsWith('~') ? path.join(process.env.HOME || '', dir.slice(1)) : dir);
const clean = (value, max = 200) => String(value ?? '').trim().slice(0, max);

function updateSettings(section, body) {
  const s = state.settings;
  switch (section) {
    case 'm365': {
      const before = s.m365.inboundChatId;
      s.m365 = {
        ...s.m365,
        tenant: clean(body.tenant, 100) || 'organizations',
        clientId: /^[0-9a-f-]{36}$/i.test(String(body.clientId || '').trim()) ? String(body.clientId).trim() : '',
        notifyChatId: clean(body.notifyChatId, 300),
        inboundChatId: clean(body.inboundChatId, 300),
        sendMode: body.sendMode === 'direkt' ? 'direkt' : 'freigabe',
        readChannels: Boolean(body.readChannels),
        basic: Boolean(body.basic),
        briefing: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(body.briefing || '').trim()) ? String(body.briefing).trim() : '',
      };
      if (s.m365.inboundChatId !== before) s.m365.inboundSince = 0;
      break;
    }
    case 'access':
      s.access = {
        hosts: String(body.hosts || '').split(/[\s,]+/).map((h) => h.toLowerCase()).filter((h) => /^[a-z0-9.-]+$/.test(h)),
      };
      if (body.token) {
        if (String(body.token).length < 16) throw httpError(400, 'Das Zugangskennwort braucht mindestens 16 Zeichen.');
        secrets.access.token = String(body.token);
        sessions.clear();
      }
      break;
    default:
      throw httpError(404, 'Unbekannter Bereich');
  }
  saveSecrets();
  changed('settings');
}

async function api(req, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent);
  const method = req.method;
  let body = {};
  if (method !== 'GET' && method !== 'DELETE') {
    try {
      body = JSON.parse((await readRaw(req)) || '{}');
    } catch {
      throw httpError(400, 'Ungültiges JSON');
    }
  }
  const [area, key, sub] = parts;

  if (area === 'state' && method === 'GET') {
    return { ...publicState(), pages: listPages(), contextDir: CONTEXT_DIR };
  }

  if (area === 'overview' && method === 'GET') return overview();

  if (area === 'projects' && sub === 'files' && method === 'GET') {
    const project = findProject(key);
    if (!project) throw httpError(404, 'Projekt nicht gefunden');
    return listDir(project, url.searchParams.get('path') || '');
  }

  if (area === 'projects') {
    if (method === 'POST' && !key) {
      const name = clean(body.name, 60);
      const machine = findMachine(body.machineId || 'lokal');
      if (!name) throw httpError(400, 'Das Projekt braucht einen Namen');
      if (!machine) throw httpError(400, 'Maschine nicht gefunden');
      if (state.projects.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw httpError(400, 'Ein Projekt mit diesem Namen gibt es schon');
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'projekt';
      const rawDir = clean(body.dir, 400) || `~/projekte/${slug}`;
      const project = {
        id: id(),
        name,
        dir: path.resolve(expandHome(rawDir)),
        machineId: machine.id,
        mode: MODES.includes(body.mode) ? body.mode : 'selbststaendig',
        // Vorgabe für neue Projekte: Modell und Aufwand wie Copilot sie wählt
        model: '',
        effort: '',
        allow: [],
        identity: { m365: Boolean(body.m365) },
      };
      fs.mkdirSync(project.dir, { recursive: true });
      state.projects.push(project);
      changed('projects');
      return project;
    }
    const project = findProject(key);
    if (!project) throw httpError(404, 'Projekt nicht gefunden');
    if (method === 'PATCH') {
      if (typeof body.name === 'string' && body.name.trim()) project.name = clean(body.name, 60);
      if (MODES.includes(body.mode)) project.mode = body.mode;
      if (typeof body.model === 'string') project.model = choiceOf({ model: body.model }).model || '';
      if (typeof body.effort === 'string') project.effort = choiceOf({ effort: body.effort }).effort || '';
      if (Array.isArray(body.allow)) project.allow = body.allow.map(String).filter(Boolean);
      if (body.identity && typeof body.identity === 'object') {
        project.identity = { m365: Boolean(body.identity.m365) };
      }
      if (typeof body.zentrale === 'boolean') {
        // Es gibt genau eine Zentrale.
        if (body.zentrale) for (const other of state.projects) other.zentrale = false;
        project.zentrale = body.zentrale;
      }
      changed('projects');
      return project;
    }
  }

  // Die Zentrale ist kein Projekt für den Menschen, sondern ein einzelner Chat ganz oben. Intern
  // läuft sie über einen versteckten Eintrag; den und ihren Chat legt der Leitstand bei Bedarf an.
  if (area === 'zentrale' && method === 'POST') {
    let project = state.projects.find((p) => p.zentrale);
    if (!project) {
      const machine = state.machines.find((m) => m.kind === 'local');
      project = {
        id: id(), name: 'Zentrale', dir: path.join(process.env.HOME || os.homedir(), 'projekte', 'zentrale'), machineId: machine.id,
        mode: 'selbststaendig', model: '', effort: '', allow: [], identity: { m365: true }, zentrale: true,
      };
      fs.mkdirSync(project.dir, { recursive: true });
      state.projects.push(project);
      changed('projects');
    }
    let chat = state.chats.filter((c) => c.projectId === project.id && c.status !== 'archived').sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!chat) chat = newChat(project, 'Zentrale');
    const text = String(body.text || '').trim();
    if (text) sendMessage(chat, text);
    else chatChanged(chat);
    return chat;
  }

  if (area === 'chats') {
    if (method === 'POST' && !key) {
      const project = findProject(body.projectId);
      const text = String(body.text || '').trim();
      if (!project) throw httpError(400, 'Projekt fehlt');
      if (project.zentrale) throw httpError(400, 'Die Zentrale hat genau einen Chat. Schreib ihr dort.');
      if (!text) throw httpError(400, 'Auftrag fehlt');
      // Modell und Aufwand für diesen Chat; leer heißt Vorgabe des Projekts.
      const choice = choiceOf(body);
      const chat = newChat(project, clean(body.title, 80) || text.split('\n')[0].slice(0, 60), choice);
      sendMessage(chat, body.kind === 'meeting' ? MEETING_PREFIX + text : text, text);
      return chat;
    }
    const chat = findChat(key);
    if (!chat) throw httpError(404, 'Chat nicht gefunden');
    if (method === 'POST' && sub === 'message') {
      const text = String(body.text || '').trim();
      if (!text) throw httpError(400, 'Nachricht fehlt');
      sendMessage(chat, text);
      return chat;
    }
    if (method === 'POST' && sub === 'action') {
      await chatAction(chat, body);
      return chat;
    }
    if (method === 'PATCH') {
      if (typeof body.title === 'string' && body.title.trim()) chat.title = clean(body.title, 80);
      // Modell und Aufwand gelten ab dem nächsten Zug; '' setzt auf die Vorgabe des Projekts zurück.
      if (typeof body.model === 'string') { const m = choiceOf({ model: body.model }).model; if (m) chat.model = m; else delete chat.model; }
      if (typeof body.effort === 'string') { const e = choiceOf({ effort: body.effort }).effort; if (e) chat.effort = e; else delete chat.effort; }
      chatChanged(chat);
      return chat;
    }
  }

  if (area === 'pages') {
    if (method === 'GET' && !key) return listPages();
    if (method === 'GET') return { name: key, content: readPage(key) };
    if (method === 'PUT') {
      writePage(key, body.content);
      return { name: key };
    }
  }

  if (area === 'machines' && key === 'lokal' && method === 'PATCH') {
    const machine = findMachine('lokal');
    if (Number(body.slots) >= 1) machine.slots = Math.min(32, Math.floor(Number(body.slots)));
    changed('fleet');
    pump();
    return machine;
  }

  if (area === 'settings' && method === 'PUT' && key) {
    updateSettings(key, body);
    return {};
  }

  if (area === 'm365') {
    if (key === 'login' && method === 'POST') return startLogin();
    if (key === 'logout' && method === 'POST') {
      logout();
      return {};
    }
    if (key === 'status' && method === 'GET') return loginState();
  }

  if (area === 'freigaben' && key && method === 'POST') {
    const f = state.freigaben.find((x) => x.id === key);
    if (!f) throw httpError(404, 'Nicht gefunden');
    return decideFreigabe(f, sub === 'senden');
  }

  if (area === 'vault') {
    // Sichtbar für alle Projekte oder genau eines.
    const scope = body.scope === 'alle' || findProject(body.scope) ? body.scope : undefined;
    if (method === 'POST' && !key) {
      createLogin({ ...body, scope: scope || 'alle' }, 'mensch');
      return {};
    }
    const entry = loginById(key);
    if (!entry) throw httpError(404, 'Zugang nicht gefunden');
    if (method === 'POST' && sub === 'reveal') {
      return {
        user: entry.user,
        password: entry.password,
        note: entry.note,
        previous: entry.previous?.[0]?.password || '',
        totp: entry.totp ? totpCode(entry.totp) : null,
      };
    }
    if (method === 'PATCH') {
      updateLogin(entry, {
        name: body.name,
        user: body.user,
        url: body.url,
        note: body.note,
        scope,
        totp: body.removeTotp ? '' : body.totp || undefined,
        password: body.password || undefined,
        generate: Boolean(body.generate),
      });
      if (body.clearPrevious) {
        entry.previous = [];
        updateLogin(entry, {});
      }
      return {};
    }
    if (method === 'DELETE') {
      deleteLogin(entry);
      return {};
    }
  }

  throw httpError(404, 'Nicht gefunden');
}

// ---------- Zugriff ----------
// Drei Wege zur Oberfläche:
// 1. Vom selben Rechner (127.0.0.1): offen, solange LEITSTAND_TRUST_LOCAL nicht 0 ist. Läuft der
//    Leitstand auf einem Server, auf dem auch die Agenten arbeiten, wird das abgeschaltet: Sonst
//    könnte sich ein Agent dort selbst etwas freigeben.
// 2. Aus dem eigenen Tailscale-Netz (LEITSTAND_TRUST_TAILNET=1): offen für die anderen Geräte
//    des Netzes, nicht für den Server selbst. Tailscale hat diese Geräte schon angemeldet.
// 3. Über einen eingetragenen Hostnamen mit Zugangskennwort.

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const TRUST_LOCAL = process.env.LEITSTAND_TRUST_LOCAL !== '0';
const TRUST_TAILNET = process.env.LEITSTAND_TRUST_TAILNET === '1';
const BIND = (process.env.LEITSTAND_BIND || HOST).split(',').map((a) => a.trim()).filter(Boolean);
const OWN_ADDRESSES = new Set(Object.values(os.networkInterfaces()).flat().map((i) => i.address));
const remoteOf = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
const isLoopback = (address) => address === '127.0.0.1' || address === '::1';
// Tailscale vergibt Adressen aus 100.64.0.0/10.
const inTailnet = (address) => {
  const [a, b] = address.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
};
const sessions = new Set();
const loginAttempts = [];
const sha = (value) => crypto.createHash('sha256').update(String(value)).digest();

function sessionOf(req) {
  const match = String(req.headers.cookie || '').match(/(?:^|;\s*)ls=([a-f0-9]{48})/);
  return match && sessions.has(match[1]) ? match[1] : null;
}

const LOGIN_PAGE = `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Leitstand</title><link rel="stylesheet" href="/style.css">
<body><form class="empty form" method="post" action="/login" style="margin:auto;text-align:left;width:320px">
<h2>Leitstand</h2><label>Zugangskennwort<input type="password" name="token" autofocus required></label>
<div class="error">__ERROR__</div><button class="primary" type="submit">Anmelden</button></form></body></html>`;

async function gate(req, res, url) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  const remote = remoteOf(req);
  if (TRUST_LOCAL && LOCAL_HOSTS.has(host) && isLoopback(remote)) return 'local';
  const knownHost = state.settings.access.hosts.includes(host) || BIND.includes(host);
  if (TRUST_TAILNET && knownHost && inTailnet(remote) && !OWN_ADDRESSES.has(remote)) return 'remote';
  if (!secrets.access.token || !knownHost) {
    res.writeHead(403).end('Forbidden');
    return null;
  }
  if (url.pathname === '/style.css') return 'remote';
  if (url.pathname === '/login') {
    let error = '';
    if (req.method === 'POST') {
      const recent = loginAttempts.filter((t) => t > Date.now() - 600_000);
      loginAttempts.length = 0;
      loginAttempts.push(...recent, Date.now());
      const token = new URLSearchParams(await readRaw(req, 10_000)).get('token') || '';
      if (recent.length >= 8) {
        error = 'Zu viele Versuche. Warte zehn Minuten.';
      } else if (crypto.timingSafeEqual(sha(token), sha(secrets.access.token))) {
        const session = crypto.randomBytes(24).toString('hex');
        sessions.add(session);
        res.writeHead(303, {
          Location: '/',
          // „Secure“ nur über HTTPS, sonst nimmt der Browser das Cookie nicht an.
          'Set-Cookie': `ls=${session}; HttpOnly;${req.headers['x-forwarded-proto'] === 'https' ? ' Secure;' : ''} SameSite=Strict; Path=/; Max-Age=2592000`,
        }).end();
        return null;
      } else {
        error = 'Das Kennwort stimmt nicht.';
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(LOGIN_PAGE.replace('__ERROR__', error));
    return null;
  }
  if (sessionOf(req)) return 'remote';
  if (url.pathname.startsWith('/api/')) res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"Nicht angemeldet"}');
  else res.writeHead(303, { Location: '/login' }).end();
  return null;
}

// ---------- HTTP ----------

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

// Ist der Leitstand auf einen Server umgezogen, leitet dieser Standort nur noch dorthin weiter.
const MOVED_TO = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'umgezogen.json'), 'utf8')).url || '';
  } catch {
    return '';
  }
})();

const handle = async (req, res) => {
  if (MOVED_TO) {
    res.writeHead(302, { Location: MOVED_TO }).end();
    return;
  }
  const url = new URL(req.url, 'http://leitstand');
  try {
    const origin = await gate(req, res, url);
    if (!origin) return;

    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      req.on('close', addClient(res));
      return;
    }

    // Dateien aus den Projektordnern, etwa eine Website, die ein Agent gebaut hat. Seiten, die
    // Skripte ausführen können, laufen abgeschottet: Sie dürfen den Leitstand nicht ansprechen.
    if (url.pathname.startsWith('/files/')) {
      const [projectId, ...rest] = url.pathname.slice('/files/'.length).split('/').map(decodeURIComponent);
      const project = findProject(projectId);
      if (!project) throw httpError(404, 'Projekt nicht gefunden');
      let file = resolveInProject(project, rest.join('/'));
      if (fs.statSync(file).isDirectory()) {
        if (!url.pathname.endsWith('/')) {
          res.writeHead(302, { Location: url.pathname + '/' }).end();
          return;
        }
        file = path.join(file, 'index.html');
        if (!fs.existsSync(file)) throw httpError(404, 'In diesem Ordner liegt keine index.html');
      }
      const type = FILE_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const active = ['text/html', 'image/svg+xml', 'text/xml'].includes(type);
      const size = fs.statSync(file).size;
      const range = /^(video|audio)\//.test(type) && String(req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
      if (range && (range[1] || range[2])) {
        let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start > end || start >= size) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
          return;
        }
        res.writeHead(206, {
          'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        });
        fs.createReadStream(file, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, {
        ...(/^(video|audio)\//.test(type) ? { 'Accept-Ranges': 'bytes', 'Content-Length': size } : {}),
        'Content-Type': /^text\/|json|svg|javascript/.test(type) ? `${type}; charset=utf-8` : type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...(active ? { 'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups' } : {}),
      });
      fs.createReadStream(file).pipe(res);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      // Schreibzugriffe brauchen einen Header, den fremde Webseiten nicht setzen können.
      if (req.method !== 'GET' && req.headers['x-leitstand'] !== '1') throw httpError(403, 'Forbidden');
      const result = await api(req, url);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result ?? {}));
      return;
    }

    const file = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': `${TYPES[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(err.status || 500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.message }));
  }
};

// Zweiter Port, nur für das Kommando `leitstand` aus Agentenläufen. Jede Anfrage braucht
// das Token eines laufenden Agenten. Von hier aus lässt sich nichts steuern oder freigeben.
const agentServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://leitstand');
  try {
    const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    if (!LOCAL_HOSTS.has(host) || !isLoopback(remoteOf(req)) || !url.pathname.startsWith('/agent/')) throw httpError(404, 'Unbekanntes Kommando');
    const text = await agentApi(req, url);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text);
  } catch (err) {
    if (!res.headersSent) res.writeHead(err.status || 500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Fehler: ${err.message}`);
  }
});

function shutdown() {
  stopAll();
  saveNow();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

agentServer.listen(AGENT_PORT, HOST);
for (const address of BIND) {
  const ui = http.createServer(handle);
  ui.listen(PORT, address, () => console.log(`Leitstand läuft: http://${address}:${PORT}`));
}
