/* Store — the ERP's side of eartheditions.co, the retail shop that replaces
   Shopify: orders paid through Stripe, the products on sale (brought in from
   Listing Manager), and the settings (exchange rate, shipping regions).

   Products live in store_products, orders in store_orders. The storefront
   reads them through its own server; staff manage them here with their ERP
   session. A listing can also be published to the store from Listing Manager,
   which writes the same rows. */
import { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "./supabase.js";
import { C, mob, FI } from "./lmTheme.js";
import { loadK, uid } from "./utils.js";
import { uploadToStorage } from "./storageUtils.js";
import { ETSY_SHOP_SECTIONS } from "../lib/listingCategories.js";
import { retailTitle } from "../lib/retailTitle.js";

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
  // A Shopify title was written by hand for a shop; an Etsy one is keywords.
  const rt = retailTitle(l.title);
  return {
    id: `lm-${l.id}`, listing_id: l.id,
    handle: existing?.handle || handleFrom(l),
    title: String(l.shopify_title || rt.title || l.title || "").trim(),
    subtitle: rt.size,
    description: String(l.shopify_description || l.description || "").replace(/<[^>]+>/g, "").trim(),
    images, videos: l.video && /^https?:/.test(l.video) ? [l.video] : (existing?.videos || []),
    material: l.material || "", shape: l.shape || "", product_type: l.productType || "",
    tags: Array.isArray(l.tags) ? l.tags : [],
    collections: existing?.collections?.length ? existing.collections : [collectionFor(l)],
    price: storePriceFor(l, fx, rounding, discount),
    // Indian buyers pay in rupees: the Etsy sale price itself, no dollar round trip.
    price_inr: +l.price_etsy ? Math.round(+l.price_etsy * (1 - (+discount || 0) / 100) / 10) * 10 : null,
    qty: Math.max(1, parseInt(l.qty, 10) || 1),
    is_unique: l.type !== "repeatable",
    status: existing?.status === "sold" ? "sold" : live ? "active" : (existing?.status || "hidden"),
    sku: l.sku || "",
    source: { listing_id: l.id, etsy_id: l.platforms?.etsy?.listing_id || null },
    updated_at: new Date().toISOString(),
  };
}

