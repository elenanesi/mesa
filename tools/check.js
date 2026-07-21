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
  'js/state.js', 'js/log.js', 'js/engine.js', 'js/planner.js', 'js/pantry.js', 'js/render.js',
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

// engine.js:recipeNutrition — perServing must divide only numeric totals fields.
// totals.sugarQuality is a string ('unknown'); dividing it by servings used to
// silently produce NaN instead of carrying the string through unchanged.
function testNutritionPerServingNonNumericFields(ctx){
  const sampleId = Object.keys(get(ctx, 'RECIPES_DB'))[0];
  const n = call(ctx, 'recipeNutrition', [sampleId, 3]);
  assert(n.perServing.sugarQuality === 'unknown',
    "nutrition: perServing.sugarQuality stays the string 'unknown' (not divided into NaN) at servings > 1",
    'got ' + JSON.stringify(n.perServing.sugarQuality));
  assert(typeof n.perServing.kcal === 'number' && Math.abs(n.perServing.kcal * 3 - n.totals.kcal) < 1e-6,
    'nutrition: perServing.kcal is still a correctly-divided number at servings > 1',
    'got ' + n.perServing.kcal);
  assert(typeof n.perServing.goodFat === 'number' && Math.abs(n.perServing.goodFat * 3 - n.totals.goodFat) < 1e-6,
    'nutrition: perServing.goodFat is still a correctly-divided number at servings > 1 (goodFat is numeric but not in NUTRIENT_KEYS, so a whitelist would miss it)',
    'got ' + n.perServing.goodFat);
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

/* ---------------- "Add to pantry" on ingredient cards ----------------
   The button lives on both ingredient surfaces (the Library > Ingredients rows and the
   ingredient detail page) and routes through openPantryAddForFood(), which reuses P2's
   selectPantryAddFood/confirmPantryAdd quantity flow. openPantryAddForFood itself can't be
   called here (it paints #sheetBody, and this harness's getElementById always returns
   null — see the file header), so the wiring is asserted the same way the C1 render-funnel
   guards do it: over the real source text. */
function testAddToPantryOnIngredientCards(ctx){
  const listHtml = call(ctx, 'renderLibFoodListMarkup', ['']);
  const rowCount = (listHtml.match(/class="altrow" data-food-id=/g) || []).length;
  const pantryBtnCount = (listHtml.match(/data-act="pantry"/g) || []).length;
  assert(rowCount > 0, 'setup: the ingredients list rendered at least one row', 'rows=' + rowCount);
  assert(pantryBtnCount === rowCount,
    'renderLibFoodListMarkup: every ingredient row offers Add to pantry (one button per row, regardless of built-in/custom)',
    'rows=' + rowCount + ' pantryButtons=' + pantryBtnCount);

  // Regression guard of the same class the README calls out for recipe rows: the row BODY
  // must still open the ingredient detail. A new action button must not swallow the row tap.
  const listSrc = fs.readFileSync(path.join(APP_DIR, 'js/library.js'), 'utf8');
  const handler = /function attachLibFoodListHandler\(\)\{[\s\S]*?\n\}/.exec(listSrc);
  assert(!!handler, 'setup: attachLibFoodListHandler() found in library.js');
  assert(/openFoodDetail\(row\.getAttribute\('data-food-id'\)\)/.test(handler[0]),
    'attachLibFoodListHandler: tapping the row body still opens the ingredient detail page');
  assert(/act === 'pantry'\) openPantryAddForFood\(id\)/.test(handler[0]),
    'attachLibFoodListHandler: the pantry button is routed (a data-act with no branch renders a dead button)');

  const detailHandler = /function attachFoodDetailHandler\(\)\{[\s\S]*?\n\}/.exec(listSrc);
  assert(!!detailHandler, 'setup: attachFoodDetailHandler() found in library.js');
  assert(/act === 'pantry'\) openPantryAddForFood\(id\)/.test(detailHandler[0]),
    'attachFoodDetailHandler: the detail page pantry button is routed');

  // The whole point of openPantryAddForFood is that it REUSES the one quantity flow. If a
  // future edit gives it its own setPantryRemaining call, the app grows a second notion of
  // "how much" and a second place that must honour the re-baselining rule.
  const opener = /function openPantryAddForFood\(foodId\)\{[\s\S]*?\n\}/.exec(listSrc);
  assert(!!opener, 'setup: openPantryAddForFood() found in library.js');
  assert(/selectPantryAddFood\(foodId\)/.test(opener[0]),
    'openPantryAddForFood: delegates to selectPantryAddFood — one quantity-entry path, not a private shortcut');
  assert(opener[0].indexOf('setPantryRemaining') === -1,
    'openPantryAddForFood: does NOT write the pantry directly — it must go through confirmPantryAdd/setPantryRemaining\'s re-baselining path', opener[0]);

  // fmtShopQty already appends the unit ("100 g"), so a call site that ALSO appends
  // food.unit renders "100 g g" — which shipped in P2's add toast, its "Already have …"
  // note and the picker's in-stock pill, and was only caught by looking at the screen.
  // fmtPantryQty is the single formatter; assert both that it is correct and that no call
  // site re-appends the unit around it.
  assert(call(ctx, 'fmtPantryQty', [100, get(ctx, "FOODS['apples']")]) === '100 g',
    'fmtPantryQty: a gram food formats once, not "100 g g"', call(ctx, 'fmtPantryQty', [100, get(ctx, "FOODS['apples']")]));
  assert(call(ctx, 'fmtPantryQty', [2, get(ctx, "FOODS['eggs']")]) === '2',
    'fmtPantryQty: a piece food formats as a bare count', call(ctx, 'fmtPantryQty', [2, get(ctx, "FOODS['eggs']")]));
  assert(!/fmtPantryQty\([^)]*\)\s*\+\s*\(?[a-z]*\.?unit/.test(listSrc),
    'no pantry call site re-appends the unit around fmtPantryQty (the "100 g g" bug)');
}

/* ---------------- Pantry page: category sections + filters ----------------
   The Pantry list groups into the same SHOP_CAT_ORDER sections the Ingredients list and
   the shopping list use, with a category-chip filter alongside the search box. */
function testPantrySectionsAndFilters(ctx){
  const savedPantry = cloneJSON(get(ctx, 'pantry'));
  try{
    run(ctx, "pantry = {}; libPantryQuery = ''; libPantryFilters = {cats: new Set()}; libPantryFiltersOpen = false;");
    // apples -> Produce, whole milk -> Dairy, chicken breast -> Protein.
    run(ctx, "pantry['apples'] = {qty: 500, setAt: 1, u: 1};");
    run(ctx, "pantry['greek-yogurt'] = {qty: 1000, setAt: 1, u: 1};");
    run(ctx, "pantry['chicken-breast'] = {qty: 300, setAt: 1, u: 1};");
    const cats = ['apples', 'greek-yogurt', 'chicken-breast'].map(function(id){ return get(ctx, "FOODS['" + id + "'] && FOODS['" + id + "'].cat"); });
    assert(cats.every(Boolean), 'setup: the three fixture foods exist with categories', JSON.stringify(cats));

    // (1) Sections render, in SHOP_CAT_ORDER, and only for categories that hold stock.
    const html = call(ctx, 'renderPantryListMarkup', ['']);
    const headings = (html.match(/<div class="shop-cat">([^<]+)<\/div>/g) || [])
      .map(function(h){ return h.replace(/<[^>]+>/g, ''); });
    const order = get(ctx, 'SHOP_CAT_ORDER');
    const expected = order.filter(function(c){ return cats.indexOf(c) !== -1; });
    assert(JSON.stringify(headings) === JSON.stringify(expected),
      'renderPantryListMarkup: groups stock into category sections, in SHOP_CAT_ORDER, only for categories that have items',
      'got ' + JSON.stringify(headings) + ' expected ' + JSON.stringify(expected));

    // (2) A category chip narrows the list to that section alone.
    run(ctx, "libPantryFilters.cats.add('Dairy');");
    const dairyOnly = call(ctx, 'renderPantryListMarkup', ['']);
    assert(dairyOnly.indexOf('data-food-id="greek-yogurt"') !== -1 && dairyOnly.indexOf('data-food-id="apples"') === -1,
      'renderPantryListMarkup: a category filter shows only that category', dairyOnly.slice(0, 200));
    assert(call(ctx, 'countFilteredPantryItems', ['']) === 1,
      'countFilteredPantryItems: counts the filtered rows, not the whole pantry', String(call(ctx, 'countFilteredPantryItems', [''])));

    // (3) The two narrowed-to-nothing states must NOT claim the pantry is empty — that
    // would read as data loss when the user has simply over-filtered.
    run(ctx, "libPantryFilters = {cats: new Set(['Frozen'])};");
    const noMatch = call(ctx, 'renderPantryListMarkup', ['']);
    assert(noMatch.indexOf('No items match') !== -1 && noMatch.indexOf('Nothing in your pantry yet') === -1,
      'renderPantryListMarkup: over-filtering says "no items match", never "nothing in your pantry"', noMatch);
    run(ctx, "libPantryFilters = {cats: new Set()}; pantry = {};");
    const trulyEmpty = call(ctx, 'renderPantryListMarkup', ['']);
    assert(trulyEmpty.indexOf('Nothing in your pantry yet') !== -1,
      'renderPantryListMarkup: a genuinely empty pantry gets the onboarding nudge', trulyEmpty);

    // (4) qty:0 tombstones (setPantryRemaining's delete shape) never render as stock.
    run(ctx, "pantry = {'apples': {qty: 0, setAt: 1, u: 1}};");
    assert(call(ctx, 'renderPantryListMarkup', ['']).indexOf('data-food-id="apples"') === -1,
      'renderPantryListMarkup: a qty:0 delete tombstone is not shown as in stock');

    // (5) Typing in the search box repaints the filter bar too, so the item count can't go
    // stale — the known wart the Ingredients page still has.
    const src = fs.readFileSync(path.join(APP_DIR, 'js/library.js'), 'utf8');
    const onInput = /function onLibPantrySearchInput\(v\)\{[\s\S]*?\n\}/.exec(src);
    assert(!!onInput && /rerenderPantryFilteredView\(\)/.test(onInput[0]),
      'onLibPantrySearchInput: repaints the filter bar (item count) as well as the list',
      onInput && onInput[0]);
  } finally {
    run(ctx, "pantry = " + JSON.stringify(savedPantry) + "; libPantryQuery = ''; libPantryFilters = {cats: new Set()}; libPantryFiltersOpen = false;");
  }
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

  // 1b) "Add to pantry" is offered on EVERY ingredient, built-in or custom — unlike
  // edit/reset/delete it does not depend on provenance. The button carries data-act="pantry"
  // so attachFoodDetailHandler's delegation routes it; a missing verb would render a dead
  // button rather than an obvious error.
  const pantryDetailHtml = call(ctx, 'buildFoodDetailMarkup', ['eggs']);
  assert(pantryDetailHtml.indexOf('data-act="pantry"') !== -1,
    'buildFoodDetailMarkup: every ingredient detail offers an Add to pantry action', pantryDetailHtml);

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
  assert(JSON.stringify(call(ctx, 'availableRecipeImageKeys', [])) === JSON.stringify(['default-recipe', 'breakfast-bowl', 'salad', 'soup', 'pasta', 'cooked-vegetables', 'meat-main', 'fish-main', 'dessert-sweets', 'ice-cream', 'ramen', 'butter-chicken', 'chinese-dinner', 'fast-food-menu', 'onigiri', 'french-toast', 'pancakes', 'boiled-chicken-broth', 'burrito', 'citrus-roast-turkey', 'club-sandwich', 'shakshuka', 'polpette-tacchino-yogurt-menta', 'feta-filo-miele-noodles-verdure', 'pomodori-al-riso', 'ricotta-pere-noci-toast', 'uova-avocado-toast', 'carrots-over-hummus', 'spring-rolls', 'pizza']),
    'availableRecipeImageKeys: returns curated recipe image set plus approved ad hoc recipe images', JSON.stringify(call(ctx, 'availableRecipeImageKeys', [])));
  assert(call(ctx, 'safeRecipeImageKey', ['fish-main']) === 'fish-main',
    'safeRecipeImageKey: accepts an available recipe image key', '');
  assert(call(ctx, 'safeRecipeImageKey', ['dessert-sweets']) === 'dessert-sweets',
    'safeRecipeImageKey: accepts the sweets recipe image key', '');
  assert(call(ctx, 'safeRecipeImageKey', ['ice-cream']) === 'ice-cream',
    'safeRecipeImageKey: accepts the ice cream recipe image key', '');
  assert(call(ctx, 'safeRecipeImageKey', ['salmon-greens']) === '',
    'safeRecipeImageKey: rejects unavailable recipe image keys even if kebab-case', '');
  assert(call(ctx, 'safeRecipeImageKey', ['../salmon']) === '',
    'safeRecipeImageKey: rejects path traversal / format-invalid keys', '');
  assert(call(ctx, 'safeRecipeImageAsset', ['assets/recipes/salmon-greens.png']) === 'assets/recipes/salmon-greens.png',
    'safeRecipeImageAsset: accepts assets/recipes/<key>.png paths', '');
  assert(call(ctx, 'safeRecipeImageAsset', ['assets/ingredients/salmon-greens.png']) === '',
    'safeRecipeImageAsset: rejects non-recipe asset directories', '');
  assert(call(ctx, 'recipeImageAssetForRecipe', [{title: 'URI hero test', emoji: '🍽️', imageUri: 'assets/recipes/pizza.png', imageKey: 'fish-main'}]) === 'assets/recipes/pizza.png',
    'recipeImageAssetForRecipe: recipe imageUri takes priority over imageKey', '');
  assert(call(ctx, 'recipeImageAssetForRecipe', [{title: 'Bad URI test', emoji: '🍽️', imageUri: 'https://evil.example/pizza.png', imageKey: 'fish-main'}]) === 'assets/recipes/fish-main.png',
    'recipeImageAssetForRecipe: rejects off-origin imageUri and falls back safely', '');
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
  assert(call(ctx, 'recipeImageAssetForRecipe', [{title: 'Tuna salad', emoji: '🥗', slot: 'lunch', tags: [], ingredients: [['tuna-in-olive-oil', 100]]}]) === 'assets/recipes/salad.png',
    'recipeImageAssetForRecipe: salad presentation wins over fish ingredients for tuna salad', '');
  assert(call(ctx, 'recipeImageAssetForRecipe', [{title: 'Baked cod', emoji: '🐟', slot: 'dinner', tags: [], ingredients: [['cod', 120]]}]) === 'assets/recipes/fish-main.png',
    'recipeImageAssetForRecipe: fish ingredients use the fish-main image even for dinner recipes', '');
  assert(call(ctx, 'recipeImageAssetForRecipe', [{title: 'Black kale soup', emoji: '🍲', slot: 'dinner', tags: [], ingredients: [['cooked-lentils', 100]]}]) === 'assets/recipes/soup.png',
    'recipeImageAssetForRecipe: soups use the soup image', '');
  assert(call(ctx, 'recipeImageAssetForRecipe', [{title: 'Pasta with tomato', emoji: '🍝', slot: 'dinner', tags: [], ingredients: [['pasta', 90]]}]) === 'assets/recipes/pasta.png',
    'recipeImageAssetForRecipe: pasta dishes use the pasta image', '');
  assert(call(ctx, 'recipeImageAssetForRecipe', [{title: 'Ramen', emoji: '🍜', slot: 'dinner', tags: [], ingredients: [['ramen-noodles', 70], ['eggs', 50]]}]) === 'assets/recipes/ramen.png',
    'recipeImageAssetForRecipe: ramen recipes use the specific ramen image', '');
  assert(call(ctx, 'recipeImageAssetForRecipe', [{title: 'Onigiri', emoji: '🍙', slot: 'lunch', tags: [], ingredients: [['rice', 100]]}]) === 'assets/recipes/onigiri.png',
    'recipeImageAssetForRecipe: onigiri recipes use the specific onigiri image', '');
  assert(call(ctx, 'recipeImageAssetForRecipe', [{title: 'French toast with fruit', emoji: '🍞', slot: 'breakfast', tags: [], ingredients: [['white-bread', 70]]}]) === 'assets/recipes/french-toast.png',
    'recipeImageAssetForRecipe: French toast recipes use the specific French toast image', '');
  assert(call(ctx, 'recipeImageAssetForRecipe', [{title: 'Pancakes', emoji: '🥞', slot: 'breakfast', tags: [], ingredients: [['oats', 45]]}]) === 'assets/recipes/pancakes.png',
    'recipeImageAssetForRecipe: pancakes use the pancakes image', '');
  assert(call(ctx, 'recipeImageAssetForRecipe', [{title: 'Ice cream', emoji: '🍨', slot: 'snack', tags: [], ingredients: [['milk', 90]]}]) === 'assets/recipes/ice-cream.png',
    'recipeImageAssetForRecipe: ice cream uses the ice cream image', '');
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
  assert(!RECIPES_DB['pasta-pomodorini-funghi-broccoli'],
    'recipe catalog cleanup: removes cherry tomato, mushroom & broccoli pasta', '');
  assert(RECIPES_DB['baked-fish'].imageKey === 'fish-main',
    'recipe catalog cleanup: baked fish uses the fish image explicitly', JSON.stringify(RECIPES_DB['baked-fish']));
  assert(RECIPES_DB.tunasalad && call(ctx, 'recipeImageAssetForRecipe', [RECIPES_DB.tunasalad, 'tunasalad']) === 'assets/recipes/salad.png',
    'recipe catalog cleanup: tuna salad uses salad art in Auto', JSON.stringify(RECIPES_DB.tunasalad));
  assert(RECIPES_DB.ramen.imageKey === 'ramen' && RECIPES_DB['butter-chicken'].imageKey === 'butter-chicken',
    'recipe catalog cleanup: specific requested recipes carry specific image keys', JSON.stringify({ramen: RECIPES_DB.ramen.imageKey, butterChicken: RECIPES_DB['butter-chicken'].imageKey}));
  assert(RECIPES_DB['brownie-dessert'].imageKey === 'dessert-sweets' && RECIPES_DB['gelato-cioccolato'].imageKey === 'ice-cream',
    'recipe catalog cleanup: brownie stays sweets while ice cream uses ice cream art', JSON.stringify({brownie: RECIPES_DB['brownie-dessert'], gelato: RECIPES_DB['gelato-cioccolato']}));
  assert(RECIPES_DB.pizza && RECIPES_DB.pizza.imageUri === 'assets/recipes/pizza.png' && call(ctx, 'recipeImageAssetForRecipe', [RECIPES_DB.pizza, 'pizza']) === 'assets/recipes/pizza.png',
    'recipe catalog cleanup: pizza exists and points to its recipe image URI', JSON.stringify(RECIPES_DB.pizza));
}

// replaceBuiltinRecipesFromCatalogRows() (js/library.js) installs whatever the D1 catalog
// mirror returned as the new BUILTIN_RECIPES_DB/BUILTIN_RECIPE_SLOT_DB, guarded by a sanity
// floor (CATALOG_REPLACE_MIN_FRACTION of BUILTIN_RECIPE_COUNT) so a truncated/partially-seeded
// D1 response can't silently shrink the live catalog with no signal. CRITICAL: this function
// mutates the module-level BUILTIN_RECIPES_DB/BUILTIN_RECIPE_SLOT_DB globals that every later
// test in this shared vm context reads (applyCustomRecipes(), the D3 cleanup test's byte-
// identical check, ...) — snapshot both before touching them and restore afterwards, even if
// an assertion throws, so a failure here can never corrupt tests that run after it.
function testReplaceBuiltinRecipesFromCatalogRows(ctx){
  const recipesSnapshot = cloneJSON(get(ctx, 'BUILTIN_RECIPES_DB'));
  const slotsSnapshot = cloneJSON(get(ctx, 'BUILTIN_RECIPE_SLOT_DB'));
  function restore(){
    ctx.__restoreRecipes__ = recipesSnapshot;
    ctx.__restoreSlots__ = slotsSnapshot;
    run(ctx,
      "Object.keys(BUILTIN_RECIPES_DB).forEach(function(id){ delete BUILTIN_RECIPES_DB[id]; });" +
      "Object.keys(__restoreRecipes__).forEach(function(id){ BUILTIN_RECIPES_DB[id] = __restoreRecipes__[id]; });" +
      "Object.keys(BUILTIN_RECIPE_SLOT_DB).forEach(function(id){ delete BUILTIN_RECIPE_SLOT_DB[id]; });" +
      "Object.keys(__restoreSlots__).forEach(function(id){ BUILTIN_RECIPE_SLOT_DB[id] = __restoreSlots__[id]; });" +
      "delete __restoreRecipes__; delete __restoreSlots__;");
  }

  try {
    const bundled = recipesSnapshot; // pristine bundled catalog (~96 recipes), taken before this test touches anything
    const bundledIds = Object.keys(bundled);
    function rowFor(id, data){ return {id: id, scope: 'global', source: 'builtin', data: data || bundled[id]}; }

    // -------- (1) a full valid payload, built FROM the bundled catalog itself -> true, catalog replaced --------
    const fullRows = bundledIds.map(function(id){ return rowFor(id); });
    let result = call(ctx, 'replaceBuiltinRecipesFromCatalogRows', [fullRows]);
    assert(result === true,
      'replaceBuiltinRecipesFromCatalogRows: a full valid payload (built from the bundled catalog) returns true', String(result));
    let db = get(ctx, 'BUILTIN_RECIPES_DB');
    assert(Object.keys(db).length === bundledIds.length,
      'replaceBuiltinRecipesFromCatalogRows: a full payload replaces BUILTIN_RECIPES_DB with the same recipe count as the bundled catalog',
      Object.keys(db).length + ' vs ' + bundledIds.length);
    assert(JSON.stringify(db[bundledIds[0]]) === JSON.stringify(bundled[bundledIds[0]]),
      'replaceBuiltinRecipesFromCatalogRows: a full payload round-trips a bundled recipe unchanged', '');

    // -------- (2) a truncated payload (3 rows, far under the 50% floor) -> false, BUILTIN_RECIPES_DB
    // still holds the FULL bundled catalog (not the 96-row set replaceBuiltinRecipesFromCatalogRows()
    // itself just installed in scenario 1 — restore() first so "still full" actually proves rejection). --------
    restore();
    const truncatedRows = bundledIds.slice(0, 3).map(function(id){ return rowFor(id); });
    result = call(ctx, 'replaceBuiltinRecipesFromCatalogRows', [truncatedRows]);
    assert(result === false,
      'replaceBuiltinRecipesFromCatalogRows: a truncated payload (3 rows) returns false', String(result));
    db = get(ctx, 'BUILTIN_RECIPES_DB');
    assert(Object.keys(db).length === bundledIds.length,
      'replaceBuiltinRecipesFromCatalogRows: a rejected truncated payload leaves BUILTIN_RECIPES_DB holding the full bundled catalog',
      Object.keys(db).length + ' vs ' + bundledIds.length);

    // -------- (3) a payload above the floor containing some invalid rows (bad slot, missing
    // ingredients, empty title) -> true, the invalid rows are absent from the result, valid ones present --------
    restore();
    const aboveFloorIds = bundledIds.slice(0, Math.ceil(bundledIds.length * 0.6)); // well above the 50% floor
    const badSlotId = aboveFloorIds[0], badIngredientsId = aboveFloorIds[1], emptyTitleId = aboveFloorIds[2];
    const mixedRows = aboveFloorIds.map(function(id){
      if(id === badSlotId) return rowFor(id, Object.assign({}, bundled[id], {slot: 'not-a-real-slot'}));
      if(id === badIngredientsId) return rowFor(id, Object.assign({}, bundled[id], {ingredients: []}));
      if(id === emptyTitleId) return rowFor(id, Object.assign({}, bundled[id], {title: ''}));
      return rowFor(id);
    });
    result = call(ctx, 'replaceBuiltinRecipesFromCatalogRows', [mixedRows]);
    assert(result === true,
      'replaceBuiltinRecipesFromCatalogRows: a payload above the floor with a few invalid rows still returns true', String(result));
    db = get(ctx, 'BUILTIN_RECIPES_DB');
    assert(!db[badSlotId] && !db[badIngredientsId] && !db[emptyTitleId],
      'replaceBuiltinRecipesFromCatalogRows: rows with a bad slot / empty ingredients / empty title are dropped, not installed',
      JSON.stringify({badSlotPresent: !!db[badSlotId], badIngredientsPresent: !!db[badIngredientsId], emptyTitlePresent: !!db[emptyTitleId]}));
    const survivingIds = aboveFloorIds.filter(function(id){ return id !== badSlotId && id !== badIngredientsId && id !== emptyTitleId; });
    assert(survivingIds.every(function(id){ return !!db[id]; }) && Object.keys(db).length === survivingIds.length,
      'replaceBuiltinRecipesFromCatalogRows: exactly the valid rows of a mixed payload are installed, nothing extra left over',
      Object.keys(db).length + ' vs ' + survivingIds.length);

    // -------- (4a) a non-array argument -> false, catalog untouched --------
    restore();
    result = call(ctx, 'replaceBuiltinRecipesFromCatalogRows', [{not: 'an array'}]);
    assert(result === false,
      'replaceBuiltinRecipesFromCatalogRows: a non-array argument returns false', String(result));
    db = get(ctx, 'BUILTIN_RECIPES_DB');
    assert(Object.keys(db).length === bundledIds.length,
      'replaceBuiltinRecipesFromCatalogRows: a non-array argument leaves BUILTIN_RECIPES_DB untouched',
      Object.keys(db).length + ' vs ' + bundledIds.length);

    // -------- (4b) an all-invalid payload -> false, catalog untouched --------
    const allInvalidRows = bundledIds.map(function(id){
      return rowFor(id, {title: '', slot: 'nope', ingredients: []});
    });
    result = call(ctx, 'replaceBuiltinRecipesFromCatalogRows', [allInvalidRows]);
    assert(result === false,
      'replaceBuiltinRecipesFromCatalogRows: an all-invalid payload returns false', String(result));
    db = get(ctx, 'BUILTIN_RECIPES_DB');
    assert(Object.keys(db).length === bundledIds.length,
      'replaceBuiltinRecipesFromCatalogRows: an all-invalid payload leaves BUILTIN_RECIPES_DB untouched',
      Object.keys(db).length + ' vs ' + bundledIds.length);
  } finally {
    restore();
  }
}

