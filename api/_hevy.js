// Hevy: recent workouts, per-exercise history and next-session targets (lbs).
const API = 'https://api.hevyapp.com/v1';
const LB = 2.20462;
const lb = (kg) => (kg == null ? null : Math.round(kg * LB * 2) / 2);

async function call(method, path, body) {
  const r = await fetch(API + path, {
    method, headers: { 'api-key': process.env.HEVY_API_KEY || '', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) throw new Error('Hevy ' + method + ' ' + path + ' ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 300));
  return r.status === 204 ? {} : r.json();
}
const get = (path) => call('GET', path);
export const getWorkout = (id) => get('/workouts/' + encodeURIComponent(id));

async function recentWorkouts(n) {
  const out = [];
  for (let page = 1; out.length < n && page <= 40; page++) {
    const d = await get(`/workouts?page=${page}&pageSize=10`);
    out.push(...(d.workouts || []));
    if (page >= (d.page_count || 1)) break;
  }
  return out.slice(0, n);
}

const isolation = /raise|fly|curl|extension|pushdown|neck|calf|shrug|face pull|kickback/i;
// Beat last time: all sets at the top of the range -> add weight, else add a rep.
function nextTarget(title, sets) {
  const work = sets.filter((s) => s.type !== 'warmup' && s.reps);
  if (!work.length) return null;
  const top = isolation.test(title) ? 12 : 10;
  const w = Math.max(...work.map((s) => s.weight_kg || 0));
  const reps = work.map((s) => s.reps);
  if (Math.min(...reps) >= top) return { weight_lb: lb(w) + (isolation.test(title) ? 2.5 : 5), reps: top - 2, why: `hit ${top}+ on every set last time, add weight` };
  return { weight_lb: lb(w), reps: reps.map((r) => r + (r === Math.min(...reps) ? 1 : 0)), why: 'same weight, one more rep on the weakest set' };
}

const fmtSets = (sets) => sets.filter((s) => s.type !== 'warmup').map((s) => (s.weight_kg ? `${lb(s.weight_kg)}x${s.reps}` : `${s.reps || s.duration_seconds + 's'}`)).join(', ');

export async function hevySummary(n = 10) {
  const ws = await recentWorkouts(Math.min(400, Math.max(1, n)));
  const history = {};
  for (const w of ws.slice().reverse()) {
    for (const e of w.exercises || []) {
      (history[e.title] = history[e.title] || []).push({ date: w.start_time.slice(0, 10), workout: w.title, sets: e.sets });
    }
  }
  const exercises = Object.entries(history).map(([title, sess]) => {
    const last = sess[sess.length - 1];
    const best = Math.max(...sess.flatMap((s) => s.sets.map((x) => (x.weight_kg || 0) * (1 + (x.reps || 0) / 30))));
    return {
      exercise: title, sessions: sess.length, last_date: last.date, last_routine: last.workout,
      last_sets_lb: fmtSets(last.sets), est_1rm_lb: best ? Math.round(best * LB) : null,
      history: sess.map((x) => {
        const work = x.sets.filter((y) => y.type !== 'warmup');
        const top = work.reduce((b, y) => ((y.weight_kg || 0) > (b.weight_kg || 0) || ((y.weight_kg || 0) === (b.weight_kg || 0) && (y.reps || 0) > (b.reps || 0)) ? y : b), work[0] || {});
        return { date: x.date, e1rm_lb: Math.round(Math.max(0, ...x.sets.map((y) => (y.weight_kg || 0) * (1 + (y.reps || 0) / 30))) * LB), top_lb: lb(top.weight_kg), top_reps: top.reps || null, sets: fmtSets(x.sets) };
      }),
      next: nextTarget(title, last.sets)
    };
  });
  return {
    units: 'lb',
    workouts: ws.map((w) => ({
      id: w.id, title: w.title, date: w.start_time.slice(0, 10), minutes: Math.round((Date.parse(w.end_time) - Date.parse(w.start_time)) / 6e4),
      exercises: (w.exercises || []).map((e) => `${e.title}: ${fmtSets(e.sets)}`)
    })),
    exercises
  };
}

// Saved routines (the plan) + when each muscle group was last trained, so a bot can call out skips.
let templates = null;
async function exerciseTemplates() {
  if (templates) return templates;
  const out = {};
  for (let page = 1; page <= 20; page++) {
    const d = await get(`/exercise_templates?page=${page}&pageSize=100`);
    for (const t of d.exercise_templates || []) out[t.id] = { title: t.title, type: t.type, custom: !!t.is_custom, primary: t.primary_muscle_group || null, secondary: t.secondary_muscle_groups || [] };
    if (page >= (d.page_count || 1)) break;
  }
  return (templates = out);
}

async function allPages(path, key) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const d = await get(`${path}?page=${page}&pageSize=10`);
    out.push(...(d[key] || []));
    if (page >= (d.page_count || 1)) break;
  }
  return out;
}

const fmtPlanned = (sets) => {
  const work = (sets || []).filter((s) => s.type !== 'warmup');
  if (!work.length) return '';
  const reps = (s) => (s.rep_range && s.rep_range.start ? `${s.rep_range.start}-${s.rep_range.end || s.rep_range.start}` : s.reps || (s.duration_seconds ? s.duration_seconds + 's' : '?'));
  const w = work.map((s) => s.weight_kg).find((x) => x);
  return `${work.length}x${reps(work[0])}${w ? ' @ ' + lb(w) + 'lb' : ''}`;
};

export async function hevyRoutines() {
  const [routines, folders, ws, tpl] = await Promise.all([
    allPages('/routines', 'routines'),
    allPages('/routine_folders', 'routine_folders').catch(() => []),
    recentWorkouts(60),
    exerciseTemplates().catch(() => ({}))
  ]);
  const folderOf = Object.fromEntries(folders.map((f) => [f.id, f]));
  const today = Date.now();
  const daysAgo = (d) => Math.floor((today - Date.parse(d)) / 864e5);
  const lastByTitle = {};
  for (const w of ws) if (!lastByTitle[w.title]) lastByTitle[w.title] = w; // ws is newest first

  const plan = routines
    .map((r) => {
      const f = folderOf[r.folder_id];
      const last = lastByTitle[r.title];
      const done = new Set(((last && last.exercises) || []).map((e) => e.exercise_template_id || e.title));
      return {
        id: r.id, routine: r.title, folder: f ? f.title : null, folder_id: r.folder_id ?? null, _order: [f ? f.index : 999, r.index ?? 0],
        last_done: last ? last.start_time.slice(0, 10) : null,
        exercises: (r.exercises || []).map((e) => ({
          exercise: e.title, planned: fmtPlanned(e.sets), muscle: (tpl[e.exercise_template_id] || {}).primary || null,
          secondary: (tpl[e.exercise_template_id] || {}).secondary || [], notes: e.notes || undefined
        })),
        skipped_last_time: last ? (r.exercises || []).filter((e) => !done.has(e.exercise_template_id) && !done.has(e.title)).map((e) => e.title) : []
      };
    })
    .sort((a, b) => a._order[0] - b._order[0] || a._order[1] - b._order[1])
    .map(({ _order, ...r }) => r);

  const muscles = {};
  for (const w of ws.slice().reverse()) {
    const date = w.start_time.slice(0, 10);
    for (const e of w.exercises || []) {
      const t = tpl[e.exercise_template_id];
      if (!t || !t.primary) continue;
      const sets = (e.sets || []).filter((s) => s.type !== 'warmup').length;
      const m = (muscles[t.primary] = muscles[t.primary] || { last_trained: null, sets_14d: 0 });
      m.last_trained = date;
      if (daysAgo(date) <= 14) m.sets_14d += sets;
    }
  }
  const planned = new Set(plan.flatMap((r) => r.exercises.map((e) => e.muscle)).filter(Boolean));
  for (const m of planned) muscles[m] = muscles[m] || { last_trained: null, sets_14d: 0 };
  const muscleList = Object.entries(muscles)
    .map(([muscle, m]) => ({ muscle, last_trained: m.last_trained, days_ago: m.last_trained ? daysAgo(m.last_trained) : null, sets_14d: m.sets_14d }))
    .sort((a, b) => (b.days_ago ?? 999) - (a.days_ago ?? 999));
  return { routines: plan, folders: folders.map((f) => ({ id: f.id, title: f.title })), muscles: muscleList };
}

// ---- Writes: log/edit workouts, create/edit routines. Bots pass exercise names and lbs; we resolve to Hevy ids and kg.
const KG = (l) => (l == null || l === '' ? null : Math.round((Number(l) / LB) * 100) / 100);
const norm = (x) => String(x || '').toLowerCase().replace(/\(.*?\)/g, (m) => ' ' + m.slice(1, -1) + ' ').replace(/[^a-z0-9]+/g, ' ').trim();

export async function findExercises(query, limit = 8) {
  const tpl = await exerciseTemplates();
  const q = norm(query).split(' ').filter(Boolean);
  return Object.entries(tpl)
    .map(([id, t]) => {
      const n = norm(t.title), words = n.split(' ');
      let score = n === q.join(' ') ? 100 : 0;
      for (const w of q) score += words.includes(w) ? 10 : n.includes(w) ? 4 : -6;
      return { id, title: t.title, muscle: t.primary, type: t.type, custom: t.custom || undefined, score: score - words.length * 0.1 };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score, ...x }) => x);
}

