/* Raj's order insights: every order since the last snapshot, with where the
   buyer came from and how they got to the till.

   Raj used to see atyahara.com orders only once someone opened the ERP (the
   Shopify sync runs in the browser), so a morning with a real order could read
   "no orders". Here the server reads the two own-site channels itself:
   - atyahara.com: Shopify's REST orders. The checkout app (Shiprocket Fastrr)
     leaves Shopify's own journey empty, but writes the landing page, the UTM
     tags and the browser into note_attributes; Meta's tags carry campaign,
     ad set and ad ids, named from ng-meta-names-v1.
   - eartheditions.co: store_orders, joined to the store's own events
     (site_events) by the purchase event's email: the session's source,
     landing page, add-to-cart and checkout times, and earlier visits.
   Etsy and eBay don't say where a buyer came from; for those Raj gives what
   is known (new or returning buyer, the piece's views and favourites).
   Addresses, phones and emails are never copied into the snapshot. */

const IST = 5.5 * 3600e3;
const istTime = ms => new Date(ms + IST).toISOString().replace("T", " ").slice(0, 16);
const r2 = x => Math.round((+x || 0) * 100) / 100;
const lc = s => String(s || "").trim().toLowerCase();
const VOID = /cancel|refund|void/i;

async function appData(sb, key) {
  const { data } = await sb.from("app_data").select("value").eq("key", key).maybeSingle();
  return typeof data?.value === "string" ? JSON.parse(data.value) : data?.value ?? null;
}

const browserOf = ua => {
  const u = String(ua || "");
  const app = /FBAN|FBAV|FB_IAB/.test(u) ? "Facebook app" : /Instagram/.test(u) ? "Instagram app" : /WhatsApp/.test(u) ? "WhatsApp" : "";
  const dev = /iPhone|iPad/.test(u) ? "iPhone" : /Android/.test(u) ? "Android phone" : /Macintosh/.test(u) ? "Mac" : /Windows/.test(u) ? "Windows PC" : "";
  return [dev, app && `in the ${app}`].filter(Boolean).join(" ");
};

function sourceFromUtm(utm, names, landingUrl) {
  const src = lc(utm.utm_source), med = lc(utm.utm_medium);
  const n = id => (id && names?.[id]) ? `${names[id]}` : id ? `id ${id}` : "";
  if (/^(fb|facebook|ig|instagram|meta)$/.test(src) || /paid_social|cpc|paid/.test(med)) {
    const placement = (String(landingUrl || "").match(/utm_placement=([^&]+)/) || [])[1] || "";
    return { kind: "Meta ad", detail: [n(utm.utm_campaign) && `campaign ${n(utm.utm_campaign)}`, n(utm.utm_term) && `ad set ${n(utm.utm_term)}`, n(utm.utm_content) && `ad ${n(utm.utm_content)}`, placement && `placement ${decodeURIComponent(placement).replace(/_/g, " ")}`].filter(Boolean).join(", ") };
  }
  if (src) return { kind: `${src}${med ? " / " + med : ""}`, detail: utm.utm_campaign ? `campaign ${n(utm.utm_campaign)}` : "" };
  return null;
}

