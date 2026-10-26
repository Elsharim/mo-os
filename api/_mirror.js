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
    outcomes: (Array.isArray(obj.outcomes) ? obj.outcomes : []).slice(0, 80).map((o) => ({ id: String(o.id || ''), name: String(o.name || '').slice(0, 120), areaId: o.areaId ? String(o.areaId) : null, nextId: o.nextId ? String(o.nextId) : null, ask: !!o.ask, done: !!o.done, ts: Number(o.ts) || 0, ...(o.pending ? { pending: true } : {}) })),
    tasks: (Array.isArray(obj.tasks) ? obj.tasks : []).slice(0, 600).map((t) => ({
      id: String(t.id || ''), name: String(t.name || '').slice(0, 500), projectId: t.projectId ? String(t.projectId) : null, outcomeId: t.outcomeId ? String(t.outcomeId) : null, today: !!t.today, pri: priOf(t.pri) || null, status: String(t.status || 'inbox'), when: t.when || null, ts: Number(t.ts) || 0, completedAt: Number(t.completedAt) || null, ...(t.pending ? { pending: true } : {})
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

// P1 = do today, P2 = this week, P3 = someday
export const priOf = (v) => { const n = parseInt(String(v == null ? '' : v).replace(/^p/i, ''), 10); return [1, 2, 3].includes(n) ? n : 0; };
const day = (d = new Date()) => d.toISOString().slice(0, 10);
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const iso = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);

// Projects are outcomes (M.outcomes); M.projects are life areas. A project shows one next action:
// nextId when it's open, else its oldest open task, none while it waits for Mo to set one (ask).
export function nextActionOf(M, o) {
  if (!o || o.done || o.ask) return null;
  const open = (M.tasks || []).filter((t) => t.outcomeId === o.id && t.status !== 'completed');
  return open.find((t) => t.id === o.nextId) || open.sort((a, b) => a.ts - b.ts)[0] || null;
}
export function projectsOf(M) {
  const area = Object.fromEntries((M.projects || []).map((p) => [p.id, p.name]));
  const tasks = M.tasks || [];
  return {
    projects: (M.outcomes || []).filter((o) => !o.done).map((o) => {
      const nx = nextActionOf(M, o);
      return { id: o.id, name: o.name, area: o.areaId ? area[o.areaId] || null : null, next_action: nx ? nx.name : null, next_action_id: nx ? nx.id : null, needs_next_action: !nx, open_tasks: tasks.filter((t) => t.outcomeId === o.id && t.status !== 'completed').length, done_tasks: tasks.filter((t) => t.outcomeId === o.id && t.status === 'completed').length, ...(o.pending ? { pending: true } : {}) };
    }),
    loose_tasks: tasks.filter((t) => t.status !== 'completed' && !(M.outcomes || []).some((o) => o.id === t.outcomeId && !o.done)).length
  };
}
export function tasksOf(M, { all = false } = {}) {
  const proj = Object.fromEntries((M.projects || []).map((p) => [p.id, p.name]));
  const outc = Object.fromEntries((M.outcomes || []).filter((o) => !o.done).map((o) => [o.id, o]));
  const nexts = new Set(Object.values(outc).map((o) => (nextActionOf(M, o) || {}).id).filter(Boolean));
  const rank = (t) => t.pri || 4;
  return (M.tasks || [])
    .filter((t) => all || t.status !== 'completed')
    .sort((a, b) => ((a.status === 'completed') - (b.status === 'completed')) || (rank(a) - rank(b)) || (b.ts - a.ts))
    .map((t) => ({ id: t.id, name: t.name, area: t.projectId ? proj[t.projectId] || null : null, project: outc[t.outcomeId] ? outc[t.outcomeId].name : null, next_action: nexts.has(t.id), priority: t.pri ? 'P' + t.pri : null, status: t.status, when: t.when, created: iso(t.ts), completed: iso(t.completedAt), ...(t.pending ? { pending: true } : {}) }));
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
    p1_today: tasks.filter((t) => t.priority === 'P1').map((t) => t.name),
    p2_this_week: tasks.filter((t) => t.priority === 'P2').map((t) => t.name),
    open_tasks: tasks.length,
    projects: projectsOf(M).projects.map((p) => ({ name: p.name, next_action: p.next_action, needs_next_action: p.needs_next_action })),
    disciplines_today: disciplinesOf(M, 1).days[0],
    goals: goalsOf(M).goals.filter((g) => !g.done).slice(0, 3),
    last_journal: journalOf(M, { limit: 1 }).map((j) => ({ date: j.date, title: j.title, text: clip(j.text, 400) }))[0] || null
  };
}

/* Apply the same changes the app will apply from the inbox to the server copy
   right away, so bots read their own changes instantly. The app overwrites
   this copy with the real state the next time it saves. */
// "MO OS: fix the goals page" -> project MO OS, task "Fix the goals page" (same rule as the app)
export function splitProject(text) {
  const m = /^\s*([^:\n]{2,40}?)\s*:\s+(\S[\s\S]*)$/.exec(String(text || ''));
  if (!m || /^https?$/i.test(m[1]) || /^\d/.test(m[1]) || m[1].trim().split(/\s+/).length > 5) return null;
  return { project: m[1].trim(), name: m[2].charAt(0).toUpperCase() + m[2].slice(1) };
}
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
  M.tasks = M.tasks || []; M.journal = M.journal || []; M.days = M.days || {};
  const now = Date.now(), day = localDay || new Date().toISOString().slice(0, 10);
  const proj = (a) => { const p = (M.projects || []).find((x) => norm(x.name) === norm(a)); return p ? p.id : null; };
  M.outcomes = M.outcomes || [];
  const outcome = (name, areaId) => {
    let o = M.outcomes.find((x) => !x.done && norm(x.name) === norm(name));
    if (!o) { o = { id: 'pending-o' + now.toString(36) + Math.random().toString(36).slice(2, 6), name: String(name).trim().slice(0, 120), areaId: areaId || null, nextId: null, ask: true, done: false, ts: now, pending: true }; M.outcomes.push(o); }
    return o;
  };
  const setOutcome = (t, name) => {
    const old = M.outcomes.find((x) => x.id === t.outcomeId); if (old && old.nextId === t.id) old.nextId = null;
    if (!name || /^none$/i.test(name)) { t.outcomeId = null; return; }
    const o = outcome(name, t.projectId); const take = o.ask || !nextActionOf(M, o);
    t.outcomeId = o.id; if (take) { o.nextId = t.id; o.ask = false; }
  };
  const done = (t) => {
    const o = M.outcomes.find((x) => x.id === t.outcomeId);
    const wasNext = o && (nextActionOf(M, o) || {}).id === t.id;
    t.status = 'completed'; t.completedAt = now;
    if (wasNext) { o.nextId = null; o.ask = true; }
  };
  for (const it of items) {
    const k = it.kind;
    if (!k) { // add task
      let text = String(it.text || '').trim(); if (!text) continue;
      let pj = String(it.project || '').trim(); if (/^none$/i.test(pj)) pj = '';
      if (!pj) { const sp = splitProject(text); if (sp) { pj = sp.project; text = sp.name; } }
      if (M.tasks.some((t) => t.status !== 'completed' && t.name.trim().toLowerCase() === text.toLowerCase())) continue;
      const id = 'pending-' + now.toString(36) + Math.random().toString(36).slice(2, 6);
      const t = { id, name: text, projectId: it.area ? proj(it.area) : null, outcomeId: null, today: false, pri: priOf(it.priority) || (it.today ? 1 : null), status: 'inbox', when: null, ts: now, completedAt: null, pending: true };
      M.tasks.push(t);
      if (pj) { setOutcome(t, pj); if (it.next_action === true) { const o = M.outcomes.find((x) => x.id === t.outcomeId); o.nextId = t.id; o.ask = false; } }
    } else if (k === 'complete') {
      for (const n of it.names || []) { const t = findOpen(M, n); if (t) done(t); }
    } else if (k === 'delete') {
      for (const n of it.names || []) {
        const q = norm(n); if (!q) continue;
        const hits = M.tasks.filter((t) => t.status !== 'completed' && (norm(t.name) === q || norm(t.name).includes(q))).sort((a, b) => a.ts - b.ts);
        const gone = new Set((it.keep_one !== false ? hits.slice(1) : hits).map((t) => t.id));
        M.tasks = M.tasks.filter((t) => !gone.has(t.id));
      }
    } else if (k === 'update') {
      const t = findOpen(M, it.name, it.id) || (it.id ? M.tasks.find((x) => x.id === it.id) : null); if (!t) continue;
      const st = it.set || {};
      if (typeof st.name === 'string' && st.name.trim()) t.name = st.name.trim().slice(0, 500);
      if (typeof st.area === 'string') { const p = proj(st.area); if (p) t.projectId = p; }
      if (typeof st.project === 'string') setOutcome(t, st.project.trim());
      if (st.next_action === true && t.outcomeId) { const o = M.outcomes.find((x) => x.id === t.outcomeId); if (o) { o.nextId = t.id; o.ask = false; } }
      if (typeof st.today === 'boolean') t.today = st.today;
      if (st.priority !== undefined) t.pri = priOf(st.priority) || null;
      if (st.status === 'completed' && t.status !== 'completed') done(t);
      if (st.status === 'open' && t.status === 'completed') { t.status = 'inbox'; t.completedAt = null; }
    } else if (k === 'workout') {
      const re = /\b(gym|lift|lifting|work ?out|(leg|push|pull|chest|back|arm|upper|lower) day)\b/i;
      M.tasks.filter((t) => t.status !== 'completed' && re.test(t.name)).forEach(done);
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
