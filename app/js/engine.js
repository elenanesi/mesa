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
  const base = 10 * p.weightKg + 6.25 * p.heightCm - 5 * ageOf(p);
  return p.sex === 'male' ? base + 5 : base - 161;
}
function maintenanceOf(p){ return bmrOf(p) * p.activity; }
function recommendedCal(p){ return round10(maintenanceOf(p) + p.goalAdj); }
// Sane band for manual targets: never below ~110% of BMR, never above maintenance + 600.
function calBand(p){ return [round10(bmrOf(p) * 1.1), round10(maintenanceOf(p) + 600)]; }

/* ---------------- goal-derived numbers (task B1) ----------------
   The bug this fixes: PROF[key].goalAdj used to be a fixed constant, so unchecking
   "Gentle fat loss" on the Profile screen changed nothing — recommendedCal() kept
   applying −325 regardless. goalAdj/goalName/goalTag are now PURE functions of
   PROF[key].goals (state.js), the single source of truth; recomputeProf() below calls
   them on every recompute so toggling a goal (render.js:toggleGoal) takes effect
   immediately, the same way editing weight/height already did. Dispatches on which
   calorie-goal key the profile's `goals` object carries (elena has `fatLoss`, partner
   has `muscleGain`) rather than on profile identity, so these also work against a bare
   {goals:{...}} object in tests. */
function deriveGoalAdj(p){
  if('fatLoss' in p.goals) return p.goals.fatLoss ? -325 : 0;
  return p.goals.muscleGain ? 60 : 0;
}
function deriveGoalName(p){
  if('fatLoss' in p.goals) return p.goals.fatLoss ? 'gentle fat loss' : 'maintenance';
  return p.goals.muscleGain ? 'small muscle-gain surplus' : 'maintenance';
}
// Short "🎯 <calorie goal> · <other emoji> <other goal>" summary shown under the name
// on the Profile screen (#goalTag). The second slot surfaces the person's most
// distinctive OTHER active goal — same priority order as state.js's WHY_RULES (thyroid
// > skin > muscle > heart for Elena; heart is the only other goal Andrea has) — and is
// omitted entirely if none of those are on.
function deriveGoalTag(p){
  const g = p.goals;
  const isElena = 'fatLoss' in g;
  const calChip = isElena
    ? (g.fatLoss ? '🎯 Gentle fat loss' : '🎯 At maintenance')
    : (g.muscleGain ? '🎯 Muscle gain' : '🎯 At maintenance');
  const other = isElena
    ? (g.hashi ? '🦋 Hashimoto' : g.skin ? '✨ Skin' : g.muscle ? '💪 Muscle & protein' : g.heart ? '❤️ Heart-smart' : null)
    : (g.heart ? '❤️ Heart-smart' : null);
  return other ? (calChip + ' · ' + other) : calChip;
}

// Recomputes macro gram targets + fat good/sat split from the profile's split % and
// daily calories. Consumed grams are fixed (already eaten today); only the target
// denominators — and therefore the bar widths — move when the split changes.
function recomputeProf(key){
  const p = PROF[key];
  // Goal-derived numbers first (task B1) — recCal below reads p.goalAdj.
  p.goalAdj = deriveGoalAdj(p);
  p.goalName = deriveGoalName(p);
  p.goalTag = deriveGoalTag(p);
  p.hashi = !!p.goals.hashi; // mirrored convenience: Insights' selenium check reads PROF[key].hashi directly
  // Daily target: the Mifflin-St Jeor recommendation unless a manual override is set.
  p.recCal = recommendedCal(p);
  if(p.calCustom !== null && p.calCustom === p.recCal) p.calCustom = null; // drifted back onto the recommendation
  p.calGoalNum = (p.calCustom !== null) ? p.calCustom : p.recCal;
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

// Scales one food's macros to `grams`. Per-piece foods (unit:'piece', e.g. eggs) store
// PER-PIECE values with avgG documenting the assumed piece weight, so the scale factor
// is grams/avgG rather than grams/per (per-100g/ml foods use grams/per, per === 100).
// A missing food id is a data bug, never a crash: log loudly and return zeros so a bad
// id degrades one line of a nutrition grid to "0" instead of breaking the screen.
function foodMacros(foodId, grams){
  const food = (typeof FOODS !== 'undefined') ? FOODS[foodId] : undefined;
  if(!food){
    console.error('foodMacros: unknown food id "' + foodId + '"');
    return {kcal:0, protein:0, carbs:0, fat:0, satFat:0, fiber:0, sugars:0, freeSugars:0, sugarQuality:'unknown'};
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
