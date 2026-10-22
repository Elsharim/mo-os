import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyItemsToMirror, coercePriority, groupTasks, mergeAppSnapshot, mergeTaskLists,
  NOW_CAP, priorityFromUpdate, priorityOf, sortTasks, tasksOf
} from '../api/_mirror.js';

const task = (id, name, extra = {}) => ({ id, name, priority: 'P2', status: 'inbox', ts: extra.ts || 1, touchedAt: extra.touchedAt || extra.ts || 1, ...extra });

test('legacy top3 migrates to P1, everything else P2', () => {
  assert.equal(priorityOf({ id: 'a' }, ['a']), 'P1');
  assert.equal(priorityOf({ id: 'b' }, ['a']), 'P2');
  assert.equal(priorityOf({ id: 'a', priority: 'P3' }, ['a']), 'P3');
});

test('priority input: explicit wins, legacy true maps to P1, default P2', () => {
  assert.equal(coercePriority(undefined, {}), 'P2');
  assert.equal(coercePriority('p1', { today: false }), 'P1');
  assert.equal(coercePriority('', { top3: true }), 'P1');
  assert.equal(coercePriority('', { today: true }), 'P1');
  assert.equal(coercePriority('P3', { today: true, top3: true }), 'P3');
  assert.equal(priorityFromUpdate({ top3: false, today: false }, 'P1'), 'P1');
  assert.equal(priorityFromUpdate({ top3: true }, 'P3'), 'P1');
  assert.equal(priorityFromUpdate({ priority: 'P2', top3: true }, 'P3'), 'P2');
  assert.equal(priorityFromUpdate({ name: 'renamed' }, 'P1'), 'P1');
});

test('lists sort by priority, then oldest first', () => {
  const sorted = sortTasks([
    task('c', 'later', { priority: 'P3', ts: 1 }),
    task('b', 'new now', { priority: 'P1', ts: 50 }),
    task('a', 'old now', { priority: 'P1', ts: 10 }),
    task('d', 'week', { priority: 'P2', ts: 5 })
  ]);
  assert.deepEqual(sorted.map((t) => t.id), ['a', 'b', 'd', 'c']);
});

