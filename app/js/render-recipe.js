/* render-recipe.js — recipe detail rendering, options chips, serving context */
/* ---------------- recipe detail rendering ---------------- */
let recipeServingCtx = null;

function recipeServingContextFor(key){
  const person = (recipeDayCtx && recipeDayCtx.person) || currentProf;
  function fromPlan(weekStartDate, dayIndex, slot){
    const plan = ensureWeekPlan(weekStartDate);
    const day = plan.days && plan.days[dayIndex];
    const meal = day && day.meals && day.meals[slot];
    if(!meal) return null;
    const dateISO = day.date || addDaysISO(plan.weekStartDate, dayIndex);
    const logged = loggedPlanEntryForSlot(dateISO, person, slot);
    if(logged && logged.ref === key){
      // task D1: the frozen variant this slot was actually logged with, if any — the
      // recipe-screen chips (renderRecipeOptionsChips) open pre-selected to it.
      const loggedComponents = Array.isArray(logged.components) && logged.components.length ? logged.components : null;
      const loggedOpts = loggedComponents && loggedComponents[0] && loggedComponents[0].opts;
      return {weekStartDate: weekStartDate, dayIndex: dayIndex, dateISO: dateISO, slot: slot, shared: false, solo: logged.portion || 1, person: person, source: 'logged', opts: loggedOpts};
    }
    if(meal.shared && meal.recipeId === key){
      return {weekStartDate: weekStartDate, dayIndex: dayIndex, dateISO: dateISO, slot: slot, shared: true, svE: meal.elena.portion, svM: meal.partner.portion, person: person, source: 'plan', opts: meal.elena.opts};
    }
    if(meal[person] && meal[person].recipeId === key){
      return {weekStartDate: weekStartDate, dayIndex: dayIndex, dateISO: dateISO, slot: slot, shared: false, solo: meal[person].portion, person: person, source: 'plan', opts: meal[person].opts};
    }
    return null;
  }

  if(recipeDayCtx && recipeDayCtx.slot && typeof recipeDayCtx.dayIndex === 'number'){
    const ctx = fromPlan(recipeDayCtx.weekStartDate || mondayOfWeek(todayISO()), recipeDayCtx.dayIndex, recipeDayCtx.slot);
    if(ctx) return ctx;
  }

  const currentPlan = ensureWeekPlan(mondayOfWeek(todayISO()));
  const todayIdx = todayDayIndex();
  for(let i = 0; i < SLOT_ORDER.length; i++){
    const ctx = fromPlan(currentPlan.weekStartDate, todayIdx, SLOT_ORDER[i]);
    if(ctx) return ctx;
  }
  return null;
}

// Per-serving ingredient display rows: [displayName, qty, unit] — moved verbatim from the
// old state.js:buildLegacyRecipesCompat() compat view (removed; RECIPES_DB + this helper
// are now the only source for the recipe screen's ingredient list). Quantities are scaled
// to ONE serving (recipe batch / servings, same scale recipeNutrition(id, 1) uses);
// piece-unit foods (FOODS[id].unit === 'piece', e.g. eggs) convert grams to a piece count
// via avgG instead of showing grams; toTaste entries (pantry staples not counted in
// nutrition) append as [label, null, 'to taste'] rows. updateServings() multiplies qty by
// the current total servings at render time.
// `opts` (task D1, optional — {groupKey: choiceId}): resolved through
// engine.js:recipeEffectiveIngredients, the same single source recipeNutrition/
// computeShoppingList/validate.js's recipeMacros read through, so the ingredient rows a
// recipe with optionGroups shows always match whichever variant's numbers are on screen.
// Every pre-existing call site omits `opts`, which normalizes to the deterministic
// default combo for a recipe WITH optionGroups, or {} (bare `ingredients`, unchanged) for
// one without — byte-identical to pre-D1 output either way.
function recipeDisplayIngredients(recipeId, opts){
  const src = RECIPES_DB[recipeId];
  if(!src) return [];
  const batchYield = (typeof src.servings === 'number' && src.servings > 0) ? src.servings : 1;
  const ingredients = recipeEffectiveIngredients(src, opts).map(function(ing){
    const foodId = ing[0], grams = +(ing[1] / batchYield).toFixed(1);
    const food = FOODS[foodId];
    if(!food){ console.error('recipeDisplayIngredients: "' + recipeId + '" ingredient food id "' + foodId + '" not found in FOODS'); return [foodId, grams, 'g']; }
    if(food.unit === 'piece') return [food.name, +(grams / food.avgG).toFixed(2), ''];
    return [food.name, grams, food.unit];
  });
  (src.toTaste || []).forEach(function(t){ ingredients.push([capitalizeFirst(t), null, 'to taste']); });
  return ingredients;
}

// RECIPES_DB[id].tags (raw tag strings) mapped through TAG_PILL_MAP (state.js) to the
// legacy [pillClass, label] pill pairs the recipe screen/Today cards already know how to
// paint — moved verbatim from the old buildLegacyRecipesCompat() compat view.
function recipeDisplayPills(recipeId){
  const src = RECIPES_DB[recipeId];
  if(!src || !Array.isArray(src.tags)) return [];
  // Tags without an approved, factual display label are internal catalog metadata, not
  // user-facing health claims (for example the retired thyroid/skin/low-GI labels).
  return src.tags.filter(function(t){ return !!TAG_PILL_MAP[t]; }).map(function(t){ return TAG_PILL_MAP[t]; });
}

