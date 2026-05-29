/**
 * eBay OAuth 2.0 (authorization code grant) — for the Media API (video upload),
 * which the legacy Auth'n'Auth Trading token cannot do.
 *
 * eBay quirk: the OAuth `redirect_uri` param value is the **RuName** (the redirect
 * URL *name* you configure in the eBay developer portal), NOT a literal URL. The
 * portal's "Auth accepted URL" for that RuName must point back at THIS endpoint
 * (https://<your-domain>/api/ebay-auth) so eBay can deliver ?code=...
 *
 * Required env vars:
 *   EBAY_APP_ID   (client id)      — already set for Trading API
 *   EBAY_CERT_ID  (client secret)  — already set for Trading API
 *   EBAY_RUNAME   (the RuName)     — NEW, from the eBay dev portal
 *   VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (for token storage)
 *
 * Flow:
 *   GET /api/ebay-auth?action=start  → redirect to eBay consent
 *   GET /api/ebay-auth?code=xxx      → exchange code → store tokens in Supabase
 *   GET /api/ebay-auth?action=status → check whether a token is present
 */

const APP_ID  = process.env.EBAY_APP_ID  || process.env.EBAY_CLIENT_ID     || "";
const CERT_ID = process.env.EBAY_CERT_ID || process.env.EBAY_CLIENT_SECRET || "";
const RUNAME  = process.env.EBAY_RUNAME  || "";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || "";

// Scopes needed for the Media API (video) + inventory/listing work.
const SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.item",
].join(" ");

const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const EBAY_SESSION_KEY = "ng-ebay-oauth-session-v1";

const basicAuth = () => "Basic " + Buffer.from(`${APP_ID}:${CERT_ID}`).toString("base64");

// ── Token exchange / refresh ───────────────────────────────────────────────────
async function exchangeCode(code) {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth() },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: RUNAME }),
  });
  return { status: r.status, data: await r.json() };
}

export async function refreshEbayToken(refreshToken) {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth() },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, scope: SCOPES }),
  });
  return r.json();
}

// ── Supabase token storage (shared, same pattern as etsy-auth.js) ───────────────
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
      body: JSON.stringify({ key: EBAY_SESSION_KEY, value: tokens }),
    });
  } catch {}
}

async function loadTokens() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/app_data?key=eq.${EBAY_SESSION_KEY}&select=value`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (!r.ok) return null;
    const rows = await r.json();
    return rows?.[0]?.value || null;
  } catch { return null; }
}

// ── Get a valid OAuth access token — auto-refresh when expired ──────────────────
export async function getEbayAccessToken() {
  const stored = await loadTokens();
  if (stored) {
    const age = (Date.now() - (stored.updated_at || 0)) / 1000;
    const ttl = stored.expires_in || 7200;
    if (stored.access_token && age < ttl - 300) return stored.access_token;
    if (stored.refresh_token) {
      const refreshed = await refreshEbayToken(stored.refresh_token);
      if (refreshed.access_token) {
        await saveTokens({
          access_token:  refreshed.access_token,
          refresh_token: stored.refresh_token, // eBay does not rotate the refresh token here
          expires_in:    refreshed.expires_in || 7200,
          updated_at:    Date.now(),
        });
        return refreshed.access_token;
      }
    }
  }
  // Fallback: a manually-pasted token / refresh token in env
  if (process.env.EBAY_OAUTH_TOKEN) return process.env.EBAY_OAUTH_TOKEN;
  if (process.env.EBAY_OAUTH_REFRESH_TOKEN) {
    try {
      const refreshed = await refreshEbayToken(process.env.EBAY_OAUTH_REFRESH_TOKEN);
      if (refreshed.access_token) return refreshed.access_token;
    } catch {}
  }
  return null;
}

// ── Handler ─────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const { action, code, error, error_description } = req.query;

  if (action === "status") {
    const token = await getEbayAccessToken();
    return res.json({
      has_token: !!token,
      runame_set: !!RUNAME,
      start_url: "/api/ebay-auth?action=start",
    });
  }

  if (action === "start") {
    if (!APP_ID)  return res.status(500).send("EBAY_APP_ID not set");
    if (!RUNAME)  return res.status(500).send("EBAY_RUNAME not set — create a RuName in the eBay developer portal and add it as an env var.");
    const params = new URLSearchParams({
      client_id:     APP_ID,
      response_type: "code",
      redirect_uri:  RUNAME,
      scope:         SCOPES,
      prompt:        "login",
    });
    return res.redirect(`https://auth.ebay.com/oauth2/authorize?${params}`);
  }

  if (code) {
    if (error) return res.status(400).send(`<h2>eBay auth error: ${error}</h2><p>${error_description || ""}</p>`);
    const { status, data } = await exchangeCode(code);
    if (data.access_token) {
      await saveTokens({
        access_token:  data.access_token,
        refresh_token: data.refresh_token || "",
        expires_in:    data.expires_in    || 7200,
        updated_at:    Date.now(),
      });
      return res.send(`<!DOCTYPE html><html><head><title>eBay Connected</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,sans-serif;background:#faf8f4;display:flex;align-items:center;justify-content:center;min-height:80vh;text-align:center;color:#1a1a1a}.wrap{max-width:420px}.icon{font-size:56px}h2{color:#2d7a4f}</style>
</head><body><div class="wrap"><div class="icon">✅</div><h2>eBay Connected!</h2>
<p>OAuth token stored — video publishing is now enabled. You can close this window.</p>
<button onclick="window.close()">Close</button></div></body></html>`);
    }
    return res.status(status).send(`<h2>Token exchange failed (${status})</h2><pre>${JSON.stringify(data, null, 2)}</pre>
<p>Check that EBAY_RUNAME matches the RuName in your eBay portal and its "Auth accepted URL" points to this endpoint.</p>`);
  }

  return res.json({
    message: "eBay OAuth handler",
    start: "/api/ebay-auth?action=start",
    status: "/api/ebay-auth?action=status",
    runame_set: !!RUNAME,
  });
}
