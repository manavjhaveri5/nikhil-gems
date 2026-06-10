/**
 * Nikhil Gems Service Worker
 * Strategy:
 *   - index.html: network-first (2 s timeout) → cache fallback   ← always gets updates
 *   - /assets/*:  cache-first → network + recache                ← content-hashed, safe to cache forever
 *   - /api/*:     network-only (pass-through)                     ← handled by app offline queue
 *   - Supabase:   network-only
 *
 * The cache name uses SELF_URL so every new sw.js deployment busts the old cache.
 */

const CACHE = "ng-shell-2026-06-09-v12";
const SHELL  = ["/", "/index.html"];
const freshRequest = req => new Request(req, { cache: "no-store" });
const clearShellCaches = () =>
  caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("ng-shell-")).map(k => caches.delete(k))));
const reloadModule = () => new Response(
  "caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('ng-shell-')).map(k=>caches.delete(k)))).finally(()=>location.reload()); export default {};",
  { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" } }
);

// ── Install: pre-cache the app shell ─────────────────────────────────────────
self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: delete old caches ───────────────────────────────────────────────
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", e => {
  if (e.data?.type === "SKIP_WAITING") self.skipWaiting();
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);

  // Skip cross-origin (Supabase, fonts, CDN)
  if (url.origin !== self.location.origin) return;

  // API calls — always go to network; let app handle offline gracefully
  if (url.pathname.startsWith("/api/")) return;

  // Hashed JS/CSS assets — cache-first, recache on network hit
  if (url.pathname.startsWith("/assets/")) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(freshRequest(e.request)).then(res => {
          if (!res.ok) {
            if (url.pathname.endsWith(".js")) {
              clearShellCaches().catch(() => {});
              return reloadModule();
            }
            return res;
          }
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
          return res;
        }).catch(err => {
          if (url.pathname.endsWith(".js")) {
            clearShellCaches().catch(() => {});
            return reloadModule();
          }
          throw err;
        });
      })
    );
    return;
  }

  // Navigation (index.html) — network-first with 2 s timeout, fallback to cache
  if (e.request.mode === "navigate") {
    e.respondWith(
      Promise.race([
        fetch(freshRequest(e.request)).then(res => {
          if (!res.ok) throw new Error("navigation failed");
          // Recache the fresh index.html on every successful network response
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
          return res;
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
      ]).catch(() => caches.match("/index.html"))
    );
    return;
  }
});
