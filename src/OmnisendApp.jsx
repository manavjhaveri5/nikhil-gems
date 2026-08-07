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

  const TABS = [["campaigns", "📣", "Campaigns"], ["subscribers", "👥", "Subscribers"]];

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
        {configured && tab === "subscribers" && <SubscribersTab showToast={showToast} />}
      </div>

      {composerOpen && <CampaignComposer listings={listings} showToast={showToast} onClose={() => setComposerOpen(false)} />}
    </div>
  );
}

/* ── Campaigns ─────────────────────────────────────────────────────────────── */
function CampaignsTab({ showToast }) {
  const [rows, setRows] = useState([]);
  const [after, setAfter] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");

  const load = useCallback(async (cursor = "") => {
    setLoading(true); setErr("");
    try {
      const d = await api({ action: "campaigns", limit: 100, ...(cursor ? { after: cursor } : {}) });
      setRows(prev => cursor ? [...prev, ...(d.campaigns || [])] : (d.campaigns || []));
      setAfter(d.after || ""); setHasMore(!!d.hasMore);
    } catch (e) { setErr(e.message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const ql = q.trim().toLowerCase();
  const shown = rows.filter(c =>
    (status === "all" || String(c.status).toLowerCase() === status) &&
    (!ql || `${c.name} ${c.subject} ${c.senderName}`.toLowerCase().includes(ql)));

  const statuses = ["all", ...[...new Set(rows.map(r => String(r.status || "").toLowerCase()).filter(Boolean))]];

  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, subject or sender…" style={{ ...FI(), maxWidth: 320 }} />
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {statuses.map(s => (
            <button key={s} onClick={() => setStatus(s)} style={{
              ...btn(status === s ? C.ink : C.surface, status === s ? "#fff" : C.inkMid),
              padding: "6px 12px", fontSize: 11.5, textTransform: "capitalize",
            }}>{s}{s === "all" ? ` ${rows.length}` : ""}</button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={() => load()} disabled={loading} style={btn()}>{loading ? "Loading…" : "↻ Refresh"}</button>
        <button
          onClick={() => downloadCsv(`omnisend-campaigns-${new Date().toISOString().slice(0, 10)}.csv`,
            [["Name", "Subject", "Status", "Sender", "Sender email", "Created", "Sent"],
             ...shown.map(c => [c.name, c.subject, c.status, c.senderName, c.senderEmail, c.createdAt, c.sentAt])])}
          disabled={!shown.length} style={btn()}>⬇ CSV</button>
      </div>

      {err && <div style={{ ...card, borderColor: C.red, background: C.redBg, color: C.red, padding: "10px 13px", fontSize: 12.5, marginBottom: 12 }}>{err}</div>}

      {!loading && !shown.length && !err && (
        <div style={{ ...card, padding: 40, textAlign: "center", color: C.inkFaint, fontSize: 13 }}>
          {rows.length ? "No campaigns match that filter." : "No campaigns in this Omnisend account yet."}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {shown.map(c => (
          <div key={c.id}>
            <div onClick={() => setOpen(open === c.id ? null : c.id)}
              style={{ ...card, padding: mob() ? "11px 12px" : "13px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", borderLeft: `4px solid ${(STATUS_TONE[String(c.status).toLowerCase()] || [C.border])[0]}` }}>
              <div style={{ minWidth: 0, flex: "1 1 300px" }}>
                <div style={{ fontSize: 13.5, fontWeight: 800, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</div>
                <div style={{ fontSize: 11.5, color: C.inkMid, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.subject || "(no subject)"}</div>
              </div>
              <div style={{ fontSize: 11, color: C.inkFaint, whiteSpace: "nowrap" }}>{c.senderName || "—"}</div>
              <div style={{ fontSize: 11, color: C.inkFaint, whiteSpace: "nowrap", minWidth: 120, textAlign: "right" }}>
                {c.sentAt ? `Sent ${fmtDate(c.sentAt)}` : `Created ${fmtDate(c.createdAt)}`}
              </div>
              <Pill>{c.status}</Pill>
            </div>
            {open === c.id && (
              <div style={{ ...card, marginTop: -2, borderTop: "none", borderRadius: "0 0 12px 12px", padding: "14px 16px", background: C.card }}>
                <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "repeat(auto-fit,minmax(200px,1fr))", gap: 12 }}>
                  {[["Subject", c.subject], ["Preheader", c.preheader], ["Sender", c.senderName],
                    ["Sender email", c.senderEmail], ["Type", `${c.type || "—"}${c.channel ? ` · ${c.channel}` : ""}`],
                    ["Audience", c.segmentIds?.length ? `${c.segmentIds.length} segment${c.segmentIds.length > 1 ? "s" : ""}` : "All subscribers"],
                    ["Created", fmtDateTime(c.createdAt)], ["Sent", fmtDateTime(c.sentAt)]].map(([k, v]) => (
                    <div key={k}>
                      <span style={lab}>{k}</span>
                      <div style={{ fontSize: 12.5, color: C.ink, wordBreak: "break-word" }}>{v || "—"}</div>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}`, fontSize: 11, color: C.inkFaint, lineHeight: 1.6 }}>
                  Open and click rates aren't exposed by Omnisend's campaign API — see the campaign in Omnisend for reporting.
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {hasMore && (
        <div style={{ textAlign: "center", marginTop: 14 }}>
          <button onClick={() => load(after)} disabled={loading} style={btn()}>{loading ? "Loading…" : "Load more"}</button>
        </div>
      )}
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
