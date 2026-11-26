// Atyahara accounting stock, in pieces, by customs category (Sir, 26 Nov 2026).
//
// Atyahara buys from Nikhil Gems in bulk and sells piece by piece. The stock book is
// worked out from the documents themselves, so it can never drift:
//   + every NG invoice billed to Atyahara (and any Atyahara purchase bill)
//   − every Atyahara sales invoice
//   ± manual adjustments kept on each category
// A sale line counts against the category it is linked to (item.acctStockId, set in
// the orders flow's stock step) or, when not linked, the category its customs
// description points to. Cancelled and proforma invoices are left out.
//
// Pure functions only (no React, no Supabase), so scripts can import this too.

export const AT_ACC_STOCK_KEY = "at-acc-stock-v1";
// The book opens with NG-62-2025/26 (25 Feb 2026), the bulk lot Atyahara has sold from
// since. Earlier NG bills were bought one order at a time and are long sold.
export const ATY_STOCK_FROM = "2026-02-25";
export const ATY_GSTIN = "27BCVPJ2000F1ZU";

// The 11 customs descriptions are the categories. Same table as ng-customs-descs-v1.
export const DEFAULT_ATY_CATEGORIES = [
  { desc: "Natural agate stone, cut and polished, roughly shaped", shape: "Palmstone, Tumbled, Flatstone, Slice, Sticks, Cabochon" },
  { desc: "Natural agate stone, sawn and polished into sphere, roughly shaped", shape: "Sphere" },
  { desc: "Natural Agate, cut into heart form, roughly shaped", shape: "Heart" },
  { desc: "Natural Agate, traditionally cut and polished, roughly shaped", shape: "Shivalingam, Egg" },
  { desc: "Natural agate, hollowed and polished, roughly shaped", shape: "Bowl" },
  { desc: "Natural agate, hand-shaped and polished, shaped", shape: "Freeform, Carving, Bookend" },
  { desc: "Natural mineral stone specimen, roughly trimmed", shape: "Mineral" },
  { desc: "Natural agate stone, sawn", shape: "Rough, Geodes" },
  { desc: "Natural agate, pointed and polished, roughly shaped", shape: "Wand, Tower, Pendulum, Points, Pyramid" },
  { desc: "Clear quartz, chipped and roughly shaped", shape: "Quartz Chips" },
  { desc: "Natural Agate Stone, Beaded", shape: "Bracelet" },
];
export const UNCATEGORISED = "Uncategorised";
// A mixed lot (NG-62: palmstones, pendulums, carvings…) is not one customs category.
// It sits in its own pool, and any category that sells more than it bought draws the
// shortfall from the pool, so the pool shrinks as those pieces are sold.
export const MIXED_LOT = "Mixed agate shapes (bulk lot)";
const isMixed = line => /\bmix(ed)?\b/i.test([line?.acctDesc, line?.desc].filter(Boolean).join(" "));

const norm = s => String(s || "").toLowerCase().replace(/[^a-z]+/g, " ").replace(/\bpolish\b/g, "polished").replace(/\b(natural|stone|the|and|into)\b/g, " ").replace(/\s+/g, " ").trim();
export const slug = s => norm(s).replace(/ /g, "-").slice(0, 60) || "x";
export const catId = (desc, unit = "pcs") => `atc-${slug(desc)}-${normUnit(unit)}`;

// pcs / PCS / Pc. / NOS → pcs; grams → gm; everything else lower-cased.
export const normUnit = u => {
  const x = String(u || "pcs").trim().toLowerCase().replace(/\.$/, "");
  if (["pc", "pcs", "piece", "pieces", "nos", "no", "p", ""].includes(x)) return "pcs";
  if (["g", "gm", "gms", "gram", "grams"].includes(x)) return "gm";
  if (["kg", "kgs"].includes(x)) return "kg";
  if (["ct", "cts", "carat", "carats"].includes(x)) return "ct";
  return x;
};

// Words in a customs description (or product name) that point to one category.
const KEYWORDS = [
  [/\bsphere|\borb\b|\bball\b/, "sawn and polished into sphere"],
  [/\bheart/, "cut into heart form"],
  [/\bhollowed|\bbowl/, "hollowed and polished"],
  [/\bpointed|\bwand|\btower|\bpendulum|\bpoint\b|\bpoints\b|\bpyramid|\bobelisk|\bgenerator/, "pointed and polished"],
  [/hand ?-?shaped|\bcarv|\bfreeform|\bfree form|\bbookend|\bganesh|\bbuddha|\bskull|\banimal|\bfigur|\bidol/, "hand-shaped and polished"],
  [/\bspecimen|\bmineral\b|\bcluster|\bdruse/, "mineral stone specimen"],
  [/\bbeaded|\bbracelet|\bmala\b|\bnecklace/, "stone, beaded"],
  [/\bchipped|\bchips\b/, "chipped and roughly shaped"],
  [/traditionally|\bshivaling|\blingam|\begg\b/, "traditionally cut"],
  [/\bpalm ?stone|\btumbl|\bflat ?stone|\bslice|\bcabochon|\bstick|\bworry|\bthumb|cut and polished/, "cut and polished, roughly"],
  [/\bsawn\b|\brough\b|\bgeode/, "stone, sawn"],
];

