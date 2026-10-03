import { requireUser } from "../lib/auth.js";
/**
 * Listing Manager API — cross-platform publishing hub
 * Supports: Etsy, Shopify (Earth Editions), Shopify (Atyahara), eBay (future)
 *
 * Actions: ai_generate, publish_etsy, unpublish_etsy,
 *          publish_shopify, unpublish_shopify
 */

import { getEtsyAccessToken } from "../lib/etsy-auth.js";
import { createClient } from "@supabase/supabase-js";
import { endEbayItem } from "./ebay.js";

const MEDIA_BUCKET = "ng-media";

function mediaStoragePath(url) {
  if (typeof url !== "string" || !url) return "";
  const marker = `/storage/v1/object/public/${MEDIA_BUCKET}/`;
  const index = url.indexOf(marker);
  if (index < 0) return "";
  return decodeURIComponent(url.slice(index + marker.length).split("?")[0]);
}

async function deleteSourceVideo(url) {
  const path = mediaStoragePath(url);
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!path) return { deleted: false, skipped: true, reason: "not_erp_media_url" };
  if (!supabaseUrl || !serviceKey) {
    return { deleted: false, skipped: true, reason: "SUPABASE_SERVICE_ROLE_KEY_missing" };
  }
  const client = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.storage.from(MEDIA_BUCKET).remove([path]);
  if (error) return { deleted: false, error: error.message };
  return { deleted: true, path };
}

// Days the ERP keeps its own copy after Shopify first reports READY. Deleting makes
// Shopify the ONLY copy, so the grace window covers a rejected transcode or the
// product being unpublished/deleted (e.g. a Deals item coming down) soon after.
const VIDEO_GRACE_DAYS = 7;

async function cleanupReadyVideo(listing, result, platformKey) {
  if (
    String(result?.videoStatus || "").toUpperCase() !== "READY" ||
    !result?.videoUrl ||
    listing?.videoStoragePolicy !== "delete_after_shopify_ready" ||
    !listing?.video ||
    listing.video === result.videoUrl
  ) return result;
  const prevReadyAt = listing?.platforms?.[platformKey]?.videoReadyAt || listing?.videoReadyAt || "";
  const readyMs = prevReadyAt ? Date.parse(prevReadyAt) : NaN;
  if (!Number.isFinite(readyMs)) {
    // First confirmed READY — start the clock, delete nothing yet.
    return { ...result, videoReadyAt: new Date().toISOString(), videoStorageCleanup: { deleted: false, skipped: true, reason: "grace_started", graceDays: VIDEO_GRACE_DAYS } };
  }
  const ageDays = (Date.now() - readyMs) / 86400000;
  if (ageDays < VIDEO_GRACE_DAYS) {
    return { ...result, videoReadyAt: prevReadyAt, videoStorageCleanup: { deleted: false, skipped: true, reason: "within_grace", daysLeft: Math.max(0, +(VIDEO_GRACE_DAYS - ageDays).toFixed(1)) } };
  }
  const cleanup = await deleteSourceVideo(listing.video);
  return { ...result, videoReadyAt: prevReadyAt, videoStorageDeleted: cleanup.deleted, videoStorageCleanup: cleanup };
}

/* ── Etsy constants ────────────────────────────────────────────────────────── */
const ETSY_SHOP_ID   = process.env.ETSY_SHOP_ID   || "21113006";
// x-api-key must be just the keystring (API key), NOT "keystring:sharedsecret"
const ETSY_API_KEY   = process.env.ETSY_API_KEY    || process.env.ETSY_KEYSTRING || "";

async function etsyHeaders(json = true) {
  const token = await getEtsyAccessToken();
  return {
    "x-api-key": ETSY_API_KEY,
    "Authorization": `Bearer ${token}`,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

const listingSku = listing => String(listing?.sku || listing?.listing_order_id || listing?.id || "").trim();

// Shipping profile IDs (from Atyahara shop)
const ETSY_SHIPPING = {
  under35:  226959740451,  // listings under $35
  above35:  127830730749,  // listings above $35
  above350: 260361925431,  // listings above $350
};

/* A profile id that the shop has since deleted is rejected by Etsy at publish,
   and the listing goes nowhere. The shop's live profiles are read once and the
   chosen id checked against them, falling back to one that does exist rather
   than to a number that used to. */
let etsyShippingCache = null;
async function etsyShippingProfiles(hdrs) {
  if (etsyShippingCache) return etsyShippingCache;
  try {
    const { "Content-Type": _drop, ...bare } = hdrs;
    const r = await fetch(`https://openapi.etsy.com/v3/application/shops/${ETSY_SHOP_ID}/shipping-profiles`, { headers: bare });
    if (!r.ok) return [];
    etsyShippingCache = ((await r.json())?.results || []).map(p => ({ id: p.shipping_profile_id, label: p.title || "" }));
    return etsyShippingCache;
  } catch { return []; }
}
const USA_PROFILE_RE = /\b(usa|u\.s\.a|domestic|united states)\b/i;
async function resolveShippingProfile(wanted, hdrs, { preferUsa = false } = {}) {
  const live = await etsyShippingProfiles(hdrs);
  if (!live.length) return wanted;                       // nothing to check against
  const usa = live.find(p => USA_PROFILE_RE.test(p.label));
  // Stock already in the States ships from there, whatever the price band says.
  if (preferUsa && usa) return usa.id;
  if (live.some(p => String(p.id) === String(wanted))) return wanted;
  console.warn(`Etsy shipping profile ${wanted} is not on the shop any more — using ${(usa || live[0]).label}`);
  return (usa || live[0]).id;
}

/* Sections are named on Etsy and numbered underneath, and the number is what
   goes out — but the number is also what quietly becomes somebody else's
   section. Where a listing names the section it wants, the name is looked up
   against the shop and wins over any id carried along with it. */
let etsySectionCache = null;
async function resolveSectionId(listing, hdrs) {
  const wantName = String(listing.etsy_section_name || "").trim();
  if (!wantName) return null;
  try {
    if (!etsySectionCache) {
      const { "Content-Type": _drop, ...bare } = hdrs;
      const r = await fetch(`https://openapi.etsy.com/v3/application/shops/${ETSY_SHOP_ID}/sections`, { headers: bare });
      if (!r.ok) return null;
      etsySectionCache = ((await r.json())?.results || []).map(x => ({ id: x.shop_section_id, title: decodeHtmlish(x.title || "") }));
    }
    const norm = t => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const hit = etsySectionCache.find(x => norm(x.title) === norm(wantName))
      || etsySectionCache.find(x => norm(x.title).startsWith(norm(wantName)));
    return hit ? hit.id : null;
  } catch { return null; }
}
// Etsy hands section titles back HTML-escaped — "Collector&#39;s Corner".
const decodeHtmlish = t => String(t).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&");
const ETSY_RETURN_POLICY = 1290534528477; // 14 days, no exchanges

// Section ID map: shape/type → Etsy section
const ETSY_SECTIONS = {
  "Sphere": 28345880, "Spheres": 28345880,
  "Heart": 58185469, "Hearts": 58185469, "Mini Hearts": 58185469,
  "Palmstone": 30952509, "Palmstones": 30952509, "Mini Palmstones": 30952509,
  "Bracelet": 28345876, "Bracelets": 28345876, "Chips Bracelets": 28345876,
  "Bowl - 2 inch": 30949825, "Bowl - 3 inch": 30949825, "Bowl - 4 inch": 30949825,
  "Bowl - 5 inch": 30949825, "Bowl - 6 inch": 30949825, "Bowl - 7 inch": 30949825,
  "Bowl - 8 inch": 30949825, "Bowl-10\"": 30949825,
  "Tower": 30692617, "Freeform": 30692617, "Double Point": 30692617,
  "Pendant": 30843294, "Pendants": 30843294, "Pendulum": 30843294,
  "Chips": 50040802,
  "Tumbled": 28345870,
  "Mineral": 28361899, "Rough": 30789512, "Specimen": 28361899,
  "Egg": 58326407, "Shivalingam": 58326407,
  "Skull": 28345884, "Animal": 28345884, "Ganesha - 1 inch": 58218908,
  "Pyramid": 50040802,
  "Mala": 30468353, "Wellness": 30146745,
  "Collector": 58168978,
};

/* Etsy taxonomy IDs, verified against /v3/application/seller-taxonomy/nodes.
   The old numbers here were guesses and every one of them was wrong — 1003 is
   "Decorative Bowls", not "Crystals & Healing Stones", which is why geodes were
   publishing as bowls. The listing form now sends an explicit
   `etsy_taxonomy_id` per category preset; this map is only the fallback for a
   listing saved before that existed. */
const ETSY_TAXONOMY = {
  "Jewellery":      1195,  // Jewelry > Bracelets > Beaded Bracelets
  "Healing/Reiki":  1158,  // Spirituality & Religion > Prayer Beads & Charms > Metaphysical Crystals
  "Lapidary":       1158,
  "Carvings":       2869,  // Home Decor > Home Accents > Statues
  "Decor":         12490,  // Home Decor > Home Accents
  "Mineral":        1893,  // Home Decor > Home Accents > Rocks & Geodes
  "Rough":          1959,  // Spirituality & Religion > Natural Curios > Mineral
  "default":        1158,
};

/* ── Dimensions & weight ──────────────────────────────────────────────────────
   Etsy carries physical size twice: as listing-level item_* fields, and again as
   per-taxonomy attributes (the Width/Height/Depth boxes on the listing page,
   whose property ids differ between categories). Both were being left empty, so
   Etsy fell back to suggesting numbers it had read off the photos. */
const DIM_UNITS = {
  mm: { api: "mm", scale: "Millimeters", toMm: 1 },
  cm: { api: "cm", scale: "Centimeters", toMm: 10 },
  m:  { api: "m",  scale: "Meters",      toMm: 1000 },
  in: { api: "in", scale: "Inches",      toMm: 25.4 },
  ft: { api: "ft", scale: "Feet",        toMm: 304.8 },
  yd: { api: "yd", scale: "Yards",       toMm: 914.4 },
};
const WEIGHT_UNITS = { g: "g", kg: "kg", oz: "oz", lb: "lb" };

function normDimUnit(u) {
  const k = String(u || "").trim().toLowerCase();
  if (DIM_UNITS[k]) return k;
  if (/^milli|^mm/.test(k)) return "mm";
  if (/^centi|^cm/.test(k)) return "cm";
  if (/^inch|^in\b|^"/.test(k)) return "in";
  if (/^feet|^foot|^ft/.test(k)) return "ft";
  if (/^met|^m$/.test(k)) return "m";
  if (/^yard|^yd/.test(k)) return "yd";
  return "";
}

/* "969g", "1.2 kg", "12.5" (bare number = grams, the unit the shop weighs in). */
function parseWeight(raw) {
  const m = String(raw ?? "").match(/([\d.]+)\s*(kgs?|kilograms?|g|gm|grams?|oz|ounces?|lbs?|pounds?)?/i);
  if (!m || !m[1] || !isFinite(+m[1]) || +m[1] <= 0) return null;
  const u = String(m[2] || "g").toLowerCase();
  let unit = /^k/.test(u) ? "kg" : /^o/.test(u) ? "oz" : /^(lb|pound)/.test(u) ? "lb" : "g";
  let v = +m[1];
  /* Etsy's editor shows weight as two boxes — kg + g, or lb + oz — and refuses
     to save a listing whose small box is 1000 g or 16 oz and over, or has
     decimals ("Item weight" error). So 3406 g goes as 3.406 kg (3 kg 406 g),
     grams are whole, and ounces past a pound become pounds. */
  if (unit === "g" && v >= 1000) { unit = "kg"; v = v / 1000; }
  if (unit === "oz" && v >= 16) { unit = "lb"; v = v / 16; }
  v = unit === "g" ? Math.max(1, Math.round(v)) : unit === "kg" ? Math.round(v * 1000) / 1000 : unit === "lb" ? Math.round(v * 16) / 16 : Math.round(v * 10) / 10;
  return { value: v, unit: WEIGHT_UNITS[unit] };
}

/* The form's own width/height/depth win; a plain "92 x 133 x 50 mm" or "45mm"
   typed in the free-text Size box is read as a fallback rather than dropped. */
function listingDimensions(listing) {
  const unit = normDimUnit(listing.dim_unit) || "mm";
  const num = v => { const n = parseFloat(v); return isFinite(n) && n > 0 ? +n.toFixed(2) : null; };
  let width = num(listing.width), height = num(listing.height), depth = num(listing.depth);

  if (!width && !height && !depth) {
    const size = String(listing.size || "");
    const parts = size.match(/([\d.]+)\s*(?:[x×*]\s*([\d.]+))?\s*(?:[x×*]\s*([\d.]+))?/);
    const su = normDimUnit((size.match(/(mm|cm|m|in|inch(?:es)?|ft|feet|yd)\b/i) || [])[1]) || unit;
    if (parts && parts[1]) {
      const scaled = [parts[1], parts[2], parts[3]].map(v => (v ? num(v) : null));
      [width, height, depth] = scaled;
      // A sphere's one size is its diameter: the same every way.
      if (width && !height && !depth && /sphere|ball|orb/i.test(`${listing.shape || ""} ${listing.title || ""}`)) height = depth = width;
      return { width, height, depth, unit: su };
    }
  }
  return { width, height, depth, unit };
}

/* Etsy names each taxonomy's Width/Height/Depth with its own property id and its
   own set of scales (Rocks & Geodes offers Millimeters, Metaphysical Crystals
   only Inches/Centimeters), so the ids and the unit are resolved per listing and
   the value converted into a scale the category actually offers. */
async function etsyTaxonomyProperties(taxonomyId, hdrs) {
  try {
    const r = await fetch(
      `https://openapi.etsy.com/v3/application/seller-taxonomy/nodes/${taxonomyId}/properties`,
      { headers: { "x-api-key": ETSY_API_KEY, Accept: "application/json" } }
    );
    if (!r.ok) return [];
    return (await r.json())?.results || [];
  } catch { return []; }
}


/* ── Claude AI helper ──────────────────────────────────────────────────────── */
const SHAPE_WORDS = "Sphere, Heart, Palmstone, Tower, Tumbled, Bracelet, Pendant, Pendulum, Rough, Mineral, Egg, Skull, Pyramid, Chips, Freeform, Wand, Point, Slab, Other";
async function aiGenerate(listing) {
  const { title, description, material, shape, origin, size, weight, tags = [], productType } = listing;

  const prompt = `You are an expert e-commerce copywriter for a premium crystal/gemstone shop called Atyahara.
Generate platform-optimised listing content for this product. Return ONLY valid JSON.

Product:
- Title: ${title}
- Material: ${material || ""}
- Shape/Form: ${shape || ""}
- Origin: ${origin || ""}
- Size: ${size || ""}
- Weight: ${weight || ""}
- Type: ${productType || ""}
- Base description: ${description || ""}
- Tags: ${tags.join(", ")}

Return JSON with these fields:
{
  "etsy_title": "max 140 chars, SEO-rich, natural, no ALL CAPS",
  "etsy_description": "3-4 paragraphs: 1) poetic product intro, 2) specifications bullet list (use •), 3) about Atyahara brand, 4) care/shipping note",
  "etsy_tags": ["exactly 13 strings", "each under 20 chars", "mix of material", "shape", "healing use", "chakra", "origin", "gift keywords"],
  "shopify_title": "clean concise title, max 70 chars",
  "shopify_description": "HTML body with <p> and <ul> tags, professional, SEO-friendly, 200-300 words",
  "shopify_tags": "20+ comma-separated tags for Shopify SEO",
  "seo_title": "max 70 chars for meta title",
  "seo_description": "max 155 chars for meta description",
  "suggested_section": "one of: Spheres, Hearts, Palmstones, Bracelets, Towers & Freeforms, Pendants & Pendulums, Tumbled Stones, Mineral Specimens, Rough Stones, Gemstone Bowls and More, Collector's Corner, Wellness",
  "material": "the stone's name, e.g. Ruby in Zoisite — only if the title or description says it, else empty",
  "shape": "one of: ${SHAPE_WORDS} — the one this piece is, else empty",
  "origin": "the country it's from — only if the title or description says it, else empty",
  "size": "e.g. 165mm or 3 inch — only if stated, else empty"
}`;

  /* OpenAI first — it's the key the rest of the ERP runs on; Anthropic only
     when that isn't set. The reply is long (two descriptions and 30-odd tags),
     so the token cap has room for all of it: a cut-off reply is unparseable. */
  let text = "";
  if (process.env.OPENAI_KEY || process.env.OPENAI_API_KEY) {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_KEY || process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: process.env.LISTING_AI_MODEL || "gpt-4.1-mini",
        max_tokens: 4000,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`AI error: ${data?.error?.message || r.status}`);
    text = data.choices?.[0]?.message?.content || "";
  } else if (process.env.ANTHROPIC_KEY) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 4000, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`AI error: ${data?.error?.message || r.status}`);
    text = data.content?.[0]?.text || "";
  } else throw new Error("No AI key is set in Vercel (OPENAI_KEY).");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("The AI's reply couldn't be read — try again.");
  return JSON.parse(match[0]);
}

