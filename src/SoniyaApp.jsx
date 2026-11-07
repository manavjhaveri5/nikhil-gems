/* Soniya — Atyahara's brand & creative director. Same look as Raj.

   Her work (app_rows "soniya-work-v1") is written on Manav's Mac by the
   Claude scheduled task "soniya-weekly" (scripts/soniya/SONIYA.md): campaigns,
   Instagram posts, carousels, Reels, collections, naming and photo briefs, each
   in the brief's six parts. Sir approves, asks for changes or declines here.
   She never posts or publishes anything. Memory: "soniya-notes-v1". Brand book:
   app_data "soniya-brand-v1". Ask Soniya runs on /api/claude (metered by Girton). */
import { useState, useEffect, useMemo, useRef } from "react";
import { supabase } from "./supabase.js";
import { C, mob, FI } from "./lmTheme.js";
import { loadK, saveK } from "./utils.js";
import { fetchWithRetry } from "./aiClient.js";
import { Md, istDay } from "./RajApp.jsx";
import BRIEF from "./soniya/brief.md?raw";

const K = { work: "soniya-work-v1", notes: "soniya-notes-v1", brand: "soniya-brand-v1" };
const FONT = "-apple-system,'SF Pro Display','Figtree',system-ui,sans-serif";
const SERIF = "'Cormorant Garamond',Georgia,serif";
const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 16px", minWidth: 0 };
const btn = (bg = C.surface, fg = C.ink) => ({ background: bg, color: fg, border: bg === C.surface ? `1px solid ${C.border}` : "none", borderRadius: 7, padding: "7px 13px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" });
const lab = { fontSize: 9.5, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 4, display: "block" };
const h = { fontFamily: SERIF, fontSize: 18, fontWeight: 700, margin: "0 0 10px", color: C.ink };
const sub = { fontSize: 11.5, color: C.inkFaint };
const ACCENT = "#8A5A2B"; // terracotta-brown: Soniya's colour

