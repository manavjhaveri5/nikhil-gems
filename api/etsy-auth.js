/**
 * Etsy OAuth 2.0 PKCE — serverless-safe, no external storage needed.
 *
 * The code_verifier is AES-256-GCM encrypted into the `state` param,
 * so no Supabase/KV table is required. The encryption key is derived
 * from ETSY_SHARED_SECRET so only this server can decrypt it.
 *
 * Flow:
 *   GET /api/etsy-auth?action=start   → redirect to Etsy
 *   GET /api/etsy-auth?code=xxx       → exchange code → store token in env hint + show it
 *
 * Scopes: transactions_r transactions_w listings_r listings_w shops_r
 */

import crypto from "crypto";

const KEYSTRING    = process.env.ETSY_KEYSTRING     || "";
const SECRET       = process.env.ETSY_SHARED_SECRET  || "";
const REDIRECT_URI = process.env.ETSY_REDIRECT_URI   || "";
const SUPABASE_URL = process.env.VITE_SUPABASE_URL   || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || "";

const SCOPES = "transactions_r transactions_w listings_r listings_w listings_d shops_r";

// ── PKCE helpers ─────────────────────────────────────────────────────────────
const b64u = buf => buf.toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");

function makeVerifier()  { return b64u(crypto.randomBytes(32)); }
function makeChallenge(v){ return b64u(crypto.createHash("sha256").update(v).digest()); }

// ── AES-256-GCM: embed verifier in state (no server storage needed) ──────────
function deriveKey() {
  // 32-byte key from shared secret
  return crypto.createHash("sha256").update(SECRET || "etsy-fallback-key").digest();
}

function encryptState(verifier) {
  const key = deriveKey();
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc  = Buffer.concat([cipher.update(verifier, "utf8"), cipher.final()]);
  const tag  = cipher.getAuthTag();
  // state = base64url( iv(12) + tag(16) + ciphertext )
  return b64u(Buffer.concat([iv, tag, enc]));
}

function decryptState(state) {
  try {
    const buf = Buffer.from(state.replace(/-/g,"+").replace(/_/g,"/"), "base64");
    const key  = deriveKey();
    const iv   = buf.slice(0, 12);
    const tag  = buf.slice(12, 28);
    const enc  = buf.slice(28);
    const dec  = crypto.createDecipheriv("aes-256-gcm", key, iv);
    dec.setAuthTag(tag);
    return dec.update(enc) + dec.final("utf8");
  } catch { return null; }
}

// ── Token exchange ───────────────────────────────────────────────────────────
async function exchangeCode(code, verifier) {
  const r = await fetch("https://api.etsy.com/v3/public/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "authorization_code",
      client_id:     KEYSTRING,
      redirect_uri:  REDIRECT_URI,
      code,
      code_verifier: verifier,
    }),
  });
  return { status: r.status, data: await r.json() };
}

// ── Token refresh (call this from etsy.js when token expires) ────────────────
export async function refreshEtsyToken(refreshToken) {
  const r = await fetch("https://api.etsy.com/v3/public/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      client_id:     KEYSTRING,
      refresh_token: refreshToken,
    }),
  });
  return r.json();
}

// ── Persist token object to Supabase app_data (shared across all users) ──────
const ETSY_SESSION_KEY = "ng-etsy-session-v1";

async function saveTokensToSupabase(tokens) {
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
      body: JSON.stringify({ key: ETSY_SESSION_KEY, value: tokens }),
    });
  } catch {}
}

