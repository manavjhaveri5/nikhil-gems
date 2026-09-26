/* Trade site — the ERP's side of trade.eartheditions.co: the carts buyers send
   on WhatsApp, the buyers themselves, the products they see, and the settings.

   Everything lives in the trade_* tables. Staff reach them with their normal
   ERP session; buyers never do (they go through the trade site's own server
   function), so nothing here is visible to a buyer. */
import { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "./supabase.js";
import { C, mob, FI } from "./lmTheme.js";
import { loadK, uid } from "./utils.js";

const FONT = "-apple-system,'SF Pro Display','Figtree',system-ui,sans-serif";
const SERIF = "'Cormorant Garamond',Georgia,serif";
const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12 };
const btn = (bg = C.surface, fg = C.ink) => ({ background: bg, color: fg, border: bg === C.surface ? `1px solid ${C.border}` : "none", borderRadius: 7, padding: "7px 13px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" });
const lab = { fontSize: 9.5, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 4, display: "block" };
const money = (n, cur = "USD") => !n ? "on request" : new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(n);
const fmtDate = v => v ? new Date(v).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";
const waNum = p => String(p || "").replace(/[^\d]/g, "");
const optLabel = t => String(t || "").replace(/^(rgb\([^)]*\)|#[0-9a-f]{3,6}):/i, "");

const TONE = {
  new: [C.blue, C.blueBg], talking: [C.amber, C.amberBg], invoiced: [C.green, C.greenBg], lost: [C.inkFaint, C.card],
  pending: [C.amber, C.amberBg], approved: [C.green, C.greenBg], paused: [C.red, C.redBg], declined: [C.inkFaint, C.card],
};
function Pill({ k, children }) {
  const [fg, bg] = TONE[k] || [C.inkFaint, C.card];
  return <span style={{ color: fg, background: bg, borderRadius: 4, padding: "2px 8px", fontSize: 10, fontWeight: 700, whiteSpace: "nowrap", textTransform: "uppercase", letterSpacing: .4 }}>{children || k}</span>;
}

async function sha256(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const q = async p => { const { data, error } = await p; if (error) throw new Error(error.message); return data; };

async function loadAll(table, cols, order) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = await q(supabase.from(table).select(cols).order(order, { ascending: false }).range(from, from + 999));
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

export default function TradeSiteApp({ onHome, onMakeInvoice }) {
  const [tab, setTab] = useState("enquiries");
  const [settings, setSettings] = useState(null);
  const [toast, setToast] = useState("");
  const showToast = useCallback(m => { setToast(m); setTimeout(() => setToast(""), 3500); }, []);

  const loadSettings = useCallback(async () => {
    const rows = await q(supabase.from("trade_settings").select("key,value"));
    setSettings(Object.fromEntries(rows.map(r => [r.key, r.value])));
  }, []);
  useEffect(() => { loadSettings().catch(e => showToast("⚠ " + e.message)); }, [loadSettings, showToast]);
  const siteUrl = String(settings?.site_url || "https://trade.eartheditions.co").replace(/\/+$/, "");

  const TABS = [["enquiries", "💬", "Enquiries"], ["buyers", "👥", "Buyers"], ["products", "💎", "Products"], ["settings", "⚙️", "Settings"]];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: FONT, color: C.ink }}>
      {toast && <div style={{ position: "fixed", bottom: 22, right: 22, left: mob() ? 22 : "auto", zIndex: 1200, background: C.ink, color: "#fff", padding: "10px 18px", borderRadius: 6, fontSize: 12.5, boxShadow: "var(--e-2)" }}>{toast}</div>}
      <div style={{ position: "sticky", top: 0, zIndex: 100, background: C.surface, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: mob() ? "10px 14px" : "11px 28px" }}>
          <button onClick={onHome} style={{ background: "none", border: "none", cursor: "pointer", color: C.inkMid, fontFamily: "inherit", fontSize: 13, padding: "0 12px 0 0", borderRight: `1px solid ${C.border}` }}>← Home</button>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, lineHeight: 1 }}>Trade site</div>
            <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 1 }}>Wholesale buyers, their carts, and what they see</div>
          </div>
          <div style={{ flex: 1 }} />
          <a href={siteUrl} target="_blank" rel="noreferrer" style={{ ...btn(), textDecoration: "none" }}>↗ {mob() ? "" : "Open site"}</a>
        </div>
        <div style={{ display: "flex", overflowX: "auto", padding: mob() ? "0 10px" : "0 28px" }}>
          {TABS.map(([k, icon, label]) => (
            <button key={k} onClick={() => setTab(k)} style={{
              display: "flex", alignItems: "center", gap: 6, marginBottom: -1, border: "none", background: "none", cursor: "pointer",
              fontFamily: "inherit", padding: "11px 14px", fontSize: 13, fontWeight: tab === k ? 700 : 400, whiteSpace: "nowrap",
              color: tab === k ? C.ink : C.inkMid, borderBottom: `2.5px solid ${tab === k ? C.gold : "transparent"}`,
            }}><span style={{ fontSize: 14 }}>{icon}</span>{label}</button>
          ))}
        </div>
      </div>
      <div style={{ padding: mob() ? 14 : "24px 28px", maxWidth: 1180, margin: "0 auto" }}>
        {tab === "enquiries" && <EnquiriesTab showToast={showToast} onMakeInvoice={onMakeInvoice} />}
        {tab === "buyers" && <BuyersTab showToast={showToast} siteUrl={siteUrl} />}
        {tab === "products" && <ProductsTab showToast={showToast} />}
        {tab === "settings" && settings && <SettingsTab settings={settings} reload={loadSettings} showToast={showToast} />}
      </div>
    </div>
  );
}

