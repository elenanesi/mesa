/* ===================================================================
   planner.js — deterministic menu planner, swap & re-balance solver,
   shopping-list aggregation (task C2)

   generateWeek() builds a 7-day plan for BOTH people from RECIPES_DB,
   respecting (in priority order): (a) each person's avoid-list — hard
   filter; (b) the household plan style (balanced/highprotein/lowcarb,
   derived from the macro split exactly as the old computeActiveMenu
   did) — hard filter; (c) daily kcal close to each person's target,
   via portion scaling (0.5 steps, 0.5-3x) on shared meals and
   independent recipe choice + portion on solo meals; (d) protein
   grams close to target, preferring higher-protein options when
   under; (e) variety (no repeat within 3 days same slot; dinners
   don't repeat at all in the week unless the pool is too small, in
   which case the candidate with the LONGEST gap since last use wins).

   Every candidate is scored by a pure function of (kcal-fit,
   protein-fit, variety, a tiny deterministic rotation term derived
   from day/slot index + a stable string hash of the recipe id) with a
   final lexicographic-id tie-break — no Math.random, no Date.now
   inside generateWeek (weekStartDate is passed in, never computed
   here), so the same inputs always produce a byte-identical plan.

   The result is `weekPlan` (state.js) — the source of truth every
   other screen reads from: renderWeek/renderTodayMeals/renderLogPlan
   (render.js) and computeShoppingList (below). ensureWeekPlan() keeps
   it fresh, regenerating when the inputs that produced it (style,
   avoid-lists, calorie/protein targets, SHARED toggles, or the week
   itself) have moved on.

   Swap (buildSwapAlternatives/applySwap) and re-balance
   (proposeRebalanceSwaps/computeWeeklyCoverage) reuse the same
   candidatesFor/bestPortion/applySwapToPlan building blocks, so both
   respect the exact same avoid/style/kcal-fit rules as generation.
   =================================================================== */

/* ---------------- household plan style ---------------- */
function styleOf(p){ return p.kP >= 32 ? 'protein' : (p.kC <= 32 ? 'lowcarb' : 'balanced'); }
// householdStyle (state.js) uses 'balanced'/'protein'/'lowcarb'; RECIPES_DB.styles uses
// 'balanced'/'highprotein'/'lowcarb' — this is the one place that translates between them.
const STYLE_DB_KEY = {balanced:'balanced', protein:'highprotein', lowcarb:'lowcarb'};

const SLOT_ORDER = ['breakfast', 'lunch', 'dinner', 'snack'];
// Typical share of a day's calories per slot (sums to 1.0) — used to "water-fill" each
// person's remaining daily kcal/protein budget across the slots still to come, so an
// earlier slot's over/undershoot is compensated by later slots rather than compounding.
const SLOT_WEIGHT = {breakfast: 0.28, lunch: 0.32, dinner: 0.30, snack: 0.10};
const PERSON_ANCHOR = {elena: 1, partner: 1.5}; // matches the old svE/svM defaults
const PORTION_STEPS = [0.5, 1, 1.5, 2, 2.5, 3];
// Task C3 item 3 ("snack realism"): breakfast/snack portions are capped at 1.5x so a
// 2x/2.5x/3x scale-up of an egg-heavy breakfast can't produce absurd shopping totals
// (69 eggs/week before this cap). Lunch/dinner keep the full 0.5-3x range. Capping the
// portion means bestPortion() can no longer close a big kcal gap by over-scaling one
// recipe — mealScore() (which picks the WINNING candidate across the whole pool, not
// just the portion of one) then naturally prefers a denser recipe that reaches the
// target within the cap, exactly as the plan asks, with no extra "prefer denser" code
// needed: a capped, under-target portion just scores worse on kcal-fit than a candidate
// that doesn't need capping.
const SLOT_MAX_PORTION = {breakfast: 1.5, lunch: 3, dinner: 3, snack: 1.5};
// task B2 (composed meals): for each role:'main' candidate, only the top-K sides by
// combined-at-1x kcal fit are evaluated (pair pruning — determinism + speed over the full
// 9-recipe side pool). See sidePoolFor/topKSideIds below.
const SIDE_TOP_K = 4;
// Breakfast-pairing food amount steps (Decisions Q2 whitelist): piece-unit foods in whole
// pieces (1-2x avgG), everything else in 30g steps up to 120g — deterministic, no search
// beyond these fixed candidates.
const BREAKFAST_PAIR_PIECE_STEPS = [1, 2];
const BREAKFAST_PAIR_GRAM_STEPS = [30, 60, 90, 120];

/* ---------------- small deterministic helpers ---------------- */
// DJB2-xor string hash — stable across runs (no Math.random), used only as a tiny
// tie-breaking "rotation" term so the week doesn't pick the same top-scoring recipe
// every single day when kcal/protein/variety all tie.
function stableHash(str){
  let h = 5381;
  for(let i = 0; i < str.length; i++){ h = ((h * 33) ^ str.charCodeAt(i)) >>> 0; }
  return h;
}

function parseISODate(iso){ const parts = iso.split('-'); return new Date(+parts[0], +parts[1] - 1, +parts[2]); }
function fmtISODate(d){ return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function addDaysISO(iso, n){ const d = parseISODate(iso); d.setDate(d.getDate() + n); return fmtISODate(d); }
function diffDaysISO(a, b){ const da = parseISODate(a), db = parseISODate(b); return Math.round((da - db) / 86400000); }
// Monday of the week containing `iso` — weekPlan.weekStartDate is always this, so "today"
// always maps to a 0-6 day index without drifting mid-week.
function mondayOfWeek(iso){
  const d = parseISODate(iso);
  const day = d.getDay(); // 0=Sun..6=Sat
  const shift = (day === 0) ? -6 : (1 - day);
  d.setDate(d.getDate() + shift);
  return fmtISODate(d);
}
// The Monday one week after the current week's Monday — the one other week the two-week
// horizon feature (owner feedback: "I need to see both this and next week's menu to shop
// on the weekend") ever shows or generates a plan for.
function nextMondayISO(){ return addDaysISO(mondayOfWeek(todayISO()), 7); }

function unionAvoid(a, b){
  const set = {};
  (a || []).forEach(function(x){ set[x] = true; });
  (b || []).forEach(function(x){ set[x] = true; });
  return Object.keys(set);
}
function recipeHitsAvoid(recipe, avoidList){
  if(!avoidList || !avoidList.length) return false;
  return recipe.avoid.some(function(a){ return avoidList.indexOf(a) !== -1; });
}
function recipePref(id){ return recipePrefs[id] || null; }
// Every recipe for a slot x style that doesn't hit the given avoid-list, sorted
// lexicographically by id (the base order every tie-break falls back to).
function candidatesFor(slot, styleKey, avoidList, opts){
  opts = opts || {};
  return Object.keys(RECIPES_DB).filter(function(id){
    const r = RECIPES_DB[id];
    return !r.occasional
      && (opts.includeThumbsDown || recipePref(id) !== 'down')
      && (typeof recipeAllowedForCurrentSeason !== 'function' || recipeAllowedForCurrentSeason(id))
      && recipeSlotList(r).indexOf(slot) !== -1
      && r.styles.indexOf(styleKey) !== -1
      && !recipeHitsAvoid(r, avoidList)
      && recipeOptionsViable(r, avoidList);
  }).sort();
}
function dbBaseNutrition(id){ return recipeNutrition(id, 1).totals; } // "the recipe as written" (1x)

/* ---------------- task B2: composed lunch/dinner + breakfast pairing pools ----------------
   generateWeek's candidate pool for lunch/dinner/breakfast is (per plan section B2):
     role:'full' recipes (today's behavior, unchanged) UNION composed (main x side/food)
     pairs built from role:'main' recipes + the pools below. Snack never composes — its
     pool stays exactly what candidatesFor() already returns, role ignored entirely, per
     the B2 tagging handoff ("Snack: Hummus & veg sticks... roles other than what
     candidatesFor already returns are irrelevant there"). */

// Every role:'side' recipe, filtered by avoid-list + season but DELIBERATELY NOT by
// household style: a vegetable side fits any style, and the 9-recipe side pool is too
// small to also style-filter without emptying for non-balanced styles (documented per the
// B2 tagging handoff). Sides need not carry the current slot in `slots` — a side is a side
// at lunch or dinner regardless of its own slot metadata (e.g. a side tagged only for
// 'side'/'snack' can still compose into a lunch or dinner meal). Sorted id order.
function sidePoolFor(avoidList){
  return Object.keys(RECIPES_DB).filter(function(id){
    const r = RECIPES_DB[id];
    return r.role === 'side'
      && !r.occasional
      && recipePref(id) !== 'down'
      && (typeof recipeAllowedForCurrentSeason !== 'function' || recipeAllowedForCurrentSeason(id))
      && !recipeHitsAvoid(r, avoidList);
  }).sort();
}

// Plain-FOODS avoid check, mirroring library.js's own ingredient-derived avoid tagging
// (deriveRecipeMeta: Dairy -> lactose, GLUTEN_FOOD_IDS -> gluten, prawns -> shellfish,
// NUT_FOOD_IDS -> nuts). Breakfast-pairing foods are FOODS records, not recipes, so they
// carry no `avoid` array of their own — this reuses the exact same derivation rule so a
// person's avoid-list is respected identically whether the offending ingredient arrives
// via a recipe or a plain paired food.
function foodHitsAvoid(foodId, avoidList){
  if(!avoidList || !avoidList.length) return false;
  const food = FOODS[foodId];
  if(!food) return false;
  // Explicit allergen list for composite foods (e.g. pesto-elena: Pantry cat, but
  // contains dairy + almonds) — checked before the category/id heuristics below.
  if(Array.isArray(food.containsAvoid) && food.containsAvoid.some(function(k){ return avoidList.indexOf(k) !== -1; })) return true;
  if(avoidList.indexOf('lactose') !== -1 && food.cat === 'Dairy') return true;
  if(avoidList.indexOf('gluten') !== -1 && typeof GLUTEN_FOOD_IDS !== 'undefined' && GLUTEN_FOOD_IDS.indexOf(foodId) !== -1) return true;
  if(avoidList.indexOf('shellfish') !== -1 && foodId === 'prawns') return true;
  if(avoidList.indexOf('nuts') !== -1 && typeof NUT_FOOD_IDS !== 'undefined' && NUT_FOOD_IDS.indexOf(foodId) !== -1) return true;
  return false;
}

/* ---------------- task D1: recipe options/variants — planner rotation ----------------
   A recipe's optionGroups choices don't carry their own `avoid` tag array (data/
   recipes.js's optionGroups doc) — a choice is disallowed for an avoid-list the same way
   a breakfast-pairing FOOD is: ingredient-derived, via foodHitsAvoid() above (lactose/
   gluten/shellfish/nuts by category/id), applied to every [foodId, grams] pair in the
   choice's own ingredients. */
function choiceHitsAvoid(choice, avoidList){
  if(!choice || !Array.isArray(choice.ingredients)) return false;
  return choice.ingredients.some(function(ing){ return foodHitsAvoid(ing[0], avoidList); });
}

// The choices of ONE group that survive `avoidList`, sorted by choice id — the "sorted by
// choice id" order the rotation formula below indexes into (FEATURES-2026-07-plan.md D1:
// "rotated ... modulo the ALLOWED choices, sorted by choice id").
function allowedChoicesForGroup(group, avoidList){
  return (group && Array.isArray(group.choices) ? group.choices : [])
    .filter(function(c){ return c && typeof c.id === 'string' && !choiceHitsAvoid(c, avoidList); })
    .slice()
    .sort(function(a, b){ return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0); });
}

// A recipe with optionGroups can only be planned under `avoidList` if EVERY group still
// has >=1 allowed choice — one empty group makes the whole dish unservable for that
// avoid-list, so the recipe drops from the candidate pool entirely (candidatesFor()
// above calls this for every recipe, options or not — recipes without optionGroups are
// always viable, unaffected). Recipes without optionGroups are always viable (true).
function recipeOptionsViable(recipe, avoidList){
  if(!recipe || !Array.isArray(recipe.optionGroups) || !recipe.optionGroups.length) return true;
  return recipe.optionGroups.every(function(group){ return allowedChoicesForGroup(group, avoidList).length > 0; });
}

// task D1 rotation formula: for each optionGroups group, index into that group's ALLOWED
// choices (sorted by id) at `(weekSeed + dayIndex*7 + slotIndex) % allowed.length` — the
// same dayIndex*7+slotIndex convention mealScore()'s own rotation term already uses
// elsewhere in this file, so "which day/slot this is" always folds in the same way.
// Zero randomness, zero Date.now — same (weekSeed, dayIndex, slotIndex, avoidList) always
// picks the same combo. Only called once the planner has already committed to `recipe`
// for this pick, i.e. after recipeOptionsViable(recipe, avoidList) gated the pool the
// recipe came from — every group is expected to have >=1 allowed choice; returns null
// (defensive, shouldn't happen given that gate) if one doesn't.
function chosenOptsForRecipe(recipe, weekSeed, dayIndex, slotIndex, avoidList){
  if(!recipe || !Array.isArray(recipe.optionGroups) || !recipe.optionGroups.length) return null;
  const opts = {};
  for(let i = 0; i < recipe.optionGroups.length; i++){
    const group = recipe.optionGroups[i];
    if(!group || typeof group.key !== 'string') continue;
    const allowed = allowedChoicesForGroup(group, avoidList);
    if(!allowed.length) return null;
    const idx = ((weekSeed || 0) + dayIndex * 7 + slotIndex) % allowed.length;
    opts[group.key] = allowed[idx].id;
  }
  return opts;
}

// Decisions Q2 whitelist (breads + fruit) — FOODS[id].breakfastPair === true — filtered by
// avoid-list and season (a summer breakfast shouldn't default-pair with a winter-only
// fruit), sorted for deterministic iteration.
function breakfastPairFoodIds(avoidList){
  return Object.keys(FOODS).filter(function(id){
    const f = FOODS[id];
    if(!f || f.breakfastPair !== true) return false;
    if(typeof foodSeason === 'function' && typeof currentSeasonKey === 'function'){
      const s = foodSeason(id);
      if(s !== 'evergreen' && s !== currentSeasonKey()) return false;
    }
    return !foodHitsAvoid(id, avoidList);
  }).sort();
}

// The natural candidate amounts for a breakfast-pairing food: whole pieces (1-2x avgG) for
// unit:'piece' foods, 30g steps up to 120g for everything else — fixed, deterministic
// candidates, no continuous search.
function foodPairingSteps(foodId){
  const food = FOODS[foodId];
  if(!food) return [];
  if(food.unit === 'piece') return BREAKFAST_PAIR_PIECE_STEPS.map(function(n){ return n * food.avgG; });
  return BREAKFAST_PAIR_GRAM_STEPS.slice();
}

// Pair pruning (B2 plan section 2): ranks a side pool against ONE main by combined-at-1x
// kcal fit and keeps only the top K (deterministic err-then-id tie-break), so composition
// stays O(mains x K) rather than O(mains x sides).
function topKSideIds(mainBaseKcal, sidePool, desiredKcal, k){
  const scored = sidePool.map(function(sideId){
    const sideBase = dbBaseNutrition(sideId);
    return {id: sideId, err: Math.abs(mainBaseKcal + sideBase.kcal - desiredKcal)};
  });
  scored.sort(function(a, b){
    if(Math.abs(a.err - b.err) > 1e-9) return a.err - b.err;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  });
  return scored.slice(0, k).map(function(s){ return s.id; });
}

// Light variety rule for sides/breakfast-pair foods (B2 plan section 5): drops any id used
// on the day right before dayIndex (window = 1 day) by any of the given persons — but,
// per the tagging handoff, SKIPS the rule (falls back to the unfiltered pool) rather than
// ever emptying an already-tiny pool.
function applyLightConsecutiveFilter(pool, prevDayUsedArrays){
  const usedYesterday = {};
  (prevDayUsedArrays || []).forEach(function(arr){ (arr || []).forEach(function(id){ usedYesterday[id] = true; }); });
  const filtered = pool.filter(function(id){ return !usedYesterday[id]; });
  return filtered.length ? filtered : pool;
}

// Records which side/food id a composed pick used that day, for the light consecutive-day
// rule above (history.<person>.sideUse / .bfPairUse, parallel to the existing per-slot
// history arrays). A no-op when the entry has no extras (full-recipe or standalone picks).
function recordCompositionUsage(history, entry, person, slot, dayIndex){
  if(!entry || !Array.isArray(entry.extras) || !entry.extras.length) return;
  const extra = entry.extras[0];
  const bucket = slot === 'breakfast' ? 'bfPairUse' : 'sideUse';
  if(!history[person][bucket][dayIndex]) history[person][bucket][dayIndex] = [];
  history[person][bucket][dayIndex].push(extra.recipeId || extra.foodId);
}

// task D1: component[0] (the base dish) carries `.opts` when `entry.opts` is set (the
// variant makePlanEntry/the recipe-screen write-back chose) — additive, so an entry
// without optionGroups (the overwhelming majority, still 100% of built-ins pre-D2) never
// gets an `opts` key at all and this stays byte-identical to pre-D1 output. Extras can
// carry their own `.opts` too (generic — no built-in side/extra has optionGroups yet, but
// nothing here assumes only the base does).
function planEntryComponents(entry){
  if(!entry || !entry.recipeId) return [];
  const base = {recipeId: entry.recipeId, portion: (typeof entry.portion === 'number' ? entry.portion : 1)};
  if(entry.opts && typeof entry.opts === 'object') base.opts = entry.opts;
  const components = [base];
  (entry.extras || []).forEach(function(extra){
    if(extra && extra.recipeId && RECIPES_DB[extra.recipeId]){
      const c = {recipeId: extra.recipeId, portion: (typeof extra.portion === 'number' && extra.portion > 0) ? extra.portion : 1};
      if(extra.opts && typeof extra.opts === 'object') c.opts = extra.opts;
      components.push(c);
    } else if(extra && extra.foodId && FOODS[extra.foodId]){
      components.push({foodId: extra.foodId, grams: (typeof extra.grams === 'number' && extra.grams > 0) ? extra.grams : 100});
    }
  });
  return components;
}

function planEntryNutrition(entry){
  if(!entry || !entry.recipeId || !RECIPES_DB[entry.recipeId]) return fallbackNutritionTotals(entry);
  return nutritionForRecipeComponents(planEntryComponents(entry));
}

function planEntryView(entry, shared){
  const nut = roundedNutritionTotals(planEntryNutrition(entry));
  const components = planEntryComponents(entry);
  return {
    recipeId: entry ? entry.recipeId : null,
    portion: entry && typeof entry.portion === 'number' ? entry.portion : 1,
    opts: components[0] && components[0].opts,
    components: components,
    extras: components.slice(1),
    kcal: nut.kcal,
    protein: nut.protein,
    carbs: nut.carbs,
    fat: nut.fat,
    satFat: nut.satFat,
    fiber: nut.fiber,
    sugars: nut.sugars,
    freeSugars: nut.freeSugars,
    shared: !!shared
  };
}

