#!/usr/bin/env node
'use strict';

/* ===================================================================
   tools/check.js — zero-dependency regression harness for Mesa's
   DOM-free logic (data validation, nutrition math, couple-sync merge
   rules, planner determinism, sw.js shell-file drift, no-network).

   RUN: node tools/check.js

   HOW LOADING MIRRORS <script> TAGS: app/ is plain HTML/CSS/JS loaded
   via <script> tags into one shared global scope (README.md "How
   agents work on this repo"; file headers of state.js/engine.js/
   planner.js/sync.js) — no modules, no bundler. This harness uses
   node's `vm` module to reproduce that exactly: ONE vm.createContext
   sandbox, with every real app file run into it IN ORDER via
   vm.runInContext (APP_SCRIPT_ORDER below, taken from app/index.html's
   actual <script> order). Reusing the same context for every call
   means a top-level `let`/`const` from an earlier file (RECIPES_DB,
   PROF, ...) stays visible to functions defined in a later file, just
   like real <script> tags sharing one global object — a fresh
   vm.Script/`eval` per file would NOT share that binding. js/render.js
   and js/app.js are skipped (DOM boot/paint code; nothing under test
   lives there).

   Browser globals the loaded files touch at PARSE/LOAD time (not only
   inside functions the tests choose to call) are stubbed minimally: an
   in-memory localStorage, a no-op document, window/self/globalThis
   pointing back at the sandbox, navigator/location placeholders, and
   node's own `crypto`. `fetch` is a stub that RECORDS every call and
   rejects — this harness must never touch the network (see the
   "no-network" test at the bottom).

   MESA_TEST_TODAY (state.js:todayISO()) is set on the sandbox before
   date-sensitive tests run, so planner/plan-signature logic sees a
   fixed, real Monday instead of the host machine's current date.
   =================================================================== */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_DIR = path.join(__dirname, '..', 'app');
const FIXED_MONDAY = '2026-07-13'; // a real Monday — planner/plan-signature tests need a stable "today"

// Mirrors app/index.html's <script> order. js/render.js IS loaded (unlike app.js/vendor's
// zxing, still skipped below): its recipeDisplayIngredients()/recipeDisplayPills() helpers
// are under test (see testRecipeDisplayHelpers) and it only touches `document` inside
// functions the tests never call, so loading it is side-effect-free against the stubbed
// document below (same reasoning already applied to js/library.js's top-level
// ensureDefaultFoodIconCached() call).
const APP_SCRIPT_ORDER = [
  'data/foods.js', 'data/recipes.js', 'data/validate.js',
  'js/state.js', 'js/log.js', 'js/engine.js', 'js/planner.js', 'js/render.js',
  // 'vendor/zxing-browser.min.js' (barcode/camera) skipped
  'js/library.js', 'js/sync.js'
  // 'js/app.js' (boot/nav DOM code) skipped
];

/* ---------------- minimal browser-global stubs ---------------- */

function makeLocalStorage(){
  const store = new Map();
  return {
    getItem: function(k){ return store.has(k) ? store.get(k) : null; },
    setItem: function(k, v){ store.set(String(k), String(v)); },
    removeItem: function(k){ store.delete(k); },
    clear: function(){ store.clear(); },
    key: function(i){ return Array.from(store.keys())[i] || null; }
  };
}

function noop(){}
function fakeEl(){
  return {
    style: {}, children: [], classList: {add: noop, remove: noop, contains: function(){ return false; }},
    addEventListener: noop, removeEventListener: noop, setAttribute: noop, appendChild: noop
  };
}
function makeDocumentStub(){
  return {
    getElementById: function(){ return null; }, querySelector: function(){ return null; }, querySelectorAll: function(){ return []; },
    createElement: fakeEl, addEventListener: noop, removeEventListener: noop,
    cookie: '', body: fakeEl(), documentElement: fakeEl()
  };
}

// Records every attempted call and rejects — the app must never actually reach
// the network from this harness (see the "no-network" test at the bottom).
const fetchCalls = [];
function fetchStub(url){
  fetchCalls.push(String(url));
  return Promise.reject(new Error('tools/check.js: fetch() attempted (' + url + ') — the harness must stay offline'));
}

function createMesaContext(){
  const sandbox = {
    console: console,
    localStorage: makeLocalStorage(),
    navigator: {userAgent: 'mesa-check-harness/node'},
    location: {protocol: 'file:', host: 'localhost', hostname: 'localhost', href: 'http://localhost/'},
    crypto: globalThis.crypto,
    fetch: fetchStub,
    setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval
  };
  sandbox.document = makeDocumentStub();
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // js/library.js runs ensureDefaultFoodIconCached() at load (a top-level call,
  // not inside a function the tests choose to invoke). It only calls fetch()
  // when the icon isn't already cached — pre-seed the cache key it checks
  // (DEFAULT_FOOD_ICON_STORAGE_KEY) so simply LOADING the app can't cost a
  // network attempt on its own.
  sandbox.localStorage.setItem('mesa.defaultFoodIcon.v1', 'data:image/png;base64,AA==');
  return sandbox;
}

function loadAppInto(ctx){
  APP_SCRIPT_ORDER.forEach(function(rel){
    const full = path.join(APP_DIR, rel);
    vm.runInContext(fs.readFileSync(full, 'utf8'), ctx, {filename: full});
  });
}

/* ---------------- vm access helpers ----------------
   Top-level `let`/`const` bindings from the loaded app files (RECIPES_DB,
   PROF, weekPlans, ...) are NOT exposed as properties on the sandbox object
   (only `var`s/implicit globals are) — they live in the context's persistent
   lexical environment instead. Reading or calling them always goes back
   through vm.runInContext so we see the live, current binding, never a stale
   one captured too early. */
function get(ctx, name){ return vm.runInContext(name, ctx); }
function run(ctx, code){ return vm.runInContext(code, ctx); }
function call(ctx, name, args){
  ctx.__checkArgs__ = args || [];
  try{ return vm.runInContext(name + '.apply(null, __checkArgs__)', ctx); }
  finally{ delete ctx.__checkArgs__; }
}
function cloneJSON(v){ return JSON.parse(JSON.stringify(v)); }

/* ---------------- tiny test runner ---------------- */
const results = [];
function pass(name){ results.push({name: name, status: 'pass'}); }
function fail(name, detail){ results.push({name: name, status: 'fail', detail: detail}); }
// Reserved for a test that fails against CURRENT app code because it caught a
// real pre-existing bug — printed, but doesn't fail the process. Unused unless
// a test run turns one up (see this file's final-report convention).
function knownFail(name, detail){ results.push({name: name, status: 'known-fail', detail: detail}); } // eslint-disable-line no-unused-vars
function assert(cond, name, detail){ if(cond) pass(name); else fail(name, detail || 'assertion failed'); }
function runTest(name, fn){
  try{ fn(); }
  catch(e){ fail(name, e && e.stack ? e.stack : String(e)); }
}

/* ===================================================================
   TESTS
   =================================================================== */

// data/validate.js: validateData() must report ok:true against the real DB.
function testValidateData(ctx){
  const r = call(ctx, 'validateData', []);
  assert(!!r && r.ok === true, 'data: validateData() reports ok === true',
    'errors=' + JSON.stringify(r && r.errors) + ' warnings=' + JSON.stringify(r && r.warnings));
}

