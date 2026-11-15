/* Social → Platforms → Reddit: the r/Crystals Sunday shop post.

   r/Crystals allows shop posts on Sundays only (US Central time), with the
   "Advertisement/Shop Post (SUNDAY ONLY)" flair, links allowed, and a limit
   of three ads per user. Reddit bans automated posting, so nothing is posted
   from here: Manav picks the pieces and their photos, the post is written
   around them (title + body with prices, links and shipping), he downloads
   the photos, copies the text and posts it himself on Reddit — then saves it
   here so the past posts stay in one place (app data key below). */
import { useState, useEffect, useMemo } from "react";
import { C, FI, mob } from "./lmTheme.js";
import { loadK, upsertItemK, deleteItemK, uid } from "./utils.js";
import { fetchWithRetry } from "./aiClient.js";
import { loadStoreFacts } from "./StoreApp.jsx";

const KEY = "ee-reddit-sunday-v1";
const SITE = "https://eartheditions.co";
const SUB = "Crystals";
const FLAIR = "Advertisement/Shop Post (SUNDAY ONLY)";
const MAX_PIECES = 10;
const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 16px" };
const btn = (bg = C.surface, fg = C.ink) => ({ background: bg, color: fg, border: bg === C.surface ? `1px solid ${C.border}` : "none", borderRadius: 8, padding: "7px 13px", fontSize: 13, fontWeight: 650, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" });
const lab = { fontSize: 10, fontWeight: 800, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .7, marginBottom: 5, display: "block" };
const money = v => +v > 0 ? `$${(+v).toFixed(+v % 1 ? 2 : 0)}` : "";
const dateLine = iso => new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });

// Today in r/Crystals' clock (US Central).
const central = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "long", hour: "numeric", hour12: false }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return { sunday: parts.weekday === "Sunday", weekday: parts.weekday, hour: +parts.hour % 24 };
};

const VOICE = `You write Earth Editions' Sunday shop post for r/${SUB} on Reddit.
Earth Editions (${SITE}) is a small shop of natural mineral specimens, crystals and gemstone pieces.
Sound like a mineral enthusiast who happens to run a shop — never a shop pretending to be an enthusiast:
- knowledgeable about minerals, never pretentious; enthusiastic about beautiful natural specimens
- friendly and approachable, a little eccentric in its humour but not whimsical or cutesy
- transparent about origins, natural variation and any treatment; never invent a fact you weren't given
- no healing, metaphysical or spiritual claims of our own (the sub is mixed: respect both, claim neither)
- no hype words ("stunning", "must-have", "elevate", "don't miss"), no hashtags, at most one or two emojis in the whole post
- it should read like a person talking to fellow collectors, not an advertisement
Reddit markdown. Links are always embedded in descriptive words — [See the piece](url) — never a bare URL.`;

async function ask(prompt) {
  const res = await fetchWithRetry("/api/claude", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ writer: "journal", max_tokens: 2200, temperature: 0.75, messages: [{ role: "system", content: VOICE }, { role: "user", content: prompt }] }) }, { tries: 2, timeoutMs: 120000 });
  const d = await res.json();
  if (d.error) throw new Error(d.error?.message || d.error);
  const t = (d.content || []).map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("The AI's reply couldn't be read — try again");
  return JSON.parse(m[0]);
}

const linkFor = (l, fact) => {
  const s = l.platforms?.store;
  const u = s?.storefront_url || s?.url || (fact?.handle ? `${SITE}/products/${fact.handle}` : "");
  return u ? `${u}${u.includes("?") ? "&" : "?"}utm_source=reddit&utm_medium=social&utm_campaign=crystals_sunday` : "";
};

/* Photos as files. Straight from the image host when it allows it, else
   through our API (Etsy's host sends no CORS headers). */
