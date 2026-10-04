/* Instagram → TikTok, on the platforms' own free APIs.

   Instagram (API with Instagram Login, a Business or Creator account): reads
   the account's recent Reels. TikTok (Content Posting API): each Reel is sent
   to the TikTok account — into its inbox as a draft to finish and post in the
   TikTok app (the default; caption pasted there), or posted straight away
   where the TikTok app is allowed to. The video file goes from Instagram's
   CDN through this function to TikTok; nothing is stored here.

   Setup, once: a Meta app with "Instagram API with Instagram Login" and a
   TikTok developer app with Login Kit + Content Posting API, each with the
   redirect URL  https://<this site>/api/social?action=callback&p=instagram|tiktok
   and these env vars in Vercel: IG_APP_ID, IG_APP_SECRET, TIKTOK_CLIENT_KEY,
   TIKTOK_CLIENT_SECRET.

   Tokens are kept in store_secrets (service role only); the ERP's browser
   never sees them. What was sent where is in app_data ng-crosspost-v1. */
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { requireUser } from "../lib/auth.js";

const sb = () => createClient(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const LOG_KEY = "ng-crosspost-v1";

/* ── secrets ─────────────────────────────────────────────────────────────── */
async function getSecret(key) {
  const { data, error } = await sb().from("store_secrets").select("value").eq("key", key).maybeSingle();
  if (!error) { try { return data?.value ? JSON.parse(data.value) : null; } catch { return data?.value || null; } }
  // No store_secrets table yet: app_data, staff-readable, as a fallback.
  const { data: row } = await sb().from("app_data").select("value").eq("key", "ng-social-secrets-v1").maybeSingle();
  const all = typeof row?.value === "string" ? JSON.parse(row.value) : row?.value || {};
  return all[key] ?? null;
}
async function setSecret(key, value) {
  const v = value == null ? null : JSON.stringify(value);
  const { error } = v == null
    ? await sb().from("store_secrets").delete().eq("key", key)
    : await sb().from("store_secrets").upsert({ key, value: v, updated_at: new Date().toISOString() });
  if (!error) return;
  const { data: row } = await sb().from("app_data").select("value").eq("key", "ng-social-secrets-v1").maybeSingle();
  const all = typeof row?.value === "string" ? JSON.parse(row.value) : row?.value || {};
  if (value == null) delete all[key]; else all[key] = value;
  await sb().from("app_data").upsert({ key: "ng-social-secrets-v1", value: all });
}
async function readLog() {
  const { data } = await sb().from("app_data").select("value").eq("key", LOG_KEY).maybeSingle();
  const v = typeof data?.value === "string" ? JSON.parse(data.value) : data?.value;
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
async function writeLog(mediaId, entry) {
  const log = await readLog();
  log[mediaId] = { ...(log[mediaId] || {}), ...entry };
  await sb().from("app_data").upsert({ key: LOG_KEY, value: log });
  return log[mediaId];
}

const base = req => `https://${req.headers["x-forwarded-host"] || req.headers.host}`;
const redirectUri = (req, p) => `${base(req)}/api/social?action=callback&p=${p}`;
const json = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t }; } };
const fail = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };

/* ── Instagram ───────────────────────────────────────────────────────────── */
async function igToken() {
  const t = await getSecret("ig_token");
  if (!t?.access_token) return null;
  // Long-lived tokens last 60 days; refreshed here once they're a day old.
  if (Date.now() - (t.refreshed_at || 0) > 864e5 && Date.now() < (t.expires_at || 0)) {
    const r = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(t.access_token)}`);
    const d = await json(r);
    if (d.access_token) {
      const next = { ...t, access_token: d.access_token, expires_at: Date.now() + (d.expires_in || 5184000) * 1000, refreshed_at: Date.now() };
      await setSecret("ig_token", next);
      return next;
    }
  }
  return t;
}
async function igReels() {
  const t = await igToken();
  if (!t) fail(400, "Instagram isn't connected");
  const r = await fetch(`https://graph.instagram.com/v21.0/me/media?fields=id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp&limit=30&access_token=${encodeURIComponent(t.access_token)}`);
  const d = await json(r);
  if (!r.ok) fail(502, `Instagram: ${d.error?.message || r.status}`);
  return (d.data || []).filter(m => m.media_type === "VIDEO");
}

