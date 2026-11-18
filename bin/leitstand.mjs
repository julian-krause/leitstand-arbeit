#!/usr/bin/env node
// Kommando der Agenten: Kontext, Tresor, Outlook/Teams/OneDrive/To Do, Teilaufträge, andere Lead-Agenten.
// Läuft nur innerhalb eines Laufs, den der Leitstand gestartet hat. Plattformunabhängig (Node);
// Aufruf über bin/leitstand (Mac, Linux) oder bin/leitstand.cmd (Windows).

const { LEITSTAND_URL: URL_BASE, LEITSTAND_RUN: TOKEN } = process.env;
if (!URL_BASE || !TOKEN) {
  console.error('leitstand: läuft nur innerhalb eines Agentenlaufs des Leitstands');
  process.exit(2);
}

const USAGE = `leitstand wer
leitstand kontext liste | lesen NAME | schreiben NAME   (Inhalt über stdin)
leitstand outlook liste [ORDNER] [ANZAHL] | suchen BEGRIFF | lesen ID | kalender [TAGE]
leitstand outlook entwurf AN BETREFF [CC] | senden AN BETREFF [CC] | antworten ID [alle]   (Text über stdin)
leitstand outlook termin TITEL START [ENDE|MINUTEN] [TEILNEHMER] [ORT] [teams]   (Beschreibung optional über stdin;
                                                      mit Teilnehmern als Einladung erst nach Freigabe)
leitstand outlook frei MAILS [TAG] | anhaenge ID [ZIELORDNER] | markieren ID gelesen|ungelesen|markiert|erledigt
leitstand outlook verschieben ID ORDNER
leitstand teams chats [ANZAHL] | lesen CHATID [ANZAHL] | senden CHATID   (Text über stdin)
leitstand teams kanaele | kanal TEAMID KANALID [ANZAHL] | posten TEAMID KANALID   (Text über stdin)
                                                      (senden/antworten/posten/Einladungen: erst nach Freigabe)
leitstand m365 heute | personen BEGRIFF               (Tagesüberblick; Personen mit Mail, Telefon, Abteilung)
leitstand dateien liste [PFAD|zuletzt|geteilt|ID] | suchen BEGRIFF   (OneDrive und SharePoint)
leitstand dateien laden ID [ZIEL] [pdf] | hochladen DATEI [ORDNER]
leitstand aufgaben liste [LISTE] | neu TITEL [FÄLLIG] [LISTE] | erledigt ID   (Microsoft To Do; Notiz über stdin bei neu)
leitstand tresor liste | zeigen NAME | code NAME
leitstand tresor neu NAME [BENUTZER] [ADRESSE]        (erzeugt ein Passwort)
leitstand tresor setzen NAME [BENUTZER] [ADRESSE]     (Passwort über stdin)
leitstand tresor 2fa NAME | notiz NAME                (Wert über stdin; 2fa mit leerer Eingabe entfernt den Schlüssel)
leitstand tresor loeschen NAME                        (fremde Einträge erst nach Freigabe durch den Menschen)
leitstand tell PROJEKTNAME NACHRICHT
leitstand laeufe | laeufe weiter IDS|alle | laeufe erledigt IDS|alle   (vom Menschen gestoppte Läufe, nur auf seine Anweisung)
leitstand auftrag TITEL [modell=auto|NAME] [aufwand=low|medium|high|xhigh|max]   (Auftragstext über stdin)
leitstand auftraege | auftraege stopp|weiter|entfernen IDS|alle | auftraege pause IDS|alle [bis=HH:MM|MINUTEN]
leitstand auftraege modell IDS|alle [modell=…] [aufwand=…]
leitstand projekte                                    (Projekte mit ihren letzten Chats)
leitstand weitergeben PROJEKT TITEL | nachreichen CHATID | verteilt   (nur Zentrale, Text über stdin)
leitstand projekt neu NAME [ORDNER]                   (nur Zentrale)
leitstand lesen CHATID [ANZAHL] | suchen BEGRIFF      (nur Zentrale)
leitstand fragen CHATID                               (nur Zentrale: Frage an einen Agenten, Text über stdin)
leitstand zentrale TEXT                               (Nachricht an die Zentrale)
leitstand uebergabe URL TEXT                          (Mensch erledigt einen Schritt selbst)
leitstand stand TEXT                                  (Zwischenstand bei langen Schritten)
leitstand ergebnis TITEL ZIEL [BESCHREIBUNG]          (ZIEL: Pfad im Projektordner oder Webadresse)`;

const fail = (msg) => {
  console.error(msg);
  process.exit(2);
};
const need = (v, what) => (v === undefined || v === '' ? fail(`${what} fehlt`) : v);

// Standardeingabe: Pflicht liest bis zum Ende; optional nur, wenn sie umgeleitet ist und Daten kommen.
function readStdin(optional = false) {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let data = '';
    let timer = optional ? setTimeout(() => resolve(data), 800) : null;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      data += c;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    });
    process.stdin.on('end', () => {
      if (timer) clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => resolve(data));
  });
}

