/**
 * Listing Manager API — cross-platform publishing hub
 * Supports: Etsy, Shopify (Earth Editions), Shopify (Atyahara), eBay (future)
 *
 * Actions: ai_generate, publish_etsy, unpublish_etsy,
 *          publish_shopify, unpublish_shopify
 */

import { getEtsyAccessToken } from "../lib/etsy-auth.js";
import { createClient } from "@supabase/supabase-js";

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
  const unit = /^k/.test(u) ? "kg" : /^o/.test(u) ? "oz" : /^(lb|pound)/.test(u) ? "lb" : "g";
  return { value: +(+m[1]).toFixed(2), unit: WEIGHT_UNITS[unit] };
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

async function applyEtsyDimensions(listingId, taxonomyId, dims, hdrs) {
  if (!dims || (!dims.width && !dims.height && !dims.depth)) return [];
  const props = await etsyTaxonomyProperties(taxonomyId, hdrs);
  if (!props.length) return [];

  const warnings = [];
  const wanted = [["Width", dims.width], ["Height", dims.height], ["Depth", dims.depth]];

  for (const [name, value] of wanted) {
    if (!value) continue;
    const prop = props.find(p => String(p.display_name).toLowerCase() === name.toLowerCase());
    if (!prop) continue;

    // Prefer the scale matching the seller's unit; otherwise convert into one
    // the category does offer (cm for the metric-less "Inches/Centimeters" set).
    const from = DIM_UNITS[dims.unit] || DIM_UNITS.mm;
    let scale = (prop.scales || []).find(s => s.display_name === from.scale);
    let out = value;
    if (!scale) {
      for (const key of ["cm", "in", "mm", "m"]) {
        const cand = (prop.scales || []).find(s => s.display_name === DIM_UNITS[key].scale);
        if (cand) { scale = cand; out = +(value * from.toMm / DIM_UNITS[key].toMm).toFixed(2); break; }
      }
    }
    if (!scale) continue;

    const body = { values: [String(out)], value_ids: [], scale_id: scale.scale_id };
    let r = await fetch(
      `https://openapi.etsy.com/v3/application/shops/${ETSY_SHOP_ID}/listings/${listingId}/properties/${prop.property_id}`,
      { method: "PUT", headers: hdrs, body: JSON.stringify(body) }
    );
    if (!r.ok) {
      // Same JSON-vs-form split the tag update already works around.
      const form = new URLSearchParams();
      form.set("values", String(out));
      form.set("scale_id", String(scale.scale_id));
      const { "Content-Type": _drop, ...bare } = hdrs;
      r = await fetch(
        `https://openapi.etsy.com/v3/application/shops/${ETSY_SHOP_ID}/listings/${listingId}/properties/${prop.property_id}`,
        { method: "PUT", headers: { ...bare, "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() }
      );
    }
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      console.error(`Etsy ${name} property failed:`, r.status, JSON.stringify(d));
      warnings.push(name);
    }
  }
  return warnings;
}

/* ── Claude AI helper ──────────────────────────────────────────────────────── */
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
  "suggested_section": "one of: Spheres, Hearts, Palmstones, Bracelets, Towers & Freeforms, Pendants & Pendulums, Tumbled Stones, Mineral Specimens, Rough Stones, Gemstone Bowls and More, Collector's Corner, Wellness"
}`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 1200,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await r.json();
  const text = data.content?.[0]?.text || "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("AI returned invalid JSON");
  return JSON.parse(match[0]);
}

/* ── Etsy: processing profile ("readiness state") ─────────────────────────────
   Publishing used to borrow whichever readiness_state_id the shop's most recent
   active listing happened to carry, so a ready-to-ship geode went out as "Made
   to order". The shop's own profiles are read instead: ready-to-ship, shortest
   turnaround, unless the listing is ticked made-to-order.

   Etsy hasn't settled the field names on this one, so each row is read
   tolerantly and the whole feature degrades to "send nothing" rather than
   sending the wrong profile. */
function readinessInfo(row = {}) {
  const id  = row.readiness_state_id ?? row.id ?? null;
  const min = +(row.min_processing_time ?? row.processing_time_min ?? row.min ?? 0) || 0;
  const max = +(row.max_processing_time ?? row.processing_time_max ?? row.max ?? min) || min;
  const unit = String(row.processing_time_unit ?? row.unit ?? "days").replace(/s$/, "") + "s";
  const madeToOrder = row.is_made_to_order ?? row.made_to_order
    ?? (row.type ? /made.?to.?order/i.test(String(row.type)) : undefined)
    ?? !(row.is_ready_to_ship ?? true);
  const days = max && max !== min ? `${min}-${max} ${unit}` : `${min || 1} ${unit}`;
  return { id, min, max, madeToOrder: !!madeToOrder, label: `${madeToOrder ? "Made to order" : "Ready to ship"} · ${days}` };
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
    return ((await r.json())?.results || []).map(row => ({ ...readinessInfo(row), raw: row })).filter(x => x.id);
  } catch { return []; }
}

/* The listing's own pick wins; otherwise the fastest profile of the right kind. */
async function pickReadinessState(listing, hdrs) {
  if (listing.etsy_readiness_state_id) return +listing.etsy_readiness_state_id;
  const wantMadeToOrder = !!listing.etsy_made_to_order;
  const all = await etsyReadinessStates(hdrs);
  const pool = all.filter(x => x.madeToOrder === wantMadeToOrder);
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
async function uploadEtsyImage(listingId, imgUrl, rank, altText, authHdrs) {
  try {
    const imgResp = await fetch(imgUrl);
    if (!imgResp.ok) return;
    const buf  = await imgResp.arrayBuffer();
    const ext  = (imgUrl.split("?")[0].split(".").pop() || "jpg").toLowerCase().replace("jpeg", "jpg");
    const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    const form = new FormData();
    form.append("image", new Blob([buf], { type: mime }), `photo-${rank}.${ext}`);
    form.append("rank", String(rank));
    form.append("overwrite", "false");
    form.append("alt_text", (altText || "").slice(0, 250));
    // Don't pass Content-Type — let FormData set boundary automatically
    const { "Content-Type": _ct, ...bare } = authHdrs;
    const r = await fetch(
      `https://openapi.etsy.com/v3/application/shops/${ETSY_SHOP_ID}/listings/${listingId}/images`,
      { method: "POST", headers: bare, body: form }
    );
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      console.error("Etsy image upload error:", JSON.stringify(d));
    }
  } catch (e) { console.error("Etsy image upload failed:", e.message); }
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

