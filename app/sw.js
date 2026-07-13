/* ===================================================================
   sw.js — service worker (task E1, PWA shell)
   Cache-first offline shell for Mesa. Bump CACHE on every deploy that
   changes any shell file; the version string is the only thing that
   needs to change to invalidate old installs.
   =================================================================== */

const CACHE = 'mesa-v8';

// The full app shell — everything needed to boot and run with zero network.
const SHELL_FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/mesa.css',
  'js/state.js',
  'js/engine.js',
  'js/planner.js',
  'js/render.js',
  'js/library.js',
  'js/sync.js',
  'js/app.js',
  'data/foods.js',
  'data/recipes.js',
  'data/validate.js',
  'icons/icon.svg',
  'icons/icon-maskable.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-512-maskable.png'
];

self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE)
      .then(function(cache){ return cache.addAll(SHELL_FILES); })
      .then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys()
      .then(function(keys){
        return Promise.all(
          keys.filter(function(key){ return key !== CACHE; })
              .map(function(key){ return caches.delete(key); })
        );
      })
      .then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(event){
  const req = event.request;

  // Only handle same-origin GETs — everything else (cross-origin, POST, etc.)
  // passes straight through untouched.
  if(req.method !== 'GET' || new URL(req.url).origin !== self.location.origin){
    return;
  }

  event.respondWith(
    caches.match(req).then(function(cached){
      if(cached) return cached;
      return fetch(req).then(function(res){
        // Only cache good, basic (same-origin) responses.
        if(res && res.ok && res.type === 'basic'){
          const copy = res.clone();
          caches.open(CACHE).then(function(cache){ cache.put(req, copy); });
        }
        return res;
      }).catch(function(){
        // Offline and not in cache (e.g. a route not in SHELL_FILES) —
        // fall back to the cached shell page so navigations still boot.
        if(req.mode === 'navigate') return caches.match('index.html');
        return undefined;
      });
    })
  );
});
