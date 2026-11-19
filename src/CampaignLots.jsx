/* Lots for the mailing list: offers that aren't pieces in stock — a parcel
   of rough, a box of points — shown by video. A lot is a YouTube link
   (unlisted) plus what a buyer needs to decide: weight, pieces, price.

   Email can't play video, so the card is the video's frame with a ▶ drawn on
   it, linking to the video on YouTube. The frame is made here in the browser
   and stored as a small JPEG; the video itself is never stored by the ERP, so
   a big send costs no bandwidth of ours.

   Lots are kept in app_data (ng-campaign-lots-v1) so one can go out again,
   and a send stamps the lots it carried, like listings. */
import { useState } from "react";
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

/* The video's frame with a play button on it, uploaded as a JPEG. Falls back
   to YouTube's own thumbnail when drawing isn't possible. */
async function makePoster(id, lotId) {
  let img = null;
  for (const name of ["maxresdefault", "sddefault", "hqdefault"]) {
    try { const i = await loadImg(`https://i.ytimg.com/vi/${id}/${name}.jpg`); if (i.naturalWidth > 120) { img = i; break; } } catch {}
  }
  if (!img) throw new Error("Couldn't load that video's picture. Is the link right, and the video public or unlisted?");
  try {
    const w = Math.min(1080, img.naturalWidth), h = Math.round(w * img.naturalHeight / img.naturalWidth);
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0, w, h);
    const r = Math.round(Math.min(w, h) * 0.11), x = w / 2, y = h / 2;
    g.fillStyle = "rgba(0,0,0,.55)"; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "rgba(255,255,255,.9)"; g.lineWidth = Math.max(2, r * 0.06); g.stroke();
    g.fillStyle = "#fff"; g.beginPath();
    g.moveTo(x - r * 0.32, y - r * 0.45); g.lineTo(x - r * 0.32, y + r * 0.45); g.lineTo(x + r * 0.5, y); g.closePath(); g.fill();
    const blob = await new Promise(ok => c.toBlob(ok, "image/jpeg", 0.86));
    const file = new File([blob], `${lotId}.jpg`, { type: "image/jpeg" });
    return await uploadToStorage(`campaign/lots/${lotId}-${Date.now()}.jpg`, file);
  } catch { return img.src; }
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
  const lab = { fontSize: 9.5, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 3, display: "block" };
  const set = p => setEdit(e => ({ ...e, ...p }));

  const save = async () => {
    const id = youtubeId(edit.videoUrl);
    if (!id) return setErr("Paste the YouTube link of the video (an unlisted video works).");
    if (!edit.title.trim()) return setErr("Give the lot a name.");
    setBusy(true); setErr("");
    try {
      const old = lots.find(l => l.id === edit.id);
      const poster = old && old.videoId === id && old.poster ? old.poster : await makePoster(id, edit.id);
      const lot = { ...edit, title: edit.title.trim(), details: edit.details.trim(), videoId: id, videoUrl: `https://youtu.be/${id}`, poster, updatedAt: new Date().toISOString(), createdAt: edit.createdAt || new Date().toISOString() };
      const next = old ? lots.map(l => l.id === lot.id ? lot : l) : [lot, ...lots];
      await saveLots(next); setLots(next); setEdit(null);
      if (!old && !picked.has(lot.id)) togglePick(lot.id);
      onChange?.(); showToast?.(`✓ ${lot.title} saved${old ? "" : " and added to this mailer"}`);
    } catch (e) { setErr(e.message); }
    setBusy(false);
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
        <div><span style={lab}>YouTube link (unlisted is fine)</span><input value={edit.videoUrl} onChange={e => set({ videoUrl: e.target.value })} placeholder="https://youtu.be/…" style={FI()} /></div>
        {yt && <img src={`https://i.ytimg.com/vi/${yt}/hqdefault.jpg`} alt="" style={{ width: "100%", borderRadius: 7, display: "block" }} />}
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
      <div style={{ fontSize: 11, color: C.inkMid, lineHeight: 1.45 }}>Offers that aren't in stock, shown by video. Upload the video to YouTube as <b>Unlisted</b>, then paste its link here. The email shows the video's frame with a ▶ that opens it.</div>
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
