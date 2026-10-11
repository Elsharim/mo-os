// Apple Health via the Health Auto Export iOS app (REST API automation).
// The phone POSTs JSON to /api/health with header x-api-key. The key is an HMAC
// of WHOOP_STORE_SECRET, so no extra Vercel env var is required.
// Daily values live in Firestore (poppy/osapple:Mo), encrypted with that secret.
// Re-sends replace one metric for one local day; other metrics and days stay.
import { webcrypto, createHash, createHmac, timingSafeEqual } from 'crypto';

const subtle = (globalThis.crypto || webcrypto).subtle;
const rand = (n) => (globalThis.crypto || webcrypto).getRandomValues(new Uint8Array(n));
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyCYCt9-opphzCOSInAaPnrGIBN8M6kWW-Y';
const DOC_URL = 'https://firestore.googleapis.com/v1/projects/poppy-sales/databases/(default)/documents/poppy/osapple:Mo';
const ZONE = 'Europe/Sarajevo';
const KEEP_DAYS = 400;
const MAX_METRICS = 30;
const LABEL = 'apple-health-ingest';

export const INGEST_URL = 'https://mo-os-omega.vercel.app/api/health';
export const INGEST_HEADER = 'x-api-key';

const ALIAS = {
  steps: 'step_count',
  stepcount: 'step_count',
  active_energy_burned: 'active_energy',
  walk_run_distance: 'walking_running_distance',
  distance_walking_running: 'walking_running_distance',
  rest_heart_rate: 'resting_heart_rate'
};
const PRIORITY = new Set(['step_count', 'active_energy', 'walking_running_distance', 'resting_heart_rate']);
const CUMULATIVE = new Set([
  'step_count', 'active_energy', 'basal_energy', 'walking_running_distance',
  'flights_climbed', 'apple_exercise_time', 'apple_stand_time', 'apple_standtime',
  'apple_move_time', 'push_count', 'swim_stroke_count', 'swimming_stroke_count',
  'nike_fuel', 'uv_exposure'
]);

const num = (x) => {
  if (x == null || x === '') return null;
  const n = parseFloat(String(x).replace(/,/g, '').match(/-?\d+(\.\d+)?/)?.[0]);
  return Number.isFinite(n) ? n : null;
};
const r1 = (n) => Math.round(n * 10) / 10;
const r3 = (n) => Math.round(n * 1000) / 1000;

export function ingestKey() {
  const s = process.env.WHOOP_STORE_SECRET || '';
  if (!s) throw new Error('WHOOP_STORE_SECRET missing');
  return createHmac('sha256', s).update(LABEL).digest('hex');
}

export function keyOk(given) {
  const a = createHash('sha256').update(String(given || '').slice(0, 256)).digest();
  const b = createHash('sha256').update(ingestKey()).digest();
  return timingSafeEqual(a, b);
}

function ymdInZone(date) {
  if (Number.isNaN(date.getTime())) return null;
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// Health Auto Export writes "2026-10-11 00:00:00 +0200": the calendar date is the
// one in that offset, not UTC. A trailing Z has no local offset, so use Sarajevo.
export function calendarDate(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?))?(?:\s*([+-]\d{2}:?\d{2}|Z))?/);
  if (!m) return null;
  if (m[3] === 'Z' && m[2]) return ymdInZone(new Date(`${m[1]}T${m[2]}Z`));
  return m[1];
}

