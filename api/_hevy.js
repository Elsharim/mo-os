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
