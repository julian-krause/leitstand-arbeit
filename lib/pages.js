// Gemeinsamer Kontext: Seiten (.md) und Tabellen (.csv) in einem Ordner.
import fs from 'node:fs';
import path from 'node:path';
import { CONTEXT_DIR, broadcast, httpError } from './store.js';

const PAGE_NAME = /^[\p{L}\p{N} _.()-]{1,80}\.(md|csv)$/u;

function pagePath(name) {
  if (!PAGE_NAME.test(name) || name.startsWith('.')) {
    throw httpError(400, 'Ungültiger Seitenname. Erlaubt: Buchstaben, Ziffern, Leerzeichen, Endung .md oder .csv');
  }
  return path.join(CONTEXT_DIR, name);
}

export function listPages() {
  return fs
    .readdirSync(CONTEXT_DIR)
    .filter((name) => PAGE_NAME.test(name) && !name.startsWith('.'))
    .map((name) => ({ name, mtime: fs.statSync(path.join(CONTEXT_DIR, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

export function readPage(name) {
  const file = pagePath(name);
  if (!fs.existsSync(file)) throw httpError(404, `Seite „${name}“ gibt es nicht`);
  return fs.readFileSync(file, 'utf8');
}

export function writePage(name, content) {
  fs.writeFileSync(pagePath(name), String(content ?? ''));
}

let timer = null;
fs.watch(CONTEXT_DIR, () => {
  clearTimeout(timer);
  timer = setTimeout(() => broadcast('pages', listPages()), 300);
});
