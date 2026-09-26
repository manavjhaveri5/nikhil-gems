/* Store — the ERP's side of eartheditions.co, the retail shop that replaces
   Shopify: orders paid through Stripe, the products on sale (brought in from
   Listing Manager), and the settings (exchange rate, shipping regions).

   Products live in store_products, orders in store_orders. The storefront
   reads them through its own server; staff manage them here with their ERP
   session. A listing can also be published to the store from Listing Manager,
   which writes the same rows. */
import { useState, useEffect, useMemo, useCallback, useRef, lazy, Suspense } from "react";
import { supabase } from "./supabase.js";
import { C, mob, FI } from "./lmTheme.js";
import { loadK, uid } from "./utils.js";
import { uploadToStorage } from "./storageUtils.js";
import { ETSY_SHOP_SECTIONS } from "../lib/listingCategories.js";
import { retailTitle } from "../lib/retailTitle.js";
const PhotoEditor = lazy(() => import("./PhotoEditor.jsx"));
const esc = s => s.replace(/[%_]/g, m => "\\" + m);

const FONT = "-apple-system,'SF Pro Display','Figtree',system-ui,sans-serif";
const SERIF = "'Cormorant Garamond',Georgia,serif";
const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12 };
const btn = (bg = C.surface, fg = C.ink) => ({ background: bg, color: fg, border: bg === C.surface ? `1px solid ${C.border}` : "none", borderRadius: 7, padding: "7px 13px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" });
const lab = { fontSize: 9.5, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 4, display: "block" };
const usd = (n, cur = "usd") => new Intl.NumberFormat(cur === "inr" ? "en-IN" : "en-US", { style: "currency", currency: String(cur || "usd").toUpperCase(), maximumFractionDigits: cur === "inr" ? 0 : 2 }).format(+n || 0);
const fmtDate = v => v ? new Date(v).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";
const q = async p => { const { data, error } = await p; if (error) throw new Error(error.message); return data; };
const LIST_KEY = "ng-listings-v1";