// task D1: `opts` (optional 4th param — {groupKey: choiceId}) is the variant the caller
// already decided on (planner rotation via chosenOptsForRecipe, or a recipe-screen
// chip switch); normalized against `recipeId`'s optionGroups so a bad/partial `opts`
// object can never stick. Only stored on the entry (and only feeds recipeNutrition, so
// entry.kcal/protein reflect the CHOSEN variant, not always the default) when the recipe
// actually carries optionGroups — an options-less recipe never gets an `opts` field at
// all, keeping every existing call site (which omits this param) byte-identical.
function makePlanEntry(recipeId, portion, stamp, opts){
  const r = (typeof RECIPES_DB !== 'undefined') ? RECIPES_DB[recipeId] : undefined;
  const hasOptions = !!(r && Array.isArray(r.optionGroups) && r.optionGroups.length);
  const normalizedOpts = hasOptions ? normalizeRecipeOpts(r, opts) : null;
  const nut = recipeNutrition(recipeId, portion, normalizedOpts).totals;
  const entry = {recipeId: recipeId, portion: portion, kcal: nut.kcal, protein: nut.protein};
  if(typeof stamp === 'number') entry.t = stamp;
  if(normalizedOpts && Object.keys(normalizedOpts).length) entry.opts = normalizedOpts;
  return entry;
}

function refreshPlanEntryNutrition(entry){
  if(!entry || !entry.recipeId || !RECIPES_DB[entry.recipeId]) return false;
  const nut = recipeNutrition(entry.recipeId, entry.portion, entry.opts).totals;
  const changed = Math.abs((entry.kcal || 0) - nut.kcal) > 1e-6 || Math.abs((entry.protein || 0) - nut.protein) > 1e-6;
  if(changed){
    entry.kcal = nut.kcal;
    entry.protein = nut.protein;
  }
  return changed;
}

function editableWeekPlan(weekStartDate){
  const monday = weekStartDate || mondayOfWeek(todayISO());
  let plan = weekPlans[monday];
  if(!plan && weekPlan && weekPlan.weekStartDate === monday) plan = weekPlan;
  if(!plan) plan = ensureWeekPlan(monday);
  weekPlans[monday] = plan;
  if(monday === mondayOfWeek(todayISO())) weekPlan = plan;
  return plan;
}

function markWeekPlanEdited(plan){
  if(!plan) return;
  recomputeProf('elena');
  recomputeProf('partner');
  plan.signature = computePlanSignature();
  weekPlans[plan.weekStartDate] = plan;
  if(plan.weekStartDate === mondayOfWeek(todayISO())) weekPlan = plan;
}

function loggedSlotLocked(dateISO, person, slot){
  return typeof slotLogStatus === 'function' && !!slotLogStatus(dateISO, person, slot);
}

// Guards preserveLoggedSlots/preservePinnedSlots against resurrecting a recipe that no
// longer exists in RECIPES_DB (e.g. tombstoned from the catalog): a log/pin restore must
// never re-introduce exactly the dangling reference ensureWeekPlan's
// planReferencesMissingRecipe() check just regenerated the plan to fix, or every future
// ensureWeekPlan() call stays permanently stale (regenerate, restore-back, regenerate...)
// and every renderer that assumes RECIPES_DB[recipeId] exists (renderTodayMeals) crashes.
function planEntryRecipeValid(entry){
  return !!(entry && entry.recipeId && RECIPES_DB[entry.recipeId]);
}
function mealRecipesValid(meal){
  if(!meal) return false;
  if(meal.shared) return !!(meal.recipeId && RECIPES_DB[meal.recipeId]);
  return planEntryRecipeValid(meal.elena) && planEntryRecipeValid(meal.partner);
}

function preserveLoggedSlots(oldPlan, newPlan){
  if(!oldPlan || !newPlan || !Array.isArray(oldPlan.days) || !Array.isArray(newPlan.days)) return;
  for(let d = 0; d < newPlan.days.length; d++){
    const dateISO = newPlan.days[d].date;
    SLOT_ORDER.forEach(function(slot){
      const oldMeal = oldPlan.days[d] && oldPlan.days[d].meals && oldPlan.days[d].meals[slot];
      const newMeal = newPlan.days[d] && newPlan.days[d].meals && newPlan.days[d].meals[slot];
      if(!oldMeal || !newMeal) return;
      const lockE = loggedSlotLocked(dateISO, 'elena', slot);
      const lockA = loggedSlotLocked(dateISO, 'partner', slot);
      if(!lockE && !lockA) return;
      if(oldMeal.shared || newMeal.shared){
        if(!mealRecipesValid(oldMeal)) return;
        newPlan.days[d].meals[slot] = JSON.parse(JSON.stringify(oldMeal));
        return;
      }
      // Both solo + both locked: whole-cell replace carries cell-level fields the
      // per-person path below doesn't, so prefer it — but only when BOTH sides are
      // still valid. If just one side is dangling (its recipe got tombstoned while the
      // other person's logged meal is still fine), don't drop the whole cell for that;
      // fall through to the per-person restore so the valid person keeps their log.
      if(lockE && lockA && mealRecipesValid(oldMeal)){
        newPlan.days[d].meals[slot] = JSON.parse(JSON.stringify(oldMeal));
        return;
      }
      if(lockE && oldMeal.elena && planEntryRecipeValid(oldMeal.elena)) newMeal.elena = JSON.parse(JSON.stringify(oldMeal.elena));
      if(lockA && oldMeal.partner && planEntryRecipeValid(oldMeal.partner)) newMeal.partner = JSON.parse(JSON.stringify(oldMeal.partner));
    });
  }
  refreshPlanNutrition(newPlan);
}

// Finds the LAST extra in entry.extras matching {recipeId} or {foodId} — duplicates are
// allowed on add, so remove/set take back the most-recently-added match. entry.extras
// never carries the base dish, so index 0 is a valid match (unlike the logged-meal
// components array in render.js, which reserves index 0 for the base). Returns -1 if
// entry/extras/match aren't found.
function findLastExtraIndex(entry, match){
  if(!entry || !Array.isArray(entry.extras)) return -1;
  for(let i = entry.extras.length - 1; i >= 0; i--){
    const extra = entry.extras[i];
    if(!extra) continue;
    if(match.recipeId !== undefined && extra.recipeId === match.recipeId) return i;
    if(match.foodId !== undefined && extra.foodId === match.foodId) return i;
  }
  return -1;
}

// Every meal-extra mutation (add/remove/set-portion/set-grams, for both recipe and plain-
// food extras) shares this shape: look up the plan/day/meal/person entry, apply mutateFn
// to it, stamp couple-sync timestamps, refresh nutrition, and — when the meal is shared —
// apply the SAME mutateFn to the other person's entry (a shared meal moves as one dish, so
// both sides always carry the same extras). mutateFn returns `false` to abort the whole
// mutation (e.g. nothing to remove, or a validation failure) before anything is stamped;
// any other return value means it succeeded.
//
// Stamp semantics: a shared meal keeps ONE timestamp on the meal cell (meal.t), since both
// people's entries move together; a solo meal stamps only entry.t and clears any stale
// meal.t so mergePlansSection compares at the right level. Getting these backwards
// resurrects the couple-sync revert bug fixed in commit 50f6f30.
function mutateMealExtras(weekStartDate, dayIndex, slot, person, mutateFn){
  const plan = editableWeekPlan(weekStartDate);
  if(!plan || !plan.days[dayIndex]) return false;
  const meal = plan.days[dayIndex].meals[slot];
  if(!meal || !meal[person]) return false;
  const entry = meal[person];
  if(mutateFn(entry) === false) return false;
  if(meal.shared) meal.t = Date.now(); else { entry.t = Date.now(); delete meal.t; }
  refreshPlanEntryNutrition(entry);
  const otherKey = person === 'elena' ? 'partner' : 'elena';
  if(meal.shared && meal[otherKey]){
    mutateFn(meal[otherKey]);
    refreshPlanEntryNutrition(meal[otherKey]);
  }
  markWeekPlanEdited(plan);
  return true;
}

function addExtraRecipeToMeal(weekStartDate, dayIndex, slot, person, recipeId){
  return mutateMealExtras(weekStartDate, dayIndex, slot, person, function(entry){
    if(!RECIPES_DB[recipeId]) return false;
    entry.extras = Array.isArray(entry.extras) ? entry.extras : [];
    entry.extras.push({recipeId: recipeId, portion: 1});
  });
}

function addExtraFoodToMeal(weekStartDate, dayIndex, slot, person, foodId, grams){
  const amount = (typeof grams === 'number' && grams > 0) ? grams : 100;
  return mutateMealExtras(weekStartDate, dayIndex, slot, person, function(entry){
    if(!FOODS[foodId]) return false;
    entry.extras = Array.isArray(entry.extras) ? entry.extras : [];
    entry.extras.push({foodId: foodId, grams: amount});
  });
}

// Unlike the add path above, remove does NOT require RECIPES_DB[recipeId]/FOODS[foodId] to
// still exist — we're dropping a reference already in the plan, not inserting a new one, so
// a recipe/food that later dropped out of its DB should still be removable.
function removeExtraRecipeFromMeal(weekStartDate, dayIndex, slot, person, recipeId){
  return mutateMealExtras(weekStartDate, dayIndex, slot, person, function(entry){
    const idx = findLastExtraIndex(entry, {recipeId: recipeId});
    if(idx === -1) return false;
    entry.extras.splice(idx, 1);
  });
}

function removeExtraFoodFromMeal(weekStartDate, dayIndex, slot, person, foodId){
  return mutateMealExtras(weekStartDate, dayIndex, slot, person, function(entry){
    const idx = findLastExtraIndex(entry, {foodId: foodId});
    if(idx === -1) return false;
    entry.extras.splice(idx, 1);
  });
}

function setExtraRecipePortion(weekStartDate, dayIndex, slot, person, recipeId, newPortion){
  return mutateMealExtras(weekStartDate, dayIndex, slot, person, function(entry){
    const idx = findLastExtraIndex(entry, {recipeId: recipeId});
    if(idx === -1) return false;
    entry.extras[idx].portion = newPortion;
  });
}

function setExtraFoodGrams(weekStartDate, dayIndex, slot, person, foodId, grams){
  const amount = Math.max(1, Math.min(2000, Math.round(grams)));
  return mutateMealExtras(weekStartDate, dayIndex, slot, person, function(entry){
    const idx = findLastExtraIndex(entry, {foodId: foodId});
    if(idx === -1) return false;
    entry.extras[idx].grams = amount;
  });
}

function refreshPlanNutrition(plan){
  if(!plan || !Array.isArray(plan.days)) return false;
  let changed = false;
  plan.days.forEach(function(day){
    SLOT_ORDER.forEach(function(slot){
      const meal = day.meals && day.meals[slot];
      if(!meal) return;
      if(refreshPlanEntryNutrition(meal.elena)) changed = true;
      if(refreshPlanEntryNutrition(meal.partner)) changed = true;
    });
  });
  return changed;
}

function mealPinPersonForMeal(meal, person){
  return meal && meal.shared ? 'shared' : person;
}

function mealPinKey(weekStartDate, dayIndex, slot, person){
  return [weekStartDate, dayIndex, slot, person].join('|');
}

function isMealPinned(weekStartDate, dayIndex, slot, person){
  return !!mealPins[mealPinKey(weekStartDate, dayIndex, slot, person)];
}

function isUnitPinned(plan, unit){
  const meal = plan.days[unit.dayIndex].meals[unit.slot];
  const person = unit.shared ? 'shared' : unit.person;
  return isMealPinned(plan.weekStartDate, unit.dayIndex, unit.slot, person || mealPinPersonForMeal(meal, currentProf));
}

function routineOccurrencePerson(plan, dayIndex, slot, person){
  const meal = plan && plan.days && plan.days[dayIndex] && plan.days[dayIndex].meals && plan.days[dayIndex].meals[slot];
  return mealPinPersonForMeal(meal, person);
}

function routineOccurrencePinKey(weekStartDate, dayIndex, slot, person){
  const plan = weekPlans[weekStartDate] || (weekPlan && weekPlan.weekStartDate === weekStartDate ? weekPlan : null);
  const pinPerson = routineOccurrencePerson(plan, dayIndex, slot, person);
  return mealPinKey(weekStartDate, dayIndex, slot, pinPerson);
}

function isRoutineOccurrencePinned(weekStartDate, dayIndex, slot, person){
  return !!mealPins[routineOccurrencePinKey(weekStartDate, dayIndex, slot, person)];
}

function setRoutineOccurrencePinned(weekStartDate, dayIndex, slot, person, pinned){
  const key = routineOccurrencePinKey(weekStartDate, dayIndex, slot, person);
  if(pinned) mealPins[key] = true;
  else delete mealPins[key];
  return !!mealPins[key];
}

function toggleRoutineOccurrencePinned(weekStartDate, dayIndex, slot, person){
  return setRoutineOccurrencePinned(weekStartDate, dayIndex, slot, person, !isRoutineOccurrencePinned(weekStartDate, dayIndex, slot, person));
}

function routineOccurrencesForRule(rule){
  const occurrences = [];
  if(!rule) return occurrences;
  Object.keys(weekPlans).sort().forEach(function(weekStartDate){
    const plan = weekPlans[weekStartDate];
    if(!plan || !Array.isArray(plan.days)) return;
    plan.days.forEach(function(day, dayIndex){
      if(mealRuleApplies(rule, day.date, dayIndex, rule.slot, rule.person)){
        occurrences.push({
          weekStartDate: weekStartDate,
          date: day.date,
          dayIndex: dayIndex,
          slot: rule.slot,
          person: routineOccurrencePerson(plan, dayIndex, rule.slot, rule.person),
          pinKey: routineOccurrencePinKey(weekStartDate, dayIndex, rule.slot, rule.person),
          pinned: isRoutineOccurrencePinned(weekStartDate, dayIndex, rule.slot, rule.person)
        });
      }
    });
  });
  return occurrences;
}

function setRoutineOccurrencesPinned(rule, pinned){
  const occurrences = routineOccurrencesForRule(rule);
  occurrences.forEach(function(occ){
    if(pinned) mealPins[occ.pinKey] = true;
    else delete mealPins[occ.pinKey];
    occ.pinned = !!pinned;
  });
  return occurrences;
}

function pinRoutineOccurrencesFrom(rule, fromDateISO){
  if(!rule || typeof fromDateISO !== 'string') return [];
  rule.pinFromDate = fromDateISO;
  ensureWeekPlan(mondayOfWeek(todayISO()));
  ensureWeekPlan(nextMondayISO());
  const occurrences = routineOccurrencesForRule(rule).filter(function(occ){ return occ.date >= fromDateISO; });
  occurrences.forEach(function(occ){
    mealPins[occ.pinKey] = true;
    occ.pinned = true;
  });
  return occurrences;
}

function unpinRoutineOccurrencesFrom(rule, fromDateISO){
  if(!rule || typeof fromDateISO !== 'string') return [];
  ensureWeekPlan(mondayOfWeek(todayISO()));
  ensureWeekPlan(nextMondayISO());
  const occurrences = routineOccurrencesForRule(rule).filter(function(occ){ return occ.date >= fromDateISO; });
  occurrences.forEach(function(occ){
    delete mealPins[occ.pinKey];
    occ.pinned = false;
  });
  delete rule.pinFromDate;
  return occurrences;
}

function canAutoMutateUnit(plan, unit){
  if(!plan || !unit || !Array.isArray(plan.days) || !plan.days[unit.dayIndex]) return false;
  const day = plan.days[unit.dayIndex];
  const meal = day.meals && day.meals[unit.slot];
  if(!meal) return false;
  if(diffDaysISO(day.date, todayISO()) < 0) return false;
  if(unit.shared || meal.shared){
    return !loggedSlotLocked(day.date, 'elena', unit.slot)
      && !loggedSlotLocked(day.date, 'partner', unit.slot)
      && !isMealPinned(plan.weekStartDate, unit.dayIndex, unit.slot, 'shared');
  }
  if(!unit.person) return false;
  return !loggedSlotLocked(day.date, unit.person, unit.slot)
    && !isMealPinned(plan.weekStartDate, unit.dayIndex, unit.slot, unit.person);
}

function preservePinnedSlots(oldPlan, newPlan){
  if(!oldPlan || !newPlan || !Array.isArray(oldPlan.days) || !Array.isArray(newPlan.days)) return;
  for(let d = 0; d < newPlan.days.length; d++){
    SLOT_ORDER.forEach(function(slot){
      const oldMeal = oldPlan.days[d] && oldPlan.days[d].meals && oldPlan.days[d].meals[slot];
      const newMeal = newPlan.days[d] && newPlan.days[d].meals && newPlan.days[d].meals[slot];
      if(!oldMeal || !newMeal) return;
      const pinShared = isMealPinned(newPlan.weekStartDate, d, slot, 'shared');
      const pinE = isMealPinned(newPlan.weekStartDate, d, slot, 'elena');
      const pinA = isMealPinned(newPlan.weekStartDate, d, slot, 'partner');
      if(!pinShared && !pinE && !pinA) return;
      if(pinShared || oldMeal.shared || newMeal.shared){
        if(!mealRecipesValid(oldMeal)) return;
        newPlan.days[d].meals[slot] = JSON.parse(JSON.stringify(oldMeal));
        return;
      }
      // Both solo + both pinned: whole-cell replace carries cell-level fields the
      // per-person path below doesn't, so prefer it — but only when BOTH sides are
      // still valid. If just one side is dangling (its recipe got tombstoned while the
      // other person's pinned meal is still fine), don't drop the whole cell for that;
      // fall through to the per-person restore so the valid person keeps their pin.
      if(pinE && pinA && mealRecipesValid(oldMeal)){
        newPlan.days[d].meals[slot] = JSON.parse(JSON.stringify(oldMeal));
        return;
      }
      if(pinE && oldMeal.elena && planEntryRecipeValid(oldMeal.elena)) newMeal.elena = JSON.parse(JSON.stringify(oldMeal.elena));
      if(pinA && oldMeal.partner && planEntryRecipeValid(oldMeal.partner)) newMeal.partner = JSON.parse(JSON.stringify(oldMeal.partner));
    });
  }
  refreshPlanNutrition(newPlan);
}

// Applies a real user-authored meal-routine rule to a stored plan cell. Stamped exactly
// like applySwapToPlan (Date.now() for the real edit) so sync.js:mergePlansSection treats
// a routine-set meal as a real edit instead of losing to any stamped remote change (the
// bug fixed alongside commit 50f6f30's swap-revert fix) — shared cell stamps meal.t as a
// whole, solo stamps the person's entry and clears any stale meal.t.
function setMealRecipe(plan, dayIndex, slot, person, recipeId){
  const meal = plan.days[dayIndex].meals[slot];
  if(!meal || !RECIPES_DB[recipeId]) return false;
  if(recipeSlotList(RECIPES_DB[recipeId]).indexOf(slot) === -1) return false;
  const now = Date.now();
  if(person === 'shared'){
    if(!meal.shared) return false;
    meal.recipeId = recipeId;
    meal.elena = makePlanEntry(recipeId, meal.elena.portion);
    meal.partner = makePlanEntry(recipeId, meal.partner.portion);
    meal.t = now;
  } else {
    if(meal.shared) return false;
    meal[person] = makePlanEntry(recipeId, meal[person].portion, now);
    delete meal.t;
  }
  return true;
}