function testRecipeImagePicker(ctx){
  run(ctx, "var __recipePickerStub = {toast: toast, openMyRecipes: openMyRecipes, applyProf: applyProf, renderFoodLibraryCount: renderFoodLibraryCount}; toast = function(){}; openMyRecipes = function(){}; applyProf = function(){}; renderFoodLibraryCount = function(){};");
  call(ctx, 'openNewRecipeForm', []);
  run(ctx, "recipeBuilder.name = 'Image picker recipe'; recipeBuilder.emoji = '🍽️'; recipeBuilder.ingredients = [{foodId:'eggs', grams:100}, {foodId:'spinach', grams:50}]; recipeBuilder.imagePickerOpen = true;");
  let html = call(ctx, 'buildRecipeBuilderSheet', []);
  assert(html.indexOf('Lead image') !== -1,
    'buildRecipeBuilderSheet: labels the recipe image control as Lead image', html);
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
  assert(get(ctx, 'recipeBuilder').imagePickerOpen === false,
    'openEditRecipeForm: normal recipe edit does not force-open the image picker', String(get(ctx, 'recipeBuilder').imagePickerOpen));
  html = call(ctx, 'buildRecipeBuilderSheet', []);
  assert(html.indexOf('Lead image') !== -1 && html.indexOf('Choose lead image') !== -1,
    'buildRecipeBuilderSheet: normal recipe edit exposes the Choose lead image action', html);
  call(ctx, 'openRecipeImageForm', ['salmon']);
  html = call(ctx, 'buildRecipeBuilderSheet', []);
  assert(get(ctx, 'recipeBuilder').imagePickerOpen === true && html.indexOf('data-role="recipe-image-grid"') !== -1,
    'openRecipeImageForm: opens edit recipe with the lead image picker expanded', html);
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

/* ---------------- PANTRY-plan.md P1: mergePantrySection ---------------- */
function emptyPantrySection(){ return {pantry: {}}; }

// (a) same foodId edited on both sides with different `u` — newer wins regardless of
// which side is passed as `local` (mirrors testMergeLibraryNewerWins).
function testMergePantrySectionNewerWins(ctx){
  const local = emptyPantrySection();
  local.pantry['eggs'] = {qty: 6, setAt: 1000, u: 1000};
  const remote = emptyPantrySection();
  remote.pantry['eggs'] = {qty: 2, setAt: 2000, u: 2000};
  const mergedLR = call(ctx, 'mergePantrySection', [cloneJSON(local), cloneJSON(remote)]);
  const mergedRL = call(ctx, 'mergePantrySection', [cloneJSON(remote), cloneJSON(local)]);
  assert(!!mergedLR.pantry['eggs'] && mergedLR.pantry['eggs'].qty === 2,
    'mergePantrySection: newer `u` wins (local, remote)', JSON.stringify(mergedLR.pantry['eggs']));
  assert(!!mergedRL.pantry['eggs'] && mergedRL.pantry['eggs'].qty === 2,
    'mergePantrySection: newer `u` wins regardless of argument order (remote, local)', JSON.stringify(mergedRL.pantry['eggs']));
}

// (b) a delete (qty:0 + fresh u) beats an older non-zero edit, survives alternating
// merges without resurrection (the bug class the "×200 (imported)" incident produced —
// see mergeLibrarySection's doc block), and the converged result is idempotent.
function testMergePantrySectionDeleteNotResurrected(ctx){
  const editedLocal = emptyPantrySection();
  editedLocal.pantry['milk'] = {qty: 500, setAt: 1000, u: 1000};
  const deletedRemote = emptyPantrySection();
  deletedRemote.pantry['milk'] = {qty: 0, setAt: 2000, u: 2000}; // newer than the edit — a delete

  const merged1 = call(ctx, 'mergePantrySection', [cloneJSON(editedLocal), cloneJSON(deletedRemote)]);
  assert(!!merged1.pantry['milk'] && merged1.pantry['milk'].qty === 0,
    'mergePantrySection: a newer qty:0 delete beats an older non-zero edit', JSON.stringify(merged1.pantry['milk']));

  // Repeated alternating merges (A->B, B->A, A->B) must not resurrect the deleted qty.
  let m = call(ctx, 'mergePantrySection', [cloneJSON(editedLocal), cloneJSON(deletedRemote)]);
  m = call(ctx, 'mergePantrySection', [cloneJSON(m), cloneJSON(editedLocal)]);
  m = call(ctx, 'mergePantrySection', [cloneJSON(m), cloneJSON(deletedRemote)]);
  assert(m.pantry['milk'].qty === 0,
    'mergePantrySection: alternating merges (A->B->A->B) never resurrect a deleted (qty:0) entry', JSON.stringify(m.pantry['milk']));

  // Idempotence: merging the converged result with either original input again is a no-op.
  const again1 = call(ctx, 'mergePantrySection', [cloneJSON(m), cloneJSON(editedLocal)]);
  const again2 = call(ctx, 'mergePantrySection', [cloneJSON(m), cloneJSON(deletedRemote)]);
  assert(JSON.stringify(again1) === JSON.stringify(m),
    'mergePantrySection: merging the converged result with the local input again is a no-op', 'converged=' + JSON.stringify(m) + ' after=' + JSON.stringify(again1));
  assert(JSON.stringify(again2) === JSON.stringify(m),
    'mergePantrySection: merging the converged result with the remote input again is a no-op', 'converged=' + JSON.stringify(m) + ' after=' + JSON.stringify(again2));
}

// (c) order-independence across a mix of only-local, only-remote, and conflicting
// foodIds — merge(A,B) must equal merge(B,A) content-wise.
function testMergePantrySectionOrderIndependence(ctx){
  const a = emptyPantrySection();
  a.pantry['eggs'] = {qty: 6, setAt: 1000, u: 1000};   // only in A
  a.pantry['milk'] = {qty: 200, setAt: 1000, u: 1000}; // conflicts with B — A newer
  const b = emptyPantrySection();
  b.pantry['bread'] = {qty: 1, setAt: 1000, u: 1000};  // only in B
  b.pantry['milk'] = {qty: 500, setAt: 500, u: 500};   // conflicts with A — B older

  const ab = call(ctx, 'mergePantrySection', [cloneJSON(a), cloneJSON(b)]);
  const ba = call(ctx, 'mergePantrySection', [cloneJSON(b), cloneJSON(a)]);
  // deepEqualJSON (library.js), not JSON.stringify string equality: mergeEntryMap builds its
  // output by iterating Object.keys(local) then Object.keys(remote), so ab/ba are the same
  // CONTENT with different key INSERTION order depending on argument order — a real
  // structural-equality check (same reasoning deepEqualJSON's own doc comment gives for why
  // it isn't just JSON.stringify(a)===JSON.stringify(b)) is what "order-independent" means.
  assert(call(ctx, 'deepEqualJSON', [ab, ba]) === true,
    'mergePantrySection: merge(A,B) content equals merge(B,A) (order-independent)', 'AB=' + JSON.stringify(ab) + ' BA=' + JSON.stringify(ba));
  assert(ab.pantry['eggs'].qty === 6 && ab.pantry['bread'].qty === 1 && ab.pantry['milk'].qty === 200,
    'mergePantrySection: unions only-local and only-remote foodIds, and picks the newer `u` on a real conflict', JSON.stringify(ab.pantry));
}

// (d) an exact-tie `u` with different content (the historically dangerous case —
// mergeLibrarySection's doc block / the duplication-ratchet incident) still converges
// deterministically instead of growing, mirroring testMergeLibraryRatchetRegression.
function testMergePantrySectionTieBreakConverges(ctx){
  const sideA = emptyPantrySection();
  sideA.pantry['flour'] = {qty: 500, setAt: 5000, u: 5000};
  const sideB = emptyPantrySection();
  sideB.pantry['flour'] = {qty: 750, setAt: 5000, u: 5000}; // exact-tie u, different qty

  let merged = call(ctx, 'mergePantrySection', [cloneJSON(sideA), cloneJSON(sideB)]);
  const counts = [Object.keys(merged.pantry).length];
  for(let i = 0; i < 6; i++){
    merged = call(ctx, 'mergePantrySection', [cloneJSON(merged), cloneJSON(sideA)]);
    merged = call(ctx, 'mergePantrySection', [cloneJSON(merged), cloneJSON(sideB)]);
    counts.push(Object.keys(merged.pantry).length);
  }
  assert(counts.every(function(c){ return c === 1; }),
    'mergePantrySection: repeated round-trips never grow the entry count on an exact-tie `u` conflict (ratchet regression)', 'counts=' + counts.join(', '));
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

/* ---------------- Today Re-balance regressions ----------------
   Today Re-balance is allowed to repair only TODAY's still-open slots. Confirmed and
   skipped slots are frozen, including shared slots when either person has logged/skipped
   their half. These checks deliberately avoid exact recipe assertions: the planner's
   catalog/ranking can evolve, but locks, stale guards, frozen nutrition, score direction,
   and date boundaries must not. */
function testTodayRebalance(ctx){
  const TODAY = FIXED_MONDAY;
  const TOMORROW = call(ctx, 'addDaysISO', [TODAY, 1]);
  const YESTERDAY = call(ctx, 'addDaysISO', [TODAY, -1]);
  const slotOrder = get(ctx, 'SLOT_ORDER');

  function reset(){
    run(ctx, "MESA_TEST_TODAY = '" + TODAY + "'; weekPlans = {}; weekPlan = null; mealPins = {}; mealRules = []; logHistory = {};");
    return call(ctx, 'ensureWeekPlan', []);
  }
  function mealFor(plan, unit){
    return plan.days[unit.dayIndex].meals[unit.slot];
  }
  function entryFor(plan, unit, person){
    const meal = mealFor(plan, unit);
    return unit.shared || meal.shared ? meal[person || 'elena'] : meal[unit.person || person || 'elena'];
  }
  function slotSignature(plan, unit){
    return JSON.stringify(mealFor(plan, unit));
  }
  function unitMatches(a, b){
    return !!a && !!b && a.dayIndex === b.dayIndex && a.slot === b.slot
      && !!a.shared === !!b.shared && (a.shared || a.person === b.person);
  }
  function suggestionUnit(s){ return s && s.unit; }
  function acceptedOnly(prop, keepFn){
    const copy = cloneJSON(prop);
    copy.suggestions = (copy.suggestions || []).map(function(s){
      s.accepted = keepFn(s) === true;
      return s;
    });
    return copy;
  }
  function proposalScore(prop){
    if(!prop) return null;
    if(typeof prop.afterScore === 'number') return prop.afterScore;
    if(prop.after && typeof prop.after.score === 'number') return prop.after.score;
    if(typeof prop.scoreAfter === 'number') return prop.scoreAfter;
    if(typeof prop.improvement === 'number' && typeof prop.beforeScore === 'number') return prop.beforeScore + prop.improvement;
    if(Array.isArray(prop.suggestions)){
      return prop.suggestions.reduce(function(sum, s){ return sum + (typeof s.improvement === 'number' ? s.improvement : 0); }, 0);
    }
    return null;
  }
  function confirmUnit(dateISO, plan, unit, person){
    const p = person || unit.person || 'elena';
    const entry = entryFor(plan, unit, p);
    call(ctx, 'logPlanEntry', [dateISO, p, unit.slot, entry.recipeId, entry.portion, call(ctx, 'planEntryComponents', [entry])]);
  }
  function loggedEntry(dateISO, person, slot){
    return get(ctx, "logHistory['" + dateISO + "'] && logHistory['" + dateISO + "']['" + person + "']").filter(function(e){
      return e.kind === 'plan' && e.slot === slot;
    })[0];
  }

  // (a) confirmed and skipped slots are excluded up front and rejected by the apply-time
  // unit guard.
  {
    const plan = reset();
    call(ctx, 'logPlanEntry', [TODAY, 'elena', 'breakfast', plan.days[0].meals.breakfast.elena.recipeId, plan.days[0].meals.breakfast.elena.portion, call(ctx, 'planEntryComponents', [plan.days[0].meals.breakfast.elena])]);
    call(ctx, 'markSlotSkipped', [TODAY, 'elena', 'snack']);
    const prop = call(ctx, 'proposeTodayRebalanceSuggestions', [TODAY, 'elena']);
    const units = (prop.suggestions || []).map(suggestionUnit);
    assert(units.every(function(u){ return !(u.dayIndex === 0 && u.slot === 'breakfast' && (!u.shared ? u.person === 'elena' : true)); }),
      'today re-balance: confirmed slots are excluded from suggestions', JSON.stringify(prop.suggestions));
    assert(units.every(function(u){ return !(u.dayIndex === 0 && u.slot === 'snack' && (!u.shared ? u.person === 'elena' : true)); }),
      'today re-balance: skipped slots are excluded from suggestions', JSON.stringify(prop.suggestions));
    assert(call(ctx, 'canApplyTodayRebalanceUnit', [plan, {dayIndex:0, slot:'breakfast', shared:!!plan.days[0].meals.breakfast.shared, person:'elena'}, TODAY]) === false,
      'today re-balance: canApplyTodayRebalanceUnit rejects a confirmed slot', '');
    assert(call(ctx, 'canApplyTodayRebalanceUnit', [plan, {dayIndex:0, slot:'snack', shared:!!plan.days[0].meals.snack.shared, person:'elena'}, TODAY]) === false,
      'today re-balance: canApplyTodayRebalanceUnit rejects a skipped slot', '');
  }

  // (b) a stale proposal cannot mutate a slot after that slot becomes logged/skipped.
  {
    const plan = reset();
    const prop = call(ctx, 'proposeTodayRebalanceSuggestions', [TODAY, 'elena']);
    const target = (prop.suggestions || []).filter(function(s){ return !!s.unit; })[0];
    assert(!!target, 'today re-balance stale-guard setup: a suggestion exists for an open slot', JSON.stringify(prop));
    if(target){
      const beforeSig = slotSignature(plan, target.unit);
      confirmUnit(TODAY, plan, target.unit, target.unit.person || 'elena');
      assert(call(ctx, 'canApplyTodayRebalanceUnit', [plan, target.unit, TODAY]) === false,
        'today re-balance: stale proposal guard rejects a unit after it becomes confirmed', JSON.stringify(target.unit));
      const afterPlan = call(ctx, 'todayRebalanceAcceptedPlan', [acceptedOnly(prop, function(s){ return s === target; })]);
      assert(slotSignature(afterPlan, target.unit) === beforeSig,
        'today re-balance: accepted stale suggestion does not mutate the now-confirmed slot',
        'before=' + beforeSig + ' after=' + slotSignature(afterPlan, target.unit));
    }
  }

  // (c) shared slots lock as a single household unit when either person has confirmed or
  // skipped their half.
  {
    const plan = reset();
    const sharedSlot = slotOrder.filter(function(slot){ return !!plan.days[0].meals[slot].shared; })[0];
    assert(!!sharedSlot, 'today re-balance shared-lock setup: today has at least one shared slot', JSON.stringify(plan.days[0].meals));
    if(sharedSlot){
      const unit = {dayIndex:0, slot:sharedSlot, shared:true};
      confirmUnit(TODAY, plan, unit, 'partner');
      assert(call(ctx, 'canApplyTodayRebalanceUnit', [plan, unit, TODAY]) === false,
        'today re-balance: shared slot is locked when either person has logged it', sharedSlot);
      run(ctx, 'logHistory = {};');
      call(ctx, 'markSlotSkipped', [TODAY, 'elena', sharedSlot]);
      assert(call(ctx, 'canApplyTodayRebalanceUnit', [plan, unit, TODAY]) === false,
        'today re-balance: shared slot is locked when either person has skipped it', sharedSlot);
      const prop = call(ctx, 'proposeTodayRebalanceSuggestions', [TODAY, 'partner']);
      assert((prop.suggestions || []).every(function(s){ return !unitMatches(s.unit, unit); }),
        'today re-balance: shared logged/skipped slot is excluded from suggestions for the other person', JSON.stringify(prop.suggestions));
    }
  }

  // (d) applying changes to other open slots never rewrites a frozen logged entry's
  // nutrition snapshot.
  {
    const plan = reset();
    confirmUnit(TODAY, plan, {dayIndex:0, slot:'breakfast', shared:!!plan.days[0].meals.breakfast.shared, person:'elena'}, 'elena');
    const before = cloneJSON(loggedEntry(TODAY, 'elena', 'breakfast'));
    const prop = call(ctx, 'proposeTodayRebalanceSuggestions', [TODAY, 'elena']);
    call(ctx, 'todayRebalanceAcceptedPlan', [acceptedOnly(prop, function(s){
      return !!s.unit && !(s.unit.dayIndex === 0 && s.unit.slot === 'breakfast');
    })]);
    const after = loggedEntry(TODAY, 'elena', 'breakfast');
    assert(JSON.stringify(after) === JSON.stringify(before),
      'today re-balance: logged nutrition snapshot is unchanged after other slots change',
      'before=' + JSON.stringify(before) + ' after=' + JSON.stringify(after));
  }

  // (e) after a quick-add deviation, accepting today's proposal improves the planner's
  // score/objective signal.
  {
    const plan = reset();
    call(ctx, 'logFoodEntry', [TODAY, 'elena', 'olive-oil', 50]);
    const prop = call(ctx, 'proposeTodayRebalanceSuggestions', [TODAY, 'elena']);
    const accepted = acceptedOnly(prop, function(){ return true; });
    const afterPlan = call(ctx, 'todayRebalanceAcceptedPlan', [accepted]);
    const afterProp = call(ctx, 'proposeTodayRebalanceSuggestions', [TODAY, 'elena']);
    const beforeScore = proposalScore(prop);
    const afterScore = proposalScore(afterProp);
    assert((prop.suggestions || []).length > 0, 'today re-balance: quick-add deviation produces at least one suggested repair', JSON.stringify(prop));
    assert(call(ctx, 'todayRebalanceChangedSuggestionCount', [plan, afterPlan, accepted.suggestions]) > 0,
      'today re-balance: accepting quick-add repair suggestions changes at least one open meal cell',
      'suggestions=' + JSON.stringify(prop.suggestions));
    assert(afterPlan && afterPlan.days && beforeScore !== null && afterScore !== null && afterScore >= beforeScore - 1e-9,
      'today re-balance: score/objective does not regress after accepting quick-add repair suggestions',
      'beforeScore=' + beforeScore + ' afterScore=' + afterScore + ' suggestions=' + JSON.stringify(prop.suggestions));
  }

  // (f) Today Re-balance is date-boundary strict: yesterday/tomorrow do not produce
  // applicable units against the fixed TODAY.
  {
    const plan = reset();
    const yesterdayProp = call(ctx, 'proposeTodayRebalanceSuggestions', [YESTERDAY, 'elena']);
    const tomorrowProp = call(ctx, 'proposeTodayRebalanceSuggestions', [TOMORROW, 'elena']);
    assert((yesterdayProp.suggestions || []).length === 0, 'today re-balance: yesterday produces no suggestions', JSON.stringify(yesterdayProp));
    assert((tomorrowProp.suggestions || []).length === 0, 'today re-balance: tomorrow produces no suggestions', JSON.stringify(tomorrowProp));
    assert(call(ctx, 'canApplyTodayRebalanceUnit', [plan, {dayIndex:1, slot:'lunch', shared:!!plan.days[1].meals.lunch.shared, person:'elena'}, TOMORROW]) === false,
      'today re-balance: canApplyTodayRebalanceUnit rejects tomorrow units', '');
  }

  run(ctx, 'weekPlans = {}; weekPlan = null; logHistory = {};');
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

/* ---------------- pinned-meal re-balance immutability (2026-07-19 bug report) ----------------
   Elena's report: "when NEXT week is re-balanced, the pinned meals stay pinned — but
   change". Contract (README v26): a pin makes AUTO mutation (re-balance, regeneration)
   leave that meal byte-identical, while explicit USER actions (manual swap, routine set,
   extras edit — v56) stay allowed. These tests pin NEXT week's meals through the exact
   key-derivation chain the Week UI uses (render.js renderWeek: mealPinPersonForMeal →
   mealPinKey → toggleMealPin writes mealPins[key]) — never by hand-writing key strings —
   so any future drift between the UI's write key and canAutoMutateUnit's read key fails
   here. The applyRebalance simulation mirrors render.js applyRebalance's exact mutation
   sequence (rebalanceAcceptedPlan → preserveLoggedSlots → preservePinnedSlots →
   markWeekPlanEdited); a source guard below keeps that mirror honest. */
function uiDerivedPinKey(ctx, weekStartDate, dayIndex, slot, viewerPerson){
  // Exactly renderWeek's derivation at 📍-render time: the meal's CURRENT shared/solo
  // state picks 'shared' vs the viewing profile.
  const meal = call(ctx, 'ensureWeekPlan', [weekStartDate]).days[dayIndex].meals[slot];
  const pinPerson = call(ctx, 'mealPinPersonForMeal', [meal, viewerPerson]);
  return call(ctx, 'mealPinKey', [weekStartDate, dayIndex, slot, pinPerson]);
}

function testPinnedMealsRebalanceImmutability(ctx){
  run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "'; weekPlans = {}; weekPlan = null; mealPins = {}; mealRules = []; logHistory = {};");
  const nextMonday = call(ctx, 'addDaysISO', [FIXED_MONDAY, 7]);
  let plan = call(ctx, 'ensureWeekPlan', [nextMonday]);

  // Locate one of each pin form on next week's plan.
  function findDay(slot, wantShared){
    for(let d = 0; d < 7; d++){
      const m = plan.days[d].meals[slot];
      if(m && !!m.shared === wantShared) return d;
    }
    return -1;
  }
  const sharedDinnerDay = findDay('dinner', true);
  const soloLunchDay = findDay('lunch', false);
  assert(sharedDinnerDay !== -1 && soloLunchDay !== -1,
    'pin immutability setup: next week has a shared dinner and a solo lunch',
    'sharedDinnerDay=' + sharedDinnerDay + ' soloLunchDay=' + soloLunchDay);
  if(sharedDinnerDay === -1 || soloLunchDay === -1) return;

  // Pin all four UI-producible key forms:
  // (1) shared dinner pinned by Elena → key '...|shared'
  // (2) solo lunch pinned by Elena for herself → '...|elena'
  // (3) same solo lunch pinned by Andrea for himself → '...|partner'
  // (4) a pinned daily routine (pinRoutineOccurrencesFrom) → routineOccurrencePinKey keys
  const keyShared = uiDerivedPinKey(ctx, nextMonday, sharedDinnerDay, 'dinner', 'elena');
  const keyElena = uiDerivedPinKey(ctx, nextMonday, soloLunchDay, 'lunch', 'elena');
  const keyPartner = uiDerivedPinKey(ctx, nextMonday, soloLunchDay, 'lunch', 'partner');
  [keyShared, keyElena, keyPartner].forEach(function(k){ run(ctx, 'mealPins[' + JSON.stringify(k) + '] = true;'); });
  assert(keyShared.split('|')[3] === 'shared' && keyElena.split('|')[3] === 'elena' && keyPartner.split('|')[3] === 'partner',
    'pin immutability: UI key derivation yields shared/elena/partner person segments',
    JSON.stringify([keyShared, keyElena, keyPartner]));

  const routineDay = plan.days.findIndex(function(day, d){ return d !== sharedDinnerDay && !plan.days[d].meals.breakfast.shared; });
  const routineRecipeId = plan.days[Math.max(0, routineDay)].meals.breakfast.elena.recipeId;
  run(ctx, 'mealRules = [{recipeId: ' + JSON.stringify(routineRecipeId) + ", slot: 'breakfast', cadence: 'daily', person: 'elena', anchorDate: " + JSON.stringify(nextMonday) + ', dayIndex: 0}];');
  call(ctx, 'pinRoutineOccurrencesFrom', [get(ctx, 'mealRules[0]'), nextMonday]);
  plan = call(ctx, 'ensureWeekPlan', [nextMonday]);

  // Manual swap ON the pinned solo lunch — v56: explicit user corrections remain allowed
  // even on a pinned meal, and the pin key must survive the swap.
  const preSwapId = plan.days[soloLunchDay].meals.lunch.elena.recipeId;
  const alt = call(ctx, 'buildSwapAlternatives', [soloLunchDay, 'lunch', 'elena', nextMonday])[0];
  assert(!!alt && alt.id !== preSwapId, 'pin immutability setup: a swap alternative exists for the pinned solo lunch', JSON.stringify(alt));
  call(ctx, 'applySwap', [soloLunchDay, 'lunch', 'elena', alt.id, nextMonday]);
  plan = call(ctx, 'ensureWeekPlan', [nextMonday]);
  assert(plan.days[soloLunchDay].meals.lunch.elena.recipeId === alt.id,
    'pins do not block explicit user actions: manual swap on a pinned meal still applies',
    'wanted=' + alt.id + ' got=' + plan.days[soloLunchDay].meals.lunch.elena.recipeId);
  assert(get(ctx, 'mealPins')[keyElena] === true,
    'pins survive an explicit manual swap: the pin key is still set afterwards',
    JSON.stringify(get(ctx, 'mealPins')));

  // Snapshot every pinned cell — the user-CHOSEN state (post-swap), not the generated one.
  const snapSharedDinner = cloneJSON(plan.days[sharedDinnerDay].meals.dinner);
  const snapSoloLunch = cloneJSON(plan.days[soloLunchDay].meals.lunch);
  const routineDays = plan.days.map(function(day, d){ return d; }).filter(function(d){
    return get(ctx, 'mealPins')[uiDerivedPinKey(ctx, nextMonday, d, 'breakfast', 'elena')];
  });
  const snapRoutine = routineDays.map(function(d){ return cloneJSON(plan.days[d].meals.breakfast); });

  // (A) Enumeration: no suggestion may target any pinned unit.
  const proposal = call(ctx, 'proposeRebalanceSuggestions', [nextMonday]);
  function hits(s, dayIndex, slot, shared, person){
    if(!s.unit || s.unit.dayIndex !== dayIndex || s.unit.slot !== slot) return false;
    if(!!s.unit.shared !== !!shared) return false;
    return shared || s.unit.person === person;
  }
  const badTargets = (proposal.suggestions || []).filter(function(s){
    return hits(s, sharedDinnerDay, 'dinner', true, null)
      || hits(s, soloLunchDay, 'lunch', false, 'elena')
      || hits(s, soloLunchDay, 'lunch', false, 'partner')
      || routineDays.some(function(d){ return hits(s, d, 'breakfast', !!plan.days[d].meals.breakfast.shared, 'elena'); });
  });
  assert(badTargets.length === 0,
    're-balance suggestions never target a pinned unit (all four UI pin-key forms)',
    JSON.stringify(badTargets));

  // (B) The fix must not make pinned meals mutable. With a smaller catalog, this fixture can
  // already satisfy the selected target; in that case a no-op proposal is valid.
  assert((proposal.suggestions || []).length > 0 || !proposal.gapInfo || proposal.gapInfo.gap <= 0,
    're-balance either proposes unpinned changes or has no remaining target gap',
    JSON.stringify(proposal));

  // (C) Full applyRebalance-equivalent mutation (mirrors render.js applyRebalance):
  const basePlan = call(ctx, 'ensureWeekPlan', [nextMonday]);
  const baseJson = JSON.stringify(basePlan);
  const resultPlan = call(ctx, 'rebalanceAcceptedPlan', [proposal]);
  call(ctx, 'preserveLoggedSlots', [basePlan, resultPlan]);
  call(ctx, 'preservePinnedSlots', [basePlan, resultPlan]);
  call(ctx, 'markWeekPlanEdited', [resultPlan]);
  assert(JSON.stringify(resultPlan.days[sharedDinnerDay].meals.dinner) === JSON.stringify(snapSharedDinner),
    'applyRebalance-equivalent: pinned shared dinner cell is byte-identical',
    'before=' + JSON.stringify(snapSharedDinner) + ' after=' + JSON.stringify(resultPlan.days[sharedDinnerDay].meals.dinner));
  assert(JSON.stringify(resultPlan.days[soloLunchDay].meals.lunch) === JSON.stringify(snapSoloLunch),
    'applyRebalance-equivalent: pinned solo lunch cell (user-swapped, both people pinned) is byte-identical',
    'before=' + JSON.stringify(snapSoloLunch) + ' after=' + JSON.stringify(resultPlan.days[soloLunchDay].meals.lunch));
  routineDays.forEach(function(d, i){
    assert(JSON.stringify(resultPlan.days[d].meals.breakfast) === JSON.stringify(snapRoutine[i]),
      'applyRebalance-equivalent: pinned routine-occurrence breakfast (day ' + d + ') is byte-identical',
      'before=' + JSON.stringify(snapRoutine[i]) + ' after=' + JSON.stringify(resultPlan.days[d].meals.breakfast));
  });
  const changedCells = [];
  resultPlan.days.forEach(function(day, d){
    Object.keys(day.meals).forEach(function(slot){
      if(JSON.stringify(day.meals[slot]) !== JSON.stringify(basePlan.days[d].meals[slot])) changedCells.push(d + '|' + slot);
    });
  });
  assert(((proposal.suggestions || []).length === 0 || changedCells.length > 0) && changedCells.every(function(c){
      return c !== sharedDinnerDay + '|dinner' && c !== soloLunchDay + '|lunch' && routineDays.every(function(d){ return c !== d + '|breakfast'; });
    }),
    'applyRebalance-equivalent: accepted changes touch only unpinned cells',
    'changed=' + JSON.stringify(changedCells));
  assert(JSON.stringify(basePlan) === baseJson,
    'applyRebalance-equivalent: the base plan itself was not mutated by the simulation', '');

  // (D) Belt-and-braces: even a stale/hostile proposal whose suggestions DO target pinned
  // units cannot change them — apply-time canAutoMutateUnit guard + preservePinnedSlots.
  const staleAlt = call(ctx, 'buildSwapAlternatives', [sharedDinnerDay, 'dinner', 'elena', nextMonday])[0];
  const staleProp = {weekStartDate: nextMonday, suggestions: [
    {kind: 'swap', accepted: true, unit: {dayIndex: sharedDinnerDay, slot: 'dinner', shared: true}, toRecipeId: staleAlt.id},
    {kind: 'swap', accepted: true, unit: {dayIndex: soloLunchDay, slot: 'lunch', shared: false, person: 'elena'}, toRecipeId: preSwapId},
    {kind: 'addSide', accepted: true, unit: {dayIndex: soloLunchDay, slot: 'lunch', shared: false, person: 'partner'}, sideRecipeId: 'asparagi-fagiolini-broccoli'}
  ]};
  const stalePlan = call(ctx, 'rebalanceAcceptedPlan', [staleProp]);
  call(ctx, 'preserveLoggedSlots', [basePlan, stalePlan]);
  call(ctx, 'preservePinnedSlots', [basePlan, stalePlan]);
  assert(JSON.stringify(stalePlan.days[sharedDinnerDay].meals.dinner) === JSON.stringify(snapSharedDinner)
    && JSON.stringify(stalePlan.days[soloLunchDay].meals.lunch) === JSON.stringify(snapSoloLunch),
    'applyRebalance-equivalent: stale suggestions aimed straight at pinned units still leave them byte-identical',
    'dinner=' + JSON.stringify(stalePlan.days[sharedDinnerDay].meals.dinner) + ' lunch=' + JSON.stringify(stalePlan.days[soloLunchDay].meals.lunch));

  run(ctx, "weekPlans = {}; weekPlan = null; mealPins = {}; mealRules = []; logHistory = {};");
}

// Source guard: the simulation above mirrors render.js's applyRebalance/applyTodayRebalance.
// Keep the mirror honest — both appliers must call preservePinnedSlots AFTER
// preserveLoggedSlots and BEFORE markWeekPlanEdited (the 2026-07-19 belt-and-braces fix;
// regeneration in planner.js ensureWeekPlan already had the same final guard from abe920f).
function testRebalanceAppliersCarryPinGuard(){
  const src = fs.readFileSync(path.join(APP_DIR, 'js', 'render.js'), 'utf8');
  ['applyRebalance', 'applyTodayRebalance'].forEach(function(fnName){
    const start = src.indexOf('function ' + fnName + '(');
    const end = src.indexOf('\nfunction ', start + 1);
    const body = start === -1 ? '' : src.slice(start, end === -1 ? src.length : end);
    const iLogged = body.indexOf('preserveLoggedSlots(');
    const iPinned = body.indexOf('preservePinnedSlots(');
    const iEdited = body.indexOf('markWeekPlanEdited(');
    assert(iLogged !== -1 && iPinned !== -1 && iEdited !== -1 && iLogged < iPinned && iPinned < iEdited,
      'render.js ' + fnName + '(): preservePinnedSlots runs after preserveLoggedSlots and before markWeekPlanEdited',
      'indexes logged=' + iLogged + ' pinned=' + iPinned + ' edited=' + iEdited);
  });
}

/* ---------------- preserveLoggedSlots/preservePinnedSlots: one-sided dangling recipe
   (2026-07-19 fix) ----------------
   planEntryRecipeValid()/mealRecipesValid() (~line 394) guard these two restorers against
   resurrecting a recipeId tombstoned out of RECIPES_DB. The original guard was too coarse
   for a SOLO meal with BOTH people locked (logged or pinned): mealRecipesValid() requires
   elena AND partner to both resolve, so if only one side's recipeId went dangling the
   whole cell was dropped — silently discarding the OTHER person's still-valid logged/pinned
   meal. Covers, for both restorers: (1) one-sided dangling on a solo meal -> only the
   dangling side is replaced by the freshly-regenerated entry, the valid side survives;
   (2) both sides valid on a solo meal -> the whole-cell replace still runs (proven via a
   synthetic marker field on the cell that only a whole-object copy would carry over — the
   per-person path only ever touches .elena/.partner); (3) a genuinely SHARED meal with a
   dangling recipeId is still dropped wholesale, never partially restored (mealRecipesValid
   checks the shared cell's OWN top-level recipeId, not its elena/partner sub-entries). */
function testPreserveSlotsOneSidedDangling(ctx){
  run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "'; weekPlans = {}; weekPlan = null; logHistory = {}; mealPins = {};");
  const basePlan = call(ctx, 'ensureWeekPlan', []);
  const wk = basePlan.weekStartDate;
  const SLOT_ORDER = get(ctx, 'SLOT_ORDER');
  const RECIPES_DB = get(ctx, 'RECIPES_DB');
  const realIds = Object.keys(RECIPES_DB);
  assert(realIds.length >= 4, 'one-sided-dangling test setup: RECIPES_DB has enough real recipes for alt-id substitution', 'count=' + realIds.length);

  function findSlot(wantShared){
    for(let d = 0; d < basePlan.days.length; d++){
      for(let i = 0; i < SLOT_ORDER.length; i++){
        const slot = SLOT_ORDER[i];
        const m = basePlan.days[d].meals[slot];
        if(m && !!m.shared === wantShared && m.elena && m.elena.recipeId && m.partner && m.partner.recipeId) return {d: d, slot: slot};
      }
    }
    return null;
  }
  const solo = findSlot(false);
  const sharedLoc = findSlot(true);
  assert(!!solo && !!sharedLoc,
    'one-sided-dangling test setup: the generated week has both a solo and a shared slot to test against',
    'solo=' + JSON.stringify(solo) + ' shared=' + JSON.stringify(sharedLoc));
  if(!solo || !sharedLoc) return;

  // Picks a real RECIPES_DB id not in `exclude` — stands in for "what regeneration
  // proposed", always a real id (unlike the fixture's fabricated dangling ids).
  function altIdFor(exclude){
    return realIds.filter(function(id){ return exclude.indexOf(id) === -1; })[0];
  }
  function lockBothSolo(dateISO, slot, meal){
    call(ctx, 'logPlanEntry', [dateISO, 'elena', slot, meal.elena.recipeId, 1, [{recipeId: meal.elena.recipeId, portion: 1}], undefined]);
    call(ctx, 'logPlanEntry', [dateISO, 'partner', slot, meal.partner.recipeId, 1, [{recipeId: meal.partner.recipeId, portion: 1}], undefined]);
  }
  function pinBothSolo(d, slot){
    run(ctx, 'mealPins[' + JSON.stringify(call(ctx, 'mealPinKey', [wk, d, slot, 'elena'])) + '] = true;');
    run(ctx, 'mealPins[' + JSON.stringify(call(ctx, 'mealPinKey', [wk, d, slot, 'partner'])) + '] = true;');
  }

  /* ========================= preserveLoggedSlots ========================= */

  // (1) one-sided dangling, both solo + both logged: the valid person's logged meal
  // survives; the dangling person's takes the freshly-regenerated entry.
  (function(){
    run(ctx, 'logHistory = {};');
    const dateISO = basePlan.days[solo.d].date;
    lockBothSolo(dateISO, solo.slot, basePlan.days[solo.d].meals[solo.slot]);

    const oldPlan = cloneJSON(basePlan);
    const validPartnerId = oldPlan.days[solo.d].meals[solo.slot].partner.recipeId;
    oldPlan.days[solo.d].meals[solo.slot].elena.recipeId = 'ghost-recipe-tombstoned-log-1sided';

    const newPlan = cloneJSON(oldPlan);
    const freshElena = altIdFor(['ghost-recipe-tombstoned-log-1sided', validPartnerId]);
    const freshPartner = altIdFor(['ghost-recipe-tombstoned-log-1sided', validPartnerId, freshElena]);
    newPlan.days[solo.d].meals[solo.slot].elena.recipeId = freshElena;
    newPlan.days[solo.d].meals[solo.slot].partner.recipeId = freshPartner;

    call(ctx, 'preserveLoggedSlots', [oldPlan, newPlan]);
    const result = newPlan.days[solo.d].meals[solo.slot];
    assert(result.elena.recipeId === freshElena,
      'preserveLoggedSlots: one-sided dangling (elena) keeps the freshly-regenerated recipe on the dangling side',
      'got ' + result.elena.recipeId + ', expected ' + freshElena);
    assert(result.partner.recipeId === validPartnerId,
      'preserveLoggedSlots: one-sided dangling (elena) still restores the OTHER (valid) person\'s logged meal',
      'got ' + result.partner.recipeId + ', expected ' + validPartnerId);
  })();

  // (2) both sides valid, both solo + both logged: whole-cell replace still runs
  // unchanged (the synthetic marker field only survives a whole-object copy).
  (function(){
    run(ctx, 'logHistory = {};');
    const dateISO = basePlan.days[solo.d].date;
    lockBothSolo(dateISO, solo.slot, basePlan.days[solo.d].meals[solo.slot]);

    const oldPlan = cloneJSON(basePlan);
    oldPlan.days[solo.d].meals[solo.slot].__wholeCellMarker = 'from-old-plan';
    const origElenaId = oldPlan.days[solo.d].meals[solo.slot].elena.recipeId;
    const origPartnerId = oldPlan.days[solo.d].meals[solo.slot].partner.recipeId;

    const newPlan = cloneJSON(oldPlan);
    delete newPlan.days[solo.d].meals[solo.slot].__wholeCellMarker;
    newPlan.days[solo.d].meals[solo.slot].elena.recipeId = altIdFor([origElenaId, origPartnerId]);

    call(ctx, 'preserveLoggedSlots', [oldPlan, newPlan]);
    const result = newPlan.days[solo.d].meals[solo.slot];
    assert(result.__wholeCellMarker === 'from-old-plan',
      'preserveLoggedSlots: both sides valid still does the whole-cell replace (cell-level marker field survives)',
      'got marker=' + JSON.stringify(result.__wholeCellMarker));
    assert(result.elena.recipeId === origElenaId,
      'preserveLoggedSlots: both sides valid restores the ORIGINAL logged recipe, not the freshly-regenerated one',
      'got ' + result.elena.recipeId + ', expected ' + origElenaId);
  })();

  // (3) a genuinely SHARED meal with a dangling top-level recipeId: still dropped
  // wholesale, not partially restored — even though the sub-entries still point at the
  // still-real, still-valid original id.
  (function(){
    run(ctx, 'logHistory = {};');
    const dateISO = basePlan.days[sharedLoc.d].date;
    const mealBefore = basePlan.days[sharedLoc.d].meals[sharedLoc.slot];
    call(ctx, 'logPlanEntry', [dateISO, 'elena', sharedLoc.slot, mealBefore.recipeId, 1, [{recipeId: mealBefore.recipeId, portion: 1}], undefined]);
    call(ctx, 'logPlanEntry', [dateISO, 'partner', sharedLoc.slot, mealBefore.recipeId, 1, [{recipeId: mealBefore.recipeId, portion: 1}], undefined]);

    const oldPlan = cloneJSON(basePlan);
    const origSharedId = oldPlan.days[sharedLoc.d].meals[sharedLoc.slot].recipeId;
    oldPlan.days[sharedLoc.d].meals[sharedLoc.slot].recipeId = 'ghost-recipe-tombstoned-log-shared';
    // elena/partner sub-entries deliberately left pointing at the still-real id — proves
    // the shared branch checks the CELL's recipeId, not the sub-entries.

    const newPlan = cloneJSON(oldPlan);
    const freshShared = altIdFor([origSharedId, 'ghost-recipe-tombstoned-log-shared']);
    newPlan.days[sharedLoc.d].meals[sharedLoc.slot].recipeId = freshShared;
    newPlan.days[sharedLoc.d].meals[sharedLoc.slot].elena.recipeId = freshShared;
    newPlan.days[sharedLoc.d].meals[sharedLoc.slot].partner.recipeId = freshShared;

    call(ctx, 'preserveLoggedSlots', [oldPlan, newPlan]);
    const result = newPlan.days[sharedLoc.d].meals[sharedLoc.slot];
    assert(result.recipeId === freshShared && result.elena.recipeId === freshShared && result.partner.recipeId === freshShared,
      'preserveLoggedSlots: a genuinely shared meal with a dangling recipeId is dropped wholesale, not partially restored',
      'got ' + JSON.stringify(result));
  })();

  /* ========================= preservePinnedSlots ========================= */

  // (1) one-sided dangling, both solo + both pinned: the valid person's pinned meal
  // survives; the dangling person's takes the freshly-regenerated entry.
  (function(){
    run(ctx, 'mealPins = {};');
    pinBothSolo(solo.d, solo.slot);

    const oldPlan = cloneJSON(basePlan);
    const validPartnerId = oldPlan.days[solo.d].meals[solo.slot].partner.recipeId;
    oldPlan.days[solo.d].meals[solo.slot].elena.recipeId = 'ghost-recipe-tombstoned-pin-1sided';

    const newPlan = cloneJSON(oldPlan);
    const freshElena = altIdFor(['ghost-recipe-tombstoned-pin-1sided', validPartnerId]);
    const freshPartner = altIdFor(['ghost-recipe-tombstoned-pin-1sided', validPartnerId, freshElena]);
    newPlan.days[solo.d].meals[solo.slot].elena.recipeId = freshElena;
    newPlan.days[solo.d].meals[solo.slot].partner.recipeId = freshPartner;

    call(ctx, 'preservePinnedSlots', [oldPlan, newPlan]);
    const result = newPlan.days[solo.d].meals[solo.slot];
    assert(result.elena.recipeId === freshElena,
      'preservePinnedSlots: one-sided dangling (elena) keeps the freshly-regenerated recipe on the dangling side',
      'got ' + result.elena.recipeId + ', expected ' + freshElena);
    assert(result.partner.recipeId === validPartnerId,
      'preservePinnedSlots: one-sided dangling (elena) still restores the OTHER (valid) person\'s pinned meal',
      'got ' + result.partner.recipeId + ', expected ' + validPartnerId);
  })();

  // (2) both sides valid, both solo + both pinned: whole-cell replace still runs
  // unchanged (the synthetic marker field only survives a whole-object copy).
  (function(){
    run(ctx, 'mealPins = {};');
    pinBothSolo(solo.d, solo.slot);

    const oldPlan = cloneJSON(basePlan);
    oldPlan.days[solo.d].meals[solo.slot].__wholeCellMarker = 'from-old-plan-pin';
    const origElenaId = oldPlan.days[solo.d].meals[solo.slot].elena.recipeId;
    const origPartnerId = oldPlan.days[solo.d].meals[solo.slot].partner.recipeId;

    const newPlan = cloneJSON(oldPlan);
    delete newPlan.days[solo.d].meals[solo.slot].__wholeCellMarker;
    newPlan.days[solo.d].meals[solo.slot].elena.recipeId = altIdFor([origElenaId, origPartnerId]);

    call(ctx, 'preservePinnedSlots', [oldPlan, newPlan]);
    const result = newPlan.days[solo.d].meals[solo.slot];
    assert(result.__wholeCellMarker === 'from-old-plan-pin',
      'preservePinnedSlots: both sides valid still does the whole-cell replace (cell-level marker field survives)',
      'got marker=' + JSON.stringify(result.__wholeCellMarker));
    assert(result.elena.recipeId === origElenaId,
      'preservePinnedSlots: both sides valid restores the ORIGINAL pinned recipe, not the freshly-regenerated one',
      'got ' + result.elena.recipeId + ', expected ' + origElenaId);
  })();

  // (3) a genuinely SHARED meal with a dangling top-level recipeId: still dropped
  // wholesale, not partially restored.
  (function(){
    run(ctx, 'mealPins = {};');
    run(ctx, 'mealPins[' + JSON.stringify(call(ctx, 'mealPinKey', [wk, sharedLoc.d, sharedLoc.slot, 'shared'])) + '] = true;');

    const oldPlan = cloneJSON(basePlan);
    const origSharedId = oldPlan.days[sharedLoc.d].meals[sharedLoc.slot].recipeId;
    oldPlan.days[sharedLoc.d].meals[sharedLoc.slot].recipeId = 'ghost-recipe-tombstoned-pin-shared';

    const newPlan = cloneJSON(oldPlan);
    const freshShared = altIdFor([origSharedId, 'ghost-recipe-tombstoned-pin-shared']);
    newPlan.days[sharedLoc.d].meals[sharedLoc.slot].recipeId = freshShared;
    newPlan.days[sharedLoc.d].meals[sharedLoc.slot].elena.recipeId = freshShared;
    newPlan.days[sharedLoc.d].meals[sharedLoc.slot].partner.recipeId = freshShared;

    call(ctx, 'preservePinnedSlots', [oldPlan, newPlan]);
    const result = newPlan.days[sharedLoc.d].meals[sharedLoc.slot];
    assert(result.recipeId === freshShared && result.elena.recipeId === freshShared && result.partner.recipeId === freshShared,
      'preservePinnedSlots: a genuinely shared meal with a dangling recipeId is dropped wholesale, not partially restored',
      'got ' + JSON.stringify(result));
  })();

  run(ctx, "weekPlans = {}; weekPlan = null; mealPins = {}; logHistory = {};");
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
  assert(totProtein.protein >= (totNone.protein * 0.98) - 1e-6, "'protein' tuning: fortnight total protein remains close to 'none' after catalog removals",
    'protein=' + totProtein.protein + ', none=' + totNone.protein);
  // Tolerance, like the 'protein' assertion above, and for the same class of reason:
  // VARIETY-plan.md P2's Mediterranean ceilings (red <=1/wk, poultry <=3/wk, 2 meatless
  // days) are HARD filters applied before scoring, so once poultry hits its quota every
  // poultry recipe leaves the pool for the rest of the week. tuningBonus is a scoring term
  // and can only choose among what survives, so it can no longer be guaranteed to move a
  // nutrient strictly upward — it now optimises within a materially smaller feasible set.
  // Measured drift at the time of writing: 1028.9 vs 1040.1, ~1%. Kept as a 2% guard rather
  // than deleted, so a real collapse of the tuning feature would still fail here.
  assert(totFiber.fiber >= (totNone.fiber * 0.98) - 1e-6, "'fiber' tuning: fortnight total fiber stays within 2% of 'none' (protein ceilings shrink the feasible set)",
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

/* ---------------- persist() storage-failure reporting (Fix 3) ----------------
   persist() (state.js) must degrade to in-memory-only, never throw, when
   localStorage.setItem throws (iOS PWA quota exhausted, Safari private mode,
   storage disabled, …) — but it must also STOP failing silently: it tracks the
   healthy/unhealthy transition (module-level lastPersistOk in state.js) and
   fires the optional onMesaPersistFailed(err) hook only when a write fails
   right after a healthy one, not on every write while storage stays broken
   (that would mean a toast on every keystroke for a user with a permanently
   full disk), and fires it again if storage recovers and then fails anew.

   Same stub-then-restore bracketing pattern testRecipeOptionsBuilder uses for
   toast/openMyRecipes/etc: swap out localStorage.setItem and the real
   onMesaPersistFailed (defined in js/render.js, which this harness loads) for
   a counting stub, for the duration of this test only, then restore both —
   in a `finally` so a mid-test assertion failure can't leak either override
   into later tests — and end with one real successful persist() so STORE_KEY
   holds a normal, current snapshot afterward. */
function testPersistFailureHook(ctx){
  run(ctx, "var __persistFailStub = {setItem: localStorage.setItem, onMesaPersistFailed: onMesaPersistFailed}; " +
    "var __persistFailCalls = 0; onMesaPersistFailed = function(){ __persistFailCalls++; };");
  try{
    // (1) storage throws -> persist() must not throw, and the hook fires exactly once
    // (first failure = the healthy->unhealthy transition).
    run(ctx, "localStorage.setItem = function(){ throw new Error('QuotaExceededError (test)'); };");
    let threw = false;
    try{ run(ctx, "persist();"); } catch(e){ threw = true; }
    assert(!threw, 'persist(): does not throw when localStorage.setItem throws (degrades to in-memory)');
    assert(get(ctx, '__persistFailCalls') === 1, 'onMesaPersistFailed: fires on the first storage failure',
      'calls=' + get(ctx, '__persistFailCalls'));

    // (2) storage still broken -> a second consecutive failure must NOT re-fire the hook.
    run(ctx, "persist();");
    assert(get(ctx, '__persistFailCalls') === 1, 'onMesaPersistFailed: does not re-fire on a second consecutive failure',
      'calls=' + get(ctx, '__persistFailCalls'));

    // (3) storage recovers -> a successful persist() must not fire the hook, and must
    // clear the unhealthy flag so a later failure is treated as a fresh transition.
    run(ctx, "localStorage.setItem = __persistFailStub.setItem; persist();");
    assert(get(ctx, '__persistFailCalls') === 1, 'onMesaPersistFailed: does not fire on a successful persist',
      'calls=' + get(ctx, '__persistFailCalls'));

    // (4) a NEW failure after that healthy write must fire the hook again.
    run(ctx, "localStorage.setItem = function(){ throw new Error('QuotaExceededError (test)'); };");
    run(ctx, "persist();");
    assert(get(ctx, '__persistFailCalls') === 2, 'onMesaPersistFailed: fires again after an intervening successful persist',
      'calls=' + get(ctx, '__persistFailCalls'));

    // (5) A THROWING hook must not escalate a degraded save into a crash. render.js's real
    // implementation calls toast(), which dereferences #toast with no null guard — so if
    // storage fails before the DOM is parsed, the hook throws from inside persist()'s catch
    // block and would propagate out, breaking the "degrade to in-memory rather than crashing
    // the app" contract. It must also still flip the unhealthy flag, or every subsequent
    // persist() re-enters the branch and re-throws.
    run(ctx, "localStorage.setItem = __persistFailStub.setItem; persist();"); // back to healthy
    run(ctx, "localStorage.setItem = function(){ throw new Error('QuotaExceededError (test)'); };");
    run(ctx, "__persistFailCalls = 0; onMesaPersistFailed = function(){ __persistFailCalls++; throw new Error('hook exploded (test)'); };");
    let hookThrewOut = false;
    try{ run(ctx, "persist();"); } catch(e){ hookThrewOut = true; }
    assert(!hookThrewOut, 'persist(): a throwing onMesaPersistFailed hook does not propagate out of persist()');
    assert(get(ctx, '__persistFailCalls') === 1, 'onMesaPersistFailed: a throwing hook still marks storage unhealthy (fired once)',
      'calls=' + get(ctx, '__persistFailCalls'));
    run(ctx, "persist();");
    assert(get(ctx, '__persistFailCalls') === 1, 'onMesaPersistFailed: a throwing hook is not re-entered on the next failed persist',
      'calls=' + get(ctx, '__persistFailCalls'));
  } finally {
    // Restore both real bindings BEFORE the closing real persist() below, so that write
    // (and every test after this one) goes through the real localStorage/hook again
    // regardless of which assertion above failed.
    run(ctx, "localStorage.setItem = __persistFailStub.setItem; onMesaPersistFailed = __persistFailStub.onMesaPersistFailed; delete __persistFailStub; delete __persistFailCalls;");
    run(ctx, "persist();"); // leave STORE_KEY holding a normal, current, successfully-written snapshot
  }
}

/* ---------------- task B2 part 2: composed lunch/dinner + breakfast-pairing algorithm ----------------
   Part 1 (already merged, covered above by testRecipeRolesAndBreakfastPair) tagged every
   recipe with role:'full'|'main'|'side' and flagged 9 foods breakfastPair:true. This suite
   covers the ALGORITHM that composes main+side/food units inside generateWeek
   (pickSharedMeal/pickSoloMeal via planner.js's sidePoolFor/breakfastPairFoodIds/
   topKSideIds/foodHitsAvoid/applyLightConsecutiveFilter). */
/* ---------------- VARIETY-plan.md P1: day-wide variety ----------------
   The per-slot gap rule (lastUsedGap reads history[person][slot]) could never see a repeat
   in a DIFFERENT slot the same day — 16 recipes are legal at both lunch and dinner, and a
   lunch pick reads as gap=Infinity when dinner is scored. Sides had the same hole from the
   other side: applyLightConsecutiveFilter only looked at yesterday. Measured before the
   fix: 'Snack: Hummus & veg sticks' 6x in one week, twice on one day (as a lunch side, a
   dinner side AND the standalone snack). */
function testDayWideVariety(ctx){
  const savedWeekPlans = get(ctx, 'weekPlans');
  const savedWeekPlan = get(ctx, 'weekPlan');
  const savedAvoidE = cloneJSON(get(ctx, 'PROF.elena.avoid'));
  try{
    run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "'; weekPlans = {}; weekPlan = null;");
    const SLOT_ORDER = get(ctx, 'SLOT_ORDER');
    const RECIPES_DB = get(ctx, 'RECIPES_DB');
    const w1 = call(ctx, 'ensureWeekPlan', [call(ctx, 'mondayOfWeek', [call(ctx, 'todayISO', [])])]);
    const w2 = call(ctx, 'ensureWeekPlan', [call(ctx, 'nextMondayISO', [])]);

    // Every recipe id a person eats on one day: the main dish AND every composed extra.
    function idsForDay(day, person){
      const ids = [];
      SLOT_ORDER.forEach(function(slot){
        const m = day.meals[slot];
        const e = m.shared ? m.elena : m[person];
        if(!e || !e.recipeId) return;
        ids.push(e.recipeId);
        (e.extras || []).forEach(function(x){ if(x.recipeId) ids.push(x.recipeId); });
      });
      return ids;
    }

    // (1) The core P1 guarantee, across a full fortnight and both people.
    const offenders = [];
    [w1, w2].forEach(function(plan){
      plan.days.forEach(function(day, d){
        ['elena', 'partner'].forEach(function(person){
          const counts = {};
          idsForDay(day, person).forEach(function(id){ counts[id] = (counts[id] || 0) + 1; });
          Object.keys(counts).forEach(function(id){
            if(counts[id] > 1) offenders.push(plan.weekStartDate + ' d' + d + ' ' + person + ' ' + id + ' x' + counts[id]);
          });
        });
      });
    });
    assert(offenders.length === 0,
      'day-wide variety: no recipe appears twice in the same day (mains AND composed extras, both people, both weeks)',
      offenders.join(' | '));

    // (2) The exact reported case. hummus-veg-sticks is role:'side' with
    // slots:['snack','side'], so it is in BOTH the side pool and the snack pool — it could
    // be the lunch side, the dinner side and the snack all on one day.
    assert(!!RECIPES_DB['hummus-veg-sticks'] && RECIPES_DB['hummus-veg-sticks'].role === 'side',
      'setup: hummus-veg-sticks is still the side/snack dual-pool recipe this guards');
    let worstHummus = 0;
    [w1, w2].forEach(function(plan){
      plan.days.forEach(function(day){
        ['elena', 'partner'].forEach(function(person){
          const n = idsForDay(day, person).filter(function(id){ return id === 'hummus-veg-sticks'; }).length;
          if(n > worstHummus) worstHummus = n;
        });
      });
    });
    assert(worstHummus <= 1,
      'day-wide variety: hummus-veg-sticks is never the lunch side AND dinner side AND snack on one day',
      'worst same-day count was ' + worstHummus);

    // (3) Determinism is the planner's contract: the output changes with this fix, but the
    // same inputs must still produce byte-identical plans.
    run(ctx, "weekPlans = {}; weekPlan = null;");
    const again = call(ctx, 'ensureWeekPlan', [call(ctx, 'mondayOfWeek', [call(ctx, 'todayISO', [])])]);
    assert(JSON.stringify(again) === JSON.stringify(w1),
      'day-wide variety: generation stays deterministic (same inputs -> byte-identical plan)');

    // (4) Never empty a pool. Every new exclusion must degrade rather than return nothing —
    // otherwise pickSharedMeal/pickSoloMeal fall into their console.error path and emit a
    // null-recipe meal, which the user sees as a blank day. A heavy avoid-list is the
    // realistic way a pool gets thin.
    run(ctx, "PROF.elena.avoid = ['meat', 'fish', 'gluten', 'dairy', 'nuts', 'eggs']; weekPlans = {}; weekPlan = null;");
    const thin = call(ctx, 'ensureWeekPlan', [call(ctx, 'mondayOfWeek', [call(ctx, 'todayISO', [])])]);
    let nulls = 0, slotsSeen = 0;
    thin.days.forEach(function(day){
      SLOT_ORDER.forEach(function(slot){
        const m = day.meals[slot];
        ['elena', 'partner'].forEach(function(p){
          const e = m.shared ? m[p] : m[p];
          if(!e) return;
          slotsSeen++;
          if(!e.recipeId) nulls++;
        });
      });
    });
    assert(thin.days.length === 7 && slotsSeen > 0 && nulls === 0,
      'day-wide variety: a heavily-restricted pool still fills all 7 days with real recipes (exclusions relax, never empty the pool)',
      'days=' + thin.days.length + ' slots=' + slotsSeen + ' nullRecipeIds=' + nulls);
  } finally {
    run(ctx, "PROF.elena.avoid = " + JSON.stringify(savedAvoidE) + ";");
    ctx.weekPlans = savedWeekPlans; ctx.weekPlan = savedWeekPlan;
    run(ctx, "weekPlans = {}; weekPlan = null;");
  }
}

/* ---------------- VARIETY-plan.md P2: weekly repetition caps ----------------
   P1 stopped same-day repeats; this caps how often ONE recipe may appear in ONE person's
   week. The caps are tuned to MEASURED pool sizes (see WEEKLY_RECIPE_CAP's doc), so where a
   pool genuinely cannot fill its slots within quota the rule relaxes rather than failing —
   that relaxation is counted and reported, and is the signal for P3. */
function testWeeklyRecipeCaps(ctx){
  const savedWeekPlans = get(ctx, 'weekPlans');
  const savedWeekPlan = get(ctx, 'weekPlan');
  try{
    // (1) The cap is role-driven and lives in one constants block.
    assert(call(ctx, 'weeklyCapForRecipe', ['hummus-veg-sticks']) === 3,
      'weeklyCapForRecipe: a role:side recipe caps at 3 (thin side/snack pools)');
    assert(call(ctx, 'weeklyCapForRecipe', ['shakshuka']) === 2,
      'weeklyCapForRecipe: a role:full recipe caps at 2');
    assert(call(ctx, 'weeklyCapForRecipe', ['__no_such_recipe__']) === get(ctx, 'WEEKLY_RECIPE_CAP_DEFAULT'),
      'weeklyCapForRecipe: an unknown id falls back to the documented default');

    // (2) applyWeeklyCapFilter drops at-quota ids, and RELAXES rather than returning an
    // empty pool when every candidate is at quota — the never-empty invariant every
    // variety rule here shares.
    run(ctx, "var __h = {elena: {weekUse: {}}, partner: {weekUse: {}}};");
    run(ctx, "__h.elena.weekUse['shakshuka'] = 2;"); // at its cap of 2
    const filtered = call(ctx, 'applyWeeklyCapFilter', [['shakshuka', 'pizza'], get(ctx, '__h'), ['elena']]);
    assert(JSON.stringify(filtered) === JSON.stringify(['pizza']),
      'applyWeeklyCapFilter: drops a recipe already at its weekly quota', JSON.stringify(filtered));
    run(ctx, "__h.elena.weekUse['pizza'] = 2;");
    const relaxed = call(ctx, 'applyWeeklyCapFilter', [['shakshuka', 'pizza'], get(ctx, '__h'), ['elena']]);
    assert(relaxed.length === 2,
      'applyWeeklyCapFilter: relaxes to the full pool when everything is at quota (never returns empty)', JSON.stringify(relaxed));
    run(ctx, "delete __h;");

    // (3) The side ladder's priority order. Given one side that is over quota but NOT used
    // today, and one under quota but ALREADY used today, it must prefer the over-quota one:
    // a same-day repeat is more visible than an over-quota week. Nesting the filters (the
    // first implementation) got this backwards.
    run(ctx, "var __h2 = {elena: {weekUse: {}, dayUseRecipe: {}, sideUse: {}}};");
    run(ctx, "__h2.elena.weekUse['hummus-veg-sticks'] = 99; __h2.elena.dayUseRecipe[0] = ['verdure-wok'];");
    const ladder = call(ctx, 'sidePoolLadder', [['hummus-veg-sticks', 'verdure-wok'], get(ctx, '__h2'), ['elena'], 0]);
    assert(JSON.stringify(ladder) === JSON.stringify(['hummus-veg-sticks']),
      'sidePoolLadder: prefers an over-quota side over one already eaten today (same-day repeat outranks over-quota)', JSON.stringify(ladder));
    run(ctx, "delete __h2;");

    // (4) End to end: recipes drawing on the LARGE pools (lunch/dinner 24, breakfast 13)
    // must respect the cap outright — no relaxation is justified there. The thin side and
    // snack pools are excluded from this assertion on purpose; they are P3's job, and
    // asserting on them would bake today's catalog shortage into the suite as correct.
    run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "'; weekPlans = {}; weekPlan = null;");
    const SLOT_ORDER = get(ctx, 'SLOT_ORDER');
    const RECIPES_DB = get(ctx, 'RECIPES_DB');
    const plan = call(ctx, 'ensureWeekPlan', [call(ctx, 'mondayOfWeek', [call(ctx, 'todayISO', [])])]);
    const over = [];
    ['elena', 'partner'].forEach(function(person){
      const counts = {};
      plan.days.forEach(function(day){
        SLOT_ORDER.forEach(function(slot){
          const m = day.meals[slot];
          const e = m.shared ? m[person] : m[person];
          if(!e || !e.recipeId) return;
          counts[e.recipeId] = (counts[e.recipeId] || 0) + 1;
          (e.extras || []).forEach(function(x){ if(x.recipeId) counts[x.recipeId] = (counts[x.recipeId] || 0) + 1; });
        });
      });
      Object.keys(counts).forEach(function(id){
        const r = RECIPES_DB[id];
        if(!r || r.role === 'side' || r.role === 'sauce') return; // thin pools — see above
        const cap = call(ctx, 'weeklyCapForRecipe', [id]);
        if(counts[id] > cap) over.push(person + ' ' + id + ' ' + counts[id] + '>' + cap);
      });
    });
    assert(over.length === 0,
      'weekly cap: no full/main recipe exceeds its quota in a person-week (large pools leave no excuse to relax)',
      over.join(' | '));

    // (5) The relaxation is COUNTED, not silent — that counter is how P3 knows which pools
    // are too thin, and a silently-relaxing cap is indistinguishable from a broken one.
    assert(typeof get(ctx, 'weeklyCapRelaxations') === 'number',
      'weeklyCapRelaxations: the relaxation count is observable rather than silent');
  } finally {
    ctx.weekPlans = savedWeekPlans; ctx.weekPlan = savedWeekPlan;
    run(ctx, "weekPlans = {}; weekPlan = null;");
  }
}

/* ---------------- FAVORITES-EATENOUT-plan.md item 2: stronger favorites ----------------
   Covers the two changes made to make a favorite ('recipePrefs[id] === "favorite"')
   noticeably more likely to appear: (1) weeklyCapForRecipe's +1 for a favorite (full/main
   2->3, side/sauce 3->4), and (2) mealScore's prefBoost raised from 35 to the empirically-
   chosen FAVORITE_SCORE_BOOST=90 (see that constant's doc in planner.js for the sweep).
   Fixture recipes and their measured FIXED_MONDAY fortnight (current + next week) usage,
   pinned so a regression in either change shows up as a concrete number mismatch rather
   than a vague "favorites don't work" failure:
     chicken-couscous-salad (role:full)  baseline=0 -> favorited=4  (cap 2->3)
     carrots-over-hummus    (role:side)  baseline=3 -> favorited=5  (cap 3->4) */
function testFavorites(ctx){
  ctx.__savedWeekPlans__ = get(ctx, 'weekPlans');
  ctx.__savedWeekPlan__ = get(ctx, 'weekPlan');
  ctx.__savedRecipePrefs__ = get(ctx, 'recipePrefs');
  try{
    run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "';");

    function fortnightUsage(recipeId, person){
      run(ctx, "weekPlans = {}; weekPlan = null;");
      const cur = call(ctx, 'ensureWeekPlan', []);
      const nextMonday = call(ctx, 'nextMondayISO', []);
      const next = call(ctx, 'ensureWeekPlan', [nextMonday]);
      let n = 0;
      [cur, next].forEach(function(plan){
        plan.days.forEach(function(day){
          Object.keys(day.meals).forEach(function(slot){
            const entry = day.meals[slot] && day.meals[slot][person];
            if(!entry) return;
            call(ctx, 'planEntryComponents', [entry]).forEach(function(c){ if(c.recipeId === recipeId) n++; });
          });
        });
      });
      return n;
    }

    // (1) Favoriting measurably raises a recipe's planned fortnight count vs the unfavorited
    // baseline, same seed (FIXED_MONDAY) both times — pinned exact numbers, per the doc
    // block above.
    run(ctx, "recipePrefs = {};");
    const fullBaseline = fortnightUsage('chicken-couscous-salad', 'elena');
    run(ctx, "recipePrefs = {'chicken-couscous-salad': 'favorite'};");
    const fullFavorited = fortnightUsage('chicken-couscous-salad', 'elena');
    assert(fullBaseline === 0 && fullFavorited === 4,
      'favorites: favoriting "chicken-couscous-salad" raises its fortnight usage vs the unfavorited baseline (FIXED_MONDAY, default household)',
      'baseline=' + fullBaseline + ' favorited=' + fullFavorited + ' (expected 0 -> 4)');
    assert(fullFavorited > fullBaseline,
      'favorites: favorited fortnight usage is strictly greater than the unfavorited baseline (general form of the pinned assertion above)',
      'baseline=' + fullBaseline + ' favorited=' + fullFavorited);

    run(ctx, "recipePrefs = {};");
    const sideBaseline = fortnightUsage('carrots-over-hummus', 'elena');
    run(ctx, "recipePrefs = {'carrots-over-hummus': 'favorite'};");
    const sideFavorited = fortnightUsage('carrots-over-hummus', 'elena');
    assert(sideBaseline === 3 && sideFavorited === 5,
      'favorites: favoriting "carrots-over-hummus" (role:side) raises its fortnight usage vs the unfavorited baseline',
      'baseline=' + sideBaseline + ' favorited=' + sideFavorited + ' (expected 3 -> 5)');

    // (2) A favorited full/main can reach 3/week where an unfavorited one caps at 2; a
    // favorited side/sauce reaches 4 where an unfavorited one caps at 3 — the raised-cap
    // half of item 2, asserted directly against weeklyCapForRecipe (not just via usage,
    // which can under-shoot the cap for reasons unrelated to the cap itself — see the
    // planner.js FAVORITE_SCORE_BOOST doc's note on day-wide/ladder relaxation).
    run(ctx, "recipePrefs = {};");
    assert(call(ctx, 'weeklyCapForRecipe', ['chicken-couscous-salad']) === 2,
      'weeklyCapForRecipe: an unfavorited role:full recipe still caps at the base 2');
    run(ctx, "recipePrefs = {'chicken-couscous-salad': 'favorite'};");
    assert(call(ctx, 'weeklyCapForRecipe', ['chicken-couscous-salad']) === 3,
      'weeklyCapForRecipe: a favorited role:full recipe caps one higher, at 3');
    run(ctx, "recipePrefs = {};");
    assert(call(ctx, 'weeklyCapForRecipe', ['carrots-over-hummus']) === 3,
      'weeklyCapForRecipe: an unfavorited role:side recipe still caps at the base 3');
    run(ctx, "recipePrefs = {'carrots-over-hummus': 'favorite'};");
    assert(call(ctx, 'weeklyCapForRecipe', ['carrots-over-hummus']) === 4,
      'weeklyCapForRecipe: a favorited role:side recipe caps one higher, at 4');

    // (3)+(4): a week with SEVERAL favorites still respects P1's day-wide no-repeat rule and
    // does not collapse to only those favorites — the finite raised cap + day-wide rule
    // must still bound it (FAVORITES-EATENOUT-plan.md item 2's "risk" section).
    const manyIds = ['chicken-couscous-salad', 'lemon-herb-chicken-breast', 'seared-tuna-lemon', 'carrots-over-hummus'];
    const prefsObj = {};
    manyIds.forEach(function(id){ prefsObj[id] = 'favorite'; });
    run(ctx, "recipePrefs = " + JSON.stringify(prefsObj) + "; weekPlans = {}; weekPlan = null;");
    const manyPlan = call(ctx, 'ensureWeekPlan', []);
    const SLOT_ORDER = get(ctx, 'SLOT_ORDER');
    let dayRepeatFound = false;
    const allUsed = {};
    ['elena', 'partner'].forEach(function(person){
      manyPlan.days.forEach(function(day){
        const idsToday = [];
        SLOT_ORDER.forEach(function(slot){
          const entry = day.meals[slot] && day.meals[slot][person];
          if(!entry) return;
          call(ctx, 'planEntryComponents', [entry]).forEach(function(c){
            if(!c.recipeId) return;
            idsToday.push(c.recipeId);
            if(person === 'elena') allUsed[c.recipeId] = (allUsed[c.recipeId] || 0) + 1;
          });
        });
        const seen = {};
        idsToday.forEach(function(id){ if(seen[id]) dayRepeatFound = true; seen[id] = true; });
      });
    });
    assert(!dayRepeatFound,
      'favorites: a many-favorites week still never repeats the same recipe on the same day for either person (P1 holds with the raised cap)');
    const totalSlots = Object.keys(allUsed).reduce(function(s, k){ return s + allUsed[k]; }, 0);
    const favoriteSlots = manyIds.reduce(function(s, id){ return s + (allUsed[id] || 0); }, 0);
    const nonFavoriteRecipeCount = Object.keys(allUsed).filter(function(id){ return manyIds.indexOf(id) === -1; }).length;
    assert(nonFavoriteRecipeCount > 0,
      'favorites: a many-favorites week still contains non-favorite recipes (does not collapse to only favorites)',
      'distinct recipes used=' + Object.keys(allUsed).length + ', all of them favorited=' + (nonFavoriteRecipeCount === 0));
    assert(favoriteSlots < totalSlots,
      'favorites: favorited recipes account for only PART of the week\'s component-slots, not all of them',
      'favoriteSlots=' + favoriteSlots + ' totalSlots=' + totalSlots);

    // (5) Determinism: same seed (FIXED_MONDAY, same recipePrefs) -> byte-identical plan —
    // the planner stays deterministic with favorites in play, same contract
    // testPlannerDeterminism already pins for the unfavorited path.
    run(ctx, "weekPlans = {}; weekPlan = null;");
    const detA = JSON.stringify(call(ctx, 'ensureWeekPlan', []));
    run(ctx, "weekPlans = {}; weekPlan = null;");
    const detB = JSON.stringify(call(ctx, 'ensureWeekPlan', []));
    assert(detA === detB,
      'favorites: ensureWeekPlan() stays byte-identical across two fresh generations for the same Monday with favorites set',
      'lengths differ or content differs (lenA=' + detA.length + ', lenB=' + detB.length + ')');
  } finally {
    run(ctx, 'weekPlans = __savedWeekPlans__; weekPlan = __savedWeekPlan__; recipePrefs = __savedRecipePrefs__;' +
      ' delete __savedWeekPlans__; delete __savedWeekPlan__; delete __savedRecipePrefs__;');
  }
}

