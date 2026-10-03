// Daily backup of MO OS out of the shared Firestore into Mo's own Vercel Blob.
// Everything copied is already ciphertext (state, photos) or public (inbox key),
// so the backup is as unreadable as the original. Runs from Vercel Cron.
import { put, list, del } from '@vercel/blob';
import { timingSafeEqual } from 'crypto';

export const config = { maxDuration: 60 };

const PROJECT = 'poppy-sales';
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyCYCt9-opphzCOSInAaPnrGIBN8M6kWW-Y';
const BASE = `projects/${PROJECT}/databases/(default)/documents`;
const KEEP = 30;

function authed(req) {
  const tok = process.env.CRON_SECRET || '';
  if (!tok) return false;
  const h = String(req.headers.authorization || '');
  const a = Buffer.from(h), b = Buffer.from('Bearer ' + tok);
  return a.length === b.length && timingSafeEqual(a, b);
}

// All docs in poppy/ whose id starts with `prefix` (name range query).
async function docsWithPrefix(prefix) {
  const end = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
  const ref = (id) => ({ referenceValue: `${BASE}/poppy/${id}` });
  const r = await fetch(`https://firestore.googleapis.com/v1/${BASE}:runQuery?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'poppy' }],
        where: { compositeFilter: { op: 'AND', filters: [
          { fieldFilter: { field: { fieldPath: '__name__' }, op: 'GREATER_THAN_OR_EQUAL', value: ref(prefix) } },
          { fieldFilter: { field: { fieldPath: '__name__' }, op: 'LESS_THAN', value: ref(end) } }
        ] } }
      }
    })
  });
  if (!r.ok) throw new Error('Firestore query ' + r.status);
  return (await r.json()).filter((x) => x.document).map((x) => x.document);
}

export default async function handler(req, res) {
  if (!authed(req)) { res.status(401).json({ error: 'Unauthorized' }); return; }
  try {
    const [main, photos, inbox] = await Promise.all([
      docsWithPrefix('os:Mo'), docsWithPrefix('osimg:Mo:'), docsWithPrefix('osinbox:Mo')
    ]);
    const state = main.find((d) => d.name.endsWith('/os:Mo'));
    const v = state && state.fields && state.fields.v && state.fields.v.stringValue;
    const healthy = typeof v === 'string' && v.startsWith('enc1:') && v.length > 1000;

    const docs = {};
    for (const d of [state, ...photos, ...inbox].filter(Boolean)) {
      docs[d.name.split('/').pop()] = { fields: d.fields || {}, updateTime: d.updateTime };
    }
    const day = new Date().toISOString().slice(0, 10);
    const body = JSON.stringify({ at: new Date().toISOString(), healthy, docs });
    const out = await put(`backups/mo-os-${day}.json`, body, {
      access: 'public', contentType: 'application/json', addRandomSuffix: true
    });

    // Prune old copies, but never while today's state looks wrong (wiped or
    // overwritten), so a bad stretch can't push the good backups out.
    let pruned = 0;
    if (healthy) {
      const { blobs } = await list({ prefix: 'backups/' });
      const old = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)).slice(KEEP);
      if (old.length) { await del(old.map((b) => b.url)); pruned = old.length; }
    }
    res.status(200).json({ ok: true, healthy, docs: Object.keys(docs).length, bytes: body.length, pruned, path: out.pathname });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
