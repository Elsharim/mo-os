// A copy of the parts of MO OS the bots need (tasks, journal, disciplines,
// goals), pushed by the app itself after each save and stored in Firestore
// (poppy/osmirror:Mo) encrypted with the server-only secret, like food and
// money. Reads only; writes go through the sealed inbox so an open app tab
// never clobbers them.
import { webcrypto, createHash } from 'crypto';
const subtle = (globalThis.crypto || webcrypto).subtle;
const rand = (n) => (globalThis.crypto || webcrypto).getRandomValues(new Uint8Array(n));
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyCYCt9-opphzCOSInAaPnrGIBN8M6kWW-Y';
const DOC_URL = 'https://firestore.googleapis.com/v1/projects/poppy-sales/databases/(default)/documents/poppy/osmirror:Mo';

export const NO_MIRROR = 'MO OS has not shared a copy of its tasks and journal yet. Mo opens MO OS once on any device and it syncs within a few seconds.';

const key = () => subtle.importKey('raw', createHash('sha256').update('mirror:' + (process.env.WHOOP_STORE_SECRET || '')).digest(), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

export async function storeMirror(obj) {
  const clean = {
    at: Date.now(),
    name: String(obj.name || 'Mo').slice(0, 60),
    projects: (Array.isArray(obj.projects) ? obj.projects : []).slice(0, 50).map((p) => ({ id: String(p.id || ''), name: String(p.name || '').slice(0, 80) })),
    top3: (Array.isArray(obj.top3) ? obj.top3 : []).slice(0, 3).map(String),
    tasks: (Array.isArray(obj.tasks) ? obj.tasks : []).slice(0, 600).map((t) => ({
      id: String(t.id || ''), name: String(t.name || '').slice(0, 500), projectId: t.projectId ? String(t.projectId) : null, today: !!t.today, status: String(t.status || 'inbox'), when: t.when || null, ts: Number(t.ts) || 0, completedAt: Number(t.completedAt) || null, ...(t.pending ? { pending: true } : {})
    })),
    journal: (Array.isArray(obj.journal) ? obj.journal : []).slice(0, 120).map((j) => ({ key: String(j.key || '').slice(0, 20), title: String(j.title || '').slice(0, 200), text: String(j.text || '').slice(0, 6000), ts: Number(j.ts) || 0, done: !!j.done, ...(j.pending ? { pending: true } : {}) })),
    disciplines: (Array.isArray(obj.disciplines) ? obj.disciplines : []).slice(0, 60).map((d) => ({ id: String(d.id || ''), label: String(d.label || '').slice(0, 80), weight: Number(d.weight) || 0 })),
    days: Object.fromEntries(Object.entries(obj.days || {}).slice(-60).map(([k, v]) => [String(k).slice(0, 10), Object.fromEntries(Object.entries((v && v.disc) || {}).filter(([, on]) => on).map(([id]) => [String(id), true]))])),
    goals: (Array.isArray(obj.goals) ? obj.goals : []).slice(0, 40).map((g) => ({ id: String(g.id || ''), label: String(g.label || '').slice(0, 80), text: String(g.text || '').slice(0, 1000), targetDate: g.targetDate || '', setAt: g.setAt || '', done: !!g.done })),
    north_star: obj.north_star ? String(obj.north_star).slice(0, 1000) : null,
    buy_box: obj.buy_box ? String(obj.buy_box).slice(0, 1000) : null
  };
  const iv = rand(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, await key(), new TextEncoder().encode(JSON.stringify(clean)));
  const v = Buffer.from(iv).toString('base64') + ':' + Buffer.from(new Uint8Array(ct)).toString('base64');
  if (v.length > 900000) throw new Error('mirror too large');
  const r = await fetch(`${DOC_URL}?key=${API_KEY}&updateMask.fieldPaths=v`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { v: { stringValue: v } } }) });
  if (!r.ok) throw new Error('mirror write ' + r.status);
  return { tasks: clean.tasks.length, journal: clean.journal.length, bytes: v.length };
}

export async function readMirror() {
  const r = await fetch(`${DOC_URL}?key=${API_KEY}`);
  if (r.status === 404) throw new Error(NO_MIRROR);
  if (!r.ok) throw new Error('mirror read ' + r.status);
  const v = (((await r.json()).fields || {}).v || {}).stringValue;
  if (!v) throw new Error(NO_MIRROR);
  const [iv, ct] = v.split(':').map((x) => new Uint8Array(Buffer.from(x, 'base64')));
  return JSON.parse(new TextDecoder().decode(await subtle.decrypt({ name: 'AES-GCM', iv }, await key(), ct)));
}

const day = (d = new Date()) => d.toISOString().slice(0, 10);
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const iso = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);

export function tasksOf(M, { all = false } = {}) {
  const proj = Object.fromEntries((M.projects || []).map((p) => [p.id, p.name]));
  const top3 = M.top3 || [];
  return (M.tasks || [])
    .filter((t) => all || t.status !== 'completed')
    .sort((a, b) => (top3.includes(b.id) - top3.includes(a.id)) || (b.today - a.today) || (b.ts - a.ts))
    .map((t) => ({ id: t.id, name: t.name, area: t.projectId ? proj[t.projectId] || null : null, today: t.today, top3: top3.includes(t.id), status: t.status, when: t.when, created: iso(t.ts), completed: iso(t.completedAt), ...(t.pending ? { pending: true } : {}) }));
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
  const tasks = tasksOf(M);
  return {
    name: M.name,
    synced_at: new Date(M.at).toISOString(),
    top3: tasks.filter((t) => t.top3).map((t) => t.name),
    today_tasks: tasks.filter((t) => t.today && !t.top3).map((t) => t.name),
    open_tasks: tasks.length,
    disciplines_today: disciplinesOf(M, 1).days[0],
    goals: goalsOf(M).goals.filter((g) => !g.done).slice(0, 3),
    last_journal: journalOf(M, { limit: 1 }).map((j) => ({ date: j.date, title: j.title, text: clip(j.text, 400) }))[0] || null
  };
}