// engine.js:recipeNutrition — internal kcal consistency, servings scaling, purity.
function testNutritionDeterminism(ctx){
  const RECIPES_DB = get(ctx, 'RECIPES_DB');
  const ids = Object.keys(RECIPES_DB);
  assert(ids.length > 0, 'nutrition: RECIPES_DB is non-empty', 'RECIPES_DB has 0 ids');

  const kcalBad = [];
  ids.forEach(function(id){
    const t = call(ctx, 'recipeNutrition', [id, 1]).totals;
    if(Math.abs((4 * t.protein + 4 * t.carbs + 9 * t.fat) - t.kcal) > 1e-6) kcalBad.push(id);
  });
  assert(kcalBad.length === 0, 'nutrition: recipeNutrition().totals.kcal === 4*protein + 4*carbs + 9*fat for every RECIPES_DB id',
    'ids failing: ' + kcalBad.join(', '));

  const keys = ['kcal', 'protein', 'carbs', 'fat', 'satFat', 'fiber', 'sugars', 'freeSugars'];
  const servingsIds = ids.filter(function(id){ return typeof RECIPES_DB[id].servings === 'number' && RECIPES_DB[id].servings > 1; });
  const perServingBad = [];
  servingsIds.forEach(function(id){
    const servings = RECIPES_DB[id].servings;
    const n = call(ctx, 'recipeNutrition', [id, servings]);
    keys.forEach(function(k){ if(Math.abs(n.perServing[k] * servings - n.totals[k]) > 1e-6) perServingBad.push(id + '.' + k); });
  });
  // As of this writing every real RECIPES_DB entry defaults to batch yield 1 (no
  // recipe sets `servings` > 1) — a fact about the current data, not a bug, so it
  // can't be asserted against. Exercise the same recipeNutrition() code path
  // (batchYield division + perServing derivation) with one synthetic fixture
  // recipe instead, added to RECIPES_DB just for this check and removed right
  // after so it can never leak into a later test (planner selection, etc).
  const fixtureId = '__check_servings_fixture__';
  run(ctx, "RECIPES_DB['" + fixtureId + "'] = {ingredients: [['eggs', 150], ['mixed-berries', 300]], servings: 4};");
  try{
    const n = call(ctx, 'recipeNutrition', [fixtureId, 4]);
    keys.forEach(function(k){ if(Math.abs(n.perServing[k] * 4 - n.totals[k]) > 1e-6) perServingBad.push(fixtureId + '.' + k); });
  } finally { run(ctx, "delete RECIPES_DB['" + fixtureId + "'];"); }
  assert(perServingBad.length === 0,
    'nutrition: perServing * servings === totals (real servings>1 recipes, plus a synthetic fixture since none exist in RECIPES_DB today)',
    'fields failing: ' + perServingBad.join(', ') + (servingsIds.length === 0 ? ' [note: 0 real recipes with servings > 1 right now]' : ''));

  const sampleId = ids[0];
  const a = JSON.stringify(call(ctx, 'recipeNutrition', [sampleId, 1]));
  const b = JSON.stringify(call(ctx, 'recipeNutrition', [sampleId, 1]));
  assert(a === b, 'nutrition: recipeNutrition() returns identical JSON on repeat calls (purity)', 'first=' + a + ' second=' + b);
}

// engine.js:foodMacros — linear in grams for both per-100g and unit:'piece' foods.
function testFoodMacrosLinearity(ctx){
  const FOODS = get(ctx, 'FOODS');
  const candidateIds = ['eggs', 'mixed-berries', 'chicken-breast'].filter(function(id){ return !!FOODS[id]; });
  assert(candidateIds.length >= 2, 'foodMacros: at least 2 sample foods available (one per-100g, one unit:piece)',
    'found only: ' + candidateIds.join(', '));

  const keys = ['kcal', 'protein', 'carbs', 'fat', 'satFat', 'fiber', 'sugars', 'freeSugars'];
  const bad = [];
  const x = 37; // arbitrary non-round grams so a scaling bug can't hide behind factor-of-1 coincidences
  candidateIds.forEach(function(id){
    const m1 = call(ctx, 'foodMacros', [id, x]);
    const m2 = call(ctx, 'foodMacros', [id, 2 * x]);
    keys.forEach(function(k){ if(Math.abs(m2[k] - 2 * m1[k]) > 1e-9) bad.push(id + '.' + k); });
  });
  assert(bad.length === 0, 'foodMacros: foodMacros(id, 2x) === 2 * foodMacros(id, x) fieldwise, per-100g and unit:piece foods alike',
    'fields failing: ' + bad.join(', '));
}

/* ---------------- render.js recipe-display helpers (compat-view removal) ----------------
   render.js used to read a second, hand-synchronized object (state.js:RECIPES, built by
   the now-deleted buildLegacyRecipesCompat()) for the recipe screen's display shape. That's
   gone: render.js reads RECIPES_DB directly plus two small on-demand helpers,
   recipeDisplayIngredients(id) and recipeDisplayPills(id). These EXPECTED_* values were
   captured by calling the OLD buildLegacyRecipesCompat() against the real data before it
   was deleted (see the migration's report for the exact capture command) and are now frozen
   literals, so this test guards the new helpers against ever silently drifting from what
   users saw before the refactor — for three representative recipes: 'salmon' (one of the
   original 10 legacy mockup ids, has toTaste entries), 'omelette' (legacy id, has a
   piece-unit ingredient — 150g eggs at avgG 50 -> 3 whole eggs — plus toTaste entries), and
   'chicken-couscous-salad' (a non-legacy RECIPES_DB entry with toTaste but no piece-unit
   ingredient, exercising the "every RECIPES_DB id" path task C2 added). */
const EXPECTED_RECIPE_DISPLAY = {
  salmon: {
    emoji: '🐟',
    title: 'Baked salmon, quinoa & greens',
    time: '25 min',
    kcal: 602,
    protein: 41,
    tags: [['berry', 'Thyroid-friendly'], ['', 'Omega-3'], ['', 'Low-GI'], ['terra', 'High protein']],
    ingredients: [
      ['Salmon fillet, raw (Atlantic)', 140, 'g'],
      ['Quinoa, dry (uncooked)', 60, 'g'],
      ['Spinach, baby leaf, raw', 40, 'g'],
      ['Broccoli, raw', 100, 'g'],
      ['Olive oil, extra virgin', 5, 'ml'],
      ['Lemon', null, 'to taste'],
      ['Garlic', null, 'to taste']
    ],
    method: [
      'Rinse quinoa, simmer in 2x water for 15 min until fluffy.',
      'Rub salmon with olive oil, lemon, garlic. Bake at 200C for 12-14 min.',
      'Steam broccoli; wilt spinach in the warm pan.',
      'Plate quinoa, greens, salmon. Finish with lemon and olive oil.'
    ]
  },
  omelette: {
    emoji: '🍳',
    title: 'Veggie omelette & rye toast',
    time: '12 min',
    kcal: 433,
    protein: 25,
    tags: [['terra', 'High protein'], ['berry', 'Thyroid-friendly']],
    ingredients: [
      ['Eggs, whole', 3, ''],
      ['Bell pepper, red, raw', 50, 'g'],
      ['Spinach, baby leaf, raw', 30, 'g'],
      ['Rye bread', 60, 'g'],
      ['Olive oil, extra virgin', 5, 'ml'],
      ['Herbs', null, 'to taste'],
      ['Black pepper', null, 'to taste']
    ],
    method: [
      'Whisk eggs; saute peppers and spinach in olive oil.',
      'Pour eggs over the veg and cook gently until just set.',
      'Toast the rye bread and plate alongside the omelette.'
    ]
  },
  'chicken-couscous-salad': {
    emoji: '🥗',
    title: 'Chicken & couscous salad',
    time: '20 min',
    kcal: 553,
    protein: 52,
    tags: [['terra', 'High protein'], ['', 'Heart-smart']],
    ingredients: [
      ['Chicken breast, grilled, skinless', 130, 'g'],
      ['Couscous, dry', 80, 'g'],
      ['Cherry tomatoes, raw', 80, 'g'],
      ['Cucumber, raw, with peel', 60, 'g'],
      ['Olive oil, extra virgin', 5, 'ml'],
      ['Lemon', null, 'to taste'],
      ['Herbs', null, 'to taste']
    ],
    method: [
      'Cook couscous per pack instructions and fluff with a fork.',
      'Grill or pan-sear the chicken until cooked through, then slice.',
      'Toss couscous with tomatoes and cucumber.',
      'Top with chicken, olive oil, lemon and herbs.'
    ]
  }
};

function testRecipeDisplayHelpers(ctx){
  const RECIPES_DB = get(ctx, 'RECIPES_DB');
  Object.keys(EXPECTED_RECIPE_DISPLAY).forEach(function(id){
    const expected = EXPECTED_RECIPE_DISPLAY[id];
    const src = RECIPES_DB[id];
    assert(!!src, 'recipe display (' + id + '): still present in RECIPES_DB', 'RECIPES_DB has no id "' + id + '"');
    if(!src) return;

    assert(src.emoji === expected.emoji, 'recipe display (' + id + '): RECIPES_DB[id].emoji matches the frozen value', 'got ' + JSON.stringify(src.emoji));
    assert(src.title === expected.title, 'recipe display (' + id + '): RECIPES_DB[id].title matches the frozen value', 'got ' + JSON.stringify(src.title));
    const time = src.time + ' min';
    assert(time === expected.time, 'recipe display (' + id + '): RECIPES_DB[id].time + \' min\' matches the frozen value', 'got ' + JSON.stringify(time));
    assert(JSON.stringify(src.steps) === JSON.stringify(expected.method), 'recipe display (' + id + '): RECIPES_DB[id].steps matches the frozen "method" value', 'got ' + JSON.stringify(src.steps));

    const nut = call(ctx, 'recipeNutrition', [id, 1]).totals;
    const kcal = Math.round(nut.kcal), protein = Math.round(nut.protein);
    assert(kcal === expected.kcal, 'recipe display (' + id + '): Math.round(recipeNutrition(id,1).totals.kcal) matches the frozen value', 'got ' + kcal);
    assert(protein === expected.protein, 'recipe display (' + id + '): Math.round(recipeNutrition(id,1).totals.protein) matches the frozen value', 'got ' + protein);

    const pills = call(ctx, 'recipeDisplayPills', [id]);
    assert(JSON.stringify(pills) === JSON.stringify(expected.tags), 'recipeDisplayPills(' + JSON.stringify(id) + ') matches the frozen "tags" value', 'got ' + JSON.stringify(pills));

    const ingredients = call(ctx, 'recipeDisplayIngredients', [id]);
    assert(JSON.stringify(ingredients) === JSON.stringify(expected.ingredients), 'recipeDisplayIngredients(' + JSON.stringify(id) + ') matches the frozen "ingredients" value', 'got ' + JSON.stringify(ingredients));
  });
}

