/* Soniya → Planner: Atyahara's Instagram, planned on a calendar and worked
   post by post with Sir.

   How it works
   - Month view: Soniya lays out the month (subject, format, tile colour, why).
   - A post is worked in stages (direction → words → body → visual → caption).
     At each stage Sir picks one of three options, asks for a change in a note,
     or edits the words himself. Every change is kept as a version.
   - "First" is Soniya's first full draft; on approval the planner compares it
     with the final, scores how much Sir changed, and Soniya writes down what she
     learned (app_rows soniya-notes-v1, kind "lesson", source "planner"). Her
     next drafts start from those lessons, so the change score should fall.
   - Phase 2: "Edit in Canva" sends the post to Canva as a one-slide PowerPoint
     (every line and photo editable, api/canva.js import); "Bring back" exports
     it as the final JPEG. An approved post is scheduled into the Social
     autopilot queue (ng-social-queue-v1) for @atyahara at its date and time,
     and goes out only after Sir has approved it.

   Storage: app_rows "soniya-ig-v1", one row per post. Renders: public/soniya/post.html.
   AI: /api/claude (metered by Girton). */
import { useState, useEffect, useMemo, useRef } from "react";
import { supabase } from "./supabase.js";
import { C, mob, FI } from "./lmTheme.js";
import { fetchWithRetry } from "./aiClient.js";
import { uploadToStorage } from "./storageUtils.js";
import { NINE_STUDY, LIBRARY } from "./soniya/nineStudy.js";

const KEY = "soniya-ig-v1", NOTES = "soniya-notes-v1";
const SERIF = "'Cormorant Garamond',Georgia,serif";
const ACCENT = "#8A5A2B";
const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 16px", minWidth: 0 };
const btn = (bg = C.surface, fg = C.ink) => ({ background: bg, color: fg, border: bg === C.surface ? `1px solid ${C.border}` : "none", borderRadius: 7, padding: "7px 13px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" });
const lab = { fontSize: 9.5, fontWeight: 700, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6, marginBottom: 4, display: "block" };
const sub = { fontSize: 11.5, color: C.inkFaint };
const uid = () => Math.random().toString(36).slice(2, 10);
const DAY = 864e5;
const ymd = d => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const fmtDay = d => d ? new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : "";

export const TILES = { rose: "#DDA99D", sage: "#B5B596", ivory: "#EFE6D8", terracotta: "#A85B43", white: "#F7F3EE", mauve: "#9C747A", sand: "#DCC8AC", moss: "#5E6247", blush: "#EBCDC3" };
const DARK = new Set(["terracotta", "mauve", "moss"]);
const FORMATS = {
  archive: ["The Archive · object", "A museum or collection object cut out on its own. kicker ≤30 chars (italic lead-in, ends mid-sentence); headline ≤12 chars, one or two words, e.g. “JADE.”; dev ≤8 aksharas; body ≤240 chars; credit = full museum credit line. Needs a cut-out image (transparent PNG)."],
  relic: ["The Archive · centred", "One object centred, a big pale Devanagari word behind it. dev 2–3 aksharas; kicker ≤26 chars; headline ≤22 chars; body ≤220 chars; credit. Needs a cut-out image."],
  plate: ["The Archive · plate", "A framed museum plate. kicker ≤28 chars; headline ≤18 chars; dev ≤5 aksharas; figure ≤60 chars (“Fig. 3 · …”); body ≤240 chars; credit. Landscape photo."],
  word: ["The Word", "One Devanagari word as a dictionary entry. dev 2–4 aksharas (shown huge); translit (IAST); gram e.g. “noun, Sanskrit”; points = exactly 2: {k:\"Meaning\", v:\"1. …\\n2. …\"} and {k:\"In use\", v:\"…\"}, each v ≤150 chars; credit ≤60 chars. No photo."],
  specimen: ["Specimen", "A catalogue sheet for one piece. kicker e.g. “Specimen Nº 02”; headline ≤34 chars; dev ≤6 aksharas; points = up to 6 rows {k:\"Mineral\"|\"Locality\"|\"Form\"|\"Size\"|\"Hardness\"…, v ≤40 chars}; body ≤130 chars. Up to 3 photos (image, image2, image3)."],
  craft: ["Craft · steps", "A craft explained in three steps under a wide photo. kicker ≤40 chars (place · subject); headline ≤12 chars, one word; dev + translit (gloss in quotes ≤36 chars); points = exactly 3 {v ≤130 chars}; credit. Landscape photo."],
  window: ["Craft · arched window", "Tall arched photo at right. dev ≤5 aksharas; headline ≤40 chars; body ≤320 chars; credit. Portrait photo."],
  hand: ["In the Hand", "The piece held in a hand on white. dev ≤6 aksharas; headline ≤28 chars; body ≤200 chars. Photo on a white ground."],
  frieze: ["In the Hand · row", "A row of pieces across the middle. dev ≤5 aksharas; kicker ≤40 chars; points = 3–6 labels {k ≤14 chars}; body ≤160 chars; credit ≤60 chars. Wide photo of the row."],
};
const SERIES = { archive: "archive", relic: "archive", plate: "archive", word: "word", specimen: "specimen", craft: "craft", window: "craft", hand: "hand", frieze: "hand" };
const TEXT = ["direction", "kicker", "headline", "dev", "translit", "gram", "body", "figure", "credit", "caption", "hashtags"];
const STAGES = [
  ["direction", "1 · Direction", "The story this post tells, and the format it takes.", ["direction", "format"]],
  ["words", "2 · Headline & Devanagari", "What reads first on the grid.", ["kicker", "headline", "dev", "translit", "gram"]],
  ["body", "3 · Story", "The body, the facts and the credit.", ["body", "points", "figure", "credit"]],
  ["visual", "4 · Visual", "Layout, tile colour and photographs.", ["format", "tile", "image", "image2", "image3"]],
  ["caption", "5 · Caption", "The Instagram caption and hashtags.", ["caption", "hashtags"]],
];
const STATUS = { idea: ["Idea", C.inkMid, C.card], draft: ["Working", C.blue, C.blueBg], approved: ["Approved", C.green, C.greenBg], scheduled: ["Scheduled", C.purple, C.purpleBg], published: ["Published", C.inkMid, C.card], skipped: ["Skipped", C.inkFaint, C.card] };
/* A finished image that is posted as it is: a Canva export, or a file supplied ready-made (source "file"). */
const fixedFinal = p => !!p?.final?.url && ["canva", "file"].includes(p.final.source);
const finalName = p => p.final?.source === "file" ? "Finished file" : "Canva version";
const Tag = ({ c = C.inkMid, bg = C.card, children }) => <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: .4, background: bg, color: c, borderRadius: 4, padding: "2px 6px", whiteSpace: "nowrap" }}>{children}</span>;

/* ── storage ─────────────────────────────────────────────────────────── */
async function rowsOf(key) {
  const { data, error } = await supabase.from("app_rows").select("data").eq("key", key).eq("deleted", false).order("pos", { ascending: true }).limit(2000);
  if (error) throw new Error(error.message);
  return (data || []).map(r => r.data);
}
async function put(key, item) {
  const { error } = await supabase.rpc("app_rows_upsert", { p_key: key, p_item: { ...item, updated_at: new Date().toISOString() }, p_prepend: false });
  if (error) throw new Error(error.message);
}

