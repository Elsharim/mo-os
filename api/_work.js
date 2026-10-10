// Calls per day: booked (calendar) vs showed (a Tactiq recording exists), logged
// by Grok each night. Stored encrypted in Firestore (poppy/oswork:Mo).
import { webcrypto, createHash } from 'crypto';

const subtle = (globalThis.crypto || webcrypto).subtle;
const rand = (n) => (globalThis.crypto || webcrypto).getRandomValues(new Uint8Array(n));
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyCYCt9-opphzCOSInAaPnrGIBN8M6kWW-Y';
const DOC_URL = 'https://firestore.googleapis.com/v1/projects/poppy-sales/databases/(default)/documents/poppy/oswork:Mo';

async function key() {
  return subtle.importKey('raw', createHash('sha256').update('work:' + (process.env.WHOOP_STORE_SECRET || '')).digest(), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function load() {
  const r = await fetch(`${DOC_URL}?key=${API_KEY}`);
  if (r.status === 404) return { days: {} };
  if (!r.ok) throw new Error('store read ' + r.status);
  const v = (((await r.json()).fields || {}).v || {}).stringValue;
  if (!v) return { days: {} };
  const [iv, ct] = v.split(':').map((x) => new Uint8Array(Buffer.from(x, 'base64')));
  const s = JSON.parse(new TextDecoder().decode(await subtle.decrypt({ name: 'AES-GCM', iv }, await key(), ct)));
  s.days = s.days || {};
  return s;
}
async function save(obj) {
  const iv = rand(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, await key(), new TextEncoder().encode(JSON.stringify(obj)));
  const v = Buffer.from(iv).toString('base64') + ':' + Buffer.from(new Uint8Array(ct)).toString('base64');
  const r = await fetch(`${DOC_URL}?key=${API_KEY}&updateMask.fieldPaths=v`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { v: { stringValue: v } } }) });
  if (!r.ok) throw new Error('store write ' + r.status);
}
const int = (x) => { const n = parseInt(x, 10); return Number.isFinite(n) && n >= 0 ? n : null; };

export async function logCalls(a) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(a.date || '') ? a.date : null;
  if (!date) throw new Error('date must be YYYY-MM-DD');
  const booked = int(a.booked), showed = int(a.showed);
  if (booked == null || showed == null) throw new Error('Give booked and showed as whole numbers.');
  const s = await load();
  s.days[date] = {
    booked, showed, no_shows: Math.max(0, booked - showed),
    closed: int(a.closed) ?? 0,
    cash_usd: Number(a.cash_usd) || 0,
    calls: Array.isArray(a.calls) ? a.calls.slice(0, 30).map((c) => ({ who: String(c.who || '').slice(0, 80), showed: !!c.showed, kind: String(c.kind || '').slice(0, 30), result: String(c.result || '').slice(0, 60) })) : undefined,
    note: a.note ? String(a.note).slice(0, 300) : undefined,
    updated: new Date().toISOString()
  };
  const keys = Object.keys(s.days).sort();
  keys.slice(0, Math.max(0, keys.length - 400)).forEach((k) => delete s.days[k]);
  await save(s);
  return { date, ...s.days[date] };
}

const sum = (list, k) => list.reduce((t, d) => t + (d[k] || 0), 0);
function roll(days) {
  const booked = sum(days, 'booked'), showed = sum(days, 'showed'), closed = sum(days, 'closed');
  return { days: days.length, booked, showed, no_shows: booked - showed, show_rate: booked ? Math.round((showed / booked) * 100) : null, closed, close_rate: showed ? Math.round((closed / showed) * 100) : null, cash_usd: Math.round(sum(days, 'cash_usd')) };
}
export async function callsSummary(days = 30) {
  const s = await load();
  const keys = Object.keys(s.days).sort();
  const today = new Date().toISOString().slice(0, 10);
  const since = (n) => new Date(Date.now() - (n - 1) * 864e5).toISOString().slice(0, 10);
  const pick = (from) => keys.filter((k) => k >= from).map((k) => ({ date: k, ...s.days[k] }));
  const wk = new Date(); const dow = (wk.getDay() + 6) % 7; const weekStart = new Date(wk.getTime() - dow * 864e5).toISOString().slice(0, 10);
  return {
    today: s.days[today] ? { date: today, ...s.days[today] } : null,
    yesterday: (() => { const y = new Date(Date.now() - 864e5).toISOString().slice(0, 10); return s.days[y] ? { date: y, ...s.days[y] } : null; })(),
    this_week: roll(pick(weekStart)),
    last_30_days: roll(pick(since(30))),
    recent: pick(since(Math.min(90, days))).reverse()
  };
}
