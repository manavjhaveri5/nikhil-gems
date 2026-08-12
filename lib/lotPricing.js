/* Lot pricing — a bulk stock card sold on Shopify as one product priced by weight.
 *
 * A 4 kg / 34 pcs lot at $125/kg lists at $500. Sell a piece and the card drops to
 * 3.88 kg, so the listing must become $485 with a description reading the new
 * figures. This module is the single source of that arithmetic.
 *
 * Dependency-free and pure, so `api/shopify.js` and the browser compute identical
 * numbers — a mismatch there would show one price in the preview and publish
 * another.
 *
 * Two distinctions carry real weight here:
 *   • null vs 0 — null means "this card has no weight dimension at all" (so it can
 *     never be a lot), 0 means "the lot is sold out". Collapsing them would list
 *     pcs-only cards at zero.
 *   • empty vs absent tokens — a card with no second unit must not render a
 *     dangling "pcs:" line, so a line whose token is empty is dropped whole.
 */

export const DEFAULT_LOT_TEMPLATE = [
  "{material} — {shape}",
  "kgs: {kg}",
  "pcs: {pcs}",
  "origin: {origin}",
].join("\n");

/* Mirrors normalizeStockUnit in nikhil-gems-v6.jsx:67 — units arrive from imports,
   the Telegram bot and hand entry, so "Kgs"/"kilogram"/"pieces" all appear. */
export function normalizeUnit(u) {
  const s = String(u || "").trim().toLowerCase();
  if (["piece", "pieces", "pc", "pcs"].includes(s)) return "pcs";
  if (["gram", "grams", "g", "gm"].includes(s)) return "gm";
  if (["kilogram", "kilograms", "kgs", "kg"].includes(s)) return "kg";
  if (["carat", "carats", "ct"].includes(s)) return "ct";
  return s;
}

const num = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const round = (n, dp = 2) => {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
};

/* Weight in kg, following the precedence already used for cost-per-kg at
   nikhil-gems-v6.jsx:7907: primary unit, then secondary, then the weightGm field.
   weightGm is deliberately last — nothing recomputes it after an allocation, so it
   goes stale (see the note in the plan).
   Returns null when the card carries no weight dimension at all. */
export function resolveLotKg(item) {
  if (!item) return null;
  const u1 = normalizeUnit(item.unit);
  const u2 = normalizeUnit(item.unit2);
  if (u1 === "kg") return Math.max(0, num(item.qty) ?? 0);
  if (u1 === "gm") return Math.max(0, (num(item.qty) ?? 0) / 1000);
  if (u2 === "kg") return Math.max(0, num(item.qty2) ?? 0);
  if (u2 === "gm") return Math.max(0, (num(item.qty2) ?? 0) / 1000);
  const gm = num(item.weightGm);
  if (gm != null && gm > 0) return Math.max(0, gm / 1000);
  return null;
}

/* Piece count, same idea. Null when the card is measured only by weight. */
export function resolveLotPcs(item) {
  if (!item) return null;
  const u1 = normalizeUnit(item.unit);
  const u2 = normalizeUnit(item.unit2);
  if (u1 === "pcs") return Math.max(0, num(item.qty) ?? 0);
  if (u2 === "pcs") return Math.max(0, num(item.qty2) ?? 0);
  return null;
}

export const isLotCard = item =>
  !!item &&
  item.pricingMode === "lot_by_weight" &&
  resolveLotKg(item) != null &&
  (num(item.pricePerKg) ?? 0) > 0;

/* Price for the whole remaining lot. Cards that aren't set up for lot pricing —
   or have no weight to price against — fall through to today's flat behaviour
   untouched, which is what makes this safe to leave switched off. */
