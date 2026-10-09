// Money: daily snapshots of Mo's accounts (balances by account + currency) and
// monthly income / spend, pushed by Grok from his Plaid connection (log_money).
// Stored encrypted in Firestore (poppy/osmoney:Mo) with a server-only secret.
import { webcrypto, createHash } from 'crypto';
import { estimateTax, TAX_2026 } from './_tax.js';

const subtle = (globalThis.crypto || webcrypto).subtle;
const rand = (n) => (globalThis.crypto || webcrypto).getRandomValues(new Uint8Array(n));
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyCYCt9-opphzCOSInAaPnrGIBN8M6kWW-Y';
const DOC_URL = 'https://firestore.googleapis.com/v1/projects/poppy-sales/databases/(default)/documents/poppy/osmoney:Mo';
const KEEP_DAYS = 400;
const TYPES = ['cash', 'savings', 'investment', 'crypto', 'tax', 'credit', 'loan', 'other'];

async function key() {
  return subtle.importKey('raw', createHash('sha256').update('money:' + (process.env.WHOOP_STORE_SECRET || '')).digest(), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function load() {
  const r = await fetch(`${DOC_URL}?key=${API_KEY}`);
  if (r.status === 404) return { days: {}, months: {}, settings: {} };
  if (!r.ok) throw new Error('store read ' + r.status);
  const v = (((await r.json()).fields || {}).v || {}).stringValue;
  if (!v) return { days: {}, months: {}, settings: {} };
  const [iv, ct] = v.split(':').map((x) => new Uint8Array(Buffer.from(x, 'base64')));
  const s = JSON.parse(new TextDecoder().decode(await subtle.decrypt({ name: 'AES-GCM', iv }, await key(), ct)));
  s.days = s.days || {}; s.months = s.months || {}; s.settings = s.settings || {};
  return s;
}
async function save(obj) {
  const iv = rand(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, await key(), new TextEncoder().encode(JSON.stringify(obj)));
  const v = Buffer.from(iv).toString('base64') + ':' + Buffer.from(new Uint8Array(ct)).toString('base64');
  const r = await fetch(`${DOC_URL}?key=${API_KEY}&updateMask.fieldPaths=v`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { v: { stringValue: v } } }) });
  if (!r.ok) throw new Error('store write ' + r.status);
}
const num = (x) => { if (x == null || x === '') return null; const n = parseFloat(String(x).replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : null; };
const r2 = (n) => Math.round(n * 100) / 100;

// FX to CAD. Cached per day; falls back to the last known or a rough default.
const FX_DEFAULT = { CAD: 1, USD: 1.37, EUR: 1.5, GBP: 1.75 };
async function fxToCad(s) {
  const today = new Date().toISOString().slice(0, 10);
  if (s.fx && s.fx.date === today) return s.fx.rates;
  try {
    const r = await fetch('https://api.frankfurter.app/latest?from=CAD');
    const j = await r.json();
    const rates = { CAD: 1 };
    for (const [c, v] of Object.entries(j.rates || {})) rates[c] = 1 / v;
    s.fx = { date: today, rates };
    return rates;
  } catch (_) { return (s.fx && s.fx.rates) || FX_DEFAULT; }
}

export async function logMoney(a) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(a.date || '') ? a.date : new Date().toISOString().slice(0, 10);
  const s = await load();
  const rates = await fxToCad(s);
  const accounts = (Array.isArray(a.accounts) ? a.accounts : []).map((x) => {
    const cur = String(x.currency || 'CAD').toUpperCase().slice(0, 3);
    const bal = num(x.balance);
    let type = TYPES.includes(String(x.type || '').toLowerCase()) ? String(x.type).toLowerCase() : 'other';
    if (/\btax\b/i.test(String(x.name || ''))) type = 'tax'; // his tax reserve, not an investment
    return bal == null ? null : {
      name: String(x.name || 'Account').slice(0, 80), institution: String(x.institution || '').slice(0, 60),
      type, currency: cur, balance: r2(bal), cad: r2(bal * (rates[cur] || FX_DEFAULT[cur] || 1))
    };
  }).filter(Boolean);
  if (!accounts.length) throw new Error('Give at least one account with a balance.');
  // liabilities count against net worth
  const nw = accounts.reduce((t, x) => t + (x.type === 'credit' || x.type === 'loan' ? -Math.abs(x.cad) : x.cad), 0);
  s.days[date] = { accounts, net_worth_cad: r2(nw), updated: new Date().toISOString() };
  const keys = Object.keys(s.days).sort();
  keys.slice(0, Math.max(0, keys.length - KEEP_DAYS)).forEach((k) => delete s.days[k]);
  const ym = date.slice(0, 7);
  const m = (s.months[ym] = s.months[ym] || {});
  if (num(a.income_month_cad) != null) m.income = r2(num(a.income_month_cad));
  if (num(a.spent_month_cad) != null) m.spent = r2(num(a.spent_month_cad));
  if (Array.isArray(a.top_spending)) m.top = a.top_spending.slice(0, 8).map((x) => ({ category: String(x.category || '').slice(0, 40), cad: r2(num(x.cad) || 0) }));
  if (a.note) m.note = String(a.note).slice(0, 300);
  await save(s);
  return { date, net_worth_cad: s.days[date].net_worth_cad, accounts: accounts.length, month: { ym, ...m } };
}

