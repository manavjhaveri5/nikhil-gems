/* Alex — Atyahara's chief strategy & growth officer. Same look as Raj and Soniya.

   His thinking runs on Manav's Mac as the Claude scheduled task "alex-weekly"
   (scripts/alex/ALEX.md): a weekly growth review, an opportunity pipeline in
   the brief's 10-step structure, a partner pipeline, and hand-offs to Soniya and
   Raj. Sir approves, asks for changes or declines here. Alex never emails
   partners, publishes, spends or changes listings. Ask Alex runs on /api/claude
   (metered by Girton). Scope: Atyahara India (atyahara.com, gifting, retail);
   customer insight and the selling-moments calendar (app_data alex-moments-v1) come
   from Alex's weekly review, which reads Shopify directly. */
import { useState, useEffect, useMemo, useRef } from "react";
import { supabase } from "./supabase.js";
import { C, mob, FI } from "./lmTheme.js";
import { loadK } from "./utils.js";
import { fetchWithRetry } from "./aiClient.js";
import { Md, istDay } from "./RajApp.jsx";
import BRIEF from "./alex/brief.md?raw";

const K = { opps: "alex-opps-v1", partners: "alex-partners-v1", notes: "alex-notes-v1", reviews: "alex-reviews-v1" };
const BLUEPRINT = "https://claude.ai/artifact/YLGzWcYqG5LCDMeyb6J6FY";
const FONT = "-apple-system,'SF Pro Display','Figtree',system-ui,sans-serif";
const SERIF = "'Cormorant Garamond',Georgia,serif";
const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 16px", minWidth: 0 };
const btn = (bg = C.surface, fg = C.ink) => ({ background: bg, color: fg, border: bg === C.surface ? `1px solid ${C.border}` : "none", borderRadius: 7, padding: "7px 13px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" });
const lab = { fontSize: 9.5, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 4, display: "block" };
const h = { fontFamily: SERIF, fontSize: 18, fontWeight: 700, margin: "0 0 10px", color: C.ink };
const sub = { fontSize: 11.5, color: C.inkFaint };
const ACCENT = "#1F5F5B"; // deep teal: Alex's colour