/* ── how much changed between Soniya's first draft and the final ─────── */
const words = s => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
function sim(a, b) {
  const x = words(a), y = words(b);
  if (!x.length && !y.length) return 1;
  if (!x.length || !y.length) return 0;
  // longest common subsequence over words: order matters, as it does in a headline
  const m = x.length, n = y.length, dp = Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) { let prev = 0; for (let j = 1; j <= n; j++) { const t = dp[j]; dp[j] = x[i - 1] === y[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]); prev = t; } }
  return (2 * dp[n]) / (m + n);
}
const ptsText = p => (p || []).map(x => `${x.k || ""} ${x.v || ""}`).join(" ");
export function changeScore(first, fin) {
  if (!first || !fin) return null;
  const parts = [];
  for (const f of TEXT) if (first[f] || fin[f]) parts.push(1 - sim(first[f], fin[f]));
  if ((first.points || []).length || (fin.points || []).length) parts.push(1 - sim(ptsText(first.points), ptsText(fin.points)));
  for (const f of ["format", "tile", "image"]) if (first[f] || fin[f]) parts.push(first[f] === fin[f] ? 0 : 1);
  return parts.length ? Math.round(100 * parts.reduce((s, v) => s + v, 0) / parts.length) : 0;
}

/* ── the render ───────────────────────────────────────────────────────── */
function stampNos(posts) {
  const n = {}, out = {};
  for (const p of [...posts].filter(p => p.status !== "skipped" && p.cur).sort((a, b) => (a.date || "").localeCompare(b.date || ""))) {
    const s = SERIES[p.cur.format] || "archive"; n[s] = (n[s] || 0) + 1; out[p.id] = n[s];
  }
  return out;
}
export function Preview({ data, width = 300, no, style }) {
  const d = { ...(data || {}), stamp: { no: no || 1 } };
  const h = Math.round(width * 1.25);
  return <div style={{ width, height: h, overflow: "hidden", position: "relative", background: TILES[d.tile] || C.card, borderRadius: 4, flexShrink: 0, ...style }}>
    <iframe title="post" loading="lazy" src={`/soniya/post.html#${encodeURIComponent(JSON.stringify(d))}`}
      style={{ width: 1080, height: 1350, border: 0, transform: `scale(${width / 1080})`, transformOrigin: "0 0", pointerEvents: "none", position: "absolute", left: 0, top: 0 }} />
  </div>;
}

// A preview that fills the width of its box.
function AutoPreview({ data, no, style }) {
  const ref = useRef(null);
  const [w, setW] = useState(0);
  useEffect(() => { const el = ref.current; if (!el) return; const ro = new ResizeObserver(() => setW(el.clientWidth)); ro.observe(el); return () => ro.disconnect(); }, []);
  return <div ref={ref} style={{ width: "100%" }}>{w > 0 && <Preview data={data} width={w} no={no} style={style} />}</div>;
}