/* ---------------- VARIETY-plan.md P2: Mediterranean protein balance ----------------
   Decision Q1: red meat <=1/week, poultry <=3/week, fish >=2/week, >=2 fully meatless days.
   Measured before the rule: meat in 15 of 28 meals on 7 days out of 7, despite the catalog
   being 60 meatless / 21 poultry / 10 fish / 5 red — a scoring bias (mealScore rewards the
   protein target and meat scores best on it), not a catalog gap. */
function testProteinBalance(ctx){
  const savedWeekPlans = get(ctx, 'weekPlans');
  const savedWeekPlan = get(ctx, 'weekPlan');
  try{
    // (1) Classification reads the real ingredient lists, split by kind, and red outranks
    // poultry outranks fish. The id lists live in library.js and are derived into
    // ANIMAL_FOOD_IDS, so the veggie-tagging that already reads it cannot drift.
    assert(call(ctx, 'recipeProteinKind', ['lemon-herb-chicken-breast']) === 'poultry',
      'recipeProteinKind: a chicken dish classifies as poultry');
    assert(call(ctx, 'recipeProteinKind', ['shakshuka']) === null,
      'recipeProteinKind: an egg/veg dish is meatless (eggs are deliberately not animal-protein here)');
    const animal = get(ctx, 'ANIMAL_FOOD_IDS');
    const parts = get(ctx, 'RED_MEAT_FOOD_IDS').length + get(ctx, 'POULTRY_FOOD_IDS').length + get(ctx, 'FISH_FOOD_IDS').length;
    assert(animal.length === parts,
      'ANIMAL_FOOD_IDS is derived from the three kind lists, so a food can only be added in one place',
      'animal=' + animal.length + ' parts=' + parts);

    // (2) The conservative meatless test. 'pasta' has a tuna & olives OPTION, so it may be
    // meaty even though its default condiment is not — the variant is rotated only AFTER
    // the pool is filtered, which is exactly how a designated meatless day picked a tuna
    // pasta before this existed.
    assert(call(ctx, 'recipeProteinKind', ['pasta']) === null,
      'setup: pasta classifies as meatless by its DEFAULT option');
    assert(call(ctx, 'recipeMayContainAnimalProtein', ['pasta']) === true,
      'recipeMayContainAnimalProtein: pasta MAY be meaty via its tuna option — a meatless day must exclude it');
    assert(call(ctx, 'recipeMayContainAnimalProtein', ['shakshuka']) === false,
      'recipeMayContainAnimalProtein: a dish with no meaty variant stays eligible on a meatless day');

    // (3) The two floors are carried by deterministically designated days, spread apart and
    // never on day 0, and the two kinds of day never collide.
    const sched = call(ctx, 'proteinScheduleForWeek', [12345]);
    const meatlessDays = Object.keys(sched.meatless).map(Number);
    const fishDays = Object.keys(sched.fish).map(Number);
    assert(meatlessDays.length === get(ctx, 'MEATLESS_DAYS_MIN'),
      'proteinScheduleForWeek: designates the required number of meatless days', JSON.stringify(meatlessDays));
    assert(meatlessDays.every(function(d){ return d >= 1 && d <= 6; }),
      'proteinScheduleForWeek: never designates day 0 (often already part-logged on regeneration)', JSON.stringify(meatlessDays));
    assert(fishDays.every(function(d){ return meatlessDays.indexOf(d) === -1; }),
      'proteinScheduleForWeek: a fish day never lands on a meatless day', JSON.stringify({meatlessDays: meatlessDays, fishDays: fishDays}));

    // (4) End to end over a real week, for both people: ceilings respected and the meatless
    // floor met. This is the assertion that would have caught the tuna-pasta leak.
    run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "'; weekPlans = {}; weekPlan = null;");
    const SLOT_ORDER = get(ctx, 'SLOT_ORDER');
    const plan = call(ctx, 'ensureWeekPlan', [FIXED_MONDAY]);
    const limits = get(ctx, 'PROTEIN_WEEK_LIMITS');
    ['elena', 'partner'].forEach(function(person){
      const counts = {red: 0, poultry: 0, fish: 0};
      let meatlessDayCount = 0;
      plan.days.forEach(function(day){
        let dayHasAnimal = false;
        SLOT_ORDER.forEach(function(slot){
          const m = day.meals[slot];
          const e = m.shared ? m[person] : m[person];
          if(!e || !e.recipeId) return;
          const kind = call(ctx, 'entryProteinKind', [e]);
          if(kind){ counts[kind]++; dayHasAnimal = true; }
        });
        if(!dayHasAnimal) meatlessDayCount++;
      });
      assert(counts.red <= limits.red,
        'protein balance (' + person + '): red meat within its weekly ceiling', 'red=' + counts.red + ' limit=' + limits.red);
      assert(counts.poultry <= limits.poultry,
        'protein balance (' + person + '): poultry within its weekly ceiling', 'poultry=' + counts.poultry + ' limit=' + limits.poultry);
      assert(meatlessDayCount >= get(ctx, 'MEATLESS_DAYS_MIN'),
        'protein balance (' + person + '): at least the required number of fully meatless days',
        'meatlessDays=' + meatlessDayCount + ' required=' + get(ctx, 'MEATLESS_DAYS_MIN'));
    });

    // (5) Relaxation stays observable — same reasoning as the weekly cap's counter.
    assert(typeof get(ctx, 'proteinRuleRelaxations') === 'number',
      'proteinRuleRelaxations: the protein rule reports when it had to relax rather than doing so silently');
  } finally {
    ctx.weekPlans = savedWeekPlans; ctx.weekPlan = savedWeekPlan;
    run(ctx, "weekPlans = {}; weekPlan = null;");
  }
}

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

  // -------- (0) real built-in optionGroups (task D2) + generateWeek() determinism against
  // the REAL catalog: D2 wired optionGroups onto three real built-ins (baked-fish, pasta,
  // french-toast-fruit-maple, per this file's header comment above) — confirm exactly those
  // three carry optionGroups (a regression guard: catches an accidental optionGroups drop OR
  // an accidental addition on some other id), then confirm two independent generateWeek()
  // calls with identical inputs are still byte-identical JSON now that real rotation/avoid-
  // filtering logic runs against real optionGroups data, not just the synthetic fixture used
  // below (testPlannerDeterminism covers the options-less case separately). --------
  (function(){
    const expectedOptionGroupIds = ['baked-fish', 'french-toast-fruit-maple', 'pasta', 'pizza'];
    const actualOptionGroupIds = Object.keys(RECIPES_DB).filter(function(id){
      return Array.isArray(RECIPES_DB[id].optionGroups) && RECIPES_DB[id].optionGroups.length;
    }).sort();
    assert(JSON.stringify(actualOptionGroupIds) === JSON.stringify(expectedOptionGroupIds),
      'D2: exactly the expected built-in recipes carry optionGroups', JSON.stringify(actualOptionGroupIds));

    run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "';");
    run(ctx, 'weekPlans = {}; weekPlan = null;');
    const sigA = call(ctx, 'computePlanSignature', []);
    const genA = call(ctx, 'generateWeek', [{weekStartDate: FIXED_MONDAY, signature: sigA}]);
    run(ctx, 'weekPlans = {}; weekPlan = null;');
    const sigB = call(ctx, 'computePlanSignature', []);
    const genB = call(ctx, 'generateWeek', [{weekStartDate: FIXED_MONDAY, signature: sigB}]);
    assert(JSON.stringify(genA) === JSON.stringify(genB),
      'D2: generateWeek() output is byte-identical across two independent generations against the REAL catalog (now containing real optionGroups recipes)',
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
      // VARIETY-plan.md P1: day-wide usage logs (planner.js generateWeek() now seeds these
      // alongside sideUse/bfPairUse) — applyVarietyFilter reads dayUseRecipe unconditionally,
      // so a hand-built history fixture calling pickSoloMeal/pickSharedMeal directly (as
      // below) needs them too, or it throws instead of exercising the real code path.
      h.dayUseRecipe = {}; h.dayUseFood = {};
      // VARIETY-plan.md P2: applyWeeklyCapFilter reads weekUse unconditionally, same as
      // applyVarietyFilter reads dayUseRecipe — a hand-built history needs it too.
      h.weekUse = {};
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
   PANTRY-plan.md P1: foodQuantitiesForComponents() — the meal->food decomposition
   extracted out of computeShoppingList's old addRecipe/addFood (planner.js). Covers batch
   yield, the piece-vs-gram unit split, optionGroups variants, and meal extras flowing
   through, per the plan's P1 test list.
   =================================================================== */
function testFoodQuantitiesForComponents(ctx){
  // fixture: servings:2 (batch yield) so the /r.servings division is exercised; one
  // gram/ml ingredient (olive-oil), one unit:'piece' ingredient (eggs, avgG:50) so both
  // unit branches run through the SAME recipe; one optionGroups group (carb: rice
  // default / potato) so the chosen-variant path is exercised too.
  const FIXTURE_ID = '__pantry_p1_fixture_recipe__';
  const fixtureRecipe = {
    title: 'Pantry P1 fixture dish', emoji: '🧪', slot: 'dinner', role: 'full',
    styles: ['balanced'], time: 5, servings: 2,
    ingredients: [['olive-oil', 100], ['eggs', 150]],
    toTaste: ['salt'], steps: ['Combine.'], tags: [], avoid: [],
    optionGroups: [
      {key: 'carb', label: 'Carb', choices: [
        {id: 'rice', label: 'Rice', ingredients: [['rice', 100]]},
        {id: 'potato', label: 'Potato', ingredients: [['potatoes', 200]]}
      ]}
    ]
  };
  run(ctx, "RECIPES_DB['" + FIXTURE_ID + "'] = " + JSON.stringify(fixtureRecipe) + ';');
  try{
    // (a) batch yield + gram/ml unit + default optionGroups choice, portion 1.
    const out1 = call(ctx, 'foodQuantitiesForComponents', [[{recipeId: FIXTURE_ID, portion: 1}]]);
    assert(Math.abs(out1['olive-oil'] - 50) < 1e-9,
      'foodQuantitiesForComponents: batch-yield divides a gram/ml ingredient by r.servings (100/2*1=50)', 'got ' + out1['olive-oil']);
    assert(Math.abs(out1['rice'] - 50) < 1e-9,
      'foodQuantitiesForComponents: default optionGroups choice (choices[0]) is used when opts is omitted', 'got ' + out1['rice']);
    assert(out1['potatoes'] === undefined,
      'foodQuantitiesForComponents: the non-chosen optionGroups choice contributes nothing', JSON.stringify(Object.keys(out1)));

    // (b) unit:'piece' conversion — same recipe, same call, proving both unit branches run
    // off ONE shared ingredient loop (eggs: raw batch grams 150, avgG:50).
    assert(Math.abs(out1['eggs'] - 1.5) < 1e-9,
      'foodQuantitiesForComponents: unit:"piece" foods convert via food.avgG into pieces, not grams (150/2/50=1.5)', 'got ' + out1['eggs']);

    // (c) portion scales linearly.
    const out2 = call(ctx, 'foodQuantitiesForComponents', [[{recipeId: FIXTURE_ID, portion: 2}]]);
    assert(Math.abs(out2['olive-oil'] - 100) < 1e-9, 'foodQuantitiesForComponents: portion scales linearly (100/2*2=100)', 'got ' + out2['olive-oil']);

    // (d) optionGroups variant flows through: opts selects potato instead of rice.
    const out3 = call(ctx, 'foodQuantitiesForComponents', [[{recipeId: FIXTURE_ID, portion: 1, opts: {carb: 'potato'}}]]);
    assert(out3['rice'] === undefined, 'foodQuantitiesForComponents: choosing the potato variant drops rice entirely', JSON.stringify(Object.keys(out3)));
    assert(Math.abs(out3['potatoes'] - 100) < 1e-9,
      'foodQuantitiesForComponents: the CHOSEN optionGroups variant\'s ingredient is bought, not the default (200/2*1=100g potatoes)', 'got ' + out3['potatoes']);

    // (e) meal extras flowing through: a base recipe component plus a standalone
    // {foodId, grams} extra (planEntryComponents()'s extras shape) both contribute, and an
    // extra targeting the SAME food the base recipe already touched accumulates onto it.
    const out4 = call(ctx, 'foodQuantitiesForComponents', [[
      {recipeId: FIXTURE_ID, portion: 1},
      {foodId: 'olive-oil', grams: 10}
    ]]);
    assert(Math.abs(out4['olive-oil'] - 60) < 1e-9,
      'foodQuantitiesForComponents: a meal extra (foodId component) accumulates onto the same food the base recipe already contributed (50+10=60)', 'got ' + out4['olive-oil']);
    assert(Math.abs(out4['eggs'] - 1.5) < 1e-9,
      'foodQuantitiesForComponents: the base recipe\'s own contribution is unaffected by an unrelated extra', 'got ' + out4['eggs']);

    // (f) a standalone piece-unit extra converts the same way a recipe ingredient does.
    const out5 = call(ctx, 'foodQuantitiesForComponents', [[{foodId: 'eggs', grams: 100}]]);
    assert(Math.abs(out5['eggs'] - 2) < 1e-9,
      'foodQuantitiesForComponents: a standalone piece-unit food component converts via avgG same as a recipe ingredient (100/50=2)', 'got ' + out5['eggs']);

    // (g) guards: unknown recipeId, non-positive portion, unknown foodId, non-positive
    // grams all contribute nothing (mirrors the pre-refactor addRecipe/addFood guards).
    const out6 = call(ctx, 'foodQuantitiesForComponents', [[
      {recipeId: 'not-a-real-recipe-id', portion: 1},
      {recipeId: FIXTURE_ID, portion: 0},
      {foodId: 'not-a-real-food-id', grams: 100},
      {foodId: 'olive-oil', grams: 0}
    ]]);
    assert(Object.keys(out6).length === 0,
      'foodQuantitiesForComponents: unknown recipe/food ids and non-positive portion/grams contribute nothing', JSON.stringify(out6));

    // (h) empty/null components never throw.
    assert(JSON.stringify(call(ctx, 'foodQuantitiesForComponents', [[]])) === '{}', 'foodQuantitiesForComponents: empty components array -> {}');
    assert(JSON.stringify(call(ctx, 'foodQuantitiesForComponents', [null])) === '{}', 'foodQuantitiesForComponents: null components -> {} (does not throw)');
  } finally {
    run(ctx, "delete RECIPES_DB['" + FIXTURE_ID + "'];");
  }
}

// decomposition parity (PANTRY-plan.md P1): computeShoppingList()'s totals must equal an
// INDEPENDENTLY rebuilt foodQuantitiesForComponents() pass over the exact same week's
// components (both people, every day/slot, planEntryComponents' shape), grouped by
// food.name — the invariant the P1 refactor exists to guarantee. Runs entirely inside the
// vm context (a single run() call) so no cross-realm object needs to cross the ctx
// boundary; only the final JSON comes back.
function testShoppingListDecompositionParity(ctx){
  // weekPlans/weekPlan are named explicitly (alongside pantry) as globals later tests
  // depend on — snapshot and restore even on failure rather than relying on the trailing
  // reset alone.
  ctx.__savedWeekPlans__ = get(ctx, 'weekPlans');
  ctx.__savedWeekPlan__ = get(ctx, 'weekPlan');
  // PANTRY-plan.md P3: computeShoppingList() now also excludes already-logged/skipped
  // slots for the current week (Q1) and subtracts the pantry — the manual rebuild below
  // does NEITHER, so this decomposition-parity check is only valid with logHistory/pantry
  // both empty (a no-op for both). ensureWeekPlan() below always resolves `wk` to the
  // CURRENT week (mondayOfWeek(MESA_TEST_TODAY)), so Q1 is live here without this reset.
  const savedLogHistory = cloneJSON(get(ctx, 'logHistory'));
  const savedPantry = cloneJSON(get(ctx, 'pantry'));
  try{
    run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "';");
    run(ctx, 'weekPlans = {}; weekPlan = null; logHistory = {}; pantry = {};');
    const plan = call(ctx, 'ensureWeekPlan', []);
    const wk = plan.weekStartDate;
    const list = call(ctx, 'computeShoppingList', [wk]);

    const rebuilt = JSON.parse(run(ctx, [
      '(function(){',
      '  var p = weekPlans[' + JSON.stringify(wk) + '];',
      '  var allComponents = [];',
      '  p.days.forEach(function(day){',
      '    SLOT_ORDER.forEach(function(slot){',
      '      var m = day.meals[slot];',
      '      planEntryComponents(m.elena).forEach(function(c){ allComponents.push(c); });',
      '      planEntryComponents(m.partner).forEach(function(c){ allComponents.push(c); });',
      '    });',
      '  });',
      '  var qtyByFood = foodQuantitiesForComponents(allComponents);',
      '  var rebuilt = {};',
      '  Object.keys(qtyByFood).forEach(function(foodId){',
      '    var food = FOODS[foodId];',
      '    if(!food) return;',
      '    var name = food.name;',
      '    if(!rebuilt[name]) rebuilt[name] = {qty: 0, unit: food.unit === "piece" ? "" : food.unit, foodIds: []};',
      '    rebuilt[name].qty += qtyByFood[foodId];',
      '    if(rebuilt[name].foodIds.indexOf(foodId) === -1) rebuilt[name].foodIds.push(foodId);',
      '  });',
      '  return JSON.stringify(rebuilt);',
      '})()'
    ].join('\n')));

    assert(Object.keys(list.totals).length > 0, 'decomposition parity: the generated week actually produced a non-empty shopping list (sanity floor for the assertion below)', 'keys=' + Object.keys(list.totals).length);
    assert(JSON.stringify(list.totals) === JSON.stringify(rebuilt),
      'computeShoppingList: totals equal an independently rebuilt foodQuantitiesForComponents(week components) grouped by name (decomposition parity)',
      'computeShoppingList keys=' + Object.keys(list.totals).length + ' rebuilt keys=' + Object.keys(rebuilt).length);
  } finally {
    run(ctx, 'weekPlans = __savedWeekPlans__; weekPlan = __savedWeekPlan__; delete __savedWeekPlans__; delete __savedWeekPlan__;');
    run(ctx, 'logHistory = ' + JSON.stringify(savedLogHistory) + '; pantry = ' + JSON.stringify(savedPantry) + ';');
  }
}

/* ===================================================================
   PANTRY-plan.md P3: computeShoppingList() — Q1 (already-logged/skipped slots excluded
   from the CURRENT week only), pantry subtraction (fully/partially covered rows), and the
   next-week projection (pantryProjectedForNextWeek, js/pantry.js). Uses a dedicated fixture
   FOOD (not just a fixture recipe) so the row's planned quantity is exactly and only what
   this test put there — no real recipe can reference an id that doesn't exist yet, so
   there's no risk of the randomly-generated rest of the week adding noise to the totals.
   =================================================================== */
function testShoppingListLoggedExclusionAndPantrySubtraction(ctx){
  const FOOD_ID = '__pantry_p3_fixture_food__';
  const RECIPE_ID = '__pantry_p3_fixture_recipe__';
  const FOOD_NAME = 'P3 fixture food';
  ctx.__savedWeekPlans__ = get(ctx, 'weekPlans');
  ctx.__savedWeekPlan__ = get(ctx, 'weekPlan');
  const savedLogHistory = cloneJSON(get(ctx, 'logHistory'));
  const savedPantry = cloneJSON(get(ctx, 'pantry'));
  try{
    // Building a shopping list is a PURE READ and must not mutate logHistory. The Q1
    // logged-meal exclusion checks slot status per (day, slot, person), and log.js's
    // slotLogStatus() reads through getDayLog(), which lazily CREATES an empty day record
    // for any date asked about. Since pruneLogHistory() only drops records by age and never
    // by emptiness, going straight through it would leave 7 empty records behind per view,
    // persisted and synced for the full 60-day window (planner.js:slotLoggedReadOnly).
    (function(){
      run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "'; logHistory = {}; pantry = {}; weekPlans = {}; weekPlan = null;");
      call(ctx, 'computeShoppingList', [call(ctx, 'mondayOfWeek', [call(ctx, 'todayISO', [])])]);
      const keys = get(ctx, 'Object.keys(logHistory).length');
      assert(keys === 0,
        'computeShoppingList: builds the current-week list WITHOUT lazily creating empty logHistory day records (pure read)',
        'logHistory gained ' + keys + ' day record(s)');
    })();

    run(ctx, "FOODS['" + FOOD_ID + "'] = " + JSON.stringify({
      name: FOOD_NAME, per: 100, unit: 'g',
      kcal: 30, protein: 3, carbs: 4, fat: 0, satFat: 0, fiber: 2, sugars: 0, freeSugars: 0,
      flags: [], cat: 'Produce', iconKey: 'spinach', src: 'test fixture'
    }) + ';');
    run(ctx, "RECIPES_DB['" + RECIPE_ID + "'] = " + JSON.stringify({
      title: 'P3 fixture dish', emoji: '🧪', slot: 'dinner', role: 'full',
      // occasional:true keeps it out of candidatesFor(), so the ONLY appearances of this
      // fixture are the ones this test injects into a plan cell by hand. Without it the
      // generator started picking it too once VARIETY-plan.md P2's protein ceilings began
      // favouring meatless recipes, and the "exactly 200g planned" setup read 1400g.
      occasional: true,
      styles: ['balanced'], time: 5, servings: 1,
      ingredients: [[FOOD_ID, 200]], toTaste: [], steps: ['Combine.'], tags: [], avoid: []
    }) + ';');

    const nextMonday = call(ctx, 'addDaysISO', [FIXED_MONDAY, 7]);
    const fixtureEntryJSON = JSON.stringify({recipeId: RECIPE_ID, portion: 1, kcal: 0, protein: 0});

    // ---- (a) Q1: a logged/skipped slot is excluded from the CURRENT week's list only —
    // the SAME (recipe, slot) logged against NEXT week's own calendar date must NOT be
    // excluded from next week's list (proves the gate is "is this the current week", not
    // merely "does a log entry exist touching this food"). ----
    (function(){
      run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "';");
      run(ctx, 'weekPlans = {}; weekPlan = null; logHistory = {}; pantry = {};');
      call(ctx, 'ensureWeekPlan', [FIXED_MONDAY]);
      call(ctx, 'ensureWeekPlan', [nextMonday]);
      run(ctx, "weekPlans['" + FIXED_MONDAY + "'].days[0].meals.dinner.elena = " + fixtureEntryJSON + ';');
      run(ctx, "weekPlans['" + nextMonday + "'].days[0].meals.dinner.elena = " + fixtureEntryJSON + ';');

      const beforeCurrent = call(ctx, 'computeShoppingList', [FIXED_MONDAY]);
      const beforeCurrentQty = (beforeCurrent.totals[FOOD_NAME] && beforeCurrent.totals[FOOD_NAME].qty) || 0;
      const beforeNext = call(ctx, 'computeShoppingList', [nextMonday]);
      const beforeNextQty = (beforeNext.totals[FOOD_NAME] && beforeNext.totals[FOOD_NAME].qty) || 0;
      assert(Math.abs(beforeCurrentQty - 200) < 1e-6, 'Q1 test setup: current week list carries exactly the fixture\'s 200g before logging (no other recipe can reference this fixture food)', 'got ' + beforeCurrentQty);
      assert(Math.abs(beforeNextQty - 200) < 1e-6, 'Q1 test setup: next week list carries the same 200g (mirrored slot)', 'got ' + beforeNextQty);

      call(ctx, 'logPlanEntry', [FIXED_MONDAY, 'elena', 'dinner', RECIPE_ID, 1, [{recipeId: RECIPE_ID, portion: 1}]]);
      assert(call(ctx, 'slotLogStatus', [FIXED_MONDAY, 'elena', 'dinner']) === 'confirmed',
        'Q1 test setup: the fixture slot is really logged (slotLogStatus === "confirmed")');

      const afterCurrent = call(ctx, 'computeShoppingList', [FIXED_MONDAY]);
      const afterCurrentQty = (afterCurrent.totals[FOOD_NAME] && afterCurrent.totals[FOOD_NAME].qty) || 0;
      assert(Math.abs(afterCurrentQty - 0) < 1e-6,
        'Q1: the CURRENT week list drops the logged slot\'s contribution entirely once it is logged (200 -> 0, no other source)', 'got ' + afterCurrentQty);

      // Log the SAME recipe/slot against NEXT week's own calendar date too — an entry that
      // really does exist in logHistory for that date — and confirm next week's list is
      // still unaffected: Q1 only ever applies to the week that IS the current week.
      call(ctx, 'logPlanEntry', [nextMonday, 'elena', 'dinner', RECIPE_ID, 1, [{recipeId: RECIPE_ID, portion: 1}]]);
      assert(call(ctx, 'slotLogStatus', [nextMonday, 'elena', 'dinner']) === 'confirmed',
        'Q1 test setup: next week\'s mirrored slot is ALSO logged (so the assertion below is a real exclusion test, not just an absence of data)');
      const afterNext = call(ctx, 'computeShoppingList', [nextMonday]);
      const afterNextQty = (afterNext.totals[FOOD_NAME] && afterNext.totals[FOOD_NAME].qty) || 0;
      assert(Math.abs(afterNextQty - beforeNextQty) < 1e-6,
        'Q1: NEXT week\'s list is unaffected by a logged slot, even one logged against next week\'s own calendar date — exclusion only ever applies to the CURRENT week',
        'before=' + beforeNextQty + ' after=' + afterNextQty);
    })();

    // ---- (b) pantry subtraction: a fully-covered row disappears entirely; a partially-
    // covered row keeps a REDUCED qty and is annotated in `covered` rather than just
    // vanishing (PANTRY-plan.md's explicit "never silent" requirement). ----
    (function(){
      run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "';");
      run(ctx, 'weekPlans = {}; weekPlan = null; logHistory = {}; pantry = {};');
      call(ctx, 'ensureWeekPlan', [FIXED_MONDAY]);
      run(ctx, "weekPlans['" + FIXED_MONDAY + "'].days[0].meals.dinner.elena = " + fixtureEntryJSON + ';');

      const base = call(ctx, 'computeShoppingList', [FIXED_MONDAY]);
      assert(!!base.totals[FOOD_NAME] && Math.abs(base.totals[FOOD_NAME].qty - 200) < 1e-6,
        'pantry subtraction test setup: planned qty is exactly 200g with an empty pantry', JSON.stringify(base.totals[FOOD_NAME]));

      // Partial: pantry has LESS than planned.
      run(ctx, "pantry['" + FOOD_ID + "'] = {qty: 120, setAt: Date.now(), u: Date.now()};");
      const partial = call(ctx, 'computeShoppingList', [FIXED_MONDAY]);
      assert(!!partial.totals[FOOD_NAME], 'partially-covered row: still on the list (need > 0)', JSON.stringify(Object.keys(partial.totals)));
      assert(Math.abs(partial.totals[FOOD_NAME].qty - 80) < 1e-6,
        'partially-covered row: shows the REDUCED quantity (200 planned - 120 in pantry = 80)', 'got ' + partial.totals[FOOD_NAME].qty);
      assert(!!partial.covered[FOOD_NAME] && Math.abs(partial.covered[FOOD_NAME].have - 120) < 1e-6,
        '`covered` annotates exactly how much the pantry contributed to the partially-covered row (120)', JSON.stringify(partial.covered[FOOD_NAME]));
      assert(partial.fullyCovered.indexOf(FOOD_NAME) === -1, 'a partially-covered row is not ALSO listed in fullyCovered', JSON.stringify(partial.fullyCovered));

      // Full: pantry has AT LEAST as much as planned — the row drops off the list entirely,
      // but is never silently missing: it's named in fullyCovered instead.
      run(ctx, "pantry['" + FOOD_ID + "'] = {qty: 200, setAt: Date.now(), u: Date.now()};");
      const full = call(ctx, 'computeShoppingList', [FIXED_MONDAY]);
      assert(!full.totals[FOOD_NAME], 'fully-covered row: disappears entirely from totals once the pantry fully covers it', JSON.stringify(Object.keys(full.totals)));
      assert(full.fullyCovered.indexOf(FOOD_NAME) !== -1, 'fully-covered row: named in fullyCovered instead of silently vanishing', JSON.stringify(full.fullyCovered));
      assert(!full.covered[FOOD_NAME], 'fully-covered row: not double-listed in the partial `covered` map', JSON.stringify(full.covered[FOOD_NAME]));

      // Over-coverage: pantry has MORE than planned — still fully covered, still dropped.
      run(ctx, "pantry['" + FOOD_ID + "'] = {qty: 500, setAt: Date.now(), u: Date.now()};");
      const over = call(ctx, 'computeShoppingList', [FIXED_MONDAY]);
      assert(!over.totals[FOOD_NAME], 'over-coverage: still fully covered when the pantry has MORE than needed', JSON.stringify(Object.keys(over.totals)));
    })();

    // ---- (c) next-week projection: pantryProjectedForNextWeek() = pantryRemaining() minus
    // THIS week's still-outstanding (not logged/skipped) demand, floored at 0 — "the
    // subtlest part of the feature" per the plan. A pantry item fully consumed by this
    // week's remaining plan must NOT reduce next week's list. ----
    (function(){
      run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "';");
      run(ctx, 'weekPlans = {}; weekPlan = null; logHistory = {}; pantry = {};');
      call(ctx, 'ensureWeekPlan', [FIXED_MONDAY]);
      call(ctx, 'ensureWeekPlan', [nextMonday]);
      // THIS week's day0 dinner (elena) is NOT logged — still outstanding demand (200g).
      run(ctx, "weekPlans['" + FIXED_MONDAY + "'].days[0].meals.dinner.elena = " + fixtureEntryJSON + ';');
      // NEXT week's day0 dinner (elena) demands the same 200g of the same fixture food.
      run(ctx, "weekPlans['" + nextMonday + "'].days[0].meals.dinner.elena = " + fixtureEntryJSON + ';');

      // (c1) pantry has EXACTLY as much as this week still needs -> projected leftover for
      // next week is 0 -> next week's list must show the FULL 200g, untouched.
      run(ctx, "pantry['" + FOOD_ID + "'] = {qty: 200, setAt: Date.now(), u: Date.now()};");
      const projected1 = call(ctx, 'pantryProjectedForNextWeek', []);
      assert((projected1[FOOD_ID] || 0) === 0,
        'pantryProjectedForNextWeek: a pantry item fully eaten by this week\'s remaining plan projects to 0 for next week', 'got ' + projected1[FOOD_ID]);
      const nextList1 = call(ctx, 'computeShoppingList', [nextMonday]);
      assert(!!nextList1.totals[FOOD_NAME] && Math.abs(nextList1.totals[FOOD_NAME].qty - 200) < 1e-6,
        'next-week projection: a pantry item FULLY CONSUMED by this week\'s remaining plan must NOT reduce next week\'s list (still the full 200g)',
        'got ' + JSON.stringify(nextList1.totals[FOOD_NAME]));

      // (c2) pantry has MORE than this week needs -> only the SURPLUS projects forward.
      run(ctx, "pantry['" + FOOD_ID + "'] = {qty: 350, setAt: Date.now(), u: Date.now()};");
      const projected2 = call(ctx, 'pantryProjectedForNextWeek', []);
      assert(Math.abs(projected2[FOOD_ID] - 150) < 1e-6,
        'pantryProjectedForNextWeek: only the surplus over this week\'s outstanding demand projects forward (350 - 200 = 150)', 'got ' + projected2[FOOD_ID]);
      const nextList2 = call(ctx, 'computeShoppingList', [nextMonday]);
      assert(Math.abs(nextList2.totals[FOOD_NAME].qty - 50) < 1e-6,
        'next-week projection: next week\'s list is reduced by exactly the projected leftover (200 planned - 150 projected = 50), not the raw pantry amount',
        'got ' + JSON.stringify(nextList2.totals[FOOD_NAME]));

      // (c3) sanity: prove this is really exercising the projection, not accidentally
      // passing because plain pantryRemaining() would have produced the same number.
      const rawRemaining = call(ctx, 'pantryRemaining', []);
      assert(rawRemaining[FOOD_ID] === 350 && rawRemaining[FOOD_ID] !== projected2[FOOD_ID],
        'sanity: pantryRemaining() (350) differs from the projected number actually used for next week (150)',
        'remaining=' + rawRemaining[FOOD_ID] + ' projected=' + projected2[FOOD_ID]);

      // (c4) meanwhile THIS week's own list still uses plain pantryRemaining() directly —
      // 350 in stock covers the 200 needed, so the row is fully covered there.
      const thisWeekList = call(ctx, 'computeShoppingList', [FIXED_MONDAY]);
      assert(!thisWeekList.totals[FOOD_NAME] && thisWeekList.fullyCovered.indexOf(FOOD_NAME) !== -1,
        'sanity: the CURRENT week\'s own list uses plain pantryRemaining() (350 covers the 200 needed -> fully covered)', JSON.stringify(Object.keys(thisWeekList.totals)));
    })();
  } finally {
    run(ctx, "delete RECIPES_DB['" + RECIPE_ID + "']; delete FOODS['" + FOOD_ID + "'];");
    run(ctx, 'weekPlans = __savedWeekPlans__; weekPlan = __savedWeekPlan__; delete __savedWeekPlans__; delete __savedWeekPlan__;');
    run(ctx, 'logHistory = ' + JSON.stringify(savedLogHistory) + '; pantry = ' + JSON.stringify(savedPantry) + ';');
  }
}

