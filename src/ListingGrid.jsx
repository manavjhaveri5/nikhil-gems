/* Listing Manager's grid: every listing as a card, four or five across, with
   its live platforms, the three prices that matter (USA $ and India ₹ on the
   store, Etsy ₹) editable in place, and a drawer to manage photos, platforms
   and every other price. ListingManagerApp owns the data and the platform
   calls; this file is the view. */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import { C, FI } from "./lmTheme.js";
import { locationOf, needsLocation, knownLocations, tradeRowOf } from "./listingChannels.js";
import { useStoriesDone, listedAt } from "./storyState.js";
import { sbThumb } from "./photoUrls.js";

const PhotoEditor = lazy(() => import("./PhotoEditor.jsx"));
const StoryStudio = lazy(() => import("./StoryStudio.jsx"));

const PLAT = [
  { key: "etsy",          label: "Etsy",       short: "Etsy",  color: "#F56400" },
  // eartheditions.co and the old Earth Editions Shopify store are one shop to us:
  // one chip, live if the piece is live on either.
  { key: "store",         label: "Earth Editions", short: "Earth Ed.", color: "#141210" },
  { key: "shopify_aty",   label: "Atyahara",   short: "Aty",   color: "#6B3FA0" },
  { key: "ebay",          label: "eBay",       short: "eBay",  color: "#0064D2" },
  { key: "trade",         label: "Trade site", short: "Trade", color: "#1F8F4E" },
];
// Every price a listing carries, for the drawer. The grid shows the first three.
const PRICES = [
  { field: "price_store",         label: "USA · Earth Editions",  cur: "$", flag: "🇺🇸", sync: "store" },
  { field: "price_store_inr",     label: "India · Earth Editions", cur: "₹", flag: "🇮🇳", sync: "store" },
  { field: "price_etsy",          label: "Etsy",            cur: "₹", flag: "🏷️", sync: "etsy" },
  { field: "price_ebay",          label: "eBay",            cur: "$", flag: "🔨", sync: "ebay" },
  { field: "price_shopify_earth", label: "Earth Ed.",       cur: "$", flag: "🌍", sync: "shopify_earth" },
  { field: "price_shopify_aty",   label: "Atyahara",        cur: "₹", flag: "💫", sync: "shopify_aty" },
  { field: "price_trade",         label: "Trade site",      cur: "$", flag: "🤝", sync: "trade" },
];

const serif = "'Cormorant Garamond', Georgia, serif";
const num = v => (v === "" || v == null || !isFinite(+v) ? null : +v);
const money = (v, cur) => v == null || v === "" ? "—" : `${cur}${Number(v).toLocaleString(cur === "₹" ? "en-IN" : "en-US", { maximumFractionDigits: +v >= 100 ? 0 : 2 })}`;
/* The store and the trade site keep their own records: a piece hidden or sold
   in the store's editor, or added or deleted by an editor on the trade site,
   isn't written back to the listing. Once those records have loaded
   (f.store, f.trade), they decide; the listing's own note is the fallback. */
const rawStatus = (l, k, f = {}) => {
  if (k === "store" && f.store) { const r = f.store[l.id]; return !r ? "" : r.status === "active" ? "active" : r.status === "sold" ? "sold" : "draft"; }
  if (k === "trade" && f.trade) { const r = tradeRowOf(f.trade, l); return !r ? "" : r.live ? "active" : "draft"; }
  const st = l.platforms?.[k]?.status || "";
  return st === "deleted" ? "" : st;
};
// Earth Editions is one shop: eartheditions.co or its old Shopify store, whichever is live.
const statusOf = (l, k, f = {}) => {
  if (k !== "store") return rawStatus(l, k, f);
  const a = rawStatus(l, "store", f), b = rawStatus(l, "shopify_earth", f);
  return a === "active" || b === "active" ? "active" : a || b;
};
export const isLive = (l, f) => PLAT.some(p => statusOf(l, p.key, f) === "active");
// Listing-sized images: Etsy serves smaller copies of its own; ours via sbThumb.
export const thumb = (u, w = 570) => {
  if (!u || typeof u !== "string") return u;
  if (/i\.etsystatic\.com/.test(u)) return u.replace(/il_fullxfull\./, w <= 340 ? "il_340x270." : "il_570xN.");
  return sbThumb(u, w);
};
const soldOut = (l, orders, f) => l.type === "unique" && (orders || []).some(o => o.listing_id === l.id) && !isLive(l, f);

/* What each piece has done, for its card. Sales are the Orders record's, by
   the listing they came from, cancelled and fully refunded ones out. Views and
   favourites are Etsy's, from the copy of the shop the Etsy tab keeps on this
   device (ng-etsy-v4), so they're as of that tab's last sync, and so are its
   dates. Etsy's are the ones to trust: the ERP's created_at is the day a piece
   was imported for anything brought in from Etsy, and the ERP keeps no
   renewal dates at all. Etsy moves created_timestamp on every renewal and
   keeps the first in original_creation_timestamp. */
