// Zustand, Geheimnisse und Live-Updates. Alles liegt als JSON im Datenordner.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = process.env.LEITSTAND_DATA || path.join(ROOT, 'data');
export const CONTEXT_DIR = path.join(DATA_DIR, 'kontext');
export const KEY_DIR = path.join(DATA_DIR, 'keys');
export const PORT = Number(process.env.LEITSTAND_PORT || 4747);
// Eigener Port nur für das Kommando `leitstand` der Agenten; die Steuerung der Oberfläche ist
// von dort nicht erreichbar.
export const AGENT_PORT = Number(process.env.LEITSTAND_AGENT_PORT || PORT + 1);
// Die Agenten laufen über GitHub Copilot CLI (`copilot -p`).
export const COPILOT_BIN = process.env.LEITSTAND_COPILOT || 'copilot';

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SECRETS_PLAIN = path.join(DATA_DIR, 'secrets.json'); // alter, unverschlüsselter Stand
const SECRETS_FILE = path.join(DATA_DIR, 'secrets.enc');
const MASTER_KEY_FILE = path.join(KEY_DIR, 'tresor.key');

fs.mkdirSync(CONTEXT_DIR, { recursive: true });
fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });

function load(file, fallback) {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return fallback;
  }
}

export const state = load(STATE_FILE, {
  projects: [],
  chats: [],
  machines: [],
  outbox: [],
  freigaben: [],
  results: [],
  settings: {},
});

// ---------- Geheimnisse ----------
// Tokens, Kennwörter, Kartendaten und der Passwortmanager liegen verschlüsselt in
// secrets.enc (AES-256-GCM) und gehen nie an die Oberfläche. Der Schlüssel dazu liegt
// als eigene Datei in data/keys. Das schützt die Datei selbst (Vorschau, Suche, ein
// versehentlich weitergegebenes Backup dieser einen Datei), nicht gegen jemanden, der
// den ganzen Datenordner kopiert.
// Der Schlüsselbund des Macs wird nur benutzt, wenn LEITSTAND_KEYCHAIN=1 gesetzt ist.
// Dann liegt der Schlüssel dort statt im Datenordner, und eine Kopie des Ordners ist wertlos.

const KEYCHAIN = ['-s', 'leitstand-tresor', '-a', DATA_DIR];
const useKeychain = process.platform === 'darwin' && process.env.LEITSTAND_KEYCHAIN === '1';
const security = (args) =>
  execFileSync('/usr/bin/security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 }).trim();

function masterKey(mayCreate) {
  if (fs.existsSync(MASTER_KEY_FILE)) return Buffer.from(fs.readFileSync(MASTER_KEY_FILE, 'utf8').trim(), 'hex');
  if (useKeychain) {
    try {
      return Buffer.from(security(['find-generic-password', ...KEYCHAIN, '-w']), 'hex');
    } catch (err) {
      // 44 heißt: Eintrag fehlt. Alles andere heißt: Schlüsselbund gerade nicht erreichbar.
      if (err.status !== 44 || !mayCreate) return null;
    }
    const key = crypto.randomBytes(32);
    try {
      security(['add-generic-password', ...KEYCHAIN, '-l', 'Leitstand Tresor', '-w', key.toString('hex')]);
      return key;
    } catch {
      // Schlüsselbund nicht nutzbar: weiter unten als Datei ablegen
    }
  }
  if (!mayCreate) return null;
  const key = crypto.randomBytes(32);
  fs.writeFileSync(MASTER_KEY_FILE, key.toString('hex'), { mode: 0o600 });
  return key;
}

// Einen neuen Schlüssel gibt es nur, solange noch nichts damit verschlüsselt ist.
const KEY = masterKey(!fs.existsSync(SECRETS_FILE));
if (!KEY || KEY.length !== 32) {
  throw new Error('Der Schlüssel zu data/secrets.enc ist nicht erreichbar (data/keys/tresor.key fehlt?). Der Leitstand startet nicht, damit keine Geheimnisse überschrieben werden.');
}

function encrypt(data) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') });
}

function decrypt(text) {
  const box = JSON.parse(text);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.ct, 'base64')), decipher.final()]).toString('utf8'));
}

const SECRET_DEFAULTS = { access: {}, logins: [], m365: null };

