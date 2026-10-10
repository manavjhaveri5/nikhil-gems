/* Social: every platform from one place.

   Compose — a piece from Listing Manager (its photos, video and store link),
     captions for each platform written in one go, then published to every
     platform ticked. A platform that isn't connected still gets its caption,
     ready to copy.
   Cross-post — the Instagram account's recent posts and Reels, each sent on
     to TikTok, YouTube Shorts, Threads, X or Pinterest.
   Journal — an article for the eartheditions.co journal, written and
     published (committed to the store's repo, live after its deploy).
   Community — Reddit threads this week about stones we stock, with a reply
     drafted to post by hand, and drafts for Reddit and Mindat. Never posted
     from here: both ban automated posting.
   Accounts — connecting each platform, with its setup steps.
   Log — what went where.

   The server side is api/social.js. */
import { useState, useEffect, useCallback, useMemo, lazy, Suspense } from "react";
import { C, FI, mob } from "./lmTheme.js";
import { loadK } from "./utils.js";
import { fetchWithRetry } from "./aiClient.js";
import { VOICE, Replies } from "./StoreSocial.jsx";
import { INSTAGRAM_VOICE, instagramShape, HASHTAG_ENDING } from "../lib/instagramVoice.js";
const SocialStories = lazy(() => import("./SocialStories.jsx"));
const Captions = lazy(() => import("./StoreSocial.jsx"));
const SocialCalendar = lazy(() => import("./SocialCalendar.jsx"));

const SITE = "https://eartheditions.co";
const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 16px" };
const btn = (bg = C.surface, fg = C.ink) => ({ background: bg, color: fg, border: bg === C.surface ? `1px solid ${C.border}` : "none", borderRadius: 8, padding: "7px 13px", fontSize: 13, fontWeight: 650, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" });
const lab = { fontSize: 10, fontWeight: 800, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .7, marginBottom: 5, display: "block" };
const ago = t => { const m = (Date.now() - Date.parse(t)) / 6e4; return m < 60 ? `${Math.max(1, Math.round(m))}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };

export const PLATFORMS = [
  { k: "instagram", label: "Instagram", icon: "📸", media: "photo or video", limit: 2200 },
  { k: "tiktok", label: "TikTok", icon: "🎵", media: "video", limit: 2200 },
  { k: "youtube", label: "YouTube Shorts", icon: "▶️", media: "video", limit: 4900 },
  { k: "pinterest", label: "Pinterest", icon: "📌", media: "photo", limit: 500 },
  { k: "threads", label: "Threads", icon: "🧵", media: "any", limit: 500 },
  { k: "x", label: "X", icon: "𝕏", media: "photos or text", limit: 280 },
];
const SETUP = {
  instagram: ["developers.facebook.com → Create app → Business → add Instagram → \"API setup with Instagram login\". Your Instagram must be a Business or Creator account; add it as a tester.", "IG_APP_ID", "IG_APP_SECRET"],
  threads: ["developers.facebook.com → Create app → use case \"Access the Threads API\". Add your Threads account as a tester.", "THREADS_APP_ID", "THREADS_APP_SECRET"],
  tiktok: ["developers.tiktok.com → Manage apps → Connect an app → add Login Kit and Content Posting API (Direct Post on). Add your account as a target user.", "TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
  youtube: ["console.cloud.google.com → new project → enable \"YouTube Data API v3\" → OAuth consent screen (External, add yourself as test user) → Credentials → OAuth client ID (Web).", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  pinterest: ["developers.pinterest.com → My apps → Connect app. New apps get Trial access; ask for Standard access so pins go live.", "PINTEREST_APP_ID", "PINTEREST_APP_SECRET"],
  x: ["developer.x.com → Free plan → your app → User authentication settings: OAuth 2.0, Web App, read and write.", "X_CLIENT_ID", "X_CLIENT_SECRET"],
};
const LIMITS = {
  instagram: "", threads: "",
  tiktok: "Until TikTok reviews the app, \"Post now\" posts privately — drafts work fully (you post from the TikTok app).",
  youtube: "Until Google verifies the app, uploads stay private — publish them from YouTube Studio.",
  pinterest: "Trial access posts only to a test board; Standard access (a short form) puts pins live.",
  x: "Free plan: about 500 posts a month.",
};

const api = async (action, { p, body } = {}) => {
  const r = await fetch(`/api/social?action=${action}${p ? `&p=${p}` : ""}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, p }) } : {});
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Failed (${r.status})`);
  return d;
};
async function ask(prompt, maxTokens = 1800, system = VOICE, writer) {
  const res = await fetchWithRetry("/api/claude", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ writer, max_tokens: maxTokens, temperature: 0.7, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }) }, { tries: 2, timeoutMs: 90000 });
  const d = await res.json();
  if (d.error) throw new Error(d.error?.message || d.error);
  return (d.content || []).map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
}
const parseJson = t => { const m = String(t).match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; };

/* ── Compose ───────────────────────────────────────────────────────────── */
const storeLink = l => {
  const s = l.platforms?.store;
  const u = s?.storefront_url || s?.url || "";
  return u ? `${u}${u.includes("?") ? "&" : "?"}utm_source=social&utm_medium=social` : "";
};
function Compose({ st, showToast }) {
  const [listings, setListings] = useState(null);
  const [q, setQ] = useState("");
  const [pick, setPick] = useState(null);
  const [imgs, setImgs] = useState([]);
  const [useVideo, setUseVideo] = useState(true);
  const [txt, setTxt] = useState({});
  const [on, setOn] = useState({});
  const [busy, setBusy] = useState("");
  const [res, setRes] = useState({});
  const [board, setBoard] = useState("");
  const [boards, setBoards] = useState([]);
  const [tiktokMode, setTiktokMode] = useState("draft");
  const [when, setWhen] = useState("");   // a time to post later, from Autopilot's queue
  useEffect(() => { loadK("ng-listings-v1").then(ls => setListings((Array.isArray(ls) ? ls : []).filter(l => (l.images || []).some(u => typeof u === "string")))).catch(() => setListings([])); }, []);
  useEffect(() => { if (st?.pinterest?.connected) api("pinterest_boards").then(d => { setBoards(d.boards); setBoard(b => b || d.boards[0]?.id || ""); }).catch(() => {}); }, [st?.pinterest?.connected]);

  const shown = useMemo(() => {
    const w = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (listings || []).filter(l => w.every(x => `${l.title} ${l.material} ${l.sku}`.toLowerCase().includes(x))).slice(0, 24);
  }, [listings, q]);
  const choose = l => {
    setPick(l); setImgs((l.images || []).filter(u => typeof u === "string").slice(0, 10)); setTxt({}); setRes({});
    setUseVideo(!!l.video);
    setOn(Object.fromEntries(PLATFORMS.map(p => [p.k, !!st?.[p.k]?.connected && (p.media !== "video" || !!l.video) && (p.k !== "pinterest" || !!storeLink(l))])));
  };
  const video = useVideo && pick?.video ? pick.video : "";
  const link = pick ? storeLink(pick) : "";

  const write = async () => {
    setBusy("write");
    try {
      const facts = [`Piece: ${pick.title}`, pick.material && `Stone: ${pick.material}`, pick.shape && `Shape: ${pick.shape}`, pick.origin && `Origin: ${pick.origin}`,
        pick.size && `Size: ${pick.size}`, pick.weight && `Weight: ${pick.weight}`, pick.description && `Listing description: ${String(pick.description).slice(0, 1200)}`,
        link && `Link: ${link}`].filter(Boolean).join("\n");
      const out = parseJson(await ask(`Write social posts for this piece, one per platform, each in that platform's own style. Never invent facts beyond these.\n\n${facts}\n\nReturn ONLY JSON:
{"instagram":"the Instagram caption (shape below)",
 "tiktok":"1-2 punchy lines + 4-6 hashtags",
 "youtube_title":"under 80 characters","youtube":"description, 2-3 lines, the link, 3 hashtags",
 "pinterest_title":"under 100 characters, searchable","pinterest":"under 450 characters, keyword-rich, no hashtags",
 "threads":"under 450 characters, conversational, 1-2 hashtags",
 "x":"under 250 characters including the link if given, 1-2 hashtags"}