async function getFile(url, name) {
  let b;
  try { const r = await fetch(url); if (!r.ok) throw new Error(); b = await r.blob(); }
  catch {
    const r = await fetch(`/api/social?action=image&url=${encodeURIComponent(url)}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Couldn't get a photo (${r.status})`);
    b = await r.blob();
  }
  const ext = (b.type.split("/")[1] || "jpg").replace("jpeg", "jpg").replace(/\+.*/, "");
  return new File([b], `${name}.${ext}`, { type: b.type || "image/jpeg" });
}
const saveToDisk = f => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(f); a.download = f.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
};
const canShare = fs => { try { return !!navigator.canShare?.({ files: fs }); } catch { return false; } };

/* All the post's photos in one go. On a phone: the share sheet → "Save N
   Images" puts them in Photos, in order. On a computer: downloads. Getting the
   files and opening the share sheet are two taps — the sheet must open
   straight from a tap. */
function PhotoSaver({ photos, showToast }) {
  const sig = photos.map(p => p.u).join("|");
  const [files, setFiles] = useState(null);   // null | "loading" | File[]
  const [got, setGot] = useState(0);
  useEffect(() => { setFiles(null); setGot(0); }, [sig]);
  const name = (p, n) => `${String(n + 1).padStart(2, "0")}-${p.name}`;
  const prepare = async () => {
    setFiles("loading"); setGot(0);
    try {
      const out = await Promise.all(photos.map((p, n) => getFile(p.u, name(p, n)).then(f => { setGot(g => g + 1); return f; })));
      setFiles(out);
    } catch (e) { setFiles(null); showToast(`⚠ ${e.message}`); }
  };
  const save = async () => {
    if (canShare(files)) {
      try { await navigator.share({ files }); } catch (e) { if (e.name !== "AbortError") showToast(`⚠ ${e.message}`); }
      return;
    }
    for (const f of files) { saveToDisk(f); await new Promise(r => setTimeout(r, 300)); }
  };
  const one = async (p, n) => {
    try {
      const f = Array.isArray(files) ? files[n] : await getFile(p.u, name(p, n));
      if (canShare([f])) await navigator.share({ files: [f] }).catch(() => {}); else saveToDisk(f);
    } catch (e) { showToast(`⚠ ${e.message}`); }
  };
  const ready = Array.isArray(files);
  return (<>
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
      {photos.map((p, n) => (
        <button key={p.u + n} onClick={() => one(p, n)} title="Save this photo" style={{ position: "relative", border: "none", padding: 0, background: "none", cursor: "pointer" }}>
          <img src={p.u} alt="" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, display: "block" }} />
          <span style={{ position: "absolute", bottom: 3, left: 3, background: "rgba(0,0,0,.6)", color: "#fff", fontSize: 10, borderRadius: 5, padding: "0 5px" }}>{n + 1}</span>
        </button>))}
    </div>
    {!ready
      ? <button disabled={!photos.length || files === "loading"} onClick={prepare} style={btn(C.ink, "#FAF0DC")}>{files === "loading" ? `Getting photos… ${got}/${photos.length}` : `📲 Get all ${photos.length} photos`}</button>
      : <button onClick={save} style={btn(C.green, "#fff")}>{canShare(files) ? `✓ Save ${files.length} photos to Photos` : `⬇ Download all ${files.length}`}</button>}
    {ready && canShare(files) && <div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 5 }}>In the share sheet, tap “Save {files.length} Images”. They're numbered in posting order.</div>}
  </>);
}
/* The post on the clipboard twice over: hyperlinks (HTML) for Reddit's rich
   text editor, markdown (plain text) for its markdown editor and the app. */
const esc = t => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const toHtml = md => md.trim().split(/\n{2,}/).map(par => `<p>${par.split("\n").map(line =>
  esc(line).replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, t, u) => `<a href="${u.replace(/"/g, "&quot;")}">${t}</a>`)).join("<br>")}</p>`).join("");
async function copyPost(md) {
  try {
    if (window.ClipboardItem && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([toHtml(md)], { type: "text/html" }), "text/plain": new Blob([md], { type: "text/plain" }) })]);
      return;
    }
  } catch { /* fall back to plain text */ }
  await navigator.clipboard.writeText(md);
}
const slug = s => String(s || "photo").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "photo";

