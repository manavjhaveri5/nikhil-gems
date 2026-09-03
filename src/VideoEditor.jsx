import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { C, mob, FI } from "./lmTheme.js";
import { uploadToStorage } from "./storageUtils.js";
import { CurveEditor, emptyCurves, curvesTouched } from "./ToneCurve.jsx";
import { askGrade } from "./gradeAi.js";
import {
  ADJUSTMENTS, NEUTRAL, MIXER, emptyMixer, mixerTouched, mixerBands, MAX_BANDS,
  ASPECTS, NO_GEO, clamp, cropGeometry, geoTouched,
  createPipeline, setPipelineSource, renderPipeline,
} from "./glPipeline.js";
import { lab, Slider } from "./EditorControls.jsx";
import {
  ETSY_MAX_SECONDS, ETSY_MIN_SECONDS, openClip, closeClip, clipLength, totalLength,
  frameSink, buildFilmstrip, canCopy, keyframeBefore, exportVideo,
} from "./videoLab.js";

/* The listing video, cut in the app rather than in another program.

   It is the photo editor with a time axis: the same shader, the same sliders,
   the same AI reading the same stone — a listing's clip was shot alongside its
   photos, so it wants the same correction. What time adds is where the clip
   starts and stops, and the fact that several takes can be strung together.

   The important promise is that trimming costs nothing. Cutting a clip and
   joining two takes don't change a single pixel, so when that is all the seller
   did, the frames are moved across untouched and the file can be re-cut as
   often as they like without a generation of quality going missing. Touch a
   colour slider or the crop and that stops being true — so the editor says
   which of the two it is about to do, in the export button itself. */

const FILMSTRIP = 12;

/* Spend the 15 seconds from the front: each take keeps what is left of the
   budget when its turn comes, and a take that starts past the end is dropped.
   Only the cut points move — nothing is thrown away. */
const etsyCut = clips => {
  let left = ETSY_MAX_SECONDS;
  return clips.map(c => {
    const keep = Math.min(clipLength(c), Math.max(0, left));
    left -= keep;
    return { ...c, out: c.in + keep };
  }).filter(c => clipLength(c) > 0.05);
};
const fmt = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

/* Quality only matters on the re-encoded path, and it is a quantizer, not a
   bitrate: the encoder spends what the picture needs. 18 is the point where a
   stone on a white sweep stops being distinguishable from its source. */
const QUALITIES = [
  { key: "max",  label: "Maximum",  hint: "indistinguishable from the source", q: 16 },
  { key: "high", label: "High",     hint: "the sensible default", q: 21 },
  { key: "small",label: "Smaller",  hint: "when the file has to fit", q: 27 },
];

/* One clip's row: a strip of stills with the kept span lit and the two ends
   draggable. The strip is of the whole clip, never of the trim — so pulling a
   handle in doesn't move the picture the seller is aiming at. */