const cancelled = o => !!o?.cancelled || !!o?.refunded || !!o?.cancelled_at || /cancel|refund/i.test(String(o?.status || ""));
// The first time it went up anywhere (listedAt is the latest, for "newest").
const firstListed = l => {
  const ts = [l.created_at, ...Object.values(l.platforms || {}).flatMap(p => [p?.first_listed_at, p?.live_at])].map(v => Date.parse(v || "") || 0).filter(v => v > 0);
  return ts.length ? Math.min(...ts) : 0;
};
const salesByListing = orders => {
  const m = new Map();
  for (const o of orders || []) {
    if (!o?.listing_id || cancelled(o)) continue;
    const s = m.get(o.listing_id) || { units: 0, money: {}, last: 0, where: new Set() };
    s.units += +o.qty || 1;
    const cur = String(o.currency || "INR").toUpperCase();
    s.money[cur] = (s.money[cur] || 0) + (+o.sale_price || 0);
    s.last = Math.max(s.last, Date.parse(o.created_at || o.date) || 0);
    if (o.platform) s.where.add(o.platform);
    m.set(o.listing_id, s);
  }
  return m;
};
const etsyOnDevice = () => {
  const m = new Map();
  try {
    const c = JSON.parse(localStorage.getItem("ng-etsy-v4") || "null");
    for (const x of c?.listings || []) if (x?.listing_id) m.set(String(x.listing_id), { views: +x.views || 0, favs: +x.num_favorers || 0, state: x.state || "",
      created: (+x.original_creation_timestamp || 0) * 1000, renewed: (+x.created_timestamp || 0) * 1000, ends: (+x.ending_timestamp || 0) * 1000 });
    return { m, at: +c?.syncedAt || 0 };
  } catch { return { m, at: 0 }; }
};
const etsyOf = (l, etsy) => etsy?.m.get(String(l.platforms?.etsy?.listing_id || "")) || null;
const shortMoney = (v, cur) => {
  const sym = cur === "INR" ? "₹" : cur === "USD" ? "$" : cur === "EUR" ? "€" : cur === "GBP" ? "£" : `${cur} `;
  const a = Math.abs(v), t = a >= 1e5 && cur === "INR" ? `${(a / 1e5).toFixed(1)}L` : a >= 1e4 ? `${Math.round(a / 1e3)}k` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}k` : `${Math.round(a)}`;
  return `${sym}${t}`;
};
const ageOf = ms => { const d = ms / 864e5; return d < 1 ? "today" : d < 14 ? `${Math.round(d)}d` : d < 60 ? `${Math.round(d / 7)}wk` : d < 365 ? `${Math.round(d / 30.4)}mo` : `${(d / 365).toFixed(1).replace(/\.0$/, "")}yr`; };
const PLATFORM_NAME = { etsy: "Etsy", store: "Earth Editions", shopify_earth: "Earth Ed. (Shopify)", shopify_aty: "Atyahara", ebay: "eBay", trade: "Trade site", manual: "by hand" };

/* ── a price you can click and type over ───────────────────────────────── */
function PriceCell({ flag, cur, value: live, hint, onSave, big = false, title }) {
  const [edit, setEdit] = useState(false);
  // What was just saved shows at once; the platform's own figure takes over when it catches up.
  const [saved, setSaved] = useState(null);
  useEffect(() => { setSaved(null); }, [live]);
  const value = saved ?? live;
  const [v, setV] = useState("");
  const [state, setState] = useState("");   // "" | "saving" | "ok" | error text
  const ref = useRef(null);
  useEffect(() => { if (edit) ref.current?.select(); }, [edit]);
  const commit = async () => {
    setEdit(false);
    const n = num(v);
    if (n == null || n === num(value)) return;
    setState("saving");
    try { await onSave(n); setSaved(n); setState("ok"); setTimeout(() => setState(""), 1600); }
    catch (e) { setState(e.message || "Failed"); setTimeout(() => setState(""), 5000); }
  };
  return (
    <div title={state && state !== "ok" && state !== "saving" ? state : `${title || ""}${value != null ? ` (${money(value, cur)})` : ""}`} onClick={e => { e.stopPropagation(); if (!edit) { setV(value ?? ""); setEdit(true); } }}
      style={{ flex: 1, minWidth: 0, cursor: "text", borderRadius: 7, padding: big ? "6px 8px" : "5px 6px",
        background: state && state !== "ok" && state !== "saving" ? C.redBg : C.bg, border: `1px solid ${edit ? C.gold : "transparent"}`, transition: "border-color .15s" }}>
      <div style={{ fontSize: 9.5, color: C.inkFaint, letterSpacing: .3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{flag}</div>
      {edit ? (
        <input ref={ref} value={v} inputMode="decimal" onChange={e => setV(e.target.value.replace(/[^\d.]/g, ""))}
          onBlur={commit} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { setV(value ?? ""); setEdit(false); } }}
          style={{ width: "100%", border: "none", outline: "none", background: "transparent", padding: 0, fontSize: big ? 15 : 13.5, fontWeight: 700, color: C.ink, fontFamily: "inherit" }} />
      ) : (
        <div style={{ fontSize: big ? 15 : String(value ?? "").length > 5 ? 12 : 13.5, fontWeight: 700, color: value == null ? C.inkFaint : C.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", letterSpacing: -.2 }}>
          {state === "saving" ? "…" : state === "ok" ? "✓ " + money(value, cur) : money(value, cur)}
          {hint && value == null && <span style={{ fontSize: 10, fontWeight: 500, marginLeft: 4 }}>{hint}</span>}
        </div>
      )}
    </div>
  );
}

/* ── where it sits: click and type, or pick a place already in use ──────── */
function LocationCell({ value, missing, onSave }) {
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState("");
  const [state, setState] = useState("");
  const commit = async () => {
    setEdit(false);
    const n = v.trim();
    if (n === value) return;
    setState("saving");
    try { await onSave(n); setState(""); } catch (e) { setState(e.message || "Failed"); setTimeout(() => setState(""), 5000); }
  };
  if (edit) return (
    <input autoFocus value={v} list="lm-grid-locs" onClick={e => e.stopPropagation()} onChange={e => setV(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { setV(value); setEdit(false); } }}
      placeholder="Shelf, box, drawer…" style={{ ...FI(), padding: "4px 8px", fontSize: 12 }} />
  );
  return (
    <button onClick={e => { e.stopPropagation(); setV(value || ""); setEdit(true); }} title={state && state !== "saving" ? state : "Where it is — click to change"}
      style={{ display: "flex", alignItems: "center", gap: 5, width: "100%", textAlign: "left", border: `1px ${missing ? "dashed" : "solid"} ${missing ? "#C0392B" : "transparent"}`, cursor: "text",
        background: missing ? C.redBg : C.bg, borderRadius: 7, padding: "4px 8px", fontSize: 11.5, fontWeight: 600, color: missing ? C.red : value ? C.ink : C.inkFaint, minWidth: 0 }}>
      <span>📍</span>
      <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{state === "saving" ? "Saving…" : value || (missing ? "Add location" : "No location")}</span>
    </button>
  );
}

/* ── one listing ───────────────────────────────────────────────────────── */
function Tile({ l, store, facts, orders, stock, sales, etsy, etsyAt, onOpen, onEdit, onPrice, onLocation, selected, onSelect }) {
  const imgs = (l.images || []).filter(u => typeof u === "string");
  const [i, setI] = useState(0);
  const [hover, setHover] = useState(false);
  /* The video plays over the photo once the pointer rests on it a moment —
     only then is it loaded, so a page of cards doesn't fetch every video. The
     photo stays until the video is actually playing; the arrows go back to it. */
  const [vid, setVid] = useState(false);
  const [vidShown, setVidShown] = useState(false);
  const vidT = useRef(null);
  useEffect(() => () => clearTimeout(vidT.current), []);
  const stopVid = () => { clearTimeout(vidT.current); setVid(false); setVidShown(false); };
  const sold = soldOut(l, orders, facts);
  const where = locationOf(l, stock);
  const s = store?.[l.id];
  const usd = s ? num(s.price) : num(l.price_store);
  const inr = s ? num(s.price_inr) : num(l.price_store_inr);
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ background: C.surface, border: `1px solid ${selected ? C.gold : C.border}`, borderRadius: 12, overflow: "hidden", display: "flex", flexDirection: "column",
        boxShadow: hover ? "0 6px 22px rgba(40,30,15,.10)" : "0 1px 2px rgba(40,30,15,.04)", transition: "box-shadow .2s, transform .2s", transform: hover ? "translateY(-2px)" : "none" }}>
      <div onClick={() => onOpen(l, "photos")} onMouseEnter={() => { if (l.video) vidT.current = setTimeout(() => setVid(true), 250); }} onMouseLeave={stopVid}
        style={{ position: "relative", aspectRatio: "1", background: C.card, cursor: "pointer", overflow: "hidden" }}>
        {imgs[i] ? <img src={thumb(imgs[i])} alt="" loading="lazy" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", display: "block", opacity: sold ? .55 : 1 }} />
          : <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 34, opacity: .5 }}>💎</div>}
        {vid && <video src={l.video} autoPlay muted loop playsInline onPlaying={() => setVidShown(true)} onError={stopVid}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", display: "block", pointerEvents: "none",
            opacity: vidShown ? (sold ? .55 : 1) : 0, transition: "opacity .2s" }} />}
        <label onClick={e => e.stopPropagation()} style={{ position: "absolute", top: 8, left: 8, width: 24, height: 24, borderRadius: 6, background: "rgba(255,255,255,.9)",
          display: hover || selected ? "flex" : "none", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
          <input type="checkbox" checked={selected} onChange={() => onSelect(l.id)} style={{ margin: 0, cursor: "pointer" }} />
        </label>
        <div style={{ position: "absolute", top: 8, right: 8, display: "flex", gap: 4 }}>
          {l.video && <span style={pill("#fff", "rgba(20,15,8,.65)")}>▶</span>}
          {l.type === "unique" ? <span style={pill(C.blue, "rgba(255,255,255,.92)")}>1 of 1</span> : <span style={pill(C.amber, "rgba(255,255,255,.92)")}>Qty {l.qty || "—"}</span>}
        </div>
        {/* Sold reads at a glance across the grid: a red stamp, not another dark chip. */}
        {sold && <span style={{ position: "absolute", bottom: 10, left: 10, fontSize: 12.5, fontWeight: 900, letterSpacing: 1.4, color: "#fff", background: "#E0362C",
          padding: "4px 11px", borderRadius: 6, boxShadow: "0 2px 8px rgba(224,54,44,.45)", textTransform: "uppercase" }}>✓ Sold</span>}
        {imgs.length > 1 && hover && <>
          <button onClick={e => { e.stopPropagation(); stopVid(); setI(x => (x - 1 + imgs.length) % imgs.length); }} style={arrow("left")}>‹</button>
          <button onClick={e => { e.stopPropagation(); stopVid(); setI(x => (x + 1) % imgs.length); }} style={arrow("right")}>›</button>
        </>}
        {imgs.length > 1 && !vidShown && <span style={{ position: "absolute", bottom: 8, right: 8, ...pill("#fff", "rgba(20,15,8,.55)") }}>{i + 1}/{imgs.length}</span>}
      </div>
      <div style={{ padding: "10px 11px 11px", display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
        <div onClick={() => onOpen(l, "platforms")} style={{ display: "flex", gap: 3, flexWrap: "wrap", cursor: "pointer" }} title="Platforms — click to manage">
          {PLAT.map(p => {
            const st = statusOf(l, p.key, facts);
            const on = st === "active", draft = st && st !== "active" && st !== "deleted";
            // Filled = live and on sale; dashed = there but not on sale (a draft, or sold out); faint = not on it.
            const expired = p.key === "etsy" && draft && st !== "sold" && l.platforms?.etsy?.expired;
            return <span key={p.key} title={`${p.label}: ${on ? "live" : st === "sold" ? "sold" : expired ? "expired — renew it (Renew tab)" : draft ? "draft — there, not on sale" : "not listed"}`}
              style={{ fontSize: 9.5, fontWeight: 700, padding: "2px 6px", borderRadius: 10, letterSpacing: .2,
              background: on ? p.color : "transparent", color: on ? "#fff" : draft ? p.color : C.inkFaint,
              border: `1px ${draft ? "dashed" : "solid"} ${on ? p.color : draft ? p.color : C.border}`, opacity: on || draft ? 1 : .7 }}>{p.short}{draft ? (st === "sold" ? " · sold" : expired ? " · expired" : " · draft") : ""}</span>;
          })}
        </div>
        <div onClick={() => onOpen(l, "platforms")} style={{ cursor: "pointer" }}>
          <div style={{ fontSize: 13, fontWeight: 650, color: C.ink, lineHeight: 1.3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", minHeight: 34 }}>{l.title || "Untitled listing"}</div>
          <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {[l.material, l.shape, l.sku || l.listing_order_id].filter(Boolean).join(" · ")}
          </div>
        </div>
        <Stats l={l} sales={sales} etsy={etsy} etsyAt={etsyAt} />
        {onLocation && <LocationCell value={where} missing={!where && needsLocation(l, sold)} onSave={v => onLocation(l, v)} />}
        <div style={{ display: "flex", gap: 5, marginTop: "auto" }}>
          <PriceCell flag="🇺🇸 USA" cur="$" value={usd} title="USA price on eartheditions.co — click to change" onSave={v => onPrice(l, "price_store", v)} />
          <PriceCell flag="🇮🇳 India" cur="₹" value={inr} title="India price on eartheditions.co — click to change" onSave={v => onPrice(l, "price_store_inr", v)} />
          <PriceCell flag="🏷️ Etsy" cur="₹" value={num(l.price_etsy)} title="Etsy price — click to change" onSave={v => onPrice(l, "price_etsy", v)} />
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => onEdit(l)} style={btn()}>Edit</button>
          <button onClick={() => onOpen(l, "platforms")} style={btn(true)}>Manage</button>
        </div>
      </div>
    </div>
  );
}
/* The card's numbers: Etsy views and favourites, what it has sold and for
   how much, when it last sold; then its dates: created, last renewed and when
   it ends on Etsy. The details, and where each date comes from, are in the
   tooltip. */
const day = ms => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" });
function Stats({ l, sales, etsy, etsyAt }) {
  const now = Date.now();
  const money = sales ? Object.entries(sales.money).filter(([, v]) => v > 0).map(([c, v]) => shortMoney(v, c)).join(" + ") : "";
  const bits = [
    etsy && { k: "views", t: `👁 ${etsy.views.toLocaleString("en-IN")}`, tip: `${etsy.views.toLocaleString("en-IN")} views on Etsy` },
    etsy && { k: "favs", t: `♥ ${etsy.favs}`, tip: `${etsy.favs} favourite${etsy.favs === 1 ? "" : "s"} on Etsy` },
    sales ? { k: "sold", t: `${sales.units} sold${money ? ` · ${money}` : ""}`, strong: true,
        tip: `${sales.units} sold (${[...sales.where].map(w => PLATFORM_NAME[w] || w).join(", ") || "orders"})${money ? `, ${money}` : ""}${sales.last ? `, last on ${day(sales.last)}` : ""}` }
      : { k: "sold", t: "no sales yet", tip: "No orders from this listing in Orders" },
    sales?.last && { k: "last", t: `last ${ageOf(now - sales.last)} ago`, tip: "" },
  ].filter(Boolean);
  /* Its dates: Etsy's, from this device's copy of the shop when it's newer,
     else as the Etsy sync keeps them on the listing; else the earliest the
     ERP knows. */
  const et = l.platforms?.etsy || {}, at = v => Date.parse(v || "") || 0;
  const created = etsy?.created || at(et.first_listed_at) || firstListed(l);
  const renewed = etsy ? (etsy.renewed > etsy.created + 864e5 ? etsy.renewed : 0) : at(et.renewed_at);
  const ends = (etsy ? etsy.state === "active" && etsy.ends : et.status === "active" && at(et.ends_at)) || 0;
  const dates = [created && `Created ${day(created)}`, renewed && `renewed ${day(renewed)}`, ends && `${ends < now ? "ended" : "ends"} ${day(ends)}`].filter(Boolean).join(" · ");
  const tip = [...bits.map(b => b.tip).filter(Boolean),
    created ? `Created ${day(created)}${etsy?.created || et.first_listed_at ? " on Etsy" : " — the ERP's earliest date for it"}` : "",
    renewed ? `last renewed ${day(renewed)}` : "", ends ? `its Etsy term ${ends < now ? "ended" : "ends"} ${day(ends)}` : "",
    etsy && etsyAt ? `Etsy numbers as of ${day(etsyAt)} (the Etsy tab's last sync)` : ""].filter(Boolean).join(" · ");
  return (
    <div title={tip} style={{ display: "grid", gap: 2, fontSize: 11, lineHeight: 1.35 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 8px", color: C.inkMid }}>
        {bits.map(b => <span key={b.k} style={{ whiteSpace: "nowrap", fontWeight: b.strong ? 700 : 500, color: b.strong ? C.green : b.k === "sold" ? C.inkFaint : C.inkMid }}>{b.t}</span>)}
      </div>
      {dates && <div style={{ color: C.inkFaint, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{dates}</div>}
    </div>
  );
}
const pill = (color, bg) => ({ fontSize: 10, fontWeight: 800, color, background: bg, padding: "2px 7px", borderRadius: 10, letterSpacing: .3 });
const arrow = side => ({ position: "absolute", top: "50%", [side]: 6, transform: "translateY(-50%)", width: 28, height: 28, borderRadius: 14, border: "none",
  background: "rgba(255,255,255,.9)", fontSize: 18, lineHeight: "26px", cursor: "pointer", color: "#141210", padding: 0, boxShadow: "0 1px 4px rgba(0,0,0,.2)" });
const btn = (dark = false) => ({ flex: 1, padding: "7px 0", borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: "pointer",
  border: `1px solid ${dark ? C.ink : C.border}`, background: dark ? C.ink : C.surface, color: dark ? "#FAF0DC" : C.ink });

/* ── the drawer: photos, platforms, every price ────────────────────────── */
function Drawer({ l, where, sold, onStory, tab, setTab, store, onClose, onPrice, onSavePhotos, onEdit, onMarkSold, onDelete, renderManage }) {
  const [imgs, setImgs] = useState(() => (l.images || []).filter(u => typeof u === "string"));
  const [editIdx, setEditIdx] = useState(null);
  const [busy, setBusy] = useState(false);
  const [story, setStory] = useState(false);
  useEffect(() => { setImgs((l.images || []).filter(u => typeof u === "string")); }, [l.id, l.images]);
  const changed = JSON.stringify(imgs) !== JSON.stringify((l.images || []).filter(u => typeof u === "string"));
  const s = store?.[l.id];
  const val = f => f === "price_store" && s ? num(s.price) : f === "price_store_inr" && s ? num(s.price_inr) : num(l[f]);
  const move = (i, d) => setImgs(a => { const b = [...a]; const j = i + d; if (j < 0 || j >= b.length) return a; [b[i], b[j]] = [b[j], b[i]]; return b; });
  useEffect(() => { const k = e => e.key === "Escape" && editIdx == null && !story && onClose(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose, editIdx, story]);
  return (
    <div onMouseDown={e => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, zIndex: 1200, background: "rgba(20,15,8,.35)", display: "flex", justifyContent: "flex-end" }}>
      <div style={{ width: "100%", maxWidth: 620, height: "100%", background: C.bg, display: "flex", flexDirection: "column", boxShadow: "-12px 0 40px rgba(0,0,0,.18)" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "14px 18px", borderBottom: `1px solid ${C.border}`, background: C.surface }}>
          {imgs[0] && <img src={thumb(imgs[0], 340)} alt="" style={{ width: 46, height: 46, borderRadius: 8, objectFit: "cover" }} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: serif, fontSize: 20, fontWeight: 600, color: C.ink, lineHeight: 1.15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.title}</div>
            <div style={{ fontSize: 11, color: C.inkFaint }}>{[where && `📍 ${where}`, l.material, l.shape, l.sku || l.listing_order_id, l._source === "etsy-import" ? "imported from Etsy" : "made in the ERP"].filter(Boolean).join(" · ")}</div>
          </div>
          <button onClick={onClose} style={{ border: "none", background: "none", fontSize: 24, cursor: "pointer", color: C.inkMid }}>×</button>
        </div>
        <div style={{ display: "flex", gap: 4, padding: "8px 14px 0", borderBottom: `1px solid ${C.border}`, background: C.surface }}>
          {[["platforms", "Platforms"], ["prices", "Prices"], ["photos", `Photos (${imgs.length}${l.video ? " + video" : ""})`]].map(([k, t]) => (
            <button key={k} onClick={() => setTab(k)} style={{ padding: "9px 12px", border: "none", background: "none", cursor: "pointer", fontSize: 13,
              fontWeight: tab === k ? 700 : 500, color: tab === k ? C.ink : C.inkMid, borderBottom: `2.5px solid ${tab === k ? C.gold : "transparent"}`, marginBottom: -1 }}>{t}</button>
          ))}
          <div style={{ flex: 1 }} />
          <button onClick={() => onEdit(l)} style={{ ...btn(), flex: "none", padding: "5px 12px", margin: "4px 0" }}>Full editor</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          {tab === "platforms" && renderManage(l)}
          {tab === "prices" && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
              {PRICES.map(p => {
                const linked = !!(l.platforms?.[p.sync]?.status && l.platforms[p.sync].status !== "deleted");
                return (
                  <div key={p.field} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 10 }}>
                    <PriceCell big flag={`${p.flag} ${p.label}`} cur={p.cur} value={val(p.field)} onSave={v => onPrice(l, p.field, v)} />
                    <div style={{ fontSize: 10.5, color: C.inkFaint, marginTop: 6, paddingLeft: 8 }}>{linked ? `Updates ${p.label.split(" · ").pop()} on save` : "Saved on the listing; used when it's posted there"}</div>
                  </div>
                );
              })}
            </div>
          )}
          {tab === "photos" && (
            <>
              <div style={{ fontSize: 12, color: C.inkMid, marginBottom: 10 }}>★ makes the cover · arrows reorder · ✎ opens the photo editor · × removes. Save to update every platform it's on. Add new photos, or change the video, in the full editor.</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
                {!imgs.length && l.video && <VideoTile url={l.video} />}
                {imgs.map((u, i) => (
                  <Fragment key={u + i}>
                  <div style={{ position: "relative", aspectRatio: "1", borderRadius: 9, overflow: "hidden", background: C.card, outline: i === 0 ? `2.5px solid ${C.gold}` : "none", outlineOffset: -2.5 }}>
                    <img src={thumb(u, 340)} alt="" onError={e => { if (e.currentTarget.src !== u) e.currentTarget.src = u; }} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    <div style={{ position: "absolute", top: 5, right: 5, display: "flex", gap: 4 }}>
                      {i > 0 && <button title="Make cover" onClick={() => setImgs(a => [a[i], ...a.filter((_, j) => j !== i)])} style={round}>★</button>}
                      <button title="Edit photo" onClick={() => setEditIdx(i)} style={round}>✎</button>
                      <button title="Remove" onClick={() => setImgs(a => a.filter((_, j) => j !== i))} style={round}>×</button>
                    </div>
                    <div style={{ position: "absolute", bottom: 5, left: 5, display: "flex", gap: 4 }}>
                      {i > 0 && <button title="Move left" onClick={() => move(i, -1)} style={round}>‹</button>}
                      {i < imgs.length - 1 && <button title="Move right" onClick={() => move(i, 1)} style={round}>›</button>}
                    </div>
                  </div>
                  {/* Second, after the cover — where Etsy puts it */}
                  {i === 0 && l.video && <VideoTile url={l.video} />}
                  </Fragment>
                ))}
              </div>
              {editIdx != null && imgs[editIdx] && (
                <Suspense fallback={null}>
                  <PhotoEditor url={imgs[editIdx]} original={l.original_images?.[imgs[editIdx]] || ""} photos={imgs} index={editIdx}
                    onSave={u => setImgs(a => a.map((x, j) => (j === editIdx ? u : x)))}
                    onSaveAll={next => setImgs(() => next)}
                    onAdd={u => { setImgs(a => [...a.slice(0, editIdx + 1), u, ...a.slice(editIdx + 1)]); setEditIdx(editIdx + 1); }}
                    onClose={() => setEditIdx(null)} />
                </Suspense>
              )}
            </>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, padding: "12px 16px", borderTop: `1px solid ${C.border}`, background: C.surface, alignItems: "center" }}>
          <button onClick={() => { onClose(); onMarkSold(l); }} style={{ ...btn(), flex: "none", padding: "8px 14px", background: C.greenBg, color: C.green, borderColor: C.green + "40" }}>Mark sold</button>
          <button onClick={() => setStory(true)} disabled={!imgs.length} title={imgs.length ? "Just listed / Sold story for Instagram" : "Add a photo first"}
            style={{ ...btn(), flex: "none", padding: "8px 14px", opacity: imgs.length ? 1 : .5 }}>Story</button>
          {/* The asking belongs with the deleting: handleDelete knows which
              platforms this piece is actually on and names them. A second
              confirm here would ask twice and, worse, still promise that the
              platforms are left alone — which is no longer true. */}
          <button onClick={() => { onClose(); onDelete(l.id); }} style={{ ...btn(), flex: "none", padding: "8px 14px", color: C.red }}>Delete</button>
          <div style={{ flex: 1 }} />
          {tab === "photos" && changed && (
            <button disabled={busy} onClick={async () => { setBusy(true); try { await onSavePhotos(l, imgs); } finally { setBusy(false); } }}
              style={{ ...btn(true), flex: "none", padding: "9px 18px", opacity: busy ? .6 : 1 }}>{busy ? "Saving…" : "Save photos"}</button>
          )}
        </div>
      </div>
      {story && <Suspense fallback={null}><StoryStudio listing={l} sold={sold} onShared={k => onStory?.(k, l)} onClose={() => setStory(false)} /></Suspense>}
    </div>
  );
}
/* The listing's one video among its photos: plays muted while the pointer is on
   it, with controls for sound and scrubbing. */
function VideoTile({ url }) {
  const [bad, setBad] = useState(false);
  return (
    <div style={{ position: "relative", aspectRatio: "1", borderRadius: 9, overflow: "hidden", background: "#141210" }}>
      {bad
        ? <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, padding: 10, textAlign: "center", fontSize: 12, color: "#fff" }}>
            The video didn't load
            <a href={url} target="_blank" rel="noreferrer" style={{ color: "#fff", fontWeight: 700 }}>Open it ↗</a>
          </div>
        : <video src={`${url}#t=0.1`} muted loop playsInline controls preload="metadata" onError={() => setBad(true)}
            onMouseEnter={e => e.currentTarget.play().catch(() => {})} onMouseLeave={e => e.currentTarget.pause()}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />}
      <span style={{ position: "absolute", top: 5, left: 5, ...pill("#fff", "rgba(20,15,8,.65)") }}>▶ Video</span>
    </div>
  );
}
const round = { width: 26, height: 26, borderRadius: 13, border: "none", background: "rgba(20,15,8,.7)", color: "#fff", fontSize: 13, cursor: "pointer", padding: 0, lineHeight: "26px" };

