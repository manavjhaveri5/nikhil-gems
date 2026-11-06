import React, { useEffect, useMemo, useState } from "react";
import { C, FI } from "./ui.jsx";
import { mob, loadK, saveK } from "./utils.js";
import { sbThumb } from "./photoUrls.js";
import { fetchWithRetry } from "./aiClient.js";

/* Customers: every buyer across Etsy (both shops), eartheditions.co, atyahara.com
   and eBay, built from ng-orders-v1 (one row per piece sold). A buyer is a name +
   country. Cancelled and refunded lines are left out. Money is in rupees: Etsy
   rows are already INR, USD rows are converted at the finance rate.
   Contact details and notes Sir adds are kept in ng-customer-notes-v1 (a map by
   customer key), since Etsy hides buyers' emails. Drafts are written by
   /api/claude (OpenAI) from the buyer's real history and pieces in stock; they
   are only drafts: nothing is sent from here. */

const NOTES_KEY = "ng-customer-notes-v1";
const SERIF = "'Cormorant Garamond',Georgia,serif";
const DAY = 86400000;
const card = { background: C.surface, borderRadius: 16, boxShadow: "var(--e-1)", border: `1px solid ${C.border}`, padding: mob ? "14px" : "18px 20px", minWidth: 0 };
const eyebrow = { fontSize: 10.5, fontWeight: 800, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 1.1 };
const TIER = { vip: ["VIP", "#9C3D0A", "#F8E6D8"], strong: ["Strong", C.blue, C.blueBg], one: ["One-time", C.inkMid, C.card] };
const CH = { "Atyahara Etsy": "#F56400", "EE Etsy": "#9C3D0A", "eartheditions.co": C.teal, "atyahara.com": C.green, eBay: C.blue };

const dec = t => String(t || "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const norm = n => String(n || "").toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
const title = n => String(n || "").toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
const inr = v => { const a = Math.round(v || 0); return a >= 100000 ? `₹${(a / 100000).toFixed(a >= 1000000 ? 1 : 2).replace(/\.?0+$/, "")}L` : `₹${a.toLocaleString("en-IN")}`; };
const flag = iso => /^[A-Z]{2}$/.test(iso || "") ? String.fromCodePoint(...[...iso].map(c => 127397 + c.charCodeAt(0))) : "🌐";
const ago = days => days < 1 ? "today" : days < 31 ? `${days}d ago` : days < 365 ? `${Math.round(days / 30)}mo ago` : `${(days / 365).toFixed(1).replace(/\.0$/, "")}y ago`;
const channelOf = o => o.platform === "etsy" ? (o.etsy_shop === "earth" ? "EE Etsy" : "Atyahara Etsy") : o.platform === "store" ? "eartheditions.co" : o.platform === "shopify_aty" ? "atyahara.com" : o.platform === "ebay" ? "eBay" : o.platform;
const shortTitle = t => dec(t).split(/\s[|–—-]\s|:/)[0].trim().slice(0, 60);
const imgOf = l => { const i = (l?.images || [])[0]; const u = typeof i === "string" ? i : i?.url || i?.src; return u ? sbThumb(u, 200) : ""; };
const STONE_STOP = new Set(["natural", "polished", "raw", "crystal", "stone", "gemstone", "handmade", "rare", "large", "small", "set", "piece", "the", "and", "with", "for", "from", "india", "healing", "aaa", "sphere", "tower", "wand", "bracelet", "point", "palmstone", "heart", "specimen", "mineral", "matrix", "decor", "home", "energy", "reiki", "hand", "carved", "inch", "mm", "grams", "high", "grade", "quality", "collector", "premium", "beaded", "beads", "round", "bead", "gift"]);
const words = t => dec(t).toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter(w => w.length > 3 && !STONE_STOP.has(w));

function buildCustomers(orders, rate) {
  const B = new Map();
  for (const o of orders || []) {
    if (o.cancelled || o.refunded || /cancel|refund/i.test(o.status || "")) continue;
    const name = dec(o.buyer_name || o.ship_name); if (!norm(name)) continue;
    const country = o.buyer_country || o.ship_country || "";
    const key = norm(name) + "|" + country;
    const amt = String(o.currency || "INR").toUpperCase() === "USD" ? (+o.sale_price || 0) * rate : (+o.sale_price || 0);
    const c = B.get(key) || { key, name: /[a-z]/.test(name) ? name : title(name), country, city: o.ship_city ? title(o.ship_city) : "", state: o.ship_state || "", emails: new Set(), orders: new Map(), lines: [], spend: 0, pieces: 0, channels: new Set(), mats: {}, shapes: {} };
    if (o.buyer_email) c.emails.add(o.buyer_email);
    const oid = o.platform_order_id || o.order_number || o.id;
    const prev = c.orders.get(oid) || { id: oid, number: o.order_number, date: o.date, total: 0, channel: channelOf(o), lines: [] };
    prev.total += amt; prev.lines.push(o); c.orders.set(oid, prev);
    c.lines.push({ date: o.date, amt, title: dec(o.listing_title), img: o.listing_image, mat: o.listing_material, shape: o.listing_shape, channel: channelOf(o), number: o.order_number });
    c.spend += amt; c.pieces += +o.qty || 1; c.channels.add(channelOf(o));
    for (const m of String(o.listing_material || "").split(/,\s*/).filter(Boolean)) c.mats[m.toLowerCase()] = (c.mats[m.toLowerCase()] || 0) + 1;
    for (const w of words(o.listing_title)) c.mats[w] = (c.mats[w] || 0) + 0.5;
    if (o.listing_shape) c.shapes[o.listing_shape] = (c.shapes[o.listing_shape] || 0) + 1;
    B.set(key, c);
  }
  const now = Date.now();
  return [...B.values()].map(c => {
    const ords = [...c.orders.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const first = ords[0]?.date, last = ords[ords.length - 1]?.date;
    const since = last ? Math.max(0, Math.round((now - new Date(last)) / DAY)) : 9999;
    const gaps = ords.slice(1).map((o, i) => (new Date(o.date) - new Date(ords[i].date)) / DAY).filter(g => g > 0);
    const n = ords.length;
    const tier = c.spend >= 50000 || (n >= 3 && c.spend >= 20000) ? "vip" : c.spend >= 20000 || n >= 2 ? "strong" : "one";
    const score = Math.round(c.spend / 1000 + (n - 1) * 25 + Math.max(0, 20 - since / 18));
    const lapsed = n >= 2 && gaps.length ? since > Math.max(120, 2.5 * (gaps.reduce((a, b) => a + b, 0) / gaps.length)) : since > 365;
    return { ...c, emails: [...c.emails], channels: [...c.channels], ords, n, first, last, since, tier, score, lapsed, aov: c.spend / n,
      gap: gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null,
      biggest: c.lines.reduce((a, l) => l.amt > (a?.amt || 0) ? l : a, null),
      topMats: Object.entries(c.mats).sort((a, b) => b[1] - a[1]).slice(0, 6).map(e => e[0]),
      topShapes: Object.entries(c.shapes).sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]) };
  }).sort((a, b) => b.score - a.score);
}

