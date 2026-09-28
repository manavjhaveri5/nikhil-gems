/* Stories to post, worked out from the listings themselves: pieces that went
   live in the last week make "Just listed", pieces that sold in the last week
   make "Sold 🔥". Posting one (sharing or downloading it) ticks it off, on every
   device. Any older listing can be picked from the past-listings search below
   for either story. */
import { useEffect, useMemo, useState, lazy, Suspense } from "react";
import { C, FI } from "./lmTheme.js";
import { storyLists, listedAt, cover, ago, small, WEEK } from "./storyState.js";

const StoryStudio = lazy(() => import("./StoryStudio.jsx"));
const PAGE = 48;

const tab = on => ({ padding: "10px 14px", border: "none", background: "none", cursor: "pointer", fontSize: 14,
  fontWeight: on ? 700 : 500, color: on ? C.ink : C.inkMid, borderBottom: `2.5px solid ${on ? C.gold : "transparent"}`, marginBottom: -1 });
const head = { fontSize: 11, fontWeight: 800, letterSpacing: .8, textTransform: "uppercase", color: C.inkMid, margin: "4px 0 10px" };

function Tile({ r, kind, state, onOpen, onSkip }) {
  const img = cover(r.l);
  return (
    <div style={{ position: "relative", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", cursor: "pointer" }} onClick={onOpen}>
      <div style={{ aspectRatio: "1", background: C.card }}>
        <img src={small(img)} onError={e => { if (e.currentTarget.src !== img) e.currentTarget.src = img; }} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", opacity: state ? .55 : 1 }} />
      </div>
      <div style={{ padding: "7px 9px 8px" }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: C.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.l.title}</div>
        <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 2 }}>{r.verb || (kind === "sold" ? "Sold" : "Listed")} {r.at ? ago(r.at) : ""}</div>
      </div>
      {state && <span style={{ position: "absolute", top: 7, left: 7, fontSize: 10.5, fontWeight: 800, padding: "3px 8px", borderRadius: 20,
        background: state.how === "posted" ? C.greenBg : C.card, color: state.how === "posted" ? C.green : C.inkMid, border: `1px solid ${C.border}` }}>{state.how === "posted" ? "✓ Posted" : "Skipped"}</span>}
      {onSkip && !state && <button title="Skip — don't post a story for this one" onClick={e => { e.stopPropagation(); onSkip(); }}
        style={{ position: "absolute", top: 6, right: 6, width: 26, height: 26, borderRadius: 13, border: "none", background: "rgba(20,15,8,.7)", color: "#fff", fontSize: 14, cursor: "pointer", padding: 0, lineHeight: "26px" }}>×</button>}
    </div>
  );
}

