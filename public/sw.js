// SkelzAI Service Worker — PWA offline support
// Strategy:
//   - Precache shell (index.html, manifest, icons) on install
//   - Network-first for navigation (always fetch fresh HTML, fallback to cache)
//   - Cache-first for static assets (icons, css, fonts)
//   - Network-only for /api/* (never cache API responses)
//   - Bypass for cross-origin CDN scripts (Tailwind, pdf.js, mammoth, fonts)

const VERSION = 'skelzai-v2.6.0';
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

// Assets to precache on install
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png'
];

// Install: precache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => {
      return cache.addAll(PRECACHE_URLS).catch((err) => {
        // Some assets may 404 in dev — log and continue
        console.warn('[SW] Precache partial failure:', err);
      });
    }).then(() => {
      return self.skipWaiting();
    })
  );
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key))
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

// Helper: check if URL is same-origin
function isSameOrigin(url) {
  return new URL(url).origin === self.location.origin;
}

// Helper: check if URL is API call
function isApiCall(url) {
  return new URL(url).pathname.startsWith('/api/');
}

// Helper: check if URL is a static asset
function isStaticAsset(url) {
  const u = new URL(url);
  if (!isSameOrigin(url)) return false;
  return /\.(?:png|jpg|jpeg|gif|svg|webp|css|js|woff2?|ttf|ico|json)$/.test(u.pathname) ||
         u.pathname.startsWith('/icons/');
}

// Fetch handler — route-based caching strategy
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = req.url;

  // Only handle GET requests
  if (req.method !== 'GET') return;

  // Skip cross-origin (CDN scripts: Tailwind, pdf.js, mammoth, Google Fonts)
  // Let browser handle them normally
  if (!isSameOrigin(url)) return;

  // Never cache API calls — always go to network
  if (isApiCall(url)) return;

  // Navigation requests (HTML pages): network-first, fallback to cached shell
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((response) => {
          // Cache fresh copy of index.html
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put('/index.html', copy));
          return response;
        })
        .catch(() => {
          // Offline — return cached shell
          return caches.match('/index.html').then((r) => r || caches.match('/'));
        })
    );
    return;
  }

  // Static assets: cache-first, then network (and cache the response)
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((response) => {
          // Only cache successful responses
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(RUNTIME_CACHE).then((cache) => cache.put(req, copy));
          }
          return response;
        });
      })
    );
    return;
  }

  // manifest.json: network-first with cache fallback
  if (url.endsWith('/manifest.json')) {
    event.respondWith(
      fetch(req).catch(() => caches.match(req))
    );
    return;
  }

  // Default: try network, fallback to cache
  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});

// Listen for messages from client (e.g., "SKIP_WAITING" to activate new SW)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
