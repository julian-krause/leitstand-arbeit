// Warteschlange, Plätze, Start und Überwachung der Agenten. Jeder Lauf ist ein Aufruf von
// GitHub Copilot CLI (`copilot -p … --output-format json`) im Projektordner. Die Vorgeschichte
// eines Chats ist eine Copilot-Sitzung: Der erste Lauf legt sie mit --session-id an, jeder
// weitere setzt sie mit --resume fort.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  state, ROOT, DATA_DIR, CONTEXT_DIR, AGENT_PORT, COPILOT_BIN,
  save, changed, chatChanged, id, findChat, findProject, findMachine, httpError, views,
} from './store.js';
import { leadPrompt, parseStatus, toolLabel, denialPatterns } from './agent.js';

// Unter Windows legt npm `copilot.cmd` an; die lässt sich ohne Shell nicht starten (und mit
// Shell wäre das Quoting des Prompts riskant). Darum dort direkt den Node-Einstieg starten.
function copilotCommand() {
  if (process.platform !== 'win32' || /\.exe$/i.test(COPILOT_BIN)) return [COPILOT_BIN, []];
  const dirs = path.isAbsolute(COPILOT_BIN) ? [path.dirname(COPILOT_BIN)] : String(process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    const loader = path.join(dir, 'node_modules', '@github', 'copilot', 'npm-loader.js');
    if (fs.existsSync(loader)) return [process.execPath, [loader]];
    if (fs.existsSync(path.join(dir, 'copilot.exe'))) return [path.join(dir, 'copilot.exe'), []];
  }
  return [COPILOT_BIN, []];
}

const running = new Map(); // chatId -> { child, machineId, token, interrupted, stopping }
const runTokens = new Map(); // Token eines Laufs -> chatId
const RUN_DIR = path.join(DATA_DIR, 'copilot');

// Andere Module können die Meldung am Ende eines Laufs ergänzen (etwa offene Freigaben).
export const attentionHooks = [];

views.fleet = () => ({
  machines: state.machines.map((m) => ({ ...m, running: runningCount(m.id) })),
});

export const chatForRunToken = (token) => findChat(runTokens.get(token));
export const runningCount = (machineId) => [...running.values()].filter((r) => r.machineId === machineId).length;
export const isRunning = (chatId) => running.has(chatId);

// ---------- Warteschlange ----------

export function addMessage(chat, role, text, extra = {}) {
  chat.messages.push({ id: id(), role, text, ts: Date.now(), ...extra });
}

export function newChat(project, title, extra = {}) {
  const chat = {
    id: id(),
    projectId: project.id,
    title: String(title).trim().slice(0, 80) || 'Auftrag',
    sessionId: null,
    status: 'idle',
    attention: null,
    snoozeUntil: null,
    crew: 0,
    activity: null,
    pending: [],
    messages: [],
    createdAt: Date.now(),
    ...extra,
  };
  state.chats.push(chat);
  return chat;
}

function enqueue(chat, text, notBefore = 0) {
  // Hatte ein pausierter oder gestoppter Lauf noch eine Nachricht offen, geht sie mit.
  if (chat.held) text = `${text}\n\nDiese Nachricht war beim Anhalten noch offen:\n\n${chat.held}`;
  chat.held = null;
  chat.paused = null;
  chat.stopped = null;
  chat.waitingFor = null;
  chat.queued = { text, at: Date.now(), reason: '', notBefore };
  chat.status = 'queued';
  chat.attention = null;
  chat.snoozeUntil = null;
  chatChanged(chat);
  pump();
}

// „Unterbrechen“: beendet den laufenden Copilot-Aufruf, die Sitzung bleibt. Eine mitgeschickte
// Nachricht bearbeitet der Agent direkt danach (mit --resume).
export function interruptRun(chat, text = '') {
  const run = running.get(chat.id);
  if (!run) throw httpError(409, 'Der Agent läuft gerade nicht.');
  run.interrupted = true;
  run.child.kill('SIGINT');
  setTimeout(() => {
    if (run.child.exitCode === null) run.child.kill('SIGTERM');
  }, 5000).unref();
  addMessage(chat, 'system', 'Unterbrochen.');
  if (text.trim()) sendMessage(chat, text.trim());
  else chatChanged(chat);
}

// `text` geht an den Agenten, `shown` steht im Chat. `copilot -p` nimmt während eines Laufs
// keine Eingaben an: Nachrichten an einen laufenden Agenten gehen gesammelt in den nächsten Zug.
export function sendMessage(chat, text, shown = text) {
  addMessage(chat, 'user', shown);
  const run = running.get(chat.id);
  if (run) {
    chat.pending = [...(chat.pending || []), text];
    chatChanged(chat);
  } else if (chat.status === 'queued' && chat.queued) {
    chat.queued.text += `\n\n${text}`;
    chatChanged(chat);
  } else {
    enqueue(chat, text);
  }
}