export function computeLotPrice(item) {
  if (!isLotCard(item)) {
    return { mode: "legacy", price: num(item?.listPrice), kg: null, rate: null, belowFloor: false };
  }
  const kg = resolveLotKg(item);
  const rate = num(item.pricePerKg);
  const price = round(kg * rate);
  const floor = num(item.lotMinPrice);
  return {
    mode: "lot",
    price,
    kg,
    rate,
    // A lot worn down to 0.1 kg prices at $12.50 — someone would buy the tail of a
    // $125/kg lot for pocket change. Below the floor it goes sold-out instead.
    belowFloor: floor != null && floor > 0 && price > 0 && price < floor,
  };
}

/* Publish state as a pure function of what's left, so a restock flips the product
   back to active on its own rather than needing a reverse transition somewhere. */
export function computeLotStatus(item) {
  if (!isLotCard(item)) return "active";
  if (item.shopifySoldOutMode === "keep") return "active";
  const { price, kg, belowFloor } = computeLotPrice(item);
  if (kg == null || kg <= 0 || !price || price <= 0 || belowFloor) return "draft";
  return "active";
}

const trimNum = n => (n == null ? "" : String(round(n, 3)));

export function buildLotTokens(item, computed) {
  const c = computed || computeLotPrice(item);
  const kg = c.kg != null ? c.kg : resolveLotKg(item);
  const pcs = resolveLotPcs(item);
  return {
    material: item?.material ?? "",
    shape: item?.shape ?? "",
    origin: item?.origin ?? "",
    size: item?.size ?? "",
    grade: item?.grade ?? "",
    sku: item?.sku ?? "",
    location: item?.location ?? "",
    notes: item?.notes ?? "",
    kg: trimNum(kg),
    pcs: trimNum(pcs),
    gm: kg != null ? trimNum(kg * 1000) : "",
    price: c.price != null ? String(round(c.price)) : "",
    price_per_kg: c.rate != null ? String(round(c.rate)) : "",
  };
}

const escapeHtml = s => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* Zero counts as empty: a lot at 0 pcs must not publish "pcs: 0". */
const isEmptyToken = v =>
  v === undefined || v === null ||
  String(v).trim() === "" ||
  num(v) === 0;

const TOKEN = /\{([a-z_]+)(\?)?\}/gi;

/* Renders line by line. A line containing any empty token is dropped entirely —
   that is what stops a pcs-only card showing a blank "kgs:" row. `{token?}` opts a
   token out of that rule for lines that mix several facts. Unknown tokens count as
   empty rather than leaking a literal "{foo}" onto the storefront. */
