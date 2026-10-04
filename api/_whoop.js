// WHOOP connection: OAuth tokens + data fetch. Tokens live in Firestore
// (poppy/oswhoop:Mo) encrypted with WHOOP_STORE_SECRET, which only exists in Vercel.
import { webcrypto, createHash, createHmac } from 'crypto';

const subtle = (globalThis.crypto || webcrypto).subtle;
const rand = (n) => (globalThis.crypto || webcrypto).getRandomValues(new Uint8Array(n));

const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyCYCt9-opphzCOSInAaPnrGIBN8M6kWW-Y';
const DOC_URL = 'https://firestore.googleapis.com/v1/projects/poppy-sales/databases/(default)/documents/poppy/oswhoop:Mo';
const AUTH_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const API = 'https://api.prod.whoop.com/developer';
export const REDIRECT = 'https://mo-os-omega.vercel.app/api/whoop/callback';
const SCOPES = 'offline read:recovery read:cycles read:workout read:sleep read:profile read:body_measurement';

async function storeKey() {
  const s = process.env.WHOOP_STORE_SECRET || '';
  if (!s) throw new Error('WHOOP_STORE_SECRET missing');
  return subtle.importKey('raw', createHash('sha256').update(s).digest(), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function seal(obj) {
  const iv = rand(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, await storeKey(), new TextEncoder().encode(JSON.stringify(obj)));
  return Buffer.from(iv).toString('base64') + ':' + Buffer.from(new Uint8Array(ct)).toString('base64');
}
async function unseal(s) {
  const [iv, ct] = s.split(':').map((x) => new Uint8Array(Buffer.from(x, 'base64')));
  return JSON.parse(new TextDecoder().decode(await subtle.decrypt({ name: 'AES-GCM', iv }, await storeKey(), ct)));
}
async function load() {
  const r = await fetch(`${DOC_URL}?key=${API_KEY}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('store read ' + r.status);
  const v = (((await r.json()).fields || {}).v || {}).stringValue;
  return v ? unseal(v) : null;
}
async function save(obj) {
  const r = await fetch(`${DOC_URL}?key=${API_KEY}&updateMask.fieldPaths=v`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { v: { stringValue: await seal(obj) } } })
  });
  if (!r.ok) throw new Error('store write ' + r.status);
}

// State must be 8 chars: HMAC of a 10-minute bucket, so no storage is needed.
const stateFor = (b) => createHmac('sha256', process.env.WHOOP_STORE_SECRET || '').update('whoop-state:' + b).digest('hex').slice(0, 8);
const bucket = () => Math.floor(Date.now() / 6e5);
export const connectUrl = () => {
  const q = new URLSearchParams({ client_id: process.env.WHOOP_CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPES, state: stateFor(bucket()) });
  return `${AUTH_URL}?${q}`;
};
export const stateOk = (s) => s === stateFor(bucket()) || s === stateFor(bucket() - 1);

async function tokenRequest(params) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.WHOOP_CLIENT_ID, client_secret: process.env.WHOOP_CLIENT_SECRET, ...params })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('WHOOP token error ' + r.status + ' ' + (j.error || ''));
  return j;
}
const fromTokens = (j, prev) => ({ ...(prev || {}), access: j.access_token, refresh: j.refresh_token || (prev && prev.refresh), exp: Date.now() + (j.expires_in || 3600) * 1000 });

// OAuth callback. The first WHOOP account to connect becomes the owner; later
// connects must be the same person, so nobody else can swap their data in.
export async function finishConnect(code) {
  const j = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT });
  const prof = await (await fetch(`${API}/v2/user/profile/basic`, { headers: { Authorization: 'Bearer ' + j.access_token } })).json();
  const prev = await load().catch(() => null);
  if (prev && prev.owner && String(prev.owner) !== String(prof.user_id)) throw new Error('This MO OS is already linked to a different WHOOP account.');
  await save(fromTokens(j, { owner: prof.user_id, name: prof.first_name || '' }));
  return prof.first_name || 'you';
}

async function accessToken() {
  let s = await load();
  if (!s || !s.refresh) return null;
  if (s.exp - Date.now() > 60e3) return s.access;
  try {
    const j = await tokenRequest({ grant_type: 'refresh_token', refresh_token: s.refresh, scope: 'offline' });
    s = fromTokens(j, s);
    await save(s);
    return s.access;
  } catch (e) {
    // another request may have rotated the token a moment ago
    const again = await load();
    if (again && again.exp - Date.now() > 60e3) return again.access;
    throw e;
  }
}

async function get(tok, path, params) {
  const r = await fetch(`${API}${path}${params ? '?' + new URLSearchParams(params) : ''}`, { headers: { Authorization: 'Bearer ' + tok } });
  if (!r.ok) throw new Error('WHOOP ' + path + ' ' + r.status);
  return r.json();
}

// Local wall-clock time using the offset WHOOP stores with each record.
function local(iso, off) {
  if (!iso) return null;
  const m = /^([+-])(\d\d):(\d\d)$/.exec(off || '');
  const mins = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  const d = new Date(Date.parse(iso) + mins * 6e4);
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) };
}
const hrs = (ms) => (ms ? Math.round((ms / 3.6e6) * 10) / 10 : 0);

export const NOT_CONNECTED = 'WHOOP is not connected yet. Open https://mo-os-omega.vercel.app/api/whoop/connect once and approve.';

// Summary of the last `days` days, newest first.
export async function whoopSummary(days = 7) {
  const tok = await accessToken();
  if (!tok) return null;
  const start = new Date(Date.now() - (days + 1) * 864e5).toISOString();
  const limit = String(Math.min(25, days + 2));
  const [rec, slp, cyc, wo, body] = await Promise.all([
    get(tok, '/v2/recovery', { start, limit }),
    get(tok, '/v2/activity/sleep', { start, limit: '25' }),
    get(tok, '/v2/cycle', { start, limit }),
    get(tok, '/v2/activity/workout', { start, limit: '25' }),
    get(tok, '/v2/user/measurement/body').catch(() => null)
  ]);
  const sleeps = (slp.records || []).filter((s) => !s.nap && s.score_state === 'SCORED').map((s) => {
    const st = (s.score && s.score.stage_summary) || {};
    const asleep = (st.total_in_bed_time_milli || 0) - (st.total_awake_time_milli || 0);
    return {
      id: s.id, bed: local(s.start, s.timezone_offset), woke: local(s.end, s.timezone_offset),
      asleep_h: hrs(asleep), in_bed_h: hrs(st.total_in_bed_time_milli),
      deep_h: hrs(st.total_slow_wave_sleep_time_milli), rem_h: hrs(st.total_rem_sleep_time_milli),
      performance: s.score && s.score.sleep_performance_percentage, consistency: s.score && s.score.sleep_consistency_percentage
    };
  });
  const recovery = (rec.records || []).filter((r) => r.score_state === 'SCORED').map((r) => ({
    sleep_id: r.sleep_id, date: (sleeps.find((s) => s.id === r.sleep_id) || {}).woke?.date || String(r.created_at).slice(0, 10),
    score: Math.round(r.score.recovery_score), hrv: Math.round(r.score.hrv_rmssd_milli), rhr: Math.round(r.score.resting_heart_rate)
  }));
  const strain = (cyc.records || []).filter((c) => c.score).map((c) => ({ date: (local(c.start, c.timezone_offset) || {}).date, strain: Math.round(c.score.strain * 10) / 10, calories: Math.round((c.score.kilojoule || 0) / 4.184) }));
  const workouts = (wo.records || []).filter((w) => w.score_state === 'SCORED').map((w) => ({
    sport: w.sport_name, date: (local(w.start, w.timezone_offset) || {}).date, start: (local(w.start, w.timezone_offset) || {}).time,
    minutes: Math.round((Date.parse(w.end) - Date.parse(w.start)) / 6e4), strain: Math.round(w.score.strain * 10) / 10
  }));
  return {
    today: { recovery: recovery[0] || null, sleep: sleeps[0] || null, strain: strain[0] || null, workouts_today: workouts.filter((w) => strain[0] && w.date === strain[0].date) },
    recovery, sleep: sleeps, strain, workouts,
    weight_kg: body && body.weight_kilogram ? Math.round(body.weight_kilogram * 10) / 10 : null
  };
}
