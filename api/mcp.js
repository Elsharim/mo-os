// MO OS remote MCP server: lets Grok Bot (or any MCP client) add tasks.
// MO OS is end-to-end encrypted, so this server never sees or touches the real
// data. Each task is sealed to the app's public key (ECDH P-256 + AES-GCM) and
// parked in an inbox doc; the app unseals and merges it the next time it's open.
import { webcrypto, timingSafeEqual } from 'crypto';
import { whoopSummary, NOT_CONNECTED } from './_whoop.js';
import { hevySummary, hevyRoutines, hevyEdit } from './_hevy.js';
import { healthSummary, logFood, logWeight, removeFood, setTargets, removeWeight } from './_health.js';
import { logMoney, moneySummary, setMoneySettings, logPayout, removePayout, removeMoneyDay } from './_money.js';
import { logCalls, callsSummary, removeCalls } from './_work.js';
import { readMirror, tasksOf, priOf, journalOf, disciplinesOf, goalsOf, summaryOf, applyToMirror, nameForId } from './_mirror.js';
import { localDateISO } from './_health.js';
import { calendarToday } from './_cal.js';
import { weekView } from './life.js';
import { leaveNote, readNotes } from './_notes.js';

const subtle = (globalThis.crypto || webcrypto).subtle;
const rand = (n) => (globalThis.crypto || webcrypto).getRandomValues(new Uint8Array(n));