/* Listing Manager hooks — the store is a platform there, like Etsy. */
export async function publishListingToStore(listing, { syncOnly = false } = {}) {
  const s = await storeSettings();
  const id = `lm-${listing.id}`;
  const existing = await q(supabase.from("store_products").select("handle,status,collections,videos").eq("id", id).maybeSingle());
  let row = rowFromListing(listing, { fx: +s.fx_inr_per_usd || 84, rounding: s.price_rounding, discount: s.etsy_discount_pct, existing, live: !syncOnly });
  if (!existing) {
    const clash = await q(supabase.from("store_products").select("id").eq("handle", row.handle).maybeSingle());
    if (clash) row = { ...row, handle: `${row.handle}-${String(listing.id).slice(-4)}` };
  }
  if (!row.price) throw new Error("No store price — set one, or an Etsy price to convert");
  await q(supabase.from("store_products").upsert(row, { onConflict: "id" }));
  const base = String(s.site_url || "https://eartheditions.co").replace(/\/+$/, "");
  return { product_id: id, url: `${base}/products/${row.handle}`, status: row.status === "active" ? "active" : "draft" };
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
  const [shown, setShown] = useState(60);
  const load = useCallback(() => q(supabase.from("store_products").select("*").order("created_at", { ascending: false }).range(0, 4999))
    .then(setRows).catch(e => { showToast?.("⚠ " + e.message); setRows([]); }), [showToast]);
  useEffect(() => { load(); }, [load]);
  const save = async (id, p) => {
    try { const row = await q(supabase.from("store_products").update({ ...p, updated_at: new Date().toISOString() }).eq("id", id).select().single()); setRows(r => r.map(x => x.id === id ? row : x)); }
    catch (e) { showToast?.("⚠ " + e.message); }
  };
  const del = async p => {
    if (!window.confirm(`Take "${p.title}" off the store completely? (Hide keeps it for later.)`)) return;
    try { await q(supabase.from("store_products").delete().eq("id", p.id)); setRows(r => r.filter(x => x.id !== p.id)); }
    catch (e) { showToast?.("⚠ " + e.message); }
  };
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const list = useMemo(() => (rows || []).filter(p => (filter === "all" || p.status === filter || (filter === "featured" && p.featured)) &&
    words.every(w => `${p.title} ${p.material} ${p.shape} ${p.sku} ${(p.collections || []).join(" ")}`.toLowerCase().includes(w))), [rows, filter, search]);
  const count = f => (rows || []).filter(p => f === "featured" ? p.featured : p.status === f).length;

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
      <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${mob() ? 160 : 210}px, 1fr))`, gap: mob() ? 10 : 14 }}>
        {list.slice(0, shown).map(p => (
          <div key={p.id} style={{ ...card, overflow: "hidden", display: "flex", flexDirection: "column", opacity: p.status === "active" ? 1 : .6 }}>
            <a href={`${site}/products/${p.handle}`} target="_blank" rel="noreferrer" style={{ position: "relative", aspectRatio: "4/5", background: C.card, display: "block" }}>
              {p.images?.[0] && <img src={p.images[0]} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />}
              {p.status === "sold" && <span style={{ position: "absolute", top: 8, left: 8, background: C.ink, color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 4, padding: "2px 7px" }}>SOLD</span>}
              {p.featured && <span style={{ position: "absolute", top: 8, right: 8, background: C.gold, color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 4, padding: "2px 7px" }}>★</span>}
            </a>
            <div style={{ padding: "10px 12px 6px", flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 13.5, lineHeight: 1.25, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{p.title}</div>
              <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 3 }}>{[p.subtitle, (p.collections || [])[0]].filter(Boolean).join(" · ")}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 6 }}>
                <span style={{ fontSize: 12, color: C.inkMid }}>$</span>
                <input defaultValue={p.price} inputMode="decimal" onBlur={e => { const v = +e.target.value || 0; if (v !== +p.price) save(p.id, { price: v }); }}
                  style={FI({ padding: "4px 8px", fontSize: 13, fontWeight: 700, width: 90 })} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 5, padding: "4px 10px 10px" }}>
              {p.status !== "sold"
                ? <button onClick={() => save(p.id, { status: p.status === "active" ? "hidden" : "active" })} style={{ ...btn(p.status === "active" ? C.ink : C.surface, p.status === "active" ? "#fff" : C.inkMid), flex: 1, padding: "5px 0", fontSize: 11 }}>{p.status === "active" ? "On sale" : "Hidden"}</button>
                : <button onClick={() => save(p.id, { status: "active", sold_at: null })} style={{ ...btn(), flex: 1, padding: "5px 0", fontSize: 11 }}>Relist</button>}
              <button onClick={() => save(p.id, { featured: !p.featured })} title="Feature on the home page" style={{ ...btn(p.featured ? C.gold : C.surface, p.featured ? "#fff" : C.inkMid), padding: "5px 9px", fontSize: 11 }}>★</button>
              <button onClick={() => del(p)} title="Remove from the store" style={{ ...btn(), padding: "5px 9px", fontSize: 11, color: C.red }}>✕</button>
            </div>
          </div>
        ))}
      </div>
      {list.length > shown && <div style={{ textAlign: "center", marginTop: 12 }}><button onClick={() => setShown(s => s + 100)} style={btn()}>Show more ({list.length - shown})</button></div>}
      {importing && settings && <ImportFromListings settings={settings} existing={rows || []} onClose={() => setImporting(false)} onDone={n => { setImporting(false); load(); showToast?.(`✓ ${n} piece${n === 1 ? "" : "s"} added to the store`); }} />}
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
    hero: { image: "", video: "", heading: "", eyebrow: "", ...(settings.hero || {}) },
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
        { key: "hero", value: { image: f.hero.image, video: f.hero.video, heading: f.hero.heading.trim(), eyebrow: f.hero.eyebrow.trim() } },
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
          <div><span style={lab}>Small line above</span><input value={f.hero.eyebrow} onChange={e => setHero({ eyebrow: e.target.value })} placeholder="Crystals · Minerals · Carvings" style={FI()} /></div>
          <div><span style={lab}>Headline</span><input value={f.hero.heading} onChange={e => setHero({ heading: e.target.value })} placeholder="The exact piece you see." style={FI()} /></div>
        </div>
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
