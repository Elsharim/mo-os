// Food + body data sent from Mo's iPhone (MacroFactor -> Apple Health -> Shortcut).
// Stored per day in Firestore (poppy/oshealth:Mo), encrypted with a server-only secret.
import { webcrypto, createHash } from 'crypto';

const subtle = (globalThis.crypto || webcrypto).subtle;
const rand = (n) => (globalThis.crypto || webcrypto).getRandomValues(new Uint8Array(n));
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyCYCt9-opphzCOSInAaPnrGIBN8M6kWW-Y';
const DOC_URL = 'https://firestore.googleapis.com/v1/projects/poppy-sales/databases/(default)/documents/poppy/oshealth:Mo';
const KEEP_DAYS = 400;

async function key() {
  return subtle.importKey('raw', createHash('sha256').update('health:' + (process.env.WHOOP_STORE_SECRET || '')).digest(), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function load() {
  const r = await fetch(`${DOC_URL}?key=${API_KEY}`);
  if (r.status === 404) return { days: {} };
  if (!r.ok) throw new Error('store read ' + r.status);
  const v = (((await r.json()).fields || {}).v || {}).stringValue;
  if (!v) return { days: {} };
  const [iv, ct] = v.split(':').map((x) => new Uint8Array(Buffer.from(x, 'base64')));
  return JSON.parse(new TextDecoder().decode(await subtle.decrypt({ name: 'AES-GCM', iv }, await key(), ct)));
}
async function save(obj) {
  const iv = rand(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, await key(), new TextEncoder().encode(JSON.stringify(obj)));
  const v = Buffer.from(iv).toString('base64') + ':' + Buffer.from(new Uint8Array(ct)).toString('base64');
  const r = await fetch(`${DOC_URL}?key=${API_KEY}&updateMask.fieldPaths=v`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { v: { stringValue: v } } })
  });
  if (!r.ok) throw new Error('store write ' + r.status);
}

// iOS Shortcuts sends numbers as strings, sometimes with units or commas.
const num = (x) => {
  if (x == null || x === '') return null;
  const n = parseFloat(String(x).replace(/,/g, '').match(/-?\d+(\.\d+)?/)?.[0]);
  return Number.isFinite(n) ? n : null;
};
const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

export async function ingest(body) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : null;
  if (!date) throw new Error('date must be YYYY-MM-DD');
  const day = {};
  const cal = num(body.calories), p = num(body.protein), c = num(body.carbs), f = num(body.fat), st = num(body.steps);
  let w = num(body.weight_lb);
  if (w == null && num(body.weight_kg) != null) w = num(body.weight_kg) * 2.20462;
  if (cal != null) day.calories = Math.round(cal);
  if (p != null) day.protein = Math.round(p);
  if (c != null) day.carbs = Math.round(c);
  if (f != null) day.fat = Math.round(f);
  if (st != null) day.steps = Math.round(st);
  if (w != null && w > 50 && w < 500) day.weight_lb = r1(w);
  const s = await load();
  s.days[date] = { ...(s.days[date] || {}), ...day, updated: new Date().toISOString() };
  const keys = Object.keys(s.days).sort();
  keys.slice(0, Math.max(0, keys.length - KEEP_DAYS)).forEach((k) => delete s.days[k]);
  await save(s);
  return { date, ...s.days[date] };
}

export async function healthSummary(days = 7) {
  const s = await load();
  const keys = Object.keys(s.days).sort().reverse();
  const recent = keys.slice(0, Math.min(90, days)).map((k) => ({ date: k, ...s.days[k] }));
  const weights = keys.map((k) => ({ date: k, lb: s.days[k].weight_lb })).filter((x) => x.lb);
  const trend = weights.length >= 2 ? r1(weights[0].lb - weights[Math.min(weights.length - 1, 7)].lb) : null;
  return {
    goal: { bodyweight_lb: 170 },
    days: recent,
    latest_weight_lb: weights[0] ? weights[0].lb : null,
    weight_change_last_7_entries_lb: trend,
    note: recent.length ? undefined : 'No food or weight data yet. The iPhone shortcut sends it from Apple Health (MacroFactor).'
  };
}