export function makeCategorizer(customsRows) {
  const rows = (Array.isArray(customsRows) && customsRows.length ? customsRows : DEFAULT_ATY_CATEGORIES)
    .filter(r => r && r.desc).map(r => ({ desc: String(r.desc).trim(), shapes: String(r.shape || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean) }));
  const byNorm = new Map(rows.map(r => [norm(r.desc), r.desc]));
  const findByPhrase = phrase => rows.find(r => r.desc.toLowerCase().includes(phrase))?.desc || null;
  const byShape = shape => {
    const want = String(shape || "").trim().toLowerCase().replace(/s$/, "");
    if (!want) return null;
    return rows.find(r => r.shapes.some(s => s.replace(/s$/, "") === want))?.desc || null;
  };
  const byWords = text => {
    const t = String(text || "").toLowerCase();
    if (!t) return null;
    for (const [re, phrase] of KEYWORDS) if (re.test(t)) { const d = findByPhrase(phrase); if (d) return d; }
    return null;
  };
  // Returns { desc, how } — how is "desc" | "shape" | "words" | "none".
  return function categorize(line, { shape = "", title = "" } = {}) {
    const descs = [line?.acctDesc, line?.desc, line?.catDesc].filter(Boolean);
    if (line?._side === "in" && isMixed(line)) return { desc: MIXED_LOT, how: "mixed" };
    for (const d of descs) { const hit = byNorm.get(norm(d)); if (hit) return { desc: hit, how: "desc" }; }
    for (const d of descs) { const hit = byWords(d); if (hit && /natural|agate|quartz|mineral/i.test(d)) return { desc: hit, how: "desc" }; }
    const s = byShape(shape || line?.shape || line?._shape);
    if (s) return { desc: s, how: "shape" };
    for (const t of [line?.customDesc, line?._title, ...descs, title]) { const hit = byWords(t); if (hit) return { desc: hit, how: "words" }; }
    return { desc: UNCATEGORISED, how: "none" };
  };
}

const isVoid = inv => {
  const st = String(inv?.status || "").toLowerCase();
  return st === "cancelled" || st === "canceled" || !!inv?.cancelledAt || String(inv?.type || "").toLowerCase() === "proforma";
};
export const isToAtyahara = inv => {
  const blob = [inv?.buyerName, inv?.buyer, inv?.consigneeName, inv?.buyerGstin].map(x => String(x || "")).join(" ");
  return /atyahara/i.test(blob) || blob.toUpperCase().includes(ATY_GSTIN) || String(inv?.buyerId || "") === "582525000001157005";
};
const r4 = n => +(+n || 0).toFixed(4);

/* Build the stock book. Inputs are the raw stores; `prev` is the current
   at-acc-stock-v1 so manual adjustments and hand-made categories survive. */
