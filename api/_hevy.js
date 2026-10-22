// Hevy: recent workouts, per-exercise history and next-session targets (lbs).
const API = 'https://api.hevyapp.com/v1';
const LB = 2.20462;
const lb = (kg) => (kg == null ? null : Math.round(kg * LB * 2) / 2);

async function get(path) {
  const r = await fetch(API + path, { headers: { 'api-key': process.env.HEVY_API_KEY || '' } });
  if (!r.ok) throw new Error('Hevy ' + path + ' ' + r.status);
  return r.json();
}
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
      title: w.title, date: w.start_time.slice(0, 10), minutes: Math.round((Date.parse(w.end_time) - Date.parse(w.start_time)) / 6e4),
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
    for (const t of d.exercise_templates || []) out[t.id] = { primary: t.primary_muscle_group || null, secondary: t.secondary_muscle_groups || [] };
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
        routine: r.title, folder: f ? f.title : null, _order: [f ? f.index : 999, r.index ?? 0],
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
  return { routines: plan, muscles: muscleList };
}
