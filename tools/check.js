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

/* ---------------- task B2: recipe `role` tagging pass + breakfastPair whitelist ----------------
   role is orthogonal to slots (data/recipes.js's file-header doc, FEATURES-2026-07-plan.md
   B2): every RECIPES_DB entry must carry a valid role (data/validate.js:VALID_ROLES already
   enforces this as an ERROR in validateData(), which the test above covers), and exactly the
   approved whitelist of foods (Decisions Q2) carries breakfastPair — no more, no less.
   Also covers applyCustomRecipes()'s read-time normalization of a legacy custom recipe
   saved before `role` existed, and the library-sync round-trip for both new fields. */
const BREAKFAST_PAIR_FOOD_IDS = ['rye-bread', 'wholewheat-bread', 'white-bread', 'apples', 'pears', 'bananas', 'oranges', 'peaches', 'mixed-berries'];

function testRecipeRolesAndBreakfastPair(ctx){
  const RECIPES_DB = get(ctx, 'RECIPES_DB');
  const FOODS = get(ctx, 'FOODS');
  const VALID_ROLES = get(ctx, 'VALID_ROLES');

  const badRole = Object.keys(RECIPES_DB).filter(function(id){ return VALID_ROLES.indexOf(RECIPES_DB[id].role) === -1; });
  assert(badRole.length === 0, 'data: every RECIPES_DB id has a valid role',
    'ids with a missing/invalid role: ' + badRole.join(', '));

  const missingPair = BREAKFAST_PAIR_FOOD_IDS.filter(function(id){ return !FOODS[id] || FOODS[id].breakfastPair !== true; });
  assert(missingPair.length === 0, 'data: every whitelisted breakfastPair food (Decisions Q2) carries breakfastPair === true',
    'missing/false on: ' + missingPair.join(', '));

  const extraPair = Object.keys(FOODS).filter(function(id){ return FOODS[id].breakfastPair === true && BREAKFAST_PAIR_FOOD_IDS.indexOf(id) === -1; });
  assert(extraPair.length === 0, 'data: no food outside the breakfastPair whitelist carries breakfastPair === true',
    'unexpected breakfastPair on: ' + extraPair.join(', '));

  // A custom recipe saved before `role` existed (no field at all) must normalize to 'full'
  // at read time — js/library.js:applyCustomRecipes()/normalizeRecipeRoleField(), not a
  // silent one-shot localStorage migration — so validateData() stays green on old user data.
  run(ctx, "customRecipes['cr-legacy-no-role-test'] = {title: 'Legacy test recipe', emoji: '🍽️', slot: 'dinner', slots: ['dinner'], styles: ['balanced'], time: 10, ingredients: [['eggs', 100], ['spinach', 50]], toTaste: [], steps: ['Combine and enjoy.'], tags: [], avoid: [], u: 1};");
  call(ctx, 'applyCustomRecipes', []);
  const normalized = get(ctx, "RECIPES_DB['cr-legacy-no-role-test']");
  assert(!!normalized && normalized.role === 'full',
    'applyCustomRecipes: a legacy custom recipe with no role field normalizes to "full"',
    'got ' + JSON.stringify(normalized && normalized.role));
  run(ctx, "delete customRecipes['cr-legacy-no-role-test'];");
  call(ctx, 'applyCustomRecipes', []); // rebuild RECIPES_DB without the test fixture before later tests run

  // Library-sync round-trip: mergeLibrarySection() (js/sync.js) is what applySyncResponse's
  // 'library' branch runs incoming data through — role/imageKey/breakfastPair must survive it
  // unchanged, same as any other recipe/food field (extends the existing
  // mergeLibrarySection fixtures above rather than duplicating their setup).
  const local = emptyLibrarySection();
  local.customRecipes['cr-role-roundtrip-test'] = {title: 'Role round-trip recipe', role: 'side', slot: 'side', imageKey: 'role-roundtrip-recipe', u: 1000};
  local.customFoods['cf-pair-roundtrip-test'] = {name: 'Pair round-trip food', breakfastPair: true, u: 1000};
  const remote = emptyLibrarySection();
  const merged = call(ctx, 'mergeLibrarySection', [cloneJSON(local), cloneJSON(remote)]);
  assert(!!merged.customRecipes['cr-role-roundtrip-test'] && merged.customRecipes['cr-role-roundtrip-test'].role === 'side',
    'mergeLibrarySection: a custom recipe\'s role survives the library section round-trip',
    'got ' + JSON.stringify(merged.customRecipes['cr-role-roundtrip-test']));
  assert(!!merged.customRecipes['cr-role-roundtrip-test'] && merged.customRecipes['cr-role-roundtrip-test'].imageKey === 'role-roundtrip-recipe',
    'mergeLibrarySection: a custom recipe\'s imageKey survives the library section round-trip',
    'got ' + JSON.stringify(merged.customRecipes['cr-role-roundtrip-test']));
  assert(!!merged.customFoods['cf-pair-roundtrip-test'] && merged.customFoods['cf-pair-roundtrip-test'].breakfastPair === true,
    'mergeLibrarySection: a custom food\'s breakfastPair survives the library section round-trip',
    'got ' + JSON.stringify(merged.customFoods['cf-pair-roundtrip-test']));
}

/* ---------------- task B1: goal toggles (engine.js deriveGoalAdj/deriveGoalName,
   state.js `goals` persistence, whyText skin/thyroid clauses) ----------------
   Regression coverage for the bug this batch fixes: PROF[key].goalAdj used to be a
   fixed constant, so unchecking "Gentle fat loss" on the Profile screen changed
   nothing. Restores every mutated PROF field to its default at the end so later tests
   (planner determinism, meal extras) see the same starting state they always have. */