function mealRuleApplies(rule, dateISO, dayIndex, slot, person){
  if(!rule || rule.slot !== slot || rule.person !== person) return false;
  if(!RECIPES_DB[rule.recipeId] || recipeSlotList(RECIPES_DB[rule.recipeId]).indexOf(slot) === -1) return false;
  if(rule.cadence === 'daily') return true;
  if(rule.cadence === 'weekly') return dayIndex === rule.dayIndex;
  if(rule.cadence === 'alternate'){
    const anchor = rule.anchorDate || dateISO;
    return Math.abs(diffDaysISO(dateISO, anchor)) % 2 === 0;
  }
  return false;
}

function applyMealRulesToPlan(plan){
  if(!plan || !Array.isArray(plan.days) || !mealRules.length) return false;
  let changed = false;
  plan.days.forEach(function(day, dayIndex){
    SLOT_ORDER.forEach(function(slot){
      const meal = day.meals[slot];
      const units = meal.shared ? ['shared'] : ['elena', 'partner'];
      units.forEach(function(person){
        if(isMealPinned(plan.weekStartDate, dayIndex, slot, person)) return;
        mealRules.forEach(function(rule){
          if(!mealRuleApplies(rule, day.date, dayIndex, slot, person)) return;
          if(setMealRecipe(plan, dayIndex, slot, person, rule.recipeId)) changed = true;
        });
      });
    });
  });
  return changed;
}

function applyMealRulesToStoredPlans(){
  let changed = false;
  Object.keys(weekPlans).forEach(function(wk){
    if(applyMealRulesToPlan(weekPlans[wk])) changed = true;
    refreshPlanNutrition(weekPlans[wk]);
  });
  weekPlan = weekPlans[mondayOfWeek(todayISO())] || weekPlan;
  return changed;
}

// Picks the portion (0.5 steps, 0.5-3x, or 0.5-maxPortion when capped) that lands closest
// to desiredKcal; ties broken toward the person's natural anchor (Elena 1x, Andrea 1.5x)
// so portions stay sane rather than drifting to arbitrary extremes when multiple steps
// tie on kcal. maxPortion defaults to 3 (the old uncapped behavior) — callers pass
// SLOT_MAX_PORTION[slot] to apply the breakfast/snack cap (task C3 item 3).
function bestPortion(baseKcal, desiredKcal, anchor, maxPortion){
  maxPortion = (typeof maxPortion === 'number' && maxPortion > 0) ? maxPortion : 3;
  if(!(baseKcal > 0)) return {portion: 1, kcal: 0, err: Math.abs(desiredKcal), anchorDist: 0};
  let best = null;
  PORTION_STEPS.filter(function(p){ return p <= maxPortion; }).forEach(function(portion){
    const kcal = baseKcal * portion;
    const err = Math.abs(kcal - desiredKcal);
    const anchorDist = Math.abs(portion - anchor);
    const better = !best || err < best.err - 1e-9 || (Math.abs(err - best.err) <= 1e-9 && anchorDist < best.anchorDist - 1e-9);
    if(better) best = {portion: portion, kcal: kcal, err: err, anchorDist: anchorDist};
  });
  return best;
}

/* ---------------- variety + scoring ---------------- */
// history[person][slot] is a sparse array of recipe ids by day index. Gap since the
// recipe was last used in this slot for this person; Infinity if never used.
function lastUsedGap(history, person, slot, dayIndex, recipeId){
  const arr = history[person][slot];
  let lastUsed = -1;
  for(let d = 0; d < dayIndex; d++){ if(arr[d] === recipeId) lastUsed = d; }
  return lastUsed === -1 ? Infinity : dayIndex - lastUsed;
}

// Rule (e) as a HARD filter (a soft penalty loses to the kcal term and yields 7
// identical breakfasts): a candidate is "fresh" if it hasn't been used in this slot in
// the last 3 days — and, for dinner, not at all this week. If no candidate is fresh
// (pool too small), relax exactly as specified: keep only the candidates with the
// LONGEST gap since last use, and score among those.
function applyVarietyFilter(pool, history, person, slot, dayIndex){
  const gaps = {};
  pool.forEach(function(id){ gaps[id] = lastUsedGap(history, person, slot, dayIndex, id); });
  const fresh = pool.filter(function(id){
    return gaps[id] > 3 && (slot !== 'dinner' || gaps[id] === Infinity);
  });
  if(fresh.length) return fresh;
  let maxGap = -1;
  pool.forEach(function(id){ if(gaps[id] > maxGap) maxGap = gaps[id]; });
  return pool.filter(function(id){ return gaps[id] === maxGap; });
}

// Cross-week variety (two-week horizon) — a HARD filter, the same mechanism the
// within-week variety rule above uses. A rotation-score nudge was tried first and
// verified to change NOTHING for the default household (0/28 slot choices differed):
// the #1-vs-#2 candidate score gap at every decision was 7-82 points, far beyond any
// tie-break term's reach — so cross-week variety must be a filter, not a score term.
// When generating week N, the recipe chosen for the SAME (day, slot[, person]) in the
// PREVIOUS week's stored plan (weekPlans[weekStartDate − 7d]) is excluded from the
// candidate pool. Relaxation identical to the within-week rule: if the exclusion empties
// the pool, fall back to the full pool — constraints and the ±5%/day guarantee always
// win over variety. If the previous week isn't in the store at all (first-ever
// generation, or pruned — the normal case when regenerating the CURRENT week, since last
// week is pruned on load), the filter is skipped. Deterministic: the previous week's
// stored plan is itself a deterministic input, so same inputs -> same exclusions ->
// byte-identical output.
function applyCrossWeekFilter(pool, excludeId){
  if(!excludeId) return pool;
  const filtered = pool.filter(function(id){ return id !== excludeId; });
  return filtered.length ? filtered : pool;
}

// Weighted so priority (c) kcal-fit > (d) protein-fit; variety (e) is the hard filter
// above. The tiny rotation term only breaks ties that survive both (deterministic — a
// stable hash of day/slot/recipe id folded with a stable hash of the WEEK's Monday, no
// randomness). weekSeed shifts those tie-breaks between weeks; it is a SECONDARY
// mechanism only — the primary cross-week variety is applyCrossWeekFilter() above (a
// score-sized nudge can't outvote the kcal term; a hard filter doesn't have to).
function mealScore(actualKcal, desiredKcal, actualProtein, desiredProtein, dayIndex, slotIndex, recipeId, weekSeed){
  const kcalErr = Math.abs(actualKcal - desiredKcal) / Math.max(Math.abs(desiredKcal), 1);
  const proteinShort = desiredProtein > 0 ? Math.max(0, desiredProtein - actualProtein) / desiredProtein : 0;
  const rotation = ((dayIndex * 7 + slotIndex + stableHash(recipeId) + (weekSeed || 0)) % 97) / 97;
  const prefBoost = recipePref(recipeId) === 'favorite' ? 35 : 0;
  return -(kcalErr * 1000) - (proteinShort * 100) + prefBoost + rotation * 0.5;
}

/* ---------------- task C2 (2026-07-18): next-week tuning bonus ----------------
   tuningBonus(totals, tuningKey) is a small deterministic secondary term ADDED to
   mealScore's result (both pickSharedMeal and pickSoloMeal, below) for the candidate
   whose kcal/protein already went into that mealScore call. Magnitude analysis, read off
   mealScore() above: a candidate's kcal-fit term (kcalErr*1000) typically separates real
   candidates by tens of points whenever their portion search lands at meaningfully
   different kcal residuals, and can reach ~1000 for a wildly-off pick; the protein-fit
   term (proteinShort*100) is 0-100; prefBoost is a flat 35; the existing rotation
   tie-break is the smallest term in the system at 0-0.5. tuningBonus must sit clearly
   ABOVE rotation (or it would never survive being a real secondary signal) but clearly
   BELOW kcal/protein-fit (or it would distort the targets the old banner promised to
   keep — "same calories and protein"). 'none' returns exactly 0 regardless of weight — no
   term, no floating-point-visible change to the score at all (x + 0 === x), which is what
   keeps plan generation bit-identical to pre-this-batch output at the default.
     protein / fiber : +weight * (grams / norm)      — norm ~= a "big" meal's grams for
                        that nutrient (40g protein, 8g fiber).
     lowSugar        : -weight * (freeSugars / 15)    — 15g norm ~= a moderately sweet meal.
     lowSatFat       : -weight * (satFat / fat)        — already a natural 0..1 share, no
                        norm needed; 0 when the unit has no fat at all.
     omega3          : +weight flat, once, if ANY recipe in the composed unit (main or its
                        recipe extra — a plain paired FOOD extra doesn't count, per the
                        plan's "any recipe in the unit") carries the omega3 tag or
                        ingredient-flag (recipeFlagSet/hasTag, state.js). Binary, so it's
                        exactly the cap either way.

   TUNING_WEIGHT=15 (caps each tuning term at 15 points) is the result of an empirical
   investigation, not just the formula above — worth recording since a first pass at
   TUNING_WEIGHT=4 (a stricter reading of "low relative to kcal/protein-fit": under half
   of proteinShort's 100, a tenth of kcalErr's ~1000) turned out to violate the 'protein'
   fortnight weak-monotonic test (tools/check.js) by a small margin (fortnight total
   protein ~0.2% BELOW the 'none' plan's). Root-caused with a debug harness (not checked
   in) that dumped per-candidate scores at the exact flipped slot: the regression was NOT
   tuningBonus favoring a lower-protein candidate (it never does — it's a monotonic
   function of totals.protein) but a knock-on effect of the PRE-EXISTING water-filling
   remaining-budget mechanism in generateWeek(): an earlier same-day slot's tuning-nudged
   choice already delivered more protein, so remainingProtein (and therefore that day's
   LATER slot's desiredProt) shrank, which shrank mealScore's OWN proteinShort penalty for
   a low-protein candidate enough to let it win on kcal-fit alone — a pre-existing
   mechanism (the current rotation tie-break can trigger the identical cascade) that a
   bounded per-candidate nudge cannot categorically prevent. A weight sweep (1-30) confirmed
   this isn't "weight too low" in the sense the plan warns about special-casing: weights
   1-10 stayed inert-or-regressed on this exact fixture (protein delta 0.00 at 1, then
   negative at 2/3/4/5/6/8/10) and only >=15 turned all three required directions
   (protein/fiber up, freeSugars down) non-negative for the real default household on
   FIXED_MONDAY — verified with both the full fortnight and a frozen-current-week/
   next-week-only isolation (ruling out cross-week filter noise as the sole cause). 15 is
   still a fraction of kcalErr's scale and under half of prefBoost (35), so a favorited
   recipe or a genuinely-better kcal fit still wins — it just needed to be bigger than 4 to
   reliably beat the existing proteinShort/kcalErr terms' OWN budget-driven noise floor on
   this dataset. See tools/check.js testNextWeekTuning for the pinned assertions. */
const TUNING_WEIGHT = 15;
const TUNING_PROTEIN_NORM = 40; // grams — a high-protein full meal
const TUNING_FIBER_NORM = 8;    // grams — a high-fiber meal/side
const TUNING_SUGAR_NORM = 15;   // grams — a moderately sweet meal

function recipeHasOmega3(recipeId){
  const r = RECIPES_DB[recipeId];
  if(!r) return false;
  return hasTag(r, 'omega3') || !!recipeFlagSet(recipeId).omega3;
}

// Scales one recipe's nutrition totals (already at 1x/dbBaseNutrition) by a portion —
// only the fields tuningBonus needs, not a full nutrition object.
function scaleNutrientTotals(base, portion){
  return {protein: base.protein * portion, fiber: base.fiber * portion, freeSugars: base.freeSugars * portion, fat: base.fat * portion, satFat: base.satFat * portion};
}
function addNutrientTotals(a, b){
  return {protein: a.protein + b.protein, fiber: a.fiber + b.fiber, freeSugars: a.freeSugars + b.freeSugars, fat: a.fat + b.fat, satFat: a.satFat + b.satFat};
}
function withOmega3(totals, flag){ totals.hasOmega3 = flag; return totals; }

function tuningBonus(totals, tuningKey){
  if(!totals || tuningKey === 'none') return 0;
  if(tuningKey === 'protein') return TUNING_WEIGHT * (totals.protein / TUNING_PROTEIN_NORM);
  if(tuningKey === 'fiber') return TUNING_WEIGHT * (totals.fiber / TUNING_FIBER_NORM);
  if(tuningKey === 'lowSugar') return -TUNING_WEIGHT * (totals.freeSugars / TUNING_SUGAR_NORM);
  if(tuningKey === 'lowSatFat') return -TUNING_WEIGHT * (totals.fat > 0 ? totals.satFat / totals.fat : 0);
  if(tuningKey === 'omega3') return totals.hasOmega3 ? TUNING_WEIGHT : 0;
  return 0; // unknown key (shouldn't happen — state.js validates on load/sync) behaves like 'none'
}

/* ---------------- week generation ---------------- */
// seed = {weekStartDate, signature} — pure function of these plus the live PROF/SHARED/
// householdStyle state AND weekPlans[weekStartDate − 7d] (the previous week's stored
// plan, read-only input to the cross-week variety filter; itself deterministic). No
// Math.random/Date.now inside, so calling this twice with the same PROF/SHARED/
// householdStyle, the same weekStartDate and the same stored previous week yields
// byte-identical JSON.
//
// ORDERING IMPLICATION (two-week horizon): generating NEXT week consults the CURRENT
// week's stored plan — so the current week must be resolved first. ensureWeekPlan()
// (below) guarantees that ordering: it always freshens the current week before any
// other week, and eagerly re-freshens a stored next week whenever the current week
// just regenerated (signature change), so the pair stays consistent.
function generateWeek(seed){
  const weekStartDate = seed.weekStartDate;
  const signature = seed.signature;
  const styleKey = STYLE_DB_KEY[householdStyle] || 'balanced';
  const dayTarget = {
    elena: {kcal: PROF.elena.calGoalNum, protein: PROF.elena.targetP},
    partner: {kcal: PROF.partner.calGoalNum, protein: PROF.partner.targetP}
  };
  const avoidList = {
    elena: (PROF.elena.avoid || []).slice(),
    partner: (PROF.partner.avoid || []).slice()
  };

  const history = {elena: {}, partner: {}};
  SLOT_ORDER.forEach(function(s){ history.elena[s] = []; history.partner[s] = []; });
  // task B2: parallel "what composed side/breakfast-pair id did this person use on day N"
  // logs, keyed by dayIndex (sparse), for the light consecutive-day variety rule — separate
  // from the main-recipe history arrays above, which main/full ids still join unchanged.
  history.elena.sideUse = {}; history.partner.sideUse = {};
  history.elena.bfPairUse = {}; history.partner.bfPairUse = {};

  // weekSeed: deterministic per-week tie-break shift (see mealScore doc) — kept as a
  // secondary mechanism; the primary cross-week variety is the prevPlan filter below.
  const weekSeed = stableHash(weekStartDate);

  // Cross-week variety filter input: the PREVIOUS week's stored plan, if any (see
  // applyCrossWeekFilter doc). prevRecipeId(d, slot, person) is what that person ate at
  // the same (day, slot) last week — null when there's no stored previous week, which
  // disables the filter for that pick.
  const prevPlan = weekPlans[addDaysISO(weekStartDate, -7)] || null;
  function prevRecipeId(dayIndex, slot, person){
    if(!prevPlan || !prevPlan.days || !prevPlan.days[dayIndex]) return null;
    const m = prevPlan.days[dayIndex].meals && prevPlan.days[dayIndex].meals[slot];
    if(!m) return null;
    return m.shared ? m.recipeId : ((m[person] && m[person].recipeId) || null);
  }

  const days = [];
  for(let d = 0; d < 7; d++){
    const remainingKcal = {elena: dayTarget.elena.kcal, partner: dayTarget.partner.kcal};
    const remainingProtein = {elena: dayTarget.elena.protein, partner: dayTarget.partner.protein};
    let remainingWeight = 1;
    const dayMeals = {};
    SLOT_ORDER.forEach(function(slot, si){
      const w = SLOT_WEIGHT[slot];
      const shared = !!SHARED[slot];
      if(shared){
        const avoidBoth = unionAvoid(avoidList.elena, avoidList.partner);
        const pool = candidatesFor(slot, styleKey, avoidBoth);
        // For shared slots both people ate the same dish last week — Elena's entry stands
        // for both (same convention as the variety filter's history handling).
        const chosen = pickSharedMeal(pool.length ? pool : candidatesFor(slot, styleKey, avoidBoth, {includeThumbsDown: true}), slot, d, si, remainingKcal, remainingProtein, remainingWeight, history, weekSeed, prevRecipeId(d, slot, 'elena'));
        dayMeals[slot] = chosen;
        // Deduct the WHOLE unit (main + any composed extra) via planEntryNutrition, not the
        // raw entry.kcal/protein cache (which — like every existing manual meal-extra —
        // stays base-recipe-only; see makePlanEntry/refreshPlanEntryNutrition). Identical to
        // the old `chosen.elena.kcal` deduction whenever there's no extra, since
        // planEntryNutrition({recipeId,portion}) === recipeNutrition(recipeId,portion) then.
        const sharedNutE = planEntryNutrition(chosen.elena), sharedNutA = planEntryNutrition(chosen.partner);
        remainingKcal.elena -= sharedNutE.kcal; remainingKcal.partner -= sharedNutA.kcal;
        remainingProtein.elena -= sharedNutE.protein; remainingProtein.partner -= sharedNutA.protein;
        history.elena[slot][d] = chosen.recipeId; history.partner[slot][d] = chosen.recipeId;
        recordCompositionUsage(history, chosen.elena, 'elena', slot, d);
        recordCompositionUsage(history, chosen.partner, 'partner', slot, d);
      } else {
        const poolE = candidatesFor(slot, styleKey, avoidList.elena);
        const poolA = candidatesFor(slot, styleKey, avoidList.partner);
        const chE = pickSoloMeal(poolE.length ? poolE : candidatesFor(slot, styleKey, [], {includeThumbsDown: true}), 'elena', slot, d, si, remainingKcal.elena, remainingProtein.elena, remainingWeight, history, weekSeed, prevRecipeId(d, slot, 'elena'));
        const chA = pickSoloMeal(poolA.length ? poolA : candidatesFor(slot, styleKey, [], {includeThumbsDown: true}), 'partner', slot, d, si, remainingKcal.partner, remainingProtein.partner, remainingWeight, history, weekSeed, prevRecipeId(d, slot, 'partner'));
        dayMeals[slot] = {shared: false, elena: chE, partner: chA};
        const soloNutE = planEntryNutrition(chE), soloNutA = planEntryNutrition(chA);
        remainingKcal.elena -= soloNutE.kcal; remainingKcal.partner -= soloNutA.kcal;
        remainingProtein.elena -= soloNutE.protein; remainingProtein.partner -= soloNutA.protein;
        history.elena[slot][d] = chE.recipeId; history.partner[slot][d] = chA.recipeId;
        recordCompositionUsage(history, chE, 'elena', slot, d);
        recordCompositionUsage(history, chA, 'partner', slot, d);
      }
      remainingWeight -= w;
    });
    days.push({date: addDaysISO(weekStartDate, d), meals: dayMeals});
  }
  return {v: 1, weekStartDate: weekStartDate, signature: signature, days: days};
}

