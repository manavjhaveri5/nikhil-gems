export const config = { api: { bodyParser: { sizeLimit: "10mb" } } };

// ── Shopify OAuth callback (GET /api/shopify?code=xxx&shop=xxx) ───────────────
const REDIRECT_BASE = "https://project-nine-tan-22.vercel.app";
async function handleOAuthCallback(req, res) {
  const { code, shop, error } = req.query;
  const redir = (err) => res.redirect(`${REDIRECT_BASE}/#shopify-error=${encodeURIComponent(err)}`);
  if (error) return redir("Shopify denied: " + error);
  if (!code || !shop) return redir("Missing code or shop from Shopify callback");
  const clientId     = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return redir("SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET not set in Vercel");
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

async function generateAIContent(item, title, availStr) {
  try {
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
          content: `You are an SEO copywriter for a premium gemstone wholesale business. Given the product details below, generate Shopify SEO content.

Product: ${title}
${details}

Return ONLY valid JSON with these fields:
{
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

async function addToDealsCollection(shop, token, productId) {
  try {
    // Find the "Deals" collection (check both custom and smart)
    const r = await fetch(`https://${shop}/admin/api/2024-04/custom_collections.json?title=Deals&limit=1`, {
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    });
    const data = await r.json();
    const collection = data?.custom_collections?.[0];
    if (!collection) { console.log("Deals collection not found"); return; }
    // Add product to collection
    await fetch(`https://${shop}/admin/api/2024-04/collects.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ collect: { product_id: productId, collection_id: collection.id } }),
    });
  } catch (e) {
    console.error("Add to Deals collection failed:", e.message);
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

async function shopifyReq(shop, token, method, path, body) {
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
  try { data = JSON.parse(text); } catch { return { ok: false, error: text.slice(0, 300) }; }
  if (!r.ok) return { ok: false, error: data?.errors || data?.error || text.slice(0, 300), status: r.status };
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

  if (!SHOP)  return res.status(400).json({ error: "Store domain required" });
  if (!TOKEN) return res.status(400).json({ error: "Shopify access token required" });

  const sr = (method, path, b) => shopifyReq(SHOP, TOKEN, method, path, b);

  if (action === "list_products") {
    const cleanLimit = Math.min(Math.max(parseInt(limit, 10) || 250, 1), 250);
    const qs = new URLSearchParams({
      limit: String(cleanLimit),
      fields: "id,title,handle,body_html,product_type,tags,images,image,variants,status,created_at,updated_at,admin_graphql_api_id",
    });
    if (status && status !== "any" && status !== "all") qs.set("status", status);
    let collections = [];
    try {
      const [custom, smart] = await Promise.all([
        sr("GET", "/custom_collections.json?limit=250&fields=id,title,handle"),
        sr("GET", "/smart_collections.json?limit=250&fields=id,title,handle"),
      ]);
      collections = [
        ...(custom.ok ? custom.data.custom_collections || [] : []),
        ...(smart.ok ? smart.data.smart_collections || [] : []),
      ].map(c => ({ id: String(c.id), title: c.title || "", handle: c.handle || "" }));
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

  if (!item) return res.status(400).json({ error: "item required" });

  // Title: use user-confirmed name from modal, or fallback
  const title = shopifyName || [item.material, item.location ? `#${item.location}` : null].filter(Boolean).join(" — ");

  // Availability string for description
  const avail = [];
  if (item.qty && +item.qty > 0) avail.push(`${item.qty} ${item.unit || "pcs"}`);
  if (item.qty2 && +item.qty2 > 0 && item.unit2 && item.unit2 !== item.unit) avail.push(`${item.qty2} ${item.unit2}`);
  const availStr = avail.join(" / ");

  // AI-generated SEO + tags (runs in parallel with nothing, fast model ~1s)
  const ai = await generateAIContent(item, title, availStr);

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
  const bodyHtml = descParts.join("<br>");

  // SEO fields — use AI if available, fall back to rule-based
  const seoTitle = ai?.seoTitle || title;
  const seoDesc  = ai?.seoDesc  || [
    item.material, item.shape, item.origin && `from ${item.origin}`,
    item.grade && `${item.grade} grade`, availStr && `${availStr} available`,
  ].filter(Boolean).join(" · ");

  const price = shopifyPrice || item.listPrice || item.price;
  const qty = Math.max(0, parseInt(item.qty) || 0);

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
    await Promise.all([
      applySEOAndMeta(SHOP, TOKEN, product.id, seoTitle, seoDesc, item),
      addToDealsCollection(SHOP, TOKEN, product.id),
    ]);

    return res.json({
      success: true,
      action: "created",
      shopifyProductId: product.id,
      shopifyUrl: `https://${SHOP}/admin/products/${product.id}`,
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
    await Promise.all([
      applySEOAndMeta(SHOP, TOKEN, productId, seoTitle, seoDesc, item),
      addToDealsCollection(SHOP, TOKEN, productId),
    ]);

    return res.json({
      success: true,
      action: "updated",
      shopifyProductId: product.id,
      shopifyUrl: `https://${SHOP}/admin/products/${product.id}`,
      videoQueued: videoOk2 && !!item.video,
      videoErr: videoErr2 || undefined,
    });
  }
}
