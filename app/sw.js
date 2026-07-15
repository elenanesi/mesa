/* ===================================================================
   sw.js — service worker (task E1, PWA shell)
   Cache-first offline shell for Mesa. Bump CACHE on every deploy that
   changes any shell file; the version string is the only thing that
   needs to change to invalidate old installs.
   =================================================================== */

const CACHE = 'mesa-v55';

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
  'vendor/zxing-browser.min.js',
  'js/library.js',
  'js/sync.js',
  'js/app.js',
  'data/foods.js',
  'data/recipes.js',
  'data/validate.js',
  'assets/ingredients/default-food.png',
  'assets/ingredients/almonds.png',
  'assets/ingredients/apples.png',
  'assets/ingredients/asparagus.png',
  'assets/ingredients/aubergine.png',
  'assets/ingredients/avocado.png',
  'assets/ingredients/bacon.png',
  'assets/ingredients/balsamic-vinegar.png',
  'assets/ingredients/bananas.png',
  'assets/ingredients/barley.png',
  'assets/ingredients/basil.png',
  'assets/ingredients/beef-mince-lean.png',
  'assets/ingredients/bell-pepper.png',
  'assets/ingredients/brazil-nuts.png',
  'assets/ingredients/bresaola.png',
  'assets/ingredients/broccoli.png',
  'assets/ingredients/broccoli-courgette.png',
  'assets/ingredients/brownie.png',
  'assets/ingredients/cabbage.png',
  'assets/ingredients/cannellini-beans.png',
  'assets/ingredients/capers.png',
  'assets/ingredients/cappuccino-unsweetened.png',
  'assets/ingredients/carrot.png',
  'assets/ingredients/carrots.png',
  'assets/ingredients/cauliflower.png',
  'assets/ingredients/cavolo-nero.png',
  'assets/ingredients/cherry-tomatoes.png',
  'assets/ingredients/cherry-tomatoes-cucumber.png',
  'assets/ingredients/chia-seeds.png',
  'assets/ingredients/chicken-breast.png',
  'assets/ingredients/chicken-thigh.png',
  'assets/ingredients/chickpeas.png',
  'assets/ingredients/coconut-milk.png',
  'assets/ingredients/cod.png',
  'assets/ingredients/cola.png',
  'assets/ingredients/courgette.png',
  'assets/ingredients/couscous.png',
  'assets/ingredients/cucumber.png',
  'assets/ingredients/eggs.png',
  'assets/ingredients/espresso-unsweetened.png',
  'assets/ingredients/escarole.png',
  'assets/ingredients/fast-food-beef-burger.png',
  'assets/ingredients/garlic.png',
  'assets/ingredients/ginger.png',
  'assets/ingredients/green-beans.png',
  'assets/ingredients/lemon-juice.png',
  'assets/ingredients/lettuce.png',
  'assets/ingredients/milk.png',
  'assets/ingredients/mixed-berries.png',
  'assets/ingredients/mushrooms.png',
  'assets/ingredients/oranges.png',
  'assets/ingredients/pasta.png',
  'assets/ingredients/pasta-filo.png',
  'assets/ingredients/peaches.png',
  'assets/ingredients/pears.png',
  'assets/ingredients/pizza-bianca.png',
  'assets/ingredients/potatoes.png',
  'assets/ingredients/pumpkin.png',
  'assets/ingredients/rice.png',
  'assets/ingredients/red-onion.png',
  'assets/ingredients/rocket-arugula.png',
  'assets/ingredients/rye-bread.png',
  'assets/ingredients/spinach.png',
  'assets/ingredients/sugar.png',
  'assets/ingredients/sweet-potato.png',
  'assets/ingredients/wholewheat-bread.png',
  'assets/ingredients/white-bread.png',
  'icons/icon.svg',
  'icons/icon-maskable.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-512-maskable.png'
];

// No skipWaiting() here: the new worker parks in "waiting" until the page posts
// SKIP_WAITING (below), so activation + the controllerchange reload happen exactly
// once, driven by the page — never mid-session behind the user's back.
self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE)
      .then(function(cache){ return cache.addAll(SHELL_FILES); })
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
      // claim() fires controllerchange on open pages; app.js reloads on that.
      // That is the single reload path — no client.navigate() here on top of it.
      .then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('message', function(event){
  if(event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', function(event){
  const req = event.request;

  // Only handle same-origin GETs — everything else (cross-origin, POST, etc.)
  // passes straight through untouched.
  if(req.method !== 'GET' || new URL(req.url).origin !== self.location.origin){
    return;
  }

  if(req.mode === 'navigate'){
    // Network-first, but NEVER cache.put the fetched HTML into the versioned cache: doing
    // so paired a freshly-deployed index.html with whatever JS/CSS happened to still be
    // pinned under the OLD CACHE version whenever a deploy forgot to bump CACHE, so
    // offline/flaky loads could serve mismatched HTML+JS. Falling back only to the
    // install-time cached index.html (put there once, atomically, by the install handler's
    // cache.addAll(SHELL_FILES) above) keeps the offline shell internally consistent by
    // construction — it can only ever pair with the JS/CSS cached in that same install.
    event.respondWith(
      fetch(req).catch(function(){
        return caches.match('index.html');
      })
    );
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
