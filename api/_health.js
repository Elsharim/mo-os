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
  const targets = resolveTargets(s.targets);
  const avg = (arr) => (arr.length ? r1(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
  const w7 = avg(weights.slice(0, 7).map((x) => x.lb)), wPrev7 = avg(weights.slice(7, 14).map((x) => x.lb));
  return {
    targets,
    weight_avg_7d_lb: w7, weight_avg_prev_7d_lb: wPrev7, weekly_change_lb: w7 != null && wPrev7 != null ? r1(w7 - wPrev7) : null,
    saved_meals: Object.values(s.meals || {}),
    days: recent,
    latest_weight_lb: weights[0] ? weights[0].lb : null,
    weight_change_last_7_entries_lb: trend,
    food_plan: buildFoodPlan(s.days, targets, localDateISO()),
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
    const usedSaved = !!(saved && MACROS.every((k) => num(it[k]) == null));
    for (const k of MACROS) m[k] = Math.round(num(it[k]) ?? (saved ? saved[k] : 0) ?? 0);
    if (!m.calories && !saved) throw new Error(`No numbers for "${m.name}" and it is not a saved meal. Estimate calories, protein, carbs and fat.`);
    m.estimated = !usedSaved;
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
  return { date, added: list, day_totals: { calories: d.calories, protein: d.protein, carbs: d.carbs, fat: d.fat }, food_plan: buildFoodPlan(s.days, s.targets, localDateISO()) };
}

export async function savedMeals() {
  const s = await load();
  return Object.values(s.meals || {});
}

export const DEFAULT_TARGETS = { calories: 3000, protein: 150, workouts_per_week: 5, goal_weight_lb: 170, start_weight_lb: 145, weekly_gain_lb: 0.4, tracking_since: '2026-10-09' };

export async function setTargets(t) {
  const s = await load();
  s.targets = { ...DEFAULT_TARGETS, ...(s.targets || {}) };
  for (const k of ['calories', 'protein', 'workouts_per_week', 'goal_weight_lb', 'weekly_gain_lb', 'start_weight_lb']) if (num(t[k]) != null) s.targets[k] = num(t[k]);
  if (num(t.weekly_calories) != null) s.targets.weekly_calories = Math.round(num(t.weekly_calories));
  if (/^\d{4}-\d{2}-\d{2}$/.test(t.tracking_since || '')) s.targets.tracking_since = t.tracking_since;
  s.targets.changed = new Date().toISOString().slice(0, 10);
  await save(s);
  return resolveTargets(s.targets);
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
  return { removed: gone, day_totals: { calories: d.calories, protein: d.protein, carbs: d.carbs, fat: d.fat }, food_plan: buildFoodPlan(s.days, s.targets, localDateISO()) };
}

// Weekly calorie budget. Weeks are Monday–Sunday on Mo's calendar (Europe/Sarajevo).
// The adjusted daily target uses food logged before today only, so eating today
// does not shrink today's target. Missing days stay unlogged, not zero.
// If any completed day is unlogged, the target is provisional: it is prorated
// over logged days plus the days still left, not the full weekly goal.
export const FOOD_TZ = 'Europe/Sarajevo';
export const ADJUST_HEADROOM = 700;
const HISTORY_WEEKS = 26;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const fmtCal = (n) => Math.round(n).toLocaleString('en-US');

export function localDateISO(now = new Date(), timeZone = FOOD_TZ) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function addIsoDays(iso, n) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function mondayOf(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addIsoDays(iso, -((dow + 6) % 7));
}

export function resolveTargets(stored) {
  const t = { ...DEFAULT_TARGETS, ...(stored || {}) };
  if (num(t.calories) == null) t.calories = 3000;
  if (num(t.protein) == null) t.protein = 150;
  if (num(t.goal_weight_lb) == null) t.goal_weight_lb = 170;
  if (num(t.start_weight_lb) == null) t.start_weight_lb = 145;
  if (num(t.weekly_calories) == null) t.weekly_calories = Math.round(num(t.calories) || 3000) * 7;
  else t.weekly_calories = Math.round(num(t.weekly_calories));
  return t;
}

function foodLogged(entry) {
  if (!entry) return false;
  if (Array.isArray(entry.foods) && entry.foods.length > 0) return true;
  return entry.calories != null;
}

function dayEstimated(entry) {
  if (!entry || !Array.isArray(entry.foods) || !entry.foods.length) return false;
  return entry.foods.some((f) => f.estimated !== false);
}

function adjustedNote({ raw, recommended, minRec, maxRec, remainingDays, unlogged }) {
  const notes = [];
  if (raw > maxRec) {
    notes.push(remainingDays === 1
      ? `Finishing the week today would take ${fmtCal(raw)} cal. Eat about ${fmtCal(recommended)} instead of cramming the gap into one day.`
      : `Finishing the week would take ${fmtCal(raw)} cal a day. Eat about ${fmtCal(recommended)} today and spread the rest across the remaining days instead of cramming.`);
  } else if (raw < minRec - 50) {
    notes.push(`You're ahead of the weekly budget (the uncapped target would be ${fmtCal(raw)}). Today's recommendation stays at your ${fmtCal(minRec)} base.`);
  }
  if (unlogged.length) {
    const n = unlogged.length;
    notes.push(`${n} day${n === 1 ? '' : 's'} unlogged, target based on logged days only.`);
  }
  return notes.length ? notes.join(' ') : null;
}

function summarizeWeek(daysMap, weekStart, today, T) {
  const base = Math.round(num(T.calories) || 3000);
  const weekly = Math.round(num(T.weekly_calories) || base * 7);
  const minRec = base;
  const maxRec = base + ADJUST_HEADROOM;
  const weekEnd = addIsoDays(weekStart, 6);
  const current = today >= weekStart && today <= weekEnd;
  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = addIsoDays(weekStart, i);
    const entry = daysMap ? daysMap[date] : null;
    const logged = foodLogged(entry);
    let status = 'unlogged';
    if (date > today) status = 'future';
    else if (date === today) status = 'partial';
    else if (logged) status = 'logged';
    const calories = logged ? Math.round(Number(entry.calories) || 0) : null;
    const protein = logged ? Math.round(Number(entry.protein) || 0) : null;
    days.push({
      date,
      weekday: WEEKDAYS[i],
      status,
      logged: status === 'future' ? false : logged,
      calories,
      protein,
      protein_hit: status === 'logged' ? protein >= T.protein : null,
      estimated: !!(logged && dayEstimated(entry))
    });
  }
  const completed = days.filter((d) => d.status === 'logged');
  const unlogged = days.filter((d) => d.status === 'unlogged');
  const eatenBefore = completed.reduce((a, d) => a + d.calories, 0);
  const todayDay = days.find((d) => d.date === today) || null;
  const todayCalories = todayDay && todayDay.logged ? todayDay.calories : 0;
  const consumed = current ? eatenBefore + (todayDay && todayDay.logged ? todayDay.calories : 0) : eatenBefore;
  const remainingDays = current ? days.filter((d) => d.date >= today).length : 0;
  // Unlogged completed days are not a hole in the full 21,000. Cover only the
  // days that were logged plus the days still left, including today.
  const provisional = unlogged.length > 0;
  const coveredDays = completed.length + remainingDays;
  const budget = provisional ? base * coveredDays : weekly;
  let raw = null;
  let recommended = null;
  let clamped = false;
  let note = null;
  if (current && remainingDays > 0) {
    raw = Math.round((budget - eatenBefore) / remainingDays);
    recommended = Math.min(maxRec, Math.max(minRec, raw));
    clamped = recommended !== raw;
    note = adjustedNote({ raw, recommended, minRec, maxRec, remainingDays, unlogged });
  } else if (provisional) {
    const n = unlogged.length;
    note = `${n} day${n === 1 ? '' : 's'} unlogged, target based on logged days only.`;
  }
  const avg = completed.length ? Math.round(eatenBefore / completed.length) : null;
  const delta = completed.length ? eatenBefore - base * completed.length : null;
  const band = 100 * completed.length;
  let pace = 'no_completed_days';
  let pace_note = 'No completed logged days yet. Today is still partial.';
  if (completed.length) {
    if (delta > band) pace = 'ahead';
    else if (delta < -band) pace = 'behind';
    else pace = 'on_pace';
    const gap = Math.abs(delta).toLocaleString('en-US');
    pace_note = pace === 'ahead'
      ? `${gap} cal ahead of the ${fmtCal(base)} base, across ${completed.length} logged day${completed.length === 1 ? '' : 's'}.`
      : pace === 'behind'
        ? `${gap} cal behind the ${fmtCal(base)} base, across ${completed.length} logged day${completed.length === 1 ? '' : 's'}.`
        : `On pace with the ${fmtCal(base)} base across logged days.`;
    if (unlogged.length) pace_note += ` ${unlogged.length} day${unlogged.length === 1 ? '' : 's'} unlogged, pace based on logged days only.`;
  } else if (unlogged.length) {
    pace_note += ` ${unlogged.length} day${unlogged.length === 1 ? '' : 's'} unlogged, pace based on logged days only.`;
  }
  const todayView = current ? {
    date: today,
    status: 'partial',
    logged: !!(todayDay && todayDay.logged),
    calories: todayCalories,
    estimated: !!(todayDay && todayDay.estimated),
    adjusted_daily_target: recommended,
    adjusted_daily_target_raw: raw,
    base_target: base,
    provisional,
    budget,
    clamped,
    clamp_min: minRec,
    clamp_max: maxRec,
    note,
    protein: todayDay && todayDay.logged ? todayDay.protein : 0,
    protein_target: T.protein,
    protein_remaining: Math.max(0, T.protein - (todayDay && todayDay.logged ? todayDay.protein : 0)),
    protein_hit: !!(todayDay && todayDay.logged && todayDay.protein >= T.protein)
  } : null;
  return {
    week_start: weekStart,
    week_end: weekEnd,
    current,
    weekly_goal: weekly,
    budget,
    provisional,
    calories: consumed,
    remaining: Math.max(0, budget - consumed),
    over: Math.max(0, consumed - budget),
    eaten_before_today: current ? eatenBefore : null,
    completed_logged_days: completed.length,
    unlogged_days: unlogged.length,
    unlogged_dates: unlogged.map((d) => d.date),
    avg_daily_calories: avg,
    adjusted_daily_target: recommended,
    adjusted_daily_target_raw: raw,
    clamped,
    adjusted_note: note,
    pace,
    pace_delta_cal: delta,
    pace_note,
    days,
    today: todayView
  };
}

function buildBulk(daysMap, T) {
  const weights = Object.keys(daysMap || {})
    .filter((k) => daysMap[k] && daysMap[k].weight_lb != null)
    .sort()
    .map((k) => ({ date: k, lb: daysMap[k].weight_lb }));
  const latest = weights.length ? weights[weights.length - 1] : null;
  const start = num(T.start_weight_lb) ?? 145;
  const goal = num(T.goal_weight_lb) ?? 170;
  const latestLb = latest ? latest.lb : null;
  const span = goal - start;
  const progress = latestLb != null && span > 0
    ? Math.round(Math.max(0, Math.min(1, (latestLb - start) / span)) * 1000) / 10
    : null;
  return {
    latest_weight_lb: latestLb,
    latest_weight_date: latest ? latest.date : null,
    start_weight_lb: start,
    goal_weight_lb: goal,
    gained_lb: latestLb != null ? r1(latestLb - start) : null,
    remaining_lb: latestLb != null ? r1(goal - latestLb) : null,
    progress_pct: progress
  };
}

export function buildFoodPlan(daysMap, targets, today) {
  const T = resolveTargets(targets);
  const thisMonday = mondayOf(today);
  let earliest = thisMonday;
  for (const k of Object.keys(daysMap || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !foodLogged(daysMap[k])) continue;
    const m = mondayOf(k);
    if (m < earliest) earliest = m;
  }
  const cap = addIsoDays(thisMonday, -7 * (HISTORY_WEEKS - 1));
  if (earliest < cap) earliest = cap;
  const weeks = [];
  for (let start = thisMonday; start >= earliest; start = addIsoDays(start, -7)) {
    const week = summarizeWeek(daysMap, start, today, T);
    // Empty past weeks stay in the day store. They are not listed as a 0-calorie week.
    if (week.current || week.completed_logged_days > 0) weeks.push(week);
  }
  const current = weeks[0];
  const todayView = current.today;
  for (const w of weeks) delete w.today;
  return {
    timezone: FOOD_TZ,
    as_of: today,
    adjusted_basis: 'When every completed day is logged, the weekly goal minus calories logged before today, divided by days left including today. When any completed day is unlogged, the target is provisional: daily base times logged days plus days left, minus calories on those logged days, divided by days left. Then capped between the daily base and the base plus 700. Calories eaten today do not change today\'s target. Week remaining and pace use that same budget.',
    protein_note: 'Protein is a daily target. A high day does not offset a low day.',
    targets: {
      calories: T.calories,
      protein: T.protein,
      weekly_calories: T.weekly_calories,
      start_weight_lb: T.start_weight_lb,
      goal_weight_lb: T.goal_weight_lb
    },
    today: todayView,
    week: current,
    recent_weeks: weeks,
    bulk: buildBulk(daysMap, T)
  };
}