// task D1: the ONE title helper every Today/Week/Log/recipe-screen path reads through
// (mealTitleWithExtras, logEntryTitleWithComponents, renderRecipe/renderRecipeMealStrip
// below) so a plan/log title can never show one variant's label while another surface
// shows a different (or no) one. Recipes without optionGroups: identical to the bare
// title (byte-for-byte — no parens, no behavior change). `opts` missing/invalid falls
// back to the deterministic default combo (normalizeRecipeOpts), so a stale/legacy
// component with no `.opts` field still shows a sensible ("default choice") label.
function recipeDisplayTitle(id, opts){
  const r = RECIPES_DB[id];
  if(!r) return '';
  if(!Array.isArray(r.optionGroups) || !r.optionGroups.length) return r.title;
  const normalized = normalizeRecipeOpts(r, opts);
  const labels = r.optionGroups.map(function(group){
    if(!group || typeof group.key !== 'string') return null;
    const choiceId = normalized[group.key];
    const choice = (group.choices || []).filter(function(c){ return c && c.id === choiceId; })[0];
    return choice ? choice.label : null;
  }).filter(Boolean);
  return labels.length ? (r.title + ' (' + labels.join(', ') + ')') : r.title;
}

const DEFAULT_RECIPE_IMAGE_ASSET = 'assets/recipes/default-recipe.png';
const RECIPE_IMAGE_KEYS = [
  'default-recipe', 'breakfast-bowl', 'salad', 'soup', 'pasta',
  'cooked-vegetables', 'meat-main', 'fish-main', 'dessert-sweets', 'ice-cream',
  'ramen', 'butter-chicken', 'chinese-dinner', 'fast-food-menu', 'onigiri',
  'french-toast', 'pancakes', 'boiled-chicken-broth', 'burrito',
  'citrus-roast-turkey', 'club-sandwich', 'shakshuka',
  'polpette-tacchino-yogurt-menta', 'feta-filo-miele-noodles-verdure',
  'pomodori-al-riso', 'ricotta-pere-noci-toast', 'uova-avocado-toast',
  'carrots-over-hummus', 'spring-rolls', 'pizza', 'snack-board'
];

function recipeImageLabel(key){
  if(typeof RECIPES_DB !== 'undefined' && RECIPES_DB[key] && RECIPES_DB[key].title) return RECIPES_DB[key].title;
  const labels = {
    'default-recipe': 'Default',
    'breakfast-bowl': 'Breakfast bowl',
    'salad': 'Salad',
    'soup': 'Soup',
    'pasta': 'Pasta',
    'cooked-vegetables': 'Cooked veg',
    'meat-main': 'Meat main',
    'fish-main': 'Fish main',
    'dessert-sweets': 'Dessert',
    'ice-cream': 'Ice cream',
    'ramen': 'Ramen',
    'butter-chicken': 'Butter chicken',
    'chinese-dinner': 'Chinese dinner',
    'fast-food-menu': 'Fast food',
    'onigiri': 'Onigiri',
    'french-toast': 'French toast',
    'pancakes': 'Pancakes',
    'boiled-chicken-broth': 'Chicken broth',
    'burrito': 'Burrito',
    'citrus-roast-turkey': 'Citrus turkey',
    'club-sandwich': 'Club sandwich',
    'shakshuka': 'Shakshuka',
    'snack-board': 'Snack board'
  };
  return labels[key] || String(key || '').replace(/-/g, ' ');
}

function availableRecipeImageKeys(){
  return RECIPE_IMAGE_KEYS.slice();
}

function safeRecipeImageKey(v){
  v = String(v || '').trim();
  return (RECIPE_IMAGE_KEYS.indexOf(v) !== -1) ? v : '';
}

function safeRecipeImageAsset(v){
  v = String(v || '').trim();
  return /^assets\/recipes\/[a-z0-9][a-z0-9-]*\.png$/.test(v) ? v : '';
}

const FISH_RECIPE_INGREDIENT_IDS = ['salmon-fillet', 'tuna-in-olive-oil', 'tuna', 'cod', 'prawns', 'clams', 'mussels', 'sole-fish'];

function recipeHasFishIngredient(recipe){
  if(!recipe || !Array.isArray(recipe.ingredients)) return false;
  return recipe.ingredients.some(function(ing){
    const id = String((ing && ing[0]) || '');
    if(FISH_RECIPE_INGREDIENT_IDS.indexOf(id) !== -1) return true;
    const f = (typeof FOODS !== 'undefined') && FOODS[id];
    const text = (id + ' ' + (f && f.name ? f.name : '')).toLowerCase();
    return /salmon|salmone|cod|tuna|tonno|sole|sogliola|fish|prawn|shrimp|clam|mussel/.test(text);
  });
}