test('Now stays short: P1 first, overdue and untouched bubble up, cap is 5', () => {
  const now = Date.parse('2026-10-22T20:00:00Z');
  const tasks = [
    ...Array.from({ length: 7 }, (_, i) => task('p' + i, 'urgent ' + i, { priority: 'P1', ts: i + 1 })),
    task('late', 'missed call', { priority: 'P3', ts: 1, when: '2026-10-22T18:00:00Z' }),
    task('stale', 'sitting there', { priority: 'P2', ts: now - 5 * 864e5, touchedAt: now - 5 * 864e5 }),
    task('fresh', 'this week', { priority: 'P2', ts: now - 3600e3, touchedAt: now - 3600e3 }),
    task('someday', 'buy sweaters', { priority: 'P3', ts: 3 }),
    task('ancient', 'forgotten', { priority: 'P2', ts: now - 20 * 864e5, touchedAt: now - 20 * 864e5 })
  ];
  const g = groupTasks(tasks, now);
  assert.equal(NOW_CAP, 5);
  assert.equal(g.now.length, 5);
  assert.equal(g.now[0].id, 'late');
  assert.equal(g.now[0].surfaced, 'overdue');
  assert.equal(g.now.filter((t) => t.priority === 'P1').length, 4);
  assert.equal(g.also_now.length, 3);
  assert.equal(g.now.some((t) => t.id === 'stale'), false);
  assert.equal(g.this_week.some((t) => t.id === 'fresh'), true);
  assert.equal(g.this_week.some((t) => t.id === 'ancient'), true);
  assert.equal(g.later.some((t) => t.id === 'someday'), true);
  assert.equal(g.later.some((t) => t.id === 'late'), false);
  const ids = [...g.now, ...g.also_now, ...g.this_week, ...g.later].map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('untouched P2 fills an empty Now, and is not also listed this week', () => {
  const now = Date.parse('2026-10-22T20:00:00Z');
  const g = groupTasks([
    task('s', 'Figure out content automation', { ts: now - 4 * 864e5, touchedAt: now - 4 * 864e5 })
  ], now);
  assert.equal(g.now.length, 1);
  assert.equal(g.now[0].surfaced, 'untouched');
  assert.equal(g.this_week.length, 0);
});

test('a fresh app snapshot replaces the stale bot copy', () => {
  const prev = {
    builtAt: 1000,
    rev: 2,
    tasks: [
      task('pete', 'respond to pete'),
      task('why', 'write about why')
    ]
  };
  const incoming = {
    builtAt: 5000,
    name: 'Mo',
    projects: [],
    tasks: [
      task('c1', 'Figure out content automation', { ts: 4000, touchedAt: 4000 }),
      task('c2', 'Research Christian\'s agency', { ts: 4100, touchedAt: 4100 }),
      task('c3', 'Fix MO OS goals', { ts: 4200, touchedAt: 4200 }),
      task('c4', 'Fix Grok bot and MO OS', { ts: 4300, touchedAt: 4300 }),
      task('c5', 'Figure out signing up for multiple platforms', { ts: 4400, touchedAt: 4400 }),
      task('c6', 'Research content automation agency', { ts: 4500, touchedAt: 4500 })
    ],
    journal: [], disciplines: [], days: {}, goals: []
  };
  const merged = mergeAppSnapshot(prev, incoming);
  assert.equal(merged.skip, false);
  const names = merged.value.tasks.map((t) => t.name);
  assert.equal(names.includes('respond to pete'), false);
  assert.equal(names.includes('write about why'), false);
  assert.equal(names.includes('Figure out content automation'), true);
  assert.equal(names.includes('Fix MO OS goals'), true);
  assert.equal(merged.value.tasks.length, 6);
});

test('a slow older snapshot cannot put deleted tasks back or drop newer ones', () => {
  const current = {
    builtAt: 9000,
    rev: 4,
    tasks: [task('c1', 'Figure out content automation', { ts: 4000, touchedAt: 4000 })]
  };
  const stale = {
    builtAt: 1000,
    tasks: [task('pete', 'respond to pete'), task('why', 'write about why')]
  };
  const merged = mergeAppSnapshot(current, stale);
  assert.equal(merged.skip, true);
  assert.equal(merged.value.tasks.length, 1);
  assert.equal(merged.value.tasks[0].name, 'Figure out content automation');
});

test('pending bot adds survive until the app has them, then are not duplicated', () => {
  const pending = task('pending-1', 'Research Christian\'s agency', { pending: true, ts: 8000, touchedAt: 8000, botTouch: 8000 });
  const kept = mergeTaskLists([], [pending], 1000, []);
  const again = mergeAppSnapshot({ builtAt: 1000, tasks: kept, rev: 1 }, {
    builtAt: 9000,
    tasks: [task('real', 'Research Christian\'s agency', { ts: 8500, touchedAt: 8500 })],
    journal: [], disciplines: [], days: {}, goals: [], projects: []
  });
  assert.equal(again.value.tasks.length, 1);
  assert.equal(again.value.tasks[0].id, 'real');

  const stillPending = mergeAppSnapshot({ builtAt: 1000, tasks: [pending], rev: 1 }, {
    builtAt: 9000,
    tasks: [task('other', 'Get an electrician', { ts: 2000, touchedAt: 2000 })],
    journal: [], disciplines: [], days: {}, goals: [], projects: []
  });
  assert.equal(stillPending.value.tasks.some((t) => t.id === 'pending-1'), true);
});

test('a bot completion is not resurrected by an older app copy', () => {
  const prev = {
    builtAt: 2000,
    rev: 3,
    tasks: [task('pete', 'respond to pete', { status: 'completed', completedAt: 8000, botTouch: 8000, touchedAt: 8000 })]
  };
  const incoming = {
    builtAt: 9000,
    tasks: [task('pete', 'respond to pete', { touchedAt: 1000, ts: 1000 })],
    journal: [], disciplines: [], days: {}, goals: [], projects: []
  };
  const merged = mergeAppSnapshot(prev, incoming);
  assert.equal(merged.value.tasks[0].status, 'completed');
});

test('the app can reopen a task it touched after the bot completed it', () => {
  const prev = {
    builtAt: 2000,
    tasks: [task('pete', 'respond to pete', { status: 'completed', completedAt: 8000, botTouch: 8000 })]
  };
  const incoming = {
    builtAt: 12000,
    tasks: [task('pete', 'respond to pete', { touchedAt: 11000, ts: 1000 })],
    journal: [], disciplines: [], days: {}, goals: [], projects: []
  };
  const merged = mergeAppSnapshot(prev, incoming);
  assert.equal(merged.value.tasks[0].status, 'inbox');
});

test('a bot delete stays deleted when the app snapshot is older than the tombstone', () => {
  const now = Date.now();
  const prev = { builtAt: now - 10000, tombstones: [{ id: 'why', at: now - 1000 }], tasks: [] };
  const incoming = {
    builtAt: now - 500,
    tasks: [task('why', 'write about why', { touchedAt: now - 5000, ts: now - 5000 })],
    journal: [], disciplines: [], days: {}, goals: [], projects: []
  };
  const merged = mergeAppSnapshot(prev, incoming);
  assert.equal(merged.value.tasks.length, 0);
});

test('open tasks are kept when the mirror is full of old completed ones', () => {
  const done = Array.from({ length: 590 }, (_, i) => task('d' + i, 'done ' + i, { status: 'completed', completedAt: i, ts: i }));
  const open = Array.from({ length: 20 }, (_, i) => task('o' + i, 'open ' + i, { priority: 'P1', ts: 10000 + i }));
  const merged = mergeAppSnapshot(null, {
    builtAt: 5,
    tasks: [...done, ...open],
    journal: [], disciplines: [], days: {}, goals: [], projects: []
  });
  assert.equal(merged.value.tasks.length, 600);
  assert.equal(merged.value.tasks.filter((t) => t.status !== 'completed').length, 20);
});

test('bot adds, completes, and deletes update the mirror copy in place', () => {
  const M = { tasks: [task('pete', 'respond to pete', { ts: 1 }), task('pete2', 'respond to pete', { ts: 2 }), task('why', 'write about why')], top3: ['why'], projects: [{ id: 'sales', name: 'Sales' }] };
  applyItemsToMirror(M, [{ text: 'Figure out content automation', priority: 'P1' }], '2026-10-22');
  assert.equal(M.tasks.some((t) => t.name === 'Figure out content automation' && t.priority === 'P1' && t.pending), true);
  applyItemsToMirror(M, [{ text: 'write about why', priority: 'P3' }], '2026-10-22');
  assert.notEqual(M.tasks.find((t) => t.name === 'write about why').priority, 'P3');
  applyItemsToMirror(M, [{ text: 'Get an electrician' }], '2026-10-22');
  applyItemsToMirror(M, [{ text: 'Get an electrician', priority: 'P1' }], '2026-10-22');
  assert.equal(M.tasks.find((t) => t.name === 'Get an electrician').priority, 'P1');
  applyItemsToMirror(M, [{ kind: 'complete', names: ['respond to pete'] }], '2026-10-22');
  assert.equal(M.tasks.filter((t) => t.name === 'respond to pete' && t.status === 'completed').length, 1);
  applyItemsToMirror(M, [{ kind: 'delete', names: ['write about why'], keep_one: false }], '2026-10-22');
  assert.equal(M.tasks.some((t) => t.name === 'write about why'), false);
  assert.equal(M.tombstones.some((t) => t.id === 'why'), true);
  applyItemsToMirror(M, [{ kind: 'update', name: 'Figure out content automation', set: { top3: true } }], '2026-10-22');
  assert.equal(M.tasks.find((t) => t.name === 'Figure out content automation').priority, 'P1');
});

test('list_tasks shape is grouped and carries priority', () => {
  const out = tasksOf({
    at: Date.parse('2026-10-22T12:00:00Z'),
    projects: [{ id: 'sales', name: 'Sales' }],
    top3: ['old'],
    tasks: [
      { id: 'old', name: 'starred legacy', status: 'inbox', ts: 10, projectId: 'sales' },
      { id: 'w', name: 'weekly', priority: 'P2', status: 'inbox', ts: 20 },
      { id: 'l', name: 'later', priority: 'P3', status: 'inbox', ts: 30 },
      { id: 'done', name: 'respond to pete', priority: 'P2', status: 'completed', ts: 5, completedAt: 6 }
    ]
  });
  assert.equal(out.now[0].name, 'starred legacy');
  assert.equal(out.now[0].priority, 'P1');
  assert.equal(out.now[0].area, 'Sales');
  assert.equal(out.this_week[0].name, 'weekly');
  assert.equal(out.later[0].name, 'later');
  assert.equal(out.tasks.some((t) => t.name === 'respond to pete'), false);
  assert.equal(out.tasks[0].priority, 'P1');
});