const TYPE = { campaign: ["🎯", "Campaign"], post: ["▫️", "Post"], carousel: ["🎞", "Carousel"], reel: ["🎬", "Reel"], collection: ["🗂", "Collection"], naming: ["✍️", "Naming"], photo: ["📷", "Photo brief"] };
const SEG = { gifting: "Gifting", spiritual: "Spiritual", design: "Design", collector: "Collector" };
const PURPOSE = { identity: "Brand identity", educate: "Educate", desire: "Create desire", discovery: "Discovery", sales: "Sales", trust: "Trust" };
const STATUS = { proposed: ["Waiting for you", C.blue, C.blueBg], changes: ["Changes asked", C.amber, C.amberBg], approved: ["Approved", C.green, C.greenBg], published: ["Published", C.inkMid, C.card], declined: ["Declined", C.inkFaint, C.card] };
const NOTE = { decision: ["⚖️", "Decision"], lesson: ["🎓", "Lesson"], knowledge: ["📚", "Knowledge"], followup: ["📌", "Follow-up"], campaign: ["🎯", "Campaign result"] };
const Tag = ({ c = C.inkMid, bg = C.card, children }) => <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: .4, background: bg, color: c, borderRadius: 4, padding: "2px 6px", whiteSpace: "nowrap" }}>{children}</span>;
const grid = (cols, gap = 12) => ({ display: "grid", gridTemplateColumns: mob() ? "minmax(0,1fr)" : cols, gap });
const fmtDay = d => d ? new Date(`${d}T12:00:00+05:30`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : "";

async function rowsOf(key) {
  const { data, error } = await supabase.from("app_rows").select("data").eq("key", key).eq("deleted", false).order("pos", { ascending: true }).limit(1000);
  if (error) throw new Error(error.message);
  return (data || []).map(r => r.data);
}
async function put(key, item) {
  const { error } = await supabase.rpc("app_rows_upsert", { p_key: key, p_item: { ...item, updated_at: new Date().toISOString() }, p_prepend: false });
  if (error) throw new Error(error.message);
}

/* ── one piece of work, in the brief's six parts ───────────────────────── */
function Section({ n, title, children }) {
  if (!children) return null;
  return <div style={{ marginTop: 10 }}>
    <span style={lab}>{n}. {title}</span>
    <div style={{ fontSize: 13, color: C.ink, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{children}</div>
  </div>;
}
function Work({ w, onSave, compact }) {
  const [open, setOpen] = useState(!compact);
  const [mode, setMode] = useState(null); // "changes" | "decline"
  const [fb, setFb] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sl, sc, sbg] = STATUS[w.status] || STATUS.proposed;
  const [ti, tl] = TYPE[w.type] || ["•", w.type];
  const act = async (status, extra = {}) => { setBusy(true); try { await onSave({ ...w, status, ...extra }); setMode(null); setFb(""); } finally { setBusy(false); } };
  const copy = async () => { try { await navigator.clipboard.writeText(w.copy?.caption || ""); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {} };
  return <div style={{ ...card, padding: 0, overflow: "hidden", borderLeft: `3px solid ${w.status === "proposed" || w.status === "changes" ? ACCENT : w.status === "approved" ? C.green : C.border}` }}>
    <div style={{ padding: "13px 16px 11px" }}>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 7, alignItems: "center" }}>
        <Tag>{ti} {tl}</Tag>{w.segment && <Tag>{SEG[w.segment] || w.segment}</Tag>}{w.purpose && <Tag>{PURPOSE[w.purpose] || w.purpose}</Tag>}
        {w.date && <Tag c={ACCENT} bg="#F6EEE4">{fmtDay(w.date)}</Tag>}<Tag c={sc} bg={sbg}>{sl}</Tag>
      </div>
      <div onClick={() => setOpen(!open)} style={{ fontFamily: SERIF, fontSize: 19, fontWeight: 700, lineHeight: 1.2, cursor: "pointer" }}>{w.title}</div>
      {w.copy?.headline && <div style={{ marginTop: 4, fontSize: 13.5, color: C.inkMid, fontStyle: "italic" }}>“{w.copy.headline}”</div>}
      {!open && w.concept && <div style={{ marginTop: 6, fontSize: 13, color: C.inkMid, lineHeight: 1.5 }}>{w.concept}</div>}
      {open && <>
        <Section n={1} title="The insight">{w.insight}</Section>
        <Section n={2} title="The concept">{w.concept}</Section>
        <Section n={3} title="The art direction">{w.art_direction}</Section>
        {(w.copy?.caption || w.copy?.supporting) && <div style={{ marginTop: 10 }}>
          <span style={lab}>4. The copy</span>
          {w.copy.caption && <div style={{ position: "relative", background: C.card, borderRadius: 8, padding: "10px 12px", fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
            {w.copy.caption}
            <button onClick={copy} style={{ ...btn(), position: "absolute", top: 6, right: 6, padding: "3px 8px", fontSize: 11 }}>{copied ? "Copied" : "Copy caption"}</button>
          </div>}
          {w.copy.supporting && <div style={{ marginTop: 6, fontSize: 12.5, color: C.inkMid, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{w.copy.supporting}</div>}
        </div>}
        <Section n={5} title="The commercial objective">{w.objective}</Section>
        <Section n={6} title="The execution">{w.execution}</Section>
        {w.products?.length > 0 && <div style={{ marginTop: 10 }}><span style={lab}>Products</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{w.products.map((p, i) => p.url
            ? <a key={i} href={p.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: ACCENT, textDecoration: "none", background: "#F6EEE4", borderRadius: 6, padding: "3px 8px" }}>{p.title} ↗</a>
            : <span key={i} style={{ fontSize: 12, background: C.card, borderRadius: 6, padding: "3px 8px" }}>{p.title}</span>)}</div></div>}
      </>}
      {w.feedback && <div style={{ marginTop: 10, fontSize: 12.5, background: C.amberBg, borderRadius: 8, padding: "7px 10px" }}><b>Your note:</b> {w.feedback}</div>}
      {w.result && <div style={{ marginTop: 8, fontSize: 12.5, color: C.inkMid }}><b>Result:</b> {w.result}</div>}
    </div>
    <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "9px 16px", background: C.card, borderTop: `1px solid ${C.border}`, flexWrap: "wrap" }}>
      <button onClick={() => setOpen(!open)} style={{ all: "unset", cursor: "pointer", fontSize: 12, fontWeight: 600, color: ACCENT, flex: 1 }}>{open ? "▾ Less" : "▸ Full brief"}</button>
      {(w.status === "proposed" || w.status === "changes") && !mode && <>
        <button disabled={busy} onClick={() => setMode("decline")} style={btn()}>Decline</button>
        <button disabled={busy} onClick={() => setMode("changes")} style={btn()}>Ask for changes</button>
        <button disabled={busy} onClick={() => act("approved", { decided_at: new Date().toISOString() })} style={btn(C.ink, "#fff")}>Approve</button>
      </>}
      {w.status === "approved" && <>
        <button disabled={busy} onClick={() => act("proposed")} style={btn()}>Undo</button>
        <button disabled={busy} onClick={() => act("published", { published_at: new Date().toISOString() })} style={btn(C.ink, "#fff")}>Mark as published</button>
      </>}
      {(w.status === "declined" || w.status === "published") && <button disabled={busy} onClick={() => act("proposed")} style={btn()}>Reopen</button>}
    </div>
    {mode && <div style={{ padding: "10px 16px 12px", background: C.card, display: "flex", gap: 8, flexWrap: "wrap" }}>
      <textarea autoFocus value={fb} onChange={e => setFb(e.target.value)} rows={2} placeholder={mode === "changes" ? "What should Soniya change?" : "Why not? (Soniya learns from this)"} style={FI({ flex: 1, minWidth: 220, resize: "vertical" })} />
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <button disabled={busy || (mode === "changes" && !fb.trim())} onClick={() => act(mode === "changes" ? "changes" : "declined", { feedback: fb.trim() || null })} style={btn(C.ink, "#fff")}>{mode === "changes" ? "Send to Soniya" : "Decline"}</button>
        <button onClick={() => setMode(null)} style={btn()}>Cancel</button>
      </div>
    </div>}
  </div>;
}

/* ── Ask Soniya ────────────────────────────────────────────────────────── */
function AskTab({ work, notes, brand }) {
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);
  const send = async () => {
    const q = text.trim(); if (!q || busy) return;
    setText(""); setBusy(true);
    const next = [...msgs, { role: "user", content: q }];
    setMsgs(next);
    try {
      const words = q.toLowerCase().split(/\W+/).filter(w => w.length > 3);
      const hit = x => words.reduce((s, w) => s + (JSON.stringify(x).toLowerCase().includes(w) ? 1 : 0), 0);
      const rel = [...work].map(w => [hit(w), w]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).slice(0, 4).map(([, w]) => w);
      const ctx = [
        `Today (IST): ${istDay()}`,
        brand?.sections?.length ? `BRAND BOOK:\n${brand.sections.map(s => `## ${s.title}\n${s.body_md}`).join("\n\n").slice(0, 9000)}` : "",
        `YOUR MEMORY (decisions, lessons):\n${notes.slice(0, 40).map(n => `- (${n.kind}) ${n.title}: ${n.body || ""}`).join("\n") || "none yet"}`,
        `YOUR WORK IN PROGRESS:\n${work.filter(w => w.status !== "declined").slice(0, 25).map(w => `- [${w.status}${w.date ? ` ${w.date}` : ""}] ${w.type}: ${w.title}${w.feedback ? ` (Sir: ${w.feedback})` : ""}`).join("\n") || "none yet"}`,
        rel.length ? `RELEVANT BRIEFS IN FULL:\n${JSON.stringify(rel).slice(0, 8000)}` : "",
      ].filter(Boolean).join("\n\n");
      const sys = `${BRIEF}\n\nYou are answering Sir in the ERP chat. Be concise and specific; when he asks for a creative idea, use the six-part format. You can't see live product data here beyond what is in the context; your weekly work on Mondays reads the full catalogue and sales.\n\n${ctx}`;
      const res = await fetchWithRetry("/api/claude", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_tokens: 1400, messages: [{ role: "system", content: sys }, ...next.slice(-10)] }) }, { tries: 2, timeoutMs: 90000 });
      const d = await res.json();
      if (d.error) throw new Error(d.error?.message || d.error);
      setMsgs(m => [...m, { role: "assistant", content: (d.content || []).map(x => x.text || "").join("").trim() || "…" }]);
    } catch (e) { setMsgs(m => [...m, { role: "assistant", content: `⚠ ${e.message}` }]); }
    setBusy(false);
  };
  return <div style={{ ...card, padding: 14, display: "flex", flexDirection: "column", minHeight: 420 }}>
    <div style={{ flex: 1, overflowY: "auto", maxHeight: "60vh" }}>
      {msgs.length === 0 && <div style={{ color: C.inkFaint, fontSize: 13, padding: 12, lineHeight: 1.6 }}>Ask Soniya for a caption, a campaign idea, what to call a collection, or her view on a design. Her full weekly work (with the whole catalogue and sales) runs on Mondays on your Claude plan.</div>}
      {msgs.map((m, i) => <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", margin: "8px 0" }}>
        <div style={{ maxWidth: "85%", background: m.role === "user" ? C.ink : C.card, color: m.role === "user" ? "#fff" : C.ink, borderRadius: 10, padding: "8px 12px" }}>
          {m.role === "user" ? <span style={{ fontSize: 13.5 }}>{m.content}</span> : <Md text={m.content} size={13} />}
        </div>
      </div>)}
      {busy && <div style={{ fontSize: 12, color: C.inkFaint, padding: 6 }}>Soniya is thinking…</div>}
      <div ref={end} />
    </div>
    <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
      <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === "Enter" && send()} placeholder="Ask Soniya…" style={FI({ flex: 1, width: "auto" })} />
      <button onClick={send} disabled={busy} style={btn(C.ink, "#fff")}>Send</button>
    </div>
  </div>;
}