/* ── the whole view ────────────────────────────────────────────────────── */
const SORTS = {
  // By when a piece was first listed: an Etsy renewal doesn't make it new.
  new: ["Newest", (a, b) => listedAt(b) - listedAt(a)],
  old: ["Oldest", (a, b) => (listedAt(a) || Infinity) - (listedAt(b) || Infinity)],
  etsyHigh: ["Etsy price ↓", (a, b) => (+b.price_etsy || 0) - (+a.price_etsy || 0)],
  etsyLow: ["Etsy price ↑", (a, b) => (+a.price_etsy || 1e12) - (+b.price_etsy || 1e12)],
  az: ["A–Z", (a, b) => String(a.title || "").localeCompare(String(b.title || ""))],
  sold: ["Most sold", (a, b, c) => (c.sales.get(b.id)?.units || 0) - (c.sales.get(a.id)?.units || 0) || listedAt(b) - listedAt(a)],
  views: ["Most viewed on Etsy", (a, b, c) => (etsyOf(b, c.etsy)?.views || 0) - (etsyOf(a, c.etsy)?.views || 0)],
};

// Checkbox filters: within a group, any ticked option matches; groups combine.
const toggle = (set, v) => { const n = new Set(set); n.has(v) ? n.delete(v) : n.add(v); return n; };

