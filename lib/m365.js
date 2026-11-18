// Microsoft 365: Outlook (Mail, Kalender) und Teams (Chats, Kanäle) über Microsoft Graph.
// Anmeldung einmal per Gerätecode mit dem Arbeitskonto des Menschen (delegierte Rechte, kein
// App-Geheimnis). Das Refresh-Token liegt verschlüsselt in secrets.m365.
//
// Was in seinem Namen hinausgeht (Mail senden, antworten, in Teams schreiben), legt der Leitstand
// ihm als „Freigabe“ vor, außer in den Einstellungen steht sendMode = 'direkt'.
// Dazu: Benachrichtigung in einen Teams-Chat, wenn ein Chat den Menschen braucht, und
// Nachrichten aus einem Teams-Chat an die Zentrale (mit Antwort zurück in Teams).
import fs from 'node:fs';
import path from 'node:path';
import { state, secrets, saveSecrets, changed, chatChanged, id, findChat, findProject, httpError, views } from './store.js';
import { attentionHooks, sendMessage, newChat } from './runs.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
// Öffentlicher Client „Microsoft Graph Command Line Tools“: in den meisten Tenants schon
// zugelassen, Gerätecode erlaubt. Eigene App-Registrierung: Einstellungen → Client-ID.
const DEFAULT_CLIENT = '14d82eec-204b-4c2f-b7e8-296a70dab67e';
const BASE_SCOPES = [
  'offline_access', 'openid', 'profile', 'User.Read',
  'Mail.ReadWrite', 'Mail.Send', 'Calendars.ReadWrite',
  'Chat.ReadWrite', 'Team.ReadBasic.All', 'Channel.ReadBasic.All', 'ChannelMessage.Send',
];
// Dazu, wenn nicht „Nur Grundrechte“ eingestellt ist: Personen, OneDrive/SharePoint, To Do.
// Alle ohne Admin-Zustimmung möglich, sofern der Tenant Benutzerzustimmung erlaubt.
const EXTRA_SCOPES = ['People.Read', 'User.ReadBasic.All', 'Files.ReadWrite.All', 'Sites.Read.All', 'Tasks.ReadWrite'];
// Kanäle lesen braucht in vielen Tenants die Zustimmung eines Admins; darum nur auf Wunsch.
const CHANNEL_READ = 'ChannelMessage.Read.All';
export const MARKER = '🛰️ Leitstand';

const cfg = () => state.settings.m365;
const tenant = () => cfg().tenant || 'organizations';
const clientId = () => cfg().clientId || process.env.LEITSTAND_M365_CLIENT_ID || DEFAULT_CLIENT;
const scopes = () => [...BASE_SCOPES, ...(cfg().basic ? [] : EXTRA_SCOPES), ...(cfg().readChannels ? [CHANNEL_READ] : [])].join(' ');
const authUrl = (p) => `https://login.microsoftonline.com/${encodeURIComponent(tenant())}/oauth2/v2.0/${p}`;

// ---------- Anmeldung per Gerätecode ----------

let login = null; // { userCode, url, message, expiresAt, error }
let access = null; // { token, expiresAt }

export const loginState = () => ({
  signedIn: Boolean(secrets.m365?.refreshToken),
  account: secrets.m365?.account || '',
  pending: login && !login.error && login.expiresAt > Date.now() ? { userCode: login.userCode, url: login.url, message: login.message } : null,
  error: login?.error || '',
});

async function form(url, fields) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

export async function startLogin() {
  const { ok, data } = await form(authUrl('devicecode'), { client_id: clientId(), scope: scopes() });
  if (!ok) throw httpError(502, `Anmeldung bei Microsoft nicht möglich: ${data.error_description || data.error || 'unbekannter Fehler'}`);
  const current = {
    userCode: data.user_code,
    url: data.verification_uri,
    message: data.message,
    expiresAt: Date.now() + (data.expires_in || 900) * 1000,
    error: '',
  };
  login = current;
  changed('settings');
  pollLogin(current, data.device_code, Math.max(5, data.interval || 5));
  return loginState();
}

async function pollLogin(current, deviceCode, interval) {
  while (login === current && current.expiresAt > Date.now()) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const { ok, data } = await form(authUrl('token'), {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId(),
      device_code: deviceCode,
    }).catch((err) => ({ ok: false, data: { error: 'network', error_description: err.message } }));
    if (ok) {
      secrets.m365 = { refreshToken: data.refresh_token, account: '', tenant: tenant(), clientId: clientId() };
      access = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 120) * 1000 };
      try {
        const me = await graph('GET', '/me?$select=displayName,mail,userPrincipalName');
        secrets.m365.account = `${me.displayName} <${me.mail || me.userPrincipalName}>`;
        secrets.m365.userId = me.id;
      } catch {}
      saveSecrets();
      login = null;
      changed('settings');
      return;
    }
    if (data.error === 'authorization_pending' || data.error === 'network') continue;
    if (data.error === 'slow_down') {
      interval += 5;
      continue;
    }
    current.error = data.error_description?.split('\n')[0] || data.error || 'Anmeldung fehlgeschlagen';
    changed('settings');
    return;
  }
  if (login === current && !current.error) {
    current.error = 'Der Code ist abgelaufen. Bitte neu anmelden.';
    changed('settings');
  }
}

export function logout() {
  secrets.m365 = null;
  access = null;
  login = null;
  saveSecrets();
  changed('settings');
}

async function accessToken() {
  if (access && access.expiresAt > Date.now()) return access.token;
  const refresh = secrets.m365?.refreshToken;
  if (!refresh) throw httpError(409, 'Microsoft 365 ist nicht angemeldet. Der Mensch meldet sich im Reiter „Einstellungen“ unter Microsoft 365 an.');
  const { ok, data } = await form(authUrl('token'), {
    grant_type: 'refresh_token',
    client_id: secrets.m365.clientId || clientId(),
    refresh_token: refresh,
    scope: scopes(),
  });
  if (!ok) {
    access = null;
    throw httpError(409, `Microsoft-365-Anmeldung abgelaufen (${data.error || 'Fehler'}). Der Mensch meldet sich im Reiter „Einstellungen“ neu an.`);
  }
  access = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 120) * 1000 };
  if (data.refresh_token && data.refresh_token !== refresh) {
    secrets.m365.refreshToken = data.refresh_token;
    saveSecrets();
  }
  return access.token;
}

