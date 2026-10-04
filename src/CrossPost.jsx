/* Instagram → TikTok. Connect both accounts once; then each recent Reel can be
   sent to TikTok — as a draft in the TikTok app's inbox (finish and post it
   there, caption already copied), or posted straight away. The server side
   is api/social.js; what was sent is remembered, so nothing goes twice by
   accident. */
import { useState, useEffect, useCallback } from "react";
import { C } from "./lmTheme.js";

const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12 };
const btn = (bg = C.surface, fg = C.ink) => ({ background: bg, color: fg, border: bg === C.surface ? `1px solid ${C.border}` : "none", borderRadius: 7, padding: "6px 12px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" });
const api = async (action, { p, body, q = "" } = {}) => {
  const r = await fetch(`/api/social?action=${action}${p ? `&p=${p}` : ""}${q}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Failed (${r.status})`);
  return d;
};
const ago = t => { const m = (Date.now() - Date.parse(t)) / 6e4; return m < 60 ? `${Math.round(m)}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };

export default function CrossPost({ showToast }) {
  const [st, setSt] = useState(null);
  const [reels, setReels] = useState(null);
  const [busy, setBusy] = useState({});
  const [err, setErr] = useState("");
  const [help, setHelp] = useState(false);

  const load = useCallback(async () => {
    setErr("");
    try {
      const s = await api("status"); setSt(s);
      if (s.instagram) setReels((await api("reels")).reels);
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const connect = async p => { try { location.href = (await api("start", { p })).url; } catch (e) { showToast?.(`⚠ ${e.message}`); } };
  const disconnect = async p => { if (!confirm(`Disconnect ${p === "tiktok" ? "TikTok" : "Instagram"}?`)) return; await api("disconnect", { p }); load(); };
  const send = async (m, mode) => {
    if (mode === "post" && !confirm("Post this to TikTok now, with its Instagram caption?")) return;
    setBusy(b => ({ ...b, [m.id]: mode }));
    // The draft's caption goes on in the TikTok app — copied now, ready to paste.
    if (mode === "draft" && m.caption) { try { await navigator.clipboard.writeText(m.caption); } catch { /* not allowed */ } }
    try {
      const d = await api("send", { body: { id: m.id, mode } });
      setReels(rs => rs.map(x => x.id === m.id ? { ...x, sent: d } : x));
      showToast?.(mode === "draft" ? "✓ In your TikTok inbox — open TikTok, finish and post it (caption copied)" : `✓ Posted to TikTok${d.privacy === "SELF_ONLY" ? " — private until TikTok approves the app" : ""}`);
    } catch (e) { showToast?.(`⚠ ${e.message}`); }
    setBusy(b => ({ ...b, [m.id]: "" }));
  };

  const ready = st?.instagram && st?.tiktok;
  return (
    <div style={{ ...card, padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <div style={{ flex: 1 }}>
          <b style={{ fontSize: 15 }}>Instagram → TikTok</b>
          <div style={{ fontSize: 12, color: C.inkFaint }}>Your recent Reels, each one tap from TikTok. Free, on Instagram's and TikTok's own APIs.</div>
        </div>
        <button onClick={load} style={btn()}>↻</button>
      </div>

      {err && <div style={{ fontSize: 12.5, color: C.red, marginBottom: 8 }}>⚠ {err}</div>}

      {st && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          {[["instagram", "Instagram", st.instagram && `@${st.instagram.username}`], ["tiktok", "TikTok", st.tiktok && (st.tiktok.name || "connected")]].map(([p, label, who]) => (
            <div key={p} style={{ display: "flex", alignItems: "center", gap: 8, border: `1px solid ${who ? C.green + "60" : C.border}`, borderRadius: 9, padding: "7px 10px", background: who ? C.greenBg : "transparent" }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{label}</span>
              {who
                ? <><span style={{ fontSize: 12, color: C.green }}>✓ {who}</span><button onClick={() => disconnect(p)} style={{ ...btn(), padding: "3px 8px", fontSize: 11 }}>Disconnect</button></>
                : st.setup[p]
                  ? <button onClick={() => connect(p)} style={btn(C.ink, "#FAF0DC")}>Connect</button>
                  : <span style={{ fontSize: 12, color: C.inkFaint }}>needs setting up first</span>}
            </div>
          ))}
          {(!st.setup.instagram || !st.setup.tiktok) && <button onClick={() => setHelp(h => !h)} style={btn()}>How to set up</button>}
        </div>
      )}

      {help && st && (
        <div style={{ fontSize: 12.5, color: C.inkMid, background: C.card, borderRadius: 9, padding: 12, marginBottom: 10, lineHeight: 1.6 }}>
          <b>Once, about 20 minutes.</b> Instagram must be a Business or Creator account.
          <ol style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            <li><b>Instagram:</b> developers.facebook.com → Create app → Business → add <i>Instagram</i> → "API setup with Instagram login". Add your Instagram account as a tester; under Business login settings put this redirect URL:<br /><code style={{ wordBreak: "break-all" }}>{st.redirect.instagram}</code><br />Copy the Instagram app ID and secret.</li>
            <li><b>TikTok:</b> developers.tiktok.com → Manage apps → Connect an app. Add <i>Login Kit</i> (redirect URL below) and <i>Content Posting API</i> (turn on Direct Post). Scopes: user.info.basic, video.upload, video.publish.<br /><code style={{ wordBreak: "break-all" }}>{st.redirect.tiktok}</code><br />Add your TikTok account as a sandbox / target user, then copy the client key and secret.</li>
            <li><b>Vercel</b> → Settings → Environment Variables: <code>IG_APP_ID</code>, <code>IG_APP_SECRET</code>, <code>TIKTOK_CLIENT_KEY</code>, <code>TIKTOK_CLIENT_SECRET</code> → redeploy. Then tap Connect on each here.</li>
          </ol>
          <div style={{ marginTop: 6 }}>Until TikTok reviews the app, <i>Post now</i> posts privately (only you see it) — <i>Send as draft</i> works fully: it lands in TikTok's inbox and you post it publicly from there.</div>
        </div>
      )}

      {st?.instagram && !reels && !err && <div style={{ fontSize: 13, color: C.inkFaint }}>Loading Reels…</div>}
      {reels && !reels.length && <div style={{ fontSize: 13, color: C.inkFaint }}>No Reels in the account's recent posts.</div>}
      {reels?.length > 0 && (
        <div style={{ display: "grid", gap: 8 }}>
          {reels.map(m => (
            <div key={m.id} style={{ display: "flex", gap: 10, alignItems: "center", borderTop: `1px solid ${C.border}`, paddingTop: 8 }}>
              <a href={m.permalink} target="_blank" rel="noreferrer" style={{ flex: "none" }}>
                <img src={m.thumbnail_url} alt="" style={{ width: 54, height: 72, objectFit: "cover", borderRadius: 7, background: C.card }} />
              </a>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, color: C.ink, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{m.caption || <i style={{ color: C.inkFaint }}>No caption</i>}</div>
                <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 2 }}>
                  {ago(m.timestamp)}
                  {m.sent && <span style={{ color: C.green, fontWeight: 700 }}> · ✓ {m.sent.mode === "post" ? "posted" : "sent as draft"} {ago(m.sent.at)}</span>}
                </div>
              </div>
              {ready && (
                <div style={{ display: "flex", flexDirection: "column", gap: 5, flex: "none" }}>
                  <button disabled={!!busy[m.id]} onClick={() => send(m, "draft")} style={{ ...btn(m.sent ? C.surface : C.ink, m.sent ? C.ink : "#FAF0DC"), opacity: busy[m.id] ? .6 : 1 }}>
                    {busy[m.id] === "draft" ? "Sending…" : m.sent ? "Send again" : "Send as draft"}</button>
                  {st.tiktok.canPost && <button disabled={!!busy[m.id]} onClick={() => send(m, "post")} style={{ ...btn(), opacity: busy[m.id] ? .6 : 1 }}>{busy[m.id] === "post" ? "Posting…" : "Post now"}</button>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
