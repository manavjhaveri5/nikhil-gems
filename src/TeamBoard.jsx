/* Team Board: the to-do list as a full-screen workspace for the whole team.

   Two boards share one store (ng-team-board-v1, an app_data array written one
   item at a time with upsertItemK, never as a whole array):
   - Tasks: To do → In progress → Done.
   - Photography plan: To photograph → Photographed → Being listed → Listed.
     A plan item can point at a stock card. Its stage moves forward by itself
     when the card gets new photos (more than it had when it was planned), when
     a listing is made from that card after it was planned, and when that
     listing goes live anywhere. A stage set by hand is never pulled back.

   Who sees what: the admin sees everything. Anyone else sees what is assigned
   to them, what they created, and the common items (marked "common", or
   assigned to nobody).

   Other devices hear about a save through the same "invalidate" broadcast the
   rest of the ERP uses (no postgres_changes), plus the one-minute version poll. */
import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { C, FI } from "./ui.jsx";
import { mob, uid, today, loadK, loadKFresh, saveK, useLiveK, upsertItemK, upsertItemsK, deleteItemK } from "./utils.js";
import { KEYS } from "./constants.js";
import { sbThumb } from "./photoUrls.js";

export const BOARD_KEY = "ng-team-board-v1";
const LISTINGS_KEY = "ng-listings-v1";
const oldTodoKey = me => me === "admin" ? "ng-todos-v1" : `ng-todos-${me.replace(/[^a-z0-9]/gi, "-")}-v1`;
const SERIF = "'Cormorant Garamond',Georgia,serif";
const iso = () => new Date().toISOString();

const TASK_COLS = [
  { key: "todo", label: "To do", icon: "○", color: "#8C7E66", bg: "rgba(140,126,102,.10)" },
  { key: "doing", label: "In progress", icon: "◐", color: "#B07D12", bg: "rgba(176,125,18,.10)" },
  { key: "done", label: "Done", icon: "●", color: "#2A6845", bg: "rgba(42,104,69,.10)" },
];
const SHOOT_COLS = [
  { key: "plan", label: "To photograph", icon: "📷", color: "#A85E08", bg: "rgba(168,94,8,.10)" },
  { key: "photographed", label: "Photographed", icon: "🖼", color: "#1A4A8A", bg: "rgba(26,74,138,.10)" },
  { key: "listing", label: "Being listed", icon: "✍️", color: "#5A3A8A", bg: "rgba(90,58,138,.10)" },
  { key: "listed", label: "Listed", icon: "✓", color: "#2A6845", bg: "rgba(42,104,69,.10)" },
];
const STAGE_ORDER = SHOOT_COLS.map(c => c.key);
const laterStage = (a, b) => STAGE_ORDER.indexOf(a) >= STAGE_ORDER.indexOf(b) ? a : b;
const PLATFORMS = [
  { key: "etsy", label: "Etsy" },
  { key: "store", label: "Earth Editions" },
  { key: "shopify_aty", label: "Atyahara" },
  { key: "ebay", label: "eBay" },
];
const PALETTE = ["#2B2620", "#B07D12", "#1A6A6A", "#8B2020", "#5A3A8A", "#1A4A8A", "#3D7A5A", "#A85E08"];
const RECUR = { "": "Doesn't repeat", daily: "Daily", weekly: "Weekly", monthly: "Monthly" };

