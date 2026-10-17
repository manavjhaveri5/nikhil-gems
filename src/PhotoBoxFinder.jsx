/* Photo → box. A piece turns up without its box — on the table at a show, in
   a return, on the packing floor — and this finds where it belongs. A photo of
   it goes to the AI with the stone names and shapes already in stock, and
   comes back named in our own words. Every card of that stone is then a
   candidate; the ones most like it (same shape, same region, with a photo) go
   back to the AI beside the piece, and it ranks them by how alike they look —
   colour, pattern, finish, size. Lots of one stone from different buys
   usually differ in just those; trays of one lot, or cards sharing a photo,
   don't, and the AI can't tell those apart any better than an eye can. So
   the order is a guide: a box is called the best match only when it stands
   clearly ahead, and otherwise the screen says they look alike. The person
   picks; nothing is changed.

   Each photo is drawn down in the browser before it goes, so a lookup is two
   small requests: well under a cent. */
import { useEffect, useRef, useState } from "react";
import { C, FI } from "./ui.jsx";
import { mob } from "./utils.js";
import { fetchWithRetry } from "./aiClient.js";

const key = v => String(v || "").trim().toLowerCase().replace(/\s+/g, " ");
// The most box photos set beside the piece in one go.
const MAX_COMPARE = 12;
// How far ahead of the next photo the top one must be to be called the best match.
const CLEAR_LEAD = 20;

const loadImage = blob => new Promise((resolve, reject) => {
  const u = URL.createObjectURL(blob), im = new Image();
  im.onload = () => { URL.revokeObjectURL(u); resolve(im); };
  im.onerror = () => { URL.revokeObjectURL(u); reject(new Error("That file isn't a photo the browser can read")); };
  im.src = u;
});
// A photo (a file, or a stock photo's address) as a JPEG of at most `max` px.
async function shrink(src, max) {
  let blob = src;
  if (typeof src === "string") {
    const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), 12000);
    try {
      const r = await fetch(src, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`photo ${r.status}`);
      blob = await r.blob();
    } finally { clearTimeout(t); }
  }
  const img = await loadImage(blob);
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const cv = document.createElement("canvas");
  cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
  cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
  const url = cv.toDataURL("image/jpeg", 0.82);
  return { url, b64: url.split(",")[1] };
}
const imagePart = p => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: p.b64 } });

// One request to the AI; its reply is read as the JSON it was asked for.
async function ask(content, maxTokens) {
  const res = await fetchWithRetry("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-opus-4-5", max_tokens: maxTokens, messages: [{ role: "user", content }] }),
  }, { tries: 2, timeoutMs: 60000 });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "The AI didn't answer");
  const text = data.content?.find(b => b.type === "text")?.text || "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("The AI's answer couldn't be read");
  return JSON.parse(m[0]);
}

const shapeHit = (s, shape) => {
  const a = key(s.shape).replace(/s$/, ""), b = key(shape).replace(/s$/, "");
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
};
// A name the AI gave, matched to the stock's own however it is cased or punctuated —
// never to a near name: "Alien Amethyst" is not "Amethyst".
const bare = v => key(v).replace(/[^a-z0-9]+/g, "");
const cardsOfStone = (stock, name) => {
  const k = bare(name);
  return k ? stock.filter(s => bare(s.material) === k) : [];
};

