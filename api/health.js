// POST /api/health from the iPhone shortcut: today's calories, macros, weight, steps.
import { timingSafeEqual } from 'crypto';
import { ingestAny } from './_health.js';

function authed(req) {
  const tok = process.env.HEALTH_TOKEN || '';
  const h = String(req.headers.authorization || '');
  const given = h.startsWith('Bearer ') ? h.slice(7).trim() : String((req.query && req.query.key) || '');
  const a = Buffer.from(given), b = Buffer.from(tok);
  return !!tok && a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  if (!authed(req)) { res.status(401).json({ error: 'Unauthorized' }); return; }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch (_) { body = {}; } }
  try {
    const saved = await ingestAny(body || {});
    res.status(200).json({ ok: true, saved });
  } catch (e) {
    res.status(400).json({ error: String((e && e.message) || e) });
  }
}