// task B2: builds every composed breakfast candidate for ONE role:'main' recipe — the
// standalone pick (bp already computed by the caller, reused so "a light breakfast alone"
// and "light breakfast + fruit" share the same main portion) plus one paired candidate per
// whitelisted, avoid/season/variety-filtered breakfastPair food, each at whichever fixed
// gram/piece step lands closest to the remaining gap (desired − standalone main kcal).
// `push` is called once per candidate with (tieId, kcalTotal, proteinTotal, extra|null).
function pushBreakfastPairCandidates(push, mainId, mainBase, bp, desired, foodPool){
  foodPool.forEach(function(foodId){
    let bestStep = null;
    foodPairingSteps(foodId).forEach(function(grams){
      const m = foodMacros(foodId, grams);
      const err = Math.abs(bp.kcal + m.kcal - desired);
      const better = !bestStep || err < bestStep.err - 1e-9 || (Math.abs(err - bestStep.err) <= 1e-9 && grams < bestStep.grams);
      if(better) bestStep = {grams: grams, kcal: m.kcal, protein: m.protein, err: err};
    });
    if(!bestStep) return;
    push(mainId + '|bf|' + foodId, bp.kcal + bestStep.kcal, mainBase.protein * bp.portion + bestStep.protein, {foodId: foodId, grams: bestStep.grams});
  });
}

// task B2: builds every composed lunch/dinner candidate for ONE role:'main' recipe against
// ONE person's desired kcal — top-K sides (topKSideIds) x fixed side-portion steps {0.5,1},
// main portion re-searched via bestPortion against (desired − side kcal at that step).
// `push` is called once per (side, sidePortion) candidate.
function pushComposedSideCandidates(push, mainId, mainBase, desired, anchor, maxPortion, sidePool, topSideIds){
  topSideIds.forEach(function(sideId){
    const sideBase = dbBaseNutrition(sideId);
    [0.5, 1].forEach(function(sidePortion){
      const sideKcal = sideBase.kcal * sidePortion, sideProtein = sideBase.protein * sidePortion;
      const bp = bestPortion(mainBase.kcal, desired - sideKcal, anchor, maxPortion);
      push(mainId + '|side|' + sideId + '@' + sidePortion, bp.kcal + sideKcal, mainBase.protein * bp.portion + sideProtein, {recipeId: sideId, portion: sidePortion}, bp.portion);
    });
  });
}

function pickSharedMeal(pool, slot, dayIndex, slotIndex, remainingKcal, remainingProtein, remainingWeight, history, weekSeed, excludePrevWeekId){
  const w = SLOT_WEIGHT[slot];
  const desiredE = remainingKcal.elena * (w / remainingWeight);
  const desiredA = remainingKcal.partner * (w / remainingWeight);
  const desiredProtE = remainingProtein.elena * (w / remainingWeight);
  const desiredProtA = remainingProtein.partner * (w / remainingWeight);
  // Cross-week filter first (falls back to the full pool if it would empty it), then the
  // within-week variety filter over Elena's history — for shared slots both histories are
  // written in sync, so hers stands for both.
  pool = applyCrossWeekFilter(pool, excludePrevWeekId);
  pool = applyVarietyFilter(pool, history, 'elena', slot, dayIndex);
  const maxPortion = SLOT_MAX_PORTION[slot];
  // task D1: hoisted above the slot branches below (breakfast/lunch/dinner already
  // computed this further down for the composed-pair pools) so the final opts-rotation
  // step after `best` is picked can use it regardless of slot, snack included.
  const avoidBoth = unionAvoid(PROF.elena.avoid || [], PROF.partner.avoid || []);

  // candidates: {tieId, mainId, extra: null|{recipeId,portion}|{foodId,grams},
  //              portionE, portionA, kcalE, kcalA, proteinE, proteinA,
  //              totalsE, totalsA (task C2, 2026-07-18: per-person combined-unit nutrition
  //              fed to tuningBonus() below — {protein,fiber,freeSugars,fat,satFat,hasOmega3})}
  const candidates = [];
  function pushFull(id, base, bpE, bpA){
    const hasO3 = recipeHasOmega3(id);
    candidates.push({tieId: id, mainId: id, extra: null,
      portionE: bpE.portion, portionA: bpA.portion,
      kcalE: bpE.kcal, kcalA: bpA.kcal,
      proteinE: base.protein * bpE.portion, proteinA: base.protein * bpA.portion,
      totalsE: withOmega3(scaleNutrientTotals(base, bpE.portion), hasO3),
      totalsA: withOmega3(scaleNutrientTotals(base, bpA.portion), hasO3)});
  }

  if(slot === 'snack'){
    // Snack never composes — every id in the pool (any role) is a standalone pick,
    // exactly today's behavior (B2 tagging handoff).
    pool.forEach(function(id){
      const base = dbBaseNutrition(id);
      const bpE = bestPortion(base.kcal, desiredE, PERSON_ANCHOR.elena, maxPortion);
      const bpA = bestPortion(base.kcal, desiredA, PERSON_ANCHOR.partner, maxPortion);
      pushFull(id, base, bpE, bpA);
    });
  } else {
    const fullIds = pool.filter(function(id){ return RECIPES_DB[id].role === 'full'; });
    const mainIds = pool.filter(function(id){ return RECIPES_DB[id].role === 'main'; });
    fullIds.forEach(function(id){
      const base = dbBaseNutrition(id);
      const bpE = bestPortion(base.kcal, desiredE, PERSON_ANCHOR.elena, maxPortion);
      const bpA = bestPortion(base.kcal, desiredA, PERSON_ANCHOR.partner, maxPortion);
      pushFull(id, base, bpE, bpA);
    });

    if(slot === 'breakfast'){
      const foodPoolRaw = breakfastPairFoodIds(avoidBoth);
      const foodPool = applyLightConsecutiveFilter(foodPoolRaw, [history.elena.bfPairUse[dayIndex - 1], history.partner.bfPairUse[dayIndex - 1]]);
      mainIds.forEach(function(id){
        const base = dbBaseNutrition(id);
        const bpE = bestPortion(base.kcal, desiredE, PERSON_ANCHOR.elena, maxPortion);
        const bpA = bestPortion(base.kcal, desiredA, PERSON_ANCHOR.partner, maxPortion);
        pushFull(id, base, bpE, bpA); // standalone role:'main' breakfast remains legal
        // Paired candidates need each person's OWN kcal/protein total, but the extra
        // (food+grams) must be the SAME for both (shared dish) — build each side's totals
        // per person, then only keep candidates where both persons' step search picked the
        // same food (grams may differ per person's remaining gap; see below).
        pushBreakfastPairCandidates(function(tieId, kcalE, proteinE, extraE){
          // Re-run the same food's step search against Elena's target to get her totals,
          // and against Andrea's target for his — both share `extraE.foodId`, but each
          // person's grams are chosen independently against their own desired kcal (same
          // convention lunch/dinner's shared side-portion-but-per-person-main uses).
          let bestStepA = null;
          foodPairingSteps(extraE.foodId).forEach(function(grams){
            const m = foodMacros(extraE.foodId, grams);
            const err = Math.abs(bpA.kcal + m.kcal - desiredA);
            const better = !bestStepA || err < bestStepA.err - 1e-9 || (Math.abs(err - bestStepA.err) <= 1e-9 && grams < bestStepA.grams);
            if(better) bestStepA = {grams: grams, kcal: m.kcal, protein: m.protein, err: err};
          });
          const hasO3 = recipeHasOmega3(id); // extra here is a plain FOOD, never counts toward omega3
          const foodMacrosE = foodMacros(extraE.foodId, extraE.grams);
          const foodMacrosA = foodMacros(extraE.foodId, bestStepA.grams);
          candidates.push({
            tieId: tieId, mainId: id, extra: {foodId: extraE.foodId, gramsE: extraE.grams, gramsA: bestStepA.grams},
            portionE: bpE.portion, portionA: bpA.portion,
            kcalE: kcalE, kcalA: bpA.kcal + bestStepA.kcal,
            proteinE: proteinE, proteinA: base.protein * bpA.portion + bestStepA.protein,
            totalsE: withOmega3(addNutrientTotals(scaleNutrientTotals(base, bpE.portion), foodMacrosE), hasO3),
            totalsA: withOmega3(addNutrientTotals(scaleNutrientTotals(base, bpA.portion), foodMacrosA), hasO3)
          });
        }, id, base, bpE, desiredE, foodPool);
      });
    } else if(slot === 'lunch' || slot === 'dinner'){
      const sidePoolRaw = sidePoolFor(avoidBoth);
      const sidePool = applyLightConsecutiveFilter(sidePoolRaw, [history.elena.sideUse[dayIndex - 1], history.partner.sideUse[dayIndex - 1]]);
      if(sidePool.length){
        mainIds.forEach(function(mainId){
          const mainBase = dbBaseNutrition(mainId);
          const topsE = topKSideIds(mainBase.kcal, sidePool, desiredE, SIDE_TOP_K);
          const topsA = topKSideIds(mainBase.kcal, sidePool, desiredA, SIDE_TOP_K);
          const topsSet = {};
          topsE.concat(topsA).forEach(function(id){ topsSet[id] = true; });
          const tops = Object.keys(topsSet).sort();
          // Side portion is shared (same dish, same amount for both); main portion is
          // searched per person against (desired − side kcal at that shared portion).
          tops.forEach(function(sideId){
            const sideBase = dbBaseNutrition(sideId);
            [0.5, 1].forEach(function(sidePortion){
              const sideKcal = sideBase.kcal * sidePortion, sideProtein = sideBase.protein * sidePortion;
              const bpE = bestPortion(mainBase.kcal, desiredE - sideKcal, PERSON_ANCHOR.elena, maxPortion);
              const bpA = bestPortion(mainBase.kcal, desiredA - sideKcal, PERSON_ANCHOR.partner, maxPortion);
              const hasO3 = recipeHasOmega3(mainId) || recipeHasOmega3(sideId);
              const sideTotals = scaleNutrientTotals(sideBase, sidePortion);
              candidates.push({
                tieId: mainId + '|side|' + sideId + '@' + sidePortion, mainId: mainId, extra: {recipeId: sideId, portion: sidePortion},
                portionE: bpE.portion, portionA: bpA.portion,
                kcalE: bpE.kcal + sideKcal, kcalA: bpA.kcal + sideKcal,
                proteinE: mainBase.protein * bpE.portion + sideProtein, proteinA: mainBase.protein * bpA.portion + sideProtein,
                totalsE: withOmega3(addNutrientTotals(scaleNutrientTotals(mainBase, bpE.portion), sideTotals), hasO3),
                totalsA: withOmega3(addNutrientTotals(scaleNutrientTotals(mainBase, bpA.portion), sideTotals), hasO3)
              });
            });
          });
        });
      }
    }
  }

  let best = null;
  candidates.forEach(function(c){
    // mealScore's rotation/favorite-boost is keyed on the real MAIN recipe id (mainId) —
    // never the composite tieId — so a composed unit's score treats "which main" exactly
    // like a full-recipe pick would (Q1: no bias for/against composing). tieId is used
    // ONLY for the final deterministic tie-break below.
    const scoreE = mealScore(c.kcalE, desiredE, c.proteinE, desiredProtE, dayIndex, slotIndex, c.mainId, weekSeed) + tuningBonus(c.totalsE, nextWeekTuning);
    const scoreA = mealScore(c.kcalA, desiredA, c.proteinA, desiredProtA, dayIndex, slotIndex, c.mainId, weekSeed) + tuningBonus(c.totalsA, nextWeekTuning);
    const total = scoreE + scoreA;
    const better = !best || total > best.total + 1e-9 || (Math.abs(total - best.total) <= 1e-9 && c.tieId < best.tieId);
    if(better) best = Object.assign({total: total}, c);
  });
  if(!best){
    console.error('pickSharedMeal: empty candidate pool for slot="' + slot + '" style="' + householdStyle + '" — check RECIPES_DB coverage for this avoid-list combination.');
    return {shared: true, recipeId: null, elena: {recipeId: null, portion: 1, kcal: 0, protein: 0}, partner: {recipeId: null, portion: 1, kcal: 0, protein: 0}};
  }
  // task D1: the SAME variant for both people (one shared dish) — rotated deterministically
  // off (weekSeed, dayIndex, slotIndex) over the choices allowed under avoidBoth (both
  // people's avoid-lists, per the plan's "both people for shared slots"). null for a
  // recipe without optionGroups; makePlanEntry's own normalizeRecipeOpts no-ops on null.
  const sharedOpts = chosenOptsForRecipe(RECIPES_DB[best.mainId], weekSeed, dayIndex, slotIndex, avoidBoth);
  const elenaEntry = makePlanEntry(best.mainId, best.portionE, undefined, sharedOpts);
  const partnerEntry = makePlanEntry(best.mainId, best.portionA, undefined, sharedOpts);
  if(best.extra){
    if(best.extra.foodId !== undefined && best.extra.gramsE !== undefined){
      elenaEntry.extras = [{foodId: best.extra.foodId, grams: best.extra.gramsE}];
      partnerEntry.extras = [{foodId: best.extra.foodId, grams: best.extra.gramsA}];
    } else {
      elenaEntry.extras = [{recipeId: best.extra.recipeId, portion: best.extra.portion}];
      partnerEntry.extras = [{recipeId: best.extra.recipeId, portion: best.extra.portion}];
    }
  }
  return {shared: true, recipeId: best.mainId, elena: elenaEntry, partner: partnerEntry};
}

function pickSoloMeal(pool, person, slot, dayIndex, slotIndex, remainingKcalP, remainingProteinP, remainingWeight, history, weekSeed, excludePrevWeekId){
  const w = SLOT_WEIGHT[slot];
  const desired = remainingKcalP * (w / remainingWeight);
  const desiredProt = remainingProteinP * (w / remainingWeight);
  const anchor = PERSON_ANCHOR[person];
  // Cross-week filter first (with its own full-pool fallback), then within-week variety.
  pool = applyCrossWeekFilter(pool, excludePrevWeekId);
  pool = applyVarietyFilter(pool, history, person, slot, dayIndex);
  const maxPortion = SLOT_MAX_PORTION[slot];
  const avoidP = PROF[person].avoid || [];

  // candidates: {tieId, mainId, extra: null|{recipeId,portion}|{foodId,grams}, portion,
  //              kcal, protein, totals (task C2, 2026-07-18: combined-unit nutrition fed
  //              to tuningBonus() below — {protein,fiber,freeSugars,fat,satFat,hasOmega3})}
  const candidates = [];
  function pushFull(id, base, bp){
    candidates.push({tieId: id, mainId: id, extra: null, portion: bp.portion, kcal: bp.kcal, protein: base.protein * bp.portion,
      totals: withOmega3(scaleNutrientTotals(base, bp.portion), recipeHasOmega3(id))});
  }

  if(slot === 'snack'){
    // Snack never composes — every id in the pool (any role) is a standalone pick.
    pool.forEach(function(id){
      const base = dbBaseNutrition(id);
      pushFull(id, base, bestPortion(base.kcal, desired, anchor, maxPortion));
    });
  } else {
    const fullIds = pool.filter(function(id){ return RECIPES_DB[id].role === 'full'; });
    const mainIds = pool.filter(function(id){ return RECIPES_DB[id].role === 'main'; });
    fullIds.forEach(function(id){
      const base = dbBaseNutrition(id);
      pushFull(id, base, bestPortion(base.kcal, desired, anchor, maxPortion));
    });

    if(slot === 'breakfast'){
      const foodPoolRaw = breakfastPairFoodIds(avoidP);
      const foodPool = applyLightConsecutiveFilter(foodPoolRaw, [history[person].bfPairUse[dayIndex - 1]]);
      mainIds.forEach(function(id){
        const base = dbBaseNutrition(id);
        const bp = bestPortion(base.kcal, desired, anchor, maxPortion);
        pushFull(id, base, bp); // standalone role:'main' breakfast remains legal
        const hasO3 = recipeHasOmega3(id); // extra here is a plain FOOD, never counts toward omega3
        pushBreakfastPairCandidates(function(tieId, kcal, protein, extra){
          candidates.push({tieId: tieId, mainId: id, extra: extra, portion: bp.portion, kcal: kcal, protein: protein,
            totals: withOmega3(addNutrientTotals(scaleNutrientTotals(base, bp.portion), foodMacros(extra.foodId, extra.grams)), hasO3)});
        }, id, base, bp, desired, foodPool);
      });
    } else if(slot === 'lunch' || slot === 'dinner'){
      const sidePoolRaw = sidePoolFor(avoidP);
      const sidePool = applyLightConsecutiveFilter(sidePoolRaw, [history[person].sideUse[dayIndex - 1]]);
      if(sidePool.length){
        mainIds.forEach(function(mainId){
          const mainBase = dbBaseNutrition(mainId);
          const tops = topKSideIds(mainBase.kcal, sidePool, desired, SIDE_TOP_K);
          pushComposedSideCandidates(function(tieId, kcal, protein, extra, portion){
            const sideBase = dbBaseNutrition(extra.recipeId);
            candidates.push({tieId: tieId, mainId: mainId, extra: extra, portion: portion, kcal: kcal, protein: protein,
              totals: withOmega3(addNutrientTotals(scaleNutrientTotals(mainBase, portion), scaleNutrientTotals(sideBase, extra.portion)), recipeHasOmega3(mainId) || recipeHasOmega3(extra.recipeId))});
          }, mainId, mainBase, desired, anchor, maxPortion, sidePool, tops);
        });
      }
    }
  }

  let best = null;
  candidates.forEach(function(c){
    // Same reasoning as pickSharedMeal: score keyed on the real main id, tie-break on tieId.
    const score = mealScore(c.kcal, desired, c.protein, desiredProt, dayIndex, slotIndex, c.mainId, weekSeed) + tuningBonus(c.totals, nextWeekTuning);
    const better = !best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && c.tieId < best.tieId);
    if(better) best = Object.assign({score: score}, c);
  });
  if(!best){
    console.error('pickSoloMeal: empty candidate pool for person="' + person + '" slot="' + slot + '" style="' + householdStyle + '"');
    return {recipeId: null, portion: 1, kcal: 0, protein: 0};
  }
  // task D1: rotated deterministically off (weekSeed, dayIndex, slotIndex) over the
  // choices allowed under THIS person's own avoid-list (avoidP) — a solo slot can pick a
  // different variant per person even on the same day/slot, since each person's avoid-
  // list can allow a different set of choices. null for a recipe without optionGroups.
  const soloOpts = chosenOptsForRecipe(RECIPES_DB[best.mainId], weekSeed, dayIndex, slotIndex, avoidP);
  const entry = makePlanEntry(best.mainId, best.portion, undefined, soloOpts);
  if(best.extra) entry.extras = [best.extra];
  return entry;
}

