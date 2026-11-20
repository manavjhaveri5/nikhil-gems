/* Lots for the mailing list: offers that aren't pieces in stock — a parcel
   of rough, a box of points — shown by video. A lot is a YouTube link
   (unlisted) plus what a buyer needs to decide: weight, pieces, price.

   Email can't play video, so the card is the video's frame with a ▶ drawn on
   it, linking to the video on YouTube. The frame is made here in the browser
   and stored as a small JPEG; the video itself is never stored by the ERP, so
   a big send costs no bandwidth of ours.

   Lots are kept in app_data (ng-campaign-lots-v1) so one can go out again,
   and a send stamps the lots it carried, like listings. */
import { useState, lazy, Suspense } from "react";
const VideoEditor = lazy(() => import("./VideoEditor.jsx"));
import { C, FI } from "./lmTheme.js";
import { loadKFresh, saveK, uid } from "./utils.js";
import { uploadToStorage } from "./storageUtils.js";

export const LOTS_KEY = "ng-campaign-lots-v1";
export const loadLots = () => loadKFresh(LOTS_KEY).then(v => (Array.isArray(v) ? v : [])).catch(() => []);
export const saveLots = list => saveK(LOTS_KEY, list, { merge: false });

export function youtubeId(url) {
  const s = String(url || "").trim();
  const m = s.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : /^[A-Za-z0-9_-]{11}$/.test(s) ? s : "";
}

const loadImg = src => new Promise((ok, bad) => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => ok(i); i.onerror = bad; i.src = src; });

/* A frame (an image or a <video>) with a ▶ drawn on it, uploaded as a JPEG. */
async function drawPoster(img, sw, sh, name) {
    const w = Math.min(1080, sw), h = Math.round(w * sh / sw);
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0, w, h);
    const r = Math.round(Math.min(w, h) * 0.11), x = w / 2, y = h / 2;
    g.fillStyle = "rgba(0,0,0,.55)"; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "rgba(255,255,255,.9)"; g.lineWidth = Math.max(2, r * 0.06); g.stroke();
    g.fillStyle = "#fff"; g.beginPath();
    g.moveTo(x - r * 0.32, y - r * 0.45); g.lineTo(x - r * 0.32, y + r * 0.45); g.lineTo(x + r * 0.5, y); g.closePath(); g.fill();
    const blob = await new Promise(ok => c.toBlob(ok, "image/jpeg", 0.86));
    const file = new File([blob], `${name}.jpg`, { type: "image/jpeg" });
    return await uploadToStorage(`campaign/lots/${name}-${Date.now()}.jpg`, file);
}

/* The video's frame with a play button on it. Falls back to YouTube's own
   thumbnail when drawing isn't possible. */
export async function makePoster(id, lotId) {
  let img = null;
  for (const name of ["maxresdefault", "sddefault", "hqdefault"]) {
    try { const i = await loadImg(`https://i.ytimg.com/vi/${id}/${name}.jpg`); if (i.naturalWidth > 120) { img = i; break; } } catch {}
  }
  if (!img) throw new Error("Couldn't load that video's picture. Is the link right, and the video public or unlisted?");
  try { return await drawPoster(img, img.naturalWidth, img.naturalHeight, lotId); } catch { return img.src; }
}

/* The poster from the video itself (a file, or a URL that allows it) — YouTube
   has no thumbnail for a few minutes after an upload. A frame a second in. */
export async function posterFromVideo(src, name) {
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.preload = "auto"; v.crossOrigin = "anonymous";
  const url = typeof src === "string" ? src : URL.createObjectURL(src);
  try {
    await new Promise((ok, bad) => { v.onloadeddata = ok; v.onerror = () => bad(new Error("Couldn't read a frame of that video")); v.src = url; });
    await new Promise(ok => { v.onseeked = ok; v.currentTime = Math.min(1, (v.duration || 2) / 2); });
    return await drawPoster(v, v.videoWidth, v.videoHeight, name);
  } finally { if (typeof src !== "string") URL.revokeObjectURL(url); }
}

/* Several videos joined end to end into one MP4, in the order given. Clips off
   the same phone are copied as they are (no quality lost, quick); otherwise
   they're re-encoded at the first clip's size. */