/* ── Brand book ────────────────────────────────────────────────────────── */
function BrandTab({ brand, onSave }) {
  const [edit, setEdit] = useState(null); // section id
  const [draft, setDraft] = useState("");
  if (!brand?.sections?.length) return <div style={{ ...card, color: C.inkMid, fontSize: 13 }}>No brand book yet. Soniya writes it in her first weekly session.</div>;
  return <div style={{ display: "grid", gap: 12 }}>
    {brand.updated_at && <div style={sub}>Last revised {new Date(brand.updated_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}. Edit a section if something is wrong; Soniya follows this book in every piece of work.</div>}
    {brand.sections.map(s => <div key={s.id} style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <div style={h}>{s.title}</div>
        {edit !== s.id && <button onClick={() => { setEdit(s.id); setDraft(s.body_md); }} style={{ all: "unset", cursor: "pointer", fontSize: 12, fontWeight: 600, color: ACCENT }}>Edit</button>}
      </div>
      {s.swatches?.length > 0 && <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>{s.swatches.map(c => <div key={c.hex} style={{ textAlign: "center" }}>
        <div style={{ width: 64, height: 44, borderRadius: 8, background: c.hex, border: `1px solid ${C.border}` }} />
        <div style={{ fontSize: 10.5, marginTop: 3, fontWeight: 600 }}>{c.name}</div><div style={{ fontSize: 10, color: C.inkFaint }}>{c.hex}</div>
      </div>)}</div>}
      {edit === s.id ? <>
        <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={Math.min(24, draft.split("\n").length + 2)} style={FI({ width: "100%", resize: "vertical", fontFamily: "ui-monospace,monospace", fontSize: 12.5 })} />
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button onClick={async () => { await onSave({ ...brand, sections: brand.sections.map(x => x.id === s.id ? { ...x, body_md: draft } : x), updated_at: new Date().toISOString(), edited_by: "Sir" }); setEdit(null); }} style={btn(C.ink, "#fff")}>Save</button>
          <button onClick={() => setEdit(null)} style={btn()}>Cancel</button>
        </div>
      </> : <Md text={s.body_md} size={13} />}
    </div>)}
  </div>;
}

/* ── Page ─────────────────────────────────────────────────────────────── */
const TABS = [["studio", "🎨", "Studio"], ["calendar", "🗓", "Calendar"], ["collections", "🗂", "Collections"], ["brand", "📖", "Brand book"], ["memory", "📚", "Memory"], ["ask", "💬", "Ask Soniya"]];

export default function SoniyaApp({ onHome }) {
  const [work, setWork] = useState(null);
  const [notes, setNotes] = useState([]);
  const [brand, setBrand] = useState(null);
  const [err, setErr] = useState("");
  const [toast, setToast] = useState("");
  const [tab, setTab] = useState(() => { try { return localStorage.getItem("soniya-tab") || "studio"; } catch { return "studio"; } });
  const [filter, setFilter] = useState("waiting");
  const [noteKind, setNoteKind] = useState("all");

  const go = t => { setTab(t); try { localStorage.setItem("soniya-tab", t); } catch {} };
  const showToast = m => { setToast(m); setTimeout(() => setToast(""), 2400); };
  const load = async () => {
    try {
      const [w, n, b] = await Promise.all([rowsOf(K.work), rowsOf(K.notes), loadK(K.brand)]);
      setWork(w); setNotes(n); setBrand(b || null);
    } catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  const saveWork = async w => {
    try { await put(K.work, w); setWork(ws => ws.map(x => x.id === w.id ? w : x)); showToast(STATUS[w.status]?.[0] || "Saved"); }
    catch (e) { setErr(e.message); }
  };
  const saveBrand = async b => { await saveK(K.brand, b, { merge: false }); setBrand(b); showToast("Brand book saved"); };
  const closeNote = async n => { const x = { ...n, status: n.status === "done" ? "open" : "done" }; await put(K.notes, x); setNotes(ns => ns.map(y => y.id === n.id ? x : y)); };

  const today = istDay();
  const waiting = (work || []).filter(w => w.status === "proposed" || w.status === "changes");
  const merch = (work || []).filter(w => ["collection", "naming", "photo"].includes(w.type));
  const cal = useMemo(() => (work || []).filter(w => w.date && w.status !== "declined").sort((a, b) => a.date.localeCompare(b.date)), [work]);

  const shell = body => <div style={{ minHeight: "100vh", background: C.bg, fontFamily: FONT, color: C.ink }}>
    {toast && <div style={{ position: "fixed", bottom: 22, right: 22, left: mob() ? 22 : "auto", zIndex: 1200, background: C.ink, color: "#fff", padding: "10px 18px", borderRadius: 6, fontSize: 12.5 }}>{toast}</div>}
    <div style={{ position: "sticky", top: 0, zIndex: 100, background: C.surface, borderBottom: `1px solid ${C.border}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: mob() ? "10px 14px" : "11px 28px" }}>
        {onHome && <button onClick={onHome} style={{ background: "none", border: "none", cursor: "pointer", color: C.inkMid, fontFamily: "inherit", fontSize: 13, padding: "0 12px 0 0", borderRight: `1px solid ${C.border}` }}>← Home</button>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, lineHeight: 1 }}>Soniya</div>
          <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 1 }}>Brand & creative director · Atyahara</div>
        </div>
        <button onClick={load} style={btn()}>↻</button>
      </div>
      <div style={{ display: "flex", overflowX: "auto", padding: mob() ? "0 10px" : "0 28px" }}>
        {TABS.map(([k, icon, label]) => <button key={k} onClick={() => go(k)} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: -1, border: "none", background: "none", cursor: "pointer", fontFamily: "inherit", padding: "11px 14px", fontSize: 13, whiteSpace: "nowrap", fontWeight: tab === k ? 700 : 500, color: tab === k ? C.ink : C.inkMid, borderBottom: `2px solid ${tab === k ? C.gold : "transparent"}` }}>
          <span style={{ fontSize: 14 }}>{icon}</span>{label}{k === "studio" && waiting.length ? <span style={{ background: C.gold, color: "#fff", borderRadius: 99, padding: "0 6px", fontSize: 10.5, fontWeight: 700 }}>{waiting.length}</span> : null}
        </button>)}
      </div>
    </div>
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: mob() ? "14px 12px 60px" : "22px 28px 60px" }}>
      {err && <div style={{ ...card, background: C.redBg, color: C.red, marginBottom: 12, fontSize: 13 }}>{err}</div>}
      {body}
    </div>
  </div>;

  if (!work) return shell(<div style={{ color: C.inkFaint, padding: 30 }}>{err ? "" : "Loading…"}</div>);

  let body;
  if (tab === "studio") {
    const list = work.filter(w => filter === "waiting" ? (w.status === "proposed" || w.status === "changes") : filter === "approved" ? w.status === "approved" : filter === "done" ? w.status === "published" : w.status === "declined")
      .sort((a, b) => (a.type === "campaign" ? 0 : 1) - (b.type === "campaign" ? 0 : 1) || String(a.date || "9").localeCompare(String(b.date || "9")));
    body = <>
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        {[["waiting", `Waiting (${waiting.length})`], ["approved", `Approved (${work.filter(w => w.status === "approved").length})`], ["done", `Published (${work.filter(w => w.status === "published").length})`], ["declined", `Declined (${work.filter(w => w.status === "declined").length})`]].map(([k, l]) =>
          <button key={k} onClick={() => setFilter(k)} style={filter === k ? btn(C.ink, "#fff") : btn()}>{l}</button>)}
        <span style={{ ...sub, marginLeft: 4 }}>Soniya proposes; nothing is posted until you publish it yourself.</span>
      </div>
      <div style={{ display: "grid", gap: 12 }}>{list.map(w => <Work key={w.id} w={w} onSave={saveWork} compact={list.length > 2} />)}</div>
      {!list.length && <div style={{ ...card, color: C.inkMid, fontSize: 13 }}>{filter === "waiting" ? "Nothing waiting. Soniya's next work arrives Monday morning." : "Nothing here."}</div>}
    </>;
  } else if (tab === "calendar") {
    const weeks = {};
    for (const w of cal) { const d = new Date(`${w.date}T12:00:00+05:30`); const mon = new Date(d - ((d.getDay() + 6) % 7) * 864e5).toISOString().slice(0, 10); (weeks[mon] ||= []).push(w); }
    body = <>
      <div style={{ ...sub, marginBottom: 12 }}>Atyahara's Instagram plan. Approve each piece in the Studio; tap one to read it.</div>
      {Object.entries(weeks).filter(([mon]) => mon >= new Date(Date.parse(today) - 7 * 864e5).toISOString().slice(0, 10)).map(([mon, items]) => <div key={mon} style={{ ...card, marginBottom: 12 }}>
        <div style={h}>Week of {fmtDay(mon)}</div>
        {items.map(w => { const [sl, sc, sbg] = STATUS[w.status] || STATUS.proposed; const [ti, tl] = TYPE[w.type] || ["•", w.type]; return <details key={w.id} style={{ borderTop: `1px solid ${C.border}`, padding: "9px 0" }}>
          <summary style={{ cursor: "pointer", display: "grid", gridTemplateColumns: mob() ? "70px minmax(0,1fr)" : "110px minmax(0,1fr) auto", gap: 10, alignItems: "baseline", fontSize: 13.5 }}>
            <b style={{ color: w.date < today ? C.inkFaint : C.ink }}>{fmtDay(w.date)}</b>
            <span>{ti} <b>{w.title}</b> <span style={{ color: C.inkFaint }}>· {tl}{w.purpose ? ` · ${PURPOSE[w.purpose] || w.purpose}` : ""}</span></span>
            {!mob() && <Tag c={sc} bg={sbg}>{sl}</Tag>}
          </summary>
          <div style={{ marginTop: 8 }}><Work w={w} onSave={saveWork} /></div>
        </details>; })}
      </div>)}
      {!cal.length && <div style={{ ...card, color: C.inkMid, fontSize: 13 }}>No calendar yet. Soniya fills the next two weeks every Monday.</div>}
    </>;
  } else if (tab === "collections") {
    body = <>
      <div style={{ ...sub, marginBottom: 12 }}>Curated collections, product names and photo briefs Soniya proposes for atyahara.com.</div>
      <div style={{ display: "grid", gap: 12 }}>{merch.map(w => <Work key={w.id} w={w} onSave={saveWork} compact />)}</div>
      {!merch.length && <div style={{ ...card, color: C.inkMid, fontSize: 13 }}>None yet.</div>}
    </>;
  } else if (tab === "brand") {
    body = <BrandTab brand={brand} onSave={saveBrand} />;
  } else if (tab === "memory") {
    const list = notes.filter(n => noteKind === "all" || n.kind === noteKind);
    body = <>
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        {[["all", "All"], ...Object.entries(NOTE).map(([k, [, l]]) => [k, l])].map(([k, l]) => <button key={k} onClick={() => setNoteKind(k)} style={noteKind === k ? btn(C.ink, "#fff") : btn()}>{l}</button>)}
      </div>
      <div style={grid("repeat(2, minmax(0,1fr))")}>{list.map(n => { const [ic, kl] = NOTE[n.kind] || ["•", n.kind]; return <div key={n.id} style={{ ...card, opacity: n.status === "done" ? .55 : 1 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 5 }}><Tag>{ic} {kl}</Tag>{n.due && <Tag c={n.due < today && n.status !== "done" ? C.red : C.inkMid}>due {fmtDay(n.due)}</Tag>}
          {n.kind === "followup" && <button onClick={() => closeNote(n)} style={{ all: "unset", cursor: "pointer", marginLeft: "auto", fontSize: 12, color: ACCENT, fontWeight: 600 }}>{n.status === "done" ? "Reopen" : "Done"}</button>}</div>
        <div style={{ fontWeight: 700, fontSize: 14 }}>{n.title}</div>
        <div style={{ fontSize: 13, color: C.inkMid, marginTop: 4, lineHeight: 1.5 }}>{n.body}</div>
      </div>; })}</div>
      {!list.length && <div style={{ ...card, color: C.inkMid, fontSize: 13 }}>Nothing yet.</div>}
    </>;
  } else body = <AskTab work={work} notes={notes} brand={brand} />;

  return shell(body);
}