function setWaitReason(chat, reason) {
  if (chat.queued.reason === reason) return;
  chat.queued.reason = reason;
  chatChanged(chat);
}

const fmtClock = (ts) => new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

export function pump() {
  const waiting = state.chats
    .filter((c) => c.status === 'queued' && c.queued && !running.has(c.id))
    .sort((a, b) => a.queued.at - b.queued.at);
  for (const chat of waiting) {
    const project = findProject(chat.projectId);
    const machine = findMachine('lokal');
    if (!project) {
      chat.queued = null;
      finishRun(chat, { kind: 'fehler', kurz: 'Das Projekt gibt es nicht mehr.' });
    } else if (chat.queued.notBefore > Date.now()) {
      setWaitReason(chat, `Copilot-Limit erreicht, nächster Versuch ${fmtClock(chat.queued.notBefore)}`);
    } else if (runningCount(machine.id) >= machine.slots) {
      setWaitReason(chat, 'wartet auf einen freien Platz');
    } else {
      startRun(chat, project, machine);
    }
  }
}
setInterval(pump, 15_000).unref();

// ---------- Ein Lauf ----------

// Lange Nachrichten (Transkripte) passen nicht in ein Programmargument: Sie gehen als Datei mit.
const MAX_ARG = 100_000;

function copilotArgs(chat, project, text, dir) {
  let prompt = text;
  if (Buffer.byteLength(text) > MAX_ARG) {
    const file = path.join(dir, `nachricht-${Date.now()}.md`);
    fs.writeFileSync(file, text);
    prompt = `Die Nachricht ist zu lang für die Eingabe und liegt vollständig in der Datei ${file}. Lies sie zuerst ganz und bearbeite sie dann.\n\nAnfang:\n${text.slice(0, 4000)}`;
  }
  const args = ['-p', prompt, '--output-format', 'json', '--no-color', '--no-ask-user', '--no-auto-update', '--add-dir', CONTEXT_DIR, '--add-dir', dir];

  // Die Zentrale führt ein Gespräch, aber nur ein kurzes: Nach 20 Zügen oder 4 Stunden Pause
  // beginnt sie eine frische Sitzung. Was bleiben soll, steht in ihrem Notizbuch und im Prompt.
  let fresh = !chat.sessionId;
  if (project.zentrale) {
    fresh = fresh || (chat.zentraleTurns || 0) >= 20 || Date.now() - (chat.zentraleLast || 0) > 4 * 3_600_000;
    if (fresh) chat.zentraleTurns = 0;
    chat.zentraleTurns = (chat.zentraleTurns || 0) + 1;
    chat.zentraleLast = Date.now();
  }
  if (fresh) chat.sessionId = crypto.randomUUID();
  args.push(fresh ? '--session-id' : '--resume', chat.sessionId);

  const { model, effort } = runModel(chat, project);
  if (model) args.push('--model', model);
  if (effort) args.push('--reasoning-effort', effort);

  // Rechte: „autonom“ darf alles, auch außerhalb des Projektordners. „selbststaendig“ führt
  // jedes Werkzeug ohne Rückfrage aus, bleibt aber in Projektordner und Kontext. „vorsichtig“
  // darf Dateien ändern und das Kommando `leitstand`; alles andere wird verweigert und dem
  // Menschen als Erlaubnis vorgelegt.
  if (project.mode === 'autonom' && !project.zentrale) args.push('--allow-all');
  else if (project.mode === 'vorsichtig') {
    for (const rule of new Set(['write', 'shell(leitstand:*)', 'shell(echo)', 'shell(printf)', ...(project.allow || [])])) args.push('--allow-tool', rule);
    args.push('--allow-all-urls');
  } else args.push('--allow-all-tools', '--allow-all-urls');
  return args;
}

