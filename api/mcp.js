// MO OS remote MCP server: lets Grok Bot (or any MCP client) add tasks.
// MO OS is end-to-end encrypted, so this server never sees or touches the real
// data. Each task is sealed to the app's public key (ECDH P-256 + AES-GCM) and
// parked in an inbox doc; the app unseals and merges it the next time it's open.
import { webcrypto, timingSafeEqual } from 'crypto';
import { whoopSummary, NOT_CONNECTED } from './_whoop.js';
import { hevySummary } from './_hevy.js';
import { healthSummary, logFood, logWeight, removeFood, setTargets } from './_health.js';
import { logMoney, moneySummary, setMoneySettings } from './_money.js';

const subtle = (globalThis.crypto || webcrypto).subtle;
const rand = (n) => (globalThis.crypto || webcrypto).getRandomValues(new Uint8Array(n));

const PROJECT = 'poppy-sales';
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyCYCt9-opphzCOSInAaPnrGIBN8M6kWW-Y';
const DOC_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/poppy/osinbox:Mo`;
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const NOT_READY = 'The MO OS inbox is not activated yet. Open MO OS once on any device, then try again.';

const TOOLS = [{
  name: 'add_tasks',
  description: "Add one or more tasks to Mo's MO OS task list. Set today=true to also put a task in his Top 3 for today (the app keeps at most 3; extras still land in the list). Optional area: Sales, Fitness, Money or Personal. MO OS is end-to-end encrypted, so you can add tasks but cannot read his existing list. Tasks appear the next time MO OS is open.",
  inputSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array', minItems: 1, maxItems: 20,
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The task, short and actionable' },
            area: { type: 'string', description: 'Optional: Sales, Fitness, Money or Personal' },
            today: { type: 'boolean', description: "Put it in today's Top 3" }
          },
          required: ['text']
        }
      }
    },
    required: ['tasks']
  }
}, {
  name: 'whoop',
  description: "Mo's WHOOP data: today's recovery (score, HRV, resting HR), last night's sleep (bed and wake time in his local time, hours asleep, deep/REM, performance), day strain and calories, workouts, plus the same for recent days and his weight. Use it for morning check-ins, to judge how hard he should push today, and to spot patterns.",
  inputSchema: { type: 'object', properties: { days: { type: 'number', description: 'How many recent days, 1 to 30. Default 7.' } } }
}, {
  name: 'write_journal',
  description: "Save text to Mo's MO OS journal for a given day (appends to that day's entry, or starts one). Use it at night to save his check-in answers in his own words, lightly cleaned up. Pass the date in his local time.",
  inputSchema: { type: 'object', properties: {
    text: { type: 'string', description: 'What to save' },
    date: { type: 'string', description: 'YYYY-MM-DD in his local time' },
    title: { type: 'string', description: 'Optional short title if this starts a new entry' }
  }, required: ['text', 'date'] }
}, {
  name: 'food_and_weight',
  description: "Mo's daily calories, protein, carbs, fat, steps and bodyweight (lbs), from MacroFactor via Apple Health. Today's numbers update a few times a day. His goal is to go from about 147 to 170 lbs, so he needs to eat in a surplus and hit protein. Use it to nudge him to eat, and to track weight trend.",
  inputSchema: { type: 'object', properties: { days: { type: 'number', description: 'How many recent days, 1 to 90. Default 7.' } } }
}, {
  name: 'log_food',
  description: "Log what Mo ate to MO OS. He sends a photo or text; estimate calories, protein, carbs and fat per item (be realistic, not optimistic). If he names one of his saved meals (see food_and_weight saved_meals), pass just the name and the saved numbers are used. Use save_as when he says to remember a meal. Then tell him today's total vs his goal (eating in a surplus toward 170 lbs, protein about 1g per lb).",
  inputSchema: { type: 'object', properties: {
    date: { type: 'string', description: 'YYYY-MM-DD in his local time' },
    items: { type: 'array', items: { type: 'object', properties: {
      name: { type: 'string' }, calories: { type: 'number' }, protein: { type: 'number' }, carbs: { type: 'number' }, fat: { type: 'number' }
    }, required: ['name'] } },
    save_as: { type: 'string', description: 'Optional: save these items together as a named meal for next time' }
  }, required: ['date', 'items'] }
}, {
  name: 'log_weight',
  description: 'Log a morning weigh-in. Pass lb (or kg) and his local date.',
  inputSchema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD local' }, lb: { type: 'number' }, kg: { type: 'number' } }, required: ['date'] }
}, {
  name: 'remove_food',
  description: 'Undo a logged food: the last item, or the latest one matching a name. Use for "undo", "delete that", or before re-logging a corrected version.',
  inputSchema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD local' }, name: { type: 'string', description: 'Optional, part of the item name' } }, required: ['date'] }
}, {
  name: 'set_food_targets',
  description: 'Change his daily calorie and protein targets (and goal weight or weekly gain rate). Only when he asks, or in the Sunday review after he agrees to an adjustment.',
  inputSchema: { type: 'object', properties: { calories: { type: 'number' }, protein: { type: 'number' }, workouts_per_week: { type: 'number' }, goal_weight_lb: { type: 'number' }, weekly_gain_lb: { type: 'number' }, tracking_since: { type: 'string', description: 'YYYY-MM-DD, the day he started tracking properly; averages for gym, food and weight only count from here' } } }
}, {
  name: 'log_money',
  description: "Save today's account balances to MO OS (run this every morning from Mo's Plaid connection, and whenever he asks). Pass every account with its balance and currency; types: cash, savings, investment, crypto, tax (his tax reserve account), credit, loan. Credit and loan balances are what he owes (positive number). Optionally pass this month's income and spending in CAD and top spending categories. MO OS converts to CAD and tracks net worth over time.",
  inputSchema: { type: 'object', properties: {
    date: { type: 'string', description: 'YYYY-MM-DD in his local time, default today' },
    accounts: { type: 'array', items: { type: 'object', properties: {
      name: { type: 'string' }, institution: { type: 'string' }, type: { type: 'string', enum: ['cash', 'savings', 'investment', 'crypto', 'tax', 'credit', 'loan', 'other'] },
      currency: { type: 'string', description: 'CAD, USD, EUR...' }, balance: { type: 'number' }
    }, required: ['name', 'balance'] } },
    income_month_cad: { type: 'number', description: 'Money in this month so far, CAD' },
    spent_month_cad: { type: 'number', description: 'Spending this month so far, CAD (not transfers between his own accounts)' },
    top_spending: { type: 'array', items: { type: 'object', properties: { category: { type: 'string' }, cad: { type: 'number' } } } },
    note: { type: 'string' }
  }, required: ['accounts'] }
}, {
  name: 'money',
  description: "Mo's money from MO OS: net worth in CAD and its 30 day change, every account balance, cash vs investments, runway in months, this month's income, spending, saved %, top spending, and tax to set aside. Use it for money questions and in the night check-in / Sunday review.",
  inputSchema: { type: 'object', properties: { days: { type: 'number', description: 'History length for net worth, default 90' } } }
}, {
  name: 'set_money_settings',
  description: 'Change money assumptions: monthly_burn_cad (what a normal month costs him), tax_rate (0.3 = 30%), runway_goal_months. Only when he asks.',
  inputSchema: { type: 'object', properties: { monthly_burn_cad: { type: 'number' }, tax_rate: { type: 'number' }, runway_goal_months: { type: 'number' } } }
}, {
  name: 'hevy',
  description: "Mo's gym log from Hevy (weights in lbs): recent workouts with every set, and per exercise the last session, estimated 1RM, and the target to beat next time (progressive overload). Use it before a gym session to tell him exactly what to hit, and to track strength progress toward his goal of going from about 147 to 170 lbs bodyweight.",
  inputSchema: { type: 'object', properties: { workouts: { type: 'number', description: 'How many recent workouts, 1 to 30. Default 10.' } } }
}];

const INSTRUCTIONS = [
  "MO OS is Mo's personal operating system. Tools: add_tasks, write_journal, whoop (sleep/recovery), hevy (lifts), food_and_weight, log_food, log_weight, remove_food, set_food_targets, log_money (push balances from Plaid), money, set_money_settings.",
  "Tasks: capture anything he asks to remember or do with add_tasks. To plan his day, check his calendar, Close and Slack, pick the 3 that matter most and add them with today=true.",
  "FOOD COACH: Mo is bulking from about 147 to 170 lbs and his real problem is forgetting to eat when he is locked into calls. When he sends a food photo or text, log it right away with log_food (his local date), no questions unless something is truly ambiguous. Estimate realistically from visible portions; for restaurant or delivery food assume oil and bigger portions. If he names a saved meal, pass just the name. Weigh-ins go to log_weight. 'undo' or a correction = remove_food then log again.",
  "Reply format after logging, short, exactly like this:\n<one emoji> <meal name>\n<cal> cal · <protein>g protein\n\nToday  <cal so far> / <target> cal\nProtein  <g so far> / <target>g\n\n<one line: what to eat next and when, tied to his next call if you know his calendar>",
  "Tone: like a sharp friend who knows nutrition. Plain words, no hype, no lectures, no em dashes. Praise only when earned (hit protein, new weight high). Never guilt him."
].join('\n\n');

const b64 = (u) => Buffer.from(u).toString('base64');

function authed(req) {
  const tok = process.env.MOOS_MCP_TOKEN || '';
  if (!tok) return false;
  const h = String(req.headers.authorization || '');
  const given = h.startsWith('Bearer ') ? h.slice(7).trim() : String((req.query && req.query.key) || '');
  const a = Buffer.from(given), b = Buffer.from(tok);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function sealFor(pubJwk, payload) {
  const appPub = await subtle.importKey('jwk', { kty: pubJwk.kty, crv: pubJwk.crv, x: pubJwk.x, y: pubJwk.y }, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'ECDH', public: appPub }, eph.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = rand(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  const e = await subtle.exportKey('jwk', eph.publicKey);
  return JSON.stringify({ e: { kty: e.kty, crv: e.crv, x: e.x, y: e.y }, iv: b64(iv), ct: b64(new Uint8Array(ct)) });
}

// Seal items to the app's public key and park them in the inbox doc.
export async function sealToInbox(items) {
  const r = await fetch(`${DOC_URL}?key=${API_KEY}&mask.fieldPaths=pub`);
  if (!r.ok) throw new Error(NOT_READY);
  const doc = await r.json();
  const pubStr = doc.fields && doc.fields.pub && doc.fields.pub.stringValue;
  if (!pubStr) throw new Error(NOT_READY);
  const pub = JSON.parse(pubStr);
  const fields = {}, paths = [];
  for (const t of items) {
    const id = 'i' + Date.now() + Math.random().toString(36).slice(2, 8);
    fields[id] = { stringValue: await sealFor(pub, { ...t, ts: Date.now() }) };
    paths.push(id);
  }
  const qs = paths.map((p) => 'updateMask.fieldPaths=' + encodeURIComponent(p)).join('&');
  const w = await fetch(`${DOC_URL}?key=${API_KEY}&${qs}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  if (!w.ok) throw new Error('Could not save to the MO OS inbox (' + w.status + ').');
}