function inferredRecipeImageKey(recipe, recipeId){
  if(!recipe) return 'default-recipe';
  const title = String(recipe.title || '').toLowerCase();
  const emoji = String(recipe.emoji || '');
  const tags = Array.isArray(recipe.tags) ? recipe.tags : [];
  const foodIds = Array.isArray(recipe.ingredients) ? recipe.ingredients.map(function(ing){ return ing && ing[0]; }) : [];
  const foodText = foodIds.map(function(id){
    const f = (typeof FOODS !== 'undefined') && FOODS[id];
    return (id || '') + ' ' + (f && f.name ? f.name : '');
  }).join(' ').toLowerCase();
  const haystack = title + ' ' + emoji + ' ' + tags.join(' ') + ' ' + foodText;

  if(/ramen/.test(haystack)) return 'ramen';
  if(/butter chicken|curry/.test(haystack)) return 'butter-chicken';
  if(/chinese|spring roll|dumpling|ravioli|almond chicken/.test(haystack)) return 'chinese-dinner';
  if(/mcdonald|burger king|fast food|burger|fries|cola/.test(haystack)) return 'fast-food-menu';
  if(/onigiri|rice ball/.test(haystack)) return 'onigiri';
  if(/french toast/.test(haystack)) return 'french-toast';
  if(/pancake/.test(haystack)) return 'pancakes';
  if(/boiled chicken|chicken in broth|pollo bollito/.test(haystack)) return 'boiled-chicken-broth';
  if(/burrito/.test(haystack)) return 'burrito';
  if(/citrus roast turkey|orange.*turkey|turkey.*orange/.test(haystack)) return 'citrus-roast-turkey';
  if(/club sandwich/.test(haystack)) return 'club-sandwich';
  if(/shakshuka/.test(haystack)) return 'shakshuka';
  if(/gelato|ice cream/.test(haystack)) return 'ice-cream';
  if(/brownie|dessert|sweet|sweets|chocolate/.test(haystack)) return 'dessert-sweets';
  if(/soup|zuppa|broth|minestrone|stew/.test(haystack)) return 'soup';
  if(/pasta|spaghetti|lasagna|tagliatelle|penne|fusilli/.test(haystack)) return 'pasta';
  if(/salad|insalata|cous cous/.test(haystack) || emoji === '🥗') return 'salad';
  if(recipeHasFishIngredient(recipe) || /salmon|salmone|cod|tuna|tonno|sole|sogliola|fish|prawn|shrimp|clam|mussel/.test(haystack)) return 'fish-main';
  if(recipe.slot === 'breakfast') return 'breakfast-bowl';
  if(recipe.slot === 'lunch') return 'salad';
  if(recipe.slot === 'dinner') return 'default-recipe';
  if(/breakfast|yogurt|skyr|oats|cereali|chia|pudding|bowl/.test(haystack)) return 'breakfast-bowl';
  if(/chicken|pollo|turkey|tacchino|beef|manzo|pork|maiale|bacon|prosciutto|speck|sausage|meat|burger/.test(haystack)) return 'meat-main';
  if(recipe.role === 'side' || tags.indexOf('veggie') !== -1 || /verdure|vegetable|veg|broccoli|cavolfiore|asparagi|pak choy|scarola|carrots|carote/.test(haystack)) return 'cooked-vegetables';
  return 'default-recipe';
}

function recipeImageAssetForRecipe(recipe, recipeId){
  if(!recipe) return '';
  const imageUri = safeRecipeImageAsset(recipe.imageUri);
  if(imageUri) return imageUri;
  const imageKey = safeRecipeImageKey(recipe.imageKey) || inferredRecipeImageKey(recipe, recipeId);
  const src = safeRecipeImageAsset('assets/recipes/' + imageKey + '.png');
  return src || DEFAULT_RECIPE_IMAGE_ASSET;
}

function recipeHeroHtml(recipe, recipeId){
  if(!recipe) return '';
  const emoji = recipe.emoji || '';
  const src = safeRecipeImageAsset(recipeImageAssetForRecipe(recipe, recipeId)) || DEFAULT_RECIPE_IMAGE_ASSET;
  return '<img class="recipe-image" src="' + htmlAttr(src) + '" alt="" aria-hidden="true" loading="lazy" data-fallback="' + htmlAttr(emoji) + '" onerror="this.onerror=null;this.replaceWith(document.createTextNode(this.getAttribute(\'data-fallback\')||\'\'))">';
}

function renderRecipe(key){
  const r = RECIPES_DB[key] || RECIPES_DB.salmon;
  currentRecipeKey = RECIPES_DB[key] ? key : 'salmon';
  svE = 1; svM = 1.5; svS = 1;
  recipeServingCtx = recipeServingContextFor(currentRecipeKey);
  if(recipeServingCtx){
    if(recipeServingCtx.shared){
      svE = recipeServingCtx.svE || 1;
      svM = recipeServingCtx.svM || 1.5;
    } else {
      svS = recipeServingCtx.solo || 1;
    }
  }
  // task D1: opens pre-selected to whatever variant this slot is actually planned/logged
  // with (recipeServingCtx.opts), falling back to the deterministic default combo when
  // opened from the library (no plan/log context) or for a recipe without optionGroups —
  // normalizeRecipeOpts handles both (bad/missing opts -> default, {} when no groups).
  recipeOptsCtx = normalizeRecipeOpts(r, recipeServingCtx && recipeServingCtx.opts);
  const base = recipeNutrition(currentRecipeKey, 1, recipeOptsCtx).totals; // one serving, same scale the old compat view used
  document.getElementById('recipeHero').innerHTML = recipeHeroHtml(r, currentRecipeKey);
  document.getElementById('recipeTitle').textContent = recipeDisplayTitle(currentRecipeKey, recipeOptsCtx);
  document.getElementById('rsTime').textContent = '⏱️ ' + r.time + ' min';
  document.getElementById('rsKcal').textContent = '🔥 ' + Math.round(base.kcal) + ' kcal';
  document.getElementById('rsProt').textContent = '💪 ' + Math.round(base.protein) + 'g protein';
  document.getElementById('recipeTags').innerHTML = recipeDisplayPills(currentRecipeKey).map(function(t){ return '<span class="pill'+(t[0]?' '+t[0]:'')+'">'+t[1]+'</span>'; }).join('');
  renderRecipeDetailActions();
  renderRecipeOptionsChips();
  updateRecipeWhy();
  document.getElementById('recipeMethod').innerHTML = r.steps.map(function(s){ return '<li>'+escapeHtml(s)+'</li>'; }).join('');
  updateServings();
  renderRecipeMealStrip();
}

