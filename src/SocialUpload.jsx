/* Social → upload a finished video (e.g. a Reel saved from Instagram with its
   song) and send that exact file on: TikTok as a draft (finish and post it in
   the TikTok app) and YouTube as a Short. The caption can be taken from one of
   the recent Instagram posts. The file goes to the ERP's storage first (over
   50 MB → a 1080p copy, as for listing videos), then each platform pulls it. */
import { useState, useEffect } from "react";
import { C, FI } from "./lmTheme.js";

const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 16px" };
const btn = (bg = C.surface, fg = C.ink) => ({ background: bg, color: fg, border: bg === C.surface ? `1px solid ${C.border}` : "none", borderRadius: 8, padding: "7px 13px", fontSize: 13, fontWeight: 650, cursor: "pointer", fontFamily: "inherit" });
const lab = { fontSize: 10, fontWeight: 800, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .7, margin: "12px 0 5px", display: "block" };
const api = async (action, { p, body } = {}) => {
  const r = await fetch(`/api/social?action=${action}${p ? `&p=${p}` : ""}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, p }) } : {});
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Failed (${r.status})`);
  return d;
};
const TARGETS = [["tiktok", "🎵 TikTok", "as a draft — open TikTok to post it"], ["youtube", "▶️ YouTube Shorts", "posted publicly"]];

export default function SocialUpload({ st, showToast }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState("");
  const [url, setUrl] = useState("");
  const [step, setStep] = useState("");
  const [err, setErr] = useState("");
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [ig, setIg] = useState([]);
  const [on, setOn] = useState({ tiktok: true, youtube: true });
  const [res, setRes] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (st?.instagram?.connected) api("instagram_media").then(d => setIg((d.media || []).slice(0, 8))).catch(() => {}); }, [st?.instagram?.connected]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const choose = async f => {
    if (!f) return;
    setErr(""); setRes({}); setUrl(""); setFile(f); setPreview(URL.createObjectURL(f));
    try {
      const { uploadToStorage } = await import("./storageUtils.js");
      let up = f;
      if (f.size > 50 * 1024 * 1024) {
        const { fitVideoForStorage } = await import("./videoLab.js");
        up = await fitVideoForStorage(f, { onProgress: p => setStep(`Making a 1080p copy (over 50 MB)… ${Math.round(p * 100)}%`) });
      }
      const ext = (up.name.split(".").pop() || "mp4").toLowerCase();
      setStep("Uploading… 0%");
      const u = await uploadToStorage(`social-uploads/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.${ext}`, up, { onProgress: p => setStep(`Uploading… ${Math.round((p > 1 ? p / 100 : p) * 100)}%`) });
      setUrl(u); setStep("");
    } catch (e) { setErr(e.message || String(e)); setStep(""); }
  };
  const useCaption = id => {
    const m = ig.find(x => x.id === id);
    if (!m) return;
    setText(m.caption || "");
    setTitle((m.caption || "").split("\n")[0].replace(/#\S+/g, "").trim().slice(0, 90));
  };
  const send = async () => {
    const list = TARGETS.filter(([k]) => on[k] && st?.[k]?.connected);
    if (!url || !list.length) return;
    setBusy(true);
    for (const [k] of list) {
      setRes(r => ({ ...r, [k]: { busy: true } }));
      try {
        const d = await api("post", { p: k, body: { video: url, text, title: title || text.split("\n")[0].slice(0, 90), mode: k === "tiktok" ? "draft" : "", source: "upload" } });
        setRes(r => ({ ...r, [k]: { ok: true, url: d.url, note: d.note } }));
      } catch (e) { setRes(r => ({ ...r, [k]: { error: e.message } })); }
    }
    setBusy(false);
    showToast("Done — see each platform below");
  };

  return (
    <div style={card}>
      <b style={{ fontSize: 15 }}>📤 Upload a finished video</b>
      <div style={{ fontSize: 12.5, color: C.inkMid, marginTop: 3 }}>Save your Reel from Instagram (with its song) and upload it here — the same file goes to TikTok as a draft and to YouTube Shorts.</div>

      <label style={{ ...btn(), display: "inline-block", marginTop: 10 }}>
        {file ? "Choose another video" : "Choose video…"}
        <input type="file" accept="video/*" style={{ display: "none" }} onChange={e => choose(e.target.files?.[0])} />
      </label>
      {file && <span style={{ fontSize: 12, color: C.inkFaint, marginLeft: 8 }}>{file.name} · {Math.round(file.size / 1048576)} MB</span>}
      {step && <div style={{ fontSize: 12.5, color: C.inkMid, marginTop: 6 }}>{step}</div>}
      {err && <div style={{ fontSize: 12.5, color: C.red, marginTop: 6 }}>⚠ {err}</div>}
      {preview && <video src={preview} controls playsInline style={{ display: "block", marginTop: 10, maxHeight: 320, maxWidth: "100%", borderRadius: 10, background: "#000" }} />}

      {file && <>
        <span style={lab}>Caption</span>
        {ig.length > 0 && <select defaultValue="" onChange={e => useCaption(e.target.value)} style={FI({ marginBottom: 6, fontSize: 13 })}>
          <option value="" disabled>Use the caption from an Instagram post…</option>
          {ig.map(m => <option key={m.id} value={m.id}>{new Date(m.timestamp).toLocaleDateString()} · {(m.caption || "No caption").split("\n")[0].slice(0, 70)}</option>)}
        </select>}
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="YouTube title" style={FI({ marginBottom: 6, fontWeight: 600 })} />
        <textarea value={text} onChange={e => setText(e.target.value)} rows={5} placeholder="Caption" style={FI({ fontSize: 13, lineHeight: 1.5, resize: "vertical" })} />

        <span style={lab}>Send to</span>
        {TARGETS.map(([k, label, hint]) => {
          const ok = st?.[k]?.connected, r = res[k];
          return (
            <div key={k} style={{ padding: "4px 0" }}>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, fontWeight: 650, cursor: ok ? "pointer" : "default", opacity: ok ? 1 : .5 }}>
                <input type="checkbox" disabled={!ok} checked={!!on[k] && ok} onChange={e => setOn(o => ({ ...o, [k]: e.target.checked }))} />
                {label} <span style={{ fontWeight: 400, fontSize: 12, color: C.inkFaint }}>{ok ? hint : "not connected"}</span>
              </label>
              {r && <div style={{ fontSize: 12.5, marginLeft: 24, color: r.error ? C.red : r.busy ? C.inkMid : C.green }}>
                {r.busy ? "Sending…" : r.error ? `⚠ ${r.error}` : <>✓ {r.note || (k === "tiktok" ? "Sent to your TikTok drafts" : "Posted")} {r.url && <a href={r.url} target="_blank" rel="noreferrer">View ↗</a>}</>}</div>}
            </div>);
        })}
        <div style={{ fontSize: 11.5, color: C.inkFaint, margin: "6px 0 10px" }}>A song licensed on Instagram can be claimed on YouTube or muted on TikTok — if that happens, the video stays up without it.</div>
        <button disabled={!url || busy || !TARGETS.some(([k]) => on[k] && st?.[k]?.connected)} onClick={send}
          style={{ ...btn(C.ink, "#FAF0DC"), width: "100%", padding: 12, fontSize: 15, opacity: !url || busy ? .5 : 1 }}>
          {busy ? "Sending…" : !url ? (step ? "Uploading…" : "Upload a video first") : `Send to ${TARGETS.filter(([k]) => on[k] && st?.[k]?.connected).map(([, l]) => l.split(" ").slice(1).join(" ")).join(" + ")}`}</button>
      </>}
    </div>
  );
}
