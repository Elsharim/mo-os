// Reframes a self-limiting thought into its empowering opposite via Groq (free tier).
export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  let text = '';
  try { text = String((req.body && req.body.text) || '').trim().slice(0, 600); } catch (_) {}
  if (!text) { res.status(400).json({ error: 'No text' }); return; }

  const key = process.env.GROQ_KEY;
  if (!key) { res.status(503).json({ error: 'AI not configured' }); return; }

  const sys = `You reframe a person's self-limiting or negative thought into its empowering opposite.
Rules:
- Output ONE sentence only. First person. Present tense.
- Fully invert the meaning: turn the limitation into a strength or truth, on the SAME topic.
- Be specific and grounded, not generic hype. Believable, like something a sharp mentor would say.
- Under 26 words. No emojis, no quotation marks, no preamble, no "here is". Just the sentence.`;

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        temperature: 0.7,
        max_tokens: 300,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: text }
        ]
      })
    });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 200);
      res.status(502).json({ error: 'AI error ' + r.status, detail });
      return;
    }
    const j = await r.json();
    let out = ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
    out = out.replace(/^["'`]+|["'`]+$/g, '').replace(/\s*\n+\s*/g, ' ').trim();
    if (!out) { res.status(502).json({ error: 'Empty AI response' }); return; }
    res.status(200).json({ reframe: out });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
}
