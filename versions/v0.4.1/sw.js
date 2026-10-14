const CACHE_NAME = 'echomark-web-v0.4.1';
const APP_FILES = ['./', './index.html', './product.html', './styles.css', './themes.css?v=0.4.1', './theme-colors.js?v=0.4.1', './vendor/material-colors.mjs', './app.js?v=0.4.1', './speech-core.js?v=0.4.1', './recognition-controller.js?v=0.4.1', './vendor/pinyin-pro.js', './icon.svg', './manifest.webmanifest', './styles.css?v=0.4.1'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
    return response;
  })));
});