export async function joinVideos(files, onStep, { muted = false } = {}) {
  const [{ openClip, closeClip, exportVideo }, { NEUTRAL, NO_GEO }, { emptyCurves }] =
    await Promise.all([import("./videoLab.js"), import("./glPipeline.js"), import("./ToneCurve.jsx")]);
  const clips = [];
  try {
    for (let i = 0; i < files.length; i++) {
      onStep?.(`Reading video ${i + 1} of ${files.length}…`);
      clips.push(await openClip(files[i], files[i].name));
    }
    const { blob, lossless } = await exportVideo({
      clips, recipe: { touched: false, muted, adjust: NEUTRAL, bands: [], curves: emptyCurves(), geo: NO_GEO },
      onProgress: p => onStep?.(`${files.length > 1 ? `Joining ${files.length} videos` : "Taking the sound out"}${clips.some(c => c.videoKey !== clips[0].videoKey) ? " (re-encoding)" : ""}… ${Math.round(p * 100)}%`),
    });
    void lossless;
    return new File([blob], `lot-${Date.now().toString(36)}.mp4`, { type: "video/mp4" });
  } finally { clips.forEach(closeClip); }
}

/* The browser sends the file to the upload session the server opened. A
   YouTube refusal (quota, not connected) is final; a blocked or dropped
   connection falls back to the storage route. */
async function directToYoutube(file, { title, text, onStep }) {
  onStep?.("Opening the YouTube upload…");
  const r = await fetch("/api/social?action=youtube_session&p=youtube", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ p: "youtube", title: String(title || "Earth Editions lot").slice(0, 90), text, privacy: "unlisted", size: file.size, type: file.type || "video/mp4" }) });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) throw Object.assign(new Error("Your ERP login ran out — reload the page, then upload again"), { final: true });
  if (!r.ok || !d.uploadUrl) throw Object.assign(new Error(/connect|token/i.test(d.error || "") ? "YouTube isn't connected — connect it in Social first" : d.error || `YouTube failed (${r.status})`), { final: true });
  const mb = Math.round(file.size / 1048576);
  const res = await new Promise((ok, bad) => {
    const x = new XMLHttpRequest();
    x.open("PUT", d.uploadUrl);
    x.setRequestHeader("Content-Type", file.type || "video/mp4");
    x.upload.onprogress = e => e.lengthComputable && onStep?.(`Uploading to YouTube… ${Math.round(e.loaded / e.total * 100)}% of ${mb} MB`);
    x.onload = () => ok(x);
    x.onerror = () => bad(new Error("the browser couldn't reach YouTube's upload"));
    x.send(file);
  });
  let v = {}; try { v = JSON.parse(res.responseText || "{}"); } catch {}
  if (res.status < 200 || res.status >= 300 || !v.id) throw Object.assign(new Error(`YouTube: ${v.error?.message || res.status}`), { final: res.status >= 400 && res.status < 500 });
  const note = v.status?.privacyStatus && v.status.privacyStatus !== "unlisted" ? `uploaded as ${v.status.privacyStatus} — Google keeps uploads private until the app is verified` : "";
  return { url: `https://youtu.be/${v.id}`, id: v.id, note };
}

/* A video to YouTube as Unlisted, through Social's connected channel. Takes a
   File (stored first, over 50 MB a 1080p copy) or a stored URL. Returns
   { url: "https://youtu.be/…", id, note }. */
export async function videoToYoutube(src, { title = "", text = "", onStep } = {}) {
  // A file goes straight from this browser to YouTube, full quality, any size.
  if (typeof src !== "string") {
    try { return await directToYoutube(src, { title, text, onStep }); }
    catch (e) { if (e.final) throw e; console.warn("[lots] direct YouTube upload failed, going via storage:", e); }
  }
  let url = typeof src === "string" ? src : "";
  if (!url) {
    let up = src;
    if (up.size > 50 * 1024 * 1024) {
      const { fitVideoForStorage } = await import("./videoLab.js");
      up = await fitVideoForStorage(up, { onProgress: (p, edge) => onStep?.(`Over 50 MB — making a ${edge >= 1920 ? "1080p" : edge >= 1280 ? "720p" : "540p"} copy… ${Math.round(p * 100)}%`) });
    }
    const ext = (up.name.split(".").pop() || "mp4").toLowerCase();
    onStep?.("Uploading… 0%");
    url = await uploadToStorage(`campaign/lot-videos/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.${ext}`, up, { onProgress: p => onStep?.(`Uploading… ${Math.round((p > 1 ? p / 100 : p) * 100)}%`) });
  }
  onStep?.("Sending to YouTube (unlisted)…");
  const r = await fetch("/api/social?action=post&p=youtube", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ p: "youtube", video: url, title: String(title || "Earth Editions lot").slice(0, 90), text, privacy: "unlisted", source: "campaign" }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(/connect|token/i.test(d.error || "") ? "YouTube isn't connected — connect it in Social first" : d.error || `YouTube failed (${r.status})`);
  return d;
}

