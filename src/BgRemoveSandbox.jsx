import { useState, useRef } from "react";
import { uploadToStorage } from "./storageUtils.js";

// ── Background-removal sandbox ─────────────────────────────────────────────────
// Phone photo → clean white (or transparent) background → download or save back
// into the ERP's media storage. A try-it module to evaluate the workflow before
// wiring it into Image Library / Listing Manager.

const AMBER = "#c48208";
const INK = "#1a1208";
const MUTE = "#7a6a4a";
const BG = "#FAF7F2";

// transparent-checkerboard so a transparent result is visible
const CHECKER =
  "repeating-conic-gradient(#e8e2d6 0% 25%, #fff 0% 50%) 50% / 18px 18px";

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
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
  const [original, setOriginal] = useState(null); // data URL
  const [result, setResult] = useState(null); // data URL
  const [bgColor, setBgColor] = useState("ffffff"); // ffffff | transparent | custom hex
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [savedUrl, setSavedUrl] = useState("");
  const fileRef = useRef(null);

  const pick = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setError("");
    setInfo("");
    setResult(null);
    setSavedUrl("");
    setOriginal(await fileToDataURL(f));
  };

  const removeBg = async () => {
    if (!original) return;
    setBusy(true);
    setError("");
    setInfo("");
    setResult(null);
    setSavedUrl("");
    try {
      const r = await fetch("/api/remove-bg", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: original, bg_color: bgColor, size: "auto" }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setResult(data.image);
      setInfo(data.creditsCharged ? `Done · ${data.creditsCharged} credit(s) used` : "Done");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
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
    setBusy(true);
    setError("");
    try {
      const blob = dataURLToBlob(result);
      const file = new File([blob], `cutout-${Date.now()}.png`, { type: "image/png" });
      const url = await uploadToStorage(`bg-sandbox/${file.name}`, file);
      setSavedUrl(url);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setOriginal(null);
    setResult(null);
    setError("");
    setInfo("");
    setSavedUrl("");
    if (fileRef.current) fileRef.current.value = "";
  };

  const swatch = (val, label) => {
    const active = bgColor === val;
    return (
      <button
        key={val}
        onClick={() => setBgColor(val)}
        style={{
          padding: "8px 14px",
          borderRadius: 9,
          border: active ? `2px solid ${AMBER}` : "1px solid #ddd2bf",
          background: active ? "#fff7e8" : "#fff",
          color: INK,
          fontSize: 13,
          fontWeight: active ? 700 : 500,
          cursor: "pointer",
        }}
      >
        {label}
      </button>
    );
  };

  const Panel = ({ title, src, transparent }) => (
    <div style={{ flex: 1, minWidth: 220 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: MUTE, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.4 }}>
        {title}
      </div>
      <div
        style={{
          aspectRatio: "1 / 1",
          borderRadius: 12,
          border: "1px solid #e6ddca",
          background: transparent ? CHECKER : "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {src ? (
          <img src={src} alt={title} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
        ) : (
          <span style={{ color: "#c4b89c", fontSize: 13 }}>—</span>
        )}
      </div>
    </div>
  );

  return (
    <div style={{ minHeight: "100dvh", background: BG, fontFamily: "system-ui, sans-serif", color: INK }}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "16px 16px 48px" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
          <button
            onClick={onHome}
            style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: INK, padding: 4 }}
            aria-label="Home"
          >
            ←
          </button>
          <div>
            <div style={{ fontSize: 19, fontWeight: 800 }}>✂️ Background Remover</div>
            <div style={{ fontSize: 12, color: MUTE }}>Sandbox · phone photo → clean white background</div>
          </div>
        </div>

        {/* Pick */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={pick}
            style={{ display: "none" }}
            id="bg-file"
          />
          <label
            htmlFor="bg-file"
            style={{
              padding: "11px 20px",
              background: AMBER,
              color: "#fff",
              borderRadius: 10,
              fontSize: 15,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            📷 Take / choose photo
          </label>
          {original && (
            <button
              onClick={reset}
              style={{ padding: "11px 18px", background: "#fff", color: INK, border: "1px solid #ddd2bf", borderRadius: 10, fontSize: 14, cursor: "pointer" }}
            >
              Clear
            </button>
          )}
        </div>

        {/* Background choice */}
        {original && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: MUTE, marginBottom: 8 }}>BACKGROUND</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {swatch("ffffff", "⬜ White")}
              {swatch("transparent", "▦ Transparent")}
              {swatch("000000", "⬛ Black")}
            </div>
          </div>
        )}

        {/* Action */}
        {original && (
          <button
            onClick={removeBg}
            disabled={busy}
            style={{
              width: "100%",
              padding: "13px",
              background: busy ? "#d9b56a" : AMBER,
              color: "#fff",
              border: "none",
              borderRadius: 11,
              fontSize: 16,
              fontWeight: 700,
              cursor: busy ? "default" : "pointer",
              marginBottom: 18,
            }}
          >
            {busy ? "Working…" : "Remove background"}
          </button>
        )}

        {error && (
          <div style={{ background: "#fdecec", border: "1px solid #f3b9b9", color: "#9b2c2c", borderRadius: 10, padding: "10px 14px", fontSize: 13, marginBottom: 16 }}>
            {error}
          </div>
        )}
        {info && !error && (
          <div style={{ color: MUTE, fontSize: 12, marginBottom: 12 }}>{info}</div>
        )}

        {/* Before / after */}
        {original && (
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 18 }}>
            <Panel title="Original" src={original} transparent={false} />
            <Panel title="Result" src={result} transparent={bgColor === "transparent"} />
          </div>
        )}

        {/* Result actions */}
        {result && (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button
              onClick={download}
              style={{ padding: "11px 18px", background: "#fff", color: INK, border: "1px solid #ddd2bf", borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: "pointer" }}
            >
              ⬇️ Download PNG
            </button>
            <button
              onClick={saveToStorage}
              disabled={busy}
              style={{ padding: "11px 18px", background: AMBER, color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: "pointer" }}
            >
              💾 Save to storage
            </button>
          </div>
        )}

        {savedUrl && (
          <div style={{ marginTop: 14, fontSize: 12, color: MUTE, wordBreak: "break-all" }}>
            Saved →{" "}
            <a href={savedUrl} target="_blank" rel="noreferrer" style={{ color: AMBER }}>
              {savedUrl}
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
