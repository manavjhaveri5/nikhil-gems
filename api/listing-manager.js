/**
 * Listing Manager API — cross-platform publishing hub
 * Supports: Etsy, Shopify (Earth Editions), Shopify (Atyahara), eBay (future)
 *
 * Actions: ai_generate, publish_etsy, unpublish_etsy,
 *          publish_shopify, unpublish_shopify
 */

import { getEtsyAccessToken } from "./etsy-auth.js";

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

// Etsy taxonomy IDs for crystal/mineral products
const ETSY_TAXONOMY = {
  "Jewellery": 1994,    // Jewelry
  "Healing/Reiki": 1003, // Crystals & Healing Stones
  "Lapidary": 1003,
  "Carvings": 1003,
  "Decor": 903,          // Home Decor
  "Mineral": 1003,
  "Rough": 1003,
  "default": 1003,
};

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

/* ── Etsy: publish listing ─────────────────────────────────────────────────── */
async function publishEtsy(listing, ai, { activate = true } = {}) {
  const {
    title, material, shape, productType, qty = 1, type = "repeatable",
    price_etsy, price_etsy_usd, images = [],
  } = listing;

  const etsyTitle = ai?.etsy_title || title;
  const etsyDesc  = ai?.etsy_description || listing.description || title;
  const etsyTags  = (ai?.etsy_tags || listing.tags || []).slice(0, 13);

  const sectionId      = listing.etsy_section_id   || ETSY_SECTIONS[shape] || ETSY_SECTIONS[productType] || null;
  const taxonomyId     = listing.etsy_taxonomy_id  || ETSY_TAXONOMY[productType] || ETSY_TAXONOMY.default;
  const shippingId     = listing.etsy_shipping_profile_id || etsyShippingProfile(price_etsy_usd || (price_etsy / 84));
  const returnPolicyId = listing.etsy_return_policy_id    || ETSY_RETURN_POLICY;
  const quantity       = type === "unique" ? 1 : Math.max(1, +qty || 1);

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
    should_auto_renew: listing.etsy_auto_renew ?? false,
    ...(listing.etsy_ads ? { is_on_etsy_ads: true } : {}),
    ...(sectionId ? { shop_section_id: sectionId } : {}),
    ...(listing.sku ? { skus: [listing.sku] } : {}),
  };

  const hdrs = await etsyHeaders();

  // Borrow readiness_state_id from an existing listing (it's shop-specific)
  try {
    const sample = await fetch(
      `https://openapi.etsy.com/v3/application/shops/${ETSY_SHOP_ID}/listings?state=active&limit=1`,
      { headers: hdrs }
    );
    const sd = await sample.json();
    const rid = sd.results?.[0]?.readiness_state_id;
    if (rid) payload.readiness_state_id = rid;
  } catch {}

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
  if (listing.video && typeof listing.video === "string" && listing.video.startsWith("http")) {
    await uploadEtsyVideo(listingId, listing.video, hdrs, etsyTitle);
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

  return { listing_id: listingId, url: `https://www.etsy.com/listing/${listingId}`, status: finalStatus };
}

/* ── Etsy: update listing ──────────────────────────────────────────────────── */
async function updateEtsyListing(listingId, listing, ai) {
  const etsyTitle = ai?.etsy_title || listing.title;
  const etsyDesc  = ai?.etsy_description || listing.description || listing.title;
  const etsyTags  = (ai?.etsy_tags || listing.tags || []).slice(0, 13);
  const quantity  = listing.type === "unique" ? 1 : Math.max(1, +listing.qty || 1);

  const hdrs = await etsyHeaders();
  const patchBody = {
    title:       etsyTitle.slice(0, 140),
    description: etsyDesc,
    price:       parseFloat((+listing.price_etsy || 0).toFixed(2)),
    quantity,
    tags:        etsyTags,
    should_auto_renew: listing.etsy_auto_renew ?? false,
    ...(listing.sku ? { skus: [listing.sku] } : {}),
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

  // Optional listing video — best-effort (Etsy ignores/replaces if one already exists)
  if (listing.video && typeof listing.video === "string" && listing.video.startsWith("http")) {
    await uploadEtsyVideo(listingId, listing.video, hdrs, etsyTitle);
  }

  return { listing_id: listingId, status: existingStatus };
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
async function publishShopify(store, token, listing, ai) {
  const { title, qty = 0, type = "repeatable", price_shopify, sku, productType, material, images = [] } = listing;

  const shopTitle = ai?.shopify_title || title;
  const bodyHtml  = ai?.shopify_description || `<p>${listing.description || title}</p>`;
  const tags      = ai?.shopify_tags || listing.tags?.join(", ") || "";
  const quantity  = type === "unique" ? 1 : Math.max(0, +qty || 0);

  // Create product
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
        variants: [{
          sku: sku || "",
          inventory_management: "shopify",
          inventory_policy: "deny",
          inventory_quantity: quantity,
          price: String(price_shopify || 0),
        }],
        ...(images.length > 0 ? { images: images.slice(0, 10).map(url => ({ src: url })) } : {}),
      },
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Shopify create failed: ${JSON.stringify(data.errors || data)}`);

  const product = data.product;

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
      const [spResp, rpResp] = await Promise.all([
        fetch(`https://openapi.etsy.com/v3/application/shops/${ETSY_SHOP_ID}/shipping-profiles`, { headers: hdrs }),
        fetch(`https://openapi.etsy.com/v3/application/shops/${ETSY_SHOP_ID}/return-policies`, { headers: hdrs }),
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
      return res.json({ shippingProfiles, returnPolicies });
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

      let result;
      if (listing.platforms?.etsy?.listing_id) {
        result = await updateEtsyListing(listing.platforms.etsy.listing_id, listing, ai);
      } else {
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

      let result;
      if (existingId) {
        // Update existing
        const priceField = store_key === "atyahara" ? "price_shopify_aty" : "price_shopify_earth";
        const patchBody = {
          product: {
            id: existingId,
            title: ai?.shopify_title || listing.title,
            body_html: ai?.shopify_description || listing.description || "",
            tags: ai?.shopify_tags || listing.tags?.join(", ") || "",
            variants: [{ price: String(listing[priceField] || listing.price_shopify || 0) }],
          },
        };
        const r = await fetch(`https://${store}/admin/api/2024-04/products/${existingId}.json`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
          body: JSON.stringify(patchBody),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(`Shopify update: ${JSON.stringify(d.errors || d)}`);
        result = { product_id: existingId, status: "active" };
      } else {
        const priceField = store_key === "atyahara" ? "price_shopify_aty" : "price_shopify_earth";
        result = await publishShopify(store, token, { ...listing, price_shopify: listing[priceField] || listing.price_shopify }, ai);
      }
      return res.json({ ok: true, platform: store_key, result });
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