const PROJECT = 'poppy-sales';
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyCYCt9-opphzCOSInAaPnrGIBN8M6kWW-Y';
const DOC_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/poppy/osinbox:Mo`;
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const NOT_READY = 'The MO OS inbox is not activated yet. Open MO OS once on any device, then try again.';

const TOOLS = [{
  name: 'add_tasks',
  description: "Add one or more tasks to Mo's MO OS task list. Optional priority: P1 (do today), P2 (this week), P3 (someday); leave it out if unsure. Optional area: Sales, Fitness, Money or Personal. Use list_tasks to read his list.",
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
            priority: { type: 'string', enum: ['P1', 'P2', 'P3'], description: 'P1 = do today, P2 = this week, P3 = someday' }
          },
          required: ['text']
        }
      }
    },
    required: ['tasks']
  }
}, {
  name: 'complete_tasks',
  description: "Mark tasks in Mo's MO OS list as done, matched by name (case-insensitive, partial match is fine, best match wins). Use it when Mo says something is done. MO OS is encrypted, so you cannot read the list; just pass the names as he said them. Takes effect right away for the bots; the app applies it whenever it's open.",
  inputSchema: { type: 'object', properties: { names: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' } } }, required: ['names'] }
}, {
  name: 'delete_tasks',
  description: "Delete open tasks in MO OS by name. keep_one=true keeps the oldest copy and deletes the duplicates (use this to clean up repeats). keep_one=false deletes every open task matching that name. Takes effect right away for the bots; the app applies it whenever it's open. add_tasks already skips a task when an open one with the same name exists.",
  inputSchema: { type: 'object', properties: { names: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' } }, keep_one: { type: 'boolean', description: 'Default true' } }, required: ['names'] }
}, {
  name: 'remove_log',
  description: "Delete one logged day from MO OS: kind 'weight' (a weigh-in), 'calls' (a calls day), or 'money' (a balance snapshot). Give the date.",
  inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['weight', 'calls', 'money'] }, date: { type: 'string', description: 'YYYY-MM-DD' } }, required: ['kind', 'date'] }
}, {
  name: 'list_tasks',
  description: "Mo's open tasks from MO OS, sorted by priority (P1 do today, P2 this week, P3 someday, then null = not sorted), with id, name, area, priority, status and when (from the copy the app syncs each time it saves; pending=true means the app has not picked it up yet). Optional priority filter. Pass all=true to include completed ones.",
  inputSchema: { type: 'object', properties: { all: { type: 'boolean' }, priority: { type: 'string', enum: ['P1', 'P2', 'P3', 'none'], description: 'Only tasks with this priority (none = not sorted yet)' } } }
}, {
  name: 'update_tasks',
  description: "Change tasks in MO OS. Each update names a task by id (from list_tasks) or by name, and sets any of: name (rename), priority (P1 do today, P2 this week, P3 someday, none to clear), area (Sales, Fitness, Money, Personal), status ('completed' or 'open'). Takes effect right away for the bots; the app applies it whenever it's open.",
  inputSchema: { type: 'object', properties: { updates: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, set: { type: 'object', properties: { name: { type: 'string' }, priority: { type: 'string', enum: ['P1', 'P2', 'P3', 'none'], description: 'P1 = do today, P2 = this week, P3 = someday, none = clear it' }, area: { type: 'string' }, status: { type: 'string', enum: ['completed', 'open'] } } } }, required: ['set'] } } }, required: ['updates'] }
}, {
  name: 'read_journal',
  description: "Mo's journal entries from MO OS, newest first. Optional from/to dates (YYYY-MM-DD) and limit (default 30). Each entry has a key for edit_journal.",
  inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, limit: { type: 'number' } } }
}, {
  name: 'edit_journal',
  description: "Edit or delete one journal entry by key (from read_journal). Give title and/or text to replace them, or delete=true. Takes effect right away for the bots; the app applies it whenever it's open. New entries: write_journal.",
  inputSchema: { type: 'object', properties: { key: { type: 'string' }, title: { type: 'string' }, text: { type: 'string' }, delete: { type: 'boolean' } }, required: ['key'] }
}, {
  name: 'disciplines',
  description: "Mo's daily disciplines list and which ones he hit each day (default last 7 days). Use for the night check-in score and the Sunday review.",
  inputSchema: { type: 'object', properties: { days: { type: 'number' } } }
}, {
  name: 'tick',
  description: "Mark disciplines done or not done for a date (default today). Pass labels or ids from the disciplines tool. Takes effect right away for the bots; the app applies it whenever it's open.",
  inputSchema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD, his local day' }, done: { type: 'array', items: { type: 'string' } }, undone: { type: 'array', items: { type: 'string' } } } }
}, {
  name: 'goals',
  description: "Mo's goals from MO OS: the goal list with target dates and done flags, north star, buy box.",
  inputSchema: { type: 'object', properties: {} }
}, {
  name: 'summary',
  description: "One call for briefs: P1 tasks (today), P2 tasks (this week), open task count, disciplines today, active goals, last journal entry, plus last night's sleep and recovery, food so far, today's calendar and calls this week.",
  inputSchema: { type: 'object', properties: {} }
}, {
  name: 'week',
  description: "Mo's habit week, the same data as the Week page in MO OS. Per day (last ~16 days): gym (Hevy), calories, protein, weight, calls taken and booked, supplements, learning (days he added to his brain library, with the title), parents (days he texted or called Baba or Mama), plus targets and payouts. Weeks run Monday to Sunday. Habit targets: gym 5, calories 7 (90 percent of target), protein 7, supplements 7, learning 7, parents 4. Use it for the Sunday recap and the Monday plan.",
  inputSchema: { type: 'object', properties: {} }
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
  description: "Mo's daily calories, protein, carbs, fat, steps and bodyweight (lbs), from MacroFactor via Apple Health, plus the weekly calorie budget. food_plan.today is calories eaten vs the adjusted daily target (base stays 3,000), protein vs 150g, and whether protein is hit. food_plan.week is Monday–Sunday in Europe/Sarajevo: eaten vs the working budget, remaining, average over completed logged days, adjusted target for the days left, and ahead/behind pace. When every completed day is logged, that budget is the weekly goal (21,000, or 7 × base). When any completed day is unlogged, today.provisional and week.provisional are true: budget is the base times logged days plus days left, and today.note says the target is based on logged days only. Do not quote the full weekly goal as the gap in that case. food_plan.recent_weeks keeps earlier weeks. food_plan.bulk is latest weight and progress from his start weight (145) to 170. Unlogged days are unlogged, not zero. Today's intake does not change today's target. Weight trend fields (7-day average, weekly change) are unchanged. Use food_plan when you tell him what to eat, and never tell him to cram past the capped target.",
  inputSchema: { type: 'object', properties: { days: { type: 'number', description: 'How many recent days, 1 to 90. Default 7.' } } }
}, {
  name: 'log_food',
  description: "Log what Mo ate to MO OS. He sends a photo or text; estimate calories, protein, carbs and fat per item (be realistic, not optimistic). If he names one of his saved meals (see food_and_weight saved_meals), pass just the name and the saved numbers are used. Use save_as when he says to remember a meal. The reply includes food_plan with the same today, week and bulk numbers as food_and_weight. Tell him today's total vs adjusted_daily_target, and protein vs the daily protein target. If today.provisional is true, say the target is provisional and based on logged days only. If today.note is set, tell him to spread the gap instead of eating the uncapped number.",
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
  description: 'Change his daily calorie and protein targets, weekly calorie budget, start weight, goal weight, or weekly gain rate. The weekly budget defaults to 7 × the daily base when it has not been set. Only when he asks, or in the Sunday review after he agrees to an adjustment.',
  inputSchema: { type: 'object', properties: { calories: { type: 'number' }, protein: { type: 'number' }, weekly_calories: { type: 'number', description: 'Monday–Sunday calorie budget. Omit to keep the stored value, or the default of 7 × daily calories.' }, workouts_per_week: { type: 'number' }, goal_weight_lb: { type: 'number' }, start_weight_lb: { type: 'number', description: 'Bulk starting weight. Progress is from here to goal_weight_lb.' }, weekly_gain_lb: { type: 'number' }, tracking_since: { type: 'string', description: 'YYYY-MM-DD, the day he started tracking properly; averages for gym, food and weight only count from here' } } }
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
  name: 'log_payout',
  description: "Record a Poppy payout (his monthly contractor income). Pass the date the money was sent, the gross amount and currency (usually USD). MO OS converts to CAD at that day's rate and uses it for the 2026 tax estimate. Logging the same date again replaces it.",
  inputSchema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD' }, amount: { type: 'number' }, currency: { type: 'string', description: 'USD or CAD, default USD' }, period: { type: 'string', description: 'e.g. "Aug 26 to Sep 25"' }, remove: { type: 'boolean', description: 'true to delete the payout on that date' } }, required: ['date'] }
}, {
  name: 'set_money_settings',
  description: 'Change money assumptions: deductions_cad (business expenses he will deduct this year), monthly_burn_cad, tax_rate. Only when he asks.',
  inputSchema: { type: 'object', properties: { deductions_cad: { type: 'number' }, monthly_burn_cad: { type: 'number' }, tax_rate: { type: 'number' } } }
}, {
  name: 'log_calls',
  description: "Log Mo's sales calls for a day: how many were booked on his calendar and how many actually happened (a Tactiq recording exists = showed). Run it every night for today, or when he asks for a past day. Optional: closed count, cash collected (USD), and the per-call list with who / showed / result. Logging the same date again replaces it.",
  inputSchema: { type: 'object', properties: {
    date: { type: 'string', description: 'YYYY-MM-DD in his local time' },
    booked: { type: 'number', description: 'Sales calls on the calendar that day (demos, closes, follow-ups; not team meetings or coaching)' },
    showed: { type: 'number', description: 'How many of those actually happened' },
    closed: { type: 'number' }, cash_usd: { type: 'number' },
    calls: { type: 'array', items: { type: 'object', properties: { who: { type: 'string' }, showed: { type: 'boolean' }, kind: { type: 'string' }, result: { type: 'string' } } } },
    note: { type: 'string' }
  }, required: ['date', 'booked', 'showed'] }
}, {
  name: 'calls',
  description: "Mo's call stats from MO OS: today, yesterday, this week and last 30 days (booked, showed, no-shows, show rate, closes, close rate, cash), plus recent days. Use for the night check-in, Sunday review and any question about shows or no-shows.",
  inputSchema: { type: 'object', properties: { days: { type: 'number', description: 'How many recent days to list, default 30' } } }
}, {
  name: 'note_for_claude',
  description: "Leave a note for Claude (Mo's other assistant, who builds MO OS and sees his email, calendar, Close and files). Use it when Mo says something Claude should know or act on, when you notice a problem with MO OS, or when you want Claude to do something. Claude reads these when Mo opens that chat.",
  inputSchema: { type: 'object', properties: { text: { type: 'string' }, topic: { type: 'string', description: 'Short label, e.g. "calendar", "tax", "bug"' } }, required: ['text'] }
}, {
  name: 'notes_from_claude',
  description: "Read notes Claude left for you. Call this at the start of every scheduled job and whenever Mo asks what Claude said. Notes are marked read once you fetch them.",
  inputSchema: { type: 'object', properties: { unread_only: { type: 'boolean', description: 'Default true' } } }
}, {
  name: 'hevy',
  description: "Mo's gym log from Hevy (weights in lbs): recent workouts with every set, and per exercise the last session, estimated 1RM, and the target to beat next time (progressive overload). Use it before a gym session to tell him exactly what to hit, and to track strength progress toward his goal of going from about 147 to 170 lbs bodyweight. Pass routines=true to also get his saved Hevy routines (the plan: each routine's exercises with planned sets/reps and muscle groups, when it was last done, and which planned exercises he skipped that time) plus every muscle group with the date it was last trained and working sets in the last 14 days. Use that to call out skipped exercises and neglected muscles. Workouts and routines come with ids for hevy_edit.",
  inputSchema: { type: 'object', properties: { workouts: { type: 'number', description: 'How many recent workouts, 1 to 30. Default 10.' }, routines: { type: 'boolean', description: 'Also return saved routines and muscle group recency. Default false.' } } }
}, {
  name: 'hevy_edit',
  description: "Write to Mo's Hevy account. Weights in lbs. Exercises by exact Hevy title (e.g. \"Lat Pulldown (Cable)\") or exercise_template_id; if a name is ambiguous the error lists the closest titles, so run find_exercise first when unsure. Actions: find_exercise {query}; get_workout {id}; log_workout {title, exercises, start_time?, end_time? (ISO, default ends now), minutes? (default 60), description?}; update_workout {id, fields to change; exercises replaces the whole list, omit it to keep them}; get_routine {id}; create_routine {title, exercises, folder_id?, notes?}; update_routine {id, title?, folder_id?, notes?, exercises? (replaces the whole list)}; create_folder {title}; create_exercise {title, exercise_type?, equipment?, muscle?} for a custom exercise. Exercise shape: {exercise, notes?, rest_seconds?, superset_id?, sets: [{weight_lb?, reps?, rep_min?, rep_max?, type?: warmup|normal|failure|dropset, duration_seconds?, rpe?}]} or shorthand {exercise, sets: 3, reps: 10 or \"8-10\", weight_lb?}. To edit one exercise in a routine, get_routine first, then send the full list back. Hevy's API cannot delete workouts or routines. Confirm with Mo before overwriting an existing workout or routine.",
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['find_exercise', 'get_workout', 'log_workout', 'update_workout', 'get_routine', 'create_routine', 'update_routine', 'create_folder', 'create_exercise'] },
      id: { type: 'string', description: 'Workout or routine id' },
      query: { type: 'string', description: 'find_exercise search text' },
      title: { type: 'string' }, notes: { type: 'string' }, description: { type: 'string' },
      folder_id: { type: 'number' }, start_time: { type: 'string' }, end_time: { type: 'string' }, minutes: { type: 'number' },
      exercise_type: { type: 'string' }, equipment: { type: 'string' }, muscle: { type: 'string' },
      exercises: { type: 'array', items: { type: 'object' } }
    },
    required: ['action']
  }
}];

const INSTRUCTIONS = [
  "MO OS is Mo's personal operating system. Tools: add_tasks, complete_tasks, delete_tasks, update_tasks, list_tasks, remove_log, write_journal, read_journal, edit_journal, disciplines, tick, goals, summary, whoop (sleep/recovery), hevy (lifts), hevy_edit (log/edit workouts and routines in Hevy), food_and_weight, log_food, log_weight, remove_food, set_food_targets, log_money (push balances from Plaid), money, set_money_settings.",
  "Tasks: capture anything he asks to remember or do with add_tasks. To plan his day, check his calendar, Close and Slack, and set priorities: P1 for what must happen today, P2 for this week, P3 for someday. Keep P1 short.",
  "FOOD COACH: Mo is bulking from 145 to 170 lbs. Base is 3,000 cal a day, weekly budget is 7 times that base (21,000 unless food_plan.targets.weekly_calories says otherwise), Monday to Sunday in Europe/Sarajevo, protein 150g a day. His real problem is forgetting to eat when he is locked into calls. When he sends a food photo or text, log it right away with log_food (his local date), no questions unless something is truly ambiguous. Estimate realistically from visible portions; for restaurant or delivery food assume oil and bigger portions. If he names a saved meal, pass just the name. Weigh-ins go to log_weight. 'undo' or a correction = remove_food then log again.",
  "Reply format after logging, short, exactly like this:\n<one emoji> <meal name>\n<cal> cal · <protein>g protein\n\nToday  <cal so far> / <adjusted daily target> cal\nProtein  <g so far> / <daily protein target>g\n\n<one line: what to eat next and when, tied to his next call if you know his calendar>",
  "The adjusted daily target is food_plan.today.adjusted_daily_target on log_food and food_and_weight. It does not drop as he eats today. If today.provisional is true, the target and the week remaining use the prorated budget (base times logged days plus days left), not the full weekly goal, and you say it is provisional. If today.clamped or today.note is set, the one line tells him to spread the gap, and you never tell him to eat the raw uncapped number. Protein is daily: a high day does not cover a low day. Unlogged days are unlogged, not zero. Weight trend fields on food_and_weight stay as they are.",
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
  // apply the same change to the bots' copy now, so reads see it right away
  await applyToMirror(items, localDateISO()).catch(() => false);
}

async function writeJournal(a) {
  const text = String(a.text || '').trim().slice(0, 8000);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(a.date || '') ? a.date : '';
  if (!text || !date) throw new Error('Need text and a YYYY-MM-DD date.');
  await sealToInbox([{ kind: 'journal', text, date, title: String(a.title || '').slice(0, 120), src: 'Grok Bot' }]);
  return `Saved to the journal for ${date}. read_journal shows it now; the app picks it up whenever it's open.`;
}

