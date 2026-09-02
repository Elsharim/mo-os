// Pulls call notes + action items straight from a Fathom share link.
export const config = { maxDuration: 60 };
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

    let [a, n] = await Promise.all([part('aiNotes'), part('noteClips')]);

    // ask Fathom to generate the deep templates if this call doesn't have them yet
    const WANT = [49, 46]; // One-on-One, Q&A
    const notesOf = x => (x.aiNotes && x.aiNotes.notes) || [];
    const createPath = a.aiNotes && a.aiNotes.actions && a.aiNotes.actions.createUrl;
    if (createPath) {
      const createUrl = createPath.startsWith('http') ? createPath : 'https://fathom.video' + createPath;
      const have = new Set(notesOf(a).map(x => x.aiTemplate && x.aiTemplate.id));
      const missing = WANT.filter(id => !have.has(id));
      if (missing.length) {
        await Promise.all(missing.map(id => fetch(createUrl, {
          method: 'POST',
          headers: { ...UA, ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ template_id: id })
        }).catch(() => {})));
      }
      // wait for generation to finish (usually 10-30s)
      for (let i = 0; i < 11; i++) {
        const l = notesOf(a);
        const stillGen = l.some(x => x.isGenerating);
        const stillMissing = WANT.some(id => !l.some(x => x.aiTemplate && x.aiTemplate.id === id));
        if (!stillGen && !stillMissing) break;
        await new Promise(r => setTimeout(r, 3000));
        try { a = await part('aiNotes'); } catch (_) { break; }
      }
    }

    const clean = t => String(t || '')
      .replace(/<a [^>]*>/g, '')
      .replace(/<\/a>/g, '')
      .replace(/\*\*/g, '')
      .trim();

    const allNotes = ((a.aiNotes && a.aiNotes.notes) || []).filter(x => x && x.noteText && x.isReady);
    const generating = ((a.aiNotes && a.aiNotes.notes) || []).some(x => x && x.isGenerating);
    if (!allNotes.length) {
      res.status(200).json({ pending: true, error: generating ? 'Fathom is writing the notes. Pull again in a minute.' : 'No notes on this call yet.' });
      return;
    }
    // combine every generated note: Enhanced first, then the coaching-relevant templates
    const RANK = { 23: 0, 49: 1, 46: 2 };
    const rank = x => (x.aiTemplate && RANK[x.aiTemplate.id] !== undefined) ? RANK[x.aiTemplate.id] : 3;
    const ordered = allNotes.slice().sort((x, y) => rank(x) - rank(y) || (y.noteText || '').length - (x.noteText || '').length);
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
