/* The four places a listing is sold, and what each one needs. The editor,
   the grid and the publish calls all read these, so "what goes out to eBay"
   is decided in one place.

   Title and description fall back in order: the platform's own override, then
   (for the two sites of ours) the older Shopify override they used to share,
   then the main title / description. */

export const CHANNELS = [
  { key: "etsy",  label: "Etsy",           short: "Etsy",  color: "#F56400", priceField: "price_etsy",  cur: "₹",
    titleField: "etsy_title",  descField: "etsy_description",  titleMax: 140,
    blurb: "Retail marketplace. Title up to 140 characters, 13 tags, category and shop section." },
  // The second Etsy shop (lib/etsy-auth.js), on its own account. Same price, title and tags as Atyahara's.
  { key: "etsy_ee", label: "Etsy · EarthEditions", short: "Etsy EE", color: "#9C3D0A", priceField: "price_etsy", cur: "₹",
    titleField: "etsy_title",  descField: "etsy_description",  titleMax: 140, shop: "earth",
    blurb: "The EarthEditions Etsy shop. Same Etsy title, tags and price; its own sections and shipping." },
  { key: "ebay",  label: "eBay",           short: "eBay",  color: "#0064D2", priceField: "price_ebay",  cur: "$",
    titleField: "ebay_title",  descField: "ebay_description",  titleMax: 80,
    blurb: "Title up to 80 characters: eBay cuts anything longer. Condition and shipping are set here." },
  { key: "trade", label: "Wholesale",      short: "Trade", color: "#1F8F4E", priceField: "price_trade", cur: "$",
    titleField: "trade_title", descField: "trade_description", legacy: "shopify",
    blurb: "The trade site for wholesale buyers. Short, plain names read best, e.g. \"Cobalto Calcite Sphere\"." },
  { key: "store", label: "Earth Editions", short: "EE",    color: "#141210", priceField: "price_store", cur: "$",
    titleField: "store_title", descField: "store_description", legacy: "shopify",
    blurb: "eartheditions.co, our own retail site. USA $ and India ₹ prices. The site shortens long titles itself." },
];
// Still supported, shown under "More".
export const OTHER_CHANNELS = [
  { key: "shopify_earth", label: "Earth Ed. Shopify", color: "#2A6845", priceField: "price_shopify_earth", cur: "$" },
  { key: "shopify_aty",   label: "Atyahara",          color: "#6B3FA0", priceField: "price_shopify_aty",   cur: "₹" },
];
// Both Etsy shops behave alike everywhere but in which shop they talk to.
export const isEtsyKey = key => key === "etsy" || key === "etsy_ee";
export const etsyShopOf = key => key === "etsy_ee" ? "earth" : "atyahara";
export const channel = key => CHANNELS.find(c => c.key === key) || OTHER_CHANNELS.find(c => c.key === key);

export function titleFor(l, key) {
  const c = channel(key);
  const own = c?.titleField && String(l?.[c.titleField] || "").trim();
  if (own) return own;
  if (c?.legacy && String(l?.shopify_title || "").trim()) return String(l.shopify_title).trim();
  return String(l?.title || "").trim();
}
export function descFor(l, key) {
  const c = channel(key);
  const own = c?.descField && String(l?.[c.descField] || "").trim();
  if (own) return l[c.descField];
  if (c?.legacy && String(l?.shopify_description || "").trim()) return l.shopify_description;
  return l?.description || "";
}
// Which field the shown title came from, for the editor's hint.
export function titleSource(l, key) {
  const c = channel(key);
  if (c?.titleField && String(l?.[c.titleField] || "").trim()) return "own";
  if (c?.legacy && String(l?.shopify_title || "").trim()) return "shopify";
  return "main";
}

