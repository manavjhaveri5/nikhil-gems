import { getEtsyAccessToken } from "./etsy-auth.js";

export const maxDuration = 45; // Vercel Pro: allow up to 45s for multi-page listing fetches

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Etsy-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // x-api-key must be keystring:sharedsecret for Etsy API v3
  const key = process.env.ETSY_API_KEY ||
    (process.env.ETSY_KEYSTRING && process.env.ETSY_SHARED_SECRET
      ? `${process.env.ETSY_KEYSTRING}:${process.env.ETSY_SHARED_SECRET}`
      : process.env.ETSY_KEYSTRING);

  // Bearer token: prefer client-provided (frontend manages refresh lifecycle),
  // fall back to server env var for backwards compat.
  const clientToken = req.headers["x-etsy-token"] ||
    (req.headers["authorization"]?.startsWith("Bearer ") ? req.headers["authorization"].slice(7) : null);
  const token = clientToken || await getEtsyAccessToken();

  const defaultShopId = process.env.ETSY_SHOP_ID;

  const readJsonish = async response => {
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { text, data };
  };

  const etsyMessage = data => data?.error || data?.message || data?.detail || data?.raw || "Etsy API error";

  if (!key) {
    return res.status(500).json({
      error: "ETSY_KEYSTRING / ETSY_API_KEY not set.",
      setup: "Add ETSY_KEYSTRING and ETSY_SHARED_SECRET to your env vars."
    });
  }

  const { action, shop_id, limit = "50", offset = "0", min_created, receipt_id } = req.query;
  const sid = shop_id || defaultShopId;

  // Public endpoints only need x-api-key. Authenticated endpoints also need Bearer.
  const pubHeaders  = { "x-api-key": key };
  const authHeaders = token
    ? { "x-api-key": key, Authorization: `Bearer ${token}` }
    : pubHeaders;

  try {
    // ── ping: verify API key (public endpoint) ─────────────────────────────────
    if (action === "ping") {
      const r = await fetch("https://openapi.etsy.com/v3/application/openapi-ping", { headers: pubHeaders });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ ok: false, error: data.error || "Auth failed", details: data });
      return res.json({
        ok: true,
        api_key_valid: true,
        has_oauth_token: !!token,
        message: token
          ? "✓ API key valid + OAuth token present — ready to sync orders"
          : "✓ API key valid — but no OAuth token yet. Visit /api/etsy-auth?action=start to connect your shop",
        data
      });
    }

    if (!sid) return res.status(400).json({ error: "shop_id required (or set ETSY_SHOP_ID env var)" });

    // ── shop: fetch shop info (public) ─────────────────────────────────────────
    if (action === "shop") {
      const r = await fetch(`https://openapi.etsy.com/v3/application/shops/${sid}`, { headers: pubHeaders });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error || "Etsy API error", details: data });
      return res.json(data);
    }

    // ── orders: list paid receipts (requires OAuth) ────────────────────────────
    if (action === "orders") {
      if (!token) return res.status(401).json({
        error: "OAuth token required to read orders.",
        fix: "Visit /api/etsy-auth?action=start to authorize your shop."
      });
      const p = new URLSearchParams({ was_paid: "true", limit, offset });
      if (min_created) p.set("min_created", min_created);
      const r = await fetch(`https://openapi.etsy.com/v3/application/shops/${sid}/receipts?${p}`, { headers: authHeaders });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error || "Etsy API error", details: data });
      return res.json(data);
    }

    // ── receipt: single receipt by ID (requires OAuth) ─────────────────────────
    if (action === "receipt") {
      if (!receipt_id) return res.status(400).json({ error: "receipt_id required" });
      if (!token) return res.status(401).json({ error: "OAuth token required", fix: "Visit /api/etsy-auth?action=start" });
      const r = await fetch(`https://openapi.etsy.com/v3/application/shops/${sid}/receipts/${receipt_id}`, { headers: authHeaders });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error || "Etsy API error", details: data });
      return res.json(data);
    }

    // ── discounts: active shop sales / discounts ─────────────────────────────
    if (action === "discounts") {
      if (!token) return res.status(401).json({ error: "OAuth token required" });
      const r = await fetch(`https://openapi.etsy.com/v3/application/shops/${sid}/discounts`, { headers: authHeaders });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error || "Etsy API error", details: data });
      return res.json(data);
    }

    // ── sections: shop sections ───────────────────────────────────────────────
    if (action === "sections") {
      const r = await fetch(`https://openapi.etsy.com/v3/application/shops/${sid}/sections`, { headers: authHeaders });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error || "Etsy API error", details: data });
      return res.json(data);
    }

    // ── listings: active listings with images ─────────────────────────────────
    if (action === "listings") {
      const state = req.query.state || "active";
      const p = new URLSearchParams({ state, limit, offset });
      p.append("includes[]", "Images");
      const r = await fetch(`https://openapi.etsy.com/v3/application/shops/${sid}/listings?${p}`, { headers: authHeaders });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error || "Etsy API error", details: data });
      return res.json(data);
    }

    // ── listings_all: paginate all active + inactive + sold_out listings ──────
    if (action === "listings_all") {
      const results = [];
      const stateErrors = [];
      const etsyFetch = (url) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 12000); // 12s per request
        return fetch(url, { headers: authHeaders, signal: ctrl.signal })
          .finally(() => clearTimeout(t));
      };
      for (const state of ["active", "inactive", "sold_out"]) {
        const p0 = new URLSearchParams({ state, limit: "100", offset: "0" });
        p0.append("includes[]", "Images");
        let r0;
        try {
          r0 = await etsyFetch(`https://openapi.etsy.com/v3/application/shops/${sid}/listings?${p0}`);
        } catch (e) {
          stateErrors.push({ state, status: 0, error: e.name === "AbortError" ? "timeout" : e.message });
          continue;
        }
        if (!r0.ok) {
          const e = await r0.json().catch(() => ({}));
          stateErrors.push({ state, status: r0.status, error: e.error || e.message || "unknown" });
          continue;
        }
        const d0 = await r0.json();
        results.push(...(d0.results || []));
        const total = d0.count || 0;
        if (total > 100) {
          const pageCount = Math.ceil((total - 100) / 100);
          const fetches = Array.from({ length: pageCount }, (_, i) => {
            const p = new URLSearchParams({ state, limit: "100", offset: String((i + 1) * 100) });
            p.append("includes[]", "Images");
            return etsyFetch(`https://openapi.etsy.com/v3/application/shops/${sid}/listings?${p}`)
              .then(r => r.ok ? r.json() : { results: [] })
              .catch(() => ({ results: [] }));
          });
          const pages = await Promise.all(fetches);
          pages.forEach(d => results.push(...(d.results || [])));
        }
      }
      return res.json({ count: results.length, results, stateErrors: stateErrors.length ? stateErrors : undefined });
    }

    // ── listing_images: images for a listing ──────────────────────────────────
    if (action === "listing_images") {
      const { listing_id } = req.query;
      if (!listing_id) return res.status(400).json({ error: "listing_id required" });
      const r = await fetch(`https://openapi.etsy.com/v3/application/listings/${listing_id}/images`, { headers: pubHeaders });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error || "Etsy API error", details: data });
      return res.json(data);
    }

    // ── listing: single listing detail ────────────────────────────────────────
    if (action === "listing") {
      const { listing_id } = req.query;
      if (!listing_id) return res.status(400).json({ error: "listing_id required" });
      const r = await fetch(`https://openapi.etsy.com/v3/application/listings/${listing_id}`, { headers: pubHeaders });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error || "Etsy API error", details: data });
      return res.json(data);
    }

    // ── upload_listing_image: fetch image from URL and POST to Etsy listing ─────
    if (action === "upload_listing_image") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
      if (!token) return res.status(401).json({ error: "OAuth token required" });
      const { listing_id } = req.query;
      const { image_url, rank = 1 } = req.body || {};
      if (!listing_id || !image_url) return res.status(400).json({ error: "listing_id and image_url required" });
      const imgR = await fetch(image_url);
      if (!imgR.ok) return res.status(400).json({ error: `Could not fetch image (${imgR.status})` });
      const imgBuf = await imgR.arrayBuffer();
      const ct = imgR.headers.get("content-type") || "image/jpeg";
      const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
      const form = new FormData();
      form.append("image", new Blob([imgBuf], { type: ct }), `img.${ext}`);
      form.append("rank", String(rank));
      const r = await fetch(
        `https://openapi.etsy.com/v3/application/shops/${sid}/listings/${listing_id}/images`,
        { method: "POST", headers: { "x-api-key": key, Authorization: `Bearer ${token}` }, body: form }
      );
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error || "Image upload failed", details: data });
      return res.json(data);
    }

    // ── upload_listing_video: fetch video from URL and POST to Etsy listing ─────
    // Etsy allows ONE video per listing: MP4, ≤100MB, ~5–15s.
    if (action === "upload_listing_video") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
      if (!token) return res.status(401).json({ error: "OAuth token required" });
      const { listing_id } = req.query;
      const { video_url, name = "video" } = req.body || {};
      if (!listing_id || !video_url) return res.status(400).json({ error: "listing_id and video_url required" });
      const vR = await fetch(video_url);
      if (!vR.ok) return res.status(400).json({ error: `Could not fetch video (${vR.status})` });
      const vBuf = await vR.arrayBuffer();
      const ct = vR.headers.get("content-type") || "video/mp4";
      const form = new FormData();
      form.append("video", new Blob([vBuf], { type: ct }), "video.mp4");
      form.append("name", String(name).slice(0, 70));
      const r = await fetch(
        `https://openapi.etsy.com/v3/application/shops/${sid}/listings/${listing_id}/videos`,
        { method: "POST", headers: { "x-api-key": key, Authorization: `Bearer ${token}` }, body: form }
      );
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error || "Video upload failed", details: data });
      return res.json(data);
    }

    // ── delete_listing_image: remove an image from a listing ──────────────────
    if (action === "delete_listing_image") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
      if (!token) return res.status(401).json({ error: "OAuth token required" });
      const { listing_id, listing_image_id } = { ...req.query, ...(req.body || {}) };
      if (!listing_id || !listing_image_id) return res.status(400).json({ error: "listing_id and listing_image_id required" });
      const r = await fetch(
        `https://openapi.etsy.com/v3/application/shops/${sid}/listings/${listing_id}/images/${listing_image_id}`,
        { method: "DELETE", headers: authHeaders }
      );
      if (!r.ok) { const d = await r.json().catch(() => ({})); return res.status(r.status).json({ error: d.error || "Delete failed" }); }
      return res.json({ ok: true });
    }

    // ── update_listing: PATCH listing metadata (title, description, tags, state) ─
    if (action === "update_listing") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
      if (!token) return res.status(401).json({ error: "OAuth token required", fix: "Visit /api/etsy-auth?action=start" });
      const { listing_id } = req.query;
      if (!listing_id) return res.status(400).json({ error: "listing_id required" });
      const { title, description, tags, state } = req.body || {};
      const payload = {};
      if (title !== undefined) payload.title = String(title).slice(0, 140);
      if (description !== undefined) payload.description = String(description);
      if (state !== undefined) payload.state = state;
      if (Array.isArray(tags)) {
        payload.tags = [...new Set(tags.map(t => String(t).trim()).filter(Boolean))].slice(0, 13);
      }
      const url = `https://openapi.etsy.com/v3/application/shops/${sid}/listings/${listing_id}`;

      // Try JSON first — Etsy v3 listing PATCH accepts JSON on current clusters.
      let r = await fetch(url, {
        method: "PATCH",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      let { data } = await readJsonish(r);
      console.log("[etsy update_listing] json PATCH status:", r.status, "etsyMsg:", etsyMessage(data));

      // Fallback to form-encoded only on 4xx that aren't auth errors.
      // Some older Etsy clusters reject JSON body and want form-encoded tags.
      if (!r.ok && r.status !== 401 && r.status !== 403) {
        const form = new URLSearchParams();
        if (payload.title       !== undefined) form.set("title",       payload.title);
        if (payload.description !== undefined) form.set("description", payload.description);
        if (payload.state       !== undefined) form.set("state",       payload.state);
        if (payload.tags        !== undefined) form.set("tags",        JSON.stringify(payload.tags));
        const rf = await fetch(url, {
          method: "PATCH",
          headers: { ...authHeaders, "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        });
        const { data: df } = await readJsonish(rf);
        console.log("[etsy update_listing] form PATCH status:", rf.status, "etsyMsg:", etsyMessage(df));
        if (rf.ok) { r = rf; data = df; }
        else if (rf.status !== r.status) { r = rf; data = df; } // use whichever has more info
      }

      if (!r.ok) {
        return res.status(r.status).json({
          error: `Listing update failed: ${etsyMessage(data)}`,
          etsyError: etsyMessage(data),
          details: data,
        });
      }
      return res.json(data);
    }

    // ── update_inventory: update price + quantity via inventory endpoint ──────
    if (action === "update_inventory") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
      if (!token) return res.status(401).json({ error: "OAuth token required" });
      const { listing_id } = req.query;
      if (!listing_id) return res.status(400).json({ error: "listing_id required" });
      const { price, quantity } = req.body || {};
      // 1. GET current inventory
      const getR = await fetch(`https://openapi.etsy.com/v3/application/listings/${listing_id}/inventory`, { headers: authHeaders });
      const { data: invData } = await readJsonish(getR);
      if (!getR.ok) {
        return res.status(getR.status).json({
          error: "Failed to fetch inventory",
          etsyError: invData?.error || invData?.message || invData?.detail || null,
          details: invData,
          hint: getR.status === 403
            ? "Token may be missing listings_r scope — re-authorize via /api/etsy-auth?action=start"
            : getR.status === 401
            ? "OAuth token expired or invalid — re-authorize via /api/etsy-auth?action=start"
            : null,
        });
      }
      const inv = invData;
      const parsedPrice = price !== undefined ? Number.parseFloat(price) : undefined;
      const parsedQuantity = quantity !== undefined ? Number.parseInt(quantity, 10) : undefined;
      if (price !== undefined && !Number.isFinite(parsedPrice)) {
        return res.status(400).json({ error: "Price must be a valid number" });
      }
      if (quantity !== undefined && (!Number.isFinite(parsedQuantity) || parsedQuantity < 0)) {
        return res.status(400).json({ error: "Quantity must be a valid non-negative number" });
      }

      const moneyToDecimal = money => {
        if (typeof money === "number") return money;
        const amount = Number(money?.amount ?? 0);
        const divisor = Number(money?.divisor || 100);
        return divisor ? amount / divisor : amount;
      };

      // 2. Modify ALL products/offerings (handles multi-variation listings too).
      // Etsy requires the full inventory payload, but rejects read-only fields from
      // getListingInventory. It also wants offering.price as a decimal, not a Money object.
      const cleanProducts = (inv.products || []).map(prod => ({
        sku: prod.sku || "",
        property_values: (prod.property_values || []).map(pv => {
          const clean = {
            property_id: pv.property_id,
            property_name: pv.property_name,
            scale_id: pv.scale_id ?? null,
            value_ids: Array.isArray(pv.value_ids) ? pv.value_ids : [],
            values: Array.isArray(pv.values) ? pv.values : [],
          };
          return Object.fromEntries(Object.entries(clean).filter(([, v]) => v !== undefined));
        }),
        offerings: (prod.offerings || []).map(offering => {
          const nextPrice = parsedPrice ?? moneyToDecimal(offering.price);
          const clean = {
            quantity: parsedQuantity ?? (offering.quantity ?? 1),
            is_enabled: offering.is_enabled ?? true,
            price: Number(nextPrice.toFixed ? nextPrice.toFixed(2) : Number(nextPrice).toFixed(2)),
          };
          if (offering.readiness_state_id !== undefined) clean.readiness_state_id = offering.readiness_state_id;
          return clean;
        }),
      }));
      if (!cleanProducts.length) return res.status(400).json({ error: "Listing has no Etsy inventory products to update" });

      const inventoryBody = {
        products: cleanProducts,
        price_on_property: inv.price_on_property || [],
        quantity_on_property: inv.quantity_on_property || [],
        sku_on_property: inv.sku_on_property || [],
      };
      if (Array.isArray(inv.readiness_state_on_property)) {
        inventoryBody.readiness_state_on_property = inv.readiness_state_on_property;
      }

      // 3. PUT back as JSON. Some Etsy clusters still expect form-encoded JSON
      // strings, so retry that encoding if Etsy returns the classic JSON-string error.
      const inventoryUrl = `https://openapi.etsy.com/v3/application/listings/${listing_id}/inventory`;
      let putR = await fetch(inventoryUrl, {
        method: "PUT",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(inventoryBody),
      });
      let { text: putText, data: putData } = await readJsonish(putR);
      console.log("[etsy update_inventory] JSON PUT status:", putR.status, "body:", putText.slice(0, 500));

      if (!putR.ok && /json/i.test(etsyMessage(putData))) {
        const formBody = new URLSearchParams({
          products: JSON.stringify(cleanProducts),
          price_on_property: JSON.stringify(inventoryBody.price_on_property),
          quantity_on_property: JSON.stringify(inventoryBody.quantity_on_property),
          sku_on_property: JSON.stringify(inventoryBody.sku_on_property),
        });
        if (Array.isArray(inventoryBody.readiness_state_on_property)) {
          formBody.set("readiness_state_on_property", JSON.stringify(inventoryBody.readiness_state_on_property));
        }
        putR = await fetch(inventoryUrl, {
          method: "PUT",
          headers: { ...authHeaders, "Content-Type": "application/x-www-form-urlencoded" },
          body: formBody.toString(),
        });
        ({ text: putText, data: putData } = await readJsonish(putR));
        console.log("[etsy update_inventory] FORM PUT status:", putR.status, "body:", putText.slice(0, 500));
      }

      if (!putR.ok) {
        return res.status(putR.status).json({
          error: `Inventory update failed: ${etsyMessage(putData)}`,
          details: putData,
        });
      }
      return res.json(putData);
    }

    return res.status(400).json({ error: "Unknown action. Use: ping, shop, orders, receipt, listings, listings_all, listing_images, listing, upload_listing_image, upload_listing_video, delete_listing_image, update_listing, update_inventory" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