The Instagram caption:
${instagramShape(HASHTAG_ENDING)}`, 1800, INSTAGRAM_VOICE, "journal"));
      if (!out) throw new Error("The AI's reply couldn't be read — try again");
      setTxt(out);
    } catch (e) { showToast(`⚠ ${e.message}`); }
    setBusy("");
  };

  const payload = k => ({
    text: txt[k] || "", title: k === "youtube" ? txt.youtube_title : k === "pinterest" ? txt.pinterest_title : pick.title,
    images: imgs, video: ["tiktok", "youtube"].includes(k) || (["instagram", "threads"].includes(k) && video) ? video : "",
    link, board, mode: k === "tiktok" ? tiktokMode : "", source: `listing:${pick.id}`,
  });
  const schedule = async () => {
    const list = PLATFORMS.filter(p => on[p.k] && st?.[p.k]?.connected);
    if (!list.length || !when) return;
    setBusy("schedule");
    try {
      const d = await api("schedule", { body: { at: new Date(when).toISOString(), items: list.map(p => ({ platform: p.k, payload: payload(p.k) })) } });
      showToast(`✓ ${d.added} post${d.added === 1 ? "" : "s"} scheduled for ${new Date(when).toLocaleString()} — see Autopilot`);
      setWhen("");
    } catch (e) { showToast(`⚠ ${e.message}`); }
    setBusy("");
  };
  const publish = async () => {
    const list = PLATFORMS.filter(p => on[p.k]);
    if (!list.length) return;
    if (!confirm(`Publish to ${list.map(p => p.label).join(", ")}?`)) return;
    setBusy("publish");
    for (const p of list) {
      setRes(r => ({ ...r, [p.k]: { busy: true } }));
      try { const d = await api("post", { p: p.k, body: payload(p.k) }); setRes(r => ({ ...r, [p.k]: { ok: true, url: d.url, note: d.note } })); }
      catch (e) { setRes(r => ({ ...r, [p.k]: { error: e.message } })); }
    }
    setBusy("");
  };

  if (!pick) return (
    <div style={card}>
      <span style={lab}>1 · Pick a piece</span>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search listings — name, stone, SKU…" style={FI({ marginBottom: 10 })} />
      {!listings && <div style={{ color: C.inkFaint, fontSize: 13 }}>Loading…</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 10 }}>
        {shown.map(l => (
          <button key={l.id} onClick={() => choose(l)} style={{ border: `1px solid ${C.border}`, background: C.surface, borderRadius: 10, padding: 0, overflow: "hidden", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
            <img src={l.images.find(u => typeof u === "string")} alt="" style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block" }} />
            <div style={{ padding: "6px 8px", fontSize: 12, fontWeight: 600, color: C.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.video ? "▶ " : ""}{l.title}</div>
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={card}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
          <b style={{ flex: 1, fontSize: 15 }}>{pick.title}</b>
          <button onClick={() => setPick(null)} style={btn()}>Change piece</button>
        </div>
        <span style={lab}>Photos — tap to leave one out · {imgs.length} chosen</span>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {(pick.images || []).filter(u => typeof u === "string").map(u => {
            const inn = imgs.includes(u);
            return <img key={u} src={u} alt="" onClick={() => setImgs(a => inn ? a.filter(x => x !== u) : [...a, u].slice(0, 10))}
              style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, cursor: "pointer", opacity: inn ? 1 : .3, outline: inn ? `2px solid ${C.gold}` : "none" }} />;
          })}
        </div>
        {pick.video && <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginTop: 10, cursor: "pointer" }}>
          <input type="checkbox" checked={useVideo} onChange={e => setUseVideo(e.target.checked)} /> Use the video (Instagram as a Reel, Threads as a video; TikTok and YouTube always need it)</label>}
        <div style={{ fontSize: 12, color: link ? C.inkMid : C.amber, marginTop: 8 }}>{link ? <>Link: {link.split("?")[0]}</> : "Not on eartheditions.co yet — posts go without a link (Pinterest needs one)."}</div>
      </div>

      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <span style={{ ...lab, flex: 1, margin: 0 }}>2 · Captions for each platform</span>
          <button disabled={busy === "write"} onClick={write} style={btn(C.ink, "#FAF0DC")}>{busy === "write" ? "Writing…" : Object.keys(txt).length ? "↻ Write again" : "✨ Write captions"}</button>
        </div>
        {PLATFORMS.map(p => {
          const s = st?.[p.k] || {};
          const needsVideo = p.media === "video" && !video;
          const r = res[p.k];
          return (
            <div key={p.k} style={{ borderTop: `1px solid ${C.border}`, padding: "10px 0" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: s.connected && !needsVideo ? "pointer" : "default", flex: 1, fontWeight: 700, fontSize: 14 }}>
                  <input type="checkbox" disabled={!s.connected || needsVideo} checked={!!on[p.k] && s.connected && !needsVideo} onChange={e => setOn(o => ({ ...o, [p.k]: e.target.checked }))} />
                  {p.icon} {p.label}
                  <span style={{ fontWeight: 400, fontSize: 11.5, color: C.inkFaint }}>{!s.connected ? "not connected — copy the text" : needsVideo ? "needs a video" : s.name}</span>
                </label>
                {p.k === "tiktok" && s.connected && (
                  <select value={tiktokMode} onChange={e => setTiktokMode(e.target.value)} style={{ ...FI(), width: "auto", padding: "4px 8px", fontSize: 12 }}>
                    <option value="draft">Send as draft</option>{s.canPost && <option value="post">Post now</option>}
                  </select>
                )}
                {p.k === "pinterest" && s.connected && boards.length > 0 && (
                  <select value={board} onChange={e => setBoard(e.target.value)} style={{ ...FI(), width: "auto", padding: "4px 8px", fontSize: 12 }}>{boards.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
                )}
                {txt[p.k] && <button onClick={() => navigator.clipboard.writeText(txt[p.k]).then(() => showToast("Copied"))} style={{ ...btn(), padding: "4px 10px", fontSize: 12 }}>Copy</button>}
              </div>
              {(p.k === "youtube" || p.k === "pinterest") && (txt[`${p.k}_title`] != null) && (
                <input value={txt[`${p.k}_title`] || ""} onChange={e => setTxt(t => ({ ...t, [`${p.k}_title`]: e.target.value }))} placeholder="Title" style={FI({ marginBottom: 6, fontWeight: 600 })} />
              )}
              {txt[p.k] != null && <textarea value={txt[p.k]} onChange={e => setTxt(t => ({ ...t, [p.k]: e.target.value }))} rows={p.limit > 500 ? 5 : 3} style={FI({ fontSize: 13, lineHeight: 1.5, resize: "vertical" })} />}
              {txt[p.k] != null && <div style={{ fontSize: 11, color: txt[p.k].length > p.limit ? C.red : C.inkFaint, textAlign: "right" }}>{txt[p.k].length}/{p.limit}</div>}
              {r && <div style={{ fontSize: 12.5, marginTop: 4, color: r.error ? C.red : r.busy ? C.inkMid : C.green }}>
                {r.busy ? "Posting…" : r.error ? `⚠ ${r.error}` : <>✓ {r.note || "Posted"} {r.url && <a href={r.url} target="_blank" rel="noreferrer">View ↗</a>}</>}</div>}
            </div>
          );
        })}
        <button disabled={!!busy || !Object.keys(txt).length || !PLATFORMS.some(p => on[p.k])} onClick={publish}
          style={{ ...btn(C.ink, "#FAF0DC"), width: "100%", padding: "12px", fontSize: 15, marginTop: 8, opacity: busy || !Object.keys(txt).length ? .5 : 1 }}>
          {busy === "publish" ? "Publishing…" : `Publish now to ${PLATFORMS.filter(p => on[p.k] && st?.[p.k]?.connected).length || "…"} platform${PLATFORMS.filter(p => on[p.k]).length === 1 ? "" : "s"}`}</button>
        <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12.5, color: C.inkMid }}>or later:</span>
          <input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} style={FI({ flex: 1, padding: "7px 10px" })} />
          <button disabled={!!busy || !when || !Object.keys(txt).length} onClick={schedule} style={{ ...btn(), opacity: !when || !Object.keys(txt).length ? .5 : 1 }}>{busy === "schedule" ? "…" : "Schedule"}</button>
        </div>
      </div>
    </div>
  );
}

/* ── Cross-post from Instagram ─────────────────────────────────────────── */
function CrossPost({ st, showToast }) {
  const [media, setMedia] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState({});
  const load = useCallback(() => { setErr(""); api("instagram_media").then(d => setMedia(d.media)).catch(e => setErr(e.message)); }, []);
  useEffect(() => { if (st?.instagram?.connected) load(); }, [st?.instagram?.connected, load]);
  if (!st?.instagram?.connected) return <div style={card}>Connect Instagram in <b>Accounts</b> first — its posts and Reels show here, ready to send on.</div>;
  const send = async (m, k) => {
    const caption = m.caption || "";
    if (k === "tiktok" && caption) { try { await navigator.clipboard.writeText(caption); } catch { /* not allowed */ } }
    setBusy(b => ({ ...b, [m.id + k]: true }));
    try {
      const d = await api("post", { p: k, body: { source: `ig:${m.id}`, text: k === "x" ? caption.slice(0, 270) : caption, title: caption.split("\n")[0].slice(0, 90), mode: k === "tiktok" ? "draft" : "" } });
      showToast(`✓ ${PLATFORMS.find(p => p.k === k).label}${d.note ? ` — ${d.note}` : ""}`);
      setMedia(ms => ms.map(x => x.id === m.id ? { ...x, sent: [...(x.sent || []), d.entry] } : x));
    } catch (e) { showToast(`⚠ ${e.message}`); }
    setBusy(b => ({ ...b, [m.id + k]: false }));
  };
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
        <div style={{ flex: 1, fontSize: 12.5, color: C.inkMid }}>Recent posts on {st.instagram.name || "Instagram"}. Videos go to TikTok (as a draft — caption copied) and YouTube Shorts; anything to Threads, X and Pinterest.</div>
        <button onClick={load} style={btn()}>↻</button>
      </div>
      {err && <div style={{ color: C.red, fontSize: 13 }}>⚠ {err}</div>}
      {!media && !err && <div style={{ color: C.inkFaint, fontSize: 13 }}>Loading…</div>}
      {(media || []).map(m => {
        const vid = m.media_type === "VIDEO";
        const done = new Set((m.sent || []).map(e => e.platform));
        return (
          <div key={m.id} style={{ display: "flex", gap: 10, borderTop: `1px solid ${C.border}`, padding: "10px 0" }}>
            <a href={m.permalink} target="_blank" rel="noreferrer"><img src={m.thumbnail_url || m.media_url} alt="" style={{ width: 60, height: 76, objectFit: "cover", borderRadius: 8, background: C.card }} /></a>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{m.caption || <i style={{ color: C.inkFaint }}>No caption</i>}</div>
              <div style={{ fontSize: 11, color: C.inkFaint, margin: "2px 0 6px" }}>{vid ? "Reel" : m.media_type === "CAROUSEL_ALBUM" ? "Carousel" : "Photo"} · {ago(m.timestamp)}</div>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {PLATFORMS.filter(p => p.k !== "instagram" && (p.media !== "video" || vid) && !(p.k === "pinterest" && vid)).map(p => {
                  const ok = st?.[p.k]?.connected;
                  return <button key={p.k} disabled={!ok || busy[m.id + p.k]} onClick={() => send(m, p.k)} title={ok ? "" : "Connect it in Accounts"}
                    style={{ ...btn(done.has(p.k) ? C.greenBg : C.surface, done.has(p.k) ? C.green : C.ink), padding: "4px 9px", fontSize: 12, opacity: ok ? 1 : .45 }}>
                    {busy[m.id + p.k] ? "…" : `${done.has(p.k) ? "✓ " : ""}${p.icon} ${p.label}`}</button>;
                })}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Journal ───────────────────────────────────────────────────────────── */
/* The journal on eartheditions.co/blog. A scheduled writer (a Claude routine)
   publishes a new article every Tuesday and Friday at 04:30 UTC, taking the
   next topic from the queue here (content/blog/planned.json in the store's
   repo) or choosing one itself when the queue is empty. Here: what's
   published (edit or take down), what's coming and in what order, and a
   post written and published by hand. */
const nextRuns = n => {
  const out = [], d = new Date();
  for (let i = 0; out.length < n && i < 60; i++) {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + i, 4, 30));
    if ((x.getUTCDay() === 2 || x.getUTCDay() === 5) && x > d) out.push(x);
  }
  return out;
};
function Journal({ st, showToast }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [plan, setPlan] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [topic, setTopic] = useState("");
  const [post, setPost] = useState(null);       // the editor: a new post, or a published one being changed
  const [busy, setBusy] = useState("");
  const [done, setDone] = useState(null);
  const load = useCallback(() => { setErr(""); api("journal_list").then(d => { setData(d); setPlan(d.planned); setDirty(false); }).catch(e => setErr(e.message)); }, []);
  useEffect(() => { load(); }, [load]);
  const runs = nextRuns(Math.max(4, plan.length + 1));

  const write = async () => {
    setBusy("write"); setDone(null);
    try {
      const out = parseJson(await ask(`Write an article for the Earth Editions journal (eartheditions.co/blog) about: ${topic}.
