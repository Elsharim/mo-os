// MO OS widget core for Scriptable. No secrets here: the small loader script on Mo's phone
// holds the key, downloads this file, and calls it. Edit this file to change the widget.
const URL = "https://mo-os-omega.vercel.app/api/life?view=glance";
const APP = "https://mo-os-omega.vercel.app";

module.exports = async function (KEY) {
  const C = {
    bg1: new Color("#141418"), bg2: new Color("#0a0a0c"), text: new Color("#f4f4f6"), dim: new Color("#8b8b94"),
    faint: new Color("#3a3a42"), track: new Color("#26262c"), orange: new Color("#ff7a47"), teal: new Color("#2dd4bf"),
    green: new Color("#4ade80"), chip: new Color("#ff7a47", 0.16)
  };

  async function load() {
    try {
      const r = new Request(URL); r.headers = { Authorization: "Bearer " + KEY }; r.timeoutInterval = 12;
      const d = await r.loadJSON();
      if (d && d.date) { Keychain.set("moos_glance", JSON.stringify(d)); return d; }
    } catch (e) {}
    try { return JSON.parse(Keychain.get("moos_glance")); } catch (e) { return null; }
  }
  const fmt = (n) => Number(n || 0).toLocaleString();
  const t12 = (hm) => { if (!hm) return ""; let [h, m] = hm.split(":").map(Number); const ap = h < 12 ? "am" : "pm"; h = h % 12 || 12; return h + (m ? ":" + String(m).padStart(2, "0") : "") + ap; };
  const inTxt = (m) => (m == null ? "" : m < 1 ? "now" : m < 60 ? "in " + m + "m" : "in " + Math.floor(m / 60) + "h" + (m % 60 ? " " + (m % 60) + "m" : ""));

  // ring: progress arc drawn as a polyline, value in the middle
  function ring(pct, color, big, small, size) {
    const S = size, lw = S * 0.11, r = (S - lw) / 2, cx = S / 2, cy = S / 2;
    const ctx = new DrawContext(); ctx.size = new Size(S, S); ctx.opaque = false; ctx.respectScreenScale = true;
    const arc = (from, to, col) => {
      const p = new Path(), steps = 90;
      for (let i = 0; i <= steps; i++) { const a = -Math.PI / 2 + (from + (to - from) * i / steps) * Math.PI * 2; const pt = new Point(cx + r * Math.cos(a), cy + r * Math.sin(a)); i ? p.addLine(pt) : p.move(pt); }
      ctx.addPath(p); ctx.setStrokeColor(col); ctx.setLineWidth(lw); ctx.strokePath();
    };
    arc(0, 1, C.track);
    const v = Math.max(0, Math.min(1, pct));
    if (v > 0.005) arc(0, v, color);
    ctx.setTextAlignedCenter();
    ctx.setFont(Font.boldRoundedSystemFont(S * 0.2)); ctx.setTextColor(C.text);
    ctx.drawTextInRect(big, new Rect(0, cy - S * 0.17, S, S * 0.26));
    ctx.setFont(Font.mediumSystemFont(S * 0.1)); ctx.setTextColor(C.dim);
    ctx.drawTextInRect(small, new Rect(0, cy + S * 0.08, S, S * 0.14));
    return ctx.getImage();
  }

  // gym week: 7 dots, Monday first
  function dots(days, w) {
    const n = 7, gap = w * 0.035, d = (w - gap * (n - 1)) / n, H = d + w * 0.09;
    const ctx = new DrawContext(); ctx.size = new Size(w, H); ctx.opaque = false; ctx.respectScreenScale = true;
    const L = ["M", "T", "W", "T", "F", "S", "S"];
    (days || []).forEach((x, i) => {
      const rect = new Rect(i * (d + gap), 0, d, d), p = new Path(); p.addEllipse(rect); ctx.addPath(p);
      ctx.setFillColor(x.gym ? C.green : x.future ? new Color("#1c1c21") : C.track); ctx.fillPath();
      ctx.setTextAlignedCenter(); ctx.setFont(Font.boldSystemFont(d * 0.42)); ctx.setTextColor(x.gym ? new Color("#0a0a0c") : C.dim);
      ctx.drawTextInRect(L[i], new Rect(i * (d + gap), d * 0.27, d, d * 0.5));
    });
    return ctx.getImage();
  }

  function txt(stack, s, size, color, weight) {
    const t = stack.addText(s); t.font = weight === "b" ? Font.boldRoundedSystemFont(size) : weight === "m" ? Font.mediumSystemFont(size) : Font.systemFont(size);
    t.textColor = color || C.text; t.lineLimit = 1; return t;
  }

  function nextBlock(parent, d, big) {
    const s = parent.addStack(); s.layoutVertically();
    const top = s.addStack(); top.layoutHorizontally(); top.centerAlignContent();
    if (d.next) {
      txt(top, t12(d.next.time), big ? 26 : 20, C.text, "b"); top.addSpacer(8);
      const chip = top.addStack(); chip.backgroundColor = C.chip; chip.cornerRadius = 8; chip.setPadding(3, 7, 3, 7);
      txt(chip, inTxt(d.next.in_min), 11, C.orange, "m");
      s.addSpacer(2); txt(s, d.next.title, big ? 13 : 12, C.dim, "m");
    } else { txt(top, "Done for today", big ? 22 : 18, C.text, "b"); s.addSpacer(2); txt(s, "no more calls", 12, C.dim, "m"); }
  }

  function build(d, fam) {
    const w = new ListWidget(); w.url = APP; w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
    const g = new LinearGradient(); g.colors = [C.bg1, C.bg2]; g.locations = [0, 1]; w.backgroundGradient = g;
    if (!d) { w.setPadding(16, 16, 16, 16); txt(w, "MO OS", 14, C.orange, "b"); txt(w, "offline", 12, C.dim); return w; }
    const f = d.food, gym = d.gym;
    const calP = f.cal / (f.cal_target || 1), proP = f.protein / (f.protein_target || 1);

    if (fam === "accessoryRectangular") {
      txt(w, d.next ? t12(d.next.time) + "  " + d.next.title : "Done for today", 13, null, "b");
      txt(w, fmt(f.cal) + " cal · " + f.protein + "g", 12);
      txt(w, "Gym " + gym.week + "/" + gym.target + "  💊 " + (d.supps ? "✓" : "–"), 12);
      return w;
    }
    if (fam === "accessoryCircular") { const i = w.addImage(ring(gym.week / gym.target, Color.white(), gym.week + "/" + gym.target, "gym", 60)); i.imageSize = new Size(60, 60); return w; }
    if (fam === "accessoryInline") { txt(w, (d.next ? t12(d.next.time) + " " + d.next.title + " · " : "") + fmt(f.cal) + " cal", 12); return w; }

    if (fam === "small") {
      w.setPadding(14, 14, 12, 14);
      const top = w.addStack(); top.layoutHorizontally(); top.centerAlignContent();
      const ri = top.addImage(ring(calP, C.orange, fmt(f.cal), "of " + fmt(f.cal_target), 90)); ri.imageSize = new Size(90, 90);
      w.addSpacer(8);
      const b = w.addStack(); b.layoutHorizontally(); b.centerAlignContent();
      txt(b, f.protein + "g", 13, proP >= 1 ? C.green : C.teal, "b"); b.addSpacer(); txt(b, "💊 " + (d.supps ? "✓" : "–"), 12, d.supps ? C.green : C.dim, "m");
      w.addSpacer(6);
      const di = w.addImage(dots(gym.days, 120)); di.imageSize = new Size(120, 22);
      return w;
    }

    // medium and large
    w.setPadding(16, 16, 14, 16);
    const head = w.addStack(); head.layoutHorizontally(); head.centerAlignContent();
    txt(head, new Date().toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }).toUpperCase(), 11, C.dim, "m");
    head.addSpacer(); txt(head, "MO OS", 11, C.orange, "b");
    w.addSpacer(8);

    const row = w.addStack(); row.layoutHorizontally(); row.centerAlignContent();
    nextBlock(row, d, fam === "large");
    row.addSpacer();
    const r1 = row.addImage(ring(calP, C.orange, fmt(f.cal), "cal", 64)); r1.imageSize = new Size(64, 64);
    row.addSpacer(8);
    const r2 = row.addImage(ring(proP, C.teal, f.protein + "g", "protein", 64)); r2.imageSize = new Size(64, 64);

    w.addSpacer(10);
    const gr = w.addStack(); gr.layoutHorizontally(); gr.centerAlignContent();
    const gi = gr.addImage(dots(gym.days, 170)); gi.imageSize = new Size(170, 30);
    gr.addSpacer();
    const meta = gr.addStack(); meta.layoutVertically();
    txt(meta, "Gym " + gym.week + "/" + gym.target, 13, gym.week >= gym.target ? C.green : C.text, "b");
    txt(meta, "💊 " + (d.supps ? "taken" : "not yet"), 11, d.supps ? C.green : C.dim, "m");

    if (fam === "large") {
      w.addSpacer(14);
      if (d.calls && d.calls.left) { txt(w, d.calls.left + " calls left today", 12, C.dim, "m"); w.addSpacer(10); }
      txt(w, "NOW", 11, C.orange, "b"); w.addSpacer(6);
      const list = (d.now || []).slice(0, 4);
      if (!list.length) txt(w, "Nothing urgent 🙌", 14, C.dim, "m");
      for (const t of list) { const r = w.addStack(); r.layoutHorizontally(); r.centerAlignContent(); txt(r, "○", 13, C.orange, "b"); r.addSpacer(8); txt(r, t, 14, C.text, "m"); w.addSpacer(5); }
    }
    w.addSpacer();
    return w;
  }

  const d = await load();
  const fam = config.widgetFamily || "large";
  const widget = build(d, fam);
  if (config.runsInWidget) Script.setWidget(widget);
  else if (fam === "small") await widget.presentSmall(); else if (fam === "medium") await widget.presentMedium(); else await widget.presentLarge();
  Script.complete();
};