/* ---------------- keeping weekPlan fresh ---------------- */
// Everything that should force a regeneration, folded into one opaque string: style,
// both avoid-lists, both calorie targets, both protein targets, and the four SHARED
// toggles. Calorie/protein targets already only change "materially" here since
// calGoalNum/targetP are rounded, formula-derived numbers (Mifflin-St Jeor, macro split
// %) — a change too small to move them isn't a change a person would notice either.
function computePlanSignature(){
  const e = PROF.elena, a = PROF.partner;
  return [
    householdStyle,
    (e.avoid || []).slice().sort().join(','),
    (a.avoid || []).slice().sort().join(','),
    e.calGoalNum, a.calGoalNum, e.targetP, a.targetP,
    SHARED.breakfast ? 1 : 0, SHARED.lunch ? 1 : 0, SHARED.dinner ? 1 : 0, SHARED.snack ? 1 : 0,
    nextWeekTuning // task C2 (2026-07-18): changing the tuning goal must regenerate future
                   // (non-logged, non-pinned) days exactly like any other signature input —
                   // 'none' is just another value here, no special-cased branch.
  ].join('|');
}

function planSignatureMatches(planSignature, currentSignature){
  if(planSignature === currentSignature) return true;
  // v20 and earlier included customRev as a final pipe-delimited field. Treat that legacy
  // signature as equivalent so adding a recipe no longer forces one last regeneration.
  if(typeof planSignature === 'string'){
    const parts = planSignature.split('|');
    if(parts.length === currentSignature.split('|').length + 1 && parts.slice(0, -1).join('|') === currentSignature){
      return true;
    }
  }
  return false;
}

function planReferencesMissingRecipe(plan){
  if(!plan || !Array.isArray(plan.days)) return true;
  for(let d = 0; d < plan.days.length; d++){
    const meals = plan.days[d] && plan.days[d].meals;
    if(!meals) return true;
    for(let s = 0; s < SLOT_ORDER.length; s++){
      const slot = SLOT_ORDER[s];
      const m = meals[slot];
      if(!m || !m.elena || !m.partner) return true;
      if(m.shared && m.recipeId && !RECIPES_DB[m.recipeId]) return true;
      if(!RECIPES_DB[m.elena.recipeId] || !RECIPES_DB[m.partner.recipeId]) return true;
    }
  }
  return false;
}

// Call before reading a week's plan anywhere. Generalized (two-week horizon feature) to
// take an optional mondayISO — the week to ensure/return — defaulting to the CURRENT
// week's Monday when omitted, so every pre-existing call site (`ensureWeekPlan()`, no
// args — Today/Log/computeActiveMenu/computeShoppingList/buildSwapAlternatives'
// unqualified callers) keeps meaning exactly what it always meant. Regenerates
// weekPlans[monday] when: the plan signature above has changed (style/avoid-list/
// calorie-or-protein-target/shared-toggle), when the stored plan references a recipe that
// no longer exists, or nothing has been generated
// for that Monday yet. Cheap when nothing changed — recomputeProf() is pure math, and the
// signature check is a string compare.
//
// ORDERING (cross-week variety filter): generateWeek(next Monday) consults
// weekPlans[current Monday], so the CURRENT week is always freshened FIRST here,
// whichever week was asked for. And whenever the current week just regenerated
// (signature change / first generation), any STORED next week is eagerly re-freshened
// right after — its stored signature is stale by construction, so the same signature
// logic regenerates it against the NEW current week. The pair therefore always stays
// consistent: next week's plan is always derived from the current week's plan as it
// exists now, never from one that was discarded.
//
// COMPATIBILITY GETTER: `weekPlan` (state.js) is kept as a bare global that always mirrors
// weekPlans[the CURRENT week's Monday] — every pre-two-week-horizon code path (Today, Log,
// recipe screen, re-balance, todayDayIndex, computeActiveMenu…) reads/writes that bare
// variable and is completely unaware weekPlans exists, so those paths needed zero changes.
// It's re-synced on every call (same object reference as weekPlans[currentMonday], so
// in-place mutations like applySwapToPlan() stay consistent from both names). Asking for
// a DIFFERENT week (e.g. next week) returns that week's plan without repointing
// `weekPlan`, so current-week code is unaffected by next-week reads/writes.
function ensureWeekPlan(mondayISO){
  recomputeProf('elena');
  recomputeProf('partner');
  const sig = computePlanSignature();
  const currentMonday = mondayOfWeek(todayISO());
  const wantStart = mondayISO || currentMonday;

  function freshen(monday){
    let plan = weekPlans[monday];
    const previousPlan = plan ? JSON.parse(JSON.stringify(plan)) : null;
    const stale = !plan || !planSignatureMatches(plan.signature, sig) || plan.weekStartDate !== monday || planReferencesMissingRecipe(plan);
    if(stale){
      plan = generateWeek({weekStartDate: monday, signature: sig});
      applyMealRulesToPlan(plan);
      preserveLoggedSlots(previousPlan, plan);
      preservePinnedSlots(previousPlan, plan);
      weekPlans[monday] = plan;
    } else if(plan.signature !== sig){
      plan.signature = sig;
    }
    refreshPlanNutrition(plan);
    return {plan: plan, regenerated: stale};
  }

  // Current week first, always — it's both the compat getter's value and the cross-week
  // filter's input for any later week.
  const cur = freshen(currentMonday);
  weekPlan = cur.plan; // compat getter — see doc above
  // Pair consistency: a just-regenerated current week invalidates a stored next week
  // (its signature no longer matches), so regenerate it right away against the new
  // current week rather than leaving a plan derived from a discarded one in the store.
  const nextMonday = addDaysISO(currentMonday, 7);
  if(cur.regenerated && weekPlans[nextMonday]) freshen(nextMonday);

  if(wantStart === currentMonday) return cur.plan;
  return freshen(wantStart).plan;
}

function todayDayIndex(){
  if(!weekPlan) ensureWeekPlan();
  return Math.max(0, Math.min(6, diffDaysISO(todayISO(), weekPlan.weekStartDate)));
}

/* ---------------- Today / Log screen view of the plan ---------------- */
// Replaces the old static MEALPLANS-driven computeActiveMenu(): reads today's row of
// weekPlan for currentProf. Shape kept close to the old one (breakfastKey etc.) but each
// slot is now a full computed view {recipeId, portion, kcal, protein, shared}.
function computeActiveMenu(){
  return computeMenuForDate(todayISO(), currentProf);
}

function computeMenuForDate(dateISO, person){
  const plan = ensureWeekPlan(mondayOfWeek(dateISO));
  const dayIdx = Math.max(0, Math.min(6, diffDaysISO(dateISO, plan.weekStartDate)));
  const day = plan.days[dayIdx];
  function view(slot){
    const entry = day.meals[slot][person];
    return planEntryView(entry, day.meals[slot].shared);
  }
  return {style: householdStyle, dateISO: dateISO, weekStartDate: plan.weekStartDate, dayIndex: dayIdx, breakfast: view('breakfast'), lunch: view('lunch'), dinner: view('dinner'), snack: view('snack')};
}

// Task D1 ("Today = Log"): PROF.consumed*/consumedKcal derived purely from today's
// logHistory entries for personKey (confirmed plan slots + quick-added foods) — replaces
// the old weekPlan-plus-todayLog-status computation. Every number here was already
// computed once at log time (recipeNutrition/foodMacros), so this is just a sum.
// FIX 1 (feedback): breakfast used to be force-logged here via the now-removed
// ensureTodayBreakfastLogged() the moment its plan slot was known. Breakfast is now a
// normal meal — nothing is in logHistory until the user taps Confirm on the Log screen —
// so this is a pure read, exactly like every other slot.
function recomputeConsumed(personKey){
  const entries = getDayLog(todayISO())[personKey];
  let kcal = 0, p = 0, c = 0, f = 0, sat = 0, fib = 0;
  entries.forEach(function(e){
    const nut = logEntryNutrition(e);
    kcal += nut.kcal; p += nut.protein; c += nut.carbs; f += nut.fat; sat += nut.satFat; fib += nut.fiber;
  });
  PROF[personKey].consumedKcal = Math.round(kcal);
  PROF[personKey].consumed = {p: Math.round(p), c: Math.round(c), f: Math.round(f), satFat: Math.round(sat), fiber: Math.round(fib)};
}

/* ---------------- Insights (task D1 item 4) ---------------- */
// The single rolling 7-day window (today included, oldest first) every Insights number —
// bars, band, stat tiles, call-outs — is computed over, so they can never disagree with
// each other or with the Log screen's "today" slice.
function last7Dates(){
  const today = todayISO();
  const dates = [];
  for(let i = 6; i >= 0; i--) dates.push(addDaysISO(today, -i));
  return dates;
}

const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']; // Mon..Sun
function dayLetterFor(iso){
  const jsDay = parseISODate(iso).getDay(); // 0=Sun..6=Sat
  return DAY_LETTERS[(jsDay + 6) % 7];
}

// How many distinct calendar days (within retention) have at least one logged entry for
// personKey — the "<2 logged days" empty-state gate (task D1 item 4 EMPTY STATES). Not
// limited to the rolling 7-day window: 2 logged days anywhere unlocks Insights.
function loggedDayCount(personKey){
  return Object.keys(logHistory).filter(function(date){
    const day = logHistory[date];
    return day && Array.isArray(day[personKey]) && day[personKey].length > 0;
  }).length;
}

// task C1: shared ±10% window classifier for the per-day nutrient-band bars — SAME
// tolerance the kcal inBand check above uses, so "in band" never means something
// different depending on which metric's bar you're looking at.
function classifyWindowBand(value, target){
  if(!(target > 0)) return 'in';
  if(value > target * 1.10) return 'over';
  if(value < target * 0.90) return 'under';
  return 'in';
}
// Fiber only has a floor (WEEK_SUMMARY_THRESHOLDS.fiberMinPerDay) — there's no "too much
// fiber" band, so the only out-of-band state is 'under'.
function classifyMinBand(value, min){
  return (min > 0 && value < min) ? 'under' : 'in';
}
// Free sugars only has a ceiling (coverageGaps' 6%-of-kcal target, converted to grams for
// the person's calorie goal) — the only out-of-band state is 'over'.
function classifyMaxBand(value, max){
  return (max > 0 && value > max) ? 'over' : 'in';
}

// Pure computation for the Insights screen (task D1 item 4). Every per-day kcal figure is
// compared against that day's FROZEN target snapshot (state.js:ensureTargetSnapshot), so a
// later calorie-target change never moves a past day's bar or band dot. Returns
// hasEnoughData:false (with everything else zeroed) once fewer than 2 days have ever been
// logged — render.js paints the empty-state pattern in that case.
function computeInsights(personKey){
  const prof = PROF[personKey];
  // task C1: per-day nutrient bands — protein/carbs/fat vs the person's own targets (±10%,
  // same window as kcal), fiber vs the single-sourced WEEK_SUMMARY_THRESHOLDS.fiberMinPerDay
  // (never re-typed 25), free sugars vs the coverageGaps-derived %-of-kcal target (never
  // re-typed 6) converted to grams for this person's calorie goal — the SAME derivation
  // render.js:weekNutriSummary already uses for sugarTargetG, so Insights and Week can never
  // disagree on what "too much sugar" means.
  const sugarTargetPct = coverageGaps(computeWeeklyCoverage()).freeSugars.target;
  const sugarTargetG = prof.calGoalNum > 0 ? (sugarTargetPct / 100) * prof.calGoalNum / 4 : 0;

  const days = last7Dates().map(function(date){
    const day = getDayLog(date);
    const entries = day[personKey] || [];
    const logged = entries.length > 0;
    let kcal = 0, protein = 0, carbs = 0, fat = 0, satFat = 0, fiber = 0, freeSugars = 0;
    entries.forEach(function(e){
      const nut = logEntryNutrition(e);
      kcal += nut.kcal; protein += nut.protein; carbs += nut.carbs; fat += nut.fat;
      satFat += nut.satFat; fiber += nut.fiber; freeSugars += nut.freeSugars;
    });
    const target = (typeof day.targets[personKey] === 'number') ? day.targets[personKey] : prof.calGoalNum;
    const inBand = logged && target > 0 && Math.abs(kcal - target) <= target * 0.10;
    const bands = logged ? {
      protein: classifyWindowBand(protein, prof.targetP),
      carbs: classifyWindowBand(carbs, prof.targetC),
      fat: classifyWindowBand(fat, prof.targetF),
      fiber: classifyMinBand(fiber, WEEK_SUMMARY_THRESHOLDS.fiberMinPerDay),
      freeSugars: classifyMaxBand(freeSugars, sugarTargetG)
    } : null;
    return {date: date, letter: dayLetterFor(date), logged: logged, kcal: Math.round(kcal), target: Math.round(target),
      protein: protein, carbs: carbs, fat: fat, satFat: satFat, fiber: fiber, freeSugars: freeSugars,
      inBand: inBand, bands: bands};
  });

  // task C1: single-sourced band targets for render.js's nutrient-bands card (bar tooltips/
  // labels) — computed once here so the renderer never re-derives the sugar-gram conversion
  // itself (would risk re-typing 6).
  const bandTargets = {protein: prof.targetP, carbs: prof.targetC, fat: prof.targetF,
    fiber: WEEK_SUMMARY_THRESHOLDS.fiberMinPerDay, freeSugars: Math.round(sugarTargetG)};

  const totalLoggedDays = loggedDayCount(personKey);
  if(totalLoggedDays < 2){
    return {hasEnoughData: false, days: days, inBandCount: 0, daysLoggedCount: 0,
      avgProtein: 0, avgFiber: 0, pctUnsaturated: 0, targetProtein: PROF[personKey].targetP,
      bandTargets: bandTargets, callouts: []};
  }

  const loggedDays = days.filter(function(d){ return d.logged; });
  const sum = function(key){ return loggedDays.reduce(function(s, d){ return s + d[key]; }, 0); };
  const avgProtein = loggedDays.length ? sum('protein') / loggedDays.length : 0;
  const avgFiber = loggedDays.length ? sum('fiber') / loggedDays.length : 0;
  const totalFat = sum('fat'), totalSatFat = sum('satFat');
  const pctUnsaturated = totalFat > 0 ? (1 - totalSatFat / totalFat) * 100 : 0;
  const inBandCount = days.filter(function(d){ return d.inBand; }).length;
  const targetProtein = PROF[personKey].targetP;

  return {
    hasEnoughData: true, days: days, inBandCount: inBandCount, daysLoggedCount: loggedDays.length,
    avgProtein: avgProtein, avgFiber: avgFiber, pctUnsaturated: pctUnsaturated, targetProtein: targetProtein,
    bandTargets: bandTargets,
    callouts: buildInsightCallouts(avgProtein, targetProtein, avgFiber, pctUnsaturated, inBandCount)
  };
}

// Task D1 item 4d: exactly 2 call-outs ("what's working / watch this"), picked
// deterministically by which metric sits furthest (relatively) from its target — the most
// notable fact wins; ties broken by this fixed rule order (protein, fiber, satFat,
// adherence). Every clause has fixed phrasing per rule × verdict — no free text.
function buildInsightCallouts(avgProtein, targetProtein, avgFiber, pctUnsaturated, inBandCount){
  const satSharePct = 100 - pctUnsaturated;
  const rules = [
    {
      key: 'protein', magnitude: targetProtein > 0 ? Math.abs(avgProtein - targetProtein) / targetProtein : 0,
      good: avgProtein >= targetProtein,
      icon: function(good){ return good ? '💪' : '📌'; },
      text: function(good){ return good
        ? 'Protein average is on target — ' + Math.round(avgProtein) + 'g/day vs a ' + targetProtein + 'g goal.'
        : 'Protein is running under target — ' + Math.round(avgProtein) + 'g/day vs a ' + targetProtein + 'g goal.'; }
    },
    {
      key: 'fiber', magnitude: Math.abs(avgFiber - 25) / 25,
      good: avgFiber >= 25,
      icon: function(good){ return good ? '🌾' : '📌'; },
      text: function(good){ return good
        ? 'Fiber is solidly heart-smart — averaging ' + Math.round(avgFiber) + 'g/day, at or above the 25g guide.'
        : 'Fiber is under the 25g guide — averaging ' + Math.round(avgFiber) + 'g/day this week.'; }
    },
    {
      key: 'satFat', magnitude: Math.abs(satSharePct - 33) / 33,
      good: satSharePct <= 33,
      icon: function(good){ return good ? '❤️' : '📌'; },
      text: function(good){ return good
        ? 'Saturated fat stays in check — ' + Math.round(satSharePct) + '% of fat vs the 33% cap.'
        : 'Saturated fat is creeping up — ' + Math.round(satSharePct) + '% of fat vs the 33% cap.'; }
    },
    {
      key: 'adherence', magnitude: Math.abs(inBandCount / 7 - 0.7),
      good: inBandCount >= 5,
      icon: function(good){ return good ? '🎉' : '📌'; },
      text: function(good){ return good
        ? 'Adherence is steady — ' + inBandCount + ' of 7 days landed inside your target range.'
        : 'A few days drifted outside your target range — ' + inBandCount + ' of 7 this week.'; }
    }
  ];
  rules.sort(function(a, b){ return b.magnitude - a.magnitude; }); // stable sort (ES2019+): ties keep the fixed order above
  return rules.slice(0, 2).map(function(r){ return {key: r.key, good: r.good, icon: r.icon(r.good), text: r.text(r.good)}; });
}

/* ---------------- avoid-list editor helpers (task C3 item 2) ---------------- */
// How many RECIPES_DB recipes carry `key` in their `avoid` array — used by the Profile
// screen's toast when a person adds/removes an avoid key ("Lactose removed — N more
// recipes available to you"). Independent of anyone's CURRENT avoid list: it's just how
// many recipes that single key touches across the whole DB.
function countRecipesWithAvoidKey(key){
  return Object.keys(RECIPES_DB).filter(function(id){ return RECIPES_DB[id].avoid.indexOf(key) !== -1; }).length;
}

