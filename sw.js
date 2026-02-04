// sw.js
// Abrox — Service Worker
// - Versioned precache
// - Defensive addAll fallback (individual caching if some assets fail)
// - Runtime caching strategies:
//     * Cache-first for images & static assets
//     * Network-first for navigation (HTML) with offline fallback to cached index
// - Responds to SKIP_WAITING and simple postMessage events
// - Broadcasts install/activate lifecycle events

const CACHE_VERSION = 'v1.2026.02.04';
const CACHE_NAME = `abrox-chat-${CACHE_VERSION}`;
const RUNTIME_CACHE = `abrox-runtime-${CACHE_VERSION}`;

// list of assets to precache (keep in sync with index.html includes)
const PRECACHE_ASSETS = [
  '/',
  '/index.html',

  // core scripts
  '/precache.js',
  '/synthetic-people.js',
  '/message-pool.js',
  '/typing-engine.js',
  '/simulation-engine.js',
  '/ui-adapter.js',
  '/message.js',

  // ui / assets
  '/styles.css',
  '/emoji-pack.js',
  '/assets/logo.png'
];

// Helper to log with SW prefix
function log(...args) {
  try{ console.log('[Abrox SW]', ...args); }catch(e){}
}

// Safe caching: try addAll, otherwise fall back to add each
async function safePrecache(list, cache) {
  try {
    await cache.addAll(list);
    log('precache addAll succeeded, items:', list.length);
    return;
  } catch (err) {
    log('precache.addAll failed, falling back to per-item caching', err);
    for (const url of list) {
      try {
        const resp = await fetch(url, { cache: 'no-cache' });
        if (resp && resp.ok) await cache.put(url, resp.clone());
      } catch (e) {
        log('precache item failed:', url, e);
      }
    }
  }
}

self.addEventListener('install', (event) => {
  log('install event — caching precache assets');
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      await safePrecache(PRECACHE_ASSETS, cache);
    } catch (e) {
      log('install precache failed', e);
    }
    // Activate worker as soon as it's finished installing
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  log('activate — cleaning up old caches');
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => {
        if (k !== CACHE_NAME && k !== RUNTIME_CACHE) {
          log('deleting old cache', k);
          return caches.delete(k);
        }
        return Promise.resolve(true);
      }));
    } catch (e) {
      log('activate cleanup error', e);
    }
    await self.clients.claim();
    // broadcast activation to clients
    const all = await self.clients.matchAll({ includeUncontrolled: true });
    for (const client of all) {
      client.postMessage({ type: 'abrox-sw-activated', cache: CACHE_NAME });
    }
  })());
});

// Utility: fetch from network then cache; returns response or throws
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    // cache only successful responses
    if (response && response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      try { cache.put(request, response.clone()); } catch(e){ /* ignore */ }
    }
    return response;
  } catch (err) {
    const cache = await caches.match(request);
    if (cache) return cache;
    throw err;
  }
}

// Utility: try cache first, otherwise network and cache result
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      try { cache.put(request, response.clone()); } catch(e){ /* ignore */ }
    }
    return response;
  } catch (e) {
    return caches.match('/index.html'); // fallback to index as a last resort
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // only handle GET requests
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // same-origin navigation (HTML) -> network-first (fresh content), fallback to cached index.html
  if (req.mode === 'navigate' || (req.headers.get('accept') && req.headers.get('accept').includes('text/html'))) {
    event.respondWith((async () => {
      try {
        const response = await networkFirst(req);
        if (response) return response;
      } catch (e) { /* fall through */ }
      // try cache fallback
      const cached = await caches.match('/index.html');
      if (cached) return cached;
      return new Response('<h1>Offline</h1><p>Unable to load content.</p>', { headers: { 'Content-Type': 'text/html' }});
    })());
    return;
  }

  // Static assets & images — cache-first strategy
  if (/\.(png|jpg|jpeg|gif|webp|svg|ico|avif)$/.test(url.pathname) || url.pathname.startsWith('/assets/') || url.pathname.endsWith('.css') || url.pathname.endsWith('.js')) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // API/XHR-ish requests: network-first with cache fallback
  if (req.headers.get('accept') && req.headers.get('accept').includes('application/json')) {
    event.respondWith((async () => {
      try {
        const resp = await networkFirst(req);
        return resp || new Response(JSON.stringify({ error: 'offline' }), { headers: { 'Content-Type': 'application/json' }});
      } catch (e) {
        const cached = await caches.match(req);
        if (cached) return cached;
        return new Response(JSON.stringify({ error: 'offline' }), { headers: { 'Content-Type': 'application/json' }});
      }
    })());
    return;
  }

  // Default: try cache, else network
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const resp = await fetch(req);
      // cache static resources heuristically
      if (resp && resp.ok && req.destination !== 'document') {
        const cache = await caches.open(RUNTIME_CACHE);
        try { cache.put(req, resp.clone()); } catch(e){ /* ignore */ }
      }
      return resp;
    } catch (e) {
      // final fallback to index.html for unknown requests
      return caches.match('/index.html');
    }
  })());
});

// Listen for messages from client pages (e.g., SKIP_WAITING)
self.addEventListener('message', (event) => {
  try {
    const data = event.data || {};
    if (!data || !data.type) return;
    if (data.type === 'SKIP_WAITING') {
      log('received SKIP_WAITING — calling skipWaiting()');
      self.skipWaiting();
    } else if (data.type === 'PING') {
      // reply to the source client
      if (event.source && typeof event.source.postMessage === 'function') {
        event.source.postMessage({ type: 'PONG', timestamp: Date.now() });
      }
    } else {
      // broadcast to all clients for app-level handling
      self.clients.matchAll({ includeUncontrolled: true }).then(clients => {
        clients.forEach(c => {
          c.postMessage({ type: 'abrox-sw-message', data });
        });
      });
    }
  } catch (e) {
    log('message handler error', e);
  }
});

// Optional: cleanup handler for periodic maintenance (could be extended)
self.addEventListener('periodicsync', (ev) => {
  // Not all browsers support periodicsync; ignore if not used
  log('periodicsync event', ev);
});