Read by collectors and curious buyers: accurate geology, mineralogy and history, plain and warm, British spelling, 800-1200 words. No health, healing or metaphysical claims; don't invent facts about the business. Link stones the way the journal does: [amethyst](/stones/amethyst) (lower-case slug, hyphens), and where it fits, an existing post: ${(data?.posts || []).slice(0, 12).map(p => `/blog/${p.slug}`).join(", ")}.
Body format: paragraphs separated by a blank line; "## " starts a heading (3-6 of them); lines starting "- " make a list; **bold**, *italic*. No emojis, no exclamation marks, no "In conclusion".
Return ONLY JSON: {"title":"under 70 characters","description":"90-170 characters","slug":"short-hyphenated-slug","stones":["slugs"],"body":"the article"}`, 4000));
      if (!out?.body) throw new Error("The AI's reply couldn't be read — try again");
      setPost({ ...out, isNew: true });
    } catch (e) { showToast(`⚠ ${e.message}`); }
    setBusy("");
  };
  const publish = async () => {
    if (!confirm(post.isNew ? `Publish "${post.title}" to the journal now?` : `Save your changes to "${post.title}"? They go live after the store redeploys.`)) return;
    setBusy("pub");
    try { const d = await api("journal_publish", { body: { post } }); setDone(d.url); showToast("✓ Done — live after the store's deploy (2–3 minutes)"); load(); }
    catch (e) { showToast(`⚠ ${e.message}`); }
    setBusy("");
  };
  const unpublish = async p => {
    if (!confirm(`Take "${p.title}" off the journal? Its page will stop working.`)) return;
    setBusy(p.slug);
    try { await api("journal_unpublish", { body: { slug: p.slug } }); showToast("✓ Taken down — gone after the store's deploy"); load(); }
    catch (e) { showToast(`⚠ ${e.message}`); }
    setBusy("");
  };
  const savePlan = async () => {
    setBusy("plan");
    try { const d = await api("journal_plan", { body: { planned: plan } }); setPlan(d.planned); setDirty(false); showToast("✓ Plan saved — the writer follows it from the next run"); }
    catch (e) { showToast(`⚠ ${e.message}`); }
    setBusy("");
  };
  const suggest = async () => {
    setBusy("suggest");
    try {
      const have = [...(data?.posts || []).map(p => p.title), ...plan.map(p => p.topic)];
      const out = parseJson(await ask(`Suggest 6 new journal topics for eartheditions.co (natural crystals, mineral specimens, carvings; a family business in India). Things people really search for: how a stone forms, where it's from and its history, telling it from fakes or look-alikes, what a trade name means, how a shape is made, care. Not these, already covered or planned: ${have.join("; ")}.