const num = v => String(v ?? "").replace(/[^\d.]/g, "");
const fmt = n => { const v = Math.round(+n * 100) / 100; return `$${v.toLocaleString("en-US", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })}`; };

/* How a lot reads on its card. */
export function lotPrice(l) {
  const p = +l.price || 0;
  if (!p || l.hidePrice) return { price: "", priceValue: null, currency: "" };
  const w = +l.weight || 0, n = +l.pieces || 0;
  const per = { kg: "kg", g: "g", ct: "ct", piece: "piece" }[l.basis];
  const total = l.basis === "total" ? p : per === "piece" ? (n ? p * n : 0) : per && w && l.unit === per ? p * w : 0;
  const text = l.basis === "total" ? fmt(p) : `${fmt(p)} / ${per}${total ? ` · ${fmt(total)} the lot` : ""}`;
  return { price: text, priceValue: total || p, currency: "USD" };
}
export const lotMeta = l => [+l.weight ? `${l.weight} ${l.unit || "kg"}` : "", +l.pieces ? `${l.pieces} pieces` : "", l.details].filter(Boolean).join(" · ");
export const lotToProduct = l => ({
  id: `lot-${l.id}`, lotId: l.id, isLot: true, video: true, deal: !!l.deal,
  title: l.title || "Lot", image: l.poster || "", url: l.videoUrl, meta: lotMeta(l), description: l.details || "",
  ...lotPrice(l),
});

const blank = () => ({ id: uid(), videoUrl: "", title: "", weight: "", unit: "kg", pieces: "", price: "", basis: "kg", details: "", deal: false, hidePrice: false });

