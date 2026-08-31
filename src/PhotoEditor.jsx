import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { C, mob, FI } from "./lmTheme.js";
import { uploadToStorage } from "./storageUtils.js";
import { fetchWithRetry } from "./aiClient.js";
import { CurveEditor, buildLut, emptyCurves, curvesTouched, CHANNELS } from "./ToneCurve.jsx";
import { buildBackgroundMask, maskToRgba } from "./backgroundSweep.js";

/* Native photo editor for listing shots.

   The model reads the photo and writes the recipe; the GPU moves the pixels.
   That split is deliberate: these are wholesale goods, and a generative
   re-render would repaint the stone's own pattern — the buyer would be looking
   at a picture of a piece that doesn't exist. So the AI's job is to say what to
   change and by how much ("the inclusions sit at hue 268–292, push those"),
   and every number it picks lands on a slider the eye can overrule.

   Everything renders through one WebGL pass, so the preview is the save: the
   same shader runs again at full resolution when the photo is written back. */

/* Sliders are all -100..100 so the model has one scale to reason in; the shader
   receives them normalised. Ranges are chosen to make ±100 a strong but not
   destructive move — a full stop of exposure, a doubling of saturation. */
const ADJUSTMENTS = [
  { key: "exposure",   u: "uExposure",   label: "Exposure",   hint: "stops" },
  { key: "contrast",   u: "uContrast",   label: "Contrast" },
  { key: "highlights", u: "uHighlights", label: "Highlights" },
  { key: "shadows",    u: "uShadows",    label: "Shadows" },
  { key: "temperature",u: "uTemp",       label: "Warmth" },
  { key: "tint",       u: "uTint",       label: "Tint",       hint: "green ↔ magenta" },
  { key: "vibrance",   u: "uVibrance",   label: "Vibrance",   hint: "spares what's already saturated" },
  { key: "saturation", u: "uSaturation", label: "Saturation" },
  { key: "clarity",    u: "uClarity",    label: "Clarity",    hint: "local contrast" },
];
const NEUTRAL = Object.fromEntries(ADJUSTMENTS.map(a => [a.key, 0]));

/* The colour mixer: the eight ranges every editor names, so "just the blues,
   brighter and stronger" is two sliders rather than a sentence to the model.
   Centres and widths are the usual wheel divisions, widened a little where the
   eye reads a range as broad (greens, blues) and kept tight where a spill would
   show (orange, which is also where skin lives). */
const MIXER = [
  { key: "red",     label: "Red",     center: 2,   width: 40, swatch: "#c0392b" },
  { key: "orange",  label: "Orange",  center: 28,  width: 30, swatch: "#d97b20" },
  { key: "yellow",  label: "Yellow",  center: 56,  width: 34, swatch: "#d4b106" },
  { key: "green",   label: "Green",   center: 120, width: 70, swatch: "#2e8b57" },
  { key: "aqua",    label: "Aqua",    center: 182, width: 50, swatch: "#1c9c9c" },
  { key: "blue",    label: "Blue",    center: 226, width: 52, swatch: "#2c6fbb" },
  { key: "purple",  label: "Purple",  center: 283, width: 44, swatch: "#7b4fa8" },
  { key: "magenta", label: "Magenta", center: 322, width: 44, swatch: "#b83b7a" },
];
const NO_MIX = Object.fromEntries(MIXER.map(m => [m.key, { hue: 0, sat: 0, lum: 0 }]));
const emptyMixer = () => JSON.parse(JSON.stringify(NO_MIX));
const mixerTouched = mix => MIXER.some(m => mix[m.key].hue || mix[m.key].sat || mix[m.key].lum);
// Only the ranges actually moved become bands, so the shader loop stays short.
const mixerBands = mix => MIXER.filter(m => mix[m.key].hue || mix[m.key].sat || mix[m.key].lum).map(m => ({
  name: m.label, center: m.center, width: m.width,
  sat: mix[m.key].sat, lum: mix[m.key].lum, hue: (mix[m.key].hue / 100) * 20,
}));
/* Eight named ranges for the colour mixer plus room for the model's own
   measured targets. Ten vec4s is nothing to a fragment shader. */