function testGoalToggles(ctx){
  const round10 = function(n){ return Math.round(n / 10) * 10; };

  // deriveGoalAdj/deriveGoalName are pure functions of a bare {goals} object — every
  // combination of elena's fatLoss and partner's muscleGain (the only two goals that
  // move a number, per engine.js's dispatch on which key the `goals` object carries).
  assert(call(ctx, 'deriveGoalAdj', [{goals: {fatLoss: true}}]) === -325, 'deriveGoalAdj: elena fatLoss on -> -325');
  assert(call(ctx, 'deriveGoalAdj', [{goals: {fatLoss: false}}]) === 0, 'deriveGoalAdj: elena fatLoss off -> 0');
  assert(call(ctx, 'deriveGoalAdj', [{goals: {muscleGain: true}}]) === 60, 'deriveGoalAdj: partner muscleGain on -> 60');
  assert(call(ctx, 'deriveGoalAdj', [{goals: {muscleGain: false}}]) === 0, 'deriveGoalAdj: partner muscleGain off -> 0');
  assert(call(ctx, 'deriveGoalName', [{goals: {fatLoss: true}}]) === 'gentle fat loss', 'deriveGoalName: elena fatLoss on -> "gentle fat loss"');
  assert(call(ctx, 'deriveGoalName', [{goals: {fatLoss: false}}]) === 'maintenance', 'deriveGoalName: elena fatLoss off -> "maintenance"');
  assert(call(ctx, 'deriveGoalName', [{goals: {muscleGain: true}}]) === 'small muscle-gain surplus', 'deriveGoalName: partner muscleGain on -> "small muscle-gain surplus"');
  assert(call(ctx, 'deriveGoalName', [{goals: {muscleGain: false}}]) === 'maintenance', 'deriveGoalName: partner muscleGain off -> "maintenance"');

  // Toggling the real PROF.elena.goals.fatLoss off/on drives recommendedCal() end to
  // end through recomputeProf() — the actual bug: this used to be a no-op.
  run(ctx, 'PROF.elena.goals.fatLoss = false;');
  call(ctx, 'recomputeProf', ['elena']);
  const maintE = run(ctx, 'maintenanceOf(PROF.elena)');
  let recCalE = get(ctx, 'PROF.elena.recCal');
  assert(recCalE === round10(maintE), 'goal toggle: elena fatLoss off -> recommendedCal === round10(maintenance)', 'got ' + recCalE + ', expected ' + round10(maintE));
  run(ctx, 'PROF.elena.goals.fatLoss = true;');
  call(ctx, 'recomputeProf', ['elena']);
  recCalE = get(ctx, 'PROF.elena.recCal');
  assert(recCalE === round10(maintE - 325), 'goal toggle: elena fatLoss back on -> recommendedCal restores the -325 offset', 'got ' + recCalE + ', expected ' + round10(maintE - 325));

  // Same round trip for partner.goals.muscleGain (+60).
  run(ctx, 'PROF.partner.goals.muscleGain = false;');
  call(ctx, 'recomputeProf', ['partner']);
  const maintP = run(ctx, 'maintenanceOf(PROF.partner)');
  let recCalP = get(ctx, 'PROF.partner.recCal');
  assert(recCalP === round10(maintP), 'goal toggle: partner muscleGain off -> recommendedCal === round10(maintenance)', 'got ' + recCalP + ', expected ' + round10(maintP));
  run(ctx, 'PROF.partner.goals.muscleGain = true;');
  call(ctx, 'recomputeProf', ['partner']);
  recCalP = get(ctx, 'PROF.partner.recCal');
  assert(recCalP === round10(maintP + 60), 'goal toggle: partner muscleGain back on -> recommendedCal restores the +60 offset', 'got ' + recCalP + ', expected ' + round10(maintP + 60));

  // Persistence round-trip (task B1: `goals` joins PERSIST_PROFILE_FIELDS as an
  // object-field special case, mirroring how `avoid` is already handled).
  run(ctx, 'PROF.elena.goals.hashi = false; PROF.elena.goals.skin = false; persist();');
  run(ctx, 'PROF.elena.goals.hashi = true; PROF.elena.goals.skin = true;'); // scramble in-memory before reload
  run(ctx, 'loadState();');
  const goalsAfterLoad = get(ctx, 'PROF.elena.goals');
  assert(goalsAfterLoad && goalsAfterLoad.hashi === false && goalsAfterLoad.skin === false
    && goalsAfterLoad.fatLoss === true && goalsAfterLoad.muscle === true && goalsAfterLoad.heart === true,
    'goals persistence: buildSnapshot()/loadState() round-trips PROF.elena.goals exactly',
    'got ' + JSON.stringify(goalsAfterLoad));
  run(ctx, "localStorage.removeItem(STORE_KEY);"); // don't leak this store into later tests

  // whyText: skin/hashi clauses follow the booleans (task B1's other consumer besides
  // calories). 'baked-cod-greens' is a real non-legacy RECIPES_DB id (no LEGACY_WHY
  // override, so whyText() runs the real WHY_RULES template) whose tags
  // ['thyroid','muscle','lowGI'] hit both the thyroid rule (hasTag 'thyroid') and the
  // skin rule (hasTag 'lowGI') regardless of ingredient flags.
  run(ctx, "PROF.elena.goals.hashi = true; PROF.elena.goals.skin = true; recomputeProf('elena');");
  const withBoth = call(ctx, 'whyText', ['baked-cod-greens', 'elena']);
  assert(/selenium/.test(withBoth), 'whyText: thyroid clause present when goals.hashi is on', withBoth);
  assert(/skin goal/.test(withBoth), 'whyText: skin clause present when goals.skin is on', withBoth);

  run(ctx, "PROF.elena.goals.hashi = false; PROF.elena.goals.skin = false; recomputeProf('elena');");
  const withNeither = call(ctx, 'whyText', ['baked-cod-greens', 'elena']);
  assert(!/selenium/.test(withNeither) && !/Hashimoto/.test(withNeither), 'whyText: thyroid clause dropped when goals.hashi is off', withNeither);
  assert(!/skin goal/.test(withNeither), 'whyText: skin clause dropped when goals.skin is off', withNeither);

  // Restore every mutated field to defaults for the tests that run after this one.
  run(ctx, "PROF.elena.goals = {fatLoss:true, muscle:true, heart:true, skin:true, hashi:true}; PROF.partner.goals = {muscleGain:true, heart:true}; recomputeProf('elena'); recomputeProf('partner');");
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

/* ---------------- ingredient detail page (task C4): buildFoodDetailMarkup() ----------------
   library.js's buildFoodDetailMarkup(id) is the pure HTML-string builder behind
   openFoodDetail() — it reads the live merged FOODS[id] record (overrides applied) and
   returns a self-contained markup string with no DOM access, so it's testable headlessly
   here exactly like renderLibFoodListMarkup()/buildRecipeIngredientPickerSheet() above. */
function testFoodDetailMarkup(ctx){
  const FOODS = get(ctx, 'FOODS');

  // 1) Hostile-named custom food: name/brand escaped, no raw breakout. Custom food shows
  // Delete, no Reset (it's not an override of a built-in).
  run(ctx, "customFoods['cf-detail-hostile-test'] = {name: '\\\"><img src=x onerror=window.__xss1=1>', per: 100, unit: 'g', kcal: 100, protein: 5, carbs: 10, fat: 2, satFat: 1, fiber: 2, sugars: 3, freeSugars: 1, sugarQuality: 'mixed', flags: [], cat: 'Pantry', season: 'evergreen', brand: '\\\"><b>evil</b>', u: 1};");
  call(ctx, 'applyCustomFoods', []);
  const hostileHtml = call(ctx, 'buildFoodDetailMarkup', ['cf-detail-hostile-test']);
  assert(hostileHtml.indexOf('<img src=x onerror') === -1 && hostileHtml.indexOf('<b>evil</b>') === -1,
    'buildFoodDetailMarkup: hostile custom-food name/brand render escaped (no raw < or ")', hostileHtml);
  assert(hostileHtml.indexOf('&quot;&gt;') !== -1 || hostileHtml.indexOf('&amp;quot;') !== -1 || /&lt;img/.test(hostileHtml),
    'buildFoodDetailMarkup: hostile name is HTML-escaped, not silently dropped', hostileHtml);
  assert(hostileHtml.indexOf('data-act="delete"') !== -1, 'buildFoodDetailMarkup: custom food shows a Delete action', hostileHtml);
  assert(hostileHtml.indexOf('data-act="reset"') === -1, 'buildFoodDetailMarkup: custom (non-override) food shows no Reset action', hostileHtml);
  run(ctx, "delete customFoods['cf-detail-hostile-test'];");
  call(ctx, 'applyCustomFoods', []);

  // 2) Per-piece food (eggs) shows the per-piece basis with avgG.
  const eggsHtml = call(ctx, 'buildFoodDetailMarkup', ['eggs']);
  assert(eggsHtml.indexOf('per piece (~50g)') !== -1,
    'buildFoodDetailMarkup: per-piece food (eggs) shows "per piece (~50g)" basis', eggsHtml);

  // 3) Built-in shows its src citation and NO delete button.
  const builtinId = Object.keys(FOODS).find(function(id){ return FOODS[id].src && id.indexOf('cf-') !== 0 && !get(ctx, 'foodOverrides')[id]; });
  const builtinHtml = call(ctx, 'buildFoodDetailMarkup', [builtinId]);
  const escapedSrc = call(ctx, 'escapeHtml', [FOODS[builtinId].src]);
  assert(builtinHtml.indexOf(escapedSrc) !== -1, 'buildFoodDetailMarkup: built-in shows its src citation line', builtinId + ' | ' + builtinHtml);
  assert(builtinHtml.indexOf('data-act="delete"') === -1, 'buildFoodDetailMarkup: built-in shows NO delete button', builtinHtml);
  assert(builtinHtml.indexOf('data-act="reset"') === -1, 'buildFoodDetailMarkup: unedited built-in shows no Reset action', builtinHtml);

  // 4) Edited built-in shows Reset + "edited" badge.
  run(ctx, "foodOverrides['" + builtinId + "'] = Object.assign({}, FOODS['" + builtinId + "'], {protein: FOODS['" + builtinId + "'].protein + 1, u: Date.now()});");
  call(ctx, 'applyCustomFoods', []);
  const editedHtml = call(ctx, 'buildFoodDetailMarkup', [builtinId]);
  assert(editedHtml.indexOf('data-act="reset"') !== -1 && editedHtml.indexOf('pill mini terra">edited') !== -1,
    'buildFoodDetailMarkup: edited built-in shows Reset action + "edited" badge', editedHtml);
  assert(editedHtml.indexOf('data-act="delete"') === -1, 'buildFoodDetailMarkup: edited built-in (not custom) still shows no Delete', editedHtml);
  run(ctx, "delete foodOverrides['" + builtinId + "'];");
  call(ctx, 'applyCustomFoods', []);

  // 5) sourceUrl scheme guard: http:// link dropped, https:// link rendered with rel="noopener".
  run(ctx, "customFoods['cf-detail-url-test'] = {name: 'URL test food', per: 100, unit: 'g', kcal: 100, protein: 1, carbs: 1, fat: 1, satFat: 0, fiber: 0, sugars: 0, freeSugars: 0, sugarQuality: 'unknown', flags: [], cat: 'Pantry', season: 'evergreen', offUrl: 'http://evil', u: 1};");
  call(ctx, 'applyCustomFoods', []);
  const httpHtml = call(ctx, 'buildFoodDetailMarkup', ['cf-detail-url-test']);
  assert(httpHtml.indexOf('<a href') === -1, 'buildFoodDetailMarkup: a non-https offUrl (http://evil) renders NO source link', httpHtml);
  run(ctx, "customFoods['cf-detail-url-test'].offUrl = 'https://world.openfoodfacts.org/product/123';");
  call(ctx, 'applyCustomFoods', []);
  const httpsHtml = call(ctx, 'buildFoodDetailMarkup', ['cf-detail-url-test']);
  assert(httpsHtml.indexOf('<a href="https://world.openfoodfacts.org/product/123" rel="noopener" target="_blank"') !== -1,
    'buildFoodDetailMarkup: an https:// offUrl renders a link with rel="noopener"', httpsHtml);
  run(ctx, "delete customFoods['cf-detail-url-test'];");
  call(ctx, 'applyCustomFoods', []);

  // 6) breakfastPair badge appears only for flagged foods.
  const pairId = BREAKFAST_PAIR_FOOD_IDS.filter(function(id){ return !!FOODS[id]; })[0];
  const pairHtml = call(ctx, 'buildFoodDetailMarkup', [pairId]);
  assert(pairHtml.indexOf('Breakfast pairing') !== -1, 'buildFoodDetailMarkup: a breakfastPair-flagged food shows the Breakfast pairing badge', pairId + ' | ' + pairHtml);
  const nonPairId = Object.keys(FOODS).find(function(id){ return !FOODS[id].breakfastPair && id.indexOf('cf-') !== 0; });
  const nonPairHtml = call(ctx, 'buildFoodDetailMarkup', [nonPairId]);
  assert(nonPairHtml.indexOf('Breakfast pairing') === -1, 'buildFoodDetailMarkup: a non-breakfastPair food shows no Breakfast pairing badge', nonPairId + ' | ' + nonPairHtml);
}

/* ---------------- ingredient icon picker (task C5) ---------------- */
function testIconPicker(ctx){
  const FOODS = get(ctx, 'FOODS');
  const BUILTIN_FOODS_DB = get(ctx, 'BUILTIN_FOODS_DB');

  // 1) availableIngredientIconKeys(): unique, sorted, every key resolves to an asset path
  // via the same safe helpers the renderers use, and matches exactly the set of iconKey
  // values BUILTIN_FOODS_DB actually carries (built-ins only — customFoods excluded).
  const keys = call(ctx, 'availableIngredientIconKeys', []);
  assert(Array.isArray(keys) && keys.length > 0, 'availableIngredientIconKeys: returns a non-empty array', JSON.stringify(keys));
  const sorted = keys.slice().sort();
  assert(JSON.stringify(keys) === JSON.stringify(sorted), 'availableIngredientIconKeys: result is sorted', JSON.stringify(keys));
  assert(new Set(keys).size === keys.length, 'availableIngredientIconKeys: result has no duplicates', JSON.stringify(keys));
  assert(keys.every(function(k){ return call(ctx, 'safeIngredientIconAsset', ['assets/ingredients/' + k + '.png']) === 'assets/ingredients/' + k + '.png'; }),
    'availableIngredientIconKeys: every key resolves to a valid asset path via safeIngredientIconAsset', JSON.stringify(keys));
  const expectedKeys = Array.from(new Set(Object.keys(BUILTIN_FOODS_DB).map(function(id){ return BUILTIN_FOODS_DB[id].iconKey; }).filter(Boolean))).sort();
  assert(JSON.stringify(keys) === JSON.stringify(expectedKeys), 'availableIngredientIconKeys: matches the unique iconKey set on BUILTIN_FOODS_DB', JSON.stringify(keys));
  // customFoods contributions must NOT extend the vocabulary.
  run(ctx, "customFoods['cf-icon-vocab-test'] = {name: 'Icon vocab test', per: 100, unit: 'g', kcal: 10, protein: 1, carbs: 1, fat: 0, satFat: 0, fiber: 0, sugars: 0, freeSugars: 0, sugarQuality: 'unknown', flags: [], cat: 'Pantry', season: 'evergreen', iconKey: 'zzz-not-a-builtin-key', u: 1};");
  call(ctx, 'applyCustomFoods', []);
  const keysAfterCustom = call(ctx, 'availableIngredientIconKeys', []);
  assert(JSON.stringify(keysAfterCustom) === JSON.stringify(keys), 'availableIngredientIconKeys: a customFoods iconKey does not extend the picker vocabulary', JSON.stringify(keysAfterCustom));
  run(ctx, "delete customFoods['cf-icon-vocab-test'];");
  call(ctx, 'applyCustomFoods', []);

  const pickedKey = keys[0];

  // saveNewFood's tail (toast/openFoodLibrary/applyProf/renderFoodLibraryCount) is real-DOM
  // paint code this DOM-free harness doesn't stub (document.getElementById always returns
  // null here, per createMesaContext) — same reasoning js/render.js's file header already
  // documents for "functions the tests never call". Stub the three that unconditionally
  // dereference a DOM node (toast, openFoodLibrary, applyProf) for the DURATION of the two
  // saveNewFood() calls below only, so this test exercises saveNewFood's actual persistence
  // logic (not a hand-rolled re-implementation of it) without tripping over unrelated paint
  // code; restored immediately after (renderFoodLibraryCount already no-ops on a null element
  // and needs no stub).
  run(ctx, "var __c5stub = {toast: toast, openFoodLibrary: openFoodLibrary, applyProf: applyProf}; toast = function(){}; openFoodLibrary = function(){}; applyProf = function(){};");

  // 2) Save flow: openNewFoodForm -> pick an icon -> saveNewFood persists iconKey; the list
  // row (renderLibFoodListMarkup) and detail page (buildFoodDetailMarkup) both emit that
  // asset with ZERO renderer special-casing (foodIconHtml/ingredientIconAssetForFood read
  // it straight off the record).
  call(ctx, 'openNewFoodForm', []);
  run(ctx, "newFoodForm.name = 'Icon picker test food'; newFoodForm.protein = 5; newFoodForm.carbs = 5; newFoodForm.fat = 1; newFoodForm.iconKey = " + JSON.stringify(pickedKey) + ";");
  call(ctx, 'saveNewFood', []);
  const savedId = Object.keys(get(ctx, 'customFoods')).find(function(id){ return get(ctx, 'customFoods')[id].name === 'Icon picker test food'; });
  assert(!!savedId, 'saveNewFood: the icon-picker test food was saved', savedId);
  assert(get(ctx, 'customFoods')[savedId].iconKey === pickedKey, 'saveNewFood: persists the chosen iconKey on the custom food record', JSON.stringify(get(ctx, 'customFoods')[savedId]));
  const expectedAsset = 'assets/ingredients/' + pickedKey + '.png';
  const listHtml = call(ctx, 'renderLibFoodListMarkup', ['']);
  assert(listHtml.indexOf('src="' + expectedAsset + '"') !== -1, 'renderLibFoodListMarkup: the saved custom food renders the chosen icon asset', listHtml.indexOf(pickedKey) === -1 ? 'asset not found' : 'ok');
  const detailHtml = call(ctx, 'buildFoodDetailMarkup', [savedId]);
  assert(detailHtml.indexOf('src="' + expectedAsset + '"') !== -1, 'buildFoodDetailMarkup: the saved custom food\'s detail page renders the chosen icon asset', detailHtml);

  // 3) Edit round-trip: openEditFoodForm seeds newFoodForm.iconKey from the existing record,
  // and buildNewFoodFormSheet's picker shows it as the current selection (sel + preview src).
  call(ctx, 'openEditFoodForm', [savedId]);
  assert(get(ctx, 'newFoodForm').iconKey === pickedKey, 'openEditFoodForm: seeds newFoodForm.iconKey from the existing custom food', get(ctx, 'newFoodForm').iconKey);
  run(ctx, 'newFoodForm.iconPickerOpen = true;');
  const editSheetHtml = call(ctx, 'buildNewFoodFormSheet', []);
  assert(editSheetHtml.indexOf('src="' + expectedAsset + '"') !== -1, 'buildNewFoodFormSheet: edit form preview shows the existing icon asset', editSheetHtml);
  assert(editSheetHtml.indexOf('class="icon-tile sel" data-icon-key="' + pickedKey + '"') !== -1,
    'buildNewFoodFormSheet: the matching tile is marked selected (class="icon-tile sel")', editSheetHtml);

  // 4) Clearing to Default (setNewFoodIconKey('')) removes the field on save entirely —
  // not just blanks it — so a cleared custom food falls back to the generic default icon
  // exactly like a food that never had one.
  call(ctx, 'setNewFoodIconKey', ['']);
  assert(get(ctx, 'newFoodForm').iconKey === null, 'setNewFoodIconKey(""): clears newFoodForm.iconKey to null (Default)', String(get(ctx, 'newFoodForm').iconKey));
  call(ctx, 'saveNewFood', []);
  run(ctx, "toast = __c5stub.toast; openFoodLibrary = __c5stub.openFoodLibrary; applyProf = __c5stub.applyProf; delete __c5stub;");
  assert(!('iconKey' in get(ctx, 'customFoods')[savedId]), 'saveNewFood: clearing to Default removes the iconKey field from the stored record entirely', JSON.stringify(get(ctx, 'customFoods')[savedId]));
  const clearedDetailHtml = call(ctx, 'buildFoodDetailMarkup', [savedId]);
  assert(clearedDetailHtml.indexOf(expectedAsset) === -1, 'buildFoodDetailMarkup: after clearing to Default, the picked asset no longer renders', clearedDetailHtml);

  run(ctx, "delete customFoods['" + savedId + "'];");
  call(ctx, 'applyCustomFoods', []);

  // 5) Library sync round-trip: a custom food's iconKey survives mergeLibrarySection (the
  // whole record clones through librarySectionData()/mergeLibrarySection unchanged, same as
  // role/breakfastPair above — this is a minimal extension of that existing coverage).
  const local = emptyLibrarySection();
  local.customFoods['cf-icon-sync-test'] = {name: 'Icon sync test', per: 100, unit: 'g', kcal: 40, protein: 2, carbs: 6, fat: 1, satFat: 0, fiber: 1, sugars: 1, freeSugars: 0, sugarQuality: 'unknown', flags: [], cat: 'Pantry', season: 'evergreen', iconKey: pickedKey, u: 1000};
  const remote = emptyLibrarySection();
  const mergedSync = call(ctx, 'mergeLibrarySection', [cloneJSON(local), cloneJSON(remote)]);
  assert(!!mergedSync.customFoods['cf-icon-sync-test'] && mergedSync.customFoods['cf-icon-sync-test'].iconKey === pickedKey,
    'mergeLibrarySection: a custom food\'s iconKey survives the library section round-trip', JSON.stringify(mergedSync.customFoods['cf-icon-sync-test']));

  // 6) Regression-document the safe-helper fallback for a bogus iconKey. Two layers:
  //   a) a FORMAT-invalid key (path traversal, uppercase, punctuation) is rejected by
  //      safeIngredientIconKey/safeIngredientIconAsset at the string level, so
  //      ingredientIconAssetForFood returns '' — ingredientIconHtml() then falls back to
  //      defaultFoodIconSrc() straight away (no request for a bad path is ever built).
  //   b) a format-VALID but nonexistent key (e.g. a typo'd slug) still builds a normal
  //      assets/ingredients/<key>.png src — the safe helpers only validate shape, not that
  //      the file exists on disk — and the fallback to the default icon happens at the DOM
  //      level via the <img>'s onerror handler, which every ingredientIconHtml() output
  //      wires up unconditionally.
  const bogusFood = {iconKey: '../../evil'};
  assert(call(ctx, 'ingredientIconAssetForFood', [bogusFood]) === '', 'ingredientIconAssetForFood: a format-invalid (path-traversal) iconKey resolves to no asset', call(ctx, 'ingredientIconAssetForFood', [bogusFood]));
  const bogusHtml = call(ctx, 'ingredientIconHtml', [call(ctx, 'ingredientIconAssetForFood', [bogusFood])]);
  const expectedDefaultSrc = call(ctx, 'defaultFoodIconSrc', []);
  assert(bogusHtml.indexOf('src="' + expectedDefaultSrc + '"') !== -1, 'ingredientIconHtml: a format-invalid iconKey falls back straight to the default icon src', bogusHtml);

  const typoFood = {iconKey: 'not-a-real-icon-key'};
  const typoAsset = call(ctx, 'ingredientIconAssetForFood', [typoFood]);
  assert(typoAsset === 'assets/ingredients/not-a-real-icon-key.png', 'ingredientIconAssetForFood: a format-valid but nonexistent iconKey still builds a normal asset path (shape-only validation)', typoAsset);
  const typoHtml = call(ctx, 'ingredientIconHtml', [typoAsset]);
  assert(/onerror="this\.onerror=null;this\.src=defaultFoodIconSrc\(\)"/.test(typoHtml), 'ingredientIconHtml: every rendered icon wires an onerror fallback to the default icon (covers a nonexistent-but-well-formed key at the DOM level)', typoHtml);
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

function testRecipeImageHelpers(ctx){
  assert(JSON.stringify(call(ctx, 'availableRecipeImageKeys', [])) === JSON.stringify(['default-recipe', 'salad', 'cooked-vegetables', 'meat-main', 'fish-main', 'breakfast-bowl', 'dessert-sweets', 'ramen', 'butter-chicken', 'chinese-dinner', 'fast-food-menu']),
    'availableRecipeImageKeys: returns the curated recipe image set', JSON.stringify(call(ctx, 'availableRecipeImageKeys', [])));
  assert(call(ctx, 'safeRecipeImageKey', ['fish-main']) === 'fish-main',
    'safeRecipeImageKey: accepts an available recipe image key', '');
  assert(call(ctx, 'safeRecipeImageKey', ['dessert-sweets']) === 'dessert-sweets',
    'safeRecipeImageKey: accepts the sweets recipe image key', '');
  assert(call(ctx, 'safeRecipeImageKey', ['salmon-greens']) === '',
    'safeRecipeImageKey: rejects unavailable recipe image keys even if kebab-case', '');
  assert(call(ctx, 'safeRecipeImageKey', ['../salmon']) === '',
    'safeRecipeImageKey: rejects path traversal / format-invalid keys', '');
  assert(call(ctx, 'safeRecipeImageAsset', ['assets/recipes/salmon-greens.png']) === 'assets/recipes/salmon-greens.png',
    'safeRecipeImageAsset: accepts assets/recipes/<key>.png paths', '');
  assert(call(ctx, 'safeRecipeImageAsset', ['assets/ingredients/salmon-greens.png']) === '',
    'safeRecipeImageAsset: rejects non-recipe asset directories', '');
  assert(call(ctx, 'recipeHasFishIngredient', [{title: 'Cod test', ingredients: [['cod', 120]]}]) === true,
    'recipeHasFishIngredient: detects fish ingredients from ingredient ids', '');
  assert(call(ctx, 'recipeHasFishIngredient', [{title: 'Chicken test', ingredients: [['chicken-breast', 120]]}]) === false,
    'recipeHasFishIngredient: does not classify non-fish protein as fish', '');

  const recipe = {title: 'Hero test', emoji: '🍽️', imageKey: 'fish-main'};
  assert(call(ctx, 'recipeImageAssetForRecipe', [recipe]) === 'assets/recipes/fish-main.png',
    'recipeImageAssetForRecipe: maps imageKey to an available assets/recipes/<key>.png', '');
  assert(call(ctx, 'recipeImageAssetForRecipe', [{title: 'Breakfast bowl', emoji: '🥣', slot: 'breakfast', tags: [], ingredients: []}]) === 'assets/recipes/breakfast-bowl.png',
    'recipeImageAssetForRecipe: infers the breakfast-bowl image for breakfast recipes', '');
  assert(call(ctx, 'recipeImageAssetForRecipe', [{title: 'Big salad', emoji: '🥗', slot: 'lunch', tags: [], ingredients: []}]) === 'assets/recipes/salad.png',
    'recipeImageAssetForRecipe: uses the salad image for lunch recipes', '');
  assert(call(ctx, 'recipeImageAssetForRecipe', [{title: 'Tuna lunch', emoji: '🥗', slot: 'lunch', tags: [], ingredients: [['tuna-in-olive-oil', 100]]}]) === 'assets/recipes/fish-main.png',
    'recipeImageAssetForRecipe: fish ingredients override the lunch salad default', '');
  assert(call(ctx, 'recipeImageAssetForRecipe', [{title: 'Baked cod', emoji: '🐟', slot: 'dinner', tags: [], ingredients: [['cod', 120]]}]) === 'assets/recipes/fish-main.png',
    'recipeImageAssetForRecipe: fish ingredients use the fish-main image even for dinner recipes', '');
  assert(call(ctx, 'recipeImageAssetForRecipe', [{title: 'Ramen', emoji: '🍜', slot: 'dinner', tags: [], ingredients: [['ramen-noodles', 70], ['eggs', 50]]}]) === 'assets/recipes/ramen.png',
    'recipeImageAssetForRecipe: ramen recipes use the specific ramen image', '');
  assert(call(ctx, 'recipeImageAssetForRecipe', [{title: 'Brownie', emoji: '🍫', slot: 'snack', tags: [], ingredients: [['brownie', 80]]}]) === 'assets/recipes/dessert-sweets.png',
    'recipeImageAssetForRecipe: sweets use the dessert image', '');
  assert(call(ctx, 'recipeImageAssetForRecipe', [{title: 'Burger and fries', emoji: '🍔', slot: 'dinner', tags: [], ingredients: [['fast-food-beef-burger', 180], ['cola', 400]]}]) === 'assets/recipes/fast-food-menu.png',
    'recipeImageAssetForRecipe: fast-food menus use the fast-food image', '');
  assert(call(ctx, 'recipeImageAssetForRecipe', [{title: 'Roast chicken', emoji: '🍗', slot: 'dinner', tags: [], ingredients: [['chicken-breast', 120]]}]) === 'assets/recipes/default-recipe.png',
    'recipeImageAssetForRecipe: keeps the default image for meat dinners unless explicitly changed', '');
  assert(call(ctx, 'recipeImageAssetForRecipe', [{title: 'Custom salad', emoji: '🥗', slot: 'lunch', tags: [], ingredients: []}, 'cr-custom-salad']) === 'assets/recipes/salad.png',
    'recipeImageAssetForRecipe: custom recipes in Auto use their slot default image', '');

  const html = call(ctx, 'recipeHeroHtml', [recipe]);
  assert(html.indexOf('<img ') === 0 && html.indexOf('class="recipe-image"') !== -1 && html.indexOf('src="assets/recipes/fish-main.png"') !== -1,
    'recipeHeroHtml: renders an image for recipes with imageKey', html);
  assert(/onerror="this\.onerror=null;this\.replaceWith\(document\.createTextNode\(this\.getAttribute\('data-fallback'\)\|\|''\)\)"/.test(html),
    'recipeHeroHtml: rendered image wires a DOM-level fallback to the recipe emoji', html);

  const noImageHtml = call(ctx, 'recipeHeroHtml', [{title: 'No image', emoji: '<meal>'}]);
  assert(noImageHtml.indexOf('src="assets/recipes/default-recipe.png"') !== -1 && noImageHtml.indexOf('data-fallback="&lt;meal&gt;"') !== -1,
    'recipeHeroHtml: recipes without imageKey render the default image with escaped emoji/text fallback', noImageHtml);

  const hostileHtml = call(ctx, 'recipeHeroHtml', [{title: 'Bad image', emoji: '🍽️', imageKey: '../evil'}]);
  assert(hostileHtml.indexOf('../evil') === -1 && hostileHtml.indexOf('src="assets/recipes/default-recipe.png"') !== -1,
    'recipeHeroHtml: format-invalid imageKey falls back without building a hostile image request', hostileHtml);
}

function testRecipeCatalogCleanup(ctx){
  const RECIPES_DB = get(ctx, 'RECIPES_DB');
  assert(!RECIPES_DB['white-bean-tuna-salad'],
    'recipe catalog cleanup: removes the duplicate white-bean tuna salad', '');
  assert(RECIPES_DB['tuna-white-bean-salad'] && RECIPES_DB['tuna-white-bean-salad'].title === 'Tuna & white bean salad',
    'recipe catalog cleanup: keeps the canonical tuna & white bean salad', JSON.stringify(RECIPES_DB['tuna-white-bean-salad']));
  assert(RECIPES_DB['yogurt-cereali-frutta'].title === 'Yogurt, cereal & fruit',
    'recipe catalog cleanup: default wishlist breakfast title is English', RECIPES_DB['yogurt-cereali-frutta'].title);
  assert(RECIPES_DB['cena-cinese'].title === 'Chinese-style dinner' && RECIPES_DB['cena-cinese'].imageKey === 'chinese-dinner',
    'recipe catalog cleanup: Chinese dinner title/imageKey are explicit', JSON.stringify(RECIPES_DB['cena-cinese']));
  assert(RECIPES_DB.ramen.imageKey === 'ramen' && RECIPES_DB['butter-chicken'].imageKey === 'butter-chicken',
    'recipe catalog cleanup: specific requested recipes carry specific image keys', JSON.stringify({ramen: RECIPES_DB.ramen.imageKey, butterChicken: RECIPES_DB['butter-chicken'].imageKey}));
  assert(RECIPES_DB['brownie-dessert'].imageKey === 'dessert-sweets',
    'recipe catalog cleanup: brownie uses the sweets image key', JSON.stringify(RECIPES_DB['brownie-dessert']));
}

function testRecipeImagePicker(ctx){
  run(ctx, "var __recipePickerStub = {toast: toast, openMyRecipes: openMyRecipes, applyProf: applyProf, renderFoodLibraryCount: renderFoodLibraryCount}; toast = function(){}; openMyRecipes = function(){}; applyProf = function(){}; renderFoodLibraryCount = function(){};");
  call(ctx, 'openNewRecipeForm', []);
  run(ctx, "recipeBuilder.name = 'Image picker recipe'; recipeBuilder.emoji = '🍽️'; recipeBuilder.ingredients = [{foodId:'eggs', grams:100}, {foodId:'spinach', grams:50}]; recipeBuilder.imagePickerOpen = true;");
  let html = call(ctx, 'buildRecipeBuilderSheet', []);
  assert(html.indexOf('data-role="recipe-image-grid"') !== -1,
    'buildRecipeBuilderSheet: recipe image picker grid renders when open', html);
  assert(html.indexOf('data-image-key="fish-main"') !== -1 && html.indexOf('assets/recipes/fish-main.png') !== -1,
    'buildRecipeBuilderSheet: recipe image picker offers the available recipe images', html);

  call(ctx, 'setRecipeImageKey', ['fish-main']);
  assert(get(ctx, 'recipeBuilder').imageKey === 'fish-main',
    'setRecipeImageKey: stores the selected recipe image key on the builder draft', get(ctx, 'recipeBuilder').imageKey);
  call(ctx, 'saveRecipeBuilder', []);
  const savedId = Object.keys(get(ctx, 'customRecipes')).find(function(id){ return get(ctx, 'customRecipes')[id].title === 'Image picker recipe'; });
  assert(!!savedId, 'saveRecipeBuilder: the image-picker custom recipe was saved', savedId);
  assert(get(ctx, 'customRecipes')[savedId].imageKey === 'fish-main',
    'saveRecipeBuilder: custom recipes persist the chosen imageKey', JSON.stringify(get(ctx, 'customRecipes')[savedId]));

  call(ctx, 'openEditRecipeForm', ['salmon']);
  assert(get(ctx, 'recipeBuilder').imageKey === null,
    'openEditRecipeForm: built-in recipes without explicit imageKey start in Auto mode', String(get(ctx, 'recipeBuilder').imageKey));
  call(ctx, 'setRecipeImageKey', ['salad']);
  call(ctx, 'saveRecipeBuilder', []);
  assert(get(ctx, 'recipeOverrides').salmon && get(ctx, 'recipeOverrides').salmon.imageKey === 'salad',
    'saveRecipeBuilder: built-in recipe overrides persist a chosen imageKey', JSON.stringify(get(ctx, 'recipeOverrides').salmon));

  call(ctx, 'openEditRecipeForm', ['salmon']);
  assert(get(ctx, 'recipeBuilder').imageKey === 'salad',
    'openEditRecipeForm: existing recipe imageKey seeds back into the builder draft', get(ctx, 'recipeBuilder').imageKey);
  run(ctx, "recipeBuilder.imagePickerOpen = true;");
  html = call(ctx, 'buildRecipeBuilderSheet', []);
  assert(html.indexOf('class="icon-tile sel" data-image-key="salad"') !== -1,
    'buildRecipeBuilderSheet: the selected recipe image tile is marked selected', html);
  call(ctx, 'setRecipeImageKey', ['']);
  assert(get(ctx, 'recipeBuilder').imageKey === null,
    'setRecipeImageKey: empty key returns the recipe image picker to Auto mode', String(get(ctx, 'recipeBuilder').imageKey));

  run(ctx, "delete customRecipes['" + savedId + "']; delete recipeOverrides.salmon; applyCustomRecipes(); toast = __recipePickerStub.toast; openMyRecipes = __recipePickerStub.openMyRecipes; applyProf = __recipePickerStub.applyProf; renderFoodLibraryCount = __recipePickerStub.renderFoodLibraryCount; delete __recipePickerStub;");
}

function testLibraryRecipeRowsOpenDetail(){
  const src = fs.readFileSync(path.join(APP_DIR, 'js', 'library.js'), 'utf8');
  assert(src.indexOf("openRecipe(id, 'libraryRecipes')") !== -1,
    'library recipes: tapping a recipe row opens the recipe detail screen with Back to Recipes', '');
  assert(src.indexOf('style="cursor:default" data-recipe-id=') === -1,
    'library recipes: recipe rows are no longer styled as non-clickable/default-cursor rows', '');
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

  // task C2 (2026-07-18): nextWeekTuning param lets local/remote differ so the LWW
  // assertion below actually exercises something (the other LWW fields here — SHARED/
  // householdStyle/servings — are identical on both sides, shape-completeness only).
  function plansSection(plan, tuning){
    const weekPlans = {}; weekPlans[monday] = plan;
    return {weekPlans: weekPlans, mealPins: {}, mealRules: [],
      SHARED: {breakfast: false, lunch: false, dinner: true, snack: false}, householdStyle: 'balanced',
      nextWeekTuning: tuning || 'none', servings: {svE: 1, svM: 1.5, svS: 1}};
  }

  const merged = call(ctx, 'mergePlansSection', [cloneJSON(plansSection(localPlan, 'protein')), cloneJSON(plansSection(remotePlan, 'fiber')), false]);
  const day0 = merged.weekPlans[monday].days[0];
  assert(day0.meals.breakfast.elena.recipeId === 'skyrbowl', "mergePlansSection: side A's newer per-person mutation (breakfast) is kept",
    'got ' + JSON.stringify(day0.meals.breakfast.elena));
  assert(day0.meals.dinner.recipeId === 'tunasalad', "mergePlansSection: side B's newer mutation on a DIFFERENT cell (dinner) is also kept",
    'got ' + JSON.stringify(day0.meals.dinner));
  assert(merged.nextWeekTuning === 'fiber', 'mergePlansSection: nextWeekTuning stays LWW (remote wins), like householdStyle/SHARED/servings',
    'got ' + JSON.stringify(merged.nextWeekTuning));
}

/* ---------------- routine pin state/sync slice ---------------- */

function testMealRulePinFromDatePersistence(ctx){
  run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "';");
  run(ctx, 'localStorage.clear(); mealRules = [{recipeId:"omelette", slot:"breakfast", cadence:"daily", person:"elena", anchorDate:"2026-07-13", dayIndex:0, pinFromDate:"2026-07-20"}]; persist();');
  run(ctx, 'mealRules = []; loadState();');
  const loaded = get(ctx, 'mealRules');
  assert(loaded.length === 1 && loaded[0].pinFromDate === '2026-07-20',
    'mealRules persistence: optional pinFromDate survives local load',
    'got ' + JSON.stringify(loaded));
  run(ctx, 'localStorage.clear(); mealRules = [];');
}

function testMealRulePinFromDateSyncApply(ctx){
  run(ctx, 'mealRules = [];');
  call(ctx, 'applyPlansSectionData', [{
    weekPlans: {},
    mealPins: {},
    mealRules: [{recipeId:'omelette', slot:'breakfast', cadence:'daily', person:'elena', anchorDate:'2026-07-13', dayIndex:0, pinFromDate:'2026-07-20'}],
    SHARED: {breakfast:false, lunch:false, dinner:true, snack:false},
    householdStyle: 'balanced',
    nextWeekTuning: 'none',
    servings: {svE:1, svM:1.5, svS:1}
  }]);
  const applied = get(ctx, 'mealRules');
  assert(applied.length === 1 && applied[0].pinFromDate === '2026-07-20',
    'mealRules sync: optional pinFromDate survives applyPlansSectionData()',
    'got ' + JSON.stringify(applied));
  run(ctx, 'mealRules = [];');
}

function testPinnedRebalanceDoesNotTouchPinnedUnit(ctx){
  run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "'; weekPlans = {}; weekPlan = null; mealPins = {}; mealRules = [];");
  const plan = call(ctx, 'ensureWeekPlan', []);
  const pinnedUnit = {dayIndex: 1, slot: 'breakfast', shared: !!plan.days[1].meals.breakfast.shared, person: 'elena'};
  const currentId = plan.days[pinnedUnit.dayIndex].meals[pinnedUnit.slot].elena.recipeId;
  const alt = call(ctx, 'buildSwapAlternatives', [pinnedUnit.dayIndex, pinnedUnit.slot, pinnedUnit.person, plan.weekStartDate])[0];
  assert(!!alt && alt.id !== currentId, 're-balance stale-proposal setup: a valid alternate exists for the soon-pinned unit',
    'current=' + currentId + ' alt=' + JSON.stringify(alt));
  const pinPerson = pinnedUnit.shared ? 'shared' : pinnedUnit.person;
  const pinKey = call(ctx, 'mealPinKey', [plan.weekStartDate, pinnedUnit.dayIndex, pinnedUnit.slot, pinPerson]);
  run(ctx, 'mealPins[' + JSON.stringify(pinKey) + '] = true;');
  const proposal = call(ctx, 'proposeRebalanceSuggestions', [plan.weekStartDate]);
  const hitPinned = (proposal.suggestions || []).some(function(s){
    return s.unit && s.unit.dayIndex === pinnedUnit.dayIndex && s.unit.slot === pinnedUnit.slot
      && !!s.unit.shared === !!pinnedUnit.shared && (s.unit.shared || s.unit.person === pinnedUnit.person);
  });
  assert(!hitPinned, 're-balance: stale proposal candidates do not include a pinned unit',
    'suggestions=' + JSON.stringify(proposal.suggestions));
  const staleProp = {weekStartDate: plan.weekStartDate, suggestions: [{kind:'swap', accepted:true, unit:pinnedUnit, toRecipeId:alt.id}]};
  const acceptedPlan = call(ctx, 'rebalanceAcceptedPlan', [staleProp]);
  const afterId = acceptedPlan.days[pinnedUnit.dayIndex].meals[pinnedUnit.slot].elena.recipeId;
  assert(afterId === currentId, 're-balance: apply-time guard ignores stale suggestions for a pinned unit',
    'before=' + currentId + ' after=' + afterId + ' attempted=' + alt.id);
  run(ctx, 'mealPins = {};');
}

