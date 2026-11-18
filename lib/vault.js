// Passwortmanager der Agenten: Zugänge mit erzeugten Passwörtern, 2FA-Codes und Notizen.
// Die Einträge liegen in den verschlüsselten Geheimnissen (store.js). Agenten greifen über
// das Kommando `leitstand tresor` zu, der Mensch über den Reiter „Tresor“.
import crypto from 'node:crypto';
import { secrets, saveSecrets, changed, id, views, httpError } from './store.js';

const NAME = /^[\p{L}\p{N} _.@:/+-]{1,80}$/u;
const clean = (value, max) => String(value ?? '').trim().slice(0, max);

// ---------- Passwörter ----------

// 24 Zeichen aus Buchstaben, Ziffern und Zeichen, die praktisch jede Anmeldeseite annimmt.
export function generatePassword(length = 24) {
  const sets = ['abcdefghijkmnopqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789', '-_!#%+'];
  const all = sets.join('');
  const chars = sets.map((set) => set[crypto.randomInt(set.length)]);
  while (chars.length < length) chars.push(all[crypto.randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// ---------- 2FA-Codes (TOTP, RFC 6238) ----------

function base32(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of input.toUpperCase().replace(/[\s=-]/g, '')) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw httpError(400, 'Das ist kein gültiger 2FA-Schlüssel (erwartet: Base32 oder otpauth://-Adresse).');
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

// Nimmt den Einrichtungsschlüssel einer Seite an, als reinen Schlüssel oder als otpauth://-Adresse.
function parseTotp(raw) {
  raw = String(raw).trim();
  let secret = raw;
  let digits = 6;
  let period = 30;
  let algorithm = 'sha1';
  if (raw.toLowerCase().startsWith('otpauth://')) {
    const params = new URL(raw).searchParams;
    secret = params.get('secret') || '';
    digits = Number(params.get('digits')) || 6;
    period = Number(params.get('period')) || 30;
    algorithm = (params.get('algorithm') || 'SHA1').toLowerCase();
  }
  const key = base32(secret);
  if (key.length < 10 || !['sha1', 'sha256', 'sha512'].includes(algorithm)) {
    throw httpError(400, 'Das ist kein gültiger 2FA-Schlüssel.');
  }
  return { key, digits, period, algorithm };
}

export function totpCode(raw, now = Date.now()) {
  const { key, digits, period, algorithm } = parseTotp(raw);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / period)));
  const hmac = crypto.createHmac(algorithm, key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = String((hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
  return { code, remaining: period - (Math.floor(now / 1000) % period) };
}

// ---------- Einträge ----------

// Was die Oberfläche als Liste bekommt: alles außer Passwort, 2FA-Schlüssel und Notiz.
views.logins = () =>
  secrets.logins.map((e) => ({
    id: e.id,
    name: e.name,
    user: e.user,
    url: e.url,
    scope: e.scope,
    hasTotp: Boolean(e.totp),
    hasNote: Boolean(e.note),
    createdBy: e.createdBy,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    lastUsedAt: e.lastUsedAt || null,
    lastUsedBy: e.lastUsedBy || null,
  }));

function stored() {
  saveSecrets();
  changed('settings');
}

export const loginById = (loginId) => secrets.logins.find((e) => e.id === loginId);

// Ein Agent sieht die Zugänge seines Projekts und die für alle freigegebenen.
export function visibleTo(projectId) {
  return secrets.logins.filter((e) => e.scope === 'alle' || e.scope === projectId);
}

// Bei gleichem Namen gewinnt der Eintrag des eigenen Projekts.
export function findFor(projectId, name) {
  const wanted = String(name).trim().toLowerCase();
  const matches = visibleTo(projectId).filter((e) => e.name.toLowerCase() === wanted);
  return matches.find((e) => e.scope === projectId) || matches[0] || null;
}

export function createLogin(fields, createdBy) {
  const name = clean(fields.name, 80);
  if (!NAME.test(name)) throw httpError(400, 'Der Name darf Buchstaben, Ziffern, Leerzeichen und . _ @ : / + - enthalten.');
  const scope = fields.scope || 'alle';
  if (secrets.logins.some((e) => e.scope === scope && e.name.toLowerCase() === name.toLowerCase())) {
    throw httpError(409, `Einen Zugang „${name}“ gibt es schon.`);
  }
  if (fields.totp) totpCode(fields.totp); // prüft den Schlüssel
  const entry = {
    id: id(),
    name,
    user: clean(fields.user, 200),
    password: fields.password ? String(fields.password) : generatePassword(),
    url: clean(fields.url, 300),
    totp: clean(fields.totp, 500),
    note: String(fields.note ?? '').slice(0, 5000),
    scope,
    createdBy,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    previous: [],
  };
  secrets.logins.push(entry);
  stored();
  return entry;
}

// Ein ersetztes Passwort bleibt als „vorheriges“ erhalten, falls die Änderung auf der Seite
// selbst nicht angekommen ist.
export function setPassword(entry, password) {
  if (password === entry.password) return;
  entry.previous = [{ password: entry.password, until: Date.now() }, ...(entry.previous || [])].slice(0, 3);
  entry.password = password;
}

export function updateLogin(entry, fields) {
  if (fields.name !== undefined) {
    const name = clean(fields.name, 80);
    if (!NAME.test(name)) throw httpError(400, 'Ungültiger Name');
    entry.name = name;
  }
  if (fields.user !== undefined) entry.user = clean(fields.user, 200);
  if (fields.url !== undefined) entry.url = clean(fields.url, 300);
  if (fields.note !== undefined) entry.note = String(fields.note).slice(0, 5000);
  if (fields.scope) entry.scope = fields.scope;
  if (fields.totp !== undefined && fields.totp !== null) {
    if (fields.totp) totpCode(fields.totp);
    entry.totp = clean(fields.totp, 500);
  }
  if (fields.generate) setPassword(entry, generatePassword());
  else if (fields.password) setPassword(entry, String(fields.password));
  entry.updatedAt = Date.now();
  stored();
  return entry;
}

export function deleteLogin(entry) {
  secrets.logins = secrets.logins.filter((e) => e.id !== entry.id);
  stored();
}

// Merkt sich, welches Projekt einen Zugang zuletzt geholt hat.
export function used(entry, projectId) {
  entry.lastUsedAt = Date.now();
  entry.lastUsedBy = projectId;
  stored();
}

// Vollständiger Eintrag als Text, so wie ihn ein Agent zu sehen bekommt.
export function describe(entry) {
  const lines = [`Name: ${entry.name}`];
  if (entry.url) lines.push(`Adresse: ${entry.url}`);
  if (entry.user) lines.push(`Benutzer: ${entry.user}`);
  lines.push(`Passwort: ${entry.password}`);
  if (entry.totp) {
    const { code, remaining } = totpCode(entry.totp);
    lines.push(`2FA-Code: ${code} (noch ${remaining} s gültig)`);
  }
  if (entry.previous?.length) lines.push(`Vorheriges Passwort: ${entry.previous[0].password}`);
  if (entry.note) lines.push('Notiz:', entry.note);
  return lines.join('\n');
}
