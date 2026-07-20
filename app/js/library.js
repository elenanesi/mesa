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
   into RECIPES_DB + RECIPE_SLOT_DB by applyCustomRecipes(), so whyText(),
   the planner's candidatesFor(), computeShoppingList() and every renderer
   that reads RECIPES_DB[id] (directly, or via render.js's recipeDisplay*
   helpers) see them exactly like a built-in recipe — no special-casing
   anywhere else.

   Both mutate `customRev` (state.js), a monotonic counter used by persistence/sync.
   Library changes do NOT regenerate an existing week: new recipes are available for
   manual swaps immediately and for future automatically generated weeks.

   Deleting a custom recipe never corrupts log history: LogEntry rows
   store frozen computed macros (state.js) and render.js already falls
   back gracefully (🍽️ / "Meal") when RECIPES_DB[e.ref] is missing.
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

// task B2: `role` is required + enum-checked by data/validate.js (VALID_ROLES), but any
// customRecipes/recipeOverrides entry saved BEFORE this field existed has no role at all —
// normalize it to 'full' (a complete one-dish meal, matching how every such recipe behaved
// in planning before roles existed) here at merge time, so validateData() stays green on
// legacy user data without a silent migration writing back into localStorage.
function normalizeRecipeRoleField(recipe){
  if(recipe && VALID_ROLES.indexOf(recipe.role) === -1) recipe.role = 'full';
  return recipe;
}

// Fraction of BUILTIN_RECIPE_COUNT (the bundled catalog's size, captured once above at
// script-parse time — never ratchets down even if this function runs more than once) that an
// incoming D1 payload's ACCEPTED rows must clear before replaceBuiltinRecipesFromCatalogRows()
// will install it. Legitimate catalog edits add/remove a handful of recipes at a time (a
// recent commit removed 4) — 0.5 is far below any real edit but still catches a truncated or
// partially-seeded D1 response, which would otherwise silently shrink the planner's candidate
// pool with no visible cause (README "The defect").
const CATALOG_REPLACE_MIN_FRACTION = 0.5;

function replaceBuiltinRecipesFromCatalogRows(rows){
  if(!Array.isArray(rows)) return false;
  const nextRecipes = {};
  const nextSlots = {};
  let rejectedCount = 0;
  const rejectedIds = [];
  rows.forEach(function(row){
    if(!row || row.deleted_at || row.deletedAt) return;
    if(row.scope !== 'global' || row.source !== 'builtin') return;
    const id = String(row.id || '').trim();
    const data = row.data;
    if(!id || !data || typeof data !== 'object' || Array.isArray(data)) return;
    const recipe = normalizeRecipeRoleField(JSON.parse(JSON.stringify(data)));
    const titleValid = typeof recipe.title === 'string' && !!recipe.title;
    const slotValid = typeof recipe.slot === 'string' && VALID_SLOTS.indexOf(recipe.slot) !== -1;
    const ingredientsValid = Array.isArray(recipe.ingredients) && recipe.ingredients.length > 0;
    if(!titleValid || !slotValid || !ingredientsValid){
      rejectedCount++;
      if(rejectedIds.length < 10) rejectedIds.push(id);
      return;
    }
    nextRecipes[id] = recipe;
    nextSlots[id] = recipe.slot;
  });
  const acceptedCount = Object.keys(nextRecipes).length;
  if(!acceptedCount) return false;

  // Sanity floor — reject the WHOLE payload (bundled BUILTIN_RECIPES_DB/BUILTIN_RECIPE_SLOT_DB
  // left completely untouched) rather than installing a thin catalog silently.
  const minAccepted = BUILTIN_RECIPE_COUNT * CATALOG_REPLACE_MIN_FRACTION;
  if(acceptedCount < minAccepted){
    console.error('replaceBuiltinRecipesFromCatalogRows: rejected D1 catalog payload — only ' +
      acceptedCount + ' of ' + BUILTIN_RECIPE_COUNT + ' bundled recipes were accepted (floor is ' +
      minAccepted + ', ' + (CATALOG_REPLACE_MIN_FRACTION * 100) + '% of bundled count). Keeping bundled fallback.');
    return false;
  }

  if(rejectedCount){
    console.warn('replaceBuiltinRecipesFromCatalogRows: dropped ' + rejectedCount +
      ' row(s) that failed validation: ' + rejectedIds.join(', ') + (rejectedCount > rejectedIds.length ? ', ...' : ''));
  }

  Object.keys(BUILTIN_RECIPES_DB).forEach(function(id){ delete BUILTIN_RECIPES_DB[id]; });
  Object.keys(BUILTIN_RECIPE_SLOT_DB).forEach(function(id){ delete BUILTIN_RECIPE_SLOT_DB[id]; });
  Object.keys(nextRecipes).forEach(function(id){
    BUILTIN_RECIPES_DB[id] = nextRecipes[id];
    BUILTIN_RECIPE_SLOT_DB[id] = nextSlots[id];
  });
  return true;
}