async function writeJournal(a) {
  const text = String(a.text || '').trim().slice(0, 8000);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(a.date || '') ? a.date : '';
  if (!text || !date) throw new Error('Need text and a YYYY-MM-DD date.');
  await sealToInbox([{ kind: 'journal', text, date, title: String(a.title || '').slice(0, 120), src: 'Grok Bot' }]);
  return `Saved to the journal for ${date}. It shows up the next time MO OS is open.`;
}

async function addTasks(args) {
  const list = Array.isArray(args && args.tasks) ? args.tasks : [];
  const clean = list
    .map((t) => ({
      text: String((t && t.text) || '').trim().slice(0, 500),
      area: String((t && t.area) || '').trim().slice(0, 40),
      today: !!(t && t.today)
    }))
    .filter((t) => t.text)
    .slice(0, 20);
  if (!clean.length) throw new Error('No task text was given.');

  await sealToInbox(clean.map((t) => ({ ...t, src: 'Grok Bot' })));

  const n = clean.length, todayN = clean.filter((t) => t.today).length;
  return `Added ${n} task${n > 1 ? 's' : ''} to MO OS${todayN ? ` (${todayN} for today's Top 3)` : ''}. They show up the next time MO OS is open.`;
}

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg || {};
  if (id === undefined || id === null) return null; // notification: no reply
  switch (method) {
    case 'initialize': {
      const v = params && params.protocolVersion;
      return ok(id, {
        protocolVersion: VERSIONS.includes(v) ? v : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'mo-os', version: '1.1.0' },
        instructions: INSTRUCTIONS
      });
    }
    case 'ping': return ok(id, {});
    case 'tools/list': return ok(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params && params.name;
      if (!['add_tasks', 'whoop', 'hevy', 'write_journal', 'food_and_weight', 'log_food', 'log_weight', 'remove_food', 'set_food_targets', 'log_money', 'money', 'set_money_settings'].includes(name)) return err(id, -32602, 'Unknown tool: ' + name);
      try {
        const args = (params && params.arguments) || {};
        const text = name === 'whoop'
          ? await whoopSummary(Math.min(30, Math.max(1, Number(args.days) || 7))).then((d) => (d ? JSON.stringify(d) : NOT_CONNECTED))
          : name === 'log_money'
            ? JSON.stringify(await logMoney(args))
          : name === 'money'
            ? JSON.stringify(await moneySummary(Number(args.days) || 90))
          : name === 'set_money_settings'
            ? JSON.stringify(await setMoneySettings(args))
          : name === 'log_weight'
            ? JSON.stringify(await logWeight(args))
          : name === 'remove_food'
            ? JSON.stringify(await removeFood(args))
          : name === 'set_food_targets'
            ? JSON.stringify(await setTargets(args))
          : name === 'log_food'
            ? JSON.stringify(await logFood(args))
          : name === 'food_and_weight'
            ? JSON.stringify(await healthSummary(Math.min(90, Math.max(1, Number(args.days) || 7))))
          : name === 'write_journal'
            ? await writeJournal(args)
          : name === 'hevy'
            ? JSON.stringify(await hevySummary(Number(args.workouts) || 10))
            : await addTasks(args);
        return ok(id, { content: [{ type: 'text', text }] });
      } catch (e) {
        return ok(id, { content: [{ type: 'text', text: String((e && e.message) || e) }], isError: true });
      }
    }
    default: return err(id, -32601, 'Method not found: ' + method);
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (!authed(req)) { res.status(401).json({ error: 'Unauthorized' }); return; }
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); res.status(405).json({ error: 'Use POST' }); return; }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { res.status(400).json(err(null, -32700, 'Parse error')); return; }
  }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(handle))).filter(Boolean);
    if (!out.length) { res.status(202).end(); return; }
    res.status(200).json(out);
    return;
  }
  const out = await handle(body);
  if (!out) { res.status(202).end(); return; }
  res.status(200).json(out);
}