async function addTasks(args) {
  const list = Array.isArray(args && args.tasks) ? args.tasks : [];
  const clean = list
    .map((t) => ({
      text: String((t && t.text) || '').trim().slice(0, 500),
      area: String((t && t.area) || '').trim().slice(0, 40),
      priority: priOf(t && t.priority) ? 'P' + priOf(t.priority) : undefined
    }))
    .filter((t) => t.text)
    .slice(0, 20);
  if (!clean.length) throw new Error('No task text was given.');

  await sealToInbox(clean.map((t) => ({ ...t, src: 'Grok Bot' })));

  const n = clean.length, p1 = clean.filter((t) => t.priority === 'P1').length;
  return `Added ${n} task${n > 1 ? 's' : ''} to MO OS${p1 ? ` (${p1} as P1 for today)` : ''}. list_tasks shows them now; the app picks them up whenever it's open.`;
}

async function completeTasks(args) {
  const names = (Array.isArray(args && args.names) ? args.names : []).map((x) => String(x || '').trim().slice(0, 200)).filter(Boolean).slice(0, 20);
  if (!names.length) throw new Error('No task names were given.');
  await sealToInbox([{ kind: 'complete', names, src: 'Grok Bot' }]);
  return `Marked ${names.length} task${names.length > 1 ? 's' : ''} done: ${names.join('; ')}. list_tasks reflects it now.`;
}