Return ONLY JSON: {"topics":[{"topic":"the article's subject, as a working title","notes":"one line on the angle"}]}`, 900));
      setPlan(p => [...p, ...(out?.topics || [])]); setDirty(true);
    } catch (e) { showToast(`⚠ ${e.message}`); }
    setBusy("");
  };
  const move = (i, d) => { setPlan(p => { const a = [...p], j = i + d; if (j < 0 || j >= a.length) return p; [a[i], a[j]] = [a[j], a[i]]; return a; }); setDirty(true); };
  const setP = (i, k, v) => { setPlan(p => p.map((x, j) => j === i ? { ...x, [k]: v } : x)); setDirty(true); };
  const set = k => e => setPost(p => ({ ...p, [k]: k === "stones" ? e.target.value.split(/[,\s]+/).filter(Boolean) : e.target.value }));
  const fmt = d => d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) + ", " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...card, fontSize: 12.5, color: C.inkMid, lineHeight: 1.6 }}>
        <b style={{ color: C.ink, fontSize: 14 }}>How the journal runs</b><br />
        A writer publishes a new article <b>every Tuesday and Friday at {nextRuns(1)[0].toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</b> (your time). It takes the <b>next topic in the queue below</b> — in that order, with your notes — or picks a topic people search for when the queue is empty. It writes 700–1,200 words in the journal's voice, checks it, and it's live on <a href={`${SITE}/blog`} target="_blank" rel="noreferrer">eartheditions.co/blog</a> a few minutes later. After 30 posts it goes weekly (Tuesdays).
      </div>
      {err && <div style={{ ...card, color: C.red, fontSize: 13 }}>⚠ {err}{/GITHUB_BLOG_TOKEN/.test(err) && <div style={{ color: C.inkMid, marginTop: 6 }}>github.com → Settings → Developer settings → Fine-grained tokens → Generate → Repository access: only earth-store → Permissions: Contents: Read and write → add it in Vercel as GITHUB_BLOG_TOKEN → Redeploy.</div>}</div>}

      <div style={card}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
          <b style={{ fontSize: 15, flex: 1 }}>Coming up</b>
          <button disabled={!data || busy === "suggest"} onClick={suggest} style={btn()}>{busy === "suggest" ? "Thinking…" : "✨ Suggest topics"}</button>
          <button disabled={!data} onClick={() => { setPlan(p => [...p, { topic: "", notes: "" }]); setDirty(true); }} style={btn()}>+ Add topic</button>
          {dirty && <button disabled={busy === "plan"} onClick={savePlan} style={btn(C.ink, "#FAF0DC")}>{busy === "plan" ? "Saving…" : "Save plan"}</button>}
        </div>
        {runs.map((r, i) => {
          const p = plan[i];
          return (
            <div key={r.toISOString()} style={{ display: "flex", gap: 10, borderTop: `1px solid ${C.border}`, padding: "8px 0", alignItems: "flex-start" }}>
              <div style={{ width: 120, flex: "none", fontSize: 12.5, fontWeight: 650, paddingTop: 7 }}>{fmt(r)}</div>
              {p ? (
                <div style={{ flex: 1, minWidth: 0 }}>
                  <input value={p.topic} onChange={e => setP(i, "topic", e.target.value)} placeholder="Topic" style={FI({ fontWeight: 650, marginBottom: 4 })} />
                  <input value={p.notes || ""} onChange={e => setP(i, "notes", e.target.value)} placeholder="Notes for the writer (angle, stones to link, what to avoid) — optional" style={FI({ fontSize: 12.5 })} />
                </div>
              ) : <div style={{ flex: 1, fontSize: 13, color: C.inkFaint, paddingTop: 7 }}>Writer's choice — a topic not covered yet</div>}
              {p && <div style={{ display: "flex", gap: 3, flex: "none" }}>
                <button onClick={() => move(i, -1)} disabled={!i} style={{ ...btn(), padding: "4px 8px" }}>↑</button>
                <button onClick={() => move(i, 1)} disabled={i === plan.length - 1} style={{ ...btn(), padding: "4px 8px" }}>↓</button>
                <button onClick={() => { setPlan(x => x.filter((_, j) => j !== i)); setDirty(true); }} style={{ ...btn(), padding: "4px 8px", color: C.red }}>×</button>
              </div>}
            </div>
          );
        })}
        {plan.length > runs.length && <div style={{ fontSize: 12, color: C.inkFaint }}>+ {plan.length - runs.length} more after these</div>}
      </div>

      <div style={card}>
        <b style={{ fontSize: 15 }}>Write one now</b>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input value={topic} onChange={e => setTopic(e.target.value)} placeholder="e.g. Why labradorite flashes blue" style={FI({ flex: 1 })} />
          <button disabled={!topic.trim() || !!busy} onClick={write} style={btn(C.ink, "#FAF0DC")}>{busy === "write" ? "Writing…" : "✨ Write"}</button>
        </div>
        <div style={{ fontSize: 12, color: C.inkFaint, marginTop: 6 }}>Published as soon as you approve it, outside the Tue/Fri schedule.</div>
      </div>

      {post && (
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
            <b style={{ fontSize: 15, flex: 1 }}>{post.isNew ? "New post" : `Editing: ${post.title}`}</b>
            <button onClick={() => setPost(null)} style={btn()}>Close</button>
          </div>
          <span style={lab}>Title</span><input value={post.title || ""} onChange={set("title")} style={FI({ marginBottom: 8, fontWeight: 700 })} />
          <span style={lab}>Search description</span><input value={post.description || ""} onChange={set("description")} style={FI({ marginBottom: 8 })} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 200px" }}><span style={lab}>Address</span><input value={post.slug || ""} disabled={!post.isNew} onChange={set("slug")} style={FI({ marginBottom: 8 })} /></div>
            <div style={{ flex: "1 1 200px" }}><span style={lab}>Stones (slugs)</span><input value={(post.stones || []).join(", ")} onChange={set("stones")} style={FI({ marginBottom: 8 })} /></div>
            <div style={{ flex: "0 1 150px" }}><span style={lab}>Date</span><input type="date" value={post.date || new Date().toISOString().slice(0, 10)} onChange={set("date")} style={FI({ marginBottom: 8 })} /></div>
          </div>
          <span style={lab}>Article</span>
          <textarea value={post.body || ""} onChange={set("body")} rows={20} style={FI({ fontSize: 13.5, lineHeight: 1.6, resize: "vertical" })} />
          <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
            <span style={{ fontSize: 12, color: C.inkFaint, flex: 1 }}>{String(post.body || "").split(/\s+/).length} words</span>
            <button onClick={() => navigator.clipboard.writeText(post.body).then(() => showToast("Copied"))} style={btn()}>Copy</button>
            <button disabled={!!busy || !st?.journal?.ready} onClick={publish} style={btn(C.ink, "#FAF0DC")}>{busy === "pub" ? "Saving…" : post.isNew ? "Publish" : "Save changes"}</button>
          </div>
          {done && <div style={{ fontSize: 13, color: C.green, marginTop: 8 }}>✓ <a href={done} target="_blank" rel="noreferrer">{done}</a> — live once the store redeploys.</div>}
        </div>
      )}

      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
          <b style={{ fontSize: 15, flex: 1 }}>Published · {data?.posts?.length ?? "…"}</b>
          <button onClick={load} style={btn()}>↻</button>
        </div>
        {!data && !err && <div style={{ fontSize: 13, color: C.inkFaint }}>Loading…</div>}
        {(data?.posts || []).map(p => (
          <div key={p.slug} style={{ display: "flex", gap: 10, borderTop: `1px solid ${C.border}`, padding: "8px 0", alignItems: "center" }}>
            <span style={{ width: 82, flex: "none", fontSize: 12, color: C.inkFaint }}>{p.date}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 650 }}>{p.title}</div>
              <div style={{ fontSize: 11.5, color: C.inkFaint, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.words} words · {(p.stones || []).join(", ")}</div>
            </div>
            <a href={`${SITE}/blog/${p.slug}`} target="_blank" rel="noreferrer" style={{ fontSize: 12.5 }}>View ↗</a>
            <button disabled={p.broken} onClick={() => { setPost({ ...p, isNew: false }); setDone(null); scrollTo({ top: 0, behavior: "smooth" }); }} style={{ ...btn(), padding: "4px 10px", fontSize: 12 }}>Edit</button>
            <button disabled={busy === p.slug} onClick={() => unpublish(p)} style={{ ...btn(), padding: "4px 10px", fontSize: 12, color: C.red }}>{busy === p.slug ? "…" : "Take down"}</button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Community: Reddit threads about our stones, replies drafted ───────── */
/* Answers on Reddit, to build a name as someone who knows rough stone — never
   to sell. The voice is a person, not the shop: no brand, no links, no "DM me".
   r/whatsthisrock is all photos, so the photos go to the model with the post. */
const ANSWER = `You write Reddit replies for a man in India who has spent years buying, sorting and wholesaling rough stone and minerals — he's handled tonnes of it and can tell most stones at a glance, and he's honest when he can't. He answers to help, never to sell.