function metricName(name) {
  const n = String(name || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
  if (!n || n === 'proto' || n === 'constructor' || n === 'prototype') return '';
  return ALIAS[n] || n;
}

function isCumulative(name) {
  return CUMULATIVE.has(name) || name.startsWith('dietary_') || name.startsWith('distance_') || name.endsWith('_distance');
}

function pointQty(pt) {
  const q = num(pt && pt.qty);
  if (q != null) return q;
  const avg = num(pt && (pt.Avg != null ? pt.Avg : pt.avg));
  if (avg != null) return avg;
  return num(pt && pt.asleep);
}

function energyToKcal(qty, units) {
  const raw = String(units || '').trim();
  const u = raw.toLowerCase();
  if (u === 'kj' || u.startsWith('kilojoule')) return qty / 4.184;
  if (u === 'kcal' || u.startsWith('kilocalorie')) return qty;
  if (raw === 'Cal' || raw === 'Calories') return qty;
  if (u === 'cal' || u === 'calorie' || u === 'calories') return qty / 1000;
  return qty;
}

function distanceConvert(qty, units) {
  const u = String(units || '').trim().toLowerCase();
  if (!u || u === 'km' || u.startsWith('kilomet')) return { qty, units: 'km' };
  if (u === 'mi' || u === 'mile' || u === 'miles') return { qty: qty * 1.609344, units: 'km' };
  if (u === 'm' || u === 'meter' || u === 'meters' || u === 'metre' || u === 'metres') return { qty: qty / 1000, units: 'km' };
  if (u === 'yd' || u.startsWith('yard')) return { qty: qty * 0.0009144, units: 'km' };
  if (u === 'ft' || u === 'foot' || u === 'feet') return { qty: qty * 0.0003048, units: 'km' };
  return { qty, units: u };
}

function convert(name, qty, units) {
  if (name === 'active_energy' || name === 'basal_energy') return { qty: energyToKcal(qty, units), units: 'kcal' };
  if (name === 'step_count') return { qty, units: 'count' };
  if (name === 'resting_heart_rate' || name === 'heart_rate' || name === 'walking_heart_rate') return { qty, units: 'count/min' };
  if (name === 'walking_running_distance' || name.startsWith('distance_') || name.endsWith('_distance')) return distanceConvert(qty, units);
  return { qty, units: String(units || '') };
}

function roundQty(name, qty, units) {
  if (name === 'step_count') return Math.round(qty);
  if (units === 'kcal' || name === 'resting_heart_rate' || name.endsWith('heart_rate')) return r1(qty);
  if (units === 'km') return r3(qty);
  return r3(qty);
}

function lists(body) {
  if (Array.isArray(body)) return { metrics: body, workouts: [], deletions: [] };
  const d = body && body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : {};
  const metrics = Array.isArray(d.metrics) ? d.metrics : (Array.isArray(body.metrics) ? body.metrics : []);
  const workouts = Array.isArray(d.workouts) ? d.workouts : (Array.isArray(body.workouts) ? body.workouts : []);
  const deletions = Array.isArray(d.deletions) ? d.deletions : (Array.isArray(body.deletions) ? body.deletions : []);
  return { metrics, workouts, deletions };
}

export function isAutoExport(body) {
  if (Array.isArray(body)) return body.some((m) => m && typeof m === 'object' && (m.name || Array.isArray(m.data)));
  if (!body || typeof body !== 'object') return false;
  const { metrics, workouts, deletions } = lists(body);
  return !!(metrics.length || workouts.length || deletions.length || (body.data && typeof body.data === 'object' && (Array.isArray(body.data.metrics) || Array.isArray(body.data.workouts))));
}

function blank() { return { days: {}, synced: null }; }

async function storeKey() {
  const s = process.env.WHOOP_STORE_SECRET || '';
  if (!s) throw new Error('WHOOP_STORE_SECRET missing');
  return subtle.importKey('raw', createHash('sha256').update('apple:' + s).digest(), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function load() {
  const r = await fetch(`${DOC_URL}?key=${API_KEY}`);
  if (r.status === 404) return blank();
  if (!r.ok) throw new Error('store read ' + r.status);
  const v = (((await r.json()).fields || {}).v || {}).stringValue;
  if (!v) return blank();
  const [iv, ct] = v.split(':').map((x) => new Uint8Array(Buffer.from(x, 'base64')));
  const s = JSON.parse(new TextDecoder().decode(await subtle.decrypt({ name: 'AES-GCM', iv }, await storeKey(), ct)));
  s.days = s.days || {};
  return s;
}
async function save(obj) {
  const iv = rand(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, await storeKey(), new TextEncoder().encode(JSON.stringify(obj)));
  const v = Buffer.from(iv).toString('base64') + ':' + Buffer.from(new Uint8Array(ct)).toString('base64');
  const r = await fetch(`${DOC_URL}?key=${API_KEY}&updateMask.fieldPaths=v`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { v: { stringValue: v } } })
  });
  if (!r.ok) throw new Error('store write ' + r.status);
}

function collapse(body) {
  const { metrics, workouts, deletions } = lists(body);
  const days = {};
  const touch = (date) => (days[date] = days[date] || { metrics: {}, workouts: [] });
  for (const m of metrics) {
    if (!m || typeof m !== 'object') continue;
    const name = metricName(m.name);
    if (!name) continue;
    const cumulative = isCumulative(name);
    for (const pt of m.data || []) {
      if (!pt || typeof pt !== 'object') continue;
      const date = calendarDate(pt.date || pt.startDate);
      const raw = pointQty(pt);
      if (!date || raw == null) continue;
      const c = convert(name, raw, pt.units || m.units);
      const bucket = touch(date);
      const slot = bucket.metrics[name];
      if (!slot) bucket.metrics[name] = { sum: c.qty, n: 1, units: c.units, cumulative };
      else if (slot.units === c.units) { slot.sum += c.qty; slot.n += 1; }
    }
  }
  for (const w of workouts) {
    if (!w || typeof w !== 'object') continue;
    const start = String(w.start || w.startDate || '');
    const date = calendarDate(start);
    if (!date) continue;
    const name = String(w.name || w.workoutActivityType || 'Workout').slice(0, 80);
    const id = String(w.id || w.workoutId || `${start}|${name}`).slice(0, 120);
    const dur = num(w.duration);
    const row = { id, name, start: start.slice(0, 40), end: String(w.end || w.endDate || '').slice(0, 40) };
    if (dur != null) row.duration_min = Math.round(dur / 60);
    touch(date).workouts.push(row);
  }
  const drops = [];
  for (const d of deletions) {
    if (!d || typeof d !== 'object') continue;
    const name = metricName(d.name);
    const date = calendarDate(d.date || d.startDate);
    if (name && date) drops.push({ name, date });
  }
  return { days, drops };
}

