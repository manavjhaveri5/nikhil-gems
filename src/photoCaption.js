/* A line of type burnt into the photo itself.

   "Exact piece shown" is the single most load-bearing sentence on a listing of
   one-of-a-kind stones — it is the difference between a buyer expecting THIS
   sphere and a buyer expecting one like it — and it has to survive the trip to
   Etsy. Etsy renders its own pages, so no caption of ours written in CSS ever
   reaches them. The only text that travels with a photo everywhere it goes is
   text that is part of the photo. So it is drawn into the pixels, once, at save.

   Which also means the store and the trade site need no caption code at all:
   they show the photo, and the photo already says it.

   The type is self-hosted rather than pulled from Google on the fly. A webfont
   that has not finished loading does not throw — the canvas quietly falls back
   to a system face and writes the words in the wrong typeface, and the mistake
   is then baked into a JPEG that goes out to Etsy. loadCaptionFont() has to be
   awaited before any draw. StoryStudio self-hosts for the same reason. */

export const CAPTION_FONTS = [
  { key: "jost",       label: "Jost",       family: "EE Caption Jost",  weight: 300,
    file: "jost-latin-variable",            desc: { weight: "100 900" } },
  { key: "montserrat", label: "Montserrat", family: "EE Caption Mont",  weight: 300,
    file: "montserrat-latin-300-normal",    desc: { weight: "300" } },
  { key: "raleway",    label: "Raleway",    family: "EE Caption Rale",  weight: 200,
    file: "raleway-latin-200-normal",       desc: { weight: "200" } },
];

export const CAPTION_PRESETS = ["EXACT PIECE SHOWN", "SIMILAR PIECE SHOWN"];

const loaded = new Map();
export function loadCaptionFont(key) {
  const f = CAPTION_FONTS.find(x => x.key === key) || CAPTION_FONTS[0];
  if (!loaded.has(f.key)) {
    loaded.set(f.key, (async () => {
      const face = new FontFace(f.family, `url(/fonts/caption/${f.file}.woff2)`, f.desc);
      document.fonts.add(await face.load());
    })().catch(e => { loaded.delete(f.key); throw e; }));
  }
  return loaded.get(f.key).then(() => f);
}

export const NO_CAPTION = { text: "", font: "jost", pos: "top", size: 3.4, track: 28, dark: true };
export const captionOn = c => !!(c && c.text || "").toString().trim();

/* Every measurement is a share of the photo's own size, so one setting looks
   the same on the 794px preview and the 3000px original. The alternative —
   pixels — would have the preview lying about the result. */
export function drawCaption(ctx, cap, W, H) {
  const text = String(cap?.text || "").trim();
  if (!text) return;
  const f = CAPTION_FONTS.find(x => x.key === cap.font) || CAPTION_FONTS[0];
  const edge = Math.min(W, H);
  const size = Math.round(edge * (+cap.size || 3.4) / 100);
  if (size < 4) return;

  ctx.save();
  ctx.font = `${f.weight} ${size}px "${f.family}", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  /* Tracking is the whole look of this caption, and canvas only grew a
     letterSpacing property recently. Where it is missing the glyphs are placed
     by hand instead, so an older browser writes the same line rather than a
     cramped one. */
  const trackPx = size * (+cap.track || 0) / 100;
  const native = "letterSpacing" in ctx;
  if (native) ctx.letterSpacing = `${trackPx}px`;

  ctx.fillStyle = cap.dark === false ? "#FFFFFF" : "#1A1A1A";
  const y = cap.pos === "bottom" ? H - edge * 0.075 : edge * 0.075;

  if (native) {
    /* Trailing tracking sits after the last glyph, pushing a centred line left
       by half a space. Nudging back by half keeps it optically centred. */
    ctx.fillText(text, W / 2 + trackPx / 2, y);
  } else {
    const chars = [...text];
    const total = chars.reduce((w, c) => w + ctx.measureText(c).width, 0) + trackPx * (chars.length - 1);
    let x = W / 2 - total / 2;
    ctx.textAlign = "left";
    for (const c of chars) {
      ctx.fillText(c, x, y);
      x += ctx.measureText(c).width + trackPx;
    }
  }
  ctx.restore();
}

/* The WebGL canvas holds the graded pixels and cannot take a 2D context, so the
   caption is drawn on a copy. Returns a 2D canvas to read the blob from. */
export function compositeCaption(glCanvas, cap) {
  const out = document.createElement("canvas");
  out.width = glCanvas.width;
  out.height = glCanvas.height;
  const ctx = out.getContext("2d");
  ctx.drawImage(glCanvas, 0, 0);
  drawCaption(ctx, cap, out.width, out.height);
  return out;
}
