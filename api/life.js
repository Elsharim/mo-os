// /api/life?view=today -> sleep, recovery, calls, food so far (Morning strip)
// /api/life?view=body  -> weight, sleep, recovery and lift trends (Body page)
// Auth: the device's media secret (set at PIN unlock) or the connector token.
import { createHmac, timingSafeEqual } from 'crypto';
import { whoopSummary } from './_whoop.js';
import { healthSummary, localDateISO, mondayOf } from './_health.js';
import { hevySummary } from './_hevy.js';
import { calendarToday, storePushed, queueAdd, queuePending, queueAck } from './_cal.js';
import { moneySummary } from './_money.js';
import { callsSummary } from './_work.js';
import { leaveNote, readNotes } from './_notes.js';
import { isConnected as gcalConnected, createEvent as gcalCreate, deleteEvent as gcalDelete } from './_gcal.js';
import { storeMirror, readMirror } from './_mirror.js';

function eq(a, b) { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return y.length > 0 && x.length === y.length && timingSafeEqual(x, y); }
function authed(req) {
  const pepper = process.env.MOOS_PEPPER || '';
  const media = pepper ? createHmac('sha256', pepper).update('mo-os-media-v1').digest('hex') : '';
  const h = String(req.headers.authorization || '');
  const bearer = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  return eq(req.headers['x-moos-secret'], media) || eq(bearer, process.env.MOOS_MCP_TOKEN);
}
const safe = (p) => p.catch((e) => ({ error: String((e && e.message) || e) }));

// Small read-only summary for the iPhone widget. Its own token (WIDGET_TOKEN) can only read this.
async function glance() {
  const [whoop, food, hevy, work, M] = await Promise.all([safe(whoopSummary(2)), safe(healthSummary(1)), safe(hevySummary(30)), safe(callsSummary(7)), readMirror().catch(() => null)]);
  const tz = (whoop && !whoop.error && whoop.tz_offset) || '+02:00';
  const cal = await safe(calendarToday(tz));
  const today = localDateISO(), mon = mondayOf(today);
  const ws = (hevy && hevy.workouts) || [];
  const week = ws.filter((w) => w.date >= mon && w.date <= today);
  const plan = food && food.food_plan && food.food_plan.today;
  const T = (food && food.targets) || {};
  const ev = cal && !cal.error ? cal.events : [];
  const next = ev.find((e) => !e.past && !/^busy$|sleep|lights out/i.test(e.title)) || null;
  const mins = next ? Math.round((Date.parse(next.start_iso) - Date.now()) / 6e4) : null;
  const tasks = M && M.tasks ? M.tasks.filter((t) => t.status !== 'completed') : [];
  const now = tasks.filter((t) => t.pri === 1 || t.pri === '1').map((t) => t.name);
  const c = work && !work.error ? work.today : null;
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(Date.parse(mon + 'T12:00:00Z') + i * 864e5).toISOString().slice(0, 10); return { date: d, gym: ws.some((w) => w.date === d), future: d > today }; });
  const supp = !!(M && M.days && M.days[today] && (M.days[today].supplements || M.days[today]['supplements']));
  return {
    at: new Date().toISOString(), date: today,
    next: next ? { title: next.title, time: next.start, in_min: mins } : null,
    calls: { booked: ev.length ? ev.filter((e) => !/lunch|dinner|break|gym|sleep|busy/i.test(e.title)).length : 0, left: ev.filter((e) => !e.past && !/lunch|dinner|break|gym|sleep|busy/i.test(e.title)).length, taken: c ? c.showed : null },
    food: { cal: plan ? plan.calories : 0, cal_target: plan ? plan.adjusted_daily_target : (T.calories || 3000), protein: plan ? plan.protein : 0, protein_target: plan ? plan.protein_target : (T.protein || 150) },
    gym: { week: week.length, target: T.workouts_per_week || 5, today: week.some((w) => w.date === today), last: ws[0] ? ws[0].date : null, days },
    supps: supp,
    now: now.slice(0, 4), now_count: now.length,
    events: ev.filter((e) => !/^busy$|sleep|lights out/i.test(e.title)).slice(0, 10).map((e) => ({ title: e.title, time: e.start, past: !!e.past }))
  };
}