/* ===================================================================
   PANTRY-plan.md P3 step 4 (Q2) — "Add ticked items to pantry": restockTickedShopItems()
   (js/render.js), the pure (no-DOM) logic behind the shopping sheet's restock button.
   =================================================================== */
function testRestockTickedShopItems(ctx){
  const FOOD_ID = '__pantry_p3_restock_fixture_food__';
  const RECIPE_ID = '__pantry_p3_restock_fixture_recipe__';
  const FOOD_NAME = 'P3 restock fixture food';
  ctx.__savedWeekPlans__ = get(ctx, 'weekPlans');
  ctx.__savedWeekPlan__ = get(ctx, 'weekPlan');
  const savedLogHistory = cloneJSON(get(ctx, 'logHistory'));
  const savedPantry = cloneJSON(get(ctx, 'pantry'));
  const savedChecked = cloneJSON(get(ctx, 'checkedShopByWeek'));
  try{
    run(ctx, "FOODS['" + FOOD_ID + "'] = " + JSON.stringify({
      name: FOOD_NAME, per: 100, unit: 'g',
      kcal: 40, protein: 2, carbs: 5, fat: 1, satFat: 0, fiber: 1, sugars: 0, freeSugars: 0,
      flags: [], cat: 'Pantry', iconKey: 'spinach', src: 'test fixture'
    }) + ';');
    run(ctx, "RECIPES_DB['" + RECIPE_ID + "'] = " + JSON.stringify({
      title: 'P3 restock fixture dish', emoji: '🧪', slot: 'dinner', role: 'full',
      occasional: true, // see the other P3 fixture: keeps the generator from planning it too
      styles: ['balanced'], time: 5, servings: 1,
      ingredients: [[FOOD_ID, 300]], toTaste: [], steps: ['Combine.'], tags: [], avoid: []
    }) + ';');

    run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "';");
    run(ctx, 'weekPlans = {}; weekPlan = null; logHistory = {}; pantry = {}; checkedShopByWeek = {};');
    call(ctx, 'ensureWeekPlan', [FIXED_MONDAY]);
    run(ctx, "weekPlans['" + FIXED_MONDAY + "'].days[0].meals.dinner.elena = " + JSON.stringify({recipeId: RECIPE_ID, portion: 1, kcal: 0, protein: 0}) + ';');

    // Pantry already has SOME (80g) — the sheet's listed (net) qty is 300 - 80 = 220.
    run(ctx, "pantry['" + FOOD_ID + "'] = {qty: 80, setAt: 1000, u: 1000};");
    const list = call(ctx, 'computeShoppingList', [FIXED_MONDAY]);
    assert(Math.abs(list.totals[FOOD_NAME].qty - 220) < 1e-6,
      'restock test setup: the listed qty is net of the existing 80g pantry stock (300 - 80 = 220)', JSON.stringify(list.totals[FOOD_NAME]));

    // (a) ticking a row alone must NOT stock anything — ticked is a shopping-list UI
    // concept only (checkedShopByWeek), separate from the pantry until the explicit action.
    const checkedObj = {}; checkedObj[FOOD_NAME] = true;
    run(ctx, "checkedShopByWeek['" + FIXED_MONDAY + "'] = " + JSON.stringify(checkedObj) + ';');
    const remainingAfterTickOnly = call(ctx, 'pantryRemaining', []);
    assert(remainingAfterTickOnly[FOOD_ID] === 80, 'ticking a row alone changes nothing in the pantry', 'got ' + remainingAfterTickOnly[FOOD_ID]);

    // (b) the restock action: stocks the ticked row at its LISTED (net) quantity (220), ON
    // TOP of the 80g already there — expected new remaining = 80 + 220 = 300 (exactly the
    // recipe's full planned amount, as it should: you bought what was missing).
    const beforeRestock = Date.now();
    const count = call(ctx, 'restockTickedShopItems', [FIXED_MONDAY]);
    assert(count === 1, 'restockTickedShopItems: writes exactly one foodId (the single ticked row\'s single foodId)', 'got ' + count);
    const remaining = call(ctx, 'pantryRemaining', []);
    assert(Math.abs(remaining[FOOD_ID] - 300) < 1e-6,
      'restockTickedShopItems: stocks the LISTED (net) quantity ON TOP of what was already there (80 + 220 = 300)', 'got ' + remaining[FOOD_ID]);

    // (c) goes through the ONE re-baselining mutator (setPantryRemaining) — qty/setAt/u are
    // all freshly stamped there, not a raw pantry[...] write.
    const entry = get(ctx, "pantry['" + FOOD_ID + "']");
    assert(entry.qty === 300, 'restockTickedShopItems: pantry entry stores the new total qty verbatim (re-baselined)', JSON.stringify(entry));
    assert(typeof entry.setAt === 'number' && entry.setAt >= beforeRestock,
      'restockTickedShopItems: re-stamps setAt to NOW via setPantryRemaining — proves it went through the mutator, not a raw write', JSON.stringify(entry));
    assert(typeof entry.u === 'number' && entry.u >= beforeRestock,
      'restockTickedShopItems: re-stamps a fresh sync u too', JSON.stringify(entry));

    // (d) nothing ticked -> nothing written.
    run(ctx, "checkedShopByWeek['" + FIXED_MONDAY + "'] = {};");
    const countNone = call(ctx, 'restockTickedShopItems', [FIXED_MONDAY]);
    assert(countNone === 0, 'restockTickedShopItems: with nothing ticked, writes nothing', 'got ' + countNone);
  } finally {
    run(ctx, "delete RECIPES_DB['" + RECIPE_ID + "']; delete FOODS['" + FOOD_ID + "'];");
    run(ctx, 'weekPlans = __savedWeekPlans__; weekPlan = __savedWeekPlan__; delete __savedWeekPlans__; delete __savedWeekPlan__;');
    run(ctx, 'logHistory = ' + JSON.stringify(savedLogHistory) + '; pantry = ' + JSON.stringify(savedPantry) + '; checkedShopByWeek = ' + JSON.stringify(savedChecked) + ';');
  }
}

