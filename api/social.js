/* Social: posting to every platform from the ERP, on each platform's own free
   API. One file, because the platforms share most of the work: an OAuth
   login, a token kept safe and refreshed, then "post this media with this
   text".

   Platforms and what each needs in Vercel (each is optional — a platform
   without its keys shows "set up" in the Accounts tab):
     instagram  IG_APP_ID, IG_APP_SECRET         Meta app, "Instagram API with Instagram Login"
     threads    THREADS_APP_ID, THREADS_APP_SECRET Meta app, Threads API use case
     tiktok     TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET  Login Kit + Content Posting API
     youtube    GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   Google Cloud, YouTube Data API v3
     pinterest  PINTEREST_APP_ID, PINTEREST_APP_SECRET
     x          X_CLIENT_ID, X_CLIENT_SECRET     X developer app, OAuth 2.0 (free tier)
     reddit     REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET   read-only, to find threads
     journal    GITHUB_BLOG_TOKEN                fine-grained token, contents:write on earth-store
   Every login comes back to  https://<this site>/api/social?action=callback&p=<platform>.

   Tokens live in store_secrets (service role only). What was posted where is
   kept in app_data ng-social-log-v1. Reddit and Mindat are never posted to
   from here: both ban automated posting, so the Community tab drafts replies
   for a person to post. */
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { requireUser, hasStoreSecret } from "../lib/auth.js";

export const config = { maxDuration: 300 };

const sb = () => createClient(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const LOG_KEY = "ng-social-log-v1";
const OLD_LOG_KEY = "ng-crosspost-v1";
const env = k => process.env[k] || "";
const json = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t }; } };
const fail = (status, msg) => { throw Object.assign(new Error(msg), { status }); };
const form = o => new URLSearchParams(Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)));
const basic = (id, secret) => "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");

/* ── secrets and the log ─────────────────────────────────────────────────── */
async function appData(key) {
  const { data } = await sb().from("app_data").select("value").eq("key", key).maybeSingle();
  return typeof data?.value === "string" ? JSON.parse(data.value) : data?.value ?? null;
}
async function getSecret(key) {
  const { data, error } = await sb().from("store_secrets").select("value").eq("key", key).maybeSingle();
  if (!error) { try { return data?.value ? JSON.parse(data.value) : null; } catch { return data?.value || null; } }
  return (await appData("ng-social-secrets-v1") || {})[key] ?? null;   // no store_secrets table yet
}
async function setSecret(key, value) {
  const { error } = value == null
    ? await sb().from("store_secrets").delete().eq("key", key)
    : await sb().from("store_secrets").upsert({ key, value: JSON.stringify(value), updated_at: new Date().toISOString() });
  if (!error) return;
  const all = await appData("ng-social-secrets-v1") || {};
  if (value == null) delete all[key]; else all[key] = value;
  await sb().from("app_data").upsert({ key: "ng-social-secrets-v1", value: all });
}
async function readLog() {
  const [log, old] = await Promise.all([appData(LOG_KEY), appData(OLD_LOG_KEY)]);
  const out = Array.isArray(log) ? log : [];
  // The first version kept TikTok sends by Instagram media id.
  if (old && typeof old === "object" && !out.some(e => e.legacy)) for (const [id, e] of Object.entries(old)) out.push({ legacy: true, source: `ig:${id}`, platform: "tiktok", ...e });
  return out;
}
async function addLog(entry) {
  const log = (await appData(LOG_KEY)) || [];
  const e = { id: crypto.randomUUID(), at: new Date().toISOString(), ...entry };
  await sb().from("app_data").upsert({ key: LOG_KEY, value: [e, ...log].slice(0, 500) });
  return e;
}

const site = req => `https://${req.headers["x-forwarded-host"] || req.headers.host}`;
const redirectUri = (req, p) => `${site(req)}/api/social?action=callback&p=${p}`;