function Group({ title, children, open: startOpen = true }) {
  const [open, setOpen] = useState(startOpen);
  return (
    <div style={{ borderBottom: `1px solid ${C.border}`, padding: "12px 0" }}>
      <button onClick={() => setOpen(o => !o)} style={{ display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center", border: "none", background: "none", padding: 0, cursor: "pointer",
        fontSize: 11, fontWeight: 800, letterSpacing: .8, textTransform: "uppercase", color: C.inkMid }}>{title}<span style={{ fontSize: 12 }}>{open ? "−" : "+"}</span></button>
      {open && <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 8 }}>{children}</div>}
    </div>
  );
}
function Check({ checked, onChange, label, count, color }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.ink, cursor: "pointer", padding: "4px 2px", borderRadius: 6 }}>
      <input type="checkbox" checked={checked} onChange={onChange} style={{ margin: 0, width: 15, height: 15, accentColor: "#141210", cursor: "pointer" }} />
      {color && <span style={{ width: 8, height: 8, borderRadius: 4, background: color, flex: "none" }} />}
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: checked ? 700 : 400 }}>{label}</span>
      {count != null && <span style={{ fontSize: 11, color: C.inkFaint }}>{count}</span>}
    </label>
  );
}

export default function ListingGrid({ listings, orders, stock = [], loadStoreFacts, tradeFacts: trade = null, onEdit, onPrice, onLocation, onBulkMove, onSavePhotos, onMarkSold, onDelete, onBulkDelete, renderManage, onBulkPrice, onBulkPricePost }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState(new Set());   // live | notlive | sold
  const [liveOn, setLiveOn] = useState(new Set());   // platform keys: live on any of these
  const [notOn, setNotOn] = useState(new Set());     // platform keys: not on any of these
  const [types, setTypes] = useState(new Set());     // unique | repeatable
  const [stones, setStones] = useState(new Set());
  const [stoneQ, setStoneQ] = useState("");
  const [allStones, setAllStones] = useState(false);
  const [erpOnly, setErpOnly] = useState(false);
  const [issues, setIssues] = useState(new Set());   // noprice | nophotos | nostore | noloc
  const [locs, setLocs] = useState(new Set());       // lower-cased places; "" = none
  const [locQ, setLocQ] = useState("");
  const [sort, setSort] = useState("new");
  const [cols, setCols] = useState(() => { try { return +localStorage.getItem("lm-grid-cols") || 0; } catch { return 0; } });
  const [panel, setPanel] = useState(() => typeof window === "undefined" || window.innerWidth >= 900);
  const [shown, setShown] = useState(60);
  const [open, setOpen] = useState(null);           // { id, tab }
  const [store, setStore] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [pricePost, setPricePost] = useState(false);
  const more = useRef(null);

  // Left null when a load fails, so the pills fall back to the listing's own note. The trade
  // site's records come in as a prop: Listing Manager's shared copy, re-read after every post.
  const refreshStore = () => loadStoreFacts().then(setStore).catch(() => {});
  useEffect(() => { refreshStore(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  /* The store's records decide its pill, and they were read once, when the
     grid opened, so a piece put on the store after that stayed grey until a
     reload. Putting one on (or taking it off) from here changes its note, so
     a change in any note reads the store again. */
  const storeNotes = useMemo(() => listings.map(l => `${l.id}:${l.platforms?.store?.status || ""}:${l.platforms?.store?.live_at || ""}`).join("|"), [listings]);
  const notesSeen = useRef(storeNotes);
  useEffect(() => {
    if (notesSeen.current === storeNotes) return;
    notesSeen.current = storeNotes;
    refreshStore();
  }, [storeNotes]); // eslint-disable-line react-hooks/exhaustive-deps
  const facts = useMemo(() => ({ store, trade }), [store, trade]);
  const sales = useMemo(() => salesByListing(orders), [orders]);
  const etsy = useMemo(etsyOnDevice, []);
  useEffect(() => { try { localStorage.setItem("lm-grid-cols", String(cols)); } catch {} }, [cols]);

  const materials = useMemo(() => {
    // "Amethyst" and "amethyst" are one stone; the capitalised spelling names it.
    const m = new Map();
    for (const l of listings) {
      const raw = String(l.material || "").trim(), k = raw.toLowerCase();
      if (!k) continue;
      const e = m.get(k) || { n: 0, label: raw };
      e.n++; if (/^[A-Z]/.test(raw) && !/^[A-Z]/.test(e.label)) e.label = raw;
      m.set(k, e);
    }
    return [...m.entries()].map(([k, e]) => [k, e.n, e.label]).sort((a, b) => b[1] - a[1]);
  }, [listings]);
  const whereOf = useMemo(() => new Map(listings.map(l => [l.id, locationOf(l, stock)])), [listings, stock]);
  const places = useMemo(() => {
    const m = new Map();
    for (const l of listings) { const w = whereOf.get(l.id), k = w.toLowerCase(); const e = m.get(k) || { n: 0, label: w || "No location" }; e.n++; m.set(k, e); }
    return [...m.entries()].sort((a, b) => (a[0] === "") - (b[0] === "") || b[1].n - a[1].n);
  }, [listings, whereOf]);
  const allPlaces = useMemo(() => knownLocations(listings, stock), [listings, stock]);
  const lost = l => !whereOf.get(l.id) && needsLocation(l, soldOut(l, orders, facts));
  const counts = useMemo(() => ({
    // Not live leaves out what's sold: those have their own filter.
    notlive: listings.filter(l => !isLive(l, facts) && !soldOut(l, orders, facts)).length,
    live: listings.filter(l => isLive(l, facts)).length,
    sold: listings.filter(l => soldOut(l, orders, facts)).length,
    unique: listings.filter(l => l.type === "unique").length,
    erp: listings.filter(l => l._source !== "etsy-import").length,
    noprice: listings.filter(l => !(+l.price_etsy > 0)).length,
    nophotos: listings.filter(l => !(l.images || []).length).length,
    nostore: listings.filter(l => !statusOf(l, "store", facts)).length,
    noloc: listings.filter(lost).length,
    plat: Object.fromEntries(PLAT.map(p => [p.key, listings.filter(l => statusOf(l, p.key, facts) === "active").length])),
  }), [listings, orders, whereOf, facts]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return listings.filter(l => {
      if (status.size) {
        const live = isLive(l, facts), sold = soldOut(l, orders, facts);
        if (!((status.has("live") && live) || (status.has("notlive") && !live && !sold) || (status.has("sold") && sold))) return false;
      }
      if (liveOn.size && ![...liveOn].some(k => statusOf(l, k, facts) === "active")) return false;
      if (notOn.size && [...notOn].some(k => statusOf(l, k, facts) === "active")) return false;
      if (types.size && !types.has(l.type)) return false;
      if (stones.size && !stones.has(String(l.material || "").trim().toLowerCase())) return false;
      if (erpOnly && l._source === "etsy-import") return false;
      if (locs.size && !locs.has(whereOf.get(l.id).toLowerCase())) return false;
      if (issues.size) {
        const hit = (issues.has("noprice") && !(+l.price_etsy > 0)) || (issues.has("nophotos") && !(l.images || []).length) || (issues.has("nostore") && !statusOf(l, "store", facts)) || (issues.has("noloc") && lost(l));
        if (!hit) return false;
      }
      if (terms.length) {
        const hay = [l.title, l.material, l.shape, l.sku, l.listing_order_id, l.origin, l.productType, whereOf.get(l.id), l.etsy_title, l.ebay_title, l.trade_title, l.store_title, l.shopify_title, Array.isArray(l.tags) ? l.tags.join(" ") : l.tags].filter(Boolean).join(" ").toLowerCase();
        if (!terms.every(t => hay.includes(t))) return false;
      }
      return true;
    }).sort((a, b) => SORTS[sort][1](a, b, { sales, etsy }));
  }, [listings, orders, q, status, liveOn, notOn, types, stones, erpOnly, issues, sort, locs, whereOf, facts, sales, etsy]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setShown(60); }, [q, status, liveOn, notOn, types, stones, erpOnly, issues, sort, locs]);
  // Load more as the bottom comes into view.
  useEffect(() => {
    const el = more.current; if (!el) return;
    const io = new IntersectionObserver(es => { if (es[0].isIntersecting) setShown(n => n + 60); }, { rootMargin: "600px" });
    io.observe(el); return () => io.disconnect();
  }, [list.length, shown]);

  const price = async (l, field, v) => { await onPrice(l, field, v); if (field.startsWith("price_store")) refreshStore(); };
  const openL = open && listings.find(l => l.id === open.id);
  const toggleSel = id => setSel(s => toggle(s, id));
  const selected = list.filter(l => sel.has(l.id));
  // Stories waiting to be posted: pieces that went live or sold this week.
  const stories = useStoriesDone();
  const nFilters = status.size + liveOn.size + notOn.size + types.size + stones.size + issues.size + locs.size + (erpOnly ? 1 : 0);
  const clearAll = () => { setStatus(new Set()); setLiveOn(new Set()); setNotOn(new Set()); setTypes(new Set()); setStones(new Set()); setIssues(new Set()); setLocs(new Set()); setErpOnly(false); setQ(""); };
  const placeList = places.filter(([k, e]) => !locQ || e.label.toLowerCase().includes(locQ.toLowerCase()));
  const stoneList = materials.filter(([k]) => !stoneQ || k.includes(stoneQ.toLowerCase()));
  const chip = on => ({ padding: "6px 12px", borderRadius: 18, fontSize: 12.5, fontWeight: on ? 700 : 500, cursor: "pointer", whiteSpace: "nowrap",
    border: `1px solid ${on ? C.ink : C.border}`, background: on ? C.ink : C.surface, color: on ? "#FAF0DC" : C.inkMid });

  return (
    <div>
      {pricePost && <PricePost rows={selected} facts={facts} onClose={() => setPricePost(false)}
        onRun={async (rows, post, step) => { const r = await onBulkPricePost(rows, post, step); refreshStore(); return r; }} />}
      {/* search, sort, layout */}
      <div style={{ position: "sticky", top: 0, zIndex: 20, background: C.bg, padding: "10px 0 12px", marginBottom: 8, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={() => setPanel(p => !p)} style={chip(panel)}>☰ Filters{nFilters ? ` · ${nFilters}` : ""}</button>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={`Search ${listings.length} listings — title, stone, SKU, tag…`}
            style={{ ...FI(), flex: "1 1 260px", maxWidth: 460, borderRadius: 20, padding: "8px 14px" }} />
          <select value={sort} onChange={e => setSort(e.target.value)} style={{ ...FI(), width: "auto", padding: "7px 10px", fontSize: 12.5, borderRadius: 18 }}>{Object.entries(SORTS).map(([k, [t]]) => <option key={k} value={k}>Sort: {t}</option>)}</select>
          {nFilters > 0 && <button onClick={clearAll} style={{ ...chip(false), color: C.red }}>Clear filters</button>}
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: C.inkFaint }}>{list.length} of {listings.length}</span>
          <div style={{ display: "flex", border: `1px solid ${C.border}`, borderRadius: 18, overflow: "hidden" }} title="Cards per row">
            {[[0, "Auto"], [4, "4"], [5, "5"]].map(([n, t]) => <button key={n} onClick={() => setCols(n)} style={{ padding: "5px 10px", border: "none", fontSize: 12, cursor: "pointer", background: cols === n ? C.ink : C.surface, color: cols === n ? "#FAF0DC" : C.inkMid }}>{t}</button>)}
          </div>
        </div>
        {selected.length > 0 && (
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10, padding: "8px 12px", background: C.amberBg, borderRadius: 10, fontSize: 12.5, flexWrap: "wrap" }}>
            <b>{selected.length} selected</b>
            {onBulkPricePost && <button onClick={() => setPricePost(true)} style={{ ...chip(true) }}>💲 Price &amp; post…</button>}
            <button onClick={() => onBulkPrice(selected).then(refreshStore)} style={chip(false)}>Change prices by %…</button>
            {onBulkMove && <button onClick={() => onBulkMove(selected)} style={chip(false)}>📍 Move to…</button>}
            <button onClick={() => setSel(new Set(list.map(l => l.id)))} style={chip(false)}>Select all {list.length}</button>
            <button onClick={() => setSel(new Set())} style={chip(false)}>Clear selection</button>
            {onBulkDelete && (
              /* Last, apart from the others, and in red: the one button here
                 that cannot be undone should not sit under the thumb next to
                 "Move to…". The selection clears only once they are gone. */
              <button onClick={async () => { await onBulkDelete(selected); setSel(new Set()); }}
                style={{ ...chip(false), marginLeft: "auto", color: C.red, border: `1px solid ${C.red}55` }}>
                Delete {selected.length}…
              </button>
            )}
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 22, alignItems: "flex-start" }}>
        {/* checkbox filters */}
        {panel && (
          <aside style={{ width: 230, flex: "none", position: "sticky", top: 70, maxHeight: "calc(100vh - 90px)", overflowY: "auto", paddingRight: 4 }}>
            <Group title="Show">
              <Check checked={status.has("live")} onChange={() => setStatus(s => toggle(s, "live"))} label="Live" count={counts.live} color={C.green} />
              <Check checked={status.has("notlive")} onChange={() => setStatus(s => toggle(s, "notlive"))} label="Not live" count={counts.notlive} />
              <Check checked={status.has("sold")} onChange={() => setStatus(s => toggle(s, "sold"))} label="Sold" count={counts.sold} />
              <Check checked={erpOnly} onChange={() => setErpOnly(v => !v)} label="Posted from ERP" count={counts.erp} color={C.gold} />
            </Group>
            <Group title="Live on">
              {PLAT.map(p => <Check key={p.key} checked={liveOn.has(p.key)} onChange={() => setLiveOn(s => toggle(s, p.key))} label={p.label} count={counts.plat[p.key]} color={p.color} />)}
            </Group>
            <Group title="Not on" open={false}>
              {PLAT.map(p => <Check key={p.key} checked={notOn.has(p.key)} onChange={() => setNotOn(s => toggle(s, p.key))} label={p.label} count={listings.length - counts.plat[p.key]} color={p.color} />)}
            </Group>
            <Group title="Type">
              <Check checked={types.has("unique")} onChange={() => setTypes(s => toggle(s, "unique"))} label="One of a kind" count={counts.unique} />
              <Check checked={types.has("repeatable")} onChange={() => setTypes(s => toggle(s, "repeatable"))} label="Repeatable" count={listings.length - counts.unique} />
            </Group>
            <Group title={`Stone${stones.size ? ` · ${stones.size}` : ""}`}>
              <input value={stoneQ} onChange={e => setStoneQ(e.target.value)} placeholder="Find a stone…" style={{ ...FI(), padding: "5px 9px", fontSize: 12, marginBottom: 4 }} />
              {(allStones || stoneQ ? stoneList : stoneList.slice(0, 12)).map(([k, n, label]) => <Check key={k} checked={stones.has(k)} onChange={() => setStones(s => toggle(s, k))} label={label} count={n} />)}
              {!stoneQ && stoneList.length > 12 && <button onClick={() => setAllStones(v => !v)} style={{ border: "none", background: "none", color: C.inkMid, fontSize: 12, textAlign: "left", padding: "4px 2px", cursor: "pointer", textDecoration: "underline" }}>{allStones ? "Show fewer" : `Show all ${stoneList.length}`}</button>}
            </Group>
            <Group title={`Location${locs.size ? ` · ${locs.size}` : ""}`}>
              {places.length > 8 && <input value={locQ} onChange={e => setLocQ(e.target.value)} placeholder="Find a place…" style={{ ...FI(), padding: "5px 9px", fontSize: 12, marginBottom: 4 }} />}
              {(locQ ? placeList : placeList.slice(0, 12)).map(([k, e]) => <Check key={k || "_none"} checked={locs.has(k)} onChange={() => setLocs(s => toggle(s, k))} label={e.label} count={e.n} color={k ? null : C.red} />)}
              {!locQ && placeList.length > 12 && <div style={{ fontSize: 11, color: C.inkFaint, padding: "2px" }}>{placeList.length - 12} more — search to find them</div>}
            </Group>
            <Group title="Needs attention" open={counts.noloc > 0}>
              <Check checked={issues.has("noloc")} onChange={() => setIssues(s => toggle(s, "noloc"))} label="One of a kind, no location" count={counts.noloc} color={C.red} />
              <Check checked={issues.has("noprice")} onChange={() => setIssues(s => toggle(s, "noprice"))} label="No Etsy price" count={counts.noprice} color={C.red} />
              <Check checked={issues.has("nophotos")} onChange={() => setIssues(s => toggle(s, "nophotos"))} label="No photos" count={counts.nophotos} color={C.red} />
              <Check checked={issues.has("nostore")} onChange={() => setIssues(s => toggle(s, "nostore"))} label="Not on Earth Editions" count={counts.nostore} color={C.amber} />
            </Group>
          </aside>
        )}

        {/* grid */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "grid", gap: 14, gridTemplateColumns: cols ? `repeat(${cols}, minmax(0, 1fr))` : "repeat(auto-fill, minmax(230px, 1fr))" }}>
            {list.slice(0, shown).map(l => (
              <Tile key={l.id} l={l} store={store} facts={facts} orders={orders} stock={stock} sales={sales.get(l.id)} etsy={etsyOf(l, etsy)} etsyAt={etsy.at} selected={sel.has(l.id)} onSelect={toggleSel}
                onOpen={(x, tab) => setOpen({ id: x.id, tab })} onEdit={onEdit} onPrice={price} onLocation={onLocation} />
            ))}
          </div>
          <datalist id="lm-grid-locs">{allPlaces.map(p => <option key={p.label} value={p.label} />)}</datalist>
          {!list.length && <div style={{ textAlign: "center", padding: "60px 0", color: C.inkFaint }}>No listings match these filters.</div>}
          {shown < list.length && <div ref={more} style={{ textAlign: "center", padding: 24, color: C.inkFaint, fontSize: 12 }}>Loading more…</div>}
        </div>
      </div>

      {openL && (
        <Drawer l={openL} where={whereOf.get(openL.id)} sold={soldOut(openL, orders, facts)} onStory={(k, x) => stories.mark(k, x, "posted")} tab={open.tab} setTab={t => setOpen(o => ({ ...o, tab: t }))} store={store}
          onClose={() => setOpen(null)} onPrice={price} onEdit={x => { setOpen(null); onEdit(x); }}
          onSavePhotos={onSavePhotos} onMarkSold={onMarkSold} onDelete={onDelete} renderManage={renderManage} />
      )}
    </div>
  );
}