/* ── Soniya's voice for this page ────────────────────────────────────── */
function rules(brief, lessons) {
  return `${brief}

You are planning and writing Atyahara's Instagram grid with Sir, post by post, in the ERP planner.
The visual system is fixed: the nine-post study in the earth palette. Big Devanagari display (Gajraj One), Gloock headlines, EB Garamond text, a round registry stamp, nine tile colours of one dusty depth (${Object.keys(TILES).join(", ")}); cocoa ink, never yellow, never black.
Formats and their limits (keep strictly to the character limits: the layout is fixed and long text overflows):
${Object.entries(FORMATS).map(([k, [n, d]]) => `- ${k} (${n}): ${d}`).join("\n")}
House rules: British spelling. ₹ for prices, and only prices you are given. No healing or metaphysical claims. Never invent a fact, a date, a museum number or a provenance: if you are not sure, write it with “[check: …]” so Sir can verify. Museum images must be public domain or CC; say which in the credit. Devanagari must be real, natural Hindi or Sanskrit; give it in the dev field and its transliteration where the format asks.
Caption: 3–6 short paragraphs, plain and specific, no emoji walls, no “✨”, ends with the piece’s availability only if it is an Atyahara piece. Hashtags: 5–10, specific (#rockcrystal, #indianart), on one line.
${lessons.length ? `WHAT YOU HAVE LEARNED FROM SIR'S EDITS (follow these):\n${lessons.map(l => `- ${l}`).join("\n")}` : ""}
Answer with JSON only, no prose, no code fences.`;
}
async function ask(system, user, max = 2200) {
  const res = await fetchWithRetry("/api/claude", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ max_tokens: max, messages: [{ role: "system", content: system }, { role: "user", content: user }] }) }, { tries: 2, timeoutMs: 120000 });
  const d = await res.json();
  if (d.error) throw new Error(d.error?.message || d.error);
  const t = (d.content || []).map(x => x.text || "").join("").trim();
  const a = t.search(/[[{]/), b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  try { return JSON.parse(t.slice(a, b + 1)); } catch { throw new Error("Soniya's answer wasn't readable. Try again."); }
}
const FIELDS_JSON = `{"direction":"one sentence: the story","format":"one of ${Object.keys(FORMATS).join("|")}","kicker":"","headline":"","dev":"Devanagari","translit":"","gram":"","body":"","points":[{"k":"","v":""}],"figure":"","credit":"","image_brief":"the photograph this post needs, specific","caption":"","hashtags":"#a #b"}`;
const postBrief = p => JSON.stringify({ date: p.date, subject: p.idea?.subject, angle: p.idea?.angle, why: p.idea?.why, ...(p.cur ? { current: { ...p.cur, image: p.cur.image ? "(set)" : "", image2: undefined, image3: undefined } } : {}) });

/* ── a post, worked in stages ────────────────────────────────────────── */
function Field({ label, value, onSave, rows = 1, mono }) {
  const [v, setV] = useState(value || "");
  useEffect(() => setV(value || ""), [value]);
  const dirty = (v || "") !== (value || "");
  return <div style={{ marginBottom: 8 }}>
    <span style={lab}>{label}</span>
    <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
      {rows > 1 ? <textarea value={v} onChange={e => setV(e.target.value)} rows={rows} style={FI({ flex: 1, resize: "vertical", fontSize: 13, ...(mono ? { fontFamily: "'Tiro Devanagari Hindi',serif" } : {}) })} />
        : <input value={v} onChange={e => setV(e.target.value)} style={FI({ flex: 1, width: "auto", fontSize: 13 })} />}
      {dirty && <button onClick={() => onSave(v)} style={btn(C.ink, "#fff")}>Save</button>}
    </div>
  </div>;
}
function PointsField({ value, onSave }) {
  const [t, setT] = useState("");
  const fmt = p => (p || []).map(x => [x.k, x.v].filter(Boolean).join(" | ")).join("\n");
  useEffect(() => setT(fmt(value)), [value]);
  const parse = s => s.split("\n").map(l => l.trim()).filter(Boolean).map(l => { const [k, ...v] = l.split("|"); return v.length ? { k: k.trim(), v: v.join("|").trim().replace(/\\n/g, "\n") } : { v: k.trim() }; });
  return <div style={{ marginBottom: 8 }}>
    <span style={lab}>Points (one per line, “label | text”)</span>
    <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
      <textarea value={t} onChange={e => setT(e.target.value)} rows={Math.max(3, t.split("\n").length)} style={FI({ flex: 1, resize: "vertical", fontSize: 12.5 })} />
      {t !== fmt(value) && <button onClick={() => onSave(parse(t))} style={btn(C.ink, "#fff")}>Save</button>}
    </div>
  </div>;
}
function ImagePick({ label, value, onPick, library }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const file = useRef(null);
  const up = async f => { if (!f) return; setBusy(true); try { onPick(await uploadToStorage(`soniya/ig/${Date.now()}-${f.name.replace(/[^\w.-]/g, "_")}`, f)); setOpen(false); } catch (e) { alert(e.message); } setBusy(false); };
  return <div style={{ marginBottom: 8 }}>
    <span style={lab}>{label}</span>
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      {value ? <img src={value} alt="" style={{ width: 54, height: 54, objectFit: "cover", borderRadius: 6, border: `1px solid ${C.border}`, background: C.card }} /> : <div style={{ width: 54, height: 54, borderRadius: 6, border: `1px dashed ${C.border}` }} />}
      <button onClick={() => setOpen(!open)} style={btn()}>{value ? "Change" : "Choose photo"}</button>
      {value && <button onClick={() => onPick("")} style={btn()}>Remove</button>}
    </div>
    {open && <div style={{ marginTop: 8, padding: 10, background: C.card, borderRadius: 8 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{library.map(u => <img key={u} src={u} alt="" onClick={() => { onPick(u); setOpen(false); }} style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 6, cursor: "pointer", border: `2px solid ${u === value ? ACCENT : "transparent"}`, background: "#fff" }} />)}</div>
      <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder="…or paste an image address (https://)" style={FI({ flex: 1, minWidth: 180, width: "auto", fontSize: 12.5 })} />
        <button disabled={!/^https?:\/\//.test(url)} onClick={() => { onPick(url.trim()); setOpen(false); setUrl(""); }} style={btn()}>Use</button>
        <button disabled={busy} onClick={() => file.current?.click()} style={btn()}>{busy ? "Uploading…" : "Upload"}</button>
        <input ref={file} type="file" accept="image/*" style={{ display: "none" }} onChange={e => up(e.target.files?.[0])} />
      </div>
    </div>}
  </div>;
}

function Stage({ st, post, no, busy, onPatch, onOptions, onChoose, library }) {
  const [key, title, hint, fields] = st;
  const cur = post.cur || {};
  const [note, setNote] = useState("");
  const opts = post.options?.stage === key ? post.options : null;
  const set = (f, v, why) => onPatch({ [f]: v }, key, why || "Sir edited");
  return <div style={{ ...card, marginBottom: 10 }}>
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
      <div style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700 }}>{title}</div><div style={{ ...sub, flex: 1 }}>{hint}</div>
    </div>
    {key === "direction" && <>
      <Field label="The story" value={cur.direction} rows={2} onSave={v => set("direction", v)} />
      <span style={lab}>Format</span>
      <select value={cur.format || "archive"} onChange={e => set("format", e.target.value, "Sir chose the format")} style={FI({ width: "auto", fontSize: 13, marginBottom: 6 })}>
        {Object.entries(FORMATS).map(([k, [n]]) => <option key={k} value={k}>{n}</option>)}</select>
      <div style={{ ...sub, marginBottom: 8 }}>{FORMATS[cur.format || "archive"]?.[1]}</div>
    </>}
    {key === "words" && <>
      {["kicker", "headline", "dev", "translit", "gram"].map(f => <Field key={f} label={{ kicker: "Kicker (lead-in / label)", headline: "Headline", dev: "Devanagari", translit: "Transliteration / gloss", gram: "Grammar note" }[f]} value={cur[f]} mono={f === "dev"} onSave={v => set(f, v)} />)}
    </>}
    {key === "body" && <>
      <Field label="Body" value={cur.body} rows={4} onSave={v => set("body", v)} />
      <PointsField value={cur.points} onSave={v => set("points", v)} />
      <Field label="Figure line (plate only)" value={cur.figure} onSave={v => set("figure", v)} />
      <Field label="Credit" value={cur.credit} rows={2} onSave={v => set("credit", v)} />
    </>}
    {key === "visual" && <>
      {cur.image_brief && <div style={{ fontSize: 12.5, background: "#F6EEE4", borderRadius: 8, padding: "7px 10px", marginBottom: 8 }}><b>Photo Soniya wants:</b> {cur.image_brief}</div>}
      <span style={lab}>Tile colour</span>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>{Object.entries(TILES).map(([k, hex]) => <button key={k} title={k} onClick={() => set("tile", k, `Sir chose ${k}`)}
        style={{ width: 34, height: 34, borderRadius: 6, background: hex, cursor: "pointer", border: cur.tile === k ? `3px solid ${C.ink}` : `1px solid ${C.border}` }} />)}</div>
      <span style={lab}>Layout</span>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>{Object.entries(FORMATS).map(([k, [n]]) => <button key={k} onClick={() => set("format", k, `Sir chose ${n}`)} style={cur.format === k ? btn(C.ink, "#fff") : btn()}>{n}</button>)}</div>
      <ImagePick label="Photograph" value={cur.image} library={library} onPick={u => set("image", u, "Sir chose the photo")} />
      {cur.format === "specimen" && <><ImagePick label="Second photo" value={cur.image2} library={library} onPick={u => set("image2", u)} /><ImagePick label="Third photo" value={cur.image3} library={library} onPick={u => set("image3", u)} /></>}
    </>}
    {key === "caption" && <>
      <Field label="Caption" value={cur.caption} rows={7} onSave={v => set("caption", v)} />
      <Field label="Hashtags" value={cur.hashtags} onSave={v => set("hashtags", v)} />
    </>}

    <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
      <input value={note} onChange={e => setNote(e.target.value)} placeholder={key === "visual" ? "e.g. “calmer: try sage and the plate layout”" : "Tell Soniya what to change (optional)"} style={FI({ flex: 1, minWidth: 200, width: "auto", fontSize: 12.5 })} />
      <button disabled={busy} onClick={() => { onOptions(key, note.trim()); setNote(""); }} style={btn(ACCENT, "#fff")}>{busy === key ? "Thinking…" : note.trim() ? "Redo with my note" : "Show me 3 options"}</button>
    </div>

    {opts && <div style={{ marginTop: 10 }}>
      {opts.note && <div style={{ ...sub, marginBottom: 6 }}>Your note: “{opts.note}”</div>}
      <div style={{ display: "grid", gridTemplateColumns: mob() ? "minmax(0,1fr)" : "repeat(3,minmax(0,1fr))", gap: 8 }}>
        {opts.list.map((o, i) => <div key={i} style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: 10, background: C.bg, display: "flex", flexDirection: "column", gap: 6 }}>
          {key === "visual" && <AutoPreview data={{ ...cur, ...o.patch }} no={no} />}
          <div style={{ fontWeight: 700, fontSize: 13 }}>{o.label}</div>
          {key !== "visual" && <div style={{ fontSize: 12.5, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{Object.entries(o.patch || {}).map(([k, v]) => <div key={k}><span style={{ color: C.inkFaint }}>{k}: </span>{Array.isArray(v) ? v.map(x => [x.k, x.v].filter(Boolean).join(": ")).join(" · ") : String(v)}</div>)}</div>}
          {o.why && <div style={{ ...sub, fontStyle: "italic" }}>{o.why}</div>}
          <button onClick={() => onChoose(key, o)} style={{ ...btn(C.ink, "#fff"), marginTop: "auto" }}>Use this</button>
        </div>)}
      </div>
    </div>}
  </div>;
}


/* ── render in a hidden full-size frame: JPEG for Instagram, PPTX for Canva ── */
function inFrame(data, fn) {
  return new Promise((resolve, reject) => {
    const f = document.createElement("iframe");
    f.style.cssText = "position:fixed;left:-20000px;top:0;width:1080px;height:1350px;border:0;opacity:0;pointer-events:none";
    f.src = `/soniya/post.html#${encodeURIComponent(JSON.stringify(data))}`;
    const done = (fnErr, v) => { f.remove(); fnErr ? reject(fnErr) : resolve(v); };
    const timer = setTimeout(() => done(new Error("The render took too long. Try again.")), 60000);
    f.onload = async () => { try { const v = await f.contentWindow[fn](); clearTimeout(timer); done(null, v); } catch (e) { clearTimeout(timer); done(e); } };
    document.body.appendChild(f);
  });
}
const b64Blob = (b64, type) => { const bin = atob(b64.replace(/^data:[^,]+,/, "")); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return new Blob([a], { type }); };
const PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
async function store(blob, name) { return uploadToStorage(`soniya/ig/${Date.now()}-${name}`, new File([blob], name, { type: blob.type })); }
async function api(path, body) {
  const r = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) { const e = new Error(typeof d.error === "string" ? d.error : d.error?.message || `HTTP ${r.status}`); e.needsAuth = d.needsAuth; throw e; }
  return d;
}
const istAt = (date, time) => new Date(`${date}T${time || "19:30"}:00+05:30`).toISOString();
const captionOf = c => [c?.caption, c?.hashtags].filter(Boolean).join("\n\n");

