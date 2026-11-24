import * as db from './db.js';
import * as voice from './voice.js';
import * as datos from './datos.js';

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
    else if (!(r.status === 429 || r.status >= 500) || i >= tries) throw new Error(r.status === 429 ? 'Dariopedia está recibiendo demasiadas solicitudes (429), prueba en un rato' : 'HTTP ' + r.status);
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
  const [idx, recent, est] = await Promise.all([datos.cargarIndice(), db.recentArticles(15), navigator.storage?.estimate?.().catch(() => null)]);
  const e = await datos.estado();
  view.innerHTML = `
    <section class="hero">
      <h1>Dariopedia</h1>
      <p>La enciclopedia, disponible sin conexión.</p>
      <div class="stats">
        <div><b>${e.instalado ? idx.articulos.toLocaleString('es') : '—'}</b>artículos sin conexión</div>
        ${est ? `<div><b>${fmtBytes(est.usage || 0)}</b>ocupa en tu móvil</div>` : ''}
      </div>
      <div class="row" style="justify-content:center;margin-top:18px">
        <button class="btn" id="rnd">🎲 Artículo aleatorio</button>
        ${e.instalado ? '' : '<a class="btn primary" href="#/descargas">⬇︎ Descargar</a>'}
      </div>
    </section>
    <section class="card"><h2 style="margin-top:0">Recientes</h2>
      ${recent.length ? `<ul class="list">${recent.map(r => `<li><a href="${articleHref(r.lang, r.title)}">${esc(r.title)}</a></li>`).join('')}</ul>`
        : `<p class="empty">${e.instalado ? 'Busca algo en la barra de arriba.' : 'Todavía no has descargado la enciclopedia. Ve a <a href="#/descargas">Descargas</a>.'}</p>`}
    </section>`;
  $('#rnd').onclick = async () => {
    const t = await datos.aleatorio();
    if (t) return go(articleHref(prefs.lang, t));
    if (navigator.onLine) { try { const j = await api(prefs.lang, { action: 'query', list: 'random', rnnamespace: 0, rnlimit: 1 }); return go(articleHref(prefs.lang, j.query.random[0].title)); } catch {} }
    toast('Descarga primero la enciclopedia.');
  };
}

async function search(q) {
  $('#q').value = q;
  view.innerHTML = `<h2>Resultados para “${esc(q)}”</h2><div id="loc" class="card"><p class="hint">Buscando…</p></div><div id="onl"></div>`;
  const [pack, mios] = await Promise.all([datos.buscar(q, 30), db.searchLocal(q, prefs.lang, 10)]);
  const vistos = new Set(pack.map(r => datos.norm(r.title)));
  const local = [...pack, ...mios.filter(r => !vistos.has(datos.norm(r.title))).map(r => ({ title: r.title, r: r.r ?? null }))].map(r => ({ ...r, lang: prefs.lang }));
  const exact = local.find(r => datos.norm(r.title) === datos.norm(q));
  $('#loc').innerHTML = `<h3 style="margin-top:0">Sin conexión (${local.length})</h3>` + (local.length
    ? `<ul class="list">${local.map(r => `<li><a href="${articleHref(r.lang, r.title)}">${esc(r.title)}</a>${r.r ? ` <span class="hint">→ ${esc(r.r)}</span>` : ''}<span class="badge ok">sin conexión</span></li>`).join('')}</ul>`
    : '<p class="hint">No hay ningún título que empiece así en tu enciclopedia sin conexión.</p>');
  if (!navigator.onLine) return;
  $('#onl').innerHTML = '<div class="card"><p class="hint">Buscando en línea…</p></div>';
  try {
    const j = await api(prefs.lang, { action: 'query', list: 'search', srsearch: q, srlimit: 20, srprop: 'snippet' });
    const hits = j.query.search;
    const have = await Promise.all(hits.map(async h => (await datos.existe(h.title)) || (await db.hasArticle(prefs.lang, h.title))));
    $('#onl').innerHTML = `<div class="card"><h3 style="margin-top:0">En línea (${hits.length})</h3><ul class="list">${hits.map((h, i) =>
      `<li><a href="${articleHref(prefs.lang, h.title)}">${esc(h.title)}</a>${have[i] ? '<span class="badge ok">sin conexión</span>' : ''}<small>${h.snippet.replace(/<(?!\/?span)[^>]+>/g, '')}…</small></li>`).join('')}</ul></div>`;
    if (!exact && hits[0] && datos.norm(hits[0].title) === datos.norm(q)) go(articleHref(prefs.lang, hits[0].title), true);
  } catch (e) { $('#onl').innerHTML = `<div class="card"><p class="hint">No se ha podido buscar en línea: ${esc(e.message)}</p></div>`; }
}