async function call(route, fields = {}, method = 'POST') {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) body.append(k, String(v));
  const url = `${URL_BASE}/agent/${route}${method === 'GET' && [...body].length ? `?${body}` : ''}`;
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: method === 'POST' ? body : undefined,
      signal: AbortSignal.timeout(120_000),
    });
    process.stdout.write(`${await res.text()}\n`);
  } catch (err) {
    fail(`leitstand: keine Verbindung zum Leitstand (${err.message})`);
  }
}
const get = (route, fields) => call(route, fields, 'GET');

const [a = '', b = '', ...rest] = process.argv.slice(2);
const args = [b, ...rest]; // args[0] = Unterkommando
const pairs = (list) => Object.fromEntries(list.filter((w) => w.includes('=')).map((w) => [w.slice(0, w.indexOf('=')), w.slice(w.indexOf('=') + 1)]));
const words = (list) => list.filter((w) => !w.includes('='));
const r = rest;

const table = {
  wer: () => call('wer'),
  'kontext:liste': () => call('kontext'),
  'kontext:': () => call('kontext'),
  'kontext:lesen': () => get('kontext/lesen', { name: need(r[0], 'NAME') }),
  'kontext:schreiben': async () => call('kontext/schreiben', { name: need(r[0], 'NAME'), text: await readStdin() }),

  'outlook:': () => get('outlook/liste', {}),
  'outlook:liste': () => get('outlook/liste', { ordner: r[0] || '', anzahl: r[1] || '' }),
  'outlook:suchen': () => get('outlook/suchen', { begriff: need(r.join(' '), 'BEGRIFF') }),
  'outlook:lesen': () => get('outlook/lesen', { id: need(r[0], 'ID') }),
  'outlook:kalender': () => get('outlook/kalender', { tage: r[0] || '' }),
  'outlook:entwurf': async () => call('outlook/entwurf', { an: need(r[0], 'AN'), betreff: need(r[1], 'BETREFF'), cc: r[2] || '', text: await readStdin() }),
  'outlook:senden': async () => call('outlook/senden', { an: need(r[0], 'AN'), betreff: need(r[1], 'BETREFF'), cc: r[2] || '', text: await readStdin() }),
  'outlook:antworten': async () => call('outlook/antworten', { id: need(r[0], 'ID'), alle: r[1] === 'alle' ? '1' : '', text: await readStdin() }),
  'outlook:termin': async () => call('outlook/termin', {
    titel: need(r[0], 'TITEL'), start: need(r[1], 'START'), ende: r[2] || '', teilnehmer: r[3] || '', ort: r[4] || '',
    teams: r.includes('teams') ? '1' : '', text: await readStdin(true),
  }),
  'outlook:frei': () => get('outlook/frei', { wer: need(r[0], 'MAILS'), tag: r[1] || 'heute' }),
  'outlook:anhaenge': () => call('outlook/anhaenge', { id: need(r[0], 'ID'), ziel: r[1] || '' }),
  'outlook:markieren': () => call('outlook/markieren', { id: need(r[0], 'ID'), wie: need(r[1], 'gelesen|ungelesen|markiert|erledigt') }),
  'outlook:verschieben': () => call('outlook/verschieben', { id: need(r[0], 'ID'), ordner: need(r[1], 'ORDNER') }),

  'teams:': () => get('teams/chats', {}),
  'teams:chats': () => get('teams/chats', { anzahl: r[0] || '' }),
  'teams:lesen': () => get('teams/lesen', { chat: need(r[0], 'CHATID'), anzahl: r[1] || '' }),
  'teams:senden': async () => call('teams/senden', { chat: need(r[0], 'CHATID'), text: await readStdin() }),
  'teams:kanaele': () => call('teams/kanaele'),
  'teams:kanal': () => get('teams/kanal', { team: need(r[0], 'TEAMID'), kanal: need(r[1], 'KANALID'), anzahl: r[2] || '' }),
  'teams:posten': async () => call('teams/posten', { team: need(r[0], 'TEAMID'), kanal: need(r[1], 'KANALID'), text: await readStdin() }),

  'm365:': () => call('m365/heute'),
  'm365:heute': () => call('m365/heute'),
  'm365:personen': () => get('m365/personen', { begriff: need(r.join(' '), 'BEGRIFF') }),
  'dateien:': () => get('dateien/liste', {}),
  'dateien:liste': () => get('dateien/liste', { ort: r[0] || '' }),
  'dateien:suchen': () => get('dateien/suchen', { begriff: need(r.join(' '), 'BEGRIFF') }),
  'dateien:laden': () => {
    const pdf = r.includes('pdf');
    const plain = r.filter((w) => w !== 'pdf');
    return call('dateien/laden', { id: need(plain[0], 'ID'), ziel: plain[1] || '', format: pdf ? 'pdf' : '' });
  },
  'dateien:hochladen': () => call('dateien/hochladen', { datei: need(r[0], 'DATEI'), ordner: r[1] || '' }),
  'aufgaben:': () => get('aufgaben/liste', {}),
  'aufgaben:liste': () => get('aufgaben/liste', { liste: r[0] || '' }),
  'aufgaben:neu': async () => call('aufgaben/neu', { titel: need(r[0], 'TITEL'), faellig: r[1] || '', liste: r[2] || '', text: await readStdin(true) }),
  'aufgaben:erledigt': () => call('aufgaben/erledigt', { id: need(r[0], 'ID') }),

  'tresor:': () => call('tresor'),
  'tresor:liste': () => call('tresor'),
  'tresor:zeigen': () => get('tresor/zeigen', { name: need(r[0], 'NAME') }),
  'tresor:lesen': () => get('tresor/lesen', { name: need(r[0], 'NAME') }),
  'tresor:code': () => get('tresor/code', { name: need(r[0], 'NAME') }),
  'tresor:neu': () => call('tresor/neu', { name: need(r[0], 'NAME'), benutzer: r[1] || '', url: r[2] || '' }),
  'tresor:setzen': async () => call('tresor/setzen', { name: need(r[0], 'NAME'), benutzer: r[1] || '', url: r[2] || '', wert: await readStdin() }),
  'tresor:2fa': async () => call('tresor/2fa', { name: need(r[0], 'NAME'), wert: await readStdin() }),
  'tresor:notiz': async () => call('tresor/notiz', { name: need(r[0], 'NAME'), wert: await readStdin() }),
  'tresor:loeschen': () => call('tresor/loeschen', { name: need(r[0], 'NAME') }),

  'auftraege:modell': () => call('auftraege/modell', { ids: need(words(r).join(' '), 'IDS oder alle'), ...pairs(r) }),
  'auftraege:stopp': () => call('auftraege/stopp', { ids: need(r.join(' '), 'IDS oder alle') }),
  'auftraege:pause': () => call('auftraege/pause', { ids: need(r.join(' '), 'IDS oder alle') }),
  'auftraege:weiter': () => call('auftraege/weiter', { ids: need(r.join(' '), 'IDS oder alle') }),
  'auftraege:entfernen': () => call('auftraege/entfernen', { ids: need(r.join(' '), 'IDS oder alle') }),
  laeufe: () => call('laeufe'),
  'laeufe:liste': () => call('laeufe'),
  'laeufe:weiter': () => call('laeufe/weiter', { ids: need(r.join(' '), 'IDS oder alle') }),
  'laeufe:erledigt': () => call('laeufe/erledigt', { ids: need(r.join(' '), 'IDS oder alle') }),
  'projekt:neu': () => call('projekt/neu', { name: need(r[0], 'NAME'), ordner: r[1] || '' }),
};