export default async function handler(req, res) {
  const view0 = req.query.view;
  if (view0 === 'glance') {
    const h = String(req.headers.authorization || ''); const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : String(req.query.key || '');
    if (!(eq(tok, process.env.WIDGET_TOKEN) || authed(req))) { res.status(401).json({ error: 'Unauthorized' }); return; }
    res.setHeader('Cache-Control', 'no-store');
    try { res.status(200).json(await glance()); } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
    return;
  }
  // Apps Script side: fetch pending calendar writes / ack them
  if (view0 === 'calendar_queue' || view0 === 'calendar_ack') {
    const h = String(req.headers.authorization || '');
    if (!eq(h.startsWith('Bearer ') ? h.slice(7).trim() : String(req.query.key || ''), process.env.CAL_PUSH_TOKEN)) { res.status(401).json({ error: 'Unauthorized' }); return; }
    try {
      if (view0 === 'calendar_queue') { res.status(200).json({ items: await queuePending() }); return; }
      let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch (_) { body = {}; } }
      await queueAck(Array.isArray(body && body.ids) ? body.ids : []);
      res.status(200).json({ ok: true });
    } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
    return;
  }
  // App side: a copy of tasks, journal, disciplines and goals for the bots
  if (req.method === 'POST' && view0 === 'mirror') {
    if (!authed(req)) { res.status(401).json({ error: 'Unauthorized' }); return; }
    let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch (_) { body = {}; } }
    try { res.status(200).json({ ok: true, ...(await storeMirror(body || {})) }); }
    catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
    return;
  }
  // App side: schedule a task (create) or unschedule it (delete)
  if (req.method === 'POST' && view0 === 'schedule') {
    if (!authed(req)) { res.status(401).json({ error: 'Unauthorized' }); return; }
    let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch (_) { body = {}; } }
    body = body || {};
    try {
      const title = String(body.title || '').trim().slice(0, 200);
      const start = Date.parse(body.start_iso), end = Date.parse(body.end_iso);
      if (!title || isNaN(start)) { res.status(400).json({ error: 'title and start_iso needed' }); return; }
      if (await gcalConnected().catch(() => false)) {
        // Google Calendar is linked directly: do it now, no queue
        if (body.action === 'delete') { res.status(200).json({ ok: true, removed: await gcalDelete({ title, start_iso: new Date(start).toISOString() }), via: 'google' }); return; }
        const id = await gcalCreate({ title, start_iso: new Date(start).toISOString(), end_iso: new Date(isNaN(end) ? start + 30 * 6e4 : end).toISOString() });
        res.status(200).json({ ok: true, id, via: 'google' }); return;
      }
      const item = await queueAdd(body.action === 'delete'
        ? { action: 'delete', title, start_iso: new Date(start).toISOString() }
        : { action: 'create', title, start_iso: new Date(start).toISOString(), end_iso: new Date(isNaN(end) ? start + 30 * 6e4 : end).toISOString() });
      res.status(200).json({ ok: true, id: item.id });
    } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
    return;
  }
  if (req.method === 'POST' && req.query.view === 'calendar') {
    // pushed by the Google Apps Script in Mo's account
    const h = String(req.headers.authorization || '');
    if (!eq(h.startsWith('Bearer ') ? h.slice(7).trim() : String(req.query.key || ''), process.env.CAL_PUSH_TOKEN)) { res.status(401).json({ error: 'Unauthorized' }); return; }
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch (_) { body = {}; } }
    try { res.status(200).json({ ok: true, saved: await storePushed((body || {}).events) }); }
    catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
    return;
  }
  if (!authed(req)) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const view = req.query.view || 'today';
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (view === 'today') {
      const [whoop, food, work] = await Promise.all([safe(whoopSummary(2)), safe(healthSummary(1)), safe(callsSummary(7))]);
      const tz = (whoop && whoop.tz_offset) || null;
      const cal = await safe(calendarToday(tz));
      const t = whoop && whoop.today;
      const todayFood = food && food.days && food.days[0];
      res.status(200).json({
        tz_offset: tz,
        sleep: t && t.sleep ? { bed: t.sleep.bed && t.sleep.bed.time, woke: t.sleep.woke && t.sleep.woke.time, woke_date: t.sleep.woke && t.sleep.woke.date, hours: t.sleep.asleep_h, performance: t.sleep.performance } : null,
        recovery: t && t.recovery ? t.recovery.score : null,
        hrv: t && t.recovery ? t.recovery.hrv : null,
        rhr: t && t.recovery ? t.recovery.rhr : null,
        calendar: cal && !cal.error ? cal : null,
        food: food && !food.error ? {
          date: (food.food_plan && food.food_plan.as_of) || (todayFood && todayFood.date),
          calories: food.food_plan ? food.food_plan.today.calories : ((todayFood && todayFood.calories) || 0),
          protein: food.food_plan ? food.food_plan.today.protein : ((todayFood && todayFood.protein) || 0),
          targets: food.targets,
          plan: food.food_plan || null
        } : null,
        calls: work && !work.error ? { today: work.today, yesterday: work.yesterday, week: work.this_week } : null,
        whoop_connected: !!(whoop && !whoop.error)
      });
      return;
    }
    if (view === 'body') {
      const span = Math.min(370, Math.max(7, Number(req.query.days) || 30));
      const [whoop, food, hevy] = await Promise.all([safe(whoopSummary(span)), safe(healthSummary(span)), safe(hevySummary(400))]);
      if (whoop && whoop.error) whoop.sleep = whoop.recovery = whoop.strain = whoop.workouts = [];
      const weights = (food.days || []).filter((d) => d.weight_lb).map((d) => ({ date: d.date, lb: d.weight_lb })).reverse();
      if (!weights.length && whoop && whoop.weight_kg) weights.push({ date: new Date().toISOString().slice(0, 10), lb: Math.round(whoop.weight_kg * 22.0462) / 10, from: 'whoop' });
      const days = food.days || [];
      res.status(200).json({
        goal_lb: (food.targets && food.targets.goal_weight_lb) || 170,
        weights,
        sleep: ((whoop && whoop.sleep) || []).map((s) => ({ date: s.woke && s.woke.date, hours: s.asleep_h, in_bed: s.in_bed_h, bed: s.bed && s.bed.time, woke: s.woke && s.woke.time, deep: s.deep_h, rem: s.rem_h, performance: s.performance, consistency: s.consistency })).reverse(),
        recovery: ((whoop && whoop.recovery) || []).map((r) => ({ date: r.date, score: r.score, hrv: r.hrv, rhr: r.rhr })).reverse(),
        strain: ((whoop && whoop.strain) || []).map((c) => ({ date: c.date, strain: c.strain, calories: c.calories })).reverse(),
        food: days.filter((d) => d.calories).map((d) => ({ date: d.date, calories: d.calories, protein: d.protein || 0, carbs: d.carbs || 0, fat: d.fat || 0 })).reverse(),
        food_today: days[0] && days[0].foods ? { date: days[0].date, items: days[0].foods.slice(-20) } : null,
        saved_meals: food.saved_meals || [],
        targets: food.targets || null,
        food_plan: food.food_plan || null,
        lifts: hevy && hevy.exercises ? hevy.exercises.filter((e) => e.sessions >= 2 && e.est_1rm_lb >= 40).sort((a, b) => b.last_date.localeCompare(a.last_date) || b.sessions - a.sessions).slice(0, 24)
          .map((e) => ({ exercise: e.exercise, sessions: e.sessions, history: e.history, last: e.last_sets_lb, last_date: e.last_date, est_1rm_lb: e.est_1rm_lb, next: e.next })) : [],
        workouts: hevy && hevy.workouts ? hevy.workouts.map((w) => ({ date: w.date, title: w.title, minutes: w.minutes, exercises: w.exercises })) : [],
        whoop_workouts: ((whoop && whoop.workouts) || []).map((w) => ({ date: w.date, sport: w.sport, minutes: w.minutes, strain: w.strain }))
      });
      return;
    }
    if (view === 'week') {
      // Per-day facts for the Daily page: sleep, gym, cardio, food, weight, calls, plus payouts
      const [whoop, food, hevy, work, money] = await Promise.all([safe(whoopSummary(16)), safe(healthSummary(16)), safe(hevySummary(60)), safe(callsSummary(16)), safe(moneySummary(60))]);
      const days = {}; const D = (k) => (days[k] = days[k] || { date: k });
      ((whoop && whoop.sleep) || []).forEach((x) => { const k = x.woke && x.woke.date; if (k) { const d = D(k); d.sleep_h = x.asleep_h; d.bed = x.bed && x.bed.time; } });
      ((whoop && whoop.workouts) || []).forEach((w) => { if (!w.date) return; const d = D(w.date); if (/weight|strength|lift|powerlift/i.test(w.sport || '')) d.lift = true; else d.cardio = (d.cardio || []).concat(w.sport || 'cardio'); });
      ((food && food.days) || []).forEach((x) => { const d = D(x.date); if (x.calories) d.calories = x.calories; if (x.protein) d.protein = x.protein; if (x.weight_lb) d.weight_lb = x.weight_lb; });
      ((hevy && hevy.workouts) || []).forEach((w) => { if (w.date) D(w.date).gym = true; });
      ((work && work.recent) || []).forEach((x) => { const d = D(x.date); d.calls = x.showed; d.booked = x.booked; });
      const payouts = (((money && money.tax) || {}).payouts || []).map((p) => ({ date: p.date, cad: p.cad, amount: p.amount, currency: p.currency }));
      res.status(200).json({ targets: (food && food.targets) || null, days, payouts });
      return;
    }
    if (view === 'notes') {
      // Claude's side of the notepad (Bearer token only)
      if (req.method === 'POST') {
        let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch (_) { body = {}; } }
        res.status(200).json(await leaveNote({ from: 'claude', to: 'grok', text: (body || {}).text, topic: (body || {}).topic })); return;
      }
      res.status(200).json({ notes: await readNotes({ to: 'claude', unread_only: req.query.all ? false : true, mark_read: !req.query.peek }) }); return;
    }
    if (view === 'money') { res.status(200).json(await moneySummary(Math.min(400, Number(req.query.days) || 90))); return; }
    res.status(404).json({ error: 'Unknown view' });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