/* ── Etsy: publish listing ─────────────────────────────────────────────────── */
async function publishEtsy(listing, ai, { activate = true } = {}) {
  const {
    title, material, shape, productType, qty = 1, type = "repeatable",
    price_etsy, price_etsy_usd, images = [],
  } = listing;

  const etsyTitle = ai?.etsy_title || title;
  const etsyDesc  = ai?.etsy_description || listing.description || title;
  const etsyTags  = curatedTags(listing.tags, ai?.etsy_tags).slice(0, 13);

  const sectionId      = listing.etsy_section_id   || ETSY_SECTIONS[shape] || ETSY_SECTIONS[productType] || null;
  const taxonomyId     = listing.etsy_taxonomy_id  || ETSY_TAXONOMY[productType] || ETSY_TAXONOMY.default;
  const shippingId     = listing.etsy_shipping_profile_id || etsyShippingProfile(price_etsy_usd || (price_etsy / 84));
  const returnPolicyId = listing.etsy_return_policy_id    || ETSY_RETURN_POLICY;
  const quantity       = type === "unique" ? 1 : Math.max(1, +qty || 1);

  const dims   = listingDimensions(listing);
  const weight = parseWeight(listing.weight);

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
    ...(dims.width  ? { item_width:  dims.width  } : {}),
    ...(dims.height ? { item_height: dims.height } : {}),
    ...(dims.depth  ? { item_length: dims.depth  } : {}),
    ...(dims.width || dims.height || dims.depth
      ? { item_dimensions_unit: (DIM_UNITS[dims.unit] || DIM_UNITS.mm).api } : {}),
    ...(weight ? { item_weight: weight.value, item_weight_unit: weight.unit } : {}),
    should_auto_renew: listing.etsy_auto_renew ?? false,
    ...(listing.etsy_ads ? { is_on_etsy_ads: true } : {}),
    ...(sectionId ? { shop_section_id: sectionId } : {}),
    ...(listingSku(listing) ? { skus: [listingSku(listing)] } : {}),
  };

  const hdrs = await etsyHeaders();

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
    await uploadEtsyImage(listingId, imgUrls[i], i + 1, etsyTitle, hdrs);
    if (i < imgUrls.length - 1) await new Promise(r => setTimeout(r, 400));
  }

  // Optional listing video (one per listing)
  let videoSrc = "";
  if (listing.video && typeof listing.video === "string" && listing.video.startsWith("http")) {
    if (await uploadEtsyVideo(listingId, listing.video, hdrs, etsyTitle)) videoSrc = listing.video;
  }

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
  const dimFailed   = await applyEtsyDimensions(listingId, taxonomyId, dims, hdrs);

  const gaps = [];
  if (!etsyTags.length) gaps.push("no tags");
  if (!payload.materials.length) gaps.push("no materials");
  if (!dims.width && !dims.height && !dims.depth) gaps.push("no dimensions");
  if (!weight) gaps.push("no weight");
  if (dimFailed.length) gaps.push(`Etsy rejected ${dimFailed.join("/")}`);

  return {
    listing_id: listingId, url: `https://www.etsy.com/listing/${listingId}`, status: finalStatus,
    tags_applied: etsyTags.length, videoSrc, ...(tagsWarning ? { tagsWarning } : {}),
    ...(gaps.length ? { fieldsWarning: `Published with ${gaps.join(", ")} — fill these in on the listing form and re-sync.` } : {}),
  };
}

