// Leitstand (Arbeitsversion): Oberfläche. Kein Framework, der Server schickt Änderungen per SSE.
// Die Agenten laufen über GitHub Copilot CLI; was sie in deinem Namen über Outlook oder Teams
// senden wollen, liegt dir als „Freigabe“ vor.

const S = {
  projects: [],
  chats: new Map(),
  pages: [],
  machines: [],
  settings: {},
  secretFlags: {},
  freigaben: [],
  outbox: [],
  m365: null,
  logins: [],
  vaultSearch: '',
  contextDir: '',
  view: 'overview',
  overview: null,
  files: { projectId: null, path: '', entries: [], file: null },
  chatId: null,
  chatFilter: 'alle',
  pageName: null,
  pageContent: '',
  pageEdit: false,
};

const $ = (sel) => document.querySelector(sel);

// ---------- Hilfen ----------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Leitstand': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('Nicht angemeldet');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}
const run = (promise) => promise.catch((err) => alert(err.message));

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------- Medien im Chat ----------
// Links auf Dateien (über /files/ ausgeliefert) und Pfade in den Projektordnern erscheinen als
// Vorschau: Video und Audio mit Player, Bilder, PDFs und HTML-Seiten im Rahmen.
const MEDIA = {
  video: /\.(mp4|webm|mov|m4v)$/i,
  audio: /\.(mp3|m4a|wav|ogg|oga)$/i,
  image: /\.(png|jpe?g|gif|webp|svg|avif)$/i,
  pdf: /\.pdf$/i,
  page: /\.html?$/i,
};
const MEDIA_EXT = 'mp4|webm|mov|m4v|mp3|m4a|wav|ogg|oga|png|jpe?g|gif|webp|svg|avif|pdf|html?';
const MAX_EMBEDS = 8;
let EMBED = { count: 0, seen: new Set() };

function mediaKind(url) {
  const bare = url.replace(/&amp;/g, '&').split(/[?#]/)[0];
  const local = bare.startsWith('/files/');
  for (const [kind, re] of Object.entries(MEDIA)) if (re.test(bare)) return local || ['video', 'audio', 'image'].includes(kind) ? kind : null;
  return local && bare.endsWith('/') ? 'page' : null;
}

function embed(title, url) {
  const link = `<a href="${url}" target="_blank" rel="noopener">${title}</a>`;
  const kind = mediaKind(url);
  if (!kind || EMBED.count >= MAX_EMBEDS || EMBED.seen.has(url)) return link;
  EMBED.count += 1;
  EMBED.seen.add(url);
  const open = `<span class="embed-cap">${link} · <a href="${url}" target="_blank" rel="noopener">In neuem Tab öffnen</a></span>`;
  if (kind === 'video') return `<span class="embed"><video src="${url}" controls preload="metadata" playsinline></video>${open}</span>`;
  if (kind === 'audio') return `<span class="embed"><audio src="${url}" controls preload="metadata"></audio>${open}</span>`;
  if (kind === 'image') return `<span class="embed"><a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${title}" loading="lazy"></a>${open}</span>`;
  if (kind === 'pdf') return `<span class="embed"><iframe class="embed-doc" src="${url}" loading="lazy" title="${title}"></iframe>${open}</span>`;
  return `<span class="embed"><iframe class="embed-page" src="${url}" loading="lazy" sandbox="allow-scripts allow-forms allow-popups" title="${title}"></iframe>${open}</span>`;
}

// Pfade in den Projektordnern dieses Rechners zu /files/-Links machen (nur Medien, nicht in Codeblöcken).
function mediaLinks(line, project) {
  // Alles läuft auf diesem Rechner: jeder Projektordner ist über /files/ erreichbar.
  const local = (S.allProjects || S.projects || []).filter((p) => p.dir);
  const toUrl = (abs) => {
    const p = local.filter((x) => abs.startsWith(x.dir.replace(/\/+$/, '') + '/')).sort((a, b) => b.dir.length - a.dir.length)[0];
    if (!p) return null;
    return fileUrl(p.id, abs.slice(p.dir.replace(/\/+$/, '').length + 1)) + (abs.endsWith('/') ? '/' : '');
  };
  const name = (abs) => abs.replace(/\/+$/, '').split('/').pop();
  const ext = new RegExp(`\\.(?:${MEDIA_EXT})$`, 'i');
  // [Titel](/home/…) -> [Titel](/files/…)
  line = line.replace(/\]\((\/[^\s)]+)\)/g, (m, abs) => (toUrl(abs) ? `](${toUrl(abs)})` : m));
  // `pfad` oder nackter absoluter Pfad mit Medien-Endung
  line = line.replace(/(`?)((?:\/|~\/)[^\s`'"()<>\[\]]+)\1/g, (m, tick, raw, offset, all) => {
    if (all.slice(Math.max(0, offset - 2), offset) === '](') return m;
    const abs = raw.replace(/[.,;:!?]+$/, '');
    if (!ext.test(abs)) return m;
    const url = toUrl(abs);
    return url ? `[${name(abs)}](${url})${raw.slice(abs.length)}` : m;
  });
  // `relativer/pfad.mp4` im eigenen Projektordner
  if (project?.dir) {
    line = line.replace(/`([^`\s/][^`\s]*)`/g, (m, rel) => (ext.test(rel) && !/^[a-z]+:/i.test(rel) && !rel.includes('..') ? `[${name(rel)}](${fileUrl(project.id, rel)})` : m));
  }
  return line;
}

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/files\/)[^\s)]+)\)/g, (m, title, url) => embed(title, url));
}