/* ── Price research ─────────────────────────────────────────────────────────
   The admin is whoever signs in without a staff profile (same rule as the
   app shell: staff are the people listed in ng-users-v1). */
async function isAdminUser(user) {
  const email = String(user?.email || "").toLowerCase();
  if (!email) return false;
  const sb = createClient(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data } = await sb.from("app_data").select("value").eq("key", "ng-users-v1").maybeSingle();
  const v = typeof data?.value === "string" ? JSON.parse(data.value) : data?.value;
  return !(Array.isArray(v) ? v : []).some(u => String(u?.email || "").toLowerCase() === email);
}

const RESEARCH_STOP = new Set("the a an and or of for with from in on to by natural genuine real crystal crystals stone stones gemstone gem mineral minerals polished handmade raw piece large small big mini gift home decor rare quality high grade".split(" "));
const researchWords = t => [...new Set(String(t || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 2 && !RESEARCH_STOP.has(w)))];
const sizeMm = t => { const m = String(t || "").match(/(\d+(?:\.\d+)?)\s*(mm|cm|inch|in|")\b/i); if (!m) return 0; const n = +m[1]; return /cm/i.test(m[2]) ? n * 10 : /mm/i.test(m[2]) ? n : n * 25.4; };

/* Etsy's own search — no AI, so it costs nothing. Ranked by how many of the
   piece's words each listing shares, with a plain note on why it's close. */
async function researchEtsy(listing) {
  const stone = String(listing.material || "").trim(), shape = String(listing.shape || "").trim();
  const q = [stone, shape].filter(Boolean).join(" ") || String(listing.title || "").split(/[—|,-]/)[0];
  const url = `https://openapi.etsy.com/v3/application/listings/active?keywords=${encodeURIComponent(q.trim())}&limit=50&sort_on=score`;
  const r = await fetch(url, { headers: await etsyHeaders(false) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Etsy search: ${d.error || r.status}`);
  const mine = researchWords(`${listing.title} ${stone} ${shape}`);
  const ourMm = sizeMm(listing.size) || sizeMm(listing.title);
  const scored = (d.results || []).filter(x => String(x.shop_id) !== String(ETSY_SHOP_ID)).map(x => {
    const theirs = researchWords(x.title);
    const shared = mine.filter(w => theirs.includes(w));
    const mm = sizeMm(x.title);
    let score = shared.length;
    if (stone && x.title.toLowerCase().includes(stone.toLowerCase())) score += 3;
    if (shape && x.title.toLowerCase().includes(shape.toLowerCase().replace(/s$/, ""))) score += 2;
    if (ourMm && mm) score += Math.max(0, 2 - Math.abs(mm - ourMm) / ourMm * 4);
    const note = [
      stone && x.title.toLowerCase().includes(stone.toLowerCase()) ? `same stone` : "",
      shape && x.title.toLowerCase().includes(shape.toLowerCase().replace(/s$/, "")) ? `same shape` : "",
      ourMm && mm ? `${Math.round(mm)}mm vs ours ${Math.round(ourMm)}mm` : "",
      shared.length ? `shares “${shared.slice(0, 4).join(", ")}”` : "",
      x.num_favorers ? `${x.num_favorers} favourites` : "",
      x.quantity > 1 ? `${x.quantity} in stock (repeatable)` : "one of a kind",
    ].filter(Boolean).join(" · ");
    return { id: String(x.listing_id), title: x.title, url: x.url, where: "Etsy",
      price: x.price ? x.price.amount / x.price.divisor : 0, currency: x.price?.currency_code || "", note, score };
  }).sort((a, b) => b.score - a.score).slice(0, 12);
  // One batch call for their photos.
  if (scored.length) {
    try {
      const b = await fetch(`https://openapi.etsy.com/v3/application/listings/batch?listing_ids=${scored.map(x => x.id).join(",")}&includes=Images`, { headers: await etsyHeaders(false) });
      const bd = await b.json();
      const img = Object.fromEntries((bd.results || []).map(x => [String(x.listing_id), x.images?.[0]?.url_170x135 || x.images?.[0]?.url_570xN || ""]));
      scored.forEach(x => { x.image = img[x.id] || ""; });
    } catch {}
  }
  return scored.map(({ score, ...x }) => x);
}

/* Anywhere online — one AI call with web search, only when asked for. */
async function researchWeb(listing) {
  const key = process.env.OPENAI_KEY || process.env.OPENAI_API_KEY;
  if (!key) throw new Error("No OpenAI key is set in Vercel (OPENAI_KEY).");
  const desc = [listing.title, listing.material && `stone: ${listing.material}`, listing.shape && `shape: ${listing.shape}`,
    listing.size && `size: ${listing.size}`, listing.weight && `weight: ${listing.weight}`, listing.origin && `origin: ${listing.origin}`].filter(Boolean).join("; ");
  const prompt = `Find up to 8 items for sale online that are most similar to this piece: ${desc}.
Look across Etsy, eBay, crystal shops' own sites and marketplaces. Prefer the same stone, shape and a similar size. Skip anything sold by "Atyahara" or "Earth Editions" (that's us).
Return ONLY JSON: {"items":[{"title":"","url":"the item's own page","where":"site or shop name","price":number,"currency":"USD|INR|GBP|EUR…","note":"one short line: how close it is to ours and why (stone, shape, size, quality)"}]}`;
  const content = [{ type: "input_text", text: prompt }];
  const img = (listing.images || [])[0];
  if (img) content.push({ type: "input_image", image_url: img });
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: process.env.RESEARCH_AI_MODEL || "gpt-4.1-mini", tools: [{ type: "web_search_preview" }], input: [{ role: "user", content }], max_output_tokens: 2500 }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`AI error: ${d?.error?.message || r.status}`);
  const text = d.output_text || (d.output || []).flatMap(o => o.content || []).map(c => c.text || "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  let items = [];
  try { items = JSON.parse(m?.[0] || "{}").items || []; } catch {}
  return items.filter(x => /^https?:\/\//.test(x?.url || "")).slice(0, 8).map((x, i) => ({
    id: `w${i}`, title: String(x.title || ""), url: x.url, where: String(x.where || ""), price: +x.price || 0, currency: String(x.currency || "").toUpperCase(), note: String(x.note || ""), image: "",
  }));
}

/* ── Etsy: processing profile ("readiness state") ─────────────────────────────
   Publishing used to borrow whichever readiness_state_id the shop's most recent
   active listing happened to carry, so a ready-to-ship geode went out as "Made
   to order". The shop's own profiles are read instead: ready-to-ship, shortest
   turnaround, unless the listing is ticked made-to-order.

   The shop's rows come back as {readiness_state, min/max_processing_days};
   with none of them readable the feature degrades to sending nothing rather
   than sending the wrong profile. */
function readinessInfo(row = {}) {
  const min = +row.min_processing_days || 0;
  const max = +row.max_processing_days || min;
  const madeToOrder = String(row.readiness_state || "") === "made_to_order";
  const days = row.processing_days_display_label || (max && max !== min ? `${min}-${max} days` : `${min} day${min === 1 ? "" : "s"}`);
  return {
    id: row.readiness_state_id ?? null,
    min, max, madeToOrder,
    label: `${madeToOrder ? "Made to order" : "Ready to ship"} · ${days}`,
  };
}