function startRun(chat, project, machine) {
  // Ein Hinweis des Leitstands (etwa ein gestoppter Teilauftrag) geht einmal mit.
  const text = chat.note ? `${chat.note}\n\n${chat.queued.text}` : chat.queued.text;
  chat.note = null;
  const token = crypto.randomBytes(24).toString('hex');

  // Die Anweisungen des Leitstands lädt Copilot als AGENTS.md aus einem eigenen Ordner je Chat
  // (COPILOT_CUSTOM_INSTRUCTIONS_DIRS); sie werden vor jedem Lauf neu geschrieben.
  const dir = path.join(RUN_DIR, chat.id);
  let child;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), leadPrompt(project, chat));
    const args = copilotArgs(chat, project, text, dir);
    fs.mkdirSync(project.dir, { recursive: true });
    const env = {
      ...process.env,
      PATH: `${path.join(ROOT, 'bin')}${path.delimiter}${process.env.PATH}`,
      LEITSTAND_URL: `http://127.0.0.1:${AGENT_PORT}`,
      LEITSTAND_RUN: token,
      COPILOT_CUSTOM_INSTRUCTIONS_DIRS: [dir, process.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS].filter(Boolean).join(','),
      COPILOT_AUTO_UPDATE: 'false',
    };
    const [bin, pre] = copilotCommand();
    child = spawn(bin, [...pre, ...args], { cwd: project.dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (err) {
    chat.queued = null;
    finishRun(chat, { kind: 'fehler', kurz: `Agent konnte nicht starten: ${err.message}` });
    return;
  }

  const run = { child, machineId: machine.id, token, interrupted: false, stopping: false };
  running.set(chat.id, run);
  runTokens.set(token, chat.id);
  chat.queued = null;
  chat.status = 'running';
  chat.attention = null;
  chat.handoff = null;
  chat.crew = 0;
  chat.activity = 'Startet …';
  chat.machineId = machine.id;
  chatChanged(chat);
  changed('fleet');

  const openTasks = new Set();
  const toolArgs = new Map(); // toolCallId -> { name, input }
  const denials = [];
  let lastAgentText = '';
  let result = null;
  let sessionError = '';
  let stderr = '';
  let buffer = '';

  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  child.on('error', (err) => {
    stderr += `\n${err.message}`;
  });

  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // Zeilen, die kein JSON sind
      }
      try {
        handleEvent(event);
      } catch {}
    }
  });

  const textOf = (content) =>
    typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('') : '';

  function handleEvent(event) {
    const data = event.data || {};
    const fromSubagent = Boolean(data.parentToolCallId || event.parentToolCallId || data.agentId);
    switch (event.type) {
      case 'assistant.message': {
        const message = textOf(data.content);
        if (message.trim() && !fromSubagent) {
          lastAgentText = message;
          const parsed = parseStatus(message);
          if (parsed.text) addMessage(chat, 'agent', parsed.text);
          chatChanged(chat);
        }
        break;
      }
      case 'tool.execution_start': {
        const name = data.toolName || data.name || 'Werkzeug';
        const input = typeof data.arguments === 'string' ? (() => { try { return JSON.parse(data.arguments); } catch { return {}; } })() : data.arguments || {};
        toolArgs.set(data.toolCallId, { name, input });
        if (name === 'task' || name === 'agent') openTasks.add(data.toolCallId);
        chat.activity = toolLabel({ name, input });
        if (!fromSubagent && name !== 'report_intent') addMessage(chat, 'tool', chat.activity);
        chat.crew = openTasks.size;
        chatChanged(chat);
        break;
      }
      case 'tool.execution_complete': {
        openTasks.delete(data.toolCallId);
        const call = toolArgs.get(data.toolCallId);
        const err = [data.error?.message, data.error?.code, typeof data.result === 'string' ? data.result : data.result?.content].filter(Boolean).join(' ');
        if (call && data.success === false && /denied|not (been )?(permitted|allowed|approved)|permission|verweigert|rejected/i.test(err)) {
          denials.push({ tool_name: call.name, tool_input: call.input });
        }
        if (chat.crew !== openTasks.size) {
          chat.crew = openTasks.size;
          chatChanged(chat);
        }
        break;
      }
      case 'session.error':
        sessionError = String(data.message || data.error || JSON.stringify(data)).slice(0, 500);
        break;
      case 'result':
        result = event;
        if (event.sessionId && event.sessionId !== chat.sessionId) {
          chat.sessionId = event.sessionId;
          save();
        }
        break;
      default:
        break;
    }
  }

  child.on('close', (code, signal) => {
    if (running.get(chat.id) !== run) return; // gestoppt, schon abgeschlossen
    const usage = result?.usage || {};
    if (usage.premiumRequests) chat.premiumRequests = (chat.premiumRequests || 0) + usage.premiumRequests;

    if (run.interrupted) {
      if (chat.pending?.length) {
        releaseRun(chat, run);
        const next = chat.pending.join('\n\n');
        chat.pending = [];
        enqueue(chat, next);
        changed('fleet');
        return;
      }
      finishRun(chat, { kind: 'antwort', kurz: 'Du hast den Agenten unterbrochen. Schreib ihm, wie es weitergehen soll.' });
      return;
    }
    const exitCode = result?.exitCode ?? code;
    const failed = exitCode !== 0 || (!result && !lastAgentText);
    const errorText = sessionError || stderr.trim().split('\n').filter(Boolean).slice(-3).join(' ') || `Exit-Code ${exitCode ?? signal}`;

    if (failed && /rate.?limit|quota|premium requests|429|too many requests|limit (reached|exceeded)/i.test(errorText)) {
      // Copilot-Limit: Auftrag zurück in die Warteschlange, neuer Versuch in 15 Minuten.
      releaseRun(chat, run);
      addMessage(chat, 'system', `Copilot-Limit erreicht (${errorText.slice(0, 160)}). Neuer Versuch in 15 Minuten.`);
      enqueue(chat, `Dein letzter Lauf wurde durch ein Limit unterbrochen. Prüf kurz den Stand und mach dort weiter. Die Nachricht, an der du gearbeitet hast:\n\n${text}`, Date.now() + 15 * 60_000);
      changed('fleet');
      return;
    }
    if (failed && /session.{0,40}(not found|does not exist|unknown)|no (such )?session/i.test(errorText)) {
      releaseRun(chat, run);
      chat.sessionId = null;
      addMessage(chat, 'system', 'Die Vorgeschichte dieses Chats liegt nicht mehr vor. Der Agent beginnt neu und stützt sich auf die Dateien und den gemeinsamen Kontext.');
      enqueue(chat, text);
      changed('fleet');
      return;
    }
    if (failed && /authenticat|not logged in|login/i.test(errorText)) {
      finishRun(chat, { kind: 'fehler', kurz: `Copilot ist auf diesem Rechner nicht angemeldet. Einmal im Terminal \`copilot\` starten und /login ausführen (oder COPILOT_GITHUB_TOKEN setzen). ${errorText}`.slice(0, 500) });
      return;
    }
    if (failed) {
      finishRun(chat, { kind: 'fehler', kurz: `Der Agent ist abgebrochen: ${errorText}`.slice(0, 500) });
      return;
    }

    const { status } = parseStatus(lastAgentText);
    const kind = ['fertig', 'entscheidung', 'blockiert', 'wartet'].find((k) => status?.zustand?.toLowerCase().startsWith(k));
    const attention = {
      kind: kind || 'antwort',
      kurz: status?.kurz || 'Der Agent hat geantwortet.',
      frage: status?.frage,
      optionen: status?.optionen ? status.optionen.split('|').map((o) => o.trim()).filter(Boolean) : [],
      naechster_schritt: status?.naechster_schritt,
    };
    // Verweigerte Schritte: Hat der Agent sein Ziel trotzdem erreicht, sind sie erledigt und
    // kosten den Menschen keinen Klick. Nur wenn er nicht fertig geworden ist, kommen sie mit
    // auf den Tisch, zusammen mit seiner eigentlichen Frage.
    const seen = new Set();
    const requests = denials
      .map((denial) => ({
        tool: denial.tool_name,
        detail: String(denial.tool_input?.command || denial.tool_input?.url || denial.tool_input?.path || denial.tool_input?.query || ''),
        patterns: denialPatterns(denial),
      }))
      .filter((r) => !seen.has(r.tool + r.detail) && seen.add(r.tool + r.detail));
    if (requests.length && kind !== 'fertig') {
      attention.requests = requests;
      if (!kind) {
        attention.kind = 'erlaubnis';
        attention.kurz = status?.kurz || 'Der Agent kommt ohne eine Erlaubnis nicht weiter.';
      }
    }
    // Übergabe: Der Mensch erledigt einen Schritt selbst, etwa in seinem Browser.
    if (chat.handoff && attention.kind !== 'fertig') {
      attention.kind = 'uebergabe';
      attention.frage = chat.handoff.text;
      attention.url = chat.handoff.url;
    }
    chat.handoff = null;
    finishRun(chat, attention);
  });
}

