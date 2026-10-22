// A copy of the parts of MO OS the bots need (tasks, journal, disciplines,
// goals). The app pushes its state after each save. Bots also patch this copy
// when they change something, so list_tasks updates before the app is open.
// Writes compare-and-swap on the Firestore document. A stale app snapshot
// cannot wipe a newer one, and a bot edit cannot put an old task list back.
import { webcrypto, createHash } from 'crypto';
const subtle = (globalThis.crypto || webcrypto).subtle;
const rand = (n) => (globalThis.crypto || webcrypto).getRandomValues(new Uint8Array(n));
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyCYCt9-opphzCOSInAaPnrGIBN8M6kWW-Y';
const DOC_URL = 'https://firestore.googleapis.com/v1/projects/poppy-sales/databases/(default)/documents/poppy/osmirror:Mo';

export const NO_MIRROR = 'MO OS has not shared a copy of its tasks and journal yet. Mo opens MO OS once on any device and it syncs within a few seconds.';
export const NOW_CAP = 5;
export const NUDGE_MS = 3 * 864e5;
export const QUIET_MS = 14 * 864e5;

const key = () => subtle.importKey('raw', createHash('sha256').update('mirror:' + (process.env.WHOOP_STORE_SECRET || '')).digest(), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

const day = (d = new Date()) => d.toISOString().slice(0, 10);
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const iso = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);
const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

export function priorityRank(p) { return p === 'P1' ? 0 : p === 'P3' ? 2 : 1; }

export function priorityOf(t, top3ids) {
  const p = t && t.priority;
  if (p === 'P1' || p === 'P2' || p === 'P3') return p;
  if (top3ids && t && top3ids.includes(t.id)) return 'P1';
  return 'P2';
}

// Explicit priority wins. Legacy today/top3 true means P1. Otherwise P2.
export function coercePriority(raw, hints) {
  const p = String(raw || '').toUpperCase();
  if (p === 'P1' || p === 'P2' || p === 'P3') return p;
  const h = hints || {};
  if (h.top3 === true || h.today === true) return 'P1';
  return 'P2';
}

// For an update: a real priority wins, legacy true flags promote to P1,
// legacy false does not demote.
export function priorityFromUpdate(st, current) {
  const cur = current === 'P1' || current === 'P2' || current === 'P3' ? current : 'P2';
  if (!st || typeof st !== 'object') return cur;
  if (st.priority != null && String(st.priority).trim() !== '') {
    const p = String(st.priority).toUpperCase();
    if (p === 'P1' || p === 'P2' || p === 'P3') return p;
  }
  if (st.top3 === true || st.today === true) return 'P1';
  return cur;
}

export function sortTasks(list) {
  return list.slice().sort((a, b) =>
    priorityRank(a.priority) - priorityRank(b.priority) ||
    (Number(a.ts) || 0) - (Number(b.ts) || 0) ||
    String(a.id || '').localeCompare(String(b.id || ''))
  );
}

function decorate(t, why) {
  const surfaced = why === 'overdue' || why === 'untouched' ? why : null;
  return surfaced ? { ...t, surfaced } : { ...t, surfaced: null };
}

// Open tasks, grouped the way the app shows them. `now` is capped.
export function groupTasks(tasks, now = Date.now()) {
  const open = (tasks || []).filter((t) => t && t.status !== 'completed');
  const overdue = (t) => {
    const w = Date.parse(t.when || '');
    return !Number.isNaN(w) && w < now;
  };
  const age = (t) => now - (Number(t.touchedAt || t.ts) || 0);
  const quiet = (t) => age(t) > QUIET_MS;
  const pool = [];
  const add = (list, why) => {
    for (const t of sortTasks(list)) {
      if (pool.some((x) => x.id === t.id)) continue;
      pool.push({ task: t, why });
    }
  };
  add(open.filter(overdue), 'overdue');
  add(open.filter((t) => t.priority === 'P1'), 'priority');
  add(open.filter((t) => t.priority === 'P2' && !overdue(t) && age(t) >= NUDGE_MS && !quiet(t)), 'untouched');
  const nowItems = pool.slice(0, NOW_CAP).map((x) => decorate(x.task, x.why));
  const nowIds = new Set(nowItems.map((t) => t.id));
  const also = pool.filter((x) => !nowIds.has(x.task.id) && x.why !== 'untouched').map((x) => decorate(x.task, x.why));
  const taken = new Set([...nowIds, ...also.map((t) => t.id)]);
  return {
    now: nowItems,
    also_now: also,
    this_week: sortTasks(open.filter((t) => t.priority === 'P2' && !taken.has(t.id))),
    later: sortTasks(open.filter((t) => t.priority === 'P3' && !taken.has(t.id)))
  };
}

