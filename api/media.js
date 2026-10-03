// Vision board media (videos) in Vercel Blob.
// Files are encrypted in the browser before upload, so the store only ever holds
// unreadable bytes. Uploads go browser -> Blob directly (client upload); this
// endpoint just hands out upload tokens and deletes, and only to a device that
// proved it knows the PIN (media secret = HMAC(pepper), derived at unlock).
import { handleUpload } from '@vercel/blob/client';
import { del } from '@vercel/blob';
import { createHmac, timingSafeEqual } from 'crypto';

export const config = { maxDuration: 30 };

const MAX_BYTES = 100 * 1024 * 1024;

function expectedSecret() {
  const pepper = process.env.MOOS_PEPPER || '';
  return pepper ? createHmac('sha256', pepper).update('mo-os-media-v1').digest('hex') : '';
}
function secretOk(s) {
  const e = expectedSecret();
  if (!e || typeof s !== 'string') return false;
  const a = Buffer.from(s), b = Buffer.from(e);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch (_) { body = {}; } }
  body = body || {};

  if (body.action === 'delete') {
    if (!secretOk(body.secret)) { res.status(401).json({ error: 'Not authorized' }); return; }
    const url = String(body.url || '');
    if (!/^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/vision\//i.test(url)) { res.status(400).json({ error: 'Bad url' }); return; }
    try { await del(url); res.status(200).json({ ok: true }); }
    catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
    return;
  }

  try {
    const json = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        if (!secretOk(clientPayload)) throw new Error('Not authorized');
        if (!/^vision\/[\w-]+\.bin$/.test(pathname)) throw new Error('Bad path');
        return {
          allowedContentTypes: ['application/octet-stream'],
          maximumSizeInBytes: MAX_BYTES,
          addRandomSuffix: true
        };
      },
      onUploadCompleted: async () => {}
    });
    res.status(200).json(json);
  } catch (e) {
    res.status(400).json({ error: String((e && e.message) || e) });
  }
}
