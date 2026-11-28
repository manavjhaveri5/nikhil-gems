// Nikhil Gems accounting stock book from 1 Apr 2026 (Sir, 28 Nov 2026).
//
// Worked out from the documents every time, so it can't drift:
//   opening at 1 Apr 2026 = NG's Tally closing at 31 Mar 2026 (the CA's books)
//   + every NG purchase bill from 1 Apr (goods lines; services and packing left out)
//   − every NG sales invoice from 1 Apr (proforma and cancelled left out)
// Kept by unit, the way the CA keeps NG in Tally (AGT-KGS, AGT-PCS, AGT-GMS...): NG buys
// rough by the kg and sells finished pieces, so a book by shape can never balance.
// Grams are counted as kg (weight). Valued at weighted average cost for the year (opening + inwards), as Tally does.
//
// Pure functions only (no React, no Supabase), so scripts can import this too.

export const NG_STOCK_FROM = "2026-04-01";

// Tally company 010044, stock summary at 31 Mar 2026 (decoded 28 Nov 2026), grouped by unit.
// Tally items: kg = AGT-KGS 16,860.508, AGT-TUM 164.57, JAI-KGS 68.59, AGT-CHI 29.63,
// MINR 10.4, AGT-ROU −328.506; pcs = AGT-PCS 377, AGT-WAN 299, JAI-PCS 266, AGT-TRE 202,
// AGT-BOW 53, AJT-BOW 30, New Hook Pendut 11, AGT-Minerals −10, AGT-SET −10;
// gm = Crystal Point 2.03, Tourmaline Point 0.6.
export const NG_OPENING_2026 = [
  { unit: "kg", qty: 16805.192, value: 5203381.24, source: "Tally 31 Mar 2026" },
  { unit: "pcs", qty: 1218, value: 149327.12, source: "Tally 31 Mar 2026" },
  { unit: "gm", qty: 2.63, value: 6480.0, source: "Tally 31 Mar 2026" },
];

export const normNgUnit = u => {
  const x = String(u || "pcs").trim().toLowerCase().replace(/\.$/, "");
  if (["pc", "pcs", "piece", "pieces", "nos", "no", "p", ""].includes(x)) return "pcs";
  if (["g", "gm", "gms", "gram", "grams"].includes(x)) return "gm";
  if (["kg", "kgs", "kilo", "kilograms"].includes(x)) return "kg";
  if (["ct", "cts", "carat", "carats"].includes(x)) return "ct";
  if (["set", "sets"].includes(x)) return "set";
  if (["lot", "lots"].includes(x)) return "lot";
  return x;
};

// Services (99xx), plastic and paper packing (39xx, 48xx) are not stock.
const NOT_STOCK_HSN = /^(99|39|48|49)/;
const isStockLine = it => {
  if (!it || it.addToAccountingStock === false) return false;
  if (NOT_STOCK_HSN.test(String(it.hsn || "").trim())) return false;
  return (+it.qty || 0) !== 0;
};
const r2 = n => Math.round(n * 100) / 100;
const r3 = n => Math.round(n * 1000) / 1000;