function cleanIncomingTask(t, top3ids, previous) {
  const id = String((t && t.id) || '');
  const explicit = t && (t.priority === 'P1' || t.priority === 'P2' || t.priority === 'P3');
  let priority = 'P2';
  if (explicit) priority = t.priority;
  else if (top3ids.includes(id)) priority = 'P1';
  else if (previous && (previous.priority === 'P1' || previous.priority === 'P2' || previous.priority === 'P3')) priority = previous.priority;
  return {
    id,
    name: String((t && t.name) || '').slice(0, 500),
    projectId: t && t.projectId ? String(t.projectId) : null,
    today: !!(t && t.today),
    priority,
    status: String((t && t.status) || 'inbox'),
    when: (t && t.when) || null,
    ts: Number(t && t.ts) || 0,
    touchedAt: Number((t && (t.touchedAt || t.ts)) || 0) || 0,
    completedAt: Number(t && t.completedAt) || null
  };
}

// App snapshot wins, except:
// - a bot edit newer than the app's touchedAt (botTouch) is kept
// - a bot delete tombstone newer than touchedAt drops the task
// - a pending bot add whose name the app does not have yet is kept
// - a task created or bot-edited after this snapshot was built is kept
export function mergeTaskLists(prevTasks, incomingTasks, builtAt, tombstones) {
  const prev = prevTasks || [];
  const byId = new Map(prev.map((t) => [t.id, t]));
  const tombs = new Map((tombstones || []).filter((t) => t && t.id).map((t) => [t.id, Number(t.at) || 0]));
  const out = [];
  for (const t of incomingTasks || []) {
    if (!t || !t.id) continue;
    const tombAt = tombs.get(t.id) || 0;
    if (tombAt && (Number(t.touchedAt) || 0) < tombAt) continue;
    const old = byId.get(t.id);
    if (old && old.botTouch && (Number(t.touchedAt) || 0) < Number(old.botTouch)) {
      out.push(old);
      continue;
    }
    out.push(t);
  }
  const openNames = new Set(out.filter((t) => t.status !== 'completed').map((t) => norm(t.name)));
  const outIds = new Set(out.map((t) => t.id));
  for (const t of prev) {
    if (!t || outIds.has(t.id)) continue;
    const newer = builtAt && ((Number(t.ts) || 0) > builtAt || (Number(t.botTouch) || 0) > builtAt);
    if (t.pending && !openNames.has(norm(t.name))) { out.push(t); continue; }
    if (newer) out.push(t);
  }
  return out;
}

function capTasks(tasks) {
  const open = [];
  const done = [];
  for (const t of tasks) (t.status === 'completed' ? done : open).push(t);
  done.sort((a, b) => (Number(b.completedAt) || 0) - (Number(a.completedAt) || 0));
  return [...sortTasks(open), ...done].slice(0, 600);
}

function flattenDays(days) {
  return Object.fromEntries(Object.entries(days || {}).slice(-60).map(([k, v]) => [String(k).slice(0, 10), Object.fromEntries(Object.entries((v && v.disc) || v || {}).filter(([, on]) => on).map(([id]) => [String(id), true]))]));
}

