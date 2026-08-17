/* Omnisend — email marketing: past campaigns, the subscriber list, and the
   composer that turns ERP listings into a mailer.

   Two deliberate limits, both imposed by Omnisend's API rather than by choice:
   its campaign resource carries no open/click statistics, so this screen links
   out for reporting instead of inventing numbers; and contacts page by opaque
   cursor, so "load more" walks forward and cannot jump to an arbitrary page. */
import { useState, useEffect, useRef, useCallback } from "react";
import { C, mob, FI } from "./lmTheme.js";
import { loadK } from "./utils.js";
import CampaignComposer from "./CampaignComposer.jsx";

const LIST_KEY = "ng-listings-v1";
const PAGE = 250;

const api = async payload => {
  const r = await fetch("/api/omnisend", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d.error || `Request failed (${r.status})`);
  return d;
};

const fmtDate = v => {
  if (!v) return "—";
  const d = new Date(v);
  return isNaN(d) ? "—" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};
const fmtDateTime = v => {
  if (!v) return "—";
  const d = new Date(v);
  return isNaN(d) ? "—" : `${fmtDate(v)} · ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
};

const STATUS_TONE = {
  sent: [C.green, C.greenBg], sending: [C.blue, C.blueBg], scheduled: [C.blue, C.blueBg],
  draft: [C.amber, C.amberBg], paused: [C.amber, C.amberBg], failed: [C.red, C.redBg],
  subscribed: [C.green, C.greenBg], unsubscribed: [C.red, C.redBg], nonsubscribed: [C.inkFaint, C.card],
};
/* The ERP's own type scale: Figtree for the interface, Cormorant for headings and
   the numbers that want to read as figures. Everything below borrows the weights
   the rest of the suite uses (600–700, never 800+) so this module doesn't shout. */
const FONT = "-apple-system,'SF Pro Display','Figtree',system-ui,sans-serif";
const SERIF = "'Cormorant Garamond',Georgia,serif";

function Pill({ children }) {
  const key = String(children || "").toLowerCase();
  const [fg, bg] = STATUS_TONE[key] || [C.inkFaint, C.card];
  return <span style={{ color: fg, background: bg, borderRadius: 4, padding: "2px 8px", fontSize: 10, fontWeight: 700, whiteSpace: "nowrap" }}>{children || "—"}</span>;
}

const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12 };
const btn = (bg = C.surface, fg = C.ink) => ({ background: bg, color: fg, border: bg === C.surface ? `1px solid ${C.border}` : "none", borderRadius: 7, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap", transition: "background .15s, box-shadow .15s" });
const lab = { fontSize: 9.5, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 4, display: "block" };

/* One table skin for both list screens — they were drifting apart by a pixel or
   two in every cell, which is most of what made the module look unlike the ERP. */
const TH = { textAlign: "left", fontSize: 9.5, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, padding: "9px 12px", borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" };
const TD = { padding: "11px 12px", fontSize: 13, color: C.ink, borderBottom: `1px solid ${C.border}`, verticalAlign: "middle" };

/* Segmented filter — the same control the ERP dashboard uses for its view switch:
   one recessed track, the active choice lifted onto a white chip. */
function Segmented({ value, onChange, options }) {
  return (
    <div style={{ display: "flex", gap: 2, background: C.card, borderRadius: 9, padding: 3 }}>
      {options.map(([k, label]) => (
        <button key={k} onClick={() => onChange(k)} style={{
          border: "none", cursor: "pointer", fontFamily: "inherit", borderRadius: 7,
          padding: "6px 13px", fontSize: 12.5, whiteSpace: "nowrap",
          background: value === k ? C.surface : "transparent",
          boxShadow: value === k ? "0 1px 3px rgba(26,19,8,.10)" : "none",
          fontWeight: value === k ? 600 : 400,
          color: value === k ? C.ink : C.inkMid,
          textTransform: "capitalize", transition: "all .15s",
        }}>{label}</button>
      ))}
    </div>
  );
}

/* RFC-4180 quoting: Excel mangles the file otherwise on names with commas. */
const csvCell = v => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function downloadCsv(filename, rows) {
  const blob = new Blob(["﻿" + rows.map(r => r.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export default function OmnisendApp({ onHome }) {
  const [tab, setTab] = useState("campaigns");
  const [configured, setConfigured] = useState(null); // null = still checking
  const [setupErr, setSetupErr] = useState("");
  const [listings, setListings] = useState([]);
  const [composerOpen, setComposerOpen] = useState(false);
  const [toast, setToast] = useState("");
  const showToast = m => { setToast(m); setTimeout(() => setToast(""), 3200); };

  useEffect(() => {
    (async () => {
      try {
        const s = await api({ action: "status" });
        setConfigured(!!s.configured && s.valid !== false);
        if (s.configured && s.valid === false) setSetupErr(s.error || "Omnisend rejected the API key.");
      } catch (e) { setConfigured(false); setSetupErr(e.message); }
    })();
    loadK(LIST_KEY).then(l => setListings(Array.isArray(l) ? l : [])).catch(() => {});
  }, []);

  const TABS = [["campaigns", "📣", "Campaigns"], ["approvals", "✅", "Approvals"], ["subscribers", "👥", "Subscribers"]];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: FONT, color: C.ink }}>
      {toast && <div style={{ position: "fixed", bottom: 22, right: 22, zIndex: 1200, background: C.ink, color: "#fff", padding: "10px 18px", borderRadius: 6, fontSize: 12, boxShadow: "var(--e-2)", display: "flex", alignItems: "center", gap: 8 }}>{toast}</div>}

      {/* Sticky header — same two-deck shape as Listing Manager: title bar, then tabs. */}
      <div style={{ position: "sticky", top: 0, zIndex: 100, background: C.surface, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: mob() ? "10px 14px" : "11px 28px" }}>
          <button onClick={onHome}
            style={{ background: "none", border: "none", cursor: "pointer", color: C.inkMid, fontFamily: "inherit",
              fontSize: 13, padding: "0 12px 0 0", borderRight: `1px solid ${C.border}` }}>← Home</button>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, lineHeight: 1 }}>Omnisend</div>
            <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 1 }}>Campaigns, subscribers and mailers</div>
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={() => setComposerOpen(true)} disabled={!configured}
            title={configured ? "" : "Connect Omnisend first"}
            style={{ background: configured ? C.ink : C.card, color: configured ? "#FAF0DC" : C.inkFaint, border: "none",
              borderRadius: 7, padding: "8px 18px", fontSize: 13, fontWeight: 700, fontFamily: "inherit",
              cursor: configured ? "pointer" : "not-allowed" }}>
            📣 {mob() ? "" : "New campaign"}
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", overflowX: "auto", padding: mob() ? "0 10px" : "0 28px" }}>
          {TABS.map(([k, icon, label]) => (
            <button key={k} onClick={() => setTab(k)} style={{
              display: "flex", alignItems: "center", gap: 6, marginBottom: -1,
              border: "none", background: "none", cursor: "pointer", fontFamily: "inherit",
              padding: "11px 14px", fontSize: 13, fontWeight: tab === k ? 700 : 400, whiteSpace: "nowrap",
              color: tab === k ? C.ink : C.inkMid,
              borderBottom: `2.5px solid ${tab === k ? C.gold : "transparent"}`,
            }}><span style={{ fontSize: 14 }}>{icon}</span>{label}</button>
          ))}
        </div>
      </div>

      <div style={{ padding: mob() ? 14 : "24px 28px", maxWidth: 1100, margin: "0 auto" }}>
        {configured === false && (
          <div style={{ ...card, background: C.goldLight, border: `1px solid ${C.borderHi}`, padding: "13px 16px", marginBottom: 16, fontSize: 13, color: C.gold, lineHeight: 1.6 }}>
            <strong>Omnisend isn't connected.</strong> Add <code>OMNISEND_API_KEY</code> in Vercel → Settings → Environment Variables, then redeploy — env vars are baked in at deploy time, so an existing deployment won't pick up a new key.
            {setupErr && <div style={{ marginTop: 6, color: C.red }}>{setupErr}</div>}
          </div>
        )}
        {configured === null && <div style={{ color: C.inkFaint, fontSize: 13, padding: 20 }}>Checking connection…</div>}
        {configured && tab === "campaigns" && <CampaignsTab showToast={showToast} />}
        {configured && tab === "approvals" && <ApprovalsTab showToast={showToast} />}
        {configured && tab === "subscribers" && <SubscribersTab showToast={showToast} />}
      </div>

      {composerOpen && <CampaignComposer listings={listings} showToast={showToast} onClose={() => setComposerOpen(false)} />}
    </div>
  );
}

/* ── Campaigns ─────────────────────────────────────────────────────────────── */
const relTime = iso => {
  const t = new Date(iso).getTime();
  if (!t || isNaN(t)) return "";
  const d = Math.floor((Date.now() - t) / 86400000);
  if (d < 0) return "scheduled";
  if (d === 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 30) return `${d}d ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
};
const duration = (a, b) => {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  if (!ms || isNaN(ms) || ms < 0) return "";
  return ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`;
};

function CampaignsTab({ showToast }) {
  const [rows, setRows] = useState([]);
  const [segNames, setSegNames] = useState({});   // segmentID → name
  const [after, setAfter] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("newest");
  const [deleting, setDeleting] = useState("");

  const load = useCallback(async (cursor = "") => {
    setLoading(true); setErr("");
    try {
      const d = await api({ action: "campaigns", limit: 100, ...(cursor ? { after: cursor } : {}) });
      setRows(prev => cursor ? [...prev, ...(d.campaigns || [])] : (d.campaigns || []));
      setAfter(d.after || ""); setHasMore(!!d.hasMore);
    } catch (e) { setErr(e.message); } finally { setLoading(false); }
  }, []);

  /* Deleting is offered for drafts and the failed ones only — a sent campaign is
     the record that it went out, and the API refuses those anyway. Typing isn't
     demanded the way sending demands it: this destroys a draft, not an audience's
     inbox, and the name is in the prompt to catch the wrong row. */
  const remove = async c => {
    if (!window.confirm(`Delete the draft "${c.name || c.subject || c.id}"?\n\nThis removes it from Omnisend and cannot be undone.`)) return;
    setDeleting(c.id); setErr("");
    try {
      await api({ action: "delete_campaign", campaignId: c.id });
      setRows(rs => rs.filter(r => r.id !== c.id));
      setOpen(o => (o === c.id ? null : o));
      showToast?.("✓ Draft deleted");
    } catch (e) { setErr(`Couldn't delete: ${e.message}`); } finally { setDeleting(""); }
  };

  useEffect(() => {
    load();
    // Audience is stored as segment ids; names make the list readable.
    api({ action: "segments" })
      .then(d => setSegNames(Object.fromEntries((d.segments || []).map(s => [String(s.id), s.name]))))
      .catch(() => {});
  }, [load]);

  const audienceOf = c => {
    const ids = c.segmentIds || [];
    if (!ids.length) return "All subscribers";
    const named = ids.map(id => segNames[String(id)]).filter(Boolean);
    return named.length ? named.join(" + ") : `${ids.length} segment${ids.length > 1 ? "s" : ""}`;
  };

  const ql = q.trim().toLowerCase();
  const shown = rows
    .filter(c => (status === "all" || String(c.status).toLowerCase() === status) &&
      (!ql || `${c.name} ${c.subject} ${c.senderName} ${audienceOf(c)}`.toLowerCase().includes(ql)))
    .sort((a, b) => {
      if (sort === "name") return String(a.name).localeCompare(String(b.name));
      const at = new Date(a.sentAt || a.createdAt || 0).getTime();
      const bt = new Date(b.sentAt || b.createdAt || 0).getTime();
      return sort === "oldest" ? at - bt : bt - at;
    });

  const statuses = ["all", ...[...new Set(rows.map(r => String(r.status || "").toLowerCase()).filter(Boolean))]];
  const sentRows = rows.filter(r => String(r.status).toLowerCase() === "sent");
  const lastSent = sentRows.map(r => r.sentAt).filter(Boolean).sort().pop();

  const stat = (label, value, sub) => (
    <div style={{ ...card, padding: "11px 15px", minWidth: 116, flex: "1 1 116px", boxShadow: "var(--e-1)" }}>
      <div style={lab}>{label}</div>
      <div className="tnum" style={{ fontFamily: SERIF, fontSize: 24, fontWeight: 700, color: C.ink, lineHeight: 1.05 }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, color: C.inkFaint, marginTop: 3 }}>{sub}</div>}
    </div>
  );

  return (
    <>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        {stat("Campaigns", rows.length, hasMore ? "more available" : "all loaded")}
        {stat("Sent", sentRows.length, lastSent ? `last ${relTime(lastSent)}` : "none yet")}
        {stat("Drafts", rows.filter(r => String(r.status).toLowerCase() === "draft").length, "not sent")}
        {stat("Audiences", Object.keys(segNames).length || "—", "segments in account")}
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, subject, sender or audience…" style={{ ...FI(), maxWidth: 300 }} />
        <Segmented value={status} onChange={setStatus} options={statuses.map(s => [s,
          `${s} ${s === "all" ? rows.length : rows.filter(r => String(r.status).toLowerCase() === s).length}`])} />
        <select value={sort} onChange={e => setSort(e.target.value)} style={{ ...FI(), width: "auto", cursor: "pointer", fontSize: 12, padding: "7px 9px" }}>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="name">By name</option>
        </select>
        <div style={{ flex: 1 }} />
        <button onClick={() => load()} disabled={loading} style={btn()}>{loading ? "Loading…" : "↻ Refresh"}</button>
        <button
          onClick={() => downloadCsv(`omnisend-campaigns-${new Date().toISOString().slice(0, 10)}.csv`,
            [["Name", "Subject", "Preheader", "Status", "Audience", "Sender", "Sender email", "Created", "Sent"],
             ...shown.map(c => [c.name, c.subject, c.preheader, c.status, audienceOf(c), c.senderName, c.senderEmail, c.createdAt, c.sentAt])])}
          disabled={!shown.length} style={btn()}>⬇ CSV</button>
      </div>

      {err && <div style={{ ...card, borderColor: C.red, background: C.redBg, color: C.red, padding: "10px 13px", fontSize: 12.5, marginBottom: 12 }}>{err}</div>}

      {!loading && !shown.length && !err && (
        <div style={{ ...card, padding: 40, textAlign: "center", color: C.inkFaint, fontSize: 13 }}>
          {rows.length ? "No campaigns match that filter." : "No campaigns in this Omnisend account yet."}
        </div>
      )}

      <div style={{ ...card, overflow: "hidden" }}>
        {shown.map((c, i) => {
          const isOpen = open === c.id;
          const tone = (STATUS_TONE[String(c.status).toLowerCase()] || [C.inkFaint])[0];
          const when = c.sentAt || c.createdAt;
          return (
            <div key={c.id} style={{ borderTop: i ? `1px solid ${C.border}` : "none" }}>
              <div onClick={() => setOpen(isOpen ? null : c.id)} className="rh"
                style={{ display: "grid", gridTemplateColumns: mob() ? "1fr auto" : "minmax(0,2.2fr) minmax(0,1.1fr) 128px 84px 18px",
                  gap: 10, alignItems: "center", padding: mob() ? "10px 12px" : "10px 14px", cursor: "pointer",
                  borderLeft: `3px solid ${tone}`, background: isOpen ? C.card : "transparent" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</div>
                  <div style={{ fontSize: 11, color: C.inkMid, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.subject || "(no subject)"}</div>
                </div>
                {!mob() && <div style={{ fontSize: 11, color: C.inkFaint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={audienceOf(c)}>👥 {audienceOf(c)}</div>}
                {!mob() && (
                  <div style={{ fontSize: 11, color: C.inkFaint, whiteSpace: "nowrap" }}>
                    {c.sentAt ? "Sent " : "Created "}{fmtDate(when)}
                    <div style={{ fontSize: 10, opacity: .75 }}>{relTime(when)}</div>
                  </div>
                )}
                <Pill>{c.status}</Pill>
                {!mob() && <span style={{ fontSize: 10, color: C.inkFaint, transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▸</span>}
              </div>

              {isOpen && (
                <div style={{ padding: "14px 16px 16px", background: C.card, borderTop: `1px solid ${C.border}` }}>
                  <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "repeat(auto-fit,minmax(190px,1fr))", gap: 12 }}>
                    {[["Subject", c.subject], ["Preheader", c.preheader],
                      ["Audience", audienceOf(c)],
                      ["Sender", c.senderName ? `${c.senderName}${c.senderEmail ? ` <${c.senderEmail}>` : ""}` : ""],
                      ["Type", `${c.type || "—"}${c.channel ? ` · ${c.channel}` : ""}`],
                      ["Created", fmtDateTime(c.createdAt)],
                      ["Sent", c.sentAt ? fmtDateTime(c.sentAt) : "—"],
                      ["Delivery took", duration(c.sentAt, c.endedAt)],
                      ["Campaign ID", c.id],
                    ].filter(([, v]) => v).map(([k, v]) => (
                      <div key={k}>
                        <span style={lab}>{k}</span>
                        <div style={{ fontSize: 12.5, color: C.ink, wordBreak: "break-word" }}>{v}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ marginTop: 13, paddingTop: 12, borderTop: `1px solid ${C.border}`, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    {/* Deep link to this campaign — the bare /campaigns index 404s. */}
                    <a href={`https://app.omnisend.com/campaigns/edit/${encodeURIComponent(c.id)}/content`}
                      target="_blank" rel="noreferrer" style={{ ...btn(), textDecoration: "none", display: "inline-block" }}>Open in Omnisend ↗</a>
                    {!["sent", "sending"].includes(String(c.status).toLowerCase()) && (
                      <button onClick={() => remove(c)} disabled={deleting === c.id}
                        style={{ ...btn(C.redBg, C.red), border: `1px solid ${C.red}`, opacity: deleting === c.id ? .5 : 1 }}>
                        {deleting === c.id ? "Deleting…" : "Delete draft"}
                      </button>
                    )}
                    <span style={{ fontSize: 10.5, color: C.inkFaint, lineHeight: 1.5, flex: "1 1 260px" }}>
                      Open/click rates and the email preview aren't in Omnisend's API — its campaign endpoint returns no statistics and past templates aren't retrievable, so those live in Omnisend itself.
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
        <span style={{ fontSize: 11.5, color: C.inkFaint }}>
          {shown.length} shown{rows.length !== shown.length ? ` of ${rows.length}` : ""}
        </span>
        <div style={{ flex: 1 }} />
        {hasMore && <button onClick={() => load(after)} disabled={loading} style={btn()}>{loading ? "Loading…" : "Load more"}</button>}
      </div>
    </>
  );
}

/* ── Approvals ─────────────────────────────────────────────────────────────────
   Mailing-list signups land as Shopify customers with no trade access. Approving
   is three steps that belong together: the storefront reads a tag on the Shopify
   customer to unlock prices and login, Omnisend reads a tag on the contact to
   place them in the audience, and a custom event tells Omnisend to send the
   welcome mail. A half-done approval is the failure mode this screen exists to
   prevent, so each step is reported per row.

   The email itself is not sent from here. Omnisend has no transactional endpoint,
   and even if it did, the template, the unsubscribe footer and the open rates
   belong in the mail tool — so the ERP fires WELCOME_EVENT and an automation in
   Omnisend does the sending. No automation there means no email: the approval
   still completes, which is why a failed event is reported but never fatal.

   Shopify credentials live in Supabase per store, not in the function's env, so
   they are read here and passed with the request — the same path the Listing
   Manager uses. */
const APPROVE_TAG = "approved";
/* An approval puts the contact in the active segment — that segment is the mailing
   list, and a wholesale buyer who was just let in belongs on it. Applied whether
   the approval creates the contact or finds one already there: being approved is
   what "active" means here. If a contact was parked in another segment by hand,
   the tag editor is where that gets sorted out. */
const ACTIVE_TAG = "active";
const WELCOME_EVENT = "wholesale_approved";
const SHOP_CREDS_KEY = "ng-shopify-creds-earth";

const shopApi = async payload => {
  const r = await fetch("/api/shopify", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d.error || `Request failed (${r.status})`);
  return d;
};
const hasApproveTag = c => (c.tags || []).some(t => String(t).toLowerCase() === APPROVE_TAG);

/* ── Welcome email template ───────────────────────────────────────────────────
   The mail is sent by an Omnisend automation, so its design has to live there
   too — which is how it drifted away from everything else the brand sends. The
   ERP can still author it: this renders the same editorial shell the campaigns
   use (via the API's preview action, no products) and hands over the HTML to
   paste into the automation's email step once.

   [[contact.firstName]] is Omnisend's own contact tag, resolved at send. It is
   left visible in the copy so it is obvious what will be substituted. */
const WELCOME_DEFAULTS = {
  heading: "Welcome to Earth Editions",
  intro: [
    "Hello [[contact.firstName]],",
    "",
    "Thank you for registering with Earth Editions — your wholesale account has been approved, and trade pricing is now visible when you log in.",
    "",
    "A bit about us: we exhibit internationally at Tucson, Denver, Munich and Tokyo, and export year-round to clients worldwide. With decades of experience working with natural minerals, we focus on high-quality material, honest grading and dependable support.",
    "",
    "We're glad to have you with us.",
  ].join("\n"),
};

/* `forCustomer` turns the authoring view into "what this person gets": the
   personalisation tag is filled in with their own name, the way Omnisend will
   fill it at send. It is a preview of the template, not a copy of a delivered
   message — Omnisend sends it and the ERP never sees the result. */
function WelcomeTemplate({ onClose, showToast, forCustomer }) {
  const [heading, setHeading] = useState(WELCOME_DEFAULTS.heading);
  const [intro, setIntro] = useState(WELCOME_DEFAULTS.intro);
  const [html, setHtml] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Same renderer as the campaigns — products omitted, so the shell carries the
  // masthead, the copy, the trade panel and the shipping terms and nothing else.
  const render = useCallback(async () => {
    setBusy(true); setErr("");
    try {
      // Personalisation is resolved by Omnisend at send; substituting here shows
      // the customer what lands in their inbox rather than the raw tag.
      const first = String(forCustomer?.name || "").trim().split(" ")[0];
      const d = await api({
        action: "preview", layout: "editorial", products: [],
        brand: "Earth Editions", heading,
        intro: forCustomer ? intro.replace(/\[\[contact\.firstName\]\]/g, first || "there") : intro,
        dateLine: false,
        headerImage: "https://cdn.shopify.com/s/files/1/0799/9576/4953/files/White_Background_-_Black_-_Vertical_f86e2e99-211d-4ab6-84a2-b67ff247af3f.png?v=1786605155",
        logoWidth: 150, font: "serif", cornerStyle: "square",
        pageBg: "#e5e6e6", cardBg: "#ffffff", ink: "#1a1308",
        tradeEyebrow: "Trade access", tradeLine: "View full catalogue & wholesale pricing",
        tradeButton: "Log in to eartheditions.co", tradeUrl: "https://eartheditions.co/account/login",
        shipIcon: "✈️", shipTitle: "Duty free worldwide shipping",
        shipNote: "All orders ship DDP — the price you see is the price you pay. No customs fees, no import duties, no surprise charges on delivery.",
        instagramUrl: "https://www.instagram.com/eartheditions_/?hl=fr",
      });
      setHtml(d.html || "");
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }, [heading, intro, forCustomer]);
  useEffect(() => { render(); /* eslint-disable-next-line */ }, [forCustomer]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(html); showToast?.("✓ HTML copied — paste it into the Omnisend automation"); }
    catch { setErr("Couldn't reach the clipboard — select the HTML below and copy it manually."); }
  };

  return (
    <div onClick={e => e.target === e.currentTarget && onClose()}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 1000, display: "flex", alignItems: mob() ? "stretch" : "center", justifyContent: "center", padding: mob() ? 0 : 20 }}>
      <div style={{ background: C.bg, borderRadius: mob() ? 0 : 16, width: "min(1000px,100%)", maxHeight: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", borderBottom: `1px solid ${C.border}`, background: C.surface, flexShrink: 0 }}>
          <div style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, lineHeight: 1 }}>✉ Welcome email</div>
          <div style={{ fontSize: 11, color: C.inkFaint }}>
            {forCustomer ? `as ${forCustomer.email || forCustomer.name} receives it` : "sent by the Omnisend automation, authored here"}
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={btn()}>Close</button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 14, display: "grid", gap: 12, gridTemplateColumns: mob() ? "1fr" : "1fr 1fr" }}>
          <div style={{ display: "grid", gap: 10, alignContent: "start" }}>
            <div>
              <span style={lab}>Heading</span>
              <input value={heading} onChange={e => setHeading(e.target.value)} style={FI()} />
            </div>
            <div>
              <span style={lab}>Body</span>
              <textarea value={intro} onChange={e => setIntro(e.target.value)} rows={12} style={{ ...FI(), resize: "vertical", lineHeight: 1.6 }} />
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={render} disabled={busy} style={btn()}>{busy ? "Rendering…" : "↻ Refresh preview"}</button>
              <button onClick={copy} disabled={!html} style={{ ...btn(C.ink, "#FAF0DC"), opacity: html ? 1 : .5 }}>Copy HTML</button>
            </div>
            {err && <div style={{ ...card, borderColor: C.red, background: C.redBg, color: C.red, padding: "9px 12px", fontSize: 12.5 }}>{err}</div>}
            <div style={{ ...card, padding: "11px 13px", fontSize: 11.5, color: C.inkMid, lineHeight: 1.7 }}>
              <strong style={{ color: C.ink }}>Where this goes.</strong> Omnisend → Automations → trigger <code>Custom event → {WELCOME_EVENT}</code> → Email step → in the editor choose an HTML/code block and paste. Approve one customer first: an event only appears in the trigger list once it has fired.
              <div style={{ marginTop: 7 }}>Omnisend adds the copyright, address and unsubscribe links underneath — this HTML deliberately carries none.</div>
            </div>
          </div>
          <div style={{ ...card, padding: 0, overflow: "hidden", minHeight: 380 }}>
            <iframe title="Welcome email preview" srcDoc={html} style={{ width: "100%", height: "100%", minHeight: 380, border: "none", background: "#fff" }} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Omnisend tag editor ──────────────────────────────────────────────────────
   Segments in Omnisend are driven by these tags, so the tags have to be editable
   by hand: a contact sitting in the wrong segment is fixed here rather than in a
   second browser tab. Saved as a diff rather than a whole list — the API merges
   adds and removals into whatever the contact carries at that moment, so a tag
   applied in Omnisend since this screen loaded isn't wiped by saving here. */
const TAG_SUGGESTIONS = [APPROVE_TAG, ACTIVE_TAG, "inactive", "wholesale"];

function TagEditor({ email, tags, onClose, onSaved, showToast }) {
  const [list, setList] = useState(() => [...(tags || [])]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const has = t => list.some(x => String(x).toLowerCase() === String(t).toLowerCase());
  const addTag = raw => {
    const fresh = String(raw).split(",").map(t => t.trim()).filter(Boolean);
    setList(l => {
      const out = [...l];
      for (const t of fresh) if (!out.some(x => String(x).toLowerCase() === t.toLowerCase())) out.push(t);
      return out;
    });
    setInput("");
  };
  const drop = t => setList(l => l.filter(x => x !== t));

  const save = async () => {
    const before = (tags || []).map(String);
    const lower = a => a.map(t => String(t).toLowerCase());
    const addTags = list.filter(t => !lower(before).includes(String(t).toLowerCase()));
    const removeTags = before.filter(t => !lower(list).includes(String(t).toLowerCase()));
    if (!addTags.length && !removeTags.length) { onClose(); return; }
    setBusy(true); setErr("");
    try {
      const d = await api({ action: "contact_tag", email, addTags, removeTags, createIfMissing: false });
      onSaved(d.tags || list);
      showToast?.(`✓ Tags updated for ${email}`);
      onClose();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div onClick={e => e.target === e.currentTarget && onClose()}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ ...card, background: C.bg, width: "min(460px,100%)", padding: 18 }}>
        <div style={{ fontFamily: SERIF, fontSize: 19, fontWeight: 700, lineHeight: 1 }}>Omnisend tags</div>
        <div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 4 }}>{email}</div>

        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", margin: "14px 0 10px", minHeight: 26 }}>
          {list.length ? list.map(t => (
            <span key={t} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: C.card, border: `1px solid ${C.border}`, borderRadius: 5, padding: "3px 6px 3px 8px", fontSize: 11.5, color: C.ink }}>
              {t}
              <button onClick={() => drop(t)} title={`Remove ${t}`}
                style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", color: C.inkFaint, fontSize: 13, lineHeight: 1, padding: 0 }}>×</button>
            </span>
          )) : <span style={{ fontSize: 11.5, color: C.inkFaint }}>No tags — this contact is in no tag-driven segment.</span>}
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <input value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && input.trim()) { e.preventDefault(); addTag(input); } }}
            placeholder="Add a tag, then Enter…" style={FI()} />
          <button onClick={() => input.trim() && addTag(input)} disabled={!input.trim()} style={{ ...btn(), opacity: input.trim() ? 1 : .5 }}>Add</button>
        </div>

        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 9 }}>
          {TAG_SUGGESTIONS.filter(t => !has(t)).map(t => (
            <button key={t} onClick={() => addTag(t)}
              style={{ background: "none", border: `1px dashed ${C.border}`, borderRadius: 5, padding: "3px 8px", fontSize: 11, color: C.inkMid, cursor: "pointer", fontFamily: "inherit" }}>+ {t}</button>
          ))}
        </div>

        {err && <div style={{ ...card, borderColor: C.red, background: C.redBg, color: C.red, padding: "9px 12px", fontSize: 12.5, marginTop: 12 }}>{err}</div>}

        <div style={{ display: "flex", gap: 8, marginTop: 16, alignItems: "center" }}>
          <button onClick={save} disabled={busy} style={{ ...btn(C.ink, "#FAF0DC"), opacity: busy ? .6 : 1 }}>{busy ? "Saving…" : "Save tags"}</button>
          <button onClick={onClose} style={btn()}>Cancel</button>
          <span style={{ fontSize: 10.5, color: C.inkFaint, lineHeight: 1.4 }}>Segments update on Omnisend's own schedule.</span>
        </div>
      </div>
    </div>
  );
}

function ApprovalsTab({ showToast }) {
  const [creds, setCreds] = useState(undefined);   // undefined = loading, null = missing
  const [rows, setRows] = useState([]);
  const [omniTags, setOmniTags] = useState({});    // email → tags[] already in Omnisend
  const [mailed, setMailed] = useState({});        // email → welcome event fired this session
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState({});            // customer id → true
  const [view, setView] = useState("pending");
  const [q, setQ] = useState("");
  const [tplOpen, setTplOpen] = useState(false);
  const [previewFor, setPreviewFor] = useState(null);   // customer whose copy to show
  const [tagFor, setTagFor] = useState(null);           // customer whose Omnisend tags are being edited

  useEffect(() => {
    loadK(SHOP_CREDS_KEY)
      .then(c => setCreds(c?.store && c?.token ? c : null))
      .catch(() => setCreds(null));
  }, []);

  const load = useCallback(async () => {
    if (!creds) return;
    setLoading(true); setErr("");
    try {
      const d = await shopApi({ action: "list_customers", shopStore: creds.store, shopToken: creds.token });
      const customers = d.customers || [];
      setRows(customers);
      // Cross-check Omnisend so a half-done approval is visible rather than assumed.
      try {
        const oc = await api({ action: "contacts", limit: PAGE });
        const map = {};
        for (const c of oc.contacts || []) if (c.email) map[c.email.toLowerCase()] = c.tags || [];
        setOmniTags(map);
      } catch {}
    } catch (e) { setErr(e.message); } finally { setLoading(false); }
  }, [creds]);
  useEffect(() => { if (creds) load(); }, [creds, load]);

  const inOmnisend = c => omniTags[String(c.email || "").toLowerCase()];
  const omniApproved = c => (inOmnisend(c) || []).some(t => String(t).toLowerCase() === APPROVE_TAG);

  const approve = async (c, undo = false) => {
    setBusy(b => ({ ...b, [c.id]: true })); setErr("");
    const done = [];
    try {
      await shopApi({
        action: "tag_customer", shopStore: creds.store, shopToken: creds.token,
        customer_id: c.id,
        ...(undo ? { remove_tags: [APPROVE_TAG] } : { add_tags: [APPROVE_TAG] }),
      });
      done.push("Shopify");
      setRows(rs => rs.map(r => r.id === c.id ? {
        ...r,
        tags: undo ? (r.tags || []).filter(t => String(t).toLowerCase() !== APPROVE_TAG) : [...(r.tags || []), APPROVE_TAG],
      } : r));

      if (c.email) {
        try {
          const [firstName, ...rest] = String(c.name || "").split(" ");
          const t = await api({
            action: "contact_tag", email: c.email,
            /* Un-approving takes back trade access, so it takes back the mailing
               segment with it — otherwise a removed buyer keeps receiving the
               list they were removed from. */
            ...(undo ? { removeTags: [APPROVE_TAG, ACTIVE_TAG] } : { addTags: [APPROVE_TAG, ACTIVE_TAG] }),
            createIfMissing: !undo, firstName: firstName || "", lastName: rest.join(" "),
          });
          done.push(undo ? "Omnisend"
            : t.created ? `added to Omnisend · ${APPROVE_TAG} + ${ACTIVE_TAG}`
            : `Omnisend · ${ACTIVE_TAG}`);
          setOmniTags(m => ({ ...m, [c.email.toLowerCase()]: t.tags || [] }));

          // Approving is what earns the welcome mail, so the event only fires on
          // the way in. Un-approving can't unsend anything, so it fires nothing.
          if (!undo) {
            try {
              await api({
                action: "trigger_event", eventName: WELCOME_EVENT, email: c.email,
                properties: {
                  firstName: firstName || "", lastName: rest.join(" "),
                  shopifyCustomerId: String(c.id), approvedAt: new Date().toISOString(),
                },
              });
              done.push("welcome email");
              setMailed(m => ({ ...m, [c.email.toLowerCase()]: true }));
            } catch (e) {
              setErr(`Approved and tagged, but the welcome email didn't trigger for ${c.email}: ${e.message}`);
            }
          }
        } catch (e) {
          // Shopify already succeeded — say exactly what is left undone.
          setErr(`Tagged in Shopify, but Omnisend failed for ${c.email}: ${e.message}`);
        }
      }
      showToast?.(`${undo ? "Removed approval" : "Approved"} · ${done.join(" + ")}`);
    } catch (e) {
      setErr(e.message);
    } finally { setBusy(b => ({ ...b, [c.id]: false })); }
  };

  const ql = q.trim().toLowerCase();
  const matches = c => !ql || `${c.email} ${c.name} ${(c.tags || []).join(" ")}`.toLowerCase().includes(ql);
  const pending = rows.filter(c => !hasApproveTag(c));
  const approved = rows.filter(hasApproveTag);
  const shown = (view === "pending" ? pending : view === "approved" ? approved : rows).filter(matches);

  const th = TH, td = TD;

  if (creds === undefined) return <div style={{ color: C.inkFaint, fontSize: 13, padding: 20 }}>Loading…</div>;
  if (creds === null) return (
    <div style={{ ...card, background: C.goldLight, border: `1px solid ${C.borderHi}`, padding: "13px 16px", fontSize: 13, color: C.gold, lineHeight: 1.6 }}>
      <strong>Earth Editions isn't connected.</strong> Open Listing Manager → Earth Ed. and connect the store, then come back — approving writes a tag to the Shopify customer, so it needs that store's token.
    </div>
  );

  return (
    <>
      {tplOpen && <WelcomeTemplate onClose={() => setTplOpen(false)} showToast={showToast} />}
      {previewFor && <WelcomeTemplate onClose={() => setPreviewFor(null)} showToast={showToast} forCustomer={previewFor} />}
      {tagFor && (
        <TagEditor
          email={tagFor.email} tags={inOmnisend(tagFor) || []} showToast={showToast}
          onClose={() => setTagFor(null)}
          onSaved={tags => setOmniTags(m => ({ ...m, [String(tagFor.email).toLowerCase()]: tags }))}
        />
      )}
      <div style={{ padding: "0 2px", marginBottom: 14, fontSize: 12, color: C.inkFaint, lineHeight: 1.6, maxWidth: 760 }}>
        Approving adds the <code style={{ fontSize: 11.5, background: C.card, borderRadius: 4, padding: "1px 5px" }}>{APPROVE_TAG}</code> tag to the Shopify customer — which unlocks trade prices and account login — adds that tag plus <code style={{ fontSize: 11.5, background: C.card, borderRadius: 4, padding: "1px 5px" }}>{ACTIVE_TAG}</code> to their Omnisend contact so they land in the active segment, and fires the <code style={{ fontSize: 11.5, background: C.card, borderRadius: 4, padding: "1px 5px" }}>{WELCOME_EVENT}</code> event so Omnisend sends the welcome email. All in one click — and <em>✎ tags</em> on any row edits that contact's Omnisend tags by hand.
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search email, name or tag…" style={{ ...FI(), maxWidth: 280 }} />
        <Segmented value={view} onChange={setView} options={[["pending", `Pending ${pending.length}`], ["approved", `Approved ${approved.length}`], ["all", `All ${rows.length}`]]} />
        <div style={{ flex: 1 }} />
        <button onClick={() => setTplOpen(true)} style={btn()} title="Author the email the approval automation sends">✉ Welcome email</button>
        <button onClick={load} disabled={loading} style={btn()}>{loading ? "Loading…" : "↻ Refresh"}</button>
        <button
          onClick={() => downloadCsv(`earth-editions-customers-${new Date().toISOString().slice(0, 10)}.csv`,
            [["Email", "Name", "Approved", "In Omnisend", "Omnisend approved", "Orders", "Spent", "Shopify tags", "Omnisend tags", "Joined"],
             ...shown.map(c => [c.email, c.name, hasApproveTag(c) ? "yes" : "no", inOmnisend(c) ? "yes" : "no",
               omniApproved(c) ? "yes" : "no", c.ordersCount, c.totalSpent, (c.tags || []).join(" | "),
               (inOmnisend(c) || []).join(" | "), c.createdAt])])}
          disabled={!shown.length} style={btn()}>⬇ CSV</button>
      </div>

      {err && <div style={{ ...card, borderColor: C.red, background: C.redBg, color: C.red, padding: "10px 13px", fontSize: 12.5, marginBottom: 12 }}>{err}</div>}

      <div style={{ ...card, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
            <thead><tr>{["Customer", "Shopify", "Omnisend", "Orders", "Joined", ""].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {shown.map(c => {
                const ok = hasApproveTag(c);
                const known = !!inOmnisend(c);
                return (
                  <tr key={c.id} className="rh">
                    <td style={td}>
                      <div style={{ fontWeight: 600 }}>{c.email || "(no email)"}</div>
                      {c.name && <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 1 }}>{c.name}</div>}
                    </td>
                    <td style={td}><Pill>{ok ? "approved" : "pending"}</Pill></td>
                    <td style={td}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        {!known
                          ? <span style={{ fontSize: 11.5, color: C.inkFaint }}>not a contact</span>
                          : omniApproved(c)
                            ? <span style={{ fontSize: 11.5, fontWeight: 600, color: C.green }}>✓ tagged</span>
                            : <span style={{ fontSize: 11.5, fontWeight: 600, color: C.amber }}>untagged</span>}
                        {/* The tags are what put the contact in a segment, so they're
                            editable in place — no trip to Omnisend to fix one. */}
                        {known && c.email && (
                          <button onClick={() => setTagFor(c)} title="Edit this contact's Omnisend tags"
                            style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit",
                              fontSize: 10.5, color: C.inkFaint, textDecoration: "underline" }}>✎ tags</button>
                        )}
                      </div>
                      {known && !!(inOmnisend(c) || []).length && (
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 3 }}>
                          {(inOmnisend(c) || []).slice(0, 3).map(t => (
                            <span key={t} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 5, padding: "1px 5px", fontSize: 10, color: C.inkMid, whiteSpace: "nowrap" }}>{t}</span>
                          ))}
                          {(inOmnisend(c) || []).length > 3 && <span style={{ fontSize: 10, color: C.inkFaint }}>+{(inOmnisend(c) || []).length - 3}</span>}
                        </div>
                      )}
                      {/* Independent of the tag state: the mail either fired or it didn't. */}
                      {mailed[String(c.email || "").toLowerCase()] &&
                        <button onClick={() => setPreviewFor(c)} title="See the welcome email as they receive it"
                          style={{ background: "none", border: "none", padding: "1px 0 0", cursor: "pointer", fontFamily: "inherit",
                            fontSize: 10.5, color: C.inkFaint, textDecoration: "underline", display: "block" }}>
                          ✉ welcome sent · view
                        </button>}
                    </td>
                    <td className="tnum" style={{ ...td, color: C.inkMid }}>{c.ordersCount || 0}</td>
                    <td className="tnum" style={{ ...td, color: C.inkMid, whiteSpace: "nowrap" }}>{fmtDate(c.createdAt)}</td>
                    <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                      {/* Read the mail before sending it, not only after. */}
                      {c.email && (
                        <button onClick={() => setPreviewFor(c)} title="Preview the welcome email this customer will get"
                          style={{ ...btn(), padding: "6px 10px", fontSize: 12, color: C.inkMid, marginRight: 6 }}>✉</button>
                      )}
                      <button onClick={() => approve(c, ok)} disabled={!!busy[c.id] || !c.email}
                        title={c.email ? "" : "This customer has no email address"}
                        style={{ ...btn(ok ? C.surface : C.greenBg, ok ? C.inkMid : C.green), padding: "6px 14px", fontSize: 12,
                          border: `1px solid ${ok ? C.border : C.green}`, opacity: busy[c.id] || !c.email ? .5 : 1 }}>
                        {busy[c.id] ? "…" : ok ? "Remove" : "Approve"}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {!shown.length && !loading && (
                <tr><td colSpan={6} style={{ ...td, textAlign: "center", color: C.inkFaint, padding: 34 }}>
                  {view === "pending" ? "Nothing waiting for approval." : "No customers match."}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 12 }}>{shown.length} shown of {rows.length} customers</div>
    </>
  );
}

/* ── Subscribers ───────────────────────────────────────────────────────────── */
const BLANK = { contactId: "", email: "", firstName: "", lastName: "", country: "", city: "", tags: "", status: "subscribed" };

function SubscribersTab({ showToast }) {
  const [rows, setRows] = useState([]);
  const [after, setAfter] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [status, setStatus] = useState("all");
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState(null);   // BLANK-shaped draft, or null
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState("");
  const cancelExport = useRef(false);

  const load = useCallback(async (cursor = "", statusFilter = status) => {
    setLoading(true); setErr("");
    try {
      const d = await api({
        action: "contacts", limit: PAGE,
        ...(cursor ? { after: cursor } : {}),
        ...(statusFilter !== "all" ? { status: statusFilter } : {}),
      });
      setRows(prev => cursor ? [...prev, ...(d.contacts || [])] : (d.contacts || []));
      setAfter(d.after || ""); setHasMore(!!d.hasMore);
    } catch (e) { setErr(e.message); } finally { setLoading(false); }
  }, [status]);

  useEffect(() => { load("", status); /* eslint-disable-next-line */ }, [status]);

  const save = async () => {
    setSaving(true); setErr("");
    try {
      const payload = {
        action: "contact_save",
        contactId: edit.contactId || undefined,
        email: edit.email.trim(),
        firstName: edit.firstName, lastName: edit.lastName,
        country: edit.country, city: edit.city, status: edit.status,
        tags: edit.tags.split(",").map(t => t.trim()).filter(Boolean),
      };
      const d = await api(payload);
      showToast?.(d.updated ? "✓ Subscriber updated" : "✓ Subscriber added");
      setEdit(null);
      load("", status);
    } catch (e) { setErr(e.message); } finally { setSaving(false); }
  };

  /* Walk every cursor page so the CSV is the whole list, not just what's on screen.
     Capped so a runaway list can't spin forever; the count is reported either way. */
  const exportAll = async () => {
    cancelExport.current = false;
    setExporting("Fetching page 1…"); setErr("");
    const all = []; let cursor = "", page = 0;
    try {
      do {
        page++;
        const d = await api({ action: "contacts", limit: PAGE, ...(cursor ? { after: cursor } : {}), ...(status !== "all" ? { status } : {}) });
        all.push(...(d.contacts || []));
        cursor = d.after || "";
        setExporting(`Fetched ${all.length} subscribers…`);
        if (!d.hasMore || !cursor || cancelExport.current || page >= 80) break;
      } while (true);
      downloadCsv(`omnisend-subscribers-${new Date().toISOString().slice(0, 10)}.csv`, [
        ["Email", "First name", "Last name", "Status", "Phone", "Country", "City", "Tags", "Created", "Opt-in"],
        ...all.map(c => [c.email, c.firstName, c.lastName, c.status, c.phone, c.country, c.city, (c.tags || []).join(" | "), c.createdAt, c.optInDate]),
      ]);
      showToast?.(`⬇ Exported ${all.length} subscribers`);
    } catch (e) { setErr(e.message); } finally { setExporting(""); }
  };

  const ql = q.trim().toLowerCase();
  const shown = rows.filter(c => !ql || `${c.email} ${c.firstName} ${c.lastName} ${(c.tags || []).join(" ")}`.toLowerCase().includes(ql));

  const th = TH, td = TD;

  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter loaded subscribers…" style={{ ...FI(), maxWidth: 280 }} />
        <Segmented value={status} onChange={setStatus} options={["all", "subscribed", "unsubscribed", "nonsubscribed"].map(s => [s, s])} />
        <div style={{ flex: 1 }} />
        <button onClick={() => setEdit({ ...BLANK })} style={{ ...btn(C.greenBg, C.green), border: `1px solid ${C.green}` }}>+ Add subscriber</button>
        <button onClick={exportAll} disabled={!!exporting} style={btn()}>{exporting || "⬇ Export CSV"}</button>
        <button onClick={() => load("", status)} disabled={loading} style={btn()}>{loading ? "Loading…" : "↻"}</button>
      </div>

      {err && <div style={{ ...card, borderColor: C.red, background: C.redBg, color: C.red, padding: "10px 13px", fontSize: 12.5, marginBottom: 12 }}>{err}</div>}

      {edit && (
        <div style={{ ...card, padding: 16, marginBottom: 14, borderColor: C.gold }}>
          <div style={{ fontFamily: SERIF, fontSize: 19, fontWeight: 700, color: C.ink, marginBottom: 12, lineHeight: 1 }}>{edit.contactId ? "Edit subscriber" : "Add subscriber"}</div>
          <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "repeat(auto-fit,minmax(190px,1fr))", gap: 12 }}>
            <div><span style={lab}>Email *</span><input value={edit.email} disabled={!!edit.contactId} onChange={e => setEdit(s => ({ ...s, email: e.target.value }))} placeholder="name@example.com" style={{ ...FI(), ...(edit.contactId ? { background: C.card, color: C.inkMid } : {}) }} /></div>
            <div><span style={lab}>First name</span><input value={edit.firstName} onChange={e => setEdit(s => ({ ...s, firstName: e.target.value }))} style={FI()} /></div>
            <div><span style={lab}>Last name</span><input value={edit.lastName} onChange={e => setEdit(s => ({ ...s, lastName: e.target.value }))} style={FI()} /></div>
            <div><span style={lab}>Country</span><input value={edit.country} onChange={e => setEdit(s => ({ ...s, country: e.target.value }))} style={FI()} /></div>
            <div><span style={lab}>City</span><input value={edit.city} onChange={e => setEdit(s => ({ ...s, city: e.target.value }))} style={FI()} /></div>
            <div><span style={lab}>Status</span>
              <select value={edit.status} onChange={e => setEdit(s => ({ ...s, status: e.target.value }))} style={{ ...FI(), cursor: "pointer" }}>
                <option value="subscribed">Subscribed</option>
                <option value="unsubscribed">Unsubscribed</option>
              </select>
            </div>
            <div style={{ gridColumn: mob() ? "auto" : "1 / -1" }}><span style={lab}>Tags (comma separated)</span><input value={edit.tags} onChange={e => setEdit(s => ({ ...s, tags: e.target.value }))} placeholder="wholesale, tucson-2026" style={FI()} /></div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center" }}>
            <button onClick={save} disabled={saving || !edit.email.trim()} style={{ ...btn(C.green, "#fff"), opacity: saving || !edit.email.trim() ? .6 : 1 }}>{saving ? "Saving…" : edit.contactId ? "Save changes" : "Add subscriber"}</button>
            <button onClick={() => setEdit(null)} style={btn()}>Cancel</button>
            {edit.contactId && <span style={{ fontSize: 11, color: C.inkFaint }}>Email can't be changed — it identifies the contact in Omnisend.</span>}
          </div>
        </div>
      )}

      <div style={{ ...card, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
            <thead><tr>
              {["Email", "Name", "Status", "Country", "Tags", "Joined", ""].map(h => <th key={h} style={th}>{h}</th>)}
            </tr></thead>
            <tbody>
              {shown.map(c => (
                <tr key={c.id} className="rh">
                  <td style={{ ...td, fontWeight: 600 }}>{c.email || "—"}</td>
                  <td style={td}>{[c.firstName, c.lastName].filter(Boolean).join(" ") || "—"}</td>
                  <td style={td}><Pill>{c.status}</Pill></td>
                  <td style={td}>{c.country || "—"}</td>
                  <td style={{ ...td, maxWidth: 240 }}>
                    {(c.tags || []).length ? (
                      <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {c.tags.slice(0, 3).map(t => <span key={t} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 5, padding: "2px 6px", fontSize: 10.5, color: C.inkMid, whiteSpace: "nowrap" }}>{t}</span>)}
                        {c.tags.length > 3 && <span style={{ fontSize: 10.5, color: C.inkFaint }}>+{c.tags.length - 3}</span>}
                      </span>
                    ) : "—"}
                  </td>
                  <td className="tnum" style={{ ...td, color: C.inkMid, whiteSpace: "nowrap" }}>{fmtDate(c.createdAt)}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button onClick={() => setEdit({
                      contactId: c.id, email: c.email, firstName: c.firstName, lastName: c.lastName,
                      country: c.country, city: c.city, tags: (c.tags || []).join(", "),
                      status: c.status === "unsubscribed" ? "unsubscribed" : "subscribed",
                    })} style={{ ...btn(), padding: "5px 12px", fontSize: 12, color: C.inkMid }}>Edit</button>
                  </td>
                </tr>
              ))}
              {!shown.length && !loading && (
                <tr><td colSpan={7} style={{ ...td, textAlign: "center", color: C.inkFaint, padding: 34 }}>
                  {rows.length ? "No subscribers match that filter." : "No subscribers found."}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
        <span style={{ fontSize: 11.5, color: C.inkFaint }}>
          {shown.length} shown{rows.length !== shown.length ? ` of ${rows.length} loaded` : ""}{hasMore ? " · more available" : ""}
        </span>
        <div style={{ flex: 1 }} />
        {hasMore && <button onClick={() => load(after, status)} disabled={loading} style={btn()}>{loading ? "Loading…" : "Load more"}</button>}
      </div>
    </>
  );
}