/* atyahara.com, straight from Shopify. */
export async function shopifyAtyOrders(sb, sinceMs, names) {
  const creds = await appData(sb, "ng-shopify-creds-v1").catch(() => null);
  const store = creds?.store || process.env.SHOPIFY_ATY_STORE || "7b7b96-29.myshopify.com";
  const token = creds?.token || process.env.SHOPIFY_ATY_TOKEN;
  if (!token) return { error: "no Atyahara Shopify token" };
  const fields = "id,name,created_at,total_price,currency,line_items,customer,note_attributes,discount_codes,payment_gateway_names,cancelled_at,financial_status,shipping_address,landing_site,referring_site";
  const r = await fetch(`https://${store}/admin/api/2025-01/orders.json?status=any&limit=50&created_at_min=${new Date(sinceMs).toISOString()}&fields=${fields}`,
    { headers: { "X-Shopify-Access-Token": token } });
  if (!r.ok) return { error: `Shopify ${r.status}` };
  const { orders = [] } = await r.json();
  return {
    orders: orders.filter(o => !o.cancelled_at).map(o => {
      const na = Object.fromEntries((o.note_attributes || []).map(a => [a.name, a.value]));
      const landing = na.landing_page_url || o.landing_site || "";
      const src = sourceFromUtm(na, names, landing) || (o.referring_site ? { kind: "referral", detail: o.referring_site } : landing ? { kind: "direct / unknown", detail: "" } : null);
      return {
        channel: "shopify_aty", id: `shopify_aty-${o.id}`, number: `ATY-${String(o.name || "").replace("#", "")}`,
        ts: Date.parse(o.created_at), revenue: r2(o.total_price), cur: o.currency || "INR",
        units: (o.line_items || []).reduce((t, l) => t + (+l.quantity || 1), 0) || 1,
        buyer: lc(o.customer?.email || [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(" ")),
        buyer_name: [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(" ").trim(),
        country: o.shipping_address?.country_code || "", city: o.shipping_address?.city || "",
        lines: (o.line_items || []).map(l => ({ title: l.title + (l.variant_title ? ` (${l.variant_title})` : ""), qty: +l.quantity || 1, amt: r2(l.price * (l.quantity || 1)), lid: String(l.product_id || "") })),
        insight: {
          source: src,
          landing_page: landing ? landing.split("?")[0].replace(/^https?:\/\/[^/]+/, "") : "",
          device: browserOf(na.user_agent),
          payment: [(o.payment_gateway_names || []).join(", "), ...(o.discount_codes || []).map(d => `${d.code} −₹${Math.round(+d.amount || 0)}`)].filter(Boolean).join(" · "),
          shopify_orders_by_buyer: +o.customer?.orders_count || null,
        },
      };
    }),
  };
}

/* eartheditions.co: the order plus the visitor's trail on the site. */
export async function storeOrders(sb, sinceMs) {
  const { data, error } = await sb.from("store_orders").select("number,created_at,status,total,currency,lines,shipping,email,name,discount_code,gateway")
    .gte("created_at", new Date(sinceMs).toISOString()).order("created_at");
  if (error) return { error: error.message };
  const out = [];
  for (const o of (data || []).filter(o => !VOID.test(o.status || "") && o.status !== "pending")) {
    const ts = Date.parse(o.created_at);
    const insight = { source: null, landing_page: "", device: "", payment: [o.gateway, o.discount_code && `code ${o.discount_code}`].filter(Boolean).join(" · ") };
    try {
      // The purchase event carries the buyer's email; its visitor id (vid) ties every earlier page view to them.
      const { data: buy } = await sb.from("site_events").select("vid,sid,at,data").eq("type", "purchase")
        .gte("at", new Date(ts - 3 * 3600e3).toISOString()).lte("at", new Date(ts + 3 * 3600e3).toISOString());
      const hit = (buy || []).find(e => lc(e.data?.email) === lc(o.email)) || (buy || []).find(e => +e.data?.value === +o.total);
      if (hit) {
        const { data: trail } = await sb.from("site_events").select("at,sid,type,path,source,medium,campaign,referrer,city,country,device,browser,os")
          .eq("vid", hit.vid).lte("at", hit.at).order("at").limit(400);
        const t = trail || [];
        const sess = t.filter(e => e.sid === hit.sid), first = t[0], land = sess[0] || first;
        const atc = sess.find(e => e.type === "add_to_cart"), co = sess.find(e => e.type === "checkout");
        const mins = (a, b) => a && b ? Math.max(0, Math.round((Date.parse(b.at) - Date.parse(a.at)) / 6e4)) : null;
        insight.source = { kind: [land?.source, land?.medium].filter(Boolean).join(" / ") || "direct", detail: [land?.campaign && `campaign ${land.campaign}`, land?.referrer && `from ${land.referrer.replace(/^https?:\/\//, "").replace(/\/$/, "")}`].filter(Boolean).join(", ") };
        insight.landing_page = land?.path || "";
        insight.device = [land?.device, land?.browser, land?.os].filter(Boolean).join(", ");
        insight.trail = {
          sessions: new Set(t.map(e => e.sid)).size, pages_viewed: t.filter(e => e.type === "view").length,
          first_seen: first ? istTime(Date.parse(first.at)) + " IST" : "", first_source: first ? [first.source, first.medium].filter(Boolean).join(" / ") : "",
          minutes_landing_to_cart: mins(land, atc), minutes_cart_to_paid: mins(atc || co, hit), minutes_on_site_this_visit: mins(land, hit),
          pages_this_visit: sess.filter(e => e.type === "view").map(e => e.path).slice(0, 8),
        };
      }
    } catch { /* the order still reports without its trail */ }
    out.push({
      channel: "store", id: `store-${o.number}`, number: o.number, ts, revenue: r2(o.total), cur: String(o.currency || "USD").toUpperCase(),
      units: (o.lines || []).reduce((t, l) => t + (+l.qty || 1), 0) || 1, buyer: lc(o.email), buyer_name: o.name || "",
      country: o.shipping?.country || "", city: o.shipping?.city || "",
      lines: (o.lines || []).map(l => ({ title: l.title, qty: +l.qty || 1, amt: r2((+l.price || 0) * (+l.qty || 1)), lid: l.id || "" })), insight,
    });
  }
  return { orders: out };
}

/* One readable record per order since the last snapshot. `all` is every order
   Raj knows (ERP + Etsy receipts + the two pulls above), for buyer history. */
export function orderInsights(recent, all, erpRows, etsyIntel) {
  const hist = new Map();
  const key = (name, country) => `${lc(name).replace(/[^a-z ]/g, "").replace(/\s+/g, " ")}|${country || ""}`;
  for (const r of erpRows || []) {
    if (VOID.test(String(r.status || "")) || r.cancelled || r.refunded) continue;
    const k = key(r.buyer_name || r.ship_name, r.buyer_country || r.ship_country);
    const h = hist.get(k) || { orders: new Set(), first: r.date, spend_inr: 0 };
    h.orders.add(r.platform_order_id || r.order_number); if (r.date < h.first) h.first = r.date;
    h.spend_inr += String(r.currency || "INR").toUpperCase() === "USD" ? (+r.sale_price || 0) * 84 : (+r.sale_price || 0);
    hist.set(k, h);
  }
  // etsyViews: { etsy: { listingId: [lifetimeViews, favourites] }, etsy_ee: {...} }
  const listingStats = lid => {
    for (const ch of ["etsy", "etsy_ee"]) { const v = etsyIntel?.[ch]?.[lid]; if (v) return { views: v[0], favs: v[1] }; }
    return null;
  };
  // Etsy receipts carry no name; the ERP's copy of the order does.
  const byReceipt = new Map((erpRows || []).filter(r => r.etsy_receipt_id).map(r => [String(r.etsy_receipt_id), r]));
  return recent.sort((a, b) => a.ts - b.ts).map(o => {
    if (/etsy/.test(o.channel)) {
      const rid = String(o.id).split("-").pop(), row = byReceipt.get(rid);
      o.number = o.number || `ETSY-${rid}`;
      if (row) { o.buyer_name = row.buyer_name || row.ship_name || ""; o.city = row.ship_city || ""; o.country = o.country || row.buyer_country || ""; }
    }
    const h = o.buyer_name ? hist.get(key(o.buyer_name, o.country)) : null;
    const before = h ? [...h.orders].filter(id => !String(o.id).endsWith(String(id))).length : 0;
    const ins = { ...(o.insight || {}) };
    if (!ins.source) ins.source = /etsy/.test(o.channel) ? { kind: "Etsy", detail: "Etsy doesn't share whether it was search, an ad or the shop page" }
      : o.channel === "ebay" ? { kind: "eBay", detail: "eBay doesn't give the buyer's source" } : null;
    if (/etsy/.test(o.channel)) {
      const st = o.lines.map(l => listingStats(l.lid)).find(Boolean);
      if (st) ins.listing = { lifetime_views: st.views ?? null, favourites: st.favs ?? null };
    }
    const chs = h ? [...new Set((erpRows || []).filter(r => key(r.buyer_name || r.ship_name, r.buyer_country || r.ship_country) === key(o.buyer_name, o.country)).map(r => r.platform === "etsy" ? (r.etsy_shop === "earth" ? "EE Etsy" : "Atyahara Etsy") : r.platform))] : [];
    return {
      channel: o.channel, number: o.number || o.id, at_ist: istTime(o.ts), amount: o.revenue, cur: o.cur, units: o.units,
      items: o.lines.map(l => l.title).slice(0, 4), buyer: o.buyer_name || "", country: o.country || "", city: o.city || "",
      buyer_history: before ? `returning: ${before} earlier order${before > 1 ? "s" : ""} since ${h.first}, about ₹${Math.round(h.spend_inr).toLocaleString("en-IN")} lifetime, bought on ${chs.join(" + ")}` : "new buyer",
      ...ins,
    };
  });
}