/* ── the platforms ───────────────────────────────────────────────────────── */
// login: how to send someone to the platform's login. token: code → tokens.
// refresh: an expiring token → a fresh one. who: the account's name.
const P = {
  instagram: {
    keys: ["IG_APP_ID", "IG_APP_SECRET"],
    login: (req, state) => `https://www.instagram.com/oauth/authorize?client_id=${env("IG_APP_ID")}&redirect_uri=${encodeURIComponent(redirectUri(req, "instagram"))}&response_type=code&scope=${encodeURIComponent("instagram_business_basic,instagram_business_content_publish")}&state=${state}`,
    async token(req, code) {
      const s = await json(await fetch("https://api.instagram.com/oauth/access_token", { method: "POST", body: form({ client_id: env("IG_APP_ID"), client_secret: env("IG_APP_SECRET"), grant_type: "authorization_code", redirect_uri: redirectUri(req, "instagram"), code }) }));
      if (!s.access_token) fail(400, s.error_message || "no token");
      const l = await json(await fetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(env("IG_APP_SECRET"))}&access_token=${encodeURIComponent(s.access_token)}`));
      const access_token = l.access_token || s.access_token;
      const me = await json(await fetch(`https://graph.instagram.com/v21.0/me?fields=user_id,username&access_token=${encodeURIComponent(access_token)}`));
      return { access_token, expires_at: Date.now() + (l.expires_in || 3600) * 1000, refreshed_at: Date.now(), user_id: me.user_id || me.id || s.user_id, name: me.username ? `@${me.username}` : "" };
    },
    async refresh(t) {
      if (Date.now() - (t.refreshed_at || 0) < 864e5) return t;
      const d = await json(await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(t.access_token)}`));
      return d.access_token ? { ...t, access_token: d.access_token, expires_at: Date.now() + (d.expires_in || 5184000) * 1000, refreshed_at: Date.now() } : t;
    },
  },
  threads: {
    keys: ["THREADS_APP_ID", "THREADS_APP_SECRET"],
    login: (req, state) => `https://threads.net/oauth/authorize?client_id=${env("THREADS_APP_ID")}&redirect_uri=${encodeURIComponent(redirectUri(req, "threads"))}&scope=threads_basic,threads_content_publish&response_type=code&state=${state}`,
    async token(req, code) {
      const s = await json(await fetch("https://graph.threads.net/oauth/access_token", { method: "POST", body: form({ client_id: env("THREADS_APP_ID"), client_secret: env("THREADS_APP_SECRET"), grant_type: "authorization_code", redirect_uri: redirectUri(req, "threads"), code }) }));
      if (!s.access_token) fail(400, s.error_message || s.error?.message || "no token");
      const l = await json(await fetch(`https://graph.threads.net/access_token?grant_type=th_exchange_token&client_secret=${encodeURIComponent(env("THREADS_APP_SECRET"))}&access_token=${encodeURIComponent(s.access_token)}`));
      const access_token = l.access_token || s.access_token;
      const me = await json(await fetch(`https://graph.threads.net/v1.0/me?fields=username&access_token=${encodeURIComponent(access_token)}`));
      return { access_token, expires_at: Date.now() + (l.expires_in || 3600) * 1000, refreshed_at: Date.now(), name: me.username ? `@${me.username}` : "" };
    },
    async refresh(t) {
      if (Date.now() - (t.refreshed_at || 0) < 864e5) return t;
      const d = await json(await fetch(`https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(t.access_token)}`));
      return d.access_token ? { ...t, access_token: d.access_token, expires_at: Date.now() + (d.expires_in || 5184000) * 1000, refreshed_at: Date.now() } : t;
    },
  },
  tiktok: {
    keys: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
    login: (req, state) => `https://www.tiktok.com/v2/auth/authorize/?client_key=${env("TIKTOK_CLIENT_KEY")}&scope=${encodeURIComponent("user.info.basic,video.upload,video.publish")}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri(req, "tiktok"))}&state=${state}`,
    async token(req, code) {
      const d = await json(await fetch("https://open.tiktokapis.com/v2/oauth/token/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form({ client_key: env("TIKTOK_CLIENT_KEY"), client_secret: env("TIKTOK_CLIENT_SECRET"), code, grant_type: "authorization_code", redirect_uri: redirectUri(req, "tiktok") }) }));
      if (!d.access_token) fail(400, d.error_description || d.error || "no token");
      let name = "";
      try { name = (await json(await fetch("https://open.tiktokapis.com/v2/user/info/?fields=display_name", { headers: { Authorization: `Bearer ${d.access_token}` } }))).data?.user?.display_name || ""; } catch { /* none */ }
      return { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + (d.expires_in || 86400) * 1000, scope: d.scope || "", name };
    },
    async refresh(t) {
      if (Date.now() < (t.expires_at || 0) - 300000) return t;
      const d = await json(await fetch("https://open.tiktokapis.com/v2/oauth/token/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form({ client_key: env("TIKTOK_CLIENT_KEY"), client_secret: env("TIKTOK_CLIENT_SECRET"), grant_type: "refresh_token", refresh_token: t.refresh_token }) }));
      if (!d.access_token) fail(401, "TikTok's login has run out — connect it again");
      return { ...t, access_token: d.access_token, refresh_token: d.refresh_token || t.refresh_token, expires_at: Date.now() + (d.expires_in || 86400) * 1000 };
    },
  },
  youtube: {
    keys: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    login: (req, state) => `https://accounts.google.com/o/oauth2/v2/auth?client_id=${env("GOOGLE_CLIENT_ID")}&redirect_uri=${encodeURIComponent(redirectUri(req, "youtube"))}&response_type=code&scope=${encodeURIComponent("https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly")}&access_type=offline&prompt=consent&state=${state}`,
    async token(req, code) {
      const d = await json(await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: form({ client_id: env("GOOGLE_CLIENT_ID"), client_secret: env("GOOGLE_CLIENT_SECRET"), code, grant_type: "authorization_code", redirect_uri: redirectUri(req, "youtube") }) }));
      if (!d.access_token) fail(400, d.error_description || d.error || "no token");
      let name = "";
      try { name = (await json(await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", { headers: { Authorization: `Bearer ${d.access_token}` } }))).items?.[0]?.snippet?.title || ""; } catch { /* none */ }
      return { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + (d.expires_in || 3600) * 1000, name };
    },
    async refresh(t) {
      if (Date.now() < (t.expires_at || 0) - 300000) return t;
      const d = await json(await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: form({ client_id: env("GOOGLE_CLIENT_ID"), client_secret: env("GOOGLE_CLIENT_SECRET"), grant_type: "refresh_token", refresh_token: t.refresh_token }) }));
      if (!d.access_token) fail(401, "YouTube's login has run out — connect it again");
      return { ...t, access_token: d.access_token, expires_at: Date.now() + (d.expires_in || 3600) * 1000 };
    },
  },
  pinterest: {
    keys: ["PINTEREST_APP_ID", "PINTEREST_APP_SECRET"],
    login: (req, state) => `https://www.pinterest.com/oauth/?client_id=${env("PINTEREST_APP_ID")}&redirect_uri=${encodeURIComponent(redirectUri(req, "pinterest"))}&response_type=code&scope=${encodeURIComponent("boards:read,pins:read,pins:write,user_accounts:read")}&state=${state}`,
    async token(req, code) {
      const d = await json(await fetch("https://api.pinterest.com/v5/oauth/token", { method: "POST", headers: { Authorization: basic(env("PINTEREST_APP_ID"), env("PINTEREST_APP_SECRET")), "Content-Type": "application/x-www-form-urlencoded" },
        body: form({ grant_type: "authorization_code", code, redirect_uri: redirectUri(req, "pinterest") }) }));
      if (!d.access_token) fail(400, d.message || "no token");
      let name = "";
      try { name = (await json(await fetch("https://api.pinterest.com/v5/user_account", { headers: { Authorization: `Bearer ${d.access_token}` } }))).username || ""; } catch { /* none */ }
      return { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + (d.expires_in || 2592000) * 1000, name };
    },
    async refresh(t) {
      if (Date.now() < (t.expires_at || 0) - 864e5) return t;
      const d = await json(await fetch("https://api.pinterest.com/v5/oauth/token", { method: "POST", headers: { Authorization: basic(env("PINTEREST_APP_ID"), env("PINTEREST_APP_SECRET")), "Content-Type": "application/x-www-form-urlencoded" },
        body: form({ grant_type: "refresh_token", refresh_token: t.refresh_token }) }));
      if (!d.access_token) fail(401, "Pinterest's login has run out — connect it again");
      return { ...t, access_token: d.access_token, expires_at: Date.now() + (d.expires_in || 2592000) * 1000 };
    },
  },
  x: {
    keys: ["X_CLIENT_ID", "X_CLIENT_SECRET"],
    pkce: true,
    login: (req, state, challenge) => `https://x.com/i/oauth2/authorize?response_type=code&client_id=${env("X_CLIENT_ID")}&redirect_uri=${encodeURIComponent(redirectUri(req, "x"))}&scope=${encodeURIComponent("tweet.read tweet.write users.read media.write offline.access")}&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`,
    async token(req, code, verifier) {
      const d = await json(await fetch("https://api.x.com/2/oauth2/token", { method: "POST", headers: { Authorization: basic(env("X_CLIENT_ID"), env("X_CLIENT_SECRET")), "Content-Type": "application/x-www-form-urlencoded" },
        body: form({ grant_type: "authorization_code", code, redirect_uri: redirectUri(req, "x"), code_verifier: verifier, client_id: env("X_CLIENT_ID") }) }));
      if (!d.access_token) fail(400, d.error_description || d.error || "no token");
      let name = "";
      try { name = "@" + ((await json(await fetch("https://api.x.com/2/users/me", { headers: { Authorization: `Bearer ${d.access_token}` } }))).data?.username || ""); } catch { /* none */ }
      return { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + (d.expires_in || 7200) * 1000, name: name === "@" ? "" : name };
    },
    async refresh(t) {
      if (Date.now() < (t.expires_at || 0) - 300000) return t;
      const d = await json(await fetch("https://api.x.com/2/oauth2/token", { method: "POST", headers: { Authorization: basic(env("X_CLIENT_ID"), env("X_CLIENT_SECRET")), "Content-Type": "application/x-www-form-urlencoded" },
        body: form({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: env("X_CLIENT_ID") }) }));
      if (!d.access_token) fail(401, "X's login has run out — connect it again");
      return { ...t, access_token: d.access_token, refresh_token: d.refresh_token || t.refresh_token, expires_at: Date.now() + (d.expires_in || 7200) * 1000 };
    },
  },
};
const ready = p => P[p].keys.every(k => env(k));

async function token(p) {
  const t = await getSecret(`tok_${p}`);
  if (!t?.access_token) fail(400, `${p} isn't connected`);
  const fresh = await P[p].refresh(t);
  if (fresh !== t) await setSecret(`tok_${p}`, fresh);
  return fresh;
}

/* ── posting ─────────────────────────────────────────────────────────────── */
const wait = ms => new Promise(r => setTimeout(r, ms));
async function download(url) {
  const r = await fetch(url);
  if (!r.ok) fail(502, `Couldn't fetch the media (${r.status})`);
  return { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get("content-type") || "" };
}

// Instagram: one photo, a carousel of up to 10, or a Reel.
async function postInstagram({ text, images = [], video }) {
  const t = await token("instagram");
  const g = async (path, params) => {
    const d = await json(await fetch(`https://graph.instagram.com/v21.0/${path}`, { method: "POST", body: form({ ...params, access_token: t.access_token }) }));
    if (d.error) fail(502, `Instagram: ${d.error.message}`);
    return d;
  };
  const user = t.user_id || "me";
  let creation;
  if (video) creation = (await g(`${user}/media`, { media_type: "REELS", video_url: video, caption: text })).id;
  else if (images.length > 1) {
    const kids = [];
    for (const u of images.slice(0, 10)) kids.push((await g(`${user}/media`, { image_url: u, is_carousel_item: "true" })).id);
    creation = (await g(`${user}/media`, { media_type: "CAROUSEL", children: kids.join(","), caption: text })).id;
  } else if (images[0]) creation = (await g(`${user}/media`, { image_url: images[0], caption: text })).id;
  else fail(400, "Instagram needs a photo or video");
  // A video is processed before it can go up.
  for (let i = 0; video && i < 40; i++) {
    const s = await json(await fetch(`https://graph.instagram.com/v21.0/${creation}?fields=status_code&access_token=${encodeURIComponent(t.access_token)}`));
    if (s.status_code === "FINISHED") break;
    if (s.status_code === "ERROR") fail(502, "Instagram couldn't process the video");
    await wait(5000);
  }
  const pub = await g(`${user}/media_publish`, { creation_id: creation });
  const link = await json(await fetch(`https://graph.instagram.com/v21.0/${pub.id}?fields=permalink&access_token=${encodeURIComponent(t.access_token)}`));
  return { url: link.permalink || "" };
}

async function postThreads({ text, images = [], video }) {
  const t = await token("threads");
  const g = async (path, params) => {
    const d = await json(await fetch(`https://graph.threads.net/v1.0/${path}`, { method: "POST", body: form({ ...params, access_token: t.access_token }) }));
    if (d.error) fail(502, `Threads: ${d.error.message}`);
    return d;
  };
  const body = String(text || "").slice(0, 500);
  let id;
  if (video) id = (await g("me/threads", { media_type: "VIDEO", video_url: video, text: body })).id;
  else if (images.length > 1) {
    const kids = [];
    for (const u of images.slice(0, 10)) kids.push((await g("me/threads", { media_type: "IMAGE", image_url: u, is_carousel_item: "true" })).id);
    id = (await g("me/threads", { media_type: "CAROUSEL", children: kids.join(","), text: body })).id;
  } else if (images[0]) id = (await g("me/threads", { media_type: "IMAGE", image_url: images[0], text: body })).id;
  else id = (await g("me/threads", { media_type: "TEXT", text: body })).id;
  await wait(video ? 30000 : 3000);   // Threads asks for a pause before publishing
  const pub = await g("me/threads_publish", { creation_id: id });
  const link = await json(await fetch(`https://graph.threads.net/v1.0/${pub.id}?fields=permalink&access_token=${encodeURIComponent(t.access_token)}`));
  return { url: link.permalink || "" };
}

// TikTok: a video, into the app's inbox as a draft or posted straight away.
async function postTikTok({ text, video, mode = "draft" }) {
  if (!video) fail(400, "TikTok needs a video");
  const t = await token("tiktok");
  const call = async (path, body) => {
    const r = await fetch(`https://open.tiktokapis.com${path}`, { method: "POST", headers: { Authorization: `Bearer ${t.access_token}`, "Content-Type": "application/json; charset=UTF-8" }, body: JSON.stringify(body || {}) });
    const d = await json(r);
    if (!r.ok || (d.error?.code && d.error.code !== "ok")) fail(502, `TikTok: ${d.error?.message || d.error?.code || r.status}`);
    return d.data || {};
  };
  const { buf } = await download(video);
  const size = buf.length, CHUNK = 10 * 1024 * 1024;
  const chunk = size <= CHUNK ? size : CHUNK, count = Math.max(1, Math.floor(size / chunk));
  const source_info = { source: "FILE_UPLOAD", video_size: size, chunk_size: chunk, total_chunk_count: count };
  let init, privacy = "";
  if (mode === "post") {
    const info = await call("/v2/post/publish/creator_info/query/");
    const opts = info.privacy_level_options || ["SELF_ONLY"];
    privacy = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"].find(p => opts.includes(p)) || opts[0];
    init = await call("/v2/post/publish/video/init/", { post_info: { title: String(text || "").slice(0, 2200), privacy_level: privacy }, source_info });
  } else init = await call("/v2/post/publish/inbox/video/init/", { source_info });
  for (let i = 0; i < count; i++) {
    const start = i * chunk, end = i === count - 1 ? size : start + chunk;
    const r = await fetch(init.upload_url, { method: "PUT", headers: { "Content-Type": "video/mp4", "Content-Length": String(end - start), "Content-Range": `bytes ${start}-${end - 1}/${size}` }, body: buf.subarray(start, end) });
    if (!r.ok && r.status !== 206) fail(502, `TikTok upload failed (${r.status})`);
  }
  return { url: "", note: mode === "post" ? (privacy === "SELF_ONLY" ? "posted privately — TikTok hasn't reviewed the app yet" : "posted") : "in your TikTok inbox — finish and post it in the app", publish_id: init.publish_id };
}

// YouTube: a vertical video under 3 minutes is a Short; #Shorts in the title helps it along.
async function postYouTube({ title, text, video }) {
  if (!video) fail(400, "YouTube needs a video");
  const t = await token("youtube");
  const { buf, type } = await download(video);
  const name = String(title || text || "Earth Editions").replace(/\s+/g, " ").trim().slice(0, 90);
  const meta = { snippet: { title: /#shorts/i.test(name) ? name : `${name.slice(0, 91)} #Shorts`, description: String(text || "").slice(0, 4900), categoryId: "26" },
    status: { privacyStatus: "public", selfDeclaredMadeForKids: false } };
  const start = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", { method: "POST",
    headers: { Authorization: `Bearer ${t.access_token}`, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Length": String(buf.length), "X-Upload-Content-Type": type || "video/mp4" }, body: JSON.stringify(meta) });
  if (!start.ok) fail(502, `YouTube: ${(await json(start)).error?.message || start.status}`);
  const up = await fetch(start.headers.get("location"), { method: "PUT", headers: { "Content-Type": type || "video/mp4" }, body: buf });
  const d = await json(up);
  if (!up.ok) fail(502, `YouTube: ${d.error?.message || up.status}`);
  return { url: `https://youtube.com/shorts/${d.id}`, note: d.status?.privacyStatus && d.status.privacyStatus !== "public" ? `uploaded as ${d.status.privacyStatus} — Google keeps uploads private until the app is verified` : "" };
}

// Pinterest: a pin with a link back to the piece, on the board chosen (or the first).
async function postPinterest({ title, text, images = [], link, board }) {
  if (!images[0]) fail(400, "Pinterest needs a photo");
  const t = await token("pinterest");
  const h = { Authorization: `Bearer ${t.access_token}`, "Content-Type": "application/json" };
  let board_id = board;
  if (!board_id) board_id = (await json(await fetch("https://api.pinterest.com/v5/boards?page_size=1", { headers: h }))).items?.[0]?.id;
  if (!board_id) fail(400, "Make a board on Pinterest first");
  const r = await fetch("https://api.pinterest.com/v5/pins", { method: "POST", headers: h, body: JSON.stringify({
    board_id, title: String(title || "").slice(0, 100), description: String(text || "").slice(0, 500), link: link || undefined,
    media_source: images.length > 1 ? { source_type: "multiple_image_urls", items: images.slice(0, 5).map(url => ({ url })) } : { source_type: "image_url", url: images[0] } }) });
  const d = await json(r);
  if (!r.ok) fail(502, `Pinterest: ${d.message || r.status}`);
  return { url: d.id ? `https://www.pinterest.com/pin/${d.id}/` : "" };
}

// X: text with up to four photos (free tier).
async function postX({ text, images = [] }) {
  const t = await token("x");
  const media_ids = [];
  for (const u of images.slice(0, 4)) {
    try {
      const { buf, type } = await download(u);
      const fd = new FormData();
      fd.append("media", new Blob([buf], { type: type || "image/jpeg" }), "photo.jpg");
      fd.append("media_category", "tweet_image");
      const d = await json(await fetch("https://api.x.com/2/media/upload", { method: "POST", headers: { Authorization: `Bearer ${t.access_token}` }, body: fd }));
      const id = d.data?.id || d.media_id_string;
      if (id) media_ids.push(String(id));
    } catch { /* goes without that photo */ }
  }
  const r = await fetch("https://api.x.com/2/tweets", { method: "POST", headers: { Authorization: `Bearer ${t.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: String(text || "").slice(0, 280), ...(media_ids.length ? { media: { media_ids } } : {}) }) });
  const d = await json(r);
  if (!r.ok) fail(502, `X: ${d.detail || d.title || r.status}`);
  return { url: `https://x.com/i/web/status/${d.data?.id}`, note: images.length && !media_ids.length ? "posted without photos — X wouldn't take them" : "" };
}

const POST = { instagram: postInstagram, threads: postThreads, tiktok: postTikTok, youtube: postYouTube, pinterest: postPinterest, x: postX };

/* ── reading: Instagram posts, Reddit threads ────────────────────────────── */
async function igMedia() {
  const t = await token("instagram");
  const d = await json(await fetch(`https://graph.instagram.com/v21.0/me/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,children{media_url,media_type}&limit=30&access_token=${encodeURIComponent(t.access_token)}`));
  if (d.error) fail(502, `Instagram: ${d.error.message}`);
  return d.data || [];
}

const SUBS = ["crystals", "MineralCollectors", "Rockhounds", "whatsthisrock", "mineralporn", "CrystalCollectors"];
async function redditSearch(terms) {
  let auth = {};
  if (env("REDDIT_CLIENT_ID")) {
    const tk = await json(await fetch("https://www.reddit.com/api/v1/access_token", { method: "POST",
      headers: { Authorization: basic(env("REDDIT_CLIENT_ID"), env("REDDIT_CLIENT_SECRET")), "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "web:earth-editions-erp:1.0" }, body: form({ grant_type: "client_credentials" }) }));
    if (tk.access_token) auth = { Authorization: `Bearer ${tk.access_token}` };
  }
  const host = auth.Authorization ? "https://oauth.reddit.com" : "https://www.reddit.com";
  const q = terms.slice(0, 12).map(s => `"${s}"`).join(" OR ");
  const r = await fetch(`${host}/r/${SUBS.join("+")}/search${auth.Authorization ? "" : ".json"}?q=${encodeURIComponent(q)}&restrict_sr=1&sort=new&t=week&limit=40`, { headers: { ...auth, "User-Agent": "web:earth-editions-erp:1.0" } });
  if (!r.ok) fail(502, r.status === 403 || r.status === 429 ? "Reddit blocked the search — add REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET (a free 'script' app at reddit.com/prefs/apps)" : `Reddit: ${r.status}`);
  const d = await json(r);
  return (d.data?.children || []).map(c => c.data).map(p => ({
    id: p.id, sub: p.subreddit, title: p.title, text: String(p.selftext || "").slice(0, 600), url: `https://www.reddit.com${p.permalink}`,
    image: p.preview?.images?.[0]?.source?.url?.replace(/&amp;/g, "&") || (/\.(jpe?g|png|webp)$/i.test(p.url || "") ? p.url : ""),
    comments: p.num_comments, at: new Date(p.created_utc * 1000).toISOString(),
  }));
}

/* ── the journal: a post on eartheditions.co, committed to the store's repo ─ */
const GH = "https://api.github.com/repos/manavjhaveri5/earth-store/contents";
async function gh(path, opts = {}) {
  const r = await fetch(`${GH}/${path}`, { ...opts, headers: { Authorization: `Bearer ${env("GITHUB_BLOG_TOKEN")}`, Accept: "application/vnd.github+json", "User-Agent": "earth-editions-erp", ...(opts.headers || {}) } });
  const d = await json(r);
  if (!r.ok) fail(502, `GitHub: ${d.message || r.status}`);
  return d;
}
async function publishJournal(post) {
  if (!env("GITHUB_BLOG_TOKEN")) fail(400, "Add GITHUB_BLOG_TOKEN in Vercel (contents: write on earth-store)");
  const slug = String(post.slug || post.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70);
  if (!slug || !post.title || !post.body) fail(400, "A post needs a title and a body");
  const q = s => JSON.stringify(String(s || ""));
  const file = `export default {\n  slug: ${q(slug)},\n  title: ${q(post.title)},\n  description: ${q(post.description)},\n  date: ${q(post.date || new Date().toISOString().slice(0, 10))},\n  stones: ${JSON.stringify(post.stones || [])},\n  body: \`\n${String(post.body).replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}\n\`,\n};\n`;
  const b64 = s => Buffer.from(s, "utf8").toString("base64");
  let existing = null;
  try { existing = await gh(`content/blog/${slug}.js`); } catch { /* new */ }
  await gh(`content/blog/${slug}.js`, { method: "PUT", body: JSON.stringify({ message: `Journal: ${post.title}`, content: b64(file), ...(existing?.sha ? { sha: existing.sha } : {}) }) });
  if (!existing) {
    const idx = await gh("content/blog/index.js");
    const src = Buffer.from(idx.content, "base64").toString("utf8");
    const v = `p_${slug.replace(/-/g, "_")}`;
    if (!src.includes(`"./${slug}.js"`)) {
      const next = src.replace(/(\nexport default \[)/, `import ${v} from "./${slug}.js";\n$1`).replace(/\n\];\s*$/, `\n  ${v},\n];\n`);
      await gh("content/blog/index.js", { method: "PUT", body: JSON.stringify({ message: `Journal: list ${slug}`, content: b64(next), sha: idx.sha }) });
    }
  }
  return { url: `https://eartheditions.co/blog/${slug}`, slug };
}

/* ── autopilot ───────────────────────────────────────────────────────────────
   Run every 15 minutes by .github/workflows/social-autopost.yml (with the
   shared store secret). Three jobs, each switched on in Social → Autopilot:
   - posts scheduled from Compose go out when their time comes;
   - a piece that went live in Listing Manager is posted, after a wait, to
     the platforms picked, with captions written for each;
   - a new Instagram post or Reel is sent on to the platforms picked.
   A few at a time, so one run never outlasts the function. */
const AUTO_KEY = "ng-social-auto-v1", QUEUE_KEY = "ng-social-queue-v1";
const AUTO_DEFAULT = {
  listings: { on: false, platforms: ["instagram", "pinterest", "threads"], afterHours: 1, since: null },
  instagram: { on: false, platforms: ["tiktok", "youtube"], since: null },
};
async function autoSettings() { const a = await appData(AUTO_KEY); return { listings: { ...AUTO_DEFAULT.listings, ...(a?.listings || {}) }, instagram: { ...AUTO_DEFAULT.instagram, ...(a?.instagram || {}) } }; }
const saveData = (key, value) => sb().from("app_data").upsert({ key, value });

const VOICE = "You write for Earth Editions (eartheditions.co), a family business in India selling natural crystals, mineral specimens and gemstone carvings, bought as rough at the source and cut in house. Warm, knowledgeable, plain English, no hype. Metaphysical meaning only as tradition or belief, never a health claim. Never invent a locality, weight, size or treatment that isn't given.";
async function captionsFor(l, link) {
  const key = env("OPENAI_KEY") || env("OPENAI_API_KEY");
  if (!key) fail(400, "No OpenAI key for writing captions");
  const facts = [`Piece: ${l.title}`, l.material && `Stone: ${l.material}`, l.shape && `Shape: ${l.shape}`, l.origin && `Origin: ${l.origin}`, l.size && `Size: ${l.size}`, l.weight && `Weight: ${l.weight}`,
    l.description && `Listing description: ${String(l.description).slice(0, 1000)}`, link && `Link: ${link}`].filter(Boolean).join("\n");
  const r = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: env("SOCIAL_AI_MODEL") || "gpt-4.1-mini", max_tokens: 2000, response_format: { type: "json_object" }, messages: [{ role: "system", content: VOICE }, { role: "user", content:
      `Social posts for this piece, one per platform in its own style.\n\n${facts}\n\nReturn JSON: {"instagram":"3 short paragraphs then 8-15 hashtags, 'link in bio'","tiktok":"1-2 lines + 4-6 hashtags","youtube_title":"under 80 chars","youtube":"2-3 lines, the link, 3 hashtags","pinterest_title":"under 100 chars","pinterest":"under 450 chars, keyword-rich","threads":"under 450 chars, 1-2 hashtags","x":"under 250 chars incl. the link, 1-2 hashtags"}` }] }) });
  const d = await json(r);
  if (!r.ok) fail(502, `AI: ${d.error?.message || r.status}`);
  return JSON.parse(d.choices?.[0]?.message?.content || "{}");
}
const storeLink = l => { const s = l.platforms?.store; const u = s?.storefront_url || s?.url || ""; return u ? `${u}${u.includes("?") ? "&" : "?"}utm_source=social&utm_medium=autopilot` : ""; };
const wentLive = l => Math.min(...Object.values(l.platforms || {}).filter(x => x?.status === "active").map(x => Date.parse(x.live_at || x.first_listed_at || "") || Infinity));
const payloadFor = (k, l, cap, link) => ({
  text: cap[k] || "", title: k === "youtube" ? cap.youtube_title : k === "pinterest" ? cap.pinterest_title : l.title,
  images: (l.images || []).filter(u => typeof u === "string" && /^https?:/.test(u)).slice(0, 10),
  video: ["tiktok", "youtube", "instagram", "threads"].includes(k) && l.video && /^https?:/.test(l.video) ? l.video : "",
  link, mode: k === "tiktok" ? "draft" : "", source: `listing:${l.id}`,
});
const canTake = (k, pl) => !((k === "tiktok" || k === "youtube") && !pl.video) && !(k === "pinterest" && (!pl.images.length || !pl.link)) && !(k !== "threads" && k !== "x" && !pl.images.length && !pl.video);

async function runAutopilot() {
  const done = [], started = Date.now(), budget = 200000;
  const time = () => Date.now() - started < budget;
  const connected = async k => !!(await getSecret(`tok_${k}`))?.access_token;

  // 1. Scheduled posts that are due.
  const queue = (await appData(QUEUE_KEY)) || [];
  for (const q of queue.filter(x => x.status === "pending" && Date.parse(x.at) <= Date.now()).slice(0, 4)) {
    if (!time()) break;
    try { const out = await POST[q.platform](q.payload); Object.assign(q, { status: "done", url: out.url || "", note: out.note || "", done_at: new Date().toISOString() }); await addLog({ platform: q.platform, source: q.payload.source || "", title: q.payload.title || "", url: out.url || "", note: `scheduled${out.note ? ` · ${out.note}` : ""}` }); }
    catch (e) { Object.assign(q, { status: "failed", error: e.message, done_at: new Date().toISOString() }); }
    done.push(`${q.platform}: ${q.status}`);
  }
  if (done.length) await saveData(QUEUE_KEY, queue);

  const auto = await autoSettings();
  const log = await readLog();
  const posted = new Set(log.map(e => `${e.source}|${e.platform}`));

  // 2. Pieces that went live since autopilot was switched on, after the wait.
  if (auto.listings.on && time()) {
    const listings = (await appData("ng-listings-v1")) || [];
    const since = Date.parse(auto.listings.since || "") || Date.now();
    const ready = listings.filter(l => { const t = wentLive(l); return t > since && Date.now() - t >= (+auto.listings.afterHours || 0) * 36e5; })
      .filter(l => auto.listings.platforms.some(k => !posted.has(`listing:${l.id}|${k}`)));
    for (const l of ready.slice(0, 2)) {
      if (!time()) break;
      const link = storeLink(l);
      let cap;
      try { cap = await captionsFor(l, link); } catch (e) { done.push(`captions for ${l.title}: ${e.message}`); continue; }
      for (const k of auto.listings.platforms) {
        if (posted.has(`listing:${l.id}|${k}`) || !(await connected(k)) || !time()) continue;
        const pl = payloadFor(k, l, cap, link);
        if (!canTake(k, pl)) { await addLog({ platform: k, source: `listing:${l.id}`, title: l.title, note: "autopilot skipped — not the right media" }); continue; }
        try { const out = await POST[k](pl); await addLog({ platform: k, source: pl.source, title: l.title, url: out.url || "", note: `autopilot${out.note ? ` · ${out.note}` : ""}` }); done.push(`${k}: ${l.title}`); }
        catch (e) { await addLog({ platform: k, source: pl.source, title: l.title, note: `autopilot failed: ${e.message}` }); done.push(`${k} failed: ${e.message}`); }
      }
    }
  }

  // 3. New Instagram posts, sent on.
  if (auto.instagram.on && time() && await connected("instagram")) {
    const since = Date.parse(auto.instagram.since || "") || Date.now();
    const media = (await igMedia()).filter(m => Date.parse(m.timestamp) > since);
    for (const m of media.slice(0, 2)) {
      for (const k of auto.instagram.platforms) {
        const vid = m.media_type === "VIDEO";
        if (posted.has(`ig:${m.id}|${k}`) || !time() || !(await connected(k))) continue;
        if ((k === "tiktok" || k === "youtube") && !vid) continue;
        if (k === "pinterest" && vid) continue;
        const caption = m.caption || "";
        const images = vid ? [] : m.media_type === "CAROUSEL_ALBUM" ? (m.children?.data || []).filter(c => c.media_type === "IMAGE").map(c => c.media_url) : [m.media_url];
        try {
          const out = await POST[k]({ text: k === "x" ? caption.slice(0, 270) : caption, title: caption.split("\n")[0].slice(0, 90), images, video: vid ? m.media_url : "", mode: k === "tiktok" ? "draft" : "", link: "https://eartheditions.co" });
          await addLog({ platform: k, source: `ig:${m.id}`, title: caption.split("\n")[0].slice(0, 80), url: out.url || "", note: `autopilot${out.note ? ` · ${out.note}` : ""}` });
          done.push(`${k}: Instagram ${m.id}`);
        } catch (e) { await addLog({ platform: k, source: `ig:${m.id}`, title: caption.split("\n")[0].slice(0, 80), note: `autopilot failed: ${e.message}` }); }
      }
    }
  }
  return done;
}

/* ── handler ─────────────────────────────────────────────────────────────── */
export default async function handler(req, res) {
  const u = new URL(req.url, "http://x");
  const body = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : req.body || {};
  const action = u.searchParams.get("action") || body.action;
  const p = u.searchParams.get("p") || body.p;
  try {
    /* Back from a platform's login: no ERP session on this request, so the
       one-time state is what proves it's ours. */
    if (action === "callback") {
      const back = msg => { res.statusCode = 302; res.setHeader("Location", `/?social=${encodeURIComponent(msg)}`); res.end(); };
      const want = await getSecret(`state_${p}`);
      await setSecret(`state_${p}`, null);
      if (!P[p] || !u.searchParams.get("code") || !want || want.state !== u.searchParams.get("state") || Date.now() > want.until) return back(`${p}: login didn't finish — try Connect again`);
      try {
        const t = await P[p].token(req, u.searchParams.get("code"), want.verifier);
        await setSecret(`tok_${p}`, t);
        return back(`${p[0].toUpperCase() + p.slice(1)} connected${t.name ? ` (${t.name})` : ""}`);
      } catch (e) { return back(`${p}: ${e.message}`); }
    }

    // The scheduled run (GitHub Actions, every 15 minutes) comes with the store secret.
    if (action === "cron") {
      if (!hasStoreSecret(req) && !(await requireUser(req, res))) return;
      return res.json({ ok: true, done: await runAutopilot() });
    }

    if (!(await requireUser(req, res))) return;

    if (action === "auto_get") return res.json({ auto: await autoSettings(), queue: (await appData(QUEUE_KEY)) || [] });
    if (action === "auto_set") {
      const cur = await autoSettings(), next = body.auto || {};
      // Switching a job on starts it from now: nothing older is posted.
      for (const k of ["listings", "instagram"]) if (next[k]?.on && !cur[k].on) next[k].since = new Date().toISOString();
      const merged = { listings: { ...cur.listings, ...(next.listings || {}) }, instagram: { ...cur.instagram, ...(next.instagram || {}) } };
      await saveData(AUTO_KEY, merged);
      return res.json({ auto: merged });
    }
    // Scheduled posts from Compose: one row per platform.
    if (action === "schedule") {
      const queue = (await appData(QUEUE_KEY)) || [];
      if (!Date.parse(body.at)) fail(400, "When?");
      const rows = (body.items || []).filter(i => POST[i.platform]).map(i => ({ id: crypto.randomUUID(), at: new Date(body.at).toISOString(), platform: i.platform, payload: i.payload, status: "pending", created: new Date().toISOString() }));
      const keep = queue.filter(q => q.status === "pending" || Date.now() - Date.parse(q.done_at || q.at) < 30 * 864e5);
      await saveData(QUEUE_KEY, [...keep, ...rows]);
      return res.json({ ok: true, added: rows.length });
    }
    if (action === "unschedule") {
      const queue = (await appData(QUEUE_KEY)) || [];
      await saveData(QUEUE_KEY, queue.filter(q => q.id !== body.id));
      return res.json({ ok: true });
    }

    if (action === "status") {
      const out = {};
      for (const k of Object.keys(P)) {
        // The first version kept these under other names.
        let t = await getSecret(`tok_${k}`);
        if (!t && (k === "instagram" || k === "tiktok")) {
          const old = await getSecret(k === "instagram" ? "ig_token" : "tt_token");
          if (old?.access_token) { t = { ...old, name: old.name || (old.username ? `@${old.username}` : "") }; await setSecret(`tok_${k}`, t); }
        }
        out[k] = { ready: ready(k), connected: !!t?.access_token, name: t?.name || "", redirect: redirectUri(req, k), canPost: k !== "tiktok" || /video\.publish/.test(t?.scope || "") };
      }
      out.reddit = { ready: !!env("REDDIT_CLIENT_ID") };
      out.journal = { ready: !!env("GITHUB_BLOG_TOKEN") };
      return res.json(out);
    }

    if (action === "start") {
      if (!P[p]) fail(400, "Which platform?");
      if (!ready(p)) fail(400, `Add ${P[p].keys.join(" and ")} in Vercel first`);
      const state = crypto.randomBytes(16).toString("hex");
      const verifier = P[p].pkce ? crypto.randomBytes(32).toString("base64url") : "";
      const challenge = verifier ? crypto.createHash("sha256").update(verifier).digest("base64url") : "";
      await setSecret(`state_${p}`, { state, verifier, until: Date.now() + 600000 });
      return res.json({ url: P[p].login(req, state, challenge) });
    }

    if (action === "disconnect") { await setSecret(`tok_${p}`, null); return res.json({ ok: true }); }

    if (action === "log") return res.json({ log: await readLog() });

    if (action === "instagram_media") {
      const [media, log] = await Promise.all([igMedia(), readLog()]);
      return res.json({ media: media.map(m => ({ ...m, sent: log.filter(e => e.source === `ig:${m.id}`) })) });
    }

    if (action === "pinterest_boards") {
      const t = await token("pinterest");
      const d = await json(await fetch("https://api.pinterest.com/v5/boards?page_size=100", { headers: { Authorization: `Bearer ${t.access_token}` } }));
      return res.json({ boards: (d.items || []).map(b => ({ id: b.id, name: b.name })) });
    }

    /* Post to one platform. body: { p, text, title, images[], video, link,
       board, mode, source } — media as public URLs. An Instagram source
       ("ig:<id>") is read fresh, since Instagram's media links expire. */
    if (action === "post") {
      if (!POST[p]) fail(400, "Which platform?");
      let { images = [], video = "" } = body;
      if (String(body.source || "").startsWith("ig:")) {
        const m = (await igMedia()).find(x => `ig:${x.id}` === body.source);
        if (!m) fail(404, "That Instagram post isn't in the recent ones");
        if (m.media_type === "VIDEO") { video = m.media_url; images = m.thumbnail_url ? [m.thumbnail_url] : []; }
        else if (m.media_type === "CAROUSEL_ALBUM") images = (m.children?.data || []).filter(c => c.media_type === "IMAGE").map(c => c.media_url);
        else images = [m.media_url];
      }
      const out = await POST[p]({ ...body, images, video });
      const entry = await addLog({ platform: p, source: body.source || "", title: body.title || "", url: out.url || "", note: out.note || "", mode: body.mode || "" });
      return res.json({ ok: true, ...out, entry });
    }

    if (action === "reddit_search") return res.json({ threads: await redditSearch(Array.isArray(body.terms) ? body.terms : []) });

    if (action === "journal_publish") {
      const out = await publishJournal(body.post || {});
      await addLog({ platform: "journal", title: body.post?.title || "", url: out.url });
      return res.json({ ok: true, ...out });
    }

    fail(400, `Unknown action: ${action}`);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
}