/* ── 6 · Canva & Instagram ───────────────────────────────────────────── */
function Publish({ post, no, onSave, ig }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [needCanva, setNeedCanva] = useState(false);
  const cur = post.cur || {};
  const lastEdit = post.versions?.length ? post.versions[post.versions.length - 1].at : "";
  const stale = post.final?.source === "canva" && lastEdit > post.final.at;
  const run = async (k, fn) => { setBusy(k); setErr(""); try { await fn(); } catch (e) { setErr(e.message); if (e.needsAuth) setNeedCanva(true); } setBusy(""); };
  const data = { ...cur, stamp: { no: no || 1 } };

  const toCanva = () => run("canva", async () => {
    const b64 = await inFrame(data, "soniyaPptx");
    const url = await store(b64Blob(b64, PPTX_TYPE), `${post.id}.pptx`);
    const d = await api("/api/canva", { action: "import", url, title: `Atyahara · ${post.date} · ${cur.headline || cur.dev || post.idea?.subject || "post"}`.slice(0, 50) });
    await onSave({ ...post, canva: { design_id: d.design_id, edit_url: d.edit_url, at: new Date().toISOString() } });
  });
  const fromCanva = () => run("back", async () => {
    const d = await api("/api/canva", { action: "export", design_id: post.canva.design_id, jpg: true, width: 1080, height: 1350 });
    const url = await store(b64Blob(d.image, "image/jpeg"), `${post.id}-canva.jpg`);
    await onSave({ ...post, final: { url, source: "canva", at: new Date().toISOString() } });
  });
  const imageForPost = async () => {
    if (fixedFinal(post)) return post.final;
    const jpg = await inFrame(data, "soniyaJpeg");
    return { url: await store(b64Blob(jpg, "image/jpeg"), `${post.id}-final.jpg`), source: "erp", at: new Date().toISOString() };
  };
  const schedule = () => run("schedule", async () => {
    if (!ig?.ok) throw new Error("The ERP can't post to @atyahara yet (see the note above).");
    const at = istAt(post.date, post.time);
    if (Date.parse(at) < Date.now() + 5 * 6e4) throw new Error("That time has passed. Change the date or time first.");
    if (!cur.caption && !window.confirm("This post has no caption yet. Schedule it anyway?")) return;
    const final = await imageForPost();
    const qid = crypto.randomUUID();
    await api("/api/social?action=schedule", { at, items: [{ id: qid, platform: "instagram", payload: { account: "atyahara", text: captionOf(cur), images: [final.url], title: cur.headline || post.idea?.subject || "", source: `soniya:${post.id}` } }] });
    await onSave({ ...post, status: "scheduled", final, queue_id: qid, scheduled_at: at, post_error: null });
  });
  const unschedule = () => run("unschedule", async () => {
    if (post.queue_id) await api("/api/social?action=unschedule", { id: post.queue_id });
    await onSave({ ...post, status: "approved", queue_id: null, scheduled_at: null });
  });
  const postNow = () => run("now", async () => {
    if (!ig?.ok) throw new Error("The ERP can't post to @atyahara yet (see the note above).");
    if (!window.confirm("Post this to @atyahara on Instagram now?")) return;
    const final = await imageForPost();
    const d = await api("/api/social?action=post&p=instagram", { p: "instagram", account: "atyahara", text: captionOf(cur), images: [final.url], title: cur.headline || "", source: `soniya:${post.id}` });
    await onSave({ ...post, status: "published", final, published_at: new Date().toISOString(), url: d.url || "" });
  });

  return <div style={{ ...card, marginBottom: 10 }}>
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
      <div style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700 }}>6 · Canva & Instagram</div><div style={{ ...sub, flex: 1 }}>Fine-tune in Canva if you want, then schedule.</div>
    </div>
    {err && <div style={{ background: C.redBg, color: C.red, borderRadius: 8, padding: "7px 10px", fontSize: 12.5, marginBottom: 8 }}>{err}</div>}

    <span style={lab}>Canva</span>
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
      {needCanva && <button onClick={() => window.open("/api/canva-auth?action=start", "canva-auth", "width=520,height=720")} style={btn(C.ink, "#fff")}>Connect Canva</button>}
      {post.canva?.edit_url && <a href={post.canva.edit_url} target="_blank" rel="noreferrer" style={{ ...btn(ACCENT, "#fff"), textDecoration: "none" }}>Open in Canva ↗</a>}
      <button disabled={!!busy} onClick={toCanva} style={btn()}>{busy === "canva" ? "Sending to Canva…" : post.canva ? "Send a fresh copy" : "Edit in Canva"}</button>
      {post.canva && <button disabled={!!busy} onClick={fromCanva} style={btn(C.ink, "#fff")}>{busy === "back" ? "Bringing it back…" : "Bring back from Canva"}</button>}
    </div>
    <div style={{ ...sub, marginBottom: 10 }}>{post.canva ? `In Canva since ${new Date(post.canva.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}. Each line of text, photo and the stamp are separate elements; fonts are Canva's own copies, so check spacing once.` : "Sends this post to your Canva as an editable design."}</div>
    {fixedFinal(post) && <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
      <img src={post.final.url} alt="" style={{ width: 64, borderRadius: 4, border: `1px solid ${C.border}` }} />
      <div style={{ fontSize: 12.5, flex: 1 }}>The {finalName(post).toLowerCase()} will be posted.{stale && <div style={{ color: C.amber }}>You've changed the post here since; bring it back again or use the ERP version.</div>}</div>
      <button onClick={() => onSave({ ...post, final: null })} style={btn()}>Use the ERP version</button>
    </div>}

    <span style={lab}>Instagram · @atyahara</span>
    {ig && !ig.ok && <div style={{ fontSize: 12.5, background: C.amberBg, borderRadius: 8, padding: "7px 10px", marginBottom: 8 }}>The ERP can't post to @atyahara yet: {ig.reason || "no access"}. In Meta Business Settings → Users → System users → “Earth Editions Studio System User” → Assign assets → Instagram accounts → @atyahara, give full control, then reload this page.</div>}
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      <input type="date" value={post.date} disabled={post.status === "scheduled"} onChange={e => e.target.value && onSave({ ...post, date: e.target.value })} style={FI({ width: "auto", fontSize: 12.5 })} />
      <input type="time" value={post.time || "19:30"} disabled={post.status === "scheduled"} onChange={e => onSave({ ...post, time: e.target.value })} style={FI({ width: "auto", fontSize: 12.5 })} />
      <span style={sub}>IST</span>
      {post.status === "approved" && <>
        <button disabled={!!busy} onClick={schedule} style={btn(C.green, "#fff")}>{busy === "schedule" ? "Scheduling…" : "Schedule"}</button>
        <button disabled={!!busy} onClick={postNow} style={btn()}>{busy === "now" ? "Posting…" : "Post now"}</button>
      </>}
      {post.status === "scheduled" && <button disabled={!!busy} onClick={unschedule} style={btn()}>{busy === "unschedule" ? "…" : "Unschedule"}</button>}
      {post.status === "draft" && <span style={sub}>Approve the post first.</span>}
      {post.status === "published" && post.url && <a href={post.url} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, color: ACCENT }}>View on Instagram ↗</a>}
    </div>
    {post.status === "scheduled" && <div style={{ ...sub, marginTop: 6 }}>Goes out {new Date(post.scheduled_at).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })} IST, within the hour (the autopilot runs hourly).</div>}
    {post.post_error && <div style={{ fontSize: 12.5, color: C.red, marginTop: 6 }}>Last attempt failed: {post.post_error}</div>}
  </div>;
}