/* ── Enquiries ─────────────────────────────────────────────────────────── */
function EnquiriesTab({ showToast, onMakeInvoice }) {
  const [rows, setRows] = useState(null);
  const [filter, setFilter] = useState("open");
  const [open, setOpen] = useState(null);

  const load = useCallback(() => q(supabase.from("trade_enquiries").select("*").order("created_at", { ascending: false }).limit(500))
    .then(setRows).catch(e => { showToast("⚠ " + e.message); setRows(r => r || []); }), [showToast]);
  useEffect(() => { load(); }, [load]);

  const patch = async (id, p) => {
    try {
      await q(supabase.from("trade_enquiries").update({ ...p, updated_at: new Date().toISOString() }).eq("id", id));
      setRows(r => r.map(x => x.id === id ? { ...x, ...p } : x));
    } catch (e) { showToast("⚠ " + e.message); }
  };

  const shown = (rows || []).filter(e => filter === "all" || (filter === "open" ? ["new", "talking"].includes(e.status) : e.status === filter));
  const count = s => (rows || []).filter(e => s === "open" ? ["new", "talking"].includes(e.status) : e.status === s).length;

  const makeInvoice = e => {
    onMakeInvoice?.(e);
    patch(e.id, { status: "invoiced" });
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
        {[["open", "Open"], ["new", "New"], ["talking", "Talking"], ["invoiced", "Invoiced"], ["lost", "Lost"], ["all", "All"]].map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)} style={{ ...btn(filter === k ? C.ink : C.surface, filter === k ? "#fff" : C.ink), borderRadius: 999 }}>
            {l}{k !== "all" ? ` · ${count(k)}` : ""}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button onClick={load} style={btn()}>↻ Refresh</button>
      </div>
      {!rows && <div style={{ color: C.inkFaint, fontSize: 13 }}>Loading…</div>}
      {rows && !shown.length && <div style={{ ...card, padding: 24, color: C.inkFaint, fontSize: 13, textAlign: "center" }}>No enquiries here yet. When a buyer taps “Send on WhatsApp”, the cart lands in this list as well as in your chat.</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {shown.map(e => {
          const b = e.buyer || {};
          const isOpen = open === e.id;
          return (
            <div key={e.id} style={{ ...card, padding: mob() ? 12 : "14px 18px" }}>
              <div onClick={() => setOpen(isOpen ? null : e.id)} style={{ display: "flex", gap: 12, alignItems: "center", cursor: "pointer", flexWrap: "wrap" }}>
                <div style={{ fontWeight: 700, fontSize: 13, fontFamily: "ui-monospace,monospace" }}>{e.code}</div>
                <div style={{ flex: 1, minWidth: 160 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{b.company || b.name}{b.company && b.name ? <span style={{ color: C.inkFaint, fontWeight: 400 }}> · {b.name}</span> : null}</div>
                  <div style={{ fontSize: 11.5, color: C.inkFaint }}>{fmtDate(e.created_at)} · {e.lines.length} line{e.lines.length === 1 ? "" : "s"} · {[b.city, b.state, b.country].filter(Boolean).join(", ")}</div>
                </div>
                <div style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700 }}>{e.total ? money(e.total, e.currency) : "—"}</div>
                <Pill k={e.status} />
              </div>
              {isOpen && (
                <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <tbody>
                      {e.lines.map((l, i) => (
                        <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                          <td style={{ padding: "6px 8px 6px 0", width: 44 }}>{l.image && <img src={l.image} alt="" style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 6 }} />}</td>
                          <td style={{ padding: 6 }}>{l.title}{l.variant ? <span style={{ color: C.inkFaint }}> · {optLabel(l.variant)}</span> : null}{l.sku ? <div style={{ fontSize: 11, color: C.inkFaint }}>{l.sku}</div> : null}</td>
                          <td style={{ padding: 6, textAlign: "right", whiteSpace: "nowrap" }}>{l.qty} {l.unit === "piece" ? "pcs" : l.unit}</td>
                          <td style={{ padding: 6, textAlign: "right", whiteSpace: "nowrap", color: C.inkMid }}>{money(l.price, e.currency)}</td>
                          <td style={{ padding: "6px 0 6px 6px", textAlign: "right", whiteSpace: "nowrap", fontWeight: 600 }}>{l.price ? money(l.price * l.qty, e.currency) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {e.note && <div style={{ marginTop: 10, fontSize: 13, background: C.card, borderRadius: 7, padding: "8px 12px" }}><b>Buyer's note:</b> {e.note}</div>}
                  <div style={{ fontSize: 12.5, color: C.inkMid, marginTop: 10 }}>{[b.email, b.phone].filter(Boolean).join(" · ")}</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12, alignItems: "center" }}>
                    {waNum(b.phone) && <a href={`https://wa.me/${waNum(b.phone)}`} target="_blank" rel="noreferrer" style={{ ...btn("#1f8f4e", "#fff"), textDecoration: "none" }}>💬 Open chat</a>}
                    {b.email && <a href={`mailto:${b.email}?subject=${encodeURIComponent(`Your Earth Editions order ${e.code}`)}`} style={{ ...btn(), textDecoration: "none" }}>✉ Email</a>}
                    <button onClick={() => makeInvoice(e)} style={btn(C.ink, "#FAF0DC")}>📄 Make invoice</button>
                    <select value={e.status} onChange={ev => patch(e.id, { status: ev.target.value })} style={{ ...FI({ width: "auto", padding: "6px 10px" }) }}>
                      <option value="new">New</option><option value="talking">Talking</option><option value="invoiced">Invoiced</option><option value="lost">Lost</option>
                    </select>
                  </div>
                  <textarea defaultValue={e.staff_note} placeholder="Our notes (buyer never sees this)" onBlur={ev => ev.target.value !== e.staff_note && patch(e.id, { staff_note: ev.target.value })}
                    style={{ ...FI({ marginTop: 10, minHeight: 56, resize: "vertical" }) }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Buyers ────────────────────────────────────────────────────────────── */
function BuyersTab({ showToast, siteUrl }) {
  const [rows, setRows] = useState(null);
  const [filter, setFilter] = useState("pending");
  const [search, setSearch] = useState("");
  const [links, setLinks] = useState({}); // id → invite link, shown once
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => loadAll("trade_buyers",
    "id,email,name,company,phone,city,state,country,resale_no,resale_docs,status,created_at,approved_at,last_login,shopify_id,notes,invite_expires,has_password,sells_on,marketing_opt_in,prefs,is_editor",
    "created_at").then(setRows).catch(e => { showToast("⚠ " + e.message); setRows(r => r || []); }), [showToast]);
  useEffect(() => { load(); }, [load]);

  const patch = async (id, p) => {
    try {
      await q(supabase.from("trade_buyers").update(p).eq("id", id));
      setRows(r => r.map(x => x.id === id ? { ...x, ...p } : x));
    } catch (e) { showToast("⚠ " + e.message); }
  };

  // A fresh one-time link. Only its hash is stored, so a lost link can't be
  // read back — make a new one instead.
  const invite = async b => {
    const token = randomToken();
    await patch(b.id, { invite_hash: await sha256(token), invite_expires: new Date(Date.now() + 14 * 864e5).toISOString() });
    const link = `${siteUrl}/set-password?t=${token}`;
    setLinks(l => ({ ...l, [b.id]: link }));
    return link;
  };

  /* Approve = the whole welcome in one click: open the account, make the
     set-password link, put an opted-in buyer on the mailing list, and fire the
     same Omnisend event the Shopify approvals used, now carrying the link, so
     the existing automation sends it. The link also stays on screen for
     WhatsApp in case the email is slow or filtered. */
  const approve = async b => {
    setBusy(true);
    try {
      // Someone who already has a password (a paused account, say) just gets
      // switched back on — no second welcome email, no new set-up link.
      if (b.has_password) {
        await patch(b.id, { status: "approved" });
        showToast(`✓ ${b.company || b.name || b.email} is active again`);
        setBusy(false);
        return;
      }
      await patch(b.id, { status: "approved", approved_at: new Date().toISOString() });
      const link = await invite(b);
      const omni = async payload => {
        const r = await fetch("/api/omnisend", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.error) throw new Error(d.error || `Omnisend ${r.status}`);
        return d;
      };
      const first = String(b.name || "").split(" ")[0];
      const notes = [];
      if (b.marketing_opt_in) {
        await omni({ action: "contact_tag", email: b.email, addTags: ["approved", "active", "trade"], firstName: first, lastName: String(b.name || "").split(" ").slice(1).join(" ") })
          .then(() => notes.push("added to the mailing list")).catch(e => notes.push(`⚠ list: ${e.message}`));
      }
      // The approval email: sent by the ERP itself through Resend (from
      // eartheditions.co, so it reaches the inbox); until that's set up, the
      // Omnisend automation on wholesale_approved sends it.
      const mailed = await fetch("/api/mail", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template: "trade_approved", to: b.email, name: b.name, setup_url: link, site_url: siteUrl }) })
        .then(async r => ({ ok: r.ok, status: r.status, d: await r.json().catch(() => ({})) })).catch(e => ({ ok: false, d: { error: e.message } }));
      if (mailed.ok) notes.push("approval email sent");
      else if (mailed.status === 503) {
        await omni({ action: "trigger_event", eventName: "wholesale_approved", email: b.email,
          properties: { setup_url: link, first_name: first, company: b.company || "", site_url: siteUrl } })
          .then(() => notes.push("approval event sent to Omnisend")).catch(e => notes.push(`⚠ email: ${e.message}`));
      } else notes.push(`⚠ email: ${mailed.d?.error || mailed.status} — send the set-up link on WhatsApp`);
      showToast(`✓ ${b.company || b.name} approved — ${notes.join(", ")}`);
    } catch (e) { showToast("⚠ " + e.message); }
    setBusy(false);
  };

  const bulkInvites = async () => {
    const list = (rows || []).filter(b => b.status === "approved" && !b.has_password);
    if (!list.length) { showToast("Every approved buyer already has a password"); return; }
    if (!window.confirm(`Make fresh set-up links for ${list.length} buyers without a password? Any older links stop working. You'll get a CSV (email, name, link) to import into Omnisend or mail-merge.`)) return;
    setBusy(true);
    try {
      const out = [["email", "name", "company", "link"]];
      for (const b of list) out.push([b.email, b.name, b.company, await invite(b)]);
      const cell = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
      const blob = new Blob(["﻿" + out.map(r => r.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `trade-invites-${list.length}.csv`; a.click();
      showToast(`${list.length} links made — links last 14 days`);
    } catch (e) { showToast("⚠ " + e.message); }
    setBusy(false);
  };

  // Gone for good: the account, its login and its uploaded certificates.
  // Their past enquiries stay (the buyer's details are copied onto each one).
  const remove = async b => {
    if (!window.confirm(`Delete ${b.company || b.name || b.email} (${b.email})?\n\nTheir login stops working and they'd have to apply again. Past enquiries are kept.`)) return;
    try {
      const paths = (b.resale_docs || []).map(d => d.path).filter(Boolean);
      if (paths.length) await supabase.storage.from("trade-private").remove(paths);
      await q(supabase.from("trade_buyers").delete().eq("id", b.id));
      setRows(r => r.filter(x => x.id !== b.id));
      showToast("Deleted");
    } catch (e) { showToast("⚠ " + e.message); }
  };

  const openDoc = async d => {
    const { data, error } = await supabase.storage.from("trade-private").createSignedUrl(d.path, 300);
    if (error) { showToast("⚠ " + error.message); return; }
    window.open(data.signedUrl, "_blank");
  };

  const count = s => (rows || []).filter(b => b.status === s).length;
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (rows || []).filter(b => (filter === "all" || b.status === filter) &&
    words.every(w => `${b.name} ${b.company} ${b.email} ${b.state} ${b.country}`.toLowerCase().includes(w)));

  return (
    <div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
        {[["pending", "Waiting"], ["approved", "Approved"], ["paused", "Paused"], ["declined", "Declined"], ["all", "All"]].map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)} style={{ ...btn(filter === k ? C.ink : C.surface, filter === k ? "#fff" : C.ink), borderRadius: 999 }}>
            {l}{k !== "all" ? ` · ${count(k)}` : ` · ${(rows || []).length}`}
          </button>
        ))}
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, shop, email…" style={{ ...FI({ width: mob() ? "100%" : 220, borderRadius: 999 }) }} />
        <div style={{ flex: 1 }} />
        <button onClick={bulkInvites} disabled={busy} style={btn()}>{busy ? "Making links…" : "✉ Set-up links for all (CSV)"}</button>
      </div>
      {!rows && <div style={{ color: C.inkFaint, fontSize: 13 }}>Loading…</div>}
      {rows && !shown.length && <div style={{ ...card, padding: 24, color: C.inkFaint, fontSize: 13, textAlign: "center" }}>{filter === "pending" ? "No applications waiting." : "Nobody here."}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {shown.slice(0, 300).map(b => (
          <div key={b.id} style={{ ...card, padding: mob() ? 12 : "12px 16px" }}>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{b.company || b.name || b.email} {b.company && b.name && <span style={{ color: C.inkFaint, fontWeight: 400 }}>· {b.name}</span>}</div>
                <div style={{ fontSize: 12, color: C.inkMid }}>{[b.email, b.phone, [b.city, b.state, b.country].filter(Boolean).join(", ")].filter(Boolean).join(" · ")}</div>
                <div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 2 }}>
                  {b.shopify_id ? "From Shopify" : `Applied ${fmtDate(b.created_at)}`}
                  {" · "}{b.has_password ? (b.last_login ? `last in ${fmtDate(b.last_login)}` : "password set") : "no password yet"}
                  {b.resale_no ? ` · Sales tax ID ${b.resale_no}` : ""}
                  {b.marketing_opt_in ? " · ✉ opted in to emails" : ""}
                </div>
                {(b.sells_on?.channels || []).length > 0 && (
                  <div style={{ fontSize: 12, color: C.inkMid, marginTop: 4 }}>
                    <b style={{ fontWeight: 600 }}>Sells on:</b> {b.sells_on.channels.map(c => {
                      const label = { instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok", retail: "Retail store", website: "Online shop", other: "Other", collector: "Collector (bulk)" }[c] || c;
                      const h = b.sells_on.handles?.[c];
                      const href = !h ? null : c === "instagram" ? `https://instagram.com/${h.replace(/^@/, "").replace(/.*instagram\.com\//, "")}`
                        : c === "tiktok" ? `https://www.tiktok.com/@${h.replace(/^@/, "").replace(/.*tiktok\.com\/@?/, "")}`
                        : /^(https?:\/\/|www\.|[\w-]+\.[a-z]{2,})/i.test(h) ? (h.startsWith("http") ? h : `https://${h}`) : null;
                      return <span key={c} style={{ marginRight: 10 }}>{label}{h ? <>: {href ? <a href={href} target="_blank" rel="noreferrer" style={{ color: C.blue }}>{h}</a> : h}</> : null}</span>;
                    })}
                  </div>
                )}
                {(b.prefs?.interests?.length > 0 || b.prefs?.buys || b.prefs?.contact) && (
                  <div style={{ fontSize: 12, color: C.inkFaint, marginTop: 2 }}>
                    {[b.prefs.interests?.length ? `Likes ${b.prefs.interests.join(", ")}` : "", b.prefs.buys ? `buys ${b.prefs.buys}` : "", b.prefs.contact ? `prefers ${b.prefs.contact}` : ""].filter(Boolean).join(" · ")}
                  </div>
                )}
                {(b.resale_docs || []).length > 0 && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                    {b.resale_docs.map((d, i) => <button key={i} onClick={() => openDoc(d)} style={{ ...btn(C.blueBg, C.blue), padding: "3px 9px", fontSize: 11 }}>📄 {d.name}</button>)}
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                {b.is_editor && <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: .5, textTransform: "uppercase", color: C.gold, background: C.amberBg, border: `1px solid ${C.gold}40`, borderRadius: 20, padding: "2px 8px" }}>✎ Editor</span>}
                <Pill k={b.status}>{b.status === "pending" ? "waiting" : b.status}</Pill>
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
              {b.status !== "approved" && <button disabled={busy} onClick={() => approve(b)} style={btn(C.green, "#fff")}>{b.status === "paused" && b.has_password ? "▶ Reactivate" : "✓ Approve"}</button>}
              {b.status === "approved" && <button onClick={() => patch(b.id, { status: "paused" })} style={btn()}>Pause</button>}
              {b.status === "pending" && <button onClick={() => patch(b.id, { status: "declined" })} style={btn()}>Decline</button>}
              {b.status === "approved" && <button onClick={() => invite(b).catch(e => showToast("⚠ " + e.message))} style={btn()}>🔗 {b.has_password ? "Password reset link" : "Set-up link"}</button>}
              {/* An editor can change products on the trade site itself (the ✎ Edit
                  product button). Theirs is the same login as any buyer's. */}
              {b.status === "approved" && (
                <button onClick={() => {
                  if (!b.is_editor && !window.confirm(`Let ${b.name || b.email} edit products on the trade site?`)) return;
                  patch(b.id, { is_editor: !b.is_editor }).then(() => showToast(b.is_editor ? "Editing turned off" : "✓ Can now edit products on the trade site — reload the site"));
                }} style={btn(b.is_editor ? C.amberBg : "transparent", b.is_editor ? C.gold : C.ink)}>
                  ✎ {b.is_editor ? "Editor · on" : "Make editor"}
                </button>
              )}
              <div style={{ flex: 1 }} />
              <button onClick={() => remove(b)} style={{ ...btn(), color: C.red }} title="Delete this account">Delete</button>
            </div>
            {links[b.id] && (
              <div style={{ marginTop: 10, background: C.card, borderRadius: 8, padding: 10, fontSize: 12 }}>
                <div style={{ wordBreak: "break-all", fontFamily: "ui-monospace,monospace", marginBottom: 8 }}>{links[b.id]}</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button onClick={() => navigator.clipboard.writeText(links[b.id]).then(() => showToast("Link copied"))} style={btn()}>Copy</button>
                  {waNum(b.phone) && <a target="_blank" rel="noreferrer" style={{ ...btn("#1f8f4e", "#fff"), textDecoration: "none" }}
                    href={`https://wa.me/${waNum(b.phone)}?text=${encodeURIComponent(`Hi ${b.name || ""}, Earth Editions' trade catalogue has moved to its own site. Set your password here to see trade prices and order: ${links[b.id]}`)}`}>Send on WhatsApp</a>}
                  <a style={{ ...btn(), textDecoration: "none" }}
                    href={`mailto:${b.email}?subject=${encodeURIComponent("Your Earth Editions trade account")}&body=${encodeURIComponent(`Hi ${b.name || ""},\n\nOur trade catalogue has moved to its own site. Set your password here to see trade prices and order:\n\n${links[b.id]}\n\nThe link works for 14 days.\n\nEarth Editions`)}`}>Email</a>
                </div>
                <div style={{ color: C.inkFaint, marginTop: 6 }}>Works once, for 14 days. Only shown now — make a new one if it's lost.</div>
              </div>
            )}
          </div>
        ))}
      </div>
      {shown.length > 300 && <div style={{ color: C.inkFaint, fontSize: 12, marginTop: 10 }}>Showing 300 of {shown.length} — search to narrow.</div>}
    </div>
  );
}

/* ── Products ──────────────────────────────────────────────────────────── */
function ProductsTab({ showToast }) {
  const [rows, setRows] = useState(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [edit, setEdit] = useState(null);
  const [picker, setPicker] = useState(false);
  const [shown, setShown] = useState(60);

  const load = useCallback(() => loadAll("trade_products", "*", "created_at").then(setRows).catch(e => { showToast("⚠ " + e.message); setRows(r => r || []); }), [showToast]);
  useEffect(() => { load(); }, [load]);

  const save = async (id, p) => {
    try {
      const row = await q(supabase.from("trade_products").update({ ...p, updated_at: new Date().toISOString() }).eq("id", id).select().single());
      setRows(r => r.map(x => x.id === id ? row : x));
      return row;
    } catch (e) { showToast("⚠ " + e.message); throw e; }
  };

  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const list = useMemo(() => (rows || []).filter(p =>
    (filter === "all" || (filter === "live" ? p.live : filter === "hidden" ? !p.live : filter === "new" ? p.is_new : filter === "deal" ? p.is_deal : !p.price)) &&
    words.every(w => `${p.title} ${p.shape} ${p.product_type} ${(p.collections || []).join(" ")} ${(p.variants || []).map(v => v.sku).join(" ")}`.toLowerCase().includes(w))
  ), [rows, filter, search]);
  const count = f => (rows || []).filter(p => f === "live" ? p.live : f === "hidden" ? !p.live : f === "new" ? p.is_new : f === "deal" ? p.is_deal : !p.price).length;

  return (
    <div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
        {[["all", "All"], ["live", "Live"], ["hidden", "Hidden"], ["new", "New"], ["deal", "Deals"], ["noprice", "No price"]].map(([k, l]) => (
          <button key={k} onClick={() => { setFilter(k); setShown(60); }} style={{ ...btn(filter === k ? C.ink : C.surface, filter === k ? "#fff" : C.ink), borderRadius: 999 }}>
            {l} · {k === "all" ? (rows || []).length : count(k)}
          </button>
        ))}
        <input value={search} onChange={e => { setSearch(e.target.value); setShown(60); }} placeholder="Search title, SKU, collection…" style={{ ...FI({ width: mob() ? "100%" : 240, borderRadius: 999 }) }} />
        <div style={{ flex: 1 }} />
        <button onClick={() => setPicker(true)} style={btn(C.ink, "#FAF0DC")}>＋ From stock</button>
      </div>
      {!rows && <div style={{ color: C.inkFaint, fontSize: 13 }}>Loading…</div>}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${mob() ? 160 : 210}px, 1fr))`, gap: mob() ? 10 : 14 }}>
        {list.slice(0, shown).map(p => <ProductCard key={p.id} p={p} onOpen={() => setEdit(p)} onToggle={patch => save(p.id, patch)} />)}
      </div>
      {rows && !list.length && <div style={{ ...card, padding: 24, color: C.inkFaint, fontSize: 13, textAlign: "center" }}>Nothing matches.</div>}
      {list.length > shown && <div style={{ textAlign: "center", marginTop: 12 }}><button onClick={() => setShown(s => s + 100)} style={btn()}>Show more ({list.length - shown})</button></div>}
      {edit && <ProductEditor p={edit} onClose={() => setEdit(null)} onSave={async patch => { await save(edit.id, patch); setEdit(null); showToast("Saved — live on the site now"); }} />}
      {picker && <StockPicker onClose={() => setPicker(false)} existing={rows || []} onAdd={async row => {
        try {
          const saved = await q(supabase.from("trade_products").insert(row).select().single());
          setRows(r => [saved, ...(r || [])]);
          setPicker(false);
          setEdit(saved);
          showToast("Added — set a price, then it's ready");
        } catch (e) { showToast("⚠ " + e.message); }
      }} />}
    </div>
  );
}

/* One product as a card: the photo does the recognising, the toggles sit
   under it so live / new / deal can be flipped without opening anything. */
function ProductCard({ p, onOpen, onToggle }) {
  const tog = (label, key, on, extra = {}) => (
    <button onClick={e => { e.stopPropagation(); onToggle({ [key]: !on, ...extra }); }}
      title={label}
      style={{ flex: 1, border: `1px solid ${on ? "transparent" : C.border}`, background: on ? (key === "is_deal" ? C.green : key === "live" ? C.ink : C.gold) : C.surface,
        color: on ? "#fff" : C.inkMid, borderRadius: 6, padding: "5px 0", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
      {label}
    </button>
  );
  return (
    <div style={{ ...card, overflow: "hidden", display: "flex", flexDirection: "column", opacity: p.live ? 1 : .6 }}>
      <div onClick={onOpen} style={{ cursor: "pointer", position: "relative", aspectRatio: "1", background: C.card }}>
        {p.images?.[0] && <img src={p.images[0]} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />}
        {!p.price && <span style={{ position: "absolute", top: 8, left: 8, background: C.amberBg, color: C.amber, fontSize: 10, fontWeight: 700, borderRadius: 4, padding: "2px 7px" }}>NO PRICE</span>}
        {p.is_deal && <span style={{ position: "absolute", top: 8, right: 8, background: C.green, color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 4, padding: "2px 7px" }}>DEAL</span>}
      </div>
      <div onClick={onOpen} style={{ padding: "10px 12px 6px", cursor: "pointer", flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 13.5, lineHeight: 1.25, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{p.title}</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6, marginTop: 4 }}>
          <span style={{ fontSize: 11, color: C.inkFaint, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{[p.shape, p.stock != null ? `${p.stock} in stock` : ""].filter(Boolean).join(" · ")}</span>
          <span style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 700, whiteSpace: "nowrap" }}>{p.price ? money(p.price) : "—"}</span>
        </div>
      </div>
      <div style={{ display: "flex", gap: 5, padding: "4px 10px 10px" }}>
        {tog("Live", "live", !!p.live)}
        {tog("New", "is_new", !!p.is_new, !p.is_new ? { new_at: new Date().toISOString() } : {})}
        {tog("Deal", "is_deal", !!p.is_deal)}
      </div>
    </div>
  );
}

function Modal({ title, onClose, children, footer }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(20,15,5,.45)", display: "flex", alignItems: mob() ? "flex-end" : "center", justifyContent: "center", padding: mob() ? 0 : 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ ...card, width: "100%", maxWidth: 640, maxHeight: mob() ? "92vh" : "88vh", display: "flex", flexDirection: "column", borderRadius: mob() ? "14px 14px 0 0" : 12 }}>
        <div style={{ display: "flex", alignItems: "center", padding: "14px 18px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, flex: 1 }}>{title}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.inkMid }}>×</button>
        </div>
        <div style={{ overflowY: "auto", padding: 18, flex: 1 }}>{children}</div>
        {footer && <div style={{ padding: "12px 18px", borderTop: `1px solid ${C.border}`, display: "flex", gap: 8, justifyContent: "flex-end" }}>{footer}</div>}
      </div>
    </div>
  );
}

function ProductEditor({ p, onClose, onSave }) {
  const [f, setF] = useState(() => ({
    title: p.title, description: p.description, shape: p.shape, product_type: p.product_type, unit: p.unit,
    collections: (p.collections || []).join(", "), live: p.live, is_new: p.is_new, is_deal: !!p.is_deal, deal_note: p.deal_note || "",
    variants: (p.variants?.length ? p.variants : [{ id: uid(), title: "Default Title", price: p.price || 0, sku: "", stock: p.stock ?? null }]).map(v => ({ ...v, price: v.price || "" })),
  }));
  const [busy, setBusy] = useState(false);
  const set = k => e => setF(x => ({ ...x, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const setV = (i, k, val) => setF(x => ({ ...x, variants: x.variants.map((v, j) => j === i ? { ...v, [k]: val } : v) }));
  const submit = async () => {
    setBusy(true);
    const variants = f.variants.map(v => ({ ...v, price: +v.price || 0, stock: v.stock === "" || v.stock == null ? null : +v.stock }));
    const prices = variants.map(v => v.price).filter(x => x > 0);
    const tracked = variants.filter(v => v.stock != null);
    try {
      await onSave({
        title: f.title.trim(), description: f.description, shape: f.shape.trim(), product_type: f.product_type.trim(), unit: f.unit,
        collections: f.collections.split(",").map(s => s.trim()).filter(Boolean), live: f.live,
        is_new: f.is_new, new_at: f.is_new && !p.is_new ? new Date().toISOString() : p.new_at,
        is_deal: f.is_deal, deal_note: f.deal_note.trim(),
        variants, price: prices.length ? Math.min(...prices) : 0,
        stock: tracked.length ? tracked.reduce((t, v) => t + v.stock, 0) : null,
      });
    } catch { /* toast already shown */ }
    setBusy(false);
  };
  return (
    <Modal title="Edit product" onClose={onClose} footer={<>
      <button onClick={onClose} style={btn()}>Cancel</button>
      <button onClick={submit} disabled={busy} style={btn(C.ink, "#FAF0DC")}>{busy ? "Saving…" : "Save"}</button>
    </>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {p.images?.length > 0 && <div style={{ display: "flex", gap: 6, overflowX: "auto" }}>{p.images.map(src => <img key={src} src={src} alt="" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 6 }} />)}</div>}
        <div><span style={lab}>Title</span><input value={f.title} onChange={set("title")} style={FI()} /></div>
        <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "1fr 1fr 110px", gap: 10 }}>
          <div><span style={lab}>Shape</span><input value={f.shape} onChange={set("shape")} style={FI()} /></div>
          <div><span style={lab}>Type</span><input value={f.product_type} onChange={set("product_type")} style={FI()} /></div>
          <div><span style={lab}>Sold per</span><select value={f.unit} onChange={set("unit")} style={FI()}><option value="piece">piece</option><option value="kg">kg</option><option value="lot">lot</option></select></div>
        </div>
        <div><span style={lab}>Collections (comma separated)</span><input value={f.collections} onChange={set("collections")} style={FI()} /></div>
        <div>
          <span style={lab}>Trade price{f.variants.length > 1 ? " per option" : ""} (USD · blank = on request)</span>
          {f.variants.map((v, i) => (
            <div key={v.id} style={{ display: "grid", gridTemplateColumns: f.variants.length > 1 ? "1fr 100px 80px" : "120px 80px", gap: 8, marginBottom: 6, alignItems: "center" }}>
              {f.variants.length > 1 && <div style={{ fontSize: 12.5, color: C.inkMid }}>{optLabel(v.title)}</div>}
              <input value={v.price} onChange={e => setV(i, "price", e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" placeholder="$" style={FI()} />
              <input value={v.stock ?? ""} onChange={e => setV(i, "stock", e.target.value.replace(/[^\d]/g, ""))} inputMode="numeric" placeholder="stock" title="Stock — blank = not tracked" style={FI()} />
            </div>
          ))}
        </div>
        <div><span style={lab}>Description</span><textarea value={f.description} onChange={set("description")} style={FI({ minHeight: 120, resize: "vertical" })} /></div>
        <div style={{ display: "flex", gap: 18 }}>
          <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={f.live} onChange={set("live")} /> Live on the site</label>
          <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={f.is_new} onChange={set("is_new")} /> New arrival</label>
          <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={f.is_deal} onChange={set("is_deal")} /> Mineral deal</label>
        </div>
        {f.is_deal && <div><span style={lab}>Deal note (shown with “Ready to ship · Free shipping”)</span><input value={f.deal_note} onChange={set("deal_note")} placeholder="e.g. 12 pieces left · was $80" style={FI()} /></div>}
      </div>
    </Modal>
  );
}

function StockPicker({ onClose, onAdd, existing }) {
  const [stock, setStock] = useState(null);
  const [search, setSearch] = useState("");
  useEffect(() => { loadK("ng-stock-v5").then(s => setStock(Array.isArray(s) ? s : [])).catch(() => setStock([])); }, []);
  const taken = useMemo(() => new Set(existing.map(p => p.source?.stock_id).filter(Boolean)), [existing]);
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const list = (stock || []).filter(s => (s.photos?.length || s.photo) && words.every(w => `${s.material} ${s.shape} ${s.sku} ${s.productType}`.toLowerCase().includes(w)))
    .sort((a, b) => String(b.createdAt || b.addedDate).localeCompare(String(a.createdAt || a.addedDate)));

  const add = s => {
    const photos = (s.photos?.length ? s.photos : [s.photo]).filter(Boolean);
    const unit = /kg/i.test(s.unit) ? "kg" : "piece";
    onAdd({
      id: `stock-${s.id}-${uid()}`, title: [s.material, s.shape && !/mineral/i.test(s.shape) ? s.shape : ""].filter(Boolean).join(" "),
      description: s.notes || "", shape: s.shape || "", material: s.material || "", product_type: s.productType || "",
      images: photos, unit, variants: [{ id: uid(), title: "Default Title", price: 0, sku: s.sku || "", stock: null }],
      price: 0, is_new: true, new_at: new Date().toISOString(), live: false, source: { stock_id: s.id, sku: s.sku || "" },
    });
  };

  return (
    <Modal title="Add from stock" onClose={onClose}>
      <input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Search material, shape, SKU…" style={{ ...FI({ marginBottom: 12 }) }} />
      <div style={{ fontSize: 11.5, color: C.inkFaint, marginBottom: 8 }}>Only stock with photos is listed. It's added hidden and marked New — set a price, then switch it live.</div>
      {!stock && <div style={{ color: C.inkFaint, fontSize: 13 }}>Loading stock…</div>}
      {list.slice(0, 80).map(s => (
        <div key={s.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${C.border}` }}>
          <img src={(s.photos && s.photos[0]) || s.photo} alt="" loading="lazy" style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 6 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{s.material} {s.shape ? <span style={{ color: C.inkFaint, fontWeight: 400 }}>· {s.shape}</span> : null}</div>
            <div style={{ fontSize: 11.5, color: C.inkFaint }}>{[s.sku, s.qty ? `${s.qty} ${s.unit || ""}` : "", s.addedDate].filter(Boolean).join(" · ")}</div>
          </div>
          {taken.has(s.id) ? <span style={{ fontSize: 11, color: C.inkFaint }}>on site</span> : <button onClick={() => add(s)} style={btn()}>Add</button>}
        </div>
      ))}
    </Modal>
  );
}