function applyCustomRecipes(){
  Object.keys(RECIPES_DB).forEach(function(id){ delete RECIPES_DB[id]; });
  Object.keys(RECIPE_SLOT_DB).forEach(function(id){ delete RECIPE_SLOT_DB[id]; });

  Object.keys(BUILTIN_RECIPES_DB).forEach(function(id){
    if(deletedRecipes[id]) return;
    const src = recipeOverrides[id] || BUILTIN_RECIPES_DB[id];
    RECIPES_DB[id] = normalizeRecipeRoleField(JSON.parse(JSON.stringify(src)));
    RECIPE_SLOT_DB[id] = RECIPES_DB[id].slot || BUILTIN_RECIPE_SLOT_DB[id];
  });
  Object.keys(recipeOverrides).forEach(function(id){
    if(BUILTIN_RECIPES_DB[id] || deletedRecipes[id]) return;
    RECIPES_DB[id] = normalizeRecipeRoleField(JSON.parse(JSON.stringify(recipeOverrides[id])));
    RECIPE_SLOT_DB[id] = RECIPES_DB[id].slot;
  });
  Object.keys(customRecipes).forEach(function(id){
    if(deletedRecipes[id]) return;
    RECIPES_DB[id] = normalizeRecipeRoleField(JSON.parse(JSON.stringify(customRecipes[id])));
    RECIPE_SLOT_DB[id] = RECIPES_DB[id].slot;
  });
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
  'clams', 'mussels', 'cod', 'sole-fish', 'sea-bass-fillet', 'prawns', 'chicken-thigh',
  'beef-mince-lean', 'pork-loin', 'pork-sausage', 'bresaola', 'speck'
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
    // Composite foods declare allergens their category hides (foods.js containsAvoid,
    // e.g. pesto-elena) — same rule planner.js:foodHitsAvoid applies for options/pairing.
    (Array.isArray(x.food.containsAvoid) ? x.food.containsAvoid : []).forEach(function(k){ avoidSet[k] = true; });
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

// task B2: recipe `role` picker (data/validate.js's VALID_ROLES = ['full','main','side',
// 'sauce'] as of task D2) — orthogonal to meal slots, defaults to 'full' (a complete
// one-dish meal) so an existing custom recipe or a builder draft that never touches this
// field behaves exactly as every recipe did before this field existed. 'sauce' (task D2):
// a condiment/sauce meant to be added to another dish, never planned standalone — see
// data/validate.js's role-kcal band and js/render.js's add-meal sheet "Sauces" section.
const ROLE_LABELS = {full: 'Full meal', main: 'Main', side: 'Side', sauce: 'Sauce & condiment'};
function normalizeRecipeRole(v){
  return (typeof VALID_ROLES !== 'undefined' && VALID_ROLES.indexOf(v) !== -1) ? v : 'full';
}
function recipeRoleLabel(v){ return ROLE_LABELS[normalizeRecipeRole(v)]; }
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

const DEFAULT_FOOD_ICON_ASSET = 'assets/ingredients/default-food.png';

function safeIngredientIconKey(v){
  v = String(v || '').trim();
  return /^[a-z0-9][a-z0-9-]*$/.test(v) ? v : '';
}

function safeIngredientIconAsset(v){
  v = String(v || '').trim();
  return /^assets\/ingredients\/[a-z0-9][a-z0-9-]*\.png$/.test(v) ? v : '';
}

function defaultFoodIconSrc(){
  return DEFAULT_FOOD_ICON_ASSET;
}

// One-shot reclaim for installs that ran the old base64-in-localStorage icon cache
// (key 'mesa.defaultFoodIcon.v1', removed 2026-07-19). The service worker already
// precaches assets/ingredients/default-food.png via SHELL_FILES, so that copy was pure
// duplication — but deleting the WRITER alone would strand the blob on existing phones
// forever, still occupying the same scarce iOS-PWA quota persist() needs for real user
// data. removeItem on a missing key is a no-op, so this costs nothing once drained and
// needs no "already cleaned" flag of its own.
function dropLegacyDefaultFoodIconCache(){
  try{ localStorage.removeItem('mesa.defaultFoodIcon.v1'); }catch(e){}
}
dropLegacyDefaultFoodIconCache();

function ingredientIconAssetForFood(food){
  if(!food) return '';
  const explicitAsset = safeIngredientIconAsset(food.iconAsset);
  if(explicitAsset) return explicitAsset;
  const iconKey = safeIngredientIconKey(food.iconKey);
  return iconKey ? 'assets/ingredients/' + iconKey + '.png' : '';
}

function ingredientIconHtml(src){
  src = safeIngredientIconAsset(src) || defaultFoodIconSrc();
  return '<img class="ingredient-icon" src="' + htmlAttr(src) + '" alt="" aria-hidden="true" loading="lazy" onerror="this.onerror=null;this.src=defaultFoodIconSrc()">';
}

function foodIconHtml(foodId){
  return ingredientIconHtml(ingredientIconAssetForFood(FOODS[foodId]));
}

// task C5: the icon picker's vocabulary — unique, sorted iconKey values across BUILT-IN
// FOODS records only (BUILTIN_FOODS_DB, the pre-merge snapshot below; NOT customFoods —
// those are user-authored, not the curated watercolor set). Each key is validated through
// the same safeIngredientIconKey/safeIngredientIconAsset helpers every other icon lookup
// uses, so the picker can never offer a key that the renderer would reject. Derived at
// runtime — no hardcoded list, no separate manifest file to keep in sync.
function availableIngredientIconKeys(){
  const seen = {};
  Object.keys(BUILTIN_FOODS_DB).forEach(function(id){
    const key = safeIngredientIconKey(BUILTIN_FOODS_DB[id].iconKey);
    if(key && safeIngredientIconAsset('assets/ingredients/' + key + '.png')) seen[key] = true;
  });
  return Object.keys(seen).sort();
}

function renderLibraryHub(){
  const el = document.getElementById('libraryHubBody');
  if(!el) return;
  el.innerHTML =
    '<div style="margin-top:10px">'
    + '<div class="altrow" onclick="openFoodLibrary()"><div class="ae">🧺</div><div class="at"><div class="an">Ingredients</div><div class="ad">Browse, edit or add foods</div></div></div>'
    + '<div class="altrow" onclick="openMyRecipes()"><div class="ae">📖</div><div class="at"><div class="an">Recipes</div><div class="ad">Browse, edit or add recipes</div></div></div>'
    + '<div class="altrow" onclick="openPantryLibrary()"><div class="ae">🥫</div><div class="at"><div class="an">Pantry</div><div class="ad">Track what you already have at home</div></div></div>'
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
function setPantryScreenHtml(html){ return setLibraryScreenHtml('libraryPantry', 'libraryPantryBody', html); }

function openFoodLibrary(){
  libFoodQuery = '';
  libFoodFilters = {cats: new Set(), flags: new Set(), seasons: new Set()};
  libFoodFiltersOpen = false;
  renderFoodLibraryList();
}

// Task C4: repaints the Ingredients LIST screen without resetting libFoodQuery/
// libFoodFilters — used by the detail page's back button so returning to the list
// preserves whatever search/filter state was active before the row tap. openFoodLibrary()
// above (fresh open) still resets that state first, then calls this.
function renderFoodLibraryList(){
  setIngredientsScreenHtml(buildFoodLibrarySheet());
  attachLibFoodListHandler();
}

// Delegated click handler for the Ingredients list's per-row action buttons
// (renderLibFoodListMarkup). #libFoodList itself is only recreated by openFoodLibrary
// (which re-runs this attach); search (onLibFoodSearchInput) and filters
// (rerenderLibFoodFilteredView) replace its CHILDREN only, so one onclick assignment
// survives them — same non-accumulating pattern as render.js:attachShopListClickHandler.
// Task C4: extended with row-tap -> openFoodDetail(id), WITHOUT touching the existing
// button behaviors. Precedence is resolved by checking the [data-act] button branch FIRST
// and returning — a tap that lands on ✎/↺/✕ never falls through to also open the detail
// page, since a click event's target is either inside a button or it isn't.
function attachLibFoodListHandler(){
  const el = document.getElementById('libFoodList');
  if(!el) return;
  el.onclick = function(e){
    const btn = e.target.closest('button[data-act]');
    if(btn && el.contains(btn)){
      const row = btn.closest('.altrow[data-food-id]');
      if(!row) return;
      const id = row.getAttribute('data-food-id');
      const act = btn.getAttribute('data-act');
      if(act === 'edit') openEditFoodForm(id);
      else if(act === 'reset') resetFoodOverride(id);
      else if(act === 'delete') deleteCustomFood(id);
      return;
    }
    const row = e.target.closest('.altrow[data-food-id]');
    if(!row || !el.contains(row)) return;
    openFoodDetail(row.getAttribute('data-food-id'));
  };
}

function openAddMenu(){
  document.getElementById('sheetBody').innerHTML =
    '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Add</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
    + '<div style="margin-top:10px">'
    + '<div class="altrow" onclick="openBarcodeScanner()"><div class="ae">📷</div><div class="at"><div class="an">Scan barcode</div><div class="ad">Import packaged foods from Open Food Facts</div></div></div>'
    + '<div class="altrow" onclick="openNewFoodForm()"><div class="ae">' + ingredientIconHtml('') + '</div><div class="at"><div class="an">New ingredient</div><div class="ad">Create a food with computed calories from macros</div></div></div>'
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
  if(/fish|salmon|sole|tuna|sardine|mussel|clam|shrimp|prawn|speck|sausage|meat|chicken|turkey|beef|pork|egg|pesce|tonno|salmone|cozza|cozze|vongol|gamber|sogliola|salsiccia|carne|pollo|uova/.test(hay)) return 'Protein';
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
  if(/salmon|salmone|sardine|tuna|tonno|mackerel|sgombro|anchovy|acciug|sole|sogliola/.test(hay)) flags.push('omega3');
  if(/fermented|kefir|kimchi|sauerkraut|crauti|miso|tempeh/.test(hay)) flags.push('fermented');
  return flags;
}

function inferSugarQuality(product){
  const hay = [
    product.ingredients_text || '',
    product.ingredients_text_it || '',
    product.labels_tags || []
  ].join(' ').toLowerCase();
  if(/\b(no added sugar|without added sugar|senza zuccheri aggiunti|sans sucres ajoutés)\b/.test(hay)) return 'intrinsic';
  if(/\b(sugar|zuccheri|zucchero|glucose|fructose|syrup|sciroppo|dextrose|maltodextrin|maltodestrina)\b/.test(hay)) return 'mixed';
  return 'unknown';
}

function openFoodFactsProductToFood(product, barcode){
  const nutriments = product.nutriments || {};
  const protein = offNum(nutriments, 'proteins');
  const carbs = offNum(nutriments, 'carbohydrates');
  const fat = offNum(nutriments, 'fat');
  if(protein === null || carbs === null || fat === null) return null;
  const satFat = offNum(nutriments, 'saturated-fat') || 0;
  const fiber = offNum(nutriments, 'fiber') || 0;
  const sugars = offNum(nutriments, 'sugars');
  const addedSugars = offNum(nutriments, 'added-sugars');
  const freeSugars = addedSugars !== null ? addedSugars : null;
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
    sugars: sugars === null ? 0 : +Math.min(sugars, carbs).toFixed(1),
    freeSugars: freeSugars === null ? 0 : +Math.min(freeSugars, sugars === null ? carbs : sugars).toFixed(1),
    sugarQuality: inferSugarQuality(product),
    flags: [],
    cat: inferOffCategory(product),
    season: 'evergreen',
    src: 'Open Food Facts barcode ' + barcode + '; kcal computed by Mesa from label macros; sugars are informational',
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
    + '<div class="n"><div class="nt"><span>Sugars</span><b>' + Math.round(f.sugars || 0) + ' g</b></div></div>'
    + '<div class="n"><div class="nt"><span>Fat</span><b>' + f.fat + ' g</b></div></div>'
    + '</div>'
    + '<div class="sub" style="margin-top:8px">Per 100g · ' + escapeHtml(f.cat) + ' · ' + seasonLabel(foodSeason(f)) + ' · ' + sugarQualityLabel(f.sugarQuality) + (f.flags.length ? ' · ' + f.flags.map(flagLabel).join(', ') : '') + '</div>'
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
// Live re-render on filter toggle or search input: repaints both the filter bar (chip
// on/off + count/Clear — the count reads libFoodQuery, so search must repaint it too)
// and the list below it. The search input itself lives OUTSIDE #libFoodFilterBar, so
// repainting the bar never destroys the focused input mid-typing.
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
    // Defensive: a malformed/null entry (e.g. from a bad couple-sync merge — see
    // js/sync.js:mergeEntryMap) must not crash the WHOLE list build. Skipping just this
    // id keeps the rest of the sheet (search bar, other categories) rendering normally
    // instead of leaving the Ingredients screen blank.
    if(!food || !food.name) return;
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
        + Math.round((f.carbs || 0) * factor) + 'g C, of which ' + Math.round((f.sugars || 0) * factor) + 'g sugars · '
        + Math.round((f.fat || 0) * factor) + 'g F · '
        + Math.round((f.fiber || 0) * factor) + 'g fiber / 100' + (f.unit === 'piece' ? 'g' : f.unit);
      // Food ids can be user-authored ('cf-<slug>' from a typed name), so the id rides in
      // a data-* attribute (htmlAttr-escaped once, never re-parsed as JS) and the buttons
      // carry a data-act verb for attachLibFoodListHandler's delegation below — same
      // pattern as the shopping list (render.js:attachShopListClickHandler). Task C4: the
      // row itself is now tappable (opens the ingredient detail page) so it keeps .altrow's
      // default cursor:pointer instead of the old cursor:default override, and carries an
      // aria-label naming the action for screen readers.
      out += '<div class="altrow" data-food-id="' + htmlAttr(id) + '" aria-label="View ' + htmlAttr(f.name) + '">'
        + '<div class="ae">' + foodIconHtml(id) + '</div>'
        + '<div class="at"><div class="an">' + escapeHtml(f.name) + (isCustom ? ' <span class="pill mini gold">yours</span>' : '') + (isEdited ? ' <span class="pill mini terra">edited</span>' : '') + ' <span class="pill mini">' + sugarQualityLabel(f.sugarQuality) + '</span></div>'
        + '<div class="ad">' + kcalPer100 + ' kcal · ' + macroLine + ' · ' + seasonLabel(foodSeason(f)) + '</div></div>'
        + '<button class="lib-edit" data-act="edit" aria-label="Edit ' + htmlAttr(f.name) + '">✎</button>'
        + (isEdited ? '<button class="lib-del" data-act="reset" aria-label="Reset ' + htmlAttr(f.name) + '">↺</button>' : '')
        + (isCustom ? '<button class="lib-del" data-act="delete" aria-label="Delete ' + htmlAttr(f.name) + '">✕</button>' : '')
        + '</div>';
    });
  });
  return out || '<p class="sub" style="margin-top:10px">No ingredients match your search or filters.</p>';
}

function onLibFoodSearchInput(v){
  libFoodQuery = v;
  rerenderLibFoodFilteredView(); // bar too, so the "N ingredients" count tracks the query
}

/* ---------------- new ingredient form ---------------- */
const FOOD_CATEGORIES = ['Produce', 'Protein', 'Dairy', 'Pantry', 'Bakery', 'Frozen']; // matches data/foods.js ALLOWED_CATS
const FOOD_FORM_FLAGS = ['lowGI', 'omega3', 'highFiber', 'glutenFree']; // offered when hand-authoring a new custom ingredient
// T5: extended with selenium/highIodine/fermented — the rest of data/foods.js's flag
// vocabulary, needed for the Ingredients sheet's tag filter (FOOD_FILTER_FLAGS above)
// even though the new-ingredient form only offers the original 4.
const FOOD_FLAG_LABELS = {lowGI: 'Low-GI', omega3: 'Omega-3', highFiber: 'High fiber', glutenFree: 'Gluten-free', selenium: 'Selenium', highIodine: 'High iodine', fermented: 'Fermented'};
function flagLabel(fl){ return FOOD_FLAG_LABELS[fl] || fl; }
function sugarQualityLabel(q){
  if(q === 'intrinsic') return 'Intrinsic sugars';
  if(q === 'added/free') return 'Added/free sugars';
  if(q === 'mixed') return 'Mixed sugars';
  return 'Sugar quality unknown';
}

let newFoodForm = null;

function openNewFoodForm(){
  newFoodForm = {editingId: null, name: '', cat: 'Produce', season: 'evergreen', protein: 0, carbs: 0, fat: 0, satFat: 0, fiber: 0, sugars: 0, freeSugars: 0, sugarQuality: 'unknown', flags: [], breakfastPair: false, iconKey: null, iconPickerOpen: false};
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
    sugars: +((f.sugars || 0) * factor).toFixed(1),
    freeSugars: +((f.freeSugars || 0) * factor).toFixed(1),
    sugarQuality: f.sugarQuality || 'unknown',
    flags: Array.isArray(f.flags) ? f.flags.slice() : [],
    breakfastPair: !!f.breakfastPair,
    iconKey: safeIngredientIconKey(f.iconKey) || null,
    iconPickerOpen: false
  };
  renderNewFoodFormSheet();
}
// Re-attaches the icon grid's delegated click handler every time (setIngredientsScreenHtml
// replaces #libraryIngredientsBody's innerHTML wholesale, so any prior listener on the old
// grid element is gone) — same per-render re-attach pattern as renderFoodLibraryList's
// attachLibFoodListHandler call.
function renderNewFoodFormSheet(){
  setIngredientsScreenHtml(buildNewFoodFormSheet());
  attachNewFoodIconGridHandler();
}

function computeNewFoodKcal(f){ return Math.round(4 * f.protein + 4 * f.carbs + 9 * f.fat); }

