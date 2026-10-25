// Habit days only Mo's Mac can see (learning from his brain library, parents from texts and calls),
// pushed by ~/.claude/tools/moos-signals.py every 30 min. Stored encrypted with the server secret.
import { webcrypto, createHash } from 'crypto';
const subtle = (globalThis.crypto || webcrypto).subtle;
const rand = (n) => (globalThis.crypto || webcrypto).getRandomValues(new Uint8Array(n));
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyCYCt9-opphzCOSInAaPnrGIBN8M6kWW-Y';
const DOC_URL = 'https://firestore.googleapis.com/v1/projects/poppy-sales/databases/(default)/documents/poppy/ossignals:Mo';
const key = () => subtle.importKey('raw', createHash('sha256').update('signals:' + (process.env.WHOOP_STORE_SECRET || '')).digest(), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
const dates = (a) => (Array.isArray(a) ? a : []).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).slice(-120);

export async function storeSignals(body) {
  const clean = { at: Date.now(), learning: dates(body.learning), parents: dates(body.parents),
    learning_titles: Object.fromEntries(Object.entries(body.learning_titles || {}).slice(-60).map(([k, v]) => [k, String(v).slice(0, 160)])) };
  const iv = rand(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, await key(), new TextEncoder().encode(JSON.stringify(clean)));
  const v = Buffer.from(iv).toString('base64') + ':' + Buffer.from(new Uint8Array(ct)).toString('base64');
  const r = await fetch(`${DOC_URL}?key=${API_KEY}&updateMask.fieldPaths=v`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { v: { stringValue: v } } }) });
  if (!r.ok) throw new Error('signals write ' + r.status);
  return { learning: clean.learning.length, parents: clean.parents.length };
}
export async function readSignals() {
  const r = await fetch(`${DOC_URL}?key=${API_KEY}`);
  if (!r.ok) return null;
  const v = (((await r.json()).fields || {}).v || {}).stringValue;
  if (!v) return null;
  const [iv, ct] = v.split(':').map((x) => new Uint8Array(Buffer.from(x, 'base64')));
  return JSON.parse(new TextDecoder().decode(await subtle.decrypt({ name: 'AES-GCM', iv }, await key(), ct)));
}