async function etsyReadinessStates(hdrs) {
  try {
    const { "Content-Type": _drop, ...bare } = hdrs;
    const r = await fetch(
      `https://openapi.etsy.com/v3/application/shops/${ETSY_SHOP_ID}/readiness-state-definitions`,
      { headers: bare }
    );
    if (!r.ok) return [];
    // The raw row rides along: Etsy has changed these field names before, and
    // seeing them beats guessing at why every profile reads "1 days".
    return ((await r.json())?.results || []).map(readinessInfo).filter(x => x.id);
  } catch { return []; }
}

/* The listing's own pick wins; otherwise the fastest profile of the right kind. */
async function pickReadinessState(listing, hdrs) {
  if (listing.etsy_readiness_state_id) return +listing.etsy_readiness_state_id;
  const wantMadeToOrder = !!listing.etsy_made_to_order;
  const all = await etsyReadinessStates(hdrs);
  const pool = all.filter(x => x.madeToOrder === wantMadeToOrder);
  /* Stock sitting in the USA warehouse only moves when the shop is over for
     Denver or Tucson, so it takes the longest window the shop has rather than
     the shortest. It is still shorter than the truth — a processing profile of
     a few weeks has to be made on Etsy itself — but it does not promise
     tomorrow. */
  if (listing.etsy_slow_dispatch) {
    const slowest = (pool.length ? pool : all).sort((a, b) => (b.max - a.max) || (b.min - a.min))[0];
    if (slowest) return slowest.id;
  }
  const best = (pool.length ? pool : all).sort((a, b) => (a.min - b.min) || (a.max - b.max))[0];
  if (best) return best.id;

  // No definitions to go on: copy a live listing, but only one that isn't
  // made-to-order when this listing isn't — better nothing than the wrong one.
  try {
    const { "Content-Type": _drop, ...bare } = hdrs;
    const sample = await fetch(
      `https://openapi.etsy.com/v3/application/shops/${ETSY_SHOP_ID}/listings?state=active&limit=1`,
      { headers: bare }
    );
    const rid = (await sample.json())?.results?.[0]?.readiness_state_id;
    return wantMadeToOrder ? null : (rid || null);
  } catch { return null; }
}

/* ── Etsy: pick shipping profile based on price ────────────────────────────── */
function etsyShippingProfile(priceUSD) {
  const p = +priceUSD || 0;
  if (p >= 350) return ETSY_SHIPPING.above350;
  if (p >= 35)  return ETSY_SHIPPING.above35;
  return ETSY_SHIPPING.under35;
}

/* ── Etsy: upload one image (download from URL → multipart to Etsy) ──────── */
/* Says whether the photo went, and why not when it didn't.

   This used to return nothing on every path: a refused upload logged a line to
   a console nobody reads and the sync carried on as though the photo were
   there, then recorded the whole set as sent — so the next sync saw "no change"
   and never retried. A photo could go missing permanently and silently. */
async function uploadEtsyImage(listingId, imgUrl, rank, altText, authHdrs) {
  let imgResp;
  try {
    imgResp = await fetch(imgUrl);
    if (!imgResp.ok) return { ok: false, error: `couldn't fetch the photo (${imgResp.status})` };
  } catch (e) { return { ok: false, error: `couldn't fetch the photo: ${e.message}` }; }

  let buf;
  try { buf = await imgResp.arrayBuffer(); }
  catch (e) { return { ok: false, error: `couldn't read the photo: ${e.message}` }; }

  /* Etsy goes by the filename's extension, and a storage URL often carries none
     — "…/listing-photos/edited-1738" would have been sent as "photo-1.edited-1738".
     The response's own content-type is the reliable answer; the URL is the
     fallback for a host that doesn't send one. */
  const ctype = String(imgResp.headers.get("content-type") || "").toLowerCase();
  const urlExt = (imgUrl.split("?")[0].split("/").pop() || "").includes(".")
    ? imgUrl.split("?")[0].split(".").pop().toLowerCase().replace("jpeg", "jpg") : "";
  const ext  = ctype.includes("png") ? "png" : ctype.includes("webp") ? "webp"
    : ctype.includes("jpeg") || ctype.includes("jpg") ? "jpg"
    : ["png", "webp", "jpg", "gif"].includes(urlExt) ? urlExt : "jpg";
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";

  const { "Content-Type": _ct, ...bare } = authHdrs;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const form = new FormData();
      form.append("image", new Blob([buf], { type: mime }), `photo-${rank}.${ext}`);
      form.append("rank", String(rank));
      form.append("overwrite", "false");
      form.append("alt_text", (altText || "").slice(0, 250));
      const r = await fetch(
        `https://openapi.etsy.com/v3/application/shops/${ETSY_SHOP_ID}/listings/${listingId}/images`,
        { method: "POST", headers: bare, body: form }
      );
      if (r.ok) return { ok: true };
      const d = await r.json().catch(() => ({}));
      const why = d.error || d.error_description || d.message || `HTTP ${r.status}`;
      // A throttle clears in a moment; a refusal will not.
      if (r.status !== 429 && r.status < 500) {
        console.error("Etsy image upload error:", r.status, JSON.stringify(d));
        return { ok: false, error: why };
      }
    } catch (e) { console.error("Etsy image upload threw:", e.message); }
    await new Promise(r => setTimeout(r, 1100));
  }
  return { ok: false, error: "Etsy kept refusing the upload (rate limited)" };
}

/* ── Etsy: upload listing video (download from URL → multipart to Etsy) ────────
   Etsy allows ONE video per listing: MP4, ≤100MB, ~5–15s. Returns true on success. */
async function uploadEtsyVideo(listingId, videoUrl, authHdrs, name = "video") {
  try {
    const vResp = await fetch(videoUrl);
    if (!vResp.ok) { console.error("Etsy video fetch failed:", vResp.status); return false; }
    const buf  = await vResp.arrayBuffer();
    const mime = vResp.headers.get("content-type") || "video/mp4";
    const form = new FormData();
    form.append("video", new Blob([buf], { type: mime }), "video.mp4");
    form.append("name", String(name || "video").slice(0, 70));
    const { "Content-Type": _ct, ...bare } = authHdrs;
    const r = await fetch(
      `https://openapi.etsy.com/v3/application/shops/${ETSY_SHOP_ID}/listings/${listingId}/videos`,
      { method: "POST", headers: bare, body: form }
    );
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      console.error("Etsy video upload error:", r.status, JSON.stringify(d));
      return false;
    }
    return true;
  } catch (e) { console.error("Etsy video upload failed:", e.message); return false; }
}

/* ── Etsy: what video the listing is holding, and taking it off ───────────────
   Etsy allows one video per listing and does not swap it in place: an edited
   clip only arrives if the old one is deleted first. */
/* null when Etsy could not be asked, which is not the same as a listing with no
   photos — and telling the two apart is the whole point. Answering [] to a
   throttled request made the sync believe the listing was empty, so it uploaded
   a full set on top of the photos already there. That is where the doubles came
   from. One retry, because the usual reason is the per-second limit and a
   moment's wait clears it. */
async function etsyListingImages(listingId, authHdrs) {
  const { "Content-Type": _ct, ...bare } = authHdrs;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`https://openapi.etsy.com/v3/application/listings/${listingId}/images`, { headers: bare });
      if (r.ok) {
        const d = await r.json().catch(() => ({}));
        return Array.isArray(d?.results) ? d.results : [];
      }
      if (r.status !== 429 && r.status < 500) {
        console.error("Etsy images list failed:", r.status);
        return null;
      }
    } catch (e) { console.error("Etsy images list threw:", e.message); }
    await new Promise(r => setTimeout(r, 1100));
  }
  return null;
}

/* Says whether the photo actually went. A rejected DELETE answers with a
   response rather than throwing, so awaiting it and moving on counted a refusal
   as a deletion — and the upload that followed sat on top of a photo that was
   still there. */
async function deleteEtsyImage(listingId, imageId, authHdrs) {
  if (!imageId) return { ok: false, error: "no image id" };
  const { "Content-Type": _ct, ...bare } = authHdrs;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`https://openapi.etsy.com/v3/application/shops/${ETSY_SHOP_ID}/listings/${listingId}/images/${imageId}`, { method: "DELETE", headers: bare });
      if (r.ok || r.status === 404) return { ok: true };   // gone is gone
      if (r.status !== 429 && r.status < 500) {
        const d = await r.json().catch(() => ({}));
        const why = d.error || d.error_description || d.message || `HTTP ${r.status}`;
        console.error("Etsy image delete failed:", r.status, imageId, why);
        return { ok: false, error: why };
      }
    } catch (e) { console.error("Etsy image delete threw:", e.message); }
    await new Promise(r => setTimeout(r, 1100));
  }
  return { ok: false, error: "Etsy kept refusing the delete (rate limited)" };
}

async function etsyListingVideos(listingId, authHdrs) {
  try {
    const { "Content-Type": _ct, ...bare } = authHdrs;
    const r = await fetch(`https://openapi.etsy.com/v3/application/listings/${listingId}/videos`, { headers: bare });
    if (!r.ok) return [];
    const d = await r.json().catch(() => ({}));
    return Array.isArray(d?.results) ? d.results : [];
  } catch { return []; }
}

async function deleteEtsyVideo(listingId, videoId, authHdrs) {
  try {
    const { "Content-Type": _ct, ...bare } = authHdrs;
    const r = await fetch(
      `https://openapi.etsy.com/v3/application/shops/${ETSY_SHOP_ID}/listings/${listingId}/videos/${videoId}`,
      { method: "DELETE", headers: bare }
    );
    return r.ok || r.status === 404;
  } catch { return false; }
}

/* ── Tags: the form is the record, the AI is a suggestion ──────────────────── */
/* Generate merges its tags into the listing's own chips, and those chips are
   what the seller then edits by hand — so the list on the form is the only one
   they can see and the only one they can change. Preferring the AI's snapshot
   over it meant a tag typed after Generate never reached Etsy, and a thin AI
   reply carrying "etsy_tags": [] published the listing with no tags at all,
   because an empty array is truthy and won the `||`.

   Title and description are the other way round on purpose: those have their
   own per-platform override boxes, folded into `_ai` on the way out, so there
   the `_ai` value *is* what the seller asked for. */