function releaseRun(chat, run) {
  running.delete(chat.id);
  if (run) runTokens.delete(run.token);
  chat.crew = 0;
  chat.activity = null;
  chat.assist = null;
  chat.progress = null;
}

// ---------- Teilaufträge ----------
// Ein Lead-Agent kann Teile eines großen Auftrags an eigene Agenten vergeben. Die laufen als
// eigene Chats parallel, und ihr Ergebnis geht als Nachricht an ihn zurück, nicht an den Menschen.

const MAX_OPEN_CHILDREN = 8;
const MAX_CHILDREN = 24;
// Teilaufträge können selbst Teilaufträge vergeben, bis zu dieser Tiefe (Lead = 0).
export const MAX_DEPTH = 3;
// Höchstens so viele offene Teilaufträge in einem ganzen Auftragsbaum.
const MAX_OPEN_TREE = 16;
// Modelle sind die Namen von `copilot --model` (etwa auto, claude-sonnet-4.5, gpt-5).
// Vorgabe: LEITSTAND_MODEL oder „auto“ (Copilot wählt selbst).
export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const DEFAULT_MODEL = process.env.LEITSTAND_MODEL || 'auto';
export const DEFAULT_EFFORT = process.env.LEITSTAND_EFFORT || '';
export const ZENTRALE_MODEL = process.env.LEITSTAND_ZENTRALE_MODEL || '';
export const runModel = (chat, project) => project?.zentrale ? { model: ZENTRALE_MODEL || project.model || DEFAULT_MODEL, effort: project.effort || DEFAULT_EFFORT } : ({
  model: chat.model || project?.model || DEFAULT_MODEL,
  effort: chat.effort || project?.effort || DEFAULT_EFFORT,
});
const MODEL_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;
// Prüft modell=/aufwand= und gibt nur gültige Werte zurück; leer heißt „Vorgabe“.
export function pickModel({ model, effort } = {}) {
  const m = String(model || '').trim();
  const e = String(effort || '').trim().toLowerCase();
  if (m && !MODEL_RE.test(m)) throw httpError(400, `Ungültiger Modellname „${m}“ (wie bei copilot --model, etwa auto).`);
  if (e && !EFFORTS.includes(e)) throw httpError(400, `Unbekannter Aufwand „${e}“. Möglich: ${EFFORTS.join(', ')}.`);
  const out = {};
  if (m) out.model = m;
  if (e) out.effort = e;
  return out;
}
export const depthOf = (chat) => {
  let d = 0;
  for (let c = chat; c?.parentId && d < 20; c = state.chats.find((x) => x.id === c.parentId)) d++;
  return d;
};
const rootOf = (chat) => {
  let c = chat;
  for (let i = 0; c?.parentId && i < 20; i++) c = state.chats.find((x) => x.id === c.parentId) || c;
  return c;
};
const descendantsOf = (chat) => {
  const out = [];
  const walk = (c) => { for (const k of state.chats.filter((x) => x.parentId === c.id)) { out.push(k); walk(k); } };
  walk(chat);
  return out;
};
export const childrenOf = (chat) => state.chats.filter((c) => c.parentId === chat.id);
const isOpen = (chat) => chat.status === 'running' || chat.status === 'queued';

