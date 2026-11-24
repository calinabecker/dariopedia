// Enciclopedia sin conexión: bloques ordenados guardados en Cache Storage.
//
//  datos/indice.json  → lista de bloques [primeraClave, archivo, nº entradas, bytes, hash]
//  datos/bNNNN.gz     → gzip de líneas JSON  ["Título","texto"]  |  ["Alias",0,"Título real"]
//
// Instalar = descargar archivos sueltos (en paralelo, con reintentos y comprobación de tamaño).
// Leer = búsqueda binaria en el índice + abrir UN bloque. Nada de bases de datos.
export const CACHE = 'dariopedia-datos-v1';
const BASE = new URL('datos/', location.href).href;

export const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/_/g, ' ').trim();

let indice = null;          // contenido de indice.json
const bloques = new Map();  // LRU de bloques ya descomprimidos
const clave = b => `${BASE}${b[1]}?h=${b[4]}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
function conTiempo(ms) {
  if (AbortSignal.timeout) return { signal: AbortSignal.timeout(ms), fin() {} };
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, fin: () => clearTimeout(t) };
}

async function bajar(url, esperado, intentos = 5) {
  let ultimo;
  for (let i = 0; i < intentos; i++) {
    const t = conTiempo(45000);
    try {
      const r = await fetch(url, { cache: 'no-store', signal: t.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = await r.arrayBuffer();
      if (esperado && buf.byteLength !== esperado) throw new Error('archivo incompleto');
      t.fin();
      return buf;
    } catch (e) { t.fin(); ultimo = e; await sleep(800 * 2 ** i + Math.random() * 400); }
  }
  throw ultimo;
}

/** Índice instalado (null si no hay datos). */
export async function cargarIndice() {
  if (indice) return indice;
  try {
    const c = await caches.open(CACHE);
    const r = await c.match(BASE + 'indice.json');
    if (r) indice = await r.json();
  } catch {}
  return indice;
}

/** Cuántos bloques están completos en el dispositivo. */
export async function estado() {
  const idx = await cargarIndice();
  if (!idx) return { instalado: false, hechos: 0, total: 0, idx: null };
  const c = await caches.open(CACHE);
  const claves = new Set((await c.keys()).map(r => r.url));
  const hechos = idx.bloques.filter(b => claves.has(clave(b))).length;
  return { instalado: hechos === idx.bloques.length, hechos, total: idx.bloques.length, idx };
}

export async function manifiesto() {
  const r = await fetch(BASE + 'indice.json', { cache: 'no-store' });
  if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) return null;
  return r.json();
}

/**
 * Descarga lo que falte. Reanudable: lo ya guardado no se vuelve a pedir.
 * cb({hechos,total,bytes,totalBytes,velocidad}) · ctl.parar = true para pausar.
 */
export async function instalar(cb, ctl = {}) {
  const nuevo = await manifiesto();
  if (!nuevo) throw new Error('SIN_DATOS');
  const c = await caches.open(CACHE);
  const url = b => clave(b);
  // Bloques antiguos de otra versión: fuera.
  const validas = new Set(nuevo.bloques.map(url));
  for (const k of await c.keys()) if (k.url.startsWith(BASE) && !k.url.endsWith('indice.json') && !validas.has(k.url)) await c.delete(k);
  const existentes = new Set((await c.keys()).map(r => r.url));
  const pendientes = nuevo.bloques.filter(b => !existentes.has(url(b)));
  const total = nuevo.bloques.length, totalBytes = nuevo.bloques.reduce((n, b) => n + b[3], 0);
  let hechos = total - pendientes.length, bytes = nuevo.bloques.filter(b => existentes.has(url(b))).reduce((n, b) => n + b[3], 0);
  const t0 = Date.now(), bytes0 = bytes;
  const emit = () => cb?.({ hechos, total, bytes, totalBytes, velocidad: (bytes - bytes0) / Math.max(1, (Date.now() - t0) / 1000) });
  emit();

  const fallidos = [];
  const cola = pendientes.slice();
  async function obrero() {
    while (cola.length && !ctl.parar) {
      const b = cola.shift();
      try {
        const buf = await bajar(BASE + b[1], b[3]);
        await c.put(url(b), new Response(buf, { headers: { 'content-type': 'application/gzip' } }));
        hechos++; bytes += b[3]; emit();
      } catch (e) {
        if (/quota|storage|space/i.test(String(e.message || e.name))) { ctl.parar = true; throw new Error('SIN_ESPACIO'); }
        fallidos.push(b);
      }
    }
  }
  await Promise.all(Array.from({ length: 5 }, obrero));
  // Segunda pasada tranquila para lo que falló por la red.
  for (let pasada = 0; pasada < 3 && fallidos.length && !ctl.parar; pasada++) {
    await sleep(2000 * (pasada + 1));
    cola.push(...fallidos.splice(0));
    await Promise.all(Array.from({ length: 2 }, obrero));
  }
  if (ctl.parar) return { completo: false, pausado: true };
  if (fallidos.length) return { completo: false, faltan: fallidos.length };
  // El índice se guarda al final: si existe, los datos están completos.
  await c.put(BASE + 'indice.json', new Response(JSON.stringify(nuevo), { headers: { 'content-type': 'application/json' } }));
  indice = nuevo; bloques.clear();
  return { completo: true };
}

export async function borrar() { indice = null; bloques.clear(); return caches.delete(CACHE); }

/* ---------------- Lectura ---------------- */
async function leerBloque(i) {
  if (bloques.has(i)) { const v = bloques.get(i); bloques.delete(i); bloques.set(i, v); return v; }
  const c = await caches.open(CACHE);
  const r = await c.match(clave(indice.bloques[i]));
  if (!r) return null;
  const texto = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).text();
  const lineas = texto.split('\n');
  const items = new Array(lineas.length);
  for (let k = 0; k < lineas.length; k++) { const e = JSON.parse(lineas[k]); items[k] = { n: norm(e[0]), t: e[0], x: e[1], r: e[2] }; }
  bloques.set(i, items);
  if (bloques.size > 6) bloques.delete(bloques.keys().next().value);
  return items;
}

/** Primer bloque que puede contener claves >= n. */
function inicio(n) {
  const B = indice.bloques; let lo = 0, hi = B.length - 1, r = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (B[m][0] < n) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}

/** Todas las entradas cuya clave empieza por n (como mucho `max`). */
export async function prefijo(q, max = 3000) {
  if (!await cargarIndice()) return [];
  const n = norm(q); if (!n) return [];
  const out = [];
  for (let i = inicio(n); i < indice.bloques.length; i++) {
    const items = await leerBloque(i); if (!items) continue;
    let pasado = false;
    for (const e of items) {
      if (e.n < n) continue;
      if (!e.n.startsWith(n)) { pasado = true; break; }
      out.push(e); if (out.length >= max) return out;
    }
    if (pasado) break;
  }
  return out;
}

/** Artículo por título (sigue alias). → { title, text, desde } | null */
export async function obtener(titulo, profundidad = 0) {
  if (!await cargarIndice() || profundidad > 3) return null;
  const n = norm(titulo);
  const hallados = (await prefijo(titulo, 400)).filter(e => e.n === n);
  const e = hallados.find(h => h.t === titulo.replace(/_/g, ' ')) || hallados.find(h => h.r == null) || hallados[0];
  if (!e) return null;
  if (e.r != null) { const a = await obtener(e.r, profundidad + 1); return a && { ...a, desde: e.t }; }
  return { title: e.t, text: e.x };
}

export async function existe(titulo) { return !!(await obtener(titulo)); }

export async function aleatorio() {
  if (!await cargarIndice()) return null;
  for (let k = 0; k < 20; k++) {
    const items = await leerBloque(Math.floor(Math.random() * indice.bloques.length));
    const arts = items?.filter(e => e.r == null && e.x && e.x.length > 200);
    if (arts?.length) return arts[Math.floor(Math.random() * arts.length)].t;
  }
  return null;
}

/* ---------------- Búsqueda con relevancia ---------------- */
function puntos(e, n, q) {
  const cap = q.charAt(0).toUpperCase() + q.slice(1).toLowerCase();
  // mayúsculas/minúsculas: tal como se escribió > "Capitalizado" > resto > TODO EN MAYÚSCULAS
  const caso = e.t === q ? 0 : e.t === cap ? 1 : e.t === e.t.toUpperCase() ? 4 : 2;
  const alias = e.r != null ? 3 : 0;               // el artículo real antes que un alias con el mismo nombre
  if (e.n === n) return caso + alias;
  let s = 100 + (e.n.length - n.length);
  if (e.n.includes('(')) s += 300;                  // "Gato (danza)" detrás de "Gato"
  if (e.n.startsWith(n + ' ')) s -= 40;             // palabra completa antes que prefijo parcial
  return s + alias;
}

/** Resultados ordenados: coincidencia exacta, títulos cortos y sin paréntesis primero. */
export async function buscar(q, limite = 30) {
  const n = norm(q);
  const cand = await prefijo(q, 4000);
  const qt = q.trim();
  cand.sort((a, b) => puntos(a, n, qt) - puntos(b, n, qt) || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
  return cand.slice(0, limite).map(e => ({ title: e.t, r: e.r ?? null }));
}
