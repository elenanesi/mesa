/* ===================================================================
   engine.js — deterministic target engine
   Pure(ish) calculation functions: BMR/maintenance/recommended calories
   (Mifflin-St Jeor), the daily calorie band, macro-split guardrails,
   and recomputeProf() which derives a profile's display-ready numbers
   from its stored body stats + split. No DOM access in this file.
   =================================================================== */

/* ---------------- deterministic target engine ---------------- */
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const ACTIVITY_LEVELS = [
  {f:1.2,   t:'Sedentary',         d:'Mostly sitting · ×1.2'},
  {f:1.375, t:'Lightly active',    d:'Walks or 1–2 workouts a week · ×1.375'},
  {f:1.55,  t:'Moderately active', d:'Training 3–5 days a week · ×1.55'},
  {f:1.725, t:'Very active',       d:'Hard training most days · ×1.725'}
];
function fmtKcal(n){ return n.toLocaleString('en-US'); }
function round10(n){ return Math.round(n / 10) * 10; }
function ageOf(p){
  const now = new Date();
  let a = now.getFullYear() - p.dobY;
  if((now.getMonth() + 1) < p.dobM) a--;
  return a;
}
// Mifflin-St Jeor: male 10w + 6.25h − 5a + 5 · female 10w + 6.25h − 5a − 161
function bmrOf(p){
  if(p.sex == null || p.dobY == null || p.dobM == null || p.heightCm == null || p.weightKg == null) return NaN;
  const base = 10 * p.weightKg + 6.25 * p.heightCm - 5 * ageOf(p);
  return p.sex === 'male' ? base + 5 : base - 161;
}
function maintenanceOf(p){ return bmrOf(p) * p.activity; }
function recommendedCal(p){ return round10(maintenanceOf(p) + p.goalAdj); }
// Sane band for manual targets: never below ~110% of BMR, never above maintenance + 600.
function calBand(p){ return [round10(bmrOf(p) * 1.1), round10(maintenanceOf(p) + 600)]; }

/* ---------------- goal-derived numbers (task B1, un-pinned in the goal audit) ----------------
   The bug this originally fixed: PROF[key].goalAdj used to be a fixed constant, so
   unchecking "Gentle fat loss" on the Profile screen changed nothing — recommendedCal()
   kept applying −325 regardless. goalAdj/goalName/goalTag are PURE functions of
   PROF[key].goals (state.js), the single source of truth; recomputeProf() below calls
   them on every recompute so toggling a goal (render-profile.js:toggleGoal) takes effect
   immediately, the same way editing weight/height already did.

   Goal-audit fix: this used to also take a `calorieGoalKey` param (CALORIE_GOAL_KEY =
   {elena:'fatLoss', partner:'muscleGain'}) that PINNED which calorie goal each SLOT was
   even allowed to move — so partner checking "Gentle fat loss" showed a checkmark but
   deriveGoalAdj still dispatched on 'muscleGain' for that slot and applied nothing. Both
   goals are plain booleans on EVERY profile's `goals` object (GOAL_DEFS union, state.js)
   and both slots can use either one — there is no slot-based dispatch left. The two
   remain mutually exclusive (a person can't be in a deficit and a surplus at once), but
   that's enforced where the user actually flips the checkbox (render-profile.js:
   toggleGoal — turning one on turns the other off), not baked into which slot "owns"
   which goal. fatLoss taking priority over muscleGain below only matters for one instant
   mid-toggle (toggleGoal sets the new one before clearing the old one) — the two should
   never both be true once toggleGoal's own clearing has run. */
function deriveGoalAdj(p){
  if(p.goals.fatLoss) return -325;
  if(p.goals.muscleGain) return 60;
  return 0;
}
function deriveGoalName(p){
  if(p.goals.fatLoss) return 'gentle fat loss';
  if(p.goals.muscleGain) return 'small muscle-gain surplus';
  return 'maintenance';
}
// Legacy compact goal summary. Today no longer renders this lossy chip because it could
// show only one non-calorie goal; Profile's Nutrition plan is the full, authoritative
// place to review goals.
function deriveGoalTag(p){
  const g = p.goals;
  const calChip = g.fatLoss ? '🎯 Gentle fat loss' : g.muscleGain ? '🎯 Muscle gain' : '🎯 At maintenance';
  const other = g.hashi ? '🦋 Hashimoto' : g.skin ? '✨ Skin' : g.muscle ? '💪 Muscle & protein' : g.heart ? '❤️ Heart-smart' : null;
  return other ? (calChip + ' · ' + other) : calChip;
}

