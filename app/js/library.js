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

   Both mutate `customRev` (state.js), a monotonic counter folded into
   planner.js:computePlanSignature() so any library change deterministically
   regenerates the week (task brief: "the planner must see them").

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
  Object.keys(customFoods).forEach(function(id){ FOODS[id] = customFoods[id]; });
}

function applyCustomRecipes(){
  Object.keys(RECIPES_DB).forEach(function(id){
    if(id.indexOf('cr-') === 0 && !customRecipes[id]){
      delete RECIPES_DB[id];
      delete RECIPE_SLOT_DB[id];
      delete RECIPES[id];
    }
  });
  Object.keys(customRecipes).forEach(function(id){
    RECIPES_DB[id] = customRecipes[id];
    RECIPE_SLOT_DB[id] = customRecipes[id].slot;
  });
  // Rebuilds RECIPES[id] for EVERY id in RECIPES_DB (state.js) — custom ids included —
  // so whyText()/renderRecipe()/renderWeek()/shopping list etc. need no special-casing.
  buildLegacyRecipesCompat();
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

function openFoodLibrary(){
  libFoodQuery = '';
  document.getElementById('sheetBody').innerHTML = buildFoodLibrarySheet();
  document.getElementById('sheet').classList.add('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
  const input = document.getElementById('libFoodSearchInput');
  if(input) input.focus();
}

function buildFoodLibrarySheet(){
  return '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Ingredients</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
    + '<input class="inp" style="width:100%;box-sizing:border-box;border:1px solid var(--line);margin-top:8px" type="text" id="libFoodSearchInput" placeholder="Search ingredients…" value="' + htmlAttr(libFoodQuery) + '" oninput="onLibFoodSearchInput(this.value)" autocomplete="off">'
    + '<button class="cta ghostbtn" style="margin-top:12px" onclick="openNewFoodForm()">＋ New ingredient</button>'
    + '<div id="libFoodList" style="margin-top:4px">' + renderLibFoodListMarkup(libFoodQuery) + '</div>';
}

function libFoodIdsByCategory(query){
  const q = (query || '').trim().toLowerCase();
  const byCat = {};
  Object.keys(FOODS).forEach(function(id){
    if(q && FOODS[id].name.toLowerCase().indexOf(q) === -1) return;
    const cat = FOODS[id].cat;
    (byCat[cat] = byCat[cat] || []).push(id);
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
      const kcalPer100 = f.unit === 'piece' ? Math.round(f.kcal / f.avgG * 100) : Math.round(f.kcal);
      out += '<div class="altrow" style="cursor:default">'
        + '<div class="ae">🥕</div>'
        + '<div class="at"><div class="an">' + escapeHtml(f.name) + (isCustom ? ' <span class="pill mini gold">yours</span>' : '') + '</div>'
        + '<div class="ad">' + kcalPer100 + ' kcal / 100' + (f.unit === 'piece' ? 'g' : f.unit) + '</div></div>'
        + (isCustom ? '<button class="lib-del" aria-label="Delete ' + htmlAttr(f.name) + '" onclick="deleteCustomFood(\'' + id + '\')">✕</button>' : '')
        + '</div>';
    });
  });
  return out || '<p class="sub" style="margin-top:10px">No ingredients match your search.</p>';
}

function onLibFoodSearchInput(v){
  libFoodQuery = v;
  const el = document.getElementById('libFoodList');
  if(el) el.innerHTML = renderLibFoodListMarkup(v);
}

/* ---------------- new ingredient form ---------------- */
const FOOD_CATEGORIES = ['Produce', 'Protein', 'Dairy', 'Pantry', 'Bakery', 'Frozen']; // matches data/foods.js ALLOWED_CATS
const FOOD_FORM_FLAGS = ['lowGI', 'omega3', 'highFiber', 'glutenFree'];
const FOOD_FLAG_LABELS = {lowGI: 'Low-GI', omega3: 'Omega-3', highFiber: 'High fiber', glutenFree: 'Gluten-free'};
function flagLabel(fl){ return FOOD_FLAG_LABELS[fl] || fl; }