export function buildAtyStock({ ngInvoices = [], atInvoices = [], atPurchases = [], ngStock = [], customsRows = [], prev = [], from = ATY_STOCK_FROM, now = new Date().toISOString() }) {
  const categorize = makeCategorizer(customsRows);
  const shapeOf = new Map((ngStock || []).map(s => [s.id, s.shape || ""]));
  const prevById = new Map((Array.isArray(prev) ? prev : []).map(e => [e.id, e]));
  const book = new Map();
  const unsorted = [];
  const entry = (desc, unit) => {
    const id = catId(desc, unit);
    if (!book.has(id)) {
      const p = prevById.get(id);
      book.set(id, { id, desc, unit: normUnit(unit), hsn: "71031029", gst: "0", auto: true, bills: [], outs: [], adjustments: p?.adjustments || [], qty: 0 });
    }
    return book.get(id);
  };
  // Hand-made categories (not built here) keep their entry so links to them still work.
  for (const p of prevById.values()) if (!p.auto) book.set(p.id, { ...p, bills: [], outs: [], qty: 0 });
  // Categories that only hold adjustments (e.g. an opening count) stay too.
  for (const p of prevById.values()) if (p.auto && (p.adjustments || []).length) entry(p.desc, p.unit);

  // + NG invoices billed to Atyahara
  for (const inv of ngInvoices || []) {
    if (isVoid(inv) || !isToAtyahara(inv) || String(inv.date || "") < from) continue;
    for (const it of inv.items || []) {
      const qty = +it.qty || 0;
      if (!qty) continue;
      const c = categorize({ ...it, _side: "in" }, { shape: shapeOf.get(it.stockId) });
      const e = entry(c.desc, it.unit);
      e.bills.push({ src: "ng-invoice", billId: inv.id, billNumber: inv.invNo || "", supplier: "Nikhil Gems", billDate: inv.date || "", lineId: it.id || "", item: it.customDesc || it.acctDesc || "", qty: r4(qty), unit: e.unit, rate: +it.rate || 0, amt: +it.amt || (+it.rate || 0) * qty, how: c.how });
      if (c.how === "none") unsorted.push({ side: "in", doc: inv.invNo, date: inv.date, item: it.customDesc || it.acctDesc || "", qty });
    }
  }
  // + Atyahara purchase bills from anyone else (NG bills arrive as NG invoices above)
  for (const b of atPurchases || []) {
    if (b?.type !== "bill" || /nikhil/i.test(b.supplier || "") || String(b.billDate || "") < from) continue;
    for (const it of b.items || []) {
      if (it.addToAccountingStock === false) continue;
      const qty = +it.qty || 0;
      if (!qty) continue;
      const c = categorize(it);
      const e = entry(c.desc, it.unit);
      e.bills.push({ src: "purchase-bill", billId: b.id, billNumber: b.billNumber || "", supplier: b.supplier || "", billDate: b.billDate || "", lineId: it.id || "", item: it.purchaseDesc || it.desc || "", qty: r4(qty), unit: e.unit, rate: +it.rate || 0, amt: (+it.rate || 0) * qty, how: c.how });
    }
  }
  // − Atyahara sales invoices
  for (const inv of atInvoices || []) {
    if (isVoid(inv) || String(inv.date || "") < from) continue;
    for (const it of inv.items || []) {
      const qty = +(it.acctQty || it.qty) || 0;
      if (!qty) continue;
      let e = it.acctStockId ? book.get(it.acctStockId) : null;
      let how = e ? "linked" : "";
      if (!e) { const c = categorize(it, { shape: it._shape }); e = entry(c.desc, it.unit); how = c.how; }
      e.outs.push({ invId: inv.id, invNo: inv.invNo || "", buyer: inv.buyerName || inv.consigneeName || inv.sourceBuyerName || "", date: inv.date || "", lineId: it.id || "", item: it.customDesc || it._title || it.acctDesc || "", qty: r4(qty), unit: e.unit, how });
      if (how === "none") unsorted.push({ side: "out", doc: inv.invNo, date: inv.date, item: it.customDesc || it.acctDesc || "", qty });
    }
  }
  const out = [...book.values()].map(e => {
    const inQ = e.bills.reduce((s, b) => s + b.qty, 0), outQ = e.outs.reduce((s, o) => s + o.qty, 0), adj = (e.adjustments || []).reduce((s, a) => s + (+a.qty || 0), 0);
    const inV = e.bills.reduce((s, b) => s + (+b.amt || 0), 0);
    return { ...e, qtyIn: r4(inQ), qtyOut: r4(outQ), qtyAdj: r4(adj), qty: r4(inQ - outQ + adj), fromLot: 0, avgCost: inQ ? +(inV / inQ).toFixed(2) : 0, rebuiltAt: now };
  });
  // Shortfalls in a category come out of the mixed lot, oldest first by category name.
  const pool = out.find(e => e.desc === MIXED_LOT && e.unit === "pcs");
  if (pool) {
    pool.toCategories = [];
    for (const e of out) {
      if (e === pool || e.unit !== "pcs" || e.desc === UNCATEGORISED || e.qty >= 0 || pool.qty <= 0) continue;
      const take = r4(Math.min(-e.qty, pool.qty));
      e.fromLot = take; e.qty = r4(e.qty + take);
      pool.qty = r4(pool.qty - take);
      pool.toCategories.push({ id: e.id, desc: e.desc, qty: take });
    }
    pool.qtyToCategories = r4(pool.toCategories.reduce((s, x) => s + x.qty, 0));
  }
  out.sort((a, b) => (a.desc === UNCATEGORISED) - (b.desc === UNCATEGORISED) || a.desc.localeCompare(b.desc) || a.unit.localeCompare(b.unit));
  return { entries: out, unsorted };
}