// Guard against the deleted RECIPES compat view (state.js:buildLegacyRecipesCompat(),
// removed) creeping back in: no app/js/*.js source file may reference a bare `RECIPES`
// identifier outside of `RECIPES_DB`/`RECIPE_SLOT_DB` — every reader must go through
// RECIPES_DB + engine.js/render.js helpers instead (mirrors the escaping-helpers
// "defined exactly once" guard style above).
function testNoLegacyRecipesCompatView(){
  const jsDir = path.join(APP_DIR, 'js');
  const files = fs.readdirSync(jsDir).filter(function(f){ return f.endsWith('.js'); });
  const bareRe = /\bRECIPES\b(?!_DB)/;
  const offenders = [];
  files.forEach(function(f){
    const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
    src.split('\n').forEach(function(line, i){
      // RECIPE_SLOT_DB doesn't start with "RECIPES" so bareRe can't false-positive on it;
      // only RECIPES_DB itself needs the negative lookahead above.
      if(bareRe.test(line)) offenders.push(f + ':' + (i + 1) + ': ' + line.trim());
    });
  });
  assert(offenders.length === 0, 'no bare RECIPES reference remains outside RECIPES_DB/RECIPE_SLOT_DB in app/js/*.js',
    offenders.join(' | '));
}

/* ---------------- sync.js merge tests ---------------- */

function emptyLibrarySection(){
  return {customFoods: {}, foodOverrides: {}, customRecipes: {}, recipeOverrides: {}, deletedRecipes: {}, deletedFoods: {}, recipePrefs: {}};
}

// mergeLibrarySection case (a): same id edited on both sides with different `u`
// stamps — the newer wins regardless of which side is passed as `local`.
function testMergeLibraryNewerWins(ctx){
  const local = emptyLibrarySection();
  local.customRecipes['cr-test'] = {title: 'Local version', u: 1000};
  const remote = emptyLibrarySection();
  remote.customRecipes['cr-test'] = {title: 'Remote version', u: 2000};
  const mergedLR = call(ctx, 'mergeLibrarySection', [cloneJSON(local), cloneJSON(remote)]);
  const mergedRL = call(ctx, 'mergeLibrarySection', [cloneJSON(remote), cloneJSON(local)]);
  assert(!!mergedLR.customRecipes['cr-test'] && mergedLR.customRecipes['cr-test'].title === 'Remote version',
    'mergeLibrarySection: newer `u` wins (local, remote)', 'got ' + JSON.stringify(mergedLR.customRecipes['cr-test']));
  assert(!!mergedRL.customRecipes['cr-test'] && mergedRL.customRecipes['cr-test'].title === 'Remote version',
    'mergeLibrarySection: newer `u` wins regardless of argument order (remote, local)', 'got ' + JSON.stringify(mergedRL.customRecipes['cr-test']));
}

// mergeLibrarySection case (b): a newer tombstone beats an older edit, repeated
// alternating merges don't resurrect it, and the converged result is idempotent.
function testMergeLibraryTombstoneIdempotence(ctx){
  const editedLocal = emptyLibrarySection();
  editedLocal.customRecipes['cr-gone'] = {title: 'Edited before the delete synced', u: 1000};
  const tombstonedRemote = emptyLibrarySection();
  tombstonedRemote.deletedRecipes['cr-gone'] = 2000; // newer than the edit above

  const merged1 = call(ctx, 'mergeLibrarySection', [cloneJSON(editedLocal), cloneJSON(tombstonedRemote)]);
  assert(!merged1.customRecipes['cr-gone'], 'mergeLibrarySection: a newer tombstone beats an older edit',
    'got customRecipes["cr-gone"] = ' + JSON.stringify(merged1.customRecipes['cr-gone']));
  assert(merged1.deletedRecipes['cr-gone'] === 2000, 'mergeLibrarySection: tombstone timestamp survives the merge',
    'got ' + JSON.stringify(merged1.deletedRecipes['cr-gone']));

  // Repeated alternating merges (A->B, B->A, A->B) must not resurrect the tombstoned id.
  let m = call(ctx, 'mergeLibrarySection', [cloneJSON(editedLocal), cloneJSON(tombstonedRemote)]);
  m = call(ctx, 'mergeLibrarySection', [cloneJSON(m), cloneJSON(editedLocal)]);
  m = call(ctx, 'mergeLibrarySection', [cloneJSON(m), cloneJSON(tombstonedRemote)]);
  assert(!m.customRecipes['cr-gone'], 'mergeLibrarySection: alternating merges (A->B->A->B) never resurrect a tombstoned entry',
    'got ' + JSON.stringify(m.customRecipes['cr-gone']));

  // Idempotence: merging the converged result with either original input again is a no-op.
  const again1 = call(ctx, 'mergeLibrarySection', [cloneJSON(m), cloneJSON(editedLocal)]);
  const again2 = call(ctx, 'mergeLibrarySection', [cloneJSON(m), cloneJSON(tombstonedRemote)]);
  assert(JSON.stringify(again1) === JSON.stringify(m), 'mergeLibrarySection: merging the converged result with the local input again is a no-op',
    'converged=' + JSON.stringify(m) + ' after=' + JSON.stringify(again1));
  assert(JSON.stringify(again2) === JSON.stringify(m), 'mergeLibrarySection: merging the converged result with the remote input again is a no-op',
    'converged=' + JSON.stringify(m) + ' after=' + JSON.stringify(again2));
}

// mergeLibrarySection case (c): the duplication-ratchet regression — several
// simulated sync round-trips of the same two sides must never grow the total
// entry count (the original incident: mergeImportedLibrary re-cloned a same-id
// conflict bigger every round; mergeLibrarySection's newer-wins + deterministic
// tie-break must converge instead).
function testMergeLibraryRatchetRegression(ctx){
  function countEntries(section){
    return Object.keys(section.customFoods).length + Object.keys(section.customRecipes).length
      + Object.keys(section.foodOverrides).length + Object.keys(section.recipeOverrides).length;
  }
  const sideA = emptyLibrarySection();
  sideA.customRecipes['cr-ratchet'] = {title: 'Ratchet from A', u: 5000};
  const sideB = emptyLibrarySection();
  sideB.customRecipes['cr-ratchet'] = {title: 'Ratchet from B', u: 5000}; // exact-tie `u`, different content — the historically dangerous case

  let merged = call(ctx, 'mergeLibrarySection', [cloneJSON(sideA), cloneJSON(sideB)]);
  const counts = [countEntries(merged)];
  for(let i = 0; i < 6; i++){
    merged = call(ctx, 'mergeLibrarySection', [cloneJSON(merged), cloneJSON(sideA)]);
    merged = call(ctx, 'mergeLibrarySection', [cloneJSON(merged), cloneJSON(sideB)]);
    counts.push(countEntries(merged));
  }
  assert(counts.every(function(c){ return c === 1; }),
    'mergeLibrarySection: repeated sync round-trips never grow the entry count (duplication-ratchet regression)',
    'entry counts over rounds: ' + counts.join(', '));
}