export async function graph(method, path, body, headers = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(path.startsWith('http') ? path : GRAPH + path, {
      method,
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, (Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000));
      continue;
    }
    if (res.status === 202 || res.status === 204) return {};
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.error?.message || res.statusText;
      if (res.status === 403) throw httpError(403, `Microsoft verweigert den Zugriff (${msg}). Meist fehlt die Zustimmung für diese Berechtigung im Tenant.`);
      throw httpError(res.status === 404 ? 404 : 502, `Microsoft Graph: ${msg}`);
    }
    return data;
  }
}

views.m365 = loginState;

// ---------- Hilfen ----------

const when = (iso) => (iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Berlin' }) : '');
const addr = (r) => r?.emailAddress ? (r.emailAddress.name && r.emailAddress.name !== r.emailAddress.address ? `${r.emailAddress.name} <${r.emailAddress.address}>` : r.emailAddress.address) : '';
const recipients = (list) => String(list || '').split(/[,;]/).map((a) => a.trim()).filter(Boolean).map((address) => ({ emailAddress: { address } }));
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)} …` : s);

export function htmlToText(html) {
  return String(html || '')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<attachment[^>]*><\/attachment>/gi, '[Anhang]')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const textToHtml = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');

// ---------- Outlook ----------

const FOLDERS = { posteingang: 'inbox', inbox: 'inbox', gesendet: 'sentitems', entwuerfe: 'drafts', entwürfe: 'drafts', archiv: 'archive', junk: 'junkemail' };
const MAIL_FIELDS = '$select=id,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview,hasAttachments';

async function folderId(name) {
  const key = String(name || 'posteingang').toLowerCase();
  if (FOLDERS[key]) return FOLDERS[key];
  const found = await graph('GET', `/me/mailFolders?$top=100&$filter=${encodeURIComponent(`displayName eq '${String(name).replace(/'/g, "''")}'`)}`);
  if (!found.value?.length) throw httpError(404, `Einen Ordner „${name}“ gibt es nicht. Möglich: posteingang, gesendet, entwuerfe, archiv oder ein eigener Ordnername.`);
  return found.value[0].id;
}

const mailLine = (m) => `[${m.id}]\n    ${when(m.receivedDateTime)} · ${addr(m.from)}${m.isRead === false ? ' · UNGELESEN' : ''}${m.hasAttachments ? ' · Anhang' : ''}\n    ${m.subject || '(ohne Betreff)'}\n    ${clip(String(m.bodyPreview || '').replace(/\s+/g, ' '), 160)}`;

export async function mailList(folder, count) {
  const n = Math.min(50, Math.max(1, Number(count) || 15));
  const data = await graph('GET', `/me/mailFolders/${encodeURIComponent(await folderId(folder))}/messages?$top=${n}&$orderby=receivedDateTime desc&${MAIL_FIELDS}`);
  return data.value.map(mailLine).join('\n') || '(keine Nachrichten)';
}

export async function mailSearch(term) {
  if (!term.trim()) throw httpError(400, 'Suchbegriff fehlt.');
  const data = await graph('GET', `/me/messages?$top=25&$search=${encodeURIComponent(`"${term.replace(/"/g, '')}"`)}&${MAIL_FIELDS}`);
  return data.value.map(mailLine).join('\n') || '(nichts gefunden)';
}

export async function mailRead(messageId) {
  const m = await graph('GET', `/me/messages/${encodeURIComponent(messageId)}?$select=subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,webLink`, null, { Prefer: 'outlook.body-content-type="text"' });
  let attachments = '';
  if (m.hasAttachments) {
    const a = await graph('GET', `/me/messages/${encodeURIComponent(messageId)}/attachments?$select=name,size,contentType`).catch(() => ({ value: [] }));
    attachments = `\nAnhänge: ${a.value.map((x) => `${x.name} (${Math.round(x.size / 1024)} KB)`).join(', ')}`;
  }
  return `Von: ${addr(m.from)}\nAn: ${(m.toRecipients || []).map(addr).join(', ')}${m.ccRecipients?.length ? `\nCc: ${m.ccRecipients.map(addr).join(', ')}` : ''}\nBetreff: ${m.subject}\nDatum: ${when(m.receivedDateTime)}${attachments}\n\n${clip(String(m.body?.content || '').trim(), 20000)}`;
}

export async function calendar(days) {
  const n = Math.min(60, Math.max(1, Number(days) || 7));
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + n * 86_400_000);
  const data = await graph('GET', `/me/calendarView?startDateTime=${start.toISOString()}&endDateTime=${end.toISOString()}&$orderby=start/dateTime&$top=100&$select=subject,start,end,location,organizer,isOnlineMeeting,isAllDay,showAs`, null, { Prefer: 'outlook.timezone="Europe/Berlin"' });
  const fmt = (d) => new Date(`${d.dateTime}`).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return data.value.map((e) => `- ${e.isAllDay ? `${fmt(e.start).split(',')[0]} ganztägig` : `${fmt(e.start)}–${new Date(e.end.dateTime).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`} · ${e.subject || '(ohne Titel)'}${e.location?.displayName ? ` · ${e.location.displayName}` : ''}${e.isOnlineMeeting ? ' · Teams' : ''} · ${addr(e.organizer)}`).join('\n') || `(keine Termine in den nächsten ${n} Tagen)`;
}

async function createDraft({ to, cc, subject, text }) {
  if (!recipients(to).length) throw httpError(400, 'Empfänger fehlt.');
  return graph('POST', '/me/messages', {
    subject,
    body: { contentType: 'Text', content: text },
    toRecipients: recipients(to),
    ccRecipients: recipients(cc),
  });
}

// ---------- Teams ----------

const chatName = (c) => c.topic || (c.members || []).map((m) => m.displayName).filter((n) => n && !secrets.m365?.account?.startsWith(n)).join(', ') || c.chatType;

export async function teamsChats(count) {
  const n = Math.min(50, Math.max(1, Number(count) || 20));
  const data = await graph('GET', `/me/chats?$top=${n}&$expand=members,lastMessagePreview&$orderby=lastMessagePreview/createdDateTime desc`).catch(() => graph('GET', `/me/chats?$top=${n}&$expand=members`));
  return data.value.map((c) => {
    const last = c.lastMessagePreview;
    return `[${c.id}]\n    ${chatName(c)}${last ? `\n    ${when(last.createdDateTime)} · ${last.from?.user?.displayName || ''}: ${clip(htmlToText(last.body?.content).replace(/\s+/g, ' '), 140)}` : ''}`;
  }).join('\n') || '(keine Chats)';
}

const messageLine = (m) => `${when(m.createdDateTime)} · ${m.from?.user?.displayName || m.from?.application?.displayName || '?'}: ${htmlToText(m.body?.content)}`;

export async function teamsRead(chatId, count) {
  const n = Math.min(50, Math.max(1, Number(count) || 20));
  const data = await graph('GET', `/chats/${encodeURIComponent(chatId)}/messages?$top=${n}&$orderby=createdDateTime desc`);
  return data.value.filter((m) => m.messageType === 'message').reverse().map(messageLine).join('\n') || '(keine Nachrichten)';
}

export async function teamsChannels() {
  const teams = await graph('GET', '/me/joinedTeams?$select=id,displayName');
  const out = [];
  for (const t of teams.value) {
    const ch = await graph('GET', `/teams/${t.id}/channels?$select=id,displayName`).catch(() => ({ value: [] }));
    out.push(`${t.displayName} [${t.id}]`, ...ch.value.map((c) => `    # ${c.displayName} [${c.id}]`));
  }
  return out.join('\n') || '(keine Teams)';
}