export function renderTemplate(tpl, tokens) {
  const src = String(tpl == null ? DEFAULT_LOT_TEMPLATE : tpl);
  const out = [];
  for (const line of src.split("\n")) {
    let drop = false;
    let any = false;
    const rendered = line.replace(TOKEN, (_m, name, optional) => {
      any = true;
      const raw = tokens[String(name).toLowerCase()];
      if (isEmptyToken(raw)) {
        if (!optional) drop = true;
        return "";
      }
      return escapeHtml(raw);
    });
    if (any && drop) continue;
    out.push(rendered.trimEnd());
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/* Shopify strips <style> and ignores stylesheets, so plain text needs <br>.
   Same HTML test as src/ListingManagerApp.jsx:8286. */
export function toBodyHtml(text) {
  const s = String(text || "");
  return /<[a-z][\s\S]*>/i.test(s) ? s : s.replace(/\n/g, "<br>");
}

export function buildLotBody(item) {
  const computed = computeLotPrice(item);
  const tokens = buildLotTokens(item, computed);
  const rendered = renderTemplate(item?.shopifyDescTemplate || DEFAULT_LOT_TEMPLATE, tokens);
  return toBodyHtml(rendered);
}

/* Everything the sync would write. One call so the preview and the request can
   never disagree. */
export function buildLotSync(item) {
  const computed = computeLotPrice(item);
  const body_html = buildLotBody(item);
  const status = computeLotStatus(item);
  const price = computed.mode === "lot" ? computed.price : num(item?.listPrice);
  return { body_html, price, status, ...computed, hash: lotSyncHash({ body_html, price, status }) };
}

/* ── Part-lot variants ─────────────────────────────────────────────────────
 *
 * A 222 pcs lot listed as one buy-it-all product loses every buyer who wants a
 * handful. So the same card can publish extra Shopify variants — half, quarter,
 * or a single unit — each priced off the same total and counted in the card's own
 * primary unit, which is what the seller thinks in.
 *
 * Shopify keeps each variant's inventory separate: selling a half does not lower
 * what the "full lot" variant claims to have. The ERP card is the real stock, and
 * the next push/sync rewrites every variant from it — the modal says so.
 */

/* The unit the card is actually counted in — the first non-empty qty pair. */
export function resolvePrimaryQty(item) {
  if (!item) return null;
  const pairs = [
    { qty: num(item.qty), unit: normalizeUnit(item.unit) || "pcs" },
    { qty: num(item.qty2), unit: normalizeUnit(item.unit2) || "kg" },
  ];
  const hit = pairs.find(p => p.qty != null && p.qty > 0);
  return hit || null;
}

export const LOT_SPLITS = [
  { key: "full", label: "Full lot", share: 1 },
  { key: "half", label: "Half lot", share: 0.5 },
  { key: "quarter", label: "Quarter lot", share: 0.25 },
  { key: "unit", label: "Single unit", share: null },
];

/* One variant per chosen split. `price` is what the whole lot costs; everything
   else is derived, so there is never a second number to keep in step.
   Returns [] when the card has nothing to divide. */
export function buildLotVariants(item, splitKeys, totalPrice) {
  const primary = resolvePrimaryQty(item);
  const total = num(totalPrice);
  if (!primary || !(primary.qty > 0)) return [];
  const keys = Array.isArray(splitKeys) && splitKeys.length ? splitKeys : ["full"];
  const out = [];
  const seen = new Set();
  // Pieces don't halve: a quarter of 222 pcs is 55, never 55.5. Weight does.
  const discrete = primary.unit === "pcs";
  for (const def of LOT_SPLITS) {
    if (!keys.includes(def.key)) continue;
    // "Single unit" is a share only once the lot's own size is known.
    const wanted = def.share != null ? primary.qty * def.share : 1;
    const portion = discrete ? Math.floor(wanted) : round(wanted, 3);
    // Below a thousandth of a unit — or below one whole piece — nothing is left to sell.
    if (!(portion > (discrete ? 0 : 0.0009))) continue;
    // Price the portion actually offered, not the nominal fraction, so a rounded
    // 55 of 222 is charged as 55 and the sizes always add back up to the lot.
    const share = portion / primary.qty;
    const unitLabel = portion === 1 && primary.unit === "pcs" ? "pc" : primary.unit;
    const title = def.key === "unit"
      ? `1 ${unitLabel}`
      : `${def.label} · ${trimNum(portion)} ${unitLabel}`;
    /* Two splits can land on the same size — a quarter of 4 kg is also 1 kg, half
       of 3 pcs rounds down to 1. Sizes are what the buyer picks between, so the
       first (larger) name wins and the duplicate is dropped. */
    if (seen.has(portion)) continue;
    seen.add(portion);
    out.push({
      key: def.key,
      title,
      share,
      qty: portion,
      unit: primary.unit,
      // Shopify refuses a variant with no price, and a free part-lot is never
      // what was meant — fall back to a cent rather than publishing 0.
      price: total != null && total > 0 ? String(Math.max(0.01, round(total * share))) : "",
      // How many of this size the lot holds. The full lot is one.
      inventory: Math.max(1, Math.floor(primary.qty / portion)),
    });
  }
  return out;
}

/* Short stable fingerprint of what would be written, so an unchanged card is
   skipped without a round trip. Not security-sensitive — djb2 is plenty. */
export function lotSyncHash(payload) {
  const s = JSON.stringify([payload?.body_html || "", payload?.price ?? "", payload?.status || ""]);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
