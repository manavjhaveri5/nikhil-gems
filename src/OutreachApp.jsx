/* Outreach — wholesale cold outreach for Nikhil Gems / Earth Editions Trade (bulk by the kilo).

   Leads are researched on Manav's Mac (scripts/outreach/: Etsy Open API, shop websites, web
   search) and pushed to app_rows outreach-leads-v1 with a personal draft for each shop.
   Nothing here sends anything by itself: Sejal opens the draft in her own Gmail or Instagram,
   sends it by hand, and marks it here. Follow-ups come due 4 and 10 days later, then stop. */
import { useState, useEffect, useMemo } from "react";
import { supabase } from "./supabase.js";
import { C, mob, FI } from "./lmTheme.js";
import PLAYBOOK from "./outreach/playbook.md?raw";
import { Md, istDay } from "./RajApp.jsx";

const KEY = "outreach-leads-v1";
const FONT = "-apple-system,'SF Pro Display','Figtree',system-ui,sans-serif";
const SERIF = "'Cormorant Garamond',Georgia,serif";
const ACCENT = "#7A4E2D";
const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 16px", minWidth: 0 };
const btn = (bg = C.surface, fg = C.ink) => ({ background: bg, color: fg, border: bg === C.surface ? `1px solid ${C.border}` : "none", borderRadius: 7, padding: "6px 11px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" });
const lab = { fontSize: 9.5, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 4, display: "block" };
const sub = { fontSize: 11.5, color: C.inkFaint };
const Tag = ({ c = C.inkMid, bg = C.card, children }) => <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: .4, background: bg, color: c, borderRadius: 4, padding: "2px 6px", whiteSpace: "nowrap" }}>{children}</span>;
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const FLAG = { US: "🇺🇸", GB: "🇬🇧", AU: "🇦🇺", NZ: "🇳🇿", JP: "🇯🇵", DE: "🇩🇪", NL: "🇳🇱", FR: "🇫🇷", IT: "🇮🇹", ES: "🇪🇸", IE: "🇮🇪", CA: "🇨🇦", BE: "🇧🇪", AT: "🇦🇹", CH: "🇨🇭", SE: "🇸🇪", DK: "🇩🇰" };
const SEG = { etsy_reseller: "Etsy shop", online_shop: "Online shop", physical_shop: "Shop (walk-in)", live_seller: "Live seller" };
const STAGE = { new: ["Not contacted", C.inkMid, C.card], sent: ["Sent", C.blue, C.blueBg], followed_up: ["Followed up", C.blue, C.blueBg], replied: ["Replied", C.green, C.greenBg],
  talking: ["In talks", C.green, C.greenBg], sample: ["Sample / trial", ACCENT, "#F3E9DF"], customer: ["Customer", "#fff", C.green], no: ["Not interested", C.inkFaint, C.card], bounced: ["Bounced", C.red, C.redBg], skip: ["Skipped", C.inkFaint, C.card] };
const OPEN = ["sent", "followed_up"];
// Safe daily limits for a person sending by hand from an ordinary mailbox and a young Instagram account.
const CAP = { email: 20, instagram: 12 };

async function load() {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("app_rows").select("data").eq("key", KEY).eq("deleted", false).order("pos", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data || []).map(r => r.data));
    if (!data || data.length < 1000) break;
  }
  return out;
}
async function put(item) {
  const { error } = await supabase.rpc("app_rows_upsert", { p_key: KEY, p_item: { ...item, updated_at: new Date().toISOString() }, p_prepend: false });
  if (error) throw new Error(error.message);
}
const gmail = (to, su, body) => `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to || "")}&su=${encodeURIComponent(su || "")}&body=${encodeURIComponent(body || "")}`;
const igUrl = h => `https://www.instagram.com/${String(h || "").replace(/^@/, "")}/`;
const copy = async (t, toast) => { try { await navigator.clipboard.writeText(t); toast("Copied"); } catch { toast("Couldn't copy"); } };
const sentToday = (leads, via, today) => leads.filter(l => (l.history || []).some(h => h.day === today && h.via === via && /^(sent|followup)/.test(h.what))).length;