function ClipTrack({ clip, strip, active, playhead, onTrim, onSeek, onRemove, onMove, first, last }) {
  const barRef = useRef(null);
  const dragRef = useRef(null);
  const at = e => {
    const r = barRef.current.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1) * clip.duration;
  };
  const down = (which, e) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = which;
  };
  const move = e => {
    if (!dragRef.current) return;
    const t = at(e);
    if (dragRef.current === "in") onTrim({ in: Math.min(t, clip.out - 0.1) });
    else onTrim({ out: Math.max(t, clip.in + 0.1) });
  };
  const up = () => { dragRef.current = null; };

  const pct = t => `${(t / clip.duration) * 100}%`;
  const handle = {
    position: "absolute", top: -2, bottom: -2, width: 14, marginLeft: -7, cursor: "ew-resize",
    display: "grid", placeItems: "center", zIndex: 2, touchAction: "none",
  };

  return (
    <div style={{ display: "grid", gap: 5 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 800, color: active ? C.teal : C.inkMid,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 190 }}>
          {clip.label}
        </span>
        <span style={{ fontSize: 10, color: C.inkFaint }}>
          {clip.width}×{clip.height} · {clipLength(clip).toFixed(1)}s of {clip.duration.toFixed(1)}s
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={() => onMove(-1)} disabled={first} title="Earlier in the video"
          style={{ background: "none", border: "none", cursor: first ? "default" : "pointer", color: first ? C.inkFaint : C.inkMid, fontSize: 13, padding: "0 2px", opacity: first ? .4 : 1 }}>↑</button>
        <button type="button" onClick={() => onMove(1)} disabled={last} title="Later in the video"
          style={{ background: "none", border: "none", cursor: last ? "default" : "pointer", color: last ? C.inkFaint : C.inkMid, fontSize: 13, padding: "0 2px", opacity: last ? .4 : 1 }}>↓</button>
        <button type="button" onClick={onRemove} title="Take this clip out"
          style={{ background: "none", border: "none", cursor: "pointer", color: C.inkFaint, fontSize: 14, padding: "0 2px" }}>×</button>
      </div>

      <div ref={barRef} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        onClick={e => { if (!dragRef.current) onSeek(at(e)); }}
        style={{ position: "relative", height: 44, borderRadius: 7, overflow: "hidden", cursor: "pointer",
          background: "#111", border: `1px solid ${active ? C.teal : C.border}`, display: "flex", touchAction: "none" }}>
        {strip.length
          ? strip.map((src, i) => (
              <div key={i} style={{ flex: 1, minWidth: 0, backgroundImage: src ? `url(${src})` : "none",
                backgroundSize: "cover", backgroundPosition: "center" }} />
            ))
          : <div style={{ flex: 1, display: "grid", placeItems: "center", fontSize: 10, color: "#888" }}>reading the clip…</div>}

        {/* Everything outside the cut is dimmed rather than hidden — the seller
            can see what they are giving up and pull it back. */}
        <div style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: pct(clip.in), background: "rgba(0,0,0,.62)" }} />
        <div style={{ position: "absolute", top: 0, bottom: 0, right: 0, width: pct(clip.duration - clip.out), background: "rgba(0,0,0,.62)" }} />
        <div style={{ position: "absolute", top: 0, bottom: 0, left: pct(clip.in), width: pct(clipLength(clip)),
          border: `2px solid ${C.gold}`, borderRadius: 5, pointerEvents: "none" }} />

        <div onPointerDown={e => down("in", e)} style={{ ...handle, left: pct(clip.in) }}>
          <div style={{ width: 4, height: "100%", background: C.gold, borderRadius: 2 }} />
        </div>
        <div onPointerDown={e => down("out", e)} style={{ ...handle, left: pct(clip.out) }}>
          <div style={{ width: 4, height: "100%", background: C.gold, borderRadius: 2 }} />
        </div>

        {active && playhead >= 0 && (
          <div style={{ position: "absolute", top: 0, bottom: 0, left: pct(playhead), width: 2, marginLeft: -1,
            background: "#fff", boxShadow: "0 0 4px rgba(0,0,0,.8)", pointerEvents: "none" }} />
        )}
      </div>
    </div>
  );
}

/* The editor opens on one clip or on several. A listing can be shot in two or
   three takes, and the seller shouldn't have to upload one, edit, upload the
   next: hand them all in together and they arrive as a joined timeline, in the
   order they were picked, ready to be trimmed. */