// Recomputes macro gram targets + fat good/sat split from the profile's split % and
// daily calories. Consumed grams are fixed (already eaten today); only the target
// denominators — and therefore the bar widths — move when the split changes.
function recomputeProf(key){
  const p = PROF[key];
  // Goal-derived numbers first (task B1) — recCal below reads p.goalAdj. Both goals are
  // plain per-profile booleans now (see deriveGoalAdj's doc above) — no slot dispatch.
  p.goalAdj = deriveGoalAdj(p);
  p.goalName = deriveGoalName(p);
  p.goalTag = deriveGoalTag(p);
  p.hashi = !!p.goals.hashi; // mirrored convenience: Insights' selenium check reads PROF[key].hashi directly
  // Task B2: displayName is the real source now — seg (segment-button label) and av
  // (avatar initial) DERIVE from it every recompute (state.js:avatarInitial), same
  // pattern as goalAdj/goalName/goalTag above deriving from `goals`. The trim/non-empty
  // guard mirrors loadState()'s (state.js) — recomputeProf() can run against a bare test
  // fixture too, so it can't assume loadState() already validated p.displayName.
  // A REAL stored name is normalized and kept as-is; a placeholder (unset, or a legacy
  // 'You'/'Partner' literal from the B2 build) is left UNTOUCHED in p.displayName so it
  // never gets promoted into shared/synced data, and only the display fields resolve
  // viewer-relatively — see state.js:resolveDisplayName's doc for why the two differ.
  if(typeof p.displayName === 'string' && p.displayName.trim() && !isPlaceholderDisplayName(p.displayName)){
    p.displayName = p.displayName.trim().slice(0, DISPLAY_NAME_MAX_LEN);
  }
  const dn = resolveDisplayName(key);
  p.seg = dn;
  p.av = avatarInitial(dn);
  // Daily target: the Mifflin-St Jeor recommendation unless a manual override is set.
  p.recCal = recommendedCal(p);
  if(p.calCustom !== null && p.calCustom === p.recCal) p.calCustom = null; // drifted back onto the recommendation
  p.calGoalNum = (p.calCustom !== null) ? p.calCustom : p.recCal;
  // Handle incomplete profiles (null body fields): show placeholder copy, no calorie targets.
  if(!isFinite(p.calGoalNum)){
    p.calGoal = '—';
    p.cals = 'Complete your profile to set targets';
    p.calLeft = '—';
    p.off = 0;
    p.targetP = 0; p.targetC = 0; p.targetF = 0;
    p.mp = p.consumed.p + ' / — g';
    p.mc = p.consumed.c + ' / — g';
    p.mf = p.consumed.f + ' / — g';
    p.bp = '—'; p.bc = '—'; p.bff = '—';
  } else {
    p.calGoal = fmtKcal(p.calGoalNum);
    p.cals = fmtKcal(p.calGoalNum) + ' kcal';
    p.calLeft = fmtKcal(p.calGoalNum - p.consumedKcal);
    p.off = Math.round(351.8 * Math.min(1, p.consumedKcal / p.calGoalNum)); // ring arc = fraction of kcal still left
    const kcal = p.calGoalNum;
    const targetP = Math.round(kcal * p.kP / 100 / 4);
    const targetC = Math.round(kcal * p.kC / 100 / 4);
    const targetF = Math.round(kcal * p.kF / 100 / 9);
    p.targetP = targetP; p.targetC = targetC; p.targetF = targetF;
    p.mp = p.consumed.p + ' / ' + targetP + ' g';
    p.mc = p.consumed.c + ' / ' + targetC + ' g';
    p.mf = p.consumed.f + ' / ' + targetF + ' g';
    p.bp = Math.min(100, Math.round(p.consumed.p / targetP * 100)) + '%';
    p.bc = Math.min(100, Math.round(p.consumed.c / targetC * 100)) + '%';
    p.bff = Math.min(100, Math.round(p.consumed.f / targetF * 100)) + '%';
  }
  // Good/sat fat line (task D1 item 3 "Today = Log"): the REAL split of today's logged
  // fat (planner.js:recomputeConsumed sums satFat straight from each LogEntry, itself
  // computed at log time by recipeNutrition()/foodMacros()) — no more 75/25 target-based
  // approximation. Zero before anything is logged, exactly like every other consumed number.
  p.fatSat = Math.round(p.consumed.satFat || 0);
  p.fatGood = Math.max(0, Math.round(p.consumed.f || 0) - p.fatSat);
}