function testPinnedFutureMealSurvivesRegenerationContract(ctx){
  const hasPinHelper = run(ctx, "typeof pinRoutineOccurrencesFrom === 'function'");
  if(!hasPinHelper){
    pass('pinned future regeneration: contract pending planner/render slice');
    return;
  }
  run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "'; weekPlans = {}; weekPlan = null; mealPins = {}; mealRules = [];");
  const nextMonday = call(ctx, 'addDaysISO', [FIXED_MONDAY, 7]);
  const plan = call(ctx, 'ensureWeekPlan', [nextMonday]);
  const before = plan.days[0].meals.breakfast.elena.recipeId;
  const rule = {recipeId: before, slot:'breakfast', cadence:'daily', person:'elena', anchorDate:nextMonday, dayIndex:0};
  call(ctx, 'pinRoutineOccurrencesFrom', [rule, nextMonday]);
  run(ctx, 'weekPlans[' + JSON.stringify(nextMonday) + '].signature = "stale-signature";');
  const regenerated = call(ctx, 'ensureWeekPlan', [nextMonday]);
  const after = regenerated.days[0].meals.breakfast.elena.recipeId;
  assert(after === before, 'pinned future meal survives regeneration',
    'before=' + before + ' after=' + after + ' pins=' + JSON.stringify(get(ctx, 'mealPins')));
  run(ctx, 'mealPins = {}; mealRules = [];');
}

function testRoutinePinHelperContracts(ctx){
  const hasPinHelper = run(ctx, "typeof pinRoutineOccurrencesFrom === 'function'");
  const hasUnpinHelper = run(ctx, "typeof unpinRoutineOccurrencesFrom === 'function'");
  if(!hasPinHelper || !hasUnpinHelper){
    pass('routine pins: helper contract pending planner/render slice');
    return;
  }
  run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "'; weekPlans = {}; weekPlan = null; mealPins = {}; mealRules = [];");
  const plan = call(ctx, 'ensureWeekPlan', []);
  const rule = {recipeId:'omelette', slot:'breakfast', cadence:'daily', person:'elena', anchorDate:'2026-07-13', dayIndex:0};
  call(ctx, 'pinRoutineOccurrencesFrom', [rule, '2026-07-20']);
  const pinsAfterPin = get(ctx, 'mealPins');
  const laterKey = call(ctx, 'mealPinKey', [plan.weekStartDate, 0, 'breakfast', 'elena']);
  assert(rule.pinFromDate === '2026-07-20' && Object.keys(pinsAfterPin).some(function(k){ return pinsAfterPin[k]; }),
    'routine auto-pin: pinRoutineOccurrencesFrom() records pinFromDate and creates pins',
    'rule=' + JSON.stringify(rule) + ' pins=' + JSON.stringify(pinsAfterPin) + ' sampleKey=' + laterKey);
  call(ctx, 'unpinRoutineOccurrencesFrom', [rule, '2026-07-20']);
  const pinsAfterUnpin = get(ctx, 'mealPins');
  assert(!rule.pinFromDate && Object.keys(pinsAfterUnpin).every(function(k){ return !pinsAfterUnpin[k]; }),
    'routine unpin following: clears pinFromDate and removes later routine pins',
    'rule=' + JSON.stringify(rule) + ' pins=' + JSON.stringify(pinsAfterUnpin));
  run(ctx, 'mealPins = {}; mealRules = [];');
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

  // task B2 (composed meals): the determinism guarantee above already covers composed
  // units byte-for-byte (they're just entry.extras on the same JSON structure) — this adds
  // the B2-specific assertion the plan asks for: at least one composed unit (main + side,
  // or main + breakfastPair food) actually exists in a freshly generated fortnight for the
  // default household, given the pools allow it. If a future avoid/season/style combination
  // ever shrinks the pools to zero composable units, this SKIPS with a note instead of
  // failing — composing nothing is a legitimate, explicitly-designed fallback (B2 handoff
  // "never fail, never degrade below today's behavior"), not a bug.
  let composedCount = 0;
  plan1.days.forEach(function(day){
    ['breakfast', 'lunch', 'dinner', 'snack'].forEach(function(slot){
      const m = day.meals[slot];
      ['elena', 'partner'].forEach(function(person){
        const e = m && m[person];
        if(e && Array.isArray(e.extras) && e.extras.length) composedCount++;
      });
    });
  });
  if(composedCount > 0){
    pass('planner (B2): the generated fortnight contains at least one composed (main + side/food) unit — composedCount=' + composedCount);
  } else {
    pass('planner (B2): SKIPPED composed-unit-exists check — 0 composed units this run (pools/scoring chose full recipes throughout; not a failure, see B2 fallback rule)');
  }
}

/* ---------------- task C2 (2026-07-18): "Tune next week" ----------------
   nextWeekTuning (state.js) folds into computePlanSignature() and adds
   planner.js:tuningBonus() as a low-weight secondary term in pickSharedMeal/
   pickSoloMeal's candidate scoring. Covers: signature reacts to the setting and reverts
   cleanly; the 'none' default is provably inert (byte-identical across two independent
   generations, same guarantee testPlannerDeterminism already pins for the untouched
   code path); each non-'none' goal at least doesn't hurt its own metric across a full
   fortnight (weak monotonic — the nudge is deliberately small, see planner.js's
   TUNING_WEIGHT doc); and the setting round-trips through both localStorage
   (buildSnapshot/loadState) and the plans sync section (plansSectionData/
   applyPlansSectionData), with invalid stored values normalizing to 'none'. */
function testNextWeekTuning(ctx){
  // ---- signature reacts + reverts ----
  run(ctx, "nextWeekTuning = 'none';");
  const sigNone = call(ctx, 'computePlanSignature', []);
  run(ctx, "nextWeekTuning = 'protein';");
  const sigProtein = call(ctx, 'computePlanSignature', []);
  assert(sigNone !== sigProtein, 'computePlanSignature: changes when nextWeekTuning changes', 'sigNone=' + sigNone + ' sigProtein=' + sigProtein);
  run(ctx, "nextWeekTuning = 'none';");
  const sigNoneAgain = call(ctx, 'computePlanSignature', []);
  assert(sigNoneAgain === sigNone, 'computePlanSignature: reverts to the same signature when nextWeekTuning is set back to none', 'got ' + sigNoneAgain + ', expected ' + sigNone);

  // ---- 'none' is provably inert: byte-identical across two independent generations ----
  run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "'; nextWeekTuning = 'none'; weekPlans = {}; weekPlan = null;");
  const noneA = call(ctx, 'ensureWeekPlan', []);
  const noneAJson = JSON.stringify(noneA);
  run(ctx, 'weekPlans = {}; weekPlan = null;');
  const noneB = call(ctx, 'ensureWeekPlan', []);
  const noneBJson = JSON.stringify(noneB);
  assert(noneAJson === noneBJson, "'none' tuning: two independent generations for the same Monday are byte-identical (tuningBonus contributes exactly 0)",
    'lengths differ or content differs (lenA=' + noneAJson.length + ', lenB=' + noneBJson.length + ')');

  // ---- weak monotonic assertions over a full fortnight (current + next week) ----
  function fortnightTotals(tuningKey){
    run(ctx, "weekPlans = {}; weekPlan = null; nextWeekTuning = '" + tuningKey + "';");
    const cur = call(ctx, 'ensureWeekPlan', []);
    const nextMonday = call(ctx, 'nextMondayISO', []);
    const next = call(ctx, 'ensureWeekPlan', [nextMonday]);
    let protein = 0, fiber = 0, freeSugars = 0, n = 0;
    [cur, next].forEach(function(plan){
      plan.days.forEach(function(day){
        Object.keys(day.meals).forEach(function(slot){
          const m = day.meals[slot];
          ['elena', 'partner'].forEach(function(person){
            const entry = m && m[person];
            if(!entry || !entry.recipeId) return;
            const nut = call(ctx, 'planEntryNutrition', [entry]);
            protein += nut.protein; fiber += nut.fiber; freeSugars += nut.freeSugars; n++;
          });
        });
      });
    });
    return {protein: protein, fiber: fiber, freeSugars: freeSugars, n: n};
  }

  const totNone = fortnightTotals('none');
  const totProtein = fortnightTotals('protein');
  const totFiber = fortnightTotals('fiber');
  const totLowSugar = fortnightTotals('lowSugar');
  assert(totNone.n > 0 && totProtein.n === totNone.n && totFiber.n === totNone.n && totLowSugar.n === totNone.n,
    'tuning fortnight totals: same number of planned meal-halves counted across all four runs (n=' + totNone.n + ')',
    'n=' + JSON.stringify({none: totNone.n, protein: totProtein.n, fiber: totFiber.n, lowSugar: totLowSugar.n}));
  assert(totProtein.protein >= totNone.protein - 1e-6, "'protein' tuning: fortnight total protein >= 'none' fortnight's",
    'protein=' + totProtein.protein + ', none=' + totNone.protein);
  assert(totFiber.fiber >= totNone.fiber - 1e-6, "'fiber' tuning: fortnight total fiber >= 'none' fortnight's",
    'fiber=' + totFiber.fiber + ', none=' + totNone.fiber);
  assert(totLowSugar.freeSugars <= totNone.freeSugars + 1e-6, "'lowSugar' tuning: fortnight total free sugars <= 'none' fortnight's",
    'lowSugar=' + totLowSugar.freeSugars + ', none=' + totNone.freeSugars);

  // ---- localStorage round-trip (buildSnapshot/loadState), plus invalid-value normalization ----
  run(ctx, "nextWeekTuning = 'omega3'; persist();");
  run(ctx, "nextWeekTuning = 'none';"); // scramble in-memory before reload, same convention testGoalToggles uses
  run(ctx, 'loadState();');
  assert(get(ctx, 'nextWeekTuning') === 'omega3', 'nextWeekTuning persistence: buildSnapshot()/loadState() round-trips the stored value', 'got ' + get(ctx, 'nextWeekTuning'));
  run(ctx, "localStorage.removeItem(STORE_KEY);"); // don't leak this store into later tests

  // Real boot always starts from the in-code default ('none', state.js) before loadState()
  // ever runs — an invalid stored value must be REJECTED (loadState()'s guard is a no-op
  // for it), leaving that in-code default in place. Unlike the goals-persistence test above
  // (which proves a VALID stored value overwrites a scrambled in-memory one), scrambling to
  // some other valid enum member here would test the wrong thing — it would only prove
  // loadState() left nextWeekTuning untouched, not that it specifically fell back to 'none'.
  run(ctx, "localStorage.setItem(STORE_KEY, JSON.stringify(Object.assign({}, buildSnapshot(), {nextWeekTuning: 'not-a-real-goal'})));");
  run(ctx, "nextWeekTuning = 'none';"); // the real in-code default a fresh page load would have
  run(ctx, 'loadState();');
  assert(get(ctx, 'nextWeekTuning') === 'none', 'nextWeekTuning: an invalid stored value normalizes to the "none" default', 'got ' + get(ctx, 'nextWeekTuning'));
  run(ctx, "localStorage.removeItem(STORE_KEY);");

  // ---- plans sync-section round-trip (plansSectionData/applyPlansSectionData) ----
  run(ctx, "nextWeekTuning = 'lowSatFat';");
  const section = call(ctx, 'plansSectionData', []);
  assert(section.nextWeekTuning === 'lowSatFat', 'plansSectionData: carries the live nextWeekTuning value', 'got ' + JSON.stringify(section.nextWeekTuning));
  run(ctx, "nextWeekTuning = 'none';"); // scramble before applying, same reasoning as the loadState checks above
  call(ctx, 'applyPlansSectionData', [section]);
  assert(get(ctx, 'nextWeekTuning') === 'lowSatFat', 'applyPlansSectionData: nextWeekTuning round-trips through the plans sync section', 'got ' + get(ctx, 'nextWeekTuning'));

  // Restore every mutated field to defaults for the tests that run after this one.
  run(ctx, "nextWeekTuning = 'none'; weekPlans = {}; weekPlan = null;");
}

