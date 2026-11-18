// Dateien der Projekte: durchsuchen, ausliefern, Websites und frische Ergebnisse finden.
// Gilt für Projekte, deren Ordner auf der Maschine des Leitstands liegt.
import fs from 'node:fs';
import path from 'node:path';
import { state, findMachine, httpError } from './store.js';

const SKIP = new Set(['node_modules', '.git', '.playwright-mcp', '.next', 'dist', '.cache', '__pycache__', '.venv']);
const hidden = (name) => name.startsWith('.') || SKIP.has(name);

function rootOf(project) {
  if (findMachine(project.machineId)?.kind !== 'local') {
    throw httpError(400, `Die Dateien von „${project.name}“ liegen auf einer anderen Maschine und lassen sich hier nicht anzeigen.`);
  }
  if (!fs.existsSync(project.dir)) throw httpError(404, 'Der Projektordner existiert noch nicht.');
  return fs.realpathSync(project.dir);
}

// Löst einen Pfad innerhalb des Projektordners auf und lässt nichts außerhalb zu,
// auch nicht über symbolische Links.
export function resolveInProject(project, relative) {
  const root = rootOf(project);
  const target = path.resolve(root, '.' + path.sep + String(relative || ''));
  if (!fs.existsSync(target)) throw httpError(404, 'Datei nicht gefunden');
  const real = fs.realpathSync(target);
  if (real !== root && !real.startsWith(root + path.sep)) throw httpError(403, 'Außerhalb des Projektordners');
  return real;
}

// Ergebnisse dürfen als absoluter Pfad im Projektordner gemeldet sein; die Ansicht braucht ihn relativ.
export function resultTarget(r) {
  const t = String(r.target || '');
  if (/^https?:\/\//.test(t) || !t.startsWith('/')) return t;
  const project = state.projects.find((p) => p.id === r.projectId);
  const dir = project?.dir ? String(project.dir).replace(/\/+$/, '') : '';
  return dir && t.startsWith(dir + '/') ? t.slice(dir.length + 1) : t;
}

export function listDir(project, relative) {
  const dir = resolveInProject(project, relative);
  if (!fs.statSync(dir).isDirectory()) throw httpError(400, 'Kein Ordner');
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => !hidden(e.name) && (e.isDirectory() || e.isFile()))
    .map((e) => {
      const stat = fs.statSync(path.join(dir, e.name));
      return { name: e.name, dir: e.isDirectory(), size: stat.size, mtime: stat.mtimeMs };
    })
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, 'de'));
}

// Geht den Projektordner bis zu einer festen Tiefe durch.
function walk(root, visit, maxDepth = 5, limit = 4000) {
  let seen = 0;
  const queue = [['', 0]];
  while (queue.length && seen < limit) {
    const [relative, depth] = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (hidden(entry.name)) continue;
      seen++;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (visit(child, entry, true) !== false && depth < maxDepth) queue.push([child, depth + 1]);
      } else if (entry.isFile()) {
        visit(child, entry, false);
      }
    }
  }
}

function titleOf(file) {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 8000);
    return (head.match(/<title[^>]*>([^<]{1,120})<\/title>/i)?.[1] || '').trim();
  } catch {
    return '';
  }
}

// Websites: Ordner mit einer index.html. Unterseiten einer gefundenen Website zählen nicht extra.
function sitesOf(project, root) {
  const sites = [];
  walk(root, (relative, entry, isDir) => {
    if (!isDir) return undefined;
    const index = path.join(root, relative, 'index.html');
    if (!fs.existsSync(index)) return undefined;
    sites.push({
      projectId: project.id,
      project: project.name,
      path: relative,
      title: titleOf(index) || path.basename(relative),
      mtime: fs.statSync(index).mtimeMs,
    });
    return false; // nicht tiefer in diese Website hinein
  });
  if (fs.existsSync(path.join(root, 'index.html'))) {
    sites.unshift({ projectId: project.id, project: project.name, path: '', title: titleOf(path.join(root, 'index.html')) || project.name, mtime: fs.statSync(path.join(root, 'index.html')).mtimeMs });
  }
  return sites;
}

function recentOf(project, root, limit) {
  const files = [];
  walk(root, (relative, entry, isDir) => {
    if (isDir) return undefined;
    const stat = fs.statSync(path.join(root, relative));
    files.push({ projectId: project.id, project: project.name, path: relative, size: stat.size, mtime: stat.mtimeMs });
    return undefined;
  });
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

// Alles, was die Übersicht über die Arbeit der Agenten zeigt.
export function overview() {
  const sites = [];
  const recent = [];
  const folders = [];
  for (const project of state.projects) {
    let root;
    try {
      root = rootOf(project);
    } catch {
      continue;
    }
    sites.push(...sitesOf(project, root));
    recent.push(...recentOf(project, root, 12));
    // Oberste Ordner mit Zahl der Dateien: zeigt auf einen Blick, was entstanden ist.
    for (const entry of listDir(project, '')) {
      if (!entry.dir) continue;
      for (const sub of listDir(project, entry.name)) {
        if (!sub.dir) continue;
        let count = 0;
        walk(path.join(root, entry.name, sub.name), (r, e, isDir) => { if (!isDir) count++; return undefined; });
        folders.push({ projectId: project.id, project: project.name, path: `${entry.name}/${sub.name}`, files: count, mtime: sub.mtime });
      }
    }
  }
  return {
    sites: sites.sort((a, b) => b.mtime - a.mtime).slice(0, 12),
    recent: recent.sort((a, b) => b.mtime - a.mtime).slice(0, 14),
    folders: folders.sort((a, b) => b.mtime - a.mtime).slice(0, 16),
    results: (state.results || []).slice(-40).reverse().map((r) => ({ ...r, target: resultTarget(r) })),
  };
}

export const FILE_TYPES = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.csv': 'text/csv',
  '.md': 'text/plain', '.txt': 'text/plain', '.xml': 'text/xml', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
};
