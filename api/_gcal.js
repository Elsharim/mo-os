// Google Calendar, connected directly (OAuth) so nothing in Mo's Google account
// has to keep running. Tokens live in Firestore (poppy/osgcal:Mo) encrypted with
// WHOOP_STORE_SECRET, which only exists in Vercel.
import { webcrypto, createHash, createHmac } from 'crypto';

const subtle = (globalThis.crypto || webcrypto).subtle;
const rand = (n) => (globalThis.crypto || webcrypto).getRandomValues(new Uint8Array(n));
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyCYCt9-opphzCOSInAaPnrGIBN8M6kWW-Y';
const DOC_URL = 'https://firestore.googleapis.com/v1/projects/poppy-sales/databases/(default)/documents/poppy/osgcal:Mo';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';
export const REDIRECT = 'https://mo-os-omega.vercel.app/api/gcal/callback';
const SCOPES = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events';

export const configured = () => !!(process.env.GCAL_CLIENT_ID && process.env.GCAL_CLIENT_SECRET);

async function storeKey() {
  const s = process.env.WHOOP_STORE_SECRET || '';
  if (!s) throw new Error('WHOOP_STORE_SECRET missing');
  return subtle.importKey('raw', createHash('sha256').update('gcal:' + s).digest(), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
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

const stateFor = (b) => createHmac('sha256', process.env.WHOOP_STORE_SECRET || '').update('gcal-state:' + b).digest('hex').slice(0, 12);
const bucket = () => Math.floor(Date.now() / 6e5);
export const connectUrl = () => {
  const q = new URLSearchParams({ client_id: process.env.GCAL_CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPES, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state: stateFor(bucket()) });
  return `${AUTH_URL}?${q}`;
};
export const stateOk = (s) => s === stateFor(bucket()) || s === stateFor(bucket() - 1);

async function tokenRequest(params) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GCAL_CLIENT_ID, client_secret: process.env.GCAL_CLIENT_SECRET, ...params })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) { const e = new Error('Google token error ' + r.status + ' ' + (j.error || '')); e.code = j.error; throw e; }
  return j;
}
const fromTokens = (j, prev) => ({ ...(prev || {}), access: j.access_token, refresh: j.refresh_token || (prev && prev.refresh), exp: Date.now() + (j.expires_in || 3600) * 1000, bad: null });

// The first Google account to connect owns this; later connects must match.
export async function finishConnect(code) {
  const j = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT });
  const list = await (await fetch(`${API}/users/me/calendarList?minAccessRole=reader`, { headers: { Authorization: 'Bearer ' + j.access_token } })).json();
  const primary = (list.items || []).find((c) => c.primary) || {};
  const prev = await load().catch(() => null);
  if (prev && prev.owner && primary.id && String(prev.owner) !== String(primary.id)) throw new Error('This MO OS is already linked to a different Google account.');
  if (!j.refresh_token && !(prev && prev.refresh)) throw new Error('Google did not hand back a long-lived token. Remove MO OS at myaccount.google.com/permissions and connect again.');
  await save(fromTokens(j, { owner: primary.id || (prev && prev.owner) || '', tz: primary.timeZone || (prev && prev.tz) || '' }));
  return primary.id || 'you';
}

async function accessToken() {
  let s = await load();
  if (!s || !s.refresh) return null;
  if (s.exp - Date.now() > 60e3) return s.access;
  try {
    const j = await tokenRequest({ grant_type: 'refresh_token', refresh_token: s.refresh });
    s = fromTokens(j, s);
    await save(s);
    return s.access;
  } catch (e) {
    const again = await load();
    if (again && again.exp - Date.now() > 60e3) return again.access;
    if (e.code === 'invalid_grant') { await save({ ...s, bad: 'reconnect' }).catch(() => {}); }
    throw e;
  }
}