export default function StoryQueue({ listings, orders, isLive, stories, onClose }) {
  const { done, mark } = stories;
  const lists = useMemo(() => storyLists(listings, orders, isLive, done), [listings, orders, isLive, done]);
  const [kind, setKind] = useState(() => lists.due.listed.length || !lists.due.sold.length ? "listed" : "sold");
  const [open, setOpen] = useState(null);
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [anyListing, setAnyListing] = useState(false);
  useEffect(() => { setShown(PAGE); }, [kind, q, anyListing]);
  useEffect(() => { const k = e => e.key === "Escape" && !open && onClose(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose, open]);

  const due = lists.due[kind];
  const recentDone = lists[kind].filter(r => Date.now() - r.at < WEEK && done[`${kind}:${r.l.id}`]);
  // Past listings: live ones for Just listed, ones that sold for Sold — or any listing at all.
  const past = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const base = anyListing
      ? (listings || []).filter(cover).map(l => lists[kind].find(r => r.l.id === l.id) || { l, at: listedAt(l), verb: "Listed" }).sort((a, b) => b.at - a.at)
      : lists[kind];
    return terms.length ? base.filter(r => { const h = `${r.l.title} ${r.l.material || ""} ${r.l.shape || ""} ${r.l.sku || ""}`.toLowerCase(); return terms.every(w => h.includes(w)); }) : base;
  }, [q, anyListing, kind, lists, listings]);

  const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 10 };
  const openIt = r => setOpen(r.l);

  return (
    <div onMouseDown={e => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, zIndex: 1250, background: "rgba(20,15,8,.45)", display: "flex", justifyContent: "flex-end" }}>
      <div style={{ width: "100%", maxWidth: 760, height: "100%", background: C.bg, display: "flex", flexDirection: "column", boxShadow: "-12px 0 40px rgba(0,0,0,.18)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", borderBottom: `1px solid ${C.border}`, background: C.surface }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: C.ink }}>Instagram stories</div>
            <div style={{ fontSize: 12, color: C.inkFaint }}>New and sold pieces from the last 7 days, found automatically</div>
          </div>
          <button onClick={onClose} style={{ border: "none", background: "none", fontSize: 24, cursor: "pointer", color: C.inkMid }}>×</button>
        </div>
        <div style={{ display: "flex", gap: 4, padding: "4px 14px 0", borderBottom: `1px solid ${C.border}`, background: C.surface }}>
          <button onClick={() => setKind("listed")} style={tab(kind === "listed")}>Just listed{lists.due.listed.length ? ` · ${lists.due.listed.length}` : ""}</button>
          <button onClick={() => setKind("sold")} style={tab(kind === "sold")}>Sold 🔥{lists.due.sold.length ? ` · ${lists.due.sold.length}` : ""}</button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          <div style={head}>To post</div>
          {due.length
            ? <div style={grid}>{due.map(r => <Tile key={r.l.id} r={r} kind={kind} onOpen={() => openIt(r)} onSkip={() => mark(kind, r.l, "skipped")} />)}</div>
            : <div style={{ fontSize: 13, color: C.inkMid, padding: "14px 0 6px" }}>{kind === "listed" ? "Nothing new went live in the last 7 days that still needs a story." : "No sales in the last 7 days that still need a story."}</div>}
          {kind === "listed" && due.length > 4 && <div style={{ fontSize: 12, color: C.inkFaint, marginTop: 8 }}>Tip: 3–4 Just listed stories a day is plenty — post the best, skip the rest with ×.</div>}

          {recentDone.length > 0 && (
            <>
              <div style={{ ...head, marginTop: 22 }}>Done this week</div>
              <div style={grid}>{recentDone.map(r => <Tile key={r.l.id} r={r} kind={kind} state={done[`${kind}:${r.l.id}`]} onOpen={() => openIt(r)} />)}</div>
            </>
          )}

          <div style={{ ...head, marginTop: 26 }}>Past listings</div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search by name, stone, shape, SKU…" style={FI({ flex: 1, minWidth: 200, fontSize: 14 })} />
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, color: C.inkMid, cursor: "pointer" }}>
              <input type="checkbox" checked={anyListing} onChange={e => setAnyListing(e.target.checked)} />
              {kind === "listed" ? "Include pieces not live now" : "Include pieces with no sale"}
            </label>
          </div>
          <div style={{ fontSize: 12, color: C.inkFaint, marginBottom: 10 }}>
            {anyListing ? `Every listing with a photo · ${past.length}` : kind === "listed" ? `Live now, newest first · ${past.length}` : `Sold, most recent first · ${past.length}`}
          </div>
          <div style={grid}>{past.slice(0, shown).map(r => <Tile key={r.l.id} r={r} kind={kind} state={done[`${kind}:${r.l.id}`]} onOpen={() => openIt(r)} />)}</div>
          {shown < past.length && <div style={{ textAlign: "center", marginTop: 14 }}>
            <button onClick={() => setShown(n => n + PAGE)} style={{ padding: "9px 18px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface, color: C.ink, fontWeight: 700, cursor: "pointer" }}>Show more</button>
          </div>}
        </div>
      </div>
      {open && (
        <Suspense fallback={null}>
          <StoryStudio listing={open} kind={kind} onShared={k => mark(k, open, "posted")} onClose={() => setOpen(null)} />
        </Suspense>
      )}
    </div>
  );
}