// Kleines Markdown: Überschriften, Listen, Code, Absätze. Alles wird vorher maskiert.
function md(text, project = null) {
  EMBED = { count: 0, seen: new Set() };
  const out = [];
  const lines = String(text ?? '').split('\n');
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.trim().startsWith('```')) {
      flushPara();
      flushList();
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i++]);
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    line = mediaLinks(line, project);
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (heading) {
      flushPara();
      flushList();
      const level = Math.min(heading[1].length + 1, 4);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (bullet || numbered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push((bullet || numbered)[1]);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else if (list && /^\s+\S/.test(line)) {
      list.items[list.items.length - 1] += ' ' + line.trim();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return out.join('');
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === ';') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function ago(ts) {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return 'jetzt';
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} h` : `${Math.round(h / 24)} T`;
}
const when = (ts) => (ts ? new Date(ts).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '');

const projectOf = (chat) => (S.allProjects || S.projects).find((p) => p.id === chat.projectId);
// Die Zentrale ist kein Projekt für dich: ein einzelner Chat ganz oben, intern über einen versteckten Eintrag.
const isZentrale = (chat) => Boolean(chat && projectOf(chat)?.zentrale);
const zentraleChat = () => [...S.chats.values()].filter((c) => isZentrale(c) && c.status !== 'archived').sort((a, b) => b.createdAt - a.createdAt)[0];
function setProjects(list) {
  S.allProjects = list;
  S.projects = list.filter((p) => !p.zentrale);
}
const isSnoozed = (chat) => chat.snoozeUntil && chat.snoozeUntil > Date.now();
const chatList = () => [...S.chats.values()];

// Ausgehende Nachrichten (Outlook, Teams), die auf deine Freigabe warten.
const openFreigaben = (chat) => S.freigaben.filter((f) => f.chatId === chat.id && f.status === 'wartet');
const waitingFreigaben = () => S.freigaben.filter((f) => f.status === 'wartet');

// Was auf dich wartet: zuerst alles, was eine Entscheidung braucht, danach fertige Ergebnisse.
const needsDecision = (chat) => chat.attention?.kind !== 'fertig';
const rank = (chat) => (needsDecision(chat) ? 1 : 2);
const waitingSince = (chat) => chat.attention?.since || openFreigaben(chat)[0]?.ts || 0;
function queue() {
  return chatList()
    .filter((c) => (c.status === 'attention' && !isSnoozed(c)) || (c.status !== 'archived' && openFreigaben(c).length))
    .sort((a, b) => rank(a) - rank(b) || waitingSince(a) - waitingSince(b));
}
const childrenOf = (chat) => chatList().filter((c) => c.parentId === chat.id);
// Beendet und samt eigener Teilaufträge entfernbar (wie isFinished/canRemove in lib/runs.js).
const isFinishedChat = (c) =>
  ['done', 'idle', 'archived'].includes(c.status) ||
  (c.status === 'attention' && (Boolean(c.stopped) || ['fertig', 'fehler', 'antwort'].includes(c.attention?.kind)));
const canRemoveChat = (c) => c.status !== 'archived' && isFinishedChat(c) && childrenOf(c).every((k) => k.status === 'archived' || canRemoveChat(k) );

const KIND_LABEL = {
  entscheidung: 'Entscheidung',
  erlaubnis: 'Erlaubnis',
  freigabe: 'Freigabe',
  tresor: 'Tresor',
  fertig: 'Fertig',
  blockiert: 'Blockiert',
  antwort: 'Antwort',
  fehler: 'Fehler',
  uebergabe: 'Selbst erledigen',
};
// Art einer ausgehenden Nachricht (wie KIND_LABEL in lib/m365.js)
const SEND_LABEL = { mail: 'Mail', antwort: 'Antwort', 'teams-chat': 'Teams-Nachricht', 'teams-kanal': 'Teams-Beitrag', termin: 'Einladung' };
const FREIGABE_STATUS = { wartet: ['wartet', 'busy'], gesendet: ['gesendet', 'ok'], verworfen: ['verworfen', ''], fehler: ['Fehler', 'bad'] };
// Was der Chat gerade von dir braucht; offene Freigaben auch dann, wenn der Agent noch weiterarbeitet.
const attentionKind = (chat) => (chat.status === 'attention' && chat.attention?.kind) || (openFreigaben(chat).length ? 'freigabe' : '');

function dotClass(chat) {
  if (chat.status === 'running') return 'running';
  if (chat.status === 'queued' || chat.status === 'waiting') return 'queued';
  if (chat.status === 'attention') return chat.attention?.kind === 'fehler' ? 'fehler' : isSnoozed(chat) ? '' : 'attention';
  if (chat.status === 'done') return 'done';
  return '';
}

// ---------- Aktionen ----------

const act = (chatId, action, extra = {}) => run(api('POST', `/api/chats/${chatId}/action`, { action, ...extra }));
const decideFreigabe = (id, send) => run(api('POST', `/api/freigaben/${encodeURIComponent(id)}/${send ? 'senden' : 'verwerfen'}`));

function selectChat(chatId) {
  // Ein fertiges Ergebnis gilt als erledigt, sobald du es angesehen hast und weitergehst.
  const previous = S.chats.get(S.chatId);
  if (previous && previous.id !== chatId && previous.status === 'attention' && previous.attention?.kind === 'fertig') {
    act(previous.id, 'done');
  }
  S.chatId = chatId;
  setView('chats');
  document.body.classList.toggle('detail', Boolean(chatId));
  buildChat();
  renderAll();
}

function goNext() {
  const q = queue();
  if (!q.length) return;
  const index = q.findIndex((c) => c.id === S.chatId);
  selectChat(q[(index + 1) % q.length].id);
}

const focusComposer = () => $('#composer-input')?.focus();

// ---------- Kopfzeile und Warteschlange ----------

function renderMeters() {
  const chats = chatList();
  const runningCount = chats.filter((c) => c.status === 'running').length;
  const queuedCount = chats.filter((c) => c.status === 'queued').length;
  const sends = waitingFreigaben().length;
  $('#meter-running').textContent = [
    runningCount ? `${runningCount} ${runningCount === 1 ? 'läuft' : 'laufen'}` : '',
    queuedCount ? `${queuedCount} in der Schlange` : '',
  ].filter(Boolean).join(' · ');
  const badge = $('#tab-freigaben-count');
  if (badge) {
    badge.textContent = sends || '';
    badge.hidden = !sends;
  }
}

function primaryAction(chat) {
  const a = chat.attention;
  if (!a || chat.status !== 'attention') return null;
  if (a.kind === 'entscheidung' && !a.optionen?.length) return { label: 'Freigeben', go: () => act(chat.id, 'approve') };
  if (a.kind === 'erlaubnis') return { label: 'Erlauben', go: () => act(chat.id, 'allow') };
  if (a.kind === 'fertig') return { label: 'Erledigt', go: () => act(chat.id, 'done') };
  return null;
}

function renderCapsule() {
  const el = $('#capsule');
  const q = queue();
  if (!q.length || S.view !== 'chats') {
    el.hidden = true;
    return;
  }
  const current = q.find((c) => c.id === S.chatId) || q[0];
  const selected = current.id === S.chatId;
  const kind = attentionKind(current) || 'freigabe';
  const primary = selected ? primaryAction(current) : null;
  el.hidden = false;
  el.innerHTML = `
    <span class="dot ${kind === 'fehler' ? 'fehler' : 'attention'}"></span>
    <span class="where">${esc(projectOf(current)?.name || '')} · ${esc(KIND_LABEL[kind] || kind)}</span>
    <span class="what" title="${esc(current.attention?.kurz || '')}">${esc(current.title)}</span>
    ${selected ? '' : '<button class="primary" data-a="open">Öffnen</button>'}
    ${primary ? `<button class="primary" data-a="primary">${esc(primary.label)}</button>` : ''}
    ${current.status === 'attention' ? '<button data-a="snooze" title="Für eine Stunde ausblenden">Später</button><button data-a="done" title="Aus der Warteschlange nehmen">Nicht mehr nötig</button>' : ''}
    <span class="count">${[q.filter(needsDecision).length && `${q.filter(needsDecision).length} zu entscheiden`, q.filter((c) => !needsDecision(c)).length && `${q.filter((c) => !needsDecision(c)).length} fertig`].filter(Boolean).join(' · ')}</span>
    <button data-a="next" title="Leertaste">Weiter <kbd>␣</kbd></button>`;
  el.onclick = (event) => {
    const a = event.target.closest('button')?.dataset.a;
    if (a === 'open') selectChat(current.id);
    else if (a === 'primary') primary.go();
    else if (a === 'snooze') act(current.id, 'snooze');
    else if (a === 'done') act(current.id, 'done');
    else if (a === 'next') goNext();
  };
}

// ---------- Übersicht ----------
// Die Startseite: was dich braucht, was läuft, was die Agenten gebaut haben, welche Nachrichten
// auf deine Freigabe warten und welche Konten die Agenten angelegt haben.

const fileUrl = (projectId, relative) => `/files/${projectId}/${String(relative || '').split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
const topOrders = () => chatList().filter((c) => !c.parentId && c.status !== 'archived').sort((a, b) => b.createdAt - a.createdAt);

async function loadOverview() {
  renderOverview();
  const overview = await api('GET', '/api/overview').catch(() => null);
  S.overview = overview || { sites: [], recent: [], folders: [], results: [] };
  if (S.view === 'overview') renderOverview();
}

// Eine ausgehende Nachricht: Art, Empfänger, Titel, Vorschau, Herkunft und (wenn sie wartet) Knöpfe.
// withChat: Link zum Chat anzeigen (nicht nötig, wenn sie im Chat selbst steht).
function freigabeHtml(f, { withChat = true, buttons = true } = {}) {
  const chat = S.chats.get(f.chatId);
  const project = (S.allProjects || S.projects).find((p) => p.id === f.projectId);
  const [statusLabel, tone] = FREIGABE_STATUS[f.status] || [f.status, ''];
  const meta = [
    project?.name || '',
    withChat && chat ? `<button class="link" data-chat="${esc(chat.id)}">${esc(chat.title)}</button>` : '',
    esc(when(f.decidedAt || f.ts)),
    f.payload?.webLink ? `<a href="${esc(f.payload.webLink)}" target="_blank" rel="noopener">Entwurf in Outlook</a>` : '',
  ].filter(Boolean);
  return `<div class="freigabe ${f.status}" data-freigabe="${esc(f.id)}">
    <div class="f-head"><span class="badge">${esc(SEND_LABEL[f.kind] || f.kind)}</span><b>an ${esc(f.to || '?')}</b>${f.title ? `<span class="f-title">${esc(f.title)}</span>` : ''}${f.status !== 'wartet' ? `<span class="badge ${tone}">${esc(statusLabel)}</span>` : ''}</div>
    ${f.preview ? `<div class="f-preview">${esc(f.preview)}</div>` : ''}
    ${f.error ? `<p class="note warn" style="margin:0">${esc(f.error)}</p>` : ''}
    <div class="f-meta">${meta.join(' · ')}</div>
    ${buttons && f.status === 'wartet' ? '<div class="row"><button class="primary" data-send="1">Senden</button><button data-send="0">Verwerfen</button></div>' : ''}
  </div>`;
}

function overviewLive() {
  const chats = chatList();
  const decisions = queue().filter(needsDecision);
  const running = chats.filter((c) => c.status === 'running').length;
  const sends = waitingFreigaben();
  const stats = [
    [decisions.length, 'zu entscheiden'],
    [running, running === 1 ? 'Agent arbeitet' : 'Agenten arbeiten'],
    [chats.filter((c) => c.status === 'queued').length, 'in der Schlange'],
    [sends.length, sends.length === 1 ? 'Nachricht wartet auf Freigabe' : 'Nachrichten warten auf Freigabe'],
  ];
  const needs = decisions.map((c) => {
    const kind = attentionKind(c);
    const open = openFreigaben(c).length;
    const text = c.attention?.frage || (open ? `${open} ${open === 1 ? 'Nachricht' : 'Nachrichten'} zur Freigabe` : '') || c.attention?.kurz || '';
    return `<button class="list-row" data-chat="${c.id}"><div class="main"><b>${esc(KIND_LABEL[kind] || '')}: ${esc(c.title)}</b><span>${esc(text)}</span></div><div class="side">${esc(ago(waitingSince(c)))}</div></button>`;
  }).join('');
  const orders = topOrders().slice(0, 8).map((c) => {
    const kids = childrenOf(c);
    const done = kids.filter((k) => k.status === 'done').length;
    const label = {
      running: 'arbeitet', queued: 'in der Schlange', waiting: 'Teilaufträge laufen', done: 'erledigt', idle: 'bereit',
      attention: c.attention?.kind === 'fertig' ? 'fertig' : 'wartet auf dich',
    }[c.status] || c.status;
    const tone = c.status === 'attention' && c.attention?.kind !== 'fertig' ? 'busy' : c.status === 'done' || c.attention?.kind === 'fertig' ? 'ok' : '';
    const moving = [c, ...kids].filter((k) => k.status === 'running').map((k) => k.progress?.text || k.activity).filter(Boolean)[0];
    const last = c.attention?.kurz || moving || c.waitingFor || '';
    return `<button class="list-row" data-chat="${c.id}"><div class="main">
        <b>${esc(c.title)} <span class="badge ${tone}">${esc(label)}</span></b>
        <span>${esc(projectOf(c)?.name || '')}${kids.length ? ` · ${done} von ${kids.length} Teilaufträgen fertig` : ''}${last ? ` · ${esc(last)}` : ''}</span>
        ${kids.length ? bar(done, kids.length) : ''}
      </div><div class="side">${esc(ago(c.createdAt))}</div></button>`;
  }).join('');
  const m = S.m365 || {};
  const sendsHtml = `<div class="head-row"><h2>Freigaben</h2><button class="ghost" data-view-go="freigaben">Alle</button></div>
    <p class="note" style="margin-top:0">${m.signedIn ? `Microsoft 365: ${esc(m.account || 'angemeldet')}` : 'Microsoft 365 ist nicht angemeldet (Einstellungen).'}${S.settings.m365?.sendMode === 'direkt' ? ' · Versand direkt, ohne Freigabe' : ''}</p>
    ${sends.slice(0, 5).map((f) => freigabeHtml(f)).join('') || '<p class="note">Nichts wartet. Was Agenten über Outlook oder Teams senden wollen, steht hier zur Freigabe.</p>'}
    ${sends.length > 5 ? `<p class="note">und ${sends.length - 5} weitere unter „Freigaben“</p>` : ''}`;
  return { stats, needs, orders, sendsHtml };
}

function renderOverview() {
  const el = $('#overview');
  const live = overviewLive();
  const ov = S.overview;

  const sites = (ov?.sites || []).map((site) => `<div class="site">
      <a class="thumb" href="${fileUrl(site.projectId, site.path)}/" target="_blank" rel="noopener" title="In neuem Tab öffnen">
        <iframe src="${fileUrl(site.projectId, site.path)}/" sandbox="allow-scripts" loading="lazy" tabindex="-1" aria-hidden="true"></iframe>
      </a>
      <div class="site-meta"><b>${esc(site.title)}</b><span>${esc(site.project)} · ${esc(site.path || 'Projektordner')} · ${esc(ago(site.mtime))}</span></div>
      <div class="row"><a class="button primary" href="${fileUrl(site.projectId, site.path)}/" target="_blank" rel="noopener">Öffnen</a><button data-files="${site.projectId}" data-path="${esc(site.path)}">Dateien</button></div>
    </div>`).join('');
  const results = (ov?.results || []).map((r) => {
    const href = /^https?:\/\//.test(r.target) ? r.target : fileUrl(r.projectId, r.target);
    return `<a class="list-row" href="${esc(href)}" target="_blank" rel="noopener"><div class="main"><b>${esc(r.title)}</b><span>${esc(r.note || r.target)}</span></div><div class="side">${esc(ago(r.ts))}</div></a>`;
  }).join('');
  const folders = (ov?.folders || []).map((f) => `<button class="chip-button" data-files="${f.projectId}" data-path="${esc(f.path)}">${esc(f.path.split('/').pop())} <span>${f.files} Dateien</span></button>`).join('');
  const recent = (ov?.recent || []).slice(0, 8).map((f) => `<button class="list-row" data-files="${f.projectId}" data-path="${esc(f.path.split('/').slice(0, -1).join('/'))}" data-file="${esc(f.path)}"><div class="main"><b>${esc(f.path.split('/').pop())}</b><span>${esc(f.project)} · ${esc(f.path.split('/').slice(0, -1).join('/'))}</span></div><div class="side">${esc(ago(f.mtime))}</div></button>`).join('');

  const accounts = S.logins.slice(0, 8).map((e) => `<div class="list-row"><div class="main"><b>${esc(e.name)}${e.hasTotp ? ' <span class="badge ok">2FA</span>' : ''}</b><span>${esc(e.user || 'ohne Benutzername')}</span></div><div class="side">${esc(scopeName(e.scope))}</div></div>`).join('');
  const sent = [...S.outbox].reverse().slice(0, 5).map((o) => `<div class="list-row"><div class="main"><b>${esc(o.subject)}</b><span>an ${esc(o.to)}${o.projectId ? ` · ${esc((S.allProjects || S.projects).find((p) => p.id === o.projectId)?.name || '')}` : ''}</span></div><div class="side">${esc(when(o.ts))}</div></div>`).join('');

  el.innerHTML = `<div class="inner wide">
    <div class="head-row"><h1>Übersicht</h1><button class="primary" id="ov-new">Neuer Auftrag</button></div>
    <div class="stats" id="ov-stats">${live.stats.map(([n, label]) => `<div class="stat"><b>${esc(n)}</b><span>${esc(label)}</span></div>`).join('')}</div>
    ${setupCard()}
    <div class="ov-grid">
      <div class="ov-col">
        <div class="card" id="ov-needs" ${live.needs ? '' : 'hidden'}><h2>Braucht dich</h2><div id="ov-needs-list">${live.needs}</div></div>
        <div class="card"><h2>Aufträge</h2><div id="ov-orders">${live.orders || '<p class="note">Noch kein Auftrag. Mit „Neuer Auftrag“ gibst du einem Lead-Agenten ein Vorhaben; er verteilt die Arbeit selbst auf weitere Agenten.</p>'}</div></div>
        <div class="card"><h2>Was die Agenten gebaut haben</h2>
          ${!ov ? '<p class="note">Lädt …</p>' : ''}
          ${sites ? `<div class="sites">${sites}</div>` : ''}
          ${results ? `<h3 class="section-title">Gemeldete Ergebnisse</h3>${results}` : ''}
          ${folders ? `<h3 class="section-title">Ordner</h3><div class="chips">${folders}</div>` : ''}
          ${recent ? `<h3 class="section-title">Zuletzt geändert</h3>${recent}` : ''}
          ${ov && !sites && !results && !folders && !recent ? '<p class="note">Noch nichts. Websites, Dokumente und Listen der Agenten erscheinen hier mit Vorschau.</p>' : ''}
        </div>
      </div>
      <div class="ov-col">
        <div class="card" id="ov-sends">${live.sendsHtml}</div>
        <div class="card" id="ov-sent" ${sent ? '' : 'hidden'}><h2>Zuletzt gesendet</h2><div id="ov-sent-list">${sent}</div></div>
        <div class="card"><div class="head-row"><h2>Konten der Agenten</h2><button class="ghost" data-view-go="vault">Tresor</button></div>
          ${accounts || '<p class="note">Noch keine. Legt ein Agent irgendwo ein Konto an, steht es hier und im Tresor.</p>'}</div>
      </div>
    </div>
  </div>`;
  $('#ov-new').onclick = () => newChatDialog();
}

// Nur die beweglichen Teile auffrischen, damit die Vorschauen nicht neu laden.
function refreshOverviewLive() {
  if (S.view !== 'overview' || !$('#ov-stats')) return;
  const live = overviewLive();
  $('#ov-stats').innerHTML = live.stats.map(([n, label]) => `<div class="stat"><b>${esc(n)}</b><span>${esc(label)}</span></div>`).join('');
  $('#ov-needs').hidden = !live.needs;
  $('#ov-needs-list').innerHTML = live.needs;
  if (live.orders) $('#ov-orders').innerHTML = live.orders;
  $('#ov-sends').innerHTML = live.sendsHtml;
}

// Senden/Verwerfen-Knöpfe einer Freigabe, wo immer sie außerhalb eines Chats steht.
function onFreigabeClick(event) {
  const button = event.target.closest('button[data-send]');
  const id = button && event.target.closest('[data-freigabe]')?.dataset.freigabe;
  if (!id) return false;
  const send = button.dataset.send === '1';
  const f = S.freigaben.find((x) => x.id === id);
  if (!send && !confirm(`${SEND_LABEL[f?.kind] || 'Nachricht'} an ${f?.to || '?'} verwerfen? Ein Outlook-Entwurf wird dabei gelöscht.`)) return true;
  button.disabled = true;
  decideFreigabe(id, send);
  return true;
}

$('#overview').addEventListener('click', (event) => {
  if (onFreigabeClick(event)) return;
  const chatId = event.target.closest('[data-chat]')?.dataset.chat;
  if (chatId) return selectChat(chatId);
  const go = event.target.closest('[data-view-go]')?.dataset.viewGo;
  if (go) return setView(go);
  const files = event.target.closest('[data-files]');
  if (files) {
    S.files = { ...S.files, projectId: files.dataset.files, path: files.dataset.path || '', file: files.dataset.file || null };
    setView('files');
  }
});

// ---------- Dateien ----------

const TEXT_FILE = /\.(md|txt|csv|json|js|mjs|ts|tsx|jsx|css|py|sh|yml|yaml|toml|xml|env|sql)$/i;
const IMAGE_FILE = /\.(png|jpe?g|webp|gif|svg|ico)$/i;
const VIDEO_FILE = /\.(mp4|webm|mov)$/i;
const AUDIO_FILE = /\.(mp3|m4a|wav|ogg)$/i;

async function openFiles(projectId, relative = '', file = null) {
  const local = S.projects;
  const project = local.find((p) => p.id === projectId) || local[0];
  if (!project) {
    $('#files-list').innerHTML = '<p class="hint">Noch kein Projekt.</p>';
    $('#files-preview').innerHTML = '';
    return;
  }
  let entries = [];
  let error = '';
  try {
    entries = await api('GET', `/api/projects/${project.id}/files?path=${encodeURIComponent(relative)}`);
  } catch (err) {
    error = err.message;
  }
  S.files = { projectId: project.id, path: relative, entries, file, error };
  document.body.classList.toggle('detail', Boolean(file));
  renderFiles();
}

function renderFiles() {
  const { projectId, path: relative, entries, file, error } = S.files;
  const local = S.projects;
  const parts = relative.split('/').filter(Boolean);
  const crumbs = [`<button class="crumb" data-path="">${esc(S.projects.find((p) => p.id === projectId)?.name || '')}</button>`,
    ...parts.map((part, i) => `<button class="crumb" data-path="${esc(parts.slice(0, i + 1).join('/'))}">${esc(part)}</button>`)].join('<span class="sep">/</span>');
  $('#files-list').innerHTML = `
    ${local.length > 1 ? `<select id="files-project">${local.map((p) => `<option value="${p.id}" ${p.id === projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : ''}
    <div class="crumbs">${crumbs}</div>
    ${error ? `<p class="hint">${esc(error)}</p>` : ''}
    ${entries.map((e) => {
      const full = [...parts, e.name].join('/');
      return `<button class="item ${file === full ? 'active' : ''}" data-${e.dir ? 'path' : 'file'}="${esc(full)}"><span class="label">${e.dir ? '▸ ' : ''}${esc(e.name)}</span><span class="meta">${e.dir ? '' : esc(ago(e.mtime))}</span></button>`;
    }).join('') || (error ? '' : '<p class="hint">Leer.</p>')}`;
  const select = $('#files-project');
  if (select) select.onchange = () => openFiles(select.value, '');
  renderFilePreview();
}

async function renderFilePreview() {
  const { projectId, path: relative, entries, file } = S.files;
  const el = $('#files-preview');
  const hasIndex = entries.some((e) => !e.dir && e.name === 'index.html');
  const target = file || (hasIndex ? [relative, 'index.html'].filter(Boolean).join('/') : null);
  if (!target) {
    el.innerHTML = '<div class="empty"><h2>Dateien der Agenten</h2><p>Alles, was im Projektordner entsteht. Websites siehst du direkt als Vorschau, Texte und Tabellen lesbar aufbereitet.</p></div>';
    return;
  }
  const url = fileUrl(projectId, target);
  const head = `<div class="page-head"><button class="ghost back" data-a="back" aria-label="Zurück zur Liste">←</button><h1>${esc(target.split('/').pop())}</h1><a class="button" href="${url}" target="_blank" rel="noopener">In neuem Tab öffnen</a></div>`;
  let body;
  if (/\.html?$/i.test(target)) body = `<iframe class="preview-frame" src="${url}" sandbox="allow-scripts allow-forms allow-popups"></iframe>`;
  else if (IMAGE_FILE.test(target)) body = `<div class="page-body"><img src="${url}" alt="" style="max-width:100%"></div>`;
  else if (VIDEO_FILE.test(target)) body = `<div class="page-body"><video src="${url}" controls preload="metadata" playsinline style="width:100%;max-height:80vh;background:#000"></video></div>`;
  else if (AUDIO_FILE.test(target)) body = `<div class="page-body"><audio src="${url}" controls preload="metadata" style="width:100%"></audio></div>`;
  else if (/\.pdf$/i.test(target)) body = `<iframe class="preview-frame" src="${url}"></iframe>`;
  else if (TEXT_FILE.test(target)) {
    const text = await fetch(url).then((r) => r.text()).catch(() => '');
    if (S.files.file !== file) return; // inzwischen etwas anderes gewählt
    if (/\.md$/i.test(target)) body = `<div class="page-body"><div class="doc msg agent">${md(text)}</div></div>`;
    else if (/\.csv$/i.test(target)) {
      const rows = parseCsv(text).slice(0, 2000);
      body = `<div class="page-body"><table class="grid"><thead><tr>${(rows[0] || []).map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    } else body = `<div class="page-body"><pre><code>${esc(text.slice(0, 300000))}</code></pre></div>`;
  } else body = `<div class="empty"><p>Für diesen Dateityp gibt es keine Vorschau.</p><a class="button primary" href="${url}" target="_blank" rel="noopener">Öffnen</a></div>`;
  el.innerHTML = head + body;
  el.querySelector('[data-a="back"]').onclick = () => {
    S.files.file = null;
    document.body.classList.remove('detail');
    renderFiles();
  };
}

$('#files-list').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-path], button[data-file]');
  if (!button) return;
  if (button.dataset.file !== undefined) {
    S.files.file = button.dataset.file;
    document.body.classList.add('detail');
    renderFiles();
  } else {
    openFiles(S.files.projectId, button.dataset.path);
  }
});

// ---------- Einrichtung ----------

// Was noch fehlt. Jeder Punkt führt dorthin, wo er erledigt wird. Ob Copilot auf diesem Rechner
// angemeldet ist, sieht die Oberfläche nicht; das zeigt sich am ersten Lauf.
function setupSteps() {
  return [
    {
      done: S.projects.length > 0,
      title: 'Erstes Projekt anlegen',
      hint: 'Ein Projekt ist ein Ordner auf diesem Rechner mit eigenen Lead-Agenten (GitHub Copilot CLI).',
      go: 'project',
      button: 'Projekt anlegen',
    },
    {
      done: Boolean(S.m365?.signedIn || S.secretFlags.m365),
      title: 'Microsoft 365 anmelden',
      hint: 'Damit lesen die Agenten Outlook und Teams und legen dir Nachrichten zur Freigabe vor. Anmeldung per Code mit deinem Arbeitskonto.',
      go: 'm365',
      button: 'Anmelden',
    },
  ];
}

function setupCard() {
  const steps = setupSteps();
  if (steps.every((s) => s.done)) return '';
  const open = steps.filter((s) => !s.done).length;
  return `<div class="card setup">
    <h2>Einrichtung <span class="badge">${open} offen</span></h2>
    ${steps.map((s) => `<div class="setup-step ${s.done ? 'done' : ''}">
      <span class="check" aria-hidden="true">${s.done ? '✓' : ''}</span>
      <div class="main"><b>${esc(s.title)}</b>${s.done ? '' : `<span>${esc(s.hint)}</span>`}</div>
      ${!s.done && s.go ? `<button data-go="${s.go}">${esc(s.button)}</button>` : ''}
    </div>`).join('')}
  </div>`;
}

document.addEventListener('click', (event) => {
  const go = event.target.closest('[data-go]')?.dataset.go;
  if (!go) return;
  if (go === 'project') {
    setView('projects');
    newProjectDialog();
  } else {
    setView('settings');
    renderSettings();
    const form = $(`#settings [data-section="${go}"]`);
    form?.scrollIntoView({ block: 'start' });
  }
});

// ---------- Chat-Liste ----------

function renderZentraleEntry() {
  const el = $('#zentrale-entry');
  if (!el) return;
  const chat = zentraleChat();
  const state = !chat ? '' : chat.status === 'running' || chat.status === 'queued' ? 'denkt …' : chat.status === 'attention' ? 'fragt dich etwas' : 'bereit';
  el.className = `zentrale-entry ${chat && chat.id === S.chatId ? 'active' : ''}`;
  el.innerHTML = `<span class="z-icon" aria-hidden="true">◎</span>
    <span class="z-text"><b>Zentrale</b><span>Überblick, Fragen, Abstimmung über alle Projekte</span></span>
    ${chat ? `<span class="z-state"><span class="dot ${dotClass(chat)}"></span>${esc(state)}</span>` : ''}`;
}

async function openZentrale() {
  let chat = zentraleChat();
  if (!chat) {
    chat = await api('POST', '/api/zentrale', {});
    S.chats.set(chat.id, chat);
  }
  selectChat(chat.id);
}

function renderChatList() {
  renderZentraleEntry();
  const all = chatList().filter((c) => c.status !== 'archived' && !isZentrale(c));
  const counts = {
    alle: all.length,
    warten: all.filter((c) => c.status === 'attention' && !isSnoozed(c)).length,
    laufen: all.filter((c) => ['running', 'queued', 'waiting'].includes(c.status)).length,
  };
  $('#chat-filter').innerHTML = [['alle', 'Alle'], ['warten', 'Warten auf dich'], ['laufen', 'Laufen']]
    .map(([key, label]) => `<button data-filter="${key}" class="${S.chatFilter === key ? 'active' : ''}">${label} ${counts[key]}</button>`)
    .join('');

  const el = $('#chat-list');
  if (!S.projects.length) {
    el.innerHTML = '<p class="hint">Leg zuerst unter „Projekte“ ein Projekt an. Jedes Projekt bekommt einen eigenen Lead-Agenten.</p>';
    return;
  }
  const visible = (c) =>
    S.chatFilter === 'alle' ||
    (S.chatFilter === 'warten' && c.status === 'attention' && !isSnoozed(c)) ||
    (S.chatFilter === 'laufen' && ['running', 'queued', 'waiting'].includes(c.status));
  const html = [];
  for (const project of S.projects) {
    const mine = all.filter((c) => c.projectId === project.id && visible(c));
    const isChild = (c) => c.parentId && mine.some((p) => p.id === c.parentId);
    // Neueste Aufträge oben, darunter jeweils ihre Teilaufträge (auch verschachtelte) in der Reihenfolge der Vergabe.
    const depth = new Map();
    const withKids = (c, d) => {
      depth.set(c.id, d);
      return [c, ...mine.filter((k) => k.parentId === c.id).sort((a, b) => a.createdAt - b.createdAt).flatMap((k) => withKids(k, d + 1))];
    };
    const chats = mine
      .filter((c) => !isChild(c))
      .sort((a, b) => b.createdAt - a.createdAt)
      .flatMap((c) => withKids(c, 0));
    if (!chats.length && S.chatFilter !== 'alle') continue;
    html.push(`<div class="group-title"><span>${esc(project.name)}</span><span class="group-side"><button class="group-add" data-new="${project.id}" title="Neuer Chat in „${esc(project.name)}“" aria-label="Neuer Chat in ${esc(project.name)}">+</button></span></div>`);
    if (!chats.length) html.push('<p class="hint">Noch kein Auftrag.</p>');
    for (const chat of chats) {
      const meta =
        openFreigaben(chat).length && chat.status !== 'attention' ? 'Freigabe'
        : chat.status === 'running' ? (chat.crew ? `Crew ${chat.crew}` : 'läuft')
        : chat.status === 'queued' ? 'Schlange'
        : chat.status === 'waiting' ? 'wartet'
        : isSnoozed(chat) ? 'später'
        : ago(chat.attention?.since || chat.createdAt);
      const d = depth.get(chat.id) || 0;
      html.push(`<button class="item ${chat.id === S.chatId ? 'active' : ''} ${chat.status === 'done' ? 'dim' : ''} ${d ? 'child' : ''}" data-chat="${chat.id}" ${d > 1 ? `style="padding-left:${12 + d * 14}px"` : ''}>
        <span class="dot ${dotClass(chat)}"></span>
        <span class="label">${esc(chat.title)}</span>
        <span class="meta">${esc(meta)}</span>
        ${d && canRemoveChat(chat) ? `<span class="item-x" role="button" data-remove="${chat.id}" title="Beendeten Teilauftrag aus der Liste entfernen" aria-label="Entfernen">×</span>` : ''}
      </button>`);
    }
  }
  el.innerHTML = html.join('') || '<p class="hint">Nichts in dieser Ansicht.</p>';
}

// ---------- Chat ----------

function buildChat() {
  const el = $('#chat');
  const chat = S.chats.get(S.chatId);
  if (!chat) {
    document.body.classList.remove('detail');
    el.innerHTML = `<div class="welcome">${setupCard()}<div class="empty"><h2>Kein Auftrag ausgewählt</h2>
      <p>Gib einem Lead-Agenten einen Auftrag. Er arbeitet selbstständig und meldet sich hier, wenn er fertig ist oder eine Entscheidung braucht. Mit der Leertaste springst du zum nächsten Chat, der dich braucht.</p></div></div>`;
    return;
  }
  el.innerHTML = `
    <div class="chat-head" id="chat-head"></div>
    <div class="messages" id="messages"><div class="messages-inner" id="messages-inner"></div></div>
    <div id="ask"></div>
    <form class="composer" id="composer">
      <textarea id="composer-input" rows="1" placeholder="Nachricht an deinen Lead-Agenten (Enter sendet, Umschalt+Enter für neue Zeile)"></textarea>
      <button type="button" id="composer-interrupt" hidden title="Beendet den laufenden Copilot-Aufruf. Steht Text im Feld, setzt der Agent sofort damit fort (Esc).">Unterbrechen</button>
      <button class="primary" type="submit">Senden</button>
    </form>`;
  const input = $('#composer-input');
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      await api('POST', `/api/chats/${chat.id}/message`, { text });
    } catch (err) {
      input.value = text;
      alert(err.message);
    }
  };
  $('#composer').onsubmit = (event) => {
    event.preventDefault();
    send();
  };
  const interrupt = async () => {
    const text = input.value.trim();
    input.value = '';
    try {
      await api('POST', `/api/chats/${chat.id}/action`, { action: 'interrupt', text });
    } catch (err) {
      input.value = text;
      alert(err.message);
    }
  };
  $('#composer-interrupt').onclick = interrupt;
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && S.chats.get(chat.id)?.status === 'running') {
      event.preventDefault();
      interrupt();
    }
  });
  input.onkeydown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    }
  };
  updateChat(true);
}

