const CACHE_NAME = 'echomark-web-v0.4.0';
const APP_FILES = ['./', './index.html', './product.html', './styles.css', './themes.css', './theme-colors.js', './vendor/material-colors.mjs', './app.js', './speech-core.js', './recognition-controller.js', './local-asr.js', './local-asr-worker.js', './pcm-worklet.js', './vendor/pinyin-pro.js', './icon.svg', './manifest.webmanifest'];

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