/* ---------------- computed nutrition core (task C1) ----------------
   Every displayed nutrition number is computed from data/foods.js +
   data/recipes.js — never typed in (ground rule #1). This block is the
   single source both the recipe screen and the legacy-recipe
   compatibility view (state.js) read from. */

/* ---------------- composite ingredients (task: composite-ingredients engine) ----------------
   A composite FOODS entry (data/foods.js — `components` array present, e.g. 'pesto-elena')
   behaves like a food (used by grams, everywhere a foodId is) but stores no macros of its
   own: `components` is a batch formula ([foodId, grams] pairs — the exact convention recipe
   ingredients already use) and `yieldG` is the batch's total output weight, so per-100g
   macros are the summed component macros scaled by 100/yieldG. foodMacros() below is the
   ONLY place this resolution happens — every real consumer (recipeNutrition,
   nutritionForRecipeComponents, the shopping list/pantry via planner.js:
   foodQuantitiesForComponents, the Library UI's food-detail/list/recipe-builder-search
   screens, and data/validate.js's recipeMacros) reads a composite's numbers through
   foodMacros(), never a frozen field on the record — so correcting a component (say,
   parmesan's protein) moves every composite that contains it immediately, with no separate
   "resync the frozen numbers" step to forget. That resync-forgetting is the literal bug this
   feature retires (pesto-elena used to carry a hand-frozen kcal/protein/... snapshot).

   NESTED COMPOSITES are allowed (a component can itself be a composite id) rather than
   restricted — a future composite built from other composites (e.g. a sandwich containing
   plain guacamole as one component) is a perfectly reasonable batch formula, and forbidding
   it would be an arbitrary limit this recursive implementation doesn't actually need to
   impose. `seen`/`depth` guard the one real risk nesting adds — a data-authoring cycle —
   the same "bad data degrades one number, never crashes" contract foodMacros already has
   for an unknown plain food id: a cycle logs loudly and resolves to zero instead of
   recursing forever.

   VARIANT SELECTION is HOUSEHOLD-WIDE, not per-meal or per-person — see
   householdDietListForComposites()'s doc immediately below for why. */
const COMPOSITE_MAX_DEPTH = 6;

// Every diet active ANYWHERE in the household right now: both PROF slots, unioned via
// planner.js:unionDiets (that file loads after this one; forward-referenced by name at call
// time, the same convention planner.js itself already uses to reach library.js's
// DAIRY_FOOD_IDS etc — see planner.js's own comment on proteinKindForIngredientIds).
// Deliberately household-wide rather than per-person/per-meal: a composite like "pesto" is
// one jar in the fridge, not a dish re-planned fresh per meal — a real household doesn't
// keep a vegan jar AND a dairy jar side by side, it goes vegan wherever ANY member needs it
// to. This also answers the "what does a SHARED meal satisfying both people mean" question
// by construction, per the task brief: since the household union already includes both
// people's diets, a shared meal and each person's own solo meals all resolve to the
// IDENTICAL variant — there's no separate shared-vs-solo branch that could disagree. Pure
// function of the live PROF state (no Math.random/Date.now), so it stays deterministic for
// the planner.
function householdDietListForComposites(){
  if(typeof PROF === 'undefined' || typeof unionDiets !== 'function') return [];
  return unionDiets(Object.keys(PROF));
}

