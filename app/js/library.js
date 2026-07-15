/* ===================================================================
   library.js — user ingredient & recipe library (post-MVP iteration)

   Feature 1 (ingredients): a Profile "Food library" section lets Elena/
   Andrea add their own foods (id `cf-<slug>`, stored in state.js's
   `customFoods`) and browse/delete them. applyCustomFoods() merges
   customFoods into the global FOODS object (data/foods.js) at boot and
   after every add/delete, so custom foods behave exactly like built-in
   ones everywhere: quick-add search (render.js:searchFoods), shopping-
   list categorization (planner.js:foodCategoryForName), and as
   ingredients in any recipe (built-in or custom).

   Feature 2 (recipes): "My recipes" lets them build a full recipe (name,
   emoji, slot, time, >=2 ingredients, optional steps) with NO nutrition
   typed in — kcal/protein/etc. are always computed from ingredients
   (ground rule 1), and tags/styles/avoid are AUTO-DERIVED from the
   ingredients + computed totals by deriveRecipeMeta() below, from named
   threshold constants (AUTO_TAG_THRESHOLDS / AUTO_STYLE_THRESHOLDS).
   Custom recipes (id `cr-<slug>`, stored in `customRecipes`) are merged
   into RECIPES_DB + RECIPE_SLOT_DB by applyCustomRecipes(), which also
   rebuilds the RECIPES compat view (state.js:buildLegacyRecipesCompat())
   so whyText(), the planner's candidatesFor(), computeShoppingList() and
   every renderer that reads RECIPES[id]/RECIPES_DB[id] see them exactly
   like a built-in recipe — no special-casing anywhere else.

   Both mutate `customRev` (state.js), a monotonic counter used by persistence/sync.
   Library changes do NOT regenerate an existing week: new recipes are available for
   manual swaps immediately and for future automatically generated weeks.

   Deleting a custom recipe never corrupts log history: LogEntry rows
   store frozen computed macros (state.js) and render.js already falls
   back gracefully (🍽️ / "Meal") when RECIPES[e.ref] is missing.
   =================================================================== */

/* ---------------- built-in counts, captured before any merge ----------------
   Runs at script-parse time — after data/foods.js + data/recipes.js have
   populated FOODS/RECIPES_DB with the shipped built-ins, but BEFORE
   app.js's boot sequence calls applyCustomFoods()/applyCustomRecipes().
   So these are always "how many shipped with the app", regardless of
   how many custom entries a reload later merges in. */
const BUILTIN_FOOD_COUNT = Object.keys(FOODS).length;
const BUILTIN_RECIPE_COUNT = Object.keys(RECIPES_DB).length;
const BUILTIN_FOODS_DB = JSON.parse(JSON.stringify(FOODS));
const BUILTIN_RECIPES_DB = JSON.parse(JSON.stringify(RECIPES_DB));
const BUILTIN_RECIPE_SLOT_DB = JSON.parse(JSON.stringify(RECIPE_SLOT_DB));

/* ---------------- merge custom content into the live DBs ----------------
   Both functions are full "sync to customFoods/customRecipes" passes (not
   just additive merges) — they also drop any previously-merged cf-… / cr-…
   entry that customFoods/customRecipes no longer has, so a delete is
   reflected correctly even though these are also called (harmlessly) from
   the add path. Called once at boot (app.js) and again after every add/
   delete (this file). */
function applyCustomFoods(){
  Object.keys(FOODS).forEach(function(id){
    if(id.indexOf('cf-') === 0 && !customFoods[id]) delete FOODS[id];
  });
  Object.keys(BUILTIN_FOODS_DB).forEach(function(id){
    FOODS[id] = JSON.parse(JSON.stringify(foodOverrides[id] || BUILTIN_FOODS_DB[id]));
  });
  Object.keys(customFoods).forEach(function(id){ FOODS[id] = customFoods[id]; });
}

function applyCustomRecipes(){
  Object.keys(RECIPES_DB).forEach(function(id){ delete RECIPES_DB[id]; });
  Object.keys(RECIPE_SLOT_DB).forEach(function(id){ delete RECIPE_SLOT_DB[id]; });

  Object.keys(BUILTIN_RECIPES_DB).forEach(function(id){
    if(deletedRecipes[id]) return;
    const src = recipeOverrides[id] || BUILTIN_RECIPES_DB[id];
    RECIPES_DB[id] = JSON.parse(JSON.stringify(src));
    RECIPE_SLOT_DB[id] = RECIPES_DB[id].slot || BUILTIN_RECIPE_SLOT_DB[id];
  });
  Object.keys(recipeOverrides).forEach(function(id){
    if(BUILTIN_RECIPES_DB[id] || deletedRecipes[id]) return;
    RECIPES_DB[id] = JSON.parse(JSON.stringify(recipeOverrides[id]));
    RECIPE_SLOT_DB[id] = RECIPES_DB[id].slot;
  });
  Object.keys(customRecipes).forEach(function(id){
    if(deletedRecipes[id]) return;
    RECIPES_DB[id] = JSON.parse(JSON.stringify(customRecipes[id]));
    RECIPE_SLOT_DB[id] = RECIPES_DB[id].slot;
  });
  // Rebuilds RECIPES[id] for EVERY id in RECIPES_DB (state.js) — custom ids included —
  // so whyText()/renderRecipe()/renderWeek()/shopping list etc. need no special-casing.
  buildLegacyRecipesCompat();
  Object.keys(RECIPES).forEach(function(id){ if(!RECIPES_DB[id]) delete RECIPES[id]; });
}

/* ===================================================================
   AUTO-DERIVATION (task brief: "all thresholds as named constants in
   one place, documented"). deriveRecipeMeta() is the single function
   that turns a custom recipe's ingredients + computed per-serving
   totals + prep time into {tags, styles, avoid} — the same vocabulary
   RECIPES_DB / validate.js already enforce (VALID_TAGS/VALID_STYLES/
   VALID_AVOID, data/validate.js). Nothing here is typed in per recipe;
   it recomputes fresh every time (save time, and live in the builder's
   preview footer) from whatever ingredients are currently in the list.
   =================================================================== */
const AUTO_TAG_THRESHOLDS = {
  omega3MinG: 40,            // any omega3-flagged ingredient >= this many grams -> tags: omega3
  seleniumMinG: 15,          // any selenium-flagged ingredient >= this many grams -> tags: thyroid
  highFiberMinG: 6,          // total fiber/serving >= this -> tags: highFiber
  lowGICarbContributorMinG: 5, // an ingredient counts as "carb-contributing" once it supplies
                              // >= this many carb grams to the dish (used by the lowGI rule)
  muscleProteinMinG: 25,     // total protein/serving >= this -> tags: muscle
  heartFiberMinG: 5,         // total fiber/serving >= this (AND heartSatFatMaxShare below) -> tags: heart
  heartSatFatMaxShare: 0.33, // satFat / fat <= this (AND heartFiberMinG above) -> tags: heart
  quickMaxMinutes: 15        // prep time <= this -> tags: quick
};
const AUTO_STYLE_THRESHOLDS = {
  highProteinKcalShareMin: 0.28, // protein kcal / total kcal >= this -> styles += 'highprotein'
  lowCarbMaxG: 30,               // total carbs/serving <= this -> styles += 'lowcarb'
  balancedCarbKcalShareMax: 0.55 // carb kcal / total kcal > this -> drop 'balanced', UNLESS it's
                                  // the only style left (never leave styles empty)
};
// Fish/meat/poultry ingredient ids — presence of ANY of these makes a dish non-veggie.
// Hand-picked from data/foods.js's Protein category (excludes eggs and plant proteins
// like chickpeas/cannellini-beans, matching how built-in recipes are hand-tagged — e.g.
// 'shakshuka' contains eggs and is tagged 'veggie' in data/recipes.js). Adding a new
// fish/meat/poultry food later needs a one-line addition here.
const ANIMAL_FOOD_IDS = [
  'salmon-fillet', 'turkey-breast', 'chicken-breast', 'tuna-in-olive-oil', 'tuna',
  'sardines', 'cod', 'prawns', 'chicken-thigh', 'beef-mince-lean', 'pork-loin', 'bresaola'
];
// Per the task brief's exact list.
const GLUTEN_FOOD_IDS = ['rye-bread', 'wholewheat-bread', 'wholegrain-pasta', 'pasta', 'couscous', 'barley', 'granola', 'oats'];
const NUT_FOOD_IDS = ['walnuts', 'almonds', 'brazil-nuts', 'pumpkin-seeds', 'pumpkin-chia-seeds'];

// ingredients: [{foodId, grams}, ...] (the recipe as authored = exactly 1 serving, same
// convention as RECIPES_DB). totals: the SAME shape recipeNutrition()/computeBuilderTotals()
// produce (kcal already 4/4/9-recomputed). timeMinutes: the recipe's prep time.
function deriveRecipeMeta(ingredients, totals, timeMinutes){
  const T = AUTO_TAG_THRESHOLDS, S = AUTO_STYLE_THRESHOLDS;
  const rows = (ingredients || [])
    .map(function(row){ return {row: row, food: FOODS[row.foodId]}; })
    .filter(function(x){ return !!x.food; });

  const tags = [];
  function hasFlagAtLeast(flag, minG){
    return rows.some(function(x){ return (x.food.flags || []).indexOf(flag) !== -1 && x.row.grams >= minG; });
  }
  if(hasFlagAtLeast('omega3', T.omega3MinG)) tags.push('omega3');
  if(hasFlagAtLeast('selenium', T.seleniumMinG)) tags.push('thyroid');
  if(totals.fiber >= T.highFiberMinG) tags.push('highFiber');

  // lowGI: every carb-contributing ingredient (>=5g carbs in the dish) must be lowGI-flagged.
  // A dish with no carb-contributing ingredient at all doesn't qualify (vacuous truth guard).
  const carbContributors = rows.filter(function(x){
    return foodMacros(x.row.foodId, x.row.grams).carbs >= T.lowGICarbContributorMinG;
  });
  if(carbContributors.length && carbContributors.every(function(x){ return (x.food.flags || []).indexOf('lowGI') !== -1; })){
    tags.push('lowGI');
  }

  if(totals.protein >= T.muscleProteinMinG) tags.push('muscle');

  const satShare = totals.fat > 0 ? totals.satFat / totals.fat : 0;
  if(totals.fiber >= T.heartFiberMinG && satShare <= T.heartSatFatMaxShare) tags.push('heart');

  const isVeggie = !rows.some(function(x){ return ANIMAL_FOOD_IDS.indexOf(x.row.foodId) !== -1; });
  if(isVeggie) tags.push('veggie');

  if(timeMinutes <= T.quickMaxMinutes) tags.push('quick');

  // styles — RECIPES_DB.styles vocabulary directly ('balanced'/'highprotein'/'lowcarb'),
  // not the household-style vocabulary (planner.js:STYLE_DB_KEY translates the other way).
  let styles = ['balanced'];
  const proteinKcalShare = totals.kcal > 0 ? (totals.protein * 4) / totals.kcal : 0;
  const carbKcalShare = totals.kcal > 0 ? (totals.carbs * 4) / totals.kcal : 0;
  if(proteinKcalShare >= S.highProteinKcalShareMin) styles.push('highprotein');
  if(totals.carbs <= S.lowCarbMaxG) styles.push('lowcarb');
  if(carbKcalShare > S.balancedCarbKcalShareMax && styles.length > 1){
    styles = styles.filter(function(s){ return s !== 'balanced'; }); // guard keeps 'balanced' if it'd otherwise be empty
  }

  // avoid
  const avoidSet = {};
  rows.forEach(function(x){
    if(x.food.cat === 'Dairy') avoidSet.lactose = true;
    if(GLUTEN_FOOD_IDS.indexOf(x.row.foodId) !== -1) avoidSet.gluten = true;
    if(x.row.foodId === 'prawns') avoidSet.shellfish = true;
    if(NUT_FOOD_IDS.indexOf(x.row.foodId) !== -1) avoidSet.nuts = true;
  });

  return {tags: tags, styles: styles, avoid: Object.keys(avoidSet)};
}

// Non-blocking kcal-band nudge shown in the builder footer (same bands as
// data/validate.js:KCAL_BAND, already loaded — not redefined here).
function kcalBandWarning(slot, kcal){
  const band = KCAL_BAND[slot];
  if(!band) return null;
  if(kcal < band[0]) return 'Light for a ' + slot + ' — the planner may size portions up.';
  if(kcal > band[1]) return 'Rich for a ' + slot + ' — the planner may size portions down.';
  return null;
}

function tagLabelForPreview(t){ return (TAG_PILL_MAP[t] && TAG_PILL_MAP[t][1]) || t; }

/* ---------------- small helpers ---------------- */
const SEASON_VALUES = ['evergreen', 'winter/autumn', 'spring/summer'];
const SEASON_LABELS = {'evergreen': 'Evergreen', 'winter/autumn': 'Winter/autumn', 'spring/summer': 'Spring/summer'};

function normalizeSeason(v){
  return SEASON_VALUES.indexOf(v) !== -1 ? v : 'evergreen';
}
function seasonLabel(v){ return SEASON_LABELS[normalizeSeason(v)]; }
function foodSeason(foodOrId){
  const f = typeof foodOrId === 'string' ? FOODS[foodOrId] : foodOrId;
  return normalizeSeason(f && f.season);
}
function recipeSeason(recipeOrId){
  const r = typeof recipeOrId === 'string' ? RECIPES_DB[recipeOrId] : recipeOrId;
  if(!r) return 'evergreen';
  if(SEASON_VALUES.indexOf(r.season) !== -1) return r.season;
  const seasonal = {};
  (r.ingredients || []).forEach(function(ing){
    const s = foodSeason(ing && ing[0]);
    if(s !== 'evergreen') seasonal[s] = true;
  });
  const keys = Object.keys(seasonal);
  return keys.length === 1 ? keys[0] : 'evergreen';
}
function currentSeasonKey(){
  const d = (typeof todayISO === 'function') ? parseISODate(todayISO()) : new Date();
  const m = d.getMonth() + 1;
  return (m >= 4 && m <= 9) ? 'spring/summer' : 'winter/autumn';
}
function recipeAllowedForCurrentSeason(recipeId){
  const s = recipeSeason(recipeId);
  return s === 'evergreen' || s === currentSeasonKey();
}
function derivedRecipeSeasonFromIngredients(ingredients){
  const seasonal = {};
  (ingredients || []).forEach(function(row){
    const foodId = row.foodId || row[0];
    const s = foodSeason(foodId);
    if(s !== 'evergreen') seasonal[s] = true;
  });
  const keys = Object.keys(seasonal);
  return keys.length === 1 ? keys[0] : 'evergreen';
}

