/**
 * Canva Connect OAuth 2.0 PKCE — mirrors api/etsy-auth.js.
 *
 * The code_verifier is AES-256-GCM encrypted into the `state` param, so no
 * separate storage is needed for the in-flight auth. Tokens are persisted to
 * the Supabase `app_data` table (shared across browsers) and auto-refreshed.
 *
 * Flow:
 *   GET /api/canva-auth?action=start   → redirect to Canva consent
 *   GET /api/canva-auth?code=xxx       → exchange code → store tokens → close popup
 *   GET /api/canva-auth?action=status  → { connected: bool }
 *
 * Required env: CANVA_CLIENT_ID, CANVA_CLIENT_SECRET, CANVA_REDIRECT_URI
 * Redirect URI must exactly match the one set in the Canva integration.
 */

import crypto from "crypto";

const CLIENT_ID     = process.env.CANVA_CLIENT_ID     || "";
const CLIENT_SECRET = process.env.CANVA_CLIENT_SECRET || "";
const REDIRECT_URI  = process.env.CANVA_REDIRECT_URI  || "";
const SUPABASE_URL  = process.env.VITE_SUPABASE_URL   || "";
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || "";

// Be explicit — Canva does not imply :read from :write.
const SCOPES = "asset:read asset:write design:content:read design:content:write design:meta:read";
const AUTH_URL    = "https://www.canva.com/api/oauth/authorize";
const TOKEN_URL   = "https://api.canva.com/rest/v1/oauth/token";
const SESSION_KEY = "ng-canva-session-v1";

// ── PKCE helpers ─────────────────────────────────────────────────────────────
const b64u = buf => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
const makeVerifier  = () => b64u(crypto.randomBytes(32));               // 43 chars (Canva wants 43–128)
const makeChallenge = v  => b64u(crypto.createHash("sha256").update(v).digest());

// ── AES-256-GCM: embed verifier in state (no DB needed for the flow) ─────────
const deriveKey = () => crypto.createHash("sha256").update(CLIENT_SECRET || "canva-fallback-key").digest();

function encryptState(verifier) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(), iv);
  const enc = Buffer.concat([cipher.update(verifier, "utf8"), cipher.final()]);
  return b64u(Buffer.concat([iv, cipher.getAuthTag(), enc]));
}

function decryptState(state) {
  try {
    const buf = Buffer.from(state.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const dec = crypto.createDecipheriv("aes-256-gcm", deriveKey(), buf.slice(0, 12));
    dec.setAuthTag(buf.slice(12, 28));
    return dec.update(buf.slice(28)) + dec.final("utf8");
  } catch { return null; }
}

const basicAuth = () => "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

// ── Token exchange / refresh ─────────────────────────────────────────────────
async function exchangeCode(code, verifier) {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth() },
    body: new URLSearchParams({
      grant_type:    "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri:  REDIRECT_URI,
    }),
  });
  return { status: r.status, data: await r.json() };
}

export async function refreshCanvaToken(refreshToken) {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth() },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  return r.json();
}

// ── Supabase persistence (shared, like Etsy) ─────────────────────────────────
async function saveTokens(tokens) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/app_data`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({ key: SESSION_KEY, value: tokens }),
    });
  } catch {}
}

async function loadTokens() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/app_data?key=eq.${SESSION_KEY}&select=value`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (!r.ok) return null;
    const rows = await r.json();
    return rows?.[0]?.value || null;
  } catch { return null; }
}

// ── Get a valid access token — auto-refresh (used by api/canva.js) ───────────
export async function getCanvaAccessToken() {
  const stored = await loadTokens();
  if (!stored?.access_token && !stored?.refresh_token) return null;

  const age = (Date.now() - (stored.updated_at || 0)) / 1000;
  const ttl = stored.expires_in || 14400; // Canva access tokens ~4h
  if (stored.access_token && age < ttl - 300) return stored.access_token;

  if (stored.refresh_token) {
    const refreshed = await refreshCanvaToken(stored.refresh_token);
    if (refreshed.access_token) {
      await saveTokens({
        access_token:  refreshed.access_token,
        refresh_token: refreshed.refresh_token || stored.refresh_token, // Canva rotates refresh tokens
        expires_in:    refreshed.expires_in || 14400,
        updated_at:    Date.now(),
      });
      return refreshed.access_token;
    }
  }
  return null;
}

// ── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { action, code, state, error } = req.query;

  if (action === "status") {
    const token = await getCanvaAccessToken();
    return res.json({
      connected: !!token,
      configured: !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI),
      redirect_uri: REDIRECT_URI || "(CANVA_REDIRECT_URI not set)",
    });
  }

  if (action === "disconnect") {
    await saveTokens({ access_token: null, refresh_token: null, expires_in: 0, updated_at: 0 }).catch(() => {});
    return res.json({ ok: true });
  }

  if (action === "start") {
    if (!CLIENT_ID || !CLIENT_SECRET) return res.status(500).send("CANVA_CLIENT_ID / CANVA_CLIENT_SECRET not set");
    if (!REDIRECT_URI) return res.status(500).send("CANVA_REDIRECT_URI not set");

    const verifier  = makeVerifier();
    const challenge = makeChallenge(verifier);
    const params = new URLSearchParams({
      response_type:         "code",
      client_id:             CLIENT_ID,
      redirect_uri:          REDIRECT_URI,
      scope:                 SCOPES,
      state:                 encryptState(verifier),
      code_challenge:        challenge,
      code_challenge_method: "S256",
    });
    return res.redirect(`${AUTH_URL}?${params}`);
  }

  if (code) {
    if (error) return res.status(400).send(`<h2>Canva auth error: ${error}</h2>`);
    const verifier = state ? decryptState(state) : null;
    if (!verifier) {
      return res.status(400).send(`<h2>State / verifier mismatch</h2>
        <p>Possible if CANVA_CLIENT_SECRET changed mid-flow. <a href="/api/canva-auth?action=start">Try again →</a></p>`);
    }

    const { status, data } = await exchangeCode(code, verifier);
    if (data.access_token) {
      await saveTokens({
        access_token:  data.access_token,
        refresh_token: data.refresh_token || "",
        expires_in:    data.expires_in || 14400,
        updated_at:    Date.now(),
      });
      return res.send(`<!DOCTYPE html><html><head><title>Canva Connected ✓</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#faf8f4;margin:0;padding:20px;color:#1a1a1a;display:flex;align-items:center;justify-content:center;min-height:80vh;text-align:center}.wrap{max-width:420px}.icon{font-size:56px;margin-bottom:16px}h2{color:#2d7a4f;margin:0 0 8px;font-size:24px}.sub{color:#666;font-size:14px;line-height:1.5}</style>
</head><body><div class="wrap"><div class="icon">✅</div><h2>Canva Connected!</h2>
<div class="sub">You can close this window and return to the app.</div></div>
<script>try{if(window.opener)window.opener.postMessage({type:"canva-auth-complete"},"*");setTimeout(function(){window.close()},1500);}catch(e){}</script>
</body></html>`);
    }
    return res.status(status).send(`<h2>Token exchange failed (${status})</h2><pre>${JSON.stringify(data, null, 2)}</pre>
      <p>Check that the Canva integration's redirect URL exactly matches <code>${REDIRECT_URI}</code>.</p>`);
  }

  return res.json({
    message: "Canva OAuth handler",
    start: "/api/canva-auth?action=start",
    status: "/api/canva-auth?action=status",
    redirect_uri: REDIRECT_URI || "(CANVA_REDIRECT_URI not set)",
  });
}
