export const config = { api: { bodyParser: { sizeLimit: "10mb" } } };

// ── Shopify OAuth callback (GET /api/shopify?code=xxx&shop=xxx) ───────────────
const REDIRECT_BASE = "https://project-nine-tan-22.vercel.app";
async function handleOAuthCallback(req, res) {
  const { code, shop, error } = req.query;
  const redir = (err) => res.redirect(`${REDIRECT_BASE}/#shopify-error=${encodeURIComponent(err)}`);
  if (error) return redir("Shopify denied: " + error);
  if (!code || !shop) return redir("Missing code or shop from Shopify callback");
  // Store-aware OAuth creds: each Shopify store is its own app with its own client
  // id/secret. Match the authorizing shop to a per-store credential pair, falling back
  // to the generic SHOPIFY_CLIENT_ID/SECRET so existing (Earth Ed.) wiring is untouched.
  const shopHost = String(shop || "").toLowerCase();
  const isAty   = shopHost && shopHost === String(process.env.SHOPIFY_ATY_STORE   || "").toLowerCase();
  const isEarth = shopHost && shopHost === String(process.env.SHOPIFY_EARTH_STORE || "").toLowerCase();
  const clientId     = (isAty && process.env.SHOPIFY_ATY_CLIENT_ID)     || (isEarth && process.env.SHOPIFY_EARTH_CLIENT_ID)     || process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = (isAty && process.env.SHOPIFY_ATY_CLIENT_SECRET) || (isEarth && process.env.SHOPIFY_EARTH_CLIENT_SECRET) || process.env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return redir(`No Shopify client id/secret set for ${shopHost || "this shop"} (checked SHOPIFY_ATY_* / SHOPIFY_EARTH_* / SHOPIFY_CLIENT_*)`);
  const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); }
  catch { return redir(`Shopify returned non-JSON (${r.status}): ${text.slice(0, 200)}`); }
  if (!data.access_token) return redir(data.error_description || data.error || JSON.stringify(data));
  const token = data.access_token;
  return res.redirect(`${REDIRECT_BASE}/#shopify-auth=${encodeURIComponent(token)}&shopify-shop=${encodeURIComponent(shop)}`);
}

async function pushVideo(shop, token, productId, videoUrl) {
  if (!videoUrl || !videoUrl.startsWith("http")) return;
  const cleanUrl = videoUrl.split("?")[0];
  const filename = cleanUrl.split("/").pop() || "video.mp4";
  const ext = filename.split(".").pop().toLowerCase();
  const mimeType = ext === "mov" ? "video/quicktime" : ext === "webm" ? "video/webm" : "video/mp4";
  const gqlUrl = `https://${shop}/admin/api/2025-01/graphql.json`;
  const gqlHeaders = { "Content-Type": "application/json", "X-Shopify-Access-Token": token };

  try {
    // Step 1: HEAD the Vercel Blob URL to get file size (required by Shopify staged upload)
    const headRes = await fetch(cleanUrl, { method: "HEAD" });
    const fileSize = headRes.headers.get("content-length") || "0";

    // Step 2: create Shopify staged upload — VIDEO requires httpMethod PUT + fileSize
    const stagedRes = await fetch(gqlUrl, {
      method: "POST", headers: gqlHeaders,
      body: JSON.stringify({
        query: `mutation stagedUploadsCreate($input:[StagedUploadInput!]!){
          stagedUploadsCreate(input:$input){
            stagedTargets{ url resourceUrl parameters{ name value } }
            userErrors{ field message }
          }
        }`,
        variables: { input: [{ filename, mimeType, resource: "VIDEO", httpMethod: "POST", fileSize }] },
      }),
    });
    const stagedData = await stagedRes.json();
    const userErrors = stagedData?.data?.stagedUploadsCreate?.userErrors;
    if (userErrors?.length) throw new Error("Staged init errors: " + userErrors.map(e => e.message).join(", "));
    const target = stagedData?.data?.stagedUploadsCreate?.stagedTargets?.[0];
    if (!target?.url) throw new Error("No staged URL returned: " + JSON.stringify(stagedData?.data));

    // Log parameters for debugging
    console.log("Staged target url:", target.url);
    console.log("Staged parameters:", JSON.stringify(target.parameters));

    // Step 3: fetch video blob then POST as multipart to GCS (params = policy fields, no auth header needed)
    const videoRes = await fetch(cleanUrl);
    if (!videoRes.ok) throw new Error(`Fetching video failed: ${videoRes.status}`);
    const videoBlob = await videoRes.blob();

    const form = new FormData();
    for (const { name, value } of target.parameters) form.append(name, value);
    form.append("file", videoBlob, filename);

    const uploadRes = await fetch(target.url, { method: "POST", body: form });
    if (!uploadRes.ok) {
      const txt = await uploadRes.text();
      throw new Error(`GCS staging failed ${uploadRes.status}: ${txt.slice(0, 300)}`);
    }

    // Step 4: attach the staged video to the Shopify product
    const resourceUrl = target.resourceUrl || target.url;
    const mediaRes = await fetch(gqlUrl, {
      method: "POST", headers: gqlHeaders,
      body: JSON.stringify({
        query: `mutation productCreateMedia($productId:ID!,$media:[CreateMediaInput!]!){
          productCreateMedia(productId:$productId,media:$media){
            media{ mediaContentType status }
            mediaUserErrors{ field message }
          }
        }`,
        variables: {
          productId: `gid://shopify/Product/${productId}`,
          media: [{ mediaContentType: "VIDEO", originalSource: resourceUrl }],
        },
      }),
    });
    const mediaData = await mediaRes.json();
    const errs = mediaData?.data?.productCreateMedia?.mediaUserErrors;
    if (errs?.length) throw new Error(errs.map(e => e.message).join(", "));
  } catch (e) {
    console.error("Shopify video push failed:", e.message);
    throw e;
  }
}

