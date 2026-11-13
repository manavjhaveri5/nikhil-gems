/* Social → Insights: the TikTok account at a glance, straight from TikTok's
   Display API (followers, likes, video count) and its recent videos with
   views, likes, comments and shares. The calls run on Vercel (US), so this
   works from India without a VPN once the account is connected.

   Server side: api/social.js actions tiktok_stats and tiktok_creator. */
import { useState, useEffect, useMemo } from "react";
import { C, mob } from "./lmTheme.js";

const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 16px" };
const btn = (bg = C.surface, fg = C.ink) => ({ background: bg, color: fg, border: bg === C.surface ? `1px solid ${C.border}` : "none", borderRadius: 8, padding: "7px 13px", fontSize: 13, fontWeight: 650, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" });
const n = v => v == null ? "—" : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${Math.round(v / 1e3)}K` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(v);
const pct = v => `${(v * 100).toFixed(1)}%`;
const api = async (action, q = "") => {
  const r = await fetch(`/api/social?action=${action}${q}`);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Failed (${r.status})`);
  return d;
};
const SORTS = [["new", "Newest"], ["view_count", "Views"], ["like_count", "Likes"], ["comment_count", "Comments"], ["share_count", "Shares"], ["eng", "Engagement"]];

export default function SocialInsights({ st, showToast, onAccounts }) {
  const [d, setD] = useState(null);
  const [creator, setCreator] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [sort, setSort] = useState("new");
  const tt = st?.tiktok || {};

  const load = async () => {
    setBusy(true); setErr("");
    try {
      const [s, c] = await Promise.all([api("tiktok_stats"), api("tiktok_creator").catch(() => null)]);
      setD(s); setCreator(c);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const more = async () => {
    setBusy(true);
    try { const s = await api("tiktok_stats", `&cursor=${d.cursor}`); setD(x => ({ ...s, user: x.user, videos: [...x.videos, ...s.videos] })); }
    catch (e) { showToast(`⚠ ${e.message}`); }
    setBusy(false);
  };
  useEffect(() => { if (tt.connected) load(); }, [tt.connected]); // eslint-disable-line react-hooks/exhaustive-deps

  const videos = useMemo(() => {
    const v = (d?.videos || []).map(x => ({ ...x, eng: x.view_count ? ((x.like_count || 0) + (x.comment_count || 0) + (x.share_count || 0)) / x.view_count : 0 }));
    return sort === "new" ? v.sort((a, b) => b.create_time - a.create_time) : v.sort((a, b) => (b[sort] || 0) - (a[sort] || 0));
  }, [d, sort]);
  const tot = useMemo(() => videos.reduce((t, v) => ({ views: t.views + (v.view_count || 0), likes: t.likes + (v.like_count || 0), comments: t.comments + (v.comment_count || 0), shares: t.shares + (v.share_count || 0) }), { views: 0, likes: 0, comments: 0, shares: 0 }), [videos]);

  if (!st) return <div style={card}>Loading…</div>;
  if (!tt.connected) return <div style={card}><b>🎵 TikTok isn't connected.</b> <button onClick={onAccounts} style={{ ...btn(), marginLeft: 8 }}>Go to Accounts</button></div>;

  const u = d?.user || {};
  const missing = d?.missing?.length ? d.missing : tt.insights === false ? ["user.info.profile", "user.info.stats", "video.list"] : [];
  const Stat = ({ k, v, sub }) => <div style={{ ...card, padding: "12px 14px" }}><div style={{ fontSize: 10.5, fontWeight: 800, color: C.inkFaint, textTransform: "uppercase", letterSpacing: .6 }}>{k}</div><div style={{ fontSize: 24, fontWeight: 700, marginTop: 3 }}>{v}</div>{sub && <div style={{ fontSize: 11.5, color: C.inkFaint }}>{sub}</div>}</div>;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 12 }}>
      <div style={{ ...card, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        {u.avatar_url && <img src={u.avatar_url} alt="" referrerPolicy="no-referrer" style={{ width: 48, height: 48, borderRadius: "50%" }} />}
        <div style={{ flex: 1, minWidth: 160 }}>
          <b style={{ fontSize: 16 }}>🎵 {u.display_name || tt.name || "TikTok"}</b> {u.username && <span style={{ color: C.inkFaint, fontSize: 13 }}>@{u.username}</span>} {u.is_verified && "✔"}
          {u.bio_description && <div style={{ fontSize: 12.5, color: C.inkMid, marginTop: 2 }}>{u.bio_description}</div>}
          {creator?.privacy_level_options && <div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 3 }}>
            Direct posts can go: {creator.privacy_level_options.map(o => o.replace(/_/g, " ").toLowerCase()).join(", ")}
            {creator.privacy_level_options.length === 1 && creator.privacy_level_options[0] === "SELF_ONLY" && " — only private until TikTok approves the app"}
            {creator.max_video_post_duration_sec ? ` · up to ${Math.round(creator.max_video_post_duration_sec / 60)} min` : ""}</div>}
        </div>
        {u.profile_deep_link && <a href={u.profile_deep_link} target="_blank" rel="noreferrer" style={{ ...btn(), textDecoration: "none" }}>Open on TikTok ↗</a>}
        <button onClick={load} disabled={busy} style={btn(C.ink, "#FAF0DC")}>{busy ? "Loading…" : "Refresh"}</button>
      </div>

      {missing.length > 0 && <div style={{ ...card, borderColor: C.gold, fontSize: 13, lineHeight: 1.6 }}>
        <b>Insights need one reconnect.</b> TikTok was connected before the ERP asked for {missing.join(", ")}. Accounts → TikTok → Disconnect → Connect (the TikTok login page needs the VPN in India; nothing after that does).
        <button onClick={onAccounts} style={{ ...btn(), marginLeft: 8 }}>Go to Accounts</button></div>}
      {err && <div style={{ ...card, color: C.red, fontSize: 13 }}>⚠ {err}</div>}
      {d?.errors?.length > 0 && <div style={{ ...card, color: C.red, fontSize: 12.5 }}>TikTok said: {d.errors.join(" · ")}</div>}

      {d && <div style={{ display: "grid", gridTemplateColumns: mob() ? "repeat(2, minmax(0, 1fr))" : "repeat(4, minmax(0, 1fr))", gap: 10 }}>
        <Stat k="Followers" v={n(u.follower_count)} sub={u.following_count != null ? `following ${n(u.following_count)}` : ""} />
        <Stat k="Total likes" v={n(u.likes_count)} />
        <Stat k="Videos" v={n(u.video_count)} />
        <Stat k={`Views · last ${videos.length}`} v={n(tot.views)} sub={tot.views ? `${pct((tot.likes + tot.comments + tot.shares) / tot.views)} engagement` : ""} />
      </div>}

      {d && <div style={card}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
          <b style={{ fontSize: 15, flex: 1 }}>Videos</b>
          {SORTS.map(([k, l]) => <button key={k} onClick={() => setSort(k)} style={{ ...btn(sort === k ? C.ink : C.surface, sort === k ? "#FAF0DC" : C.ink), padding: "4px 10px", fontSize: 12 }}>{l}</button>)}
        </div>
        {!videos.length && <div style={{ fontSize: 13, color: C.inkFaint }}>No videos yet{missing.length ? " (or the video.list permission isn't granted yet)" : ""}.</div>}
        {videos.map(v => (
          <div key={v.id} style={{ display: "flex", gap: 12, alignItems: "center", borderTop: `1px solid ${C.border}`, padding: "9px 0" }}>
            {v.cover_image_url ? <img src={v.cover_image_url} alt="" referrerPolicy="no-referrer" loading="lazy" style={{ width: 54, height: 72, objectFit: "cover", borderRadius: 6, flex: "none", background: C.card }} /> : <div style={{ width: 54, height: 72, borderRadius: 6, background: C.card, flex: "none" }} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.title || v.video_description || "(no caption)"}</div>
              <div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 2 }}>{v.create_time ? new Date(v.create_time * 1000).toLocaleDateString() : ""}{v.duration ? ` · ${v.duration}s` : ""}</div>
              <div style={{ fontSize: 12.5, color: C.inkMid, marginTop: 4, display: "flex", gap: 12, flexWrap: "wrap" }}>
                <span>▶ {n(v.view_count)}</span><span>♥ {n(v.like_count)}</span><span>💬 {n(v.comment_count)}</span><span>↗ {n(v.share_count)}</span>
                {v.view_count > 0 && <span style={{ color: v.eng >= .08 ? C.green : C.inkFaint }}>{pct(v.eng)}</span>}
              </div>
            </div>
            {v.share_url && <a href={v.share_url} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, flex: "none" }}>View ↗</a>}
          </div>
        ))}
        {d.has_more && <button onClick={more} disabled={busy} style={{ ...btn(), marginTop: 8 }}>{busy ? "Loading…" : "Load older videos"}</button>}
      </div>}
      <div style={{ fontSize: 11.5, color: C.inkFaint }}>TikTok's API gives public counts only: no watch time, reach or audience breakdown (those stay in the TikTok app's analytics). Post from Compose or Cross-post.</div>
    </div>
  );
}
