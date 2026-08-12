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
function Pill({ children }) {
  const key = String(children || "").toLowerCase();
  const [fg, bg] = STATUS_TONE[key] || [C.inkFaint, C.card];
  return <span style={{ color: fg, background: bg, borderRadius: 20, padding: "3px 10px", fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: .4, whiteSpace: "nowrap" }}>{children || "—"}</span>;
}

const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12 };
const btn = (bg = C.surface, fg = C.ink) => ({ background: bg, color: fg, border: bg === C.surface ? `1px solid ${C.border}` : "none", borderRadius: 8, padding: "8px 14px", fontSize: 12.5, fontWeight: 800, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" });
const lab = { fontSize: 10, fontWeight: 800, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 4, display: "block" };

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
    <div style={{ minHeight: "100vh", background: C.bg }}>
      {toast && <div style={{ position: "fixed", bottom: 22, right: 22, zIndex: 1200, background: C.ink, color: "#fff", padding: "10px 18px", borderRadius: 8, fontSize: 12.5, boxShadow: "0 8px 28px rgba(0,0,0,.18)" }}>{toast}</div>}

      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: mob() ? "12px 14px" : "14px 22px", borderBottom: `1px solid ${C.border}`, background: C.surface, flexWrap: "wrap" }}>
        <button onClick={onHome} style={btn()}>← Home</button>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 850, color: C.ink }}>Omnisend</div>
          <div style={{ fontSize: 11, color: C.inkFaint }}>Campaigns, subscribers and mailers</div>
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={() => setComposerOpen(true)} disabled={!configured}
          title={configured ? "" : "Connect Omnisend first"}
          style={{ ...btn(configured ? C.ink : C.card, configured ? "#fff" : C.inkFaint), cursor: configured ? "pointer" : "not-allowed" }}>
          📣 New campaign
        </button>
      </div>

      <div style={{ display: "flex", gap: 4, padding: mob() ? "10px 10px 0" : "12px 22px 0", borderBottom: `1px solid ${C.border}`, background: C.surface }}>
        {TABS.map(([k, icon, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            border: "none", background: "transparent", cursor: "pointer", fontFamily: "inherit",
            padding: "8px 14px", fontSize: 13, fontWeight: 800,
            color: tab === k ? C.ink : C.inkFaint,
            borderBottom: `2.5px solid ${tab === k ? C.gold : "transparent"}`,
          }}>{icon} {label}</button>
        ))}
      </div>

      <div style={{ padding: mob() ? 12 : 22, maxWidth: 1280, margin: "0 auto" }}>
        {configured === false && (
          <div style={{ ...card, background: "#fff8e6", border: "1px solid #f0dfae", padding: "13px 15px", marginBottom: 16, fontSize: 12.5, color: "#8a6d1a", lineHeight: 1.6 }}>
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

  const load = useCallback(async (cursor = "") => {
    setLoading(true); setErr("");
    try {
      const d = await api({ action: "campaigns", limit: 100, ...(cursor ? { after: cursor } : {}) });
      setRows(prev => cursor ? [...prev, ...(d.campaigns || [])] : (d.campaigns || []));
      setAfter(d.after || ""); setHasMore(!!d.hasMore);
    } catch (e) { setErr(e.message); } finally { setLoading(false); }
  }, []);

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
    <div style={{ ...card, padding: "10px 14px", minWidth: 116, flex: "1 1 116px" }}>
      <div style={{ fontSize: 9.5, fontWeight: 800, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6 }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 850, color: C.ink, marginTop: 3, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, color: C.inkFaint, marginTop: 2 }}>{sub}</div>}
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
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {statuses.map(s => (
            <button key={s} onClick={() => setStatus(s)} style={{
              ...btn(status === s ? C.ink : C.surface, status === s ? "#fff" : C.inkMid),
              padding: "6px 12px", fontSize: 11.5, textTransform: "capitalize",
            }}>{s}{s === "all" ? ` ${rows.length}` : ` ${rows.filter(r => String(r.status).toLowerCase() === s).length}`}</button>
          ))}
        </div>
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
              <div onClick={() => setOpen(isOpen ? null : c.id)}
                style={{ display: "grid", gridTemplateColumns: mob() ? "1fr auto" : "minmax(0,2.2fr) minmax(0,1.1fr) 128px 84px 18px",
                  gap: 10, alignItems: "center", padding: mob() ? "10px 12px" : "10px 14px", cursor: "pointer",
                  borderLeft: `3px solid ${tone}`, background: isOpen ? C.card : "transparent" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 800, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</div>
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
                    <a href="https://app.omnisend.com/campaigns" target="_blank" rel="noreferrer" style={{ ...btn(), textDecoration: "none", display: "inline-block" }}>Open in Omnisend ↗</a>
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
   is two writes that belong together: the storefront reads a tag on the Shopify
   customer to unlock prices and login, and Omnisend reads a tag on the contact to
   place them in the audience. Doing one without the other is the failure mode
   this screen exists to prevent, so both are reported per row.

   Shopify credentials live in Supabase per store, not in the function's env, so
   they are read here and passed with the request — the same path the Listing
   Manager uses. */
const APPROVE_TAG = "approved";
const SHOP_CREDS_KEY = "ng-shopify-creds-earth";

const shopApi = async payload => {
  const r = await fetch("/api/shopify", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) {
    const e = new Error(d.error || `Request failed (${r.status})`);
    e.data = d;                                    // carries scopeMissing so the UI can offer a reconnect
    throw e;
  }
  return d;
};
const hasApproveTag = c => (c.tags || []).some(t => String(t).toLowerCase() === APPROVE_TAG);

function ApprovalsTab({ showToast }) {
  const [creds, setCreds] = useState(undefined);   // undefined = loading, null = missing
  const [rows, setRows] = useState([]);
  const [omniTags, setOmniTags] = useState({});    // email → tags[] already in Omnisend
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [needScope, setNeedScope] = useState("");  // scope the saved token is missing, if any
  const [busy, setBusy] = useState({});            // customer id → true
  const [view, setView] = useState("pending");
  const [q, setQ] = useState("");

  useEffect(() => {
    loadK(SHOP_CREDS_KEY)
      .then(c => setCreds(c?.store && c?.token ? c : null))
      .catch(() => setCreds(null));
  }, []);

  const load = useCallback(async () => {
    if (!creds) return;
    setLoading(true); setErr(""); setNeedScope("");
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
    } catch (e) {
      if (e.data?.scopeMissing) setNeedScope(e.data.scope || "read_customers"); else setErr(e.message);
    } finally { setLoading(false); }
  }, [creds]);
  useEffect(() => { if (creds) load(); }, [creds, load]);

  // The saved token predates the customer scopes; re-running OAuth mints one that has them.
  const reconnect = async () => {
    try {
      const d = await shopApi({ action: "oauth_url", store_key: "earth", shop: creds.store });
      if (d.url) window.location.href = d.url;
    } catch (e) { setErr(e.message); }
  };

  const inOmnisend = c => omniTags[String(c.email || "").toLowerCase()];
  const omniApproved = c => (inOmnisend(c) || []).some(t => String(t).toLowerCase() === APPROVE_TAG);

  const approve = async (c, undo = false) => {
    setBusy(b => ({ ...b, [c.id]: true })); setErr(""); setNeedScope("");
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
            ...(undo ? { removeTags: [APPROVE_TAG] } : { addTags: [APPROVE_TAG] }),
            createIfMissing: !undo, firstName: firstName || "", lastName: rest.join(" "),
          });
          done.push(t.created ? "added to Omnisend" : "Omnisend");
          setOmniTags(m => ({ ...m, [c.email.toLowerCase()]: t.tags || [] }));
        } catch (e) {
          // Shopify already succeeded — say exactly what is left undone.
          setErr(`Tagged in Shopify, but Omnisend failed for ${c.email}: ${e.message}`);
        }
      }
      showToast?.(`${undo ? "Removed approval" : "Approved"} · ${done.join(" + ")}`);
    } catch (e) {
      if (e.data?.scopeMissing) setNeedScope(e.data.scope || "write_customers"); else setErr(e.message);
    } finally { setBusy(b => ({ ...b, [c.id]: false })); }
  };

  const ql = q.trim().toLowerCase();
  const matches = c => !ql || `${c.email} ${c.name} ${(c.tags || []).join(" ")}`.toLowerCase().includes(ql);
  const pending = rows.filter(c => !hasApproveTag(c));
  const approved = rows.filter(hasApproveTag);
  const shown = (view === "pending" ? pending : view === "approved" ? approved : rows).filter(matches);

  const th = { textAlign: "left", fontSize: 10, fontWeight: 800, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .5, padding: "8px 10px", borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" };
  const td = { padding: "9px 10px", fontSize: 12.5, color: C.ink, borderBottom: `1px solid ${C.border}`, verticalAlign: "middle" };

  if (creds === undefined) return <div style={{ color: C.inkFaint, fontSize: 13, padding: 20 }}>Loading…</div>;
  if (creds === null) return (
    <div style={{ ...card, background: "#fff8e6", border: "1px solid #f0dfae", padding: "13px 15px", fontSize: 12.5, color: "#8a6d1a", lineHeight: 1.6 }}>
      <strong>Earth Editions isn't connected.</strong> Open Listing Manager → Earth Ed. and connect the store, then come back — approving writes a tag to the Shopify customer, so it needs that store's token.
    </div>
  );

  return (
    <>
      <div style={{ ...card, padding: "11px 14px", marginBottom: 14, fontSize: 12, color: C.inkMid, lineHeight: 1.6 }}>
        Approving adds the <code>{APPROVE_TAG}</code> tag to the Shopify customer — which is what unlocks trade prices and account login — and the same tag to their Omnisend contact so the audience rules pick them up. Both happen in one click.
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search email, name or tag…" style={{ ...FI(), maxWidth: 280 }} />
        <div style={{ display: "flex", gap: 4 }}>
          {[["pending", `Pending ${pending.length}`], ["approved", `Approved ${approved.length}`], ["all", `All ${rows.length}`]].map(([k, label]) => (
            <button key={k} onClick={() => setView(k)} style={{ ...btn(view === k ? C.ink : C.surface, view === k ? "#fff" : C.inkMid), padding: "6px 12px", fontSize: 11.5 }}>{label}</button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={load} disabled={loading} style={btn()}>{loading ? "Loading…" : "↻ Refresh"}</button>
        <button
          onClick={() => downloadCsv(`earth-editions-customers-${new Date().toISOString().slice(0, 10)}.csv`,
            [["Email", "Name", "Approved", "In Omnisend", "Omnisend approved", "Orders", "Spent", "Tags", "Joined"],
             ...shown.map(c => [c.email, c.name, hasApproveTag(c) ? "yes" : "no", inOmnisend(c) ? "yes" : "no",
               omniApproved(c) ? "yes" : "no", c.ordersCount, c.totalSpent, (c.tags || []).join(" | "), c.createdAt])])}
          disabled={!shown.length} style={btn()}>⬇ CSV</button>
      </div>

      {needScope && (
        <div style={{ ...card, background: "#fff8e6", border: "1px solid #f0dfae", padding: "13px 15px", fontSize: 12.5, color: "#8a6d1a", lineHeight: 1.6, marginBottom: 12 }}>
          <strong>Earth Editions' Shopify token doesn't include <code>{needScope}</code>.</strong> It was granted before this screen existed, so Shopify refuses the customer calls. Reconnect the store to mint a token that has them.
          <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={reconnect} style={{ ...btn(C.ink, "#fff"), padding: "6px 12px", fontSize: 11.5 }}>Reconnect Earth Editions</button>
            <span style={{ fontSize: 11 }}>Customer data is a protected scope — if the reconnect still comes back without it, approve protected customer data access for the app in the Shopify Partner dashboard first.</span>
          </div>
        </div>
      )}

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
                  <tr key={c.id}>
                    <td style={td}>
                      <div style={{ fontWeight: 700 }}>{c.email || "(no email)"}</div>
                      {c.name && <div style={{ fontSize: 11, color: C.inkFaint }}>{c.name}</div>}
                    </td>
                    <td style={td}><Pill>{ok ? "approved" : "pending"}</Pill></td>
                    <td style={td}>
                      {!known
                        ? <span style={{ fontSize: 11, color: C.inkFaint }}>not a contact</span>
                        : omniApproved(c)
                          ? <span style={{ fontSize: 11.5, fontWeight: 800, color: C.green }}>✓ tagged</span>
                          : <span style={{ fontSize: 11.5, fontWeight: 800, color: C.amber }}>untagged</span>}
                    </td>
                    <td style={{ ...td, color: C.inkMid }}>{c.ordersCount || 0}</td>
                    <td style={{ ...td, color: C.inkMid, whiteSpace: "nowrap" }}>{fmtDate(c.createdAt)}</td>
                    <td style={{ ...td, textAlign: "right" }}>
                      <button onClick={() => approve(c, ok)} disabled={!!busy[c.id] || !c.email}
                        title={c.email ? "" : "This customer has no email address"}
                        style={{ ...btn(ok ? C.surface : C.green, ok ? C.ink : "#fff"), padding: "6px 12px", fontSize: 11.5, opacity: busy[c.id] || !c.email ? .6 : 1 }}>
                        {busy[c.id] ? "…" : ok ? "Remove" : "Approve"}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {!shown.length && !loading && (
                <tr><td colSpan={6} style={{ ...td, textAlign: "center", color: C.inkFaint, padding: 34 }}>
                  {needScope ? "Customer list unavailable until the store is reconnected."
                    : view === "pending" ? "Nothing waiting for approval." : "No customers match."}
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

  const th = { textAlign: "left", fontSize: 10, fontWeight: 800, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .5, padding: "8px 10px", borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" };
  const td = { padding: "9px 10px", fontSize: 12.5, color: C.ink, borderBottom: `1px solid ${C.border}`, verticalAlign: "middle" };

  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter loaded subscribers…" style={{ ...FI(), maxWidth: 280 }} />
        <div style={{ display: "flex", gap: 4 }}>
          {["all", "subscribed", "unsubscribed", "nonsubscribed"].map(s => (
            <button key={s} onClick={() => setStatus(s)} style={{ ...btn(status === s ? C.ink : C.surface, status === s ? "#fff" : C.inkMid), padding: "6px 11px", fontSize: 11.5, textTransform: "capitalize" }}>{s}</button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={() => setEdit({ ...BLANK })} style={btn(C.green, "#fff")}>+ Add subscriber</button>
        <button onClick={exportAll} disabled={!!exporting} style={btn()}>{exporting || "⬇ Export CSV"}</button>
        <button onClick={() => load("", status)} disabled={loading} style={btn()}>{loading ? "Loading…" : "↻"}</button>
      </div>

      {err && <div style={{ ...card, borderColor: C.red, background: C.redBg, color: C.red, padding: "10px 13px", fontSize: 12.5, marginBottom: 12 }}>{err}</div>}

      {edit && (
        <div style={{ ...card, padding: 16, marginBottom: 14, borderColor: C.gold }}>
          <div style={{ fontSize: 14, fontWeight: 850, color: C.ink, marginBottom: 12 }}>{edit.contactId ? "Edit subscriber" : "Add subscriber"}</div>
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
                <tr key={c.id}>
                  <td style={{ ...td, fontWeight: 700 }}>{c.email || "—"}</td>
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
                  <td style={{ ...td, color: C.inkMid, whiteSpace: "nowrap" }}>{fmtDate(c.createdAt)}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button onClick={() => setEdit({
                      contactId: c.id, email: c.email, firstName: c.firstName, lastName: c.lastName,
                      country: c.country, city: c.city, tags: (c.tags || []).join(", "),
                      status: c.status === "unsubscribed" ? "unsubscribed" : "subscribed",
                    })} style={{ ...btn(), padding: "5px 10px", fontSize: 11 }}>Edit</button>
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