/* ---------------- shopping list (computed from weekPlan) ---------------- */
// "Mon 6 – Sun 12 Jul" (task C3 item 4): weekStartDate is always a Monday
// (planner.js:mondayOfWeek), so the range is always exactly 7 days, Mon..Sun. Only the
// end date's month is shown unless the week actually crosses a month boundary.
function fmtShopWeekRange(weekStartDate){
  const start = parseISODate(weekStartDate);
  const end = parseISODate(addDaysISO(weekStartDate, 6));
  const sameMonth = start.getMonth() === end.getMonth();
  const startStr = 'Mon ' + start.getDate() + (sameMonth ? '' : ' ' + MONTHS[start.getMonth()]);
  const endStr = 'Sun ' + end.getDate() + ' ' + MONTHS[end.getMonth()];
  return startStr + ' – ' + endStr;
}

// Categories now come straight from FOODS[id].cat (task B1) instead of a hand-typed
// name->category map — the food DB is the single source of truth for both nutrition and
// shopping-aisle grouping.
const SHOP_CAT_ORDER = ['Produce', 'Protein', 'Dairy', 'Bakery', 'Pantry', 'Frozen'];
function foodCategoryForName(name){
  const id = Object.keys(FOODS).find(function(fid){ return FOODS[fid].name === name; });
  const cat = id ? FOODS[id].cat : 'Pantry';
  return SHOP_CAT_ORDER.indexOf(cat) !== -1 ? cat : 'Pantry';
}

// Walks the full 7-day plan for BOTH people and aggregates identical ingredient (food)
// names. Shared slots: one recipe cooked at (Elena's portion + Andrea's portion)
// combined — cooked once, counted once, same convention as before. Solo slots: each
// person's own recipe at their own portion. Portions come from the plan itself now
// (per-meal, per-day), not a single global svE/svM factor.
//
// Parameterized by week (task: "shopping list per week") — weekStartDate defaults to the
// CURRENT week's Monday when omitted, so any caller that predates the two-week horizon
// feature keeps computing exactly what it always computed. Passing nextMondayISO()
// aggregates NEXT week's plan instead, over the exact same RECIPES_DB/FOODS logic.
function computeShoppingList(weekStartDate){
  const plan = ensureWeekPlan(weekStartDate);
  const totals = {};  // food display name -> {qty, unit}
  const staples = {}; // food display name -> true (toTaste garnish, unquantified)
  function addRecipe(recipeId, factor, opts){
    const r = RECIPES_DB[recipeId];
    if(!r || !(factor > 0)) return;
    // `factor` is servings eaten; ingredients are the whole batch, which makes
    // r.servings servings — buy batch/servings per serving eaten.
    const batchYield = (typeof r.servings === 'number' && r.servings > 0) ? r.servings : 1;
    // task D1: recipeEffectiveIngredients (engine.js) resolves the CHOSEN variant's
    // ingredients (base + the opts-selected choice per group) — the shopping list buys
    // what was actually planned/eaten, not always the default combo.
    recipeEffectiveIngredients(r, opts).forEach(function(ing){
      const foodId = ing[0], grams = ing[1] / batchYield;
      const food = FOODS[foodId];
      if(!food) return;
      const name = food.name;
      if(food.unit === 'piece'){
        if(!totals[name]) totals[name] = {qty: 0, unit: ''};
        totals[name].qty += (grams * factor) / food.avgG;
      } else {
        if(!totals[name]) totals[name] = {qty: 0, unit: food.unit};
        totals[name].qty += grams * factor;
      }
    });
    (r.toTaste || []).forEach(function(t){ staples[capitalizeFirst(t)] = true; });
  }
  function addFood(foodId, grams){
    const food = FOODS[foodId];
    if(!food || !(grams > 0)) return;
    const name = food.name;
    if(food.unit === 'piece'){
      if(!totals[name]) totals[name] = {qty: 0, unit: ''};
      totals[name].qty += grams / food.avgG;
    } else {
      if(!totals[name]) totals[name] = {qty: 0, unit: food.unit};
      totals[name].qty += grams;
    }
  }
  plan.days.forEach(function(day){
    SLOT_ORDER.forEach(function(slot){
      const m = day.meals[slot];
      planEntryComponents(m.elena).forEach(function(c){ if(c.recipeId) addRecipe(c.recipeId, c.portion, c.opts); else addFood(c.foodId, c.grams); });
      planEntryComponents(m.partner).forEach(function(c){ if(c.recipeId) addRecipe(c.recipeId, c.portion, c.opts); else addFood(c.foodId, c.grams); });
    });
  });
  return {totals: totals, staples: staples, weekStartDate: plan.weekStartDate};
}

// Whole grams/ml, whole items rounded up (you can't buy 31.5 eggs),
// and ≥1000 g/ml promoted to kg/L for readability.
function fmtShopQty(qty, unit){
  if(unit === '') return '' + Math.ceil(qty);
  const g = Math.round(qty);
  if(g >= 1000) return (Math.round(g / 10) / 100) + (unit === 'ml' ? ' L' : ' kg');
  return g + ' ' + unit;
}

/* ---------------- swap (task C2 item 3) ---------------- */
// A "unit" identifies exactly one swappable meal in the plan: a (day, slot) that's
// either shared (one recipe, both people) or solo for a specific person.
function unitKey(unit){
  const slotIdx = SLOT_ORDER.indexOf(unit.slot);
  const suffix = unit.shared ? 'x' : (unit.person === 'elena' ? 'a' : 'b');
  return unit.dayIndex + '-' + slotIdx + '-' + suffix;
}

// Mutates `plan` in place: swaps unit's recipe to newRecipeId, re-portioning (bestPortion,
// anchored to whatever kcal was there before) so the day's kcal balance doesn't lurch —
// used both by the real swap-sheet apply and by the re-balance solver's what-if search.
function applySwapToPlan(plan, unit, newRecipeId){
  const m = plan.days[unit.dayIndex].meals[unit.slot];
  const now = Date.now(); // mutation stamp — sync.js:mergePlansSection keeps the newer edit
  const newBase = dbBaseNutrition(newRecipeId);
  if(unit.shared){
    const currentE = planEntryNutrition(m.elena);
    const currentA = planEntryNutrition(m.partner);
    const extrasE = Array.isArray(m.elena.extras) ? m.elena.extras.slice() : [];
    const extrasA = Array.isArray(m.partner.extras) ? m.partner.extras.slice() : [];
    const bpE = bestPortion(newBase.kcal, currentE.kcal, PERSON_ANCHOR.elena, SLOT_MAX_PORTION[unit.slot]);
    const bpA = bestPortion(newBase.kcal, currentA.kcal, PERSON_ANCHOR.partner, SLOT_MAX_PORTION[unit.slot]);
    // Shared dish changes for BOTH people at once, so the whole cell moves together —
    // stamp the cell (sync.js merges shared cells whole, by this m.t).
    m.recipeId = newRecipeId;
    m.t = now;
    m.elena = makePlanEntry(newRecipeId, bpE.portion);
    m.partner = makePlanEntry(newRecipeId, bpA.portion);
    m.elena.extras = extrasE;
    m.partner.extras = extrasA;
    refreshPlanEntryNutrition(m.elena);
    refreshPlanEntryNutrition(m.partner);
  } else {
    const person = unit.person;
    const current = planEntryNutrition(m[person]);
    const extras = Array.isArray(m[person].extras) ? m[person].extras.slice() : [];
    const bp = bestPortion(newBase.kcal, current.kcal, PERSON_ANCHOR[person], SLOT_MAX_PORTION[unit.slot]);
    // SOLO meal: only THIS person's half of the slot changes. Stamp the person's half, NOT
    // the cell — bumping the cell-level t would let the couple-sync merge overwrite the
    // OTHER person's half of the same slot with a stale copy (the swap-revert bug). Also
    // clear any stale cell stamp so the merge governs each half purely by per-person time.
    m[person] = makePlanEntry(newRecipeId, bp.portion, now);
    m[person].extras = extras;
    refreshPlanEntryNutrition(m[person]);
    delete m.t;
  }
  return m;
}

function addSideToPlan(plan, unit, sideRecipeId){
  const m = plan.days[unit.dayIndex].meals[unit.slot];
  const now = Date.now();
  const stampSide = function(entry, stampEntry){
    entry.extras = Array.isArray(entry.extras) ? entry.extras : [];
    entry.extras.push({recipeId: sideRecipeId, portion: 1});
    refreshPlanEntryNutrition(entry);
    if(stampEntry) entry.t = now;
  };
  if(unit.shared){
    stampSide(m.elena, false);
    stampSide(m.partner, false);
    m.t = now;
  } else {
    stampSide(m[unit.person], true);
    delete m.t;
  }
  return m;
}

// Alternatives = same slot, same style, avoid-respecting, excluding the current recipe
// and anything already planned elsewhere today for this person; ranked by closest
// computed kcal to what's currently planned (deterministic tie-break by id).
// weekStartDate (optional, defaults to the current week — same compat contract as
// ensureWeekPlan) lets the Week screen's swap sheet operate on NEXT week's plan too.
function buildSwapAlternatives(dayIndex, slot, person, weekStartDate){
  const plan = ensureWeekPlan(weekStartDate);
  const day = plan.days[dayIndex];
  const m = day.meals[slot];
  const shared = m.shared;
  const currentId = shared ? m.recipeId : m[person].recipeId;
  const currentNut = planEntryNutrition(m[person]);
  const currentKcal = currentNut.kcal, currentProtein = currentNut.protein;
  const styleKey = STYLE_DB_KEY[householdStyle] || 'balanced';
  const avoidL = shared ? unionAvoid(PROF.elena.avoid || [], PROF.partner.avoid || []) : (PROF[person].avoid || []);
  const plannedToday = {};
  SLOT_ORDER.forEach(function(s){
    if(s === slot) return;
    const other = day.meals[s];
    const id = other.shared ? other.recipeId : other[person].recipeId;
    if(id) plannedToday[id] = true;
  });
  let pool = candidatesFor(slot, styleKey, avoidL).filter(function(id){ return id !== currentId && !plannedToday[id]; });
  if(!pool.length) pool = candidatesFor(slot, styleKey, avoidL).filter(function(id){ return id !== currentId; });
  const anchor = PERSON_ANCHOR[person];
  const scored = pool.map(function(id){
    const base = dbBaseNutrition(id);
    const bp = bestPortion(base.kcal, currentKcal, anchor, SLOT_MAX_PORTION[slot]);
    const protein = base.protein * bp.portion;
    return {id: id, portion: bp.portion, kcal: bp.kcal, protein: protein, kcalDelta: bp.kcal - currentKcal, proteinDelta: protein - currentProtein};
  });
  scored.sort(function(a, b){
    const d = Math.abs(a.kcalDelta) - Math.abs(b.kcalDelta);
    if(Math.abs(d) > 1e-9) return d;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  });
  return scored.slice(0, 5);
}

function swapSearchText(id){
  const r = RECIPES_DB[id];
  if(!r) return '';
  return [
    r.title || '',
    recipeSlotList(r).join(' '),
    (r.tags || []).join(' '),
    (r.styles || []).join(' '),
    id.indexOf('cr-') === 0 ? 'yours custom recipe' : 'built in'
  ].join(' ').toLowerCase();
}

// Searchable swap pool: every recipe in the same meal slot, built-in and custom, across
// all plan styles. Manual search is explicit user intent, so it does not apply the current
// household style filter. Avoid-lists still apply, and the currently planned recipe is
// excluded because selecting it would be a no-op.
function buildSwapSearchOptions(dayIndex, slot, person, query, weekStartDate){
  const plan = ensureWeekPlan(weekStartDate);
  const m = plan.days[dayIndex].meals[slot];
  const shared = m.shared;
  const currentId = shared ? m.recipeId : m[person].recipeId;
  const currentNut = planEntryNutrition(m[person]);
  const currentKcal = currentNut.kcal, currentProtein = currentNut.protein;
  const avoidL = shared ? unionAvoid(PROF.elena.avoid || [], PROF.partner.avoid || []) : (PROF[person].avoid || []);
  const q = String(query || '').trim().toLowerCase();
  if(q.length < 2) return [];
  const anchor = PERSON_ANCHOR[person];
  const pool = Object.keys(RECIPES_DB).filter(function(id){
    const r = RECIPES_DB[id];
    return recipeSlotList(r).indexOf(slot) !== -1 && id !== currentId && swapSearchText(id).indexOf(q) !== -1;
  });
  const scored = pool.map(function(id){
    const base = dbBaseNutrition(id);
    const bp = bestPortion(base.kcal, currentKcal, anchor, SLOT_MAX_PORTION[slot]);
    const protein = base.protein * bp.portion;
    return {id: id, title: RECIPES_DB[id].title, custom: id.indexOf('cr-') === 0, avoidHit: recipeHitsAvoid(RECIPES_DB[id], avoidL), portion: bp.portion, kcal: bp.kcal, protein: protein,
      kcalDelta: bp.kcal - currentKcal, proteinDelta: protein - currentProtein};
  });
  scored.sort(function(a, b){
    const aFav = recipePref(a.id) === 'favorite';
    const bFav = recipePref(b.id) === 'favorite';
    if(aFav !== bFav) return aFav ? -1 : 1;
    if(a.custom !== b.custom) return a.custom ? -1 : 1;
    if(a.avoidHit !== b.avoidHit) return a.avoidHit ? 1 : -1;
    if(a.title !== b.title) return a.title < b.title ? -1 : 1;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  });
  return scored;
}

// Applies the swap to the live plan (weekStartDate optional, defaults to the current
// week) and returns a display-ready view (title/emoji/tags/kcal/protein) for the caller
// to paint. Does NOT persist — callers persist(). Mutates weekPlans[weekStartDate] in
// place (applySwapToPlan) — when weekStartDate resolves to the current week, `weekPlan`
// (the compat getter) is the exact same object, so both names see the swap.
function applySwap(dayIndex, slot, person, newRecipeId, weekStartDate){
  const plan = ensureWeekPlan(weekStartDate);
  const meal = plan.days[dayIndex].meals[slot];
  const unit = {dayIndex: dayIndex, slot: slot, shared: !!(meal && meal.shared), person: person};
  applySwapToPlan(plan, unit, newRecipeId);
  markWeekPlanEdited(plan);
  const r = RECIPES_DB[newRecipeId] || {title: 'Recipe', emoji: '🍽️'};
  const entry = plan.days[dayIndex].meals[slot][person];
  const view = planEntryView(entry, plan.days[dayIndex].meals[slot].shared);
  const tags = RECIPES_DB[newRecipeId] ? recipeDisplayPills(newRecipeId) : [];
  return {recipeId: newRecipeId, title: r.title, emoji: r.emoji, tags: tags, kcal: view.kcal, protein: view.protein};
}

// Resolves a click on "Swap" (from Today, Log, or the recipe-detail screen) to a
// concrete (day, slot, person). Swap always targets TODAY's plan for currentProf — the
// Today/Log screens are inherently "today", and the recipe-detail screen doesn't carry a
// day context in this app (its swap button is reached from Today/Week/Log alike), so
// "today" is the only sensible default without adding day-picking UI (out of scope here).
function resolveSwapContext(mealKey){
  ensureWeekPlan();
  const slot = SLOT_ORDER.indexOf(mealKey) !== -1 ? mealKey : (RECIPE_SLOT_DB[mealKey] || mealKey);
  return {dayIndex: todayDayIndex(), slot: slot, person: currentProf};
}

let swapCtx = null;

function swapRecipeDisplay(id){
  const r = RECIPES_DB[id];
  return {
    title: (r && r.title) || 'Recipe',
    emoji: (r && r.emoji) || '🍽️',
    tags: r ? recipeDisplayPills(id) : []
  };
}

function swapTagsHtml(tags){
  return (Array.isArray(tags) ? tags : []).map(function(t){
    const label = Array.isArray(t) ? t[1] : t;
    return '<span class="pill ghost">' + escapeHtml(label || '') + '</span>';
  }).join('');
}

// Renders one alternative row — shared by both sheet sections so "Best matches" and "All
// options" look identical (same emoji/title/kcal-delta/protein-delta/tags layout); `i` is
// the row's index into the COMBINED alts array swapCtx.alts holds, so chooseSwap(i) works
// identically no matter which section the tap came from.
function swapAltRowHtml(a, i){
  const r = swapRecipeDisplay(a.id);
  const kd = (a.kcalDelta >= 0 ? '+' : '') + Math.round(a.kcalDelta) + ' kcal';
  const pd = (a.proteinDelta >= 0 ? '+' : '') + Math.round(a.proteinDelta) + 'g protein';
  return '<div class="altrow" onclick="chooseSwap(' + i + ')">'
    + '<div class="ae">' + r.emoji + '</div>'
    + '<div class="at"><div class="an">' + escapeHtml(r.title) + '</div>'
    + '<div class="ad"><b>' + kd + '</b> · <b>' + pd + '</b></div>'
    + '<div class="tags">' + swapTagsHtml(r.tags) + '</div>'
    + '</div></div>';
}

// data-recipe-id (not an onclick="...chooseSwapRecipe('ID')..." JS string) — search
// results come from buildSwapSearchOptions, which includes custom `cr-<slug>` recipes
// whose id is influenced by a user-typed title. The delegated click handler in
// attachSwapSearchHandler below reads the id back with getAttribute and never re-parses
// it as JS.
function swapRecipeRowHtml(a){
  const r = swapRecipeDisplay(a.id);
  const kd = (a.kcalDelta >= 0 ? '+' : '') + Math.round(a.kcalDelta) + ' kcal';
  const pd = (a.proteinDelta >= 0 ? '+' : '') + Math.round(a.proteinDelta) + 'g protein';
  const yours = a.custom ? '<span class="pill terra">Yours</span>' : '';
  const avoid = a.avoidHit ? '<span class="pill ghost">Contains avoided</span>' : '';
  return '<div class="altrow" data-recipe-id="' + htmlAttr(a.id) + '">'
    + '<div class="ae">' + r.emoji + '</div>'
    + '<div class="at"><div class="an">' + escapeHtml(r.title) + '</div>'
    + '<div class="ad"><b>' + kd + '</b> · <b>' + pd + '</b></div>'
    + '<div class="tags">' + yours + avoid + swapTagsHtml(r.tags) + '</div>'
    + '</div></div>';
}

function buildSwapSearchResults(){
  try{
    if(!swapCtx) return '';
    const q = swapCtx.searchQuery || '';
    const slotLabel = (SLOT_LABEL[swapCtx.slot] || swapCtx.slot).toLowerCase();
    if(String(q).trim().length < 2){
      return '<p class="sub">Search by recipe name or tag. Custom recipes are included with built-ins.</p>';
    }
    const matches = buildSwapSearchOptions(swapCtx.dayIndex, swapCtx.slot, swapCtx.person, q, swapCtx.weekStartDate);
    if(!matches.length){
      return '<p class="sub">No ' + slotLabel + ' recipe matches that search.</p>';
    }
    const shown = matches.slice(0, 8);
    let html = '<p class="sub" style="margin-top:8px">' + matches.length + ' match' + (matches.length === 1 ? '' : 'es') + (matches.length > shown.length ? ' · showing first ' + shown.length : '') + '</p>';
    html += shown.map(swapRecipeRowHtml).join('');
    return html;
  } catch(err){
    console.warn('Swap search failed', err);
    return '<p class="sub">Search hit a saved recipe it could not read. Try another term, or check the recipe in Library.</p>';
  }
}

