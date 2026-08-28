// Bump this when you deploy an update — it forces the new files to replace the old cache.
const CACHE_NAME = "pantry-keeper-v15";

const APP_SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./vendor/react.production.min.js",
  "./vendor/react-dom.production.min.js",
  "./vendor/babel.min.js",
  "./vendor/supabase.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        // { cache: "reload" } forces a real network fetch for each file instead of letting
        // the browser silently hand back its own stale HTTP-cached copy — without this,
        // "updating" the service worker could still re-cache old content.
        Promise.all(APP_SHELL.map((url) => cache.add(new Request(url, { cache: "reload" }))))
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache calls to Supabase (any project) or the Anthropic API — those need to
  // hit the network live every time. Caching a Supabase response would risk serving
  // stale synced data instead of what's actually current across the household.
  if (url.hostname.endsWith(".supabase.co") || url.hostname === "api.anthropic.com") return;

  // Cache-first for the app shell and vendored scripts, so the app opens instantly offline.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && event.request.method === "GET") {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});