export default function SocialReddit({ showToast }) {
  const [past, setPast] = useState(null);
  const [view, setView] = useState("new");   // new | past
  const [open, setOpen] = useState(null);    // a past post shown in full
  useEffect(() => { loadK(KEY).then(v => setPast(Array.isArray(v) ? v : [])).catch(() => setPast([])); }, []);
  const [reuse, setReuse] = useState(null);
  const now = central();
  const lastAt = (past || []).filter(x => x.posted_at).map(x => x.posted_at).sort().pop();
  const postedToday = lastAt && Date.now() - Date.parse(lastAt) < 36e5 * 30 && now.sunday;

  const save = async post => { const next = await upsertItemK(KEY, post); setPast(Array.isArray(next) ? next : [post, ...(past || [])]); };
  const remove = async id => {
    if (!confirm("Remove this post from the history here? (It stays on Reddit.)")) return;
    const next = await deleteItemK(KEY, id).catch(e => { showToast(`⚠ ${e.message}`); return null; });
    if (next) { setPast(Array.isArray(next) ? next : (past || []).filter(x => x.id !== id)); setOpen(null); }
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...card, display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <span style={{ fontSize: 26 }}>👽</span>
        <div style={{ flex: 1, minWidth: 220 }}>
          <b style={{ fontSize: 16 }}>Reddit · r/{SUB} Sunday shop post</b>
          <div style={{ fontSize: 12.5, color: C.inkMid, marginTop: 3, lineHeight: 1.5 }}>
            Shop posts are allowed on <b>Sundays only</b> (US Central time), with the flair <b>{FLAIR}</b>. Links are fine. Max three ads per user — breaking the rules can get the account banned. Reddit bans automated posting, so you post it yourself: download the photos, copy the title and post.
          </div>
          <div style={{ fontSize: 12.5, marginTop: 6, color: now.sunday ? C.green : C.amber, fontWeight: 650 }}>
            {now.sunday ? (postedToday ? "It's Sunday in Central time — and you've already posted today." : "✓ It's Sunday in Central time — good to post.") : `It's ${now.weekday} in Central time — write it now, post it on Sunday.`}
          </div>
        </div>
        <a href={`https://www.reddit.com/r/${SUB}/`} target="_blank" rel="noreferrer" style={{ ...btn(), textDecoration: "none" }}>r/{SUB} ↗</a>
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        {[["new", "✍️ New Sunday post"], ["past", `🗂 Past posts${past ? ` · ${past.length}` : ""}`]].map(([k, l]) => (
          <button key={k} onClick={() => setView(k)} style={{ ...btn(view === k ? C.ink : C.surface, view === k ? "#FAF0DC" : C.ink), borderRadius: 999 }}>{l}</button>))}
      </div>

      {view === "new"
        ? <Composer key={reuse?.id || "new"} from={reuse} showToast={showToast} onSaved={async p => { await save(p); setReuse(null); setView("past"); showToast("✓ Saved to past posts"); }} />
        : <Past past={past} onOpen={setOpen} />}

      {open && <PastPopup post={open} onClose={() => setOpen(null)} showToast={showToast} onDelete={() => remove(open.id)}
        onReuse={() => { setReuse({ ...open, id: uid() }); setOpen(null); setView("new"); }}
        onSaveUrl={async url => { const p = { ...open, url }; await save(p); setOpen(p); showToast("✓ Saved"); }} />}
    </div>
  );
}