async function loadTokensFromSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/app_data?key=eq.${ETSY_SESSION_KEY}&select=value`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (!r.ok) return null;
    const rows = await r.json();
    return rows?.[0]?.value || null;
  } catch { return null; }
}

// ── Get current access token — auto-refresh if expired ───────────────────────
export async function getEtsyAccessToken() {
  // 1. Try app_data (shared, most up-to-date)
  const stored = await loadTokensFromSupabase();
  if (stored) {
    const age = (Date.now() - (stored.updated_at || 0)) / 1000;
    const ttl = stored.expires_in || 3600;
    if (stored.access_token && age < ttl - 300) {
      return stored.access_token;
    }
    // Expired — auto-refresh
    if (stored.refresh_token) {
      const refreshed = await refreshEtsyToken(stored.refresh_token);
      if (refreshed.access_token) {
        const newTokens = {
          access_token:  refreshed.access_token,
          refresh_token: refreshed.refresh_token || stored.refresh_token,
          expires_in:    refreshed.expires_in    || 3600,
          updated_at:    Date.now(),
        };
        await saveTokensToSupabase(newTokens);
        return refreshed.access_token;
      }
    }
  }

  // 2. Fall back to env var refresh token
  const envToken   = process.env.ETSY_ACCESS_TOKEN;
  const envRefresh = process.env.ETSY_REFRESH_TOKEN;
  if (envRefresh && !envToken) {
    try {
      const refreshed = await refreshEtsyToken(envRefresh);
      if (refreshed.access_token) return refreshed.access_token;
    } catch {}
  }

  // 3. Last resort: env var (may be expired)
  return envToken || null;
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { action, code, state, error } = req.query;

  // ── GET-SESSION: return stored session so any browser can bootstrap itself ───
  if (action === "get-session") {
    const stored = await loadTokensFromSupabase();
    if (!stored) return res.status(404).json({ error: "No session stored" });
    // Auto-refresh if expired
    const age = (Date.now() - (stored.updated_at || 0)) / 1000;
    const ttl = stored.expires_in || 3600;
    if (stored.access_token && age < ttl - 300) {
      return res.json({ access_token: stored.access_token, refresh_token: stored.refresh_token, expires_in: Math.round(ttl - age) });
    }
    if (stored.refresh_token) {
      const refreshed = await refreshEtsyToken(stored.refresh_token);
      if (refreshed.access_token) {
        const newTokens = { access_token: refreshed.access_token, refresh_token: refreshed.refresh_token || stored.refresh_token, expires_in: refreshed.expires_in || 3600, updated_at: Date.now() };
        await saveTokensToSupabase(newTokens);
        return res.json({ access_token: refreshed.access_token, refresh_token: newTokens.refresh_token, expires_in: refreshed.expires_in || 3600 });
      }
    }
    return res.status(401).json({ error: "Session expired and refresh failed" });
  }

  // ── INVALIDATE: clear stored token so user is forced to re-auth fresh ─────────
  if (action === "invalidate") {
    try {
      await saveTokensToSupabase({ access_token: null, refresh_token: null, expires_in: 0, updated_at: 0 });
    } catch {}
    return res.json({ ok: true });
  }

  // ── REFRESH: exchange a refresh token for new tokens ─────────────────────────
  if (action === "refresh" && req.method === "POST") {
    const { refresh_token } = req.body || {};
    if (!refresh_token) return res.status(400).json({ error: "refresh_token required" });
    const r = await refreshEtsyToken(refresh_token);
    if (!r.access_token) return res.status(401).json({ error: r.error || "Refresh failed", details: r });
    // Also save to Supabase if available
    await saveTokensToSupabase({ access_token: r.access_token, refresh_token: r.refresh_token || refresh_token, expires_in: r.expires_in || 3600, updated_at: Date.now() }).catch(() => {});
    return res.json({ access_token: r.access_token, refresh_token: r.refresh_token, expires_in: r.expires_in || 3600 });
  }

  // ── START: generate PKCE + redirect to Etsy ─────────────────────────────────
  if (action === "start") {
    if (!KEYSTRING)    return res.status(500).send("ETSY_KEYSTRING not set");
    if (!REDIRECT_URI) return res.status(500).send(
      "ETSY_REDIRECT_URI not set. Add it to Vercel env vars: https://project-nine-tan-22.vercel.app/api/etsy-auth"
    );

    const verifier  = makeVerifier();
    const challenge = makeChallenge(verifier);
    const stateVal  = encryptState(verifier);  // verifier embedded in state — no DB needed

    const params = new URLSearchParams({
      response_type:         "code",
      redirect_uri:          REDIRECT_URI,
      scope:                 SCOPES,
      client_id:             KEYSTRING,
      state:                 stateVal,
      code_challenge:        challenge,
      code_challenge_method: "S256",
    });

    return res.redirect(`https://www.etsy.com/oauth/connect?${params}`);
  }

  // ── CALLBACK: Etsy redirects here with ?code=xxx&state=xxx ──────────────────
  if (code) {
    if (error) return res.status(400).send(`<h2>Etsy auth error: ${error}</h2>`);

    // Recover verifier from encrypted state
    const verifier = state ? decryptState(state) : null;
    if (!verifier) {
      return res.status(400).send(`
        <h2>State / verifier mismatch</h2>
        <p>This can happen if the state param was corrupted or ETSY_SHARED_SECRET changed.</p>
        <p><a href="/api/etsy-auth?action=start">Try again →</a></p>
      `);
    }

    const { status, data } = await exchangeCode(code, verifier);

    if (data.access_token) {
      // Show token so user can paste into Vercel env vars
      const accessToken  = data.access_token;
      const refreshToken = data.refresh_token || "";
      const expiresIn    = data.expires_in || 3600;

      // Persist tokens to Supabase (enables auto-refresh without manual re-auth)
      await saveTokensToSupabase({
        access_token:  accessToken,
        refresh_token: refreshToken,
        expires_in:    expiresIn,
        updated_at:    Date.now(),
      });

      return res.send(`<!DOCTYPE html><html><head><title>Etsy Connected ✓</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#faf8f4;margin:0;padding:20px;color:#1a1a1a;display:flex;align-items:center;justify-content:center;min-height:80vh;text-align:center}
  .wrap{max-width:420px}.icon{font-size:56px;margin-bottom:16px}
  h2{color:#2d7a4f;margin:0 0 8px;font-size:24px}
  .sub{color:#666;font-size:14px;margin-bottom:24px;line-height:1.5}
  .status{background:#f0f7f3;border:1.5px solid #2d7a4f40;border-radius:10px;padding:14px 18px;font-size:13px;color:#2d7a4f;font-weight:600}
  .close-btn{margin-top:18px;background:#2d7a4f;color:#fff;border:none;border-radius:8px;padding:11px 28px;font-size:14px;font-weight:700;cursor:pointer}
</style>
</head><body>
<div class="wrap">
  <div class="icon">✅</div>
  <h2>Etsy Connected!</h2>
  <div class="sub">Your shop <strong>Atyahara</strong> is now linked.<br>This window will close automatically.</div>
  <div class="status" id="status">Saving tokens…</div>
  <button class="close-btn" onclick="window.close()">Close Window</button>
</div>
<script>
(function(){
  try {
    var session = {
      access_token:  "${accessToken}",
      refresh_token: "${refreshToken}",
      expiry: Date.now() + ${(expiresIn - 120) * 1000}
    };
    localStorage.setItem("etsy-session", JSON.stringify(session));
    localStorage.setItem("etsy-refresh",  "${refreshToken}");
    document.getElementById("status").textContent = "✓ Tokens saved — syncing your shop…";
    if (window.opener) {
      window.opener.postMessage({ type: "etsy-auth-complete" }, "*");
    }
    setTimeout(function(){ window.close(); }, 2000);
  } catch(e) {
    document.getElementById("status").textContent = "Saved. You can close this window.";
  }
})();
</script>
</body></html>`);
    }

    return res.status(status).send(`
      <h2>Token exchange failed (${status})</h2>
      <pre>${JSON.stringify(data, null, 2)}</pre>
      <p><strong>Common fixes:</strong></p>
      <ul>
        <li>Make sure the callback URL in your Etsy app <em>exactly</em> matches <code>${REDIRECT_URI}</code></li>
        <li>Each authorization code can only be used once — <a href="/api/etsy-auth?action=start">start again</a></li>
      </ul>
    `);
  }

  // ── STATUS check ─────────────────────────────────────────────────────────────
  if (action === "status") {
    const token = await getEtsyAccessToken();
    return res.json({
      has_token: !!token,
      source: process.env.ETSY_ACCESS_TOKEN ? "ETSY_ACCESS_TOKEN env var" : "none",
      shop_id: process.env.ETSY_SHOP_ID || null,
      redirect_uri: REDIRECT_URI || "(not set)",
      start_url: `${REDIRECT_URI ? new URL(REDIRECT_URI).origin : ""}/api/etsy-auth?action=start`,
    });
  }

  return res.json({
    message: "Etsy OAuth handler",
    start: "/api/etsy-auth?action=start",
    status: "/api/etsy-auth?action=status",
    redirect_uri: REDIRECT_URI || "(ETSY_REDIRECT_URI not set)",
  });
}
