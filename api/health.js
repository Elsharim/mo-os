// POST /api/health
// - Health Auto Export: header x-api-key (HMAC of WHOOP_STORE_SECRET). Apple Health days.
// - iPhone shortcut: Authorization: Bearer HEALTH_TOKEN, or ?key=. Calories, macros, weight.
import { timingSafeEqual } from 'crypto';
import { ingestAny } from './_health.js';
import { ingestApple, isAutoExport, keyOk } from './_apple.js';

function header(req, name) {
  const v = req.headers && req.headers[name];
  return String((Array.isArray(v) ? v[0] : v) || '').trim();
}

function foodAuthed(req) {
  const tok = process.env.HEALTH_TOKEN || '';
  const h = String(req.headers.authorization || '');
  const given = h.startsWith('Bearer ') ? h.slice(7).trim() : String((req.query && req.query.key) || '');
  const a = Buffer.from(given), b = Buffer.from(tok);
  return !!tok && a.length === b.length && timingSafeEqual(a, b);
}

function parseBody(req) {
  if (typeof req.body !== 'string') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch (_) { return undefined; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  const apiKey = header(req, 'x-api-key');
  if (apiKey) {
    let ok = false;
    try { ok = keyOk(apiKey); } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) });
      return;
    }
    if (!ok) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const body = parseBody(req);
    if (body === undefined || !isAutoExport(body)) {
      res.status(400).json({ error: 'Expected Health Auto Export JSON ({ data: { metrics } }).' });
      return;
    }
    try {
      res.status(200).json({ ok: true, ...(await ingestApple(body)) });
    } catch (e) {
      const msg = String((e && e.message) || e);
      res.status(/store /.test(msg) ? 500 : 400).json({ error: msg });
    }
    return;
  }

  if (!foodAuthed(req)) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const body = parseBody(req);
  try {
    const saved = await ingestAny(body || {});
    res.status(200).json({ ok: true, saved });
  } catch (e) {
    res.status(400).json({ error: String((e && e.message) || e) });
  }
}