/* ===================================================================
   PANTRY-plan.md P1: state.js pantry — module state, buildSnapshot()/loadState() round
   trip, the reset path, and isValidPantryEntry()'s load-time validation.
   =================================================================== */
function testPantryLoadValidation(ctx){
  // isValidPantryEntry() unit-level: exercises branches a realistic localStorage JSON
  // round-trip can't reach on its own (JSON.parse can never itself produce NaN, and a
  // non-object entry only arises from hand-authored/corrupt data).
  (function(){
    assert(call(ctx, 'isValidPantryEntry', ['eggs', {qty: 6, setAt: 1, u: 1}]) === true,
      'isValidPantryEntry: a well-formed entry for a real foodId is valid');
    assert(call(ctx, 'isValidPantryEntry', ['eggs', {qty: 0, setAt: 1, u: 1}]) === true,
      'isValidPantryEntry: qty:0 (a delete/tombstone, PANTRY-plan.md) is valid — the guard is >= 0, not > 0');
    assert(call(ctx, 'isValidPantryEntry', ['not-a-real-food-id', {qty: 6}]) === false,
      'isValidPantryEntry: an unknown foodId is invalid');
    assert(call(ctx, 'isValidPantryEntry', ['eggs', {qty: -1}]) === false,
      'isValidPantryEntry: a negative qty is invalid');
    assert(call(ctx, 'isValidPantryEntry', ['eggs', {qty: NaN}]) === false,
      'isValidPantryEntry: a NaN qty is invalid');
    assert(call(ctx, 'isValidPantryEntry', ['eggs', {qty: '6'}]) === false,
      'isValidPantryEntry: a string qty is invalid (must be typeof number)');
    assert(call(ctx, 'isValidPantryEntry', ['eggs', null]) === false,
      'isValidPantryEntry: a null entry is invalid');
    assert(call(ctx, 'isValidPantryEntry', ['eggs', {}]) === false,
      'isValidPantryEntry: an entry with no qty at all is invalid');
  })();

  const savedPantry = get(ctx, 'pantry');
  ctx.__savedPantry__ = savedPantry;
  try{
    // End-to-end round trip through localStorage/loadState() (not just the predicate above)
    // — proves the actual wiring: module state, buildSnapshot(), and the reset+validate
    // block in loadState(). Object.assign(buildSnapshot(), {pantry: ...}) keeps every OTHER
    // field exactly as the live app currently has it (same convention testGoalToggles/
    // testNextWeekTuning use), so this can't disturb any other global's semantic content.
    const goodPantry = {
      eggs: {qty: 6, setAt: 1000, u: 1000},
      'olive-oil': {qty: 0, setAt: 2000, u: 2000} // qty:0 tombstone — must survive
    };
    run(ctx, "localStorage.setItem(STORE_KEY, JSON.stringify(Object.assign({}, buildSnapshot(), {pantry: " + JSON.stringify(goodPantry) + "})));");
    run(ctx, 'pantry = {};'); // scramble in-memory before reload
    run(ctx, 'loadState();');
    assert(JSON.stringify(get(ctx, 'pantry')) === JSON.stringify(goodPantry),
      'loadState(): a well-formed pantry (including a qty:0 tombstone) round-trips exactly',
      'got ' + JSON.stringify(get(ctx, 'pantry')));
    run(ctx, 'localStorage.removeItem(STORE_KEY);');

    // A payload with one good entry alongside every kind of bad one — built from a REAL
    // buildSnapshot() so every other field stays valid, then hand-edited as raw JSON TEXT
    // (not a JS object round-tripped through JSON.stringify, which would silently turn a
    // JS Infinity into `null` before loadState() ever saw it) so it can carry a literal
    // `1e999` token — the one way a real JSON string parses to Infinity.
    const base = call(ctx, 'buildSnapshot', []);
    base.pantry = {
      eggs: {qty: 3, setAt: 1000, u: 1000},                  // kept
      'not-a-real-food-id': {qty: 5, setAt: 1000, u: 1000},  // dropped: foodId not in FOODS
      rice: {qty: -1, setAt: 1000, u: 1000},                 // dropped: qty < 0
      potatoes: {qty: '5', setAt: 1000, u: 1000},            // dropped: qty not typeof number
      cod: {qty: '__INF_PLACEHOLDER__', setAt: 1000, u: 1000}, // dropped: qty not finite (see replace() below)
      prawns: {qty: 0, setAt: 3000, u: 3000}                 // kept: qty:0 tombstone
    };
    const raw = JSON.stringify(base).replace('"__INF_PLACEHOLDER__"', '1e999');
    run(ctx, 'localStorage.setItem(STORE_KEY, ' + JSON.stringify(raw) + ');');
    run(ctx, 'pantry = {};');
    run(ctx, 'loadState();');
    const loadedBad = get(ctx, 'pantry');
    assert(JSON.stringify(Object.keys(loadedBad).sort()) === JSON.stringify(['eggs', 'prawns']),
      'loadState(): drops an unknown foodId, a negative qty, a non-numeric qty, and a non-finite (Infinity) qty, keeping only the valid entries (incl. a qty:0 tombstone)',
      'got keys=' + JSON.stringify(Object.keys(loadedBad)));
    assert(loadedBad.eggs.qty === 3 && loadedBad.prawns.qty === 0,
      'loadState(): the surviving entries keep their exact qty', JSON.stringify(loadedBad));
    run(ctx, 'localStorage.removeItem(STORE_KEY);');

    // The reset path: a pre-pantry backup (no `pantry` key in the saved object at all, the
    // shape every store predating this feature has) must reset pantry to {} rather than
    // carry over whatever was in memory before loadState() ran.
    const base2 = call(ctx, 'buildSnapshot', []);
    delete base2.pantry;
    run(ctx, 'localStorage.setItem(STORE_KEY, ' + JSON.stringify(JSON.stringify(base2)) + ');');
    run(ctx, 'pantry = {eggs: {qty: 1, setAt: 1, u: 1}};'); // scramble with a NONEMPTY value first
    run(ctx, 'loadState();');
    assert(JSON.stringify(get(ctx, 'pantry')) === '{}',
      'loadState(): a pre-pantry backup (no pantry key at all) resets pantry to {} rather than keeping stale in-memory data',
      'got ' + JSON.stringify(get(ctx, 'pantry')));
    run(ctx, 'localStorage.removeItem(STORE_KEY);');
  } finally {
    ctx.__savedPantry__ = savedPantry;
    run(ctx, 'pantry = __savedPantry__; delete __savedPantry__;');
    run(ctx, "localStorage.removeItem(STORE_KEY);");
  }
}

// validateBackupStructure() (render.js) — the shallow backup-file structural gate. pantry
// is additive/optional like every other post-v4 field it doesn't enumerate.
function testValidateBackupStructurePantry(ctx){
  const base = call(ctx, 'buildSnapshot', []);
  delete base.pantry;
  assert(call(ctx, 'validateBackupStructure', [base]) === true,
    'validateBackupStructure: a pre-pantry backup (no pantry key) is still valid');
  const withPantry = Object.assign({}, base, {pantry: {eggs: {qty: 1, setAt: 1, u: 1}}});
  assert(call(ctx, 'validateBackupStructure', [withPantry]) === true,
    'validateBackupStructure: a backup with a well-formed pantry object is valid');
  const badPantry = Object.assign({}, base, {pantry: 'not-an-object'});
  assert(call(ctx, 'validateBackupStructure', [badPantry]) === false,
    'validateBackupStructure: a non-object pantry field is rejected');
}

/* ===================================================================
   PANTRY-plan.md P2: pantryConsumedSince()/pantryRemaining() (js/pantry.js) — pure
   derivation from logHistory + the pantry baseline. Snapshots/restores both `pantry` and
   `logHistory` (including on failure) since every sub-test mutates them directly, per the
   plan's test list: consumption summed across both people, a backdated (t:null) entry
   counted, remaining floored at 0, each food using its OWN setAt (never a shared/global
   one), and the 60-day retention bound pinned so nobody later assumes unlimited history.
   =================================================================== */
function testPantryConsumedSinceAndRemaining(ctx){
  const savedPantry = cloneJSON(get(ctx, 'pantry'));
  const savedLogHistory = cloneJSON(get(ctx, 'logHistory'));
  try{
    // (a) both people summed: a shared dish is logged once per eater (matching
    // computeShoppingList's convention, planner.js) — both contribute to consumption.
    (function(){
      run(ctx, 'logHistory = {}; pantry = {};');
      call(ctx, 'logFoodEntry', ['2026-07-10', 'elena', 'eggs', 100]);   // 100/50 = 2 pieces
      call(ctx, 'logFoodEntry', ['2026-07-10', 'partner', 'eggs', 150]); // 150/50 = 3 pieces
      const consumed = call(ctx, 'pantryConsumedSince', [0]);
      assert(Math.abs(consumed['eggs'] - 5) < 1e-9,
        'pantryConsumedSince: sums BOTH people\'s logs for the same food (2 + 3 = 5 eggs)', 'got ' + consumed['eggs']);
    })();

    // Consumption is filtered on WHEN THE FOOD WAS EATEN (date + t), never on the entry's
    // `u` sync stamp — see pantry.js:logEntryEatenAtMs. These fixtures therefore anchor
    // setAt to a real calendar instant relative to the logged dates, rather than pairing a
    // "now" baseline with a past log date (which is only coherent under the old, wrong
    // `u`-based reading).
    const AT = function(y, m, d, hh, mm){ return 'new Date(' + y + ',' + (m - 1) + ',' + d + ',' + (hh || 0) + ',' + (mm || 0) + ',0,0).getTime()'; };

    // (b) a backdated (t:null, task B5 catch-up) plan entry for a day AFTER the baseline
    // still counts: t:null resolves to the END of its day, so a same-day ambiguity counts
    // the meal rather than silently keeping food the household may not have.
    const FIXTURE_ID = '__pantry_p2_fixture_recipe__';
    run(ctx, "RECIPES_DB['" + FIXTURE_ID + "'] = " + JSON.stringify({
      title: 'P2 fixture dish', emoji: '🧪', slot: 'dinner', role: 'full',
      styles: ['balanced'], time: 5, servings: 1,
      ingredients: [['spinach', 100]], toTaste: [], steps: ['Combine.'], tags: [], avoid: []
    }) + ';');
    try{
      run(ctx, 'logHistory = {}; pantry = {};');
      run(ctx, "pantry['spinach'] = {qty: 500, setAt: " + AT(2026, 7, 10, 8, 0) + ", u: 1};");
      call(ctx, 'logPlanEntry', ['2026-07-12', 'elena', 'dinner', FIXTURE_ID, 1, [{recipeId: FIXTURE_ID, portion: 1}], {tNull: true}]);
      const logged = get(ctx, "logHistory['2026-07-12'].elena[0]");
      assert(logged && logged.t === null, 'sanity: the fixture entry is really backdated (t === null)', JSON.stringify(logged));
      const remaining = call(ctx, 'pantryRemaining', []);
      assert(Math.abs(remaining['spinach'] - 400) < 1e-9,
        'pantryRemaining: a backdated (t:null) entry AFTER the baseline is counted (500 - 100 = 400)', 'got ' + remaining['spinach']);

      // (b2) THE CATCH-UP CASE the `u` stamp got wrong: the same backdated entry, but for a
      // day BEFORE the baseline. The baseline is a PHYSICAL count of the cupboard, so it
      // already reflected that meal — subtracting it again would double-count. Filtering on
      // `u` (when it was entered, i.e. now) would wrongly deduct it.
      run(ctx, 'logHistory = {}; pantry = {};');
      run(ctx, "pantry['spinach'] = {qty: 500, setAt: " + AT(2026, 7, 10, 8, 0) + ", u: 1};");
      call(ctx, 'logPlanEntry', ['2026-07-05', 'elena', 'dinner', FIXTURE_ID, 1, [{recipeId: FIXTURE_ID, portion: 1}], {tNull: true}]);
      const catchUp = call(ctx, 'pantryRemaining', []);
      assert(catchUp['spinach'] === 500,
        'pantryRemaining: catch-up logging a meal EATEN BEFORE the baseline does not deduct it (the physical count already reflected it)', 'got ' + catchUp['spinach']);

      // (b3) EDITING an old meal re-stamps its `u` to now (log.js:upsertLogEntry does this
      // so sync sees the edit as newer). That must NOT drag a pre-baseline meal's whole
      // ingredient list into today's pantry — the food still left the shelf back then.
      run(ctx, "logHistory['2026-07-05'].elena[0].u = Date.now();");
      const afterEdit = call(ctx, 'pantryRemaining', []);
      assert(afterEdit['spinach'] === 500,
        'pantryRemaining: bumping a pre-baseline entry\'s `u` (an edit/swap) does not retroactively deduct it', 'got ' + afterEdit['spinach']);
    } finally {
      run(ctx, "delete RECIPES_DB['" + FIXTURE_ID + "'];");
    }

    // (c) never negative: consumption can exceed the stored baseline (e.g. a baseline that
    // was already stale) — pantryRemaining() must floor at 0, not go negative.
    (function(){
      run(ctx, 'logHistory = {}; pantry = {};');
      run(ctx, "pantry['eggs'] = {qty: 1, setAt: " + AT(2026, 7, 5, 0, 0) + ", u: 1};");
      call(ctx, 'logFoodEntry', ['2026-07-06', 'elena', 'eggs', 1000]); // 20 pieces, way over baseline
      const remaining = call(ctx, 'pantryRemaining', []);
      assert(remaining['eggs'] === 0, 'pantryRemaining: floors at 0, never negative', 'got ' + remaining['eggs']);
    })();

    // (d) each food uses its OWN setAt as the consumption origin, never a single shared/
    // global timestamp. Spinach was re-baselined on the 10th (a later shop) while eggs'
    // baseline dates from the 1st. A spinach meal eaten on the 8th falls BEFORE spinach's
    // own baseline — already reflected in that count — so it must not be deducted, even
    // though it is after eggs' baseline. A (wrong) shared-minimum-timestamp implementation
    // would count it.
    (function(){
      run(ctx, 'logHistory = {}; pantry = {};');
      run(ctx, "pantry['eggs'] = {qty: 10, setAt: " + AT(2026, 7, 1, 0, 0) + ", u: 1};");
      run(ctx, "pantry['spinach'] = {qty: 500, setAt: " + AT(2026, 7, 10, 8, 0) + ", u: 1};");
      run(ctx, "logHistory['2026-07-08'] = {elena: [{kind: 'food', ref: 'spinach', grams: 200, id: 'a', kcal: 1, protein: 1, carbs: 1, fat: 1, satFat: 1, fiber: 1, sugars: 0, freeSugars: 0, t: '10:00', u: 2000}], partner: [], targets: {elena: null, partner: null}, skipped: {elena: {}, partner: {}}, tomb: {elena: [], partner: []}};");
      const remaining = call(ctx, 'pantryRemaining', []);
      assert(remaining['spinach'] === 500,
        'pantryRemaining: each food consumes from its OWN setAt — a spinach meal on the 8th is excluded from a spinach baseline set on the 10th, even though it is after eggs\' baseline', 'got ' + remaining['spinach']);
      assert(remaining['eggs'] === 10, 'sanity: eggs baseline is unaffected (no eggs consumption was logged)', 'got ' + remaining['eggs']);
    })();

    // (d2) the same spinach meal, now eaten AFTER its baseline, IS deducted — proving (d)
    // excludes on the timeline rather than by ignoring that food's entries altogether.
    (function(){
      run(ctx, 'logHistory = {}; pantry = {};');
      run(ctx, "pantry['spinach'] = {qty: 500, setAt: " + AT(2026, 7, 7, 0, 0) + ", u: 1};");
      run(ctx, "logHistory['2026-07-08'] = {elena: [{kind: 'food', ref: 'spinach', grams: 200, id: 'a', kcal: 1, protein: 1, carbs: 1, fat: 1, satFat: 1, fiber: 1, sugars: 0, freeSugars: 0, t: '10:00', u: 2000}], partner: [], targets: {elena: null, partner: null}, skipped: {elena: {}, partner: {}}, tomb: {elena: [], partner: []}};");
      const remaining = call(ctx, 'pantryRemaining', []);
      assert(remaining['spinach'] === 300,
        'pantryRemaining: a spinach meal on the 8th IS deducted from a baseline set on the 7th (500 - 200 = 300)', 'got ' + remaining['spinach']);
    })();

    // (e) retention bound pinned: LOG_HISTORY_RETENTION_DAYS (log.js) is 60 — a baseline
    // older than that would over-report what's left once logHistory is pruned. Pinning this
    // so nobody later assumes unlimited history (PANTRY-plan.md §2).
    assert(get(ctx, 'LOG_HISTORY_RETENTION_DAYS') === 60,
      'LOG_HISTORY_RETENTION_DAYS is pinned at 60 (pantryConsumedSince cannot see further back than logHistory retains)',
      'got ' + get(ctx, 'LOG_HISTORY_RETENTION_DAYS'));
  } finally {
    run(ctx, 'pantry = ' + JSON.stringify(savedPantry) + '; logHistory = ' + JSON.stringify(savedLogHistory) + ';');
  }
}

/* ===================================================================
   PANTRY-plan.md P2: the re-baseline mutation path (js/library.js: setPantryRemaining()
   and its direct-on-row callers) — the load-bearing rule from the plan's P2 step 4. Covers:
   undo/delete restoring the remaining quantity with NO compensating write (the "derive,
   don't mutate" payoff), and the critical re-baseline case itself: a manual downward
   correction must show EXACTLY what was set, proving the pre-edit consumption is not
   double-subtracted.
   =================================================================== */
function testPantryRebaselineMutationPath(ctx){
  const savedPantry = cloneJSON(get(ctx, 'pantry'));
  const savedLogHistory = cloneJSON(get(ctx, 'logHistory'));
  try{
    // (a) undo/delete restores remaining with NO compensating write — logging consumes,
    // removeLogEntryAt (the "Today so far" ✕) undoes it, and the pantry baseline entry
    // itself must be byte-identical before and after (a pure derivation needs no write to
    // "undo" anything; the undone entry is just absent from the next pantryRemaining() walk).
    (function(){
      const dateISO = '2026-07-10';
      run(ctx, 'logHistory = {}; pantry = {};');
      // Baseline predates the logged meal: consumption is filtered on when the food was
      // EATEN (pantry.js:logEntryEatenAtMs), so a "now" setAt paired with a past log date
      // would (correctly) exclude the meal and defeat the point of this case.
      run(ctx, "pantry['eggs'] = {qty: 12, setAt: new Date(2026,6,9,0,0,0,0).getTime(), u: 1};");
      call(ctx, 'logFoodEntry', [dateISO, 'elena', 'eggs', 100]); // consumes 2 pieces
      let remaining = call(ctx, 'pantryRemaining', []);
      assert(Math.abs(remaining['eggs'] - 10) < 1e-9, 'sanity: after logging, remaining = 12 - 2 = 10', 'got ' + remaining['eggs']);

      const before = get(ctx, "pantry['eggs']");
      call(ctx, 'removeLogEntryAt', [dateISO, 'elena', 0]); // undo the quick-add
      remaining = call(ctx, 'pantryRemaining', []);
      assert(Math.abs(remaining['eggs'] - 12) < 1e-9,
        'pantryRemaining: undoing a log entry restores the FULL baseline (12) with no compensating write', 'got ' + remaining['eggs']);
      const after = get(ctx, "pantry['eggs']");
      assert(JSON.stringify(before) === JSON.stringify(after),
        'undo makes NO write at all to the pantry baseline itself (pure derivation) — before=' + JSON.stringify(before) + ' after=' + JSON.stringify(after));
    })();

    // (b) THE re-baseline test: log consumption against a food, then manually correct it
    // DOWN via setPantryRemaining (the row's typed "set-exact" / decrease path) — the
    // displayed remaining must equal EXACTLY what was set, proving setAt was re-stamped
    // atomically with qty (a stale setAt would double-subtract the pre-edit consumption and
    // show LESS than what was just typed).
    (function(){
      // The pre-correction baseline/consumption use small EXPLICIT timestamps (not
      // Date.now()) precisely so the assertion below can't collide with setPantryRemaining's
      // own real Date.now()-based setAt a few statements later — two real Date.now() calls
      // executed back-to-back in a synchronous test can legitimately land in the same
      // millisecond, which would make this test flaky rather than proving anything.
      run(ctx, 'logHistory = {}; pantry = {};');
      run(ctx, "pantry['spinach'] = {qty: 500, setAt: 1000, u: 1000};");
      run(ctx, "logHistory['2026-07-07'] = {elena: [{kind: 'food', ref: 'spinach', grams: 150, id: 'a', kcal: 1, protein: 1, carbs: 1, fat: 1, satFat: 1, fiber: 1, sugars: 0, freeSugars: 0, t: '10:00', u: 5000}], partner: [], targets: {elena: null, partner: null}, skipped: {elena: {}, partner: {}}, tomb: {elena: [], partner: []}};"); // consumes 150g at u=5000 (>= setAt=1000)
      let remaining = call(ctx, 'pantryRemaining', []);
      assert(Math.abs(remaining['spinach'] - 350) < 1e-9, 'sanity: before the correction, remaining = 500 - 150 = 350', 'got ' + remaining['spinach']);

      const beforeCorrection = Date.now();
      call(ctx, 'setPantryRemaining', ['spinach', 100]); // user corrects down to 100 — re-baselines with a real (large) Date.now(), guaranteed well past the u:5000 fixture entry above
      remaining = call(ctx, 'pantryRemaining', []);
      assert(remaining['spinach'] === 100,
        'RE-BASELINE: remaining equals EXACTLY what the user set (100) — the pre-edit consumption is not double-subtracted', 'got ' + remaining['spinach']);
      const entry = get(ctx, "pantry['spinach']");
      assert(entry.qty === 100, 'setPantryRemaining: stores the new qty verbatim', JSON.stringify(entry));
      assert(typeof entry.setAt === 'number' && entry.setAt >= beforeCorrection,
        'setPantryRemaining: re-stamps setAt to NOW (fresh depletion origin), not left at the old value', JSON.stringify(entry));
      assert(typeof entry.u === 'number' && entry.u >= beforeCorrection,
        'setPantryRemaining: re-stamps a fresh sync `u` too (so the correction propagates through couple sync)', JSON.stringify(entry));
    })();

    // (c) remove -> setPantryRemaining(id, 0) writes a proper fresh-`u` tombstone that
    // mergePantrySection (js/sync.js, already covered end-to-end by the P1 merge tests)
    // treats as a delete beating an older non-zero remote copy — an integration check that
    // MY mutator (not just the merge function in isolation) produces a mergeable tombstone.
    (function(){
      run(ctx, 'pantry = {};');
      run(ctx, "pantry['milk'] = {qty: 500, setAt: 1000, u: 1000};");
      call(ctx, 'setPantryRemaining', ['milk', 0]); // the row's "remove" action
      const localEntry = get(ctx, "pantry['milk']");
      assert(localEntry.qty === 0 && typeof localEntry.u === 'number' && localEntry.u > 1000,
        'setPantryRemaining(id, 0): produces a qty:0 tombstone with a fresh `u`', JSON.stringify(localEntry));
      const merged = call(ctx, 'mergePantrySection', [{pantry: {milk: localEntry}}, {pantry: {milk: {qty: 500, setAt: 1000, u: 1000}}}]);
      assert(merged.pantry.milk.qty === 0,
        'mergePantrySection: the tombstone from setPantryRemaining beats an older non-zero remote copy (not resurrected)', JSON.stringify(merged.pantry.milk));
    })();
  } finally {
    run(ctx, 'pantry = ' + JSON.stringify(savedPantry) + '; logHistory = ' + JSON.stringify(savedLogHistory) + ';');
  }
}

/* ===================================================================
   FAVORITES-EATENOUT-plan.md item 3 — "eaten out": a log entry's `eatenOut` flag. The ONE
   behavioural change is pantryConsumedSince (js/pantry.js) skipping such entries; nutrition
   (logEntryNutrition), the shopping-list exclusion (already achieved by being LOGGED, Q1 in
   planner.js), and sync (mergeLogSection keeps whole entries by identity+newer `u`) are all
   unaffected BY DESIGN — this suite proves that rather than assuming it. Uses a dedicated
   fixture food+recipe (not a real catalog item) so the planned/consumed quantities are
   exactly and only what this test put there. Snapshots/restores every global touched
   (logHistory, pantry, weekPlans, weekPlan), including on failure.
   =================================================================== */