const STATUS = { proposed: ["Waiting for you", C.blue, C.blueBg], changes: ["Changes asked", C.amber, C.amberBg], approved: ["Approved", C.green, C.greenBg], running: ["Running", ACCENT, "#E3EFEE"], done: ["Done", C.inkMid, C.card], declined: ["Declined", C.inkFaint, C.card] };
const KIND = { experiment: "Experiment", investment: "Investment", opex: "Operating cost" };
const TIER = { high: "High priority", approach: "To approach", long_term: "Long term", rejected: "Rejected" };
const STAGE = { not_contacted: "Not contacted", drafted: "Message drafted", contacted: "Contacted", talking: "In talks", trial: "Trial order", customer: "Customer", no: "Said no" };
const NOTE = { decision: ["⚖️", "Decision"], lesson: ["🎓", "Lesson"], knowledge: ["📚", "Knowledge"], followup: ["📌", "Follow-up"], handoff: ["🤝", "Hand-off"] };
const STEPS = [["opportunity", "Opportunity"], ["market", "Market"], ["competition", "Competition"], ["economics", "Economics"], ["execution", "Execution"], ["resources", "Resources"], ["risks", "Risks"], ["recommendation", "Recommendation"], ["success_criteria", "Success criteria"]];
const Tag = ({ c = C.inkMid, bg = C.card, children }) => <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: .4, background: bg, color: c, borderRadius: 4, padding: "2px 6px", whiteSpace: "nowrap" }}>{children}</span>;
const grid = (cols, gap = 12) => ({ display: "grid", gridTemplateColumns: mob() ? "minmax(0,1fr)" : cols, gap });
const fmtDay = d => d ? new Date(`${d}T12:00:00+05:30`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : "";
const inr = n => n == null ? "—" : n >= 1e5 ? `₹${(n / 1e5).toFixed(2)} lakh` : `₹${Math.round(n).toLocaleString("en-IN")}`;
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

async function rowsOf(key) {
  const { data, error } = await supabase.from("app_rows").select("data").eq("key", key).eq("deleted", false).order("pos", { ascending: true }).limit(1000);
  if (error) throw new Error(error.message);
  return (data || []).map(r => r.data);
}
async function put(key, item) {
  const { error } = await supabase.rpc("app_rows_upsert", { p_key: key, p_item: { ...item, updated_at: new Date().toISOString() }, p_prepend: false });
  if (error) throw new Error(error.message);
}

/* atyahara.com numbers from the ERP's orders (INR, cancelled excluded). Scope is Atyahara INDIA:
   the Etsy shop is a separate export business. The ERP sync misses some Shopify orders, so the
   weekly review (read straight from Shopify) is the source of truth for insight. */
function useNumbers(orders) {
  return useMemo(() => {
    if (!orders) return null;
    const t = istDay();
    const live = orders.filter(o => o.platform === "shopify_aty" && !/cancel/i.test(o.status || "") && o.date && (+o.sale_price || 0) > 20);
    const sum = a => a.reduce((s, o) => s + (+o.sale_price || 0), 0);
    const win = (from, to) => live.filter(o => o.date >= from && o.date <= to);
    return { d30: sum(win(addDays(t, -29), t)), mtd: sum(win(t.slice(0, 8) + "01", t)), orders30: new Set(win(addDays(t, -29), t).map(o => o.order_number || o.id)).size };
  }, [orders]);
}
const daysTo = d => d ? Math.round((Date.parse(d) - Date.parse(istDay())) / 864e5) : null;

/* ── one opportunity, in the brief's 10-step structure ─────────────────── */
function Opp({ o, onSave, compact }) {
  const [open, setOpen] = useState(!compact);
  const [mode, setMode] = useState(null);
  const [fb, setFb] = useState("");
  const [busy, setBusy] = useState(false);
  const [sl, sc, sbg] = STATUS[o.status] || STATUS.proposed;
  const act = async (status, extra = {}) => { setBusy(true); try { await onSave({ ...o, status, ...extra }); setMode(null); setFb(""); } finally { setBusy(false); } };
  const na = o.next_action || {};
  return <div style={{ ...card, padding: 0, overflow: "hidden", borderLeft: `3px solid ${["proposed", "changes"].includes(o.status) ? ACCENT : o.status === "approved" || o.status === "running" ? C.green : C.border}` }}>
    <div style={{ padding: "13px 16px 11px" }}>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 7 }}>
        {o.priority && <Tag c="#fff" bg={ACCENT}>P{o.priority}</Tag>}{o.kind && <Tag>{KIND[o.kind] || o.kind}</Tag>}{o.segment && <Tag>{o.segment}</Tag>}
        {o.budget_inr != null && <Tag>{inr(o.budget_inr)}</Tag>}<Tag c={sc} bg={sbg}>{sl}</Tag>
      </div>
      <div onClick={() => setOpen(!open)} style={{ fontFamily: SERIF, fontSize: 19, fontWeight: 700, lineHeight: 1.2, cursor: "pointer" }}>{o.title}</div>
      {!open && <div style={{ marginTop: 6, fontSize: 13, color: C.inkMid, lineHeight: 1.5 }}>{o.recommendation}</div>}
      {open && STEPS.map(([k, l], i) => o[k] ? <div key={k} style={{ marginTop: 10 }}><span style={lab}>{i + 1}. {l}</span>
        <div style={{ fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{o[k]}</div></div> : null)}
      {(na.what || typeof o.next_action === "string") && <div style={{ marginTop: 10 }}><span style={lab}>10. Next action</span>
        <div style={{ fontSize: 13, lineHeight: 1.55 }}>{na.what || o.next_action}{na.owner ? ` — ${na.owner}` : ""}{na.due ? `, by ${fmtDay(na.due)}` : ""}</div></div>}
      {o.feedback && <div style={{ marginTop: 10, fontSize: 12.5, background: C.amberBg, borderRadius: 8, padding: "7px 10px" }}><b>Your note:</b> {o.feedback}</div>}
      {o.result && <div style={{ marginTop: 8, fontSize: 12.5, color: C.inkMid }}><b>Result:</b> {o.result}</div>}
    </div>
    <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "9px 16px", background: C.card, borderTop: `1px solid ${C.border}`, flexWrap: "wrap" }}>
      <button onClick={() => setOpen(!open)} style={{ all: "unset", cursor: "pointer", fontSize: 12, fontWeight: 600, color: ACCENT, flex: 1 }}>{open ? "▾ Less" : "▸ All 10 steps"}</button>
      {["proposed", "changes"].includes(o.status) && !mode && <>
        <button disabled={busy} onClick={() => setMode("decline")} style={btn()}>Decline</button>
        <button disabled={busy} onClick={() => setMode("changes")} style={btn()}>Ask for changes</button>
        <button disabled={busy} onClick={() => act("approved", { decided_at: new Date().toISOString() })} style={btn(C.ink, "#fff")}>Approve</button>
      </>}
      {o.status === "approved" && <><button disabled={busy} onClick={() => act("proposed")} style={btn()}>Undo</button>
        <button disabled={busy} onClick={() => act("running", { started_at: new Date().toISOString() })} style={btn(C.ink, "#fff")}>Started</button></>}
      {o.status === "running" && <button disabled={busy} onClick={() => setMode("done")} style={btn(C.ink, "#fff")}>Finished</button>}
      {["declined", "done"].includes(o.status) && <button disabled={busy} onClick={() => act("proposed")} style={btn()}>Reopen</button>}
    </div>
    {mode && <div style={{ padding: "10px 16px 12px", background: C.card, display: "flex", gap: 8, flexWrap: "wrap" }}>
      <textarea autoFocus value={fb} onChange={e => setFb(e.target.value)} rows={2} placeholder={mode === "changes" ? "What should Alex change?" : mode === "done" ? "What happened? (numbers if you have them)" : "Why not? (Alex learns from this)"} style={FI({ flex: 1, minWidth: 220, resize: "vertical" })} />
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <button disabled={busy || (mode !== "decline" && !fb.trim())} onClick={() => mode === "done" ? act("done", { result: fb.trim() }) : act(mode === "changes" ? "changes" : "declined", { feedback: fb.trim() || null })} style={btn(C.ink, "#fff")}>{mode === "changes" ? "Send to Alex" : mode === "done" ? "Save" : "Decline"}</button>
        <button onClick={() => setMode(null)} style={btn()}>Cancel</button>
      </div>
    </div>}
  </div>;
}

