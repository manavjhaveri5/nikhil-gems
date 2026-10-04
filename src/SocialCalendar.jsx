/* Social → Calendar: the week's posts, planned, drafted, approved, posted.

   The standing plan (a week at a time, "Plan this week"):
     Mon  r/crystals          a piece worth talking about
     Wed  r/Minerals          a specimen — locality, habit, association
     Fri  r/mineralcollectors a specimen, for collectors
     Sun  r/Crystalsforsale   ten pieces from eartheditions.co, priced

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
  { dow: 3, sub: "Minerals", type: "show", what: "a mineral specimen", specimen: true },
  { dow: 5, sub: "mineralcollectors", type: "show", what: "a specimen for collectors", specimen: true },
  { dow: 0, sub: "Crystalsforsale", type: "sale", what: "ten pieces from the store" },
];
const HOUR_UTC = 14;

const weekStart = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };   // Monday
const dayOf = (ws, dow) => { const x = new Date(ws); x.setDate(x.getDate() + ((dow + 6) % 7)); return x; };
const slot = (ws, dow) => { const d = dayOf(ws, dow); return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), HOUR_UTC)).toISOString(); };
const localInput = iso => { const d = new Date(iso); const p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

/* How a person writes on Reddit. The drafts are a starting point, read and
   edited every time — but they should already sound like someone, not a shop. */
const REDDIT = `You're helping a man who cuts and collects stone in India (family business, buys rough at the source) write his own Reddit posts. Write exactly the way a knowledgeable, slightly understated hobbyist writes on Reddit — not a brand, not a marketer.
- First person, plain, specific. Mix short and long sentences. Contractions. It's fine to be a little dry.
- No hashtags, no emojis, no exclamation marks, no "check out", "stunning", "mesmerizing", "gorgeous", "beautiful energy", "I'm excited to share", "Hey everyone", "Hope you enjoy".
- No links, no shop name, nothing for sale in show-and-tell posts — subs remove self-promotion.
- Never invent a fact. Only the size, weight, origin and details given; if origin isn't given, don't name one.
- No health or metaphysical claims. In r/Minerals and r/mineralcollectors talk like a collector: locality, habit, associated minerals, luster, how it was found, prepped or cut; in r/crystals a bit warmer, still grounded.
- End the comment with one real question the sub would enjoy answering (an ID detail, a comparison, a cutting choice) — not "what do you think?".`;

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
async function draftSale(rows) {
  const out = await ask(`Draft the opening and closing lines for this week's sale post on r/Crystalsforsale. The list of pieces is added separately — don't repeat it. Pieces: ${rows.map(r => r.name).join("; ")}.
Return ONLY JSON: {"title":"starts with [WTS], under 160 characters, names 2-3 of the stones, says ships worldwide from India","intro":"1-2 plain sentences, no hype","outro":"1-2 lines: comment or DM to claim, happy to send more photos or video"}`, 500);
  return out;
}

const specimenRe = /specimen|cluster|mineral|rough|matrix|geode|point|crystal|druz|raw/i;
const polishedRe = /sphere|heart|palm|tower|bracelet|pendant|carving|egg|skull|pyramid|wand|bowl|tumble|cabochon|lingam/i;
const isSpecimen = l => specimenRe.test(`${l.shape} ${l.title}`) && !polishedRe.test(`${l.shape} ${l.title}`);
const live = l => Object.values(l.platforms || {}).some(p => p?.status === "active");