export function spawnChild(parent, title, text, opts = {}) {
  if (findProject(parent.projectId)?.zentrale) throw httpError(403, 'Die Zentrale vergibt keine Teilaufträge. Gib Arbeit mit `leitstand weitergeben` an ein Projekt.');
  const depth = depthOf(parent) + 1;
  if (depth > MAX_DEPTH) throw httpError(403, `Tiefer als ${MAX_DEPTH} Ebenen gehen Teilaufträge nicht. Erledige die Arbeit selbst oder mit Unter-Agenten in deinem Zug.`);
  if (descendantsOf(rootOf(parent)).filter(isOpen).length >= MAX_OPEN_TREE) throw httpError(429, `In diesem Auftrag laufen schon ${MAX_OPEN_TREE} Teilaufträge. Warte auf Ergebnisse, bevor du weitere vergibst.`);
  const choice = pickModel(opts);
  const children = childrenOf(parent);
  if (children.filter(isOpen).length >= MAX_OPEN_CHILDREN) throw httpError(429, `Es laufen schon ${MAX_OPEN_CHILDREN} Teilaufträge. Warte auf Ergebnisse, bevor du weitere vergibst.`);
  if (children.length >= MAX_CHILDREN) throw httpError(429, 'Für diesen Auftrag sind schon sehr viele Teilaufträge vergeben. Mach mit den vorhandenen Ergebnissen weiter.');
  const project = findProject(parent.projectId);
  const child = newChat(project, title, { parentId: parent.id, ...choice });
  sendMessage(
    child,
    `Du bearbeitest einen Teilauftrag aus dem größeren Auftrag „${parent.title}“. Dein Auftraggeber ist der Lead-Agent dieses Auftrags, nicht der Mensch: Dein Ergebnis geht direkt an ihn zurück. Er kennt deinen Chat nicht, also muss deine letzte Antwort für sich stehen und alles enthalten, was er zum Weiterarbeiten braucht (Ergebnis, Pfade der Dateien, offene Punkte).${depth < MAX_DEPTH ? ` Du bist Ebene ${depth} von höchstens ${MAX_DEPTH}: Ist dein Teil selbst groß, darfst du ihn mit \`leitstand auftrag\` weiter zerlegen.` : ` Du bist auf der untersten Ebene (${depth}): Weitere Teilaufträge gehen nicht, nimm Unter-Agenten in deinem Zug.`}\n\nTeilauftrag „${title}“:\n${text}`,
    text,
  );
  return child;
}

// Ergebnis eines Teilauftrags zurück an den Auftraggeber. Gibt true zurück, wenn der Mensch
// damit nichts mehr zu tun hat.
function reportToParent(chat, attention) {
  const parent = chat.parentId && findChat(chat.parentId);
  if (!parent || parent.status === 'archived') return false;
  if (!['fertig', 'antwort'].includes(attention.kind)) return false; // echte Entscheidungen gehen an den Menschen
  const last = [...chat.messages].reverse().find((m) => m.role === 'agent');
  chat.status = 'done';
  chat.attention = null;
  chatChanged(chat);
  sendMessage(
    parent,
    `Ergebnis des Teilauftrags „${chat.title}“:\n\n${last?.text || attention.kurz}`,
    `Teilauftrag fertig: ${chat.title}`,
  );
  return true;
}

function finishRun(chat, attention) {
  releaseRun(chat, running.get(chat.id));
  if (attention.kind === 'fehler') addMessage(chat, 'system', attention.kurz);
  for (const hook of attentionHooks) attention = hook(chat, attention) || attention;

  // Der Agent wartet auf seine Teilaufträge: kein Fall für den Menschen. Läuft keiner mehr,
  // ist das Warten ein Irrtum und wird wie eine normale Antwort behandelt.
  if (attention.kind === 'wartet') {
    if (childrenOf(chat).some((c) => isOpen(c) || c.paused?.until) || chat.pending?.length) attention.waiting = true;
    else attention.kind = 'antwort';
  }

  // Nachrichten, die während des Laufs kamen, gehen direkt weiter.
  if (chat.pending?.length && attention.kind !== 'fehler') {
    const next = chat.pending.join('\n\n');
    chat.pending = [];
    enqueue(chat, next);
  } else if (findProject(chat.projectId)?.zentrale && !['entscheidung', 'blockiert', 'fehler'].includes(attention.kind)) {
    // Die Zentrale meldet sich nur, wenn sie eine Entscheidung braucht. Ein erledigtes
    // Weitergeben landet nicht in der Warteschlange.
    chat.pending = [];
    chat.status = 'idle';
    chat.attention = null;
    chatChanged(chat);
  } else if (attention.waiting) {
    chat.pending = [];
    chat.status = 'waiting';
    chat.attention = null;
    chat.waitingFor = attention.kurz;
    chatChanged(chat);
  } else if (!reportToParent(chat, attention)) {
    chat.pending = [];
    chat.status = 'attention';
    chat.attention = { ...attention, since: Date.now() };
    chatChanged(chat);
  }
  changed('fleet');
  pump();
}

function killRun(chat, run) {
  if (!run) return;
  run.stopping = true;
  run.child.kill('SIGTERM');
}

// Was der Agent noch nicht bekommen hat (Warteschlange, Nachrichten während des Laufs).
const heldText = (chat) => [chat.held, chat.queued?.text, ...(chat.pending || [])].filter(Boolean).join('\n\n') || null;

// by: 'mensch' (Knopf in der Oberfläche), 'auftrag' (mit dem übergeordneten Auftrag), 'lead' (vom Lead-Agenten)
export function stopRun(chat, note = 'Lauf gestoppt.', { byParent = false, by = byParent ? 'auftrag' : 'mensch', withId = null } = {}) {
  const run = running.get(chat.id);
  const openChildren = childrenOf(chat).filter((c) => isOpen(c) || c.status === 'waiting');
  if (!run && chat.status !== 'queued' && chat.status !== 'waiting' && !openChildren.length) return;
  // Wer einen Auftrag stoppt, stoppt auch seine laufenden, wartenden und pausierten Teilaufträge.
  for (const child of openChildren) {
    stopRun(child, `Gestoppt, weil der Auftrag „${chat.title}“ gestoppt wurde.`, { byParent: true, withId: chat.id });
  }
  killRun(chat, run);
  releaseRun(chat, run);
  chat.held = heldText(chat);
  chat.queued = null;
  chat.pending = [];
  chat.waitingFor = null;
  chat.paused = null;
  chat.stopped = { since: Date.now(), by, withId };
  // Mitgestoppte Teilaufträge landen nicht einzeln beim Menschen, sie gelten als erledigt.
  chat.status = byParent ? 'done' : 'attention';
  chat.attention = byParent ? null : {
    kind: 'antwort',
    kurz: openChildren.length ? `Du hast den Lauf gestoppt, mit ${openChildren.length === 1 ? 'einem Teilauftrag' : `${openChildren.length} Teilaufträgen`}.` : 'Du hast den Lauf gestoppt.',
    since: Date.now(),
  };
  addMessage(chat, 'system', openChildren.length ? `${note} Mitgestoppt: ${openChildren.map((c) => `„${c.title}“`).join(', ')}.` : note);
  chatChanged(chat);
  if (by === 'mensch' && chat.parentId) tellParentStopped(chat, 'Der Mensch hat ihn gestoppt.');
  changed('fleet');
  pump();
}

// ---------- Teilaufträge steuern: Lead-Agenten stoppen, pausieren und setzen fort ----------

const RESUME_CHILD = 'Dein Lauf war angehalten und geht jetzt weiter. Prüf kurz den Stand (Dateien, Teilaufträge) und mach dort weiter, wo du warst. Wiederhol nichts, was schon erledigt ist, vor allem keine Nachrichten nach außen.';

// Der Lead erfährt, dass ein Teilauftrag nicht mehr läuft. Geweckt wird er nur, wenn er sonst
// für immer warten würde; sonst bekommt er es mit seiner nächsten Nachricht.
function tellParentStopped(chat, why) {
  const parent = chat.parentId && findChat(chat.parentId);
  if (!parent || parent.status === 'archived' || parent.stopped) return;
  const text = `Der Teilauftrag „${chat.title}“ [${chat.id}] läuft nicht mehr: ${why} Vergib ihn nicht neu, das kostet die Arbeit doppelt. Fortsetzen mit seiner Vorgeschichte geht mit \`leitstand auftraege weiter ${chat.id}\`, aber nur, wenn der Mensch das will; frag ihn dann mit zustand: entscheidung. Sonst mach mit den vorhandenen Ergebnissen weiter.`;
  const stillOpen = childrenOf(parent).some((c) => c.id !== chat.id && (isOpen(c) || c.paused?.until));
  if (running.has(parent.id) || parent.status === 'queued' || (parent.status === 'waiting' && !stillOpen)) {
    sendMessage(parent, text, `Teilauftrag angehalten: ${chat.title}`);
  } else {
    parent.note = parent.note ? `${parent.note}\n\n${text}` : text;
  }
}