async function article(lang, title) {
  view.innerHTML = '<p class="empty">Cargando…</p>';
  let html = await db.getArticle(lang, title), saved = !!html, shownTitle = title, resumen = false, desde = null;
  if (html) shownTitle = (await db.resolveTitle(lang, title)) || title;
  if (!html && lang === prefs.lang) {
    const hit = await datos.obtener(title);
    if (hit) { html = textToHtml(hit.text); shownTitle = hit.title; resumen = true; desde = hit.desde; }
  }
  if (!html) {
    if (!navigator.onLine) {
      view.innerHTML = `<div class="card"><h2>${esc(title)}</h2><p>Este artículo no está en tu enciclopedia y no hay conexión.</p>
        <p><a href="#/s/${encodeURIComponent(title)}">Buscar títulos parecidos</a></p></div>`;
      return;
    }
    try {
      const a = await fetchArticle(lang, title);
      html = a.html; shownTitle = a.title;
      if (a.title !== title.replace(/_/g, ' ')) history.replaceState(null, '', articleHref(lang, a.title));
      if (prefs.autoSave) { await db.putArticle(a); saved = true; cacheImages(html); }
    } catch (e) {
      view.innerHTML = `<div class="card"><h2>${esc(title)}</h2><p>No se ha podido cargar: ${esc(e.message)}</p></div>`; return;
    }
  }
  document.title = `${shownTitle} — Dariopedia`; db.touchRecent(lang, shownTitle).catch(() => {});
  view.innerHTML = `
    <article class="article">
      <h1 class="title">${esc(shownTitle)}</h1>
      ${desde ? `<p class="hint" style="margin:-2px 0 8px">(Redirigido desde «${esc(desde)}»)</p>` : ''}
      <div class="toolbar">
        <button class="btn" id="readAll">🔊 Leer</button>
        ${resumen ? '<button class="btn" id="fullBtn">📖 Ver artículo completo</button>' : ''}
        ${saved ? '<button class="btn danger" id="delBtn">Quitar guardado</button>' : ''}
      </div>
      <div id="body">${html}</div>
      ${resumen ? '<p class="hint">Resumen disponible sin conexión. «Ver artículo completo» necesita internet.</p>' : ''}
      <p class="attrib">Contenido disponible bajo la licencia Creative Commons Atribución-CompartirIgual 4.0.</p>
    </article>`;
  $('#fullBtn') && ($('#fullBtn').onclick = async () => {
    if (!navigator.onLine) return toast('Necesitas conexión para ver el artículo completo.');
    const btn = $('#fullBtn'); btn.disabled = true; btn.textContent = 'Cargando…';
    try {
      const a = await fetchArticle(lang, shownTitle);
      await db.putArticle(a); cacheImages(a.html); article(lang, a.title);
    } catch (e) { btn.disabled = false; btn.textContent = '📖 Ver artículo completo'; toast('No se ha podido cargar: ' + e.message); }
  });
  $('#delBtn') && ($('#delBtn').onclick = async () => { await db.deleteArticle(lang, shownTitle); toast('Quitado'); article(lang, shownTitle); });
  $('#readAll').onclick = () => readText(articleText($('#body')), lang);
}

function articleText(el) {
  const c = el.cloneNode(true);
  c.querySelectorAll('table,sup,.reference,.reflist,.references,figure,.thumb,style,.mw-references-wrap').forEach(n => n.remove());
  return c.innerText;
}

