/* Instagram stories for a listing: "Just listed" and "Sold 🔥", drawn from the
   piece's own photo at 1080×1920, set in one italic serif: "Sold 🔥" over the
   name, or the name alone. No logo: Instagram already puts the profile photo
   and @eartheditions_ on every story. The image goes to the phone's share
   sheet, so it lands straight in Instagram; the link sticker is added there,
   on the plainest patch of the photo, with the link copied from here. */
import { useEffect, useMemo, useRef, useState } from "react";
import { C, FI } from "./lmTheme.js";
import { loadBitmap } from "./glPipeline.js";
import { loadStoreProduct, storeSettings } from "./StoreApp.jsx";

const W = 1080, H = 1920, LEFT = 72, TEXT_W = W - 2 * LEFT;
const F = { serif: "EE Story Serif" };
const EMOJI = '"Apple Color Emoji","Noto Color Emoji","Segoe UI Emoji",sans-serif';

let fontsReady = null;
const loadFonts = () => fontsReady ||= Promise.all([
  [F.serif, "tinos-latin-400-italic", { style: "italic", weight: "400" }],
].map(async ([fam, file, desc]) => {
  const f = new FontFace(fam, `url(/fonts/story/${file}.woff2)`, desc);
  document.fonts.add(await f.load());
})).catch(e => { fontsReady = null; throw e; });

/* The name a story can carry: the store's short title, or the listing title
   cut at the first separator Etsy titles pile keywords behind. */
export const storyName = (l, storeTitle) => {
  const t = String(storeTitle || l.title || "").trim();
  const cut = storeTitle ? t : t.split(/\s[|–—\-·]\s|\||,/)[0].trim();
  const words = cut.split(/\s+/);
  return words.length > 9 ? words.slice(0, 9).join(" ") : cut;
};

const wrap = (ctx, s, max, width = t => ctx.measureText(t).width) => {
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
function readPhoto(bmp, frame) {
  const cv = document.createElement("canvas");
  cv.width = 54; cv.height = 96;
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

/* A photo's own background colour, from its outer edge: what runs on
   around the photo when it's zoomed out past the screen. */
function edgeOf(bmp) {
  const n = 40, cv = document.createElement("canvas");
  cv.width = cv.height = n;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, n, n);
  const px = ctx.getImageData(0, 0, n, n).data, rgb = [0, 0, 0];
  let count = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (x > 1 && x < n - 2 && y > 1 && y < n - 2) continue;
    const i = (y * n + x) * 4;
    rgb[0] += px[i]; rgb[1] += px[i + 1]; rgb[2] += px[i + 2]; count++;
  }
  const [r, g, b] = rgb.map(v => Math.round(v / count));
  return { bg: `rgb(${r},${g},${b})` };
}

// Zoom 1 fills the screen; the smallest zoom shows the whole photo.
const coverScale = bmp => Math.max(W / bmp.width, H / bmp.height);
export const minZoom = bmp => Math.min(W / bmp.width, H / bmp.height) / coverScale(bmp);