export function mergeAppSnapshot(current, incoming) {
  const prev = current && typeof current === 'object' ? current : null;
  const inc = incoming && typeof incoming === 'object' ? incoming : {};
  const builtAt = Number(inc.builtAt) || 0;
  const prevBuilt = prev ? Number(prev.builtAt) || 0 : 0;
  if (prev && prevBuilt && builtAt && builtAt < prevBuilt) return { skip: true, value: prev };
  const top3 = Array.isArray(inc.top3) ? inc.top3.map(String) : [];
  const prevById = new Map(((prev && prev.tasks) || []).map((t) => [t.id, t]));
  const incomingTasks = (Array.isArray(inc.tasks) ? inc.tasks : []).map((t) => cleanIncomingTask(t, top3, prevById.get(String((t && t.id) || ''))));
  const tombstones = ((prev && prev.tombstones) || []).filter((t) => t && t.id && Date.now() - (Number(t.at) || 0) < 30 * 864e5).slice(-400);
  const tasks = capTasks(mergeTaskLists(prev && prev.tasks, incomingTasks, builtAt, tombstones));
  const inJournal = (Array.isArray(inc.journal) ? inc.journal : []).slice(0, 120).map((j) => ({
    key: String(j.key || '').slice(0, 20), title: String(j.title || '').slice(0, 200), text: String(j.text || '').slice(0, 6000), ts: Number(j.ts) || 0, done: !!j.done
  }));
  const inKeys = new Set(inJournal.map((j) => j.key));
  const pendingJ = ((prev && prev.journal) || []).filter((j) => j && j.pending && !inKeys.has(j.key));
  return {
    skip: false,
    value: {
      at: Date.now(),
      rev: ((prev && Number(prev.rev)) || 0) + 1,
      builtAt: builtAt || prevBuilt || Date.now(),
      name: String(inc.name || (prev && prev.name) || 'Mo').slice(0, 60),
      projects: (Array.isArray(inc.projects) ? inc.projects : (prev && prev.projects) || []).slice(0, 50).map((p) => ({ id: String(p.id || ''), name: String(p.name || '').slice(0, 80) })),
      tasks,
      tombstones,
      journal: [...inJournal, ...pendingJ].slice(0, 120),
      disciplines: (Array.isArray(inc.disciplines) ? inc.disciplines : (prev && prev.disciplines) || []).slice(0, 60).map((d) => ({ id: String(d.id || ''), label: String(d.label || '').slice(0, 80), weight: Number(d.weight) || 0 })),
      days: flattenDays(inc.days || (prev && prev.days) || {}),
      goals: (Array.isArray(inc.goals) ? inc.goals : (prev && prev.goals) || []).slice(0, 40).map((g) => ({ id: String(g.id || ''), label: String(g.label || '').slice(0, 80), text: String(g.text || '').slice(0, 1000), targetDate: g.targetDate || '', setAt: g.setAt || '', done: !!g.done })),
      north_star: Object.prototype.hasOwnProperty.call(inc, 'north_star') ? (inc.north_star ? String(inc.north_star).slice(0, 1000) : null) : (prev ? prev.north_star || null : null),
      buy_box: Object.prototype.hasOwnProperty.call(inc, 'buy_box') ? (inc.buy_box ? String(inc.buy_box).slice(0, 1000) : null) : (prev ? prev.buy_box || null : null)
    }
  };
}

async function loadMirrorDoc() {
  const r = await fetch(`${DOC_URL}?key=${API_KEY}`);
  if (r.status === 404) return { missing: true, data: null, updateTime: null };
  if (!r.ok) throw new Error('mirror read ' + r.status);
  const j = await r.json();
  const v = (((j.fields || {}).v || {}).stringValue) || '';
  if (!v) return { missing: false, data: null, updateTime: j.updateTime || null };
  const [iv, ct] = v.split(':').map((x) => new Uint8Array(Buffer.from(x, 'base64')));
  const data = JSON.parse(new TextDecoder().decode(await subtle.decrypt({ name: 'AES-GCM', iv }, await key(), ct)));
  return { missing: false, data, updateTime: j.updateTime || null };
}