function slugify(name){
  const s = String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
  return s || 'item';
}
function uniqueSlug(base, dbObj, prefix){
  let slug = base, n = 2;
  while(dbObj[prefix + slug]){ slug = base + '-' + n; n++; }
  return prefix + slug;
}
// HTML-attribute escaper (double-quoted value="..." contexts) — distinct from render.js's
// jsAttr(), which escapes for single-quoted inline-JS string contexts.
function htmlAttr(s){ return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeHtml(s){ return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// Profile → "Food library" section header line: "75 built-in · N yours".
function renderFoodLibraryCount(){
  const el = document.getElementById('libFoodCount');
  if(!el) return;
  const n = Object.keys(customFoods).length;
  el.textContent = BUILTIN_FOOD_COUNT + ' built-in · ' + n + ' yours';
}

/* ===================================================================
   FEATURE 1 — Browse ingredients sheet
   =================================================================== */
let libFoodQuery = '';

/* ---------------- T5: Ingredients sheet — category/tag filter chips ----------------
   Multi-select AND-combine with the existing text search (libFoodQuery). Category is a
   single facet (foods have exactly one `cat`), so multiple active categories are OR'd
   together; flags are AND'd (a food must carry every active flag) — documented choice,
   matching the task brief's "AND across flags is fine". View-only: reset every time the
   sheet (re)opens (openFoodLibrary below), never persisted. */
let libFoodFilters = {cats: new Set(), flags: new Set(), seasons: new Set()};
let libFoodFiltersOpen = false;
// Full flag facet per the task brief (data/foods.js's actual flag vocabulary) — a
// superset of FOOD_FORM_FLAGS below, which is only the subset offered when hand-authoring
// a NEW custom ingredient.
const FOOD_FILTER_FLAGS = ['lowGI', 'omega3', 'selenium', 'highIodine', 'glutenFree', 'highFiber', 'fermented'];

const INGREDIENT_ICON_ASSETS = {
  almonds: 'assets/ingredients/almonds.png',
  apples: 'assets/ingredients/apples.png',
  asparagus: 'assets/ingredients/asparagus.png',
  aubergine: 'assets/ingredients/aubergine.png',
  avocado: 'assets/ingredients/avocado.png',
  bacon: 'assets/ingredients/bacon.png',
  'balsamic-vinegar': 'assets/ingredients/balsamic-vinegar.png',
  bananas: 'assets/ingredients/bananas.png',
  barley: 'assets/ingredients/barley.png',
  basil: 'assets/ingredients/basil.png',
  'beef-mince-lean': 'assets/ingredients/beef-mince-lean.png',
  'bell-pepper': 'assets/ingredients/bell-pepper.png',
  'brazil-nuts': 'assets/ingredients/brazil-nuts.png',
  bresaola: 'assets/ingredients/bresaola.png',
  broccoli: 'assets/ingredients/broccoli.png',
  'broccoli-courgette': 'assets/ingredients/broccoli-courgette.png',
  brownie: 'assets/ingredients/brownie.png',
  cabbage: 'assets/ingredients/cabbage.png',
  'cannellini-beans': 'assets/ingredients/cannellini-beans.png',
  capers: 'assets/ingredients/capers.png',
  'cappuccino-unsweetened': 'assets/ingredients/cappuccino-unsweetened.png',
  carrot: 'assets/ingredients/carrot.png',
  carrots: 'assets/ingredients/carrots.png',
  cauliflower: 'assets/ingredients/cauliflower.png',
  'cavolo-nero': 'assets/ingredients/cavolo-nero.png',
  'cherry-tomatoes': 'assets/ingredients/cherry-tomatoes.png',
  'cherry-tomatoes-cucumber': 'assets/ingredients/cherry-tomatoes-cucumber.png',
  'chia-seeds': 'assets/ingredients/chia-seeds.png',
  'chicken-breast': 'assets/ingredients/chicken-breast.png',
  'chicken-thigh': 'assets/ingredients/chicken-thigh.png',
  chickpeas: 'assets/ingredients/chickpeas.png',
  'coconut-milk': 'assets/ingredients/coconut-milk.png',
  cod: 'assets/ingredients/cod.png',
  cola: 'assets/ingredients/cola.png',
  courgette: 'assets/ingredients/courgette.png',
  couscous: 'assets/ingredients/couscous.png',
  cucumber: 'assets/ingredients/cucumber.png',
  eggs: 'assets/ingredients/eggs.png',
  'espresso-unsweetened': 'assets/ingredients/espresso-unsweetened.png',
  milk: 'assets/ingredients/milk.png',
  pasta: 'assets/ingredients/pasta.png',
  rice: 'assets/ingredients/rice.png',
  sugar: 'assets/ingredients/sugar.png'
};

const FOOD_ICON_KEYS = {
  almonds: 'almonds',
  apples: 'apples',
  asparagus: 'asparagus',
  aubergine: 'aubergine',
  avocado: 'avocado',
  bacon: 'bacon',
  'balsamic-vinegar': 'balsamic-vinegar',
  bananas: 'bananas',
  barley: 'barley',
  basil: 'basil',
  'beef-mince-lean': 'beef-mince-lean',
  'bell-pepper': 'bell-pepper',
  'brazil-nuts': 'brazil-nuts',
  bresaola: 'bresaola',
  broccoli: 'broccoli',
  'broccoli-courgette': 'broccoli-courgette',
  brownie: 'brownie',
  cabbage: 'cabbage',
  'cannellini-beans': 'cannellini-beans',
  capers: 'capers',
  'cappuccino-unsweetened': 'cappuccino-unsweetened',
  carrot: 'carrot',
  carrots: 'carrots',
  cauliflower: 'cauliflower',
  'cavolo-nero': 'cavolo-nero',
  'cherry-tomatoes': 'cherry-tomatoes',
  'cherry-tomatoes-cucumber': 'cherry-tomatoes-cucumber',
  'chia-seeds': 'chia-seeds',
  'chicken-breast': 'chicken-breast',
  'chicken-thigh': 'chicken-thigh',
  chickpeas: 'chickpeas',
  'coconut-milk': 'coconut-milk',
  cod: 'cod',
  cola: 'cola',
  courgette: 'courgette',
  couscous: 'couscous',
  cucumber: 'cucumber',
  eggs: 'eggs',
  'espresso-unsweetened': 'espresso-unsweetened',
  milk: 'milk',
  'oat-milk': 'milk',
  pasta: 'pasta',
  'wholegrain-pasta': 'pasta',
  rice: 'rice',
  sugar: 'sugar'
};

function ingredientIconKeyForFood(foodId){
  const food = FOODS[foodId];
  if(FOOD_ICON_KEYS[foodId]) return FOOD_ICON_KEYS[foodId];
  const name = food ? String(food.name || '').toLowerCase() : '';
  if(/\bcarrots?\b/.test(name)) return 'carrot';
  if(/\beggs?\b/.test(name)) return 'eggs';
  if(/^(whole |skimmed |skim |semi-skimmed |low-fat |almond |soy |oat |coconut |rice )?milk\b/.test(name)) return 'milk';
  if(/\b(pasta|spaghetti|tagliatelle|penne|fusilli)\b/.test(name)) return 'pasta';
  if(/\brice\b/.test(name)) return 'rice';
  if(/\bsugar\b/.test(name)) return 'sugar';
  return null;
}

function ingredientIconHtml(iconKey, fallbackEmoji){
  const src = INGREDIENT_ICON_ASSETS[iconKey];
  if(!src) return fallbackEmoji || '🥕';
  return '<img class="ingredient-icon" src="' + src + '" alt="" aria-hidden="true" loading="lazy">';
}

function foodIconHtml(foodId, fallbackEmoji){
  return ingredientIconHtml(ingredientIconKeyForFood(foodId), fallbackEmoji);
}

function renderLibraryHub(){
  const el = document.getElementById('libraryHubBody');
  if(!el) return;
  el.innerHTML =
    '<div style="margin-top:10px">'
    + '<div class="altrow" onclick="openFoodLibrary()"><div class="ae">🧺</div><div class="at"><div class="an">Ingredients</div><div class="ad">Browse, edit or add foods</div></div></div>'
    + '<div class="altrow" onclick="openMyRecipes()"><div class="ae">📖</div><div class="at"><div class="an">Recipes</div><div class="ad">Browse, edit or add recipes</div></div></div>'
    + '<div class="altrow" onclick="openBarcodeScanner(true)"><div class="ae">📷</div><div class="at"><div class="an">Scan barcode</div><div class="ad">Add packaged products sold in Italy</div></div></div>'
    + '<div class="altrow" onclick="openNewFoodForm()"><div class="ae">＋</div><div class="at"><div class="an">New ingredient</div><div class="ad">Create a food from macros</div></div></div>'
    + '<div class="altrow" onclick="openNewRecipeForm()"><div class="ae">✎</div><div class="at"><div class="an">New recipe</div><div class="ad">Build from ingredients and meal slots</div></div></div>'
    + '</div>';
}

function setLibraryScreenHtml(screenId, bodyId, html){
  const body = document.getElementById(bodyId);
  if(body){
    body.innerHTML = html;
    const sheet = document.getElementById('sheet');
    const backdrop = document.getElementById('sheetBackdrop');
    if(sheet){ sheet.classList.remove('show'); sheet.classList.remove('tall'); }
    if(backdrop) backdrop.classList.remove('show');
    const screen = document.getElementById(screenId);
    if(!screen || !screen.classList.contains('active')) go(screenId);
    return true;
  }
  return false;
}

function setIngredientsScreenHtml(html){ return setLibraryScreenHtml('libraryIngredients', 'libraryIngredientsBody', html); }
function setRecipesScreenHtml(html){ return setLibraryScreenHtml('libraryRecipes', 'libraryRecipesBody', html); }
function setScannerScreenHtml(html){ return setLibraryScreenHtml('libraryScanner', 'libraryScannerBody', html); }

function openFoodLibrary(){
  libFoodQuery = '';
  libFoodFilters = {cats: new Set(), flags: new Set(), seasons: new Set()};
  libFoodFiltersOpen = false;
  setIngredientsScreenHtml(buildFoodLibrarySheet());
  const input = document.getElementById('libFoodSearchInput');
  if(input) input.focus();
}

function openAddMenu(){
  document.getElementById('sheetBody').innerHTML =
    '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Add</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
    + '<div style="margin-top:10px">'
    + '<div class="altrow" onclick="openBarcodeScanner()"><div class="ae">📷</div><div class="at"><div class="an">Scan barcode</div><div class="ad">Import packaged foods from Open Food Facts</div></div></div>'
    + '<div class="altrow" onclick="openNewFoodForm()"><div class="ae">🥕</div><div class="at"><div class="an">New ingredient</div><div class="ad">Create a food with computed calories from macros</div></div></div>'
    + '<div class="altrow" onclick="openNewRecipeForm()"><div class="ae">📖</div><div class="at"><div class="an">New recipe</div><div class="ad">Build a recipe from ingredients</div></div></div>'
    + '<div class="altrow" onclick="openFoodSearch()"><div class="ae">＋</div><div class="at"><div class="an">Log food</div><div class="ad">Quick-add something to today</div></div></div>'
    + '</div>';
  document.getElementById('sheet').classList.remove('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

function openLibraryHub(tabEl){
  renderLibraryHub();
  go('library', tabEl);
}

function buildFoodLibrarySheet(){
  return '<div class="row between" style="margin-top:6px"><h1 style="margin:0">Ingredients</h1><button class="backbtn" style="margin:0" onclick="openLibraryHub()">‹ Library</button></div>'
    + '<input class="inp" style="width:100%;box-sizing:border-box;border:1px solid var(--line);margin-top:8px" type="text" id="libFoodSearchInput" placeholder="Search ingredients…" value="' + htmlAttr(libFoodQuery) + '" oninput="onLibFoodSearchInput(this.value)" autocomplete="off">'
    + '<div id="libFoodFilterBar">' + renderLibFoodFilterBar() + '</div>'
    + '<button class="cta ghostbtn" style="margin-top:12px" onclick="openBarcodeScanner(true)">📷 Scan barcode</button>'
    + '<button class="cta ghostbtn" style="margin-top:12px" onclick="openNewFoodForm()">＋ New ingredient</button>'
    + '<div id="libFoodList" style="margin-top:4px">' + renderLibFoodListMarkup(libFoodQuery) + '</div>';
}

/* ===================================================================
   BARCODE IMPORT — packaged-product ingredients from Open Food Facts

   Flow:
   1. Camera preview via getUserMedia(), decoded with the native
      BarcodeDetector API where the browser exposes it.
   2. Manual barcode fallback stays visible because Safari/iOS support for
      native barcode detection is uneven even though camera access works.
   3. Product data comes from Open Food Facts API v3.6 and is saved into
      customFoods as a normal Mesa ingredient. Mesa still computes kcal
      from macros (4/4/9); the label kcal is preserved as metadata.
   =================================================================== */
let barcodeScannerState = {
  stream: null,
  detector: null,
  zxingReader: null,
  zxingControls: null,
  raf: null,
  busy: false,
  lastCode: null
};
let barcodeProductDraft = null;

function openBarcodeScanner(asPage){
  stopBarcodeScanner();
  barcodeProductDraft = null;
  const html = buildBarcodeScannerSheet('Starting camera…', !!asPage);
  if(asPage){
    setScannerScreenHtml(html);
  } else {
    document.getElementById('sheet').classList.add('tall');
    document.getElementById('sheetBackdrop').classList.add('show');
    document.getElementById('sheet').classList.add('show');
    document.getElementById('sheetBody').innerHTML = html;
  }
  startBarcodeScanner();
}

function buildBarcodeScannerSheet(status, asPage){
  const nativeSupported = 'BarcodeDetector' in window;
  const zxingSupported = !!(window.ZXingBrowser && window.ZXingBrowser.BrowserMultiFormatReader);
  return '<div class="row between" style="margin-top:6px"><h1 style="margin:0">Scan barcode</h1><button class="backbtn" style="margin:0" onclick="' + (asPage ? 'openLibraryHub()' : 'closeSheet()') + '">' + (asPage ? '‹ Library' : '✕ Close') + '</button></div>'
    + '<p class="sub" style="margin-top:8px">Fill the frame with the EAN/UPC barcode. Mesa imports the product as one ingredient from Open Food Facts.</p>'
    + '<div class="scanner-box" style="margin-top:12px">'
    + '<video id="barcodeVideo" class="scanner-video" autoplay muted playsinline></video>'
    + '<div class="scanner-frame" aria-hidden="true"></div>'
    + '</div>'
    + '<div class="cap-note" id="barcodeStatus" style="font-size:12px;margin-top:8px">' + escapeHtml(status || 'Point the camera at the barcode.') + '</div>'
    + (!nativeSupported && zxingSupported ? '<div class="cap-note" style="font-size:12px">Using Mesa’s fallback scanner for this browser.</div>' : '')
    + (!nativeSupported && !zxingSupported ? '<div class="cap-note" style="font-size:12px;color:#b25e35">This browser can use the camera, but automatic barcode decoding is not available. Type the number below.</div>' : '')
    + '<div class="field"><label>Barcode</label>'
    + '<input class="inp" id="barcodeManualInput" style="width:100%;box-sizing:border-box;border:1px solid var(--line);margin-top:6px" inputmode="numeric" pattern="[0-9]*" placeholder="e.g. 8000500037560" autocomplete="off" onkeydown="if(event.key===\'Enter\'){lookupBarcodeFromManualInput();}"></div>'
    + '<button class="cta" onclick="lookupBarcodeFromManualInput()">Look up product</button>'
    + '<button class="cta ghostbtn" onclick="openNewFoodForm()">Add manually instead</button>';
}

function setBarcodeStatus(msg){
  const el = document.getElementById('barcodeStatus');
  if(el) el.textContent = msg;
}

function stopBarcodeScanner(){
  if(barcodeScannerState.raf) cancelAnimationFrame(barcodeScannerState.raf);
  barcodeScannerState.raf = null;
  if(barcodeScannerState.zxingControls && typeof barcodeScannerState.zxingControls.stop === 'function'){
    barcodeScannerState.zxingControls.stop();
  }
  barcodeScannerState.zxingControls = null;
  barcodeScannerState.zxingReader = null;
  if(barcodeScannerState.stream){
    barcodeScannerState.stream.getTracks().forEach(function(track){ track.stop(); });
  }
  barcodeScannerState.stream = null;
  barcodeScannerState.detector = null;
  barcodeScannerState.busy = false;
}

function startBarcodeScanner(){
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    setBarcodeStatus('Camera is not available here. Enter the barcode manually.');
    return;
  }
  if(!('BarcodeDetector' in window) && window.ZXingBrowser && window.ZXingBrowser.BrowserMultiFormatReader){
    startZXingBarcodeScanner();
    return;
  }
  navigator.mediaDevices.getUserMedia({
    video: {facingMode: {ideal: 'environment'}, width: {ideal: 1280}, height: {ideal: 720}},
    audio: false
  }).then(function(stream){
    barcodeScannerState.stream = stream;
    const video = document.getElementById('barcodeVideo');
    if(!video) return;
    video.srcObject = stream;
    if('BarcodeDetector' in window){
      const formats = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
      barcodeScannerState.detector = new BarcodeDetector({formats: formats});
      video.onloadedmetadata = function(){
        video.play();
        setBarcodeStatus('Point the camera at the barcode.');
        scanBarcodeFrame();
      };
    } else {
      video.onloadedmetadata = function(){ video.play(); };
      setBarcodeStatus('Camera ready. Type the barcode below if it does not auto-detect.');
    }
  }).catch(function(){
    setBarcodeStatus('Camera permission was not available. Enter the barcode manually.');
  });
}

function startZXingBarcodeScanner(){
  const video = document.getElementById('barcodeVideo');
  if(!video) return;
  const reader = new ZXingBrowser.BrowserMultiFormatReader();
  barcodeScannerState.zxingReader = reader;
  reader.decodeFromConstraints({
    video: {facingMode: {ideal: 'environment'}, width: {ideal: 1280}, height: {ideal: 720}},
    audio: false
  }, video, function(result){
    if(!result || barcodeScannerState.busy) return;
    const code = normalizeBarcode(typeof result.getText === 'function' ? result.getText() : result.text);
    if(!code || code === barcodeScannerState.lastCode) return;
    barcodeScannerState.lastCode = code;
    const input = document.getElementById('barcodeManualInput');
    if(input) input.value = code;
    lookupBarcode(code);
  }).then(function(controls){
    barcodeScannerState.zxingControls = controls;
    setBarcodeStatus('Camera ready. Hold the barcode straight and fill the frame.');
  }).catch(function(){
    setBarcodeStatus('Camera permission was not available. Enter the barcode manually.');
  });
}

function scanBarcodeFrame(){
  const video = document.getElementById('barcodeVideo');
  if(!video || !barcodeScannerState.detector || barcodeScannerState.busy){
    barcodeScannerState.raf = requestAnimationFrame(scanBarcodeFrame);
    return;
  }
  if(video.readyState < 2){
    barcodeScannerState.raf = requestAnimationFrame(scanBarcodeFrame);
    return;
  }
  barcodeScannerState.detector.detect(video).then(function(codes){
    if(codes && codes.length){
      const code = normalizeBarcode(codes[0].rawValue);
      if(code && code !== barcodeScannerState.lastCode){
        barcodeScannerState.lastCode = code;
        const input = document.getElementById('barcodeManualInput');
        if(input) input.value = code;
        lookupBarcode(code);
        return;
      }
    }
    barcodeScannerState.raf = requestAnimationFrame(scanBarcodeFrame);
  }).catch(function(){
    setBarcodeStatus('Could not read this frame. You can type the barcode below.');
    barcodeScannerState.raf = requestAnimationFrame(scanBarcodeFrame);
  });
}

function normalizeBarcode(raw){
  return String(raw || '').replace(/\D/g, '').trim();
}

function lookupBarcodeFromManualInput(){
  const input = document.getElementById('barcodeManualInput');
  lookupBarcode(input ? input.value : '');
}

function lookupBarcode(raw){
  const barcode = normalizeBarcode(raw);
  if(barcode.length < 8){ toast('Enter the barcode number'); return; }
  const existingId = customFoodIdForBarcode(barcode);
  if(existingId){
    stopBarcodeScanner();
    toast('Already in your ingredients');
    openEditFoodForm(existingId);
    return;
  }
  barcodeScannerState.busy = true;
  setBarcodeStatus('Looking up ' + barcode + '…');
  const fields = [
    'code', 'product_name', 'product_name_it', 'generic_name', 'generic_name_it',
    'brands', 'quantity', 'categories', 'categories_tags', 'labels_tags',
    'countries', 'countries_tags', 'stores', 'ingredients_text', 'ingredients_text_it',
    'allergens_tags', 'traces_tags', 'additives_tags', 'nutriscore_grade', 'nova_group',
    'image_front_url', 'image_url', 'url', 'nutriments'
  ].join(',');
  fetchOpenFoodFactsProduct(barcode, fields).then(function(product){
    barcodeProductDraft = product;
    stopBarcodeScanner();
    renderBarcodeProductPreview();
  }).catch(function(err){
    barcodeScannerState.busy = false;
    setBarcodeStatus(err && err.message === 'missing nutrition'
      ? 'Product found, but it is missing macro data. Add it manually from the label.'
      : 'Product not found in Open Food Facts. Yuka may still know it from its own database. You can add it manually.');
    toast(err && err.message === 'missing nutrition' ? 'Missing nutrition data' : 'Product not found');
  });
}

function fetchOpenFoodFactsProduct(barcode, fields){
  // Some products have richer localized data than the global endpoint. Example:
  // 3387390331660 (Nesquik Conchigliette) has nutrition on it.openfoodfacts.org
  // while the same filtered world API response can return an empty nutriments object.
  const endpoints = [
    'https://it.openfoodfacts.org/api/v3/product/',
    'https://world.openfoodfacts.org/api/v3/product/',
    'https://world.openfoodfacts.org/api/v3.6/product/'
  ];
  let foundWithoutNutrition = false;

  function tryEndpoint(i){
    if(i >= endpoints.length){
      throw new Error(foundWithoutNutrition ? 'missing nutrition' : 'not found');
    }
    const url = endpoints[i] + encodeURIComponent(barcode) + '.json?fields=' + encodeURIComponent(fields);
    return fetch(url, {headers: {'Accept': 'application/json'}})
      .then(function(res){
        if(!res.ok) throw new Error('lookup failed');
        return res.json();
      })
      .then(function(json){
        if(!json || (json.status && json.status !== 'success') || !json.product){
          return tryEndpoint(i + 1);
        }
        const food = openFoodFactsProductToFood(json.product, barcode);
        if(food) return food;
        foundWithoutNutrition = true;
        return tryEndpoint(i + 1);
      })
      .catch(function(err){
        if(i >= endpoints.length - 1) throw err;
        return tryEndpoint(i + 1);
      });
  }

  return tryEndpoint(0);
}

function customFoodIdForBarcode(barcode){
  const code = normalizeBarcode(barcode);
  return Object.keys(customFoods).find(function(id){
    return customFoods[id] && normalizeBarcode(customFoods[id].barcode || customFoods[id].offBarcode) === code;
  }) || null;
}

function offNum(nutriments, key){
  if(!nutriments) return null;
  const candidates = [key + '_100g', key + '_serving', key];
  for(let i = 0; i < candidates.length; i++){
    const v = nutriments[candidates[i]];
    if(v === undefined || v === null || v === '') continue;
    const n = Number(String(v).replace(',', '.'));
    if(isFinite(n)) return Math.max(0, n);
  }
  return null;
}

function firstText(){
  for(let i = 0; i < arguments.length; i++){
    const v = arguments[i];
    if(typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function inferOffCategory(product){
  const hay = ((product.categories || '') + ' ' + (product.categories_tags || []).join(' ')).toLowerCase();
  if(/yogurt|yoghurt|cheese|milk|dairy|formaggi|latte|yogurt/.test(hay)) return 'Dairy';
  if(/fish|salmon|tuna|sardine|meat|chicken|turkey|beef|pork|egg|pesce|tonno|salmone|carne|pollo|uova/.test(hay)) return 'Protein';
  if(/vegetable|fruit|verdure|frutta|legume|legumi/.test(hay)) return 'Produce';
  if(/pasta|rice|cereal|flour|farina|riso|cereali/.test(hay)) return 'Pantry';
  if(/bread|bakery|pane|biscuit|cracker/.test(hay)) return 'Bakery';
  if(/frozen|surgelat/.test(hay)) return 'Frozen';
  return 'Pantry';
}

function inferOffFlags(product, food){
  const flags = [];
  const hay = [
    product.categories || '',
    (product.categories_tags || []).join(' '),
    (product.labels_tags || []).join(' '),
    (product.allergens_tags || []).join(' ')
  ].join(' ').toLowerCase();
  if((food.fiber || 0) >= 6) flags.push('highFiber');
  if(/gluten-free|senza-glutine|sans-gluten/.test(hay)) flags.push('glutenFree');
  if(/salmon|salmone|sardine|tuna|tonno|mackerel|sgombro|anchovy|acciug/.test(hay)) flags.push('omega3');
  if(/fermented|kefir|kimchi|sauerkraut|crauti|miso|tempeh/.test(hay)) flags.push('fermented');
  return flags;
}

function openFoodFactsProductToFood(product, barcode){
  const nutriments = product.nutriments || {};
  const protein = offNum(nutriments, 'proteins');
  const carbs = offNum(nutriments, 'carbohydrates');
  const fat = offNum(nutriments, 'fat');
  if(protein === null || carbs === null || fat === null) return null;
  const satFat = offNum(nutriments, 'saturated-fat') || 0;
  const fiber = offNum(nutriments, 'fiber') || 0;
  const labelKcal = offNum(nutriments, 'energy-kcal');
  const name = firstText(product.product_name_it, product.product_name, product.generic_name_it, product.generic_name, 'Product ' + barcode);
  const food = {
    name: name,
    per: 100, unit: 'g',
    kcal: Math.round(4 * protein + 4 * carbs + 9 * fat),
    protein: +protein.toFixed(1),
    carbs: +carbs.toFixed(1),
    fat: +fat.toFixed(1),
    satFat: +Math.min(satFat, fat).toFixed(1),
    fiber: +Math.min(fiber, carbs).toFixed(1),
    flags: [],
    cat: inferOffCategory(product),
    season: 'evergreen',
    src: 'Open Food Facts barcode ' + barcode + '; kcal computed by Mesa from label macros',
    barcode: barcode,
    offBarcode: barcode,
    offUrl: product.url || ('https://world.openfoodfacts.org/product/' + barcode),
    brand: firstText(product.brands),
    quantity: firstText(product.quantity),
    ingredientsText: firstText(product.ingredients_text_it, product.ingredients_text),
    labelKcal: labelKcal === null ? null : Math.round(labelKcal),
    nutriscore: firstText(product.nutriscore_grade).toUpperCase(),
    novaGroup: product.nova_group || null,
    countries: firstText(product.countries),
    stores: firstText(product.stores),
    imageUrl: product.image_front_url || product.image_url || '',
    allergens: Array.isArray(product.allergens_tags) ? product.allergens_tags.slice() : [],
    traces: Array.isArray(product.traces_tags) ? product.traces_tags.slice() : [],
    additives: Array.isArray(product.additives_tags) ? product.additives_tags.slice() : []
  };
  food.flags = inferOffFlags(product, food);
  return food;
}

function renderBarcodeProductPreview(){
  const f = barcodeProductDraft;
  const asPage = document.getElementById('libraryScanner') && document.getElementById('libraryScanner').classList.contains('active');
  if(!f){ openBarcodeScanner(asPage); return; }
  const labelDiff = (typeof f.labelKcal === 'number' && Math.abs(f.labelKcal - f.kcal) > 2)
    ? '<div class="cap-note">Label says ' + f.labelKcal + ' kcal / 100g; Mesa stores ' + f.kcal + ' kcal from 4/4/9 macros for internal consistency.</div>'
    : '';
  const html =
    '<div class="row between" style="margin-top:6px"><h1 style="margin:0">Product found</h1><button class="backbtn" style="margin:0" onclick="' + (asPage ? 'openLibraryHub()' : 'closeSheet()') + '">' + (asPage ? '‹ Library' : '✕ Close') + '</button></div>'
    + '<div class="card scanned-product-card">'
    + (f.imageUrl ? '<img class="scanned-product-img" src="' + htmlAttr(f.imageUrl) + '" alt="" loading="lazy">' : '<div class="ae">📦</div>')
    + '<div class="at"><div class="an">' + escapeHtml(f.name) + '</div>'
    + '<div class="ad">' + [f.brand, f.quantity, f.barcode].filter(Boolean).map(escapeHtml).join(' · ') + '</div></div>'
    + '</div>'
    + '<div class="nutri" style="margin-top:12px">'
    + '<div class="n"><div class="nt"><span>Calories</span><b>' + f.kcal + ' kcal</b></div></div>'
    + '<div class="n"><div class="nt"><span>Protein</span><b>' + f.protein + ' g</b></div></div>'
    + '<div class="n"><div class="nt"><span>Carbs</span><b>' + f.carbs + ' g</b></div></div>'
    + '<div class="n"><div class="nt"><span>Fat</span><b>' + f.fat + ' g</b></div></div>'
    + '</div>'
    + '<div class="sub" style="margin-top:8px">Per 100g · ' + escapeHtml(f.cat) + ' · ' + seasonLabel(foodSeason(f)) + (f.flags.length ? ' · ' + f.flags.map(flagLabel).join(', ') : '') + '</div>'
    + labelDiff
    + (f.ingredientsText ? '<div class="field"><label>Ingredients from label</label><div class="why" style="margin-top:6px">' + escapeHtml(f.ingredientsText) + '</div></div>' : '<p class="sub" style="margin-top:10px">No ingredient text was available for this product.</p>')
    + '<button class="cta" onclick="saveBarcodeProductAsFood()">Save ingredient</button>'
    + '<button class="cta ghostbtn" onclick="openBarcodeScanner(' + (asPage ? 'true' : 'false') + ')">Scan another</button>';
  if(asPage) setScannerScreenHtml(html);
  else document.getElementById('sheetBody').innerHTML = html;
}

function saveBarcodeProductAsFood(){
  const f = barcodeProductDraft;
  if(!f){ toast('No product to save'); return; }
  const existing = customFoodIdForBarcode(f.barcode);
  if(existing){ openEditFoodForm(existing); return; }
  let name = f.name;
  const lower = name.toLowerCase();
  const dupName = Object.keys(FOODS).some(function(id){ return FOODS[id].name.toLowerCase() === lower; });
  if(dupName && f.brand) name = name + ' · ' + f.brand;
  const id = uniqueSlug(slugify(name + '-' + f.barcode), FOODS, 'cf-');
  const saved = Object.assign({}, f, {name: name, season: foodSeason(f), u: Date.now()});
  if(deletedFoods[id]) delete deletedFoods[id];
  customFoods[id] = saved;
  customRev++;
  applyCustomFoods();
  applyProf(currentProf);
  renderFoodLibraryCount();
  barcodeProductDraft = null;
  toast('✓ ' + name + ' added');
  openFoodLibrary();
}

// One reusable chip button — pill visual language, but with the 44px min tap-target this
// sheet's non-form chips need (the same inline-style-override pattern the app already uses
// for other oversized pills, e.g. #calRestoreBtn) rather than a brand-new class.
function filterChipHtml(label, active, onclickJs){
  return '<button class="pill ghost chip-preset' + (active ? ' chipsel' : '') + '" style="min-height:44px;padding:0 14px" onclick="' + onclickJs + '">' + escapeHtml(label) + '</button>';
}

function filterActiveCount(filters){
  let n = 0;
  if(filters.cats) n += filters.cats.size;
  if(filters.flags) n += filters.flags.size;
  if(filters.slots) n += filters.slots.size;
  if(filters.tags) n += filters.tags.size;
  if(filters.seasons) n += filters.seasons.size;
  return n;
}

function filterSummaryChips(labels, clearFn){
  if(!labels.length) return '';
  return '<div class="filter-summary" aria-label="Active filters">'
    + labels.map(function(label){ return '<span class="pill mini gold">' + escapeHtml(label) + '</span>'; }).join('')
    + '<button class="filter-clear" onclick="' + clearFn + '">Clear</button>'
    + '</div>';
}

function countFilteredFoods(query){
  const byCat = libFoodIdsByCategory(query);
  return Object.keys(byCat).reduce(function(sum, c){ return sum + byCat[c].length; }, 0);
}

function renderLibFoodFilterBar(){
  const anyActive = libFoodFilters.cats.size > 0 || libFoodFilters.flags.size > 0 || libFoodFilters.seasons.size > 0;
  const activeCount = filterActiveCount(libFoodFilters);
  const labels = [];
  libFoodFilters.cats.forEach(function(c){ labels.push(c); });
  libFoodFilters.flags.forEach(function(fl){ labels.push(flagLabel(fl)); });
  libFoodFilters.seasons.forEach(function(s){ labels.push(seasonLabel(s)); });
  const count = countFilteredFoods(libFoodQuery);
  let html = '<div class="filter-compact">'
    + '<button class="filter-toggle" onclick="toggleLibFoodFiltersPanel()">' + (libFoodFiltersOpen ? 'Hide filters' : 'Filters') + (activeCount ? ' · ' + activeCount : '') + '</button>'
    + '<span class="sub" style="margin:0">' + count + ' ingredient' + (count === 1 ? '' : 's') + '</span>'
    + '</div>'
    + filterSummaryChips(labels, 'clearLibFoodFilters()');
  if(libFoodFiltersOpen){
    html += '<div class="filter-panel">'
      + '<div class="filter-label">Category</div>'
      + '<div class="row" style="gap:7px;flex-wrap:wrap">'
      + FOOD_CATEGORIES.map(function(c){ return filterChipHtml(c, libFoodFilters.cats.has(c), 'toggleLibFoodCatFilter(\'' + c + '\')'); }).join('')
      + '</div>'
      + '<div class="filter-label">Season</div>'
      + '<div class="row" style="gap:7px;flex-wrap:wrap">'
      + SEASON_VALUES.map(function(s){ return filterChipHtml(seasonLabel(s), libFoodFilters.seasons.has(s), 'toggleLibFoodSeasonFilter(\'' + s + '\')'); }).join('')
      + '</div>'
      + '<div class="filter-label">Tags</div>'
      + '<div class="row" style="gap:7px;flex-wrap:wrap">'
      + FOOD_FILTER_FLAGS.map(function(fl){ return filterChipHtml(flagLabel(fl), libFoodFilters.flags.has(fl), 'toggleLibFoodFlagFilter(\'' + fl + '\')'); }).join('')
      + '</div>'
      + (anyActive ? '<button class="filter-clear full" onclick="clearLibFoodFilters()">Clear filters</button>' : '')
      + '</div>';
  }
  return html;
}

function toggleLibFoodFiltersPanel(){
  libFoodFiltersOpen = !libFoodFiltersOpen;
  rerenderLibFoodFilteredView();
}

function toggleLibFoodCatFilter(cat){
  if(libFoodFilters.cats.has(cat)) libFoodFilters.cats.delete(cat); else libFoodFilters.cats.add(cat);
  rerenderLibFoodFilteredView();
}
function toggleLibFoodFlagFilter(fl){
  if(libFoodFilters.flags.has(fl)) libFoodFilters.flags.delete(fl); else libFoodFilters.flags.add(fl);
  rerenderLibFoodFilteredView();
}
function toggleLibFoodSeasonFilter(season){
  season = normalizeSeason(season);
  if(libFoodFilters.seasons.has(season)) libFoodFilters.seasons.delete(season); else libFoodFilters.seasons.add(season);
  rerenderLibFoodFilteredView();
}
function clearLibFoodFilters(){
  libFoodFilters = {cats: new Set(), flags: new Set(), seasons: new Set()};
  libFoodFiltersOpen = false;
  rerenderLibFoodFilteredView();
}
// Live re-render on toggle (same "re-render in place" pattern as onLibFoodSearchInput):
// repaints both the filter bar (chip on/off + count/Clear) and the list below it.
function rerenderLibFoodFilteredView(){
  const bar = document.getElementById('libFoodFilterBar');
  if(bar) bar.innerHTML = renderLibFoodFilterBar();
  const list = document.getElementById('libFoodList');
  if(list) list.innerHTML = renderLibFoodListMarkup(libFoodQuery);
}

// Extended (task T5) to also drop foods failing the active category set (OR across
// categories — a food has exactly one) or missing any active flag (AND across flags,
// documented choice per the task brief) — combined with the existing text search.
function libFoodIdsByCategory(query){
  const q = (query || '').trim().toLowerCase();
  const byCat = {};
  Object.keys(FOODS).forEach(function(id){
    const food = FOODS[id];
    if(q && food.name.toLowerCase().indexOf(q) === -1) return;
    if(libFoodFilters.cats.size && !libFoodFilters.cats.has(food.cat)) return;
    if(libFoodFilters.seasons.size && !libFoodFilters.seasons.has(foodSeason(food))) return;
    if(libFoodFilters.flags.size){
      const flags = food.flags || [];
      let hasAll = true;
      libFoodFilters.flags.forEach(function(fl){ if(flags.indexOf(fl) === -1) hasAll = false; });
      if(!hasAll) return;
    }
    (byCat[food.cat] = byCat[food.cat] || []).push(id);
  });
  return byCat;
}

function renderLibFoodListMarkup(query){
  const byCat = libFoodIdsByCategory(query);
  let out = '';
  SHOP_CAT_ORDER.forEach(function(cat){
    const ids = byCat[cat];
    if(!ids || !ids.length) return;
    ids.sort(function(a, b){ return FOODS[a].name < FOODS[b].name ? -1 : (FOODS[a].name > FOODS[b].name ? 1 : 0); });
    out += '<div class="shop-cat">' + cat + '</div>';
    ids.forEach(function(id){
      const f = FOODS[id];
      const isCustom = !!customFoods[id];
      const isEdited = !isCustom && !!foodOverrides[id];
      const kcalPer100 = f.unit === 'piece' ? Math.round(f.kcal / f.avgG * 100) : Math.round(f.kcal);
      const factor = f.unit === 'piece' ? (100 / f.avgG) : (100 / f.per);
      const macroLine = Math.round((f.protein || 0) * factor) + 'g P · '
        + Math.round((f.carbs || 0) * factor) + 'g C · '
        + Math.round((f.fat || 0) * factor) + 'g F · '
        + Math.round((f.fiber || 0) * factor) + 'g fiber / 100' + (f.unit === 'piece' ? 'g' : f.unit);
      out += '<div class="altrow" style="cursor:default">'
        + '<div class="ae">' + foodIconHtml(id, '🥕') + '</div>'
        + '<div class="at"><div class="an">' + escapeHtml(f.name) + (isCustom ? ' <span class="pill mini gold">yours</span>' : '') + (isEdited ? ' <span class="pill mini terra">edited</span>' : '') + '</div>'
        + '<div class="ad">' + kcalPer100 + ' kcal · ' + macroLine + ' · ' + seasonLabel(foodSeason(f)) + '</div></div>'
        + '<button class="lib-edit" aria-label="Edit ' + htmlAttr(f.name) + '" onclick="openEditFoodForm(\'' + id + '\')">✎</button>'
        + (isEdited ? '<button class="lib-del" aria-label="Reset ' + htmlAttr(f.name) + '" onclick="resetFoodOverride(\'' + id + '\')">↺</button>' : '')
        + (isCustom ? '<button class="lib-del" aria-label="Delete ' + htmlAttr(f.name) + '" onclick="deleteCustomFood(\'' + id + '\')">✕</button>' : '')
        + '</div>';
    });
  });
  return out || '<p class="sub" style="margin-top:10px">No ingredients match your search or filters.</p>';
}

function onLibFoodSearchInput(v){
  libFoodQuery = v;
  const el = document.getElementById('libFoodList');
  if(el) el.innerHTML = renderLibFoodListMarkup(v);
}

/* ---------------- new ingredient form ---------------- */
const FOOD_CATEGORIES = ['Produce', 'Protein', 'Dairy', 'Pantry', 'Bakery', 'Frozen']; // matches data/foods.js ALLOWED_CATS
const FOOD_FORM_FLAGS = ['lowGI', 'omega3', 'highFiber', 'glutenFree']; // offered when hand-authoring a new custom ingredient
// T5: extended with selenium/highIodine/fermented — the rest of data/foods.js's flag
// vocabulary, needed for the Ingredients sheet's tag filter (FOOD_FILTER_FLAGS above)
// even though the new-ingredient form only offers the original 4.
const FOOD_FLAG_LABELS = {lowGI: 'Low-GI', omega3: 'Omega-3', highFiber: 'High fiber', glutenFree: 'Gluten-free', selenium: 'Selenium', highIodine: 'High iodine', fermented: 'Fermented'};
function flagLabel(fl){ return FOOD_FLAG_LABELS[fl] || fl; }

let newFoodForm = null;

function openNewFoodForm(){
  newFoodForm = {editingId: null, name: '', cat: 'Produce', season: 'evergreen', protein: 0, carbs: 0, fat: 0, satFat: 0, fiber: 0, flags: []};
  renderNewFoodFormSheet();
}

function openEditFoodForm(id){
  const f = FOODS[id];
  if(!f){ toast('Ingredient not found'); return; }
  const factor = f.unit === 'piece' && f.avgG ? (100 / f.avgG) : (100 / (f.per || 100));
  newFoodForm = {
    editingId: id,
    name: f.name || '',
    cat: f.cat || 'Produce',
    season: foodSeason(f),
    protein: +((f.protein || 0) * factor).toFixed(1),
    carbs: +((f.carbs || 0) * factor).toFixed(1),
    fat: +((f.fat || 0) * factor).toFixed(1),
    satFat: +((f.satFat || 0) * factor).toFixed(1),
    fiber: +((f.fiber || 0) * factor).toFixed(1),
    flags: Array.isArray(f.flags) ? f.flags.slice() : []
  };
  renderNewFoodFormSheet();
}
function renderNewFoodFormSheet(){ setIngredientsScreenHtml(buildNewFoodFormSheet()); }

function computeNewFoodKcal(f){ return Math.round(4 * f.protein + 4 * f.carbs + 9 * f.fat); }

function newFoodCapNotes(f){
  const notes = [];
  if(f.satFat > f.fat + 1e-9) notes.push('Sat. fat can’t be more than total fat.');
  if(f.fiber > f.carbs + 1e-9) notes.push('Fiber can’t be more than total carbs.');
  if(f.protein + f.carbs + f.fat > 100 + 1e-9) notes.push('Protein + carbs + fat can’t add up to more than 100g per 100g.');
  return notes;
}

function buildNewFoodFormSheet(){
  const f = newFoodForm;
  const kcal = computeNewFoodKcal(f);
  const editing = !!f.editingId;
  let html = '<div class="row between" style="margin-top:6px"><h2 style="margin:0">' + (editing ? 'Edit ingredient' : 'New ingredient') + '</h2><button class="backbtn" style="margin:0" onclick="openFoodLibrary()">‹ Back</button></div>';

  html += '<div class="field"><label>Name</label>'
    + '<input class="inp" style="width:100%;box-sizing:border-box;border:1px solid var(--line);margin-top:6px" type="text" value="' + htmlAttr(f.name) + '" oninput="newFoodForm.name=this.value" placeholder="e.g. Tempeh" autocomplete="off"></div>';

  html += '<div class="field"><label>Category</label><div class="row" style="gap:7px;flex-wrap:wrap;margin-top:6px">'
    + FOOD_CATEGORIES.map(function(c){ return '<button class="pill ghost chip-preset' + (f.cat === c ? ' chipsel' : '') + '" onclick="setNewFoodCat(\'' + c + '\')">' + c + '</button>'; }).join('')
    + '</div></div>';

  html += '<div class="field"><label>Season</label><div class="row" style="gap:7px;flex-wrap:wrap;margin-top:6px">'
    + SEASON_VALUES.map(function(s){ return '<button class="pill ghost chip-preset' + (normalizeSeason(f.season) === s ? ' chipsel' : '') + '" onclick="setNewFoodSeason(\'' + s + '\')">' + seasonLabel(s) + '</button>'; }).join('')
    + '</div></div>';

  // FIX 2 (feedback, owner: "prova a creare un ingrediente con 100 calorie usando il +…
  // permetti di scrivere direttamente l'importo… anche i decimali (es: 7,4 grassi)"): each
  // value is now a typeable input (comma OR dot decimals, commitNewFoodField below), flanked
  // by the same +/- steppers as before.
  [['protein', 'Protein'], ['carbs', 'Carbs'], ['fat', 'Fat'], ['satFat', 'Sat. fat'], ['fiber', 'Fiber']].forEach(function(pair){
    const key = pair[0], label = pair[1];
    html += '<div class="field"><label>' + label + ' (g / 100g)</label><div class="inp">'
      + '<span>' + label + '</span>'
      + '<span class="sv-stepper" style="margin:0">'
      + '<button onclick="stepNewFoodField(\'' + key + '\',-1)" aria-label="Decrease ' + label + '">–</button>'
      + '<input class="sv-val" type="text" inputmode="decimal" value="' + f[key] + '" onfocus="this.select()" onkeydown="if(event.key===\'Enter\'){this.blur();}" onblur="commitNewFoodField(\'' + key + '\',this.value)" aria-label="' + label + ' grams per 100 grams">'
      + '<span class="sv-unit">g</span>'
      + '<button onclick="stepNewFoodField(\'' + key + '\',1)" aria-label="Increase ' + label + '">+</button>'
      + '</span></div></div>';
  });

  html += '<div class="field"><label>Calories <span class="chip-computed">✓ computed</span></label><div class="inp"><span>Calories / 100g</span><b>' + kcal + ' kcal</b></div>'
    + '<div class="cap-note">4×protein + 4×carbs + 9×fat — never typed in.</div></div>';

  const notes = newFoodCapNotes(f);
  if(notes.length) html += '<div class="cap-note" style="color:#b25e35;margin-top:2px">' + notes.join(' ') + '</div>';

  html += '<div class="field"><label>Flags (optional)</label><div class="row" style="gap:7px;flex-wrap:wrap;margin-top:6px">'
    + FOOD_FORM_FLAGS.map(function(fl){ return '<button class="pill ghost chip-preset' + (f.flags.indexOf(fl) !== -1 ? ' chipsel' : '') + '" onclick="toggleNewFoodFlag(\'' + fl + '\')">' + flagLabel(fl) + '</button>'; }).join('')
    + '</div></div>';

  html += '<button class="cta" onclick="saveNewFood()">' + (editing ? 'Save changes' : 'Save ingredient') + '</button>'
    + '<button class="cta ghostbtn" onclick="openFoodLibrary()">Cancel</button>';
  return html;
}

function setNewFoodCat(c){ newFoodForm.cat = c; renderNewFoodFormSheet(); }
function setNewFoodSeason(season){ newFoodForm.season = normalizeSeason(season); renderNewFoodFormSheet(); }
function toggleNewFoodFlag(fl){
  const i = newFoodForm.flags.indexOf(fl);
  if(i === -1) newFoodForm.flags.push(fl); else newFoodForm.flags.splice(i, 1);
  renderNewFoodFormSheet();
}
function stepNewFoodField(key, delta){
  newFoodForm[key] = Math.max(0, Math.min(100, +(newFoodForm[key] + delta).toFixed(1)));
  renderNewFoodFormSheet();
}

// FIX 2 (feedback): typed macro value, 0–100g/100g with 1 decimal, comma OR dot accepted
// ("7,4" -> 7.4). Invalid text (empty, "abc") or a negative number ("-3") reverts to the
// previous value with a toast rather than guessing; the satFat<=fat / fiber<=carbs / sum<=100
// cross-field checks are unchanged — they still run at save time (saveNewFood) and their
// live cap-note already re-derives on every renderNewFoodFormSheet() this triggers.
function commitNewFoodField(key, raw){
  const n = parseDecimalInput(raw);
  if(n === null || n < 0){ toast('Enter a number, e.g. 7.4 or 7,4'); renderNewFoodFormSheet(); return; }
  newFoodForm[key] = Math.max(0, Math.min(100, +n.toFixed(1)));
  renderNewFoodFormSheet();
}

function saveNewFood(){
  const f = newFoodForm;
  const name = (f.name || '').trim();
  if(!name){ toast('Give this ingredient a name'); return; }
  const lower = name.toLowerCase();
  const dup = Object.keys(FOODS).some(function(id){ return id !== f.editingId && FOODS[id].name.toLowerCase() === lower; });
  if(dup){ toast('“' + name + '” already exists — try a different name'); return; }
  if(f.protein < 0 || f.carbs < 0 || f.fat < 0 || f.satFat < 0 || f.fiber < 0){ toast('Values must be zero or more'); return; }
  if(f.satFat > f.fat + 1e-9){ toast('Sat. fat can’t exceed total fat'); return; }
  if(f.fiber > f.carbs + 1e-9){ toast('Fiber can’t exceed total carbs'); return; }
  if(f.protein + f.carbs + f.fat > 100 + 1e-9){ toast('Protein + carbs + fat can’t exceed 100g per 100g'); return; }

  const id = f.editingId || uniqueSlug(slugify(name), FOODS, 'cf-');
  const kcal = computeNewFoodKcal(f);
  if(deletedFoods[id]) delete deletedFoods[id]; // recreate-after-delete: this save's `u` below beats the tombstone (js/sync.js:mergeLibrarySection)
  const existing = FOODS[id] || {};
  const saved = Object.assign({}, existing, {
    name: name, per: 100, unit: 'g',
    kcal: kcal, protein: f.protein, carbs: f.carbs, fat: f.fat, satFat: f.satFat, fiber: f.fiber,
    flags: f.flags.slice(), cat: f.cat, season: normalizeSeason(f.season), src: 'User-added ingredient',
    u: Date.now() // couple-sync newer-wins stamp (js/sync.js:mergeEntryMap) — see state.js's doc block
  });
  delete saved.avgG;
  if(id.indexOf('cf-') === 0) customFoods[id] = saved;
  else foodOverrides[id] = saved;
  customRev++;
  applyCustomFoods();
  applyProf(currentProf); // refreshes library-derived UI without resetting the existing plan
  toast('✓ ' + name + (f.editingId ? ' updated' : ' added') + ' — ' + kcal + ' kcal / 100g');
  newFoodForm = null;
  openFoodLibrary();
  renderFoodLibraryCount();
}

function resetFoodOverride(id){
  if(!foodOverrides[id]) return;
  const name = foodOverrides[id].name || (BUILTIN_FOODS_DB[id] && BUILTIN_FOODS_DB[id].name) || 'ingredient';
  delete foodOverrides[id];
  customRev++;
  applyCustomFoods();
  applyProf(currentProf);
  toast('✓ Reset ' + name);
  renderFoodLibraryCount();
  if(document.getElementById('libraryIngredients') && document.getElementById('libraryIngredients').classList.contains('active')) openFoodLibrary();
}

function deleteCustomFood(id){
  if(!customFoods[id]) return;
  const usedBy = Object.keys(RECIPES_DB).filter(function(rid){
    return (RECIPES_DB[rid].ingredients || []).some(function(ing){ return ing[0] === id; });
  });
  if(usedBy.length){
    const names = usedBy.map(function(rid){ return RECIPES_DB[rid].title; }).join(', ');
    toast('Can’t delete — used in ' + names + '. Delete that recipe first.');
    return;
  }
  const name = customFoods[id].name;
  delete customFoods[id];
  deletedFoods[id] = Date.now(); // tombstone so couple-sync's per-id merge doesn't resurrect it (js/sync.js:mergeLibrarySection)
  customRev++;
  applyCustomFoods();
  applyProf(currentProf);
  toast('✓ Deleted ' + name);
  renderFoodLibraryCount();
  if(document.getElementById('libraryIngredients') && document.getElementById('libraryIngredients').classList.contains('active')) openFoodLibrary();
}

/* ===================================================================
   FEATURE 2 — My recipes sheet + builder
   =================================================================== */
/* ---------------- T5: Recipes sheet — meal-slot/tag filter chips ----------------
   Same pattern as the Ingredients sheet's filters above: Meal (slot) is OR'd (a recipe
   can carry multiple slots), Tag is AND'd (recipe must carry every active tag). Combines with
   the (currently absent) implicit "all recipes" list — no separate search box exists here,
   so filters are the only narrowing. View-only: reset every time the sheet opens. */
let libRecipeFilters = {query: '', slots: new Set(), tags: new Set(), seasons: new Set()};
let libRecipeFiltersOpen = false;

function openMyRecipes(){
  libRecipeFilters = {query: '', slots: new Set(), tags: new Set(), seasons: new Set()};
  libRecipeFiltersOpen = false;
  setRecipesScreenHtml(buildMyRecipesSheet());
}

function filteredRecipeIds(){
  return Object.keys(RECIPES_DB).filter(function(id){
    const r = RECIPES_DB[id];
    const q = (libRecipeFilters.query || '').trim().toLowerCase();
    if(q.length){
      const haystack = [
        r.title,
        id,
        recipeSlotList(r).map(function(s){ return SLOT_LABEL[s] || s; }).join(' '),
        seasonLabel(recipeSeason(r)),
        (r.tags || []).join(' '),
        (r.styles || []).join(' ')
      ].join(' ').toLowerCase();
      if(haystack.indexOf(q) === -1) return false;
    }
    if(libRecipeFilters.slots.size){
      const slots = recipeSlotList(r);
      let hasSlot = false;
      libRecipeFilters.slots.forEach(function(slot){ if(slots.indexOf(slot) !== -1) hasSlot = true; });
      if(!hasSlot) return false;
    }
    if(libRecipeFilters.tags.size){
      const tags = r.tags || [];
      let hasAll = true;
      libRecipeFilters.tags.forEach(function(t){ if(tags.indexOf(t) === -1) hasAll = false; });
      if(!hasAll) return false;
    }
    if(libRecipeFilters.seasons.size && !libRecipeFilters.seasons.has(recipeSeason(r))) return false;
    return true;
  }).sort(function(a, b){
    const aFav = recipePrefs[a] === 'favorite';
    const bFav = recipePrefs[b] === 'favorite';
    if(aFav !== bFav) return aFav ? -1 : 1;
    return RECIPES_DB[a].title < RECIPES_DB[b].title ? -1 : (RECIPES_DB[a].title > RECIPES_DB[b].title ? 1 : 0);
  });
}

function renderLibRecipeFilterBar(){
  const anyActive = (libRecipeFilters.query || '').trim().length > 0 || libRecipeFilters.slots.size > 0 || libRecipeFilters.tags.size > 0 || libRecipeFilters.seasons.size > 0;
  const activeCount = filterActiveCount(libRecipeFilters);
  const labels = [];
  libRecipeFilters.slots.forEach(function(s){ labels.push(SLOT_LABEL[s] || s); });
  libRecipeFilters.tags.forEach(function(t){ labels.push(tagLabelForPreview(t)); });
  libRecipeFilters.seasons.forEach(function(s){ labels.push(seasonLabel(s)); });
  const n = filteredRecipeIds().length;
  let html = '<input class="inp" style="width:100%;box-sizing:border-box;border:1px solid var(--line);margin-top:10px" type="text" id="libRecipeSearchInput" placeholder="Search recipes…" value="' + htmlAttr(libRecipeFilters.query || '') + '" oninput="onLibRecipeSearchInput(this.value)" autocomplete="off">'
    + '<div class="filter-compact">'
    + '<button class="filter-toggle" onclick="toggleLibRecipeFiltersPanel()">' + (libRecipeFiltersOpen ? 'Hide filters' : 'Filters') + (activeCount ? ' · ' + activeCount : '') + '</button>'
    + '<span class="sub" style="margin:0">' + n + ' recipe' + (n === 1 ? '' : 's') + '</span>'
    + '</div>'
    + filterSummaryChips(labels, 'clearLibRecipeFilters()');
  if(libRecipeFiltersOpen){
    html += '<div class="filter-panel">'
      + '<div class="filter-label">Meal</div>'
      + '<div class="row" style="gap:7px;flex-wrap:wrap">'
      + RECIPE_SLOTS.map(function(s){ return filterChipHtml(SLOT_LABEL[s], libRecipeFilters.slots.has(s), 'toggleLibRecipeSlotFilter(\'' + s + '\')'); }).join('')
      + '</div>'
      + '<div class="filter-label">Season</div>'
      + '<div class="row" style="gap:7px;flex-wrap:wrap">'
      + SEASON_VALUES.map(function(s){ return filterChipHtml(seasonLabel(s), libRecipeFilters.seasons.has(s), 'toggleLibRecipeSeasonFilter(\'' + s + '\')'); }).join('')
      + '</div>'
      + '<div class="filter-label">Tags</div>'
      + '<div class="row" style="gap:7px;flex-wrap:wrap">'
      + VALID_TAGS.map(function(t){ return filterChipHtml(tagLabelForPreview(t), libRecipeFilters.tags.has(t), 'toggleLibRecipeTagFilter(\'' + t + '\')'); }).join('')
      + '</div>'
      + (anyActive ? '<button class="filter-clear full" onclick="clearLibRecipeFilters()">Clear filters</button>' : '')
      + '</div>';
  }
  return html;
}

function toggleLibRecipeFiltersPanel(){
  libRecipeFiltersOpen = !libRecipeFiltersOpen;
  rerenderLibRecipeFilteredView();
}

function toggleLibRecipeSlotFilter(slot){
  if(libRecipeFilters.slots.has(slot)) libRecipeFilters.slots.delete(slot); else libRecipeFilters.slots.add(slot);
  rerenderLibRecipeFilteredView();
}
function onLibRecipeSearchInput(value){
  libRecipeFilters.query = value;
  rerenderLibRecipeFilteredView();
  const input = document.getElementById('libRecipeSearchInput');
  if(input) input.focus();
}
function toggleLibRecipeTagFilter(tag){
  if(libRecipeFilters.tags.has(tag)) libRecipeFilters.tags.delete(tag); else libRecipeFilters.tags.add(tag);
  rerenderLibRecipeFilteredView();
}
function toggleLibRecipeSeasonFilter(season){
  season = normalizeSeason(season);
  if(libRecipeFilters.seasons.has(season)) libRecipeFilters.seasons.delete(season); else libRecipeFilters.seasons.add(season);
  rerenderLibRecipeFilteredView();
}
function clearLibRecipeFilters(){
  libRecipeFilters = {query: '', slots: new Set(), tags: new Set(), seasons: new Set()};
  libRecipeFiltersOpen = false;
  rerenderLibRecipeFilteredView();
}
function rerenderLibRecipeFilteredView(){
  const bar = document.getElementById('libRecipeFilterBar');
  if(bar) bar.innerHTML = renderLibRecipeFilterBar();
  const list = document.getElementById('libRecipeList');
  if(list) list.innerHTML = renderLibRecipeListMarkup();
}

function renderLibRecipeListMarkup(){
  const ids = filteredRecipeIds();
  if(!ids.length){
    const anyActive = libRecipeFilters.slots.size > 0 || libRecipeFilters.tags.size > 0 || libRecipeFilters.seasons.size > 0;
    return '<p class="sub" style="margin-top:14px">' + (anyActive
      ? 'No recipes match your filters.'
      : 'No recipes available — tap ＋ New recipe to add one. It’ll show up here and in the planner automatically.') + '</p>';
  }
  return '<div style="margin-top:4px">' + ids.map(function(id){
    const r = RECIPES_DB[id];
    const nut = recipeNutrition(id, 1).totals;
    const badge = customRecipes[id] ? ' <span class="pill mini gold">yours</span>' : (recipeOverrides[id] ? ' <span class="pill mini terra">edited</span>' : '');
    const slotLabel = recipeSlotList(r).map(function(s){ return SLOT_LABEL[s] || s; }).join(' / ');
    const pref = recipePrefs[id] || null;
    return '<div class="altrow" style="cursor:default"><div class="ae">' + r.emoji + '</div>'
      + '<div class="at"><div class="an">' + escapeHtml(r.title) + badge + '</div>'
      + '<div class="ad">' + slotLabel + ' · ' + seasonLabel(recipeSeason(r)) + ' · ' + Math.round(nut.kcal) + ' kcal · ' + Math.round(nut.protein) + 'g protein</div></div>'
      + '<div class="lib-recipe-actions">'
      + '<button class="lib-edit' + (pref === 'favorite' ? ' is-pref' : '') + '" aria-label="Favorite ' + htmlAttr(r.title) + '" onclick="toggleRecipePref(\'' + id + '\',\'favorite\')">♡</button>'
      + '<button class="lib-edit' + (pref === 'down' ? ' is-pref' : '') + '" aria-label="Thumbs down ' + htmlAttr(r.title) + '" onclick="toggleRecipePref(\'' + id + '\',\'down\')">👎</button>'
      + '<button class="lib-edit" aria-label="Edit ' + htmlAttr(r.title) + '" onclick="openEditRecipeForm(\'' + id + '\')">✎</button>'
      + '<button class="lib-del" aria-label="Delete ' + htmlAttr(r.title) + '" onclick="deleteRecipe(\'' + id + '\')">✕</button>'
      + '</div>'
      + '</div>';
  }).join('') + '</div>';
}

function toggleRecipePref(id, pref){
  if(!RECIPES_DB[id]) return;
  if(recipePrefs[id] === pref) delete recipePrefs[id];
  else recipePrefs[id] = pref;
  customRev++;
  persist();
  rerenderLibRecipeFilteredView();
}

function buildMyRecipesSheet(){
  let html = '<div class="row between" style="margin-top:6px"><h1 style="margin:0">Recipes</h1><button class="backbtn" style="margin:0" onclick="openLibraryHub()">‹ Library</button></div>'
    + '<button class="cta ghostbtn" style="margin-top:10px" onclick="openNewRecipeForm()">＋ New recipe</button>'
    + '<div id="libRecipeFilterBar">' + renderLibRecipeFilterBar() + '</div>';
  if(!Object.keys(RECIPES_DB).length){
    html += '<p class="sub" style="margin-top:14px">No recipes available — tap ＋ New recipe to add one. It’ll show up here and in the planner automatically.</p>';
    return html;
  }
  html += '<div id="libRecipeList">' + renderLibRecipeListMarkup() + '</div>';
  return html;
}

function deleteRecipe(id){
  const r = RECIPES_DB[id] || customRecipes[id] || recipeOverrides[id] || BUILTIN_RECIPES_DB[id];
  if(!r) return;
  const title = r.title;
  // Both branches tombstone: without it, couple-sync's per-id merge (js/sync.js:
  // mergeLibrarySection) is a plain union and would resurrect the delete from whichever
  // phone hasn't seen it yet — exactly the "clone under a freeConflictId every sync round"
  // ratchet this fix targets. applyCustomRecipes() already treats deletedRecipes[id] as
  // "hide this id" for BOTH built-in-override and custom (cr-) ids (see the function above).
  if(customRecipes[id]) delete customRecipes[id];
  else if(recipeOverrides[id]) delete recipeOverrides[id];
  deletedRecipes[id] = Date.now();
  customRev++;
  applyCustomRecipes();
  applyProf(currentProf); // refreshes library-derived UI without resetting the existing plan
  toast('✓ Deleted ' + title);
  renderFoodLibraryCount();
  if(document.getElementById('libraryRecipes') && document.getElementById('libraryRecipes').classList.contains('active')) openMyRecipes();
}

/* ---------------- recipe builder ---------------- */
const RECIPE_SLOTS = ['breakfast', 'lunch', 'dinner', 'snack', 'side'];
let recipeBuilder = null;

function recipeToBuilder(id){
  const r = RECIPES_DB[id];
  if(!r) return null;
  return {
    editingId: id,
    name: r.title || '',
    emoji: r.emoji || '🍽️',
    slots: recipeSlotList(r).length ? recipeSlotList(r) : [r.slot || 'dinner'],
    season: recipeSeason(r),
    time: r.time || 20,
    servings: r.servings || 1,
    ingredients: (r.ingredients || []).map(function(ing){ return {foodId: ing[0], grams: ing[1]}; }),
    stepsText: (r.steps || []).join('\n'),
    pickerQuery: ''
  };
}

function openNewRecipeForm(){
  recipeBuilder = {name: '', emoji: '🍽️', slots: ['dinner'], season: 'evergreen', time: 20, servings: 1, ingredients: [], stepsText: '', pickerQuery: ''};
  renderRecipeBuilderSheet();
}

function openEditRecipeForm(id){
  const draft = recipeToBuilder(id);
  if(!draft){ toast('Recipe not found'); return; }
  recipeBuilder = draft;
  renderRecipeBuilderSheet();
}

function renderRecipeBuilderSheet(){ setRecipesScreenHtml(buildRecipeBuilderSheet()); }

function computeBuilderTotals(){
  const totals = {kcal: 0, protein: 0, carbs: 0, fat: 0, satFat: 0, fiber: 0};
  (recipeBuilder ? recipeBuilder.ingredients : []).forEach(function(row){
    const m = foodMacros(row.foodId, row.grams);
    totals.kcal += m.kcal; totals.protein += m.protein; totals.carbs += m.carbs;
    totals.fat += m.fat; totals.satFat += m.satFat; totals.fiber += m.fiber;
  });
  totals.kcal = 4 * totals.protein + 4 * totals.carbs + 9 * totals.fat; // same 4/4/9 self-consistency as recipeNutrition()
  return totals;
}

function buildRecipeBuilderSheet(){
  const rb = recipeBuilder;
  const totals = computeBuilderTotals();
  // The ingredient list is the whole batch; every displayed/derived number below is
  // per serving (batch / rb.servings) — same convention as engine.js:recipeNutrition().
  const perServing = {};
  Object.keys(totals).forEach(function(k){ perServing[k] = totals[k] / (rb.servings || 1); });
  const perServingIngredients = rb.ingredients.map(function(row){
    return {foodId: row.foodId, grams: row.grams / (rb.servings || 1)};
  });
  const meta = deriveRecipeMeta(perServingIngredients, perServing, rb.time);

  const editing = !!rb.editingId;
  let html = '<div class="row between" style="margin-top:6px"><h2 style="margin:0">' + (editing ? 'Edit recipe' : 'New recipe') + '</h2><button class="backbtn" style="margin:0" onclick="openMyRecipes()">‹ Back</button></div>';

  html += '<div class="field"><label>Name</label>'
    + '<input class="inp" style="width:100%;box-sizing:border-box;border:1px solid var(--line);margin-top:6px" type="text" value="' + htmlAttr(rb.name) + '" oninput="recipeBuilder.name=this.value" placeholder="e.g. Tempeh bowl" autocomplete="off"></div>';

  html += '<div class="field"><label>Emoji</label>'
    + '<input class="inp" style="width:64px;box-sizing:border-box;border:1px solid var(--line);margin-top:6px;text-align:center;font-size:19px" type="text" maxlength="4" value="' + htmlAttr(rb.emoji) + '" oninput="recipeBuilder.emoji=this.value"></div>';

  html += '<div class="field"><label>Meal slots</label><div class="row" style="gap:7px;flex-wrap:wrap;margin-top:6px">'
    + RECIPE_SLOTS.map(function(s){ return '<button class="pill ghost chip-preset' + (rb.slots.indexOf(s) !== -1 ? ' chipsel' : '') + '" onclick="toggleRecipeSlot(\'' + s + '\')">' + SLOT_LABEL[s] + '</button>'; }).join('')
    + '</div><div class="sub" style="margin-top:4px">Pick every meal this recipe can work for. The first selected slot stays primary for old plans.</div></div>';

  html += '<div class="field"><label>Season</label><div class="row" style="gap:7px;flex-wrap:wrap;margin-top:6px">'
    + SEASON_VALUES.map(function(s){ return '<button class="pill ghost chip-preset' + (normalizeSeason(rb.season) === s ? ' chipsel' : '') + '" onclick="setRecipeBuilderSeason(\'' + s + '\')">' + seasonLabel(s) + '</button>'; }).join('')
    + '</div><div class="sub" style="margin-top:4px">Evergreen is always eligible; the seasonal tags limit automatic planning/re-balance to the current season.</div></div>';

  html += '<div class="field"><label>Prep time</label><div class="inp"><span>Minutes</span>'
    + '<span class="sv-stepper" style="margin:0">'
    + '<button onclick="stepRecipeTime(-5)" aria-label="Decrease time">–</button><span class="sv-val">' + rb.time + ' min</span>'
    + '<button onclick="stepRecipeTime(5)" aria-label="Increase time">+</button></span></div></div>';

  html += '<div class="field"><label>Makes</label><div class="inp"><span>Servings</span>'
    + '<span class="sv-stepper" style="margin:0">'
    + '<button onclick="stepRecipeServings(-1)" aria-label="Decrease servings">–</button><span class="sv-val">' + rb.servings + '</span>'
    + '<button onclick="stepRecipeServings(1)" aria-label="Increase servings">+</button></span></div>'
    + '<div class="sub" style="margin-top:4px">Enter ingredients for the whole batch — nutrition below is per serving.</div></div>';

  html += '<h2 style="margin-top:18px">Ingredients <span class="sub" style="font-weight:400;font-size:12px">(' + rb.ingredients.length + ', need at least 2)</span></h2>';
  rb.ingredients.forEach(function(row, i){
    const food = FOODS[row.foodId];
    if(!food) return;
    const pieceHint = food.unit === 'piece' ? ' (≈' + (+(row.grams / food.avgG).toFixed(1)) + ' piece)' : '';
    html += '<div class="field"><div class="inp"><span>' + escapeHtml(food.name) + '</span>'
      + '<span class="sv-stepper" style="margin:0">'
      + '<button onclick="stepRecipeIngredientGrams(' + i + ',-10)" aria-label="Decrease grams">–</button>'
      + '<input class="sv-val" type="text" inputmode="decimal" value="' + row.grams + '" onfocus="this.select()" onkeydown="if(event.key===\'Enter\'){this.blur();}" onblur="commitRecipeIngredientGrams(' + i + ',this.value)" aria-label="Grams of ' + htmlAttr(food.name) + '">'
      + '<span class="sv-unit">g' + pieceHint + '</span>'
      + '<button onclick="stepRecipeIngredientGrams(' + i + ',10)" aria-label="Increase grams">+</button>'
      + '<button class="lib-del" style="margin-left:4px" aria-label="Remove ' + htmlAttr(food.name) + '" onclick="removeRecipeIngredient(' + i + ')">✕</button>'
      + '</span></div></div>';
  });
  html += '<button class="cta ghostbtn" style="margin-top:2px" onclick="openAddIngredientToRecipe()">＋ Add ingredient</button>';

  html += '<div class="field" style="margin-top:16px"><label>Steps (one per line, optional)</label>'
    + '<textarea class="inp" style="width:100%;box-sizing:border-box;min-height:90px;border:1px solid var(--line);margin-top:6px;display:block;resize:vertical;font:inherit" oninput="recipeBuilder.stepsText=this.value" placeholder="Combine and enjoy.">' + escapeHtml(rb.stepsText) + '</textarea></div>';

  html += '<div class="card" style="padding:14px;margin-top:14px">'
    + '<div class="row between"><b style="font-size:13px">Per serving' + (rb.servings > 1 ? ' <span class="sub" style="font-weight:400">(makes ' + rb.servings + ')</span>' : '') + '</b><span class="chip-computed">✓ computed</span></div>'
    + '<div class="nutri" style="margin-top:8px">'
    + '<div class="n"><div class="nt"><span>Calories</span><b>' + Math.round(perServing.kcal) + ' kcal</b></div></div>'
    + '<div class="n"><div class="nt"><span>Protein</span><b>' + Math.round(perServing.protein) + ' g</b></div></div>'
    + '<div class="n"><div class="nt"><span>Carbs</span><b>' + Math.round(perServing.carbs) + ' g</b></div></div>'
    + '<div class="n"><div class="nt"><span>Fat</span><b>' + Math.round(perServing.fat) + ' g</b></div></div>'
    + '</div>'
    + '<div class="sub" style="margin-top:8px">Auto tags: ' + (meta.tags.length ? meta.tags.map(tagLabelForPreview).join(', ') : '—') + '</div>'
    + '<div class="sub" style="margin-top:2px">Styles: ' + meta.styles.join(', ') + '</div>'
    + (meta.avoid.length ? '<div class="sub" style="margin-top:2px">Contains: ' + meta.avoid.map(avoidLabel).join(', ') + '</div>' : '')
    + '</div>';

  if(rb.ingredients.length){
    const warn = kcalBandWarning(rb.slots[0] || 'dinner', perServing.kcal);
    if(warn) html += '<div class="cap-note" style="color:#b25e35;margin-top:8px">' + warn + '</div>';
  }

  html += '<button class="cta" style="margin-top:16px" onclick="saveRecipeBuilder()">' + (editing ? 'Save changes' : 'Save recipe') + '</button>'
    + '<button class="cta ghostbtn" onclick="openMyRecipes()">Cancel</button>';
  return html;
}

function toggleRecipeSlot(s){
  const slots = recipeBuilder.slots || [];
  const idx = slots.indexOf(s);
  if(idx === -1) slots.push(s);
  else if(slots.length > 1) slots.splice(idx, 1);
  else { toast('Pick at least one meal slot'); return; }
  recipeBuilder.slots = RECIPE_SLOTS.filter(function(slot){ return slots.indexOf(slot) !== -1; });
  renderRecipeBuilderSheet();
}
function setRecipeBuilderSeason(season){ recipeBuilder.season = normalizeSeason(season); renderRecipeBuilderSheet(); }
function stepRecipeTime(delta){ recipeBuilder.time = Math.max(2, Math.min(180, recipeBuilder.time + delta)); renderRecipeBuilderSheet(); }
function stepRecipeServings(delta){ recipeBuilder.servings = Math.max(1, Math.min(12, recipeBuilder.servings + delta)); renderRecipeBuilderSheet(); }
function stepRecipeIngredientGrams(i, delta){
  const row = recipeBuilder.ingredients[i];
  if(!row) return;
  row.grams = Math.max(1, Math.min(2000, row.grams + delta));
  renderRecipeBuilderSheet();
}

// FIX 2 (feedback): typed grams, integer 1–2000 (same bound the stepper now clamps to),
// comma OR dot accepted. Invalid/negative reverts with a toast; a valid value re-renders
// through the same builder sheet a stepper tap would, so the live per-serving nutrition
// card and auto-tags recompute identically either way.
function commitRecipeIngredientGrams(i, raw){
  const row = recipeBuilder.ingredients[i];
  if(!row) return;
  const n = parseDecimalInput(raw);
  if(n === null || n < 0){ toast('Enter grams, e.g. 125'); renderRecipeBuilderSheet(); return; }
  row.grams = Math.max(1, Math.min(2000, Math.round(n)));
  renderRecipeBuilderSheet();
}
function removeRecipeIngredient(i){
  recipeBuilder.ingredients.splice(i, 1);
  renderRecipeBuilderSheet();
}

/* ---------------- add-ingredient picker (reuses render.js:searchFoods) ---------------- */
function openAddIngredientToRecipe(){
  recipeBuilder.pickerQuery = '';
  setRecipesScreenHtml(buildRecipeIngredientPickerSheet());
  const input = document.getElementById('recIngSearchInput');
  if(input) input.focus();
}
function buildRecipeIngredientPickerSheet(){
  return '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Add ingredient</h2><button class="backbtn" style="margin:0" onclick="renderRecipeBuilderSheet()">‹ Back</button></div>'
    + '<input class="inp" style="width:100%;box-sizing:border-box;border:1px solid var(--line);margin-top:8px" type="text" id="recIngSearchInput" placeholder="Search foods…" value="' + htmlAttr(recipeBuilder.pickerQuery) + '" oninput="onRecipeIngredientSearch(this.value)" autocomplete="off">'
    + '<div id="recIngResults" style="margin-top:4px">' + renderRecipeIngredientResults(recipeBuilder.pickerQuery) + '</div>';
}
function renderRecipeIngredientResults(q){
  q = (q || '').trim();
  if(q.length < 2) return '<p class="sub" style="margin-top:10px">Type at least 2 letters to search.</p>';
  const ids = searchFoods(q); // render.js — same substring match the quick-add flow uses
  if(!ids.length) return '<p class="sub" style="margin-top:10px">No foods match “' + escapeHtml(q) + '”.</p>';
  return ids.map(function(id){
    const f = FOODS[id];
    const per = f.unit === 'piece' ? 'piece' : '100' + f.unit;
    return '<div class="altrow" onclick="addIngredientToRecipe(\'' + id + '\')">'
      + '<div class="ae">' + foodIconHtml(id, '🥕') + '</div>'
      + '<div class="at"><div class="an">' + escapeHtml(f.name) + '</div>'
      + '<div class="ad">' + Math.round(f.kcal) + ' kcal · ' + f.protein + 'g protein <b>/ ' + per + '</b></div></div>'
      + '</div>';
  }).join('');
}
function onRecipeIngredientSearch(v){
  recipeBuilder.pickerQuery = v;
  const el = document.getElementById('recIngResults');
  if(el) el.innerHTML = renderRecipeIngredientResults(v);
}
function addIngredientToRecipe(foodId){
  const food = FOODS[foodId];
  if(!food) return;
  const defaultGrams = food.unit === 'piece' ? food.avgG : 100;
  recipeBuilder.ingredients.push({foodId: foodId, grams: defaultGrams});
  renderRecipeBuilderSheet();
}

/* ===================================================================
   FEATURE (owner feedback): merge-only import — the counterpart to
   render.js's exportData()/confirmImport() (task F2's full-store
   export/import). "Replace everything" (confirmImport) overwrites the
   WHOLE store, which is a heavy hammer just to hand your partner one
   recipe. This — mergeImportedLibrary(), wired up from render.js's
   import-confirm sheet as confirmMergeImport() — imports ONLY
   customFoods + customRecipes from an already-validated backup file
   (render.js:validateBackupStructure), ADDING them to this device's
   library. No other state (profiles, plans, log history, shopping
   checks) is read or written — Elena and Andrea can now share just a
   recipe across their two phones pre-couple-sync without either
   phone's plan/log/settings being clobbered.

   Merge rules (owner brief), applied per incoming entry, foods first
   (so recipe ingredient references can be remapped against the result):
   - an incoming id that already exists locally is SKIPPED — not
     counted as added — when its content is byte-for-byte identical
     (deepEqualJSON below: order-independent for plain-object keys,
     order-sensitive for arrays, i.e. real JSON-equality, not just
     JSON.stringify() comparison which would false-negative on key
     order).
   - an incoming id that already exists locally with DIFFERENT content
     is kept as a SEPARATE entry: re-idded with a '-2' suffix (bumped
     to '-3', '-4'… via freeConflictId if a lower suffix is already
     taken, e.g. from an earlier merge). If the conflict was on a FOOD
     id, every INCOMING recipe's ingredient list is remapped from the
     old food id to the new one (foodIdRemap) — otherwise a freshly
     imported recipe would silently reference this device's PRE-
     EXISTING (different) food under that id. Existing local recipes
     are untouched: they already correctly reference their own local
     food by its unchanged id.
   - a NAME collision (same display name — case/whitespace-insensitive
     — as any existing or already-merged-this-pass entry, regardless of
     id) gets " (imported)" appended to the incoming entry's name/title,
     so the library never ends up with two identically-named rows.
   - customRev (state.js) is bumped ONCE at the end if anything was
     actually added (not on a no-op merge) — never per item — so sync/persist
     sees one library change; applyCustomFoods()/applyCustomRecipes() (above)
     are likewise called once each.
   Returns {addedFoods, addedRecipes} (counts of ACTUAL additions —
   identical-content skips don't count) for the caller's toast.
   =================================================================== */

// Real structural equality for the plain-JSON shapes customFoods/customRecipes entries
// are (no functions, no cycles) — NOT a JSON.stringify() string comparison, which would
// incorrectly report two objects with the same keys in a different insertion order as
// different.
function deepEqualJSON(a, b){
  if(a === b) return true;
  if(typeof a !== typeof b || a === null || b === null) return a === b;
  if(Array.isArray(a) !== Array.isArray(b)) return false;
  if(Array.isArray(a)){
    if(a.length !== b.length) return false;
    for(let i = 0; i < a.length; i++){ if(!deepEqualJSON(a[i], b[i])) return false; }
    return true;
  }
  if(typeof a === 'object'){
    const ak = Object.keys(a), bk = Object.keys(b);
    if(ak.length !== bk.length) return false;
    return ak.every(function(k){ return Object.prototype.hasOwnProperty.call(b, k) && deepEqualJSON(a[k], b[k]); });
  }
  return a === b;
}

// Finds the first free 'baseId-2', 'baseId-3', … per the merge rules' id-conflict
// handling above. `isTaken(candidateId)` decides — callers check both the live DB and
// anything already claimed earlier in the SAME merge pass, so two incoming entries that
// both conflict with the same local id don't collide with each other either.
// Content-equality that ignores the `u` (updatedAt) stamp — two entries with identical
// recipe/food content but different save timestamps must still compare EQUAL here, both
// for mergeImportedLibrary's identical-content skip below and for js/sync.js's
// mergeLibrarySection per-id merge, or a bare re-save (which only bumps `u`) would look
// like a real edit and start the exact " (imported)"-suffix ratchet this stamp exists to
// stop (see the 2026-07 "Frittata di pasta" duplication postmortem in js/sync.js).
function withoutStamp(obj){
  if(!obj || typeof obj !== 'object') return obj;
  const clone = Object.assign({}, obj);
  delete clone.u;
  return clone;
}
function contentEqualJSON(a, b){
  return deepEqualJSON(withoutStamp(a), withoutStamp(b));
}

function freeConflictId(baseId, isTaken){
  let n = 2, candidate = baseId + '-' + n;
  while(isTaken(candidate)){ n++; candidate = baseId + '-' + n; }
  return candidate;
}

function mergeImportedLibrary(parsed){
  const incomingFoods = {}, incomingFoodOverrides = {}, incomingRecipes = {};
  if(parsed && parsed.customFoods && typeof parsed.customFoods === 'object'){
    Object.keys(parsed.customFoods).forEach(function(id){
      const v = parsed.customFoods[id];
      if(typeof id === 'string' && id.indexOf('cf-') === 0 && v && typeof v === 'object') incomingFoods[id] = v;
    });
  }
  if(parsed && parsed.foodOverrides && typeof parsed.foodOverrides === 'object'){
    Object.keys(parsed.foodOverrides).forEach(function(id){
      const v = parsed.foodOverrides[id];
      if(typeof id === 'string' && v && typeof v === 'object') incomingFoodOverrides[id] = v;
    });
  }
  if(parsed && parsed.customRecipes && typeof parsed.customRecipes === 'object'){
    Object.keys(parsed.customRecipes).forEach(function(id){
      const v = parsed.customRecipes[id];
      if(typeof id === 'string' && id.indexOf('cr-') === 0 && v && typeof v === 'object') incomingRecipes[id] = v;
    });
  }
  const incomingOverrides = {};
  if(parsed && parsed.recipeOverrides && typeof parsed.recipeOverrides === 'object'){
    Object.keys(parsed.recipeOverrides).forEach(function(id){
      const v = parsed.recipeOverrides[id];
      if(typeof id === 'string' && v && typeof v === 'object') incomingOverrides[id] = v;
    });
  }
  const incomingDeleted = {};
  if(parsed && parsed.deletedRecipes && typeof parsed.deletedRecipes === 'object'){
    Object.keys(parsed.deletedRecipes).forEach(function(id){
      if(typeof id === 'string' && parsed.deletedRecipes[id]) incomingDeleted[id] = true;
    });
  }
  const incomingPrefs = {};
  if(parsed && parsed.recipePrefs && typeof parsed.recipePrefs === 'object'){
    Object.keys(parsed.recipePrefs).forEach(function(id){
      const pref = parsed.recipePrefs[id];
      if(typeof id === 'string' && (pref === 'favorite' || pref === 'down')) incomingPrefs[id] = pref;
    });
  }

  // Existing display names (built-in + current custom), normalized — extended as entries
  // are merged in, so two incoming entries sharing a name don't both land unrenamed.
  const existingFoodNames = Object.keys(FOODS).map(function(id){ return String(FOODS[id].name || '').trim().toLowerCase(); });
  const existingRecipeNames = Object.keys(RECIPES_DB).map(function(id){ return String(RECIPES_DB[id].title || '').trim().toLowerCase(); });

  const foodIdRemap = {}; // incoming (old) food id -> final local id, only set when re-idded
  let addedFoods = 0, addedRecipes = 0, changedRecipeControls = 0, changedPrefs = 0;

  function commitFood(targetId, incoming){
    const food = JSON.parse(JSON.stringify(incoming));
    const nameNorm = String(food.name || '').trim().toLowerCase();
    if(existingFoodNames.indexOf(nameNorm) !== -1) food.name = food.name + ' (imported)';
    existingFoodNames.push(String(food.name).trim().toLowerCase());
    customFoods[targetId] = food;
    addedFoods++;
  }

  Object.keys(incomingFoods).sort().forEach(function(id){
    const incoming = incomingFoods[id];
    if(customFoods[id]){
      if(contentEqualJSON(customFoods[id], incoming)) return; // identical (ignoring `u`) — skip, not added
      const newId = freeConflictId(id, function(cand){ return !!customFoods[cand] || !!incomingFoods[cand]; });
      foodIdRemap[id] = newId;
      commitFood(newId, incoming);
    } else {
      commitFood(id, incoming);
    }
  });

  Object.keys(incomingFoodOverrides).sort().forEach(function(id){
    if(contentEqualJSON(foodOverrides[id], incomingFoodOverrides[id])) return;
    foodOverrides[id] = JSON.parse(JSON.stringify(incomingFoodOverrides[id]));
    if(deletedFoods[id]) delete deletedFoods[id];
    addedFoods++;
  });

  // Remaps an incoming recipe's ingredient food-ids through foodIdRemap (a no-op for any
  // ingredient whose food id wasn't actually re-idded above) before it's compared/stored —
  // see the merge-rules doc above for why this has to happen before the identical-content
  // check, not after.
  function remapIngredients(recipe){
    if(!recipe || !Array.isArray(recipe.ingredients)) return recipe;
    const r = JSON.parse(JSON.stringify(recipe));
    r.ingredients = r.ingredients.map(function(ing){
      const fid = ing && ing[0];
      return (fid && foodIdRemap[fid]) ? [foodIdRemap[fid], ing[1]] : ing;
    });
    return r;
  }

  function commitRecipe(targetId, recipe){
    const nameNorm = String(recipe.title || '').trim().toLowerCase();
    if(existingRecipeNames.indexOf(nameNorm) !== -1) recipe.title = recipe.title + ' (imported)';
    existingRecipeNames.push(String(recipe.title).trim().toLowerCase());
    customRecipes[targetId] = recipe;
    addedRecipes++;
  }

  Object.keys(incomingRecipes).sort().forEach(function(id){
    const remapped = remapIngredients(incomingRecipes[id]);
    if(customRecipes[id]){
      if(contentEqualJSON(customRecipes[id], remapped)) return; // identical (ignoring `u`) — skip, not added
      const newId = freeConflictId(id, function(cand){ return !!customRecipes[cand] || !!incomingRecipes[cand]; });
      commitRecipe(newId, remapped);
    } else {
      commitRecipe(id, remapped);
    }
  });

  Object.keys(incomingOverrides).sort().forEach(function(id){
    if(contentEqualJSON(recipeOverrides[id], incomingOverrides[id])) return;
    recipeOverrides[id] = JSON.parse(JSON.stringify(incomingOverrides[id]));
    if(deletedRecipes[id]) delete deletedRecipes[id];
    changedRecipeControls++;
  });
  Object.keys(incomingDeleted).sort().forEach(function(id){
    if(deletedRecipes[id]) return;
    deletedRecipes[id] = true;
    if(recipeOverrides[id]) delete recipeOverrides[id];
    if(customRecipes[id]) delete customRecipes[id];
    changedRecipeControls++;
  });
  Object.keys(incomingPrefs).sort().forEach(function(id){
    if(recipePrefs[id] === incomingPrefs[id]) return;
    recipePrefs[id] = incomingPrefs[id];
    changedPrefs++;
  });

  if(addedFoods || addedRecipes || changedRecipeControls || changedPrefs){
    customRev++;
    applyCustomFoods();
    applyCustomRecipes();
  }
  return {addedFoods: addedFoods, addedRecipes: addedRecipes, changedRecipes: changedRecipeControls, changedPrefs: changedPrefs};
}

function saveRecipeBuilder(){
  const rb = recipeBuilder;
  const name = (rb.name || '').trim();
  if(!name){ toast('Give this recipe a name'); return; }
  const lower = name.toLowerCase();
  const dup = Object.keys(RECIPES_DB).some(function(id){ return id !== rb.editingId && RECIPES_DB[id].title.toLowerCase() === lower; });
  if(dup){ toast('“' + name + '” already exists — try a different name'); return; }
  if(rb.ingredients.length < 2){ toast('Add at least 2 ingredients'); return; }

  const totals = computeBuilderTotals();
  // Tags/styles/kcal thresholds are per-serving quantities — derive from batch/servings.
  const yieldN = rb.servings || 1;
  const perServing = {};
  Object.keys(totals).forEach(function(k){ perServing[k] = totals[k] / yieldN; });
  const meta = deriveRecipeMeta(
    rb.ingredients.map(function(r){ return {foodId: r.foodId, grams: r.grams / yieldN}; }),
    perServing, rb.time);
  const stepsArr = (rb.stepsText || '').split('\n').map(function(s){ return s.trim(); }).filter(function(s){ return !!s; });

  const id = rb.editingId || uniqueSlug(slugify(name), RECIPES_DB, 'cr-');
  const recipe = {
    title: name, emoji: (rb.emoji || '').trim() || '🍽️', slot: (rb.slots && rb.slots[0]) || 'dinner', slots: (rb.slots && rb.slots.length ? rb.slots.slice() : ['dinner']),
    styles: meta.styles, time: rb.time, servings: yieldN,
    season: normalizeSeason(rb.season || derivedRecipeSeasonFromIngredients(rb.ingredients)),
    ingredients: rb.ingredients.map(function(r){ return [r.foodId, r.grams]; }),
    toTaste: [],
    steps: stepsArr.length ? stepsArr : ['Combine and enjoy.'],
    tags: meta.tags, avoid: meta.avoid,
    u: Date.now() // couple-sync newer-wins stamp (js/sync.js:mergeEntryMap) — see state.js's doc block
  };
  if(deletedRecipes[id]) delete deletedRecipes[id]; // recreate-after-delete: this save's `u` beats the tombstone either way
  if(id.indexOf('cr-') === 0) customRecipes[id] = recipe;
  else recipeOverrides[id] = recipe;
  customRev++;
  applyCustomRecipes();
  applyProf(currentProf); // refreshes library-derived UI without resetting the existing plan
  toast('✓ ' + name + (rb.editingId ? ' updated' : ' added to recipes'));
  recipeBuilder = null;
  openMyRecipes();
  renderFoodLibraryCount();
}

/* ===================================================================
   ONE-SHOT CLEANUP MIGRATION (2026-07 fix): before couple-sync's library
   merge got per-entry `u` stamps, applySyncResponse's 'library' branch
   reused mergeImportedLibrary (the manual-file-import merge) for every
   sync round. That merge intentionally clones same-id/different-content
   conflicts under a freeConflictId + " (imported)" name suffix — correct
   for a one-time file import, but a two-phone couple-sync loop re-applies
   it every round: phone A merges phone B's copy (clone #1, name +
   "(imported)"), pushes, phone B merges THAT back (clone #2, another
   "(imported)"), forever — a per-sync-round duplication ratchet. A
   custom recipe re-created a few times while "sync looked flaky" is
   enough of a seed for this to balloon into ~200 near-identical copies
   within days.
   Runs ONCE at boot (app.js, right after loadState()/applyCustomRecipes()
   populate customRecipes, before the first render) — idempotent, so it's
   a no-op on a clean library and safe to leave running on every future
   boot rather than needing a "ran once" flag.
   =================================================================== */

// Strips ANY NUMBER of trailing " (imported)" suffixes (repeated merge rounds can stack
// several), case-insensitively, so "Frittata di pasta (imported)(imported)(imported)"
// and "Frittata di pasta" group together.
function stripImportedSuffixes(title){
  let t = String(title || '').trim();
  const re = /\s*\(imported\)\s*$/i;
  while(re.test(t)) t = t.replace(re, '').trim();
  return t;
}
function normalizeRecipeGroupKey(title){
  return stripImportedSuffixes(title).toLowerCase();
}
// Heuristic for "this id looks like it was born from freeConflictId()" (baseId + '-N')
// — used only to prefer the least-mangled id as the kept/canonical one when several
// duplicates' content ties on everything else the picker cares about.
function isConflictSuffixedId(id){ return /-\d+$/.test(id); }

// Content-equality for the DUPLICATE-COLLAPSE decision specifically: ignores title (the
// whole point — "Foo" and "Foo (imported)" must compare equal here) on top of the `u`
// stamp contentEqualJSON() above already ignores.
function contentEqualIgnoringTitleAndStamp(a, b){
  function strip(o){
    const c = Object.assign({}, o);
    delete c.title; delete c.u;
    return c;
  }
  return deepEqualJSON(strip(a), strip(b));
}

function cleanupDuplicateLibraryEntries(){
  // Group custom recipe ids by normalized title.
  const groups = {};
  Object.keys(customRecipes).forEach(function(id){
    const r = customRecipes[id];
    if(!r) return;
    const key = normalizeRecipeGroupKey(r.title);
    (groups[key] = groups[key] || []).push(id);
  });

  let removedCount = 0, variantGroupCount = 0;
  const idRemap = {}; // deleted id -> kept canonical id

  Object.keys(groups).forEach(function(key){
    const ids = groups[key];
    if(ids.length < 2) return; // nothing to collapse in a group of one

    // Partition the group into content-equivalence clusters (ignoring title/u) — entries
    // with genuinely DIFFERENT content are real variants and must NOT be collapsed.
    const clusters = [];
    ids.forEach(function(id){
      const entry = customRecipes[id];
      let target = null;
      for(let i = 0; i < clusters.length; i++){
        if(contentEqualIgnoringTitleAndStamp(customRecipes[clusters[i].ids[0]], entry)){ target = clusters[i]; break; }
      }
      if(target) target.ids.push(id); else clusters.push({ids: [id]});
    });

    if(clusters.length > 1) variantGroupCount++; // real variants left alone — noted for the summary, not touched

    clusters.forEach(function(cluster){
      if(cluster.ids.length < 2) return; // singleton cluster — nothing to collapse

      // Canonical pick: prefer a title with no "(imported)" suffix, then an id with no
      // '-N' conflict suffix, else the lexicographically smallest id — deterministic so
      // re-running this (e.g. after a future sync re-merges some other duplicate set)
      // never picks a different "winner" for content already collapsed once.
      const canonical = cluster.ids.slice().sort(function(a, b){
        const ra = customRecipes[a], rb = customRecipes[b];
        const aClean = stripImportedSuffixes(ra.title) === String(ra.title || '').trim();
        const bClean = stripImportedSuffixes(rb.title) === String(rb.title || '').trim();
        if(aClean !== bClean) return aClean ? -1 : 1;
        const aConf = isConflictSuffixedId(a), bConf = isConflictSuffixedId(b);
        if(aConf !== bConf) return aConf ? 1 : -1;
        return a < b ? -1 : (a > b ? 1 : 0);
      })[0];

      cluster.ids.forEach(function(id){
        if(id === canonical) return;
        idRemap[id] = canonical;
        delete customRecipes[id];
        // Tombstoned (not just deleted) so couple-sync propagates the cleanup to the
        // partner's phone instead of the next sync round resurrecting these via union.
        deletedRecipes[id] = Date.now();
        removedCount++;
      });
    });
  });

  if(!removedCount) return; // idempotent: clean library (including a re-run right after
                             // this migration already ran once) changes nothing further

  function remapId(id){ return idRemap[id] || id; }

  // Remap weekPlans (both people, all weeks incl. the `weekPlan` compat alias — which is
  // just a bare reference into weekPlans, so mutating in place covers it for free).
  Object.keys(weekPlans).forEach(function(wk){
    const plan = weekPlans[wk];
    if(!plan || !Array.isArray(plan.days)) return;
    plan.days.forEach(function(day){
      if(!day || !day.meals) return;
      Object.keys(day.meals).forEach(function(slot){
        const meal = day.meals[slot];
        if(!meal) return;
        if(meal.recipeId && idRemap[meal.recipeId]) meal.recipeId = remapId(meal.recipeId);
        ['elena', 'partner'].forEach(function(p){
          const side = meal[p];
          if(!side) return;
          if(side.recipeId && idRemap[side.recipeId]) side.recipeId = remapId(side.recipeId);
          if(Array.isArray(side.extras)){
            side.extras.forEach(function(ex){ if(ex && ex.recipeId && idRemap[ex.recipeId]) ex.recipeId = remapId(ex.recipeId); });
          }
        });
      });
    });
  });

  // Remap logHistory (both people, ref + components[].recipeId) — LogEntry macros are
  // frozen at log time (state.js doc), so this only fixes which recipe a past entry
  // LINKS to (for recipe-detail taps etc.), never rewrites any stored nutrition number.
  Object.keys(logHistory).forEach(function(dateISO){
    const day = logHistory[dateISO];
    if(!day) return;
    ['elena', 'partner'].forEach(function(p){
      (day[p] || []).forEach(function(entry){
        if(!entry) return;
        if(entry.ref && idRemap[entry.ref]) entry.ref = remapId(entry.ref);
        if(Array.isArray(entry.components)){
          entry.components.forEach(function(c){ if(c && c.recipeId && idRemap[c.recipeId]) c.recipeId = remapId(c.recipeId); });
        }
      });
    });
  });

  // recipePrefs keyed by a deleted id: remap onto the kept id (unless it already has its
  // own pref, in which case the deleted id's pref is just dropped rather than clobbering it).
  Object.keys(idRemap).forEach(function(deletedId){
    const keptId = idRemap[deletedId];
    if(recipePrefs[deletedId] !== undefined){
      if(recipePrefs[keptId] === undefined) recipePrefs[keptId] = recipePrefs[deletedId];
      delete recipePrefs[deletedId];
    }
  });

  customRev++;
  applyCustomRecipes();
  persist();
  toast('🧹 Cleaned ' + removedCount + ' duplicate recipe' + (removedCount === 1 ? '' : 's')
    + (variantGroupCount ? ' (kept ' + variantGroupCount + ' genuine variant' + (variantGroupCount === 1 ? '' : 's') + ')' : ''));
}