// ---------- Beendete Teilaufträge entfernen ----------
// „Entfernen“ archiviert: Der Chat verschwindet aus der Liste, bleibt aber gespeichert.
// Nur beendete Teilaufträge, samt allem, was sie selbst vergeben haben.
export const isFinished = (c) =>
  ['done', 'idle', 'archived'].includes(c.status) ||
  (c.status === 'attention' && (Boolean(c.stopped) || ['fertig', 'fehler', 'antwort'].includes(c.attention?.kind)));
const subtree = (chat) => childrenOf(chat).flatMap((c) => [c, ...subtree(c)]);
export const canRemove = (c) => c.status !== 'archived' && isFinished(c) && subtree(c).every(isFinished);

export function removeChild(child, by) {
  if (!canRemove(child)) return false;
  for (const c of [child, ...subtree(child)]) {
    if (c.status === 'archived') continue;
    c.status = 'archived';
    c.attention = null;
    c.queued = null;
    c.snoozeUntil = null;
    c.removed = { since: Date.now(), by };
    chatChanged(c);
  }
  changed('fleet');
  return true;
}

// Alle beendeten Teilaufträge eines Chats (für den Knopf in der Oberfläche).
export function removeFinishedChildren(chat, by) {
  return childrenOf(chat).filter((c) => removeChild(c, by));
}