/* ── listing → store product ────────────────────────────────────────────── */
const slugify = s => String(s || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70);
const SECTION = Object.fromEntries(ETSY_SHOP_SECTIONS.filter(s => s.id).map(s => [String(s.id), s.label]));
// Listings with no Etsy section still need a collection; the shape decides.
const collectionFor = l => {
  if (SECTION[String(l.etsy_section_id)]) return SECTION[String(l.etsy_section_id)];
  const s = String(l.shape || "").toLowerCase();
  if (/sphere/.test(s)) return "Spheres";
  if (/heart/.test(s)) return "Hearts";
  if (/palm/.test(s)) return "Palmstones";
  if (/bowl/.test(s)) return "Gemstone Bowls and More";
  if (/tower|freeform|point/.test(s)) return "Towers & Freeforms";
  if (/rough/.test(s)) return "Rough Stones";
  if (/egg|shiv/.test(s)) return "Eggs & Shivas";
  if (/collector/.test(s)) return "Collector's Corner";
  if (/tumble/.test(s)) return "Tumbled Stones";
  return "Mineral Specimens";
};
// Etsy prices are in rupees; the store sells in dollars. The Etsy list price
// carries a standing sale, so the store starts from the price Etsy buyers pay.
export const storePriceFor = (l, fx, rounding = "whole", discountPct = 0) => {
  if (+l.price_store > 0) return +l.price_store;
  const inr = (+l.price_etsy || 0) * (1 - (+discountPct || 0) / 100);
  if (!inr || !fx) return 0;
  const v = inr / fx;
  return rounding === "cents" ? Math.round(v * 100) / 100 : rounding === "99" ? Math.max(1, Math.round(v)) - .01 : Math.round(v);
};
const handleFrom = l => {
  // Keep the Shopify address where there was one, so old links and search results still land.
  // (Only a storefront handle counts — an admin link ends in the numeric product id.)
  const m = String(l.platforms?.shopify_earth?.url || "").match(/\/products\/([^/?#]+)/);
  return m && !/^\d+$/.test(m[1]) ? m[1] : `${slugify(l.title)}-${String(l.id).slice(-5)}`;
};

async function storeSettings() {
  const rows = await q(supabase.from("store_settings").select("key,value"));
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

function rowFromListing(l, { fx, rounding, discount, existing, live }) {
  const images = (l.images || []).filter(u => typeof u === "string" && /^https?:/.test(u));
  // The store's own short name: "Ruby in Matrix Specimen #3", size on its own line.
  const own = String(l.store_title || "").trim();
  const rt = retailTitle(own || l.shopify_title || l.title);
  const size = rt.size || retailTitle(l.title).size;
  return {
    id: `lm-${l.id}`, listing_id: l.id,
    handle: existing?.handle || handleFrom(l),
    // A title set for Earth Editions in Listing Manager is meant as written.
    title: own || existing?.title || (rt.number ? `${rt.title} #${rt.number}` : rt.title || String(l.title || "").trim()),
    subtitle: size,
    description: String(l.store_description || l.shopify_description || l.description || "").replace(/<[^>]+>/g, "").trim(),
    images, videos: l.video && /^https?:/.test(l.video) ? [l.video] : (existing?.videos || []),
    material: l.material || "", shape: l.shape || "", product_type: l.productType || "",
    tags: Array.isArray(l.tags) ? l.tags : [],
    collections: existing?.collections?.length ? existing.collections : [collectionFor(l)],
    price: storePriceFor(l, fx, rounding, discount),
    // Indian buyers pay in rupees: a store ₹ price set in Listing Manager, else
    // the Etsy sale price itself, no dollar round trip.
    price_inr: +l.price_store_inr ? Math.round(+l.price_store_inr) : +l.price_etsy ? Math.round(+l.price_etsy * (1 - (+discount || 0) / 100) / 10) * 10 : null,
    qty: Math.max(1, parseInt(l.qty, 10) || 1),
    is_unique: l.type !== "repeatable",
    status: existing?.status === "sold" ? "sold" : live ? "active" : (existing?.status || "hidden"),
    sku: l.sku || "",
    source: { listing_id: l.id, etsy_id: l.platforms?.etsy?.listing_id || null },
    updated_at: new Date().toISOString(),
  };
}
/* What staff changed by hand in the store's product editor stays as they left
   it when the listing syncs again; source.manual names those fields. */
const MANUAL = ["title", "subtitle", "handle", "description", "images", "videos", "material", "shape", "product_type", "tags", "collections", "price", "compare_at", "price_inr", "qty", "is_unique", "sku", "weight_g"];
function keepManual(row, existing) {
  const manual = (existing?.source?.manual || []).filter(k => MANUAL.includes(k));
  if (!manual.length) return row;
  const out = { ...row, source: { ...row.source, manual } };
  for (const k of manual) if (k in existing) out[k] = existing[k];
  return out;
}

/* Listing Manager hooks — the store is a platform there, like Etsy. */
/* override: fields just set on purpose in Listing Manager (a price typed on
   its grid) — they win over an earlier hand edit in the store's editor. */
export async function publishListingToStore(listing, { syncOnly = false, override = [] } = {}) {
  const s = await storeSettings();
  const id = `lm-${listing.id}`;
  let existing = await q(supabase.from("store_products").select("*").eq("id", id).maybeSingle());
  if (existing && override.length) existing = { ...existing, source: { ...(existing.source || {}), manual: (existing.source?.manual || []).filter(k => !override.includes(k)) } };
  let row = keepManual(rowFromListing(listing, { fx: +s.fx_inr_per_usd || 84, rounding: s.price_rounding, discount: s.etsy_discount_pct, existing, live: !syncOnly }), existing);
  if (!existing) {
    // Another piece already has this name: this one takes the next number.
    if (!/ #\d+$/.test(row.title)) {
      const same = await q(supabase.from("store_products").select("title").or(`title.eq.${row.title.replace(/[,()]/g, "")},title.like.${esc(row.title.replace(/[,()]/g, ""))} #*`));
      if (same.length) {
        const nums = same.map(x => +(x.title.match(/ #(\d+)$/) || [0, 1])[1]);
        row = { ...row, title: `${row.title} #${Math.max(...nums) + 1}` };
      }
    }
    const clash = await q(supabase.from("store_products").select("id").eq("handle", row.handle).maybeSingle());
    if (clash) row = { ...row, handle: `${row.handle}-${String(listing.id).slice(-4)}` };
  }
  if (!row.price) throw new Error("No store price — set one, or an Etsy price to convert");
  await q(supabase.from("store_products").upsert(row, { onConflict: "id" }));
  const base = String(s.site_url || "https://eartheditions.co").replace(/\/+$/, "");
  return { product_id: id, url: `${base}/products/${row.handle}`, status: row.status === "active" ? "active" : "draft" };
}
/* What Listing Manager's grid shows for the store: the live $ and ₹ prices and
   status of each listing's store product, keyed by listing id. */
export async function loadStoreFacts() {
  const out = {};
  for (let from = 0; ; from += 1000) {
    const rows = await q(supabase.from("store_products").select("id,listing_id,price,price_inr,status,handle").range(from, from + 999));
    for (const r of rows) { const lid = r.listing_id || (String(r.id).startsWith("lm-") ? String(r.id).slice(3) : ""); if (lid) out[lid] = r; }
    if (rows.length < 1000) break;
  }
  return out;
}

export async function markStoreSold(productId) {
  if (!productId) throw new Error("Not on the store");
  await q(supabase.from("store_products").update({ status: "sold", sold_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", productId));
}
export async function hideStoreProduct(productId) {
  if (!productId) throw new Error("Not on the store");
  await q(supabase.from("store_products").update({ status: "hidden", updated_at: new Date().toISOString() }).eq("id", productId).neq("status", "sold"));
}

/* ── the app ────────────────────────────────────────────────────────────── */
export default function StoreApp({ onHome }) {
  const [tab, setTab] = useState("orders");
  const [toast, setToast] = useState("");
  const showToast = useCallback(m => { setToast(m); setTimeout(() => setToast(""), 3800); }, []);
  const [settings, setSettings] = useState(null);
  const reload = useCallback(() => storeSettings().then(setSettings).catch(e => showToast("⚠ " + e.message)), [showToast]);
  useEffect(() => { reload(); }, [reload]);
  const site = String(settings?.site_url || "https://eartheditions.co").replace(/\/+$/, "");
  const TABS = [["orders", "🧾", "Orders"], ["products", "💎", "Products"], ["settings", "⚙️", "Settings"]];
  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: FONT, color: C.ink }}>
      {toast && <div style={{ position: "fixed", bottom: 22, right: 22, left: mob() ? 22 : "auto", zIndex: 1200, background: C.ink, color: "#fff", padding: "10px 18px", borderRadius: 6, fontSize: 12.5 }}>{toast}</div>}
      <div style={{ position: "sticky", top: 0, zIndex: 100, background: C.surface, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: mob() ? "10px 14px" : "11px 28px" }}>
          <button onClick={onHome} style={{ background: "none", border: "none", cursor: "pointer", color: C.inkMid, fontFamily: "inherit", fontSize: 13, padding: "0 12px 0 0", borderRight: `1px solid ${C.border}` }}>← Home</button>
          <div>
            <div style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, lineHeight: 1 }}>Store</div>
            <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 1 }}>eartheditions.co — orders, products, shipping</div>
          </div>
          <div style={{ flex: 1 }} />
          <a href={site} target="_blank" rel="noreferrer" style={{ ...btn(), textDecoration: "none" }}>↗ {mob() ? "" : "Open store"}</a>
        </div>
        <div style={{ display: "flex", overflowX: "auto", padding: mob() ? "0 10px" : "0 28px" }}>
          {TABS.map(([k, icon, label]) => (
            <button key={k} onClick={() => setTab(k)} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: -1, border: "none", background: "none", cursor: "pointer", fontFamily: "inherit", padding: "11px 14px", fontSize: 13, fontWeight: tab === k ? 700 : 400, whiteSpace: "nowrap", color: tab === k ? C.ink : C.inkMid, borderBottom: `2.5px solid ${tab === k ? C.gold : "transparent"}` }}>
              <span style={{ fontSize: 14 }}>{icon}</span>{label}
            </button>
          ))}
        </div>
      </div>
      <div style={{ padding: mob() ? 14 : "24px 28px", maxWidth: 1180, margin: "0 auto" }}>
        {tab === "orders" && <OrdersTab showToast={showToast} />}
        {tab === "products" && settings && <StoreProductsPanel showToast={showToast} settings={settings} site={site} />}
        {tab === "settings" && settings && <SettingsTab settings={settings} reload={reload} showToast={showToast} />}
      </div>
    </div>
  );
}

/* ── Orders ─────────────────────────────────────────────────────────────── */
const STATUS = ["paid", "packed", "shipped", "delivered", "refunded", "cancelled"];
function OrdersTab({ showToast }) {
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(null);
  const [filter, setFilter] = useState("open");
  const load = useCallback(() => q(supabase.from("store_orders").select("*").order("created_at", { ascending: false }).limit(500))
    .then(setRows).catch(e => { showToast("⚠ " + e.message); setRows([]); }), [showToast]);
  useEffect(() => { load(); }, [load]);
  const patch = async (id, p) => {
    try { await q(supabase.from("store_orders").update({ ...p, updated_at: new Date().toISOString() }).eq("id", id)); setRows(r => r.map(x => x.id === id ? { ...x, ...p } : x)); }
    catch (e) { showToast("⚠ " + e.message); }
  };
  // "pending" = a Razorpay payment window opened but never paid; kept out of the way.
  const shown = (rows || []).filter(o => filter === "all" ? o.status !== "pending" : filter === "open" ? ["paid", "packed"].includes(o.status) : o.status === filter);
  const count = f => (rows || []).filter(o => f === "open" ? ["paid", "packed"].includes(o.status) : o.status === f).length;
  return (
    <div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
        {[["open", "To ship"], ["shipped", "Shipped"], ["delivered", "Delivered"], ["refunded", "Refunded"], ["all", "All"]].map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)} style={{ ...btn(filter === k ? C.ink : C.surface, filter === k ? "#fff" : C.ink), borderRadius: 999 }}>{l}{k !== "all" ? ` · ${count(k)}` : ""}</button>
        ))}
        <div style={{ flex: 1 }} /><button onClick={load} style={btn()}>↻ Refresh</button>
      </div>
      {!rows && <div style={{ color: C.inkFaint, fontSize: 13 }}>Loading…</div>}
      {rows && !shown.length && <div style={{ ...card, padding: 24, textAlign: "center", color: C.inkFaint, fontSize: 13 }}>No orders here. Paid orders from the store land here and in Listing Manager → Orders.</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {shown.map(o => {
          const a = o.shipping || {};
          const isOpen = open === o.id;
          return (
            <div key={o.id} style={{ ...card, padding: mob() ? 12 : "14px 18px", borderColor: o.notes?.startsWith("⚠") ? C.red : C.border }}>
              <div onClick={() => setOpen(isOpen ? null : o.id)} style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", cursor: "pointer" }}>
                <b style={{ fontFamily: "ui-monospace,monospace", fontSize: 13 }}>{o.number}</b>
                <div style={{ flex: 1, minWidth: 160 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{o.name || o.email}</div>
                  <div style={{ fontSize: 11.5, color: C.inkFaint }}>{fmtDate(o.created_at)} · {o.lines.length} piece{o.lines.length === 1 ? "" : "s"} · {[a.city, a.country].filter(Boolean).join(", ")}{o.erp_synced ? "" : " · not yet in Orders"}</div>
                </div>
                <div style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700 }}>{usd(o.total, o.currency)}</div>
                <span style={{ fontSize: 10, color: C.inkFaint }}>{o.gateway === "razorpay" ? "Razorpay" : "Stripe"}</span>
                <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: .4, padding: "2px 8px", borderRadius: 4, background: o.status === "paid" ? C.amberBg : o.status === "shipped" || o.status === "delivered" ? C.greenBg : C.card, color: o.status === "paid" ? C.amber : o.status === "shipped" || o.status === "delivered" ? C.green : C.inkMid }}>{o.status}</span>
              </div>
              {isOpen && (
                <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 12, display: "grid", gap: 10 }}>
                  {o.notes && <div style={{ fontSize: 13, color: o.notes.startsWith("⚠") ? C.red : C.inkMid }}>{o.notes}</div>}
                  {o.lines.map((l, i) => (
                    <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13 }}>
                      {l.image && <img src={l.image} alt="" style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 6 }} />}
                      <div style={{ flex: 1 }}>{l.title}{l.sku ? <span style={{ color: C.inkFaint }}> · {l.sku}</span> : null}</div>
                      <div>{l.qty} × {usd(l.price, o.currency)}</div>
                    </div>
                  ))}
                  <div style={{ fontSize: 12.5, color: C.inkMid }}>Subtotal {usd(o.subtotal, o.currency)} · Shipping {usd(o.shipping_cost, o.currency)}{o.discount ? ` · Discount −${usd(o.discount, o.currency)}` : ""} · <b>Total {usd(o.total, o.currency)}</b></div>
                  <div style={{ fontSize: 13, whiteSpace: "pre-line", background: C.card, borderRadius: 8, padding: "10px 12px" }}>
                    <b>Ship to</b>{"\n"}{o.name}{"\n"}{[a.line1, a.line2].filter(Boolean).join(", ")}{"\n"}{[a.city, a.state, a.postal_code].filter(Boolean).join(" ")}{"\n"}{a.country}{"\n"}{[o.email, o.phone].filter(Boolean).join(" · ")}
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <select value={o.status} onChange={e => patch(o.id, { status: e.target.value })} style={FI({ width: "auto", padding: "6px 10px" })}>{STATUS.map(s => <option key={s}>{s}</option>)}</select>
                    <input defaultValue={o.tracking} placeholder="Tracking number" onBlur={e => e.target.value !== o.tracking && patch(o.id, { tracking: e.target.value.trim() })} style={FI({ width: 220 })} />
                    {o.stripe_payment && (o.gateway === "razorpay"
                      ? <a href={`https://dashboard.razorpay.com/app/payments/${o.stripe_payment}`} target="_blank" rel="noreferrer" style={{ ...btn(), textDecoration: "none" }}>Razorpay ↗</a>
                      : <a href={`https://dashboard.stripe.com/payments/${o.stripe_payment}`} target="_blank" rel="noreferrer" style={{ ...btn(), textDecoration: "none" }}>Stripe ↗</a>)}
                    {o.email && <a href={`mailto:${o.email}?subject=${encodeURIComponent(`Your Earth Editions order ${o.number}`)}`} style={{ ...btn(), textDecoration: "none" }}>✉ Email</a>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Products (also the Listing Manager "Store" tab) ────────────────────── */
export function StoreProductsPanel({ showToast, settings: given, site: givenSite }) {
  const [settings, setSettings] = useState(given || null);
  useEffect(() => { if (!given) storeSettings().then(setSettings).catch(() => {}); }, [given]);
  const site = givenSite || String(settings?.site_url || "https://eartheditions.co").replace(/\/+$/, "");
  const [rows, setRows] = useState(null);
  const [filter, setFilter] = useState("active");
  const [search, setSearch] = useState("");
  const [importing, setImporting] = useState(false);
  const [edit, setEdit] = useState(null);
  const [shown, setShown] = useState(60);
  /* Loads once. Listing Manager hands in a fresh showToast on every render, so
     keying the load on it would re-download the store on each redraw. */
  const toastRef = useRef(showToast);
  toastRef.current = showToast;
  const toast = m => toastRef.current?.(m);
  const load = useCallback(() => q(supabase.from("store_products").select("*").order("created_at", { ascending: false }).range(0, 4999))
    .then(setRows).catch(e => { toastRef.current?.("⚠ " + e.message); setRows(r => r || []); }), []);
  useEffect(() => { load(); }, [load]);
  // `manual` = fields changed by hand; a later Listing Manager sync leaves them alone.
  const save = async (id, p, manual = []) => {
    try {
      const cur = (rows || []).find(x => x.id === id);
      const patch = { ...p, updated_at: new Date().toISOString() };
      if (manual.length) patch.source = { ...(cur?.source || {}), manual: [...new Set([...(cur?.source?.manual || []), ...manual])] };
      const row = await q(supabase.from("store_products").update(patch).eq("id", id).select().single());
      setRows(r => r.map(x => x.id === id ? row : x));
      return row;
    } catch (e) { toast("⚠ " + (/store_products_handle_key|duplicate key/.test(e.message) ? "Another product already uses that web address" : e.message)); throw e; }
  };
  const del = async p => {
    if (!window.confirm(`Delete "${p.title}" from the store completely? (Hide keeps it for later.)`)) return false;
    try { await q(supabase.from("store_products").delete().eq("id", p.id)); setRows(r => r.filter(x => x.id !== p.id)); toast("Deleted from the store"); return true; }
    catch (e) { toast("⚠ " + e.message); return false; }
  };
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const list = useMemo(() => (rows || []).filter(p => (filter === "all" || p.status === filter || (filter === "featured" && p.featured)) &&
    words.every(w => `${p.title} ${p.material} ${p.shape} ${p.sku} ${(p.collections || []).join(" ")}`.toLowerCase().includes(w))), [rows, filter, search]);
  const count = f => (rows || []).filter(p => f === "featured" ? p.featured : p.status === f).length;
  const collections = useMemo(() => [...new Set([...Object.values(SECTION), ...(rows || []).flatMap(p => p.collections || [])])].sort(), [rows]);

  return (
    <div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
        {[["active", "On sale"], ["hidden", "Hidden"], ["sold", "Sold"], ["featured", "Featured"], ["all", "All"]].map(([k, l]) => (
          <button key={k} onClick={() => { setFilter(k); setShown(60); }} style={{ ...btn(filter === k ? C.ink : C.surface, filter === k ? "#fff" : C.ink), borderRadius: 999 }}>{l} · {k === "all" ? (rows || []).length : count(k)}</button>
        ))}
        <input value={search} onChange={e => { setSearch(e.target.value); setShown(60); }} placeholder="Search…" style={FI({ width: mob() ? "100%" : 200, borderRadius: 999 })} />
        <div style={{ flex: 1 }} />
        <button onClick={() => setImporting(true)} style={btn(C.ink, "#FAF0DC")}>＋ Add from listings</button>
      </div>
      {!rows && <div style={{ color: C.inkFaint, fontSize: 13 }}>Loading…</div>}
      {rows && !rows.length && <div style={{ ...card, padding: 28, textAlign: "center", fontSize: 13.5, color: C.inkMid }}>The store is empty. <b>＋ Add from listings</b> brings your Listing Manager pieces in — tick the ones to sell.</div>}
      {rows?.length > 0 && <div style={{ fontSize: 11.5, color: C.inkFaint, marginBottom: 10 }}>Tap a piece to edit its photos, name, price and description, or to delete it.</div>}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${mob() ? 160 : 210}px, 1fr))`, gap: mob() ? 10 : 14 }}>
        {list.slice(0, shown).map(p => (
          <div key={p.id} style={{ ...card, overflow: "hidden", display: "flex", flexDirection: "column", opacity: p.status === "active" ? 1 : .6 }}>
            <div onClick={() => setEdit(p)} title="Edit" style={{ position: "relative", aspectRatio: "4/5", background: C.card, cursor: "pointer" }}>
              {p.images?.[0] && <img src={p.images[0]} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />}
              {p.status === "sold" && <span style={{ position: "absolute", top: 8, left: 8, background: C.ink, color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 4, padding: "2px 7px" }}>SOLD</span>}
              {p.featured && <span style={{ position: "absolute", top: 8, right: 8, background: C.gold, color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 4, padding: "2px 7px" }}>★</span>}
            </div>
            <div style={{ padding: "10px 12px 6px", flex: 1 }}>
              <div onClick={() => setEdit(p)} style={{ fontWeight: 600, fontSize: 13.5, lineHeight: 1.25, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", cursor: "pointer" }}>{p.title}</div>
              <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 3 }}>{[p.subtitle, (p.collections || [])[0]].filter(Boolean).join(" · ")}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 6 }}>
                <span style={{ fontSize: 12, color: C.inkMid }}>$</span>
                <input key={p.price} defaultValue={p.price} inputMode="decimal" onBlur={e => { const v = +e.target.value || 0; if (v && v !== +p.price) save(p.id, { price: v }, ["price"]).catch(() => {}); }}
                  style={FI({ padding: "4px 8px", fontSize: 13, fontWeight: 700, width: 90 })} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 5, padding: "4px 10px 10px" }}>
              {p.status !== "sold"
                ? <button onClick={() => save(p.id, { status: p.status === "active" ? "hidden" : "active" }).catch(() => {})} style={{ ...btn(p.status === "active" ? C.ink : C.surface, p.status === "active" ? "#fff" : C.inkMid), flex: 1, padding: "5px 0", fontSize: 11 }}>{p.status === "active" ? "On sale" : "Hidden"}</button>
                : <button onClick={() => save(p.id, { status: "active", sold_at: null }).catch(() => {})} style={{ ...btn(), flex: 1, padding: "5px 0", fontSize: 11 }}>Relist</button>}
              <button onClick={() => save(p.id, { featured: !p.featured }).catch(() => {})} title="Feature on the home page" style={{ ...btn(p.featured ? C.gold : C.surface, p.featured ? "#fff" : C.inkMid), padding: "5px 9px", fontSize: 11 }}>★</button>
              <button onClick={() => setEdit(p)} title="Edit" style={{ ...btn(), padding: "5px 9px", fontSize: 11 }}>✎</button>
              <button onClick={() => del(p)} title="Delete from the store" style={{ ...btn(), padding: "5px 9px", fontSize: 11, color: C.red }}>✕</button>
            </div>
          </div>
        ))}
      </div>
      {list.length > shown && <div style={{ textAlign: "center", marginTop: 12 }}><button onClick={() => setShown(s => s + 100)} style={btn()}>Show more ({list.length - shown})</button></div>}
      {edit && <StoreProductEditor p={edit} site={site} collections={collections} showToast={toast}
        onClose={() => setEdit(null)}
        onDelete={async () => { if (await del(edit)) setEdit(null); }}
        onSave={async (patch, manual) => { await save(edit.id, patch, manual); setEdit(null); toast("Saved — live on the store within a minute"); }}
        onUnlock={async () => { const row = await save(edit.id, { source: { ...(edit.source || {}), manual: [] } }); setEdit(row); toast("The next listing sync will update this piece again"); }} />}
      {importing && settings && <ImportFromListings settings={settings} existing={rows || []} onClose={() => setImporting(false)} onDone={n => { setImporting(false); load(); toast(`✓ ${n} piece${n === 1 ? "" : "s"} added to the store`); }} />}
    </div>
  );
}

/* Everything the store shows about one piece. Fields changed here are marked
   hand-edited so a Listing Manager sync doesn't put the listing's version back. */
const FIELD_NAMES = { title: "name", subtitle: "size line", handle: "web address", description: "description", images: "photos", videos: "video", material: "material", shape: "shape", product_type: "type", tags: "tags", collections: "collections", price: "price", compare_at: "was-price", price_inr: "₹ price", qty: "quantity", is_unique: "one of a kind", sku: "SKU", weight_g: "weight" };
function StoreProductEditor({ p, site, collections, showToast, onClose, onSave, onDelete, onUnlock }) {
  const [f, setF] = useState(() => ({
    title: p.title || "", subtitle: p.subtitle || "", handle: p.handle || "", description: p.description || "",
    images: [...(p.images || [])], video: (p.videos || [])[0] || "",
    material: p.material || "", shape: p.shape || "", product_type: p.product_type || "",
    tags: (p.tags || []).join(", "), collections: [...(p.collections || [])],
    price: p.price ?? "", compare_at: p.compare_at ?? "", price_inr: p.price_inr ?? "",
    qty: p.qty ?? 1, is_unique: p.is_unique !== false, sku: p.sku || "", weight_g: p.weight_g ?? "",
    status: p.status || "hidden", featured: !!p.featured,
  }));
  const [busy, setBusy] = useState("");
  const [editIdx, setEditIdx] = useState(null);   // photo open in the photo editor
  const set = k => e => setF(x => ({ ...x, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const num = k => e => setF(x => ({ ...x, [k]: e.target.value.replace(/[^\d.]/g, "") }));
  const setImages = fn => setF(x => ({ ...x, images: fn(x.images) }));
  const toggleCol = c => setF(x => ({ ...x, collections: x.collections.includes(c) ? x.collections.filter(y => y !== c) : [...x.collections, c] }));
  const [newCol, setNewCol] = useState("");
  const addPhotos = async files => {
    const list = [...(files || [])].filter(file => file.type.startsWith("image/"));
    if (!list.length) return;
    setBusy("photos");
    try {
      const urls = [];
      for (const file of list) urls.push(await uploadToStorage(`store/products/${uid()}.${(file.name.split(".").pop() || "jpg").toLowerCase()}`, file));
      setImages(a => [...a, ...urls]);
    } catch (e) { showToast("⚠ " + e.message); }
    setBusy("");
  };
  const addVideo = async file => {
    if (!file) return;
    setBusy("video");
    try { const url = await uploadToStorage(`store/products/${uid()}.${(file.name.split(".").pop() || "mp4").toLowerCase()}`, file); setF(x => ({ ...x, video: url })); }
    catch (e) { showToast("⚠ " + e.message); }
    setBusy("");
  };
  const submit = async () => {
    const price = +f.price || 0;
    if (!f.title.trim()) return showToast("⚠ The piece needs a name");
    if (!price) return showToast("⚠ Set a price in dollars");
    const handle = slugify(f.handle) || p.handle;
    const next = {
      title: f.title.trim(), subtitle: f.subtitle.trim(), handle, description: f.description.trim(),
      images: f.images, videos: f.video ? [f.video] : [],
      material: f.material.trim(), shape: f.shape.trim(), product_type: f.product_type.trim(),
      tags: f.tags.split(",").map(s => s.trim()).filter(Boolean), collections: f.collections,
      price, compare_at: +f.compare_at > price ? +f.compare_at : null, price_inr: +f.price_inr || null,
      qty: Math.max(0, parseInt(f.qty, 10) || 0), is_unique: f.is_unique, sku: f.sku.trim(), weight_g: parseInt(f.weight_g, 10) || null,
    };
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const manual = Object.keys(next).filter(k => !same(next[k], k === "price" || k === "compare_at" || k === "price_inr" ? (p[k] == null ? null : +p[k]) : p[k]));
    const patch = { ...next, featured: f.featured };
    if (f.status !== p.status) { patch.status = f.status; patch.sold_at = f.status === "sold" ? (p.sold_at || new Date().toISOString()) : null; }
    setBusy("save");
    try { await onSave(patch, manual); } catch { /* toast already shown */ }
    setBusy("");
  };
  const locked = (p.source?.manual || []).filter(k => FIELD_NAMES[k]);
  const two = mob() ? "1fr" : "1fr 1fr";
  const three = mob() ? "1fr 1fr" : "1fr 1fr 1fr";
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(20,15,5,.45)", display: "flex", alignItems: mob() ? "flex-end" : "center", justifyContent: "center", padding: mob() ? 0 : 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ ...card, width: "100%", maxWidth: 720, maxHeight: mob() ? "94vh" : "90vh", display: "flex", flexDirection: "column", borderRadius: mob() ? "14px 14px 0 0" : 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, flex: 1 }}>Edit store product</div>
          <a href={`${site}/products/${p.handle}`} target="_blank" rel="noreferrer" style={{ ...btn(), textDecoration: "none", padding: "5px 10px" }}>↗ View</a>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.inkMid }}>×</button>
        </div>
        <div style={{ overflowY: "auto", padding: 18, flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>
          {locked.length > 0 && (
            <div style={{ fontSize: 12, color: C.inkMid, background: C.card, borderRadius: 8, padding: "8px 12px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ flex: 1, minWidth: 200 }}>Edited here, so a Listing Manager sync leaves it alone: <b>{locked.map(k => FIELD_NAMES[k]).join(", ")}</b>.</span>
              {p.listing_id && <button onClick={() => { if (window.confirm("Let the next Listing Manager sync overwrite these with the listing's details again?")) onUnlock().catch(() => {}); }} style={{ ...btn(), padding: "4px 10px", fontSize: 11.5 }}>Follow the listing again</button>}
            </div>
          )}
          <div>
            <span style={lab}>Photos · tap one to edit · first is the cover</span>
            <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 2 }}>
              {f.images.map((src, i) => (
                <div key={src} style={{ position: "relative", flexShrink: 0 }}>
                  <img src={src} alt="" onClick={() => setEditIdx(i)} title="Edit this photo"
                    style={{ width: 76, height: 76, objectFit: "cover", borderRadius: 7, cursor: "pointer", display: "block", border: `2px solid ${i === 0 ? C.gold : "transparent"}` }} />
                  <div style={{ position: "absolute", top: 3, right: 3, display: "flex", gap: 3 }}>
                    {i > 0 && <button type="button" title="Make cover" onClick={() => setImages(a => [a[i], ...a.filter((_, j) => j !== i)])}
                      style={{ width: 22, height: 22, borderRadius: 11, border: "none", background: "rgba(20,15,8,.7)", color: "#fff", fontSize: 11, cursor: "pointer", padding: 0 }}>★</button>}
                    <button type="button" title="Remove" onClick={() => setImages(a => a.filter((_, j) => j !== i))}
                      style={{ width: 22, height: 22, borderRadius: 11, border: "none", background: "rgba(20,15,8,.7)", color: "#fff", fontSize: 13, cursor: "pointer", padding: 0 }}>×</button>
                  </div>
                </div>
              ))}
              <label style={{ width: 76, height: 76, flexShrink: 0, borderRadius: 7, border: `1.5px dashed ${C.border}`, display: "grid", placeItems: "center", fontSize: 11.5, color: C.inkMid, cursor: "pointer", textAlign: "center" }}>
                {busy === "photos" ? "Uploading…" : "＋ Photos"}
                <input type="file" accept="image/*" multiple hidden onChange={e => { addPhotos(e.target.files); e.target.value = ""; }} />
              </label>
            </div>
          </div>
          {editIdx != null && f.images[editIdx] && (
            <Suspense fallback={null}>
              <PhotoEditor url={f.images[editIdx]} photos={f.images} index={editIdx} showToast={showToast}
                onSave={u => setImages(a => a.map((x, j) => (j === editIdx ? u : x)))}
                onSaveAll={next => setImages(() => next)}
                onClose={() => setEditIdx(null)} />
            </Suspense>
          )}
          <div>
            <span style={lab}>Video</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {f.video ? <video src={f.video} muted playsInline style={{ width: 110, height: 76, objectFit: "cover", borderRadius: 7, background: C.card }} /> : <span style={{ fontSize: 12, color: C.inkFaint }}>none</span>}
              <label style={{ ...btn(), cursor: "pointer" }}>{busy === "video" ? "Uploading…" : f.video ? "Replace" : "Upload video"}<input type="file" accept="video/*" hidden onChange={e => { addVideo(e.target.files?.[0]); e.target.value = ""; }} /></label>
              {f.video && <button onClick={() => setF(x => ({ ...x, video: "" }))} style={btn()}>Remove</button>}
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "2fr 1fr", gap: 10 }}>
            <div><span style={lab}>Name</span><input value={f.title} onChange={set("title")} style={FI()} /></div>
            <div><span style={lab}>Size line</span><input value={f.subtitle} onChange={set("subtitle")} placeholder="47mm · 690g" style={FI()} /></div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: three, gap: 10 }}>
            <div><span style={lab}>Price $</span><input value={f.price} onChange={num("price")} inputMode="decimal" style={FI({ fontWeight: 700 })} /></div>
            <div><span style={lab}>Was $ (shows a sale)</span><input value={f.compare_at} onChange={num("compare_at")} inputMode="decimal" placeholder="—" style={FI()} /></div>
            <div><span style={lab}>India price ₹</span><input value={f.price_inr} onChange={num("price_inr")} inputMode="decimal" placeholder="—" style={FI()} /></div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: two, gap: 10 }}>
            <div><span style={lab}>Status</span><select value={f.status} onChange={set("status")} style={FI()}><option value="active">On sale</option><option value="hidden">Hidden</option><option value="sold">Sold</option></select></div>
            <div><span style={lab}>Quantity</span><input value={f.qty} onChange={e => setF(x => ({ ...x, qty: e.target.value.replace(/[^\d]/g, "") }))} inputMode="numeric" disabled={f.is_unique} style={FI({ opacity: f.is_unique ? .5 : 1 })} /></div>
          </div>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
            <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={f.is_unique} onChange={set("is_unique")} /> One of a kind (sells once)</label>
            <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={f.featured} onChange={set("featured")} /> ★ Featured on the home page</label>
          </div>
          <div>
            <span style={lab}>Collections</span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {[...new Set([...collections, ...f.collections])].map(c => {
                const on = f.collections.includes(c);
                return <button key={c} type="button" onClick={() => toggleCol(c)} style={{ ...btn(on ? C.ink : C.surface, on ? "#fff" : C.inkMid), borderRadius: 999, padding: "4px 11px", fontSize: 11.5 }}>{c}</button>;
              })}
              <input value={newCol} onChange={e => setNewCol(e.target.value)} placeholder="＋ New collection" style={FI({ width: 150, padding: "4px 10px", fontSize: 12, borderRadius: 999 })}
                onKeyDown={e => { if (e.key === "Enter" && newCol.trim()) { const c = newCol.trim(); setF(x => ({ ...x, collections: x.collections.includes(c) ? x.collections : [...x.collections, c] })); setNewCol(""); } }} />
            </div>
          </div>
          <div><span style={lab}>Description</span><textarea value={f.description} onChange={set("description")} style={FI({ minHeight: 140, resize: "vertical" })} /></div>
          <div style={{ display: "grid", gridTemplateColumns: three, gap: 10 }}>
            <div><span style={lab}>Material</span><input value={f.material} onChange={set("material")} style={FI()} /></div>
            <div><span style={lab}>Shape</span><input value={f.shape} onChange={set("shape")} style={FI()} /></div>
            <div><span style={lab}>Type</span><input value={f.product_type} onChange={set("product_type")} style={FI()} /></div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: three, gap: 10 }}>
            <div><span style={lab}>SKU</span><input value={f.sku} onChange={set("sku")} style={FI()} /></div>
            <div><span style={lab}>Weight (g, for shipping)</span><input value={f.weight_g} onChange={e => setF(x => ({ ...x, weight_g: e.target.value.replace(/[^\d]/g, "") }))} inputMode="numeric" style={FI()} /></div>
            <div><span style={lab}>Tags (comma separated)</span><input value={f.tags} onChange={set("tags")} style={FI()} /></div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: two, gap: 10 }}>
            <div><span style={lab}>Web address</span><div style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ fontSize: 11.5, color: C.inkFaint, whiteSpace: "nowrap" }}>/products/</span><input value={f.handle} onChange={set("handle")} onBlur={() => setF(x => ({ ...x, handle: slugify(x.handle) || p.handle }))} style={FI()} /></div></div>
            <div style={{ fontSize: 11, color: C.inkFaint, alignSelf: "end", paddingBottom: 6 }}>Changing the address breaks old links to this piece.</div>
          </div>
        </div>
        <div style={{ padding: "12px 18px", borderTop: `1px solid ${C.border}`, display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={onDelete} style={{ ...btn(), color: C.red }}>🗑 Delete</button>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={btn()}>Cancel</button>
          <button onClick={submit} disabled={!!busy} style={btn(C.ink, "#FAF0DC")}>{busy === "save" ? "Saving…" : busy ? "Uploading…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

/* Pick listings to sell. Everything starts ticked except what's already on
   the store or has no photo/price; untick what shouldn't go up. */
function ImportFromListings({ settings, existing, onClose, onDone }) {
  const [listings, setListings] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [onlyEtsy, setOnlyEtsy] = useState(true);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState("");
  const fx = +settings.fx_inr_per_usd || 84;
  const have = useMemo(() => new Set(existing.map(p => p.listing_id)), [existing]);
  useEffect(() => {
    loadK(LIST_KEY).then(ls => {
      const arr = Array.isArray(ls) ? ls : [];
      setListings(arr);
      setPicked(new Set(arr.filter(l => l.platforms?.etsy?.status === "active" && !have.has(l.id) && (l.images || []).length && storePriceFor(l, fx, settings.price_rounding, settings.etsy_discount_pct) > 0).map(l => l.id)));
    }).catch(() => setListings([]));
  }, []);
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const list = (listings || []).filter(l => !have.has(l.id) && (!onlyEtsy || l.platforms?.etsy?.status === "active") && words.every(w => `${l.title} ${l.material} ${l.shape}`.toLowerCase().includes(w)));
  const toggle = id => setPicked(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const go = async () => {
    const chosen = (listings || []).filter(l => picked.has(l.id) && !have.has(l.id));
    const handles = new Set(existing.map(p => p.handle));
    const rows = [];
    for (const l of chosen) {
      const r = rowFromListing(l, { fx, rounding: settings.price_rounding, discount: settings.etsy_discount_pct, existing: null, live: true });
      if (!r.price || !r.images.length) continue;
      if (handles.has(r.handle)) r.handle = `${r.handle}-${String(l.id).slice(-4)}`;
      handles.add(r.handle);
      rows.push(r);
    }
    setBusy(`Adding ${rows.length}…`);
    try {
      for (let i = 0; i < rows.length; i += 100) await q(supabase.from("store_products").upsert(rows.slice(i, i + 100), { onConflict: "id" }));
      onDone(rows.length);
    } catch (e) { setBusy(""); alert(e.message); }
  };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(20,15,5,.45)", display: "flex", alignItems: mob() ? "flex-end" : "center", justifyContent: "center", padding: mob() ? 0 : 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ ...card, width: "100%", maxWidth: 760, maxHeight: "90vh", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, flex: 1 }}>Add from listings</div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer" }}>×</button>
        </div>
        <div style={{ padding: "10px 18px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", borderBottom: `1px solid ${C.border}` }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…" style={FI({ width: 200 })} />
          <label style={{ fontSize: 12.5, display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={onlyEtsy} onChange={e => setOnlyEtsy(e.target.checked)} /> Live on Etsy only</label>
          <div style={{ flex: 1 }} />
          <button onClick={() => setPicked(new Set([...picked, ...list.map(l => l.id)]))} style={btn()}>Tick all shown</button>
          <button onClick={() => setPicked(s => { const n = new Set(s); list.forEach(l => n.delete(l.id)); return n; })} style={btn()}>Untick all shown</button>
        </div>
        <div style={{ fontSize: 11.5, color: C.inkFaint, padding: "8px 18px 0" }}>Price = Etsy ₹{+settings.etsy_discount_pct ? ` less ${settings.etsy_discount_pct}%` : ""} ÷ {fx}, rounded ({settings.price_rounding || "whole"} dollars) — change the rate in Settings. A Store price set in Listing Manager wins.</div>
        <div style={{ overflowY: "auto", padding: "6px 18px", flex: 1 }}>
          {!listings && <div style={{ color: C.inkFaint, fontSize: 13, padding: 10 }}>Loading listings…</div>}
          {list.map(l => {
            const price = storePriceFor(l, fx, settings.price_rounding, settings.etsy_discount_pct);
            const ok = price > 0 && (l.images || []).length;
            return (
              <label key={l.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "7px 0", borderBottom: `1px solid ${C.border}`, cursor: ok ? "pointer" : "default", opacity: ok ? 1 : .5 }}>
                <input type="checkbox" disabled={!ok} checked={picked.has(l.id)} onChange={() => toggle(l.id)} />
                {l.images?.[0] ? <img src={l.images[0]} alt="" loading="lazy" style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 6 }} /> : <div style={{ width: 44, height: 44, background: C.card, borderRadius: 6 }} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.title}</div>
                  <div style={{ fontSize: 11, color: C.inkFaint }}>{collectionFor(l)} · {l.type === "repeatable" ? `repeatable, ${l.qty || 1}` : "one of a kind"}{!ok ? (price ? " · no photo" : " · no price") : ""}</div>
                </div>
                <div style={{ fontSize: 12, color: C.inkMid, textAlign: "right", whiteSpace: "nowrap" }}>{l.price_etsy ? `₹${(+l.price_etsy).toLocaleString("en-IN")}` : ""}<br /><b style={{ color: C.ink, fontSize: 13 }}>{price ? usd(price) : "—"}</b></div>
              </label>
            );
          })}
        </div>
        <div style={{ padding: "12px 18px", borderTop: `1px solid ${C.border}`, display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
          <span style={{ fontSize: 12.5, color: C.inkMid, marginRight: "auto" }}>{picked.size} ticked</span>
          <button onClick={onClose} style={btn()}>Cancel</button>
          <button onClick={go} disabled={!!busy || !picked.size} style={btn(C.ink, "#FAF0DC")}>{busy || `Add ${picked.size} to the store`}</button>
        </div>
      </div>
    </div>
  );
}

/* ── Settings ───────────────────────────────────────────────────────────── */
function SettingsTab({ settings, reload, showToast }) {
  const [f, setF] = useState(() => ({
    fx: settings.fx_inr_per_usd ?? 84, rounding: settings.price_rounding || "whole", discount: settings.etsy_discount_pct ?? 25,
    in_rate: settings.india_shipping?.rate ?? 150, in_free: settings.india_shipping?.free_over ?? 5000,
    regions: settings.shipping?.regions?.length ? settings.shipping.regions : [{ name: "United States", countries: ["US"], rate: 0, free_over: 0 }, { name: "Rest of world", countries: ["*"], rate: 0, free_over: 0 }],
    announcement: settings.announcement || "", about: settings.about || "", site_url: settings.site_url || "",
    contact_email: settings.contact_email || "", instagram: settings.instagram || "", whatsapp: settings.whatsapp || "",
    hero: { image: "", video: "", heading: "", eyebrow: "", intro: "", ...(settings.hero || {}) },
    sourcing: Array.isArray(settings.sourcing_photos) ? settings.sourcing_photos : [],
    insta_feed: typeof settings.instagram_feed === "string" ? settings.instagram_feed : "",
    insta: Array.isArray(settings.instagram_photos) ? settings.instagram_photos.map(x => typeof x === "string" ? { src: x, url: "" } : { src: x?.src || "", url: x?.url || "" }).filter(x => x.src) : [],
    dispatch_note: settings.dispatch_note || "", returns_note: settings.returns_note || "",
  }));
  const [busy, setBusy] = useState(false);
  const [heroBusy, setHeroBusy] = useState("");
  const setHero = patch => setF(x => ({ ...x, hero: { ...x.hero, ...patch } }));
  // A home-page photo or video, stored with the rest of the ERP's media.
  const uploadHero = async (file, kind) => {
    if (!file) return;
    setHeroBusy(kind);
    try {
      const ext = (file.name.split(".").pop() || (kind === "video" ? "mp4" : "jpg")).toLowerCase();
      const url = await uploadToStorage(`store/hero/${uid()}.${ext}`, file);
      setHero(kind === "video" ? { video: url } : { image: url });
      showToast("Uploaded — press Save settings to put it live");
    } catch (e) { showToast("⚠ " + e.message); }
    setHeroBusy("");
  };
  // The "From the mine to your shelf" collage on the home page.
  const addSourcing = async files => {
    const list = [...(files || [])].filter(f => f.type.startsWith("image/"));
    if (!list.length) return;
    setHeroBusy("sourcing");
    try {
      const urls = [];
      for (const file of list) urls.push(await uploadToStorage(`store/sourcing/${uid()}.${(file.name.split(".").pop() || "jpg").toLowerCase()}`, file));
      setF(x => ({ ...x, sourcing: [...x.sourcing, ...urls] }));
      showToast(`${urls.length} photo${urls.length === 1 ? "" : "s"} added — press Save settings`);
    } catch (e) { showToast("⚠ " + e.message); }
    setHeroBusy("");
  };
  // The "On Instagram" wall on the home page: five photos, each opening its post.
  const addInsta = async files => {
    const list = [...(files || [])].filter(f => f.type.startsWith("image/"));
    if (!list.length) return;
    setHeroBusy("insta");
    try {
      const got = [];
      for (const file of list) got.push({ src: await uploadToStorage(`store/instagram/${uid()}.${(file.name.split(".").pop() || "jpg").toLowerCase()}`, file), url: "" });
      setF(x => ({ ...x, insta: [...x.insta, ...got] }));
      showToast(`${got.length} photo${got.length === 1 ? "" : "s"} added — press Save settings`);
    } catch (e) { showToast("⚠ " + e.message); }
    setHeroBusy("");
  };
  // The live feed link (Behold.so or similar): try it, and say how many posts it gives.
  const [feedCheck, setFeedCheck] = useState("");
  const checkFeed = async url => {
    url = url.trim();
    if (!url) return setFeedCheck("");
    if (!/^https:\/\//.test(url)) return setFeedCheck("⚠ Paste the full link, starting https://");
    setFeedCheck("Checking…");
    try {
      const d = await (await fetch(url)).json();
      const posts = Array.isArray(d) ? d : d?.posts || d?.data || [];
      setFeedCheck(posts.length ? `✓ ${posts.length} posts found — press Save settings` : "⚠ The link works but has no posts");
    } catch { setFeedCheck("⚠ Couldn't read that link — use the JSON feed link"); }
  };
  const setInsta = (i, patch) => setF(x => ({ ...x, insta: x.insta.map((p, j) => j === i ? { ...p, ...patch } : p) }));
  const moveInsta = (i, d) => setF(x => { const a = [...x.insta]; const j = i + d; if (j < 0 || j >= a.length) return x; [a[i], a[j]] = [a[j], a[i]]; return { ...x, insta: a }; });
  const moveSourcing = (i, d) => setF(x => { const a = [...x.sourcing]; const j = i + d; if (j < 0 || j >= a.length) return x; [a[i], a[j]] = [a[j], a[i]]; return { ...x, sourcing: a }; });
  const setR = (i, k, v) => setF(x => ({ ...x, regions: x.regions.map((r, j) => j === i ? { ...r, [k]: v } : r) }));
  const save = async () => {
    setBusy(true);
    try {
      const regions = f.regions.map(r => ({ name: String(r.name).trim() || "Region", countries: (Array.isArray(r.countries) ? r.countries : String(r.countries).split(",")).map(c => c.trim().toUpperCase()).filter(Boolean), rate: +r.rate || 0, free_over: +r.free_over || 0 }));
      await q(supabase.from("store_settings").upsert([
        { key: "fx_inr_per_usd", value: +f.fx || 84 }, { key: "price_rounding", value: f.rounding },
        { key: "etsy_discount_pct", value: Math.max(0, Math.min(90, +f.discount || 0)) },
        { key: "india_shipping", value: { rate: +f.in_rate || 0, free_over: +f.in_free || 0 } },
        { key: "shipping", value: { regions } }, { key: "announcement", value: f.announcement.trim() },
        { key: "about", value: f.about.trim() }, { key: "site_url", value: f.site_url.trim().replace(/\/+$/, "") },
        { key: "hero", value: { image: f.hero.image, video: f.hero.video, heading: f.hero.heading.trim(), eyebrow: f.hero.eyebrow.trim(), intro: (f.hero.intro || "").trim() } },
        { key: "sourcing_photos", value: f.sourcing },
        { key: "instagram_feed", value: /^https:\/\//.test(f.insta_feed.trim()) ? f.insta_feed.trim() : "" },
        { key: "instagram_photos", value: f.insta.map(x => ({ src: x.src, url: /^https:\/\/(www\.)?instagram\.com\//.test(x.url.trim()) ? x.url.trim().split("?")[0] : "" })) },
        { key: "contact_email", value: f.contact_email.trim() }, { key: "instagram", value: f.instagram.trim().replace(/^@/, "") },
        { key: "whatsapp", value: f.whatsapp.replace(/[^\d]/g, "") },
        { key: "dispatch_note", value: f.dispatch_note.trim() }, { key: "returns_note", value: f.returns_note.trim() },
      ], { onConflict: "key" }));
      await reload();
      showToast("Saved — the store picks it up within a minute");
    } catch (e) { showToast("⚠ " + e.message); }
    setBusy(false);
  };
  return (
    <div style={{ display: "grid", gap: 14, maxWidth: 680 }}>
      <div style={{ ...card, padding: 18, display: "grid", gap: 12 }}>
        <div style={{ fontWeight: 700 }}>Prices</div>
        <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "1fr 1fr 1fr", gap: 10 }}>
          <div><span style={lab}>Etsy sale to match (% off list)</span><input value={f.discount} onChange={e => setF(x => ({ ...x, discount: e.target.value.replace(/[^\d.]/g, "") }))} style={FI()} /></div>
          <div><span style={lab}>Rupees per dollar (Etsy ₹ → store $)</span><input value={f.fx} onChange={e => setF(x => ({ ...x, fx: e.target.value.replace(/[^\d.]/g, "") }))} style={FI()} /></div>
          <div><span style={lab}>Rounding</span><select value={f.rounding} onChange={e => setF(x => ({ ...x, rounding: e.target.value }))} style={FI()}><option value="whole">Whole dollars ($84)</option><option value="99">.99 endings ($83.99)</option><option value="cents">Exact ($83.57)</option></select></div>
        </div>
        <div style={{ fontSize: 11.5, color: C.inkFaint }}>Used when adding pieces and when a listing syncs without its own Store price. Existing store prices don't change.</div>
      </div>
      <div style={{ ...card, padding: 18, display: "grid", gap: 10 }}>
        <div style={{ fontWeight: 700 }}>Shipping by region</div>
        <div style={{ fontSize: 11.5, color: C.inkFaint }}>Countries as 2-letter codes (US, CA, GB…). <b>*</b> means everywhere else. Free over = order value for free shipping (0 = never).</div>
        {f.regions.map((r, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: mob() ? "1fr 1fr" : "1.2fr 1.4fr .7fr .8fr auto", gap: 8, alignItems: "end" }}>
            <div><span style={lab}>Name</span><input value={r.name} onChange={e => setR(i, "name", e.target.value)} style={FI()} /></div>
            <div><span style={lab}>Countries</span><input value={Array.isArray(r.countries) ? r.countries.join(", ") : r.countries} onChange={e => setR(i, "countries", e.target.value)} style={FI()} /></div>
            <div><span style={lab}>Rate $</span><input value={r.rate} onChange={e => setR(i, "rate", e.target.value.replace(/[^\d.]/g, ""))} style={FI()} /></div>
            <div><span style={lab}>Free over $</span><input value={r.free_over} onChange={e => setR(i, "free_over", e.target.value.replace(/[^\d.]/g, ""))} style={FI()} /></div>
            <button onClick={() => setF(x => ({ ...x, regions: x.regions.filter((_, j) => j !== i) }))} style={{ ...btn(), color: C.red }}>✕</button>
          </div>
        ))}
        <div><button onClick={() => setF(x => ({ ...x, regions: [...x.regions, { name: "", countries: "", rate: 0, free_over: 0 }] }))} style={btn()}>＋ Region</button></div>
      </div>
      <div style={{ ...card, padding: 18, display: "grid", gap: 10 }}>
        <div style={{ fontWeight: 700 }}>India (Razorpay, in rupees)</div>
        <div style={{ fontSize: 11.5, color: C.inkFaint }}>Indian buyers see the Etsy sale price in ₹ and pay with UPI, cards or netbanking.</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div><span style={lab}>Shipping ₹</span><input value={f.in_rate} onChange={e => setF(x => ({ ...x, in_rate: e.target.value.replace(/[^\d.]/g, "") }))} style={FI()} /></div>
          <div><span style={lab}>Free over ₹ (0 = never)</span><input value={f.in_free} onChange={e => setF(x => ({ ...x, in_free: e.target.value.replace(/[^\d.]/g, "") }))} style={FI()} /></div>
        </div>
      </div>
      <div style={{ ...card, padding: 18, display: "grid", gap: 12 }}>
        <div style={{ fontWeight: 700 }}>Home page</div>
        <div style={{ fontSize: 11.5, color: C.inkFaint }}>The big picture at the top of eartheditions.co. Use a wide, sharp photo (at least 2400px across) or a short, silent video. Without one, the store uses the photo of a ★ featured piece.</div>
        <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "1fr 1fr", gap: 12 }}>
          <div>
            <span style={lab}>Photo</span>
            {f.hero.image ? <img src={f.hero.image} alt="" style={{ width: "100%", aspectRatio: "16/9", objectFit: "cover", borderRadius: 8, border: `1px solid ${C.border}` }} /> : <div style={{ aspectRatio: "16/9", background: C.card, borderRadius: 8, display: "grid", placeItems: "center", fontSize: 12, color: C.inkFaint }}>none</div>}
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <label style={{ ...btn(), cursor: "pointer" }}>{heroBusy === "image" ? "Uploading…" : "Upload photo"}<input type="file" accept="image/*" hidden onChange={e => { uploadHero(e.target.files?.[0], "image"); e.target.value = ""; }} /></label>
              {f.hero.image && <button onClick={() => setHero({ image: "" })} style={btn()}>Remove</button>}
            </div>
          </div>
          <div>
            <span style={lab}>Video (optional — plays instead of the photo)</span>
            {f.hero.video ? <video src={f.hero.video} muted playsInline loop autoPlay style={{ width: "100%", aspectRatio: "16/9", objectFit: "cover", borderRadius: 8, border: `1px solid ${C.border}` }} /> : <div style={{ aspectRatio: "16/9", background: C.card, borderRadius: 8, display: "grid", placeItems: "center", fontSize: 12, color: C.inkFaint }}>none</div>}
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <label style={{ ...btn(), cursor: "pointer" }}>{heroBusy === "video" ? "Uploading…" : "Upload video"}<input type="file" accept="video/*" hidden onChange={e => { uploadHero(e.target.files?.[0], "video"); e.target.value = ""; }} /></label>
              {f.hero.video && <button onClick={() => setHero({ video: "" })} style={btn()}>Remove</button>}
            </div>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "1fr 2fr", gap: 10 }}>
          <div><span style={lab}>Small line above</span><input value={f.hero.eyebrow} onChange={e => setHero({ eyebrow: e.target.value })} placeholder="Rocks · Crystals · Minerals · Carvings & more" style={FI()} /></div>
          <div><span style={lab}>Headline</span><input value={f.hero.heading} onChange={e => setHero({ heading: e.target.value })} placeholder="From the earth, to your hands." style={FI()} /></div>
        </div>
        <div><span style={lab}>Intro line under the headline</span><input value={f.hero.intro || ""} onChange={e => setHero({ intro: e.target.value })} placeholder="Natural crystals, mineral specimens, rough stone and hand-carved pieces — sourced close to the mine and shipped worldwide." style={FI()} /></div>
      </div>
      <div style={{ ...card, padding: 18, display: "grid", gap: 10 }}>
        <div style={{ fontWeight: 700 }}>From the mine <span style={{ fontWeight: 400, fontSize: 12, color: C.inkFaint }}>— the sourcing collage on the home page</span></div>
        <div style={{ fontSize: 11.5, color: C.inkFaint }}>Mines, rough stone, boulders at the source. Any shape works; they're laid out as a collage in this order. Until you add some, three default photos show.</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {f.sourcing.map((u, i) => (
            <div key={u} style={{ position: "relative", width: 110 }}>
              <img src={u} alt="" style={{ width: 110, height: 110, objectFit: "cover", borderRadius: 8, border: `1px solid ${C.border}`, display: "block" }} />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3 }}>
                <button onClick={() => moveSourcing(i, -1)} disabled={!i} style={{ ...btn(), padding: "2px 8px" }}>‹</button>
                <button onClick={() => setF(x => ({ ...x, sourcing: x.sourcing.filter((_, j) => j !== i) }))} style={{ ...btn(), padding: "2px 8px", color: C.red }}>✕</button>
                <button onClick={() => moveSourcing(i, 1)} disabled={i === f.sourcing.length - 1} style={{ ...btn(), padding: "2px 8px" }}>›</button>
              </div>
            </div>
          ))}
        </div>
        <div><label style={{ ...btn(), cursor: "pointer", display: "inline-block" }}>{heroBusy === "sourcing" ? "Uploading…" : "＋ Add photos"}<input type="file" accept="image/*" multiple hidden onChange={e => { addSourcing(e.target.files); e.target.value = ""; }} /></label></div>
      </div>
      <div style={{ ...card, padding: 18, display: "grid", gap: 10 }}>
        <div style={{ fontWeight: 700 }}>On Instagram <span style={{ fontWeight: 400, fontSize: 12, color: C.inkFaint }}>— the photo wall at the foot of the home page</span></div>
        <div>
          <span style={lab}>Live feed link (optional)</span>
          <input value={f.insta_feed} onChange={e => setF(x => ({ ...x, insta_feed: e.target.value }))} onBlur={e => checkFeed(e.target.value)} placeholder="https://feeds.behold.so/…" style={FI()} />
          <div style={{ fontSize: 11.5, color: feedCheck.startsWith("⚠") ? C.red : feedCheck.startsWith("✓") ? C.green : C.inkFaint, marginTop: 4 }}>
            {feedCheck || <>For your latest posts to show by themselves: sign in with Instagram at <a href="https://behold.so" target="_blank" rel="noreferrer" style={{ color: "inherit" }}>behold.so</a> (free), make a <b>JSON</b> feed, and paste its link here. Without one, the photos below show.</>}
          </div>
        </div>
        <div style={{ fontSize: 11.5, color: C.inkFaint }}>Backup photos — five show, the first large. Paste a post's link under a photo to open that post; without one it opens your profile. Without photos here, second photos of pieces on sale show. Needs your handle under Contact below.</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {f.insta.map((ph, i) => (
            <div key={ph.src} style={{ width: 130, opacity: i < 5 ? 1 : .45 }} title={i < 5 ? "" : "Only the first five show"}>
              <img src={ph.src} alt="" style={{ width: 130, height: 130, objectFit: "cover", borderRadius: 8, border: `2px solid ${i === 0 ? C.gold : C.border}`, display: "block" }} />
              <input value={ph.url} onChange={e => setInsta(i, { url: e.target.value })} placeholder="Post link (optional)" style={FI({ marginTop: 4, padding: "4px 7px", fontSize: 11, borderColor: ph.url && !/^https:\/\/(www\.)?instagram\.com\//.test(ph.url.trim()) ? C.red : undefined })} />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3 }}>
                <button onClick={() => moveInsta(i, -1)} disabled={!i} style={{ ...btn(), padding: "2px 8px" }}>‹</button>
                <button onClick={() => setF(x => ({ ...x, insta: x.insta.filter((_, j) => j !== i) }))} style={{ ...btn(), padding: "2px 8px", color: C.red }}>✕</button>
                <button onClick={() => moveInsta(i, 1)} disabled={i === f.insta.length - 1} style={{ ...btn(), padding: "2px 8px" }}>›</button>
              </div>
            </div>
          ))}
        </div>
        <div><label style={{ ...btn(), cursor: "pointer", display: "inline-block" }}>{heroBusy === "insta" ? "Uploading…" : "＋ Add photos"}<input type="file" accept="image/*" multiple hidden onChange={e => { addInsta(e.target.files); e.target.value = ""; }} /></label></div>
      </div>
      <div style={{ ...card, padding: 18, display: "grid", gap: 12 }}>
        <div><span style={lab}>Announcement bar (blank = free-shipping line)</span><input value={f.announcement} onChange={e => setF(x => ({ ...x, announcement: e.target.value }))} style={FI()} /></div>
        <div><span style={lab}>About page (blank line = new paragraph)</span><textarea value={f.about} onChange={e => setF(x => ({ ...x, about: e.target.value }))} style={FI({ minHeight: 120, resize: "vertical" })} /></div>
        <div><span style={lab}>Store address</span><input value={f.site_url} onChange={e => setF(x => ({ ...x, site_url: e.target.value }))} style={FI()} /></div>
      </div>
      <div style={{ ...card, padding: 18, display: "grid", gap: 12 }}>
        <div style={{ fontWeight: 700 }}>Contact & policies <span style={{ fontWeight: 400, fontSize: 12, color: C.inkFaint }}>— shown on Contact and Shipping & returns</span></div>
        <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "1fr 1fr 1fr", gap: 10 }}>
          <div><span style={lab}>Email</span><input value={f.contact_email} onChange={e => setF(x => ({ ...x, contact_email: e.target.value }))} placeholder="hello@eartheditions.co" style={FI()} /></div>
          <div><span style={lab}>Instagram</span><input value={f.instagram} onChange={e => setF(x => ({ ...x, instagram: e.target.value }))} placeholder="@eartheditions" style={FI()} /></div>
          <div><span style={lab}>WhatsApp</span><input value={f.whatsapp} onChange={e => setF(x => ({ ...x, whatsapp: e.target.value }))} placeholder="Country code + number" style={FI()} /></div>
        </div>
        <div><span style={lab}>Dispatch time (e.g. "Orders ship within 3–5 business days from …")</span><input value={f.dispatch_note} onChange={e => setF(x => ({ ...x, dispatch_note: e.target.value }))} style={FI()} /></div>
        <div><span style={lab}>Returns policy (blank = 14-day "we'll make it right" wording)</span><textarea value={f.returns_note} onChange={e => setF(x => ({ ...x, returns_note: e.target.value }))} style={FI({ minHeight: 90, resize: "vertical" })} /></div>
      </div>
      <div><button onClick={save} disabled={busy} style={btn(C.ink, "#FAF0DC")}>{busy ? "Saving…" : "Save settings"}</button></div>
    </div>
  );
}