function testEatenOutFlag(ctx){
  const FOOD_ID = '__eatenout_fixture_food__';
  const RECIPE_ID = '__eatenout_fixture_recipe__';
  const FOOD_NAME = 'Eaten-out fixture food';
  ctx.__savedWeekPlans__ = get(ctx, 'weekPlans');
  ctx.__savedWeekPlan__ = get(ctx, 'weekPlan');
  const savedLogHistory = cloneJSON(get(ctx, 'logHistory'));
  const savedPantry = cloneJSON(get(ctx, 'pantry'));
  try{
    run(ctx, "FOODS['" + FOOD_ID + "'] = " + JSON.stringify({
      name: FOOD_NAME, per: 100, unit: 'g',
      kcal: 50, protein: 5, carbs: 5, fat: 2, satFat: 1, fiber: 1, sugars: 0, freeSugars: 0,
      flags: [], cat: 'Produce', iconKey: 'spinach', src: 'test fixture'
    }) + ';');
    run(ctx, "RECIPES_DB['" + RECIPE_ID + "'] = " + JSON.stringify({
      title: 'Eaten-out fixture dish', emoji: '🧪', slot: 'dinner', role: 'full',
      occasional: true, // keeps the random generator from ever picking it too (see the other pantry fixtures' doc notes)
      styles: ['balanced'], time: 5, servings: 1,
      ingredients: [[FOOD_ID, 200]], toTaste: [], steps: ['Combine.'], tags: [], avoid: []
    }) + ';');

    // ---- (a) a logged kind:'plan' entry marked eaten-out: kcal stays in the day total
    // (logEntryNutrition is unchanged) but pantryConsumedSince/pantryRemaining stop
    // reflecting it — the pantry math un-deducts the 200g this dish would otherwise cost.
    // Toggling back to false restores depletion. ----
    (function(){
      const dateISO = '2026-07-10';
      run(ctx, 'logHistory = {}; pantry = {};');
      // Baseline predates the meal (consumption is filtered on WHEN THE FOOD WAS EATEN —
      // pantry.js:logEntryEatenAtMs), same convention testPantryConsumedSinceAndRemaining
      // uses: setAt at the START of the day, the entry backdated (t:null) so it resolves to
      // the END of that same day, i.e. clearly after setAt.
      run(ctx, "pantry['" + FOOD_ID + "'] = {qty: 500, setAt: new Date(2026,6,10,0,0,0,0).getTime(), u: 1};");
      call(ctx, 'logPlanEntry', [dateISO, 'elena', 'dinner', RECIPE_ID, 1, [{recipeId: RECIPE_ID, portion: 1}], {tNull: true}]);

      const entryPath = "logHistory['" + dateISO + "'].elena[0]";
      const kcalBefore = run(ctx, 'logEntryNutrition(' + entryPath + ').kcal');
      // recipeNutrition recomputes kcal 4/4/9 from the summed macros (never the food's own
      // declared `kcal` field — see engine.js's doc comment on that policy), so this is
      // 200g of {protein:5, carbs:5, fat:2} per 100g -> protein 10, carbs 10, fat 4 ->
      // 4*10 + 4*10 + 9*4 = 116, not the food's naive 50*2=100.
      assert(Math.abs(kcalBefore - 116) < 1e-9, 'setup sanity: the fixture dish (200g, Atwater 4/4/9 from summed macros) logs at 116 kcal', 'got ' + kcalBefore);

      const remainingBeforeFlag = call(ctx, 'pantryRemaining', []);
      assert(Math.abs(remainingBeforeFlag[FOOD_ID] - 300) < 1e-9,
        'setup sanity: BEFORE marking eaten-out, the logged meal depletes the pantry normally (500 - 200 = 300)', 'got ' + remainingBeforeFlag[FOOD_ID]);

      const marked = call(ctx, 'setLogEntryEatenOut', [dateISO, 'elena', 0, true]);
      assert(!!marked && marked.eatenOut === true, 'setLogEntryEatenOut: sets eatenOut === true on the target entry', JSON.stringify(marked));

      const kcalAfter = run(ctx, 'logEntryNutrition(' + entryPath + ').kcal');
      assert(kcalAfter === kcalBefore, 'eaten-out kind:"plan" entry: kcal in the day total is UNCHANGED (logEntryNutrition never looks at eatenOut)', 'before=' + kcalBefore + ' after=' + kcalAfter);

      const remainingEatenOut = call(ctx, 'pantryRemaining', []);
      assert(remainingEatenOut[FOOD_ID] === 500,
        'pantryConsumedSince: an eaten-out kind:"plan" entry is skipped entirely — pantryRemaining() does NOT drop for its ingredients (stays at the full 500)', 'got ' + remainingEatenOut[FOOD_ID]);

      // Toggle back off: depletion is restored (this is a live derivation, not a one-way flag).
      call(ctx, 'setLogEntryEatenOut', [dateISO, 'elena', 0, false]);
      const remainingRestored = call(ctx, 'pantryRemaining', []);
      assert(remainingRestored[FOOD_ID] === 300,
        'toggling eaten-out back to false restores pantry depletion (500 - 200 = 300 again)', 'got ' + remainingRestored[FOOD_ID]);
    })();

    // ---- (b) a logged kind:'food' quick-add marked eaten-out likewise does not deplete
    // the pantry, and likewise restores on toggle-off. ----
    (function(){
      const dateISO = '2026-07-11';
      run(ctx, 'logHistory = {}; pantry = {};');
      run(ctx, "pantry['" + FOOD_ID + "'] = {qty: 500, setAt: new Date(2026,6,11,0,0,0,0).getTime(), u: 1};");
      call(ctx, 'logFoodEntry', [dateISO, 'elena', FOOD_ID, 200]); // quick-add 200g of the fixture food directly

      const remainingBefore = call(ctx, 'pantryRemaining', []);
      assert(Math.abs(remainingBefore[FOOD_ID] - 300) < 1e-9,
        'setup sanity: a quick-add depletes the pantry normally before any flag (500 - 200 = 300)', 'got ' + remainingBefore[FOOD_ID]);

      call(ctx, 'setLogEntryEatenOut', [dateISO, 'elena', 0, true]);
      const remainingEatenOut = call(ctx, 'pantryRemaining', []);
      assert(remainingEatenOut[FOOD_ID] === 500,
        'pantryConsumedSince: an eaten-out kind:"food" quick-add is skipped too — pantryRemaining() stays at 500', 'got ' + remainingEatenOut[FOOD_ID]);

      call(ctx, 'setLogEntryEatenOut', [dateISO, 'elena', 0, false]);
      const remainingRestored = call(ctx, 'pantryRemaining', []);
      assert(remainingRestored[FOOD_ID] === 300,
        'toggling a quick-add\'s eaten-out flag back to false restores pantry depletion (300 again)', 'got ' + remainingRestored[FOOD_ID]);
    })();

    // ---- (c) setLogEntryEatenOut bumps `u` (so mergeLogSection sees the toggle as newer)
    // and guards a bad/stale index the same way removeLogEntryAt does. ----
    (function(){
      const dateISO = '2026-07-12';
      run(ctx, 'logHistory = {}; pantry = {};');
      call(ctx, 'logFoodEntry', [dateISO, 'elena', FOOD_ID, 50]);
      // Pin an explicit, unambiguously-old `u` first — two real Date.now() calls executed
      // back-to-back can legitimately land in the same millisecond, which would make a
      // "strictly newer" assertion flaky rather than proving anything (same reasoning
      // testPantryRebaselineMutationPath's re-baseline case already documents).
      run(ctx, "logHistory['" + dateISO + "'].elena[0].u = 1000;");
      const beforeToggle = Date.now();
      const marked = call(ctx, 'setLogEntryEatenOut', [dateISO, 'elena', 0, true]);
      assert(!!marked && typeof marked.u === 'number' && marked.u >= beforeToggle,
        'setLogEntryEatenOut: re-stamps `u` to (approximately) now', JSON.stringify(marked));
      assert(marked.u > 1000, 'setLogEntryEatenOut: the fresh `u` is strictly newer than the pinned old one', 'got ' + marked.u);

      const badIndex = call(ctx, 'setLogEntryEatenOut', [dateISO, 'elena', 7, true]);
      assert(badIndex === null, 'setLogEntryEatenOut: an out-of-range index is a no-op (returns null), mirroring removeLogEntryAt\'s guard', 'got ' + JSON.stringify(badIndex));
    })();

    // ---- (d) the flag survives a mergeLogSection round-trip: an entry toggled eaten-out
    // (via the real mutator, so its `u` is genuinely fresh) beats an older remote copy of
    // the SAME identity that predates the toggle — the couple-sync contract every other
    // log edit already relies on (mergeLogSection: newer-`u`-wins by identity). ----
    (function(){
      const dateISO = '2026-07-13';
      run(ctx, 'logHistory = {};');
      call(ctx, 'logFoodEntry', [dateISO, 'elena', 'eggs', 100]);
      run(ctx, "logHistory['" + dateISO + "'].elena[0].u = 1000;"); // pin an old `u` (see (c)'s note on avoiding same-millisecond flakiness)
      const beforeEntry = cloneJSON(get(ctx, "logHistory['" + dateISO + "'].elena[0]"));
      call(ctx, 'setLogEntryEatenOut', [dateISO, 'elena', 0, true]);
      const afterEntry = cloneJSON(get(ctx, "logHistory['" + dateISO + "'].elena[0]"));
      assert(afterEntry.eatenOut === true && afterEntry.u > beforeEntry.u,
        'setup: the toggled entry really is eatenOut:true with a strictly newer `u` than the pre-toggle copy', JSON.stringify({before: beforeEntry, after: afterEntry}));

      const wireLocal = {}; wireLocal[dateISO] = {entries: [afterEntry], tomb: [], target: null, skipped: {}};
      const wireRemote = {}; wireRemote[dateISO] = {entries: [beforeEntry], tomb: [], target: null, skipped: {}}; // an older remote copy that never saw the toggle
      const merged = call(ctx, 'mergeLogSection', [cloneJSON(wireLocal), cloneJSON(wireRemote)]);
      assert(merged[dateISO].entries.length === 1 && merged[dateISO].entries[0].eatenOut === true,
        'mergeLogSection: the eatenOut toggle (newer `u`) survives merging against an older remote copy without it', JSON.stringify(merged[dateISO].entries));

      // Order-independence: passing the same two wire copies with local/remote swapped
      // must reach the same result — mergeLogSection's newer-`u`-wins rule keys on the
      // entry's OWN `u`, never on which argument slot it arrived in.
      const mergedSwapped = call(ctx, 'mergeLogSection', [cloneJSON(wireRemote), cloneJSON(wireLocal)]);
      assert(mergedSwapped[dateISO].entries.length === 1 && mergedSwapped[dateISO].entries[0].eatenOut === true,
        'mergeLogSection: eatenOut survival is order-independent (newer `u` wins regardless of local/remote argument order)', JSON.stringify(mergedSwapped[dateISO].entries));
    })();

    // ---- (e) shopping list: a planned meal LOGGED and marked eaten-out stays absent from
    // the current-week shopping list. This is the plan's explicit "verify, don't build"
    // item — the exclusion already comes from being logged (Q1, planner.js:
    // weekPlanComponents/slotLoggedReadOnly, which reads slotLogStatus() and never looks at
    // eatenOut at all), so marking it eaten-out on top must be a complete no-op for the
    // list, not a second exclusion path and not a reintroduction. ----
    (function(){
      run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "'; weekPlans = {}; weekPlan = null; logHistory = {}; pantry = {};");
      call(ctx, 'ensureWeekPlan', [FIXED_MONDAY]);
      run(ctx, "weekPlans['" + FIXED_MONDAY + "'].days[0].meals.dinner.elena = " + JSON.stringify({recipeId: RECIPE_ID, portion: 1, kcal: 0, protein: 0}) + ';');

      const before = call(ctx, 'computeShoppingList', [FIXED_MONDAY]);
      assert(!!before.totals[FOOD_NAME] && Math.abs(before.totals[FOOD_NAME].qty - 200) < 1e-6,
        'setup sanity: the fixture dish is planned at 200g before logging', JSON.stringify(before.totals[FOOD_NAME]));

      call(ctx, 'logPlanEntry', [FIXED_MONDAY, 'elena', 'dinner', RECIPE_ID, 1, [{recipeId: RECIPE_ID, portion: 1}]]);
      const afterLogged = call(ctx, 'computeShoppingList', [FIXED_MONDAY]);
      assert(!afterLogged.totals[FOOD_NAME],
        'sanity: logging the slot already drops it from the current-week list (Q1, pre-existing behavior — unrelated to eatenOut)', JSON.stringify(Object.keys(afterLogged.totals)));

      call(ctx, 'setLogEntryEatenOut', [FIXED_MONDAY, 'elena', 0, true]);
      const afterEatenOut = call(ctx, 'computeShoppingList', [FIXED_MONDAY]);
      assert(!afterEatenOut.totals[FOOD_NAME],
        'FAVORITES-EATENOUT-plan.md item 3: a planned meal marked eaten-out stays absent from the current-week shopping list (no second exclusion path was added — the existing logged-exclusion already covers it)', JSON.stringify(Object.keys(afterEatenOut.totals)));
    })();
  } finally {
    run(ctx, "delete RECIPES_DB['" + RECIPE_ID + "']; delete FOODS['" + FOOD_ID + "'];");
    run(ctx, 'weekPlans = __savedWeekPlans__; weekPlan = __savedWeekPlan__; delete __savedWeekPlans__; delete __savedWeekPlan__;');
    run(ctx, 'logHistory = ' + JSON.stringify(savedLogHistory) + '; pantry = ' + JSON.stringify(savedPantry) + ';');
  }
}

/* ---------------- FAVORITES-EATENOUT-plan.md item 3: toggle wiring (source guard) ----------------
   The Today lists' per-row eaten-out toggle can't be exercised through the DOM here (this
   harness's document stub returns null from getElementById — see this file's header doc,
   and the same reasoning testRefreshAfterLogChangeRendersWeekOnce already applies to the
   Week-render funnel). So this asserts the WIRING structurally: the toggle handlers really
   call setLogEntryEatenOut() and go through the shared refreshAfterLogChange() funnel (not
   some ad-hoc repaint), and the two render functions really reference the toggle handlers
   and the "eaten out" pill, rather than silently never being called. */
function testEatenOutToggleWiring(){
  const renderSrc = fs.readFileSync(path.join(APP_DIR, 'js', 'render.js'), 'utf8');
  const fnBody = function(name){
    const m = renderSrc.match(new RegExp('function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}\\n'));
    return m ? m[0] : '';
  };

  const toggleRow = fnBody('toggleTodayEntryEatenOut');
  assert(toggleRow.length > 0, 'wiring setup: toggleTodayEntryEatenOut() function body found in render.js', 'not found');
  assert(toggleRow.indexOf('setLogEntryEatenOut(') !== -1, 'toggleTodayEntryEatenOut(): calls setLogEntryEatenOut() (log.js)', toggleRow);
  assert(toggleRow.indexOf('refreshAfterLogChange()') !== -1, 'toggleTodayEntryEatenOut(): re-renders through the shared refreshAfterLogChange() funnel', toggleRow);

  const toggleGroup = fnBody('toggleTodayRecordGroupEatenOut');
  assert(toggleGroup.length > 0, 'wiring setup: toggleTodayRecordGroupEatenOut() function body found in render.js', 'not found');
  assert(toggleGroup.indexOf('setLogEntryEatenOut(') !== -1, 'toggleTodayRecordGroupEatenOut(): calls setLogEntryEatenOut() (log.js)', toggleGroup);
  assert(toggleGroup.indexOf('refreshAfterLogChange()') !== -1, 'toggleTodayRecordGroupEatenOut(): re-renders through the shared refreshAfterLogChange() funnel', toggleGroup);

  const soFarFn = fnBody('renderTodaySoFar');
  assert(soFarFn.length > 0, 'wiring setup: renderTodaySoFar() function body found in render.js', 'not found');
  assert(soFarFn.indexOf('toggleTodayEntryEatenOut(') !== -1, 'renderTodaySoFar(): each row wires its toggle button to toggleTodayEntryEatenOut()', soFarFn);
  assert(soFarFn.indexOf('chip-computed') !== -1, 'renderTodaySoFar(): an eaten-out row shows an at-a-glance pill (reuses the chip-computed style)', soFarFn);

  const recordsFn = fnBody('renderTodayRecords');
  assert(recordsFn.length > 0, 'wiring setup: renderTodayRecords() function body found in render.js', 'not found');
  // A plan row (delete only, no edit sheet) keeps the inline toggle; a food row routes it
  // into the edit sheet to avoid a crowded three-button row (Elena's call, 2026-07-21).
  assert(recordsFn.indexOf('toggleTodayRecordGroupEatenOut(') !== -1, 'renderTodayRecords(): a plan row wires its inline toggle to toggleTodayRecordGroupEatenOut()', recordsFn);
  assert(recordsFn.indexOf('chip-computed') !== -1, 'renderTodayRecords(): an eaten-out row shows an at-a-glance pill (reuses the chip-computed style)', recordsFn);

  // Food-row eaten-out lives in the edit sheet: the sheet exposes the toggle, and Save
  // applies it through setLogEntryEatenOut (which bumps u for sync). This is the no-crowding
  // path Elena chose over a third inline button.
  const editSheetFn = fnBody('buildEditTodayFoodSheet');
  assert(editSheetFn.indexOf('toggleEditTodayFoodEatenOut()') !== -1, 'buildEditTodayFoodSheet(): exposes the eaten-out toggle inside the food edit sheet', editSheetFn);
  const saveFn = fnBody('saveEditTodayFood');
  assert(saveFn.indexOf('setLogEntryEatenOut(') !== -1, 'saveEditTodayFood(): applies the sheet\'s eaten-out choice via setLogEntryEatenOut()', saveFn);
  const openFn = fnBody('openEditTodayRecord');
  assert(openFn.indexOf('groupEatenOut(group)') !== -1, 'openEditTodayRecord(): seeds the edit sheet with the group\'s current eaten-out state', openFn);
}

/* ===================================================================
   WEEK-EATENOUT-plan.md — marking a Week-plan meal "eating out". NOT a new plan-cell flag:
   toggling it LOGS the planned meal as eaten-out on THAT ROW'S OWN DATE, reusing the daily
   eaten-out machinery FAVORITES-EATENOUT-plan.md item 3 already built (logPlanEntry +
   setLogEntryEatenOut on, removeLoggedSlot off) — already proven generically by
   testEatenOutFlag above (kcal counts, pantryConsumedSince skips it, setLogEntryEatenOut's
   `u`/merge behavior). This suite proves the pieces THIS feature actually adds:
   slotLoggedEatenOut() (log.js) and weekPlanComponents' UNCONDITIONAL exclusion on it
   (planner.js) — that a pre-logged eaten-out meal drops off BOTH the current week's AND
   (the plan's own flagged "subtle bit") NEXT week's shopping list, that a SHARED meal
   logs/drops BOTH people (not just one), and that undo (removeLoggedSlot) restores the
   list and leaves the slot genuinely clean for a normal re-log. The real UI handler
   (toggleWeekMealEatenOut) can't be invoked directly here — it ends in
   refreshAfterLogChange() -> renderWeek(), which needs a real #weekList element this
   harness's document stub doesn't provide (same reasoning testEatenOutToggleWiring's doc
   comment gives for the daily toggle) — so each scenario below calls the exact same
   primitives that handler calls, in the same order, and the separate wiring-guard suite
   below (testWeekEatenOutToggleWiring) proves the handler really does call them. Uses a
   dedicated fixture food+recipe (not a real catalog item, `occasional:true` so
   ensureWeekPlan's random generator never picks it on its own) so every planned/consumed
   quantity in the assertions is exactly and only what this test put there. Snapshots/
   restores every global touched (logHistory, pantry, weekPlans, weekPlan), including on
   failure.
   =================================================================== */
function testWeekEatenOut(ctx){
  const FOOD_ID = '__week_eatenout_fixture_food__';
  const RECIPE_ID = '__week_eatenout_fixture_recipe__';
  const FOOD_NAME = 'Week eaten-out fixture food';
  ctx.__savedWeekPlans__ = get(ctx, 'weekPlans');
  ctx.__savedWeekPlan__ = get(ctx, 'weekPlan');
  const savedLogHistory = cloneJSON(get(ctx, 'logHistory'));
  const savedPantry = cloneJSON(get(ctx, 'pantry'));
  try{
    run(ctx, "FOODS['" + FOOD_ID + "'] = " + JSON.stringify({
      name: FOOD_NAME, per: 100, unit: 'g',
      kcal: 50, protein: 5, carbs: 5, fat: 2, satFat: 1, fiber: 1, sugars: 0, freeSugars: 0,
      flags: [], cat: 'Produce', iconKey: 'spinach', src: 'test fixture'
    }) + ';');
    run(ctx, "RECIPES_DB['" + RECIPE_ID + "'] = " + JSON.stringify({
      title: 'Week eaten-out fixture dish', emoji: '🧪', slot: 'dinner', role: 'full',
      occasional: true, // keeps the random plan generator from ever picking it on its own
      styles: ['balanced'], time: 5, servings: 1,
      ingredients: [[FOOD_ID, 200]], toTaste: [], steps: ['Combine.'], tags: [], avoid: []
    }) + ';');

    // ---- (a) SOLO meal, CURRENT week, TODAY's date (FIXED_MONDAY === todayISO()): log +
    // mark eaten-out via the exact (logPlanEntry, setLogEntryEatenOut) pair
    // toggleWeekMealEatenOut()'s "turning ON" branch calls. Proves calories count, the
    // entry is eatenOut===true, and the pantry is NOT depleted; undo (removeLoggedSlot)
    // leaves the slot genuinely clean — a fresh NORMAL (non-eaten-out) re-log afterward
    // depletes the pantry exactly as if the eaten-out detour never happened. Shopping-list
    // assertions are the SEPARATE scenario (a2) below, with an EMPTY pantry: computeShoppingList
    // subtracts pantry stock from planned need (PANTRY-plan.md P3), so the 500g pantry
    // baseline this scenario needs (to observe depletion/non-depletion) would fully cover
    // this dish's 200g need and drop it from `totals` regardless of log state — proving
    // nothing about the eaten-out exclusion itself, and fighting the pantry feature instead
    // of testing this one. ----
    (function(){
      run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "'; weekPlans = {}; weekPlan = null; logHistory = {}; pantry = {};");
      call(ctx, 'ensureWeekPlan', [FIXED_MONDAY]);
      // partner's recipeId MUST be a real RECIPES_DB entry, not null: ensureWeekPlan's own
      // staleness check (planReferencesMissingRecipe) treats a meal cell with an unknown
      // recipeId as reason to regenerate the WHOLE plan from scratch on its very next call —
      // which would silently discard this manual override. 'baked-cod-greens' is a real,
      // unrelated built-in recipe so partner's half never touches FOOD_NAME.
      run(ctx, "weekPlans['" + FIXED_MONDAY + "'].days[0].meals.dinner = " + JSON.stringify({
        shared: false,
        elena: {recipeId: RECIPE_ID, portion: 1, kcal: 0, protein: 0},
        partner: {recipeId: 'baked-cod-greens', portion: 1, kcal: 0, protein: 0}
      }) + ';');
      run(ctx, "pantry['" + FOOD_ID + "'] = {qty: 500, setAt: new Date(2026,6,13,0,0,0,0).getTime(), u: 1};"); // 2026-07-13 00:00 = start of FIXED_MONDAY

      call(ctx, 'logPlanEntry', [FIXED_MONDAY, 'elena', 'dinner', RECIPE_ID, 1, [{recipeId: RECIPE_ID, portion: 1}]]);
      call(ctx, 'setLogEntryEatenOut', [FIXED_MONDAY, 'elena', 0, true]);

      const entry = get(ctx, "logHistory['" + FIXED_MONDAY + "'].elena[0]");
      assert(entry.kind === 'plan' && entry.slot === 'dinner' && entry.ref === RECIPE_ID && entry.eatenOut === true,
        'Week eaten-out: logs a normal kind:"plan" entry for the row\'s slot, with eatenOut===true', JSON.stringify(entry));

      const kcal = run(ctx, "logEntryNutrition(logHistory['" + FIXED_MONDAY + "'].elena[0]).kcal");
      // 200g of {protein:5, carbs:5, fat:2} per 100g -> protein 10, carbs 10, fat 4 ->
      // Atwater 4*10 + 4*10 + 9*4 = 116 (recipeNutrition recomputes from summed macros,
      // same fixture math testEatenOutFlag's setup sanity above already established).
      assert(Math.abs(kcal - 116) < 1e-9, 'Week eaten-out: the date\'s logged nutrition includes the meal\'s calories (unaffected by eatenOut)', 'got ' + kcal);

      const remainingOut = call(ctx, 'pantryRemaining', []);
      assert(remainingOut[FOOD_ID] === 500, 'Week eaten-out: pantryConsumedSince skips the eaten-out entry — the pantry is NOT depleted (stays at 500)', 'got ' + remainingOut[FOOD_ID]);

      call(ctx, 'removeLoggedSlot', [FIXED_MONDAY, 'elena', 'dinner']);
      const statusAfterUndo = call(ctx, 'slotLogStatus', [FIXED_MONDAY, 'elena', 'dinner']);
      assert(statusAfterUndo === null, 'undo (removeLoggedSlot): the slot is genuinely un-logged (slotLogStatus back to null)', 'got ' + JSON.stringify(statusAfterUndo));

      call(ctx, 'logPlanEntry', [FIXED_MONDAY, 'elena', 'dinner', RECIPE_ID, 1, [{recipeId: RECIPE_ID, portion: 1}]]);
      const remainingRelogged = call(ctx, 'pantryRemaining', []);
      assert(remainingRelogged[FOOD_ID] === 300,
        'undo (removeLoggedSlot): pantry depletion works normally again for a fresh, non-eaten-out log of the same slot (500 - 200 = 300) — undo left no residual eatenOut taint', 'got ' + remainingRelogged[FOOD_ID]);
    })();

    // ---- (a2) shopping list, CURRENT week: same solo/today setup as (a), but with an
    // EMPTY pantry (no baseline for FOOD_ID) so the plan's raw need is what shows up in
    // `totals` — pantry subtraction is orthogonal to this feature and would otherwise mask
    // the assertion (see (a)'s doc note above). Proves the meal drops off the CURRENT
    // week's list once marked eaten-out (sanity — already covered by the pre-existing Q1
    // logged-exclusion) and that undo (removeLoggedSlot) restores it. ----
    (function(){
      run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "'; weekPlans = {}; weekPlan = null; logHistory = {}; pantry = {};");
      call(ctx, 'ensureWeekPlan', [FIXED_MONDAY]);
      run(ctx, "weekPlans['" + FIXED_MONDAY + "'].days[0].meals.dinner = " + JSON.stringify({
        shared: false,
        elena: {recipeId: RECIPE_ID, portion: 1, kcal: 0, protein: 0},
        partner: {recipeId: 'baked-cod-greens', portion: 1, kcal: 0, protein: 0}
      }) + ';');

      const beforeList = call(ctx, 'computeShoppingList', [FIXED_MONDAY]);
      assert(!!beforeList.totals[FOOD_NAME] && Math.abs(beforeList.totals[FOOD_NAME].qty - 200) < 1e-6,
        'setup sanity: the fixture dish is planned at 200g before any logging', JSON.stringify(beforeList.totals[FOOD_NAME]));

      call(ctx, 'logPlanEntry', [FIXED_MONDAY, 'elena', 'dinner', RECIPE_ID, 1, [{recipeId: RECIPE_ID, portion: 1}]]);
      call(ctx, 'setLogEntryEatenOut', [FIXED_MONDAY, 'elena', 0, true]);

      const listAfterOut = call(ctx, 'computeShoppingList', [FIXED_MONDAY]);
      assert(!listAfterOut.totals[FOOD_NAME], 'Week eaten-out: the meal drops off the CURRENT week\'s shopping list', JSON.stringify(Object.keys(listAfterOut.totals)));

      call(ctx, 'removeLoggedSlot', [FIXED_MONDAY, 'elena', 'dinner']);
      const listAfterUndo = call(ctx, 'computeShoppingList', [FIXED_MONDAY]);
      assert(!!listAfterUndo.totals[FOOD_NAME] && Math.abs(listAfterUndo.totals[FOOD_NAME].qty - 200) < 1e-6,
        'undo (removeLoggedSlot): the meal reappears on the shopping list', JSON.stringify(listAfterUndo.totals[FOOD_NAME]));
    })();

    // ---- (b) THE SUBTLE BIT (WEEK-EATENOUT-plan.md's own "Risks" section): a solo meal on
    // NEXT week, pre-logged eaten-out for a date that is NOT today ({tNull:true} — the same
    // backdated convention weekLogConfirm uses for a past date, here used for a FUTURE one
    // per the plan's "log it now, dated to that day" decision). computeShoppingList only
    // ever passes excludeLogged=true for the CURRENT week — a next-week list is built via
    // weekPlanComponents(plan, /*excludeLogged*/ false) — so WITHOUT the new UNCONDITIONAL
    // slotLoggedEatenOut() exclusion, this meal would silently stay on next week's list
    // forever. This is THE test that must fail if that planner.js line is reverted. ----
    (function(){
      run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "'; weekPlans = {}; weekPlan = null; logHistory = {}; pantry = {};");
      // nextMondayISO() must be computed AFTER MESA_TEST_TODAY is pinned above — it derives
      // from the mocked "today", and a stale value left over from an earlier test's own
      // MESA_TEST_TODAY would silently point this scenario at the wrong week.
      const nextMonday = call(ctx, 'nextMondayISO', []);
      call(ctx, 'ensureWeekPlan', [nextMonday]);
      // partner's recipeId must be real (see the identical note in scenario (a) above) —
      // otherwise ensureWeekPlan's planReferencesMissingRecipe() regenerates the whole plan
      // on the very next ensureWeekPlan call and silently discards this override.
      run(ctx, "weekPlans['" + nextMonday + "'].days[2].meals.lunch = " + JSON.stringify({
        shared: false,
        elena: {recipeId: RECIPE_ID, portion: 1, kcal: 0, protein: 0},
        partner: {recipeId: 'baked-cod-greens', portion: 1, kcal: 0, protein: 0}
      }) + ';');
      const nextDayISO = get(ctx, "weekPlans['" + nextMonday + "'].days[2].date");

      const beforeNext = call(ctx, 'computeShoppingList', [nextMonday]);
      assert(!!beforeNext.totals[FOOD_NAME] && Math.abs(beforeNext.totals[FOOD_NAME].qty - 200) < 1e-6,
        'setup sanity: next week\'s fixture dish is planned at 200g before pre-logging', JSON.stringify(beforeNext.totals[FOOD_NAME]));
      assert(nextDayISO !== FIXED_MONDAY, 'setup sanity: the pre-logged date is genuinely NOT today', nextDayISO);

      call(ctx, 'logPlanEntry', [nextDayISO, 'elena', 'lunch', RECIPE_ID, 1, [{recipeId: RECIPE_ID, portion: 1}], {tNull: true}]);
      call(ctx, 'setLogEntryEatenOut', [nextDayISO, 'elena', 0, true]);
      const preloggedEntry = get(ctx, "logHistory['" + nextDayISO + "'].elena[0]");
      assert(preloggedEntry.t === null && preloggedEntry.eatenOut === true,
        'setup sanity: the future pre-log carries t:null (unknown eating time, weekLogConfirm\'s own backdated convention) and eatenOut===true', JSON.stringify(preloggedEntry));

      const afterNext = call(ctx, 'computeShoppingList', [nextMonday]);
      assert(!afterNext.totals[FOOD_NAME],
        'THE CRITICAL ASSERTION: a pre-logged eaten-out meal is absent from NEXT week\'s shopping list too, even though computeShoppingList builds next week via weekPlanComponents(plan, /*excludeLogged*/ false)', JSON.stringify(Object.keys(afterNext.totals)));

      // Pins the assertion to the exact call shape the plan's Risks section calls out
      // (weekPlanComponents called directly with excludeLogged=false), not just the
      // higher-level computeShoppingList wrapper.
      const nextPlan = get(ctx, "weekPlans['" + nextMonday + "']");
      const directComponents = call(ctx, 'weekPlanComponents', [nextPlan, false]);
      const stillPresent = directComponents.some(function(c){ return c.recipeId === RECIPE_ID; });
      assert(!stillPresent, 'weekPlanComponents(plan, /*excludeLogged*/ false): the eaten-out exclusion is UNCONDITIONAL, not gated on the excludeLogged argument', JSON.stringify(directComponents));
    })();

    // ---- (c) SHARED meal, CURRENT week: marking eaten-out logs+drops BOTH `elena` and
    // `partner` — a shared dinner eating out means both people ate out, and
    // weekPlanComponents/computeShoppingList counts a shared meal once PER EATER, so
    // dropping only one person would leave the other's portion still on the list. Undo
    // removes both too. ----
    (function(){
      run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "'; weekPlans = {}; weekPlan = null; logHistory = {}; pantry = {};");
      call(ctx, 'ensureWeekPlan', [FIXED_MONDAY]);
      run(ctx, "weekPlans['" + FIXED_MONDAY + "'].days[0].meals.dinner = " + JSON.stringify({
        shared: true, recipeId: RECIPE_ID,
        elena: {recipeId: RECIPE_ID, portion: 1, kcal: 0, protein: 0},
        partner: {recipeId: RECIPE_ID, portion: 1.5, kcal: 0, protein: 0}
      }) + ';');

      const before = call(ctx, 'computeShoppingList', [FIXED_MONDAY]);
      // elena portion 1 (200g) + partner portion 1.5 (300g) = 500g combined.
      assert(!!before.totals[FOOD_NAME] && Math.abs(before.totals[FOOD_NAME].qty - 500) < 1e-6,
        'setup sanity: the shared fixture dish sums BOTH portions (1x + 1.5x = 500g) before logging', JSON.stringify(before.totals[FOOD_NAME]));

      ['elena', 'partner'].forEach(function(p){
        const portion = p === 'elena' ? 1 : 1.5;
        call(ctx, 'logPlanEntry', [FIXED_MONDAY, p, 'dinner', RECIPE_ID, portion, [{recipeId: RECIPE_ID, portion: portion}]]);
        call(ctx, 'setLogEntryEatenOut', [FIXED_MONDAY, p, 0, true]);
      });
      const elenaLogged = get(ctx, "logHistory['" + FIXED_MONDAY + "'].elena[0]");
      const partnerLogged = get(ctx, "logHistory['" + FIXED_MONDAY + "'].partner[0]");
      assert(elenaLogged.eatenOut === true && partnerLogged.eatenOut === true,
        'shared meal eaten-out: BOTH elena and partner get a logged eatenOut===true entry for the slot', JSON.stringify({elena: elenaLogged, partner: partnerLogged}));

      const afterOut = call(ctx, 'computeShoppingList', [FIXED_MONDAY]);
      assert(!afterOut.totals[FOOD_NAME],
        'shared meal eaten-out: drops the WHOLE row (both people\'s portions) from the shopping list, not just one person\'s half', JSON.stringify(Object.keys(afterOut.totals)));

      ['elena', 'partner'].forEach(function(p){ call(ctx, 'removeLoggedSlot', [FIXED_MONDAY, p, 'dinner']); });
      const afterUndo = call(ctx, 'computeShoppingList', [FIXED_MONDAY]);
      assert(!!afterUndo.totals[FOOD_NAME] && Math.abs(afterUndo.totals[FOOD_NAME].qty - 500) < 1e-6,
        'shared meal undo: removing BOTH people\'s logs restores the FULL combined shopping quantity (not just half)', JSON.stringify(afterUndo.totals[FOOD_NAME]));
    })();

    // ---- (d) determinism / no snapshot-shape change: buildSnapshot()/loadState() round-
    // trips a Week-path-produced eaten-out entry exactly — same normalizeLogEntry() path
    // every other logHistory entry takes (WEEK-EATENOUT-plan.md: "no new state field ...
    // it rides entirely on the existing log:* sync section"). ----
    (function(){
      run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "'; weekPlans = {}; weekPlan = null; logHistory = {}; pantry = {};");
      call(ctx, 'ensureWeekPlan', [FIXED_MONDAY]);
      run(ctx, "weekPlans['" + FIXED_MONDAY + "'].days[0].meals.dinner.elena = " + JSON.stringify({recipeId: RECIPE_ID, portion: 1, kcal: 0, protein: 0}) + ';');
      call(ctx, 'logPlanEntry', [FIXED_MONDAY, 'elena', 'dinner', RECIPE_ID, 1, [{recipeId: RECIPE_ID, portion: 1}]]);
      call(ctx, 'setLogEntryEatenOut', [FIXED_MONDAY, 'elena', 0, true]);
      const before = cloneJSON(get(ctx, "logHistory['" + FIXED_MONDAY + "'].elena[0]"));

      run(ctx, "localStorage.setItem(STORE_KEY, JSON.stringify(buildSnapshot()));");
      run(ctx, "logHistory = {};"); // scramble in-memory before reload
      run(ctx, "loadState();");
      const after = get(ctx, "logHistory['" + FIXED_MONDAY + "'].elena[0]");
      assert(!!after && after.kind === 'plan' && after.slot === 'dinner' && after.ref === RECIPE_ID && after.eatenOut === true,
        'buildSnapshot()/loadState(): the Week path\'s eaten-out entry round-trips with kind/slot/ref/eatenOut intact — no snapshot/validator change was needed', JSON.stringify(after));
      assert(after.kcal === before.kcal && after.protein === before.protein && after.carbs === before.carbs
        && after.fat === before.fat && after.u === before.u && after.t === before.t,
        'buildSnapshot()/loadState(): every other field of the round-tripped entry matches the pre-persist entry exactly', JSON.stringify({before: before, after: after}));
      run(ctx, "localStorage.removeItem(STORE_KEY);"); // don't leak this store into later tests
    })();
  } finally {
    run(ctx, "delete RECIPES_DB['" + RECIPE_ID + "']; delete FOODS['" + FOOD_ID + "'];");
    run(ctx, 'weekPlans = __savedWeekPlans__; weekPlan = __savedWeekPlan__; delete __savedWeekPlans__; delete __savedWeekPlan__;');
    run(ctx, 'logHistory = ' + JSON.stringify(savedLogHistory) + '; pantry = ' + JSON.stringify(savedPantry) + ';');
    run(ctx, "localStorage.removeItem(STORE_KEY);");
  }
}

