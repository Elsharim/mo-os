// Shared notepad between Claude and Grok, inside MO OS. Each side leaves notes
// for the other and marks them read. Stored encrypted (poppy/osnotes:Mo).
import { webcrypto, createHash } from 'crypto';

const subtle = (globalThis.crypto || webcrypto).subtle;
const rand = (n) => (globalThis.crypto || webcrypto).getRandomValues(new Uint8Array(n));
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyCYCt9-opphzCOSInAaPnrGIBN8M6kWW-Y';
const DOC_URL = 'https://firestore.googleapis.com/v1/projects/poppy-sales/databases/(default)/documents/poppy/osnotes:Mo';
const KEEP = 200;

async function key() {
  return subtle.importKey('raw', createHash('sha256').update('notes:' + (process.env.WHOOP_STORE_SECRET || '')).digest(), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function load() {
  const r = await fetch(`${DOC_URL}?key=${API_KEY}`);
  if (r.status === 404) return { notes: [] };
  if (!r.ok) throw new Error('store read ' + r.status);
  const v = (((await r.json()).fields || {}).v || {}).stringValue;
  if (!v) return { notes: [] };
  const [iv, ct] = v.split(':').map((x) => new Uint8Array(Buffer.from(x, 'base64')));
  const s = JSON.parse(new TextDecoder().decode(await subtle.decrypt({ name: 'AES-GCM', iv }, await key(), ct)));
  s.notes = s.notes || [];
  return s;
}
async function save(obj) {
  const iv = rand(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, await key(), new TextEncoder().encode(JSON.stringify(obj)));
  const v = Buffer.from(iv).toString('base64') + ':' + Buffer.from(new Uint8Array(ct)).toString('base64');
  const r = await fetch(`${DOC_URL}?key=${API_KEY}&updateMask.fieldPaths=v`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { v: { stringValue: v } } }) });
  if (!r.ok) throw new Error('store write ' + r.status);
}
const side = (x) => (String(x || '').toLowerCase() === 'grok' ? 'grok' : 'claude');

export async function leaveNote({ from, to, text, topic }) {
  const t = String(text || '').trim().slice(0, 2000);
  if (!t) throw new Error('Note is empty.');
  const s = await load();
  const n = { id: 'n' + Date.now() + Math.random().toString(36).slice(2, 6), at: new Date().toISOString(), from: side(from), to: side(to), topic: String(topic || '').slice(0, 60), text: t, read: false };
  s.notes.push(n);
  s.notes = s.notes.slice(-KEEP);
  await save(s);
  return n;
}
export async function readNotes({ to, unread_only, limit, mark_read }) {
  const s = await load();
  const who = side(to);
  let list = s.notes.filter((n) => n.to === who && (!unread_only || !n.read));
  list = list.slice(-Math.min(50, Number(limit) || 20));
  if (mark_read !== false && list.length) {
    const ids = new Set(list.map((n) => n.id));
    s.notes.forEach((n) => { if (ids.has(n.id)) n.read = true; });
    await save(s);
  }
  return list;
}