/* ── one partner ───────────────────────────────────────────────────────── */
function Partner({ p, onSave }) {
  const [note, setNote] = useState(null);
  return <div style={{ ...card, padding: "11px 14px" }}>
    <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
      {p.rank && <b style={{ color: ACCENT, fontSize: 13 }}>#{p.rank}</b>}
      <div style={{ flex: 1, minWidth: 160 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>{p.url ? <a href={p.url} target="_blank" rel="noreferrer" style={{ color: C.ink }}>{p.name} ↗</a> : p.name}</div>
        <div style={sub}>{p.type}{p.city ? ` · ${p.city}` : ""}</div>
      </div>
      <select value={p.stage || "not_contacted"} onChange={e => onSave({ ...p, stage: e.target.value })} style={FI({ width: "auto", fontSize: 12, padding: "4px 6px" })}>
        {Object.entries(STAGE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
    </div>
    <div style={{ fontSize: 12.5, color: C.inkMid, marginTop: 6, lineHeight: 1.5 }}>{p.why}{p.first_step ? <> · <b>First step:</b> {p.first_step}</> : null}</div>
    {p.evidence && <div style={{ fontSize: 12, color: C.inkMid, marginTop: 4 }}><b>Evidence:</b> {p.evidence}</div>}
    {note === null ? <div style={{ marginTop: 6, fontSize: 12 }}>{p.sir_note && <span style={{ background: C.amberBg, borderRadius: 6, padding: "2px 7px", marginRight: 8 }}>Your note: {p.sir_note}</span>}
      <button onClick={() => setNote(p.sir_note || "")} style={{ all: "unset", cursor: "pointer", color: ACCENT, fontWeight: 600 }}>{p.sir_note ? "Edit note" : "Add note"}</button></div>
      : <div style={{ display: "flex", gap: 6, marginTop: 6 }}><input autoFocus value={note} onChange={e => setNote(e.target.value)} placeholder="What happened? Alex reads this on Monday" style={FI({ flex: 1, width: "auto" })} />
        <button onClick={async () => { await onSave({ ...p, sir_note: note.trim() || null }); setNote(null); }} style={btn(C.ink, "#fff")}>Save</button><button onClick={() => setNote(null)} style={btn()}>Cancel</button></div>}
  </div>;
}

/* ── Ask Alex ──────────────────────────────────────────────────────────── */
function AskTab({ opps, partners, notes, review, nums, moments }) {
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
      const ctx = [
        `Today (IST): ${istDay()}`,
        "SCOPE: Atyahara INDIA only (atyahara.com, B2B gifting, Indian retail), built as a mass-luxury brand. The Atyahara Etsy shop is a separate export business: ignore it.",
        nums ? `atyahara.com in the ERP (sync incomplete): last 30 days ${inr(nums.d30)} from ${nums.orders30} orders; month to date ${inr(nums.mtd)}. Product costs are NOT in the ERP.` : "",
        review?.insights ? `LATEST CUSTOMER INSIGHT:\n${JSON.stringify(review.insights).slice(0, 3000)}` : "",
        moments?.length ? `SELLING MOMENTS:\n${moments.map(m => `- ${m.name}: ${m.date_note || m.date} · ${m.regions} · ${m.product} · angle "${m.ad_angle}"`).join("\n")}` : "",
        review ? `YOUR LATEST WEEKLY REVIEW (${review.id}):\n${String(review.review_md || "").slice(0, 5000)}` : "",
        `YOUR PIPELINE:\n${opps.filter(o => o.status !== "declined").slice(0, 20).map(o => `- [${o.status}] ${o.title}${o.budget_inr != null ? ` (${inr(o.budget_inr)})` : ""}${o.feedback ? ` (Sir: ${o.feedback})` : ""}`).join("\n") || "none yet"}`,
        `PARTNERS:\n${partners.slice(0, 25).map(p => `- #${p.rank || "?"} ${p.name} (${TIER[p.tier] || p.tier}, ${STAGE[p.stage] || p.stage})${p.sir_note ? ` Sir: ${p.sir_note}` : ""}`).join("\n") || "none yet"}`,
        `YOUR MEMORY:\n${notes.slice(0, 30).map(n => `- (${n.kind}) ${n.title}: ${String(n.body || "").slice(0, 300)}`).join("\n") || "none yet"}`,
      ].filter(Boolean).join("\n\n");
      const sys = `${BRIEF}\n\nYou are answering Sir in the ERP chat. Be concise and direct; give a recommendation, label facts vs assumptions, and use the 10-step structure only for a major recommendation. You only see the context below; your Monday review reads the full data.\n\n${ctx}`;
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
      {msgs.length === 0 && <div style={{ color: C.inkFaint, fontSize: 13, padding: 12, lineHeight: 1.6 }}>Ask Alex where the next ₹10,000 should go, whether a channel is worth testing, or how to price a bulk order. His full weekly review runs on Mondays on your Claude plan.</div>}
      {msgs.map((m, i) => <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", margin: "8px 0" }}>
        <div style={{ maxWidth: "85%", background: m.role === "user" ? C.ink : C.card, color: m.role === "user" ? "#fff" : C.ink, borderRadius: 10, padding: "8px 12px" }}>
          {m.role === "user" ? <span style={{ fontSize: 13.5 }}>{m.content}</span> : <Md text={m.content} size={13} />}
        </div>
      </div>)}
      {busy && <div style={{ fontSize: 12, color: C.inkFaint, padding: 6 }}>Alex is thinking…</div>}
      <div ref={end} />
    </div>
    <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
      <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === "Enter" && send()} placeholder="Ask Alex…" style={FI({ flex: 1, width: "auto" })} />
      <button onClick={send} disabled={busy} style={btn(C.ink, "#fff")}>Send</button>
    </div>
  </div>;
}

/* ── Page ─────────────────────────────────────────────────────────────── */
const TABS = [["dash", "📊", "Dashboard"], ["pipeline", "🧭", "Pipeline"], ["partners", "🤝", "Partners"], ["memory", "📚", "Decisions & notes"], ["ask", "💬", "Ask Alex"]];

export default function AlexApp({ onHome }) {
  const [opps, setOpps] = useState(null);
  const [partners, setPartners] = useState([]);
  const [notes, setNotes] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [orders, setOrders] = useState(null);
  const [moments, setMoments] = useState([]);
  const [err, setErr] = useState("");
  const [toast, setToast] = useState("");
  const [tab, setTab] = useState(() => { try { return localStorage.getItem("alex-tab") || "dash"; } catch { return "dash"; } });
  const [filter, setFilter] = useState("waiting");
  const [noteKind, setNoteKind] = useState("all");
  const nums = useNumbers(orders);

  const go = t => { setTab(t); try { localStorage.setItem("alex-tab", t); } catch {} };
  const showToast = m => { setToast(m); setTimeout(() => setToast(""), 2400); };
  const load = async () => {
    try {
      const [o, p, n, r] = await Promise.all([rowsOf(K.opps), rowsOf(K.partners), rowsOf(K.notes), rowsOf(K.reviews)]);
      setOpps(o); setPartners(p); setNotes(n); setReviews(r.sort((a, b) => String(b.id).localeCompare(String(a.id))));
    } catch (e) { setErr(e.message); }
    loadK("ng-orders-v1").then(x => setOrders(Array.isArray(x) ? x : [])).catch(() => setOrders([]));
    supabase.from("app_data").select("value").eq("key", "alex-moments-v1").maybeSingle().then(({ data }) => setMoments(data?.value?.moments || []));
  };
  useEffect(() => { load(); }, []);

  const saveOpp = async o => { try { await put(K.opps, o); setOpps(xs => xs.map(x => x.id === o.id ? o : x)); showToast(STATUS[o.status]?.[0] || "Saved"); } catch (e) { setErr(e.message); } };
  const savePartner = async p => { try { await put(K.partners, p); setPartners(xs => xs.map(x => x.id === p.id ? p : x)); showToast("Saved"); } catch (e) { setErr(e.message); } };
  const closeNote = async n => { const x = { ...n, status: n.status === "done" ? "open" : "done" }; await put(K.notes, x); setNotes(ns => ns.map(y => y.id === n.id ? x : y)); };

  const today = istDay();
  const waiting = (opps || []).filter(o => ["proposed", "changes"].includes(o.status));
  const review = reviews[0];

  const shell = body => <div style={{ minHeight: "100vh", background: C.bg, fontFamily: FONT, color: C.ink }}>
    {toast && <div style={{ position: "fixed", bottom: 22, right: 22, left: mob() ? 22 : "auto", zIndex: 1200, background: C.ink, color: "#fff", padding: "10px 18px", borderRadius: 6, fontSize: 12.5 }}>{toast}</div>}
    <div style={{ position: "sticky", top: 0, zIndex: 100, background: C.surface, borderBottom: `1px solid ${C.border}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: mob() ? "10px 14px" : "11px 28px" }}>
        {onHome && <button onClick={onHome} style={{ background: "none", border: "none", cursor: "pointer", color: C.inkMid, fontFamily: "inherit", fontSize: 13, padding: "0 12px 0 0", borderRight: `1px solid ${C.border}` }}>← Home</button>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, lineHeight: 1 }}>Alex</div>
          <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 1 }}>Strategy & growth · Atyahara</div>
        </div>
        <button onClick={load} style={btn()}>↻</button>
      </div>
      <div style={{ display: "flex", overflowX: "auto", padding: mob() ? "0 10px" : "0 28px" }}>
        {TABS.map(([k, icon, label]) => <button key={k} onClick={() => go(k)} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: -1, border: "none", background: "none", cursor: "pointer", fontFamily: "inherit", padding: "11px 14px", fontSize: 13, whiteSpace: "nowrap", fontWeight: tab === k ? 700 : 500, color: tab === k ? C.ink : C.inkMid, borderBottom: `2px solid ${tab === k ? C.gold : "transparent"}` }}>
          <span style={{ fontSize: 14 }}>{icon}</span>{label}{k === "pipeline" && waiting.length ? <span style={{ background: C.gold, color: "#fff", borderRadius: 99, padding: "0 6px", fontSize: 10.5, fontWeight: 700 }}>{waiting.length}</span> : null}
        </button>)}
      </div>
    </div>
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: mob() ? "14px 12px 60px" : "22px 28px 60px" }}>
      {err && <div style={{ ...card, background: C.redBg, color: C.red, marginBottom: 12, fontSize: 13 }}>{err}</div>}
      {body}
    </div>
  </div>;

  if (!opps) return shell(<div style={{ color: C.inkFaint, padding: 30 }}>{err ? "" : "Loading…"}</div>);

  let body;
  if (tab === "dash") {
    const ins = review?.insights || {};
    const upcoming = moments.filter(m => m.date && daysTo(m.date) >= -3).sort((x, y) => x.date.localeCompare(y.date)).slice(0, 4);
    const next = upcoming[0];
    const ws = (ins.regions || []).filter(r => /west|south/i.test(r.region)).reduce((t, r) => t + (r.share_pct || 0), 0);
    const stat = (l, v, s) => <div style={card}><span style={lab}>{l}</span><div style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 700, lineHeight: 1.1 }}>{v}</div>{s && <div style={{ ...sub, marginTop: 3 }}>{s}</div>}</div>;
    body = <>
      <div style={{ ...sub, marginBottom: 10 }}>Atyahara India: atyahara.com, gifting and retail. The Etsy shop is a separate business and is not counted here.</div>
      <div style={{ ...grid("repeat(4, minmax(0,1fr))"), marginBottom: 12 }}>
        {stat("atyahara.com, 30 days", nums ? inr(nums.d30) : "…", nums ? `${nums.orders30} orders · ERP (sync incomplete)` : "")}
        {stat("Indian orders, all time", review?.metrics?.orders_all_time ?? "—", review?.metrics?.revenue_all_time_inr ? `${inr(review.metrics.revenue_all_time_inr)} · avg ${inr(review.metrics.avg_order_inr)}` : "from Alex's review")}
        {stat("West + South", ws ? `${ws}%` : "—", "share of Indian revenue")}
        {stat("Next selling moment", next ? next.name : "—", next ? `${fmtDay(next.date)} · in ${daysTo(next.date)} days` : "")}
      </div>
      <div style={grid("minmax(0,1.6fr) minmax(0,1fr)")}>
        <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
          <div style={card}>
            <div style={h}>{review ? `Growth review · ${fmtDay(review.id)}` : "Growth review"}</div>
            {review ? <>{review.headline && <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>{review.headline}</div>}<Md text={review.review_md || ""} size={13} /></>
              : <div style={{ fontSize: 13, color: C.inkMid }}>Alex's first weekly review arrives Monday morning. Until then, read the Growth Blueprint.</div>}
          </div>
          {ins.ad_ideas?.length > 0 && <div style={card}><div style={h}>Ads to make</div>
            {ins.ad_ideas.map((a, i) => <div key={i} style={{ fontSize: 13, lineHeight: 1.5, padding: "5px 0", borderTop: i ? `1px solid ${C.border}` : "none" }}>{a}</div>)}
            {ins.next_moment && <div style={{ marginTop: 8, fontSize: 12.5, background: "#E3EFEE", borderRadius: 8, padding: "8px 10px" }}><b>Next test:</b> {ins.next_moment.name} ({fmtDay(ins.next_moment.date)}) · {ins.next_moment.regions} · {ins.next_moment.product} · “{ins.next_moment.ad_angle}” · {inr(ins.next_moment.budget_inr)}</div>}
          </div>}
        </div>
        <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
          <a href={BLUEPRINT} target="_blank" rel="noreferrer" style={{ ...card, textDecoration: "none", color: C.ink, borderLeft: `3px solid ${ACCENT}` }}>
            <span style={lab}>First assignment</span><div style={{ fontFamily: SERIF, fontSize: 19, fontWeight: 700 }}>Atyahara — The Growth Blueprint ↗</div>
            <div style={{ ...sub, marginTop: 4 }}>Who buys, where and when; selling moments; markets, partners, packaging, money, 90 days.</div></a>
          {ins.regions?.length > 0 && <div style={card}><div style={h}>Where buyers are</div>
            {ins.regions.map(r => <div key={r.region} style={{ padding: "5px 0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}><b>{r.region}</b><span style={{ color: C.inkMid }}>{r.share_pct}% · {r.orders} orders</span></div>
              <div style={{ height: 6, background: C.card, borderRadius: 3, marginTop: 4 }}><div style={{ width: `${r.share_pct}%`, height: 6, background: ACCENT, borderRadius: 3 }} /></div>
              {r.note && <div style={{ ...sub, marginTop: 3 }}>{r.note}</div>}
            </div>)}
            {ins.buyer && <div style={{ fontSize: 12.5, color: C.inkMid, marginTop: 8, lineHeight: 1.5 }}><b>Buyer:</b> {ins.buyer}</div>}
          </div>}
          {upcoming.length > 0 && <div style={card}><div style={h}>Selling moments ahead</div>
            {upcoming.map(m => { const d = daysTo(m.date); const adIn = d - (m.ad_start_days_before || 0); return <div key={m.id} style={{ padding: "6px 0", borderTop: `1px solid ${C.border}`, fontSize: 12.5 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><b>{m.name}</b><span style={{ color: C.inkFaint, whiteSpace: "nowrap" }}>{fmtDay(m.date)}</span></div>
              <div style={{ color: C.inkMid, marginTop: 2 }}>{m.regions} · {m.product}</div>
              <div style={{ color: adIn <= 0 ? C.red : ACCENT, marginTop: 2, fontWeight: 600 }}>{adIn <= 0 ? "Campaign window is open" : `Start campaign in ${adIn} days`}</div>
            </div>; })}</div>}
          <div style={card}><div style={h}>Decisions for you</div>
            {(review?.decisions_for_sir || []).map((d, i) => <div key={i} style={{ borderTop: i ? `1px solid ${C.border}` : "none", padding: "7px 0", fontSize: 13 }}>
              <b>{d.question}</b>{d.recommend && <div style={{ color: C.inkMid, marginTop: 2 }}>Alex recommends: {d.recommend}</div>}</div>)}
            {!(review?.decisions_for_sir || []).length && <div style={sub}>None open.</div>}
          </div>
        </div>
      </div>
    </>;
  } else if (tab === "pipeline") {
    const list = opps.filter(o => filter === "waiting" ? ["proposed", "changes"].includes(o.status) : filter === "live" ? ["approved", "running"].includes(o.status) : filter === "done" ? o.status === "done" : o.status === "declined")
      .sort((a, b) => (a.priority || 9) - (b.priority || 9));
    body = <>
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        {[["waiting", `Waiting (${waiting.length})`], ["live", `Approved & running (${opps.filter(o => ["approved", "running"].includes(o.status)).length})`], ["done", `Done (${opps.filter(o => o.status === "done").length})`], ["declined", `Declined (${opps.filter(o => o.status === "declined").length})`]].map(([k, l]) =>
          <button key={k} onClick={() => setFilter(k)} style={filter === k ? btn(C.ink, "#fff") : btn()}>{l}</button>)}
        <span style={{ ...sub, marginLeft: 4 }}>Alex proposes; nothing is spent or sent until you do it.</span>
      </div>
      <div style={{ display: "grid", gap: 12 }}>{list.map(o => <Opp key={o.id} o={o} onSave={saveOpp} compact={list.length > 1} />)}</div>
      {!list.length && <div style={{ ...card, color: C.inkMid, fontSize: 13 }}>Nothing here.</div>}
    </>;
  } else if (tab === "partners") {
    body = <>
      <div style={{ ...sub, marginBottom: 12 }}>Real businesses Alex has researched. None has shown interest until a stage says so. Update the stage and add a note when something happens; Alex reads them every Monday.</div>
      {Object.entries(TIER).map(([t, l]) => { const ps = partners.filter(p => p.tier === t).sort((a, b) => (a.rank || 99) - (b.rank || 99)); return ps.length ? <div key={t} style={{ marginBottom: 18 }}>
        <div style={h}>{l} <span style={{ ...sub, fontFamily: FONT }}>{ps.length}</span></div>
        <div style={grid("repeat(2, minmax(0,1fr))", 10)}>{ps.map(p => <Partner key={p.id} p={p} onSave={savePartner} />)}</div>
      </div> : null; })}
      {!partners.length && <div style={{ ...card, color: C.inkMid, fontSize: 13 }}>No partners yet.</div>}
    </>;
  } else if (tab === "memory") {
    const list = notes.filter(n => noteKind === "all" || n.kind === noteKind);
    body = <>
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        {[["all", "All"], ...Object.entries(NOTE).map(([k, [, l]]) => [k, l])].map(([k, l]) => <button key={k} onClick={() => setNoteKind(k)} style={noteKind === k ? btn(C.ink, "#fff") : btn()}>{l}</button>)}
      </div>
      <div style={grid("repeat(2, minmax(0,1fr))")}>{list.map(n => { const [ic, kl] = NOTE[n.kind] || ["•", n.kind]; return <div key={n.id} style={{ ...card, opacity: n.status === "done" ? .55 : 1 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 5, flexWrap: "wrap" }}><Tag>{ic} {kl}</Tag>{n.to && <Tag c={ACCENT} bg="#E3EFEE">to {n.to}</Tag>}{n.due && <Tag c={n.due < today && n.status !== "done" ? C.red : C.inkMid}>due {fmtDay(n.due)}</Tag>}
          {["followup", "handoff"].includes(n.kind) && <button onClick={() => closeNote(n)} style={{ all: "unset", cursor: "pointer", marginLeft: "auto", fontSize: 12, color: ACCENT, fontWeight: 600 }}>{n.status === "done" ? "Reopen" : "Done"}</button>}</div>
        <div style={{ fontWeight: 700, fontSize: 14 }}>{n.title}</div>
        <div style={{ fontSize: 13, color: C.inkMid, marginTop: 4, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{n.body}</div>
      </div>; })}</div>
      {!list.length && <div style={{ ...card, color: C.inkMid, fontSize: 13 }}>Nothing yet.</div>}
    </>;
  } else body = <AskTab opps={opps} partners={partners} notes={notes} review={review} nums={nums} moments={moments} />;

  return shell(body);
}