/* Is it on the platform, and where. */
export function linkOf(l, key) {
  const pd = l?.platforms?.[key] || {};
  const id = pd.listing_id || pd.item_id || pd.product_id || "";
  if (!id || pd.status === "deleted") return { linked: false, status: pd.status || "" };
  let live = "", admin = "";
  if (isEtsyKey(key)) { live = pd.url || `https://www.etsy.com/listing/${id}`; admin = `https://www.etsy.com/your/shops/me/listing-editor/edit/${id}`; }
  else if (key === "ebay") { live = pd.url || `https://www.ebay.com/itm/${id}`; }
  // Our own two sites save the public page as `url`; Shopify saves its admin page there.
  else if (key === "trade" || key === "store") { live = pd.storefront_url || pd.url || ""; }
  else { live = pd.storefront_url || ""; admin = pd.url || ""; }
  /* eartheditions.co keeps its own status, and staff hide or sell pieces
     there without the listing hearing of it: the note saved at publish said
     "active" for 135 pieces the site was hiding or had sold (15 Nov 2026).
     When the caller has read the store's row (`_storeRow`, null = no row),
     the site's word wins. */
  let status = pd.status || "active";
  if (key === "store" && l && "_storeRow" in l) status = l._storeRow ? (l._storeRow.status || "hidden") : "missing";
  return { linked: true, id: String(id), status, live, admin, error: pd.error || pd.last_error || "", ref: !!pd.linked_only };
}
/* A linked piece that isn't on sale, in words. The store's own states first. */
export const STATUS_WORDS = {
  hidden:  ["Hidden on the site", "hidden on the site, publishing puts it back on sale"],
  sold:    ["Sold on the site",   "marked sold on the site, publishing puts it back on sale"],
  missing: ["Not on the site",    "not on the site any more, publishing adds it again"],
  expired: ["Expired",            "expired there, publishing renews it"],
};
export const statusShort = s => STATUS_WORDS[s]?.[0] || (s === "active" ? "Live" : "Draft");
export const statusLong = s => STATUS_WORDS[s]?.[1] || (s === "active" ? "already live" : "already a draft there");

/* The trade product for a listing, from loadTradeFacts' map: the one naming
   this listing, else the one the listing is linked to. */
export function tradeRowOf(map, l) {
  if (!map || !l) return null;
  const pd = l.platforms?.trade;
  return map[l.id] || (pd?.product_id && pd.status !== "deleted" ? map[`#${pd.product_id}`] : null) || null;
}
/* A trade product connected by hand is another product, e.g. a per-kilo lot
   of the same stone. It's shown as this listing's Wholesale home, but the
   listing never writes to it: no sync, no hiding when the piece sells. */
export const tradeRefOnly = l => !!l?.platforms?.trade?.linked_only;

/* How many pieces a kilo of each shape usually holds: the starting count
   when a piece goes onto the trade site per kilo. The trade site keeps the
   same table (src/pieces.js) for products saved without a count. */
const PER_KG = [
  [/\bmini[\s-]*hearts?\b/i, 70, 100],
  [/\bspheres?\b|\bballs?\b/i, 7, 13],
  [/\bpalm[\s-]?stones?\b|\bworry stones?\b/i, 15, 25],
  [/\bhearts?\b/i, 20, 30],
  [/\bshiva|\blingams?\b/i, 20, 25],
];
/* Already on the trade site? Most trade products were made on the site
   itself (a per-kilo lot: "Arusha Sunstone with Iolite Palmstones (1KG)"),
   so nothing ties them to the listing. A product is a match when it names
   the same shape and the same stone — every word of the listing's stone is
   in its title, and at most one stone word of its title isn't in the
   listing. Exact ones (no extra word) are picked to link; the rest are
   offered. Checked against the real catalogue on 16 Nov 2026: ~100 exact. */
const TP_STOP = new Set("and the with from crystal crystals natural stone stones gemstone gemstones grade aaa kg 1kg lot bulk pcs pc".split(" "));
const TP_GENERIC = new Set("mini small medium large big polished tumble tumbled wholesale bulk set mix pack piece size round".split(" "));
const TP_SHAPES = { palmstone: ["palmstone", "palm", "flatstone"], heart: ["heart"], sphere: ["sphere"], tower: ["tower", "obelisk"], tumbled: ["tumble"],
  egg: ["egg"], pyramid: ["pyramid"], skull: ["skull"], point: ["point"], wand: ["wand"], freeform: ["freeform"], bracelet: ["bracelet"],
  pendant: ["pendant"], pendulum: ["pendulum", "pendant"], chip: ["chip"], rough: ["rough", "raw"], lingam: ["shivalingam", "lingam"], bowl: ["bowl"] };