How he answers:
- Lead with the answer: what it most likely is, then the one or two things in the photo that say so (luster, habit, cleavage or fracture, colour zoning, inclusions, matrix, weight for size, how it's been cut or polished).
- If it's uncertain, say what it could be and the quick check that would settle it (scratch/hardness, streak, magnet, UV, a chipped edge, heft, a loupe on the surface).
- Call out fakes and treatments plainly when they're likely: dyed agate/howlite, glass sold as "opalite" or citrine, heated amethyst, resin, reconstituted turquoise.
- 2-5 sentences, plain Reddit English, contractions, a little dry. Speak from experience ("we get a lot of this from…", "in rough it usually…") but never invent a specific fact, place or number you aren't sure of.
- Never: the name Earth Editions, a shop, a link, prices, "DM me", offers to sell, emojis, exclamation marks, hashtags, health or metaphysical claims.`;
async function draftAnswer(t) {
  const content = [{ type: "text", text: `r/${t.sub} post${t.flair ? ` [${t.flair}]` : ""}\nTitle: ${t.title}\n${t.text || "(photo only)"}\n\nWrite his reply. Return only the reply.` },
    ...(t.images || (t.image ? [t.image] : [])).map(url => url.startsWith("data:")
      ? { type: "image", source: { media_type: url.slice(5, url.indexOf(";")), data: url.split(",")[1] } }
      : { type: "image", source: { type: "url", url } })];
  const res = await fetchWithRetry("/api/claude", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4.1", max_tokens: 400, temperature: 0.6, messages: [{ role: "system", content: ANSWER }, { role: "user", content }] }) }, { tries: 2, timeoutMs: 90000 });
  const d = await res.json();
  if (d.error) throw new Error(d.error?.message || d.error);
  return (d.content || []).map(b => b.text || "").join("").trim();
}

function Community({ st, showToast }) {
  const [threads, setThreads] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [drafts, setDrafts] = useState({});
  const [terms, setTerms] = useState([]);
  useEffect(() => {
    // The stones we have most of, as the search words.
    loadK("ng-listings-v1").then(ls => {
      const n = new Map();
      for (const l of Array.isArray(ls) ? ls : []) { const m = String(l.material || "").trim(); if (m && m.length < 30) n.set(m, (n.get(m) || 0) + 1); }
      setTerms([...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([m]) => m));
    }).catch(() => {});
  }, []);
  const [mode, setMode] = useState("questions");   // "questions" (r/whatsthisrock, r/crystals) | "stones" (threads naming what we stock)
  const find = async (m = mode) => {
    setBusy("find"); setErr(""); setMode(m);
    try { setThreads((m === "questions" ? await api("reddit_questions") : await api("reddit_search", { body: { terms } })).threads); } catch (e) { setErr(e.message); }
    setBusy("");
  };
  const draft = async t => {
    setBusy(t.id);
    try {
      const out = mode === "questions" ? await draftAnswer(t) : await ask(`A post on r/${t.sub}:\nTitle: ${t.title}\n${t.text}\n\nWrite a reply as Earth Editions' founder, a collector who cuts stone in India: genuinely helpful, specific, 2-5 sentences, the way a knowledgeable person talks on Reddit. No selling, no links, no brand name unless directly asked where to buy. If it's an ID request and the photo can't be seen, ask for the details that would settle it. Return only the reply.`, 500);
      setDrafts(d => ({ ...d, [t.id]: out }));
    } catch (e) { showToast(`⚠ ${e.message}`); }
    setBusy("");
  };
  /* Draft from a post you're looking at: paste its title/text, paste or drop
     its photo. Works without any Reddit API access. */
  const [pasted, setPasted] = useState({ text: "", sub: "whatsthisrock", images: [], reply: "" });
  const addPhotos = files => Promise.all([...files].filter(f => f.type.startsWith("image/")).slice(0, 3).map(f => new Promise(res => {
    const img = new Image(); img.onload = () => { const k = Math.min(1, 1400 / Math.max(img.width, img.height)); const c = document.createElement("canvas"); c.width = img.width * k; c.height = img.height * k; c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); res(c.toDataURL("image/jpeg", .85)); URL.revokeObjectURL(img.src); };
    img.src = URL.createObjectURL(f);
  }))).then(urls => setPasted(p => ({ ...p, images: [...p.images, ...urls].slice(0, 3) })));
  const draftPasted = async () => {
    setBusy("paste");
    try { const lines = pasted.text.trim().split("\n"); setPasted(p => ({ ...p, reply: "" })); const reply = await draftAnswer({ sub: pasted.sub, title: lines[0] || "", text: lines.slice(1).join("\n"), images: pasted.images }); setPasted(p => ({ ...p, reply })); }
    catch (e) { showToast(`⚠ ${e.message}`); }
    setBusy("");
  };
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={card} onPaste={e => { if (e.clipboardData?.files?.length) { e.preventDefault(); addPhotos(e.clipboardData.files); } }}
        onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); addPhotos(e.dataTransfer.files); }}>
        <b style={{ fontSize: 15 }}>Answer a post you're looking at</b>
        <div style={{ fontSize: 12, color: C.inkMid, margin: "2px 0 8px" }}>Paste the post's title (first line) and text, and paste or drop its photo (a screenshot is fine). You get a reply in the voice of someone who's handled a lot of rough — no shop, no links. Make it yours, then post it on Reddit yourself.</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
          {["whatsthisrock", "crystals", "Minerals", "geology"].map(x => <button key={x} onClick={() => setPasted(p => ({ ...p, sub: x }))} style={btn(pasted.sub === x ? C.ink : undefined, pasted.sub === x ? "#FAF0DC" : undefined)}>r/{x}</button>)}
        </div>
        <textarea value={pasted.text} onChange={e => setPasted(p => ({ ...p, text: e.target.value }))} rows={3} placeholder={"Found this on a beach in Oregon, what is it?\nHeavy for its size, scratches glass…"} style={FI({ fontSize: 13 })} />
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
          {pasted.images.map((u, i) => <img key={i} src={u} alt="" onClick={() => setPasted(p => ({ ...p, images: p.images.filter((_, j) => j !== i) }))} title="Click to remove" style={{ width: 52, height: 52, objectFit: "cover", borderRadius: 7, cursor: "pointer" }} />)}
          <label style={{ ...btn(), display: "inline-block" }}>＋ Photo<input type="file" accept="image/*" multiple hidden onChange={e => { addPhotos(e.target.files); e.target.value = ""; }} /></label>
          <span style={{ fontSize: 11.5, color: C.inkFaint }}>or paste / drop it here</span>
          <div style={{ flex: 1 }} />
          <button disabled={busy === "paste" || (!pasted.text.trim() && !pasted.images.length)} onClick={draftPasted} style={btn(C.ink, "#FAF0DC")}>{busy === "paste" ? "Drafting…" : pasted.reply ? "↻ Draft again" : "Draft a reply"}</button>
        </div>
        {pasted.reply && <>
          <textarea value={pasted.reply} onChange={e => setPasted(p => ({ ...p, reply: e.target.value }))} rows={5} style={FI({ fontSize: 13, marginTop: 8 })} />
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <button onClick={() => navigator.clipboard.writeText(pasted.reply).then(() => showToast("Copied — paste it on Reddit"))} style={btn(C.ink, "#FAF0DC")}>Copy reply</button>
            <button onClick={() => setPasted({ text: "", sub: pasted.sub, images: [], reply: "" })} style={btn()}>Next post</button>
          </div>
        </>}
      </div>
      <div style={card}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div style={{ flex: 1 }}>
            <b style={{ fontSize: 15 }}>{mode === "questions" ? "Questions to answer — r/whatsthisrock, r/crystals" : "Reddit this week"}</b>
            <div style={{ fontSize: 12, color: C.inkMid }}>{mode === "questions"
              ? "New posts from the last 2 days asking what a stone is, or if it's real, with few answers yet. The reply is drafted from the photos, as someone who's handled a lot of rough — no shop, no links, no selling. Read it, make it yours, then Copy & open the thread and post it yourself. A few good answers a day builds the name."
              : <>Threads in r/crystals, r/MineralCollectors, r/Rockhounds, r/whatsthisrock and others that mention stones you stock: {terms.slice(0, 8).join(", ") || "…"}. A reply is drafted to post yourself — Reddit and Mindat ban accounts for automated posting.</>}</div>
          </div>
          <button disabled={!!busy} onClick={() => find("questions")} style={btn(C.ink, "#FAF0DC")}>{busy === "find" && mode === "questions" ? "Searching…" : "Questions to answer"}</button>
          <button disabled={!!busy || !terms.length} onClick={() => find("stones")} style={btn()}>{busy === "find" && mode === "stones" ? "Searching…" : "Threads about our stones"}</button>
        </div>
        {!st?.reddit?.ready && <div style={{ fontSize: 12, color: C.inkFaint, marginTop: 6 }}>If Reddit blocks the search, make a free "script" app at reddit.com/prefs/apps and add REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in Vercel.</div>}
        {err && <div style={{ color: C.red, fontSize: 13, marginTop: 8 }}>⚠ {err}</div>}
        {threads && !threads.length && <div style={{ color: C.inkFaint, fontSize: 13, marginTop: 8 }}>Nothing this week.</div>}
        {(threads || []).map(t => (
          <div key={t.id} style={{ borderTop: `1px solid ${C.border}`, padding: "10px 0", display: "flex", gap: 10 }}>
            {t.image && <img src={t.image} alt="" style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 7 }} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <a href={t.url} target="_blank" rel="noreferrer" style={{ fontSize: 13.5, fontWeight: 650, color: C.ink, textDecoration: "none" }}>{t.title} ↗</a>
              <div style={{ fontSize: 11, color: C.inkFaint }}>r/{t.sub} · {t.comments} comments · {ago(t.at)}</div>
              {drafts[t.id] != null
                ? <><textarea value={drafts[t.id]} onChange={e => setDrafts(d => ({ ...d, [t.id]: e.target.value }))} rows={4} style={FI({ fontSize: 13, marginTop: 6 })} />
                    <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                      <button onClick={() => { navigator.clipboard.writeText(drafts[t.id]); window.open(t.url, "_blank"); }} style={btn(C.ink, "#FAF0DC")}>Copy & open thread</button>
                      <button onClick={() => draft(t)} style={btn()}>↻</button></div></>
                : <button disabled={busy === t.id} onClick={() => draft(t)} style={{ ...btn(), marginTop: 6, padding: "4px 10px", fontSize: 12 }}>{busy === t.id ? "Drafting…" : "Draft a reply"}</button>}
            </div>
          </div>
        ))}
      </div>
      <Replies site={SITE} showToast={showToast} />
    </div>
  );
}