export async function setMoneySettings(t) {
  const s = await load();
  for (const k of ['monthly_burn_cad', 'tax_rate', 'runway_goal_months', 'deductions_cad']) if (num(t[k]) != null) s.settings[k] = num(t[k]);
  await save(s);
  return s.settings;
}

export async function moneySummary(days = 90) {
  const s = await load();
  const keys = Object.keys(s.days).sort();
  const latestKey = keys[keys.length - 1];
  const latest = latestKey ? s.days[latestKey] : null;
  if (latest) latest.accounts = (latest.accounts || []).map((x) => (/\btax\b/i.test(x.name || '') ? { ...x, type: 'tax' } : x));
  const hist = keys.slice(-Math.min(400, days)).map((k) => ({ date: k, net_worth_cad: s.days[k].net_worth_cad }));
  const ym = new Date().toISOString().slice(0, 7);
  const month = s.months[ym] || {};
  const months = Object.keys(s.months).sort().slice(-12).map((k) => ({ month: k, ...s.months[k] }));
  const set = { tax_rate: 0.3, ...s.settings };
  const byType = {};
  (latest ? latest.accounts : []).forEach((x) => { byType[x.type] = r2((byType[x.type] || 0) + x.cad); });
  const liquid = (byType.cash || 0) + (byType.savings || 0);
  // what a month costs him: his setting, else the average of full months logged
  const spentMonths = months.filter((m) => m.month !== ym && m.spent != null).slice(-3);
  const burn = set.monthly_burn_cad || (spentMonths.length ? r2(spentMonths.reduce((a, m) => a + m.spent, 0) / spentMonths.length) : null);
  const burnFrom = set.monthly_burn_cad ? 'set' : spentMonths.length ? 'avg' : null;
  const prevKey = keys.filter((k) => k <= new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)).pop();
  const tax = taxPicture(s, byType.tax || 0);
  return {
    tax,
    as_of: latestKey || null,
    net_worth_cad: latest ? latest.net_worth_cad : null,
    change_30d_cad: latest && prevKey ? r2(latest.net_worth_cad - s.days[prevKey].net_worth_cad) : null,
    accounts: latest ? latest.accounts : [],
    by_type_cad: byType,
    liquid_cad: r2(liquid),
    runway_months: liquid && burn ? Math.round((liquid / burn) * 10) / 10 : null,
    burn_cad: burn, burn_from: burnFrom,
    this_month: { month: ym, income_cad: month.income ?? null, spent_cad: month.spent ?? null, saved_pct: month.income && month.spent != null ? Math.round(((month.income - month.spent) / month.income) * 100) : null, top_spending: month.top || [] },
    months,
    settings: set,
    tax_set_aside_cad: month.income ? r2(month.income * set.tax_rate) : null,
    tax_reserve_cad: byType.tax || 0,
    history: hist,
    note: latest ? undefined : 'No money data yet. Grok logs balances from Plaid with log_money.'
  };
}