const fmtQty = v => {
  if (v === undefined || v === null || v === "") return "";
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("en-IN", { maximumFractionDigits: 3 }) : String(v).trim();
};
const qtyParts = item => {
  const parts = [];
  if (item?.qty !== undefined && item.qty !== null && item.qty !== "" && +item.qty !== 0) parts.push({ qty: item.qty, unit: item.unit || "pcs" });
  if (item?.qty2 !== undefined && item.qty2 !== null && item.qty2 !== "" && +item.qty2 !== 0) parts.push({ qty: item.qty2, unit: item.unit2 || "kg" });
  return parts;
};
const titleQtyParts = item => [...qtyParts(item)].sort((a, b) => {
  const rank = u => {
    const s = String(u || "").toLowerCase();
    if (s === "kg" || s === "kgs") return 0;
    if (s === "gm" || s === "g") return 1;
    if (s === "pcs") return 2;
    return 3;
  };
  return rank(a.unit) - rank(b.unit);
});
const fallbackShopifyTitle = item => {
  const name = [item?.material, item?.shape].filter(Boolean).join(" ").trim() || "Stone";
  const qty = titleQtyParts(item).map(p => `${fmtQty(p.qty)} ${p.unit}`).join(" ");
  return qty ? `${name} - ${qty}` : name;
};
const availabilityString = item => qtyParts(item).map(p => `${fmtQty(p.qty)} ${p.unit}`).join(" / ");

async function generateAIContent(item, title, availStr) {
  try {
    const exactTitleFormat = fallbackShopifyTitle(item);
    const details = [
      item.material && `Material: ${item.material}`,
      item.shape    && `Shape: ${item.shape}`,
      item.origin   && `Origin: ${item.origin}`,
      item.grade    && `Grade: ${item.grade}`,
      item.size     && `Size: ${item.size}`,
      item.productType && `Type: ${item.productType}`,
      availStr      && `Available: ${availStr}`,
      item.notes    && `Notes: ${item.notes}`,
    ].filter(Boolean).join("\n");

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 600,
        messages: [{
          role: "user",
          content: `You are an SEO copywriter for a premium gemstone wholesale business. Given the product details below, generate Shopify product content.

Product: ${title}
Required title pattern: ${exactTitleFormat}
${details}

Return ONLY valid JSON with these fields:
{
  "shopifyTitle": "clean product title in this pattern: Stone Shape - kg pcs. Keep the exact quantities and units from the required title pattern. Do not add location or marketing fluff.",
  "bodyHtml": "short Shopify HTML description, 2-4 sentences plus a compact details line. Must include exact kg and pcs if present. Include origin; use stated origin when present, otherwise infer a likely source region for the specific mineral and phrase it as likely/probable origin.",
  "seoTitle": "max 70 chars, include material + origin + grade if available, no quotes",
  "seoDesc": "max 155 chars, natural sentence, highlight quality + origin + use case",
  "tags": "15-20 comma-separated tags: include material name variants, healing/spiritual uses, chakra associations if relevant, origin country, shape, grade, crystal type, buyer intent keywords"
}`,
        }],
      }),
    });
    const data = await res.json();
    const text = data.content?.[0]?.text || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch (e) {
    console.error("AI SEO generation failed:", e.message);
    return null;
  }
}

/* Pushing ready stock into the storefront's "Deals" section is the main reason
   this endpoint is used, so the outcome is reported back rather than swallowed —
   a missing Deals collection used to fail silently and the product would quietly
   never appear in the section. */
async function addToDealsCollection(shop, token, productId) {
  const H = { "Content-Type": "application/json", "X-Shopify-Access-Token": token };
  try {
    const r = await fetch(`https://${shop}/admin/api/2024-04/custom_collections.json?title=Deals&limit=1`, { headers: H });
    const data = await r.json();
    const collection = data?.custom_collections?.[0];
    if (!collection) return { ok: false, error: 'No collection titled "Deals" on this store' };

    // Re-pushing an item must not create a duplicate collect.
    const fr = await fetch(`https://${shop}/admin/api/2024-04/collects.json?product_id=${productId}&collection_id=${collection.id}&limit=1`, { headers: H });
    const fd = await fr.json().catch(() => ({}));
    if (fd?.collects?.[0]) return { ok: true, collectionId: String(collection.id), alreadyIn: true };

    const cr = await fetch(`https://${shop}/admin/api/2024-04/collects.json`, {
      method: "POST", headers: H,
      body: JSON.stringify({ collect: { product_id: productId, collection_id: collection.id } }),
    });
    if (!cr.ok) {
      const err = await cr.text().catch(() => "");
      return { ok: false, error: `Deals collect failed (${cr.status}) ${err.slice(0, 140)}` };
    }
    return { ok: true, collectionId: String(collection.id) };
  } catch (e) {
    console.error("Add to Deals collection failed:", e.message);
    return { ok: false, error: e.message };
  }
}