const tpWords = s => new Set(String(s || "").toLowerCase().replace(/palm[\s-]*stones?/g, "palmstone").replace(/[äà]/g, "a")
  .split(/[^a-z0-9]+/).filter(w => w.length > 2 && !TP_STOP.has(w)).map(w => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)));
const tpIsShape = x => Object.values(TP_SHAPES).some(ss => ss.some(s => x.startsWith(s)));
const tpShapeOf = s => { const w = [...tpWords(s)]; return Object.keys(TP_SHAPES).find(k => w.some(x => TP_SHAPES[k].some(p => x.startsWith(p)))) || null; };
export function tradeMatches(l, facts) {
  const sk = tpShapeOf(l.title) || tpShapeOf(l.shape);
  if (!sk || !facts?.length) return [];
  const lw = tpWords(`${l.title || ""} ${l.material || ""} ${l.shape || ""}`);
  const mw = [...tpWords(l.material)].filter(w => !TP_GENERIC.has(w));
  return facts.map(t => {
    const w = tpWords(t.title);
    if (![...w].some(x => TP_SHAPES[sk].some(s => x.startsWith(s)))) return null;
    const stone = [...w].filter(x => !TP_GENERIC.has(x) && !tpIsShape(x));
    const stoneHit = stone.filter(x => lw.has(x)).length;
    // One stone word of the listing may be missing from a shorter trade title
    // ("Arusha Sunstone with Shivalingam" for "…with Iolite Shivalingam"): offered, never picked.
    const missing = mw.filter(x => !w.has(x)).length;
    if (!stoneHit || missing > 1) return null;
    const extra = stone.length - stoneHit + missing;
    // Ties go to the closer title: "Sunstone Round Palmstone" over "Sunstone Palmstone".
    const hit = [...w].filter(x => lw.has(x)).length - [...w].filter(x => !lw.has(x)).length / 10;
    return extra <= 1 ? { t, extra, hit } : null;
  }).filter(Boolean).sort((a, b) => a.extra - b.extra || b.hit - a.hit || b.t.live - a.t.live).slice(0, 4);
}

/* The shape a title names, in the form's own words, for when the AI gives
   none. "2 Inch Sunstone Bowl" → "Bowl - 2 inch". */
