import { supabase } from "./supabase.js";

/* Every /api function requires the signed-in user's Supabase session (see
   lib/auth.js). Rather than touch each of the ~100 call sites, the app's own
   /api requests get `Authorization: Bearer <access_token>` added here, once.
   Only same-origin /api/ URLs are touched, and an Authorization the caller set
   itself is left alone. getSession() refreshes an expired token first. */

const nativeFetch = window.fetch.bind(window);

const isOwnApi = input => {
  try {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, window.location.href);
    return url.origin === window.location.origin && url.pathname.startsWith("/api/");
  } catch { return false; }
};

/* The open module (ng-last-mod) plus the first app file in the call stack,
   e.g. "finance/FinanceApp". Built chunks are named after their source file. */
const aiFeature = () => {
  let mod = "home";
  try { mod = sessionStorage.getItem("ng-last-mod") || "home"; } catch {}
  const files = (new Error().stack || "").match(/\/([A-Za-z][\w-]*?)(?:-[\w]{6,})?\.(?:jsx?|mjs)/g) || [];
  const file = files.map(f => f.replace(/^\/|(?:-[\w]{6,})?\.(?:jsx?|mjs)$/g, ""))
    .find(f => !/^(apiAuth|aiClient|index|vendor|react|chunk)/i.test(f)) || "";
  return file ? `${mod}/${file}` : mod;
};

/* One refresh shared by every request that hit a 401 at the same moment, and
   at most one a minute: when Supabase itself is struggling, the server's check
   fails too, and a refresh per request would only pile on more load. */
let refreshing = null, lastRefresh = 0;
const refreshOnce = () => {
  if (refreshing) return refreshing;
  if (Date.now() - lastRefresh < 60_000) return Promise.resolve(null);
  lastRefresh = Date.now();
  refreshing = Promise.race([
    supabase.auth.refreshSession().then(r => r.data?.session || null),
    new Promise(ok => setTimeout(() => ok(null), 15_000)),
  ]).catch(() => null).finally(() => { refreshing = null; });
  return refreshing;
};

window.fetch = async (input, init = {}) => {
  if (!isOwnApi(input)) return nativeFetch(input, init);
  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
  // Girton's meter: which screen (and file) asked for this AI call.
  if (/^\/api\/(claude|openai|embed)/.test(new URL(typeof input === "string" || input instanceof URL ? input : input.url, window.location.href).pathname) && !headers.has("x-ai-feature")) {
    headers.set("x-ai-feature", aiFeature());
  }
  const ownAuth = headers.has("Authorization");
  if (!ownAuth) {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) headers.set("Authorization", `Bearer ${session.access_token}`);
    } catch {}
  }
  const res = await nativeFetch(input, { ...init, headers });
  /* A 401 usually means the token ran out while the tab was busy (a long
     video join or render keeps the refresh timer from firing). Refresh the
     session once and send the same request again; only a body that can be
     sent twice is retried. */
  const resendable = !(input instanceof Request) && !(init.body instanceof ReadableStream);
  if (res.status === 401 && !ownAuth && resendable) {
    try {
      const session = await refreshOnce();
      if (session?.access_token) {
        headers.set("Authorization", `Bearer ${session.access_token}`);
        return nativeFetch(input, { ...init, headers });
      }
    } catch {}
  }
  return res;
};