// mergeLogSection: dedupe by identity, tombstone exclusion, plan:<slot> newer-wins,
// and a re-confirm surviving a same-slot skip tombstone (the v55 fix this guards).
function testMergeLogSection(ctx){
  const DATE = '2026-07-13';
  function emptyLogDay(){ return {entries: [], tomb: [], target: null, skipped: {}}; }

  // (a) same-identity entries on both sides dedupe to one.
  {
    const local = {}; local[DATE] = emptyLogDay();
    local[DATE].entries.push({kind: 'food', ref: 'eggs', grams: 100, id: 'food-a', u: 1000, t: '08:00',
      kcal: 150, protein: 12, carbs: 1, fat: 10, satFat: 3, fiber: 0, sugars: 0, freeSugars: 0});
    const remote = {}; remote[DATE] = emptyLogDay();
    remote[DATE].entries.push(cloneJSON(local[DATE].entries[0]));
    const merged = call(ctx, 'mergeLogSection', [cloneJSON(local), cloneJSON(remote)]);
    assert(merged[DATE].entries.length === 1, 'mergeLogSection: same-identity entries on both sides dedupe to one',
      'got ' + merged[DATE].entries.length + ' entries: ' + JSON.stringify(merged[DATE].entries));
  }
  // (b) a tombstoned entry (older than the tombstone) does not come back.
  {
    const local = {}; local[DATE] = emptyLogDay();
    local[DATE].tomb.push({id: 'food:food-b', u: 5000});
    const remote = {}; remote[DATE] = emptyLogDay();
    remote[DATE].entries.push({kind: 'food', ref: 'eggs', grams: 100, id: 'food-b', u: 1000, t: '08:00',
      kcal: 150, protein: 12, carbs: 1, fat: 10, satFat: 3, fiber: 0, sugars: 0, freeSugars: 0});
    const merged = call(ctx, 'mergeLogSection', [cloneJSON(local), cloneJSON(remote)]);
    const survived = merged[DATE].entries.some(function(e){ return e.id === 'food-b'; });
    assert(!survived, 'mergeLogSection: a tombstoned entry does not come back', 'entries: ' + JSON.stringify(merged[DATE].entries));
  }
  // (c) a 'plan:<slot>' entry with a newer `u` replaces an older one for the same slot.
  {
    const local = {}; local[DATE] = emptyLogDay();
    local[DATE].entries.push({kind: 'plan', slot: 'lunch', ref: 'lentil', portion: 1, u: 1000, t: '12:00',
      kcal: 500, protein: 25, carbs: 60, fat: 15, satFat: 3, fiber: 8, sugars: 5, freeSugars: 2});
    const remote = {}; remote[DATE] = emptyLogDay();
    remote[DATE].entries.push({kind: 'plan', slot: 'lunch', ref: 'salmon', portion: 1, u: 2000, t: '12:30',
      kcal: 550, protein: 40, carbs: 45, fat: 20, satFat: 4, fiber: 5, sugars: 3, freeSugars: 1});
    const merged = call(ctx, 'mergeLogSection', [cloneJSON(local), cloneJSON(remote)]);
    assert(merged[DATE].entries.length === 1 && merged[DATE].entries[0].ref === 'salmon',
      'mergeLogSection: a newer plan:<slot> entry replaces the older one for the same slot', 'entries: ' + JSON.stringify(merged[DATE].entries));
  }
  // (d) a re-confirm AFTER a skip tombstone (entry `u` newer than the tombstone `u`)
  // survives the merge and the stale tombstone is dropped (the v55 fix).
  {
    const local = {}; local[DATE] = emptyLogDay();
    local[DATE].tomb.push({id: 'plan:breakfast', u: 1000}); // the earlier skip
    const remote = {}; remote[DATE] = emptyLogDay();
    remote[DATE].entries.push({kind: 'plan', slot: 'breakfast', ref: 'omelette', portion: 1, u: 1500, t: '08:00',
      kcal: 350, protein: 22, carbs: 20, fat: 18, satFat: 5, fiber: 3, sugars: 2, freeSugars: 0}); // the later re-confirm
    const merged = call(ctx, 'mergeLogSection', [cloneJSON(local), cloneJSON(remote)]);
    const survived = merged[DATE].entries.some(function(e){ return e.kind === 'plan' && e.slot === 'breakfast' && e.ref === 'omelette'; });
    const tombLeft = merged[DATE].tomb.some(function(t){ return t.id === 'plan:breakfast'; });
    assert(survived && !tombLeft, 'mergeLogSection: a re-confirm newer than a skip tombstone survives the merge and clears the tombstone',
      'entries: ' + JSON.stringify(merged[DATE].entries) + ' tomb: ' + JSON.stringify(merged[DATE].tomb));
  }
}

// mergePlansSection: two copies of the same week plan (same signature) where
// side A mutates one meal cell and side B mutates a DIFFERENT one — both survive.
function testMergePlansSection(ctx){
  function half(recipeId, portion, kcal, protein, t){ return {recipeId: recipeId, portion: portion, kcal: kcal, protein: protein, t: t}; }
  function baseDay(label){
    return {date: label, meals: {
      breakfast: {shared: false, elena: half('omelette', 1, 350, 20, 1000), partner: half('omelette', 1.5, 500, 30, 1000)},
      lunch: {shared: false, elena: half('lentil', 1, 500, 25, 1000), partner: half('lentil', 1.5, 700, 35, 1000)},
      dinner: {shared: true, recipeId: 'salmongreens', t: 1000, elena: half('salmongreens', 1, 450, 35, 1000), partner: half('salmongreens', 1.5, 650, 50, 1000)},
      snack: {shared: false, elena: half('yogurt', 1, 200, 15, 1000), partner: half('yogurt', 1, 200, 15, 1000)}
    }};
  }
  function basePlan(monday, signature){
    const days = [];
    for(let i = 0; i < 7; i++) days.push(baseDay(monday + '#day' + i));
    return {v: 1, weekStartDate: monday, signature: signature, days: days};
  }
  const monday = '2026-07-13', sig = 'test-signature';
  const localPlan = basePlan(monday, sig);
  const remotePlan = cloneJSON(localPlan);

  // Side A (local): a newer per-person mutation on day 0's solo breakfast (elena only).
  localPlan.days[0].meals.breakfast.elena = half('skyrbowl', 1, 300, 22, 5000);
  // Side B (remote): a newer mutation on a DIFFERENT cell — day 0's shared dinner.
  remotePlan.days[0].meals.dinner = {shared: true, recipeId: 'tunasalad', t: 5000,
    elena: half('tunasalad', 1, 400, 38, 5000), partner: half('tunasalad', 1.5, 600, 55, 5000)};

  function plansSection(plan){
    const weekPlans = {}; weekPlans[monday] = plan;
    return {weekPlans: weekPlans, mealPins: {}, mealRules: [],
      SHARED: {breakfast: false, lunch: false, dinner: true, snack: false}, householdStyle: 'balanced', servings: {svE: 1, svM: 1.5, svS: 1}};
  }

  const merged = call(ctx, 'mergePlansSection', [cloneJSON(plansSection(localPlan)), cloneJSON(plansSection(remotePlan)), false]);
  const day0 = merged.weekPlans[monday].days[0];
  assert(day0.meals.breakfast.elena.recipeId === 'skyrbowl', "mergePlansSection: side A's newer per-person mutation (breakfast) is kept",
    'got ' + JSON.stringify(day0.meals.breakfast.elena));
  assert(day0.meals.dinner.recipeId === 'tunasalad', "mergePlansSection: side B's newer mutation on a DIFFERENT cell (dinner) is also kept",
    'got ' + JSON.stringify(day0.meals.dinner));
}

/* ---------------- planner.js determinism ---------------- */

function testPlannerDeterminism(ctx){
  run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "';");

  run(ctx, 'weekPlans = {}; weekPlan = null;');
  const plan1 = call(ctx, 'ensureWeekPlan', []);
  const json1 = JSON.stringify(plan1);
  run(ctx, 'weekPlans = {}; weekPlan = null;');
  const plan2 = call(ctx, 'ensureWeekPlan', []);
  const json2 = JSON.stringify(plan2);
  assert(json1 === json2, 'planner: ensureWeekPlan() produces byte-identical JSON across two fresh generations for the same Monday',
    'lengths differ or content differs (len1=' + json1.length + ', len2=' + json2.length + ')');

  const RECIPES_DB = get(ctx, 'RECIPES_DB');
  const PROF = get(ctx, 'PROF');
  const problems = [];
  plan1.days.forEach(function(day, di){
    Object.keys(day.meals).forEach(function(slot){
      const m = day.meals[slot];
      ['elena', 'partner'].forEach(function(person){
        const half = m && m[person];
        if(!half || !half.recipeId){ problems.push('day' + di + ' ' + slot + ' ' + person + ': missing recipeId'); return; }
        const recipe = RECIPES_DB[half.recipeId];
        if(!recipe){ problems.push('day' + di + ' ' + slot + ' ' + person + ': unknown recipeId "' + half.recipeId + '"'); return; }
        if(call(ctx, 'recipeHitsAvoid', [recipe, PROF[person].avoid])){
          problems.push('day' + di + ' ' + slot + ' ' + person + ': "' + half.recipeId + '" hits ' + person + "'s avoid list");
        }
      });
    });
  });
  assert(problems.length === 0, "planner: every planned meal has a real recipeId and respects that person's avoid list", problems.join('; '));
}