/* ── small pieces ── */
function Kpi({ label, value, sub }) {
  return <div style={{ ...card, padding: "14px 16px" }}>
    <div style={eyebrow}>{label}</div>
    <div style={{ fontFamily: SERIF, fontVariantNumeric: "lining-nums", fontSize: 30, fontWeight: 600, color: C.ink, lineHeight: 1.1, marginTop: 4 }}>{value}</div>
    {sub && <div style={{ fontSize: 11.5, color: C.inkMid, marginTop: 3 }}>{sub}</div>}
  </div>;
}
function Section({ title: t, sub, right, children, style }) {
  return <div style={{ ...card, ...style }}>
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
      <div><div style={{ fontFamily: SERIF, fontSize: 21, fontWeight: 600, color: C.ink, lineHeight: 1.1 }}>{t}</div>
        {sub && <div style={{ fontSize: 12, color: C.inkMid, marginTop: 3, maxWidth: 720 }}>{sub}</div>}</div>
      {right}
    </div>
    {children}
  </div>;
}
const Pill = ({ children, color = C.inkMid, bg = C.card }) => <span style={{ fontSize: 10.5, fontWeight: 800, color, background: bg, borderRadius: 999, padding: "2px 8px", whiteSpace: "nowrap" }}>{children}</span>;
const TierPill = ({ t }) => { const [l, c, bg] = TIER[t]; return <Pill color={c} bg={bg}>{l}</Pill>; };
const Btn = ({ on, children, onClick, primary, disabled, title: tt }) => <button title={tt} disabled={disabled} onClick={onClick} style={{ border: primary ? "none" : `1px solid ${C.border}`, cursor: disabled ? "default" : "pointer", fontSize: 12.5, fontWeight: 800, padding: "7px 12px", borderRadius: 9, opacity: disabled ? .5 : 1,
  background: primary ? C.ink : on ? C.ink : C.surface, color: primary || on ? "#fff" : C.inkMid, whiteSpace: "nowrap" }}>{children}</button>;