/* ── Autopilot ─────────────────────────────────────────────────────────── */
function Autopilot({ st, showToast }) {
  const [a, setA] = useState(null);
  const [queue, setQueue] = useState([]);
  const load = useCallback(() => api("auto_get").then(d => { setA(d.auto); setQueue(d.queue); }).catch(e => showToast(`⚠ ${e.message}`)), [showToast]);
  useEffect(() => { load(); }, [load]);
  const save = async next => { try { setA((await api("auto_set", { body: { auto: next } })).auto); showToast("✓ Saved"); } catch (e) { showToast(`⚠ ${e.message}`); } };
  const toggle = (job, k) => { const cur = a[job].platforms; save({ [job]: { ...a[job], platforms: cur.includes(k) ? cur.filter(x => x !== k) : [...cur, k] } }); };
  const cancel = async id => { await api("unschedule", { body: { id } }); load(); };
  if (!a) return <div style={card}>Loading…</div>;
  const pending = queue.filter(q => q.status === "pending").sort((x, y) => x.at.localeCompare(y.at));
  const past = queue.filter(q => q.status !== "pending").sort((x, y) => (y.done_at || "").localeCompare(x.done_at || "")).slice(0, 20);
  const job = (key, title, sub, allowed, extra = null) => (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ flex: 1 }}><b style={{ fontSize: 15 }}>{title}</b><div style={{ fontSize: 12.5, color: C.inkMid }}>{sub}</div></div>
        <button onClick={() => save({ [key]: { ...a[key], on: !a[key].on } })} style={btn(a[key].on ? C.green : C.surface, a[key].on ? "#fff" : C.ink)}>{a[key].on ? "● On" : "Off"}</button>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
        {PLATFORMS.filter(p => allowed.includes(p.k)).map(p => {
          const sel = a[key].platforms.includes(p.k), ok = st?.[p.k]?.connected;
          return <button key={p.k} onClick={() => toggle(key, p.k)} style={{ ...btn(sel ? C.ink : C.surface, sel ? "#FAF0DC" : C.ink), padding: "5px 10px", fontSize: 12, opacity: ok ? 1 : .55 }} title={ok ? "" : "Not connected — skipped until it is"}>{p.icon} {p.label}</button>;
        })}
      </div>
      {extra}
      {a[key].on && a[key].since && <div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 8 }}>On since {new Date(a[key].since).toLocaleString()} — only things after that are posted.</div>}
    </div>
  );
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ fontSize: 12.5, color: C.inkMid }}>Runs every hour by itself (a free GitHub job), even with the ERP closed. Each job only posts to platforms that are connected; everything it does shows in Log.</div>
      {job("listings", "🆕 New listings", "When a piece goes live in Listing Manager, captions are written for each platform and it's posted — Instagram as photos (or a Reel if it has a video), TikTok as a draft, Pinterest with its store link.",
        ["instagram", "pinterest", "threads", "x", "tiktok", "youtube"],
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, marginTop: 10, flexWrap: "wrap" }}>Wait
          <select value={a.listings.afterHours} onChange={e => save({ listings: { ...a.listings, afterHours: +e.target.value } })} style={{ ...FI(), width: "auto", padding: "4px 8px" }}>
            {[0, 1, 3, 6, 24].map(h => <option key={h} value={h}>{h ? `${h} hour${h > 1 ? "s" : ""}` : "no time"}</option>)}
          </select> after it goes live (time to fix anything first)</label>)}
      {job("instagram", "🔁 New Instagram posts", "Whatever you post on Instagram goes on to these too — Reels to TikTok (as a draft) and YouTube Shorts, photos to Pinterest, everything to Threads and X.",
        ["tiktok", "youtube", "threads", "x", "pinterest"])}
      <div style={card}>
        <b style={{ fontSize: 15 }}>🗓 Scheduled</b>
        <div style={{ fontSize: 12.5, color: C.inkMid, marginBottom: 6 }}>Posts set for later from Compose.</div>
        {!pending.length && <div style={{ fontSize: 13, color: C.inkFaint }}>Nothing scheduled.</div>}
        {pending.map(q => {
          const p = PLATFORMS.find(x => x.k === q.platform);
          return <div key={q.id} style={{ display: "flex", gap: 10, alignItems: "center", borderTop: `1px solid ${C.border}`, padding: "7px 0", fontSize: 13 }}>
            <span style={{ width: 150, flex: "none" }}>{new Date(q.at).toLocaleString()}</span>
            <span style={{ flex: 1, minWidth: 0 }}>{p?.icon} {p?.label} · {q.payload?.title}</span>
            <button onClick={() => cancel(q.id)} style={{ ...btn(), padding: "3px 9px", fontSize: 12, color: C.red }}>Cancel</button></div>;
        })}
        {past.length > 0 && <div style={{ marginTop: 10 }}>{past.map(q => <div key={q.id} style={{ fontSize: 12, color: q.status === "failed" ? C.red : C.inkFaint, padding: "3px 0" }}>
          {q.status === "failed" ? "⚠" : "✓"} {PLATFORMS.find(x => x.k === q.platform)?.label} · {q.payload?.title} · {q.error || q.note || "posted"} {q.url && <a href={q.url} target="_blank" rel="noreferrer">↗</a>}</div>)}</div>}
      </div>
    </div>
  );
}

