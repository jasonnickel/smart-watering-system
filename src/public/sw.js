// Service Worker for Smart Water PWA
// Minimal - just enables "Add to Home Screen" and basic offline shell

const CACHE_NAME = 'smart-water-v13';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Purge old caches so updated CSS/JS is fetched fresh
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Network-first strategy - always try live data, fall back to cache
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cache successful GET responses for offline fallback
        if (event.request.method === 'GET' && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Offline - try cache
        return caches.match(event.request).then(cached => {
          if (cached) return cached;
          // Return a simple offline page for navigation requests
          if (event.request.mode === 'navigate') {
            return new Response(
              '<html><body style="font-family:sans-serif;padding:40px;text-align:center;">' +
              '<h1>Smart Water</h1><p>You are offline. Connect to your network to view the dashboard.</p>' +
              '</body></html>',
              { headers: { 'Content-Type': 'text/html' } }
            );
          }
          return new Response('', { status: 503 });
        });
      })
  );
});
