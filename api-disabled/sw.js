const sw = String.raw`/**
 * Nikhil Gems Service Worker
 */

const CACHE = "ng-shell-2026-06-09-v12";
const SHELL = ["/", "/index.html"];

const freshRequest = req => new Request(req, { cache: "no-store" });
const clearShellCaches = () =>
  caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("ng-shell-")).map(k => caches.delete(k))));
const reloadModule = () => new Response(
  "caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('ng-shell-')).map(k=>caches.delete(k)))).finally(()=>location.reload()); export default {};",
  { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" } }
);

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

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

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

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

  if (e.request.mode === "navigate") {
    e.respondWith(
      Promise.race([
        fetch(freshRequest(e.request)).then(res => {
          if (!res.ok) throw new Error("navigation failed");
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
          return res;
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
      ]).catch(() => caches.match("/index.html"))
    );
  }
});
`;

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.status(200).send(sw);
}