/* Apply the same changes the app will apply from the inbox to the server copy
   right away, so bots read their own changes instantly. The app overwrites
   this copy with the real state the next time it saves. */
const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
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
export async function applyToMirror(items, localDay) {
  let M;
  try { M = await readMirror(); } catch (_) { return false; }
  M.tasks = M.tasks || []; M.top3 = M.top3 || []; M.journal = M.journal || []; M.days = M.days || {};
  const now = Date.now(), day = localDay || new Date().toISOString().slice(0, 10);
  const proj = (a) => { const p = (M.projects || []).find((x) => norm(x.name) === norm(a)); return p ? p.id : null; };
  for (const it of items) {
    const k = it.kind;
    if (!k) { // add task
      const text = String(it.text || '').trim(); if (!text) continue;
      if (M.tasks.some((t) => t.status !== 'completed' && t.name.trim().toLowerCase() === text.toLowerCase())) continue;
      const id = 'pending-' + now.toString(36) + Math.random().toString(36).slice(2, 6);
      M.tasks.push({ id, name: text, projectId: it.area ? proj(it.area) : null, today: !!it.today, status: 'inbox', when: null, ts: now, completedAt: null, pending: true });
      if (it.today && M.top3.length < 3) M.top3.push(id);
    } else if (k === 'complete') {
      for (const n of it.names || []) { const t = findOpen(M, n); if (t) { t.status = 'completed'; t.completedAt = now; M.top3 = M.top3.filter((x) => x !== t.id); } }
    } else if (k === 'delete') {
      for (const n of it.names || []) {
        const q = norm(n); if (!q) continue;
        const hits = M.tasks.filter((t) => t.status !== 'completed' && (norm(t.name) === q || norm(t.name).includes(q))).sort((a, b) => a.ts - b.ts);
        const gone = new Set((it.keep_one !== false ? hits.slice(1) : hits).map((t) => t.id));
        M.tasks = M.tasks.filter((t) => !gone.has(t.id)); M.top3 = M.top3.filter((x) => !gone.has(x));
      }
    } else if (k === 'update') {
      const t = findOpen(M, it.name, it.id) || (it.id ? M.tasks.find((x) => x.id === it.id) : null); if (!t) continue;
      const st = it.set || {};
      if (typeof st.name === 'string' && st.name.trim()) t.name = st.name.trim().slice(0, 500);
      if (typeof st.area === 'string') { const p = proj(st.area); if (p) t.projectId = p; }
      if (typeof st.today === 'boolean') t.today = st.today;
      if (typeof st.top3 === 'boolean') { const on = M.top3.includes(t.id); if (st.top3 && !on && M.top3.length < 3) M.top3.push(t.id); if (!st.top3 && on) M.top3 = M.top3.filter((x) => x !== t.id); }
      if (st.status === 'completed') { t.status = 'completed'; t.completedAt = now; M.top3 = M.top3.filter((x) => x !== t.id); }
      if (st.status === 'open' && t.status === 'completed') { t.status = 'inbox'; t.completedAt = null; }
    } else if (k === 'workout') {
      const re = /\b(gym|lift|lifting|work ?out|(leg|push|pull|chest|back|arm|upper|lower) day)\b/i;
      M.tasks.filter((t) => t.status !== 'completed' && re.test(t.name)).forEach((t) => { t.status = 'completed'; t.completedAt = now; });
    } else if (k === 'tick') {
      const d = /^\d{4}-\d{2}-\d{2}$/.test(it.date || '') ? it.date : day;
      const rec = (M.days[d] = M.days[d] || {});
      const find = (x) => { const q = String(x || '').toLowerCase().trim(); return (M.disciplines || []).find((z) => z.id === x || z.label.toLowerCase() === q) || (M.disciplines || []).find((z) => z.label.toLowerCase().includes(q)); };
      (it.done || []).forEach((x) => { const z = find(x); if (z) rec[z.id] = true; });
      (it.undone || []).forEach((x) => { const z = find(x); if (z) delete rec[z.id]; });
    } else if (k === 'journal') {
      const body = String(it.text || '').trim(); if (!body) continue;
      const d = /^\d{4}-\d{2}-\d{2}$/.test(it.date || '') ? it.date : day;
      const e = M.journal.filter((j) => j.key.slice(0, 10) === d && !j.done).sort((a, b) => a.key.localeCompare(b.key)).pop();
      if (e) { e.text = (e.text ? e.text + '\n\n' : '') + body; if (!e.title && it.title) e.title = it.title; e.ts = now; }
      else { let key = d, n = 2; while (M.journal.some((j) => j.key === key)) key = d + '#' + n++; M.journal.push({ key, title: it.title || '', text: body, ts: now, done: d < day, pending: true }); }
    } else if (k === 'journal_edit') {
      const i = M.journal.findIndex((j) => j.key === it.key); if (i < 0) continue;
      if (it.delete) { M.journal.splice(i, 1); continue; }
      if (typeof it.title === 'string') M.journal[i].title = it.title;
      if (typeof it.text === 'string') M.journal[i].text = it.text;
      M.journal[i].ts = now;
    }
  }
  const pend = { at: M.at, tasks: M.tasks, journal: M.journal };
  await storeMirror({ ...M, days: Object.fromEntries(Object.entries(M.days).map(([k, v]) => [k, { disc: v }])) });
  return pend;
}