function drawPhoto(ctx, bmp, { zoom = 1, ox = 0, oy = 0, bg = "#f4f2ee" }, k = 1) {
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
function busyness(ctx, { x, y, w, h }) {
  const px = ctx.getImageData(x - 40, y - 40, w + 80, h + 80).data;
  let n = 0, sum = 0, sq = 0;
  for (let i = 0; i < px.length; i += 4 * 7) {
    const v = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
    n++; sum += v; sq += v * v;
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sq / n - mean * mean));
}
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/* The story itself. Returns where the link sticker goes, for the preview. */
function drawStory(ctx, bmp, { kind, name, place, tone, frame }) {
  ctx.clearRect(0, 0, W, H);
  drawPhoto(ctx, bmp, frame);
  const light = tone === "light", ink = light ? "#fff" : "#141210";
  const top = place === "top";

  // Everything is set in the one italic. A name takes one line if a smaller
  // size gets it there, and only then goes to two, smaller again if it must.
  const fit = (text, start, oneLineMin, min) => {
    const at = size => { ctx.font = `italic 400 ${size}px "${F.serif}"`; return wrap(ctx, text, TEXT_W); };
    let size = start, lines = at(size);
    while (lines.length > 1 && size > oneLineMin) lines = at(size -= 4);
    if (lines.length > 1) { size = Math.max(min, Math.min(start, oneLineMin + 8)); lines = at(size); }
    while (lines.length > 2 && size > min) lines = at(size -= 4);
    return { size, lines, lineH: Math.round(size * 1.04) };
  };
  const nm = kind === "sold" ? fit(name, 56, 42, 38) : fit(name, 92, 68, 56);
  // Above the name: "Sold 🔥" large, or a small "Just listed" tag.
  const TAG = "Just listed", tagSize = 32, tagH = 56;
  const headH = kind === "sold" ? 125 + 18 : tagH + 24;
  const hgt = headH + nm.lines.length * nm.lineH;
  const y0 = top ? 300 : H - 300 - hgt;
  ctx.font = `italic 400 ${nm.size}px "${F.serif}"`;
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
    ctx.font = `italic 400 132px "${F.serif}"`;
    ctx.fillText("Sold", LEFT, y0 + 106);
    const after = LEFT + ctx.measureText("Sold").width + 18;
    ctx.font = `78px ${EMOJI}`;
    ctx.fillText("🔥", after, y0 + 94);
  }
  if (kind === "listed") {
    // A thin outlined tag in the same italic: minimal, never louder than the name.
    ctx.font = `italic 400 ${tagSize}px "${F.serif}"`;
    const tw = ctx.measureText(TAG).width + 44;
    ctx.strokeStyle = ink; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(LEFT + 1, y0 + 1, tw, tagH - 2, (tagH - 2) / 2) : ctx.rect(LEFT + 1, y0 + 1, tw, tagH - 2); ctx.stroke();
    ctx.fillText(TAG, LEFT + 22, y0 + tagH / 2 + tagSize * .32);
  }
  ctx.font = `italic 400 ${nm.size}px "${F.serif}"`;
  if (kind === "sold") ctx.fillStyle = light ? "rgba(255,255,255,.9)" : "#2b2824";
  nm.lines.forEach((ln, i) => ctx.fillText(ln, LEFT, y0 + headH + Math.round(nm.size * .8) + i * nm.lineH));
  return sticker;
}

const pill = on => ({ padding: "7px 14px", borderRadius: 20, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
  border: `1.5px solid ${on ? C.ink : C.border}`, background: on ? C.ink : C.surface, color: on ? "#FAF0DC" : C.ink });