/* ── writing a new post ─────────────────────────────────────────────────── */
function Composer({ from, showToast, onSaved }) {
  const [listings, setListings] = useState(null);
  const [facts, setFacts] = useState({});
  const [q, setQ] = useState("");
  const [more, setMore] = useState(12);
  const [items, setItems] = useState(() => from?.items || []);   // [{ id, title, images:[all], chosen:[urls], price, link, note }]
  const [shipping, setShipping] = useState(from?.shipping ?? "Free shipping");
  const [intro, setIntro] = useState(from?.intro || "");
  const [title, setTitle] = useState(from?.title || "");
  const [body, setBody] = useState(from?.body || "");
  const [busy, setBusy] = useState("");
  const [url, setUrl] = useState("");
  useEffect(() => {
    loadK("ng-listings-v1").then(ls => setListings((Array.isArray(ls) ? ls : []).filter(l => (l.images || []).some(u => typeof u === "string")))).catch(() => setListings([]));
    loadStoreFacts().then(setFacts).catch(() => {});
  }, []);
  const byId = useMemo(() => Object.fromEntries((listings || []).map(l => [l.id, l])), [listings]);
  const shown = useMemo(() => {
    const w = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (listings || []).filter(l => w.every(x => `${l.title} ${l.material} ${l.sku}`.toLowerCase().includes(x))).slice(0, more);
  }, [listings, q, more]);
  const total = useMemo(() => { const w = q.toLowerCase().split(/\s+/).filter(Boolean); return (listings || []).filter(l => w.every(x => `${l.title} ${l.material} ${l.sku}`.toLowerCase().includes(x))).length; }, [listings, q]);
  const picked = new Set(items.map(i => i.id));

  const toggle = l => {
    if (picked.has(l.id)) return setItems(a => a.filter(i => i.id !== l.id));
    if (items.length >= MAX_PIECES) return showToast(`Up to ${MAX_PIECES} pieces in one post`);
    const f = facts[l.id];
    const imgs = (l.images || []).filter(u => typeof u === "string");
    setItems(a => [...a, { id: l.id, title: f?.title || l.title, images: imgs, chosen: imgs.slice(0, 2), price: f?.price ?? l.price_store ?? "", link: linkFor(l, f), note: "" }]);
  };
  const upd = (id, patch) => setItems(a => a.map(i => i.id === id ? { ...i, ...patch } : i));
  const move = (id, d) => setItems(a => { const i = a.findIndex(x => x.id === id), j = i + d; if (j < 0 || j >= a.length) return a; const b = [...a]; [b[i], b[j]] = [b[j], b[i]]; return b; });
  const photos = items.flatMap(i => i.chosen.map(u => ({ u, name: slug(i.title) })));

  const write = async () => {
    setBusy("write");
    try {
      const pieces = items.map((i, n) => {
        const l = byId[i.id] || {};
        return [`Piece ${n + 1}: ${i.title}`, l.material && `Stone/mineral: ${l.material}`, l.shape && `Shape: ${l.shape}`, l.origin && `Origin: ${l.origin}`,
          l.size && `Size: ${l.size}`, l.weight && `Weight: ${l.weight}`, i.price && `Price: ${money(i.price)}`, i.link ? `Link: ${i.link}` : "Link: (none — say to message us)",
          `Photos in the post: ${i.chosen.length}`, i.note && `Manav's note on it: ${i.note}`,
          l.description && `Listing description: ${String(l.description).slice(0, 700)}`].filter(Boolean).join("\n");
      }).join("\n\n");
      const out = await ask(`Write this Sunday's r/${SUB} shop post (flair: ${FLAIR}) for these pieces. The photos go in the post in the order listed.

${pieces}

Shipping: ${shipping || "not stated"}
${intro ? `What Manav wants said up top (keep his meaning, his facts): ${intro}` : ""}

The exact format (follow it strictly):
- One short, conversational opening paragraph (2-3 sentences): a small mineral shop, Earth Editions, and what's on the table this Sunday${/free/i.test(shipping) ? `, and "${shipping}"` : shipping ? `, and the shipping (${shipping})` : ""}. No sales pitch.
- Then the pieces as a numbered list written 1) 2) 3) …, in the order given, one item per line (no blank lines inside an item).
- Each item is ONE compact paragraph: Name (size) — $price: one or two short sentences of key details (formation, colour, inclusions, locality, natural marks or treatment if given), ending with the link embedded in descriptive words, e.g. [See the piece](url). Leave out the size brackets if no size is given; if a piece has no link, end with "message me for this one".
- No separate lines for descriptions or links. No bare URLs anywhere. No bold, no headings.
- At most ONE casual closing line after the list (e.g. inviting questions, with [the rest of the shop](${SITE}) embedded). Nothing else.

Example item:
1) Malachite Chrysocolla Slice (80 mm) — $51: Beautiful green malachite banding with blue chrysocolla edges, and a naturally hollow center. [See the piece](https://eartheditions.co/products/example).

The title: under 120 characters, friendly and specific (name a piece or two), not clickbait, no ALL CAPS, no emojis. It may start with "[Shop]" or not — whatever reads naturally.${/free/i.test(shipping) ? ` It must end with "· ${shipping}" (exactly that wording). ` : ""}

Return ONLY JSON: {"title":"…","body":"… the full post in Reddit markdown …"}`);
      setTitle(out.title || ""); setBody(out.body || "");
    } catch (e) { showToast(`⚠ ${e.message}`); }
    setBusy("");
  };
  const copy = (t, what) => navigator.clipboard.writeText(t).then(() => showToast(`✓ ${what} copied`)).catch(() => showToast("⚠ Couldn't copy"));
  const finish = async posted => {
    setBusy("save");
    try {
      await onSaved({ id: from?.id || uid(), sub: SUB, title, body, shipping, intro, created_at: new Date().toISOString(), posted_at: posted ? new Date().toISOString() : "", url: url.trim(),
        items: items.map(i => ({ ...i, thumb: i.chosen[0] || i.images[0] || "" })) });
    } catch (e) { showToast(`⚠ ${e.message}`); }
    setBusy("");
  };

  return (<>
    <div style={card}>
      <span style={lab}>1 · Pick the pieces · {items.length} chosen</span>
      <input value={q} onChange={e => { setQ(e.target.value); setMore(12); }} placeholder="Search listings — name, stone, SKU…" style={FI({ marginBottom: 10 })} />
      {!listings && <div style={{ color: C.inkFaint, fontSize: 13 }}>Loading…</div>}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${mob() ? 100 : 120}px, 1fr))`, gap: 8 }}>
        {shown.map(l => {
          const on = picked.has(l.id), price = facts[l.id]?.price ?? l.price_store;
          return (
            <button key={l.id} onClick={() => toggle(l)} style={{ position: "relative", border: `1px solid ${on ? C.gold : C.border}`, outline: on ? `2px solid ${C.gold}` : "none", background: C.surface, borderRadius: 10, padding: 0, overflow: "hidden", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
              <img src={l.images.find(u => typeof u === "string")} alt="" style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block" }} />
              {on && <span style={{ position: "absolute", top: 5, right: 5, background: C.gold, color: "#fff", borderRadius: 999, fontSize: 11, fontWeight: 800, padding: "1px 7px" }}>{items.findIndex(i => i.id === l.id) + 1}</span>}
              <div style={{ padding: "5px 7px", fontSize: 11.5, fontWeight: 600, color: C.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.title}</div>
              {+price > 0 && <div style={{ padding: "0 7px 5px", fontSize: 11, color: C.inkFaint }}>{money(price)}</div>}
            </button>);
        })}
      </div>
      {total > shown.length && <button onClick={() => setMore(m => m + 24)} style={{ ...btn(), width: "100%", marginTop: 10 }}>Show more · {total - shown.length} left</button>}
    </div>

    {items.length > 0 && <div style={card}>
      <span style={lab}>2 · Photos, price and link for each — tap a photo to add or leave it out</span>
      {items.map((i, n) => (
        <div key={i.id} style={{ borderTop: n ? `1px solid ${C.border}` : "none", padding: "10px 0" }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
            <b style={{ flex: 1, fontSize: 13.5, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n + 1}. {i.title}</b>
            <button onClick={() => move(i.id, -1)} disabled={!n} style={{ ...btn(), padding: "3px 8px" }} title="Move up">↑</button>
            <button onClick={() => move(i.id, 1)} disabled={n === items.length - 1} style={{ ...btn(), padding: "3px 8px" }} title="Move down">↓</button>
            <button onClick={() => setItems(a => a.filter(x => x.id !== i.id))} style={{ ...btn(), padding: "3px 8px", color: C.red }}>✕</button>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            {i.images.map(u => { const on = i.chosen.includes(u); return (
              <img key={u} src={u} alt="" onClick={() => upd(i.id, { chosen: on ? i.chosen.filter(x => x !== u) : [...i.chosen, u] })}
                style={{ width: 58, height: 58, objectFit: "cover", borderRadius: 8, cursor: "pointer", opacity: on ? 1 : .3, outline: on ? `2px solid ${C.gold}` : "none" }} />); })}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "110px 1fr", gap: 6 }}>
            <input value={i.price} onChange={e => upd(i.id, { price: e.target.value })} placeholder="Price $" inputMode="decimal" style={FI({ padding: "7px 10px" })} />
            <input value={i.link} onChange={e => upd(i.id, { link: e.target.value })} placeholder="Link (not on eartheditions.co yet)" style={FI({ padding: "7px 10px" })} />
          </div>
          <input value={i.note} onChange={e => upd(i.id, { note: e.target.value })} placeholder="Anything to say about it? (optional — e.g. 'heavy for its size', 'my favourite this month')" style={FI({ padding: "7px 10px", marginTop: 6 })} />
        </div>))}
      <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "1fr 2fr", gap: 6, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
        <label><span style={lab}>Shipping</span><input value={shipping} onChange={e => setShipping(e.target.value)} style={FI({ padding: "7px 10px" })} /></label>
        <label><span style={lab}>Anything to say up top (optional)</span><input value={intro} onChange={e => setIntro(e.target.value)} placeholder="e.g. fresh batch from Tucson, a few one-offs…" style={FI({ padding: "7px 10px" })} /></label>
      </div>
    </div>}

    {items.length > 0 && <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <span style={{ ...lab, flex: 1, margin: 0 }}>3 · Title and post</span>
        <button disabled={busy === "write"} onClick={write} style={btn(C.ink, "#FAF0DC")}>{busy === "write" ? "Writing…" : body ? "↻ Write again" : "✨ Write the post"}</button>
      </div>
      {(title || body) ? <>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Title" style={FI({ fontWeight: 650 })} />
          <button onClick={() => copy(title, "Title")} style={btn()}>Copy</button>
        </div>
        <div style={{ fontSize: 11, color: title.length > 300 ? C.red : C.inkFaint, textAlign: "right", margin: "2px 0 6px" }}>{title.length}/300</div>
        <textarea value={body} onChange={e => setBody(e.target.value)} rows={14} style={FI({ fontSize: 13, lineHeight: 1.55, resize: "vertical", fontFamily: "ui-monospace, Menlo, monospace" })} />
        <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
          <button onClick={() => copyPost(body).then(() => showToast("✓ Post copied — links stay links")).catch(() => showToast("⚠ Couldn't copy"))} style={btn(C.ink, "#FAF0DC")}>Copy post</button>
                  </div>
      </> : <div style={{ fontSize: 12.5, color: C.inkFaint }}>Write it once the pieces, photos and prices look right — then edit anything.</div>}
    </div>}

    {items.length > 0 && <div style={card}>
      <span style={lab}>4 · Photos to upload · {photos.length}</span>
      <PhotoSaver photos={photos} showToast={showToast} />
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
        <a href={`https://www.reddit.com/r/${SUB}/submit`} target="_blank" rel="noreferrer" style={{ ...btn(), textDecoration: "none" }}>Open r/{SUB} to post ↗</a>
      </div>
      <div style={{ fontSize: 12, color: C.inkMid, margin: "10px 0 6px", lineHeight: 1.5 }}>On Reddit: choose <b>Images</b>, upload the photos in this order, paste the title, paste the post as the body — the links come through as links — and set the flair <b>{FLAIR}</b>.</div>
      <input value={url} onChange={e => setUrl(e.target.value)} placeholder="Reddit link of the post (optional — paste once it's up)" style={FI({ padding: "7px 10px", marginBottom: 8 })} />
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button disabled={!body || busy === "save"} onClick={() => finish(true)} style={btn(C.ink, "#FAF0DC")}>{busy === "save" ? "Saving…" : "✓ Posted — save it"}</button>
        <button disabled={!body || busy === "save"} onClick={() => finish(false)} style={btn()}>Save as draft</button>
      </div>
    </div>}
  </>);
}

