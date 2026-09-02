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
    let combined = ordered.map(n => {
      const name = (n.aiTemplate && n.aiTemplate.name) || '';
      const body = clean(n.noteText);
      return /^#/.test(body) ? body : ('## ' + name + '\n\n' + body);
    }).join('\n\n\n').trim();

    // lift Key Takeaways and Next Steps sections out of the body — they get their own UI sections
    const cutAll = (txt, titleRe) => {
      const re = new RegExp('^#{1,4}\\s*(?:' + titleRe + ')[^\\n]*$\\n?([\\s\\S]*?)(?=^#{1,4}\\s|(?![\\s\\S]))', 'gim');
      const items = [];
      const body = txt.replace(re, (m, sec) => {
        sec.split(/\n/).forEach(l => {
          const t = l.trim().replace(/^[-•*]\s+/, '');
          if (t.length > 3) items.push(t);
        });
        return '';
      });
      return { body: body.replace(/\n{3,}/g, '\n\n\n').trim(), items };
    };
    const dedup = arr => {
      const seen = new Set();
      return arr.filter(t => { const k = t.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    };
    const tk = cutAll(combined, 'key\\s*take\\s*aways?|key\\s*points');
    combined = tk.body;
    const ns = cutAll(combined, 'next\\s*steps?|action\\s*items?');
    combined = ns.body;
    const notes = combined;
    const takeaways = dedup(tk.items);
    const nextSteps = dedup(ns.items);

    const clips = (n.noteClips && n.noteClips.clips) || [];
    const clipActions = clips
      .filter(c => c.note && c.note.bookmark && c.note.bookmark.action_item && (c.note.text || '').trim())
      .map(c => {
        const t = c.note.text.trim();
        const who = (c.note.actionItemAssigneeName || '').trim();
        return who ? t + ' — ' + who : t;
      });
    const actions = clipActions.length ? clipActions : nextSteps;

    res.status(200).json({ notes, actions, takeaways });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
}
