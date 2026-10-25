// MO OS widget core for Scriptable. No secrets here: the small loader script on Mo's phone
// holds the key, downloads this file, and calls it. Edit this file to change the widget.
const URL = "https://mo-os-omega.vercel.app/api/life?view=glance";
const APP = "https://mo-os-omega.vercel.app";
module.exports = async function (KEY) {
const C = { bg: new Color("#0b0b0d"), card: new Color("#17171b"), text: Color.white(), dim: new Color("#8a8a93"),
  orange: new Color("#ff7a47"), teal: new Color("#2dd4bf"), green: new Color("#4ade80"), red: new Color("#f87171") };

async function load() {
  try {
    const r = new Request(URL); r.headers = { Authorization: "Bearer " + KEY }; r.timeoutInterval = 12;
    const d = await r.loadJSON();
    if (d && d.date) { Keychain.set("moos_glance", JSON.stringify(d)); return d; }
  } catch (e) {}
  try { return JSON.parse(Keychain.get("moos_glance")); } catch (e) { return null; }
}
const fmt = (n) => Number(n || 0).toLocaleString();
function t12(hm) { if (!hm) return ""; let [h, m] = hm.split(":").map(Number); const ap = h < 12 ? "am" : "pm"; h = h % 12 || 12; return h + (m ? ":" + String(m).padStart(2, "0") : "") + ap; }
function inTxt(m) { if (m == null) return ""; if (m < 1) return "now"; if (m < 60) return "in " + m + "m"; const h = Math.floor(m / 60), r = m % 60; return "in " + h + "h" + (r ? " " + r + "m" : ""); }

function row(stack, label, value, color, size) {
  const s = stack.addStack(); s.layoutHorizontally(); s.centerAlignContent();
  const l = s.addText(label); l.font = Font.mediumSystemFont(size - 2); l.textColor = C.dim;
  s.addSpacer();
  const v = s.addText(value); v.font = Font.boldSystemFont(size); v.textColor = color || C.text;
  stack.addSpacer(4);
}
function bar(stack, pct, color) {
  const w = 120, h = 4, ctx = new DrawContext(); ctx.size = new Size(w, h); ctx.opaque = false; ctx.respectScreenScale = true;
  const bg = new Path(); bg.addRoundedRect(new Rect(0, 0, w, h), 2, 2); ctx.addPath(bg); ctx.setFillColor(new Color("#2a2a30")); ctx.fillPath();
  const fg = new Path(); fg.addRoundedRect(new Rect(0, 0, Math.max(4, w * Math.min(1, pct)), h), 2, 2); ctx.addPath(fg); ctx.setFillColor(color); ctx.fillPath();
  const img = stack.addImage(ctx.getImage()); img.imageSize = new Size(w, h);
}

async function build(d) {
  const fam = config.widgetFamily || "large";
  const w = new ListWidget(); w.backgroundColor = C.bg; w.url = APP; w.setPadding(14, 14, 14, 14);
  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
  if (!d) { const t = w.addText("MO OS offline"); t.textColor = C.dim; return w; }
  const food = d.food, gym = d.gym, gymColor = gym.today ? C.green : (gym.week >= gym.target ? C.green : C.orange);

  if (fam === "accessoryRectangular") {
    w.setPadding(0, 0, 0, 0);
    const a = w.addText(d.next ? t12(d.next.time) + " " + d.next.title : "No more calls"); a.font = Font.boldSystemFont(12); a.lineLimit = 1;
    const b = w.addText(fmt(food.cal) + " cal · " + food.protein + "g"); b.font = Font.systemFont(11);
    const c = w.addText("Gym " + gym.week + "/" + gym.target + (gym.today ? " ✓ today" : "")); c.font = Font.systemFont(11);
    return w;
  }
  if (fam === "accessoryCircular") {
    w.setPadding(0, 0, 0, 0); const t = w.addText(gym.week + "/" + gym.target); t.font = Font.boldSystemFont(16); t.centerAlignText();
    const s = w.addText("gym"); s.font = Font.systemFont(9); s.centerAlignText(); return w;
  }

  const size = fam === "small" ? 13 : 15;
  if (d.next) {
    const n = w.addText(t12(d.next.time) + "  " + inTxt(d.next.in_min)); n.font = Font.boldSystemFont(size + 4); n.textColor = C.orange;
    const nt = w.addText(d.next.title); nt.font = Font.mediumSystemFont(size - 1); nt.textColor = C.text; nt.lineLimit = 1;
  } else { const n = w.addText("No more calls today"); n.font = Font.boldSystemFont(size + 2); n.textColor = C.dim; }
  w.addSpacer(10);

  row(w, "Food", fmt(food.cal) + " / " + fmt(food.cal_target), food.cal >= food.cal_target * 0.9 ? C.green : C.text, size);
  bar(w, food.cal / (food.cal_target || 1), C.orange); w.addSpacer(6);
  row(w, "Protein", food.protein + " / " + food.protein_target + "g", food.protein >= food.protein_target ? C.green : C.text, size);
  bar(w, food.protein / (food.protein_target || 1), C.teal); w.addSpacer(6);
  row(w, "Gym this week", gym.week + " / " + gym.target + (gym.today ? "  ✓" : ""), gymColor, size);
  if (fam !== "small" && d.calls && d.calls.left) row(w, "Calls left today", String(d.calls.left), C.text, size);

  if (fam === "large" && d.now && d.now.length) {
    w.addSpacer(8);
    const h = w.addText("NOW"); h.font = Font.boldSystemFont(11); h.textColor = C.dim; w.addSpacer(4);
    for (const t of d.now) { const x = w.addText("○  " + t); x.font = Font.systemFont(size - 1); x.textColor = C.text; x.lineLimit = 1; w.addSpacer(3); }
  }
  w.addSpacer();
  const f = w.addText("updated " + new Date(d.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })); f.font = Font.systemFont(9); f.textColor = new Color("#55555c");
  return w;
}

const d = await load();
const widget = await build(d);
if (config.runsInWidget) Script.setWidget(widget); else await widget.presentLarge();
Script.complete();
};