function onSwapRecipeSearch(value){
  if(!swapCtx) return;
  swapCtx.searchQuery = value;
  const el = document.getElementById('swapSearchResults');
  if(el) el.innerHTML = buildSwapSearchResults();
}

function attachSwapSearchHandler(){
  const input = document.getElementById('swapRecipeSearchInput');
  if(input) input.oninput = function(){ onSwapRecipeSearch(this.value); };
  // Delegated click for swapRecipeRowHtml's rows (data-recipe-id, not inline onclick — see
  // that function's comment). #swapSearchResults itself is only ever recreated when the
  // whole sheet reopens (this function is called again then), and onSwapRecipeSearch only
  // replaces its CHILDREN via innerHTML on every keystroke, so one assignment here survives
  // repeated searches within the same sheet-open, same non-accumulating-listener pattern as
  // the oninput assignment above.
  const results = document.getElementById('swapSearchResults');
  if(results) results.onclick = function(e){
    const row = e.target.closest('.altrow[data-recipe-id]');
    if(!row || !results.contains(row)) return;
    chooseSwapRecipe(row.getAttribute('data-recipe-id'));
  };
}

// FEATURE ("Swap anything"): the sheet has a short "Best matches" section and a search
// field for the full same-slot recipe book. That keeps the default sheet calm while still
// making every compatible recipe reachable, including custom `cr-...` recipes.
function buildSwapSheet(ctx){
  const best = buildSwapAlternatives(ctx.dayIndex, ctx.slot, ctx.person, ctx.weekStartDate);
  if(swapCtx){
    swapCtx.alts = best;
    swapCtx.searchQuery = swapCtx.searchQuery || '';
  }

  const slotLabel = (SLOT_LABEL[ctx.slot] || ctx.slot).toLowerCase();
  let html = '<h2 style="margin-top:6px">Swap this meal</h2><p class="sub">Best matches keep the plan close. Search can pick any compatible ' + slotLabel + ' recipe, including yours.</p>';

  if(!best.length){
    html += '<p class="sub">No other option fits this slot today.</p>';
  } else {
    html += '<div class="shop-cat">Best matches</div>';
    html += best.map(function(a, i){ return swapAltRowHtml(a, i); }).join('');
  }

  html += '<div class="shop-cat">Search ' + slotLabel + ' recipes</div>'
    + '<input class="inp" style="width:100%;box-sizing:border-box;border:1px solid var(--line);margin-top:8px" type="search" id="swapRecipeSearchInput" placeholder="Search recipes, tags, yours..." value="' + htmlAttr(swapCtx ? swapCtx.searchQuery || '' : '') + '" autocomplete="off">'
    + '<div id="swapSearchResults">' + buildSwapSearchResults() + '</div>';
  return html;
}

function chooseSwap(i){
  if(!swapCtx || !swapCtx.alts) return;
  const alt = swapCtx.alts[i];
  if(!alt) return;
  chooseSwapRecipe(alt.id, alt);
}

function chooseSwapRecipe(recipeId, alt){
  if(!swapCtx || !RECIPES_DB[recipeId]) return;
  const resolvedWeekStartDate = swapCtx.weekStartDate || mondayOfWeek(todayISO());
  const swapDateISO = addDaysISO(resolvedWeekStartDate, swapCtx.dayIndex);
  if(!alt){
    const matches = buildSwapSearchOptions(swapCtx.dayIndex, swapCtx.slot, swapCtx.person, recipeId, swapCtx.weekStartDate);
    alt = matches.filter(function(a){ return a.id === recipeId; })[0];
  }
  if(!alt){
    const plan = ensureWeekPlan(swapCtx.weekStartDate);
    const m = plan.days[swapCtx.dayIndex].meals[swapCtx.slot];
    const base = dbBaseNutrition(recipeId);
    const currentNut = planEntryNutrition(m[swapCtx.person]);
    const bp = bestPortion(base.kcal, currentNut.kcal, PERSON_ANCHOR[swapCtx.person], SLOT_MAX_PORTION[swapCtx.slot]);
    const protein = base.protein * bp.portion;
    alt = {id: recipeId, kcal: bp.kcal, protein: protein, kcalDelta: bp.kcal - currentNut.kcal, proteinDelta: protein - currentNut.protein};
  }
  // swapCtx.weekStartDate is set by openWeekSwap() (render.js — the Week screen's inline
  // swap, current OR next week); undefined for every pre-existing swap entry point
  // (Today/Log cards, the recipe screen), which always target the current week/today —
  // applySwap()'s own default keeps that behavior byte-for-byte unchanged.
  const weekStartDate = swapCtx.weekStartDate;
  const view = applySwap(swapCtx.dayIndex, swapCtx.slot, swapCtx.person, alt.id, weekStartDate);
  const swappedPlan = ensureWeekPlan(weekStartDate);

  // If this slot is already confirmed for the affected date, correct its LogEntry in
  // place. Manual user swaps are allowed for past days (for example yesterday); automatic
  // generation/re-balance still avoids past/logged slots via enumerateSwapUnits().
  const isCurrentWeek = resolvedWeekStartDate === mondayOfWeek(todayISO());
  if(logHistory[swapDateISO]){
    // A shared-slot swap changes BOTH people's dish (applySwapToPlan rewrites
    // m.elena and m.partner), so correct every person's confirmed entry — not just
    // the swapper's — or the other person's Log card keeps the old dish forever.
    const meal = swappedPlan.days[swapCtx.dayIndex].meals[swapCtx.slot];
    const people = meal.shared ? ['elena', 'partner'] : [swapCtx.person];
    people.forEach(function(person){
      if(slotLogStatus(swapDateISO, person, swapCtx.slot) !== 'confirmed') return;
      const planEntry = meal[person];
      logPlanEntry(swapDateISO, person, swapCtx.slot, planEntry.recipeId, planEntry.portion, planEntryComponents(planEntry));
    });
  }

  // Re-render every surface that shows the plan; consumed-so-far follows the plan's
  // current recipes, so it's refreshed too. renderWeek() repaints whichever week is
  // currently toggled on-screen (render.js:weekScreenShowsNext), so a next-week swap is
  // reflected immediately without touching Today/Log (both strictly current-week).
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderTodayMeals();
  renderLogPlan();
  renderWeek();
  const recipeScreen = document.getElementById('recipe');
  if(recipeScreen && recipeScreen.classList.contains('active') && isCurrentWeek) renderRecipe(view.recipeId);
  persist();
  closeSheet();
  toast('🔁 Swapped to ' + view.title + ' (' + (alt.kcalDelta >= 0 ? '+' : '') + Math.round(alt.kcalDelta) + ' kcal)');
}

/* ---------------- servings eaten (FEATURE: recipe servings) ---------------- */
// User-set "how many servings am I eating" for one of today's meals — a manual
// override of the auto-picked portion for the CURRENT person only (each person
// plates their own amount, shared dish or not). kcal/protein recompute from the
// per-serving base; a slot already confirmed today gets its LogEntry corrected in
// place (same contract as a swap). 0.5-serving steps, 0.5–4.
function stepMealServings(slot, delta, dateISO){
  dateISO = dateISO || todayISO();
  const weekStartDate = mondayOfWeek(dateISO);
  const dayIndex = diffDaysISO(dateISO, weekStartDate);
  const plan = editableWeekPlan(weekStartDate);
  const meal = plan.days[dayIndex] && plan.days[dayIndex].meals[slot];
  if(!meal || !meal[currentProf]) return;
  const entry = meal[currentProf];
  const next = Math.max(0.5, Math.min(4, +(entry.portion + delta).toFixed(1)));
  if(next === entry.portion) return;
  // Servings are per-person (each plates their own, shared dish or not). For a solo meal
  // stamp the person's half so the couple-sync merge doesn't clobber the other person's
  // half; a shared dish still moves as one cell (its recipe is joint), so stamp the cell.
  if(meal.shared){ meal.t = Date.now(); } else { entry.t = Date.now(); delete meal.t; }
  entry.portion = next;
  refreshPlanEntryNutrition(entry);
  markWeekPlanEdited(plan);
  if(slotLogStatus(dateISO, currentProf, slot) === 'confirmed'){
    logPlanEntry(dateISO, currentProf, slot, entry.recipeId, entry.portion, planEntryComponents(entry));
  }
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderTodayMeals();
  renderLogPlan();
  renderWeek();
  persist();
}

/* ---------------- re-balance (task C2 item 4) ---------------- */
// Whether any ingredient of the given recipe carries `flag` (data/foods.js flags).
function recipeHasFlag(recipeId, flag){
  const r = RECIPES_DB[recipeId];
  if(!r) return false;
  return r.ingredients.some(function(ing){
    const food = FOODS[ing[0]];
    return food && food.flags && food.flags.indexOf(flag) !== -1;
  });
}

// Real weekly nutrient coverage over a given plan (defaults to the live weekPlan):
// omega-3 / selenium meal counts (a meal counts if EITHER person's dish that slot
// contains the flag — for shared meals that's the one dish both eat), fiber g/day
// average per person, and the household's saturated-fat + free-sugar share of total energy.
function computeWeeklyCoverage(plan){
  plan = plan || weekPlan;
  let omega3Count = 0, seleniumCount = 0;
  let fiberSumE = 0, fiberSumA = 0;
  let fatSum = 0, satFatSum = 0, freeSugarKcal = 0, totalKcal = 0;
  plan.days.forEach(function(day){
    SLOT_ORDER.forEach(function(slot){
      const m = day.meals[slot];
      // Flag coverage must see extras, not just the base dish (task: Insights ignoring
      // meal extras) — a meal counts if ANY component (base or extra) of either person's
      // entry that slot has the flag, mirroring how Today/Log treat extras as real food.
      const componentsE = planEntryComponents(m.elena);
      const componentsA = planEntryComponents(m.partner);
      const hasFlag = function(components, flag){
        return components.some(function(c){ return recipeHasFlag(c.recipeId, flag); });
      };
      if(hasFlag(componentsE, 'omega3') || hasFlag(componentsA, 'omega3')) omega3Count++;
      if(hasFlag(componentsE, 'selenium') || hasFlag(componentsA, 'selenium')) seleniumCount++;
      const nutE = planEntryNutrition(m.elena);
      const nutA = planEntryNutrition(m.partner);
      fiberSumE += nutE.fiber; fiberSumA += nutA.fiber;
      fatSum += nutE.fat + nutA.fat;
      satFatSum += nutE.satFat + nutA.satFat;
      freeSugarKcal += (nutE.freeSugars + nutA.freeSugars) * 4;
      totalKcal += nutE.kcal + nutA.kcal;
    });
  });
  return {
    omega3PerWeek: omega3Count,
    seleniumPerWeek: seleniumCount,
    fiberAvgPerDay: {elena: fiberSumE / 7, partner: fiberSumA / 7},
    satFatShareOfFat: fatSum > 0 ? satFatSum / fatSum : 0,
    freeSugarShareOfKcal: totalKcal > 0 ? freeSugarKcal / totalKcal : 0
  };
}

// Normalizes each metric to a 0..1+ "gap fraction" (0 = target met) so they're
// comparable; the "worst gap" is whichever is largest. Fiber is per-person by spec, so
// this reports whichever of the two people is currently worse off.
function coverageGaps(cov){
  const worstFiberPerson = cov.fiberAvgPerDay.elena <= cov.fiberAvgPerDay.partner ? 'elena' : 'partner';
  const worstFiberVal = cov.fiberAvgPerDay[worstFiberPerson];
  const satPct = cov.satFatShareOfFat * 100;
  const sugarPct = cov.freeSugarShareOfKcal * 100;
  return {
    omega3: {key: 'omega3', label: 'Omega-3 meals', value: cov.omega3PerWeek, target: 3, unit: '/wk',
      gap: Math.max(0, (3 - cov.omega3PerWeek) / 3), pct: Math.min(100, Math.round(cov.omega3PerWeek / 3 * 100))},
    selenium: {key: 'selenium', label: 'Selenium sources', value: cov.seleniumPerWeek, target: 3, unit: '/wk',
      gap: Math.max(0, (3 - cov.seleniumPerWeek) / 3), pct: Math.min(100, Math.round(cov.seleniumPerWeek / 3 * 100))},
    fiber: {key: 'fiber', label: 'Fiber', value: Math.round(worstFiberVal), target: 25, unit: 'g/day', person: worstFiberPerson,
      gap: Math.max(0, (25 - worstFiberVal) / 25), pct: Math.min(100, Math.round(worstFiberVal / 25 * 100))},
    satFat: {key: 'satFat', label: 'Sat. fat', value: Math.round(satPct), target: 33, unit: '% of fat', cap: true,
      gap: Math.max(0, (satPct - 33) / 33), pct: Math.min(100, Math.round(satPct / 33 * 100))},
    freeSugars: {key: 'freeSugars', label: 'Free sugars', value: Math.round(sugarPct), target: Math.round(6), unit: '% of kcal',
      gap: Math.max(0, (sugarPct - 6) / 6), pct: Math.min(100, Math.round(sugarPct / 6 * 100)), cap: true, note: 'target from current profile calories'},
    freeSugarsWarn: {key: 'freeSugarsWarn', label: 'Free sugars ceiling', value: Math.round(sugarPct), target: Math.round(10), unit: '% of kcal',
      gap: Math.max(0, (sugarPct - 10) / 10), pct: Math.min(100, Math.round(sugarPct / 10 * 100)), cap: true}
  };
}

/* ---------------- T6: week diet-summary line ---------------- */
// Deterministic, single-person read of a given plan: the same 28 meals renderWeek() lists
// for `personKey` (day.meals[slot][personKey] — already the portion-scaled view render.js
// uses), tallying (a) recipe tag frequency for the "what this week leans toward" chips and
// (b) the SAME headline metrics/thresholds as Insights (planner.js:buildInsightCallouts /
// coverageGaps) so the wording never disagrees with the Insights screen:
//   fiber >= 25 g/day · sat fat <= 33% of fat · protein >= personal goal · omega-3 >= 3 meals/wk
// Nothing here is typed in — every number comes from recipeNutrition()/PROF[personKey].targetP.
const WEEK_SUMMARY_THRESHOLDS = {fiberMinPerDay: 25, satFatMaxShare: 0.33, omega3MinPerWeek: 3};

function summarizeWeekPlan(plan, personKey){
  const tagCounts = {};
  let fiberSum = 0, proteinSum = 0, fatSum = 0, satFatSum = 0, omega3Count = 0;
  const mealCount = plan.days.length * SLOT_ORDER.length;

  plan.days.forEach(function(day){
    SLOT_ORDER.forEach(function(slot){
      const entry = day.meals[slot][personKey];
      const r = RECIPES_DB[entry.recipeId];
      if(!r) return;
      (r.tags || []).forEach(function(t){ tagCounts[t] = (tagCounts[t] || 0) + 1; });
      // Components-aware (base + extras), same reasoning as computeWeeklyCoverage above —
      // this headline must agree with what Today/Log actually counted for the person.
      const nut = planEntryNutrition(entry);
      fiberSum += nut.fiber; proteinSum += nut.protein; fatSum += nut.fat; satFatSum += nut.satFat;
      if(planEntryComponents(entry).some(function(c){ return recipeHasFlag(c.recipeId, 'omega3'); })) omega3Count++;
    });
  });

  const days = plan.days.length || 7;
  const avgFiberPerDay = fiberSum / days;
  const avgProteinPerDay = proteinSum / days;
  const satFatShare = fatSum > 0 ? satFatSum / fatSum : 0;
  const targetProtein = PROF[personKey] ? PROF[personKey].targetP : 0;

  // Up to 3 headline tags, most-frequent first; ties broken by TAG_PILL_MAP's fixed key
  // order (stable sort keeps that order for equal counts) so the same plan always renders
  // the same chip order.
  const tagOrder = Object.keys(TAG_PILL_MAP);
  const topTags = Object.keys(tagCounts)
    .sort(function(a, b){
      const diff = tagCounts[b] - tagCounts[a];
      if(diff !== 0) return diff;
      return tagOrder.indexOf(a) - tagOrder.indexOf(b);
    })
    .slice(0, 3)
    .map(function(t){ return (TAG_PILL_MAP[t] && TAG_PILL_MAP[t][1]) || t; });

  // One hard headline metric — the first of these (fixed priority, matching the T7/Insights
  // threshold order) that actually clears its target; falls back to the fiber figure
  // (framed against its goal, not claimed as a win) if none do, so the line is never empty.
  const T = WEEK_SUMMARY_THRESHOLDS;
  const metricCandidates = [
    {
      good: avgFiberPerDay >= T.fiberMinPerDay,
      text: '≈' + Math.round(avgFiberPerDay) + 'g fiber/day'
    },
    {
      good: satFatShare <= T.satFatMaxShare,
      text: 'sat. fat in check — ' + Math.round(satFatShare * 100) + '% of fat'
    },
    {
      good: targetProtein > 0 && avgProteinPerDay >= targetProtein,
      text: 'protein on target — ' + Math.round(avgProteinPerDay) + 'g/day'
    },
    {
      good: omega3Count >= T.omega3MinPerWeek,
      text: 'omega-3 ' + omega3Count + ' meals this week'
    }
  ];
  const metric = metricCandidates.find(function(m){ return m.good; })
    || {good: false, text: Math.round(avgFiberPerDay) + 'g fiber/day (goal ' + T.fiberMinPerDay + 'g)'};

  return {
    tags: topTags,
    metricText: metric.text,
    metricGood: metric.good,
    mealCount: mealCount,
    avgFiberPerDay: avgFiberPerDay,
    avgProteinPerDay: avgProteinPerDay,
    satFatShare: satFatShare,
    omega3Count: omega3Count,
    targetProtein: targetProtein
  };
}

function enumerateSwapUnits(plan){
  const units = [];
  for(let d = 0; d < 7; d++){
    SLOT_ORDER.forEach(function(slot){
      const m = plan.days[d].meals[slot];
      if(m.shared){
        const sharedUnit = {dayIndex: d, slot: slot, shared: true};
        if(canAutoMutateUnit(plan, sharedUnit)) units.push(sharedUnit);
      }
      else {
        const elenaUnit = {dayIndex: d, slot: slot, shared: false, person: 'elena'};
        const partnerUnit = {dayIndex: d, slot: slot, shared: false, person: 'partner'};
        if(canAutoMutateUnit(plan, elenaUnit)) units.push(elenaUnit);
        if(canAutoMutateUnit(plan, partnerUnit)) units.push(partnerUnit);
      }
    });
  }
  return units;
}

