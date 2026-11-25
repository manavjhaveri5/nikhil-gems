import { waitUntil } from "@vercel/functions";
/* Social: posting to every platform from the ERP, on each platform's own free
   API. One file, because the platforms share most of the work: an OAuth
   login, a token kept safe and refreshed, then "post this media with this
   text".

   Platforms and what each needs in Vercel (each is optional — a platform
   without its keys shows "set up" in the Accounts tab):
     instagram  IG_APP_ID, IG_APP_SECRET (+ IG_CONFIG_ID and IG_USER_ID for Unified login on newer Meta apps)
     threads    THREADS_APP_ID, THREADS_APP_SECRET Meta app, Threads API use case
     tiktok     TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET  Login Kit + Content Posting API
     youtube    GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   Google Cloud, YouTube Data API v3
     pinterest  PINTEREST_APP_ID, PINTEREST_APP_SECRET (+ PINTEREST_SANDBOX_TOKEN while on Trial access)
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
import { isRowKey, readRows } from "../lib/app-rows.js";
import { requireUser, hasStoreSecret, cronKeyOk } from "../lib/auth.js";
import { INSTAGRAM_VOICE, instagramShape, HASHTAG_ENDING } from "../lib/instagramVoice.js";
import { writeWithBest } from "../lib/captionWriter.js";
import { tagPayload } from "../lib/socialLinks.js";

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
  if (isRowKey(key)) return readRows(sb(), key);
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
// TikTok refuses a redirect URI with a query string, so it comes back on a
// plain path that vercel.json (and deploy.py's routes) rewrite to this one.
// TikTok, Pinterest and Instagram want redirect URLs without ?params, so they get clean paths (rewrites in vercel.json).
const CLEAN_CALLBACK = new Set(["tiktok", "pinterest", "instagram"]);
const redirectUri = (req, p) => CLEAN_CALLBACK.has(p) ? `${site(req)}/api/${p}-callback` : `${site(req)}/api/social?action=callback&p=${p}`;

/* ── the platforms ───────────────────────────────────────────────────────── */
// login: how to send someone to the platform's login. token: code → tokens.
// refresh: an expiring token → a fresh one. who: the account's name.
// Unified login: code → a business token that doesn't expire; the Instagram account comes from the token's granted targets.
const FB = "https://graph.facebook.com/v21.0";
async function unifiedInstagramToken(req, code) {
  const q = new URLSearchParams({ client_id: env("IG_APP_ID"), client_secret: env("IG_APP_SECRET"), redirect_uri: redirectUri(req, "instagram"), code });
  const s = await json(await fetch(`${FB}/oauth/access_token?${q}`));
  if (!s.access_token) fail(400, s.error?.message || "no token");
  const at = encodeURIComponent(s.access_token);
  const get = async path => json(await fetch(`${FB}/${path}${path.includes("?") ? "&" : "?"}access_token=${at}`));
  // Which Instagram account the token covers: try the granted targets, then pages, then the business's accounts.
  // A system-user token can't list its accounts, so the account id is set once (IG_USER_ID, from Business Suite → Instagram accounts).
  const cands = env("IG_USER_ID") ? [env("IG_USER_ID")] : [];
  const dbg = await json(await fetch(`${FB}/debug_token?input_token=${at}&access_token=${encodeURIComponent(`${env("IG_APP_ID")}|${env("IG_APP_SECRET")}`)}`));
  for (const g of dbg.data?.granular_scopes || []) if (/^instagram_/.test(g.scope)) cands.push(...(g.target_ids || []));
  const pages = await get("me/accounts?fields=instagram_business_account");
  cands.push(...(pages.data || []).map(x => x.instagram_business_account?.id).filter(Boolean));
  const biz = await get("me/businesses?fields=id");
  for (const b of biz.data || []) {
    for (const edge of ["owned_instagram_accounts", "instagram_business_accounts", "client_instagram_assets"]) {
      const r = await get(`${b.id}/${edge}?fields=id,username`);
      cands.push(...(r.data || []).map(x => x.id));
    }
  }
  let user_id = "", me = {};
  for (const id of [...new Set(cands)]) {
    const m = await get(`${id}?fields=id,username`);
    if (m.username) { user_id = m.id || id; me = m; if (/eartheditions/i.test(m.username)) break; }
  }
  if (!user_id) {
    const sc = (dbg.data?.granular_scopes || []).map(g => `${g.scope}${g.target_ids ? `[${g.target_ids.length}]` : ""}`).join(",");
    fail(400, `No Instagram account found on the login (type ${dbg.data?.type || "?"}; scopes ${sc || dbg.data?.scopes?.join(",") || "none"}; pages ${(pages.data || []).length}; businesses ${(biz.data || []).length}; tried ${cands.length}${pages.error ? `; ${pages.error.message}` : ""})`);
  }
  try { await linkFacebookPage(s.access_token); } catch (e) { console.warn(e.message); } // the Page is optional
  return { access_token: s.access_token, host: FB, user_id, refreshed_at: Date.now(), name: me.username ? `@${me.username}` : "" };
}

