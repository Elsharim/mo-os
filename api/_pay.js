// Mo's pay, read from the sales tracker's notebook (poppy/obtracker:Mo in the shared Firestore copy that
// production refreshes) with the same commission rules as his /mo pay tab (mo-desk src/pay.js + paytab.jsx).
// If /mo's rules change, change them here too.
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyCYCt9-opphzCOSInAaPnrGIBN8M6kWW-Y';
const DOC = 'https://firestore.googleapis.com/v1/projects/poppy-sales/databases/(default)/documents/poppy/obtracker:Mo';
const ME = 'Mo', BASE_MONTH = 3000;
const n = (v) => { const x = typeof v === 'number' ? v : v != null && v !== '' ? parseFloat(v) : NaN; return isFinite(x) ? x : 0; };
const SET = 0.05, CLOSE = 0.08, BOTH = 0.13, TRIAGE = 0.03, LIFE = 0.15, LIFE_FROM = '2026-09-26', TRIAGE_START = '2026-09-15';
const refunded = (r) => !!(r && r.refundedOn);
const triage = (r) => !!(r && (r.triage || (r.bookedVia === 'Self' && (r.date || '') >= TRIAGE_START)));
const kindOf = (r) => (r && r.kind === 'Close' && r.setBy && r.setBy === ME && !r.setBy2 ? 'Both' : (r ? r.kind : ''));
const numSet = (v) => v !== '' && v != null && isFinite(Number(v));
const isLife = (r) => !!r && /lifetime|poppy for life/i.test(String(r.soldOn || '')) && String(r.date || '') >= LIFE_FROM;
export function earn(r) {
  if (refunded(r)) return 0;
  if (numSet(r.commOverride)) return n(r.commOverride);
  const cc = n(r.cc);
  if (numSet(r.commRate)) return cc * (n(r.commRate) / 100);
  const k = kindOf(r);
  if (k !== 'Set' && isLife(r)) return cc * (k === 'Both' ? LIFE + SET : LIFE);
  return k === 'Set' ? cc * (triage(r) ? TRIAGE : SET) : k === 'Close' ? cc * CLOSE : cc * BOTH;
}
export async function loadDeals() {
  const r = await fetch(`${DOC}?key=${API_KEY}`);
  if (!r.ok) throw new Error('tracker read ' + r.status);
  const v = (((await r.json()).fields || {}).v || {}).stringValue || '{}';
  const o = JSON.parse(v);
  return { comms: (o.comms || []).filter((x) => x && x.id) };
}
// Commission between two dates (inclusive) plus the base for that many days.
export async function payBetween(from, to) {
  const { comms } = await loadDeals();
  const rows = comms.filter((r) => (r.date || '') >= from && (r.date || '') <= to);
  const counted = (r) => ['Set', 'Close', 'Both'].includes(kindOf(r)); // same buckets as /mo's payTotals
  const commission = Math.round(rows.reduce((a, r) => a + (counted(r) ? earn(r) : 0), 0) * 100) / 100;
  const cc = rows.reduce((a, r) => a + (refunded(r) ? 0 : n(r.cc)), 0);
  const days = Math.round((Date.parse(to + 'T12:00:00Z') - Date.parse(from + 'T12:00:00Z')) / 864e5) + 1;
  const base = Math.round(BASE_MONTH * 12 / 365 * days);
  return { from, to, commission, base, total: Math.round(commission + base), deals: rows.filter((r) => !r.paymentOf).length, cc: Math.round(cc), currency: 'USD',
    biggest: rows.slice().sort((a, b) => earn(b) - earn(a)).slice(0, 3).map((r) => ({ name: r.name, date: r.date, cc: n(r.cc), earned: Math.round(earn(r)) })) };
}
