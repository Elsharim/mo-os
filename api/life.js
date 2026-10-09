// /api/life?view=today -> sleep, recovery, calls, food so far (Morning strip)
// /api/life?view=body  -> weight, sleep, recovery and lift trends (Body page)
// Auth: the device's media secret (set at PIN unlock) or the connector token.
import { createHmac, timingSafeEqual } from 'crypto';
import { whoopSummary } from './_whoop.js';
import { healthSummary } from './_health.js';
import { hevySummary } from './_hevy.js';
import { calendarToday, storePushed } from './_cal.js';

function eq(a, b) { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return y.length > 0 && x.length === y.length && timingSafeEqual(x, y); }
function authed(req) {
  const pepper = process.env.MOOS_PEPPER || '';
  const media = pepper ? createHmac('sha256', pepper).update('mo-os-media-v1').digest('hex') : '';
  const h = String(req.headers.authorization || '');
  const bearer = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  return eq(req.headers['x-moos-secret'], media) || eq(bearer, process.env.MOOS_MCP_TOKEN);
}
const safe = (p) => p.catch((e) => ({ error: String((e && e.message) || e) }));

export default async function handler(req, res) {
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
      const [whoop, food] = await Promise.all([safe(whoopSummary(2)), safe(healthSummary(1))]);
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
        food: food && !food.error ? { date: todayFood && todayFood.date, calories: (todayFood && todayFood.calories) || 0, protein: (todayFood && todayFood.protein) || 0, targets: food.targets } : null,
        whoop_connected: !!(whoop && !whoop.error)
      });
      return;
    }
    if (view === 'body') {
      const [whoop, food, hevy] = await Promise.all([safe(whoopSummary(30)), safe(healthSummary(90)), safe(hevySummary(30))]);
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
        lifts: hevy && hevy.exercises ? hevy.exercises.filter((e) => e.sessions >= 2 && e.est_1rm_lb >= 40).sort((a, b) => b.last_date.localeCompare(a.last_date) || b.sessions - a.sessions).slice(0, 10)
          .map((e) => ({ exercise: e.exercise, sessions: e.sessions, history: e.history, last: e.last_sets_lb, last_date: e.last_date, est_1rm_lb: e.est_1rm_lb, next: e.next })) : [],
        workouts: hevy && hevy.workouts ? hevy.workouts.map((w) => ({ date: w.date, title: w.title, minutes: w.minutes, exercises: w.exercises })) : [],
        whoop_workouts: ((whoop && whoop.workouts) || []).map((w) => ({ date: w.date, sport: w.sport, minutes: w.minutes, strain: w.strain }))
      });
      return;
    }
    res.status(404).json({ error: 'Unknown view' });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