function updateChat(forceScroll = false) {
  const chat = S.chats.get(S.chatId);
  if (!chat || !$('#chat-head')) return;
  const project = projectOf(chat);

  const statusText = {
    running: 'arbeitet',
    queued: chat.queued?.reason || 'in der Schlange',
    attention: isSnoozed(chat) ? 'später' : 'wartet auf dich',
    waiting: 'wartet auf Teilaufträge',
    done: 'erledigt',
    idle: 'bereit',
    archived: 'archiviert',
  }[chat.status];
  const kids = childrenOf(chat).filter((c) => c.status !== 'archived');
  const kidsOpen = kids.filter((c) => ['running', 'queued'].includes(c.status)).length;
  const kidsDone = kids.filter(canRemoveChat).length;
  const parent = chat.parentId && S.chats.get(chat.parentId);
  const sub = [project?.name, chat.viaZentrale ? 'über die Zentrale' : '', project?.zentrale ? 'verteilt an deine Projekte, ohne Vorgeschichte' : '', parent ? `Teilauftrag von „${parent.title}“` : 'Lead-Agent', kids.length ? `${kids.length} Teilaufträge, ${kidsOpen} laufen` : '', chat.attention?.naechster_schritt ? `Nächster Schritt: ${chat.attention.naechster_schritt}` : '']
    .filter(Boolean).map(esc).join(' · ');
  // Während Modell oder Aufwand bearbeitet werden, nicht neu zeichnen, sonst geht die Eingabe verloren.
  if (!document.activeElement?.closest?.('#chat-head select, #chat-head input')) $('#chat-head').innerHTML = `
    <button class="ghost back" data-a="back" aria-label="Zurück zur Liste">←</button>
    <div class="grow">
      <h1>${esc(chat.title)}</h1>
      <div class="sub">${isZentrale(chat) ? 'Das zentrale Gehirn: kennt alle Projekte, findet selbst heraus, stimmt sich mit den Agenten ab' : sub}</div>
    </div>
    ${chat.crew ? `<span class="badge">Crew ${chat.crew}</span>` : ''}
    ${chat.premiumRequests ? `<span class="badge" title="Premium-Anfragen, die dieser Chat bei Copilot verbraucht hat">${esc(chat.premiumRequests)} Premium</span>` : ''}
    <span class="model-pick" title="Modell und Aufwand dieses Chats, gilt ab dem nächsten Zug">
      ${modelInput(chat.model || '', project?.model, 'data-pick="model" aria-label="Modell"')}
      <select data-pick="effort" aria-label="Aufwand">${effortOptions(chat.effort || '', project?.effort)}</select>
    </span>
    ${isZentrale(chat) ? '' : `<button data-a="new" title="Neuen Chat in „${esc(project?.name || '')}“ starten">+ Chat</button>`}
    <span class="badge"><span class="dot ${dotClass(chat)}"></span>${esc(statusText)}</span>
    ${['running', 'queued', 'waiting'].includes(chat.status) ? '<button data-a="stop">Stoppen</button>' : ''}
    ${kidsDone ? `<button data-a="remove-children" title="Beendete Teilaufträge aus der Liste entfernen; laufende bleiben stehen">Beendete entfernen (${kidsDone})</button>` : ''}
    ${isZentrale(chat) ? '' : chat.parentId && canRemoveChat(chat) ? '<button class="ghost" data-a="remove" title="Diesen beendeten Teilauftrag aus der Liste entfernen">Entfernen</button>' : '<button class="ghost" data-a="archive" title="Aus der Liste entfernen">Archivieren</button>'}`;
  $('#chat-head').onchange = (event) => {
    const pick = event.target.closest('[data-pick]')?.dataset.pick;
    if (!pick) return;
    event.target.blur();
    run(api('PATCH', `/api/chats/${chat.id}`, { [pick]: event.target.value.trim() }).then((c) => { S.chats.set(c.id, c); updateChat(); }));
  };
  $('#chat-head').onclick = (event) => {
    const a = event.target.closest('button')?.dataset.a;
    if (a === 'back') selectChat(null);
    if (a === 'new') newChatDialog({ projectId: chat.projectId });
    if (a === 'stop') act(chat.id, 'stop');
    if (a === 'remove-children') act(chat.id, 'remove-children');
    if (a === 'remove') {
      act(chat.id, 'remove');
      selectChat(null);
    }
    if (a === 'archive' && confirm('Diesen Chat archivieren? Ein laufender Agent wird gestoppt.')) {
      act(chat.id, 'archive');
      selectChat(null);
    }
  };

  const box = $('#messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const html = chat.messages.map((m) =>
    m.role === 'agent' || m.role === 'result' ? `<div class="msg ${m.role}">${md(m.text, project)}</div>` : `<div class="msg ${m.role}">${esc(m.text)}</div>`,
  );
  const keys = chat.messages.map((m) => m.id);
  if (chat.status === 'running') {
    const lastMove = chat.messages.length ? chat.messages[chat.messages.length - 1].ts : chat.createdAt;
    html.push(`<div class="working"><span class="dot running"></span>${chat.progress ? `<b>${esc(chat.progress.text)}</b> · ` : ''}${esc(chat.activity || 'Arbeitet …')} · letzte Regung ${esc(ago(lastMove))}${chat.pending?.length ? ` · ${chat.pending.length} ${chat.pending.length === 1 ? 'Nachricht geht' : 'Nachrichten gehen'} in den nächsten Zug` : ''}</div>`);
  } else if (chat.status === 'queued') {
    html.push(`<div class="working"><span class="dot queued"></span>${esc(chat.queued?.reason || 'Startet gleich …')}</div>`);
  } else if (chat.status === 'waiting') {
    html.push(`<div class="working"><span class="dot queued"></span>${esc(chat.waitingFor || 'Wartet auf die Ergebnisse der Teilaufträge.')}</div>`);
  }
  // Nur geänderte Nachrichten neu zeichnen: Videos spielen weiter, Vorschauen laden nicht neu.
  patchNodes($('#messages-inner'), html.map((h, i) => ({ key: keys[i] || `extra-${i}`, html: h })));
  if (forceScroll || nearBottom) box.scrollTop = box.scrollHeight;

  const running = chat.status === 'running';
  $('#composer-interrupt').hidden = !running;
  $('#composer-input').placeholder = isZentrale(chat)
    ? 'Frag, was du wissen willst, oder sag, was abgestimmt werden soll (Enter)'
    : running
    ? 'Geht in seinen nächsten Zug (Enter) · Unterbrechen (Esc) setzt sofort damit fort'
    : 'Nachricht an deinen Lead-Agenten (Enter sendet, Umschalt+Enter für neue Zeile)';

  renderAsk(chat);
}