export default function LotsPanel({ lots, setLots, picked, togglePick, onChange, showToast }) {
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [step, setStep] = useState("");
  const [pendingVids, setPendingVids] = useState([]); // picked, waiting for: trim in the editor, or upload as is
  const [editorOpen, setEditorOpen] = useState(false);
  const [mute, setMute] = useState(false);
  const lab = { fontSize: 9.5, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 3, display: "block" };
  const set = p => setEdit(e => ({ ...e, ...p }));

  const save = async () => {
    const id = youtubeId(edit.videoUrl);
    if (!id) return setErr("Paste the YouTube link of the video (an unlisted video works).");
    if (!edit.title.trim()) return setErr("Give the lot a name.");
    setBusy(true); setErr("");
    try {
      const old = lots.find(l => l.id === edit.id);
      const poster = edit.posterFor === id && edit.poster ? edit.poster : old && old.videoId === id && old.poster ? old.poster : await makePoster(id, edit.id);
      const { posterFor, ...rest } = edit;
      const lot = { ...rest, title: edit.title.trim(), details: edit.details.trim(), videoId: id, videoUrl: `https://youtu.be/${id}`, poster, updatedAt: new Date().toISOString(), createdAt: edit.createdAt || new Date().toISOString() };
      const next = old ? lots.map(l => l.id === lot.id ? lot : l) : [lot, ...lots];
      await saveLots(next); setLots(next); setEdit(null);
      if (!old && !picked.has(lot.id)) togglePick(lot.id);
      onChange?.(); showToast?.(`✓ ${lot.title} saved${old ? "" : " and added to this mailer"}`);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  /* Upload the video here: it goes to YouTube as Unlisted on Social's channel,
     its link fills in, and the poster is drawn from the file itself. */
  const uploadVideo = async (files, { muted = false } = {}) => {
    const list = (Array.isArray(files) ? files : [files]).filter(Boolean);
    if (!list.length) return;
    setBusy(true); setErr("");
    try {
      // Several picked: joined into one video, in the order picked, before it goes up.
      // Several picked are joined into one; muted, even a single one is rebuilt without its sound.
      const f = typeof list[0] !== "string" && (list.length > 1 || muted) ? await joinVideos(list, setStep, { muted }) : list[0];
      setPendingVids([]);
      let poster = "";
      try { setStep("Taking a frame for the email…"); poster = await posterFromVideo(f, edit.id); } catch {}
      const d = await videoToYoutube(f, { title: edit.title || (typeof list[0] === "string" ? "Lot" : list[0].name.replace(/\.[^.]+$/, "")), text: edit.details, onStep: setStep });
      const vid = youtubeId(d.url);
      set({ videoUrl: d.url, ...(poster ? { poster, posterFor: vid } : {}) });
      showToast?.(`✓ ${list.length > 1 ? `${list.length} videos joined and on` : "On"} YouTube (unlisted)${d.note ? ` — ${d.note}` : ""}`, d.note ? 9000 : 4000);
    } catch (e) { setErr(e.message || String(e)); }
    setStep(""); setBusy(false);
  };
  const remove = async l => {
    if (!window.confirm(`Delete the lot "${l.title}"? The YouTube video isn't touched.`)) return;
    const next = lots.filter(x => x.id !== l.id); await saveLots(next); setLots(next);
    if (picked.has(l.id)) togglePick(l.id);
    setEdit(null); onChange?.();
  };

  if (edit) {
    const yt = youtubeId(edit.videoUrl);
    const pv = lotPrice(edit);
    return (
      <div style={{ display: "grid", gap: 9, overflowY: "auto" }}>
        <label style={{ background: C.card, border: `1px dashed ${C.border}`, borderRadius: 7, padding: "9px 12px", fontSize: 12.5, fontWeight: 700, cursor: busy ? "default" : "pointer", textAlign: "center", opacity: busy ? .6 : 1 }}>
          {yt ? "⬆ Upload a different video" : "⬆ Pick the video — or several, to join into one"}
          <input type="file" accept="video/*" multiple disabled={busy} style={{ display: "none" }} onChange={e => { const fs = [...(e.target.files || [])]; e.target.value = ""; if (fs.length) setPendingVids(fs); }} />
        </label>
        {pendingVids.length > 0 && !busy && (
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 7, padding: 9, display: "grid", gap: 7 }}>
            <div style={{ fontSize: 12, color: C.inkMid }}>{pendingVids.length} video{pendingVids.length > 1 ? "s" : ""} · {Math.round(pendingVids.reduce((n, f) => n + f.size, 0) / 1048576)} MB{pendingVids.length > 1 ? " — joined in this order" : ""}</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button type="button" onClick={() => setEditorOpen(true)} style={{ background: C.ink, color: "#FAF0DC", border: "none", borderRadius: 7, padding: "7px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>✂ Trim / join in the editor</button>
              <button type="button" onClick={() => uploadVideo(pendingVids, { muted: mute })} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 7, padding: "7px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Upload as is</button>
              <button type="button" onClick={() => setPendingVids([])} style={{ background: "none", border: "none", color: C.inkMid, fontSize: 12, cursor: "pointer" }}>Cancel</button>
              <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 700, cursor: "pointer", marginLeft: "auto" }}><input type="checkbox" checked={mute} onChange={e => setMute(e.target.checked)} /> 🔇 Mute</label>
            </div>
            <div style={{ fontSize: 10.5, color: C.inkFaint }}>Over 50 MB is made smaller on the way (1080p, then 720p or 540p if it must).</div>
          </div>
        )}
        {editorOpen && (
          <Suspense fallback={<div style={{ position: "fixed", inset: 0, zIndex: 2100, background: "rgba(20,15,8,.78)", display: "grid", placeItems: "center", color: "#FAF0DC", fontSize: 13, fontWeight: 700 }}>Loading the video editor…</div>}>
            <VideoEditor urls={pendingVids} noEtsy showToast={showToast}
              onSave={savedUrl => { setEditorOpen(false); uploadVideo([savedUrl]); }}
              onClose={() => setEditorOpen(false)} />
          </Suspense>
        )}
        {step && <div style={{ fontSize: 12, color: C.inkMid }}>{step}</div>}
        <div><span style={lab}>…or paste a YouTube link (unlisted is fine)</span><input value={edit.videoUrl} onChange={e => set({ videoUrl: e.target.value })} placeholder="https://youtu.be/…" style={FI()} /></div>
        {yt && <img src={edit.posterFor === yt && edit.poster ? edit.poster : `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`} alt="" style={{ width: "100%", borderRadius: 7, display: "block" }} />}
        <div><span style={lab}>Lot name</span><input value={edit.title} onChange={e => set({ title: e.target.value })} placeholder="Amethyst points lot" style={FI()} /></div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 70px 1fr", gap: 6 }}>
          <div><span style={lab}>Weight</span><input value={edit.weight} onChange={e => set({ weight: num(e.target.value) })} style={FI()} /></div>
          <div><span style={lab}>Unit</span><select value={edit.unit} onChange={e => set({ unit: e.target.value })} style={FI()}><option>kg</option><option>g</option><option>ct</option></select></div>
          <div><span style={lab}>Pieces</span><input value={edit.pieces} onChange={e => set({ pieces: num(e.target.value).replace(".", "") })} style={FI()} /></div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          <div><span style={lab}>Price $</span><input value={edit.price} onChange={e => set({ price: num(e.target.value) })} style={FI()} /></div>
          <div><span style={lab}>Price is</span><select value={edit.basis} onChange={e => set({ basis: e.target.value })} style={FI()}>
            <option value="kg">per kg</option><option value="g">per gram</option><option value="ct">per carat</option><option value="piece">per piece</option><option value="total">for the whole lot</option>
          </select></div>
        </div>
        {pv.price && <div style={{ fontSize: 11.5, color: C.inkMid }}>Prints as: <b>{pv.price}</b></div>}
        <div><span style={lab}>Details (printed under the name)</span><input value={edit.details} onChange={e => set({ details: e.target.value })} placeholder="Brazil · 3–6 cm · A grade" style={FI()} /></div>
        <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={edit.deal} onChange={e => set({ deal: e.target.checked })} /> Under the in-stock banner</label>
        <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={edit.hidePrice} onChange={e => set({ hidePrice: e.target.checked })} /> Don't print the price (ask us)</label>
        {err && <div style={{ fontSize: 12, color: C.red }}>{err}</div>}
        <div style={{ display: "flex", gap: 6 }}>
          <button type="button" onClick={save} disabled={busy} style={{ background: C.ink, color: "#FAF0DC", border: "none", borderRadius: 7, padding: "8px 14px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>{busy ? "Saving…" : "Save lot"}</button>
          <button type="button" onClick={() => { setEdit(null); setErr(""); }} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 7, padding: "8px 12px", fontSize: 12.5, cursor: "pointer" }}>Cancel</button>
          <div style={{ flex: 1 }} />
          {lots.some(l => l.id === edit.id) && <button type="button" onClick={() => remove(edit)} style={{ background: "none", border: "none", color: C.red, fontSize: 12, cursor: "pointer" }}>Delete</button>}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}>
      <div style={{ fontSize: 11, color: C.inkMid, lineHeight: 1.45 }}>Offers that aren't in stock, shown by video. Upload the video here and it goes to YouTube as <b>Unlisted</b> on your connected channel (or paste a link). The email shows the video's frame with a ▶ that opens it.</div>
      <button type="button" onClick={() => setEdit(blank())} style={{ background: C.ink, color: "#FAF0DC", border: "none", borderRadius: 7, padding: "8px 12px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>＋ New lot</button>
      <div style={{ overflowY: "auto", display: "grid", gap: 6 }}>
        {!lots.length && <div style={{ fontSize: 12, color: C.inkFaint, textAlign: "center", padding: 16 }}>No lots yet.</div>}
        {lots.map(l => (
          <div key={l.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: 6, borderRadius: 8, border: `1px solid ${picked.has(l.id) ? C.ink : C.border}`, background: picked.has(l.id) ? C.card : "transparent" }}>
            <input type="checkbox" checked={picked.has(l.id)} onChange={() => { togglePick(l.id); onChange?.(); }} />
            {l.poster && <img src={l.poster} alt="" style={{ width: 54, height: 36, objectFit: "cover", borderRadius: 4 }} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.title}</div>
              <div style={{ fontSize: 10.5, color: C.inkFaint }}>{[lotMeta(l), lotPrice(l).price].filter(Boolean).join(" · ")}{l.mailedAt ? ` · mailed ${new Date(l.mailedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}</div>
            </div>
            <button type="button" onClick={() => setEdit({ ...blank(), ...l })} style={{ background: "none", border: "none", fontSize: 11.5, color: C.inkMid, cursor: "pointer", textDecoration: "underline" }}>Edit</button>
          </div>
        ))}
      </div>
    </div>
  );
}