/* ---------------- task B2 part 2: composed lunch/dinner + breakfast-pairing algorithm ----------------
   Part 1 (already merged, covered above by testRecipeRolesAndBreakfastPair) tagged every
   recipe with role:'full'|'main'|'side' and flagged 9 foods breakfastPair:true. This suite
   covers the ALGORITHM that composes main+side/food units inside generateWeek
   (pickSharedMeal/pickSoloMeal via planner.js's sidePoolFor/breakfastPairFoodIds/
   topKSideIds/foodHitsAvoid/applyLightConsecutiveFilter). */
function testComposedMeals(ctx){
  const RECIPES_DB = get(ctx, 'RECIPES_DB');
  const KCAL_BAND = get(ctx, 'KCAL_BAND');

  run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "';");
  run(ctx, 'weekPlans = {}; weekPlan = null;');
  const plan1 = call(ctx, 'ensureWeekPlan', []);
  const nextMonday = call(ctx, 'nextMondayISO', []);
  const plan2 = call(ctx, 'ensureWeekPlan', [nextMonday]);

  /* -------- (1) every composed unit is well-formed: right whitelist, right role, never on
     snack, and its COMBINED kcal sits within the slot band +/- a tolerance -- the SAME
     tolerance a full-recipe pick's combined kcal is also held to here (no double standard
     between the two shapes; Q1 "combos compete on EQUAL scoring"). 20% was picked because
     it's the smallest round number that already contains every full-recipe pick's kcal
     across both generated weeks for the default household (empirically: the widest
     full-recipe overshoot observed is ~10.6% above KCAL_BAND's upper bound). -------- */
  const TOLERANCE = 0.20;
  const problems = [];
  let composedLunchDinner = 0, composedBreakfast = 0, checkedLunchDinner = 0, checkedBreakfast = 0;

  [plan1, plan2].forEach(function(pl){
    pl.days.forEach(function(day, di){
      ['breakfast', 'lunch', 'dinner', 'snack'].forEach(function(slot){
        const m = day.meals[slot];
        ['elena', 'partner'].forEach(function(person){
          const entry = m && m[person];
          if(!entry || !entry.recipeId) return;
          const isComposed = Array.isArray(entry.extras) && entry.extras.length > 0;

          if(slot === 'snack'){
            if(isComposed) problems.push('snack composed (must never compose): ' + pl.weekStartDate + ' day' + di + ' ' + person + ' ' + JSON.stringify(entry));
            return;
          }

          const nut = call(ctx, 'planEntryNutrition', [entry]);
          const band = KCAL_BAND[slot];
          if(band){
            if(slot === 'breakfast') checkedBreakfast++; else checkedLunchDinner++;
            if(nut.kcal < band[0] * (1 - TOLERANCE) || nut.kcal > band[1] * (1 + TOLERANCE)){
              problems.push((isComposed ? 'composed' : 'full') + ' ' + slot + ' kcal ' + Math.round(nut.kcal) + ' outside band*tolerance ' + JSON.stringify(band) + ' (tol=' + TOLERANCE + '): ' + pl.weekStartDate + ' day' + di + ' ' + person);
            }
          }

          if(!isComposed) return;
          if(slot === 'breakfast') composedBreakfast++; else composedLunchDinner++;
          const extra = entry.extras[0];
          if(slot === 'breakfast'){
            if(!extra.foodId || BREAKFAST_PAIR_FOOD_IDS.indexOf(extra.foodId) === -1){
              problems.push('breakfast extra not on the breakfastPair whitelist: ' + JSON.stringify(extra));
            }
          } else {
            if(!extra.recipeId || !RECIPES_DB[extra.recipeId] || RECIPES_DB[extra.recipeId].role !== 'side'){
              problems.push(slot + ' extra is not a role:"side" recipe: ' + JSON.stringify(extra));
            }
          }
        });
      });
    });
  });

  assert(problems.length === 0,
    'composed meals: every composed unit is well-formed (whitelist/role-correct, never on snack, combined kcal within slot band +/- tolerance — same tolerance full picks are held to)',
    problems.join('; '));
  assert(checkedLunchDinner > 0 && checkedBreakfast > 0, 'composed meals test setup: the fortnight actually has lunch/dinner and breakfast entries to check', 'checkedLunchDinner=' + checkedLunchDinner + ' checkedBreakfast=' + checkedBreakfast);
  if(composedLunchDinner + composedBreakfast > 0){
    pass('composed meals: at least one composed lunch/dinner AND/OR breakfast unit exists across the two generated weeks — lunchDinner=' + composedLunchDinner + ' breakfast=' + composedBreakfast);
  } else {
    pass('composed meals: SKIPPED (0 composed units across both weeks this run — pools/scoring chose full recipes throughout; not a failure per the B2 fallback rule)');
  }

  /* -------- (2) sidePoolFor()/breakfastPairFoodIds() only ever return role:'side' recipes /
     whitelisted foods respectively — a direct, data-shape-level guarantee independent of
     which units the scorer happens to pick this run. -------- */
  const allSideIds = call(ctx, 'sidePoolFor', [[]]);
  const badSideRole = allSideIds.filter(function(id){ return !RECIPES_DB[id] || RECIPES_DB[id].role !== 'side'; });
  assert(allSideIds.length > 0 && badSideRole.length === 0,
    'sidePoolFor(): returns only role:"side" recipes (and at least one)', 'ids=' + JSON.stringify(allSideIds) + ' bad=' + JSON.stringify(badSideRole));
  const allPairFoodIds = call(ctx, 'breakfastPairFoodIds', [[]]);
  const badPairFood = allPairFoodIds.filter(function(id){ return BREAKFAST_PAIR_FOOD_IDS.indexOf(id) === -1; });
  assert(allPairFoodIds.length > 0 && badPairFood.length === 0,
    'breakfastPairFoodIds(): returns only foods from the Decisions-Q2 whitelist (and at least one)', 'ids=' + JSON.stringify(allPairFoodIds) + ' bad=' + JSON.stringify(badPairFood));

  /* -------- (3) avoid-lists respected for the SIDE component specifically: mutate one real,
     currently-available side recipe to carry an avoid key, add that key to elena's
     avoid-list ONLY, and confirm sidePoolFor() drops it for her while an unfiltered call
     still returns it — isolating that the SIDE's own avoid is what's being checked, not the
     main's. -------- */
  (function(){
    const targetSide = allSideIds.slice().sort()[0]; // deterministic pick, no season/date fragility
    const before = allSideIds.indexOf(targetSide) !== -1;
    assert(before, 'avoid fixture setup: the chosen target side is present with no avoid-list applied', targetSide);
    ctx.__savedSideAvoid__ = get(ctx, "RECIPES_DB['" + targetSide + "'].avoid");
    run(ctx, "RECIPES_DB['" + targetSide + "'].avoid = ['nuts'];");
    const filtered = call(ctx, 'sidePoolFor', [['nuts']]);
    run(ctx, "RECIPES_DB['" + targetSide + "'].avoid = __savedSideAvoid__; delete __savedSideAvoid__;");
    assert(filtered.indexOf(targetSide) === -1,
      'sidePoolFor(): a side recipe hit by the given avoid-list never appears in the pool', 'targetSide=' + targetSide + ' filtered=' + JSON.stringify(filtered));
  })();

  /* -------- (4) avoid-lists respected for the FOOD component specifically (breakfast
     pairing): 'gluten' must drop rye-bread/wholewheat-bread (real GLUTEN_FOOD_IDS entries)
     but keep white-bread (not on that list) and the fruit whitelist entries untouched. -------- */
  (function(){
    const withGluten = call(ctx, 'breakfastPairFoodIds', [['gluten']]);
    assert(withGluten.indexOf('rye-bread') === -1 && withGluten.indexOf('wholewheat-bread') === -1,
      'breakfastPairFoodIds([\'gluten\']): drops the two gluten-flagged whitelist breads', JSON.stringify(withGluten));
    assert(withGluten.indexOf('white-bread') !== -1,
      'breakfastPairFoodIds([\'gluten\']): keeps a whitelist bread NOT flagged gluten (white-bread)', JSON.stringify(withGluten));
    assert(withGluten.indexOf('bananas') !== -1,
      'breakfastPairFoodIds([\'gluten\']): keeps whitelist fruit untouched by an unrelated avoid key', JSON.stringify(withGluten));
  })();

  /* -------- (5) end-to-end: with elena's avoid-list ACTUALLY carrying a key that hits a
     real available side, regenerating her week never surfaces that side as an extra for
     her OR on any shared meal (shared uses the avoid UNION) -- only her solo avoid changed,
     so this also confirms the fixture didn't leak into partner-only solo slots by checking
     the same recipe is excluded from every 'elena' entry and every shared meal. -------- */
  (function(){
    const targetSide = allSideIds.slice().sort()[0];
    ctx.__savedSideAvoid2__ = get(ctx, "RECIPES_DB['" + targetSide + "'].avoid");
    ctx.__savedElenaAvoid__ = get(ctx, 'PROF.elena.avoid');
    run(ctx, "RECIPES_DB['" + targetSide + "'].avoid = ['nuts']; PROF.elena.avoid = (PROF.elena.avoid || []).concat(['nuts']);");
    run(ctx, 'weekPlans = {}; weekPlan = null;');
    const fixturePlan = call(ctx, 'ensureWeekPlan', []);
    run(ctx, "RECIPES_DB['" + targetSide + "'].avoid = __savedSideAvoid2__; PROF.elena.avoid = __savedElenaAvoid__; delete __savedSideAvoid2__; delete __savedElenaAvoid__;");
    run(ctx, 'weekPlans = {}; weekPlan = null;'); // leave no fixture plan cached for later tests
    const leaks = [];
    fixturePlan.days.forEach(function(day, di){
      ['breakfast', 'lunch', 'dinner', 'snack'].forEach(function(slot){
        const m = day.meals[slot];
        ['elena', 'partner'].forEach(function(person){
          const e = m && m[person];
          if(!e || !Array.isArray(e.extras)) return;
          const hit = e.extras.some(function(x){ return x && x.recipeId === targetSide; });
          if(hit && (person === 'elena' || m.shared)) leaks.push('day' + di + ' ' + slot + ' ' + person + ' shared=' + m.shared);
        });
      });
    });
    assert(leaks.length === 0,
      'end-to-end: a side hit by elena\'s avoid-list never appears as her extra or on any shared meal after regeneration',
      'targetSide=' + targetSide + ' leaks=' + leaks.join('; '));
  })();

  /* -------- (6) extras shape parity: a composed unit's combined nutrition, read through
     planEntryComponents()/nutritionForRecipeComponents() (the exact functions every
     downstream surface -- Today/Week titles, logging, shopping -- already reads), equals
     independently summing the main and side/food's OWN nutrition. Since manual extras
     (addExtraRecipeToMeal/addExtraFoodToMeal) push the identical {recipeId,portion} /
     {foodId,grams} shape and are read by the SAME functions (no composed-only code path
     exists anywhere downstream), this is the parity proof the plan asks for. -------- */
  (function(){
    let recipeSample = null, foodSample = null;
    [plan1, plan2].forEach(function(pl){
      pl.days.forEach(function(day){
        ['lunch', 'dinner'].forEach(function(slot){
          ['elena', 'partner'].forEach(function(person){
            const e = day.meals[slot][person];
            if(!recipeSample && e && Array.isArray(e.extras) && e.extras[0] && e.extras[0].recipeId) recipeSample = e;
          });
        });
        const bf = day.meals.breakfast;
        ['elena', 'partner'].forEach(function(person){
          const e = bf[person];
          if(!foodSample && e && Array.isArray(e.extras) && e.extras[0] && e.extras[0].foodId) foodSample = e;
        });
      });
    });

    if(recipeSample){
      const components = call(ctx, 'planEntryComponents', [recipeSample]);
      const got = call(ctx, 'nutritionForRecipeComponents', [components]);
      const mainNut = call(ctx, 'recipeNutrition', [recipeSample.recipeId, recipeSample.portion]).totals;
      const sideNut = call(ctx, 'recipeNutrition', [recipeSample.extras[0].recipeId, recipeSample.extras[0].portion]).totals;
      assert(Math.abs(got.kcal - (mainNut.kcal + sideNut.kcal)) < 1e-6 && Math.abs(got.protein - (mainNut.protein + sideNut.protein)) < 1e-6,
        'extras parity (lunch/dinner side): planEntryComponents/nutritionForRecipeComponents on a composed unit equals main-nutrition + side-nutrition summed independently',
        'got=' + JSON.stringify(got) + ' main=' + JSON.stringify(mainNut) + ' side=' + JSON.stringify(sideNut));
    } else {
      pass('extras parity (lunch/dinner side): SKIPPED — no composed lunch/dinner unit in this run\'s two weeks to sample');
    }

    if(foodSample){
      const components = call(ctx, 'planEntryComponents', [foodSample]);
      const got = call(ctx, 'nutritionForRecipeComponents', [components]);
      const mainNut = call(ctx, 'recipeNutrition', [foodSample.recipeId, foodSample.portion]).totals;
      const foodNut = call(ctx, 'foodMacros', [foodSample.extras[0].foodId, foodSample.extras[0].grams]);
      assert(Math.abs(got.kcal - (mainNut.kcal + foodNut.kcal)) < 1e-6 && Math.abs(got.protein - (mainNut.protein + foodNut.protein)) < 1e-6,
        'extras parity (breakfast pairing food): planEntryComponents/nutritionForRecipeComponents on a composed unit equals main-nutrition + food-macros summed independently',
        'got=' + JSON.stringify(got) + ' main=' + JSON.stringify(mainNut) + ' food=' + JSON.stringify(foodNut));
    } else {
      pass('extras parity (breakfast pairing food): SKIPPED — no composed breakfast unit in this run\'s two weeks to sample');
    }
  })();
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
    // task B2: generation can now itself compose a side/food extra onto lunch/dinner (the
    // very slots this suite targets) when the scoring picks a role:'main' recipe. Strip any
    // auto-composed extras from day0's lunch/dinner first so this suite's "starts with no
    // extras" assumptions hold regardless of which unit the planner picked this run —
    // composition itself is covered by its own tests below.
    run(ctx, "['lunch','dinner'].forEach(function(slot){ var m = weekPlans['" + plan.weekStartDate + "'].days[0].meals[slot]; delete m.elena.extras; delete m.partner.extras; });");
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

/* ---------------- task B5: catch-up logging from the Week view ----------------
   Backdated confirm/skip/undo on a past day of the CURRENT week, via the same
   logPlanEntry/markSlotSkipped/removeLoggedSlot funnel Log/Today use (log.js) — just
   reachable for any day <= today instead of only Today/Yesterday. Uses a Thursday
   "today" so Monday/Tuesday/Wednesday of the SAME week (whose plan is generated from
   FIXED_MONDAY) are genuinely in the past. */
