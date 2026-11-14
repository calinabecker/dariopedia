// Text-to-speech for Dariopedia.
// - "sistema": Web Speech API (works offline with voices installed on the device).
// - "clonada": a voice cloned from an audio sample via the ElevenLabs API (needs internet
//   to generate; generated audio is cached in IndexedDB and replays offline).
import { audioGet, audioPut, kvGet, kvSet } from './db.js';

const EL = 'https://api.elevenlabs.io/v1';
let settings = { engine: 'sistema', systemVoice: '', rate: 1, apiKey: '', voiceId: '', voiceName: '' };
let current = null; // { stop() }
const listeners = new Set();
export const onState = fn => listeners.add(fn);
const emit = s => listeners.forEach(f => f(s));

export async function loadSettings() { Object.assign(settings, (await kvGet('voice')) || {}); return settings; }
export async function saveSettings(patch) { Object.assign(settings, patch); await kvSet('voice', settings); return settings; }
export const getSettings = () => settings;

export function systemVoices() {
  return new Promise(res => {
    const v = speechSynthesis.getVoices();
    if (v.length) return res(v);
    speechSynthesis.onvoiceschanged = () => res(speechSynthesis.getVoices());
    setTimeout(() => res(speechSynthesis.getVoices()), 1500);
  });
}

function chunks(text, max) {
  const parts = text.replace(/\s+/g, ' ').trim().match(/[^.!?¡¿;:]+[.!?;:]*\s*/g) || [text];
  const out = []; let cur = '';
  for (const p of parts) {
    if ((cur + p).length > max && cur) { out.push(cur.trim()); cur = ''; }
    if (p.length > max) { for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max)); continue; }
    cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

async function sha(s) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function stop() { current?.stop(); current = null; emit('idle'); }

export async function speak(text, lang = 'es') {
  stop();
  if (!text?.trim()) return;
  if (settings.engine === 'clonada' && settings.voiceId) return speakCloned(text);
  return speakSystem(text, lang);
}

async function speakSystem(text, lang) {
  const voices = await systemVoices();
  const voice = voices.find(v => v.voiceURI === settings.systemVoice) || voices.find(v => v.lang?.startsWith(lang));
  let stopped = false;
  current = { stop() { stopped = true; speechSynthesis.cancel(); } };
  emit('playing');
  for (const c of chunks(text, 220)) {
    if (stopped) return;
    await new Promise(res => {
      const u = new SpeechSynthesisUtterance(c);
      if (voice) u.voice = voice;
      u.lang = voice?.lang || lang; u.rate = settings.rate;
      u.onend = u.onerror = res;
      speechSynthesis.speak(u);
    });
  }
  if (!stopped) { current = null; emit('idle'); }
}

async function clonedChunk(text) {
  const key = await sha(settings.voiceId + '|' + text);
  let blob = await audioGet(key);
  if (blob) return blob;
  if (!navigator.onLine) throw new Error('Sin conexión: la voz clonada solo puede generar audio nuevo con internet (lo que ya has escuchado sí funciona sin conexión).');
  const r = await fetch(`${EL}/text-to-speech/${settings.voiceId}`, {
    method: 'POST',
    headers: { 'xi-api-key': settings.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' })
  });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 200)}`);
  blob = await r.blob();
  await audioPut(key, blob);
  return blob;
}

async function speakCloned(text) {
  const parts = chunks(text, 1500);
  let stopped = false, audio = null;
  current = { stop() { stopped = true; audio?.pause(); } };
  emit('loading');
  try {
    let next = clonedChunk(parts[0]);
    for (let i = 0; i < parts.length && !stopped; i++) {
      const blob = await next;
      if (i + 1 < parts.length) next = clonedChunk(parts[i + 1]);
      if (stopped) return;
      const url = URL.createObjectURL(blob);
      audio = new Audio(url); audio.playbackRate = settings.rate;
      emit('playing');
      await new Promise((res, rej) => { audio.onended = res; audio.onerror = () => rej(new Error('No se pudo reproducir el audio')); audio.play().catch(rej); });
      URL.revokeObjectURL(url);
    }
  } catch (e) { emit('idle'); current = null; throw e; }
  if (!stopped) { current = null; emit('idle'); }
}

/** Create an instant voice clone from an audio sample. Returns the voice id. */
export async function cloneVoice(file, name, apiKey) {
  const fd = new FormData();
  fd.append('name', name || 'Voz Dariopedia');
  fd.append('files', file, file.name || 'muestra.mp3');
  fd.append('description', 'Voz creada desde Dariopedia');
  const r = await fetch(`${EL}/voices/add`, { method: 'POST', headers: { 'xi-api-key': apiKey }, body: fd });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const { voice_id } = await r.json();
  await saveSettings({ apiKey, voiceId: voice_id, voiceName: name, engine: 'clonada' });
  return voice_id;
}