/* ── past posts ─────────────────────────────────────────────────────────── */
function Past({ past, onOpen }) {
  if (!past) return <div style={{ color: C.inkFaint, fontSize: 13 }}>Loading…</div>;
  if (!past.length) return <div style={{ ...card, color: C.inkMid, fontSize: 13 }}>No Sunday posts saved yet — write one in “New Sunday post”.</div>;
  const list = [...past].sort((a, b) => Date.parse(b.posted_at || b.created_at) - Date.parse(a.posted_at || a.created_at));
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {list.map(p => (
        <button key={p.id} onClick={() => onOpen(p)} style={{ ...card, display: "flex", gap: 12, alignItems: "center", textAlign: "left", cursor: "pointer", fontFamily: "inherit", color: C.ink }}>
          <div style={{ display: "flex", gap: 3, flex: "none" }}>
            {(p.items || []).slice(0, mob() ? 2 : 4).map(i => <img key={i.id} src={i.thumb} alt="" style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 6, background: C.card }} />)}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 650, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.title || <i>Untitled</i>}</div>
            <div style={{ fontSize: 11.5, color: C.inkFaint }}>{p.posted_at ? `Posted ${dateLine(p.posted_at)}` : `Draft · ${dateLine(p.created_at)}`} · {(p.items || []).length} piece{(p.items || []).length === 1 ? "" : "s"}{p.url ? " · on Reddit ↗" : ""}</div>
          </div>
        </button>))}
    </div>
  );
}