function patchNodes(box, items) {
  const old = new Map([...box.children].filter((n) => n.dataset.k).map((n) => [n.dataset.k, n]));
  items.forEach((item, i) => {
    let node = old.get(item.key);
    if (!node || node._html !== item.html) {
      const t = document.createElement('template');
      t.innerHTML = item.html;
      const fresh = t.content.firstElementChild || document.createElement('div');
      fresh.dataset.k = item.key;
      fresh._html = item.html;
      if (node) node.replaceWith(fresh);
      node = fresh;
    }
    old.delete(item.key);
    if (box.children[i] !== node) box.insertBefore(node, box.children[i] || null);
  });
  for (const n of old.values()) n.remove();
  while (box.children.length > items.length) box.lastElementChild.remove();
}

function renderAsk(chat) {
  const el = $('#ask');
  const a = chat.attention;
  const open = openFreigaben(chat);
  const waitingAsk = chat.status === 'attention' && a;
  // Ausgehende Nachrichten warten auf dich: als eigene Entscheidung (attention 'freigabe') oder,
  // solange der Agent noch weiterarbeitet, schon vorab.
  if (open.length && (!waitingAsk || a.kind === 'freigabe')) {
    el.innerHTML = `<div class="ask freigabe-ask">
      <div class="kind">Freigabe</div>
      <div class="q">${esc(a?.kind === 'freigabe' && a.frage && a.freigaben?.length === open.length ? a.frage : open.length === 1 ? `${SEND_LABEL[open[0].kind] || 'Nachricht'} an ${open[0].to} senden?` : `${open.length} Nachrichten senden?`)}</div>
      ${a?.kind === 'freigabe' && a.kurz ? `<div class="next">${esc(a.kurz)}</div>` : ''}
      ${!waitingAsk ? '<div class="next">Der Agent arbeitet solange an allem weiter, was nicht davon abhängt. Gesendet wird erst mit deinem Klick, in deinem Namen.</div>' : ''}
      <div class="freigabe-list">${open.map((f) => `${freigabeHtml(f, { withChat: false, buttons: false })}`).join('')}</div>
      ${open.length > 1 || waitingAsk ? `<div class="row">${open.length > 1 ? '<button class="primary" data-a="send-all">Alle senden</button><button data-a="deny-all">Alle verwerfen</button>' : ''}
        ${waitingAsk ? '<button data-a="reply">Antworten</button><button class="ghost" data-a="snooze">Später</button>' : ''}</div>` : ''}
    </div>`;
    // Knöpfe je Nachricht in die Karten setzen
    el.querySelectorAll('.freigabe-list [data-freigabe]').forEach((card) => {
      card.insertAdjacentHTML('beforeend', '<div class="row"><button class="primary" data-a="send-one">Senden</button><button data-a="deny-one">Verwerfen</button></div>');
    });
    el.onclick = (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      const action = button.dataset.a;
      const freigabeId = button.closest('[data-freigabe]')?.dataset.freigabe;
      if (action === 'send-one') act(chat.id, 'send-approve', { freigabeId });
      else if (action === 'deny-one') act(chat.id, 'send-deny', { freigabeId });
      else if (action === 'send-all') act(chat.id, 'send-approve');
      else if (action === 'deny-all' && confirm(`Alle ${open.length} Nachrichten verwerfen?`)) act(chat.id, 'send-deny');
      else if (action === 'reply') focusComposer();
      else if (action === 'snooze') act(chat.id, 'snooze');
      else return;
      if (action !== 'reply') button.disabled = true;
    };
    return;
  }
  if (!waitingAsk) {
    el.innerHTML = '';
    el.onclick = null;
    return;
  }
  const buttons = [];
  if (a.kind === 'entscheidung') {
    if (a.optionen?.length) {
      a.optionen.forEach((option, i) =>
        buttons.push(`<button class="${i === 0 ? 'primary' : ''}" data-a="option" data-i="${i}">${esc(option)}${i === 0 ? '<span class="rec">empfohlen</span>' : ''}</button>`),
      );
    } else {
      buttons.push('<button class="primary" data-a="approve">Freigeben</button>');
    }
    buttons.push('<button data-a="reply">Änderungen anfordern</button>');
  } else if (a.kind === 'erlaubnis') {
    buttons.push('<button class="primary" data-a="allow">Erlauben</button>', '<button data-a="deny">Ablehnen</button>');
  } else if (a.kind === 'tresor') {
    buttons.push('<button class="primary" data-a="vault-approve">Freigeben</button>', '<button data-a="vault-deny">Ablehnen</button>');
  } else if (a.kind === 'fertig') {
    buttons.push('<button class="primary" data-a="done">Erledigt</button>', '<button data-a="reply">Nacharbeiten</button>');
  } else if (a.kind === 'fehler') {
    buttons.push('<button class="primary" data-a="retry">Nochmal versuchen</button>', '<button data-a="reply">Antworten</button>');
  } else if (a.kind === 'uebergabe') {
    buttons.push(`${a.url ? '<button class="primary" data-a="open">Im eigenen Browser öffnen ↗</button>' : ''}`, '<button data-a="handoff-done">Erledigt</button>', '<button data-a="reply">Ging nicht</button>');
  } else {
    buttons.push('<button class="primary" data-a="reply">Antworten</button>');
  }
  if (a.requests?.length && a.kind !== 'erlaubnis') buttons.splice(1, 0, '<button data-a="allow">Verweigerte Schritte freigeben</button>');
  buttons.push('<button class="ghost" data-a="snooze">Später</button>');
  if (a.kind !== 'fertig') buttons.push('<button class="ghost" data-a="done">Nicht mehr nötig</button>');

  // Verweigerte Schritte sind oft lange Befehle: eingeklappt, nur die erste Zeile als Vorschau.
  const requests = (a.requests || []).map((r) => {
    const detail = String(r.detail || '');
    const lines = detail.split('\n').length;
    const first = detail.split('\n')[0].slice(0, 90);
    return `<details class="req-box"><summary>Verweigerter Schritt · ${esc(r.tool)}${lines > 1 ? ` · ${lines} Zeilen` : ''}: <code>${esc(first)}${detail.length > first.length ? ' …' : ''}</code></summary><pre class="req"><code>${esc(detail)}</code></pre></details>`;
  }).join('');
  const notes = [];
  if (a.requests?.length) {
    notes.push(projectOf(chat)?.mode === 'vorsichtig'
      ? `Die Freigabe gilt ab dann für dieses Projekt: ${a.requests.flatMap((r) => r.patterns || []).join(', ')}`
      : 'Diese Schritte wurden dem Agenten verweigert, und er kommt ohne sie nicht weiter. Die Freigabe gilt nur für genau diese Schritte.');
  }
  if (a.kind === 'uebergabe') {
    notes.push(`Der Agent hat alles vorbereitet. Das hier erledigst du selbst, in deinem normalen Browser oder am Handy${a.url ? `: ${a.url}` : '.'}`);
    notes.push('Zugangsdaten, die er angelegt hat, kopierst du im Reiter „Tresor“. Danach „Erledigt“, und er macht von selbst weiter.');
  }
  const tone = { fertig: 'fertig', fehler: 'fehler' }[a.kind] || '';
  el.innerHTML = `<div class="ask ${tone}">
    <div class="kind">${esc(KIND_LABEL[a.kind] || a.kind)}</div>
    <div class="q">${esc(a.frage || a.kurz)}</div>
    ${a.frage && a.kurz ? `<div class="next">${esc(a.kurz)}</div>` : ''}
    ${requests}${notes.map((n) => `<div class="next">${esc(n)}</div>`).join('')}
    <div class="row">${buttons.join('')}</div>
  </div>`;
  el.onclick = (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const action = button.dataset.a;
    if (action === 'option') act(chat.id, 'approve', { option: a.optionen[Number(button.dataset.i)] });
    else if (action === 'reply') focusComposer();
    else if (action === 'open') window.open(a.url, '_blank', 'noopener,noreferrer');
    else act(chat.id, action);
  };
}