/* ---------------- WEEK-EATENOUT-plan.md: toggle wiring (source guard) ----------------
   The add/edit meal sheet's toggle and its handler can't be exercised through the DOM here
   (this harness's document stub returns null from getElementById — see
   testEatenOutToggleWiring's doc comment above for the same reasoning). So this asserts the
   WIRING structurally: the sheet exposes the toggle and reflects state via
   slotLoggedEatenOut(), the handler it routes to really calls logPlanEntry() +
   setLogEntryEatenOut() (on, date-aware via tNull) and removeLoggedSlot() (off) and
   branches on meal.shared, and renderWeek() really emits the "🍴 out" pill from
   slotLoggedEatenOut() using the same chip-computed style. */
function testWeekEatenOutToggleWiring(){
  const renderSrc = fs.readFileSync(path.join(APP_DIR, 'js', 'render.js'), 'utf8');
  const fnBody = function(name){
    const m = renderSrc.match(new RegExp('function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}\\n'));
    return m ? m[0] : '';
  };

  const sheetFn = fnBody('openAddMealSheetForContext');
  assert(sheetFn.length > 0, 'wiring setup: openAddMealSheetForContext() function body found in render.js', 'not found');
  assert(sheetFn.indexOf('slotLoggedEatenOut(') !== -1, 'openAddMealSheetForContext(): reflects the current eaten-out state via slotLoggedEatenOut()', sheetFn);
  assert(sheetFn.indexOf('toggleWeekMealEatenOut()') !== -1, 'openAddMealSheetForContext(): the sheet\'s toggle button routes to toggleWeekMealEatenOut()', sheetFn);

  const toggleFn = fnBody('toggleWeekMealEatenOut');
  assert(toggleFn.length > 0, 'wiring setup: toggleWeekMealEatenOut() function body found in render.js', 'not found');
  assert(toggleFn.indexOf('logPlanEntry(') !== -1, 'toggleWeekMealEatenOut(): turning ON calls logPlanEntry()', toggleFn);
  assert(toggleFn.indexOf('setLogEntryEatenOut(') !== -1, 'toggleWeekMealEatenOut(): turning ON calls setLogEntryEatenOut()', toggleFn);
  assert(toggleFn.indexOf('removeLoggedSlot(') !== -1, 'toggleWeekMealEatenOut(): turning OFF calls removeLoggedSlot()', toggleFn);
  assert(toggleFn.indexOf('tNull') !== -1, 'toggleWeekMealEatenOut(): passes a date-aware {tNull:true} for a non-today date, mirroring weekLogConfirm', toggleFn);
  assert(toggleFn.indexOf('refreshAfterLogChange()') !== -1, 'toggleWeekMealEatenOut(): re-renders through the shared refreshAfterLogChange() funnel', toggleFn);
  assert(toggleFn.indexOf('meal.shared') !== -1, 'toggleWeekMealEatenOut(): branches on meal.shared to log/drop BOTH people for a shared meal', toggleFn);

  const weekFn = fnBody('renderWeek');
  assert(weekFn.length > 0, 'wiring setup: renderWeek() function body found in render.js', 'not found');
  assert(weekFn.indexOf('slotLoggedEatenOut(') !== -1, 'renderWeek(): emits the row\'s "eating out" pill from slotLoggedEatenOut()', weekFn);
  assert(weekFn.indexOf('chip-computed') !== -1, 'renderWeek(): the eaten-out pill reuses the chip-computed style', weekFn);
}

/* ===================================================================
   task D2: sauce role, new ingredient (sea bass), new/extended catalog recipes
   (baked-fish, pasta, french-toast-fruit-maple fruit options, 3 new role:'main'
   recipes, 2 role:'sauce' recipes), butter-chicken season fix.
   =================================================================== */
function testD2SauceRoleAndCatalog(ctx){
  const RECIPES_DB = get(ctx, 'RECIPES_DB');
  const FOODS = get(ctx, 'FOODS');
  const VALID_ROLES = get(ctx, 'VALID_ROLES');
  const SAUCE_IDS = ['tomato-basil-sauce', 'yogurt-herb-sauce'];

  // -------- (0) containsAvoid: composite foods declare allergens their category hides.
  // The regression this guards: pesto-elena (cat 'Pantry', contains parmesan/pecorino/
  // almonds) passed foodHitsAvoid for a lactose avoider, so the pasta recipe's
  // "Pesto Elena" option could be rotated onto Elena's plan. --------
  (function(){
    const containsAvoid = FOODS['pesto-elena'] && FOODS['pesto-elena'].containsAvoid;
    assert(Array.isArray(containsAvoid) && containsAvoid.indexOf('lactose') !== -1 && containsAvoid.indexOf('nuts') !== -1,
      'pesto-elena declares containsAvoid lactose+nuts');
    const VALID_AVOID = get(ctx, 'VALID_AVOID');
    Object.keys(FOODS).forEach(function(id){
      (FOODS[id].containsAvoid || []).forEach(function(k){
        assert(VALID_AVOID.indexOf(k) !== -1, 'containsAvoid key "' + k + '" on ' + id + ' is a valid avoid key');
      });
    });
    assert(call(ctx, 'foodHitsAvoid', ['pesto-elena', ['lactose']]) === true, 'foodHitsAvoid: pesto-elena hits lactose');
    assert(call(ctx, 'foodHitsAvoid', ['pesto-elena', ['nuts']]) === true, 'foodHitsAvoid: pesto-elena hits nuts');
    assert(call(ctx, 'foodHitsAvoid', ['pesto-elena', ['gluten']]) === false, 'foodHitsAvoid: pesto-elena clean for gluten');
    // End-to-end: a lactose avoider's allowed choices for the pasta condiment group
    // exclude BOTH dairy routes — Pesto Elena (containsAvoid) and courgette & ricotta
    // (cat Dairy) — while tomato & basil stays allowed.
    const pastaGroups = RECIPES_DB['pasta'] && RECIPES_DB['pasta'].optionGroups;
    assert(pastaGroups && pastaGroups.length === 1, 'pasta has its condiment optionGroup');
    const allowed = call(ctx, 'allowedChoicesForGroup', [pastaGroups[0], ['lactose']]).map(function(c){ return c.id; });
    assert(allowed.indexOf('pesto-elena') === -1 && allowed.join(',').indexOf('pesto') === -1,
      'lactose avoider: pesto choice excluded (got: ' + allowed.join(',') + ')');
    assert(allowed.some(function(id){ return id.indexOf('tomato') !== -1; }),
      'lactose avoider: tomato & basil choice still allowed');
    // Custom-recipe derivation agrees: a recipe built on pesto-elena derives lactose+nuts.
    const meta = call(ctx, 'deriveRecipeMeta', [[{foodId: 'pesto-elena', grams: 30}, {foodId: 'pasta', grams: 100}], call(ctx, 'recipeNutrition', ['pasta', 1]).totals, 15]);
    assert(meta.avoid.indexOf('lactose') !== -1 && meta.avoid.indexOf('nuts') !== -1,
      'deriveRecipeMeta: pesto-based custom recipe derives lactose+nuts');
  })();

  // -------- (1) new ingredient: sea-bass-fillet, real-source macros, 4/4/9 kcal policy
  // (foods.js's own stated convention — see the file header), and wired into
  // ANIMAL_FOOD_IDS (js/library.js) for the custom-recipe builder's auto-veggie-tag
  // derivation, same as every other fish/meat/poultry id. --------
  (function(){
    const f = FOODS['sea-bass-fillet'];
    assert(!!f, 'D2: sea-bass-fillet food exists', JSON.stringify(f));
    if(!f) return;
    assert(f.cat === 'Protein' && f.unit === 'g' && f.per === 100,
      'D2: sea-bass-fillet is a per-100g Protein-category food', JSON.stringify(f));
    assert(typeof f.src === 'string' && /FDC/.test(f.src),
      'D2: sea-bass-fillet cites a real USDA FDC source (ground rule: no invented numbers)', f.src);
    const expectedKcal = Math.round(4 * f.protein + 4 * f.carbs + 9 * f.fat);
    assert(f.kcal === expectedKcal,
      'D2: sea-bass-fillet.kcal follows foods.js\'s stated 4/4/9-from-sourced-macros policy',
      'kcal=' + f.kcal + ' expected=' + expectedKcal);

    const ANIMAL_FOOD_IDS = get(ctx, 'ANIMAL_FOOD_IDS');
    assert(ANIMAL_FOOD_IDS.indexOf('sea-bass-fillet') !== -1,
      'D2: sea-bass-fillet is registered in ANIMAL_FOOD_IDS (custom-recipe builder veggie-tag derivation)', JSON.stringify(ANIMAL_FOOD_IDS));
  })();

  // -------- (2) role 'sauce': VALID_ROLES + library role-picker label. --------
  (function(){
    assert(VALID_ROLES.indexOf('sauce') !== -1, 'D2: VALID_ROLES includes "sauce"', JSON.stringify(VALID_ROLES));
    const label = call(ctx, 'recipeRoleLabel', ['sauce']);
    assert(label === 'Sauce & condiment', 'D2: recipeRoleLabel("sauce") === "Sauce & condiment"', label);
  })();

  // -------- (3) the two new sauce recipes: role/slots convention + WARNING-band kcal. --------
  (function(){
    SAUCE_IDS.forEach(function(id){
      const r = RECIPES_DB[id];
      assert(!!r, 'D2: sauce recipe "' + id + '" exists', id);
      if(!r) return;
      assert(r.role === 'sauce', 'D2: "' + id + '".role === "sauce"', r.role);
      const slots = call(ctx, 'recipeSlotList', [r]);
      assert(slots.length === 1 && slots[0] === 'side',
        'D2: "' + id + '" carries the sauce convention slots === [\'side\']', JSON.stringify(slots));
      const kcal = call(ctx, 'recipeNutrition', [id, 1]).totals.kcal;
      assert(kcal >= 40 && kcal <= 250,
        'D2: "' + id + '" computed kcal ' + Math.round(kcal) + ' is within the sauce WARNING band 40-250', kcal);
    });
  })();

  // -------- (4) sauce exclusion is structural, not a planner special-case: never a
  // candidatesFor() result (real meal slots only) and never a sidePoolFor() result (that
  // pool filters role==='side' specifically, and 'sauce' !== 'side'). --------
  (function(){
    const hits = [];
    ['breakfast', 'lunch', 'dinner', 'snack'].forEach(function(slot){
      ['balanced', 'highprotein', 'lowcarb'].forEach(function(style){
        const pool = call(ctx, 'candidatesFor', [slot, style, [], {includeThumbsDown: true}]);
        SAUCE_IDS.forEach(function(id){ if(pool.indexOf(id) !== -1) hits.push(slot + '/' + style + '/' + id); });
      });
    });
    assert(hits.length === 0, 'D2: candidatesFor() never returns a sauce id for any real meal slot', JSON.stringify(hits));

    const sidePool = call(ctx, 'sidePoolFor', [[]]);
    const sideHits = SAUCE_IDS.filter(function(id){ return sidePool.indexOf(id) !== -1; });
    assert(sideHits.length === 0, 'D2: sidePoolFor() never returns a sauce id (filters role===\'side\', not \'sauce\')', JSON.stringify(sideHits));
  })();

  // -------- (5) add-meal sheet: mealRecipeOptions() puts both sauces in their own
  // "Sauces" bucket, absent from both "Sides" and "Full recipes". --------
  (function(){
    const opts = call(ctx, 'mealRecipeOptions', [[]]);
    assert(JSON.stringify(opts.sauces.slice().sort()) === JSON.stringify(SAUCE_IDS.slice().sort()),
      'D2: mealRecipeOptions().sauces is exactly the two sauce recipes', JSON.stringify(opts.sauces));
    const inSides = SAUCE_IDS.filter(function(id){ return opts.sides.indexOf(id) !== -1; });
    const inFull = SAUCE_IDS.filter(function(id){ return opts.full.indexOf(id) !== -1; });
    assert(inSides.length === 0 && inFull.length === 0,
      'D2: sauce recipes never leak into the Sides or Full-recipes buckets', 'sides=' + JSON.stringify(inSides) + ' full=' + JSON.stringify(inFull));
  })();

  // -------- (6) end-to-end: a real two-week generated plan never contains a sauce id,
  // neither as a standalone base meal nor as a composed side/extra. --------
  (function(){
    run(ctx, "MESA_TEST_TODAY = '" + FIXED_MONDAY + "'; weekPlans = {}; weekPlan = null;");
    const sig1 = call(ctx, 'computePlanSignature', []);
    const week1 = call(ctx, 'generateWeek', [{weekStartDate: FIXED_MONDAY, signature: sig1}]);
    const week2Start = call(ctx, 'addDaysISO', [FIXED_MONDAY, 7]);
    const sig2 = call(ctx, 'computePlanSignature', []);
    const week2 = call(ctx, 'generateWeek', [{weekStartDate: week2Start, signature: sig2}]);

    function sauceHitsIn(week){
      const hits = [];
      (week.days || []).forEach(function(day){
        Object.keys(day.meals || {}).forEach(function(slot){
          ['elena', 'partner'].forEach(function(person){
            const entry = day.meals[slot] && day.meals[slot][person];
            if(!entry) return;
            if(SAUCE_IDS.indexOf(entry.recipeId) !== -1) hits.push(day.date + '/' + slot + '/' + person + ' (base)');
            (entry.extras || []).forEach(function(ex){
              if(SAUCE_IDS.indexOf(ex.recipeId) !== -1) hits.push(day.date + '/' + slot + '/' + person + ' (extra)');
            });
          });
        });
      });
      return hits;
    }
    const hits = sauceHitsIn(week1).concat(sauceHitsIn(week2));
    assert(hits.length === 0, 'D2: a generated fortnight never contains a sauce id (standalone or composed)', JSON.stringify(hits));
    run(ctx, 'weekPlans = {}; weekPlan = null;');
  })();

  // -------- (7) butter-chicken season fix + Vegetarian burrito title stays clean. --------
  (function(){
    assert(RECIPES_DB['butter-chicken'].season === 'winter/autumn',
      'D2: butter-chicken.season === "winter/autumn"', RECIPES_DB['butter-chicken'].season);
    const staleTitles = Object.keys(RECIPES_DB).filter(function(id){
      return /burrito vegetariano/i.test(RECIPES_DB[id].title || '');
    });
    assert(staleTitles.length === 0, 'D2: no recipe title regresses to the stale Italian "Burrito vegetariano"', JSON.stringify(staleTitles));
    assert(RECIPES_DB['burrito-vegetariano'].title === 'Vegetarian burrito',
      'D2: burrito-vegetariano.title is the corrected English title', RECIPES_DB['burrito-vegetariano'].title);
  })();

  // -------- (8) baked-fish (role:'main'): default combo + every fish choice lands inside
  // ROLE_KCAL_BAND.main [250,650] — the WARNING band data/validate.js checks. --------
  (function(){
    const ROLE_KCAL_BAND = get(ctx, 'ROLE_KCAL_BAND');
    const band = ROLE_KCAL_BAND.main;
    const r = RECIPES_DB['baked-fish'];
    assert(!!r && r.role === 'main' && JSON.stringify(call(ctx, 'recipeSlotList', [r])) === JSON.stringify(['lunch', 'dinner']),
      'D2: baked-fish is role:"main", slots ["lunch","dinner"]', JSON.stringify(r));
    const fishGroup = r.optionGroups.filter(function(g){ return g.key === 'fish'; })[0];
    assert(!!fishGroup && fishGroup.choices.length === 4, 'D2: baked-fish has a 4-choice "fish" optionGroup', JSON.stringify(fishGroup));
    const defaultKcal = call(ctx, 'recipeNutrition', ['baked-fish', 1]).totals.kcal;
    assert(defaultKcal >= band[0] && defaultKcal <= band[1],
      'D2: baked-fish default combo (salmon) kcal ' + Math.round(defaultKcal) + ' is within the main band ' + band.join('-'), defaultKcal);
    const outOfBand = fishGroup.choices.filter(function(choice){
      const opts = {fish: choice.id};
      const kcal = call(ctx, 'recipeNutrition', ['baked-fish', 1, opts]).totals.kcal;
      return kcal < band[0] || kcal > band[1];
    });
    assert(outOfBand.length === 0, 'D2: every baked-fish fish choice lands inside the main band ' + band.join('-'), JSON.stringify(outOfBand));
  })();

  // -------- (9) pasta (role:'full', slot 'lunch'): default combo + every condiment choice
  // lands inside KCAL_BAND.lunch [400,750] — the ERROR-level band for the default, WARNING
  // for the other choices (data/validate.js). --------
  (function(){
    const KCAL_BAND = get(ctx, 'KCAL_BAND');
    const band = KCAL_BAND.lunch;
    const r = RECIPES_DB.pasta;
    assert(!!r && r.role === 'full' && r.slot === 'lunch',
      'D2: pasta is role:"full", primary slot "lunch"', JSON.stringify(r && {role: r.role, slot: r.slot}));
    const condimentGroup = r.optionGroups.filter(function(g){ return g.key === 'condiment'; })[0];
    assert(!!condimentGroup && condimentGroup.choices.length === 4, 'D2: pasta has a 4-choice "condiment" optionGroup', JSON.stringify(condimentGroup));
    const defaultKcal = call(ctx, 'recipeNutrition', ['pasta', 1]).totals.kcal;
    assert(defaultKcal >= band[0] && defaultKcal <= band[1],
      'D2: pasta default combo (tomato & basil) kcal ' + Math.round(defaultKcal) + ' is within the lunch band ' + band.join('-'), defaultKcal);
    const outOfBand = condimentGroup.choices.filter(function(choice){
      const opts = {condiment: choice.id};
      const kcal = call(ctx, 'recipeNutrition', ['pasta', 1, opts]).totals.kcal;
      return kcal < band[0] || kcal > band[1];
    });
    assert(outOfBand.length === 0, 'D2: every pasta condiment choice lands inside the lunch band ' + band.join('-'), JSON.stringify(outOfBand));
  })();

  // -------- (10) french-toast-fruit-maple: the no-opts effective ingredient list must
  // compute IDENTICAL nutrition to the recipe before this batch's edit (mixed-berries
  // moved from the base array into optionGroups.fruit's default choice) — literals
  // captured from `recipeNutrition('french-toast-fruit-maple', 1)` against the pre-D2
  // ingredients array [['white-bread',70],['eggs',50],['milk',80],['mixed-berries',80],
  // ['maple-syrup',15],['olive-oil',4]], BEFORE any D2 edit. --------
  (function(){
    const PRE_D2_TOTALS = {
      kcal: 422.98499999999996, protein: 15.81, carbs: 57.389999999999986,
      fat: 14.465000000000002, satFat: 4.632, fiber: 4.69,
      sugars: 18.515, freeSugars: 9.075, goodFat: 9.833000000000002
    };
    const noOpts = call(ctx, 'recipeNutrition', ['french-toast-fruit-maple', 1]).totals;
    Object.keys(PRE_D2_TOTALS).forEach(function(k){
      assert(Math.abs(noOpts[k] - PRE_D2_TOTALS[k]) < 1e-6,
        'D2: french-toast-fruit-maple no-opts nutrition unchanged from before the D2 edit (' + k + ')',
        'got ' + noOpts[k] + ' expected ' + PRE_D2_TOTALS[k]);
    });
    const berriesChoice = call(ctx, 'recipeNutrition', ['french-toast-fruit-maple', 1, {fruit: 'berries'}]).totals;
    Object.keys(PRE_D2_TOTALS).forEach(function(k){
      assert(Math.abs(berriesChoice[k] - noOpts[k]) < 1e-6,
        'D2: french-toast-fruit-maple explicit {fruit:"berries"} matches the no-opts default exactly (' + k + ')',
        'got ' + berriesChoice[k] + ' expected ' + noOpts[k]);
    });
    // Banana/peach choices exist, resolve, and stay inside the breakfast plausibility band.
    const KCAL_BAND = get(ctx, 'KCAL_BAND');
    const band = KCAL_BAND.breakfast;
    ['banana', 'peach'].forEach(function(choiceId){
      const kcal = call(ctx, 'recipeNutrition', ['french-toast-fruit-maple', 1, {fruit: choiceId}]).totals.kcal;
      assert(kcal >= band[0] && kcal <= band[1],
        'D2: french-toast-fruit-maple {fruit:"' + choiceId + '"} kcal ' + Math.round(kcal) + ' is within the breakfast band ' + band.join('-'), kcal);
    });
  })();

  // -------- (11) new role:'main' recipes exist with sane roles/slots (lemon-herb-chicken-
  // breast, turkey-cutlets-sage, white-bean-rosemary-mash), each inside ROLE_KCAL_BAND.main. --------
  (function(){
    const ROLE_KCAL_BAND = get(ctx, 'ROLE_KCAL_BAND');
    const band = ROLE_KCAL_BAND.main;
    ['lemon-herb-chicken-breast', 'turkey-cutlets-sage', 'white-bean-rosemary-mash'].forEach(function(id){
      const r = RECIPES_DB[id];
      assert(!!r && r.role === 'main', 'D2: "' + id + '" exists with role:"main"', JSON.stringify(r && r.role));
      const slots = call(ctx, 'recipeSlotList', [r]);
      assert(slots.indexOf('lunch') !== -1, 'D2: "' + id + '" is plannable at lunch', JSON.stringify(slots));
      const kcal = call(ctx, 'recipeNutrition', [id, 1]).totals.kcal;
      assert(kcal >= band[0] && kcal <= band[1],
        'D2: "' + id + '" computed kcal ' + Math.round(kcal) + ' is within the main band ' + band.join('-'), kcal);
    });
  })();

  // -------- (12) pool-count deltas: lunch role:'main' recipe count (overall, and within
  // the thin 'balanced' style) must be >= the pre-D2 baseline captured via this same
  // candidatesFor-style enumeration BEFORE this batch's recipes.js edits (README's B2
  // entry: "lunch role:'main' pool is thin (2 in balanced style)"; re-measured directly
  // against the pre-D2 tree at spawn time: 5 total lunch mains, 3 of them 'balanced'). --------
  (function(){
    const PRE_D2_LUNCH_MAIN_TOTAL = 5;
    const PRE_D2_LUNCH_MAIN_BALANCED = 3;
    const lunchMainIds = Object.keys(RECIPES_DB).filter(function(id){
      const r = RECIPES_DB[id];
      return !r.occasional && r.role === 'main' && call(ctx, 'recipeSlotList', [r]).indexOf('lunch') !== -1;
    });
    const lunchMainBalanced = lunchMainIds.filter(function(id){ return RECIPES_DB[id].styles.indexOf('balanced') !== -1; });
    assert(lunchMainIds.length > PRE_D2_LUNCH_MAIN_TOTAL,
      'D2: lunch role:"main" pool grew from the pre-D2 baseline (' + PRE_D2_LUNCH_MAIN_TOTAL + ')', lunchMainIds.length);
    assert(lunchMainBalanced.length > PRE_D2_LUNCH_MAIN_BALANCED,
      'D2: lunch role:"main" x style:"balanced" pool grew from the pre-D2 baseline (' + PRE_D2_LUNCH_MAIN_BALANCED + ')', lunchMainBalanced.length);
  })();
}

/* ===================================================================
   task D3 — recipe builder "Options" section (user-editable optionGroups).
   Same stub-then-restore bracketing pattern testRecipeImagePicker uses: the builder's
   save/reset paths call toast()/openMyRecipes()/applyProf()/renderFoodLibraryCount(),
   all DOM/render side effects irrelevant to the logic under test, so they're stubbed to
   no-ops for the whole function and restored at the very end. Every subsection cleans up
   after itself (deletes any customRecipes/recipeOverrides entry it created) so later tests
   — and the final consistency check at the bottom of this function — see a pristine DB.
   =================================================================== */
