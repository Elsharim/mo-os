// MO OS widgets for Scriptable. No secrets: Mo's loader holds the key, downloads this file and calls it.
// One script, every size. Widget Parameter (long press > Edit Widget > Parameter) picks a view on ANY size:
//   food | gym | next | now | smart (what matters right now) | today | day (timeline)
//   blank = small: smart, medium: today, large: day
const URL = "https://mo-os-omega.vercel.app/api/life?view=glance";
const APP = "https://mo-os-omega.vercel.app";

module.exports = async function (KEY) {
  const hex = (h, a) => new Color(h, a == null ? 1 : a);
  const P = {
    ink: hex("#0b0b0d"), ink2: hex("#1a1411"), text: hex("#f5f5f7"), dim: hex("#ffffff", 0.55), faint: hex("#ffffff", 0.28),
    track: hex("#ffffff", 0.10), trackDark: hex("#ffffff", 0.08), orange: hex("#ff7a47"), orangeD: hex("#ff7a47"),
    green: hex("#ff7a47"), greenD: hex("#0b0b0d"), teal: hex("#ffb02e"), coral: hex("#ff7a47"), coralD: hex("#0b0b0d")
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
  const k = (n) => (n >= 1000 ? (Math.round(n / 100) / 10).toString().replace(/\.0$/, "") + "k" : String(n));
  const t12 = (hm, short) => { if (!hm) return ""; let [h, m] = hm.split(":").map(Number); const ap = h < 12 ? "am" : "pm"; h = h % 12 || 12; return h + (m ? ":" + String(m).padStart(2, "0") : "") + (short ? "" : ap); };
  const inTxt = (m) => (m == null ? "" : m < 1 ? "now" : m < 60 ? "in " + m + "m" : "in " + Math.floor(m / 60) + "h" + (m % 60 ? " " + (m % 60) + "m" : ""));
  const firstName = (s) => String(s || "").replace(/ and Mo.*$| x Mo.*$|Mo Elsharif/gi, "").replace(/^👥\s*/, "").trim();

  function bg(w, top, bottom) { const g = new LinearGradient(); g.colors = [top, bottom]; g.locations = [0, 1]; g.startPoint = new Point(0, 0); g.endPoint = new Point(1, 1); w.backgroundGradient = g; }
  function T(stack, s, size, color, weight, opts) {
    const t = stack.addText(String(s));
    t.font = weight === "heavy" ? Font.heavyRoundedSystemFont(size) : weight === "bold" ? Font.boldRoundedSystemFont(size) : weight === "semi" ? Font.semiboldRoundedSystemFont(size) : Font.mediumRoundedSystemFont(size);
    t.textColor = color || P.text; t.lineLimit = (opts && opts.lines) || 1; if (opts && opts.min) t.minimumScaleFactor = opts.min; return t;
  }
  function label(stack, sym, s, color) {
    const r = stack.addStack(); r.layoutHorizontally(); r.centerAlignContent();
    if (sym) { const im = r.addImage(SFSymbol.named(sym).image); im.imageSize = new Size(11, 11); im.tintColor = color || P.dim; r.addSpacer(4); }
    T(r, s.toUpperCase(), 11, color || P.dim, "bold"); return r;
  }
  function ring(pct, color, track, S, lw) {
    const ctx = new DrawContext(); ctx.size = new Size(S, S); ctx.opaque = false; ctx.respectScreenScale = true;
    const r = (S - lw) / 2, cx = S / 2, cy = S / 2;
    const arc = (to, col) => { const p = new Path(), n = 120; for (let i = 0; i <= n; i++) { const a = -Math.PI / 2 + (to * i / n) * Math.PI * 2, pt = new Point(cx + r * Math.cos(a), cy + r * Math.sin(a)); i ? p.addLine(pt) : p.move(pt); } ctx.addPath(p); ctx.setStrokeColor(col); ctx.setLineWidth(lw); ctx.strokePath(); };
    arc(1, track); const v = Math.max(0, Math.min(1, pct)); if (v > 0.01) arc(v, color);
    if (v > 0.01) { const a = -Math.PI / 2 + v * Math.PI * 2, e = new Path(); e.addEllipse(new Rect(cx + r * Math.cos(a) - lw / 2, cy + r * Math.sin(a) - lw / 2, lw, lw)); ctx.addPath(e); ctx.setFillColor(color); ctx.fillPath(); const s0 = new Path(); s0.addEllipse(new Rect(cx - lw / 2, cy - r - lw / 2, lw, lw)); ctx.addPath(s0); ctx.fillPath(); }
    return ctx.getImage();
  }
  function dots(days, w, on, off, fut) {
    const n = 7, gap = 5, d = Math.min(16, (w - gap * 6) / 7), W = d * 7 + gap * 6;
    const ctx = new DrawContext(); ctx.size = new Size(W, d); ctx.opaque = false; ctx.respectScreenScale = true;
    (days || []).forEach((x, i) => { const p = new Path(); p.addEllipse(new Rect(i * (d + gap), 0, d, d)); ctx.addPath(p); ctx.setFillColor(x.gym ? on : x.future ? fut : off); ctx.fillPath(); });
    return { img: ctx.getImage(), size: new Size(W, d) };
  }
  function overlayCenter(stack, img, size, top, bottom, topSize) {
    const z = stack.addStack(); z.size = size; z.backgroundImage = img; z.layoutVertically(); z.centerAlignContent();
    z.addSpacer(); const a = z.addStack(); a.addSpacer(); T(a, top, topSize, P.text, "heavy", { min: 0.6 }); a.addSpacer();
    if (bottom) { const b = z.addStack(); b.addSpacer(); T(b, bottom, 10, P.dim, "semi"); b.addSpacer(); }
    z.addSpacer(); return z;
  }

  // ---------- small widgets ----------
  function smallFood(w, d) {
    const f = d.food; bg(w, P.ink2, P.ink);
    label(w, "fork.knife", "Food", P.orange); w.addSpacer();
    const row = w.addStack(); row.addSpacer();
    overlayCenter(row, ring(f.cal / (f.cal_target || 1), P.orange, P.trackDark, 82, 9), new Size(82, 82), k(f.cal), "of " + k(f.cal_target), 17);
    row.addSpacer(); w.addSpacer();
    const b = w.addStack(); b.centerAlignContent();
    b.addSpacer(); T(b, f.protein + "g", 13, f.protein >= f.protein_target ? P.green : P.teal, "bold"); T(b, " protein", 11, P.dim, "semi"); b.addSpacer();
  }
  function smallGym(w, d) {
    const g = d.gym; bg(w, P.ink2, P.ink);
    label(w, "dumbbell.fill", "Gym week", P.orange); w.addSpacer();
    const n = w.addStack(); n.bottomAlignContent(); T(n, g.week, 40, P.text, "heavy"); T(n, " /" + g.target, 18, hex("#ffffff", 0.6), "bold");
    T(w, g.today ? "trained today" : g.week >= g.target ? "week done" : (g.target - g.week) + " to go", 12, P.dim, "semi");
    w.addSpacer(10);
    const dd = dots(g.days, 118, P.orange, hex("#ffffff", 0.12), hex("#ffffff", 0.05)); const im = w.addImage(dd.img); im.imageSize = dd.size;
  }
  function smallNext(w, d) {
    bg(w, hex("#2a160c"), P.ink); label(w, "phone.fill", "Next call", P.orange); w.addSpacer();
    if (d.next) {
      const n = w.addStack(); n.bottomAlignContent(); T(n, t12(d.next.time, true), 34, P.text, "heavy"); T(n, d.next.time >= "12:00" ? " pm" : " am", 15, P.dim, "bold");
      T(w, firstName(d.next.title) || "Call", 13, P.text, "bold", { min: 0.7 }); w.addSpacer(6);
      T(w, inTxt(d.next.in_min) + (d.calls && d.calls.left > 1 ? " · " + d.calls.left + " left" : ""), 12, P.orange, "semi");
    } else { T(w, "Done", 38, P.text, "heavy"); T(w, "no more calls today", 12, P.dim, "semi"); w.addSpacer(); }
  }
  function smallNow(w, d) {
    bg(w, P.ink2, P.ink); label(w, "checklist", "Now", P.orange); w.addSpacer(12);
    const list = (d.now || []).slice(0, 2);
    if (!list.length) { T(w, "Nothing urgent", 15, P.text, "bold"); T(w, "you're clear 🙌", 12, P.dim, "semi"); }
    for (const t of list) { const r = w.addStack(); r.topAlignContent(); const c = r.addImage(SFSymbol.named("circle").image); c.imageSize = new Size(12, 12); c.tintColor = P.orange; r.addSpacer(7); T(r, t, 13, P.text, "semi", { lines: 2 }); w.addSpacer(10); }
    w.addSpacer();
  }
  function smart(d) {
    const m = d.next && d.next.in_min != null ? d.next.in_min : 9999;
    if (m <= 180) return "next";
    const hr = new Date().getHours(), f = d.food, behind = f.cal < f.cal_target * Math.min(1, Math.max(0, (hr - 10) / 14)) - 400;
    if (behind) return "food";
    if (!d.gym.today && d.gym.week < d.gym.target && hr >= 10 && hr < 20) return "gym";
    return "food";
  }

  // ---------- medium: today ----------
  function mediumToday(w, d) {
    bg(w, P.ink2, P.ink); const f = d.food, g = d.gym;
    const top = w.addStack(); top.centerAlignContent();
    label(top, null, new Date().toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }), P.dim); top.addSpacer(); T(top, "MO OS", 11, P.orange, "heavy");
    w.addSpacer(8);
    const row = w.addStack(); row.centerAlignContent();
    const L = row.addStack(); L.layoutVertically();
    if (d.next) {
      const a = L.addStack(); a.bottomAlignContent(); T(a, t12(d.next.time), 24, P.text, "heavy"); a.addSpacer(8);
      const chip = a.addStack(); chip.backgroundColor = hex("#ff7a47", 0.18); chip.cornerRadius = 9; chip.setPadding(3, 8, 3, 8); T(chip, inTxt(d.next.in_min), 11, P.orange, "bold");
      T(L, firstName(d.next.title) || "Call", 13, P.dim, "semi");
    } else { T(L, "Done for today", 22, P.text, "heavy"); T(L, "no more calls", 13, P.dim, "semi"); }
    row.addSpacer();
    overlayCenter(row, ring(f.cal / (f.cal_target || 1), P.orange, P.trackDark, 56, 7), new Size(56, 56), k(f.cal), "cal", 13);
    row.addSpacer(10);
    overlayCenter(row, ring(f.protein / (f.protein_target || 1), P.teal, P.trackDark, 56, 7), new Size(56, 56), f.protein + "g", "protein", 13);
    w.addSpacer();
    const b = w.addStack(); b.centerAlignContent();
    const dd = dots(g.days, 130, P.green, P.trackDark, hex("#ffffff", 0.05)); const im = b.addImage(dd.img); im.imageSize = dd.size;
    b.addSpacer(8); T(b, g.week + "/" + g.target, 12, g.week >= g.target ? P.green : P.text, "bold"); b.addSpacer();
    if (d.calls && d.calls.left) T(b, d.calls.left + (d.calls.left === 1 ? " call left" : " calls left"), 11, P.dim, "semi");
  }

  // ---------- large: your day ----------
  function largeDay(w, d) {
    bg(w, P.ink2, P.ink); const f = d.food, g = d.gym;
    const top = w.addStack(); top.topAlignContent();
    const L = top.addStack(); L.layoutVertically();
    label(L, null, new Date().toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }), P.dim); L.addSpacer(3);
    const left = (d.events || []).filter((e) => !e.past).length;
    T(L, left ? left + (left === 1 ? " thing left" : " things left") : "All done today", 24, P.text, "heavy");
    top.addSpacer();
    overlayCenter(top, ring(f.cal / (f.cal_target || 1), P.orange, P.trackDark, 54, 7), new Size(54, 54), k(f.cal), "cal", 12);
    top.addSpacer(6);
    overlayCenter(top, ring(f.protein / (f.protein_target || 1), P.teal, P.trackDark, 54, 7), new Size(54, 54), f.protein + "g", "prot", 12);
    w.addSpacer(18);

    const evs = (d.events || []).slice();
    let shown = evs.filter((e) => !e.past).slice(0, 5); const done = evs.filter((e) => e.past).slice(-Math.max(0, Math.min(2, 5 - shown.length)));
    shown = done.concat(shown);
    if (!shown.length) T(w, "Nothing on the calendar", 14, P.dim, "semi");
    const nextIdx = shown.findIndex((e) => !e.past);
    shown.forEach((e, i) => {
      const r = w.addStack(); r.centerAlignContent();
      const isNext = i === nextIdx;
      const dot = r.addImage(SFSymbol.named(e.past ? "checkmark.circle.fill" : isNext ? "circle.inset.filled" : "circle").image); dot.imageSize = new Size(13, 13); dot.tintColor = e.past ? P.faint : isNext ? P.orange : P.faint;
      r.addSpacer(9);
      const tm = T(r, t12(e.time), 13, e.past ? P.faint : isNext ? P.orange : P.text, "bold"); tm.font = Font.boldRoundedSystemFont(13);
      r.addSpacer(8); T(r, firstName(e.title) || e.title, 13, e.past ? P.faint : P.text, isNext ? "bold" : "semi", { min: 0.8 });
      if (isNext && d.next && d.next.in_min != null) { r.addSpacer(); T(r, inTxt(d.next.in_min), 11, P.orange, "bold"); }
      w.addSpacer(11);
    });
    w.addSpacer();
    const b = w.addStack(); b.centerAlignContent();
    const dd = dots(g.days, 130, P.green, P.trackDark, hex("#ffffff", 0.05)); const im = b.addImage(dd.img); im.imageSize = dd.size;
    b.addSpacer(8); T(b, "gym " + g.week + "/" + g.target, 12, g.week >= g.target ? P.green : P.dim, "bold"); b.addSpacer();
  }

  // ---------- lock screen ----------
  function lock(w, d, fam) {
    const f = d.food, g = d.gym;
    if (fam === "accessoryCircular") {
      const z = w.addStack(); z.size = new Size(64, 64); z.backgroundImage = ring(g.week / g.target, Color.white(), hex("#ffffff", 0.25), 64, 6); z.layoutVertically();
      z.addSpacer(); const a = z.addStack(); a.addSpacer(); T(a, g.week + "/" + g.target, 15, Color.white(), "heavy"); a.addSpacer();
      const b = z.addStack(); b.addSpacer(); const im = b.addImage(SFSymbol.named("dumbbell.fill").image); im.imageSize = new Size(10, 10); im.tintColor = Color.white(); b.addSpacer(); z.addSpacer(); return;
    }
    if (fam === "accessoryInline") { T(w, (d.next ? t12(d.next.time) + " " + firstName(d.next.title) + " · " : "") + k(f.cal) + " cal", 12, Color.white(), "semi"); return; }
    T(w, d.next ? t12(d.next.time) + "  " + (firstName(d.next.title) || "Call") : "No more calls", 14, Color.white(), "heavy");
    T(w, k(f.cal) + " cal · " + f.protein + "g", 12, Color.white(), "semi");
    T(w, "gym " + g.week + "/" + g.target, 12, Color.white(), "semi");
  }

  const d = await load();
  const fam = config.widgetFamily || "large";
  const param = String(args.widgetParameter || "").toLowerCase().trim();
  const w = new ListWidget(); w.url = APP; w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
  if (!d) { bg(w, P.ink2, P.ink); w.setPadding(14, 14, 14, 14); T(w, "MO OS", 14, P.orange, "heavy"); T(w, "can't reach it right now", 12, P.dim, "semi"); }
  else if (fam.startsWith("accessory")) lock(w, d, fam);
  else {
    // the Parameter works on every size: food, gym, next, now, smart, today, day
    const one = { food: smallFood, gym: smallGym, next: smallNext, now: smallNow };
    const p = param.replace(/[^a-z]/g, "");
    if (one[p] || p === "smart" || (fam === "small" && !p)) {
      w.setPadding(fam === "small" ? 16 : 20, fam === "small" ? 16 : 22, fam === "small" ? 16 : 20, fam === "small" ? 16 : 22);
      one[one[p] ? p : smart(d)](w, d);
    } else if (p === "today" || (fam === "medium" && p !== "day")) { w.setPadding(16, 18, 16, 18); mediumToday(w, d); }
    else { w.setPadding(20, 20, 18, 20); largeDay(w, d); }
  }

  if (config.runsInWidget) Script.setWidget(w);
  else if (fam === "small") await w.presentSmall(); else if (fam === "medium") await w.presentMedium(); else await w.presentLarge();
  Script.complete();
};