export async function teamsChannelRead(teamId, channelId, count) {
  const n = Math.min(50, Math.max(1, Number(count) || 20));
  const data = await graph('GET', `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages?$top=${n}`);
  return data.value.filter((m) => m.messageType === 'message').reverse().map((m) => `${messageLine(m)}${m.subject ? ` (Betreff: ${m.subject})` : ''}`).join('\n') || '(keine Beiträge)';
}

const postChat = (chatId, html) => graph('POST', `/chats/${encodeURIComponent(chatId)}/messages`, { body: { contentType: 'html', content: html } });
const postChannel = (teamId, channelId, html) => graph('POST', `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`, { body: { contentType: 'html', content: html } });


// ---------- Kalender: Termine, freie Zeiten ----------

// „2026-11-20 14:00“, „20.11. 14:00“, „morgen 9:30“, „heute 16“ → lokale Zeit (Europe/Berlin)
export function parseWhen(text) {
  const t = String(text || '').trim().toLowerCase();
  const now = new Date();
  let day = null;
  let rest = t;
  const rel = t.match(/^(heute|morgen|übermorgen|uebermorgen)\b\s*(.*)$/);
  if (rel) {
    day = new Date(now);
    day.setDate(now.getDate() + ({ heute: 0, morgen: 1 }[rel[1]] ?? 2));
    rest = rel[2];
  } else {
    let m = t.match(/^(\d{4})-(\d{2})-(\d{2})[t\s]*(.*)$/);
    if (m) {
      day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      rest = m[4];
    } else if ((m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})?\s*(.*)$/))) {
      const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : now.getFullYear();
      day = new Date(y, Number(m[2]) - 1, Number(m[1]));
      rest = m[4];
    }
  }
  if (!day) throw httpError(400, `Zeit „${text}“ nicht verstanden. Format: JJJJ-MM-TT HH:MM, TT.MM. HH:MM oder heute/morgen HH:MM.`);
  const hm = rest.replace(/uhr/, '').trim().match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (rest && !hm) throw httpError(400, `Uhrzeit „${rest}“ nicht verstanden.`);
  const pad = (n) => String(n).padStart(2, '0');
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}T${pad(hm ? Number(hm[1]) : 0)}:${pad(hm?.[2] ? Number(hm[2]) : 0)}:00`;
}

const TZ = 'W. Europe Standard Time';

async function createEvent({ subject, start, end, attendees, location, text, online }) {
  return graph('POST', '/me/events', {
    subject,
    body: { contentType: 'Text', content: text || '' },
    start: { dateTime: start, timeZone: TZ },
    end: { dateTime: end, timeZone: TZ },
    ...(location ? { location: { displayName: location } } : {}),
    attendees: recipients(attendees).map((r) => ({ ...r, type: 'required' })),
    ...(online ? { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' } : {}),
  });
}

function eventFields(param) {
  const start = parseWhen(param('start'));
  const endRaw = param('ende').trim();
  let end;
  if (/^\d+$/.test(endRaw)) end = new Date(new Date(start).getTime() + Number(endRaw) * 60_000);
  else if (/^\d{1,2}(:\d{2})?$/.test(endRaw)) end = new Date(parseWhen(`${start.slice(0, 10)} ${endRaw}`));
  else if (endRaw) end = new Date(parseWhen(endRaw));
  else end = new Date(new Date(start).getTime() + 30 * 60_000);
  const pad = (n) => String(n).padStart(2, '0');
  const endIso = `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}T${pad(end.getHours())}:${pad(end.getMinutes())}:00`;
  if (endIso <= start) throw httpError(400, 'Das Ende liegt vor dem Anfang.');
  return { subject: param('titel').trim() || 'Termin', start, end: endIso, attendees: param('teilnehmer'), location: param('ort'), text: param('text'), online: param('teams') === '1' };
}

export async function freeBusy(people, dayText) {
  const list = String(people || '').split(/[,;]/).map((a) => a.trim()).filter(Boolean);
  if (!list.length) throw httpError(400, 'Wen? Mail-Adressen mit Komma.');
  const day = parseWhen(dayText || 'heute').slice(0, 10);
  const data = await graph('POST', '/me/calendar/getSchedule', {
    schedules: list,
    startTime: { dateTime: `${day}T07:00:00`, timeZone: TZ },
    endTime: { dateTime: `${day}T19:00:00`, timeZone: TZ },
    availabilityViewInterval: 30,
  }, { Prefer: 'outlook.timezone="Europe/Berlin"' });
  const slots = (view) => view.split('').map((c, i) => {
    const h = 7 + Math.floor(i / 2);
    return `${String(h).padStart(2, '0')}:${i % 2 ? '30' : '00'}${c === '0' ? '' : c === '1' ? '?' : '×'}`;
  });
  const lines = data.value.map((s) => `${s.scheduleId}: ${s.error ? `nicht abrufbar (${s.error.message})` : slots(s.availabilityView || '').join(' ')}`);
  // Gemeinsam frei: alle Zeichen 0
  const views = data.value.filter((s) => !s.error).map((s) => s.availabilityView || '');
  const free = views.length ? views[0].split('').map((_, i) => views.every((v) => v[i] === '0')).map((ok, i) => (ok ? `${String(7 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}` : null)).filter(Boolean) : [];
  return `${day}, 07–19 Uhr in 30-Minuten-Schritten (× belegt, ? vorläufig):\n${lines.join('\n')}\n\nAlle frei ab: ${free.join(', ') || '(kein gemeinsamer Slot)'}`;
}

// ---------- Personen ----------

export async function people(term) {
  const q = String(term || '').trim();
  if (!q) throw httpError(400, 'Suchbegriff fehlt.');
  const out = [];
  const a = await graph('GET', `/me/people?$top=10&$search=${encodeURIComponent(`"${q.replace(/"/g, '')}"`)}&$select=displayName,scoredEmailAddresses,jobTitle,department,phones,officeLocation`).catch(() => ({ value: [] }));
  for (const p of a.value) out.push(`- ${p.displayName}${p.jobTitle ? `, ${p.jobTitle}` : ''}${p.department ? ` (${p.department})` : ''} · ${p.scoredEmailAddresses?.[0]?.address || ''}${p.phones?.[0]?.number ? ` · ${p.phones[0].number}` : ''}${p.officeLocation ? ` · ${p.officeLocation}` : ''}`);
  if (!out.length) {
    const b = await graph('GET', `/users?$top=10&$search=${encodeURIComponent(`"displayName:${q.replace(/"/g, '')}"`)}&$select=displayName,mail,jobTitle,department,businessPhones,mobilePhone,officeLocation`, null, { ConsistencyLevel: 'eventual' }).catch(() => ({ value: [] }));
    for (const u of b.value) out.push(`- ${u.displayName}${u.jobTitle ? `, ${u.jobTitle}` : ''}${u.department ? ` (${u.department})` : ''} · ${u.mail || ''}${u.businessPhones?.[0] ? ` · ${u.businessPhones[0]}` : ''}${u.mobilePhone ? ` · ${u.mobilePhone}` : ''}`);
  }
  return out.join('\n') || '(niemand gefunden)';
}

// ---------- OneDrive und SharePoint ----------

const size = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`);
const itemLine = (i) => `[${i.parentReference?.driveId || ''}!${i.id}] ${i.folder ? '📁 ' : ''}${i.name}${i.folder ? '' : ` · ${size(i.size)}`} · ${when(i.lastModifiedDateTime)}${i.lastModifiedBy?.user?.displayName ? ` · ${i.lastModifiedBy.user.displayName}` : ''}${i.webUrl ? `\n    ${i.webUrl}` : ''}`;
const splitRef = (ref) => {
  const [drive, item] = String(ref || '').includes('!') && !String(ref).startsWith('!') ? [String(ref).split('!')[0], String(ref).slice(String(ref).indexOf('!') + 1)] : ['', String(ref || '').replace(/^!/, '')];
  if (!item) throw httpError(400, 'Datei-ID fehlt (aus `leitstand dateien suchen` oder `liste`, Form LAUFWERK!ID).');
  return drive ? `/drives/${encodeURIComponent(drive)}/items/${encodeURIComponent(item)}` : `/me/drive/items/${encodeURIComponent(item)}`;
};