function Compare({ post, no }) {
  const a = post.first || {}, b = post.cur || {};
  const score = changeScore(a, b);
  const rows = [...TEXT, "points", "format", "tile", "image"].filter(f => JSON.stringify(a[f] ?? "") !== JSON.stringify(b[f] ?? ""));
  const show = v => Array.isArray(v) ? v.map(x => [x.k, x.v].filter(Boolean).join(": ")).join(" · ") : String(v ?? "");
  return <div style={card}>
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
      <div style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700 }}>Soniya's first draft vs now</div>
      {score != null && <Tag c={score <= 15 ? C.green : score <= 40 ? C.amber : C.red} bg={score <= 15 ? C.greenBg : score <= 40 ? C.amberBg : C.redBg}>{score}% changed</Tag>}
      <span style={sub}>{post.versions?.length || 0} versions</span>
    </div>
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 12 }}>
      <div><span style={lab}>First</span><Preview data={a} width={mob() ? 150 : 220} no={no} /></div>
      <div><span style={lab}>Now</span><Preview data={b} width={mob() ? 150 : 220} no={no} /></div>
    </div>
    {rows.length ? rows.map(f => <div key={f} style={{ borderTop: `1px solid ${C.border}`, padding: "7px 0", fontSize: 12.5, lineHeight: 1.5 }}>
      <span style={lab}>{f}</span>
      <div style={{ color: C.red, textDecoration: "line-through", whiteSpace: "pre-wrap" }}>{f.startsWith("image") ? (a[f] ? "photo" : "none") : show(a[f]) || "—"}</div>
      <div style={{ color: C.green, whiteSpace: "pre-wrap" }}>{f.startsWith("image") ? (b[f] ? "new photo" : "none") : show(b[f]) || "—"}</div>
    </div>) : <div style={sub}>Nothing changed: you approved her first draft as it was.</div>}
    {post.learned?.length > 0 && <div style={{ marginTop: 10, background: "#F6EEE4", borderRadius: 8, padding: "8px 12px" }}>
      <span style={lab}>What Soniya learned</span>{post.learned.map((l, i) => <div key={i} style={{ fontSize: 12.5, lineHeight: 1.5 }}>• {l}</div>)}</div>}
  </div>;
}