/* ── Settings ──────────────────────────────────────────────────────────── */
function SettingsTab({ settings, reload, showToast }) {
  const [f, setF] = useState(() => ({
    whatsapp: settings.whatsapp || "", hide_prices: settings.hide_prices !== false, min_order: settings.min_order || 0,
    currency: settings.currency || "USD", site_url: settings.site_url || "https://trade.eartheditions.co",
    about: settings.about || "", public_limit: settings.public_limit ?? 50,
    hidden_shows: Array.isArray(settings.hidden_shows) ? settings.hidden_shows : [],
  }));
  const [shows, setShows] = useState([]);
  useEffect(() => {
    const today = new Date().toISOString().slice(0, 10);
    loadK("ng-shows-v1").then(l => setShows((Array.isArray(l) ? l : [])
      .filter(x => x?.name && x.startDate && ((x.endDate >= x.startDate ? x.endDate : x.startDate) >= today))
      .sort((a, b) => a.startDate.localeCompare(b.startDate)))).catch(() => {});
  }, []);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await q(supabase.from("trade_settings").upsert([
        { key: "whatsapp", value: waNum(f.whatsapp) },
        { key: "hide_prices", value: !!f.hide_prices },
        { key: "min_order", value: +f.min_order || 0 },
        { key: "currency", value: f.currency },
        { key: "site_url", value: f.site_url.trim().replace(/\/+$/, "") },
        { key: "about", value: f.about.trim() },
        { key: "public_limit", value: Math.max(0, parseInt(f.public_limit, 10) || 0) },
        { key: "hidden_shows", value: f.hidden_shows },
      ], { onConflict: "key" }));
      await reload();
      showToast("Saved");
    } catch (e) { showToast("⚠ " + e.message); }
    setBusy(false);
  };
  return (
    <div style={{ ...card, padding: 20, maxWidth: 560, display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <span style={lab}>WhatsApp number carts go to</span>
        <input value={f.whatsapp} onChange={e => setF(x => ({ ...x, whatsapp: e.target.value }))} placeholder="Country code + number, e.g. 91 98xxxxxxxx" inputMode="tel" style={FI()} />
        <div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 4 }}>Without it, carts are still saved here but the buyer isn't taken to WhatsApp.</div>
      </div>
      <label style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={f.hide_prices} onChange={e => setF(x => ({ ...x, hide_prices: e.target.checked }))} />
        Hide prices until a buyer is signed in and approved
      </label>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div><span style={lab}>Minimum order (0 = none)</span><input value={f.min_order} onChange={e => setF(x => ({ ...x, min_order: e.target.value.replace(/[^\d.]/g, "") }))} inputMode="decimal" style={FI()} /></div>
        <div><span style={lab}>Currency</span><select value={f.currency} onChange={e => setF(x => ({ ...x, currency: e.target.value }))} style={FI()}><option>USD</option><option>EUR</option><option>GBP</option><option>INR</option></select></div>
      </div>
      <div>
        <span style={lab}>Pieces visitors see before signing in</span>
        <input value={f.public_limit} onChange={e => setF(x => ({ ...x, public_limit: e.target.value.replace(/[^\d]/g, "") }))} inputMode="numeric" style={FI({ width: 120 })} />
        <div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 4 }}>The newest ones, plus any deals. Everything else needs an approved account.</div>
      </div>
      <div>
        <span style={lab}>About us (blank line = new paragraph)</span>
        <textarea value={f.about} onChange={e => setF(x => ({ ...x, about: e.target.value }))} style={FI({ minHeight: 120, resize: "vertical" })} />
      </div>
      <div>
        <span style={lab}>Show schedule on the site (from Shows)</span>
        {!shows.length && <div style={{ fontSize: 12.5, color: C.inkFaint }}>No upcoming shows in the Shows module.</div>}
        {shows.map(sh => {
          const hidden = f.hidden_shows.includes(sh.id) || !sh.city || /^new show$/i.test(sh.name);
          const locked = !sh.city || /^new show$/i.test(sh.name);
          return (
            <label key={sh.id} style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center", padding: "4px 0", color: locked ? C.inkFaint : C.ink }}>
              <input type="checkbox" disabled={locked} checked={!hidden}
                onChange={e => setF(x => ({ ...x, hidden_shows: e.target.checked ? x.hidden_shows.filter(id => id !== sh.id) : [...x.hidden_shows, sh.id] }))} />
              {sh.name} · {sh.city || "no city"} · {sh.startDate}{locked ? " (needs a name and city in Shows)" : ""}
            </label>
          );
        })}
      </div>
      <div>
        <span style={lab}>Site address (used in set-up links)</span>
        <input value={f.site_url} onChange={e => setF(x => ({ ...x, site_url: e.target.value }))} style={FI()} />
      </div>
      <div><button onClick={save} disabled={busy} style={btn(C.ink, "#FAF0DC")}>{busy ? "Saving…" : "Save settings"}</button></div>
    </div>
  );
}