async function saveMirrorDoc(obj, updateTime) {
  const iv = rand(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, await key(), new TextEncoder().encode(JSON.stringify(obj)));
  const v = Buffer.from(iv).toString('base64') + ':' + Buffer.from(new Uint8Array(ct)).toString('base64');
  if (v.length > 900000) throw new Error('mirror too large');
  let url = `${DOC_URL}?key=${API_KEY}&updateMask.fieldPaths=v`;
  if (updateTime) url += `&currentDocument.updateTime=${encodeURIComponent(updateTime)}`;
  const w = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { v: { stringValue: v } } })
  });
  if (w.status === 409 || w.status === 412) return 'conflict';
  if (!w.ok) {
    const body = await w.text().catch(() => '');
    if (/FAILED_PRECONDITION|ABORTED|conflict/i.test(body)) return 'conflict';
    throw new Error('mirror write ' + w.status);
  }
  return 'ok';
}

// mutator returns the next document, or null to leave the current one alone.
async function updateMirror(mutator) {
  for (let i = 0; i < 6; i++) {
    const doc = await loadMirrorDoc();
    const next = await mutator(doc.data);
    if (next == null) return { data: doc.data, skipped: true };
    const status = await saveMirrorDoc(next, doc.missing ? null : doc.updateTime);
    if (status === 'ok') return { data: next, skipped: false };
  }
  throw new Error('mirror busy');
}

export async function storeMirror(obj) {
  let info = null;
  const res = await updateMirror((current) => {
    info = mergeAppSnapshot(current, obj || {});
    if (info.skip) return null;
    return info.value;
  });
  const value = info && info.skip ? info.value : res.data;
  return {
    tasks: ((value && value.tasks) || []).length,
    journal: ((value && value.journal) || []).length,
    rev: (value && value.rev) || 0,
    skipped: !!(info && info.skip)
  };
}

export async function readMirror() {
  const doc = await loadMirrorDoc();
  if (doc.missing || !doc.data) throw new Error(NO_MIRROR);
  return doc.data;
}

function presentTask(t) {
  const { ts, touchedAt, ...rest } = t;
  return rest;
}

export function tasksOf(M, { all = false } = {}) {
  const proj = Object.fromEntries((M.projects || []).map((p) => [p.id, p.name]));
  const top3 = M.top3 || [];
  const mapped = (M.tasks || []).map((t) => ({
    id: t.id,
    name: t.name,
    area: t.projectId ? proj[t.projectId] || null : null,
    priority: priorityOf(t, top3),
    today: !!t.today,
    status: t.status,
    when: t.when,
    created: iso(t.ts),
    completed: iso(t.completedAt),
    ts: Number(t.ts) || 0,
    touchedAt: Number(t.touchedAt || t.ts) || 0,
    ...(t.pending ? { pending: true } : {})
  }));
  const open = mapped.filter((t) => t.status !== 'completed');
  const groups = groupTasks(open);
  const tasks = sortTasks(all ? mapped : open).map(presentTask);
  return {
    now: groups.now.map(presentTask),
    also_now: groups.also_now.map(presentTask),
    this_week: groups.this_week.map(presentTask),
    later: groups.later.map(presentTask),
    tasks
  };
}
export function journalOf(M, { from, to, limit = 30 } = {}) {
  return (M.journal || []).filter((j) => (!from || j.key.slice(0, 10) >= from) && (!to || j.key.slice(0, 10) <= to)).sort((a, b) => b.key.localeCompare(a.key)).slice(0, limit)
    .map((j) => ({ key: j.key, date: j.key.slice(0, 10), title: j.title, text: j.text, done: j.done }));
}
export function disciplinesOf(M, days = 7) {
  const list = M.disciplines || [];
  const out = [];
  for (let i = 0; i < days; i++) {
    const k = day(new Date(Date.now() - i * 864e5));
    const disc = (M.days || {})[k] || {};
    out.push({ date: k, done: list.filter((d) => disc[d.id]).map((d) => d.label), missed: list.filter((d) => !disc[d.id]).map((d) => d.label) });
  }
  return { list, days: out, synced_at: new Date(M.at).toISOString() };
}
export function goalsOf(M) {
  return { goals: (M.goals || []).map((g) => ({ id: g.id, label: g.label, text: g.text, target_date: g.targetDate || null, set_at: g.setAt || null, done: g.done })), north_star: M.north_star, buy_box: M.buy_box };
}
export function summaryOf(M) {
  const g = tasksOf(M);
  return {
    name: M.name,
    synced_at: new Date(M.at).toISOString(),
    now: g.now.map((t) => t.name),
    also_now: g.also_now.map((t) => t.name),
    this_week: g.this_week.slice(0, 12).map((t) => t.name),
    later: g.later.length,
    open_tasks: g.tasks.length,
    disciplines_today: disciplinesOf(M, 1).days[0],
    goals: goalsOf(M).goals.filter((g) => !g.done).slice(0, 3),
    last_journal: journalOf(M, { limit: 1 }).map((j) => ({ date: j.date, title: j.title, text: clip(j.text, 400) }))[0] || null
  };
}

