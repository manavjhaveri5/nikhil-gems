/* Listing Manager's grid: every listing as a card, four or five across, with
   its live platforms, the three prices that matter (USA $ and India ₹ on the
   store, Etsy ₹) editable in place, and a drawer to manage photos, platforms
   and every other price. ListingManagerApp owns the data and the platform
   calls; this file is the view. */
import { useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import { C, FI } from "./lmTheme.js";

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
const statusOf = (l, k) => l.platforms?.[k]?.status || "";
const isLive = l => PLAT.some(p => statusOf(l, p.key) === "active");
// Listing-sized images: Etsy and Supabase both resize on request.
export const thumb = (u, w = 570) => {
  if (!u || typeof u !== "string") return u;
  if (/i\.etsystatic\.com/.test(u)) return u.replace(/il_fullxfull\./, w <= 340 ? "il_340x270." : "il_570xN.");
  if (u.includes("/storage/v1/object/public/")) return u.replace("/storage/v1/object/public/", "/storage/v1/render/image/public/") + `?width=${w}&quality=72&resize=contain`;
  return u;
};
const soldOut = (l, orders) => l.type === "unique" && (orders || []).some(o => o.listing_id === l.id) && !isLive(l);

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

/* ── one listing ───────────────────────────────────────────────────────── */
function Tile({ l, store, orders, onOpen, onEdit, onPrice, selected, onSelect }) {
  const imgs = (l.images || []).filter(u => typeof u === "string");
  const [i, setI] = useState(0);
  const [hover, setHover] = useState(false);
  const sold = soldOut(l, orders);
  const s = store?.[l.id];
  const usd = s ? num(s.price) : num(l.price_store);
  const inr = s ? num(s.price_inr) : num(l.price_store_inr);
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ background: C.surface, border: `1px solid ${selected ? C.gold : C.border}`, borderRadius: 12, overflow: "hidden", display: "flex", flexDirection: "column",
        boxShadow: hover ? "0 6px 22px rgba(40,30,15,.10)" : "0 1px 2px rgba(40,30,15,.04)", transition: "box-shadow .2s, transform .2s", transform: hover ? "translateY(-2px)" : "none" }}>
      <div onClick={() => onOpen(l, "photos")} style={{ position: "relative", aspectRatio: "1", background: C.card, cursor: "pointer" }}>
        {imgs[i] ? <img src={thumb(imgs[i])} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", opacity: sold ? .55 : 1 }} />
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
            const st = statusOf(l, p.key);
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
function Drawer({ l, tab, setTab, store, onClose, onPrice, onSavePhotos, onEdit, onMarkSold, onDelete, renderManage }) {
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
            <div style={{ fontSize: 11, color: C.inkFaint }}>{[l.material, l.shape, l.sku || l.listing_order_id, l._source === "etsy-import" ? "imported from Etsy" : "made in the ERP"].filter(Boolean).join(" · ")}</div>
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

export default function ListingGrid({ listings, orders, loadStoreFacts, onEdit, onPrice, onSavePhotos, onMarkSold, onDelete, renderManage, onBulkPrice }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");      // all | live | notlive | sold
  const [plat, setPlat] = useState("");             // platform key
  const [platOn, setPlatOn] = useState("on");       // on | off
  const [type, setType] = useState("");             // unique | repeatable
  const [material, setMaterial] = useState("");
  const [erpOnly, setErpOnly] = useState(false);
  const [issue, setIssue] = useState("");           // noprice | nophotos
  const [sort, setSort] = useState("new");
  const [cols, setCols] = useState(() => { try { return +localStorage.getItem("lm-grid-cols") || 0; } catch { return 0; } });
  const [shown, setShown] = useState(60);
  const [open, setOpen] = useState(null);           // { id, tab }
  const [store, setStore] = useState(null);
  const [sel, setSel] = useState(new Set());
  const more = useRef(null);

  const refreshStore = () => loadStoreFacts().then(setStore).catch(() => setStore({}));
  useEffect(() => { refreshStore(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { try { localStorage.setItem("lm-grid-cols", String(cols)); } catch {} }, [cols]);

  const materials = useMemo(() => {
    const m = new Map();
    for (const l of listings) { const k = String(l.material || "").trim(); if (k) m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60);
  }, [listings]);

  const list = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return listings.filter(l => {
      if (status === "live" && !isLive(l)) return false;
      if (status === "notlive" && isLive(l)) return false;
      if (status === "sold" && !soldOut(l, orders)) return false;
      if (plat) { const on = statusOf(l, plat) === "active"; if (platOn === "on" ? !on : on) return false; }
      if (type && l.type !== type) return false;
      if (material && String(l.material || "").trim() !== material) return false;
      if (erpOnly && l._source === "etsy-import") return false;
      if (issue === "noprice" && +l.price_etsy > 0) return false;
      if (issue === "nophotos" && (l.images || []).length) return false;
      if (terms.length) {
        const hay = [l.title, l.material, l.shape, l.sku, l.listing_order_id, l.origin, l.productType, l.etsy_title, l.shopify_title, Array.isArray(l.tags) ? l.tags.join(" ") : l.tags].filter(Boolean).join(" ").toLowerCase();
        if (!terms.every(t => hay.includes(t))) return false;
      }
      return true;
    }).sort(SORTS[sort][1]);
  }, [listings, orders, q, status, plat, platOn, type, material, erpOnly, issue, sort]);

  useEffect(() => { setShown(60); }, [q, status, plat, platOn, type, material, erpOnly, issue, sort]);
  // Load more as the bottom comes into view.
  useEffect(() => {
    const el = more.current; if (!el) return;
    const io = new IntersectionObserver(es => { if (es[0].isIntersecting) setShown(n => n + 60); }, { rootMargin: "600px" });
    io.observe(el); return () => io.disconnect();
  }, [list.length, shown]);

  const price = async (l, field, v) => { await onPrice(l, field, v); if (field.startsWith("price_store")) refreshStore(); };
  const openL = open && listings.find(l => l.id === open.id);
  const toggleSel = id => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selected = list.filter(l => sel.has(l.id));
  const anyFilter = q || status !== "all" || plat || type || material || erpOnly || issue;

  const chip = on => ({ padding: "6px 12px", borderRadius: 18, fontSize: 12.5, fontWeight: on ? 700 : 500, cursor: "pointer", whiteSpace: "nowrap",
    border: `1px solid ${on ? C.ink : C.border}`, background: on ? C.ink : C.surface, color: on ? "#FAF0DC" : C.inkMid });
  const sel_ = { ...FI(), width: "auto", padding: "6px 10px", fontSize: 12.5, borderRadius: 18 };
  const liveCount = listings.filter(isLive).length;

  return (
    <div>
      {/* filters */}
      <div style={{ position: "sticky", top: 0, zIndex: 20, background: C.bg, padding: "10px 0 12px", marginBottom: 6, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={`Search ${listings.length} listings — title, stone, SKU, tag…`}
            style={{ ...FI(), flex: "1 1 260px", maxWidth: 420, borderRadius: 20, padding: "8px 14px" }} />
          {[["all", `All ${listings.length}`], ["live", `Live ${liveCount}`], ["notlive", `Not live ${listings.length - liveCount}`], ["sold", "Sold"]].map(([k, t]) => (
            <button key={k} onClick={() => setStatus(k)} style={chip(status === k)}>{t}</button>
          ))}
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: C.ink, cursor: "pointer", padding: "6px 12px", borderRadius: 18, border: `1px solid ${erpOnly ? C.gold : C.border}`, background: erpOnly ? C.amberBg : C.surface, whiteSpace: "nowrap" }}>
            <input type="checkbox" checked={erpOnly} onChange={e => setErpOnly(e.target.checked)} style={{ margin: 0 }} /> Posted from ERP
          </label>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
          <select value={plat} onChange={e => setPlat(e.target.value)} style={sel_}>
            <option value="">Any platform</option>
            {PLAT.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
          {plat && <select value={platOn} onChange={e => setPlatOn(e.target.value)} style={sel_}><option value="on">is live on it</option><option value="off">is not on it</option></select>}
          <select value={material} onChange={e => setMaterial(e.target.value)} style={sel_}>
            <option value="">Any stone</option>
            {materials.map(([m, n]) => <option key={m} value={m}>{m} ({n})</option>)}
          </select>
          <select value={type} onChange={e => setType(e.target.value)} style={sel_}><option value="">Unique & repeatable</option><option value="unique">One of a kind</option><option value="repeatable">Repeatable</option></select>
          <select value={issue} onChange={e => setIssue(e.target.value)} style={sel_}><option value="">No issue filter</option><option value="noprice">Missing Etsy price</option><option value="nophotos">No photos</option></select>
          <select value={sort} onChange={e => setSort(e.target.value)} style={sel_}>{Object.entries(SORTS).map(([k, [t]]) => <option key={k} value={k}>{t}</option>)}</select>
          {anyFilter && <button onClick={() => { setQ(""); setStatus("all"); setPlat(""); setType(""); setMaterial(""); setErpOnly(false); setIssue(""); }} style={{ ...chip(false), color: C.red }}>Clear</button>}
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: C.inkFaint }}>{list.length} shown</span>
          <div style={{ display: "flex", border: `1px solid ${C.border}`, borderRadius: 18, overflow: "hidden" }} title="Cards per row">
            {[[0, "Auto"], [4, "4"], [5, "5"]].map(([n, t]) => <button key={n} onClick={() => setCols(n)} style={{ padding: "5px 10px", border: "none", fontSize: 12, cursor: "pointer", background: cols === n ? C.ink : C.surface, color: cols === n ? "#FAF0DC" : C.inkMid }}>{t}</button>)}
          </div>
        </div>
        {selected.length > 0 && (
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10, padding: "8px 12px", background: C.amberBg, borderRadius: 10, fontSize: 12.5, flexWrap: "wrap" }}>
            <b>{selected.length} selected</b>
            <button onClick={() => onBulkPrice(selected, "up").then(refreshStore)} style={{ ...chip(false) }}>Change prices by %…</button>
            <button onClick={() => setSel(new Set(list.map(l => l.id)))} style={chip(false)}>Select all {list.length}</button>
            <button onClick={() => setSel(new Set())} style={chip(false)}>Clear selection</button>
          </div>
        )}
      </div>

      {/* grid */}
      <div style={{ display: "grid", gap: 14, gridTemplateColumns: cols ? `repeat(${cols}, minmax(0, 1fr))` : "repeat(auto-fill, minmax(245px, 1fr))" }}>
        {list.slice(0, shown).map(l => (
          <Tile key={l.id} l={l} store={store} orders={orders} selected={sel.has(l.id)} onSelect={toggleSel}
            onOpen={(x, tab) => setOpen({ id: x.id, tab })} onEdit={onEdit} onPrice={price} />
        ))}
      </div>
      {!list.length && <div style={{ textAlign: "center", padding: "60px 0", color: C.inkFaint }}>No listings match these filters.</div>}
      {shown < list.length && <div ref={more} style={{ textAlign: "center", padding: 24, color: C.inkFaint, fontSize: 12 }}>Loading more…</div>}

      {openL && (
        <Drawer l={openL} tab={open.tab} setTab={t => setOpen(o => ({ ...o, tab: t }))} store={store}
          onClose={() => setOpen(null)} onPrice={price} onEdit={x => { setOpen(null); onEdit(x); }}
          onSavePhotos={onSavePhotos} onMarkSold={onMarkSold} onDelete={onDelete} renderManage={renderManage} />
      )}
    </div>
  );
}