const P = {
  instagram: {
    keys: ["IG_APP_ID", "IG_APP_SECRET"],
    // New Meta apps get "Unified login" (Facebook Login for Business + a configuration, IG_CONFIG_ID). Older apps use Instagram Login.
    login: (req, state) => env("IG_CONFIG_ID")
      ? `https://www.facebook.com/v21.0/dialog/oauth?client_id=${env("IG_APP_ID")}&config_id=${env("IG_CONFIG_ID")}&redirect_uri=${encodeURIComponent(redirectUri(req, "instagram"))}&response_type=code&override_default_response_type=true&state=${state}`
      : `https://www.instagram.com/oauth/authorize?client_id=${env("IG_APP_ID")}&redirect_uri=${encodeURIComponent(redirectUri(req, "instagram"))}&response_type=code&scope=${encodeURIComponent("instagram_business_basic,instagram_business_content_publish")}&state=${state}`,
    async token(req, code) {
      if (env("IG_CONFIG_ID")) return unifiedInstagramToken(req, code);
      const s = await json(await fetch("https://api.instagram.com/oauth/access_token", { method: "POST", body: form({ client_id: env("IG_APP_ID"), client_secret: env("IG_APP_SECRET"), grant_type: "authorization_code", redirect_uri: redirectUri(req, "instagram"), code }) }));
      if (!s.access_token) fail(400, s.error_message || "no token");
      const l = await json(await fetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(env("IG_APP_SECRET"))}&access_token=${encodeURIComponent(s.access_token)}`));
      const access_token = l.access_token || s.access_token;
      const me = await json(await fetch(`https://graph.instagram.com/v21.0/me?fields=user_id,username&access_token=${encodeURIComponent(access_token)}`));
      return { access_token, expires_at: Date.now() + (l.expires_in || 3600) * 1000, refreshed_at: Date.now(), user_id: me.user_id || me.id || s.user_id, name: me.username ? `@${me.username}` : "" };
    },
    async refresh(t) {
      if (t.host || Date.now() - (t.refreshed_at || 0) < 864e5) return t; // Unified-login tokens don't expire.
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
    login: (req, state) => `https://www.tiktok.com/v2/auth/authorize/?client_key=${env("TIKTOK_CLIENT_KEY")}&scope=${encodeURIComponent(TT_SCOPES)}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri(req, "tiktok"))}&state=${state}&disable_auto_auth=1`, // always show what is being granted
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
    login: (req, state) => `https://accounts.google.com/o/oauth2/v2/auth?client_id=${env("GOOGLE_CLIENT_ID")}&redirect_uri=${encodeURIComponent(redirectUri(req, "youtube"))}&response_type=code&scope=${encodeURIComponent("https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube")}&access_type=offline&prompt=consent&state=${state}`,
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
    login: (req, state) => `https://www.pinterest.com/oauth/?client_id=${env("PINTEREST_APP_ID")}&redirect_uri=${encodeURIComponent(redirectUri(req, "pinterest"))}&response_type=code&scope=${encodeURIComponent("boards:read,boards:write,pins:read,pins:write,user_accounts:read")}&state=${state}`,
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
  /* Reddit, logged in as the account that posts. Only ever posts what's been
     approved in Social → Calendar (never on its own). A "web app" at
     reddit.com/prefs/apps; the same keys also do the read-only search. */
  reddit: {
    keys: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"],
    login: (req, state) => `https://www.reddit.com/api/v1/authorize?client_id=${env("REDDIT_CLIENT_ID")}&response_type=code&state=${state}&redirect_uri=${encodeURIComponent(redirectUri(req, "reddit"))}&duration=permanent&scope=${encodeURIComponent("identity submit read flair")}`,
    async token(req, code) {
      const d = await json(await fetch("https://www.reddit.com/api/v1/access_token", { method: "POST", headers: { Authorization: basic(env("REDDIT_CLIENT_ID"), env("REDDIT_CLIENT_SECRET")), "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
        body: form({ grant_type: "authorization_code", code, redirect_uri: redirectUri(req, "reddit") }) }));
      if (!d.access_token) fail(400, d.error || "no token");
      let name = "";
      try { name = "u/" + ((await json(await fetch("https://oauth.reddit.com/api/v1/me", { headers: { Authorization: `Bearer ${d.access_token}`, "User-Agent": UA } }))).name || ""); } catch { /* none */ }
      return { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + (d.expires_in || 3600) * 1000, name: name === "u/" ? "" : name };
    },
    async refresh(t) {
      if (Date.now() < (t.expires_at || 0) - 120000) return t;
      const d = await json(await fetch("https://www.reddit.com/api/v1/access_token", { method: "POST", headers: { Authorization: basic(env("REDDIT_CLIENT_ID"), env("REDDIT_CLIENT_SECRET")), "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
        body: form({ grant_type: "refresh_token", refresh_token: t.refresh_token }) }));
      if (!d.access_token) fail(401, "Reddit's login has run out — connect it again");
      return { ...t, access_token: d.access_token, expires_at: Date.now() + (d.expires_in || 3600) * 1000 };
    },
  },
};
// What the ERP asks TikTok for: posting, plus the profile, follower counts and
// video list the Insights tab shows. Each must be switched on in the developer app.
const TT_SCOPES = "user.info.basic,user.info.profile,user.info.stats,video.list,video.upload,video.publish";

// TikTok insights: the account's counts and its recent videos with views, likes,
// comments and shares. Needs the Display API scopes; says which are missing.
async function tiktokStats(cursor) {
  const t = await token("tiktok");
  const H = { Authorization: `Bearer ${t.access_token}` };
  const need = ["user.info.profile", "user.info.stats", "video.list"].filter(s => !(t.scope || "").includes(s));
  const uf = "open_id,avatar_url,display_name,username,bio_description,profile_deep_link,is_verified,follower_count,following_count,likes_count,video_count";
  const u = await json(await fetch(`https://open.tiktokapis.com/v2/user/info/?fields=${uf}`, { headers: H }));
  const vf = "id,title,video_description,cover_image_url,share_url,embed_link,duration,create_time,view_count,like_count,comment_count,share_count";
  const vr = await fetch(`https://open.tiktokapis.com/v2/video/list/?fields=${vf}`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ max_count: 20, ...(cursor ? { cursor: Number(cursor) } : {}) }) });
  const v = await json(vr);
  const err = [u.error, v.error].filter(e => e?.code && e.code !== "ok").map(e => e.message || e.code);
  return { user: u.data?.user || {}, videos: v.data?.videos || [], cursor: v.data?.cursor || 0, has_more: !!v.data?.has_more, missing: need, errors: [...new Set(err)] };
}

// Where a direct post stands (processing, published, failed) — TikTok works on it after the upload.
async function tiktokPublishStatus(publish_id) {
  const t = await token("tiktok");
  const d = await json(await fetch("https://open.tiktokapis.com/v2/post/publish/status/fetch/", { method: "POST", headers: { Authorization: `Bearer ${t.access_token}`, "Content-Type": "application/json; charset=UTF-8" }, body: JSON.stringify({ publish_id }) }));
  if (d.error?.code && d.error.code !== "ok") fail(502, `TikTok: ${d.error.message || d.error.code}`);
  return d.data || {};
}

const UA = "web:earth-editions-erp:1.0 (by the shop's own account)";
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

// Instagram: one photo, a carousel of up to 10, a Reel, or a Story (one
// photo or video, up for 24 hours; the API can't add stickers or text to it).
/* Two accounts on one system-user token: @eartheditions_ (the token's own) and
   @atyahara (Soniya's planner), found by business discovery on 20 Nov 2026.
   The system user must be given @atyahara in Business Settings to post there. */
const IG_ACCOUNTS = { atyahara: () => env("IG_ATYAHARA_USER_ID") || "17841448177921254" };
async function postInstagram({ text, images = [], video, story = false, account }) {
  const t0 = await token("instagram");
  const t = account && IG_ACCOUNTS[account] ? { ...t0, user_id: IG_ACCOUNTS[account](), name: `@${account}` } : t0;
  const G = t.host || "https://graph.instagram.com/v21.0";
  const g = async (path, params) => {
    const d = await json(await fetch(`${G}/${path}`, { method: "POST", body: form({ ...params, access_token: t.access_token }) }));
    if (d.error) fail(502, `Instagram: ${d.error.message}`);
    return d;
  };
  const user = t.user_id || "me";
  let creation;
  if (story) {
    if (!video && !images[0]) fail(400, "A story needs a photo or a video");
    creation = (await g(`${user}/media`, video ? { media_type: "STORIES", video_url: video } : { media_type: "STORIES", image_url: images[0] })).id;
  } else if (video) creation = (await g(`${user}/media`, { media_type: "REELS", video_url: video, caption: text })).id;
  else if (images.length > 1) {
    const kids = [];
    for (const u of images.slice(0, 10)) kids.push((await g(`${user}/media`, { image_url: u, is_carousel_item: "true" })).id);
    creation = (await g(`${user}/media`, { media_type: "CAROUSEL", children: kids.join(","), caption: text })).id;
  } else if (images[0]) creation = (await g(`${user}/media`, { image_url: images[0], caption: text })).id;
  else fail(400, "Instagram needs a photo or video");
  // A video is processed before it can go up.
  for (let i = 0; video && i < 40; i++) {
    const s = await json(await fetch(`${G}/${creation}?fields=status_code&access_token=${encodeURIComponent(t.access_token)}`));
    if (s.status_code === "FINISHED") break;
    if (s.status_code === "ERROR") fail(502, "Instagram couldn't process the video");
    await wait(5000);
  }
  const pub = await g(`${user}/media_publish`, { creation_id: creation });
  if (story) return { url: `https://www.instagram.com/stories/${(t.name || "@eartheditions_").slice(1)}/`, note: "Story is up for the next 24 hours", id: pub.id };
  const link = await json(await fetch(`${G}/${pub.id}?fields=permalink&access_token=${encodeURIComponent(t.access_token)}`));
  return { url: link.permalink || "" };
}

/* Facebook: the Earth Editions Page (made 23 Nov 2026). It rides on the
   Instagram connection (Unified login): the login's configuration grants
   pages_manage_posts on the Page, and the Page's own token is kept as
   tok_facebook. Linked on each Instagram connect, or by action "fb_link". */
async function linkFacebookPage(userToken) {
  const at = encodeURIComponent(userToken);
  const get = async path => json(await fetch(`${FB}/${path}${path.includes("?") ? "&" : "?"}access_token=${at}`));
  const dbg = await json(await fetch(`${FB}/debug_token?input_token=${at}&access_token=${encodeURIComponent(`${env("IG_APP_ID")}|${env("IG_APP_SECRET")}`)}`));
  const ids = new Set([env("FB_PAGE_ID"), ...(dbg.data?.granular_scopes || []).filter(g => /^pages_/.test(g.scope)).flatMap(g => g.target_ids || [])].filter(Boolean));
  const pages = (await get("me/accounts?fields=id,name,access_token")).data || [];
  for (const id of ids) if (!pages.some(x => x.id === id)) { const x = await get(`${id}?fields=id,name,access_token`); if (x.id) pages.push(x); }
  const page = pages.find(x => env("FB_PAGE_ID") ? x.id === env("FB_PAGE_ID") : /earth\s*editions/i.test(x.name || ""));
  if (!page?.access_token) fail(400, `Facebook: the Earth Editions Page isn't on the login (scopes ${(dbg.data?.granular_scopes || []).map(g => g.scope).filter(s => /^pages_/.test(s)).join(",") || "no pages_*"}; pages seen ${pages.map(x => x.name).join(", ") || "none"})`);
  const t = { access_token: page.access_token, page_id: page.id, name: page.name, host: FB, linked_at: Date.now() };
  await setSecret("tok_facebook", t);
  return t;
}

// A photo, several photos (one post), a video, or text with a link.
async function postFacebook({ text = "", images = [], video, link }) {
  const t = await getSecret("tok_facebook");
  if (!t?.access_token) fail(400, "facebook isn't connected");
  const g = async (path, params) => {
    const d = await json(await fetch(`${FB}/${path}`, { method: "POST", body: form({ ...params, access_token: t.access_token }) }));
    if (d.error) fail(502, `Facebook: ${d.error.message}`);
    return d;
  };
  const page = t.page_id;
  if (video) {
    const d = await g(`${page}/videos`, { file_url: video, description: text });
    return { url: `https://www.facebook.com/${page}/videos/${d.id}`, note: "Facebook processes the video for a few minutes" };
  }
  if (images.length > 1) {
    const ids = [];
    for (const u of images.slice(0, 10)) ids.push((await g(`${page}/photos`, { url: u, published: "false" })).id);
    const params = { message: text };
    ids.forEach((id, i) => { params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
    const d = await g(`${page}/feed`, params);
    return { url: `https://www.facebook.com/${d.id}` };
  }
  if (images[0]) {
    const d = await g(`${page}/photos`, { url: images[0], caption: text });
    return { url: `https://www.facebook.com/${d.post_id || d.id}` };
  }
  if (!text) fail(400, "Facebook needs a photo, a video or some text");
  const d = await g(`${page}/feed`, link ? { message: text, link } : { message: text });
  return { url: `https://www.facebook.com/${d.id}` };
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
async function postTikTok({ text, video, mode = "draft", tt = {} }) {
  if (!video) fail(400, "TikTok needs a video");
  // A direct post goes only with the settings the person chose in Compose
  // (TikTok's sharing guidelines: no privacy level picked for them).
  if (mode === "post" && !tt.privacy_level) fail(400, "Choose who can see the TikTok video first");
  const t = await token("tiktok");
  const call = async (path, body) => {
    const r = await fetch(`https://open.tiktokapis.com${path}`, { method: "POST", headers: { Authorization: `Bearer ${t.access_token}`, "Content-Type": "application/json; charset=UTF-8" }, body: JSON.stringify(body || {}) });
    const d = await json(r);
    if (!r.ok || (d.error?.code && d.error.code !== "ok")) fail(502, `TikTok: ${d.error?.message || r.status}${d.error?.code ? ` (${d.error.code})` : ""}`);
    return d.data || {};
  };
  const { buf } = await download(video);
  const size = buf.length, CHUNK = 10 * 1024 * 1024;
  const chunk = size <= CHUNK ? size : CHUNK, count = Math.max(1, Math.floor(size / chunk));
  const source_info = { source: "FILE_UPLOAD", video_size: size, chunk_size: chunk, total_chunk_count: count };
  let init, privacy = "";
  if (mode === "post") {
    const info = await call("/v2/post/publish/creator_info/query/");
    const opts = info.privacy_level_options || [];
    if (!opts.includes(tt.privacy_level)) fail(400, "That audience isn't available for this TikTok account any more — choose again");
    if (tt.brand_content_toggle && tt.privacy_level === "SELF_ONLY") fail(400, "Branded content can't be private on TikTok");
    privacy = tt.privacy_level;
    const post_info = { title: String(text || "").slice(0, 2200), privacy_level: privacy,
      disable_comment: !!tt.disable_comment || !!info.comment_disabled, disable_duet: !!tt.disable_duet || !!info.duet_disabled, disable_stitch: !!tt.disable_stitch || !!info.stitch_disabled,
      brand_content_toggle: !!tt.brand_content_toggle, brand_organic_toggle: !!tt.brand_organic_toggle };
    // Until TikTok reviews the app it only lets it post to a *private account*
    // (the account itself, not just the video): say so plainly.
    try { init = await call("/v2/post/publish/video/init/", { post_info, source_info }); }
    catch (e) { if (/unaudited_client_can_only_post_to_private_accounts/.test(e.message)) fail(400, "TikTok hasn't reviewed this app yet, so it can only post straight to a private TikTok account. Use \"Send as draft\" (you post it from the TikTok app), or make the account private in TikTok first."); throw e; }
  } else init = await call("/v2/post/publish/inbox/video/init/", { source_info });
  for (let i = 0; i < count; i++) {
    const start = i * chunk, end = i === count - 1 ? size : start + chunk;
    const r = await fetch(init.upload_url, { method: "PUT", headers: { "Content-Type": "video/mp4", "Content-Length": String(end - start), "Content-Range": `bytes ${start}-${end - 1}/${size}` }, body: buf.subarray(start, end) });
    if (!r.ok && r.status !== 206) fail(502, `TikTok upload failed (${r.status})`);
  }
  return { url: "", note: mode === "post" ? "sent — TikTok takes a few minutes to process it" : "in your TikTok inbox — finish and post it in the app", publish_id: init.publish_id };
}

// YouTube: a vertical video under 3 minutes is a Short; #Shorts in the title helps it along.
// privacy "unlisted" (Campaign lots): an ordinary video only the link opens — no #Shorts, a youtu.be link back.
async function postYouTube({ title, text, video, privacy }) {
  if (!video) fail(400, "YouTube needs a video");
  const t = await token("youtube");
  const { buf, type } = await download(video);
  const unlisted = privacy === "unlisted";
  const name = String(title || text || "Earth Editions").replace(/\s+/g, " ").trim().slice(0, 90);
  const meta = { snippet: { title: unlisted || /#shorts/i.test(name) ? name : `${name.slice(0, 91)} #Shorts`, description: String(text || "").slice(0, 4900), categoryId: "26" },
    status: { privacyStatus: unlisted ? "unlisted" : "public", selfDeclaredMadeForKids: false } };
  const start = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", { method: "POST",
    headers: { Authorization: `Bearer ${t.access_token}`, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Length": String(buf.length), "X-Upload-Content-Type": type || "video/mp4" }, body: JSON.stringify(meta) });
  if (!start.ok) fail(502, `YouTube: ${(await json(start)).error?.message || start.status}`);
  const up = await fetch(start.headers.get("location"), { method: "PUT", headers: { "Content-Type": type || "video/mp4" }, body: buf });
  const d = await json(up);
  if (!up.ok) fail(502, `YouTube: ${d.error?.message || up.status}`);
  const want = unlisted ? "unlisted" : "public";
  return { url: unlisted ? `https://youtu.be/${d.id}` : `https://youtube.com/shorts/${d.id}`, id: d.id, note: d.status?.privacyStatus && d.status.privacyStatus !== want ? `uploaded as ${d.status.privacyStatus} — Google keeps uploads private until the app is verified` : "" };
}

// Pinterest: a pin with a link back to the piece, on the board chosen (or the first).
// A multi-photo pin needs every photo the same shape; when they aren't, the
// pin goes up with the first photo alone rather than failing.
async function postPinterest(args) {
  try { return await postPinterestOnce(args); }
  catch (e) {
    if (!(args.images?.length > 1) || !/width\/height|ratio/i.test(e.message || "")) throw e;
    const out = await postPinterestOnce({ ...args, images: args.images.slice(0, 1) });
    return { ...out, note: [out.note, "Posted with the first photo only: the photos are different shapes, and Pinterest needs them all the same for a multi-photo pin"].filter(Boolean).join(". ") };
  }
}
async function postPinterestOnce({ title, text, images = [], link, board }) {
  if (!images[0]) fail(400, "Pinterest needs a photo");
  const t = await token("pinterest");
  const h = { Authorization: `Bearer ${t.access_token}`, "Content-Type": "application/json" };
  let board_id = board;
  if (!board_id) board_id = (await json(await fetch("https://api.pinterest.com/v5/boards?page_size=1", { headers: h }))).items?.[0]?.id;
  if (!board_id) fail(400, "Make a board on Pinterest first");
  const body = id => ({
    board_id: id, title: String(title || "").slice(0, 100), description: String(text || "").slice(0, 500), link: link || undefined,
    media_source: images.length > 1 ? { source_type: "multiple_image_urls", items: images.slice(0, 5).map(url => ({ url })) } : { source_type: "image_url", url: images[0] } });
  const r = await fetch("https://api.pinterest.com/v5/pins", { method: "POST", headers: h, body: JSON.stringify(body(board_id)) });
  const d = await json(r);
  if (!r.ok && /Trial access/i.test(d.message || "")) return pinterestSandbox(h, body(board_id));
  if (!r.ok) fail(502, `Pinterest: ${d.message || r.status}`);
  return { url: d.id ? `https://www.pinterest.com/pin/${d.id}/` : "" };
}

// Trial-access apps may only create pins in Pinterest's sandbox. Used until Standard access is granted; the pin is NOT live.
async function pinterestSandbox(_h, pin) {
  const SB = "https://api-sandbox.pinterest.com/v5";
  if (!env("PINTEREST_SANDBOX_TOKEN")) fail(502, "Pinterest is on Trial access, which can't create live pins. Add a sandbox token (PINTEREST_SANDBOX_TOKEN) to test, or wait for Standard access");
  const h = { Authorization: `Bearer ${env("PINTEREST_SANDBOX_TOKEN")}`, "Content-Type": "application/json" };
  const NAME = "Natural Crystals & Minerals";
  let listErr = "";
  const list = async () => { const d = await json(await fetch(`${SB}/boards?page_size=100`, { headers: h })); if (!d.items) listErr = d.message || JSON.stringify(d).slice(0, 160); return d.items || []; };
  let board_id = (await list()).find(b => b.name === NAME)?.id || (await list())[0]?.id;
  // The sandbox's board list can come back empty even when a board exists, so fall back to a fresh name.
  for (const name of [NAME, `${NAME} · Studio`, `Studio ${new Date().toISOString().slice(0, 16)}`]) {
    if (board_id) break;
    const b = await fetch(`${SB}/boards`, { method: "POST", headers: h, body: JSON.stringify({ name }) });
    const bd = await json(b);
    if (bd.id) board_id = bd.id;
    else if (!/already have a board/i.test(bd.message || "")) fail(502, `Pinterest sandbox: ${bd.message || b.status}`);
  }
  if (!board_id) fail(502, `Pinterest sandbox: couldn't find or make a board${listErr ? ` (${listErr})` : ""}`);
  const r = await fetch(`${SB}/pins`, { method: "POST", headers: h, body: JSON.stringify({ ...pin, board_id }) });
  const d = await json(r);
  if (!r.ok) fail(502, `Pinterest sandbox: ${d.message || r.status}`);
  return { url: "", note: `Sandbox pin ${d.id || ""} created. Not live on Pinterest until Standard access is granted` };
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

const POST = { instagram: postInstagram, facebook: postFacebook, threads: postThreads, tiktok: postTikTok, youtube: postYouTube, pinterest: postPinterest, x: postX };

/* ── Reddit: posting what was approved ─────────────────────────────────────
   An image post (the photo goes to Reddit's own image host, so it shows in
   the feed) with the story in a first comment, the way people post there;
   or a text post (the Sunday sale list). */
async function rd(path, t, params, method = "POST") {
  const r = await fetch(`https://oauth.reddit.com${path}`, { method, headers: { Authorization: `Bearer ${t.access_token}`, "User-Agent": UA, ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) }, body: params ? form(params) : undefined });
  const d = await json(r);
  if (!r.ok) fail(502, `Reddit: ${d.message || d.error || r.status}`);
  const errs = d.json?.errors;
  if (errs?.length) fail(400, `Reddit: ${errs.map(e => e.slice(1).join(" ")).join("; ")}`);
  return d;
}
async function redditUpload(t, url) {
  const { buf, type } = await download(url);
  const mime = /png/.test(type) ? "image/png" : "image/jpeg";
  const lease = await rd("/api/media/asset.json", t, { filepath: mime === "image/png" ? "photo.png" : "photo.jpg", mimetype: mime });
  const action = lease.args.action.startsWith("//") ? `https:${lease.args.action}` : lease.args.action;
  const fd = new FormData();
  for (const f of lease.args.fields) fd.append(f.name, f.value);
  fd.append("file", new Blob([buf], { type: mime }), mime === "image/png" ? "photo.png" : "photo.jpg");
  const up = await fetch(action, { method: "POST", body: fd });
  if (!up.ok && up.status !== 201) fail(502, `Reddit image upload failed (${up.status})`);
  const key = lease.args.fields.find(f => f.name === "key")?.value;
  return { url: `${action}/${key}`, asset_id: lease.asset.asset_id };
}
async function postReddit({ sub, title, kind = "image", body = "", images = [], comment = "", flair_id = "", flair_text = "" }) {
  const t = await token("reddit");
  if (!sub || !title) fail(400, "A subreddit and a title");
  const base = { sr: sub.replace(/^r\//i, ""), title: title.slice(0, 300), api_type: "json", resubmit: "true", sendreplies: "true", ...(flair_id ? { flair_id, flair_text } : {}) };
  let d;
  if (kind === "image" && images[0]) {
    const img = await redditUpload(t, images[0]);
    d = await rd("/api/submit", t, { ...base, kind: "image", url: img.url });
  } else d = await rd("/api/submit", t, { ...base, kind: "self", text: body });
  const name = d.json?.data?.name || (d.json?.data?.id ? `t3_${d.json.data.id}` : "");
  let url = d.json?.data?.url || "";
  // An image post's link comes back as the image; the thread's address is what we want.
  if (name) { try { const info = await rd(`/api/info?id=${name}`, t, null, "GET"); url = `https://www.reddit.com${info.data?.children?.[0]?.data?.permalink || ""}` || url; } catch { /* keep */ } }
  if (comment && name) { try { await rd("/api/comment", t, { thing_id: name, text: comment, api_type: "json" }); } catch (e) { return { url, note: `posted, but the comment didn't go: ${e.message}` }; } }
  return { url };
}
POST.reddit = postReddit;
// Every post, by hand, scheduled or autopilot, goes out with its store links tagged for its platform (lib/socialLinks.js).
for (const k of Object.keys(POST)) { const send = POST[k]; POST[k] = payload => send(tagPayload(payload, k)); }

/* ── reading: Instagram posts, Reddit threads ────────────────────────────── */
/* ── per-platform views: recent posts with their numbers, the account's numbers, delete ── */
// Every platform's posts in one shape: { id, url, thumb, text, at, type, stats: { views, likes, comments, shares, saves, reach }, canDelete }.
const num = v => v == null || v === "" || Number(v) < 0 ? null : Number(v);
async function igFeed() {
  const t = await token("instagram");
  const G = t.host || "https://graph.instagram.com/v21.0", uid = t.host ? t.user_id : "me", at = encodeURIComponent(t.access_token);
  const d = await json(await fetch(`${G}/${uid}/media?fields=id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp,like_count,comments_count&limit=24&access_token=${at}`));
  if (d.error) fail(502, `Instagram: ${d.error.message}`);
  const posts = (d.data || []).map(m => ({ id: m.id, url: m.permalink, thumb: m.thumbnail_url || m.media_url || "", text: m.caption || "", at: m.timestamp,
    type: m.media_product_type === "REELS" ? "Reel" : m.media_type === "CAROUSEL_ALBUM" ? "Carousel" : m.media_type === "VIDEO" ? "Video" : "Photo",
    stats: { likes: num(m.like_count), comments: num(m.comments_count) }, canDelete: false, canComments: true }));
  // Views, reach, saves and shares need the insights permission; without it the list still shows likes and comments.
  let insights = true;
  await Promise.all(posts.map(async p => {
    if (!insights) return;
    const r = await json(await fetch(`${G}/${p.id}/insights?metric=views,reach,saved,shares&access_token=${at}`));
    if (r.error) { insights = false; return; }
    for (const m of r.data || []) p.stats[{ saved: "saves" }[m.name] || m.name] = m.values?.[0]?.value ?? m.total_value?.value ?? null;
  }));
  const a = await json(await fetch(`${G}/${uid}?fields=username,followers_count,media_count&access_token=${at}`));
  const account = { name: a.username ? `@${a.username}` : t.name, followers: num(a.followers_count), posts: num(a.media_count), url: a.username ? `https://instagram.com/${a.username}` : "" };
  if (insights) {
    const since = Math.floor(Date.now() / 1000) - 28 * 86400, until = Math.floor(Date.now() / 1000);
    const r = await json(await fetch(`${G}/${uid}/insights?metric=reach,views,accounts_engaged&period=day&metric_type=total_value&since=${since}&until=${until}&access_token=${at}`));
    for (const m of r.data || []) account[`${m.name}_28d`] = m.total_value?.value ?? null;
  }
  return { posts, account, note: insights ? "" : "Views, reach and saves need Instagram's insights permission — reconnect Instagram after it's added.", deleteNote: "Instagram doesn't let apps delete posts — open the post and delete it in the app." };
}
async function ttFeed() {
  const d = await tiktokStats();
  const u = d.user || {};
  return { posts: (d.videos || []).map(v => ({ id: v.id, url: v.share_url, thumb: v.cover_image_url, text: v.video_description || v.title || "", at: new Date(v.create_time * 1000).toISOString(), type: "Video",
      stats: { views: num(v.view_count), likes: num(v.like_count), comments: num(v.comment_count), shares: num(v.share_count) }, canDelete: false })),
    account: { name: u.username ? `@${u.username}` : u.display_name, followers: num(u.follower_count), posts: num(u.video_count), likes: num(u.likes_count), url: u.profile_deep_link || "" },
    note: d.missing?.length ? `TikTok numbers need ${d.missing.join(", ")} — reconnect TikTok.` : (d.errors || []).join(" · "), deleteNote: "TikTok doesn't let apps delete videos — delete it in the TikTok app." };
}
async function ytFeed() {
  const t = await token("youtube");
  const H = { Authorization: `Bearer ${t.access_token}` };
  const c = (await json(await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&mine=true", { headers: H }))).items?.[0];
  if (!c) fail(502, "YouTube: this Google account has no channel");
  const pl = await json(await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=24&playlistId=${c.contentDetails.relatedPlaylists.uploads}`, { headers: H }));
  const ids = (pl.items || []).map(i => i.contentDetails.videoId).join(",");
  const v = ids ? await json(await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,status&id=${ids}`, { headers: H })) : { items: [] };
  return { posts: (v.items || []).map(x => ({ id: x.id, url: `https://youtube.com/shorts/${x.id}`, thumb: x.snippet.thumbnails?.high?.url || x.snippet.thumbnails?.default?.url, text: x.snippet.title, at: x.snippet.publishedAt,
      type: x.status?.privacyStatus && x.status.privacyStatus !== "public" ? `Short · ${x.status.privacyStatus}` : "Short",
      edit: { title: x.snippet.title, description: x.snippet.description || "", privacy: x.status?.privacyStatus || "public" },
      stats: { views: num(x.statistics.viewCount), likes: num(x.statistics.likeCount), comments: num(x.statistics.commentCount) }, canDelete: true })),
    account: { name: c.snippet.title, followers: num(c.statistics.subscriberCount), posts: num(c.statistics.videoCount), views: num(c.statistics.viewCount), url: c.snippet.customUrl ? `https://youtube.com/${c.snippet.customUrl}` : `https://youtube.com/channel/${c.id}` } };
}
async function pinFeed() {
  const t = await token("pinterest");
  const H = { Authorization: `Bearer ${t.access_token}` };
  const d = await json(await fetch("https://api.pinterest.com/v5/pins?page_size=25&pin_metrics=true", { headers: H }));
  if (d.code && !d.items) fail(502, `Pinterest: ${d.message}`);
  const a = await json(await fetch("https://api.pinterest.com/v5/user_account", { headers: H }));
  return { posts: (d.items || []).map(p => { const m = p.pin_metrics?.lifetime_metrics || p.pin_metrics?.["90d"] || {};
      return { id: p.id, url: `https://www.pinterest.com/pin/${p.id}/`, thumb: p.media?.images?.["600x"]?.url || p.media?.images?.["400x300"]?.url || "", text: p.title || p.description || "", at: p.created_at, type: "Pin",
        edit: { title: p.title || "", description: p.description || "", link: p.link || "" },
        stats: { views: num(m.impression), saves: num(m.save), clicks: num(m.outbound_click ?? m.pin_click), comments: num(m.comment) }, canDelete: true }; }),
    account: { name: a.username, followers: num(a.follower_count), posts: num(a.pin_count), views: num(a.monthly_views), url: a.username ? `https://www.pinterest.com/${a.username}/` : "" },
    note: "Trial access: new pins go to Pinterest's sandbox until Standard access is granted." };
}
// The Earth Editions Page: its own posts with reactions, comments and shares.
async function fbFeed() {
  const t = await getSecret("tok_facebook");
  if (!t?.access_token) fail(400, "facebook isn't connected");
  const at = encodeURIComponent(t.access_token);
  // Reactions and comments need pages_read_user_content; without it the posts still list, with shares only.
  const list = fields => fetch(`${FB}/${t.page_id}/published_posts?fields=${fields}&limit=25&access_token=${at}`).then(json);
  const base = "id,message,created_time,permalink_url,full_picture,attachments{media_type},shares";
  let d = await list(`${base},reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)`), counts = true;
  if (d.error?.code === 10) { d = await list(base); counts = false; }
  if (d.error) fail(502, `Facebook: ${d.error.message}`);
  const a = await json(await fetch(`${FB}/${t.page_id}?fields=name,link,followers_count,fan_count&access_token=${at}`));
  const kind = x => { const m = x.attachments?.data?.[0]?.media_type || ""; return /video/i.test(m) ? "Video" : /album/i.test(m) ? "Album" : /photo/i.test(m) ? "Photo" : m ? "Link" : "Post"; };
  return {
    posts: (d.data || []).map(x => ({ id: x.id, url: x.permalink_url || `https://www.facebook.com/${x.id}`, thumb: x.full_picture || "", text: x.message || "", at: x.created_time, type: kind(x),
      stats: counts ? { likes: num(x.reactions?.summary?.total_count), comments: num(x.comments?.summary?.total_count), shares: num(x.shares?.count ?? 0) } : { shares: num(x.shares?.count ?? 0) }, canDelete: true })),
    account: { name: a.name || t.name, followers: num(a.followers_count ?? a.fan_count), posts: (d.data || []).length, url: a.link || `https://www.facebook.com/${t.page_id}` },
    note: counts ? "" : "Likes and comments need Facebook's pages_read_user_content permission — add it to the Meta login, then reconnect.",
  };
}
const FEED = { instagram: igFeed, facebook: fbFeed, tiktok: ttFeed, youtube: ytFeed, pinterest: pinFeed };

// Change a post where the platform lets apps: YouTube title/description/privacy, Pinterest title/description/link, Instagram comments on/off.
async function editPost(p, id, f = {}) {
  if (!/^[\w-]+$/.test(String(id))) fail(400, "Which post?");
  if (p === "youtube") {
    const t = await token("youtube");
    const H = { Authorization: `Bearer ${t.access_token}`, "Content-Type": "application/json" };
    const v = (await json(await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,status&id=${id}`, { headers: H }))).items?.[0];
    if (!v) fail(404, "YouTube: video not found");
    const snippet = { ...v.snippet, title: String(f.title ?? v.snippet.title).slice(0, 100), description: String(f.description ?? v.snippet.description).slice(0, 4900) };
    delete snippet.thumbnails; delete snippet.localized;
    const status = { ...v.status, privacyStatus: ["public", "unlisted", "private"].includes(f.privacy) ? f.privacy : v.status.privacyStatus };
    const r = await fetch("https://www.googleapis.com/youtube/v3/videos?part=snippet,status", { method: "PUT", headers: H, body: JSON.stringify({ id, snippet, status }) });
    if (r.status === 403) fail(403, "YouTube needs the wider permission to edit — reconnect YouTube in Accounts");
    if (!r.ok) fail(502, `YouTube: ${(await json(r)).error?.message || r.status}`);
    return;
  }
  if (p === "pinterest") {
    const t = await token("pinterest");
    const body = {};
    if (f.title != null) body.title = String(f.title).slice(0, 100);
    if (f.description != null) body.description = String(f.description).slice(0, 500);
    if (f.link != null) body.link = String(f.link);
    const r = await fetch(`https://api.pinterest.com/v5/pins/${id}`, { method: "PATCH", headers: { Authorization: `Bearer ${t.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) fail(502, `Pinterest: ${(await json(r)).message || r.status}`);
    return;
  }
  if (p === "instagram" && typeof f.comments === "boolean") {
    const t = await token("instagram");
    const G = t.host || "https://graph.instagram.com/v21.0";
    const d = await json(await fetch(`${G}/${id}`, { method: "POST", body: form({ comment_enabled: String(f.comments), access_token: t.access_token }) }));
    if (d.error) fail(502, `Instagram: ${d.error.message}`);
    return;
  }
  fail(400, `${p} doesn't let apps edit posts — change it in the ${p} app`);
}

async function removePost(p, id) {
  if (!/^[\w-]+$/.test(String(id))) fail(400, "Which post?");
  if (p === "youtube") {
    const t = await token("youtube");
    const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?id=${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${t.access_token}` } });
    if (r.status === 403) fail(403, "YouTube needs the wider permission to delete — reconnect YouTube in Accounts");
    if (!r.ok) fail(502, `YouTube: ${(await json(r)).error?.message || r.status}`);
    return;
  }
  if (p === "pinterest") {
    const t = await token("pinterest");
    const r = await fetch(`https://api.pinterest.com/v5/pins/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${t.access_token}` } });
    if (!r.ok) fail(502, `Pinterest: ${(await json(r)).message || r.status}`);
    return;
  }
  if (p === "facebook") {
    const t = await getSecret("tok_facebook");
    if (!t?.access_token) fail(400, "facebook isn't connected");
    const d = await json(await fetch(`${FB}/${id}?access_token=${encodeURIComponent(t.access_token)}`, { method: "DELETE" }));
    if (d.error) fail(502, `Facebook: ${d.error.message}`);
    return;
  }
  fail(400, `${p} doesn't let apps delete posts — delete it in the ${p} app`);
}

async function igMedia() {
  const t = await token("instagram");
  const d = await json(await fetch(`${t.host || "https://graph.instagram.com/v21.0"}/${t.host ? t.user_id : "me"}/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,children{media_url,media_type}&limit=30&access_token=${encodeURIComponent(t.access_token)}`));
  if (d.error) fail(502, `Instagram: ${d.error.message}`);
  return d.data || [];
}

const SUBS = ["crystals", "MineralCollectors", "Rockhounds", "whatsthisrock", "mineralporn", "CrystalCollectors"];
/* Questions worth answering: the newest posts in r/whatsthisrock and
   r/crystals that ask something (an ID, "is this real", "what is this") and
   haven't been answered to death yet — where a good answer is seen. */
/* Without API access Reddit refuses the JSON, but its RSS feeds still answer:
   the same new posts, with title, text and photo. No reply counts there. */
const unxml = t => String(t || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
async function redditRss(sub) {
  const r = await fetch(`https://www.reddit.com/r/${sub}/new/.rss?limit=50`, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141 Safari/537.36", Accept: "application/atom+xml,application/xml" } });
  if (!r.ok) fail(502, `Reddit: ${r.status}`);
  const xml = await r.text();
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
    const tag = n => (e.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`)) || [])[1] || "";
    const html = unxml(tag("content"));
    const id = (tag("id").match(/t3_(\w+)/) || [])[1] || "";
    const link = (e.match(/<link href="([^"]+)"/) || [])[1] || "";
    const imgs = [...html.matchAll(/(?:src|href)="(https:\/\/(?:i|preview)\.redd\.it\/[^"]+)"/g)].map(m => unxml(m[1]));
    const thumb = (html.match(/<img src="([^"]+)"/) || [])[1] || "";
    const text = unxml((html.match(/<div class="md">([\s\S]*?)<\/div>/) || [])[1] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return { id, sub, title: unxml(tag("title")), text: text.slice(0, 800), url: link, image: imgs[0] || unxml(thumb), images: [...new Set([...imgs, unxml(thumb)].filter(Boolean))].slice(0, 3),
      flair: "", comments: null, at: new Date(tag("updated") || tag("published") || Date.now()).toISOString() };
  }).filter(p => p.id);
}

let rssMemo = null;
async function redditQuestions() {
  // API access (once Reddit approves it) gives reply counts. Until then Reddit
  // refuses Vercel, so the feed comes from the relay on the office Mac
  // (scripts/reddit-relay.mjs → app_data ng-reddit-feed-v1), else the RSS.
  if (!env("REDDIT_CLIENT_ID")) {
    const relay = await appData("ng-reddit-feed-v1").catch(() => null);
    if (relay?.threads?.length) return Object.assign(relay.threads.filter(p => Date.now() - Date.parse(p.at) < 72 * 3600e3), { feedAt: relay.at });
    const ASKS = /\?|\b(what|which|is (this|it)|real|fake|dyed|identif\w*|id\b|help|anyone know|any idea|found)\b/i;
    // One sub at a time, a beat apart, kept 5 minutes: Reddit rate-limits feeds fetched back to back.
    if (rssMemo && Date.now() - rssMemo.at < 5 * 60e3) return rssMemo.list;
    const got = [];
    for (const sub of ["whatsthisrock", "crystals", "minerals"]) {
      try { got.push(...await redditRss(sub)); } catch (e) { if (!got.length && sub === "crystals") throw e; }
      await new Promise(r => setTimeout(r, 1200));
    }
    const all = got
      .filter(p => Date.now() - Date.parse(p.at) < 48 * 3600e3)
      .filter(p => p.sub === "whatsthisrock" || ASKS.test(`${p.title} ${p.text.slice(0, 300)}`));
    const list = all.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50);
    if (list.length) rssMemo = { at: Date.now(), list };
    return list;
  }
  let auth = {};
  if (env("REDDIT_CLIENT_ID")) {
    const tk = await json(await fetch("https://www.reddit.com/api/v1/access_token", { method: "POST",
      headers: { Authorization: basic(env("REDDIT_CLIENT_ID"), env("REDDIT_CLIENT_SECRET")), "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "web:earth-editions-erp:1.0" }, body: form({ grant_type: "client_credentials" }) }));
    if (tk.access_token) auth = { Authorization: `Bearer ${tk.access_token}` };
  }
  const host = auth.Authorization ? "https://oauth.reddit.com" : "https://www.reddit.com";
  const ASKS = /\?|\b(what|which|is (this|it)|real|fake|dyed|identif\w*|id\b|help|anyone know|any idea|found)\b/i;
  const out = [];
  for (const sub of ["whatsthisrock", "crystals", "minerals"]) {
    const r = await fetch(`${host}/r/${sub}/new${auth.Authorization ? "" : ".json"}?limit=60`, { headers: { ...auth, "User-Agent": "web:earth-editions-erp:1.0" } });
    if (!r.ok) fail(502, r.status === 403 || r.status === 429 ? "Reddit blocked the search — add REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET in Vercel" : `Reddit: ${r.status}`);
    const d = await json(r);
    for (const p of (d.data?.children || []).map(c => c.data)) {
      if (p.stickied || p.locked || p.removed_by_category) continue;
      const age = Date.now() / 1000 - p.created_utc;
      if (age > 48 * 3600 || p.num_comments > 8) continue;
      if (sub === "crystals" && !ASKS.test(`${p.title} ${p.link_flair_text || ""} ${String(p.selftext || "").slice(0, 300)}`)) continue;
      const gallery = p.is_gallery && p.media_metadata ? Object.values(p.media_metadata).map(m => m?.s?.u || m?.s?.gif).filter(Boolean).map(u => u.replace(/&amp;/g, "&")) : [];
      const image = p.preview?.images?.[0]?.source?.url?.replace(/&amp;/g, "&") || (/\.(jpe?g|png|webp)$/i.test(p.url || "") ? p.url : "") || gallery[0] || "";
      out.push({ id: p.id, sub: p.subreddit, title: p.title, text: String(p.selftext || "").slice(0, 800), url: `https://www.reddit.com${p.permalink}`,
        image, images: [image, ...gallery].filter(Boolean).filter((u, i, a) => a.indexOf(u) === i).slice(0, 3), flair: p.link_flair_text || "",
        comments: p.num_comments, at: new Date(p.created_utc * 1000).toISOString() });
    }
  }
  // Fewest answers first, then newest: where a good answer is most likely to be read.
  return out.sort((a, b) => a.comments - b.comments || b.at.localeCompare(a.at)).slice(0, 40);
}

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
/* Reading the journal: every post, and the topic queue the Tue/Fri writer
   works through (content/blog/planned.json — [{ topic, notes }], first one
   next). earth-store is a private repo, so this needs GITHUB_BLOG_TOKEN too. */
const ghRead = async path => {
  if (!env("GITHUB_BLOG_TOKEN")) fail(400, "Add GITHUB_BLOG_TOKEN in Vercel to see the journal here");
  const r = await fetch(`${GH}/${path}?ref=main`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "earth-editions-erp", Authorization: `Bearer ${env("GITHUB_BLOG_TOKEN")}` } });
  if (r.status === 404) return null;
  const d = await json(r);
  if (!r.ok) fail(502, `GitHub: ${d.message || r.status}`);
  return d;
};
const ghText = async path => { const f = await ghRead(path); return f?.content ? Buffer.from(f.content, "base64").toString("utf8") : null; };
async function journalList() {
  const index = (await ghText("content/blog/index.js")) || "";
  const files = [...index.matchAll(/from "\.\/([^"]+\.js)"/g)].map(m => m[1]);
  const posts = await Promise.all(files.map(async name => {
    try {
      const src = await ghText(`content/blog/${name}`);
      // The posts are our own files: a plain object literal behind export default.
      const p = new Function(src.replace(/^\s*export\s+default\s+/m, "return "))();
      return { slug: p.slug, title: p.title, description: p.description, date: p.date, stones: p.stones || [], body: String(p.body || "").trim(), words: String(p.body || "").split(/\s+/).length };
    } catch { return { slug: name.replace(/\.js$/, ""), title: name, broken: true }; }
  }));
  let planned = [];
  try { planned = JSON.parse((await ghText("content/blog/planned.json")) || "[]"); } catch { /* none yet */ }
  return { posts: posts.sort((a, b) => String(b.date).localeCompare(String(a.date))), planned: Array.isArray(planned) ? planned : [] };
}
async function setPlanned(list) {
  if (!env("GITHUB_BLOG_TOKEN")) fail(400, "Add GITHUB_BLOG_TOKEN in Vercel to change the plan");
  const clean = (Array.isArray(list) ? list : []).map(x => ({ topic: String(x.topic || "").trim(), notes: String(x.notes || "").trim() })).filter(x => x.topic).slice(0, 50);
  const cur = await ghRead("content/blog/planned.json");
  await gh("content/blog/planned.json", { method: "PUT", body: JSON.stringify({ message: "Journal: planned topics", content: Buffer.from(JSON.stringify(clean, null, 2) + "\n").toString("base64"), ...(cur?.sha ? { sha: cur.sha } : {}) }) });
  return clean;
}
async function unpublishJournal(slug) {
  if (!env("GITHUB_BLOG_TOKEN")) fail(400, "Add GITHUB_BLOG_TOKEN in Vercel first");
  const f = await ghRead(`content/blog/${slug}.js`);
  if (!f) fail(404, "No such post");
  const idx = await gh("content/blog/index.js");
  const src = Buffer.from(idx.content, "base64").toString("utf8");
  const v = (src.match(new RegExp(`import (\\w+) from "\\./${slug}\\.js";`)) || [])[1];
  if (v) {
    const next = src.replace(new RegExp(`import ${v} from "\\./${slug}\\.js";\\n`), "").replace(new RegExp(`\\n\\s*${v},`), "");
    await gh("content/blog/index.js", { method: "PUT", body: JSON.stringify({ message: `Journal: unpublish ${slug}`, content: Buffer.from(next).toString("base64"), sha: idx.sha }) });
  }
  await gh(`content/blog/${slug}.js`, { method: "DELETE", body: JSON.stringify({ message: `Journal: unpublish ${slug}`, sha: f.sha }) });
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
   Run every hour by .github/workflows/social-autopost.yml (with the
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
  // A one-of-a-kind piece live on eartheditions.co goes up as an Instagram story.
  stories: { on: false, platforms: ["instagram"], afterHours: 0, since: null },
};
const AUTO_JOBS = Object.keys(AUTO_DEFAULT);
async function autoSettings() { const a = await appData(AUTO_KEY); return Object.fromEntries(AUTO_JOBS.map(k => [k, { ...AUTO_DEFAULT[k], ...(a?.[k] || {}) }])); }
const saveData = (key, value) => sb().from("app_data").upsert({ key, value });

// Written by OpenAI's best writer, in the journal's voice (lib/captionWriter.js).
async function captionsFor(l, link) {
  const facts = [`Piece: ${l.title}`, l.material && `Stone: ${l.material}`, l.shape && `Shape: ${l.shape}`, l.origin && `Locality: ${l.origin}`, l.size && `Size: ${l.size}`, l.weight && `Weight: ${l.weight}`,
    l.description && `Listing description: ${String(l.description).slice(0, 1000)}`, link && `Link: ${link}`].filter(Boolean).join("\n");
  const prompt = `Social posts for this piece, one per platform in its own style. Never invent facts beyond these.\n\n${facts}\n\nReturn ONLY JSON: {"instagram":"the Instagram caption (shape below)","tiktok":"1-2 lines + 4-6 hashtags","youtube_title":"under 80 chars","youtube":"2-3 lines, the link, 3 hashtags","pinterest_title":"under 100 chars","pinterest":"under 450 chars, keyword-rich","threads":"under 450 chars, 1-2 hashtags","x":"under 250 chars incl. the link, 1-2 hashtags"}\n\nThe Instagram caption:\n${instagramShape(HASHTAG_ENDING)}`;
  const key = env("OPENAI_KEY") || env("OPENAI_API_KEY");
  if (!key) fail(400, "No AI key for writing captions");
  const { text } = await writeWithBest(key, { instructions: INSTAGRAM_VOICE, input: prompt, maxTokens: 2000 }).catch(e => fail(502, `AI: ${e.message}`));
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) fail(502, "The AI's reply couldn't be read");
  return JSON.parse(m[0]);
}
const storeLink = l => { const s = l.platforms?.store; const u = s?.storefront_url || s?.url || ""; return u ? `${u}${u.includes("?") ? "&" : "?"}utm_source=social&utm_medium=autopilot` : ""; };
const wentLive = l => Math.min(...Object.values(l.platforms || {}).filter(x => x?.status === "active").map(x => Date.parse(x.live_at || x.first_listed_at || "") || Infinity));
const payloadFor = (k, l, cap, link) => ({
  text: cap[k] || (k === "facebook" ? cap.instagram || "" : ""), title: k === "youtube" ? cap.youtube_title : k === "pinterest" ? cap.pinterest_title : l.title,
  images: (l.images || []).filter(u => typeof u === "string" && /^https?:/.test(u)).slice(0, 10),
  video: ["tiktok", "youtube", "instagram", "facebook", "threads"].includes(k) && l.video && /^https?:/.test(l.video) ? l.video : "",
  link, mode: k === "tiktok" ? "draft" : "", source: `listing:${l.id}`,
});
const canTake = (k, pl) => !((k === "tiktok" || k === "youtube") && !pl.video) && !(k === "pinterest" && (!pl.images.length || !pl.link)) && !(k !== "threads" && k !== "x" && !pl.images.length && !pl.video);

/* ── new-piece stories ── */
const storeLiveAt = l => { const st = l.platforms?.store; return st?.status === "active" ? Date.parse(st.live_at || "") || 0 : 0; };
const storiesDone = async () => new Set(((await appData("ng-stories-v1")) || []).map(r => r.id));
// The piece's video when it has one (a story suits it best), else the cover
// photo; a video Instagram refuses (too long, odd format) still gets the photo.
async function postStory(l, image = "") {
  // The "Just listed" image drawn by Listing Manager when there is one; else the plain cover photo, or the video.
  const ours = /^https:\/\/[a-z0-9]+\.supabase\.co\/storage\/v1\/object\/public\//.test(image || "") ? image : "";
  const photo = ours || (l.images || []).find(u => typeof u === "string" && /^https:/.test(u));
  // A photo always wins (Sir, 21 Nov): the video only for a piece with no photo.
  const video = photo ? "" : /^https:.*\.(mp4|mov)(\?|$)/i.test(l.video || "") ? l.video : "";
  if (!photo && !video) { await addLog({ platform: "instagram", source: `story:${l.id}`, title: l.title, note: "story skipped — no photo or video" }); return { ok: false, error: "no photo or video" }; }
  let out, how = ours ? "Just listed photo" : video ? "video" : "photo", err;
  try { out = await postInstagram({ story: true, video, images: photo ? [photo] : [] }); }
  catch (e) {
    err = e;
    if (video && photo) { try { out = await postInstagram({ story: true, images: [photo] }); how = "photo"; } catch (e2) { err = e2; } }
  }
  if (!out) { await addLog({ platform: "instagram", source: `story:${l.id}`, title: l.title, note: `story failed: ${err.message}` }); return { ok: false, error: err.message }; }
  await addLog({ platform: "instagram", source: `story:${l.id}`, title: l.title, url: out.url || "", note: `story (${how}) — went live on eartheditions.co` });
  // Ticked in Stories too, so nobody posts it again by hand.
  try { await sb().rpc("app_data_upsert_item", { p_key: "ng-stories-v1", p_item: { id: `listed:${l.id}`, kind: "listed", listing_id: l.id, how: "auto", at: new Date().toISOString() }, p_prepend: true }); } catch {}
  return { ok: true, how, url: out.url };
}
/* Called by Listing Manager the moment a piece first goes live on the site.
   Answers at once; the post (a video takes a minute or two at Instagram)
   carries on after the reply. */
async function storyNow(id, image) {
  const auto = await autoSettings();
  if (!auto.stories.on) return { skipped: "Story autopilot is off" };
  if (auto.stories.afterHours > 0) return { skipped: `Waits ${auto.stories.afterHours}h — the hourly run posts it` };
  if (!(await getSecret("tok_instagram"))?.access_token) return { skipped: "Instagram isn't connected" };
  const { data } = await sb().from("app_rows").select("data").eq("key", "ng-listings-v1").eq("id", String(id)).eq("deleted", false).maybeSingle();
  const l = data?.data;
  if (!l) return { skipped: "Piece not found" };
  if (l.type !== "unique") return { skipped: "Not one of a kind" };
  if (!storeLiveAt(l)) return { skipped: "Not live on eartheditions.co" };
  if ((await storiesDone()).has(`listed:${l.id}`) || (await readLog()).some(e => e.source === `story:${l.id}` && /^story \(/.test(e.note || ""))) return { skipped: "Story already posted" };
  waitUntil(postStory(l, image).catch(e => console.error("story_now", e.message)));
  return { posting: true };
}

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

  // Calendar items approved for posting (Reddit and the rest), at their time.
  const cal = (await appData("ng-social-calendar-v1")) || [];
  let calChanged = false;
  for (const it of cal.filter(x => x.status === "approved" && Date.parse(x.at) <= Date.now()).slice(0, 3)) {
    if (!time()) break;
    try {
      // The photo chosen in the calendar, not just the first.
      const out = await POST[it.platform](it.platform === "reddit" ? { ...it, images: it.kind === "image" ? [it.images?.[it.image || 0]].filter(Boolean) : [] } : { ...it, text: it.body });
      Object.assign(it, { status: "posted", url: out.url || "", note: out.note || "", posted_at: new Date().toISOString() });
      await addLog({ platform: it.platform, source: `calendar:${it.id}`, title: it.title, url: out.url || "", note: `calendar${it.sub ? ` · r/${it.sub}` : ""}${out.note ? ` · ${out.note}` : ""}` });
    } catch (e) { Object.assign(it, { status: "failed", error: e.message }); }
    calChanged = true; done.push(`calendar ${it.platform}: ${it.status}`);
  }
  if (calChanged) await saveData("ng-social-calendar-v1", cal);

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
        if (wentLive(l) <= (Date.parse(auto.listings.added?.[k] || "") || 0)) continue;
        const pl = payloadFor(k, l, cap, link);
        if (!canTake(k, pl)) { await addLog({ platform: k, source: `listing:${l.id}`, title: l.title, note: "autopilot skipped — not the right media" }); continue; }
        try { const out = await POST[k](pl); await addLog({ platform: k, source: pl.source, title: l.title, url: out.url || "", note: `autopilot${out.note ? ` · ${out.note}` : ""}` }); done.push(`${k}: ${l.title}`); }
        catch (e) { await addLog({ platform: k, source: pl.source, title: l.title, note: `autopilot failed: ${e.message}` }); done.push(`${k} failed: ${e.message}`); }
      }
    }
  }

  // 3. New one-of-a-kind pieces on eartheditions.co as stories. Normally posted
  // the moment the piece goes live (action "story_now"); this hourly pass
  // catches any that went live some other way, or whose post failed.
  if (auto.stories.on && time() && await connected("instagram")) {
    const since = Date.parse(auto.stories.since || "") || Date.now();
    const storyDone = await storiesDone();
    const ready = ((await appData("ng-listings-v1")) || [])
      .map(l => ({ l, at: storeLiveAt(l) }))
      .filter(({ l, at }) => l.type === "unique" && !l.deleted && at > since && Date.now() - at >= (+auto.stories.afterHours || 0) * 36e5
        && !posted.has(`story:${l.id}|instagram`) && !storyDone.has(`listed:${l.id}`))
      .sort((a, b) => a.at - b.at);
    for (const { l } of ready.slice(0, 3)) {
      if (!time()) break;
      const r = await postStory(l);
      done.push(r.ok ? `story: ${l.title}` : `story failed: ${r.error}`);
    }
  }

  // 4. New Instagram posts, sent on.
  if (auto.instagram.on && time() && await connected("instagram")) {
    const since = Date.parse(auto.instagram.since || "") || Date.now();
    const media = (await igMedia()).filter(m => Date.parse(m.timestamp) > since);
    for (const m of media.slice(0, 2)) {
      for (const k of auto.instagram.platforms) {
        const vid = m.media_type === "VIDEO";
        if (posted.has(`ig:${m.id}|${k}`) || !time() || !(await connected(k))) continue;
        if (Date.parse(m.timestamp) <= (Date.parse(auto.instagram.added?.[k] || "") || 0)) continue; // older than when this platform was added
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
  // req.query also carries what a rewrite added (/api/tiktok-callback → action, p).
  const action = u.searchParams.get("action") || req.query?.action || body.action;
  const p = u.searchParams.get("p") || req.query?.p || body.p;
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

    // The scheduled run: Postgres's hourly knock (cron key), or anything holding the store secret.
    if (action === "cron") {
      if (!hasStoreSecret(req) && !(await cronKeyOk(req, "social")) && !(await requireUser(req, res))) return;
      return res.json({ ok: true, done: await runAutopilot() });
    }

    if (!(await requireUser(req, res))) return;
    if (action === "story_now") return res.json(await storyNow(body.id, String(body.image || "")));
    /* A listing photo, passed through so the browser may save it (Etsy's image
       host sends no CORS headers). Only the hosts our listing photos live on. */
    if (action === "image") {
      let src;
      try { src = new URL(String(u.searchParams.get("url") || "")); } catch { return res.status(400).json({ error: "Bad image link" }); }
      if (src.protocol !== "https:" || !/(^|\.)(etsystatic\.com|blob\.vercel-storage\.com|shopify\.com|shopifycdn\.net|supabase\.co|eartheditions\.co)$/i.test(src.hostname))
        return res.status(400).json({ error: "Not a listing photo" });
      const r = await fetch(src, { redirect: "follow" });
      const type = r.headers.get("content-type") || "";
      if (!r.ok || !/^image\//i.test(type)) return res.status(502).json({ error: `Couldn't fetch the photo (${r.status})` });
      res.setHeader("Content-Type", type);
      res.setHeader("Cache-Control", "private, max-age=3600");
      return res.send(Buffer.from(await r.arrayBuffer()));
    }

    // Can the token post to this account? (Soniya's planner shows it before scheduling.)
    if (action === "ig_check") {
      const acct = String(body.account || u.searchParams.get("account") || "");
      if (!IG_ACCOUNTS[acct]) fail(400, "Which account?");
      const t = await getSecret("tok_instagram");
      if (!t?.access_token) return res.json({ ok: false, reason: "Instagram isn't connected in Social." });
      const G = t.host || "https://graph.instagram.com/v21.0";
      const d = await json(await fetch(`${G}/${IG_ACCOUNTS[acct]()}?fields=username&access_token=${encodeURIComponent(t.access_token)}`));
      return res.json(d.username ? { ok: true, username: d.username } : { ok: false, reason: d.error?.message || "No access" });
    }
    if (action === "auto_get") return res.json({ auto: await autoSettings(), queue: (await appData(QUEUE_KEY)) || [] });
    if (action === "auto_set") {
      const cur = await autoSettings(), next = body.auto || {};
      // Switching a job on starts it from now: nothing older is posted.
      for (const k of AUTO_JOBS) if (next[k]?.on && !cur[k].on) next[k].since = new Date().toISOString();
      // So does a platform added to a running job: it gets only what comes after (no backfill).
      for (const k of AUTO_JOBS) if (next[k]?.platforms) {
        const added = { ...(cur[k].added || {}) };
        for (const p of next[k].platforms) if (!cur[k].platforms.includes(p)) added[p] = new Date().toISOString();
        next[k].added = added;
      }
      const merged = Object.fromEntries(AUTO_JOBS.map(k => [k, { ...cur[k], ...(next[k] || {}) }]));
      await saveData(AUTO_KEY, merged);
      return res.json({ auto: merged });
    }
    // Scheduled posts from Compose: one row per platform.
    if (action === "schedule") {
      const queue = (await appData(QUEUE_KEY)) || [];
      if (!Date.parse(body.at)) fail(400, "When?");
      const rows = (body.items || []).filter(i => POST[i.platform]).map(i => ({ id: i.id || crypto.randomUUID(), at: new Date(body.at).toISOString(), platform: i.platform, payload: i.payload, status: "pending", created: new Date().toISOString() }));
      const keep = queue.filter(q => q.status === "pending" || Date.now() - Date.parse(q.done_at || q.at) < 30 * 864e5);
      await saveData(QUEUE_KEY, [...keep, ...rows]);
      return res.json({ ok: true, added: rows.length, ids: rows.map(r => r.id) });
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
        out[k] = { ready: ready(k), connected: !!t?.access_token, name: t?.name || "", redirect: redirectUri(req, k), canPost: k !== "tiktok" || /video\.publish/.test(t?.scope || ""), ...(k === "tiktok" && t?.access_token ? { insights: /video\.list/.test(t.scope || "") } : {}) };
      }

      { const f = await getSecret("tok_facebook"); out.facebook = { ready: ready("instagram"), connected: !!f?.access_token, name: f?.name || "", redirect: redirectUri(req, "instagram"), canPost: true, via: "instagram" }; }
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

    if (action === "fb_link") return res.json({ ok: true, page: (({ page_id, name }) => ({ page_id, name }))(await linkFacebookPage((await token("instagram")).access_token)) });
    if (action === "disconnect") { await setSecret(`tok_${p}`, null); return res.json({ ok: true }); }

    if (action === "log") return res.json({ log: await readLog() });

    // Which YouTube channel the connected Google account posts to (none = the account has no channel).
    if (action === "youtube_channel") {
      const t = await token("youtube");
      const d = await json(await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true", { headers: { Authorization: `Bearer ${t.access_token}` } }));
      const c = d.items?.[0];
      if (c && !t.name) await setSecret("tok_youtube", { ...t, name: c.snippet?.title || "" });
      return res.json({ channel: c ? { id: c.id, title: c.snippet?.title, url: c.snippet?.customUrl ? `https://youtube.com/${c.snippet.customUrl}` : `https://youtube.com/channel/${c.id}`, subscribers: c.statistics?.subscriberCount, videos: c.statistics?.videoCount } : null, error: d.error?.message || "" });
    }
    if (action === "tiktok_stats") return res.json(await tiktokStats(u.searchParams.get("cursor") || body.cursor));
    if (action === "tiktok_publish_status") return res.json(await tiktokPublishStatus(String(body.publish_id || u.searchParams.get("id") || "")));
    if (action === "tiktok_creator") {
      const t = await token("tiktok");
      const d = await json(await fetch("https://open.tiktokapis.com/v2/post/publish/creator_info/query/", { method: "POST", headers: { Authorization: `Bearer ${t.access_token}`, "Content-Type": "application/json; charset=UTF-8" }, body: "{}" }));
      return res.json({ ...(d.data || {}), scope: t.scope || "", error: d.error?.code !== "ok" ? d.error?.message || d.error?.code : "" });
    }

    if (action === "feed") {
      if (!FEED[p]) fail(400, "Which platform?");
      const out = await FEED[p]();
      const queue = ((await appData(QUEUE_KEY)) || []).filter(q => q.platform === p && q.status === "pending");
      return res.json({ ...out, scheduled: queue.map(q => ({ id: q.id, at: q.at, title: q.payload?.title || "", text: q.payload?.text || "", thumb: q.payload?.images?.[0] || "" })) });
    }
    if (action === "edit") {
      await editPost(p, body.id, body.fields || {});
      return res.json({ ok: true });
    }
    if (action === "remove") {
      await removePost(p, body.id);
      await addLog({ platform: p, source: "", title: `Deleted ${body.id}`, url: "", note: "deleted from Studio" });
      return res.json({ ok: true });
    }

    if (action === "instagram_media") {
      const [media, log] = await Promise.all([igMedia(), readLog()]);
      return res.json({ media: media.map(m => ({ ...m, sent: log.filter(e => e.source === `ig:${m.id}`) })) });
    }

    /* A YouTube upload the browser sends itself, straight to Google: this opens
       the resumable session (the channel's token never leaves the server) and
       hands back where to send the bytes. No storage in between, so no 50 MB
       cap and no copy made smaller. body: { title, text, privacy, size, type } */
    if (action === "youtube_session") {
      const t = await token("youtube");
      const unlisted = body.privacy === "unlisted";
      const name = String(body.title || body.text || "Earth Editions").replace(/\s+/g, " ").trim().slice(0, 90);
      const meta = { snippet: { title: unlisted || /#shorts/i.test(name) ? name : `${name.slice(0, 91)} #Shorts`, description: String(body.text || "").slice(0, 4900), categoryId: "26" },
        status: { privacyStatus: unlisted ? "unlisted" : "public", selfDeclaredMadeForKids: false } };
      const start = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", { method: "POST",
        headers: { Authorization: `Bearer ${t.access_token}`, "Content-Type": "application/json; charset=UTF-8",
          ...(body.size ? { "X-Upload-Content-Length": String(body.size) } : {}), "X-Upload-Content-Type": body.type || "video/mp4",
          // The browser that will send the bytes, so Google answers it.
          ...(req.headers.origin ? { Origin: req.headers.origin } : {}) },
        body: JSON.stringify(meta) });
      if (!start.ok) fail(502, `YouTube: ${(await json(start)).error?.message || start.status}`);
      return res.json({ uploadUrl: start.headers.get("location") });
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

    if (action === "reddit_flairs") {
      const t = await token("reddit");
      const d = await json(await fetch(`https://oauth.reddit.com/r/${encodeURIComponent(String(u.searchParams.get("sub") || "").replace(/^r\//i, ""))}/api/link_flair_v2`, { headers: { Authorization: `Bearer ${t.access_token}`, "User-Agent": UA } }));
      return res.json({ flairs: Array.isArray(d) ? d.map(f => ({ id: f.id, text: f.text })) : [] });
    }
    // A calendar item posted now, by hand.
    if (action === "post_item") {
      const it = body.item || {};
      if (!POST[it.platform]) fail(400, "Which platform?");
      const out = await POST[it.platform](it.platform === "reddit" ? it : { ...it, text: it.body });
      await addLog({ platform: it.platform, source: `calendar:${it.id}`, title: it.title, url: out.url || "", note: `calendar${it.sub ? ` · r/${it.sub}` : ""}${out.note ? ` · ${out.note}` : ""}` });
      return res.json({ ok: true, ...out });
    }

    if (action === "reddit_search") return res.json({ threads: await redditSearch(Array.isArray(body.terms) ? body.terms : []) });
    if (action === "reddit_questions") { const threads = await redditQuestions(); return res.json({ threads, feedAt: threads.feedAt || "", canPost: !!(await getSecret("tok_reddit"))?.access_token }); }
    // A reply posted as the connected account (needs Reddit's API approval and Accounts → Reddit).
    if (action === "reddit_reply") {
      const id = String(body.id || "").replace(/^t3_/, "").replace(/[^\w]/g, ""), text = String(body.text || "").trim();
      if (!id || !text) fail(400, "Which post, and the reply");
      const t = await token("reddit");
      const d = await rd("/api/comment", t, { thing_id: `t3_${id}`, text, api_type: "json" });
      const c = d.json?.data?.things?.[0]?.data || {};
      return res.json({ ok: true, url: c.permalink ? `https://www.reddit.com${c.permalink}` : "" });
    }

    if (action === "journal_list") return res.json(await journalList());
    if (action === "journal_plan") return res.json({ planned: await setPlanned(body.planned) });
    if (action === "journal_unpublish") { await unpublishJournal(String(body.slug || "")); await addLog({ platform: "journal", title: `Unpublished ${body.slug}` }); return res.json({ ok: true }); }

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
