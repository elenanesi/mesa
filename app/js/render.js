/* ===================================================================
   render.js — all DOM-writing functions
   Everything that reads state (state.js) / computed values (engine.js,
   planner.js) and paints it into the DOM: screen renderers, sheet
   builders, the toast helper, and the profile/basics/macro-split
   editor (kept together with applyProf since they're one tightly
   coupled render cycle — see the A1 report for the split rationale).
   =================================================================== */

// toast helper
let tT;
function toast(msg){
  const t=document.getElementById('toast');
  t.textContent=msg; t.classList.add('show');
  clearTimeout(tT); tT=setTimeout(()=>t.classList.remove('show'),1900);
}

// Implements the optional onMesaPersistFailed(err) hook state.js calls (see persist() in
// state.js) on the healthy->unhealthy transition of a localStorage write — i.e. once when
// storage first fails, not again on every subsequent failed write while it stays broken.
// The user can't see console.error on a phone, so this is the only signal they get that
// their data stopped saving.
function onMesaPersistFailed(err){
  toast('Could not save — device storage is full, recent changes may be lost');
}

/* ---------------- FIX 2 (feedback): typeable numeric fields ----------------
   Every field that used to be stepper-only (+/- only) now also accepts direct
   typing, with BOTH comma and dot as the decimal separator ("7,4" -> 7.4, the
   Italian keyboard's native decimal key). One parser shared by every commit
   function below (ingredient macros in library.js, recipe-builder/quick-add
   grams, profile height/weight/calories) so "what counts as a valid number"
   never drifts between fields. Returns null for anything that isn't a finite
   number (blank, "abc", "-", "7,4,2"…) — callers treat null (and, per field,
   negative numbers) as invalid and revert with a toast rather than guessing. */
function parseDecimalInput(str){
  if(typeof str !== 'string') return null;
  const cleaned = str.trim().replace(/\s+/g, '').replace(',', '.');
  if(cleaned === '' || cleaned === '-' || cleaned === '.' || cleaned === '-.') return null;
  const n = Number(cleaned);
  return isFinite(n) ? n : null;
}

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
  return src.tags.map(function(t){ return TAG_PILL_MAP[t] || ['', t]; });
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
  'carrots-over-hummus', 'spring-rolls', 'pizza'
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
    'shakshuka': 'Shakshuka'
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
  renderRecipeOptionsChips();
  updateRecipeWhy();
  document.getElementById('recipeMethod').innerHTML = r.steps.map(function(s){ return '<li>'+escapeHtml(s)+'</li>'; }).join('');
  updateServings();
  renderRecipeEatenState(); // fresh eaten/skipped read every time the recipe screen paints (open, re-render on plan change, swap)
  renderRecipeMealStrip();
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
  renderLogPlan();
  renderWeek();
}

function updateServings(){
  const shared = recipeServingCtx ? recipeServingCtx.shared : isShared(currentRecipeKey);
  document.getElementById('serveRowShared').style.display = shared ? 'flex' : 'none';
  document.getElementById('sharedCaption').style.display = shared ? 'block' : 'none';
  document.getElementById('serveRowSolo').style.display = shared ? 'none' : 'flex';
  let total;
  if(shared){
    document.getElementById('svElenaVal').textContent = svE + '×';
    document.getElementById('svAndreaVal').textContent = svM + '×';
    total = +(svE + svM).toFixed(1);
    document.getElementById('rsServesMeta').textContent = '👥 ' + total + ' servings';
    document.getElementById('ingHeader').innerHTML = 'Ingredients · scaled for ' + total + ' servings';
    const slot = (recipeServingCtx && recipeServingCtx.slot) || RECIPE_SLOT_DB[currentRecipeKey] || 'meal';
    document.getElementById('sharedCaption').textContent = 'Shared ' + slot + ' — cooked once, plated per target';
  } else {
    document.getElementById('svSoloVal').textContent = svS + '×';
    total = svS;
    const label = total === 1 ? 'serving' : 'servings';
    document.getElementById('rsServesMeta').textContent = '🍽️ ' + total + ' ' + label;
    document.getElementById('ingHeader').innerHTML = 'Ingredients · scaled for ' + total + ' ' + label;
  }
  const ingredients = recipeDisplayIngredients(currentRecipeKey, recipeOptsCtx);
  document.getElementById('ingList').innerHTML = ingredients.map(function(ing){
    const name = escapeHtml(ing[0]), qty = ing[1], unit = escapeHtml(String(ing[2]));
    if(qty === null) return '<li><span>'+name+'</span><span>'+unit+'</span></li>';
    const scaled = +(qty * total).toFixed(1);
    return '<li><span>'+name+'</span><span>'+scaled+' '+unit+'</span></li>';
  }).join('');
  updateNutritionGrid(total);
  syncServeHighlight();
}

// Nutrition grid + "kcal from" split, computed fresh from recipeNutrition() at the
// current total serving scale (same scale the ingredient list above uses) — so the
// steppers rescale nutrition exactly as they rescale ingredients (task C1). Replaces
// the old hand-typed r.nutrition/r.kcalSplit fields entirely; nothing here is typed in.
function updateNutritionGrid(total){
  const header = document.getElementById('nutriHeader');
  if(header) header.textContent = (total === 1) ? 'Nutrition (per serving)' : 'Nutrition · scaled for ' + total + ' servings';
  const nut = recipeNutrition(currentRecipeKey, total, recipeOptsCtx).totals;
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
    ['Good fats (unsat.)', Math.round(nut.goodFat) + ' g'],
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
function markEatenFromRecipe(){
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
    if(card && !card.classList.contains('done')) logConfirm(slot); // wasn't already confirmed (nothing to correct) — log it fresh
    renderRecipeEatenState();
    renderRecipeMealStrip();
    return;
  }
  const card = document.getElementById('log-' + slot);
  if(card && !card.classList.contains('done') && !card.classList.contains('skipped')){
    logConfirm(slot);
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
// renderTodayCardActions()/renderLogPlan() — logHistory), so it can never drift from the
// Today/Log screens. Resolves the slot exactly like markEatenFromRecipe() does; the
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
    wrap.innerHTML = '<button class="cta" id="recipeEatenBtn" onclick="markEatenFromRecipe()">✓ Mark as eaten</button>';
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
  if(!view || !view.extras || !view.extras.length){
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }
  const baseNut = roundedNutritionTotals(recipeNutrition(view.recipeId, view.portion, view.opts).totals);
  let rows = '<div class="row between"><b style="font-size:14px">In this meal</b>'
    + '<button class="tag-undo" onclick="openAddMealRecipeSheet(\'' + slot + '\')">Manage</button></div>'
    + '<div class="logitem"><div class="li-t">' + escapeHtml(recipeDisplayTitle(view.recipeId, view.opts)) + ' (base)<small>' + baseNut.kcal + ' kcal</small></div></div>';
  view.extras.forEach(function(c){
    if(!RECIPES_DB[c.recipeId]) return;
    const nut = roundedNutritionTotals(recipeNutrition(c.recipeId, (typeof c.portion === 'number' && c.portion > 0) ? c.portion : 1, c.opts).totals);
    rows += '<div class="logitem"><div class="li-t">' + escapeHtml(recipeDisplayTitle(c.recipeId, c.opts)) + '<small>' + nut.kcal + ' kcal</small></div></div>';
  });
  rows += '<div class="logitem" style="border-bottom:0"><div class="li-t"><b>Meal total</b><small><b>' + view.kcal + ' kcal</b></small></div></div>';
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
    ? '↺ Un-logged ' + (TITLES[slot] || SLOT_LABEL[slot]) + ' — confirm it again anytime'
    : '↺ ' + SLOT_LABEL[slot] + ' un-skipped');
}