// Picks the active {components, yieldG} combo for a composite: the first entry in
// `food.variants` (authored array order = deterministic priority — same "authored order is
// the tie-break" convention normalizeRecipeOpts already uses for recipe optionGroups) whose
// `dietKeys` intersects the household's active diets; falls back to the composite's own
// top-level fields (the declared default/"classic" combo) when no variant matches — exactly
// the task's "when no diet forces a choice, use the composite's declared default" rule.
function activeCompositeVariant(food){
  const dietList = householdDietListForComposites();
  if(Array.isArray(food.variants) && dietList.length){
    for(let i = 0; i < food.variants.length; i++){
      const v = food.variants[i];
      if(v && Array.isArray(v.dietKeys) && v.dietKeys.some(function(k){ return dietList.indexOf(k) !== -1; })){
        return v;
      }
    }
  }
  return food;
}

// Recursively resolves a composite's per-100g(/ml) macros. `seen` is a foodId->true map
// guarding against a cycle (A contains B contains A); `depth` is a belt-and-braces cap in
// case a cycle somehow slips the `seen` check (it shouldn't, but a bounded recursion is a
// cheap extra guarantee against a stack overflow from bad data). Returns null when `foodId`
// isn't a composite at all, so foodMacros() below can tell "not a composite" apart from "a
// composite that resolved to zero."
function compositeMacrosPer100(foodId, seen, depth){
  seen = seen || {};
  depth = depth || 0;
  const food = (typeof FOODS !== 'undefined') ? FOODS[foodId] : undefined;
  if(!food || !Array.isArray(food.components)) return null;
  const zero = {kcal:0, protein:0, carbs:0, fat:0, satFat:0, fiber:0, sugars:0, freeSugars:0, sugarQuality:'unknown'};
  if(seen[foodId] || depth > COMPOSITE_MAX_DEPTH){
    console.error('compositeMacrosPer100: cycle or excessive composite nesting at "' + foodId + '"');
    return zero;
  }
  const combo = activeCompositeVariant(food);
  const components = Array.isArray(combo.components) ? combo.components : food.components;
  const yieldG = (typeof combo.yieldG === 'number' && combo.yieldG > 0) ? combo.yieldG
    : (typeof food.yieldG === 'number' && food.yieldG > 0) ? food.yieldG : null;
  if(!yieldG){
    console.error('compositeMacrosPer100: composite "' + foodId + '" missing a positive yieldG');
    return zero;
  }
  const nextSeen = Object.assign({}, seen);
  nextSeen[foodId] = true;
  const totals = {kcal:0, protein:0, carbs:0, fat:0, satFat:0, fiber:0, sugars:0, freeSugars:0};
  components.forEach(function(c){
    const cId = c[0], cGrams = c[1];
    const cFood = FOODS[cId];
    if(!cFood){
      console.error('compositeMacrosPer100: unknown component id "' + cId + '" in "' + foodId + '"');
      return;
    }
    const cFactor = (cFood.unit === 'piece') ? (cGrams / cFood.avgG) : (cGrams / (cFood.per || 100));
    const basis = Array.isArray(cFood.components) ? (compositeMacrosPer100(cId, nextSeen, depth + 1) || zero) : cFood;
    totals.kcal += (basis.kcal || 0) * cFactor;
    totals.protein += (basis.protein || 0) * cFactor;
    totals.carbs += (basis.carbs || 0) * cFactor;
    totals.fat += (basis.fat || 0) * cFactor;
    totals.satFat += (basis.satFat || 0) * cFactor;
    totals.fiber += (basis.fiber || 0) * cFactor;
    totals.sugars += (basis.sugars || 0) * cFactor;
    totals.freeSugars += (basis.freeSugars || 0) * cFactor;
  });
  const scale = 100 / yieldG;
  const per100 = {
    kcal: totals.kcal * scale, protein: totals.protein * scale, carbs: totals.carbs * scale,
    fat: totals.fat * scale, satFat: totals.satFat * scale, fiber: totals.fiber * scale,
    sugars: totals.sugars * scale, freeSugars: totals.freeSugars * scale,
    sugarQuality: totals.freeSugars > 0 ? 'added/free' : (totals.sugars > 0 ? 'intrinsic' : 'unknown')
  };
  // kcal policy (data/foods.js's header comment): Atwater 4/4/9 recomputed from the
  // composite's own summed macro grams, same as every plain food and recipeNutrition() —
  // keeps a composite internally consistent even though it was authored in ingredient
  // grams, never a typed-in kcal number.
  per100.kcal = 4 * per100.protein + 4 * per100.carbs + 9 * per100.fat;
  return per100;
}