/* ---------------- planner.js meal-extras (add/remove/set) ----------------
   dayIndex 0 of a FIXED_MONDAY plan always has lunch.shared === false and
   dinner.shared === true (household SHARED defaults, not randomized), so
   those two slots stand in for the SOLO and SHARED cases below. 'yogurt'
   (a real RECIPES_DB id) and 'spinach' (a real FOODS id) are used as the
   extra being added/removed/adjusted — distinct from whatever base recipe
   the planner picked for lunch/dinner that week. */

function testMealExtras(ctx){
  function freshPlan(){
    run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "';");
    run(ctx, 'weekPlans = {}; weekPlan = null;');
    const plan = call(ctx, 'ensureWeekPlan', []);
    return {wk: plan.weekStartDate, weekPlans: get(ctx, 'weekPlans')};
  }
  function cell(state, slot){ return state.weekPlans[state.wk].days[0].meals[slot]; }
  function entry(state, slot, person){ return cell(state, slot)[person]; }
  function hasNoExtras(e){ return !Array.isArray(e.extras) || e.extras.length === 0; }

  /* ============================= recipe-extra variant ============================= */

  // (a) add to a SHARED meal (dinner): extras appear on BOTH persons; meal.t stamped.
  (function(){
    const s = freshPlan();
    const ok = call(ctx, 'addExtraRecipeToMeal', [s.wk, 0, 'dinner', 'elena', 'yogurt']);
    assert(ok === true, 'addExtraRecipeToMeal: shared add returns true', 'got ' + ok);
    const e = entry(s, 'dinner', 'elena'), p = entry(s, 'dinner', 'partner');
    assert(Array.isArray(e.extras) && e.extras.length === 1 && e.extras[0].recipeId === 'yogurt' && e.extras[0].portion === 1,
      'addExtraRecipeToMeal: shared add appends {recipeId, portion:1} to the acting person', JSON.stringify(e.extras));
    assert(Array.isArray(p.extras) && p.extras.length === 1 && p.extras[0].recipeId === 'yogurt',
      'addExtraRecipeToMeal: shared add mirrors the same push onto the OTHER person', JSON.stringify(p.extras));
    assert(typeof cell(s, 'dinner').t === 'number', 'addExtraRecipeToMeal: shared add stamps meal.t', 'meal.t=' + cell(s, 'dinner').t);
  })();

  // (b) add to a SOLO meal (lunch): extra only on the acting person; entry.t stamped, meal.t cleared.
  (function(){
    const s = freshPlan();
    const ok = call(ctx, 'addExtraRecipeToMeal', [s.wk, 0, 'lunch', 'elena', 'yogurt']);
    assert(ok === true, 'addExtraRecipeToMeal: solo add returns true', 'got ' + ok);
    const e = entry(s, 'lunch', 'elena'), p = entry(s, 'lunch', 'partner');
    assert(Array.isArray(e.extras) && e.extras.length === 1 && e.extras[0].recipeId === 'yogurt',
      'addExtraRecipeToMeal: solo add appends to the acting person only', JSON.stringify(e.extras));
    assert(hasNoExtras(p), 'addExtraRecipeToMeal: solo add does not touch the other person', JSON.stringify(p.extras));
    assert(typeof e.t === 'number', 'addExtraRecipeToMeal: solo add stamps entry.t', 'entry.t=' + e.t);
    assert(cell(s, 'lunch').t === undefined, 'addExtraRecipeToMeal: solo add clears meal.t', 'meal.t=' + cell(s, 'lunch').t);
  })();

  // (c) remove reverses the add, same stamp semantics, both shared and solo.
  (function(){
    const s = freshPlan();
    call(ctx, 'addExtraRecipeToMeal', [s.wk, 0, 'dinner', 'elena', 'yogurt']);
    const ok = call(ctx, 'removeExtraRecipeFromMeal', [s.wk, 0, 'dinner', 'elena', 'yogurt']);
    assert(ok === true, 'removeExtraRecipeFromMeal: shared remove returns true', 'got ' + ok);
    const e = entry(s, 'dinner', 'elena'), p = entry(s, 'dinner', 'partner');
    assert(hasNoExtras(e), 'removeExtraRecipeFromMeal: shared remove clears the acting person\'s extras', JSON.stringify(e.extras));
    assert(hasNoExtras(p), 'removeExtraRecipeFromMeal: shared remove mirrors the removal onto the other person', JSON.stringify(p.extras));
    assert(typeof cell(s, 'dinner').t === 'number', 'removeExtraRecipeFromMeal: shared remove stamps meal.t', 'meal.t=' + cell(s, 'dinner').t);
  })();
  (function(){
    const s = freshPlan();
    call(ctx, 'addExtraRecipeToMeal', [s.wk, 0, 'lunch', 'elena', 'yogurt']);
    const ok = call(ctx, 'removeExtraRecipeFromMeal', [s.wk, 0, 'lunch', 'elena', 'yogurt']);
    assert(ok === true, 'removeExtraRecipeFromMeal: solo remove returns true', 'got ' + ok);
    const e = entry(s, 'lunch', 'elena');
    assert(hasNoExtras(e), 'removeExtraRecipeFromMeal: solo remove clears the acting person\'s extras', JSON.stringify(e.extras));
    assert(typeof e.t === 'number', 'removeExtraRecipeFromMeal: solo remove stamps entry.t', 'entry.t=' + e.t);
    assert(cell(s, 'lunch').t === undefined, 'removeExtraRecipeFromMeal: solo remove clears meal.t', 'meal.t=' + cell(s, 'lunch').t);
  })();
  // Removing a recipeId no longer present in RECIPES_DB must still work (unlike add,
  // remove intentionally does not validate against the DB).
  (function(){
    const s = freshPlan();
    call(ctx, 'addExtraRecipeToMeal', [s.wk, 0, 'lunch', 'elena', 'yogurt']);
    ctx.__savedYogurt__ = get(ctx, "RECIPES_DB['yogurt']");
    run(ctx, "delete RECIPES_DB['yogurt'];");
    const ok = call(ctx, 'removeExtraRecipeFromMeal', [s.wk, 0, 'lunch', 'elena', 'yogurt']);
    run(ctx, "RECIPES_DB['yogurt'] = __savedYogurt__;");
    delete ctx.__savedYogurt__;
    assert(ok === true, 'removeExtraRecipeFromMeal: removes an extra whose recipeId was since deleted from RECIPES_DB', 'got ' + ok);
    assert(!!get(ctx, "RECIPES_DB['yogurt']"), 'test hygiene: RECIPES_DB[\'yogurt\'] was restored after the delete-from-DB check', '');
  })();

  // (d) set portion updates the LAST matching extra: both sides for shared, one side for solo.
  (function(){
    const s = freshPlan();
    call(ctx, 'addExtraRecipeToMeal', [s.wk, 0, 'dinner', 'elena', 'yogurt']);
    call(ctx, 'addExtraRecipeToMeal', [s.wk, 0, 'dinner', 'elena', 'yogurt']); // duplicate
    const ok = call(ctx, 'setExtraRecipePortion', [s.wk, 0, 'dinner', 'elena', 'yogurt', 2.5]);
    assert(ok === true, 'setExtraRecipePortion: shared set returns true', 'got ' + ok);
    const e = entry(s, 'dinner', 'elena'), p = entry(s, 'dinner', 'partner');
    assert(e.extras.length === 2 && e.extras[0].portion === 1 && e.extras[1].portion === 2.5,
      'setExtraRecipePortion: shared set updates only the LAST matching extra (self)', JSON.stringify(e.extras));
    assert(p.extras.length === 2 && p.extras[0].portion === 1 && p.extras[1].portion === 2.5,
      'setExtraRecipePortion: shared set mirrors the same update onto the other person\'s LAST matching extra', JSON.stringify(p.extras));
  })();
  (function(){
    const s = freshPlan();
    call(ctx, 'addExtraRecipeToMeal', [s.wk, 0, 'lunch', 'elena', 'yogurt']);
    call(ctx, 'addExtraRecipeToMeal', [s.wk, 0, 'lunch', 'elena', 'yogurt']); // duplicate
    const ok = call(ctx, 'setExtraRecipePortion', [s.wk, 0, 'lunch', 'elena', 'yogurt', 3]);
    assert(ok === true, 'setExtraRecipePortion: solo set returns true', 'got ' + ok);
    const e = entry(s, 'lunch', 'elena'), p = entry(s, 'lunch', 'partner');
    assert(e.extras.length === 2 && e.extras[0].portion === 1 && e.extras[1].portion === 3,
      'setExtraRecipePortion: solo set updates only the LAST matching extra (self)', JSON.stringify(e.extras));
    assert(hasNoExtras(p), 'setExtraRecipePortion: solo set does not touch the other person', JSON.stringify(p.extras));
  })();

  // (e) duplicates: adding the same recipeId twice then removing once removes only ONE (the last).
  (function(){
    const s = freshPlan();
    call(ctx, 'addExtraRecipeToMeal', [s.wk, 0, 'lunch', 'elena', 'yogurt']);
    call(ctx, 'addExtraRecipeToMeal', [s.wk, 0, 'lunch', 'elena', 'yogurt']);
    entry(s, 'lunch', 'elena').extras[0].__marker = 'first';
    call(ctx, 'removeExtraRecipeFromMeal', [s.wk, 0, 'lunch', 'elena', 'yogurt']);
    const e = entry(s, 'lunch', 'elena');
    assert(e.extras.length === 1 && e.extras[0].__marker === 'first',
      'removeExtraRecipeFromMeal: two duplicate extras + one remove leaves the FIRST-added (removes the last)', JSON.stringify(e.extras));
  })();

  // (f) return values: false for bad dayIndex / missing meal / unknown recipeId on ADD;
  // remove/set only need bad dayIndex / missing meal / not-found to return false (no DB check).
  (function(){
    const s = freshPlan();
    assert(call(ctx, 'addExtraRecipeToMeal', [s.wk, 99, 'lunch', 'elena', 'yogurt']) === false,
      'addExtraRecipeToMeal: false for an out-of-range dayIndex', '');
    assert(call(ctx, 'addExtraRecipeToMeal', [s.wk, 0, 'not-a-slot', 'elena', 'yogurt']) === false,
      'addExtraRecipeToMeal: false for a missing meal/slot', '');
    assert(call(ctx, 'addExtraRecipeToMeal', [s.wk, 0, 'lunch', 'elena', 'not-a-real-recipe']) === false,
      'addExtraRecipeToMeal: false for an unknown recipeId', '');
    assert(call(ctx, 'removeExtraRecipeFromMeal', [s.wk, 99, 'lunch', 'elena', 'yogurt']) === false,
      'removeExtraRecipeFromMeal: false for an out-of-range dayIndex', '');
    assert(call(ctx, 'removeExtraRecipeFromMeal', [s.wk, 0, 'not-a-slot', 'elena', 'yogurt']) === false,
      'removeExtraRecipeFromMeal: false for a missing meal/slot', '');
    assert(call(ctx, 'removeExtraRecipeFromMeal', [s.wk, 0, 'lunch', 'elena', 'never-added']) === false,
      'removeExtraRecipeFromMeal: false when the recipeId was never an extra', '');
    assert(call(ctx, 'setExtraRecipePortion', [s.wk, 0, 'lunch', 'elena', 'never-added', 2]) === false,
      'setExtraRecipePortion: false when the recipeId is not a current extra', '');
  })();

  /* ============================== food-extra variant ============================== */

  // (a) add to a SHARED meal (dinner): extras appear on BOTH persons; meal.t stamped.
  (function(){
    const s = freshPlan();
    const ok = call(ctx, 'addExtraFoodToMeal', [s.wk, 0, 'dinner', 'elena', 'spinach', 50]);
    assert(ok === true, 'addExtraFoodToMeal: shared add returns true', 'got ' + ok);
    const e = entry(s, 'dinner', 'elena'), p = entry(s, 'dinner', 'partner');
    assert(Array.isArray(e.extras) && e.extras.length === 1 && e.extras[0].foodId === 'spinach' && e.extras[0].grams === 50,
      'addExtraFoodToMeal: shared add appends {foodId, grams} to the acting person', JSON.stringify(e.extras));
    assert(Array.isArray(p.extras) && p.extras.length === 1 && p.extras[0].foodId === 'spinach' && p.extras[0].grams === 50,
      'addExtraFoodToMeal: shared add mirrors the same push onto the OTHER person', JSON.stringify(p.extras));
    assert(typeof cell(s, 'dinner').t === 'number', 'addExtraFoodToMeal: shared add stamps meal.t', 'meal.t=' + cell(s, 'dinner').t);
  })();

  // (b) add to a SOLO meal (lunch): extra only on the acting person; entry.t stamped, meal.t
  // cleared; missing/invalid grams default to 100.
  (function(){
    const s = freshPlan();
    const ok = call(ctx, 'addExtraFoodToMeal', [s.wk, 0, 'lunch', 'elena', 'spinach', undefined]);
    assert(ok === true, 'addExtraFoodToMeal: solo add returns true', 'got ' + ok);
    const e = entry(s, 'lunch', 'elena'), p = entry(s, 'lunch', 'partner');
    assert(Array.isArray(e.extras) && e.extras.length === 1 && e.extras[0].foodId === 'spinach' && e.extras[0].grams === 100,
      'addExtraFoodToMeal: missing/invalid grams default to 100', JSON.stringify(e.extras));
    assert(hasNoExtras(p), 'addExtraFoodToMeal: solo add does not touch the other person', JSON.stringify(p.extras));
    assert(typeof e.t === 'number', 'addExtraFoodToMeal: solo add stamps entry.t', 'entry.t=' + e.t);
    assert(cell(s, 'lunch').t === undefined, 'addExtraFoodToMeal: solo add clears meal.t', 'meal.t=' + cell(s, 'lunch').t);
  })();

  // (c) remove reverses the add, same stamp semantics, both shared and solo.
  (function(){
    const s = freshPlan();
    call(ctx, 'addExtraFoodToMeal', [s.wk, 0, 'dinner', 'elena', 'spinach', 40]);
    const ok = call(ctx, 'removeExtraFoodFromMeal', [s.wk, 0, 'dinner', 'elena', 'spinach']);
    assert(ok === true, 'removeExtraFoodFromMeal: shared remove returns true', 'got ' + ok);
    const e = entry(s, 'dinner', 'elena'), p = entry(s, 'dinner', 'partner');
    assert(hasNoExtras(e), 'removeExtraFoodFromMeal: shared remove clears the acting person\'s extras', JSON.stringify(e.extras));
    assert(hasNoExtras(p), 'removeExtraFoodFromMeal: shared remove mirrors the removal onto the other person', JSON.stringify(p.extras));
    assert(typeof cell(s, 'dinner').t === 'number', 'removeExtraFoodFromMeal: shared remove stamps meal.t', 'meal.t=' + cell(s, 'dinner').t);
  })();
  (function(){
    const s = freshPlan();
    call(ctx, 'addExtraFoodToMeal', [s.wk, 0, 'lunch', 'elena', 'spinach', 40]);
    const ok = call(ctx, 'removeExtraFoodFromMeal', [s.wk, 0, 'lunch', 'elena', 'spinach']);
    assert(ok === true, 'removeExtraFoodFromMeal: solo remove returns true', 'got ' + ok);
    const e = entry(s, 'lunch', 'elena');
    assert(hasNoExtras(e), 'removeExtraFoodFromMeal: solo remove clears the acting person\'s extras', JSON.stringify(e.extras));
    assert(typeof e.t === 'number', 'removeExtraFoodFromMeal: solo remove stamps entry.t', 'entry.t=' + e.t);
    assert(cell(s, 'lunch').t === undefined, 'removeExtraFoodFromMeal: solo remove clears meal.t', 'meal.t=' + cell(s, 'lunch').t);
  })();
  // Removing a foodId no longer present in FOODS must still work (remove doesn't validate
  // against the DB — only add does).
  (function(){
    const s = freshPlan();
    call(ctx, 'addExtraFoodToMeal', [s.wk, 0, 'lunch', 'elena', 'spinach', 40]);
    ctx.__savedSpinach__ = get(ctx, "FOODS['spinach']");
    run(ctx, "delete FOODS['spinach'];");
    const ok = call(ctx, 'removeExtraFoodFromMeal', [s.wk, 0, 'lunch', 'elena', 'spinach']);
    run(ctx, "FOODS['spinach'] = __savedSpinach__;");
    delete ctx.__savedSpinach__;
    assert(ok === true, 'removeExtraFoodFromMeal: removes an extra whose foodId was since deleted from FOODS', 'got ' + ok);
    assert(!!get(ctx, "FOODS['spinach']"), 'test hygiene: FOODS[\'spinach\'] was restored after the delete-from-DB check', '');
  })();

  // (d) set grams updates the LAST matching extra: both sides for shared, one side for solo;
  // grams are clamped to [1, 2000] and rounded.
  (function(){
    const s = freshPlan();
    call(ctx, 'addExtraFoodToMeal', [s.wk, 0, 'dinner', 'elena', 'spinach', 40]);
    call(ctx, 'addExtraFoodToMeal', [s.wk, 0, 'dinner', 'elena', 'spinach', 40]); // duplicate
    const ok = call(ctx, 'setExtraFoodGrams', [s.wk, 0, 'dinner', 'elena', 'spinach', 300]);
    assert(ok === true, 'setExtraFoodGrams: shared set returns true', 'got ' + ok);
    const e = entry(s, 'dinner', 'elena'), p = entry(s, 'dinner', 'partner');
    assert(e.extras.length === 2 && e.extras[0].grams === 40 && e.extras[1].grams === 300,
      'setExtraFoodGrams: shared set updates only the LAST matching extra (self)', JSON.stringify(e.extras));
    assert(p.extras.length === 2 && p.extras[0].grams === 40 && p.extras[1].grams === 300,
      'setExtraFoodGrams: shared set mirrors the same update onto the other person\'s LAST matching extra', JSON.stringify(p.extras));
  })();
  (function(){
    const s = freshPlan();
    call(ctx, 'addExtraFoodToMeal', [s.wk, 0, 'lunch', 'elena', 'spinach', 40]);
    call(ctx, 'addExtraFoodToMeal', [s.wk, 0, 'lunch', 'elena', 'spinach', 40]); // duplicate
    const ok = call(ctx, 'setExtraFoodGrams', [s.wk, 0, 'lunch', 'elena', 'spinach', 300]);
    assert(ok === true, 'setExtraFoodGrams: solo set returns true', 'got ' + ok);
    const e = entry(s, 'lunch', 'elena'), p = entry(s, 'lunch', 'partner');
    assert(e.extras.length === 2 && e.extras[0].grams === 40 && e.extras[1].grams === 300,
      'setExtraFoodGrams: solo set updates only the LAST matching extra (self)', JSON.stringify(e.extras));
    assert(hasNoExtras(p), 'setExtraFoodGrams: solo set does not touch the other person', JSON.stringify(p.extras));
  })();
  (function(){
    const s = freshPlan();
    call(ctx, 'addExtraFoodToMeal', [s.wk, 0, 'lunch', 'elena', 'spinach', 40]);
    call(ctx, 'setExtraFoodGrams', [s.wk, 0, 'lunch', 'elena', 'spinach', 5000]);
    assert(entry(s, 'lunch', 'elena').extras[0].grams === 2000, 'setExtraFoodGrams: clamps above 2000 down to 2000', 'got ' + entry(s, 'lunch', 'elena').extras[0].grams);
    call(ctx, 'setExtraFoodGrams', [s.wk, 0, 'lunch', 'elena', 'spinach', -50]);
    assert(entry(s, 'lunch', 'elena').extras[0].grams === 1, 'setExtraFoodGrams: clamps below 1 up to 1', 'got ' + entry(s, 'lunch', 'elena').extras[0].grams);
    call(ctx, 'setExtraFoodGrams', [s.wk, 0, 'lunch', 'elena', 'spinach', 150.6]);
    assert(entry(s, 'lunch', 'elena').extras[0].grams === 151, 'setExtraFoodGrams: rounds fractional grams', 'got ' + entry(s, 'lunch', 'elena').extras[0].grams);
  })();

  // (e) duplicates: adding the same foodId twice then removing once removes only ONE (the last).
  (function(){
    const s = freshPlan();
    call(ctx, 'addExtraFoodToMeal', [s.wk, 0, 'lunch', 'elena', 'spinach', 40]);
    call(ctx, 'addExtraFoodToMeal', [s.wk, 0, 'lunch', 'elena', 'spinach', 40]);
    entry(s, 'lunch', 'elena').extras[0].__marker = 'first';
    call(ctx, 'removeExtraFoodFromMeal', [s.wk, 0, 'lunch', 'elena', 'spinach']);
    const e = entry(s, 'lunch', 'elena');
    assert(e.extras.length === 1 && e.extras[0].__marker === 'first',
      'removeExtraFoodFromMeal: two duplicate extras + one remove leaves the FIRST-added (removes the last)', JSON.stringify(e.extras));
  })();

  // (f) return values: false for bad dayIndex / missing meal / unknown foodId on ADD;
  // remove/set only need bad dayIndex / missing meal / not-found to return false (no DB check).
  (function(){
    const s = freshPlan();
    assert(call(ctx, 'addExtraFoodToMeal', [s.wk, 99, 'lunch', 'elena', 'spinach', 40]) === false,
      'addExtraFoodToMeal: false for an out-of-range dayIndex', '');
    assert(call(ctx, 'addExtraFoodToMeal', [s.wk, 0, 'not-a-slot', 'elena', 'spinach', 40]) === false,
      'addExtraFoodToMeal: false for a missing meal/slot', '');
    assert(call(ctx, 'addExtraFoodToMeal', [s.wk, 0, 'lunch', 'elena', 'not-a-real-food', 40]) === false,
      'addExtraFoodToMeal: false for an unknown foodId', '');
    assert(call(ctx, 'removeExtraFoodFromMeal', [s.wk, 99, 'lunch', 'elena', 'spinach']) === false,
      'removeExtraFoodFromMeal: false for an out-of-range dayIndex', '');
    assert(call(ctx, 'removeExtraFoodFromMeal', [s.wk, 0, 'not-a-slot', 'elena', 'spinach']) === false,
      'removeExtraFoodFromMeal: false for a missing meal/slot', '');
    assert(call(ctx, 'removeExtraFoodFromMeal', [s.wk, 0, 'lunch', 'elena', 'never-added']) === false,
      'removeExtraFoodFromMeal: false when the foodId was never an extra', '');
    assert(call(ctx, 'setExtraFoodGrams', [s.wk, 0, 'lunch', 'elena', 'never-added', 100]) === false,
      'setExtraFoodGrams: false when the foodId is not a current extra', '');
  })();
}

