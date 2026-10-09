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

// Health Auto Export (iOS app) REST format:
// { data: { metrics: [ { name, units, data: [ { date: "2026-10-04 00:00:00 -0700", qty } ] } ] } }
const HAE = {
  dietary_energy: 'calories', protein: 'protein', carbohydrates: 'carbs', total_fat: 'fat',
  step_count: 'steps', weight_body_mass: 'weight'
};
function fromAutoExport(body) {
  const days = {};
  for (const m of (body.data && body.data.metrics) || []) {
    const field = HAE[m.name];
    if (!field) continue;
    for (const pt of m.data || []) {
      const date = String(pt.date || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      let q = num(pt.qty);
      if (q == null) continue;
      const d = (days[date] = days[date] || { date });
      if (field === 'calories' && /kj/i.test(m.units || '')) q = q / 4.184;
      if (field === 'weight') d.weight = q + ' ' + (m.units || '');
      else d[field] = (num(d[field]) || 0) + q;
    }
  }
  return Object.values(days);
}

export async function ingestAny(body) {
  if (body && body.data && Array.isArray(body.data.metrics)) {
    const out = [];
    for (const day of fromAutoExport(body)) out.push(await ingest(day));
    return out;
  }
  return [await ingest(body)];
}

export async function ingest(body) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : null;
  if (!date) throw new Error('date must be YYYY-MM-DD');
  const day = {};
  const cal = num(body.calories), p = num(body.protein), c = num(body.carbs), f = num(body.fat), st = num(body.steps);
  let w = num(body.weight_lb);
  if (w == null && num(body.weight_kg) != null) w = num(body.weight_kg) * 2.20462;
  if (w == null && num(body.weight) != null) {
    // raw Health value like "66.6 kg" or "147 lb"; no unit -> guess by size
    const raw = String(body.weight).toLowerCase(), n = num(body.weight);
    w = /kg/.test(raw) || (!/lb/.test(raw) && n < 100) ? n * 2.20462 : n;
  }
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
  const targets = { ...DEFAULT_TARGETS, ...(s.targets || {}) };
  const avg = (arr) => (arr.length ? r1(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
  const w7 = avg(weights.slice(0, 7).map((x) => x.lb)), wPrev7 = avg(weights.slice(7, 14).map((x) => x.lb));
  return {
    targets,
    weight_avg_7d_lb: w7, weight_avg_prev_7d_lb: wPrev7, weekly_change_lb: w7 != null && wPrev7 != null ? r1(w7 - wPrev7) : null,
    saved_meals: Object.values(s.meals || {}),
    days: recent,
    latest_weight_lb: weights[0] ? weights[0].lb : null,
    weight_change_last_7_entries_lb: trend,
    note: recent.length ? undefined : 'Nothing logged yet. Mo logs food and weight by messaging Grok (log_food, log_weight).'
  };
}

// Food logged by talking to Grok (photo or text). Adds to the day's totals and
// keeps the item list. Saved meals are reused by name with exact numbers.
const MACROS = ['calories', 'protein', 'carbs', 'fat'];
const mkey = (n) => String(n || '').trim().toLowerCase();

export async function logFood({ date, items, save_as }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('date must be YYYY-MM-DD (his local date)');
  const s = await load();
  s.meals = s.meals || {};
  const list = [];
  for (const it of Array.isArray(items) ? items : []) {
    const saved = s.meals[mkey(it.name)];
    const m = { name: String(it.name || 'food').slice(0, 120) };
    for (const k of MACROS) m[k] = Math.round(num(it[k]) ?? (saved ? saved[k] : 0) ?? 0);
    if (!m.calories && !saved) throw new Error(`No numbers for "${m.name}" and it is not a saved meal. Estimate calories, protein, carbs and fat.`);
    list.push(m);
  }
  if (!list.length) throw new Error('No food items given.');
  if (save_as) {
    const tot = {}; for (const k of MACROS) tot[k] = list.reduce((a, x) => a + x[k], 0);
    s.meals[mkey(save_as)] = { name: String(save_as).slice(0, 80), ...tot };
  }
  const d = (s.days[date] = s.days[date] || {});
  d.foods = d.foods || [];
  for (const m of list) {
    d.foods.push({ ...m, at: new Date().toISOString() });
    for (const k of MACROS) d[k] = (d[k] || 0) + m[k];
  }
  d.updated = new Date().toISOString();
  await save(s);
  return { date, added: list, day_totals: { calories: d.calories, protein: d.protein, carbs: d.carbs, fat: d.fat } };
}

export async function savedMeals() {
  const s = await load();
  return Object.values(s.meals || {});
}

export const DEFAULT_TARGETS = { calories: 3000, protein: 150, workouts_per_week: 5, goal_weight_lb: 170, weekly_gain_lb: 0.4, tracking_since: '2026-10-09' };

export async function setTargets(t) {
  const s = await load();
  s.targets = { ...DEFAULT_TARGETS, ...(s.targets || {}) };
  for (const k of ['calories', 'protein', 'workouts_per_week', 'goal_weight_lb', 'weekly_gain_lb']) if (num(t[k]) != null) s.targets[k] = num(t[k]);
  if (/^\d{4}-\d{2}-\d{2}$/.test(t.tracking_since || '')) s.targets.tracking_since = t.tracking_since;
  s.targets.changed = new Date().toISOString().slice(0, 10);
  await save(s);
  return s.targets;
}

export async function logWeight({ date, lb, kg }) {
  const w = num(lb) ?? (num(kg) != null ? num(kg) * 2.20462 : null);
  if (w == null) throw new Error('Give lb or kg.');
  return ingest({ date, weight_lb: w });
}

// Remove a logged item: by name (latest match) or the last one.
export async function removeFood({ date, name }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('date must be YYYY-MM-DD');
  const s = await load();
  const d = s.days[date];
  if (!d || !d.foods || !d.foods.length) throw new Error('Nothing logged that day.');
  let i = d.foods.length - 1;
  if (name) { const n = mkey(name); for (; i >= 0; i--) if (mkey(d.foods[i].name).includes(n)) break; }
  if (i < 0) throw new Error(`No "${name}" logged that day.`);
  const [gone] = d.foods.splice(i, 1);
  for (const k of MACROS) d[k] = Math.max(0, (d[k] || 0) - (gone[k] || 0));
  await save(s);
  return { removed: gone, day_totals: { calories: d.calories, protein: d.protein, carbs: d.carbs, fat: d.fat } };
}