const photosOf = s => [...(Array.isArray(s?.photos) ? s.photos : []), s?.photo].filter((u, i, a) => u && typeof u === "string" && a.indexOf(u) === i);
const stockLabel = s => [s?.material, s?.shape, s?.size].filter(Boolean).join(" · ") || s?.sku || "Stock card";
const thumb = (u, w = 320) => {
  if (!u || typeof u !== "string") return "";
  if (/i\.etsystatic\.com/.test(u)) return u.replace(/il_fullxfull\./, "il_340x270.");
  try { return sbThumb(u, w) || u; } catch { return u; }
};
const isLiveListing = l => !!l && Object.values(l.platforms || {}).some(p => p?.status === "active");
const nextDue = (due, freq) => {
  const base = due ? new Date(due + "T00:00:00") : new Date();
  const d = base < new Date() ? new Date() : base;
  if (freq === "daily") d.setDate(d.getDate() + 1);
  else if (freq === "weekly") d.setDate(d.getDate() + 7);
  else if (freq === "monthly") d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
};
const dueTone = due => {
  if (!due) return null;
  const t = today();
  if (due < t) return { label: "Overdue", color: "#8B2020", bg: "rgba(139,32,32,.09)" };
  if (due === t) return { label: "Today", color: "#B07D12", bg: "rgba(176,125,18,.12)" };
  const d = new Date(due + "T00:00:00");
  return { label: d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }), color: "#8C7E66", bg: "rgba(140,126,102,.10)" };
};
const ago = ts => {
  const s = (Date.now() - Date.parse(ts || 0)) / 1000;
  if (!(s >= 0)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
};
const broadcast = () => {
  try { globalThis.__ngDataChannel?.send({ type: "broadcast", event: "invalidate", payload: { key: BOARD_KEY, ts: Date.now() } }).catch(() => {}); } catch {}
};

/* ─── Small pieces ─────────────────────────────────────────────── */
function Avatar({ p, size = 24, ring }) {
  const name = p?.name || "?";
  return (
    <span title={name} style={{ width: size, height: size, borderRadius: size / 2, background: p?.color || "#999", color: "#FAF0DC", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: size * .42, fontWeight: 700, flexShrink: 0, boxShadow: ring ? `0 0 0 2px ${C.surface}` : "none", letterSpacing: 0, fontFamily: "inherit" }}>
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}
function AvatarStack({ list, size = 22 }) {
  if (!list.length) return <span style={{ fontSize: 10, fontWeight: 700, color: C.teal, background: C.tealBg, borderRadius: 10, padding: "2px 8px" }}>Common</span>;
  return <span style={{ display: "inline-flex" }}>{list.map((p, i) => <span key={p.key} style={{ marginLeft: i ? -6 : 0 }}><Avatar p={p} size={size} ring /></span>)}</span>;
}
function Chip({ on, onClick, children, color, title }) {
  return (
    <button type="button" onClick={onClick} title={title}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: mob ? "7px 12px" : "5px 11px", borderRadius: 20, border: `1px solid ${on ? (color || C.ink) : C.border}`, background: on ? (color || C.ink) : C.surface, color: on ? "#FAF0DC" : C.inkMid, fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", fontFamily: "inherit", transition: "all .12s" }}>
      {children}
    </button>
  );
}
function PersonPicker({ people, value = [], onChange, me }) {
  const toggle = k => onChange(value.includes(k) ? value.filter(x => x !== k) : [...value, k]);
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {people.map(p => {
        const on = value.includes(p.key);
        return (
          <button key={p.key} type="button" onClick={() => toggle(p.key)}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 10px 3px 3px", borderRadius: 20, border: `1px solid ${on ? p.color : C.border}`, background: on ? p.color : C.surface, color: on ? "#FAF0DC" : C.inkMid, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
            <Avatar p={p} size={mob ? 26 : 22} />{p.key === me ? "Me" : p.name.split(" ")[0]}
          </button>
        );
      })}
    </div>
  );
}

/* ─── A card on the board ──────────────────────────────────────── */
function BoardCard({ it, info, col, people, me, isNew, onOpen, onToggle, onDragStart, onAdvance, dragging }) {
  // Only the people this viewer may see: staff see themselves, never their colleagues' names.
  const assignees = (it.assignees || []).map(k => people.find(p => p.key === k)).filter(Boolean);
  const due = it.status === "done" || info?.stage === "listed" ? null : dueTone(it.dueDate);
  const shoot = it.kind === "shoot";
  const img = shoot ? (info?.listingImg || info?.photo || it.stockPhoto) : (it.photos || [])[0];
  const comments = (it.comments || []).length;
  const done = shoot ? info?.stage === "listed" : it.status === "done";
  const autoMoved = shoot && info && info.auto !== "plan" && STAGE_ORDER.indexOf(info.auto) > STAGE_ORDER.indexOf(it.stage || "plan");
  return (
    <div draggable={!mob} onDragStart={e => { e.dataTransfer.setData("text/plain", it.id); e.dataTransfer.effectAllowed = "move"; onDragStart?.(it.id); }}
      onClick={() => onOpen(it.id)} className="tb-card"
      style={{ background: C.surface, borderRadius: 14, border: `1px solid ${isNew ? C.gold : C.border}`, boxShadow: "0 1px 2px rgba(26,19,8,.05), 0 4px 14px rgba(26,19,8,.04)", cursor: "pointer", overflow: "hidden", opacity: dragging ? .4 : done ? .72 : 1, transition: "transform .12s, box-shadow .12s, opacity .12s", position: "relative" }}>
      {img && (
        <div style={{ height: mob ? 130 : 120, background: `${C.card} center/cover no-repeat url("${thumb(img)}")`, position: "relative" }}>
          {it.stockLocation && <span style={{ position: "absolute", left: 8, bottom: 8, background: "rgba(20,15,8,.72)", color: "#FAF0DC", fontSize: 10, fontWeight: 700, borderRadius: 6, padding: "2px 7px", letterSpacing: .3 }}>{it.stockLocation}</span>}
        </div>
      )}
      <div style={{ padding: "10px 12px 11px" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          {!shoot && (
            <button type="button" onClick={e => { e.stopPropagation(); onToggle(it); }} aria-label={done ? "Mark not done" : "Mark done"}
              style={{ width: 20, height: 20, borderRadius: 10, border: `2px solid ${done ? C.green : col.color}`, background: done ? C.green : "transparent", color: "#fff", fontSize: 11, lineHeight: "16px", padding: 0, cursor: "pointer", flexShrink: 0, marginTop: 1 }}>{done ? "✓" : ""}</button>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: C.ink, lineHeight: 1.32, textDecoration: done && !shoot ? "line-through" : "none", wordBreak: "break-word" }}>
              {it.priority && <span style={{ color: C.red, marginRight: 4 }}>⚑</span>}{it.title}
            </div>
            {it.notes && <div style={{ fontSize: 12, color: C.inkMid, lineHeight: 1.4, marginTop: 4, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden", whiteSpace: "pre-wrap" }}>{shoot && <span style={{ fontWeight: 700, color: C.purple }}>Make: </span>}{it.notes}</div>}
          </div>
        </div>
        {shoot && (it.platforms || []).length > 0 && (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 7 }}>
            {it.platforms.map(k => <span key={k} style={{ fontSize: 10, fontWeight: 600, color: C.inkMid, background: C.card, border: `1px solid ${C.border}`, borderRadius: 5, padding: "1px 6px" }}>{PLATFORMS.find(p => p.key === k)?.label || k}</span>)}
          </div>
        )}
        {shoot && info?.listing && (
          <div style={{ marginTop: 7, fontSize: 11, color: info.live ? C.green : C.purple, fontWeight: 600, display: "flex", gap: 5, alignItems: "center" }}>
            <span>{info.live ? "● Live" : "◌ Draft"}</span>
            <span style={{ color: C.inkFaint, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{info.listing.listing_order_id || info.listing.title}</span>
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 9, flexWrap: "wrap" }}>
          <AvatarStack list={assignees} />
          {isNew && <span style={{ fontSize: 10, fontWeight: 800, color: "#fff", background: C.gold, borderRadius: 10, padding: "2px 7px", letterSpacing: .4 }}>NEW</span>}
          {it.recurring && <span title={RECUR[it.recurring]} style={{ fontSize: 10, fontWeight: 700, color: C.blue, background: C.blueBg, borderRadius: 10, padding: "2px 7px" }}>↻ {RECUR[it.recurring]}</span>}
          {autoMoved && <span title="Moved on by itself from the stock card and listings" style={{ fontSize: 10, fontWeight: 700, color: C.teal, background: C.tealBg, borderRadius: 10, padding: "2px 7px" }}>auto</span>}
          <span style={{ flex: 1 }} />
          {comments > 0 && <span style={{ fontSize: 11, color: C.inkFaint }}>💬 {comments}</span>}
          {due && <span style={{ fontSize: 10, fontWeight: 700, color: due.color, background: due.bg, borderRadius: 10, padding: "2px 8px" }}>{due.label}</span>}
          {mob && onAdvance && <button type="button" onClick={e => { e.stopPropagation(); onAdvance(it); }} style={{ border: `1px solid ${C.border}`, background: C.card, borderRadius: 14, padding: "4px 10px", fontSize: 12, fontWeight: 700, color: C.inkMid, cursor: "pointer", fontFamily: "inherit" }}>Next →</button>}
        </div>
      </div>
    </div>
  );
}

/* ─── The board ───────────────────────────────────────────────── */
export default function TeamBoard({ onHome, currentUser, isAdmin, allUsers = [], onOpenModule, onOpenStock }) {
  const me = isAdmin ? "admin" : String(currentUser?.email || "").toLowerCase();
  const allPeople = useMemo(() => [
    { key: "admin", name: "Admin", color: PALETTE[0] },
    ...allUsers.filter(u => u?.email).map((u, i) => ({ key: u.email.toLowerCase(), name: u.name || u.email, color: PALETTE[(i + 1) % PALETTE.length] })),
  ], [allUsers]);
  // Staff never see who else is on the team: only themselves (and "Common").
  const people = useMemo(() => isAdmin ? allPeople : allPeople.filter(p => p.key === me), [allPeople, isAdmin, me]);
  const rawItems = useLiveK(BOARD_KEY, []);
  const rawStock = useLiveK(KEYS.stock, []);
  const rawListings = useLiveK(LISTINGS_KEY, []);
  const items = Array.isArray(rawItems) ? rawItems.filter(x => x?.id) : [];
  const stock = Array.isArray(rawStock) ? rawStock : [];
  const listings = Array.isArray(rawListings) ? rawListings : [];

  const [view, setView] = useState(() => { try { return localStorage.getItem("ng-team-view") || "tasks"; } catch { return "tasks"; } });
  useEffect(() => { try { localStorage.setItem("ng-team-view", view); } catch {} }, [view]);
  const [who, setWho] = useState("all");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState(null);
  const [picker, setPicker] = useState(false);
  const [mobCol, setMobCol] = useState(0);
  const [dragId, setDragId] = useState(null);
  const [overCol, setOverCol] = useState(null);
  const [showAllDone, setShowAllDone] = useState(false);
  const [toast, setToast] = useState("");
  const say = useCallback(m => { setToast(m); setTimeout(() => setToast(""), 3200); }, []);

  // "New" for things handed to me by someone else since I last looked.
  const seenKey = `ng-team-seen-${me}`;
  const [seenAt] = useState(() => { try { return localStorage.getItem(seenKey) || ""; } catch { return ""; } });
  useEffect(() => { const t = setTimeout(() => { try { localStorage.setItem(seenKey, iso()); } catch {} }, 4000); return () => clearTimeout(t); }, [seenKey]);
  const isNew = it => !!seenAt && (it.assignees || []).includes(me) && it.createdBy !== me && it.createdAt > seenAt;

  // Staff see only what is assigned to them, and common items (visible to all).
  const canSee = it => isAdmin || it.shared || !(it.assignees || []).length || (it.assignees || []).includes(me);
  const visible = items.filter(canSee);

  // Stock and listings, for the photography plan.
  const stockById = useMemo(() => new Map(stock.filter(s => s?.id).map(s => [s.id, s])), [stock]);
  const listingsByStock = useMemo(() => {
    const m = new Map();
    listings.forEach(l => { if (l?.linked_stock_id) { if (!m.has(l.linked_stock_id)) m.set(l.linked_stock_id, []); m.get(l.linked_stock_id).push(l); } });
    return m;
  }, [listings]);
  const shootInfo = useCallback(it => {
    const card = it.stockId ? stockById.get(it.stockId) : null;
    const cands = it.stockId ? (listingsByStock.get(it.stockId) || []) : [];
    const planned = Date.parse(it.createdAt || 0) - 3600e3;
    const listing = it.listingId
      ? listings.find(l => l.id === it.listingId)
      : cands.filter(l => (Date.parse(l.created_at || 0) || 0) >= planned && l.status !== "deleted").sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))[0];
    const live = isLiveListing(listing);
    const photos = photosOf(card);
    const shot = !!card && photos.length > (+it.photosAtPlan || 0);
    const auto = live ? "listed" : listing ? "listing" : shot ? "photographed" : "plan";
    return { card, cands, listing, live, auto, stage: laterStage(it.stage || "plan", auto), photo: photos[0] || "", listingImg: (listing?.images || [])[0] || "" };
  }, [stockById, listingsByStock, listings]);

  const matchesWho = it => {
    const a = it.assignees || [];
    if (who === "all") return true;
    if (who === "mine") return a.includes(me);
    if (who === "common") return it.shared || !a.length;
    return a.includes(who);
  };
  const ql = q.trim().toLowerCase();
  const matchesQ = it => !ql || [it.title, it.notes, it.stockLabel, it.stockLocation, it.stockSku].some(v => String(v || "").toLowerCase().includes(ql));
  const recentCut = Date.now() - 14 * 864e5;
  const isRecent = it => showAllDone || (Date.parse(it.doneAt || it.updatedAt || it.createdAt || 0) || 0) >= recentCut;

  const tasks = visible.filter(it => it.kind !== "shoot");
  const shoots = visible.filter(it => it.kind === "shoot");
  const infos = new Map(shoots.map(it => [it.id, shootInfo(it)]));
  const stageOf = it => it.kind === "shoot" ? infos.get(it.id)?.stage || "plan" : (it.status || "todo");

  const cols = view === "photo" ? SHOOT_COLS : TASK_COLS;
  const lastCol = cols[cols.length - 1].key;
  const pool = (view === "photo" ? shoots : tasks).filter(matchesWho).filter(matchesQ);
  const sortItems = list => [...list].sort((a, b) =>
    (b.priority ? 1 : 0) - (a.priority ? 1 : 0) ||
    (a.dueDate || "9999").localeCompare(b.dueDate || "9999") ||
    String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const byCol = Object.fromEntries(cols.map(c => [c.key, sortItems(pool.filter(it => stageOf(it) === c.key && (c.key !== lastCol || isRecent(it))))]));
  const hiddenDone = pool.filter(it => stageOf(it) === lastCol && !isRecent(it)).length;

  // Open work per person, for the people strip.
  const openOf = key => visible.filter(it => (it.assignees || []).includes(key) && stageOf(it) !== (it.kind === "shoot" ? "listed" : "done")).length;
  const commonOpen = visible.filter(it => (it.shared || !(it.assignees || []).length) && stageOf(it) !== (it.kind === "shoot" ? "listed" : "done")).length;

  /* ── writes ── */
  const save = async (it, patch = {}) => {
    const next = { ...it, ...patch, updatedAt: iso(), updatedBy: me };
    try { await upsertItemK(BOARD_KEY, next); broadcast(); }
    catch (e) { say(`Couldn't save: ${e.message || e}`); }
    return next;
  };
  const remove = async it => {
    try { await deleteItemK(BOARD_KEY, it.id); broadcast(); setOpenId(null); say("Deleted"); }
    catch (e) { say(`Couldn't delete: ${e.message || e}`); }
  };
  const moveTo = (it, key) => {
    if (it.kind === "shoot") {
      if ((it.stage || "plan") === key && stageOf(it) === key) return;
      return save(it, { stage: key, doneAt: key === "listed" ? iso() : "" });
    }
    if (key === "done" && it.recurring) {
      say(`Done — back on ${nextDue(it.dueDate, it.recurring)}`);
      return save(it, { status: "todo", dueDate: nextDue(it.dueDate, it.recurring), lastDoneAt: iso(), lastDoneBy: me });
    }
    return save(it, { status: key, doneAt: key === "done" ? iso() : "", doneBy: key === "done" ? me : "" });
  };
  const toggleDone = it => moveTo(it, it.status === "done" ? "todo" : "done");
  const advance = it => {
    const keys = cols.map(c => c.key);
    const i = keys.indexOf(stageOf(it));
    if (i < keys.length - 1) moveTo(it, keys[i + 1]);
  };

  /* ── quick add ── */
  const [draft, setDraft] = useState("");
  const [draftWho, setDraftWho] = useState(() => isAdmin ? [] : [me]);
  const [draftDue, setDraftDue] = useState("");
  const [draftOpts, setDraftOpts] = useState(false);
  const addDraft = async () => {
    const text = draft.trim();
    if (!text) return;
    const [title, ...rest] = text.split(/\n/);
    const it = {
      id: uid(), kind: view === "photo" ? "shoot" : "task", title: title.trim(), notes: rest.join("\n").trim(),
      assignees: draftWho, shared: !draftWho.length, dueDate: draftDue,
      status: "todo", stage: "plan", createdBy: me, createdAt: iso(), comments: [],
    };
    setDraft(""); setDraftDue("");
    await save(it);
    say(draftWho.length ? `Added for ${draftWho.map(k => k === me ? "you" : people.find(p => p.key === k)?.name.split(" ")[0] || k).join(", ")}` : "Added to common");
  };

  /* ── old to-do list ── */
  const [oldTodos, setOldTodos] = useState([]);
  const [oldHidden, setOldHidden] = useState(() => { try { return localStorage.getItem(`ng-team-oldmoved-${me}`) === "1"; } catch { return false; } });
  useEffect(() => { if (me) loadK(oldTodoKey(me)).then(d => setOldTodos(Array.isArray(d) ? d.filter(x => x?.id && !x.done) : [])).catch(() => {}); }, [me]);
  const moveOld = async () => {
    const key = oldTodoKey(me);
    const fresh = await loadKFresh(key).catch(() => null);
    const list = (Array.isArray(fresh) ? fresh : oldTodos).filter(x => x?.id);
    const pending = list.filter(x => !x.done);
    if (!pending.length) { setOldTodos([]); return; }
    const moved = pending.map(x => ({
      id: `todo-${x.id}`, kind: "task", title: x.text || "Task", notes: "", photos: x.photos || [],
      assignees: [me], shared: false, dueDate: x.dueDate || "", recurring: x.recurring || "",
      status: "todo", createdBy: x.assignedBy ? "admin" : me, createdAt: x.createdAt || iso(), comments: [],
      ...(x.assignedBy ? { notes: `Assigned by ${x.assignedBy}` } : {}),
    }));
    try {
      await upsertItemsK(BOARD_KEY, moved);
      broadcast();
      await saveK(key, list.filter(x => x.done));
      setOldTodos([]);
      try { localStorage.setItem(`ng-team-oldmoved-${me}`, "1"); } catch {}
      say(`Moved ${moved.length} to the board`);
    } catch (e) { say(`Couldn't move them: ${e.message || e}`); }
  };

  const open = openId ? items.find(x => x.id === openId) : null;
  useEffect(() => {
    const k = e => { if (e.key === "Escape") { setOpenId(null); setPicker(false); } };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  }, []);

  const todayLabel = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });
  const myName = isAdmin ? "" : String(currentUser?.name || "").split(" ")[0];
  const plannedStockIds = new Set(items.filter(it => it.kind === "shoot" && it.stockId && stageOf(it) !== "listed").map(it => it.stockId));
  const pad = mob ? 12 : 28;

  return (
    <div style={{ minHeight: "100%", background: `radial-gradient(1200px 500px at 10% -10%, rgba(176,125,18,.08), transparent 60%), ${C.bg}`, color: C.ink, fontFamily: "-apple-system,'SF Pro Display','Figtree',system-ui,sans-serif", paddingBottom: mob ? "calc(90px + env(safe-area-inset-bottom))" : 60 }}>
      <style>{`.tb-card:hover{transform:translateY(-1px);box-shadow:0 2px 4px rgba(26,19,8,.06),0 10px 24px rgba(26,19,8,.08)!important}.tb-col::-webkit-scrollbar{width:6px}.tb-col::-webkit-scrollbar-thumb{background:rgba(0,0,0,.12);border-radius:3px}@keyframes tbIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}`}</style>

      {/* Header */}
      <div style={{ position: "sticky", top: 0, zIndex: 50, background: "var(--c-topbar,rgba(255,255,255,0.78))", backdropFilter: "blur(18px) saturate(170%)", WebkitBackdropFilter: "blur(18px) saturate(170%)", borderBottom: `0.5px solid ${C.border}`, padding: `${mob ? 10 : 14}px ${pad}px ${mob ? 10 : 12}px`, paddingTop: mob ? "calc(10px + env(safe-area-inset-top))" : 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: mob ? 8 : 14, flexWrap: "wrap" }}>
          <button onClick={onHome} style={{ border: `1px solid ${C.border}`, background: C.surface, borderRadius: 10, padding: mob ? "7px 10px" : "6px 12px", fontSize: 13, color: C.inkMid, cursor: "pointer", fontFamily: "inherit" }}>‹ {mob ? "" : "Home"}</button>
          <div style={{ minWidth: 0, flex: mob ? 1 : "0 1 auto" }}>
            <div style={{ fontFamily: SERIF, fontSize: mob ? 24 : 30, fontWeight: 600, lineHeight: 1, letterSpacing: .2 }}>Team Board</div>
            <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 3 }}>{myName ? `Hi ${myName} · ` : ""}{todayLabel}</div>
          </div>
          {!mob && <div style={{ flex: 1 }} />}
          <div style={{ display: "flex", background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 3, order: mob ? 5 : 0, width: mob ? "100%" : "auto" }}>
            {[["tasks", "✓ Tasks", tasks.filter(t => (t.status || "todo") !== "done").length], ["photo", "📷 Photography plan", shoots.filter(s => stageOf(s) !== "listed").length]].map(([k, label, n]) => (
              <button key={k} onClick={() => { setView(k); setMobCol(0); }}
                style={{ flex: 1, border: "none", borderRadius: 9, padding: mob ? "8px 10px" : "7px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", background: view === k ? C.surface : "transparent", color: view === k ? C.ink : C.inkMid, boxShadow: view === k ? "0 1px 3px rgba(0,0,0,.1)" : "none", whiteSpace: "nowrap" }}>
                {label} <span style={{ color: C.inkFaint, fontWeight: 600 }}>{n}</span>
              </button>
            ))}
          </div>
          <button onClick={() => setPicker(true)}
            style={{ border: "none", background: C.ink, color: "#FAF0DC", borderRadius: 10, padding: mob ? "9px 12px" : "9px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap", boxShadow: "0 4px 14px rgba(26,19,8,.18)" }}>
            💎 {mob ? "Plan" : "Plan from stock cards"}
          </button>
        </div>

        {/* People strip + search */}
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 11, overflowX: "auto", paddingBottom: 2, scrollbarWidth: "none" }}>
          <Chip on={who === "all"} onClick={() => setWho("all")}>{isAdmin ? "Everyone" : "All I can see"}</Chip>
          <Chip on={who === "mine"} onClick={() => setWho("mine")}>Mine <span style={{ opacity: .7 }}>{openOf(me)}</span></Chip>
          <Chip on={who === "common"} onClick={() => setWho("common")} color="#1A6A6A">Common <span style={{ opacity: .7 }}>{commonOpen}</span></Chip>
          {isAdmin && <span style={{ width: 1, height: 20, background: C.border, margin: "0 4px", flexShrink: 0 }} />}
          {isAdmin && people.filter(p => p.key !== me).map(p => (
            <button key={p.key} onClick={() => setWho(who === p.key ? "all" : p.key)}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 11px 3px 3px", borderRadius: 20, border: `1px solid ${who === p.key ? p.color : C.border}`, background: who === p.key ? p.color : C.surface, color: who === p.key ? "#FAF0DC" : C.inkMid, fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", fontFamily: "inherit", flexShrink: 0 }}>
              <Avatar p={p} size={22} />{p.name.split(" ")[0]} <span style={{ opacity: .7 }}>{openOf(p.key)}</span>
            </button>
          ))}
          <span style={{ flex: 1, minWidth: 8 }} />
          {!mob && <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search the board…" style={{ ...FI, width: 220, borderRadius: 20, padding: "6px 14px", flexShrink: 0 }} />}
        </div>
      </div>

      <div style={{ padding: `${mob ? 12 : 18}px ${pad}px 0` }}>
        {/* Old personal list */}
        {oldTodos.length > 0 && !oldHidden && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, background: C.goldLight, border: `1px solid ${C.borderHi}`, borderRadius: 12, padding: "10px 14px", marginBottom: 14, flexWrap: "wrap" }}>
            <span style={{ fontSize: 18 }}>📝</span>
            <div style={{ flex: 1, minWidth: 180, fontSize: 13, color: C.ink }}><b>{oldTodos.length}</b> open item{oldTodos.length === 1 ? "" : "s"} on your old to-do list. Move them here so everything is in one place.</div>
            <button onClick={moveOld} style={{ border: "none", background: C.ink, color: "#FAF0DC", borderRadius: 8, padding: "7px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Move them onto the board</button>
            <button onClick={() => { setOldHidden(true); try { localStorage.setItem(`ng-team-oldmoved-${me}`, "1"); } catch {} }} style={{ border: "none", background: "none", color: C.inkFaint, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>Not now</button>
          </div>
        )}

        {/* Composer */}
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: mob ? 10 : 12, marginBottom: 16, boxShadow: "0 1px 2px rgba(26,19,8,.04)" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 18, color: C.inkFaint, paddingLeft: 4 }}>{view === "photo" ? "📷" : "＋"}</span>
            <input id="ng-team-input" value={draft} onChange={e => setDraft(e.target.value)} onFocus={() => setDraftOpts(true)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addDraft(); } }}
              placeholder={view === "photo" ? "Add a shoot — e.g. “Shoot the 6 labradorite spheres on the grey cloth”" : "Add a task for the team, press Enter…"}
              style={{ ...FI, border: "none", background: "transparent", fontSize: mob ? 16 : 15, padding: "8px 4px", flex: 1, boxShadow: "none", outline: "none" }} />
            <button onClick={addDraft} disabled={!draft.trim()}
              style={{ border: "none", background: draft.trim() ? C.gold : C.card, color: draft.trim() ? "#fff" : C.inkFaint, borderRadius: 10, padding: "8px 16px", fontSize: 13, fontWeight: 700, cursor: draft.trim() ? "pointer" : "default", fontFamily: "inherit" }}>Add</button>
          </div>
          {(draftOpts || draft) && (
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 8, paddingTop: 9, borderTop: `1px dashed ${C.border}`, animation: "tbIn .15s ease" }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .7 }}>For</span>
              <PersonPicker people={people} value={draftWho} onChange={setDraftWho} me={me} />
              <Chip on={!draftWho.length} onClick={() => setDraftWho([])} color="#1A6A6A" title="Everyone sees it; anyone can pick it up">Common</Chip>
              <span style={{ flex: 1 }} />
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.inkMid }}>Due
                <input type="date" value={draftDue} onChange={e => setDraftDue(e.target.value)} style={{ ...FI, width: "auto", padding: "5px 8px" }} />
              </label>
            </div>
          )}
        </div>

        {mob && <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search the board…" style={{ ...FI, borderRadius: 20, padding: "8px 14px", marginBottom: 12 }} />}

        {/* Phone: one column at a time */}
        {mob && (
          <div style={{ display: "flex", gap: 6, overflowX: "auto", marginBottom: 12, scrollbarWidth: "none" }}>
            {cols.map((c, i) => (
              <button key={c.key} onClick={() => setMobCol(i)}
                style={{ flexShrink: 0, border: `1px solid ${mobCol === i ? c.color : C.border}`, background: mobCol === i ? c.color : C.surface, color: mobCol === i ? "#fff" : C.inkMid, borderRadius: 20, padding: "7px 13px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                {c.label} <span style={{ opacity: .75 }}>{byCol[c.key].length}</span>
              </button>
            ))}
          </div>
        )}

        {/* Columns */}
        <div style={{ display: mob ? "block" : "grid", gridTemplateColumns: `repeat(${cols.length}, minmax(250px, 1fr))`, gap: 16, alignItems: "start", overflowX: mob ? "visible" : "auto" }}>
          {cols.map((c, i) => (mob && i !== mobCol) ? null : (
            <div key={c.key}
              onDragOver={e => { if (!dragId) return; e.preventDefault(); setOverCol(c.key); }}
              onDragLeave={() => setOverCol(o => o === c.key ? null : o)}
              onDrop={e => { e.preventDefault(); const id = e.dataTransfer.getData("text/plain") || dragId; const it = items.find(x => x.id === id); setOverCol(null); setDragId(null); if (it) moveTo(it, c.key); }}
              style={{ background: overCol === c.key ? c.bg : mob ? "transparent" : "rgba(140,126,102,.06)", border: mob ? "none" : `1px solid ${overCol === c.key ? c.color : "transparent"}`, borderRadius: 18, padding: mob ? 0 : 10, transition: "background .12s, border-color .12s", minHeight: mob ? 0 : 320 }}>
              {!mob && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 6px 10px" }}>
                  <span style={{ width: 26, height: 26, borderRadius: 13, background: c.bg, color: c.color, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 800 }}>{c.icon}</span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>{c.label}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: c.color, background: c.bg, borderRadius: 10, padding: "1px 8px" }}>{byCol[c.key].length}</span>
                </div>
              )}
              <div className="tb-col" style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: mob ? "none" : "calc(100vh - 330px)", overflowY: mob ? "visible" : "auto", paddingRight: mob ? 0 : 2, paddingBottom: 4 }}>
                {byCol[c.key].map(it => (
                  <div key={it.id} style={{ animation: "tbIn .18s ease both" }}>
                    <BoardCard it={it} info={it.kind === "shoot" ? infos.get(it.id) : null} col={c} people={people} me={me} isNew={isNew(it)}
                      dragging={dragId === it.id} onDragStart={setDragId} onOpen={setOpenId} onToggle={toggleDone}
                      onAdvance={i < cols.length - 1 ? advance : null} />
                  </div>
                ))}
                {byCol[c.key].length === 0 && (
                  <div style={{ border: `1.5px dashed ${C.border}`, borderRadius: 14, padding: "22px 12px", textAlign: "center", fontSize: 12, color: C.inkFaint, lineHeight: 1.5 }}>
                    {i === 0 ? (view === "photo" ? <>Nothing to photograph.<br /><button onClick={() => setPicker(true)} style={{ marginTop: 8, border: "none", background: "none", color: C.gold, fontWeight: 700, cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>Pick stock cards →</button></> : "All clear 🎉") : mob ? "Nothing here" : "Drag cards here"}
                  </div>
                )}
                {c.key === lastCol && hiddenDone > 0 && (
                  <button onClick={() => setShowAllDone(true)} style={{ border: "none", background: "none", color: C.inkFaint, fontSize: 12, cursor: "pointer", padding: 6, fontFamily: "inherit" }}>+ {hiddenDone} older</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {open && <DetailPanel it={open} info={open.kind === "shoot" ? shootInfo(open) : null} stage={stageOf(open)} people={people} me={me} isAdmin={isAdmin}
        onClose={() => setOpenId(null)} onSave={save} onMove={moveTo} onDelete={remove} onOpenModule={onOpenModule} onOpenStock={onOpenStock} listings={listings} />}
      {picker && <StockPicker stock={stock} listingsByStock={listingsByStock} planned={plannedStockIds} people={people} me={me} isAdmin={isAdmin}
        onClose={() => setPicker(false)}
        onCreate={async made => {
          try { await upsertItemsK(BOARD_KEY, made); broadcast(); setPicker(false); setView("photo"); setMobCol(0); say(`${made.length} added to the photography plan`); }
          catch (e) { say(`Couldn't add: ${e.message || e}`); }
        }} />}
      {toast && <div style={{ position: "fixed", left: "50%", transform: "translateX(-50%)", bottom: mob ? "calc(84px + env(safe-area-inset-bottom))" : 28, zIndex: 3000, background: C.ink, color: "#FAF0DC", padding: "10px 18px", borderRadius: 12, fontSize: 13, boxShadow: "0 10px 30px rgba(0,0,0,.25)", animation: "tbIn .15s ease" }}>{toast}</div>}
    </div>
  );
}

/* ─── Detail panel ────────────────────────────────────────────── */
function DetailPanel({ it, info, stage, people, me, isAdmin, onClose, onSave, onMove, onDelete, onOpenModule, onOpenStock, listings }) {
  const shoot = it.kind === "shoot";
  const [title, setTitle] = useState(it.title || "");
  const [notes, setNotes] = useState(it.notes || "");
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  useEffect(() => { setTitle(it.title || ""); setNotes(it.notes || ""); }, [it.id]);
  const cols = shoot ? SHOOT_COLS : TASK_COLS;
  const by = k => people.find(p => p.key === k) || { key: k, name: k === "admin" ? "Admin" : isAdmin ? (k || "Someone") : "Teammate", color: "#999" };
  const canDelete = isAdmin || it.createdBy === me;
  const commit = patch => onSave(it, patch);
  const addComment = async () => {
    const text = comment.trim();
    if (!text || sending) return;
    setSending(true);
    // Read the item fresh first, so two people commenting at once both land.
    const fresh = await loadKFresh(BOARD_KEY).catch(() => null);
    const cur = (Array.isArray(fresh) ? fresh : []).find(x => x.id === it.id) || it;
    await onSave(cur, { comments: [...(cur.comments || []), { id: uid(), by: me, text, at: iso() }] });
    setComment(""); setSending(false);
  };
  const card = info?.card;
  const label = { fontSize: 10, fontWeight: 800, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .9, marginBottom: 7 };
  const section = { padding: "14px 0", borderTop: `1px solid ${C.border}` };
  return (
    <div onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 1300, background: "rgba(20,15,8,.38)", display: "flex", justifyContent: "flex-end", animation: "fadeIn .15s ease" }}>
      <div style={{ width: "100%", maxWidth: mob ? "100%" : 520, height: "100%", background: C.bg, display: "flex", flexDirection: "column", boxShadow: "-14px 0 44px rgba(0,0,0,.2)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 18px", paddingTop: "calc(12px + env(safe-area-inset-top))", borderBottom: `1px solid ${C.border}`, background: C.surface }}>
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: .8, textTransform: "uppercase", color: shoot ? C.purple : C.gold }}>{shoot ? "📷 Photography plan" : "✓ Task"}</span>
          <span style={{ flex: 1 }} />
          <button onClick={() => commit({ priority: !it.priority })} title="Urgent" style={{ border: `1px solid ${it.priority ? C.red : C.border}`, background: it.priority ? C.redBg : "none", color: it.priority ? C.red : C.inkFaint, borderRadius: 8, padding: "4px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>⚑ {it.priority ? "Urgent" : "Mark urgent"}</button>
          <button onClick={onClose} aria-label="Close" style={{ border: "none", background: "none", fontSize: 26, lineHeight: 1, color: C.inkMid, cursor: "pointer", padding: "0 2px" }}>×</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px", paddingBottom: "calc(24px + env(safe-area-inset-bottom))" }}>
          <textarea value={title} onChange={e => setTitle(e.target.value)} onBlur={() => title.trim() && title !== it.title && commit({ title: title.trim() })} rows={1}
            style={{ ...FI, fontFamily: SERIF, fontSize: 24, fontWeight: 600, border: "none", background: "transparent", padding: 0, resize: "none", lineHeight: 1.2, minHeight: 34, boxShadow: "none" }} />

          {/* Stage stepper */}
          <div style={{ display: "flex", gap: 4, margin: "14px 0 16px" }}>
            {cols.map((c, i) => {
              const at = cols.findIndex(x => x.key === stage);
              const on = i <= at;
              return (
                <button key={c.key} onClick={() => onMove(it, c.key)}
                  style={{ flex: 1, border: "none", borderRadius: 8, padding: "8px 4px", background: on ? c.color : C.card, color: on ? "#fff" : C.inkMid, fontSize: mob ? 11 : 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", boxShadow: i === at ? `0 0 0 2px ${C.bg}, 0 0 0 4px ${c.color}` : "none" }}>
                  {c.label}
                </button>
              );
            })}
          </div>
          {shoot && info && info.auto !== "plan" && STAGE_ORDER.indexOf(info.auto) > STAGE_ORDER.indexOf(it.stage || "plan") && (
            <div style={{ fontSize: 11.5, color: C.teal, background: C.tealBg, borderRadius: 8, padding: "7px 10px", marginTop: -6, marginBottom: 12 }}>
              Moved to <b>{SHOOT_COLS.find(c => c.key === info.auto)?.label}</b> by itself: {info.auto === "listed" ? "its listing is live" : info.auto === "listing" ? "a listing was made from this stock card" : "the stock card has new photos"}.
            </div>
          )}

          <div style={label}>{shoot ? "What listing to make" : "Notes"}</div>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} onBlur={() => notes !== (it.notes || "") && commit({ notes })} rows={4}
            placeholder={shoot ? "e.g. One unique listing per sphere, photograph on the black stand, Etsy + Earth Editions" : "Details, links, anything that helps…"}
            style={{ ...FI, resize: "vertical", lineHeight: 1.5, marginBottom: 14 }} />

          <div style={section}>
            <div style={label}>Assigned to</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <PersonPicker people={people} value={it.assignees || []} onChange={v => { const next = isAdmin ? v : [...(it.assignees || []).filter(k => k !== me), ...v]; commit({ assignees: next, shared: !next.length ? true : !!it.shared }); }} me={me} />
              <Chip on={!!it.shared || !(it.assignees || []).length} onClick={() => commit({ shared: !(it.shared || !(it.assignees || []).length) })} color="#1A6A6A" title="Common items are visible to the whole team">Common</Chip>
            </div>
          </div>

          <div style={{ ...section, display: "flex", gap: 14, flexWrap: "wrap" }}>
            <label style={{ flex: 1, minWidth: 140 }}><div style={label}>Due</div>
              <input type="date" value={it.dueDate || ""} onChange={e => commit({ dueDate: e.target.value })} style={FI} /></label>
            {!shoot && <label style={{ flex: 1, minWidth: 140 }}><div style={label}>Repeats</div>
              <select value={it.recurring || ""} onChange={e => commit({ recurring: e.target.value })} style={FI}>
                {Object.entries(RECUR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select></label>}
          </div>

          {shoot && (
            <div style={section}>
              <div style={label}>Make it for</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {PLATFORMS.map(p => { const on = (it.platforms || []).includes(p.key); return <Chip key={p.key} on={on} onClick={() => commit({ platforms: on ? it.platforms.filter(x => x !== p.key) : [...(it.platforms || []), p.key] })}>{p.label}</Chip>; })}
              </div>
            </div>
          )}

          {shoot && it.stockId && (
            <div style={section}>
              <div style={label}>Stock card</div>
              <div style={{ display: "flex", gap: 12, alignItems: "center", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 10 }}>
                {(info?.photo || it.stockPhoto) ? <img src={thumb(info?.photo || it.stockPhoto, 200)} alt="" style={{ width: 64, height: 64, borderRadius: 9, objectFit: "cover", flexShrink: 0 }} /> : <div style={{ width: 64, height: 64, borderRadius: 9, background: C.card, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24 }}>💎</div>}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>{card ? stockLabel(card) : it.stockLabel}</div>
                  <div style={{ fontSize: 11.5, color: C.inkMid, marginTop: 2 }}>
                    {[card?.location || it.stockLocation, card?.sku || it.stockSku, card ? `${photosOf(card).length} photo${photosOf(card).length === 1 ? "" : "s"}` : "card not found"].filter(Boolean).join(" · ")}
                  </div>
                </div>
                {onOpenStock && <button onClick={() => onOpenStock(it.stockId)} style={{ border: `1px solid ${C.border}`, background: C.card, borderRadius: 8, padding: "6px 10px", fontSize: 12, fontWeight: 600, color: C.inkMid, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>Open card ›</button>}
              </div>
            </div>
          )}

          {shoot && (
            <div style={section}>
              <div style={label}>Listing</div>
              {info?.listing ? (
                <div style={{ display: "flex", gap: 12, alignItems: "center", background: C.surface, border: `1px solid ${info.live ? C.green : C.border}`, borderRadius: 12, padding: 10 }}>
                  {info.listingImg && <img src={thumb(info.listingImg, 200)} alt="" style={{ width: 52, height: 52, borderRadius: 8, objectFit: "cover" }} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{info.listing.title || "Untitled listing"}</div>
                    <div style={{ fontSize: 11.5, color: info.live ? C.green : C.purple, fontWeight: 600, marginTop: 2 }}>
                      {info.live ? `Live on ${Object.entries(info.listing.platforms || {}).filter(([, p]) => p?.status === "active").map(([k]) => PLATFORMS.find(p => p.key === k)?.label || k).join(", ")}` : "Draft — not live yet"}
                      <span style={{ color: C.inkFaint, fontWeight: 500 }}> · {info.listing.listing_order_id || ""}</span>
                    </div>
                  </div>
                </div>
              ) : <div style={{ fontSize: 12.5, color: C.inkFaint }}>No listing yet. It links by itself when a listing is made from this stock card.</div>}
              {(info?.cands || []).length > 0 && (
                <select value={it.listingId || ""} onChange={e => commit({ listingId: e.target.value })} style={{ ...FI, marginTop: 8 }}>
                  <option value="">Link automatically (newest made after planning)</option>
                  {info.cands.map(l => <option key={l.id} value={l.id}>{(l.listing_order_id ? l.listing_order_id + " — " : "") + (l.title || "Untitled")}{isLiveListing(l) ? " · live" : ""}</option>)}
                </select>
              )}
              {onOpenModule && <button onClick={() => onOpenModule("etsy")} style={{ marginTop: 8, border: `1px solid ${C.border}`, background: C.card, borderRadius: 8, padding: "7px 12px", fontSize: 12, fontWeight: 600, color: C.inkMid, cursor: "pointer", fontFamily: "inherit" }}>Open Listing Manager ›</button>}
            </div>
          )}

          {(it.photos || []).length > 0 && (
            <div style={section}>
              <div style={label}>Photos</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{it.photos.map(u => <a key={u} href={u} target="_blank" rel="noreferrer"><img src={thumb(u, 200)} alt="" style={{ width: 84, height: 84, borderRadius: 9, objectFit: "cover" }} /></a>)}</div>
            </div>
          )}

          {/* Conversation */}
          <div style={section}>
            <div style={label}>Conversation</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 10 }}>
              {(it.comments || []).map(c => { const p = by(c.by); return (
                <div key={c.id} style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
                  <Avatar p={p} size={26} />
                  <div style={{ flex: 1, background: c.by === me ? C.goldLight : C.surface, border: `1px solid ${C.border}`, borderRadius: "4px 12px 12px 12px", padding: "7px 11px" }}>
                    <div style={{ fontSize: 11, color: C.inkFaint, marginBottom: 2 }}><b style={{ color: C.inkMid }}>{c.by === me ? "You" : p.name.split(" ")[0]}</b> · {ago(c.at)}</div>
                    <div style={{ fontSize: 13, color: C.ink, whiteSpace: "pre-wrap", lineHeight: 1.45 }}>{c.text}</div>
                  </div>
                </div>
              ); })}
              {!(it.comments || []).length && <div style={{ fontSize: 12, color: C.inkFaint }}>No messages yet. Ask a question or leave an update for the team.</div>}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input value={comment} onChange={e => setComment(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addComment(); }} placeholder="Write an update…" style={{ ...FI, flex: 1 }} />
              <button onClick={addComment} disabled={!comment.trim() || sending} style={{ border: "none", background: comment.trim() ? C.ink : C.card, color: comment.trim() ? "#FAF0DC" : C.inkFaint, borderRadius: 8, padding: "0 14px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>{sending ? "…" : "Send"}</button>
            </div>
          </div>

          <div style={{ ...section, display: "flex", alignItems: "center", gap: 10, fontSize: 11.5, color: C.inkFaint }}>
            <span style={{ flex: 1 }}>Added by {it.createdBy === me ? "you" : by(it.createdBy).name.split(" ")[0]} · {ago(it.createdAt)}{it.updatedBy && it.updatedAt ? ` · last change by ${it.updatedBy === me ? "you" : by(it.updatedBy).name.split(" ")[0]} ${ago(it.updatedAt)}` : ""}</span>
            {canDelete && <button onClick={() => { if (window.confirm("Delete this card for everyone?")) onDelete(it); }} style={{ border: `1px solid ${C.border}`, background: "none", color: C.red, borderRadius: 8, padding: "5px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Delete</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Pick stock cards for the photography plan ───────────────── */
function StockPicker({ stock, listingsByStock, planned, people, me, isAdmin, onClose, onCreate }) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("nophoto");
  const [limit, setLimit] = useState(60);
  const [sel, setSel] = useState([]);            // [{id, note}]
  const [whoFor, setWhoFor] = useState(() => isAdmin ? [] : [me]);
  const [due, setDue] = useState("");
  const [plats, setPlats] = useState(["etsy", "store"]);
  const [busy, setBusy] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { if (!mob) inputRef.current?.focus(); }, []);
  const ql = q.trim().toLowerCase();
  const physical = useMemo(() => stock.filter(s => s?.id && s.type !== "accounting" && !s.archived && !s.deleted), [stock]);
  const listed = s => (listingsByStock.get(s.id) || []).some(isLiveListing);
  const shown = useMemo(() => physical.filter(s => {
    if (filter === "nophoto" && photosOf(s).length) return false;
    if (filter === "unlisted" && (listed(s) || s.postedEtsy)) return false;
    if (filter === "photographed" && (!photosOf(s).length || listed(s) || s.postedEtsy)) return false;
    // Nothing left on the card: only under "All cards".
    if (filter !== "all" && !(+s.qty > 0) && !(+s.qty2 > 0)) return false;
    if (!ql) return true;
    return [s.material, s.shape, s.size, s.location, s.sku, s.notes, s.vendor, s.origin].some(v => String(v || "").toLowerCase().includes(ql));
  }).sort((a, b) => String(b.addedDate || b.createdAt || "").localeCompare(String(a.addedDate || a.createdAt || ""))), [physical, filter, ql, listingsByStock]);
  const selIds = new Set(sel.map(x => x.id));
  const toggle = s => setSel(v => selIds.has(s.id) ? v.filter(x => x.id !== s.id) : [...v, { id: s.id, note: "" }]);
  const byId = new Map(physical.map(s => [s.id, s]));
  const create = async () => {
    if (!sel.length || busy) return;
    setBusy(true);
    const at = iso();
    const made = sel.map((x, i) => {
      const s = byId.get(x.id) || {};
      const note = x.note.trim();
      return {
        id: uid(), kind: "shoot", title: stockLabel(s), notes: note,
        stockId: s.id, stockLabel: stockLabel(s), stockLocation: s.location || "", stockSku: s.sku || "", stockPhoto: photosOf(s)[0] || "",
        photosAtPlan: photosOf(s).length, platforms: plats,
        assignees: whoFor, shared: !whoFor.length, dueDate: due,
        stage: "plan", status: "todo", createdBy: me, createdAt: new Date(Date.parse(at) - i).toISOString(), comments: [],
      };
    });
    await onCreate(made);
    setBusy(false);
  };
  const FILTERS = [["nophoto", "Not photographed"], ["photographed", "Photographed, not listed"], ["unlisted", "Not listed"], ["all", "All cards"]];
  const tray = (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ padding: "14px 16px 10px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 600 }}>{sel.length ? `${sel.length} card${sel.length === 1 ? "" : "s"} picked` : "Pick cards on the left"}</div>
        <div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 2 }}>Say what listing to make from each one.</div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "10px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
        {sel.map(x => { const s = byId.get(x.id) || {}; const ph = photosOf(s)[0]; return (
          <div key={x.id} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 10 }}>
            <div style={{ display: "flex", gap: 9, alignItems: "center", marginBottom: 7 }}>
              {ph ? <img src={thumb(ph, 120)} alt="" style={{ width: 36, height: 36, borderRadius: 7, objectFit: "cover" }} /> : <span style={{ width: 36, height: 36, borderRadius: 7, background: C.card, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>💎</span>}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{stockLabel(s)}</div>
                <div style={{ fontSize: 11, color: C.inkFaint }}>{[s.location, s.sku].filter(Boolean).join(" · ")}</div>
              </div>
              <button onClick={() => toggle(s)} aria-label="Remove" style={{ border: "none", background: "none", color: C.inkFaint, fontSize: 18, cursor: "pointer" }}>×</button>
            </div>
            <textarea value={x.note} onChange={e => setSel(v => v.map(y => y.id === x.id ? { ...y, note: e.target.value } : y))} rows={2}
              placeholder="What listing to make — e.g. “3 unique listings, the big one for Atyahara”"
              style={{ ...FI, resize: "vertical", fontSize: mob ? 16 : 12.5, lineHeight: 1.4 }} />
          </div>
        ); })}
      </div>
      <div style={{ padding: "12px 16px", paddingBottom: "calc(12px + env(safe-area-inset-bottom))", borderTop: `1px solid ${C.border}`, background: C.surface, display: "flex", flexDirection: "column", gap: 10 }}>
        <div><div style={{ fontSize: 10, fontWeight: 800, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .9, marginBottom: 6 }}>For</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}><PersonPicker people={people} value={whoFor} onChange={setWhoFor} me={me} /><Chip on={!whoFor.length} onClick={() => setWhoFor([])} color="#1A6A6A">Common</Chip></div></div>
        <div><div style={{ fontSize: 10, fontWeight: 800, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .9, marginBottom: 6 }}>List on</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{PLATFORMS.map(p => { const on = plats.includes(p.key); return <Chip key={p.key} on={on} onClick={() => setPlats(on ? plats.filter(x => x !== p.key) : [...plats, p.key])}>{p.label}</Chip>; })}</div></div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ fontSize: 12, color: C.inkMid, display: "flex", alignItems: "center", gap: 6 }}>Due <input type="date" value={due} onChange={e => setDue(e.target.value)} style={{ ...FI, width: "auto", padding: "5px 8px" }} /></label>
          <span style={{ flex: 1 }} />
          <button onClick={create} disabled={!sel.length || busy}
            style={{ border: "none", background: sel.length ? C.gold : C.card, color: sel.length ? "#fff" : C.inkFaint, borderRadius: 10, padding: "10px 16px", fontSize: 13, fontWeight: 800, cursor: sel.length ? "pointer" : "default", fontFamily: "inherit", whiteSpace: "nowrap" }}>
            {busy ? "Adding…" : `Add ${sel.length || ""} to plan`}
          </button>
        </div>
      </div>
    </div>
  );
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1300, background: "rgba(20,15,8,.42)", display: "flex", alignItems: "stretch", justifyContent: "center", padding: mob ? 0 : 24, animation: "fadeIn .15s ease" }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ width: "100%", maxWidth: 1320, background: C.bg, borderRadius: mob ? 0 : 20, overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 24px 80px rgba(0,0,0,.3)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", paddingTop: mob ? "calc(12px + env(safe-area-inset-top))" : 12, borderBottom: `1px solid ${C.border}`, background: C.surface, flexWrap: "wrap" }}>
          <div style={{ fontFamily: SERIF, fontSize: 22, fontWeight: 600, flex: mob ? 1 : "0 0 auto" }}>Plan from stock cards</div>
          {mob && <button onClick={onClose} aria-label="Close" style={{ border: "none", background: "none", fontSize: 26, color: C.inkMid, cursor: "pointer" }}>×</button>}
          <input ref={inputRef} value={q} onChange={e => { setQ(e.target.value); setLimit(60); }} placeholder="Search material, shape, shelf, SKU…" style={{ ...FI, flex: 1, minWidth: 200, borderRadius: 20, padding: "8px 14px" }} />
          {!mob && <button onClick={onClose} aria-label="Close" style={{ border: "none", background: "none", fontSize: 26, color: C.inkMid, cursor: "pointer" }}>×</button>}
          <div style={{ display: "flex", gap: 6, overflowX: "auto", width: "100%", scrollbarWidth: "none" }}>
            {FILTERS.map(([k, l]) => <Chip key={k} on={filter === k} onClick={() => { setFilter(k); setLimit(60); }}>{l}</Chip>)}
            <span style={{ fontSize: 12, color: C.inkFaint, alignSelf: "center", marginLeft: 6, whiteSpace: "nowrap" }}>{shown.length} cards</span>
          </div>
        </div>
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <div style={{ flex: 1, overflowY: "auto", padding: mob ? 10 : 16, paddingBottom: mob ? 90 : 16 }}>
            <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${mob ? 150 : 170}px, 1fr))`, gap: mob ? 8 : 12 }}>
              {shown.slice(0, limit).map(s => {
                const on = selIds.has(s.id); const ph = photosOf(s)[0]; const inPlan = planned.has(s.id); const live = listed(s);
                return (
                  <button key={s.id} onClick={() => toggle(s)}
                    style={{ textAlign: "left", padding: 0, border: `2px solid ${on ? C.gold : "transparent"}`, borderRadius: 14, background: C.surface, cursor: "pointer", overflow: "hidden", boxShadow: on ? "0 6px 18px rgba(176,125,18,.25)" : "0 1px 3px rgba(26,19,8,.07)", fontFamily: "inherit", position: "relative", transition: "all .12s" }}>
                    <div style={{ height: mob ? 100 : 120, background: ph ? `${C.card} center/cover no-repeat url("${thumb(ph, 300)}")` : C.card, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, color: C.inkFaint }}>{!ph && "💎"}</div>
                    <span style={{ position: "absolute", top: 8, right: 8, width: 24, height: 24, borderRadius: 12, background: on ? C.gold : "rgba(255,255,255,.9)", border: on ? "none" : `1.5px solid ${C.border}`, color: "#fff", fontSize: 13, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>{on ? "✓" : ""}</span>
                    {(inPlan || live) && <span style={{ position: "absolute", top: 8, left: 8, fontSize: 9.5, fontWeight: 800, letterSpacing: .3, color: "#fff", background: live ? "rgba(42,104,69,.9)" : "rgba(90,58,138,.9)", borderRadius: 6, padding: "2px 6px" }}>{live ? "LISTED" : "IN PLAN"}</span>}
                    <div style={{ padding: "8px 10px 10px" }}>
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: C.ink, lineHeight: 1.25, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{stockLabel(s)}</div>
                      <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{[s.location, s.qty ? `${s.qty} ${s.unit || "pcs"}` : "", s.sku].filter(Boolean).join(" · ")}</div>
                    </div>
                  </button>
                );
              })}
            </div>
            {shown.length > limit && <div style={{ textAlign: "center", padding: 16 }}><button onClick={() => setLimit(l => l + 120)} style={{ border: `1px solid ${C.border}`, background: C.surface, borderRadius: 20, padding: "8px 18px", fontSize: 13, color: C.inkMid, cursor: "pointer", fontFamily: "inherit" }}>Show more ({shown.length - limit})</button></div>}
            {!shown.length && <div style={{ textAlign: "center", color: C.inkFaint, fontSize: 13, padding: 40 }}>{stock.length ? "No cards match." : "Loading stock…"}</div>}
          </div>
          {!mob && <div style={{ width: 380, borderLeft: `1px solid ${C.border}`, background: C.bg, display: "flex", flexDirection: "column", minHeight: 0 }}>{tray}</div>}
        </div>
        {mob && sel.length > 0 && !trayOpen && (
          <button onClick={() => setTrayOpen(true)} style={{ position: "fixed", left: 12, right: 12, bottom: "calc(14px + env(safe-area-inset-bottom))", zIndex: 1310, border: "none", background: C.ink, color: "#FAF0DC", borderRadius: 14, padding: "14px", fontSize: 15, fontWeight: 800, fontFamily: "inherit", boxShadow: "0 10px 30px rgba(0,0,0,.3)" }}>
            {sel.length} picked — add notes →
          </button>
        )}
        {mob && trayOpen && (
          <div style={{ position: "fixed", inset: 0, zIndex: 1320, background: C.bg, display: "flex", flexDirection: "column", paddingTop: "env(safe-area-inset-top)" }}>
            <button onClick={() => setTrayOpen(false)} style={{ border: "none", background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "12px 16px", textAlign: "left", fontSize: 14, color: C.inkMid, fontFamily: "inherit", cursor: "pointer" }}>‹ Back to cards</button>
            <div style={{ flex: 1, minHeight: 0 }}>{tray}</div>
          </div>
        )}
      </div>
    </div>
  );
}
