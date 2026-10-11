import test from 'node:test';
import assert from 'node:assert/strict';
import { addIsoDays, buildFoodPlan, localDateISO, mondayOf, resolveTargets, ADJUST_HEADROOM } from '../api/_health.js';

const food = (calories, protein, extra = {}) => ({ calories, protein, foods: [{ name: 'meal', calories, protein, estimated: true }], ...extra });

test('defaults: 3,000 base, 21,000 week, 150 protein, 145 to 170', () => {
  const t = resolveTargets({});
  assert.equal(t.calories, 3000);
  assert.equal(t.protein, 150);
  assert.equal(t.weekly_calories, 21000);
  assert.equal(t.start_weight_lb, 145);
  assert.equal(t.goal_weight_lb, 170);
  assert.equal(t.weekly_gain_lb, 0.4);
});

test('weekly target follows 7 × base unless one is stored', () => {
  assert.equal(resolveTargets({ calories: 3200 }).weekly_calories, 22400);
  assert.equal(resolveTargets({ calories: 3200, weekly_calories: 20000 }).weekly_calories, 20000);
});

test('Europe/Sarajevo local date, including the DST change', () => {
  assert.equal(localDateISO(new Date('2026-10-11T21:59:00Z')), '2026-10-11');
  assert.equal(localDateISO(new Date('2026-10-11T22:00:00Z')), '2026-10-12');
  assert.equal(localDateISO(new Date('2026-11-01T22:59:00Z')), '2026-11-01');
  assert.equal(localDateISO(new Date('2026-11-01T23:00:00Z')), '2026-11-02');
});

test('weeks start Monday', () => {
  assert.equal(mondayOf('2026-10-11'), '2026-10-05');
  assert.equal(mondayOf('2026-10-05'), '2026-10-05');
  assert.equal(mondayOf('2026-10-12'), '2026-10-12');
});

test('adjusted target ignores today and prorates when a completed day is unlogged', () => {
  const days = {
    '2026-10-05': food(2800, 140),
    '2026-10-06': food(3200, 160),
    '2026-10-07': food(3100, 155),
    '2026-10-09': food(2500, 120),
    '2026-10-10': food(3400, 170, { weight_lb: 145.2 }),
    '2026-10-11': food(900, 40)
  };
  const plan = buildFoodPlan(days, {}, '2026-10-11');
  assert.equal(plan.today.calories, 900);
  assert.equal(plan.today.status, 'partial');
  assert.equal(plan.today.protein, 40);
  assert.equal(plan.today.protein_hit, false);
  assert.equal(plan.today.protein_remaining, 110);
  assert.equal(plan.today.base_target, 3000);
  assert.equal(plan.week.eaten_before_today, 15000);
  assert.equal(plan.today.provisional, true);
  assert.equal(plan.week.provisional, true);
  assert.equal(plan.week.weekly_goal, 21000);
  assert.equal(plan.week.budget, 18000);
  assert.equal(plan.today.budget, 18000);
  assert.equal(plan.today.adjusted_daily_target_raw, 3000);
  assert.equal(plan.today.adjusted_daily_target, 3000);
  assert.equal(plan.today.clamped, false);
  assert.match(plan.today.note, /1 day unlogged, target based on logged days only/);
  assert.equal(plan.week.avg_daily_calories, 3000);
  assert.equal(plan.week.completed_logged_days, 5);
  assert.equal(plan.week.unlogged_days, 1);
  assert.deepEqual(plan.week.unlogged_dates, ['2026-10-08']);
  assert.equal(plan.week.calories, 15900);
  assert.equal(plan.week.remaining, 2100);
  assert.equal(plan.week.pace, 'on_pace');
  assert.match(plan.week.pace_note, /pace based on logged days only/);
  const thu = plan.week.days.find((d) => d.date === '2026-10-08');
  assert.equal(thu.status, 'unlogged');
  assert.equal(thu.calories, null);
  const sun = plan.week.days.find((d) => d.date === '2026-10-11');
  assert.equal(sun.status, 'partial');
  assert.equal(sun.protein_hit, null);
  assert.equal(plan.week.days.find((d) => d.date === '2026-10-05').protein_hit, false);
  assert.equal(plan.week.days.find((d) => d.date === '2026-10-06').protein_hit, true);
  assert.equal(plan.today.estimated, true);
  assert.equal(plan.bulk.latest_weight_lb, 145.2);
  assert.equal(plan.bulk.gained_lb, 0.2);
  assert.equal(plan.bulk.remaining_lb, 24.8);
  assert.equal(plan.bulk.progress_pct, 0.8);

  const withoutToday = buildFoodPlan({ ...days, '2026-10-11': { weight_lb: 145 } }, {}, '2026-10-11');
  assert.equal(withoutToday.today.adjusted_daily_target_raw, plan.today.adjusted_daily_target_raw);
  assert.equal(withoutToday.today.logged, false);
  assert.equal(withoutToday.today.calories, 0);
});