export function stopChild(child, lead) {
  if (child.status === 'attention') {
    // Wartet auf den Menschen: nichts mehr zu stoppen, nur ablegen.
    child.held = heldText(child);
    child.status = 'done';
    child.attention = null;
    child.stopped = { since: Date.now(), by: 'lead', withId: null };
    addMessage(child, 'system', `Vom Lead-Agenten („${lead.title}“) beendet.`);
    chatChanged(child);
    changed('fleet');
    return true;
  }
  if (!isOpen(child) && child.status !== 'waiting') return false;
  stopRun(child, `Vom Lead-Agenten („${lead.title}“) gestoppt.`, { byParent: true, by: 'lead' });
  return true;
}

export function pauseChild(child, lead, until = null) {
  // Eigene Teilaufträge des pausierten Teilauftrags halten mit an.
  for (const sub of childrenOf(child).filter(isOpen)) pauseChild(sub, child, until);
  if (child.status === 'waiting' && child.paused) {
    child.paused.until = until;
    child.waitingFor = pausedLabel(until);
    chatChanged(child);
    return true;
  }
  if (!isOpen(child)) return false;
  const run = running.get(child.id);
  killRun(child, run);
  releaseRun(child, run);
  child.held = heldText(child);
  child.queued = null;
  child.pending = [];
  child.status = 'waiting';
  child.attention = null;
  child.paused = { since: Date.now(), until, by: lead.id };
  child.waitingFor = pausedLabel(until);
  addMessage(child, 'system', `Vom Lead-Agenten („${lead.title}“) pausiert${until ? `, geht ${fmtTime(until)} von selbst weiter` : ''}.`);
  chatChanged(child);
  changed('fleet');
  pump();
  return true;
}

