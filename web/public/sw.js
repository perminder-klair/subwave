// SUB/WAVE service worker — minimal, hand-rolled. Goals:
//   1. Make the app installable (PWA install criteria require an active SW).
//   2. Keep the app shell responsive when the network blips, so the lock-screen
//      controls and "scanning the dial" state survive a flaky connection.
// Non-goals:
//   • Offline playback. The live Icecast stream and the controller API are
//     pass-through (network-only). Caching either would either serve stale
//     audio chunks or stale "now playing" state — both worse than failing.
//
// Cache strategy:
//   • /stream.mp3, /stream.opus, /stream.aac, /stream.flac, /api/*
//                                      → bypass entirely (do not even respondWith).
//   • POST / non-GET       → bypass.
//   • Cross-origin         → bypass (Next image/font CDNs can self-cache).
//   • /_next/static/*      → cache-first. These URLs are content-hashed and
//                            immutable, so a cache hit is always correct.
//   • Everything else (HTML documents, RSC payloads, icons, manifest)
//                          → network-first, cache only as an offline fallback.
//
// Why network-first for HTML and not stale-while-revalidate: an HTML document
// (or RSC payload) embeds references to content-hashed `_next/static/*` chunk
// filenames. After a deploy those hashes change. Serving a *stale* cached
// document means the browser then requests chunk hashes the server no longer
// has → 404 → ChunkLoadError → "Application error: a client-side exception".
// That is exactly the failure a stale-while-revalidate HTML cache produced on
// the first route a returning visitor landed on after a deploy. Network-first
// guarantees the document always matches the build whose chunks are live.
//
// Bump CACHE when a worker change requires evicting the existing shell cache.
// The `activate` handler deletes every cache whose key isn't the current CACHE;
// network-only bypass-list changes do not alter cached shell entries.

const CACHE = 'subwave-shell-v2';
const LIVE_STREAM_PATHS = new Set([
  '/stream.mp3',
  '/stream.opus',
  '/stream.aac',
  '/stream.flac',
]);

self.addEventListener('install', (event) => {
  // Take over straight away so a freshly-deployed shell isn't stuck behind
  // the previous worker for a whole tab lifetime.
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (LIVE_STREAM_PATHS.has(url.pathname)) return;
  if (url.pathname.startsWith('/api/')) return;

  // Content-hashed, immutable build assets — a cache hit is always correct.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // HTML documents, RSC navigations, icons, manifest — must track the live
  // build. Network-first; the cache is only a flaky-network fallback.
  event.respondWith(networkFirst(request));
});

// Immutable assets: serve from cache if present, otherwise fetch and store.
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res && res.ok && res.type === 'basic') {
      cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  } catch {
    return Response.error();
  }
}

// Everything else: always prefer the network so the shell matches the deployed
// build; fall back to the last good cached copy only when the network fails.
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (res && res.ok && res.type === 'basic') {
      cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  } catch {
    const cached = await cache.match(request);
    return cached || Response.error();
  }
}
