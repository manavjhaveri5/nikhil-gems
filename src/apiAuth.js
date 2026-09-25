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

window.fetch = async (input, init = {}) => {
  if (!isOwnApi(input)) return nativeFetch(input, init);
  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
  if (!headers.has("Authorization")) {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) headers.set("Authorization", `Bearer ${session.access_token}`);
    } catch {}
  }
  return nativeFetch(input, { ...init, headers });
};