function findOpen(M, q, id) {
  const open = (M.tasks || []).filter((t) => t.status !== 'completed');
  if (id) { const t = open.find((x) => x.id === id); if (t) return t; }
  q = norm(q); if (!q) return null;
  let hit = open.find((t) => norm(t.name) === q) || open.find((t) => norm(t.name).includes(q) || q.includes(norm(t.name)));
  if (hit) return hit;
  const qs = q.split(' ').filter((w) => w.length > 2); let best = null, bs = 0;
  for (const t of open) { const tn = norm(t.name); const sc = qs.filter((w) => tn.includes(w)).length / Math.max(1, qs.length); if (sc > bs) { bs = sc; best = t; } }
  return bs >= 0.6 ? best : null;
}
export function nameForId(M, id) { const t = (M.tasks || []).find((x) => x.id === id); return t ? t.name : null; }

function bury(M, id, now) {
  M.tombstones = (M.tombstones || []).filter((x) => x.id !== id);
  M.tombstones.push({ id, at: now });
  if (M.tombstones.length > 400) M.tombstones = M.tombstones.slice(-400);
}

// Pure bot-side mutation of a mirror object. Returns true when it changed something.
export function applyItemsToMirror(M, items, localDay) {
  M.tasks = M.tasks || [];
  M.tombstones = M.tombstones || [];
  M.journal = M.journal || [];
  M.days = M.days || {};
  M.projects = M.projects || [];
  const now = Date.now();
  const today = localDay || new Date().toISOString().slice(0, 10);
  const proj = (a) => { const p = M.projects.find((x) => norm(x.name) === norm(a)); return p ? p.id : null; };
  let changed = false;
  for (const it of items || []) {
    const k = it.kind;
    if (!k) {
      const text = String(it.text || '').trim(); if (!text) continue;
      const priority = coercePriority(it.priority, { today: it.today, top3: it.top3 });
      const existing = M.tasks.find((t) => t.status !== 'completed' && t.name.trim().toLowerCase() === text.toLowerCase());
      if (existing) {
        if (priorityRank(priority) < priorityRank(priorityOf(existing, M.top3))) { existing.priority = priority; existing.botTouch = now; existing.touchedAt = now; changed = true; }
        continue;
      }
      const id = 'pending-' + now.toString(36) + Math.random().toString(36).slice(2, 6);
      M.tasks.push({ id, name: text, projectId: it.area ? proj(it.area) : null, today: priority === 'P1', priority, status: 'inbox', when: null, ts: now, touchedAt: now, completedAt: null, pending: true, botTouch: now });
      changed = true;
    } else if (k === 'complete') {
      for (const n of it.names || []) {
        const t = findOpen(M, n);
        if (t) { t.status = 'completed'; t.completedAt = now; t.botTouch = now; changed = true; }
      }
    } else if (k === 'delete') {
      for (const n of it.names || []) {
        const q = norm(n); if (!q) continue;
        const hits = M.tasks.filter((t) => t.status !== 'completed' && (norm(t.name) === q || norm(t.name).includes(q))).sort((a, b) => a.ts - b.ts);
        const gone = new Set((it.keep_one !== false ? hits.slice(1) : hits).map((t) => t.id));
        if (!gone.size) continue;
        gone.forEach((id) => bury(M, id, now));
        M.tasks = M.tasks.filter((t) => !gone.has(t.id));
        changed = true;
      }
    } else if (k === 'update') {
      const t = findOpen(M, it.name, it.id) || (it.id ? M.tasks.find((x) => x.id === it.id) : null); if (!t) continue;
      const st = it.set || {};
      if (typeof st.name === 'string' && st.name.trim()) t.name = st.name.trim().slice(0, 500);
      if (typeof st.area === 'string') { const p = proj(st.area); if (p) t.projectId = p; }
      if (typeof st.today === 'boolean') t.today = st.today;
      t.priority = priorityFromUpdate(st, priorityOf(t, M.top3));
      if (st.status === 'completed') { t.status = 'completed'; t.completedAt = now; }
      if (st.status === 'open' && t.status === 'completed') { t.status = 'inbox'; t.completedAt = null; }
      t.botTouch = now;
      t.touchedAt = now;
      changed = true;
    } else if (k === 'workout') {
      const re = /\b(gym|lift|lifting|work ?out|(leg|push|pull|chest|back|arm|upper|lower) day)\b/i;
      M.tasks.filter((t) => t.status !== 'completed' && re.test(t.name)).forEach((t) => { t.status = 'completed'; t.completedAt = now; t.botTouch = now; changed = true; });
    } else if (k === 'tick') {
      const d = /^\d{4}-\d{2}-\d{2}$/.test(it.date || '') ? it.date : today;
      const rec = (M.days[d] = M.days[d] || {});
      const find = (x) => { const q = String(x || '').toLowerCase().trim(); return (M.disciplines || []).find((z) => z.id === x || z.label.toLowerCase() === q) || (M.disciplines || []).find((z) => z.label.toLowerCase().includes(q)); };
      (it.done || []).forEach((x) => { const z = find(x); if (z) rec[z.id] = true; });
      (it.undone || []).forEach((x) => { const z = find(x); if (z) delete rec[z.id]; });
      changed = true;
    } else if (k === 'journal') {
      const body = String(it.text || '').trim(); if (!body) continue;
      const d = /^\d{4}-\d{2}-\d{2}$/.test(it.date || '') ? it.date : today;
      const e = M.journal.filter((j) => j.key.slice(0, 10) === d && !j.done).sort((a, b) => a.key.localeCompare(b.key)).pop();
      if (e) { e.text = (e.text ? e.text + '\n\n' : '') + body; if (!e.title && it.title) e.title = it.title; e.ts = now; }
      else { let key = d, n = 2; while (M.journal.some((j) => j.key === key)) key = d + '#' + n++; M.journal.push({ key, title: it.title || '', text: body, ts: now, done: d < today, pending: true }); }
      changed = true;
    } else if (k === 'journal_edit') {
      const i = M.journal.findIndex((j) => j.key === it.key); if (i < 0) continue;
      if (it.delete) { M.journal.splice(i, 1); changed = true; continue; }
      if (typeof it.title === 'string') M.journal[i].title = it.title;
      if (typeof it.text === 'string') M.journal[i].text = it.text;
      M.journal[i].ts = now;
      changed = true;
    }
  }
  return changed;
}

export async function applyToMirror(items, localDay) {
  let changed = false;
  const res = await updateMirror((current) => {
    if (!current) return null;
    const M = structuredClone(current);
    changed = applyItemsToMirror(M, items, localDay);
    M.rev = (Number(current.rev) || 0) + 1;
    M.at = Date.now();
    return M;
  });
  if (!res || res.skipped || !res.data) return false;
  return changed;
}