// Kommandos, deren zweites Wort ein freier Wert ist.
const free = {
  auftrag: async () => {
    // „auftrag stopp ID“ usw. als Kurzform für auftraege
    if (['stopp', 'pause', 'weiter', 'entfernen'].includes(b) && rest[0] && !rest[0].includes('=')) return call(`auftraege/${b}`, { ids: rest.join(' ') });
    const opts = pairs(rest);
    for (const k of Object.keys(opts)) if (!['modell', 'model', 'aufwand', 'effort'].includes(k)) fail(`leitstand auftrag: unbekannte Angabe „${k}=…“ (erlaubt: modell=…, aufwand=…)`);
    return call('auftrag', { titel: need(b, 'TITEL'), ...opts, text: await readStdin() });
  },
  auftraege: () => call('auftraege'),
  projekte: () => call('projekte'),
  weitergeben: async () => call('weitergeben', { projekt: need(b, 'PROJEKT'), titel: need(rest[0], 'TITEL'), text: await readStdin() }),
  nachreichen: async () => call('nachreichen', { chat: need(b, 'CHATID'), text: await readStdin() }),
  verteilt: () => call('verteilt'),
  fragen: async () => call('fragen', { chat: need(b, 'CHATID'), text: await readStdin() }),
  zentrale: () => call('zentrale', { text: need(args.join(' ').trim(), 'TEXT') }),
  lesen: () => call('lesen', { chat: need(b, 'CHATID'), anzahl: rest[0] || '' }),
  suchen: () => call('suchen', { begriff: need(args.join(' ').trim(), 'BEGRIFF') }),
  ergebnis: () => call('ergebnis', { titel: need(b, 'TITEL'), ziel: need(rest[0], 'ZIEL'), text: rest[1] || '' }),
  stand: () => call('stand', { text: need(b, 'TEXT') }),
  uebergabe: () => call('uebergabe', { url: need(b, 'URL'), text: need(rest[0], 'TEXT') }),
  tell: () => call('tell', { projekt: need(b, 'PROJEKTNAME'), nachricht: need(rest[0], 'NACHRICHT') }),
  budget: () => console.log('Copilot-Kontingent ist hier nicht abrufbar. Normal arbeiten; bei einem Limit stellt der Leitstand den Lauf selbst zurück.'),
};

const handler = table[`${a}:${b}`] || (b === '' && table[a]) || free[a];
if (!handler) fail(USAGE);
await handler();