let newFoodForm = null;

function openNewFoodForm(){
  newFoodForm = {name: '', cat: 'Produce', protein: 0, carbs: 0, fat: 0, satFat: 0, fiber: 0, flags: []};
  document.getElementById('sheet').classList.add('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
  renderNewFoodFormSheet();
}
function renderNewFoodFormSheet(){ document.getElementById('sheetBody').innerHTML = buildNewFoodFormSheet(); }

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
  let html = '<div class="row between" style="margin-top:6px"><h2 style="margin:0">New ingredient</h2><button class="backbtn" style="margin:0" onclick="openFoodLibrary()">‹ Back</button></div>';

  html += '<div class="field"><label>Name</label>'
    + '<input class="inp" style="width:100%;box-sizing:border-box;border:1px solid var(--line);margin-top:6px" type="text" value="' + htmlAttr(f.name) + '" oninput="newFoodForm.name=this.value" placeholder="e.g. Tempeh" autocomplete="off"></div>';

  html += '<div class="field"><label>Category</label><div class="row" style="gap:7px;flex-wrap:wrap;margin-top:6px">'
    + FOOD_CATEGORIES.map(function(c){ return '<button class="pill ghost chip-preset' + (f.cat === c ? ' chipsel' : '') + '" onclick="setNewFoodCat(\'' + c + '\')">' + c + '</button>'; }).join('')
    + '</div></div>';

  [['protein', 'Protein'], ['carbs', 'Carbs'], ['fat', 'Fat'], ['satFat', 'Sat. fat'], ['fiber', 'Fiber']].forEach(function(pair){
    const key = pair[0], label = pair[1];
    html += '<div class="field"><label>' + label + ' (g / 100g)</label><div class="inp">'
      + '<span>' + label + '</span>'
      + '<span class="sv-stepper" style="margin:0">'
      + '<button onclick="stepNewFoodField(\'' + key + '\',-1)" aria-label="Decrease ' + label + '">–</button>'
      + '<span class="sv-val">' + f[key] + 'g</span>'
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

  html += '<button class="cta" onclick="saveNewFood()">Save ingredient</button>'
    + '<button class="cta ghostbtn" onclick="openFoodLibrary()">Cancel</button>';
  return html;
}

function setNewFoodCat(c){ newFoodForm.cat = c; renderNewFoodFormSheet(); }
function toggleNewFoodFlag(fl){
  const i = newFoodForm.flags.indexOf(fl);
  if(i === -1) newFoodForm.flags.push(fl); else newFoodForm.flags.splice(i, 1);
  renderNewFoodFormSheet();
}
function stepNewFoodField(key, delta){
  newFoodForm[key] = Math.max(0, +(newFoodForm[key] + delta).toFixed(1));
  renderNewFoodFormSheet();
}

function saveNewFood(){
  const f = newFoodForm;
  const name = (f.name || '').trim();
  if(!name){ toast('Give this ingredient a name'); return; }
  const lower = name.toLowerCase();
  const dup = Object.keys(FOODS).some(function(id){ return FOODS[id].name.toLowerCase() === lower; });
  if(dup){ toast('“' + name + '” already exists — try a different name'); return; }
  if(f.protein < 0 || f.carbs < 0 || f.fat < 0 || f.satFat < 0 || f.fiber < 0){ toast('Values must be zero or more'); return; }
  if(f.satFat > f.fat + 1e-9){ toast('Sat. fat can’t exceed total fat'); return; }
  if(f.fiber > f.carbs + 1e-9){ toast('Fiber can’t exceed total carbs'); return; }
  if(f.protein + f.carbs + f.fat > 100 + 1e-9){ toast('Protein + carbs + fat can’t exceed 100g per 100g'); return; }

  const id = uniqueSlug(slugify(name), FOODS, 'cf-');
  const kcal = computeNewFoodKcal(f);
  customFoods[id] = {
    name: name, per: 100, unit: 'g',
    kcal: kcal, protein: f.protein, carbs: f.carbs, fat: f.fat, satFat: f.satFat, fiber: f.fiber,
    flags: f.flags.slice(), cat: f.cat, src: 'User-added ingredient'
  };
  customRev++;
  applyCustomFoods();
  applyProf(currentProf); // regenerates the week if the signature (customRev) changed, persists
  toast('✓ ' + name + ' added — ' + kcal + ' kcal / 100g');
  newFoodForm = null;
  openFoodLibrary();
  renderFoodLibraryCount();
}

function deleteCustomFood(id){
  if(!customFoods[id]) return;
  const usedBy = Object.keys(customRecipes).filter(function(rid){
    return (customRecipes[rid].ingredients || []).some(function(ing){ return ing[0] === id; });
  });
  if(usedBy.length){
    const names = usedBy.map(function(rid){ return customRecipes[rid].title; }).join(', ');
    toast('Can’t delete — used in ' + names + '. Delete that recipe first.');
    return;
  }
  const name = customFoods[id].name;
  delete customFoods[id];
  customRev++;
  applyCustomFoods();
  applyProf(currentProf);
  toast('✓ Deleted ' + name);
  renderFoodLibraryCount();
  if(document.getElementById('sheet').classList.contains('show')) openFoodLibrary();
}

/* ===================================================================
   FEATURE 2 — My recipes sheet + builder
   =================================================================== */
function openMyRecipes(){
  document.getElementById('sheetBody').innerHTML = buildMyRecipesSheet();
  document.getElementById('sheet').classList.add('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

function buildMyRecipesSheet(){
  let html = '<div class="row between" style="margin-top:6px"><h2 style="margin:0">My recipes</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
    + '<button class="cta ghostbtn" style="margin-top:10px" onclick="openNewRecipeForm()">＋ New recipe</button>';
  const ids = Object.keys(customRecipes).sort(function(a, b){
    return customRecipes[a].title < customRecipes[b].title ? -1 : (customRecipes[a].title > customRecipes[b].title ? 1 : 0);
  });
  if(!ids.length){
    html += '<p class="sub" style="margin-top:14px">No recipes yet — tap ＋ New recipe to add your first one. It’ll show up here and in the planner automatically.</p>';
    return html;
  }
  html += '<div style="margin-top:4px">' + ids.map(function(id){
    const r = customRecipes[id];
    const nut = recipeNutrition(id, 1).totals;
    return '<div class="altrow" style="cursor:default"><div class="ae">' + r.emoji + '</div>'
      + '<div class="at"><div class="an">' + escapeHtml(r.title) + ' <span class="pill mini gold">yours</span></div>'
      + '<div class="ad">' + SLOT_LABEL[r.slot] + ' · ' + Math.round(nut.kcal) + ' kcal · ' + Math.round(nut.protein) + 'g protein</div></div>'
      + '<button class="lib-del" aria-label="Delete ' + htmlAttr(r.title) + '" onclick="deleteCustomRecipe(\'' + id + '\')">✕</button>'
      + '</div>';
  }).join('') + '</div>';
  return html;
}

function deleteCustomRecipe(id){
  if(!customRecipes[id]) return;
  const title = customRecipes[id].title;
  delete customRecipes[id];
  customRev++;
  applyCustomRecipes();
  applyProf(currentProf); // signature (customRev) changed -> ensureWeekPlan() regenerates
  toast('✓ Deleted ' + title);
  renderFoodLibraryCount();
  if(document.getElementById('sheet').classList.contains('show')) openMyRecipes();
}

/* ---------------- recipe builder ---------------- */
const RECIPE_SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'];
let recipeBuilder = null;

function openNewRecipeForm(){
  recipeBuilder = {name: '', emoji: '🍽️', slot: 'dinner', time: 20, ingredients: [], stepsText: '', pickerQuery: ''};
  document.getElementById('sheet').classList.add('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
  renderRecipeBuilderSheet();
}
function renderRecipeBuilderSheet(){ document.getElementById('sheetBody').innerHTML = buildRecipeBuilderSheet(); }

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
  const meta = deriveRecipeMeta(rb.ingredients, totals, rb.time);

  let html = '<div class="row between" style="margin-top:6px"><h2 style="margin:0">New recipe</h2><button class="backbtn" style="margin:0" onclick="openMyRecipes()">‹ Back</button></div>';

  html += '<div class="field"><label>Name</label>'
    + '<input class="inp" style="width:100%;box-sizing:border-box;border:1px solid var(--line);margin-top:6px" type="text" value="' + htmlAttr(rb.name) + '" oninput="recipeBuilder.name=this.value" placeholder="e.g. Tempeh bowl" autocomplete="off"></div>';

  html += '<div class="field"><label>Emoji</label>'
    + '<input class="inp" style="width:64px;box-sizing:border-box;border:1px solid var(--line);margin-top:6px;text-align:center;font-size:19px" type="text" maxlength="4" value="' + htmlAttr(rb.emoji) + '" oninput="recipeBuilder.emoji=this.value"></div>';

  html += '<div class="field"><label>Meal slot</label><div class="row" style="gap:7px;flex-wrap:wrap;margin-top:6px">'
    + RECIPE_SLOTS.map(function(s){ return '<button class="pill ghost chip-preset' + (rb.slot === s ? ' chipsel' : '') + '" onclick="setRecipeSlot(\'' + s + '\')">' + SLOT_LABEL[s] + '</button>'; }).join('')
    + '</div></div>';

  html += '<div class="field"><label>Prep time</label><div class="inp"><span>Minutes</span>'
    + '<span class="sv-stepper" style="margin:0">'
    + '<button onclick="stepRecipeTime(-5)" aria-label="Decrease time">–</button><span class="sv-val">' + rb.time + ' min</span>'
    + '<button onclick="stepRecipeTime(5)" aria-label="Increase time">+</button></span></div></div>';

  html += '<h2 style="margin-top:18px">Ingredients <span class="sub" style="font-weight:400;font-size:12px">(' + rb.ingredients.length + ', need at least 2)</span></h2>';
  rb.ingredients.forEach(function(row, i){
    const food = FOODS[row.foodId];
    if(!food) return;
    const pieceHint = food.unit === 'piece' ? ' (≈' + (+(row.grams / food.avgG).toFixed(1)) + ' piece)' : '';
    html += '<div class="field"><div class="inp"><span>' + escapeHtml(food.name) + '</span>'
      + '<span class="sv-stepper" style="margin:0">'
      + '<button onclick="stepRecipeIngredientGrams(' + i + ',-10)" aria-label="Decrease grams">–</button>'
      + '<span class="sv-val">' + row.grams + 'g' + pieceHint + '</span>'
      + '<button onclick="stepRecipeIngredientGrams(' + i + ',10)" aria-label="Increase grams">+</button>'
      + '<button class="lib-del" style="margin-left:4px" aria-label="Remove ' + htmlAttr(food.name) + '" onclick="removeRecipeIngredient(' + i + ')">✕</button>'
      + '</span></div></div>';
  });
  html += '<button class="cta ghostbtn" style="margin-top:2px" onclick="openAddIngredientToRecipe()">＋ Add ingredient</button>';

  html += '<div class="field" style="margin-top:16px"><label>Steps (one per line, optional)</label>'
    + '<textarea class="inp" style="width:100%;box-sizing:border-box;min-height:90px;border:1px solid var(--line);margin-top:6px;display:block;resize:vertical;font:inherit" oninput="recipeBuilder.stepsText=this.value" placeholder="Combine and enjoy.">' + escapeHtml(rb.stepsText) + '</textarea></div>';

  html += '<div class="card" style="padding:14px;margin-top:14px">'
    + '<div class="row between"><b style="font-size:13px">Per serving</b><span class="chip-computed">✓ computed</span></div>'
    + '<div class="nutri" style="margin-top:8px">'
    + '<div class="n"><div class="nt"><span>Calories</span><b>' + Math.round(totals.kcal) + ' kcal</b></div></div>'
    + '<div class="n"><div class="nt"><span>Protein</span><b>' + Math.round(totals.protein) + ' g</b></div></div>'
    + '<div class="n"><div class="nt"><span>Carbs</span><b>' + Math.round(totals.carbs) + ' g</b></div></div>'
    + '<div class="n"><div class="nt"><span>Fat</span><b>' + Math.round(totals.fat) + ' g</b></div></div>'
    + '</div>'
    + '<div class="sub" style="margin-top:8px">Auto tags: ' + (meta.tags.length ? meta.tags.map(tagLabelForPreview).join(', ') : '—') + '</div>'
    + '<div class="sub" style="margin-top:2px">Styles: ' + meta.styles.join(', ') + '</div>'
    + (meta.avoid.length ? '<div class="sub" style="margin-top:2px">Contains: ' + meta.avoid.map(avoidLabel).join(', ') + '</div>' : '')
    + '</div>';

  if(rb.ingredients.length){
    const warn = kcalBandWarning(rb.slot, totals.kcal);
    if(warn) html += '<div class="cap-note" style="color:#b25e35;margin-top:8px">' + warn + '</div>';
  }

  html += '<button class="cta" style="margin-top:16px" onclick="saveNewRecipe()">Save recipe</button>'
    + '<button class="cta ghostbtn" onclick="openMyRecipes()">Cancel</button>';
  return html;
}

function setRecipeSlot(s){ recipeBuilder.slot = s; renderRecipeBuilderSheet(); }
function stepRecipeTime(delta){ recipeBuilder.time = Math.max(2, Math.min(180, recipeBuilder.time + delta)); renderRecipeBuilderSheet(); }
function stepRecipeIngredientGrams(i, delta){
  const row = recipeBuilder.ingredients[i];
  if(!row) return;
  row.grams = Math.max(10, row.grams + delta);
  renderRecipeBuilderSheet();
}
function removeRecipeIngredient(i){
  recipeBuilder.ingredients.splice(i, 1);
  renderRecipeBuilderSheet();
}

/* ---------------- add-ingredient picker (reuses render.js:searchFoods) ---------------- */
function openAddIngredientToRecipe(){
  recipeBuilder.pickerQuery = '';
  document.getElementById('sheetBody').innerHTML = buildRecipeIngredientPickerSheet();
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
      + '<div class="ae">🥕</div>'
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

function saveNewRecipe(){
  const rb = recipeBuilder;
  const name = (rb.name || '').trim();
  if(!name){ toast('Give this recipe a name'); return; }
  const lower = name.toLowerCase();
  const dup = Object.keys(RECIPES_DB).some(function(id){ return RECIPES_DB[id].title.toLowerCase() === lower; });
  if(dup){ toast('“' + name + '” already exists — try a different name'); return; }
  if(rb.ingredients.length < 2){ toast('Add at least 2 ingredients'); return; }

  const totals = computeBuilderTotals();
  const meta = deriveRecipeMeta(rb.ingredients, totals, rb.time);
  const stepsArr = (rb.stepsText || '').split('\n').map(function(s){ return s.trim(); }).filter(function(s){ return !!s; });

  const id = uniqueSlug(slugify(name), RECIPES_DB, 'cr-');
  customRecipes[id] = {
    title: name, emoji: (rb.emoji || '').trim() || '🍽️', slot: rb.slot,
    styles: meta.styles, time: rb.time,
    ingredients: rb.ingredients.map(function(r){ return [r.foodId, r.grams]; }),
    toTaste: [],
    steps: stepsArr.length ? stepsArr : ['Combine and enjoy.'],
    tags: meta.tags, avoid: meta.avoid
  };
  customRev++;
  applyCustomRecipes();
  applyProf(currentProf); // signature (customRev) changed -> ensureWeekPlan() regenerates, persists
  toast('✓ ' + name + ' added to My recipes');
  recipeBuilder = null;
  openMyRecipes();
  renderFoodLibraryCount();
}