const MAX_BANDS = 10;

/* The quad always fills the canvas; what moves is where its corners read from
   in the source photo. uUvM is a 2x2 (rotation × the crop rectangle's size) and
   uUvOff the crop's centre — so straightening, the 90° turns and the crop are
   one matrix, applied for free at the only moment the pixels are touched. */
const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
uniform vec4 uUvM;
uniform vec2 uUvOff;
void main() {
  vUv = vec2(uUvM.x * aPos.x + uUvM.y * aPos.y, uUvM.z * aPos.x + uUvM.w * aPos.y) + uUvOff;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform sampler2D uCurve;   // 256x1 LUT, one channel per component
uniform sampler2D uMask;    // backdrop mask, 255 where the sweep may write white
uniform float uCurveOn, uSweep;
uniform vec2 uTexel;
uniform float uExposure, uContrast, uSaturation, uVibrance, uTemp, uTint, uHighlights, uShadows, uClarity;
uniform int uBandCount;
uniform vec4 uBands[${MAX_BANDS}];   // centre°, width°, saturation, luminance
uniform float uBandHue[${MAX_BANDS}];

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
  vec3 col = texture2D(uTex, vUv).rgb;

  /* Clarity first, while the tones are still where the lens put them: an
     unsharp mask against a cheap 8-tap ring, which is what "punch" actually is
     on a stone — edge micro-contrast, not global contrast. */
  if (abs(uClarity) > 0.001) {
    float r = 3.0;
    vec3 blur = vec3(0.0);
    blur += texture2D(uTex, vUv + vec2( uTexel.x * r, 0.0)).rgb;
    blur += texture2D(uTex, vUv + vec2(-uTexel.x * r, 0.0)).rgb;
    blur += texture2D(uTex, vUv + vec2(0.0,  uTexel.y * r)).rgb;
    blur += texture2D(uTex, vUv + vec2(0.0, -uTexel.y * r)).rgb;
    blur += texture2D(uTex, vUv + vec2( uTexel.x * r,  uTexel.y * r)).rgb;
    blur += texture2D(uTex, vUv + vec2(-uTexel.x * r, -uTexel.y * r)).rgb;
    blur += texture2D(uTex, vUv + vec2( uTexel.x * r, -uTexel.y * r)).rgb;
    blur += texture2D(uTex, vUv + vec2(-uTexel.x * r,  uTexel.y * r)).rgb;
    blur /= 8.0;
    col = clamp(col + (col - blur) * uClarity * 1.6, 0.0, 1.0);
  }

  col *= pow(2.0, uExposure);

  // White balance as channel gain — warmth trades red against blue, tint green
  // against the magenta pair, which is how the sliders read to the eye.
  col.r *= 1.0 + uTemp * 0.30;
  col.b *= 1.0 - uTemp * 0.30;
  col.g *= 1.0 + uTint * 0.22;
  col.r *= 1.0 - uTint * 0.10;
  col.b *= 1.0 - uTint * 0.10;
  col = clamp(col, 0.0, 1.0);

  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = clamp(col + uHighlights * smoothstep(0.5, 1.0, l) * 0.45, 0.0, 1.0);
  col = clamp(col + uShadows * (1.0 - smoothstep(0.0, 0.5, l)) * 0.45, 0.0, 1.0);
  col = clamp((col - 0.5) * (1.0 + uContrast) + 0.5, 0.0, 1.0);

  /* Curves sit after the tone sliders and before any colour work: they are the
     last word on where each input level lands, and the hue bands should read
     the tones the user actually sees. */
  if (uCurveOn > 0.5) {
    col = vec3(
      texture2D(uCurve, vec2(col.r, 0.5)).r,
      texture2D(uCurve, vec2(col.g, 0.5)).g,
      texture2D(uCurve, vec2(col.b, 0.5)).b);
  }

  /* Targeted hue work. Each band is a soft wedge of the colour wheel, feathered
     at the edges so a boost never draws a seam through a gradient, and held off
     the near-greys so a hand or a white sweep doesn't take the colour with it. */
  vec3 hsv = rgb2hsv(col);
  for (int i = 0; i < ${MAX_BANDS}; i++) {
    if (i >= uBandCount) break;
    vec4 b = uBands[i];
    float d = abs(mod(hsv.x * 360.0 - b.x + 540.0, 360.0) - 180.0);
    float w = 1.0 - smoothstep(b.y * 0.5, b.y * 0.5 + 10.0, d);
    w *= smoothstep(0.07, 0.20, hsv.y);
    if (w > 0.0) {
      hsv.y = clamp(hsv.y * (1.0 + b.z * w), 0.0, 1.0);
      hsv.z = clamp(hsv.z * (1.0 + b.w * w), 0.0, 1.0);
      hsv.x = fract(hsv.x + (uBandHue[i] / 360.0) * w + 1.0);
    }
  }
  col = hsv2rgb(hsv);

  float g = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float mx = max(col.r, max(col.g, col.b));
  float mn = min(col.r, min(col.g, col.b));
  col = mix(vec3(g), col, 1.0 + uVibrance * (1.0 - (mx - mn)));
  col = mix(vec3(g), col, 1.0 + uSaturation);

  /* The sweep is last: it paints the backdrop white after every tonal move, so
     white stays white however the rest of the picture was pushed. */
  if (uSweep > 0.0) col = mix(col, vec3(1.0), texture2D(uMask, vUv).r * uSweep);

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

const SYSTEM = `You are a retoucher for wholesale gemstone and mineral product photography.

You are given one product photo and what the seller wants changed. Reply with ONLY a JSON object — no prose, no code fence:

{
  "summary": "one short sentence on what you changed and why",
  "adjust": { "exposure": 0, "contrast": 0, "highlights": 0, "shadows": 0, "temperature": 0, "tint": 0, "vibrance": 0, "saturation": 0, "clarity": 0 },
  "bands": [ { "name": "purple inclusions", "center": 275, "width": 34, "sat": 22, "lum": -4, "hue": 0 } ],
  "curve": { "rgb": [[0,0],[64,58],[192,200],[255,255]] }
}

Every value in "adjust" is -100..100, 0 = untouched. Omit a key to leave it at 0.
"bands" targets specific colours already in the photo: "center" and "width" are degrees on the hue wheel (red 0, yellow 55, green 120, cyan 185, blue 240, purple 280, magenta 320), "sat"/"lum" are -100..100, "hue" is a shift in degrees, -30..30. At most 4 bands. Read the actual hues off THIS photo — measure them, do not use the nominal value for the colour's name. Name each band after what it is in the picture.

"curve" is optional and usually unnecessary — reach for it only when the sliders cannot say it: a filmic S for a flat scene, a lifted black point for a washed-out shot, or a per-channel fix for a colour cast ("r", "g", "b" keys, same shape). Points are [in, out] on 0..255, x ascending, first x 0 and last x 255, at most 6 points, never decreasing.

Rules:
- The buyer receives this exact stone. Correct the photograph, never invent the goods: no colour that isn't in the frame, no saturation that turns a dull piece into a bright one.
- Hand shots are the norm here. Skin sits around hue 15-35 at low saturation — keep bands off it, and say so in the summary if the seller's request would have hit it.
- Prefer a few decisive numbers over many timid ones. Most photos need less than ±30.
- If the photo is already right, return zeros and say so.`;

/* Reading the picture, not editing it. The model's other job is to answer "what
   colours are actually in here" — named in the photo's own terms and measured
   off the pixels — so the ranges to push are the ones this stone has, rather
   than the eight a colour wheel happens to be divided into. */
const SYSTEM_FIND = `You are a retoucher looking at one product photo of a gemstone, mineral or carving.

List the distinct colour ranges actually present in the stone. Reply with ONLY JSON:

{ "summary": "one short sentence naming what you found",
  "bands": [ { "name": "rust vein", "center": 28, "width": 26, "sat": 0, "lum": 0, "hue": 0 } ] }

- 2 to 4 ranges, ordered by how much of the stone they cover.
- "center" and "width" are degrees on the hue wheel, measured off THIS photo — sample the pixels, do not use the nominal hue for the colour's name.
- Width is the spread that colour actually occupies, not a default.
- Name each range the way the seller would say it out loud: "rust vein", "olive body", "blue-grey shell".
- The background and the hand holding the piece are not colours of the stone. Skin sits near hue 15-35 at low saturation — never return a range that would catch it, and say so in the summary if the stone's own colour sits there too.
- Always return "sat": 0, "lum": 0, "hue": 0. You are identifying the ranges, not adjusting them.`;

/* Two ceilings meet at 4096: the storage layer downscales anything larger on
   upload anyway, and a texture that big is safely inside every GPU's limit. So
   the working copy is capped there and nothing is lost that would have survived
   the save. */
const MAX_EDGE = 4096;
/* The preview only has to satisfy the eye on screen; the save renders the crop
   at its own true pixels. */
const PREVIEW_EDGE = 640;
/* Crop shapes. The value is width/height; the label is what the seller calls it. */
const ASPECTS = [
  { key: "1:1", label: "Square", hint: "shop grid · Instagram", ratio: 1 },
  { key: "4:5", label: "4:5",    hint: "tallest Instagram allows", ratio: 4 / 5 },
  { key: "4:3", label: "4:3",    hint: "eBay · marketplace", ratio: 4 / 3 },
  { key: "3:2", label: "3:2",    hint: "a camera's own shape", ratio: 3 / 2 },
];
const NO_GEO = { rotate: 0, straighten: 0, crop: { on: false, aspect: "1:1", zoom: 0, cx: 0.5, cy: 0.5 } };
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* The crop rectangle, in source pixels. Rotating the photo tilts the rectangle
   against the frame, so the biggest one that still fits shrinks as the angle
   grows — computing that here is what stops a straighten from ever exposing an
   empty corner. Zoom shrinks it further, and the centre is then held far enough
   from the edges that the tilted rectangle stays inside the picture. */
function cropGeometry(src, geo) {
  const { w: W, h: H } = src;
  // Negated: the shader maps output→source, so turning the picture right means
  // reading it along an axis turned left.
  const theta = -((geo.rotate * 90 + geo.straighten) * Math.PI) / 180;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const c = Math.abs(cos), sn = Math.abs(sin);
  const upright = geo.rotate % 2 === 0;
  const ratio = geo.crop.on
    ? (ASPECTS.find(a => a.key === geo.crop.aspect) || ASPECTS[0]).ratio
    : (upright ? W / H : H / W);
  // Fits when the tilted rectangle's own bounding box fits the frame.
  let w = Math.min(W / (c + sn / ratio), H / (sn + c / ratio));
  w *= 1 - (geo.crop.on ? geo.crop.zoom / 100 : 0) * 0.6;
  const h = w / ratio;
  const bw = w * c + h * sn, bh = w * sn + h * c;
  const cx = clamp(geo.crop.cx * W, bw / 2, W - bw / 2);
  const cy = clamp(geo.crop.cy * H, bh / 2, H - bh / 2);
  return { w, h, cx, cy, cos, sin, W, H };
}
const geoTouched = g => g.rotate !== 0 || g.straighten !== 0 || g.crop.on;

async function fitToTexture(bitmap) {
  const longest = Math.max(bitmap.width, bitmap.height);
  if (longest <= MAX_EDGE) return bitmap;
  const scale = MAX_EDGE / longest;
  const cv = document.createElement("canvas");
  cv.width = Math.round(bitmap.width * scale);
  cv.height = Math.round(bitmap.height * scale);
  cv.getContext("2d").drawImage(bitmap, 0, 0, cv.width, cv.height);
  const fitted = await createImageBitmap(cv);
  bitmap.close?.();
  return fitted;
}

/* Fetched rather than pointed at with <img src>, so the canvas is never tainted
   and the edited pixels can be read back out on save. */
async function loadBitmap(url) {
  const res = await fetch(url, { mode: "cors" });
  if (!res.ok) throw new Error(`Couldn't load the photo (${res.status})`);
  return fitToTexture(await createImageBitmap(await res.blob()));
}

/* The model gets a small copy — a 768px long edge is plenty to judge exposure
   and read hues off, and keeps the request quick and cheap. */
async function downscaleToB64(bitmap, max = 768) {
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  cv.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  return cv.toDataURL("image/jpeg", 0.85).split(",")[1] || "";
}

function parseRecipe(text) {
  const raw = String(text || "").replace(/```json|```/gi, "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The model didn't return a recipe.");
  const parsed = JSON.parse(raw.slice(start, end + 1));
  const adjust = { ...NEUTRAL };
  for (const a of ADJUSTMENTS) {
    const v = +parsed?.adjust?.[a.key];
    if (Number.isFinite(v)) adjust[a.key] = Math.max(-100, Math.min(100, Math.round(v)));
  }
  const bands = (Array.isArray(parsed?.bands) ? parsed.bands : []).slice(0, MAX_BANDS).map(b => ({
    name: String(b?.name || "colour").slice(0, 28),
    center: ((+b?.center || 0) % 360 + 360) % 360,
    width: Math.max(8, Math.min(180, +b?.width || 40)),
    sat: Math.max(-100, Math.min(100, +b?.sat || 0)),
    lum: Math.max(-100, Math.min(100, +b?.lum || 0)),
    hue: Math.max(-30, Math.min(30, +b?.hue || 0)),
  }));
  const curves = emptyCurves();
  for (const ch of CHANNELS) {
    const raw = parsed?.curve?.[ch.key];
    if (!Array.isArray(raw) || raw.length < 2) continue;
    const pts = raw
      .map(p => [Math.max(0, Math.min(1, (+p?.[0] || 0) / 255)), Math.max(0, Math.min(1, (+p?.[1] || 0) / 255))])
      .sort((a, b) => a[0] - b[0])
      .slice(0, 6);
    // The ends are structural, not the model's to move off the corners.
    pts[0] = [0, pts[0][1]];
    pts[pts.length - 1] = [1, pts[pts.length - 1][1]];
    curves[ch.key] = pts;
  }
  return { summary: String(parsed?.summary || "").slice(0, 240), adjust, bands, curves };
}

/* Defined at module scope on purpose: a component created inside the render is a
   fresh type on every state change, so React would remount the range input
   mid-drag and the slider would drop the pointer after the first pixel. */
const lab = { fontSize: 9.5, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6 };

function Slider({ label, hint, value, min = -100, max = 100, signed = true, step = 1, unit = "", onChange, onReset }) {
  return (
    <div style={{ display: "grid", gap: 3 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={lab}>{label}</span>
        {hint && <span style={{ fontSize: 9.5, color: C.inkFaint }}>{hint}</span>}
        <span style={{ flex: 1 }} />
        <button type="button" onClick={onReset} title="Back to zero"
          style={{ background: "none", border: "none", padding: 0, cursor: "pointer",
            fontSize: 11, fontWeight: 700, color: value === 0 ? C.inkFaint : C.teal }}>
          {(signed && value > 0 ? `+${value}` : `${value}`) + unit}
        </button>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(+e.target.value)}
        style={{ width: "100%", accentColor: C.teal, margin: 0 }} />
    </div>
  );
}

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
    const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true, premultipliedAlpha: false });
    if (!gl) return false;

    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || "shader failed");
      return sh;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "link failed");
    gl.useProgram(program);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);

    // The LUT lives on its own texture unit and is refreshed whenever a point moves.
    const curveTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, curveTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.activeTexture(gl.TEXTURE0);

    const maskTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, maskTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.activeTexture(gl.TEXTURE0);

    const u = name => gl.getUniformLocation(program, name);
    gl.uniform1i(u("uTex"), 0);
    gl.uniform1i(u("uCurve"), 1);
    gl.uniform1i(u("uMask"), 2);
    glRef.current = {
      gl, program, texture, curveTexture, maskTexture,
      uniforms: {
        texel: u("uTexel"), bandCount: u("uBandCount"), curveOn: u("uCurveOn"), sweep: u("uSweep"),
        uvM: u("uUvM"), uvOff: u("uUvOff"),
        bands: u("uBands[0]"), bandHue: u("uBandHue[0]"),
        ...Object.fromEntries(ADJUSTMENTS.map(a => [a.key, u(a.u)])),
      },
    };
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
    const { gl, uniforms } = ctx;
    const values = o.values || adjust;
    const bandList = o.bands || allBands;
    const curveSet = o.curves || curves;
    const sweepSet = o.sweep || sweep;
    const maskSet = o.bitmap ? o.mask : (o.mask !== undefined ? o.mask : mask);

    const g = cropGeometry({ w: bitmap.width, h: bitmap.height }, o.geo || geo);
    geoRef.current = g;
    /* Preview at a size the screen can show, save at the crop's true pixels —
       the only difference between the two renders. */
    const scale = o.full ? 1 : Math.min(1, PREVIEW_EDGE / Math.max(g.w, g.h));
    const ow = Math.max(1, Math.round(g.w * scale));
    const oh = Math.max(1, Math.round(g.h * scale));
    if (canvas.width !== ow || canvas.height !== oh) { canvas.width = ow; canvas.height = oh; }
    gl.viewport(0, 0, ow, oh);

    gl.uniform4f(uniforms.uvM,
      (g.cos * g.w * 0.5) / g.W, (g.sin * g.h * 0.5) / g.W,
      (g.sin * g.w * 0.5) / g.H, (-g.cos * g.h * 0.5) / g.H);
    gl.uniform2f(uniforms.uvOff, g.cx / g.W, g.cy / g.H);
    gl.uniform2f(uniforms.texel, 1 / bitmap.width, 1 / bitmap.height);

    const useSweep = sweepSet.on && maskSet ? sweepSet.strength / 100 : 0;
    gl.uniform1f(uniforms.sweep, useSweep);
    if (useSweep) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, ctx.maskTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, maskSet.width, maskSet.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, maskSet.data);
      gl.activeTexture(gl.TEXTURE0);
    }

    const useCurve = curvesTouched(curveSet);
    gl.uniform1f(uniforms.curveOn, useCurve ? 1 : 0);
    if (useCurve) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, ctx.curveTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, buildLut(curveSet));
      gl.activeTexture(gl.TEXTURE0);
    }

    for (const a of ADJUSTMENTS) gl.uniform1f(uniforms[a.key], (values[a.key] || 0) / 100);

    const list = bandList.slice(0, MAX_BANDS);
    const packed = new Float32Array(MAX_BANDS * 4);
    const hues = new Float32Array(MAX_BANDS);
    list.forEach((b, i) => {
      packed.set([b.center, b.width, b.sat / 100, b.lum / 100], i * 4);
      hues[i] = b.hue;
    });
    gl.uniform4fv(uniforms.bands, packed);
    gl.uniform1fv(uniforms.bandHue, hues);
    gl.uniform1i(uniforms.bandCount, list.length);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }, [adjust, allBands, curves, sweep, mask, geo]);

  /* Point the one texture unit at a different photo — the batch's whole trick. */
  const setSource = useCallback(bitmap => {
    const ctx = glRef.current;
    if (!ctx) return;
    const { gl } = ctx;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, ctx.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
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
      const data = await downscaleToB64(bitmapRef.current);
      const res = await fetchWithRetry("/api/claude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          max_tokens: 800,
          temperature: 0,
          messages: [
            { role: "system", content: mode === "find" ? SYSTEM_FIND : SYSTEM },
            { role: "user", content: [
              { type: "text", text: instruction },
              { type: "image", source: { media_type: "image/jpeg", data } },
            ] },
          ],
        }),
      }, { tries: 2, timeoutMs: 60000 });
      const body = await res.json();
      if (body.error) throw new Error(body.error?.message || "The model refused the request.");
      const recipe = parseRecipe(body.content?.[0]?.text || "");
      if (mode === "find") {
        // An inventory, not an edit: the ranges arrive at zero for you to push.
        setBands(recipe.bands.map(b => ({ ...b, sat: 0, lum: 0, hue: 0 })));
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
