#!/usr/bin/env node
'use strict';

/* ===================================================================
   tools/catalog-drift.js — reports drift between the BUNDLED data files
   (app/data/foods.js, app/data/recipes.js) and the LIVE D1 catalog the
   app actually reads at launch (GET /library/GLOBAL).

   WHY: the D1 GLOBAL catalog is the SOURCE OF TRUTH — the app replaces
   its bundled builtins with it on every launch (sync.js:
   replaceBuiltin*FromCatalogRows). So a food/recipe added to the bundled
   file but NOT seeded to D1 is INVISIBLE in the app (2026-09: figs, and
   several recipes, shipped in code but never appeared). This has bitten
   us 3x. Run this after adding/editing a builtin food or recipe, and
   before relying on it in the app.

   RUN:  node tools/catalog-drift.js
   Exit code 0 = in sync, 1 = drift found (usable in CI/pre-deploy).

   Loads the bundled files in a vm exactly like tools/check.js / seed-d1.js
   (same stubs, same script order) to read BUILTIN_FOODS_DB /
   BUILTIN_RECIPES_DB, then fetches the live GLOBAL catalog and diffs the
   id sets. GLOBAL is a public route (no auth needed).
   =================================================================== */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_DIR = path.join(__dirname, '..', 'app');
const SYNC_URL = process.env.MESA_SYNC_URL || 'https://mesa-sync.elenanesi55.workers.dev';
// Only the files needed to populate BUILTIN_FOODS_DB / BUILTIN_RECIPES_DB and their deps.
const SCRIPT_ORDER = ['data/foods.js', 'data/recipes.js', 'data/validate.js', 'js/state.js'];

function noop(){}
function fakeEl(){
  return {style: {}, children: [], classList: {add: noop, remove: noop, contains: function(){ return false; }},
    addEventListener: noop, removeEventListener: noop, setAttribute: noop, appendChild: noop};
}
function createContext(){
  const store = new Map();
  const sandbox = {
    console: {log: noop, warn: noop, error: noop},
    localStorage: {getItem: function(k){ return store.has(k) ? store.get(k) : null; },
      setItem: function(k, v){ store.set(String(k), String(v)); }, removeItem: function(k){ store.delete(k); }},
    navigator: {userAgent: 'mesa-catalog-drift/node'},
    location: {protocol: 'file:', host: 'localhost', hostname: 'localhost', href: 'http://localhost/'},
    crypto: globalThis.crypto,
    fetch: function(){ return Promise.reject(new Error('drift-check must read bundled files offline')); },
    setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval
  };
  sandbox.document = {getElementById: function(){ return null; }, querySelector: function(){ return null; },
    querySelectorAll: function(){ return []; }, createElement: fakeEl, addEventListener: noop,
    removeEventListener: noop, cookie: '', body: fakeEl(), documentElement: fakeEl()};
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

function bundledIds(){
  const ctx = createContext();
  SCRIPT_ORDER.forEach(function(rel){
    vm.runInContext(fs.readFileSync(path.join(APP_DIR, rel), 'utf8'), ctx, {filename: rel});
  });
  // The bundled files define `FOODS` / `RECIPES_DB` directly (BUILTIN_*_DB are derived later in
  // library.js, which this tool deliberately does not load). These consts ARE the bundled builtins.
  return {
    foods: vm.runInContext('Object.keys(FOODS)', ctx),
    recipes: vm.runInContext('Object.keys(RECIPES_DB)', ctx)
  };
}

async function liveCatalog(){
  const res = await fetch(SYNC_URL + '/library/GLOBAL', {headers: {'Accept': 'application/json'}, cache: 'no-store'});
  if(!res.ok) throw new Error('GET /library/GLOBAL -> HTTP ' + res.status);
  const payload = await res.json();
  const foods = {}, recipes = {};
  (payload.foods || []).forEach(function(r){ if(r && r.id && !r.deleted_at && !r.deletedAt) foods[r.id] = r.source || 'builtin'; });
  (payload.recipes || []).forEach(function(r){ if(r && r.id && !r.deleted_at && !r.deletedAt) recipes[r.id] = r.source || 'builtin'; });
  return {foods: foods, recipes: recipes};
}

function report(kind, bundled, live){
  // BUNDLED-but-missing-from-D1 is the real hazard: shipped in code, invisible in the app.
  const missing = bundled.filter(function(id){ return !live[id]; });
  // In D1 but not bundled is EXPECTED for admin-created rows (source 'custom'); only flag a
  // D1 'builtin' row with no bundled twin, which means the bundled file dropped/renamed it.
  const orphanBuiltin = Object.keys(live).filter(function(id){ return live[id] === 'builtin' && bundled.indexOf(id) === -1; });
  return {missing: missing, orphanBuiltin: orphanBuiltin};
}

(async function main(){
  let bundled, live;
  try{ bundled = bundledIds(); }
  catch(err){ console.error('Failed to load bundled data files: ' + err.message); process.exit(2); }
  try{ live = await liveCatalog(); }
  catch(err){ console.error('Failed to fetch live catalog (' + SYNC_URL + '): ' + err.message); process.exit(2); }

  const f = report('food', bundled.foods, live.foods);
  const r = report('recipe', bundled.recipes, live.recipes);
  let drift = false;

  function section(label, res, unit){
    if(res.missing.length){
      drift = true;
      console.log('\n✗ ' + res.missing.length + ' ' + unit + '(s) in the bundled file but MISSING from the live D1 catalog');
      console.log('  (shipped in code, INVISIBLE in the app until seeded — see tools/seed-d1.js):');
      res.missing.forEach(function(id){ console.log('    - ' + id); });
    }
    if(res.orphanBuiltin.length){
      console.log('\n⚠ ' + res.orphanBuiltin.length + ' builtin ' + unit + '(s) in D1 with NO bundled twin');
      console.log('  (the bundled file dropped/renamed them; the app keeps serving the D1 copy):');
      res.orphanBuiltin.forEach(function(id){ console.log('    - ' + id); });
    }
  }
  console.log('Catalog drift: bundled files vs ' + SYNC_URL + '/library/GLOBAL');
  console.log('  bundled: ' + bundled.foods.length + ' foods, ' + bundled.recipes.length + ' recipes');
  console.log('  live D1: ' + Object.keys(live.foods).length + ' foods, ' + Object.keys(live.recipes).length + ' recipes');
  section('food', f, 'food');
  section('recipe', r, 'recipe');

  if(!drift && !f.orphanBuiltin.length && !r.orphanBuiltin.length){
    console.log('\n✓ In sync — every bundled food and recipe is present in the live catalog.');
  }
  // Only bundled-but-missing is a hard failure (the invisible-in-app bug). Orphan builtins are a
  // warning, not a failure (a deliberately curated-down catalog is allowed — see seed-d1 notes).
  process.exit(drift ? 1 : 0);
})();