/* Where the money comes from: buyers ranked by spend, cut into bands. */
function Concentration({ list }) {
  const total = list.reduce((a, c) => a + c.spend, 0) || 1, sorted = [...list].sort((a, b) => b.spend - a.spend), N = sorted.length;
  const cut = (from, to) => sorted.slice(Math.floor(from * N), Math.max(Math.floor(from * N) + 1, Math.floor(to * N))).reduce((a, c) => a + c.spend, 0);
  const bands = [["Top 1%", cut(0, .01), "#9C3D0A"], ["Next 9%", cut(.01, .1), "#D95A00"], ["Next 40%", cut(.1, .5), "#E9A46B"], ["Bottom 50%", cut(.5, 1), "#F3D9C2"]];
  return <div>
    <div style={{ display: "flex", height: 34, borderRadius: 10, overflow: "hidden" }}>
      {bands.map(([l, v, col]) => <div key={l} title={`${l}: ${inr(v)}`} style={{ width: `${v / total * 100}%`, background: col, display: "flex", alignItems: "center", justifyContent: "center", color: col === "#F3D9C2" || col === "#E9A46B" ? "#5A2A08" : "#fff", fontSize: 11.5, fontWeight: 800, minWidth: 0, overflow: "hidden" }}>{v / total > .07 ? `${Math.round(v / total * 100)}%` : ""}</div>)}
    </div>
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", marginTop: 10 }}>
      {bands.map(([l, v, col]) => <div key={l} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.inkMid }}>
        <span style={{ width: 10, height: 10, borderRadius: 3, background: col }} /><b style={{ color: C.ink }}>{l}</b> of buyers · {inr(v)} ({Math.round(v / total * 100)}%)</div>)}
    </div>
  </div>;
}

/* Revenue by month, split into first orders and repeat orders. */
function NewVsRepeat({ list }) {
  const months = useMemo(() => {
    const m = {};
    for (const c of list) c.ords.forEach((o, i) => { const k = String(o.date).slice(0, 7); if (!/^\d{4}-\d{2}$/.test(k)) return; m[k] = m[k] || { k, first: 0, repeat: 0 }; m[k][i === 0 ? "first" : "repeat"] += o.total; });
    return Object.values(m).sort((a, b) => a.k.localeCompare(b.k)).slice(-18);
  }, [list]);
  const max = Math.max(1, ...months.map(m => m.first + m.repeat)), H = 150;
  const repeatShare = months.reduce((a, m) => a + m.repeat, 0) / Math.max(1, months.reduce((a, m) => a + m.first + m.repeat, 0));
  return <div>
    <div style={{ display: "flex", alignItems: "flex-end", gap: mob ? 2 : 5, height: H + 22 }}>
      {months.map(m => { const t = m.first + m.repeat; return <div key={m.k} title={`${m.k}: first orders ${inr(m.first)}, repeat ${inr(m.repeat)}`} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "stretch", minWidth: 0 }}>
        <div style={{ height: H, display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
          <div style={{ height: m.repeat / max * H, background: "#9C3D0A", borderRadius: "4px 4px 0 0" }} />
          <div style={{ height: m.first / max * H, background: "#E9A46B", borderRadius: m.repeat ? 0 : "4px 4px 0 0" }} />
        </div>
        <div style={{ fontSize: 9.5, color: C.inkFaint, textAlign: "center", marginTop: 4, whiteSpace: "nowrap", overflow: "hidden" }}>{new Date(m.k + "-01").toLocaleString("en", { month: "short" })}{m.k.endsWith("-01") ? ` ’${m.k.slice(2, 4)}` : ""}</div>
      </div>; })}
    </div>
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, color: C.inkMid, marginTop: 6 }}>
      <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: "#E9A46B", marginRight: 6 }} />First order</span>
      <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: "#9C3D0A", marginRight: 6 }} />Repeat order</span>
      <span>Repeat buyers brought <b style={{ color: C.ink }}>{Math.round(repeatShare * 100)}%</b> of revenue in these months.</span>
    </div>
  </div>;
}

function Countries({ list }) {
  const rows = useMemo(() => { const m = {}; for (const c of list) { const k = c.country || "?"; m[k] = m[k] || { k, n: 0, spend: 0 }; m[k].n++; m[k].spend += c.spend; } return Object.values(m).sort((a, b) => b.spend - a.spend).slice(0, 8); }, [list]);
  const top = rows[0]?.spend || 1;
  return <div style={{ display: "grid", gap: 7 }}>{rows.map(r => <div key={r.k} style={{ display: "grid", gridTemplateColumns: "52px 1fr 86px", alignItems: "center", gap: 8, fontSize: 12.5 }}>
    <span style={{ fontWeight: 800, whiteSpace: "nowrap" }}>{flag(r.k)} {r.k}</span>
    <div style={{ background: C.card, borderRadius: 6, height: 16, overflow: "hidden" }}><div style={{ width: `${r.spend / top * 100}%`, height: "100%", background: "#D95A00", borderRadius: 6 }} /></div>
    <span style={{ textAlign: "right", color: C.inkMid }}>{inr(r.spend)}<span style={{ color: C.inkFaint }}> · {r.n}</span></span>
  </div>)}</div>;
}