/* ---------------- week screen rendering ---------------- */
// weekPlan.weekStartDate is always a Monday (planner.js:mondayOfWeek), so the day index
// maps straight onto Mon..Sun.
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Two-week horizon (owner feedback: "I need to see both this and next week's menu to shop
// on the weekend"): which week the Week screen's "This week | Next week" segmented control
// (index.html #weekSeg, reusing the existing .seg style) currently shows. Default is
// CURRENT week on every fresh render of the screen (app.js:go() doesn't reset it on
// re-visit, matching how every other screen's local view state — e.g. quickAdd — persists
// across tab switches within a session).
let weekScreenShowsNext = false;

function setWeekScreenMode(mode, el){
  weekScreenShowsNext = (mode === 'next');
  if(el){
    el.parentNode.querySelectorAll('button').forEach(function(b){ b.classList.remove('on'); });
    el.classList.add('on');
  }
  renderWeek();
}

// "Mon 20" — weekday abbreviation + day-of-month, used for next week's day rows (task:
// "show weekday names with dates") since "Today"-relative labels like the current week's
// don't make sense a week out. parseISODate (planner.js) is in the same shared global
// scope (classic <script> tags, no modules).
function dayDateLabel(dateISO){
  const d = parseISODate(dateISO);
  return DAY_NAMES[(d.getDay() + 6) % 7] + ' ' + d.getDate();
}

// Paints the 7-day list for the CURRENT person, for whichever week the segmented control
// currently selects (task C2 origin; two-week horizon adds the week parameter): every
// kcal shown is that person's portion-scaled computed value, day totals are real sums
// over the four slots. "Today" only ever highlights on the CURRENT week's row — next
// week has no "today". Each meal row gets an inline 🔁 swap icon (weekStartDate-aware —
// see openWeekSwap below) so a swap works on whichever week is displayed, not just today.
// B4: per-day, per-slot displayed views + macro totals for `person` across a plan's 7
// days, built from displayedSlotViewForDate() — the SAME per-slot view renderWeek()'s rows
// paint from. Computed ONCE here so nutrition is never derived twice for a single render:
// renderWeek() consumes dayViews[i].views[slot] for the row markup and dayViews[i].totals
// for the day's macro line, and passes the whole array into renderWeekNutriCard for the
// week-level averages. Pure/DOM-free (safe to call from tools/check.js). A slot with no
// matching recipe (view.recipe falsy — same guard the row loop already used) contributes
// nothing to that day's totals.
// B4×B5 fix: a slot the person SKIPPED (slotLogStatus === 'skipped', current-week past
// rows only — B5's catch-up log) still returns its planned/frozen macros from
// displayedSlotViewForDate (view.kcal keeps showing that informational number on the row,
// same convention as the Today card), but must NOT count toward the day/week "logged
// overlay" totals — a skipped meal wasn't eaten, matching how recomputeConsumed/Insights
// already zero it via the raw logHistory entries. Without this guard the day macro line
// and week nutrient card silently disagreed with the row's own ∅ state.
// C3 fix: quick-add kind:'food' log entries (Log screen's quick-add foods/beverages —
// cappuccinos, gelato, anything logged outside a meal slot) are NEVER slot views —
// displayedSlotViewForDate only ever resolves a slot's kind:'plan' entry or the planned
// recipe — so computeInsights/recomputeConsumed (which iterate the whole day log,
// kind-agnostic) already counted them while this function didn't. Folded in here, once,
// so both renderWeek's day-header kcal and its macro line (which both read THIS totals
// object — see renderWeek below) can never disagree. Only for days that already have a
// real log, i.e. day.date <= todayISO(): a next-week plan's days (and any future date
// within the current week) always sort after today, so this single date check is enough
// to skip them — no separate "is this the current week's plan" flag needed, and no
// logHistory entries exist for future dates regardless.
function weekDayNutriViews(plan, person){
  return plan.days.map(function(day){
    const views = {};
    const totals = {kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugars: 0, freeSugars: 0};
    SLOT_ORDER.forEach(function(slot){
      const m = day.meals[slot];
      const entry = m[person];
      const view = displayedSlotViewForDate(day.date, person, slot, planEntryView(entry, m.shared));
      views[slot] = view;
      if(!view.recipe) return;
      if(slotLogStatus(day.date, person, slot) === 'skipped') return;
      totals.kcal += view.kcal; totals.protein += view.protein; totals.carbs += view.carbs;
      totals.fat += view.fat; totals.fiber += view.fiber; totals.sugars += view.sugars; totals.freeSugars += view.freeSugars;
    });
    let quickAddCount = 0;
    if(day.date <= todayISO()){
      const dayLog = getDayLog(day.date);
      const entries = (dayLog && dayLog[person]) || [];
      entries.forEach(function(e){
        if(!e || e.kind !== 'food') return;
        quickAddCount++;
        const nut = logEntryNutrition(e);
        totals.kcal += nut.kcal; totals.protein += nut.protein; totals.carbs += nut.carbs;
        totals.fat += nut.fat; totals.fiber += nut.fiber; totals.sugars += nut.sugars; totals.freeSugars += nut.freeSugars;
      });
    }
    return {views: views, totals: totals, quickAddCount: quickAddCount};
  });
}

// B4: pure week-level summary consumed by renderWeekNutriCard — per-day averages (kcal/P/
// C/F), fiber and free-sugars averages against their existing single-sourced targets, and
// the coverageGaps() object for the two headline household chips (omega-3, sat fat),
// evaluated against the DISPLAYED week's plan (current or next). dayViews defaults to a
// fresh weekDayNutriViews() call but renderWeek passes in the one it already built so nutri
// totals are computed once per paint. Pure/DOM-free (safe to call from tools/check.js).
function weekNutriSummary(plan, person, dayViews){
  dayViews = dayViews || weekDayNutriViews(plan, person);
  const days = dayViews.length || 7;
  const sum = function(key){ return dayViews.reduce(function(s, d){ return s + d.totals[key]; }, 0); };
  const avgKcal = sum('kcal') / days;
  const avgProtein = sum('protein') / days;
  const avgCarbs = sum('carbs') / days;
  const avgFat = sum('fat') / days;
  const avgFiber = sum('fiber') / days;
  const avgFreeSugars = sum('freeSugars') / days;

  const fiberTarget = WEEK_SUMMARY_THRESHOLDS.fiberMinPerDay; // single-sourced, never re-typed 25
  const cov = computeWeeklyCoverage(plan);
  const gaps = coverageGaps(cov);
  const sugarTargetPct = gaps.freeSugars.target; // single-sourced, never re-typed 6
  const calGoal = (PROF[person] && PROF[person].calGoalNum) || 0;
  // Same grams conversion coverageTargetText already applies for this person's calorie goal
  // — kept in sync by construction since both read gaps.freeSugars.target, never a literal.
  const sugarTargetG = calGoal > 0 ? Math.round((sugarTargetPct / 100) * calGoal / 4) : 0;

  return {
    avgKcal: avgKcal, avgProtein: avgProtein, avgCarbs: avgCarbs, avgFat: avgFat,
    avgFiber: avgFiber, avgFreeSugars: avgFreeSugars,
    fiberTarget: fiberTarget, sugarTargetG: sugarTargetG, gaps: gaps
  };
}

function renderWeek(){
  const mondayISO = weekScreenShowsNext ? nextMondayISO() : mondayOfWeek(todayISO());
  const plan = ensureWeekPlan(mondayISO);
  const todayIdx = weekScreenShowsNext ? -1 : todayDayIndex();
  const person = currentProf;
  const el = document.getElementById('weekList');
  // B4: every row's view, computed exactly once, reused for the day macro lines AND the
  // week card below (see weekDayNutriViews's header comment).
  const dayViews = weekDayNutriViews(plan, person);
  // B5 (catch-up logging): on the CURRENT week only, rows for dates up to and including
  // today swap the pin/routine buttons for a single log-state button (data-act="log") so
  // rows never exceed their existing button budget (decision Q3). Next week and future
  // dates of this week are untouched — pins/routines on the past are meaningless anyway
  // (re-balance already ignores them), so nothing of value is hidden.
  el.innerHTML = plan.days.map(function(day, di){
    const totals = dayViews[di].totals;
    const titles = [];
    const logEligible = !weekScreenShowsNext && day.date <= todayISO();
    const rows = SLOT_ORDER.map(function(slot){
      const m = day.meals[slot];
      const view = dayViews[di].views[slot];
      const r = view.recipe;
      if(!r) return '';
      titles.push(escapeHtml(mealTitleWithExtras(view)));
      const together = view.shared ? ' <span class="pill together mini">👥 Together</span>' : '';
      // Recipe ids can be user-authored ('cr-<slug>'), so every per-row argument rides in
      // data-* attributes (htmlAttr-escaped once, never re-parsed as JS) and clicks are
      // resolved by the delegated #weekList handler below instead of inline onclick JS.
      // The buttons' old event.stopPropagation() is replaced by handler ordering: the
      // delegated handler checks buttons before the row, and the row before the day.
      const swapBtn = '<button class="dm-swap" data-act="swap" aria-label="Swap this meal">🔁</button>';
      // B3: sides/extras button on EVERY row (This week and Next week alike) — opens
      // openAddMealSheetForContext via the delegated handler below, same sheet the Today
      // card ✎/＋ and recipe-screen "Manage" strip already use. Icon/label follow the same
      // hasExtras convention as those entry points (renderTodayCardActions/buildLogSlotCard).
      const hasExtras = !!(view.extras && view.extras.length);
      const extrasAria = (hasExtras ? 'Edit ' : 'Add to ') + (SLOT_LABEL[slot] || slot);
      const extrasBtn = '<button class="dm-extras" data-act="extras" aria-label="'+extrasAria+'">'+(hasExtras ? '✎' : '＋')+'</button>';
      let actionBtns;
      if(logEligible){
        const status = slotLogStatus(day.date, person, slot);
        const icon = status === 'confirmed' ? '✓' : (status === 'skipped' ? '∅' : '◯');
        const label = SLOT_LABEL[slot] || slot;
        const aria = (status === 'confirmed' ? 'Logged ' : (status === 'skipped' ? 'Skipped ' : 'Log ')) + label.toLowerCase();
        const logBtn = '<button class="dm-log'+(status ? ' on' : '')+'" data-act="log" aria-label="'+aria+'">'+icon+'</button>';
        actionBtns = logBtn + extrasBtn + swapBtn;
      } else {
        const pinPerson = mealPinPersonForMeal(m, person);
        const pinned = isMealPinned(plan.weekStartDate, di, slot, pinPerson);
        const pinBtn = '<button class="dm-pin'+(pinned ? ' on' : '')+'" data-act="pin" data-pin-person="'+htmlAttr(pinPerson)+'" aria-label="'+(pinned ? 'Unpin this meal' : 'Pin this meal')+'">'+(pinned ? '📌' : '📍')+'</button>';
        const routineBtn = '<button class="dm-rule" data-act="routine" aria-label="Set meal routine">↻</button>';
        actionBtns = pinBtn + routineBtn + extrasBtn + swapBtn;
      }
      return '<div class="day-meal-row" data-di="'+di+'" data-slot="'+htmlAttr(slot)+'" data-recipe-id="'+htmlAttr(view.recipeId)+'">'
        + '<div class="dm-e">'+r.emoji+'</div>'
        + '<div class="dm-t">'+escapeHtml(mealTitleWithExtras(view))+'<small>'+SLOT_LABEL[slot]+together+'</small></div>'
        + '<div class="dm-k">'+Math.round(view.kcal)+'</div>'
        + actionBtns + '</div>';
    }).join('');
    // B4 day-level macro line: current-profile totals for the day (dayViews[di].totals —
    // already computed above, not re-derived), matching Insights' sugar-tracking convention
    // (FREE sugars is the headline metric there — planner.js coverageGaps' 'freeSugars'
    // entry, label "Free sugars" — so it's labeled the same way here rather than showing
    // total sugars, which would be a second, disagreeing figure).
    // C3: honestly surface the quick-add entries folded into `totals` above (count only,
    // no list — keeps the row compact per the plan) so the macro line doesn't silently
    // read higher than the meal titles above it would suggest.
    const extrasNote = dayViews[di].quickAddCount > 0
      ? ' · <b>+ ' + dayViews[di].quickAddCount + ' logged extras</b>' : '';
    const dayMacroLine = '<div class="sub day-macros" style="margin:0">P '+Math.round(totals.protein)+'g · C '+Math.round(totals.carbs)
      +'g · F '+Math.round(totals.fat)+'g · fiber '+Math.round(totals.fiber)+'g · free sugars '+Math.round(totals.freeSugars)+'g'+extrasNote+'</div>';
    const label = weekScreenShowsNext ? dayDateLabel(day.date) : (DAY_NAMES[di] + (di === todayIdx ? ' · Today' : ''));
    return '<div class="day'+(di === todayIdx ? ' today' : '')+'" id="wd'+di+'" data-di="'+di+'">'
      + '<div class="dh"><span class="dn">'+label+'</span><span class="dk">~'+fmtKcal(Math.round(totals.kcal))+' kcal <span class="chev">⌄</span></span></div>'
      + '<div class="dmeals">'+titles.join(' · ')+'</div>'
      + '<div class="day-meals">'+dayMacroLine+rows+'</div></div>';
  }).join('');
  // Delegated click handler for the whole week list (see the data-* note above): most
  // specific target first — action button, then meal row (open recipe), then day header
  // (expand/collapse) — which reproduces the old inline stopPropagation() behavior.
  // Reassigned (not addEventListener) on every renderWeek so the closure always captures
  // the currently displayed week's weekStartDate and person.
  el.onclick = function(e){
    const btn = e.target.closest('button[data-act]');
    if(btn && el.contains(btn)){
      const mrow = btn.closest('.day-meal-row');
      if(!mrow) return;
      const di2 = +mrow.getAttribute('data-di');
      const slot2 = mrow.getAttribute('data-slot');
      const act = btn.getAttribute('data-act');
      if(act === 'pin') toggleMealPin(plan.weekStartDate, di2, slot2, btn.getAttribute('data-pin-person'));
      else if(act === 'routine') openMealRoutineSheet(plan.weekStartDate, di2, slot2, person, mrow.getAttribute('data-recipe-id'));
      else if(act === 'swap') openWeekSwap(plan.weekStartDate, di2, slot2, person);
      else if(act === 'log') openWeekLogSheet(plan.weekStartDate, di2, slot2, person);
      else if(act === 'extras') openWeekAddMealSheet(plan.weekStartDate, di2, slot2, person);
      return;
    }
    const mealRow = e.target.closest('.day-meal-row');
    if(mealRow && el.contains(mealRow)){
      openRecipe(mealRow.getAttribute('data-recipe-id'), 'week', {weekStartDate: plan.weekStartDate, dayIndex: +mealRow.getAttribute('data-di'), slot: mealRow.getAttribute('data-slot'), person: person});
      // No return: the old inline markup let a meal-row click bubble to the day's
      // toggleDay too (only the action buttons stopped propagation) — keep that.
    }
    const day = e.target.closest('.day[data-di]');
    if(day && el.contains(day)) toggleDay(+day.getAttribute('data-di'));
  };
  renderWeekSummaryLine(plan, person);
  renderWeekNutriCard(plan, person, dayViews);

  // Nutrient coverage chips always reflect the CURRENT week regardless of which week is
  // toggled on-screen (renderNutrientChips reads the `weekPlan` compat getter, which only
  // ever mirrors the current week — planner.js:ensureWeekPlan) — no change needed there.
  renderNutrientChips();
  updateWeekActionsForMode();
}

// B4: paints weekNutriSummary(plan, person, dayViews) into #weekNutriCard — the compact
// card ABOVE the day list, on BOTH This-week and Next-week modes: per-day averages
// (kcal/P/C/F) for the CURRENT profile, fiber and free-sugars averages against the SAME
// targets Insights already uses, and the two headline household coverage chips (omega-3
// meals/wk, sat-fat share) for the DISPLAYED week's plan. dayViews are exactly what
// renderWeek() already built from displayedSlotViewForDate() — current week's totals are
// therefore logged-overlay-aware (what the rows show), and next week's are plan-only (no
// logged overlay exists for future dates), with no special-casing needed here.
function renderWeekNutriCard(plan, person, dayViews){
  const wrap = document.getElementById('weekNutriCard');
  if(!wrap) return;
  const s = weekNutriSummary(plan, person, dayViews);

  const macroLine = 'Avg/day — ' + fmtKcal(Math.round(s.avgKcal)) + ' kcal · P ' + Math.round(s.avgProtein) + 'g · C ' + Math.round(s.avgCarbs)
    + 'g · F ' + Math.round(s.avgFat) + 'g';

  // Fiber: single-sourced against WEEK_SUMMARY_THRESHOLDS.fiberMinPerDay (never re-typed
  // 25 here) — reuses coverageChipHtml's exact chip markup via a coverageGaps-shaped
  // object built from OUR OWN per-day average (not the household worst-of-two Insights
  // tracks), since fiber here is a per-profile, logged-overlay-aware figure.
  const fiberGap = {
    key: 'fiber', label: 'Fiber', value: Math.round(s.avgFiber), target: s.fiberTarget, unit: 'g/day',
    gap: Math.max(0, (s.fiberTarget - s.avgFiber) / s.fiberTarget),
    pct: Math.min(100, Math.round(s.avgFiber / s.fiberTarget * 100))
  };

  // Free sugars: same headline metric/label Insights already uses (planner.js coverageGaps
  // 'freeSugars' — never total sugars), against the SAME 6%-of-kcal target (gaps.freeSugars
  // .target, never re-typed as a literal 6, via weekNutriSummary's sugarTargetG) — the
  // cap-note reuses coverageTargetText(gaps.freeSugars) verbatim so the target text never
  // disagrees with Insights' own.
  const sugarOver = s.sugarTargetG > 0 && s.avgFreeSugars > s.sugarTargetG;
  const sugarPct = s.sugarTargetG > 0 ? Math.min(100, Math.round(s.avgFreeSugars / s.sugarTargetG * 100)) : 0;
  const sugarChip = '<div class="n'+(sugarOver ? ' low' : '')+'"><div class="nt"><span>Free sugars</span><b>'+Math.round(s.avgFreeSugars)+' g/day</b></div>'
    + '<div class="nbar"><i style="width:'+sugarPct+'%"></i></div>'
    + '<div class="cap-note">Target ' + coverageTargetText(s.gaps.freeSugars) + ' — staying below is good</div></div>';

  // Two headline household coverage chips, evaluated against the DISPLAYED week's plan
  // (This or Next) via the exact same computeWeeklyCoverage/coverageGaps/coverageChipHtml
  // Insights uses — never re-derived.
  const covChips = ['omega3', 'satFat'].map(function(k){ return coverageChipHtml(s.gaps[k]); }).join('');

  wrap.innerHTML = '<div class="sub" style="margin:0 0 10px">' + macroLine + '</div>'
    + '<div class="nutri">' + coverageChipHtml(fiberGap) + sugarChip + covChips + '</div>';
}

// T6: paints planner.js:summarizeWeekPlan(plan, person) into #weekSummaryLine as a single
// (wrappable) line — up to 3 friendly tag chips from the plan's most-common recipe tags,
// plus one hard metric that clears a T7/Insights threshold (or, failing that, the fiber
// figure framed against its goal). Called every renderWeek(), so it already tracks the
// This/Next toggle (`plan`/`person` passed in) and profile switch for free.
function renderWeekSummaryLine(plan, person){
  const el = document.getElementById('weekSummaryLine');
  if(!el) return;
  const s = summarizeWeekPlan(plan, person);
  const tagsHtml = s.tags.length
    ? s.tags.map(function(t){ return '<b>' + escapeHtml(t) + '</b>'; }).join(' <span class="ws-sep">·</span> ')
    : '<b>Balanced week</b>';
  el.innerHTML = tagsHtml + ' <span class="ws-sep">·</span> ' + escapeHtml(s.metricText);
}

function updateWeekActionsForMode(){
  const btn = document.getElementById('rebalanceBtn');
  const note = document.getElementById('rebalanceCapNote');
  if(btn) btn.textContent = weekScreenShowsNext ? '✨ Re-balance next week' : '✨ Re-balance this week';
  if(note) note.style.display = 'none';
}

// Opens the swap sheet for one meal on a SPECIFIC week (current or next) — the Week
// screen's inline 🔁 per meal row. Unlike openSwap() (Today/Log/recipe-screen entry
// points, which always target today's plan via resolveSwapContext), this carries an
// explicit weekStartDate through swapCtx so chooseSwap (planner.js) applies the swap to
// the right week's plan, and — for next week — skips the "correct today's log entry" step
// entirely (there's nothing logged for a future date).
// 'tall' (not 'remove'): the sheet now has a "Best matches" + "All <slot> options" section
// (FEATURE: swap anything) which can be long — same tall/scrollable treatment as the
// shopping list and library sheets.
function openSwapSheetForContext(ctx, targetElId){
  swapCtx = {dayIndex: ctx.dayIndex, slot: ctx.slot, person: ctx.person, weekStartDate: ctx.weekStartDate, targetElId: targetElId || null};
  document.getElementById('sheetBody').innerHTML = buildSwapSheet(ctx);
  document.getElementById('sheet').classList.add('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
  if(typeof attachSwapSearchHandler === 'function') attachSwapSearchHandler();
}

function openWeekSwap(weekStartDate, dayIndex, slot, person){
  openSwapSheetForContext({dayIndex: dayIndex, slot: slot, person: person, weekStartDate: weekStartDate}, null);
}

function toggleMealPin(weekStartDate, dayIndex, slot, person){
  const key = mealPinKey(weekStartDate, dayIndex, slot, person);
  if(mealPins[key]){
    const rule = routineRuleForPinnedOccurrence(weekStartDate, dayIndex, slot, person);
    if(rule){ openRoutineUnpinSheet(weekStartDate, dayIndex, slot, person, rule); return; }
    delete mealPins[key]; toast('Meal unpinned');
  }
  else { mealPins[key] = true; toast('Pinned — re-balance will leave it alone'); }
  renderWeek();
  persist();
}

let routineUnpinCtx = null;

function routineRuleForPinnedOccurrence(weekStartDate, dayIndex, slot, person){
  const plan = ensureWeekPlan(weekStartDate);
  const day = plan.days && plan.days[dayIndex];
  const meal = day && day.meals && day.meals[slot];
  if(!day || !meal) return null;
  const rulePerson = mealPinPersonForMeal(meal, person);
  const recipeId = meal.shared ? meal.recipeId : (meal[rulePerson] && meal[rulePerson].recipeId);
  for(let i = mealRules.length - 1; i >= 0; i--){
    const rule = mealRules[i];
    if(!rule || !rule.pinFromDate || day.date < rule.pinFromDate) continue;
    if(rule.recipeId !== recipeId) continue;
    if(mealRuleApplies(rule, day.date, dayIndex, slot, rulePerson)) return rule;
  }
  return null;
}

function openRoutineUnpinSheet(weekStartDate, dayIndex, slot, person, rule){
  const plan = ensureWeekPlan(weekStartDate);
  const day = plan.days[dayIndex];
  routineUnpinCtx = {weekStartDate: weekStartDate, dayIndex: dayIndex, slot: slot, person: person, rule: rule, dateISO: day.date};
  const meal = day.meals[slot];
  const entry = meal.shared ? meal.elena : meal[person];
  const view = planEntryView(entry, meal.shared);
  document.getElementById('sheetBody').innerHTML =
    '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Unpin routine meal?</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
    + '<p class="sub"><b>' + escapeHtml(mealTitleWithExtras(view)) + '</b> is part of a pinned routine. Choose whether to unlock only this meal or the following meals in this routine too.</p>'
    + '<button class="cta" onclick="unpinOnlyThisMeal()">Unpin only this meal</button>'
    + '<button class="cta ghostbtn" onclick="unpinThisAndFollowingRoutineMeals()">Unpin this and following routine meals</button>';
  document.getElementById('sheet').classList.remove('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

function unpinOnlyThisMeal(){
  if(!routineUnpinCtx) return;
  const ctx = routineUnpinCtx;
  delete mealPins[mealPinKey(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person)];
  routineUnpinCtx = null;
  closeSheet();
  renderWeek();
  persist();
  toast('Meal unpinned');
}

function unpinThisAndFollowingRoutineMeals(){
  if(!routineUnpinCtx) return;
  const ctx = routineUnpinCtx;
  if(typeof unpinRoutineOccurrencesFrom === 'function') unpinRoutineOccurrencesFrom(ctx.rule, ctx.dateISO);
  else delete mealPins[mealPinKey(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person)];
  routineUnpinCtx = null;
  closeSheet();
  renderWeek();
  persist();
  toast('Routine meals unpinned');
}

function routineLabel(rule){
  if(!rule) return 'No routine';
  if(rule.cadence === 'daily') return 'Every day';
  if(rule.cadence === 'alternate') return 'Every other day';
  if(rule.cadence === 'weekly') return 'Every ' + DAY_NAMES[rule.dayIndex];
  return 'Routine';
}

function findMealRule(slot, person){
  for(let i = mealRules.length - 1; i >= 0; i--){
    const r = mealRules[i];
    if(r.slot === slot && r.person === person) return r;
  }
  return null;
}

let routineCtx = null;

function openMealRoutineSheet(weekStartDate, dayIndex, slot, person, recipeId){
  const plan = ensureWeekPlan(weekStartDate);
  const meal = plan.days[dayIndex].meals[slot];
  const rulePerson = meal.shared ? 'shared' : person;
  routineCtx = {weekStartDate: weekStartDate, dayIndex: dayIndex, slot: slot, person: rulePerson, recipeId: recipeId};
  const r = RECIPES_DB[recipeId];
  const existing = findMealRule(slot, rulePerson);
  const weeklyLabel = 'Every ' + DAY_NAMES[dayIndex];
  const pinChecked = existing && existing.pinFromDate ? ' checked' : '';
  document.getElementById('sheetBody').innerHTML =
    '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Meal routine</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
    + '<p class="sub">Use <b>' + (r ? escapeHtml(r.title) : 'this meal') + '</b> as a default for ' + SLOT_LABEL[slot].toLowerCase() + '. A routine is a preference; pinned routine meals are locked against re-balance.</p>'
    + '<div class="card" style="padding:14px;margin-top:12px"><div class="row between"><b>Current</b><span class="pill ghost">' + routineLabel(existing) + '</span></div></div>'
    + '<label class="card" style="padding:14px;margin-top:12px;display:flex;gap:12px;align-items:flex-start;cursor:pointer"><input id="routinePinRepeats" type="checkbox"' + pinChecked + ' style="margin-top:3px;min-width:18px;min-height:18px"><span><b>Pin repeated meals too</b><small style="display:block;color:var(--muted);margin-top:4px">Matching routine meals from this date onward stay unchanged unless you unpin them.</small></span></label>'
    + '<button class="cta ghostbtn" onclick="setMealRoutine(\'daily\')">Every day</button>'
    + '<button class="cta ghostbtn" onclick="setMealRoutine(\'alternate\')">Every other day</button>'
    + '<button class="cta ghostbtn" onclick="setMealRoutine(\'weekly\')">' + weeklyLabel + '</button>'
    + '<button class="cta ghostbtn" onclick="clearMealRoutine()">Clear this routine</button>';
  document.getElementById('sheet').classList.remove('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

function replaceMealRule(rule){
  mealRules = mealRules.filter(function(r){ return !(r.slot === rule.slot && r.person === rule.person); });
  mealRules.push(rule);
}

function refreshAfterMealRules(){
  applyMealRulesToStoredPlans();
  refreshAfterMealRuleStateChange();
}

function refreshAfterMealRuleStateChange(){
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderTodayMeals();
  renderLogPlan();
  renderWeek();
  persist();
}

function setMealRoutine(cadence){
  if(!routineCtx) return;
  const pinRepeats = !!(document.getElementById('routinePinRepeats') && document.getElementById('routinePinRepeats').checked);
  const rule = {
    recipeId: routineCtx.recipeId,
    slot: routineCtx.slot,
    cadence: cadence,
    person: routineCtx.person,
    anchorDate: addDaysISO(routineCtx.weekStartDate, routineCtx.dayIndex),
    dayIndex: routineCtx.dayIndex
  };
  if(pinRepeats) rule.pinFromDate = rule.anchorDate;
  replaceMealRule(rule);
  applyMealRulesToStoredPlans();
  if(pinRepeats && typeof pinRoutineOccurrencesFrom === 'function') pinRoutineOccurrencesFrom(rule, rule.pinFromDate);
  closeSheet();
  refreshAfterMealRuleStateChange();
  toast(pinRepeats ? 'Routine saved and pinned' : 'Routine saved');
}

function clearMealRoutine(){
  if(!routineCtx) return;
  mealRules = mealRules.filter(function(r){ return !(r.slot === routineCtx.slot && r.person === routineCtx.person); });
  closeSheet();
  refreshAfterMealRules();
  toast('Routine cleared');
}

/* ---------------- B5: catch-up logging from the Week view (current week only) ----------------
   The ◯/✓/∅ button (see renderWeek's logEligible branch) opens this mini sheet for one
   (dateISO, slot, currentProf) — same log-history funnel as Log/Today (logPlanEntry,
   markSlotSkipped, removeLoggedSlot), just reachable for any past day of the CURRENT week
   instead of only Today/Yesterday. Confirm/Skip both remain offered regardless of the
   current status (so a skip can be corrected to a confirm and vice versa — upsertLogEntry/
   markSlotSkipped already clear the other state's tombstone, see log.js); Undo only when
   something is actually logged. Static onclicks with constant (zero-arg) calls are fine
   here, same as openMealRoutineSheet's setMealRoutine('daily') pattern — weekLogCtx carries
   the real arguments, and the only user string on the sheet (the meal title) is escaped. */
let weekLogCtx = null;

function weekLogStatusLabel(status){
  if(status === 'confirmed') return '✓ Logged';
  if(status === 'skipped') return '∅ Skipped';
  return '◯ Not logged yet';
}

function openWeekLogSheet(weekStartDate, dayIndex, slot, person){
  const plan = ensureWeekPlan(weekStartDate);
  const day = plan.days[dayIndex];
  const dateISO = day.date;
  const meal = day.meals[slot];
  const entry = meal[person];
  weekLogCtx = {weekStartDate: plan.weekStartDate, dayIndex: dayIndex, slot: slot, person: person, dateISO: dateISO};
  const view = displayedSlotViewForDate(dateISO, person, slot, planEntryView(entry, meal.shared));
  const status = slotLogStatus(dateISO, person, slot);
  const titleText = (view.recipe ? mealTitleWithExtras(view) : (SLOT_LABEL[slot] || slot)) + ' · ' + dayDateLabel(dateISO);
  document.getElementById('sheetBody').innerHTML =
    '<div class="row between" style="margin-top:6px"><h2 style="margin:0">' + escapeHtml(titleText) + '</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
    + '<p class="sub">Log what actually happened for ' + SLOT_LABEL[slot].toLowerCase() + ' on this day.</p>'
    + '<div class="card" style="padding:14px;margin-top:12px"><div class="row between"><b>Current</b><span class="pill ghost">' + weekLogStatusLabel(status) + '</span></div></div>'
    + '<button class="cta" onclick="weekLogConfirm()">✓ Eaten as planned</button>'
    + '<button class="cta ghostbtn" onclick="weekLogSkip()">∅ Skipped</button>'
    + (status ? '<button class="cta ghostbtn" onclick="weekLogUndo()">↺ Undo</button>' : '');
  document.getElementById('sheet').classList.remove('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

function weekLogConfirm(){
  if(!weekLogCtx) return;
  const ctx = weekLogCtx;
  const plan = ensureWeekPlan(ctx.weekStartDate);
  const entry = plan.days[ctx.dayIndex] && plan.days[ctx.dayIndex].meals[ctx.slot][ctx.person];
  if(!entry || !entry.recipeId){ closeSheet(); return; }
  // Confirm logs the meal AS PLANNED, extras included (planEntryComponents mirrors
  // logConfirm's own v.components derivation) — only ctx.person's log is written, exactly
  // like logConfirm's shared-meal semantics (the other person logs their own row separately).
  const components = planEntryComponents(entry);
  // Backdated days carry `t: null` (unknown eating time — the migrateV1TodayLog precedent);
  // logging TODAY through this same sheet keeps the normal HH:MM stamp.
  const opts = ctx.dateISO === todayISO() ? undefined : {tNull: true};
  logPlanEntry(ctx.dateISO, ctx.person, ctx.slot, entry.recipeId, entry.portion, components, opts);
  closeSheet();
  refreshAfterLogChange(); // task C1: now renders Week itself — see that function's doc comment
  toast('✓ Logged ' + dayDateLabel(ctx.dateISO).toLowerCase());
}

function weekLogSkip(){
  if(!weekLogCtx) return;
  const ctx = weekLogCtx;
  markSlotSkipped(ctx.dateISO, ctx.person, ctx.slot);
  closeSheet();
  refreshAfterLogChange(); // task C1: now renders Week itself — see that function's doc comment
  toast('∅ Skipped ' + dayDateLabel(ctx.dateISO).toLowerCase());
}

function weekLogUndo(){
  if(!weekLogCtx) return;
  const ctx = weekLogCtx;
  const status = slotLogStatus(ctx.dateISO, ctx.person, ctx.slot);
  if(!status){ closeSheet(); return; }
  removeLoggedSlot(ctx.dateISO, ctx.person, ctx.slot);
  closeSheet();
  refreshAfterLogChange(); // task C1: now renders Week itself — see that function's doc comment
  toast('↺ Un-logged ' + dayDateLabel(ctx.dateISO).toLowerCase());
}

// The "Weekly nutrient coverage" card (FIX 3: moved from the Week screen to the TOP of
// Insights — same markup/ids, same live wiring: renderWeek() still calls this after every
// plan change, and renderInsights() also refreshes it on each visit): the 4 REAL computed metrics from
// planner.js:computeWeeklyCoverage (omega-3 meals/wk ≥3, selenium sources/wk ≥3 while
// Elena's thyroid goal is on, fiber g/day avg vs 25g for whoever of the two is lower,
// sat-fat share of fat ≤33%), replacing the hardcoded Vitamin D demo chips. The chip
// markup (.n/.nt/.nbar) is unchanged — same visual design, real numbers.
function coverageValueText(g){
  if(g.key === 'fiber') return g.value + ' g/day';
  if(g.key === 'satFat') return g.value + '% of fat';
  if(g.key === 'freeSugars' || g.key === 'freeSugarsWarn'){
    const kcal = (PROF && PROF[currentProf] && PROF[currentProf].calGoalNum) || 0;
    const grams = kcal > 0 ? Math.round((g.value / 100) * kcal / 4) : 0;
    return grams + ' g/day (' + g.value + '% of kcal)';
  }
  return g.value + '/wk';
}
function coverageTargetText(g){
  if(g.key === 'fiber') return g.target + ' g/day';
  if(g.key === 'satFat') return '≤' + g.target + '%';
  if(g.key === 'freeSugars' || g.key === 'freeSugarsWarn'){
    const kcal = (PROF && PROF[currentProf] && PROF[currentProf].calGoalNum) || 0;
    const grams = kcal > 0 ? Math.round((g.target / 100) * kcal / 4) : 0;
    return (g.key === 'freeSugars' ? '≈' : '≤') + grams + ' g/day (' + g.target + '% of kcal)';
  }
  return '≥' + g.target + '/wk';
}
// Single chip's markup (.n/.nt/.nbar/.cap-note) for a coverageGaps() entry — factored out
// of renderNutrientChips (Insights) so B4's week-level card (renderWeekNutriCard) can
// paint the SAME two headline chips (omega-3, sat fat) with identical styling instead of
// re-deriving the markup, per the B4 design note "reuse renderNutrientChips' chip styling".
function coverageChipHtml(g){
  const low = g.gap > 1e-9;
  const capNote = g.cap ? '<div class="cap-note">Keep under ' + g.target + '% — staying below is good</div>' : '';
  return '<div class="n'+(low ? ' low' : '')+'"><div class="nt"><span>'+g.label+'</span><b>'+coverageValueText(g)+'</b></div>'
    + '<div class="nbar"><i style="width:'+g.pct+'%"></i></div>'+capNote+'</div>';
}
function renderNutrientChips(){
  const wrap = document.getElementById('nutriChips');
  if(!wrap) return;
  const gaps = coverageGaps(computeWeeklyCoverage(weekPlan));
  const order = ['omega3', 'selenium', 'fiber', 'satFat', 'freeSugars', 'freeSugarsWarn'].filter(function(k){
    return k !== 'selenium' || PROF.elena.hashi; // selenium target tracked only with the thyroid goal on
  });
  wrap.innerHTML = order.map(function(k){ return coverageChipHtml(gaps[k]); }).join('');
  const worstKey = order.reduce(function(a, b){ return gaps[b].gap > gaps[a].gap ? b : a; });
  const worst = gaps[worstKey];
  const pill = document.getElementById('coveragePill');
  if(pill) pill.textContent = worst.gap > 1e-9 ? 'Needs a nudge' : 'On track';
  const note = document.getElementById('coverageNote');
  if(note){
    note.innerHTML = worst.gap > 1e-9
      ? '📌 <b>' + worst.label + ' is the biggest gap</b> — at ' + coverageValueText(worst) + ' vs a ' + coverageTargetText(worst) + ' target. “Re-balance my week” proposes the fewest swaps to close it.'
      : '✅ <b>All coverage targets are on track this week.</b> Omega-3, ' + (PROF.elena.hashi ? 'selenium, ' : '') + 'fiber, saturated fat and free sugars are all within the current guide.';
  }
}

function toggleDay(i){
  document.getElementById('wd'+i).classList.toggle('expanded');
}

/* ---------------- bottom sheet: generic open/close ---------------- */
// mealKey may be a slot name (from Today/Log cards) or a recipe id (from the recipe
// screen) — planner.js:resolveSwapContext maps either to (dayIndex, slot, person) on
// TODAY's plan for the current person. buildSwapSheet stores the computed alternatives
// on swapCtx so chooseSwap (planner.js) applies exactly what was shown.
// 'tall': see openWeekSwap's doc above — the sheet can now be long (FEATURE: swap anything).
function openSwap(mealKey, targetElId){
  // Recipe screen reached from a Week row carries that row's day (recipeDayCtx) —
  // swap THAT day/week, not today. Every other entry point still resolves to today.
  const fromWeekRow = recipeDayCtx && SLOT_ORDER.indexOf(mealKey) === -1;
  const ctx = fromWeekRow
    ? {dayIndex: recipeDayCtx.dayIndex, slot: recipeDayCtx.slot, person: recipeDayCtx.person, weekStartDate: recipeDayCtx.weekStartDate}
    : resolveSwapContext(mealKey);
  openSwapSheetForContext(ctx, targetElId);
}

function logDateSwapContext(slot){
  const dateISO = currentLogDateISO();
  const weekStartDate = mondayOfWeek(dateISO);
  return {dayIndex: diffDaysISO(dateISO, weekStartDate), slot: slot, person: currentProf, weekStartDate: weekStartDate};
}

function openLogSwap(slot, targetElId){
  openSwapSheetForContext(logDateSwapContext(slot), targetElId);
}

// B3: explicit context, mirroring swapCtx/openSwapSheetForContext below — the sheet no
// longer resolves its own (weekStartDate, dayIndex) from an ambient "today" or
// currentLogDateISO() dateISO; every opener builds {weekStartDate, dayIndex, slot, person}
// up front (openAddMealRecipeSheet(slot, dateISO) below still exists as a thin adapter for
// the Today/Log/recipe-screen call sites, which only ever know a dateISO) so the Week
// screen's per-row ＋ button can open the sheet for ANY row (this week or next) the same
// way openWeekSwap already does.
let addMealCtx = null;
let addMealFoodQuery = '';

// (b)/(a) fix: the sheet is now sections instead of one undifferentiated, slot-filtered
// pile — "In this meal" (with a remove control per extra), "Sides", "Sauces" (task D2:
// role:'sauce' recipes — condiments meant to be added to a meal, never planned standalone,
// same delegated-row pattern as Sides), and "Full recipes" (every remaining recipe from ANY
// slot, not just this one — owner complaint (a): "I should always be able to add both sides
// specifically or full main course recipes"). `components` is the meal's CURRENT components
// (base + extras) so all three pick lists exclude what's already in — same resolution
// openAddMealRecipeSheet already had.
function mealTitleSort(a, b){
  const aFav = recipePrefs[a] === 'favorite';
  const bFav = recipePrefs[b] === 'favorite';
  if(aFav !== bFav) return aFav ? -1 : 1;
  return RECIPES_DB[a].title < RECIPES_DB[b].title ? -1 : (RECIPES_DB[a].title > RECIPES_DB[b].title ? 1 : 0);
}
function mealRecipeOptions(components){
  const used = {};
  (components || []).forEach(function(c){ if(c.recipeId) used[c.recipeId] = true; });
  const ids = Object.keys(RECIPES_DB).filter(function(id){ return !used[id]; });
  const isSauce = function(id){ return RECIPES_DB[id].role === 'sauce'; };
  const isSide = function(id){ return !isSauce(id) && recipeSlotList(RECIPES_DB[id]).indexOf('side') !== -1; };
  return {
    sides: ids.filter(isSide).sort(mealTitleSort),
    sauces: ids.filter(isSauce).sort(mealTitleSort),
    full: ids.filter(function(id){ return !isSide(id) && !isSauce(id); }).sort(mealTitleSort)
  };
}

function componentTitle(c){
  if(c && c.recipeId && RECIPES_DB[c.recipeId]) return recipeDisplayTitle(c.recipeId, c.opts);
  if(c && c.foodId && FOODS[c.foodId]) return FOODS[c.foodId].name;
  return null;
}

function componentNutrition(c){
  if(c && c.recipeId) return roundedNutritionTotals(recipeNutrition(c.recipeId, c.portion).totals);
  if(c && c.foodId) return roundedNutritionTotals(foodMacros(c.foodId, c.grams));
  return roundedNutritionTotals(null);
}

function defaultMealFoodGrams(foodId){
  const food = FOODS[foodId];
  if(!food) return 100;
  if(food.unit === 'piece') return food.avgG || 50;
  if(food.unit === 'ml') return 200;
  return 100;
}

// Recipe ids can be user-authored ('cr-<slug>' from a typed recipe name), so the id rides
// in a data-* attribute (htmlAttr-escaped once, never re-parsed as JS) and the click is
// handled by attachAddMealSheetHandler's delegation — same pattern as the shopping list
// (attachShopListClickHandler) and swap search (planner.js:attachSwapSearchHandler).
function mealRecipeOptionRowHtml(id){
  const r = RECIPES_DB[id];
  const nut = roundedNutritionTotals(recipeNutrition(id, 1).totals);
  return '<div class="altrow" data-add-recipe-id="' + htmlAttr(id) + '">'
    + '<div class="ae">' + r.emoji + '</div>'
    + '<div class="at"><div class="an">' + escapeHtml(r.title) + '</div>'
    + '<div class="ad">' + nut.kcal + ' kcal · ' + nut.protein + 'g protein</div></div>'
    + '</div>';
}

// B3: the sheet's single entry point. ctx is the explicit {weekStartDate, dayIndex, slot,
// person} shape (same shape swapCtx/openSwapSheetForContext use) — dateISO is DERIVED from
// the plan day, never passed in ambiently. Logged-vs-plan branch keys off
// `dateISO <= todayISO() && slotLogStatus(...) === 'confirmed'`: for any future date (next
// week, or a not-yet-elapsed day of this week) that's automatically false, so the sheet is
// plan-only there — no new special-casing needed for the Week row entry point below.
function openAddMealSheetForContext(ctx){
  const plan = editableWeekPlan(ctx.weekStartDate);
  const day = plan.days[ctx.dayIndex];
  const dateISO = day && day.date;
  const meal = day && day.meals[ctx.slot];
  const logged = (dateISO && dateISO <= todayISO() && slotLogStatus(dateISO, ctx.person, ctx.slot) === 'confirmed')
    ? loggedPlanEntryForSlot(dateISO, ctx.person, ctx.slot) : null;
  const entry = meal && meal[ctx.person];
  if(!entry && !logged){ toast('Meal not found'); return; }
  const loggedComponents = logged
    ? (Array.isArray(logged.components) && logged.components.length ? logged.components : [{recipeId: logged.ref, portion: logged.portion || 1}])
    : null;
  // Guardrail: filter gracefully if RECIPES_DB is ever missing an id a stored component
  // still points to (e.g. a since-removed recipe) rather than rendering a broken row.
  const components = (loggedComponents || planEntryComponents(entry)).filter(function(c){ return c && RECIPES_DB[c.recipeId]; });
  const allComponents = (loggedComponents || planEntryComponents(entry)).filter(function(c){
    return c && ((c.recipeId && RECIPES_DB[c.recipeId]) || (c.foodId && FOODS[c.foodId]));
  });
  const slot = ctx.slot;
  addMealCtx = {weekStartDate: plan.weekStartDate, dayIndex: ctx.dayIndex, slot: slot, person: ctx.person, logged: !!logged};
  const opts = mealRecipeOptions(allComponents);
  // USER FEEDBACK item 3: retitle "Edit X" once the meal already has extras — "Add to X"
  // undersells that this is also where you remove what you added earlier.
  const sheetHasExtras = allComponents.length > 1;
  const sheetTitle = (sheetHasExtras ? 'Edit ' : 'Add to ') + (SLOT_LABEL[slot] || slot);
  let html = '<div class="row between" style="margin-top:6px"><h2 style="margin:0">' + sheetTitle + '</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
    + '<p class="sub" style="margin-top:6px">See what’s in this meal, add plain ingredients, a side or a full recipe, or remove something you added earlier. Mesa recalculates the meal’s calories and nutrients either way.</p>';

  html += '<div class="shop-cat">In this meal</div>';
  allComponents.forEach(function(c, i){
    const isRecipe = !!c.recipeId;
    const r = isRecipe ? RECIPES_DB[c.recipeId] : null;
    const food = c.foodId ? FOODS[c.foodId] : null;
    const title = isRecipe ? r.title : food.name;
    const emoji = isRecipe ? r.emoji : foodIconHtml(c.foodId);
    const nut = componentNutrition(c);
    const isBase = i === 0;
    // Extras get a 0.5-step portion stepper (base has its own steppers elsewhere on the
    // serving screen, so it's left at its plain "Base ·" label here).
    // Component ids can be user-authored ('cr-'/'cf-' slugs), so rows carry them in
    // data-* attributes and the buttons carry a data-act verb; the single delegated
    // handler (attachAddMealSheetHandler below) maps act+id back to the step/remove
    // functions. No inline onclick, so nothing user-influenced is ever parsed as JS.
    const stepper = isBase ? '' : ('<span class="sv-stepper" style="margin-left:8px;flex:0 0 auto">'
      + '<button data-act="minus" aria-label="' + (isRecipe ? 'Fewer servings of ' : 'Less ') + htmlAttr(title) + '">-</button>'
      + '<span class="sv-val">' + (isRecipe ? (((typeof c.portion === 'number' && c.portion > 0) ? c.portion : 1) + 'x') : foodAmountLabel(food, c.grams)) + '</span>'
      + '<button data-act="plus" aria-label="' + (isRecipe ? 'More servings of ' : 'More ') + htmlAttr(title) + '">+</button>'
      + '</span>');
    html += '<div class="altrow" style="cursor:default" ' + (isRecipe ? 'data-recipe-id="' + htmlAttr(c.recipeId) + '"' : 'data-food-id="' + htmlAttr(c.foodId) + '"') + '>'
      + '<div class="ae">' + emoji + '</div>'
      + '<div class="at"><div class="an">' + escapeHtml(title) + '</div>'
      + '<div class="ad">' + (isBase ? 'Base · ' : '') + nut.kcal + ' kcal · ' + nut.protein + 'g protein</div></div>'
      + stepper
      + (isBase ? '' : '<button class="tag-undo" style="margin-left:8px;flex:0 0 auto" data-act="remove">✕ Remove</button>')
      + '</div>';
  });

  html += '<div class="shop-cat">Ingredients</div>'
    + '<input class="inp" style="width:100%;box-sizing:border-box;border:1px solid var(--line);margin-top:8px" type="text" id="mealFoodSearchInput" placeholder="Search ingredients…" value="' + htmlAttr(addMealFoodQuery) + '" oninput="onMealFoodSearch(this.value)" autocomplete="off">'
    + '<div id="mealFoodResults" style="margin-top:4px">' + renderMealFoodResults(addMealFoodQuery) + '</div>';

  html += '<div class="shop-cat">Sides</div>';
  html += opts.sides.length ? opts.sides.map(mealRecipeOptionRowHtml).join('') : '<p class="sub" style="margin-top:6px">No side recipes available.</p>';

  html += '<div class="shop-cat">Sauces</div>';
  html += opts.sauces.length ? opts.sauces.map(mealRecipeOptionRowHtml).join('') : '<p class="sub" style="margin-top:6px">No sauces available.</p>';

  html += '<div class="shop-cat">Full recipes</div>';
  html += opts.full.length ? opts.full.map(mealRecipeOptionRowHtml).join('') : '<p class="sub" style="margin-top:6px">No other recipes available.</p>';

  document.getElementById('sheetBody').innerHTML = html;
  attachAddMealSheetHandler();
  document.getElementById('sheet').classList.add('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

// Today card ✎/＋, the recipe screen's "Manage" strip, and the Log screen's Add/Edit
// button only ever know a slot + (optionally) a dateISO — never a week/day index — so this
// stays the entry point for all three, unchanged behavior: no dateISO means today, and any
// dateISO resolves to its own week/day via the same mondayOfWeek/diffDaysISO math the sheet
// used internally before this refactor (moved here, not removed).
function openAddMealRecipeSheet(slot, dateISO){
  dateISO = dateISO || todayISO();
  const weekStartDate = mondayOfWeek(dateISO);
  const dayIndex = diffDaysISO(dateISO, weekStartDate);
  openAddMealSheetForContext({weekStartDate: weekStartDate, dayIndex: dayIndex, slot: slot, person: currentProf});
}

// Week row ＋ entry point (task B3) — mirrors openWeekSwap's shape exactly, so a row on
// EITHER This week or Next week can open the sheet directly from its own
// (weekStartDate, dayIndex), without first converting back to a dateISO.
function openWeekAddMealSheet(weekStartDate, dayIndex, slot, person){
  openAddMealSheetForContext({weekStartDate: weekStartDate, dayIndex: dayIndex, slot: slot, person: person});
}

// Delegated click handler for the whole add-meal sheet: composition-row steppers/remove
// (button[data-act] inside a row carrying data-recipe-id / data-food-id), "Sides"/"Full
// recipes" option rows (data-add-recipe-id) and ingredient search results
// (data-add-food-id). One sheetBody.onclick assignment per sheet-open — the same
// non-accumulating pattern as attachShopListClickHandler above; #mealFoodResults keeps
// only its CHILDREN replaced on each keystroke (onMealFoodSearch), so delegation from
// sheetBody survives searches, and every re-render of the sheet re-runs this attach.
function attachAddMealSheetHandler(){
  const el = document.getElementById('sheetBody');
  if(!el) return;
  el.onclick = function(e){
    const btn = e.target.closest('button[data-act]');
    if(btn && el.contains(btn)){
      const row = btn.closest('.altrow');
      if(!row) return;
      const act = btn.getAttribute('data-act');
      const recipeId = row.getAttribute('data-recipe-id');
      const foodId = row.getAttribute('data-food-id');
      if(act === 'remove'){
        if(recipeId) removeMealExtraRecipe(recipeId);
        else if(foodId) removeMealExtraFood(foodId);
      } else if(act === 'minus' || act === 'plus'){
        const dir = act === 'plus' ? 1 : -1;
        if(recipeId) stepMealExtraPortion(recipeId, dir * 0.5);
        else if(foodId) stepMealExtraFoodGrams(foodId, dir * 10);
      }
      return;
    }
    const addRecipeRow = e.target.closest('.altrow[data-add-recipe-id]');
    if(addRecipeRow && el.contains(addRecipeRow)){ chooseMealExtraRecipe(addRecipeRow.getAttribute('data-add-recipe-id')); return; }
    const addFoodRow = e.target.closest('.altrow[data-add-food-id]');
    if(addFoodRow && el.contains(addFoodRow)) chooseMealExtraFood(addFoodRow.getAttribute('data-add-food-id'));
  };
}

function renderMealFoodResults(q){
  q = (q || '').trim();
  if(q.length < 2) return '<p class="sub" style="margin-top:6px">Type at least 2 letters to add plain foods.</p>';
  const ids = searchFoods(q).slice(0, 12);
  if(!ids.length) return '<p class="sub" style="margin-top:6px">No ingredients match “' + escapeHtml(q) + '”.</p>';
  return ids.map(function(id){
    const f = FOODS[id];
    const grams = defaultMealFoodGrams(id);
    const nut = roundedNutritionTotals(foodMacros(id, grams));
    // data-add-food-id instead of onclick: food ids can be user-authored 'cf-' slugs.
    return '<div class="altrow" data-add-food-id="' + htmlAttr(id) + '">'
      + '<div class="ae">' + foodIconHtml(id) + '</div>'
      + '<div class="at"><div class="an">' + escapeHtml(f.name) + '</div>'
      + '<div class="ad">' + foodAmountLabel(f, grams) + ' · ' + nut.kcal + ' kcal · ' + nut.protein + 'g protein</div></div>'
      + '</div>';
  }).join('');
}

function onMealFoodSearch(value){
  addMealFoodQuery = value;
  const el = document.getElementById('mealFoodResults');
  if(el) el.innerHTML = renderMealFoodResults(value);
}

function chooseMealExtraRecipe(recipeId){
  if(!addMealCtx || !RECIPES_DB[recipeId]) return;
  const ctx = addMealCtx;
  const dateISO = addDaysISO(ctx.weekStartDate, ctx.dayIndex);
  if(ctx.logged){
    // Symmetric with removeMealExtraRecipe below: update BOTH the log entry AND the plan
    // entry, else a later swap-correction or undo+reconfirm rebuilds the log from the plan
    // and silently drops this extra, and computeShoppingList (plan-based) never counts it.
    addExtraToLoggedMeal(dateISO, ctx.person, ctx.slot, recipeId);
    addExtraRecipeToMeal(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person, recipeId);
  } else {
    if(!addExtraRecipeToMeal(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person, recipeId)) return;
  }
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderTodayMeals();
  renderLogPlan();
  renderWeek();
  persist();
  closeSheet();
  toast('＋ Added ' + RECIPES_DB[recipeId].title);
}

function chooseMealExtraFood(foodId){
  if(!addMealCtx || !FOODS[foodId]) return;
  const ctx = addMealCtx;
  const grams = defaultMealFoodGrams(foodId);
  const dateISO = addDaysISO(ctx.weekStartDate, ctx.dayIndex);
  if(ctx.logged){
    addFoodExtraToLoggedMeal(dateISO, ctx.person, ctx.slot, foodId, grams);
    addExtraFoodToMeal(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person, foodId, grams);
  } else {
    if(!addExtraFoodToMeal(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person, foodId, grams)) return;
  }
  addMealFoodQuery = '';
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderTodayMeals();
  renderLogPlan();
  renderWeek();
  persist();
  openAddMealRecipeSheet(ctx.slot, dateISO);
  toast('＋ Added ' + FOODS[foodId].name);
}

// (b) fix: owner complaint — once an extra (e.g. Greek salad + cucumber salad alongside
// shakshuka) was added there was no way to take it back off. Symmetric to
// chooseMealExtraRecipe above, with one extra step for an already-logged meal: the logged
// entry is a components snapshot taken at confirm time (state.js:logPlanEntry), separate
// from the still-live plan entry's own extras — removing only from the log would leave a
// matching extra sitting in today's plan entry, which the Week view AND
// computeShoppingList (planner.js) both still read via planEntryComponents, so it would
// keep counting phantom ingredients on the shopping list. We remove from both, treating
// the plan-side removal as best-effort (a no-op, via removeExtraRecipeFromMeal's own
// false return, if that extra was never mirrored into the plan — e.g. one added to an
// already-logged meal via addExtraToLoggedMeal, which never touches the plan).
// Re-renders the sheet in place afterward (not closeSheet()) so several extras can be
// removed back-to-back without reopening.
function removeMealExtraRecipe(recipeId){
  if(!addMealCtx) return;
  const ctx = addMealCtx;
  const dateISO = addDaysISO(ctx.weekStartDate, ctx.dayIndex);
  const title = RECIPES_DB[recipeId] ? RECIPES_DB[recipeId].title : 'item';
  if(ctx.logged){
    if(!removeExtraFromLoggedMeal(dateISO, ctx.person, ctx.slot, recipeId)) return;
    removeExtraRecipeFromMeal(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person, recipeId);
  } else {
    if(!removeExtraRecipeFromMeal(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person, recipeId)) return;
  }
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderTodayMeals();
  renderLogPlan();
  renderWeek();
  persist();
  openAddMealRecipeSheet(ctx.slot, dateISO);
  toast('✕ Removed ' + title);
}

function removeMealExtraFood(foodId){
  if(!addMealCtx) return;
  const ctx = addMealCtx;
  const dateISO = addDaysISO(ctx.weekStartDate, ctx.dayIndex);
  const title = FOODS[foodId] ? FOODS[foodId].name : 'item';
  if(ctx.logged){
    if(!removeFoodExtraFromLoggedMeal(dateISO, ctx.person, ctx.slot, foodId)) return;
    removeExtraFoodFromMeal(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person, foodId);
  } else {
    if(!removeExtraFoodFromMeal(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person, foodId)) return;
  }
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderTodayMeals();
  renderLogPlan();
  renderWeek();
  persist();
  openAddMealRecipeSheet(ctx.slot, dateISO);
  toast('✕ Removed ' + title);
}

// A logged entry's components is a snapshot taken at confirm time (state.js:logPlanEntry),
// separate from the still-live plan entry -- falls back to a single-item [base] array when
// nothing was ever snapshotted (pre-extras logged meals, or logged.components empty).
function loggedMealComponents(logged){
  return Array.isArray(logged.components) && logged.components.length
    ? logged.components.slice()
    : [{recipeId: logged.ref, portion: (typeof logged.portion === 'number' ? logged.portion : 1)}];
}

// Finds the LAST component matching {recipeId} or {foodId} -- duplicates are allowed on
// add, so remove/set take back the most-recently-added match. Index 0 is always the base
// recipe/food from loggedMealComponents, never itself a removable/adjustable extra, so
// (unlike planner.js's findLastExtraIndex, whose entry.extras never carries a base) the
// scan starts at index 1.
function findLastLoggedComponentIndex(components, match){
  for(let i = components.length - 1; i >= 1; i--){
    const c = components[i];
    if(!c) continue;
    if(match.recipeId !== undefined && c.recipeId === match.recipeId) return i;
    if(match.foodId !== undefined && c.foodId === match.foodId) return i;
  }
  return -1;
}

// Commits a mutated components array back onto a logged entry: recomputes frozen totals the
// deterministic way (nutritionForRecipeComponents), never hand-set, and stamps logged.u for
// sync. Logged entries are per-person (the log has no shared-meal concept the way plan
// cells do), so -- unlike planner.js's mutateMealExtras -- there is no partner mirroring.
function commitLoggedMealComponents(logged, components){
  const nut = roundedNutritionTotals(nutritionForRecipeComponents(components));
  logged.components = components;
  logged.kcal = nut.kcal; logged.protein = nut.protein; logged.carbs = nut.carbs;
  logged.fat = nut.fat; logged.satFat = nut.satFat; logged.fiber = nut.fiber;
  logged.sugars = nut.sugars; logged.freeSugars = nut.freeSugars;
  logged.u = Date.now();
  return true;
}

function addExtraToLoggedMeal(dateISO, person, slot, recipeId){
  const logged = loggedPlanEntryForSlot(dateISO, person, slot);
  if(!logged) return false;
  const components = loggedMealComponents(logged);
  components.push({recipeId: recipeId, portion: 1});
  return commitLoggedMealComponents(logged, components);
}

function addFoodExtraToLoggedMeal(dateISO, person, slot, foodId, grams){
  const logged = loggedPlanEntryForSlot(dateISO, person, slot);
  if(!logged) return false;
  const components = loggedMealComponents(logged);
  components.push({foodId: foodId, grams: grams});
  return commitLoggedMealComponents(logged, components);
}

function removeExtraFromLoggedMeal(dateISO, person, slot, recipeId){
  const logged = loggedPlanEntryForSlot(dateISO, person, slot);
  if(!logged) return false;
  const components = loggedMealComponents(logged);
  const idx = findLastLoggedComponentIndex(components, {recipeId: recipeId});
  if(idx === -1) return false;
  components.splice(idx, 1);
  return commitLoggedMealComponents(logged, components);
}

function removeFoodExtraFromLoggedMeal(dateISO, person, slot, foodId){
  const logged = loggedPlanEntryForSlot(dateISO, person, slot);
  if(!logged) return false;
  const components = loggedMealComponents(logged);
  const idx = findLastLoggedComponentIndex(components, {foodId: foodId});
  if(idx === -1) return false;
  components.splice(idx, 1);
  return commitLoggedMealComponents(logged, components);
}

function setExtraPortionInLoggedMeal(dateISO, person, slot, recipeId, newPortion){
  const logged = loggedPlanEntryForSlot(dateISO, person, slot);
  if(!logged) return false;
  const components = loggedMealComponents(logged);
  const idx = findLastLoggedComponentIndex(components, {recipeId: recipeId});
  if(idx === -1) return false;
  components[idx] = {recipeId: recipeId, portion: newPortion};
  return commitLoggedMealComponents(logged, components);
}

function setFoodExtraGramsInLoggedMeal(dateISO, person, slot, foodId, grams){
  const logged = loggedPlanEntryForSlot(dateISO, person, slot);
  if(!logged) return false;
  const components = loggedMealComponents(logged);
  const idx = findLastLoggedComponentIndex(components, {foodId: foodId});
  if(idx === -1) return false;
  components[idx] = {foodId: foodId, grams: Math.max(1, Math.min(2000, Math.round(grams)))};
  return commitLoggedMealComponents(logged, components);
}

// USER FEEDBACK item 1: per-extra portion stepper in the "In this meal" sheet rows.
// Follows chooseMealExtraRecipe/removeMealExtraRecipe's exact pattern: update the logged
// entry (when ctx.logged) AND the plan extra, run the standard refresh funnel, then
// re-render the sheet in place so the stepper's new value shows without closing.
function stepMealExtraPortion(recipeId, delta){
  if(!addMealCtx) return;
  const ctx = addMealCtx;
  const dateISO = addDaysISO(ctx.weekStartDate, ctx.dayIndex);
  const loggedComp = ctx.logged ? loggedPlanEntryForSlot(dateISO, ctx.person, ctx.slot) : null;
  let current = 1;
  if(loggedComp){
    const comps = Array.isArray(loggedComp.components) ? loggedComp.components : [];
    for(let i = comps.length - 1; i >= 1; i--){
      if(comps[i] && comps[i].recipeId === recipeId){ current = (typeof comps[i].portion === 'number' && comps[i].portion > 0) ? comps[i].portion : 1; break; }
    }
  } else {
    const plan = editableWeekPlan(ctx.weekStartDate);
    const meal = plan && plan.days[ctx.dayIndex] && plan.days[ctx.dayIndex].meals[ctx.slot];
    const entry = meal && meal[ctx.person];
    const extras = entry && Array.isArray(entry.extras) ? entry.extras : [];
    for(let i = extras.length - 1; i >= 0; i--){
      if(extras[i] && extras[i].recipeId === recipeId){ current = (typeof extras[i].portion === 'number' && extras[i].portion > 0) ? extras[i].portion : 1; break; }
    }
  }
  const newPortion = Math.min(4, Math.max(0.5, +(current + delta).toFixed(1)));
  if(ctx.logged){
    setExtraPortionInLoggedMeal(dateISO, ctx.person, ctx.slot, recipeId, newPortion);
    setExtraRecipePortion(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person, recipeId, newPortion);
  } else {
    if(!setExtraRecipePortion(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person, recipeId, newPortion)) return;
  }
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderTodayMeals();
  renderLogPlan();
  renderWeek();
  persist();
  openAddMealRecipeSheet(ctx.slot, dateISO);
}

function stepMealExtraFoodGrams(foodId, delta){
  if(!addMealCtx || !FOODS[foodId]) return;
  const ctx = addMealCtx;
  const dateISO = addDaysISO(ctx.weekStartDate, ctx.dayIndex);
  let current = defaultMealFoodGrams(foodId);
  if(ctx.logged){
    const loggedComp = ctx.logged ? loggedPlanEntryForSlot(dateISO, ctx.person, ctx.slot) : null;
    const comps = loggedComp && Array.isArray(loggedComp.components) ? loggedComp.components : [];
    for(let i = comps.length - 1; i >= 1; i--){
      if(comps[i] && comps[i].foodId === foodId){ current = (typeof comps[i].grams === 'number' && comps[i].grams > 0) ? comps[i].grams : current; break; }
    }
  } else {
    const plan = editableWeekPlan(ctx.weekStartDate);
    const meal = plan && plan.days[ctx.dayIndex] && plan.days[ctx.dayIndex].meals[ctx.slot];
    const entry = meal && meal[ctx.person];
    const extras = entry && Array.isArray(entry.extras) ? entry.extras : [];
    for(let i = extras.length - 1; i >= 0; i--){
      if(extras[i] && extras[i].foodId === foodId){ current = (typeof extras[i].grams === 'number' && extras[i].grams > 0) ? extras[i].grams : current; break; }
    }
  }
  const newGrams = Math.max(1, Math.min(2000, Math.round(current + delta)));
  if(ctx.logged){
    setFoodExtraGramsInLoggedMeal(dateISO, ctx.person, ctx.slot, foodId, newGrams);
    setExtraFoodGrams(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person, foodId, newGrams);
  } else {
    if(!setExtraFoodGrams(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person, foodId, newGrams)) return;
  }
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderTodayMeals();
  renderLogPlan();
  renderWeek();
  persist();
  openAddMealRecipeSheet(ctx.slot, dateISO);
}

function closeSheet(){
  if(typeof stopBarcodeScanner === 'function') stopBarcodeScanner();
  document.getElementById('sheetBackdrop').classList.remove('show');
  document.getElementById('sheet').classList.remove('show');
}

// Two-week horizon: which week the shopping sheet currently shows ('current'|'next').
// Reset every time the sheet is opened fresh (openShopping()) to whichever week the Week
// screen was showing at that moment (task: "default: the week currently shown on the Week
// screen when opened from there") — setShopWeek() then lets the sheet's own segmented
// control switch it without closing/reopening. currentShopWeekStartDate is the resolved
// Monday for whichever mode is active right now — toggleShop() writes into that week's
// checked-set, so it's always kept in sync with buildShopSheet()'s own resolution.
let shopWeekMode = 'current';
let currentShopWeekStartDate = null;

function openShopping(){
  shopWeekMode = weekScreenShowsNext ? 'next' : 'current';
  document.getElementById('sheetBody').innerHTML = buildShopSheet();
  document.getElementById('sheet').classList.add('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
  attachShopListClickHandler();
}

// Switches the shopping sheet's own "This week | Next week" control without closing the
// sheet — same pattern as setWeekScreenMode() on the Week screen, just scoped to the sheet.
function setShopWeek(mode){
  shopWeekMode = mode;
  document.getElementById('sheetBody').innerHTML = buildShopSheet();
  attachShopListClickHandler();
}

// Shopping-list ids (sh-0, sh-1…) are positional and change whenever the list
// recomputes (different week, different servings), so checked state is tracked and
// persisted by ingredient NAME, PER WEEK (checkedShopByWeek/checkedSetForWeek, state.js)
// — the DOM class is just this render's presentation of that. Writes into whichever
// week's bucket buildShopSheet() most recently resolved (currentShopWeekStartDate), so
// checking an item on next week's list never touches this week's checks and vice versa.
function toggleShop(id, name){
  const el = document.getElementById(id);
  if(!el) return;
  el.classList.toggle('done');
  if(name && currentShopWeekStartDate){
    const checked = checkedSetForWeek(currentShopWeekStartDate);
    if(el.classList.contains('done')) checked[name] = true;
    else delete checked[name];
    persist();
  }
}

// Delegated click handler for the shopping list's .shop-item rows (buildShopSheet below).
// Ingredient NAMES can be user-authored (custom food/recipe names), so rows carry the name
// only in a data-* attribute (htmlAttr-escaped once by the HTML-attribute parser, never
// re-parsed as JS) instead of interpolating it into an onclick="..." JS string — same
// re-attach-after-innerHTML-rebuild pattern as attachSwapSearchHandler (planner.js).
function attachShopListClickHandler(){
  const el = document.getElementById('sheetBody');
  if(!el) return;
  el.onclick = function(e){
    const row = e.target.closest('.shop-item');
    if(!row || !el.contains(row)) return;
    toggleShop(row.id, row.getAttribute('data-shop-name') || '');
  };
}

function buildShopSheet(){
  const weekStartDate = shopWeekMode === 'next' ? nextMondayISO() : mondayOfWeek(todayISO());
  currentShopWeekStartDate = weekStartDate; // toggleShop() writes into this week's checked-set
  const list = computeShoppingList(weekStartDate);
  const checked = checkedSetForWeek(weekStartDate);
  const byCat = {};
  Object.keys(list.totals).forEach(function(name){
    const cat = foodCategoryForName(name); // real FOODS[..].cat, no hand-typed map (task C2)
    (byCat[cat] = byCat[cat] || []).push(name);
  });
  // Task C3 item 4 (generalized for the two-week horizon): the week date range, computed
  // from the week actually being shown, never the current week by default.
  const weekRange = fmtShopWeekRange(list.weekStartDate);
  const weekLabel = shopWeekMode === 'next' ? 'next week\'s' : 'this week\'s';
  let html = '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Shopping list <span class="chip-computed">✓ computed</span></h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
    + '<div class="seg" style="width:100%;margin-top:10px">'
    + '<button style="flex:1" class="'+(shopWeekMode === 'current' ? 'on' : '')+'" onclick="setShopWeek(\'current\')">This week</button>'
    + '<button style="flex:1" class="'+(shopWeekMode === 'next' ? 'on' : '')+'" onclick="setShopWeek(\'next\')">Next week</button>'
    + '</div>'
    + '<p class="sub" style="margin-top:10px"><b>' + weekRange + '</b> · For both of you · 7 days · totals summed from ' + weekLabel + ' plan at each meal\'s planned portions. Shared meals are cooked once and counted once.</p>';
  let idx = 0;
  SHOP_CAT_ORDER.forEach(function(cat){
    const names = byCat[cat];
    if(!names || !names.length) return;
    names.sort();
    html += '<div class="shop-cat">'+cat+'</div>';
    names.forEach(function(name){
      const t = list.totals[name];
      const id = 'sh-' + (idx++);
      const done = checked[name] ? ' done' : '';
      html += '<div class="shop-item'+done+'" id="'+id+'" data-shop-name="'+htmlAttr(name)+'"><div class="sck">✓</div><div class="sname">'+escapeHtml(name)+'</div><div class="sqty">'+fmtShopQty(t.qty, t.unit)+'</div></div>';
    });
  });
  const stapleNames = Object.keys(list.staples).sort();
  if(stapleNames.length){
    html += '<div class="shop-cat">Pantry staples — check you have these</div>';
    stapleNames.forEach(function(name){
      const id = 'sh-' + (idx++);
      const done = checked[name] ? ' done' : '';
      html += '<div class="shop-item'+done+'" id="'+id+'" data-shop-name="'+htmlAttr(name)+'"><div class="sck">✓</div><div class="sname">'+escapeHtml(name)+'</div></div>';
    });
  }
  return html;
}

/* ---------------- re-balance week (task C2 item 4 — real solver) ---------------- */
// buildRebalanceSheet asks planner.js:proposeRebalanceSuggestions() for the real worst
// coverage gap and a small deterministic set of swap/side suggestions that improve it;
// applyRebalance() commits only the accepted suggestions, persists, and re-renders
// every surface that shows the plan (chips included).
let rebalanceProposal = null;
let todayRebalanceProposal = null;

function rebalanceValueAfter(prop){
  // The worst metric's value on the proposed plan, formatted like the chips.
  const gaps = coverageGaps(prop.after);
  return coverageValueText(gaps[prop.metricKey]);
}

function rebalanceProposalLabel(){
  return rebalanceProposal && rebalanceProposal.weekStartDate === nextMondayISO() ? 'next week' : 'this week';
}

function rebalanceSuggestionLabel(s){
  if(s.kind === 'swap'){
    const to = RECIPES_DB[s.toRecipeId];
    return DAY_NAMES[s.unit.dayIndex] + ' ' + SLOT_LABEL[s.unit.slot].toLowerCase() + ' → ' + escapeHtml(to.title);
  }
  const side = RECIPES_DB[s.sideRecipeId];
  return DAY_NAMES[s.unit.dayIndex] + ' ' + SLOT_LABEL[s.unit.slot].toLowerCase() + ' + side ' + escapeHtml(side.title);
}

function rebalanceAcceptedPlan(prop){
  if(!prop) return null;
  const basePlan = ensureWeekPlan(prop.weekStartDate);
  const resultPlan = JSON.parse(JSON.stringify(basePlan));
  prop.suggestions.forEach(function(s){
    if(s.accepted === false) return;
    if(typeof canAutoMutateUnit === 'function' && !canAutoMutateUnit(resultPlan, s.unit)) return;
    if(s.kind === 'swap') applySwapToPlan(resultPlan, s.unit, s.toRecipeId);
    else addSideToPlan(resultPlan, s.unit, s.sideRecipeId);
  });
  return resultPlan;
}

function setRebalanceSuggestionChoice(index, accepted){
  if(!rebalanceProposal || !rebalanceProposal.suggestions || !rebalanceProposal.suggestions[index]) return;
  rebalanceProposal.suggestions[index].accepted = !!accepted;
  document.getElementById('sheetBody').innerHTML = renderRebalanceSheet();
}

function buildRebalanceSheet(){
  const weekStartDate = weekScreenShowsNext ? nextMondayISO() : mondayOfWeek(todayISO());
  rebalanceProposal = proposeRebalanceSuggestions(weekStartDate);
  return renderRebalanceSheet();
}

function renderRebalanceSheet(){
  if(!rebalanceProposal) return '';
  const g = rebalanceProposal.gapInfo;
  const acceptedPlan = rebalanceAcceptedPlan(rebalanceProposal);
  let html = '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Re-balance ' + rebalanceProposalLabel() + '</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>';
  if(!rebalanceProposal.suggestions.length){
    const allMet = g.gap <= 1e-9;
    html += '<p class="sub">' + (allMet
      ? 'Nothing to fix — all four weekly coverage targets are already met. Nicely balanced.'
      : 'The biggest gap right now is <b>' + g.label + '</b> (' + coverageValueText(g) + ' vs ' + coverageTargetText(g) + '), but no legal suggestion improves it for this week.')
      + '</p>'
      + '<button class="cta ghostbtn" onclick="closeSheet()">Close</button>';
    return html;
  }
  html += '<p class="sub">Keeps fixed: pinned meals, logged or skipped slots, foods you avoid, and past dates. Biggest computed gap: <b>' + g.label + '</b> at ' + coverageValueText(g) + ' (target ' + coverageTargetText(g) + '). Suggestions stay conservative and week-aware.</p>'
    + '<div class="card" style="padding:14px">'
    + '<b style="font-size:13px">Suggestions</b>';
  rebalanceProposal.suggestions.forEach(function(s, i){
    const accepted = s.accepted !== false;
    const who = s.unit.shared ? '' : (s.unit.person === 'elena' ? ' (Elena)' : ' (Andrea)');
    const last = i === rebalanceProposal.suggestions.length - 1;
    const kind = s.kind === 'swap' ? 'swap' : 'side';
    const icon = s.kind === 'swap' ? RECIPES_DB[s.toRecipeId].emoji : RECIPES_DB[s.sideRecipeId].emoji;
    html += '<div class="logitem"' + (last ? ' style="border-bottom:0"' : '') + '><div class="li-i" style="background:var(--sage-tint)">' + icon + '</div>'
      + '<div class="li-t">' + rebalanceSuggestionLabel(s) + who
      + '<small>' + (kind === 'swap' ? 'Swap' : 'Add side') + ' · +' + g.label + '</small></div>'
      + '<div class="row" style="gap:8px">'
      + '<button class="backbtn' + (accepted ? ' on' : '') + '" onclick="setRebalanceSuggestionChoice(' + i + ',true)">Accept</button>'
      + '<button class="backbtn' + (!accepted ? ' on' : '') + '" onclick="setRebalanceSuggestionChoice(' + i + ',false)">Refuse</button>'
      + '</div></div>';
  });
  const acceptedGap = coverageGaps(computeWeeklyCoverage(acceptedPlan))[rebalanceProposal.metricKey];
  html += '</div>'
    + '<p class="sub">' + g.label + ' after accepted suggestions: <b>' + coverageValueText(acceptedGap) + '</b> (now ' + coverageValueText(g) + ').</p>'
    + '<button class="cta" onclick="applyRebalance()">Apply re-balance</button>'
    + '<button class="cta ghostbtn" onclick="closeSheet()">Cancel</button>';
  return html;
}

function openRebalanceSheet(){
  document.getElementById('sheetBody').innerHTML = buildRebalanceSheet();
  document.getElementById('sheet').classList.remove('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

function applyRebalance(){
  if(!rebalanceProposal || !rebalanceProposal.suggestions.length){ closeSheet(); return; }
  const g = rebalanceProposal.gapInfo;
  const accepted = rebalanceProposal.suggestions.filter(function(s){ return s.accepted !== false; });
  if(!accepted.length){ closeSheet(); return; }
  const basePlan = ensureWeekPlan(rebalanceProposal.weekStartDate);
  const resultPlan = rebalanceAcceptedPlan(rebalanceProposal);
  const afterText = coverageValueText(coverageGaps(computeWeeklyCoverage(resultPlan))[rebalanceProposal.metricKey]);
  preserveLoggedSlots(basePlan, resultPlan);
  // Belt-and-braces pin guard (2026-07-19 pin-leak report): every suggestion is already
  // filtered per-unit by canAutoMutateUnit (enumeration AND apply time), but regeneration
  // (ensureWeekPlan) already gets a preservePinnedSlots final pass, and this apply path is
  // the same kind of AUTO mutation — so any pinned cell is restored from basePlan
  // wholesale here regardless of what the accepted suggestions did. Explicit user
  // corrections (manual swap, routine set, extras edit) never route through this
  // function, so v56's "explicit user corrections remain allowed" is untouched.
  preservePinnedSlots(basePlan, resultPlan);
  markWeekPlanEdited(resultPlan);
  weekPlans[rebalanceProposal.weekStartDate] = resultPlan;
  if(rebalanceProposal.weekStartDate === mondayOfWeek(todayISO())) weekPlan = resultPlan;
  rebalanceProposal = null;
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderTodayMeals();
  renderLogPlan();
  renderWeek();
  persist();
  closeSheet();
  toast('✓ Week re-balanced — ' + g.label + ' now ' + afterText);
}

/* ---------------- re-balance today (UI slice) ---------------- */
function todayRebalanceProposalDate(){
  return (todayRebalanceProposal && todayRebalanceProposal.dateISO) || todayISO();
}

function todayRebalanceSuggestionLabel(s){
  const unit = s.unit || {};
  const slot = unit.slot || s.slot || '';
  const label = SLOT_LABEL[slot] || slot || 'Meal';
  if(s.kind === 'swap'){
    const to = RECIPES_DB[s.toRecipeId] || {};
    return label + ' → ' + escapeHtml(to.title || 'suggested meal');
  }
  const side = RECIPES_DB[s.sideRecipeId] || {};
  return label + ' + side ' + escapeHtml(side.title || 'suggested side');
}

function todayRebalanceSuggestionIcon(s){
  if(s.kind === 'swap'){
    const to = RECIPES_DB[s.toRecipeId] || {};
    return to.emoji || '↔';
  }
  const side = RECIPES_DB[s.sideRecipeId] || {};
  return side.emoji || '+';
}

function todayRebalanceChangedSuggestions(beforePlan, afterPlan, suggestions){
  if(!beforePlan || !afterPlan || !Array.isArray(suggestions)) return [];
  return suggestions.filter(function(s){
    return s && s.accepted !== false && s.unit
      && todayRebalanceUnitSnapshot(beforePlan, s.unit) !== todayRebalanceUnitSnapshot(afterPlan, s.unit);
  });
}

function todayRebalanceAcceptedCount(prop){
  return prop && prop.suggestions ? prop.suggestions.filter(function(s){ return s.accepted !== false && todayRebalanceUnitCanApply(prop, s); }).length : 0;
}

function todayRebalanceUnitCanApply(prop, s){
  if(typeof canApplyTodayRebalanceUnit !== 'function') return true;
  const dateISO = (prop && prop.dateISO) || todayISO();
  const plan = ensureWeekPlan(mondayOfWeek(dateISO));
  return canApplyTodayRebalanceUnit(plan, (s && s.unit) || {}, dateISO);
}

function setTodayRebalanceSuggestionChoice(index, accepted){
  if(!todayRebalanceProposal || !todayRebalanceProposal.suggestions || !todayRebalanceProposal.suggestions[index]) return;
  todayRebalanceProposal.suggestions[index].accepted = !!accepted;
  document.getElementById('sheetBody').innerHTML = renderTodayRebalanceSheet();
}

function buildTodayRebalanceSheet(){
  const dateISO = todayISO();
  todayRebalanceProposal = proposeTodayRebalanceSuggestions(dateISO, currentProf);
  if(todayRebalanceProposal){
    todayRebalanceProposal.dateISO = todayRebalanceProposal.dateISO || dateISO;
    todayRebalanceProposal.personKey = todayRebalanceProposal.personKey || currentProf;
  }
  return renderTodayRebalanceSheet();
}

function renderTodayRebalanceSheet(){
  if(!todayRebalanceProposal) return '';
  const suggestions = todayRebalanceProposal.suggestions || [];
  let html = '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Re-balance today</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>';
  if(!suggestions.length){
    html += '<p class="sub">Nothing to fix for today. Your current menu already fits the remaining day as well as Mesa can nudge it.</p>'
      + '<button class="cta ghostbtn" onclick="closeSheet()">Close</button>';
    return html;
  }

  html += '<p class="sub">Keeps fixed: logged or skipped slots, pinned meals, foods you avoid, and the rest of the week. Accept the swaps you want, then apply them to today only.</p>'
    + '<div class="card" style="padding:14px">'
    + '<b style="font-size:13px">Suggestions</b>';
  suggestions.forEach(function(s, i){
    const accepted = s.accepted !== false;
    const canApply = todayRebalanceUnitCanApply(todayRebalanceProposal, s);
    const disabled = canApply ? '' : ' disabled';
    const last = i === suggestions.length - 1;
    const kind = s.kind === 'swap' ? 'Swap' : 'Add side';
    const lockedNote = canApply ? '' : ' · Locked';
    html += '<div class="logitem"' + (last ? ' style="border-bottom:0"' : '') + '><div class="li-i" style="background:var(--sage-tint)">' + todayRebalanceSuggestionIcon(s) + '</div>'
      + '<div class="li-t">' + todayRebalanceSuggestionLabel(s)
      + '<small>' + kind + lockedNote + '</small></div>'
      + '<div class="row" style="gap:8px">'
      + '<button class="backbtn' + (accepted && canApply ? ' on' : '') + '"' + disabled + ' onclick="setTodayRebalanceSuggestionChoice(' + i + ',true)">Accept</button>'
      + '<button class="backbtn' + (!accepted || !canApply ? ' on' : '') + '" onclick="setTodayRebalanceSuggestionChoice(' + i + ',false)">Refuse</button>'
      + '</div></div>';
  });
  html += '</div>'
    + '<p class="sub">Accepted suggestions: <b>' + todayRebalanceAcceptedCount(todayRebalanceProposal) + '</b>.</p>'
    + '<button class="cta" onclick="applyTodayRebalance()">Apply ' + todayRebalanceAcceptedCount(todayRebalanceProposal) + ' ' + (todayRebalanceAcceptedCount(todayRebalanceProposal) === 1 ? 'change' : 'changes') + '</button>'
    + '<button class="cta ghostbtn" onclick="closeSheet()">Cancel</button>';
  return html;
}

function renderTodayRebalanceAppliedSheet(changedSuggestions){
  const changed = Array.isArray(changedSuggestions) ? changedSuggestions : [];
  let html = '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Applied changes</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
    + '<p class="sub">Today was updated. Logged and skipped meals stayed fixed.</p>';
  html += '<div class="card" style="padding:14px"><b style="font-size:13px">Changed today</b>';
  changed.forEach(function(s, i){
    html += '<div class="logitem"' + (i === changed.length - 1 ? ' style="border-bottom:0"' : '') + '>'
      + '<div class="li-i" style="background:var(--sage-tint)">' + todayRebalanceSuggestionIcon(s) + '</div>'
      + '<div class="li-t">' + todayRebalanceSuggestionLabel(s)
      + '<small>Updated in Today, Log, Week, and saved offline</small></div></div>';
  });
  html += '</div><button class="cta" onclick="closeSheet()">Done</button>';
  return html;
}

function openTodayRebalanceSheet(){
  document.getElementById('sheetBody').innerHTML = buildTodayRebalanceSheet();
  document.getElementById('sheet').classList.remove('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

function applyTodayRebalance(){
  if(!todayRebalanceProposal || !todayRebalanceProposal.suggestions || !todayRebalanceProposal.suggestions.length){ closeSheet(); return; }
  todayRebalanceProposal.suggestions.forEach(function(s){
    if(!todayRebalanceUnitCanApply(todayRebalanceProposal, s)) s.accepted = false;
  });
  const accepted = todayRebalanceProposal.suggestions.filter(function(s){ return s.accepted !== false; });
  if(!accepted.length){ closeSheet(); return; }
  const basePlan = ensureWeekPlan(mondayOfWeek(todayRebalanceProposalDate()));
  const resultPlan = todayRebalanceAcceptedPlan(todayRebalanceProposal);
  if(!resultPlan){ closeSheet(); return; }
  const changedSuggestions = todayRebalanceChangedSuggestions(basePlan, resultPlan, accepted);
  if(!changedSuggestions.length){
    document.getElementById('sheetBody').innerHTML =
      '<div class="row between" style="margin-top:6px"><h2 style="margin:0">No open meals changed</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
      + '<p class="sub">Those suggestions are no longer applicable. A meal may have been logged, skipped, pinned, or updated since the sheet opened.</p>'
      + '<button class="cta" onclick="document.getElementById(\'sheetBody\').innerHTML=buildTodayRebalanceSheet()">Refresh suggestions</button>'
      + '<button class="cta ghostbtn" onclick="closeSheet()">Close</button>';
    toast('No open meals changed — re-open re-balance for fresh suggestions');
    return;
  }
  const weekStartDate = resultPlan.weekStartDate || mondayOfWeek(todayRebalanceProposalDate());
  preserveLoggedSlots(basePlan, resultPlan);
  // Same belt-and-braces pin guard as applyRebalance above: today-rebalance is AUTO
  // mutation too, so pinned cells are restored from basePlan after the logged-slot pass.
  preservePinnedSlots(basePlan, resultPlan);
  markWeekPlanEdited(resultPlan);
  weekPlans[weekStartDate] = resultPlan;
  if(weekStartDate === mondayOfWeek(todayISO())) weekPlan = resultPlan;
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderTodayMeals();
  renderLogPlan();
  renderWeek();
  persist();
  todayRebalanceProposal = null;
  document.getElementById('sheetBody').innerHTML = renderTodayRebalanceAppliedSheet(changedSuggestions);
  document.getElementById('sheet').classList.add('show');
  document.getElementById('sheetBackdrop').classList.add('show');
  toast('✓ Today re-balanced — ' + changedSuggestions.length + (changedSuggestions.length === 1 ? ' change' : ' changes'));
}

/* ---------------- log / plan-first confirm (task D1: writes real LogEntrys) ---------------- */
let selectedLogDateISO = todayISO();
let logMenu = null;

function currentLogDateISO(){
  return selectedLogDateISO || todayISO();
}

function logDateLabel(){
  return currentLogDateISO() === todayISO() ? 'Today' : 'Yesterday';
}

function setLogDateMode(mode, el){
  selectedLogDateISO = mode === 'yesterday' ? addDaysISO(todayISO(), -1) : todayISO();
  const seg = document.getElementById('logDateSeg');
  if(seg) seg.querySelectorAll('button').forEach(function(b){ b.classList.remove('on'); });
  if(el) el.classList.add('on');
  renderLogPlan();
}

// Recomputes the "Today so far" kcal pill straight from today's logHistory entries for
// currentProf (task D1 item 3) — replaces the old incrementally-accumulated `logTotal`.
function updateLogTotalPill(){
  const entries = getDayLog(currentLogDateISO())[currentProf];
  const total = entries.reduce(function(s, e){ return s + logEntryNutrition(e).kcal; }, 0);
  document.getElementById('logTotalPill').textContent = Math.round(total) + ' kcal';
}

function macroSummaryFromTotals(nut){
  nut = roundedNutritionTotals(nut || {});
  return nut.protein + 'g protein · ' + nut.carbs + 'g carbs · ' + nut.sugars + 'g sugars · ' + nut.fat + 'g fat';
}

function beverageCountsForToday(){
  const entries = getDayLog(currentLogDateISO())[currentProf];
  return entries.reduce(function(acc, e){
    if(e.kind !== 'food' || (e.ref !== 'espresso-unsweetened' && e.ref !== 'cappuccino-unsweetened')) return acc;
    const food = FOODS[e.ref];
    const count = food && food.unit === 'piece' ? Math.round(e.grams / food.avgG) : 1;
    if(e.ref === 'espresso-unsweetened') acc.coffee += count;
    if(e.ref === 'cappuccino-unsweetened') acc.cappuccino += count;
    return acc;
  }, {coffee: 0, cappuccino: 0});
}

function renderBeverageCounts(){
  const el = document.getElementById('coffeeCountPill');
  if(!el) return;
  const counts = beverageCountsForToday();
  el.textContent = counts.coffee + ' coffee · ' + counts.cappuccino + ' cappuccino';
}

function foodAmountLabel(food, grams){
  if(!food) return grams + 'g';
  if(food.unit === 'piece' && food.avgG){
    const count = Math.max(1, Math.round(grams / food.avgG));
    return count + 'x';
  }
  return Math.round(grams) + (food.unit || 'g');
}

function foodGroupTitle(food, grams){
  if(!food) return 'Food';
  if(food === FOODS['espresso-unsweetened']){
    const count = Math.max(1, Math.round(grams / food.avgG));
    return count + (count === 1 ? ' coffee' : ' coffees');
  }
  if(food === FOODS['cappuccino-unsweetened']){
    const count = Math.max(1, Math.round(grams / food.avgG));
    return count + (count === 1 ? ' cappuccino' : ' cappuccinos');
  }
  if(food.unit === 'piece' && food.avgG){
    const count = Math.max(1, Math.round(grams / food.avgG));
    const plural = count === 1 ? food.name : (food.name + 's');
    return count + ' ' + plural;
  }
  return food.name;
}

let todayRecordGroups = [];
let editTodayFoodCtx = null;

function groupedTodayRecords(){
  const raw = getDayLog(todayISO())[currentProf];
  const groups = [];
  const foodByRef = {};
  raw.forEach(function(e, i){
    if(e.kind === 'food'){
      const key = 'food:' + e.ref;
      if(!foodByRef[key]){
        foodByRef[key] = {kind: 'food', ref: e.ref, indices: [], grams: 0, kcal: 0, t: e.t || ''};
        groups.push(foodByRef[key]);
      }
      foodByRef[key].indices.push(i);
      foodByRef[key].grams += e.grams || 0;
      foodByRef[key].kcal += logEntryNutrition(e).kcal;
      if((e.t || '') < (foodByRef[key].t || '99:99')) foodByRef[key].t = e.t || '';
    } else {
      groups.push({kind: 'plan', entry: e, indices: [i], t: e.t || ''});
    }
  });
  return groups.sort(function(a, b){ return ((a.t || '00:00') < (b.t || '00:00')) ? -1 : 1; });
}

// "Today so far" list (task D1 item 3): every logged entry for currentProf today —
// confirmed plan slots AND quick-added foods — sorted by log time. Fully derived from
// logHistory on every call, so it can never drift from what confirm/skip/quick-add wrote.
// FIX 2c (feedback): every row carries a ✕ that removes that SPECIFIC entry from
// logHistory (removeTodayEntry below). Rows are sorted for display but each ✕ carries the
// entry's ORIGINAL index in the day's array (captured before the sort), so it always
// removes exactly the entry shown.
function renderTodaySoFar(){
  const raw = getDayLog(currentLogDateISO())[currentProf];
  const entries = raw.map(function(e, i){ return {e: e, i: i}; }).sort(function(a, b){
    return ((a.e.t || '00:00') < (b.e.t || '00:00')) ? -1 : 1;
  });
  const list = document.getElementById('todaySoFar');
  if(!list) return;
  if(!entries.length){
    list.innerHTML = '<p class="sub" style="margin:8px 0 0">Nothing logged yet for ' + logDateLabel().toLowerCase() + '.</p>';
    return;
  }
  list.innerHTML = entries.map(function(row){
    const e = row.e;
    const removeBtn = '<button class="li-x" aria-label="Remove this entry" onclick="removeTodayEntry('+row.i+')">✕</button>';
    if(e.kind === 'plan'){
      const r = RECIPES_DB[e.ref];
      const emoji = r ? r.emoji : '🍽️';
      const title = escapeHtml(logEntryTitleWithComponents(e));
      const label = (e.slot ? SLOT_LABEL[e.slot] : 'Meal') + (e.t ? ' · ' + e.t : ' · earlier today');
      return '<div class="logitem"><div class="li-i">'+emoji+'</div><div class="li-t">'+title+'<small>'+label+'</small></div><div class="li-k">'+Math.round(logEntryNutrition(e).kcal)+'</div>'+removeBtn+'</div>';
    }
    const food = FOODS[e.ref];
    const name = escapeHtml(food ? food.name : 'Food');
    let amount = e.grams + 'g';
    if(food && food.unit === 'piece'){
      const count = Math.max(1, Math.round(e.grams / food.avgG));
      amount = count + 'x';
    }
    const label = (e.ref === 'espresso-unsweetened' || e.ref === 'cappuccino-unsweetened' ? 'Drink' : 'Quick add') + ' · ' + amount + (e.t ? ' · ' + e.t : '');
    return '<div class="logitem"><div class="li-i">🥄</div><div class="li-t">'+name+'<small>'+label+'</small></div><div class="li-k">'+Math.round(logEntryNutrition(e).kcal)+'</div>'+removeBtn+'</div>';
  }).join('');
}

function renderTodayRecords(){
  const raw = getDayLog(todayISO())[currentProf];
  const list = document.getElementById('todayRecordsList');
  const pill = document.getElementById('todayRecordsPill');
  if(!list) return;
  const total = raw.reduce(function(s, e){ return s + logEntryNutrition(e).kcal; }, 0);
  if(pill) pill.textContent = Math.round(total) + ' kcal';
  todayRecordGroups = groupedTodayRecords();
  if(!todayRecordGroups.length){
    list.innerHTML = '<p class="sub" style="margin:8px 0 0">Nothing logged yet today.</p>';
    return;
  }
  list.innerHTML = todayRecordGroups.map(function(group, gi){
    const editBtn = '<button class="li-x" aria-label="Edit this item" onclick="openEditTodayRecord('+gi+')">✎</button>';
    const deleteBtn = '<button class="li-x" aria-label="Delete this item" onclick="deleteTodayRecordGroup('+gi+')">✕</button>';
    if(group.kind === 'plan'){
      const e = group.entry;
      const r = RECIPES_DB[e.ref];
      const emoji = r ? r.emoji : '🍽️';
      const title = escapeHtml(logEntryTitleWithComponents(e));
      const label = (e.slot ? SLOT_LABEL[e.slot] : 'Meal') + ' · ' + macroSummaryFromTotals(logEntryNutrition(e)) + (e.t ? ' · ' + e.t : '');
      return '<div class="logitem"><div class="li-i">'+emoji+'</div><div class="li-t">'+title+'<small>'+label+'</small></div><div class="li-k">'+Math.round(logEntryNutrition(e).kcal)+'</div>'+deleteBtn+'</div>';
    }
    const food = FOODS[group.ref];
    const title = escapeHtml(foodGroupTitle(food, group.grams));
    const nut = foodMacros(group.ref, group.grams);
    const label = (group.ref === 'espresso-unsweetened' || group.ref === 'cappuccino-unsweetened' ? 'Drink' : 'Quick add') + ' · ' + foodAmountLabel(food, group.grams) + ' · ' + macroSummaryFromTotals(nut);
    return '<div class="logitem"><div class="li-i">🥄</div><div class="li-t">'+title+'<small>'+label+'</small></div><div class="li-k">'+Math.round(group.kcal)+'</div>'+editBtn+deleteBtn+'</div>';
  }).join('');
}

function deleteTodayRecordGroup(groupIndex){
  const group = todayRecordGroups[groupIndex];
  if(!group) return;
  group.indices.slice().sort(function(a, b){ return b - a; }).forEach(function(i){ removeLogEntryAt(todayISO(), currentProf, i); });
  refreshAfterLogChange();
  toast('✕ Removed item');
}

function openEditTodayRecord(groupIndex){
  const group = todayRecordGroups[groupIndex];
  if(!group) return;
  if(group.kind === 'plan'){
    deleteTodayRecordGroup(groupIndex);
    return;
  }
  editTodayFoodCtx = {indices: group.indices.slice(), ref: group.ref, grams: Math.max(1, Math.round(group.grams))};
  document.getElementById('sheetBody').innerHTML = buildEditTodayFoodSheet();
  document.getElementById('sheet').classList.remove('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

function buildEditTodayFoodSheet(){
  const food = FOODS[editTodayFoodCtx.ref];
  if(!food) return '<p class="sub">Food not found.</p>';
  const nut = foodMacros(editTodayFoodCtx.ref, editTodayFoodCtx.grams);
  const isPiece = food.unit === 'piece' && food.avgG;
  const amountText = isPiece ? Math.max(1, Math.round(editTodayFoodCtx.grams / food.avgG)) + 'x' : editTodayFoodCtx.grams + 'g';
  const step = isPiece ? food.avgG : 10;
  return '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Edit ' + escapeHtml(food.name) + '</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
    + '<div class="serve-row" style="margin-top:14px"><div class="serve-card me" style="flex:1">'
    + '<div class="sv-name">Amount</div>'
    + '<div class="sv-stepper"><button onclick="stepEditTodayFood(-'+step+')" aria-label="Decrease amount">–</button>'
    + '<span class="sv-val">' + amountText + '</span>'
    + '<button onclick="stepEditTodayFood('+step+')" aria-label="Increase amount">+</button></div></div></div>'
    + '<div class="nutri" style="margin-top:16px">'
    + '<div class="n"><div class="nt"><span>Calories</span><b>'+Math.round(nut.kcal)+' kcal</b></div></div>'
    + '<div class="n"><div class="nt"><span>Protein</span><b>'+Math.round(nut.protein)+' g</b></div></div>'
    + '<div class="n"><div class="nt"><span>Carbs</span><b>'+Math.round(nut.carbs)+' g</b></div></div>'
    + '<div class="n"><div class="nt"><span>Sugars</span><b>'+Math.round(nut.sugars)+' g</b></div></div>'
    + '<div class="n"><div class="nt"><span>Fat</span><b>'+Math.round(nut.fat)+' g</b></div></div>'
    + '</div>'
    + '<button class="cta" onclick="saveEditTodayFood()">Save</button>'
    + '<button class="cta ghostbtn" onclick="deleteEditingTodayFood()">Delete</button>';
}

function stepEditTodayFood(delta){
  if(!editTodayFoodCtx) return;
  editTodayFoodCtx.grams = Math.max(1, Math.min(2000, Math.round(editTodayFoodCtx.grams + delta)));
  document.getElementById('sheetBody').innerHTML = buildEditTodayFoodSheet();
}

function saveEditTodayFood(){
  if(!editTodayFoodCtx) return;
  const arr = getDayLog(todayISO())[currentProf];
  const keepIndex = editTodayFoodCtx.indices[0];
  const base = arr[keepIndex];
  if(!base) return;
  const nut = roundedNutritionTotals(foodMacros(editTodayFoodCtx.ref, editTodayFoodCtx.grams));
  base.grams = editTodayFoodCtx.grams;
  base.kcal = nut.kcal; base.protein = nut.protein; base.carbs = nut.carbs; base.fat = nut.fat; base.satFat = nut.satFat; base.fiber = nut.fiber; base.sugars = nut.sugars; base.freeSugars = nut.freeSugars; base.u = Date.now();
  editTodayFoodCtx.indices.slice(1).sort(function(a, b){ return b - a; }).forEach(function(i){ removeLogEntryAt(todayISO(), currentProf, i); });
  editTodayFoodCtx = null;
  refreshAfterLogChange();
  closeSheet();
  toast('✓ Updated item');
}

function deleteEditingTodayFood(){
  if(!editTodayFoodCtx) return;
  editTodayFoodCtx.indices.slice().sort(function(a, b){ return b - a; }).forEach(function(i){ removeLogEntryAt(todayISO(), currentProf, i); });
  editTodayFoodCtx = null;
  refreshAfterLogChange();
  closeSheet();
  toast('✕ Removed item');
}

// FIX 2 (feedback): one refresh funnel for every undo/remove — everything below derives
// from logHistory, so this is all that's needed for full parity across Today (ring/
// macros/fat line), Log (cards, pill, "Today so far") and Insights (which repaints from
// logHistory on next visit via go()).
function refreshAfterLogChange(){
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderLogPlan(); // rebuilds cards + replays statuses, then updates pill + "Today so far"
  renderTodayRecords();
  renderBeverageCounts();
  if(currentLogDateISO() === todayISO()) renderTodayCardActions(); // keep Today cards in sync only when editing today
  // task C1 fix: the Week screen's day rows/totals also derive from logHistory (same as
  // everything above), but previously only weekLogConfirm/weekLogSkip/weekLogUndo re-painted
  // Week themselves after this funnel — every OTHER caller (quick-add edit/delete:
  // saveEditTodayFood/deleteTodayRecordGroup/removeTodayEntry/deleteEditingTodayFood, plus
  // undoLogSlot/undoRecipeEatenSlot) left Week stale until the next unrelated repaint.
  // Centralizing the repaint here is the single funnel this function's own doc comment
  // promises — those three callers' now-redundant explicit repaint calls were removed.
  renderWeek();
  persist();
}

/* ---------------- FIX 1 (feedback): Confirm/Skip directly on the Today cards ----------------
   Owner: "lo skip si vede solo se clicco su '+', ma non in 'today'" — the four Today cards
   only opened the recipe before. This paints a compact action row into each card, driven
   by the EXACT SAME funnel the Log screen uses (logConfirm/logSkip/undoLogSlot,
   slotLogStatus — logHistory is the one source of truth), so Today and Log can never
   disagree: whichever screen you tap on, both re-derive from the same state.
   Re-derives all four slots fresh from slotLogStatus() every call (cheap — 4 lookups), so
   it's safe to call after ANY log-affecting action regardless of which surface triggered
   it (Today tap, Log tap, Undo, swap, profile switch, rebalance…) without tracking which
   slot changed. */
const TODAY_CARD_ACTION_EL = {breakfast: 'taBreakfast', lunch: 'taLunch', dinner: 'taDinner', snack: 'taSnack'};

function renderTodayCardActions(){
  SLOT_ORDER.forEach(function(slot){
    const wrap = document.getElementById(TODAY_CARD_ACTION_EL[slot]);
    if(!wrap) return;
    const status = slotLogStatus(todayISO(), currentProf, slot);
    const label = SLOT_LABEL[slot] || slot;
    // USER FEEDBACK item 3: the only path to removing an extra is this add button, which
    // read as pure "add" — once the meal already has extras, relabel it "Edit" so removal
    // is discoverable without adding a new button.
    const hasExtras = todaySlotView(slot).extras.length > 0;
    const addLabel = hasExtras ? '✎ Edit' : '＋ Add';
    const addAria = (hasExtras ? 'Edit ' : 'Add to ') + label;
    if(status === 'confirmed'){
      wrap.innerHTML = '<div class="tag-row"><span class="confirmed-tag">✓ Logged</span>'
        + '<span class="tag-controls"><button class="tag-undo" onclick="event.stopPropagation();openSwap(\''+slot+'\',null)">↔ Swap</button>'
        + '<button class="tag-undo" aria-label="'+addAria+'" onclick="event.stopPropagation();openAddMealRecipeSheet(\''+slot+'\')">'+addLabel+'</button>'
        + '<button class="tag-undo" onclick="event.stopPropagation();undoLogSlot(\''+slot+'\')">↺ Undo</button></span></div>';
    } else if(status === 'skipped'){
      wrap.innerHTML = '<div class="tag-row"><span class="skipped-tag">Skipped for today</span>'
        + '<button class="tag-undo" onclick="event.stopPropagation();undoLogSlot(\''+slot+'\')">↺ Undo</button></div>';
    } else {
      wrap.innerHTML = '<div class="ta-actions">'
        + '<button class="ta-btn ta-confirm" aria-label="Confirm '+label+'" onclick="event.stopPropagation();logConfirm(\''+slot+'\')">✓</button>'
        + '<button class="ta-btn ta-swap" aria-label="Swap '+label+'" onclick="event.stopPropagation();openSwap(\''+slot+'\',null)">↔</button>'
        + '<button class="ta-btn" aria-label="'+addAria+'" onclick="event.stopPropagation();openAddMealRecipeSheet(\''+slot+'\')">'+(hasExtras ? '✎' : '＋')+'</button>'
        + '<button class="ta-btn ta-skip" aria-label="Skip '+label+'" onclick="event.stopPropagation();logSkip(\''+slot+'\')">✕</button>'
        + '</div>';
    }
  });
}

// FIX 2a/2b (feedback): "Undo" on a confirmed or skipped Log card — clears the slot's
// plan entry / skipped flag (state.js:removeLoggedSlot), which restores the card's
// Confirm/Swap/Skip actions on the renderLogPlan() rebuild.
function undoLogSlot(slot){
  const status = slotLogStatus(currentLogDateISO(), currentProf, slot);
  if(!status) return;
  removeLoggedSlot(currentLogDateISO(), currentProf, slot);
  refreshAfterLogChange();
  toast(status === 'confirmed'
    ? '↺ Un-logged ' + (TITLES[slot] || SLOT_LABEL[slot]) + ' — confirm it again anytime'
    : '↺ ' + SLOT_LABEL[slot] + ' un-skipped');
}

// FIX 2c (feedback): the "Today so far" ✕ — removes one specific entry from today's
// logHistory. For a plan entry this also restores the matching card's actions (the card
// state is re-derived from slotLogStatus on the renderLogPlan() rebuild, same path as
// undoLogSlot — the two stay consistent by construction).
function removeTodayEntry(index){
  const removed = removeLogEntryAt(currentLogDateISO(), currentProf, index);
  if(!removed) return;
  let name = 'entry';
  if(removed.kind === 'plan'){
    const r = RECIPES_DB[removed.ref];
    name = r ? r.title : 'meal';
  } else {
    const f = FOODS[removed.ref];
    name = f ? f.name : 'food';
  }
  refreshAfterLogChange();
  toast('✕ Removed ' + name + ' (−' + removed.kcal + ' kcal)');
}

// `silent` is used only by restoreTodayLog() (app.js) replaying a persisted
// confirm/skip at boot, so reload doesn't re-fire the toast or re-log the entry (it's
// already in logHistory) for something the user already actioned in a previous session.
// FIX 2a/2b (feedback): the confirmed/skipped tag is now a ROW — the status text plus an
// "Undo" ghost button (44px tap target, css .tag-undo) that reverses the action via
// undoLogSlot(). Shared by logConfirm and logSkip below.
function appendTagRow(card, slot, tagClass, tagText){
  const actions = card.querySelector('.logactions'); if(actions) actions.remove();
  const info = card.querySelector('.info');
  const row = document.createElement('div');
  row.className = 'tag-row';
  const dateISO = currentLogDateISO();
  const correctionBtns = tagClass === 'confirmed-tag'
    ? '<button class="tag-undo" onclick="openLogSwap(\''+slot+'\',\'log-'+slot+'\')">↔ Swap</button>'
      + '<button class="tag-undo" onclick="openAddMealRecipeSheet(\''+slot+'\',\''+jsAttr(dateISO)+'\')">✎ Edit</button>'
    : '';
  row.innerHTML = '<span class="'+tagClass+'">'+tagText+'</span>'
    + '<span class="tag-controls">' + correctionBtns + '<button class="tag-undo" onclick="undoLogSlot(\''+slot+'\')">↺ Undo</button></span>';
  info.appendChild(row);
}

function logConfirm(key, silent){
  const card = document.getElementById('log-' + key);
  if(!card || card.classList.contains('done') || card.classList.contains('skipped')) return;
  card.classList.add('done');
  appendTagRow(card, key, 'confirmed-tag', silent ? '✓ Logged · earlier today' : '✓ Logged · just now');

  if(!silent){
    const v = (logMenu || computeMenuForDate(currentLogDateISO(), currentProf))[key];
    logPlanEntry(currentLogDateISO(), currentProf, key, v.recipeId, v.portion, v.components);
    toast('✓ Logged to ' + logDateLabel().toLowerCase());
  }

  // Task D1: Today ring/macros/good-sat-fat line and the "Today so far" list all derive
  // from logHistory — refresh them on every confirm (live tap or silent replay alike).
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  updateLogTotalPill();
  renderTodaySoFar();
  renderTodayRecords();
  if(currentLogDateISO() === todayISO()) renderTodayCardActions(); // mirror the confirm onto Today cards only for today
  persist();
}

function logSkip(key, silent){
  const card = document.getElementById('log-' + key);
  if(!card || card.classList.contains('done') || card.classList.contains('skipped')) return;
  card.classList.add('skipped');
  appendTagRow(card, key, 'skipped-tag', 'Skipped for ' + logDateLabel().toLowerCase());
  if(!silent) toast('Skipped — your plan stays balanced');

  markSlotSkipped(currentLogDateISO(), currentProf, key);
  if(currentLogDateISO() === todayISO()) renderTodayCardActions(); // mirror the skip onto Today cards only for today
  persist();
}

// Builds the four "Today's plan" cards on the Log screen from the active menu (today's
// row of weekPlan for the current person — kcal/protein are portion-scaled computed
// values). Re-running this rebuilds the cards fresh, then replays today's persisted
// confirm/skip status back onto them (restoreTodayLog, app.js) so confirms survive
// profile switches and plan re-renders within the same day.
// FIX 1 (feedback): breakfast is a normal meal now — same Confirm/Swap/Skip actions as
// lunch/dinner/snack, nothing pre-logged. All four slots go through the same
// buildLogSlotCard() path (the old breakfast-only "always done" branch is gone).
function renderLogPlan(){
  logMenu = computeMenuForDate(currentLogDateISO(), currentProf);
  const title = document.getElementById('logPlanTitle'); if(title) title.textContent = logDateLabel() + "'s plan";
  const soFar = document.getElementById('logSoFarTitle'); if(soFar) soFar.textContent = logDateLabel() + ' so far';
  const coffee = document.getElementById('coffeeCountTitle'); if(coffee) coffee.textContent = 'Coffee ' + logDateLabel().toLowerCase();
  SLOT_ORDER.forEach(function(slot){
    const v = logSlotView(slot);
    buildLogSlotCard(slot, v.recipe.emoji, mealTitleWithExtras(v), v.kcal, SLOT_LABEL[slot] + ' · ' + macroSummaryFromTotals(v), v.portion);
  });

  updateLogTotalPill();
  renderTodaySoFar();
  renderTodayRecords();
  renderBeverageCounts();

  if(typeof restoreTodayLog === 'function') restoreTodayLog();
}

function buildLogSlotCard(slot, emoji, title, kcal, desc, portionOverride){
  EMOJI[slot] = emoji; TITLES[slot] = title; LOGKCAL[slot] = kcal;
  const card = document.getElementById('log-' + slot);
  card.className = 'card meal';
  card.style.cursor = 'default';
  // Servings-eaten stepper (FEATURE: recipe servings) — the plan entry's portion is
  // "servings of the recipe", user-adjustable before confirming.
  const portion = (typeof portionOverride === 'number') ? portionOverride : ((activeMenu && activeMenu[slot]) ? activeMenu[slot].portion : 1);
  const dateISO = currentLogDateISO();
  const canEditSelectedDate = dateISO <= todayISO();
  const swapAction = canEditSelectedDate ? '<button class="la-swap" onclick="openLogSwap(\''+slot+'\',\'log-'+slot+'\')">Swap</button>' : '';
  // USER FEEDBACK item 3: relabel to "Edit" once the meal has extras, same as the Today
  // card's add button — the only path to removing an extra, so it shouldn't read as "add".
  const hasExtras = logSlotView(slot).extras.length > 0;
  const addAction = canEditSelectedDate ? ('<button class="la-swap" aria-label="'+(hasExtras ? 'Edit ' : 'Add to ')+(SLOT_LABEL[slot] || slot)+'" onclick="openAddMealRecipeSheet(\''+slot+'\',\''+jsAttr(dateISO)+'\')">'+(hasExtras ? '✎ Edit' : '+ Add')+'</button>') : '';
  const servingStepper = canEditSelectedDate ? '<span class="sv-stepper" style="margin-left:auto">'
    + '<button onclick="stepMealServings(\''+slot+'\',-0.5,\''+jsAttr(dateISO)+'\')" aria-label="Fewer servings">-</button>'
    + '<span class="sv-val">'+portion+'x</span>'
    + '<button onclick="stepMealServings(\''+slot+'\',0.5,\''+jsAttr(dateISO)+'\')" aria-label="More servings">+</button>'
    + '</span>' : '';
  card.innerHTML = '<div class="thumb">'+emoji+'</div><div class="info">'
    + '<div class="row between"><span class="t">'+escapeHtml(title)+'</span><span class="kcal">'+kcal+'</span></div>'
    + '<div class="d">'+desc+'</div>'
    + '<div class="logactions">'
    + '<button class="la-confirm" onclick="logConfirm(\''+slot+'\')">Confirm</button>'
    + swapAction
    + addAction
    + '<button class="la-skip" onclick="logSkip(\''+slot+'\')">Skip</button>'
    + servingStepper
    + '</div></div>';
}

/* ---------------- shared-meals toggle + Today rendering ---------------- */
function loggedPlanEntryForSlot(dateISO, personKey, slot){
  const day = logHistory[dateISO];
  if(!day) return null;
  const arr = Array.isArray(day[personKey]) ? day[personKey] : [];
  for(let i = arr.length - 1; i >= 0; i--){
    const e = arr[i];
    if(e && e.kind === 'plan' && e.slot === slot) return e;
  }
  return null;
}

function displayedSlotViewForDate(dateISO, personKey, slot, planned){
  const logged = loggedPlanEntryForSlot(dateISO, personKey, slot);
  if(logged && RECIPES_DB[logged.ref]){
    const nut = roundedNutritionTotals(logEntryNutrition(logged));
    const loggedComponents = Array.isArray(logged.components) && logged.components.length ? logged.components : [{recipeId: logged.ref, portion: logged.portion}];
    return {
      recipeId: logged.ref,
      recipe: RECIPES_DB[logged.ref],
      opts: loggedComponents[0] && loggedComponents[0].opts,
      components: loggedComponents,
      extras: loggedComponents.slice(1),
      kcal: nut.kcal,
      protein: nut.protein,
      carbs: nut.carbs,
      fat: nut.fat,
      satFat: nut.satFat,
      fiber: nut.fiber,
      sugars: nut.sugars,
      freeSugars: nut.freeSugars,
      portion: (typeof logged.portion === 'number') ? logged.portion : 1,
      shared: planned ? !!planned.shared : false,
      logged: true
    };
  }
  const recipe = planned && RECIPES_DB[planned.recipeId];
  const nut = planned ? roundedNutritionTotals(planEntryNutrition(planned)) : null;
  const plannedComponents = planned ? planEntryComponents(planned) : [];
  return {
    recipeId: planned ? planned.recipeId : null,
    recipe: recipe,
    opts: plannedComponents[0] && plannedComponents[0].opts,
    components: plannedComponents,
    extras: plannedComponents.slice(1),
    kcal: nut ? nut.kcal : 0,
    protein: nut ? nut.protein : 0,
    carbs: nut ? nut.carbs : 0,
    fat: nut ? nut.fat : 0,
    satFat: nut ? nut.satFat : 0,
    fiber: nut ? nut.fiber : 0,
    sugars: nut ? nut.sugars : 0,
    freeSugars: nut ? nut.freeSugars : 0,
    portion: planned ? planned.portion : 1,
    shared: planned ? !!planned.shared : false,
    logged: false
  };
}

function todaySlotView(slot){
  return displayedSlotViewForDate(todayISO(), currentProf, slot, activeMenu && activeMenu[slot]);
}

function logSlotView(slot){
  const dateISO = currentLogDateISO();
  const menu = logMenu || computeMenuForDate(dateISO, currentProf);
  return displayedSlotViewForDate(dateISO, currentProf, slot, menu && menu[slot]);
}

function displayedTodayRecipeId(slot){
  const view = todaySlotView(slot);
  return view.recipeId;
}

// task D1: base title runs through recipeDisplayTitle(view.recipeId, view.opts) — appends
// the chosen variant's label(s) in parens for a recipe with optionGroups, unchanged for
// one without — so every Today/Week/pinned-routine card reading this (see call sites)
// shows the actual planned/logged variant, never just the bare recipe title.
function mealTitleWithExtras(view){
  if(!view || !view.recipe) return '';
  const extras = (view.extras || []).map(function(c){
    return componentTitle(c);
  }).filter(Boolean);
  return recipeDisplayTitle(view.recipeId, view.opts) + (extras.length ? ' + ' + extras.join(' + ') : '');
}

function logEntryTitleWithComponents(entry){
  if(!entry || entry.kind !== 'plan') return '';
  const parts = Array.isArray(entry.components) ? entry.components : [];
  const baseOpts = parts[0] && parts[0].opts;
  const base = RECIPES_DB[entry.ref] ? recipeDisplayTitle(entry.ref, baseOpts) : 'Meal';
  const extras = parts.slice(1).map(componentTitle).filter(Boolean);
  return base + (extras.length ? ' + ' + extras.join(' + ') : '');
}

function toggleShared(slot, el){
  SHARED[slot] = !SHARED[slot];
  el.classList.toggle('sel', SHARED[slot]);
  el.querySelector('.ck').textContent = SHARED[slot] ? '✓' : '';
  const sub = el.querySelector('.od');
  if(sub) sub.textContent = SHARED[slot] ? 'Shared' : 'Solo';
  toast(SHARED[slot]
    ? SLOT_LABEL[slot] + ' is now shared — one recipe, two portions'
    : SLOT_LABEL[slot] + ' is now solo — planned per person');
  // Shared-toggles are part of the plan signature, so the next ensureWeekPlan() (inside
  // renderTodayMeals -> computeActiveMenu) regenerates the week; refresh every surface.
  renderTogetherPills();
  renderLogPlan();
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderWeek();
  if(document.getElementById('recipe').classList.contains('active')) updateServings();
  persist();
}

function renderTogetherPills(){
  renderTodayMeals();
}

// Renders all four Today cards from the active menu — today's row of weekPlan for the
// current person (task C2). Kcal shown are the person's portion-scaled computed values.
// Belt-and-suspenders fallback for a slot whose planned/logged recipeId doesn't resolve
// in RECIPES_DB (a dangling reference should already be caught upstream by
// planner.js:planReferencesMissingRecipe + the mealRecipesValid guards in
// preserveLoggedSlots/preservePinnedSlots, but this keeps one bad slot from blanking the
// whole Today screen — renderWeek() already has the equivalent `if(!r) return ''` guard).
const MISSING_RECIPE_FALLBACK = {emoji: '❓', title: 'Meal unavailable'};

function renderTodayMeals(){
  activeMenu = computeActiveMenu();

  function tagsHtml(recipeId, slot, pillId){
    let html = recipeDisplayPills(recipeId).map(function(t){ return '<span class="pill'+(t[0]?' '+t[0]:'')+'">'+t[1]+'</span>'; }).join('');
    html += '<span class="pill together mini" id="'+pillId+'" style="display:'+(SHARED[slot]?'inline-flex':'none')+'">👥 Together</span>';
    return html;
  }

  const bfv = todaySlotView('breakfast'), bf = bfv.recipe || MISSING_RECIPE_FALLBACK;
  document.getElementById('bfEmoji').textContent = bf.emoji;
  document.getElementById('bfTitle').textContent = bfv.recipe ? mealTitleWithExtras(bfv) : bf.title;
  document.getElementById('bfKcal').textContent = bfv.kcal;
  document.getElementById('bfDesc').textContent = 'Breakfast · ' + macroSummaryFromTotals(bfv);
  document.getElementById('bfTags').innerHTML = tagsHtml(bfv.recipeId, 'breakfast', 'pillBreakfast');

  const luv = todaySlotView('lunch'), lu = luv.recipe || MISSING_RECIPE_FALLBACK;
  document.getElementById('lunchThumb').textContent = lu.emoji;
  document.getElementById('lunchTitle').textContent = luv.recipe ? mealTitleWithExtras(luv) : lu.title;
  document.getElementById('lunchKcal').textContent = luv.kcal;
  document.getElementById('lunchDesc').textContent = 'Lunch · ' + macroSummaryFromTotals(luv);
  document.getElementById('lunchTags').innerHTML = tagsHtml(luv.recipeId, 'lunch', 'pillLunch');

  const div_ = todaySlotView('dinner'), di = div_.recipe || MISSING_RECIPE_FALLBACK;
  document.getElementById('dinnerThumb').textContent = di.emoji;
  document.getElementById('dinnerTitle').textContent = div_.recipe ? mealTitleWithExtras(div_) : di.title;
  document.getElementById('dinnerKcal').textContent = div_.kcal;
  document.getElementById('dinnerDesc').textContent = 'Dinner · ' + macroSummaryFromTotals(div_);
  document.getElementById('dinnerTags').innerHTML = tagsHtml(div_.recipeId, 'dinner', 'pillDinner');

  const snv = todaySlotView('snack'), sn = snv.recipe || MISSING_RECIPE_FALLBACK;
  document.getElementById('snackThumbEl').textContent = sn.emoji;
  document.getElementById('snackTitleEl').textContent = snv.recipe ? mealTitleWithExtras(snv) : sn.title;
  document.getElementById('snackKcalEl').textContent = snv.kcal;
  document.getElementById('snackDescEl').textContent = 'Snack · ' + macroSummaryFromTotals(snv);
  document.getElementById('snackTags').innerHTML = tagsHtml(snv.recipeId, 'snack', 'pillSnack');

  renderTodayCardActions(); // FIX 1: paint each card's Confirm/Skip or Logged/Skipped+Undo row
  renderTodayRecords();
}

/* ---------------- editable basics ---------------- */
// Renders the Basics section for the current profile: sex segments, DOB + computed age,
// height/weight steppers, activity options, and the daily-target row with its
// computed/custom state, restore action and transparent formula line.
function renderBasics(){
  const p = PROF[currentProf];
  document.getElementById('sexBtnF').classList.toggle('on', p.sex === 'female');
  document.getElementById('sexBtnM').classList.toggle('on', p.sex === 'male');
  document.getElementById('pfDob').textContent = 'Born ' + MONTHS[p.dobM-1] + ' ' + p.dobY + ' · ' + ageOf(p);
  document.getElementById('dobMVal').textContent = MONTHS[p.dobM-1];
  document.getElementById('dobYVal').textContent = p.dobY;
  document.getElementById('hVal').value = p.heightCm;
  document.getElementById('wVal').value = p.weightKg;
  document.getElementById('actOpts').innerHTML = ACTIVITY_LEVELS.map(function(a, i){
    const sel = p.activity === a.f;
    return '<div class="opt'+(sel ? ' sel' : '')+'" style="margin-top:'+(i===0?'6':'9')+'px" onclick="setActivity('+i+')">'
      + '<div class="ck">'+(sel ? '✓' : '')+'</div>'
      + '<div><div class="ot">'+a.t+'</div><div class="od">'+a.d+'</div></div></div>';
  }).join('');
  // daily target row
  document.getElementById('pfCals').value = p.calGoalNum;
  const isCustom = p.calCustom !== null;
  const chip = document.getElementById('calChip');
  chip.textContent = isCustom ? 'custom' : '✓ computed';
  chip.className = isCustom ? 'pill gold' : 'chip-computed';
  const btn = document.getElementById('calRestoreBtn');
  btn.style.display = isCustom ? 'inline-flex' : 'none';
  btn.textContent = '↺ Restore recommended (' + fmtKcal(p.recCal) + ')';
  // task B1: p.goalAdj is 0 when the person's calorie-affecting goal (fatLoss/
  // muscleGain) is off — drop the "+/- N <goalName>" clause entirely rather than
  // print "+ 0 maintenance", so the line reads as plain maintenance-based copy.
  document.getElementById('calFormula').textContent =
    'BMR ' + fmtKcal(Math.round(bmrOf(p))) + ' × ' + p.activity + ' activity'
    + (p.goalAdj !== 0 ? ' ' + (p.goalAdj >= 0 ? '+ ' : '− ') + Math.abs(p.goalAdj) + ' ' + p.goalName : ' (at maintenance)')
    + ' = ' + fmtKcal(p.recCal) + ' kcal recommended';
  document.getElementById('calNote').textContent = p.calNote || '';
}

// One funnel for every body-stat edit: refresh the recommendation, keep any manual
// override untouched (non-destructive nudge instead), cascade through applyProf, and
// say exactly what changed.
function afterBasicsChange(label){
  const p = PROF[currentProf];
  const oldGoal = p.calGoalNum;
  const newRec = recommendedCal(p);
  if(p.calCustom !== null && p.calCustom !== newRec){
    p.calNote = 'Mesa now recommends ' + fmtKcal(newRec) + ' kcal — your custom ' + fmtKcal(p.calCustom) + ' stays until you tap restore.';
  } else {
    p.calNote = '';
  }
  applyProf(currentProf);
  if(p.calCustom !== null){
    toast(label + ' — Mesa now recommends ' + fmtKcal(newRec) + ' kcal');
  } else if(p.calGoalNum !== oldGoal){
    toast(label + ' → new target ' + fmtKcal(p.calGoalNum) + ' kcal');
  } else {
    toast(label + ' — target unchanged at ' + fmtKcal(p.calGoalNum) + ' kcal');
  }
}

function setSex(s){
  const p = PROF[currentProf];
  if(p.sex === s) return;
  p.sex = s;
  afterBasicsChange('Sex ' + (s === 'female' ? 'female' : 'male'));
}

function stepDob(part, delta){
  const p = PROF[currentProf];
  if(part === 'm'){
    p.dobM += delta;
    if(p.dobM < 1){ p.dobM = 12; p.dobY--; }
    if(p.dobM > 12){ p.dobM = 1; p.dobY++; }
  } else {
    p.dobY += delta;
  }
  const maxY = new Date().getFullYear() - 16; // Mesa plans for adults
  p.dobY = Math.min(maxY, Math.max(1930, p.dobY));
  afterBasicsChange('Born ' + MONTHS[p.dobM-1] + ' ' + p.dobY + ' (age ' + ageOf(p) + ')');
}

// Bounds widened to match the typed-input clamp (FIX 2 brief: height 120–230, weight
// 30–250) so stepping and typing can never land in a state the other path disagrees with.
function stepBody(field, delta){
  const p = PROF[currentProf];
  if(field === 'height'){
    p.heightCm = Math.min(230, Math.max(120, p.heightCm + delta));
    afterBasicsChange('Height ' + p.heightCm + ' cm');
  } else {
    p.weightKg = Math.min(250, Math.max(30, +(p.weightKg + delta).toFixed(1)));
    afterBasicsChange('Weight ' + p.weightKg + ' kg');
  }
}

// FIX 2 (feedback): height/weight typeable directly. Invalid text (empty, "abc") or a
// negative number reverts to the previous value with a toast; a parseable value clamps to
// the same band stepBody() uses (height integer 120–230cm, weight 1-decimal 30–250kg) —
// so "type 64,5" lands on exactly the same weightKg a stepper run would, and every
// downstream recompute (BMR, target calories, macro grams) fires the same way either way.
function commitHeight(raw){
  const p = PROF[currentProf];
  const n = parseDecimalInput(raw);
  if(n === null || n < 0){ toast('Enter a height in cm, e.g. 168'); renderBasics(); return; }
  p.heightCm = Math.round(Math.min(230, Math.max(120, n)));
  afterBasicsChange('Height ' + p.heightCm + ' cm');
}
function commitWeight(raw){
  const p = PROF[currentProf];
  const n = parseDecimalInput(raw);
  if(n === null || n < 0){ toast('Enter a weight in kg, e.g. 64.5'); renderBasics(); return; }
  p.weightKg = +(Math.min(250, Math.max(30, n))).toFixed(1);
  afterBasicsChange('Weight ' + p.weightKg + ' kg');
}

function setActivity(i){
  const p = PROF[currentProf];
  const a = ACTIVITY_LEVELS[i];
  if(p.activity === a.f) return;
  p.activity = a.f;
  afterBasicsChange(a.t + ' (×' + a.f + ')');
}

// Manual calorie override, ±50 per tap, clamped to a sane band with a friendly note.
function stepCal(delta){
  const p = PROF[currentProf];
  const band = calBand(p);
  let next = p.calGoalNum + delta;
  if(next < band[0]){
    next = band[0];
    p.calNote = 'Held at ' + fmtKcal(band[0]) + ' — Mesa won’t plan below ~110% of your BMR. Gentle beats drastic.';
  } else if(next > band[1]){
    next = band[1];
    p.calNote = 'Held at ' + fmtKcal(band[1]) + ' — beyond maintenance + 600 kcal adds fat faster than muscle.';
  } else {
    p.calNote = '';
  }
  p.calCustom = (next === p.recCal) ? null : next;
  applyProf(currentProf);
  if(p.calCustom === null) toast('✓ Back on Mesa’s recommendation');
}

// FIX 2 (feedback): daily calorie target typeable directly, reusing stepCal's exact
// calBand clamp + cap-note copy (owner brief: "calories keep the calBand clamp + existing
// cap-note") so typing "2000" and stepping to 2000 in ±50 taps land on the identical
// p.calCustom / p.calNote state and produce the identical toast.
function commitCalories(raw){
  const p = PROF[currentProf];
  const n = parseDecimalInput(raw);
  if(n === null || n < 0){ toast('Enter a calorie target, e.g. 2000'); renderBasics(); return; }
  const band = calBand(p);
  let next = Math.round(n);
  if(next < band[0]){
    next = band[0];
    p.calNote = 'Held at ' + fmtKcal(band[0]) + ' — Mesa won’t plan below ~110% of your BMR. Gentle beats drastic.';
  } else if(next > band[1]){
    next = band[1];
    p.calNote = 'Held at ' + fmtKcal(band[1]) + ' — beyond maintenance + 600 kcal adds fat faster than muscle.';
  } else {
    p.calNote = '';
  }
  p.calCustom = (next === p.recCal) ? null : next;
  applyProf(currentProf);
  if(p.calCustom === null) toast('✓ Back on Mesa’s recommendation');
}

function restoreCal(){
  const p = PROF[currentProf];
  p.calCustom = null;
  p.calNote = '';
  applyProf(currentProf);
  toast('↺ Back to recommended ' + fmtKcal(p.recCal) + ' kcal');
}

// Steps one macro by ±5%, then pulls the compensating amount from whichever of the
// other two is currently larger — so the three always sum to 100 and the effect on a
// second macro is predictable (never split across both).
function stepSplit(macro, delta){
  const p = PROF[currentProf];
  const [lo, hi] = SPLIT_BOUNDS[macro];
  const prop = SPLIT_PROP[macro];
  const old = p[prop];
  let next = old + delta;
  let note = null;
  if(next < lo){ next = lo; note = splitGuardNote(macro, 'min'); }
  else if(next > hi){ next = hi; note = splitGuardNote(macro, 'max'); }
  const actualDelta = next - old;
  if(actualDelta === 0){
    p.splitNote = note || '';
    renderSplitEditor();
    return;
  }
  p[prop] = next;

  const others = ['P','C','F'].filter(function(k){ return k !== macro; });
  const big = p[SPLIT_PROP[others[0]]] >= p[SPLIT_PROP[others[1]]] ? others[0] : others[1];
  const small = big === others[0] ? others[1] : others[0];
  const compDelta = -actualDelta;
  const [bLo, bHi] = SPLIT_BOUNDS[big];
  const bigWanted = p[SPLIT_PROP[big]] + compDelta;
  const bigFinal = Math.max(bLo, Math.min(bHi, bigWanted));
  p[SPLIT_PROP[big]] = bigFinal;
  const leftover = bigWanted - bigFinal;
  if(leftover !== 0){
    const [sLo, sHi] = SPLIT_BOUNDS[small];
    const smallWanted = p[SPLIT_PROP[small]] + leftover;
    const smallFinal = Math.max(sLo, Math.min(sHi, smallWanted));
    p[SPLIT_PROP[small]] = smallFinal;
    if(!note && smallFinal !== smallWanted) note = splitGuardNote(small, leftover > 0 ? 'max' : 'min');
  }
  if(!note && bigFinal !== bigWanted) note = splitGuardNote(big, compDelta > 0 ? 'max' : 'min');
  p.splitNote = note || '';

  applyProf(currentProf);
  scheduleMenuRebuild();
}

function applyPreset(name){
  const p = PROF[currentProf];
  let target;
  if(name === 'default') target = p.defaultSplit;
  else if(name === 'highprotein') target = {P:35, C:35, F:30};
  else if(name === 'lowcarb') target = {P:30, C:30, F:40};
  else return;
  p.kP = target.P; p.kC = target.C; p.kF = target.F;
  p.splitNote = '';
  applyProf(currentProf);
  scheduleMenuRebuild();
}

function renderSplitEditor(){
  const p = PROF[currentProf];
  const kcal = p.calGoalNum;
  const gP = Math.round(kcal * p.kP / 100 / 4);
  const gC = Math.round(kcal * p.kC / 100 / 4);
  const gF = Math.round(kcal * p.kF / 100 / 9);
  document.getElementById('splitPVal').textContent = p.kP + '% · ' + gP + 'g';
  document.getElementById('splitCVal').textContent = p.kC + '% · ' + gC + 'g';
  document.getElementById('splitFVal').textContent = p.kF + '% · ' + gF + 'g';

  const chips = document.querySelectorAll('#macroPresets .chip-preset');
  const matches = function(t){ return p.kP === t.P && p.kC === t.C && p.kF === t.F; };
  if(chips[0]) chips[0].classList.toggle('chipsel', matches(p.defaultSplit));
  if(chips[1]) chips[1].classList.toggle('chipsel', matches({P:35,C:35,F:30}));
  if(chips[2]) chips[2].classList.toggle('chipsel', matches({P:30,C:30,F:40}));

  // Visible custom state: pill by the header + a restore hint, mirroring the calorie row.
  const customSplit = !matches(p.defaultSplit);
  const pill = document.getElementById('splitStatePill');
  if(pill) pill.style.display = customSplit ? 'inline-flex' : 'none';
  document.getElementById('splitNote').textContent = p.splitNote
    || (customSplit ? 'Custom split — “Mesa default” restores ' + p.defaultSplit.P + '/' + p.defaultSplit.C + '/' + p.defaultSplit.F + '.' : '');
}

/* ---------------- "Health goals" editor (task B1) ----------------
   Real per-profile checklist, replacing the 5 static checkboxes index.html used to show
   IDENTICALLY for both people (the bug: unchecking "Gentle fat loss" did nothing, and
   Andrea saw a fat-loss goal he doesn't have). Renders GOAL_DEFS[currentProf] (state.js
   — single copy source) against PROF[currentProf].goals; titles/descriptions are fixed
   developer copy (not user input), same trust level as ACTIVITY_LEVELS/renderBasics
   above, so no escapeHtml needed. Mirrors renderAvoidEditor()'s structure: one function,
   called from applyProf(), full re-render on every toggle (cheap — five rows). */
function renderGoalsEditor(){
  const key = currentProf;
  const p = PROF[key];
  const el = document.getElementById('goalsList');
  if(!el) return; // Profile screen markup not present (shouldn't happen, but don't crash)
  const defs = GOAL_DEFS[key] || [];
  el.innerHTML = defs.map(function(g){
    const on = !!p.goals[g.key];
    return '<div class="opt' + (on ? ' sel' : '') + '" onclick="toggleGoal(\'' + key + '\',\'' + g.key + '\',this)">'
      + '<div class="ck">' + (on ? '✓' : '') + '</div>'
      + '<div><div class="ot">' + g.title + '</div><div class="od">' + g.desc + '</div></div></div>';
  }).join('');
}

// Toggles one goal on the given profile (task B1 fix: was cosmetic tog(this), no state,
// no recompute, no persistence). Follows the same funnel as addAvoid/removeAvoid below
// and afterBasicsChange() above: mutate -> recomputeProf -> applyProf (re-derives every
// display number, including recCal/calGoalNum, AND re-persists AND re-runs
// ensureWeekPlan() — future plan days re-target off the new calorie goal exactly like a
// weight edit does, since calGoalNum is part of computePlanSignature(); logged/past
// slots stay protected by planner.js's existing preserveLoggedSlots() guard regardless).
// Deliberately does NOT call scheduleMenuRebuild(): that funnel is specific to macro-
// split changes (it re-derives householdStyle from kP/kC/kF and shows a "menu rebuilt
// for x/y/z%" toast), neither of which applies here — a goal toggle never touches the
// split, and applyProf()'s own ensureWeekPlan() call already re-targets the plan.
function toggleGoal(profKey, goalKey, el){
  const p = PROF[profKey];
  if(!p || !p.goals || !(goalKey in p.goals)) return;
  const before = p.calGoalNum;
  p.goals[goalKey] = !p.goals[goalKey];
  recomputeProf(profKey);
  applyProf(profKey);
  const def = (GOAL_DEFS[profKey] || []).find(function(g){ return g.key === goalKey; });
  const label = def ? def.title : goalKey;
  const on = p.goals[goalKey];
  const calChanged = p.calGoalNum !== before;
  toast(label + (on ? ' is back on' : ' turned off') + (calChanged ? ' — target now ' + p.calGoal + ' kcal' : ''));
}

/* ---------------- "Foods to avoid" editor (task C3 item 2) ---------------- */
// Real editor over PROF[currentProf].avoid (state.js), replacing the three static demo
// pills. Renders removable pills from the persisted array, plus a picker of the
// remaining AVOID_KEYS (state.js) behind the "＋ Add" field — free-text isn't supported
// in MVP (cap-note in index.html says so), so there's nothing to validate/parse here.
function renderAvoidEditor(){
  const p = PROF[currentProf];
  const pillsEl = document.getElementById('avoidPills');
  if(!pillsEl) return; // Profile screen markup not present (shouldn't happen, but don't crash)
  const list = (p.avoid || []).slice().sort();
  pillsEl.innerHTML = list.length
    ? list.map(function(k){ return '<span class="pill ghost" onclick="removeAvoid(\''+k+'\')">'+avoidLabel(k)+' ✕</span>'; }).join('')
    : '<span class="sub" style="margin:0">Nothing avoided right now — tap ＋ Add to pick from lactose, gluten, shellfish, nuts, raw onion or spicy.</span>';

  const chooserEl = document.getElementById('avoidChooser');
  if(chooserEl){
    const remaining = AVOID_KEYS.filter(function(k){ return list.indexOf(k) === -1; });
    chooserEl.innerHTML = remaining.length
      ? remaining.map(function(k){ return '<span class="pill" onclick="addAvoid(\''+k+'\')">＋ '+avoidLabel(k)+'</span>'; }).join('')
      : '<span class="sub" style="margin:0">Every supported item is already avoided.</span>';
  }
}

function toggleAvoidChooser(){
  const el = document.getElementById('avoidChooser');
  if(!el) return;
  el.style.display = (el.style.display === 'flex') ? 'none' : 'flex';
}

// Adds/removes one avoid key on the CURRENT profile, then runs the exact same funnel
// every other profile-mutating action uses: applyProf() re-derives everything (including
// ensureWeekPlan(), since the avoid-list is part of the plan signature — task C2) and
// persists. The toast's recipe count is a simple DB-wide fact (countRecipesWithAvoidKey,
// planner.js) — how many recipes carry this key at all — not a "how many now fit today's
// slot/style" figure, which would need re-deriving the whole candidate pool just to word
// a toast.
function addAvoid(key){
  const p = PROF[currentProf];
  p.avoid = p.avoid || [];
  if(p.avoid.indexOf(key) !== -1) return;
  p.avoid.push(key);
  const n = countRecipesWithAvoidKey(key);
  applyProf(currentProf);
  const chooserEl = document.getElementById('avoidChooser');
  if(chooserEl) chooserEl.style.display = 'none';
  toast(avoidLabel(key) + ' avoided — ' + n + (n === 1 ? ' recipe' : ' recipes') + ' fewer available to you');
}

function removeAvoid(key){
  const p = PROF[currentProf];
  const idx = (p.avoid || []).indexOf(key);
  if(idx === -1) return;
  p.avoid.splice(idx, 1);
  const n = countRecipesWithAvoidKey(key);
  applyProf(currentProf);
  toast(avoidLabel(key) + ' removed — ' + n + (n === 1 ? ' more recipe' : ' more recipes') + ' available to you');
}

// Debounced ~600ms after the last tap: reclassifies the plan style from the active
// profile's split, rebuilds the shared menu, and surfaces a toast + coach note.
let splitRebuildTimer = null;
function scheduleMenuRebuild(){
  clearTimeout(splitRebuildTimer);
  splitRebuildTimer = setTimeout(function(){
    const p = PROF[currentProf];
    householdStyle = styleOf(p);
    const bannerMsgs = {
      protein:{t:'Rebuilt for more protein 💪', d:'Rebuilt for your ' + p.kP + '/' + p.kC + '/' + p.kF + ' split — protein up, carbs trimmed. Same calories, same avoid-list.'},
      lowcarb:{t:'Rebuilt lower-carb 🥑', d:'Rebuilt for your ' + p.kP + '/' + p.kC + '/' + p.kF + ' split — carbs down, healthy fat up. Same calories, same avoid-list.'},
      balanced:{t:'Rebuilt for an even split 🥗', d:'Rebuilt for your ' + p.kP + '/' + p.kC + '/' + p.kF + ' split — an even mix across protein, carbs and fat. Same calories, same avoid-list.'}
    };
    const msg = bannerMsgs[householdStyle];
    p.coachOverrideT = msg.t; p.coachOverrideD = msg.d;
    applyProf(currentProf);
    toast('✓ Menu rebuilt for ' + p.kP + '/' + p.kC + '/' + p.kF);
  }, 600);
}

// The Today screen's ring + macro bars for the current profile — split out of applyProf
// so logConfirm/chooseSwap/applyRebalance can refresh consumed-so-far numbers without
// re-running the whole profile render cycle.
function refreshRingAndBars(){
  const p = PROF[currentProf];
  document.getElementById('calLeft').textContent=p.calLeft;
  document.getElementById('calGoal').textContent=p.calGoal;
  document.getElementById('mp').textContent=p.mp;
  document.getElementById('mc').textContent=p.mc;
  document.getElementById('mf').textContent=p.mf;
  document.getElementById('bp').style.width=p.bp;
  document.getElementById('bc').style.width=p.bc;
  document.getElementById('bff').style.width=p.bff;
  document.getElementById('calRing').style.strokeDashoffset=p.off;
  document.getElementById('fatSplit').textContent = '💚 ' + p.fatGood + 'g good fats · ' + p.fatSat + 'g sat.';
}

function applyProf(key){
  currentProf = key;
  const p=PROF[key];
  ensureWeekPlan();       // regenerate the plan first if its inputs changed (task C2)
  recomputeConsumed(key); // consumed-so-far from today's confirmed slots of the real plan
  recomputeProf(key);
  refreshRingAndBars();
  document.getElementById('goalTag').textContent=p.goalTag;
  const coachT = document.getElementById('coachT');
  const coachD = document.getElementById('coachD');
  if(coachT) coachT.textContent=p.coachOverrideT || p.coachT;
  if(coachD) coachD.textContent=p.coachOverrideD || p.coachD;
  document.getElementById('profAv').textContent=p.av;
  const topAv = document.getElementById('topProfAv');
  if(topAv) topAv.textContent = p.av;
  renderBasics();
  const pKcal = Math.round(p.calGoalNum * p.kP / 100);
  const cKcal = Math.round(p.calGoalNum * p.kC / 100);
  const fKcal = p.calGoalNum - pKcal - cKcal;
  document.getElementById('kcalProteinText').textContent = fmtKcal(pKcal) + ' kcal';
  document.getElementById('kcalCarbsText').textContent = fmtKcal(cKcal) + ' kcal';
  document.getElementById('kcalFatText').textContent = fmtKcal(fKcal) + ' kcal';
  document.getElementById('kcalProteinMeta').textContent = p.targetP + 'g · ' + p.kP + '%';
  document.getElementById('kcalCarbsMeta').textContent = p.targetC + 'g · ' + p.kC + '%';
  document.getElementById('kcalFatMeta').textContent = p.targetF + 'g · ' + p.kF + '%';
  document.getElementById('kcalSplitLegend').textContent = 'Target split for ' + p.calGoal + ' today';
  renderSplitEditor();
  renderGoalsEditor();  // task B1: real per-profile "Health goals" checklist
  renderAvoidEditor();  // task C3: "Foods to avoid" pills for whichever profile is now active
  if(typeof renderFoodLibraryCount === 'function') renderFoodLibraryCount(); // js/library.js: "N built-in · M yours"
  if(typeof renderCoupleSync === 'function') renderCoupleSync(); // js/sync.js (task S1): "Couple sync" section
  renderTodayMeals();
  renderLogPlan();
  renderWeek();
  if(typeof renderInsights === 'function') renderInsights(); // task D1: keep Insights in sync with whoever's now current
  updateRecipeWhy();     // task C3: re-personalize the why-box if the recipe screen is open
  renderRecipeEatenState(); // eaten/skipped is per-person (slotLogStatus keyed by currentProf) — re-derive on profile switch too
  renderRecipeMealStrip();
  syncServeHighlight();
  syncProfileToggle(key);
  persist();
}

// Keeps both "whose plan" segmented controls (top tabbar and Profile screen) in sync
// with currentProf — needed on top of the click handlers' own toggling because
// loadState() can restore a non-default currentProf before any click ever happens.
function syncProfileToggle(key){
  document.querySelectorAll('#profSeg button').forEach(function(b){ b.classList.toggle('on', b.dataset.prof === key); });
  const whoSeg = document.getElementById('profWhoSeg');
  if(whoSeg){
    const btns = whoSeg.querySelectorAll('button');
    if(btns[0]) btns[0].classList.toggle('on', key === 'elena');
    if(btns[1]) btns[1].classList.toggle('on', key === 'partner');
  }
}

// profile screen switch
function setProf(key, el){
  el.parentNode.querySelectorAll('button').forEach(x=>x.classList.remove('on'));
  el.classList.add('on'); applyProf(key);
  // sync top control
  document.querySelectorAll('#profSeg button').forEach(x=>x.classList.toggle('on', x.dataset.prof===key));
}

// T1: Profile jump-to-section chip bar (index.html #profileNav) — scrolls the target
// section's <h2> (class="jump-target", scroll-margin-top in mesa.css) to the top edge of
// the #profile scroll container, clear of the sticky bar. The bar itself is static markup
// (not re-painted per profile switch/render), so this only needs to track which chip is
// visually "on".
function jumpToProfileSection(id, el){
  const target = document.getElementById(id);
  const screen = document.getElementById('profile');
  const bar = document.getElementById('profileNav');
  // scrollIntoView() and scrollTo({behavior:'smooth'}) both no-op inside the absolutely-
  // positioned .screen scroller in iOS WebKit; only a direct scrollTop assignment moves it
  // reliably. target.offsetParent is #profile itself, so offsetTop already IS the scroll
  // offset — subtract the sticky bar height + a small gap so the section lands just under
  // the nav rather than hidden behind it. Instant (not animated): rAF-based tweening is
  // paused whenever the page is backgrounded, so a direct set is the dependable choice.
  if(target && screen){
    const offset = (bar ? bar.offsetHeight : 0) + 12;
    screen.scrollTop = Math.max(0, target.offsetTop - offset);
  }
  if(el && bar){
    bar.querySelectorAll('button').forEach(function(b){ b.classList.remove('on'); });
    el.classList.add('on');
  }
}

/* ===================================================================
   Insights screen (task D1 item 4) — paints planner.js:computeInsights()
   into the 4 sections: stat tiles, weekly band, 7-day bars, and the
   2 deterministic "what's working" call-outs. Below 2 total logged days
   every section instead shows the same friendly empty-state copy,
   styled with the app's existing card/tile classes (no new components).
   =================================================================== */
const INSIGHTS_EMPTY_NOTE = 'Log a few days to unlock this — Mesa needs at least 2 logged days to show real trends here.';

// task C1: the 5 nutrient-band rows, in fixed display order — each reuses the exact
// #insightsBarsCard 7-day .spark/.col bar pattern (empty state included), just at a
// shorter height (.spark.compact, css/mesa.css) so 5 rows fit in one card. Colors reuse
// the existing sage ('hi', in-band)/terra ('over')/terra-tint ('under') palette — no new
// design language, just two new modifier classes on the same .col element.
const NUTRIENT_BAND_ROWS = [
  {key: 'protein', label: 'Protein'},
  {key: 'carbs', label: 'Carbs'},
  {key: 'fat', label: 'Fat'},
  {key: 'fiber', label: 'Fiber'},
  {key: 'freeSugars', label: 'Free sugars'}
];

// Fiber/free-sugars are single-direction targets (floor / ceiling); protein/carbs/fat are
// a symmetric ±10% window — the label prefix communicates which, using the SAME target
// number computeInsights already derived (never re-typed here).
function nutrientBandTargetLabel(key, target){
  const g = Math.round(target);
  if(key === 'fiber') return '≥' + g + 'g/day';
  if(key === 'freeSugars') return '≤' + g + 'g/day';
  return '~' + g + 'g/day';
}

function nutrientBandRowHtml(row, days, target){
  const cols = days.map(function(d){
    if(!d.logged) return '<div class="col empty" style="height:14%" title="Not logged"><b>'+d.letter+'</b></div>';
    const value = d[row.key];
    const pct = target > 0 ? Math.max(6, Math.min(100, Math.round(value / target * 100))) : 100;
    const status = d.bands && d.bands[row.key];
    const cls = status === 'over' ? 'over' : (status === 'under' ? 'under' : 'hi');
    return '<div class="col '+cls+'" style="height:'+pct+'%" title="'+Math.round(value)+'g vs '+nutrientBandTargetLabel(row.key, target)+'"><b>'+d.letter+'</b></div>';
  }).join('');
  return '<div class="row between" style="margin-bottom:4px"><b style="font-size:13px">'+row.label+'</b><span class="pill ghost" style="font-size:10px">'+nutrientBandTargetLabel(row.key, target)+'</span></div>'
    + '<div class="spark compact">' + cols + '</div>';
}

function renderInsights(){
  const statWrap = document.getElementById('insightsStats');
  const bandsWrap = document.getElementById('insightsNutrientBands');
  const bandWrap = document.getElementById('insightsBandCard');
  const barsWrap = document.getElementById('insightsBarsCard');
  const workingWrap = document.getElementById('insightsWorking');
  if(!statWrap || !bandsWrap || !bandWrap || !barsWrap || !workingWrap) return; // Insights markup not present

  // FIX 3 (feedback): the coverage card lives at the top of Insights now — refresh its
  // chips/pill/note on every visit (plan-derived, so not gated on logged-day count).
  renderNutrientChips();
  // task C2 (2026-07-18): the "Tune next week" chip card is likewise plan-derived, not
  // log-derived — paint it unconditionally too, same reasoning as renderNutrientChips().
  renderTuningCard();

  const data = computeInsights(currentProf);

  if(!data.hasEnoughData){
    statWrap.innerHTML = '<div class="s" style="grid-column:1/-1"><div class="sl" style="font-size:13px;font-weight:700;color:var(--ink)">Stats</div><p class="sub" style="margin-top:6px">'+INSIGHTS_EMPTY_NOTE+'</p></div>';
    bandsWrap.innerHTML = '<div class="row between"><b style="font-size:14px">Nutrient bands</b></div><p class="sub" style="margin-top:6px">'+INSIGHTS_EMPTY_NOTE+'</p>';
    bandWrap.innerHTML = '<div class="row between"><b style="font-size:14px">Your weekly band</b></div><p class="sub" style="margin-top:6px">'+INSIGHTS_EMPTY_NOTE+'</p>';
    barsWrap.innerHTML = '<div class="row between" style="margin-bottom:6px"><b style="font-size:14px">Calories vs target</b></div><p class="sub">'+INSIGHTS_EMPTY_NOTE+'</p>';
    workingWrap.innerHTML = '<p class="sub" style="margin:0">'+INSIGHTS_EMPTY_NOTE+'</p>';
    return;
  }

  // task C1: 5-row nutrient bands (protein/carbs/fat/fiber/free sugars vs each metric's
  // own band) — data.bandTargets/data.days[i].bands come straight from computeInsights, so
  // this is pure paint, no re-derivation of any threshold.
  bandsWrap.innerHTML = '<div class="row between" style="margin-bottom:10px"><b style="font-size:14px">Nutrient bands <span class="chip-computed">✓ computed</span></b><span class="pill">last 7 days</span></div>'
    + NUTRIENT_BAND_ROWS.map(function(row){ return nutrientBandRowHtml(row, data.days, data.bandTargets[row.key]); }).join('');

  // stat tiles
  const tiles = [
    {sv: Math.round(data.avgProtein) + 'g', sl: 'Avg protein/day (7d)', good: data.avgProtein >= data.targetProtein, goodNote: '▲ on target', badNote: '▼ below target'},
    {sv: Math.round(data.avgFiber) + 'g', sl: 'Avg fiber/day (7d)', good: data.avgFiber >= 25, goodNote: '▲ heart-smart', badNote: '▼ below 25g guide'},
    {sv: Math.round(data.pctUnsaturated) + '%', sl: 'Fats unsaturated (7d)', good: data.pctUnsaturated >= 67, goodNote: '▲ heart & skin smart', badNote: '▼ watch saturated fat'},
    {sv: data.daysLoggedCount + '/7', sl: 'Days logged this week', good: data.daysLoggedCount >= 5, goodNote: '▲ steady', badNote: '▼ log a few more days'}
  ];
  statWrap.innerHTML = tiles.map(function(t){
    return '<div class="s"><div class="sv">'+t.sv+'</div><div class="sl">'+t.sl+'</div><div class="sd '+(t.good ? 'up' : 'dn2')+'">'+(t.good ? t.goodNote : t.badNote)+'</div></div>';
  }).join('');

  // weekly band
  bandWrap.innerHTML = '<div class="row between"><b style="font-size:14px">Your weekly band <span class="chip-computed">✓ computed</span></b></div>'
    + '<p class="sub" style="margin-top:6px">'+data.inBandCount+' of 7 days landed inside your target range this week (kcal within ±10% of that day\'s target) — no streak to lose, just a gentle rhythm.</p>'
    + '<div class="band">' + data.days.map(function(d){
        const dotClass = !d.logged ? '' : (d.inBand ? 'filled' : 'soft');
        return '<div class="dwrap"><div class="dot '+dotClass+'"></div><div class="dl">'+d.letter+'</div></div>';
      }).join('') + '</div>';

  // 7-day bars — height is kcal as a % of that day's OWN target (capped 6-100%) so every
  // bar reads against the same "did I hit my target" scale; unlogged days get a distinct
  // pale/empty style (.spark .col.empty, css/mesa.css) so they don't read as "a bad day".
  barsWrap.innerHTML = '<div class="row between" style="margin-bottom:6px"><b style="font-size:14px">Calories vs target</b><span class="pill">last 7 days</span></div>'
    + '<div class="spark">' + data.days.map(function(d){
        if(!d.logged) return '<div class="col empty" style="height:14%" title="Not logged"><b>'+d.letter+'</b></div>';
        const pct = d.target > 0 ? Math.max(6, Math.min(100, Math.round(d.kcal / d.target * 100))) : 100;
        return '<div class="col'+(d.inBand ? ' hi' : '')+'" style="height:'+pct+'%" title="'+d.kcal+' kcal vs '+d.target+' target"><b>'+d.letter+'</b></div>';
      }).join('') + '</div>';

  // what's working / watch this — exactly 2 deterministic call-outs (planner.js)
  workingWrap.innerHTML = data.callouts.map(function(c, i){
    const last = i === data.callouts.length - 1;
    const bg = c.good ? 'var(--sage-tint)' : 'var(--terra-tint)';
    return '<div class="logitem"'+(last ? ' style="border-bottom:0"' : '')+'><div class="li-i" style="background:'+bg+'">'+c.icon+'</div><div class="li-t">'+c.text+'</div></div>';
  }).join('');
}

/* ===================================================================
   "Tune next week" chip card (task C2, 2026-07-18) — replaces the fake Mesa-coach
   banner + toast-only button. Fixed vocabulary (NEXT_WEEK_TUNING_DEFS, state.js), so the
   chips are built here but every onclick argument is a hardcoded constant — no user
   string ever reaches this markup. Same .pill.chip-preset/.chipsel look #macroPresets
   (index.html) already uses for a single-select chip row.
   =================================================================== */
function renderTuningCard(){
  const chipsEl = document.getElementById('tuningChips');
  const noteEl = document.getElementById('tuningNote');
  if(!chipsEl || !noteEl) return; // Insights markup not present
  chipsEl.innerHTML = NEXT_WEEK_TUNING_DEFS.map(function(d){
    const on = d.key === nextWeekTuning;
    return '<button class="pill ghost chip-preset' + (on ? ' chipsel' : '') + '" onclick="setNextWeekTuning(\'' + d.key + '\')">' + d.title + '</button>';
  }).join('');
  noteEl.textContent = nextWeekTuningDef(nextWeekTuning).note;
}

// Persists the household's tuning goal, regenerates next week (and current week's still-
// unlogged/unpinned future slots — same signature-driven regen every other
// computePlanSignature input already causes), and repaints every plan-derived screen —
// mirrors the refresh scope applyProf() runs after a householdStyle-affecting change,
// minus the profile-specific fields (goal tag, macro editor, avoid pills…) that tuning
// never touches.
function setNextWeekTuning(key){
  if(NEXT_WEEK_TUNING_KEYS.indexOf(key) === -1) return;
  nextWeekTuning = key;
  persist();
  toast('✓ ' + nextWeekTuningDef(key).title + ' — next week regenerating…');
  ensureWeekPlan(nextMondayISO());
  renderInsights();
  renderWeek();
  renderTodayMeals();
  renderLogPlan();
}

/* ===================================================================
   Quick-add: food search sheet (task D1 item 2)
   "Search" and "Meal" quick actions (Log screen) both open this sheet
   — Meal is a documented MVP alias, same flow. Two sub-views painted
   into #sheetBody: a live text-filtered food list (>=2 chars, client-
   side substring match on FOODS[..].name), then a grams stepper with a
   live-computed kcal/protein/carbs/fat preview (foodMacros(), engine.js)
   before writing a food-kind LogEntry (state.js:logFoodEntry) for
   currentProf. Barcode/photo stay demo toasts (index.html); water stays
   a toast too (it's not a nutrition entry).
   =================================================================== */
let quickAdd = {query: '', selectedId: null, grams: 100};

function openFoodSearch(){
  quickAdd = {query: '', selectedId: null, grams: 100};
  document.getElementById('sheetBody').innerHTML = buildFoodSearchSheet();
  // Delegated click for the result rows (data-food-id, not inline onclick — food ids can
  // be user-authored 'cf-' slugs). Attached on sheetBody so it also survives the
  // grams-stepper "‹ Back" path and #foodSearchResults child-only re-renders.
  const sheetBody = document.getElementById('sheetBody');
  sheetBody.onclick = function(e){
    const row = e.target.closest('.altrow[data-food-id]');
    if(!row || !sheetBody.contains(row)) return;
    selectQuickAddFood(row.getAttribute('data-food-id'));
  };
  document.getElementById('sheet').classList.remove('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
  const input = document.getElementById('foodSearchInput');
  if(input) input.focus();
}

// Client-side substring match on food display names, case-insensitive, capped to keep the
// sheet scannable. Requires >=2 characters (task D1 item 2) — shorter queries show a hint
// instead of the whole 60-food DB.
function searchFoods(query){
  const q = query.trim().toLowerCase();
  if(q.length < 2) return [];
  return Object.keys(FOODS)
    .filter(function(id){ return FOODS[id].name.toLowerCase().indexOf(q) !== -1; })
    .sort(function(a, b){ return FOODS[a].name < FOODS[b].name ? -1 : (FOODS[a].name > FOODS[b].name ? 1 : 0); })
    .slice(0, 20);
}

function buildFoodSearchSheet(){
  return '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Add a food</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
    + '<div class="field"><input class="inp" style="width:100%;box-sizing:border-box;border:1px solid var(--line)" type="text" id="foodSearchInput" placeholder="Search foods… (e.g. yogurt)" value="'+htmlAttr(quickAdd.query)+'" oninput="onFoodSearchInput(this.value)" autocomplete="off"></div>'
    + '<div id="foodSearchResults">' + renderFoodSearchResults() + '</div>';
}

function renderFoodSearchResults(){
  const q = quickAdd.query.trim();
  if(q.length < 2) return '<p class="sub" style="margin-top:10px">Type at least 2 letters to search.</p>';
  const ids = searchFoods(q);
  if(!ids.length) return '<p class="sub" style="margin-top:10px">No foods match “' + escapeHtml(q) + '”.</p>';
  return ids.map(function(id){
    const f = FOODS[id];
    const per = f.unit === 'piece' ? 'piece' : '100' + f.unit;
    return '<div class="altrow" data-food-id="'+htmlAttr(id)+'">'
      + '<div class="ae">' + foodIconHtml(id) + '</div>'
      + '<div class="at"><div class="an">'+escapeHtml(f.name)+'</div>'
      + '<div class="ad">'+Math.round(f.kcal)+' kcal · '+f.protein+'g protein · '+Math.round(f.sugars || 0)+'g sugars <b>/ '+per+'</b></div></div>'
      + '</div>';
  }).join('');
}

function onFoodSearchInput(value){
  quickAdd.query = value;
  const el = document.getElementById('foodSearchResults');
  if(el) el.innerHTML = renderFoodSearchResults();
}

function selectQuickAddFood(id){
  if(!FOODS[id]) return;
  quickAdd.selectedId = id;
  quickAdd.grams = 100;
  document.getElementById('sheetBody').innerHTML = buildGramsStepperSheet();
}

// FIX 2 (feedback): grams typeable directly, integer 1–2000 (same bound the stepper now
// clamps to as well, so typing and tapping can never disagree). Invalid/empty text reverts
// to the previous grams with a toast; a valid typed value re-renders through the exact same
// sheet builder a stepper tap uses, so the live kcal/protein/carbs/fat preview recomputes
// identically either way.
function commitQuickAddGrams(raw){
  const n = parseDecimalInput(raw);
  if(n === null || n < 0){ toast('Enter grams, e.g. 125'); document.getElementById('sheetBody').innerHTML = buildGramsStepperSheet(); return; }
  quickAdd.grams = Math.max(1, Math.min(2000, Math.round(n)));
  document.getElementById('sheetBody').innerHTML = buildGramsStepperSheet();
}

function stepQuickAddGrams(delta){
  quickAdd.grams = Math.max(1, Math.min(2000, quickAdd.grams + delta));
  document.getElementById('sheetBody').innerHTML = buildGramsStepperSheet();
}

function buildGramsStepperSheet(){
  const food = FOODS[quickAdd.selectedId];
  if(!food) return buildFoodSearchSheet();
  const nut = foodMacros(quickAdd.selectedId, quickAdd.grams);
  const pieceHint = food.unit === 'piece' ? ' (≈' + (+(quickAdd.grams / food.avgG).toFixed(1)) + ' piece)' : '';
  return '<div class="row between" style="margin-top:6px"><h2 style="margin:0">'+escapeHtml(food.name)+'</h2><button class="backbtn" style="margin:0" onclick="openFoodSearch()">‹ Back</button></div>'
    + '<div class="serve-row" style="margin-top:14px"><div class="serve-card me" style="flex:1">'
    + '<div class="sv-name">Amount</div>'
    + '<div class="sv-stepper"><button onclick="stepQuickAddGrams(-10)" aria-label="Decrease grams">–</button>'
    + '<input class="sv-val" type="text" inputmode="decimal" value="'+quickAdd.grams+'" onfocus="this.select()" onkeydown="if(event.key===\'Enter\'){this.blur();}" onblur="commitQuickAddGrams(this.value)" aria-label="Grams">'
    + '<span class="sv-unit">g'+pieceHint+'</span>'
    + '<button onclick="stepQuickAddGrams(10)" aria-label="Increase grams">+</button></div></div></div>'
    + '<div class="nutri" style="margin-top:16px">'
    + '<div class="n"><div class="nt"><span>Calories</span><b>'+Math.round(nut.kcal)+' kcal</b></div></div>'
    + '<div class="n"><div class="nt"><span>Protein</span><b>'+Math.round(nut.protein)+' g</b></div></div>'
    + '<div class="n"><div class="nt"><span>Carbs</span><b>'+Math.round(nut.carbs)+' g</b></div></div>'
    + '<div class="n"><div class="nt"><span>Sugars</span><b>'+Math.round(nut.sugars)+' g</b></div></div>'
    + '<div class="n"><div class="nt"><span>Fat</span><b>'+Math.round(nut.fat)+' g</b></div></div>'
    + '</div>'
    + '<button class="cta" onclick="confirmQuickAdd()">Add to today</button>'
    + '<button class="cta ghostbtn" onclick="closeSheet()">Cancel</button>';
}

function confirmQuickAdd(){
  if(!quickAdd.selectedId || !FOODS[quickAdd.selectedId]) return;
  const food = FOODS[quickAdd.selectedId];
  const grams = quickAdd.grams;
  logFoodEntry(currentLogDateISO(), currentProf, quickAdd.selectedId, grams);
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  updateLogTotalPill();
  renderTodaySoFar();
  renderTodayRecords();
  renderBeverageCounts();
  // C3: a quick-add is a kind:'food' logHistory entry, which weekDayNutriViews now folds
  // into the CURRENT week's day totals (Week screen header/macro line) whenever the
  // logged date is today-or-earlier — repaint Week here too, same as every other
  // logHistory mutator in this file (confirm/skip/swap/extras), so it can't show stale
  // numbers until some unrelated action happens to repaint it next.
  renderWeek();
  persist();
  closeSheet();
  toast('✓ Added ' + grams + 'g ' + food.name + ' to ' + logDateLabel().toLowerCase());
}

function logBeverage(foodId){
  const food = FOODS[foodId];
  if(!food) return;
  const grams = (food.unit === 'piece' && food.avgG) ? food.avgG : 1;
  logFoodEntry(currentLogDateISO(), currentProf, foodId, grams);
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  updateLogTotalPill();
  renderTodaySoFar();
  renderTodayRecords();
  renderBeverageCounts();
  renderWeek(); // C3: same reasoning as confirmQuickAdd() above — this also writes a kind:'food' entry.
  persist();
  toast('✓ Added ' + food.name);
}

/* ===================================================================
   export / import (task F2) — Profile → "Your data"

   Poor-man's Elena⇄Andrea sync until Phase 2's real backend: export
   downloads (iOS Safari: share-sheets) the EXACT mesa.v1 value as a
   dated JSON file; import reads a file, validates its shape, shows a
   confirm sheet naming the backup's date, and on confirm overwrites
   localStorage and reloads. Nothing is written to localStorage until
   the user confirms — an invalid file never touches existing state.
   =================================================================== */

// exportData() calls persist() first so the exact bytes exported are what's actually in
// localStorage right now (not a re-serialization that could drift from it), then reads
// STORE_KEY back verbatim and downloads it — no transformation of the stored value.
function exportData(){
  persist();
  let raw = null;
  try{ raw = localStorage.getItem(STORE_KEY); }catch(e){ raw = null; }
  if(!raw){ toast('Nothing to export yet'); return; }
  const filename = 'mesa-backup-' + todayISO() + '.json';
  const blob = new Blob([raw], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on a delay: iOS Safari's share sheet reads the blob URL asynchronously after
  // the click handler returns, so revoking immediately can race it.
  setTimeout(function(){ URL.revokeObjectURL(url); }, 2000);
  toast('✓ Backup downloaded');
}

// The same structural checks loadState() trusts before touching any field: a version
// number no newer than this app understands, and a profiles object with both known
// people. Deliberately shallow — loadState()'s own per-field type checks (already run
// against whatever we write to localStorage, on the reload that follows a confirmed
// import) are the real guard against a malformed-but-structurally-OK file.
function validateBackupStructure(obj){
  if(!obj || typeof obj !== 'object') return false;
  if(typeof obj.v !== 'number' || obj.v > CURRENT_STORE_VERSION) return false;
  if(!obj.profiles || typeof obj.profiles !== 'object') return false;
  if(!obj.profiles.elena || typeof obj.profiles.elena !== 'object') return false;
  if(!obj.profiles.partner || typeof obj.profiles.partner !== 'object') return false;
  return true;
}

// Pulls a human date out of the mesa-backup-YYYY-MM-DD.json filename Mesa itself writes
// (exportData() above) so the confirm sheet can name the backup without needing an
// export timestamp inside the store itself; falls back to the file's mtime for a
// renamed file, and finally to a neutral phrase if neither is available.
function importDateLabel(filename, lastModified){
  const m = /mesa-backup-(\d{4}-\d{2}-\d{2})/.exec(filename || '');
  if(m) return m[1];
  if(typeof lastModified === 'number' && isFinite(lastModified)){
    try{ return new Date(lastModified).toISOString().slice(0, 10); }catch(e){ /* fall through */ }
  }
  return 'this file';
}

// Holds the exact raw JSON text of a file that passed validateBackupStructure() and is
// awaiting the confirm sheet's decision — never written to localStorage until
// confirmImport(). null whenever no import is pending (cancelled, completed, or never
// started).
let pendingImportRaw = null;

function handleImportFile(input){
  const file = input.files && input.files[0];
  input.value = ''; // reset so re-picking the same filename still fires 'change'
  if(!file) return;
  const reader = new FileReader();
  reader.onerror = function(){ toast("Couldn't read that file"); };
  reader.onload = function(){
    let parsed;
    try{ parsed = JSON.parse(String(reader.result)); }
    catch(e){ toast("That file isn't a valid Mesa backup"); return; }
    if(!validateBackupStructure(parsed)){ toast("That file isn't a valid Mesa backup"); return; }
    pendingImportRaw = String(reader.result);
    openImportConfirm(importDateLabel(file.name, file.lastModified));
  };
  reader.readAsText(file);
}

// FEATURE (owner feedback): two import modes, not one. "Merge food library only" (new —
// js/library.js:mergeImportedLibrary()) is the safe default action for the common case
// ("share just a recipe with each other") — it merges custom foods/recipes plus recipe
// edits/deletes, while leaving profiles, plans, logs, and shopping checks alone. "Replace everything" is the
// original F2 behavior, unchanged (confirmImport() below), for the rarer full-phone-sync
// case — kept as the ghost/secondary button precisely because it's destructive.
function buildImportConfirmSheet(dateLabel){
  return '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Import backup</h2><button class="backbtn" style="margin:0" onclick="cancelImport()">✕ Close</button></div>'
    + '<p class="sub">Backup from <b>' + dateLabel + '</b>. Choose how to bring it in.</p>'
    + '<button class="cta" onclick="confirmMergeImport()">🔀 Merge food library only</button>'
    + '<button class="cta ghostbtn" style="margin-top:10px" onclick="confirmImport()">⚠️ Replace everything</button>'
    + '<p class="sub" style="margin-top:10px">Merge adds this backup\'s custom ingredients &amp; recipes to what\'s already on this phone — nothing else changes, and it\'s safe to run more than once. Replace everything overwrites ALL data on this phone (profiles, plans, log history, library) with the backup — your current data here will be lost.</p>'
    + '<button class="cta ghostbtn" style="margin-top:14px" onclick="cancelImport()">Cancel</button>';
}

function openImportConfirm(dateLabel){
  document.getElementById('sheetBody').innerHTML = buildImportConfirmSheet(dateLabel);
  document.getElementById('sheet').classList.remove('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

function cancelImport(){
  pendingImportRaw = null;
  closeSheet();
}

// Overwrites STORE_KEY with the pending backup's exact bytes, then reloads: a full
// reload (rather than re-running loadState() in place) guarantees every already-rendered
// screen and in-memory global (PROF, weekPlan, logHistory, currentProf, RECIPES_DB…)
// rebuild from scratch against the new store, with zero risk of stale in-memory state
// bleeding through.
function confirmImport(){
  if(!pendingImportRaw){ closeSheet(); return; }
  try{
    localStorage.setItem(STORE_KEY, pendingImportRaw);
  }catch(e){
    toast("Couldn't save that backup on this phone");
    return;
  }
  pendingImportRaw = null;
  location.reload();
}

// Merge-only import (FEATURE, owner feedback): parses the SAME pending backup
// validateBackupStructure() already accepted for structural soundness, hands it to
// js/library.js:mergeImportedLibrary() (library content only — see that
// function's doc for the full merge-rule spec: identical-content skip, '-2' conflict
// copies with ingredient remap, " (imported)" on name collisions), then persists +
// re-renders via applyProf() — the exact same pattern saveNewFood()/saveNewRecipe()/
// deleteCustomFood()/deleteRecipe() (js/library.js) already use for every other
// library mutation. Unlike confirmImport() above (full replace + hard reload), this
// never reloads: it's a pure in-place library merge, so everything else already on this
// phone (profile edits, plans, log history) is completely undisturbed.
function confirmMergeImport(){
  if(!pendingImportRaw){ closeSheet(); return; }
  let parsed;
  try{ parsed = JSON.parse(pendingImportRaw); }
  catch(e){ toast("That file isn't a valid Mesa backup"); pendingImportRaw = null; closeSheet(); return; }
  const result = mergeImportedLibrary(parsed);
  pendingImportRaw = null;
  applyProf(currentProf); // refreshes library-derived UI without resetting the existing plan
  closeSheet();
  const parts = [];
  if(result.addedRecipes) parts.push(result.addedRecipes + ' recipe' + (result.addedRecipes === 1 ? '' : 's'));
  if(result.addedFoods) parts.push(result.addedFoods + ' ingredient' + (result.addedFoods === 1 ? '' : 's'));
  toast(parts.length ? '✓ Added ' + parts.join(' and ') + ' from the backup' : 'Nothing new in that backup — already on this phone');
}
