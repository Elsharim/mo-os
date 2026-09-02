// Pulls call notes + action items straight from a Fathom share link.
export default async function handler(req, res) {
  const url = String(req.query.url || '').trim().split('?')[0];
  if (!/^https:\/\/fathom\.video\/share\/[\w-]+$/.test(url)) {
    res.status(400).json({ error: 'Not a fathom.video share link' });
    return;
  }
  const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' };
  try {
    const shell = await fetch(url, { headers: UA, redirect: 'follow' });
    if (!shell.ok) throw new Error('Fathom returned ' + shell.status + ' for the link');
    const setC = typeof shell.headers.getSetCookie === 'function'
      ? shell.headers.getSetCookie()
      : (shell.headers.get('set-cookie') ? [shell.headers.get('set-cookie')] : []);
    const cookie = setC.map(c => c.split(';')[0]).join('; ');

    const part = async names => {
      const r = await fetch(url + '?_inertia=' + Math.random().toString(36).slice(2, 8), {
        headers: {
          ...UA,
          ...(cookie ? { Cookie: cookie } : {}),
          'X-Inertia': 'true',
          'X-Inertia-Partial-Component': 'page-call-detail',
          'X-Inertia-Partial-Data': names,
          'Accept': 'text/html, application/xhtml+xml'
        }
      });
      if (!r.ok) throw new Error('Fathom data fetch failed (' + r.status + ')');
      return (await r.json()).props || {};
    };

    const [a, n] = await Promise.all([part('aiNotes'), part('noteClips')]);

    const note = a.aiNotes && (a.aiNotes.defaultNote || (a.aiNotes.notes || [])[0]);
    if (note && note.isGenerating) {
      res.status(200).json({ pending: true, error: 'Fathom is still generating the summary. Try again in a minute.' });
      return;
    }
    const raw = (note && note.noteText) || '';
    const notes = raw
      .replace(/<a [^>]*>/g, '')
      .replace(/<\/a>/g, '')
      .replace(/\*\*/g, '')
      .trim();

    const clips = (n.noteClips && n.noteClips.clips) || [];
    const actions = clips
      .filter(c => c.note && c.note.bookmark && c.note.bookmark.action_item && (c.note.text || '').trim())
      .map(c => {
        const t = c.note.text.trim();
        const who = (c.note.actionItemAssigneeName || '').trim();
        return who ? t + ' — ' + who : t;
      });

    const title = null;
    res.status(200).json({ notes, actions, title });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
}