// Keep recipe management adjacent to the identity of the recipe, not mixed into the
// cooking flow. Logging is intentionally absent: a meal is confirmed only from Today.
function renderRecipeDetailActions(){
  const wrap = document.getElementById('recipeDetailActions');
  const r = RECIPES_DB[currentRecipeKey];
  if(!wrap || !r) return;
  const hasMeal = !!(recipeServingCtx && recipeServingCtx.slot);
  let html = '<button class="recipe-action recipe-action-primary" onclick="openRecipeEditorFromDetail()">✎ Edit recipe</button>';
  if(hasMeal){
    html += '<button class="recipe-action" onclick="manageRecipeMealFromDetail()">☷ Manage meal</button>';
    html += '<button class="recipe-action recipe-action-quiet" onclick="openSwap(recipeServingCtx.slot,null)">↔ Swap</button>';
  }
  if(recipeOverrides[currentRecipeKey]) html += '<button class="recipe-action recipe-action-quiet" onclick="resetRecipeFromDetail()">↺ Reset</button>';
  if(customRecipes[currentRecipeKey]) html += '<button class="recipe-action recipe-action-danger" onclick="deleteRecipeFromDetail()">Delete</button>';
  wrap.innerHTML = html;
}

function openRecipeEditorFromDetail(){ openEditRecipeForm(currentRecipeKey); }
function manageRecipeMealFromDetail(){
  if(!recipeServingCtx || !recipeServingCtx.slot) return;
  openAddMealSheetForContext({weekStartDate: recipeServingCtx.weekStartDate || mondayOfWeek(recipeServingCtx.dateISO || todayISO()), dayIndex: recipeServingCtx.dayIndex, slot: recipeServingCtx.slot, person: recipeServingCtx.person || currentProf});
}
function resetRecipeFromDetail(){
  resetRecipeOverride(currentRecipeKey);
  persist();
  renderRecipe(currentRecipeKey);
}
function deleteRecipeFromDetail(){
  const id = currentRecipeKey;
  deleteRecipe(id);
  persist();
  backFromRecipe();
}

/* ---------------- task D1: recipe options/variants — recipe-screen chips ----------------
   recipeOptsCtx holds the currently-shown combo ({groupKey: choiceId}) for
   currentRecipeKey — set fresh by renderRecipe() on open, updated in place by
   chooseRecipeOption() on a chip tap. A chip row per optionGroups group (existing
   .pill.chip-preset/.chipsel look, sized to the 44px tap-target minimum via
   .recipe-opt-chip in mesa.css); nothing renders for a recipe without optionGroups. */
let recipeOptsCtx = null;

// task D3: pure HTML-string builder, split out of renderRecipeOptionsChips() below in the
// same buildXxx()/renderXxx() pattern js/library.js's builder sheets already use, so it's
// testable headlessly (tools/check.js's hostile-label coverage — group/choice labels are
// now USER-CONTROLLED text via the recipe builder's Options section, not just D1's
// app-authored built-in copy). `resolvedOpts` must already be normalizeRecipeOpts() output
// (every group has an entry) — callers normalize first, same contract this logic upheld
// inline before the split. Choice ids/group keys still ride data-* attributes with a
// delegated handler (attachRecipeOptionsHandler) rather than inline onclick — group keys/
// choice ids are user-derived slugs now, never safe to interpolate into a JS-string
// context — and labels go through escapeHtml (text-node context) / htmlAttr (attribute
// context) like every other dynamic string in this file.
function buildRecipeOptionsChipsHtml(recipe, resolvedOpts){
  if(!recipe || !Array.isArray(recipe.optionGroups) || !recipe.optionGroups.length) return '';
  return recipe.optionGroups.map(function(group){
    const chips = (group.choices || []).map(function(choice){
      const on = resolvedOpts[group.key] === choice.id;
      return '<button type="button" class="pill ghost chip-preset recipe-opt-chip' + (on ? ' chipsel' : '') + '"'
        + ' data-opt-group="' + htmlAttr(group.key) + '" data-opt-choice="' + htmlAttr(choice.id) + '">'
        + escapeHtml(choice.label) + '</button>';
    }).join('');
    return '<div class="row" style="gap:6px;flex-wrap:wrap;margin-top:8px;align-items:center">'
      + '<span class="sub" style="margin:0 2px 0 0">' + escapeHtml(group.label) + '</span>' + chips + '</div>';
  }).join('');
}

function renderRecipeOptionsChips(){
  const wrap = document.getElementById('recipeOptionsWrap');
  if(!wrap) return;
  const r = RECIPES_DB[currentRecipeKey];
  if(!r || !Array.isArray(r.optionGroups) || !r.optionGroups.length){
    wrap.innerHTML = '';
    wrap.style.display = 'none';
    return;
  }
  recipeOptsCtx = normalizeRecipeOpts(r, recipeOptsCtx);
  wrap.style.display = 'block';
  wrap.innerHTML = buildRecipeOptionsChipsHtml(r, recipeOptsCtx);
  attachRecipeOptionsHandler();
}

function attachRecipeOptionsHandler(){
  const wrap = document.getElementById('recipeOptionsWrap');
  if(!wrap) return;
  wrap.onclick = function(e){
    const btn = e.target.closest('button[data-opt-group]');
    if(!btn || !wrap.contains(btn)) return;
    chooseRecipeOption(btn.getAttribute('data-opt-group'), btn.getAttribute('data-opt-choice'));
  };
}