// ---------- Dialoge ----------

function openDialog(html, onSubmit, submitLabel = 'Anlegen') {
  const dialog = $('#dialog');
  dialog.innerHTML = `<form class="form" method="dialog">${html}<div class="error" id="dialog-error"></div>
    <div class="actions"><button type="button" id="dialog-cancel">Abbrechen</button><button class="primary" type="submit">${esc(submitLabel)}</button></div></form>`;
  $('#dialog-cancel').onclick = () => dialog.close();
  dialog.querySelector('form').onsubmit = async (event) => {
    event.preventDefault();
    const submit = event.target.querySelector('[type=submit]');
    submit.disabled = true;
    try {
      await onSubmit(Object.fromEntries(new FormData(event.target)));
      dialog.close();
    } catch (err) {
      $('#dialog-error').textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  };
  dialog.showModal();
  return dialog;
}

// Modell und Aufwand: '' heißt Vorgabe (des Projekts bzw. von Copilot). Modellnamen wie bei
// `copilot --model`; die Vorschläge stehen in <datalist id="model-list"> (index.html).
const EFFORT_NAMES = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
const modelInput = (value, fallback, attrs = '') =>
  `<input list="model-list" autocomplete="off" spellcheck="false" value="${esc(value || '')}" placeholder="Vorgabe${fallback ? ` (${esc(fallback)})` : ''}" ${attrs}>`;
const effortOptions = (value, fallback) =>
  `<option value="">Vorgabe${fallback ? ` (${esc(fallback)})` : ''}</option>` +
  Object.entries(EFFORT_NAMES).map(([k, v]) => `<option value="${k}" ${k === value ? 'selected' : ''}>${v}</option>`).join('') +
  (value && !EFFORT_NAMES[value] ? `<option value="${esc(value)}" selected>${esc(value)}</option>` : '');

function newChatDialog(preset = null) {
  if (preset instanceof Event) preset = null;
  if (!S.projects.length) {
    setView('projects');
    newProjectDialog();
    return;
  }
  const current = preset?.projectId || S.chats.get(S.chatId)?.projectId;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const dialog = openDialog(
    `<h2>${preset?.projectId ? `Neuer Chat in „${esc(S.projects.find((p) => p.id === preset.projectId)?.name || '')}“` : 'Neuer Auftrag'}</h2>
    <label>Projekt<select name="projectId" id="chat-project">${S.projects.map((p) => `<option value="${p.id}" ${p.id === current ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}<option value="">+ Neues Projekt</option></select></label>
    <label id="chat-new-project" hidden>Name des neuen Projekts<input name="projectName" maxlength="60"></label>
    <label>Art<select name="kind" id="chat-kind"><option value="auftrag">Auftrag</option><option value="meeting">Gespräch: Aufträge ableiten und zur Freigabe vorlegen</option></select></label>
    <label>Titel (optional)<input name="title" maxlength="80" value="${esc(preset?.title || '')}"></label>
    <div class="row-2">
      <label>Modell${modelInput('', '', 'name="model" id="chat-model"')}</label>
      <label>Aufwand<select name="effort" id="chat-effort">${effortOptions('')}</select></label>
    </div>
    <label><span id="chat-text-label">Was soll erreicht werden?</span><textarea name="text" id="chat-text" rows="7" required placeholder="Ziel, gewünschtes Ergebnis, Grenzen. Je klarer das fertige Ergebnis beschrieben ist, desto weniger Rückfragen.">${esc(preset?.text || '')}</textarea></label>
    <div id="record-row" hidden>
      <button type="button" id="record">Gespräch mitschneiden</button>
      <p class="note">${Recognition ? 'Die Spracherkennung macht der Browser. In Chrome geht der Ton dafür an Google.' : 'Dieser Browser kann nicht mitschneiden. Füg das Transkript ein.'}</p>
    </div>`,
    async (data) => {
      recognition?.stop();
      recording = false;
      if (!data.projectId) {
        if (!data.projectName?.trim()) throw new Error('Gib dem neuen Projekt einen Namen.');
        data.projectId = (await createProject({ name: data.projectName })).id;
      }
      data.model = (data.model || '').trim();
      const chat = await api('POST', '/api/chats', data);
      S.chats.set(chat.id, chat);
      selectChat(chat.id);
    },
    'Starten',
  );

  // Mitschnitt: Der Browser schreibt mit, der Text landet im Feld.
  let recognition = null;
  let recording = false;
  const textarea = $('#chat-text');
  const button = $('#record');
  // Die Vorgabe im Modell-Feld zeigt, was das gewählte Projekt nimmt.
  const showDefaults = () => {
    const p = S.projects.find((x) => x.id === $('#chat-project').value);
    const e = $('#chat-effort').value;
    $('#chat-model').placeholder = `Vorgabe${p?.model ? ` (${p.model})` : ''}`;
    $('#chat-effort').innerHTML = effortOptions(e, p?.effort);
  };
  showDefaults();
  $('#chat-project').onchange = (event) => {
    showDefaults();
    $('#chat-new-project').hidden = event.target.value !== '';
    if (!event.target.value) $('#chat-new-project input').focus();
  };
  $('#chat-kind').onchange = (event) => {
    const meeting = event.target.value === 'meeting';
    $('#record-row').hidden = !meeting;
    $('#chat-text-label').textContent = meeting ? 'Transkript oder Mitschrift' : 'Was soll erreicht werden?';
    textarea.placeholder = meeting ? 'Transkript einfügen oder mitschneiden.' : 'Ziel, gewünschtes Ergebnis, Grenzen.';
  };
  button.disabled = !Recognition;
  button.onclick = () => {
    if (recording) {
      recording = false;
      recognition.stop();
      button.textContent = 'Gespräch mitschneiden';
      return;
    }
    let base = textarea.value ? textarea.value.trimEnd() + '\n' : '';
    recognition = new Recognition();
    recognition.lang = 'de-DE';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const piece = event.results[i][0].transcript.trim();
        if (event.results[i].isFinal) base += piece + '\n';
        else interim += piece + ' ';
      }
      textarea.value = base + interim;
      textarea.scrollTop = textarea.scrollHeight;
    };
    recognition.onerror = (event) => {
      if (event.error === 'no-speech') return;
      recording = false;
      button.textContent = 'Gespräch mitschneiden';
      $('#dialog-error').textContent = `Mitschnitt nicht möglich: ${event.error}`;
    };
    // Der Browser beendet die Erkennung nach Pausen von selbst: weiterlaufen lassen.
    recognition.onend = () => recording && recognition.start();
    recording = true;
    recognition.start();
    button.textContent = 'Mitschnitt beenden';
  };
  dialog.addEventListener('close', () => {
    recording = false;
    recognition?.stop();
  }, { once: true });
}

// Ein neues Projekt übernimmt die Einstellungen des zuletzt angelegten, damit nichts neu
// zusammengeklickt werden muss.
async function createProject(data) {
  const template = S.projects[S.projects.length - 1];
  const project = await api('POST', '/api/projects', data);
  if (template) {
    await api('PATCH', `/api/projects/${project.id}`, {
      mode: template.mode, model: template.model || '', effort: template.effort || '',
      identity: 'm365' in data ? { m365: Boolean(data.m365) } : template.identity,
    });
  }
  return project;
}

function newProjectDialog() {
  const last = S.projects[S.projects.length - 1];
  openDialog(
    `<h2>Neues Projekt</h2>
    <label>Name<input name="name" required maxlength="60"></label>
    <label class="check"><input type="checkbox" name="m365" ${!last || last.identity?.m365 ? 'checked' : ''}> Outlook &amp; Teams nutzen (Microsoft 365)</label>
    <p class="note" style="margin:0">Mehr braucht es nicht. Den Ordner legt der Leitstand auf diesem Rechner selbst an; Modell, Aufwand und Modus übernimmt er vom letzten Projekt und lässt sich unter „Projekte“ ändern.</p>`,
    (data) => createProject({ ...data, m365: Boolean(data.m365) }),
  );
}

function newPageDialog() {
  openDialog(
    `<h2>Neue Seite</h2>
    <label>Name<input name="name" required maxlength="70" placeholder="Zielkunden"></label>
    <label>Art<select name="type"><option value="md">Seite (.md)</option><option value="csv">Tabelle (.csv)</option></select></label>`,
    async (data) => {
      const name = `${data.name.trim()}.${data.type}`;
      await api('PUT', `/api/pages/${encodeURIComponent(name)}`, { content: data.type === 'md' ? `# ${data.name.trim()}\n\n` : 'Spalte A,Spalte B\n' });
      await openPage(name, true);
    },
  );
}