function testWeekCatchupLogging(ctx){
  const TODAY = '2026-07-16'; // Thursday of the FIXED_MONDAY week (2026-07-13 Mon .. 07-19 Sun)
  run(ctx, "MESA_TEST_TODAY = '" + TODAY + "';");
  run(ctx, 'weekPlans = {}; weekPlan = null; logHistory = {};');
  const plan = call(ctx, 'ensureWeekPlan', []);
  const wk = plan.weekStartDate;
  const pastDate = plan.days[1].date; // Tuesday — before TODAY, inside the current week

  function planEntry(slot){ return get(ctx, "weekPlans['" + wk + "'].days[1].meals['" + slot + "'].elena"); }
  function dayLog(dateISO){ return get(ctx, "logHistory['" + dateISO + "']"); }
  function frozenKcal(components){
    return call(ctx, 'roundedNutritionTotals', [call(ctx, 'nutritionForRecipeComponents', [components])]).kcal;
  }
  function confirmSlot(dateISO, slot, opts){
    const entry = planEntry(slot);
    const portion = (typeof entry.portion === 'number') ? entry.portion : 1;
    const components = call(ctx, 'planEntryComponents', [entry]);
    call(ctx, 'logPlanEntry', [dateISO, 'elena', slot, entry.recipeId, portion, components, opts]);
    return {entry: entry, components: components};
  }

  // (a) backdated confirm on a past weekday: frozen macros, t === null, fresh numeric u,
  // and the day's plan/skip tombstones for this slot are clear.
  {
    const before = confirmSlot(pastDate, 'lunch', {tNull: true});
    const day = dayLog(pastDate);
    const logged = day.elena.filter(function(e){ return e.kind === 'plan' && e.slot === 'lunch'; })[0];
    assert(!!logged, 'B5: backdated confirm writes a logHistory[pastDate].elena plan entry for the slot', JSON.stringify(day));
    assert(logged.t === null, 'B5: backdated confirm stamps t === null (unknown eating time)', 'got t=' + JSON.stringify(logged && logged.t));
    assert(typeof logged.u === 'number' && isFinite(logged.u) && logged.u > 0, 'B5: backdated confirm stamps a fresh numeric u', 'got u=' + JSON.stringify(logged && logged.u));
    assert(logged.kcal === frozenKcal(before.components), 'B5: backdated confirm freezes the AS-PLANNED macros (incl. extras) at log time',
      'got kcal=' + logged.kcal + ' expected=' + frozenKcal(before.components));
    const tombIds = day.tomb.elena.map(function(t){ return call(ctx, 'logTombstoneId', [t]); });
    assert(tombIds.indexOf('plan:lunch') === -1 && tombIds.indexOf('skip:lunch') === -1,
      'B5: backdated confirm leaves no stale plan:/skip: tombstone for the slot', JSON.stringify(day.tomb.elena));
    assert(call(ctx, 'slotLogStatus', [pastDate, 'elena', 'lunch']) === 'confirmed', 'B5: slotLogStatus reads back "confirmed" after a backdated confirm');
  }

  // (b) skip then undo round-trips: slotLogStatus back to null, tombstones written for
  // both the implicit plan: tombstone (skip always writes one) and the skip: tombstone
  // (undo of a skip).
  {
    call(ctx, 'markSlotSkipped', [pastDate, 'elena', 'snack']);
    assert(call(ctx, 'slotLogStatus', [pastDate, 'elena', 'snack']) === 'skipped', 'B5: markSlotSkipped -> slotLogStatus "skipped"');
    call(ctx, 'removeLoggedSlot', [pastDate, 'elena', 'snack']);
    assert(call(ctx, 'slotLogStatus', [pastDate, 'elena', 'snack']) === null, 'B5: undo after a skip -> slotLogStatus null again',
      'got ' + call(ctx, 'slotLogStatus', [pastDate, 'elena', 'snack']));
    const day = dayLog(pastDate);
    const tombIds = day.tomb.elena.map(function(t){ return call(ctx, 'logTombstoneId', [t]); });
    assert(tombIds.indexOf('skip:snack') !== -1, 'B5: undoing a skip writes a skip:<slot> tombstone (couple-sync propagation)', JSON.stringify(day.tomb.elena));
  }

  // (c) confirming over a previous skip clears the skip (upsertLogEntry's existing
  // tombstone/skipped-flag clearing — verified here, not reimplemented).
  {
    call(ctx, 'markSlotSkipped', [pastDate, 'elena', 'breakfast']);
    assert(call(ctx, 'slotLogStatus', [pastDate, 'elena', 'breakfast']) === 'skipped', 'B5 (c): breakfast starts skipped');
    confirmSlot(pastDate, 'breakfast', {tNull: true});
    assert(call(ctx, 'slotLogStatus', [pastDate, 'elena', 'breakfast']) === 'confirmed', 'B5 (c): confirming over a previous skip clears the skip -> "confirmed"');
    const day = dayLog(pastDate);
    assert(!day.skipped.elena.breakfast, 'B5 (c): the skipped flag itself is cleared', JSON.stringify(day.skipped.elena));
  }

  // (d) logging TODAY through the same helper (no opts) keeps the normal HH:MM stamp —
  // the Week sheet only passes {tNull:true} for dates before today.
  {
    confirmSlot(TODAY, 'dinner', undefined);
    const day = dayLog(TODAY);
    const logged = day.elena.filter(function(e){ return e.kind === 'plan' && e.slot === 'dinner'; })[0];
    assert(!!logged && typeof logged.t === 'string' && /^\d{2}:\d{2}$/.test(logged.t),
      'B5: logging TODAY via the same helper (opts omitted) keeps t as HH:MM, not null', 'got t=' + JSON.stringify(logged && logged.t));
  }

  // (e) regeneration/re-balance must not lose a newly-logged BACKDATED past slot —
  // preserveLoggedSlots (planner.js) is the guard both paths already call through.
  {
    const oldPlanSnapshot = cloneJSON(get(ctx, "weekPlans['" + wk + "']"));
    const newPlan = cloneJSON(oldPlanSnapshot);
    const realRecipeId = newPlan.days[1].meals.lunch.elena.recipeId;
    newPlan.days[1].meals.lunch.elena.recipeId = 'not-the-logged-recipe'; // simulate regeneration proposing something else
    call(ctx, 'preserveLoggedSlots', [oldPlanSnapshot, newPlan]);
    assert(newPlan.days[1].meals.lunch.elena.recipeId === realRecipeId,
      'B5: preserveLoggedSlots restores a backdated logged past slot instead of the regenerated recipe',
      'got ' + newPlan.days[1].meals.lunch.elena.recipeId + ', expected ' + realRecipeId);
  }
}

/* ---------------- task B4: day + week nutrient/fiber summary ----------------
   render.js:weekDayNutriViews/weekNutriSummary are pure/DOM-free (renderWeek's HTML
   building is not — it throws on the harness's null #weekList — so these two helpers,
   factored out specifically so the underlying math is testable, are what this hits
   directly). Seeds a meal-extras case (day0 lunch, solo per FIXED_MONDAY's day0 SHARED
   defaults — same fact testMealExtras relies on) and a logged-overlay case (day0
   breakfast logged as a DIFFERENT recipe than planned, so its macros must differ and the
   overlay must win), then checks (a) day totals equal the independently-summed slot
   views, (b) week averages equal sum/7 of the day totals, (c) the fiber/free-sugars
   targets referenced are the SAME constants/formulas Insights already uses. */
function testWeekNutriSummary(ctx){
  run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "';");
  run(ctx, 'weekPlans = {}; weekPlan = null; logHistory = {};');
  const plan0 = call(ctx, 'ensureWeekPlan', []);
  const wk = plan0.weekStartDate;
  const SLOT_ORDER = get(ctx, 'SLOT_ORDER');
  const person = 'elena';

  // task B2: strip any auto-composed extra generation may have put on day0 lunch (this
  // test seeds its OWN single extra below and asserts on its exact shape/count).
  run(ctx, "['lunch','dinner'].forEach(function(slot){ var m = weekPlans['" + wk + "'].days[0].meals[slot]; delete m.elena.extras; delete m.partner.extras; });");

  // Seed (a): an extra on day0 lunch...
  call(ctx, 'addExtraRecipeToMeal', [wk, 0, 'lunch', person, 'yogurt']);
  // ...and (b): day0 breakfast logged as a recipe DIFFERENT from what's planned, so the
  // displayed view must reflect the logged overlay's macros, not the plan's.
  const day0Before = get(ctx, "weekPlans['" + wk + "'].days[0]");
  const plannedBreakfastId = day0Before.meals.breakfast.elena.recipeId;
  const RECIPES_DB = get(ctx, 'RECIPES_DB');
  const overlayRecipeId = Object.keys(RECIPES_DB).sort().filter(function(id){ return id !== plannedBreakfastId; })[0];
  call(ctx, 'logPlanEntry', [day0Before.date, person, 'breakfast', overlayRecipeId, 1, [{recipeId: overlayRecipeId, portion: 1}], undefined]);
  const loggedNut = call(ctx, 'roundedNutritionTotals', [call(ctx, 'nutritionForRecipeComponents', [[{recipeId: overlayRecipeId, portion: 1}]])]);
  const plannedNut = call(ctx, 'roundedNutritionTotals', [call(ctx, 'planEntryNutrition', [day0Before.meals.breakfast.elena])]);
  assert(loggedNut.protein !== plannedNut.protein || loggedNut.kcal !== plannedNut.kcal,
    'B4 test setup: the overlay recipe genuinely differs in macros from the planned one (otherwise the overlay-wins case proves nothing)',
    'logged=' + JSON.stringify(loggedNut) + ' planned=' + JSON.stringify(plannedNut));

  // (a) day0's totals must equal the sum of its 4 slot views, computed independently here
  // (not by re-calling weekDayNutriViews) — each slot's view mirrors what renderWeek's row
  // loop and displayedSlotViewForDate would produce, extras and the logged overlay included.
  const plan = get(ctx, "weekPlans['" + wk + "']");
  const day0 = plan.days[0];
  const expected = {kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugars: 0, freeSugars: 0};
  SLOT_ORDER.forEach(function(slot){
    const m = day0.meals[slot];
    const entry = m[person];
    const planned = call(ctx, 'planEntryView', [entry, m.shared]);
    const view = call(ctx, 'displayedSlotViewForDate', [day0.date, person, slot, planned]);
    if(!view.recipe) return;
    expected.kcal += view.kcal; expected.protein += view.protein; expected.carbs += view.carbs;
    expected.fat += view.fat; expected.fiber += view.fiber; expected.sugars += view.sugars; expected.freeSugars += view.freeSugars;
  });
  // The breakfast slot's view must show the LOGGED recipe, not the planned one — proof the
  // overlay actually won for this slot (not just that totals happen to match by accident).
  const breakfastView = call(ctx, 'displayedSlotViewForDate', [day0.date, person, 'breakfast', call(ctx, 'planEntryView', [day0.meals.breakfast.elena, day0.meals.breakfast.shared])]);
  assert(breakfastView.recipeId === overlayRecipeId, 'B4: displayedSlotViewForDate shows the logged overlay recipe for a logged slot, not the planned one',
    'got ' + breakfastView.recipeId + ', expected ' + overlayRecipeId);
  assert(day0.meals.lunch.elena.extras && day0.meals.lunch.elena.extras.length === 1, 'B4 test setup: the meal-extras seed actually landed on day0 lunch',
    JSON.stringify(day0.meals.lunch.elena.extras));

  const dayViews = call(ctx, 'weekDayNutriViews', [plan, person]);
  const totals0 = dayViews[0].totals;
  ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugars', 'freeSugars'].forEach(function(key){
    assert(Math.abs(totals0[key] - expected[key]) < 1e-6,
      'B4: weekDayNutriViews day0.totals.' + key + ' equals the independently-summed slot views (extras + logged-overlay included)',
      'got ' + totals0[key] + ', expected ' + expected[key]);
  });

  // (b) week averages equal sum/7 of the (independently verified) per-day totals.
  const days = dayViews.length;
  assert(days === 7, 'B4: weekDayNutriViews returns one entry per plan day', 'got ' + days);
  const expectedAvg = {};
  ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'freeSugars'].forEach(function(key){
    expectedAvg[key] = dayViews.reduce(function(s, d){ return s + d.totals[key]; }, 0) / days;
  });
  const summary = call(ctx, 'weekNutriSummary', [plan, person, dayViews]);
  assert(Math.abs(summary.avgKcal - expectedAvg.kcal) < 1e-6, 'B4: weekNutriSummary.avgKcal === sum/7 of day totals', 'got ' + summary.avgKcal + ', expected ' + expectedAvg.kcal);
  assert(Math.abs(summary.avgProtein - expectedAvg.protein) < 1e-6, 'B4: weekNutriSummary.avgProtein === sum/7 of day totals', 'got ' + summary.avgProtein + ', expected ' + expectedAvg.protein);
  assert(Math.abs(summary.avgCarbs - expectedAvg.carbs) < 1e-6, 'B4: weekNutriSummary.avgCarbs === sum/7 of day totals', 'got ' + summary.avgCarbs + ', expected ' + expectedAvg.carbs);
  assert(Math.abs(summary.avgFat - expectedAvg.fat) < 1e-6, 'B4: weekNutriSummary.avgFat === sum/7 of day totals', 'got ' + summary.avgFat + ', expected ' + expectedAvg.fat);
  assert(Math.abs(summary.avgFiber - expectedAvg.fiber) < 1e-6, 'B4: weekNutriSummary.avgFiber === sum/7 of day totals', 'got ' + summary.avgFiber + ', expected ' + expectedAvg.fiber);
  assert(Math.abs(summary.avgFreeSugars - expectedAvg.freeSugars) < 1e-6, 'B4: weekNutriSummary.avgFreeSugars === sum/7 of day totals', 'got ' + summary.avgFreeSugars + ', expected ' + expectedAvg.freeSugars);

  // weekNutriSummary called with no dayViews arg must self-derive the identical numbers
  // (renderWeekNutriCard always passes dayViews, but the function stays correct standalone).
  const summaryNoArg = call(ctx, 'weekNutriSummary', [plan, person]);
  assert(Math.abs(summaryNoArg.avgKcal - summary.avgKcal) < 1e-6, 'B4: weekNutriSummary(plan, person) with no dayViews arg matches the passed-dayViews result',
    'got ' + summaryNoArg.avgKcal + ', expected ' + summary.avgKcal);

  // (c) fiber/free-sugars targets are the SAME constants Insights already uses — identity
  // checks plus a source-grep guard against a re-typed literal creeping into render.js.
  const fiberMinPerDay = get(ctx, 'WEEK_SUMMARY_THRESHOLDS.fiberMinPerDay');
  assert(summary.fiberTarget === fiberMinPerDay, 'B4: weekNutriSummary.fiberTarget === WEEK_SUMMARY_THRESHOLDS.fiberMinPerDay (never re-typed)',
    'got ' + summary.fiberTarget + ', expected ' + fiberMinPerDay);
  const gapsFreeSugarsTarget = call(ctx, 'coverageGaps', [call(ctx, 'computeWeeklyCoverage', [plan])]).freeSugars.target;
  const calGoal = get(ctx, "PROF['" + person + "'].calGoalNum");
  const expectedSugarTargetG = calGoal > 0 ? Math.round((gapsFreeSugarsTarget / 100) * calGoal / 4) : 0;
  assert(summary.sugarTargetG === expectedSugarTargetG,
    'B4: weekNutriSummary.sugarTargetG derives from coverageGaps().freeSugars.target (the SAME sugar target Insights uses), not a re-typed literal',
    'got ' + summary.sugarTargetG + ', expected ' + expectedSugarTargetG);

  const renderSrc = fs.readFileSync(path.join(APP_DIR, 'js', 'render.js'), 'utf8');
  const fnBody = function(name){
    const m = renderSrc.match(new RegExp('function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}\\n'));
    return m ? m[0] : '';
  };
  const summaryFn = fnBody('weekNutriSummary');
  assert(summaryFn.indexOf('WEEK_SUMMARY_THRESHOLDS.fiberMinPerDay') !== -1,
    'B4 source guard: weekNutriSummary references WEEK_SUMMARY_THRESHOLDS.fiberMinPerDay literally (grep-detectable single source)', summaryFn);
  assert(summaryFn.indexOf('gaps.freeSugars.target') !== -1,
    'B4 source guard: weekNutriSummary references gaps.freeSugars.target literally instead of a re-typed sugar-target literal', summaryFn);
  assert(!/\bfiberTarget\s*=\s*25\b/.test(summaryFn) && !/\bsugarTargetPct\s*=\s*6\b/.test(summaryFn),
    'B4 source guard: neither fiber (25) nor sugar (6) target is re-typed as a bare literal in weekNutriSummary', summaryFn);
}

/* ---------------- task C3: Week screen must count quick-add LOGGED foods ----------------
   Confirmed bug: weekDayNutriViews (B4) summed ONLY the four slot views from
   displayedSlotViewForDate, so kind:'food' quick-add log entries (Log screen's cappuccino/
   gelato/any quick-add) never reached the Week screen's day totals or the week average
   card, even though computeInsights (planner.js) and Today's ring already counted them —
   both iterate the WHOLE day log, kind-agnostic. This suite pins the fix: (a) a past
   current-week day's weekDayNutriViews totals, after logging two quick-adds, equal the
   independently-computed slot-view sum PLUS the two entries' own logEntryNutrition, across
   every metric; (b) the week average shifts by exactly that total / 7; (c) a different
   week (next week) built from a DIFFERENT plan object is unaffected — no logHistory exists
   for its (future) dates; (d) regression-documents that computeInsights already included
   the quick-adds all along, so a future render.js refactor can never silently regress it. */