// A chip tap: updates the currently-shown combo, recomputes ingredients/nutrition live at
// the current servings (same recompute updateServings() already does on a servings-
// stepper tap), writes back to whatever plan/log context this recipe screen opened from
// (applyRecipeOptsOverride — mirrors adjServe/applyRecipeServingOverride's mechanics
// exactly), and repaints the chip row so the new selection highlights.
function chooseRecipeOption(groupKey, choiceId){
  const r = RECIPES_DB[currentRecipeKey];
  if(!r || !Array.isArray(r.optionGroups)) return;
  const group = r.optionGroups.filter(function(g){ return g.key === groupKey; })[0];
  if(!group || !(group.choices || []).some(function(c){ return c.id === choiceId; })) return;
  const requested = Object.assign({}, recipeOptsCtx);
  requested[groupKey] = choiceId;
  recipeOptsCtx = normalizeRecipeOpts(r, requested);
  document.getElementById('recipeTitle').textContent = recipeDisplayTitle(currentRecipeKey, recipeOptsCtx);
  renderRecipeOptionsChips();
  updateServings();
  applyRecipeOptsOverride();
  persist();
}

// Task C3: "why this fits you" is per-PERSON (whyText(recipeId, profKey) — state.js), so
// it can't be baked into a shared recipe object at boot. Called from renderRecipe()
// (opening a recipe) and from applyProf() (switching profile while the recipe screen is
// already open) so the copy always matches whoever's currently selected.
function updateRecipeWhy(){
  const el = document.getElementById('recipeWhy');
  if(!el || !RECIPES_DB[currentRecipeKey]) return;
  el.innerHTML = '<b>Why this fits you</b><br>' + whyText(currentRecipeKey, currentProf);
}

function adjServe(who, delta){
  if(who === 'elena'){ svE = Math.min(3, Math.max(0.5, +(svE + delta).toFixed(1))); }
  else if(who === 'andrea'){ svM = Math.min(3, Math.max(0.5, +(svM + delta).toFixed(1))); }
  else { svS = Math.min(4, Math.max(0.5, +(svS + delta).toFixed(1))); }
  updateServings();
  applyRecipeServingOverride();
  persist();
}

function applyRecipeServingOverride(){
  if(!recipeServingCtx || !recipeServingCtx.slot) return;
  const dateISO = recipeServingCtx.dateISO || todayISO();
  const slot = recipeServingCtx.slot;

  if(recipeServingCtx.source === 'logged'){
    const logged = loggedPlanEntryForSlot(dateISO, recipeServingCtx.person || currentProf, slot);
    if(!logged || logged.ref !== currentRecipeKey) return;
    const portion = recipeServingCtx.shared
      ? (currentProf === 'partner' ? svM : svE)
      : svS;
    const components = Array.isArray(logged.components) && logged.components.length
      ? logged.components.slice()
      : [{recipeId: logged.ref, portion: logged.portion || 1}];
    // task D1: carry forward whatever variant is currently shown (recipeOptsCtx) — a
    // servings-only change must not silently drop an already-chosen combo back to default.
    const baseComponent = {recipeId: currentRecipeKey, portion: portion};
    if(recipeOptsCtx && Object.keys(recipeOptsCtx).length) baseComponent.opts = recipeOptsCtx;
    components[0] = baseComponent;
    logPlanEntry(dateISO, recipeServingCtx.person || currentProf, slot, currentRecipeKey, portion, components);
    refreshAfterRecipeServingOverride(dateISO);
    return;
  }

  const weekStartDate = recipeServingCtx.weekStartDate || mondayOfWeek(dateISO);
  const dayIndex = typeof recipeServingCtx.dayIndex === 'number' ? recipeServingCtx.dayIndex : todayDayIndex();
  const plan = editableWeekPlan(weekStartDate);
  const meal = plan && plan.days && plan.days[dayIndex] && plan.days[dayIndex].meals && plan.days[dayIndex].meals[slot];
  if(!meal) return;

  if(recipeServingCtx.shared && meal.shared && meal.recipeId === currentRecipeKey){
    meal.elena.portion = svE;
    meal.partner.portion = svM;
    refreshPlanEntryNutrition(meal.elena);
    refreshPlanEntryNutrition(meal.partner);
    meal.t = Date.now();
  } else {
    const person = recipeServingCtx.person || currentProf;
    const entry = meal[person];
    if(!entry || entry.recipeId !== currentRecipeKey) return;
    entry.portion = svS;
    refreshPlanEntryNutrition(entry);
    entry.t = Date.now();
    if(!meal.shared) delete meal.t;
  }
  refreshAfterRecipeServingOverride(dateISO);
}

