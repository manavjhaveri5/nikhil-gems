/* The drawing behind the Instagram stories ("Just listed", "Sold 🔥"): the
   Stories module (src/StoryStudio.jsx) draws with it in the browser, and the
   server (api/social.js) draws the same story with @napi-rs/canvas when a
   piece goes live, so a story goes up even with no ERP open. No DOM here:
   the canvas comes from setCanvasFactory (the browser's by default). */
export const W = 1080, H = 1920, LEFT = 72, TEXT_W = W - 2 * LEFT;
export const F = { sans: "EE Story Sans" };
export const EMOJI = '"Apple Color Emoji","Noto Color Emoji","Segoe UI Emoji",sans-serif';


let makeCanvas = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
export const setCanvasFactory = f => { makeCanvas = f; };

/* The name a story can carry: the store's short title, or the listing title
   cut at the first separator Etsy titles pile keywords behind. */
export const storyName = (l, storeTitle) => {
  const t = String(storeTitle || l.title || "").trim();
  const cut = storeTitle ? t : t.split(/\s[|–—\-·]\s|\||,/)[0].trim();
  const words = cut.split(/\s+/);
  return words.length > 9 ? words.slice(0, 9).join(" ") : cut;
};

export const wrap = (ctx, s, max, width = t => ctx.measureText(t).width) => {
  const lines = [];
  let line = "";
  for (const w of s.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${w}` : w;
    if (line && width(next) > max) { lines.push(line); line = w; } else line = next;
  }
  return line ? [...lines, line] : lines;
};

/* Where the type sits and in which colour: the emptier of the two bands the
   story leaves free of Instagram's own bars, dark type on a light photo. */
export function readPhoto(bmp, frame) {
  const cv = makeCanvas(54, 96);
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  drawPhoto(ctx, bmp, frame, 54 / W);
  const px = ctx.getImageData(0, 0, 54, 96).data;
  const band = (y0, y1) => {
    const v = [];
    for (let y = y0; y < y1; y++) for (let x = 2; x < 34; x++) {
      const i = (y * 54 + x) * 4;
      v.push((0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255);
    }
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    return { mean, spread: Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length) };
  };
  return { top: band(14, 32), bottom: band(64, 84) };
}

/* A photo's own background, from its outer edge: its average colour, and
   whether it's plain (a studio shot on white or grey) or part of the scene. */
export function edgeOf(bmp) {
  const n = 40, cv = makeCanvas(n, n);
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, n, n);
  const px = ctx.getImageData(0, 0, n, n).data, rgb = [0, 0, 0], lum = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (x > 1 && x < n - 2 && y > 1 && y < n - 2) continue;
    const i = (y * n + x) * 4;
    rgb[0] += px[i]; rgb[1] += px[i + 1]; rgb[2] += px[i + 2];
    lum.push((0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255);
  }
  const mean = lum.reduce((a, b) => a + b, 0) / lum.length;
  const spread = Math.sqrt(lum.reduce((a, b) => a + (b - mean) ** 2, 0) / lum.length);
  const [r, g, b] = rgb.map(v => Math.round(v / lum.length));
  return { bg: `rgb(${r},${g},${b})`, plain: spread < .045 };
}

// Zoom 1 fills the screen; the smallest zoom shows the whole photo.
export const coverScale = bmp => Math.max(W / bmp.width, H / bmp.height);
export const minZoom = bmp => Math.min(W / bmp.width, H / bmp.height) / coverScale(bmp);

export function drawPhoto(ctx, bmp, { zoom = 1, ox = 0, oy = 0, bg = "#f4f2ee" }, k = 1) {
  const s = coverScale(bmp) * zoom;
  const w = bmp.width * s, h = bmp.height * s;
  // Zoomed out past the screen, the photo's own background colour runs on
  // around it, so the story still fills the screen.
  if (w < W || h < H) { ctx.fillStyle = bg; ctx.fillRect(0, 0, W * k, H * k); }
  // The photo can be moved, but never past its edge into empty space.
  const x = Math.min(Math.max(0, W - w), Math.max(Math.min(0, W - w), (W - w) / 2 + ox));
  const y = Math.min(Math.max(0, H - h), Math.max(Math.min(0, H - h), (H - h) / 2 + oy));
  ctx.drawImage(bmp, x * k, y * k, w * k, h * k);
}

/* How busy a patch of the photo is (spread of its brightness): the link
   sticker goes on the plainest patch, so it never sits on the piece. */
export function busyness(ctx, { x, y, w, h }) {
  const px = ctx.getImageData(x - 40, y - 40, w + 80, h + 80).data;
  let n = 0, sum = 0, sq = 0;
  for (let i = 0; i < px.length; i += 4 * 7) {
    const v = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
    n++; sum += v; sq += v * v;
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sq / n - mean * mean));
}
export const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/* The story itself. Returns where the link sticker goes, for the preview. */
/* Inter Tight, set tight as a display face (the look of Helvetica Now
   Display): weight and size, with tracking pulled in a touch. */
export const face = (ctx, weight, size) => {
  ctx.font = `${weight} ${size}px "${F.sans}"`;
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${(-0.02 * size).toFixed(1)}px`;
};
export function drawStory(ctx, bmp, { kind, name, place, tone, frame }) {
  ctx.clearRect(0, 0, W, H);
  drawPhoto(ctx, bmp, frame);
  const light = tone === "light", ink = light ? "#fff" : "#141210";
  const top = place === "top";

  // Everything is set in the one face. A name takes one line if a smaller
  // size gets it there, and only then goes to two, smaller again if it must.
  const fit = (text, start, oneLineMin, min) => {
    const at = size => { face(ctx, 600, size); return wrap(ctx, text, TEXT_W); };
    let size = start, lines = at(size);
    while (lines.length > 1 && size > oneLineMin) lines = at(size -= 4);
    if (lines.length > 1) { size = Math.max(min, Math.min(start, oneLineMin + 8)); lines = at(size); }
    while (lines.length > 2 && size > min) lines = at(size -= 4);
    return { size, lines, lineH: Math.round(size * 1.04) };
  };
  const nm = kind === "sold" ? fit(name, 52, 40, 36) : fit(name, 84, 62, 52);
  // Above the name: "Sold 🔥" large, or a small "Just listed" tag.
  const TAG = "Just listed", tagSize = 28, tagH = 52;
  const headH = kind === "sold" ? 125 + 18 : tagH + 24;
  const hgt = headH + nm.lines.length * nm.lineH;
  const y0 = top ? 300 : H - 300 - hgt;
  face(ctx, 600, nm.size);
  const textW = Math.max(420, ...nm.lines.map(l => ctx.measureText(l).width));
  const textBox = { x: LEFT - 20, y: y0 - 30, w: textW + 40, h: hgt + 60 };

  // Where the link sticker would sit least in the way: under the name, or in
  // a corner, whichever patch of the photo is plainest.
  let sticker = null;
  if (kind === "listed") {
    const sw = 300, sh = 62, low = H - 250 - sh - 30, high = 270;
    const lastW = ctx.measureText(nm.lines[nm.lines.length - 1]).width;
    // Beside a short name, level with its last line.
    const beside = LEFT + lastW + 40 + sw <= W - LEFT
      ? { x: LEFT + lastW + 40, y: y0 + headH + (nm.lines.length - 1) * nm.lineH + Math.round((nm.lineH - sh) / 2), w: sw, h: sh, near: true } : null;
    // Under the name, then down both edges and along the foot of the story.
    const tries = [{ x: LEFT, y: y0 + hgt + 30, near: true }, { x: (W - sw) / 2, y: low }];
    for (let y = high; y <= low; y += 110) tries.push({ x: LEFT, y }, { x: W - LEFT - sw, y });
    const spots = tries.map(p => ({ ...p, w: sw, h: sh })).filter(p => p.y + sh <= H - 240 && p.y >= high && !overlaps(p, textBox));
    if (beside) spots.push(beside);
    // A small nudge towards the spots by the name, where people look for it.
    sticker = spots.map(p => ({ p, score: busyness(ctx, p) - (p.near ? .02 : 0) })).sort((a, b) => a.score - b.score)[0]?.p || null;
  }

  // A light shade under white type only, towards the edge the type sits on.
  if (light) {
    const g = top ? ctx.createLinearGradient(0, 0, 0, H * .4) : ctx.createLinearGradient(0, H * .55, 0, H);
    g.addColorStop(top ? 0 : 1, `rgba(0,0,0,${top ? .3 : .5})`);
    g.addColorStop(top ? 1 : 0, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = ink;

  if (kind === "sold") {
    face(ctx, 700, 132);
    ctx.fillText("Sold", LEFT - 4, y0 + 106);
    const after = LEFT + ctx.measureText("Sold").width + 14;
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
    ctx.font = `78px ${EMOJI}`;
    ctx.fillText("🔥", after, y0 + 94);
  }
  if (kind === "listed") {
    // A thin outlined tag: minimal, never louder than the name.
    face(ctx, 500, tagSize);
    const tw = ctx.measureText(TAG).width + 44;
    ctx.strokeStyle = ink; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(LEFT + 1, y0 + 1, tw, tagH - 2, (tagH - 2) / 2) : ctx.rect(LEFT + 1, y0 + 1, tw, tagH - 2); ctx.stroke();
    ctx.fillText(TAG, LEFT + 22, y0 + tagH / 2 + tagSize * .32);
  }
  face(ctx, 600, nm.size);
  if (kind === "sold") ctx.fillStyle = light ? "rgba(255,255,255,.9)" : "#2b2824";
  nm.lines.forEach((ln, i) => ctx.fillText(ln, LEFT, y0 + headH + Math.round(nm.size * .8) + i * nm.lineH));
  if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
  return sticker;
}


/* How the studio first frames a "Just listed" story for a photo: a studio
   shot on a plain background shown whole, a scene filling the screen; the
   type in the emptier band, dark on a light photo. Shared by the Stories
   module in the browser and by the server, so both make the same story. */
export function listedLayout(bmp) {
  const edge = edgeOf(bmp);
  const frame = { zoom: edge.plain ? Math.max(minZoom(bmp), W / bmp.width / coverScale(bmp)) : 1, ox: 0, oy: 0, bg: edge.bg };
  const r = readPhoto(bmp, frame);
  const place = r.top.spread <= r.bottom.spread ? "top" : "bottom";
  return { frame, place, tone: r[place].mean > .55 ? "dark" : "light" };
}
