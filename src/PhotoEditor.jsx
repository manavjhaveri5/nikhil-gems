import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { C, mob, FI } from "./lmTheme.js";
import { uploadToStorage } from "./storageUtils.js";
import { CurveEditor, emptyCurves, curvesTouched } from "./ToneCurve.jsx";
import { askGrade } from "./gradeAi.js";
import { buildBackgroundMask, maskToRgba } from "./backgroundSweep.js";
import {
  ADJUSTMENTS, NEUTRAL, MIXER, emptyMixer, mixerTouched, mixerBands, MAX_BANDS,
  ASPECTS, NO_GEO, PREVIEW_EDGE, clamp, cropGeometry, geoTouched, loadBitmap,
  createPipeline, setPipelineSource, renderPipeline,
} from "./glPipeline.js";
import { lab, Slider } from "./EditorControls.jsx";

/* Native photo editor for listing shots.

   The model reads the photo and writes the recipe; the GPU moves the pixels.
   That split is deliberate: these are wholesale goods, and a generative
   re-render would repaint the stone's own pattern — the buyer would be looking
   at a picture of a piece that doesn't exist. So the AI's job is to say what to
   change and by how much ("the inclusions sit at hue 268–292, push those"),
   and every number it picks lands on a slider the eye can overrule.

   Everything renders through one WebGL pass, so the preview is the save: the
   same shader runs again at full resolution when the photo is written back. */