function PastPopup({ post, onClose, onDelete, onReuse, onSaveUrl, showToast }) {
  const [url, setUrl] = useState(post.url || "");
  useEffect(() => { const esc = e => e.key === "Escape" && onClose(); window.addEventListener("keydown", esc); return () => window.removeEventListener("keydown", esc); }, [onClose]);
  const copy = (t, what) => navigator.clipboard.writeText(t).then(() => showToast(`✓ ${what} copied`));
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 1200, background: "rgba(20,16,10,.55)", display: "flex", alignItems: mob() ? "flex-end" : "center", justifyContent: "center", padding: mob() ? 0 : 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.surface, borderRadius: mob() ? "16px 16px 0 0" : 16, width: "100%", maxWidth: 720, maxHeight: mob() ? "92vh" : "88vh", overflow: "auto", padding: "16px 18px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <div style={{ flex: 1, fontSize: 12.5, color: C.inkMid }}>r/{post.sub || SUB} · {post.posted_at ? `posted ${dateLine(post.posted_at)}` : `draft · ${dateLine(post.created_at)}`}</div>
          <button onClick={onClose} aria-label="Close" style={{ ...btn(), padding: "4px 10px" }}>✕</button>
        </div>
        <b style={{ fontSize: 15.5, display: "block", marginBottom: 8 }}>{post.title}</b>
        <div style={{ marginBottom: 12 }}>
          <PhotoSaver photos={(post.items || []).flatMap(i => (i.chosen || []).map(u => ({ u, name: slug(i.title) })))} showToast={showToast} />
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-wrap", background: C.bg, borderRadius: 10, padding: "10px 12px", maxHeight: 320, overflow: "auto" }}>{post.body}</div>
        <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
          <input value={url} onChange={e => setUrl(e.target.value)} placeholder="Reddit link of the post" style={FI({ padding: "7px 10px" })} />
          <button disabled={url.trim() === (post.url || "")} onClick={() => onSaveUrl(url.trim())} style={btn()}>Save</button>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap", borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
          <button onClick={() => copy(post.title, "Title")} style={btn()}>Copy title</button>
          <button onClick={() => copyPost(post.body).then(() => showToast("✓ Post copied"))} style={btn()}>Copy post</button>
          {post.url && <a href={post.url} target="_blank" rel="noreferrer" style={{ ...btn(), textDecoration: "none" }}>Open on Reddit ↗</a>}
          <button onClick={onReuse} style={btn()}>Use as a starting point</button>
          <span style={{ flex: 1 }} />
          <button onClick={onDelete} style={btn(C.redBg, C.red)}>Remove</button>
        </div>
      </div>
    </div>
  );
}