test('a low completed day raises the next target, and a high day does not drop it under the base', () => {
  const behind = buildFoodPlan({ '2026-10-05': food(2000, 100) }, {}, '2026-10-06');
  assert.equal(behind.today.provisional, false);
  assert.equal(behind.week.budget, 21000);
  assert.equal(behind.today.adjusted_daily_target_raw, 3167);
  assert.equal(behind.today.adjusted_daily_target, 3167);
  assert.equal(behind.today.clamped, false);
  assert.equal(behind.week.pace, 'behind');
  assert.equal(behind.week.avg_daily_calories, 2000);

  const ahead = buildFoodPlan({ '2026-10-05': food(6000, 200) }, {}, '2026-10-06');
  assert.equal(ahead.today.provisional, false);
  assert.equal(ahead.week.budget, 21000);
  assert.equal(ahead.today.adjusted_daily_target_raw, 2500);
  assert.equal(ahead.today.adjusted_daily_target, 3000);
  assert.equal(ahead.today.clamped, true);
  assert.match(ahead.today.note, /stays at your 3,000 base/);
  assert.equal(ahead.week.days.find((d) => d.date === '2026-10-05').protein_hit, true);
  assert.equal(ahead.week.pace, 'ahead');
});

test('an all-logged binge still uses the full weekly goal and caps the day', () => {
  const days = {};
  for (let i = 0; i < 6; i++) days[addIsoDays('2026-10-05', i)] = food(1000, 40);
  const plan = buildFoodPlan(days, {}, '2026-10-11');
  assert.equal(plan.today.provisional, false);
  assert.equal(plan.week.budget, 21000);
  assert.equal(plan.week.weekly_goal, 21000);
  assert.equal(plan.today.adjusted_daily_target_raw, 15000);
  assert.equal(plan.today.adjusted_daily_target, 3000 + ADJUST_HEADROOM);
  assert.equal(plan.today.clamped, true);
  assert.match(plan.today.note, /cramming/);
  assert.equal(plan.week.pace, 'behind');
});