// task D1: writes recipeOptsCtx (the combo currently shown after a chip tap) back to the
// exact plan/log context this recipe screen opened from — mirrors
// applyRecipeServingOverride() above line for line (logged -> correct the frozen
// LogEntry's component[0] in place via logPlanEntry; plan -> mutate the meal entry/entries
// directly + refreshPlanEntryNutrition), just setting `.opts` instead of `.portion`.
// Library origin (recipeServingCtx null) previews only — nothing to write back to.
function applyRecipeOptsOverride(){
  if(!recipeServingCtx || !recipeServingCtx.slot) return;
  const dateISO = recipeServingCtx.dateISO || todayISO();
  const slot = recipeServingCtx.slot;
  const opts = recipeOptsCtx;

  if(recipeServingCtx.source === 'logged'){
    const logged = loggedPlanEntryForSlot(dateISO, recipeServingCtx.person || currentProf, slot);
    if(!logged || logged.ref !== currentRecipeKey) return;
    const portion = recipeServingCtx.shared
      ? (currentProf === 'partner' ? svM : svE)
      : svS;
    const components = Array.isArray(logged.components) && logged.components.length
      ? logged.components.slice()
      : [{recipeId: logged.ref, portion: logged.portion || 1}];
    components[0] = {recipeId: currentRecipeKey, portion: portion, opts: opts};
    logPlanEntry(dateISO, recipeServingCtx.person || currentProf, slot, currentRecipeKey, portion, components);
    refreshAfterRecipeServingOverride(dateISO);
    return;
  }

  const weekStartDate = recipeServingCtx.weekStartDate || mondayOfWeek(dateISO);
  const dayIndex = typeof recipeServingCtx.dayIndex === 'number' ? recipeServingCtx.dayIndex : todayDayIndex();
  const plan = editableWeekPlan(weekStartDate);
  const meal = plan && plan.days && plan.days[dayIndex] && plan.days[dayIndex].meals && plan.days[dayIndex].meals[slot];
  if(!meal) return;

  if(recipeServingCtx.shared && meal.shared && meal.recipeId === currentRecipeKey){
    meal.elena.opts = opts;
    meal.partner.opts = opts;
    refreshPlanEntryNutrition(meal.elena);
    refreshPlanEntryNutrition(meal.partner);
    meal.t = Date.now();
  } else {
    const person = recipeServingCtx.person || currentProf;
    const entry = meal[person];
    if(!entry || entry.recipeId !== currentRecipeKey) return;
    entry.opts = opts;
    refreshPlanEntryNutrition(entry);
    entry.t = Date.now();
    if(!meal.shared) delete meal.t;
  }
  refreshAfterRecipeServingOverride(dateISO);
}

function refreshAfterRecipeServingOverride(dateISO){
  if(dateISO === todayISO()){
    activeMenu = computeActiveMenu();
    recomputeConsumed(currentProf);
    recomputeProf(currentProf);
    refreshRingAndBars();
    renderTodayMeals();
  }
  renderLogScreen();
  renderWeek();
}

function updateServings(){
  // Task B3 (solo households): a plan-backed recipeServingCtx already carries shared:false
  // for every meal in a one-person household (planner.js:generateWeek never produces a
  // shared cell there), but the CONTEXT-LESS fallback (isShared(currentRecipeKey), reached
  // when a recipe is opened without a specific day/slot — e.g. straight from the library)
  // reads the raw household SHARED[slot] default, which is unaware of household size. Force
  // false here so the second serve card can never appear for a one-person household via
  // that path either.
  const shared = (typeof isSoloHousehold === 'function' && isSoloHousehold())
    ? false
    : (recipeServingCtx ? recipeServingCtx.shared : isShared(currentRecipeKey));
  document.getElementById('serveRowShared').style.display = shared ? 'flex' : 'none';
  document.getElementById('sharedCaption').style.display = shared ? 'block' : 'none';
  document.getElementById('serveRowSolo').style.display = shared ? 'none' : 'flex';
  // `total` scales the INGREDIENTS — the whole dish, cooked once for everyone.
  // `nutServings` scales the NUTRITION grid — only the VIEWER's own portion, because the
  // recipe screen answers "what am I eating", not "what's in the pot". For a shared meal
  // these differ (the pot is svE+svM servings, but you only eat your own); for a solo meal
  // they're the same. (A LOGGED shared meal already arrives here as solo — its per-person
  // logged portion — via recipeServingContextFor's 'logged' branch, so this only changes
  // the PLANNED shared case that used to show both people's nutrition summed.)
  let total, nutServings, nutHeader;
  if(shared){
    document.getElementById('svElenaVal').textContent = svE + '×';
    document.getElementById('svAndreaVal').textContent = svM + '×';
    total = +(svE + svM).toFixed(1);
    const viewerIsPartner = (recipeServingCtx && recipeServingCtx.person)
      ? recipeServingCtx.person === 'partner' : currentProf === 'partner';
    // Task B2 (generic identity): the viewer's own displayName, not a hardcoded person name
    // — nutHeader below is only ever assigned to .textContent (updateNutritionGrid), never
    // innerHTML, so no escapeHtml is needed here the way rebalanceSuggestionLabel's `who`
    // (further down this file) needs one.
    const viewerName = viewerIsPartner ? resolveDisplayName('partner') : resolveDisplayName('elena');
    nutServings = viewerIsPartner ? svM : svE;
    document.getElementById('rsServesMeta').textContent = '👥 ' + total + ' servings';
    document.getElementById('ingHeader').innerHTML = 'Ingredients · for the whole dish (' + total + ' servings)';
    const slot = (recipeServingCtx && recipeServingCtx.slot) || RECIPE_SLOT_DB[currentRecipeKey] || 'meal';
    document.getElementById('sharedCaption').textContent = 'Shared ' + slot + ' — cooked once for both; nutrition below is your ' + nutServings + '× portion';
    nutHeader = 'Your portion (' + viewerName + ' · ' + nutServings + '×)';
  } else {
    document.getElementById('svSoloVal').textContent = svS + '×';
    total = svS;
    nutServings = svS;
    const label = total === 1 ? 'serving' : 'servings';
    document.getElementById('rsServesMeta').textContent = '🍽️ ' + total + ' ' + label;
    document.getElementById('ingHeader').innerHTML = 'Ingredients · scaled for ' + total + ' ' + label;
    nutHeader = (total === 1) ? 'Nutrition (per serving)' : 'Nutrition · scaled for ' + total + ' servings';
  }
  const ingredients = recipeDisplayIngredients(currentRecipeKey, recipeOptsCtx);
  document.getElementById('ingList').innerHTML = ingredients.map(function(ing){
    const name = escapeHtml(ing[0]), qty = ing[1], unit = escapeHtml(String(ing[2]));
    if(qty === null) return '<li><span>'+name+'</span><span>'+unit+'</span></li>';
    const scaled = +(qty * total).toFixed(1);
    return '<li><span>'+name+'</span><span>'+scaled+' '+unit+'</span></li>';
  }).join('');
  updateNutritionGrid(nutServings, nutHeader);
  syncServeHighlight();
}

