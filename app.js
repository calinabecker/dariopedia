import * as db from './db.js';
import * as voice from './voice.js';

const $ = s => document.querySelector(s);
const view = $('#view');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const prefs = { lang: 'es', saveImages: true, autoSave: true };
try { Object.assign(prefs, JSON.parse(localStorage.getItem('prefs') || '{}')); } catch {}
const savePrefs = () => { try { localStorage.setItem('prefs', JSON.stringify(prefs)); } catch {} };

function toast(msg, ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms);
}
const fmtBytes = b => b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB';
const articleHref = (lang, title) => `#/a/${lang}/${encodeURIComponent(title.replace(/ /g, '_'))}`;

/* ---------------- Wikipedia access ---------------- */
async function api(lang, params, tries = 4) {
  const u = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  Object.entries({ format: 'json', formatversion: 2, origin: '*', maxlag: 5, ...params }).forEach(([k, v]) => u.searchParams.set(k, v));
  for (let i = 0; ; i++) {
    const r = await fetch(u);
    if (r.ok) { const j = await r.json(); if (j.error?.code !== 'maxlag' || i >= tries) return j; }
    else if (!(r.status === 429 || r.status >= 500) || i >= tries) throw new Error(r.status === 429 ? 'Wikipedia está limitando las solicitudes (429), probá en un rato' : 'HTTP ' + r.status);
    const wait = (+r.headers.get('retry-after') || 2 ** i) * 1000;
    await new Promise(res => setTimeout(res, Math.min(wait, 30000)));
  }
}

async function fetchArticle(lang, title) {
  const j = await api(lang, { action: 'parse', page: title, prop: 'text', redirects: 1, disableeditsection: 1, disablelimitreport: 1, disabletoc: 1 });
  if (j.error) throw new Error(j.error.info || 'No encontrado');
  return { lang, title: j.parse.title, html: cleanHTML(j.parse.text, lang) };
}