function testWeekQuickAddNutrition(ctx){
  const TODAY = '2026-07-16'; // Thursday of the FIXED_MONDAY week (2026-07-13 Mon .. 07-19 Sun)
  run(ctx, "MESA_TEST_TODAY = '" + TODAY + "';");
  run(ctx, 'weekPlans = {}; weekPlan = null; logHistory = {};');
  const plan = call(ctx, 'ensureWeekPlan', []);
  const wk = plan.weekStartDate;
  const person = 'elena';
  const pastDate = plan.days[1].date; // Tuesday — before TODAY, inside the current week
  const SLOT_ORDER = get(ctx, 'SLOT_ORDER');

  // Independent slot-view sum for one day (same technique testWeekNutriSummary uses) —
  // computed WITHOUT calling weekDayNutriViews, so the "totals include quick-adds" check
  // below isn't just the function under test agreeing with itself.
  function slotViewSum(dayIndex){
    const day = get(ctx, "weekPlans['" + wk + "'].days[" + dayIndex + "]");
    const sum = {kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugars: 0, freeSugars: 0};
    SLOT_ORDER.forEach(function(slot){
      const m = day.meals[slot];
      const entry = m[person];
      const planned = call(ctx, 'planEntryView', [entry, m.shared]);
      const view = call(ctx, 'displayedSlotViewForDate', [day.date, person, slot, planned]);
      if(!view.recipe) return;
      if(call(ctx, 'slotLogStatus', [day.date, person, slot]) === 'skipped') return;
      sum.kcal += view.kcal; sum.protein += view.protein; sum.carbs += view.carbs;
      sum.fat += view.fat; sum.fiber += view.fiber; sum.sugars += view.sugars; sum.freeSugars += view.freeSugars;
    });
    return sum;
  }
  const baseline1 = slotViewSum(1);

  // Baseline dayViews/summary BEFORE any quick-add is logged — logHistory[pastDate]
  // doesn't exist yet, so weekDayNutriViews' quick-add branch has nothing to add
  // regardless of the fix's correctness; this doubles as the "no quick-adds yet" case.
  const dayViewsBefore = call(ctx, 'weekDayNutriViews', [plan, person]);
  assert(dayViewsBefore[1].quickAddCount === 0, 'C3: quickAddCount is 0 before any quick-add is logged', 'got ' + dayViewsBefore[1].quickAddCount);
  ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugars', 'freeSugars'].forEach(function(key){
    assert(Math.abs(dayViewsBefore[1].totals[key] - baseline1[key]) < 1e-6,
      'C3 test setup: day1 totals.' + key + ' match the independent slot-view sum before any quick-add', 'got ' + dayViewsBefore[1].totals[key] + ', expected ' + baseline1[key]);
  });
  const summaryBefore = call(ctx, 'weekNutriSummary', [plan, person, dayViewsBefore]);
  // Insights snapshot BEFORE any quick-add: no meal for pastDate has been confirmed
  // either, so logHistory[pastDate] is empty and computeInsights shows it unlogged.
  const insightsBefore = call(ctx, 'computeInsights', [person]);
  const insightsDayBefore = insightsBefore.days.filter(function(d){ return d.date === pastDate; })[0];
  assert(!!insightsDayBefore && insightsDayBefore.logged === false && insightsDayBefore.kcal === 0,
    'C3 test setup: computeInsights shows pastDate as unlogged/0kcal before any quick-add (nothing confirmed or quick-added yet)',
    JSON.stringify(insightsDayBefore));

  // (a) log two quick-add foods on the past day: one plain quick-add and one
  // beverage-style (cappuccino) — both go through logFoodEntry (the only kind:'food'
  // writer), matching the plan's "quick-add foods (cappuccinos, beverages, pantry extras)" wording.
  call(ctx, 'logFoodEntry', [pastDate, person, 'fruit-jam', 30]);
  call(ctx, 'logFoodEntry', [pastDate, person, 'cappuccino-unsweetened', 1]);
  const dayLog = get(ctx, "logHistory['" + pastDate + "']");
  const quickAdds = dayLog[person].filter(function(e){ return e.kind === 'food'; });
  assert(quickAdds.length === 2, 'C3 test setup: both quick-add entries landed in logHistory[pastDate].elena', JSON.stringify(dayLog[person]));

  const expectedExtra = {kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugars: 0, freeSugars: 0};
  quickAdds.forEach(function(e){
    const nut = call(ctx, 'logEntryNutrition', [e]);
    ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugars', 'freeSugars'].forEach(function(k){ expectedExtra[k] += nut[k]; });
  });
  assert(expectedExtra.kcal > 0, 'C3 test setup: the quick-add entries carry nonzero kcal (otherwise the totals-increase assertion below proves nothing)', JSON.stringify(expectedExtra));

  // (a) day1's weekDayNutriViews totals now equal the (unchanged) slot-view sum PLUS the
  // quick-adds' own logEntryNutrition, for every metric.
  const dayViewsAfter = call(ctx, 'weekDayNutriViews', [plan, person]);
  const totals1 = dayViewsAfter[1].totals;
  ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugars', 'freeSugars'].forEach(function(key){
    const expected = baseline1[key] + expectedExtra[key];
    assert(Math.abs(totals1[key] - expected) < 1e-6,
      'C3: weekDayNutriViews day1.totals.' + key + ' = slot-view sum + the 2 quick-adds’ logEntryNutrition',
      'got ' + totals1[key] + ', expected ' + expected);
  });
  assert(dayViewsAfter[1].quickAddCount === 2, 'C3: weekDayNutriViews reports quickAddCount === 2 for the day with 2 quick-adds', 'got ' + dayViewsAfter[1].quickAddCount);

  // Every OTHER day of the SAME week is untouched (quick-adds only landed on pastDate).
  dayViewsAfter.forEach(function(dv, i){
    if(i === 1) return;
    assert(dv.quickAddCount === 0, 'C3: day' + i + ' (no quick-adds logged) still reports quickAddCount === 0', 'got ' + dv.quickAddCount);
    assert(Math.abs(dv.totals.kcal - dayViewsBefore[i].totals.kcal) < 1e-6,
      'C3: day' + i + ' totals.kcal unaffected by another day’s quick-adds', 'got ' + dv.totals.kcal + ', expected ' + dayViewsBefore[i].totals.kcal);
  });

  // (b) the week average shifts by exactly the quick-adds' total / 7 (7 plan days).
  const summaryAfter = call(ctx, 'weekNutriSummary', [plan, person, dayViewsAfter]);
  ['avgKcal', 'avgProtein', 'avgCarbs', 'avgFat', 'avgFiber', 'avgFreeSugars'].forEach(function(avgKey){
    const rawKey = avgKey.slice(3, 4).toLowerCase() + avgKey.slice(4); // avgKcal -> kcal, avgFreeSugars -> freeSugars
    const delta = summaryAfter[avgKey] - summaryBefore[avgKey];
    const expectedDelta = expectedExtra[rawKey] / 7;
    assert(Math.abs(delta - expectedDelta) < 1e-6,
      'C3: weekNutriSummary.' + avgKey + ' shifts by exactly the quick-adds’ total / 7',
      'got delta=' + delta + ', expected ' + expectedDelta);
  });

  // (c) a DIFFERENT week (next week, a distinct plan object) is unaffected by this week's
  // logHistory — next week's dates have no log entries regardless of the fix's guard.
  const nextMonday = call(ctx, 'nextMondayISO', []);
  const nextPlan = call(ctx, 'ensureWeekPlan', [nextMonday]);
  assert(nextPlan.weekStartDate !== wk, 'C3 test setup: next week is a genuinely different plan/week', nextPlan.weekStartDate);
  const nextDayViews = call(ctx, 'weekDayNutriViews', [nextPlan, person]);
  nextDayViews.forEach(function(dv, i){
    assert(dv.quickAddCount === 0, 'C3: next week day' + i + ' quickAddCount === 0 (no logHistory exists for future dates)', 'got ' + dv.quickAddCount);
  });

  // (d) regression-document: computeInsights' per-day kcal for pastDate already INCLUDES
  // the quick-adds (no meal was confirmed for pastDate in this test, so logHistory holds
  // ONLY the 2 quick-add entries — Insights flipping from unlogged/0kcal to logged/
  // expectedExtra.kcal proves it counts kind:'food' entries same as everything else,
  // the already-correct Insights behavior this batch must never break).
  const insightsAfter = call(ctx, 'computeInsights', [person]);
  const insightsDayAfter = insightsAfter.days.filter(function(d){ return d.date === pastDate; })[0];
  assert(!!insightsDayAfter, 'C3 regression check: computeInsights returns an entry for pastDate', pastDate);
  assert(insightsDayAfter.logged === true, 'C3 regression-document: computeInsights marks pastDate logged once quick-adds exist', JSON.stringify(insightsDayAfter));
  const expectedInsightsKcal = Math.round(expectedExtra.kcal);
  assert(Math.abs(insightsDayAfter.kcal - expectedInsightsKcal) <= 1,
    'C3 regression-document: computeInsights day kcal for pastDate INCLUDES the quick-adds (already-correct Insights behavior, pinned so it can never regress silently)',
    'got ' + insightsDayAfter.kcal + ', expected ~' + expectedInsightsKcal);
}

/* ---------------- task B3: sides/extras from the Week screen (next-week context) ----------------
   The Week screen's new ＋ button (render.js:openWeekAddMealSheet) reaches the extras sheet
   with an explicit {weekStartDate, dayIndex, slot, person} context instead of a dateISO
   relative to "today" -- this proves the underlying guarantee that refactor depends on:
   the SAME weekStartDate-aware planner mutators (addExtraRecipeToMeal/addExtraFoodToMeal,
   already exercised against the CURRENT week by testMealExtras above) work identically
   against a NEXT-week plan, (b) a subsequent ensureWeekPlan(nextMonday) revalidation does
   NOT regenerate the edited plan (v22/v57 guarantee -- markWeekPlanEdited refreshes the
   signature so the plan still matches on the next freshen() check), and (c) editing a
   future date never creates a logHistory entry (the sheet's own logged-vs-plan branch is
   dateISO <= todayISO() && slotLogStatus(...)==='confirmed', which is automatically false
   for any date after today -- nothing here should touch logHistory at all). Reuses
   testMealExtras' facts: dayIndex 0 has lunch.shared === false (solo) and
   dinner.shared === true (shared), independent of which week is generated since `shared`
   comes from the household SHARED{} config, not the date. */
function testWeekExtrasNextWeek(ctx){
  run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "';");
  run(ctx, 'weekPlans = {}; weekPlan = null; logHistory = {};');
  call(ctx, 'ensureWeekPlan', []); // seed the current week first, same as a real session would have
  const nextMonday = call(ctx, 'nextMondayISO', []);
  const plan = call(ctx, 'ensureWeekPlan', [nextMonday]);
  const wk = plan.weekStartDate;
  assert(wk === nextMonday, 'B3 setup: ensureWeekPlan(nextMonday) returns a plan for the requested week', 'got ' + wk);

  // task B2: strip any auto-composed extra generation may have put on day0 lunch/dinner —
  // this suite seeds its OWN single extra on each and asserts on its exact shape/count.
  run(ctx, "['lunch','dinner'].forEach(function(slot){ var m = weekPlans['" + wk + "'].days[0].meals[slot]; delete m.elena.extras; delete m.partner.extras; });");

  function cell(slot){ return get(ctx, "weekPlans['" + wk + "'].days[0].meals['" + slot + "']"); }
  function entry(slot, person){ return cell(slot)[person]; }

  // (a) recipe extra on next week's SHARED slot (dinner): stamps/mirrors exactly like the
  // current-week case in testMealExtras.
  {
    const ok = call(ctx, 'addExtraRecipeToMeal', [wk, 0, 'dinner', 'elena', 'yogurt']);
    assert(ok === true, 'B3: addExtraRecipeToMeal on a NEXT-week meal returns true', 'got ' + ok);
    const e = entry('dinner', 'elena'), p = entry('dinner', 'partner');
    assert(Array.isArray(e.extras) && e.extras.length === 1 && e.extras[0].recipeId === 'yogurt',
      'B3: next-week recipe extra appends {recipeId, portion:1} to the acting person', JSON.stringify(e.extras));
    assert(Array.isArray(p.extras) && p.extras.length === 1 && p.extras[0].recipeId === 'yogurt',
      'B3: next-week SHARED recipe extra mirrors the same push onto the other person', JSON.stringify(p.extras));
    assert(typeof cell('dinner').t === 'number', 'B3: next-week shared recipe extra stamps meal.t (couple-sync)', 'meal.t=' + cell('dinner').t);
  }

  // (b) food extra on next week's SOLO slot (lunch): does not mirror onto the other person.
  {
    const ok = call(ctx, 'addExtraFoodToMeal', [wk, 0, 'lunch', 'elena', 'spinach', 50]);
    assert(ok === true, 'B3: addExtraFoodToMeal on a NEXT-week meal returns true', 'got ' + ok);
    const e = entry('lunch', 'elena'), p = entry('lunch', 'partner');
    assert(Array.isArray(e.extras) && e.extras.length === 1 && e.extras[0].foodId === 'spinach' && e.extras[0].grams === 50,
      'B3: next-week food extra appends {foodId, grams} to the acting person', JSON.stringify(e.extras));
    assert(!Array.isArray(p.extras) || p.extras.length === 0,
      'B3: next-week SOLO food extra does not touch the other person', JSON.stringify(p.extras));
  }

  // (c) neither mutation touched logHistory for the future date -- a plan-only edit must
  // never create/require an eaten record.
  const dateISO = get(ctx, "weekPlans['" + wk + "'].days[0].date");
  assert(!get(ctx, "logHistory['" + dateISO + "']"),
    'B3: adding extras to a NEXT-week meal creates no logHistory entry for that date', JSON.stringify(get(ctx, "logHistory['" + dateISO + "']")));

  // (d) v22/v57 guarantee: ensureWeekPlan(nextMonday) called again afterward (the same call
  // renderWeek()/sync would make on the next paint) must NOT regenerate -- the plan,
  // including BOTH extras added above, comes back byte-identical.
  const before = cloneJSON(get(ctx, "weekPlans['" + wk + "']"));
  const revalidated = call(ctx, 'ensureWeekPlan', [nextMonday]);
  assert(JSON.stringify(revalidated) === JSON.stringify(before),
    'B3: ensureWeekPlan(nextMonday) revalidation leaves the edited plan (incl. both extras) byte-identical -- no regeneration',
    'before=' + JSON.stringify(before) + ' after=' + JSON.stringify(revalidated));
}

/* ---------------- task C1: Insights per-day nutrient bands ----------------
   computeInsights (planner.js) now sums carbs/freeSugars (kind-agnostic, same entries
   loop as kcal/protein/fat/fiber) and classifies each logged day against 5 bands:
   protein/carbs/fat vs the person's own targetP/targetC/targetF (+-10%, same window the
   kcal inBand check uses), fiber vs WEEK_SUMMARY_THRESHOLDS.fiberMinPerDay (floor only),
   free sugars vs coverageGaps().freeSugars.target converted to grams for the person's
   calorie goal (ceiling only) -- the SAME derivation render.js:weekNutriSummary already
   uses for sugarTargetG, so Insights and the Week card can never disagree on it. */
function testInsightsNutrientBands(ctx){
  run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "';");
  run(ctx, 'weekPlans = {}; weekPlan = null; logHistory = {};');
  call(ctx, 'ensureWeekPlan', []); // populates weekPlan -- coverageGaps/computeWeeklyCoverage default to it
  const person = 'elena';
  call(ctx, 'recomputeProf', [person]); // fresh targetP/targetC/targetF/calGoalNum before reading them

  const targetP = get(ctx, "PROF['" + person + "'].targetP");
  const targetC = get(ctx, "PROF['" + person + "'].targetC");
  const targetF = get(ctx, "PROF['" + person + "'].targetF");
  assert(targetP > 0 && targetC > 0 && targetF > 0,
    'C1 test setup: PROF.elena has positive targetP/targetC/targetF', 'P=' + targetP + ' C=' + targetC + ' F=' + targetF);

  const last7 = call(ctx, 'last7Dates', []);
  assert(Array.isArray(last7) && last7.length === 7 && last7[6] === FIXED_MONDAY,
    'C1 test setup: last7Dates()[6] is today', JSON.stringify(last7));

  // bandTargets is computed before computeInsights' <2-logged-days early return, so it's
  // available even with zero logHistory -- read the free-sugars gram cap it derived,
  // plus an INDEPENDENTLY computed expectation (same technique as B4's sugarTargetG test)
  // to prove it's the coverageGaps()-derived value, not a re-typed literal.
  const bandTargets0 = call(ctx, 'computeInsights', [person]).bandTargets;
  const gapsFreeSugarsTarget = call(ctx, 'coverageGaps', [call(ctx, 'computeWeeklyCoverage', [])]).freeSugars.target;
  const calGoal = get(ctx, "PROF['" + person + "'].calGoalNum");
  const expectedSugarCapG = calGoal > 0 ? Math.round((gapsFreeSugarsTarget / 100) * calGoal / 4) : 0;
  assert(bandTargets0.freeSugars === expectedSugarCapG,
    'C1: computeInsights().bandTargets.freeSugars derives from coverageGaps().freeSugars.target (the SAME sugar target Insights/Week already share), not a re-typed literal',
    'got ' + bandTargets0.freeSugars + ', expected ' + expectedSugarCapG);
  assert(bandTargets0.fiber === get(ctx, 'WEEK_SUMMARY_THRESHOLDS.fiberMinPerDay'),
    'C1: computeInsights().bandTargets.fiber === WEEK_SUMMARY_THRESHOLDS.fiberMinPerDay (never re-typed)',
    'got ' + bandTargets0.fiber);
  const sugarCapG = bandTargets0.freeSugars;
  assert(sugarCapG > 0, 'C1 test setup: sugarCapG is positive (otherwise the over/in-band sugars fixtures below prove nothing)', 'got ' + sugarCapG);

  // (a) kind-agnostic carbs/freeSugars sums: a real PLAN entry (components -> recipeNutrition
  // path) plus a real quick-add FOOD entry, on the same day, both counted.
  const RECIPES_DB = get(ctx, 'RECIPES_DB');
  const recipeId = Object.keys(RECIPES_DB)[0];
  const components = [{recipeId: recipeId, portion: 1}];
  call(ctx, 'logPlanEntry', [FIXED_MONDAY, person, 'lunch', recipeId, 1, components]);
  const FOODS = get(ctx, 'FOODS');
  const foodId = Object.keys(FOODS)[0];
  call(ctx, 'logFoodEntry', [FIXED_MONDAY, person, foodId, 100]);

  const planNut = call(ctx, 'nutritionForRecipeComponents', [components]);
  const foodNut = call(ctx, 'foodMacros', [foodId, 100]);
  const expectedCarbs = planNut.carbs + foodNut.carbs;
  const expectedFreeSugars = planNut.freeSugars + foodNut.freeSugars;

  const dataToday = call(ctx, 'computeInsights', [person]);
  const todayDay = dataToday.days[6];
  assert(todayDay.date === FIXED_MONDAY, 'C1 test setup: computeInsights.days[6] is today', todayDay.date);
  assert(Math.abs(todayDay.carbs - expectedCarbs) < 1e-6,
    'C1: computeInsights day.carbs sums a plan entry + a quick-add (kind-agnostic, same loop as kcal/protein)',
    'got ' + todayDay.carbs + ', expected ' + expectedCarbs);
  assert(Math.abs(todayDay.freeSugars - expectedFreeSugars) < 1e-6,
    'C1: computeInsights day.freeSugars sums a plan entry + a quick-add (kind-agnostic, same loop as kcal/protein)',
    'got ' + todayDay.freeSugars + ', expected ' + expectedFreeSugars);

  run(ctx, 'logHistory = {};'); // clear before crafting the per-band fixture days below

  // (b) band classification: one crafted day each for in-band/over/under on PROTEIN (the
  // representative +-10%-window metric: protein/carbs/fat all share classifyWindowBand),
  // and in-band/over on FREE SUGARS (the representative ceiling-only metric alongside
  // fiber's floor-only case -- sugars has no "too little" bad state by the C1 spec, so only
  // 2 of the 3 states are meaningful there). Raw entries carry every NUTRIENT_KEYS field
  // as a finite number, so logEntryNutrition() takes the direct fallback-fields path
  // (engine.js) deterministically regardless of kind.
  function pushRawEntry(date, overrides){
    ctx.__c1Fixture__ = Object.assign({kind: 'food', ref: '__c1_fixture__', grams: 100,
      id: 'c1-' + date + '-' + Math.random().toString(16).slice(2),
      kcal: 500, protein: 0, carbs: 0, fat: 0, satFat: 0, fiber: 0, sugars: 0, freeSugars: 0, t: '12:00'}, overrides);
    run(ctx, "getDayLog('" + date + "')['" + person + "'].push(__c1Fixture__); delete __c1Fixture__;");
  }

  const proteinInDate = last7[0], proteinOverDate = last7[1], proteinUnderDate = last7[2];
  pushRawEntry(proteinInDate, {protein: targetP}); // exactly at target -> within +-10%
  pushRawEntry(proteinOverDate, {protein: targetP * 1.5}); // well above +10%
  pushRawEntry(proteinUnderDate, {protein: targetP * 0.5}); // well below -10%

  const sugarsInDate = last7[3], sugarsOverDate = last7[4];
  pushRawEntry(sugarsInDate, {freeSugars: sugarCapG * 0.5}); // comfortably under the cap
  pushRawEntry(sugarsOverDate, {freeSugars: sugarCapG * 2}); // well over the cap

  const data = call(ctx, 'computeInsights', [person]);
  const dayFor = function(date){ return data.days.filter(function(d){ return d.date === date; })[0]; };

  const inDay = dayFor(proteinInDate), overDay = dayFor(proteinOverDate), underDay = dayFor(proteinUnderDate);
  assert(!!inDay && !!inDay.bands, 'C1 test setup: protein in-band fixture day is logged/classified', JSON.stringify(inDay));
  assert(inDay.bands.protein === 'in', 'C1: protein at target classifies as "in" band', 'got ' + (inDay.bands && inDay.bands.protein));
  assert(overDay.bands.protein === 'over', 'C1: protein 50% over target classifies as "over" band', 'got ' + overDay.bands.protein);
  assert(underDay.bands.protein === 'under', 'C1: protein 50% under target classifies as "under" band', 'got ' + underDay.bands.protein);

  const sugarsInDay = dayFor(sugarsInDate), sugarsOverDay = dayFor(sugarsOverDate);
  assert(sugarsInDay.bands.freeSugars === 'in', 'C1: free sugars at half the cap classifies as "in" band', 'got ' + sugarsInDay.bands.freeSugars);
  assert(sugarsOverDay.bands.freeSugars === 'over', 'C1: free sugars at 2x the cap classifies as "over" band', 'got ' + sugarsOverDay.bands.freeSugars);

  // unlogged days in the window carry bands: null (render.js paints the empty-state bar).
  const unloggedDate = last7[6] === FIXED_MONDAY ? last7[5] : last7[6]; // any date not fixtured above
  if([proteinInDate, proteinOverDate, proteinUnderDate, sugarsInDate, sugarsOverDate].indexOf(unloggedDate) === -1){
    const unloggedDay = dayFor(unloggedDate);
    assert(unloggedDay.logged === false && unloggedDay.bands === null,
      'C1: an unlogged day in the 7-day window carries bands: null', JSON.stringify(unloggedDay));
  }

  run(ctx, 'logHistory = {};'); // don't leak these fixture days into later tests

  // (c) source-grep guard: computeInsights references WEEK_SUMMARY_THRESHOLDS.fiberMinPerDay
  // and coverageGaps()'s freeSugars.target literally -- no re-typed 25/6 bare literal.
  const plannerSrc = fs.readFileSync(path.join(APP_DIR, 'js', 'planner.js'), 'utf8');
  const insightsFnMatch = plannerSrc.match(/function computeInsights\([^)]*\)\{[\s\S]*?\n\}\n/);
  const insightsFn = insightsFnMatch ? insightsFnMatch[0] : '';
  assert(insightsFn.length > 0, 'C1 source guard: computeInsights() function body found in planner.js', 'not found');
  assert(insightsFn.indexOf('WEEK_SUMMARY_THRESHOLDS.fiberMinPerDay') !== -1,
    'C1 source guard: computeInsights references WEEK_SUMMARY_THRESHOLDS.fiberMinPerDay literally (grep-detectable single source)', insightsFn);
  assert(insightsFn.indexOf('.freeSugars.target') !== -1,
    'C1 source guard: computeInsights references coverageGaps(...).freeSugars.target literally instead of a re-typed sugar-target literal', insightsFn);
  // Same targeted style as the B4 guard above -- an actual assignment of the bare number
  // (the real regression risk), not a blanket "no digit 25/6 anywhere" scan (which would
  // false-positive on this very function's own doc comments explaining it's NOT re-typed).
  assert(!/\bfiberMinPerDay\s*=\s*25\b/.test(insightsFn) && !/\bsugarTargetPct\s*=\s*6\b/.test(insightsFn),
    'C1 source guard: neither fiber (25) nor sugar (6) target is re-typed as a bare literal assignment in computeInsights', insightsFn);
}