export default function VideoEditor({ url, urls, recipe, onSave, onClose, showToast }) {
  const canvasRef = useRef(null);
  const glRef = useRef(null);
  const sinksRef = useRef(new Map());     // clip id → CanvasSink, built once per clip
  const frameRef = useRef(null);          // the decoded frame currently on screen
  const playRef = useRef(false);
  const seekRef = useRef(0);              // generation counter, so a stale decode can't paint
  const fileRef = useRef(null);
  const dragRef = useRef(null);

  const [clips, setClips] = useState([]);
  const [strips, setStrips] = useState({});   // clip id → data URLs
  const [ready, setReady] = useState(false);
  const [playhead, setPlayhead] = useState(0); // seconds along the joined timeline
  const [playing, setPlaying] = useState(false);

  const [adjust, setAdjust] = useState(NEUTRAL);
  const [bands, setBands] = useState([]);
  const [curves, setCurves] = useState(emptyCurves);
  const [mixer, setMixer] = useState(emptyMixer);
  const [geo, setGeo] = useState(NO_GEO);
  const setCrop = patch => setGeo(g => ({ ...g, crop: { ...g.crop, ...patch } }));

  const [quality, setQuality] = useState("high");
  const [mixKey, setMixKey] = useState("blue");
  const [ask, setAsk] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState("");
  const [prog, setProg] = useState(0);
  const [err, setErr] = useState("");
  const [showOriginal, setShowOriginal] = useState(false);
  const [note, setNote] = useState("");        // something the editor did on the seller's behalf
  const [snaps, setSnaps] = useState({});     // clip id → where a copied cut really starts
  const [narrow, setNarrow] = useState(mob);
  useEffect(() => {
    const onResize = () => setNarrow(mob());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const graded = ADJUSTMENTS.some(a => adjust[a.key] !== 0) || bands.length > 0
    || curvesTouched(curves) || mixerTouched(mixer) || geoTouched(geo);
  const trimmed = clips.some(c => c.in > 0.001 || c.out < c.duration - 0.001);
  const touched = graded || trimmed || clips.length > 1;
  const allBands = useMemo(() => [...mixerBands(mixer), ...bands].slice(0, MAX_BANDS), [mixer, bands]);

  const total = totalLength(clips);
  const overEtsy = total > ETSY_MAX_SECONDS + 0.05;
  const copy = useMemo(() => canCopy({ clips, recipeTouched: graded }), [clips, graded]);

  /* Where the playhead is, in clip terms. The timeline the seller drags along
     is the joined one; every decode has to be asked of a particular clip. */
  const locate = useCallback(t => {
    let acc = 0;
    for (const c of clips) {
      const len = clipLength(c);
      if (t < acc + len || c === clips[clips.length - 1]) return { clip: c, local: clamp(c.in + (t - acc), c.in, c.out), acc };
      acc += len;
    }
    return null;
  }, [clips]);
  const here = locate(playhead);

  /* ── Loading ────────────────────────────────────────────────────────────── */
  const addClip = useCallback(async src => {
    setBusy("open"); setErr("");
    try {
      const clip = await openClip(src);
      setClips(cs => [...cs, clip]);
      buildFilmstrip(clip, FILMSTRIP)
        .then(canvases => setStrips(s => ({ ...s, [clip.id]: canvases.map(c => (c ? c.toDataURL("image/jpeg", 0.6) : null)) })))
        .catch(() => {});
      return clip;
    } catch (e) { setErr(e.message || String(e)); return null; }
    finally { setBusy(""); }
  }, []);

  /* Several at once, opened one after another rather than in parallel: each
     clip holds a decoder, and racing them on a phone is how the tab runs out
     of memory. The order the seller picked is the order they play in. */
  const addClips = useCallback(async list => {
    const opened = [];
    for (const src of list) { const c = await addClip(src); if (c) opened.push(c); }
    return opened;
  }, [addClip]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      try {
        const ctx = createPipeline(canvas);
        if (!ctx) throw new Error("This browser has no WebGL, so the editor can't run here.");
        glRef.current = ctx;
        const seeds = (urls && urls.length ? urls : [url]).filter(Boolean);
        const opened = await addClips(seeds);
        if (cancelled || !opened.length) return;

        /* An edit is stored as its ingredients, not as its result: the takes it
           was cut from, where each one starts and stops, and the look. So
           reopening it puts every slider and handle back where the last person
           left them — the picture on screen is rebuilt from the original takes,
           not from their export, and no generation of quality is lost however
           many times the listing is revisited. */
        if (recipe) {
          const cuts = recipe.clips || [];
          if (cuts.length) setClips(cs => cs.map((c, i) => (cuts[i]
            ? { ...c, in: clamp(+cuts[i].in || 0, 0, c.duration), out: clamp(+cuts[i].out ?? c.duration, 0, c.duration) }
            : c)));
          const look = recipe.look || {};
          if (look.adjust) setAdjust({ ...NEUTRAL, ...look.adjust });
          if (look.bands) setBands(look.bands);
          if (look.curves) setCurves(look.curves);
          if (look.mixer) setMixer(look.mixer);
          if (look.geo) setGeo(look.geo);
          if (recipe.quality) setQuality(recipe.quality);
        } else if (seeds.length > 1 && totalLength(opened) > ETSY_MAX_SECONDS + 0.05) {
          /* Several takes handed in at once will almost always overrun Etsy's
             15 seconds together. Cutting them back is what the seller was going
             to do anyway, so it is done for them — and said, because the frames
             are only hidden, not gone, and the handles pull them back. */
          setClips(etsyCut);
          setNote(`Cut to Etsy's ${ETSY_MAX_SECONDS}s across ${opened.length} takes — drag the handles to choose what to keep.`);
        }
        setReady(true);
      } catch (e) { if (!cancelled) setErr(e.message || String(e)); }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // Every clip holds an open reader on its file; drop them when the editor closes.
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  useEffect(() => () => { clipsRef.current.forEach(closeClip); }, []);

  const sinkFor = useCallback(clip => {
    let sink = sinksRef.current.get(clip.id);
    if (!sink) {
      // Tall enough that the grade can be judged, small enough to decode at speed.
      sink = frameSink(clip, { height: Math.min(clip.height, 540) });
      sinksRef.current.set(clip.id, sink);
    }
    return sink;
  }, []);

  /* ── Painting ───────────────────────────────────────────────────────────── */
  const paint = useCallback(o => {
    const ctx = glRef.current, canvas = canvasRef.current, frame = frameRef.current;
    if (!ctx || !canvas || !frame) return;
    setPipelineSource(ctx, frame);
    renderPipeline(ctx, canvas, {
      sw: frame.width, sh: frame.height,
      values: o?.plain ? NEUTRAL : adjust,
      bands: o?.plain ? [] : allBands,
      curves: o?.plain ? emptyCurves() : curves,
      geo: o?.plain ? NO_GEO : geo,
    });
  }, [adjust, allBands, curves, geo]);

  // A recipe change repaints the frame already in hand — no second decode.
  useEffect(() => { paint({ plain: showOriginal }); }, [paint, showOriginal]);

  const showFrame = useCallback(async (clip, local) => {
    const gen = ++seekRef.current;
    const wrapped = await sinkFor(clip).getCanvas(local);
    if (!wrapped || gen !== seekRef.current) return;
    frameRef.current = wrapped.canvas;
    paint({ plain: showOriginal });
  }, [sinkFor, paint, showOriginal]);

  // Land on the first frame as soon as the first clip is open.
  useEffect(() => {
    if (!ready || !here || playing) return;
    showFrame(here.clip, here.local);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, playhead, clips.length]);

  /* Playback decodes forward rather than seeking per frame: the sink is built
     to stream in order, and each frame is held back until its own timestamp
     comes round on the wall clock. Muted throughout — Etsy plays listing videos
     muted, and there is nothing here to listen for. */
  const play = useCallback(async () => {
    if (!clips.length) return;
    playRef.current = true;
    setPlaying(true);
    const startWall = performance.now();
    const startAt = playhead >= total - 0.05 ? 0 : playhead;
    let cursor = startAt;
    try {
      let acc = 0;
      for (const clip of clips) {
        const len = clipLength(clip);
        if (startAt >= acc + len) { acc += len; continue; }
        const from = Math.max(clip.in, clip.in + (startAt - acc));
        for await (const frame of sinkFor(clip).canvases(from, clip.out)) {
          if (!playRef.current) return;
          cursor = acc + (frame.timestamp - clip.in);
          const wait = (cursor - startAt) * 1000 - (performance.now() - startWall);
          if (wait > 4) await new Promise(r => setTimeout(r, wait));
          if (!playRef.current) return;
          frameRef.current = frame.canvas;
          paint({ plain: showOriginal });
          setPlayhead(cursor);
        }
        acc += len;
      }
      setPlayhead(total);
    } catch (e) { setErr(e.message || String(e)); }
    finally { playRef.current = false; setPlaying(false); }
  }, [clips, playhead, total, sinkFor, paint, showOriginal]);

  const stop = () => { playRef.current = false; setPlaying(false); };
  const seek = t => { stop(); setPlayhead(clamp(t, 0, Math.max(0, total - 0.01))); };

  /* ── The model's turn ───────────────────────────────────────────────────── */
  /* It reads the frame on screen. That is the honest thing to show it: a clip
     of a stone turning is the same stone in every frame, and the seller has
     already parked the playhead on the moment they care about. */
  const runAi = async (instruction, mode = "edit") => {
    if (!frameRef.current) return;
    setBusy("ai"); setErr("");
    try {
      const recipe = await askGrade({ source: frameRef.current, instruction, mode });
      if (mode === "find") setBands(recipe.bands);
      else { setAdjust(recipe.adjust); setBands(recipe.bands); setCurves(recipe.curves); }
      setSummary(recipe.summary);
    } catch (e) { setErr(e.message || String(e)); } finally { setBusy(""); }
  };

  /* ── Where a lossless cut really lands ──────────────────────────────────── */
  /* Only asked while the copy path is live, and only for clips cut away from
     their start: the answer costs a seek into the file. */
  useEffect(() => {
    if (!copy.ok) { setSnaps({}); return undefined; }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const next = {};
      for (const c of clips) {
        if (c.in <= 0.001) continue;
        try { next[c.id] = await keyframeBefore(c, c.in); } catch {}
      }
      if (!cancelled) setSnaps(next);
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [clips, copy.ok]);
  const snapDrift = clips.reduce((n, c) => n + (snaps[c.id] !== undefined ? Math.max(0, c.in - snaps[c.id]) : 0), 0);

  /* ── Export ─────────────────────────────────────────────────────────────── */
  const cancelRef = useRef(false);
  const save = async () => {
    if (!clips.length) return;
    stop();
    cancelRef.current = false;
    setBusy("save"); setErr(""); setProg(0);
    try {
      const { blob, lossless } = await exportVideo({
        clips,
        recipe: { touched: graded, adjust, bands: allBands, curves, geo },
        quantizer: (QUALITIES.find(q => q.key === quality) || QUALITIES[1]).q,
        onProgress: p => setProg(p),
        cancelled: () => cancelRef.current,
      });
      /* Every take has to outlive this export, or the edit stops being an edit
         and becomes the only copy. A take dragged in from the desktop has no
         URL yet, so it is stored now — untouched, exactly as it was shot — and
         the recipe points at it. That is what lets the next person open this
         video, see the original, move one slider, and re-render from the
         source rather than from someone else's compression. */
      const sources = [];
      for (const c of clips) {
        if (c.url) { sources.push(c.url); continue; }
        const sname = `take-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
        sources.push(await uploadToStorage(`listing-videos/${sname}`, new File([c.blob], sname, { type: c.blob.type || "video/mp4" })));
      }
      const name = `edited-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
      const saved = await uploadToStorage(`listing-videos/${name}`, new File([blob], name, { type: "video/mp4" }));
      onSave(saved, {
        sources,
        clips: clips.map((c, i) => ({ src: sources[i], in: c.in, out: c.out, label: c.label })),
        look: { adjust, bands, curves, mixer, geo },
        quality, seconds: +total.toFixed(2), lossless, at: new Date().toISOString(),
      });
      showToast?.(lossless
        ? `✓ Video re-cut to ${total.toFixed(1)}s — same frames, nothing re-encoded`
        : `✓ Video rebuilt at ${total.toFixed(1)}s`);
      onClose();
    } catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(""); setProg(0); }
  };

  /* ── Dragging the picture inside the crop ───────────────────────────────── */
  const onDragStart = e => {
    if (!geo.crop.on) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, cx: geo.crop.cx, cy: geo.crop.cy,
      rect: e.currentTarget.getBoundingClientRect(), frame: frameRef.current };
  };
  const onDragMove = e => {
    const d = dragRef.current;
    if (!d || !d.frame) return;
    const g = cropGeometry({ w: d.frame.width, h: d.frame.height }, geo);
    const px = -((e.clientX - d.x) / d.rect.width) * g.w;
    const py = -((e.clientY - d.y) / d.rect.height) * g.h;
    setCrop({
      cx: clamp(d.cx + (g.cos * px - g.sin * py) / g.W, 0, 1),
      cy: clamp(d.cy + (g.sin * px + g.cos * py) / g.H, 0, 1),
    });
  };
  const onDragEnd = () => { dragRef.current = null; };

  const patchClip = (id, patch) => setClips(cs => cs.map(c => (c.id === id ? { ...c, ...patch } : c)));
  const setOne = (key, v) => setAdjust(a => ({ ...a, [key]: v }));
  const setBand = (i, patch) => setBands(bs => bs.map((b, j) => (j === i ? { ...b, ...patch } : b)));

  /* Cut the tail off wherever the 15 seconds run out, clip by clip. Anything
     past the limit goes; a clip that starts beyond it is dropped whole. */
  const trimToEtsy = () => setClips(etsyCut);

  /* Back to the takes as they were shot: full length, no grade, no crop. The
     files themselves were never touched, so this is always available. */
  const resetAll = () => {
    stop();
    setClips(cs => cs.map(c => ({ ...c, in: 0, out: c.duration })));
    setAdjust(NEUTRAL); setBands([]); setCurves(emptyCurves()); setMixer(emptyMixer());
    setGeo(NO_GEO); setSummary(""); setNote("Back to the original takes.");
    setPlayhead(0);
  };

  const btn = (bg, fg) => ({ background: bg, color: fg, border: bg === "transparent" ? `1px solid ${C.border}` : "none",
    borderRadius: 8, padding: "9px 15px", fontSize: 12.5, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" });
  const panel = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, display: "grid", gap: 10 };

  return (
    <div onMouseDown={e => e.target === e.currentTarget && onClose()}
      style={{ position: "fixed", inset: 0, zIndex: 2100, background: "rgba(20,15,8,.78)",
        display: "grid", placeItems: "center", padding: narrow ? 0 : 20 }}>
      <div style={{ background: C.bg, borderRadius: narrow ? 0 : 14, width: "min(1100px,100%)", maxHeight: "100%",
        display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 24px 80px rgba(0,0,0,.45)" }}>

        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
          background: C.surface, borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: C.ink }}>🎬 Edit video</div>
          <div style={{ fontSize: 11, color: C.inkFaint }}>
            {recipe?.at
              ? `Reopened from the original takes · last edited ${recipe.by ? `by ${recipe.by} ` : ""}${new Date(recipe.at).toLocaleDateString()}`
              : `Trim, join, crop and grade · Etsy takes ${ETSY_MAX_SECONDS}s`}
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 22, color: C.inkMid, cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>

        <div style={{ flex: 1, minHeight: 0, display: "grid", gap: 14, padding: 14,
          overflowY: narrow ? "auto" : "hidden",
          gridTemplateColumns: narrow ? "1fr" : "1fr 320px" }}>

          {/* ── Picture and timeline ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0, minHeight: 0,
            overflowY: narrow ? "visible" : "auto" }}>
            {note && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, lineHeight: 1.5,
                background: C.card, border: `1px solid ${C.border}`, borderRadius: 9, padding: "7px 10px", color: C.inkMid }}>
                <span>{note}</span>
                <span style={{ flex: 1 }} />
                <button type="button" onClick={() => setNote("")}
                  style={{ background: "none", border: "none", color: C.inkFaint, fontSize: 15, cursor: "pointer", lineHeight: 1 }}>×</button>
              </div>
            )}
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 10,
              display: "grid", placeItems: "center", minHeight: 220 }}>
              <canvas ref={canvasRef}
                onPointerDown={onDragStart} onPointerMove={onDragMove}
                onPointerUp={onDragEnd} onPointerCancel={onDragEnd}
                style={{ maxWidth: "100%", maxHeight: narrow ? 300 : "min(46vh, 420px)", borderRadius: 8,
                  display: ready ? "block" : "none", background: "#000",
                  touchAction: geo.crop.on ? "none" : "auto", cursor: geo.crop.on ? "grab" : "default" }} />
              {!ready && <div style={{ fontSize: 12, color: C.inkFaint }}>{err ? "—" : "Reading the video…"}</div>}
            </div>

            {/* Transport */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button type="button" onClick={() => (playing ? stop() : play())} disabled={!ready}
                style={{ ...btn(C.ink, "#FAF0DC"), padding: "8px 14px" }}>
                {playing ? "❚❚ Pause" : "▶ Play"}
              </button>
              <button type="button" onClick={() => seek(0)} disabled={!ready} style={{ ...btn("transparent", C.ink), padding: "8px 12px" }}>⏮</button>
              <span style={{ fontSize: 11.5, fontWeight: 700, color: C.inkMid, fontVariantNumeric: "tabular-nums" }}>
                {fmt(playhead)} / {fmt(total)}
              </span>
              <span style={{ flex: 1 }} />
              <button type="button"
                onMouseDown={() => setShowOriginal(true)} onMouseUp={() => setShowOriginal(false)}
                onMouseLeave={() => setShowOriginal(false)}
                onTouchStart={() => setShowOriginal(true)} onTouchEnd={() => setShowOriginal(false)}
                disabled={!graded} style={{ ...btn("transparent", C.ink), opacity: graded ? 1 : .45 }}>
                👁 Hold to compare
              </button>
            </div>

            {/* The budget. Etsy is the tightest of the marketplaces, so its limit
                is the one drawn — and it is drawn as a bar because the seller is
                spending seconds across several takes. */}
            <div style={{ ...panel, gap: 8 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <span style={lab}>Length</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 12, fontWeight: 800, fontVariantNumeric: "tabular-nums",
                  color: overEtsy ? C.red : total < ETSY_MIN_SECONDS ? C.amber : C.green }}>
                  {total.toFixed(1)}s / {ETSY_MAX_SECONDS}s
                </span>
              </div>
              <div style={{ height: 7, borderRadius: 4, background: C.border, overflow: "hidden" }}>
                <div style={{ width: `${Math.min(100, (total / ETSY_MAX_SECONDS) * 100)}%`, height: "100%",
                  background: overEtsy ? C.red : total < ETSY_MIN_SECONDS ? C.amber : C.green }} />
              </div>
              {overEtsy && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 11, color: C.red, lineHeight: 1.5 }}>
                    {(total - ETSY_MAX_SECONDS).toFixed(1)}s over what Etsy accepts.
                  </span>
                  <button type="button" onClick={trimToEtsy} style={{ ...btn("transparent", C.ink), padding: "5px 10px", fontSize: 11.5 }}>
                    Cut to {ETSY_MAX_SECONDS}s
                  </button>
                </div>
              )}
              {!overEtsy && total < ETSY_MIN_SECONDS && (
                <div style={{ fontSize: 11, color: C.inkFaint, lineHeight: 1.5 }}>
                  Etsy asks for at least {ETSY_MIN_SECONDS} seconds. Shorter than that and the listing will refuse it.
                </div>
              )}
            </div>

            {/* Clips */}
            <div style={{ ...panel, gap: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={lab}>Clips</span>
                <span style={{ fontSize: 9.5, color: C.inkFaint }}>played in this order</span>
                <span style={{ flex: 1 }} />
                <input ref={fileRef} type="file" accept="video/*" multiple style={{ display: "none" }}
                  onChange={e => { const fs = [...(e.target.files || [])]; e.target.value = ""; if (fs.length) addClips(fs); }} />
                <button type="button" onClick={() => fileRef.current?.click()} disabled={!!busy}
                  style={{ ...btn("transparent", C.ink), padding: "5px 10px", fontSize: 11.5 }}>
                  {busy === "open" ? "Reading…" : "+ Add takes"}
                </button>
              </div>
              {clips.map((c, i) => (
                <ClipTrack key={c.id} clip={c} strip={strips[c.id] || []}
                  active={here?.clip === c} playhead={here?.clip === c ? here.local : -1}
                  first={i === 0} last={i === clips.length - 1}
                  onTrim={patch => { stop(); patchClip(c.id, patch); if (patch.in !== undefined) seek(clips.slice(0, i).reduce((n, x) => n + clipLength(x), 0)); }}
                  onSeek={t => seek(clips.slice(0, i).reduce((n, x) => n + clipLength(x), 0) + clamp(t - c.in, 0, clipLength(c)))}
                  onRemove={() => { stop(); sinksRef.current.delete(c.id); closeClip(c); setClips(cs => cs.filter(x => x.id !== c.id)); setPlayhead(0); }}
                  onMove={d => setClips(cs => { const n = [...cs]; const j = i + d; if (j < 0 || j >= n.length) return cs; [n[i], n[j]] = [n[j], n[i]]; return n; })} />
              ))}
            </div>

            {/* What is about to happen to the pixels, said before the button is
                pressed rather than after. */}
            <div style={{ ...panel, gap: 8, borderColor: copy.ok ? `${C.green}66` : C.border }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span style={{ fontSize: 12, fontWeight: 800, color: copy.ok ? C.green : C.amber }}>
                  {copy.ok ? "✓ Lossless" : "↻ Re-encoded"}
                </span>
                <span style={{ fontSize: 11, color: C.inkMid, lineHeight: 1.5 }}>
                  {copy.ok
                    ? "the original frames, re-cut — nothing is decoded or compressed again"
                    : `every frame is rebuilt, because ${copy.why}`}
                </span>
              </div>
              {copy.ok && snapDrift > 0.02 && (
                <div style={{ fontSize: 11, color: C.inkFaint, lineHeight: 1.5 }}>
                  A copied cut can only start on a key frame, so the start moves back by {snapDrift.toFixed(2)}s.
                  Move a colour slider — or crop — if the exact frame matters more than the extra generation.
                </div>
              )}
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button type="button" onClick={() => { setAdjust(NEUTRAL); setBands([]); setCurves(emptyCurves()); setMixer(emptyMixer()); setGeo(NO_GEO); setSummary(""); }}
                disabled={!graded} style={{ ...btn("transparent", C.ink), opacity: graded ? 1 : .45 }}>
                Reset the look
              </button>
              <button type="button" onClick={resetAll} disabled={!ready || !touched}
                style={{ ...btn("transparent", C.ink), opacity: ready && touched ? 1 : .45 }}
                title="Full length, no grade, no crop — the takes exactly as they were shot">
                Start over
              </button>
              <span style={{ flex: 1 }} />
              {busy === "save" && (
                <button type="button" onClick={() => { cancelRef.current = true; }} style={{ ...btn("transparent", C.ink), padding: "8px 12px" }}>
                  Stop
                </button>
              )}
              <button type="button" onClick={save} disabled={!ready || !!busy || !touched || overEtsy || !total}
                style={{ ...btn(C.ink, "#FAF0DC"), opacity: !ready || busy || !touched || overEtsy || !total ? .5 : 1 }}>
                {busy === "save"
                  ? `${copy.ok ? "Re-cutting" : "Rendering"} ${Math.round(prog * 100)}%…`
                  : copy.ok ? "Save to listing · lossless" : "Save to listing"}
              </button>
            </div>

            {err && <div style={{ fontSize: 12, color: C.red, background: C.redBg, border: `1px solid ${C.red}30`,
              borderRadius: 8, padding: "8px 10px", lineHeight: 1.5 }}>{err}</div>}
          </div>

          {/* ── Controls ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0, minHeight: 0,
            overflowY: narrow ? "visible" : "auto", paddingRight: narrow ? 0 : 4 }}>

            <div style={{ ...panel, gap: 8 }}>
              <label style={lab}>Tell it what you want</label>
              <textarea value={ask} onChange={e => setAsk(e.target.value)} rows={2}
                placeholder="warmer, and lift the shadows…"
                style={{ ...FI(), fontSize: 12, resize: "vertical" }} />
              <div style={{ fontSize: 10.5, color: C.inkFaint, lineHeight: 1.5 }}>
                It reads the frame you're parked on and grades the whole clip from it.
              </div>
              <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                <button type="button" onClick={() => runAi(ask.trim() || "Make this a clean, true-to-life product video frame.")}
                  disabled={!ready || !!busy} style={{ ...btn(C.gold, "#fff"), opacity: !ready || busy ? .5 : 1 }}>
                  {busy === "ai" ? "✨ Reading the frame…" : "✨ Ask AI"}
                </button>
                <button type="button" onClick={() => runAi("Auto-correct this product video frame: exposure, white balance, a natural amount of contrast and clarity. Keep the stone's colour honest.")}
                  disabled={!ready || !!busy} style={{ ...btn("transparent", C.ink), opacity: !ready || busy ? .5 : 1 }}>
                  Auto
                </button>
                <button type="button" onClick={() => runAi("Which colours are in this stone?", "find")}
                  disabled={!ready || !!busy} style={{ ...btn("transparent", C.ink), opacity: !ready || busy ? .5 : 1 }}>
                  🎨 Find colours
                </button>
              </div>
              {summary && <div style={{ fontSize: 11.5, color: C.inkMid, lineHeight: 1.5, borderTop: `1px solid ${C.border}`, paddingTop: 8 }}>{summary}</div>}
            </div>

            <div style={panel}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={lab}>Frame</span>
                <span style={{ flex: 1 }} />
                <button type="button" title="Turn left" onClick={() => setGeo(g => ({ ...g, rotate: (g.rotate + 3) % 4 }))}
                  style={{ ...btn("transparent", C.ink), padding: "5px 9px", fontSize: 13 }}>↺</button>
                <button type="button" title="Turn right" onClick={() => setGeo(g => ({ ...g, rotate: (g.rotate + 1) % 4 }))}
                  style={{ ...btn("transparent", C.ink), padding: "5px 9px", fontSize: 13 }}>↻</button>
              </div>

              <Slider label="Straighten" hint="a hand-held take is never quite level" min={-15} max={15} step={0.5} unit="°"
                value={geo.straighten} onChange={v => setGeo(g => ({ ...g, straighten: v }))}
                onReset={() => setGeo(g => ({ ...g, straighten: 0 }))} />

              <label style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
                <input type="checkbox" checked={geo.crop.on} onChange={e => setCrop({ on: e.target.checked })}
                  style={{ accentColor: C.teal }} />
                <span style={lab}>Crop to a shape</span>
              </label>
              {!geo.crop.on ? (
                <div style={{ fontSize: 11, color: C.inkFaint, lineHeight: 1.5 }}>
                  Cuts the frame to a fixed shape — square for the shop grid, 9:16 for a phone. Nothing is stretched; the long side is trimmed.
                  {clips.length > 1 && " With several takes joined, a shape also makes them agree: without one they have to have been shot the same way round."}
                </div>
              ) : (
                <>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {ASPECTS.map(a => (
                      <button key={a.key} type="button" onClick={() => setCrop({ aspect: a.key })} title={a.hint}
                        style={{ ...btn(geo.crop.aspect === a.key ? C.teal : "transparent", geo.crop.aspect === a.key ? "#fff" : C.ink),
                          padding: "6px 10px", fontSize: 11.5 }}>
                        {a.label}
                      </button>
                    ))}
                  </div>
                  <Slider label="Zoom" hint="drag the picture to move it in the frame" min={0} max={100} signed={false}
                    value={geo.crop.zoom} onChange={v => setCrop({ zoom: v })} onReset={() => setCrop({ zoom: 0 })} />
                </>
              )}
            </div>

            {!copy.ok && (
              <div style={panel}>
                <span style={lab}>Quality</span>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {QUALITIES.map(q => (
                    <button key={q.key} type="button" onClick={() => setQuality(q.key)} title={q.hint}
                      style={{ ...btn(quality === q.key ? C.teal : "transparent", quality === q.key ? "#fff" : C.ink),
                        padding: "6px 10px", fontSize: 11.5 }}>
                      {q.label}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: C.inkFaint, lineHeight: 1.5 }}>
                  {(QUALITIES.find(q => q.key === quality) || QUALITIES[1]).hint}. Every marketplace re-encodes what it
                  is given, so this only decides what they start from.
                </div>
              </div>
            )}

            <div style={{ ...panel, gap: 12 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <span style={lab}>Colours in this clip</span>
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

            <div style={panel}>
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

            <div style={panel}>
              <span style={lab}>Curves</span>
              <CurveEditor curves={curves} onChange={setCurves} size={252} />
            </div>

            <div style={{ ...panel, gap: 11 }}>
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
