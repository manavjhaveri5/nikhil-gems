import { useState, useRef, useEffect } from "react";
import { uploadToStorage } from "./storageUtils.js";

// ── Background Remover (Canva loop) ────────────────────────────────────────────
// Phone photo → auto-uploaded into Canva as a ready-to-edit design → you click
// Canva's Remove BG once → pull the finished cutout straight back into ERP
// storage. Keeps Canva's quality; removes the manual upload/download shuffle.

const AMBER = "#c48208";
const INK = "#1a1208";
const MUTE = "#7a6a4a";
const BG = "#FAF7F2";

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => resolve({ dataURL: r.result, width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = reject;
      img.src = r.result;
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function dataURLToBlob(dataURL) {
  const [head, b64] = dataURL.split(",");
  const mime = (head.match(/data:(.*?);/) || [])[1] || "image/png";
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

export default function BgRemoveSandbox({ onHome }) {
  const [connected, setConnected] = useState(null); // null = checking
  const [configured, setConfigured] = useState(true);
  const [photo, setPhoto] = useState(null); // { dataURL, width, height }
  const [design, setDesign] = useState(null); // { design_id, edit_url }
  const [result, setResult] = useState(null); // data URL
  const [savedUrl, setSavedUrl] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const fileRef = useRef(null);

  const checkStatus = async () => {
    try {
      const r = await fetch("/api/canva-auth?action=status");
      const d = await r.json();
      setConnected(!!d.connected);
      setConfigured(!!d.configured);
    } catch {
      setConnected(false);
    }
  };

  useEffect(() => {
    checkStatus();
    const onMsg = (e) => { if (e.data?.type === "canva-auth-complete") checkStatus(); };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const connect = () => {
    window.open("/api/canva-auth?action=start", "canva-auth", "width=520,height=720");
  };

  const pick = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setError(""); setResult(null); setDesign(null); setSavedUrl("");
    setPhoto(await fileToImage(f));
  };

  const sendToCanva = async () => {
    if (!photo) return;
    setBusy("send"); setError(""); setResult(null); setSavedUrl("");
    try {
      const r = await fetch("/api/canva", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", image: photo.dataURL, width: photo.width, height: photo.height, name: `ERP photo ${new Date().toLocaleString()}` }),
      });
      const d = await r.json();
      if (!r.ok) {
        if (d.needsAuth) setConnected(false);
        throw new Error(d.error || `HTTP ${r.status}`);
      }
      setDesign(d);
      if (d.edit_url) window.open(d.edit_url, "_blank");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };

  const pullBack = async () => {
    if (!design?.design_id) return;
    setBusy("pull"); setError("");
    try {
      const r = await fetch("/api/canva", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "export", design_id: design.design_id }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setResult(d.image);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };

  const download = () => {
    if (!result) return;
    const a = document.createElement("a");
    a.href = result;
    a.download = `cutout-${Date.now()}.png`;
    a.click();
  };

  const saveToStorage = async () => {
    if (!result) return;
    setBusy("save"); setError("");
    try {
      const file = new File([dataURLToBlob(result)], `cutout-${Date.now()}.png`, { type: "image/png" });
      setSavedUrl(await uploadToStorage(`bg-canva/${file.name}`, file));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };

  const reset = () => {
    setPhoto(null); setDesign(null); setResult(null); setSavedUrl(""); setError("");
    if (fileRef.current) fileRef.current.value = "";
  };

  const Step = ({ n, title, active, done, children }) => (
    <div style={{ display: "flex", gap: 12, marginBottom: 18, opacity: active || done ? 1 : 0.45 }}>
      <div style={{ flexShrink: 0, width: 28, height: 28, borderRadius: "50%", background: done ? "#2d7a4f" : active ? AMBER : "#d8ccb4", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700 }}>
        {done ? "✓" : n}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: active ? 8 : 0 }}>{title}</div>
        {active && children}
      </div>
    </div>
  );

  const btn = (label, onClick, { primary = true, disabled = false } = {}) => (
    <button onClick={onClick} disabled={disabled}
      style={{ padding: "11px 18px", borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: disabled ? "default" : "pointer",
        background: disabled ? "#d9b56a" : primary ? AMBER : "#fff", color: primary ? "#fff" : INK,
        border: primary ? "none" : "1px solid #ddd2bf" }}>
      {label}
    </button>
  );

  return (
    <div style={{ minHeight: "100dvh", background: BG, fontFamily: "system-ui, sans-serif", color: INK }}>
      <div style={{ maxWidth: 620, margin: "0 auto", padding: "16px 16px 48px" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
          <button onClick={onHome} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: INK, padding: 4 }} aria-label="Home">←</button>
          <div>
            <div style={{ fontSize: 19, fontWeight: 800 }}>✂️ Background Remover</div>
            <div style={{ fontSize: 12, color: MUTE }}>Sandbox · phone photo → Canva → clean cutout → back in ERP</div>
          </div>
        </div>

        {/* Connection banner */}
        {connected === false && (
          <div style={{ background: "#fff7e8", border: `1px solid ${AMBER}55`, borderRadius: 12, padding: 16, marginBottom: 18 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>Connect your Canva account</div>
            <div style={{ fontSize: 13, color: MUTE, marginBottom: 12 }}>
              {configured
                ? "One-time sign-in so the ERP can push photos into Canva and pull the finished cutout back."
                : "Canva isn’t configured on the server yet — add CANVA_CLIENT_ID, CANVA_CLIENT_SECRET and CANVA_REDIRECT_URI in Vercel, then redeploy."}
            </div>
            {configured && btn("🔗 Connect Canva", connect)}
          </div>
        )}

        {connected && (
          <div style={{ fontSize: 12, color: "#2d7a4f", fontWeight: 600, marginBottom: 14 }}>● Canva connected</div>
        )}

        {/* Steps */}
        {connected && (
          <>
            <Step n={1} title="Take or choose a photo" active={!photo} done={!!photo}>
              <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={pick} style={{ display: "none" }} id="bg-file" />
              <label htmlFor="bg-file" style={{ display: "inline-block", padding: "11px 20px", background: AMBER, color: "#fff", borderRadius: 10, fontSize: 15, fontWeight: 600, cursor: "pointer" }}>📷 Take / choose photo</label>
            </Step>

            <Step n={2} title="Send to Canva" active={!!photo && !design} done={!!design}>
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                {photo && <img src={photo.dataURL} alt="" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, border: "1px solid #e6ddca" }} />}
                {btn(busy === "send" ? "Uploading…" : "Send to Canva ↗", sendToCanva, { disabled: busy === "send" })}
                {btn("Clear", reset, { primary: false })}
              </div>
            </Step>

            <Step n={3} title="Remove background in Canva" active={!!design && !result} done={!!result}>
              <div style={{ fontSize: 13, color: MUTE, lineHeight: 1.5, marginBottom: 10 }}>
                The design opened in Canva. Select the photo → <b>Edit photo</b> → <b>BG Remover</b> → it autosaves. Then come back and pull it.
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {design?.edit_url && btn("Open in Canva ↗", () => window.open(design.edit_url, "_blank"), { primary: false })}
                {btn(busy === "pull" ? "Pulling…" : "Pull finished image ↓", pullBack, { disabled: busy === "pull" })}
              </div>
            </Step>

            <Step n={4} title="Save back into ERP" active={!!result} done={!!savedUrl}>
              {result && (
                <>
                  <div style={{ width: "100%", maxWidth: 280, aspectRatio: "1/1", border: "1px solid #e6ddca", borderRadius: 12, background: "repeating-conic-gradient(#e8e2d6 0% 25%, #fff 0% 50%) 50% / 18px 18px", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", marginBottom: 12 }}>
                    <img src={result} alt="result" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
                  </div>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    {btn("⬇️ Download", download, { primary: false })}
                    {btn(busy === "save" ? "Saving…" : "💾 Save to storage", saveToStorage, { disabled: busy === "save" })}
                    {btn("Start over", reset, { primary: false })}
                  </div>
                  {savedUrl && (
                    <div style={{ marginTop: 12, fontSize: 12, color: MUTE, wordBreak: "break-all" }}>
                      Saved → <a href={savedUrl} target="_blank" rel="noreferrer" style={{ color: AMBER }}>{savedUrl}</a>
                    </div>
                  )}
                </>
              )}
            </Step>
          </>
        )}

        {error && (
          <div style={{ background: "#fdecec", border: "1px solid #f3b9b9", color: "#9b2c2c", borderRadius: 10, padding: "10px 14px", fontSize: 13, marginTop: 8 }}>
            {error}
          </div>
        )}

        {connected === null && <div style={{ color: MUTE, fontSize: 13 }}>Checking Canva connection…</div>}
      </div>
    </div>
  );
}