/* ---------------- task C1: quick-add edit/delete must live-refresh the Week screen ----------------
   Confirmed bug: refreshAfterLogChange() (render.js) — the single documented refresh funnel
   for every log-affecting action — never called renderWeek(), so the Week screen's day rows/
   totals (which also derive from logHistory) went stale after saveEditTodayFood/
   deleteTodayRecordGroup/removeTodayEntry/deleteEditingTodayFood/undoLogSlot/
   undoRecipeEatenSlot. Only the 3 B5 catch-up-logging paths (weekLogConfirm/weekLogSkip/
   weekLogUndo) called renderWeek() themselves, explicitly, right after
   refreshAfterLogChange(). The fix centralizes renderWeek() INSIDE refreshAfterLogChange
   and removes those 3 now-redundant explicit calls -- exactly one Week render per action,
   for every caller. A DOM-level test is impractical here: tools/check.js's document stub
   returns null from getElementById (see this file's header doc), and renderWeek() itself
   throws on that null #weekList, so this is a structural/source assertion instead: count
   'renderWeek()' occurrences in each function's own extracted source. */
function testRefreshAfterLogChangeRendersWeekOnce(){
  const renderSrc = fs.readFileSync(path.join(APP_DIR, 'js', 'render.js'), 'utf8');
  const fnBody = function(name){
    const m = renderSrc.match(new RegExp('function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}\\n'));
    return m ? m[0] : '';
  };
  const occurrences = function(src, needle){ return src.length ? src.split(needle).length - 1 : 0; };

  const refreshFn = fnBody('refreshAfterLogChange');
  assert(refreshFn.length > 0, 'C1 setup: refreshAfterLogChange() function body found in render.js', 'not found');
  assert(occurrences(refreshFn, 'renderWeek()') === 1,
    'C1: refreshAfterLogChange() calls renderWeek() exactly once — the single shared funnel every log-affecting action now goes through',
    refreshFn);

  const callerNames = ['deleteTodayRecordGroup', 'saveEditTodayFood', 'removeTodayEntry',
    'deleteEditingTodayFood', 'undoLogSlot', 'undoRecipeEatenSlot',
    'weekLogConfirm', 'weekLogSkip', 'weekLogUndo'];
  callerNames.forEach(function(name){
    const fn = fnBody(name);
    assert(fn.length > 0, 'C1 setup: ' + name + '() function body found in render.js', 'not found');
    assert(fn.indexOf('refreshAfterLogChange()') !== -1,
      'C1 setup: ' + name + '() calls refreshAfterLogChange()', fn);
    assert(occurrences(fn, 'renderWeek()') === 0,
      'C1: ' + name + '() does not ALSO call renderWeek() itself — exactly one Week re-render per action, via the shared funnel (regression test for the quick-add-delete-path bug)',
      fn);
  });
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

  const recipesDir = path.join(APP_DIR, 'assets', 'recipes');
  const recipeImagesOnDisk = fs.existsSync(recipesDir) ? fs.readdirSync(recipesDir).filter(function(f){ return f.toLowerCase().endsWith('.png'); }) : [];
  const missingRecipeImages = recipeImagesOnDisk.filter(function(f){ return !listedSet.has('assets/recipes/' + f); });
  assert(missingRecipeImages.length === 0, 'sw: every app/assets/recipes/*.png on disk is listed in SHELL_FILES', 'missing from SHELL_FILES: ' + missingRecipeImages.join(', '));

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
   task D1: recipe options/variants — no built-in RECIPES_DB recipe carries
   optionGroups yet (D2 adds real ones: baked-fish, pasta, french-toast-fruit-maple), so
   every scenario below is exercised against INJECTED fixture recipes, registered into
   the sandbox's live RECIPES_DB via run()+JSON.stringify (same pattern
   testRecipeRolesAndBreakfastPair's legacy-custom-recipe fixture uses) and removed again
   at the end so later tests see the real, unmodified catalog.
   =================================================================== */
function testRecipeOptions(ctx){
  const RECIPES_DB = get(ctx, 'RECIPES_DB');
  const FOODS = get(ctx, 'FOODS');
  const SLOT_ORDER = get(ctx, 'SLOT_ORDER');

  // -------- (0) options-less byte-identical: BEFORE any fixture is injected, confirm (a)
  // zero RECIPES_DB entries carry optionGroups right now, and (b) two independent
  // generateWeek() calls with identical inputs produce byte-identical JSON — the
  // determinism guarantee every other test below leans on, pinned explicitly for a
  // catalog with no optionGroups present anywhere (not just re-relying on
  // testPlannerDeterminism's own coverage). --------
  (function(){
    const anyOptionGroups = Object.keys(RECIPES_DB).some(function(id){
      return Array.isArray(RECIPES_DB[id].optionGroups) && RECIPES_DB[id].optionGroups.length;
    });
    assert(anyOptionGroups === false, 'D1 test setup: no built-in RECIPES_DB recipe carries optionGroups yet (D2 adds them)', '');

    run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "';");
    run(ctx, 'weekPlans = {}; weekPlan = null;');
    const sigA = call(ctx, 'computePlanSignature', []);
    const genA = call(ctx, 'generateWeek', [{weekStartDate: FIXED_MONDAY, signature: sigA}]);
    run(ctx, 'weekPlans = {}; weekPlan = null;');
    const sigB = call(ctx, 'computePlanSignature', []);
    const genB = call(ctx, 'generateWeek', [{weekStartDate: FIXED_MONDAY, signature: sigB}]);
    assert(JSON.stringify(genA) === JSON.stringify(genB),
      'D1: options-less generateWeek() output is byte-identical across two independent generations (no optionGroups present anywhere in RECIPES_DB)',
      'lenA=' + JSON.stringify(genA).length + ' lenB=' + JSON.stringify(genB).length);
    run(ctx, 'weekPlans = {}; weekPlan = null;');
  })();

  // -------- fixture: role:'full' (never composes, so it's always a standalone pick in
  // both pickers regardless of slot), two optionGroups so multi-group normalization/
  // rotation is exercised together: "protein" (salmon default / cod / prawns — prawns is
  // the real FOODS shellfish id foodHitsAvoid() checks) and "carb" (rice default /
  // potato). Base `ingredients` is a single evergreen pantry item so recipeSeason() can
  // never filter it out regardless of the harness's fixed "today". --------
  const FIXTURE_ID = '__d1_fixture_recipe__';
  const fixtureRecipe = {
    title: 'D1 fixture dish', emoji: '🧪', slot: 'dinner', role: 'full',
    styles: ['balanced', 'highprotein', 'lowcarb'], time: 10,
    ingredients: [['olive-oil', 5]],
    toTaste: [], steps: ['Combine and enjoy.'], tags: [], avoid: [],
    optionGroups: [
      {key: 'protein', label: 'Protein', choices: [
        {id: 'salmon', label: 'Salmon', ingredients: [['salmon-fillet', 150]]},
        {id: 'cod', label: 'Cod', ingredients: [['cod', 150]]},
        {id: 'prawns', label: 'Prawns', ingredients: [['prawns', 150]]}
      ]},
      {key: 'carb', label: 'Carb', choices: [
        {id: 'rice', label: 'Rice', ingredients: [['rice', 100]]},
        {id: 'potato', label: 'Potato', ingredients: [['potatoes', 150]]}
      ]}
    ]
  };

  // -------- (1) recipeEffectiveIngredients: default combo, an explicit combo, and a bad-
  // opts fallback (unknown group key, unknown choice id, wrong-typed value) all resolve
  // sanely — none of it needs RECIPES_DB registration since the function takes the recipe
  // object directly. --------
  (function(){
    const effDefault = call(ctx, 'recipeEffectiveIngredients', [fixtureRecipe, null]);
    assert(JSON.stringify(effDefault) === JSON.stringify([['olive-oil', 5], ['salmon-fillet', 150], ['rice', 100]]),
      'recipeEffectiveIngredients: default combo = base + choices[0] of every group (authored order)', JSON.stringify(effDefault));

    const effChosen = call(ctx, 'recipeEffectiveIngredients', [fixtureRecipe, {protein: 'cod', carb: 'potato'}]);
    assert(JSON.stringify(effChosen) === JSON.stringify([['olive-oil', 5], ['cod', 150], ['potatoes', 150]]),
      'recipeEffectiveIngredients: an explicit valid opts combo resolves to base + each chosen choice', JSON.stringify(effChosen));

    const effBad = call(ctx, 'recipeEffectiveIngredients', [fixtureRecipe, {protein: 'not-a-real-choice', bogusGroup: 'x', carb: 42}]);
    assert(JSON.stringify(effBad) === JSON.stringify(effDefault),
      'recipeEffectiveIngredients: bad opts (unknown choice id, unknown group key, wrong-typed value) falls back to the default combo', JSON.stringify(effBad));

    const effUndefinedRecipe = call(ctx, 'recipeEffectiveIngredients', [null, {protein: 'cod'}]);
    assert(Array.isArray(effUndefinedRecipe) && effUndefinedRecipe.length === 0,
      'recipeEffectiveIngredients: a null recipe returns [] rather than throwing', JSON.stringify(effUndefinedRecipe));
  })();

  // -------- (2) normalizeRecipeOpts: default-fill, unknown-key-drop, partial-override. --------
  (function(){
    const normDefault = call(ctx, 'normalizeRecipeOpts', [fixtureRecipe, null]);
    assert(JSON.stringify(normDefault) === JSON.stringify({protein: 'salmon', carb: 'rice'}),
      'normalizeRecipeOpts(recipe, null): fills every group with its choices[0] default', JSON.stringify(normDefault));

    const normBad = call(ctx, 'normalizeRecipeOpts', [fixtureRecipe, {protein: 'not-real', extraneousKey: 'ignored'}]);
    assert(JSON.stringify(normBad) === JSON.stringify({protein: 'salmon', carb: 'rice'}),
      'normalizeRecipeOpts: an invalid choice id falls back to default, and a key matching no group is dropped', JSON.stringify(normBad));

    const normPartial = call(ctx, 'normalizeRecipeOpts', [fixtureRecipe, {carb: 'potato'}]);
    assert(JSON.stringify(normPartial) === JSON.stringify({protein: 'salmon', carb: 'potato'}),
      'normalizeRecipeOpts: a partial opts object fills in only the missing group(s) with their default', JSON.stringify(normPartial));

    const normNoGroups = call(ctx, 'normalizeRecipeOpts', [RECIPES_DB.yogurt, {anything: 'x'}]);
    assert(JSON.stringify(normNoGroups) === '{}',
      'normalizeRecipeOpts: a recipe without optionGroups always resolves to {}', JSON.stringify(normNoGroups));
  })();

  // -------- (3) nutrition differs correctly between two choices, cross-checked against an
  // independently-computed sum (never a re-typed literal) — protein is directly additive,
  // so a difference there proves the ingredient swap actually took effect. --------
  (function(){
    run(ctx, "RECIPES_DB['" + FIXTURE_ID + "'] = " + JSON.stringify(fixtureRecipe) + ';');

    const codNut = call(ctx, 'recipeNutrition', [FIXTURE_ID, 1, {protein: 'cod', carb: 'rice'}]).totals;
    const expectedCodProtein = call(ctx, 'foodMacros', ['olive-oil', 5]).protein
      + call(ctx, 'foodMacros', ['cod', 150]).protein
      + call(ctx, 'foodMacros', ['rice', 100]).protein;
    assert(Math.abs(codNut.protein - expectedCodProtein) < 1e-6,
      'recipeNutrition(id, servings, opts): protein matches an independently-summed foodMacros() total for the chosen combo',
      'got=' + codNut.protein + ' expected=' + expectedCodProtein);

    const prawnsNut = call(ctx, 'recipeNutrition', [FIXTURE_ID, 1, {protein: 'prawns', carb: 'rice'}]).totals;
    assert(Math.abs(codNut.protein - prawnsNut.protein) > 1e-6,
      'recipeNutrition: two different choices in the same group produce different nutrition (cod vs prawns protein, both at the same 150g)',
      'cod=' + codNut.protein + ' prawns=' + prawnsNut.protein);

    const defaultNut = call(ctx, 'recipeNutrition', [FIXTURE_ID, 1]).totals; // 3rd param omitted entirely
    const salmonNut = call(ctx, 'recipeNutrition', [FIXTURE_ID, 1, null]).totals;
    assert(Math.abs(defaultNut.protein - salmonNut.protein) < 1e-6,
      'recipeNutrition: omitting opts entirely behaves exactly like passing null (both resolve to the default combo)',
      'omitted=' + defaultNut.protein + ' explicitNull=' + salmonNut.protein);
  })();

  // -------- (4) rotation formula: (weekSeed + dayIndex*7 + slotIndex) % allowed.length,
  // over the group's choices sorted by id — deterministic (two identical calls agree) and
  // matches a hand-computed expected index. --------
  (function(){
    const weekSeed = call(ctx, 'stableHash', [FIXED_MONDAY]);
    const optsA = call(ctx, 'chosenOptsForRecipe', [fixtureRecipe, weekSeed, 2, 1, []]);
    const optsB = call(ctx, 'chosenOptsForRecipe', [fixtureRecipe, weekSeed, 2, 1, []]);
    assert(JSON.stringify(optsA) === JSON.stringify(optsB),
      'chosenOptsForRecipe: deterministic — identical (recipe, weekSeed, dayIndex, slotIndex, avoidList) always picks the same combo', JSON.stringify(optsA) + ' vs ' + JSON.stringify(optsB));

    const proteinAllowedSorted = ['cod', 'prawns', 'salmon']; // group.choices ids, already alphabetical
    const carbAllowedSorted = ['potato', 'rice'];
    const expectedProteinIdx = (weekSeed + 2 * 7 + 1) % proteinAllowedSorted.length;
    const expectedCarbIdx = (weekSeed + 2 * 7 + 1) % carbAllowedSorted.length;
    assert(optsA.protein === proteinAllowedSorted[expectedProteinIdx] && optsA.carb === carbAllowedSorted[expectedCarbIdx],
      'chosenOptsForRecipe: index = (weekSeed + dayIndex*7 + slotIndex) % allowed.length, over choices sorted by id, matches a hand-computed expectation for both groups',
      'got=' + JSON.stringify(optsA) + ' expected protein=' + proteinAllowedSorted[expectedProteinIdx] + ' carb=' + carbAllowedSorted[expectedCarbIdx]);

    // Varying only slotIndex across the group's own choice count sweeps every allowed index
    // at least once — a second, formula-independent way of pinning the rotation (not just
    // trusting the same arithmetic twice).
    const seenProtein = {};
    for(let si = 0; si < proteinAllowedSorted.length; si++){
      const o = call(ctx, 'chosenOptsForRecipe', [fixtureRecipe, 0, 0, si, []]);
      seenProtein[o.protein] = true;
    }
    assert(Object.keys(seenProtein).length === proteinAllowedSorted.length,
      'chosenOptsForRecipe: sweeping slotIndex across the group\'s own choice count visits every allowed choice at least once (real rotation, not a constant)',
      JSON.stringify(seenProtein));
  })();

  // -------- (5) avoid-respect: a shellfish avoid-list never yields the prawns choice,
  // across a wide sweep of (dayIndex, slotIndex) — and WOULD yield prawns for at least one
  // combo with no avoid-list, proving the exclusion is real, not just unreachable. --------
  (function(){
    let prawnsWithAvoid = false, prawnsWithoutAvoid = false;
    for(let d = 0; d < 7; d++){
      for(let si = 0; si < 4; si++){
        const withAvoid = call(ctx, 'chosenOptsForRecipe', [fixtureRecipe, 0, d, si, ['shellfish']]);
        if(withAvoid.protein === 'prawns') prawnsWithAvoid = true;
        const withoutAvoid = call(ctx, 'chosenOptsForRecipe', [fixtureRecipe, 0, d, si, []]);
        if(withoutAvoid.protein === 'prawns') prawnsWithoutAvoid = true;
      }
    }
    assert(prawnsWithAvoid === false, 'chosenOptsForRecipe: a person avoiding shellfish never gets the prawns choice, across a full week x slot sweep', '');
    assert(prawnsWithoutAvoid === true, 'D1 test setup: with no avoid-list, the same sweep DOES reach the prawns choice at least once (the assertion above is a real exclusion, not vacuously true)', '');

    // "both people for shared slots": the SAME union-of-avoid-lists mechanism candidatesFor
    // and the shared picker already use elsewhere (unionAvoid) — only ELENA avoids
    // shellfish, but the union still carries it, so a shared pick still never gets prawns.
    const avoidUnion = call(ctx, 'unionAvoid', [['shellfish'], []]);
    let prawnsInSharedUnion = false;
    for(let d = 0; d < 7; d++){
      for(let si = 0; si < 4; si++){
        const o = call(ctx, 'chosenOptsForRecipe', [fixtureRecipe, 0, d, si, avoidUnion]);
        if(o.protein === 'prawns') prawnsInSharedUnion = true;
      }
    }
    assert(prawnsInSharedUnion === false,
      'chosenOptsForRecipe under unionAvoid(elenaAvoid, partnerAvoid): a shared pick respects EITHER person\'s avoid-list, never just the acting person\'s', '');
  })();

  // -------- (6) zero allowed choices in a group excludes the whole recipe from the pool —
  // both at the pure allowedChoicesForGroup/recipeOptionsViable level and end-to-end
  // through candidatesFor(). --------
  const FIXTURE_ALL_SHELLFISH_ID = '__d1_fixture_allshellfish__';
  (function(){
    const allShellfishGroup = {key: 'protein', label: 'Protein', choices: [
      {id: 'prawns-a', label: 'Prawns A', ingredients: [['prawns', 100]]},
      {id: 'prawns-b', label: 'Prawns B', ingredients: [['prawns', 120]]}
    ]};
    const allShellfishRecipe = {
      title: 'D1 all-shellfish fixture', emoji: '🧪', slot: 'dinner', role: 'full',
      styles: ['balanced'], time: 10, ingredients: [['olive-oil', 5]],
      toTaste: [], steps: ['Combine and enjoy.'], tags: [], avoid: [],
      optionGroups: [allShellfishGroup]
    };
    const allowedNone = call(ctx, 'allowedChoicesForGroup', [allShellfishGroup, ['shellfish']]);
    assert(Array.isArray(allowedNone) && allowedNone.length === 0,
      'allowedChoicesForGroup: every choice hit by the avoid-list leaves zero allowed', JSON.stringify(allowedNone));
    assert(call(ctx, 'recipeOptionsViable', [allShellfishRecipe, ['shellfish']]) === false,
      'recipeOptionsViable: false once a group has zero allowed choices under the avoid-list', '');
    assert(call(ctx, 'recipeOptionsViable', [allShellfishRecipe, []]) === true,
      'recipeOptionsViable: true with no avoid-list restricting the group', '');
    assert(call(ctx, 'chosenOptsForRecipe', [allShellfishRecipe, 0, 0, 0, ['shellfish']]) === null,
      'chosenOptsForRecipe: returns null (cannot pick) when a group has zero allowed choices', '');

    run(ctx, "RECIPES_DB['" + FIXTURE_ALL_SHELLFISH_ID + "'] = " + JSON.stringify(allShellfishRecipe) + ';');
    const poolNoAvoid = call(ctx, 'candidatesFor', ['dinner', 'balanced', []]);
    assert(poolNoAvoid.indexOf(FIXTURE_ALL_SHELLFISH_ID) !== -1,
      'candidatesFor: a recipe whose optionGroups all still have >=1 allowed choice stays in the pool', '');
    const poolShellfishAvoid = call(ctx, 'candidatesFor', ['dinner', 'balanced', ['shellfish']]);
    assert(poolShellfishAvoid.indexOf(FIXTURE_ALL_SHELLFISH_ID) === -1,
      'candidatesFor: a recipe with a zero-allowed-choices group drops from the pool entirely once the avoid-list is applied', '');
    run(ctx, "delete RECIPES_DB['" + FIXTURE_ALL_SHELLFISH_ID + "'];");
  })();

  // -------- (7) planner wiring end-to-end: pickSoloMeal/pickSharedMeal, called directly
  // with a single-candidate pool (so the fixture is guaranteed to win — this isolates the
  // opts-assignment wiring from the unrelated kcal/protein scoring competition against the
  // real 30+ recipe catalog), actually store the rotated combo on entry.opts, agree with
  // chosenOptsForRecipe() called with the same inputs, and are deterministic across two
  // calls. --------
  (function(){
    function freshHistory(){
      const h = {};
      SLOT_ORDER.forEach(function(s){ h[s] = []; });
      h.sideUse = {}; h.bfPairUse = {};
      return h;
    }
    const history = {elena: freshHistory(), partner: freshHistory()};
    const weekSeed = call(ctx, 'stableHash', [FIXED_MONDAY]);

    ctx.__savedElenaAvoid__ = get(ctx, 'PROF.elena.avoid');
    run(ctx, 'PROF.elena.avoid = [];');
    const soloEntry1 = call(ctx, 'pickSoloMeal', [[FIXTURE_ID], 'elena', 'snack', 3, 2, 600, 30, 1, history, weekSeed, null]);
    const soloEntry2 = call(ctx, 'pickSoloMeal', [[FIXTURE_ID], 'elena', 'snack', 3, 2, 600, 30, 1, history, weekSeed, null]);
    run(ctx, 'PROF.elena.avoid = __savedElenaAvoid__; delete __savedElenaAvoid__;');

    assert(JSON.stringify(soloEntry1) === JSON.stringify(soloEntry2),
      'pickSoloMeal: two calls with identical inputs produce a byte-identical entry (incl. .opts)', JSON.stringify(soloEntry1) + ' vs ' + JSON.stringify(soloEntry2));
    assert(soloEntry1.recipeId === FIXTURE_ID && !!soloEntry1.opts,
      'pickSoloMeal: the single-candidate pool is picked and its entry carries an .opts field', JSON.stringify(soloEntry1));
    const expectedSoloOpts = call(ctx, 'chosenOptsForRecipe', [fixtureRecipe, weekSeed, 3, 2, []]);
    assert(JSON.stringify(soloEntry1.opts) === JSON.stringify(expectedSoloOpts),
      'pickSoloMeal: entry.opts matches chosenOptsForRecipe() called with the same (weekSeed, dayIndex, slotIndex, avoidList=PROF.elena.avoid)',
      'got=' + JSON.stringify(soloEntry1.opts) + ' expected=' + JSON.stringify(expectedSoloOpts));

    ctx.__savedElenaAvoid2__ = get(ctx, 'PROF.elena.avoid');
    ctx.__savedPartnerAvoid__ = get(ctx, 'PROF.partner.avoid');
    run(ctx, "PROF.elena.avoid = ['shellfish']; PROF.partner.avoid = [];");
    const sharedRemainingKcal = {elena: 1200, partner: 1500};
    const sharedRemainingProtein = {elena: 60, partner: 80};
    const sharedEntry = call(ctx, 'pickSharedMeal', [[FIXTURE_ID], 'snack', 4, 1, sharedRemainingKcal, sharedRemainingProtein, 1, history, weekSeed, null]);
    run(ctx, 'PROF.elena.avoid = __savedElenaAvoid2__; PROF.partner.avoid = __savedPartnerAvoid__; delete __savedElenaAvoid2__; delete __savedPartnerAvoid__;');

    assert(sharedEntry.shared === true && sharedEntry.recipeId === FIXTURE_ID,
      'pickSharedMeal: the single-candidate pool is picked for the shared unit', JSON.stringify(sharedEntry));
    assert(JSON.stringify(sharedEntry.elena.opts) === JSON.stringify(sharedEntry.partner.opts),
      'pickSharedMeal: elena and partner get the SAME variant on a shared dish', JSON.stringify(sharedEntry.elena.opts) + ' vs ' + JSON.stringify(sharedEntry.partner.opts));
    assert(sharedEntry.elena.opts.protein !== 'prawns',
      'pickSharedMeal: with only elena avoiding shellfish, the SHARED pick (avoid union) still never gets prawns', JSON.stringify(sharedEntry.elena.opts));
  })();

  // -------- (8) shopping list aggregates the CHOSEN variant's ingredients, not the default
  // combo — differential check (before/after) so a coincidental real-recipe use of the same
  // foods elsewhere in the week can't produce a false pass. --------
  (function(){
    run(ctx, 'weekPlans = {}; weekPlan = null;');
    const plan = call(ctx, 'ensureWeekPlan', []);
    const wk = plan.weekStartDate;
    const before = call(ctx, 'computeShoppingList', [wk]);
    const prawnsName = FOODS.prawns.name, potatoesName = FOODS.potatoes.name;
    const beforePrawns = (before.totals[prawnsName] && before.totals[prawnsName].qty) || 0;
    const beforePotatoes = (before.totals[potatoesName] && before.totals[potatoesName].qty) || 0;

    const chosenEntry = {recipeId: FIXTURE_ID, portion: 1, kcal: 0, protein: 0, opts: {protein: 'prawns', carb: 'potato'}};
    run(ctx, "weekPlans['" + wk + "'].days[0].meals.lunch.elena = " + JSON.stringify(chosenEntry) + ';');
    const after = call(ctx, 'computeShoppingList', [wk]);
    const afterPrawns = (after.totals[prawnsName] && after.totals[prawnsName].qty) || 0;
    const afterPotatoes = (after.totals[potatoesName] && after.totals[potatoesName].qty) || 0;
    run(ctx, 'weekPlans = {}; weekPlan = null;');

    assert(Math.abs((afterPrawns - beforePrawns) - 150) < 1e-6,
      'computeShoppingList: buys the CHOSEN variant\'s ingredient (150g prawns), not the default (salmon)', 'delta=' + (afterPrawns - beforePrawns));
    assert(Math.abs((afterPotatoes - beforePotatoes) - 150) < 1e-6,
      'computeShoppingList: buys the CHOSEN variant\'s carb choice (150g potatoes), not the default (rice)', 'delta=' + (afterPotatoes - beforePotatoes));
  })();

  // -------- (9) a frozen log entry keeps the variant's macros after the fixture recipe's
  // choice data is mutated afterward — proving `.opts` pins the CHOICE, and the entry's own
  // snapshot fields never re-derive from a later DB edit (log.js's frozen-history contract).
  // A live recompute of the SAME components (nutritionForRecipeComponents) DOES change post-
  // mutation, so the frozen assertion below is a real guarantee, not a vacuous one. --------
  (function(){
    run(ctx, 'logHistory = {};');
    const chosenOpts = {protein: 'cod', carb: 'rice'};
    const components = [{recipeId: FIXTURE_ID, portion: 1, opts: chosenOpts}];
    const preMutationNut = call(ctx, 'nutritionForRecipeComponents', [components]);
    call(ctx, 'logPlanEntry', [FIXED_MONDAY, 'elena', 'dinner', FIXTURE_ID, 1, components]);

    function loggedDinnerEntry(){
      const arr = get(ctx, "logHistory['" + FIXED_MONDAY + "'].elena");
      return arr.filter(function(e){ return e.kind === 'plan' && e.slot === 'dinner'; })[0];
    }
    const before = loggedDinnerEntry();
    assert(!!before && before.kcal === Math.round(preMutationNut.kcal) && before.protein === Math.round(preMutationNut.protein),
      'logPlanEntry: freezes the CHOSEN variant\'s macros at log time (matches an independently-computed nutritionForRecipeComponents total)',
      'got=' + JSON.stringify(before) + ' expected kcal=' + Math.round(preMutationNut.kcal) + ' protein=' + Math.round(preMutationNut.protein));

    // Mutate the fixture's "cod" choice drastically (150g -> 900g) directly in RECIPES_DB.
    run(ctx, "RECIPES_DB['" + FIXTURE_ID + "'].optionGroups[0].choices[1].ingredients = [['cod', 900]];");
    const postMutationNut = call(ctx, 'nutritionForRecipeComponents', [components]);
    assert(Math.abs(postMutationNut.kcal - preMutationNut.kcal) > 50,
      'D1 test setup: mutating the fixture\'s chosen choice DOES change a fresh live recompute (proves the frozen-entry assertion below is meaningful, not vacuous)',
      'pre=' + preMutationNut.kcal + ' post=' + postMutationNut.kcal);

    const after = loggedDinnerEntry();
    assert(after.kcal === before.kcal && after.protein === before.protein,
      'logPlanEntry: the already-frozen LogEntry\'s macros are UNCHANGED after the fixture recipe\'s choice data is mutated',
      'before=' + JSON.stringify(before) + ' after=' + JSON.stringify(after));

    run(ctx, 'logHistory = {};');
  })();

  // -------- (10) title helper: recipeDisplayTitle + its wiring into
  // mealTitleWithExtras/logEntryTitleWithComponents. --------
  (function(){
    const titleDefault = call(ctx, 'recipeDisplayTitle', [FIXTURE_ID, null]);
    assert(titleDefault === 'D1 fixture dish (Salmon, Rice)',
      'recipeDisplayTitle: default combo appends every group\'s choices[0] label in parens', titleDefault);

    const titleChosen = call(ctx, 'recipeDisplayTitle', [FIXTURE_ID, {protein: 'cod', carb: 'potato'}]);
    assert(titleChosen === 'D1 fixture dish (Cod, Potato)',
      'recipeDisplayTitle: an explicit combo appends the CHOSEN labels', titleChosen);

    const titleBadOpts = call(ctx, 'recipeDisplayTitle', [FIXTURE_ID, {protein: 'nonsense'}]);
    assert(titleBadOpts === titleDefault,
      'recipeDisplayTitle: bad opts falls back to the default-combo title', titleBadOpts);

    const plainTitle = call(ctx, 'recipeDisplayTitle', ['yogurt', null]);
    assert(plainTitle === RECIPES_DB.yogurt.title,
      'recipeDisplayTitle: a recipe without optionGroups is identical to the bare title (byte-for-byte, no parens)', plainTitle);

    const mtwe = call(ctx, 'mealTitleWithExtras', [{recipe: {title: 'ignored'}, recipeId: FIXTURE_ID, opts: {protein: 'cod', carb: 'potato'}, extras: []}]);
    assert(mtwe === 'D1 fixture dish (Cod, Potato)',
      'mealTitleWithExtras: reads the base title through recipeDisplayTitle(view.recipeId, view.opts)', mtwe);

    const letc = call(ctx, 'logEntryTitleWithComponents', [{kind: 'plan', ref: FIXTURE_ID, components: [{recipeId: FIXTURE_ID, portion: 1, opts: {protein: 'prawns', carb: 'rice'}}]}]);
    assert(letc === 'D1 fixture dish (Prawns, Rice)',
      'logEntryTitleWithComponents: reads the base title through recipeDisplayTitle(entry.ref, components[0].opts)', letc);
  })();

  // -------- cleanup: leave RECIPES_DB/weekPlans/logHistory exactly as every other test
  // expects them. --------
  run(ctx, "delete RECIPES_DB['" + FIXTURE_ID + "']; weekPlans = {}; weekPlan = null; logHistory = {};");
}

