import { createClient } from "@supabase/supabase-js";

/* Every /api function acts on live stores (Etsy, eBay, Shopify, Omnisend) with
   server-side keys, so each one asks for the signed-in staff member's Supabase
   session: the browser sends `Authorization: Bearer <access_token>` (see
   src/apiAuth.js) and it's checked here with the service-role client.
   Server-to-server callers (the retail store, the ops-check workflow) present
   the shared STORE_SYNC_SECRET in `x-store-secret` instead, where allowed. */

let admin;
const adminClient = () => admin ||= createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// A warm instance sees the same token many times a minute (a publish fans out
// to several calls); remember a verified one briefly instead of asking Supabase
// every time. Never longer than the token itself lives.
const verified = new Map();
const CACHE_MS = 60_000;

export const hasStoreSecret = req => {
  const secret = process.env.STORE_SYNC_SECRET;
  return !!secret && req.headers["x-store-secret"] === secret;
};

/* Resolves to the Supabase user, or sends 401 and resolves to null — callers
   do `if (!(await requireUser(req, res))) return;`. */
export async function requireUser(req, res, { allowStoreSecret = false } = {}) {
  if (allowStoreSecret && hasStoreSecret(req)) return { id: "store", store: true };
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token) {
    const hit = verified.get(token);
    if (hit && hit.until > Date.now()) return hit.user;
    try {
      const { data, error } = await adminClient().auth.getUser(token);
      if (!error && data?.user) {
        const exp = (JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).exp || 0) * 1000;
        if (verified.size > 500) verified.clear();
        verified.set(token, { user: data.user, until: Math.min(Date.now() + CACHE_MS, exp) });
        return data.user;
      }
    } catch {}
  }
  res.status(401).json({ error: "Unauthorized — sign in to the ERP" });
  return null;
}