// Scales one food's macros to `grams`. Per-piece foods (unit:'piece', e.g. eggs) store
// PER-PIECE values with avgG documenting the assumed piece weight, so the scale factor
// is grams/avgG rather than grams/per (per-100g/ml foods use grams/per, per === 100). A
// COMPOSITE food (components present) has no static per/avgG-scaled fields of its own —
// compositeMacrosPer100 resolves its live per-100g numbers first, then the exact same
// grams/per scaling applies (composites always declare per:100, like every non-piece food).
// A missing food id is a data bug, never a crash: log loudly and return zeros so a bad
// id degrades one line of a nutrition grid to "0" instead of breaking the screen.
function foodMacros(foodId, grams){
  const food = (typeof FOODS !== 'undefined') ? FOODS[foodId] : undefined;
  if(!food){
    console.error('foodMacros: unknown food id "' + foodId + '"');
    return {kcal:0, protein:0, carbs:0, fat:0, satFat:0, fiber:0, sugars:0, freeSugars:0, sugarQuality:'unknown'};
  }
  if(Array.isArray(food.components)){
    const per100 = compositeMacrosPer100(foodId) || {kcal:0, protein:0, carbs:0, fat:0, satFat:0, fiber:0, sugars:0, freeSugars:0, sugarQuality:'unknown'};
    const factor = grams / (food.per || 100);
    return {
      kcal: per100.kcal * factor,
      protein: per100.protein * factor,
      carbs: per100.carbs * factor,
      fat: per100.fat * factor,
      satFat: per100.satFat * factor,
      fiber: per100.fiber * factor,
      sugars: per100.sugars * factor,
      freeSugars: per100.freeSugars * factor,
      sugarQuality: per100.sugarQuality
    };
  }
  const factor = (food.unit === 'piece') ? (grams / food.avgG) : (grams / food.per);
  return {
    kcal: food.kcal * factor,
    protein: food.protein * factor,
    carbs: food.carbs * factor,
    fat: food.fat * factor,
    satFat: food.satFat * factor,
    fiber: food.fiber * factor,
    sugars: (food.sugars || 0) * factor,
    freeSugars: (food.freeSugars || 0) * factor,
    sugarQuality: food.sugarQuality || 'unknown'
  };
}

// task D1 (recipe options/variants): resolves an `opts` object ({groupKey: choiceId})
// against `recipe.optionGroups` into a COMPLETE, valid combo — every group gets exactly
// one entry. Missing keys, unknown group keys in `opts`, and choice ids that don't
// belong to that group all fall back to choices[0] (authored order — the deterministic
// default, see data/recipes.js's optionGroups doc); unknown keys in `opts` that don't
// match any group are silently dropped (never copied into the result, since this
// iterates recipe.optionGroups, never `opts`, to build the output). Recipes without
// optionGroups always resolve to {} — every downstream caller treats an empty/undefined
// opts object identically, so this is the ONE place "bad opts" gets sanitized rather
// than every reader re-guarding it.
function normalizeRecipeOpts(recipe, opts){
  const out = {};
  if(!recipe || !Array.isArray(recipe.optionGroups) || !recipe.optionGroups.length) return out;
  const src = (opts && typeof opts === 'object') ? opts : {};
  recipe.optionGroups.forEach(function(group){
    if(!group || typeof group.key !== 'string') return;
    const choices = Array.isArray(group.choices) ? group.choices : [];
    if(!choices.length) return;
    const requested = src[group.key];
    const match = choices.filter(function(c){ return c && c.id === requested; })[0];
    out[group.key] = match ? match.id : choices[0].id;
  });
  return out;
}