// Nutrition grid + "kcal from" split, computed fresh from recipeNutrition() at the
// current total serving scale (same scale the ingredient list above uses) — so the
// steppers rescale nutrition exactly as they rescale ingredients (task C1). Replaces
// the old hand-typed r.nutrition/r.kcalSplit fields entirely; nothing here is typed in.
// `servings` is the VIEWER's portion (updateServings passes each person their own share of
// a shared dish, not the pot total), and `headerText` is the caption updateServings already
// computed for it ("Your portion (Elena · 1×)" for shared, the per-serving/scaled label for
// solo). Kept as a param rather than re-derived here so the grid and the header can never
// disagree about how many servings they describe.
function updateNutritionGrid(servings, headerText){
  const header = document.getElementById('nutriHeader');
  if(header) header.textContent = headerText || ((servings === 1) ? 'Nutrition (per serving)' : 'Nutrition · scaled for ' + servings + ' servings');
  const nut = recipeNutrition(currentRecipeKey, servings, recipeOptsCtx).totals;
  const topKcal = document.getElementById('rsKcal');
  const topProt = document.getElementById('rsProt');
  if(topKcal) topKcal.textContent = '🔥 ' + fmtKcal(Math.round(nut.kcal)) + ' kcal';
  if(topProt) topProt.textContent = '💪 ' + Math.round(nut.protein) + 'g protein';
  const rows = [
    ['Calories', fmtKcal(Math.round(nut.kcal))],
    ['Protein', Math.round(nut.protein) + ' g'],
    ['Carbs', Math.round(nut.carbs) + ' g'],
    ['Sugars', Math.round(nut.sugars) + ' g'],
    ['Free sugars', Math.round(nut.freeSugars) + ' g'],
    ['Fat', Math.round(nut.fat) + ' g'],
    ['Non-saturated fat (estimate)', Math.round(nut.goodFat) + ' g'],
    ['Sat. fat', Math.round(nut.satFat) + ' g'],
    ['Fiber', Math.round(nut.fiber) + ' g']
  ];
  document.getElementById('recipeNutri').innerHTML = rows.map(function(n){ return '<div class="n"><div class="nt"><span>'+n[0]+'</span><b>'+n[1]+'</b></div></div>'; }).join('');
  const kcalR = nut.kcal;
  const pPct = kcalR > 0 ? Math.round(nut.protein * 4 / kcalR * 100) : 0;
  const cPct = kcalR > 0 ? Math.round(nut.carbs * 4 / kcalR * 100) : 0;
  const fPct = kcalR > 0 ? Math.round(nut.fat * 9 / kcalR * 100) : 0;
  document.getElementById('recipeKcalSplit').textContent = 'kcal from: protein ' + pPct + '% · carbs ' + cPct + '% · fat ' + fPct + '%';
}

function syncServeHighlight(){
  const se = document.getElementById('serveElena'), sm = document.getElementById('serveAndrea');
  if(!se || !sm) return;
  se.classList.toggle('me', currentProf === 'elena');
  sm.classList.toggle('me', currentProf === 'partner');
}

// Log cards are keyed by SLOT (log-breakfast...), not recipe id — resolve the slot
// first. PRODUCT REQUIREMENT: the plan must never block recording what was actually
// eaten. If this recipe isn't today's planned dish for the slot, swap the slot to it
// (chooseSwapRecipe — the same path the swap sheet uses, so an already-confirmed
// LogEntry gets corrected in place rather than duplicated) and then confirm it,
// instead of the old dead-end toast that only told you to go do it from the Log tab.
function markEatenFromRecipe(anchorEl){
  const anchorRect = typeof captureRewardAnchor === 'function' ? captureRewardAnchor(anchorEl) : null;
  const slot = (recipeServingCtx && recipeServingCtx.slot) || RECIPE_SLOT_DB[currentRecipeKey];
  if(!slot){ toast('Could not log this recipe'); return; }
  const planned = displayedTodayRecipeId(slot) === currentRecipeKey;
  if(!planned){
    // Clear a stale "skipped" flag first — logConfirm() below no-ops on a skipped card,
    // and skipping earlier shouldn't block logging the real meal now.
    if(slotLogStatus(todayISO(), currentProf, slot) === 'skipped') removeLoggedSlot(todayISO(), currentProf, slot);
    swapCtx = {dayIndex: todayDayIndex(), slot: slot, person: currentProf, weekStartDate: null, targetElId: null};
    chooseSwapRecipe(currentRecipeKey); // swaps today's slot to this dish; toasts + re-renders Today/Log/Week
    const card = document.getElementById('log-' + slot);
    if(card && !card.classList.contains('done')) logConfirm(slot, todayISO(), anchorEl, anchorRect); // wasn't already confirmed (nothing to correct) — log it fresh
    renderRecipeEatenState();
    renderRecipeMealStrip();
    return;
  }
  const card = document.getElementById('log-' + slot);
  if(card && !card.classList.contains('done') && !card.classList.contains('skipped')){
    logConfirm(slot, todayISO(), anchorEl, anchorRect);
  } else {
    toast('Already logged for today');
  }
  renderRecipeEatenState(); // paint the CTA's new state immediately (button no longer just sits there saying "Mark as eaten")
  renderRecipeMealStrip();
}

