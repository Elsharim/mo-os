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

    const clean = t => String(t || '')
      .replace(/<a [^>]*>/g, '')
      .replace(/<\/a>/g, '')
      .replace(/\*\*/g, '')
      .trim();

    const allNotes = ((a.aiNotes && a.aiNotes.notes) || []).filter(n => n && n.noteText);
    const generating = ((a.aiNotes && a.aiNotes.notes) || []).some(n => n && n.isGenerating);
    if (!allNotes.length && generating) {
      res.status(200).json({ pending: true, error: 'Fathom is still generating the summary. Try again in a minute.' });
      return;
    }
    // combine every generated note: Enhanced summary first, deeper templates after
    const ordered = allNotes.slice().sort((x, y) => {
      const en = n => (n.aiTemplate && n.aiTemplate.name === 'Enhanced') ? 0 : 1;
      return en(x) - en(y) || (y.noteText || '').length - (x.noteText || '').length;
    });
    const notes = ordered.map(n => {
      const name = (n.aiTemplate && n.aiTemplate.name) || '';
      const body = clean(n.noteText);
      const titled = /^#/.test(body) ? body : ('## ' + name + '\n\n' + body);
      return titled;
    }).join('\n\n\n').trim();

    // takeaways come from whichever note has a Key Takeaways section
    let takeaways = [];
    for (const n of allNotes) {
      const txt = clean(n.noteText);
      const m = txt.match(/^#{1,4}\s*key\s*takeaways\s*$([\s\S]*?)(?=^#{1,4}\s|\n*$(?![\s\S]))/im);
      if (m) {
        takeaways = m[1].split(/\n/).map(l => l.trim().replace(/^[-•*]\s+/, '')).filter(l => l.length > 8);
        if (takeaways.length) break;
      }
    }

    const clips = (n.noteClips && n.noteClips.clips) || [];
    const actions = clips
      .filter(c => c.note && c.note.bookmark && c.note.bookmark.action_item && (c.note.text || '').trim())
      .map(c => {
        const t = c.note.text.trim();
        const who = (c.note.actionItemAssigneeName || '').trim();
        return who ? t + ' — ' + who : t;
      });

    res.status(200).json({ notes, actions, takeaways });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
}
