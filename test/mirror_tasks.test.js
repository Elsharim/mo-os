import test from 'node:test';
import assert from 'node:assert/strict';
import { priOf, tasksOf, summaryOf } from '../api/_mirror.js';

const task = (id, name, extra = {}) => ({ id, name, status: 'inbox', ts: extra.ts || 1, ...extra });

test('priOf reads P1, P2, P3 and the same digits', () => {
  assert.equal(priOf('P1'), 1);
  assert.equal(priOf('p2'), 2);
  assert.equal(priOf(3), 3);
  assert.equal(priOf('P3'), 3);
  assert.equal(priOf('none'), 0);
  assert.equal(priOf(null), 0);
  assert.equal(priOf(undefined), 0);
  assert.equal(priOf(''), 0);
  assert.equal(priOf('P4'), 0);
  assert.equal(priOf(0), 0);
});

test('tasksOf is a flat list sorted by priority, then newest', () => {
  const out = tasksOf({
    at: Date.parse('2026-10-22T12:00:00Z'),
    projects: [{ id: 'sales', name: 'Sales' }],
    tasks: [
      task('old', 'starred legacy', { pri: 1, ts: 10, projectId: 'sales' }),
      task('w', 'weekly', { pri: 2, ts: 20 }),
      task('w2', 'newer week', { pri: 2, ts: 40 }),
      task('l', 'later', { pri: 3, ts: 30 }),
      task('none', 'unsorted', { pri: null, ts: 50 }),
      task('done', 'respond to pete', { pri: 2, status: 'completed', ts: 5, completedAt: 6 })
    ]
  });
  assert.deepEqual(out.map((t) => t.id), ['old', 'w2', 'w', 'l', 'none']);
  assert.equal(out[0].priority, 'P1');
  assert.equal(out[0].area, 'Sales');
  assert.equal(out[0].created, '1970-01-01');
  assert.equal(out.find((t) => t.id === 'none').priority, null);
  assert.equal(out.some((t) => t.name === 'respond to pete'), false);
});

test('tasksOf all=true keeps completed tasks after open ones', () => {
  const out = tasksOf({
    tasks: [
      task('done', 'respond to pete', { pri: 1, status: 'completed', ts: 9, completedAt: Date.parse('2026-10-21T00:00:00Z') }),
      task('open', 'weekly', { pri: 3, ts: 1 })
    ]
  }, { all: true });
  assert.deepEqual(out.map((t) => t.id), ['open', 'done']);
  assert.equal(out[1].priority, 'P1');
  assert.equal(out[1].completed, '2026-10-21');
});

test('pending bot adds stay marked pending', () => {
  const out = tasksOf({
    tasks: [task('pending-1', 'Research Christian\'s agency', { pri: 2, pending: true, ts: 8 })]
  });
  assert.equal(out[0].pending, true);
  assert.equal(out[0].priority, 'P2');
});

test('summaryOf reports P1 today, P2 this week, and the open count', () => {
  const s = summaryOf({
    at: Date.parse('2026-10-22T12:00:00Z'),
    name: 'Mo',
    projects: [],
    tasks: [
      task('a', 'Fix MO OS goals', { pri: 1, ts: 1 }),
      task('b', 'Figure out content automation', { pri: 2, ts: 2 }),
      task('c', 'Research Christian\'s agency', { pri: 3, ts: 3 }),
      task('d', 'respond to pete', { pri: 1, status: 'completed', ts: 4, completedAt: 5 })
    ],
    disciplines: [],
    days: {},
    goals: [{ id: 'g', label: '90-day', text: 'Ship it', targetDate: '', setAt: '', done: false }],
    journal: [],
    north_star: null,
    buy_box: null
  });
  assert.deepEqual(s.p1_today, ['Fix MO OS goals']);
  assert.deepEqual(s.p2_this_week, ['Figure out content automation']);
  assert.equal(s.open_tasks, 3);
  assert.equal(s.name, 'Mo');
  assert.equal(s.goals.length, 1);
});

test('a task with no pri stays unsorted', () => {
  const out = tasksOf({ tasks: [task('n', 'write about why')] });
  assert.equal(out[0].priority, null);
});