export async function status(withCalendars) {
  const s = await load().catch(() => null);
  if (!s || !s.refresh) return { connected: false, configured: configured() };
  const out = { connected: !s.bad, configured: true, owner: s.owner || '', needs_reconnect: s.bad === 'reconnect', tz: s.tz || '', only: s.only || null };
  if (withCalendars) {
    try {
      const tok = await accessToken();
      const list = await call(tok, 'GET', '/users/me/calendarList', { minAccessRole: 'reader' });
      out.calendars = (list.items || []).map((c) => ({ id: c.id, name: c.summary || '', role: c.accessRole, primary: !!c.primary, selected: c.selected !== false, used: useCal(c, s) }));
    } catch (e) { out.calendars_error = String(e.message || e); }
  }
  return out;
}
// Which calendars count: an explicit list if Mo set one, else the ones he owns.
function useCal(c, s) {
  if (s && Array.isArray(s.only) && s.only.length) return s.only.includes(c.id) || s.only.includes(c.summary);
  return c.accessRole === 'owner' && !/holiday|birthday|weather/i.test(c.summary || '');
}
export async function setOnly(names) {
  const s = await load();
  if (!s) throw new Error('not connected');
  s.only = Array.isArray(names) ? names.filter(Boolean) : null;
  await save(s);
  return s.only;
}
export const isConnected = async () => { const s = await status(); return s.connected; };

async function call(tok, method, path, params, body) {
  const r = await fetch(`${API}${path}${params ? '?' + new URLSearchParams(params) : ''}`, {
    method, headers: { Authorization: 'Bearer ' + tok, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Google ' + path + ' ' + r.status + ' ' + ((j.error && j.error.message) || ''));
  return j;
}

// Every event on Mo's selected calendars between two times, recurring ones expanded.
export async function listEvents(fromMs, toMs) {
  const tok = await accessToken();
  if (!tok) return null;
  const s = await load();
  const list = await call(tok, 'GET', '/users/me/calendarList', { minAccessRole: 'reader' });
  const cals = (list.items || []).filter((c) => useCal(c, s));
  const out = [];
  await Promise.all(cals.map(async (c) => {
    const ev = await call(tok, 'GET', `/calendars/${encodeURIComponent(c.id)}/events`, {
      timeMin: new Date(fromMs).toISOString(), timeMax: new Date(toMs).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '250', showDeleted: 'false'
    }).catch(() => ({ items: [] }));
    for (const e of ev.items || []) {
      if (e.status === 'cancelled') continue;
      if (e.attendees && e.attendees.some((a) => a.self && a.responseStatus === 'declined')) continue;
      const allDay = !!(e.start && e.start.date && !e.start.dateTime);
      const start = e.start ? (e.start.dateTime || e.start.date) : null;
      const end = e.end ? (e.end.dateTime || e.end.date) : null;
      if (!start) continue;
      out.push({ id: e.id, cal: c.summary || '', title: e.summary || 'Busy', start, end, allDay, primary: !!c.primary });
    }
  }));
  return out;
}

export async function createEvent({ title, start_iso, end_iso }) {
  const tok = await accessToken();
  if (!tok) throw new Error('Google Calendar not connected');
  const s = await load();
  const e = await call(tok, 'POST', '/calendars/primary/events', null, {
    summary: title, start: { dateTime: start_iso, timeZone: s.tz || undefined }, end: { dateTime: end_iso, timeZone: s.tz || undefined }, description: 'from MO OS'
  });
  return e.id;
}

// Delete the primary-calendar event with this title starting within a minute of start_iso.
export async function deleteEvent({ title, start_iso }) {
  const tok = await accessToken();
  if (!tok) throw new Error('Google Calendar not connected');
  const at = Date.parse(start_iso);
  const ev = await call(tok, 'GET', '/calendars/primary/events', { timeMin: new Date(at - 6e4).toISOString(), timeMax: new Date(at + 6e4).toISOString(), singleEvents: 'true', maxResults: '20' });
  const hit = (ev.items || []).find((e) => (e.summary || '').trim().toLowerCase() === String(title).trim().toLowerCase());
  if (!hit) return false;
  await call(tok, 'DELETE', `/calendars/primary/events/${encodeURIComponent(hit.id)}`);
  return true;
}