/* Price & post: the selected pieces in one table — a price per column for
   each, filled by hand, all at once, or by weight — then live on the
   platforms ticked. */
const gramsOf = l => {
  for (const t of [l.weight, l.title]) {
    const m = String(t || "").replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*(kg|kgs|g|gm|gms|grams?)\b/i);
    if (m) return +m[1] * (/^kg/i.test(m[2]) ? 1000 : 1);
  }
  return null;
};
const PP_COLS = [
  { field: "price_store", label: "USA $", cur: "$" },
  { field: "price_store_inr", label: "India ₹", cur: "₹" },
  { field: "price_etsy", label: "Etsy ₹", cur: "₹" },
  { field: "price_trade", label: "Trade $", cur: "$" },
];
const PP_POST = [["store", "Earth Editions"], ["etsy", "Etsy"], ["trade", "Trade site"]];
function PricePost({ rows, facts, onClose, onRun }) {
  const cur = (l, f) => { const s = facts.store?.[l.id]; return f === "price_store" && s ? num(s.price) : f === "price_store_inr" && s ? num(s.price_inr) : num(l[f]); };
  const [vals, setVals] = useState(() => Object.fromEntries(rows.map(l => [l.id, Object.fromEntries(PP_COLS.map(c => [c.field, cur(l, c.field) ?? ""]))])));
  const [rate, setRate] = useState({});
  const [all, setAll] = useState({});
  const [post, setPost] = useState(() => new Set(["store"]));
  const [busy, setBusy] = useState(0);
  const [failed, setFailed] = useState(null);
  const set = (id, f, v) => setVals(x => ({ ...x, [id]: { ...x[id], [f]: v } }));
  const fillAll = f => { const v = all[f]; if (v === "" || v == null) return; setVals(x => Object.fromEntries(Object.entries(x).map(([id, r]) => [id, { ...r, [f]: v }]))); };
  const byWeight = f => { const r = +rate[f]; if (!(r > 0)) return; setVals(x => Object.fromEntries(Object.entries(x).map(([id, row]) => { const g = gramsOf(rows.find(l => l.id === id)); return [id, g ? { ...row, [f]: Math.round(g * r) } : row]; }))); };
  const noWeight = rows.filter(l => !gramsOf(l)).length;
  const run = async () => {
    const list = rows.map(l => ({ l, prices: Object.fromEntries(PP_COLS.filter(c => vals[l.id][c.field] !== "" && +vals[l.id][c.field] !== cur(l, c.field)).map(c => [c.field, +vals[l.id][c.field]])) }));
    const missing = post.has("store") ? rows.filter(l => !(+vals[l.id].price_store > 0)).length : 0;
    if (missing && !confirm(`${missing} piece${missing === 1 ? " has" : "s have"} no USA price — post anyway?`)) return;
    setBusy(0.001);
    const r = await onRun(list, [...post], n => setBusy(n));
    setBusy(0);
    if (r?.failed?.length) setFailed(r.failed); else if (r) onClose();
  };
  const box = { ...FI(), padding: "5px 7px", fontSize: 12.5, width: 84 };
  return (
    <div onClick={() => !busy && onClose()} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 80, display: "grid", placeItems: "center", padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.surface, borderRadius: 14, width: "min(980px, 100%)", maxHeight: "90vh", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 10 }}>
          <b style={{ fontSize: 16, flex: 1 }}>Price &amp; post · {rows.length} piece{rows.length === 1 ? "" : "s"}</b>
          <button disabled={!!busy} onClick={onClose} style={{ border: "none", background: "transparent", fontSize: 18, cursor: "pointer", color: C.inkMid }}>×</button>
        </div>
        <div style={{ overflow: "auto", padding: "8px 18px" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr style={{ color: C.inkFaint, fontSize: 11, textAlign: "left" }}>
                <th style={{ padding: "6px 4px" }}>Piece</th><th>Weight</th>
                {PP_COLS.map(c => <th key={c.field} style={{ padding: "6px 4px" }}>{c.label}</th>)}
              </tr>
              <tr style={{ background: C.bg }}>
                <td style={{ padding: "6px 4px", fontSize: 11.5, color: C.inkMid }} colSpan={2}>Same for all →<br />Per gram →{noWeight ? <span style={{ color: C.amber }}> ({noWeight} without a weight stay as they are)</span> : null}</td>
                {PP_COLS.map(c => (
                  <td key={c.field} style={{ padding: "6px 4px" }}>
                    <div style={{ display: "flex", gap: 3 }}><input value={all[c.field] ?? ""} onChange={e => setAll(a => ({ ...a, [c.field]: e.target.value }))} onKeyDown={e => e.key === "Enter" && fillAll(c.field)} placeholder={c.cur} style={{ ...box, width: 60 }} /><button onClick={() => fillAll(c.field)} style={{ ...box, width: "auto", cursor: "pointer" }}>↓</button></div>
                    <div style={{ display: "flex", gap: 3, marginTop: 3 }}><input value={rate[c.field] ?? ""} onChange={e => setRate(a => ({ ...a, [c.field]: e.target.value }))} onKeyDown={e => e.key === "Enter" && byWeight(c.field)} placeholder={`${c.cur}/g`} style={{ ...box, width: 60 }} /><button onClick={() => byWeight(c.field)} style={{ ...box, width: "auto", cursor: "pointer" }}>↓</button></div>
                  </td>))}
              </tr>
            </thead>
            <tbody>
              {rows.map(l => (
                <tr key={l.id} style={{ borderTop: `1px solid ${C.border}` }}>
                  <td style={{ padding: "6px 4px", display: "flex", gap: 8, alignItems: "center", minWidth: 220 }}>
                    {(l.images || []).find(u => typeof u === "string") && <img src={(l.images || []).find(u => typeof u === "string")} alt="" style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 6 }} />}
                    <span style={{ lineHeight: 1.3 }}>{l.title}</span>
                  </td>
                  <td style={{ color: C.inkMid, whiteSpace: "nowrap" }}>{gramsOf(l) ? `${gramsOf(l)} g` : "—"}</td>
                  {PP_COLS.map(c => <td key={c.field} style={{ padding: "6px 4px" }}><input inputMode="decimal" value={vals[l.id][c.field]} onChange={e => set(l.id, c.field, e.target.value.replace(/[^\d.]/g, ""))} style={box} /></td>)}
                </tr>))}
            </tbody>
          </table>
          {failed && <div style={{ marginTop: 10, padding: 10, background: C.redBg, color: C.red, borderRadius: 8, fontSize: 12.5 }}>{failed.map(f => <div key={f}>⚠ {f}</div>)}</div>}
        </div>
        <div style={{ padding: "12px 18px", borderTop: `1px solid ${C.border}`, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12.5, fontWeight: 700 }}>Post live on:</span>
          {PP_POST.map(([k, label]) => (
            <label key={k} style={{ fontSize: 12.5, display: "flex", gap: 5, alignItems: "center", cursor: "pointer" }}>
              <input type="checkbox" checked={post.has(k)} onChange={() => setPost(s => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; })} /> {label}</label>))}
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 11.5, color: C.inkFaint }}>Already live elsewhere? Those just get the new prices.</span>
          <button disabled={!!busy} onClick={run} style={{ background: C.ink, color: "#FAF0DC", border: "none", borderRadius: 8, padding: "9px 16px", fontSize: 13, fontWeight: 750, cursor: busy ? "wait" : "pointer" }}>
            {busy ? `Working… ${Math.floor(busy)}/${rows.length}` : post.size ? `Save prices & post ${rows.length}` : `Save prices`}</button>
        </div>
      </div>
    </div>
  );
}