function mergeWorkouts(prev, next) {
  const map = new Map();
  for (const w of prev || []) if (w && w.id) map.set(w.id, w);
  for (const w of next || []) if (w && w.id) map.set(w.id, w);
  return [...map.values()].slice(-20);
}

export async function ingestApple(body) {
  if (!isAutoExport(body)) throw new Error('Expected Health Auto Export JSON ({ data: { metrics } }).');
  const patch = collapse(body);
  const s = await load();
  let upserts = 0;
  let workoutUpserts = 0;
  for (const drop of patch.drops) {
    const d = s.days[drop.date];
    if (d && d.metrics && d.metrics[drop.name]) { delete d.metrics[drop.name]; upserts += 1; }
  }
  for (const [date, incoming] of Object.entries(patch.days)) {
    const d = (s.days[date] = s.days[date] || { metrics: {} });
    d.metrics = d.metrics || {};
    for (const [name, slot] of Object.entries(incoming.metrics)) {
      if (!PRIORITY.has(name) && d.metrics[name] == null && Object.keys(d.metrics).length >= MAX_METRICS) continue;
      const qty = slot.cumulative ? slot.sum : slot.sum / slot.n;
      d.metrics[name] = { qty: roundQty(name, qty, slot.units), units: slot.units };
      upserts += 1;
    }
    if (incoming.workouts.length) {
      d.workouts = mergeWorkouts(d.workouts, incoming.workouts);
      workoutUpserts += incoming.workouts.length;
    }
    if (!Object.keys(d.metrics).length && !(d.workouts || []).length) delete s.days[date];
  }
  for (const date of Object.keys(s.days)) {
    const d = s.days[date];
    if (!d || (!Object.keys(d.metrics || {}).length && !(d.workouts || []).length)) delete s.days[date];
  }
  const keys = Object.keys(s.days).sort();
  keys.slice(0, Math.max(0, keys.length - KEEP_DAYS)).forEach((k) => delete s.days[k]);
  if (upserts || workoutUpserts) s.synced = new Date().toISOString();
  await save(s);
  return {
    upserts, workout_upserts: workoutUpserts,
    days: Object.keys(patch.days).sort(),
    metrics: [...new Set(Object.values(patch.days).flatMap((d) => Object.keys(d.metrics)))].sort()
  };
}

function dayView(date, day) {
  const m = (day && day.metrics) || {};
  const extra = {};
  for (const [k, v] of Object.entries(m)) {
    if (PRIORITY.has(k) || !v) continue;
    extra[k] = { qty: v.qty, units: v.units || '' };
  }
  const workouts = ((day && day.workouts) || []).map((w) => {
    const row = { name: w.name, start: w.start };
    if (w.duration_min != null) row.duration_min = w.duration_min;
    return row;
  });
  const out = {
    date,
    steps: m.step_count ? m.step_count.qty : null,
    active_energy_kcal: m.active_energy ? m.active_energy.qty : null,
    distance_km: m.walking_running_distance && m.walking_running_distance.units === 'km' ? m.walking_running_distance.qty : null,
    resting_hr: m.resting_heart_rate ? m.resting_heart_rate.qty : null
  };
  if (Object.keys(extra).length) out.extra = extra;
  if (workouts.length) out.workouts = workouts;
  return out;
}

function avg(rows, field, round) {
  const vals = rows.map((r) => r[field]).filter((v) => v != null);
  if (!vals.length) return null;
  return round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

export async function appleSummary(days = 7) {
  const n = Math.min(90, Math.max(1, Math.round(Number(days) || 7)));
  const s = await load();
  const keys = Object.keys(s.days).sort().reverse();
  const recent = keys.slice(0, n).map((k) => dayView(k, s.days[k]));
  const week = keys.slice(0, 7).map((k) => dayView(k, s.days[k]));
  const out = {
    last_sync: s.synced || null,
    averages_7d: {
      steps: avg(week, 'steps', Math.round),
      active_energy_kcal: avg(week, 'active_energy_kcal', r1),
      distance_km: avg(week, 'distance_km', r3),
      resting_hr: avg(week, 'resting_hr', r1)
    },
    days: recent
  };
  if (!keys.length) out.note = 'No Apple Health data yet. Call health with setup:true and paste the URL and x-api-key into Health Auto Export.';
  return out;
}

export function appleSetup() {
  const key = ingestKey();
  return {
    url: INGEST_URL,
    method: 'POST',
    header: INGEST_HEADER,
    key,
    health_auto_export: {
      automation_type: 'REST API',
      url: INGEST_URL,
      headers: [{ name: INGEST_HEADER, value: key }],
      data_type: 'Health Metrics',
      metrics: [
        'Step Count (step_count)',
        'Active Energy (active_energy)',
        'Walking + Running Distance (walking_running_distance)',
        'Resting Heart Rate (resting_heart_rate)'
      ],
      export_format: 'JSON',
      export_version: 'Version 2',
      summarize_data: true,
      time_grouping: 'Days',
      date_range: 'Previous 7 Days',
      batch_requests: false,
      sync: 'Every 1 hour'
    }
  };
}
