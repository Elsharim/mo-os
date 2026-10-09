// Mo's calendar. Preferred: a Google Apps Script in his account pushes the next
// ~36h of events here every 15 min (handles recurring events). Fallback: Google's
// private iCal link (env CAL_ICS_URL), which only sees one-off events.
import { webcrypto, createHash } from 'crypto';
const subtle = (globalThis.crypto || webcrypto).subtle;
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyCYCt9-opphzCOSInAaPnrGIBN8M6kWW-Y';
const DOC_URL = 'https://firestore.googleapis.com/v1/projects/poppy-sales/databases/(default)/documents/poppy/oscal:Mo';
const ckey = () => subtle.importKey('raw', createHash('sha256').update('cal:' + (process.env.WHOOP_STORE_SECRET || '')).digest(), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

export async function storePushed(events) {
  const clean = (Array.isArray(events) ? events : []).slice(0, 200).map((e) => ({
    title: String(e.title || 'Busy').slice(0, 200), start: String(e.start || ''), end: String(e.end || ''), cal: String(e.cal || '').slice(0, 80)
  })).filter((e) => !isNaN(Date.parse(e.start)));
  const iv = (globalThis.crypto || webcrypto).getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, await ckey(), new TextEncoder().encode(JSON.stringify({ at: Date.now(), events: clean })));
  const v = Buffer.from(iv).toString('base64') + ':' + Buffer.from(new Uint8Array(ct)).toString('base64');
  const r = await fetch(`${DOC_URL}?key=${API_KEY}&updateMask.fieldPaths=v`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { v: { stringValue: v } } }) });
  if (!r.ok) throw new Error('store write ' + r.status);
  return clean.length;
}
async function loadPushed() {
  const r = await fetch(`${DOC_URL}?key=${API_KEY}`);
  if (!r.ok) return null;
  const v = (((await r.json()).fields || {}).v || {}).stringValue;
  if (!v) return null;
  const [iv, ct] = v.split(':').map((x) => new Uint8Array(Buffer.from(x, 'base64')));
  return JSON.parse(new TextDecoder().decode(await subtle.decrypt({ name: 'AES-GCM', iv }, await ckey(), ct)));
}

function zonedToUtc(y, mo, d, h, mi, s, tz) {
  // Treat the wall time as UTC, then correct by the zone's offset at that moment.
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
    const asTz = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return guess - (asTz - guess);
  } catch (_) { return guess; }
}

function parseDate(prop, val) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(val.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (!h) return { ms: Date.UTC(+y, +mo - 1, +d), allDay: true };
  if (z) return { ms: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) };
  const tz = (/TZID=([^;:]+)/.exec(prop) || [])[1];
  return { ms: tz ? zonedToUtc(+y, +mo, +d, +h, +mi, +s, tz) : Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) };
}

function parseIcs(text) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const out = [];
  let ev = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { ev = {}; continue; }
    if (line === 'END:VEVENT') { if (ev && ev.start) out.push(ev); ev = null; continue; }
    if (!ev) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const prop = line.slice(0, i), val = line.slice(i + 1);
    const name = prop.split(';')[0];
    if (name === 'DTSTART') ev.start = parseDate(prop, val);
    else if (name === 'DTEND') ev.end = parseDate(prop, val);
    else if (name === 'SUMMARY') ev.title = val.replace(/\\([,;\\])/g, '$1').replace(/\\n/g, ' ');
    else if (name === 'STATUS') ev.status = val;
    else if (name === 'RRULE') ev.recurring = true;
  }
  return out.filter((e) => e.status !== 'CANCELLED');
}

const offMin = (off) => {
  const m = /^([+-])(\d\d):(\d\d)$/.exec(off || '');
  return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : 0;
};
const hhmm = (ms, off) => new Date(ms + offMin(off) * 6e4).toISOString().slice(11, 16);

// Events in Mo's "day": local 5am today to 5am tomorrow (his calls run late).
export async function calendarToday(tzOffset) {
  const pushed = await loadPushed().catch(() => null);
  const urls = String(process.env.CAL_ICS_URL || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!pushed && !urls.length) return null;
  let raw;
  if (pushed) raw = pushed.events.map((e) => ({ title: e.title, start: { ms: Date.parse(e.start) }, end: e.end ? { ms: Date.parse(e.end) } : null }));
  else {
    const texts = await Promise.all(urls.map((u) => fetch(u).then((r) => (r.ok ? r.text() : '')).catch(() => '')));
    raw = texts.flatMap(parseIcs);
  }
  const now = Date.now(), om = offMin(tzOffset) * 6e4;
  const localNow = new Date(now + om);
  let dayStart = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), 5) - om;
  if (now < dayStart) dayStart -= 864e5;
  const dayEnd = dayStart + 864e5;
  const events = raw
    .filter((e) => !e.start.allDay && e.start.ms >= dayStart && e.start.ms < dayEnd)
    .sort((a, b) => a.start.ms - b.start.ms)
    .map((e) => ({
      title: e.title || 'Busy', start: hhmm(e.start.ms, tzOffset), end: e.end ? hhmm(e.end.ms, tzOffset) : null,
      start_iso: new Date(e.start.ms).toISOString(), end_iso: e.end ? new Date(e.end.ms).toISOString() : null, past: (e.end ? e.end.ms : e.start.ms + 18e5) < now
    }));
  const next = events.find((e) => !e.past) || null;
  return { events, next, synced_at: pushed ? new Date(pushed.at).toISOString() : null };
}

/* Queue of calendar writes (create / delete) that the Apps Script in Mo's account
   applies on its next run, then acks. Stored encrypted like the pushed events. */
const Q_URL = 'https://firestore.googleapis.com/v1/projects/poppy-sales/databases/(default)/documents/poppy/oscalq:Mo';
async function qLoad() {
  const r = await fetch(`${Q_URL}?key=${API_KEY}`);
  if (!r.ok) return [];
  const v = (((await r.json()).fields || {}).v || {}).stringValue;
  if (!v) return [];
  const [iv, ct] = v.split(':').map((x) => new Uint8Array(Buffer.from(x, 'base64')));
  try { return JSON.parse(new TextDecoder().decode(await subtle.decrypt({ name: 'AES-GCM', iv }, await ckey(), ct))); } catch (_) { return []; }
}
async function qSave(list) {
  const iv = (globalThis.crypto || webcrypto).getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, await ckey(), new TextEncoder().encode(JSON.stringify(list)));
  const v = Buffer.from(iv).toString('base64') + ':' + Buffer.from(new Uint8Array(ct)).toString('base64');
  const r = await fetch(`${Q_URL}?key=${API_KEY}&updateMask.fieldPaths=v`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { v: { stringValue: v } } }) });
  if (!r.ok) throw new Error('queue write ' + r.status);
}
export async function queueAdd(item) {
  const list = await qLoad();
  const it = { id: 'q' + Date.now() + Math.random().toString(36).slice(2, 7), at: Date.now(), ...item };
  list.push(it);
  await qSave(list.slice(-100));
  return it;
}
export const queuePending = () => qLoad();
export async function queueAck(ids) {
  const list = await qLoad();
  await qSave(list.filter((x) => !ids.includes(x.id)));
}
