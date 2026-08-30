/* Sweeping a product shot's backdrop to pure white.

   The naïve version — "every pixel near the backdrop colour becomes white" —
   eats the stone whenever the stone has a pale face, which for quartz, opal or
   a white-banded agate is most of the catalogue. So the mask is grown from the
   border inwards instead: a pixel is background because it is *connected* to
   the edge of the frame through other background-coloured pixels, not merely
   because it resembles them. A pale inclusion in the middle of the piece is
   never reached, so it is never blown out.

   Studio shots on a sweep are what this is for. A hand shot has no continuous
   backdrop to grow through, and the editor says so rather than pretending. */

const MASK_EDGE = 900;   // plenty for a mask the GPU will smooth anyway

/* The backdrop's own colour, taken as the median of the frame's border so one
   bright reflection or a dark corner vignette can't drag the reference. */
function borderReference(data, w, h) {
  const rs = [], gs = [], bs = [];
  const push = (x, y) => {
    const i = (y * w + x) * 4;
    rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
  };
  const step = Math.max(1, Math.round(Math.min(w, h) / 120));
  for (let x = 0; x < w; x += step) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y += step) { push(0, y); push(w - 1, y); }
  const mid = arr => arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)] || 0;
  return [mid(rs), mid(gs), mid(bs)];
}

/* One box blur pass per axis, run twice — cheap, and two passes of a box are
   close enough to a Gaussian that no edge shows. */
function feather(mask, w, h, radius) {
  if (radius < 1) return mask;
  let src = mask;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {
      let sum = 0;
      for (let x = -radius; x <= radius; x++) sum += src[y * w + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = sum / (radius * 2 + 1);
        sum -= src[y * w + Math.min(w - 1, Math.max(0, x - radius))];
        sum += src[y * w + Math.min(w - 1, Math.max(0, x + radius + 1))];
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -radius; y <= radius; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = sum / (radius * 2 + 1);
        sum -= tmp[Math.min(h - 1, Math.max(0, y - radius)) * w + x];
        sum += tmp[Math.min(h - 1, Math.max(0, y + radius + 1)) * w + x];
      }
    }
    src = out.slice();
  }
  return src;
}

/* Returns { mask, width, height, coverage } — coverage is the share of the
   frame the sweep claims, which is how the UI knows to warn that a hand shot
   isn't a backdrop (too little) or that the piece itself is going (too much). */
export function buildBackgroundMask(bitmap, { tolerance = 30, softness = 2 } = {}) {
  const scale = Math.min(1, MASK_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  const [br, bg, bb] = borderReference(data, w, h);
  const limit = tolerance * tolerance * 3;
  const mask = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;

  const matches = idx => {
    const i = idx * 4;
    const dr = data[i] - br, dg = data[i + 1] - bg, db = data[i + 2] - bb;
    return dr * dr + dg * dg + db * db <= limit;
  };
  const seed = idx => { if (!mask[idx] && matches(idx)) { mask[idx] = 255; queue[tail++] = idx; } };

  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }

  while (head < tail) {
    const idx = queue[head++];
    const x = idx % w, y = (idx / w) | 0;
    if (x > 0) seed(idx - 1);
    if (x < w - 1) seed(idx + 1);
    if (y > 0) seed(idx - w);
    if (y < h - 1) seed(idx + w);
  }

  let claimed = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) claimed++;

  return { mask: feather(mask, w, h, Math.round(softness)), width: w, height: h, coverage: claimed / (w * h) };
}

// The shader samples one channel; RGBA is what texImage2D wants without fuss.
export function maskToRgba(mask) {
  const out = new Uint8Array(mask.length * 4);
  for (let i = 0; i < mask.length; i++) {
    out[i * 4] = mask[i];
    out[i * 4 + 3] = 255;
  }
  return out;
}