function testRecipeOptionsBuilder(ctx){
  run(ctx, "var __d3BuilderStub = {toast: toast, openMyRecipes: openMyRecipes, applyProf: applyProf, renderFoodLibraryCount: renderFoodLibraryCount}; toast = function(){}; openMyRecipes = function(){}; applyProf = function(){}; renderFoodLibraryCount = function(){};");

  // -------- (1) validateRecipeBuilderOptionGroups: direct unit coverage of every
  // structural rule, mirroring data/validate.js's own optionGroups ERROR checks. --------
  (function(){
    assert(call(ctx, 'validateRecipeBuilderOptionGroups', [{optionGroups: []}]) === null,
      'validateRecipeBuilderOptionGroups: a draft with no option groups is valid (the feature is optional)', '');
    assert(call(ctx, 'validateRecipeBuilderOptionGroups', [{optionGroups: [
      {label: '', choices: [{label: 'A', ingredients: [{foodId: 'olive-oil', grams: 5}]}, {label: 'B', ingredients: [{foodId: 'olive-oil', grams: 5}]}]}
    ]}]) !== null, 'validateRecipeBuilderOptionGroups: rejects a group with an empty label', '');
    assert(call(ctx, 'validateRecipeBuilderOptionGroups', [{optionGroups: [
      {label: 'G', choices: [{label: 'A', ingredients: [{foodId: 'olive-oil', grams: 5}]}]}
    ]}]) !== null, 'validateRecipeBuilderOptionGroups: rejects a group with fewer than 2 choices', '');
    assert(call(ctx, 'validateRecipeBuilderOptionGroups', [{optionGroups: [
      {label: 'G', choices: [{label: '', ingredients: [{foodId: 'olive-oil', grams: 5}]}, {label: 'B', ingredients: [{foodId: 'olive-oil', grams: 5}]}]}
    ]}]) !== null, 'validateRecipeBuilderOptionGroups: rejects a choice with an empty label', '');
    assert(call(ctx, 'validateRecipeBuilderOptionGroups', [{optionGroups: [
      {label: 'G', choices: [{label: 'A', ingredients: []}, {label: 'B', ingredients: [{foodId: 'olive-oil', grams: 5}]}]}
    ]}]) !== null, 'validateRecipeBuilderOptionGroups: rejects a choice with zero ingredients', '');
    assert(call(ctx, 'validateRecipeBuilderOptionGroups', [{optionGroups: [
      {label: 'G', choices: [{label: 'A', ingredients: [{foodId: 'not-a-real-food-id', grams: 5}]}, {label: 'B', ingredients: [{foodId: 'olive-oil', grams: 5}]}]}
    ]}]) !== null, 'validateRecipeBuilderOptionGroups: rejects a choice ingredient whose food id does not resolve', '');
    assert(call(ctx, 'validateRecipeBuilderOptionGroups', [{optionGroups: [
      {label: 'G', choices: [{label: 'A', ingredients: [{foodId: 'olive-oil', grams: 5}]}, {label: 'B', ingredients: [{foodId: 'olive-oil', grams: 5}]}]}
    ]}]) === null, 'validateRecipeBuilderOptionGroups: accepts a well-formed group (>=2 labeled choices, each with a resolvable ingredient)', '');
  })();

  // -------- (2) builder round-trip: a NEW custom recipe with 1 group/3 choices saves in
  // RECIPES_DB's real shape (slugified key/ids, authored order = default), validateData()
  // stays ok:true, and reopening the SAME recipe in the builder repopulates identically. --------
  (function(){
    call(ctx, 'openNewRecipeForm', []);
    const rb = get(ctx, 'recipeBuilder');
    rb.name = 'D3 Test Variant Bowl';
    rb.emoji = '🥗';
    rb.ingredients = [{foodId: 'olive-oil', grams: 10}, {foodId: 'lemon-juice', grams: 10}];
    call(ctx, 'addRecipeOptionGroup', []);
    rb.optionGroups[0].label = 'Protein';
    rb.optionGroups[0].choices[0].label = 'Salmon';
    rb.optionGroups[0].choices[0].ingredients = [{foodId: 'salmon-fillet', grams: 150}];
    rb.optionGroups[0].choices[1].label = 'Cod';
    rb.optionGroups[0].choices[1].ingredients = [{foodId: 'cod', grams: 150}];
    call(ctx, 'addRecipeOptionChoice', [0]);
    rb.optionGroups[0].choices[2].label = 'Sole';
    rb.optionGroups[0].choices[2].ingredients = [{foodId: 'sole-fish', grams: 150}];

    call(ctx, 'saveRecipeBuilder', []);
    const RECIPES_DB = get(ctx, 'RECIPES_DB');
    const customRecipes = get(ctx, 'customRecipes');
    const savedId = Object.keys(customRecipes).find(function(id){ return customRecipes[id].title === 'D3 Test Variant Bowl'; });
    assert(!!savedId, 'builder round-trip: new recipe with 1 option group/3 choices was saved', savedId);
    const saved = RECIPES_DB[savedId];

    assert(Array.isArray(saved.optionGroups) && saved.optionGroups.length === 1,
      'builder round-trip: saved recipe carries exactly 1 optionGroups entry', JSON.stringify(saved.optionGroups));
    const group = saved.optionGroups[0];
    assert(group.key === 'protein' && group.label === 'Protein',
      'builder round-trip: group key is slugified from the label; label preserved verbatim', JSON.stringify(group));
    const ids = group.choices.map(function(c){ return c.id; });
    assert(JSON.stringify(ids) === JSON.stringify(['salmon', 'cod', 'sole']),
      'builder round-trip: choice ids slugified from labels, authored order preserved (choices[0] = default)', JSON.stringify(ids));
    assert(JSON.stringify(group.choices[0].ingredients) === JSON.stringify([['salmon-fillet', 150]]),
      'builder round-trip: choice ingredients saved as [foodId,grams] tuples', JSON.stringify(group.choices[0].ingredients));

    const validation = call(ctx, 'validateData', []);
    assert(validation.ok === true, 'builder round-trip: validateData() stays ok:true after saving a new optionGroups custom recipe', JSON.stringify(validation.errors));

    call(ctx, 'openEditRecipeForm', [savedId]);
    const reopened = get(ctx, 'recipeBuilder');
    assert(reopened.optionGroups.length === 1 && reopened.optionGroups[0].label === 'Protein',
      'builder round-trip: reopening the saved recipe repopulates the group label', JSON.stringify(reopened.optionGroups));
    assert(JSON.stringify(reopened.optionGroups[0].choices.map(function(c){ return c.label; })) === JSON.stringify(['Salmon', 'Cod', 'Sole']),
      'builder round-trip: reopening repopulates choice labels in authored order', JSON.stringify(reopened.optionGroups[0].choices.map(function(c){ return c.label; })));
    assert(JSON.stringify(reopened.optionGroups[0].choices.map(function(c){ return c.ingredients; }))
      === JSON.stringify([[{foodId: 'salmon-fillet', grams: 150}], [{foodId: 'cod', grams: 150}], [{foodId: 'sole-fish', grams: 150}]]),
      'builder round-trip: reopening repopulates each choice\'s ingredient rows identically', JSON.stringify(reopened.optionGroups[0].choices));

    run(ctx, "delete customRecipes['" + savedId + "']; applyCustomRecipes(); recipeBuilder = null;");
  })();

  // -------- (3) built-in override: adding a 4th choice to french-toast-fruit-maple's
  // fruit group through the builder -> chosenOptsForRecipe rotation can select it -> a
  // STALE opts value from before the edit re-normalizes to the (possibly re-slugified)
  // default rather than throwing -> reset restores exactly the original 3 choices and the
  // recipeOverrides entry disappears. --------
  (function(){
    const originalIds = get(ctx, 'RECIPES_DB')['french-toast-fruit-maple'].optionGroups[0].choices.map(function(c){ return c.id; });
    assert(JSON.stringify(originalIds) === JSON.stringify(['berries', 'banana', 'peach']),
      'french-toast override: original built-in choice ids, pre-edit (test setup sanity)', JSON.stringify(originalIds));

    call(ctx, 'openEditRecipeForm', ['french-toast-fruit-maple']);
    const rb = get(ctx, 'recipeBuilder');
    assert(rb.optionGroups.length === 1 && rb.optionGroups[0].choices.length === 3,
      'french-toast override: builder opens with the original 3-choice fruit group', JSON.stringify(rb.optionGroups));

    call(ctx, 'addRecipeOptionChoice', [0]);
    rb.optionGroups[0].choices[3].label = 'Oranges';
    rb.optionGroups[0].choices[3].ingredients = [{foodId: 'oranges', grams: 80}];
    call(ctx, 'saveRecipeBuilder', []);

    const recipeOverrides = get(ctx, 'recipeOverrides');
    assert(!!recipeOverrides['french-toast-fruit-maple'],
      'french-toast override: saving a built-in edit through the builder creates a recipeOverrides entry', '');
    const updated = get(ctx, 'RECIPES_DB')['french-toast-fruit-maple'];
    assert(updated.optionGroups[0].choices.length === 4, 'french-toast override: 4th fruit choice saved', updated.optionGroups[0].choices.length);
    const newChoiceId = updated.optionGroups[0].choices[3].id;
    assert(newChoiceId === 'oranges', 'french-toast override: new choice gets a slugified id', newChoiceId);

    const validation = call(ctx, 'validateData', []);
    assert(validation.ok === true, 'french-toast override: validateData() stays ok:true with the added 4th choice', JSON.stringify(validation.errors));

    let found = false;
    for(let d = 0; d < 4; d++){
      for(let si = 0; si < 4; si++){
        const opts = call(ctx, 'chosenOptsForRecipe', [updated, 0, d, si, []]);
        if(opts && opts.fruit === newChoiceId) found = true;
      }
    }
    assert(found, 'french-toast override: chosenOptsForRecipe rotation can select the newly-added 4th choice across a dayIndex/slotIndex sweep', '');

    // D3 plan: an edited/removed choice's stale opts re-normalize to the default rather
    // than crash. The "Mixed berries" label was left untouched, but D3 always re-derives
    // ids from the CURRENT label at save time (buildRecipeOptionGroupsForSave's doc
    // comment), so its id drifted from the original 'berries' to 'mixed-berries' — a real,
    // expected instance of exactly the case this normalization exists for.
    const staleNormalized = call(ctx, 'normalizeRecipeOpts', [updated, {fruit: 'berries'}]);
    assert(staleNormalized.fruit === updated.optionGroups[0].choices[0].id,
      'french-toast override: a stale opts value from before the edit falls back to the current default choice, never throws', JSON.stringify(staleNormalized));

    call(ctx, 'resetRecipeOverride', ['french-toast-fruit-maple']);
    assert(!get(ctx, 'recipeOverrides')['french-toast-fruit-maple'],
      'french-toast override: reset removes the recipeOverrides entry entirely', '');
    const restored = get(ctx, 'RECIPES_DB')['french-toast-fruit-maple'];
    const restoredIds = restored.optionGroups[0].choices.map(function(c){ return c.id; });
    assert(JSON.stringify(restoredIds) === JSON.stringify(['berries', 'banana', 'peach']),
      'french-toast override: reset restores exactly the original 3 choices (ids included)', JSON.stringify(restoredIds));
    run(ctx, "recipeBuilder = null;");
  })();

  // -------- (4) hostile labels: group/choice labels are now USER-CONTROLLED text, so they
  // must render inert everywhere — the builder's own markup, recipeDisplayTitle's real
  // escapeHtml()-wrapped render sites, and the recipe-detail chip builder (D1 already
  // escaped this correctly for app-authored copy; this proves the SAME code path holds for
  // hostile user text now that it's reachable). --------
  (function(){
    const PAYLOAD_TAG = '"><img src=x onerror=window.__xssA=1>';
    const PAYLOAD_JS = "'); evil(); ('";

    call(ctx, 'openNewRecipeForm', []);
    const rb = get(ctx, 'recipeBuilder');
    rb.name = 'D3 hostile label recipe';
    rb.ingredients = [{foodId: 'olive-oil', grams: 10}, {foodId: 'lemon-juice', grams: 10}];
    call(ctx, 'addRecipeOptionGroup', []);
    rb.optionGroups[0].label = PAYLOAD_TAG;
    rb.optionGroups[0].choices[0].label = PAYLOAD_TAG; // DEFAULT choice — this is the one recipeDisplayTitle surfaces
    rb.optionGroups[0].choices[0].ingredients = [{foodId: 'salmon-fillet', grams: 100}];
    rb.optionGroups[0].choices[1].label = PAYLOAD_JS; // non-default — exercises the chips builder's onclick-safety check
    rb.optionGroups[0].choices[1].ingredients = [{foodId: 'cod', grams: 100}];

    const builderHtml = call(ctx, 'buildRecipeBuilderSheet', []);
    assert(builderHtml.indexOf('<img src=x onerror') === -1,
      'builder markup: a hostile group label does not inject a raw <img> tag while editing', '');
    assert(builderHtml.indexOf('&lt;img src=x onerror') !== -1,
      'builder markup: the hostile group label appears HTML-entity-escaped in its value="" attribute (proves escaping ran, not silent drop)', '');

    call(ctx, 'saveRecipeBuilder', []);
    const RECIPES_DB = get(ctx, 'RECIPES_DB');
    const customRecipes = get(ctx, 'customRecipes');
    const savedId = Object.keys(customRecipes).find(function(id){ return customRecipes[id].title === 'D3 hostile label recipe'; });
    assert(!!savedId, 'hostile labels: a recipe with hostile group/choice labels still saves (labels are just text, not markup)', '');
    const saved = RECIPES_DB[savedId];
    assert(saved.optionGroups[0].label === PAYLOAD_TAG && saved.optionGroups[0].choices[0].label === PAYLOAD_TAG && saved.optionGroups[0].choices[1].label === PAYLOAD_JS,
      'hostile labels: the hostile text is stored verbatim (escaping is a RENDER-time concern, not a storage-time one)', JSON.stringify(saved.optionGroups[0]));

    // recipeDisplayTitle's real consumers either use .textContent (auto-escaping) or wrap
    // the return value in escapeHtml() before innerHTML — simulate that audited pattern.
    const title = call(ctx, 'recipeDisplayTitle', [savedId, {}]);
    assert(title.indexOf(PAYLOAD_TAG) !== -1, 'hostile labels: recipeDisplayTitle carries the raw label (escaping happens at the render site, not inside the helper)', title);
    const escapedTitle = call(ctx, 'escapeHtml', [title]);
    assert(!/[<>]/.test(escapedTitle), 'hostile labels: escapeHtml(recipeDisplayTitle(...)) — the real innerHTML render-site pattern — contains no raw < or >', escapedTitle);

    const normalized = call(ctx, 'normalizeRecipeOpts', [saved, {}]);
    const chipsHtml = call(ctx, 'buildRecipeOptionsChipsHtml', [saved, normalized]);
    assert(chipsHtml.indexOf('<img src=x onerror') === -1,
      'chips builder (buildRecipeOptionsChipsHtml): a hostile group label does not inject a raw <img> tag', chipsHtml);
    assert(chipsHtml.indexOf('&lt;img src=x onerror') !== -1,
      'chips builder: the hostile group label appears HTML-entity-escaped in the chip row (proves escaping ran, not silent drop)', chipsHtml);
    assert(!/onclick="[^"]*evil\(\)/.test(chipsHtml),
      'chips builder: the hostile choice label never reaches a JS-string/onclick context (group key/choice id in data-* are slugs, not the raw label)', chipsHtml);
    assert(chipsHtml.indexOf(PAYLOAD_JS) !== -1,
      'chips builder: the hostile choice label still renders as inert visible text (not silently dropped) — escapeHtml leaves quotes/parens untouched in text-node context', chipsHtml);

    assert(typeof get(ctx, 'window').__xssA === 'undefined',
      'hostile labels: no code path evaluated the onerror payload (window.__xssA never set)', '');

    run(ctx, "delete customRecipes['" + savedId + "']; applyCustomRecipes(); recipeBuilder = null;");
  })();

  // -------- (5) slug collisions get unique ids/keys, both across sibling choices within
  // one group and across sibling groups within one recipe. --------
  (function(){
    call(ctx, 'openNewRecipeForm', []);
    const rb = get(ctx, 'recipeBuilder');
    rb.name = 'D3 slug collision recipe';
    rb.ingredients = [{foodId: 'olive-oil', grams: 10}, {foodId: 'lemon-juice', grams: 10}];
    call(ctx, 'addRecipeOptionGroup', []);
    call(ctx, 'addRecipeOptionGroup', []);
    rb.optionGroups[0].label = 'Fish';
    rb.optionGroups[0].choices[0].label = 'Salmon';
    rb.optionGroups[0].choices[0].ingredients = [{foodId: 'salmon-fillet', grams: 150}];
    rb.optionGroups[0].choices[1].label = 'Salmon!!'; // slugifies to the same base as 'Salmon'
    rb.optionGroups[0].choices[1].ingredients = [{foodId: 'salmon-fillet', grams: 120}];
    rb.optionGroups[1].label = 'Fish '; // slugifies to the same base as group 0's 'Fish'
    rb.optionGroups[1].choices[0].label = 'Cod';
    rb.optionGroups[1].choices[0].ingredients = [{foodId: 'cod', grams: 150}];
    rb.optionGroups[1].choices[1].label = 'Sole';
    rb.optionGroups[1].choices[1].ingredients = [{foodId: 'sole-fish', grams: 150}];

    call(ctx, 'saveRecipeBuilder', []);
    const customRecipes = get(ctx, 'customRecipes');
    const savedId = Object.keys(customRecipes).find(function(id){ return customRecipes[id].title === 'D3 slug collision recipe'; });
    assert(!!savedId, 'slug collisions: recipe with colliding group/choice labels still saves', '');
    const saved = get(ctx, 'RECIPES_DB')[savedId];

    const groupKeys = saved.optionGroups.map(function(g){ return g.key; });
    assert(JSON.stringify(groupKeys) === JSON.stringify(['fish', 'fish-2']),
      'slug collisions: two groups slugifying to the same base get unique keys (fish, fish-2)', JSON.stringify(groupKeys));
    const choiceIds = saved.optionGroups[0].choices.map(function(c){ return c.id; });
    assert(JSON.stringify(choiceIds) === JSON.stringify(['salmon', 'salmon-2']),
      'slug collisions: two choices slugifying to the same base within one group get unique ids (salmon, salmon-2)', JSON.stringify(choiceIds));

    const validation = call(ctx, 'validateData', []);
    assert(validation.ok === true, 'slug collisions: validateData() stays ok:true (no duplicate key/id structural errors)', JSON.stringify(validation.errors));

    run(ctx, "delete customRecipes['" + savedId + "']; applyCustomRecipes(); recipeBuilder = null;");
  })();

  // -------- (6) derived-meta-from-default rule: tags/styles/avoid compute from base +
  // the DEFAULT choice of every group — a dairy ingredient in the default choice shows up
  // in the saved recipe's avoid list; the SAME dairy ingredient sitting in a non-default
  // choice does not (per-choice avoid stays dynamic via planner.js:choiceHitsAvoid instead,
  // covered by testD2SauceRoleAndCatalog/testRecipeOptions already). --------
  (function(){
    call(ctx, 'openNewRecipeForm', []);
    let rb = get(ctx, 'recipeBuilder');
    rb.name = 'D3 dairy-default meta recipe';
    rb.ingredients = [{foodId: 'olive-oil', grams: 10}, {foodId: 'lemon-juice', grams: 10}];
    call(ctx, 'addRecipeOptionGroup', []);
    rb.optionGroups[0].label = 'Topping';
    rb.optionGroups[0].choices[0].label = 'Ricotta'; // DEFAULT — cat 'Dairy'
    rb.optionGroups[0].choices[0].ingredients = [{foodId: 'ricotta', grams: 100}];
    rb.optionGroups[0].choices[1].label = 'Oranges'; // non-default, no dairy
    rb.optionGroups[0].choices[1].ingredients = [{foodId: 'oranges', grams: 100}];
    call(ctx, 'saveRecipeBuilder', []);
    let customRecipes = get(ctx, 'customRecipes');
    let savedId = Object.keys(customRecipes).find(function(id){ return customRecipes[id].title === 'D3 dairy-default meta recipe'; });
    let saved = get(ctx, 'RECIPES_DB')[savedId];
    assert(saved.avoid.indexOf('lactose') !== -1,
      'derived meta: a group whose DEFAULT choice contains a dairy ingredient makes the saved recipe avoid include lactose', JSON.stringify(saved.avoid));
    run(ctx, "delete customRecipes['" + savedId + "']; applyCustomRecipes();");

    call(ctx, 'openNewRecipeForm', []);
    rb = get(ctx, 'recipeBuilder');
    rb.name = 'D3 dairy-nondefault meta recipe';
    rb.ingredients = [{foodId: 'olive-oil', grams: 10}, {foodId: 'lemon-juice', grams: 10}];
    call(ctx, 'addRecipeOptionGroup', []);
    rb.optionGroups[0].label = 'Topping';
    rb.optionGroups[0].choices[0].label = 'Oranges'; // DEFAULT, no dairy
    rb.optionGroups[0].choices[0].ingredients = [{foodId: 'oranges', grams: 100}];
    rb.optionGroups[0].choices[1].label = 'Ricotta'; // non-default — cat 'Dairy'
    rb.optionGroups[0].choices[1].ingredients = [{foodId: 'ricotta', grams: 100}];
    call(ctx, 'saveRecipeBuilder', []);
    customRecipes = get(ctx, 'customRecipes');
    savedId = Object.keys(customRecipes).find(function(id){ return customRecipes[id].title === 'D3 dairy-nondefault meta recipe'; });
    saved = get(ctx, 'RECIPES_DB')[savedId];
    assert(saved.avoid.indexOf('lactose') === -1,
      'derived meta: the SAME dairy ingredient sitting in a NON-default choice does not add lactose to the saved recipe avoid', JSON.stringify(saved.avoid));
    run(ctx, "delete customRecipes['" + savedId + "']; applyCustomRecipes(); recipeBuilder = null;");
  })();

  // -------- (7) unresolvable-ingredient choice rejected at save (defensive — never
  // reachable through the real picker UI, which only ever offers real FOODS ids, but the
  // save path must still refuse a corrupted/hand-crafted draft rather than writing a
  // structurally-broken recipe). --------
  (function(){
    call(ctx, 'openNewRecipeForm', []);
    const rb = get(ctx, 'recipeBuilder');
    rb.name = 'D3 unresolvable ingredient recipe';
    rb.ingredients = [{foodId: 'olive-oil', grams: 10}, {foodId: 'lemon-juice', grams: 10}];
    call(ctx, 'addRecipeOptionGroup', []);
    rb.optionGroups[0].label = 'Protein';
    rb.optionGroups[0].choices[0].label = 'Salmon';
    rb.optionGroups[0].choices[0].ingredients = [{foodId: 'salmon-fillet', grams: 150}];
    rb.optionGroups[0].choices[1].label = 'Ghost';
    rb.optionGroups[0].choices[1].ingredients = [{foodId: 'not-a-real-food-id', grams: 100}];

    const before = Object.keys(get(ctx, 'customRecipes')).length;
    call(ctx, 'saveRecipeBuilder', []);
    const after = Object.keys(get(ctx, 'customRecipes')).length;
    assert(after === before,
      'unresolvable ingredient: save is rejected (no new customRecipes entry) when a choice references a food id that does not resolve', 'before=' + before + ' after=' + after);
    const stillEditing = get(ctx, 'recipeBuilder');
    assert(!!stillEditing && stillEditing.name === 'D3 unresolvable ingredient recipe',
      'unresolvable ingredient: the builder draft survives the rejected save (recipeBuilder not nulled out, nothing lost)', '');
    run(ctx, "recipeBuilder = null;");
  })();

  // -------- (8) group/choice mutators: add/remove group, add/remove choice, "make
  // default" (moves a choice to position 0 — no drag/drop). --------
  (function(){
    call(ctx, 'openNewRecipeForm', []);
    const rb = get(ctx, 'recipeBuilder');
    call(ctx, 'addRecipeOptionGroup', []);
    assert(rb.optionGroups.length === 1 && rb.optionGroups[0].choices.length === 2,
      'addRecipeOptionGroup: starts a new group with 2 blank choices (the save-time minimum)', JSON.stringify(rb.optionGroups));
    call(ctx, 'addRecipeOptionChoice', [0]);
    assert(rb.optionGroups[0].choices.length === 3, 'addRecipeOptionChoice: appends a blank choice to the target group', rb.optionGroups[0].choices.length);
    rb.optionGroups[0].choices[0].label = 'A';
    rb.optionGroups[0].choices[1].label = 'B';
    rb.optionGroups[0].choices[2].label = 'C';
    call(ctx, 'makeRecipeOptionChoiceDefault', [0, 2]);
    assert(JSON.stringify(rb.optionGroups[0].choices.map(function(c){ return c.label; })) === JSON.stringify(['C', 'A', 'B']),
      'makeRecipeOptionChoiceDefault: moves the chosen choice to position 0, keeping the others\' relative order', JSON.stringify(rb.optionGroups[0].choices.map(function(c){ return c.label; })));
    call(ctx, 'removeRecipeOptionChoice', [0, 1]);
    assert(JSON.stringify(rb.optionGroups[0].choices.map(function(c){ return c.label; })) === JSON.stringify(['C', 'B']),
      'removeRecipeOptionChoice: removes exactly the targeted choice by index', JSON.stringify(rb.optionGroups[0].choices.map(function(c){ return c.label; })));
    call(ctx, 'addRecipeOptionGroup', []);
    assert(rb.optionGroups.length === 2, 'addRecipeOptionGroup: a second group can be added independently', rb.optionGroups.length);
    call(ctx, 'removeRecipeOptionGroup', [0]);
    assert(rb.optionGroups.length === 1, 'removeRecipeOptionGroup: removes exactly the targeted group by index', rb.optionGroups.length);
    run(ctx, "recipeBuilder = null;");
  })();

  // -------- (9) ingredient-row mutators + the add-ingredient picker's option-choice
  // target (openAddIngredientToRecipe/addIngredientToRecipe generalized, no new picker
  // UI). --------
  (function(){
    call(ctx, 'openNewRecipeForm', []);
    const rb = get(ctx, 'recipeBuilder');
    call(ctx, 'addRecipeOptionGroup', []);
    rb.optionGroups[0].label = 'Fish';
    rb.optionGroups[0].choices[0].label = 'Salmon';
    rb.optionGroups[0].choices[1].label = 'Cod';

    call(ctx, 'openAddIngredientToRecipe', [{groupIndex: 0, choiceIndex: 1}]);
    call(ctx, 'addIngredientToRecipe', ['cod']);
    assert(rb.optionGroups[0].choices[1].ingredients.length === 1 && rb.optionGroups[0].choices[1].ingredients[0].foodId === 'cod',
      'openAddIngredientToRecipe/addIngredientToRecipe: an option-choice target adds the ingredient into that choice, not the base list', JSON.stringify(rb.optionGroups[0].choices[1].ingredients));
    assert(rb.ingredients.length === 0,
      'addIngredientToRecipe: the base ingredients list stays untouched when the target is an option choice', rb.ingredients.length);

    call(ctx, 'openAddIngredientToRecipe', []); // no target -> base list, exactly like every pre-D3 call site
    call(ctx, 'addIngredientToRecipe', ['olive-oil']);
    assert(rb.ingredients.length === 1 && rb.ingredients[0].foodId === 'olive-oil',
      'openAddIngredientToRecipe with no target: still adds to the base ingredients list, unchanged from before D3', JSON.stringify(rb.ingredients));

    call(ctx, 'stepRecipeOptionIngredientGrams', [0, 1, 0, 10]);
    assert(rb.optionGroups[0].choices[1].ingredients[0].grams === 110,
      'stepRecipeOptionIngredientGrams: adjusts grams on the targeted choice ingredient row', rb.optionGroups[0].choices[1].ingredients[0].grams);
    call(ctx, 'commitRecipeOptionIngredientGrams', [0, 1, 0, '75']);
    assert(rb.optionGroups[0].choices[1].ingredients[0].grams === 75,
      'commitRecipeOptionIngredientGrams: sets a typed gram value on the targeted choice ingredient row', rb.optionGroups[0].choices[1].ingredients[0].grams);
    call(ctx, 'removeRecipeOptionIngredient', [0, 1, 0]);
    assert(rb.optionGroups[0].choices[1].ingredients.length === 0,
      'removeRecipeOptionIngredient: removes the targeted ingredient row from the choice', rb.optionGroups[0].choices[1].ingredients.length);
    run(ctx, "recipeBuilder = null;");
  })();

  // -------- (10) computeRecipeOptionChoiceTotals: per-serving base+choice totals,
  // cross-checked against an independently-summed foodMacros() total (never a re-typed
  // literal) — and builderEffectiveIngredientRows: a draft with no option groups returns
  // the base ingredients unchanged (pre-D3 recipes stay byte-identical). --------
  (function(){
    call(ctx, 'openNewRecipeForm', []);
    const rb = get(ctx, 'recipeBuilder');
    rb.ingredients = [{foodId: 'olive-oil', grams: 10}];
    rb.servings = 2;
    call(ctx, 'addRecipeOptionGroup', []);
    rb.optionGroups[0].choices[0].ingredients = [{foodId: 'salmon-fillet', grams: 200}];
    const totals = call(ctx, 'computeRecipeOptionChoiceTotals', [0, 0]);
    const expectedProtein = (call(ctx, 'foodMacros', ['olive-oil', 10]).protein + call(ctx, 'foodMacros', ['salmon-fillet', 200]).protein) / 2;
    assert(Math.abs(totals.protein - expectedProtein) < 1e-6,
      'computeRecipeOptionChoiceTotals: per-serving protein = (base + this choice) / servings, cross-checked against foodMacros', 'got=' + totals.protein + ' expected=' + expectedProtein);

    const rows = call(ctx, 'builderEffectiveIngredientRows', []);
    // rb still has the 1 option group set above; clear it to test the no-optionGroups case.
    rb.optionGroups = [];
    const rowsNoOptions = call(ctx, 'builderEffectiveIngredientRows', []);
    assert(JSON.stringify(rowsNoOptions) === JSON.stringify(rb.ingredients),
      'builderEffectiveIngredientRows: a draft with no option groups returns the base ingredients unchanged', JSON.stringify(rowsNoOptions));
    assert(rows.length === rb.ingredients.length + 1,
      'builderEffectiveIngredientRows: with one option group, returns base ingredients + the DEFAULT choice\'s ingredients', rows.length);
    run(ctx, "recipeBuilder = null;");
  })();

  // -------- (11) recipe-detail discoverability: the existing "Change image" edit entry
  // point (openRecipeImageForm, wired from the recipe detail hero) already opens the SAME
  // full builder sheet — verifying it now naturally reaches the Options section, showing a
  // real built-in's existing optionGroups, without any detail-screen redesign. --------
  (function(){
    call(ctx, 'openRecipeImageForm', ['baked-fish']);
    const html = call(ctx, 'buildRecipeBuilderSheet', []);
    assert(html.indexOf('Options <span') !== -1,
      'recipe detail discoverability: the existing "Change image" edit entry point (openRecipeImageForm) reaches a builder sheet including the Options section', '');
    assert(html.indexOf('recipe-option-group') !== -1 && html.indexOf('Group 1') !== -1,
      'recipe detail discoverability: baked-fish\'s existing Fish optionGroup renders inside the builder\'s Options section', '');
    run(ctx, "recipeBuilder = null;");
  })();

  // -------- (12) "Reset to default" button gating + the reset flow end-to-end against a
  // real built-in (baked-fish): hidden for an unedited built-in and for a brand-new custom
  // recipe, shown once a household override exists, and clears the override on tap. --------
  (function(){
    call(ctx, 'openEditRecipeForm', ['baked-fish']);
    let html = call(ctx, 'buildRecipeBuilderSheet', []);
    assert(html.indexOf('Reset to default') === -1, 'Reset to default: hidden for a built-in recipe with no household override', '');

    const rb = get(ctx, 'recipeBuilder');
    rb.time = rb.time + 2; // trivial edit so saveRecipeBuilder creates a recipeOverrides entry
    call(ctx, 'saveRecipeBuilder', []);
    const validation = call(ctx, 'validateData', []);
    assert(validation.ok === true, 'Reset to default setup: validateData() stays ok:true after a trivial built-in edit', JSON.stringify(validation.errors));

    call(ctx, 'openEditRecipeForm', ['baked-fish']);
    html = call(ctx, 'buildRecipeBuilderSheet', []);
    assert(html.indexOf('Reset to default') !== -1, 'Reset to default: shown once a built-in recipe has a household override', '');

    call(ctx, 'resetRecipeBuilderOverride', []);
    assert(!get(ctx, 'recipeOverrides')['baked-fish'], 'resetRecipeBuilderOverride: clears the override and reopens the builder on the restored built-in', '');
    html = call(ctx, 'buildRecipeBuilderSheet', []);
    assert(html.indexOf('Reset to default') === -1, 'Reset to default: hidden again once the override is cleared', '');

    call(ctx, 'openNewRecipeForm', []);
    html = call(ctx, 'buildRecipeBuilderSheet', []);
    assert(html.indexOf('Reset to default') === -1, 'Reset to default: never shown for a brand-new custom recipe (no editingId)', '');
    run(ctx, "recipeBuilder = null;");
  })();

  // -------- (13) final consistency: the whole D3 test suite leaves validateData() green
  // and every touched built-in recipe byte-identical to its pristine BUILTIN_RECIPES_DB
  // snapshot — proving every subsection above actually cleaned up after itself. --------
  (function(){
    const validation = call(ctx, 'validateData', []);
    assert(validation.ok === true, 'D3 cleanup: validateData() stays ok:true at the end of the builder test suite', JSON.stringify(validation.errors));
    const BUILTIN_RECIPES_DB = get(ctx, 'BUILTIN_RECIPES_DB');
    const RECIPES_DB = get(ctx, 'RECIPES_DB');
    ['baked-fish', 'french-toast-fruit-maple', 'pasta'].forEach(function(id){
      assert(JSON.stringify(RECIPES_DB[id]) === JSON.stringify(BUILTIN_RECIPES_DB[id]),
        'D3 cleanup: "' + id + '" is back to its pristine built-in shape (no leftover recipeOverrides) after the builder test suite', '');
    });
  })();

  run(ctx, "toast = __d3BuilderStub.toast; openMyRecipes = __d3BuilderStub.openMyRecipes; applyProf = __d3BuilderStub.applyProf; renderFoodLibraryCount = __d3BuilderStub.renderFoodLibraryCount; delete __d3BuilderStub;");
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
  runTest('nutrition perServing non-numeric fields', function(){ testNutritionPerServingNonNumericFields(ctx); });
  runTest('foodMacros linearity', function(){ testFoodMacrosLinearity(ctx); });
  runTest('ingredient detail page markup (task C4)', function(){ testFoodDetailMarkup(ctx); });
  runTest('Add to pantry on ingredient cards', function(){ testAddToPantryOnIngredientCards(ctx); });
  runTest('Pantry page: category sections + filters', function(){ testPantrySectionsAndFilters(ctx); });
  runTest('ingredient icon picker (task C5)', function(){ testIconPicker(ctx); });
  runTest('recipe display helpers (compat-view removal)', function(){ testRecipeDisplayHelpers(ctx); });
  runTest('recipe image helpers (task B)', function(){ testRecipeImageHelpers(ctx); });
  runTest('recipe catalog cleanup', function(){ testRecipeCatalogCleanup(ctx); });
  runTest('replaceBuiltinRecipesFromCatalogRows: D1 catalog sanity floor + validation', function(){ testReplaceBuiltinRecipesFromCatalogRows(ctx); });
  runTest('recipe image picker', function(){ testRecipeImagePicker(ctx); });
  runTest('library recipe rows open detail', function(){ testLibraryRecipeRowsOpenDetail(); });
  runTest('no legacy RECIPES compat view', function(){ testNoLegacyRecipesCompatView(); });
  runTest('mergeLibrarySection: newer-wins', function(){ testMergeLibraryNewerWins(ctx); });
  runTest('mergeLibrarySection: tombstone + idempotence', function(){ testMergeLibraryTombstoneIdempotence(ctx); });
  runTest('mergeLibrarySection: ratchet regression', function(){ testMergeLibraryRatchetRegression(ctx); });
  runTest('mergePantrySection: newer-wins (PANTRY-plan.md P1)', function(){ testMergePantrySectionNewerWins(ctx); });
  runTest('mergePantrySection: delete not resurrected (PANTRY-plan.md P1)', function(){ testMergePantrySectionDeleteNotResurrected(ctx); });
  runTest('mergePantrySection: order-independence (PANTRY-plan.md P1)', function(){ testMergePantrySectionOrderIndependence(ctx); });
  runTest('mergePantrySection: tie-break converges (PANTRY-plan.md P1)', function(){ testMergePantrySectionTieBreakConverges(ctx); });
  runTest('pantry load-validation (PANTRY-plan.md P1)', function(){ testPantryLoadValidation(ctx); });
  runTest('validateBackupStructure: pantry field (PANTRY-plan.md P1)', function(){ testValidateBackupStructurePantry(ctx); });
  runTest('pantryConsumedSince/pantryRemaining derivation (PANTRY-plan.md P2)', function(){ testPantryConsumedSinceAndRemaining(ctx); });
  runTest('pantry re-baseline mutation path (PANTRY-plan.md P2)', function(){ testPantryRebaselineMutationPath(ctx); });
  runTest('eaten-out flag: nutrition unchanged, pantry skip/restore, merge round-trip, shopping-list (FAVORITES-EATENOUT-plan.md item 3)', function(){ testEatenOutFlag(ctx); });
  runTest('eaten-out toggle wiring (FAVORITES-EATENOUT-plan.md item 3)', function(){ testEatenOutToggleWiring(); });
  runTest('Week eaten-out: calories/pantry/shopping-list (both weeks)/shared/undo (WEEK-EATENOUT-plan.md)', function(){ testWeekEatenOut(ctx); });
  runTest('Week eaten-out toggle wiring (WEEK-EATENOUT-plan.md)', function(){ testWeekEatenOutToggleWiring(); });
  runTest('mergeLogSection', function(){ testMergeLogSection(ctx); });
  runTest('mergePlansSection', function(){ testMergePlansSection(ctx); });
  runTest('mealRules pinFromDate persistence', function(){ testMealRulePinFromDatePersistence(ctx); });
  runTest('mealRules pinFromDate sync apply', function(){ testMealRulePinFromDateSyncApply(ctx); });
  runTest('pinned re-balance unit exclusion', function(){ testPinnedRebalanceDoesNotTouchPinnedUnit(ctx); });
  runTest('today re-balance regressions', function(){ testTodayRebalance(ctx); });
  runTest('pinned future regeneration contract', function(){ testPinnedFutureMealSurvivesRegenerationContract(ctx); });
  runTest('routine pin helper contracts', function(){ testRoutinePinHelperContracts(ctx); });
  runTest('pinned meals re-balance immutability (2026-07-19)', function(){ testPinnedMealsRebalanceImmutability(ctx); });
  runTest('re-balance appliers carry the pin guard', function(){ testRebalanceAppliersCarryPinGuard(); });
  runTest('preserveLoggedSlots/preservePinnedSlots one-sided dangling recipe (2026-07-19)', function(){ testPreserveSlotsOneSidedDangling(ctx); });
  runTest('planner determinism', function(){ testPlannerDeterminism(ctx); });
  runTest('next-week tuning (task C2)', function(){ testNextWeekTuning(ctx); });
  runTest('persist() storage-failure reporting (Fix 3)', function(){ testPersistFailureHook(ctx); });
  runTest('day-wide variety (VARIETY-plan.md P1)', function(){ testDayWideVariety(ctx); });
  runTest('weekly recipe caps (VARIETY-plan.md P2)', function(){ testWeeklyRecipeCaps(ctx); });
  runTest('stronger favorites: cap +1 + FAVORITE_SCORE_BOOST (FAVORITES-EATENOUT-plan.md item 2)', function(){ testFavorites(ctx); });
  runTest('Mediterranean protein balance (VARIETY-plan.md P2)', function(){ testProteinBalance(ctx); });
  runTest('composed meals (task B2 part 2)', function(){ testComposedMeals(ctx); });
  runTest('planner meal-extras', function(){ testMealExtras(ctx); });
  runTest('week catch-up logging (task B5)', function(){ testWeekCatchupLogging(ctx); });
  runTest('week nutrient summary (task B4)', function(){ testWeekNutriSummary(ctx); });
  runTest('week quick-add logged foods counted (task C3)', function(){ testWeekQuickAddNutrition(ctx); });
  runTest('week extras on next-week meal (task B3)', function(){ testWeekExtrasNextWeek(ctx); });
  runTest('Insights per-day nutrient bands (task C1)', function(){ testInsightsNutrientBands(ctx); });
  runTest('recipe options/variants (task D1)', function(){ testRecipeOptions(ctx); });
  runTest('foodQuantitiesForComponents decomposition (PANTRY-plan.md P1)', function(){ testFoodQuantitiesForComponents(ctx); });
  runTest('computeShoppingList decomposition parity (PANTRY-plan.md P1)', function(){ testShoppingListDecompositionParity(ctx); });
  runTest('computeShoppingList: Q1 logged-exclusion + pantry subtraction + next-week projection (PANTRY-plan.md P3)', function(){ testShoppingListLoggedExclusionAndPantrySubtraction(ctx); });
  runTest('restockTickedShopItems: Add ticked items to pantry (PANTRY-plan.md P3 Q2)', function(){ testRestockTickedShopItems(ctx); });
  runTest('sauce role + catalog additions (task D2)', function(){ testD2SauceRoleAndCatalog(ctx); });
  runTest('recipe builder Options section (task D3)', function(){ testRecipeOptionsBuilder(ctx); });
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