function curatedTags(own, suggested, maxLen = 20) {
  const list = Array.isArray(own) && own.length ? own
    : Array.isArray(suggested) ? suggested
    : typeof suggested === "string" ? suggested.split(",")
    : [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    // Etsy caps a tag at 20 characters and rejects the whole array if one is
    // over, which is how a single long AI tag could take all thirteen down
    // with it. Trimmed here rather than trusted; Shopify is far more generous,
    // so it passes its own limit in.
    const clean = String(raw || "").replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
    // Cut back to a whole word rather than leaving "a really very long t".
    let tag = clean.slice(0, maxLen).trim();
    if (clean.length > maxLen && tag.includes(" ")) tag = tag.slice(0, tag.lastIndexOf(" "));
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/* Etsy accepts the create, then keeps whatever tags it liked and says nothing
   about the rest. Reading the listing back is the only way to know the
   seller's tags actually landed — and telling them beats a green tick over an
   untagged listing, which is how this went unnoticed in the first place. */
async function verifyEtsyTags(listingId, expected, hdrs) {
  if (!expected.length) return null;
  try {
    const r = await fetch(`https://openapi.etsy.com/v3/application/listings/${listingId}`, { headers: hdrs });
    if (!r.ok) return null;
    const live = ((await r.json())?.tags || []).map(t => String(t).toLowerCase());
    const missing = expected.filter(t => !live.includes(t.toLowerCase()));
    if (!missing.length) return null;
    console.warn(`[etsy] listing ${listingId}: kept ${live.length}/${expected.length} tags, missing ${JSON.stringify(missing)}`);
    return `Etsy kept ${live.length} of ${expected.length} tags — missing: ${missing.join(", ")}`;
  } catch { return null; }
}

/* The USA warehouse note the Telegram bot used to add to every description:
   no longer true, so it's taken out of anything sent to a platform. */
export const stripWarehouseNote = t => String(t || "").replace(/\n*\s*Please note: this piece is held in our USA warehouse[^\n]*\n?/gi, "\n").replace(/\n{3,}/g, "\n\n").trim();

/* ── Etsy: publish listing ─────────────────────────────────────────────────── */
/* Taking a listing off draft and putting it on sale. Etsy wants this as its own
   PATCH; the shop-scoped route is the more permissive one for drafts, and the
   global one is the fallback. Kept apart from creating a listing because a
   draft that already exists has to be able to go live on its own — which it
   could not, and is why pressing Publish on a draft said it had worked while
   Etsy went on showing a draft. */
async function activateEtsyListing(listingId, readinessStateId = null) {
  const hdrs = await etsyHeaders();
  const body = { state: "active", ...(readinessStateId ? { readiness_state_id: readinessStateId } : {}) };
  let r = await fetch(`https://openapi.etsy.com/v3/application/shops/${ETSY_SHOP_ID}/listings/${listingId}`,
    { method: "PATCH", headers: hdrs, body: JSON.stringify(body) });
  if (!r.ok) {
    r = await fetch(`https://openapi.etsy.com/v3/application/listings/${listingId}`,
      { method: "PATCH", headers: hdrs, body: JSON.stringify(body) });
  }
  if (r.ok) return { ok: true };
  const d = await r.json().catch(() => ({}));
  const why = String(d.error || d.error_description || d.message || `HTTP ${r.status}`).slice(0, 180);
  console.error("Etsy activate failed:", r.status, JSON.stringify(d));
  return { ok: false, error: why };
}

export async function publishEtsy(listing, ai, { activate = true } = {}) {
  const {
    title, material, shape, productType, qty = 1, type = "repeatable",
    price_etsy, price_etsy_usd, images = [],
  } = listing;

  const etsyTitle = ai?.etsy_title || title;
  const etsyDesc  = stripWarehouseNote(ai?.etsy_description || listing.description || title);
  const etsyTags  = curatedTags(listing.tags, ai?.etsy_tags).slice(0, 13);

  const sectionId      = listing.etsy_section_id   || ETSY_SECTIONS[shape] || ETSY_SECTIONS[productType] || null;
  const taxonomyId     = listing.etsy_taxonomy_id  || ETSY_TAXONOMY[productType] || ETSY_TAXONOMY.default;
  const wantedShipping = listing.etsy_shipping_profile_id || etsyShippingProfile(price_etsy_usd || (price_etsy / 84));
  const returnPolicyId = listing.etsy_return_policy_id    || ETSY_RETURN_POLICY;
  const quantity       = type === "unique" ? 1 : Math.max(1, +qty || 1);

  const dims   = listingDimensions(listing);
  const weight = parseWeight(listing.weight);

  const hdrs = await etsyHeaders();
  const shippingId = await resolveShippingProfile(wantedShipping, hdrs, { preferUsa: !!listing.etsy_slow_dispatch });
  const namedSection = await resolveSectionId(listing, hdrs);

  const payload = {
    quantity,
    title:       etsyTitle.slice(0, 140),
    description: etsyDesc,
    price:       +(price_etsy || 0),
    who_made:    "i_did",
    when_made:   "2020_2026",
    taxonomy_id: taxonomyId,
    shipping_profile_id: shippingId,
    return_policy_id:    returnPolicyId,
    tags:      etsyTags,
    materials: material ? [material] : [],
    is_supply: false,
    is_digital: false,
    // Shipping-side dimensions; the Width/Height/Depth boxes buyers see are
    // taxonomy attributes and are set separately once the listing exists.
    /* The only place a size goes. Etsy's Width / Height / Depth attributes were
       written to as well until they were deprecated — "Property id 512 is
       deprecated and cannot be used in this request" — and the attempts spent
       the per-second rate limit on requests that could never succeed. These
       fields are the supported ones, and the ones the shipping calculator reads. */
    ...(dims.width  ? { item_width:  dims.width  } : {}),
    ...(dims.height ? { item_height: dims.height } : {}),
    ...(dims.depth  ? { item_length: dims.depth  } : {}),
    ...(dims.width || dims.height || dims.depth
      ? { item_dimensions_unit: (DIM_UNITS[dims.unit] || DIM_UNITS.mm).api } : {}),
    ...(weight ? { item_weight: weight.value, item_weight_unit: weight.unit } : {}),
    should_auto_renew: listing.etsy_auto_renew ?? false,
    ...(listing.etsy_ads ? { is_on_etsy_ads: true } : {}),
    ...((namedSection || sectionId) ? { shop_section_id: namedSection || sectionId } : {}),
    ...(listingSku(listing) ? { skus: [listingSku(listing)] } : {}),
  };

  const readinessId = await pickReadinessState(listing, hdrs);
  if (readinessId) payload.readiness_state_id = readinessId;

  const r = await fetch(`https://openapi.etsy.com/v3/application/shops/${ETSY_SHOP_ID}/listings`, {
    method: "POST", headers: hdrs, body: JSON.stringify(payload),
  });

  const data = await r.json();
  if (!r.ok) throw new Error(`Etsy create failed: ${data.error || JSON.stringify(data)}`);

  const listingId = data.listing_id;

  // Upload images FIRST — Etsy requires images before activation
  const imgUrls = images.filter(u => typeof u === "string" && u.startsWith("http")).slice(0, 10);
  for (let i = 0; i < imgUrls.length; i++) {
    const up = await uploadEtsyImage(listingId, imgUrls[i], i + 1, etsyTitle, hdrs);
    if (!up.ok) console.error(`Etsy photo ${i + 1} didn't go up:`, up.error);
    if (i < imgUrls.length - 1) await new Promise(r => setTimeout(r, 400));
  }

  // Optional listing video (one per listing)
  let videoSrc = "";
  if (listing.video && typeof listing.video === "string" && listing.video.startsWith("http")) {
    if (await uploadEtsyVideo(listingId, listing.video, hdrs, etsyTitle)) videoSrc = listing.video;
  }

  // Variations before it goes live, so it never shows without them.
  const varWarn = await applyEtsyVariations(listingId, listing, hdrs, payload.readiness_state_id);

  let finalStatus = "draft";

  if (activate) {
    // Brief pause — Etsy sometimes needs a moment after image upload before state change
    await new Promise(r => setTimeout(r, 800));

    const activateBody = {
      state: "active",
      ...(payload.readiness_state_id ? { readiness_state_id: payload.readiness_state_id } : {}),
    };

    // Try shop-scoped PATCH first (more permissive for drafts), then global
    let activateR = await fetch(
      `https://openapi.etsy.com/v3/application/shops/${ETSY_SHOP_ID}/listings/${listingId}`,
      { method: "PATCH", headers: hdrs, body: JSON.stringify(activateBody) }
    );
    if (!activateR.ok) {
      activateR = await fetch(`https://openapi.etsy.com/v3/application/listings/${listingId}`, {
        method: "PATCH", headers: hdrs, body: JSON.stringify(activateBody),
      });
    }
    if (activateR.ok) {
      finalStatus = "active";
    } else {
      const ad = await activateR.json().catch(() => ({}));
      console.error("Etsy activate failed:", activateR.status, JSON.stringify(ad));
    }
  }

  const tagsWarning = await verifyEtsyTags(listingId, etsyTags, hdrs);

  const gaps = [];
  if (!etsyTags.length) gaps.push("no tags");
  if (!payload.materials.length) gaps.push("no materials");
  if (!dims.width && !dims.height && !dims.depth) gaps.push("no dimensions");
  if (!weight) gaps.push("no weight");
  /* Two different things used to be reported as one. A missing material or
     weight is the seller's to fill in. A category's own Width/Height boxes
     refusing a value is not: the measurement already went up in the listing's
     own item_width / item_height, so the size is on Etsy either way, and there
     is nothing on the form to correct. Telling someone to fill in a field that
     is already filled sends them looking for a fault that isn't there. */
  if (varWarn) gaps.push(varWarn);

  return {
    listing_id: listingId, url: `https://www.etsy.com/listing/${listingId}`, status: finalStatus,
    tags_applied: etsyTags.length, videoSrc, imagesSrc: imgUrls, ...(varWarn ? { variationsWarning: varWarn } : {}), ...(tagsWarning ? { tagsWarning } : {}),
    ...(gaps.length ? { fieldsWarning: `Published with ${gaps.join(", ")} — fill these in on the listing form and re-sync.` } : {}),
  };
}

/* ── Etsy: update listing ──────────────────────────────────────────────────── */
/* ── Etsy: variations ──────────────────────────────────────────────────────
   The listing's variations (Size: 3×3 / 4×4 / 5×5 …) go on as Etsy's inventory:
   one product per option (or per combination, for two axes), on Etsy's two
   custom properties (513, 514). An axis priced per option carries its prices
   (listing currency, the same as price_etsy); per-option stock carries through
   too. Returns a warning string, or "" when it went through. */
const ETSY_CUSTOM_PROPS = [513, 514];
function etsyVariationAxes(listing) {
  return (Array.isArray(listing.variations) ? listing.variations : [])
    .map(v => ({ name: String(v.name || "").trim().slice(0, 45), per: !!v.perVariantPricing,
      options: (v.options || []).filter(o => String(o.label || "").trim()) }))
    .filter(v => v.name && v.options.length)
    .slice(0, 2);
}
async function applyEtsyVariations(listingId, listing, hdrs, readinessId) {
  const axes = etsyVariationAxes(listing);
  if (!axes.length) return "";
  const basePrice = +listing.price_etsy || 0;
  const baseQty = listing.type === "unique" ? 1 : Math.max(1, +listing.qty || 1);
  const sku = listingSku(listing);
  const combos = axes.length === 1 ? axes[0].options.map(o => [o]) : axes[0].options.flatMap(a => axes[1].options.map(b => [a, b]));
  const products = combos.map((opts, i) => {
    const priced = opts.find((o, k) => axes[k].per && +o.price_etsy > 0);
    const price = +(priced?.price_etsy || basePrice);
    const q = axes.length === 1 && String(opts[0].qty ?? "").trim() !== "" ? Math.max(0, Math.floor(+opts[0].qty || 0)) : baseQty;
    return {
      ...(sku ? { sku: `${sku}-${i + 1}`.slice(0, 32) } : {}),
      property_values: opts.map((o, k) => ({ property_id: ETSY_CUSTOM_PROPS[k], property_name: axes[k].name, value_ids: [], values: [String(o.label).trim().slice(0, 45)] })),
      offerings: [{ price: parseFloat(price.toFixed(2)), quantity: q, is_enabled: q > 0 || combos.length === 1, ...(readinessId ? { readiness_state_id: readinessId } : {}) }],
    };
  });
  const onProps = axes.map((a, k) => ETSY_CUSTOM_PROPS[k]);
  const body = {
    products,
    price_on_property: axes.map((a, k) => a.per ? ETSY_CUSTOM_PROPS[k] : null).filter(Boolean),
    quantity_on_property: axes.length === 1 ? onProps : [],
    sku_on_property: sku ? onProps : [],
    ...(readinessId ? { readiness_state_on_property: [] } : {}),
  };
  try {
    const r = await fetch(`https://openapi.etsy.com/v3/application/listings/${listingId}/inventory`, { method: "PUT", headers: hdrs, body: JSON.stringify(body) });
    if (r.ok) return "";
    const d = await r.json().catch(() => ({}));
    console.error("Etsy inventory update failed:", JSON.stringify(d));
    return `Etsy didn't take the sizes/options: ${d.error_description || d.error || d.message || r.status}`;
  } catch (e) { return `Etsy didn't take the variations: ${e.message}`; }
}

async function updateEtsyListing(listingId, listing, ai, { forcePhotos = false } = {}) {
  const etsyTitle = ai?.etsy_title || listing.title;
  const etsyDesc  = stripWarehouseNote(ai?.etsy_description || listing.description || listing.title);
  const etsyTags  = curatedTags(listing.tags, ai?.etsy_tags).slice(0, 13);
  const quantity  = listing.type === "unique" ? 1 : Math.max(1, +listing.qty || 1);
  const dims      = listingDimensions(listing);
  const weight    = parseWeight(listing.weight);
  // Re-sync is also the repair path for the listings published under the old,
  // wrong taxonomy ids — the category on the form is what the listing gets.
  const taxonomyId = listing.etsy_taxonomy_id || ETSY_TAXONOMY[listing.productType] || ETSY_TAXONOMY.default;

  const hdrs = await etsyHeaders();
  // Re-sync is the repair path for listings that went out under whatever
  // profile the API happened to inherit: unticked means ready to ship, and a
  // listing saved before the tick existed counts as unticked.
  const readinessId = await pickReadinessState(listing, hdrs);
  const patchBody = {
    title:       etsyTitle.slice(0, 140),
    description: etsyDesc,
    // With variations, price and stock live on each option (the inventory call below).
    ...(etsyVariationAxes(listing).length ? {} : { price: parseFloat((+listing.price_etsy || 0).toFixed(2)), quantity }),
    tags:        etsyTags,
    taxonomy_id: taxonomyId,
    ...(readinessId ? { readiness_state_id: readinessId } : {}),
    ...(listing.material ? { materials: [listing.material] } : {}),
    should_auto_renew: listing.etsy_auto_renew ?? false,
    /* The only place a size goes. Etsy's Width / Height / Depth attributes were
       written to as well until they were deprecated — "Property id 512 is
       deprecated and cannot be used in this request" — and the attempts spent
       the per-second rate limit on requests that could never succeed. These
       fields are the supported ones, and the ones the shipping calculator reads. */
    ...(dims.width  ? { item_width:  dims.width  } : {}),
    ...(dims.height ? { item_height: dims.height } : {}),
    ...(dims.depth  ? { item_length: dims.depth  } : {}),
    ...(dims.width || dims.height || dims.depth
      ? { item_dimensions_unit: (DIM_UNITS[dims.unit] || DIM_UNITS.mm).api } : {}),
    ...(weight ? { item_weight: weight.value, item_weight_unit: weight.unit } : {}),
    ...(listingSku(listing) ? { skus: [listingSku(listing)] } : {}),
  };

  const existingStatus = listing.platforms?.etsy?.status || "draft";

  // Try shop-scoped endpoint first (works for both draft + active listings)
  let r = await fetch(`https://openapi.etsy.com/v3/application/shops/${ETSY_SHOP_ID}/listings/${listingId}`, {
    method: "PATCH", headers: hdrs, body: JSON.stringify(patchBody),
  });

  // Fall back to global endpoint
  if (!r.ok) {
    const fallback = await fetch(`https://openapi.etsy.com/v3/application/listings/${listingId}`, {
      method: "PATCH", headers: hdrs, body: JSON.stringify(patchBody),
    });
    // If both fail, log and return existing data — NEVER create a new listing from an update path
    if (!fallback.ok) {
      const errData = await fallback.json().catch(() => ({}));
      const msg = errData.error_description || errData.error || errData.message || `HTTP ${fallback.status}`;
      console.warn(`Etsy PATCH failed for listing ${listingId}: ${msg} — skipping sync, keeping existing listing_id`);
      // The options are their own call — still send them, and say what Etsy refused.
      const varWarn = await applyEtsyVariations(listingId, listing, hdrs, readinessId);
      return { listing_id: listingId, status: existingStatus, sync_skipped: true,
        fieldsWarning: `Etsy refused the update: ${msg}${varWarn ? ` · ${varWarn}` : ""}`, ...(varWarn ? { variationsWarning: varWarn } : {}) };
    }
    r = fallback;
  }

  const data = await r.json();
  if (!r.ok) {
    const msg = data.error_description || data.error || data.message || JSON.stringify(data);
    console.warn(`Etsy update failed for ${listingId}: ${msg} — keeping existing listing_id`);
    const varWarn = await applyEtsyVariations(listingId, listing, hdrs, readinessId);
    return { listing_id: listingId, status: existingStatus, sync_skipped: true,
      fieldsWarning: `Etsy refused the update: ${msg}${varWarn ? ` · ${varWarn}` : ""}`, ...(varWarn ? { variationsWarning: varWarn } : {}) };
  }

  /* Photos, only when they've changed. Every sync used to upload all of them
     again on top of what Etsy held — slow, and a listing filled up with
     copies until Etsy's 10-photo cap turned the rest away. The listing
     remembers what it last sent (imagesSrc): the same list is left alone, a
     different one replaces Etsy's photos. With no record (put on Etsy by hand,
     or synced before this) photos already on Etsy are kept. */
  const imgUrls = (listing.images || []).filter(u => typeof u === "string" && u.startsWith("http")).slice(0, 10);
  const sent = listing.platforms?.etsy?.imagesSrc;
  const liveImgs = await etsyListingImages(listingId, hdrs);
  /* Not knowing what Etsy holds is a reason to do nothing. Uploading anyway is
     how a listing ends up showing the same stone twice, and a sync that skipped
     the photos costs nothing but another sync. */
  let photosWarning = "";
  let imagesSrc = Array.isArray(sent) ? sent : undefined;
  if (liveImgs == null) {
    photosWarning = "Couldn't read the photos already on Etsy, so they were left alone — re-sync to try again.";
  } else {
    /* Normally the listing's own record of what it last sent decides this, which
       is what stops every save re-uploading the same photos. But a photo edited
       in place keeps its URL, and a listing fixed by hand on Etsy has a record
       that no longer describes what is there — in both cases the record says
       "unchanged" and the new photos never go. Resync photos is the override:
       the operator has looked at both and knows they differ. */
    const photosChanged = forcePhotos
      || (Array.isArray(sent) ? sent.join("|") !== imgUrls.join("|") : !liveImgs.length);
    if (photosChanged && imgUrls.length) {
      /* Swapping the set without ever emptying the listing.

         Deleting all the old photos first and then uploading is the obvious
         order, and it is wrong: a live listing may not be left without a photo,
         so Etsy refuses the delete that would empty it. The whole swap was then
         abandoned and the new photos never went. It only ever worked while the
         listing was still a draft.

         So one old photo is held back to keep the listing legal, the new set
         goes up beside it, and it leaves last. Etsy caps a listing at ten, and
         that kept photo occupies one of them — hence the nine, with any tenth
         sent once the old one is gone.

         The order still matters: nothing is uploaded until every delete that
         was attempted has succeeded, because a half-done swap is how a listing
         ends up showing the same stone twice. */
      const CAP = 10;
      const keep  = liveImgs[liveImgs.length - 1];
      const first = liveImgs.slice(0, -1);

      const failed = [];
      for (const im of first) {
        const d = await deleteEtsyImage(listingId, im.listing_image_id, hdrs);
        if (!d.ok) failed.push(d.error);
      }

      if (failed.length) {
        photosWarning = `Etsy wouldn't remove the old photos (${failed[0]}), so the new ones were held back rather than added on top — try Resync photos again.`;
      } else {
        const upload = async (urls, from) => {
          const bad = [];
          for (let i = 0; i < urls.length; i++) {
            const up = await uploadEtsyImage(listingId, urls[i], from + i + 1, etsyTitle, hdrs);
            if (!up.ok) bad.push(`photo ${from + i + 1}: ${up.error}`);
            if (i < urls.length - 1) await new Promise(r => setTimeout(r, 400));
          }
          return bad;
        };
        const headroom = CAP - (keep ? 1 : 0);
        const bad = await upload(imgUrls.slice(0, headroom), 0);

        // The last of the old ones goes now that the listing has others to stand on.
        if (keep) {
          const d = await deleteEtsyImage(listingId, keep.listing_image_id, hdrs);
          if (!d.ok) bad.push(`the old cover stayed (${d.error})`);
          else bad.push(...await upload(imgUrls.slice(headroom), headroom));
        }

        /* Record what Etsy actually holds, not what was asked for. Writing the
           full list after a partial upload is what would tell the next sync
           "nothing changed" and strand the missing photos for good. */
        imagesSrc = bad.length ? imgUrls.filter((_, i) => !bad.some(b => b.startsWith(`photo ${i + 1}:`))) : imgUrls;
        if (bad.length) photosWarning = `Etsy took some but not all of the photos — ${bad.join("; ")}. Try Resync photos again.`;
      }
    } else {
      imagesSrc = imgUrls;
    }
  }

  /* Optional listing video — best-effort. The listing remembers the file it
     last sent to Etsy; an unchanged one is left alone rather than re-uploaded
     (it is a ~100MB round trip on every save), and a changed one replaces what
     is there, so an edit made here actually shows on the listing. */
  let videoSrc = listing.platforms?.etsy?.videoSrc || "";
  if (listing.video && typeof listing.video === "string" && listing.video.startsWith("http")) {
    const live = await etsyListingVideos(listingId, hdrs);
    // As on Shopify: no record of what was sent means leave it be, unless the
    // clip was edited here and the listing is holding the older cut.
    const changed = videoSrc ? videoSrc !== listing.video : !!listing.videoEdit?.at;
    if (!live.length || changed) {
      if (changed) for (const v of live) await deleteEtsyVideo(listingId, v.video_id || v.listing_video_id, hdrs);
      if (await uploadEtsyVideo(listingId, listing.video, hdrs, etsyTitle)) videoSrc = listing.video;
    } else { videoSrc = listing.video; }
  }

  const varWarn     = await applyEtsyVariations(listingId, listing, hdrs, readinessId);
  const tagsWarning = await verifyEtsyTags(listingId, etsyTags, hdrs);

  const gaps = [];
  if (!etsyTags.length) gaps.push("no tags");
  if (!listing.material) gaps.push("no materials");
  if (!dims.width && !dims.height && !dims.depth) gaps.push("no dimensions");
  if (!weight) gaps.push("no weight");
  if (varWarn) gaps.push(varWarn);

  return { listing_id: listingId, status: existingStatus, tags_applied: etsyTags.length, videoSrc, imagesSrc, ...(photosWarning ? { photosWarning } : {}), ...(varWarn ? { variationsWarning: varWarn } : {}),
    ...(tagsWarning ? { tagsWarning } : {}),
    ...(gaps.length ? { fieldsWarning: `Synced with ${gaps.join(", ")} — fill these in on the listing form and re-sync.` } : {}) };
}

/* ── Etsy: delete/end listing ──────────────────────────────────────────────── */
async function unpublishEtsy(listingId) {
  const r = await fetch(`https://openapi.etsy.com/v3/application/listings/${listingId}`, {
    method: "DELETE",
    headers: await etsyHeaders(false),
  });
  if (!r.ok && r.status !== 404) {
    const d = await r.json().catch(() => ({}));
    throw new Error(`Etsy delete failed: ${d.error || r.status}`);
  }
  return { listing_id: listingId, status: "deleted" };
}

/* ── Shopify: publish product ──────────────────────────────────────────────── */
function shopifyImageUrls(images = []) {
  return [...new Set(images.filter(url => typeof url === "string" && /^https?:\/\//i.test(url)))].slice(0, 10);
}

async function syncShopifyImages(store, token, productId, images = []) {
  const urls = shopifyImageUrls(images);
  if (urls.length === 0) return { uploaded: 0 };

  const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": token };
  const existingResp = await fetch(`https://${store}/admin/api/2024-04/products/${productId}/images.json`, {
    headers,
  });
  const existingData = await existingResp.json().catch(() => ({}));
  if (!existingResp.ok) {
    throw new Error(`Shopify image lookup failed: ${JSON.stringify(existingData.errors || existingData)}`);
  }

  for (const image of existingData.images || []) {
    const deleteResp = await fetch(`https://${store}/admin/api/2024-04/products/${productId}/images/${image.id}.json`, {
      method: "DELETE",
      headers: { "X-Shopify-Access-Token": token },
    });
    if (!deleteResp.ok && deleteResp.status !== 404) {
      const deleteData = await deleteResp.json().catch(() => ({}));
      throw new Error(`Shopify image delete failed: ${JSON.stringify(deleteData.errors || deleteData)}`);
    }
  }

  let uploaded = 0;
  for (const [i, src] of urls.entries()) {
    const uploadResp = await fetch(`https://${store}/admin/api/2024-04/products/${productId}/images.json`, {
      method: "POST",
      headers,
      body: JSON.stringify({ image: { src, position: i + 1 } }),
    });
    const uploadData = await uploadResp.json().catch(() => ({}));
    if (!uploadResp.ok) {
      throw new Error(`Shopify image upload failed (${i + 1}/${urls.length}): ${JSON.stringify(uploadData.errors || uploadData)}`);
    }
    uploaded += 1;
  }

  return { uploaded };
}

// Turn the app's `variations` (each = one option axis with labelled options) into Shopify's
// product options + variant grid. Returns null when there's nothing publishable, in which case
// the caller falls back to a single default variant. Shopify caps a product at 3 option axes.
// Per-option price/qty only maps unambiguously to a single axis with per-variant pricing on;
// with multiple axes (a cartesian grid) every combo falls back to the listing's base price/qty.
function buildShopifyVariants(listing) {
  const axes = (Array.isArray(listing.variations) ? listing.variations : [])
    .map(v => ({
      name: String(v.name || "").trim(),
      perVariantPricing: !!v.perVariantPricing,
      options: (v.options || []).filter(o => String(o.label || "").trim()),
    }))
    .filter(v => v.name && v.options.length)
    .slice(0, 3);
  if (!axes.length) return null;

  const basePrice = String(listing.price_shopify || 0);
  const baseQty = listing.type === "unique" ? 1 : Math.max(0, +listing.qty || 0);
  const perVar = axes.length === 1 && axes[0].perVariantPricing;

  const options = axes.map(a => ({ name: a.name, values: a.options.map(o => o.label.trim()) }));

  // Cartesian product of every axis's options.
  let combos = [[]];
  for (const a of axes) {
    const next = [];
    for (const c of combos) for (const o of a.options) next.push([...c, o]);
    combos = next;
  }

  const variants = combos.map(combo => {
    const variant = { inventory_management: "shopify", inventory_policy: "deny" };
    combo.forEach((o, idx) => { variant[`option${idx + 1}`] = o.label.trim(); });
    const opt = combo[0];
    const optPrice = perVar && opt.price_shopify !== "" && opt.price_shopify != null ? +opt.price_shopify : NaN;
    variant.price = String(Number.isFinite(optPrice) && optPrice >= 0 ? optPrice : basePrice);
    const optQty = perVar && opt.qty !== "" && opt.qty != null ? +opt.qty : NaN;
    variant.inventory_quantity = Number.isFinite(optQty) && optQty >= 0 ? Math.floor(optQty) : baseQty;
    return variant;
  });

  return { options, variants };
}

/* ── Shopify: upload ONE listing video (staged upload → productCreateMedia) ─────
   Shopify ingests the file through a staged target before it is attached to the
   product. Best-effort — returns {ok,error} so a video hiccup never fails the
   product publish itself. */
async function pushShopifyVideo(store, token, productId, videoUrl) {
  if (!videoUrl || typeof videoUrl !== "string" || !videoUrl.startsWith("http")) return { ok: false, skipped: true };
  const cleanUrl = videoUrl.split("?")[0];
  const filename = cleanUrl.split("/").pop() || "video.mp4";
  const ext = filename.split(".").pop().toLowerCase();
  const mimeType = ext === "mov" ? "video/quicktime" : ext === "webm" ? "video/webm" : "video/mp4";
  const gqlUrl = `https://${store}/admin/api/2024-04/graphql.json`;
  const gqlHeaders = { "Content-Type": "application/json", "X-Shopify-Access-Token": token };
  try {
    // Some public storage/CDN HEAD responses omit content-length. Shopify rejects
    // a staged VIDEO upload with fileSize=0, so fetch once up front when needed and
    // reuse that blob for the multipart upload below.
    const headRes = await fetch(cleanUrl, { method: "HEAD" });
    let fileSize = +(headRes.headers.get("content-length") || 0);
    let videoBlob = null;
    if (!Number.isFinite(fileSize) || fileSize <= 0) {
      const videoRes = await fetch(cleanUrl);
      if (!videoRes.ok) throw new Error(`Fetching video failed: ${videoRes.status}`);
      videoBlob = await videoRes.blob();
      fileSize = videoBlob.size;
    }
    if (!fileSize) throw new Error("Video file is empty or its size could not be determined");
    const stagedRes = await fetch(gqlUrl, {
      method: "POST", headers: gqlHeaders,
      body: JSON.stringify({
        query: `mutation stagedUploadsCreate($input:[StagedUploadInput!]!){stagedUploadsCreate(input:$input){stagedTargets{url resourceUrl parameters{name value}}userErrors{field message}}}`,
        variables: { input: [{ filename, mimeType, resource: "VIDEO", httpMethod: "POST", fileSize }] },
      }),
    });
    const stagedData = await stagedRes.json();
    if (stagedData?.errors?.length) throw new Error(stagedData.errors.map(e => e.message).join(", "));
    const ue = stagedData?.data?.stagedUploadsCreate?.userErrors;
    if (ue?.length) throw new Error("Staged init: " + ue.map(e => e.message).join(", "));
    const target = stagedData?.data?.stagedUploadsCreate?.stagedTargets?.[0];
    if (!target?.url) throw new Error("No staged URL returned");
    if (!videoBlob) {
      const videoRes = await fetch(cleanUrl);
      if (!videoRes.ok) throw new Error(`Fetching video failed: ${videoRes.status}`);
      videoBlob = await videoRes.blob();
    }
    const form = new FormData();
    for (const { name, value } of target.parameters) form.append(name, value);
    form.append("file", videoBlob, filename);
    const up = await fetch(target.url, { method: "POST", body: form });
    if (!up.ok) throw new Error(`Staging upload failed ${up.status}: ${(await up.text()).slice(0, 200)}`);
    const resourceUrl = target.resourceUrl || target.url;
    const mediaRes = await fetch(gqlUrl, {
      method: "POST", headers: gqlHeaders,
      body: JSON.stringify({
        query: `mutation productCreateMedia($productId:ID!,$media:[CreateMediaInput!]!){productCreateMedia(productId:$productId,media:$media){media{mediaContentType status}mediaUserErrors{field message}}}`,
        variables: { productId: `gid://shopify/Product/${productId}`, media: [{ mediaContentType: "VIDEO", originalSource: resourceUrl }] },
      }),
    });
    const md = await mediaRes.json();
    if (md?.errors?.length) throw new Error(md.errors.map(e => e.message).join(", "));
    const me = md?.data?.productCreateMedia?.mediaUserErrors;
    if (me?.length) throw new Error(me.map(e => e.message).join(", "));
    const media = md?.data?.productCreateMedia?.media?.[0] || null;
    return { ok: true, mediaId: media?.id || "", status: media?.status || "" };
  } catch (e) {
    console.error("Shopify listing video push failed:", e.message);
    return { ok: false, error: e.message };
  }
}

/* ── Shopify: take a media item off a product ──────────────────────────────
   Shopify won't swap a video in place, so replacing one means removing the old
   media and staging the new file. Only ever called for a video the ERP itself
   put there, and only when the source it was made from has changed. */
async function deleteShopifyMedia(store, token, productId, mediaId) {
  if (!mediaId) return { ok: false, skipped: true };
  try {
    const r = await fetch(`https://${store}/admin/api/2024-04/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({
        query: `mutation productDeleteMedia($productId:ID!,$mediaIds:[ID!]!){productDeleteMedia(productId:$productId,mediaIds:$mediaIds){deletedMediaIds mediaUserErrors{field message}}}`,
        variables: { productId: `gid://shopify/Product/${productId}`, mediaIds: [mediaId] },
      }),
    });
    const d = await r.json();
    const e = d?.data?.productDeleteMedia?.mediaUserErrors;
    if (d?.errors?.length) throw new Error(d.errors.map(x => x.message).join(", "));
    if (e?.length) throw new Error(e.map(x => x.message).join(", "));
    return { ok: true, deleted: d?.data?.productDeleteMedia?.deletedMediaIds || [] };
  } catch (err) {
    console.error("Shopify media delete failed:", err.message);
    return { ok: false, error: err.message };
  }
}

function normalizeShopifyVideoNode(node) {
  if (!node) return null;
  const sources = Array.isArray(node.sources) ? node.sources : [];
  const source = sources.find(s => s?.url && /mp4/i.test(s?.mimeType || s?.format || s?.url)) || sources.find(s => s?.url) || null;
  return {
    mediaId: node.id || "",
    videoStatus: node.status || "",
    videoUrl: source?.url || "",
    videoMimeType: source?.mimeType || "",
    videoPreviewUrl: node.preview?.image?.url || "",
  };
}

async function getShopifyVideoStatus(store, token, productId) {
  try {
    const r = await fetch(`https://${store}/admin/api/2024-04/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({
        query: `query productVideo($id:ID!){
          product(id:$id){
            media(first:25){
              nodes{
                id
                mediaContentType
                status
                preview{image{url}}
                ... on Video{
                  sources{url mimeType format width height}
                }
              }
            }
          }
        }`,
        variables: { id: `gid://shopify/Product/${productId}` },
      }),
    });
    const d = await r.json();
    if (d?.errors?.length) throw new Error(d.errors.map(e => e.message).join(", "));
    const node = (d?.data?.product?.media?.nodes || []).find(n => n.mediaContentType === "VIDEO");
    const video = normalizeShopifyVideoNode(node);
    return video || { videoStatus: "NONE", videoUrl: "" };
  } catch (e) {
    return { videoStatus: "UNKNOWN", videoUrl: "", videoErr: e.message || "Could not check Shopify video" };
  }
}