// task D1: the SINGLE source of a recipe's effective ingredient list — base `ingredients`
// (data/recipes.js) plus, for every optionGroups entry, the chosen choice's ingredients
// (normalizeRecipeOpts fills in the deterministic default for anything missing/invalid,
// so a bad/stale `opts` object can never throw or silently drop a group). Every consumer
// of a recipe's ingredients — recipeNutrition below, planner.js's computeShoppingList,
// render.js's recipeDisplayIngredients, data/validate.js's recipeMacros — reads through
// this so nutrition/shopping/display/validation can never disagree about what a chosen
// variant actually contains. Recipes without optionGroups return `ingredients` unchanged
// (same array contents, so options-less recipes stay byte-identical).
function recipeEffectiveIngredients(recipe, opts){
  if(!recipe) return [];
  const base = Array.isArray(recipe.ingredients) ? recipe.ingredients.slice() : [];
  if(!Array.isArray(recipe.optionGroups) || !recipe.optionGroups.length) return base;
  const normalized = normalizeRecipeOpts(recipe, opts);
  const effective = base;
  recipe.optionGroups.forEach(function(group){
    if(!group || typeof group.key !== 'string') return;
    const choices = Array.isArray(group.choices) ? group.choices : [];
    if(!choices.length) return;
    const chosenId = normalized[group.key];
    const choice = choices.filter(function(c){ return c && c.id === chosenId; })[0] || choices[0];
    if(choice && Array.isArray(choice.ingredients)) effective.push.apply(effective, choice.ingredients);
  });
  return effective;
}

// Sums a recipe's EFFECTIVE ingredients (recipeEffectiveIngredients — base `ingredients`
// plus, when `opts` selects them, each optionGroups choice's ingredients; never `toTaste`
// — unquantified garnish, see data/recipes.js) at `servings` SERVINGS eaten. A recipe's
// ingredient list is the batch as written; `recipe.servings` (default 1 — every
// pre-servings recipe wrote its batch as one serving) says how many servings that batch
// yields, so one serving = batch/yield. Returns both the scaled `totals` (what `servings`
// servings add up to) and the servings-invariant `perServing`.
// `opts` (task D1, optional 3rd param — every pre-existing call site omits it, so it's
// undefined -> normalizeRecipeOpts({}) -> the deterministic default combo for a recipe
// WITH optionGroups, or {} for one without -> recipeEffectiveIngredients returns the bare
// `ingredients` array unchanged -> byte-identical to pre-D1 behavior).
// kcal is computed 4/4/9 from the SUMMED macros — same policy as foods.js — so a
// recipe's kcal always stays internally consistent with its own protein/carbs/fat
// instead of drifting from summing each ingredient's already-rounded kcal field.
// goodFat = fat − satFat: the real ingredient-derived good/sat split for the recipe
// screen (no more 75/25 approximation there — that approximation remains only for the
// profile-level *target* split in recomputeProf, which this does not touch).
function recipeNutrition(recipeId, servings, opts){
  servings = (typeof servings === 'number' && servings > 0) ? servings : 1;
  const zero = {kcal:0, protein:0, carbs:0, fat:0, satFat:0, fiber:0, sugars:0, freeSugars:0, sugarQuality:'unknown', goodFat:0};
  const r = (typeof RECIPES_DB !== 'undefined') ? RECIPES_DB[recipeId] : undefined;
  if(!r){
    console.error('recipeNutrition: unknown recipe id "' + recipeId + '"');
    return {totals: Object.assign({}, zero), perServing: Object.assign({}, zero)};
  }
  const batchYield = (typeof r.servings === 'number' && r.servings > 0) ? r.servings : 1;
  const totals = {kcal:0, protein:0, carbs:0, fat:0, satFat:0, fiber:0, sugars:0, freeSugars:0};
  recipeEffectiveIngredients(r, opts).forEach(function(ing){
    const m = foodMacros(ing[0], ing[1] * servings / batchYield);
    totals.kcal += m.kcal; totals.protein += m.protein; totals.carbs += m.carbs;
    totals.fat += m.fat; totals.satFat += m.satFat; totals.fiber += m.fiber;
    totals.sugars += m.sugars || 0; totals.freeSugars += m.freeSugars || 0;
  });
  totals.kcal = 4 * totals.protein + 4 * totals.carbs + 9 * totals.fat;
  totals.goodFat = totals.fat - totals.satFat;
  totals.sugarQuality = 'unknown';
  const perServing = {};
  // totals carries sugarQuality (a string, e.g. 'unknown') alongside the numeric
  // nutrients (goodFat included, hence a typeof guard rather than a NUTRIENT_KEYS
  // whitelist, which omits goodFat) — dividing it would silently produce NaN.
  Object.keys(totals).forEach(function(k){
    perServing[k] = (typeof totals[k] === 'number') ? totals[k] / servings : totals[k];
  });
  return {totals: totals, perServing: perServing};
}

