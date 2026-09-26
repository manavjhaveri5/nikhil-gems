/* Listing Manager's grid: every listing as a card, four or five across, with
   its live platforms, the three prices that matter (USA $ and India ₹ on the
   store, Etsy ₹) editable in place, and a drawer to manage photos, platforms
   and every other price. ListingManagerApp owns the data and the platform
   calls; this file is the view. */
import { useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import { C, FI } from "./lmTheme.js";
import { locationOf, needsLocation, knownLocations, tradeRowOf } from "./listingChannels.js";

const PhotoEditor = lazy(() => import("./PhotoEditor.jsx"));

const PLAT = [
  { key: "etsy",          label: "Etsy",       short: "Etsy",  color: "#F56400" },
  { key: "store",         label: "EE store",   short: "Store", color: "#141210" },
  { key: "shopify_earth", label: "Earth Ed.",  short: "Earth", color: "#2A6845" },
  { key: "shopify_aty",   label: "Atyahara",   short: "Aty",   color: "#6B3FA0" },
  { key: "ebay",          label: "eBay",       short: "eBay",  color: "#0064D2" },
  { key: "trade",         label: "Trade site", short: "Trade", color: "#1F8F4E" },
];
// Every price a listing carries, for the drawer. The grid shows the first three.
const PRICES = [
  { field: "price_store",         label: "USA · EE store",  cur: "$", flag: "🇺🇸", sync: "store" },
  { field: "price_store_inr",     label: "India · EE store", cur: "₹", flag: "🇮🇳", sync: "store" },
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
const statusOf = (l, k, f = {}) => {
  if (k === "store" && f.store) { const r = f.store[l.id]; return !r ? "" : r.status === "active" ? "active" : r.status === "sold" ? "sold" : "draft"; }
  if (k === "trade" && f.trade) { const r = tradeRowOf(f.trade, l); return !r ? "" : r.live ? "active" : "draft"; }
  const st = l.platforms?.[k]?.status || "";
  return st === "deleted" ? "" : st;
};
const isLive = (l, f) => PLAT.some(p => statusOf(l, p.key, f) === "active");
// Listing-sized images: Etsy and Supabase both resize on request.
export const thumb = (u, w = 570) => {
  if (!u || typeof u !== "string") return u;
  if (/i\.etsystatic\.com/.test(u)) return u.replace(/il_fullxfull\./, w <= 340 ? "il_340x270." : "il_570xN.");
  if (u.includes("/storage/v1/object/public/")) return u.replace("/storage/v1/object/public/", "/storage/v1/render/image/public/") + `?width=${w}&quality=72&resize=contain`;
  return u;
};
const soldOut = (l, orders, f) => l.type === "unique" && (orders || []).some(o => o.listing_id === l.id) && !isLive(l, f);

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
function Tile({ l, store, facts, orders, stock, onOpen, onEdit, onPrice, onLocation, selected, onSelect }) {
  const imgs = (l.images || []).filter(u => typeof u === "string");
  const [i, setI] = useState(0);
  const [hover, setHover] = useState(false);
  const sold = soldOut(l, orders, facts);
  const where = locationOf(l, stock);
  const s = store?.[l.id];
  const usd = s ? num(s.price) : num(l.price_store);
  const inr = s ? num(s.price_inr) : num(l.price_store_inr);
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ background: C.surface, border: `1px solid ${selected ? C.gold : C.border}`, borderRadius: 12, overflow: "hidden", display: "flex", flexDirection: "column",
        boxShadow: hover ? "0 6px 22px rgba(40,30,15,.10)" : "0 1px 2px rgba(40,30,15,.04)", transition: "box-shadow .2s, transform .2s", transform: hover ? "translateY(-2px)" : "none" }}>
      <div onClick={() => onOpen(l, "photos")} style={{ position: "relative", aspectRatio: "1", background: C.card, cursor: "pointer", overflow: "hidden" }}>
        {imgs[i] ? <img src={thumb(imgs[i])} alt="" loading="lazy" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", display: "block", opacity: sold ? .55 : 1 }} />
          : <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 34, opacity: .5 }}>💎</div>}
        <label onClick={e => e.stopPropagation()} style={{ position: "absolute", top: 8, left: 8, width: 24, height: 24, borderRadius: 6, background: "rgba(255,255,255,.9)",
          display: hover || selected ? "flex" : "none", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
          <input type="checkbox" checked={selected} onChange={() => onSelect(l.id)} style={{ margin: 0, cursor: "pointer" }} />
        </label>
        <div style={{ position: "absolute", top: 8, right: 8, display: "flex", gap: 4 }}>
          {l.video && <span style={pill("#fff", "rgba(20,15,8,.65)")}>▶</span>}
          {l.type === "unique" ? <span style={pill(C.blue, "rgba(255,255,255,.92)")}>1 of 1</span> : <span style={pill(C.amber, "rgba(255,255,255,.92)")}>Qty {l.qty || "—"}</span>}
        </div>
        {sold && <span style={{ ...pill("#fff", C.ink), position: "absolute", bottom: 8, left: 8 }}>Sold</span>}
        {imgs.length > 1 && hover && <>
          <button onClick={e => { e.stopPropagation(); setI(x => (x - 1 + imgs.length) % imgs.length); }} style={arrow("left")}>‹</button>
          <button onClick={e => { e.stopPropagation(); setI(x => (x + 1) % imgs.length); }} style={arrow("right")}>›</button>
        </>}
        {imgs.length > 1 && <span style={{ position: "absolute", bottom: 8, right: 8, ...pill("#fff", "rgba(20,15,8,.55)") }}>{i + 1}/{imgs.length}</span>}
      </div>
      <div style={{ padding: "10px 11px 11px", display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
        <div onClick={() => onOpen(l, "platforms")} style={{ display: "flex", gap: 3, flexWrap: "wrap", cursor: "pointer" }} title="Platforms — click to manage">
          {PLAT.map(p => {
            const st = statusOf(l, p.key, facts);
            const on = st === "active", draft = st && st !== "active" && st !== "deleted";
            return <span key={p.key} style={{ fontSize: 9.5, fontWeight: 700, padding: "2px 6px", borderRadius: 10, letterSpacing: .2,
              background: on ? p.color : "transparent", color: on ? "#fff" : draft ? p.color : C.inkFaint,
              border: `1px solid ${on ? p.color : draft ? p.color + "80" : C.border}`, opacity: on || draft ? 1 : .7 }}>{p.short}</span>;
          })}
        </div>
        <div onClick={() => onOpen(l, "platforms")} style={{ cursor: "pointer" }}>
          <div style={{ fontSize: 13, fontWeight: 650, color: C.ink, lineHeight: 1.3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", minHeight: 34 }}>{l.title || "Untitled listing"}</div>
          <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {[l.material, l.shape, l.sku || l.listing_order_id].filter(Boolean).join(" · ")}
          </div>
        </div>
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
const pill = (color, bg) => ({ fontSize: 10, fontWeight: 800, color, background: bg, padding: "2px 7px", borderRadius: 10, letterSpacing: .3 });
const arrow = side => ({ position: "absolute", top: "50%", [side]: 6, transform: "translateY(-50%)", width: 28, height: 28, borderRadius: 14, border: "none",
  background: "rgba(255,255,255,.9)", fontSize: 18, lineHeight: "26px", cursor: "pointer", color: "#141210", padding: 0, boxShadow: "0 1px 4px rgba(0,0,0,.2)" });
const btn = (dark = false) => ({ flex: 1, padding: "7px 0", borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: "pointer",
  border: `1px solid ${dark ? C.ink : C.border}`, background: dark ? C.ink : C.surface, color: dark ? "#FAF0DC" : C.ink });

/* ── the drawer: photos, platforms, every price ────────────────────────── */
function Drawer({ l, where, tab, setTab, store, onClose, onPrice, onSavePhotos, onEdit, onMarkSold, onDelete, renderManage }) {
  const [imgs, setImgs] = useState(() => (l.images || []).filter(u => typeof u === "string"));
  const [editIdx, setEditIdx] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setImgs((l.images || []).filter(u => typeof u === "string")); }, [l.id, l.images]);
  const changed = JSON.stringify(imgs) !== JSON.stringify((l.images || []).filter(u => typeof u === "string"));
  const s = store?.[l.id];
  const val = f => f === "price_store" && s ? num(s.price) : f === "price_store_inr" && s ? num(s.price_inr) : num(l[f]);
  const move = (i, d) => setImgs(a => { const b = [...a]; const j = i + d; if (j < 0 || j >= b.length) return a; [b[i], b[j]] = [b[j], b[i]]; return b; });
  useEffect(() => { const k = e => e.key === "Escape" && editIdx == null && onClose(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose, editIdx]);
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
          {[["platforms", "Platforms"], ["prices", "Prices"], ["photos", `Photos (${imgs.length})`]].map(([k, t]) => (
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
              <div style={{ fontSize: 12, color: C.inkMid, marginBottom: 10 }}>★ makes the cover · arrows reorder · ✎ opens the photo editor · × removes. Save to update every platform it's on. Add new photos in the full editor.</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
                {imgs.map((u, i) => (
                  <div key={u + i} style={{ position: "relative", aspectRatio: "1", borderRadius: 9, overflow: "hidden", background: C.card, outline: i === 0 ? `2.5px solid ${C.gold}` : "none", outlineOffset: -2.5 }}>
                    <img src={thumb(u, 340)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
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
                ))}
              </div>
              {editIdx != null && imgs[editIdx] && (
                <Suspense fallback={null}>
                  <PhotoEditor url={imgs[editIdx]} photos={imgs} index={editIdx}
                    onSave={u => setImgs(a => a.map((x, j) => (j === editIdx ? u : x)))}
                    onSaveAll={next => setImgs(() => next)}
                    onClose={() => setEditIdx(null)} />
                </Suspense>
              )}
            </>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, padding: "12px 16px", borderTop: `1px solid ${C.border}`, background: C.surface, alignItems: "center" }}>
          <button onClick={() => { onClose(); onMarkSold(l); }} style={{ ...btn(), flex: "none", padding: "8px 14px", background: C.greenBg, color: C.green, borderColor: C.green + "40" }}>Mark sold</button>
          <button onClick={() => { if (confirm("Delete this listing from the ERP? It stays on the platforms.")) { onClose(); onDelete(l.id); } }} style={{ ...btn(), flex: "none", padding: "8px 14px", color: C.red }}>Delete</button>
          <div style={{ flex: 1 }} />
          {tab === "photos" && changed && (
            <button disabled={busy} onClick={async () => { setBusy(true); try { await onSavePhotos(l, imgs); } finally { setBusy(false); } }}
              style={{ ...btn(true), flex: "none", padding: "9px 18px", opacity: busy ? .6 : 1 }}>{busy ? "Saving…" : "Save photos"}</button>
          )}
        </div>
      </div>
    </div>
  );
}
const round = { width: 26, height: 26, borderRadius: 13, border: "none", background: "rgba(20,15,8,.7)", color: "#fff", fontSize: 13, cursor: "pointer", padding: 0, lineHeight: "26px" };

/* ── the whole view ────────────────────────────────────────────────────── */
const SORTS = {
  new: ["Newest", (a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""))],
  old: ["Oldest", (a, b) => String(a.created_at || "").localeCompare(String(b.created_at || ""))],
  etsyHigh: ["Etsy price ↓", (a, b) => (+b.price_etsy || 0) - (+a.price_etsy || 0)],
  etsyLow: ["Etsy price ↑", (a, b) => (+a.price_etsy || 1e12) - (+b.price_etsy || 1e12)],
  az: ["A–Z", (a, b) => String(a.title || "").localeCompare(String(b.title || ""))],
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

export default function ListingGrid({ listings, orders, stock = [], loadStoreFacts, loadTradeFacts, onEdit, onPrice, onLocation, onBulkMove, onSavePhotos, onMarkSold, onDelete, renderManage, onBulkPrice }) {
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
  const more = useRef(null);

  const [trade, setTrade] = useState(null);
  // Left null when a load fails, so the pills fall back to the listing's own note.
  const refreshStore = () => loadStoreFacts().then(setStore).catch(() => {});
  useEffect(() => { refreshStore(); loadTradeFacts?.().then(setTrade).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const facts = useMemo(() => ({ store, trade }), [store, trade]);
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
        if (!((status.has("live") && live) || (status.has("notlive") && !live) || (status.has("sold") && sold))) return false;
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
    }).sort(SORTS[sort][1]);
  }, [listings, orders, q, status, liveOn, notOn, types, stones, erpOnly, issues, sort, locs, whereOf, facts]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const nFilters = status.size + liveOn.size + notOn.size + types.size + stones.size + issues.size + locs.size + (erpOnly ? 1 : 0);
  const clearAll = () => { setStatus(new Set()); setLiveOn(new Set()); setNotOn(new Set()); setTypes(new Set()); setStones(new Set()); setIssues(new Set()); setLocs(new Set()); setErpOnly(false); setQ(""); };
  const placeList = places.filter(([k, e]) => !locQ || e.label.toLowerCase().includes(locQ.toLowerCase()));
  const stoneList = materials.filter(([k]) => !stoneQ || k.includes(stoneQ.toLowerCase()));
  const chip = on => ({ padding: "6px 12px", borderRadius: 18, fontSize: 12.5, fontWeight: on ? 700 : 500, cursor: "pointer", whiteSpace: "nowrap",
    border: `1px solid ${on ? C.ink : C.border}`, background: on ? C.ink : C.surface, color: on ? "#FAF0DC" : C.inkMid });

  return (
    <div>
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
            <button onClick={() => onBulkPrice(selected).then(refreshStore)} style={chip(false)}>Change prices by %…</button>
            {onBulkMove && <button onClick={() => onBulkMove(selected)} style={chip(false)}>📍 Move to…</button>}
            <button onClick={() => setSel(new Set(list.map(l => l.id)))} style={chip(false)}>Select all {list.length}</button>
            <button onClick={() => setSel(new Set())} style={chip(false)}>Clear selection</button>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 22, alignItems: "flex-start" }}>
        {/* checkbox filters */}
        {panel && (
          <aside style={{ width: 230, flex: "none", position: "sticky", top: 70, maxHeight: "calc(100vh - 90px)", overflowY: "auto", paddingRight: 4 }}>
            <Group title="Show">
              <Check checked={status.has("live")} onChange={() => setStatus(s => toggle(s, "live"))} label="Live" count={counts.live} color={C.green} />
              <Check checked={status.has("notlive")} onChange={() => setStatus(s => toggle(s, "notlive"))} label="Not live" count={listings.length - counts.live} />
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
              <Check checked={issues.has("nostore")} onChange={() => setIssues(s => toggle(s, "nostore"))} label="Not on the EE store" count={counts.nostore} color={C.amber} />
            </Group>
          </aside>
        )}

        {/* grid */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "grid", gap: 14, gridTemplateColumns: cols ? `repeat(${cols}, minmax(0, 1fr))` : "repeat(auto-fill, minmax(230px, 1fr))" }}>
            {list.slice(0, shown).map(l => (
              <Tile key={l.id} l={l} store={store} facts={facts} orders={orders} stock={stock} selected={sel.has(l.id)} onSelect={toggleSel}
                onOpen={(x, tab) => setOpen({ id: x.id, tab })} onEdit={onEdit} onPrice={price} onLocation={onLocation} />
            ))}
          </div>
          <datalist id="lm-grid-locs">{allPlaces.map(p => <option key={p.label} value={p.label} />)}</datalist>
          {!list.length && <div style={{ textAlign: "center", padding: "60px 0", color: C.inkFaint }}>No listings match these filters.</div>}
          {shown < list.length && <div ref={more} style={{ textAlign: "center", padding: 24, color: C.inkFaint, fontSize: 12 }}>Loading more…</div>}
        </div>
      </div>

      {openL && (
        <Drawer l={openL} where={whereOf.get(openL.id)} tab={open.tab} setTab={t => setOpen(o => ({ ...o, tab: t }))} store={store}
          onClose={() => setOpen(null)} onPrice={price} onEdit={x => { setOpen(null); onEdit(x); }}
          onSavePhotos={onSavePhotos} onMarkSold={onMarkSold} onDelete={onDelete} renderManage={renderManage} />
      )}
    </div>
  );
}