async function shopifyProductHasVideo(store, token, productId) {
  const video = await getShopifyVideoStatus(store, token, productId);
  // A FAILED media record must be retryable. Only an existing upload or an
  // actively processing/ready media item should block a new attempt.
  return !!video.mediaId && ["UPLOADED", "PROCESSING", "READY"].includes(String(video.videoStatus || "").toUpperCase());
}

async function publishShopify(store, token, listing, ai) {
  const { title, qty = 0, type = "repeatable", price_shopify, productType, material, images = [] } = listing;

  const shopTitle = ai?.shopify_title || title;
  const bodyHtml  = ai?.shopify_description || `<p>${listing.description || title}</p>`;
  const tags      = curatedTags(listing.tags, ai?.shopify_tags, 255).join(", ");
  const quantity  = type === "unique" ? 1 : Math.max(0, +qty || 0);
  const variantBundle = buildShopifyVariants(listing);

  // Create product — with real variants when the listing defines variations, else a single default.
  const r = await fetch(`https://${store}/admin/api/2024-04/products.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({
      product: {
        title: shopTitle,
        body_html: bodyHtml,
        product_type: productType || "Crystal",
        tags,
        status: "active",
        ...(variantBundle
          ? { options: variantBundle.options, variants: variantBundle.variants }
          : { variants: [{
              sku: listingSku(listing),
              inventory_management: "shopify",
              inventory_policy: "deny",
              inventory_quantity: quantity,
              price: String(price_shopify || 0),
            }] }),
      },
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Shopify create failed: ${JSON.stringify(data.errors || data)}`);

  const product = data.product;
  const imageSync = await syncShopifyImages(store, token, product.id, images);

  // Video (one per listing) — best-effort, never fails the publish.
  let videoQueued = false, videoErr = "";
  if (listing.video) {
    const v = await pushShopifyVideo(store, token, product.id, listing.video);
    videoQueued = v.ok; videoErr = v.error || "";
  }
  const video = listing.video ? await getShopifyVideoStatus(store, token, product.id) : {};

  // SEO
  try {
    const seoTitle = ai?.seo_title || shopTitle;
    const seoDesc  = ai?.seo_description || "";
    await fetch(`https://${store}/admin/api/2024-04/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({
        query: `mutation productUpdate($input:ProductInput!){productUpdate(input:$input){product{id}userErrors{field message}}}`,
        variables: { input: { id: `gid://shopify/Product/${product.id}`, seo: { title: seoTitle, description: seoDesc } } },
      }),
    });
  } catch {}

  return {
    product_id: product.id,
    url: `https://${store}/admin/products/${product.id}`,
    storefront_url: `https://${store.replace(".myshopify.com", "")}.com/products/${product.handle}`,
    status: "active",
    images_uploaded: imageSync.uploaded,
    videoQueued,
    videoErr,
    videoSrc: listing.video || "",
    ...video,
  };
}