/* ── Listing Manager hooks ────────────────────────────────────────────────
   The trade site is a platform in Listing Manager like Etsy or Shopify: its
   tab is the products panel above, and a listing can be pushed to it. Both
   write the same trade_products rows the site reads, so a change shows on
   trade.eartheditions.co as soon as it's saved. */
export { ProductsTab as TradeProductsPanel };

const plain = html => String(html || "").replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n")
  .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\n{3,}/g, "\n\n").trim();

export async function publishListingToTrade(listing, { syncOnly = false } = {}) {
  const id = listing.platforms?.trade?.product_id || `lm-${listing.id}`;
  const [existing, site] = await Promise.all([
    q(supabase.from("trade_products").select("id,live,is_new,new_at,is_deal,variants,unit,collections,videos").eq("id", id).maybeSingle()),
    q(supabase.from("trade_settings").select("value").eq("key", "site_url").maybeSingle()),
  ]);
  const v0 = existing?.variants?.[0] || {};
  /* A piece that came onto the trade site from Shopify has its trade price set
     there; a listing without one mustn't sync it back to "on request". */
  const price = +listing.price_trade || (existing ? +existing.price || +v0.price || 0 : 0);
  const images = (listing.images || []).filter(u => typeof u === "string" && /^https?:/.test(u));
  const live = syncOnly ? (existing ? existing.live : false) : true;
  const row = {
    id,
    title: String(listing.shopify_title || listing.title || "").trim(),
    description: plain(listing.shopify_description || listing.description),
    shape: listing.shape || "", material: listing.material || "", product_type: listing.productType || "",
    tags: Array.isArray(listing.tags) ? listing.tags : [],
    images,
    // A listing carries one video; keep any others added on the site itself.
    videos: [...new Set([...(listing.video && /^https?:/.test(listing.video) ? [listing.video] : []), ...(existing?.videos || [])])],
    variants: [{ id: v0.id || uid(), title: "Default Title", price, sku: listing.sku || "", stock: listing.qty !== "" && listing.qty != null ? +listing.qty || 0 : null }],
    price,
    stock: listing.qty !== "" && listing.qty != null ? +listing.qty || 0 : null,
    unit: existing?.unit || "piece",
    live,
    is_new: existing ? existing.is_new : true,
    new_at: existing?.new_at || new Date().toISOString(),
    is_deal: !!(existing?.is_deal || listing._dealOnPublish),
    source: { listing_id: listing.id, sku: listing.sku || "" },
    updated_at: new Date().toISOString(),
  };
  await q(supabase.from("trade_products").upsert(row, { onConflict: "id" }));
  const base = String(site?.value || "https://trade.eartheditions.co").replace(/\/+$/, "");
  return { product_id: id, url: `${base}/p/${id}`, status: live ? "active" : "draft" };
}

