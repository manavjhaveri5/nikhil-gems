import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { C, mob, FI } from "./lmTheme.js";
import { uploadToStorage } from "./storageUtils.js";
import { fetchWithRetry } from "./aiClient.js";
import { CurveEditor, buildLut, emptyCurves, curvesTouched, CHANNELS } from "./ToneCurve.jsx";

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

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform sampler2D uCurve;   // 256x1 LUT, one channel per component
uniform float uCurveOn;
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

function Slider({ label, hint, value, min = -100, max = 100, signed = true, onChange, onReset }) {
  return (
    <div style={{ display: "grid", gap: 3 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={lab}>{label}</span>
        {hint && <span style={{ fontSize: 9.5, color: C.inkFaint }}>{hint}</span>}
        <span style={{ flex: 1 }} />
        <button type="button" onClick={onReset} title="Back to zero"
          style={{ background: "none", border: "none", padding: 0, cursor: "pointer",
            fontSize: 11, fontWeight: 700, color: value === 0 ? C.inkFaint : C.teal }}>
          {signed && value > 0 ? `+${value}` : value}
        </button>
      </div>
      <input type="range" min={min} max={max} value={value} onChange={e => onChange(+e.target.value)}
        style={{ width: "100%", accentColor: C.teal, margin: 0 }} />
    </div>
  );
}

export default function PhotoEditor({ url, onSave, onClose, showToast }) {
  const canvasRef = useRef(null);
  const glRef = useRef(null);       // { gl, program, uniforms, texture }
  const bitmapRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [adjust, setAdjust] = useState(NEUTRAL);
  const [bands, setBands] = useState([]);
  const [curves, setCurves] = useState(emptyCurves);
  const [mixer, setMixer] = useState(emptyMixer);
  const [mixKey, setMixKey] = useState("blue");
  const [ask, setAsk] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState("");
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
    || curvesTouched(curves) || mixerTouched(mixer);
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

    const u = name => gl.getUniformLocation(program, name);
    gl.uniform1i(u("uTex"), 0);
    gl.uniform1i(u("uCurve"), 1);
    glRef.current = {
      gl, program, texture, curveTexture,
      uniforms: {
        texel: u("uTexel"), bandCount: u("uBandCount"), curveOn: u("uCurveOn"),
        bands: u("uBands[0]"), bandHue: u("uBandHue[0]"),
        ...Object.fromEntries(ADJUSTMENTS.map(a => [a.key, u(a.u)])),
      },
    };
    return true;
  }, []);

  const draw = useCallback((values = adjust, bandList = bands, curveSet = curves, size = null) => {
    const ctx = glRef.current;
    const bitmap = bitmapRef.current;
    const canvas = canvasRef.current;
    if (!ctx || !bitmap || !canvas) return;
    const { gl, uniforms } = ctx;

    const w = size?.w || canvas.width;
    const h = size?.h || canvas.height;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.uniform2f(uniforms.texel, 1 / bitmap.width, 1 / bitmap.height);

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
  }, [adjust, bands, curves]);

  /* Load the photo through fetch rather than <img src>, so the canvas is never
     tainted and the edited pixels can be read back out on save. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(url, { mode: "cors" });
        if (!res.ok) throw new Error(`Couldn't load the photo (${res.status})`);
        const bitmap = await fitToTexture(await createImageBitmap(await res.blob()));
        if (cancelled) return;
        bitmapRef.current = bitmap;
        const box = 640;
        const scale = Math.min(1, box / Math.max(bitmap.width, bitmap.height));
        const canvas = canvasRef.current;
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        if (!initGl(bitmap)) throw new Error("This browser has no WebGL, so the editor can't run here.");
        setReady(true);
      } catch (e) { if (!cancelled) setErr(e.message || String(e)); }
    })();
    return () => { cancelled = true; };
  }, [url, initGl]);

  useEffect(() => {
    if (!ready) return;
    draw(showOriginal ? NEUTRAL : adjust, showOriginal ? [] : allBands, showOriginal ? emptyCurves() : curves);
  }, [ready, adjust, allBands, curves, showOriginal, draw]);

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
  const save = async () => {
    const bitmap = bitmapRef.current;
    const canvas = canvasRef.current;
    if (!bitmap || !canvas) return;
    setBusy("save"); setErr("");
    const view = { w: canvas.width, h: canvas.height };
    try {
      // Same shader, full resolution — what was previewed is what is written.
      draw(adjust, allBands, curves, { w: bitmap.width, h: bitmap.height });
      const blob = await new Promise((resolve, reject) =>
        canvas.toBlob(b => (b ? resolve(b) : reject(new Error("Couldn't read the edited photo back."))), "image/jpeg", 0.92));
      const name = `edited-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
      const saved = await uploadToStorage(`listing-photos/${name}`, new File([blob], name, { type: "image/jpeg" }));
      onSave(saved);
      showToast?.("✓ Photo replaced — the original is still in the Image Library");
      onClose();
    } catch (e) {
      setErr(e.message || String(e));
      draw(adjust, allBands, curves, view);   // put the preview back at preview size
    } finally { setBusy(""); }
  };

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

        <div style={{ flex: 1, minHeight: 0, display: "grid", gap: 14, padding: 14, overflowY: "auto",
          gridTemplateColumns: narrow ? "1fr" : "1fr 300px" }}>

          {/* Canvas */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 10,
              display: "grid", placeItems: "center", minHeight: 240 }}>
              <canvas ref={canvasRef} style={{ maxWidth: "100%", maxHeight: narrow ? 320 : 460, borderRadius: 8, display: ready ? "block" : "none" }} />
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
              <button type="button" onClick={() => { setAdjust(NEUTRAL); setBands([]); setCurves(emptyCurves()); setMixer(emptyMixer()); setSummary(""); }}
                disabled={!touched} style={{ ...btn("transparent", C.ink), opacity: touched ? 1 : .45 }}>
                Reset
              </button>
              <span style={{ flex: 1 }} />
              <button type="button" onClick={save} disabled={!ready || !!busy || !touched}
                style={{ ...btn(C.ink, "#FAF0DC"), opacity: !ready || busy || !touched ? .5 : 1 }}>
                {busy === "save" ? "Saving…" : "Save to listing"}
              </button>
            </div>

            {err && <div style={{ fontSize: 12, color: C.red, background: C.redBg, border: `1px solid ${C.red}30`,
              borderRadius: 8, padding: "8px 10px", lineHeight: 1.5 }}>{err}</div>}
          </div>

          {/* Controls */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
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