/* ── Shopify: delete product ───────────────────────────────────────────────── */
async function unpublishShopify(store, token, productId) {
  const r = await fetch(`https://${store}/admin/api/2024-04/products/${productId}.json`, {
    method: "DELETE",
    headers: { "X-Shopify-Access-Token": token },
  });
  if (!r.ok && r.status !== 404) throw new Error(`Shopify delete failed: ${r.status}`);
  return { product_id: productId, status: "deleted" };
}

/* ── Main handler ──────────────────────────────────────────────────────────── */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  // store_sold is the retail store's webhook and checks its own secret below.
  const bodyAction = (() => { let b = req.body; if (typeof b === "string") { try { b = JSON.parse(b); } catch {} } return b?.action; })();
  const storeAction = req.method === "POST" && (bodyAction === "store_sold" || bodyAction === "etsy_active_ids");
  const user = storeAction ? null : await requireUser(req, res);
  if (!storeAction && !user) return;

  /* ── GET: fetch Etsy shop settings OR import all Etsy listings ── */
  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const action = url.searchParams.get("action");

    /* Photo relay for the in-app editor. Etsy's image CDN sends no CORS
       header, so the browser can't read those pixels itself (Safari just says
       "Load failed"). Only known photo hosts, so this can't be pointed at
       anything else. */
    if (action === "image") {
      let src;
      try { src = new URL(url.searchParams.get("url") || ""); } catch { return res.status(400).json({ error: "bad url" }); }
      const okHost = /(^|\.)(etsystatic\.com|shopify\.com|shopifycdn\.com|ebayimg\.com|supabase\.co|vercel-storage\.com)$/i;
      if (src.protocol !== "https:" || !okHost.test(src.hostname)) return res.status(400).json({ error: "host not allowed" });
      try {
        const pull = async u => {
          const r = await fetch(u);
          if (!r.ok) throw new Error(`upstream ${r.status}`);
          return { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get("content-type") || "image/jpeg" };
        };
        let img = await pull(src.href);
        /* A function reply tops out around 4.5 MB. Etsy keeps a 1588px copy of
           every photo; fall back to it for the rare original that's bigger. */
        if (img.buf.length > 4_300_000 && /il_fullxfull/.test(src.href)) img = await pull(src.href.replace("il_fullxfull", "il_1588xN"));
        if (!/^image\//.test(img.type)) return res.status(415).json({ error: "not an image" });
        res.setHeader("Content-Type", img.type);
        res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
        return res.status(200).send(img.buf);
      } catch (e) {
        return res.status(502).json({ error: e.message });
      }
    }

    /* One listing's state on Etsy now (active, draft, sold_out…), for a piece
       put live or taken down on Etsy itself since the ERP last looked. */
    if (action === "etsy_listing_state") {
      const id = String(url.searchParams.get("id") || "").replace(/\D/g, "");
      if (!id) return res.status(400).json({ ok: false, error: "id required" });
      try {
        const r = await fetch(`https://openapi.etsy.com/v3/application/listings/${id}`, { headers: await etsyHeaders(false) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return res.status(r.status === 404 ? 404 : 502).json({ ok: false, error: d?.error || `Etsy ${r.status}` });
        return res.json({ ok: true, state: d.state, url: d.url || `https://www.etsy.com/listing/${id}` });
      } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
    }

    /* Import all shop listings from Etsy → reconstruct listing objects */
    if (action === "import_etsy_listings") {
      try {
        const hdrs = await etsyHeaders(false);
        // Fetch active + draft listings (paginate up to 200)
        const allListings = [];
        for (const state of ["active", "draft"]) {
          let offset = 0;
          while (true) {
            const r = await fetch(
              `https://openapi.etsy.com/v3/application/shops/${ETSY_SHOP_ID}/listings?state=${state}&limit=100&offset=${offset}&includes=Images`,
              { headers: hdrs }
            );
            const d = await r.json();
            const results = d.results || [];
            allListings.push(...results.map(l => ({
              id: `etsy-import-${l.listing_id}`,
              title: l.title || "",
              description: l.description || "",
              material: (l.materials || [])[0] || "",
              tags: l.tags || [],
              etsy_section_id: l.shop_section_id || null,
              images: (l.images || []).map(img => img.url_fullxfull || img.url_570xN).filter(Boolean),
              price_etsy: l.price?.amount ? (l.price.amount / l.price.divisor) : 0,
              type: l.quantity === 1 ? "unique" : "repeatable",
              qty: l.quantity || 1,
              sku: (l.skus || [])[0] || "",
              platforms: {
                etsy: {
                  listing_id: l.listing_id,
                  url: `https://www.etsy.com/listing/${l.listing_id}`,
                  status: l.state === "active" ? "active" : "draft",
                },
              },
              // Etsy moves creation_timestamp to the renewal date every time a
              // listing renews; the original is when it was really first listed.
              created_at: new Date((l.original_creation_timestamp || l.creation_timestamp) * 1000).toISOString(),
              updated_at: new Date(l.last_modified_timestamp * 1000).toISOString(),
            })));
            if (results.length < 100) break;
            offset += 100;
          }
        }
        return res.json({ ok: true, listings: allListings });
      } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
      }
    }

    /* Lightweight: map every live Etsy listing_id → its state (active|draft|...),
       and when each was first listed (Etsy's original creation date, which a
       renewal doesn't move). Used to reconcile local listing badges and dates
       without re-importing full objects. */
    if (action === "sync_etsy_states") {
      try {
        const hdrs = await etsyHeaders(false);
        const states = {}, firstListed = {}, info = {};
        let renewed = 0;
        for (const state of ["active", "draft"]) {
          let offset = 0;
          while (true) {
            const r = await fetch(
              `https://openapi.etsy.com/v3/application/shops/${ETSY_SHOP_ID}/listings?state=${state}&limit=100&offset=${offset}`,
              { headers: hdrs }
            );
            const d = await r.json();
            const results = d.results || [];
            results.forEach(l => {
              states[l.listing_id] = l.state;
              // What an ERP listing can be matched on when it was put on Etsy by hand.
              info[l.listing_id] = { title: l.title || "", sku: (l.skus || [])[0] || "" };
              const first = l.original_creation_timestamp || l.creation_timestamp;
              if (first) firstListed[l.listing_id] = new Date(first * 1000).toISOString();
              if (l.original_creation_timestamp && l.creation_timestamp > l.original_creation_timestamp) renewed++;
            });
            if (results.length < 100) break;
            offset += 100;
          }
        }
        return res.json({ ok: true, states, firstListed, renewed, info });
      } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
      }
    }

    /* Import active products from a Shopify store → reconstruct listing objects */
    if (action === "import_shopify_listings") {
      const store_key = url.searchParams.get("store_key") || "earth";
      const storeEnvKey = store_key === "atyahara" ? "SHOPIFY_ATY_STORE"  : "SHOPIFY_EARTH_STORE";
      const tokenEnvKey = store_key === "atyahara" ? "SHOPIFY_ATY_TOKEN"  : "SHOPIFY_EARTH_TOKEN";
      const store = process.env[storeEnvKey] || process.env.SHOPIFY_STORE;
      const token = process.env[tokenEnvKey] || process.env.SHOPIFY_ACCESS_TOKEN;
      if (!store || !token) return res.status(400).json({
        error: `Shopify credentials not set. Add ${storeEnvKey} and ${tokenEnvKey} to Vercel env vars.`,
      });
      const platformKey = store_key === "atyahara" ? "shopify_aty" : "shopify_earth";
      const priceField  = store_key === "atyahara" ? "price_shopify_aty"  : "price_shopify_earth";
      try {
        const allListings = [];
        let nextUrl = `https://${store}/admin/api/2024-04/products.json?status=active&limit=250&fields=id,title,handle,body_html,product_type,tags,images,variants,status`;
        while (nextUrl) {
          const r = await fetch(nextUrl, { headers: { "X-Shopify-Access-Token": token } });
          const d = await r.json();
          if (!r.ok) throw new Error(d.errors ? JSON.stringify(d.errors) : "Shopify fetch failed");
          allListings.push(...(d.products || []).map(p => {
            const variant = p.variants?.[0] || {};
            const tags = (p.tags || "").split(",").map(t => t.trim()).filter(Boolean);
            return {
              id: `shopify-${store_key}-${p.id}`,
              title: p.title || "",
              description: p.body_html ? p.body_html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "",
              material: p.product_type || tags[0] || "",
              tags,
              images: (p.images || []).map(img => img.src).filter(Boolean),
              [priceField]: parseFloat(variant.price || 0),
              qty: parseInt(variant.inventory_quantity || 1, 10) || 1,
              type: parseInt(variant.inventory_quantity, 10) === 1 ? "unique" : "repeatable",
              sku: variant.sku || "",
              platforms: {
                [platformKey]: {
                  product_id: String(p.id),
                  url: `https://${store}/products/${p.handle}`,
                  status: "active",
                },
              },
            };
          }));
          // Follow cursor-based pagination via Link header
          const link = r.headers.get("link") || "";
          const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
          nextUrl = nextMatch ? nextMatch[1] : null;
        }
        return res.json({ ok: true, listings: allListings });
      } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
      }
    }

    if (action !== "get_etsy_settings")
      return res.status(400).json({ error: "Unknown GET action" });
    try {
      const hdrs = await etsyHeaders(false); // no Content-Type for GETs
      const [spResp, rpResp, readinessProfiles] = await Promise.all([
        fetch(`https://openapi.etsy.com/v3/application/shops/${ETSY_SHOP_ID}/shipping-profiles`, { headers: hdrs }),
        fetch(`https://openapi.etsy.com/v3/application/shops/${ETSY_SHOP_ID}/return-policies`, { headers: hdrs }),
        etsyReadinessStates(hdrs),
      ]);
      const [spData, rpData] = await Promise.all([spResp.json(), rpResp.json()]);
      const shippingProfiles = (spData.results || []).map(p => ({
        id: p.shipping_profile_id,
        label: p.title,
      }));
      const returnPolicies = (rpData.results || []).map(p => ({
        id: p.return_policy_id,
        label: p.accepts_returns
          ? `Returns accepted (${p.return_deadline || "?"} days)`
          : "No returns",
      }));
      return res.json({ shippingProfiles, returnPolicies, readinessProfiles });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }

  const { action, listing, platform, store_key } = body;

  /* ── STORE ORDER (called by eartheditions.co's Stripe webhook) ────────────
     Files the paid order under Orders — one row per piece, as Mark sold does.
     Taking one-of-a-kind pieces down from Etsy/eBay is approved by hand from
     that order. Stock counts are left alone on purpose; adjusted by hand. Only the store can
     call this: it must present the shared secret. */
  /* The store's daily check: which Etsy listings are still live. A piece that
     sold (or was taken down) on Etsy must not stay for sale on the store. */
  if (action === "etsy_active_ids") {
    const secret = process.env.STORE_SYNC_SECRET;
    if (!secret || req.headers["x-store-secret"] !== secret) return res.status(401).json({ error: "Unauthorized" });
    const hdrs = await etsyHeaders(false);
    const ids = [];
    for (let offset = 0; ; offset += 100) {
      const r = await fetch(`https://openapi.etsy.com/v3/application/shops/${ETSY_SHOP_ID}/listings?state=active&limit=100&offset=${offset}`, { headers: hdrs });
      const d = await r.json();
      if (!r.ok) return res.status(502).json({ error: d?.error || `Etsy ${r.status}` });
      ids.push(...(d.results || []).map(l => String(l.listing_id)));
      if ((d.results || []).length < 100) break;
    }
    return res.json({ ok: true, ids });
  }

  if (action === "store_sold") {
    const secret = process.env.STORE_SYNC_SECRET;
    if (!secret || req.headers["x-store-secret"] !== secret) return res.status(401).json({ error: "Unauthorized" });
    const order = body.order || {};
    const sb = createClient(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const readKey = async k => {
      const { data } = await sb.from("app_data").select("value").eq("key", k).maybeSingle();
      const v = typeof data?.value === "string" ? JSON.parse(data.value) : data?.value;
      return Array.isArray(v) ? v : [];
    };
    const upsert = (k, item, prepend = true) => sb.rpc("app_data_upsert_item", { p_key: k, p_item: item, p_prepend: prepend });
    const [orders, listings] = await Promise.all([readKey("ng-orders-v1"), readKey("ng-listings-v1")]);
    let n = orders.reduce((m, o) => Math.max(m, parseInt(String(o.order_number || "").replace(/\D/g, ""), 10) || 0), 0);
    const addr = order.shipping || {};
    const results = [];
    for (const [i, line] of (order.lines || []).entries()) {
      const L = listings.find(x => x.id === line.listing_id);
      const id = `store-${order.number}-${i + 1}`;
      if (!orders.some(o => o.id === id)) {
        n += 1;
        await upsert("ng-orders-v1", {
          id, order_number: `ORD-${String(n).padStart(4, "0")}`,
          listing_id: line.listing_id || "", listing_title: line.title || L?.title || "",
          listing_material: L?.material || "", listing_shape: L?.shape || "", listing_sku: line.sku || L?.sku || "",
          listing_order_id: L?.listing_order_id || "", listing_image: line.image || L?.images?.[0] || "",
          platform: "store", platform_order_id: order.number, sale_price: String((line.price || 0) * (line.qty || 1)),
          currency: "USD", qty: line.qty || 1, buyer_name: order.name || "", buyer_email: order.email || "",
          buyer_country: addr.country || "", ship_to: addr, status: "sold",
          date: String(order.created_at || new Date().toISOString()).slice(0, 10),
          notes: order.notes || "", created_at: new Date().toISOString(),
        });
      }
      // Taking the piece down elsewhere is approved by hand from the order in
      // Listing Manager → Orders; here only the store's own status is recorded.
      if (line.unique && L) {
        await upsert("ng-listings-v1", { ...L, platforms: { ...(L.platforms || {}), store: { ...(L.platforms?.store || {}), status: "sold" } }, updated_at: new Date().toISOString() }, false);
        results.push({ listing: L.id });
      }
    }
    return res.json({ ok: true, results });
  }

  try {

    /* ── Price research: pieces like this one, for the admin only ────────── */
    if (action === "price_research") {
      if (!(await isAdminUser(user))) return res.status(403).json({ error: "Price research is for the admin only." });
      if (!listing) return res.status(400).json({ error: "listing required" });
      const items = body.mode === "web" ? await researchWeb(listing) : await researchEtsy(listing);
      return res.json({ ok: true, mode: body.mode === "web" ? "web" : "etsy", items, at: new Date().toISOString() });
    }

    /* ── AI: generate platform-specific content ──────────────────────────── */
    if (action === "ai_generate") {
      if (!listing) return res.status(400).json({ error: "listing required" });
      const ai = await aiGenerate(listing);
      return res.json({ ok: true, ai });
    }

    /* ── PUBLISH TO ETSY ─────────────────────────────────────────────────── */
    if (action === "publish_etsy") {
      const etsyToken = await getEtsyAccessToken();
      if (!etsyToken) return res.status(400).json({ error: "Etsy token not available — please re-authenticate" });
      if (!listing.price_etsy) return res.status(400).json({ error: "price_etsy required" });
      const ai = listing._ai || null;
      // sync_only=true → just update fields, never activate (used on every save)
      // sync_only=false (default) → explicit publish, activate the listing
      const syncOnly = req.body?.sync_only === true;
      const allowCreate = req.body?.allow_create === true;
      // Resync photos: re-send the set even when the listing thinks it already did.
      const forcePhotos = req.body?.force_photos === true;

      let result;
      if (listing.platforms?.etsy?.listing_id) {
        const id = listing.platforms.etsy.listing_id;
        result = await updateEtsyListing(id, listing, ai, { forcePhotos });
        /* An explicit publish means "put it on sale", and that was only ever
           done on the way to creating a listing. An existing draft had its
           fields updated and stayed a draft, while the ERP reported success and
           offered the button again. Activation is attempted even when the field
           update failed: the draft is there, and going live is what was asked. */
        if (!syncOnly) {
          const act = await activateEtsyListing(id);
          result = act.ok
            ? { ...result, status: "active" }
            : { ...result, status: result?.status || "draft", activateError: act.error };
        }
      } else {
        if (syncOnly && !allowCreate) {
          return res.status(409).json({ ok: false, error: "Skipped Etsy sync: no existing Etsy listing_id" });
        }
        // New listing: create as draft always; only activate if user explicitly published
        result = await publishEtsy(listing, ai, { activate: !syncOnly });
      }
      /* Etsy refusing to put it on sale is not a successful publish. Saying so
         is the difference between a button that can be pressed again and a
         seller who believes the piece is live. */
      if (result?.activateError) {
        return res.status(502).json({ ok: false, platform: "etsy", result,
          error: `Etsy kept it as a draft: ${result.activateError}` });
      }
      return res.json({ ok: true, platform: "etsy", result });
    }

    /* ── UNPUBLISH FROM ETSY ─────────────────────────────────────────────── */
    if (action === "unpublish_etsy") {
      const listingId = listing?.platforms?.etsy?.listing_id;
      if (!listingId) return res.status(400).json({ error: "No Etsy listing_id on this listing" });
      const result = await unpublishEtsy(listingId);
      return res.json({ ok: true, platform: "etsy", result });
    }

    /* ── PUBLISH TO SHOPIFY ──────────────────────────────────────────────── */
    if (action === "publish_shopify") {
      // store_key: "earth" or "atyahara"
      const storeEnvKey   = store_key === "atyahara" ? "SHOPIFY_ATY_STORE"   : "SHOPIFY_EARTH_STORE";
      const tokenEnvKey   = store_key === "atyahara" ? "SHOPIFY_ATY_TOKEN"   : "SHOPIFY_EARTH_TOKEN";
      const store  = listing.shopify_store  || process.env[storeEnvKey]  || process.env.SHOPIFY_STORE;
      const token  = listing.shopify_token  || process.env[tokenEnvKey]  || process.env.SHOPIFY_ACCESS_TOKEN;

      if (!store || !token) return res.status(400).json({
        error: `Shopify credentials not set for store "${store_key}". Add ${storeEnvKey} and ${tokenEnvKey} to env vars.`,
        missing: [!store && storeEnvKey, !token && tokenEnvKey].filter(Boolean),
      });

      const ai = listing._ai || null;
      const platformKey = store_key === "atyahara" ? "shopify_aty" : "shopify_earth";
      const existingId = listing.platforms?.[platformKey]?.product_id;
      const syncOnly = req.body?.sync_only === true;
      const allowCreate = req.body?.allow_create === true;

      let result;
      if (existingId) {
        // Update existing
        const priceField = store_key === "atyahara" ? "price_shopify_aty" : "price_shopify_earth";
        const resolvedPrice = listing[priceField] || listing.price_shopify || 0;
        // Rebuild the variant grid when variations are defined; Shopify replaces the product's
        // options + variants wholesale on PUT. Otherwise just reprice the single default variant.
        const variantBundle = buildShopifyVariants({ ...listing, price_shopify: resolvedPrice });
        const patchBody = {
          product: {
            id: existingId,
            title: ai?.shopify_title || listing.title,
            body_html: ai?.shopify_description || listing.description || "",
            tags: curatedTags(listing.tags, ai?.shopify_tags, 255).join(", "),
            ...(variantBundle
              ? { options: variantBundle.options, variants: variantBundle.variants }
              : { variants: [{ price: String(resolvedPrice) }] }),
          },
        };
        const r = await fetch(`https://${store}/admin/api/2024-04/products/${existingId}.json`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
          body: JSON.stringify(patchBody),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(`Shopify update: ${JSON.stringify(d.errors || d)}`);
        const imageSync = await syncShopifyImages(store, token, existingId, listing.images || []);
        /* Video. A product carries one, so a plain re-sync must not add a second
           — but an edited clip has to actually reach the store, or the seller's
           tweak lives only in the ERP. The listing remembers which file it last
           pushed here (videoSrc); when that differs from the video it now holds,
           the old media comes off and the new one goes up. Unchanged, nothing
           happens and the sync stays cheap. */
        let videoQueued = false, videoErr = "", videoReplaced = false, video = {};
        if (listing.video && typeof listing.video === "string" && listing.video.startsWith("http")) {
          const pushedSrc = listing.platforms?.[platformKey]?.videoSrc || "";
          const live = await getShopifyVideoStatus(store, token, existingId);
          const holds = !!live.mediaId && ["UPLOADED", "PROCESSING", "READY"].includes(String(live.videoStatus || "").toUpperCase());
          /* Listings published before the ERP started recording what it sent
             have no videoSrc. Those are left alone unless the clip was actually
             edited here — an edit is the one case where the store is known to
             be holding the wrong cut. */
          const changed = pushedSrc ? pushedSrc !== listing.video : !!listing.videoEdit?.at;
          if (holds && changed) {
            const del = await deleteShopifyMedia(store, token, existingId, live.mediaId);
            videoReplaced = del.ok;
            if (!del.ok) videoErr = del.error || "Could not remove the old video";
          }
          if (!holds || (changed && videoReplaced)) {
            const v = await pushShopifyVideo(store, token, existingId, listing.video);
            videoQueued = v.ok; videoErr = v.error || videoErr;
          }
          video = await getShopifyVideoStatus(store, token, existingId);
        }
        result = { product_id: existingId, status: "active", images_uploaded: imageSync.uploaded,
          videoQueued, videoErr, videoReplaced, videoSrc: listing.video || "", ...video };
      } else {
        if (syncOnly && !allowCreate) {
          return res.status(409).json({ ok: false, error: `Skipped ${platformKey} sync: no existing product_id` });
        }
        const priceField = store_key === "atyahara" ? "price_shopify_aty" : "price_shopify_earth";
        result = await publishShopify(store, token, { ...listing, price_shopify: listing[priceField] || listing.price_shopify }, ai);
      }
      result = await cleanupReadyVideo(listing, result, platformKey);
      return res.json({ ok: true, platform: store_key, result });
    }

    /* ── CHECK SHOPIFY VIDEO STATUS ──────────────────────────────────────── */
    if (action === "check_shopify_video") {
      const storeEnvKey = store_key === "atyahara" ? "SHOPIFY_ATY_STORE" : "SHOPIFY_EARTH_STORE";
      const tokenEnvKey = store_key === "atyahara" ? "SHOPIFY_ATY_TOKEN" : "SHOPIFY_EARTH_TOKEN";
      const store = listing?.shopify_store || process.env[storeEnvKey] || process.env.SHOPIFY_STORE;
      const token = listing?.shopify_token || process.env[tokenEnvKey] || process.env.SHOPIFY_ACCESS_TOKEN;
      const platformKey = store_key === "atyahara" ? "shopify_aty" : "shopify_earth";
      const productId = listing?.platforms?.[platformKey]?.product_id || listing?.product_id;
      if (!store || !token) return res.status(400).json({ error: `Shopify credentials not set for store "${store_key}".` });
      if (!productId) return res.status(400).json({ error: `No ${platformKey} product_id` });
      // One deletion path only — cleanupReadyVideo enforces the READY check, the
      // opt-in policy flag, and the grace window before anything is removed.
      const status = await getShopifyVideoStatus(store, token, productId);
      const result = await cleanupReadyVideo(listing, status, platformKey);
      return res.json({ ok: true, platform: store_key, result: { product_id: productId, ...result } });
    }

    /* ── UNPUBLISH FROM SHOPIFY ──────────────────────────────────────────── */
    if (action === "unpublish_shopify") {
      const storeEnvKey = store_key === "atyahara" ? "SHOPIFY_ATY_STORE" : "SHOPIFY_EARTH_STORE";
      const tokenEnvKey = store_key === "atyahara" ? "SHOPIFY_ATY_TOKEN" : "SHOPIFY_EARTH_TOKEN";
      const store = listing?.shopify_store || process.env[storeEnvKey] || process.env.SHOPIFY_STORE;
      const token = listing?.shopify_token || process.env[tokenEnvKey] || process.env.SHOPIFY_ACCESS_TOKEN;
      const platformKey = store_key === "atyahara" ? "shopify_aty" : "shopify_earth";
      const productId = listing?.platforms?.[platformKey]?.product_id;
      if (!productId) return res.status(400).json({ error: `No ${platformKey} product_id` });
      const result = await unpublishShopify(store, token, productId);
      return res.json({ ok: true, platform: store_key, result });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