test('unlogged Mon–Thu with 5,290 on Fri–Sat prorates Sunday instead of the full 21,000', () => {
  const days = {
    '2026-10-09': food(3000, 150),
    '2026-10-10': food(2290, 110)
  };
  const plan = buildFoodPlan(days, {}, '2026-10-11');
  assert.equal(plan.today.provisional, true);
  assert.equal(plan.week.provisional, true);
  assert.equal(plan.week.unlogged_days, 4);
  assert.deepEqual(plan.week.unlogged_dates, ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']);
  assert.equal(plan.week.completed_logged_days, 2);
  assert.equal(plan.week.eaten_before_today, 5290);
  assert.equal(plan.week.weekly_goal, 21000);
  assert.equal(plan.week.budget, 9000);
  assert.equal(plan.today.budget, 9000);
  assert.equal(plan.today.adjusted_daily_target_raw, 3710);
  assert.equal(plan.today.adjusted_daily_target, 3700);
  assert.equal(plan.today.clamped, true);
  assert.match(plan.today.note, /4 days unlogged, target based on logged days only/);
  assert.equal(plan.week.calories, 5290);
  assert.equal(plan.week.remaining, 3710);
  assert.equal(plan.week.over, 0);
  assert.equal(plan.week.pace, 'behind');
  assert.equal(plan.week.pace_delta_cal, -710);
  assert.match(plan.week.pace_note, /pace based on logged days only/);

  const eating = buildFoodPlan({ ...days, '2026-10-11': food(800, 30) }, {}, '2026-10-11');
  assert.equal(eating.today.adjusted_daily_target_raw, 3710);
  assert.equal(eating.today.adjusted_daily_target, 3700);
  assert.equal(eating.week.calories, 6090);
  assert.equal(eating.week.remaining, 2910);
});

test('Monday with nothing logged is the base, and last week is kept', () => {
  const days = { '2026-10-05': food(2800, 140), '2026-10-06': food(3200, 180) };
  const plan = buildFoodPlan(days, {}, '2026-10-12');
  assert.equal(plan.week.week_start, '2026-10-12');
  assert.equal(plan.today.provisional, false);
  assert.equal(plan.today.adjusted_daily_target, 3000);
  assert.equal(plan.week.budget, 21000);
  assert.equal(plan.week.pace, 'no_completed_days');
  assert.equal(plan.recent_weeks.length, 2);
  assert.equal(plan.recent_weeks[1].week_start, '2026-10-05');
  assert.equal(plan.recent_weeks[1].calories, 6000);
  assert.equal(plan.recent_weeks[1].weekly_goal, 21000);
  assert.equal(plan.recent_weeks[1].provisional, true);
  assert.equal(plan.recent_weeks[1].budget, 6000);
  assert.equal(plan.recent_weeks[1].remaining, 0);
  assert.equal(plan.recent_weeks[1].adjusted_daily_target, null);
  assert.match(plan.recent_weeks[1].adjusted_note, /unlogged, target based on logged days only/);
  assert.equal(plan.recent_weeks[1].days.find((d) => d.date === '2026-10-05').protein_hit, false);
  assert.equal(plan.recent_weeks[1].days.find((d) => d.date === '2026-10-06').protein_hit, true);
});

test('a weight-only day is not a food log, and history is capped', () => {
  const days = { '2026-08-01': { weight_lb: 146 }, '2026-10-06': food(3000, 150) };
  const plan = buildFoodPlan(days, {}, '2026-10-07');
  assert.equal(plan.recent_weeks.length, 1);
  assert.equal(plan.bulk.latest_weight_lb, 146);
  assert.equal(plan.week.days.find((d) => d.date === '2026-10-05').status, 'unlogged');
  assert.equal(plan.week.avg_daily_calories, 3000);

  const old = {};
  for (let i = 0; i < 30; i++) old[addIsoDays('2026-10-05', -7 * i)] = food(3000, 150);
  const long = buildFoodPlan(old, {}, '2026-10-11');
  assert.equal(long.recent_weeks.length, 26);
  assert.equal(long.recent_weeks[0].current, true);
  assert.equal(long.recent_weeks.at(-1).week_start, addIsoDays('2026-10-05', -7 * 25));
  const gapped = buildFoodPlan({ '2026-09-14': food(3000, 150), '2026-10-05': food(2800, 140) }, {}, '2026-10-11');
  const starts = gapped.recent_weeks.map((w) => w.week_start);
  assert.deepEqual(starts, ['2026-10-05', '2026-09-14']);
});

test('MacroFactor totals are logged, not estimates, and an explicit zero is not unlogged', () => {
  const plan = buildFoodPlan({
    '2026-10-05': { calories: 3100, protein: 150 },
    '2026-10-06': { calories: 0, protein: 0 }
  }, {}, '2026-10-07');
  assert.equal(plan.week.days[0].estimated, false);
  assert.equal(plan.week.days[0].status, 'logged');
  assert.equal(plan.week.days[1].calories, 0);
  assert.equal(plan.week.days[1].status, 'logged');
  assert.equal(plan.week.avg_daily_calories, 1550);
});