/* ── Etsy: update listing ──────────────────────────────────────────────────── */
async function updateEtsyListing(listingId, listing, ai) {
  const etsyTitle = ai?.etsy_title || listing.title;
  const etsyDesc  = ai?.etsy_description || listing.description || listing.title;
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
    price:       parseFloat((+listing.price_etsy || 0).toFixed(2)),
    quantity,
    tags:        etsyTags,
    taxonomy_id: taxonomyId,
    ...(readinessId ? { readiness_state_id: readinessId } : {}),
    ...(listing.material ? { materials: [listing.material] } : {}),
    should_auto_renew: listing.etsy_auto_renew ?? false,
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
      // Return existing data so the listing_id is preserved in the app
      return { listing_id: listingId, status: existingStatus, sync_skipped: true };
    }
    r = fallback;
  }

  const data = await r.json();
  if (!r.ok) {
    const msg = data.error_description || data.error || data.message || JSON.stringify(data);
    console.warn(`Etsy update failed for ${listingId}: ${msg} — keeping existing listing_id`);
    return { listing_id: listingId, status: existingStatus, sync_skipped: true };
  }

  // Re-upload images
  const imgUrls = (listing.images || []).filter(u => typeof u === "string" && u.startsWith("http")).slice(0, 10);
  for (let i = 0; i < imgUrls.length; i++) {
    await uploadEtsyImage(listingId, imgUrls[i], i + 1, etsyTitle, hdrs);
    if (i < imgUrls.length - 1) await new Promise(r => setTimeout(r, 400));
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

  const tagsWarning = await verifyEtsyTags(listingId, etsyTags, hdrs);
  const dimFailed   = await applyEtsyDimensions(listingId, taxonomyId, dims, hdrs);

  const gaps = [];
  if (!etsyTags.length) gaps.push("no tags");
  if (!listing.material) gaps.push("no materials");
  if (!dims.width && !dims.height && !dims.depth) gaps.push("no dimensions");
  if (!weight) gaps.push("no weight");
  if (dimFailed.length) gaps.push(`Etsy rejected ${dimFailed.join("/")}`);

  return { listing_id: listingId, status: existingStatus, tags_applied: etsyTags.length, videoSrc,
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

  /* ── GET: fetch Etsy shop settings OR import all Etsy listings ── */
  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const action = url.searchParams.get("action");

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
              created_at: new Date(l.creation_timestamp * 1000).toISOString(),
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

    /* Lightweight: map every live Etsy listing_id → its state (active|draft|...).
       Used to reconcile local listing badges without re-importing full objects. */
    if (action === "sync_etsy_states") {
      try {
        const hdrs = await etsyHeaders(false);
        const states = {};
        for (const state of ["active", "draft"]) {
          let offset = 0;
          while (true) {
            const r = await fetch(
              `https://openapi.etsy.com/v3/application/shops/${ETSY_SHOP_ID}/listings?state=${state}&limit=100&offset=${offset}`,
              { headers: hdrs }
            );
            const d = await r.json();
            const results = d.results || [];
            results.forEach(l => { states[l.listing_id] = l.state; });
            if (results.length < 100) break;
            offset += 100;
          }
        }
        return res.json({ ok: true, states });
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

  try {

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

      let result;
      if (listing.platforms?.etsy?.listing_id) {
        result = await updateEtsyListing(listing.platforms.etsy.listing_id, listing, ai);
      } else {
        if (syncOnly && !allowCreate) {
          return res.status(409).json({ ok: false, error: "Skipped Etsy sync: no existing Etsy listing_id" });
        }
        // New listing: create as draft always; only activate if user explicitly published
        result = await publishEtsy(listing, ai, { activate: !syncOnly });
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