function Lead({ l, onSave, toast, today, open: open0 = false }) {
  const [open, setOpen] = useState(open0);
  const [note, setNote] = useState(null);
  const [st] = [STAGE[l.stage] || STAGE.new];
  const fu = (l.followups || [])[l.followups_sent || 0];
  const due = OPEN.includes(l.stage) && l.next_followup && l.next_followup <= today && fu;
  const log = (what, via) => [...(l.history || []), { day: today, what, via }];
  const mark = (stage, extra = {}, what = stage, via = "") => onSave({ ...l, stage, ...extra, history: log(what, via) });
  const markSent = via => mark("sent", { sent_at: today, sent_via: via, next_followup: addDays(today, 4), followups_sent: 0 }, "sent", via);
  const markFollowup = () => { const n = (l.followups_sent || 0) + 1; const more = (l.followups || []).length > n;
    mark("followed_up", { followups_sent: n, next_followup: more ? addDays(today, 6) : null }, `followup ${n}`, l.sent_via || ""); };
  const email = l.email, ig = l.instagram;
  const fuSubject = l.draft?.subject ? `Re: ${l.draft.subject}` : "";
  return <div style={{ ...card, borderColor: due ? C.gold : C.border }}>
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
          <span style={{ fontSize: 15 }}>{FLAG[l.country] || l.country}</span>
          <span style={{ fontWeight: 700, fontSize: 14.5 }}>{l.name}</span>
          <Tag c={l.tier === "A" ? "#fff" : C.inkMid} bg={l.tier === "A" ? ACCENT : C.card}>Tier {l.tier}</Tag>
          <Tag>{SEG[l.segment] || l.segment}</Tag>
          <Tag c={st[1]} bg={st[2]}>{st[0]}</Tag>
          {due && <Tag c="#fff" bg={C.gold}>Follow-up {(l.followups_sent || 0) + 1} due</Tag>}
          {l.language && l.language !== "en" && <Tag c={C.purple} bg={C.purpleBg}>{l.language === "ja" ? "日本語" : l.language}</Tag>}
        </div>
        <div style={{ fontSize: 12.5, color: C.inkMid, lineHeight: 1.45 }}>{l.why}</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 6, fontSize: 12 }}>
          {l.website && <a href={/^https?:/.test(l.website) ? l.website : `https://${l.website}`} target="_blank" rel="noreferrer" style={{ color: ACCENT }}>Website</a>}
          {ig && <a href={igUrl(ig)} target="_blank" rel="noreferrer" style={{ color: ACCENT }}>@{String(ig).replace(/^@/, "")}</a>}
          {l.etsy_url && <a href={l.etsy_url} target="_blank" rel="noreferrer" style={{ color: ACCENT }}>Etsy{l.sold ? ` · ${l.sold.toLocaleString()} sales` : ""}</a>}
          {email && <span style={{ color: C.inkMid }}>{email}</span>}
          {l.city && <span style={sub}>{l.city}</span>}
          {(l.signals || []).length > 0 && <span style={sub}>stocks: {l.signals.join(", ")}</span>}
        </div>
        {l.note && <div style={{ marginTop: 6, fontSize: 12, background: C.amberBg, borderRadius: 6, padding: "3px 8px", display: "inline-block" }}>Note: {l.note}</div>}
      </div>
      <button onClick={() => setOpen(o => !o)} style={btn()}>{open ? "Close" : "Open"}</button>
    </div>
    {open && <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 12, display: "grid", gap: 12 }}>
      {due && <div style={{ background: "#FBF4E4", borderRadius: 8, padding: 10 }}>
        <span style={lab}>Follow-up {(l.followups_sent || 0) + 1} · reply in the same {l.sent_via === "instagram" ? "Instagram chat" : "email thread"}</span>
        <div style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.5 }}>{fu.body}</div>
        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
          <button onClick={() => copy(fu.body, toast)} style={btn()}>Copy</button>
          {l.sent_via !== "instagram" && email && <a href={gmail(email, fuSubject, fu.body)} target="_blank" rel="noreferrer" style={{ ...btn(), textDecoration: "none" }}>Open in Gmail</a>}
          <button onClick={markFollowup} style={btn(C.ink, "#fff")}>Mark follow-up sent</button>
        </div>
      </div>}
      {l.draft && <div>
        <span style={lab}>Email{email ? ` to ${email}` : " (no address found: use the website's contact form)"}</span>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{l.draft.subject}</div>
        <div style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.55, background: C.card, borderRadius: 8, padding: 10 }}>{l.draft.body}</div>
        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
          {email && <a href={gmail(email, l.draft.subject, l.draft.body)} target="_blank" rel="noreferrer" style={{ ...btn(), textDecoration: "none" }}>Open in Gmail</a>}
          <button onClick={() => copy(`${l.draft.subject}\n\n${l.draft.body}`, toast)} style={btn()}>Copy</button>
          {l.stage === "new" && <button onClick={() => markSent("email")} style={btn(C.ink, "#fff")}>Mark email sent</button>}
        </div>
      </div>}
      {l.dm && <div>
        <span style={lab}>Instagram DM{ig ? ` to @${String(ig).replace(/^@/, "")}` : " (find their Instagram first)"}</span>
        <div style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.55, background: C.card, borderRadius: 8, padding: 10 }}>{l.dm}</div>
        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
          <button onClick={() => copy(l.dm, toast)} style={btn()}>Copy</button>
          {ig && <a href={igUrl(ig)} target="_blank" rel="noreferrer" style={{ ...btn(), textDecoration: "none" }}>Open Instagram</a>}
          {l.stage === "new" && <button onClick={() => markSent("instagram")} style={btn(C.ink, "#fff")}>Mark DM sent</button>}
        </div>
      </div>}
      <div>
        <span style={lab}>What happened</span>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {[["replied", "Replied"], ["talking", "In talks"], ["sample", "Sample / trial"], ["customer", "Customer 🎉"], ["no", "Not interested"], ["bounced", "Bounced"], ["skip", "Skip"], ["new", "Reset"]].map(([s, t]) =>
            <button key={s} onClick={() => mark(s, s === "replied" ? { replied_at: today, next_followup: null } : ["no", "bounced", "skip", "customer"].includes(s) ? { next_followup: null } : {})} style={l.stage === s ? btn(C.ink, "#fff") : btn()}>{t}</button>)}
          {note === null ? <button onClick={() => setNote(l.note || "")} style={btn()}>{l.note ? "Edit note" : "Add note"}</button> : null}
        </div>
        {note !== null && <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. wants 5 kg rose quartz tumbles, call Thursday" style={FI({ flex: 1 })} />
          <button onClick={async () => { await onSave({ ...l, note: note.trim() || null }); setNote(null); }} style={btn(C.ink, "#fff")}>Save</button>
          <button onClick={() => setNote(null)} style={btn()}>Cancel</button>
        </div>}
        {(l.history || []).length > 0 && <div style={{ ...sub, marginTop: 8 }}>{l.history.map(h => `${h.day} ${h.what}${h.via ? ` (${h.via})` : ""}`).join(" · ")}</div>}
      </div>
    </div>}
  </div>;
}