/* A trade product can also come from somewhere other than a publish — pulled
   in from the Earth Editions Shopify store or added from Stock — and then it
   isn't linked to the listing, so a new photo in Listing Manager never
   reached it. After a listing is saved, any trade product that is the same
   piece (by listing, Shopify product or stock item) takes its photos. Only
   the photos: titles and prices on the trade site are set for trade. */
export async function refreshTradePhotos(listing) {
  const images = (listing.images || []).filter(u => typeof u === "string" && /^https?:/.test(u));
  if (!images.length) return 0;
  const quote = v => `"${String(v).replace(/"/g, '\\"')}"`;
  const match = [`source->>listing_id.eq.${quote(listing.id)}`];
  const sid = String(listing.platforms?.shopify_earth?.product_id || "").replace(/\D/g, "");
  if (sid) match.push(`source->>shopify_id.eq.${quote(sid)}`, `source->>shopify_id.eq.${quote(`gid://shopify/Product/${sid}`)}`);
  if (listing.linked_stock_id) match.push(`source->>stock_id.eq.${quote(listing.linked_stock_id)}`);
  const rows = await q(supabase.from("trade_products").select("id,images").or(match.join(",")));
  const stale = (rows || []).filter(r => JSON.stringify(r.images || []) !== JSON.stringify(images));
  await Promise.all(stale.map(r => q(supabase.from("trade_products")
    .update({ images, updated_at: new Date().toISOString() }).eq("id", r.id))));
  return stale.length;
}

/* Trade products pulled in from the Earth Editions Shopify store (or added
   from Stock) are the same pieces as listings here, but nothing tied them
   together, so the Trade site chip sat unticked and saves never reached them.
   This finds each listing's trade product and returns the links to record:
   listing id → { product_id, status, url }. A trade product already claimed
   by a listing is left alone, and a stock item shared by several listings
   isn't used to guess. */
export async function findTradeLinks(listings) {
  const [rows, site] = await Promise.all([
    loadAll("trade_products", "id,live,source", "created_at"),
    q(supabase.from("trade_settings").select("value").eq("key", "site_url").maybeSingle()),
  ]);
  const base = String(site?.value || "https://trade.eartheditions.co").replace(/\/+$/, "");
  const claimed = new Set(listings.map(l => l.platforms?.trade?.product_id).filter(Boolean));
  const digits = v => String(v || "").replace(/\D/g, "");
  const byListing = new Map(), byShopify = new Map(), byStock = new Map();
  for (const r of rows) {
    if (claimed.has(r.id)) continue;
    const src = r.source || {};
    if (src.listing_id) byListing.set(String(src.listing_id), r);
    if (digits(src.shopify_id)) byShopify.set(digits(src.shopify_id), r);
    if (src.stock_id) byStock.set(String(src.stock_id), r);
  }
  const stockUse = new Map();
  for (const l of listings) if (l.linked_stock_id) stockUse.set(l.linked_stock_id, (stockUse.get(l.linked_stock_id) || 0) + 1);
  const links = {};
  const taken = new Set();
  for (const l of listings) {
    const pd = l.platforms?.trade;
    if (pd?.product_id && pd.status !== "deleted") continue;
    const row = byListing.get(String(l.id))
      || byShopify.get(digits(l.platforms?.shopify_earth?.product_id))
      || (stockUse.get(l.linked_stock_id) === 1 ? byStock.get(String(l.linked_stock_id)) : null);
    if (!row || taken.has(row.id)) continue;
    taken.add(row.id);
    links[l.id] = { product_id: row.id, status: row.live ? "active" : "draft", url: `${base}/p/${row.id}` };
  }
  return links;
}

export async function hideTradeProduct(productId) {
  if (!productId) throw new Error("Not on the trade site");
  await q(supabase.from("trade_products").update({ live: false, updated_at: new Date().toISOString() }).eq("id", productId));
}
