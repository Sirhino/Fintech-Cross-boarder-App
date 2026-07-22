// GamRemit Service Worker
// Caching strategy is deliberately conservative for a financial app:
//   - /api/* is NEVER cached or intercepted — balances, transactions, auth
//     and every money-moving request always goes straight to the network.
//     Serving stale financial data (or serving it while "offline" and
//     silently failing) is worse than no offline support at all.
//   - Static assets (HTML shells, CSS/JS within them, icons, logo) use a
//     stale-while-revalidate strategy: instant load from cache, silently
//     refreshed in the background, so the app opens fast and stays current.
//   - If there's truly no network and nothing cached, we show a minimal
//     offline message instead of a browser error page.

const CACHE_VERSION = 'gamremit-v1';
const STATIC_CACHE = `${CACHE_VERSION}-static`;

const PRECACHE_URLS = [
  '/manifest.json',
  '/logos/gamremit-logo.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .catch((err) => console.warn('[sw] precache failed (non-fatal):', err))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('gamremit-') && key !== STATIC_CACHE)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // never touch POST/PUT/etc — those are money-moving calls

  const url = new URL(request.url);

  // Never intercept API calls, webhooks, or cross-origin requests (Circle SDK,
  // fonts, etc). Those must always hit the network live.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // HTML page navigations (index.html, app.html, admin.html, etc.) — the app
  // already sets Cache-Control: no-cache on these deliberately, so the
  // service worker respects that intent: always try the network first,
  // and only fall back to whatever's cached if there's truly no connection.
  // This is the opposite of stale-while-revalidate on purpose.
  if (request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            caches.open(STATIC_CACHE).then((cache) => cache.put(request, response.clone()));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          return new Response(
            `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
             <title>GamRemit — Offline</title>
             <style>body{font-family:sans-serif;background:#07090F;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px}
             div{max-width:320px}h1{font-size:1.2rem}p{color:rgba(255,255,255,.6);font-size:.9rem}</style></head>
             <body><div><h1>⚡ You're offline</h1><p>GamRemit needs an internet connection to load your balance and transactions. Reconnect and reload.</p></div></body></html>`,
            { headers: { 'Content-Type': 'text/html' } }
          );
        })
    );
    return;
  }

  // Everything else same-origin (icons, logo, manifest.json) — these rarely
  // change, so stale-while-revalidate is safe: instant load from cache,
  // silently refreshed in the background.
  event.respondWith(
    caches.open(STATIC_CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => null);

      if (cached) {
        networkFetch; // refresh in background, don't block on it
        return cached;
      }
      const fresh = await networkFetch;
      return fresh || new Response('', { status: 504, statusText: 'Offline' });
    })
  );
});