export function buildNgStock({ purchases = [], invoices = [], opening = NG_OPENING_2026, from = NG_STOCK_FROM, to = "9999-12-31" } = {}) {
  const book = new Map();
  const row = unit => {
    if (!book.has(unit)) book.set(unit, { unit, openQty: 0, openValue: 0, inQty: 0, inValue: 0, outQty: 0, outSale: {}, ins: [], outs: [] });
    return book.get(unit);
  };
  // Grams are weight like kg: specimens sold by the gram come out of stock bought by the kg.
  const toBook = (u, q) => { const unit = normNgUnit(u); return unit === "gm" ? { unit: "kg", qty: q / 1000, asGm: q } : { unit, qty: q }; };
  for (const o of opening) { const t = toBook(o.unit, +o.qty || 0), r = row(t.unit); r.openQty += t.qty; r.openValue += +o.value || 0; r.openSource = o.source; }
  const skipped = [];
  // The same bill saved more than once (same supplier, number, total and lines) counts once.
  // The copy with payments on it is kept; the others are listed in checks for Sir to delete.
  const bills = purchases.filter(b => b && b.type === "bill" && b.trackAccStock !== false && (b.billDate || "") >= from && (b.billDate || "") <= to);
  const sig = b => [String(b.supplier || "").trim().toLowerCase(), String(b.billNumber || "").trim().toLowerCase(), r2(+b.totalAmount || 0),
    (b.items || []).map(i => `${+i.qty || 0}${normNgUnit(i.unit)}@${+i.rate || 0}`).join(",")].join("|");
  const payRank = b => (b.status === "paid" ? 3 : b.status === "partial" ? 2 : 0) + ((b.payments || []).length ? 1 : 0);
  const groups = new Map();
  for (const b of bills) { const k = /^MISC/i.test(b.billNumber || "") ? `misc|${b.id}` : sig(b); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(b); }
  const checks = [], counted = [];
  for (const g of groups.values()) {
    g.sort((a, b) => payRank(b) - payRank(a) || String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
    counted.push(g[0]);
    if (g.length > 1) checks.push({ kind: "duplicate-bill", doc: g[0].billNumber, party: g[0].supplier, date: g[0].billDate, amount: +g[0].totalAmount || 0, keep: g[0].id, extra: g.slice(1).map(b => b.id) });
  }
  // Same supplier and date, a different number or amount within 0.5%: probably the same bill typed twice.
  for (let i = 0; i < counted.length; i++) for (let j = i + 1; j < counted.length; j++) {
    const a = counted[i], b = counted[j];
    if (/^MISC/i.test(a.billNumber || "") || a.billDate !== b.billDate || String(a.supplier || "").trim().toLowerCase() !== String(b.supplier || "").trim().toLowerCase()) continue;
    const ta = +a.totalAmount || 0, tb = +b.totalAmount || 0, sameNo = String(a.billNumber || "").replace(/^0+/, "").trim().toLowerCase() === String(b.billNumber || "").replace(/^0+/, "").trim().toLowerCase();
    if (sameNo || (ta && Math.abs(ta - tb) / ta < 0.005)) checks.push({ kind: "possible-duplicate", doc: `${a.billNumber} / ${b.billNumber}`, party: a.supplier, date: a.billDate, amounts: [ta, tb], ids: [a.id, b.id] });
  }
  for (const b of counted) {
    const d = b.billDate || "";
    for (const it of b.items || []) {
      if (!isStockLine(it)) { if (+it?.qty) skipped.push({ side: "in", doc: b.billNumber, desc: it.desc, hsn: it.hsn }); continue; }
      const q = +it.qty || 0, { unit, qty, asGm } = toBook(it.unit, q);
      const value = +it.amt || q * (+it.rate || 0);
      const r = row(unit); r.inQty += qty; r.inValue += value;
      r.ins.push({ date: d, doc: b.billNumber || "", billId: b.id, party: b.supplier || "", desc: it.desc || "", hsn: it.hsn || "", qty, asGm, value: r2(value), rate: qty ? r2(value / qty) : 0 });
    }
  }
  for (const x of invoices) {
    if (!x || x.type === "proforma" || x.status === "cancelled") continue;
    const d = x.date || "";
    if (d < from || d > to) continue;
    for (const it of x.items || []) {
      if (!isStockLine(it)) continue;
      const { unit, qty, asGm } = toBook(it.unit, +it.qty || 0);
      const r = row(unit); r.outQty += qty;
      const cur = x.currency || "USD"; r.outSale[cur] = (r.outSale[cur] || 0) + (+it.amt || 0);
      r.outs.push({ date: d, doc: x.invNo || "", invId: x.id, party: x.buyerName || x.consigneeName || "", desc: it.customDesc || it.acctDesc || it.desc || "", qty, asGm, sale: +it.amt || 0, currency: cur });
    }
  }
  // A line far above that unit's usual rate (a typo in the rate or the unit).
  for (const r of book.values()) {
    const rates = r.ins.map(x => x.rate).filter(x => x > 0).sort((a, b) => a - b), med = rates[Math.floor(rates.length / 2)] || 0;
    for (const x of r.ins) if (med && x.rate > med * 50 && x.value > 100000) checks.push({ kind: "rate-outlier", doc: x.doc, party: x.party, billId: x.billId, unit: r.unit, rate: x.rate, usual: med, value: x.value });
  }
  const rows = [...book.values()].map(r => {
    const baseQty = r.openQty + r.inQty, avg = baseQty > 0 ? (r.openValue + r.inValue) / baseQty : 0;
    const closeQty = r.openQty + r.inQty - r.outQty;
    r.ins.sort((a, b) => a.date.localeCompare(b.date)); r.outs.sort((a, b) => a.date.localeCompare(b.date));
    return { ...r, openQty: r3(r.openQty), inQty: r3(r.inQty), outQty: r3(r.outQty), inValue: r2(r.inValue), openValue: r2(r.openValue),
      avgCost: r2(avg), outValue: r2(r.outQty * avg), closeQty: r3(closeQty), closeValue: r2(closeQty * avg), negative: closeQty < -0.0005 };
  }).sort((a, b) => ["kg", "pcs", "ct"].indexOf(a.unit) - ["kg", "pcs", "ct"].indexOf(b.unit) || a.unit.localeCompare(b.unit));
  const total = rows.reduce((s, r) => ({ openValue: s.openValue + r.openValue, inValue: s.inValue + r.inValue, outValue: s.outValue + r.outValue, closeValue: s.closeValue + r.closeValue }), { openValue: 0, inValue: 0, outValue: 0, closeValue: 0 });
  return { from, to, rows, total: Object.fromEntries(Object.entries(total).map(([k, v]) => [k, r2(v)])), skipped, checks };
}
