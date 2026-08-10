/* Shipping history — normalisation, and a courier estimate from what you paid.

   Two things make the raw history look thinner than it is, and both are fixed
   here rather than by collecting more data:

   1. Comparing rupees across parcels of different weight is meaningless — a
      ₹305 200g parcel is not cheaper than a ₹670 2kg one. Where weight is
      known, carriers are compared on cost per kg and the estimate is scaled to
      the parcel actually being shipped.

   2. A courier only ever used on other lanes still tells you what it charges.
      Restricting the comparison to couriers used on this exact country is what
      made the data look unusable — only one lane had two couriers on it. Each
      carrier is modelled across every shipment, then applied to this parcel,
      with the basis stated so an extrapolation is never dressed up as a fact.

   Normalisation matters for the same reason: the same courier arrives as
   "bluedart" from the dropdown and "blue dart surface" from Etsy's sync, and one
   country arrives as both "US" and "United States". */

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
  let best = "", bestLen = 0;
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

/* Zones pool sparse lanes. Shipping one parcel to France and one to Germany is
   two lanes of one, but one European zone of two — which is the difference
   between having a comparison and not. */
const ZONE_OF = {
  IN: "India",
  US: "N. America", CA: "N. America", MX: "N. America",
  GB: "Europe", FR: "Europe", DE: "Europe", IT: "Europe", ES: "Europe", NL: "Europe", BE: "Europe",
  IE: "Europe", CH: "Europe", SE: "Europe", NO: "Europe", DK: "Europe", FI: "Europe", PL: "Europe",
  AT: "Europe", PT: "Europe", CZ: "Europe", HU: "Europe", GR: "Europe", RO: "Europe",
  AU: "Oceania", NZ: "Oceania",
  JP: "Asia", KR: "Asia", CN: "Asia", SG: "Asia", HK: "Asia", TW: "Asia", TH: "Asia",
  MY: "Asia", ID: "Asia", PH: "Asia", VN: "Asia",
  AE: "Middle East", SA: "Middle East", IL: "Middle East", QA: "Middle East", KW: "Middle East",
  ZA: "Africa", NG: "Africa", KE: "Africa", EG: "Africa",
  BR: "S. America", AR: "S. America", CL: "S. America", CO: "S. America",
};
export const zoneOf = country => ZONE_OF[normalizeCountry(country)] || "Other";

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
export const shipCostOf = o => { const n = num(o?.ship_cost); return n != null && n > 0 ? n : null; };
export const shipCountryOf = o => normalizeCountry(o?.ship_country || o?.buyer_country || "");
export const shipCarrierOf = o => normalizeCarrier(o?.carrier_name);
const isShipped = o => !!o?.shipped_at || ["shipped", "completed", "fulfilled"].includes(String(o?.status || "").toLowerCase());

/* Parcel weight, from the stock allocated to the order. Falls back through the
   fields the fulfilment flow writes at different stages. */
export function orderWeightKg(order, stock = []) {
  if (!order) return null;
  const direct = num(order.parcel_weight_kg);
  if (direct && direct > 0) return direct;
  const id = order.linked_stock_id || order._ngStockId || order._ngAllocatedStockId;
  if (!id) return null;
  const item = (stock || []).find(s => s?.id === id);
  if (!item) return null;
  const qty = Math.max(1, num(order._ngDeductedQty) || num(order._ngAllocatedQty) || num(order.qty) || 1);
  const perUnitGm = num(item.weightGm);
  if (perUnitGm && perUnitGm > 0) return (perUnitGm * qty) / 1000;
  // Stock often carries a kg secondary quantity instead of a per-unit weight.
  if (String(item.unit2 || "").toLowerCase() === "kg") {
    const kg = num(item.qty2), units = num(item.qty);
    if (kg && units && units > 0) return (kg / units) * qty;
  }
  if (String(item.unit || "").toLowerCase() === "kg") {
    const perUnit = num(item.qty);
    if (perUnit && perUnit > 0) return qty;
  }
  return null;
}

const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/* Everything each carrier has ever cost, sliced by country and zone, plus a
   per-kg rate wherever weight was resolvable. */