/* ── TikTok ──────────────────────────────────────────────────────────────── */
async function ttToken() {
  const t = await getSecret("tt_token");
  if (!t?.access_token) return null;
  if (Date.now() < (t.expires_at || 0) - 300000) return t;
  // Access tokens last a day; the refresh token a year.
  const r = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY || "", client_secret: process.env.TIKTOK_CLIENT_SECRET || "", grant_type: "refresh_token", refresh_token: t.refresh_token }),
  });
  const d = await json(r);
  if (!d.access_token) fail(401, "TikTok's login has run out — connect TikTok again");
  const next = { ...t, access_token: d.access_token, refresh_token: d.refresh_token || t.refresh_token, expires_at: Date.now() + (d.expires_in || 86400) * 1000 };
  await setSecret("tt_token", next);
  return next;
}
const tt = async (path, token, body) => {
  const r = await fetch(`https://open.tiktokapis.com${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" }, body: JSON.stringify(body || {}) });
  const d = await json(r);
  if (!r.ok || (d.error?.code && d.error.code !== "ok")) fail(502, `TikTok: ${d.error?.message || d.error?.code || r.status}`);
  return d.data || {};
};

/* Sends one video to TikTok. mode "draft": into the TikTok inbox to finish in
   the app. mode "post": published straight away, with the caption, at the
   most open privacy the account allows this app (private until TikTok has
   reviewed the app). */
async function sendToTikTok(videoUrl, mode, caption) {
  const t = await ttToken();
  if (!t) fail(400, "TikTok isn't connected");
  const vid = await fetch(videoUrl);
  if (!vid.ok) fail(502, `Couldn't fetch the Reel from Instagram (${vid.status})`);
  const buf = Buffer.from(await vid.arrayBuffer());
  const size = buf.length;
  // TikTok takes chunks of 5–64 MB (a smaller file goes whole); the last chunk carries the rest.
  const CHUNK = 10 * 1024 * 1024;
  const chunk = size <= CHUNK ? size : CHUNK;
  const count = Math.max(1, Math.floor(size / chunk));
  const source_info = { source: "FILE_UPLOAD", video_size: size, chunk_size: chunk, total_chunk_count: count };

  let init;
  if (mode === "post") {
    const info = await tt("/v2/post/publish/creator_info/query/", t.access_token);
    const opts = info.privacy_level_options || ["SELF_ONLY"];
    const privacy = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"].find(p => opts.includes(p)) || opts[0];
    init = await tt("/v2/post/publish/video/init/", t.access_token, {
      post_info: { title: String(caption || "").slice(0, 2200), privacy_level: privacy, disable_duet: false, disable_comment: false, disable_stitch: false },
      source_info,
    });
    init.privacy = privacy;
  } else {
    init = await tt("/v2/post/publish/inbox/video/init/", t.access_token, { source_info });
  }
  for (let i = 0; i < count; i++) {
    const start = i * chunk, end = i === count - 1 ? size : start + chunk;
    const r = await fetch(init.upload_url, { method: "PUT", headers: { "Content-Type": "video/mp4", "Content-Length": String(end - start), "Content-Range": `bytes ${start}-${end - 1}/${size}` }, body: buf.subarray(start, end) });
    if (!r.ok && r.status !== 206) fail(502, `TikTok upload failed (${r.status})`);
  }
  return { publish_id: init.publish_id, privacy: init.privacy || "" };
}

/* ── handler ─────────────────────────────────────────────────────────────── */
export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  const u = new URL(req.url, "http://x");
  const action = u.searchParams.get("action") || req.body?.action;
  try {
    /* The platforms send the browser back here after login — no ERP session
       on that request, so the one-time state is what proves it's ours. */
    if (action === "callback") {
      const p = u.searchParams.get("p"), code = u.searchParams.get("code"), state = u.searchParams.get("state");
      const want = await getSecret(`oauth_state_${p}`);
      await setSecret(`oauth_state_${p}`, null);
      const back = msg => { res.statusCode = 302; res.setHeader("Location", `/?social=${encodeURIComponent(msg)}`); res.end(); };
      if (!code || !want || want.state !== state || Date.now() > want.until) return back(`${p}: login didn't finish — try Connect again`);
      if (p === "instagram") {
        const r = await fetch("https://api.instagram.com/oauth/access_token", { method: "POST",
          body: new URLSearchParams({ client_id: process.env.IG_APP_ID || "", client_secret: process.env.IG_APP_SECRET || "", grant_type: "authorization_code", redirect_uri: redirectUri(req, "instagram"), code }) });
        const short = await json(r);
        if (!short.access_token) return back(`Instagram: ${short.error_message || "no token"}`);
        const l = await json(await fetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(process.env.IG_APP_SECRET || "")}&access_token=${encodeURIComponent(short.access_token)}`));
        const token = l.access_token || short.access_token;
        const me = await json(await fetch(`https://graph.instagram.com/v21.0/me?fields=username&access_token=${encodeURIComponent(token)}`));
        await setSecret("ig_token", { access_token: token, expires_at: Date.now() + (l.expires_in || 3600) * 1000, refreshed_at: Date.now(), username: me.username || "" });
        return back(`Instagram connected${me.username ? ` (@${me.username})` : ""}`);
      }
      if (p === "tiktok") {
        const r = await fetch("https://open.tiktokapis.com/v2/oauth/token/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY || "", client_secret: process.env.TIKTOK_CLIENT_SECRET || "", code, grant_type: "authorization_code", redirect_uri: redirectUri(req, "tiktok") }) });
        const d = await json(r);
        if (!d.access_token) return back(`TikTok: ${d.error_description || d.error || "no token"}`);
        let name = "";
        try { const me = await json(await fetch("https://open.tiktokapis.com/v2/user/info/?fields=display_name", { headers: { Authorization: `Bearer ${d.access_token}` } })); name = me.data?.user?.display_name || ""; } catch { /* no name */ }
        await setSecret("tt_token", { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + (d.expires_in || 86400) * 1000, scope: d.scope || "", name });
        return back(`TikTok connected${name ? ` (${name})` : ""}`);
      }
      return back("Unknown platform");
    }

    if (!(await requireUser(req, res))) return;

    if (action === "status") {
      const [ig, t] = await Promise.all([getSecret("ig_token"), getSecret("tt_token")]);
      return res.json({
        setup: { instagram: !!(process.env.IG_APP_ID && process.env.IG_APP_SECRET), tiktok: !!(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET) },
        instagram: ig?.access_token ? { username: ig.username || "", expires_at: ig.expires_at } : null,
        tiktok: t?.access_token ? { name: t.name || "", canPost: /video\.publish/.test(t.scope || "") } : null,
        redirect: { instagram: redirectUri(req, "instagram"), tiktok: redirectUri(req, "tiktok") },
      });
    }

    // The login page to send the browser to, with a one-time state (and PKCE for TikTok).
    if (action === "start") {
      const p = u.searchParams.get("p");
      const state = crypto.randomBytes(16).toString("hex");
      if (p === "instagram") {
        if (!process.env.IG_APP_ID) fail(400, "Add IG_APP_ID and IG_APP_SECRET in Vercel first");
        await setSecret("oauth_state_instagram", { state, until: Date.now() + 600000 });
        return res.json({ url: `https://www.instagram.com/oauth/authorize?client_id=${process.env.IG_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri(req, "instagram"))}&response_type=code&scope=instagram_business_basic&state=${state}` });
      }
      if (p === "tiktok") {
        if (!process.env.TIKTOK_CLIENT_KEY) fail(400, "Add TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET in Vercel first");
        await setSecret("oauth_state_tiktok", { state, until: Date.now() + 600000 });
        return res.json({ url: `https://www.tiktok.com/v2/auth/authorize/?client_key=${process.env.TIKTOK_CLIENT_KEY}&scope=${encodeURIComponent("user.info.basic,video.upload,video.publish")}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri(req, "tiktok"))}&state=${state}` });
      }
      fail(400, "Which platform?");
    }

    if (action === "disconnect") {
      const p = u.searchParams.get("p");
      await setSecret(p === "tiktok" ? "tt_token" : "ig_token", null);
      return res.json({ ok: true });
    }

    if (action === "reels") {
      const [reels, log] = await Promise.all([igReels(), readLog()]);
      return res.json({ reels: reels.map(m => ({ ...m, sent: log[m.id] || null })) });
    }

    // One Reel → TikTok. The Instagram link to the video is fetched fresh (they expire).
    if (action === "send") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      const reels = await igReels();
      const m = reels.find(x => x.id === body.id);
      if (!m) fail(404, "That Reel isn't in the account's recent posts");
      const mode = body.mode === "post" ? "post" : "draft";
      const out = await sendToTikTok(m.media_url, mode, body.caption ?? m.caption);
      const entry = await writeLog(m.id, { at: new Date().toISOString(), mode, publish_id: out.publish_id, privacy: out.privacy, status: "sent" });
      return res.json({ ok: true, ...entry });
    }

    // How a sent video is getting on at TikTok.
    if (action === "check") {
      const id = u.searchParams.get("id");
      const log = await readLog();
      const e = log[id];
      if (!e?.publish_id) fail(404, "Not sent yet");
      const t = await ttToken();
      const d = await tt("/v2/post/publish/status/fetch/", t.access_token, { publish_id: e.publish_id });
      const entry = await writeLog(id, { status: String(d.status || e.status).toLowerCase(), fail_reason: d.fail_reason || "" });
      return res.json(entry);
    }

    fail(400, `Unknown action: ${action}`);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
}