/* ── Accounts ──────────────────────────────────────────────────────────── */
function Accounts({ st, reload, showToast }) {
  const [open, setOpen] = useState("");
  const connect = async k => { try { location.href = (await api("start", { p: k })).url; } catch (e) { showToast(`⚠ ${e.message}`); } };
  const disconnect = async k => { if (confirm("Disconnect?")) { await api("disconnect", { p: k }); reload(); } };
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ fontSize: 12.5, color: C.inkMid }}>Each platform needs its own free developer app, made once by the account owner. Tap <b>How to</b> for the steps; after adding its two keys in Vercel and redeploying, tap Connect.</div>
      {PLATFORMS.map(p => {
        const s = st?.[p.k] || {};
        const [how, idKey, secretKey] = SETUP[p.k];
        return (
          <div key={p.k} style={card}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <b style={{ fontSize: 15, flex: 1 }}>{p.icon} {p.label}</b>
              {s.connected ? <><span style={{ color: C.green, fontSize: 13, fontWeight: 650 }}>✓ {s.name || "connected"}</span><button onClick={() => disconnect(p.k)} style={btn()}>Disconnect</button></>
                : s.ready ? <button onClick={() => connect(p.k)} style={btn(C.ink, "#FAF0DC")}>Connect</button>
                : <span style={{ fontSize: 12, color: C.inkFaint }}>needs setting up</span>}
              <button onClick={() => setOpen(o => o === p.k ? "" : p.k)} style={btn()}>{open === p.k ? "Close" : "How to"}</button>
            </div>
            {LIMITS[p.k] && <div style={{ fontSize: 12, color: C.inkFaint, marginTop: 6 }}>{LIMITS[p.k]}</div>}
            {open === p.k && (
              <div style={{ fontSize: 12.5, color: C.inkMid, lineHeight: 1.6, marginTop: 8, background: C.card, borderRadius: 9, padding: 10 }}>
                <div>1. {how}</div>
                <div>2. Redirect / callback URL: <code style={{ wordBreak: "break-all", userSelect: "all" }}>{s.redirect}</code></div>
                <div>3. Vercel → Settings → Environment Variables: <code>{idKey}</code> and <code>{secretKey}</code> → Redeploy.</div>
                <div>4. Back here → Connect.</div>
              </div>
            )}
          </div>
        );
      })}
      <div style={card}>
        <b style={{ fontSize: 15 }}>📝 Journal (eartheditions.co/blog)</b> <span style={{ fontSize: 12.5, color: st?.journal?.ready ? C.green : C.inkFaint }}>{st?.journal?.ready ? "✓ ready" : "needs GITHUB_BLOG_TOKEN"}</span>
        <div style={{ fontSize: 12, color: C.inkFaint, marginTop: 4 }}>github.com → Settings → Developer settings → Fine-grained tokens → only earth-store → Contents: read and write.</div>
      </div>
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <b style={{ fontSize: 15, flex: 1 }}>👽 Reddit</b>
          {st?.reddit?.connected ? <><span style={{ color: C.green, fontSize: 13, fontWeight: 650 }}>✓ {st.reddit.name || "connected"}</span><button onClick={() => disconnect("reddit")} style={btn()}>Disconnect</button></>
            : st?.reddit?.ready ? <button onClick={() => connect("reddit")} style={btn(C.ink, "#FAF0DC")}>Connect</button> : <span style={{ fontSize: 12, color: C.inkFaint }}>needs setting up</span>}
        </div>
        <div style={{ fontSize: 12, color: C.inkMid, marginTop: 6, lineHeight: 1.6 }}>Posts only what you approve in Calendar, as your own account. Log in to Reddit as the account that should post, then: reddit.com/prefs/apps → "create another app" → type <b>web app</b> → redirect uri <code style={{ wordBreak: "break-all", userSelect: "all" }}>{st?.reddit?.redirect}</code> → add REDDIT_CLIENT_ID (the code under the app's name) and REDDIT_CLIENT_SECRET in Vercel → Redeploy → Connect.</div>
      </div>
    </div>
  );
}