// Owner feedback: the recipe screen's CTA never reflected that a meal had actually been
// logged — it kept reading "Mark as eaten" after the tap, and showed the same un-eaten
// button when re-opening a recipe that was already confirmed today. This re-derives the
// CTA's state fresh from slotLogStatus() every call (same source of truth as
// renderTodayCardActions() — logHistory), so it can never drift from the Today screen.
// Resolves the slot exactly like markEatenFromRecipe() does; the
// eaten/skipped tag-row ONLY ever appears for TODAY's plan for the CURRENT person — a
// recipe opened from a Week row for a different day (recipeDayCtx) or one that isn't
// today's planned slot for this person keeps the plain button (tapping it now swaps it
// into today's slot and logs it — see markEatenFromRecipe() — rather than dead-ending).
function renderRecipeEatenState(){
  const wrap = document.getElementById('recipeEatenWrap');
  if(!wrap) return;
  const slot = (recipeServingCtx && recipeServingCtx.slot) || RECIPE_SLOT_DB[currentRecipeKey];
  const planned = slot && displayedTodayRecipeId(slot) === currentRecipeKey;
  const status = planned ? slotLogStatus(todayISO(), currentProf, slot) : null;
  if(status === 'confirmed'){
    wrap.innerHTML = '<div class="tag-row"><span class="confirmed-tag">✓ Eaten today</span>'
      + '<button class="tag-undo" onclick="undoRecipeEatenSlot(\''+slot+'\')">↺ Undo</button></div>';
  } else if(status === 'skipped'){
    wrap.innerHTML = '<div class="tag-row"><span class="skipped-tag">Skipped for today</span>'
      + '<button class="tag-undo" onclick="undoRecipeEatenSlot(\''+slot+'\')">↺ Undo</button></div>';
  } else {
    // not on today's plan, OR on today's plan but not yet logged — same plain CTA either
    // way; markEatenFromRecipe() itself still tells the two cases apart (toast vs. confirm).
    wrap.innerHTML = '<button class="cta" id="recipeEatenBtn" onclick="markEatenFromRecipe(this)">✓ Mark as eaten</button>';
  }
}

// USER FEEDBACK item 2: reconciles the recipe screen's own per-serving numbers with the
// meal card's total once that meal has extras (e.g. shakshuka 617 kcal vs. the card's 1058
// with sides) — resolved exactly like renderRecipeEatenState() (same slot/planned check),
// scoped further to only paint when todaySlotView(slot) actually has extras. All numbers
// come from recipeNutrition()/todaySlotView(), nothing hand-set.
function renderRecipeMealStrip(){
  const wrap = document.getElementById('recipeMealStrip');
  if(!wrap) return;
  const slot = (recipeServingCtx && recipeServingCtx.slot) || RECIPE_SLOT_DB[currentRecipeKey];
  const planned = slot && displayedTodayRecipeId(slot) === currentRecipeKey;
  const view = planned ? todaySlotView(slot) : null;
  if(!view){
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }
  let rows = '<div class="row between"><b style="font-size:14px">This meal</b>'
    + '<button class="tag-undo" onclick="manageRecipeMealFromDetail()">Manage</button></div>';
  if(view.extras && view.extras.length){
    const baseNut = roundedNutritionTotals(recipeNutrition(view.recipeId, view.portion, view.opts).totals);
    rows += '<div class="logitem"><div class="li-t">' + escapeHtml(recipeDisplayTitle(view.recipeId, view.opts)) + ' (base)<small>' + baseNut.kcal + ' kcal</small></div></div>';
    view.extras.forEach(function(c){
      if(!RECIPES_DB[c.recipeId]) return;
      const nut = roundedNutritionTotals(recipeNutrition(c.recipeId, (typeof c.portion === 'number' && c.portion > 0) ? c.portion : 1, c.opts).totals);
      rows += '<div class="logitem"><div class="li-t">' + escapeHtml(recipeDisplayTitle(c.recipeId, c.opts)) + '<small>' + nut.kcal + ' kcal</small></div></div>';
    });
    rows += '<div class="logitem" style="border-bottom:0"><div class="li-t"><b>Meal total</b><small><b>' + view.kcal + ' kcal</b></small></div></div>';
  }
  wrap.innerHTML = rows;
  wrap.style.display = 'block';
}

// Distinct from undoLogSlot() (which reverses whatever day the Log screen's Today/
// Yesterday toggle currently points at, via currentLogDateISO()): the recipe screen's
// eaten/skipped state only ever reflects TODAY's plan (renderRecipeEatenState() above), so
// this always targets todayISO() regardless of the Log screen's toggle — otherwise tapping
// Undo here while the Log screen was left on "Yesterday" would silently undo yesterday's
// slot instead of the one this button is actually showing.
function undoRecipeEatenSlot(slot){
  const status = slotLogStatus(todayISO(), currentProf, slot);
  if(!status) return;
  removeLoggedSlot(todayISO(), currentProf, slot);
  refreshAfterLogChange();
  renderRecipeEatenState();
  renderRecipeMealStrip();
  toast(status === 'confirmed'
    ? '↺ Un-logged ' + SLOT_LABEL[slot] + ' — confirm it again anytime'
    : '↺ ' + SLOT_LABEL[slot] + ' un-skipped');
}