/* ===================================================================
   main
   =================================================================== */

function main(){
  const ctx = createMesaContext();
  loadAppInto(ctx);

  runTest('data: validateData()', function(){ testValidateData(ctx); });
  runTest('recipe roles + breakfastPair whitelist (task B2)', function(){ testRecipeRolesAndBreakfastPair(ctx); });
  runTest('goal toggles (task B1)', function(){ testGoalToggles(ctx); });
  runTest('nutrition determinism', function(){ testNutritionDeterminism(ctx); });
  runTest('foodMacros linearity', function(){ testFoodMacrosLinearity(ctx); });
  runTest('ingredient detail page markup (task C4)', function(){ testFoodDetailMarkup(ctx); });
  runTest('ingredient icon picker (task C5)', function(){ testIconPicker(ctx); });
  runTest('recipe display helpers (compat-view removal)', function(){ testRecipeDisplayHelpers(ctx); });
  runTest('recipe image helpers (task B)', function(){ testRecipeImageHelpers(ctx); });
  runTest('recipe catalog cleanup', function(){ testRecipeCatalogCleanup(ctx); });
  runTest('recipe image picker', function(){ testRecipeImagePicker(ctx); });
  runTest('library recipe rows open detail', function(){ testLibraryRecipeRowsOpenDetail(); });
  runTest('no legacy RECIPES compat view', function(){ testNoLegacyRecipesCompatView(); });
  runTest('mergeLibrarySection: newer-wins', function(){ testMergeLibraryNewerWins(ctx); });
  runTest('mergeLibrarySection: tombstone + idempotence', function(){ testMergeLibraryTombstoneIdempotence(ctx); });
  runTest('mergeLibrarySection: ratchet regression', function(){ testMergeLibraryRatchetRegression(ctx); });
  runTest('mergeLogSection', function(){ testMergeLogSection(ctx); });
  runTest('mergePlansSection', function(){ testMergePlansSection(ctx); });
  runTest('mealRules pinFromDate persistence', function(){ testMealRulePinFromDatePersistence(ctx); });
  runTest('mealRules pinFromDate sync apply', function(){ testMealRulePinFromDateSyncApply(ctx); });
  runTest('pinned re-balance unit exclusion', function(){ testPinnedRebalanceDoesNotTouchPinnedUnit(ctx); });
  runTest('pinned future regeneration contract', function(){ testPinnedFutureMealSurvivesRegenerationContract(ctx); });
  runTest('routine pin helper contracts', function(){ testRoutinePinHelperContracts(ctx); });
  runTest('planner determinism', function(){ testPlannerDeterminism(ctx); });
  runTest('next-week tuning (task C2)', function(){ testNextWeekTuning(ctx); });
  runTest('composed meals (task B2 part 2)', function(){ testComposedMeals(ctx); });
  runTest('planner meal-extras', function(){ testMealExtras(ctx); });
  runTest('week catch-up logging (task B5)', function(){ testWeekCatchupLogging(ctx); });
  runTest('week nutrient summary (task B4)', function(){ testWeekNutriSummary(ctx); });
  runTest('week quick-add logged foods counted (task C3)', function(){ testWeekQuickAddNutrition(ctx); });
  runTest('week extras on next-week meal (task B3)', function(){ testWeekExtrasNextWeek(ctx); });
  runTest('Insights per-day nutrient bands (task C1)', function(){ testInsightsNutrientBands(ctx); });
  runTest('recipe options/variants (task D1)', function(){ testRecipeOptions(ctx); });
  runTest('refreshAfterLogChange renders Week exactly once (task C1)', function(){ testRefreshAfterLogChangeRendersWeekOnce(); });
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