const TITLE_SHAPES = [
  [/\bmini[\s-]*hearts?\b/i, "Heart"], [/\bhearts?\b/i, "Heart"], [/\bspheres?\b/i, "Sphere"],
  [/\bpalm[\s-]?stones?\b|\bworry stones?\b/i, "Palmstone"], [/\btowers?\b|\bobelisks?\b/i, "Tower"],
  [/\btumbled?\b/i, "Tumbled"], [/\bbracelets?\b/i, "Bracelet"], [/\bpendulums?\b/i, "Pendulum"],
  [/\bpendants?\b|\bnecklaces?\b/i, "Pendant"], [/\beggs?\b/i, "Egg"], [/\bskulls?\b/i, "Skull"],
  [/\bpyramids?\b/i, "Pyramid"], [/\bchips\b/i, "Chips"], [/\bfree[\s-]?forms?\b/i, "Freeform"],
  [/\bmalas?\b/i, "Mala"], [/\bwands?\b/i, "Wand"], [/\bpoints?\b/i, "Point"], [/\bslabs?\b|\bslices?\b/i, "Slab"],
  [/\brough\b|\braw\b/i, "Rough"],
];
export function shapeFromTitle(title) {
  const t = String(title || "");
  if (/\bbowls?\b/i.test(t)) {
    const n = +((t.match(/(\d+(?:\.\d+)?)\s*(?:inch|inches|in\b|")/i) || [])[1] || 0);
    const size = n ? Math.min(7, Math.max(2, Math.round(n))) : 4;
    return `Bowl - ${size} inch`;
  }
  return (TITLE_SHAPES.find(([re]) => re.test(t)) || [])[1] || "";
}
/* Bowls, carvings and other single objects go wholesale by the piece; loose
   shapes (hearts, palmstones, tumbles…) by the kilo. */
const BY_PIECE = /\bbowls?\b|\bskulls?\b|\btowers?\b|\bobelisks?\b|\bpyramids?\b|\bwands?\b|\bpendulums?\b|\bpendants?\b|\bbracelets?\b|\bmalas?\b|\bidols?\b|\bganesh|\bcarvings?\b|\bstatues?\b|\bstands?\b|\bgeodes?\b|\bclusters?\b|\bslabs?\b/i;
export function defaultUnit(l) {
  if (l?.type === "unique") return "piece";
  if (defaultPieces(l)) return "kg";
  return BY_PIECE.test(`${l?.shape || ""} ${l?.title || ""}`) ? "piece" : "kg";
}
export function defaultPieces(l) {
  for (const text of [`${l?.shape || ""} ${l?.title || ""}`, l?.trade_title, l?.title]) {
    const hit = PER_KG.find(([re]) => re.test(String(text || "")));
    if (hit) return { pieces: hit[1], pieces_max: hit[2] };
  }
  return null;
}

/* A pasted link or number → the platform's id. Etsy and eBay only: the two
   sites of ours are linked by posting from here. */
export function parseRef(key, text) {
  const t = String(text || "").trim();
  if (!t) return "";
  /* Every link Etsy hands out for one listing: the shop page
     (/listing/<id>/…), the listing editor (/your/shops/me/listing-editor/edit/<id>,
     what a draft's own page is), the listings manager
     (/your/shops/me/tools/listings/<id>), and the bare number. Only
     "listing-editor/edit/" matched none of them, so a draft couldn't be linked. */
  if (isEtsyKey(key)) return (t.match(/\/listing\/(\d{6,})/) || t.match(/\/listing-editor\/edit\/(\d{6,})/)
    || t.match(/\/tools\/listings\/(?:[^/?#]+\/)*?(\d{6,})(?:[/?#]|$)/) || t.match(/[?&]listing_id=(\d{6,})/) || t.match(/^#?(\d{6,})$/) || [])[1] || "";
  if (key === "ebay") return (t.match(/\/itm\/(?:[^/?#]+\/)?(\d{9,})/) || t.match(/[?&]item=(\d{9,})/) || t.match(/^(\d{9,})$/) || [])[1] || "";
  return "";
}
export function connectPatch(key, id) {
  if (isEtsyKey(key)) return { listing_id: id, url: `https://www.etsy.com/listing/${id}`, status: "active", connected_at: new Date().toISOString() };
  if (key === "ebay") return { item_id: id, url: `https://www.ebay.com/itm/${id}`, status: "active", connected_at: new Date().toISOString() };
  return null;
}

/* What's missing before this looks right on the platform. `blocking` issues
   stop a good listing; the rest are advice. */
export function readiness(l, key, tags = l?.tags || []) {
  const out = [];
  const add = (ok, text, blocking = false) => out.push({ ok: !!ok, text, blocking });
  const c = channel(key);
  const photos = (l?.images || []).filter(Boolean).length;
  const title = titleFor(l, key);
  if (c?.priceField) add(+l?.[c.priceField] > 0 || (key === "store" && +l?.price_etsy > 0), key === "store" && !(+l?.price_store > 0) && +l?.price_etsy > 0 ? "Price (from the Etsy price)" : "Price set", true);
  add(photos > 0, photos ? `${photos} photo${photos === 1 ? "" : "s"}` : "At least one photo", true);
  if (c?.titleMax) add(title && title.length <= c.titleMax, title.length > c.titleMax ? `Title is ${title.length}/${c.titleMax}: too long` : "Title fits", true);
  if (isEtsyKey(key)) {
    add(photos >= 5, "5+ photos (Etsy ranks these higher)");
    add((tags || []).length === 13, `All 13 tags (${(tags || []).length}/13)`);
    add(String(l?.material || "").trim(), "Material / stone");
    add(["width", "height", "depth"].some(k => parseFloat(l?.[k]) > 0) || /\d/.test(String(l?.size || "")), "Dimensions");
    add(String(l?.weight || "").trim(), "Weight");
  }
  if (key === "trade") add(String(l?.origin || "").trim(), "Origin");
  if (key === "store") add(descFor(l, key).trim(), "Description");
  return out;
}
export const readyScore = checks => ({ bad: checks.filter(c => !c.ok && c.blocking).length, warn: checks.filter(c => !c.ok && !c.blocking).length });

/* ── where the piece physically is ──────────────────────────────────────── */
export function locationOf(l, stock) {
  const own = String(l?.officeLocation || "").trim();
  if (own) return own;
  const s = l?.linked_stock_id && (stock || []).find(x => x.id === l.linked_stock_id);
  return String(s?.location || "").trim();
}
// A one-of-a-kind piece that could still be sold has to be findable.
export const needsLocation = (l, sold = false) => l?.type !== "repeatable" && !sold;

/* Storage locations run in two numbered series: box numbers ("731") and STK
   shelves ("STK59"). The next free one is one past the top of the series,
   written the way the top one is; a lone number far above the rest (a stray
   998 while the boxes run to 731) isn't the top. The stock bot numbers boxes
   by the same rule. Takes anything with a location (stock cards, or
   { location } for places kept on listings). */
export const LOC_SERIES = { box: /^(?:box\s*[-_#]?\s*|#\s*)?(\d{1,5})$/i, stk: /^stk\s*[-_#]?\s*(\d{1,5})$/i };
export function nextLocation(items, series) {
  const byNum = new Map();
  for (const s of items || []) { const l = String(s?.location || "").trim(); const m = l.match(LOC_SERIES[series]); if (m) byNum.set(+m[1], l); }
  const nums = [...byNum.keys()].sort((a, b) => a - b);
  if (!nums.length) return series === "stk" ? "STK1" : "1";
  let top = nums[nums.length - 1];
  for (let i = nums.length - 1; i > 0; i--) if (nums[i] - nums[i - 1] <= 50) { top = nums[i]; break; }
  return byNum.get(top).replace(/\d+$/, d => String(top + 1).padStart(d.length, "0"));
}

// Every place in use, most used first, spelled the way most people spell it.
export function knownLocations(listings = [], stock = []) {
  const m = new Map();
  const add = raw => {
    const v = String(raw || "").trim(); if (!v) return;
    const k = v.toLowerCase(); const e = m.get(k) || { label: v, n: 0 };
    e.n++; m.set(k, e);
  };
  listings.forEach(l => add(l.officeLocation));
  stock.forEach(s => add(s.location));
  return [...m.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
}
// Kept on the listing so "where was it last week" has an answer.
export function withLocationLog(next, prevLoc, who) {
  const to = String(next.officeLocation || "").trim(), from = String(prevLoc || "").trim();
  if (to === from) return next;
  const log = Array.isArray(next.location_log) ? next.location_log : [];
  return { ...next, officeLocation: to, location_at: new Date().toISOString(),
    location_log: [{ at: new Date().toISOString(), from, to, by: who || "" }, ...log].slice(0, 30) };
}

/* The trade site names things plainly, with what the price buys:
   "38-42 MM Cobalto Calcite Sphere - Vivid Pink Matrix" → "Cobalto Calcite
   Sphere (1 kg)", or "(1 pc)" for a piece sold on its own. */
export const simpleName = t => String(t || "")
  .replace(/^\s*[\d.,\s–-]+(?:x\s*[\d.]+\s*)?(?:mm|cm|inch(?:es)?|in|g|gm|gms|kg|ct|carats?)\b\.?\s*/i, "")
  .split(/\s+[-–—|]\s+|\s*[|:]\s*|,\s/)[0]
  .replace(/\s*#\d+$/, "").trim();
/* What the trade price buys, said once: a title that already ends "(1kg)" or
   "(1 kg)" doesn't get a second one ("Porcelain Jasper Sphere (1kg) (1 kg)"). */
const TRADE_QTY_RE = /\s*\(\s*(?:1\s*)?(?:per\s*)?(?:kg|kgs|kilo|pc|pcs|piece|pieces|lot)\s*\)/gi;
export const tidyTradeTitle = t => {
  const s = String(t || "").trim();
  const all = s.match(TRADE_QTY_RE) || [];
  return all.length > 1 ? `${s.replace(TRADE_QTY_RE, "").trim()} ${all[all.length - 1].trim()}` : s;
};
export function tradeTitleFor(l, unit) {
  const u = unit || (l?.type === "unique" ? "piece" : "kg");
  const name = simpleName(l?.shopify_title || l?.title).replace(TRADE_QTY_RE, "").trim();
  return name ? `${name} (1 ${u === "piece" ? "pc" : u === "lot" ? "lot" : "kg"})` : "";
}