async function deleteTasks(args) {
  const names = (Array.isArray(args && args.names) ? args.names : []).map((x) => String(x || '').trim().slice(0, 200)).filter(Boolean).slice(0, 20);
  if (!names.length) throw new Error('No task names were given.');
  const keep = (args && args.keep_one) !== false;
  await sealToInbox([{ kind: 'delete', names, keep_one: keep, src: 'Grok Bot' }]);
  return `${keep ? 'Removed duplicates of' : 'Deleted'} ${names.join('; ')}. list_tasks reflects it now.`;
}
async function removeLog(args) {
  const k = String((args && args.kind) || '');
  if (k === 'weight') return removeWeight({ date: args.date });
  if (k === 'calls') return removeCalls(args.date);
  if (k === 'money') return removeMoneyDay(args.date);
  throw new Error("kind must be weight, calls or money");
}

async function updateTasks(args) {
  const ups = (Array.isArray(args && args.updates) ? args.updates : []).map((u) => ({ id: u.id ? String(u.id) : undefined, name: u.name ? String(u.name).slice(0, 200) : undefined, set: u.set && typeof u.set === 'object' ? u.set : {} })).filter((u) => (u.id || u.name) && Object.keys(u.set).length).slice(0, 20);
  if (!ups.length) throw new Error('Each update needs id or name plus a set object.');
  if (ups.some((u) => u.id && !u.name)) { const M = await readMirror().catch(() => null); if (M) ups.forEach((u) => { if (u.id && !u.name) u.name = nameForId(M, u.id) || undefined; }); }
  await sealToInbox(ups.map((u) => ({ kind: 'update', ...u, src: 'Grok Bot' })));
  return `Updated ${ups.length} task${ups.length > 1 ? 's' : ''}. list_tasks reflects it now.`;
}
async function editJournal(args) {
  const key = String((args && args.key) || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}(#\d+)?$/.test(key)) throw new Error('key must look like YYYY-MM-DD or YYYY-MM-DD#2 (from read_journal).');
  await sealToInbox([{ kind: 'journal_edit', key, title: args.title != null ? String(args.title).slice(0, 200) : undefined, text: args.text != null ? String(args.text).slice(0, 20000) : undefined, delete: !!args.delete, src: 'Grok Bot' }]);
  return `${args.delete ? 'Deleted' : 'Edited'} journal entry ${key}. read_journal reflects it now.`;
}
async function tick(args) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test((args && args.date) || '') ? args.date : null;
  const done = (Array.isArray(args && args.done) ? args.done : []).map(String).slice(0, 40), undone = (Array.isArray(args && args.undone) ? args.undone : []).map(String).slice(0, 40);
  if (!done.length && !undone.length) throw new Error('Give done and/or undone.');
  await sealToInbox([{ kind: 'tick', date, done, undone, src: 'Grok Bot' }]);
  return `Ticked ${done.length} done, ${undone.length} undone for ${date || 'today'}. disciplines reflects it now.`;
}
async function summary() {
  const M = await readMirror().catch((e) => ({ error: e.message }));
  const [whoop, food, work] = await Promise.all([whoopSummary(2).catch(() => null), healthSummary(1).catch(() => null), callsSummary(7).catch(() => null)]);
  const cal = await calendarToday((whoop && whoop.tz_offset) || null).catch(() => null);
  const t = whoop && whoop.today;
  return {
    app: M.error ? { error: M.error } : summaryOf(M),
    sleep: t && t.sleep ? { hours: t.sleep.asleep_h, bed: t.sleep.bed && t.sleep.bed.time, woke: t.sleep.woke && t.sleep.woke.time } : null,
    recovery: t && t.recovery ? t.recovery.score : null,
    food_today: food && food.food_plan ? food.food_plan.today : null,
    calendar_today: cal ? cal.events : null,
    calls_this_week: work ? work.this_week : null
  };
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
      if (!['week', 'add_tasks', 'complete_tasks', 'delete_tasks', 'remove_log', 'list_tasks', 'update_tasks', 'read_journal', 'edit_journal', 'disciplines', 'tick', 'goals', 'summary', 'whoop', 'hevy', 'hevy_edit', 'write_journal', 'food_and_weight', 'log_food', 'log_weight', 'remove_food', 'set_food_targets', 'log_money', 'money', 'set_money_settings', 'log_payout', 'log_calls', 'calls', 'note_for_claude', 'notes_from_claude'].includes(name)) return err(id, -32602, 'Unknown tool: ' + name);
      try {
        const args = (params && params.arguments) || {};
        const text = name === 'whoop'
          ? await whoopSummary(Math.min(30, Math.max(1, Number(args.days) || 7))).then((d) => (d ? JSON.stringify(d) : NOT_CONNECTED))
          : name === 'log_money'
            ? JSON.stringify(await logMoney(args))
          : name === 'money'
            ? JSON.stringify(await moneySummary(Number(args.days) || 90))
          : name === 'note_for_claude'
            ? JSON.stringify(await leaveNote({ from: 'grok', to: 'claude', text: args.text, topic: args.topic }))
          : name === 'notes_from_claude'
            ? JSON.stringify(await readNotes({ to: 'grok', unread_only: args.unread_only !== false }))
          : name === 'log_calls'
            ? JSON.stringify(await logCalls(args))
          : name === 'calls'
            ? JSON.stringify(await callsSummary(Number(args.days) || 30))
          : name === 'log_payout'
            ? JSON.stringify(args.remove ? await removePayout(args.date) : await logPayout(args))
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
            ? JSON.stringify(args.routines ? { ...(await hevySummary(Number(args.workouts) || 10)), ...(await hevyRoutines()) } : await hevySummary(Number(args.workouts) || 10))
          : name === 'hevy_edit'
            ? JSON.stringify(await hevyEdit(args))
          : name === 'week'
            ? JSON.stringify(await weekView())
          : name === 'complete_tasks'
            ? await completeTasks(args)
          : name === 'delete_tasks'
            ? await deleteTasks(args)
          : name === 'list_tasks'
            ? JSON.stringify(tasksOf(await readMirror(), { all: !!args.all }).filter((t) => !args.priority || (args.priority === 'none' ? !t.priority : t.priority === 'P' + priOf(args.priority))))
          : name === 'update_tasks'
            ? await updateTasks(args)
          : name === 'read_journal'
            ? JSON.stringify(journalOf(await readMirror(), { from: args.from, to: args.to, limit: Math.min(200, Number(args.limit) || 30) }))
          : name === 'edit_journal'
            ? await editJournal(args)
          : name === 'disciplines'
            ? JSON.stringify(disciplinesOf(await readMirror(), Math.min(60, Number(args.days) || 7)))
          : name === 'tick'
            ? await tick(args)
          : name === 'goals'
            ? JSON.stringify(goalsOf(await readMirror()))
          : name === 'summary'
            ? JSON.stringify(await summary())
          : name === 'remove_log'
            ? JSON.stringify(await removeLog(args))
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