async function templateId(e) {
  if (e.exercise_template_id) return e.exercise_template_id;
  const name = e.exercise || e.name || e.title;
  if (!name) throw new Error('Each exercise needs a name or exercise_template_id');
  const tpl = await exerciseTemplates();
  const exact = Object.entries(tpl).find(([, t]) => norm(t.title) === norm(name));
  if (exact) return exact[0];
  const hits = await findExercises(name, 5);
  if (!hits.length) throw new Error(`No Hevy exercise matches "${name}". Use hevy_edit action=find_exercise, or create_exercise for a custom one.`);
  const words = norm(name).split(' ');
  if (words.every((w) => norm(hits[0].title).split(' ').includes(w))) return hits[0].id;
  throw new Error(`"${name}" is not an exact Hevy exercise. Closest: ${hits.map((h) => h.title).join(' | ')}. Pass the exact title or exercise_template_id.`);
}

// sets: array of {weight_lb, reps, rep_min, rep_max, type, duration_seconds, distance_meters, rpe}
// or shorthand on the exercise: sets: 3, reps: 10 | "8-10", weight_lb.
function toSets(e, forRoutine) {
  let sets = e.sets;
  if (typeof sets === 'number' || sets == null) {
    const n = Number(sets) || 1, m = String(e.reps ?? '').match(/^(\d+)\s*[-to]+\s*(\d+)$/);
    sets = Array.from({ length: n }, () => (m ? { rep_min: +m[1], rep_max: +m[2] } : { reps: e.reps }));
    if (e.weight_lb != null) sets.forEach((s) => (s.weight_lb = e.weight_lb));
  }
  return sets.map((s) => {
    const o = { type: s.type || 'normal' };
    const kg = s.weight_kg != null ? Number(s.weight_kg) : KG(s.weight_lb);
    if (kg != null) o.weight_kg = kg;
    if (s.duration_seconds != null) o.duration_seconds = Number(s.duration_seconds);
    if (s.distance_meters != null) o.distance_meters = Number(s.distance_meters);
    if (forRoutine && (s.rep_min != null || (s.rep_range && s.rep_range.start != null))) {
      const rr = s.rep_range || { start: s.rep_min, end: s.rep_max ?? s.rep_min };
      o.rep_range = { start: Number(rr.start), end: Number(rr.end ?? rr.start) };
    } else {
      const reps = s.reps ?? s.rep_max ?? s.rep_min;
      if (reps != null && reps !== '') o.reps = Number(reps);
    }
    if (!forRoutine && s.rpe != null) o.rpe = Number(s.rpe);
    return o;
  });
}