export default function StoryStudio({ listing: l, sold = false, kind: startKind, onShared, onClose }) {
  const photos = useMemo(() => (l.images || []).filter(u => typeof u === "string"), [l.images]);
  const [kind, setKind] = useState(startKind || (sold ? "sold" : "listed"));
  const [photo, setPhoto] = useState(0);
  const [bmp, setBmp] = useState(null);
  const [err, setErr] = useState("");
  const [name, setName] = useState(() => storyName(l));
  const [link, setLink] = useState("");
  const [place, setPlace] = useState("top");
  const [tone, setTone] = useState("dark");
  const [frame, setFrame] = useState({ zoom: 1, ox: 0, oy: 0 });
  const [sticker, setSticker] = useState(null);
  const [note, setNote] = useState("");
  const cv = useRef(null), drag = useRef(null), named = useRef(false), linkEdited = useRef(false), fileRef = useRef(null);

  // The store's short name and its public page, when the piece is on the store.
  useEffect(() => {
    let off = false;
    (async () => {
      // The piece's public page, filled in by itself: eartheditions.co first,
      // then the old Earth Editions Shopify store, then Etsy, then eBay —
      // wherever it's live, so the link sticker opens the piece.
      const P = l.platforms || {}, live = k => P[k]?.status === "active";
      const others = [
        live("store") && /^https?:\/\/(?!.*\/admin)/.test(P.store.url || "") && P.store.url,
        live("shopify_earth") && P.shopify_earth.storefront_url,
        live("etsy") && (P.etsy.url || (P.etsy.listing_id && `https://www.etsy.com/listing/${P.etsy.listing_id}`)),
        live("ebay") && (P.ebay.url || (P.ebay.item_id && `https://www.ebay.com/itm/${P.ebay.item_id}`)),
      ].filter(Boolean);
      let store = "";
      try {
        const [row, s] = await Promise.all([loadStoreProduct(l.id), storeSettings().catch(() => ({}))]);
        if (off) return;
        if (row?.title && !named.current) setName(storyName(l, row.title));
        const base = String(s?.site_url || "https://eartheditions.co").replace(/\/+$/, "");
        if (row?.handle && row.status === "active") store = `${base}/products/${row.handle}`;
      } catch {}
      if (!off && !linkEdited.current) setLink(store || others[0] || "");
    })();
    return () => { off = true; };
  }, [l.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let off = false;
    setBmp(null); setErr("");
    if (!photos[photo]) { setErr("This listing has no photos yet."); return; }
    Promise.all([loadBitmap(photos[photo]), loadFonts()]).then(([b]) => {
      if (off) return;
      /* Every photo opens filling the screen. The zoom goes out to the whole
         photo, with its own background colour carried on around it. */
      const f = { zoom: 1, ox: 0, oy: 0, bg: edgeOf(b).bg };
      const r = readPhoto(b, f);
      // Sold reads best up top; a new listing wherever the photo is emptiest.
      const pick = r.top.spread <= r.bottom.spread * (kind === "sold" ? 1.4 : 1) ? "top" : "bottom";
      setPlace(pick);
      setTone(r[pick].mean > .55 ? "dark" : "light");
      setFrame(f); setBmp(b);
    }).catch(e => !off && setErr(e.message || "Couldn't load the photo."));
    return () => { off = true; };
  }, [photo, photos]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!bmp || !cv.current) return;
    setSticker(drawStory(cv.current.getContext("2d"), bmp, { kind, name: name.trim() || " ", place, tone, frame }));
  }, [bmp, kind, name, place, tone, frame]);

  useEffect(() => { const k = e => e.key === "Escape" && onClose(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose]);

  const flash = m => { setNote(m); setTimeout(() => setNote(""), 2600); };
  const fileName = `${kind === "sold" ? "Sold" : "Just-listed"}-${name.trim().replace(/[^\w]+/g, "-").replace(/^-|-$/g, "") || "piece"}.jpg`;
  const toFile = () => new Promise((ok, no) => cv.current.toBlob(b => b ? ok(new File([b], fileName, { type: "image/jpeg" })) : no(new Error("Couldn't make the image")), "image/jpeg", .93));

  /* The image is made as the preview settles, so tapping Share opens the share
     sheet straight away: iPhone only allows it right off the tap. Each image
     carries the edit it was made from; one that finishes after a later edit
     is thrown away, so Share never sends older text than the preview shows. */
  const edit = useRef(0);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const n = ++edit.current;
    fileRef.current = null; setReady(false);
    if (!bmp) return undefined;
    const t = setTimeout(() => toFile().then(f => { if (n === edit.current) { fileRef.current = f; setReady(true); } }).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [bmp, kind, name, place, tone, frame]); // eslint-disable-line react-hooks/exhaustive-deps

  const share = async () => {
    try {
      const file = fileRef.current;
      if (!file) return;
      if (navigator.canShare?.({ files: [file] })) {
        if (kind === "listed" && link) navigator.clipboard?.writeText(link).catch(() => {});
        await navigator.share({ files: [file] });
        onShared?.(kind);
        return;
      }
      await save(file);
    } catch (e) { if (e?.name !== "AbortError") flash("⚠ " + e.message); }
  };
  const save = async file => {
    file ||= await toFile();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file); a.download = file.name; a.click();
    onShared?.(kind);
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  const copy = async () => { try { await navigator.clipboard.writeText(link); flash("Link copied"); } catch { flash("Couldn't copy — select the link and copy it"); } };

  // Drag the photo to reframe it; the story stays full bleed.
  const down = e => { if (!bmp) return; e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, f: frame, k: W / e.currentTarget.clientWidth }; };
  const moveP = e => { const d = drag.current; if (!d) return; setFrame({ ...d.f, ox: d.f.ox + (e.clientX - d.x) * d.k, oy: d.f.oy + (e.clientY - d.y) * d.k }); };
  const up = () => { drag.current = null; };

  const pct = (v, of) => `${(v / of) * 100}%`;
  const phone = typeof window !== "undefined" && window.innerWidth < 700;

  return (
    <div onMouseDown={e => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, zIndex: 1300, background: "rgba(20,15,8,.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: phone ? 0 : 20 }}>
      <div style={{ background: C.bg, width: "100%", maxWidth: 860, maxHeight: "100%", overflowY: "auto", borderRadius: phone ? 0 : 14, boxShadow: "0 20px 60px rgba(0,0,0,.3)", height: phone ? "100%" : "auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", borderBottom: `1px solid ${C.border}`, background: C.surface, position: "sticky", top: 0, zIndex: 2 }}>
          <div style={{ flex: 1, fontSize: 17, fontWeight: 700, color: C.ink }}>Instagram story</div>
          <button onClick={onClose} style={{ border: "none", background: "none", fontSize: 24, cursor: "pointer", color: C.inkMid }}>×</button>
        </div>
        <div style={{ display: "flex", gap: 20, padding: 18, flexWrap: phone ? "wrap" : "nowrap", alignItems: "flex-start" }}>
          <div style={{ position: "relative", width: phone ? "min(64%, 34vh)" : 300, aspectRatio: "9 / 16", margin: phone ? "0 auto" : 0, flex: "none", borderRadius: 14, overflow: "hidden", background: C.card, boxShadow: "0 8px 24px rgba(0,0,0,.18)" }}>
            <canvas ref={cv} width={W} height={H} onPointerDown={down} onPointerMove={moveP} onPointerUp={up} onPointerCancel={up}
              style={{ width: "100%", height: "100%", display: "block", touchAction: "none", cursor: bmp ? "grab" : "default", opacity: bmp ? 1 : 0 }} />
            {!bmp && <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: C.inkMid, fontSize: 13, padding: 20, textAlign: "center" }}>{err || "Loading the photo…"}</div>}
            {bmp && sticker && (
              <div title="Add Instagram's link sticker here" style={{ position: "absolute", left: pct(sticker.x, W), top: pct(sticker.y, H), width: pct(sticker.w, W), height: pct(sticker.h, H),
                border: `1.5px dashed ${tone === "light" ? "rgba(255,255,255,.85)" : "rgba(20,18,16,.6)"}`, borderRadius: 6, color: tone === "light" ? "#fff" : "#141210",
                fontSize: 10, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>🔗 link sticker</div>
            )}
          </div>

          <div style={{ flex: phone ? "1 1 100%" : 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setKind("listed")} style={pill(kind === "listed")}>Just listed</button>
              <button onClick={() => setKind("sold")} style={pill(kind === "sold")}>Sold 🔥</button>
            </div>

            <label style={{ display: "block" }}>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: .6, textTransform: "uppercase", color: C.inkMid, marginBottom: 6 }}>Name on the story</div>
              <input value={name} onChange={e => { named.current = true; setName(e.target.value); }} style={FI({ fontSize: 16 })} />
            </label>

            {photos.length > 1 && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: .6, textTransform: "uppercase", color: C.inkMid, marginBottom: 6 }}>Photo</div>
                <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4 }}>
                  {photos.map((u, i) => (
                    <img key={u + i} src={u} alt="" onClick={() => setPhoto(i)} style={{ width: 52, height: 52, objectFit: "cover", borderRadius: 7, cursor: "pointer", flex: "none",
                      outline: i === photo ? `2.5px solid ${C.gold}` : "none", outlineOffset: -2.5, opacity: i === photo ? 1 : .75 }} />
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: .6, textTransform: "uppercase", color: C.inkMid, marginBottom: 6 }}>Text</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => setPlace("top")} style={pill(place === "top")}>Top</button>
                  <button onClick={() => setPlace("bottom")} style={pill(place === "bottom")}>Bottom</button>
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: .6, textTransform: "uppercase", color: C.inkMid, marginBottom: 6 }}>Colour</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => setTone("dark")} style={pill(tone === "dark")}>Black</button>
                  <button onClick={() => setTone("light")} style={pill(tone === "light")}>White</button>
                </div>
              </div>
            </div>

            <label style={{ display: "block" }}>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: .6, textTransform: "uppercase", color: C.inkMid, marginBottom: 6 }}>Zoom · drag the photo to move it</div>
              <input type="range" min={bmp ? minZoom(bmp).toFixed(3) : 1} max="2.5" step="0.01" value={frame.zoom} onChange={e => setFrame(f => ({ ...f, zoom: +e.target.value }))} style={{ width: "100%" }} />
            </label>

            {kind === "listed" && (
              <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12 }}>
                <div style={{ fontSize: 12, color: C.inkMid, marginBottom: 8 }}>Link for Instagram's link sticker{link ? "" : " — this piece isn't live on the store or Etsy yet, so paste one in"}</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <input value={link} onChange={e => { linkEdited.current = true; setLink(e.target.value); }} placeholder="https://eartheditions.co/products/…" style={FI({ fontSize: 13 })} />
                  <button onClick={copy} disabled={!link} style={{ ...pill(false), flex: "none", opacity: link ? 1 : .5 }}>Copy</button>
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button disabled={!ready} onClick={share} style={{ ...pill(true), padding: "11px 22px", fontSize: 14, opacity: ready ? 1 : .5 }}>{bmp && !ready ? "Updating…" : "Share to Instagram"}</button>
              <button disabled={!bmp} onClick={() => save().catch(e => flash("⚠ " + e.message))} style={{ ...pill(false), padding: "11px 18px", fontSize: 14, opacity: bmp ? 1 : .5 }}>Download</button>
              {note && <span style={{ fontSize: 12.5, color: C.inkMid }}>{note}</span>}
            </div>
            <div style={{ fontSize: 12, color: C.inkFaint, lineHeight: 1.5 }}>
              {kind === "listed"
                ? "Share opens your phone's share sheet: pick Instagram → Story. The link is copied as you share, so add the link sticker, paste, and set it on the dashed box."
                : "Share opens your phone's share sheet: pick Instagram → Story, and post."}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