export const secrets = { ...SECRET_DEFAULTS };
if (fs.existsSync(SECRETS_FILE)) {
  Object.assign(secrets, decrypt(fs.readFileSync(SECRETS_FILE, 'utf8')));
} else if (fs.existsSync(SECRETS_PLAIN)) {
  // Umzug vom unverschlüsselten Stand: verschlüsselt schreiben, gegenlesen, dann erst löschen.
  Object.assign(secrets, JSON.parse(fs.readFileSync(SECRETS_PLAIN, 'utf8')));
  migrateOldVault();
  saveSecrets();
  if (JSON.stringify(decrypt(fs.readFileSync(SECRETS_FILE, 'utf8'))) !== JSON.stringify(secrets)) {
    throw new Error('Die verschlüsselte Ablage ließ sich nicht gegenlesen. secrets.json bleibt unverändert.');
  }
  fs.rmSync(SECRETS_PLAIN);
}

// Früher war der Tresor eine einfache Liste „Projekt:Name → Wert“.
function migrateOldVault() {
  for (const [key, value] of Object.entries(secrets.vault || {})) {
    const cut = key.indexOf(':');
    secrets.logins.push({
      id: crypto.randomBytes(6).toString('hex'),
      name: key.slice(cut + 1),
      user: '',
      password: String(value),
      url: '',
      totp: '',
      note: '',
      scope: key.slice(0, cut),
      createdBy: key.slice(0, cut),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  delete secrets.vault;
}

// ---------- Standardwerte und Migration älterer Stände ----------

state.settings = {
  access: { hosts: [] },
  ...state.settings,
};
// Microsoft 365 (Outlook, Teams): Anmeldung per Gerätecode, siehe lib/m365.js.
state.settings.m365 = {
  tenant: 'organizations',
  clientId: '',
  notifyChatId: '',
  inboundChatId: '',
  sendMode: 'freigabe',
  ...state.settings.m365,
};
// Die Arbeitsversion läuft nur auf diesem Rechner. Die Zahl der Plätze (gleichzeitige Läufe)
// steht an dieser einen Maschine.
if (!state.machines.some((m) => m.id === 'lokal')) {
  state.machines.unshift({ id: 'lokal', name: 'Dieser Rechner', kind: 'local', slots: Number(process.env.LEITSTAND_SLOTS) || 4, status: 'bereit' });
}
state.machines = state.machines.filter((m) => m.id === 'lokal');
for (const project of state.projects) {
  project.machineId = 'lokal';
  project.identity ??= { m365: false };
  project.allow ??= [];
}

// ---------- Speichern ----------

function writeJson(file, data, mode) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode });
  fs.renameSync(tmp, file);
}

let saveTimer = null;
export function save() {
  saveTimer ??= setTimeout(() => {
    saveTimer = null;
    writeJson(STATE_FILE, state, 0o600);
  }, 200);
}
export function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  writeJson(STATE_FILE, state, 0o600);
}
export function saveSecrets() {
  const tmp = SECRETS_FILE + '.tmp';
  fs.writeFileSync(tmp, encrypt(secrets), { mode: 0o600 });
  fs.renameSync(tmp, SECRETS_FILE);
}

// ---------- Live-Updates ----------

const clients = new Set();
export function addClient(res) {
  clients.add(res);
  return () => clients.delete(res);
}
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 25_000).unref();

// Was die Oberfläche über Geheimnisse wissen darf: nur, ob sie gesetzt sind.
export function secretFlags() {
  return {
    access: Boolean(secrets.access.token),
    m365: secrets.m365?.refreshToken ? (secrets.m365.account || 'angemeldet') : '',
  };
}

export function publicState() {
  return { ...state, ...views.fleet(), secretFlags: secretFlags(), logins: views.logins(), m365: views.m365() };
}

// Die Flotten-Ansicht ergänzt runs.js um die laufenden Agenten je Maschine.
// Die Liste der Zugänge (ohne Passwörter) liefert vault.js.
export const views = { fleet: () => ({ machines: state.machines }), logins: () => [], m365: () => null };

export function changed(what) {
  save();
  if (what === 'projects') broadcast('projects', state.projects);
  else if (what === 'fleet') broadcast('fleet', views.fleet());
  else if (what === 'settings') broadcast('settings', { settings: state.settings, secretFlags: secretFlags(), freigaben: state.freigaben, outbox: state.outbox, logins: views.logins(), m365: views.m365() });
}
export function chatChanged(chat) {
  save();
  broadcast('chat', chat);
}

export const id = () => crypto.randomBytes(6).toString('hex');
export const findChat = (chatId) => state.chats.find((c) => c.id === chatId);
export const findProject = (projectId) => state.projects.find((p) => p.id === projectId);
export const findMachine = (machineId) => state.machines.find((m) => m.id === machineId);

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function readRaw(req, limit = 5_000_000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limit) reject(httpError(413, 'Zu groß'));
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}
