/* Social → Calendar: the week's posts, planned, drafted, approved, posted.

   The standing plan (a week at a time, "Plan this week"):
     Mon  r/crystals          a piece worth talking about
     Thu  r/Minerals          a specimen — locality, habit, association
     Sun  r/crystals          the sale post (Sundays allow selling there): this
                              week's newest pieces from eartheditions.co, priced

   Nothing goes out unless it's been read and approved here: "Approve" lets
   the autopilot post it at its time (api/social.js, every hour), "Post
   now" sends it straight away. These are posts by a person who cuts and
   collects stone, in that person's words — so the drafts are written the way
   people actually write on Reddit, and every one is edited before it goes.

   Items live in app_data ng-social-calendar-v1; scheduled posts from Compose
   (ng-social-queue-v1) show on their days too. */
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { C, FI } from "./lmTheme.js";
import { loadK, loadKFresh, saveK } from "./utils.js";
import { fetchWithRetry } from "./aiClient.js";
import { loadStoreFacts } from "./StoreApp.jsx";

const KEY = "ng-social-calendar-v1";
const SITE = "https://eartheditions.co";
const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "12px 14px" };
const btn = (bg = C.surface, fg = C.ink) => ({ background: bg, color: fg, border: bg === C.surface ? `1px solid ${C.border}` : "none", borderRadius: 8, padding: "6px 12px", fontSize: 12.5, fontWeight: 650, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" });
const lab = { fontSize: 10, fontWeight: 800, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .7, margin: "8px 0 4px", display: "block" };
const uid = () => Math.random().toString(36).slice(2, 10);
const DAY = 864e5;

// The weekly plan. dow: 0 Sunday … 6 Saturday. Posting at 14:00 UTC — mid-morning in the US, where most of these readers are.
export const PLAN = [
  { dow: 1, sub: "crystals", type: "show", what: "a piece worth talking about" },
  { dow: 4, sub: "Minerals", type: "show", what: "a mineral specimen", specimen: true },
  { dow: 0, sub: "crystals", type: "sale", what: "this week's newest pieces from the store" },
];
const HOUR_UTC = 14;

const weekStart = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };   // Monday
const dayOf = (ws, dow) => { const x = new Date(ws); x.setDate(x.getDate() + ((dow + 6) % 7)); return x; };
const slot = (ws, dow) => { const d = dayOf(ws, dow); return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), HOUR_UTC)).toISOString(); };
const localInput = iso => { const d = new Date(iso); const p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

/* How a person writes on Reddit. The drafts are a starting point, read and
   edited every time — but they should already sound like someone, not a shop. */
const REDDIT = `You're writing Reddit posts for a guy in India whose family has bought, sorted and wholesaled rough stone for years; he cuts and collects too. He posts as himself, like any regular in the sub.
How people actually write on r/crystals and r/Minerals (read hundreds of posts — sound like them):
- Short and casual. Lowercase-ish energy, contractions, plain words. Real people say "got a few new ones in", "these came out really nice", "the flash on this one is hard to catch on camera", "lmk if you want more pics", "happy sunday all". It's fine to be a bit dry or self-deprecating.
- Talk about the actual stones: what's odd or good about this piece, how it looks in hand vs photo, a detail only someone who handled it would notice. One concrete detail beats three adjectives.
- Never write like a shop or a press release: no "added some new stones to the collection", "a mix of tumbled and carved pieces", "our usual sources", "curated", "high quality", "stunning", "mesmerizing", "beautiful energy", "I'm excited to share", "Hey everyone", "Hope you enjoy", "elevate", "unique piece". No hashtags, no emoji, no exclamation marks.
- Show-and-tell posts: no links, no shop, nothing for sale. r/Minerals: collector talk — locality only if given, habit, luster, associations, how it was cut or prepped. r/crystals: warmer, still grounded.
- Never invent a fact. Use only the size, weight, origin and details given; if origin isn't given, don't name one.
- No health or metaphysical claims.`;

async function ask(prompt, max = 900) {
  const r = await fetchWithRetry("/api/claude", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ max_tokens: max, temperature: 0.85, messages: [{ role: "system", content: REDDIT }, { role: "user", content: prompt }] }) }, { tries: 2, timeoutMs: 90000 });
  const d = await r.json();
  if (d.error) throw new Error(d.error?.message || d.error);
  const t = (d.content || []).map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("The draft couldn't be read — try again");
  return JSON.parse(m[0]);
}
const factsOf = l => [`Piece: ${l.title}`, l.material && `Stone: ${l.material}`, l.shape && `Form: ${l.shape}`, l.origin && `Origin: ${l.origin}`,
  l.size && `Size: ${l.size}`, l.weight && `Weight: ${l.weight}`, l.description && `Notes: ${String(l.description).replace(/\s+/g, " ").slice(0, 900)}`].filter(Boolean).join("\n");