// Poppy payouts (gross, usually USD, once a month). Converted to CAD at the
// Bank-of-Canada-style daily rate for the payout date (frankfurter.app), cached.
async function fxOn(date, cur) {
  if (cur === 'CAD') return 1;
  try {
    const r = await fetch(`https://api.frankfurter.app/${date}?from=${cur}&to=CAD`);
    const j = await r.json();
    return (j.rates && j.rates.CAD) || null;
  } catch (_) { return null; }
}
export async function logPayout(a) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(a.date || '') ? a.date : null;
  const amount = num(a.amount);
  if (!date || amount == null) throw new Error('Need date (YYYY-MM-DD) and amount.');
  const cur = String(a.currency || 'USD').toUpperCase().slice(0, 3);
  const s = await load();
  s.payouts = s.payouts || [];
  const rate = (await fxOn(date, cur)) || FX_DEFAULT[cur] || 1;
  const rec = { date, amount: r2(amount), currency: cur, cad: r2(amount * rate), rate: Math.round(rate * 10000) / 10000, period: String(a.period || '').slice(0, 40), source: String(a.source || 'Poppy').slice(0, 40) };
  // same date = replace (re-logging a corrected amount)
  s.payouts = s.payouts.filter((p) => p.date !== date).concat(rec).sort((x, y) => x.date.localeCompare(y.date));
  await save(s);
  return rec;
}
export async function removePayout(date) {
  const s = await load();
  const before = (s.payouts || []).length;
  s.payouts = (s.payouts || []).filter((p) => p.date !== date);
  await save(s);
  return { removed: before - s.payouts.length };
}

// The tax picture for the current year: income so far, projected, estimated
// tax, what should be set aside by today vs what is in the tax reserve.
export function taxPicture(s, reserveCad) {
  const year = new Date().getFullYear();
  const set = { tax_rate: 0.3, deductions_cad: 0, ...(s.settings || {}) };
  const pays = (s.payouts || []).filter((p) => p.date.startsWith(String(year)));
  const ytd = r2(pays.reduce((t, p) => t + p.cad, 0));
  // one payout a month, paid around month end (sometimes the first days of the next
  // month), so a payout in the first week counts for the month before
  const periodMonth = (p) => { const d = new Date(p.date + 'T12:00'); if (d.getDate() <= 7) d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); };
  const paidMonths = new Set(pays.map(periodMonth));
  const monthsLeft = Math.max(0, 12 - pays.length);
  const recent = pays.slice(-3);
  const avgRecent = recent.length ? recent.reduce((t, p) => t + p.cad, 0) / recent.length : 0;
  const projected = r2(ytd + monthsLeft * avgRecent);
  const net = Math.max(0, projected - (set.deductions_cad || 0));
  const est = estimateTax(net);
  const share = projected ? ytd / projected : 0;
  const shouldHave = r2(est.total * share);
  const reserve = r2(reserveCad || 0);
  const nextPay = pays.length ? pays[pays.length - 1].cad : avgRecent;
  return {
    year, payouts: pays, payouts_count: pays.length,
    // months whose payout should have landed by now but isn't logged
    missing_months: Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`).filter((m) => !paidMonths.has(m) && m < new Date().toISOString().slice(0, 7)),
    ytd_income_cad: ytd, avg_recent_payout_cad: r2(avgRecent), months_left: monthsLeft, projected_income_cad: projected,
    deductions_cad: set.deductions_cad || 0,
    estimate: est,
    should_have_set_aside_cad: shouldHave, reserve_cad: reserve, gap_cad: r2(reserve - shouldHave),
    set_aside_pct: est.effective_rate ? Math.ceil(est.effective_rate) : null,
    set_aside_next_payout_cad: r2(nextPay * (est.effective_rate / 100)),
    deadlines: TAX_2026.deadlines
  };
}
