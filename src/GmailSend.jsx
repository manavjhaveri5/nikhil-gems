/* Campaigns from our own Gmail (team@eartheditions.co), the free alternative to
   Omnisend. The server side is lib/mailList.js: one email per person, with
   unsubscribe headers, sent through the Gmail bridge a small batch at a time.
   This page paces the batches, so it must stay open while a send runs; a send
   that stops (page closed, daily limit) resumes from the Gmail list tab. */
import { useState, useEffect, useRef } from "react";
import { C, FI, mob } from "./lmTheme.js";

export const mailApi = async payload => {
  const r = await fetch("/api/mail", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d.error || `Request failed (${r.status})`);
  return d;
};
const sleep = ms => new Promise(ok => setTimeout(ok, ms));
const GAP = 20_000; // between batches of 12: a 400-person list takes ~12 minutes

/* Runs a send batch by batch until it finishes, pauses or is stopped. */
export function useGmailRunner({ onProgress, onDone, onError }) {
  const [running, setRunning] = useState("");
  const stop = useRef(false);
  useEffect(() => () => { stop.current = true; }, []);
  useEffect(() => {
    if (!running) return;
    const warn = e => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);
  const run = async id => {
    stop.current = false; setRunning(id);
    try {
      for (;;) {
        const p = await mailApi({ action: "gmail_campaign_batch", id, start: true });
        onProgress?.(p);
        if (["done", "paused", "cancelled"].includes(p.status)) { if (p.status === "done") onDone?.(id, p); break; }
        if (stop.current) { onProgress?.(await mailApi({ action: "gmail_campaign_status", id, status: "paused" })); break; }
        await sleep(p.busy ? 15_000 : GAP);
        if (stop.current) { onProgress?.(await mailApi({ action: "gmail_campaign_status", id, status: "paused" })); break; }
      }
    } catch (e) { onError?.(e); }
    finally { setRunning(""); }
  };
  return { running, run, stop: () => { stop.current = true; } };
}

export function ProgressBar({ p }) {
  if (!p) return null;
  const done = p.sent + p.failed + p.skipped, pct = p.total ? Math.round(done / p.total * 100) : 0;
  return (
    <div style={{ display: "grid", gap: 5 }}>
      <div style={{ height: 8, background: C.card, borderRadius: 5, overflow: "hidden", border: `1px solid ${C.border}` }}>
        <div style={{ width: `${pct}%`, height: "100%", background: p.status === "paused" ? C.amber : C.teal, transition: "width .4s" }} />
      </div>
      <div style={{ fontSize: 11.5, color: C.inkMid }}>
        {p.sent} of {p.total} sent{p.failed ? ` · ${p.failed} failed` : ""}{p.skipped ? ` · ${p.skipped} skipped (unsubscribed since)` : ""}
        {p.status === "done" ? " · finished ✓" : p.status === "paused" ? ` · paused${p.pausedWhy ? ` — ${p.pausedWhy}` : ""}` : ""}
      </div>
    </div>
  );
}

const tagLabel = t => t.startsWith("seg:") ? `${t.slice(4)} (Omnisend segment)` : t;

export default function GmailSend({ payload, subject, preheader, senderName, draftId, testTo, setTestTo, onDone, showToast, ready }) {
  const [summary, setSummary] = useState(null);
  const [tags, setTags] = useState(() => new Set());
  const [count, setCount] = useState(null);
  const [sendId, setSendId] = useState("");
  const [sig, setSig] = useState("");
  const [tested, setTested] = useState(false);
  const [prog, setProg] = useState(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const m = mob();

  useEffect(() => {
    mailApi({ action: "gmail_list_summary" }).then(s => {
      setSummary(s);
      if (s.tags?.["seg:active"]) setTags(new Set(["seg:active"]));
    }).catch(e => setErr(e.message));
  }, []);
  useEffect(() => {
    if (!summary) return;
    mailApi({ action: "gmail_campaign_audience", tags: [...tags] }).then(d => setCount(d.count)).catch(() => setCount(null));
  }, [summary, tags]);

  const nowSig = JSON.stringify([payload(), subject, preheader, senderName, [...tags].sort()]);
  const stale = sendId && sig !== nowSig && !prog;
  const { running, run, stop } = useGmailRunner({
    onProgress: setProg,
    onDone: id => { showToast?.("📬 Sent from Gmail"); onDone?.(id); },
    onError: e => setErr(e.message),
  });

  const create = async () => {
    setBusy("create"); setErr("");
    try {
      const d = await mailApi({ action: "gmail_campaign_create", ...payload(), subject, preheader, senderName, tags: [...tags], draftId });
      setSendId(d.id); setSig(nowSig); setTested(false); setProg(null);
      showToast?.(`✓ Ready for ${d.total} people — send yourself a test`);
    } catch (e) { setErr(e.message); } finally { setBusy(""); }
  };
  const test = async () => {
    setBusy("test"); setErr("");
    try { await mailApi({ action: "gmail_campaign_test", id: sendId, to: testTo }); setTested(true); showToast?.(`✓ Gmail test sent to ${testTo}`); }
    catch (e) { setErr(e.message); } finally { setBusy(""); }
  };
  const send = async () => {
    const n = count ?? "the list";
    if (!window.confirm(`Send "${subject}" from ${summary?.from || "Gmail"} to ${n} people?\n\nOne email each, a batch every 20 seconds. Keep this window open until it finishes (pausing is safe — it resumes from the Gmail list tab).`)) return;
    if (window.prompt("Type SEND to confirm:") !== "SEND") { showToast?.("Cancelled — nothing sent"); return; }
    setErr(""); run(sendId);
  };

  const pill = on => ({ background: on ? C.teal : C.card, color: on ? "#fff" : C.ink, border: `1px solid ${on ? C.teal : C.border}`, borderRadius: 20, padding: "5px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer" });
  const btn = (bg, fg, bd, on = true) => ({ background: on ? bg : C.card, color: on ? fg : C.inkFaint, border: `1px solid ${on ? bd : C.border}`, borderRadius: 9, padding: "10px 16px", fontSize: 12.5, fontWeight: 700, cursor: on ? "pointer" : "not-allowed" });
  const tagList = Object.entries(summary?.tags || {}).sort((a, b) => b[1] - a[1]).slice(0, 24);

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: m ? 11 : 14, display: "grid", gap: 10 }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 700 }}>📬 Or send from our Gmail <span style={{ fontWeight: 400, color: C.inkFaint }}>— {summary?.from || "team@eartheditions.co"}, free</span></div>
        <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 3, lineHeight: 1.5 }}>
          One email per person from the real mailbox, so replies come back to it. Unsubscribes and bounces are taken off the list automatically.
          {summary && <> List: {summary.counts.subscribed} subscribed{summary.counts.unsubscribed ? ` · ${summary.counts.unsubscribed} unsubscribed` : ""}{summary.counts.bounced ? ` · ${summary.counts.bounced} bounced` : ""}.</>}
          {summary && !summary.total && <strong style={{ color: C.amber }}> The list is empty — import it from Omnisend on the Gmail list tab first.</strong>}
        </div>
      </div>

      {tagList.length > 0 && (
        <div>
          <div style={{ fontSize: 9.5, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 4 }}>
            Audience — anyone with {tags.size ? "any of these" : "no tag picked: every subscribed contact"}{count != null ? ` · ${count} people` : ""}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {tagList.map(([t, n]) => <button key={t} type="button" disabled={!!running} onClick={() => setTags(p => { const s = new Set(p); s.has(t) ? s.delete(t) : s.add(t); return s; })} style={pill(tags.has(t))}>{tagLabel(t)} · {n}</button>)}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={create} disabled={!ready || !!busy || !!running || !count} style={btn(C.ink, "#FAF0DC", C.ink, ready && !!count && !running)}>
          {busy === "create" ? "Preparing…" : sendId && !stale ? "Prepared ✓ — prepare again" : stale ? "Edited — prepare again" : `Prepare for ${count ?? "…"} people`}
        </button>
        {sendId && !stale && <>
          <input value={testTo} onChange={e => setTestTo(e.target.value)} placeholder="you@example.com" style={{ ...FI(), width: m ? "100%" : 190 }} />
          <button onClick={test} disabled={!testTo || !!busy || !!running} style={btn(C.tealBg, C.teal, C.teal, !!testTo && !running)}>{busy === "test" ? "Sending…" : "Send Gmail test"}</button>
          <div style={{ flex: 1 }} />
          {running
            ? <button onClick={stop} style={btn(C.amberBg, C.amber, C.amber)}>Pause</button>
            : prog?.status !== "done" && <button onClick={send} disabled={!tested || !!busy} title={tested ? "" : "Send yourself a test first"} style={btn(C.red, "#fff", C.red, tested)}>{prog?.status === "paused" ? "Resume →" : `Send from Gmail to ${count ?? "…"} →`}</button>}
        </>}
      </div>
      {prog && <ProgressBar p={prog} />}
      {running && <div style={{ fontSize: 11, color: C.amber }}>Sending — keep this window open. Closing it pauses the send; resume it from the Gmail list tab.</div>}
      {err && <div style={{ fontSize: 12, color: C.red }}>{err}</div>}
    </div>
  );
}
