// IndexedDB storage for Dariopedia. Articles are stored gzip-compressed when supported.
const DB_NAME = 'dariopedia';
let dbp;

export function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('articles', { keyPath: 'key' });
      const t = db.createObjectStore('titles', { keyPath: 'key' });
      t.createIndex('norm', 'norm');
      t.createIndex('savedAt', 'savedAt');
      db.createObjectStore('audio', { keyPath: 'key' });
      db.createObjectStore('kv', { keyPath: 'k' });
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

/** Save many articles in one transaction: [{lang, title, html}] */
export async function putArticles(list, group = 4) {
  // Comprimimos en grupos pequeños: cientos de streams a la vez agotan la memoria del iPhone.
  const packed = [];
  for (let i = 0; i < list.length; i += group)
    packed.push(...await Promise.all(list.slice(i, i + group).map(async a => {
      const body = a.text ?? a.html;
      return { ...a, data: await pack(body), size: body.length, t: a.text != null ? 1 : 0 };
    })));
  const db = await openDB();
  const tx = db.transaction(['articles', 'titles'], 'readwrite');
  const now = Date.now();
  for (const a of packed) {
    const key = keyOf(a.lang, a.title);
    tx.objectStore('articles').put({ key, data: a.data, t: a.t });
    tx.objectStore('titles').put({ key, lang: a.lang, title: a.title.replace(/_/g, ' '), norm: norm(a.title), size: a.size, savedAt: now });
  }
  return done(tx);
}
export const putArticle = a => putArticles([a]);

export async function getArticle(lang, title) {
  const db = await openDB();
  const rec = await req(db.transaction('articles').objectStore('articles').get(keyOf(lang, title)));
  if (!rec) return null;
  const body = await unpack(rec.data);
  return rec.t && renderer ? renderer(body) : body;
}
let renderer = null;
/** Los artículos del paquete se guardan como texto plano; se convierten a HTML al abrirlos. */
export const setRenderer = fn => { renderer = fn; };

export async function hasArticle(lang, title) {
  const db = await openDB();
  return !!(await req(db.transaction('titles').objectStore('titles').getKey(keyOf(lang, title))));
}

export async function deleteArticle(lang, title) {
  const db = await openDB();
  const tx = db.transaction(['articles', 'titles'], 'readwrite');
  const k = keyOf(lang, title);
  tx.objectStore('articles').delete(k); tx.objectStore('titles').delete(k);
  return done(tx);
}

export async function countArticles() {
  const db = await openDB();
  return req(db.transaction('titles').objectStore('titles').count());
}

/** Offline title search: prefix via index, then substring scan (bounded). */
export async function searchLocal(q, lang, limit = 30) {
  const n = norm(q); if (!n) return [];
  const db = await openDB();
  const idx = db.transaction('titles').objectStore('titles').index('norm');
  const out = new Map();
  await new Promise(res => {
    const c = idx.openCursor(IDBKeyRange.bound(n, n + '￿'));
    c.onsuccess = () => { const cur = c.result; if (!cur || out.size >= limit) return res();
      if (cur.value.lang === lang) out.set(cur.value.key, cur.value); cur.continue(); };
    c.onerror = res;
  });
  if (out.size < limit) {
    let scanned = 0;
    await new Promise(res => {
      const c = db.transaction('titles').objectStore('titles').openCursor();
      c.onsuccess = () => { const cur = c.result; if (!cur || out.size >= limit || ++scanned > 400000) return res();
        const v = cur.value; if (v.lang === lang && v.norm.includes(n)) out.set(v.key, v); cur.continue(); };
      c.onerror = res;
    });
  }
  return [...out.values()];
}

export async function recentArticles(limit = 50) {
  const db = await openDB();
  const out = [];
  await new Promise(res => {
    const c = db.transaction('titles').objectStore('titles').index('savedAt').openCursor(null, 'prev');
    c.onsuccess = () => { const cur = c.result; if (!cur || out.length >= limit) return res(); out.push(cur.value); cur.continue(); };
    c.onerror = res;
  });
  return out;
}

export async function randomLocal(lang) {
  const db = await openDB();
  const store = db.transaction('titles').objectStore('titles');
  const n = await req(store.count()); if (!n) return null;
  let skip = Math.floor(Math.random() * n);
  return new Promise(res => {
    const c = store.openCursor(); let first = true;
    c.onsuccess = () => { const cur = c.result; if (!cur) return res(null);
      if (first && skip) { first = false; return cur.advance(skip); }
      res(cur.value); };
  });
}

export async function* allTitles() {
  const db = await openDB();
  const keys = await req(db.transaction('titles').objectStore('titles').getAll());
  yield* keys;
}

export async function clearAll() {
  const db = await openDB();
  const tx = db.transaction(['articles', 'titles'], 'readwrite');
  tx.objectStore('articles').clear(); tx.objectStore('titles').clear();
  return done(tx);
}

export async function kvGet(k) { const db = await openDB(); const r = await req(db.transaction('kv').objectStore('kv').get(k)); return r?.v; }
export async function kvSet(k, v) { const db = await openDB(); const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ k, v }); return done(tx); }

export async function audioGet(key) { const db = await openDB(); const r = await req(db.transaction('audio').objectStore('audio').get(key)); return r?.blob; }
export async function audioPut(key, blob) { const db = await openDB(); const tx = db.transaction('audio', 'readwrite'); tx.objectStore('audio').put({ key, blob }); return done(tx); }
export async function audioClear() { const db = await openDB(); const tx = db.transaction('audio', 'readwrite'); tx.objectStore('audio').clear(); return done(tx); }