export function carrierModel(orders = [], stock = []) {
  const by = new Map();
  for (const o of orders || []) {
    if (!o || !isShipped(o)) continue;
    const cost = shipCostOf(o);
    if (cost == null) continue;
    const key = shipCarrierOf(o) || "other";
    if (!by.has(key)) by.set(key, { key, all: [], perKg: [], byCountry: new Map(), byZone: new Map() });
    const m = by.get(key);
    m.all.push(cost);

    const kg = orderWeightKg(o, stock);
    // Keep the weight alongside the rate: courier pricing is a base fee plus a
    // per-kg rate, so a rate derived from 200g parcels badly overstates a 2kg
    // one. Too few points to fit that curve, but enough to prefer like for like.
    if (kg && kg > 0.02) m.perKg.push({ rate: cost / kg, kg });

    const c = shipCountryOf(o);
    if (c) {
      if (!m.byCountry.has(c)) m.byCountry.set(c, []);
      m.byCountry.get(c).push(cost);
      const z = zoneOf(c);
      if (!m.byZone.has(z)) m.byZone.set(z, []);
      m.byZone.get(z).push(cost);
    }
  }
  return by;
}

/* Rank every carrier you have ever used for the parcel in hand.
   `basis` says what the number rests on, so a cross-zone extrapolation is never
   presented with the same weight as a direct observation. */
export function recommendCarriers(orders = [], stock = [], order = {}) {
  const country = shipCountryOf(order);
  if (!country) return null;
  const zone = zoneOf(country);
  const kg = orderWeightKg(order, stock);
  const model = carrierModel((orders || []).filter(o => o?.id !== order?.id), stock);
  if (!model.size) return { country, zone, kg, options: [], total: 0 };

  const options = [];
  for (const m of model.values()) {
    const onLane = m.byCountry.get(country) || [];
    const inZone = m.byZone.get(zone) || [];
    // Prefer rates from parcels of comparable weight; fall back to all of them.
    const near = kg ? m.perKg.filter(p => p.kg >= kg * 0.4 && p.kg <= kg * 2.5) : [];
    const perKgPool = near.length ? near : m.perKg;
    const perKg = median(perKgPool.map(p => p.rate));

    let expected = null, basis = "", n = 0, exact = false;
    if (onLane.length) {
      expected = median(onLane); basis = `${onLane.length} to ${country}`; n = onLane.length; exact = true;
    } else if (inZone.length) {
      expected = median(inZone); basis = `${inZone.length} to ${zone}`; n = inZone.length;
    } else if (perKg != null && kg) {
      expected = perKg * kg; basis = `est. from ${perKgPool.length} elsewhere at similar weight`; n = perKgPool.length;
    } else if (m.all.length) {
      expected = median(m.all); basis = `est. from ${m.all.length} elsewhere`; n = m.all.length;
    }
    if (expected == null) continue;

    // A same-lane median for a very different parcel is worse than its own
    // per-kg rate scaled to this one, so prefer the scaled figure when weight
    // is known on both sides.
    if (exact && perKg != null && kg && perKgPool.length >= 2) {
      expected = (expected + perKg * kg) / 2;
      basis += " · weight-adjusted";
    }

    options.push({
      key: m.key, label: carrierLabel(m.key), expected: Math.round(expected),
      basis, n, exact, perKg: perKg != null ? Math.round(perKg) : null,
      spread: onLane.length > 1 ? [Math.min(...onLane), Math.max(...onLane)] : null,
    });
  }
  options.sort((a, b) => a.expected - b.expected);

  const known = options.filter(o => o.key !== "other");
  return {
    country, zone, kg,
    options,
    total: [...model.values()].reduce((s, m) => s + m.all.length, 0),
    // A recommendation needs at least two real couriers to choose between.
    canRecommend: known.length > 1,
    best: known[0] || null,
    saving: known.length > 1 ? Math.round(known[known.length - 1].expected - known[0].expected) : 0,
  };
}

/* Flag a cost well out of line with what this parcel should cost, at the moment
   it is typed rather than in a report nobody opens. */
export function costVerdict(rec, cost) {
  const c = num(cost);
  if (!rec || !rec.options?.length || c == null || c <= 0) return null;
  const ref = median(rec.options.map(o => o.expected));
  if (!ref) return null;
  const ratio = c / ref;
  const per = rec.kg ? ` · ₹${Math.round(c / rec.kg)}/kg` : "";
  if (ratio >= 1.8) return { tone: "high", text: `${ratio.toFixed(1)}× what this parcel usually costs (~₹${Math.round(ref)})${per}` };
  if (ratio <= 0.55) return { tone: "low", text: `well under the usual ~₹${Math.round(ref)} for this parcel${per}` };
  return { tone: "ok", text: `about right — usual is ~₹${Math.round(ref)}${per}` };
}