async function draftShow(l, sub) {
  const out = await ask(`Draft an image post for r/${sub}. The photo shows this piece:\n${factsOf(l)}\n\nReturn ONLY JSON: {"title":"plain and specific, under 110 characters, no clickbait","comment":"the first comment under the photo: 2-4 short paragraphs of real detail, ending with one genuine question"}`);
  return { title: out.title || l.title, comment: out.comment || "" };
}
async function draftSale(rows, sub = "crystals") {
  const wts = /forsale/i.test(sub);
  const out = await ask(`Write the title and the few lines around the list for this week's ${wts ? "sale post on r/" + sub : "Sunday sale post on r/crystals (selling is allowed there on Sundays)"}. It's a photo post: the photos are the actual pieces. The list of pieces with prices goes in between — don't repeat it.
The pieces:\n${rows.map(r => `- ${r.name}${r.size ? ` (${r.size})` : ""}${r.notes ? ` — ${r.notes}` : ""}`).join("\n")}
How real Sunday sale posts there read: titles like "Sunday sale — couple of atlantisite skulls and some ruby fuchsite, ships from India" or "few new carvings up for grabs this week"; the text is short and practical, a line or two about the pieces in his own words, then how to buy.
Return ONLY JSON: {"title":"${wts ? "starts with [WTS], " : ""}casual, names 2-3 of the actual stones, mentions shipping from India, under 120 characters","intro":"1-2 short casual sentences about these particular pieces, something real about them (from the details given), not about 'the collection'","outro":"one short line: comment or DM with questions, happy to send more pics or a video"}`, 500);
  return out;
}

const specimenRe = /specimen|cluster|mineral|rough|matrix|geode|point|crystal|druz|raw/i;
const polishedRe = /sphere|heart|palm|tower|bracelet|pendant|carving|egg|skull|pyramid|wand|bowl|tumble|cabochon|lingam/i;
const isSpecimen = l => specimenRe.test(`${l.shape} ${l.title}`) && !polishedRe.test(`${l.shape} ${l.title}`);
const live = l => Object.values(l.platforms || {}).some(p => p?.status === "active");