const fmtTime = (ts) => new Date(ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const pausedLabel = (until) => `Pausiert vom Lead-Agenten${until ? `, geht ${fmtTime(until)} weiter` : ''}.`;

export const isResumable = (c) => (c.status === 'waiting' && c.paused) || (c.stopped && ['done', 'attention'].includes(c.status));

export function resumeChat(chat, shown) {
  if (!isResumable(chat)) return false;
  chat.attention = null;
  // Ohne Vorgeschichte beginnt der Agent mit der offenen Nachricht neu.
  const first = chat.messages.find((m) => m.role === 'user')?.text;
  const fresh = chat.held || (first && `Du bearbeitest diesen Auftrag (ein früherer Anlauf wurde abgebrochen; prüf zuerst, was davon schon in den Dateien steht):\n\n${first}`);
  const text = chat.sessionId || !fresh ? RESUME_CHILD : fresh;
  if (!chat.sessionId) chat.held = null;
  sendMessage(chat, text, shown);
  return true;
}

// Pausen mit Uhrzeit laufen von selbst ab.
setInterval(() => {
  const due = state.chats.filter((c) => c.status === 'waiting' && c.paused?.until && c.paused.until <= Date.now());
  for (const c of due) resumeChat(c, 'Pause vorbei, geht von selbst weiter.');
}, 30_000).unref();

// Pausen „bis=reset“ gibt es bei Copilot nicht als Kontingentfenster: eine Stunde.
export function nextReset() {
  return Date.now() + 3_600_000;
}

export function stopAll() {
  for (const run of running.values()) run.child.kill('SIGTERM');
}

// ---------- Start: Zustand nach einem Neustart aufräumen ----------
// Ein Lauf, den ein Neustart abgebrochen hat, geht mit seiner Vorgeschichte von selbst weiter.
// Nachrichten, die während des Laufs noch gewartet haben, gehen mit.

const RESUME = 'Der Leitstand wurde neu gestartet, dein letzter Lauf wurde dabei unterbrochen. Prüf kurz den Stand (Dateien, offene Teilaufträge) und mach dort weiter, wo du warst. Wiederhol nichts, was schon erledigt ist, vor allem keine Nachrichten nach außen. Hattest du auf den Menschen gewartet, frag erneut nach.';

const abortedChildren = [];
for (const chat of state.chats) {
  if (chat.status !== 'running') continue;
  chat.crew = 0;
  chat.activity = null;
  chat.assist = null;
  if (chat.sessionId) {
    const pending = chat.pending || [];
    chat.pending = [];
    chat.status = 'queued';
    chat.attention = null;
    chat.queued = { text: [RESUME, ...pending].join('\n\n'), at: Date.now(), reason: '' };
    addMessage(chat, 'system', 'Der Leitstand wurde neu gestartet. Der Agent macht von selbst dort weiter, wo er war.');
  } else {
    chat.status = 'attention';
    chat.attention = {
      kind: 'fehler',
      kurz: 'Der Leitstand wurde neu gestartet, der Lauf wurde dabei abgebrochen.',
      since: Date.now(),
    };
    chat.stopped = { since: Date.now(), by: 'neustart', withId: null };
    if (chat.parentId) abortedChildren.push(chat);
  }
}
setTimeout(() => {
  for (const chat of abortedChildren) tellParentStopped(chat, 'Ein Neustart des Leitstands hat ihn abgebrochen, bevor er angefangen hatte.');
}, 400).unref();
setTimeout(pump, 500).unref();
