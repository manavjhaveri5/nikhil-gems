import { useEffect, useRef, useState } from "react";
import { C } from "./lmTheme.js";

/* Tone curves for the photo editor.

   Points are normalised 0..1 in both axes, x ascending, with the two ends
   pinned. Interpolation is monotone cubic (Fritsch–Carlson) rather than plain
   Catmull-Rom: an overshooting spline can bend a curve backwards between two
   points the user placed going up, which shows on a photo as a bright halo in
   a gradient that nothing in the UI explains. */

export const CHANNELS = [
  { key: "rgb", label: "RGB", color: C.ink },
  { key: "r",   label: "R",   color: "#c0392b" },
  { key: "g",   label: "G",   color: "#2e8b57" },
  { key: "b",   label: "B",   color: "#2c6fbb" },
];

const identity = () => [[0, 0], [1, 1]];
export const emptyCurves = () => ({ rgb: identity(), r: identity(), g: identity(), b: identity() });
const isIdentity = pts => pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 1 && pts[1][1] === 1;
export const curvesTouched = cs => CHANNELS.some(c => !isIdentity(cs[c.key] || identity()));

function spline(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  if (n < 2) return x => x;
  const xs = pts.map(p => p[0]);
  const ys = pts.map(p => p[1]);

  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
  const m = [d[0]];
  for (let i = 1; i < n - 1; i++) m.push((d[i - 1] + d[i]) / 2);
  m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }

  return x => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i]
         + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

/* One 256×1 RGBA texture carries all three channels: the master curve is folded
   into each so the shader is a single lookup per channel, not four. */
export function buildLut(curves) {
  const master = spline(curves.rgb || identity());
  const perChannel = [spline(curves.r || identity()), spline(curves.g || identity()), spline(curves.b || identity())];
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const x = master(i / 255);
    for (let c = 0; c < 3; c++) {
      lut[i * 4 + c] = Math.max(0, Math.min(255, Math.round(perChannel[c](Math.max(0, Math.min(1, x))) * 255)));
    }
    lut[i * 4 + 3] = 255;
  }
  return lut;
}

export function CurveEditor({ curves, onChange, size = 250 }) {
  const [channel, setChannel] = useState("rgb");
  const canvasRef = useRef(null);
  const dragRef = useRef(null);
  const points = curves[channel] || identity();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const px = x => x * size;
    const py = y => size - y * size;

    ctx.strokeStyle = "rgba(128,128,128,.28)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath(); ctx.moveTo(px(i / 4), 0); ctx.lineTo(px(i / 4), size); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, py(i / 4)); ctx.lineTo(size, py(i / 4)); ctx.stroke();
    }
    ctx.strokeStyle = "rgba(128,128,128,.45)";
    ctx.beginPath(); ctx.moveTo(0, size); ctx.lineTo(size, 0); ctx.stroke();

    const col = CHANNELS.find(c => c.key === channel)?.color || C.ink;
    const f = spline(points);
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= size; i++) {
      const y = Math.max(0, Math.min(1, f(i / size)));
      i ? ctx.lineTo(i, py(y)) : ctx.moveTo(i, py(y));
    }
    ctx.stroke();

    ctx.fillStyle = col;
    for (const [x, y] of points) {
      ctx.beginPath();
      ctx.arc(px(x), py(y), 4.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [points, channel, size]);

  const toLocal = e => {
    const rect = canvasRef.current.getBoundingClientRect();
    return [
      Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height)),
    ];
  };
  const setPoints = next => onChange({ ...curves, [channel]: next.sort((a, b) => a[0] - b[0]) });

  const onDown = e => {
    const [x, y] = toLocal(e);
    const near = points.findIndex(p => Math.hypot(p[0] - x, p[1] - y) < 0.06);
    if (near >= 0) {
      dragRef.current = near;
    } else {
      const next = [...points, [x, y]].sort((a, b) => a[0] - b[0]);
      dragRef.current = next.findIndex(p => p[0] === x && p[1] === y);
      setPoints(next);
    }
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = e => {
    const i = dragRef.current;
    if (i == null) return;
    const [x, y] = toLocal(e);
    const next = points.map(p => [...p]);
    // The ends hold the black and white points in place; everything between
    // stays in the order it was placed, so the curve can never fold over.
    const lo = i === 0 ? 0 : next[i - 1][0] + 0.02;
    const hi = i === next.length - 1 ? 1 : next[i + 1][0] - 0.02;
    next[i] = [i === 0 ? 0 : i === next.length - 1 ? 1 : Math.max(lo, Math.min(hi, x)), y];
    setPoints(next);
  };
  const onUp = () => { dragRef.current = null; };
  const onDouble = e => {
    const [x, y] = toLocal(e);
    const near = points.findIndex(p => Math.hypot(p[0] - x, p[1] - y) < 0.06);
    if (near > 0 && near < points.length - 1) setPoints(points.filter((_, j) => j !== near));
  };

  return (
    <div style={{ display: "grid", gap: 8, justifyItems: "stretch" }}>
      <div style={{ display: "flex", gap: 5 }}>
        {CHANNELS.map(c => {
          const on = channel === c.key;
          const used = !isIdentity(curves[c.key] || identity());
          return (
            <button key={c.key} type="button" onClick={() => setChannel(c.key)}
              style={{ flex: 1, border: `1px solid ${on ? c.color : C.border}`, background: on ? c.color : "transparent",
                color: on ? "#fff" : used ? c.color : C.inkFaint, borderRadius: 6, padding: "4px 0",
                fontSize: 10.5, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }}>
              {c.label}{used ? " •" : ""}
            </button>
          );
        })}
      </div>
      <canvas ref={canvasRef}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}
        onDoubleClick={onDouble}
        style={{ width: "100%", aspectRatio: "1", background: C.card, border: `1px solid ${C.border}`,
          borderRadius: 8, touchAction: "none", cursor: "crosshair" }} />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 10, color: C.inkFaint, flex: 1, lineHeight: 1.4 }}>
          Click to add a point, drag to bend, double-click to remove.
        </span>
        <button type="button" onClick={() => onChange({ ...curves, [channel]: identity() })}
          disabled={isIdentity(points)}
          style={{ border: `1px solid ${C.border}`, background: "transparent", color: C.inkFaint, borderRadius: 6,
            padding: "3px 8px", fontSize: 10, fontWeight: 700, cursor: "pointer", opacity: isIdentity(points) ? .45 : 1 }}>
          Reset {channel.toUpperCase()}
        </button>
      </div>
    </div>
  );
}