/* Plain text: Reddit's post box shows markdown as typed, so no ** or [](). */
function saleBody(rows, d) {
  const lines = rows.map((r, i) => `${i + 1}. ${r.name}${r.size ? `, ${r.size}` : ""} — $${Math.round(r.price)}\n${r.url}`);
  return [d.intro || "", "", ...lines.flatMap(l => [l, ""]), "Prices in USD, photos are the actual pieces. Free tracked shipping to the US over $35, duties paid; ships worldwide from India.", "", d.outro || ""].join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
// A piece's photos: our own copies first (they download straight into a post),
// then any the store has that we don't.
const imgsOf = (l, sp) => { const all = [...new Set([...(l?.images || []), ...(sp?.images || [])].filter(u => typeof u === "string" && /^https:/.test(u)))]; return [...all.filter(u => !/etsystatic/.test(u)), ...all.filter(u => /etsystatic/.test(u))]; };
const grams = t => String(t || "").replace(/(\d)\s*(g|kg|mm|cm)\b/gi, "$1 $2");
// One line per piece for the sale post: name, size (weight once, not twice), store price and link.
function saleRows(ids, listings, store) {
  return ids.map(id => listings.find(l => l.id === id)).filter(l => l && store[l.id]?.handle && +store[l.id]?.price > 0).map(l => {
    const size = [...new Set([l.size, l.weight].map(grams).map(x => x.trim()).filter(Boolean))].join(", ");
    return { id: l.id, name: (store[l.id].title || [l.material, l.shape].filter(Boolean).join(" ") || l.title).replace(/^\d+\s*g\s+/i, ""), size, price: +store[l.id].price,
      notes: String(l.description || "").replace(/\s+/g, " ").slice(0, 160), url: `${SITE.replace("https://", "")}/products/${store[l.id].handle}?utm_source=reddit` };
  });
}

export default function SocialCalendar({ st, showToast }) {
  const [items, setItems] = useState(null);
  const [queue, setQueue] = useState([]);
  const [ws, setWs] = useState(() => weekStart(new Date()));
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState("");
  const [flairs, setFlairs] = useState({});

  const load = useCallback(async () => {
    const [c, q] = await Promise.all([loadKFresh(KEY).catch(() => loadK(KEY)), fetch("/api/social?action=auto_get").then(r => r.json()).catch(() => ({}))]);
    setItems(Array.isArray(c) ? c : []); setQueue(q.queue || []);
  }, []);
  useEffect(() => { load(); }, [load]);
  // Typing saves after a pause, not on every key.
  const timer = useRef(null);
  const persist = async (next, now = true) => {
    setItems(next);
    clearTimeout(timer.current);
    if (now) await saveK(KEY, next); else timer.current = setTimeout(() => saveK(KEY, next), 900);
  };
  const edit = (id, patch) => persist(items.map(x => x.id === id ? { ...x, ...patch } : x), false);
  const update = (id, patch) => persist(items.map(x => x.id === id ? { ...x, ...patch } : x));

  const weekEnd = new Date(ws.getTime() + 7 * DAY);
  const inWeek = iso => { const t = Date.parse(iso); return t >= ws.getTime() && t < weekEnd.getTime(); };
  const days = Array.from({ length: 7 }, (_, i) => new Date(ws.getTime() + i * DAY));
  const week = useMemo(() => (items || []).filter(x => inWeek(x.at)), [items, ws]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Plan the week: a draft for each slot that doesn't have one yet, each with
     its own piece — one not posted about in the last two months. */
  const plan = async () => {
    setBusy("plan");
    try {
      const [listings, store] = await Promise.all([loadK("ng-listings-v1").then(l => Array.isArray(l) ? l : []), loadStoreFacts().catch(() => ({}))]);
      const recent = new Set((items || []).filter(x => Date.now() - Date.parse(x.at) < 60 * DAY).flatMap(x => x.listing_ids || []));
      const pool = listings.filter(l => (l.images || []).some(u => typeof u === "string") && (live(l) || store[l.id]?.status === "active") && !recent.has(l.id));
      const used = new Set(), stones = new Set();
      const pickOne = specimen => {
        const c = pool.filter(l => !used.has(l.id) && !stones.has(String(l.material || "").toLowerCase()) && (specimen ? isSpecimen(l) : true));
        const l = (c.length ? c : pool.filter(x => !used.has(x.id)))[Math.floor(Math.random() * Math.min(12, c.length || 1))];
        if (l) { used.add(l.id); stones.add(String(l.material || "").toLowerCase()); }
        return l;
      };
      const made = [];
      for (const s of PLAN) {
        const at = slot(ws, s.dow);
        if ((items || []).some(x => x.plan === `${s.sub}:${at.slice(0, 10)}`)) continue;
        if (s.type === "show") {
          const l = pickOne(s.specimen);
          if (!l) continue;
          const d = await draftShow(l, s.sub);
          made.push({ id: uid(), plan: `${s.sub}:${at.slice(0, 10)}`, at, platform: "reddit", sub: s.sub, type: "show", kind: "image", title: d.title, comment: d.comment, body: "",
            images: imgsOf(l, store[l.id]).slice(0, 3), listing_ids: [l.id], piece: l.title, status: "draft" });
        } else {
          // The newest pieces on the store: the sale post is "new in this week".
          const ids = pool.filter(l => store[l.id]?.status === "active" && +store[l.id]?.price > 0 && !used.has(l.id))
            .sort((a, b) => String(store[b.id]?.created_at || b.created_at || "").localeCompare(String(store[a.id]?.created_at || a.created_at || ""))).slice(0, 6).map(l => l.id);
          const rows = saleRows(ids, listings, store);
          if (!rows.length) continue;
          const d = await draftSale(rows, s.sub);
          made.push({ id: uid(), plan: `${s.sub}:${at.slice(0, 10)}`, at, platform: "reddit", sub: s.sub, type: "sale", kind: "image", title: d.title || "Sunday sale — a few new pieces, ships from India",
            body: saleBody(rows, d), comment: "", images: rows.map(r => imgsOf(listings.find(l => l.id === r.id), store[r.id])[0]).filter(Boolean), listing_ids: rows.map(r => r.id), piece: `${rows.length} pieces`, status: "draft" });
        }
      }
      await persist([...(items || []), ...made]);
      showToast(made.length ? `✓ ${made.length} draft${made.length === 1 ? "" : "s"} for the week — read, edit, approve` : "This week is already planned");
    } catch (e) { showToast(`⚠ ${e.message}`); }
    setBusy("");
  };

  // The pieces and photos to pick from, loaded when a post is opened.
  const [lib, setLib] = useState(null);
  const loadLib = async () => {
    if (lib) return lib;
    const [listings, store] = await Promise.all([loadK("ng-listings-v1").then(l => Array.isArray(l) ? l : []), loadStoreFacts().catch(() => ({}))]);
    const v = { listings, store }; setLib(v); return v;
  };
  useEffect(() => { if (open) loadLib().catch(() => {}); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const redraft = async it => {
    setBusy(it.id);
    try {
      const { listings, store } = await loadLib();
      if (it.type === "sale") {
        const rows = saleRows(it.listing_ids || [], listings, store);
        if (!rows.length) throw new Error("Pick at least one piece that's on the store");
        const d = await draftSale(rows, it.sub);
        const images = it.images?.length ? it.images : rows.map(r => imgsOf(listings.find(l => l.id === r.id), store[r.id])[0]).filter(Boolean);
        await update(it.id, { title: d.title || it.title, body: saleBody(rows, d), piece: `${rows.length} pieces`, kind: "image", images });
      } else {
        const l = listings.find(x => x.id === it.listing_ids?.[0]);
        if (!l) throw new Error("Pick the piece first");
        const d = await draftShow(l, it.sub); await update(it.id, { title: d.title, comment: d.comment, piece: l.title });
      }
    } catch (e) { showToast(`⚠ ${e.message}`); }
    setBusy("");
  };
  const loadFlairs = async sub => {
    if (flairs[sub]) return;
    try { const d = await (await fetch(`/api/social?action=reddit_flairs&sub=${encodeURIComponent(sub)}`)).json(); setFlairs(f => ({ ...f, [sub]: d.flairs || [] })); } catch { setFlairs(f => ({ ...f, [sub]: [] })); }
  };
  const postNow = async it => {
    if (!confirm(`Post this to r/${it.sub} now?`)) return;
    setBusy(it.id);
    try {
      const payload = { ...it, images: it.kind === "image" ? [it.images?.[0]].filter(Boolean) : [] };
      const r = await fetch("/api/social?action=post_item", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ item: payload }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.status);
      await update(it.id, { status: "posted", url: d.url || "", note: d.note || "", posted_at: new Date().toISOString() });
      showToast(`✓ Posted to r/${it.sub}${d.note ? ` — ${d.note}` : ""}`);
    } catch (e) { showToast(`⚠ ${e.message}`); await update(it.id, { status: "failed", error: e.message }); }
    setBusy("");
  };
  /* Posting by hand, until Reddit approves API access: Reddit opens with the
     title filled in, the photo is saved to Downloads to drop into the post, and
     the text (or first comment) is on the clipboard. */
  const byHand = async it => {
    const photos = it.kind === "image" ? it.images || [] : [];
    // A sale post's text goes in the photo post's body; a show post's story is the first comment.
    const text = it.type === "sale" || it.kind === "self" ? it.body : it.comment;
    const stem = (it.piece || it.title || "photo").replace(/[^\w -]+/g, "").slice(0, 40).trim() || "photo";
    for (const [i, photo] of photos.entries()) {
      try {
        const b = await (await fetch(photo)).blob();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(b); a.download = `${stem} ${String(i + 1).padStart(2, "0")}.${(b.type.split("/")[1] || "jpg").replace("jpeg", "jpg")}`;
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        await new Promise(r => setTimeout(r, 350));
      } catch { window.open(photo, "_blank"); }
    }
    const q = new URLSearchParams({ title: it.title || "" });
    if (it.kind === "image") q.set("type", "IMAGE"); else q.set("type", "TEXT");
    window.open(`https://www.reddit.com/r/${it.sub}/submit?${q}`, "_blank");
    try { await navigator.clipboard.writeText(text || ""); } catch { /* not allowed */ }
    await update(it.id, { hand: true });
    showToast(it.kind !== "image" ? "Reddit opened with the title — paste the post text (it's copied)"
      : it.type === "sale" ? `Reddit opened with the title — drop in the ${photos.length} photo${photos.length === 1 ? "" : "s"} from Downloads, then paste the text into the body (it's copied)`
      : `Reddit opened with the title — drop in the photo${photos.length === 1 ? "" : "s"} from Downloads, post, then paste the first comment (it's copied)`);
  };
  const markPosted = async it => {
    const url = prompt("Paste the link to your Reddit post (optional):", "") ?? null;
    if (url === null) return;
    await update(it.id, { status: "posted", url: url.trim(), posted_at: new Date().toISOString(), error: "" });
    showToast("✓ Marked posted");
  };
  const add = async date => {
    const it = { id: uid(), at: new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), HOUR_UTC)).toISOString(), platform: "reddit", sub: "crystals", type: "show", kind: "self", title: "", body: "", comment: "", images: [], listing_ids: [], status: "draft" };
    await persist([...(items || []), it]); setOpen(it.id);
  };

  const pill = s => ({ draft: ["Draft", C.amber, C.amberBg], approved: ["Approved", C.blue, C.blueBg], posted: ["Posted", C.green, C.greenBg], failed: ["Failed", C.red, C.redBg], skipped: ["Skipped", C.inkFaint, C.card] }[s] || [s, C.inkMid, C.card]);
  const connected = !!st?.reddit?.connected;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...card, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={() => setWs(w => new Date(w.getTime() - 7 * DAY))} style={btn()}>‹</button>
        <b style={{ fontSize: 15, minWidth: 170, textAlign: "center" }}>{ws.toLocaleDateString(undefined, { day: "numeric", month: "short" })} – {new Date(weekEnd.getTime() - DAY).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</b>
        <button onClick={() => setWs(w => new Date(w.getTime() + 7 * DAY))} style={btn()}>›</button>
        <button onClick={() => setWs(weekStart(new Date()))} style={btn()}>This week</button>
        <div style={{ flex: 1 }} />
        <button disabled={busy === "plan" || !items} onClick={plan} style={btn(C.ink, "#FAF0DC")}>{busy === "plan" ? "Drafting the week…" : "✨ Plan this week"}</button>
      </div>
      <div style={{ fontSize: 12.5, color: C.inkMid }}>
        Mon r/crystals · Thu r/Minerals — a piece worth talking about, posted as a photo with the story in the first comment. Sun r/crystals — the Sunday sale post: this week's newest pieces from the store, with prices. Every post waits for you: <b>Approve</b> and it goes out at its time, or <b>Post now</b>.
        {!connected && <span style={{ color: C.amber }}> Until Reddit approves API access you post by hand: open a post, <b>Open on Reddit to post</b> (title filled in, photo saved to Downloads, text copied), then <b>✓ I posted it</b>.</span>}
      </div>

      {days.map(d => {
        const key = d.toDateString();
        const its = week.filter(x => new Date(x.at).toDateString() === key).sort((a, b) => a.at.localeCompare(b.at));
        const qs = queue.filter(q => q.status === "pending" && new Date(q.at).toDateString() === key);
        const today = new Date().toDateString() === key;
        return (
          <div key={key} style={{ ...card, borderColor: today ? C.gold : C.border }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: its.length || qs.length ? 6 : 0 }}>
              <b style={{ fontSize: 13.5, flex: 1 }}>{d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" })}{today ? " · today" : ""}</b>
              <button onClick={() => add(d)} style={{ ...btn(), padding: "3px 9px", fontSize: 12 }}>+ Add</button>
            </div>
            {qs.map(q => <div key={q.id} style={{ fontSize: 12.5, color: C.inkMid, padding: "3px 0" }}>🗓 {new Date(q.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {q.platform} · {q.payload?.title} <span style={{ color: C.inkFaint }}>(scheduled from Compose)</span></div>)}
            {its.map(it => {
              const [pl, fg, bg] = pill(it.status);
              const isOpen = open === it.id;
              return (
                <div key={it.id} style={{ borderTop: `1px solid ${C.border}`, padding: "8px 0" }}>
                  <div onClick={() => setOpen(isOpen ? null : it.id)} style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
                    {it.images?.[0] && <img src={it.images[0]} alt="" style={{ width: 38, height: 38, objectFit: "cover", borderRadius: 6 }} />}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 650, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.title || <i style={{ color: C.inkFaint }}>Untitled</i>}</div>
                      <div style={{ fontSize: 11.5, color: C.inkFaint }}>r/{it.sub} · {new Date(it.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{it.piece ? ` · ${it.piece}` : ""}</div>
                    </div>
                    <span style={{ fontSize: 10.5, fontWeight: 800, color: fg, background: bg, borderRadius: 10, padding: "2px 8px" }}>{pl}</span>
                  </div>
                  {it.status === "posted" && it.url && <a href={it.url} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>View on Reddit ↗</a>}
                  {it.status === "failed" && <div style={{ fontSize: 12, color: C.red }}>⚠ {it.error}</div>}
                  {isOpen && (
                    <div style={{ marginTop: 6 }}>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <div style={{ flex: "1 1 160px" }}><span style={lab}>Subreddit</span><input value={it.sub} onChange={e => edit(it.id, { sub: e.target.value.replace(/^r\//i, "") })} style={FI()} /></div>
                        <div style={{ flex: "1 1 180px" }}><span style={lab}>When</span><input type="datetime-local" value={localInput(it.at)} onChange={e => e.target.value && update(it.id, { at: new Date(e.target.value).toISOString() })} style={FI()} /></div>
                        <div style={{ flex: "1 1 140px" }}><span style={lab}>Post as</span>
                          <select value={it.kind} onChange={e => update(it.id, { kind: e.target.value })} style={FI()}><option value="image">{it.type === "sale" ? "Photos + text" : "Photos + first comment"}</option><option value="self">Text only</option></select></div>
                      </div>
                      <span style={lab}>Title</span>
                      <input value={it.title} onChange={e => edit(it.id, { title: e.target.value })} style={FI({ fontWeight: 650 })} />
                      <PiecePicker it={it} lib={lib} update={update} />
                      {it.kind === "image" && it.type === "sale" && <>
                        <span style={lab}>Post text (goes under the photos)</span>
                        <textarea value={it.body} onChange={e => edit(it.id, { body: e.target.value })} rows={14} style={FI({ fontSize: 13, lineHeight: 1.55 })} />
                      </>}
                      {it.kind === "image" && it.type !== "sale" && <>
                        <span style={lab}>First comment</span>
                        <textarea value={it.comment} onChange={e => edit(it.id, { comment: e.target.value })} rows={7} style={FI({ fontSize: 13.5, lineHeight: 1.55 })} />
                      </>}
                      {it.kind === "self" && <>
                        <span style={lab}>Post</span>
                        <textarea value={it.body} onChange={e => edit(it.id, { body: e.target.value })} rows={it.type === "sale" ? 16 : 8} style={FI({ fontSize: 13, lineHeight: 1.55 })} />
                      </>}
                      {it.type === "sale" && <div style={{ fontSize: 12, color: C.amber, marginTop: 4 }}>Sale subs want a timestamp photo (paper with your username and the date next to the pieces) — add that link in the post before approving. Check the sub's rules for format.</div>}
                      <span style={lab}>Flair</span>
                      {flairs[it.sub]
                        ? <select value={it.flair_id || ""} onChange={e => update(it.id, { flair_id: e.target.value, flair_text: flairs[it.sub].find(f => f.id === e.target.value)?.text || "" })} style={FI()}>
                            <option value="">None</option>{flairs[it.sub].map(f => <option key={f.id} value={f.id}>{f.text}</option>)}</select>
                        : <button disabled={!connected} onClick={() => loadFlairs(it.sub)} style={{ ...btn(), padding: "4px 10px", fontSize: 12 }}>Load r/{it.sub}'s flairs</button>}
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                        {connected && it.status !== "posted" && (it.status === "approved"
                          ? <button onClick={() => update(it.id, { status: "draft" })} style={btn()}>Un-approve</button>
                          : <button disabled={!connected || !it.title} onClick={() => update(it.id, { status: "approved", error: "" })} style={btn(C.blue, "#fff")}>✓ Approve for {new Date(it.at).toLocaleDateString(undefined, { weekday: "short" })} {new Date(it.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</button>)}
                        {it.status !== "posted" && (connected
                          ? <button disabled={!it.title || busy === it.id} onClick={() => postNow(it)} style={btn(C.ink, "#FAF0DC")}>{busy === it.id ? "…" : "Post now"}</button>
                          : <button disabled={!it.title} onClick={() => byHand(it)} style={btn(C.ink, "#FAF0DC")}>Open on Reddit to post</button>)}
                        {it.status !== "posted" && !connected && it.hand && it.kind === "image" && <button onClick={() => navigator.clipboard.writeText(it.comment || "").then(() => showToast("First comment copied"))} style={btn()}>Copy first comment</button>}
                        {it.status !== "posted" && !connected && it.hand && <button onClick={() => markPosted(it)} style={btn(C.green, "#fff")}>✓ I posted it</button>}
                        {it.status !== "posted" && <button disabled={busy === it.id} onClick={() => redraft(it)} style={btn()}>{busy === it.id ? "Writing…" : it.type === "sale" ? "↻ Rewrite for these pieces" : "↻ Draft again"}</button>}
                        <button onClick={() => navigator.clipboard.writeText([it.title, it.kind === "image" ? it.comment : it.body].join("\n\n")).then(() => showToast("Copied"))} style={btn()}>Copy</button>
                        {it.status !== "posted" && <button onClick={() => update(it.id, { status: "skipped" })} style={btn()}>Skip</button>}
                        <button onClick={() => { if (confirm("Delete this post from the calendar?")) persist(items.filter(x => x.id !== it.id)); }} style={{ ...btn(), color: C.red }}>Delete</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/* Which pieces go in the post, and which of their photos. Click a photo to put
   it in or take it out; the order you pick is the order on Reddit. */
function PiecePicker({ it, lib, update }) {
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  if (!lib) return <div style={{ fontSize: 12, color: C.inkFaint, marginTop: 8 }}>Loading pieces…</div>;
  const { listings, store } = lib;
  const ids = it.listing_ids || [];
  const chosen = it.images || [];
  const sale = it.type === "sale";
  const toggleImg = u => update(it.id, { images: chosen.includes(u) ? chosen.filter(x => x !== u) : [...chosen, u] });
  const removePiece = id => { const l = listings.find(x => x.id === id); const mine = imgsOf(l, store[id]); update(it.id, { listing_ids: ids.filter(x => x !== id), images: chosen.filter(u => !mine.includes(u)) }); };
  const addPiece = l => {
    const first = imgsOf(l, store[l.id])[0];
    update(it.id, sale
      ? { listing_ids: [...ids, l.id], images: first ? [...chosen, first] : chosen }
      : { listing_ids: [l.id], images: imgsOf(l, store[l.id]).slice(0, 3), piece: l.title });
    setAdding(false); setQ("");
  };
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const pool = listings.filter(l => !ids.includes(l.id) && imgsOf(l, store[l.id]).length && (sale ? store[l.id]?.status === "active" && +store[l.id]?.price > 0 : true))
    .filter(l => words.every(w => `${store[l.id]?.title || ""} ${l.title} ${l.material} ${l.shape}`.toLowerCase().includes(w)))
    .sort((a, b) => String(store[b.id]?.created_at || "").localeCompare(String(store[a.id]?.created_at || ""))).slice(0, 40);
  return (
    <div>
      <span style={lab}>{sale ? `Pieces (${ids.length}) & photos — ${chosen.length} picked` : `Piece & photos — ${chosen.length} picked`}</span>
      {ids.map(id => {
        const l = listings.find(x => x.id === id); const sp = store[id];
        return (
          <div key={id} style={{ border: `1px solid ${C.border}`, borderRadius: 9, padding: 8, marginBottom: 6 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
              <b style={{ fontSize: 12.5, flex: 1 }}>{sp?.title || l?.title || id}{sp?.price ? ` · $${Math.round(sp.price)}` : ""}{sale && sp?.status !== "active" ? " · not on the store" : ""}</b>
              <button onClick={() => removePiece(id)} style={{ ...btn(), padding: "2px 8px", fontSize: 11.5 }}>{sale ? "Remove" : "Change"}</button>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {imgsOf(l, sp).map(u => { const n = chosen.indexOf(u); return (
                <div key={u} onClick={() => toggleImg(u)} style={{ position: "relative", cursor: "pointer" }}>
                  <img src={u} alt="" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 6, outline: n >= 0 ? `2.5px solid ${C.gold}` : "none", opacity: n >= 0 ? 1 : .45 }} />
                  {n >= 0 && <span style={{ position: "absolute", top: 3, left: 3, background: C.ink, color: "#FAF0DC", fontSize: 10, fontWeight: 800, borderRadius: 8, padding: "0 5px" }}>{n + 1}</span>}
                </div>); })}
            </div>
          </div>);
      })}
      {(sale || !ids.length) && (adding
        ? <div style={{ border: `1px solid ${C.border}`, borderRadius: 9, padding: 8 }}>
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={sale ? "Search pieces on the store…" : "Search pieces…"} style={FI({ marginBottom: 6 })} />
            <div style={{ display: "grid", gap: 4, maxHeight: 280, overflowY: "auto" }}>
              {pool.map(l => (
                <div key={l.id} onClick={() => addPiece(l)} style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer", padding: 3, borderRadius: 6 }}>
                  <img src={imgsOf(l, store[l.id])[0]} alt="" style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 5 }} />
                  <span style={{ fontSize: 12.5, flex: 1 }}>{store[l.id]?.title || l.title}</span>
                  {store[l.id]?.price && <span style={{ fontSize: 12, color: C.inkMid }}>${Math.round(store[l.id].price)}</span>}
                </div>))}
              {!pool.length && <div style={{ fontSize: 12, color: C.inkFaint }}>Nothing matches.</div>}
            </div>
            <button onClick={() => setAdding(false)} style={{ ...btn(), marginTop: 6 }}>Done</button>
          </div>
        : <button onClick={() => setAdding(true)} style={btn()}>+ {sale ? "Add a piece" : "Pick the piece"}</button>)}
      {sale && <div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 4 }}>After changing pieces, press ↻ Rewrite for these pieces so the list and prices match.</div>}
    </div>
  );
}