// The scalar the greedy search maximizes for a given worst-metric key (higher = better;
// sat-fat is negated since lower is better there).
function objectiveFor(metricKey, plan, fixedPerson){
  const cov = computeWeeklyCoverage(plan);
  if(metricKey === 'omega3') return cov.omega3PerWeek;
  if(metricKey === 'selenium') return cov.seleniumPerWeek;
  if(metricKey === 'fiber') return cov.fiberAvgPerDay[fixedPerson];
  if(metricKey === 'satFat') return -cov.satFatShareOfFat;
  if(metricKey === 'freeSugars' || metricKey === 'freeSugarsWarn') return -cov.freeSugarShareOfKcal;
  return 0;
}

function dailyTotalsForPlan(plan){
  return plan.days.map(function(day){
    return {
      elena: SLOT_ORDER.reduce(function(sum, slot){ return sum + planEntryNutrition(day.meals[slot].elena).kcal; }, 0),
      partner: SLOT_ORDER.reduce(function(sum, slot){ return sum + planEntryNutrition(day.meals[slot].partner).kcal; }, 0)
    };
  });
}

function dailyBandState(plan){
  return dailyTotalsForPlan(plan).map(function(day, di){
    const dateISO = plan.days[di].date;
    const state = {};
    ['elena', 'partner'].forEach(function(person){
      const band = calBand(PROF[person]);
      state[person] = {
        total: day[person],
        min: band[0],
        max: band[1],
        inBand: day[person] >= band[0] && day[person] <= band[1]
      };
    });
    return state;
  });
}

function sideCandidatesForUnit(plan, unit, metricKey, baseObjective, fixedPerson){
  const m = plan.days[unit.dayIndex].meals[unit.slot];
  if(!canAutoMutateUnit(plan, unit)) return [];
  const currentEntry = unit.shared ? m.elena : m[unit.person];
  const currentExtras = Array.isArray(currentEntry.extras) ? currentEntry.extras : [];
  const avoidL = unit.shared ? unionAvoid(PROF.elena.avoid || [], PROF.partner.avoid || []) : (PROF[unit.person].avoid || []);
  const currentDaily = dailyBandState(plan)[unit.dayIndex];
  // task B2: re-balance's side suggestions now come from the same role:'side' pool the
  // generator composes with (sidePoolFor — avoid + season, deliberately not style-filtered),
  // not the old slot='side' + style lookup.
  const sidePool = sidePoolFor(avoidL).filter(function(id){
    return id !== currentEntry.recipeId && currentExtras.every(function(extra){ return !extra || extra.recipeId !== id; });
  });
  const results = [];
  sidePool.forEach(function(sideId){
    const trial = JSON.parse(JSON.stringify(plan));
    addSideToPlan(trial, unit, sideId);
    const trialDaily = dailyBandState(trial)[unit.dayIndex];
    const people = unit.shared ? ['elena', 'partner'] : [unit.person];
    const calorieSafe = people.every(function(personKey){
      const beforeInBand = currentDaily[personKey].inBand;
      const afterInBand = trialDaily[personKey].inBand;
      if(beforeInBand && !afterInBand) return false;
      if(!beforeInBand && !afterInBand) return false;
      return true;
    });
    if(!calorieSafe) return;
    const improved = objectiveFor(metricKey, trial, fixedPerson) - baseObjective;
    if(improved <= 1e-9) return;
    results.push({
      kind: 'addSide',
      unit: unit,
      sideRecipeId: sideId,
      improvement: improved,
      trial: trial
    });
  });
  return results;
}

function todayRebalanceDayIndex(plan, dateISO){
  if(!plan || !Array.isArray(plan.days)) return -1;
  for(let i = 0; i < plan.days.length; i++){
    if(plan.days[i] && plan.days[i].date === dateISO) return i;
  }
  return -1;
}

function canApplyTodayRebalanceUnit(plan, unit, dateISO){
  if(dateISO !== todayISO()) return false;
  const dayIndex = todayRebalanceDayIndex(plan, dateISO);
  if(dayIndex === -1 || !unit || unit.dayIndex !== dayIndex) return false;
  const day = plan.days[dayIndex];
  const meal = day.meals && day.meals[unit.slot];
  if(!meal) return false;
  if(unit.shared || meal.shared){
    return !!meal.shared
      && !loggedSlotLocked(dateISO, 'elena', unit.slot)
      && !loggedSlotLocked(dateISO, 'partner', unit.slot)
      && !isMealPinned(plan.weekStartDate, dayIndex, unit.slot, 'shared');
  }
  if(!unit.person || meal.shared) return false;
  return !loggedSlotLocked(dateISO, unit.person, unit.slot)
    && !isMealPinned(plan.weekStartDate, dayIndex, unit.slot, unit.person);
}

function enumerateTodayRebalanceUnits(plan, dateISO, personKey){
  const dayIndex = todayRebalanceDayIndex(plan, dateISO);
  if(dayIndex === -1) return [];
  const units = [];
  SLOT_ORDER.forEach(function(slot){
    const meal = plan.days[dayIndex].meals[slot];
    if(!meal) return;
    if(meal.shared){
      const sharedUnit = {dayIndex: dayIndex, slot: slot, shared: true};
      if(canApplyTodayRebalanceUnit(plan, sharedUnit, dateISO)) units.push(sharedUnit);
    } else {
      const unit = {dayIndex: dayIndex, slot: slot, shared: false, person: personKey};
      if(canApplyTodayRebalanceUnit(plan, unit, dateISO)) units.push(unit);
    }
  });
  return units;
}

function emptyTodayRebalanceTotals(){
  return {
    elena: {kcal: 0, protein: 0, carbs: 0, fat: 0},
    partner: {kcal: 0, protein: 0, carbs: 0, fat: 0}
  };
}

function addNutritionTotals(a, b){
  ['kcal', 'protein', 'carbs', 'fat'].forEach(function(k){ a[k] += (b && typeof b[k] === 'number') ? b[k] : 0; });
  return a;
}

function todayRebalanceTotals(plan, dateISO){
  const dayIndex = todayRebalanceDayIndex(plan, dateISO);
  const totals = emptyTodayRebalanceTotals();
  ['elena', 'partner'].forEach(function(person){
    const entries = getDayLog(dateISO)[person] || [];
    entries.forEach(function(e){ addNutritionTotals(totals[person], e); });
  });
  if(dayIndex === -1) return totals;
  SLOT_ORDER.forEach(function(slot){
    ['elena', 'partner'].forEach(function(person){
      if(slotLogStatus(dateISO, person, slot)) return;
      const meal = plan.days[dayIndex].meals[slot];
      if(meal && meal[person]) addNutritionTotals(totals[person], planEntryNutrition(meal[person]));
    });
  });
  return totals;
}

function todayMacroTargets(personKey){
  const p = PROF[personKey] || {};
  return {kcal: p.calGoalNum || 0, protein: p.targetP || 0, carbs: p.targetC || 0, fat: p.targetF || 0};
}

function todayRebalancePersonScore(totals, personKey){
  const target = todayMacroTargets(personKey);
  return ['kcal', 'protein', 'carbs', 'fat'].reduce(function(sum, k){
    const denom = Math.max(1, target[k] || 0);
    const weight = k === 'kcal' ? 1.2 : 1;
    return sum + weight * Math.abs((totals[personKey][k] || 0) - target[k]) / denom;
  }, 0);
}

function todayRebalanceScore(plan, dateISO, personKey){
  return todayRebalancePersonScore(todayRebalanceTotals(plan, dateISO), personKey);
}

function todayRebalancePeopleForUnit(unit, personKey){
  return unit && unit.shared ? ['elena', 'partner'] : [personKey];
}

function todayRebalanceCombinedScore(totals, people){
  return people.reduce(function(sum, person){ return sum + todayRebalancePersonScore(totals, person); }, 0);
}

function todayRebalancePersonMeaningfullyWorse(beforeTotals, afterTotals, personKey){
  const before = todayRebalancePersonScore(beforeTotals, personKey);
  const after = todayRebalancePersonScore(afterTotals, personKey);
  return after > before + 0.025;
}

function todayRebalancePeopleProtected(beforeTotals, afterTotals, people){
  return people.every(function(person){ return !todayRebalancePersonMeaningfullyWorse(beforeTotals, afterTotals, person); });
}

function todayRebalanceCurrentRecipeId(plan, unit){
  const meal = plan.days[unit.dayIndex].meals[unit.slot];
  return unit.shared ? meal.recipeId : (meal[unit.person] && meal[unit.person].recipeId);
}

function todayRebalanceUnitSnapshot(plan, unit){
  if(!plan || !unit || !Array.isArray(plan.days) || !plan.days[unit.dayIndex]) return '';
  const meal = plan.days[unit.dayIndex].meals && plan.days[unit.dayIndex].meals[unit.slot];
  if(!meal) return '';
  if(unit.shared || meal.shared){
    return JSON.stringify({
      shared: !!meal.shared,
      recipeId: meal.recipeId || null,
      elena: meal.elena || null,
      partner: meal.partner || null
    });
  }
  return JSON.stringify({
    shared: false,
    person: unit.person || null,
    entry: unit.person ? (meal[unit.person] || null) : null
  });
}

function todayRebalanceChangedSuggestionCount(beforePlan, afterPlan, suggestions){
  if(!beforePlan || !afterPlan || !Array.isArray(suggestions)) return 0;
  return suggestions.reduce(function(count, s){
    if(!s || s.accepted === false || !s.unit) return count;
    return count + (todayRebalanceUnitSnapshot(beforePlan, s.unit) !== todayRebalanceUnitSnapshot(afterPlan, s.unit) ? 1 : 0);
  }, 0);
}

function todayRebalanceCandidateIds(plan, unit, dateISO){
  const styleKey = STYLE_DB_KEY[householdStyle] || 'balanced';
  const avoidL = unit.shared ? unionAvoid(PROF.elena.avoid || [], PROF.partner.avoid || []) : (PROF[unit.person].avoid || []);
  const currentId = todayRebalanceCurrentRecipeId(plan, unit);
  const plannedToday = {};
  const day = plan.days[unit.dayIndex];
  SLOT_ORDER.forEach(function(slot){
    if(slot === unit.slot) return;
    const meal = day.meals[slot];
    if(!meal) return;
    const people = unit.shared ? ['elena', 'partner'] : [unit.person];
    people.forEach(function(person){
      if(slotLogStatus(dateISO, person, slot)) return;
      const id = meal.shared ? meal.recipeId : (meal[person] && meal[person].recipeId);
      if(id) plannedToday[id] = true;
    });
  });
  let pool = candidatesFor(unit.slot, styleKey, avoidL).filter(function(id){ return id !== currentId && !plannedToday[id]; });
  if(!pool.length) pool = candidatesFor(unit.slot, styleKey, avoidL).filter(function(id){ return id !== currentId; });
  return pool;
}

function todayRebalanceSideCandidateIds(plan, unit){
  const meal = plan.days[unit.dayIndex].meals[unit.slot];
  const currentEntry = unit.shared ? meal.elena : meal[unit.person];
  const currentExtras = Array.isArray(currentEntry.extras) ? currentEntry.extras : [];
  const avoidL = unit.shared ? unionAvoid(PROF.elena.avoid || [], PROF.partner.avoid || []) : (PROF[unit.person].avoid || []);
  return sidePoolFor(avoidL).filter(function(sideId){
    return sideId !== currentEntry.recipeId && currentExtras.every(function(extra){ return !extra || extra.recipeId !== sideId; });
  });
}

function proposeTodayRebalanceSuggestions(dateISO, personKey){
  dateISO = dateISO || todayISO();
  personKey = personKey || currentProf;
  const plan = ensureWeekPlan(mondayOfWeek(dateISO));
  const dayIndex = todayRebalanceDayIndex(plan, dateISO);
  if(dateISO !== todayISO() || dayIndex === -1 || ['elena', 'partner'].indexOf(personKey) === -1){
    const emptyTotals = emptyTodayRebalanceTotals();
    return {dateISO: dateISO, personKey: personKey, suggestions: [], before: emptyTotals, after: emptyTotals, resultPlan: plan};
  }
  const beforeTotals = todayRebalanceTotals(plan, dateISO);
  let planCopy = JSON.parse(JSON.stringify(plan));
  const applied = [];
  for(let round = 0; round < 2; round++){
    const baseTotals = todayRebalanceTotals(planCopy, dateISO);
    const candidates = [];
    enumerateTodayRebalanceUnits(planCopy, dateISO, personKey).forEach(function(unit){
      const people = todayRebalancePeopleForUnit(unit, personKey);
      const baseScore = todayRebalanceCombinedScore(baseTotals, people);
      todayRebalanceCandidateIds(planCopy, unit, dateISO).forEach(function(candId){
        const trial = JSON.parse(JSON.stringify(planCopy));
        applySwapToPlan(trial, unit, candId);
        const trialTotals = todayRebalanceTotals(trial, dateISO);
        if(!todayRebalancePeopleProtected(baseTotals, trialTotals, people)) return;
        const score = todayRebalanceCombinedScore(trialTotals, people);
        const improvement = baseScore - score;
        if(improvement <= 1e-9) return;
        candidates.push({kind: 'swap', unit: unit, candId: candId, fromRecipeId: todayRebalanceCurrentRecipeId(planCopy, unit), improvement: improvement, trial: trial});
      });
      todayRebalanceSideCandidateIds(planCopy, unit).forEach(function(sideId){
        const trial = JSON.parse(JSON.stringify(planCopy));
        addSideToPlan(trial, unit, sideId);
        const trialTotals = todayRebalanceTotals(trial, dateISO);
        if(!todayRebalancePeopleProtected(baseTotals, trialTotals, people)) return;
        const score = todayRebalanceCombinedScore(trialTotals, people);
        const improvement = baseScore - score;
        if(improvement <= 1e-9) return;
        candidates.push({kind: 'addSide', unit: unit, sideRecipeId: sideId, improvement: improvement, trial: trial});
      });
    });
    let best = null;
    candidates.forEach(function(c){
      const cKey = c.kind === 'swap' ? unitKey(c.unit) + ':' + c.candId : unitKey(c.unit) + ':side:' + c.sideRecipeId;
      const bKey = best ? (best.kind === 'swap' ? unitKey(best.unit) + ':' + best.candId : unitKey(best.unit) + ':side:' + best.sideRecipeId) : '';
      const better = !best || c.improvement > best.improvement + 1e-9 || (Math.abs(c.improvement - best.improvement) <= 1e-9 && cKey < bKey);
      if(better) best = c;
    });
    if(!best) break;
    planCopy = best.trial;
    if(best.kind === 'swap') applied.push({kind: 'swap', unit: best.unit, fromRecipeId: best.fromRecipeId, toRecipeId: best.candId, improvement: best.improvement});
    else applied.push({kind: 'addSide', unit: best.unit, sideRecipeId: best.sideRecipeId, improvement: best.improvement});
  }
  return {dateISO: dateISO, personKey: personKey, suggestions: applied, before: beforeTotals, after: todayRebalanceTotals(planCopy, dateISO), resultPlan: planCopy};
}

function todayRebalanceAcceptedPlan(prop){
  if(!prop) return null;
  const plan = ensureWeekPlan(mondayOfWeek(prop.dateISO || todayISO()));
  const resultPlan = JSON.parse(JSON.stringify(plan));
  (prop.suggestions || []).forEach(function(s){
    if(s.accepted === false) return;
    if(!canApplyTodayRebalanceUnit(resultPlan, s.unit, prop.dateISO)) return;
    if(s.kind === 'swap') applySwapToPlan(resultPlan, s.unit, s.toRecipeId);
    else if(s.kind === 'addSide') addSideToPlan(resultPlan, s.unit, s.sideRecipeId);
  });
  return resultPlan;
}

function proposeRebalanceSuggestions(weekStartDate){
  const plan = ensureWeekPlan(weekStartDate);
  const cov0 = computeWeeklyCoverage(plan);
  const gaps0 = coverageGaps(cov0);
  const worstKey = Object.keys(gaps0).reduce(function(a, b){ return gaps0[b].gap > gaps0[a].gap ? b : a; });
  const worst = gaps0[worstKey];
  const styleKey = STYLE_DB_KEY[householdStyle] || 'balanced';
  if(worst.gap <= 1e-9){
    return {weekStartDate: plan.weekStartDate, metricKey: worstKey, gapInfo: worst, suggestions: [], before: cov0, after: cov0, resultPlan: plan};
  }
  let planCopy = JSON.parse(JSON.stringify(plan));
  const applied = [];
  const fixedPerson = worst.person; // only meaningful for 'fiber'
  for(let round = 0; round < 2; round++){
    const baseObjective = objectiveFor(worstKey, planCopy, fixedPerson);
    const candidates = [];
    enumerateSwapUnits(planCopy).forEach(function(unit){
      const m = planCopy.days[unit.dayIndex].meals[unit.slot];
      const currentId = unit.shared ? m.recipeId : m[unit.person].recipeId;
      const avoidL = unit.shared ? unionAvoid(PROF.elena.avoid || [], PROF.partner.avoid || []) : (PROF[unit.person].avoid || []);
      const cands = candidatesFor(unit.slot, styleKey, avoidL).filter(function(id){ return id !== currentId; });
      cands.forEach(function(candId){
        const trial = JSON.parse(JSON.stringify(planCopy));
        applySwapToPlan(trial, unit, candId);
        const improvement = objectiveFor(worstKey, trial, fixedPerson) - baseObjective;
        if(improvement > 1e-9){
          candidates.push({kind:'swap', unit: unit, candId: candId, improvement: improvement, trial: trial, fromRecipeId: currentId});
        }
      });
      sideCandidatesForUnit(planCopy, unit, worstKey, baseObjective, fixedPerson).forEach(function(s){
        candidates.push(s);
      });
    });
    let best = null;
    candidates.forEach(function(c){
      const cKey = c.kind === 'swap' ? unitKey(c.unit) + ':' + c.candId : unitKey(c.unit) + ':side:' + c.sideRecipeId;
      const bKey = best ? (best.kind === 'swap' ? unitKey(best.unit) + ':' + best.candId : unitKey(best.unit) + ':side:' + best.sideRecipeId) : '';
      const better = !best || c.improvement > best.improvement + 1e-9 || (Math.abs(c.improvement - best.improvement) <= 1e-9 && cKey < bKey);
      if(better) best = c;
    });
    if(!best) break;
    planCopy = best.trial;
    if(best.kind === 'swap') applied.push({kind:'swap', unit: best.unit, fromRecipeId: best.fromRecipeId, toRecipeId: best.candId, improvement: best.improvement});
    else applied.push({kind:'addSide', unit: best.unit, sideRecipeId: best.sideRecipeId, improvement: best.improvement});
  }
  return {weekStartDate: plan.weekStartDate, metricKey: worstKey, gapInfo: worst, suggestions: applied, before: cov0, after: computeWeeklyCoverage(planCopy), resultPlan: planCopy};
}

function proposeRebalanceSwaps(){
  return proposeRebalanceSuggestions();
}