function Log() {
  const [log, setLog] = useState(null);
  useEffect(() => { api("log").then(d => setLog(d.log)).catch(() => setLog([])); }, []);
  if (!log) return <div style={card}>Loading…</div>;
  if (!log.length) return <div style={card}>Nothing posted yet.</div>;
  return (
    <div style={card}>
      {log.map(e => {
        const p = PLATFORMS.find(x => x.k === e.platform);
        return (
          <div key={e.id || e.at + e.platform} style={{ display: "flex", gap: 10, padding: "7px 0", borderTop: `1px solid ${C.border}`, fontSize: 13, alignItems: "baseline" }}>
            <span style={{ width: 120, flex: "none", fontWeight: 650 }}>{p ? `${p.icon} ${p.label}` : e.platform === "journal" ? "📝 Journal" : e.platform}</span>
            <span style={{ flex: 1, minWidth: 0, color: C.inkMid }}>{e.title || e.source}{e.note ? ` · ${e.note}` : ""}</span>
            {e.url && <a href={e.url} target="_blank" rel="noreferrer">View ↗</a>}
            <span style={{ fontSize: 11.5, color: C.inkFaint, flex: "none" }}>{e.at ? ago(e.at) : ""}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ── the module ────────────────────────────────────────────────────────── */
export default function SocialApp({ onHome }) {
  const [tab, setTab] = useState("calendar");
  const [st, setSt] = useState(null);
  const [toast, setToast] = useState("");
  const showToast = useCallback(m => { setToast(m); setTimeout(() => setToast(""), 4500); }, []);
  const reload = useCallback(() => api("status").then(setSt).catch(e => showToast(`⚠ ${e.message}`)), [showToast]);
  useEffect(() => { reload(); }, [reload]);
  const connected = st ? PLATFORMS.filter(p => st[p.k]?.connected).length : 0;
  const TABS = [["calendar", "📅", "Calendar"], ["compose", "✍️", "Compose"], ["stories", "📸", "Stories"], ["captions", "💬", "Captions"], ["crosspost", "🔁", "Cross-post"], ["autopilot", "🤖", "Autopilot"], ["journal", "📝", "Journal"], ["community", "👥", "Community"], ["accounts", "🔗", `Accounts${st ? ` · ${connected}/${PLATFORMS.length}` : ""}`], ["log", "🗒", "Log"]];
  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.ink, fontFamily: "Inter, system-ui, sans-serif" }}>
      {toast && <div style={{ position: "fixed", bottom: 22, left: 16, right: 16, margin: "0 auto", maxWidth: 520, zIndex: 1300, background: C.ink, color: "#fff", padding: "11px 16px", borderRadius: 10, fontSize: 13, textAlign: "center" }}>{toast}</div>}
      <div style={{ position: "sticky", top: 0, zIndex: 100, background: C.surface, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: mob() ? "10px 14px" : "11px 28px" }}>
          <button onClick={onHome} style={{ background: "none", border: "none", cursor: "pointer", color: C.inkMid, fontFamily: "inherit", fontSize: 13, padding: "0 12px 0 0", borderRight: `1px solid ${C.border}` }}>← Home</button>
          <div>
            <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 22, fontWeight: 600, lineHeight: 1 }}>Social</div>
            <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 2 }}>Instagram · TikTok · YouTube · Pinterest · Threads · X · Journal · Reddit</div>
          </div>
        </div>
        <div style={{ display: "flex", overflowX: "auto", padding: mob() ? "0 8px" : "0 24px" }}>
          {TABS.map(([k, icon, label]) => (
            <button key={k} onClick={() => setTab(k)} style={{ display: "flex", gap: 6, alignItems: "center", border: "none", background: "none", cursor: "pointer", fontFamily: "inherit", padding: "11px 12px", fontSize: 13, whiteSpace: "nowrap",
              fontWeight: tab === k ? 700 : 450, color: tab === k ? C.ink : C.inkMid, borderBottom: `2.5px solid ${tab === k ? C.gold : "transparent"}`, marginBottom: -1 }}>{icon} {label}</button>
          ))}
        </div>
      </div>
      <div style={{ padding: mob() ? 12 : "20px 28px", maxWidth: 980, margin: "0 auto" }}>
        {tab === "compose" && <Compose st={st} showToast={showToast} />}
        {tab === "crosspost" && <CrossPost st={st} showToast={showToast} />}
        {tab === "calendar" && <Suspense fallback={<div style={{ color: C.inkFaint, fontSize: 13 }}>Loading…</div>}><SocialCalendar st={st} showToast={showToast} /></Suspense>}
        {(tab === "stories" || tab === "captions") && <Suspense fallback={<div style={{ color: C.inkFaint, fontSize: 13 }}>Loading…</div>}>
          {tab === "stories" ? <SocialStories /> : <Captions showToast={showToast} site={SITE} />}
        </Suspense>}
        {tab === "autopilot" && <Autopilot st={st} showToast={showToast} />}
        {tab === "journal" && <Journal st={st} showToast={showToast} />}
        {tab === "community" && <Community st={st} showToast={showToast} />}
        {tab === "accounts" && <Accounts st={st} reload={reload} showToast={showToast} />}
        {tab === "log" && <Log />}
      </div>
    </div>
  );
}
