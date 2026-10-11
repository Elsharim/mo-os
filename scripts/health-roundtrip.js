// Posts a sample Health Auto Export payload into the ingest endpoint (in-memory
// Firestore) and reads it back through the health MCP tool. No network.
import { createHmac } from 'crypto';

process.env.WHOOP_STORE_SECRET = 'test-whoop-store-secret';
process.env.MOOS_MCP_TOKEN = 'test-mcp-token';
process.env.HEALTH_TOKEN = 'test-health-token';

const docs = new Map();
globalThis.fetch = async (url, opts = {}) => {
  const id = String(url).match(/documents\/poppy\/([^?]+)/)?.[1];
  if (!id) return { ok: false, status: 500, json: async () => ({}) };
  const method = opts.method || 'GET';
  if (method === 'GET') {
    if (!docs.has(id)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ fields: { v: { stringValue: docs.get(id) } } }) };
  }
  if (method === 'PATCH') {
    const body = JSON.parse(opts.body);
    docs.set(id, body.fields.v.stringValue);
    return { ok: true, status: 200, json: async () => ({}) };
  }
  return { ok: false, status: 400, json: async () => ({}) };
};

const { default: healthHandler } = await import('../api/health.js');
const { default: mcpHandler } = await import('../api/mcp.js');
const { calendarDate } = await import('../api/_apple.js');

const fails = [];
const check = (cond, msg) => {
  if (cond) console.log('ok', msg);
  else { console.error('FAIL', msg); fails.push(msg); }
};

function mockRes() {
  return {
    statusCode: 0,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader() {},
    end() {}
  };
}

async function postHealth(body, headers = {}, method = 'POST') {
  const res = mockRes();
  await healthHandler({ method, headers, body, query: {} }, res);
  return res;
}

async function rpc(msg, token = process.env.MOOS_MCP_TOKEN) {
  const res = mockRes();
  await mcpHandler({
    method: 'POST',
    headers: token ? { authorization: 'Bearer ' + token } : {},
    body: msg,
    query: {}
  }, res);
  return res;
}

async function readHealth(days = 7) {
  const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'health', arguments: { days } } });
  check(res.statusCode === 200 && res.body && res.body.result && !res.body.result.isError, 'health tool ok');
  return JSON.parse(res.body.result.content[0].text);
}

const sample = {
  data: {
    metrics: [
      {
        name: 'step_count', units: 'count',
        data: [
          { date: '2026-10-09 23:00:00 -0700', qty: 111 },
          { date: '2026-10-10 00:00:00 +0200', qty: '1,000' },
          { date: '2026-10-11 00:00:00 +0200', qty: 2500.4 },
          { date: '2026-10-11 12:00:00 +0200', qty: 500 },
          { date: 'not-a-date', qty: 99999 }
        ]
      },
      { name: 'active_energy', units: 'kJ', data: [{ date: '2026-10-11 00:00:00 +0200', qty: 418.4 }] },
      { name: 'walking_running_distance', units: 'mi', data: [{ date: '2026-10-11 00:00:00 +0200', qty: 2 }] },
      {
        name: 'resting_heart_rate', units: 'count/min',
        data: [
          { date: '2026-10-11 00:00:00 +0200', qty: 50 },
          { date: '2026-10-11 08:00:00 +0200', qty: 60 }
        ]
      },
      { name: 'heart_rate_variability', units: 'ms', data: [{ date: '2026-10-11 06:00:00 +0200', Avg: 42 }] },
      { name: 'apple_exercise_time', units: 'min', data: [{ date: '2026-10-11 00:00:00 +0200', qty: 0 }] }
    ],
    workouts: [
      { id: 'w1', name: 'Running', start: '2026-10-11 07:00:00 +0200', end: '2026-10-11 07:40:00 +0200', duration: 2400 }
    ]
  }
};

check(calendarDate('2026-10-11 23:00:00 -0700') === '2026-10-11', 'payload offset keeps its own calendar date');
check(calendarDate('2026-10-11 00:00:00 +0200') === '2026-10-11', 'Sarajevo offset date');
check(calendarDate('2026-10-11T07:15:00+02:00') === '2026-10-11', 'ISO offset date');
check(calendarDate('2026-10-11T23:00:00Z') === '2026-10-12', 'Zulu time uses Europe/Sarajevo');
check(calendarDate('2026-01-15T23:30:00Z') === '2026-01-16', 'winter Sarajevo date');

const key = createHmac('sha256', process.env.WHOOP_STORE_SECRET).update('apple-health-ingest').digest('hex');

const denied = await postHealth(sample, {});
check(denied.statusCode === 401, 'missing key is rejected');

const wrong = await postHealth(sample, { 'x-api-key': 'nope' });
check(wrong.statusCode === 401, 'wrong key is rejected');

const first = await postHealth(JSON.stringify(sample), { 'x-api-key': key });
check(first.statusCode === 200 && first.body.ok && first.body.upserts === 8, 'first ingest upserts 8 metric-days, got ' + JSON.stringify(first.body));