// ---------- Seiten ----------

function renderPageList() {
  $('#page-list').innerHTML = S.pages.length
    ? S.pages.map((p) => `<button class="item ${p.name === S.pageName ? 'active' : ''}" data-page="${esc(p.name)}"><span class="label">${esc(p.name)}</span><span class="meta">${ago(p.mtime)}</span></button>`).join('')
    : '<p class="hint">Noch keine Seiten. Agenten legen hier ab, was über einen Chat hinaus gilt.</p>';
}

async function openPage(name, edit = false) {
  const page = await api('GET', `/api/pages/${encodeURIComponent(name)}`);
  S.pageName = name;
  S.pageContent = page.content;
  S.pageEdit = edit;
  document.body.classList.add('detail');
  renderPageList();
  renderPage();
}

function renderPage() {
  const el = $('#page');
  if (!S.pageName) {
    el.innerHTML = `<div class="empty"><h2>Gemeinsamer Kontext</h2><p>Seiten und Tabellen, die alle Lead-Agenten lesen und fortschreiben. Ordner: <code>${esc(S.contextDir)}</code></p></div>`;
    return;
  }
  let body;
  if (S.pageEdit) {
    body = `<textarea id="page-text" spellcheck="false">${esc(S.pageContent)}</textarea>`;
  } else if (S.pageName.endsWith('.csv')) {
    const rows = parseCsv(S.pageContent);
    body = `<table class="grid"><thead><tr>${(rows[0] || []).map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${rows.slice(1).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  } else {
    body = `<div class="doc msg agent">${md(S.pageContent) || '<p class="hint">Leer.</p>'}</div>`;
  }
  el.innerHTML = `<div class="page-head"><button class="ghost back" data-a="back" aria-label="Zurück zur Liste">←</button><h1>${esc(S.pageName)}</h1>
    ${S.pageEdit ? '<button data-a="cancel">Abbrechen</button><button class="primary" data-a="save">Speichern</button>' : '<button data-a="edit">Bearbeiten</button>'}</div>
    <div class="page-body">${body}</div>`;
  el.querySelector('.page-head').onclick = (event) => {
    const a = event.target.closest('button')?.dataset.a;
    if (a === 'back') { S.pageName = null; document.body.classList.remove('detail'); renderPageList(); renderPage(); }
    if (a === 'edit') { S.pageEdit = true; renderPage(); }
    if (a === 'cancel') run(openPage(S.pageName));
    if (a === 'save') run(api('PUT', `/api/pages/${encodeURIComponent(S.pageName)}`, { content: $('#page-text').value }).then(() => openPage(S.pageName)));
  };
}

// ---------- Projekte ----------

function renderProjects() {
  if (document.activeElement?.closest?.('#projects input[type="text"], #projects input:not([type])')) return; // nicht mitten in einer Eingabe neu zeichnen
  const cards = S.projects.map((p) => {
    const i = p.identity || {};
    return `<div class="card" data-project="${p.id}">
      <h2>${esc(p.name)}</h2>
      <div class="path">${esc(p.dir)}</div>
      <div class="fields three">
        <label>Modus<select data-field="mode">
          <option value="selbststaendig" ${p.mode === 'selbststaendig' ? 'selected' : ''}>Selbstständig</option>
          <option value="vorsichtig" ${p.mode === 'vorsichtig' ? 'selected' : ''}>Vorsichtig</option>
          <option value="autonom" ${p.mode === 'autonom' ? 'selected' : ''}>Autonom</option>
        </select></label>
        <label>Modell${modelInput(p.model || '', '', 'data-field="model" aria-label="Modell"')}</label>
        <label>Aufwand<select data-field="effort">${effortOptions(p.effort || '')}</select></label>
      </div>
      ${{
        selbststaendig: '<p class="note">Selbstständig: Der Agent entscheidet Alltägliches selbst (Befehle, Websuche, Installieren, Dateien). Riskantes, etwa Löschen außerhalb des Projekts, wird verweigert. Dich erreicht das nur, wenn er ohne diesen Schritt nicht weiterkommt.</p>',
        vorsichtig: '<p class="note">Vorsichtig: Der Agent darf Dateien im Projektordner ändern und im Web lesen. Jeden anderen Befehl legt er dir einmal vor; deine Erlaubnis gilt dann für das Projekt. Das führt zu vielen Rückfragen.</p>',
        autonom: '<p class="note warn">Autonom: Der Agent führt alles ohne jede Prüfung aus, auch Löschen und Netzwerkzugriffe. Nur für Projekte, in denen nichts Wichtiges kaputtgehen kann.</p>',
      }[p.mode] || ''}
      <div class="checks">
        <span class="note" style="margin:0">Der Agent darf nutzen:</span>
        <label title="Mails und Kalender lesen, Teams-Chats lesen, Nachrichten in deinem Namen senden (je nach Einstellung erst nach deiner Freigabe)"><input type="checkbox" data-identity="m365" ${i.m365 ? 'checked' : ''}>Outlook &amp; Teams</label>
      </div>
      ${p.allow?.length ? `<div class="chips">${p.allow.map((a, n) => `<span class="chip">${esc(a)}<button data-remove="${n}" title="Erlaubnis entziehen" aria-label="Erlaubnis ${esc(a)} entziehen">×</button></span>`).join('')}</div>` : ''}
    </div>`;
  });
  $('#projects').innerHTML = `<div class="inner">
    <div class="head-row"><h1>Projekte</h1><button class="primary" id="new-project">Neues Projekt</button></div>
    <p class="note">Jedes Projekt hat einen eigenen Ordner auf diesem Rechner und eigene Lead-Agenten (GitHub Copilot CLI). So kommen Aufträge verschiedener Vorhaben nicht durcheinander. Modell leer lassen heißt: Copilot wählt selbst.</p>
    ${cards.join('') || '<div class="card"><p class="note">Noch kein Projekt.</p></div>'}
  </div>`;
  $('#new-project').onclick = newProjectDialog;
}

$('#projects').addEventListener('change', (event) => {
  const card = event.target.closest('[data-project]');
  if (!card) return;
  const project = S.projects.find((p) => p.id === card.dataset.project);
  const field = event.target.dataset.field;
  if (field) {
    if (field === 'mode' && event.target.value === 'autonom' && !confirm('Autonom heißt: Der Agent führt in diesem Projekt jeden Befehl ohne Rückfrage aus. Wirklich umstellen?')) {
      renderProjects();
      return;
    }
    event.target.blur();
    run(api('PATCH', `/api/projects/${project.id}`, { [field]: event.target.value.trim() }));
  } else if (event.target.dataset.identity) {
    run(api('PATCH', `/api/projects/${project.id}`, { identity: { ...project.identity, [event.target.dataset.identity]: event.target.checked } }));
  }
});

$('#projects').addEventListener('click', (event) => {
  const index = event.target.dataset.remove;
  const card = event.target.closest('[data-project]');
  if (index === undefined || !card) return;
  const project = S.projects.find((p) => p.id === card.dataset.project);
  run(api('PATCH', `/api/projects/${project.id}`, { allow: project.allow.filter((_, n) => n !== Number(index)) }));
});

function bar(used, total) {
  const pct = total ? Math.min(100, Math.round((used / total) * 100)) : 0;
  return `<div class="bar ${pct >= 100 ? 'full' : pct >= 80 ? 'warn' : ''}"><i style="width:${pct}%"></i></div>`;
}
// ---------- Tresor ----------

const scopeName = (scope) => (scope === 'alle' ? 'alle Projekte' : S.projects.find((p) => p.id === scope)?.name || 'gelöschtes Projekt');
const reveal = (loginId) => api('POST', `/api/vault/${loginId}/reveal`);

// In die Zwischenablage kopieren, auch ohne HTTPS (Aufruf über die Tailscale-Adresse) und in
// Safari, das die Klick-Berechtigung verliert, während der Wert erst vom Server kommt.
// value: Text oder Promise auf Text. Gibt den kopierten Text zurück.
async function copyText(value) {
  const pending = Promise.resolve(value).then(String);
  if (window.isSecureContext && navigator.clipboard) {
    // ClipboardItem mit Promise: wird synchron im Klick angemeldet, der Inhalt darf nachkommen.
    if (window.ClipboardItem && navigator.clipboard.write) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': pending.then((t) => new Blob([t], { type: 'text/plain' })) })]);
        return pending;
      } catch {}
    }
    try {
      const text = await pending;
      await navigator.clipboard.writeText(text);
      return text;
    } catch {}
  }
  const text = await pending;
  // Ohne sichere Verbindung: der alte Weg über ein unsichtbares Textfeld.
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
  document.body.appendChild(area);
  area.focus();
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  area.remove();
  if (!ok) copyByHand(text);
  return text;
}

// Letzter Ausweg: Wert markiert anzeigen, der Mensch drückt ⌘C / Strg+C.
function copyByHand(text) {
  openDialog(
    `<h2>Kopieren</h2><p class="note">Der Browser lässt das automatische Kopieren hier nicht zu. Der Wert ist markiert: ⌘C bzw. Strg+C drücken.</p>
    <input id="copy-by-hand" readonly value="${esc(text)}" style="font-family:ui-monospace,monospace">`,
    async () => {},
    'Fertig',
  );
  const input = $('#copy-by-hand');
  input.focus();
  input.select();
  input.addEventListener('copy', () => setTimeout(() => $('#dialog').close(), 150));
}

function renderVault() {
  if (document.activeElement?.id === 'vault-search' && $('#vault-list')) return renderVaultList();
  $('#vault').innerHTML = `<div class="inner">
    <div class="head-row"><h1>Tresor</h1>
      <input id="vault-search" type="search" placeholder="Suchen" value="${esc(S.vaultSearch)}" style="width:220px">
      <button class="primary" id="vault-new">Neuer Zugang</button></div>
    <p class="note">Der Passwortmanager der Agenten. Sie legen hier jedes Konto ab, das sie anlegen, mit erzeugtem Passwort und, wo nötig, dem Schlüssel für die Zwei-Faktor-Anmeldung. Codes erzeugt der Leitstand selbst, ohne dein Handy. Zugänge, die du selbst einträgst, können sie genauso nutzen. Hier steht nur, was Agenten anlegen oder du von Hand einträgst; aus deinem Schlüsselbund oder Browser wird nichts übernommen. Alles liegt verschlüsselt auf diesem Rechner.</p>
    <div id="vault-list"></div>
  </div>`;
  $('#vault-new').onclick = () => loginDialog(null);
  $('#vault-search').oninput = (event) => {
    S.vaultSearch = event.target.value;
    renderVaultList();
  };
  renderVaultList();
}

function renderVaultList() {
  const query = S.vaultSearch.trim().toLowerCase();
  const entries = S.logins
    .filter((e) => !query || `${e.name} ${e.user} ${e.url} ${scopeName(e.scope)}`.toLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  $('#vault-list').innerHTML = entries.map((e) => {
    const link = /^https?:\/\//.test(e.url) ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.url.replace(/^https?:\/\//, ''))}</a>` : esc(e.url);
    const trail = e.lastUsedAt
      ? `zuletzt genutzt von ${esc(scopeName(e.lastUsedBy))}, ${esc(ago(e.lastUsedAt))}`
      : `angelegt ${esc(when(e.createdAt))}${e.createdBy === 'mensch' ? ' von dir' : ` von ${esc(scopeName(e.createdBy))}`}`;
    return `<div class="card login" data-login="${e.id}">
      <h2>${esc(e.name)} <span class="badge">${esc(scopeName(e.scope))}</span>${e.hasTotp ? ' <span class="badge ok">2FA</span>' : ''}</h2>
      <div class="path">${[esc(e.user), link].filter(Boolean).join(' · ') || 'ohne Benutzername'} · ${trail}</div>
      <div class="row">
        ${e.user ? '<button data-a="copy-user">Benutzer kopieren</button>' : ''}
        <button class="primary" data-a="copy-password">Passwort kopieren</button>
        ${e.hasTotp ? '<button data-a="copy-code">2FA-Code kopieren</button>' : ''}
        <button data-a="show">Anzeigen</button>
        <button class="ghost" data-a="edit">Bearbeiten</button>
        <button class="ghost danger" data-a="delete">Löschen</button>
      </div>
      <div class="revealed" hidden></div>
    </div>`;
  }).join('') || `<div class="card"><p class="note" style="margin:0">${query ? 'Nichts gefunden.' : 'Noch keine Zugänge. Sobald ein Agent irgendwo ein Konto anlegt, steht es hier. Über „Neuer Zugang“ gibst du den Agenten ein Konto, das es schon gibt.'}</p></div>`;
}

