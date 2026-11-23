// Almacenamiento en IndexedDB.
// Los artículos se guardan en BLOQUES de ~64 comprimidos juntos (mucho más rápido y compacto
// que uno a uno). La tabla "titles" apunta a cada artículo: { key, title, norm, c: bloque, i: posición }.
const DB_NAME = 'dariopedia';
const CHUNK = 64;
let dbp;

export function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 2);
    r.onupgradeneeded = e => {
      const db = r.result, tx = r.transaction;
      if (e.oldVersion > 0 && e.oldVersion < 2) { // formato antiguo: se rehace (el paquete se vuelve a bajar)
        ['articles', 'titles'].forEach(n => db.objectStoreNames.contains(n) && db.deleteObjectStore(n));
        tx.objectStore('kv').delete('pack');
      }
      if (!db.objectStoreNames.contains('articles')) db.createObjectStore('articles', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('titles')) db.createObjectStore('titles', { keyPath: 'key' }).createIndex('norm', 'norm');
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = tx => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = tx.onabort = () => rej(tx.error); });

export const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/_/g, ' ').trim();
export const keyOf = (lang, title) => `${lang}:${title.replace(/_/g, ' ')}`;

const canGzip = typeof CompressionStream !== 'undefined';
async function pack(str) {
  if (!canGzip) return str;
  return new Response(new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
}
async function unpack(v) {
  if (typeof v === 'string') return v;
  return new Response(v.stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

let renderer = null;
/** Los artículos del paquete son texto plano; se convierten a HTML al abrirlos. */
export const setRenderer = fn => { renderer = fn; };

let seq = 0;
const newId = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Guarda artículos: [{lang, title, text | html}]. Sirve para lotes grandes. */
export async function putArticles(list, prefix = 'p') {
  const chunks = [];
  for (let i = 0; i < list.length; i += CHUNK) {
    const part = list.slice(i, i + CHUNK);
    const id = prefix + newId();
    const bodies = part.map(a => (a.text != null ? [a.text, 1] : [a.html, 0]));
    chunks.push({ id, data: await pack(JSON.stringify(bodies)), part });
  }
  const db = await openDB();
  const tx = db.transaction(['articles', 'titles'], 'readwrite');
  const A = tx.objectStore('articles'), T = tx.objectStore('titles');
  for (const c of chunks) {
    A.put({ id: c.id, data: c.data });
    c.part.forEach((a, i) => T.put({ key: keyOf(a.lang, a.title), lang: a.lang, title: a.title.replace(/_/g, ' '), norm: norm(a.title), c: c.id, i }));
  }
  return done(tx);
}
export const putArticle = a => putArticles([a], 'u');

/** Redirecciones: [{lang, title, to}] — "Gato" → "Felis silvestris catus". Solo ocupan una entrada en "titles". */
export async function putAliases(list) {
  const db = await openDB();
  const tx = db.transaction('titles', 'readwrite'), T = tx.objectStore('titles');
  for (const a of list) T.put({ key: keyOf(a.lang, a.title), lang: a.lang, title: a.title.replace(/_/g, ' '), norm: norm(a.title), r: a.to.replace(/_/g, ' ') });
  return done(tx);
}

/** Título real de un artículo (resuelve alias). null si no está guardado. */
export async function resolveTitle(lang, title) {
  const db = await openDB();
  let t = await req(db.transaction('titles').objectStore('titles').get(keyOf(lang, title)));
  for (let i = 0; t && t.r && i < 3; i++) t = await req(db.transaction('titles').objectStore('titles').get(keyOf(lang, t.r)));
  return t && !t.r ? t.title : null;
}

const cache = { id: null, items: null };
export async function getArticle(lang, title) {
  const db = await openDB();
  let t = await req(db.transaction('titles').objectStore('titles').get(keyOf(lang, title)));
  for (let i = 0; t && t.r && i < 3; i++) t = await req(db.transaction('titles').objectStore('titles').get(keyOf(lang, t.r)));
  if (!t || t.r) return null;
  if (cache.id !== t.c) {
    const rec = await req(db.transaction('articles').objectStore('articles').get(t.c));
    if (!rec) return null;
    cache.items = JSON.parse(await unpack(rec.data)); cache.id = t.c;
  }
  const [body, isText] = cache.items[t.i];
  return isText && renderer ? renderer(body) : body;
}

export async function hasArticle(lang, title) {
  const db = await openDB();
  return !!(await req(db.transaction('titles').objectStore('titles').getKey(keyOf(lang, title))));
}

export async function deleteArticle(lang, title) {
  const db = await openDB();
  const tx = db.transaction(['articles', 'titles'], 'readwrite');
  const k = keyOf(lang, title);
  const t = await req(tx.objectStore('titles').get(k));
  tx.objectStore('titles').delete(k);
  if (t && t.c.startsWith('u')) tx.objectStore('articles').delete(t.c); // solo los guardados uno a uno
  cache.id = null;
  return done(tx);
}

export async function countArticles() {
  const db = await openDB();
  return req(db.transaction('titles').objectStore('titles').count());
}

/** Puntuación: menor = más relevante (coincidencia exacta, sin paréntesis, título corto). */
function score(v, n) {
  if (v.norm === n) return 0;
  let s = 100 + (v.norm.length - n.length);
  if (v.norm.includes('(')) s += 300;           // "Gato (danza)" detrás de "Gato"
  if (v.norm.startsWith(n + ' ')) s -= 40;       // palabra completa antes que prefijo parcial
  if (!v.r) s -= 5;                              // el artículo real, antes que un alias
  return s;
}

/** Búsqueda sin conexión: exacta, por prefijo (índice) y, si faltan, coincidencia parcial; ordenada por relevancia. */
export async function searchLocal(q, lang, limit = 30) {
  const n = norm(q); if (!n) return [];
  const db = await openDB();
  const out = new Map();
  const exact = await req(db.transaction('titles').objectStore('titles').get(keyOf(lang, q.trim())));
  if (exact) out.set(exact.key, exact);
  await new Promise(res => {
    const c = db.transaction('titles').objectStore('titles').index('norm').openCursor(IDBKeyRange.bound(n, n + '\uffff'));
    c.onsuccess = () => { const cur = c.result; if (!cur || out.size >= 4000) return res();
      if (cur.value.lang === lang) out.set(cur.value.key, cur.value); cur.continue(); };
    c.onerror = res;
  });
  if (out.size < limit && n.length >= 3) {
    let scanned = 0;
    await new Promise(res => {
      const c = db.transaction('titles').objectStore('titles').index('norm').openCursor();
      c.onsuccess = () => { const cur = c.result; if (!cur || out.size >= limit * 3 || ++scanned > 300000) return res();
        const v = cur.value; if (v.lang === lang && v.norm.includes(n)) out.set(v.key, v); cur.continue(); };
      c.onerror = res;
    });
  }
  return [...out.values()].sort((x, y) => score(x, n) - score(y, n) || x.norm.localeCompare(y.norm)).slice(0, limit);
}

/** Artículos abiertos o guardados a mano (los últimos). Lista pequeña en kv. */
export async function recentArticles(limit = 15) { return ((await kvGet('recent')) || []).slice(0, limit); }
export async function touchRecent(lang, title) {
  const t = title.replace(/_/g, ' ');
  const list = ((await kvGet('recent')) || []).filter(r => !(r.lang === lang && r.title === t));
  list.unshift({ lang, title: t }); await kvSet('recent', list.slice(0, 50));
}

export async function randomLocal(lang) {
  const db = await openDB();
  const store = db.transaction('titles').objectStore('titles');
  const n = await req(store.count()); if (!n) return null;
  const skip = Math.floor(Math.random() * n);
  return new Promise(res => {
    const c = store.openCursor(); let first = true;
    c.onsuccess = () => { const cur = c.result; if (!cur) return res(null);
      if (first && skip) { first = false; return cur.advance(skip); }
      res(cur.value); };
    c.onerror = () => res(null);
  });
}

export async function clearAll() {
  const db = await openDB();
  const tx = db.transaction(['articles', 'titles', 'kv'], 'readwrite');
  tx.objectStore('articles').clear(); tx.objectStore('titles').clear(); tx.objectStore('kv').delete('pack'); tx.objectStore('kv').delete('recent');
  cache.id = null;
  return done(tx);
}

export async function kvGet(k) { const db = await openDB(); const r = await req(db.transaction('kv').objectStore('kv').get(k)); return r?.v; }
export async function kvSet(k, v) { const db = await openDB(); const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ k, v }); return done(tx); }

export async function audioGet(key) { const db = await openDB(); const r = await req(db.transaction('audio').objectStore('audio').get(key)); return r?.blob; }
export async function audioPut(key, blob) { const db = await openDB(); const tx = db.transaction('audio', 'readwrite'); tx.objectStore('audio').put({ key, blob }); return done(tx); }
export async function audioClear() { const db = await openDB(); const tx = db.transaction('audio', 'readwrite'); tx.objectStore('audio').clear(); return done(tx); }