export async function filesSearch(term) {
  const q = String(term || '').trim();
  if (!q) throw httpError(400, 'Suchbegriff fehlt.');
  const data = await graph('POST', '/search/query', { requests: [{ entityTypes: ['driveItem'], query: { queryString: q }, size: 25 }] });
  const hits = data.value?.[0]?.hitsContainers?.flatMap((c) => c.hits || []) || [];
  return hits.map((h) => `${itemLine(h.resource)}${h.summary ? `\n    … ${htmlToText(h.summary).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`).join('\n') || '(nichts gefunden)';
}

export async function filesList(where) {
  const w = String(where || '').trim();
  let url;
  if (!w || w === '/') url = '/me/drive/root/children';
  else if (w === 'zuletzt') url = '/me/drive/recent';
  else if (w === 'geteilt') url = '/me/drive/sharedWithMe';
  else if (w.includes('!') || /^[A-Z0-9]{10,}$/i.test(w)) url = `${splitRef(w)}/children`;
  else url = `/me/drive/root:/${w.replace(/^\/+|\/+$/g, '').split('/').map(encodeURIComponent).join('/')}:/children`;
  const data = await graph('GET', `${url}${url.includes('?') ? '&' : '?'}$top=100`);
  return data.value.map((i) => itemLine(i.remoteItem ? { ...i.remoteItem, name: i.name } : i)).join('\n') || '(leer)';
}

// Lädt eine Datei in den Projektordner. format=pdf wandelt Office-Dateien um.
export async function filesDownload(ref, target, project, format) {
  const meta = await graph('GET', `${splitRef(ref)}?$select=name,size,file`);
  const name = format === 'pdf' ? meta.name.replace(/\.[^.]+$/, '') + '.pdf' : meta.name;
  const rel = String(target || '').trim() || path.join('m365', name);
  const dest = path.resolve(project.dir, rel.endsWith('/') ? path.join(rel, name) : rel);
  if (!dest.startsWith(path.resolve(project.dir) + path.sep)) throw httpError(400, 'Das Ziel muss im Projektordner liegen.');
  const res = await fetch(`${GRAPH}${splitRef(ref)}/content${format === 'pdf' ? '?format=pdf' : ''}`, { headers: { Authorization: `Bearer ${await accessToken()}` } });
  if (!res.ok) throw httpError(502, `Download fehlgeschlagen (${res.status}).`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return `Gespeichert: ${dest} (${size(fs.statSync(dest).size)})`;
}

// Lädt eine Datei aus dem Projektordner in den eigenen OneDrive (Ordner „Leitstand“ oder ORDNER).
export async function filesUpload(file, folder, project) {
  const src = path.resolve(project.dir, String(file || ''));
  if (!src.startsWith(path.resolve(project.dir) + path.sep) || !fs.existsSync(src)) throw httpError(400, 'Die Datei muss im Projektordner liegen.');
  const dir = (String(folder || '').trim() || 'Leitstand').replace(/^\/+|\/+$/g, '');
  const remote = `${dir}/${path.basename(src)}`.split('/').map(encodeURIComponent).join('/');
  const data = fs.readFileSync(src);
  let item;
  if (data.length <= 4 * 1048576) {
    const res = await fetch(`${GRAPH}/me/drive/root:/${remote}:/content`, { method: 'PUT', headers: { Authorization: `Bearer ${await accessToken()}` }, body: data });
    item = await res.json();
    if (!res.ok) throw httpError(502, `Hochladen fehlgeschlagen: ${item.error?.message || res.status}`);
  } else {
    const session = await graph('POST', `/me/drive/root:/${remote}:/createUploadSession`, { item: { '@microsoft.graph.conflictBehavior': 'replace' } });
    const chunk = 5 * 1048576;
    for (let at = 0; at < data.length; at += chunk) {
      const part = data.subarray(at, Math.min(at + chunk, data.length));
      const res = await fetch(session.uploadUrl, { method: 'PUT', headers: { 'Content-Range': `bytes ${at}-${at + part.length - 1}/${data.length}` }, body: part });
      if (!res.ok && res.status !== 202) throw httpError(502, `Hochladen fehlgeschlagen (${res.status}).`);
      if (res.status === 200 || res.status === 201) item = await res.json();
    }
  }
  return `In OneDrive: ${dir}/${path.basename(src)}${item?.webUrl ? `\n${item.webUrl}` : ''}`;
}

// ---------- To Do ----------

async function todoList(name) {
  const lists = await graph('GET', '/me/todo/lists');
  const wanted = String(name || '').trim().toLowerCase();
  const list = wanted ? lists.value.find((l) => l.displayName.toLowerCase() === wanted) : lists.value.find((l) => l.wellknownListName === 'defaultList') || lists.value[0];
  if (!list) throw httpError(404, `Keine To-Do-Liste „${name}“. Vorhanden: ${lists.value.map((l) => l.displayName).join(', ')}`);
  return list;
}

export async function tasks(listName) {
  const list = await todoList(listName);
  const data = await graph('GET', `/me/todo/lists/${list.id}/tasks?$filter=status ne 'completed'&$top=100`);
  return `Liste „${list.displayName}“:\n${data.value.map((t) => `- [${list.id}!${t.id}] ${t.title}${t.dueDateTime ? ` · fällig ${new Date(t.dueDateTime.dateTime).toLocaleDateString('de-DE')}` : ''}${t.importance === 'high' ? ' · wichtig' : ''}`).join('\n') || '(keine offenen Aufgaben)'}`;
}

export async function taskAdd(title, due, listName, note) {
  if (!String(title || '').trim()) throw httpError(400, 'Titel fehlt.');
  const list = await todoList(listName);
  const t = await graph('POST', `/me/todo/lists/${list.id}/tasks`, {
    title: String(title).trim(),
    ...(due ? { dueDateTime: { dateTime: parseWhen(due), timeZone: TZ } } : {}),
    ...(note ? { body: { contentType: 'text', content: note } } : {}),
  });
  return `Aufgabe angelegt in „${list.displayName}“ [${list.id}!${t.id}].`;
}

export async function taskDone(ref) {
  const [listId, taskId] = String(ref || '').split('!');
  if (!listId || !taskId) throw httpError(400, 'ID in der Form LISTE!AUFGABE (aus `leitstand aufgaben liste`).');
  await graph('PATCH', `/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`, { status: 'completed' });
  return 'Erledigt.';
}

// ---------- Mail: Anhänge, Markieren, Verschieben ----------

export async function mailAttachments(messageId, target, project) {
  const list = await graph('GET', `/me/messages/${encodeURIComponent(messageId)}/attachments`);
  const dir = path.resolve(project.dir, String(target || '').trim() || 'm365/anhaenge');
  if (!dir.startsWith(path.resolve(project.dir))) throw httpError(400, 'Das Ziel muss im Projektordner liegen.');
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  for (const a of list.value) {
    if (a['@odata.type'] !== '#microsoft.graph.fileAttachment' || !a.contentBytes) continue;
    const dest = path.join(dir, path.basename(a.name).replace(/[\\/]/g, '_'));
    fs.writeFileSync(dest, Buffer.from(a.contentBytes, 'base64'));
    saved.push(dest);
  }
  return saved.length ? `Gespeichert:\n${saved.join('\n')}` : '(keine Dateianhänge)';
}

export async function mailMark(messageId, how) {
  const h = String(how || '').toLowerCase();
  const body = h === 'gelesen' ? { isRead: true } : h === 'ungelesen' ? { isRead: false } : h === 'erledigt' ? { flag: { flagStatus: 'complete' } } : h === 'markiert' || h === 'flagge' ? { flag: { flagStatus: 'flagged' } } : null;
  if (!body) throw httpError(400, 'Möglich: gelesen, ungelesen, markiert, erledigt.');
  await graph('PATCH', `/me/messages/${encodeURIComponent(messageId)}`, body);
  return 'Erledigt.';
}

export async function mailMove(messageId, folder) {
  const moved = await graph('POST', `/me/messages/${encodeURIComponent(messageId)}/move`, { destinationId: await folderId(folder) });
  return `Verschoben [${moved.id}].`;
}

// ---------- Tagesüberblick ----------

export async function today() {
  const parts = await Promise.all([
    calendar(1).catch((e) => `(Kalender: ${e.message})`),
    graph('GET', `/me/mailFolders/inbox/messages?$top=25&$filter=isRead eq false&$orderby=receivedDateTime desc&${MAIL_FIELDS}`).then((d) => d.value.map(mailLine).join('\n') || '(keine)').catch((e) => `(Mail: ${e.message})`),
    teamsChats(10).catch((e) => `(Teams: ${e.message})`),
    cfg().basic ? Promise.resolve('') : tasks('').catch(() => ''),
  ]);
  return `Termine heute:\n${parts[0]}\n\nUngelesene Mails:\n${parts[1]}\n\nTeams, zuletzt aktiv:\n${parts[2]}${parts[3] ? `\n\nOffene Aufgaben:\n${parts[3]}` : ''}`;
}

// Tagesbriefing: Mo–Fr zur eingestellten Uhrzeit bekommt die Zentrale den Auftrag, den Tag
// zusammenzufassen. Die Antwort geht in den Benachrichtigungs-Chat in Teams.
setInterval(() => {
  const at = cfg().briefing;
  if (!at || !secrets.m365?.refreshToken) return;
  const now = new Date();
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const day = now.toISOString().slice(0, 10);
  if (hm < at || cfg().briefingDone === day || [0, 6].includes(now.getDay())) return;
  cfg().briefingDone = day;
  changed('settings');
  const zentrale = state.projects.find((p) => p.zentrale);
  if (!zentrale) return;
  let chat = state.chats.filter((c) => c.projectId === zentrale.id && c.status !== 'archived').sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!chat) chat = newChat(zentrale, 'Zentrale');
  if (cfg().notifyChatId) chat.teamsReply = cfg().notifyChatId;
  sendMessage(chat, 'Tagesbriefing: Hol dir mit `leitstand m365 heute` Termine, ungelesene Mails, Teams-Chats und Aufgaben. Fass für den Menschen knapp zusammen: was heute ansteht, was dringend eine Antwort braucht (mit Absender und Betreff), was du vorbereiten kannst, und welche Projekte im Leitstand gerade auf ihn warten. Höchstens 15 Zeilen.', 'Tagesbriefing');
}, 60_000).unref();

// ---------- Ausgehendes: Freigaben ----------

const KIND_LABEL = { mail: 'Mail', antwort: 'Antwort', 'teams-chat': 'Teams-Nachricht', 'teams-kanal': 'Teams-Beitrag', termin: 'Einladung' };

async function execute(f) {
  const p = f.payload;
  if (f.kind === 'mail' || f.kind === 'antwort') await graph('POST', `/me/messages/${encodeURIComponent(p.draftId)}/send`);
  else if (f.kind === 'teams-chat') await postChat(p.chatId, textToHtml(p.text));
  else if (f.kind === 'teams-kanal') await postChannel(p.teamId, p.channelId, textToHtml(p.text));
  else if (f.kind === 'termin') {
    const e = await createEvent(p.event);
    f.payload.webLink = e.webLink;
  }
  state.outbox.push({ ts: Date.now(), to: f.to, subject: `${KIND_LABEL[f.kind]}: ${f.title}`, chatId: f.chatId, projectId: f.projectId });
  state.outbox = state.outbox.slice(-200);
}

// Legt eine ausgehende Nachricht an. Mails werden sofort als Entwurf in Outlook angelegt, damit
// der Mensch sie dort auch sieht; gesendet wird erst nach Freigabe (oder sofort bei „direkt“).
export async function outbound(chat, kind, fields) {
  const text = String(fields.text || '').trim();
  if (!text && kind !== 'termin') throw httpError(400, 'Der Text ist leer (über die Standardeingabe übergeben).');
  const f = {
    id: id(), ts: Date.now(), chatId: chat.id, projectId: chat.projectId, kind, status: 'wartet',
    to: '', title: '', preview: clip(text, 1500), payload: {},
  };
  if (kind === 'termin') {
    const e = fields.event;
    const fmt = (iso) => new Date(iso).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    Object.assign(f, { to: e.attendees, title: e.subject, preview: clip(`${fmt(e.start)}–${fmt(e.end).split(', ').pop()}${e.location ? ` · ${e.location}` : ''}${e.online ? ' · Teams-Besprechung' : ''}${e.text ? `\n\n${e.text}` : ''}`, 1500), payload: { event: e } });
  }
  if (kind === 'mail') {
    const draft = await createDraft({ to: fields.to, cc: fields.cc, subject: fields.subject, text });
    Object.assign(f, { to: fields.to, title: fields.subject || '(ohne Betreff)', payload: { draftId: draft.id, webLink: draft.webLink } });
  } else if (kind === 'antwort') {
    const original = await graph('GET', `/me/messages/${encodeURIComponent(fields.messageId)}?$select=subject,from`);
    const draft = await graph('POST', `/me/messages/${encodeURIComponent(fields.messageId)}/${fields.all ? 'createReplyAll' : 'createReply'}`, { comment: text });
    Object.assign(f, { to: addr(original.from), title: `AW: ${original.subject || ''}`, payload: { draftId: draft.id, webLink: draft.webLink } });
  } else if (kind === 'teams-chat') {
    const c = await graph('GET', `/chats/${encodeURIComponent(fields.chatId)}?$expand=members`);
    Object.assign(f, { to: chatName(c), title: 'Teams-Chat', payload: { chatId: fields.chatId, text } });
  } else if (kind === 'teams-kanal') {
    Object.assign(f, { to: `Kanal ${fields.channelId}`, title: 'Teams-Kanal', payload: { teamId: fields.teamId, channelId: fields.channelId, text } });
  }
  if (cfg().sendMode === 'direkt') {
    await execute(f);
    f.status = 'gesendet';
    f.decidedAt = Date.now();
    state.freigaben = [...state.freigaben, f].slice(-300);
    changed('settings');
    return `Gesendet: ${KIND_LABEL[kind]} an ${f.to}.`;
  }
  state.freigaben = [...state.freigaben, f].slice(-300);
  changed('settings');
  return `${KIND_LABEL[kind]} an ${f.to} liegt dem Menschen zur Freigabe vor [${f.id}]${f.payload.draftId ? ' (als Entwurf in Outlook angelegt)' : ''}. Gesendet wird erst mit seinem Klick; du bekommst dann Bescheid. Arbeite weiter und erwähne es in deiner Antwort.`;
}

export const openFreigaben = (chatId) => state.freigaben.filter((f) => f.chatId === chatId && f.status === 'wartet');

export async function decideFreigabe(f, approve) {
  if (f.status !== 'wartet') throw httpError(409, 'Diese Nachricht ist schon entschieden.');
  f.decidedAt = Date.now();
  try {
    if (approve) await execute(f);
    else if (f.payload.draftId) await graph('DELETE', `/me/messages/${encodeURIComponent(f.payload.draftId)}`).catch(() => {});
    f.status = approve ? 'gesendet' : 'verworfen';
  } catch (err) {
    f.status = 'fehler';
    f.error = err.message;
  }
  changed('settings');
  const chat = findChat(f.chatId);
  if (chat && !openFreigaben(chat.id).length) {
    // Alles entschieden: Der Agent erfährt das Ergebnis und macht weiter.
    const decided = state.freigaben.filter((x) => x.chatId === chat.id && x.decidedAt && x.decidedAt >= (chat.freigabenSeen || 0));
    chat.freigabenSeen = Date.now();
    const lines = decided.map((x) => `- ${KIND_LABEL[x.kind]} an ${x.to} („${x.title}“): ${x.status === 'gesendet' ? 'gesendet' : x.status === 'verworfen' ? 'vom Menschen verworfen' : `Fehler beim Senden: ${x.error}`}`);
    if (chat.status === 'attention' && chat.attention?.kind === 'freigabe') {
      sendMessage(chat, `Entscheidung des Menschen zu deinen ausgehenden Nachrichten:\n${lines.join('\n')}\nMach damit weiter.`, approve ? 'Freigegeben' : 'Verworfen');
    } else if (chat.status !== 'archived') {
      chat.note = [chat.note, `Entscheidung des Menschen zu deinen ausgehenden Nachrichten:\n${lines.join('\n')}`].filter(Boolean).join('\n\n');
      chatChanged(chat);
    }
  }
  return f;
}

// Am Ende eines Laufs: Offene Freigaben werden zur Entscheidung für den Menschen.
attentionHooks.push((chat, attention) => {
  if (attention.kind === 'fehler') return attention;
  const open = openFreigaben(chat.id);
  if (!open.length) return attention;
  return {
    ...attention,
    kind: 'freigabe',
    frage: open.length === 1 ? `${KIND_LABEL[open[0].kind]} an ${open[0].to} senden?` : `${open.length} Nachrichten senden?`,
    freigaben: open.map((f) => f.id),
  };
});

// ---------- Teams als Kanal zum Menschen ----------

// Benachrichtigung: Braucht ein Chat den Menschen, steht das im eingestellten Teams-Chat.
const NOTIFY_KINDS = new Set(['entscheidung', 'blockiert', 'erlaubnis', 'freigabe', 'fehler', 'uebergabe', 'tresor', 'fertig', 'antwort']);
async function notify(chat, attention) {
  const target = cfg().notifyChatId;
  if (!target || !secrets.m365?.refreshToken) return;
  const project = findProject(chat.projectId);
  const base = process.env.LEITSTAND_PUBLIC_URL || '';
  const html = `<b>${MARKER} · ${textToHtml(project?.name || '')}</b>: ${textToHtml(chat.title)}<br>${textToHtml(attention.kurz || '')}${attention.frage ? `<br><i>${textToHtml(attention.frage)}</i>` : ''}${attention.optionen?.length ? `<br>Optionen: ${textToHtml(attention.optionen.join(' | '))}` : ''}${base ? `<br><a href="${base}/#chat/${chat.id}">Im Leitstand öffnen</a>` : ''}`;
  await postChat(target, html).catch(() => {});
}

// Antwort der Zentrale auf eine Teams-Nachricht geht in denselben Teams-Chat zurück.
async function replyToTeams(chat) {
  const target = chat.teamsReply;
  chat.teamsReply = null;
  const last = [...chat.messages].reverse().find((m) => m.role === 'agent');
  if (!target || !last) return;
  await postChat(target, `<b>${MARKER}</b><br>${textToHtml(clip(last.text, 20000))}`).catch(() => {});
}

attentionHooks.push((chat, attention) => {
  const project = findProject(chat.projectId);
  if (chat.teamsReply && attention.kind !== 'fehler') replyToTeams(chat);
  // Teilaufträge mit Ergebnis gehen an ihren Auftraggeber, nicht an den Menschen.
  const toHuman = !(chat.parentId && ['fertig', 'antwort', 'wartet'].includes(attention.kind));
  const zentraleQuiet = project?.zentrale && !['entscheidung', 'blockiert', 'fehler', 'freigabe'].includes(attention.kind);
  if (toHuman && !zentraleQuiet && NOTIFY_KINDS.has(attention.kind)) notify(chat, attention);
  return attention;
});

// Eingang: Neue Nachrichten im eingestellten Teams-Chat gehen an die Zentrale. Eigene
// Nachrichten des Leitstands (mit Markierung) werden übersprungen.
let polling = false;
async function pollInbound() {
  const chatId = cfg().inboundChatId;
  if (!chatId || !secrets.m365?.refreshToken || polling) return;
  polling = true;
  try {
    const data = await graph('GET', `/chats/${encodeURIComponent(chatId)}/messages?$top=20&$orderby=createdDateTime desc`);
    const since = cfg().inboundSince || 0;
    const fresh = data.value
      .filter((m) => m.messageType === 'message' && Date.parse(m.createdDateTime) > since)
      .filter((m) => !htmlToText(m.body?.content).startsWith(MARKER))
      .reverse();
    if (!since) {
      // Erster Lauf: nur die Marke setzen, nichts Altes nachholen.
      cfg().inboundSince = Date.now();
      changed('settings');
      return;
    }
    if (!fresh.length) return;
    cfg().inboundSince = Math.max(...fresh.map((m) => Date.parse(m.createdDateTime)));
    changed('settings');
    const zentrale = state.projects.find((p) => p.zentrale);
    if (!zentrale) return;
    let chat = state.chats.filter((c) => c.projectId === zentrale.id && c.status !== 'archived').sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!chat) chat = newChat(zentrale, 'Zentrale');
    chat.teamsReply = chatId;
    const text = fresh.map((m) => htmlToText(m.body?.content)).join('\n\n');
    sendMessage(chat, `(Über Teams vom Menschen; deine Antwort geht in den Teams-Chat zurück, also knapp halten.)\n\n${text}`, `Über Teams: ${text}`);
  } catch {
    // Netz oder Anmeldung: beim nächsten Mal wieder
  } finally {
    polling = false;
  }
}
setInterval(pollInbound, 30_000).unref();

// ---------- Kommando `leitstand outlook …` und `leitstand teams …` ----------

export async function m365Agent(route, param, chat, project) {
  if (!project.identity?.m365 && !project.zentrale) {
    throw httpError(403, `Microsoft 365 ist für das Projekt „${project.name}“ nicht freigeschaltet. Sag dem Menschen, dass er es unter „Projekte“ einschalten kann.`);
  }
  switch (route) {
    case 'outlook':
    case 'outlook/liste':
      return mailList(param('ordner'), param('anzahl'));
    case 'outlook/suchen':
      return mailSearch(param('begriff'));
    case 'outlook/lesen':
      return mailRead(param('id'));
    case 'outlook/kalender':
      return calendar(param('tage'));
    case 'outlook/entwurf': {
      const d = await createDraft({ to: param('an'), cc: param('cc'), subject: param('betreff'), text: param('text') });
      return `Entwurf angelegt (Ordner Entwürfe) [${d.id}]. Der Mensch kann ihn in Outlook prüfen und selbst senden.`;
    }
    case 'outlook/senden':
      return outbound(chat, 'mail', { to: param('an'), cc: param('cc'), subject: param('betreff'), text: param('text') });
    case 'outlook/termin': {
      const e = eventFields(param);
      // Ohne Teilnehmer bleibt der Termin im eigenen Kalender: direkt. Mit Teilnehmern gehen
      // Einladungen hinaus: Freigabe.
      if (!recipients(e.attendees).length) {
        const ev = await createEvent(e);
        return `Termin im eigenen Kalender angelegt: ${e.subject}, ${e.start.replace('T', ' ').slice(0, 16)}–${e.end.slice(11, 16)}${ev.webLink ? `\n${ev.webLink}` : ''}`;
      }
      return outbound(chat, 'termin', { event: e });
    }
    case 'outlook/frei':
      return freeBusy(param('wer'), param('tag'));
    case 'outlook/anhaenge':
      return mailAttachments(param('id'), param('ziel'), project);
    case 'outlook/markieren':
      return mailMark(param('id'), param('wie'));
    case 'outlook/verschieben':
      return mailMove(param('id'), param('ordner'));
    case 'm365/heute':
    case 'm365':
      return today();
    case 'm365/personen':
      return people(param('begriff'));
    case 'dateien':
    case 'dateien/liste':
      return filesList(param('ort'));
    case 'dateien/suchen':
      return filesSearch(param('begriff'));
    case 'dateien/laden':
      return filesDownload(param('id'), param('ziel'), project, param('format'));
    case 'dateien/hochladen':
      return filesUpload(param('datei'), param('ordner'), project);
    case 'aufgaben':
    case 'aufgaben/liste':
      return tasks(param('liste'));
    case 'aufgaben/neu':
      return taskAdd(param('titel'), param('faellig'), param('liste'), param('text'));
    case 'aufgaben/erledigt':
      return taskDone(param('id'));
    case 'outlook/antworten':
      return outbound(chat, 'antwort', { messageId: param('id'), all: param('alle') === '1', text: param('text') });
    case 'teams':
    case 'teams/chats':
      return teamsChats(param('anzahl'));
    case 'teams/lesen':
      return teamsRead(param('chat'), param('anzahl'));
    case 'teams/senden':
      return outbound(chat, 'teams-chat', { chatId: param('chat'), text: param('text') });
    case 'teams/kanaele':
      return teamsChannels();
    case 'teams/kanal':
      return teamsChannelRead(param('team'), param('kanal'), param('anzahl'));
    case 'teams/posten':
      return outbound(chat, 'teams-kanal', { teamId: param('team'), channelId: param('kanal'), text: param('text') });
    default:
      throw httpError(404, 'Unbekanntes Kommando');
  }
}
