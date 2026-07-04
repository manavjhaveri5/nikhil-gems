/**
 * Nikhil Gems Service Worker
 * Strategy:
 *   - index.html: network-first (8 s timeout) → cache fallback; the network
 *     response is cached even when it loses the race, so a slow connection
 *     can never pin a client to an old build (v12 did exactly that)
 *   - /assets/*:  cache-first → network + recache                ← content-hashed, safe to cache forever
 *   - /api/*:     network-only (pass-through)                     ← handled by app offline queue
 *   - Supabase:   network-only
 *
 * The cache name uses SELF_URL so every new sw.js deployment busts the old cache.
 */

const CACHE = "ng-shell-2026-07-04-v13";
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
      .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "no-store" }))))
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

  // Navigation (index.html) — network-first with 8 s timeout, fallback to cache.
  // The network fetch keeps running after a timeout and still recaches, so even
  // a client that got the cached shell this time gets the fresh one next open.
  if (e.request.mode === "navigate") {
    const network = fetch(freshRequest(e.request)).then(res => {
      if (!res.ok) throw new Error("navigation failed");
      caches.open(CACHE).then(c => c.put(e.request, res.clone()));
      return res;
    });
    e.waitUntil(network.then(() => {}, () => {}));
    e.respondWith(
      Promise.race([
        network.then(res => res.clone()),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
      ]).catch(() => caches.match("/index.html").then(cached => cached || network))
    );
    return;
  }
});
