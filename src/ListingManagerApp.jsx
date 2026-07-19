import { useState, useEffect, useRef } from "react";
import { loadK, loadKFresh, saveK, uid, onCacheRefresh, upsertItemK, deleteItemK } from "./utils.js";
import { uploadToStorage } from "./storageUtils.js";
import { classify } from "./aiClient.js";
import { CUSTOMS_DESCS_KEY, DEFAULT_CUSTOMS_DESCS } from "./DatasetsApp.jsx";

/* Detect a video by URL extension (library entries may also carry mediaType/isVideo) */
const isVideoUrl = u => typeof u === "string" && /\.(mp4|mov|avi|webm|mkv)(\?|$)/i.test(u);

/* ─── theme ──────────────────────────────────────────────────────────────── */
const C = {
  bg:"var(--c-bg)", surface:"var(--c-surface)", card:"var(--c-card)",
  border:"var(--c-border)", borderHi:"var(--c-borderHi)",
  ink:"var(--c-ink)", inkMid:"var(--c-inkMid)", inkFaint:"var(--c-inkFaint)",
  gold:"var(--c-gold)", goldLight:"var(--c-goldLight)",
  green:"var(--c-green)", greenBg:"var(--c-greenBg)",
  red:"var(--c-red)", redBg:"var(--c-redBg)",
  amber:"var(--c-amber)", amberBg:"var(--c-amberBg)",
  blue:"var(--c-blue)", blueBg:"var(--c-blueBg)",
  purple:"#6B3FA0", purpleBg:"#F3EEFF",
};

const mob   = () => window.innerWidth < 700;
const now   = () => new Date().toISOString();

/* ─── storage keys ───────────────────────────────────────────────────────── */
const LIST_KEY   = "ng-listings-v1";
const ORDERS_KEY = "ng-orders-v1";
const STK_KEY    = "ng-stock-v5";
const IMG_KEY    = "ng-image-library-v1";
const AT_INVOICES_KEY = "at-invoices-v1";
const NG_INVOICES_KEY = "ng-invoices-v2";
const NG_BUYERS_KEY   = "ng-buyers-v2";
const SHOPIFY_EARTH_CACHE_KEY = "ng-shopify-earth-products-cache-v1";
const isLocalMediaUrl = url => typeof url === "string" && (url.startsWith("data:") || url.startsWith("blob:"));

const toIsoDate = value => {
  if (!value) return new Date().toISOString().slice(0, 10);
  if (typeof value === "number") return new Date(value * 1000).toISOString().slice(0, 10);
  const d = new Date(String(value).length <= 10 ? `${value}T12:00:00` : value);
  return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
};

const fiscalYearLabel = dateStr => {
  const d = new Date(`${dateStr || toIsoDate()}T12:00:00`);
  const y = d.getFullYear();
  const start = d.getMonth() >= 3 ? y : y - 1;
  return `${String(start).slice(-2)}-${String(start + 1).slice(-2)}`;
};

const nextAtyaharaInvoiceNo = (existing = [], dateStr = toIsoDate()) => {
  const fy = fiscalYearLabel(dateStr);
  const max = (existing || []).reduce((mx, inv) => {
    const no = String(inv?.invNo || inv?.number || "");
    const m = no.match(/(?:ATY?|AT)-?(\d+)/i) || no.match(/(\d+)/);
    return m ? Math.max(mx, +m[1] || 0) : mx;
  }, 0);
  return `AT-${String(max + 1).padStart(3, "0")}/${fy}`;
};

const moneyAmount = m => (m?.amount || 0) / (m?.divisor || 100);
const cleanInvoiceText = v => String(v || "").replace(/\s+/g, " ").trim();

/* ── Etsy receipt money ────────────────────────────────────────────────────────
   Etsy line prices are PRE-discount; shop coupons live on the receipt as
   discount_amt. Recording the raw line price overstated every discounted sale
   (e.g. listed ₹9,385, buyer actually paid ₹7,039 after a 25% coupon). Allocate
   the receipt discount across lines by value so per-row sale_price is what the
   buyer really paid for that item (ex shipping/tax). */
function etsyReceiptLineMoney(receipt, txn, txns) {
  const receiptLevel = {
    order_subtotal: Number(moneyAmount(receipt?.subtotal).toFixed(2)),
    order_shipping: Number(moneyAmount(receipt?.total_shipping_cost).toFixed(2)),
    order_tax:      Number((moneyAmount(receipt?.total_tax_cost) + moneyAmount(receipt?.total_vat_cost)).toFixed(2)),
    order_total:    Number(moneyAmount(receipt?.grandtotal).toFixed(2)),
  };
  const discountTotal = moneyAmount(receipt?.discount_amt);
  if (!txn?.price) {
    // No transaction detail — receipt subtotal is already post-discount, so use it
    // directly rather than re-subtracting the coupon from it.
    const paid = moneyAmount(receipt?.subtotal) || moneyAmount(receipt?.grandtotal);
    return {
      qty: 1,
      list_price: Number((paid + discountTotal).toFixed(2)),
      discount: Number(discountTotal.toFixed(2)),
      sale_price: Number(paid.toFixed(2)),
      ...receiptLevel,
    };
  }
  const lineOf = t => t?.price ? moneyAmount(t.price) * (t.quantity || 1) : 0;
  const sumLines = (txns || []).filter(Boolean).reduce((s, t) => s + lineOf(t), 0);
  const lineTotal = lineOf(txn);
  const share = sumLines > 0 ? lineTotal / sumLines : 1;
  const discount = Number((discountTotal * share).toFixed(2));
  return {
    qty:        Math.max(1, +(txn?.quantity || 1)),
    list_price: Number(lineTotal.toFixed(2)),
    discount,
    sale_price: Number(Math.max(0, lineTotal - discount).toFixed(2)),
    ...receiptLevel,
  };
}

/* ── Customs descriptions by shape ─────────────────────────────────────────────
   The Datasets tab maps shapes → customs/bill descriptions + HSN. Invoice lines
   should carry that customs description (what actually goes on the export bill),
   not the marketing title. A row's `shape` cell may hold several comma-separated
   shapes sharing one description. */
async function loadCustomsShapeTokens() {
  const rows = await loadKFresh(CUSTOMS_DESCS_KEY).catch(() => null);
  const source = Array.isArray(rows) && rows.length ? rows : DEFAULT_CUSTOMS_DESCS;
  return source.flatMap(r =>
    String(r.shape || "").split(",").map(s => s.trim()).filter(Boolean)
      .map(shape => ({ shape, desc: cleanInvoiceText(r.desc), hsn: cleanInvoiceText(r.hsn) || "71031029" }))
  );
}
const findShapeToken = (tokens, shape) => {
  const want = String(shape || "").trim().toLowerCase();
  if (!want) return null;
  return tokens.find(t => t.shape.toLowerCase() === want)
    || tokens.find(t => t.shape.toLowerCase().replace(/s$/, "") === want.replace(/s$/, ""))
    || null;
};
// Local title match — longest shape name wins ("Palmstone" beats "Stone"); tolerate
// simple plural/singular drift (Geodes/Geode, Points/Point, Carvings/Carving).
const matchShapeInTitle = (tokens, title) => {
  const t = ` ${String(title || "").toLowerCase()} `;
  let best = null;
  for (const tok of tokens) {
    const name = tok.shape.toLowerCase();
    const variants = [name, name.replace(/s$/, ""), `${name}s`];
    if (variants.some(v => v.length >= 3 && new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t))) {
      if (!best || name.length > best.shape.length) best = tok;
    }
  }
  return best;
};

async function aiEnhanceInvoiceItems(baseItems, context = {}, shapeTokens = []) {
  if (!baseItems.length) return baseItems;
  // Resolve each line's shape first: explicit shape on the order row, then a local
  // title match against the customs table. Only unresolved lines go to AI.
  const resolved = baseItems.map(item => {
    const token = findShapeToken(shapeTokens, item._shape) || matchShapeInTitle(shapeTokens, item._title || item.desc);
    return { item, token };
  });
  const needAi = resolved.filter(r => !r.token);
  let byId = {};
  if (needAi.length) {
    try {
      const shapeList = [...new Set(shapeTokens.map(t => t.shape))];
      const prompt = `Return only JSON. Clean these Etsy order lines for a commercial invoice for Atyahara.
For each input item return: shape, desc, hsn, unit.
"shape" MUST be exactly one value from this list (pick the best match for the product title) or "" if none fits: ${JSON.stringify(shapeList)}.
Use concise export-safe descriptions for crystals/gemstones.
Default HSN should be 71031029 unless the title clearly indicates a different gemstone/mineral code.
Default unit should be pcs unless quantity/description clearly indicates kg, g, ct, strand, pair, or set.
Context: ${JSON.stringify(context)}
Items: ${JSON.stringify(needAi.map(({ item: i }) => ({ id: i.id, title: i._title || i.desc, sku: i.sku, qty: i.qty })))}
Schema: {"items":[{"id":"same id","shape":"shape from list or empty","desc":"clean description","hsn":"HSN code","unit":"unit"}]}`;
      const raw = await classify(prompt, 900);
      const json = JSON.parse(String(raw || "").replace(/^```json\s*/i, "").replace(/```$/i, "").trim());
      byId = Object.fromEntries((json.items || []).map(i => [String(i.id), i]));
    } catch {}
  }
  return resolved.map(({ item, token }) => {
    const ai = byId[String(item.id)] || {};
    const aiToken = token ? null : findShapeToken(shapeTokens, ai.shape);
    const finalToken = token || aiToken;
    if (finalToken) {
      // Shape known → the customs table is authoritative for description + HSN.
      return {
        ...item,
        desc: finalToken.desc || item.desc,
        hsn: finalToken.hsn || item.hsn,
        unit: cleanInvoiceText(ai.unit) || item.unit,
        _shape: finalToken.shape,
        _aiAutofilled: !!aiToken,
      };
    }
    return {
      ...item,
      desc: cleanInvoiceText(ai.desc) || item.desc,
      hsn: cleanInvoiceText(ai.hsn) || item.hsn,
      unit: cleanInvoiceText(ai.unit) || item.unit,
      _aiAutofilled: !!byId[String(item.id)],
    };
  });
}

async function upsertAtyaharaInvoiceFromEtsy({ receiptId, orderDate, buyer = {}, address = {}, currency = "USD", items = [], notes = "", shippingCost = null }) {
  const sourceReceiptId = String(receiptId || "");
  if (!sourceReceiptId) throw new Error("Missing Etsy receipt id");
  const fresh = await loadKFresh(AT_INVOICES_KEY).catch(() => []);
  const existing = Array.isArray(fresh) ? fresh : [];
  const existingInv = existing.find(inv =>
    String(inv._etsyReceiptId || inv.etsy_receipt_id || "") === sourceReceiptId ||
    (inv.sourceOrderIds || []).some(id => String(id) === sourceReceiptId)
  );

  const date = toIsoDate(orderDate);
  const shapeTokens = await loadCustomsShapeTokens();
  const invoiceItems = await aiEnhanceInvoiceItems(items, { receiptId: sourceReceiptId, buyerCountry: buyer.country || address.country || "" }, shapeTokens);
  const totalAmt = Number(invoiceItems.reduce((s, item) => s + (+item.qty || 0) * (+item.rate || 0), 0).toFixed(2));
  const nowIso = new Date().toISOString();
  const invoice = {
    ...(existingInv || {}),
    id: existingInv?.id || `at-etsy-${sourceReceiptId}`,
    invNo: existingInv?.invNo || nextAtyaharaInvoiceNo(existing, date),
    type: existingInv?.type || "commercial",
    date,
    dueDate: existingInv?.dueDate || date,
    buyerId: existingInv?.buyerId || "",
    buyerName: buyer.name || existingInv?.buyerName || "Etsy Buyer",
    buyerEmail: buyer.email || existingInv?.buyerEmail || "",
    buyerCountry: buyer.country || address.country || existingInv?.buyerCountry || "",
    consigneeSameAsBuyer: true,
    consigneeName: address.name || buyer.name || existingInv?.consigneeName || "",
    consigneeAddress: [address.line1, address.line2, [address.city, address.state, address.postcode].filter(Boolean).join(", "), address.country].filter(Boolean).join("\n"),
    consigneeCountry: address.country || buyer.country || existingInv?.consigneeCountry || "",
    currency,
    portLading: existingInv?.portLading || "Mumbai, India",
    portDischarge: existingInv?.portDischarge || "",
    terms: existingInv?.terms || "Etsy order",
    items: invoiceItems,
    totalAmt,
    shippingCost: shippingCost != null ? shippingCost : (existingInv?.shippingCost || 0),
    notes: notes || `Etsy order #${sourceReceiptId}`,
    status: existingInv?.status || "draft",
    paidAmount: existingInv?.paidAmount || 0,
    payments: existingInv?.payments || [],
    source: "listing-manager-etsy",
    sourceOrderIds: [sourceReceiptId],
    _etsyReceiptId: sourceReceiptId,
    _aiAutofilled: invoiceItems.some(i => i._aiAutofilled),
    createdAt: existingInv?.createdAt || nowIso,
    updatedAt: nowIso,
  };
  await upsertItemK(AT_INVOICES_KEY, invoice, { prepend: !existingInv });
  return { invoice, updated: !!existingInv };
}

/* ── Inter-company: Atyahara buys the goods from Nikhil Gems ────────────────────
   The Etsy sale is invoiced to the buyer under Atyahara (above). The physical
   stock, though, belongs to Nikhil Gems — so the same goods flow through an NG
   sales invoice where the *buyer is Atyahara*, exactly like the Quick Sell widget
   (deduct NG stock, append a line to a rolling draft invoice for that buyer).
   Line rate defaults to the stock item's cost price; currency is INR (domestic
   NG → Atyahara transfer). Idempotent per order via the caller's _ngInvoiceNo flag. */
async function addOrderToNikhilGemsInvoice({ order, stockItem, qty, qty2 }) {
  const q = Math.max(1, +qty || 1);
  const q2 = Math.max(0, +qty2 || 0);
  if (!stockItem?.id) throw new Error("Link a physical stock item first");

  // 1. Deduct physical stock — fresh read so quantities stay accurate under concurrent edits.
  const stock = (await loadKFresh(STK_KEY).catch(() => [])) || [];
  const target = stock.find(s => s.id === stockItem.id);
  if (!target) throw new Error("Linked stock item no longer exists");
  const remaining = +parseFloat(Math.max(0, (+target.qty || 0) - q).toFixed(4));
  const hasQty2 = String(target.qty2 || "").trim() !== "";
  const remaining2 = hasQty2 ? +parseFloat(Math.max(0, (+target.qty2 || 0) - q2).toFixed(4)) : null;
  const nextStock = stock.map(s => s.id === target.id ? {
    ...s,
    qty: String(remaining),
    ...(hasQty2 ? { qty2: String(remaining2) } : {}),
    updatedAt: new Date().toISOString(),
  } : s);
  await saveK(STK_KEY, nextStock);

  // 2. Ensure the fixed "Atyahara" buyer exists in NG books.
  const buyers = (await loadKFresh(NG_BUYERS_KEY).catch(() => [])) || [];
  let buyer = buyers.find(b => String(b.name || "").trim().toLowerCase() === "atyahara");
  if (!buyer) {
    buyer = { id: uid(), name: "Atyahara", contactName: "", billingAddress: "", shippingAddress: "", shippingSameAsBilling: true, country: "India", state: "", email: "", phone: "", port: "", notes: "Auto-created for Etsy inter-company sales" };
    await saveK(NG_BUYERS_KEY, [buyer, ...buyers]);
  }

  // 3. Build the line — customs/bill description keyed off the stock item's shape.
  const shapeTokens = await loadCustomsShapeTokens();
  const shape = stockItem.shape || order.listing_shape || "";
  const token = findShapeToken(shapeTokens, shape) || matchShapeInTitle(shapeTokens, order.listing_title || "");
  const rate = stockItem.costPrice !== "" && stockItem.costPrice != null ? +stockItem.costPrice : 0;
  const receiptId = String(order.etsy_receipt_id || order.platform_order_id || "");
  const line = {
    id: uid(),
    acctDesc: token?.desc || "",
    customDesc: [stockItem.material, stockItem.shape, stockItem.origin, stockItem.size].filter(Boolean).join(" · "),
    hsn: token?.hsn || "71031029",
    qty: String(q),
    unit: stockItem.unit || "pcs",
    rate: String(rate || ""),
    igst: 0,
    amt: Number((q * (rate || 0)).toFixed(2)),
    stockId: stockItem.id,
    acctStockId: "",
    ready: false,
    readyDate: "",
    _sourceOrderId: order.id,
    _etsyReceiptId: receiptId,
  };

  // 4. Append to the rolling Atyahara inter-co draft (or open a new one) — Quick Sell style.
  const invoices = (await loadKFresh(NG_INVOICES_KEY).catch(() => [])) || [];
  const rolling = invoices.find(i => i.buyerId === buyer.id && i.status === "draft" && i._etsyInterco);
  let invoice, isNew = false;
  if (rolling) {
    const items = [...(rolling.items || []), line];
    invoice = { ...rolling, items, totalAmt: Number(items.reduce((s, it) => s + (+it.qty || 0) * (+it.rate || 0), 0).toFixed(2)), updatedAt: new Date().toISOString() };
  } else {
    isNew = true;
    const maxNo = invoices.reduce((mx, inv) => { const m = (inv.invNo || "").match(/(\d+)/); return m ? Math.max(mx, +m[1]) : mx; }, 0);
    invoice = {
      id: uid(), invNo: `NG-${String(maxNo + 1).padStart(3, "0")}`, type: "commercial",
      date: new Date().toISOString().slice(0, 10),
      dueDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
      buyerId: buyer.id, consigneeId: "", consigneeSameAsBuyer: true,
      consigneeName: "", consigneeAddress: "", consigneeCountry: "",
      currency: "INR", portLading: "Mumbai, India", portDischarge: "",
      terms: "Inter-company transfer",
      items: [line], shippingCost: 0, notes: "Atyahara Etsy sales — goods purchased from Nikhil Gems.",
      status: "draft", paidAmount: 0, payments: [],
      goodsShipped: false, attachments: [],
      totalAmt: Number((q * (rate || 0)).toFixed(2)),
      _etsyInterco: true,
      createdAt: new Date().toISOString(),
    };
  }
  await upsertItemK(NG_INVOICES_KEY, invoice, { prepend: isNew });
  return { invNo: invoice.invNo, deductedQty: q, deductedQty2: q2, remaining, remaining2, rate };
}

async function mediaUrlToFile(url, fallbackName) {
  const res = await fetch(url);
  const blob = await res.blob();
  const mime = blob.type || "application/octet-stream";
  const ext = (mime.split("/")[1] || "bin").replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
  return new File([blob], `${fallbackName}.${ext}`, { type: mime });
}

async function persistListingMedia(listing) {
  const images = Array.isArray(listing.images) ? listing.images : [];
  const nextImages = await Promise.all(images.map(async (url, i) => {
    if (!isLocalMediaUrl(url)) return url;
    const file = await mediaUrlToFile(url, `listing-${listing.id || uid()}-${i}`);
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    return uploadToStorage(`listing-photos/${listing.id || uid()}-${i}-${Date.now()}.${ext}`, file);
  }));

  let video = listing.video || "";
  if (isLocalMediaUrl(video)) {
    const file = await mediaUrlToFile(video, `listing-${listing.id || uid()}-video`);
    const ext = (file.name.split(".").pop() || "mp4").toLowerCase();
    video = await uploadToStorage(`listing-videos/${listing.id || uid()}-${Date.now()}.${ext}`, file);
  }

  return { ...listing, images: nextImages, video };
}

/* ─── Etsy token (shared) ─────────────────────────────────────────────────────
   Etsy access tokens expire hourly. Always resolve a FRESH token before calling
   /api/etsy: use the local token only if still valid, else refresh it, else pull
   the shared session from Supabase. Uses no React state so any component can call it. */
const getEtsyToken = async () => {
  try {
    const sess = JSON.parse(localStorage.getItem("etsy-session") || "{}");
    if (sess.access_token && sess.expiry > Date.now() + 60000) return sess.access_token;

    const rt = sess.refresh_token || localStorage.getItem("etsy-refresh");
    if (rt) {
      const r = await fetch("/api/etsy-auth?action=refresh", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: rt }),
      });
      if (r.ok) {
        const d = await r.json();
        if (d.access_token) {
          const newSess = { access_token: d.access_token, refresh_token: d.refresh_token || rt, expiry: Date.now() + (d.expires_in || 3600) * 1000 - 120000 };
          localStorage.setItem("etsy-session", JSON.stringify(newSess));
          if (d.refresh_token) localStorage.setItem("etsy-refresh", d.refresh_token);
          return d.access_token;
        }
      }
    }

    const sr = await fetch("/api/etsy-auth?action=get-session");
    if (sr.ok) {
      const sd = await sr.json();
      if (sd.access_token) {
        const newSess = { access_token: sd.access_token, refresh_token: sd.refresh_token, expiry: Date.now() + (sd.expires_in || 3600) * 1000 - 120000 };
        localStorage.setItem("etsy-session", JSON.stringify(newSess));
        if (sd.refresh_token) localStorage.setItem("etsy-refresh", sd.refresh_token);
        return sd.access_token;
      }
    }
    return null;
  } catch { return null; }
};

const clearLocalEtsySession = () => {
  try {
    localStorage.removeItem("etsy-session");
    localStorage.removeItem("etsy-refresh");
  } catch {}
};

const reconnectEtsy = async () => {
  clearLocalEtsySession();
  await fetch("/api/etsy-auth?action=invalidate").catch(() => {});
  window.open("/api/etsy-auth?action=start", "_blank");
};

const needsEtsyReconnect = msg => /reconnect|permission|transactions_w|scope|forbidden|re-?authori/i.test(String(msg || ""));

/* ─── platform config ────────────────────────────────────────────────────── */
const PLATFORMS = [
  { key:"etsy",          label:"Etsy",         icon:"🏷️", color:"#F56400", priceField:"price_etsy",         currency:"INR" },
  { key:"shopify_earth", label:"Earth Ed.",    icon:"🌍", color:"#2A6845", priceField:"price_shopify_earth", currency:"USD" },
  // Atyahara Shopify store removed for now — re-add to bring back its tab, toggles and pricing.
  // { key:"shopify_aty",   label:"Atyahara",     icon:"💫", color:"#6B3FA0", priceField:"price_shopify_aty",  currency:"INR" },
  { key:"ebay",          label:"eBay",         icon:"🔨", color:"#0064D2", priceField:"price_ebay",          currency:"USD" },
];

const SHAPES = [
  "Sphere","Heart","Palmstone","Tower","Tumbled","Bracelet","Pendant","Pendulum",
  "Bowl - 2 inch","Bowl - 3 inch","Bowl - 4 inch","Bowl - 5 inch","Bowl - 6 inch","Bowl - 7 inch",
  "Rough","Mineral","Egg","Skull","Pyramid","Chips","Freeform","Set","Mala","Wand","Point","Slab","Other",
];

const MATERIALS = [
  "Clear Quartz","Amethyst","Rose Quartz","Citrine","Labradorite","Lapis Lazuli",
  "Malachite","Obsidian","Moonstone","Tiger Eye","Fluorite","Selenite","Black Tourmaline",
  "Pyrite","Rhodonite","Amazonite","Aventurine","Carnelian","Garnet","Sodalite","Other",
];

const PRODUCT_TYPES = ["Lapidary","Carvings","Jewellery","Healing/Reiki","Decor","Mineral","Rough"];

// Etsy category presets — each maps to the shape + productType the API needs
const ETSY_CATEGORIES = [
  { value:"metaphysical", label:"Metaphysical Crystals",   shape:"Mineral",        productType:"Lapidary"      },
  { value:"rocks_geodes", label:"Rocks & Geodes",          shape:"Specimen",       productType:"Mineral"       },
  { value:"spheres",      label:"Crystal Spheres",          shape:"Sphere",         productType:"Lapidary"      },
  { value:"hearts",       label:"Crystal Hearts",           shape:"Heart",          productType:"Lapidary"      },
  { value:"palmstones",   label:"Palmstones",               shape:"Palmstone",      productType:"Lapidary"      },
  { value:"towers",       label:"Towers & Points",          shape:"Tower",          productType:"Lapidary"      },
  { value:"tumbled",      label:"Tumbled Stones",           shape:"Tumbled",        productType:"Lapidary"      },
  { value:"bowls",        label:"Crystal Bowls",            shape:"Bowl - 4 inch",  productType:"Lapidary"      },
  { value:"bracelets",    label:"Bracelets",                shape:"Bracelet",       productType:"Jewellery"     },
  { value:"pendants",     label:"Pendants & Pendulums",     shape:"Pendant",        productType:"Lapidary"      },
  { value:"rough",        label:"Rough Stones",             shape:"Rough",          productType:"Rough"         },
  { value:"carvings",     label:"Carvings & Sculptures",    shape:"Mineral",        productType:"Carvings"      },
  { value:"collector",    label:"Collector's Corner",       shape:"Collector",      productType:"Mineral"       },
];

// Actual shop sections from the Atyahara Etsy shop
const ETSY_SHOP_SECTIONS = [
  { id: null,      label: "— Let category decide —" },
  { id: 58168978,  label: "Collector's Corner" },
  { id: 28345880,  label: "Spheres" },
  { id: 58185469,  label: "Hearts" },
  { id: 30952509,  label: "Palmstones" },
  { id: 28345876,  label: "Bracelets" },
  { id: 58218908,  label: "Ganesha" },
  { id: 30949825,  label: "Gemstone Bowls and More" },
  { id: 30843294,  label: "Pendants & Pendulums" },
  { id: 30692617,  label: "Towers & Freeforms" },
  { id: 50040802,  label: "Chips" },
  { id: 28345870,  label: "Tumbled Stones" },
  { id: 28361899,  label: "Mineral Specimens" },
  { id: 30789512,  label: "Rough Stones" },
  { id: 58326407,  label: "Eggs & Shivas" },
  { id: 30146745,  label: "Wellness" },
];

const USD_RATE = 84; // INR per USD — used by price calculator

/* ─── helpers ────────────────────────────────────────────────────────────── */
function nextOrderNumber(orders) {
  const yr = new Date().getFullYear();
  const count = (orders||[]).filter(o => o.order_number?.startsWith(`NG-${yr}-`)).length;
  return `NG-${yr}-${String(count + 1).padStart(3, "0")}`;
}

function fmt(n) { return Number(n||0).toLocaleString("en-IN"); }

/* ══════════════════════════════════════════════════════════════════════════
   SHARED UI PRIMITIVES
══════════════════════════════════════════════════════════════════════════ */
function FI(extra = {}) {
  return {
    background: C.surface, border: `1.5px solid ${C.border}`, color: C.ink,
    borderRadius: 7, padding: "8px 11px", fontSize: 13, fontFamily: "inherit",
    width: "100%", boxSizing: "border-box", ...extra,
  };
}

function Label({ children, required }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase",
      letterSpacing: .7, color: C.inkFaint, marginBottom: 5 }}>
      {children}{required && <span style={{ color: C.red }}> *</span>}
    </div>
  );
}

function Section({ title, children, accent, action }) {
  return (
    <div style={{ background: C.surface, border: `1.5px solid ${accent || C.border}`, borderRadius: 10, padding: "16px 18px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: .8, color: accent || C.inkFaint }}>{title}</div>
        {action}
      </div>
      {children}
    </div>
  );
}

function Grid({ cols = 2, children }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : `repeat(${cols},1fr)`, gap: 12 }}>
      {children}
    </div>
  );
}

function StatusPill({ status }) {
  const map = {
    active:   { label: "Live",     color: C.green,   bg: C.greenBg },
    draft:    { label: "Draft",    color: C.amber,   bg: C.amberBg },
    deleted:  { label: "Removed",  color: C.red,     bg: C.redBg   },
    inactive: { label: "Inactive", color: C.inkMid,  bg: C.card    },
    sold:     { label: "Sold",     color: C.blue,    bg: C.blueBg  },
    shipped:  { label: "Shipped",  color: C.green,   bg: C.greenBg },
    unshipped:{ label: "Unshipped",color: C.amber,   bg: C.amberBg },
  };
  const s = map[status] || { label: status || "—", color: C.inkFaint, bg: C.card };
  return (
    <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20,
      background: s.bg, color: s.color, border: `1px solid ${s.color}30`,
      letterSpacing: .4, textTransform: "uppercase" }}>
      {s.label}
    </span>
  );
}

function PlatformChip({ pkey, status }) {
  const p = PLATFORMS.find(x => x.key === pkey);
  if (!p) return null;
  const live  = status === "active";
  const draft = status === "draft";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 6,
      border: `1px solid ${live ? p.color + "60" : draft ? "var(--c-amber)60" : C.border}`,
      background: live ? p.color + "15" : draft ? "var(--c-amberBg)" : C.card }}>
      <span style={{ fontSize: 11 }}>{p.icon}</span>
      <span style={{ fontSize: 10, fontWeight: 700,
        color: live ? p.color : draft ? "var(--c-amber)" : C.inkFaint, lineHeight: 1 }}>
        {p.label}{draft ? " draft" : ""}
      </span>
    </div>
  );
}

function Toast({ msg }) {
  if (!msg) return null;
  return (
    <div style={{ position: "fixed", bottom: 28, left: "50%", transform: "translateX(-50%)",
      background: C.ink, color: "#fff", padding: "10px 22px", borderRadius: 10, fontSize: 12,
      zIndex: 9999, boxShadow: "0 8px 28px rgba(0,0,0,.2)", whiteSpace: "nowrap", pointerEvents: "none" }}>
      {msg}
    </div>
  );
}

function Spinner() {
  return (
    <span style={{ display: "inline-block", width: 13, height: 13,
      border: "2px solid currentColor", borderTopColor: "transparent",
      borderRadius: "50%", animation: "lm-spin .6s linear infinite", verticalAlign: "middle" }} />
  );
}

function AiField({ label, value, mono, rows }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard.writeText(value || ""); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <Label>{label}</Label>
        <button onClick={copy} style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 4,
          padding: "2px 8px", fontSize: 10, cursor: "pointer", color: C.inkMid }}>
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      {rows
        ? <textarea readOnly value={value || ""} rows={rows}
            style={{ ...FI({ fontFamily: mono ? "monospace" : "inherit", fontSize: 12 }), resize: "vertical", color: C.inkMid }} />
        : <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 6,
            padding: "8px 10px", fontSize: 12, color: C.inkMid, fontFamily: mono ? "monospace" : "inherit", lineHeight: 1.5 }}>
            {value || "—"}
          </div>
      }
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   IMAGE PICKER  — library matches + new uploads → auto-save to library
══════════════════════════════════════════════════════════════════════════ */
function ImagePicker({ material, shape, selectedUrls, onChange, video, onVideoChange }) {
  const [allLibImages, setAllLibImages] = useState([]);
  const [uploading,    setUploading]    = useState(false);
  const [vidUploading, setVidUploading] = useState(false);
  const [libLoaded,    setLibLoaded]    = useState(false);
  // Library filter state — default to incoming material/shape props
  const [libStone,     setLibStone]     = useState(material || "");
  const [libShape,     setLibShape]     = useState(shape || "");
  const [libText,      setLibText]      = useState("");
  const fileRef = useRef(null);
  const videoRef = useRef(null);
  const dragSrc = useRef(null);

  // Load ALL library images once
  useEffect(() => {
    loadK(IMG_KEY).then(imgs => {
      setAllLibImages(Array.isArray(imgs) ? imgs : []);
      setLibLoaded(true);
    });
  }, []);
  useEffect(() => onCacheRefresh(keys => {
    if (keys.includes(IMG_KEY)) loadK(IMG_KEY).then(imgs => { if (Array.isArray(imgs)) setAllLibImages(imgs); });
  }), []);

  // Sync incoming material/shape when they change (e.g. user picks stone in form)
  useEffect(() => { if (material) setLibStone(material); }, [material]);
  useEffect(() => { if (shape)    setLibShape(shape);     }, [shape]);

  // Filter library — requires at least one filter active
  const hasFilter = libStone || libShape || libText.trim();
  const libImages = !hasFilter ? [] : allLibImages.filter(img => {
    if (libStone && img.name?.toLowerCase() !== libStone.toLowerCase()) return false;
    if (libShape && img.category?.toLowerCase() !== libShape.toLowerCase()) return false;
    if (libText.trim() && !(img.name?.toLowerCase().includes(libText.toLowerCase()) ||
                             img.category?.toLowerCase().includes(libText.toLowerCase()))) return false;
    return true;
  }).slice(0, 60);

  const toggle = url => onChange(
    selectedUrls.includes(url) ? selectedUrls.filter(u => u !== url) : [...selectedUrls, url]
  );

  const handleFiles = async files => {
    if (!files?.length) return;
    setUploading(true);
    const results = await Promise.allSettled(
      Array.from(files).map(file => {
        const ext = file.name.split(".").pop().toLowerCase() || "jpg";
        return uploadToStorage(`listing-photos/${uid()}.${ext}`, file);
      })
    );
    const newUrls = results.filter(r => r.status === "fulfilled").map(r => r.value);
    setUploading(false);
    if (newUrls.length) onChange([...selectedUrls, ...newUrls]);
  };

  // Single listing video — Etsy/eBay each allow one. Uploaded to its own prefix.
  const handleVideoFile = async file => {
    if (!file || !onVideoChange) return;
    setVidUploading(true);
    try {
      const ext = (file.name.split(".").pop() || "mp4").toLowerCase();
      const url = await uploadToStorage(`listing-videos/${uid()}.${ext}`, file);
      onVideoChange(url);
    } catch (e) { /* surfaced by caller toast if needed */ }
    setVidUploading(false);
  };

  // Drag-to-reorder selected thumbnails
  const onImgDragStart = (i, e) => {
    dragSrc.current = i;
    // Some browsers won't begin a drag unless dataTransfer carries something.
    try { e?.dataTransfer?.setData("text/plain", String(i)); if (e?.dataTransfer) e.dataTransfer.effectAllowed = "move"; } catch {}
  };
  const onImgDrop = i => {
    if (dragSrc.current === null || dragSrc.current === i) return;
    const next = [...selectedUrls];
    const [moved] = next.splice(dragSrc.current, 1);
    next.splice(i, 0, moved);
    onChange(next);
    dragSrc.current = null;
  };

  const selSx = { width: "100%", padding: "6px 10px", borderRadius: 7, border: `1.5px solid ${C.border}`,
    fontSize: 12, background: C.card, color: C.ink, outline: "none", cursor: "pointer" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

      {/* ── 1. Upload drop zone (top) ── */}
      <div onDrop={e => { e.preventDefault(); handleFiles(e.dataTransfer.files); }}
        onDragOver={e => e.preventDefault()}
        onClick={() => fileRef.current?.click()}
        style={{ border: `2px dashed ${C.border}`, borderRadius: 8, padding: "14px 12px",
          textAlign: "center", cursor: "pointer", background: C.card }}>
        <input ref={fileRef} type="file" accept="image/*,.heic,.heif" multiple style={{ display: "none" }}
          onChange={e => handleFiles(e.target.files)} />
        {uploading
          ? <div style={{ fontSize: 12, color: C.inkMid, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              <Spinner /> Uploading & saving to library…
            </div>
          : <>
              <div style={{ fontSize: 20, marginBottom: 3 }}>📷</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.inkMid }}>Drop photos or click to upload</div>
              <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 2 }}>Auto-saved to Image Library · JPEG, PNG, WEBP</div>
            </>
        }
      </div>

      {/* ── 2. Selected strip — drag to reorder ── */}
      {selectedUrls.length > 0 && (
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: .6,
            color: C.inkFaint, marginBottom: 6 }}>
            Selected ({selectedUrls.length}) · drag to reorder · first = cover
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            {selectedUrls.map((url, i) => (
              <div key={url + i} draggable
                onDragStart={e => onImgDragStart(i, e)}
                onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
                onDrop={e => { e.preventDefault(); onImgDrop(i); }}
                style={{ width: 72, height: 72, borderRadius: 8, overflow: "hidden", flexShrink: 0, position: "relative",
                  border: `2.5px solid ${i === 0 ? C.gold : C.border}`, cursor: "grab" }}>
                <img src={url} alt="" draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover", pointerEvents: "none" }} />
                {i === 0 && (
                  <div style={{ position: "absolute", top: 3, left: 3, background: C.gold, color: "#fff",
                    borderRadius: 4, fontSize: 8, fontWeight: 700, padding: "1px 5px", letterSpacing: .3 }}>COVER</div>
                )}
                <button onClick={e => { e.stopPropagation(); onChange(selectedUrls.filter((_, j) => j !== i)); }}
                  style={{ position: "absolute", top: 3, right: 3, background: "rgba(0,0,0,.65)", color: "#fff",
                    border: "none", borderRadius: "50%", width: 18, height: 18, cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, lineHeight: 1 }}>×</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── 2b. Listing video (optional) — one per listing (Etsy/eBay) ── */}
      {onVideoChange && (
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: .6,
            color: C.inkFaint, marginBottom: 6 }}>
            Video (optional) · MP4 · one per listing
          </div>
          {video ? (
            <div style={{ position: "relative", width: 120, height: 120, borderRadius: 8, overflow: "hidden",
              border: `2px solid ${C.gold}`, background: "#000" }}>
              <video src={video} muted playsInline preload="metadata" controls
                style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              <button onClick={() => onVideoChange("")}
                style={{ position: "absolute", top: 3, right: 3, background: "rgba(0,0,0,.65)", color: "#fff",
                  border: "none", borderRadius: "50%", width: 18, height: 18, cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, lineHeight: 1 }}>×</button>
            </div>
          ) : (
            <div onClick={() => !vidUploading && videoRef.current?.click()}
              style={{ border: `2px dashed ${C.border}`, borderRadius: 8, padding: "12px",
                textAlign: "center", cursor: vidUploading ? "default" : "pointer", background: C.card }}>
              <input ref={videoRef} type="file" accept="video/*" style={{ display: "none" }}
                onChange={e => { handleVideoFile(e.target.files?.[0]); e.target.value = ""; }} />
              {vidUploading
                ? <div style={{ fontSize: 12, color: C.inkMid, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}><Spinner /> Uploading video…</div>
                : <div style={{ fontSize: 12, fontWeight: 600, color: C.inkMid }}>🎬 Add a video</div>}
            </div>
          )}
        </div>
      )}

      {/* ── 3. From Image Library (bottom) — filter by stone + shape, same as save ── */}
      {libLoaded && (
        <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: .6,
            color: C.inkFaint, marginBottom: 8 }}>
            From Image Library
            <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, marginLeft: 6, color: C.inkFaint }}>
              ({allLibImages.length} saved)
            </span>
          </div>

          {/* Stone + Shape dropdowns — same fields used when saving */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
            <select value={libStone} onChange={e => setLibStone(e.target.value)} style={selSx}>
              <option value="">All stones</option>
              {MATERIALS.map(m => {
                const cnt = allLibImages.filter(i => i.name?.toLowerCase() === m.toLowerCase()).length;
                return cnt > 0 ? <option key={m} value={m}>{m} ({cnt})</option> : null;
              })}
            </select>
            <select value={libShape} onChange={e => setLibShape(e.target.value)} style={selSx}>
              <option value="">All shapes</option>
              {SHAPES.map(s => {
                const cnt = allLibImages.filter(i => i.category?.toLowerCase() === s.toLowerCase()).length;
                return cnt > 0 ? <option key={s} value={s}>{s} ({cnt})</option> : null;
              })}
            </select>
          </div>

          {/* Optional free-text refinement */}
          <input value={libText} onChange={e => setLibText(e.target.value)}
            placeholder="Refine further… (optional)"
            style={{ ...selSx, width: "100%", boxSizing: "border-box", marginBottom: 8 }} />

          {!hasFilter && (
            <div style={{ fontSize: 11, color: C.inkFaint }}>Select a stone or shape to browse your library</div>
          )}
          {hasFilter && libImages.length === 0 && (
            <div style={{ fontSize: 11, color: C.inkFaint }}>No images found — try different filters</div>
          )}
          {libImages.length > 0 && (
            <>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {libImages.map(img => {
                  const isVid = img.mediaType === "video" || img.isVideo || isVideoUrl(img.imageUrl);
                  const sel = isVid ? video === img.imageUrl : selectedUrls.includes(img.imageUrl);
                  const pickVideo = isVid && onVideoChange;
                  return (
                    <div key={img.id} onClick={() => pickVideo ? onVideoChange(sel ? "" : img.imageUrl) : (!isVid && toggle(img.imageUrl))}
                      style={{ width: 62, height: 62, borderRadius: 7, overflow: "hidden", cursor: (pickVideo || !isVid) ? "pointer" : "default", flexShrink: 0,
                        border: `2.5px solid ${sel ? (isVid ? C.gold : C.green) : C.border}`, position: "relative", transition: "border-color .15s", background: isVid ? "#000" : undefined }}>
                      {isVid
                        ? <video src={img.imageUrl} muted playsInline preload="metadata" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                        : <img src={img.imageUrl} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                      {isVid && <div style={{ position: "absolute", top: 2, left: 2, fontSize: 10 }}>🎬</div>}
                      {sel && (
                        <div style={{ position: "absolute", bottom: 2, right: 2, background: isVid ? C.gold : C.green,
                          color: "#fff", borderRadius: "50%", width: 15, height: 15,
                          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700 }}>✓</div>
                      )}
                    </div>
                  );
                })}
              </div>
              {libImages.length === 60 && (
                <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 6 }}>Showing 60 — refine filters to narrow results</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   MARK AS SOLD MODAL
══════════════════════════════════════════════════════════════════════════ */
function MarkSoldModal({ listing, orders, onSave, onClose }) {
  const livePlatforms = PLATFORMS.filter(p => !p.coming && listing.platforms?.[p.key]?.status === "active");

  const [form, setForm] = useState(() => {
    const first = livePlatforms[0];
    return {
      platform:          first?.key || "manual",
      platform_order_id: "",
      sale_price:        first ? (listing[first.priceField] || "") : "",
      buyer_name:        "",
      buyer_country:     "",
      date:              new Date().toISOString().slice(0, 10),
      notes:             "",
    };
  });

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const otherLive = livePlatforms.filter(p => p.key !== form.platform);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: 300,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: C.bg, borderRadius: 14, width: "100%", maxWidth: 520,
        boxShadow: "0 24px 80px rgba(0,0,0,.3)", overflow: "hidden" }}>

        {/* header */}
        <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`,
          padding: "14px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Record Sale</div>
            <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 2 }}>{listing.title}</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: C.inkFaint, fontSize: 20 }}>×</button>
        </div>

        <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
          <Grid cols={2}>
            <div>
              <Label>Platform sold on</Label>
              <select value={form.platform} onChange={e => {
                const key = e.target.value;
                set("platform", key);
                const p = PLATFORMS.find(x => x.key === key);
                if (p) set("sale_price", listing[p.priceField] || "");
              }} style={FI()}>
                {PLATFORMS.filter(p => !p.coming).map(p => (
                  <option key={p.key} value={p.key}>{p.icon} {p.label}</option>
                ))}
                <option value="manual">✏️ Manual / Other</option>
              </select>
            </div>
            <div>
              <Label>Sale price (INR)</Label>
              <input type="number" value={form.sale_price} onChange={e => set("sale_price", e.target.value)}
                style={FI({ fontSize: 15, fontWeight: 700 })} placeholder="0" />
            </div>
            <div>
              <Label>Platform order ID (optional)</Label>
              <input value={form.platform_order_id} onChange={e => set("platform_order_id", e.target.value)}
                style={FI()} placeholder="e.g. 3456789012" />
            </div>
            <div>
              <Label>Date</Label>
              <input type="date" value={form.date} onChange={e => set("date", e.target.value)} style={FI()} />
            </div>
            <div>
              <Label>Buyer name (optional)</Label>
              <input value={form.buyer_name} onChange={e => set("buyer_name", e.target.value)} style={FI()} />
            </div>
            <div>
              <Label>Buyer country (optional)</Label>
              <input value={form.buyer_country} onChange={e => set("buyer_country", e.target.value)}
                style={FI()} placeholder="India, USA…" />
            </div>
          </Grid>
          <div>
            <Label>Notes</Label>
            <textarea value={form.notes} onChange={e => set("notes", e.target.value)}
              rows={2} style={{ ...FI(), resize: "vertical" }} />
          </div>

          {listing.type === "unique" && otherLive.length > 0 && (
            <div style={{ background: C.amberBg, border: `1px solid ${C.amber}50`, borderRadius: 8,
              padding: "10px 14px", fontSize: 12, color: C.ink, lineHeight: 1.5 }}>
              <strong>⚡ Unique item</strong> — will automatically be removed from{" "}
              <strong>{otherLive.map(p => p.label).join(", ")}</strong> after recording this sale.
            </div>
          )}

          {listing.type === "repeatable" && (
            <div style={{ background: C.blueBg, border: `1px solid ${C.blue}30`, borderRadius: 8,
              padding: "10px 14px", fontSize: 12, color: C.ink }}>
              🔁 Repeatable item — remaining stock stays listed on all platforms.
            </div>
          )}
        </div>

        <div style={{ background: C.surface, borderTop: `1px solid ${C.border}`,
          padding: "14px 20px", display: "flex", gap: 10 }}>
          <button onClick={() => onSave(form)}
            style={{ flex: 1, background: C.green, color: "#fff", border: "none", borderRadius: 8,
              padding: "11px 0", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
            ✓ Record Sale
          </button>
          <button onClick={onClose}
            style={{ padding: "11px 20px", background: C.surface, border: `1.5px solid ${C.border}`,
              borderRadius: 8, fontSize: 13, cursor: "pointer", color: C.ink }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   LISTING FORM
══════════════════════════════════════════════════════════════════════════ */
function ListingForm({ initial, stock, onSave, onClose }) {
  const editing = !!initial?.id;

  // Derive initial category from existing shape/productType
  const inferCategory = () => {
    if (!initial) return "metaphysical";
    const hit = ETSY_CATEGORIES.find(c => c.shape === initial.shape);
    return hit ? hit.value : "metaphysical";
  };

  const [form, setForm] = useState(() => {
    const base = initial || {
      id: uid(), title: "", description: "", material: "", shape: "Mineral",
      origin: "", size: "", weight: "", sku: "", productType: "Lapidary",
      type: "unique", qty: 1, linked_stock_id: "", officeLocation: "",
      tags: [], images: [], video: "",
      price_etsy: "", price_shopify_earth: "", price_shopify_aty: "", price_ebay: "",
      platforms: { etsy: {}, shopify_earth: {}, shopify_aty: {}, ebay: {} },
      variations: [], etsy_section_id: null, created_at: now(),
      etsy_shipping_profile_id: null, etsy_return_policy_id: null,
      etsy_auto_renew: false, etsy_ads: false,
    };
    return { ...base, variations: base.variations || [] };
  });

  const [category,    setCategory]    = useState(inferCategory);
  const [tags,        setTags]        = useState(initial?.tags || []);
  const [tagDraft,    setTagDraft]    = useState("");
  const [generating,  setGenerating]  = useState(false);
  const [errors,      setErrors]      = useState({});
  const [publishTo,   setPublishTo]   = useState({});
  const [showOptional,setShowOptional]= useState(false);
  const [etsyShippingProfiles, setEtsyShippingProfiles] = useState([]);
  const [etsyReturnPolicies,   setEtsyReturnPolicies]   = useState([]);

  useEffect(() => {
    fetch("/api/listing-manager?action=get_etsy_settings")
      .then(r => r.json())
      .then(d => {
        if (d.shippingProfiles) setEtsyShippingProfiles(d.shippingProfiles);
        if (d.returnPolicies)   setEtsyReturnPolicies(d.returnPolicies);
      })
      .catch(() => {});
  }, []);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // When category changes, update shape + productType so the API still works
  const applyCategory = val => {
    setCategory(val);
    const cat = ETSY_CATEGORIES.find(c => c.value === val);
    if (cat) setForm(f => ({ ...f, shape: cat.shape, productType: cat.productType }));
  };

  const validate = () => {
    const e = {};
    if (!form.title.trim()) e.title = "Title required";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  // AI: generate description + 13 Etsy tags in one call
  const generateAI = async () => {
    if (!form.title) return;
    setGenerating(true);
    try {
      const r = await fetch("/api/listing-manager", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "ai_generate", listing: { ...form, tags } }),
      });
      const d = await r.json();
      if (d.ai) {
        if (d.ai.etsy_tags?.length)        setTags([...new Set([...tags, ...d.ai.etsy_tags])].slice(0, 13));
        if (d.ai.etsy_description && !form.description) set("description", d.ai.etsy_description);
        set("_ai", d.ai);
      }
    } catch (e) { console.error(e); }
    finally { setGenerating(false); }
  };

  const addTag = raw => {
    const t = raw.trim().toLowerCase();
    if (!t || t.length > 20 || tags.includes(t) || tags.length >= 13) return;
    setTags(prev => [...prev, t]);
    setTagDraft("");
  };

  // Variations helpers — each variation has a name + options array; options carry per-variant
  // price/qty when enabled. price_etsy is ₹ (Etsy), price_shopify is $ (Earth Ed. store) — each
  // marketplace bills in its own currency, so we keep them separate rather than converting.
  const blankVar = () => ({ id: uid(), name: "", perVariantPricing: false, options: [{ id: uid(), label: "", price_etsy: "", price_shopify: "", qty: "" }] });
  const blankOpt = () => ({ id: uid(), label: "", price_etsy: "", price_shopify: "", qty: "" });
  const addVariation  = () => setForm(f => ({ ...f, variations: [...f.variations, blankVar()] }));
  const removeVariation = i => setForm(f => ({ ...f, variations: f.variations.filter((_, j) => j !== i) }));
  const updVar = (i, patch) => setForm(f => { const a = [...f.variations]; a[i] = { ...a[i], ...patch }; return { ...f, variations: a }; });
  const addOpt = i => setForm(f => { const a = [...f.variations]; a[i] = { ...a[i], options: [...a[i].options, blankOpt()] }; return { ...f, variations: a }; });
  const removeOpt = (i, j) => setForm(f => { const a = [...f.variations]; a[i] = { ...a[i], options: a[i].options.filter((_, k) => k !== j) }; return { ...f, variations: a }; });
  const updOpt = (i, j, patch) => setForm(f => {
    const a = [...f.variations]; const opts = [...a[i].options];
    opts[j] = { ...opts[j], ...patch }; a[i] = { ...a[i], options: opts }; return { ...f, variations: a };
  });

  // Price calculator state
  const [calcOpen, setCalcOpen] = useState(null); // platform key
  const [calcCost, setCalcCost] = useState("");
  const [calcMult, setCalcMult] = useState("3");
  const [liveUsdRate, setLiveUsdRate] = useState(USD_RATE);

  useEffect(() => {
    fetch("https://open.er-api.com/v6/latest/USD")
      .then(r => r.json())
      .then(d => { if (d?.rates?.INR) setLiveUsdRate(d.rates.INR); })
      .catch(() => {});
  }, []);

  const handleSave = () => {
    if (!validate()) return;
    onSave({ ...form, tags, _ai: form._ai || null, updated_at: now() }, publishTo);
  };

  const catLabel = ETSY_CATEGORIES.find(c => c.value === category)?.label || "—";

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 200,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: C.bg, borderRadius: 14, width: "100%", maxWidth: 820,
        maxHeight: "95vh", display: "flex", flexDirection: "column", boxShadow: "0 24px 80px rgba(0,0,0,.3)" }}>

        {/* sticky header */}
        <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`,
          padding: "14px 24px", display: "flex", alignItems: "center", gap: 12,
          borderRadius: "14px 14px 0 0", flexShrink: 0 }}>
          <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 20, fontWeight: 700 }}>
            {editing ? "Edit Listing" : "New Listing"}
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={generateAI} disabled={generating || !form.title}
            style={{ background: C.gold, color: "#fff", border: "none", borderRadius: 7,
              padding: "7px 16px", fontSize: 12, fontWeight: 700, cursor: "pointer",
              opacity: generating || !form.title ? .5 : 1 }}>
            {generating ? "✨ Generating…" : "✨ AI Enhance"}
          </button>
          <button onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer", color: C.inkFaint, fontSize: 22, lineHeight: 1 }}>×</button>
        </div>

        {/* scrollable body */}
        <div style={{ overflowY: "auto", flex: 1, padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>

          {/* ── Title + Description ───────────────────────────────────────── */}
          <Section title="Listing Details">
            <div style={{ marginBottom: 12 }}>
              <Label required>Title</Label>
              <input value={form.title} onChange={e => set("title", e.target.value)}
                placeholder="e.g. Alien Amethyst with Hematite — Elestial Specimen from Hyderabad" style={FI()} />
              {errors.title && <div style={{ fontSize: 11, color: C.red, marginTop: 3 }}>{errors.title}</div>}
            </div>
            <div>
              <Label>Description</Label>
              <textarea value={form.description} onChange={e => set("description", e.target.value)}
                rows={4} placeholder="Describe the piece — origin, colour, energy, size… AI will polish this per platform."
                style={{ ...FI(), resize: "vertical" }} />
            </div>
          </Section>

          {/* ── Per-platform title / description overrides ───────────────── */}
          <Section title="Platform Overrides" action={
            <span style={{ fontSize: 11, color: C.inkFaint }}>optional — leave blank to use main title/description</span>
          }>
            <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "1fr 1fr", gap: 16 }}>
              <div>
                <Label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 12, background: C.goldLight, color: C.gold, borderRadius: 4, padding: "1px 7px", fontWeight: 700 }}>Etsy</span>
                  Title override
                </Label>
                <input value={form.etsy_title || ""} onChange={e => set("etsy_title", e.target.value)}
                  placeholder={form.title || "Same as main title"} style={FI()} />
                <Label style={{ marginTop: 10 }}>Description override</Label>
                <textarea value={form.etsy_description || ""} onChange={e => set("etsy_description", e.target.value)}
                  rows={3} placeholder="Same as main description"
                  style={{ ...FI(), resize: "vertical" }} />
              </div>
              <div>
                <Label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 12, background: C.greenBg, color: C.green, borderRadius: 4, padding: "1px 7px", fontWeight: 700 }}>Shopify</span>
                  Title override
                </Label>
                <input value={form.shopify_title || ""} onChange={e => set("shopify_title", e.target.value)}
                  placeholder={form.title || "Same as main title"} style={FI()} />
                <Label style={{ marginTop: 10 }}>Description override</Label>
                <textarea value={form.shopify_description || ""} onChange={e => set("shopify_description", e.target.value)}
                  rows={3} placeholder="Same as main description"
                  style={{ ...FI(), resize: "vertical" }} />
              </div>
            </div>
          </Section>

          {/* ── Photos & video ───────────────────────────────────────────── */}
          <Section title="Photos & Video" action={
            <span style={{ fontSize: 11, color: C.inkFaint }}>
              {form.images.length} photo{form.images.length !== 1 ? "s" : ""}{form.video ? " · 1 video" : ""}
            </span>
          }>
            <ImagePicker
              material={form.material} shape={form.shape}
              selectedUrls={form.images || []} onChange={urls => set("images", urls)}
              video={form.video || ""} onVideoChange={url => set("video", url)}
            />
          </Section>

          {/* ── Category ─────────────────────────────────────────────────── */}
          <Section title="Category & Section">
            <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "1fr 1fr 1fr", gap: 12 }}>
              <div>
                <Label>Etsy Category <span style={{ fontWeight: 400, color: C.inkFaint }}>(search taxonomy)</span></Label>
                <select value={category} onChange={e => applyCategory(e.target.value)} style={FI()}>
                  {ETSY_CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
              <div>
                <Label>Shop Section <span style={{ fontWeight: 400, color: C.inkFaint }}>(appears in your shop)</span></Label>
                <select value={form.etsy_section_id ?? ""} onChange={e => set("etsy_section_id", e.target.value ? +e.target.value : null)} style={FI()}>
                  {ETSY_SHOP_SECTIONS.map(s => <option key={s.id ?? ""} value={s.id ?? ""}>{s.label}</option>)}
                </select>
              </div>
              <div>
                <Label>Material / Stone</Label>
                <input value={form.material} onChange={e => set("material", e.target.value)}
                  list="lm-mat-list2" placeholder="Amethyst, Clear Quartz…" style={FI()} />
                <datalist id="lm-mat-list2">{MATERIALS.map(m => <option key={m} value={m} />)}</datalist>
              </div>
            </div>
          </Section>

          {/* ── Etsy Tags (13 max) ────────────────────────────────────────── */}
          <Section title="Etsy Tags"
            action={
              <span style={{ fontSize: 11, color: tags.length === 13 ? C.green : C.inkFaint }}>
                {tags.length}/13{tags.length === 13 ? " ✓ full" : ""}
              </span>
            }>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
              {tags.map((t, i) => (
                <span key={t + i} style={{ display: "inline-flex", alignItems: "center", gap: 5,
                  background: C.card, border: `1.5px solid ${C.border}`, borderRadius: 20,
                  padding: "4px 10px", fontSize: 12, color: C.ink }}>
                  {t}
                  <button onClick={() => setTags(ts => ts.filter((_, j) => j !== i))}
                    style={{ background: "none", border: "none", cursor: "pointer", color: C.inkFaint,
                      fontSize: 14, lineHeight: 1, padding: 0, marginLeft: 2 }}>×</button>
                </span>
              ))}
              {tags.length < 13 && (
                <input value={tagDraft} onChange={e => setTagDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addTag(tagDraft); } }}
                  onBlur={() => addTag(tagDraft)}
                  placeholder={tags.length === 0 ? "Type a tag and press Enter…" : "+ tag"}
                  style={{ ...FI(), width: tags.length === 0 ? "100%" : 120, fontSize: 12,
                    border: `1.5px dashed ${C.border}`, borderRadius: 20, padding: "4px 12px" }} />
              )}
            </div>
            <div style={{ fontSize: 11, color: C.inkFaint, display: "flex", alignItems: "center", gap: 8 }}>
              <span>Each tag max 20 chars. Use long-tail keywords.</span>
              <button onClick={generateAI} disabled={generating || !form.title}
                style={{ fontSize: 11, color: C.gold, background: "none", border: `1px solid ${C.gold}60`,
                  borderRadius: 5, padding: "2px 8px", cursor: form.title ? "pointer" : "not-allowed",
                  opacity: form.title ? 1 : .5 }}>
                {generating ? "…" : "✨ Generate 13 tags"}
              </button>
            </div>
          </Section>

          {/* ── Inventory ─────────────────────────────────────────────────── */}
          <Section title="Inventory">
            <div style={{ display: "flex", gap: 10, marginBottom: form.type === "repeatable" ? 12 : 0 }}>
              {[
                { v: "unique",     icon: "🔹", label: "Unique",     sub: "One-of-a-kind — auto-removed from all platforms when sold" },
                { v: "repeatable", icon: "🔁", label: "Repeatable", sub: "Multiple units — quantity tracked across platforms" },
              ].map(opt => (
                <button key={opt.v} onClick={() => set("type", opt.v)} style={{
                  flex: 1, padding: "10px 12px", borderRadius: 8, textAlign: "left", cursor: "pointer",
                  border: `2px solid ${form.type === opt.v ? C.gold : C.border}`,
                  background: form.type === opt.v ? C.amberBg : C.surface,
                }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: form.type === opt.v ? C.ink : C.inkMid }}>{opt.icon} {opt.label}</div>
                  <div style={{ fontSize: 10, color: C.inkFaint, marginTop: 3, lineHeight: 1.4 }}>{opt.sub}</div>
                </button>
              ))}
            </div>
            {form.type === "repeatable" && (
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ flex: "0 0 160px" }}>
                  <Label>Quantity</Label>
                  <input type="number" min={1} value={form.qty} onChange={e => set("qty", e.target.value)} style={FI()} />
                </div>
              </div>
            )}
          </Section>

          {/* ── Variations ────────────────────────────────────────────────── */}
          <Section title="Variations"
            action={
              <button onClick={addVariation}
                style={{ fontSize: 11, color: C.blue, background: C.blueBg, border: `1px solid ${C.blue}`,
                  borderRadius: 5, padding: "3px 10px", cursor: "pointer" }}>
                + Add Variation
              </button>
            }>
            {form.variations.length === 0 ? (
              <div style={{ fontSize: 12, color: C.inkFaint, padding: "4px 0" }}>
                No variations. Use variations to offer different sizes, weights, fillings, etc. Each option can have its own price and quantity — these publish to Shopify (Earth Ed.) as product variants.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {form.variations.map((v, i) => (
                  <div key={v.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 16px" }}>
                    {/* Variation header */}
                    <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12 }}>
                      <input value={v.name} onChange={e => updVar(i, { name: e.target.value })}
                        placeholder="Variation name (e.g. Size, Filling, Weight)"
                        style={{ ...FI(), flex: 1, fontWeight: 600 }} />
                      {/* per-variant pricing toggle */}
                      <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
                        fontSize: 11, color: v.perVariantPricing ? C.blue : C.inkFaint, flexShrink: 0, userSelect: "none" }}>
                        <div onClick={() => updVar(i, { perVariantPricing: !v.perVariantPricing })}
                          style={{ width: 32, height: 18, borderRadius: 9, background: v.perVariantPricing ? C.blue : C.border,
                            position: "relative", cursor: "pointer", transition: "background .2s" }}>
                          <div style={{ position: "absolute", top: 2, left: v.perVariantPricing ? 14 : 2,
                            width: 14, height: 14, borderRadius: "50%", background: "#fff", transition: "left .2s" }} />
                        </div>
                        Per-variant price & qty
                      </label>
                      <button onClick={() => removeVariation(i)}
                        style={{ background: "none", border: "none", cursor: "pointer", color: C.red, fontSize: 20, lineHeight: 1, padding: 0 }}>×</button>
                    </div>

                    {/* Options */}
                    {v.perVariantPricing ? (
                      <div>
                        {/* Column headers */}
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 82px 82px 62px 24px", gap: 6, marginBottom: 4, padding: "0 2px" }}>
                          {["Option", "₹ Etsy", "$ Earth Ed.", "Qty", ""].map(h => (
                            <div key={h} style={{ fontSize: 9, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .5 }}>{h}</div>
                          ))}
                        </div>
                        {v.options.map((opt, j) => (
                          <div key={opt.id} style={{ display: "grid", gridTemplateColumns: "1fr 82px 82px 62px 24px", gap: 6, marginBottom: 6, alignItems: "center" }}>
                            <input value={opt.label} onChange={e => updOpt(i, j, { label: e.target.value })}
                              placeholder="e.g. Small 4 inch" style={{ ...FI(), fontSize: 12 }} />
                            <input type="number" value={opt.price_etsy} onChange={e => updOpt(i, j, { price_etsy: e.target.value })}
                              placeholder="0.00" min="0" style={{ ...FI(), fontSize: 12 }} />
                            <input type="number" value={opt.price_shopify ?? ""} onChange={e => updOpt(i, j, { price_shopify: e.target.value })}
                              placeholder="0.00" min="0" style={{ ...FI(), fontSize: 12 }} />
                            <input type="number" value={opt.qty} onChange={e => updOpt(i, j, { qty: e.target.value })}
                              placeholder="0" min="0" style={{ ...FI(), fontSize: 12 }} />
                            <button onClick={() => removeOpt(i, j)} disabled={v.options.length <= 1}
                              style={{ background: "none", border: "none", cursor: "pointer", color: C.red, fontSize: 16, lineHeight: 1, padding: 0, opacity: v.options.length <= 1 ? .3 : 1 }}>×</button>
                          </div>
                        ))}
                        <button onClick={() => addOpt(i)}
                          style={{ fontSize: 11, color: C.blue, background: "none", border: `1px dashed ${C.blue}`,
                            borderRadius: 5, padding: "4px 12px", cursor: "pointer", marginTop: 2 }}>+ Add option</button>
                      </div>
                    ) : (
                      <div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                          {v.options.map((opt, j) => (
                            <div key={opt.id} style={{ display: "flex", alignItems: "center", gap: 4,
                              background: C.surface, border: `1px solid ${C.border}`, borderRadius: 20, padding: "4px 10px" }}>
                              <input value={opt.label} onChange={e => updOpt(i, j, { label: e.target.value })}
                                placeholder="Option…"
                                style={{ border: "none", background: "none", outline: "none", fontSize: 12, color: C.ink, width: Math.max(60, (opt.label.length || 6) * 8) }} />
                              <button onClick={() => removeOpt(i, j)} disabled={v.options.length <= 1}
                                style={{ background: "none", border: "none", cursor: "pointer", color: C.inkFaint, fontSize: 13, lineHeight: 1, padding: 0, opacity: v.options.length <= 1 ? .3 : 1 }}>×</button>
                            </div>
                          ))}
                          <button onClick={() => addOpt(i)}
                            style={{ fontSize: 12, color: C.blue, background: "none", border: `1px dashed ${C.blue}`,
                              borderRadius: 20, padding: "4px 12px", cursor: "pointer" }}>+ option</button>
                        </div>
                        <div style={{ fontSize: 10, color: C.inkFaint }}>Toggle "Per-variant price & qty" to set individual prices per option.</div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* ── Pricing ───────────────────────────────────────────────────── */}
          <Section title="Pricing">
            <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr 1fr" : "repeat(4,1fr)", gap: 12 }}>
              {PLATFORMS.map(p => {
                const isCalcOpen = calcOpen === p.key;
                const costNum  = +calcCost || 0;
                const multNum  = +calcMult || 1;
                // Etsy: base × mult / 0.75 divisor; eBay: base × mult / liveRate / 0.85
                const baseInr  = costNum * multNum;
                const etsyListed = baseInr > 0 ? Math.round(baseInr / 0.75) : 0;
                const ebayUsd    = baseInr > 0 ? +(baseInr / liveUsdRate / 0.85).toFixed(2) : 0;
                const suggested  = p.key === "ebay" ? ebayUsd
                  : p.key === "etsy" ? etsyListed
                  : baseInr > 0 ? Math.round(baseInr / 0.75) : 0;
                const suggestedDisplay = p.currency === "USD"
                  ? `$${suggested.toFixed(2)}`
                  : `₹${Math.round(suggested).toLocaleString("en-IN")}`;
                // After-fees net for display
                const netEtsy = etsyListed > 0 ? Math.round(etsyListed * 0.89) : 0;
                const netEbay = ebayUsd > 0 ? +(ebayUsd * 0.85).toFixed(2) : 0;
                return (
                  <div key={p.key} style={{ background: C.card, borderRadius: 9, padding: 12, position: "relative",
                    border: `1.5px solid ${p.coming ? C.border : p.color + "35"}`, opacity: p.coming ? .6 : 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                      <span style={{ fontSize: 15 }}>{p.icon}</span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: p.coming ? C.inkFaint : p.color }}>{p.label}</span>
                      <div style={{ flex: 1 }} />
                      {!p.coming && (
                        <button onClick={() => { setCalcOpen(isCalcOpen ? null : p.key); setCalcCost(""); }}
                          title="Price calculator"
                          style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14, color: isCalcOpen ? p.color : C.inkFaint, padding: 0, lineHeight: 1 }}>
                          🧮
                        </button>
                      )}
                    </div>
                    <div style={{ fontSize: 10, color: C.inkFaint, marginBottom: 4 }}>
                      {p.currency === "USD" ? "$ USD" : "₹ INR"}
                      {p.currency !== "USD" && +form[p.priceField] > 0 &&
                        <span style={{ marginLeft: 6, color: C.inkFaint }}>≈ ${(+form[p.priceField] / liveUsdRate).toFixed(0)} USD</span>
                      }
                      {p.currency === "USD" && +form[p.priceField] > 0 &&
                        <span style={{ marginLeft: 6, color: C.inkFaint }}>≈ ₹{(+form[p.priceField] * liveUsdRate).toLocaleString("en-IN")}</span>
                      }
                    </div>
                    <input type="number" value={form[p.priceField] || ""}
                      onChange={e => {
                        set(p.priceField, e.target.value);
                        // Auto-prefill eBay from Etsy
                        if (p.key === "etsy" && e.target.value) {
                          const etsyInr = +e.target.value;
                          const autoEbay = (etsyInr / liveUsdRate / 0.85).toFixed(2);
                          set("price_ebay", autoEbay);
                        }
                      }}
                      disabled={p.coming} placeholder="0.00"
                      style={FI({ fontSize: 15, fontWeight: 600, padding: "7px 10px", opacity: p.coming ? .5 : 1 })} />
                    {form.platforms?.[p.key]?.status && (
                      <div style={{ marginTop: 6 }}><StatusPill status={form.platforms[p.key].status} /></div>
                    )}
                    {/* Calculator popover — avant garde dark panel */}
                    {isCalcOpen && (
                      <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50, marginTop: 6,
                        background: "#0F0F0F", border: `1px solid ${p.color}55`, borderRadius: 10,
                        padding: "16px", boxShadow: `0 12px 40px rgba(0,0,0,.5), 0 0 0 1px ${p.color}22` }}>
                        {/* Header */}
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                          <div style={{ width: 3, height: 18, background: p.color, borderRadius: 2 }} />
                          <div style={{ fontSize: 9, fontWeight: 800, color: p.color, textTransform: "uppercase", letterSpacing: 2 }}>
                            Price Calculator
                          </div>
                        </div>
                        {/* Inputs */}
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
                          <div>
                            <div style={{ fontSize: 9, color: "#666", marginBottom: 4, textTransform: "uppercase", letterSpacing: 1 }}>Cost ₹</div>
                            <input type="number" value={calcCost} onChange={e => setCalcCost(e.target.value)}
                              placeholder="0" autoFocus
                              style={{ background: "#1A1A1A", border: "1px solid #333", color: "#fff",
                                borderRadius: 6, padding: "7px 10px", fontSize: 14, fontWeight: 600,
                                width: "100%", boxSizing: "border-box" }} />
                          </div>
                          <div>
                            <div style={{ fontSize: 9, color: "#666", marginBottom: 4, textTransform: "uppercase", letterSpacing: 1 }}>Multiplier</div>
                            <input type="number" value={calcMult} onChange={e => setCalcMult(e.target.value)}
                              placeholder="3" min="1" step="0.5"
                              style={{ background: "#1A1A1A", border: "1px solid #333", color: "#fff",
                                borderRadius: 6, padding: "7px 10px", fontSize: 14, fontWeight: 600,
                                width: "100%", boxSizing: "border-box" }} />
                          </div>
                        </div>
                        {/* Breakdown */}
                        {costNum > 0 && (
                          <div style={{ marginBottom: 12 }}>
                            <div style={{ borderTop: "1px solid #1E1E1E", paddingTop: 10 }}>
                              {[
                                { label: "Base", val: `₹${Math.round(baseInr).toLocaleString("en-IN")}` },
                                p.key === "etsy"
                                  ? { label: "Listed (÷0.75)", val: `₹${etsyListed.toLocaleString("en-IN")}`, hi: true }
                                  : p.key === "ebay"
                                  ? { label: `Listed (@ ₹${Math.round(liveUsdRate)}/USD ÷0.85)`, val: `$${ebayUsd.toFixed(2)}`, hi: true }
                                  : { label: "Listed (÷0.75)", val: `₹${Math.round(baseInr/0.75).toLocaleString("en-IN")}`, hi: true },
                                p.key === "etsy"
                                  ? { label: "After 11% fees", val: `₹${netEtsy.toLocaleString("en-IN")}`, dim: true }
                                  : p.key === "ebay"
                                  ? { label: "After 15% fees", val: `$${netEbay.toFixed(2)}`, dim: true }
                                  : { label: "After fees (~11%)", val: `₹${Math.round(baseInr/0.75*0.89).toLocaleString("en-IN")}`, dim: true },
                              ].map(row => (
                                <div key={row.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
                                  padding: "3px 0", borderBottom: "1px solid #141414" }}>
                                  <span style={{ fontSize: 9, color: row.hi ? "#888" : "#555", textTransform: "uppercase", letterSpacing: .8 }}>{row.label}</span>
                                  <span style={{ fontSize: row.hi ? 14 : 11, fontWeight: row.hi ? 700 : 400,
                                    color: row.hi ? p.color : row.dim ? "#444" : "#777" }}>{row.val}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        <button disabled={!suggested}
                          onClick={() => {
                            if (p.key === "ebay") {
                              set("price_ebay", ebayUsd.toFixed(2));
                            } else {
                              set(p.priceField, Math.round(suggested));
                              // auto-fill eBay when applying Etsy
                              if (p.key === "etsy") set("price_ebay", (Math.round(suggested) / liveUsdRate / 0.85).toFixed(2));
                            }
                            setCalcOpen(null);
                          }}
                          style={{ width: "100%", background: suggested ? p.color : "#1A1A1A", color: suggested ? "#fff" : "#444",
                            border: "none", borderRadius: 6, padding: "9px 0", fontSize: 11, fontWeight: 800,
                            letterSpacing: 1.5, textTransform: "uppercase", cursor: suggested ? "pointer" : "not-allowed",
                            transition: "opacity .15s" }}>
                          Apply {suggestedDisplay} →
                        </button>
                        <div style={{ marginTop: 8, fontSize: 9, color: "#333", textAlign: "center" }}>
                          1 USD = ₹{liveUsdRate.toFixed(1)} · live rate
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Section>

          {/* ── Etsy publish settings ────────────────────────────────────── */}
          <Section title="Etsy Settings" accent="#F56400">
            <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "1fr 1fr", gap: 12 }}>
              {/* Shipping profile */}
              <div>
                <Label>Shipping Profile</Label>
                <select value={form.etsy_shipping_profile_id || ""}
                  onChange={e => set("etsy_shipping_profile_id", e.target.value ? +e.target.value : null)}
                  style={FI()}>
                  <option value="">— Auto (by price)</option>
                  {etsyShippingProfiles.map(p => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
              </div>
              {/* Return policy */}
              <div>
                <Label>Return Policy</Label>
                <select value={form.etsy_return_policy_id || ""}
                  onChange={e => set("etsy_return_policy_id", e.target.value ? +e.target.value : null)}
                  style={FI()}>
                  <option value="">— Default (14-day returns)</option>
                  {etsyReturnPolicies.map(p => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
              </div>
            </div>
            {/* Toggles row */}
            <div style={{ display: "flex", gap: 24, marginTop: 12 }}>
              {[
                { field: "etsy_auto_renew", label: "Auto-renew listing", sub: "₹0.20/renewal every 4 months" },
                { field: "etsy_ads",        label: "Run Etsy Ads",       sub: "Promotes listing in search" },
              ].map(({ field, label, sub }) => (
                <label key={field} style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", flex: 1 }}>
                  <input type="checkbox" checked={!!form[field]}
                    onChange={e => set(field, e.target.checked)}
                    style={{ marginTop: 2, accentColor: "#F56400", width: 14, height: 14, flexShrink: 0 }} />
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: C.ink }}>{label}</div>
                    <div style={{ fontSize: 10, color: C.inkFaint }}>{sub}</div>
                  </div>
                </label>
              ))}
            </div>
          </Section>

          {/* ── Optional details (collapsed) ──────────────────────────────── */}
          <div>
            <button onClick={() => setShowOptional(x => !x)}
              style={{ background: "none", border: "none", cursor: "pointer", color: C.inkFaint,
                fontSize: 12, padding: "4px 0", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 10 }}>{showOptional ? "▼" : "▶"}</span>
              {showOptional ? "Hide" : "Show"} optional fields (SKU, origin, size, weight, storage, stock link)
            </button>
            {showOptional && (
              <div style={{ marginTop: 12, background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "16px 18px" }}>
                <Grid cols={2}>
                  <div><Label>SKU</Label><input value={form.sku} onChange={e => set("sku", e.target.value)} placeholder="CQ-SPH-001" style={FI()} /></div>
                  <div><Label>Origin</Label><input value={form.origin} onChange={e => set("origin", e.target.value)} placeholder="Brazil, India…" style={FI()} /></div>
                  <div><Label>Size</Label><input value={form.size} onChange={e => set("size", e.target.value)} placeholder="4 inch, 45mm…" style={FI()} /></div>
                  <div><Label>Weight</Label><input value={form.weight} onChange={e => set("weight", e.target.value)} placeholder="500g, 1.2kg…" style={FI()} /></div>
                </Grid>
                <div style={{ marginTop: 12 }}>
                  <Label>📦 Office / Storage Location (internal only — not on Etsy/eBay)</Label>
                  <input
                    value={form.officeLocation || ""}
                    onChange={e => set("officeLocation", e.target.value)}
                    placeholder="e.g. Shelf B2, Blue box, Drawer 3, Safe…"
                    style={FI()}
                    list="office-loc-list"
                  />
                  <datalist id="office-loc-list">
                    {[...new Set(stock.map(s => s.location).filter(Boolean))].map(l => (
                      <option key={l} value={l} />
                    ))}
                  </datalist>
                  <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 4 }}>
                    Where is this piece physically sitting in your office right now?
                  </div>
                </div>
                <div style={{ marginTop: 12 }}>
                  <Label>Link to Physical Stock Item (reads live quantity)</Label>
                  <select value={form.linked_stock_id} onChange={e => {
                    const sid = e.target.value;
                    set("linked_stock_id", sid);
                    // Auto-fill officeLocation from the linked stock item's location
                    if (sid) {
                      const s = stock.find(x => x.id === sid);
                      if (s?.location && !form.officeLocation) set("officeLocation", s.location);
                    }
                  }} style={FI()}>
                    <option value="">— None (use manual quantity) —</option>
                    {stock.map(s => (
                      <option key={s.id} value={s.id}>
                        {s.desc || s.material} — {s.qty} {s.unit || "pcs"}{s.location ? ` · 📦 ${s.location}` : ""}{s.sku ? ` (${s.sku})` : ""}
                      </option>
                    ))}
                  </select>
                  {form.linked_stock_id && (() => {
                    const ls = stock.find(s => s.id === form.linked_stock_id);
                    return ls ? (
                      <div style={{ marginTop: 6, background: C.card, border: `1px solid ${C.border}`, borderRadius: 7, padding: "7px 10px", fontSize: 12, color: C.inkMid, display: "flex", gap: 14, flexWrap: "wrap" }}>
                        <span>📦 <b>{ls.qty} {ls.unit || "pcs"}</b> in stock</span>
                        {ls.location && <span>📍 <b>{ls.location}</b></span>}
                        {ls.material && <span>💎 {ls.material}{ls.shape ? ` · ${ls.shape}` : ""}</span>}
                      </div>
                    ) : null;
                  })()}
                </div>
              </div>
            )}
          </div>

        </div>{/* end scrollable body */}

        {/* sticky footer */}
        <div style={{ borderTop: `1px solid ${C.border}`, borderRadius: "0 0 14px 14px",
          background: C.surface, flexShrink: 0 }}>

          {/* Footer platform row */}
          <div style={{ padding: "12px 24px 0" }}>
            {(() => {
              // "linked" = already exists on this platform (has an ID), auto-syncs on save
              const linkedPlatforms = PLATFORMS.filter(p => {
                const pd = form.platforms?.[p.key];
                if (!pd || pd.status === "deleted") return false;
                if (p.key === "etsy" && pd.listing_id) return true;
                if (p.key === "ebay" && pd.item_id) return true;
                if ((p.key === "shopify_aty" || p.key === "shopify_earth") && pd.product_id) return true;
                return pd.status === "active" || pd.status === "draft";
              });
              const linkedKeys = new Set(linkedPlatforms.map(p => p.key));
              const newPlatforms = PLATFORMS.filter(p => !linkedKeys.has(p.key));
              return (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                  {/* Already linked: show as pills, auto-syncs on every save */}
                  {linkedPlatforms.length > 0 && (
                    <>
                      <span style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .5 }}>On save, sync to</span>
                      {linkedPlatforms.map(p => {
                        const st = form.platforms?.[p.key]?.status;
                        const isDraft = st === "draft";
                        return (
                          <div key={p.key} style={{ display: "flex", alignItems: "center", gap: 5,
                            background: isDraft ? C.amberBg : p.color + "18",
                            border: `1.5px solid ${isDraft ? C.amber + "80" : p.color + "50"}`,
                            borderRadius: 8, padding: "4px 10px" }}>
                            <span style={{ fontSize: 12 }}>{p.icon}</span>
                            <span style={{ fontSize: 11, fontWeight: 700, color: isDraft ? C.amber : p.color }}>{p.label}</span>
                            <span style={{ fontSize: 9, color: isDraft ? C.amber : p.color, opacity: .8 }}>{isDraft ? "DRAFT" : "LIVE"}</span>
                          </div>
                        );
                      })}
                    </>
                  )}
                  {/* Not-yet-linked: optional checkboxes to also create a draft on save */}
                  {newPlatforms.length > 0 && (
                    <>
                      <span style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .5, marginLeft: linkedPlatforms.length ? 6 : 0 }}>
                        {linkedPlatforms.length ? "Also add to" : "Add to"}
                      </span>
                      {newPlatforms.map(p => {
                        const hasPrice = +form[p.priceField] > 0;
                        const checked  = !!publishTo[p.key];
                        return (
                          <label key={p.key} style={{
                            display: "flex", alignItems: "center", gap: 5,
                            cursor: hasPrice ? "pointer" : "not-allowed",
                            background: checked ? p.color + "15" : C.card,
                            border: `1.5px solid ${checked ? p.color : C.border}`,
                            borderRadius: 8, padding: "4px 10px",
                            opacity: hasPrice ? 1 : .4, userSelect: "none",
                          }}>
                            <input type="checkbox" checked={checked} disabled={!hasPrice}
                              onChange={e => setPublishTo(pt => ({ ...pt, [p.key]: e.target.checked }))}
                              style={{ accentColor: p.color, width: 12, height: 12 }} />
                            <span style={{ fontSize: 12 }}>{p.icon}</span>
                            <span style={{ fontSize: 11, fontWeight: 600, color: checked ? p.color : C.inkMid }}>{p.label}</span>
                            {!hasPrice && <span style={{ fontSize: 9, color: C.inkFaint }}>set price</span>}
                          </label>
                        );
                      })}
                    </>
                  )}
                </div>
              );
            })()}
          </div>

          <div style={{ padding: "10px 24px 14px", display: "flex", gap: 10 }}>
            <button onClick={handleSave}
              style={{ flex: 1, background: C.ink, color: "#FAF0DC", border: "none",
                borderRadius: 8, padding: "12px 0", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
              {editing ? "Save Changes" : (Object.values(publishTo).some(Boolean) ? "Save & Add to Draft →" : "Save Listing")}
            </button>
            <button onClick={onClose}
              style={{ padding: "12px 20px", background: C.surface, border: `1.5px solid ${C.border}`,
                borderRadius: 8, fontSize: 13, cursor: "pointer", color: C.ink }}>
              Cancel
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   LISTING CARD
══════════════════════════════════════════════════════════════════════════ */
function ListingCard({ listing, stock, orders, onEdit, onDelete, onPublish, onSaveAsDraft, onUnpublish, onMarkSold }) {
  const [expanded,   setExpanded]   = useState(false);
  const [publishing, setPublishing] = useState({});
  const [toast,      setToast]      = useState("");

  const showToast = m => { setToast(m); setTimeout(() => setToast(""), 3000); };

  const linkedStock     = stock.find(s => s.id === listing.linked_stock_id);
  const img             = listing.images?.[0];
  const salesCount      = (orders || []).filter(o => o.listing_id === listing.id).length;
  const liveOn          = PLATFORMS.filter(p => listing.platforms?.[p.key]?.status === "active");
  // Storage location: explicit field first, fall back to linked stock's location
  const storageLocation = listing.officeLocation || linkedStock?.location || "";

  const handlePublish = async pkey => {
    setPublishing(p => ({ ...p, [pkey]: "publishing" }));
    try {
      await onPublish(listing, pkey);
      showToast(`✓ Published to ${PLATFORMS.find(p => p.key === pkey)?.label}`);
    } catch (e) { showToast(`⚠ ${e.message}`); }
    finally { setPublishing(p => ({ ...p, [pkey]: false })); }
  };

  const handleSaveAsDraft = async pkey => {
    setPublishing(p => ({ ...p, [pkey]: "drafting" }));
    try {
      await onSaveAsDraft(listing, pkey);
      showToast(`✓ Saved as draft on ${PLATFORMS.find(p => p.key === pkey)?.label}`);
    } catch (e) { showToast(`⚠ ${e.message}`); }
    finally { setPublishing(p => ({ ...p, [pkey]: false })); }
  };

  const handleUnpublish = async pkey => {
    if (!confirm(`Remove from ${PLATFORMS.find(p => p.key === pkey)?.label}?`)) return;
    setPublishing(p => ({ ...p, [pkey]: "removing" }));
    try {
      await onUnpublish(listing, pkey);
      showToast(`Removed from ${PLATFORMS.find(p => p.key === pkey)?.label}`);
    } catch (e) { showToast(`⚠ ${e.message}`); }
    finally { setPublishing(p => ({ ...p, [pkey]: false })); }
  };

  const displayQty = linkedStock
    ? `${linkedStock.qty} ${linkedStock.unit || "pcs"}`
    : listing.type === "unique" ? "1 (unique)" : `${listing.qty || 1} pcs`;

  return (
    <div style={{ background: C.surface, border: `1.5px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
      <Toast msg={toast} />

      {/* main row */}
      <div style={{ display: "flex", gap: 14, padding: "14px 16px", alignItems: "flex-start" }}>

        {/* cover photo */}
        <div style={{ width: 82, height: 82, borderRadius: 9, flexShrink: 0, overflow: "hidden",
          background: C.card, border: `1px solid ${C.border}`, cursor: "pointer" }}
          onClick={() => setExpanded(e => !e)}>
          {img
            ? <img src={img} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28 }}>💎</div>
          }
        </div>

        {/* centre */}
        <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => setExpanded(e => !e)}>
          {/* title row */}
          <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap", marginBottom: 3 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>{listing.title}</span>
            <span style={{ fontSize: 10, borderRadius: 20, padding: "1px 8px", fontWeight: 700,
              textTransform: "uppercase", letterSpacing: .4,
              background: listing.type === "unique" ? C.blueBg : C.greenBg,
              color: listing.type === "unique" ? C.blue : C.green,
              border: `1px solid ${listing.type === "unique" ? C.blue : C.green}30` }}>
              {listing.type === "unique" ? "Unique" : "Repeatable"}
            </span>
            {listing.video && <span style={{ fontSize: 10, borderRadius: 20, padding: "1px 8px", fontWeight: 700,
              textTransform: "uppercase", letterSpacing: .4, background: C.amberBg, color: C.gold,
              border: `1px solid ${C.gold}40` }}>Video</span>}
            {salesCount > 0 && <span style={{ fontSize: 11, color: C.inkFaint }}>· {salesCount} sold</span>}
          </div>

          {/* meta */}
          <div style={{ fontSize: 12, color: C.inkMid, marginBottom: storageLocation ? 4 : 6 }}>
            {[listing.material, listing.shape, listing.origin].filter(Boolean).join(" · ")}
            {listing.sku && <span style={{ marginLeft: 8, fontFamily: "monospace", fontSize: 11, color: C.inkFaint }}>SKU: {listing.sku}</span>}
          </div>

          {/* storage location badge (internal ERP only) */}
          {storageLocation && (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 4, marginBottom: 6,
              background: "#FFF7ED", border: "1px solid #FED7AA", borderRadius: 5,
              padding: "2px 8px", fontSize: 11, color: "#9A3412", fontWeight: 500 }}>
              📦 {storageLocation}
              {linkedStock && <span style={{ fontSize: 10, color: "#C2410C", marginLeft: 2 }}>· {linkedStock.qty} {linkedStock.unit || "pcs"} avail</span>}
            </div>
          )}

          {/* platform chips */}
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 6 }}>
            {PLATFORMS.filter(p => !p.coming).map(p => (
              <PlatformChip key={p.key} pkey={p.key} status={listing.platforms?.[p.key]?.status} />
            ))}
          </div>

          {/* prices */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {PLATFORMS.filter(p => !p.coming && +listing[p.priceField] > 0).map(p => (
              <span key={p.key} style={{ fontSize: 11, color: p.color, fontWeight: 700 }}>
                {p.icon} {p.currency === "USD" ? "$" : "₹"}{fmt(listing[p.priceField])}
              </span>
            ))}
          </div>
        </div>

        {/* right controls */}
        <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
          <div style={{ fontSize: 11, color: C.inkFaint }}>{displayQty}</div>
          {liveOn.length > 0 && (
            <div style={{ fontSize: 11, color: C.green, fontWeight: 700 }}>{liveOn.length} live</div>
          )}
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {liveOn.length > 0 && (
              <button onClick={() => onMarkSold(listing)}
                style={{ padding: "5px 10px", background: C.greenBg, border: `1px solid ${C.green}40`,
                  borderRadius: 6, fontSize: 11, cursor: "pointer", color: C.green, fontWeight: 700 }}>
                Mark Sold
              </button>
            )}
            <button onClick={() => onEdit(listing)}
              style={{ padding: "5px 10px", background: C.surface, border: `1.5px solid ${C.border}`,
                borderRadius: 6, fontSize: 11, cursor: "pointer", color: C.ink, fontWeight: 600 }}>
              Edit
            </button>
            <button onClick={() => setExpanded(e => !e)}
              style={{ padding: "5px 8px", background: C.surface, border: `1.5px solid ${C.border}`,
                borderRadius: 6, fontSize: 11, cursor: "pointer", color: C.inkMid }}>
              {expanded ? "▲" : "▼"}
            </button>
          </div>
        </div>
      </div>

      {/* expanded platform controls */}
      {expanded && (
        <div style={{ borderTop: `1px solid ${C.border}`, background: C.bg }}>
          {listing.description && (
            <div style={{ padding: "10px 16px", fontSize: 12, color: C.inkMid, lineHeight: 1.6,
              borderBottom: `1px solid ${C.border}` }}>
              {listing.description.slice(0, 300)}{listing.description.length > 300 ? "…" : ""}
            </div>
          )}

          <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase",
              letterSpacing: .7, color: C.inkFaint, marginBottom: 2 }}>Publish / Manage</div>

            {PLATFORMS.map(p => {
              const ps       = listing.platforms?.[p.key] || {};
              const isLive   = ps.status === "active";
              const isDraft  = ps.status === "draft";
              const busy     = publishing[p.key];
              const price    = listing[p.priceField];
              const hasPrice = +price > 0;

              return (
                <div key={p.key} style={{ display: "flex", alignItems: "center", gap: 12,
                  background: isLive ? p.color + "10" : isDraft ? C.amberBg : C.card,
                  border: `1.5px solid ${isLive ? p.color + "40" : isDraft ? C.amber + "60" : C.border}`,
                  borderRadius: 9, padding: "10px 14px", opacity: p.coming ? .6 : 1 }}>
                  <span style={{ fontSize: 18 }}>{p.icon}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: isLive ? p.color : isDraft ? C.amber : C.ink }}>
                      {p.label}{isDraft ? " — Draft" : ""}
                    </div>
                    <div style={{ fontSize: 11, color: C.inkFaint }}>
                      {p.currency} {price ? (p.currency === "USD" ? `$${fmt(price)}` : `₹${fmt(price)}`) : "no price set"}
                      {(isLive || isDraft) && (ps.listing_id || ps.product_id) && (
                        <span style={{ marginLeft: 6, fontFamily: "monospace", fontSize: 10 }}>
                          ID: {ps.listing_id || ps.product_id}
                        </span>
                      )}
                    </div>
                  </div>
                  {p.coming ? (
                    <span style={{ fontSize: 11, color: C.inkFaint, fontStyle: "italic" }}>Coming soon</span>
                  ) : !hasPrice ? (
                    <span style={{ fontSize: 11, color: C.amber, fontWeight: 600 }}>⚠ Set price first</span>
                  ) : p.key === "etsy" && !isLive ? (
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                      <span style={{ fontSize: 10, color: C.inkFaint }}>$0.20 listing fee</span>
                      {isDraft ? (
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          {ps.listing_id && (
                            <a href="https://www.etsy.com/your/listings/draft"
                              target="_blank" rel="noreferrer"
                              style={{ padding: "6px 10px", background: C.amberBg,
                                border: `1px solid ${C.amber}60`, borderRadius: 6, fontSize: 11,
                                color: C.amber, textDecoration: "none", fontWeight: 600 }}>
                              View Draft ↗
                            </a>
                          )}
                          {ps.listing_id && (
                            <button onClick={() => handleUnpublish(p.key)} disabled={!!busy}
                              style={{ padding: "6px 10px", background: C.redBg, border: `1px solid ${C.red}40`,
                                borderRadius: 6, fontSize: 11, color: C.red, cursor: "pointer", fontWeight: 600, opacity: busy ? .7 : 1 }}>
                              {busy === "removing" ? <><Spinner /> Removing…</> : `Delete from ${p.label}`}
                            </button>
                          )}
                          <button onClick={() => handlePublish(p.key)} disabled={!!busy}
                            style={{ padding: "6px 14px", background: p.color, color: "#fff", border: "none",
                              borderRadius: 7, fontSize: 11, fontWeight: 700, cursor: "pointer", opacity: busy ? .7 : 1 }}>
                            {busy === "publishing" ? <><Spinner /> Publishing…</> : "Publish →"}
                          </button>
                        </div>
                      ) : (
                        // Not on Etsy yet — offer Save as Draft first, Publish is a separate step
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                          <button onClick={() => handleSaveAsDraft(p.key)} disabled={!!busy}
                            style={{ padding: "6px 14px", background: C.amberBg, color: C.amber,
                              border: `1.5px solid ${C.amber}60`, borderRadius: 7, fontSize: 11,
                              fontWeight: 700, cursor: "pointer", opacity: busy ? .7 : 1 }}>
                            {busy === "drafting" ? <><Spinner /> Saving…</> : "Save as Draft"}
                          </button>
                          <span style={{ fontSize: 9, color: C.inkFaint }}>then Publish ($0.20)</span>
                        </div>
                      )}
                    </div>
                  ) : isLive ? (
                    <div style={{ display: "flex", gap: 6 }}>
                      {(ps.url || ps.listing_id) && (
                        <a href={ps.url || `https://www.etsy.com/listing/${ps.listing_id}`}
                          target="_blank" rel="noreferrer"
                          style={{ padding: "6px 12px", background: p.color + "20",
                            border: `1px solid ${p.color}40`, borderRadius: 6, fontSize: 11,
                            color: p.color, textDecoration: "none", fontWeight: 600 }}>
                          View ↗
                        </a>
                      )}
                      <button onClick={() => handleUnpublish(p.key)} disabled={!!busy}
                        style={{ padding: "6px 12px", background: C.redBg, border: `1px solid ${C.red}40`,
                          borderRadius: 6, fontSize: 11, color: C.red, cursor: "pointer", fontWeight: 600 }}>
                        {busy === "removing" ? <><Spinner /> Removing…</> : "Delete from Etsy"}
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => handlePublish(p.key)} disabled={!!busy}
                      style={{ padding: "7px 18px", background: p.color, color: "#fff", border: "none",
                        borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: "pointer", opacity: busy ? .7 : 1 }}>
                      {busy === "publishing" ? <><Spinner /> Publishing…</> : "Publish →"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* image strip + delete */}
          <div style={{ padding: "0 16px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            {listing.images?.length > 1 ? (
              <div style={{ display: "flex", gap: 4 }}>
                {listing.images.slice(0, 6).map((url, i) => (
                  <img key={i} src={url} alt="" style={{ width: 30, height: 30, borderRadius: 4, objectFit: "cover", border: `1px solid ${C.border}` }} />
                ))}
                {listing.images.length > 6 && (
                  <span style={{ fontSize: 11, color: C.inkFaint, lineHeight: "30px", marginLeft: 2 }}>+{listing.images.length - 6}</span>
                )}
              </div>
            ) : <div />}
            <button onClick={() => onDelete(listing.id)}
              style={{ padding: "6px 14px", background: "none", border: `1px solid ${C.red}40`,
                borderRadius: 6, fontSize: 11, color: C.red, cursor: "pointer" }}>
              Delete Listing
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   ORDERS VIEW
══════════════════════════════════════════════════════════════════════════ */
function OrdersView({ orders, listings = [], stock = [], showToast }) {
  const [pFilter,  setPFilter]  = useState("all");
  const [shipFilter, setShipFilter] = useState("all");
  const [search,   setSearch]   = useState("");
  const [expanded, setExpanded] = useState(null);
  const [copied, setCopied] = useState("");
  const [etsyTracking, setEtsyTracking] = useState({});
  const [invoiceState, setInvoiceState] = useState({});
  const [ngState, setNgState] = useState({}); // per-order: {qty, loading, error, success}
  const [stockSearch, setStockSearch] = useState({});
  const [trackingModalOrder, setTrackingModalOrder] = useState(null);
  const [detailsOpen, setDetailsOpen] = useState({});
  const [stepSel, setStepSel] = useState({}); // per-order: which fulfilment step panel is open (overrides the auto-active one)
  const [stockModalOrder, setStockModalOrder] = useState(null); // order whose stock-picker modal is open
  const [atInvoices, setAtInvoices] = useState([]); // Atyahara invoices, for matching/linking existing invoices to orders
  const [invoiceModalOrder, setInvoiceModalOrder] = useState(null); // order whose "link existing invoice" picker is open
  const [invoiceModalSearch, setInvoiceModalSearch] = useState("");
  const [reconciling, setReconciling] = useState(false);
  const [etsyBackfilling, setEtsyBackfilling] = useState(false);
  const etsyBackfillRef = useRef(false);
  // Customs shape list (Datasets tab) — drives the editable Shape field per order and
  // the customs/bill description on invoices created from these orders.
  const [customsShapes, setCustomsShapes] = useState([]);
  useEffect(() => {
    loadK(CUSTOMS_DESCS_KEY).then(rows => {
      const source = Array.isArray(rows) && rows.length ? rows : DEFAULT_CUSTOMS_DESCS;
      setCustomsShapes([...new Set(source.flatMap(r => String(r.shape || "").split(",").map(s => s.trim()).filter(Boolean)))]);
    });
  }, []);
  const patchOrder = async (order, patch) => {
    const current = await loadK(ORDERS_KEY) || [];
    const next = current.map(x => x.id === order.id ? { ...x, ...patch } : x);
    const updated = next.find(x => x.id === order.id);
    if (updated) await upsertItemK(ORDERS_KEY, updated, { prepend: false });
    window.dispatchEvent(new CustomEvent("ng-orders-updated", { detail: next }));
    return updated;
  };
  const setOrderShape = (order, shape) => patchOrder(order, { listing_shape: shape });
  const ngDraft = o => ngState[o.id] || { qty: String(o._ngDeductedQty || 1), qty2: String(o._ngDeductedQty2 || ""), loading: false, error: "", success: "" };
  const updNg = (o, patch) => setNgState(s => ({ ...s, [o.id]: { ...ngDraft(o), ...patch } }));
  const linkOrderStock = (order, stockId) => patchOrder(order, { linked_stock_id: stockId });
  const setOrderTrackingUrl = (order, url) => patchOrder(order, { tracking_url: url });
  // Atyahara invoices share the store the Orders flow writes to, so we can link existing
  // invoices (created in Invoicing) back onto orders and mark "Sales invoice" done.
  const invNoOf = inv => inv.invNo || inv.number || "";
  const invAmt = inv => +inv.totalAmt || (inv.items || []).reduce((s, i) => s + (+i.amt || (+i.qty || 0) * (+i.rate || 0) || 0), 0);
  const normName = s => String(s || "").toLowerCase().replace(/\bvia etsy\b/g, "").replace(/[^a-z0-9]/g, "");
  useEffect(() => { loadKFresh(AT_INVOICES_KEY).then(d => setAtInvoices(Array.isArray(d) ? d : [])).catch(() => {}); }, []);
  const linkOrderInvoice = (order, inv) => { setInvoiceModalOrder(null); patchOrder(order, { _atInvoiceNo: invNoOf(inv), _atInvoicedAt: now() }); showToast?.(`Linked ${invNoOf(inv)} to this order`); };
  // Bulk-match unlinked Etsy orders to existing Atyahara invoices. Only links on a strong
  // signal: an exact Etsy receipt id, or a clean 1:1 buyer-name match (skips ambiguous ones
  // so duplicate buyers never get mislinked — those are handled manually per order).
  const reconcileInvoices = async () => {
    setReconciling(true);
    try {
      const invs = (await loadKFresh(AT_INVOICES_KEY).catch(() => atInvoices)) || atInvoices;
      setAtInvoices(Array.isArray(invs) ? invs : []);
      const current = await loadK(ORDERS_KEY) || [];
      const unlinked = current.filter(o => isEtsyOrder(o) && !o._atInvoiceNo);
      const byReceipt = new Map();
      for (const inv of invs) for (const id of [inv._etsyReceiptId, inv.etsy_receipt_id, ...(inv.sourceOrderIds || [])].filter(Boolean).map(String)) if (!byReceipt.has(id)) byReceipt.set(id, inv);
      const invByName = new Map();
      for (const inv of invs) { const k = normName(inv.buyerName || inv.buyer || inv.consigneeName); if (k) (invByName.get(k) || invByName.set(k, []).get(k)).push(inv); }
      const ordersByName = new Map();
      for (const o of unlinked) { const k = normName(o.buyer_name); if (k) (ordersByName.get(k) || ordersByName.set(k, []).get(k)).push(o); }
      const claimed = new Set(current.map(o => o._atInvoiceNo).filter(Boolean));
      const patches = {};
      let linked = 0, ambiguous = 0;
      for (const o of unlinked) {
        const rid = String(etsyReceiptId(o) || "");
        const hit = rid && byReceipt.get(rid);
        if (hit) { patches[o.id] = invNoOf(hit); claimed.add(invNoOf(hit)); linked++; continue; }
        const k = normName(o.buyer_name);
        const cand = (invByName.get(k) || []).filter(inv => !claimed.has(invNoOf(inv)));
        if (cand.length === 1 && (ordersByName.get(k) || []).length === 1) { patches[o.id] = invNoOf(cand[0]); claimed.add(invNoOf(cand[0])); linked++; }
        else if (cand.length) ambiguous++;
      }
      if (linked) {
        const next = current.map(o => patches[o.id] ? { ...o, _atInvoiceNo: patches[o.id], _atInvoicedAt: o._atInvoicedAt || now() } : o);
        for (const o of next) if (patches[o.id]) await upsertItemK(ORDERS_KEY, o, { prepend: false });
        window.dispatchEvent(new CustomEvent("ng-orders-updated", { detail: next }));
      }
      showToast?.(linked ? `Linked ${linked} order${linked !== 1 ? "s" : ""} to existing invoices${ambiguous ? ` · ${ambiguous} need manual linking` : ""}` : "No new matches found — link ambiguous ones from each order's step 3");
    } catch (e) {
      showToast?.(e.message || "Could not match invoices");
    } finally { setReconciling(false); }
  };
  // Deduct the linked NG stock and add a line to Atyahara's inter-company NG invoice.
  const addOrderToNg = async order => {
    const draft = ngDraft(order);
    const stockItem = stock.find(s => s.id === order.linked_stock_id);
    if (!stockItem) { updNg(order, { error: "Link a physical stock item first." }); return; }
    const qty = Math.max(1, +draft.qty || 1);
    const qty2 = Math.max(0, +draft.qty2 || 0);
    if (qty > (+stockItem.qty || 0)) { updNg(order, { error: `Only ${stockItem.qty || 0} ${stockItem.unit || "pcs"} in stock.` }); return; }
    if (String(stockItem.qty2 || "").trim() !== "" && qty2 > (+stockItem.qty2 || 0)) { updNg(order, { error: `Only ${stockItem.qty2 || 0} ${stockItem.unit2 || "secondary units"} available.` }); return; }
    updNg(order, { loading: true, error: "", success: "" });
    try {
      const { invNo, deductedQty, deductedQty2, remaining, remaining2 } = await addOrderToNikhilGemsInvoice({ order, stockItem, qty, qty2 });
      await patchOrder(order, { _ngInvoiceNo: invNo, _ngDeductedQty: deductedQty, _ngDeductedQty2: deductedQty2 || "", _ngStockId: stockItem.id, _ngInvoicedAt: now() });
      const secondaryNote = remaining2 == null ? "" : ` · −${deductedQty2} ${stockItem.unit2 || "secondary units"} (${remaining2} left)`;
      updNg(order, { loading: false, success: `Added to ${invNo} · −${deductedQty} ${stockItem.unit || "pcs"} (${remaining} left)${secondaryNote}` });
      showToast?.(`✓ ${invNo} updated · stock deducted`);
    } catch (e) {
      updNg(order, { loading: false, error: e.message || "Could not add to NG invoice" });
    }
  };
  const money = (amount, currency = "INR") => {
    const sym = currency === "INR" ? "₹" : currency === "USD" ? "$" : currency === "EUR" ? "€" : currency === "GBP" ? "£" : currency === "JPY" ? "¥" : currency;
    return `${sym}${fmt(amount)}`;
  };
  const isShipped = o => ["shipped", "completed", "fulfilled"].includes(String(o.status || "").toLowerCase()) || !!o.shipped_at;
  const orderDate = o => o.date || o.created_at || new Date().toISOString().slice(0, 10);
  const addressLines = o => [
    o.ship_name || o.buyer_name,
    o.ship_address1,
    o.ship_address2,
    [o.ship_city, o.ship_state, o.ship_postcode].filter(Boolean).join(", "),
    o.ship_country || o.buyer_country,
    o.ship_phone ? `Phone: ${o.ship_phone}` : "",
    o.buyer_email ? `Email: ${o.buyer_email}` : "",
  ].filter(Boolean);
  const copyText = async (label, text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(""), 1800);
    } catch {
      setCopied("");
    }
  };
  const isEtsyOrder = o => o.platform === "etsy" || !!o.etsy_receipt_id || String(o.order_number || "").startsWith("ETSY-");
  const etsyReceiptId = o => o.etsy_receipt_id || o.platform_order_id || String(o.order_number || "").replace(/^ETSY-/, "").split("-")[0];
  const invoiceDraft = o => invoiceState[etsyReceiptId(o)] || { loading: false, error: "", success: "" };
  const trackingDraft = o => etsyTracking[o.id] || {
    tracking_code: o.tracking_code || o.tracking_number || "",
    carrier_name: o.carrier_name || o.shipping_carrier || "other",
    note_to_buyer: "",
    send_bcc: false,
    loading: false,
    error: "",
    success: "",
  };
  const updateTrackingDraft = (o, patch) => {
    setEtsyTracking(s => ({ ...s, [o.id]: { ...trackingDraft(o), ...patch } }));
  };
  const completeEtsyOrder = async o => {
    const receiptId = etsyReceiptId(o);
    const draft = trackingDraft(o);
    const trackingCode = String(draft.tracking_code || "").trim();
    const carrierName = String(draft.carrier_name || "other").trim() || "other";
    if (!receiptId) {
      updateTrackingDraft(o, { error: "Missing Etsy receipt id.", success: "" });
      return;
    }
    if (!trackingCode) {
      updateTrackingDraft(o, { error: "Add a tracking number first.", success: "" });
      return;
    }
    updateTrackingDraft(o, { loading: true, error: "", success: "" });
    try {
      const tok = await getEtsyToken(); // fresh token (refresh + Supabase fallback), not the stale localStorage one
      let r = await fetch("/api/etsy?action=add_tracking", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(tok ? { "X-Etsy-Token": tok } : {}) },
        body: JSON.stringify({ receipt_id: receiptId, tracking_code: trackingCode, carrier_name: carrierName, note_to_buyer: draft.note_to_buyer || undefined, send_bcc: !!draft.send_bcc }),
      });
      let d = await r.json().catch(() => ({}));
      if (!r.ok && tok && needsEtsyReconnect(d.fix || d.error)) {
        clearLocalEtsySession();
        r = await fetch("/api/etsy?action=add_tracking", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ receipt_id: receiptId, tracking_code: trackingCode, carrier_name: carrierName, note_to_buyer: draft.note_to_buyer || undefined, send_bcc: !!draft.send_bcc }),
        });
        d = await r.json().catch(() => ({}));
      }
      if (!r.ok || d.ok === false) throw new Error(d.fix || d.error || "Could not complete Etsy order");
      const now = new Date().toISOString();
      const current = await loadK(ORDERS_KEY);
      const sameReceipt = x => isEtsyOrder(x) && String(etsyReceiptId(x)) === String(receiptId);
      const next = (current || orders || []).map(x => sameReceipt(x) ? {
        ...x,
        status: "shipped",
        shipped_at: x.shipped_at || now,
        tracking_code: trackingCode,
        tracking_number: trackingCode,
        carrier_name: carrierName,
        etsy_completed_at: now,
      } : x);
      const changedOrders = next.filter(x => sameReceipt(x));
      for (const order of changedOrders) await upsertItemK(ORDERS_KEY, order, { prepend: false });
      window.dispatchEvent(new CustomEvent("ng-orders-updated", { detail: next }));
      updateTrackingDraft(o, { loading: false, error: "", success: "Completed on Etsy", tracking_code: trackingCode, carrier_name: carrierName });
      return true;
    } catch (e) {
      updateTrackingDraft(o, { loading: false, error: e.message || "Could not complete Etsy order", success: "" });
      return false;
    }
  };
  const createAtyaharaInvoiceForOrder = async order => {
    const receiptId = String(etsyReceiptId(order) || "");
    if (!receiptId) {
      setInvoiceState(s => ({ ...s, [receiptId || order.id]: { loading: false, error: "Missing Etsy receipt id.", success: "" } }));
      return;
    }
    setInvoiceState(s => ({ ...s, [receiptId]: { loading: true, error: "", success: "" } }));
    try {
      const rows = (orders || []).filter(o => isEtsyOrder(o) && String(etsyReceiptId(o)) === receiptId);
      const sourceRows = rows.length ? rows : [order];
      const currency = sourceRows.find(o => o.currency)?.currency || order.currency || "USD";
      const items = sourceRows.map((row, i) => {
        // sale_price is what the buyer actually paid for the line (after coupon) — the
        // invoice must bill real money, not the pre-discount list price.
        const qty = Math.max(1, +row.qty || 1);
        const rate = Number(((+row.sale_price || 0) / qty).toFixed(2));
        return {
          id: `etsy-${receiptId}-${row.etsy_transaction_id || row.listing_sku || i}`,
          desc: cleanInvoiceText(row.listing_title || `Etsy order #${receiptId}`),
          _title: row.listing_title || "",
          _shape: row.listing_shape || "",
          sku: row.listing_sku || row.etsy_transaction_id || "",
          hsn: "71031029",
          qty: String(qty),
          unit: "pcs",
          rate: String(rate),
          gst: "0",
          igst: 0,
          amt: Number((qty * rate).toFixed(2)),
          _etsyReceiptId: receiptId,
          _etsyTransactionId: row.etsy_transaction_id || "",
          _listingId: row.listing_id || "",
          _listingImage: findOrderImage(row),
        };
      });
      const { invoice, updated } = await upsertAtyaharaInvoiceFromEtsy({
        receiptId,
        orderDate: orderDate(order),
        buyer: { name: order.buyer_name || order.ship_name || "", email: order.buyer_email || "", country: order.buyer_country || order.ship_country || "" },
        address: {
          name: order.ship_name || order.buyer_name || "",
          line1: order.ship_address1 || "",
          line2: order.ship_address2 || "",
          city: order.ship_city || "",
          state: order.ship_state || "",
          postcode: order.ship_postcode || "",
          country: order.ship_country || order.buyer_country || "",
        },
        currency,
        items,
        notes: `Created from Listing Manager Etsy receipt #${receiptId}`,
        shippingCost: order.order_shipping != null ? +order.order_shipping : null,
      });
      await patchOrder(order, { _atInvoiceNo: invoice.invNo, _atInvoicedAt: now() });
      // Persist AI-inferred shapes back onto the order rows so the Shape field fills in
      // and the next invoice refresh reuses them without another AI call.
      try {
        const inferred = (invoice.items || []).filter(it => it._shape && it._etsyTransactionId);
        if (inferred.length) {
          const current = await loadK(ORDERS_KEY) || [];
          const byTxn = Object.fromEntries(inferred.map(it => [String(it._etsyTransactionId), it._shape]));
          const changed = current.filter(x => isEtsyOrder(x) && byTxn[String(x.etsy_transaction_id)] && !x.listing_shape)
            .map(x => ({ ...x, listing_shape: byTxn[String(x.etsy_transaction_id)] }));
          for (const rowPatch of changed) await upsertItemK(ORDERS_KEY, rowPatch, { prepend: false });
          if (changed.length) {
            const ids = new Set(changed.map(x => x.id));
            window.dispatchEvent(new CustomEvent("ng-orders-updated", { detail: current.map(x => ids.has(x.id) ? changed.find(c => c.id === x.id) : x) }));
          }
        }
      } catch {}
      setInvoiceState(s => ({ ...s, [receiptId]: { loading: false, error: "", success: `${updated ? "Updated" : "Created"} ${invoice.invNo}` } }));
    } catch (e) {
      setInvoiceState(s => ({ ...s, [receiptId]: { loading: false, error: e.message || "Could not create invoice", success: "" } }));
    }
  };
  const findOrderImage = o => {
    if (o.listing_image || o.image || o.images?.[0]) return o.listing_image || o.image || o.images?.[0];
    const norm = v => String(v || "").trim().toLowerCase();
    const direct = listings.find(l => o.listing_id && l.id === o.listing_id);
    const byEtsy = listings.find(l => o.etsy_listing_id && String(l.platforms?.etsy?.listing_id || "") === String(o.etsy_listing_id));
    const bySku = listings.find(l => o.listing_sku && norm(l.sku) === norm(o.listing_sku));
    const byTitle = listings.find(l => o.listing_title && norm(l.title) === norm(o.listing_title));
    return (direct || byEtsy || bySku || byTitle)?.images?.[0] || "";
  };
  const etsyImageFromTxn = txn => {
    const img = txn?.image_data || {};
    return img.url_570xN || img.url_fullxfull || img.url_170x135 || img.url_75x75 || "";
  };
  const etsyEmailFromReceipt = receipt => receipt?.buyer_email || receipt?.email || receipt?.customer_email || receipt?.customer?.email || receipt?.buyer?.email || "";
  const receiptTrackingCode = receipt => receipt?.tracking_code || receipt?.tracking_number || receipt?.shipments?.[0]?.tracking_code || receipt?.shipments?.[0]?.tracking_number || "";
  const receiptCarrierName = receipt => receipt?.carrier_name || receipt?.shipping_carrier || receipt?.shipments?.[0]?.carrier_name || receipt?.shipments?.[0]?.carrier || "";
  const receiptShippedAt = receipt => {
    const shipment = receipt?.shipments?.[0] || {};
    const ts = receipt?.shipped_timestamp || receipt?.ship_date || receipt?.shipped_at ||
      shipment.shipped_timestamp || shipment.shipment_notification_timestamp || shipment.mail_date ||
      shipment.created_timestamp || shipment.created_at;
    if (!ts) return "";
    if (typeof ts === "number") return new Date(ts * 1000).toISOString();
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  };
  const receiptIsShipped = receipt => {
    const status = String(receipt?.status || receipt?.shipping_status || "").toLowerCase();
    return !!(
      receipt?.is_shipped ||
      receipt?.was_shipped ||
      receiptTrackingCode(receipt) ||
      (receipt?.shipments || []).length ||
      ["shipped", "fulfilled", "pre_transit", "in_transit", "delivered"].includes(status)
    );
  };
  const etsyMoney = m => (m?.amount || 0) / (m?.divisor || 100);
  const etsyOrderDate = receipt => {
    const ts = receipt?.create_timestamp || receipt?.creation_tsz || receipt?.created_timestamp || receipt?.update_timestamp;
    return ts ? new Date(ts * 1000).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  };
  const etsyCreatedAt = receipt => {
    const ts = receipt?.create_timestamp || receipt?.creation_tsz || receipt?.created_timestamp || receipt?.update_timestamp;
    return new Date((ts || Date.now() / 1000) * 1000).toISOString();
  };
  const normalizeEtsyOrdersForERP = rawOrders => {
    const listingByEtsyId = {};
    (listings || []).forEach(l => {
      const id = l.platforms?.etsy?.listing_id;
      if (id) listingByEtsyId[String(id)] = l;
    });
    const rows = [];
    (rawOrders || []).forEach(receipt => {
      const txns = receipt.transactions?.length ? receipt.transactions : [null];
      const shipped = receiptIsShipped(receipt);
      txns.forEach((txn, idx) => {
        const etsyListingId = txn?.listing_id || "";
        const linked = etsyListingId ? listingByEtsyId[String(etsyListingId)] : null;
        const currency = txn?.price?.currency_code || receipt.grandtotal?.currency_code || "USD";
        const lineMoney = etsyReceiptLineMoney(receipt, txn, txns);
        rows.push({
          id:                `etsy-${receipt.receipt_id}-${txn?.transaction_id || etsyListingId || idx}`,
          order_number:      `ETSY-${receipt.receipt_id}${txns.length > 1 ? `-${idx + 1}` : ""}`,
          listing_id:        linked?.id || "",
          listing_title:     txn?.title || linked?.title || `Etsy order #${receipt.receipt_id}`,
          listing_material:  linked?.material || "",
          listing_shape:     linked?.shape || "",
          listing_sku:       txn?.sku || linked?.sku || "",
          listing_image:     etsyImageFromTxn(txn) || linked?.images?.[0] || "",
          platform:          "etsy",
          platform_order_id: String(receipt.receipt_id),
          etsy_listing_id:   etsyListingId,
          etsy_receipt_id:   receipt.receipt_id,
          etsy_transaction_id: txn?.transaction_id || "",
          ...lineMoney,
          currency,
          buyer_name:        receipt.name || etsyEmailFromReceipt(receipt) || "",
          buyer_country:     receipt.country_iso || "",
          buyer_email:       etsyEmailFromReceipt(receipt),
          ship_name:         receipt.name || "",
          ship_address1:     receipt.first_line || "",
          ship_address2:     receipt.second_line || "",
          ship_city:         receipt.city || "",
          ship_state:        receipt.state || "",
          ship_postcode:     receipt.zip || "",
          ship_country:      receipt.country_iso || "",
          ship_phone:        receipt.phone || receipt.formatted_phone || "",
          status:            shipped ? "shipped" : "sold",
          tracking_code:     receiptTrackingCode(receipt),
          tracking_number:   receiptTrackingCode(receipt),
          carrier_name:      receiptCarrierName(receipt) || "other",
          shipped_at:        shipped ? receiptShippedAt(receipt) || new Date().toISOString() : "",
          date:              etsyOrderDate(receipt),
          notes:             receipt.message_from_buyer || "",
          created_at:        etsyCreatedAt(receipt),
          source:            "etsy-sync",
        });
      });
    });
    return rows;
  };
  const etsyOrderPatchMap = rawOrders => {
    const patches = {};
    const byReceipt = {};
    (rawOrders || []).forEach(receipt => {
      const txns = receipt.transactions?.length ? receipt.transactions : [null];
      const receiptId = String(receipt.receipt_id || "");
      const shipped = receiptIsShipped(receipt);
      byReceipt[receiptId] = {
        buyer_email: etsyEmailFromReceipt(receipt),
        buyer_name: receipt.name || etsyEmailFromReceipt(receipt),
        buyer_country: receipt.country_iso || "",
        ship_name: receipt.name || "",
        ship_address1: receipt.first_line || "",
        ship_address2: receipt.second_line || "",
        ship_city: receipt.city || "",
        ship_state: receipt.state || "",
        ship_postcode: receipt.zip || "",
        ship_country: receipt.country_iso || "",
        ship_phone: receipt.phone || receipt.formatted_phone || "",
        tracking_code: receiptTrackingCode(receipt),
        tracking_number: receiptTrackingCode(receipt),
        carrier_name: receiptCarrierName(receipt),
        status: shipped ? "shipped" : "sold",
        shipped_at: shipped ? receiptShippedAt(receipt) || new Date().toISOString() : "",
        etsy_live_is_shipped: shipped,
        etsy_status_synced_at: new Date().toISOString(),
      };
      txns.forEach((txn, idx) => {
        const listingId = txn?.listing_id || "";
        const txnId = txn?.transaction_id || "";
        const id = `etsy-${receiptId}-${txnId || listingId || idx}`;
        patches[id] = {
          ...byReceipt[receiptId],
          ...etsyReceiptLineMoney(receipt, txn, txns),
          listing_image: etsyImageFromTxn(txn),
          etsy_listing_id: listingId,
        };
      });
    });
    return { patches, byReceipt };
  };
  const mergeEtsyBackfill = async rawOrders => {
    const { patches, byReceipt } = etsyOrderPatchMap(rawOrders);
    if (!Object.keys(patches).length && !Object.keys(byReceipt).length) return false;
    const current = await loadK(ORDERS_KEY);
    let changed = false;
    const baseOrders = current || orders || [];
    const changedRows = [];
    const nextExisting = baseOrders.map(order => {
      if (order.platform !== "etsy") return order;
      const receiptId = String(order.etsy_receipt_id || order.platform_order_id || String(order.order_number || "").replace(/^ETSY-/, "").split("-")[0]);
      const candidates = [
        order.id,
        order.etsy_transaction_id ? `etsy-${receiptId}-${order.etsy_transaction_id}` : "",
        order.etsy_listing_id ? `etsy-${receiptId}-${order.etsy_listing_id}` : "",
      ].filter(Boolean);
      const patch = candidates.map(k => patches[k]).find(Boolean) || byReceipt[receiptId];
      if (!patch) return order;
      const merged = { ...order };
      // Money fields always refresh from Etsy — older rows recorded the pre-discount
      // line price as sale_price, so filling-only-when-missing would never correct them.
      const MONEY_KEYS = ["sale_price", "list_price", "discount", "qty", "order_subtotal", "order_shipping", "order_tax", "order_total"];
      Object.entries(patch).forEach(([k, v]) => {
        if (["status", "shipped_at", "tracking_code", "tracking_number", "carrier_name", "etsy_live_is_shipped", "etsy_status_synced_at"].includes(k)) {
          if (v || k === "shipped_at") merged[k] = v;
        } else if (MONEY_KEYS.includes(k)) {
          if (v != null) merged[k] = v;
        } else if (v && !merged[k]) {
          merged[k] = v;
        }
      });
      if (JSON.stringify(merged) !== JSON.stringify(order)) {
        changed = true;
        changedRows.push(merged);
      }
      return merged;
    });
    const existingIds = new Set(nextExisting.map(o => o.id));
    const additions = normalizeEtsyOrdersForERP(rawOrders).filter(o => !existingIds.has(o.id));
    if (additions.length) changed = true;
    const next = [...additions, ...nextExisting]
      .sort((a, b) => new Date(b.created_at || b.date || 0) - new Date(a.created_at || a.date || 0));
    if (changed) {
      for (const order of [...additions, ...changedRows]) await upsertItemK(ORDERS_KEY, order, { prepend: true });
      window.dispatchEvent(new CustomEvent("ng-orders-updated", { detail: next }));
    }
    return changed;
  };

  // Etsy fees & net earnings live on the payment record, not the receipt. Fetch them
  // once per receipt (they're stable after payment) and allocate to line rows by sale
  // value so per-row "earned" sums back to the receipt's net.
  const backfillEtsyFees = async receipts => {
    try {
      const current = await loadK(ORDERS_KEY) || [];
      const feesKnown = new Set(current
        .filter(o => o.platform === "etsy" && o.etsy_fee_version === 3)
        .map(o => String(o.etsy_receipt_id || o.platform_order_id)));
      const ids = [...new Set((receipts || []).map(r => String(r.receipt_id || "")).filter(id => id && !feesKnown.has(id)))].slice(0, 40);
      if (!ids.length) return;
      const tok = await getEtsyToken();
      const r = await fetch(`/api/etsy?action=payments&receipt_ids=${ids.join(",")}&_=${Date.now()}`, { headers: tok ? { "X-Etsy-Token": tok } : {}, cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      const pay = d?.payments || {};
      if (!Object.keys(pay).length) return;
      const fresh = await loadK(ORDERS_KEY) || [];
      const changedRows = [];
      const next = fresh.map(o => {
        if (o.platform !== "etsy") return o;
        const rid = String(o.etsy_receipt_id || o.platform_order_id || "");
        const p = pay[rid];
        if (!p) return o;
        const siblings = fresh.filter(x => x.platform === "etsy" && String(x.etsy_receipt_id || x.platform_order_id) === rid);
        const sum = siblings.reduce((s, x) => s + (+x.sale_price || 0), 0);
        const share = sum > 0 ? (+o.sale_price || 0) / sum : 1 / Math.max(1, siblings.length);
        const merged = {
          ...o,
          order_gross: p.gross,
          order_fees: p.fees,
          order_net: p.net,
          fees_currency: p.currency || o.currency,
          etsy_fees: Number((p.fees * share).toFixed(2)),
          etsy_net: Number((p.net * share).toFixed(2)),
          etsy_fee_source: p.source || "amount",
          etsy_processing_fee: null,
          etsy_transaction_fee: null,
          etsy_fee_version: 3,
        };
        if (JSON.stringify(merged) !== JSON.stringify(o)) changedRows.push(merged);
        return merged;
      });
      if (changedRows.length) {
        for (const order of changedRows) await upsertItemK(ORDERS_KEY, order, { prepend: false });
        window.dispatchEvent(new CustomEvent("ng-orders-updated", { detail: next }));
      }
    } catch {}
  };

  useEffect(() => {
    const hasEtsyOrders = (orders || []).some(o => o.platform === "etsy");
    const needsBackfill = hasEtsyOrders || (orders || []).some(o => o.platform === "etsy" && (!findOrderImage(o) || !o.buyer_email || !o.ship_address1));
    if (!needsBackfill || etsyBackfillRef.current) return;
    etsyBackfillRef.current = true;
    setEtsyBackfilling(true);
    // Incremental backfill: a full pull of all paid receipts (~37s and growing) was timing out
    // intermittently and silently dropping new orders. Default to only re-pulling receipts created
    // since our newest Etsy order (minus a buffer so recent shipping/status changes stay fresh) —
    // fast (~3s) and reliable. A full resync runs at most once a day to reconcile older orders.
    const FULL_MS = 24 * 60 * 60 * 1000, BUFFER_S = 3 * 24 * 60 * 60;
    let lastFull = 0;
    try { lastFull = +localStorage.getItem("ng-orders-etsy-fullbackfill-ts") || 0; } catch {}
    const hasBaseline = lastFull > 0;
    const newestMs = (orders || [])
      .filter(o => o.platform === "etsy")
      .reduce((m, o) => Math.max(m, Date.parse(o.created_at || o.date) || 0), 0);
    const doFull = newestMs <= 0 || (hasBaseline && (Date.now() - lastFull) >= FULL_MS);
    let url = `/api/etsy?action=orders&limit=100&enrich=true&_=${Date.now()}`;
    if (!doFull) url += `&min_created=${Math.max(0, Math.floor(newestMs / 1000) - BUFFER_S)}`;
    // Resolve a FRESH token (refresh + Supabase fallback). The old code sent the raw localStorage
    // token, which expires hourly — a stale token 401'd and silently dropped new orders until the
    // user manually reconnected Etsy.
    getEtsyToken()
      .then(tok => fetch(url, { headers: tok ? { "X-Etsy-Token": tok } : {}, cache: "no-store" }))
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return;
        // Record the full-resync clock on a real full pull, or to bootstrap it on first run.
        if (doFull || !hasBaseline) { try { localStorage.setItem("ng-orders-etsy-fullbackfill-ts", String(Date.now())); } catch {} }
        return mergeEtsyBackfill(d?.results || []).then(() => backfillEtsyFees(d?.results || []));
      })
      .catch(() => {})
      .finally(() => setEtsyBackfilling(false));
  }, [orders, listings]);

  const filtered = (orders || [])
    .filter(o => pFilter === "all" || o.platform === pFilter)
    .filter(o => shipFilter === "all" || (shipFilter === "shipped" ? isShipped(o) : !isShipped(o)))
    .filter(o => !search || [
      o.listing_title, o.buyer_name, o.buyer_email, o.order_number, o.platform_order_id,
      o.listing_sku, o.buyer_country, o.ship_address1, o.ship_city, o.ship_postcode,
    ]
      .join(" ").toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => new Date(b.created_at || b.date) - new Date(a.created_at || a.date));

  const revenueByCurrency = filtered.reduce((m, o) => {
    const c = o.currency || "INR";
    m[c] = (m[c] || 0) + (+o.sale_price || 0);
    return m;
  }, {});
  const revenueLabel = Object.entries(revenueByCurrency).map(([c, v]) => money(v, c)).join(" · ") || money(0);
  const shippedCount = (orders || []).filter(isShipped).length;
  const unshippedCount = (orders || []).length - shippedCount;

  const FILTER_OPTS = [
    { key: "all",    label: "All",      icon: "📦" },
    ...PLATFORMS.filter(p => !p.coming),
    { key: "manual", label: "Manual",   icon: "✏️", color: C.inkMid },
  ];
  const SHIP_OPTS = [
    { key:"all", label:"All", n:orders.length, color:C.ink, bg:C.card },
    { key:"unshipped", label:"Unshipped", n:unshippedCount, color:C.amber, bg:C.amberBg },
    { key:"shipped", label:"Shipped", n:shippedCount, color:C.green, bg:C.greenBg },
  ];

  return (
    <div>
      {trackingModalOrder && (() => {
        const order = trackingModalOrder;
        const draft = trackingDraft(order);
        return (
          <div onMouseDown={() => setTrackingModalOrder(null)} style={{ position: "fixed", inset: 0, zIndex: 900, display: "grid", placeItems: "center", padding: 18, background: "rgba(24,19,12,.46)" }}>
            <div onMouseDown={e => e.stopPropagation()} style={{ width: "min(100%, 520px)", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: "0 24px 70px rgba(0,0,0,.24)", padding: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 14, alignItems: "flex-start", marginBottom: 18 }}>
                <div><div style={{ fontSize: 18, fontWeight: 850, color: C.ink }}>Ship on Etsy</div><div style={{ marginTop: 4, fontSize: 12, color: C.inkMid }}>Etsy will mark this receipt shipped and email the buyer.</div></div>
                <button onClick={() => setTrackingModalOrder(null)} aria-label="Close" style={{ border: "none", background: "transparent", color: C.inkMid, fontSize: 22, cursor: "pointer", lineHeight: 1 }}>×</button>
              </div>
              <div style={{ display: "grid", gap: 11 }}>
                <label style={{ fontSize: 11, fontWeight: 800, color: C.inkMid }}>Tracking number<input autoFocus value={draft.tracking_code} onChange={e => updateTrackingDraft(order, { tracking_code: e.target.value })} placeholder="e.g. 1234 5678 90" style={{ ...FI(), width: "100%", marginTop: 5, padding: "10px 11px" }} /></label>
                <label style={{ fontSize: 11, fontWeight: 800, color: C.inkMid }}>Carrier<select value={draft.carrier_name} onChange={e => updateTrackingDraft(order, { carrier_name: e.target.value })} style={{ ...FI(), width: "100%", marginTop: 5, padding: "10px 11px", cursor: "pointer" }}><option value="other">Other</option><option value="dhl">DHL</option><option value="fedex">FedEx</option><option value="ups">UPS</option><option value="usps">USPS</option><option value="india-post">India Post</option><option value="bluedart">Blue Dart</option></select></label>
                <label style={{ fontSize: 11, fontWeight: 800, color: C.inkMid }}>Tracking link <span style={{ fontWeight: 500 }}>(optional, internal reference)</span><input value={order.tracking_url || ""} onChange={e => setOrderTrackingUrl(order, e.target.value)} placeholder="https://…" style={{ ...FI(), width: "100%", marginTop: 5, padding: "10px 11px" }} /></label>
                <label style={{ fontSize: 11, fontWeight: 800, color: C.inkMid }}>Note to buyer <span style={{ fontWeight: 500 }}>(optional)</span><input value={draft.note_to_buyer || ""} onChange={e => updateTrackingDraft(order, { note_to_buyer: e.target.value })} placeholder="A short shipping note" style={{ ...FI(), width: "100%", marginTop: 5, padding: "10px 11px" }} /></label>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: C.inkMid, cursor: "pointer" }}><input type="checkbox" checked={!!draft.send_bcc} onChange={e => updateTrackingDraft(order, { send_bcc: e.target.checked })} /> Send me Etsy's shipping email too</label>
              </div>
              <div style={{ marginTop: 12, padding: "8px 10px", borderRadius: 7, background: C.card, color: C.inkMid, fontSize: 11, lineHeight: 1.45 }}>This does not buy a label or confirm a carrier scan. The tracking link above stays in this app; Etsy receives the carrier and tracking number.</div>
              {draft.error && <div style={{ marginTop: 12, fontSize: 12, color: C.red, background: C.redBg, border: `1px solid ${C.red}30`, borderRadius: 7, padding: "8px 10px" }}>{draft.error}</div>}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 9, marginTop: 18 }}>
                <button onClick={() => setTrackingModalOrder(null)} style={{ background: C.card, color: C.ink, border: `1px solid ${C.border}`, borderRadius: 7, padding: "9px 13px", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>Cancel</button>
                <button onClick={async () => { if (await completeEtsyOrder(order)) setTrackingModalOrder(null); }} disabled={!!draft.loading} style={{ background: "#F56400", color: "#fff", border: "none", borderRadius: 7, padding: "9px 14px", fontSize: 12, fontWeight: 850, cursor: draft.loading ? "wait" : "pointer", opacity: draft.loading ? .7 : 1 }}>{draft.loading ? "Sending…" : "Send to Etsy & complete"}</button>
              </div>
            </div>
          </div>
        );
      })()}
      {stockModalOrder && (() => {
        const order = stockModalOrder;
        const q = (stockSearch[order.id] || "").trim().toLowerCase();
        const tokens = q.split(/\s+/).filter(Boolean);
        const matches = tokens.length
          ? stock.filter(s => { const h = `${s.material || ""} ${s.desc || ""} ${s.shape || ""} ${s.sku || ""} ${s.location || ""} ${s.productType || ""}`.toLowerCase(); return tokens.every(t => h.includes(t)); })
          : stock;
        const thumb = (s, size) => s.photo
          ? <img src={s.photo} alt="" loading="lazy" style={{ width: size, height: size, objectFit: "cover", borderRadius: 8, flexShrink: 0, border: `1px solid ${C.border}` }} />
          : <div style={{ width: size, height: size, borderRadius: 8, flexShrink: 0, background: C.card, border: `1px solid ${C.border}`, display: "grid", placeItems: "center", fontSize: Math.round(size * 0.42) }}>💎</div>;
        const pick = s => { linkOrderStock(order, s.id); updNg(order, { qty: "1" }); setStockSearch(m => ({ ...m, [order.id]: "" })); setStockModalOrder(null); };
        return (
          <div onMouseDown={() => setStockModalOrder(null)} style={{ position: "fixed", inset: 0, zIndex: 950, display: "grid", placeItems: "center", padding: 18, background: "rgba(24,19,12,.46)" }}>
            <div onMouseDown={e => e.stopPropagation()} style={{ width: "min(100%, 620px)", maxHeight: "86vh", display: "flex", flexDirection: "column", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, boxShadow: "0 24px 70px rgba(0,0,0,.28)", overflow: "hidden" }}>
              <div style={{ padding: "18px 20px 12px", borderBottom: `1px solid ${C.border}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 14, alignItems: "flex-start", marginBottom: 12 }}>
                  <div><div style={{ fontSize: 18, fontWeight: 850, color: C.ink }}>Choose stock</div><div style={{ marginTop: 3, fontSize: 12, color: C.inkMid }}>Pick the physical item that filled this order.</div></div>
                  <button onClick={() => setStockModalOrder(null)} aria-label="Close" style={{ border: "none", background: "transparent", color: C.inkMid, fontSize: 22, cursor: "pointer", lineHeight: 1 }}>×</button>
                </div>
                <input autoFocus value={stockSearch[order.id] || ""} onChange={e => setStockSearch(s => ({ ...s, [order.id]: e.target.value }))} placeholder="Search by stone, shape, SKU or location" style={{ ...FI(), width: "100%", fontSize: 14, padding: "11px 13px" }} />
              </div>
              <div style={{ overflowY: "auto", padding: 8 }}>
                {matches.length === 0
                  ? <div style={{ padding: "34px 12px", fontSize: 13, color: C.inkFaint, textAlign: "center" }}>No stock matches “{stockSearch[order.id]}”</div>
                  : matches.slice(0, 60).map(s => {
                    const out = (+s.qty || 0) <= 0;
                    return <button key={s.id} onClick={() => pick(s)} style={{ display: "flex", gap: 12, alignItems: "center", width: "100%", textAlign: "left", padding: "10px 12px", background: "transparent", border: "none", borderRadius: 9, cursor: "pointer" }}
                      onMouseEnter={e => e.currentTarget.style.background = C.card} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                      {thumb(s, 52)}
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 800, color: C.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.material || s.desc || "Item"}{s.shape ? ` · ${s.shape}` : ""}</div>
                        <div style={{ fontSize: 11.5, color: C.inkMid, marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.location ? `🗄 ${s.location} · ` : ""}{s.sku ? `${s.sku} · ` : ""}💰 {s.costPrice ? money(s.costPrice, "INR") : "cost —"}</div>
                      </div>
                      <div style={{ flexShrink: 0, textAlign: "right" }}>
                        <div style={{ fontSize: 13, fontWeight: 850, color: out ? C.red : C.green }}>{s.qty} {s.unit || "pcs"}</div>
                        {String(s.qty2 || "").trim() !== "" && <div style={{ fontSize: 10.5, color: C.inkFaint }}>{s.qty2} {s.unit2 || ""}</div>}
                      </div>
                    </button>;
                  })}
              </div>
            </div>
          </div>
        );
      })()}
      {invoiceModalOrder && (() => {
        const order = invoiceModalOrder;
        const q = invoiceModalSearch.trim().toLowerCase();
        const qTokens = q.split(/\s+/).filter(Boolean);
        const list = [...atInvoices]
          .filter(inv => { if (!qTokens.length) return true; const h = `${invNoOf(inv)} ${inv.buyerName || inv.buyer || ""} ${inv.consigneeName || ""}`.toLowerCase(); return qTokens.every(t => h.includes(t)); })
          .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
        const suggested = !q ? normName(order.buyer_name) : "";
        const ranked = suggested ? [...list].sort((a, b) => (normName(b.buyerName || b.buyer) === suggested ? 1 : 0) - (normName(a.buyerName || a.buyer) === suggested ? 1 : 0)) : list;
        return (
          <div onMouseDown={() => setInvoiceModalOrder(null)} style={{ position: "fixed", inset: 0, zIndex: 950, display: "grid", placeItems: "center", padding: 18, background: "rgba(24,19,12,.46)" }}>
            <div onMouseDown={e => e.stopPropagation()} style={{ width: "min(100%, 620px)", maxHeight: "86vh", display: "flex", flexDirection: "column", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, boxShadow: "0 24px 70px rgba(0,0,0,.28)", overflow: "hidden" }}>
              <div style={{ padding: "18px 20px 12px", borderBottom: `1px solid ${C.border}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 14, alignItems: "flex-start", marginBottom: 12 }}>
                  <div><div style={{ fontSize: 18, fontWeight: 850, color: C.ink }}>Link an existing invoice</div><div style={{ marginTop: 3, fontSize: 12, color: C.inkMid }}>Mark this order's sales invoice as already created for <b>{order.buyer_name || "this buyer"}</b>.</div></div>
                  <button onClick={() => setInvoiceModalOrder(null)} aria-label="Close" style={{ border: "none", background: "transparent", color: C.inkMid, fontSize: 22, cursor: "pointer", lineHeight: 1 }}>×</button>
                </div>
                <input autoFocus value={invoiceModalSearch} onChange={e => setInvoiceModalSearch(e.target.value)} placeholder="Search invoice no. or buyer" style={{ ...FI(), width: "100%", fontSize: 14, padding: "11px 13px" }} />
              </div>
              <div style={{ overflowY: "auto", padding: 8 }}>
                {ranked.length === 0
                  ? <div style={{ padding: "34px 12px", fontSize: 13, color: C.inkFaint, textAlign: "center" }}>No invoices found</div>
                  : ranked.slice(0, 60).map(inv => {
                    const isSuggested = suggested && normName(inv.buyerName || inv.buyer) === suggested;
                    return <button key={inv.id} onClick={() => linkOrderInvoice(order, inv)} style={{ display: "flex", gap: 12, alignItems: "center", width: "100%", textAlign: "left", padding: "10px 12px", background: "transparent", border: "none", borderRadius: 9, cursor: "pointer" }}
                      onMouseEnter={e => e.currentTarget.style.background = C.card} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 800, color: C.ink }}>{invNoOf(inv) || "(no number)"}{isSuggested && <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 800, color: C.green, background: C.greenBg, borderRadius: 20, padding: "2px 8px" }}>likely match</span>}</div>
                        <div style={{ fontSize: 11.5, color: C.inkMid, marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{inv.buyerName || inv.buyer || "Buyer"}{inv.date ? ` · ${new Date(inv.date).toLocaleDateString("en-GB")}` : ""}</div>
                      </div>
                      <div style={{ flexShrink: 0, fontSize: 12.5, fontWeight: 850, color: C.ink }}>{money(invAmt(inv), inv.currency || "INR")}</div>
                    </button>;
                  })}
              </div>
            </div>
          </div>
        );
      })()}
      {/* stats */}
      <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr 1fr" : "repeat(4,1fr)", gap: 10, marginBottom: 14 }}>
        {[
          { label: "Total Orders",  val: orders.length,     color: C.ink, bg: C.surface },
          { label: "Unshipped",     val: unshippedCount,    color: C.amber, bg: C.amberBg },
          { label: "Shipped",       val: shippedCount,      color: C.green, bg: C.greenBg },
          { label: "Revenue",       val: revenueLabel,      color: C.blue, bg: C.blueBg },
        ].map(s => (
          <div key={s.label} style={{ background: s.bg, border: `1.5px solid ${C.border}`, borderRadius: 12, padding: "13px 15px", minHeight: 74 }}>
            <div style={{ fontSize: 9, color: s.color, textTransform: "uppercase", letterSpacing: .7, fontWeight: 800, marginBottom: 6 }}>{s.label}</div>
            <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 24, fontWeight: 700, color: C.ink, lineHeight: 1.05 }}>{s.val}</div>
          </div>
        ))}
      </div>

      {/* filter bar */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 4, background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 3 }}>
          {SHIP_OPTS.map(opt => {
            const on = shipFilter === opt.key;
            return (
            <button key={opt.key} onClick={() => setShipFilter(opt.key)}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 13px", borderRadius: 8, fontSize: 12, cursor: "pointer",
                border: on ? `1.5px solid ${opt.color}55` : "1.5px solid transparent",
                fontWeight: on ? 850 : 600,
                background: on ? opt.bg : "transparent",
                color: on ? opt.color : C.inkMid }}>
              {opt.label} <span style={{ fontWeight: 850, fontSize: 11, padding: "1px 7px", borderRadius: 20, background: on ? "#fff9" : C.card, color: on ? opt.color : C.inkFaint }}>{opt.n}</span>
            </button>
          ); })}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {FILTER_OPTS.map(p => (
            <button key={p.key} onClick={() => setPFilter(p.key)}
              style={{ padding: "6px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer",
                fontWeight: pFilter === p.key ? 700 : 400,
                border: `1.5px solid ${pFilter === p.key ? (p.color || C.gold) : C.border}`,
                background: pFilter === p.key ? (p.color || C.gold) + "20" : C.surface,
                color: pFilter === p.key ? (p.color || C.ink) : C.inkMid }}>
              {p.icon} {p.label}
            </button>
          ))}
        </div>
        <button onClick={reconcileInvoices} disabled={reconciling} title="Match unshipped/unlinked Etsy orders to invoices you already created in Invoicing"
          style={{ marginLeft: "auto", background: reconciling ? C.card : C.blueBg, color: C.blue, border: `1.5px solid ${C.blue}55`, borderRadius: 10, padding: "8px 13px", fontSize: 12, fontWeight: 800, cursor: reconciling ? "wait" : "pointer", whiteSpace: "nowrap" }}>
          {reconciling ? "Matching…" : "🔗 Link existing invoices"}
        </button>
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search buyer, email, SKU, order..."
          style={{ ...FI(), width: mob() ? "100%" : 260, fontSize: 12, padding: "8px 13px", borderRadius: 10 }} />
      </div>
      {etsyBackfilling && (
        <div style={{ marginBottom: 10, background: C.blueBg, border: `1px solid ${C.blue}25`, color: C.blue, borderRadius: 9, padding: "8px 11px", fontSize: 12, fontWeight: 700 }}>
          Refreshing Etsy order photos and contact details...
        </div>
      )}

      {/* order list */}
      {filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 0", color: C.inkFaint }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>📦</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>No orders yet</div>
          <div style={{ fontSize: 12 }}>Use "Mark Sold" on any live listing to record a sale here.</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map(order => {
            const p = PLATFORMS.find(x => x.key === order.platform) || { label: "Manual", icon: "✏️", color: C.inkMid };
            const isExp = expanded === order.id;
            const shipped = isShipped(order);
            const status = shipped ? "shipped" : "unshipped";
            // Fulfilment step the panels show. Auto-advances to the first incomplete step,
            // but the stepper lets the user click any step to open it (nothing is blocked).
            const etsyDone = [shipped, !!order.linked_stock_id, !!order._atInvoiceNo, !!order._ngInvoiceNo];
            const etsyFirstOpen = etsyDone.findIndex(d => !d);
            const selStep = stepSel[order.id] != null ? stepSel[order.id] : (etsyFirstOpen === -1 ? 3 : etsyFirstOpen);
            const addr = addressLines(order);
            const copyAddress = addr.join("\n");
            const image = findOrderImage(order);
            return (
              <div key={order.id}
                style={{ background: C.surface, border: `1.5px solid ${isExp ? p.color || C.gold : C.border}`, borderRadius: 12, overflow: "hidden", boxShadow: isExp ? "0 8px 28px rgba(0,0,0,.08)" : "0 1px 5px rgba(0,0,0,.04)" }}>
                {/* row */}
                <div style={{
                  display: "grid",
                  gridTemplateColumns: mob() ? "54px minmax(0,1fr)" : "58px minmax(280px,2fr) minmax(120px,.6fr) 120px",
                  gap: mob() ? 10 : 14,
                  alignItems: "center",
                  padding: mob() ? 10 : "9px 12px",
                  cursor: "pointer",
                }}
                  onClick={() => setExpanded(isExp ? null : order.id)}>
                  <div style={{ width: 54, height: 54, borderRadius: 9, overflow: "hidden",
                    background: C.card, flexShrink: 0, border: `1px solid ${C.border}` }}>
                    {image
                      ? <img src={image} alt="" loading="eager" decoding="async" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>💎</div>}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", marginBottom: 4 }}>
                      <span style={{ fontSize: 11, fontWeight: 800, fontFamily: "monospace", color: p.color || C.gold }}>{order.order_number}</span>
                      <span style={{ fontSize: 14, fontWeight: 750, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                        {order.listing_title}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: C.inkFaint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {[order.buyer_name, order.buyer_email, order.listing_sku || order.etsy_transaction_id || order.platform_order_id]
                        .filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <div style={{ display: mob() ? "none" : "block" }}>
                    <div style={{ fontSize: 11, color: p.color, fontWeight: 750 }}>{p.icon} {p.label}</div>
                    <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 2 }}>{new Date(orderDate(order)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</div>
                  </div>
                  <div style={{ textAlign: mob() ? "left" : "right", gridColumn: mob() ? "2 / 3" : "auto" }}>
                    <div style={{ fontSize: 16, fontWeight: 850, color: C.green }}>{money(order.sale_price, order.currency)}</div>
                    <div style={{ marginTop: 3 }}><StatusPill status={status} /></div>
                  </div>
                </div>

                {/* expanded detail */}
                {isExp && (
                  <div style={{ borderTop: `1px solid ${C.border}`, padding: "13px 14px", background: C.bg }}>
                    {isEtsyOrder(order) && (
                      (() => {
                        const ETSY = "#F56400";
                        const stages = [
                          ["Ship on Etsy", "Send carrier + tracking", shipped],
                          ["Allocate stock", "Choose item & quantity", !!order.linked_stock_id],
                          ["Sales invoice", "Invoice the Etsy buyer", !!order._atInvoiceNo],
                          ["NG invoice", "Record stock at cost", !!order._ngInvoiceNo],
                        ];
                        const firstOpen = stages.findIndex(stage => !stage[2]);
                        const activeIndex = firstOpen === -1 ? stages.length - 1 : firstOpen;
                        const doneCount = stages.filter(stage => stage[2]).length;
                        const allDone = doneCount === stages.length;
                        const sel = stepSel[order.id] != null ? stepSel[order.id] : activeIndex;
                        const pct = Math.round((doneCount / stages.length) * 100);
                        return <div style={{ marginBottom: 14 }}>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                            <span style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: .7, color: C.inkFaint }}>Fulfilment</span>
                            <span style={{ fontSize: 11, fontWeight: 850, color: allDone ? C.green : C.inkMid }}>{allDone ? "✓ Complete" : `${doneCount} of ${stages.length} done`}</span>
                          </div>
                          {/* segmented progress bar */}
                          <div style={{ display: "grid", gridTemplateColumns: `repeat(${stages.length}, 1fr)`, gap: 4, marginBottom: 12 }}>
                            {stages.map(([label], index) => (
                              <div key={label} style={{ height: 6, borderRadius: 4, background: stages[index][2] ? C.green : index === activeIndex && !allDone ? ETSY : C.border, opacity: stages[index][2] || (index === activeIndex && !allDone) ? 1 : .5, transition: "background .2s" }} />
                            ))}
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr 1fr" : "repeat(4, minmax(0, 1fr))", gap: 8 }}>
                            {stages.map(([label, note, complete], index) => {
                              const selected = index === sel;
                              const accent = complete ? C.green : index === activeIndex ? ETSY : C.border;
                              return <button key={label} onClick={() => setStepSel(s => ({ ...s, [order.id]: index }))} style={{ textAlign: "left", cursor: "pointer", fontFamily: "inherit", minWidth: 0, padding: "10px 11px", borderRadius: 10, background: selected ? C.surface : complete ? C.greenBg : C.bg, border: `1.5px solid ${selected ? accent : complete ? C.green + "66" : C.border}`, boxShadow: selected ? `0 0 0 3px ${accent}22` : "none", opacity: complete || selected || index === activeIndex ? 1 : .62, transition: "box-shadow .15s, border-color .15s" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                                  <span style={{ width: 22, height: 22, flexShrink: 0, display: "grid", placeItems: "center", borderRadius: "50%", background: complete ? C.green : index === activeIndex ? ETSY : C.card, color: complete || index === activeIndex ? "#fff" : C.inkFaint, fontSize: 11, fontWeight: 900 }}>{complete ? "✓" : index + 1}</span>
                                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5, fontWeight: 850, color: C.ink }}>{label}</span>
                                </div>
                                <div style={{ marginTop: 6, fontSize: 10.5, color: C.inkMid, lineHeight: 1.3 }}>{note}</div>
                              </button>;
                            })}
                          </div>
                        </div>;
                      })()
                    )}
                    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
                      <button onClick={() => setDetailsOpen(s => ({ ...s, [order.id]: !s[order.id] }))} style={{ border: "none", background: "transparent", color: C.inkMid, fontSize: 11, fontWeight: 750, cursor: "pointer", padding: 0 }}>{detailsOpen[order.id] ? "Hide order details" : "Order details"}</button>
                    </div>
                    {detailsOpen[order.id] && <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "1fr 1fr", gap: 10, marginBottom: 10 }}>
                      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12 }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
                          <div style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: .6, color: C.inkFaint }}>Ship To</div>
                          <button onClick={() => copyText(`address-${order.id}`, copyAddress)}
                            disabled={!copyAddress}
                            style={{ background: copied === `address-${order.id}` ? C.green : C.card, border: `1px solid ${copied === `address-${order.id}` ? C.green : C.border}`, borderRadius: 7, padding: "5px 9px", fontSize: 11, fontWeight: 750, color: copied === `address-${order.id}` ? "#fff" : C.ink, cursor: copyAddress ? "pointer" : "not-allowed" }}>
                            {copied === `address-${order.id}` ? "Copied" : "Copy Address"}
                          </button>
                        </div>
                        <div style={{ whiteSpace: "pre-line", fontSize: 13, color: C.ink, lineHeight: 1.55, minHeight: 44 }}>
                          {copyAddress || "No shipping address stored yet"}
                        </div>
                      </div>
                      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12 }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
                          <div style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: .6, color: C.inkFaint }}>Buyer Contact</div>
                          {order.buyer_email && (
                            <button onClick={() => copyText(`email-${order.id}`, order.buyer_email || "")}
                              style={{ background: copied === `email-${order.id}` ? C.green : C.card, border: `1px solid ${copied === `email-${order.id}` ? C.green : C.border}`, borderRadius: 7, padding: "5px 9px", fontSize: 11, fontWeight: 750, color: copied === `email-${order.id}` ? "#fff" : C.ink, cursor: "pointer" }}>
                              {copied === `email-${order.id}` ? "Copied" : "Copy Email"}
                            </button>
                          )}
                        </div>
                        <div style={{ fontSize: 13, color: C.ink, lineHeight: 1.55 }}>
                          <div style={{ fontWeight: 750 }}>{order.buyer_name || "No buyer name"}</div>
                          {order.buyer_email && <div>{order.buyer_email}</div>}
                          {order.ship_phone && <div>{order.ship_phone}</div>}
                        </div>
                      </div>
                    </div>}
                    {isEtsyOrder(order) && selStep === 0 && (
                      <div style={{ background: C.surface, border: `1.5px solid ${shipped ? C.green : "#F56400"}`, borderLeft: `4px solid ${shipped ? C.green : "#F56400"}`, borderRadius: 10, padding: 14, marginBottom: 10 }}>
                        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 15, fontWeight: 850, color: C.ink }}>{shipped ? "Shipped on Etsy" : "Ship this order on Etsy"}</div>
                            <div style={{ fontSize: 12, color: C.inkMid, marginTop: 3, lineHeight: 1.4 }}>{shipped ? "Etsy has this order marked shipped and the buyer notified." : "Add a carrier & tracking number — Etsy marks it shipped and emails the buyer."}</div>
                          </div>
                          <div style={{ fontSize: 11, color: C.inkFaint, fontWeight: 700, whiteSpace: "nowrap" }}>Receipt #{etsyReceiptId(order)}</div>
                        </div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 12 }}>
                          {shipped
                            ? <>
                                <span style={{ fontSize: 12, fontWeight: 800, color: C.green }}>✓ {order.tracking_code || order.tracking_number || "Tracking sent"}</span>
                                {/^https?:\/\//i.test(order.tracking_url || "") && <a href={order.tracking_url} target="_blank" rel="noopener noreferrer" style={{ color: C.blue, fontSize: 12, fontWeight: 750, textDecoration: "none" }}>Open tracking link</a>}
                                <button onClick={() => setTrackingModalOrder(order)} style={{ background: C.card, color: C.ink, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>Update tracking</button>
                              </>
                            : <button onClick={() => setTrackingModalOrder(order)} style={{ background: "#F56400", color: "#fff", border: "none", borderRadius: 8, padding: "9px 16px", fontSize: 12.5, fontWeight: 850, cursor: "pointer" }}>Add tracking & ship</button>}
                          {trackingDraft(order).error && needsEtsyReconnect(trackingDraft(order).error) && <button onClick={reconnectEtsy} style={{ background: C.card, color: C.ink, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>Reconnect Etsy</button>}
                        </div>
                      </div>
                    )}
                    {/* Step 2 stays lightweight: allocation only. The invoice commits the stock movement later. */}
                    {isEtsyOrder(order) && selStep === 1 && (
                      <div style={{ background: C.surface, border: `1.5px solid ${order.linked_stock_id ? C.green : "#F56400"}`, borderLeft: `4px solid ${order.linked_stock_id ? C.green : "#F56400"}`, borderRadius: 10, padding: 14, marginBottom: 10 }}>
                        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 15, fontWeight: 850, color: C.ink }}>Allocate physical stock</div>
                            <div style={{ fontSize: 12, color: C.inkMid, marginTop: 3, lineHeight: 1.4 }}>Search your stock and set the quantity that filled this order.</div>
                          </div>
                          {order._ngInvoiceNo && (
                            <span style={{ fontSize: 11, fontWeight: 800, color: C.green, background: C.greenBg, border: `1px solid ${C.green}40`, borderRadius: 20, padding: "3px 10px", whiteSpace: "nowrap" }}>
                              ✓ {order._ngInvoiceNo} · −{order._ngDeductedQty}
                            </span>
                          )}
                        </div>
                        {(() => {
                          const linked = stock.find(s => s.id === order.linked_stock_id);
                          const done = !!order._ngInvoiceNo;
                          const thumb = (s, size) => s.photo
                            ? <img src={s.photo} alt="" loading="lazy" style={{ width: size, height: size, objectFit: "cover", borderRadius: 8, flexShrink: 0, border: `1px solid ${C.border}` }} />
                            : <div style={{ width: size, height: size, borderRadius: 8, flexShrink: 0, background: C.card, border: `1px solid ${C.border}`, display: "grid", placeItems: "center", fontSize: Math.round(size * 0.42) }}>💎</div>;
                          const hasQty2 = linked && String(linked.qty2 || "").trim() !== "";
                          return (
                            <>
                              {linked && !done ? (
                                <div style={{ display: "flex", gap: 12, alignItems: "center", padding: 10, background: C.card, border: `1.5px solid ${C.green}66`, borderRadius: 10, marginBottom: 10 }}>
                                  {thumb(linked, 56)}
                                  <div style={{ minWidth: 0, flex: 1 }}>
                                    <div style={{ fontSize: 13.5, fontWeight: 850, color: C.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{linked.material || linked.desc || "Item"}{linked.shape ? ` · ${linked.shape}` : ""}</div>
                                    <div style={{ fontSize: 11, color: C.inkMid, marginTop: 4, display: "flex", gap: 12, flexWrap: "wrap" }}>
                                      <span>📦 <b style={{ color: (+linked.qty || 0) > 0 ? C.green : C.red }}>{linked.qty} {linked.unit || "pcs"}</b> available{hasQty2 ? ` · ${linked.qty2} ${linked.unit2 || ""}` : ""}</span>
                                      {linked.location && <span>🗄 {linked.location}</span>}
                                      {linked.sku && <span style={{ fontFamily: "monospace" }}>{linked.sku}</span>}
                                      <span>💰 {linked.costPrice ? money(linked.costPrice, "INR") : "cost not set"}</span>
                                    </div>
                                  </div>
                                  <button onClick={() => { linkOrderStock(order, ""); setStockSearch(s => ({ ...s, [order.id]: "" })); }} style={{ flexShrink: 0, background: C.surface, color: C.ink, border: `1px solid ${C.border}`, borderRadius: 8, padding: "7px 12px", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>Change</button>
                                </div>
                              ) : !done && (
                                <button onClick={() => { setStockSearch(s => ({ ...s, [order.id]: "" })); setStockModalOrder(order); }} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", background: C.card, color: C.inkMid, border: `1.5px dashed ${C.border}`, borderRadius: 9, padding: "12px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer", marginBottom: 10 }}>
                                  <span style={{ fontSize: 16 }}>🔍</span>
                                  <span>Search stock to allocate…</span>
                                </button>
                              )}
                              {linked && !done && (
                                <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr 1fr" : hasQty2 ? "160px 160px 1fr" : "160px 1fr", gap: 10, alignItems: "end" }}>
                                  <label style={{ fontSize: 11, fontWeight: 800, color: C.inkMid }}>Qty used ({linked.unit || "pcs"})<input type="number" min={1} value={ngDraft(order).qty} onChange={e => updNg(order, { qty: e.target.value })} style={{ ...FI(), width: "100%", fontSize: 13, padding: "9px 11px", borderRadius: 8, marginTop: 5 }} /></label>
                                  {hasQty2 && <label style={{ fontSize: 11, fontWeight: 800, color: C.inkMid }}>{linked.unit2 || "Secondary"} used<input type="number" min={0} value={ngDraft(order).qty2} onChange={e => updNg(order, { qty2: e.target.value })} style={{ ...FI(), width: "100%", fontSize: 13, padding: "9px 11px", borderRadius: 8, marginTop: 5 }} /></label>}
                                </div>
                              )}
                              {ngDraft(order).error && (
                                <div style={{ marginTop: 8, fontSize: 12, color: C.red, background: C.redBg, border: `1px solid ${C.red}30`, borderRadius: 8, padding: "7px 9px" }}>{ngDraft(order).error}</div>
                              )}
                              {ngDraft(order).success && (
                                <div style={{ marginTop: 8, fontSize: 12, color: C.green, background: C.greenBg, border: `1px solid ${C.green}30`, borderRadius: 8, padding: "7px 9px" }}>{ngDraft(order).success}</div>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    )}
                    {isEtsyOrder(order) && selStep === 2 && (
                      <div style={{ background: C.surface, border: `1.5px solid ${order._atInvoiceNo ? C.green : "#F56400"}`, borderLeft: `4px solid ${order._atInvoiceNo ? C.green : "#F56400"}`, borderRadius: 10, padding: 14, marginBottom: 10 }}>
                        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 15, fontWeight: 850, color: C.ink }}>{order._atInvoiceNo ? "Sales invoice created" : "Create sales invoice"}</div>
                            <div style={{ fontSize: 12, color: C.inkMid, marginTop: 3, lineHeight: 1.4 }}>{order._atInvoiceNo ? `Atyahara invoice ${order._atInvoiceNo} bills the Etsy buyer.` : "Bill the Etsy buyer from Atyahara. Pick the customs shape if auto-detect is off."}</div>
                            {!order._atInvoiceNo && <select value={order.listing_shape || ""} onChange={e => setOrderShape(order, e.target.value)} style={{ ...FI(), marginTop: 8, minWidth: 220, padding: "6px 8px", fontSize: 11, cursor: "pointer" }}>
                              <option value="">Auto-detect customs shape</option>
                              {order.listing_shape && !customsShapes.includes(order.listing_shape) && <option value={order.listing_shape}>{order.listing_shape}</option>}
                              {customsShapes.map(s => <option key={s} value={s}>{s}</option>)}
                            </select>}
                          </div>
                          <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                            {!order._atInvoiceNo && <button onClick={() => { setInvoiceModalSearch(""); setInvoiceModalOrder(order); }} style={{ background: C.surface, color: C.ink, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", fontSize: 12, fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap" }}>Already invoiced?</button>}
                            <button
                              onClick={() => createAtyaharaInvoiceForOrder(order)}
                              disabled={!!invoiceDraft(order).loading}
                              style={{ background: order._atInvoiceNo ? C.card : C.green, color: order._atInvoiceNo ? C.ink : "#fff", border: order._atInvoiceNo ? `1px solid ${C.border}` : "none", borderRadius: 8, padding: "8px 13px", fontSize: 12, fontWeight: 850, cursor: invoiceDraft(order).loading ? "wait" : "pointer", opacity: invoiceDraft(order).loading ? .7 : 1, whiteSpace: "nowrap" }}>
                              {invoiceDraft(order).loading ? "Creating..." : order._atInvoiceNo ? "Refresh invoice" : "Create Invoice"}
                            </button>
                          </div>
                        </div>
                        {order._atInvoiceNo && <div style={{ marginTop: 8, fontSize: 11, color: C.green, fontWeight: 700 }}>Linked to {order._atInvoiceNo} · <button onClick={() => patchOrder(order, { _atInvoiceNo: "", _atInvoicedAt: "" })} style={{ border: "none", background: "transparent", color: C.inkMid, fontSize: 11, cursor: "pointer", textDecoration: "underline", padding: 0 }}>unlink</button></div>}
                        {!order.linked_stock_id && !order._atInvoiceNo && <div style={{ marginTop: 8, fontSize: 11, color: C.inkFaint }}>Tip: allocate a stock item in step 2 so the invoice links to physical stock.</div>}
                        {invoiceDraft(order).error && (
                          <div style={{ marginTop: 8, fontSize: 12, color: C.red, background: C.redBg, border: `1px solid ${C.red}30`, borderRadius: 8, padding: "7px 9px" }}>
                            {invoiceDraft(order).error}
                          </div>
                        )}
                        {invoiceDraft(order).success && (
                          <div style={{ marginTop: 8, fontSize: 12, color: C.green, background: C.greenBg, border: `1px solid ${C.green}30`, borderRadius: 8, padding: "7px 9px" }}>
                            {invoiceDraft(order).success}
                          </div>
                        )}
                      </div>
                    )}
                    {isEtsyOrder(order) && selStep === 3 && (
                      <div style={{ background: C.surface, border: `1.5px solid ${order._ngInvoiceNo ? C.green : "#F56400"}`, borderLeft: `4px solid ${order._ngInvoiceNo ? C.green : "#F56400"}`, borderRadius: 10, padding: 14, marginBottom: 10 }}>
                        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 15, fontWeight: 850, color: C.ink }}>{order._ngInvoiceNo ? "NG purchase invoice recorded" : "Create NG purchase invoice"}</div>
                            <div style={{ fontSize: 12, color: C.inkMid, marginTop: 3, lineHeight: 1.4 }}>{order._ngInvoiceNo ? `Added to ${order._ngInvoiceNo} — stock recorded into Nikhil Gems at cost.` : "Records the allocated stock into Nikhil Gems at cost — the last step."}</div>
                          </div>
                          <button onClick={() => addOrderToNg(order)} disabled={!!order._ngInvoiceNo || !!ngDraft(order).loading || !order.linked_stock_id} style={{ background: order._ngInvoiceNo ? C.green : C.purple, color: "#fff", border: "none", borderRadius: 8, padding: "9px 16px", fontSize: 12.5, fontWeight: 850, cursor: order._ngInvoiceNo || ngDraft(order).loading || !order.linked_stock_id ? "default" : "pointer", opacity: order._ngInvoiceNo || ngDraft(order).loading || !order.linked_stock_id ? .6 : 1, whiteSpace: "nowrap" }}>{order._ngInvoiceNo ? "Added" : ngDraft(order).loading ? "Creating…" : "Create invoice"}</button>
                        </div>
                        {!order.linked_stock_id && !order._ngInvoiceNo && <div style={{ marginTop: 8, fontSize: 11, color: C.inkFaint }}>Choose a physical stock item in step 2 first.</div>}
                      </div>
                    )}
                    {isEtsyOrder(order) && order._ngInvoiceNo && <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "13px 16px", borderRadius: 10, background: C.greenBg, border: `1.5px solid ${C.green}`, color: C.green, fontSize: 13, fontWeight: 800, marginBottom: 10 }}><span style={{ fontSize: 18, lineHeight: 1 }}>✓</span><span>Fulfilment complete · Etsy shipped · {order._atInvoiceNo || "Atyahara invoice"} · {order._ngInvoiceNo}</span></div>}
                    {detailsOpen[order.id] && <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr 1fr" : "repeat(4,1fr)", gap: 10 }}>
                      {[
                        ["Platform ID",   order.platform_order_id || order.etsy_receipt_id || "—"],
                        ["Transaction",   order.etsy_transaction_id || "—"],
                        ["Date",          new Date(orderDate(order)).toLocaleDateString("en-GB")],
                        ["Buyer",         order.buyer_name || "—"],
                        ["Email",         order.buyer_email || "—"],
                        ["Country",       order.buyer_country || "—"],
                        // Item money: list price → coupon discount → what the buyer actually paid.
                        ...(order.list_price != null && +order.discount > 0 ? [
                          ["List Price",  money(order.list_price, order.currency)],
                          ["Discount",    `-${money(order.discount, order.currency)}`],
                        ] : []),
                        ["Sale Price",    money(order.sale_price, order.currency)],
                        ...(order.order_shipping != null ? [["Shipping", money(order.order_shipping, order.currency)]] : []),
                        ...(order.order_tax > 0 ? [["Tax (Etsy)", money(order.order_tax, order.currency)]] : []),
                        ...(order.order_total != null ? [["Buyer Paid", money(order.order_total, order.currency)]] : []),
                        ...(order.etsy_fees != null ? [["Etsy fees", `-${money(order.etsy_fees, order.fees_currency || order.currency)}`]] : []),
                        ...(order.etsy_net != null ? [["Earned", money(order.etsy_net, order.fees_currency || order.currency)]] : []),
                        ["SKU",           order.listing_sku || "—"],
                        ["Status",        shipped ? "Shipped" : "Unshipped"],
                        ["Reference",     order.order_number || "—"],
                        ["Material",      order.listing_material || "—"],
                        ["Shape",         "__shape_select__"],
                        ["Created",       order.created_at ? new Date(order.created_at).toLocaleDateString("en-GB") : "—"],
                      ].map(([k, v]) => (
                        <div key={k} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 10px", minWidth: 0 }}>
                          <div style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: .5, color: C.inkFaint, marginBottom: 3 }}>
                            {k}{k === "Shape" ? <span title="Drives the customs/bill description on the invoice" style={{ marginLeft: 4, color: C.gold }}>· customs</span> : null}
                          </div>
                          {v === "__shape_select__" ? (
                            <select
                              value={order.listing_shape || ""}
                              onChange={e => setOrderShape(order, e.target.value)}
                              style={{ width: "100%", border: `1px solid ${C.border}`, borderRadius: 6, background: C.card, color: order.listing_shape ? C.ink : C.inkFaint, fontSize: 12, fontWeight: 600, padding: "3px 4px", cursor: "pointer" }}>
                              <option value="">Auto (AI on invoice)</option>
                              {order.listing_shape && !customsShapes.includes(order.listing_shape) && (
                                <option value={order.listing_shape}>{order.listing_shape}</option>
                              )}
                              {customsShapes.map(s => <option key={s} value={s}>{s}</option>)}
                            </select>
                          ) : (
                            <div style={{ fontSize: 12, color: C.ink, fontWeight: 600, overflowWrap: "anywhere" }}>{v}</div>
                          )}
                        </div>
                      ))}
                    </div>}
                    {detailsOpen[order.id] && order.notes && (
                      <div style={{ marginTop: 10, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "9px 11px" }}>
                        <div style={{ fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: .5, color: C.inkFaint, marginBottom: 3 }}>Notes</div>
                        <div style={{ fontSize: 12, color: C.inkMid, lineHeight: 1.45 }}>{order.notes}</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   PLATFORM VIEW  — one platform's listings + live stats
══════════════════════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════════════════════
   ETSY LIVE VIEW  — fetches real data directly from Etsy API
══════════════════════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════════════════════
   ETSY SHOP MANAGER — fast load, edit listings, full orders + customers
══════════════════════════════════════════════════════════════════════════ */
const ETSY_CACHE = "ng-etsy-v3";

function EtsyLiveView() {
  const loadCache = () => { try { return JSON.parse(localStorage.getItem(ETSY_CACHE)||"{}"); } catch { return {}; } };
  const c0 = loadCache();

  const [subTab,    setSubTab]    = useState("listings");
  const [listings,  setListings]  = useState(c0.listings || []);
  const [orders,    setOrders]    = useState(c0.orders   || []);
  const [hasOAuth,  setHasOAuth]  = useState(null); // null = unknown (loading), false = no token, true = connected
  const [loading,   setLoading]   = useState(!(c0.listings?.length));
  const [syncing,   setSyncing]   = useState(false);
  const [error,     setError]     = useState(null);
  const [search,    setSearch]    = useState("");
  const [expanded,  setExpanded]  = useState(null);
  const [etsyFulfill, setEtsyFulfill] = useState({});
  const [etsyInvoice, setEtsyInvoice] = useState({});

  const [listingErr,   setListingErr]   = useState(null);
  const [stFilter,     setStFilter]     = useState("active");
  const [filterTags,     setFilterTags]     = useState(new Set());
  const [sections,       setSections]       = useState([]);
  const [filterSection,  setFilterSection]  = useState(null);
  const [activeSales,    setActiveSales]    = useState([]);
  const [orderFilter,    setOrderFilter]    = useState("all");
  const [editL,        setEditL]        = useState(null);
  const [editForm,     setEditForm]     = useState({});
  const [editImages,   setEditImages]   = useState([]);
  const [imgUploading, setImgUploading] = useState(false);
  const [showPicker,   setShowPicker]   = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");
  const [saving,       setSaving]       = useState(false);
  const [saveErr,      setSaveErr]      = useState(null);
  const [toast,        setToast]        = useState("");
  const [tagInput,     setTagInput]     = useState("");
  const [showCalc,     setShowCalc]     = useState(false);
  // Price calculator state
  const [calcWeight,   setCalcWeight]   = useState("");
  const [calcUnit,     setCalcUnit]     = useState("g");   // "g" or "kg"
  const [calcCostPer,  setCalcCostPer]  = useState("");    // cost per unit
  const [calcMarkup,   setCalcMarkup]   = useState("300"); // % markup
  const [calcFees,     setCalcFees]     = useState("9.5"); // etsy fee %

  const showToast = m => { setToast(m); setTimeout(() => setToast(""), 3500); };

  const fmtCur = (amt, div, code) => {
    const v = (amt||0) / (div||100);
    const s = code==="USD"?"$":code==="GBP"?"£":code==="EUR"?"€":code==="INR"?"₹":(code||"$");
    return `${s}${v.toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  };
  const fmtDate = ts => ts ? new Date(ts*1000).toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric"}) : "—";

  // Incremental-sync tuning. A full sync re-pulls every paid receipt (slow, grows with the shop);
  // an incremental sync only asks Etsy for receipts created since the newest one we already have.
  const FULL_RESYNC_MS = 24 * 60 * 60 * 1000;        // force a full resync at most once a day (catches status flips on old orders)
  const INCREMENTAL_BUFFER_S = 3 * 24 * 60 * 60;     // re-pull the last few days so recent shipping/status changes stay fresh

  const saveCache = (ls, os, fullSynced) => {
    try {
      const prev = loadCache();
      localStorage.setItem(ETSY_CACHE, JSON.stringify({
        listings: ls, orders: os, syncedAt: Date.now(),
        lastFullSync: fullSynced ? Date.now() : (prev.lastFullSync || 0),
      }));
    } catch {}
  };

  const etsyMoney = m => (m?.amount || 0) / (m?.divisor || 100);
  const etsyReceiptTs = o => o?.create_timestamp || o?.creation_tsz || o?.created_timestamp || o?.update_timestamp || 0;
  const sortEtsyReceipts = rows => [...(rows || [])].sort((a, b) => etsyReceiptTs(b) - etsyReceiptTs(a));
  const mergeEtsyReceipts = (existing = [], fresh = []) => {
    const byId = new Map();
    existing.forEach(o => byId.set(String(o.receipt_id), o));
    fresh.forEach(o => {
      const key = String(o.receipt_id);
      byId.set(key, { ...(byId.get(key) || {}), ...o });
    });
    return sortEtsyReceipts([...byId.values()]);
  };
  const etsyOrderDate = o => {
    const ts = o.create_timestamp || o.creation_tsz || o.created_timestamp || o.update_timestamp;
    return ts ? new Date(ts * 1000).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  };
  const etsyBuyerEmail = o => o.buyer_email || o.email || o.customer_email || o.customer?.email || o.buyer?.email || "";
  const receiptTrackingCode = o => o.tracking_code || o.tracking_number || o.shipments?.[0]?.tracking_code || o.shipments?.[0]?.tracking_number || "";
  const receiptCarrierName = o => o.carrier_name || o.shipping_carrier || o.shipments?.[0]?.carrier_name || o.shipments?.[0]?.carrier || "other";
  const receiptShippedAt = o => {
    const shipment = o?.shipments?.[0] || {};
    const ts = o?.shipped_timestamp || o?.ship_date || o?.shipped_at ||
      shipment.shipped_timestamp || shipment.shipment_notification_timestamp || shipment.mail_date ||
      shipment.created_timestamp || shipment.created_at;
    if (!ts) return "";
    if (typeof ts === "number") return new Date(ts * 1000).toISOString();
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  };
  const receiptIsShipped = o => {
    const status = String(o?.status || o?.shipping_status || "").toLowerCase();
    return !!(
      o?.is_shipped ||
      o?.was_shipped ||
      receiptTrackingCode(o) ||
      (o?.shipments || []).length ||
      ["shipped", "fulfilled", "pre_transit", "in_transit", "delivered"].includes(status)
    );
  };

  const etsyListingImage = listing => {
    const imgs = listing?.images || listing?.Images || [];
    const img = [...imgs].sort((a, b) => (a.rank || 0) - (b.rank || 0))[0] || listing?.main_image;
    return img?.url_570xN || img?.url_fullxfull || img?.url_170x135 || img?.url_75x75 || "";
  };

  const syncOrdersToERP = async (rawOrders, etsyListings = []) => {
    const [erpListings, erpOrders] = await Promise.all([loadK(LIST_KEY), loadK(ORDERS_KEY)]);
    const listingByEtsyId = {};
    (erpListings || []).forEach(l => {
      const id = l.platforms?.etsy?.listing_id;
      if (id) listingByEtsyId[String(id)] = l;
    });
    const liveListingByEtsyId = {};
    (etsyListings || []).forEach(l => {
      const id = l.listing_id || l.listingId || l.id;
      if (id) liveListingByEtsyId[String(id)] = l;
    });
    const normalized = [];
    (rawOrders || []).forEach(o => {
      const txns = o.transactions?.length ? o.transactions : [null];
      txns.forEach((txn, idx) => {
        const etsyListingId = txn?.listing_id;
        const linked = etsyListingId ? listingByEtsyId[String(etsyListingId)] : null;
        const liveListing = etsyListingId ? liveListingByEtsyId[String(etsyListingId)] : null;
        const currency = txn?.price?.currency_code || o.grandtotal?.currency_code || "USD";
        const lineMoney = etsyReceiptLineMoney(o, txn, txns);
        const id = `etsy-${o.receipt_id}-${txn?.transaction_id || etsyListingId || idx}`;
        const shipped = receiptIsShipped(o);
        normalized.push({
          id,
          order_number:      `ETSY-${o.receipt_id}${txns.length > 1 ? `-${idx + 1}` : ""}`,
          listing_id:        linked?.id || "",
          listing_title:     txn?.title || linked?.title || `Etsy order #${o.receipt_id}`,
          listing_material:  linked?.material || "",
          listing_shape:     linked?.shape || "",
          listing_sku:       txn?.sku || linked?.sku || "",
          listing_image:     txn?.image_data?.url_570xN || txn?.image_data?.url_fullxfull || txn?.image_data?.url_170x135 || txn?.image_data?.url_75x75 || etsyListingImage(liveListing) || linked?.images?.[0] || "",
          platform:          "etsy",
          platform_order_id: String(o.receipt_id),
          etsy_listing_id:   etsyListingId || "",
          etsy_receipt_id:   o.receipt_id,
          etsy_transaction_id: txn?.transaction_id || "",
          ...lineMoney,
          currency,
          buyer_name:        o.name || etsyBuyerEmail(o) || "",
          buyer_country:     o.country_iso || "",
          buyer_email:       etsyBuyerEmail(o),
          ship_name:         o.name || "",
          ship_address1:     o.first_line || "",
          ship_address2:     o.second_line || "",
          ship_city:         o.city || "",
          ship_state:        o.state || "",
          ship_postcode:     o.zip || "",
          ship_country:      o.country_iso || "",
          ship_phone:        o.phone || o.formatted_phone || "",
          status:            shipped ? "shipped" : "sold",
          tracking_code:     receiptTrackingCode(o),
          tracking_number:   receiptTrackingCode(o),
          carrier_name:      receiptCarrierName(o),
          shipped_at:        shipped ? receiptShippedAt(o) || new Date().toISOString() : "",
          date:              etsyOrderDate(o),
          notes:             o.message_from_buyer || "",
          created_at:        new Date((o.create_timestamp || o.creation_tsz || Date.now() / 1000) * 1000).toISOString(),
          source:            "etsy-sync",
        });
      });
    });
    if (!normalized.length) return;
    const importedIds = new Set(normalized.map(o => o.id));
    const next = [...normalized, ...(erpOrders || []).filter(o => !importedIds.has(o.id))];
    for (const order of normalized) await upsertItemK(ORDERS_KEY, order, { prepend: true });
    window.dispatchEvent(new CustomEvent("ng-orders-updated", { detail: next }));
  };

  // ── Token management — localStorage first, fall back to shared Supabase session
  const getToken = getEtsyToken; // shared module-level helper (refresh + Supabase fallback)

  const fetchAll = async (bg=false, forceFull=false) => {
    bg ? setSyncing(true) : setLoading(true);
    setError(null); setListingErr(null);
    try {
      const tok = await getToken();
      const authHdr = tok ? { "X-Etsy-Token": tok } : {};

      // Decide incremental vs full sync for orders. Incremental only when we already have
      // cached orders, this isn't a forced full refresh, and we've done a full resync recently.
      const cache = loadCache();
      const haveOrders = (orders?.length || 0) > 0;
      const fullDue = (Date.now() - (cache.lastFullSync || 0)) >= FULL_RESYNC_MS;
      const doFullOrders = forceFull || !haveOrders || fullDue;
      let ordersUrl = `/api/etsy?action=orders&limit=100&enrich=true&_=${Date.now()}`;
      if (!doFullOrders) {
        const newestTs = orders.reduce((m, o) => Math.max(m, etsyReceiptTs(o)), 0);
        if (newestTs > 0) ordersUrl += `&min_created=${Math.max(0, Math.floor(newestTs - INCREMENTAL_BUFFER_S))}`;
      }

      const [pr, lr, or_, sr, dr] = await Promise.all([
        fetch("/api/etsy?action=ping", { headers: authHdr }),
        fetch("/api/etsy?action=listings_all", { headers: authHdr }),
        fetch(ordersUrl, { headers: authHdr, cache: "no-store" }),
        fetch("/api/etsy?action=sections", { headers: authHdr }),
        fetch("/api/etsy?action=discounts", { headers: authHdr }),
      ]);
      const pd = await pr.json();
      if (!pr.ok) { setError(pd.error || "Etsy connection failed"); return; }
      const oauth = !!pd.has_oauth_token;
      setHasOAuth(oauth);

      // parse listings — fallback to plain `listings` if listings_all errors or returns 0
      let newListings = [];
      if (lr.ok) {
        const ld = await lr.json();
        newListings = ld.results || [];
        if (ld.stateErrors?.length) {
          const msgs = ld.stateErrors.map(e => `${e.state}: ${e.error}`).join(" · ");
          setListingErr(`Some listing states failed — ${msgs}`);
        }
      }
      // if listings_all returned nothing, try the plain active listings endpoint as fallback
      if (newListings.length === 0) {
        const fb = await fetch("/api/etsy?action=listings&limit=100", { headers: authHdr });
        if (fb.ok) { const fbd = await fb.json(); newListings = fbd.results || []; }
        else { const fbe = await fb.json(); setListingErr(fbe.error || "Listings fetch failed"); }
      }
      setListings(newListings);

      let newOrders = orders;
      let ordersFullSynced = false;
      if (oauth && or_.ok) {
        const od = await or_.json();
        newOrders = mergeEtsyReceipts(orders, od.results || []);
        setOrders(newOrders);
        ordersFullSynced = doFullOrders; // only mark a full resync done when the orders fetch actually succeeded
        syncOrdersToERP(newOrders, newListings).catch(e => console.warn("Etsy order ERP sync failed:", e));
      }
      if (sr.ok) { const sd = await sr.json(); setSections(sd.results||[]); }
      if (dr.ok) {
        const dd = await dr.json();
        const now = Date.now() / 1000;
        const active = (dd.results||[]).filter(d =>
          d.seller_active &&
          (!d.start_date || d.start_date <= now) &&
          (!d.end_date   || d.end_date   >= now)
        );
        setActiveSales(active);
      }
      saveCache(newListings, newOrders, ordersFullSynced);
    } catch (e) { setError(e.message); }
    bg ? setSyncing(false) : setLoading(false);
  };

  useEffect(() => {
    const STALE_MS = 10 * 60 * 1000; // 10 minutes
    const cacheAge = c0.syncedAt ? Date.now() - c0.syncedAt : Infinity;
    // Also treat cache as stale if it has suspiciously few listings (< 200 = old pre-pagination cache)
    const cacheStale = cacheAge >= STALE_MS || (c0.listings?.length > 0 && c0.listings.length < 200);
    if (c0.listings?.length > 0 && !cacheStale) {
      // Cache is fresh — show instantly, no API call
      getToken().then(tok => setHasOAuth(!!tok));
    } else {
      fetchAll(c0.listings?.length > 0); // full load or background if cache exists
    }
    // Listen for OAuth popup completing — auto-refresh when it does
    const onMsg = (e) => {
      if (e.data?.type === "etsy-auth-complete") {
        localStorage.removeItem(ETSY_CACHE);
        fetchAll(false);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const openEdit = l => {
    const price = l.price ? (l.price.amount / (l.price.divisor||100)) : 0;
    setEditL(l);
    setEditForm({ title: l.title||"", description: l.description||"", price: price.toFixed(2),
      quantity: l.quantity||1, tags: [...(l.tags||[])], state: l.state||"active" });
    setEditImages(l.images ? [...l.images].sort((a,b)=>(a.rank||0)-(b.rank||0)) : []);
    setSaveErr(null); setTagInput(""); setShowPicker(false);
  };

  const addTag = () => {
    const t = tagInput.trim().toLowerCase();
    if (!t || editForm.tags.includes(t) || editForm.tags.length >= 13) return;
    setEditForm(f => ({...f, tags:[...f.tags, t]})); setTagInput("");
  };
  const removeTag = t => setEditForm(f => ({...f, tags:f.tags.filter(x=>x!==t)}));

  const saveEdit = async () => {
    if (!editL) return;
    setSaving(true); setSaveErr(null);
    try {
      const tok = await getToken();
      const ah = tok ? {"Content-Type":"application/json","X-Etsy-Token":tok} : {"Content-Type":"application/json"};
      const r1 = await fetch(`/api/etsy?action=update_listing&listing_id=${editL.listing_id}`, {
        method:"POST", headers:ah,
        body:JSON.stringify({ title:editForm.title, description:editForm.description,
          tags:editForm.tags, state:editForm.state }),
      });
      if (!r1.ok) {
        const e1 = await r1.json().catch(()=>({}));
        console.error("[saveEdit] update_listing failed:", r1.status, e1);
        const msg = e1.etsyError || e1.error || `Listing update failed (${r1.status})`;
        throw new Error(msg);
      }
      // price/qty via inventory — properly surfaced
      const r2 = await fetch(`/api/etsy?action=update_inventory&listing_id=${editL.listing_id}`, {
        method:"POST", headers:ah,
        body:JSON.stringify({
          price: parseFloat(editForm.price),
          quantity: parseInt(editForm.quantity),
          currency_code: editL.price?.currency_code || "INR",
        }),
      });
      // optimistic update for title/tags (already saved above)
      setListings(prev => prev.map(l => l.listing_id===editL.listing_id ? {
        ...l, title:editForm.title, description:editForm.description, tags:editForm.tags,
        state:editForm.state,
      } : l));

      if (!r2.ok) {
        const e2 = await r2.json().catch(()=>({}));
        const detail = e2.etsyError || e2.error || e2.message || `Price/qty update failed (${r2.status})`;
        const hint = e2.hint ? ` — ${e2.hint}` : "";
        // Title/tags saved — show partial success so user knows what happened
        setSaveErr(`Title & tags saved. Price/qty update failed: ${detail}${hint}`);
        setSaving(false);
        return;
      }
      // full success — also update price/qty optimistically
      setListings(prev => prev.map(l => l.listing_id===editL.listing_id ? {
        ...l, quantity:parseInt(editForm.quantity),
        price:{...l.price, amount:Math.round(parseFloat(editForm.price)*(l.price?.divisor||100))},
      } : l));
      showToast("✓ Listing updated");
      setEditL(null);
    } catch (e) { setSaveErr(e.message); }
    setSaving(false);
  };

  // ── image management helpers ──────────────────────────────────────────────
  const etsyPost = async (url, body) => {
    const tok = await getToken();
    const hdr = { "Content-Type": "application/json", ...(tok ? { "X-Etsy-Token": tok } : {}) };
    const first = await fetch(url, { method: "POST", headers: hdr, body: JSON.stringify(body) });
    if (first.ok || !tok) return first;
    const d = await first.clone().json().catch(() => ({}));
    if (!needsEtsyReconnect(d.fix || d.error)) return first;
    clearLocalEtsySession();
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  };

  const fulfillDraft = o => etsyFulfill[o.receipt_id] || {
    tracking_code: receiptTrackingCode(o),
    carrier_name: receiptCarrierName(o),
    loading: false,
    error: "",
  };
  const updateFulfillDraft = (o, patch) => {
    setEtsyFulfill(s => ({ ...s, [o.receipt_id]: { ...fulfillDraft(o), ...patch } }));
  };
  const liveInvoiceDraft = o => etsyInvoice[o.receipt_id] || { loading: false, error: "", success: "" };
  const createAtyaharaInvoiceForReceipt = async o => {
    const receiptId = String(o.receipt_id || "");
    if (!receiptId) return;
    setEtsyInvoice(s => ({ ...s, [receiptId]: { loading: true, error: "", success: "" } }));
    try {
      const txns = o.transactions?.length ? o.transactions : [null];
      const currency = txns.find(t => t?.price?.currency_code)?.price?.currency_code || o.grandtotal?.currency_code || "USD";
      const items = txns.map((t, i) => {
        // Bill the discounted amount the buyer actually paid, not the list price.
        const lm = etsyReceiptLineMoney(o, t, txns);
        const rate = Number((lm.sale_price / lm.qty).toFixed(2));
        return {
          id: `etsy-${receiptId}-${t?.transaction_id || t?.listing_id || i}`,
          desc: cleanInvoiceText(t?.title || `Etsy order #${receiptId}`),
          _title: t?.title || "",
          _shape: "",
          sku: t?.sku || "",
          hsn: "71031029",
          qty: String(lm.qty),
          unit: "pcs",
          rate: String(rate),
          gst: "0",
          igst: 0,
          amt: Number((lm.qty * rate).toFixed(2)),
          _etsyReceiptId: receiptId,
          _etsyTransactionId: t?.transaction_id || "",
          _etsyListingId: t?.listing_id || "",
          _listingImage: t?.image_data?.url_570xN || t?.image_data?.url_fullxfull || t?.image_data?.url_170x135 || t?.image_data?.url_75x75 || "",
        };
      });
      const { invoice, updated } = await upsertAtyaharaInvoiceFromEtsy({
        receiptId,
        orderDate: etsyOrderDate(o),
        buyer: { name: o.name || etsyBuyerEmail(o) || "", email: etsyBuyerEmail(o), country: o.country_iso || "" },
        address: {
          name: o.name || "",
          line1: o.first_line || "",
          line2: o.second_line || "",
          city: o.city || "",
          state: o.state || "",
          postcode: o.zip || "",
          country: o.country_iso || "",
        },
        currency,
        items,
        notes: `Created from live Etsy receipt #${receiptId}${o.message_from_buyer ? `\nBuyer note: ${o.message_from_buyer}` : ""}`,
        shippingCost: Number(moneyAmount(o.total_shipping_cost).toFixed(2)),
      });
      setEtsyInvoice(s => ({ ...s, [receiptId]: { loading: false, error: "", success: `${updated ? "Updated" : "Created"} ${invoice.invNo}` } }));
      showToast(`✓ ${updated ? "Updated" : "Created"} invoice ${invoice.invNo}`);
    } catch (e) {
      setEtsyInvoice(s => ({ ...s, [receiptId]: { loading: false, error: e.message || "Could not create invoice", success: "" } }));
    }
  };
  const completeLiveEtsyOrder = async o => {
    const draft = fulfillDraft(o);
    const trackingCode = String(draft.tracking_code || "").trim();
    const carrierName = String(draft.carrier_name || "other").trim() || "other";
    if (!trackingCode) {
      updateFulfillDraft(o, { error: "Add a tracking number first." });
      return;
    }
    updateFulfillDraft(o, { loading: true, error: "" });
    try {
      const r = await etsyPost("/api/etsy?action=add_tracking", {
        receipt_id: o.receipt_id,
        tracking_code: trackingCode,
        carrier_name: carrierName,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.ok === false) throw new Error(d.fix || d.error || "Could not complete Etsy order");
      const next = orders.map(x => String(x.receipt_id) === String(o.receipt_id) ? {
        ...x,
        is_shipped: true,
        status: "completed",
        tracking_code: trackingCode,
        tracking_number: trackingCode,
        carrier_name: carrierName,
        shipped_at: new Date().toISOString(),
      } : x);
      setOrders(next);
      saveCache(listings, next);
      syncOrdersToERP(next, listings).catch(e => console.warn("Etsy order ERP sync failed:", e));
      updateFulfillDraft(o, { loading: false, error: "", tracking_code: trackingCode, carrier_name: carrierName });
      showToast("✓ Etsy order completed");
    } catch (e) {
      updateFulfillDraft(o, { loading: false, error: e.message || "Could not complete Etsy order" });
    }
  };

  const deleteListingImg = async (imgId) => {
    if (!confirm("Remove this image from the Etsy listing?")) return;
    const r = await etsyPost("/api/etsy?action=delete_listing_image", { listing_id: editL.listing_id, listing_image_id: imgId });
    if (r.ok) { setEditImages(prev => prev.filter(i => i.listing_image_id !== imgId)); showToast("Image removed"); }
    else { const e = await r.json().catch(()=>({})); showToast("⚠ " + (e.error||"Delete failed")); }
  };

  const uploadListingImg = async (imageUrl) => {
    if (editImages.length >= 10) { showToast("⚠ Max 10 images per listing"); return; }
    setImgUploading(true);
    const r = await etsyPost(`/api/etsy?action=upload_listing_image&listing_id=${editL.listing_id}`, { image_url: imageUrl, rank: editImages.length + 1 });
    if (r.ok) {
      const data = await r.json();
      setEditImages(prev => [...prev, data]);
      showToast("✓ Image added"); setShowPicker(false);
    } else { const e = await r.json().catch(()=>({})); showToast("⚠ " + (e.error||"Upload failed")); }
    setImgUploading(false);
  };

  const uploadFileToListing = async (file) => {
    setImgUploading(true);
    try {
      const ext = file.name.split(".").pop() || "jpg";
      const url = await uploadToStorage(`etsy-uploads/${uid()}.${ext}`, file);
      await uploadListingImg(url);
    } catch (e) { showToast("⚠ " + e.message); setImgUploading(false); }
  };

  const libImages = () => { try { return JSON.parse(localStorage.getItem("ng-image-library-v1")||"[]"); } catch { return []; } };

  // ── derived ───────────────────────────────────────────────────────────────
  const firstOrder = orders.find(o => o.grandtotal?.currency_code);
  const shopCcy    = firstOrder?.grandtotal?.currency_code || "USD";
  const ccySym     = shopCcy==="USD"?"$":shopCcy==="GBP"?"£":shopCcy==="EUR"?"€":shopCcy==="INR"?"₹":shopCcy;
  const gmv        = orders.reduce((s,o) => s+(o.grandtotal?.amount||0)/(o.grandtotal?.divisor||100), 0);

  // Top tags by frequency (sidebar filter)
  const topTags = Object.entries(
    listings.reduce((acc,l) => { (l.tags||[]).forEach(t => { acc[t]=(acc[t]||0)+1; }); return acc; }, {})
  ).sort((a,b)=>b[1]-a[1]).slice(0,22);

  const visListings = listings.filter(l => {
    if (stFilter==="active"   && l.state!=="active")   return false;
    if (stFilter==="inactive" && l.state==="active")   return false;
    if (filterSection !== null && l.shop_section_id !== filterSection) return false;
    if (filterTags.size>0 && !l.tags?.some(t=>filterTags.has(t))) return false;
    if (search && !l.title?.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  // Pending = not shipped AND not already completed/canceled by Etsy
  const DONE_STATUSES = ["completed","canceled","fully_refunded","partially_refunded"];
  const pendingOrders   = orders.filter(o => !o.is_shipped && !DONE_STATUSES.includes(o.status));
  const completedOrders = orders.filter(o => !!o.is_shipped || DONE_STATUSES.includes(o.status));
  const ordersToShow    = orderFilter==="pending" ? pendingOrders : orderFilter==="completed" ? completedOrders : orders;
  const visOrders = ordersToShow.filter(o => {
    if (!search) return true;
    const q = search.toLowerCase();
    return String(o.receipt_id).includes(q) || o.buyer_email?.toLowerCase().includes(q) ||
      o.name?.toLowerCase().includes(q) || o.transactions?.some(t=>t.title?.toLowerCase().includes(q));
  });
  // Customers deduplicated by buyer_email
  const customers = Object.values(orders.reduce((acc,o) => {
    const key = o.buyer_email || String(o.receipt_id);
    if (!acc[key]) acc[key] = {email:o.buyer_email, name:o.name, count:0, total:0, lastOrder:0};
    acc[key].count++;
    acc[key].total += (o.grandtotal?.amount||0)/(o.grandtotal?.divisor||100);
    const ts = o.create_timestamp||o.creation_tsz||0;
    if (ts > acc[key].lastOrder) acc[key].lastOrder = ts;
    return acc;
  }, {})).sort((a,b)=>b.total-a.total);
  const visCust = customers.filter(c =>
    !search || c.name?.toLowerCase().includes(search.toLowerCase()) || c.email?.toLowerCase().includes(search.toLowerCase())
  );

  // ── loading / error states ────────────────────────────────────────────────
  if (loading) return (
    <div style={{textAlign:"center",padding:"80px 0",color:C.inkFaint}}>
      <Spinner /><div style={{marginTop:12,fontSize:13}}>Loading Etsy shop…</div>
    </div>
  );
  if (error && listings.length===0) return (
    <div style={{background:C.redBg,border:`1px solid ${C.red}`,borderRadius:10,padding:"20px 24px",color:C.red}}>
      <div style={{fontWeight:700,marginBottom:6}}>⚠ Etsy API Error</div>
      <div style={{fontSize:13,marginBottom:12}}>{error}</div>
      <button onClick={()=>fetchAll(false)} style={{background:C.red,color:"#fff",border:"none",borderRadius:7,padding:"7px 16px",fontSize:13,fontWeight:600,cursor:"pointer"}}>↺ Retry</button>
    </div>
  );

  return (
    <div style={{position:"relative"}}>
      {toast && <div style={{position:"fixed",bottom:28,left:"50%",transform:"translateX(-50%)",
        background:"#222",color:"#fff",borderRadius:9,padding:"10px 22px",fontSize:13,fontWeight:600,
        zIndex:9999,pointerEvents:"none",whiteSpace:"nowrap",boxShadow:"0 4px 20px rgba(0,0,0,.35)"}}>{toast}</div>}

      {/* ── Header stats ── */}
      <div style={{background:"#F5640012",border:"1.5px solid #F5640035",borderRadius:12,
        padding:"18px 22px",marginBottom:18,display:"flex",alignItems:"center",gap:18,flexWrap:"wrap"}}>
        <div style={{fontSize:36}}>🏷️</div>
        <div style={{flex:1,minWidth:120}}>
          <div style={{fontSize:20,fontWeight:700,color:"#F56400",fontFamily:"'Cormorant Garamond',Georgia,serif"}}>Etsy</div>
          <div style={{fontSize:11,color:C.inkMid,marginTop:2}}>
            {syncing ? "⟳ Syncing…" : `Atyahara · last synced ${c0.syncedAt ? new Date(c0.syncedAt).toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"}) : "—"}`}
          </div>
        </div>
        <div style={{display:"flex",gap:28,textAlign:"center",flexWrap:"wrap"}}>
          {[
            {label:"Active",  val:listings.filter(l=>l.state==="active").length, color:"#F56400"},
            {label:"Orders",  val:orders.length,   color:C.green},
          ].map(s=>(
            <div key={s.label}>
              <div style={{fontFamily:"'Cormorant Garamond',Georgia,serif",fontSize:24,fontWeight:700,color:s.color,lineHeight:1}}>{s.val}</div>
              <div style={{fontSize:10,color:C.inkFaint,textTransform:"uppercase",letterSpacing:.5,marginTop:2}}>{s.label}</div>
            </div>
          ))}
        </div>
        <div style={{display:"flex",gap:8,flexShrink:0,alignItems:"center"}}>
          <button onClick={reconnectEtsy} style={{background:"none",border:"1px solid #F5640060",color:"#F56400",
            borderRadius:7,padding:"7px 14px",fontSize:12,fontWeight:600,cursor:"pointer"}}
            title="Re-authenticate with Etsy (needed after scope changes)">
            🔑 Reconnect Etsy
          </button>
          <button onClick={()=>fetchAll(false, true)} style={{background:"none",border:"1px solid #F5640060",color:"#F56400",
            borderRadius:7,padding:"7px 14px",fontSize:12,fontWeight:600,cursor:"pointer"}}
            title="Full resync — re-pulls every order to catch status changes">
            ↺ Refresh
          </button>
          <button onClick={()=>{localStorage.removeItem(ETSY_CACHE);fetchAll(false);}}
            style={{background:"none",border:"1px solid #F5640030",color:C.inkFaint,
              borderRadius:7,padding:"7px 10px",fontSize:11,cursor:"pointer"}}
            title="Clear cache and reload">
            🗑
          </button>
        </div>
      </div>

      {/* ── Not connected banner — only after we know auth state ── */}
      {hasOAuth === false && (
        <div style={{background:C.amberBg,border:`1.5px solid ${C.amber}`,borderRadius:10,padding:"12px 18px",
          marginBottom:16,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
          <div style={{flex:1,fontSize:13,color:C.amber,fontWeight:600}}>🔑 Etsy OAuth not connected — orders unavailable</div>
          <button onClick={reconnectEtsy} style={{background:"#F56400",color:"#fff",borderRadius:7,padding:"7px 16px",fontSize:12,fontWeight:700,border:"none",cursor:"pointer"}}>
            Connect Etsy Shop →
          </button>
        </div>
      )}

      {/* ── Active sales banner ── */}
      {activeSales.length > 0 && (
        <div style={{background:"#fff7ed",border:"1.5px solid #f97316",borderRadius:10,padding:"10px 16px",
          marginBottom:14,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
          <div style={{fontSize:20}}>🏷️</div>
          <div style={{flex:1}}>
            <div style={{fontSize:13,fontWeight:700,color:"#c2410c"}}>
              {activeSales.length === 1 ? "Sale active now" : `${activeSales.length} sales active now`}
            </div>
            <div style={{display:"flex",flexWrap:"wrap",gap:10,marginTop:4}}>
              {activeSales.map(s=>(
                <div key={s.discount_id} style={{fontSize:12,color:"#9a3412",background:"#fed7aa",borderRadius:20,
                  padding:"2px 10px",fontWeight:600}}>
                  {s.name}
                  {s.percent_off && ` — ${s.percent_off}% off`}
                  {s.free_shipping && ` — Free shipping`}
                  {s.end_date && ` · ends ${new Date(s.end_date*1000).toLocaleDateString("en-IN",{day:"numeric",month:"short"})}`}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Sub-tabs + search ── */}
      <div style={{display:"flex",alignItems:"center",gap:0,borderBottom:`1px solid ${C.border}`,marginBottom:18}}>
        {[
          {key:"listings",  label:`Listings (${listings.length})`},
          {key:"orders",    label:`Orders (${orders.length})`},
          {key:"customers", label:`Customers (${customers.length})`},
        ].map(t=>(
          <button key={t.key} onClick={()=>setSubTab(t.key)} style={{
            padding:"10px 18px",background:"none",border:"none",cursor:"pointer",
            borderBottom:`2.5px solid ${subTab===t.key?"#F56400":"transparent"}`,
            color:subTab===t.key?C.ink:C.inkMid,
            fontWeight:subTab===t.key?700:400,fontSize:13,marginBottom:-1,whiteSpace:"nowrap",
          }}>{t.label}</button>
        ))}
        <div style={{flex:1}}/>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search…"
          style={{...FI(),width:180,fontSize:12,padding:"6px 12px",borderRadius:20,marginBottom:8}}/>
      </div>

      {/* ══ LISTINGS TAB ══ */}
      {subTab==="listings" && (
        <div style={{display:"flex",gap:0,alignItems:"flex-start"}}>
          {/* ── Left sidebar ── */}
          {!mob() && (
            <div style={{width:176,flexShrink:0,paddingRight:18,position:"sticky",top:0}}>
              {/* Status */}
              <div style={{marginBottom:20}}>
                <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:.7,color:C.inkFaint,marginBottom:8}}>Status</div>
                {[
                  {k:"active",   label:"Active",   n:listings.filter(l=>l.state==="active").length},
                  {k:"inactive", label:"Inactive", n:listings.filter(l=>l.state!=="active").length},
                  {k:"all",      label:"All",      n:listings.length},
                ].map(f=>(
                  <div key={f.k} onClick={()=>setStFilter(f.k)} style={{
                    display:"flex",alignItems:"center",justifyContent:"space-between",
                    padding:"5px 9px",borderRadius:6,cursor:"pointer",marginBottom:1,
                    background:stFilter===f.k?"#F5640012":"transparent",
                  }}>
                    <span style={{fontSize:13,fontWeight:stFilter===f.k?700:400,color:stFilter===f.k?"#F56400":C.ink}}>{f.label}</span>
                    <span style={{fontSize:11,color:stFilter===f.k?"#F56400":C.inkFaint,background:stFilter===f.k?"#F5640020":C.card,borderRadius:10,padding:"1px 7px"}}>{f.n}</span>
                  </div>
                ))}
              </div>

              {/* Sections */}
              {sections.length>0 && (
                <div style={{marginBottom:20}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                    <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:.7,color:C.inkFaint}}>Sections</div>
                    {filterSection !== null && (
                      <button onClick={()=>setFilterSection(null)} style={{fontSize:10,color:"#F56400",background:"none",border:"none",cursor:"pointer",padding:0,fontWeight:600}}>all</button>
                    )}
                  </div>
                  {/* "All" row */}
                  <div onClick={()=>setFilterSection(null)} style={{
                    display:"flex",alignItems:"center",justifyContent:"space-between",
                    padding:"5px 9px",borderRadius:6,cursor:"pointer",marginBottom:1,
                    background:filterSection===null?"#F5640012":"transparent",
                  }}>
                    <span style={{fontSize:13,fontWeight:filterSection===null?700:400,color:filterSection===null?"#F56400":C.ink}}>All</span>
                    <span style={{fontSize:11,color:filterSection===null?"#F56400":C.inkFaint,background:filterSection===null?"#F5640020":C.card,borderRadius:10,padding:"1px 7px"}}>
                      {listings.filter(l=>stFilter==="active"?l.state==="active":stFilter==="inactive"?l.state!=="active":true).length}
                    </span>
                  </div>
                  {sections.map(sec=>{
                    const cnt = listings.filter(l =>
                      l.shop_section_id===sec.shop_section_id &&
                      (stFilter==="active"?l.state==="active":stFilter==="inactive"?l.state!=="active":true)
                    ).length;
                    const sel = filterSection===sec.shop_section_id;
                    return (
                      <div key={sec.shop_section_id} onClick={()=>setFilterSection(sel?null:sec.shop_section_id)} style={{
                        display:"flex",alignItems:"center",justifyContent:"space-between",
                        padding:"5px 9px",borderRadius:6,cursor:"pointer",marginBottom:1,
                        background:sel?"#F5640012":"transparent",
                      }}>
                        <span style={{fontSize:12,fontWeight:sel?700:400,color:sel?"#F56400":C.ink,
                          overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1,paddingRight:6}}>{sec.title}</span>
                        <span style={{fontSize:11,color:sel?"#F56400":C.inkFaint,background:sel?"#F5640020":C.card,
                          borderRadius:10,padding:"1px 7px",flexShrink:0}}>{cnt}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Tags */}
              {topTags.length>0 && (
                <div>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                    <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:.7,color:C.inkFaint}}>Tags</div>
                    {filterTags.size>0 && (
                      <button onClick={()=>setFilterTags(new Set())} style={{fontSize:10,color:C.red,background:"none",border:"none",cursor:"pointer",padding:0,fontWeight:600}}>clear</button>
                    )}
                  </div>
                  {topTags.map(([tag,cnt])=>(
                    <div key={tag} onClick={()=>setFilterTags(prev=>{const n=new Set(prev);n.has(tag)?n.delete(tag):n.add(tag);return n;})}
                      style={{display:"flex",alignItems:"center",gap:7,padding:"3px 9px",borderRadius:6,cursor:"pointer",marginBottom:1,
                        background:filterTags.has(tag)?"#F5640010":"transparent"}}>
                      <div style={{width:13,height:13,borderRadius:3,flexShrink:0,
                        border:`1.5px solid ${filterTags.has(tag)?"#F56400":C.border}`,
                        background:filterTags.has(tag)?"#F56400":"transparent",
                        display:"flex",alignItems:"center",justifyContent:"center"}}>
                        {filterTags.has(tag) && <span style={{color:"#fff",fontSize:9,lineHeight:1}}>✓</span>}
                      </div>
                      <span style={{fontSize:11,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",
                        color:filterTags.has(tag)?C.ink:C.inkMid}}>{tag}</span>
                      <span style={{fontSize:10,color:C.inkFaint,flexShrink:0}}>{cnt}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Main grid ── */}
          <div style={{flex:1,minWidth:0}}>
            {listingErr && (
              <div style={{background:C.amberBg,border:`1px solid ${C.amber}`,borderRadius:8,
                padding:"10px 16px",marginBottom:14,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                <div style={{flex:1,fontSize:12,color:C.amber,fontWeight:600}}>
                  {listingErr.includes("invalid_token") ? "⏱ Token expired" : `⚠ ${listingErr}`}
                </div>
                <button onClick={reconnectEtsy} style={{background:"#F56400",color:"#fff",borderRadius:7,padding:"6px 14px",
                  fontSize:11,fontWeight:700,border:"none",cursor:"pointer"}}>
                  Reconnect Etsy →
                </button>
              </div>
            )}

            {visListings.length===0
              ? <div style={{textAlign:"center",padding:"50px 0",color:C.inkFaint}}>
                  <div style={{fontSize:32,marginBottom:8}}>🏷️</div>
                  <div style={{fontSize:14,fontWeight:600}}>No listings found</div>
                </div>
              : <>
                  <div style={{fontSize:11,color:C.inkFaint,marginBottom:12}}>
                    {visListings.length} listing{visListings.length!==1?"s":""}
                    {filterSection!==null && ` · ${sections.find(s=>s.shop_section_id===filterSection)?.title||"section"}`}
                    {filterTags.size>0 && ` · ${filterTags.size} tag filter${filterTags.size!==1?"s":""}`}
                  </div>
                  {/* Best active discount percentage across all running sales */}
                  {(()=>{
                    const bestPct = activeSales.reduce((m,s)=>Math.max(m,parseFloat(s.percent_off||0)),0);
                    return (
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(175px,1fr))",gap:12}}>
                    {visListings.map(l=>{
                      const img    = l.images?.[0]||l.main_image;
                      const imgUrl = img?.url_570xN||img?.url_170x135||img?.url_fullxfull;
                      const rawAmt = l.price?.amount||0, rawDiv = l.price?.divisor||100, rawCode = l.price?.currency_code||"INR";
                      const listedPrice = rawAmt/rawDiv;
                      const price  = l.price ? fmtCur(rawAmt,rawDiv,rawCode) : "—";
                      const salePrice = bestPct>0 ? listedPrice*(1-bestPct/100) : null;
                      const active = l.state==="active";
                      return (
                        <div key={l.listing_id} style={{background:C.surface,
                          border:`1.5px solid ${active?C.border:"#F5640025"}`,
                          borderRadius:10,overflow:"hidden",display:"flex",flexDirection:"column",
                          opacity:active?1:0.75}}>
                          <div style={{height:148,background:C.card,overflow:"hidden",position:"relative"}}>
                            {imgUrl
                              ? <img src={imgUrl} alt={l.title} style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                              : <div style={{width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:32}}>🏷️</div>}
                            <div style={{position:"absolute",top:6,left:6,
                              background:active?"rgba(34,197,94,.85)":"rgba(0,0,0,.55)",
                              color:"#fff",borderRadius:4,fontSize:8,fontWeight:700,
                              padding:"2px 6px",textTransform:"uppercase",letterSpacing:.5}}>
                              {l.state}
                            </div>
                            <div style={{position:"absolute",top:6,right:6,background:"rgba(0,0,0,.5)",
                              color:"#fff",borderRadius:4,fontSize:9,padding:"2px 6px"}}>
                              👁 {(l.views||0).toLocaleString()}
                            </div>
                            {salePrice && active && (
                              <div style={{position:"absolute",bottom:6,left:6,background:"#dc2626dd",
                                color:"#fff",borderRadius:4,fontSize:8,fontWeight:700,
                                padding:"2px 6px",letterSpacing:.3}}>
                                -{bestPct}%
                              </div>
                            )}
                          </div>
                          <div style={{padding:"10px 12px",flex:1,display:"flex",flexDirection:"column",gap:2}}>
                            <div style={{fontSize:11,fontWeight:700,color:C.ink,lineHeight:1.35,
                              overflow:"hidden",display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical"}}>
                              {l.title}
                            </div>
                            <div style={{marginTop:"auto",paddingTop:6}}>
                              {salePrice && active ? (
                                <div style={{display:"flex",alignItems:"baseline",gap:6,flexWrap:"wrap"}}>
                                  <span style={{fontSize:15,fontWeight:700,color:"#dc2626"}}>
                                    {fmtCur(Math.round(salePrice*rawDiv),rawDiv,rawCode)}
                                  </span>
                                  <span style={{fontSize:11,color:C.inkFaint,textDecoration:"line-through"}}>
                                    {price}
                                  </span>
                                  <span style={{fontSize:10,color:C.inkFaint,marginLeft:"auto"}}>qty {l.quantity}</span>
                                </div>
                              ) : (
                                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                                  <span style={{fontSize:15,fontWeight:700,color:"#F56400"}}>{price}</span>
                                  <span style={{fontSize:10,color:C.inkFaint}}>qty {l.quantity}</span>
                                </div>
                              )}
                            </div>
                            <div style={{display:"flex",gap:5,marginTop:6}}>
                              <button onClick={()=>openEdit(l)} style={{flex:1,background:C.card,
                                border:`1px solid ${C.border}`,color:C.ink,borderRadius:5,
                                padding:"4px 0",fontSize:10,fontWeight:600,cursor:"pointer"}}>
                                ✏ Edit
                              </button>
                              <a href={l.url} target="_blank" rel="noreferrer"
                                style={{flex:1,background:"#F5640010",border:"1px solid #F5640030",
                                  color:"#F56400",borderRadius:5,padding:"4px 0",fontSize:10,fontWeight:600,
                                  textDecoration:"none",textAlign:"center"}}>
                                View ↗
                              </a>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                    );
                  })()}
                </>
            }
          </div>
        </div>
      )}

      {/* ══ ORDERS TAB ══ */}
      {subTab==="orders" && (
        hasOAuth === false
          ? <div style={{textAlign:"center",padding:"60px 0",color:C.inkFaint}}>
              <div style={{fontSize:36,marginBottom:10}}>🔑</div>
              <div style={{fontSize:14,fontWeight:600,marginBottom:14}}>Connect Etsy to view orders</div>
              <button onClick={reconnectEtsy}
                style={{background:"#F56400",color:"#fff",borderRadius:8,padding:"10px 24px",
                  fontSize:13,fontWeight:700,border:"none",cursor:"pointer"}}>Connect Etsy Shop →</button>
            </div>
          : <div>
              {/* filter pills */}
              <div style={{display:"flex",gap:6,marginBottom:16,flexWrap:"wrap"}}>
                {[
                  {k:"all",       label:"All",       n:orders.length,          c:C.ink},
                  {k:"pending",   label:"Pending",   n:pendingOrders.length,   c:C.amber},
                  {k:"completed", label:"Completed", n:completedOrders.length, c:C.green},
                ].map(f=>(
                  <button key={f.k} onClick={()=>setOrderFilter(f.k)} style={{
                    padding:"5px 14px",borderRadius:20,cursor:"pointer",
                    border:`1.5px solid ${orderFilter===f.k?f.c:C.border}`,
                    background:orderFilter===f.k?f.c+"18":"transparent",
                    color:orderFilter===f.k?f.c:C.inkMid,
                    fontSize:12,fontWeight:orderFilter===f.k?700:400,
                  }}>{f.label} <span style={{opacity:.7}}>({f.n})</span></button>
                ))}
              </div>
              {visOrders.length===0
                ? <div style={{textAlign:"center",padding:"50px 0",color:C.inkFaint}}>
                    <div style={{fontSize:32,marginBottom:8}}>📦</div>
                    <div style={{fontSize:14,fontWeight:600}}>No {orderFilter!=="all"?orderFilter+" ":""}orders</div>
                  </div>
                : <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {visOrders.map(o=>{
                const isOpen = expanded===o.receipt_id;
                const total  = fmtCur(o.grandtotal?.amount||0,o.grandtotal?.divisor||100,o.grandtotal?.currency_code||"USD");
                const txns   = o.transactions||[];
                const items  = txns.reduce((s,t)=>s+(t.quantity||1),0);
                const isDone = o.is_shipped || DONE_STATUSES.includes(o.status);
                const sc     = isDone ? C.green : C.amber;
                const liveTrack = receiptTrackingCode(o);
                const liveDraft = fulfillDraft(o);
                // Hero image + title — match the global Orders row format so photos
                // are visible on the collapsed row, not only after expanding.
                const firstTxn   = txns[0];
                const firstImg   = firstTxn?.image_data?.url_170x135 || firstTxn?.image_data?.url_75x75 || firstTxn?.image_data?.url_570xN || "";
                const firstTitle = firstTxn?.title || `Order #${o.receipt_id}`;
                const extraItems = items - (firstTxn?.quantity || 1);
                return (
                  <div key={o.receipt_id} style={{background:C.surface,border:`1.5px solid ${C.border}`,borderRadius:10,overflow:"hidden"}}>
                    <div onClick={()=>setExpanded(isOpen?null:o.receipt_id)}
                      style={{padding:"10px 14px",cursor:"pointer",display:"flex",alignItems:"center",gap:12}}>
                      <div style={{width:9,height:9,borderRadius:"50%",background:sc,flexShrink:0}}/>
                      <div style={{width:54,height:54,borderRadius:9,overflow:"hidden",background:C.card,flexShrink:0,border:`1px solid ${C.border}`}}>
                        {firstImg
                          ? <img src={firstImg} alt="" loading="eager" decoding="async" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                          : <div style={{width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22}}>💎</div>}
                      </div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:"flex",gap:8,alignItems:"baseline",flexWrap:"wrap",marginBottom:3}}>
                          <span style={{fontSize:11,fontWeight:800,fontFamily:"monospace",color:C.amber}}>ETSY-{o.receipt_id}</span>
                          <span style={{fontSize:14,fontWeight:750,color:C.ink,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",minWidth:0}}>
                            {firstTitle}
                          </span>
                        </div>
                        <div style={{fontSize:11,color:C.inkFaint,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                          {o.name||o.buyer_email||"Buyer"} · {fmtDate(o.create_timestamp||o.creation_tsz)}{extraItems>0?` · +${extraItems} more item${extraItems>1?"s":""}`:""}
                        </div>
                      </div>
                      <span style={{fontSize:10,color:sc,background:sc+"20",border:`1px solid ${sc}50`,
                        borderRadius:5,padding:"2px 8px",textTransform:"uppercase",letterSpacing:.5,fontWeight:700,flexShrink:0}}>
                        {isDone ? "Shipped" : "New"}
                      </span>
                      <div style={{fontSize:15,fontWeight:700,color:C.green,flexShrink:0}}>{total}</div>
                      <span style={{color:C.inkFaint,fontSize:12,flexShrink:0}}>{isOpen?"▲":"▼"}</span>
                    </div>

                    {isOpen && (
                      <div style={{borderTop:`1px solid ${C.border}`,padding:"16px",display:"flex",flexDirection:"column",gap:14}}>
                        {/* line items */}
                        <div style={{display:"flex",flexDirection:"column",gap:8}}>
                          {(o.transactions||[]).map((t,i)=>{
                            const tImg = t.image_data?.url_75x75||t.image_data?.url_170x135;
                            return (
                              <div key={i} style={{display:"flex",alignItems:"center",gap:12,
                                padding:"10px 12px",background:C.card,borderRadius:8}}>
                                {tImg
                                  ? <img src={tImg} alt="" style={{width:52,height:52,borderRadius:7,objectFit:"cover",flexShrink:0}}/>
                                  : <div style={{width:52,height:52,borderRadius:7,background:C.border,
                                      display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,flexShrink:0}}>💎</div>}
                                <div style={{flex:1}}>
                                  <div style={{fontSize:13,fontWeight:600,color:C.ink}}>{t.title}</div>
                                  <div style={{fontSize:11,color:C.inkFaint,marginTop:2}}>
                                    Qty {t.quantity}
                                    {t.selected_variations?.length>0 && ` · ${t.selected_variations.map(v=>v.formatted_value).join(", ")}`}
                                  </div>
                                  {t.listing_id && <div style={{fontSize:10,color:C.inkFaint,marginTop:1}}>Listing #{t.listing_id}</div>}
                                </div>
                                <div style={{fontSize:14,fontWeight:700,color:C.green,flexShrink:0}}>
                                  {t.price ? fmtCur(t.price.amount*(t.quantity||1),t.price.divisor,t.price.currency_code) : ""}
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {/* customer + shipping */}
                        <div style={{display:"grid",gridTemplateColumns:mob()?"1fr":"1fr 1fr",gap:12}}>
                          <div style={{background:C.card,borderRadius:8,padding:"12px 14px"}}>
                            <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:.7,color:C.inkFaint,marginBottom:8}}>Customer</div>
                            {o.name && <div style={{fontSize:13,fontWeight:700,color:C.ink,marginBottom:4}}>{o.name}</div>}
                            {o.buyer_email && <div style={{fontSize:12,color:C.inkMid}}>📧 {o.buyer_email}</div>}
                            {o.buyer_user_id && <div style={{fontSize:11,color:C.inkFaint,marginTop:2}}>Etsy UID: {o.buyer_user_id}</div>}
                            {(()=>{
                              const prev = o.buyer_email ? orders.filter(x=>x.buyer_email===o.buyer_email&&x.receipt_id!==o.receipt_id) : [];
                              return prev.length>0 ? <div style={{fontSize:11,color:C.green,marginTop:4}}>★ Repeat buyer ({prev.length+1} orders)</div> : null;
                            })()}
                          </div>
                          <div style={{background:C.card,borderRadius:8,padding:"12px 14px"}}>
                            <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:.7,color:C.inkFaint,marginBottom:8}}>Ship To</div>
                            {(o.first_line||o.city)
                              ? <div style={{fontSize:12,color:C.ink,lineHeight:1.7}}>
                                  {o.name && <div>{o.name}</div>}
                                  {o.first_line && <div>{o.first_line}</div>}
                                  {o.second_line && <div>{o.second_line}</div>}
                                  {(o.city||o.state||o.zip) && <div>{[o.city,o.state,o.zip].filter(Boolean).join(", ")}</div>}
                                  {o.country_iso && <div style={{fontWeight:600}}>{o.country_iso}</div>}
                                </div>
                              : <div style={{fontSize:12,color:C.inkFaint}}>No address available</div>}
                          </div>
                        </div>

                        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:"12px 14px"}}>
                          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,flexWrap:"wrap",marginBottom:isDone?0:10}}>
                            <div>
                              <div style={{fontSize:10,fontWeight:800,textTransform:"uppercase",letterSpacing:.7,color:"#F56400",marginBottom:3}}>Complete Etsy Order</div>
                              <div style={{fontSize:12,color:C.inkMid}}>
                                {isDone ? `Completed${liveTrack ? ` · ${liveTrack}` : ""}` : "Enter tracking and this will mark the Etsy order complete."}
                              </div>
                            </div>
                            <div style={{fontSize:11,color:C.inkFaint,fontWeight:700}}>Receipt #{o.receipt_id}</div>
                          </div>
                          {!isDone && (
                            <>
                              <div style={{display:"grid",gridTemplateColumns:mob()?"1fr":"minmax(220px,1fr) 160px auto",gap:8,alignItems:"center"}}>
                                <input value={liveDraft.tracking_code}
                                  onChange={e=>updateFulfillDraft(o,{tracking_code:e.target.value})}
                                  placeholder="Tracking number"
                                  style={{...FI(),fontSize:12,padding:"8px 10px",borderRadius:8}}/>
                                <input value={liveDraft.carrier_name}
                                  onChange={e=>updateFulfillDraft(o,{carrier_name:e.target.value})}
                                  placeholder="Carrier, e.g. DHL"
                                  style={{...FI(),fontSize:12,padding:"8px 10px",borderRadius:8}}/>
                                <button onClick={()=>completeLiveEtsyOrder(o)} disabled={!!liveDraft.loading}
                                  style={{background:"#F56400",color:"#fff",border:"none",borderRadius:8,padding:"8px 13px",fontSize:12,fontWeight:850,cursor:liveDraft.loading?"wait":"pointer",opacity:liveDraft.loading ? .7 : 1,whiteSpace:"nowrap"}}>
                                  {liveDraft.loading ? "Completing..." : "Add Tracking + Complete"}
                                </button>
                              </div>
                              {liveDraft.error && (
                                <div style={{marginTop:8,fontSize:12,color:C.red,background:C.redBg,border:`1px solid ${C.red}30`,borderRadius:8,padding:"7px 9px",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                                  <span style={{flex:1,minWidth:180}}>{liveDraft.error}</span>
                                  {needsEtsyReconnect(liveDraft.error) && (
                                    <button onClick={reconnectEtsy}
                                      style={{background:"#F56400",color:"#fff",border:"none",borderRadius:7,padding:"6px 12px",fontSize:12,fontWeight:850,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0}}>
                                      🔑 Reconnect Etsy
                                    </button>
                                  )}
                                </div>
                              )}
                            </>
                          )}
                        </div>

                        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:"12px 14px"}}>
                          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,flexWrap:"wrap"}}>
                            <div>
                              <div style={{fontSize:10,fontWeight:800,textTransform:"uppercase",letterSpacing:.7,color:C.green,marginBottom:3}}>Atyahara Invoice</div>
                              <div style={{fontSize:12,color:C.inkMid}}>Create or refresh a draft Finance invoice from this Etsy receipt.</div>
                            </div>
                            <button onClick={()=>createAtyaharaInvoiceForReceipt(o)} disabled={!!liveInvoiceDraft(o).loading}
                              style={{background:C.green,color:"#fff",border:"none",borderRadius:8,padding:"8px 13px",fontSize:12,fontWeight:850,cursor:liveInvoiceDraft(o).loading?"wait":"pointer",opacity:liveInvoiceDraft(o).loading ? .7 : 1,whiteSpace:"nowrap"}}>
                              {liveInvoiceDraft(o).loading ? "Creating..." : "Create Invoice"}
                            </button>
                          </div>
                          {liveInvoiceDraft(o).error && (
                            <div style={{marginTop:8,fontSize:12,color:C.red,background:C.redBg,border:`1px solid ${C.red}30`,borderRadius:8,padding:"7px 9px"}}>
                              {liveInvoiceDraft(o).error}
                            </div>
                          )}
                          {liveInvoiceDraft(o).success && (
                            <div style={{marginTop:8,fontSize:12,color:C.green,background:C.greenBg,border:`1px solid ${C.green}30`,borderRadius:8,padding:"7px 9px"}}>
                              {liveInvoiceDraft(o).success}
                            </div>
                          )}
                        </div>

                        {/* totals row + buyer message */}
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:10}}>
                          <div>
                            {o.message_from_buyer && (
                              <div style={{fontSize:12,color:C.inkMid,fontStyle:"italic",maxWidth:380,
                                background:C.card,padding:"8px 12px",borderRadius:7,border:`1px solid ${C.border}`}}>
                                💬 "{o.message_from_buyer}"
                              </div>
                            )}
                          </div>
                          <div style={{textAlign:"right",flexShrink:0}}>
                            {o.subtotal && <div style={{fontSize:11,color:C.inkFaint}}>Subtotal: {fmtCur(o.subtotal.amount,o.subtotal.divisor,o.subtotal.currency_code)}</div>}
                            {o.total_shipping_cost && <div style={{fontSize:11,color:C.inkFaint}}>Shipping: {fmtCur(o.total_shipping_cost.amount,o.total_shipping_cost.divisor,o.total_shipping_cost.currency_code)}</div>}
                            <div style={{fontSize:16,fontWeight:700,color:C.green,marginTop:2}}>{total}</div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
                  </div>
              }
            </div>
      )}

      {/* ══ CUSTOMERS TAB ══ */}
      {subTab==="customers" && (
        hasOAuth === false
          ? <div style={{textAlign:"center",padding:"60px 0",color:C.inkFaint}}>
              <div style={{fontSize:36,marginBottom:10}}>🔑</div>
              <div style={{fontSize:14,fontWeight:600,marginBottom:14}}>Connect Etsy to view customers</div>
              <button onClick={reconnectEtsy}
                style={{background:"#F56400",color:"#fff",borderRadius:8,padding:"10px 24px",fontSize:13,fontWeight:700,border:"none",cursor:"pointer"}}>
                Connect Etsy Shop →
              </button>
            </div>
          : visCust.length===0
          ? <div style={{textAlign:"center",padding:"50px 0",color:C.inkFaint}}>
              <div style={{fontSize:32,marginBottom:8}}>👥</div>
              <div style={{fontSize:14,fontWeight:600}}>No customers yet</div>
            </div>
          : <div>
              <div style={{fontSize:12,color:C.inkFaint,marginBottom:14}}>
                {visCust.length} unique customer{visCust.length!==1?"s":""} · {orders.length} total orders
              </div>
              <div style={{display:"grid",gridTemplateColumns:mob()?"1fr":"repeat(auto-fill,minmax(280px,1fr))",gap:12}}>
                {visCust.map((c,i)=>(
                  <div key={i} style={{background:C.surface,border:`1.5px solid ${C.border}`,borderRadius:11,padding:"16px 18px"}}>
                    <div style={{display:"flex",alignItems:"flex-start",gap:12,marginBottom:12}}>
                      <div style={{width:40,height:40,borderRadius:"50%",background:"#F5640018",
                        border:"1.5px solid #F5640040",display:"flex",alignItems:"center",
                        justifyContent:"center",fontSize:16,flexShrink:0,fontWeight:700,color:"#F56400"}}>
                        {c.name ? c.name.charAt(0).toUpperCase() : "?"}
                      </div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:13,fontWeight:700,color:C.ink,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.name||"Unknown"}</div>
                        {c.email && <div style={{fontSize:11,color:C.inkFaint,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.email}</div>}
                      </div>
                      {c.count>1 && (
                        <div style={{background:"#F5640015",border:"1px solid #F5640040",borderRadius:20,
                          padding:"2px 9px",fontSize:11,fontWeight:700,color:"#F56400",flexShrink:0}}>
                          ★ Repeat
                        </div>
                      )}
                    </div>
                    <div style={{display:"flex",gap:20,fontSize:12}}>
                      <div>
                        <div style={{fontSize:20,fontWeight:700,color:"#F56400"}}>{c.count}</div>
                        <div style={{fontSize:10,color:C.inkFaint,textTransform:"uppercase",letterSpacing:.5}}>Orders</div>
                      </div>
                      <div>
                        <div style={{fontSize:20,fontWeight:700,color:C.green}}>{ccySym}{c.total.toLocaleString("en-IN",{maximumFractionDigits:0})}</div>
                        <div style={{fontSize:10,color:C.inkFaint,textTransform:"uppercase",letterSpacing:.5}}>Spent</div>
                      </div>
                      <div>
                        <div style={{fontSize:13,fontWeight:600,color:C.ink}}>{fmtDate(c.lastOrder)}</div>
                        <div style={{fontSize:10,color:C.inkFaint,textTransform:"uppercase",letterSpacing:.5}}>Last Order</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
      )}

      {/* ══ EDIT LISTING MODAL ══ */}
      {editL && (()=>{
        const IS = {padding:"9px 12px",borderRadius:8,border:`1.5px solid ${C.border}`,
          fontSize:13,background:C.surface,color:C.ink,outline:"none",width:"100%",boxSizing:"border-box"};
        const SL = {color:C.inkFaint,fontSize:11,fontWeight:600,marginBottom:5,display:"block",letterSpacing:.2};

        // calc values
        const wt  = parseFloat(calcWeight)||0, cp = parseFloat(calcCostPer)||0;
        const mu  = parseFloat(calcMarkup)||0,  fee= parseFloat(calcFees)||9.5;
        const cg  = calcUnit==="kg"?cp/1000:cp;
        const base= wt*cg, amu=base*(1+mu/100), afe=amu/(1-fee/100), lp=afe/0.75;

        const libAll = libImages();
        const libFiltered = libAll.filter(item=>
          !pickerSearch||item.name?.toLowerCase().includes(pickerSearch.toLowerCase())||
          item.category?.toLowerCase().includes(pickerSearch.toLowerCase())
        );

        return (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.6)",zIndex:1000,
          display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div style={{background:C.bg,borderRadius:16,width:"100%",maxWidth:860,
            maxHeight:"92vh",display:"flex",flexDirection:"column",
            boxShadow:"0 20px 60px rgba(0,0,0,.45)"}}>

            {/* ── Header ── */}
            <div style={{display:"flex",alignItems:"center",gap:12,
              padding:"16px 20px",borderBottom:`1px solid ${C.border}`,flexShrink:0}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:15,fontWeight:700,color:C.ink,overflow:"hidden",
                  textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{editL.title}</div>
                <div style={{fontSize:11,color:C.inkFaint,marginTop:1}}>
                  #{editL.listing_id}
                  {editL.state==="active"
                    ? <span style={{marginLeft:8,color:C.green,fontWeight:600}}>● Active</span>
                    : <span style={{marginLeft:8,color:C.amber,fontWeight:600}}>● Inactive</span>}
                </div>
              </div>
              <a href={`https://www.etsy.com/listing/${editL.listing_id}`} target="_blank" rel="noreferrer"
                style={{fontSize:11,color:"#F56400",fontWeight:600,textDecoration:"none",
                  padding:"5px 10px",border:"1px solid #F5640050",borderRadius:7,flexShrink:0}}>
                View on Etsy ↗
              </a>
              <button onClick={()=>{setEditL(null);setShowCalc(false);}}
                style={{background:"none",border:"none",fontSize:22,cursor:"pointer",
                  color:C.inkMid,lineHeight:1,padding:"0 2px",flexShrink:0}}>×</button>
            </div>

            {/* ── Body (two columns) ── */}
            <div style={{flex:1,overflow:"hidden",display:"flex",minHeight:0}}>

              {/* LEFT — Photos */}
              <div style={{width:mob()?0:270,flexShrink:0,borderRight:`1px solid ${C.border}`,
                overflowY:"auto",padding:"16px 14px",display:mob()?"none":"flex",
                flexDirection:"column",gap:12,background:C.card}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                  <span style={{fontSize:12,fontWeight:700,color:C.ink}}>
                    Photos <span style={{color:editImages.length>10?C.red:C.inkFaint,fontWeight:400}}>
                      ({editImages.length}/10)
                    </span>
                  </span>
                </div>

                {/* Photo grid */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6}}>
                  {editImages.map((img,idx)=>{
                    const url=img.url_570xN||img.url_fullxfull||img.url_170x135;
                    return (
                      <div key={img.listing_image_id||idx}
                        style={{position:"relative",aspectRatio:"1",borderRadius:8,overflow:"hidden",
                          border:`2px solid ${idx===0?"#F56400":C.border}`}}>
                        <img src={url} alt="" style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}}/>
                        {idx===0 && (
                          <div style={{position:"absolute",top:4,left:4,background:"#F56400",color:"#fff",
                            borderRadius:4,fontSize:7,fontWeight:800,padding:"2px 5px",letterSpacing:.4}}>COVER</div>
                        )}
                        <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0)",
                          transition:"background .15s",display:"flex",alignItems:"flex-end",justifyContent:"flex-end",
                          padding:4,gap:3}}
                          onMouseOver={e=>{e.currentTarget.style.background="rgba(0,0,0,.3)";}}
                          onMouseOut={e=>{e.currentTarget.style.background="rgba(0,0,0,0)";}}>
                          <a href={url} download target="_blank" rel="noreferrer"
                            style={{width:22,height:22,background:"rgba(0,0,0,.7)",color:"#fff",
                              borderRadius:4,fontSize:12,textDecoration:"none",display:"flex",
                              alignItems:"center",justifyContent:"center"}}>↓</a>
                          <button onClick={()=>deleteListingImg(img.listing_image_id)}
                            style={{width:22,height:22,background:"rgba(220,38,38,.85)",color:"#fff",
                              border:"none",borderRadius:4,fontSize:13,cursor:"pointer",
                              display:"flex",alignItems:"center",justifyContent:"center",lineHeight:1}}>×</button>
                        </div>
                      </div>
                    );
                  })}
                  {imgUploading && (
                    <div style={{aspectRatio:"1",borderRadius:8,border:`2px dashed ${C.border}`,
                      display:"flex",alignItems:"center",justifyContent:"center",
                      fontSize:20,color:C.inkFaint,animation:"spin 1s linear infinite"}}>⟳</div>
                  )}
                </div>

                {/* Upload + Library buttons */}
                <div style={{display:"flex",gap:6}}>
                  <label style={{flex:1,textAlign:"center",padding:"8px",borderRadius:8,cursor:"pointer",
                    border:`1.5px dashed ${C.border}`,fontSize:12,fontWeight:600,color:C.inkMid,
                    background:"transparent",opacity:imgUploading?.5:1}}>
                    {imgUploading?"Uploading…":"+ Upload"}
                    <input type="file" accept="image/*" multiple style={{display:"none"}} disabled={imgUploading}
                      onChange={e=>{[...e.target.files].forEach(f=>uploadFileToListing(f));e.target.value="";}}/>
                  </label>
                  <button onClick={()=>setShowPicker(v=>!v)}
                    style={{flex:1,padding:"8px",borderRadius:8,cursor:"pointer",fontSize:12,fontWeight:600,
                      border:`1.5px solid ${showPicker?"#F56400":"#F5640050"}`,
                      background:showPicker?"#F5640010":"transparent",color:"#F56400"}}>
                    From Library
                  </button>
                </div>

                {/* Library picker */}
                {showPicker && (
                  <div style={{background:C.bg,borderRadius:10,border:`1.5px solid ${C.border}`,padding:10}}>
                    <input value={pickerSearch} onChange={e=>setPickerSearch(e.target.value)}
                      autoFocus placeholder="Search stone, shape…"
                      style={{...IS,fontSize:12,padding:"6px 10px",marginBottom:8}}/>
                    {libFiltered.length===0
                      ? <div style={{fontSize:12,color:C.inkFaint,textAlign:"center",padding:"12px 0"}}>
                          {libAll.length===0?"Library empty — add photos first":"No matches"}
                        </div>
                      : <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:5,maxHeight:200,overflowY:"auto"}}>
                          {libFiltered.flatMap(item=>(item.images||[]).filter(i=>!i.isVideo).slice(0,3).map((img,ii)=>(
                            <div key={`${item.id}-${ii}`} onClick={()=>{if(!imgUploading)uploadListingImg(img.url);}}
                              title={item.name}
                              style={{aspectRatio:"1",borderRadius:6,overflow:"hidden",cursor:"pointer",position:"relative"}}
                              onMouseOver={e=>e.currentTarget.firstChild.style.opacity=".7"}
                              onMouseOut={e=>e.currentTarget.firstChild.style.opacity="1"}>
                              <img src={img.url} alt="" style={{width:"100%",height:"100%",objectFit:"cover",display:"block",transition:"opacity .15s"}}/>
                            </div>
                          )))}
                        </div>
                    }
                  </div>
                )}
              </div>

              {/* RIGHT — Form */}
              <div style={{flex:1,overflowY:"auto",padding:"20px 22px",display:"flex",flexDirection:"column",gap:18}}>

                {/* Title */}
                <div>
                  <label style={SL}>Title <span style={{float:"right",fontWeight:400}}>{editForm.title.length}/140</span></label>
                  <input value={editForm.title} maxLength={140}
                    onChange={e=>setEditForm(f=>({...f,title:e.target.value}))} style={IS}/>
                </div>

                {/* Price + Qty + Status row */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <div>
                    <label style={SL}>Price (₹)</label>
                    <div style={{position:"relative"}}>
                      <input type="number" min="0" step="1" value={editForm.price}
                        onChange={e=>setEditForm(f=>({...f,price:e.target.value}))}
                        style={{...IS,paddingRight:34}}/>
                      <button onClick={()=>setShowCalc(v=>!v)} title="Price calculator"
                        style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",
                          background:"none",border:"none",cursor:"pointer",fontSize:15,
                          color:showCalc?"#F56400":C.inkFaint,padding:0,lineHeight:1}}>🧮</button>
                    </div>
                    {/* Calculator popover */}
                    {showCalc && (
                      <div style={{position:"absolute",zIndex:10,marginTop:4,
                        background:C.bg,border:`1.5px solid ${C.border}`,borderRadius:12,
                        padding:"14px 16px",boxShadow:"0 8px 32px rgba(0,0,0,.2)",
                        width:260,display:"flex",flexDirection:"column",gap:8}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:2}}>
                          <span style={{fontSize:12,fontWeight:700,color:C.ink}}>Price Calculator</span>
                          <button onClick={()=>setShowCalc(false)} style={{background:"none",border:"none",cursor:"pointer",fontSize:16,color:C.inkFaint,lineHeight:1}}>×</button>
                        </div>
                        {[
                          [calcWeight,setCalcWeight,calcUnit,setCalcUnit,true],
                        ].map((_,__)=>(
                          <div key="w" style={{display:"grid",gridTemplateColumns:"1fr auto",gap:6}}>
                            <input value={calcWeight} onChange={e=>setCalcWeight(e.target.value)}
                              placeholder="Weight" style={{...IS,fontSize:12,padding:"6px 8px"}}/>
                            <select value={calcUnit} onChange={e=>setCalcUnit(e.target.value)}
                              style={{...IS,width:"auto",padding:"6px 6px",fontSize:12}}>
                              <option value="g">g</option><option value="kg">kg</option>
                            </select>
                          </div>
                        ))}
                        <input value={calcCostPer} onChange={e=>setCalcCostPer(e.target.value)}
                          placeholder={`Cost per ${calcUnit} (₹)`} style={{...IS,fontSize:12,padding:"6px 8px"}}/>
                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
                          <input value={calcMarkup} onChange={e=>setCalcMarkup(e.target.value)}
                            placeholder="Markup %" style={{...IS,fontSize:12,padding:"6px 8px"}}/>
                          <input value={calcFees} onChange={e=>setCalcFees(e.target.value)}
                            placeholder="Fees %" style={{...IS,fontSize:12,padding:"6px 8px"}}/>
                        </div>
                        {lp>0 ? (
                          <>
                            <div style={{borderTop:`1px solid ${C.border}`,paddingTop:8,display:"flex",flexDirection:"column",gap:3}}>
                              {[[`Base`,`₹${base.toLocaleString("en-IN",{maximumFractionDigits:0})}`],
                                [`+${mu}% markup`,`₹${amu.toLocaleString("en-IN",{maximumFractionDigits:0})}`],
                                [`After ${fee}% fees`,`₹${afe.toLocaleString("en-IN",{maximumFractionDigits:0})}`],
                                [`÷0.75 (sale)`,`₹${lp.toLocaleString("en-IN",{maximumFractionDigits:0})}`],
                              ].map(([k,v])=>(
                                <div key={k} style={{display:"flex",justifyContent:"space-between",fontSize:11}}>
                                  <span style={{color:C.inkMid}}>{k}</span>
                                  <span style={{fontWeight:600,color:C.ink}}>{v}</span>
                                </div>
                              ))}
                            </div>
                            <button onClick={()=>{setEditForm(f=>({...f,price:Math.round(lp).toString()}));setShowCalc(false);}}
                              style={{padding:"8px",borderRadius:8,background:"#F56400",color:"#fff",
                                border:"none",cursor:"pointer",fontSize:13,fontWeight:700}}>
                              Use ₹{Math.round(lp).toLocaleString("en-IN")} →
                            </button>
                          </>
                        ) : <div style={{fontSize:11,color:C.inkFaint}}>Enter weight + cost to calculate</div>}
                      </div>
                    )}
                  </div>
                  <div>
                    <label style={SL}>Quantity</label>
                    <input type="number" min="0" value={editForm.quantity}
                      onChange={e=>setEditForm(f=>({...f,quantity:e.target.value}))} style={IS}/>
                  </div>
                </div>

                {/* Status + Section */}
                <div style={{display:"grid",gridTemplateColumns:"auto 1fr",gap:16,alignItems:"start"}}>
                  <div>
                    <label style={SL}>Status</label>
                    <div style={{display:"inline-flex",borderRadius:8,border:`1.5px solid ${C.border}`,overflow:"hidden"}}>
                      {[["active","Active"],["inactive","Inactive"]].map(([s,l])=>(
                        <button key={s} onClick={()=>setEditForm(f=>({...f,state:s}))}
                          style={{padding:"7px 16px",border:"none",cursor:"pointer",fontSize:12,fontWeight:600,
                            background:editForm.state===s?(s==="active"?"#16a34a":"#d97706"):"transparent",
                            color:editForm.state===s?"#fff":C.inkMid,transition:"all .15s"}}>
                          {l}
                        </button>
                      ))}
                    </div>
                  </div>
                  {sections.length>0 && (
                    <div>
                      <label style={SL}>Section</label>
                      <select value={editForm.section_id||editL.shop_section_id||""}
                        onChange={e=>setEditForm(f=>({...f,section_id:e.target.value}))}
                        style={{...IS,fontSize:12}}>
                        <option value="">No section</option>
                        {sections.map(s=><option key={s.shop_section_id} value={s.shop_section_id}>{s.title}</option>)}
                      </select>
                    </div>
                  )}
                </div>

                {/* Tags */}
                <div>
                  <label style={SL}>Tags <span style={{fontWeight:400}}>{editForm.tags.length}/13</span></label>
                  <div style={{display:"flex",flexWrap:"wrap",gap:6,minHeight:42,
                    border:`1.5px solid ${C.border}`,borderRadius:8,padding:"7px 10px",
                    background:C.surface,cursor:"text"}}
                    onClick={()=>document.getElementById("etsy-tag-input")?.focus()}>
                    {editForm.tags.map(t=>(
                      <span key={t} style={{display:"inline-flex",alignItems:"center",gap:3,
                        background:"#F5640012",border:"1px solid #F5640030",borderRadius:20,
                        padding:"3px 10px",fontSize:12,color:"#c2410c",fontWeight:500}}>
                        {t}
                        <button onClick={e=>{e.stopPropagation();removeTag(t);}}
                          style={{background:"none",border:"none",cursor:"pointer",
                            color:"#F56400",fontSize:13,lineHeight:1,padding:"0 0 0 2px"}}>×</button>
                      </span>
                    ))}
                    {editForm.tags.length<13 && (
                      <input id="etsy-tag-input" value={tagInput} onChange={e=>setTagInput(e.target.value)}
                        onKeyDown={e=>{if(e.key==="Enter"||e.key===","){e.preventDefault();addTag();}}}
                        placeholder={editForm.tags.length===0?"Add tags…":"+ tag"}
                        style={{border:"none",background:"transparent",outline:"none",fontSize:13,
                          color:C.ink,minWidth:70,flexGrow:1}}/>
                    )}
                  </div>
                  <div style={{fontSize:11,color:C.inkFaint,marginTop:4}}>Enter or comma to add · max 13 · multi-word tags work great</div>
                </div>

                {/* Description */}
                <div>
                  <label style={SL}>Description</label>
                  <textarea value={editForm.description}
                    onChange={e=>setEditForm(f=>({...f,description:e.target.value}))}
                    rows={7} style={{...IS,resize:"vertical",lineHeight:1.6}}/>
                </div>

                {saveErr && (
                  <div style={{background:"#fef2f2",border:"1px solid #fca5a5",borderRadius:8,
                    padding:"10px 14px",fontSize:12,color:"#b91c1c"}}>⚠ {saveErr}</div>
                )}
              </div>
            </div>

            {/* ── Footer ── */}
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
              padding:"14px 22px",borderTop:`1px solid ${C.border}`,flexShrink:0,
              background:C.bg}}>
              <div style={{fontSize:11,color:C.inkFaint}}>
                {editImages.length} photo{editImages.length!==1?"s":""} · {editForm.tags.length} tags
                {editForm.title.length>100&&<span style={{color:C.amber,marginLeft:8}}>Title: {editForm.title.length}/140</span>}
              </div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={()=>{setEditL(null);setShowCalc(false);}}
                  style={{padding:"9px 20px",borderRadius:8,border:`1.5px solid ${C.border}`,
                    background:"transparent",color:C.ink,fontSize:13,cursor:"pointer",fontWeight:600}}>
                  Cancel
                </button>
                <button onClick={saveEdit} disabled={saving}
                  style={{padding:"9px 28px",borderRadius:8,border:"none",
                    background:saving?"#ccc":"#F56400",color:"#fff",
                    fontSize:13,cursor:saving?"not-allowed":"pointer",fontWeight:700,
                    boxShadow:saving?"none":"0 2px 8px #F5640040"}}>
                  {saving?"Saving…":"Save Changes"}
                </button>
              </div>
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   EBAY SHOP MANAGER
══════════════════════════════════════════════════════════════════════════ */
const EBAY_CACHE = "ng-ebay-v1";

function EbayLiveView() {
  const loadCache = () => { try { return JSON.parse(localStorage.getItem(EBAY_CACHE)||"{}"); } catch { return {}; } };
  const c0 = loadCache();

  const [connected,  setConnected]  = useState(null);
  const [username,   setUsername]   = useState("");
  const [noToken,    setNoToken]    = useState(false);
  const [listings,   setListings]   = useState(c0.listings || []);
  const [orders,     setOrders]     = useState(c0.orders   || []);
  const [loading,    setLoading]    = useState(!c0.listings?.length);
  const [syncing,    setSyncing]    = useState(false);
  const [error,      setError]      = useState(null);
  const [subTab,     setSubTab]     = useState("listings");
  const [search,     setSearch]     = useState("");
  const [editItem,       setEditItem]       = useState(null);
  const [editForm,       setEditForm]       = useState({});
  const [loadingItem,    setLoadingItem]    = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [showPhotoMenu,  setShowPhotoMenu]  = useState(false);
  const [showLibPicker,  setShowLibPicker]  = useState(false);
  const [libSearch,      setLibSearch]      = useState("");
  const [saving,         setSaving]         = useState(false);
  const [saveErr,        setSaveErr]        = useState(null);
  const [toast,          setToast]          = useState("");
  const photoInputRef = useRef();

  const getLibImages = () => { try { return JSON.parse(localStorage.getItem("ng-image-library-v1") || "[]"); } catch { return []; } };

  const showToast = m => { setToast(m); setTimeout(() => setToast(""), 3500); };
  const EBAY_BLUE = "#0064D2";

  const fetchAll = async (bg = false) => {
    bg ? setSyncing(true) : setLoading(true);
    setError(null);
    try {
      const pr = await fetch("/api/ebay?action=ping");
      const pd = await pr.json();
      if (!pd.connected && pd.reason?.includes("not set")) { setNoToken(true); setLoading(false); setSyncing(false); return; }
      setConnected(pd.connected);
      if (pd.username) setUsername(pd.username);
      if (!pd.connected) { setLoading(false); setSyncing(false); return; }

      const [lr, or_] = await Promise.all([
        fetch("/api/ebay?action=get_listings"),
        fetch("/api/ebay?action=get_orders"),
      ]);
      let newListings = listings, newOrders = orders;
      if (lr.ok) { const ld = await lr.json(); newListings = ld.results || []; setListings(newListings); }
      if (or_.ok) {
        const od = await or_.json(); newOrders = od.results || []; setOrders(newOrders);
        // Mirror eBay orders into the shared Orders store so they show in the Orders module.
        // Keyed by a stable ebay-<id>; manual/ERP edits on the row are preserved, only the
        // live synced fields (status, total) are refreshed.
        try {
          const current = await loadK(ORDERS_KEY) || [];
          const prevById = new Map(current.map(o => [o.id, o]));
          for (const eo of newOrders) {
            if (!eo?.orderId) continue;
            const norm = {
              id: `ebay-${eo.orderId}`, platform: "ebay",
              order_number: `EBAY-${eo.orderId}`, platform_order_id: String(eo.orderId),
              listing_title: eo.items?.[0]?.title || `eBay order ${eo.orderId}`,
              buyer_name: eo.buyer || "", sale_price: +eo.total || 0, order_total: +eo.total || 0,
              currency: eo.currency || "USD", status: eo.status || "",
              date: (eo.created || "").slice(0, 10) || undefined, created_at: eo.created || undefined,
              source: "ebay-sync",
            };
            const prev = prevById.get(norm.id);
            const merged = { ...norm, ...prev, status: norm.status || prev?.status, sale_price: norm.sale_price, order_total: norm.order_total };
            if (!prev || JSON.stringify(prev) !== JSON.stringify(merged)) await upsertItemK(ORDERS_KEY, merged, { prepend: true });
          }
        } catch {}
      }
      try { localStorage.setItem(EBAY_CACHE, JSON.stringify({ listings: newListings, orders: newOrders, syncedAt: Date.now() })); } catch {}
    } catch (e) { setError(e.message); }
    bg ? setSyncing(false) : setLoading(false);
  };

  useEffect(() => {
    const age = c0.syncedAt ? Date.now() - c0.syncedAt : Infinity;
    if (c0.listings?.length && age < 10 * 60 * 1000) {
      setConnected(true);
    } else {
      fetchAll(c0.listings?.length > 0);
    }
  }, []);

  const openEdit = async item => {
    setEditItem(item);
    setEditForm({ title: item.title, price: item.price, quantity: item.quantity, description: item.description || "", conditionId: item.conditionId || "1000", shippingCost: item.shippingCost ?? "", imageUrls: item.imageUrls || [] });
    setSaveErr(null);
    setLoadingItem(true);
    try {
      const r = await fetch(`/api/ebay?action=get_item&item_id=${item.itemId}`);
      if (r.ok) {
        const full = await r.json();
        setEditForm(f => ({
          ...f,
          description:  full.description  || f.description,
          conditionId:  full.conditionId  || f.conditionId,
          shippingCost: full.shippingCost !== undefined ? full.shippingCost : f.shippingCost,
          imageUrls:    full.imageUrls?.length ? full.imageUrls : f.imageUrls,
        }));
      }
    } catch {}
    setLoadingItem(false);
  };

  const addPhoto = async file => {
    if (!file || !editItem) return;
    setUploadingPhoto(true);
    try {
      const ext = file.name.split(".").pop().toLowerCase();
      const path = `ng-stock/ebay/${editItem.itemId}-${Date.now()}.${ext}`;
      const url = await uploadToStorage(path, file);
      setEditForm(f => ({ ...f, imageUrls: [...f.imageUrls, url] }));
    } catch (e) { setSaveErr("Photo upload: " + e.message); }
    setUploadingPhoto(false);
  };

  const movePhoto = (i, dir) => setEditForm(f => {
    const imgs = [...f.imageUrls];
    const j = i + dir;
    if (j < 0 || j >= imgs.length) return f;
    [imgs[i], imgs[j]] = [imgs[j], imgs[i]];
    return { ...f, imageUrls: imgs };
  });

  const removePhoto = i => setEditForm(f => ({ ...f, imageUrls: f.imageUrls.filter((_, j) => j !== i) }));

  const saveEdit = async () => {
    if (!editItem) return;
    setSaving(true); setSaveErr(null);
    try {
      const payload = {
        title:        editForm.title,
        price:        editForm.price,
        quantity:     editForm.quantity,
        description:  editForm.description,
        conditionId:  editForm.conditionId,
        shippingCost: editForm.shippingCost !== "" ? editForm.shippingCost : undefined,
        imageUrls:    editForm.imageUrls,
      };
      const r = await fetch(`/api/ebay?action=update_item&item_id=${editItem.itemId}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) { setSaveErr(d.error || "Update failed"); setSaving(false); return; }
      setListings(prev => prev.map(l => l.itemId === editItem.itemId ? { ...l, ...editForm } : l));
      showToast("✓ eBay listing updated");
      setEditItem(null);
    } catch (e) { setSaveErr(e.message); }
    setSaving(false);
  };

  const fmtDate = ts => { if (!ts) return "—"; try { return new Date(ts).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); } catch { return ts; } };
  const filtered = listings.filter(l => !search || l.title?.toLowerCase().includes(search.toLowerCase()) || l.itemId?.includes(search));

  // ── Not configured ────────────────────────────────────────────────────────
  if (noToken) return (
    <div style={{ background: "#EEF4FF", border: `1.5px solid ${EBAY_BLUE}30`, borderRadius: 10, padding: "28px 24px", maxWidth: 560 }}>
      <div style={{ fontSize: 28, marginBottom: 10 }}>🔨</div>
      <div style={{ fontWeight: 700, fontSize: 15, color: EBAY_BLUE, marginBottom: 6 }}>Set your eBay User Token to connect</div>
      <div style={{ fontSize: 13, color: C.inkMid, lineHeight: 1.6, marginBottom: 16 }}>
        Go to <strong>Vercel → Project Settings → Environment Variables</strong> and add:
      </div>
      {[
        ["EBAY_APP_ID",     "ManavJha-listingm-PRD-d09ada41f-983e42c2"],
        ["EBAY_DEV_ID",     "63192232-0f1f-4e8e-9a0f-46f848543704"],
        ["EBAY_CERT_ID",    "PRD-09ada41f0e9e-6268-4ebd-aee9-b83e"],
        ["EBAY_USER_TOKEN", "v^1.1#i^1#… (copy from eBay developer portal → User Tokens)"],
      ].map(([k, v]) => (
        <div key={k} style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 8 }}>
          <code style={{ background: "#0064D215", color: EBAY_BLUE, borderRadius: 4, padding: "2px 7px", fontSize: 12, fontWeight: 700, flexShrink: 0 }}>{k}</code>
          <span style={{ fontSize: 11, color: C.inkFaint, wordBreak: "break-all" }}>{v}</span>
        </div>
      ))}
      <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 10 }}>After saving the env vars, redeploy and refresh this page.</div>
    </div>
  );

  return (
    <div>
      {toast && <div style={{ position:"fixed", bottom:22, right:22, zIndex:9999, background:C.ink, color:"#fff", padding:"10px 18px", borderRadius:6, fontSize:12, boxShadow:"0 8px 28px rgba(0,0,0,.18)" }}>{toast}</div>}

      {/* header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
        <div>
          <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 20, fontWeight: 700 }}>
            🔨 eBay {username && <span style={{ fontSize: 13, fontWeight: 400, color: C.inkFaint }}>{username}</span>}
          </div>
          <div style={{ fontSize: 11, color: C.inkFaint }}>{listings.length} active listings · {orders.length} orders</div>
        </div>
        <div style={{ flex: 1 }} />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
          style={{ ...FI(), width: 160, fontSize: 12, padding: "6px 12px", borderRadius: 20 }} />
        <button onClick={() => fetchAll(true)} disabled={syncing}
          style={{ background: "none", border: `1.5px solid ${EBAY_BLUE}`, color: EBAY_BLUE, borderRadius: 7, padding: "7px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", opacity: syncing ? .5 : 1 }}>
          {syncing ? "Syncing…" : "↻ Sync"}
        </button>
      </div>

      {/* sub-tabs */}
      <div style={{ display: "flex", borderBottom: `1px solid ${C.border}`, marginBottom: 18 }}>
        {[["listings", `Listings (${listings.length})`], ["orders", `Orders (${orders.length})`]].map(([k, label]) => (
          <button key={k} onClick={() => setSubTab(k)} style={{
            padding: "10px 16px", background: "none", border: "none", cursor: "pointer",
            borderBottom: `2.5px solid ${subTab === k ? EBAY_BLUE : "transparent"}`,
            color: subTab === k ? EBAY_BLUE : C.inkMid, fontWeight: subTab === k ? 700 : 400,
            fontSize: 13, marginBottom: -1,
          }}>{label}</button>
        ))}
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: "60px 0", color: C.inkFaint }}><Spinner /> Loading eBay data…</div>
      ) : error ? (
        <div style={{ background: C.redBg, border: `1px solid ${C.red}40`, borderRadius: 8, padding: "14px 18px", color: C.red, fontSize: 13 }}>⚠ {error}</div>
      ) : subTab === "listings" ? (
        filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: "60px 0" }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>🔨</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: C.inkMid }}>{search ? "No listings match" : "No active eBay listings"}</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {filtered.map(l => (
              <div key={l.itemId} style={{ background: C.surface, border: `1.5px solid ${C.border}`, borderRadius: 10, padding: "14px 18px", display: "flex", gap: 14, alignItems: "flex-start" }}>
                {l.imageUrls?.[0]
                  ? <img src={l.imageUrls[0]} alt="" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 6, flexShrink: 0, border: `1px solid ${C.border}` }} />
                  : <div style={{ width: 64, height: 64, borderRadius: 6, background: C.card, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>🔨</div>
                }
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.title}</div>
                  <div style={{ fontSize: 11, color: C.inkFaint, marginBottom: 6 }}>Item ID: {l.itemId}</div>
                  <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
                    <span style={{ fontSize: 15, fontWeight: 700, color: EBAY_BLUE }}>${Number(l.price).toFixed(2)}</span>
                    <span style={{ fontSize: 12, color: C.inkMid }}>Qty: {l.quantity}</span>
                    {l.quantitySold > 0 && <span style={{ fontSize: 11, color: C.green }}>✓ {l.quantitySold} sold</span>}
                    {l.listingUrl && <a href={l.listingUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: EBAY_BLUE, textDecoration: "none" }}>View ↗</a>}
                  </div>
                </div>
                <button onClick={() => openEdit(l)} style={{ background: "none", border: `1.5px solid ${C.border}`, borderRadius: 6, padding: "6px 12px", fontSize: 12, cursor: "pointer", color: C.inkMid, flexShrink: 0 }}>✏ Edit</button>
              </div>
            ))}
          </div>
        )
      ) : (
        orders.length === 0 ? (
          <div style={{ textAlign: "center", padding: "60px 0" }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📦</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: C.inkMid }}>No orders in the last 90 days</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {orders.map(o => (
              <div key={o.orderId} style={{ background: C.surface, border: `1.5px solid ${C.border}`, borderRadius: 10, padding: "14px 18px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{o.items?.[0]?.title || o.orderId}</div>
                    <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 2 }}>
                      Buyer: {o.buyer || "—"} · {fmtDate(o.created)}
                    </div>
                    {o.items?.length > 1 && <div style={{ fontSize: 11, color: C.inkFaint }}>+{o.items.length - 1} more item{o.items.length > 2 ? "s" : ""}</div>}
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14, color: EBAY_BLUE }}>${Number(o.total).toFixed(2)}</div>
                    <div style={{ fontSize: 10, color: C.inkFaint, marginTop: 2, textTransform: "uppercase", letterSpacing: .5 }}>{(o.status || "").replace(/_/g, " ")}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* Edit modal */}
      {editItem && (
        <div style={{ position: "fixed", inset: 0, zIndex: 600, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}>
          <div style={{ background: C.surface, borderRadius: 12, padding: "24px 26px", width: "min(500px,94vw)", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,.25)" }}>
            <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Edit eBay Listing</div>
            <div style={{ fontSize: 11, color: C.inkFaint, marginBottom: 18, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{editItem.title}</div>
            {loadingItem && <div style={{ fontSize: 11, color: EBAY_BLUE, marginBottom: 12 }}>Loading full details…</div>}

            {/* Photos */}
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .5, marginBottom: 8 }}>
                Photos <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>({editForm.imageUrls?.length || 0}/12 · first = gallery image)</span>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
                {(editForm.imageUrls || []).map((url, i) => (
                  <div key={url + i} style={{ position: "relative", width: 80, flexShrink: 0 }}>
                    <img src={url} alt="" style={{ width: 80, height: 80, objectFit: "cover", borderRadius: 6, border: `2px solid ${i === 0 ? EBAY_BLUE : C.border}`, display: "block" }} />
                    {i === 0 && <div style={{ position: "absolute", top: 3, left: 3, background: EBAY_BLUE, color: "#fff", fontSize: 8, fontWeight: 700, borderRadius: 3, padding: "1px 4px" }}>MAIN</div>}
                    <button onClick={() => removePhoto(i)} title="Remove" style={{ position: "absolute", top: 2, right: 2, width: 18, height: 18, borderRadius: "50%", background: "rgba(0,0,0,.65)", color: "#fff", border: "none", cursor: "pointer", fontSize: 11, lineHeight: "18px", textAlign: "center", padding: 0 }}>×</button>
                    <div style={{ display: "flex", justifyContent: "center", gap: 2, marginTop: 4 }}>
                      <button onClick={() => movePhoto(i, -1)} disabled={i === 0} title="Move left" style={{ flex: 1, background: C.card, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 11, cursor: i === 0 ? "default" : "pointer", opacity: i === 0 ? .3 : 1, padding: "2px 0" }}>←</button>
                      <button onClick={() => movePhoto(i,  1)} disabled={i === (editForm.imageUrls?.length || 1) - 1} title="Move right" style={{ flex: 1, background: C.card, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 11, cursor: i === (editForm.imageUrls?.length || 1) - 1 ? "default" : "pointer", opacity: i === (editForm.imageUrls?.length || 1) - 1 ? .3 : 1, padding: "2px 0" }}>→</button>
                    </div>
                  </div>
                ))}
                {(editForm.imageUrls?.length || 0) < 12 && (
                  <div style={{ position: "relative" }}>
                    <input ref={photoInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={e => { addPhoto(e.target.files[0]); e.target.value = ""; setShowPhotoMenu(false); }} />
                    <button onClick={() => setShowPhotoMenu(m => !m)} disabled={uploadingPhoto} style={{ width: 80, height: 80, borderRadius: 6, border: `2px dashed ${C.border}`, background: C.card, cursor: uploadingPhoto ? "wait" : "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, color: C.inkFaint, fontSize: 11, opacity: uploadingPhoto ? .6 : 1 }}>
                      {uploadingPhoto ? <Spinner /> : <><span style={{ fontSize: 22 }}>+</span><span>Add photo</span></>}
                    </button>
                    {showPhotoMenu && (
                      <div style={{ position: "absolute", top: 88, left: 0, zIndex: 800, background: C.surface, border: `1.5px solid ${C.border}`, borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,.15)", minWidth: 180, overflow: "hidden" }}>
                        <button onClick={() => { photoInputRef.current?.click(); setShowPhotoMenu(false); }}
                          style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "11px 14px", background: "none", border: "none", cursor: "pointer", fontSize: 13, color: C.ink, textAlign: "left" }}
                          onMouseEnter={e => e.currentTarget.style.background = C.card} onMouseLeave={e => e.currentTarget.style.background = "none"}>
                          <span style={{ fontSize: 16 }}>💻</span> Upload from computer
                        </button>
                        <div style={{ height: 1, background: C.border }} />
                        <button onClick={() => { setShowLibPicker(true); setShowPhotoMenu(false); setLibSearch(""); }}
                          style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "11px 14px", background: "none", border: "none", cursor: "pointer", fontSize: 13, color: C.ink, textAlign: "left" }}
                          onMouseEnter={e => e.currentTarget.style.background = C.card} onMouseLeave={e => e.currentTarget.style.background = "none"}>
                          <span style={{ fontSize: 16 }}>🖼️</span> Pick from Image Library
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Title */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .5, marginBottom: 4 }}>Title</div>
              <input type="text" value={editForm.title ?? ""} onChange={e => setEditForm(f => ({ ...f, title: e.target.value }))}
                style={{ ...FI(), width: "100%", boxSizing: "border-box" }} />
            </div>

            {/* Price + Qty row */}
            <div style={{ display: "flex", gap: 12, marginBottom: 14 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .5, marginBottom: 4 }}>Price (USD)</div>
                <input type="number" min="0" step="0.01" value={editForm.price ?? ""} onChange={e => setEditForm(f => ({ ...f, price: e.target.value }))}
                  style={{ ...FI(), width: "100%", boxSizing: "border-box" }} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .5, marginBottom: 4 }}>Quantity</div>
                <input type="number" min="0" step="1" value={editForm.quantity ?? ""} onChange={e => setEditForm(f => ({ ...f, quantity: e.target.value }))}
                  style={{ ...FI(), width: "100%", boxSizing: "border-box" }} />
              </div>
            </div>

            {/* Condition + Shipping row */}
            <div style={{ display: "flex", gap: 12, marginBottom: 14 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .5, marginBottom: 4 }}>Condition</div>
                <select value={editForm.conditionId ?? "1000"} onChange={e => setEditForm(f => ({ ...f, conditionId: e.target.value }))}
                  style={{ ...FI(), width: "100%", boxSizing: "border-box" }}>
                  <option value="1000">New</option>
                  <option value="1500">New (other)</option>
                  <option value="2500">Seller refurbished</option>
                  <option value="3000">Used</option>
                  <option value="4000">Very Good</option>
                  <option value="5000">Good</option>
                  <option value="6000">Acceptable</option>
                  <option value="7000">For parts / not working</option>
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .5, marginBottom: 4 }}>Shipping Cost (USD)</div>
                <input type="number" min="0" step="0.01" placeholder="0.00 = free" value={editForm.shippingCost ?? ""} onChange={e => setEditForm(f => ({ ...f, shippingCost: e.target.value }))}
                  style={{ ...FI(), width: "100%", boxSizing: "border-box" }} />
              </div>
            </div>

            {/* Description */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .5, marginBottom: 4 }}>Description</div>
              <textarea rows={5} value={editForm.description ?? ""} onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
                style={{ ...FI(), width: "100%", boxSizing: "border-box", resize: "vertical", fontFamily: "inherit", fontSize: 13, lineHeight: 1.5 }} />
            </div>

            {saveErr && <div style={{ color: C.red, fontSize: 12, marginBottom: 10 }}>⚠ {saveErr}</div>}
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={saveEdit} disabled={saving || loadingItem}
                style={{ flex: 1, background: EBAY_BLUE, border: "none", color: "#fff", borderRadius: 7, padding: "11px", fontSize: 13, fontWeight: 700, cursor: (saving || loadingItem) ? "not-allowed" : "pointer", opacity: (saving || loadingItem) ? .6 : 1 }}>
                {saving ? "Saving…" : "✓ Save Changes"}
              </button>
              <button onClick={() => setEditItem(null)}
                style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 7, padding: "11px 16px", fontSize: 13, cursor: "pointer", color: C.inkFaint }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Image Library Picker */}
      {showLibPicker && (() => {
        const allLib = getLibImages();
        const q = libSearch.toLowerCase();
        const visible = allLib.filter(img => !q || (img.name + " " + img.category).toLowerCase().includes(q));
        const alreadyAdded = new Set(editForm.imageUrls || []);
        return (
          <div style={{ position: "fixed", inset: 0, zIndex: 700, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
            <div style={{ background: C.surface, borderRadius: 12, width: "min(680px,96vw)", maxHeight: "88vh", display: "flex", flexDirection: "column", boxShadow: "0 24px 64px rgba(0,0,0,.3)" }}>
              {/* header */}
              <div style={{ padding: "18px 20px 14px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 18, fontWeight: 700 }}>Image Library</div>
                  <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 2 }}>{allLib.length} images · click to add to listing</div>
                </div>
                <input value={libSearch} onChange={e => setLibSearch(e.target.value)} placeholder="Search…"
                  style={{ ...FI(), width: 160, fontSize: 12, padding: "6px 12px", borderRadius: 20 }} autoFocus />
                <button onClick={() => setShowLibPicker(false)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: C.inkFaint, padding: "0 4px" }}>×</button>
              </div>
              {/* grid */}
              <div style={{ overflowY: "auto", padding: 16, flex: 1 }}>
                {visible.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "40px 0", color: C.inkFaint, fontSize: 13 }}>
                    {allLib.length === 0 ? "No images in library yet — upload some via the Image Library tab." : "No images match."}
                  </div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(110px,1fr))", gap: 10 }}>
                    {visible.map(img => {
                      const added = alreadyAdded.has(img.imageUrl);
                      const canAdd = !added && (editForm.imageUrls?.length || 0) < 12;
                      return (
                        <div key={img.id} onClick={() => {
                          if (!canAdd) return;
                          setEditForm(f => ({ ...f, imageUrls: [...(f.imageUrls || []), img.imageUrl] }));
                          setShowLibPicker(false);
                        }} style={{ cursor: canAdd ? "pointer" : "default", borderRadius: 8, overflow: "hidden", border: `2px solid ${added ? EBAY_BLUE : C.border}`, position: "relative", opacity: added ? .6 : 1, transition: "border-color .15s" }}
                          onMouseEnter={e => { if (canAdd) e.currentTarget.style.borderColor = EBAY_BLUE; }}
                          onMouseLeave={e => { if (!added) e.currentTarget.style.borderColor = C.border; }}>
                          <img src={img.imageUrl} alt={img.name} style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block" }} loading="lazy" />
                          {added && <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,100,210,.25)", fontSize: 22 }}>✓</div>}
                          {img.name && <div style={{ padding: "4px 6px", fontSize: 10, color: C.inkMid, background: C.surface, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{img.name}</div>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              {/* footer */}
              <div style={{ padding: "12px 20px", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "flex-end" }}>
                <button onClick={() => setShowLibPicker(false)} style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 7, padding: "8px 18px", fontSize: 13, cursor: "pointer", color: C.inkFaint }}>Close</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function PlatformView({ platform, listings, orders, stock, onEdit, onPublish, onUnpublish, onMarkSold }) {
  const pkey         = platform.key;
  const liveListings = listings.filter(l => l.platforms?.[pkey]?.status === "active");
  const pOrders      = orders.filter(o => o.platform === pkey);
  const revenue      = pOrders.reduce((s, o) => s + (+o.sale_price || 0), 0);

  const [search,     setSearch]     = useState("");
  const [publishing, setPublishing] = useState({});
  const [toast,      setToast]      = useState("");

  const showToast = (m, ms = 3000) => { setToast(m); setTimeout(() => setToast(""), ms); };

  const visible = liveListings.filter(l =>
    !search || [l.title, l.material, l.shape, l.sku].join(" ").toLowerCase().includes(search.toLowerCase())
  );

  const handleUnpublish = async listing => {
    if (!confirm(`Remove "${listing.title}" from ${platform.label}?`)) return;
    setPublishing(p => ({ ...p, [listing.id]: "removing" }));
    try { await onUnpublish(listing, pkey); showToast("Removed"); }
    catch (e) { showToast("⚠ " + e.message); }
    finally { setPublishing(p => ({ ...p, [listing.id]: false })); }
  };

  return (
    <div>
      <Toast msg={toast} />

      {/* platform header card */}
      <div style={{ background: platform.color + "12", border: `1.5px solid ${platform.color}40`,
        borderRadius: 12, padding: "18px 22px", marginBottom: 22,
        display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
        <div style={{ fontSize: 40 }}>{platform.icon}</div>
        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: platform.color,
            fontFamily: "'Cormorant Garamond',Georgia,serif" }}>{platform.label}</div>
          <div style={{ fontSize: 12, color: C.inkMid, marginTop: 3 }}>
            {liveListings.length} active · {pOrders.length} sales · ₹{fmt(revenue)} revenue
          </div>
        </div>
        <div style={{ display: "flex", gap: 24, textAlign: "center" }}>
          {[
            { label: "Active",  val: liveListings.length,           color: platform.color },
            { label: "Sales",   val: pOrders.length,                color: C.green       },
            { label: "Revenue", val: `₹${revenue > 999 ? `${(revenue/1000).toFixed(1)}k` : revenue}`, color: C.green },
          ].map(s => (
            <div key={s.label}>
              <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 22, fontWeight: 700, color: s.color, lineHeight: 1 }}>{s.val}</div>
              <div style={{ fontSize: 10, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .5, marginTop: 1 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* search */}
      <input value={search} onChange={e => setSearch(e.target.value)}
        placeholder={`Search ${platform.label} listings…`}
        style={{ ...FI(), maxWidth: 320, fontSize: 12, padding: "7px 12px", borderRadius: 20, marginBottom: 16 }} />

      {visible.length === 0 ? (
        <div style={{ textAlign: "center", padding: "50px 0", color: C.inkFaint }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>{platform.icon}</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>No active listings on {platform.label}</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Publish listings from the All Listings tab.</div>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "repeat(auto-fill,minmax(270px,1fr))", gap: 12 }}>
          {visible.map(listing => {
            const ps           = listing.platforms?.[pkey] || {};
            const linkedStk    = stock.find(s => s.id === listing.linked_stock_id);
            const salesForThis = pOrders.filter(o => o.listing_id === listing.id).length;

            return (
              <div key={listing.id} style={{ background: C.surface,
                border: `1.5px solid ${platform.color}35`, borderRadius: 10, overflow: "hidden" }}>
                {/* photo */}
                <div style={{ height: 150, overflow: "hidden", background: C.card, position: "relative" }}>
                  {listing.images?.[0]
                    ? <img src={listing.images[0]} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 36 }}>💎</div>}
                  {salesForThis > 0 && (
                    <div style={{ position: "absolute", top: 8, right: 8, background: "rgba(0,0,0,.7)",
                      color: "#fff", borderRadius: 6, fontSize: 11, fontWeight: 700, padding: "3px 8px" }}>
                      {salesForThis} sold
                    </div>
                  )}
                </div>

                {/* info */}
                <div style={{ padding: "12px 14px" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 2 }}>{listing.title}</div>
                  <div style={{ fontSize: 11, color: C.inkMid, marginBottom: 8 }}>
                    {[listing.material, listing.shape].filter(Boolean).join(" · ")}
                    {listing.sku && <span style={{ marginLeft: 6, fontFamily: "monospace", fontSize: 10, color: C.inkFaint }}>SKU: {listing.sku}</span>}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <span style={{ fontSize: 17, fontWeight: 700, color: platform.color }}>₹{fmt(listing[platform.priceField])}</span>
                    <span style={{ fontSize: 11, color: C.inkFaint }}>
                      {linkedStk ? `${linkedStk.qty} ${linkedStk.unit || "pcs"} in stock` : listing.type === "unique" ? "Unique" : `${listing.qty || 1} pcs`}
                    </span>
                  </div>

                  <div style={{ display: "flex", gap: 6 }}>
                    {(ps.url || ps.listing_id || ps.product_id) && (
                      <a href={ps.url || `https://www.etsy.com/listing/${ps.listing_id}`}
                        target="_blank" rel="noreferrer"
                        style={{ flex: 1, padding: "7px 0", textAlign: "center", background: platform.color + "20",
                          border: `1px solid ${platform.color}40`, borderRadius: 6,
                          fontSize: 11, color: platform.color, fontWeight: 600, textDecoration: "none" }}>
                        View ↗
                      </a>
                    )}
                    <button onClick={() => onMarkSold(listing)}
                      style={{ flex: 1, padding: "7px 0", background: C.greenBg, border: `1px solid ${C.green}40`,
                        borderRadius: 6, fontSize: 11, color: C.green, cursor: "pointer", fontWeight: 700 }}>
                      Mark Sold
                    </button>
                    <button onClick={() => onEdit(listing)}
                      style={{ padding: "7px 10px", background: C.surface, border: `1.5px solid ${C.border}`,
                        borderRadius: 6, fontSize: 11, color: C.ink, cursor: "pointer" }}>
                      Edit
                    </button>
                    <button onClick={() => handleUnpublish(listing)}
                      disabled={!!publishing[listing.id]}
                      style={{ padding: "7px 10px", background: C.redBg, border: `1px solid ${C.red}40`,
                        borderRadius: 6, fontSize: 11, color: C.red, cursor: "pointer" }}>
                      {publishing[listing.id] === "removing" ? <Spinner /> : "✕"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ShopifyEarthView({ listings, onEditLocal }) {
  const platform = PLATFORMS.find(p => p.key === "shopify_earth");
  const [products, setProducts] = useState([]);
  const [collections, setCollections] = useState([]);
  const [creds, setCreds] = useState(null);
  const [storeInput, setStoreInput] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");
  const [tagFilter, setTagFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [collectionFilter, setCollectionFilter] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [editP, setEditP] = useState(null);

  const showToast = m => { setToast(m); setTimeout(() => setToast(""), 3200); };
  const firstImage = p => p.image?.src || p.images?.[0]?.src || "";
  const firstVariant = p => p.variants?.[0] || {};
  const adminUrl = p => p.admin_graphql_api_id
    ? `https://${creds?.store || ""}/admin/products/${p.id}`
    : `https://${creds?.store || ""}/admin/products/${p.id}`;
  const storefrontUrl = p => {
    const base = String(creds?.publicUrl || (creds?.store ? `https://${creds.store}` : "")).replace(/\/$/, "");
    return p.handle && base ? `${base}/products/${p.handle}` : "";
  };
  const productTags = p => Array.isArray(p.tags) ? p.tags : String(p.tags || "").split(",").map(t => t.trim()).filter(Boolean);
  const readProductCache = () => {
    try {
      const cached = JSON.parse(localStorage.getItem(SHOPIFY_EARTH_CACHE_KEY) || "null");
      if (cached && Array.isArray(cached.products)) return cached;
    } catch {}
    return null;
  };
  const saveProductCache = data => {
    try {
      localStorage.setItem(SHOPIFY_EARTH_CACHE_KEY, JSON.stringify({
        products: data.products || [],
        collections: data.collections || [],
        shop: data.shop || "",
        publicUrl: data.publicUrl || "",
        savedAt: Date.now(),
      }));
    } catch {}
  };

  const loadCreds = async () => {
    const saved = await loadK("ng-shopify-creds-v1");
    if (saved?.store && saved?.token) {
      const normalized = { store: saved.store, token: saved.token };
      setCreds(normalized);
      setStoreInput(saved.store);
      return normalized;
    }
    setCreds({});
    return {};
  };

  const fetchProducts = async (nextCreds = creds, bg = false, nextCollection = collectionFilter) => {
    if (!bg) setLoading(true);
    setError("");
    try {
      const r = await fetch("/api/shopify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "list_products",
          status: "any",
          limit: 250,
          store_key: "earth",
          ...(nextCollection ? { collection_id: nextCollection } : {}),
          // Manual creds (if the user saved an override) win; otherwise the
          // server uses the SHOPIFY_EARTH_* env creds — same as Image Library.
          ...(nextCreds?.token ? { shopStore: nextCreds.store, shopToken: nextCreds.token } : {}),
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.success) throw new Error(d.error || "Could not fetch Shopify products");
      setProducts(d.products || []);
      setCollections(d.collections || []);
      if (d.shop) setCreds(c => ({ ...(c || {}), store: d.shop, publicUrl: d.publicUrl }));
      if (!nextCollection) saveProductCache(d);
    } catch (e) {
      setError(e.message || "Could not fetch Shopify products");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const cached = readProductCache();
    if (cached) {
      setProducts(cached.products || []);
      setCollections(cached.collections || []);
      if (cached.shop) setCreds(c => ({ ...(c || {}), store: cached.shop, publicUrl: cached.publicUrl }));
      setLoading(false);
    }
    loadCreds().then(c => fetchProducts(c, !!cached, ""));
  }, []);

  const saveCreds = async () => {
    const store = storeInput.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const token = tokenInput.trim();
    if (!store || !token) { setError("Enter store domain and Admin API token"); return; }
    const next = { store, token };
    await saveK("ng-shopify-creds-v1", next);
    setCreds(next);
    setTokenInput("");
    fetchProducts(next);
  };

  const openEdit = p => {
    const v = firstVariant(p);
    setEditP({
      id: p.id,
      title: p.title || "",
      body_html: p.body_html || "",
      tags: Array.isArray(p.tags) ? p.tags.join(", ") : p.tags || "",
      status: p.status || "active",
      product_type: p.product_type || "",
      variant_id: v.id || "",
      sku: v.sku || "",
      price: v.price || "",
      inventory_quantity: v.inventory_quantity ?? "",
      image: firstImage(p),
    });
  };

  const saveEdit = async () => {
    if (!editP) return;
    setSaving(true);
    setError("");
    try {
      const r = await fetch("/api/shopify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_product",
          store_key: "earth",
          ...(creds?.token ? { shopStore: creds.store, shopToken: creds.token } : {}),
          product: editP,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.success) throw new Error(d.error || "Shopify update failed");
      setProducts(prev => prev.map(p => String(p.id) === String(d.product.id) ? d.product : p));
      setEditP(null);
      showToast("✓ Earth Editions product updated");
    } catch (e) {
      setError(e.message || "Shopify update failed");
    } finally {
      setSaving(false);
    }
  };

  const linkLocal = p => {
    const v = firstVariant(p);
    const norm = s => String(s || "").trim().toLowerCase();
    const match = listings.find(l =>
      (v.sku && norm(l.sku) === norm(v.sku)) ||
      (l.platforms?.shopify_earth?.product_id && String(l.platforms.shopify_earth.product_id) === String(p.id)) ||
      norm(l.title) === norm(p.title)
    );
    if (match) onEditLocal(match);
    else showToast("No matching local Listing Manager row found");
  };

  const tagOptions = [...new Set(products.flatMap(productTags))].filter(Boolean).sort((a,b)=>a.localeCompare(b));
  const typeOptions = [...new Set(products.map(p => p.product_type).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  const selectedCollection = collections.find(c => String(c.id) === String(collectionFilter));
  const collectionMatchesProduct = p => {
    if (!collectionFilter) return true;
    if ((p.collection_ids || []).map(String).includes(String(collectionFilter))) return true;
    const raw = [selectedCollection?.handle, selectedCollection?.title].filter(Boolean).join(" ");
    const terms = raw.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/).filter(x => x.length > 2);
    const expanded = [...new Set(terms.flatMap(t => [t, t.endsWith("s") ? t.slice(0, -1) : `${t}s`]))];
    const haystack = [p.title, p.handle, p.product_type, productTags(p).join(" ")].join(" ").toLowerCase();
    return expanded.some(t => haystack.includes(t));
  };
  const visible = products
    .filter(p => statusFilter === "all" || p.status === statusFilter)
    .filter(p => !tagFilter || productTags(p).includes(tagFilter))
    .filter(p => !typeFilter || p.product_type === typeFilter)
    .filter(collectionMatchesProduct)
    .filter(p => !search || [p.title, p.handle, productTags(p).join(" "), p.product_type, firstVariant(p).sku].join(" ").toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));

  const counts = {
    all: products.length,
    active: products.filter(p => p.status === "active").length,
    draft: products.filter(p => p.status === "draft").length,
    archived: products.filter(p => p.status === "archived").length,
  };

  return (
    <div>
      <Toast msg={toast} />
      <div style={{ background: platform.color + "12", border: `1.5px solid ${platform.color}35`, borderRadius: 12, padding: "16px 18px", marginBottom: 14, display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ fontSize: 34 }}>{platform.icon}</div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 21, fontWeight: 750, color: platform.color }}>Earth Editions Shopify</div>
          <div style={{ fontSize: 12, color: C.inkMid, marginTop: 3 }}>
            {loading ? "Loading Shopify..." : `${products.length} Shopify products · ${counts.active} active · ${counts.draft} drafts`}
            {creds?.store ? ` · ${creds.store}` : ""}
          </div>
        </div>
        <button onClick={() => fetchProducts(creds, false, collectionFilter)}
          style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", fontSize: 12, fontWeight: 800, cursor: "pointer", color: C.ink }}>
          Refresh
        </button>
      </div>

      {!!error && /credential|token|store|domain|unauthor|401|403|not set/i.test(String(error)) && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, marginBottom: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: .7, color: platform.color, marginBottom: 10 }}>Connect Earth Editions <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: C.inkFaint }}>· override (defaults to server credentials)</span></div>
          <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "1fr 1fr auto", gap: 10, alignItems: "end" }}>
            <div>
              <Label>Store Domain</Label>
              <input value={storeInput} onChange={e => setStoreInput(e.target.value)} placeholder="eartheditions.myshopify.com" style={FI()} />
            </div>
            <div>
              <Label>Admin API Token</Label>
              <input value={tokenInput} onChange={e => setTokenInput(e.target.value)} placeholder="shpat_..." type="password" style={FI()} />
            </div>
            <button onClick={saveCreds} style={{ background: platform.color, border: "none", color: "#fff", borderRadius: 8, padding: "10px 16px", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>Save</button>
          </div>
        </div>
      )}

      {error && (
        <div style={{ background: C.redBg, border: `1px solid ${C.red}35`, color: C.red, borderRadius: 9, padding: "9px 12px", fontSize: 12, marginBottom: 12 }}>{String(error)}</div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "190px 1fr", gap: 12, alignItems: "start" }}>
        <aside style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 10, position: mob() ? "static" : "sticky", top: 10 }}>
          <div style={{ fontSize: 10, fontWeight: 850, textTransform: "uppercase", letterSpacing: .8, color: platform.color, marginBottom: 10 }}>Filters</div>
          <div style={{ display: "grid", gap: 10 }}>
            <div>
              <Label>Status</Label>
              <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={FI()}>
                <option value="all">All ({counts.all})</option>
                <option value="active">Active ({counts.active})</option>
                <option value="draft">Draft ({counts.draft})</option>
                <option value="archived">Archived ({counts.archived})</option>
              </select>
            </div>
            <div>
              <Label>Collection</Label>
              <select value={collectionFilter} onChange={e => { const val = e.target.value; setCollectionFilter(val); setTagFilter(""); setTypeFilter(""); fetchProducts(creds, false, val); }} style={FI()}>
                <option value="">All collections</option>
                {collections.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
            </div>
            <div>
              <Label>Tags</Label>
              <select value={tagFilter} onChange={e => setTagFilter(e.target.value)} style={FI()}>
                <option value="">All tags</option>
                {tagOptions.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <Label>Product Type</Label>
              <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={FI()}>
                <option value="">All types</option>
                {typeOptions.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            {(statusFilter !== "active" || tagFilter || typeFilter || collectionFilter || search) && (
              <button onClick={() => { setStatusFilter("active"); setTagFilter(""); setTypeFilter(""); setCollectionFilter(""); setSearch(""); fetchProducts(creds, false, ""); }}
                style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 10px", fontSize: 12, fontWeight: 800, color: C.inkMid, cursor: "pointer" }}>
                Clear filters
              </button>
            )}
          </div>
        </aside>

        <div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: C.inkFaint, fontWeight: 700 }}>{visible.length} shown</div>
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search Shopify title, SKU, tags..."
              style={{ ...FI(), width: mob() ? "100%" : 360, marginLeft: "auto", borderRadius: 10 }} />
          </div>

      {loading ? (
        <div style={{ padding: "50px 0", textAlign: "center", color: C.inkFaint }}><Spinner /> Loading Earth Editions...</div>
      ) : visible.length === 0 ? (
        <div style={{ padding: "55px 0", textAlign: "center", color: C.inkFaint }}>
          <div style={{ fontSize: 34, marginBottom: 8 }}>🌍</div>
          <div style={{ fontWeight: 750, color: C.inkMid }}>No Shopify products found</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Check the Earth Editions credentials or change the status filter.</div>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "repeat(4,minmax(0,1fr))", gap: 10 }}>
          {visible.map(p => {
            const v = firstVariant(p);
            const img = firstImage(p);
            const localMatch = listings.find(l => String(l.platforms?.shopify_earth?.product_id || "") === String(p.id) || (v.sku && l.sku === v.sku));
            return (
              <div key={p.id} style={{ background: C.surface, border: `1.5px solid ${platform.color}25`, borderRadius: 11, overflow: "hidden" }}>
                <div style={{ height: 138, background: C.card, position: "relative", overflow: "hidden" }}>
                  {img ? <img src={img} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> :
                    <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 34 }}>🌍</div>}
                  <span style={{ position: "absolute", top: 8, left: 8, borderRadius: 20, padding: "3px 8px", fontSize: 10, fontWeight: 850, textTransform: "uppercase", background: p.status === "active" ? C.greenBg : C.card, color: p.status === "active" ? C.green : C.inkMid, border: `1px solid ${C.border}` }}>{p.status}</span>
                </div>
                <div style={{ padding: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: C.ink, lineHeight: 1.25, minHeight: 32 }}>{p.title}</div>
                  <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {[p.product_type, v.sku && `SKU ${v.sku}`].filter(Boolean).join(" · ") || p.handle}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
                    <div style={{ fontSize: 15, fontWeight: 850, color: platform.color }}>{v.price ? `$${fmt(v.price)}` : "No price"}</div>
                    <div style={{ fontSize: 11, color: C.inkFaint }}>{v.inventory_quantity ?? 0} in stock</div>
                  </div>
                  <div style={{ display: "flex", gap: 5, marginTop: 9 }}>
                    <button onClick={() => openEdit(p)} style={{ flex: 1, background: platform.color, color: "#fff", border: "none", borderRadius: 7, padding: "7px 0", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>Edit</button>
                    <a href={storefrontUrl(p) || adminUrl(p)} target="_blank" rel="noreferrer"
                      style={{ flex: 1, textAlign: "center", textDecoration: "none", background: C.card, border: `1px solid ${C.border}`, borderRadius: 7, padding: "7px 0", fontSize: 11, fontWeight: 800, color: C.ink }}>View</a>
                    <button onClick={() => linkLocal(p)} style={{ background: localMatch ? C.greenBg : C.surface, color: localMatch ? C.green : C.inkMid, border: `1px solid ${localMatch ? C.green + "45" : C.border}`, borderRadius: 7, padding: "7px 8px", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
                      {localMatch ? "Local" : "Link"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
        </div>
      </div>

      {editP && (
        <div onClick={e => { if (e.target === e.currentTarget) setEditP(null); }}
          style={{ position: "fixed", inset: 0, background: "rgba(26,19,8,.58)", zIndex: 1300, display: "flex", alignItems: "center", justifyContent: "center", padding: 18 }}>
          <div style={{ width: "min(760px,100%)", maxHeight: "88vh", overflow: "auto", background: C.surface, borderRadius: 14, boxShadow: "0 24px 80px rgba(0,0,0,.32)" }}>
            <div style={{ padding: "15px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: .8, color: platform.color, fontWeight: 850 }}>Earth Editions</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: C.ink }}>Edit Shopify Product</div>
              </div>
              <button onClick={() => setEditP(null)} style={{ background: "none", border: "none", fontSize: 24, color: C.inkFaint, cursor: "pointer" }}>×</button>
            </div>
            <div style={{ padding: 18, display: "grid", gridTemplateColumns: mob() ? "1fr" : "160px 1fr", gap: 16 }}>
              <div>
                <div style={{ width: "100%", aspectRatio: "1", background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
                  {editP.image ? <img src={editP.image} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}
                </div>
              </div>
              <div style={{ display: "grid", gap: 11 }}>
                <div>
                  <Label>Title</Label>
                  <input value={editP.title} onChange={e => setEditP(p => ({ ...p, title: e.target.value }))} style={FI()} />
                </div>
                <Grid cols={3}>
                  <div>
                    <Label>Status</Label>
                    <select value={editP.status} onChange={e => setEditP(p => ({ ...p, status: e.target.value }))} style={FI()}>
                      <option value="active">Active</option>
                      <option value="draft">Draft</option>
                      <option value="archived">Archived</option>
                    </select>
                  </div>
                  <div>
                    <Label>Price</Label>
                    <input value={editP.price} onChange={e => setEditP(p => ({ ...p, price: e.target.value }))} type="number" style={FI()} />
                  </div>
                  <div>
                    <Label>Inventory</Label>
                    <input value={editP.inventory_quantity} onChange={e => setEditP(p => ({ ...p, inventory_quantity: e.target.value }))} type="number" style={FI()} />
                  </div>
                </Grid>
                <Grid cols={2}>
                  <div>
                    <Label>SKU</Label>
                    <input value={editP.sku} onChange={e => setEditP(p => ({ ...p, sku: e.target.value }))} style={FI()} />
                  </div>
                  <div>
                    <Label>Product Type</Label>
                    <input value={editP.product_type} onChange={e => setEditP(p => ({ ...p, product_type: e.target.value }))} style={FI()} />
                  </div>
                </Grid>
                <div>
                  <Label>Tags</Label>
                  <input value={editP.tags} onChange={e => setEditP(p => ({ ...p, tags: e.target.value }))} style={FI()} />
                </div>
                <div>
                  <Label>Description</Label>
                  <textarea value={editP.body_html} onChange={e => setEditP(p => ({ ...p, body_html: e.target.value }))}
                    rows={8} style={{ ...FI(), resize: "vertical", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }} />
                </div>
              </div>
            </div>
            <div style={{ padding: "13px 18px", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "flex-end", gap: 9 }}>
              <button onClick={() => setEditP(null)} style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 8, padding: "9px 14px", fontSize: 13, color: C.inkMid, cursor: "pointer" }}>Cancel</button>
              <button onClick={saveEdit} disabled={saving} style={{ background: platform.color, border: "none", borderRadius: 8, padding: "9px 18px", fontSize: 13, fontWeight: 850, color: "#fff", cursor: saving ? "wait" : "pointer", opacity: saving ? .7 : 1 }}>
                {saving ? "Saving..." : "Save Shopify"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   MAIN
══════════════════════════════════════════════════════════════════════════ */
export default function ListingManagerApp({ onHome, startTab = "listings" }) {
  const [listings,   setListings]   = useState([]);
  const [orders,     setOrders]     = useState([]);
  const [stock,      setStock]      = useState([]);
  const [loaded,     setLoaded]     = useState(false);

  const [tab,        setTab]        = useState(startTab);
  const [showForm,   setShowForm]   = useState(false);
  const [editing,    setEditing]    = useState(null);
  const [soldModal,  setSoldModal]  = useState(null);
  const [toast,      setToast]      = useState("");

  const [search,     setSearch]     = useState("");
  const [filter,     setFilter]     = useState("all");

  useEffect(() => { setTab(startTab); }, [startTab]);

  const showToast = m => { setToast(m); setTimeout(() => setToast(""), 3500); };

  // Reconcile local Etsy badges with Etsy's live state. The ERP only flips a
  // listing to "active" when published through its own button; if a draft is
  // activated (or sold/expired) on Etsy directly, the badge would stay stale.
  // Patches only platforms.etsy.status — never touches other ERP fields.
  // Throttled so navigating between tabs doesn't hammer the Etsy API.
  const ETSY_STATE_SYNC_TS = "ng-etsy-state-sync-ts";
  const reconcileEtsyStates = async (current) => {
    if (!current.some(l => l.platforms?.etsy?.listing_id)) return;
    try {
      const last = +localStorage.getItem(ETSY_STATE_SYNC_TS) || 0;
      if (Date.now() - last < 10 * 60 * 1000) return; // at most once per 10 min
      localStorage.setItem(ETSY_STATE_SYNC_TS, String(Date.now()));
    } catch {}
    try {
      const r = await fetch("/api/listing-manager?action=sync_etsy_states");
      const d = await r.json();
      if (!d.ok || !d.states) return;
      const states = d.states;
      const fresh = await loadKFresh(LIST_KEY).catch(() => null);
      const base = Array.isArray(fresh) ? fresh : current;
      const changedRows = [];
      const next = base.map(l => {
        const lid = l.platforms?.etsy?.listing_id;
        const live = lid && states[lid];
        if (!live) return l;
        const mapped = live === "active" ? "active" : "draft";
        if (l.platforms.etsy.status === mapped) return l;
        const updated = { ...l, platforms: { ...l.platforms, etsy: { ...l.platforms.etsy, status: mapped } } };
        changedRows.push(updated);
        return updated;
      });
      if (!changedRows.length) return;
      setListings(next);
      for (const listing of changedRows) await upsertItemK(LIST_KEY, listing, { prepend: false });
    } catch {}
  };

  useEffect(() => {
    Promise.all([loadK(LIST_KEY), loadK(ORDERS_KEY), loadK(STK_KEY)]).then(([l, o, s]) => {
      setListings(l || []); setOrders(o || []); setStock(s || []); setLoaded(true);
      reconcileEtsyStates(l || []);
    });
    const onOrdersUpdated = e => {
      if (Array.isArray(e.detail)) setOrders(e.detail);
      else loadK(ORDERS_KEY).then(o => setOrders(o || []));
    };
    window.addEventListener("ng-orders-updated", onOrdersUpdated);
    // Live cross-user sync: when another session saves listings/orders/stock, the
    // shared cache is invalidated and we re-read so this screen reflects their changes
    // (without this, each user only ever saw their own copy and saves clobbered each other).
    const offRefresh = onCacheRefresh(keys => {
      if (keys.includes(LIST_KEY))   loadK(LIST_KEY).then(l => { if (Array.isArray(l)) setListings(l); });
      if (keys.includes(ORDERS_KEY)) loadK(ORDERS_KEY).then(o => { if (Array.isArray(o)) setOrders(o); });
      if (keys.includes(STK_KEY))    loadK(STK_KEY).then(s => { if (Array.isArray(s)) setStock(s); });
    });
    // Reliable backstop: realtime/version invalidation handles active tabs. On
    // focus/online, do one fresh read in case this tab slept through an update.
    // Avoid interval polling here: listings/orders are large JSON blobs and a
    // few open tabs can burn Supabase CPU/network on small compute instances.
    const refreshFromServer = async () => {
      try {
        const [l, o] = await Promise.all([loadKFresh(LIST_KEY), loadKFresh(ORDERS_KEY)]);
        if (Array.isArray(l)) setListings(l);
        if (Array.isArray(o)) setOrders(o);
      } catch {}
    };
    const onVisible = () => { if (document.visibilityState === "visible") refreshFromServer(); };
    const onOnline = () => refreshFromServer();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("ng-orders-updated", onOrdersUpdated);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      offRefresh();
    };
  }, []);

  const BACKUP_KEY = "ng-listings-backup-v1";

  const saveListingItem = async (listing, opts = {}) => {
    const next = await upsertItemK(LIST_KEY, listing, opts);
    if (Array.isArray(next)) setListings(next);
    return next;
  };

  const removeListingItem = async id => {
    const next = await deleteItemK(LIST_KEY, id);
    if (Array.isArray(next)) setListings(next);
    return next;
  };

  const latestListing = async listing => {
    const fresh = await loadKFresh(LIST_KEY).catch(() => null);
    return (Array.isArray(fresh) ? fresh.find(l => l.id === listing.id) : null) || listing;
  };

  const patchListingItem = async (listing, patch) => {
    const base = await latestListing(listing);
    const updated = patch(base);
    await saveListingItem(updated, { prepend: false });
    return updated;
  };

  const saveOrderItem = async (order, opts = {}) => {
    const next = await upsertItemK(ORDERS_KEY, order, opts);
    if (Array.isArray(next)) setOrders(next);
    return next;
  };

  /* save */
  const handleSave = async (listing, publishTo = {}) => {
    let savedListing = listing;
    if ((listing.images || []).some(isLocalMediaUrl) || isLocalMediaUrl(listing.video)) {
      showToast("Uploading listing media...");
      try {
        savedListing = await persistListingMedia(listing);
      } catch (e) {
        showToast(`⚠ Media upload failed: ${e.message}`, 8000);
        return;
      }
    }
    const exists = listings.find(l => l.id === listing.id);
    try {
      await saveListingItem(savedListing, { prepend: !exists });
    } catch (e) {
      showToast(`⚠️ ${e.message}`, 8000);
      return;
    }
    setShowForm(false); setEditing(null);
    showToast(exists ? "✓ Listing updated" : "✓ Listing created");

    // Auto-sync any platform already linked (draft or active) + any newly checked ones
    const liveTargets = exists
      ? PLATFORMS.filter(p => {
          const pd = listing.platforms?.[p.key];
          if (!pd || pd.status === "deleted") return false;
          // Has a real listing ID on the platform
          if (p.key === "etsy" && pd.listing_id) return true;
          if (p.key === "ebay" && pd.item_id) return true;
          if ((p.key === "shopify_aty" || p.key === "shopify_earth") && pd.product_id) return true;
          return pd.status === "active" || pd.status === "draft";
        }).map(p => p.key)
      : [];
    const newTargets  = Object.entries(publishTo).filter(([, v]) => v).map(([k]) => k);
    const targets = [...new Set([...liveTargets, ...newTargets])];
    if (targets.length === 0) return;
    showToast(`Syncing to ${targets.map(k => PLATFORMS.find(p => p.key === k)?.label).join(", ")}…`);
    // Always sync-only on save — never activate. Only the explicit Publish button activates.
    const results = await Promise.allSettled(targets.map(pkey =>
      handlePublish(savedListing, pkey, { syncOnly: true })
    ));
    const failed = results.filter(r => r.status === "rejected");
    if (failed.length === 0) {
      showToast(`✓ Synced to ${targets.map(k => PLATFORMS.find(p => p.key === k)?.label).join(", ")}`);
    } else {
      const errMsg = failed.map(r => r.reason?.message || "unknown error").join("; ");
      showToast(`⚠ ${errMsg}`, 8000);
    }
  };

  /* delete */
  const handleDelete = async id => {
    if (!confirm("Delete this listing from your catalog? Won't remove from platforms.")) return;
    await removeListingItem(id);
    showToast("Deleted");
  };

  // Earth Editions Shopify creds are stored in the shared app data (set up via
  // Image Library / the Earth tab), NOT in Vercel env vars. Attach them to the
  // listing so the API uses them instead of the (unset) SHOPIFY_EARTH_* env vars.
  const withShopifyCreds = async (listing, storeKey) => {
    if (storeKey !== "earth") return listing;
    const c = await loadK("ng-shopify-creds-v1");
    if (c?.store && c?.token) return { ...listing, shopify_store: c.store, shopify_token: c.token };
    return listing;
  };

  /* publish — syncOnly=true means update fields only, never activate */
  const handlePublish = async (listing, pkey, { syncOnly = false } = {}) => {
    // Apply per-platform title/description overrides into _ai so the API picks them up
    const ai = { ...(listing._ai || {}) };
    if (pkey === "etsy") {
      if (listing.etsy_title)       ai.etsy_title       = listing.etsy_title;
      if (listing.etsy_description) ai.etsy_description = listing.etsy_description;
    } else if (pkey === "shopify_aty" || pkey === "shopify_earth") {
      if (listing.shopify_title)       ai.shopify_title       = listing.shopify_title;
      if (listing.shopify_description) ai.shopify_description = listing.shopify_description;
    }
    listing = { ...listing, _ai: ai };

    let result;

    if (pkey === "ebay") {
      // eBay — call ebay.js directly
      const existingItemId = listing.platforms?.ebay?.item_id;
      const r = await fetch("/api/ebay?action=publish_listing", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title:        listing.title,
          description:  listing._ai?.etsy_description || listing.description || listing.title,
          price:        listing.price_ebay,
          quantity:     listing.qty || 1,
          images:       listing.images || [],
          video:        listing.video || "",
          conditionId:  listing.conditionId || "3000",
          shippingCost: listing.shippingCost || 0,
          ...(existingItemId ? { itemId: existingItemId } : {}),
        }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || "eBay publish failed");
      if (d.videoWarning) showToast(`⚠ eBay video: ${d.videoWarning}`);
      result = { item_id: d.itemId, url: d.url || `https://www.ebay.com/itm/${d.itemId}` };
    } else {
      let action, storeKey;
      if (pkey === "etsy")             { action = "publish_etsy"; }
      else if (pkey === "shopify_aty") { action = "publish_shopify"; storeKey = "atyahara"; }
      else if (pkey === "shopify_earth"){ action = "publish_shopify"; storeKey = "earth"; }
      else throw new Error(`Platform ${pkey} not supported`);

      const r = await fetch("/api/listing-manager", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, listing: await withShopifyCreds(listing, storeKey), store_key: storeKey, sync_only: syncOnly }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || "Publishing failed");
      result = d.result;
    }

    await patchListingItem(listing, current => ({
      ...current,
      platforms: { ...current.platforms, [pkey]: { ...current.platforms?.[pkey], status: "active", ...result } },
      updated_at: now(),
    }));
    return result;
  };

  /* unpublish */
  const handleUnpublish = async (listing, pkey) => {
    let action, storeKey;
    if (pkey === "etsy")             { action = "unpublish_etsy"; }
    else if (pkey === "shopify_aty") { action = "unpublish_shopify"; storeKey = "atyahara"; }
    else if (pkey === "shopify_earth") { action = "unpublish_shopify"; storeKey = "earth"; }
    else if (pkey === "ebay") {
      const itemId = listing.platforms?.ebay?.item_id;
      if (!itemId) throw new Error("No eBay item ID found");
      const r = await fetch(`/api/ebay?action=end_item&item_id=${itemId}`, { method: "POST" });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || "eBay delete failed");
      await patchListingItem(listing, current => ({ ...current, platforms: { ...current.platforms, ebay: { status: "deleted" } }, updated_at: now() }));
      return;
    }
    else throw new Error("Not supported");

    const r = await fetch("/api/listing-manager", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, listing: await withShopifyCreds(listing, storeKey), store_key: storeKey }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || "Failed");

    await patchListingItem(listing, current => ({ ...current, platforms: { ...current.platforms, [pkey]: { status: "deleted" } }, updated_at: now() }));
  };

  /* mark sold */
  const handleMarkSold = async saleForm => {
    const listing = soldModal;
    if (!listing) return;

    const order = {
      id:                uid(),
      order_number:      nextOrderNumber(orders),
      listing_id:        listing.id,
      listing_title:     listing.title,
      listing_material:  listing.material,
      listing_shape:     listing.shape,
      listing_sku:       listing.sku || "",
      listing_image:     listing.images?.[0] || "",
      platform:          saleForm.platform,
      platform_order_id: saleForm.platform_order_id,
      sale_price:        saleForm.sale_price,
      currency:          "INR",
      buyer_name:        saleForm.buyer_name,
      buyer_country:     saleForm.buyer_country,
      status:            "sold",
      date:              saleForm.date || new Date().toISOString().slice(0, 10),
      notes:             saleForm.notes,
      created_at:        now(),
    };
    await saveOrderItem(order, { prepend: true });

    // For unique items: remove from ALL live platforms in one state update
    if (listing.type === "unique") {
      const livePlatforms = PLATFORMS.filter(p => !p.coming && listing.platforms?.[p.key]?.status === "active");
      // Fire API calls in parallel for all live platforms
      await Promise.allSettled(livePlatforms.map(async p => {
        let action, storeKey;
        if (p.key === "etsy") { action = "unpublish_etsy"; }
        else if (p.key === "shopify_aty") { action = "unpublish_shopify"; storeKey = "atyahara"; }
        else if (p.key === "shopify_earth") { action = "unpublish_shopify"; storeKey = "earth"; }
        else return;
        const r = await fetch("/api/listing-manager", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, listing: await withShopifyCreds(listing, storeKey), store_key: storeKey }),
        });
        const d = await r.json();
        if (!d.ok) console.warn(`Auto-unpublish failed for ${p.key}:`, d.error);
      }));

      // Mark all live platforms as deleted in one shot, merged onto the latest row.
      await patchListingItem(listing, current => {
        const updatedPlatforms = { ...current.platforms };
        for (const p of livePlatforms) {
          updatedPlatforms[p.key] = { ...updatedPlatforms[p.key], status: "deleted" };
        }
        return { ...current, platforms: updatedPlatforms, updated_at: now() };
      });
    }

    setSoldModal(null);
    showToast(`✓ Sale recorded — ${order.order_number}`);
    setTab("orders");
  };

  /* filtered listings */
  const visibleListings = listings
    .filter(l => {
      if (filter === "live")       return PLATFORMS.some(p => l.platforms?.[p.key]?.status === "active");
      if (filter === "draft")      return !PLATFORMS.some(p => l.platforms?.[p.key]?.status === "active");
      if (filter === "unique")     return l.type === "unique";
      if (filter === "repeatable") return l.type === "repeatable";
      return true;
    })
    .filter(l => !search || [l.title, l.material, l.shape, l.sku, l.origin]
      .join(" ").toLowerCase().includes(search.toLowerCase()));

  /* summary counts */
  const liveTotal  = listings.filter(l => PLATFORMS.some(p => l.platforms?.[p.key]?.status === "active")).length;
  const totalSales = orders.length;

  /* tab definitions */
  const TABS = [
    { key: "listings", label: "All Listings", count: listings.length },
    { key: "orders",   label: "Orders",       count: orders.length,  color: C.green },
    ...PLATFORMS.filter(p => !p.coming).map(p => ({
      key: p.key, label: p.label, icon: p.icon, color: p.color,
      count: listings.filter(l => l.platforms?.[p.key]?.status === "active").length,
    })),
  ];

  const activePlatform = PLATFORMS.find(p => p.key === tab);

  return (
    <div style={{ fontFamily: "'Figtree',system-ui,sans-serif", background: C.bg, minHeight: "100vh", color: C.ink }}>
      <style>{`@keyframes lm-spin { to { transform: rotate(360deg); } }`}</style>
      <Toast msg={toast} />

      {/* ── sticky header ── */}
      <div style={{ position: "sticky", top: 0, zIndex: 100, background: C.surface, borderBottom: `1px solid ${C.border}` }}>
        {/* top bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: mob() ? "10px 14px" : "11px 28px" }}>
          <button onClick={onHome}
            style={{ background: "none", border: "none", cursor: "pointer", color: C.inkMid,
              fontSize: 13, padding: "0 12px 0 0", borderRight: `1px solid ${C.border}` }}>← Home</button>
          <div>
            <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 20, fontWeight: 700, lineHeight: 1 }}>
              Listing Manager
            </div>
            <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 1 }}>
              {listings.length} listings · {liveTotal} live · {totalSales} sales
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={() => { setEditing(null); setShowForm(true); }}
            style={{ background: C.ink, color: "#FAF0DC", border: "none", borderRadius: 7,
              padding: "8px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
            + New Listing
          </button>
        </div>

        {/* tab bar */}
        <div style={{ display: "flex", alignItems: "center", overflowX: "auto", padding: mob() ? "0 10px" : "0 28px" }}>
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "11px 14px", background: "none", border: "none", cursor: "pointer",
              borderBottom: `2.5px solid ${tab === t.key ? (t.color || C.gold) : "transparent"}`,
              color: tab === t.key ? C.ink : C.inkMid,
              fontWeight: tab === t.key ? 700 : 400,
              fontSize: 13, marginBottom: -1, whiteSpace: "nowrap",
            }}>
              {t.icon && <span style={{ fontSize: 14 }}>{t.icon}</span>}
              {t.label}
              {t.count > 0 && (
                <span style={{ background: tab === t.key ? (t.color || C.gold) + "25" : C.card,
                  color: tab === t.key ? (t.color || C.ink) : C.inkFaint,
                  border: `1px solid ${tab === t.key ? (t.color || C.gold) + "50" : C.border}`,
                  borderRadius: 20, fontSize: 10, fontWeight: 700, padding: "1px 7px", lineHeight: 1.7 }}>
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ── body ── */}
      <div style={{ maxWidth: 1060, margin: "0 auto", padding: mob() ? "14px" : "24px 28px" }}>

        {/* ══ ALL LISTINGS ══ */}
        {tab === "listings" && (
          <>
            {/* stats bar */}
            <div style={{ display: "flex", gap: 20, paddingBottom: 16, borderBottom: `1px solid ${C.border}`,
              marginBottom: 16, overflowX: "auto" }}>
              {[
                { label: "Total",       val: listings.length,                        color: C.ink   },
                { label: "Live",        val: liveTotal,                              color: C.green },
                { label: "Unique",      val: listings.filter(l => l.type === "unique").length,     color: C.blue  },
                { label: "Repeatable",  val: listings.filter(l => l.type === "repeatable").length, color: C.amber },
                ...PLATFORMS.filter(p => !p.coming).map(p => ({
                  label: p.label,
                  val:   listings.filter(l => l.platforms?.[p.key]?.status === "active").length,
                  color: p.color,
                })),
              ].map(s => (
                <div key={s.label} style={{ textAlign: "center", flexShrink: 0 }}>
                  <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 22, fontWeight: 700, color: s.color, lineHeight: 1 }}>{s.val}</div>
                  <div style={{ fontSize: 10, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .5, marginTop: 1 }}>{s.label}</div>
                </div>
              ))}
            </div>

            {/* filter + search */}
            <div style={{ display: "flex", alignItems: "center", marginBottom: 16,
              borderBottom: `1px solid ${C.border}`, overflowX: "auto" }}>
              {[["all","All"],["live","Live"],["draft","Not Live"],["unique","Unique"],["repeatable","Repeatable"]].map(([v, l]) => (
                <button key={v} onClick={() => setFilter(v)} style={{
                  padding: "10px 14px", background: "none", border: "none", cursor: "pointer",
                  borderBottom: `2.5px solid ${filter === v ? C.gold : "transparent"}`,
                  color: filter === v ? C.ink : C.inkMid,
                  fontWeight: filter === v ? 700 : 400, fontSize: 13, marginBottom: -1, whiteSpace: "nowrap",
                }}>{l}</button>
              ))}
              <div style={{ flex: 1 }} />
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search listings…"
                style={{ ...FI(), width: 200, fontSize: 12, padding: "6px 12px", borderRadius: 20,
                  border: `1.5px solid ${C.border}`, marginBottom: 8 }} />
            </div>

            {!loaded ? (
              <div style={{ textAlign: "center", padding: "60px 0", color: C.inkFaint }}>
                <Spinner /> Loading…
              </div>
            ) : visibleListings.length === 0 ? (
              <div style={{ textAlign: "center", padding: "60px 0" }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>🏷️</div>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
                  {search || filter !== "all" ? "No listings match" : "No listings yet"}
                </div>
                {!search && filter === "all" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
                    <button onClick={() => setShowForm(true)}
                      style={{ background: C.ink, color: "#FAF0DC", border: "none", borderRadius: 8,
                        padding: "10px 24px", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
                      + Create First Listing
                    </button>
                    <button onClick={async () => {
                      // Restore from backup if available
                      const backup = await loadK(BACKUP_KEY);
                      if (backup?.length) {
                        if (confirm(`Restore ${backup.length} listings from backup?`)) {
                          await saveK(LIST_KEY, backup);
                          setListings(backup);
                          showToast(`✓ Restored ${backup.length} listings from backup`);
                        }
                      } else {
                        showToast("No backup found. Use Import from Etsy below.", 5000);
                      }
                    }} style={{ background: C.surface, color: C.amber, border: `1.5px solid ${C.amber}60`,
                      borderRadius: 8, padding: "8px 20px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                      ↩ Restore from Backup
                    </button>
                    <button onClick={async () => {
                      showToast("Importing from Etsy…");
                      try {
                        const r = await fetch("/api/listing-manager?action=import_etsy_listings");
                        const d = await r.json();
                        if (!d.ok) throw new Error(d.error || "Import failed");
                        const imported = d.listings || [];
                        if (!imported.length) { showToast("No Etsy listings found", 4000); return; }
                        const merged = [...imported, ...listings.filter(l => !imported.find(i => i.platforms?.etsy?.listing_id === l.platforms?.etsy?.listing_id))];
                        await saveK(LIST_KEY, merged);
                        setListings(merged);
                        showToast(`✓ Imported ${imported.length} listings from Etsy`);
                      } catch(e) { showToast(`⚠ ${e.message}`, 6000); }
                    }} style={{ background: "#F5640018", color: "#F56400", border: "1.5px solid #F5640040",
                      borderRadius: 8, padding: "8px 20px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                      🏷️ Import from Etsy
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {visibleListings.map(l => (
                  <ListingCard key={l.id} listing={l} stock={stock} orders={orders}
                    onEdit={l => { setEditing(l); setShowForm(true); }}
                    onDelete={handleDelete}
                    onPublish={handlePublish}
                    onSaveAsDraft={(listing, pkey) => handlePublish(listing, pkey, { syncOnly: true })}
                    onUnpublish={handleUnpublish}
                    onMarkSold={setSoldModal}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* ══ ORDERS ══ */}
        {tab === "orders" && <OrdersView orders={orders} listings={listings} stock={stock} showToast={showToast} />}

        {/* ══ PLATFORM TABS ══ */}
        {tab === "etsy" && <EtsyLiveView />}
        {tab === "ebay" && <EbayLiveView />}
        {tab === "shopify_earth" && (
          <ShopifyEarthView
            listings={listings}
            onEditLocal={l => { setEditing(l); setShowForm(true); }}
          />
        )}
        {activePlatform && tab !== "etsy" && tab !== "ebay" && tab !== "shopify_earth" && (
          <PlatformView
            platform={activePlatform}
            listings={listings}
            orders={orders}
            stock={stock}
            onEdit={l => { setEditing(l); setShowForm(true); }}
            onPublish={handlePublish}
            onUnpublish={handleUnpublish}
            onMarkSold={setSoldModal}
          />
        )}
      </div>

      {/* ── modals ── */}
      {showForm && (
        <ListingForm
          initial={editing}
          stock={stock}
          onSave={handleSave}
          onClose={() => { setShowForm(false); setEditing(null); }}
        />
      )}
      {soldModal && (
        <MarkSoldModal
          listing={soldModal}
          orders={orders}
          onSave={handleMarkSold}
          onClose={() => setSoldModal(null)}
        />
      )}
    </div>
  );
}