/* ---------------- escaping helpers (stored-XSS hardening) ----------------
   escapeHtml/htmlAttr/jsAttr now live once, in js/state.js (the first-loaded
   js/*.js file per app/index.html's <script> order), instead of being
   hand-copied into library.js/render.js/planner.js. This group hammers each
   helper with hostile payloads for its OWN context, plus a source-grep guard
   so a duplicate definition can't silently creep back in. */

function testEscapingHelpers(ctx){
  // Hostile payloads covering the classic breakout shapes: tag injection,
  // attribute breakout, JS-string breakout (both quote styles), backslash
  // smuggling, script-tag close, and line-terminator smuggling (a raw U+2028/
  // U+2029 or unescaped newline can terminate a JS string literal even
  // without a quote character).
  const payloads = [
    '"><img src=x onerror=alert(1)>',
    "'); doEvil(); ('",
    '\\"); doEvil(); (\\"',
    'back\\slash',
    '</script><script>alert(1)</script>',
    `mixed "double" and 'single' quotes`,
    'line\nbreak\rand sep arators'
  ];

  // escapeHtml: TEXT NODE context. Must neutralize & < > (the characters that
  // can open a new tag or entity from within text content). Quotes are not a
  // hazard in text-node context, so escapeHtml is not required to touch them.
  (function(){
    const bad = [];
    payloads.forEach(function(p){
      const out = call(ctx, 'escapeHtml', [p]);
      if(/[<>]|&(?!amp;|lt;|gt;)/.test(out)) bad.push(JSON.stringify(p) + ' -> ' + JSON.stringify(out));
    });
    assert(bad.length === 0, 'escapeHtml: hostile payloads contain no bare <, > or unescaped & afterward', bad.join(' | '));
  })();

  // htmlAttr: HTML ATTRIBUTE VALUE context (value="...", src="...", etc).
  // Must additionally neutralize " so a payload cannot close the attribute.
  (function(){
    const bad = [];
    payloads.forEach(function(p){
      const out = call(ctx, 'htmlAttr', [p]);
      if(/[<>"]|&(?!amp;|lt;|gt;|quot;)/.test(out)) bad.push(JSON.stringify(p) + ' -> ' + JSON.stringify(out));
    });
    assert(bad.length === 0, 'htmlAttr: hostile payloads contain no bare <, >, " or unescaped & afterward', bad.join(' | '));
  })();

  // jsAttr: STRING LITERAL inside an inline event-handler attribute — crosses
  // BOTH the HTML-attribute parser and the JS string-literal parser, so it
  // must neutralize backslash, both quote characters, < > &, AND raw
  // line-terminator characters (CR/LF/U+2028/U+2029) that would otherwise
  // terminate an unescaped single-quoted JS string literal outright.
  (function(){
    const bad = [];
    payloads.forEach(function(p){
      const out = call(ctx, 'jsAttr', [p]);
      // Simulate the actual embedding this helper is for: onclick="fn('<out>')".
      const embedded = "fn('" + out + "')";
      // The HTML-attribute parser decodes entities before the JS parser ever
      // sees the string, so decode &amp;/&quot;/&lt;/&gt; the same way a
      // browser would, THEN check nothing breaks the single-quoted JS literal.
      const decoded = embedded
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      // decoded must be exactly one JS string literal 'fn(' ... ')' with no
      // unescaped single quote, unescaped backslash, or raw line terminator
      // inside it other than the ones jsAttr itself escaped.
      const innerMatch = decoded.match(/^fn\('([\s\S]*)'\)$/);
      if(!innerMatch) { bad.push(JSON.stringify(p) + ' -> does not re-form fn(\'...\'): ' + JSON.stringify(decoded)); return; }
      const inner = innerMatch[1];
      // Walk the inner string looking for an unescaped quote/backslash or any
      // raw CR/LF/U+2028/U+2029 (which would end the literal outright).
      let escaped = false, broke = false;
      for(let i = 0; i < inner.length; i++){
        const c = inner[i];
        if(escaped){ escaped = false; continue; }
        if(c === '\\'){ escaped = true; continue; }
        if(c === "'" || c === '\n' || c === '\r' || c === ' ' || c === ' '){ broke = true; break; }
      }
      if(broke || escaped) bad.push(JSON.stringify(p) + ' -> ' + JSON.stringify(out));
    });
    assert(bad.length === 0, 'jsAttr: hostile payloads stay inside a single JS string literal when embedded in onclick="fn(\'...\')"', bad.join(' | '));
  })();

  // Composition check: htmlAttr(jsAttr(payload)) — the note in the task brief
  // that a value crosses the HTML-attribute parser before the JS parser.
  // Double-escaping must not reintroduce a breakout in EITHER layer.
  (function(){
    const bad = [];
    payloads.forEach(function(p){
      const inner = call(ctx, 'jsAttr', [p]);
      const composed = call(ctx, 'htmlAttr', [inner]);
      if(/[<>"]|&(?!amp;|lt;|gt;|quot;)/.test(composed)) bad.push(JSON.stringify(p) + ' -> ' + JSON.stringify(composed));
    });
    assert(bad.length === 0, 'htmlAttr(jsAttr(payload)) stays free of bare <, >, " or unescaped & (safe under double-escaping)', bad.join(' | '));
  })();

  // Guard against the duplicates this consolidation removed creeping back:
  // each of the three canonical helpers must be defined exactly once across
  // every app/js/*.js file (simple source grep, no vm involved).
  (function(){
    const jsDir = path.join(APP_DIR, 'js');
    const files = fs.readdirSync(jsDir).filter(function(f){ return f.endsWith('.js'); });
    ['escapeHtml', 'htmlAttr', 'jsAttr'].forEach(function(name){
      const defRe = new RegExp('function\\s+' + name + '\\s*\\(');
      const definedIn = [];
      files.forEach(function(f){
        const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
        const matches = src.match(new RegExp(defRe.source, 'g'));
        if(matches) for(let i = 0; i < matches.length; i++) definedIn.push(f);
      });
      assert(definedIn.length === 1, name + '() is defined exactly once across app/js/*.js',
        'defined in: ' + JSON.stringify(definedIn));
      assert(definedIn[0] === 'state.js', name + '() lives in js/state.js (first-loaded js/*.js file)',
        'defined in: ' + JSON.stringify(definedIn));
    });
  })();
}

/* ---------------- app/sw.js SHELL_FILES drift ---------------- */

function testSwShellDrift(){
  const src = fs.readFileSync(path.join(APP_DIR, 'sw.js'), 'utf8');
  // Tolerant of GENERATED marker comments around the array (tools/build-sw.js may
  // wrap it), but SHELL_FILES stays a plain literal array of single-quoted strings.
  const arrMatch = src.match(/SHELL_FILES\s*=\s*\[([\s\S]*?)\]/);
  if(!arrMatch){ fail('sw: SHELL_FILES array found and parseable', 'no "SHELL_FILES = [ ... ]" literal found in app/sw.js'); return; }

  const listed = [];
  const strRe = /'([^']*)'/g;
  let m;
  while((m = strRe.exec(arrMatch[1]))) listed.push(m[1]);
  assert(listed.length > 0, 'sw: SHELL_FILES parsed at least one entry', 'parsed zero quoted entries');
  const listedSet = new Set(listed);

  const missingOnDisk = listed.filter(function(f){ return f !== './' && !fs.existsSync(path.join(APP_DIR, f)); });
  assert(missingOnDisk.length === 0, 'sw: every SHELL_FILES path exists under app/', 'missing on disk: ' + missingOnDisk.join(', '));

  const iconsOnDisk = fs.readdirSync(path.join(APP_DIR, 'assets', 'ingredients')).filter(function(f){ return f.toLowerCase().endsWith('.png'); });
  const missingIcons = iconsOnDisk.filter(function(f){ return !listedSet.has('assets/ingredients/' + f); });
  assert(missingIcons.length === 0, 'sw: every app/assets/ingredients/*.png on disk is listed in SHELL_FILES', 'missing from SHELL_FILES: ' + missingIcons.join(', '));

  function missingForDir(dir, ext, prefix){
    return fs.readdirSync(path.join(APP_DIR, dir)).filter(function(f){ return f.endsWith(ext); }).filter(function(f){ return !listedSet.has(prefix + f); });
  }
  const missingJs = missingForDir('js', '.js', 'js/');
  const missingData = missingForDir('data', '.js', 'data/');
  const missingCss = missingForDir('css', '.css', 'css/');
  assert(missingJs.length === 0, 'sw: every app/js/*.js file on disk is listed in SHELL_FILES', 'missing: ' + missingJs.join(', '));
  assert(missingData.length === 0, 'sw: every app/data/*.js file on disk is listed in SHELL_FILES', 'missing: ' + missingData.join(', '));
  assert(missingCss.length === 0, 'sw: every app/css/*.css file on disk is listed in SHELL_FILES', 'missing: ' + missingCss.join(', '));
}

/* ---------------- no-network ---------------- */

function testNoNetwork(){
  assert(fetchCalls.length === 0, 'no-network: the harness made zero fetch() calls', 'calls: ' + JSON.stringify(fetchCalls));
}

/* ===================================================================
   main
   =================================================================== */

function main(){
  const ctx = createMesaContext();
  loadAppInto(ctx);

  runTest('data: validateData()', function(){ testValidateData(ctx); });
  runTest('nutrition determinism', function(){ testNutritionDeterminism(ctx); });
  runTest('foodMacros linearity', function(){ testFoodMacrosLinearity(ctx); });
  runTest('recipe display helpers (compat-view removal)', function(){ testRecipeDisplayHelpers(ctx); });
  runTest('no legacy RECIPES compat view', function(){ testNoLegacyRecipesCompatView(); });
  runTest('mergeLibrarySection: newer-wins', function(){ testMergeLibraryNewerWins(ctx); });
  runTest('mergeLibrarySection: tombstone + idempotence', function(){ testMergeLibraryTombstoneIdempotence(ctx); });
  runTest('mergeLibrarySection: ratchet regression', function(){ testMergeLibraryRatchetRegression(ctx); });
  runTest('mergeLogSection', function(){ testMergeLogSection(ctx); });
  runTest('mergePlansSection', function(){ testMergePlansSection(ctx); });
  runTest('planner determinism', function(){ testPlannerDeterminism(ctx); });
  runTest('planner meal-extras', function(){ testMealExtras(ctx); });
  runTest('escaping helpers', function(){ testEscapingHelpers(ctx); });
  runTest('sw shell drift', function(){ testSwShellDrift(); });
  runTest('no-network', function(){ testNoNetwork(); }); // last: after every other test has had its chance to call fetch

  let passCount = 0, failCount = 0, knownFailCount = 0;
  results.forEach(function(r){
    if(r.status === 'pass'){ console.log('PASS ' + r.name); passCount++; }
    else if(r.status === 'known-fail'){ console.log('KNOWN-FAIL ' + r.name + ': ' + r.detail); knownFailCount++; }
    else { console.log('FAIL ' + r.name + ': ' + r.detail); failCount++; }
  });
  console.log('');
  console.log(passCount + ' passed, ' + failCount + ' failed, ' + knownFailCount + ' known-failing, ' + results.length + ' total');
  process.exit(failCount > 0 ? 1 : 0);
}

main();
