// Exchanges the correct PIN for the encryption pepper. Rate-limited.
import { createHash } from 'crypto';

const attempts = new Map(); // ip -> {count, ts}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  const pepper = process.env.MOOS_PEPPER || '';
  const pinSha = process.env.MOOS_PIN_SHA || '';
  if (!pepper || !pinSha) { res.status(500).json({ error: 'Server not configured' }); return; }

  const ip = String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
  const now = Date.now();
  const rec = attempts.get(ip) || { count: 0, ts: now };
  if (now - rec.ts > 15 * 60 * 1000) { rec.count = 0; rec.ts = now; }
  if (rec.count >= 8) { res.status(429).json({ error: 'Too many attempts. Wait 15 minutes.' }); return; }

  let pin = '';
  try { pin = String((req.body && req.body.pin) || '').trim(); } catch (_) {}
  const ok = /^\d{4}$/.test(pin) && createHash('sha256').update(pin + ':' + pepper).digest('hex') === pinSha;

  if (!ok) {
    rec.count++; rec.ts = now; attempts.set(ip, rec);
    await new Promise(r => setTimeout(r, 1500));
    res.status(401).json({ error: 'Wrong code' });
    return;
  }
  attempts.delete(ip);
  res.status(200).json({ pepper });
}
