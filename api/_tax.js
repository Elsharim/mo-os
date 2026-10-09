// 2026 income tax estimate for a self-employed Ontario resident (Mo is a contractor).
// Figures: federal brackets indexed 2% for 2026, Ontario indexed 1.9%, CPP 2026 ceilings.
// This is an estimate for planning, not a filing.
export const TAX_2026 = {
  federal: { brackets: [[58523, 0.14], [117045, 0.205], [181440, 0.26], [258482, 0.29], [Infinity, 0.33]], bpa: 16452, lowRate: 0.14 },
  ontario: { brackets: [[53891, 0.0505], [107785, 0.0915], [150000, 0.1116], [220000, 0.1216], [Infinity, 0.1316]], bpa: 12989, lowRate: 0.0505, surtax: [[5818, 0.20], [7446, 0.36]] },
  cpp: { exemption: 3500, ympe: 74600, rate: 0.119, yampe: 85000, rate2: 0.08 },
  deadlines: { payment: '2027-04-30', filing: '2027-06-15', instalments: ['2026-12-15'] }
};

const bracketTax = (income, brackets) => {
  let tax = 0, lo = 0;
  for (const [hi, rate] of brackets) { if (income <= lo) break; tax += (Math.min(income, hi) - lo) * rate; lo = hi; }
  return tax;
};
const ohp = (ti) => {
  if (ti <= 20000) return 0;
  if (ti <= 36000) return Math.min(300, (ti - 20000) * 0.06);
  if (ti <= 48000) return Math.min(450, 300 + (ti - 36000) * 0.06);
  if (ti <= 72000) return Math.min(600, 450 + (ti - 48000) * 0.25);
  if (ti <= 200000) return Math.min(750, 600 + (ti - 72000) * 0.25);
  return Math.min(900, 750 + (ti - 200000) * 0.25);
};
const r0 = (n) => Math.round(n);

// net = self-employment income after business expenses, CAD
export function estimateTax(net) {
  const T = TAX_2026;
  if (!net || net <= 0) return { net: 0, total: 0, federal: 0, ontario: 0, cpp: 0, ohp: 0, effective_rate: 0 };
  const base = Math.max(0, Math.min(net, T.cpp.ympe) - T.cpp.exemption) * T.cpp.rate;
  const cpp2 = Math.max(0, Math.min(net, T.cpp.yampe) - T.cpp.ympe) * T.cpp.rate2;
  const cpp = base + cpp2;
  // employer half of CPP is a deduction; employee half is a credit at the lowest rate
  const taxable = Math.max(0, net - cpp / 2);
  const fedCredits = (T.federal.bpa + base / 2) * T.federal.lowRate;
  const federal = Math.max(0, bracketTax(taxable, T.federal.brackets) - fedCredits);
  const onCredits = (T.ontario.bpa + base / 2) * T.ontario.lowRate;
  let ontario = Math.max(0, bracketTax(taxable, T.ontario.brackets) - onCredits);
  const surtax = T.ontario.surtax.reduce((s, [thr, rate]) => s + Math.max(0, ontario - thr) * rate, 0);
  ontario += surtax;
  const health = ohp(taxable);
  const total = federal + ontario + health + cpp;
  return { net: r0(net), taxable: r0(taxable), federal: r0(federal), ontario: r0(ontario), surtax: r0(surtax), ohp: r0(health), cpp: r0(cpp), total: r0(total), effective_rate: Math.round((total / net) * 1000) / 10 };
}