/** Strip Wikipedia HTML down to what we need; normalise links and images. */
function cleanHTML(html, lang = prefs.lang) {
  const doc = new DOMParser().parseFromString(`<div id="r">${html}</div>`, 'text/html');
  const root = doc.getElementById('r');
  root.querySelectorAll('script,style,link,meta,.mw-editsection,.noprint,.mw-empty-elt,.navbox,.navbox-styles,.sistersitebox,.mbox-small,.ambox,.portal,.mw-jump-link,.catlinks,.printfooter,.mw-authority-control,.hatnote.navigation-not-searchable')
    .forEach(n => n.remove());
  root.querySelectorAll('*').forEach(el => {
    for (const a of [...el.attributes])
      if (a.name === 'style' || a.name === 'about' || a.name.startsWith('on') || a.name.startsWith('data-mw')) el.removeAttribute(a.name);
  });
  const base = `https://${lang}.wikipedia.org`;
  const NS = /^(Archivo|File|Imagen|Image|Categoría|Category|Wikipedia|Plantilla|Template|Ayuda|Help|Especial|Special|Usuario|Usuaria|User|Portal|Discusión|Talk|Módulo|Module|MediaWiki|Wikiproyecto|Anexo discusión)( discusión| talk)?:/i;
  root.querySelectorAll('a[href]').forEach(a => {
    const h = a.getAttribute('href');
    const m = h.match(/^(?:\/wiki\/|\.\/)([^#?]+)(#.*)?$/);
    let t = null;
    if (m) { try { t = decodeURIComponent(m[1]).replace(/_/g, ' '); } catch { t = m[1]; } }
    if (t && !NS.test(t)) { a.setAttribute('data-wt', t); a.setAttribute('href', '#'); }
    else if (!h.startsWith('#')) {
      a.setAttribute('href', h.startsWith('//') ? 'https:' + h : h.startsWith('/') ? base + h : h.startsWith('./') ? base + '/wiki/' + h.slice(2) : h);
      a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener');
    }
  });
  root.querySelectorAll('img').forEach(img => {
    let s = img.getAttribute('src') || '';
    if (s.startsWith('//')) s = 'https:' + s;
    if (s.startsWith('/')) s = `https://${lang}.wikipedia.org` + s;
    img.setAttribute('src', s);
    img.removeAttribute('srcset'); img.setAttribute('loading', 'lazy');
    ['resource', 'data-file-width', 'data-file-height'].forEach(a => img.removeAttribute(a));
  });
  return root.innerHTML.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{2,}/g, '\n');
}

async function cacheImages(html) {
  if (!prefs.saveImages || !navigator.onLine) return;
  const srcs = [...html.matchAll(/<img[^>]+src="(https:\/\/upload\.wikimedia\.org[^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&'));
  const c = await caches.open('dariopedia-img');
  await Promise.all(srcs.slice(0, 40).map(async s => {
    if (await c.match(s)) return;
    try { const r = await fetch(s, { mode: 'no-cors' }); await c.put(s, r); } catch {}
  }));
}

/* ---------------- Views ---------------- */
async function home() {
  const [n, recent] = await Promise.all([db.countArticles(), db.recentArticles(15)]);
  const est = await navigator.storage?.estimate?.().catch(() => null);
  view.innerHTML = `
    <section class="hero">
      <h1>Dariopedia</h1>
      <p>La enciclopedia libre, en tu bolsillo y sin conexión.</p>
      <div class="stats">
        <div><b>${n.toLocaleString('es')}</b>artículos guardados</div>
        ${est ? `<div><b>${fmtBytes(est.usage || 0)}</b>usados de ${fmtBytes(est.quota || 0)}</div>` : ''}
      </div>
      <div class="row" style="justify-content:center;margin-top:18px">
        <button class="btn" id="rnd">🎲 Artículo al azar</button>
        <a class="btn primary" href="#/descargas">⬇︎ Descargar artículos</a>
      </div>
    </section>
    <section class="card"><h2 style="margin-top:0">Guardados recientemente</h2>
      ${recent.length ? `<ul class="list">${recent.map(r => `<li><a href="${articleHref(r.lang, r.title)}">${esc(r.title)}</a><span class="badge">${r.lang}</span></li>`).join('')}</ul>`
        : `<p class="empty">Todavía no hay artículos offline. Buscá algo o andá a <a href="#/descargas">Descargas</a>.</p>`}
    </section>`;
  $('#rnd').onclick = async () => {
    if (navigator.onLine) {
      try { const j = await api(prefs.lang, { action: 'query', list: 'random', rnnamespace: 0, rnlimit: 1 }); return go(articleHref(prefs.lang, j.query.random[0].title)); } catch {}
    }
    const r = await db.randomLocal(prefs.lang);
    r ? go(articleHref(r.lang, r.title)) : toast('No hay artículos guardados todavía.');
  };
}

async function search(q) {
  $('#q').value = q;
  view.innerHTML = `<h2>Resultados para “${esc(q)}”</h2><div id="loc" class="card"><p class="hint">Buscando en tus artículos…</p></div><div id="onl"></div>`;
  const local = await db.searchLocal(q, prefs.lang);
  const exact = local.find(r => db.norm(r.title) === db.norm(q));
  $('#loc').innerHTML = `<h3 style="margin-top:0">Sin conexión (${local.length})</h3>` + (local.length
    ? `<ul class="list">${local.map(r => `<li><a href="${articleHref(r.lang, r.title)}">${esc(r.title)}</a><span class="badge ok">offline</span></li>`).join('')}</ul>`
    : '<p class="hint">Nada guardado con ese título.</p>');
  if (!navigator.onLine) return;
  $('#onl').innerHTML = '<div class="card"><p class="hint">Buscando en Wikipedia…</p></div>';
  try {
    const j = await api(prefs.lang, { action: 'query', list: 'search', srsearch: q, srlimit: 20, srprop: 'snippet' });
    const hits = j.query.search;
    const have = await Promise.all(hits.map(h => db.hasArticle(prefs.lang, h.title)));
    $('#onl').innerHTML = `<div class="card"><h3 style="margin-top:0">En Wikipedia (${hits.length})</h3><ul class="list">${hits.map((h, i) =>
      `<li><a href="${articleHref(prefs.lang, h.title)}">${esc(h.title)}</a>${have[i] ? '<span class="badge ok">offline</span>' : ''}<small>${h.snippet.replace(/<(?!\/?span)[^>]+>/g, '')}…</small></li>`).join('')}</ul></div>`;
    if (!exact && hits[0] && db.norm(hits[0].title) === db.norm(q)) go(articleHref(prefs.lang, hits[0].title), true);
  } catch (e) { $('#onl').innerHTML = `<div class="card"><p class="hint">No se pudo buscar en Wikipedia: ${esc(e.message)}</p></div>`; }
}

async function article(lang, title) {
  view.innerHTML = '<p class="empty">Cargando…</p>';
  let html = await db.getArticle(lang, title), saved = !!html, shownTitle = title;
  if (!html) {
    if (!navigator.onLine) {
      view.innerHTML = `<div class="card"><h2>${esc(title)}</h2><p>Este artículo no está guardado y no hay conexión.</p>
        <p><a href="#/s/${encodeURIComponent(title)}">Buscar títulos parecidos offline</a></p></div>`;
      return;
    }
    try {
      const a = await fetchArticle(lang, title);
      html = a.html; shownTitle = a.title;
      if (a.title !== title.replace(/_/g, ' ')) history.replaceState(null, '', articleHref(lang, a.title));
      if (prefs.autoSave) { await db.putArticle(a); saved = true; cacheImages(html); }
    } catch (e) {
      view.innerHTML = `<div class="card"><h2>${esc(title)}</h2><p>No se pudo cargar: ${esc(e.message)}</p></div>`; return;
    }
  }
  document.title = `${shownTitle} — Dariopedia`;
  view.innerHTML = `
    <article class="article">
      <h1 class="title">${esc(shownTitle)}</h1>
      <div class="toolbar">
        <button class="btn" id="readAll">🔊 Leer artículo</button>
        <button class="btn" id="saveBtn">${saved ? '✓ Guardado offline' : '⬇︎ Guardar offline'}</button>
        ${saved ? '<button class="btn danger" id="delBtn">Eliminar</button>' : ''}
        <a class="btn" href="https://${lang}.wikipedia.org/wiki/${encodeURIComponent(shownTitle.replace(/ /g, '_'))}" target="_blank" rel="noopener">Ver original ↗</a>
      </div>
      <div id="body">${html}</div>
      <p class="hint" style="margin-top:30px">Contenido de Wikipedia, bajo licencia CC BY-SA 4.0.</p>
    </article>`;
  $('#saveBtn').onclick = async () => {
    if (saved) return;
    await db.putArticle({ lang, title: shownTitle, html }); cacheImages(html);
    toast('Guardado para leer sin conexión'); article(lang, shownTitle);
  };
  $('#delBtn') && ($('#delBtn').onclick = async () => { await db.deleteArticle(lang, shownTitle); toast('Eliminado'); article(lang, shownTitle); });
  $('#readAll').onclick = () => readText(articleText($('#body')), lang);
}

function articleText(el) {
  const c = el.cloneNode(true);
  c.querySelectorAll('table,sup,.reference,.reflist,.references,figure,.thumb,style,.mw-references-wrap').forEach(n => n.remove());
  return c.innerText;
}

/* ---------------- Bulk downloads ---------------- */
let job = null;

function downloads() {
  view.innerHTML = `
    <h2>Descargar Wikipedia para usar sin conexión</h2>
    <div class="card">
      <label for="src">¿Qué querés descargar?</label>
      <select id="src">
        <option value="featured">Artículos destacados (la mejor selección)</option>
        <option value="category">Una categoría completa</option>
        <option value="random">Artículos al azar</option>
        <option value="list">Lista de títulos</option>
        <option value="all">TODA la Wikipedia (muy lento, se puede pausar y reanudar)</option>
      </select>
      <div id="opt"></div>
      <label for="max">Máximo de artículos en esta tanda</label>
      <input id="max" type="number" min="1" value="500">
      <div class="row" style="margin-top:14px">
        <button class="btn primary" id="startDl">Empezar descarga</button>
        <button class="btn" id="stopDl" disabled>Pausar</button>
      </div>
      <div id="prog" style="margin-top:14px" hidden><progress id="bar" max="100" value="0"></progress><p class="hint" id="progTxt"></p></div>
    </div>
    <div class="card">
      <h3 style="margin-top:0">Importar un volcado completo (recomendado para “todo”)</h3>
      <p class="hint">Para tener <b>toda</b> la Wikipedia, lo más rápido es bajar el volcado oficial HTML de Wikimedia
      (<a href="https://dumps.wikimedia.org/other/enterprise_html/runs/" target="_blank" rel="noopener">dumps.wikimedia.org → enterprise_html</a>,
      archivo <code>${prefs.lang}wiki-NS0-…-ENTERPRISE-HTML.json.tar.gz</code>) e importarlo acá. También acepta paquetes exportados desde Dariopedia (.ndjson / .ndjson.gz).</p>
      <input type="file" id="imp" accept=".json,.ndjson,.gz,.tgz,application/gzip,application/json">
      <div id="impProg" hidden style="margin-top:10px"><progress id="impBar" max="100" value="0"></progress><p class="hint" id="impTxt"></p>
      <button class="btn" id="impStop">Detener importación</button></div>
    </div>`;
  const opt = $('#opt');
  const renderOpt = () => {
    const v = $('#src').value;
    opt.innerHTML = v === 'category' ? `<label for="cat">Nombre de la categoría</label><input id="cat" type="text" placeholder="Ej: Argentina, Física, Mamíferos">
        <label><input type="checkbox" id="sub" checked style="width:auto"> Incluir subcategorías (1 nivel)</label>`
      : v === 'list' ? `<label for="titles">Un título por línea</label><textarea id="titles" rows="6"></textarea>`
      : v === 'all' ? `<p class="hint">Recorre todos los artículos en orden alfabético y recuerda dónde quedó. La Wikipedia en español tiene ~2 millones de artículos; a esta velocidad son semanas. Para todo, usá mejor la importación del volcado de abajo.</p>`
      : '';
  };
  $('#src').onchange = renderOpt; renderOpt();
  $('#startDl').onclick = startDownload;
  $('#stopDl').onclick = () => { if (job) job.stop = true; };
  if (job) showJob();
  $('#imp').onchange = e => e.target.files[0] && importFile(e.target.files[0]);
  $('#impStop').onclick = () => { if (importJob) importJob.stop = true; };
}

async function* titleSource(src, lang) {
  if (src === 'list') { for (const t of $('#titles').value.split('\n').map(s => s.trim()).filter(Boolean)) yield t; return; }
  if (src === 'random') { while (true) { const j = await api(lang, { action: 'query', list: 'random', rnnamespace: 0, rnlimit: 100 }); for (const r of j.query.random) yield r.title; } }
  if (src === 'all') {
    let cont = (await db.kvGet('allpages:' + lang)) || '';
    while (true) {
      const j = await api(lang, { action: 'query', list: 'allpages', apnamespace: 0, apfilterredir: 'nonredirects', aplimit: 500, ...(cont ? { apcontinue: cont } : {}) });
      for (const p of j.query.allpages) yield p.title;
      if (!j.continue) return;
      cont = j.continue.apcontinue; await db.kvSet('allpages:' + lang, cont);
    }
  }
  let cats;
  if (src === 'featured') cats = [lang === 'es' ? 'Categoría:Wikipedia:Artículos destacados' : lang === 'en' ? 'Category:Featured articles' : 'Category:Featured articles'];
  else {
    const name = $('#cat').value.trim(); if (!name) throw new Error('Escribí una categoría');
    cats = [/:/.test(name) ? name : (lang === 'es' ? 'Categoría:' : 'Category:') + name];
  }
  const withSub = src === 'category' && $('#sub').checked;
  const seen = new Set();
  for (let i = 0; i < cats.length; i++) {
    let cont = {};
    do {
      const j = await api(lang, { action: 'query', list: 'categorymembers', cmtitle: cats[i], cmlimit: 500, cmtype: 'page|subcat', ...cont });
      for (const m of j.query.categorymembers) {
        if (m.ns === 14) { if (withSub && i === 0 && !seen.has(m.title)) { seen.add(m.title); cats.push(m.title); } continue; }
        if (m.ns === 0) yield m.title;
        else if (src === 'featured' && m.ns === 1) yield m.title.replace(/^[^:]+:/, ''); // talk pages tagged as featured
      }
      cont = j.continue || null;
    } while (cont);
  }
}

async function startDownload() {
  if (job) return;
  if (!navigator.onLine) return toast('Necesitás conexión para descargar.');
  navigator.storage?.persist?.();
  const lang = prefs.lang, src = $('#src').value, max = Math.max(1, +$('#max').value || 500);
  job = { done: 0, claimed: 0, skipped: 0, failed: 0, max, stop: false, status: 'Buscando artículos…' };
  showJob();
  const it = titleSource(src, lang);
  let running = true, buf = [];
  const flush = async () => { if (buf.length) { const b = buf; buf = []; await db.putArticles(b); } };
  const next = async () => { if (!running) return null; try { const r = await it.next(); if (r.done) { running = false; return null; } return r.value; } catch (e) { running = false; job.status = 'Error: ' + e.message; return null; } };
  let pulling = Promise.resolve();
  const getTitle = () => (pulling = pulling.then(next));
  const worker = async () => {
    while (!job.stop && job.claimed < max) {
      job.claimed++;
      const t = await getTitle(); if (t == null) return;
      try {
        if (await db.hasArticle(lang, t)) { job.skipped++; job.claimed--; continue; }
        const a = await fetchArticle(lang, t);
        buf.push(a); job.done++;
        if (buf.length >= 10) await flush();
        if (prefs.saveImages) cacheImages(a.html);
      } catch { job.failed++; job.claimed--; }
      job.status = `Descargando… último: ${t}`; showJob();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  await flush();
  job.status = job.stop ? 'Pausado. Podés reanudar cuando quieras.' : (job.status.startsWith('Error') ? job.status : 'Listo ✓');
  showJob(); const j = job; job = null; showJob(j);
}

function showJob(j = job) {
  const bar = $('#bar'); if (!bar || !j) return;
  $('#prog').hidden = false; $('#startDl').disabled = !!job; $('#stopDl').disabled = !job;
  bar.value = Math.min(100, (j.done / j.max) * 100);
  $('#progTxt').textContent = `${j.done} nuevos · ${j.skipped} ya estaban · ${j.failed} fallidos — ${j.status}`;
}

/* ---------------- Import / export ---------------- */
let importJob = null;
async function importFile(file) {
  if (importJob) return;
  navigator.storage?.persist?.();
  importJob = { stop: false };
  $('#impProg').hidden = false;
  let read = 0, count = 0, bad = 0, batch = [];
  const counter = new TransformStream({ transform(ch, ctl) { read += ch.byteLength; ctl.enqueue(ch); } });
  let stream = file.stream().pipeThrough(counter);
  if (/\.(gz|tgz)$/i.test(file.name)) stream = stream.pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let rest = '';
  const handle = line => {
    const i = line.indexOf('{'); if (i < 0) return;
    let o; try { o = JSON.parse(line.slice(i)); } catch { bad++; return; }
    if (o.html && o.title) batch.push({ lang: o.lang || prefs.lang, title: o.title, html: o.html });
    else if (o.article_body?.html && o.name && (o.namespace?.identifier ?? 0) === 0)
      batch.push({ lang: o.in_language?.identifier || prefs.lang, title: o.name, html: cleanHTML(o.article_body.html, o.in_language?.identifier || prefs.lang) });
  };
  try {
    while (!importJob.stop) {
      const { value, done } = await reader.read();
      if (done) break;
      const lines = (rest + value).split('\n'); rest = lines.pop();
      for (const l of lines) handle(l);
      if (batch.length >= 100) { count += batch.length; await db.putArticles(batch); batch = [];
        $('#impBar').value = (read / file.size) * 100;
        $('#impTxt').textContent = `${count.toLocaleString('es')} artículos importados · ${fmtBytes(read)} de ${fmtBytes(file.size)}`; }
    }
    if (!importJob.stop) handle(rest);
    if (batch.length) { count += batch.length; await db.putArticles(batch); }
    $('#impTxt').textContent = `${importJob.stop ? 'Detenido' : 'Listo ✓'} — ${count.toLocaleString('es')} artículos importados${bad ? ` (${bad} líneas ilegibles)` : ''}.`;
  } catch (e) {
    $('#impTxt').textContent = `Error: ${e.message}. Se importaron ${count} artículos (¿se llenó el almacenamiento?).`;
  } finally { reader.cancel().catch(() => {}); importJob = null; }
}

async function exportAll() {
  const titles = [];
  for await (const t of db.allTitles()) titles.push(t);
  const parts = [];
  for (const t of titles) parts.push(JSON.stringify({ lang: t.lang, title: t.title, html: await db.getArticle(t.lang, t.title) }) + '\n');
  let blob = new Blob(parts, { type: 'application/x-ndjson' }), name = 'dariopedia.ndjson';
  if (typeof CompressionStream !== 'undefined') { blob = await new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob(); name += '.gz'; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/* ---------------- Settings ---------------- */
async function settings() {
  const vs = voice.getSettings();
  const voices = await voice.systemVoices();
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  view.innerHTML = `
    <h2>Ajustes</h2>
    <div class="card">
      <h3 style="margin-top:0">Contenido</h3>
      <label for="lang">Idioma de Wikipedia</label>
      <select id="lang">${[['es', 'Español'], ['en', 'English'], ['pt', 'Português'], ['ca', 'Català'], ['gl', 'Galego'], ['eu', 'Euskara'], ['fr', 'Français'], ['it', 'Italiano'], ['de', 'Deutsch']]
        .map(([c, n]) => `<option value="${c}" ${c === prefs.lang ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <label><input type="checkbox" id="autoSave" ${prefs.autoSave ? 'checked' : ''} style="width:auto"> Guardar automáticamente todo artículo que abro</label>
      <label><input type="checkbox" id="saveImages" ${prefs.saveImages ? 'checked' : ''} style="width:auto"> Guardar también las imágenes (ocupa más espacio)</label>
    </div>
    <div class="card">
      <h3 style="margin-top:0">Voz de lectura</h3>
      <label for="engine">Motor</label>
      <select id="engine">
        <option value="sistema" ${vs.engine === 'sistema' ? 'selected' : ''}>Voz del dispositivo (funciona 100% offline)</option>
        <option value="clonada" ${vs.engine === 'clonada' ? 'selected' : ''} ${vs.voiceId ? '' : 'disabled'}>Voz clonada${vs.voiceName ? `: ${esc(vs.voiceName)}` : ' (creala abajo)'}</option>
      </select>
      <label for="sysVoice">Voz del dispositivo</label>
      <select id="sysVoice">${voices.map(v => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === vs.systemVoice ? 'selected' : ''}>${esc(v.name)} (${v.lang})${v.localService ? ' · offline' : ''}</option>`).join('') || '<option>No hay voces disponibles</option>'}</select>
      <label for="rate">Velocidad: <span id="rateV">${vs.rate}</span>×</label>
      <input id="rate" type="range" min="0.6" max="1.8" step="0.1" value="${vs.rate}" style="width:100%">
      <div class="row" style="margin-top:10px"><button class="btn" id="testVoice">▶ Probar voz</button></div>

      <h4>Clonar una voz desde un audio</h4>
      <p class="hint">Subí una grabación clara de la voz (1–3 minutos, sin música ni ruido). Se crea una copia de esa voz con
      <a href="https://elevenlabs.io" target="_blank" rel="noopener">ElevenLabs</a> (necesitás una cuenta y su clave de API).
      Generar audio nuevo requiere internet; lo que ya se escuchó queda guardado y se reproduce sin conexión.
      <b>Usá solo voces propias o de personas que te dieron permiso.</b></p>
      <label for="apiKey">Clave de API de ElevenLabs</label>
      <input id="apiKey" type="password" value="${esc(vs.apiKey)}" placeholder="sk_…" autocomplete="off">
      <label for="vName">Nombre de la voz</label>
      <input id="vName" type="text" value="${esc(vs.voiceName || 'Darío')}">
      <label for="vFile">Audio de muestra</label>
      <input id="vFile" type="file" accept="audio/*">
      <label for="vId">…o, si ya la tenés creada, el ID de la voz</label>
      <input id="vId" type="text" value="${esc(vs.voiceId)}" placeholder="voice_id">
      <div class="row" style="margin-top:10px">
        <button class="btn primary" id="cloneBtn">Crear / guardar voz</button>
        <button class="btn danger" id="clrAudio">Borrar audios guardados</button>
      </div>
      <p class="hint" id="cloneMsg"></p>
    </div>
    <div class="card">
      <h3 style="margin-top:0">Almacenamiento</h3>
      <p class="hint">${est ? `Usado: ${fmtBytes(est.usage || 0)} de ${fmtBytes(est.quota || 0)} disponibles.` : ''} ${persisted ? 'Almacenamiento persistente activado ✓' : 'El navegador podría borrar datos si falta espacio.'}</p>
      <div class="row">
        <button class="btn" id="persist">Pedir almacenamiento persistente</button>
        <button class="btn" id="exp">Exportar mis artículos</button>
        <button class="btn danger" id="wipe">Borrar todos los artículos</button>
      </div>
    </div>`;
  $('#lang').onchange = e => { prefs.lang = e.target.value; savePrefs(); toast('Idioma cambiado'); };
  $('#autoSave').onchange = e => { prefs.autoSave = e.target.checked; savePrefs(); };
  $('#saveImages').onchange = e => { prefs.saveImages = e.target.checked; savePrefs(); };
  $('#engine').onchange = e => voice.saveSettings({ engine: e.target.value });
  $('#sysVoice').onchange = e => voice.saveSettings({ systemVoice: e.target.value });
  $('#rate').oninput = e => { $('#rateV').textContent = e.target.value; voice.saveSettings({ rate: +e.target.value }); };
  $('#testVoice').onclick = () => readText('Hola, soy la voz de Dariopedia. Puedo leerte cualquier artículo.', prefs.lang);
  $('#cloneBtn').onclick = async () => {
    const apiKey = $('#apiKey').value.trim(), name = $('#vName').value.trim(), file = $('#vFile').files[0], id = $('#vId').value.trim();
    const msg = $('#cloneMsg');
    if (!apiKey) return (msg.textContent = 'Falta la clave de API.');
    try {
      if (file) { msg.textContent = 'Subiendo el audio y creando la voz…'; await voice.cloneVoice(file, name, apiKey); }
      else if (id) await voice.saveSettings({ apiKey, voiceId: id, voiceName: name, engine: 'clonada' });
      else return (msg.textContent = 'Elegí un audio de muestra o pegá un ID de voz.');
      msg.textContent = '¡Voz lista! Ya se usa para leer.'; setTimeout(settings, 1200);
    } catch (e) { msg.textContent = 'Error: ' + e.message; }
  };
  $('#clrAudio').onclick = async () => { await db.audioClear(); toast('Audios borrados'); };
  $('#persist').onclick = async () => { const ok = await navigator.storage?.persist?.(); toast(ok ? 'Almacenamiento persistente activado' : 'El navegador no lo concedió (instalá la app primero)'); settings(); };
  $('#exp').onclick = () => { toast('Preparando exportación…'); exportAll(); };
  $('#wipe').onclick = async () => { if (confirm('¿Borrar todos los artículos guardados?')) { await db.clearAll(); toast('Borrado'); settings(); } };
}

/* ---------------- Reading aloud ---------------- */
function readText(text, lang) {
  voice.speak(text, lang).catch(e => toast(e.message, 6000));
}
voice.onState(s => {
  $('#player').hidden = s === 'idle';
  $('#playerState').textContent = s === 'loading' ? 'Generando voz…' : 'Leyendo…';
});
$('#stopBtn').onclick = () => voice.stop();

const selBtn = $('#selBtn');
document.addEventListener('selectionchange', () => {
  clearTimeout(selBtn.t);
  selBtn.t = setTimeout(() => {
    const sel = getSelection(), text = sel.toString().trim();
    const inArticle = sel.rangeCount && view.contains(sel.getRangeAt(0).commonAncestorContainer);
    if (!text || !inArticle) return (selBtn.hidden = true);
    const r = sel.getRangeAt(0).getBoundingClientRect();
    selBtn.style.top = `${scrollY + r.bottom + 8}px`;
    selBtn.style.left = `${Math.max(8, Math.min(innerWidth - 170, scrollX + r.left))}px`;
    selBtn.hidden = false;
  }, 250);
});
selBtn.addEventListener('pointerdown', e => e.preventDefault());
selBtn.onclick = () => { readText(getSelection().toString(), prefs.lang); selBtn.hidden = true; };

/* ---------------- Router ---------------- */
function go(hash, replace) {
  if (replace) { history.replaceState(null, '', hash); return route(); }
  if (location.hash === hash) return route();
  location.hash = hash; // triggers route() via hashchange
}
async function route() {
  const h = location.hash.slice(1) || '/';
  const [, a, b, c] = h.split('/');
  scrollTo(0, 0); selBtn.hidden = true; document.title = 'Dariopedia';
  if (a === 'a' && b && c) return article(b, decodeURIComponent(c).replace(/_/g, ' '));
  if (a === 's' && b) return search(decodeURIComponent(b));
  if (a === 'descargas') return downloads();
  if (a === 'ajustes') return settings();
  $('#q').value = ''; return home();
}
addEventListener('hashchange', route);
view.addEventListener('click', e => {
  const a = e.target.closest('a[data-wt]'); if (!a) return;
  e.preventDefault(); go(articleHref(prefs.lang, a.dataset.wt));
});
$('#searchForm').onsubmit = e => { e.preventDefault(); const q = $('#q').value.trim(); if (q) go('#/s/' + encodeURIComponent(q)); $('#q').blur(); };

const net = () => ($('#net').hidden = navigator.onLine);
addEventListener('online', net); addEventListener('offline', net); net();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
await voice.loadSettings();
route();