async function toExercises(list, forRoutine) {
  return Promise.all((list || []).map(async (e) => ({
    exercise_template_id: await templateId(e),
    superset_id: e.superset_id ?? null,
    ...(forRoutine ? { rest_seconds: e.rest_seconds ?? null } : {}),
    notes: e.notes || null,
    sets: toSets(e, forRoutine)
  })));
}

// Existing Hevy objects back into request shape, so partial edits keep what wasn't touched.
const keepSet = (s, forRoutine) => {
  const o = { type: s.type || 'normal' };
  for (const k of ['weight_kg', 'reps', 'distance_meters', 'duration_seconds', 'custom_metric', ...(forRoutine ? [] : ['rpe'])]) if (s[k] != null) o[k] = s[k];
  if (forRoutine && s.rep_range && s.rep_range.start != null) { o.rep_range = s.rep_range; delete o.reps; }
  return o;
};
const keepExercises = (list, forRoutine) => (list || []).map((e) => ({
  exercise_template_id: e.exercise_template_id, superset_id: e.superset_id ?? null,
  ...(forRoutine ? { rest_seconds: e.rest_seconds ?? null } : {}), notes: e.notes || null,
  sets: (e.sets || []).map((s) => keepSet(s, forRoutine))
}));

const unwrap = (d, k) => (Array.isArray(d[k]) ? d[k][0] : d[k] || d);
const brief = (x) => ({ id: x.id, title: x.title, exercises: (x.exercises || []).map((e) => `${e.title}: ${(e.sets || []).map((s) => (s.weight_kg ? lb(s.weight_kg) + 'x' : '') + (s.rep_range && s.rep_range.start ? s.rep_range.start + '-' + s.rep_range.end : s.reps ?? (s.duration_seconds ? s.duration_seconds + 's' : '?'))).join(', ')}`) });