async function applySEOAndMeta(shop, token, productId, seoTitle, seoDesc, item) {
  try {
    // Set SEO title + description via metafields (namespace: global)
    const gqlUrl = `https://${shop}/admin/api/2024-04/graphql.json`;
    const mutation = `
      mutation productUpdate($input: ProductInput!) {
        productUpdate(input: $input) {
          product { id }
          userErrors { field message }
        }
      }`;
    await fetch(gqlUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({
        query: mutation,
        variables: { input: { id: `gid://shopify/Product/${productId}`, seo: { title: seoTitle, description: seoDesc } } },
      }),
    });

    // Set product metafields via REST
    const metafields = [
      item.material && { namespace: "custom", key: "material", value: item.material, type: "single_line_text_field" },
      item.shape    && { namespace: "custom", key: "shape",    value: item.shape,    type: "single_line_text_field" },
      item.origin   && { namespace: "custom", key: "origin",   value: item.origin,   type: "single_line_text_field" },
      item.grade    && { namespace: "custom", key: "grade",    value: item.grade,    type: "single_line_text_field" },
      item.size     && { namespace: "custom", key: "size",     value: item.size,     type: "single_line_text_field" },
    ].filter(Boolean);

    for (const mf of metafields) {
      await fetch(`https://${shop}/admin/api/2024-04/products/${productId}/metafields.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
        body: JSON.stringify({ metafield: mf }),
      });
    }
  } catch (e) {
    console.error("SEO/meta error:", e.message);
  }
}

async function uploadPhoto(sr, productId, item) {
  // Support multi-photo listings: item.photos = [url, ...], fall back to item.photo
  const photos = (item.photos?.length ? item.photos : item.photo ? [item.photo] : []).filter(Boolean);
  if (!photos.length) return;
  try {
    // Delete existing images first so we don't pile up duplicates on update
    const existing = await sr("GET", `/products/${productId}/images.json`);
    if (existing.ok && existing.data.images?.length) {
      for (const img of existing.data.images) {
        await sr("DELETE", `/products/${productId}/images/${img.id}.json`);
      }
    }
    // Upload all photos in order (cover first)
    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      let imagePayload;
      if (photo.startsWith("data:image")) {
        const base64 = photo.split(",")[1];
        imagePayload = { attachment: base64, filename: `${item.sku || item.id}-${i+1}.jpg`, position: i+1 };
      } else if (photo.startsWith("http")) {
        imagePayload = { src: photo, filename: `${item.sku || item.id}-${i+1}.jpg`, position: i+1 };
      } else {
        continue;
      }
      await sr("POST", `/products/${productId}/images.json`, { image: imagePayload });
    }
  } catch (_) {}
}

/* Shopify's REST limit is a 2 req/s leaky bucket, and several actions here loop
   over up to 100 products. Every call is serialised behind a minimum gap and one
   429 is retried honouring Retry-After, so a bulk tag or a sync batch degrades
   into "slow" rather than "half of them silently failed". */
const SHOPIFY_MIN_GAP_MS = 550;
let _shopifyChain = Promise.resolve();
let _shopifyLastAt = 0;
const _sleep = ms => new Promise(r => setTimeout(r, ms));

function shopifyReq(shop, token, method, path, body) {
  const run = async () => {
    const wait = SHOPIFY_MIN_GAP_MS - (Date.now() - _shopifyLastAt);
    if (wait > 0) await _sleep(wait);
    let out = await _shopifyFetch(shop, token, method, path, body);
    if (out.status === 429) {
      const after = Math.min(5, Math.max(1, +out.retryAfter || 2));
      await _sleep(after * 1000);
      out = await _shopifyFetch(shop, token, method, path, body);
    }
    _shopifyLastAt = Date.now();
    return out;
  };
  _shopifyChain = _shopifyChain.then(run, run);
  return _shopifyChain;
}

async function _shopifyFetch(shop, token, method, path, body) {
  const r = await fetch(`https://${shop}/admin/api/2024-04${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { return { ok: false, error: text.slice(0, 300), status: r.status }; }
  if (!r.ok) return { ok: false, error: data?.errors || data?.error || text.slice(0, 300), status: r.status, retryAfter: r.headers.get("Retry-After") };
  return { ok: true, data, headers: r.headers };
}

function nextPagePath(linkHeader) {
  const link = String(linkHeader || "");
  const match = link.split(",").find(part => part.includes('rel="next"'))?.match(/<([^>]+)>/);
  if (!match) return "";
  try {
    const u = new URL(match[1]);
    return `${u.pathname.replace(/^\/admin\/api\/[^/]+/, "")}${u.search}`;
  } catch {
    return "";
  }
}

/* A token minted before a scope was requested still works for everything else, so
   Shopify answers only the affected call with a 403 naming the scope. That reads as a
   dead end in the UI ("[API] This action requires merchant approval for read_customers
   scope"), when the fix is simply to reconnect the store — so name the scope and say so. */
function missingScope(err) {
  const msg = typeof err === "string" ? err : JSON.stringify(err ?? "");
  return /merchant approval for (\w+) scope/i.exec(msg)?.[1] || "";
}
const scopeErrorBody = (scope, what) => ({
  error: `This store's Shopify token doesn't grant ${scope}, so ${what}. Reconnect the store in Listing Manager → Earth Ed. to grant it (the Shopify app also needs protected customer data access approved).`,
  scopeMissing: true,
  scope,
});

async function shopifyGetAll(sr, firstPath, listKey, maxPages = 12) {
  const rows = [];
  let path = firstPath;
  for (let page = 0; path && page < maxPages; page++) {
    const result = await sr("GET", path);
    if (!result.ok) return { ok: false, error: result.error };
    rows.push(...(result.data?.[listKey] || []));
    path = nextPagePath(result.headers?.get?.("link"));
  }
  return { ok: true, rows };
}

export default async function handler(req, res) {
  // Shopify OAuth callback comes in as GET with code+shop params
  if (req.method === "GET") return handleOAuthCallback(req, res);
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }

  const { action, item, shopStore, shopToken, shopifyName, shopifyPrice, store_key, status = "active", limit = 250, product, collection_id } = body;

  const storeEnvKey = store_key === "atyahara" ? "SHOPIFY_ATY_STORE" : store_key === "earth" ? "SHOPIFY_EARTH_STORE" : "SHOPIFY_STORE";
  const tokenEnvKey = store_key === "atyahara" ? "SHOPIFY_ATY_TOKEN" : store_key === "earth" ? "SHOPIFY_EARTH_TOKEN" : "SHOPIFY_ACCESS_TOKEN";
  const SHOP  = shopStore || process.env[storeEnvKey] || process.env.SHOPIFY_STORE;
  const TOKEN = shopToken  || process.env[tokenEnvKey] || process.env.SHOPIFY_ACCESS_TOKEN;

  // Build a Shopify OAuth authorize URL for a one-click in-app "Connect" button.
  // Runs before the SHOP/TOKEN guards below (a disconnected store has neither yet).
  if (action === "oauth_url") {
    const shop = String(body.shop || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!shop) return res.status(400).json({ error: "shop domain required" });
    const clientId = store_key === "atyahara" ? (process.env.SHOPIFY_ATY_CLIENT_ID || process.env.SHOPIFY_CLIENT_ID)
                   : store_key === "earth"    ? (process.env.SHOPIFY_EARTH_CLIENT_ID || process.env.SHOPIFY_CLIENT_ID)
                   : process.env.SHOPIFY_CLIENT_ID;
    if (!clientId) return res.status(400).json({ error: `No Shopify client id configured (SHOPIFY_CLIENT_ID / SHOPIFY_${store_key === "atyahara" ? "ATY" : "EARTH"}_CLIENT_ID)` });
    // Match each store's app: Earth's ERP-2 app whitelists /api/shopify-auth (routed to
    // /api/shopify by a rewrite); Atyahara's whitelists /api/shopify and adds order scopes.
    // Requesting scopes the app lacks fails the authorize, so these must stay in step with
    // the app's configured scopes in the Partner dashboard. Customer scopes are needed by
    // the Omnisend approvals screen (read the signup list, write the `approved` tag) and are
    // protected customer data — the app must also be approved for that, or the token comes
    // back without them and reads 403 with "requires merchant approval for read_customers".
    const isEarth = store_key === "earth";
    const scope = isEarth
      ? "read_products,write_products,read_customers,write_customers"
      : "read_products,write_products,read_orders,read_all_orders,read_customers,write_customers";
    const redirect = `${REDIRECT_BASE}${isEarth ? "/api/shopify-auth" : "/api/shopify"}`;
    const url = `https://${shop}/admin/oauth/authorize?client_id=${encodeURIComponent(clientId)}&scope=${encodeURIComponent(scope)}&redirect_uri=${encodeURIComponent(redirect)}&state=erp`;
    return res.json({ success: true, url });
  }

  if (!SHOP)  return res.status(400).json({ error: "Store domain required" });
  if (!TOKEN) return res.status(400).json({ error: "Shopify access token required" });

  const sr = (method, path, b) => shopifyReq(SHOP, TOKEN, method, path, b);

  /* ── Wholesale approval ──────────────────────────────────────────────────
     Mailing-list signups arrive as Shopify customers. A tag on the customer is
     what the storefront checks to unlock trade prices and account login, so
     approving is a tag write — never a delete, and existing tags are preserved. */
  if (action === "list_customers") {
    const qs = new URLSearchParams({ limit: "250", fields: "id,email,first_name,last_name,tags,state,created_at,orders_count,total_spent,accepts_marketing,email_marketing_consent,note" });
    if (body.query) qs.set("query", String(body.query));
    const result = await shopifyGetAll(sr, `/customers.json?${qs.toString()}`, "customers");
    if (!result.ok) {
      const scope = missingScope(result.error);
      if (scope) return res.status(403).json(scopeErrorBody(scope, "the customer list can't be read"));
      return res.status(400).json({ error: result.error });
    }
    const tagOf = c => String(c.tags || "").split(",").map(t => t.trim()).filter(Boolean);
    const rows = (result.rows || []).map(c => ({
      id: String(c.id),
      email: c.email || "",
      name: [c.first_name, c.last_name].filter(Boolean).join(" "),
      tags: tagOf(c),
      state: c.state || "",
      createdAt: c.created_at || "",
      ordersCount: +c.orders_count || 0,
      totalSpent: +c.total_spent || 0,
      // Newer API reports consent as an object; older stores use the boolean.
      subscribed: c.email_marketing_consent
        ? c.email_marketing_consent.state === "subscribed"
        : !!c.accepts_marketing,
      note: c.note || "",
    }));
    return res.json({ success: true, customers: rows, total: rows.length });
  }

  if (action === "tag_customer") {
    const id = String(body.customer_id || "").trim();
    const add = [...new Set((body.add_tags || []).map(t => String(t).trim()).filter(Boolean))];
    const remove = new Set((body.remove_tags || []).map(t => String(t).trim().toLowerCase()).filter(Boolean));
    if (!id) return res.status(400).json({ error: "customer_id required" });
    if (!add.length && !remove.size) return res.status(400).json({ error: "Nothing to change" });

    // Shopify replaces the whole tag string, so read first and merge.
    const cur = await sr("GET", `/customers/${encodeURIComponent(id)}.json?fields=id,email,tags`);
    if (!cur.ok) {
      const scope = missingScope(cur.error);
      if (scope) return res.status(403).json(scopeErrorBody(scope, "the tag can't be written"));
      return res.status(cur.status || 400).json({ error: cur.error || "Customer not found" });
    }
    const existing = String(cur.data?.customer?.tags || "").split(",").map(t => t.trim()).filter(Boolean);
    const kept = existing.filter(t => !remove.has(t.toLowerCase()));
    const merged = [...kept];
    for (const t of add) if (!merged.some(x => x.toLowerCase() === t.toLowerCase())) merged.push(t);

    const r = await sr("PUT", `/customers/${encodeURIComponent(id)}.json`, { customer: { id, tags: merged.join(", ") } });
    if (!r.ok) {
      const scope = missingScope(r.error);
      if (scope) return res.status(403).json(scopeErrorBody(scope, "the tag can't be written"));
      return res.status(r.status || 400).json({ error: r.error });
    }
    return res.json({ success: true, id, email: cur.data?.customer?.email || "", tags: merged });
  }

  if (action === "get_orders") {
    const daysBack = parseInt(body.days, 10) || 90;
    const sinceISO = new Date(Date.now() - daysBack * 86400000).toISOString();
    const qs = new URLSearchParams({
      status: "any",
      limit: "250",
      created_at_min: sinceISO,
      fields: "id,name,order_number,created_at,processed_at,cancelled_at,financial_status,fulfillment_status,currency,current_total_price,total_price,customer,email,line_items,shipping_address,note,fulfillments",
    });
    const result = await shopifyGetAll(sr, `/orders.json?${qs.toString()}`, "orders");
    // read_orders scope missing (or older than 60 days without read_all_orders) → surface, don't 500
    if (!result.ok) return res.status(400).json({ error: result.error, store_key: store_key || "" });
    const orders = (result.rows || []).map(o => {
      const addr = o.shipping_address || {};
      const cust = o.customer || {};
      const li   = o.line_items || [];
      const first = li[0] || {};
      const fulfilments = o.fulfillments || [];
      const track   = fulfilments.map(f => f.tracking_number).filter(Boolean)[0] || "";
      const carrier = fulfilments.map(f => f.tracking_company).filter(Boolean)[0] || "";
      const fulfilled = o.fulfillment_status === "fulfilled" || o.fulfillment_status === "partial";
      return {
        orderId: String(o.id),
        name: o.name || `#${o.order_number}`,
        order_number: o.order_number,
        created: o.created_at || o.processed_at || "",
        cancelled_at: o.cancelled_at || "",
        financial_status: o.financial_status || "",
        fulfillment_status: o.fulfillment_status || "",
        fulfilled,
        currency: o.currency || "USD",
        total: +(o.current_total_price ?? o.total_price ?? 0),
        buyer: [cust.first_name, cust.last_name].filter(Boolean).join(" ") || addr.name || "",
        email: o.email || cust.email || "",
        title: first.title || "",
        sku: first.sku || "",
        qty: li.reduce((s, l) => s + (+l.quantity || 0), 0) || 1,
        variant: first.variant_title || "",
        productId: first.product_id ? String(first.product_id) : "",
        image: "",
        items: li.map(l => ({ title: l.title, sku: l.sku || "", qty: l.quantity, price: +l.price || 0, variant: l.variant_title || "" })),
        ship: {
          name: addr.name || "", address1: addr.address1 || "", address2: addr.address2 || "",
          city: addr.city || "", province: addr.province || "", zip: addr.zip || "",
          country: addr.country_code || addr.country || "", phone: addr.phone || "",
        },
        note: o.note || "",
        tracking_number: track,
        carrier_name: carrier,
      };
    });
    // Shopify order line items carry no image, so the order thumbnail comes back blank.
    // Fetch each first-item product's image in one bulk call and attach it.
    const productIds = [...new Set(orders.map(o => o.productId).filter(Boolean))].slice(0, 250);
    if (productIds.length) {
      const pQs = new URLSearchParams({ ids: productIds.join(","), fields: "id,image,images", limit: "250" });
      const pRes = await sr("GET", `/products.json?${pQs.toString()}`);
      if (pRes.ok) {
        const imgById = {};
        for (const p of (pRes.data?.products || [])) imgById[String(p.id)] = p.image?.src || p.images?.[0]?.src || "";
        for (const o of orders) if (o.productId && imgById[o.productId]) o.image = imgById[o.productId];
      }
    }
    return res.json({ success: true, shop: SHOP, store_key: store_key || "", results: orders });
  }

  if (action === "fulfill_order") {
    // Marks a Shopify order fulfilled with tracking (Step 1 "Ship" for Shopify stores).
    // Modern flow: list the order's fulfillment orders, then create a fulfillment
    // against the open one(s), optionally notifying the customer.
    const orderId = String(body.order_id || body.orderId || "").replace(/[^0-9]/g, "");
    if (!orderId) return res.status(400).json({ error: "order_id required" });
    const foRes = await sr("GET", `/orders/${orderId}/fulfillment_orders.json`);
    if (!foRes.ok) return res.status(400).json({ error: foRes.error || "Could not read fulfillment orders", store_key: store_key || "" });
    const openFOs = (foRes.data?.fulfillment_orders || []).filter(fo => ["open", "in_progress", "scheduled"].includes(fo.status));
    if (!openFOs.length) return res.json({ success: true, already_fulfilled: true, store_key: store_key || "" });
    const trackingInfo = {};
    if (body.tracking_number) trackingInfo.number  = String(body.tracking_number);
    if (body.tracking_company) trackingInfo.company = String(body.tracking_company);
    if (body.tracking_url)    trackingInfo.url     = String(body.tracking_url);
    const payload = {
      fulfillment: {
        line_items_by_fulfillment_order: openFOs.map(fo => ({ fulfillment_order_id: fo.id })),
        notify_customer: body.notify !== false,
        ...(Object.keys(trackingInfo).length ? { tracking_info: trackingInfo } : {}),
      },
    };
    const fRes = await sr("POST", `/fulfillments.json`, payload);
    if (!fRes.ok) return res.status(400).json({ error: fRes.error || "Fulfillment failed", store_key: store_key || "" });
    const f = fRes.data?.fulfillment || {};
    return res.json({
      success: true,
      store_key: store_key || "",
      fulfillment_id: f.id || null,
      status: f.status || "",
      tracking_number: f.tracking_number || body.tracking_number || "",
      tracking_url: (f.tracking_urls && f.tracking_urls[0]) || body.tracking_url || "",
    });
  }

  if (action === "list_products") {
    const cleanLimit = Math.min(Math.max(parseInt(limit, 10) || 250, 1), 250);
    const qs = new URLSearchParams({
      limit: String(cleanLimit),
      fields: "id,title,handle,body_html,product_type,tags,images,image,variants,status,created_at,updated_at,admin_graphql_api_id",
    });
    if (status && status !== "any" && status !== "all") qs.set("status", status);
    let collections = [];
    try {
      // Paginate both collection types — a single 250 page dropped collections
      // (e.g. smart collections like "Mini Hearts") on stores with many categories.
      const [custom, smart] = await Promise.all([
        shopifyGetAll(sr, "/custom_collections.json?limit=250&fields=id,title,handle", "custom_collections"),
        shopifyGetAll(sr, "/smart_collections.json?limit=250&fields=id,title,handle", "smart_collections"),
      ]);
      collections = [
        ...(custom.ok ? custom.rows || [] : []),
        ...(smart.ok ? smart.rows || [] : []),
      ].map(c => ({ id: String(c.id), title: c.title || "", handle: c.handle || "" }))
       .sort((a, b) => a.title.localeCompare(b.title));
    } catch (_) {}

    const productPath = collection_id
      ? `/collections/${encodeURIComponent(collection_id)}/products.json?${qs.toString()}`
      : `/products.json?${qs.toString()}`;
    const result = await shopifyGetAll(sr, productPath, "products");
    if (!result.ok) return res.status(400).json({ error: result.error });
    const products = result.rows || [];
    const byProduct = {};
    if (collection_id) {
      products.forEach(p => { byProduct[String(p.id)] = [String(collection_id)]; });
    }
    const productList = products.map(p => ({ ...p, collection_ids: byProduct[String(p.id)] || [] }));
    return res.json({
      success: true,
      shop: SHOP,
      publicUrl: process.env.SHOPIFY_EARTH_PUBLIC_URL || process.env.SHOPIFY_PUBLIC_URL || `https://${SHOP}`,
      products: productList,
      collections,
      collection_id: collection_id ? String(collection_id) : "",
    });
  }

  if (action === "bulk_tag") {
    // Add and/or remove tags across many products, touching ONLY the tags field
    // (fetch current tags, merge, PUT) so nothing else on the product is disturbed.
    const ids  = [...new Set((body.product_ids || []).map(String).filter(Boolean))].slice(0, 100);
    const addT = String(body.add_tags || "").split(",").map(t => t.trim()).filter(Boolean);
    const rmT  = String(body.remove_tags || "").split(",").map(t => t.trim()).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: "No products selected" });
    if (!addT.length && !rmT.length) return res.status(400).json({ error: "No tags to add or remove" });
    const rmLower = new Set(rmT.map(t => t.toLowerCase()));
    const results = [];
    for (const id of ids) {
      const g = await sr("GET", `/products/${id}.json?fields=id,tags`);
      if (!g.ok) { results.push({ id, ok: false, error: g.error }); continue; }
      const cur = String(g.data?.product?.tags || "").split(",").map(t => t.trim()).filter(Boolean);
      const seen = new Set(cur.map(t => t.toLowerCase()));
      let next = cur.filter(t => !rmLower.has(t.toLowerCase()));
      for (const t of addT) if (!seen.has(t.toLowerCase())) { next.push(t); seen.add(t.toLowerCase()); }
      const p = await sr("PUT", `/products/${id}.json`, { product: { id: Number(id), tags: next.join(", ") } });
      results.push({ id, ok: p.ok, tags: p.ok ? (p.data?.product?.tags || "") : "", error: p.ok ? "" : p.error });
    }
    const updated = results.filter(r => r.ok).length;
    return res.json({ success: true, updated, total: ids.length, results });
  }

  if (action === "bulk_delete") {
    // Permanently delete products from the store (used by the store view's bulk bar).
    const ids = [...new Set((body.product_ids || []).map(String).filter(Boolean))].slice(0, 100);
    if (!ids.length) return res.status(400).json({ error: "No products selected" });
    const results = [];
    for (const id of ids) {
      const r = await sr("DELETE", `/products/${id}.json`);
      results.push({ id, ok: r.ok, error: r.ok ? "" : r.error });
    }
    return res.json({ success: true, deleted: results.filter(r => r.ok).length, total: ids.length, results });
  }

  if (action === "add_to_deals" || action === "remove_from_deals") {
    // Add/remove existing products to the store's "Deals" collection (the daily-deals
    // section). Used by the ERP store view's "Add to Deals" flow + the expiry popup.
    const ids = [...new Set((body.product_ids || []).map(String).filter(Boolean))].slice(0, 100);
    if (!ids.length) return res.status(400).json({ error: "No products selected" });
    const cr = await sr("GET", "/custom_collections.json?title=Deals&limit=1");
    const collection = cr.ok ? cr.data?.custom_collections?.[0] : null;
    if (!collection) return res.status(400).json({ error: "Deals collection not found on this store" });
    const results = [];
    for (const id of ids) {
      try {
        if (action === "add_to_deals") {
          // Skip if already collected, so re-adding doesn't error/duplicate.
          const fr = await sr("GET", `/collects.json?product_id=${id}&collection_id=${collection.id}&limit=1`);
          if (fr.ok && fr.data?.collects?.[0]) { results.push({ id, ok: true }); continue; }
          const r = await sr("POST", "/collects.json", { collect: { product_id: id, collection_id: collection.id } });
          results.push({ id, ok: r.ok, error: r.ok ? "" : r.error });
        } else {
          const fr = await sr("GET", `/collects.json?product_id=${id}&collection_id=${collection.id}&limit=1`);
          const collect = fr.ok ? fr.data?.collects?.[0] : null;
          if (!collect) { results.push({ id, ok: true }); continue; }
          const dr = await sr("DELETE", `/collects/${collect.id}.json`);
          results.push({ id, ok: dr.ok, error: dr.ok ? "" : dr.error });
        }
      } catch (e) { results.push({ id, ok: false, error: e.message }); }
    }
    return res.json({ success: true, collectionId: String(collection.id), done: results.filter(r => r.ok).length, total: ids.length, results });
  }

  if (action === "update_product") {
    if (!product?.id) return res.status(400).json({ error: "product.id required" });
    const updatePayload = {
      product: {
        id: product.id,
        title: product.title || "",
        body_html: product.body_html || "",
        tags: product.tags || "",
        status: product.status || "active",
        product_type: product.product_type || "",
        variants: product.variant_id ? [{
          id: product.variant_id,
          sku: product.sku || "",
          price: String(product.price || ""),
        }] : undefined,
      },
    };
    if (!updatePayload.product.variants) delete updatePayload.product.variants;
    const result = await sr("PUT", `/products/${product.id}.json`, updatePayload);
    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.json({ success: true, shop: SHOP, product: result.data.product });
  }

  /* ── sync_lot ────────────────────────────────────────────────────────────
     Keeps a lot listing's price, description and publish state in step with the
     stock card, and touches nothing else.

     Deliberately NOT the `update` path below: that one regenerates the title and
     body via an Anthropic call, then deletes and re-uploads every product image,
     re-asserts SEO, metafields and Deals — 12+ calls. Running that on every gram
     sold would churn the gallery and overwrite titles. This is 1-2 calls.

     Two REST details that make or break it:
       • the variant object MUST carry its `id`, or Shopify replaces the variant
         set instead of patching it (the existing bug at the update path), and
       • `inventory_quantity` is ignored on a product PUT, so it is never sent —
         a lot's inventory is the constant 1 set at create time. */
  if (action === "sync_lot") {
    const productId = String(body.product_id || "").trim();
    if (!productId) return res.status(400).json({ error: "product_id required" });

    let variantId = String(body.variant_id || "").trim();
    let inventoryItemId = String(body.inventory_item_id || "").trim();
    let current = null;

    // One lookup when the ids aren't cached yet; also gives current values to diff.
    if (!variantId || body.dry_run) {
      const got = await sr("GET", `/products/${encodeURIComponent(productId)}.json?fields=id,status,body_html,variants`);
      if (!got.ok) return res.status(got.status || 400).json({ error: got.error || "Product not found" });
      const p = got.data?.product || {};
      const v = p.variants?.[0] || {};
      variantId = variantId || String(v.id || "");
      inventoryItemId = inventoryItemId || String(v.inventory_item_id || "");
      current = { body_html: p.body_html || "", price: v.price != null ? String(v.price) : "", status: p.status || "" };
    }
    if (!variantId) return res.status(400).json({ error: "Product has no variant to price" });

    const next = {
      body_html: String(body.body_html ?? ""),
      price: body.price != null && body.price !== "" ? String(body.price) : "",
      status: body.status === "draft" || body.status === "active" ? body.status : "",
    };

    if (body.dry_run) {
      const changed = !!current && (
        current.body_html !== next.body_html ||
        (next.price && String(+current.price) !== String(+next.price)) ||
        (next.status && current.status !== next.status)
      );
      return res.json({ success: true, dry_run: true, current, next, changed, variant_id: variantId, inventory_item_id: inventoryItemId });
    }

    const payload = { product: { id: productId, variants: [{ id: variantId }] } };
    if (body.body_html != null) payload.product.body_html = next.body_html;
    if (next.price) payload.product.variants[0].price = next.price;
    if (next.status) payload.product.status = next.status;

    const put = await sr("PUT", `/products/${encodeURIComponent(productId)}.json`, payload);
    if (!put.ok) return res.status(put.status || 400).json({ error: put.error });

    /* Inventory only on request. Lot mode never asks — which matters, because the
       Earth Editions token lacks write_inventory. Reported, never swallowed. */
    let inventory;
    if (body.inventory != null && inventoryItemId) {
      const loc = await sr("GET", "/locations.json");
      const locationId = loc.ok ? loc.data?.locations?.[0]?.id : null;
      if (!locationId) {
        inventory = { attempted: true, ok: false, error: loc.error || "No location found" };
      } else {
        const setR = await sr("POST", "/inventory_levels/set.json", {
          location_id: locationId, inventory_item_id: inventoryItemId, available: Math.max(0, parseInt(body.inventory, 10) || 0),
        });
        const msg = String(setR.error || "");
        inventory = {
          attempted: true, ok: setR.ok, error: setR.ok ? "" : msg,
          scopeMissing: !setR.ok && (setR.status === 403 || /write_inventory|merchant approval/i.test(msg)),
        };
      }
    }

    const prod = put.data?.product || {};
    return res.json({
      success: true,
      product_id: productId,
      variant_id: variantId,
      inventory_item_id: inventoryItemId,
      status: prod.status || next.status || "",
      price: prod.variants?.[0]?.price ?? next.price,
      ...(inventory ? { inventory } : {}),
    });
  }

  if (!item) return res.status(400).json({ error: "item required" });

  // Title: stock pushes should read "Stone Shape - kg pcs"; AI may clean
  // capitalization/wording, but exact quantities come from stock.
  const requestedTitle = shopifyName || fallbackShopifyTitle(item);
  const availStr = availabilityString(item);

  // AI-generated SEO + tags (runs in parallel with nothing, fast model ~1s)
  const ai = await generateAIContent(item, requestedTitle, availStr);
  const title = ai?.shopifyTitle || requestedTitle;

  // Tags: AI tags merged with structured tags
  const baseTags = [
    item.shape, item.grade, item.origin, item.productType,
    ...(Array.isArray(item.market) ? item.market : [item.market].filter(Boolean)),
    ...(item.tags || []),
  ].filter(Boolean);
  const aiTags = ai?.tags ? ai.tags.split(",").map(t => t.trim()).filter(Boolean) : [];
  const tags = [...new Set([...baseTags, ...aiTags])].join(", ");

  // Description
  const descParts = [];
  if (availStr)         descParts.push(`<strong>Available:</strong> ${availStr}`);
  if (item.grade)       descParts.push(`<strong>Grade:</strong> ${item.grade}`);
  if (item.origin)      descParts.push(`<strong>Origin:</strong> ${item.origin}`);
  if (item.size)        descParts.push(`<strong>Size:</strong> ${item.size}`);
  if (item.notes)       descParts.push(item.notes);
  const bodyHtml = ai?.bodyHtml || descParts.join("<br>");

  // SEO fields — use AI if available, fall back to rule-based
  const seoTitle = ai?.seoTitle || title;
  const seoDesc  = ai?.seoDesc  || [
    item.material, item.shape, item.origin && `from ${item.origin}`,
    item.grade && `${item.grade} grade`, availStr && `${availStr} available`,
  ].filter(Boolean).join(" · ");

  const price = shopifyPrice || item.listPrice || item.price;
  const inventorySource = String(item.unit || "").toLowerCase() === "pcs" ? item.qty
    : String(item.unit2 || "").toLowerCase() === "pcs" ? item.qty2
    : item.qty;
  const qty = Math.max(0, parseInt(inventorySource) || 0);

  if (action === "delete") {
    const productId = item.shopifyProductId;
    if (!productId) return res.status(400).json({ error: "No shopifyProductId" });
    const result = await sr("DELETE", `/products/${productId}.json`);
    if (!result.ok && result.status !== 404) return res.status(400).json({ error: result.error });
    return res.json({ success: true, action: "deleted", shopifyProductId: productId });
  }

  if (action === "create" || !item.shopifyProductId) {
    // Create new product
    const productPayload = {
      product: {
        title,
        body_html: bodyHtml,
        product_type: item.productType || "Crystal",
        tags,
        status: "active",
        variants: [{
          sku: item.sku || item.id,
          inventory_management: "shopify",
          inventory_policy: "deny",
          inventory_quantity: qty,
          ...(price ? { price: String(price) } : {}),
        }],
      },
    };

    const result = await sr("POST", "/products.json", productPayload);
    if (!result.ok) return res.status(400).json({ error: result.error });

    const product = result.data.product;

    // Set inventory quantity (requires location)
    try {
      const locResult = await sr("GET", "/locations.json");
      if (locResult.ok && locResult.data.locations?.length) {
        const locationId = locResult.data.locations[0].id;
        const variantId = product.variants[0]?.inventory_item_id;
        if (variantId) {
          await sr("POST", "/inventory_levels/set.json", {
            location_id: locationId,
            inventory_item_id: variantId,
            available: qty,
          });
        }
      }
    } catch (_) {}

    // Upload photo + video, set SEO + metafields
    await uploadPhoto(sr, product.id, item);
    let videoOk = true; let videoErr = "";
    if (item.video) { try { await pushVideo(SHOP, TOKEN, product.id, item.video); } catch(e) { videoOk = false; videoErr = e.message; } }
    const [, dealRes] = await Promise.all([
      applySEOAndMeta(SHOP, TOKEN, product.id, seoTitle, seoDesc, item),
      addToDealsCollection(SHOP, TOKEN, product.id),
    ]);

    return res.json({
      success: true,
      action: "created",
      shopifyProductId: product.id,
      shopifyUrl: `https://${SHOP}/admin/products/${product.id}`,
      handle: product.handle || "",
      storefrontUrl: product.handle ? `https://${SHOP}/products/${product.handle}` : "",
      dealAdded: !!dealRes?.ok,
      dealError: dealRes?.ok ? undefined : dealRes?.error,
      videoQueued: videoOk && !!item.video,
      videoErr: videoErr || undefined,
    });

  } else {
    // Update existing product
    const productId = item.shopifyProductId;

    const updatePayload = {
      product: {
        id: productId,
        title,
        body_html: bodyHtml,
        product_type: item.productType || "Crystal",
        tags,
        variants: [{
          sku: item.sku || item.id,
          inventory_quantity: qty,
          ...(price ? { price: String(price) } : {}),
        }],
      },
    };

    const result = await sr("PUT", `/products/${productId}.json`, updatePayload);
    if (!result.ok) return res.status(400).json({ error: result.error });

    const product = result.data.product;

    // Update inventory
    try {
      const locResult = await sr("GET", "/locations.json");
      if (locResult.ok && locResult.data.locations?.length) {
        const locationId = locResult.data.locations[0].id;
        const variantInventoryItemId = product.variants[0]?.inventory_item_id;
        if (variantInventoryItemId) {
          await sr("POST", "/inventory_levels/set.json", {
            location_id: locationId,
            inventory_item_id: variantInventoryItemId,
            available: qty,
          });
        }
      }
    } catch (_) {}

    // Upload photo + video, set SEO + metafields
    await uploadPhoto(sr, productId, item);
    let videoOk2 = true; let videoErr2 = "";
    if (item.video) { try { await pushVideo(SHOP, TOKEN, productId, item.video); } catch(e) { videoOk2 = false; videoErr2 = e.message; } }
    const [, dealRes2] = await Promise.all([
      applySEOAndMeta(SHOP, TOKEN, productId, seoTitle, seoDesc, item),
      addToDealsCollection(SHOP, TOKEN, productId),
    ]);

    return res.json({
      success: true,
      action: "updated",
      shopifyProductId: product.id,
      shopifyUrl: `https://${SHOP}/admin/products/${product.id}`,
      handle: product.handle || "",
      storefrontUrl: product.handle ? `https://${SHOP}/products/${product.handle}` : "",
      dealAdded: !!dealRes2?.ok,
      dealError: dealRes2?.ok ? undefined : dealRes2?.error,
      videoQueued: videoOk2 && !!item.video,
      videoErr: videoErr2 || undefined,
    });
  }
}