let data = await readHealth();
const oct11 = data.days.find((d) => d.date === '2026-10-11');
const oct09 = data.days.find((d) => d.date === '2026-10-09');
check(data.days[0].date === '2026-10-11' && oct09 && oct09.steps === 111, 'offset date stored as 2026-10-09 with 111 steps');
check(oct11 && oct11.steps === 3000 && oct11.active_energy_kcal === 100 && oct11.distance_km === 3.219 && oct11.resting_hr === 55, 'day totals ' + JSON.stringify(oct11));
check(oct11 && oct11.extra && oct11.extra.heart_rate_variability.qty === 42 && oct11.extra.apple_exercise_time.qty === 0, 'other metrics stored, including zero');
check(oct11 && oct11.workouts && oct11.workouts[0].name === 'Running' && oct11.workouts[0].duration_min === 40, 'workout stored');
check(data.averages_7d.steps === 1370 && data.averages_7d.active_energy_kcal === 100, '7-day averages ' + JSON.stringify(data.averages_7d));
check(typeof data.last_sync === 'string' && Date.now() - Date.parse(data.last_sync) < 60_000, 'last_sync is recent');

const dup = await postHealth(sample, { 'x-api-key': key });
check(dup.statusCode === 200, 'duplicate post accepted');
data = await readHealth();
check(data.days.find((d) => d.date === '2026-10-11').steps === 3000, 'duplicate re-send does not double steps');

const higher = { data: { metrics: [{ name: 'step_count', units: 'count', data: [{ date: '2026-10-11 00:00:00 +0200', qty: 4000 }] }] } };
await postHealth(higher, { 'x-api-key': key });
await postHealth(higher, { 'x-api-key': key });
data = await readHealth();
const oct11b = data.days.find((d) => d.date === '2026-10-11');
check(oct11b.steps === 4000 && oct11b.active_energy_kcal === 100 && oct11b.resting_hr === 55, 'partial step update replaces that metric only');

const hr = { data: { metrics: [{ name: 'resting_heart_rate', units: 'bpm', data: [{ date: '2026-10-11 00:00:00 +0200', qty: 58 }] }] } };
await postHealth(hr, { 'x-api-key': key });
const zulu = { data: { metrics: [{ name: 'step_count', units: 'count', data: [{ date: '2026-10-11T23:00:00Z', qty: 9 }] }] } };
await postHealth(zulu, { 'x-api-key': key });
await postHealth(zulu, { 'x-api-key': key });

const stillWrong = await postHealth(higher, { 'x-api-key': 'still-nope' });
check(stillWrong.statusCode === 401, 'later bad key does not write');

data = await readHealth(14);
const d11 = data.days.find((d) => d.date === '2026-10-11');
const d12 = data.days.find((d) => d.date === '2026-10-12');
check(d11.steps === 4000 && d11.resting_hr === 58 && d11.distance_km === 3.219, 'final Oct 11 ' + JSON.stringify(d11));
check(d12 && d12.steps === 9 && d12.active_energy_kcal == null, 'Zulu timestamp landed on the Sarajevo day');
check(data.averages_7d.steps === 1280 && data.averages_7d.resting_hr === 58 && data.averages_7d.distance_km === 3.219, 'final averages ' + JSON.stringify(data.averages_7d));

const food = await postHealth({ date: '2026-10-11', calories: 500, protein: 40, carbs: 20, fat: 10 }, { authorization: 'Bearer test-health-token' });
check(food.statusCode === 200 && food.body.saved && food.body.saved[0].calories === 500, 'food shortcut still saves');
data = await readHealth();
check(data.days.find((d) => d.date === '2026-10-11').steps === 4000, 'food ingest does not change Apple Health steps');

const setupRes = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'health', arguments: { setup: true, days: 3 } } });
const setup = JSON.parse(setupRes.body.result.content[0].text);
check(setup.url === 'https://mo-os-omega.vercel.app/api/health' && setup.header === 'x-api-key' && setup.key === key, 'setup returns url, header, and derived key');
check(setup.health_auto_export.export_format === 'JSON' && setup.health_auto_export.time_grouping === 'Days', 'setup tells the app to aggregate by day');
check(!JSON.parse((await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'health', arguments: { days: 7 } } })).body.result.content[0].text).key, 'normal read does not leak the key');

const list = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
const names = list.body.result.tools.map((t) => t.name);
for (const n of ['health', 'whoop', 'food_and_weight', 'hevy', 'calls', 'log_food', 'money']) check(names.includes(n), 'tool still listed: ' + n);

const unknown = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'not_a_tool', arguments: {} } });
check(unknown.body.error && unknown.body.error.code === -32602, 'unknown tool still rejected');

const get = await postHealth(sample, { 'x-api-key': key }, 'GET');
check(get.statusCode === 405, 'GET rejected');

const bad = await postHealth('{', { 'x-api-key': key });
check(bad.statusCode === 400, 'invalid JSON rejected');

const noMcp = await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/list' }, '');
check(noMcp.statusCode === 401, 'MCP still requires the bearer token');

if (fails.length) {
  console.error(fails.length + ' failed');
  process.exit(1);
}
console.log('all passed');