function PostStudio({ post, no, onSave, onBack, ctx, library }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [view, setView] = useState("work");
  const [ver, setVer] = useState(null);
  const [showFinal, setShowFinal] = useState(post.final?.source === "file");
  const cur = post.cur;
  const version = (p, by, stage, note) => [...(p.versions || []), { n: (p.versions?.length || 0) + 1, at: new Date().toISOString(), by, stage, note: note || "", snap: p.cur }].slice(-40);
  const save = async (p) => { try { await onSave(p); } catch (e) { setErr(e.message); } };
  const patch = (fields, stage, note) => {
    const next = { ...post, status: post.status === "idea" ? "draft" : post.status, cur: { ...post.cur, ...fields } };
    next.versions = version(next, "sir", stage, note);
    return save(next);
  };
  const draft = async () => {
    setBusy("draft"); setErr("");
    try {
      const d = await ask(ctx.system, `Write the first full draft of this post.\n${postBrief(post)}\nFormat to use: ${post.idea?.format || "your choice"}.\nReturn ${FIELDS_JSON}`);
      const c = { ...d, format: FORMATS[d.format] ? d.format : (post.idea?.format || "archive"), tile: post.idea?.tile || "ivory", image: post.cur?.image || "" };
      const next = { ...post, status: "draft", cur: c, first: c, drafted_at: new Date().toISOString() };
      next.versions = version(next, "soniya", "draft", "First draft");
      await save(next);
    } catch (e) { setErr(e.message); }
    setBusy("");
  };
  const options = async (stage, note) => {
    setBusy(stage); setErr("");
    try {
      const st = STAGES.find(s => s[0] === stage);
      let list;
      if (stage === "visual" && !note) {
        // Layout and colour options don't need a model: three layouts that fit, in tiles not used by the neighbours.
        const near = new Set(ctx.neighbourTiles(post));
        const free = Object.keys(TILES).filter(t => !near.has(t) && t !== cur.tile);
        const fam = Object.keys(FORMATS).filter(f => SERIES[f] === SERIES[cur.format]);
        const alts = [cur.format, ...fam.filter(f => f !== cur.format), ...Object.keys(FORMATS).filter(f => !fam.includes(f))];
        list = [0, 1, 2].map(i => ({ label: `${FORMATS[alts[i % alts.length]][0]} · ${free[i] || cur.tile}`, why: i === 0 ? "Same layout, a different tile." : "A different layout for the same story.", patch: { format: alts[i % alts.length], tile: free[i] || cur.tile } }));
      } else {
        const out = await ask(ctx.system, `Post so far:\n${postBrief(post)}\n\nGive Sir THREE genuinely different options for stage "${st[1]}" (${st[2]}). Only these fields may change: ${st[3].filter(f => !f.startsWith("image")).join(", ")}${stage === "direction" ? " (you may also change any other text field so the post still holds together)" : ""}.${note ? `\nSir's note: “${note}”. All three options must answer it.` : ""}\nReturn {"options":[{"label":"2–5 words","why":"one line: why this is better","patch":{…only the changed fields…}}]}`, 2400);
        list = (out.options || []).slice(0, 3);
      }
      await save({ ...post, options: { stage, note, list, at: new Date().toISOString() } });
    } catch (e) { setErr(e.message); }
    setBusy("");
  };
  const choose = (stage, o) => {
    const p = { ...o.patch }; if (p.format && !FORMATS[p.format]) delete p.format; if (p.tile && !TILES[p.tile]) delete p.tile;
    const next = { ...post, options: null, cur: { ...post.cur, ...p } };
    next.versions = version(next, "soniya", stage, `Sir chose “${o.label}”${post.options?.note ? ` for “${post.options.note}”` : ""}`);
    return save(next);
  };
  const approve = async () => {
    setBusy("approve"); setErr("");
    try {
      const change = changeScore(post.first, post.cur);
      let learned = [];
      if (post.first && change > 0) {
        const out = await ask(ctx.system, `Your first draft:\n${JSON.stringify({ ...post.first, image: undefined, image2: undefined, image3: undefined })}\n\nWhat Sir approved:\n${JSON.stringify({ ...post.cur, image: undefined, image2: undefined, image3: undefined })}\n\nSir's notes along the way: ${(post.versions || []).filter(v => v.note).map(v => `“${v.note}”`).join("; ") || "none"}\n\nWhat did you learn about how Sir wants Atyahara to sound and look? Give 1–4 short, general lessons you can apply to every future post (not about this subject). Skip anything already in your lessons list. Return {"lessons":["…"]}`, 700);
        learned = (out.lessons || []).filter(Boolean).slice(0, 4);
        for (const l of learned) await put(NOTES, { id: uid(), kind: "lesson", title: l.length > 70 ? l.slice(0, 67) + "…" : l, body: `${l}\n(From the ${post.cur?.format} post “${post.cur?.headline || post.idea?.subject}”, ${post.date}; ${change}% changed from her first draft.)`, source: "planner", post_id: post.id, at: new Date().toISOString(), status: "open" });
      }
      await save({ ...post, status: "approved", approved_at: new Date().toISOString(), change, learned, options: null });
      if (learned.length) ctx.onLearned(learned);
      setView("compare");
    } catch (e) { setErr(e.message); }
    setBusy("");
  };
  const restore = v => { const next = { ...post, cur: v.snap }; next.versions = version(next, "sir", "restore", `Went back to version ${v.n}`); setVer(null); return save(next); };

  const [sl, sc, sbg] = STATUS[post.status] || STATUS.idea;
  const pw = mob() ? Math.min(window.innerWidth - 56, 340) : 360;
  return <div>
    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
      <button onClick={onBack} style={btn()}>← Planner</button>
      <div style={{ flex: 1, minWidth: 160 }}>
        <div style={{ fontFamily: SERIF, fontSize: 21, fontWeight: 700, lineHeight: 1.1 }}>{cur?.headline || post.idea?.subject || "Post"}</div>
        <div style={sub}>{fmtDay(post.date)} · {post.idea?.subject}</div>
      </div>
      <Tag c={sc} bg={sbg}>{sl}</Tag>
      {cur && <button onClick={() => setView(view === "compare" ? "work" : "compare")} style={btn()}>{view === "compare" ? "Back to work" : "First vs now"}</button>}
      {cur && post.status === "draft" && <button disabled={!!busy} onClick={approve} style={btn(C.green, "#fff")}>{busy === "approve" ? "Approving…" : "Approve"}</button>}
      {post.status === "approved" && <>
        <button onClick={() => save({ ...post, status: "draft" })} style={btn()}>Reopen</button>
        <button onClick={() => save({ ...post, status: "published", published_at: new Date().toISOString() })} style={btn(C.ink, "#fff")}>Mark as posted</button>
      </>}
    </div>
    {err && <div style={{ ...card, background: C.redBg, color: C.red, marginBottom: 10, fontSize: 13 }}>{err}</div>}
    {post.idea?.why && <div style={{ ...card, marginBottom: 12, fontSize: 13, lineHeight: 1.5 }}><span style={lab}>Soniya's plan for this slot</span>{post.idea.angle && <div><b>{post.idea.angle}</b></div>}<div style={{ color: C.inkMid }}>{post.idea.why}</div></div>}
    {!cur ? <div style={{ ...card, textAlign: "center", padding: 30 }}>
      <div style={{ fontSize: 13.5, color: C.inkMid, marginBottom: 12 }}>Soniya hasn't drafted this post yet.</div>
      <button disabled={!!busy} onClick={draft} style={btn(ACCENT, "#fff")}>{busy === "draft" ? "Soniya is drafting…" : "Draft it"}</button>
    </div> : view === "compare" ? <Compare post={post} no={no} /> :
    <div style={{ display: "grid", gridTemplateColumns: mob() ? "minmax(0,1fr)" : `${pw}px minmax(0,1fr)`, gap: 16, alignItems: "start" }}>
      <div style={{ position: mob() ? "static" : "sticky", top: 120 }}>
        {fixedFinal(post) && !ver && <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>{[["live", "Live render"], ["canva", finalName(post)]].map(([k, l]) => <button key={k} onClick={() => setShowFinal(k === "canva")} style={(k === "canva") === showFinal ? btn(C.ink, "#fff") : btn()}>{l}</button>)}</div>}
        {showFinal && fixedFinal(post) && !ver ? <img src={post.final.url} alt="" style={{ width: pw, display: "block", borderRadius: 4 }} /> : <Preview data={ver ? ver.snap : cur} width={pw} no={no} />}
        {ver && <div style={{ display: "flex", gap: 6, marginTop: 8 }}><span style={{ ...sub, flex: 1 }}>Viewing version {ver.n}</span><button onClick={() => restore(ver)} style={btn(C.ink, "#fff")}>Go back to this</button><button onClick={() => setVer(null)} style={btn()}>Close</button></div>}
        <div style={{ ...card, marginTop: 10, padding: "10px 12px" }}>
          <span style={lab}>Versions</span>
          <div style={{ maxHeight: 220, overflowY: "auto" }}>{[...(post.versions || [])].reverse().map(v => <div key={v.n} onClick={() => setVer(v)} style={{ display: "flex", gap: 8, padding: "5px 0", borderTop: `1px solid ${C.border}`, cursor: "pointer", fontSize: 12, background: ver?.n === v.n ? C.card : "none" }}>
            <b style={{ width: 22 }}>{v.n}</b><span style={{ color: v.by === "sir" ? C.blue : ACCENT, width: 50 }}>{v.by === "sir" ? "You" : "Soniya"}</span><span style={{ flex: 1, color: C.inkMid }}>{v.note || v.stage}</span>
          </div>)}</div>
        </div>
      </div>
      <div>{STAGES.map(st => <Stage key={st[0]} st={st} post={post} no={no} busy={busy} library={library} onPatch={patch} onOptions={options} onChoose={choose} />)}
        <Publish post={post} no={no} onSave={save} ig={ctx.ig} /></div>
    </div>}
  </div>;
}

/* ── the planner page ────────────────────────────────────────────────── */
const CADENCE = { "3": [1, 3, 5], "4": [0, 1, 3, 5], "5": [1, 2, 3, 4, 5], "7": [0, 1, 2, 3, 4, 5, 6] };
export default function SoniyaPlanner({ brief, brand, notes, onNotesChanged }) {
  const [posts, setPosts] = useState(null);
  const [err, setErr] = useState("");
  const [month, setMonth] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; });
  const [view, setView] = useState(() => { try { return localStorage.getItem("soniya-plan-view") || "calendar"; } catch { return "calendar"; } });
  const [openId, setOpenId] = useState(null);
  const [planning, setPlanning] = useState(false);
  const [focus, setFocus] = useState("");
  const [cad, setCad] = useState("3");
  const [showPlan, setShowPlan] = useState(false);

  const [ig, setIg] = useState(null);
  const load = async () => {
    let ps;
    try { ps = await rowsOf(KEY); setPosts(ps); } catch (e) { setErr(e.message); return; }
    // What the autopilot did with scheduled posts.
    try {
      const { queue = [] } = await api("/api/social?action=auto_get");
      for (const p of ps.filter(p => p.status === "scheduled" && p.queue_id)) {
        const q = queue.find(x => x.id === p.queue_id);
        if (q?.status === "done") await save({ ...p, status: "published", url: q.url || "", published_at: q.done_at || new Date().toISOString() });
        else if (q?.status === "failed") await save({ ...p, status: "approved", queue_id: null, post_error: q.error || "failed" });
        else if (!q) await save({ ...p, status: "approved", queue_id: null, post_error: "It was no longer in the queue." });
      }
    } catch { /* the planner still works without the queue */ }
  };
  useEffect(() => { load(); api("/api/social?action=ig_check&account=atyahara").then(setIg).catch(e => setIg({ ok: false, reason: e.message })); }, []);
  const setV = v => { setView(v); try { localStorage.setItem("soniya-plan-view", v); } catch {} };

  const lessons = useMemo(() => (notes || []).filter(n => n.kind === "lesson").slice(-40).map(n => (n.body || n.title || "").split("\n")[0]), [notes]);
  const system = useMemo(() => rules(brief || "", lessons) + (brand?.sections?.length ? `\n\nBRAND BOOK (for voice; the visual system above wins on colour and type):\n${brand.sections.map(s => `## ${s.title}\n${s.body_md}`).join("\n\n").slice(0, 6000)}` : ""), [brief, brand, lessons]);
  const all = posts || [];
  const nos = useMemo(() => stampNos(all), [posts]);
  const live = all.filter(p => p.status !== "skipped");
  const sorted = [...live].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const neighbourTiles = p => { const i = sorted.findIndex(x => x.id === p.id); return sorted.slice(Math.max(0, i - 3), i + 4).filter(x => x.id !== p.id).map(x => x.cur?.tile || x.idea?.tile).filter(Boolean); };
  const library = useMemo(() => [...new Set([...LIBRARY, ...all.flatMap(p => [p.cur?.image, p.cur?.image2, p.cur?.image3]).filter(Boolean)])], [posts]);

  const save = async p => { await put(KEY, p); setPosts(ps => ps.some(x => x.id === p.id) ? ps.map(x => x.id === p.id ? p : x) : [...ps, p]); };

  // the learning curve: how much Sir changes, month by month
  const curve = useMemo(() => {
    const m = {};
    for (const p of all) if (p.change != null && p.approved_at) (m[p.approved_at.slice(0, 7)] ||= []).push(p.change);
    return Object.entries(m).sort().slice(-4).map(([k, v]) => [k, Math.round(v.reduce((s, x) => s + x, 0) / v.length), v.length]);
  }, [posts]);

  const [y, mo] = month.split("-").map(Number);
  const first = new Date(y, mo - 1, 1), days = new Date(y, mo, 0).getDate();
  const inMonth = live.filter(p => p.date?.startsWith(month)).sort((a, b) => a.date.localeCompare(b.date));
  const shift = n => { const d = new Date(y, mo - 1 + n, 1); setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); };
  const today = ymd(new Date());

  const pickTile = (prev) => { const recent = prev.slice(-4); return Object.keys(TILES).find(t => !recent.includes(t)) || "ivory"; };

  const planMonth = async () => {
    setPlanning(true); setErr("");
    try {
      const want = []; for (let d = 1; d <= days; d++) { const dt = new Date(y, mo - 1, d); const s = ymd(dt); if (s >= today && CADENCE[cad].includes(dt.getDay()) && !live.some(p => p.date === s)) want.push(s); }
      if (!want.length) throw new Error("Every posting day this month already has a post.");
      const recent = sorted.slice(-24).map(p => `${p.date} · ${p.cur?.format || p.idea?.format} · ${p.idea?.subject || p.cur?.headline}`).join("\n");
      const out = await ask(system, `Plan Atyahara's Instagram for these dates: ${want.join(", ")}.\n${focus ? `Sir's focus this month: “${focus}”.\n` : ""}Already planned or posted (don't repeat a subject; keep the series in rotation so no format appears twice in a row):\n${recent || "nothing yet"}\nMix: museum and archive objects that tell India's history in stone; Atyahara's own pieces (in the hand, specimens); words; crafts. Mark Indian festivals and seasons where they fall naturally, never forced.\nReturn {"posts":[{"date":"YYYY-MM-DD","subject":"what the post is about","format":"${Object.keys(FORMATS).join("|")}","angle":"the story in one line","why":"why this, why this day"}]}`, 3000);
      const prevTiles = sorted.map(p => p.cur?.tile || p.idea?.tile);
      for (const x of (out.posts || []).filter(x => want.includes(x.date))) {
        const tile = pickTile(prevTiles); prevTiles.push(tile);
        await save({ id: uid(), date: x.date, time: "19:30", status: "idea", idea: { subject: x.subject, format: FORMATS[x.format] ? x.format : "archive", angle: x.angle, why: x.why, tile, focus }, versions: [], created_at: new Date().toISOString() });
      }
      setShowPlan(false);
    } catch (e) { setErr(e.message); }
    setPlanning(false);
  };
  const seedStudy = async () => {
    setPlanning(true);
    try {
      const start = new Date(); start.setDate(start.getDate() + ((8 - start.getDay()) % 7 || 7)); // next Monday
      const dates = []; for (let d = new Date(start); dates.length < 9; d = new Date(d.getTime() + DAY)) if (CADENCE["3"].includes(d.getDay())) dates.push(ymd(d));
      for (let i = 0; i < 9; i++) {
        const { subject, ...c } = NINE_STUDY[i];
        const p = { id: uid(), date: dates[i], time: "19:30", status: "draft", idea: { subject, format: c.format, angle: c.direction, why: "From the nine-post study (Nov 2026).", tile: c.tile }, cur: c, first: c, versions: [{ n: 1, at: new Date().toISOString(), by: "soniya", stage: "draft", note: "The nine-post study", snap: c }], created_at: new Date().toISOString() };
        await save(p);
      }
    } catch (e) { setErr(e.message); }
    setPlanning(false);
  };
  const addOn = async date => { await save({ id: uid(), date, time: "19:30", status: "idea", idea: { subject: "New post", format: "archive", tile: pickTile(sorted.map(p => p.cur?.tile || p.idea?.tile)) }, versions: [], created_at: new Date().toISOString() }); };
  const move = async (p, date) => { if (date) await save({ ...p, date }); };

  if (!posts) return <div style={{ color: C.inkFaint, padding: 30 }}>{err || "Loading…"}</div>;
  const open = all.find(p => p.id === openId);
  if (open) return <PostStudio key={open.id} post={open} no={nos[open.id]} onSave={save} onBack={() => setOpenId(null)} library={library}
    ctx={{ system, neighbourTiles, ig, onLearned: () => onNotesChanged?.() }} />;

  const chip = p => { const c = p.cur || {}; const t = c.tile || p.idea?.tile || "ivory"; const [sl, sc] = STATUS[p.status] || STATUS.idea;
    return <div key={p.id} onClick={() => setOpenId(p.id)} title={p.idea?.angle || ""} style={{ cursor: "pointer", background: TILES[t], color: DARK.has(t) ? "#F7F0E6" : "#3A2A23", borderRadius: 6, padding: "5px 7px", marginTop: 4, fontSize: 11.5, lineHeight: 1.25 }}>
      <div style={{ fontFamily: "'Tiro Devanagari Hindi',serif", fontSize: 13 }}>{c.dev || ""}</div>
      <div style={{ fontWeight: 650, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{c.headline || p.idea?.subject}</div>
      <div style={{ fontSize: 9.5, opacity: .8, marginTop: 2, textTransform: "uppercase", letterSpacing: .4 }}>{FORMATS[c.format || p.idea?.format]?.[0] || ""} · <span style={{ color: DARK.has(t) ? "#fff" : sc }}>{sl}</span></div>
    </div>; };

  return <div>
    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
      <button onClick={() => shift(-1)} style={btn()}>‹</button>
      <div style={{ fontFamily: SERIF, fontSize: 22, fontWeight: 700, minWidth: 150, textAlign: "center" }}>{first.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</div>
      <button onClick={() => shift(1)} style={btn()}>›</button>
      <div style={{ display: "flex", gap: 4, marginLeft: 8 }}>{[["calendar", "Calendar"], ["grid", "Grid"]].map(([k, l]) => <button key={k} onClick={() => setV(k)} style={view === k ? btn(C.ink, "#fff") : btn()}>{l}</button>)}</div>
      <div style={{ flex: 1 }} />
      <button onClick={() => setShowPlan(!showPlan)} style={btn(ACCENT, "#fff")}>Plan this month</button>
    </div>

    {showPlan && <div style={{ ...card, marginBottom: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <input value={focus} onChange={e => setFocus(e.target.value)} placeholder="Focus for the month (optional): e.g. “wedding season, gifting, the new amethyst pieces”" style={FI({ flex: 1, minWidth: 240, width: "auto", fontSize: 13 })} />
      <select value={cad} onChange={e => setCad(e.target.value)} style={FI({ width: "auto", fontSize: 13 })}>
        <option value="3">3 a week (Mon, Wed, Fri)</option><option value="4">4 a week (+ Sun)</option><option value="5">Weekdays</option><option value="7">Every day</option></select>
      <button disabled={planning} onClick={planMonth} style={btn(C.ink, "#fff")}>{planning ? "Soniya is planning…" : "Plan the empty days"}</button>
      <div style={{ ...sub, width: "100%" }}>Soniya fills only the empty posting days from today on; posts you already have stay as they are.</div>
    </div>}

    {err && <div style={{ ...card, background: C.redBg, color: C.red, marginBottom: 10, fontSize: 13 }}>{err}</div>}

    <div style={{ ...card, marginBottom: 12, display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", padding: "10px 14px" }}>
      <div style={{ fontSize: 12.5 }}><b>How much you change her drafts</b><div style={sub}>The aim: low enough that you just approve.</div></div>
      {curve.length ? curve.map(([m, v, n]) => <div key={m} style={{ textAlign: "center" }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: v <= 15 ? C.green : v <= 40 ? C.amber : C.red }}>{v}%</div>
        <div style={sub}>{new Date(`${m}-01T12:00:00`).toLocaleDateString("en-GB", { month: "short" })} · {n} post{n === 1 ? "" : "s"}</div></div>)
        : <div style={sub}>No approved posts yet. The score starts with your first approval.</div>}
      <div style={{ ...sub, marginLeft: "auto", textAlign: "right" }}>{lessons.length} lesson{lessons.length === 1 ? "" : "s"} learned
        <div style={{ color: ig?.ok ? C.green : C.amber }}>{!ig ? "Checking @atyahara…" : ig.ok ? "Posting to @atyahara: ready" : "Posting to @atyahara: not set up yet"}</div></div>
    </div>

    {!all.length && <div style={{ ...card, marginBottom: 12, textAlign: "center", padding: 24 }}>
      <div style={{ fontSize: 13.5, color: C.inkMid, marginBottom: 10 }}>Nothing planned yet. Start from the nine-post study (earth palette) or let Soniya plan the month.</div>
      <button disabled={planning} onClick={seedStudy} style={btn(C.ink, "#fff")}>{planning ? "Adding…" : "Start with the nine-post study"}</button>
    </div>}

    {view === "calendar" ? (mob()
      ? <div style={{ display: "grid", gap: 8 }}>{inMonth.map(p => <div key={p.id} style={{ display: "grid", gridTemplateColumns: "70px minmax(0,1fr)", gap: 8, alignItems: "start" }}><b style={{ fontSize: 12.5, paddingTop: 8 }}>{fmtDay(p.date)}</b>{chip(p)}</div>)}
          {!inMonth.length && <div style={{ ...card, ...sub }}>Nothing this month.</div>}</div>
      : <div style={{ display: "grid", gridTemplateColumns: "repeat(7,minmax(0,1fr))", gap: 6 }}>
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(d => <div key={d} style={{ ...lab, textAlign: "center" }}>{d}</div>)}
        {Array.from({ length: (first.getDay() + 6) % 7 }).map((_, i) => <div key={"b" + i} />)}
        {Array.from({ length: days }).map((_, i) => { const s = `${month}-${String(i + 1).padStart(2, "0")}`; const items = inMonth.filter(p => p.date === s);
          return <div key={s} onDragOver={e => e.preventDefault()} onDrop={e => { const p = all.find(x => x.id === e.dataTransfer.getData("id")); if (p) move(p, s); }}
            style={{ minHeight: 96, background: s === today ? "#F6EEE4" : C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: 5, opacity: s < today ? .65 : 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.inkFaint }}><b>{i + 1}</b>{!items.length && s >= today && <span onClick={() => addOn(s)} style={{ cursor: "pointer" }} title="Add a post">＋</span>}</div>
            {items.map(p => <div key={p.id} draggable onDragStart={e => e.dataTransfer.setData("id", p.id)}>{chip(p)}</div>)}
          </div>; })}
      </div>)
    : <div>
      <div style={{ ...sub, marginBottom: 8 }}>How the profile will look, newest first, as on Instagram (this month and everything before it).</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 3, maxWidth: 560 }}>
        {[...sorted].filter(p => p.date <= `${month}-31`).reverse().slice(0, 24).map(p => <GridCell key={p.id} p={p} no={nos[p.id]} onOpen={() => setOpenId(p.id)} />)}
      </div>
    </div>}
  </div>;
}

function GridCell({ p, no, onOpen }) {
  const [sl, sc, sbg] = STATUS[p.status] || STATUS.idea;
  return <div onClick={onOpen} style={{ cursor: "pointer", position: "relative" }}>
    {p.final?.source === "file" && p.final.url ? <img src={p.final.url} alt="" style={{ width: "100%", aspectRatio: "4 / 5", objectFit: "cover", display: "block" }} />
      : p.cur ? <AutoPreview data={p.cur} no={no} style={{ borderRadius: 0 }} />
      : <div style={{ width: "100%", aspectRatio: "4 / 5", background: TILES[p.idea?.tile] || C.card, display: "flex", alignItems: "center", justifyContent: "center", padding: 10, textAlign: "center", fontSize: 12, color: DARK.has(p.idea?.tile) ? "#F7F0E6" : "#3A2A23" }}>{p.idea?.subject}<br />(not drafted)</div>}
    <div style={{ position: "absolute", left: 4, bottom: 4 }}><Tag c={sc} bg={sbg}>{fmtDay(p.date)} · {sl}</Tag></div>
  </div>;
}
