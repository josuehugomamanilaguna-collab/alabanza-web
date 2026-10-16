// Service Worker: interfaz offline. Los documentos privados NO se almacenan aquí.
const VERSION = 'yahweh-shell-1';
const APP_FILES = ['./', './index.html', './styles.css', './app.js', './config.js', './manifest.webmanifest'];
const LIBS = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js'
];
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(APP_FILES);
    // Bibliotecas de terceros: guardarlas si la conexión lo permite.
    await Promise.allSettled(LIBS.map(async url => {
      const response = await fetch(url, { mode: 'no-cors' });
      await cache.put(url, response);
    }));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('yahweh-shell-') && key !== VERSION) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isApp = url.origin === self.location.origin;
  const isLib = LIBS.includes(url.href);
  if (!isApp && !isLib) return; // Nunca intercepta consultas Supabase ni enlaces firmados.
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req, { ignoreSearch: isApp });
    if (isLib && cached) return cached;
    try {
      const response = await fetch(req);
      if (response.ok || (isLib && response.type === 'opaque')) {
        await cache.put(req, response.clone());
      }
      return response;
    } catch (error) {
      if (cached) return cached;
      if (isApp && req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      throw error;
    }
  })());
});