function saleBody(rows, d) {
  const lines = rows.map((r, i) => `${i + 1}. **${r.name}**${r.size ? ` — ${r.size}` : ""} — **$${Math.round(r.price)}** — [photos](${r.url})`);
  return [d.intro || "", "", ...lines, "", "Prices in USD. Free tracked shipping to the US over $35, duties paid; worldwide shipping from India.", "", d.outro || ""].join("\n").trim();
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
            images: (l.images || []).filter(u => typeof u === "string").slice(0, 6), image: 0, listing_ids: [l.id], piece: l.title, status: "draft" });
        } else {
          const rows = pool.filter(l => store[l.id]?.status === "active" && +store[l.id]?.price > 0 && !used.has(l.id))
            .sort(() => Math.random() - .5).slice(0, 10)
            .map(l => ({ id: l.id, name: [l.material, l.shape].filter(Boolean).join(" ") || l.title, size: [l.size, l.weight].filter(Boolean).join(", "), price: +store[l.id].price, url: `${SITE}/products/${store[l.id].handle}?utm_source=reddit&utm_medium=social` }));
          if (!rows.length) continue;
          const d = await draftSale(rows);
          made.push({ id: uid(), plan: `${s.sub}:${at.slice(0, 10)}`, at, platform: "reddit", sub: s.sub, type: "sale", kind: "self", title: d.title || "[WTS] This week's pieces — ships worldwide from India",
            body: saleBody(rows, d), comment: "", images: [], listing_ids: rows.map(r => r.id), piece: `${rows.length} pieces`, status: "draft" });
        }
      }
      await persist([...(items || []), ...made]);
      showToast(made.length ? `✓ ${made.length} draft${made.length === 1 ? "" : "s"} for the week — read, edit, approve` : "This week is already planned");
    } catch (e) { showToast(`⚠ ${e.message}`); }
    setBusy("");
  };

  const redraft = async it => {
    setBusy(it.id);
    try {
      const listings = await loadK("ng-listings-v1");
      const l = (listings || []).find(x => x.id === it.listing_ids?.[0]);
      if (it.type === "show" && l) { const d = await draftShow(l, it.sub); await update(it.id, { title: d.title, comment: d.comment }); }
      else showToast("Edit the sale post by hand — the list is the pieces and prices");
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
      const payload = { ...it, images: it.kind === "image" ? [it.images[it.image || 0]].filter(Boolean) : [] };
      const r = await fetch("/api/social?action=post_item", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ item: payload }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.status);
      await update(it.id, { status: "posted", url: d.url || "", note: d.note || "", posted_at: new Date().toISOString() });
      showToast(`✓ Posted to r/${it.sub}${d.note ? ` — ${d.note}` : ""}`);
    } catch (e) { showToast(`⚠ ${e.message}`); await update(it.id, { status: "failed", error: e.message }); }
    setBusy("");
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
        Mon r/crystals · Wed r/Minerals · Fri r/mineralcollectors — a piece worth talking about, posted as a photo with the story in the first comment. Sun r/Crystalsforsale — ten pieces from the store with prices. Every post waits for you: <b>Approve</b> and it goes out at its time, or <b>Post now</b>.
        {!connected && <span style={{ color: C.amber }}> Connect Reddit in Accounts to post from here.</span>}
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
                    {it.images?.[it.image || 0] && <img src={it.images[it.image || 0]} alt="" style={{ width: 38, height: 38, objectFit: "cover", borderRadius: 6 }} />}
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
                          <select value={it.kind} onChange={e => update(it.id, { kind: e.target.value })} style={FI()}><option value="image">Photo + first comment</option><option value="self">Text post</option></select></div>
                      </div>
                      <span style={lab}>Title</span>
                      <input value={it.title} onChange={e => edit(it.id, { title: e.target.value })} style={FI({ fontWeight: 650 })} />
                      {it.kind === "image" && <>
                        <span style={lab}>Photo</span>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{(it.images || []).map((u, i) => <img key={u} src={u} alt="" onClick={() => update(it.id, { image: i })} style={{ width: 54, height: 54, objectFit: "cover", borderRadius: 6, cursor: "pointer", outline: (it.image || 0) === i ? `2.5px solid ${C.gold}` : "none", opacity: (it.image || 0) === i ? 1 : .6 }} />)}</div>
                        <span style={lab}>First comment</span>
                        <textarea value={it.comment} onChange={e => edit(it.id, { comment: e.target.value })} rows={7} style={FI({ fontSize: 13.5, lineHeight: 1.55 })} />
                      </>}
                      {it.kind === "self" && <>
                        <span style={lab}>Post</span>
                        <textarea value={it.body} onChange={e => edit(it.id, { body: e.target.value })} rows={it.type === "sale" ? 16 : 8} style={FI({ fontSize: 13, lineHeight: 1.55, fontFamily: it.type === "sale" ? "ui-monospace,monospace" : "inherit" })} />
                      </>}
                      {it.type === "sale" && <div style={{ fontSize: 12, color: C.amber, marginTop: 4 }}>Sale subs want a timestamp photo (paper with your username and the date next to the pieces) — add that link in the post before approving. Check the sub's rules for format.</div>}
                      <span style={lab}>Flair</span>
                      {flairs[it.sub]
                        ? <select value={it.flair_id || ""} onChange={e => update(it.id, { flair_id: e.target.value, flair_text: flairs[it.sub].find(f => f.id === e.target.value)?.text || "" })} style={FI()}>
                            <option value="">None</option>{flairs[it.sub].map(f => <option key={f.id} value={f.id}>{f.text}</option>)}</select>
                        : <button disabled={!connected} onClick={() => loadFlairs(it.sub)} style={{ ...btn(), padding: "4px 10px", fontSize: 12 }}>Load r/{it.sub}'s flairs</button>}
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                        {it.status !== "posted" && (it.status === "approved"
                          ? <button onClick={() => update(it.id, { status: "draft" })} style={btn()}>Un-approve</button>
                          : <button disabled={!connected || !it.title} onClick={() => update(it.id, { status: "approved", error: "" })} style={btn(C.blue, "#fff")}>✓ Approve for {new Date(it.at).toLocaleDateString(undefined, { weekday: "short" })} {new Date(it.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</button>)}
                        {it.status !== "posted" && <button disabled={!connected || !it.title || busy === it.id} onClick={() => postNow(it)} style={btn(C.ink, "#FAF0DC")}>{busy === it.id ? "…" : "Post now"}</button>}
                        {it.type === "show" && it.status !== "posted" && <button disabled={busy === it.id} onClick={() => redraft(it)} style={btn()}>↻ Draft again</button>}
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