export default function OutreachApp({ onHome }) {
  const [leads, setLeads] = useState(null);
  const [err, setErr] = useState("");
  const [toastMsg, setToastMsg] = useState("");
  const [tab, setTab] = useState(() => { try { return localStorage.getItem("outreach-tab") || "today"; } catch { return "today"; } });
  const [f, setF] = useState({ country: "all", stage: "all", tier: "all", seg: "all", q: "" });
  const [shown, setShown] = useState(60);
  const today = istDay();
  const toast = m => { setToastMsg(m); setTimeout(() => setToastMsg(""), 2000); };
  const go = t => { setTab(t); try { localStorage.setItem("outreach-tab", t); } catch {} };
  const refresh = () => load().then(setLeads).catch(e => setErr(e.message));
  useEffect(() => { refresh(); }, []);
  const save = async l => { try { await put(l); setLeads(xs => xs.map(x => x.id === l.id ? l : x)); toast(STAGE[l.stage]?.[0] || "Saved"); } catch (e) { setErr(e.message); } };

  const stats = useMemo(() => {
    const s = { total: 0, contacted: 0, replied: 0, customers: 0, byCountry: {} };
    for (const l of leads || []) {
      s.total++; if (l.stage !== "new" && l.stage !== "skip") s.contacted++;
      if (["replied", "talking", "sample", "customer"].includes(l.stage)) s.replied++;
      if (l.stage === "customer") s.customers++;
      s.byCountry[l.country] = (s.byCountry[l.country] || 0) + 1;
    }
    return s;
  }, [leads]);

  const shell = body => <div style={{ minHeight: "100vh", background: C.bg, fontFamily: FONT, color: C.ink }}>
    {toastMsg && <div style={{ position: "fixed", bottom: 22, right: 22, left: mob() ? 22 : "auto", zIndex: 1200, background: C.ink, color: "#fff", padding: "10px 18px", borderRadius: 6, fontSize: 12.5 }}>{toastMsg}</div>}
    <div style={{ position: "sticky", top: 0, zIndex: 100, background: C.surface, borderBottom: `1px solid ${C.border}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: mob() ? "10px 14px" : "11px 28px" }}>
        {onHome && <button onClick={onHome} style={{ background: "none", border: "none", cursor: "pointer", color: C.inkMid, fontFamily: "inherit", fontSize: 13, padding: "0 12px 0 0", borderRight: `1px solid ${C.border}` }}>← Home</button>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, lineHeight: 1 }}>Wholesale outreach</div>
          <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 1 }}>Crystal shops abroad · bulk by the kilo · trade.eartheditions.co</div>
        </div>
        <button onClick={refresh} style={btn()}>↻</button>
      </div>
      <div style={{ display: "flex", overflowX: "auto", padding: mob() ? "0 10px" : "0 28px" }}>
        {[["today", "☀️", "Today"], ["all", "📇", "All leads"], ["playbook", "📘", "Playbook"]].map(([k, ic, t]) =>
          <button key={k} onClick={() => go(k)} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: -1, border: "none", background: "none", cursor: "pointer", fontFamily: "inherit", padding: "11px 14px", fontSize: 13, whiteSpace: "nowrap", fontWeight: tab === k ? 700 : 500, color: tab === k ? C.ink : C.inkMid, borderBottom: `2px solid ${tab === k ? C.gold : "transparent"}` }}><span>{ic}</span>{t}</button>)}
      </div>
    </div>
    <div style={{ padding: mob() ? "14px" : "20px 28px", maxWidth: 1100, margin: "0 auto" }}>
      {err && <div style={{ ...card, background: C.redBg, color: C.red, marginBottom: 12, fontSize: 13 }}>{err}</div>}
      {body}
    </div>
  </div>;

  if (!leads) return shell(<div style={sub}>Loading…</div>);
  const kpi = (n, t) => <div style={card}><div style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 700 }}>{n}</div><div style={sub}>{t}</div></div>;
  const kpis = <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr 1fr" : "repeat(4, minmax(0,1fr))", gap: 10, marginBottom: 16 }}>
    {kpi(stats.total, Object.entries(stats.byCountry).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${FLAG[c] || c} ${n}`).join("  "))}
    {kpi(stats.contacted, "contacted")}{kpi(stats.replied, `replied${stats.contacted ? ` · ${Math.round(stats.replied / stats.contacted * 100)}%` : ""}`)}{kpi(stats.customers, "became customers")}
  </div>;

  if (tab === "playbook") return shell(<div style={{ ...card, fontSize: 14, lineHeight: 1.6 }}><Md text={PLAYBOOK} /></div>);

  if (tab === "today") {
    const due = leads.filter(l => OPEN.includes(l.stage) && l.next_followup && l.next_followup <= today && (l.followups || [])[l.followups_sent || 0]);
    const usedE = sentToday(leads, "email", today), usedI = sentToday(leads, "instagram", today);
    const fresh = leads.filter(l => l.stage === "new").sort((a, b) => (a.tier || "C").localeCompare(b.tier || "C") || (b.score || 0) - (a.score || 0));
    const pickE = fresh.filter(l => l.email && l.channel !== "instagram").slice(0, Math.max(0, CAP.email - usedE));
    const pickI = fresh.filter(l => !pickE.includes(l) && l.instagram && l.dm).slice(0, Math.max(0, CAP.instagram - usedI));
    return shell(<>
      {kpis}
      <div style={{ ...sub, marginBottom: 14 }}>Today: {usedE}/{CAP.email} emails and {usedI}/{CAP.instagram} Instagram DMs sent. Staying under these limits keeps the mailbox and the Instagram account out of spam filters. Reply to anyone who answers within a day.</div>
      <div style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, margin: "0 0 10px" }}>Follow-ups due <span style={{ ...sub, fontFamily: FONT }}>{due.length}</span></div>
      <div style={{ display: "grid", gap: 10, marginBottom: 22 }}>{due.map(l => <Lead key={l.id} l={l} onSave={save} toast={toast} today={today} open />)}{!due.length && <div style={{ ...card, ...sub }}>None due today.</div>}</div>
      <div style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, margin: "0 0 10px" }}>Send today by email <span style={{ ...sub, fontFamily: FONT }}>{pickE.length}</span></div>
      <div style={{ display: "grid", gap: 10, marginBottom: 22 }}>{pickE.map(l => <Lead key={l.id} l={l} onSave={save} toast={toast} today={today} />)}{!pickE.length && <div style={{ ...card, ...sub }}>Daily email limit reached, or no leads with an email left.</div>}</div>
      <div style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, margin: "0 0 10px" }}>Send today on Instagram <span style={{ ...sub, fontFamily: FONT }}>{pickI.length}</span></div>
      <div style={{ display: "grid", gap: 10 }}>{pickI.map(l => <Lead key={l.id} l={l} onSave={save} toast={toast} today={today} />)}{!pickI.length && <div style={{ ...card, ...sub }}>Daily DM limit reached, or no Instagram leads left.</div>}</div>
    </>);
  }

  const q = f.q.trim().toLowerCase();
  const list = leads.filter(l => (f.country === "all" || l.country === f.country) && (f.stage === "all" || l.stage === f.stage) && (f.tier === "all" || l.tier === f.tier) && (f.seg === "all" || l.segment === f.seg)
    && (!q || `${l.name} ${l.city || ""} ${l.email || ""} ${l.instagram || ""}`.toLowerCase().includes(q)))
    .sort((a, b) => (a.tier || "C").localeCompare(b.tier || "C") || (b.score || 0) - (a.score || 0));
  const sel = (k, opts) => <select value={f[k]} onChange={e => { setF(x => ({ ...x, [k]: e.target.value })); setShown(60); }} style={FI({ width: "auto", padding: "6px 8px" })}>{opts.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select>;
  return shell(<>
    {kpis}
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
      {sel("country", [["all", "All countries"], ...Object.keys(stats.byCountry).sort().map(c => [c, `${FLAG[c] || ""} ${c}`])])}
      {sel("tier", [["all", "All tiers"], ["A", "Tier A"], ["B", "Tier B"], ["C", "Tier C"]])}
      {sel("seg", [["all", "All types"], ...Object.entries(SEG)])}
      {sel("stage", [["all", "Any stage"], ...Object.entries(STAGE).map(([k, v]) => [k, v[0]])])}
      <input value={f.q} onChange={e => setF(x => ({ ...x, q: e.target.value }))} placeholder="Search name, email, @handle" style={FI({ width: 220 })} />
      <span style={sub}>{list.length} leads</span>
    </div>
    <div style={{ display: "grid", gap: 10 }}>{list.slice(0, shown).map(l => <Lead key={l.id} l={l} onSave={save} toast={toast} today={today} />)}</div>
    {list.length > shown && <button onClick={() => setShown(n => n + 60)} style={{ ...btn(), marginTop: 12 }}>Show more</button>}
  </>);
}