$('#vault').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-a]');
  const card = event.target.closest('[data-login]');
  if (!button || !card) return;
  const entry = S.logins.find((e) => e.id === card.dataset.login);
  const action = button.dataset.a;
  const flash = (text) => {
    const label = button.textContent;
    button.textContent = text;
    setTimeout(() => (button.textContent = label), 1500);
  };
  try {
    if (action === 'copy-user') {
      await copyText(entry.user);
      flash('Kopiert');
    } else if (action === 'copy-password') {
      await copyText(reveal(entry.id).then((d) => d.password));
      flash('Kopiert');
    } else if (action === 'copy-code') {
      const data = reveal(entry.id);
      await copyText(data.then((d) => d.totp.code));
      const { totp } = await data;
      flash(`${totp.code} · noch ${totp.remaining} s`);
    } else if (action === 'show') {
      const box = card.querySelector('.revealed');
      if (!box.hidden) {
        box.hidden = true;
        box.innerHTML = '';
        button.textContent = 'Anzeigen';
        return;
      }
      const data = await reveal(entry.id);
      box.innerHTML = `<dl>
        <dt>Passwort</dt><dd><code>${esc(data.password)}</code></dd>
        ${data.totp ? `<dt>2FA-Code</dt><dd><code>${esc(data.totp.code)}</code> noch ${data.totp.remaining} s gültig</dd>` : ''}
        ${data.previous ? `<dt>Vorheriges Passwort</dt><dd><code>${esc(data.previous)}</code></dd>` : ''}
        ${data.note ? `<dt>Notiz</dt><dd class="mail-body" style="margin:0;max-height:none">${esc(data.note)}</dd>` : ''}
      </dl>`;
      box.hidden = false;
      button.textContent = 'Verbergen';
    } else if (action === 'edit') {
      loginDialog(entry, await reveal(entry.id));
    } else if (action === 'delete') {
      if (confirm(`Zugang „${entry.name}“ löschen? Das Konto beim Dienst bleibt bestehen, aber das Passwort ist dann weg.`)) await api('DELETE', `/api/vault/${entry.id}`);
    }
  } catch (err) {
    alert(err.message);
  }
});

function loginDialog(entry, secret = {}) {
  const scopes = [['alle', 'alle Projekte'], ...S.projects.map((p) => [p.id, `nur ${p.name}`])];
  openDialog(
    `<h2>${entry ? 'Zugang bearbeiten' : 'Neuer Zugang'}</h2>
    <label>Name des Dienstes<input name="name" required maxlength="80" value="${esc(entry?.name || '')}" placeholder="GitHub"></label>
    <div class="fields" style="margin:0">
      <label>Benutzername oder E-Mail<input name="user" autocomplete="off" value="${esc(entry?.user || '')}"></label>
      <label>Adresse der Anmeldeseite<input name="url" value="${esc(entry?.url || '')}" placeholder="https://"></label>
    </div>
    <label>Passwort<input name="password" type="password" autocomplete="new-password" placeholder="${entry ? 'leer lassen für unverändert' : 'leer lassen: der Leitstand erzeugt eines'}"></label>
    ${entry ? '<label class="check"><input type="checkbox" name="generate"> Neues Passwort erzeugen (das alte bleibt als Rückfall gespeichert)</label>' : ''}
    <label>2FA-Schlüssel (Einrichtungsschlüssel der Authenticator-App oder otpauth://-Adresse)<input name="totp" autocomplete="off" placeholder="${entry?.hasTotp ? 'gesetzt, leer lassen für unverändert' : 'optional'}"></label>
    ${entry?.hasTotp ? '<label class="check"><input type="checkbox" name="removeTotp"> 2FA-Schlüssel entfernen</label>' : ''}
    ${secret.previous ? '<label class="check"><input type="checkbox" name="clearPrevious"> Vorheriges Passwort verwerfen</label>' : ''}
    <label>Notiz (etwa Wiederherstellungscodes, leeren zum Entfernen)<textarea name="note" rows="3">${esc(secret.note || '')}</textarea></label>
    <label>Nutzbar für<select name="scope">${scopes.map(([value, label]) => `<option value="${value}" ${(entry?.scope || 'alle') === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>`,
    (data) => (entry ? api('PATCH', `/api/vault/${entry.id}`, data) : api('POST', '/api/vault', data)),
    entry ? 'Speichern' : 'Anlegen',
  );
}

// ---------- Freigaben ----------
// Was Agenten in deinem Namen über Outlook oder Teams senden wollen. Gesendet wird erst mit deinem
// Klick (außer in den Einstellungen steht „direkt“). Darunter, was zuletzt entschieden wurde.

function renderFreigaben() {
  const waiting = waitingFreigaben().sort((a, b) => a.ts - b.ts);
  const decided = S.freigaben.filter((f) => f.status !== 'wartet').sort((a, b) => (b.decidedAt || b.ts) - (a.decidedAt || a.ts)).slice(0, 40);
  const m = S.m365 || {};
  $('#freigaben').innerHTML = `<div class="inner">
    <div class="head-row"><h1>Freigaben</h1>${waiting.length > 1 ? `<button class="primary" id="freigaben-all">Alle ${waiting.length} senden</button>` : ''}</div>
    <p class="note">Mails, Antworten, Einladungen und Teams-Nachrichten, die Agenten in deinem Namen senden wollen. Mails liegen bis dahin als Entwurf in deinem Outlook. ${S.settings.m365?.sendMode === 'direkt' ? '<b>Versand steht auf „direkt“:</b> Agenten senden ohne Rückfrage; hier steht dann nur, was hinausging.' : 'Gesendet wird erst mit deinem Klick.'}${m.signedIn ? '' : ' Microsoft 365 ist noch nicht angemeldet (Einstellungen).'}</p>
    <h3 class="section-title">Warten auf dich</h3>
    ${waiting.map((f) => `<div class="card">${freigabeHtml(f)}</div>`).join('') || '<div class="card"><p class="note" style="margin:0">Nichts wartet.</p></div>'}
    <h3 class="section-title">Zuletzt entschieden</h3>
    <div class="card">${decided.map((f) => freigabeHtml(f)).join('') || '<p class="note" style="margin:0">Noch nichts.</p>'}</div>
  </div>`;
  const all = $('#freigaben-all');
  if (all) all.onclick = () => {
    if (!confirm(`Alle ${waiting.length} wartenden Nachrichten jetzt senden?`)) return;
    all.disabled = true;
    for (const f of waiting) decideFreigabe(f.id, true);
  };
}

$('#freigaben').addEventListener('click', (event) => {
  if (onFreigabeClick(event)) return;
  const chatId = event.target.closest('[data-chat]')?.dataset.chat;
  if (chatId) selectChat(chatId);
});

// ---------- Einstellungen ----------

function m365StatusHtml() {
  const m = S.m365 || {};
  const pending = m.pending;
  let body;
  if (m.signedIn) {
    body = `<p class="note" style="margin-top:0">Angemeldet als <b>${esc(m.account || 'unbekannt')}</b>.</p>
      <div class="row"><button type="button" data-a="m365-logout" class="ghost danger">Abmelden</button><button type="button" data-a="m365-login">Neu anmelden</button></div>`;
  } else if (pending) {
    body = `<p class="note" style="margin-top:0">Öffne <a href="${esc(pending.url)}" target="_blank" rel="noopener">${esc(pending.url)}</a>, gib diesen Code dort ein und melde dich mit dem Arbeitskonto an:</p>
      <div class="device-code"><code>${esc(pending.userCode)}</code><button type="button" data-a="m365-copy">Kopieren</button><a class="button primary" href="${esc(pending.url)}" target="_blank" rel="noopener">Anmeldeseite öffnen ↗</a></div>
      <p class="note">Wartet auf die Anmeldung … Diese Seite aktualisiert sich von selbst.</p>
      <div class="row"><button type="button" data-a="m365-login">Neuen Code holen</button></div>`;
  } else {
    body = `<p class="note" style="margin-top:0">Nicht angemeldet.</p>
      <div class="row"><button type="button" class="primary" data-a="m365-login">Anmelden</button></div>`;
  }
  return `${m.error ? `<p class="note warn" style="margin-top:0">${esc(m.error)}</p>` : ''}${body}`;
}

function renderSettings() {
  const s = S.settings;
  const f = S.secretFlags;
  const m = s.m365 || {};
  const local = S.machines.find((x) => x.id === 'lokal') || {};
  const secret = (set) => (set ? 'gesetzt, leer lassen für unverändert' : '');
  const v = (value) => esc(value ?? '');
  const access = s.access || {};
  $('#settings').innerHTML = `<div class="inner">
    <h1>Einstellungen</h1>
    ${setupCard()}
    <p class="note">Kennwörter und Anmeldungen liegen verschlüsselt auf diesem Rechner (<code>data/secrets.enc</code>) und werden hier nie angezeigt. Was die Agenten eines Projekts nutzen dürfen, schaltest du unter „Projekte“ frei.</p>

    <div class="card" data-section="m365-login">
      <h2>Microsoft 365 (Outlook, Teams) ${S.m365?.signedIn ? '<span class="badge ok">angemeldet</span>' : ''}</h2>
      <p class="note">Die Agenten lesen über Microsoft Graph deine Mails, deinen Kalender und deine Teams-Chats und schreiben in deinem Namen. Angemeldet wird einmal per Code mit deinem Arbeitskonto; ein App-Geheimnis ist nicht nötig.</p>
      <div id="m365-status">${m365StatusHtml()}</div>
    </div>

    <form class="card" data-section="m365">
      <h2>Microsoft 365: Einstellungen</h2>
      <div class="fields">
        <label>Tenant<input name="tenant" value="${v(m.tenant)}" placeholder="organizations"></label>
        <label>Client-ID (optional)<input name="clientId" value="${v(m.clientId)}" placeholder="leer = Microsoft Graph Command Line Tools" autocomplete="off" spellcheck="false"></label>
        <label>Versand<select name="sendMode">
          <option value="freigabe" ${m.sendMode !== 'direkt' ? 'selected' : ''}>nach Freigabe (empfohlen)</option>
          <option value="direkt" ${m.sendMode === 'direkt' ? 'selected' : ''}>direkt, ohne Rückfrage</option>
        </select></label>
        <label>Tagesbriefing (Mo–Fr, Uhrzeit)<input name="briefing" type="time" value="${v(m.briefing)}"></label>
        <label>Teams-Chat-ID für Benachrichtigungen<input name="notifyChatId" value="${v(m.notifyChatId)}" placeholder="19:…@thread.v2" autocomplete="off" spellcheck="false"></label>
        <label>Teams-Chat-ID für Eingang an die Zentrale<input name="inboundChatId" value="${v(m.inboundChatId)}" placeholder="19:…@thread.v2" autocomplete="off" spellcheck="false"></label>
      </div>
      <div class="checks">
        <label><input type="checkbox" name="readChannels" ${m.readChannels ? 'checked' : ''}>Teams-Kanäle lesen (braucht Admin-Zustimmung)</label>
        <label><input type="checkbox" name="basic" ${m.basic ? 'checked' : ''}>Nur Grundrechte (Mail, Kalender, Chats) – falls der Tenant die Anmeldung mit allen Rechten ablehnt</label>
      </div>
      <p class="note">Tagesbriefing: Die Zentrale fasst Termine, ungelesene Mails und Teams-Chats zusammen und schickt das in den Benachrichtigungs-Chat. Leer lassen für kein Briefing.</p>
      <p class="note">Chat-IDs liefert ein Agent mit <code>leitstand teams chats</code>. In den Benachrichtigungs-Chat schreibt der Leitstand, wenn ein Chat dich braucht; Nachrichten aus dem Eingangs-Chat gehen an die Zentrale, ihre Antwort kommt dorthin zurück. Geänderte Rechte (Kanäle, Grundrechte) gelten erst nach erneuter Anmeldung.</p>
      <div class="row"><button class="primary" type="submit">Speichern</button><span class="note" data-result></span></div>
    </form>

    <form class="card" data-section="slots">
      <h2>Plätze</h2>
      <p class="note">So viele Agenten laufen auf diesem Rechner gleichzeitig. Weitere Aufträge warten in der Schlange, bis ein Platz frei wird.</p>
      <div class="fields">
        <label>Gleichzeitige Läufe<input name="slots" type="number" min="1" max="32" value="${v(local.slots)}" required></label>
        <label>Gerade belegt<input id="slots-running" value="${v(local.running ?? 0)}" readonly tabindex="-1"></label>
      </div>
      <div class="row"><button class="primary" type="submit">Speichern</button><span class="note" data-result></span></div>
    </form>

    <form class="card" data-section="access">
      <h2>Zugriff vom Handy ${f.access ? '<span class="badge ok">Kennwort gesetzt</span>' : ''}</h2>
      <p class="note">Der Leitstand ist nur von diesem Rechner aus erreichbar. Für unterwegs gibst du ihn in deinem privaten Tailscale-Netz frei:</p>
      <ol class="steps">
        <li>Auf diesem Rechner: <code>tailscale serve --bg 4747</code>. Der Befehl zeigt die Adresse, etwa <code>mein-rechner.tail1234.ts.net</code>.</li>
        <li>Diese Adresse und ein Kennwort hier eintragen.</li>
        <li>Auf dem Handy (Tailscale an) <code>https://</code> plus Adresse öffnen, anmelden und zum Home-Bildschirm hinzufügen.</li>
      </ol>
      <div class="fields">
        <label>Erlaubte Adressen (durch Leerzeichen getrennt)<input name="hosts" value="${v((access.hosts || []).join(' '))}" placeholder="mein-rechner.tail1234.ts.net"></label>
        <label>Zugangskennwort (mindestens 16 Zeichen)<input name="token" type="password" autocomplete="new-password" placeholder="${secret(f.access)}"></label>
      </div>
      <div class="row"><button class="primary" type="submit">Speichern</button><span class="note" data-result></span></div>
    </form>
  </div>`;
}

// Nur den Anmeldestatus neu zeichnen (SSE), damit halb ausgefüllte Formulare stehen bleiben.
function refreshSettingsLive() {
  if (S.view !== 'settings') return;
  const status = $('#m365-status');
  if (status) status.innerHTML = m365StatusHtml();
  const badge = $('#settings [data-section="m365-login"] h2');
  if (badge) badge.innerHTML = `Microsoft 365 (Outlook, Teams) ${S.m365?.signedIn ? '<span class="badge ok">angemeldet</span>' : ''}`;
  const running = $('#slots-running');
  if (running) running.value = S.machines.find((x) => x.id === 'lokal')?.running ?? 0;
}

$('#settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const section = form.dataset.section;
  const result = form.querySelector('[data-result]');
  const data = Object.fromEntries(new FormData(form));
  try {
    if (section === 'slots') {
      await api('PATCH', '/api/machines/lokal', { slots: Number(data.slots) });
    } else {
      if (section === 'm365') {
        data.readChannels = Boolean(data.readChannels);
        data.basic = Boolean(data.basic);
      }
      await api('PUT', `/api/settings/${section}`, data);
    }
    await refreshState();
    renderSettings();
    $(`#settings [data-section="${section}"] [data-result]`).textContent = 'Gespeichert.';
  } catch (err) {
    result.textContent = err.message;
  }
});
$('#settings').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-a]');
  const action = button?.dataset.a;
  if (!action) return;
  if (action === 'm365-login') {
    button.disabled = true;
    button.textContent = 'Holt Code …';
    try {
      S.m365 = await api('POST', '/api/m365/login');
    } catch (err) {
      S.m365 = { ...(S.m365 || {}), error: err.message };
    }
    refreshSettingsLive();
  }
  if (action === 'm365-logout' && confirm('Von Microsoft 365 abmelden? Die Agenten kommen dann nicht mehr an Outlook und Teams.')) {
    await run(api('POST', '/api/m365/logout'));
    S.m365 = await api('GET', '/api/m365/status').catch(() => S.m365);
    refreshSettingsLive();
  }
  if (action === 'm365-copy' && S.m365?.pending) {
    await copyText(S.m365.pending.userCode);
    button.textContent = 'Kopiert';
  }
});