export default function PhotoBoxFinder({ file, stock = [], region = "India", coverOf, qtyText, onPick, onClose }) {
  const [photo, setPhoto] = useState(null);       // the piece, drawn down: {url, b64}
  const [phase, setPhase] = useState("start");    // start | identify | compare | done | error
  const [guess, setGuess] = useState(null);       // {stone, shape, alternatives, notes}
  const [stone, setStone] = useState("");         // the stone being looked through
  const [rows, setRows] = useState([]);           // [{s, score, why, compared}]
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [typed, setTyped] = useState("");
  const run = useRef(0);                          // a newer lookup makes an older one's answers stale

  const names = [...new Map(stock.map(s => [key(s.material), String(s.material || "").trim()]).filter(([k]) => k)).values()].sort((a, b) => a.localeCompare(b));
  const shapes = [...new Map(stock.map(s => [key(s.shape), String(s.shape || "").trim()]).filter(([k]) => k)).values()].sort((a, b) => a.localeCompare(b));

  // Step two: the boxes of one stone, the likeliest set beside the piece and ranked.
  const compare = async (pic, name, shape, id) => {
    setStone(name); setRows([]); setNote(""); setErr("");
    const all = cardsOfStone(stock, name).map(s => ({ s, shape: shapeHit(s, shape), here: (s.region || "India") === region, cover: coverOf?.(s) || "" }))
      .sort((a, b) => (b.shape - a.shape) || (b.here - a.here) || (!!b.cover - !!a.cover) || String(a.s.location || "").localeCompare(String(b.s.location || ""), undefined, { numeric: true }));
    if (!all.length) { setPhase("done"); return; }
    if (all.length === 1) { setRows([{ s: all[0].s, score: null, why: "The only card of this stone", compared: false }]); setPhase("done"); return; }
    setPhase("compare");
    // One look per photo: cards that share a photo share its place in the order.
    const photos = [...new Map(all.filter(x => x.cover).map(x => [x.cover, x])).values()].slice(0, MAX_COMPARE);
    const shots = await Promise.allSettled(photos.map(x => shrink(x.cover, 448)));
    const ready = photos.map((x, i) => ({ ...x, pic: shots[i].status === "fulfilled" ? shots[i].value : null })).filter(x => x.pic);
    if (run.current !== id) return;
    const seen = new Set(ready.map(x => x.cover));
    const rest = all.filter(x => !seen.has(x.cover));
    if (ready.length < 2) {
      setRows([...ready, ...rest].map(x => ({ s: x.s, score: null, why: "", compared: false })));
      setNote(ready.length ? "Only one of these boxes has a photo that loads, so they couldn't be compared." : "None of these boxes has a photo that loads, so they couldn't be compared.");
      setPhase("done"); return;
    }
    try {
      const content = [
        { type: "text", text: "The first photo is a piece of stone that has been separated from its box. Each candidate after it is a box (stock card) of the same stone, with that box's photo. Which box did the piece most likely come from? Compare colour, pattern, inclusions, translucency, polish, size and shape — lots of the same stone bought at different times usually differ in these. Many boxes of one lot look alike: when you can't tell candidates apart, give them the same score, and keep high scores for a box whose pieces really match the piece.\nReply with JSON only: {\"ranking\":[{\"n\":<candidate number>,\"score\":<0-100, how likely>,\"why\":\"<a few words>\"}]} — every candidate, best first." },
        { type: "text", text: "The piece:" }, imagePart(pic),
        ...ready.flatMap((x, i) => [
          { type: "text", text: `Candidate ${i + 1} — ${[...new Set(all.filter(y => y.cover === x.cover).map(y => `Box ${y.s.location || "?"}`))].join(", ")}: ${[x.s.material, x.s.shape, x.s.size].filter(Boolean).join(" · ")}` },
          imagePart(x.pic),
        ]),
      ];
      const out = await ask(content, 700);
      if (run.current !== id) return;
      const by = new Map((Array.isArray(out.ranking) ? out.ranking : []).map(r => [Number(r.n), r]));
      const byPhoto = new Map(ready.map((x, i) => [x.cover, { score: Number(by.get(i + 1)?.score) || 0, why: String(by.get(i + 1)?.why || "") }]));
      const ranked = all.filter(x => byPhoto.has(x.cover)).map(x => ({ s: x.s, cover: x.cover, ...byPhoto.get(x.cover), compared: true }))
        .sort((a, b) => b.score - a.score);
      setRows([...ranked, ...rest.map(x => ({ s: x.s, cover: x.cover, score: null, why: "", compared: false }))]);
      const left = rest.length;
      if (left) setNote(`${left} more box${left === 1 ? "" : "es"} of this stone ${left === 1 ? "wasn't" : "weren't"} compared${rest.some(x => !x.cover) ? " (no photo, or one that won't load)" : ""} — listed below.`);
      setPhase("done");
    } catch (e) {
      if (run.current !== id) return;
      setRows(all.map(x => ({ s: x.s, score: null, why: "", compared: false })));
      setErr(`Couldn't compare the photos: ${e.message}`); setPhase("done");
    }
  };

  // Step one: what the piece is, in the stock's own names.
  const start = async f => {
    const id = ++run.current;
    setPhase("identify"); setGuess(null); setRows([]); setStone(""); setNote(""); setErr(""); setTyped("");
    try {
      const pic = await shrink(f, 768);
      if (run.current !== id) return;
      setPhoto(pic);
      const g = await ask([
        { type: "text", text: `This photo shows a piece (or a few pieces) of a stone or mineral from a wholesaler's stock. Name it using our own names.\nStone names in our stock — use one of these exactly if any fits: ${names.join("; ")}\nShapes in our stock: ${shapes.join("; ")}\nReply with JSON only: {"stone":"<name>","alternatives":["<up to 3 other names from the list it could be, likeliest first>"],"shape":"<shape>","notes":"<colour, pattern, size cues in a few words>"}` },
        imagePart(pic),
      ], 300);
      if (run.current !== id) return;
      const gg = { stone: String(g.stone || "").trim(), shape: String(g.shape || "").trim(), alternatives: (Array.isArray(g.alternatives) ? g.alternatives : []).map(x => String(x).trim()).filter(Boolean), notes: String(g.notes || "").trim() };
      setGuess(gg);
      // The first name that has cards in stock is the one looked through.
      const first = [gg.stone, ...gg.alternatives].find(n => cardsOfStone(stock, n).length) || gg.stone;
      await compare(pic, first, gg.shape, id);
    } catch (e) {
      if (run.current !== id) return;
      setErr(e.message); setPhase("error");
    }
  };
  useEffect(() => { if (file) start(file); return () => { run.current++; }; }, [file]); // eslint-disable-line react-hooks/exhaustive-deps

  const lookAt = name => { if (!photo || !name) return; const id = ++run.current; compare(photo, name, guess?.shape || "", id); };
  const busy = phase === "identify" || phase === "compare";
  const others = guess ? [guess.stone, ...guess.alternatives].filter((n, i, a) => n && key(n) !== key(stone) && a.findIndex(x => key(x) === key(n)) === i) : [];
  // The best match is named only when one photo stands clearly ahead of the next.
  const ranked = rows.filter(r => r.compared);
  const topScore = ranked[0]?.score ?? 0;
  const nextScore = ranked.find(r => r.cover !== ranked[0]?.cover)?.score ?? 0;
  const clear = ranked.length > 0 && topScore - nextScore >= CLEAR_LEAD;
  const best = clear ? ranked[0] : null;
  const alike = ranked.filter(r => topScore - r.score < CLEAR_LEAD);
  const band = r => r.score == null ? null : topScore - r.score < 10 ? ["Closest", "#0f7a55", "#D9F0E3"] : topScore - r.score < 30 ? ["Possible", "#9a5a12", "#FBEBD6"] : ["Unlikely", C.inkFaint, C.card];
  const pill = on => ({ background: on ? C.ink : C.surface, color: on ? "#fff" : C.ink, border: `1px solid ${on ? C.ink : C.border}`, borderRadius: 14, padding: "4px 10px", fontSize: 12, fontWeight: 650, cursor: "pointer" });

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,15,5,.5)", zIndex: 950, display: "grid", placeItems: mob ? "end stretch" : "center", padding: mob ? 0 : 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.surface, borderRadius: mob ? "16px 16px 0 0" : 14, width: mob ? "100%" : "min(640px,100%)", maxHeight: mob ? "92vh" : "90vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,.3)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ flex: 1, fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 21, fontWeight: 600 }}>📷 Find the box</div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: C.inkFaint }}>×</button>
        </div>
        <div style={{ display: "flex", gap: 14, padding: "14px 18px", borderBottom: `1px solid ${C.border}`, alignItems: "flex-start" }}>
          <div style={{ width: 96, height: 96, borderRadius: 10, overflow: "hidden", background: C.card, flexShrink: 0, display: "grid", placeItems: "center" }}>
            {photo ? <img src={photo.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ fontSize: 26 }}>📷</span>}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {phase === "identify" && <div style={{ fontSize: 13.5, color: C.inkMid }}>Looking at the photo…</div>}
            {phase === "error" && <div style={{ fontSize: 13, color: C.red }}>⚠ {err}</div>}
            {guess && <>
              <div style={{ fontSize: 13, color: C.inkMid }}>Looks like</div>
              <div style={{ fontSize: 17, fontWeight: 750, color: C.ink }}>{stone || guess.stone}{guess.shape ? <span style={{ fontWeight: 500, color: C.inkMid }}> · {guess.shape}</span> : null}</div>
              {guess.notes && <div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 2 }}>{guess.notes}</div>}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
                {others.length > 0 && <span style={{ fontSize: 11, color: C.inkFaint }}>Not it?</span>}
                {others.map(n => <button key={n} disabled={busy} onClick={() => lookAt(n)} style={pill(false)}>{n}</button>)}
                <input value={typed} onChange={e => setTyped(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && typed.trim()) lookAt(typed.trim()); }} list="pbf-stones" placeholder="Type the stone…" disabled={busy}
                  style={{ ...FI, width: 150, padding: "4px 10px", fontSize: mob ? 16 : 12, borderRadius: 14 }} />
                <datalist id="pbf-stones">{names.map(n => <option key={n} value={n} />)}</datalist>
              </div>
            </>}
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "12px 18px" }}>
          {phase === "compare" && <div style={{ fontSize: 13, color: C.inkMid, padding: "6px 0 10px" }}>Comparing the piece with the {stone} boxes…</div>}
          {phase === "done" && !rows.length && <div style={{ fontSize: 13, color: C.inkMid, padding: "10px 0" }}>No card of {stone || "that stone"} in stock. Pick another name above, or type it.</div>}
          {err && phase === "done" && <div style={{ fontSize: 12, color: C.amber, padding: "0 0 8px" }}>⚠ {err}</div>}
          {phase === "done" && ranked.length > 1 && !clear && <div style={{ fontSize: 12, color: "#9a5a12", background: "#FBF3E4", border: "1px solid #8B6F4744", borderRadius: 9, padding: "8px 11px", marginBottom: 10 }}>
            {new Set(alike.map(r => r.s.location)).size > 1 ? `These ${new Set(alike.map(r => r.s.location)).size} boxes look alike — likely one lot, or the same photo. The order is a guess: check them.` : "No box stands out — check the closest ones."}</div>}
          {rows.map(r => {
            const s = r.s, cov = coverOf?.(s), top = !!best && r.cover === best.cover, b = band(r);
            const twin = r.cover && rows.filter(x => x !== r && x.cover === r.cover && x.s.location !== s.location).map(x => x.s.location);
            return (
              <button key={s.id} onClick={() => onPick?.(s)} style={{ display: "flex", gap: 12, alignItems: "center", width: "100%", textAlign: "left", background: top ? "#EAF6EF" : C.surface, border: `1px solid ${top ? "#3FA36B" : C.border}`, borderRadius: 12, padding: 8, marginBottom: 8, cursor: "pointer", opacity: !r.compared && ranked.length ? .8 : 1 }}>
                <div style={{ width: mob ? 72 : 88, height: mob ? 72 : 88, borderRadius: 8, overflow: "hidden", background: C.card, flexShrink: 0 }}>{cov && <img src={cov} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                    <b style={{ fontSize: 15, color: C.ink }}>Box {s.location || "—"}</b>
                    {top && <span style={{ fontSize: 10.5, fontWeight: 800, color: "#0f7a55", background: "#D9F0E3", borderRadius: 9, padding: "1px 7px" }}>Best match</span>}
                    {(s.region || "India") !== region && <span style={{ fontSize: 10.5, color: C.inkFaint }}>{s.region || "India"}{s.showTag ? ` · ${s.showTag}` : ""}</span>}
                  </div>
                  <div style={{ fontSize: 12, color: C.inkMid, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{[s.material, s.shape, s.size, qtyText?.(s)].filter(Boolean).join(" · ")}</div>
                  {r.why && <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 1 }}>{r.why}</div>}
                  {twin?.length > 0 && <div style={{ fontSize: 10.5, color: "#9a5a12", marginTop: 1 }}>Same photo as Box {[...new Set(twin)].join(", ")}</div>}
                </div>
                {b && <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 800, color: b[1], background: b[2], borderRadius: 10, padding: "2px 9px" }}>{b[0]}</span>}
              </button>);
          })}
          {note && <div style={{ fontSize: 11.5, color: C.inkFaint, padding: "2px 0 8px" }}>{note}</div>}
          {ranked.length > 0 && <div style={{ fontSize: 11, color: C.inkFaint, padding: "4px 0" }}>The order is the AI's read of how alike the photos look — check the box before putting the piece back.</div>}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "12px 18px", borderTop: `1px solid ${C.border}` }}>
          <label style={{ background: C.ink, color: "#FAF0DC", borderRadius: 8, padding: "9px 14px", fontSize: 13, fontWeight: 700, cursor: busy ? "default" : "pointer", opacity: busy ? .5 : 1 }}>
            📷 Another photo
            <input type="file" accept="image/*" disabled={busy} style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; e.target.value = ""; if (f) start(f); }} />
          </label>
          <span style={{ flex: 1, fontSize: 11, color: C.inkFaint }}>{busy ? "Working…" : rows.length ? "Tap a box to open its card." : ""}</span>
          <button onClick={onClose} style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 16px", cursor: "pointer", fontSize: 13 }}>Close</button>
        </div>
      </div>
    </div>
  );
}
