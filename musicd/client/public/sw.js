// MusicD Service Worker (#v1.1.0.3)
// =================================
// PWA support so users can install MusicD to their home screen and run it
// full-screen like a native app. The service worker only handles caching
// of static assets -- everything dynamic (API calls, WebSocket, streaming)
// passes through untouched.
//
// Caching strategy:
//   /api/*, /ws          -> never cached, always network. We don't want
//                           stale library data or stuck WS connections.
//   /assets/*            -> cache-first. Vite emits content-hashed
//                           filenames, so a new bundle has new URLs and
//                           old entries become unused garbage we trim
//                           when CACHE_VERSION bumps.
//   /  /index.html       -> network-first, fall back to cache. After an
//                           auto-update we want users to see the new HTML
//                           shell promptly, not an old cached one.
//   anything else        -> network-first, fall back to cache. Safest
//                           default.
//
// Offline fallback: if a navigation request fails (no network, server
// down) and we have no cached HTML, return the built-in offline page
// rather than the ugly browser "no internet" screen.

const CACHE_VERSION = 'musicd-v1';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
];

// Inline offline fallback page. Tiny so we don't depend on anything
// else being cached.
const OFFLINE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MusicD — offline</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    background: #000; color: #fff;
    font-family: 'DM Sans', -apple-system, sans-serif;
    display: flex; align-items: center; justify-content: center;
    text-align: center; padding: 24px;
  }
  .box { max-width: 320px; }
  .icon {
    font-size: 48px; line-height: 1;
    color: rgba(255,255,255,0.4); margin-bottom: 18px;
  }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 12px; }
  p { font-size: 13px; line-height: 1.5; opacity: 0.7; margin: 0 0 20px; }
  button {
    background: #1a8cff; color: white;
    padding: 10px 20px; border: none; border-radius: 8px;
    font-size: 13px; font-weight: 500;
    cursor: pointer;
  }
</style>
</head>
<body>
  <div class="box">
    <div class="icon">⚠</div>
    <h1>Sorry, you're offline</h1>
    <p>It could be a network issue.<br>Please contact support.</p>
    <button onclick="location.reload()">Retry</button>
  </div>
</body>
</html>`;

// ── Install: precache the essentials ────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    // Use { cache: 'reload' } to bypass the HTTP cache during precache.
    await cache.addAll(PRECACHE.map(url => new Request(url, { cache: 'reload' })));
    self.skipWaiting();
  })());
});

// ── Activate: clean up caches from previous SW versions ─────────────
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k !== STATIC_CACHE && k !== RUNTIME_CACHE)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// ── Fetch: route by URL pattern ─────────────────────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // /api/* and /ws -- always network. Never cache live data.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) {
    return;
  }

  // /assets/* -- content-hashed by Vite. Cache-first is safe and fast.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Navigation requests (the HTML shell) -- network-first so users see
  // updates promptly. Fall back to cache, then offline page.
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(navigationHandler(req));
    return;
  }

  // Everything else (images, static files, manifest) -- network-first
  // with cache fallback.
  event.respondWith(networkFirst(req));
});

async function cacheFirst(req) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function networkFirst(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req);
    if (hit) return hit;
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function navigationHandler(req) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put('/', res.clone());
    return res;
  } catch (e) {
    // Try the cached root first, then fall back to the offline page.
    const cached = await cache.match('/') || await cache.match(req);
    if (cached) return cached;
    return new Response(OFFLINE_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}
