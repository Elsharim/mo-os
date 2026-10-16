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
      id: String(t.id || ''), name: String(t.name || '').slice(0, 500), projectId: t.projectId ? String(t.projectId) : null, today: !!t.today, status: String(t.status || 'inbox'), when: t.when || null, ts: Number(t.ts) || 0, completedAt: Number(t.completedAt) || null
    })),
    journal: (Array.isArray(obj.journal) ? obj.journal : []).slice(0, 120).map((j) => ({ key: String(j.key || '').slice(0, 20), title: String(j.title || '').slice(0, 200), text: String(j.text || '').slice(0, 6000), ts: Number(j.ts) || 0, done: !!j.done })),
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
    .map((t) => ({ id: t.id, name: t.name, area: t.projectId ? proj[t.projectId] || null : null, today: t.today, top3: top3.includes(t.id), status: t.status, when: t.when, created: iso(t.ts), completed: iso(t.completedAt) }));
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
