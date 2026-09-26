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
  if (key === "etsy") { live = pd.url || `https://www.etsy.com/listing/${id}`; admin = `https://www.etsy.com/your/shops/me/listing-editor/edit/${id}`; }
  else if (key === "ebay") { live = pd.url || `https://www.ebay.com/itm/${id}`; }
  // Our own two sites save the public page as `url`; Shopify saves its admin page there.
  else if (key === "trade" || key === "store") { live = pd.storefront_url || pd.url || ""; }
  else { live = pd.storefront_url || ""; admin = pd.url || ""; }
  return { linked: true, id: String(id), status: pd.status || "active", live, admin, error: pd.error || pd.last_error || "" };
}

/* A pasted link or number → the platform's id. Etsy and eBay only: the two
   sites of ours are linked by posting from here. */
export function parseRef(key, text) {
  const t = String(text || "").trim();
  if (!t) return "";
  if (key === "etsy") return (t.match(/listing\/(\d{6,})/) || t.match(/^(\d{6,})$/) || [])[1] || "";
  if (key === "ebay") return (t.match(/\/itm\/(?:[^/?#]+\/)?(\d{9,})/) || t.match(/[?&]item=(\d{9,})/) || t.match(/^(\d{9,})$/) || [])[1] || "";
  return "";
}
export function connectPatch(key, id) {
  if (key === "etsy") return { listing_id: id, url: `https://www.etsy.com/listing/${id}`, status: "active", connected_at: new Date().toISOString() };
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
  if (key === "etsy") {
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