/* Spend over time for one buyer: a dot per order, sized by value. */
function Timeline({ c }) {
  if (!c.ords.length) return null;
  const t0 = +new Date(c.ords[0].date), t1 = Math.max(+new Date(c.ords[c.ords.length - 1].date), t0 + 30 * DAY), max = Math.max(...c.ords.map(o => o.total));
  return <div style={{ position: "relative", height: 64, margin: "6px 12px 4px" }}>
    <div style={{ position: "absolute", left: 0, right: 0, top: 32, height: 2, background: C.border }} />
    {c.ords.map(o => { const x = (+new Date(o.date) - t0) / (t1 - t0) * 100, r = 8 + 18 * Math.sqrt(o.total / max); return <div key={o.id} title={`${o.date} · ${inr(o.total)} · ${o.lines.length} pc`} style={{ position: "absolute", left: `calc(${x}% - ${r / 2}px)`, top: 33 - r / 2, width: r, height: r, borderRadius: "50%", background: CH[o.channel] || "#D95A00", opacity: .85, border: "2px solid var(--c-surface)" }} />; })}
    <div style={{ position: "absolute", left: 0, bottom: -4, fontSize: 10, color: C.inkFaint }}>{c.ords[0].date}</div>
    <div style={{ position: "absolute", right: 0, bottom: -4, fontSize: 10, color: C.inkFaint }}>{c.ords[c.ords.length - 1].date}</div>
  </div>;
}

/* Pieces in stock that fit this buyer: shared stones first, then shape, then a price near what they spend. */
function suggest(c, listings) {
  const mats = new Set(c.topMats), shapes = new Set(c.topShapes);
  const bought = new Set(c.lines.map(l => norm(shortTitle(l.title))));
  const live = l => ["store", "etsy_ee"].some(k => l.platforms?.[k]?.status === "active");
  return (listings || []).filter(l => Number(l.qty || 0) > 0 && live(l) && !bought.has(norm(shortTitle(l.title)))).map(l => {
    const lw = new Set([...words(l.title), ...String(l.material || "").toLowerCase().split(/,\s*/).filter(Boolean)]);
    let s = 0; for (const m of mats) if (lw.has(m) || [...lw].some(w => w.includes(m) && m.length > 4)) s += 3;
    if (shapes.has(l.shape)) s += 2;
    const p = +l.price_etsy || 0;
    if (p && c.biggest?.amt) { const r = p / c.biggest.amt; s += r > .3 && r < 2.5 ? 2 : r > .1 && r < 5 ? 1 : 0; }
    return { l, s, p };
  }).filter(x => x.s >= 4).sort((a, b) => b.s - a.s || b.p - a.p).slice(0, 12);
}

