/* Shipping history — normalisation and lane statistics.

   Measured against the live data before this existed: of 1,230 shipped orders
   1,223 had a carrier but only 34 had a cost, and the same courier was arriving
   under several spellings ("bluedart" from the dropdown, "blue dart surface"
   from Etsy's sync) while the same country arrived as both "US" and "United
   States". Both split the history into buckets too small to learn anything from.

   So everything is normalised on the way in, and the ship dialog shows what
   comparable shipments actually cost — which is the point of collecting it. */

const CARRIER_ALIASES = [
  ["cirro",        ["cirro", "cirro e-commerce", "cirroecommerce"]],
  ["shipglobal",   ["shipglobal", "ship global", "shipglobal.in"]],
  ["dhl-ecommerce",["dhl ecommerce", "dhl e-commerce", "dhlglobalmail", "dhl global mail"]],
  ["dhl",          ["dhl", "dhl express"]],
  ["fedex",        ["fedex", "federal express"]],
  ["ups",          ["ups", "united parcel"]],
  ["usps",         ["usps", "united states postal", "us postal"]],
  ["aramex",       ["aramex"]],
  ["india-post",   ["india post", "indiapost", "india-post", "speed post", "speedpost", "dept of post"]],
  ["bluedart",     ["bluedart", "blue dart", "blue dart surface", "bluedart surface"]],
  ["canada-post",  ["canada post", "canadapost"]],
  ["royal-mail",   ["royal mail", "royalmail"]],
  ["japan-post",   ["japan post", "japanpost"]],
  ["delhivery",    ["delhivery"]],
  ["dtdc",         ["dtdc"]],
];

export const CARRIER_LABELS = {
  cirro: "Cirro", shipglobal: "ShipGlobal", dhl: "DHL", "dhl-ecommerce": "DHL eCommerce",
  fedex: "FedEx", ups: "UPS", usps: "USPS", aramex: "Aramex", "india-post": "India Post",
  bluedart: "Blue Dart", "canada-post": "Canada Post", "royal-mail": "Royal Mail",
  "japan-post": "Japan Post", delhivery: "Delhivery", dtdc: "DTDC", other: "Other / unlabelled",
};

/* Longest alias wins, so "dhl ecommerce" isn't swallowed by the "dhl" entry. */
export function normalizeCarrier(raw) {
  const s = String(raw || "").trim().toLowerCase().replace(/[_]+/g, " ").replace(/\s+/g, " ");
  if (!s) return "";
  let best = "";
  let bestLen = 0;
  for (const [key, aliases] of CARRIER_ALIASES) {
    for (const a of aliases) {
      if ((s === a || s.includes(a)) && a.length > bestLen) { best = key; bestLen = a.length; }
    }
  }
  return best || "other";
}
export const carrierLabel = key => CARRIER_LABELS[key] || (key ? key.replace(/-/g, " ") : "—");

const COUNTRY_ALIASES = {
  "united states": "US", "united states of america": "US", usa: "US", "u.s.a.": "US", "u.s.": "US", america: "US",
  "united kingdom": "GB", uk: "GB", "great britain": "GB", england: "GB", scotland: "GB", wales: "GB",
  australia: "AU", japan: "JP", france: "FR", canada: "CA", india: "IN", germany: "DE", deutschland: "DE",
  italy: "IT", spain: "ES", netherlands: "NL", holland: "NL", belgium: "BE", ireland: "IE", "new zealand": "NZ",
  singapore: "SG", "hong kong": "HK", "south korea": "KR", korea: "KR", china: "CN", switzerland: "CH",
  sweden: "SE", norway: "NO", denmark: "DK", finland: "FI", poland: "PL", austria: "AT", portugal: "PT",
  mexico: "MX", brazil: "BR", "united arab emirates": "AE", uae: "AE", "saudi arabia": "SA", israel: "IL",
  "czech republic": "CZ", czechia: "CZ", hungary: "HU", greece: "GR", romania: "RO", "south africa": "ZA",
};
export function normalizeCountry(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return COUNTRY_ALIASES[s.toLowerCase()] || s.toUpperCase().slice(0, 24);
}

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
export const shipCostOf = o => { const n = num(o?.ship_cost); return n != null && n > 0 ? n : null; };
export const shipCountryOf = o => normalizeCountry(o?.ship_country || o?.buyer_country || "");
export const shipCarrierOf = o => normalizeCarrier(o?.carrier_name);
const isShipped = o => !!o?.shipped_at || ["shipped", "completed", "fulfilled"].includes(String(o?.status || "").toLowerCase());

const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/* What comparable past shipments cost, for the lane an order is going to.
   `value` narrows to orders of similar worth (±60%) when enough of them exist —
   with a history this thin, a wider net beats a precise but empty answer. */
export function laneHistory(orders = [], order = {}) {
  const country = shipCountryOf(order);
  if (!country) return null;
  const value = num(order.sale_price) || num(order.order_total);

  const pool = (orders || []).filter(o =>
    o && o.id !== order.id && isShipped(o) &&
    shipCountryOf(o) === country && shipCostOf(o) != null);
  if (!pool.length) return { country, total: 0, carriers: [], sampleScope: "none" };

  const near = value
    ? pool.filter(o => {
        const v = num(o.sale_price) || num(o.order_total);
        return v != null && v >= value * 0.4 && v <= value * 1.6;
      })
    : [];
  // Only narrow by value when the narrower set is still worth reading.
  const use = near.length >= 3 ? near : pool;

  const by = new Map();
  for (const o of use) {
    const k = shipCarrierOf(o) || "other";
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(shipCostOf(o));
  }
  const carriers = [...by.entries()]
    .map(([key, costs]) => ({
      key, label: carrierLabel(key), n: costs.length,
      avg: Math.round(costs.reduce((a, b) => a + b, 0) / costs.length),
      median: median(costs),
      min: Math.min(...costs), max: Math.max(...costs),
    }))
    .sort((a, b) => a.median - b.median);

  const all = use.map(shipCostOf);
  return {
    country,
    total: use.length,
    sampleScope: use === near ? "similar value" : "all values",
    carriers,
    overallMedian: median(all),
    // Only meaningful once two carriers have actually been tried on this lane.
    comparable: carriers.filter(c => c.key !== "other").length > 1,
  };
}

/* Flag a cost that is well out of line with the lane's history, at the moment
   it is entered rather than in a report nobody opens. */
export function costVerdict(history, cost) {
  const c = num(cost);
  if (!history || !history.overallMedian || c == null || c <= 0) return null;
  const ratio = c / history.overallMedian;
  if (ratio >= 1.8) return { tone: "high", text: `${ratio.toFixed(1)}× your median for ${history.country} (₹${history.overallMedian})` };
  if (ratio <= 0.55) return { tone: "low", text: `well under your ${history.country} median (₹${history.overallMedian})` };
  return { tone: "ok", text: `in line with your ${history.country} median (₹${history.overallMedian})` };
}
