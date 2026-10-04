// /api/hevy/webhook: Hevy calls this when a workout is saved. The workout is
// sealed into the MO OS inbox; the app then checks off matching gym tasks.
import { timingSafeEqual } from 'crypto';
import { getWorkout } from '../_hevy.js';
import { sealToInbox } from '../mcp.js';

function authed(req) {
  const tok = process.env.HEVY_WEBHOOK_SECRET || '';
  const a = Buffer.from(String(req.headers.authorization || '')), b = Buffer.from('Bearer ' + tok);
  return !!tok && a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.query.action !== 'webhook') { res.status(404).json({ error: 'Unknown action' }); return; }
  if (req.method !== 'POST') { res.status(405).end(); return; }
  if (!authed(req)) { res.status(401).json({ error: 'Unauthorized' }); return; }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  const id = body && (body.workoutId || (body.payload && body.payload.workoutId));
  if (!id) { res.status(200).json({ ok: true, skipped: 'no workoutId' }); return; }
  try {
    const w = await getWorkout(id);
    await sealToInbox([{ kind: 'workout', text: w.title || 'Workout', exercises: (w.exercises || []).length, src: 'Hevy' }]);
    res.status(200).json({ ok: true });
  } catch (e) {
    // still 200 so Hevy doesn't retry forever; the workout is in Hevy either way
    res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
