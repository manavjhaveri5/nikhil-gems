/* The studio shot: the photo goes to OpenAI's image editor, which takes the hand
   and the backdrop out and redraws the piece on pure white with a soft contact
   shadow, square — what the seller's ChatGPT GPT did, brought into the editor.

   This is the one place the editor lets a model repaint pixels, and the seller
   chose it knowing that: where fingers cover the stone there is nothing real to
   keep, so the model fills it in, and it redraws the rest of the stone as it
   goes. So the result is always a new photo beside the original, never a
   replacement, and the brief holds the model to the piece as photographed. */

export const STUDIO_BRIEF = `Make a clean studio product shot of the product in this photo, for an online shop listing.

- Take out the hand, fingers, props and the whole backdrop. Only the product stays.
- Pure white background, #FFFFFF, edge to edge: no gradient, texture, vignette or coloured fringe.
- A soft, subtle contact shadow on the white directly beneath the product, as if it rests on a white surface. The shadow never darkens the product itself.
- Square frame. The whole product in view and centred, with even white space around it. Never crop it.
- Keep the product exactly as it is in the photo: the same shape, proportions, orientation, colours, brightness, contrast, surface pattern, veins, inclusions, cracks, polish, reflections and highlights. Do not brighten, darken, saturate, sharpen, smooth, recolour or restyle it, and do not tidy away its natural imperfections.
- Where a finger or prop covered part of the product, continue the surrounding surface across that area plainly and consistently with what is next to it. Add no new features, colours or markings.`;

const SEND_EDGE = 1536;   // enough for the model to read the surface, small enough for the upload limit

function toJpegB64(source, max) {
  const sw = source.width, sh = source.height;
  const scale = Math.min(1, max / Math.max(sw, sh));
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(sw * scale));
  cv.height = Math.max(1, Math.round(sh * scale));
  cv.getContext("2d").drawImage(source, 0, 0, cv.width, cv.height);
  return cv.toDataURL("image/jpeg", 0.92).split(",")[1] || "";
}

const loadImg = src => new Promise((resolve, reject) => {
  const im = new Image();
  im.onload = () => resolve(im);
  im.onerror = () => reject(new Error("The studio shot came back unreadable."));
  im.src = src;
});

/* The model's white is rarely exactly white — 246, 250, a faint cast. Its level
   is read off the frame's edge, and everything near-white joined to that edge is
   the backdrop: lifted to 255 on a ramp that ends just under the backdrop's own
   level and starts 16 below it, so the shadow's fall-off stays smooth. The piece
   sits inside its white margin, so the fill never reaches it. A grey backdrop
   (the model ignored the brief) is left alone and shows up in the return value:
   how much of the frame's edge is now pure white. */
export function whitenBackdrop(cv) {
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  const W = cv.width, H = cv.height;
  const im = ctx.getImageData(0, 0, W, H), d = im.data;
  const rim = [];
  for (let x = 0; x < W; x += 4) rim.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y += 4) rim.push(y * W, y * W + W - 1);
  const levels = rim.map(p => Math.min(d[p * 4], d[p * 4 + 1], d[p * 4 + 2])).sort((a, b) => a - b);
  const to = Math.max(236, Math.min(252, levels[levels.length >> 1] - 3)), from = to - 16;
  const seen = new Uint8Array(W * H), stack = new Int32Array(W * H);
  let top = 0;
  const push = p => {
    if (seen[p]) return;
    const i = p * 4, lo = Math.min(d[i], d[i + 1], d[i + 2]), hi = Math.max(d[i], d[i + 1], d[i + 2]);
    if (lo < from || hi - lo > 14) return;
    seen[p] = 1; stack[top++] = p;
  };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (top) {
    const p = stack[--top], x = p % W, i = p * 4;
    const t = Math.min(1, (Math.min(d[i], d[i + 1], d[i + 2]) - from) / (to - from));
    for (let k = 0; k < 3; k++) d[i + k] = Math.round(d[i + k] + (255 - d[i + k]) * t);
    if (x > 0) push(p - 1);
    if (x < W - 1) push(p + 1);
    if (p >= W) push(p - W);
    if (p < W * (H - 1)) push(p + W);
  }
  ctx.putImageData(im, 0, 0);
  let edge = 0, white = 0;
  const count = p => { edge++; if (d[p * 4] === 255 && d[p * 4 + 1] === 255 && d[p * 4 + 2] === 255) white++; };
  for (let x = 0; x < W; x++) { count(x); count((H - 1) * W + x); }
  for (let y = 1; y < H - 1; y++) { count(y * W); count(y * W + W - 1); }
  return white / edge;
}

/* One round trip: a minute or so on the model's side. Not retried on its own —
   each try is a paid image. Returns a canvas ready to save, and anything the
   seller should look at before using it. */
export async function makeStudioShot(source, note = "") {
  const image = toJpegB64(source, SEND_EDGE);
  const prompt = note.trim() ? `${STUDIO_BRIEF}\n\nAlso: ${note.trim()}` : STUDIO_BRIEF;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 290000);
  let res, text;
  try {
    res = await fetch("/api/claude?_ai=studio", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image, prompt }),
      signal: ctrl.signal,
    });
    text = await res.text();
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "The studio shot took too long. Try again." : e.message);
  } finally { clearTimeout(timer); }
  let body;
  try { body = JSON.parse(text); } catch {
    throw new Error(res.status === 504 ? "The studio shot took too long. Try again." : `The studio shot failed (HTTP ${res.status}).`);
  }
  if (!res.ok || !body.image) throw new Error(body.error?.message || "No picture came back.");
  const img = await loadImg(`data:${body.mime || "image/png"};base64,${body.image}`);
  const cv = document.createElement("canvas");
  cv.width = img.naturalWidth; cv.height = img.naturalHeight;
  cv.getContext("2d").drawImage(img, 0, 0);
  const white = whitenBackdrop(cv);
  const warnings = [];
  if (cv.width !== cv.height) warnings.push("It didn't come back square.");
  if (white < 0.9) warnings.push("The edges of the frame aren't all white. Check the background.");
  return { canvas: cv, preview: cv.toDataURL("image/jpeg", 0.9), model: body.model, warnings };
}
