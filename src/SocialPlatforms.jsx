/* Social → Platforms: one place per platform. "All" shows every connected
   account at a glance; picking one shows its account numbers, what's
   scheduled for it, and its recent posts with their numbers — open, delete
   (where the platform allows apps to), or start a new post for it.

   Server side: api/social.js actions feed (posts + account + scheduled),
   remove (delete a post) and unschedule. */
import { useState, useEffect, useCallback, useMemo, lazy, Suspense } from "react";
import { C, mob } from "./lmTheme.js";

const SocialReddit = lazy(() => import("./SocialReddit.jsx"));   // r/Crystals Sunday shop post — written here, posted by hand
const REDDIT = { k: "reddit", icon: "👽", label: "Reddit" };
const FEEDS = ["instagram", "tiktok", "youtube", "pinterest"];
const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 16px" };
const btn = (bg = C.surface, fg = C.ink) => ({ background: bg, color: fg, border: bg === C.surface ? `1px solid ${C.border}` : "none", borderRadius: 8, padding: "7px 13px", fontSize: 13, fontWeight: 650, cursor: "pointer", fontFamily: "inherit" });
const n = v => v == null ? "—" : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${Math.round(v / 1e3)}K` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(v);
const when = iso => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" }); };
const api = async (action, p, body) => {
  const r = await fetch(`/api/social?action=${action}${p ? `&p=${p}` : ""}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, p }) } : {});
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Failed (${r.status})`);
  return d;
};
const STAT_LABEL = { views: "views", reach: "reach", likes: "likes", comments: "comments", shares: "shares", saves: "saves", clicks: "clicks" };
const SORTS = [["new", "Newest"], ["views", "Views"], ["likes", "Likes"], ["comments", "Comments"]];

function Stat({ label, value }) {
  return <div style={{ minWidth: 70 }}><div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.1 }}>{n(value)}</div><div style={{ fontSize: 11, color: C.inkFaint }}>{label}</div></div>;
}

export default function SocialPlatforms({ st, platforms, showToast, onCreate, onAccounts }) {
  const [sel, setSel] = useState(() => { try { return localStorage.getItem("ee-social-platform") || "all"; } catch { return "all"; } });
  const [data, setData] = useState({});   // platform → { posts, account, scheduled, note } | { error }
  const [sort, setSort] = useState("new");
  const [busy, setBusy] = useState("");
  const [open, setOpen] = useState(null);   // { k, post } — the post popup
  const pick = k => { setSel(k); try { localStorage.setItem("ee-social-platform", k); } catch { /* private window */ } };
  const live = useMemo(() => FEEDS.filter(k => st?.[k]?.connected), [st]);
  const load = useCallback(k => {
    setData(d => ({ ...d, [k]: { ...(d[k] || {}), loading: true } }));
    api("feed", k).then(r => setData(d => ({ ...d, [k]: r }))).catch(e => setData(d => ({ ...d, [k]: { error: e.message } })));
  }, []);
  useEffect(() => { live.forEach(k => { if (!data[k]) load(k); }); }, [live]); // eslint-disable-line react-hooks/exhaustive-deps

  const del = async (k, post) => {
    if (!confirm(`Delete this ${post.type.toLowerCase()} from ${platforms.find(p => p.k === k)?.label}? This can't be undone.`)) return;
    setBusy(post.id);
    try { await api("remove", k, { id: post.id }); setData(d => ({ ...d, [k]: { ...d[k], posts: d[k].posts.filter(x => x.id !== post.id) } })); setOpen(null); showToast("✓ Deleted"); }
    catch (e) { showToast(`⚠ ${e.message}`); }
    setBusy("");
  };
  const save = async (k, post, fields) => {
    setBusy(post.id);
    try {
      await api("edit", k, { id: post.id, fields });
      const upd = x => x.id !== post.id ? x : { ...x, ...(fields.title != null && k === "youtube" ? { text: fields.title } : fields.title != null || fields.description != null ? { text: fields.title || fields.description || x.text } : {}),
        ...(fields.privacy ? { type: fields.privacy === "public" ? "Short" : `Short · ${fields.privacy}` } : {}), edit: { ...(x.edit || {}), ...fields } };
      setData(d => ({ ...d, [k]: { ...d[k], posts: d[k].posts.map(upd) } }));
      setOpen(o => o && { ...o, post: upd(o.post) });
      showToast("✓ Saved");
    } catch (e) { showToast(`⚠ ${e.message}`); }
    setBusy("");
  };
  const unschedule = async (k, id) => {
    setBusy(id);
    try { await api("unschedule", null, { id }); setData(d => ({ ...d, [k]: { ...d[k], scheduled: d[k].scheduled.filter(x => x.id !== id) } })); showToast("✓ Taken off the schedule"); }
    catch (e) { showToast(`⚠ ${e.message}`); }
    setBusy("");
  };

  const chips = (
    <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4, marginBottom: 12 }}>
      {[{ k: "all", icon: "🌐", label: "All" }, ...platforms, REDDIT].map(p => {
        const on = sel === p.k, conn = p.k === "all" || p.k === "reddit" || st?.[p.k]?.connected;
        return <button key={p.k} onClick={() => pick(p.k)} style={{ ...btn(on ? C.ink : C.surface, on ? "#FAF0DC" : conn ? C.ink : C.inkFaint), borderRadius: 999, whiteSpace: "nowrap", padding: "6px 13px" }}>{p.icon} {p.label}{!conn ? " ·  off" : ""}</button>;
      })}
    </div>
  );

  if (sel === "all") return (
    <div>
      {chips}
      <div style={{ display: "grid", gridTemplateColumns: mob() ? "1fr" : "1fr 1fr", gap: 12 }}>
        {platforms.map(p => {
          const s = st?.[p.k] || {}, d = data[p.k];
          if (!s.connected) return (
            <div key={p.k} style={{ ...card, display: "flex", alignItems: "center", gap: 10, opacity: .75 }}>
              <span style={{ fontSize: 22 }}>{p.icon}</span><b style={{ flex: 1 }}>{p.label}</b>
              <button onClick={onAccounts} style={btn()}>Connect</button>
            </div>);
          return (
            <button key={p.k} onClick={() => pick(p.k)} style={{ ...card, textAlign: "left", cursor: "pointer", fontFamily: "inherit", color: C.ink }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 22 }}>{p.icon}</span>
                <div style={{ flex: 1 }}><b>{p.label}</b><div style={{ fontSize: 12, color: C.inkFaint }}>{d?.account?.name || s.name}</div></div>
                {d?.scheduled?.length > 0 && <span style={{ fontSize: 11.5, background: C.amberBg, borderRadius: 999, padding: "2px 8px" }}>🗓 {d.scheduled.length} scheduled</span>}
              </div>
              {!FEEDS.includes(p.k) ? <div style={{ fontSize: 12.5, color: C.inkMid }}>Connected — posts go out from Create.</div>
                : d?.error ? <div style={{ fontSize: 12.5, color: C.red }}>⚠ {d.error}</div>
                : !d?.account ? <div style={{ fontSize: 12.5, color: C.inkFaint }}>Loading…</div>
                : <>
                  <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                    <Stat label={p.k === "youtube" ? "subscribers" : "followers"} value={d.account.followers} />
                    <Stat label="posts" value={d.account.posts} />
                    {d.account.views != null && <Stat label={p.k === "pinterest" ? "monthly views" : "views"} value={d.account.views} />}
                    {d.account.reach_28d != null && <Stat label="reach · 28d" value={d.account.reach_28d} />}
                  </div>
                  <div style={{ display: "flex", gap: 4, marginTop: 10 }}>
                    {(d.posts || []).slice(0, 5).map(x => <img key={x.id} src={x.thumb} alt="" style={{ width: 48, height: 60, objectFit: "cover", borderRadius: 6, background: C.card }} />)}
                  </div>
                </>}
            </button>);
        })}
        <button onClick={() => pick("reddit")} style={{ ...card, textAlign: "left", cursor: "pointer", fontFamily: "inherit", color: C.ink }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 22 }}>{REDDIT.icon}</span>
            <div style={{ flex: 1 }}><b>Reddit</b><div style={{ fontSize: 12, color: C.inkFaint }}>r/Crystals · Sunday shop post</div></div>
          </div>
          <div style={{ fontSize: 12.5, color: C.inkMid }}>Pick the pieces and photos — the title and post are written around them, with prices, links and shipping. Past posts kept here.</div>
        </button>
      </div>
    </div>
  );

  if (sel === "reddit") return <div>{chips}<Suspense fallback={<div style={{ color: C.inkFaint, fontSize: 13 }}>Loading…</div>}><SocialReddit showToast={showToast} /></Suspense></div>;

  const p = platforms.find(x => x.k === sel) || platforms[0];
  const s = st?.[p.k] || {}, d = data[p.k] || {};
  const posts = [...(d.posts || [])].sort((a, b) => sort === "new" ? Date.parse(b.at) - Date.parse(a.at) : (b.stats[sort] ?? -1) - (a.stats[sort] ?? -1));
  return (
    <div>
      {chips}
      <div style={{ ...card, marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 26 }}>{p.icon}</span>
          <div style={{ flex: 1, minWidth: 140 }}>
            <b style={{ fontSize: 16 }}>{p.label}</b>
            <div style={{ fontSize: 12.5, color: C.inkFaint }}>{s.connected ? (d.account?.url ? <a href={d.account.url} target="_blank" rel="noreferrer" style={{ color: C.inkMid }}>{d.account?.name || s.name} ↗</a> : (d.account?.name || s.name)) : "Not connected"}</div>
          </div>
          {s.connected && FEEDS.includes(p.k) && <button onClick={() => load(p.k)} style={btn()} title="Refresh">↻</button>}
          {s.connected ? <button onClick={() => onCreate(p.k)} style={btn(C.ink, "#FAF0DC")}>＋ Create post</button> : <button onClick={onAccounts} style={btn(C.ink, "#FAF0DC")}>Connect</button>}
        </div>
        {d.account && <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 12 }}>
          <Stat label={p.k === "youtube" ? "subscribers" : "followers"} value={d.account.followers} />
          <Stat label="posts" value={d.account.posts} />
          {d.account.views != null && <Stat label={p.k === "pinterest" ? "monthly views" : "total views"} value={d.account.views} />}
          {d.account.likes != null && <Stat label="likes" value={d.account.likes} />}
          {d.account.views_28d != null && <Stat label="views · 28d" value={d.account.views_28d} />}
          {d.account.reach_28d != null && <Stat label="reach · 28d" value={d.account.reach_28d} />}
          {d.account.accounts_engaged_28d != null && <Stat label="engaged · 28d" value={d.account.accounts_engaged_28d} />}
        </div>}
        {d.note && <div style={{ fontSize: 12, color: C.amber, marginTop: 10 }}>{d.note}</div>}
      </div>

      {!s.connected ? null : !FEEDS.includes(p.k) ? <div style={card}>{p.label} is connected. Its posts can't be listed here yet — post to it from Create.</div> : <>
        {d.scheduled?.length > 0 && <div style={{ ...card, marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .7, marginBottom: 6 }}>Scheduled</div>
          {d.scheduled.map(q => (
            <div key={q.id} style={{ display: "flex", gap: 10, alignItems: "center", borderTop: `1px solid ${C.border}`, padding: "8px 0" }}>
              {q.thumb && <img src={q.thumb} alt="" style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 6 }} />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{q.title || q.text.slice(0, 80)}</div>
                <div style={{ fontSize: 11.5, color: C.inkFaint }}>{new Date(q.at).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</div>
              </div>
              <button disabled={busy === q.id} onClick={() => unschedule(p.k, q.id)} style={{ ...btn(), padding: "4px 10px", fontSize: 12 }}>{busy === q.id ? "…" : "Cancel"}</button>
            </div>))}
        </div>}

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <div style={{ flex: 1, fontSize: 11, fontWeight: 800, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .7 }}>Recent posts</div>
          <select value={sort} onChange={e => setSort(e.target.value)} style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: "5px 8px", fontSize: 12.5, fontFamily: "inherit", background: C.surface }}>
            {SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
        {d.error && <div style={{ ...card, color: C.red, fontSize: 13 }}>⚠ {d.error}</div>}
        {!d.posts && !d.error && <div style={{ color: C.inkFaint, fontSize: 13 }}>Loading…</div>}
        {d.posts && !posts.length && <div style={{ ...card, color: C.inkMid, fontSize: 13 }}>Nothing posted yet.</div>}
        <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${mob() ? 150 : 180}px, 1fr))`, gap: 10 }}>
          {posts.map(x => (
            <div key={x.id} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", display: "flex", flexDirection: "column" }}>
              <a href={x.url} onClick={e => { e.preventDefault(); setOpen({ k: p.k, post: x }); }} style={{ position: "relative", display: "block", cursor: "pointer" }}>
                {x.thumb ? <img src={x.thumb} alt="" style={{ width: "100%", aspectRatio: "4/5", objectFit: "cover", display: "block", background: C.card }} />
                  : <div style={{ width: "100%", aspectRatio: "4/5", background: C.card, display: "grid", placeItems: "center", fontSize: 12, color: C.inkFaint }}>No preview</div>}
                <span style={{ position: "absolute", top: 6, left: 6, background: "rgba(0,0,0,.6)", color: "#fff", fontSize: 10.5, borderRadius: 6, padding: "2px 6px" }}>{x.type}</span>
              </a>
              <div onClick={e => { if (!e.target.closest("a,button")) setOpen({ k: p.k, post: x }); }} style={{ padding: "8px 9px", flex: 1, display: "flex", flexDirection: "column", gap: 5, cursor: "pointer" }}>
                <div style={{ fontSize: 12, color: C.ink, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", minHeight: 30 }}>{x.text || <i style={{ color: C.inkFaint }}>No caption</i>}</div>
                <div style={{ display: "flex", gap: "2px 9px", flexWrap: "wrap", fontSize: 11.5, color: C.inkMid }}>
                  {Object.entries(x.stats).filter(([, v]) => v != null).map(([k, v]) => <span key={k}><b style={{ color: C.ink }}>{n(v)}</b> {(STAT_LABEL[k] || k).replace(/s$/, v === 1 && k !== "reach" ? "" : "s")}</span>)}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: "auto", paddingTop: 4 }}>
                  <span style={{ flex: 1, fontSize: 11, color: C.inkFaint }}>{when(x.at)}</span>
                  <a href={x.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: C.inkMid }}>Open ↗</a>
                  {x.canDelete
                    ? <button disabled={busy === x.id} onClick={() => del(p.k, x)} style={{ ...btn(), padding: "3px 8px", fontSize: 11.5, color: C.red }}>{busy === x.id ? "…" : "Delete"}</button>
                    : <span title={d.deleteNote} style={{ fontSize: 11, color: C.inkFaint, cursor: "help" }}>🗑 in app</span>}
                </div>
              </div>
            </div>))}
        </div>
      </>}
      {open && <PostPopup k={open.k} post={open.post} platform={p} note={d.deleteNote} busy={busy === open.post.id} onClose={() => setOpen(null)}
        onSave={f => save(open.k, open.post, f)} onDelete={() => del(open.k, open.post)} showToast={showToast} />}
    </div>
  );
}

const PRIVACY = [["public", "Public"], ["unlisted", "Unlisted"], ["private", "Private"]];
function PostPopup({ k, post, platform, note, busy, onClose, onSave, onDelete, showToast }) {
  const [f, setF] = useState(post.edit || {});
  useEffect(() => { setF(post.edit || {}); }, [post]);
  useEffect(() => { const esc = e => e.key === "Escape" && onClose(); window.addEventListener("keydown", esc); return () => window.removeEventListener("keydown", esc); }, [onClose]);
  const changed = Object.keys(f).some(key => f[key] !== (post.edit || {})[key]);
  const field = (key, label, rows) => (
    <label style={{ display: "block", marginBottom: 8 }}>
      <span style={{ fontSize: 10.5, fontWeight: 800, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6 }}>{label}</span>
      {rows ? <textarea value={f[key] ?? ""} rows={rows} onChange={e => setF(o => ({ ...o, [key]: e.target.value }))} style={inp} />
        : <input value={f[key] ?? ""} onChange={e => setF(o => ({ ...o, [key]: e.target.value }))} style={inp} />}
    </label>);
  const editable = k === "youtube" || k === "pinterest";
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 1200, background: "rgba(20,16,10,.55)", display: "flex", alignItems: mob() ? "flex-end" : "center", justifyContent: "center", padding: mob() ? 0 : 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.surface, borderRadius: mob() ? "16px 16px 0 0" : 16, width: "100%", maxWidth: 860, maxHeight: mob() ? "92vh" : "88vh", overflow: "auto", display: "flex", flexDirection: mob() ? "column" : "row" }}>
        <div style={{ flex: mob() ? "none" : "0 0 340px", background: "#111", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
          {post.thumb ? <img src={post.thumb} alt="" style={{ width: "100%", maxHeight: mob() ? 300 : "88vh", objectFit: "contain", display: "block" }} /> : <div style={{ color: "#aaa", padding: 40, fontSize: 13 }}>No preview</div>}
          <a href={post.url} target="_blank" rel="noreferrer" style={{ position: "absolute", bottom: 10, right: 10, background: "rgba(0,0,0,.65)", color: "#fff", fontSize: 12.5, borderRadius: 8, padding: "6px 10px", textDecoration: "none" }}>Open on {platform.label} ↗</a>
        </div>
        <div style={{ flex: 1, padding: "16px 18px", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 20 }}>{platform.icon}</span>
            <div style={{ flex: 1, fontSize: 13, color: C.inkMid }}>{post.type} · {new Date(post.at).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
            <button onClick={onClose} aria-label="Close" style={{ ...btn(), padding: "4px 10px" }}>✕</button>
          </div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", margin: "8px 0 14px" }}>
            {Object.entries(post.stats).filter(([, v]) => v != null).map(([key, v]) => <Stat key={key} label={STAT_LABEL[key] || key} value={v} />)}
          </div>

          {editable ? <>
            {field("title", "Title")}
            {field("description", "Description", 5)}
            {k === "pinterest" && field("link", "Link")}
            {k === "youtube" && <label style={{ display: "block", marginBottom: 8 }}>
              <span style={{ fontSize: 10.5, fontWeight: 800, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6 }}>Visibility</span>
              <select value={f.privacy || "public"} onChange={e => setF(o => ({ ...o, privacy: e.target.value }))} style={inp}>{PRIVACY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </label>}
            <button disabled={!changed || busy} onClick={() => onSave(Object.fromEntries(Object.entries(f).filter(([key, v]) => v !== (post.edit || {})[key])))}
              style={{ ...btn(C.ink, "#FAF0DC"), width: "100%", padding: 10, opacity: !changed || busy ? .5 : 1 }}>{busy ? "Saving…" : changed ? "Save changes" : "No changes"}</button>
          </> : <>
            <div style={{ fontSize: 13.5, lineHeight: 1.55, whiteSpace: "pre-wrap", color: C.ink, background: C.bg, borderRadius: 10, padding: "10px 12px", maxHeight: 260, overflow: "auto" }}>{post.text || <i style={{ color: C.inkFaint }}>No caption</i>}</div>
            <div style={{ fontSize: 12, color: C.inkFaint, margin: "8px 0" }}>{k === "instagram" ? "Instagram doesn't let apps change a caption — edit it in the app." : k === "tiktok" ? "TikTok doesn't let apps edit videos — change it in the TikTok app." : ""}</div>
            {post.canComments && <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
              <button disabled={busy} onClick={() => onSave({ comments: false })} style={btn()}>Turn comments off</button>
              <button disabled={busy} onClick={() => onSave({ comments: true })} style={btn()}>Turn comments on</button>
            </div>}
          </>}

          <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap", borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
            {post.text && <button onClick={() => navigator.clipboard.writeText(post.edit?.description || post.text).then(() => showToast("Copied"))} style={btn()}>Copy caption</button>}
            <a href={post.url} target="_blank" rel="noreferrer" style={{ ...btn(), textDecoration: "none" }}>Open ↗</a>
            <span style={{ flex: 1 }} />
            {post.canDelete ? <button disabled={busy} onClick={onDelete} style={{ ...btn(C.redBg, C.red) }}>Delete</button>
              : <span style={{ fontSize: 12, color: C.inkFaint, alignSelf: "center" }}>{note || "Delete it in the app"}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
const inp = { display: "block", width: "100%", boxSizing: "border-box", marginTop: 3, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 10px", fontSize: 13.5, fontFamily: "inherit", background: C.bg, color: C.ink, resize: "vertical" };