function newFoodCapNotes(f){
  const notes = [];
  if(f.satFat > f.fat + 1e-9) notes.push('Sat. fat can’t be more than total fat.');
  if(f.fiber > f.carbs + 1e-9) notes.push('Fiber can’t be more than total carbs.');
  if(f.sugars > f.carbs + 1e-9) notes.push('Sugars can’t be more than total carbs.');
  if(f.freeSugars > f.sugars + 1e-9) notes.push('Free sugars can’t be more than total sugars.');
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

  html += '<div class="field"><label>Sugar quality</label><div class="row" style="gap:7px;flex-wrap:wrap;margin-top:6px">'
    + [['intrinsic','Intrinsic'], ['added/free','Added/free'], ['mixed','Mixed'], ['unknown','Unknown']].map(function(pair){
      return '<button class="pill ghost chip-preset' + (f.sugarQuality === pair[0] ? ' chipsel' : '') + '" onclick="setNewFoodSugarQuality(\'' + pair[0] + '\')">' + pair[1] + '</button>';
    }).join('')
    + '</div></div>';

  // FIX 2 (feedback, owner: "prova a creare un ingrediente con 100 calorie usando il +…
  // permetti di scrivere direttamente l'importo… anche i decimali (es: 7,4 grassi)"): each
  // value is now a typeable input (comma OR dot decimals, commitNewFoodField below), flanked
  // by the same +/- steppers as before.
  [['protein', 'Protein'], ['carbs', 'Carbs'], ['fat', 'Fat'], ['satFat', 'Sat. fat'], ['fiber', 'Fiber'], ['sugars', 'Sugars'], ['freeSugars', 'Free sugars']].forEach(function(pair){
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

  // task B2: breakfastPair — an explicit whitelist (rather than inferring from cat:
  // 'Produce', which also holds vegetables) of foods the planner may pair with a light
  // breakfast main (e.g. skyr bowl + 1 pear). Same checkbox-row visual as Profile's goals
  // list (render.js renderGoalsEditor's .opt/.ck pattern) — this app has no native
  // <input type="checkbox"> anywhere, so this stays consistent with the rest of the UI.
  html += '<div class="field"><label>Breakfast pairing</label>'
    + '<div class="opt' + (f.breakfastPair ? ' sel' : '') + '" onclick="toggleNewFoodBreakfastPair()">'
    + '<div class="ck">' + (f.breakfastPair ? '✓' : '') + '</div>'
    + '<div><div class="ot">Can pair with a light breakfast</div><div class="od">Lets the planner combine this food (bread or fruit) with a plain protein breakfast main.</div></div></div></div>';

  // task C5: icon picker — current selection preview (default watercolor until chosen) +
  // a "Choose icon" toggle expanding a grid of the existing built-in watercolor icons.
  // f.iconPickerOpen persists on newFoodForm across renderNewFoodFormSheet() re-renders
  // (the same state object survives every setNewFoodCat/stepNewFoodField/etc. call), so
  // picking a tile doesn't collapse the grid.
  const currentIconKey = safeIngredientIconKey(f.iconKey || '');
  const previewSrc = currentIconKey ? 'assets/ingredients/' + currentIconKey + '.png' : '';
  html += '<div class="field"><label>Icon</label><div class="row" style="gap:12px;align-items:center;margin-top:6px">'
    + ingredientIconHtml(previewSrc)
    + '<button class="pill ghost chip-preset" onclick="toggleNewFoodIconPicker()">' + (f.iconPickerOpen ? 'Hide icons' : 'Choose icon') + '</button>'
    + '</div>'
    + (f.iconPickerOpen ? buildNewFoodIconGrid(currentIconKey) : '')
    + '</div>';

  html += '<button class="cta" onclick="saveNewFood()">' + (editing ? 'Save changes' : 'Save ingredient') + '</button>'
    + '<button class="cta ghostbtn" onclick="openFoodLibrary()">Cancel</button>';
  return html;
}

function setNewFoodCat(c){ newFoodForm.cat = c; renderNewFoodFormSheet(); }
function setNewFoodSeason(season){ newFoodForm.season = normalizeSeason(season); renderNewFoodFormSheet(); }
function setNewFoodSugarQuality(value){ newFoodForm.sugarQuality = value; renderNewFoodFormSheet(); }
function toggleNewFoodFlag(fl){
  const i = newFoodForm.flags.indexOf(fl);
  if(i === -1) newFoodForm.flags.push(fl); else newFoodForm.flags.splice(i, 1);
  renderNewFoodFormSheet();
}
function toggleNewFoodBreakfastPair(){
  newFoodForm.breakfastPair = !newFoodForm.breakfastPair;
  renderNewFoodFormSheet();
}

// task C5: tiles carry the icon key in data-icon-key (ingredient icon tiles use data-* +
// a delegated handler, per the repo's established convention for interactive grid tiles —
// same reasoning as attachLibFoodListHandler's data-food-id even though these values come
// from availableIngredientIconKeys()/FOODS, not user input). A leading "Default" tile
// carries an empty data-icon-key, which clears the field.
function buildNewFoodIconGrid(currentIconKey){
  const keys = availableIngredientIconKeys();
  let html = '<div class="icon-grid" data-role="new-food-icon-grid" style="margin-top:10px">'
    + '<button type="button" class="icon-tile' + (!currentIconKey ? ' sel' : '') + '" data-icon-key="" aria-label="Default icon">'
    + ingredientIconHtml('') + '<span class="icon-tile-label">Default</span></button>';
  keys.forEach(function(key){
    const src = 'assets/ingredients/' + key + '.png';
    html += '<button type="button" class="icon-tile' + (currentIconKey === key ? ' sel' : '') + '" data-icon-key="' + htmlAttr(key) + '" aria-label="' + htmlAttr(key.replace(/-/g, ' ')) + ' icon">'
      + ingredientIconHtml(src) + '</button>';
  });
  html += '</div>';
  return html;
}

function toggleNewFoodIconPicker(){
  newFoodForm.iconPickerOpen = !newFoodForm.iconPickerOpen;
  renderNewFoodFormSheet();
}

function setNewFoodIconKey(rawKey){
  // Read-side revalidation (safeIngredientIconKey) even though rawKey came from a tile this
  // same form just rendered from FOODS/availableIngredientIconKeys() — same belt-and-braces
  // convention as attachLibFoodListHandler's data-food-id.
  const key = safeIngredientIconKey(rawKey);
  newFoodForm.iconKey = key || null;
  renderNewFoodFormSheet();
}

// Delegated click handler for the icon grid (buildNewFoodIconGrid) — re-attached on every
// renderNewFoodFormSheet() call since setIngredientsScreenHtml replaces the sheet's
// innerHTML wholesale each time (same lifecycle as attachLibFoodListHandler).
function attachNewFoodIconGridHandler(){
  const el = document.querySelector('[data-role="new-food-icon-grid"]');
  if(!el) return;
  el.onclick = function(e){
    const btn = e.target.closest('.icon-tile');
    if(!btn || !el.contains(btn)) return;
    setNewFoodIconKey(btn.getAttribute('data-icon-key') || '');
  };
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
  if(f.protein < 0 || f.carbs < 0 || f.fat < 0 || f.satFat < 0 || f.fiber < 0 || f.sugars < 0 || f.freeSugars < 0){ toast('Values must be zero or more'); return; }
  if(f.satFat > f.fat + 1e-9){ toast('Sat. fat can’t exceed total fat'); return; }
  if(f.fiber > f.carbs + 1e-9){ toast('Fiber can’t exceed total carbs'); return; }
  if(f.sugars > f.carbs + 1e-9){ toast('Sugars can’t exceed total carbs'); return; }
  if(f.freeSugars > f.sugars + 1e-9){ toast('Free sugars can’t exceed total sugars'); return; }
  if(f.protein + f.carbs + f.fat > 100 + 1e-9){ toast('Protein + carbs + fat can’t exceed 100g per 100g'); return; }

  const id = f.editingId || uniqueSlug(slugify(name), FOODS, 'cf-');
  const kcal = computeNewFoodKcal(f);
  if(deletedFoods[id]) delete deletedFoods[id]; // recreate-after-delete: this save's `u` below beats the tombstone (js/sync.js:mergeLibrarySection)
  const existing = FOODS[id] || {};
  const saved = Object.assign({}, existing, {
    name: name, per: 100, unit: 'g',
    kcal: kcal, protein: f.protein, carbs: f.carbs, fat: f.fat, satFat: f.satFat, fiber: f.fiber,
    sugars: f.sugars, freeSugars: f.freeSugars, sugarQuality: f.sugarQuality || 'unknown',
    flags: f.flags.slice(), cat: f.cat, season: normalizeSeason(f.season), src: 'User-added ingredient',
    breakfastPair: !!f.breakfastPair,
    u: Date.now() // couple-sync newer-wins stamp (js/sync.js:mergeEntryMap) — see state.js's doc block
  });
  delete saved.avgG;
  // task C5: iconKey only persists when the user picked one — Default (null) removes any
  // previously-saved key on edit rather than writing an empty string, so a cleared custom
  // food falls back to the generic default icon exactly like a food that never had one.
  const chosenIconKey = safeIngredientIconKey(f.iconKey || '');
  if(chosenIconKey) saved.iconKey = chosenIconKey; else delete saved.iconKey;
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
   FEATURE 1b — Ingredient detail page (task C4)

   Tapping a row in the Ingredients list (anywhere except its ✎/↺/✕ buttons — see
   attachLibFoodListHandler above) opens a read-only detail page on the SAME
   'libraryIngredients' screen (setIngredientsScreenHtml, same lifecycle as the edit
   form), showing the live merged FOODS[id] record (overrides applied — never re-typed).

   Only the local watercolor icon is ever rendered (never a barcode product's remote
   `imageUrl`): the icon asset already has the exact same resolution path + default-icon
   fallback everywhere else in the app, works fully offline, and doesn't cost a network
   fetch that would 404 without connectivity — simplest correct choice, per the task brief.

   Actions reuse the existing handlers verbatim (openEditFoodForm/resetFoodOverride/
   deleteCustomFood) rather than re-implementing them. Edit's own back path returns to the
   LIST, not this detail page (acceptable per the task brief — no back-stack is built).
   Reset re-renders THIS page afterward (values refresh in place); Delete already returns
   to the list itself (existing behavior), so no re-render is layered on top of it.
   =================================================================== */
let libFoodDetailId = null;

// Basis line: 'per 100g' / 'per 100ml' for normal foods, 'per piece (~NNg)' for unit:'piece'
// foods (eggs, coffee) — matches how data/foods.js documents each record's own basis.
function foodDetailBasisLabel(f){
  return f.unit === 'piece' ? 'per piece (~' + Math.round(f.avgG || 0) + 'g)' : 'per 100' + f.unit;
}

// Open Food Facts tag strings look like 'en:gluten' or 'it:senza-lattosio' — strip the
// locale prefix and turn dashes into spaces for a readable pill, still escapeHtml'd like
// every other user-influenced string once it reaches the markup below.
function offTagLabel(tag){
  const s = String(tag || '').replace(/^[a-z]{2,3}:/, '').replace(/[-_]/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : String(tag || '');
}

function foodDetailNutriPill(label, value, unit){
  return '<div class="n"><div class="nt"><span>' + escapeHtml(label) + '</span><b>' + value + (unit ? ' ' + unit : '') + '</b></div></div>';
}

// Barcode-import metadata (brand/quantity/label kcal/Nutri-Score/NOVA/allergens/traces/
// ingredient text/source link) — rendered only when at least one such field exists, so a
// hand-authored or built-in food shows nothing here. The OFF source link is rendered ONLY
// when the URL starts with 'https://' (dropped otherwise, per the app's security
// conventions), with rel="noopener" target="_blank".
function foodDetailBarcodeSection(f){
  const hasMeta = !!(f.brand || f.quantity || f.labelKcal || f.nutriscore || f.novaGroup
    || (f.allergens && f.allergens.length) || (f.traces && f.traces.length) || f.ingredientsText || f.offUrl);
  if(!hasMeta) return '';
  let rows = '';
  if(f.brand) rows += '<div class="ad"><b>Brand</b> ' + escapeHtml(f.brand) + '</div>';
  if(f.quantity) rows += '<div class="ad"><b>Pack size</b> ' + escapeHtml(f.quantity) + '</div>';
  if(typeof f.labelKcal === 'number') rows += '<div class="ad"><b>Label calories</b> ' + f.labelKcal + ' kcal</div>';
  if(f.nutriscore) rows += '<div class="ad"><b>Nutri-Score</b> ' + escapeHtml(f.nutriscore) + '</div>';
  if(f.novaGroup) rows += '<div class="ad"><b>NOVA group</b> ' + escapeHtml(String(f.novaGroup)) + '</div>';
  if(f.allergens && f.allergens.length) rows += '<div class="ad"><b>Allergens</b> ' + f.allergens.map(offTagLabel).map(escapeHtml).join(', ') + '</div>';
  if(f.traces && f.traces.length) rows += '<div class="ad"><b>Traces</b> ' + f.traces.map(offTagLabel).map(escapeHtml).join(', ') + '</div>';
  const ingredientsBlock = f.ingredientsText
    ? '<div class="field"><label>Ingredients from label</label><div class="why" style="margin-top:6px">' + escapeHtml(f.ingredientsText) + '</div></div>'
    : '';
  const sourceLink = (typeof f.offUrl === 'string' && f.offUrl.indexOf('https://') === 0)
    ? '<div class="ad" style="margin-top:6px"><a href="' + htmlAttr(f.offUrl) + '" rel="noopener" target="_blank">View on Open Food Facts ↗</a></div>'
    : '';
  return '<div class="card" style="margin-top:12px"><b>Packaged product</b>' + rows + sourceLink + '</div>' + ingredientsBlock;
}

// Pure HTML-string builder (testable headlessly, no DOM access) — reads the live merged
// FOODS[id] record, never re-typed numbers. Returns '' if the id no longer resolves (e.g.
// a stale reference after a delete elsewhere) so callers can fall back gracefully.
function buildFoodDetailMarkup(id){
  const f = FOODS[id];
  if(!f) return '';
  const isCustom = !!customFoods[id];
  const isEdited = !isCustom && !!foodOverrides[id];
  const satFat = f.satFat || 0;
  const unsatFat = Math.max(0, (f.fat || 0) - satFat);

  let badges = '';
  if(isCustom) badges += '<span class="pill mini gold">yours</span>';
  if(isEdited) badges += '<span class="pill mini terra">edited</span>';
  badges += '<span class="pill mini ghost">' + escapeHtml(f.cat || '') + '</span>';
  badges += '<span class="pill mini ghost">' + escapeHtml(seasonLabel(foodSeason(f))) + '</span>';
  if(f.breakfastPair) badges += '<span class="pill mini">Breakfast pairing</span>';

  const flagsHtml = (f.flags || []).length
    ? '<div style="margin-top:10px">' + f.flags.map(function(fl){ return '<span class="pill" style="margin:0 6px 6px 0">' + escapeHtml(flagLabel(fl)) + '</span>'; }).join('') + '</div>'
    : '';

  const nutri = '<div class="nutri" style="margin-top:14px">'
    + foodDetailNutriPill('Calories', Math.round(f.kcal || 0), 'kcal')
    + foodDetailNutriPill('Protein', f.protein || 0, 'g')
    + foodDetailNutriPill('Carbs', f.carbs || 0, 'g')
    + foodDetailNutriPill('Fat', f.fat || 0, 'g')
    + foodDetailNutriPill('— saturated', satFat, 'g')
    + foodDetailNutriPill('— unsaturated', +unsatFat.toFixed(1), 'g')
    + foodDetailNutriPill('Fiber', f.fiber || 0, 'g')
    + foodDetailNutriPill('Sugars', f.sugars || 0, 'g')
    + foodDetailNutriPill('— free sugars', f.freeSugars || 0, 'g')
    + '</div>';

  const srcLine = f.src ? '<p class="sub" style="margin-top:10px">' + escapeHtml(f.src) + '</p>' : '';

  return '<div id="libFoodDetail">'
    + '<div class="row between" style="margin-top:6px"><h2 style="margin:0">' + escapeHtml(f.name) + '</h2><button class="backbtn" style="margin:0" onclick="renderFoodLibraryList()">‹ Back</button></div>'
    + '<div class="detail-hero ingredient-detail-hero">'
    + '<div class="detail-hero-media">' + ingredientIconHtml(ingredientIconAssetForFood(f)).replace('class="ingredient-icon"', 'class="ingredient-icon-lg"') + '</div>'
    + '<div class="detail-hero-body"><div class="detail-hero-badges">' + badges + '</div></div>'
    + '</div>'
    + '<p class="sub" style="margin-top:10px">' + foodDetailBasisLabel(f) + ' · ' + escapeHtml(sugarQualityLabel(f.sugarQuality)) + '</p>'
    + nutri
    + flagsHtml
    + foodDetailBarcodeSection(f)
    + srcLine
    + '<button class="cta ghostbtn" style="margin-top:14px" data-act="edit">✎ Edit</button>'
    + (isEdited ? '<button class="cta ghostbtn" data-act="reset">↺ Reset to default</button>' : '')
    + (isCustom ? '<button class="cta ghostbtn" data-act="delete">✕ Delete</button>' : '')
    + '</div>';
}

function openFoodDetail(id){
  if(!FOODS[id]){ toast('Ingredient not found'); renderFoodLibraryList(); return; }
  libFoodDetailId = id;
  setIngredientsScreenHtml(buildFoodDetailMarkup(id));
  attachFoodDetailHandler();
}

// Delegated handler for the detail page's own action buttons. The food id never enters
// the HTML/onclick string at all here — it's read back from the libFoodDetailId closure
// variable set by openFoodDetail(), which is the simplest way to keep a non-app-constant
// id (a typed 'cf-<slug>') out of any inline-onclick/JS-string context.
function attachFoodDetailHandler(){
  const el = document.getElementById('libFoodDetail');
  if(!el) return;
  el.onclick = function(e){
    const btn = e.target.closest('button[data-act]');
    if(!btn || !el.contains(btn)) return;
    const id = libFoodDetailId;
    if(!id) return;
    const act = btn.getAttribute('data-act');
    if(act === 'edit') openEditFoodForm(id);
    else if(act === 'reset'){ resetFoodOverride(id); openFoodDetail(id); }
    else if(act === 'delete') deleteCustomFood(id);
  };
}

/* ===================================================================
   FEATURE (PANTRY-plan.md P2) — Pantry page

   The Pantry page shows pantryRemaining() (js/pantry.js — pure derivation from the
   `pantry` baseline + logHistory) and lets Elena/Andrea correct it. Every user-initiated
   change funnels through ONE mutator, setPantryRemaining() below — the load-bearing rule
   from the plan's P2 step 4: it writes qty AND a fresh setAt/u atomically, always, so a
   correction never leaves the depletion-origin stale (which would double-subtract
   consumption that already happened and show less than what was just set). Decrease and
   remove sit directly on each row (not behind a sheet, per the plan); the add flow is a
   sheet, same shape as render.js's quick-add-food search (openFoodSearch/buildFoodSearchSheet),
   reusing its searchFoods() helper rather than re-implementing food search.
   =================================================================== */
let libPantryQuery = '';

// The ONE re-baselining mutator every pantry edit path calls — increase (via the add
// flow), decrease, set-exact (typed row correction), and remove (qty 0) alike. Pure data
// mutation + persist(): no DOM, no toast, so it's directly unit-testable (tools/check.js)
// independent of the UI wrappers below that call it.
//
// Why setAt MUST be re-stamped in the SAME assignment as qty (not a separate write):
// pantryRemaining() (js/pantry.js) = qty - pantryConsumedSince(setAt). If qty changed but
// setAt stayed at its old value, whatever was consumed since that OLD setAt would be
// subtracted a SECOND time on the next render, showing less than the user just set — an
// obvious-looking bug with a non-obvious cause (PANTRY-plan.md §3 P2 step 4). Re-basing
// setAt to now resets that consumption window to zero, so what was just set is exactly
// what renders next.
//
// Remove is qty:0 through this exact same path — never `delete pantry[foodId]` — so the
// fresh `u` makes it a proper tombstone (js/sync.js:mergePantrySection) that propagates the
// delete through couple sync instead of a stale remote copy resurrecting the item.
function setPantryRemaining(foodId, newQty){
  if(!FOODS[foodId]) return;
  const qty = (typeof newQty === 'number' && isFinite(newQty) && newQty > 0) ? newQty : 0;
  const now = Date.now();
  pantry[foodId] = {qty: qty, setAt: now, u: now};
  persist();
}

// Q3 (plan §4): age hint only — no expiry/decay modeling (inventing shelf-life rates would
// violate "computed, never typed in"). Deliberately paired with the row's direct
// decrease/remove controls: instead of Mesa guessing when food went off, it shows how old
// the NUMBER is and makes correcting it one tap away.
function pantryAgeHint(setAtMs){
  if(typeof setAtMs !== 'number' || !isFinite(setAtMs) || setAtMs <= 0) return '';
  const days = Math.floor(Math.max(0, Date.now() - setAtMs) / 86400000);
  if(days <= 0) return 'set today';
  if(days === 1) return 'set 1 day ago';
  return 'set ' + days + ' days ago';
}

function openPantryLibrary(){
  libPantryQuery = '';
  renderPantryLibraryList();
}

function renderPantryLibraryList(){
  setPantryScreenHtml(buildPantryLibrarySheet());
  attachPantryListHandler();
}

// Replaces just the row list (not the search box or its focus/caret) — same targeted-
// refresh convention as onLibFoodSearchInput/rerenderLibFoodFilteredView, used after every
// row-level mutation (decrease/remove/typed correction/add) so the still-open page reflects
// the new remaining quantities without losing whatever the user was doing in the search bar.
function refreshPantryList(){
  const el = document.getElementById('libPantryList');
  if(el) el.innerHTML = renderPantryListMarkup(libPantryQuery);
}

function buildPantryLibrarySheet(){
  return '<div class="row between" style="margin-top:6px"><h1 style="margin:0">Pantry</h1><button class="backbtn" style="margin:0" onclick="openLibraryHub()">‹ Library</button></div>'
    + '<p class="sub" style="margin-top:6px">What you already have at home — Mesa subtracts what gets logged automatically.</p>'
    + '<input class="inp" style="width:100%;box-sizing:border-box;border:1px solid var(--line);margin-top:8px" type="text" id="libPantrySearchInput" placeholder="Search your pantry…" value="' + htmlAttr(libPantryQuery) + '" oninput="onLibPantrySearchInput(this.value)" autocomplete="off">'
    + '<button class="cta ghostbtn" style="margin-top:12px" onclick="openPantryAddSheet()">＋ Add to pantry</button>'
    + '<div id="libPantryList" style="margin-top:4px">' + renderPantryListMarkup(libPantryQuery) + '</div>';
}

// foodId can be a user-authored 'cf-<slug>' (custom food), so — same convention as the
// Ingredients list (renderLibFoodListMarkup) — it only ever rides in data-food-id
// attributes, read back by attachPantryListHandler's delegation, never inline-onclick
// string-interpolated. qty:0 stored entries (setPantryRemaining's remove/tombstone shape)
// are filtered out here: they must never render as "in stock".
function renderPantryListMarkup(query){
  const q = (query || '').trim().toLowerCase();
  const remaining = pantryRemaining();
  const stockedIds = Object.keys(pantry).filter(function(id){ return pantry[id] && pantry[id].qty > 0 && !!FOODS[id]; });
  const ids = stockedIds
    .filter(function(id){ return !q || FOODS[id].name.toLowerCase().indexOf(q) !== -1; })
    .sort(function(a, b){ return FOODS[a].name < FOODS[b].name ? -1 : (FOODS[a].name > FOODS[b].name ? 1 : 0); });

  if(!ids.length){
    return '<p class="sub" style="margin-top:10px">' + (stockedIds.length ? 'No items match your search.' : 'Nothing in your pantry yet — tap “Add to pantry” to get started.') + '</p>';
  }

  return ids.map(function(id){
    const food = FOODS[id];
    const entry = pantry[id];
    const remain = Math.max(0, remaining[id] || 0);
    const unit = food.unit === 'piece' ? '' : food.unit;
    const displayVal = food.unit === 'piece' ? +(remain.toFixed(2)) : Math.round(remain);
    return '<div class="altrow" data-food-id="' + htmlAttr(id) + '" style="cursor:default">'
      + '<div class="ae">' + foodIconHtml(id) + '</div>'
      + '<div class="at"><div class="an">' + escapeHtml(food.name) + '</div>'
      + '<div class="ad">' + escapeHtml(pantryAgeHint(entry.setAt)) + '</div></div>'
      + '<div style="display:flex;align-items:center;gap:6px;flex:0 0 auto">'
      + '<button class="lib-edit" data-act="dec" aria-label="Decrease ' + htmlAttr(food.name) + '">–</button>'
      + '<input class="pantry-qty-input" type="text" inputmode="decimal" value="' + displayVal + '" aria-label="Remaining ' + htmlAttr(food.name) + '" onfocus="this.select()" onkeydown="if(event.key===\'Enter\'){this.blur();}" style="font-size:16px;width:3.4em;height:44px;text-align:center;border:1px solid var(--line);border-radius:10px;box-sizing:border-box;padding:0 2px">'
      + (unit ? '<span class="sv-unit" style="margin-left:-2px">' + unit + '</span>' : '')
      + '<button class="lib-del" data-act="remove" aria-label="Remove ' + htmlAttr(food.name) + '">✕</button>'
      + '</div></div>';
  }).join('');
}

function onLibPantrySearchInput(v){
  libPantryQuery = v;
  refreshPantryList();
}

// #libPantryList itself is only recreated by renderPantryLibraryList (full-page paint);
// search (onLibPantrySearchInput) and row mutations (refreshPantryList) replace its
// CHILDREN only, so one attach survives them — same non-accumulating pattern as
// attachLibFoodListHandler. `blur` doesn't bubble, so the typeable qty input's commit is
// caught on `focusout` (which does) rather than delegated `click`.
function attachPantryListHandler(){
  const el = document.getElementById('libPantryList');
  if(!el) return;
  el.onclick = function(e){
    const btn = e.target.closest('button[data-act]');
    if(!btn || !el.contains(btn)) return;
    const row = btn.closest('.altrow[data-food-id]');
    if(!row) return;
    const id = row.getAttribute('data-food-id');
    const act = btn.getAttribute('data-act');
    if(act === 'dec') decreasePantryItem(id);
    else if(act === 'remove') removePantryItem(id);
  };
  el.onfocusout = function(e){
    const input = e.target.closest('.pantry-qty-input');
    if(!input || !el.contains(input)) return;
    const row = input.closest('.altrow[data-food-id]');
    if(!row) return;
    commitPantryQtyInput(row.getAttribute('data-food-id'), input.value);
  };
}

// Direct-on-row decrease (plan: "not behind a sheet"). Step mirrors render.js's quick-add
// grams stepper granularity (stepQuickAddGrams's 10) for gram/ml foods; whole pieces for
// unit:'piece' foods. Floored at 0 by setPantryRemaining itself.
function decreasePantryItem(foodId){
  const food = FOODS[foodId];
  if(!food) return;
  const current = pantryRemaining()[foodId] || 0;
  const step = food.unit === 'piece' ? 1 : 10;
  setPantryRemaining(foodId, current - step);
  refreshPantryList();
}

// Direct-on-row remove (plan: "not behind a sheet") — qty 0 through the same re-baselining
// mutator, so it writes a proper fresh-`u` tombstone rather than a stale-`u` one a concurrent
// remote edit could beat in mergePantrySection.
function removePantryItem(foodId){
  const food = FOODS[foodId];
  setPantryRemaining(foodId, 0);
  toast('Removed' + (food ? ' ' + food.name : '') + ' from pantry');
  refreshPantryList();
}

// Typed "set-exact" correction — the row's qty input doubles as both the at-a-glance
// number and the direct-edit field (FIX 2's typeable-everywhere convention). Invalid/empty
// text reverts to the real stored value with a toast, same convention as
// commitQuickAddGrams/commitRecipeIngredientGrams.
function commitPantryQtyInput(foodId, raw){
  const food = FOODS[foodId];
  if(!food) return;
  const n = parseDecimalInput(raw);
  if(n === null || n < 0){
    toast('Enter an amount, e.g. 250');
    refreshPantryList();
    return;
  }
  setPantryRemaining(foodId, n);
  refreshPantryList();
}

/* ---------------- add to pantry (search + quantity, sheet flow) ----------------
   Same shape as render.js's quick-add-food sheet (openFoodSearch/buildFoodSearchSheet/
   selectQuickAddFood/buildGramsStepperSheet) — reuses its searchFoods() helper rather than
   re-implementing food search. Unlike quick-add (which LOGS a food), confirming here calls
   setPantryRemaining with current-remaining + typed amount: "Add to pantry" always means
   "I got more of this", stacking onto whatever's already left rather than replacing it. */
let pantryAdd = {query: '', selectedId: null, qty: 0};

function openPantryAddSheet(){
  pantryAdd = {query: '', selectedId: null, qty: 0};
  document.getElementById('sheetBody').innerHTML = buildPantryAddSearchSheet();
  const sheetBody = document.getElementById('sheetBody');
  sheetBody.onclick = function(e){
    const row = e.target.closest('.altrow[data-food-id]');
    if(!row || !sheetBody.contains(row)) return;
    selectPantryAddFood(row.getAttribute('data-food-id'));
  };
  document.getElementById('sheet').classList.remove('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
  // Explicit picker flow, opened by an intentional tap — README's "no auto-focus" rule is
  // for top-level landing-page searches (like this page's own #libPantrySearchInput above,
  // which does NOT auto-focus); auto-focus stays correct here, same as openFoodSearch's.
  const input = document.getElementById('pantryAddSearchInput');
  if(input) input.focus();
}

function buildPantryAddSearchSheet(){
  return '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Add to pantry</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
    + '<div class="field"><input class="inp" style="width:100%;box-sizing:border-box;border:1px solid var(--line)" type="text" id="pantryAddSearchInput" placeholder="Search foods… (e.g. flour)" value="' + htmlAttr(pantryAdd.query) + '" oninput="onPantryAddSearchInput(this.value)" autocomplete="off"></div>'
    + '<div id="pantryAddResults">' + renderPantryAddResults() + '</div>';
}

function renderPantryAddResults(){
  const q = pantryAdd.query.trim();
  if(q.length < 2) return '<p class="sub" style="margin-top:10px">Type at least 2 letters to search.</p>';
  const ids = searchFoods(q); // render.js — same substring match the quick-add sheet uses
  if(!ids.length) return '<p class="sub" style="margin-top:10px">No foods match “' + escapeHtml(q) + '”.</p>';
  const remaining = pantryRemaining();
  return ids.map(function(id){
    const f = FOODS[id];
    const per = f.unit === 'piece' ? 'piece' : '100' + f.unit;
    const already = remaining[id];
    const stockNote = already ? ' <span class="pill mini gold">' + fmtShopQty(already, f.unit === 'piece' ? '' : f.unit) + (f.unit === 'piece' ? '' : ' ' + f.unit) + ' in stock</span>' : '';
    return '<div class="altrow" data-food-id="' + htmlAttr(id) + '">'
      + '<div class="ae">' + foodIconHtml(id) + '</div>'
      + '<div class="at"><div class="an">' + escapeHtml(f.name) + stockNote + '</div>'
      + '<div class="ad">per ' + per + '</div></div>'
      + '</div>';
  }).join('');
}

function onPantryAddSearchInput(value){
  pantryAdd.query = value;
  const el = document.getElementById('pantryAddResults');
  if(el) el.innerHTML = renderPantryAddResults();
}

function selectPantryAddFood(id){
  if(!FOODS[id]) return;
  pantryAdd.selectedId = id;
  pantryAdd.qty = FOODS[id].unit === 'piece' ? 1 : 100;
  document.getElementById('sheetBody').innerHTML = buildPantryAddQtySheet();
}

function stepPantryAddQty(delta){
  pantryAdd.qty = Math.max(0, pantryAdd.qty + delta);
  document.getElementById('sheetBody').innerHTML = buildPantryAddQtySheet();
}

function commitPantryAddQty(raw){
  const n = parseDecimalInput(raw);
  if(n === null || n < 0){ toast('Enter an amount, e.g. 250'); document.getElementById('sheetBody').innerHTML = buildPantryAddQtySheet(); return; }
  pantryAdd.qty = n;
  document.getElementById('sheetBody').innerHTML = buildPantryAddQtySheet();
}

function buildPantryAddQtySheet(){
  const food = FOODS[pantryAdd.selectedId];
  if(!food) return buildPantryAddSearchSheet();
  const unitLabel = food.unit === 'piece' ? (pantryAdd.qty === 1 ? 'piece' : 'pieces') : food.unit;
  const step = food.unit === 'piece' ? 1 : 50;
  const already = pantryRemaining()[pantryAdd.selectedId] || 0;
  return '<div class="row between" style="margin-top:6px"><h2 style="margin:0">' + escapeHtml(food.name) + '</h2><button class="backbtn" style="margin:0" onclick="openPantryAddSheet()">‹ Back</button></div>'
    + (already > 0 ? '<p class="sub" style="margin-top:6px">Already have ' + fmtShopQty(already, food.unit === 'piece' ? '' : food.unit) + (food.unit === 'piece' ? '' : ' ' + food.unit) + ' — this adds to it.</p>' : '')
    + '<div class="serve-row" style="margin-top:14px"><div class="serve-card me" style="flex:1">'
    + '<div class="sv-name">Amount to add</div>'
    + '<div class="sv-stepper"><button onclick="stepPantryAddQty(-' + step + ')" aria-label="Decrease amount">–</button>'
    + '<input class="sv-val" type="text" inputmode="decimal" value="' + pantryAdd.qty + '" onfocus="this.select()" onkeydown="if(event.key===\'Enter\'){this.blur();}" onblur="commitPantryAddQty(this.value)" aria-label="Amount">'
    + '<span class="sv-unit">' + unitLabel + '</span>'
    + '<button onclick="stepPantryAddQty(' + step + ')" aria-label="Increase amount">+</button></div></div></div>'
    + '<button class="cta" onclick="confirmPantryAdd()">Add to pantry</button>'
    + '<button class="cta ghostbtn" onclick="closeSheet()">Cancel</button>';
}

function confirmPantryAdd(){
  const food = FOODS[pantryAdd.selectedId];
  if(!food || !(pantryAdd.qty > 0)){ toast('Enter an amount above 0'); return; }
  const current = pantryRemaining()[pantryAdd.selectedId] || 0;
  const unitSuffix = food.unit === 'piece' ? '' : (' ' + food.unit);
  setPantryRemaining(pantryAdd.selectedId, current + pantryAdd.qty);
  toast('✓ Added ' + fmtShopQty(pantryAdd.qty, food.unit === 'piece' ? '' : food.unit) + unitSuffix + ' ' + food.name);
  closeSheet();
  pantryAdd = {query: '', selectedId: null, qty: 0};
  refreshPantryList();
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
  attachLibRecipeListHandler();
}

// Delegated click handler for the Recipes list's tappable rows and per-row action buttons
// (renderLibRecipeListMarkup) — same rationale and lifecycle as attachLibFoodListHandler
// above: #libRecipeList is recreated only via openMyRecipes, child-only re-renders
// (rerenderLibRecipeFilteredView, toggleRecipePref) leave the assignment in place.
function attachLibRecipeListHandler(){
  const el = document.getElementById('libRecipeList');
  if(!el) return;
  el.onclick = function(e){
    const btn = e.target.closest('button[data-act]');
    const row = (btn ? btn.closest('.altrow[data-recipe-id]') : e.target.closest('.altrow[data-recipe-id]'));
    if(!row) return;
    const id = row.getAttribute('data-recipe-id');
    if(!btn){
      openRecipe(id, 'libraryRecipes');
      return;
    }
    if(!el.contains(btn)) return;
    const act = btn.getAttribute('data-act');
    if(act === 'favorite' || act === 'down') toggleRecipePref(id, act);
    else if(act === 'edit') openEditRecipeForm(id);
    else if(act === 'delete') deleteRecipe(id);
  };
}

function filteredRecipeIds(){
  return Object.keys(RECIPES_DB).filter(function(id){
    const r = RECIPES_DB[id];
    // Defensive: same reasoning as libFoodIdsByCategory above — a malformed entry from a
    // bad merge must not crash the whole Recipes sheet build.
    if(!r || !r.title) return false;
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
  // Recipe ids can be user-authored ('cr-<slug>' from a typed title), so rows carry the
  // id in data-recipe-id and the action buttons a data-act verb, resolved by
  // attachLibRecipeListHandler's delegation — never interpolated into inline onclick JS.
  return '<div style="margin-top:4px">' + ids.map(function(id){
    const r = RECIPES_DB[id];
    const nut = recipeNutrition(id, 1).totals;
    const badge = customRecipes[id] ? ' <span class="pill mini gold">yours</span>' : (recipeOverrides[id] ? ' <span class="pill mini terra">edited</span>' : '');
    const slotLabel = recipeSlotList(r).map(function(s){ return SLOT_LABEL[s] || s; }).join(' / ');
    const pref = recipePrefs[id] || null;
    return '<div class="altrow" data-recipe-id="' + htmlAttr(id) + '" aria-label="View ' + htmlAttr(r.title) + '"><div class="ae">' + r.emoji + '</div>'
      + '<div class="at"><div class="an">' + escapeHtml(r.title) + badge + '</div>'
      + '<div class="ad">' + slotLabel + ' · ' + seasonLabel(recipeSeason(r)) + ' · ' + Math.round(nut.kcal) + ' kcal · ' + Math.round(nut.protein) + 'g protein</div></div>'
      + '<div class="lib-recipe-actions">'
      + '<button class="lib-edit' + (pref === 'favorite' ? ' is-pref' : '') + '" data-act="favorite" aria-label="Favorite ' + htmlAttr(r.title) + '">♡</button>'
      + '<button class="lib-edit' + (pref === 'down' ? ' is-pref' : '') + '" data-act="down" aria-label="Thumbs down ' + htmlAttr(r.title) + '">👎</button>'
      + '<button class="lib-edit" data-act="edit" aria-label="Edit ' + htmlAttr(r.title) + '">✎</button>'
      + '<button class="lib-del" data-act="delete" aria-label="Delete ' + htmlAttr(r.title) + '">✕</button>'
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

// task D3: the builder's own draft shape for one optionGroups group/choice — deliberately
// carries NO key/id while being edited (unlike RECIPES_DB's shape). Group keys and choice
// ids are USER-CONTROLLED text once labels are editable, so they're derived from the
// current label text (slugify + a locally-unique suffix, mirroring the app's existing
// slugify/uniqueSlug convention for cf-/cr- ids) only once, at SAVE time
// (buildRecipeOptionGroupsForSave below) — every other builder interaction (add/remove
// group or choice, "make default", editing an ingredient row) addresses a group/choice by
// its ARRAY INDEX, exactly like the base ingredients list already does (removeRecipeIngredient(i)
// etc.). One consequence, called out here rather than hidden: re-saving an EXISTING
// optionGroups recipe with an unchanged label can still shift its derived id if the
// original built-in id wasn't itself slugify(label) (e.g. french-toast-fruit-maple's
// "Mixed berries" choice ships as id 'berries', not 'mixed-berries') — this is the exact
// "edited/removed choice" case D3's plan calls out: existing plan/log entries referencing
// the old id simply re-normalize to the group's new default via engine.js:
// normalizeRecipeOpts, never a crash or a stuck stale id.
function recipeOptionGroupsToBuilder(r){
  return (Array.isArray(r.optionGroups) ? r.optionGroups : []).map(function(g){
    return {
      label: (g && g.label) || '',
      choices: (g && Array.isArray(g.choices) ? g.choices : []).map(function(c){
        return {
          label: (c && c.label) || '',
          ingredients: (c && Array.isArray(c.ingredients) ? c.ingredients : []).map(function(ing){
            return {foodId: ing[0], grams: ing[1]};
          })
        };
      })
    };
  });
}

function recipeToBuilder(id){
  const r = RECIPES_DB[id];
  if(!r) return null;
  return {
    editingId: id,
    name: r.title || '',
    emoji: r.emoji || '🍽️',
    imageKey: safeRecipeImageKey(r.imageKey) || null,
    imagePickerOpen: false,
    slots: recipeSlotList(r).length ? recipeSlotList(r) : [r.slot || 'dinner'],
    season: recipeSeason(r),
    role: normalizeRecipeRole(r.role),
    time: r.time || 20,
    servings: r.servings || 1,
    ingredients: (r.ingredients || []).map(function(ing){ return {foodId: ing[0], grams: ing[1]}; }),
    optionGroups: recipeOptionGroupsToBuilder(r),
    stepsText: (r.steps || []).join('\n'),
    pickerQuery: ''
  };
}

function openNewRecipeForm(){
  recipeBuilder = {name: '', emoji: '🍽️', imageKey: null, imagePickerOpen: false, slots: ['dinner'], season: 'evergreen', role: 'full', time: 20, servings: 1, ingredients: [], optionGroups: [], stepsText: '', pickerQuery: ''};
  renderRecipeBuilderSheet();
}

function openEditRecipeForm(id){
  const draft = recipeToBuilder(id);
  if(!draft){ toast('Recipe not found'); return; }
  recipeBuilder = draft;
  renderRecipeBuilderSheet();
}

function openRecipeImageForm(id){
  const draft = recipeToBuilder(id);
  if(!draft){ toast('Recipe not found'); return; }
  draft.imagePickerOpen = true;
  recipeBuilder = draft;
  renderRecipeBuilderSheet();
}

function renderRecipeBuilderSheet(){
  setRecipesScreenHtml(buildRecipeBuilderSheet());
  attachRecipeImageGridHandler();
}

// task D3: base `ingredients` rows PLUS, for every draft option group, its DEFAULT choice's
// (index 0 — same "first choice = default" rule as engine.js:normalizeRecipeOpts) ingredient
// rows — the builder's own mirror of engine.js:recipeEffectiveIngredients(recipe, null) for
// a draft that hasn't been saved to RECIPES_DB yet. A draft with no option groups returns
// `ingredients` unchanged, so every pre-D3 recipe (none of which could author optionGroups)
// computes byte-identical totals/meta to before this task.
function builderEffectiveIngredientRows(){
  const rb = recipeBuilder;
  const rows = (rb && rb.ingredients ? rb.ingredients : []).slice();
  (rb && rb.optionGroups ? rb.optionGroups : []).forEach(function(group){
    const def = group && group.choices && group.choices[0];
    if(def && Array.isArray(def.ingredients)) rows.push.apply(rows, def.ingredients);
  });
  return rows;
}

// Per-serving totals for base + ONE SPECIFIC choice (every other group left out — this is
// deliberately not the full default combo, matching D3's "computed on base + that choice"
// advisory kcal-band note, one choice at a time, mirroring data/validate.js's own per-choice
// check).
function computeRecipeOptionChoiceTotals(gi, ci){
  const rb = recipeBuilder;
  const group = rb && rb.optionGroups && rb.optionGroups[gi];
  const choice = group && group.choices && group.choices[ci];
  const totals = {kcal: 0, protein: 0, carbs: 0, fat: 0, satFat: 0, fiber: 0};
  const rows = (rb && rb.ingredients ? rb.ingredients : []).concat(choice && Array.isArray(choice.ingredients) ? choice.ingredients : []);
  rows.forEach(function(row){
    const m = foodMacros(row.foodId, row.grams);
    totals.kcal += m.kcal; totals.protein += m.protein; totals.carbs += m.carbs;
    totals.fat += m.fat; totals.satFat += m.satFat; totals.fiber += m.fiber;
  });
  totals.kcal = 4 * totals.protein + 4 * totals.carbs + 9 * totals.fat;
  const yieldN = (rb && rb.servings) || 1;
  const perServing = {};
  Object.keys(totals).forEach(function(k){ perServing[k] = totals[k] / yieldN; });
  return perServing;
}

function computeBuilderTotals(){
  const totals = {kcal: 0, protein: 0, carbs: 0, fat: 0, satFat: 0, fiber: 0};
  builderEffectiveIngredientRows().forEach(function(row){
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
  // task D3: meta (tags/styles/avoid) derives from base + DEFAULT choice of every option
  // group (builderEffectiveIngredientRows), not the bare base list — a recipe whose default
  // fish choice is salmon should get omega3 the same way the saved built-in would.
  const perServingIngredients = builderEffectiveIngredientRows().map(function(row){
    return {foodId: row.foodId, grams: row.grams / (rb.servings || 1)};
  });
  const meta = deriveRecipeMeta(perServingIngredients, perServing, rb.time);

  const editing = !!rb.editingId;
  let html = '<div class="row between" style="margin-top:6px"><h2 style="margin:0">' + (editing ? 'Edit recipe' : 'New recipe') + '</h2><button class="backbtn" style="margin:0" onclick="openMyRecipes()">‹ Back</button></div>';

  html += '<div class="field"><label>Name</label>'
    + '<input class="inp" style="width:100%;box-sizing:border-box;border:1px solid var(--line);margin-top:6px" type="text" value="' + htmlAttr(rb.name) + '" oninput="recipeBuilder.name=this.value" placeholder="e.g. Tempeh bowl" autocomplete="off"></div>';

  html += '<div class="field"><label>Emoji</label>'
    + '<input class="inp" style="width:64px;box-sizing:border-box;border:1px solid var(--line);margin-top:6px;text-align:center;font-size:19px" type="text" maxlength="4" value="' + htmlAttr(rb.emoji) + '" oninput="recipeBuilder.emoji=this.value"></div>';

  const currentImageKey = safeRecipeImageKey(rb.imageKey || '');
  const previewRecipe = {
    title: rb.name || '',
    emoji: rb.emoji || '🍽️',
    imageKey: currentImageKey || null,
    slot: (rb.slots && rb.slots[0]) || 'dinner',
    role: normalizeRecipeRole(rb.role),
    tags: [],
    ingredients: rb.ingredients.map(function(row){ return [row.foodId, row.grams]; })
  };
  const previewSrc = recipeImageAssetForRecipe(previewRecipe, rb.editingId || '');
  const autoImageKey = previewSrc.indexOf('assets/recipes/') === 0
    ? previewSrc.slice('assets/recipes/'.length).replace(/\.png$/, '')
    : 'default-recipe';
  html += '<div class="field recipe-lead-image-field"><label>Lead image</label><div class="row recipe-lead-image-row">'
    + '<span class="recipe-image-preview recipe-image-preview-lg">' + recipeHeroHtml(previewRecipe, rb.editingId || '') + '</span>'
    + '<button class="pill ghost chip-preset" onclick="toggleRecipeImagePicker()">' + (rb.imagePickerOpen ? 'Hide images' : 'Choose lead image') + '</button>'
    + '<span class="sub" style="margin:0">' + (currentImageKey ? escapeHtml(recipeImageLabel(currentImageKey)) : 'Auto · ' + escapeHtml(recipeImageLabel(autoImageKey))) + '</span>'
    + '</div>'
    + (rb.imagePickerOpen ? buildRecipeImageGrid(currentImageKey) : '')
    + '</div>';

  html += '<div class="field"><label>Meal slots</label><div class="row" style="gap:7px;flex-wrap:wrap;margin-top:6px">'
    + RECIPE_SLOTS.map(function(s){ return '<button class="pill ghost chip-preset' + (rb.slots.indexOf(s) !== -1 ? ' chipsel' : '') + '" onclick="toggleRecipeSlot(\'' + s + '\')">' + SLOT_LABEL[s] + '</button>'; }).join('')
    + '</div><div class="sub" style="margin-top:4px">Pick every meal this recipe can work for. The first selected slot stays primary for old plans.</div></div>';

  html += '<div class="field"><label>Season</label><div class="row" style="gap:7px;flex-wrap:wrap;margin-top:6px">'
    + SEASON_VALUES.map(function(s){ return '<button class="pill ghost chip-preset' + (normalizeSeason(rb.season) === s ? ' chipsel' : '') + '" onclick="setRecipeBuilderSeason(\'' + s + '\')">' + seasonLabel(s) + '</button>'; }).join('')
    + '</div><div class="sub" style="margin-top:4px">Evergreen is always eligible; the seasonal tags limit automatic planning/re-balance to the current season.</div></div>';

  html += '<div class="field"><label>Role</label><div class="row" style="gap:7px;flex-wrap:wrap;margin-top:6px">'
    + VALID_ROLES.map(function(role){ return '<button class="pill ghost chip-preset' + (normalizeRecipeRole(rb.role) === role ? ' chipsel' : '') + '" onclick="setRecipeBuilderRole(\'' + role + '\')">' + recipeRoleLabel(role) + '</button>'; }).join('')
    + '</div><div class="sub" style="margin-top:4px">Full meal stands alone; Main pairs with a side; Side accompanies a main. How this recipe composes into a plan — separate from which meal slots it can serve.</div></div>';

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

  html += buildRecipeOptionsSection(rb);

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
  // task D3: a built-in recipe with a saved household override (recipeOverrides[id] —
  // "edited" badge in the Recipes list) can be reset back to its shipped defaults,
  // optionGroups included, mirroring the ingredient library's existing resetFoodOverride
  // action (Ingredients list's ↺ button) which this feature otherwise had no recipe-side
  // equivalent for.
  if(editing && BUILTIN_RECIPES_DB[rb.editingId] && recipeOverrides[rb.editingId]){
    html += '<button class="cta ghostbtn" onclick="resetRecipeBuilderOverride()">↺ Reset to default</button>';
  }
  return html;
}

/* ===================================================================
   task D3 — builder "Options" section (recipe variants, e.g. "Fish: salmon /
   sea bass / sole / cod"). Every group/choice is addressed by ARRAY INDEX
   while editing (gi = group index, ci = choice index, ii = ingredient-row
   index within a choice) — same convention the base ingredients list already
   uses (removeRecipeIngredient(i) etc.) — never by key/id/label, so these
   onclick handlers are always plain integers, never user text (see the
   security note on recipeOptionGroupsToBuilder above). Reuses the existing
   .field/.card/.sv-stepper/.lib-del/.pill.chip-preset builder visual language
   and the SAME ingredient-picker sheet the base ingredients list uses
   (openAddIngredientToRecipe/addIngredientToRecipe below, generalized with an
   optional target) — no new picker UI, per the plan's scope cut.
   =================================================================== */
function buildRecipeOptionsSection(rb){
  const groups = rb.optionGroups || [];
  let html = '<h2 style="margin-top:18px">Options <span class="sub" style="font-weight:400;font-size:12px">(variant groups, optional)</span></h2>'
    + '<p class="sub" style="margin-top:2px">Give this recipe swappable choices — e.g. a "Fish" group with salmon, sea bass and cod. The first choice in a group is its default.</p>';

  groups.forEach(function(group, gi){
    html += '<div class="card recipe-option-group" style="padding:14px;margin-top:12px">'
      + '<div class="row between"><b style="font-size:13px">Group ' + (gi + 1) + '</b>'
      + '<button class="lib-del" aria-label="Remove option group" onclick="removeRecipeOptionGroup(' + gi + ')">✕</button></div>';

    html += '<div class="field" style="margin-top:8px"><label>Group label</label>'
      + '<input class="inp" style="width:100%;box-sizing:border-box;border:1px solid var(--line);margin-top:6px" type="text" value="' + htmlAttr(group.label) + '" oninput="recipeBuilder.optionGroups[' + gi + '].label=this.value" placeholder="e.g. Fish" autocomplete="off"></div>';

    const choices = group.choices || [];
    choices.forEach(function(choice, ci){
      const choiceTotals = computeRecipeOptionChoiceTotals(gi, ci);
      const warn = kcalBandWarning(rb.slots[0] || 'dinner', choiceTotals.kcal);
      html += '<div class="card recipe-option-choice" style="padding:12px;margin-top:10px;background:rgba(255,255,255,.5)">'
        + '<div class="row between"><b style="font-size:12.5px">' + (ci === 0 ? 'Default choice' : 'Choice ' + (ci + 1)) + '</b>'
        + '<div class="row" style="gap:6px">'
        + (ci !== 0 ? '<button class="pill ghost chip-preset" style="min-height:44px;padding:0 12px" onclick="makeRecipeOptionChoiceDefault(' + gi + ',' + ci + ')">Make default</button>' : '')
        + '<button class="lib-del" aria-label="Remove choice" onclick="removeRecipeOptionChoice(' + gi + ',' + ci + ')">✕</button>'
        + '</div></div>';

      html += '<div class="field" style="margin-top:8px"><label>Choice label</label>'
        + '<input class="inp" style="width:100%;box-sizing:border-box;border:1px solid var(--line);margin-top:6px" type="text" value="' + htmlAttr(choice.label) + '" oninput="recipeBuilder.optionGroups[' + gi + '].choices[' + ci + '].label=this.value" placeholder="e.g. Salmon" autocomplete="off"></div>';

      (choice.ingredients || []).forEach(function(row, ii){
        const food = FOODS[row.foodId];
        if(!food) return;
        const pieceHint = food.unit === 'piece' ? ' (≈' + (+(row.grams / food.avgG).toFixed(1)) + ' piece)' : '';
        html += '<div class="field"><div class="inp"><span>' + escapeHtml(food.name) + '</span>'
          + '<span class="sv-stepper" style="margin:0">'
          + '<button onclick="stepRecipeOptionIngredientGrams(' + gi + ',' + ci + ',' + ii + ',-10)" aria-label="Decrease grams">–</button>'
          + '<input class="sv-val" type="text" inputmode="decimal" value="' + row.grams + '" onfocus="this.select()" onkeydown="if(event.key===\'Enter\'){this.blur();}" onblur="commitRecipeOptionIngredientGrams(' + gi + ',' + ci + ',' + ii + ',this.value)" aria-label="Grams of ' + htmlAttr(food.name) + '">'
          + '<span class="sv-unit">g' + pieceHint + '</span>'
          + '<button onclick="stepRecipeOptionIngredientGrams(' + gi + ',' + ci + ',' + ii + ',10)" aria-label="Increase grams">+</button>'
          + '<button class="lib-del" style="margin-left:4px" aria-label="Remove ' + htmlAttr(food.name) + '" onclick="removeRecipeOptionIngredient(' + gi + ',' + ci + ',' + ii + ')">✕</button>'
          + '</span></div></div>';
      });
      html += '<button class="cta ghostbtn" style="margin-top:2px" onclick="openAddIngredientToRecipe({groupIndex:' + gi + ',choiceIndex:' + ci + '})">＋ Add ingredient</button>';
      if(warn) html += '<div class="cap-note" style="color:#b25e35;margin-top:6px">' + warn + '</div>';
      html += '</div>'; // .recipe-option-choice
    });

    html += '<button class="cta ghostbtn" style="margin-top:8px" onclick="addRecipeOptionChoice(' + gi + ')">＋ Add choice</button>';
    html += '</div>'; // .recipe-option-group
  });

  html += '<button class="cta ghostbtn" style="margin-top:8px" onclick="addRecipeOptionGroup()">＋ Add option group</button>';
  return html;
}

function addRecipeOptionGroup(){
  if(!recipeBuilder.optionGroups) recipeBuilder.optionGroups = [];
  // Starts with 2 blank choices — the minimum the save-time validation requires — so the
  // very next thing to do is label them, not remember to add a second one.
  recipeBuilder.optionGroups.push({label: '', choices: [{label: '', ingredients: []}, {label: '', ingredients: []}]});
  renderRecipeBuilderSheet();
}
function removeRecipeOptionGroup(gi){
  if(!recipeBuilder.optionGroups) return;
  recipeBuilder.optionGroups.splice(gi, 1);
  renderRecipeBuilderSheet();
}
function addRecipeOptionChoice(gi){
  const group = recipeBuilder.optionGroups && recipeBuilder.optionGroups[gi];
  if(!group) return;
  group.choices.push({label: '', ingredients: []});
  renderRecipeBuilderSheet();
}
function removeRecipeOptionChoice(gi, ci){
  const group = recipeBuilder.optionGroups && recipeBuilder.optionGroups[gi];
  if(!group || !group.choices) return;
  group.choices.splice(ci, 1);
  renderRecipeBuilderSheet();
}
// "make default" — moves a choice to position 0 (engine.js's default rule stays "first
// choice"; no drag/drop, per the plan's scope cut).
function makeRecipeOptionChoiceDefault(gi, ci){
  const group = recipeBuilder.optionGroups && recipeBuilder.optionGroups[gi];
  if(!group || !group.choices || ci <= 0 || ci >= group.choices.length) return;
  const chosen = group.choices.splice(ci, 1)[0];
  group.choices.unshift(chosen);
  renderRecipeBuilderSheet();
}
function stepRecipeOptionIngredientGrams(gi, ci, ii, delta){
  const group = recipeBuilder.optionGroups && recipeBuilder.optionGroups[gi];
  const choice = group && group.choices && group.choices[ci];
  const row = choice && choice.ingredients && choice.ingredients[ii];
  if(!row) return;
  row.grams = Math.max(1, Math.min(2000, row.grams + delta));
  renderRecipeBuilderSheet();
}
function commitRecipeOptionIngredientGrams(gi, ci, ii, raw){
  const group = recipeBuilder.optionGroups && recipeBuilder.optionGroups[gi];
  const choice = group && group.choices && group.choices[ci];
  const row = choice && choice.ingredients && choice.ingredients[ii];
  if(!row) return;
  const n = parseDecimalInput(raw);
  if(n === null || n < 0){ toast('Enter grams, e.g. 125'); renderRecipeBuilderSheet(); return; }
  row.grams = Math.max(1, Math.min(2000, Math.round(n)));
  renderRecipeBuilderSheet();
}
function removeRecipeOptionIngredient(gi, ci, ii){
  const group = recipeBuilder.optionGroups && recipeBuilder.optionGroups[gi];
  const choice = group && group.choices && group.choices[ci];
  if(!choice || !choice.ingredients) return;
  choice.ingredients.splice(ii, 1);
  renderRecipeBuilderSheet();
}

// task D3: an edited built-in recipe (recipeOverrides[id] set) can be reset back to its
// shipped defaults — the recipe-side counterpart to resetFoodOverride() above. Unlike
// deleteRecipe() (which tombstones the id entirely, hiding it from RECIPES_DB), this only
// drops the household override so applyCustomRecipes() falls back to BUILTIN_RECIPES_DB[id]
// again — that fallback already deep-clones the WHOLE built-in record (JSON.parse(JSON.
// stringify(...))), optionGroups included, so no extra field-by-field restore logic is
// needed here.
function resetRecipeOverride(id){
  if(!recipeOverrides[id]) return;
  const name = (BUILTIN_RECIPES_DB[id] && BUILTIN_RECIPES_DB[id].title) || recipeOverrides[id].title || 'recipe';
  delete recipeOverrides[id];
  customRev++;
  applyCustomRecipes();
  applyProf(currentProf);
  toast('✓ Reset ' + name);
  renderFoodLibraryCount();
}
function resetRecipeBuilderOverride(){
  const id = recipeBuilder && recipeBuilder.editingId;
  if(!id) return;
  resetRecipeOverride(id);
  openEditRecipeForm(id); // re-opens on the now-restored built-in, options included
}

function buildRecipeImageGrid(currentImageKey){
  const keys = availableRecipeImageKeys();
  let html = '<div class="icon-grid recipe-image-grid" data-role="recipe-image-grid" style="margin-top:10px">'
    + '<button type="button" class="icon-tile' + (!currentImageKey ? ' sel' : '') + '" data-image-key="" aria-label="Automatic recipe image">'
    + '<span class="recipe-image-tile-auto">Auto</span><span class="icon-tile-label">Auto</span></button>';
  keys.forEach(function(key){
    const src = 'assets/recipes/' + key + '.png';
    html += '<button type="button" class="icon-tile' + (currentImageKey === key ? ' sel' : '') + '" data-image-key="' + htmlAttr(key) + '" aria-label="' + htmlAttr(recipeImageLabel(key)) + ' image">'
      + '<img class="recipe-image-tile" src="' + htmlAttr(src) + '" alt="" aria-hidden="true" loading="lazy" onerror="this.onerror=null;this.src=\'assets/recipes/default-recipe.png\'">'
      + '<span class="icon-tile-label">' + escapeHtml(recipeImageLabel(key)) + '</span></button>';
  });
  html += '</div>';
  return html;
}

function toggleRecipeImagePicker(){
  recipeBuilder.imagePickerOpen = !recipeBuilder.imagePickerOpen;
  renderRecipeBuilderSheet();
}

function setRecipeImageKey(rawKey){
  const key = safeRecipeImageKey(rawKey);
  recipeBuilder.imageKey = key || null;
  renderRecipeBuilderSheet();
}

function attachRecipeImageGridHandler(){
  const el = document.querySelector('[data-role="recipe-image-grid"]');
  if(!el) return;
  el.onclick = function(e){
    const btn = e.target.closest('.icon-tile');
    if(!btn || !el.contains(btn)) return;
    setRecipeImageKey(btn.getAttribute('data-image-key') || '');
  };
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
function setRecipeBuilderRole(role){ recipeBuilder.role = normalizeRecipeRole(role); renderRecipeBuilderSheet(); }
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
// task D3: `target` (optional {groupIndex, choiceIndex}, both plain integers from the
// Options section's own loop counters — see buildRecipeOptionsSection) redirects the SAME
// picker sheet/search/result-row flow that already builds the base ingredients list toward
// one option choice's own ingredients instead — no new picker UI. Omitted/invalid ->
// base ingredients (recipeOptionPickerTarget stays null), exactly like every pre-D3 call
// site (openAddIngredientToRecipe() with no args, from the base Ingredients section).
let recipeOptionPickerTarget = null;
function openAddIngredientToRecipe(target){
  recipeBuilder.pickerQuery = '';
  recipeOptionPickerTarget = (target && typeof target.groupIndex === 'number' && typeof target.choiceIndex === 'number')
    ? {groupIndex: target.groupIndex, choiceIndex: target.choiceIndex} : null;
  setRecipesScreenHtml(buildRecipeIngredientPickerSheet());
  // Delegated click for the result rows (data-food-id — ids can be user-authored 'cf-'
  // slugs, so no inline-onclick interpolation). #recIngResults keeps only its children
  // replaced on each keystroke (onRecipeIngredientSearch), so one assignment survives.
  const results = document.getElementById('recIngResults');
  if(results) results.onclick = function(e){
    const row = e.target.closest('.altrow[data-food-id]');
    if(!row || !results.contains(row)) return;
    addIngredientToRecipe(row.getAttribute('data-food-id'));
  };
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
    return '<div class="altrow" data-food-id="' + htmlAttr(id) + '">'
      + '<div class="ae">' + foodIconHtml(id) + '</div>'
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
  const target = recipeOptionPickerTarget;
  recipeOptionPickerTarget = null;
  if(target){
    const group = recipeBuilder.optionGroups && recipeBuilder.optionGroups[target.groupIndex];
    const choice = group && group.choices && group.choices[target.choiceIndex];
    if(choice) choice.ingredients.push({foodId: foodId, grams: defaultGrams});
  } else {
    recipeBuilder.ingredients.push({foodId: foodId, grams: defaultGrams});
  }
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
    if(typeof food.sugars !== 'number' || !isFinite(food.sugars)) food.sugars = 0;
    if(typeof food.freeSugars !== 'number' || !isFinite(food.freeSugars)) food.freeSugars = 0;
    if(typeof food.sugarQuality !== 'string' || ['intrinsic','added/free','mixed','unknown'].indexOf(food.sugarQuality) === -1) food.sugarQuality = 'unknown';
    if(food.sugars < 0) food.sugars = 0;
    if(food.freeSugars < 0) food.freeSugars = 0;
    if(food.sugars > (food.carbs || 0)) food.sugars = food.carbs || 0;
    if(food.freeSugars > food.sugars) food.freeSugars = food.sugars;
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

// task D3: save-time validation mirroring data/validate.js's optionGroups structural
// ERROR rules (unique keys/ids handled separately by buildRecipeOptionGroupsForSave's
// slug-uniqueness, so this only re-checks what a human can get wrong through the form:
// every group needs a label and >=2 choices, every choice needs a label and >=1
// ingredient whose food id still resolves against FOODS). Returns a message string for
// the FIRST problem found (the builder's existing inline-error pattern is one toast per
// save attempt, not a full error list), or null when the draft's option groups are clean.
function validateRecipeBuilderOptionGroups(rb){
  const groups = rb.optionGroups || [];
  for(let gi = 0; gi < groups.length; gi++){
    const group = groups[gi];
    const gLabel = (group.label || '').trim();
    const gName = gLabel || ('Option group ' + (gi + 1));
    if(!gLabel) return 'Give ' + gName.toLowerCase() + ' a label';
    const choices = group.choices || [];
    if(choices.length < 2) return '“' + gLabel + '” needs at least 2 choices';
    for(let ci = 0; ci < choices.length; ci++){
      const choice = choices[ci];
      const cLabel = (choice.label || '').trim();
      const cName = cLabel || ('choice ' + (ci + 1));
      if(!cLabel) return 'Give every choice in “' + gLabel + '” a label';
      const ingredients = choice.ingredients || [];
      if(!ingredients.length) return '“' + cName + '” in “' + gLabel + '” needs at least 1 ingredient';
      for(let ii = 0; ii < ingredients.length; ii++){
        if(!FOODS[ingredients[ii].foodId]) return '“' + cName + '” in “' + gLabel + '” has an ingredient that no longer exists';
      }
    }
  }
  return null;
}

// task D3: turns the builder's draft optionGroups (label-only, index-addressed — see
// recipeOptionGroupsToBuilder's doc comment) into RECIPES_DB's shape, deriving unique
// group keys / choice ids from the CURRENT label text via the app's existing slugify() +
// uniqueSlug() helpers. uniqueSlug() normally dedupes against a global dict keyed
// 'prefix'+slug (FOODS/RECIPES_DB elsewhere in this file); reused here with prefix ''
// against a throwaway per-recipe "seen" object, so uniqueness is enforced only among this
// recipe's OWN sibling group keys / sibling choice ids, matching data/validate.js's
// duplicate-key/id structural checks. Returns undefined (not []) when the draft has no
// option groups, so the saved recipe omits the `optionGroups` field entirely — the same
// "field only present when it means something" convention every other optional recipe
// field (imageKey, season, servings) already follows.
function buildRecipeOptionGroupsForSave(rb){
  const groups = rb.optionGroups || [];
  if(!groups.length) return undefined;
  const groupKeysSeen = {};
  return groups.map(function(group){
    const key = uniqueSlug(slugify(group.label), groupKeysSeen, '');
    groupKeysSeen[key] = true;
    const choiceIdsSeen = {};
    const choices = (group.choices || []).map(function(choice){
      const id = uniqueSlug(slugify(choice.label), choiceIdsSeen, '');
      choiceIdsSeen[id] = true;
      return {
        id: id,
        label: choice.label.trim(),
        ingredients: (choice.ingredients || []).map(function(r){ return [r.foodId, r.grams]; })
      };
    });
    return {key: key, label: group.label.trim(), choices: choices};
  });
}

function saveRecipeBuilder(){
  const rb = recipeBuilder;
  const name = (rb.name || '').trim();
  if(!name){ toast('Give this recipe a name'); return; }
  const lower = name.toLowerCase();
  const dup = Object.keys(RECIPES_DB).some(function(id){ return id !== rb.editingId && RECIPES_DB[id].title.toLowerCase() === lower; });
  if(dup){ toast('“' + name + '” already exists — try a different name'); return; }
  if(rb.ingredients.length < 2){ toast('Add at least 2 ingredients'); return; }
  const optionsError = validateRecipeBuilderOptionGroups(rb);
  if(optionsError){ toast(optionsError); return; }

  const totals = computeBuilderTotals(); // base + DEFAULT choice of every group (builderEffectiveIngredientRows)
  // Tags/styles/kcal thresholds are per-serving quantities — derive from batch/servings.
  const yieldN = rb.servings || 1;
  const perServing = {};
  Object.keys(totals).forEach(function(k){ perServing[k] = totals[k] / yieldN; });
  // task D3: derived meta (tags/styles/avoid) computes from base + DEFAULT choice of every
  // group, same single source (builderEffectiveIngredientRows) the live preview card above
  // already reads — never diverges from what the builder showed right before Save.
  const meta = deriveRecipeMeta(
    builderEffectiveIngredientRows().map(function(r){ return {foodId: r.foodId, grams: r.grams / yieldN}; }),
    perServing, rb.time);
  const stepsArr = (rb.stepsText || '').split('\n').map(function(s){ return s.trim(); }).filter(function(s){ return !!s; });

  const id = rb.editingId || uniqueSlug(slugify(name), RECIPES_DB, 'cr-');
  const recipe = {
    title: name, emoji: (rb.emoji || '').trim() || '🍽️', slot: (rb.slots && rb.slots[0]) || 'dinner', slots: (rb.slots && rb.slots.length ? rb.slots.slice() : ['dinner']),
    styles: meta.styles, time: rb.time, servings: yieldN,
    season: normalizeSeason(rb.season || derivedRecipeSeasonFromIngredients(rb.ingredients)),
    role: normalizeRecipeRole(rb.role),
    ingredients: rb.ingredients.map(function(r){ return [r.foodId, r.grams]; }),
    toTaste: [],
    steps: stepsArr.length ? stepsArr : ['Combine and enjoy.'],
    tags: meta.tags, avoid: meta.avoid,
    u: Date.now() // couple-sync newer-wins stamp (js/sync.js:mergeEntryMap) — see state.js's doc block
  };
  const optionGroupsForSave = buildRecipeOptionGroupsForSave(rb);
  if(optionGroupsForSave) recipe.optionGroups = optionGroupsForSave;
  const chosenImageKey = safeRecipeImageKey(rb.imageKey || '');
  if(chosenImageKey) recipe.imageKey = chosenImageKey;
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