export async function hevyEdit(a) {
  switch (a.action) {
    case 'find_exercise':
      return { matches: await findExercises(a.query || a.title || '', 10) };

    case 'get_workout': {
      const w = await getWorkout(a.id);
      return { ...brief(w), start_time: w.start_time, end_time: w.end_time, description: w.description };
    }

    case 'log_workout': {
      if (!a.exercises || !a.exercises.length) throw new Error('log_workout needs exercises');
      const end = a.end_time || new Date().toISOString();
      const start = a.start_time || new Date(Date.parse(end) - (Number(a.minutes) || 60) * 6e4).toISOString();
      const d = await call('POST', '/workouts', { workout: {
        title: a.title || 'Workout', description: a.description || null, start_time: start, end_time: end,
        is_private: !!a.is_private, exercises: await toExercises(a.exercises, false)
      } });
      return { ok: true, logged: brief(unwrap(d, 'workout')) };
    }

    case 'update_workout': {
      if (!a.id) throw new Error('update_workout needs id (from hevy workouts[].id)');
      const w = await getWorkout(a.id);
      const d = await call('PUT', '/workouts/' + encodeURIComponent(a.id), { workout: {
        title: a.title ?? w.title, description: a.description ?? w.description ?? null,
        start_time: a.start_time || w.start_time, end_time: a.end_time || w.end_time, is_private: a.is_private ?? !!w.is_private,
        exercises: a.exercises ? await toExercises(a.exercises, false) : keepExercises(w.exercises, false)
      } });
      return { ok: true, updated: brief(unwrap(d, 'workout')) };
    }

    case 'get_routine': {
      const r = unwrap(await get('/routines/' + encodeURIComponent(a.id)), 'routine');
      return { ...brief(r), folder_id: r.folder_id, notes: r.notes };
    }

    case 'create_routine': {
      if (!a.title || !a.exercises || !a.exercises.length) throw new Error('create_routine needs title and exercises');
      const d = await call('POST', '/routines', { routine: {
        title: a.title, folder_id: a.folder_id ?? null, notes: a.notes || null, exercises: await toExercises(a.exercises, true)
      } });
      return { ok: true, created: brief(unwrap(d, 'routine')) };
    }

    case 'update_routine': {
      if (!a.id) throw new Error('update_routine needs id (from hevy routines=true, routines[].id)');
      const r = unwrap(await get('/routines/' + encodeURIComponent(a.id)), 'routine');
      const d = await call('PUT', '/routines/' + encodeURIComponent(a.id), { routine: {
        title: a.title ?? r.title, notes: a.notes ?? r.notes ?? null,
        exercises: a.exercises ? await toExercises(a.exercises, true) : keepExercises(r.exercises, true)
      } });
      return { ok: true, updated: brief(unwrap(d, 'routine')) };
    }

    case 'create_folder': {
      if (!a.title) throw new Error('create_folder needs title');
      const d = await call('POST', '/routine_folders', { routine_folder: { title: a.title } });
      return { ok: true, folder: unwrap(d, 'routine_folder') };
    }

    case 'create_exercise': {
      if (!a.title) throw new Error('create_exercise needs title');
      const d = await call('POST', '/exercise_templates', { exercise: {
        title: a.title, exercise_type: a.exercise_type || 'weight_reps', equipment_category: a.equipment || 'other',
        muscle_group: a.muscle || 'other', other_muscles: a.other_muscles || []
      } });
      templates = null;
      return { ok: true, exercise: d };
    }

    default:
      throw new Error('Unknown action. Use find_exercise, get_workout, log_workout, update_workout, get_routine, create_routine, update_routine, create_folder, create_exercise.');
  }
}
