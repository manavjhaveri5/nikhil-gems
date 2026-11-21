/* The weekly "new pieces" email (lib/weekly.js), on the Gmail list tab: who's
   joined and from where, this week's issue with Approve / Skip / Rebuild, the
   approve-or-auto choice, and the parcel card with its sign-up QR code. */
import { useState, useEffect, useCallback } from "react";
import QRCode from "qrcode";
import { C, FI } from "./lmTheme.js";
import { mailApi } from "./GmailSend.jsx";

const JOIN = "https://studio.eartheditions.co/join";
const STATE = { awaiting: "waiting for your OK", approved: "approved", sent: "sent ✓", skipped: "skipped" };
const DAY = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const fmt = v => v ? new Date(v).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "—";

async function printCard(src) {
  const url = `${JOIN}?s=${src}`;
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 600, color: { dark: "#1a1308", light: "#ffffff" } });
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(`<!doctype html><html><head><title>Parcel card</title><style>
@page{size:A6;margin:0}body{margin:0;font-family:Georgia,serif;color:#1a1308}
.c{width:105mm;height:148mm;box-sizing:border-box;padding:12mm 10mm;display:flex;flex-direction:column;align-items:center;text-align:center}
h1{font-weight:normal;font-size:20pt;margin:6mm 0 3mm}p{font-size:10.5pt;line-height:1.5;margin:0 0 4mm;color:#4a4033}
img{width:46mm;height:46mm;margin:3mm 0}small{font-size:8pt;color:#8a7f6d}</style></head><body><div class="c">
<div style="font-size:16pt;letter-spacing:3px;font-weight:700">EARTH</div><div style="font-size:7pt;letter-spacing:4px;color:#8a7f6d">EDITIONS</div>
<h1>Thank you</h1><p>Every stone we send is chosen by hand in our studio in India. We hope this one finds a good home with you.</p>
<p>Want to see new pieces first? Scan to join our weekly email.</p><img src="${qr}" alt="QR code"><small>${url.replace("https://", "")}</small>
</div><script>onload=()=>setTimeout(()=>print(),300)</script></body></html>`);
  w.document.close();
}

export default function WeeklyCard({ card, small, showToast }) {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [approver, setApprover] = useState("");
  const load = useCallback(() => mailApi({ action: "gmail_weekly_get" }).then(x => { setD(x); setApprover(x.settings.approver); }).catch(e => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const act = async (name, payload, done) => {
    setBusy(name); setErr("");
    try { await mailApi(payload); showToast?.(done); await load(); } catch (e) { setErr(e.message); } finally { setBusy(""); }
  };
  if (!d) return <div style={card}><div style={{ fontSize: 14, fontWeight: 700 }}>Weekly new pieces</div><div style={{ fontSize: 12, color: err ? C.red : C.inkFaint }}>{err || "Loading…"}</div></div>;
  const s = d.settings, w = d.current, src = Object.entries(d.stats.bySrc || {});
  const pill = (on, label, onClick) => <button onClick={onClick} disabled={!!busy} style={{ ...small, background: on ? C.ink : C.card, color: on ? C.surface : C.ink }}>{label}</button>;

  return (
    <div style={card}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Weekly new pieces</div>
        <div style={{ fontSize: 11.5, color: C.inkFaint }}>built {DAY[s.buildDow]} {s.buildAt} · sent {DAY[s.sendDow]} {s.sendAt} IST · pieces listed in the last {s.days} days</div>
      </div>
      <div style={{ fontSize: 12.5, color: C.inkMid, margin: "8px 0 12px", lineHeight: 1.6 }}>
        <strong>{d.stats.audience}</strong> on the list{src.length ? ` (${src.map(([k, n]) => `${k} ${n}`).join(" · ")})` : ""}{d.stats.pending ? ` · ${d.stats.pending} haven't confirmed yet` : ""}.
        {" "}Only people who joined themselves. Etsy and eBay order emails are never added (Etsy Seller Policy 2b).
      </div>

      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700 }}>{d.week}: {w ? (w.subject || w.why || "—") : `not built yet (builds ${DAY[s.buildDow]} ${s.buildAt})`}</div>
        {w && <div style={{ fontSize: 12, color: C.inkMid, marginTop: 4 }}>
          {STATE[w.state] || w.state}{w.pieceCount ? ` · ${w.pieceCount} pieces` : ""}{w.audience ? ` · ${w.audience} people` : ""}{w.sendAfter ? ` · goes ${fmt(w.sendAfter)}` : ""}
          {w.approvedAt ? ` · approved ${fmt(w.approvedAt)} (${w.approvedVia})` : ""}{w.sentAt ? ` · sent ${w.sent}` : ""}
        </div>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
          {w?.state === "awaiting" && <button disabled={!!busy} onClick={() => act("ok", { action: "gmail_weekly_decide", week: d.week, act: "approve" }, "✓ Approved")} style={{ ...small, background: C.green, color: "#fff" }}>Approve and send</button>}
          {w && ["awaiting", "approved"].includes(w.state) && <button disabled={!!busy} onClick={() => window.confirm("Skip this week's email?") && act("skip", { action: "gmail_weekly_decide", week: d.week, act: "skip" }, "Skipped")} style={small}>Skip this week</button>}
          {w?.state !== "sent" && <button disabled={!!busy} onClick={() => window.confirm(`Build this week's issue now from the latest pieces and send a [Test] copy to ${s.approver}?`) && act("build", { action: "gmail_weekly_build" }, `✓ Built, test sent to ${s.approver}`)} style={small}>{busy === "build" ? "Building…" : w ? "↻ Rebuild + test" : "Build now + test"}</button>}
        </div>
      </div>

      <div style={{ display: "grid", gap: 8, fontSize: 12 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ color: C.inkMid, minWidth: 90 }}>Each week</span>
          {pill(s.mode === "approve", "Waits for my OK", () => act("mode", { action: "gmail_weekly_set", settings: { mode: "approve" } }, "Each week now waits for your OK"))}
          {pill(s.mode === "auto", "Sends by itself", () => window.confirm("Send every week's issue by itself, without waiting for approval? A [Test] copy still comes to you first.") && act("mode", { action: "gmail_weekly_set", settings: { mode: "auto" } }, "Each week now sends by itself"))}
          {pill(s.paused, s.paused ? "Paused ▸ resume" : "Pause", () => act("pause", { action: "gmail_weekly_set", settings: { paused: !s.paused } }, s.paused ? "Resumed" : "Paused"))}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ color: C.inkMid, minWidth: 90 }}>Test + approve to</span>
          <input value={approver} onChange={e => setApprover(e.target.value)} style={{ ...FI(), maxWidth: 260, padding: "5px 8px", fontSize: 12 }} />
          {approver !== s.approver && <button disabled={!!busy} onClick={() => act("appr", { action: "gmail_weekly_set", settings: { approver } }, "Saved")} style={small}>Save</button>}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ color: C.inkMid, minWidth: 90 }}>Sign-up links</span>
          {["etsy-card", "ebay-card", "etsy", "store"].map(k => <button key={k} onClick={() => navigator.clipboard?.writeText(`${JOIN}?s=${k}`).then(() => showToast?.(`Copied ${JOIN}?s=${k}`))} style={small}>⧉ {k}</button>)}
          <button onClick={() => printCard("etsy-card")} style={small}>🖨 Etsy parcel card</button>
          <button onClick={() => printCard("ebay-card")} style={small}>🖨 eBay parcel card</button>
        </div>
      </div>
      {err && <div style={{ fontSize: 12, color: C.red, marginTop: 8 }}>{err}</div>}
    </div>
  );
}
