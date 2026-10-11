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

test('adjusted target ignores today, skips unlogged in the average, and caps a binge', () => {
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
  assert.equal(plan.today.adjusted_daily_target_raw, 6000);
  assert.equal(plan.today.adjusted_daily_target, 3000 + ADJUST_HEADROOM);
  assert.equal(plan.today.clamped, true);
  assert.match(plan.today.note, /cramming/);
  assert.match(plan.today.note, /unlogged/);
  assert.equal(plan.week.avg_daily_calories, 3000);
  assert.equal(plan.week.completed_logged_days, 5);
  assert.equal(plan.week.unlogged_days, 1);
  assert.deepEqual(plan.week.unlogged_dates, ['2026-10-08']);
  assert.equal(plan.week.calories, 15900);
  assert.equal(plan.week.remaining, 5100);
  assert.equal(plan.week.pace, 'on_pace');
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
  assert.equal(behind.today.adjusted_daily_target_raw, 3167);
  assert.equal(behind.today.adjusted_daily_target, 3167);
  assert.equal(behind.today.clamped, false);
  assert.equal(behind.week.pace, 'behind');
  assert.equal(behind.week.avg_daily_calories, 2000);

  const ahead = buildFoodPlan({ '2026-10-05': food(6000, 200) }, {}, '2026-10-06');
  assert.equal(ahead.today.adjusted_daily_target_raw, 2500);
  assert.equal(ahead.today.adjusted_daily_target, 3000);
  assert.equal(ahead.today.clamped, true);
  assert.match(ahead.today.note, /stays at your 3,000 base/);
  assert.equal(ahead.week.days.find((d) => d.date === '2026-10-05').protein_hit, true);
  assert.equal(ahead.week.pace, 'ahead');
});

test('Monday with nothing logged is the base, and last week is kept', () => {
  const days = { '2026-10-05': food(2800, 140), '2026-10-06': food(3200, 180) };
  const plan = buildFoodPlan(days, {}, '2026-10-12');
  assert.equal(plan.week.week_start, '2026-10-12');
  assert.equal(plan.today.adjusted_daily_target, 3000);
  assert.equal(plan.week.pace, 'no_completed_days');
  assert.equal(plan.recent_weeks.length, 2);
  assert.equal(plan.recent_weeks[1].week_start, '2026-10-05');
  assert.equal(plan.recent_weeks[1].calories, 6000);
  assert.equal(plan.recent_weeks[1].adjusted_daily_target, null);
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