export default function PhotoEditor({ url, photos, index, onSave, onSaveAll, onClose, showToast }) {
  const canvasRef = useRef(null);
  const glRef = useRef(null);       // { gl, program, uniforms, texture }
  const bitmapRef = useRef(null);
  const geoRef = useRef(null);      // last drawn geometry, for the drag maths
  const dragRef = useRef(null);
  /* The whole listing, when the caller hands it over: one photo's edit is almost
     never one photo's problem — a lot is shot in one sitting under one light. */
  const all = Array.isArray(photos) && photos.length > 1 && typeof onSaveAll === "function" ? photos : null;
  const [ready, setReady] = useState(false);
  const [adjust, setAdjust] = useState(NEUTRAL);
  const [bands, setBands] = useState([]);
  const [curves, setCurves] = useState(emptyCurves);
  const [mixer, setMixer] = useState(emptyMixer);
  /* The backdrop sweep. `mask` is recomputed only when its own settings change,
     never on a slider move — it reads the source pixels, which the sliders
     don't touch. */
  const [sweep, setSweep] = useState({ on: false, tolerance: 30, softness: 2, strength: 100 });
  const [mask, setMask] = useState(null);   // { data, width, height, coverage }
  /* Square crop. The shader still draws the whole photo — the canvas is just cut
     down to a square and the drawing slid along its long side, so cropping costs
     nothing and stays live while the sliders move. */
  const [geo, setGeo] = useState(NO_GEO);
  const setCrop = patch => setGeo(g => ({ ...g, crop: { ...g.crop, ...patch } }));
  const [dims, setDims] = useState(null);   // source pixels, for the crop panel
  const [dragging, setDragging] = useState(false);
  const [applyAll, setApplyAll] = useState(false);
  const [mixKey, setMixKey] = useState("blue");
  const [ask, setAsk] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState("");
  const [prog, setProg] = useState("");
  const [err, setErr] = useState("");
  const [showOriginal, setShowOriginal] = useState(false);
  /* The editor fills the window, and a window gets resized while it is open —
     so the one-column break is watched rather than read once at mount. */
  const [narrow, setNarrow] = useState(mob);
  useEffect(() => {
    const onResize = () => setNarrow(mob());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const touched = ADJUSTMENTS.some(a => adjust[a.key] !== 0) || bands.length > 0
    || curvesTouched(curves) || mixerTouched(mixer) || (sweep.on && !!mask) || geoTouched(geo);
  /* The mixer's ranges and the model's measured targets are the same mechanism,
     so they go to the shader as one list — mixer first, since those are the
     ranges the hand is on. */
  const allBands = useMemo(() => [...mixerBands(mixer), ...bands].slice(0, MAX_BANDS), [mixer, bands]);

  /* ── GL plumbing ────────────────────────────────────────────────────────── */
  const initGl = useCallback(bitmap => {
    const canvas = canvasRef.current;
    if (!canvas) return false;
    const ctx = createPipeline(canvas);
    if (!ctx) return false;
    glRef.current = ctx;
    setPipelineSource(ctx, bitmap);
    return true;
  }, []);

  /* One draw call is the whole editor. Everything it needs can be overridden,
     because the same call has three jobs: the live preview, the full-resolution
     write on save, and each of the other listing photos in the batch. */
  const draw = useCallback((o = {}) => {
    const ctx = glRef.current;
    const bitmap = o.bitmap || bitmapRef.current;
    const canvas = canvasRef.current;
    if (!ctx || !bitmap || !canvas) return;
    /* Preview at a size the screen can show, save at the crop's true pixels —
       the only difference between the two renders. */
    geoRef.current = renderPipeline(ctx, canvas, {
      sw: bitmap.width, sh: bitmap.height,
      values: o.values || adjust,
      bands: o.bands || allBands,
      curves: o.curves || curves,
      sweep: o.sweep || sweep,
      mask: o.bitmap ? o.mask : (o.mask !== undefined ? o.mask : mask),
      geo: o.geo || geo,
      maxEdge: o.full ? 0 : PREVIEW_EDGE,
    });
  }, [adjust, allBands, curves, sweep, mask, geo]);

  /* Point the one texture unit at a different photo — the batch's whole trick. */
  const setSource = useCallback(bitmap => {
    if (glRef.current) setPipelineSource(glRef.current, bitmap);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const bitmap = await loadBitmap(url);
        if (cancelled) return;
        bitmapRef.current = bitmap;
        setDims({ w: bitmap.width, h: bitmap.height });
        if (!initGl(bitmap)) throw new Error("This browser has no WebGL, so the editor can't run here.");
        setReady(true);
      } catch (e) { if (!cancelled) setErr(e.message || String(e)); }
    })();
    return () => { cancelled = true; };
  }, [url, initGl]);

  useEffect(() => {
    if (!ready) return;
    draw(showOriginal
      ? { values: NEUTRAL, bands: [], curves: emptyCurves(), sweep: { ...sweep, on: false }, geo: NO_GEO }
      : {});
  }, [ready, adjust, allBands, curves, sweep, mask, geo, showOriginal, draw]);

  /* Growing the mask is the only heavy thing here, so it runs when its own
     settings change and not on every render. */
  useEffect(() => {
    if (!ready || !sweep.on || !bitmapRef.current) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      try {
        const built = buildBackgroundMask(bitmapRef.current, { tolerance: sweep.tolerance, softness: sweep.softness });
        if (cancelled) return;
        setMask({ data: maskToRgba(built.mask), width: built.width, height: built.height, coverage: built.coverage });
      } catch (e) { if (!cancelled) setErr(e.message || String(e)); }
    }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [ready, sweep.on, sweep.tolerance, sweep.softness]);

  /* ── The model's turn ───────────────────────────────────────────────────── */
  const runAi = async (instruction, mode = "edit") => {
    if (!bitmapRef.current) return;
    setBusy("ai"); setErr("");
    try {
      const recipe = await askGrade({ source: bitmapRef.current, instruction, mode });
      if (mode === "find") {
        // An inventory, not an edit: the ranges arrive at zero for you to push.
        setBands(recipe.bands);
      } else {
        setAdjust(recipe.adjust);
        setBands(recipe.bands);
        setCurves(recipe.curves);
      }
      setSummary(recipe.summary);
    } catch (e) { setErr(e.message || String(e)); } finally { setBusy(""); }
  };

  /* ── Save ───────────────────────────────────────────────────────────────── */
  /* Writing one photo and writing the whole listing are the same loop: bind a
     photo to the texture, run the same shader at full resolution, read it back.
     Only the backdrop mask is per-photo — it is measured off the pixels, so each
     photo in the batch gets its own rather than the current one's. */
  const writeOne = async (bitmap, maskFor) => {
    setSource(bitmap);
    draw({ full: true, bitmap, mask: maskFor });
    const blob = await new Promise((resolve, reject) =>
      canvasRef.current.toBlob(b => (b ? resolve(b) : reject(new Error("Couldn't read the edited photo back."))), "image/jpeg", 0.92));
    const name = `edited-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    return uploadToStorage(`listing-photos/${name}`, new File([blob], name, { type: "image/jpeg" }));
  };

  const maskFrom = bitmap => {
    if (!sweep.on) return null;
    const built = buildBackgroundMask(bitmap, { tolerance: sweep.tolerance, softness: sweep.softness });
    return { data: maskToRgba(built.mask), width: built.width, height: built.height };
  };

  const save = async () => {
    if (!bitmapRef.current || !canvasRef.current) return;
    const batch = applyAll && all;
    setBusy("save"); setErr(""); setProg("");
    try {
      if (!batch) {
        const saved = await writeOne(bitmapRef.current, mask);
        onSave(saved);
        showToast?.("✓ Photo replaced — the original is still in the Image Library");
      } else {
        const out = [...all];
        for (let i = 0; i < all.length; i++) {
          setProg(`${i + 1}/${all.length}`);
          const own = i === index;
          const bitmap = own ? bitmapRef.current : await loadBitmap(all[i]);
          out[i] = await writeOne(bitmap, own ? mask : maskFrom(bitmap));
          if (!own) bitmap.close?.();
        }
        onSaveAll(out);
        showToast?.(`✓ ${all.length} photos edited — the originals are still in the Image Library`);
      }
      onClose();
    } catch (e) {
      setErr(e.message || String(e));
      setSource(bitmapRef.current);
      draw();   // put the preview back at preview size, on the right photo
    } finally { setBusy(""); setProg(""); }
  };

  /* ── Dragging the picture inside the crop ───────────────────────────────── */
  /* The canvas shows the crop, not the photo, so the natural gesture is moving
     the picture behind a fixed frame. A screen pixel is turned into source
     pixels and then rotated by the same angle the shader uses, which is what
     keeps the drag going the way the finger does on a straightened photo. */
  const onDragStart = e => {
    if (!geo.crop.on || !geoRef.current) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, cx: geo.crop.cx, cy: geo.crop.cy,
      rect: e.currentTarget.getBoundingClientRect() };
    setDragging(true);
  };
  const onDragMove = e => {
    const d = dragRef.current, g = geoRef.current;
    if (!d || !g) return;
    const px = -((e.clientX - d.x) / d.rect.width) * g.w;
    const py = -((e.clientY - d.y) / d.rect.height) * g.h;
    setCrop({
      cx: clamp(d.cx + (g.cos * px - g.sin * py) / g.W, 0, 1),
      cy: clamp(d.cy + (g.sin * px + g.cos * py) / g.H, 0, 1),
    });
  };
  const onDragEnd = () => { dragRef.current = null; setDragging(false); };

  const setOne = (key, v) => setAdjust(a => ({ ...a, [key]: v }));
  const setBand = (i, patch) => setBands(bs => bs.map((b, j) => (j === i ? { ...b, ...patch } : b)));

  const btn = (bg, fg) => ({ background: bg, color: fg, border: bg === "transparent" ? `1px solid ${C.border}` : "none",
    borderRadius: 8, padding: "9px 15px", fontSize: 12.5, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" });

  return (
    <div onMouseDown={e => e.target === e.currentTarget && onClose()}
      style={{ position: "fixed", inset: 0, zIndex: 2100, background: "rgba(20,15,8,.78)",
        display: "grid", placeItems: "center", padding: narrow ? 0 : 20 }}>
      <div style={{ background: C.bg, borderRadius: narrow ? 0 : 14, width: "min(1040px,100%)", maxHeight: "100%",
        display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 24px 80px rgba(0,0,0,.45)" }}>

        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
          background: C.surface, borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: C.ink }}>🎛 Edit photo</div>
          <div style={{ fontSize: 11, color: C.inkFaint }}>AI reads the picture · you keep the sliders</div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 22, color: C.inkMid, cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>

        {/* Two columns that scroll on their own: the controls are a long list and
            the picture is the thing being judged, so scrolling the sliders must
            never carry the preview off the top of the screen. */}
        <div style={{ flex: 1, minHeight: 0, display: "grid", gap: 14, padding: 14,
          overflowY: narrow ? "auto" : "hidden",
          gridTemplateColumns: narrow ? "1fr" : "1fr 320px" }}>

          {/* Canvas */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0, minHeight: 0,
            overflowY: narrow ? "visible" : "auto" }}>
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 10,
              display: "grid", placeItems: "center", minHeight: 240 }}>
              <div style={{ position: "relative", display: ready ? "block" : "none", lineHeight: 0 }}>
                <canvas ref={canvasRef}
                  onPointerDown={onDragStart} onPointerMove={onDragMove}
                  onPointerUp={onDragEnd} onPointerCancel={onDragEnd}
                  style={{ maxWidth: "100%", maxHeight: narrow ? 320 : "min(52vh, 460px)", borderRadius: 8,
                    display: "block", touchAction: geo.crop.on ? "none" : "auto",
                    cursor: geo.crop.on ? (dragging ? "grabbing" : "grab") : "default" }} />
                {dragging && (
                  <div style={{ position: "absolute", inset: 0, pointerEvents: "none", borderRadius: 8,
                    backgroundImage: `linear-gradient(to right, transparent calc(33.333% - 1px), rgba(255,255,255,.55) calc(33.333% - 1px), rgba(255,255,255,.55) 33.333%, transparent 33.333%, transparent calc(66.667% - 1px), rgba(255,255,255,.55) calc(66.667% - 1px), rgba(255,255,255,.55) 66.667%, transparent 66.667%), linear-gradient(to bottom, transparent calc(33.333% - 1px), rgba(255,255,255,.55) calc(33.333% - 1px), rgba(255,255,255,.55) 33.333%, transparent 33.333%, transparent calc(66.667% - 1px), rgba(255,255,255,.55) calc(66.667% - 1px), rgba(255,255,255,.55) 66.667%, transparent 66.667%)`,
                    boxShadow: "inset 0 0 0 1px rgba(255,255,255,.6)" }} />
                )}
              </div>
              {!ready && <div style={{ fontSize: 12, color: C.inkFaint }}>{err ? "—" : "Loading the photo…"}</div>}
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button type="button"
                onMouseDown={() => setShowOriginal(true)} onMouseUp={() => setShowOriginal(false)}
                onMouseLeave={() => setShowOriginal(false)}
                onTouchStart={() => setShowOriginal(true)} onTouchEnd={() => setShowOriginal(false)}
                disabled={!touched} style={{ ...btn("transparent", C.ink), opacity: touched ? 1 : .45 }}>
                👁 Hold to compare
              </button>
              <button type="button" onClick={() => { setAdjust(NEUTRAL); setBands([]); setCurves(emptyCurves()); setMixer(emptyMixer()); setSweep(s => ({ ...s, on: false })); setGeo(NO_GEO); setSummary(""); }}
                disabled={!touched} style={{ ...btn("transparent", C.ink), opacity: touched ? 1 : .45 }}>
                Reset
              </button>
              <span style={{ flex: 1 }} />
              {all && (
                <label title="These were shot in one sitting under one light — the same correction usually fits all of them."
                  style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 11.5, fontWeight: 700, color: C.inkMid }}>
                  <input type="checkbox" checked={applyAll} onChange={e => setApplyAll(e.target.checked)}
                    disabled={!!busy} style={{ accentColor: C.teal }} />
                  Apply to all {all.length}
                </label>
              )}
              <button type="button" onClick={save} disabled={!ready || !!busy || !touched}
                style={{ ...btn(C.ink, "#FAF0DC"), opacity: !ready || busy || !touched ? .5 : 1 }}>
                {busy === "save"
                  ? (prog ? `Saving ${prog}…` : "Saving…")
                  : (applyAll && all ? `Save all ${all.length}` : "Save to listing")}
              </button>
            </div>

            {err && <div style={{ fontSize: 12, color: C.red, background: C.redBg, border: `1px solid ${C.red}30`,
              borderRadius: 8, padding: "8px 10px", lineHeight: 1.5 }}>{err}</div>}
          </div>

          {/* Controls */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0, minHeight: 0,
            overflowY: narrow ? "visible" : "auto", paddingRight: narrow ? 0 : 4 }}>
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, display: "grid", gap: 8 }}>
              <label style={lab}>Tell it what you want</label>
              <textarea value={ask} onChange={e => setAsk(e.target.value)} rows={2}
                placeholder="more purple in the spots, warmer overall…"
                style={{ ...FI(), fontSize: 12, resize: "vertical" }} />
              <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                <button type="button" onClick={() => runAi(ask.trim() || "Make this a clean, true-to-life product photo.")}
                  disabled={!ready || !!busy} style={{ ...btn(C.gold, "#fff"), opacity: !ready || busy ? .5 : 1 }}>
                  {busy === "ai" ? "✨ Reading the photo…" : "✨ Ask AI"}
                </button>
                <button type="button" onClick={() => runAi("Auto-correct this product photo: exposure, white balance, a natural amount of contrast and clarity. Keep the stone's colour honest.")}
                  disabled={!ready || !!busy} style={{ ...btn("transparent", C.ink), opacity: !ready || busy ? .5 : 1 }}>
                  Auto
                </button>
                <button type="button" onClick={() => runAi("Which colours are in this stone?", "find")}
                  disabled={!ready || !!busy} style={{ ...btn("transparent", C.ink), opacity: !ready || busy ? .5 : 1 }}>
                  {busy === "ai" ? "…" : "🎨 Find colours"}
                </button>
              </div>
              {summary && <div style={{ fontSize: 11.5, color: C.inkMid, lineHeight: 1.5, borderTop: `1px solid ${C.border}`, paddingTop: 8 }}>{summary}</div>}
            </div>

            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, display: "grid", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={lab}>Frame</span>
                <span style={{ flex: 1 }} />
                <button type="button" title="Turn left" onClick={() => setGeo(g => ({ ...g, rotate: (g.rotate + 3) % 4 }))}
                  style={{ ...btn("transparent", C.ink), padding: "5px 9px", fontSize: 13 }}>↺</button>
                <button type="button" title="Turn right" onClick={() => setGeo(g => ({ ...g, rotate: (g.rotate + 1) % 4 }))}
                  style={{ ...btn("transparent", C.ink), padding: "5px 9px", fontSize: 13 }}>↻</button>
              </div>

              <Slider label="Straighten" hint="a hand-held shot is never quite level" min={-15} max={15} step={0.5} unit="°"
                value={geo.straighten} onChange={v => setGeo(g => ({ ...g, straighten: v }))}
                onReset={() => setGeo(g => ({ ...g, straighten: 0 }))} />
              {geo.straighten !== 0 && !geo.crop.on && (
                <div style={{ fontSize: 11, color: C.inkFaint, lineHeight: 1.5 }}>
                  Trimmed in to the largest upright rectangle the tilt still leaves — a straighten never opens an empty corner.
                </div>
              )}

              <label style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
                <input type="checkbox" checked={geo.crop.on} onChange={e => setCrop({ on: e.target.checked })}
                  style={{ accentColor: C.teal }} />
                <span style={lab}>Crop to a shape</span>
              </label>
              {!geo.crop.on && (
                <div style={{ fontSize: 11, color: C.inkFaint, lineHeight: 1.5 }}>
                  Cuts the photo to a fixed shape — square for the shop grid, 4:5 for Instagram. Nothing is stretched; the long side is trimmed.
                </div>
              )}
              {geo.crop.on && (
                <>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {ASPECTS.filter(a => !a.video).map(a => (
                      <button key={a.key} type="button" onClick={() => setCrop({ aspect: a.key })} title={a.hint}
                        style={{ ...btn(geo.crop.aspect === a.key ? C.teal : "transparent", geo.crop.aspect === a.key ? "#fff" : C.ink),
                          padding: "6px 10px", fontSize: 11.5 }}>
                        {a.label}
                      </button>
                    ))}
                  </div>
                  <Slider label="Zoom" hint="drag the picture to move it in the frame" min={0} max={100} signed={false}
                    value={geo.crop.zoom} onChange={v => setCrop({ zoom: v })} onReset={() => setCrop({ zoom: 0 })} />
                  {dims && (() => {
                    const g = cropGeometry(dims, geo);
                    return (
                      <div style={{ fontSize: 11, color: C.inkFaint, lineHeight: 1.5 }}>
                        {Math.round(g.w)} × {Math.round(g.h)} px from a {dims.w} × {dims.h} original.
                      </div>
                    );
                  })()}
                </>
              )}
            </div>

            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, display: "grid", gap: 10 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer" }}>
                <input type="checkbox" checked={sweep.on} onChange={e => setSweep(v => ({ ...v, on: e.target.checked }))}
                  style={{ accentColor: C.teal }} />
                <span style={lab}>White background</span>
              </label>
              {!sweep.on && (
                <div style={{ fontSize: 11, color: C.inkFaint, lineHeight: 1.5 }}>
                  Sweeps the backdrop to pure white by growing in from the edge of the frame — a pale face on the stone stays put, because it isn't joined to the border.
                </div>
              )}
              {sweep.on && (
                <>
                  <Slider label="Tolerance" hint="how far from the backdrop still counts" min={4} max={90} signed={false}
                    value={sweep.tolerance} onChange={v => setSweep(x => ({ ...x, tolerance: v }))} onReset={() => setSweep(x => ({ ...x, tolerance: 30 }))} />
                  <Slider label="Edge softness" min={0} max={8} signed={false}
                    value={sweep.softness} onChange={v => setSweep(x => ({ ...x, softness: v }))} onReset={() => setSweep(x => ({ ...x, softness: 2 }))} />
                  <Slider label="Strength" hint="part way cleans up, all the way is pure white" min={0} max={100} signed={false}
                    value={sweep.strength} onChange={v => setSweep(x => ({ ...x, strength: v }))} onReset={() => setSweep(x => ({ ...x, strength: 100 }))} />
                  {mask && (
                    <div style={{ fontSize: 11, lineHeight: 1.5,
                      color: mask.coverage < 0.04 || mask.coverage > 0.85 ? C.red : C.inkFaint }}>
                      {mask.coverage < 0.04
                        ? "Almost no continuous backdrop found — a hand shot has none. Use Remove background (Canva) for those."
                        : mask.coverage > 0.85
                          ? "That is claiming nearly the whole frame. Lower the tolerance before saving."
                          : `Backdrop covers ${Math.round(mask.coverage * 100)}% of the frame.`}
                    </div>
                  )}
                </>
              )}
            </div>

            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, display: "grid", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <span style={lab}>Colours in this photo</span>
                <span style={{ fontSize: 9.5, color: C.inkFaint }}>measured, not guessed</span>
              </div>
                {bands.length === 0 && (
                <div style={{ fontSize: 11, color: C.inkFaint, lineHeight: 1.5 }}>
                  Hit <strong>Find colours</strong> and the model reads the ranges this stone actually has — then push them here.
                </div>
                )}
                {bands.map((b, i) => (
                <div key={i} style={{ display: "grid", gap: 6, borderTop: i ? `1px solid ${C.border}` : "none", paddingTop: i ? 10 : 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={{ width: 14, height: 14, borderRadius: "50%", flexShrink: 0,
                      background: `hsl(${b.center} 70% 50%)`, border: `1px solid ${C.border}` }} />
                    <span style={{ fontSize: 12, fontWeight: 700, color: C.ink, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</span>
                    <span style={{ fontSize: 10, color: C.inkFaint }}>{Math.round(b.center)}°</span>
                    <button type="button" onClick={() => setBands(bs => bs.filter((_, j) => j !== i))}
                      style={{ background: "none", border: "none", color: C.inkFaint, cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
                  </div>
                  <Slider label="Saturation" value={Math.round(b.sat)} onChange={v => setBand(i, { sat: v })} onReset={() => setBand(i, { sat: 0 })} />
                  <Slider label="Brightness" value={Math.round(b.lum)} onChange={v => setBand(i, { lum: v })} onReset={() => setBand(i, { lum: 0 })} />
                  <Slider label="Hue" min={-30} max={30} value={Math.round(b.hue)} onChange={v => setBand(i, { hue: v })} onReset={() => setBand(i, { hue: 0 })} />
                  <Slider label="Range" hint="how wide a slice it takes" min={8} max={180} signed={false}
                    value={Math.round(b.width)} onChange={v => setBand(i, { width: v })} onReset={() => setBand(i, { width: 40 })} />
                </div>
                ))}
              </div>

            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, display: "grid", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <span style={lab}>Colour mixer</span>
                <span style={{ fontSize: 9.5, color: C.inkFaint }}>one colour at a time</span>
              </div>
              <div style={{ display: "flex", gap: 5 }}>
                {MIXER.map(m => {
                  const on = mixKey === m.key;
                  const used = !!(mixer[m.key].hue || mixer[m.key].sat || mixer[m.key].lum);
                  return (
                    <button key={m.key} type="button" onClick={() => setMixKey(m.key)} title={m.label}
                      style={{ flex: 1, height: 26, borderRadius: 6, cursor: "pointer", background: m.swatch,
                        border: on ? `2.5px solid ${C.ink}` : `1px solid ${C.border}`, position: "relative", padding: 0 }}>
                      {used && <span style={{ position: "absolute", top: 2, right: 3, color: "#fff", fontSize: 11, lineHeight: 1, textShadow: "0 1px 2px rgba(0,0,0,.5)" }}>•</span>}
                    </button>
                  );
                })}
              </div>
              <div style={{ fontSize: 11.5, fontWeight: 800, color: C.ink }}>{MIXER.find(m => m.key === mixKey)?.label}</div>
              {[["hue", "Hue"], ["sat", "Saturation"], ["lum", "Brightness"]].map(([k, label]) => (
                <Slider key={k} label={label} value={mixer[mixKey][k]}
                  onChange={v => setMixer(mx => ({ ...mx, [mixKey]: { ...mx[mixKey], [k]: v } }))}
                  onReset={() => setMixer(mx => ({ ...mx, [mixKey]: { ...mx[mixKey], [k]: 0 } }))} />
              ))}
            </div>

            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, display: "grid", gap: 10 }}>
              <span style={lab}>Curves</span>
              <CurveEditor curves={curves} onChange={setCurves} size={252} />
            </div>


            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, display: "grid", gap: 11 }}>
              {ADJUSTMENTS.map(a => (
                <Slider key={a.key} label={a.label} hint={a.hint} value={adjust[a.key]}
                  onChange={v => setOne(a.key, v)} onReset={() => setOne(a.key, 0)} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