// ---------- Rahmen ----------

const VIEWS = ['overview', 'chats', 'files', 'pages', 'freigaben', 'vault', 'projects', 'settings'];

function setView(view) {
  const entering = S.view !== view;
  S.view = view;
  if (location.hash.slice(1).split('/')[0] !== view) history.replaceState(null, '', view === 'overview' ? location.pathname : `#${view}`);
  for (const name of VIEWS) $(`#view-${name}`).hidden = name !== view;
  for (const button of $('#tabs').children) button.classList.toggle('active', button.dataset.view === view);
  document.body.classList.toggle('detail', (view === 'chats' && Boolean(S.chats.get(S.chatId))) || (view === 'pages' && Boolean(S.pageName)) || (view === 'files' && Boolean(S.files.file)));
  renderCapsule();
  if (!entering) return;
  if (view === 'overview') loadOverview();
  if (view === 'files') openFiles(S.files.projectId, S.files.path, S.files.file);
  if (view === 'freigaben') renderFreigaben();
  if (view === 'vault') renderVault();
  if (view === 'settings') renderSettings();
  if (view === 'projects') renderProjects();
}

function renderAll() {
  renderMeters();
  renderCapsule();
  renderChatList();
  const waiting = queue().length;
  document.title = waiting ? `(${waiting}) Leitstand` : 'Leitstand';
}

$('#tabs').onclick = (event) => {
  const view = event.target.closest('[data-view]')?.dataset.view;
  if (view) setView(view);
};
$('#new-chat').onclick = newChatDialog;
$('#zentrale-entry').onclick = () => openZentrale().catch((err) => alert(err.message));
$('#new-page').onclick = newPageDialog;
$('#chat-filter').onclick = (event) => {
  const filter = event.target.dataset.filter;
  if (!filter) return;
  S.chatFilter = filter;
  renderChatList();
};
$('#chat-list').onclick = (event) => {
  const remove = event.target.closest('[data-remove]')?.dataset.remove;
  if (remove) {
    if (S.chatId === remove) selectChat(null);
    return act(remove, 'remove');
  }
  const add = event.target.closest('[data-new]')?.dataset.new;
  if (add) return newChatDialog({ projectId: add });
  const chatId = event.target.closest('[data-chat]')?.dataset.chat;
  if (chatId) selectChat(chatId);
};
$('#page-list').onclick = (event) => {
  const name = event.target.closest('[data-page]')?.dataset.page;
  if (name) run(openPage(name));
};

// Leertaste: zum nächsten Chat, der eine Entscheidung braucht.
document.addEventListener('keydown', (event) => {
  if (event.key !== ' ' || event.metaKey || event.ctrlKey || event.altKey) return;
  if ($('#dialog').open || event.target.closest('input, textarea, select, button, [contenteditable]')) return;
  event.preventDefault();
  goNext();
});

function applyState(data) {
  setProjects(data.projects);
  S.chats = new Map(data.chats.map((c) => [c.id, c]));
  S.pages = data.pages;
  S.machines = data.machines || [];
  S.settings = data.settings || {};
  S.secretFlags = data.secretFlags || {};
  S.freigaben = data.freigaben || [];
  S.outbox = data.outbox || [];
  S.m365 = data.m365 || null;
  S.logins = data.logins || [];
  S.contextDir = data.contextDir;
}
const refreshState = async () => applyState(await api('GET', '/api/state'));

function connect() {
  const source = new EventSource('/api/events');
  source.addEventListener('chat', (event) => {
    const chat = JSON.parse(event.data);
    S.chats.set(chat.id, chat);
    renderAll();
    // Auch wenn sich ein Teilauftrag des offenen Chats ändert (Zähler, Knopf „Beendete entfernen“).
    if (chat.id === S.chatId || chat.parentId === S.chatId) updateChat();
    refreshOverviewLive();
  });
  source.addEventListener('projects', (event) => {
    setProjects(JSON.parse(event.data));
    renderAll();
    renderProjects();
    if (!S.chats.get(S.chatId)) buildChat();
  });
  source.addEventListener('fleet', (event) => {
    Object.assign(S, JSON.parse(event.data));
    renderMeters();
    refreshSettingsLive();
  });
  source.addEventListener('settings', (event) => {
    const data = JSON.parse(event.data);
    Object.assign(S, data);
    S.freigaben ||= [];
    S.outbox ||= [];
    if (S.view === 'vault') renderVault();
    if (S.view === 'freigaben') renderFreigaben();
    refreshSettingsLive();
    renderAll();
    if (S.chatId) updateChat();
    if (!S.chats.get(S.chatId)) buildChat();
    refreshOverviewLive();
  });
  source.addEventListener('pages', (event) => {
    S.pages = JSON.parse(event.data);
    renderPageList();
    if (S.pageName && !S.pageEdit && S.pages.some((p) => p.name === S.pageName)) openPage(S.pageName).catch(() => {});
  });
  // Nach einer Unterbrechung (Neustart, Handy war im Hintergrund) den ganzen Stand neu holen.
  let opened = false;
  source.onopen = () => {
    if (opened) refreshState().then(() => { renderAll(); if (S.chatId) updateChat(); });
    opened = true;
  };
}

async function init() {
  await refreshState();
  const narrow = matchMedia('(max-width: 760px)').matches;
  S.chatId = narrow ? null : queue()[0]?.id || null;
  loadOverview();
  setInterval(() => S.view === 'overview' && !document.hidden && loadOverview(), 90_000);
  buildChat();
  renderAll();
  renderPageList();
  renderPage();
  renderProjects();
  const [startView, startSection] = location.hash.slice(1).split('/');
  // #chat/ID: Link aus der Teams-Benachrichtigung
  if (startView === 'chat' && S.chats.has(startSection)) selectChat(startSection);
  else if (VIEWS.includes(startView)) setView(startView);
  if (startView === 'settings' && startSection) $(`#settings [data-section="${startSection}"]`)?.scrollIntoView({ block: 'start' });
  connect();
  setInterval(() => {
    renderAll();
    if (S.chatId) updateChat();
  }, 30_000);
}

init().catch((err) => {
  document.body.insertAdjacentHTML('beforeend', `<div class="empty"><h2>Leitstand nicht erreichbar</h2><p>${esc(err.message)}</p></div>`);
});