const NUTRIENT_KEYS = ['kcal', 'protein', 'carbs', 'fat', 'satFat', 'fiber', 'sugars', 'freeSugars'];

function nutritionForRecipeComponents(components){
  const totals = {kcal:0, protein:0, carbs:0, fat:0, satFat:0, fiber:0, sugars:0, freeSugars:0};
  (components || []).forEach(function(c){
    let nut = null;
    if(c && c.recipeId && typeof RECIPES_DB !== 'undefined' && RECIPES_DB[c.recipeId]){
      // task D1: c.opts (additive — undefined on every pre-D1 component) carries which
      // variant this component froze/planned; recipeNutrition's opts param defaults it.
      nut = recipeNutrition(c.recipeId, c.portion, c.opts).totals;
    } else if(c && c.foodId && typeof FOODS !== 'undefined' && FOODS[c.foodId]){
      nut = foodMacros(c.foodId, c.grams);
    }
    if(!nut) return;
    NUTRIENT_KEYS.forEach(function(k){ totals[k] += nut[k] || 0; });
  });
  totals.goodFat = totals.fat - totals.satFat;
  totals.sugarQuality = 'unknown';
  return totals;
}

function fallbackNutritionTotals(src){
  const out = {kcal:0, protein:0, carbs:0, fat:0, satFat:0, fiber:0, sugars:0, freeSugars:0, sugarQuality:'unknown'};
  NUTRIENT_KEYS.forEach(function(k){
    const v = src && typeof src[k] === 'number' && isFinite(src[k]) ? src[k] : 0;
    out[k] = v;
  });
  out.goodFat = Math.max(0, out.fat - out.satFat);
  out.sugarQuality = (src && typeof src.sugarQuality === 'string') ? src.sugarQuality : 'unknown';
  return out;
}

function roundedNutritionTotals(src){
  const out = {};
  NUTRIENT_KEYS.forEach(function(k){ out[k] = Math.round((src && src[k]) || 0); });
  out.goodFat = Math.max(0, Math.round((src && src.goodFat !== undefined) ? src.goodFat : (out.fat - out.satFat)));
  out.sugarQuality = (src && typeof src.sugarQuality === 'string') ? src.sugarQuality : 'unknown';
  return out;
}

// Log entries carry recipe/food identity plus quantity. Stored macro numbers are kept as
// a compatibility fallback, but live displays and daily totals recompute from the current
// food/recipe DB so plan, recipe detail, log and consumed bars cannot drift apart.
function logEntryNutrition(entry){
  if(!entry || typeof entry !== 'object') return fallbackNutritionTotals(null);
  if(entry.kind === 'plan' && Array.isArray(entry.components) && entry.components.length){
    return nutritionForRecipeComponents(entry.components);
  }
  if(NUTRIENT_KEYS.every(function(k){ return typeof entry[k] === 'number' && isFinite(entry[k]); })){
    return fallbackNutritionTotals(entry);
  }
  if(entry.kind === 'plan' && entry.ref && typeof RECIPES_DB !== 'undefined' && RECIPES_DB[entry.ref]){
    return recipeNutrition(entry.ref, entry.portion).totals;
  }
  if(entry.kind === 'food' && entry.ref && typeof FOODS !== 'undefined' && FOODS[entry.ref]){
    return foodMacros(entry.ref, entry.grams);
  }
  return fallbackNutritionTotals(entry);
}

const SPLIT_BOUNDS = {P:[10,40], C:[20,60], F:[20,45]};
const SPLIT_PROP = {P:'kP', C:'kC', F:'kF'};
const SPLIT_LABEL = {P:'Protein', C:'Carbs', F:'Fat'};

function splitGuardNote(macro, dir){
  const msgs = {
    P:{min:'Protein stays ≥10% — your body needs a baseline to protect muscle.', max:'Protein stays ≤40% — more than this adds little extra benefit.'},
    C:{min:'Carbs stay ≥20% — your brain and workouts need fuel.', max:'Carbs stay ≤60% — leaves enough room for protein and fat.'},
    F:{min:'Fat stays ≥20% — needed for hormones and vitamin absorption.', max:'Fat stays ≤45% — keeps room for enough protein and carbs.'}
  };
  return msgs[macro][dir];
}
