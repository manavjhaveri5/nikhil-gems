import { buildLut, curvesTouched } from "./ToneCurve.jsx";

/* The colour engine, shared by the photo editor and the video editor.

   One WebGL pass does everything: the tone sliders, the curves, the hue bands,
   the backdrop sweep, and the geometry (rotate, straighten, crop) folded into
   the vertex stage. It lives here rather than inside either editor because a
   graded still and a graded frame of video have to come out of the same maths —
   a listing's photos and its clip are the same goods under the same light, and
   the seller sets one recipe for both. */

/* Sliders are all -100..100 so the model has one scale to reason in; the shader
   receives them normalised. Ranges are chosen to make ±100 a strong but not
   destructive move — a full stop of exposure, a doubling of saturation. */
export const ADJUSTMENTS = [
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
export const NEUTRAL = Object.fromEntries(ADJUSTMENTS.map(a => [a.key, 0]));

/* The colour mixer: the eight ranges every editor names, so "just the blues,
   brighter and stronger" is two sliders rather than a sentence to the model.
   Centres and widths are the usual wheel divisions, widened a little where the
   eye reads a range as broad (greens, blues) and kept tight where a spill would
   show (orange, which is also where skin lives). */
export const MIXER = [
  { key: "red",     label: "Red",     center: 2,   width: 40, swatch: "#c0392b" },
  { key: "orange",  label: "Orange",  center: 28,  width: 30, swatch: "#d97b20" },
  { key: "yellow",  label: "Yellow",  center: 56,  width: 34, swatch: "#d4b106" },
  { key: "green",   label: "Green",   center: 120, width: 70, swatch: "#2e8b57" },
  { key: "aqua",    label: "Aqua",    center: 182, width: 50, swatch: "#1c9c9c" },
  { key: "blue",    label: "Blue",    center: 226, width: 52, swatch: "#2c6fbb" },
  { key: "purple",  label: "Purple",  center: 283, width: 44, swatch: "#7b4fa8" },
  { key: "magenta", label: "Magenta", center: 322, width: 44, swatch: "#b83b7a" },
];
export const NO_MIX = Object.fromEntries(MIXER.map(m => [m.key, { hue: 0, sat: 0, lum: 0 }]));
export const emptyMixer = () => JSON.parse(JSON.stringify(NO_MIX));
export const mixerTouched = mix => MIXER.some(m => mix[m.key].hue || mix[m.key].sat || mix[m.key].lum);
// Only the ranges actually moved become bands, so the shader loop stays short.
export const mixerBands = mix => MIXER.filter(m => mix[m.key].hue || mix[m.key].sat || mix[m.key].lum).map(m => ({
  name: m.label, center: m.center, width: m.width,
  sat: mix[m.key].sat, lum: mix[m.key].lum, hue: (mix[m.key].hue / 100) * 20,
}));
/* Eight named ranges for the colour mixer plus room for the model's own
   measured targets. Ten vec4s is nothing to a fragment shader. */
export const MAX_BANDS = 10;


/* The quad always fills the canvas; what moves is where its corners read from
   in the source photo. uUvM is a 2x2 (rotation × the crop rectangle's size) and
   uUvOff the crop's centre — so straightening, the 90° turns and the crop are
   one matrix, applied for free at the only moment the pixels are touched. */
export const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
uniform vec4 uUvM;
uniform vec2 uUvOff;
void main() {
  vUv = vec2(uUvM.x * aPos.x + uUvM.y * aPos.y, uUvM.z * aPos.x + uUvM.w * aPos.y) + uUvOff;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export const FRAG = `
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

/* Two ceilings meet at 4096: the storage layer downscales anything larger on
   upload anyway, and a texture that big is safely inside every GPU's limit. So
   the working copy is capped there and nothing is lost that would have survived
   the save. */
export const MAX_EDGE = 4096;
/* The preview only has to satisfy the eye on screen; the save renders the crop
   at its own true pixels. */
export const PREVIEW_EDGE = 640;
/* Crop shapes. The value is width/height; the label is what the seller calls it. */
export const ASPECTS = [
  { key: "1:1", label: "Square", hint: "shop grid · Instagram", ratio: 1 },
  { key: "4:5", label: "4:5",    hint: "tallest Instagram allows", ratio: 4 / 5 },
  { key: "4:3", label: "4:3",    hint: "eBay · marketplace", ratio: 4 / 3 },
  { key: "3:2", label: "3:2",    hint: "a camera's own shape", ratio: 3 / 2 },
  // Shapes only a clip is ever cut to; the photo editor filters them back out.
  { key: "9:16", label: "9:16",  hint: "full-screen on a phone", ratio: 9 / 16, video: true },
  { key: "16:9", label: "16:9",  hint: "widescreen", ratio: 16 / 9, video: true },
];
export const NO_GEO = { rotate: 0, straighten: 0, crop: { on: false, aspect: "1:1", zoom: 0, cx: 0.5, cy: 0.5 } };
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* The crop rectangle, in source pixels. Rotating the photo tilts the rectangle
   against the frame, so the biggest one that still fits shrinks as the angle
   grows — computing that here is what stops a straighten from ever exposing an
   empty corner. Zoom shrinks it further, and the centre is then held far enough
   from the edges that the tilted rectangle stays inside the picture. */
export function cropGeometry(src, geo) {
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
export const geoTouched = g => g.rotate !== 0 || g.straighten !== 0 || g.crop.on;

export async function fitToTexture(bitmap) {
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
export async function loadBitmap(url) {
  const res = await fetch(url, { mode: "cors" });
  if (!res.ok) throw new Error(`Couldn't load the photo (${res.status})`);
  return fitToTexture(await createImageBitmap(await res.blob()));
}

/* ── The pipeline itself ──────────────────────────────────────────────────── */

/* Built once against a canvas and then reused: compiling the shader is the only
   expensive part, and both editors redraw far more often than they load. */
export function createPipeline(canvas) {
  const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true, premultipliedAlpha: false });
  if (!gl) return null;

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

  const makeTexture = unit => {
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.activeTexture(gl.TEXTURE0);
    return tex;
  };
  const texture = makeTexture(0);
  const curveTexture = makeTexture(1);   // 256x1 LUT, refreshed when a point moves
  const maskTexture = makeTexture(2);    // backdrop mask, per photo

  const u = name => gl.getUniformLocation(program, name);
  gl.uniform1i(u("uTex"), 0);
  gl.uniform1i(u("uCurve"), 1);
  gl.uniform1i(u("uMask"), 2);
  return {
    gl, program, texture, curveTexture, maskTexture,
    uniforms: {
      texel: u("uTexel"), bandCount: u("uBandCount"), curveOn: u("uCurveOn"), sweep: u("uSweep"),
      uvM: u("uUvM"), uvOff: u("uUvOff"),
      bands: u("uBands[0]"), bandHue: u("uBandHue[0]"),
      ...Object.fromEntries(ADJUSTMENTS.map(a => [a.key, u(a.u)])),
    },
  };
}

