// /api/whoop/connect  -> sends you to WHOOP to approve
// /api/whoop/callback -> WHOOP sends you back here; tokens get stored
// /api/whoop/data     -> summary JSON (needs the MO OS connector token)
import { timingSafeEqual } from 'crypto';
import { connectUrl, stateOk, finishConnect, whoopSummary, NOT_CONNECTED } from '../_whoop.js';

function authed(req) {
  const tok = process.env.MOOS_MCP_TOKEN || '';
  const h = String(req.headers.authorization || '');
  const given = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  const a = Buffer.from(given), b = Buffer.from(tok);
  return !!tok && a.length === b.length && timingSafeEqual(a, b);
}
const page = (res, code, title, msg) => {
  res.status(code).setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="background:#0e0e10;color:#e8e8ea;font:17px -apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;text-align:center;padding:16px"><div><h2 style="margin:0 0 8px">${title}</h2><p style="color:#a8a8ad">${msg}</p><p><a style="color:#ff7a47" href="/">Open MO OS</a></p></div>`);
};

export default async function handler(req, res) {
  const action = req.query.action;
  try {
    if (action === 'connect') { res.redirect(302, connectUrl()); return; }
    if (action === 'callback') {
      if (req.query.error) { page(res, 400, 'Not connected', 'WHOOP said: ' + String(req.query.error_description || req.query.error).replace(/</g, '')); return; }
      if (!stateOk(String(req.query.state || ''))) { page(res, 400, 'Link expired', 'Open the connect link again.'); return; }
      const name = await finishConnect(String(req.query.code || ''));
      page(res, 200, 'WHOOP connected', `Nice, ${String(name).replace(/</g, '')}. Your sleep and recovery now flow into MO OS.`);
      return;
    }
    if (action === 'data') {
      if (!authed(req)) { res.status(401).json({ error: 'Unauthorized' }); return; }
      const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
      const out = await whoopSummary(days);
      if (!out) { res.status(409).json({ error: NOT_CONNECTED }); return; }
      res.status(200).json(out);
      return;
    }
    res.status(404).json({ error: 'Unknown action' });
  } catch (e) {
    if (action === 'callback') page(res, 500, 'Something broke', String((e && e.message) || e).replace(/</g, ''));
    else res.status(500).json({ error: String((e && e.message) || e) });
  }
}