/* ── the profile ── */
function Profile({ c, note, onNote, listings, onClose }) {
  const [email, setEmail] = useState(note?.email || c.emails[0] || ""), [memo, setMemo] = useState(note?.notes || "");
  const picks = useMemo(() => suggest(c, listings), [c, listings]);
  const [chosen, setChosen] = useState(() => new Set(picks.slice(0, 3).map(x => x.l.id)));
  const [via, setVia] = useState(email ? "email" : "etsy"), [occasion, setOccasion] = useState("Diwali / festive greeting"), [extra, setExtra] = useState("");
  const [draft, setDraft] = useState(note?.lastDraft || ""), [busy, setBusy] = useState(false), [err, setErr] = useState(""), [copied, setCopied] = useState(false);
  const save = patch => onNote(c.key, { ...(note || {}), email, notes: memo, ...patch });
  // Saved notes can arrive after the panel opens (they load in the background): fill in what's still empty.
  useEffect(() => {
    if (!note) return;
    if (note.email) { setEmail(e => e || note.email); setVia(v => v === "etsy" && !email ? "email" : v); }
    if (note.notes) setMemo(m => m || note.notes);
    if (note.lastDraft) setDraft(d => d || note.lastDraft);
  }, [note]);

  const write = async () => {
    setBusy(true); setErr("");
    try {
      const pieces = picks.filter(x => chosen.has(x.l.id)).map(x => ({ title: shortTitle(x.l.title), price_inr: x.p || null, link: via === "email" ? (x.l.platforms?.store?.status === "active" ? x.l.platforms.store.url : x.l.platforms?.etsy_ee?.url) : null }));
      const hist = c.ords.map(o => `${o.date} (${o.channel}): ${o.lines.map(l => shortTitle(l.listing_title)).join("; ")}`).join("\n");
      const sys = `You write short, warm, personal messages from Sejal at Nikhil Gems (a family gemstone business in Mumbai) to a past customer. The new collector shop is Earth Editions (same family, same workshop).
Rules: use ONLY facts given here; never invent sizes, prices, stock levels, scarcity, discounts, "new arrivals" or anything about the buyer. Describe each piece only by its title: never claim its clarity, condition, polish, lack of scratches or quality. Sir's notes describe the BUYER (what they like or asked for), never the pieces. Don't say "I hope this message finds you well". Mention what they bought before, naturally. Offer photos or a video. No pressure, no hype, no emojis. Under 170 words.
${via === "email" ? "This is an EMAIL: start with 'Subject: ...' on the first line, then the body. You may include the given links, one per piece, as a short bulleted list. Sign off as Sejal, Nikhil Gems." : "This is an ETSY MESSAGE: no links, no website or shop names other than Etsy, no subject line. Name the pieces and offer to send photos. Sign off as Sejal."}`;
      const usr = `Buyer: ${c.name} (${[c.city, c.country].filter(Boolean).join(", ")})
Orders: ${c.n}, pieces ${c.pieces}, last order ${c.last} (${ago(c.since)}).
Purchase history:\n${hist}
Notes from Sir: ${memo || "none"}
Occasion: ${occasion}${extra ? `\nAlso: ${extra}` : ""}
Pieces to offer:\n${pieces.map(p => `- ${p.title}${p.link ? ` — ${p.link}` : ""}`).join("\n") || "- none chosen: just reconnect and offer to show new pieces matching what they like"}`;
      const res = await fetchWithRetry("/api/claude", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_tokens: 700, messages: [{ role: "system", content: sys }, { role: "user", content: usr }] }) }, { tries: 2, timeoutMs: 60000 });
      const d = await res.json();
      if (d.error) throw new Error(d.error?.message || d.error);
      const text = (d.content || []).map(x => x.text || "").join("").trim();
      setDraft(text); save({ lastDraft: text, lastDraftAt: new Date().toISOString() });
    } catch (e) { setErr(e.message || "Couldn't write the draft"); }
    setBusy(false);
  };
  const subjectOf = t => (t.match(/^subject:\s*(.+)$/im) || [])[1] || "";
  const bodyOf = t => t.replace(/^subject:.*\n+/i, "");
  const gmail = `https://mail.google.com/mail/?authuser=sejal.nikhilgems@gmail.com&view=cm&fs=1&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subjectOf(draft))}&body=${encodeURIComponent(bodyOf(draft))}`;
  const lastEtsy = c.ords.slice().reverse().find(o => /Etsy/.test(o.channel));
  const receipt = lastEtsy?.lines?.[0]?.etsy_receipt_id;

  return <div style={{ position: "fixed", inset: 0, zIndex: 900, background: "rgba(20,12,4,.35)", display: "flex", justifyContent: "flex-end" }} onClick={onClose}>
    <div onClick={e => e.stopPropagation()} style={{ width: mob ? "100%" : 720, maxWidth: "100%", height: "100%", overflowY: "auto", overflowX: "hidden", boxSizing: "border-box", background: C.bg, padding: mob ? 14 : 22, boxShadow: "-8px 0 32px rgba(0,0,0,.18)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
        <div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}><TierPill t={c.tier} />{c.lapsed && <Pill color={C.amber} bg={C.amberBg}>Lapsed</Pill>}{c.channels.map(ch => <Pill key={ch} color="#fff" bg={CH[ch] || C.inkMid}>{ch}</Pill>)}</div>
          <div style={{ fontFamily: SERIF, fontSize: 34, fontWeight: 600, color: C.ink, lineHeight: 1.1, marginTop: 6 }}>{c.name}</div>
          <div style={{ fontSize: 13, color: C.inkMid }}>{flag(c.country)} {[c.city, c.state, c.country].filter(Boolean).join(", ")} · customer since {c.first}</div>
        </div>
        <Btn onClick={onClose}>✕</Btn>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "repeat(4,1fr)", gap: 10, marginTop: 16 }}>
        <Kpi label="Lifetime" value={inr(c.spend)} sub={`${c.n} orders · ${c.pieces} pcs`} />
        <Kpi label="Avg order" value={inr(c.aov)} sub={c.biggest ? `top piece ${inr(c.biggest.amt)}` : ""} />
        <Kpi label="Last order" value={ago(c.since)} sub={c.last} />
        <Kpi label="Buys every" value={c.gap ? `${c.gap}d` : "—"} sub={c.gap ? "average gap" : "one order so far"} />
      </div>

      <Section title="Order history" style={{ marginTop: 12 }} sub="Each dot is an order; bigger means more spent.">
        <Timeline c={c} />
        <div style={{ display: "grid", gap: 6, marginTop: 14 }}>
          {c.ords.slice().reverse().map(o => <div key={o.id} style={{ borderTop: `1px solid ${C.border}`, paddingTop: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.inkMid }}><span><b style={{ color: C.ink }}>{o.date}</b> · {o.number} · <span style={{ color: CH[o.channel] }}>{o.channel}</span></span><b style={{ color: C.ink }}>{inr(o.total)}</b></div>
            {o.lines.map((l, i) => <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 6 }}>
              {l.listing_image ? <img src={l.listing_image} alt="" loading="lazy" style={{ width: 38, height: 38, borderRadius: 8, objectFit: "cover", background: C.card, flexShrink: 0 }} /> : <div style={{ width: 38, height: 38, borderRadius: 8, background: C.card, flexShrink: 0 }} />}
              <div style={{ fontSize: 12.5, color: C.ink, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dec(l.listing_title)}</div>
            </div>)}
          </div>)}
        </div>
      </Section>

      <Section title="What they like" style={{ marginTop: 12 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{c.topMats.map(m => <Pill key={m} color="#5A2A08" bg="#F8E6D8">{m}</Pill>)}{c.topShapes.map(s => <Pill key={s}>{s}</Pill>)}</div>
      </Section>

      <Section title="Contact & notes" style={{ marginTop: 12 }} sub="Etsy hides buyers' emails, so add one here when they've written to you directly. Kept in the ERP only.">
        <div style={{ display: "grid", gap: 8 }}>
          <input style={FI} placeholder="Email (if they've written to you directly)" value={email} onChange={e => setEmail(e.target.value)} onBlur={() => save({})} />
          <textarea style={{ ...FI, minHeight: 64, resize: "vertical" }} placeholder="Notes: preferences, what they asked for, past conversations…" value={memo} onChange={e => setMemo(e.target.value)} onBlur={() => save({})} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 12, color: C.inkMid, alignItems: "center" }}>
            {note?.contactedAt ? <span>Last contacted <b style={{ color: C.ink }}>{String(note.contactedAt).slice(0, 10)}</b> via {note.contactedVia}</span> : <span>Not contacted from here yet.</span>}
            {email && <a href={`https://mail.google.com/mail/#search/${encodeURIComponent(email)}`} target="_blank" rel="noreferrer" style={{ color: C.blue, fontWeight: 700 }}>Gmail history ↗</a>}
            {receipt && <a href={`https://www.etsy.com/your/orders/sold?order_id=${receipt}`} target="_blank" rel="noreferrer" style={{ color: C.blue, fontWeight: 700 }}>Etsy order & messages ↗</a>}
          </div>
        </div>
      </Section>

      <Section title="Pieces for them" style={{ marginTop: 12 }} sub="In stock and live on eartheditions.co or EarthEditions Etsy, matched on the stones and shapes they've bought. Tick the ones to offer.">
        {picks.length === 0 ? <div style={{ fontSize: 12.5, color: C.inkFaint }}>No close match in stock right now.</div> :
          <div style={{ display: "grid", gridTemplateColumns: mob ? "minmax(0,1fr)" : "minmax(0,1fr) minmax(0,1fr)", gap: 8 }}>
            {picks.map(({ l, p }) => { const on = chosen.has(l.id), url = l.platforms?.store?.status === "active" ? l.platforms.store.url : l.platforms?.etsy_ee?.url; return <label key={l.id} style={{ minWidth: 0, display: "flex", gap: 10, alignItems: "center", padding: 8, borderRadius: 10, border: `1px solid ${on ? "#D95A00" : C.border}`, background: on ? "#FDF3EA" : C.surface, cursor: "pointer" }}>
              <input type="checkbox" checked={on} onChange={() => setChosen(s => { const n = new Set(s); n.has(l.id) ? n.delete(l.id) : n.add(l.id); return n; })} />
              {imgOf(l) ? <img src={imgOf(l)} alt="" loading="lazy" style={{ width: 44, height: 44, borderRadius: 8, objectFit: "cover", flexShrink: 0 }} /> : <div style={{ width: 44, height: 44, borderRadius: 8, background: C.card, flexShrink: 0 }} />}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shortTitle(l.title)}</div>
                <div style={{ fontSize: 11.5, color: C.inkMid }}>{p ? inr(p) : ""}{url && <> · <a href={url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} style={{ color: C.blue }}>view ↗</a></>}</div>
              </div>
            </label>; })}
          </div>}
      </Section>

      <Section title="Draft a message" style={{ marginTop: 12, marginBottom: 30 }} sub="Written from their real order history and the pieces you ticked. Nothing is sent from here: copy it, or open it in Gmail and send it yourself.">
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          <Btn on={via === "email"} onClick={() => setVia("email")}>✉ Email (with links)</Btn>
          <Btn on={via === "etsy"} onClick={() => setVia("etsy")}>💬 Etsy message (no links)</Btn>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: mob ? "minmax(0,1fr)" : "minmax(0,1fr) minmax(0,1fr)", gap: 8 }}>
          <select style={FI} value={occasion} onChange={e => setOccasion(e.target.value)}>
            {["Diwali / festive greeting", "New Year greeting", "Pieces I think they'll like", "Thank-you and check-in", "Follow-up to an earlier message"].map(o => <option key={o}>{o}</option>)}
          </select>
          <input style={FI} placeholder="Anything to add (e.g. offer free insured shipping)" value={extra} onChange={e => setExtra(e.target.value)} />
        </div>
        {via === "etsy" && c.channels.every(ch => ch === "Atyahara Etsy") && <div style={{ fontSize: 11.5, color: C.amber, background: C.amberBg, borderRadius: 8, padding: "6px 10px", marginTop: 8 }}>Atyahara is on hold: keep it to one personal message, and don't point them off Etsy.</div>}
        <div style={{ marginTop: 8 }}><Btn primary onClick={write} disabled={busy}>{busy ? "Writing…" : draft ? "↻ Write again" : "✍ Write draft"}</Btn></div>
        {err && <div style={{ color: C.red, fontSize: 12, marginTop: 6 }}>{err}</div>}
        {draft && <>
          <textarea style={{ ...FI, minHeight: 260, resize: "vertical", marginTop: 10, lineHeight: 1.5 }} value={draft} onChange={e => setDraft(e.target.value)} onBlur={() => save({ lastDraft: draft })} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
            <Btn onClick={() => { navigator.clipboard?.writeText(via === "email" ? bodyOf(draft) : draft); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "✓ Copied" : "Copy"}</Btn>
            {via === "email" && <Btn disabled={!email} title={email ? "" : "Add their email above first"} onClick={() => window.open(gmail, "_blank")}>Open in Gmail ↗</Btn>}
            <Btn onClick={() => save({ lastDraft: draft, contactedAt: new Date().toISOString(), contactedVia: via === "email" ? "email" : "Etsy message" })}>✓ Mark as contacted</Btn>
          </div>
        </>}
      </Section>
    </div>
  </div>;
}

export default function CustomersApp({ orders = [], listings = [] }) {
  const [rate, setRate] = useState(88), [notes, setNotes] = useState({});
  const [q, setQ] = useState(""), [seg, setSeg] = useState("best"), [ch, setCh] = useState("all"), [sort, setSort] = useState("score"), [open, setOpen] = useState(null), [limit, setLimit] = useState(60);
  useEffect(() => {
    loadK("ng-fin-rates-v1").then(r => { if (+r?.USD > 0) setRate(+r.USD); }).catch(() => {});
    loadK(NOTES_KEY).then(n => setNotes(n && typeof n === "object" && !Array.isArray(n) ? n : {})).catch(() => {});
  }, []);
  const all = useMemo(() => buildCustomers(orders, rate), [orders, rate]);
  const onNote = (key, patch) => setNotes(prev => { const next = { ...prev, [key]: { ...patch, updatedAt: new Date().toISOString() } }; saveK(NOTES_KEY, next, { merge: false }).catch(() => {}); return next; });

  const stats = useMemo(() => {
    const total = all.reduce((a, c) => a + c.spend, 0), rep = all.filter(c => c.n > 1), vip = all.filter(c => c.tier === "vip");
    return { total, n: all.length, rep: rep.length, repShare: rep.reduce((a, c) => a + c.spend, 0) / (total || 1), vip: vip.length, vipShare: vip.reduce((a, c) => a + c.spend, 0) / (total || 1),
      lapsedVal: all.filter(c => c.lapsed && c.tier !== "one").reduce((a, c) => a + c.spend, 0), lapsedN: all.filter(c => c.lapsed && c.tier !== "one").length, ltv: total / (all.length || 1) };
  }, [all]);
  const channels = useMemo(() => [...new Set(all.flatMap(c => c.channels))], [all]);
  const shown = useMemo(() => {
    const s = norm(q);
    let l = all.filter(c => (seg === "all" || (seg === "best" ? c.tier !== "one" : seg === "lapsed" ? c.lapsed && c.tier !== "one" : seg === "contact" ? (notes[c.key]?.email || c.emails.length) : c.tier === seg))
      && (ch === "all" || c.channels.includes(ch)) && (!s || norm(c.name).includes(s) || c.topMats.some(m => m.includes(s)) || norm(c.country).includes(s)));
    const by = { score: (a, b) => b.score - a.score, spend: (a, b) => b.spend - a.spend, recent: (a, b) => a.since - b.since, orders: (a, b) => b.n - a.n }[sort];
    return l.sort(by);
  }, [all, q, seg, ch, sort, notes]);
  const exportCsv = () => {
    const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [["Buyer", "Tier", "Country", "City", "Orders", "Pieces", "Lifetime (Rs)", "Avg order (Rs)", "First", "Last", "Channels", "Likes", "Email", "Notes"]].concat(shown.map(c => [c.name, TIER[c.tier][0], c.country, c.city, c.n, c.pieces, Math.round(c.spend), Math.round(c.aov), c.first, c.last, c.channels.join(" + "), c.topMats.join(", "), notes[c.key]?.email || c.emails[0] || "", notes[c.key]?.notes || ""]));
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["﻿" + rows.map(r => r.map(esc).join(",")).join("\n")], { type: "text/csv" })); a.download = `customers-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  };
  const openC = all.find(c => c.key === open);

  return <div style={{ display: "grid", gap: 12 }}>
    <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr 1fr" : "repeat(5,1fr)", gap: 10 }}>
      <Kpi label="Customers" value={stats.n.toLocaleString("en-IN")} sub={`lifetime ${inr(stats.total)}`} />
      <Kpi label="Repeat buyers" value={stats.rep} sub={`${Math.round(stats.repShare * 100)}% of revenue`} />
      <Kpi label="VIPs" value={stats.vip} sub={`${Math.round(stats.vipShare * 100)}% of revenue`} />
      <Kpi label="Avg lifetime value" value={inr(stats.ltv)} sub="per customer" />
      <Kpi label="Lapsed good buyers" value={stats.lapsedN} sub={`${inr(stats.lapsedVal)} spent before`} />
    </div>
    <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "1.5fr 1fr", gap: 12 }}>
      <Section title="First vs repeat orders" sub="Revenue by month, last 18 months."><NewVsRepeat list={all} /></Section>
      <Section title="Where buyers are" sub="Lifetime spend · number of buyers"><Countries list={all} /></Section>
    </div>
    <Section title="Where the money comes from" sub="Every buyer ranked by lifetime spend. A small group of collectors brings most of the revenue: they're the ones worth a personal message."><Concentration list={all} /></Section>

    <Section title="Customers" sub="Click a buyer for their full history, the pieces in stock that fit them, and a drafted message."
      right={<Btn onClick={exportCsv}>⬇ Export CSV</Btn>}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        {[["best", "Best buyers"], ["vip", "VIP"], ["strong", "Strong"], ["lapsed", "Lapsed"], ["contact", "Have email"], ["all", "Everyone"]].map(([k, l]) => <Btn key={k} on={seg === k} onClick={() => { setSeg(k); setLimit(60); }}>{l}</Btn>)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: mob ? "1fr" : "2fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
        <input style={FI} placeholder="Search name, stone or country…" value={q} onChange={e => setQ(e.target.value)} />
        <select style={FI} value={ch} onChange={e => setCh(e.target.value)}><option value="all">All channels</option>{channels.map(c => <option key={c}>{c}</option>)}</select>
        <select style={FI} value={sort} onChange={e => setSort(e.target.value)}><option value="score">Best first</option><option value="spend">Highest spend</option><option value="orders">Most orders</option><option value="recent">Most recent</option></select>
      </div>
      <div style={{ fontSize: 12, color: C.inkFaint, marginBottom: 6 }}>{shown.length} buyers</div>
      <div style={{ display: "grid", gap: 6 }}>
        {shown.slice(0, limit).map(c => { const nt = notes[c.key], em = nt?.email || c.emails[0]; return <button key={c.key} onClick={() => setOpen(c.key)} style={{ all: "unset", cursor: "pointer", display: "grid", gridTemplateColumns: mob ? "1fr auto" : "minmax(180px,1.6fr) 1.6fr 90px 90px 110px", gap: 10, alignItems: "center", padding: "10px 12px", borderRadius: 12, border: `1px solid ${C.border}`, background: C.surface }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}><TierPill t={c.tier} /><b style={{ fontSize: 14, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</b></div>
            <div style={{ fontSize: 11.5, color: C.inkMid, marginTop: 2 }}>{flag(c.country)} {[c.city, c.country].filter(Boolean).join(", ")}{em ? " · ✉" : ""}{nt?.contactedAt ? ` · contacted ${String(nt.contactedAt).slice(5, 10)}` : ""}{c.lapsed && c.tier !== "one" ? " · lapsed" : ""}</div>
          </div>
          {!mob && <div style={{ display: "flex", gap: 4, flexWrap: "wrap", overflow: "hidden", maxHeight: 44 }}>{c.topMats.slice(0, 4).map(m => <Pill key={m} color="#5A2A08" bg="#F8E6D8">{m}</Pill>)}</div>}
          {!mob && <div style={{ fontSize: 12, color: C.inkMid, textAlign: "right" }}><b style={{ color: C.ink }}>{c.n}</b> order{c.n > 1 ? "s" : ""}<br />{c.pieces} pcs</div>}
          {!mob && <div style={{ fontSize: 12, color: C.inkMid, textAlign: "right" }}>{ago(c.since)}</div>}
          <div style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 600, color: C.ink, textAlign: "right" }}>{inr(c.spend)}</div>
        </button>; })}
      </div>
      {shown.length > limit && <div style={{ marginTop: 10 }}><Btn onClick={() => setLimit(l => l + 60)}>Show more</Btn></div>}
    </Section>
    {openC && <Profile key={openC.key} c={openC} note={notes[openC.key]} onNote={onNote} listings={listings} onClose={() => setOpen(null)} />}
  </div>;
}