/* ---------------- Instalación de la enciclopedia ---------------- */
/** Párrafos y "## Título" del texto plano → HTML. */
function textToHtml(t) {
  return t.split('\n\n').map(p => {
    const m = p.match(/^(#{2,4}) (.*)$/);
    return m ? `<h${m[1].length}>${esc(m[2])}</h${m[1].length}>` : `<p>${esc(p).replace(/\n/g, '<br>')}</p>`;
  }).join('');
}

const inst = { running: false, ctl: null, hechos: 0, total: 0, bytes: 0, totalBytes: 0, vel: 0, completo: false, msg: '', error: '', wake: null };
const dl = $('#dl');
const pct = () => (inst.total ? (inst.hechos / inst.total) * 100 : 0);
function paintInst() {
  const activo = inst.running;
  dl.hidden = !activo && !inst.error;
  const mins = inst.vel > 0 ? Math.max(1, Math.ceil((inst.totalBytes - inst.bytes) / inst.vel / 60)) : null;
  const linea = inst.error || (activo ? `Descargando Dariopedia… ${Math.floor(pct())} %${mins && pct() > 2 ? ` · ~${mins} min` : ''}` : inst.msg);
  $('#dlTxt').textContent = linea; $('#dlBar').value = pct(); $('#dlBar').hidden = !activo;
  const st = $('#pkgState'); if (!st) return;
  st.textContent = linea; $('#pkgBar').value = pct(); $('#pkgBar').hidden = !activo;
  $('#pkgDetail').textContent = activo || inst.hechos
    ? `${inst.hechos.toLocaleString('es')} de ${inst.total.toLocaleString('es')} bloques · ${fmtBytes(inst.bytes)} de ${fmtBytes(inst.totalBytes)}${activo && inst.vel ? ` · ${fmtBytes(inst.vel)}/s` : ''}` : '';
  $('#pkgGo').hidden = activo || inst.completo; $('#pkgStop').hidden = !activo; $('#pkgDel').hidden = activo || !inst.hechos;
}

async function instalarDatos(auto) {
  if (inst.running) return;
  inst.running = true; inst.error = ''; inst.msg = ''; inst.ctl = { parar: false }; paintInst();
  try { inst.wake = await navigator.wakeLock?.request('screen'); } catch {}
  navigator.storage?.persist?.();
  try {
    const r = await datos.instalar(p => { Object.assign(inst, { hechos: p.hechos, total: p.total, bytes: p.bytes, totalBytes: p.totalBytes, vel: p.velocidad }); paintInst(); }, inst.ctl);
    if (r.completo) { inst.completo = true; inst.msg = 'Listo ✓ Dariopedia ya funciona sin conexión.'; await db.kvSet('instalado', Date.now()); }
    else if (r.pausado) inst.msg = 'Descarga en pausa. Pulsa «Continuar» cuando quieras.';
    else inst.error = `No se han podido descargar ${r.faltan} bloques. Comprueba la conexión y pulsa «Continuar»: seguirá donde se quedó.`;
  } catch (e) {
    inst.error = e.message === 'SIN_DATOS' ? 'La enciclopedia todavía no está publicada. Vuelve a intentarlo más tarde.'
      : e.message === 'SIN_ESPACIO' ? 'No hay espacio suficiente en el móvil. Libera espacio y pulsa «Continuar».'
      : 'Se ha interrumpido la descarga (' + e.message + '). Pulsa «Continuar»: seguirá donde se quedó.';
  }
  try { await inst.wake?.release(); } catch {}
  inst.running = false;
  const e = await datos.estado(); Object.assign(inst, { hechos: e.hechos, total: e.total || inst.total, completo: e.instalado });
  paintInst();
  if (/^#\/(descargas)?$/.test(location.hash) || !location.hash) route();
}

/** Al abrir la app: si falta algo o hay versión nueva, se instala solo. */
async function comprobarInstalacion() {
  const e = await datos.estado();
  Object.assign(inst, { hechos: e.hechos, total: e.total, completo: e.instalado });
  if (!navigator.onLine || inst.running) return paintInst();
  let m = null; try { m = await datos.manifiesto(); } catch {}
  if (!m) return paintInst();
  const firma = x => x.bloques.map(b => b[4]).join('');
  if (e.instalado && firma(e.idx) === firma(m)) return paintInst();
  inst.total = m.bloques.length; inst.completo = false;
  if (!/^#\/a\//.test(location.hash)) go('#/descargas');
  instalarDatos(true);
}

function downloads() {
  view.innerHTML = `
    <h2>Descargas</h2>
    <div class="card">
      <h3 style="margin-top:0">Dariopedia sin conexión</h3>
      <p class="hint">Casi 2 millones de artículos (resumen de cada uno) y 2 millones de redirecciones, solo texto y sin imágenes.
      Ocupa unos 320 MB. Se descarga una sola vez y después funciona sin internet. Si se corta, continúa donde se quedó.</p>
      <progress id="pkgBar" max="100" value="0" hidden></progress>
      <p id="pkgState" style="margin:10px 0 2px;font-weight:600"></p>
      <p id="pkgDetail" class="hint" style="margin:0 0 12px"></p>
      <div class="row">
        <button class="btn primary" id="pkgGo">Descargar</button>
        <button class="btn" id="pkgStop" hidden>Pausar</button>
        <button class="btn danger" id="pkgDel" hidden>Borrar descarga</button>
      </div>
    </div>`;
  $('#pkgGo').onclick = () => { if (!navigator.onLine) return toast('Necesitas conexión para descargar.'); instalarDatos(); };
  $('#pkgStop').onclick = () => { if (inst.ctl) inst.ctl.parar = true; };
  $('#pkgDel').onclick = async () => { if (confirm('¿Borrar la enciclopedia descargada? Podrás volver a descargarla.')) { await datos.borrar(); Object.assign(inst, { hechos: 0, completo: false, msg: 'Descarga borrada.' }); downloads(); } };
  datos.estado().then(e => {
    if (!inst.running) { Object.assign(inst, { hechos: e.hechos, total: e.total, completo: e.instalado });
      if (e.instalado) inst.msg = `Todo instalado: ${e.idx.articulos.toLocaleString('es')} artículos y ${e.idx.alias.toLocaleString('es')} redirecciones disponibles sin conexión.`;
      else if (!inst.error && !inst.msg) inst.msg = e.hechos ? 'Descarga a medias. Pulsa «Descargar» para continuar.' : 'Todavía no has descargado la enciclopedia.'; }
    if (e.idx) inst.totalBytes = e.idx.bytes;
    paintInst();
  });
  paintInst();
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
      <label for="lang">Idioma</label>
      <select id="lang">${[['es', 'Español'], ['en', 'English'], ['pt', 'Português'], ['ca', 'Català'], ['gl', 'Galego'], ['eu', 'Euskara'], ['fr', 'Français'], ['it', 'Italiano'], ['de', 'Deutsch']]
        .map(([c, n]) => `<option value="${c}" ${c === prefs.lang ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <label><input type="checkbox" id="autoSave" ${prefs.autoSave ? 'checked' : ''} style="width:auto"> Guardar automáticamente todo artículo que abra</label>
      <label><input type="checkbox" id="saveImages" ${prefs.saveImages ? 'checked' : ''} style="width:auto"> Guardar también las imágenes (ocupa más espacio)</label>
    </div>
    <div class="card">
      <h3 style="margin-top:0">Voz de lectura</h3>
      <label for="engine">Motor</label>
      <select id="engine">
        <option value="sistema" ${vs.engine === 'sistema' ? 'selected' : ''}>Voz del dispositivo (funciona 100 % sin conexión)</option>
        <option value="clonada" ${vs.engine === 'clonada' ? 'selected' : ''} ${vs.voiceId ? '' : 'disabled'}>Voz clonada${vs.voiceName ? `: ${esc(vs.voiceName)}` : ' (créala abajo)'}</option>
      </select>
      <label for="sysVoice">Voz del dispositivo</label>
      <select id="sysVoice">${voices.map(v => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === vs.systemVoice ? 'selected' : ''}>${esc(v.name)} (${v.lang})${v.localService ? ' · sin conexión' : ''}</option>`).join('') || '<option>No hay voces disponibles</option>'}</select>
      <label for="rate">Velocidad: <span id="rateV">${vs.rate}</span>×</label>
      <input id="rate" type="range" min="0.6" max="1.8" step="0.1" value="${vs.rate}" style="width:100%">
      <div class="row" style="margin-top:10px"><button class="btn" id="testVoice">▶ Probar voz</button></div>

      <h4>Clonar una voz desde un audio</h4>
      <p class="hint">Sube una grabación clara de la voz (1–3 minutos, sin música ni ruido). Se crea una copia de esa voz con
      <a href="https://elevenlabs.io" target="_blank" rel="noopener">ElevenLabs</a> (necesitás una cuenta y su clave de API).
      Generar audio nuevo requiere internet; lo que ya se escuchó queda guardado y se reproduce sin conexión.
      <b>Usa solo voces propias o de personas que te dieron permiso.</b></p>
      <label for="apiKey">Clave de API de ElevenLabs</label>
      <input id="apiKey" type="password" value="${esc(vs.apiKey)}" placeholder="sk_…" autocomplete="off">
      <label for="vName">Nombre de la voz</label>
      <input id="vName" type="text" value="${esc(vs.voiceName || 'Dariopedia')}">
      <label for="vFile">Audio de muestra</label>
      <input id="vFile" type="file" accept="audio/*">
      <label for="vId">…o, si ya la tienes creada, el ID de la voz</label>
      <input id="vId" type="text" value="${esc(vs.voiceId)}" placeholder="voice_id">
      <div class="row" style="margin-top:10px">
        <button class="btn primary" id="cloneBtn">Crear / guardar voz</button>
        <button class="btn danger" id="clrAudio">Borrar audios guardados</button>
      </div>
      <p class="hint" id="cloneMsg"></p>
    </div>
    <div class="card">
      <h3 style="margin-top:0">Almacenamiento</h3>
      <p class="hint">${est ? `Ocupa ${fmtBytes(est.usage || 0)}. El navegador te deja usar hasta ${fmtBytes(est.quota || 0)}.` : ''} ${persisted ? 'Almacenamiento persistente activado ✓' : 'El navegador podría borrar datos si falta espacio.'}</p>
      <div class="row">
        <button class="btn" id="persist">Pedir almacenamiento persistente</button>
        <button class="btn danger" id="wipe">Borrar todo lo descargado</button>
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
      else return (msg.textContent = 'Elige un audio de muestra o pega un ID de voz.');
      msg.textContent = '¡Voz lista! Ya se usa para leer.'; setTimeout(settings, 1200);
    } catch (e) { msg.textContent = 'Error: ' + e.message; }
  };
  $('#clrAudio').onclick = async () => { await db.audioClear(); toast('Audios borrados'); };
  $('#persist').onclick = async () => { const ok = await navigator.storage?.persist?.(); toast(ok ? 'Almacenamiento persistente activado' : 'El navegador no lo concedió (instala la app primero)'); settings(); };
  $('#wipe').onclick = async () => { if (confirm('¿Borrar la enciclopedia descargada y los artículos guardados?')) { await datos.borrar(); await db.clearAll(); toast('Borrado'); settings(); } };
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
(async () => {
  // Limpieza única del formato antiguo (base de datos de 2 millones de registros).
  try { if (!(await db.kvGet('v3'))) { await db.clearAll(); await db.kvSet('v3', 1); } } catch {}
  comprobarInstalacion();
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !inst.running && !inst.completo) comprobarInstalacion(); });
  addEventListener('online', () => { if (!inst.running && !inst.completo) comprobarInstalacion(); });
})();
  location.hash = hash; // triggers route() via hashchange
}
async function route() {
  const h = location.hash.slice(1) || '/';
  const [, a, b, c] = h.split('/');
  scrollTo(0, 0); selBtn.hidden = true; document.title = 'Dariopedia';
  if (a !== 's') $('#q').value = '';
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
(async () => {
  // Limpieza única del formato antiguo (base de datos de 2 millones de registros).
  try { if (!(await db.kvGet('v3'))) { await db.clearAll(); await db.kvSet('v3', 1); } } catch {}
  comprobarInstalacion();
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !inst.running && !inst.completo) comprobarInstalacion(); });
  addEventListener('online', () => { if (!inst.running && !inst.completo) comprobarInstalacion(); });
})();
