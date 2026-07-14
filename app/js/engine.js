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

// Recomputes macro gram targets + fat good/sat split from the profile's split % and
// daily calories. Consumed grams are fixed (already eaten today); only the target
// denominators — and therefore the bar widths — move when the split changes.
function recomputeProf(key){
  const p = PROF[key];
  // Daily target: the Mifflin-St Jeor recommendation unless a manual override is set.
  p.recCal = recommendedCal(p);
  if(p.calCustom !== null && p.calCustom === p.recCal) p.calCustom = null; // drifted back onto the recommendation
  p.calGoalNum = (p.calCustom !== null) ? p.calCustom : p.recCal;
  p.calGoal = fmtKcal(p.calGoalNum);
  p.cals = fmtKcal(p.calGoalNum) + ' kcal';
  p.calLeft = fmtKcal(Math.max(0, p.calGoalNum - p.consumedKcal));
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
    return {kcal:0, protein:0, carbs:0, fat:0, satFat:0, fiber:0};
  }
  const factor = (food.unit === 'piece') ? (grams / food.avgG) : (grams / food.per);
  return {
    kcal: food.kcal * factor,
    protein: food.protein * factor,
    carbs: food.carbs * factor,
    fat: food.fat * factor,
    satFat: food.satFat * factor,
    fiber: food.fiber * factor
  };
}

// Sums a recipe's `ingredients` (never `toTaste` — unquantified garnish, see
// data/recipes.js) at `servings` SERVINGS eaten. A recipe's ingredient list is the
// batch as written; `recipe.servings` (default 1 — every pre-servings recipe wrote
// its batch as one serving) says how many servings that batch yields, so one serving
// = batch/yield. Returns both the scaled `totals` (what `servings` servings add up
// to) and the servings-invariant `perServing`.
// kcal is computed 4/4/9 from the SUMMED macros — same policy as foods.js — so a
// recipe's kcal always stays internally consistent with its own protein/carbs/fat
// instead of drifting from summing each ingredient's already-rounded kcal field.
// goodFat = fat − satFat: the real ingredient-derived good/sat split for the recipe
// screen (no more 75/25 approximation there — that approximation remains only for the
// profile-level *target* split in recomputeProf, which this does not touch).
function recipeNutrition(recipeId, servings){
  servings = (typeof servings === 'number' && servings > 0) ? servings : 1;
  const zero = {kcal:0, protein:0, carbs:0, fat:0, satFat:0, fiber:0, goodFat:0};
  const r = (typeof RECIPES_DB !== 'undefined') ? RECIPES_DB[recipeId] : undefined;
  if(!r){
    console.error('recipeNutrition: unknown recipe id "' + recipeId + '"');
    return {totals: Object.assign({}, zero), perServing: Object.assign({}, zero)};
  }
  const batchYield = (typeof r.servings === 'number' && r.servings > 0) ? r.servings : 1;
  const totals = {kcal:0, protein:0, carbs:0, fat:0, satFat:0, fiber:0};
  (r.ingredients || []).forEach(function(ing){
    const m = foodMacros(ing[0], ing[1] * servings / batchYield);
    totals.kcal += m.kcal; totals.protein += m.protein; totals.carbs += m.carbs;
    totals.fat += m.fat; totals.satFat += m.satFat; totals.fiber += m.fiber;
  });
  totals.kcal = 4 * totals.protein + 4 * totals.carbs + 9 * totals.fat;
  totals.goodFat = totals.fat - totals.satFat;
  const perServing = {};
  Object.keys(totals).forEach(function(k){ perServing[k] = totals[k] / servings; });
  return {totals: totals, perServing: perServing};
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