/* Point the one texture unit at a different picture. This is the whole trick
   behind both the photo batch and the video: the shader never changes, only
   what it is reading. */
export function setPipelineSource(ctx, source) {
  const { gl } = ctx;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, ctx.texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
}

/* One draw call is the whole editor. `maxEdge` caps the output for a preview;
   leaving it off renders at the crop's own true pixels, which is what the save
   and the video export use. `even` rounds the output to a multiple of two,
   because every video encoder insists on it.

   Returns the geometry it drew, which the drag maths needs. */
export function renderPipeline(ctx, canvas, o) {
  const { gl, uniforms } = ctx;
  const g = cropGeometry({ w: o.sw, h: o.sh }, o.geo);
  const round = o.even ? (v => Math.max(2, 2 * Math.round(v / 2))) : (v => Math.max(1, Math.round(v)));
  const scale = o.maxEdge ? Math.min(1, o.maxEdge / Math.max(g.w, g.h)) : 1;
  const ow = o.outW || round(g.w * scale);
  const oh = o.outH || round(g.h * scale);
  if (canvas.width !== ow || canvas.height !== oh) { canvas.width = ow; canvas.height = oh; }
  gl.viewport(0, 0, ow, oh);

  gl.uniform4f(uniforms.uvM,
    (g.cos * g.w * 0.5) / g.W, (g.sin * g.h * 0.5) / g.W,
    (g.sin * g.w * 0.5) / g.H, (-g.cos * g.h * 0.5) / g.H);
  gl.uniform2f(uniforms.uvOff, g.cx / g.W, g.cy / g.H);
  gl.uniform2f(uniforms.texel, 1 / o.sw, 1 / o.sh);

  const useSweep = o.sweep?.on && o.mask ? o.sweep.strength / 100 : 0;
  gl.uniform1f(uniforms.sweep, useSweep);
  if (useSweep) {
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, ctx.maskTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, o.mask.width, o.mask.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, o.mask.data);
    gl.activeTexture(gl.TEXTURE0);
  }

  const useCurve = o.curves && curvesTouched(o.curves);
  gl.uniform1f(uniforms.curveOn, useCurve ? 1 : 0);
  if (useCurve) {
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, ctx.curveTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, buildLut(o.curves));
    gl.activeTexture(gl.TEXTURE0);
  }

  for (const a of ADJUSTMENTS) gl.uniform1f(uniforms[a.key], (o.values?.[a.key] || 0) / 100);

  const list = (o.bands || []).slice(0, MAX_BANDS);
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
  return g;
}
