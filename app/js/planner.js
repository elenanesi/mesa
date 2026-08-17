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
   other screen reads from: renderWeek/renderTodayMeals/renderLogScreen
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

/* ---------------- VARIETY-plan.md P2: weekly repetition caps ----------------
   How many times ONE recipe may appear in ONE person's week, counting the main dish and
   every composed extra alike. P1 stopped same-day repeats; this is what stops the same
   side turning up on five different days (measured before this cap: 'Carrots over hummus'
   5x and 'Snack: Hummus & veg sticks' 4x in a single person-week).

   Tuned against MEASURED pool sizes, not an ideal — a cap the catalog cannot satisfy just
   makes the never-empty fallback fire on every pick, which looks exactly like the cap
   doing nothing. Per person-week there are 28 meal slots plus ~11 composed side slots,
   against an in-season side pool of 6 and a snack pool of 4 (2 of role 'full', 2 of role
   'side'), so:
     - role 'side'  -> 3: 11 side slots over 6 sides averages 1.8, and the 4-recipe snack
                      pool needs 2 side-role recipes to supply up to 6 of its 7 slots.
     - everything else -> 2: lunch/dinner pools are 24 and breakfast 13, so 2 is generous.
   Raise these once VARIETY-plan.md P3 widens the catalog — that is the whole point of P3,
   and this block is the only place to change. */
const WEEKLY_RECIPE_CAP = {side: 3, main: 2, full: 2};
const WEEKLY_RECIPE_CAP_DEFAULT = 2;
// FAVORITES-EATENOUT-plan.md item 2, Decision Q1: a favorited recipe's weekly cap is +1
// over the same recipe unfavorited (full/main 2->3, side/sauce 3->4) -- the ONE place caps
// are read (applyWeeklyCapFilter and sidePoolLadder both call this), so nothing else needs
// to duplicate the +1. Still a finite ceiling, and still subject to VARIETY-plan.md P1's
// day-wide no-repeat rule -- see testFavorites in tools/check.js for the "doesn't collapse"
// proof.
function weeklyCapForRecipe(id, persons){
  const r = RECIPES_DB[id];
  const cap = r && WEEKLY_RECIPE_CAP[r.role];
  const base = typeof cap === 'number' ? cap : WEEKLY_RECIPE_CAP_DEFAULT;
  return recipeFavoritedByAny(id, persons) ? base + 1 : base;
}

// Drops candidates this person has already used their weekly allowance of. Like every
// other variety rule here it RELAXES rather than ever returning an empty pool — a thin
// catalog must still produce a complete week (see applyLightConsecutiveFilter's doc).
// `persons` mirrors applyVarietyFilter's dayUsePersons: a shared slot must count against
// both people's weeks, since a shared dish lands on both plates.
/* ---------------- lunch/dinner main variety + meat balance ----------------
   User planning preferences, applied only to the 14 lunch/dinner MAIN courses in a
   person-week. Breakfasts, snacks and sides remain deliberately reusable.

   A main course never repeats across lunch and dinner in the same week. Red meat is
   limited to one meal and poultry to three: at most four meat meals total. Fish and
   plant-forward meals remain available. */
const MEAT_WEEK_LIMITS = {red: 1, poultry: 3, total: 4};

/* ---------------- composite ingredients: seeing through a composite's components ----------------
   A composite FOODS entry (data/foods.js — `components` present, e.g. 'pesto-elena')
   behaves like a food but isn't itself a real ingredient id in the hand-picked lists below
   (DAIRY_FOOD_IDS etc, js/library.js) — its DAIRY-ness lives in its components (parmesan),
   not in the composite id. Every helper below that used to test a bare food id against one
   of those lists now goes through `foodOrComponentsMatch`, so a diet/protein-kind check
   "sees through" a composite into what it's actually made of.

   Conservative like `recipeAllPossibleIngredientIds` above (any optionGroups variant, not
   just the default) and for the same reason: this filtering runs on the CANDIDATE POOL
   before engine.js:activeCompositeVariant picks which variant a household actually gets, so
   it has to assume the worst variant a composite could resolve to, not just its declared
   default. `compositeReachableFoodIds` collects every component id reachable from a
   composite across its default AND every declared `variants[*]` entry, recursively through
   nested composites (engine.js:compositeMacrosPer100's doc explains the nesting decision) —
   `seen`/`depth` guard the same authoring-cycle risk that resolver guards against.
   Task proof: removing 'pesto-elena' from DAIRY_FOOD_IDS and 'mayonnaise' from
   EGG_FOOD_IDS (js/library.js) must NOT change what recipeMayContainDairy/Eggs report —
   they're now found via parmesan/eggs in `components` instead of the hardcoded id itself
   (tools/check.js:testCompositeIngredients covers this explicitly). */
function compositeReachableFoodIds(foodId, seen, depth){
  seen = seen || {};
  depth = depth || 0;
  const food = FOODS[foodId];
  const out = [];
  if(!food || !Array.isArray(food.components) || seen[foodId] || depth > 6) return out;
  const nextSeen = Object.assign({}, seen);
  nextSeen[foodId] = true;
  const combos = [food.components].concat((food.variants || []).map(function(v){ return v.components; }));
  combos.forEach(function(components){
    (components || []).forEach(function(c){
      const cId = c && c[0];
      if(!cId || out.indexOf(cId) !== -1) return;
      out.push(cId);
      compositeReachableFoodIds(cId, nextSeen, depth + 1).forEach(function(deepId){
        if(out.indexOf(deepId) === -1) out.push(deepId);
      });
    });
  });
  return out;
}
function foodOrComponentsMatch(foodId, idList){
  if(idList.indexOf(foodId) !== -1) return true;
  return compositeReachableFoodIds(foodId).some(function(cId){ return idList.indexOf(cId) !== -1; });
}

// Which kind of animal protein a meal carries, from its EFFECTIVE ingredients (so an
// optionGroups variant is judged by the choice actually planned, not the default). Red
// outranks poultry outranks fish when a dish somehow contains several. null = meatless.
// The id lists live in js/library.js, which loads AFTER this file — function bodies resolve
// names at call time, and the `typeof` guard matches how foodHitsAvoid already reaches
// GLUTEN_FOOD_IDS/NUT_FOOD_IDS from here. foodOrComponentsMatch (above) sees through a
// composite ingredient into its real components, so a hypothetical meat-based composite
// would be caught here too, not just a bare meat food id.
function proteinKindForIngredientIds(ids){
  if(typeof RED_MEAT_FOOD_IDS === 'undefined') return null;
  if(ids.some(function(i){ return foodOrComponentsMatch(i, RED_MEAT_FOOD_IDS); })) return 'red';
  if(ids.some(function(i){ return foodOrComponentsMatch(i, POULTRY_FOOD_IDS); })) return 'poultry';
  if(ids.some(function(i){ return foodOrComponentsMatch(i, FISH_FOOD_IDS); })) return 'fish';
  return null;
}
function recipeProteinKind(recipeId, opts){
  const r = RECIPES_DB[recipeId];
  if(!r) return null;
  return proteinKindForIngredientIds(recipeEffectiveIngredients(r, opts).map(function(ing){ return ing[0]; }));
}

// Every food id this recipe could possibly contain, across the base ingredients AND every
// optionGroups choice of every group — used whenever a filter has to be conservative about
// a recipe whose variant hasn't been rotated/chosen yet (see the doc above
// recipeMayContainAnimalProtein, which this factors out of). Diet filtering (multi-select
// diets batch, recipeMayContainDairy/Eggs/Honey/MeatOrPoultry below) needs the exact same
// "could this contain X under ANY variant" conservatism, for the exact same reason: the
// candidate pool is filtered BEFORE chosenOptsForRecipe() rotates which choice actually
// gets planned.
function recipeAllPossibleIngredientIds(recipe){
  const ids = (recipe.ingredients || []).map(function(ing){ return ing[0]; });
  (recipe.optionGroups || []).forEach(function(g){
    (g.choices || []).forEach(function(c){
      (c.ingredients || []).forEach(function(ing){ ids.push(ing[0]); });
    });
  });
  return ids;
}

// Could this recipe carry animal protein (red meat, poultry OR fish) under ANY of its
// optionGroups variants? A meatless day has to ask this rather than recipeProteinKind(),
// because the variant is rotated (chosenOptsForRecipe) only AFTER the candidate pool has
// been filtered — so judging by the default choice let a meatless day pick 'pasta', whose
// default condiment is tomato & basil but whose rotation landed on tuna & olives.
// Deliberately conservative: it also excludes a pasta that would have been fine with the
// tomato variant, which is the right trade when the alternative is silently breaking the
// day's one hard nutritional promise (and, since the multi-select diets batch, the same
// trade recipeViolatesDiet's vegan/vegetarian check below makes for the same reason).
function recipeMayContainAnimalProtein(id){
  const r = RECIPES_DB[id];
  if(!r) return false;
  return proteinKindForIngredientIds(recipeAllPossibleIngredientIds(r)) !== null;
}
// Pescatarian-specific: red meat or poultry (fish is fine for a pescatarian), same
// any-variant conservatism as recipeMayContainAnimalProtein above.
function recipeMayContainMeatOrPoultry(id){
  const r = RECIPES_DB[id];
  if(!r || typeof RED_MEAT_FOOD_IDS === 'undefined') return false;
  const ids = recipeAllPossibleIngredientIds(r);
  return ids.some(function(i){ return foodOrComponentsMatch(i, RED_MEAT_FOOD_IDS) || foodOrComponentsMatch(i, POULTRY_FOOD_IDS); });
}
// foodOrComponentsMatch (above) sees THROUGH a composite ingredient (e.g. 'pesto-elena')
// into its real components (parmesan, pecorino) — this is what lets 'pesto-elena' be
// removed from the hardcoded DAIRY_FOOD_IDS list (js/library.js) and STILL get excluded
// from vegan/lactose-intolerant menus, purely because parmesan is real dairy.
function recipeMayContainDairy(id){
  const r = RECIPES_DB[id];
  if(!r || typeof DAIRY_FOOD_IDS === 'undefined') return false;
  return recipeAllPossibleIngredientIds(r).some(function(i){ return foodOrComponentsMatch(i, DAIRY_FOOD_IDS); });
}

// Unlike the conservative catalog scan above, this follows the composite formula that is
// active for this household. It is used only when testing a concrete recipe option: a
// lactose-free pesto formula must be allowed to make its parent recipe eligible.
function foodOrActiveComponentsMatch(foodId, idList, seen){
  if(idList.indexOf(foodId) !== -1) return true;
  const food = FOODS[foodId];
  if(!food || !Array.isArray(food.components)) return false;
  seen = seen || {};
  if(seen[foodId]) return false;
  const next = Object.assign({}, seen); next[foodId] = true;
  const active = typeof activeCompositeVariant === 'function' ? activeCompositeVariant(food) : food;
  return (active.components || []).some(function(c){ return foodOrActiveComponentsMatch(c[0], idList, next); });
}
function ingredientIdsViolateDiet(ids, dietList){
  if(!dietList || !dietList.length) return false;
  const has = function(list){ return (ids || []).some(function(id){ return foodOrActiveComponentsMatch(id, list); }); };
  if((dietList.indexOf('vegan') !== -1 || dietList.indexOf('vegetarian') !== -1) && (has(RED_MEAT_FOOD_IDS) || has(POULTRY_FOOD_IDS) || has(FISH_FOOD_IDS))) return true;
  if(dietList.indexOf('pescatarian') !== -1 && (has(RED_MEAT_FOOD_IDS) || has(POULTRY_FOOD_IDS))) return true;
  if(dietList.indexOf('vegan') !== -1 && (has(DAIRY_FOOD_IDS) || has(EGG_FOOD_IDS) || has(HONEY_FOOD_IDS))) return true;
  if(dietList.indexOf('lactose-intolerant') !== -1 && has(DAIRY_FOOD_IDS)) return true;
  return false;
}
// Same composite-aware derivation as recipeMayContainDairy above — this is what lets
// 'mayonnaise' be removed from the hardcoded EGG_FOOD_IDS list and still get excluded from
// vegan menus, purely because 'eggs' is one of its real components.
function recipeMayContainEggs(id){
  const r = RECIPES_DB[id];
  if(!r || typeof EGG_FOOD_IDS === 'undefined') return false;
  return recipeAllPossibleIngredientIds(r).some(function(i){ return foodOrComponentsMatch(i, EGG_FOOD_IDS); });
}
function recipeMayContainHoney(id){
  const r = RECIPES_DB[id];
  if(!r || typeof HONEY_FOOD_IDS === 'undefined') return false;
  return recipeAllPossibleIngredientIds(r).some(function(i){ return foodOrComponentsMatch(i, HONEY_FOOD_IDS); });
}
// "Fish/meat dinners that are not salads or pasta" (user, 2026-07-22): a fish- or meat-based,
// PROTEIN-FORWARD dish (more kcal from protein than carbs) belongs at DINNER, not lunch —
// UNLESS it's a salad, a pasta/noodle dish, or an egg dish, all of which are lunch-friendly.
// The carb-forward test alone exempts pasta/grain/legume dishes (a tuna PASTA is carb-heavy
// -> stays lunch); the salad-title and egg checks exempt the cases the macro test would
// otherwise misclassify (a lean tuna SALAD is protein-forward but IS a salad; an eggs+turkey
// dish is breakfast/lunch food). Used ONLY to drop such a recipe from LUNCH auto-planning
// (candidatesFor) and ONLY when it can still go to dinner — so a deliberately lunch-only dish
// is never stranded, and manual swap search (buildSwapSearchOptions) still lets you put a
// fish at lunch by hand.
const PASTA_NOODLE_FOOD_IDS = ['pasta', 'spaghetti', 'wholegrain-pasta', 'lasagna-sheets', 'ravioli', 'egg-noodles', 'ramen-noodles'];
function isDinnerOnlyProteinMain(id){
  const r = RECIPES_DB[id];
  if(!r || recipeProteinKind(id) === null) return false;      // no fish/meat -> rule doesn't apply
  const base = dbBaseNutrition(id);
  if(!(base.kcal > 0) || base.protein * 4 <= base.carbs * 4) return false; // carb-forward stays lunch
  const ids = recipeEffectiveIngredients(r, {}).map(function(ing){ return ing[0]; });
  if(ids.indexOf('eggs') !== -1) return false;                // egg dishes are breakfast/lunch food
  if(/salad|insalata/i.test(r.title || '')) return false;     // explicit salads stay lunch
  if(ids.some(function(i){ return PASTA_NOODLE_FOOD_IDS.indexOf(i) !== -1; })) return false; // pasta/noodles stay lunch
  return true;
}

// A whole meal unit (main + composed extras) — a veg side never makes a chicken dish
// meatless, and a tuna side would make an otherwise-meatless main a fish meal.
function entryProteinKind(entry){
  const ids = [];
  planEntryComponents(entry).forEach(function(c){
    if(c.recipeId && RECIPES_DB[c.recipeId]){
      recipeEffectiveIngredients(RECIPES_DB[c.recipeId], c.opts).forEach(function(ing){ ids.push(ing[0]); });
    } else if(c.foodId){ ids.push(c.foodId); }
  });
  return proteinKindForIngredientIds(ids);
}

function applyLunchDinnerMainRules(pool, history, persons, slot){
  if(slot !== 'lunch' && slot !== 'dinner') return pool;
  // candidatesFor() also exposes sides (which the picker discards for a main position),
  // so apply these constraints only to ids that can truly become the meal's base dish.
  const mainPool = pool.filter(isAutoLunchDinnerMain);
  const unusedMain = mainPool.filter(function(id){
    return persons.every(function(p){ return !history[p].lunchDinnerMainUse[id]; });
  });
  let out = unusedMain.length
    ? pool.filter(function(id){ return !isAutoLunchDinnerMain(id) || unusedMain.indexOf(id) !== -1; })
    : pool;
  if(!unusedMain.length && mainPool.length) mainRepeatRelaxations++;
  const underMeatLimit = out.filter(function(id){
    if(!isAutoLunchDinnerMain(id)) return false;
    const kind = recipeProteinKind(id);
    if(kind !== 'red' && kind !== 'poultry') return true;
    return persons.every(function(p){
      const use = history[p].meatUse;
      return use.total < MEAT_WEEK_LIMITS.total && use[kind] < MEAT_WEEK_LIMITS[kind];
    });
  });
  if(underMeatLimit.length){
    return out.filter(function(id){ return !isAutoLunchDinnerMain(id) || underMeatLimit.indexOf(id) !== -1; });
  }
  if(mainPool.length) meatRuleRelaxations++;
  return out;
}
let mainRepeatRelaxations = 0;
let meatRuleRelaxations = 0;

// Counts how often a weekly cap had to be relaxed during one generateWeek(). A relaxation
// is not a bug — every rule here degrades rather than returning an empty pool — but it does
// mean the catalog cannot supply that slot within quota, which is otherwise invisible and
// looks exactly like the cap doing nothing. Reported once per generation (see generateWeek)
// rather than per pick, so it stays quiet while remaining actionable: it is the signal for
// which pools VARIETY-plan.md P3 needs to widen.
let weeklyCapRelaxations = 0;

// Empty-pool guard (task 5, multi-select diets batch): counts how many individual picks
// during one generateWeek() came up with NO candidate at all (pickSharedMeal/pickSoloMeal's
// `if(!best)` branches) — an exotic filter combination (e.g. vegan + gluten-free in a thin
// season) can still starve a slot even with a widened catalog. Unlike every relaxation rule
// above, an empty pool truly cannot be filled — there is nothing to relax to. Reset per
// generateWeek() call and copied onto the returned plan as `emptyPoolCount` so callers (and
// tests) can detect a degraded plan without re-deriving it; the render layer shows an honest
// "no meal fits your filters" card for any slot marked reason:'no-candidates' rather than a
// silent blank, so the user learns their filters are too tight instead of getting a plan
// that looks broken for no visible reason.
let emptyPoolPicks = 0;

function applyWeeklyCapFilter(pool, history, persons){
  const under = pool.filter(function(id){
    const cap = weeklyCapForRecipe(id, persons);
    return persons.every(function(p){ return (history[p].weekUse[id] || 0) < cap; });
  });
  if(under.length) return under;
  if(pool.length) weeklyCapRelaxations++;
  return pool;
}

// The composed-side pool's priority ladder. Nesting the three rules instead (cap wrapped
// around the day/yesterday filter) silently ranked them wrong: "not yesterday" ended up
// outranking "under quota", and sides still reached 4x a week against a cap of 3, because
// the inner filter handed up a set that was entirely over quota and the cap could only
// relax back onto it.
//
// Stated as an explicit ladder instead, worst-first: a SAME-DAY repeat is the most visible
// failure, an over-quota WEEK the next, and a day-apart repeat the least. Each rung adds
// back exactly one relaxation, and the first non-empty rung wins — so the pool can never
// come back empty, and a constraint is only ever dropped after every softer one already has.
function sidePoolLadder(rawPool, history, persons, dayIndex){
  const today = {}, yesterday = {};
  persons.forEach(function(p){
    (history[p].dayUseRecipe[dayIndex] || []).forEach(function(id){ today[id] = true; });
    (history[p].sideUse[dayIndex - 1] || []).forEach(function(id){ yesterday[id] = true; });
  });
  function underCap(id){
    const cap = weeklyCapForRecipe(id, persons);
    return persons.every(function(p){ return (history[p].weekUse[id] || 0) < cap; });
  }
  const rungs = [
    rawPool.filter(function(id){ return !today[id] && underCap(id) && !yesterday[id]; }),
    rawPool.filter(function(id){ return !today[id] && underCap(id); }),
    rawPool.filter(function(id){ return !today[id]; }),
    rawPool.filter(function(id){ return underCap(id); }),
    rawPool
  ];
  for(let i = 0; i < rungs.length; i++){
    if(!rungs[i].length) continue;
    // Rungs 2 and 4 are the ones that dropped the weekly cap — same signal
    // applyWeeklyCapFilter records, so P3 can see which pools are too thin.
    if(i === 2 || i === 4) weeklyCapRelaxations++;
    return rungs[i];
  }
  return rawPool;
}
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

// Real diet-filter semantics (multi-select diets batch, replacing the D4 mock — see
// KNOWLEDGE-BASE.md for the full rationale). `id` (not the recipe object) so this can
// reach the id-based recipeMayContain*() helpers above, which all judge a recipe by its
// EFFECTIVE ingredients across EVERY optionGroups variant (recipeAllPossibleIngredientIds)
// — the same conservative "could violate under ANY variant" approach
// recipeMayContainAnimalProtein already used pre-this-batch, for the same reason: the
// variant is only rotated (chosenOptsForRecipe) AFTER the candidate pool is filtered.
// `dietList` is the UNION of every diet active among the person(s) this pool is for
// (unionDiets below) — a SHARED slot must satisfy everyone, so each check below is
// independent or-logic: the recipe violates if ANY diet in the list rules it out.
//   vegan:              no meat, poultry, fish, dairy, eggs or honey
//   vegetarian:         no meat, poultry or fish (eggs and dairy allowed)
//   pescatarian:        no meat or poultry (fish allowed)
//   gluten-free:        recipe must not carry 'gluten' in its own (hand-authored) avoid list
//   lactose-intolerant: no dairy (recipeMayContainDairy — NOT the old avoid-list hack,
//                       which is retired; see state.js:loadState()'s migration doc)
function recipeViolatesDiet(id, dietList){
  const recipe = RECIPES_DB[id];
  if(!recipe || !dietList || !dietList.length) return false;
  if(ingredientIdsViolateDiet((recipe.ingredients || []).map(function(ing){ return ing[0]; }), dietList)) return true;
  if(dietList.indexOf('gluten-free') !== -1 && recipe.avoid && recipe.avoid.indexOf('gluten') !== -1) return true;
  if(Array.isArray(recipe.optionGroups) && recipe.optionGroups.some(function(group){
    return !allowedChoicesForGroup(group, [], dietList).length;
  })) return true;
  return false;
}
// The union of every diet active among `persons` — a SHARED slot's candidate pool must
// satisfy BOTH people at once (unlike avoid-lists, which unionAvoid() already combines the
// same way), a SOLO slot's pool just the one. Every candidatesFor()/sidePoolFor() call site
// already passes the right `persons` for its slot (see planner.js callers of both) — this
// is the one place that turns "which people" into "which diets to enforce".
function unionDiets(persons){
  const set = {};
  (persons || []).forEach(function(p){
    ((PROF[p] && PROF[p].diets) || []).forEach(function(d){ set[d] = true; });
  });
  return Object.keys(set);
}
// PERSONAL-PREFS: recipePrefs (state.js) is now {elena:{},partner:{}} — reads always go
// through one specific person. recipeFavoritedByAny/recipeDownedByAny are the "either
// person" checks a SHARED slot needs (Decisions: "either-down excludes, either-favorite
// boosts") — pass the one or two persons relevant to the call site (see each caller).
function recipePref(id, person){ return (recipePrefs[person] && recipePrefs[person][id]) || null; }
function recipeFavoritedByAny(id, persons){
  return (persons || []).some(function(p){ return recipePref(id, p) === 'favorite'; });
}
function recipeDownedByAny(id, persons){
  return (persons || []).some(function(p){ return recipePref(id, p) === 'down'; });
}
// Every recipe for a slot x style that doesn't hit the given avoid-list, sorted
// lexicographically by id (the base order every tie-break falls back to). `persons` is
// who this candidate pool is FOR — a shared slot passes both, a solo slot passes just the
// one person — used only for the down-vote filter below (opts.includeThumbsDown bypasses
// it regardless of persons, same as before this batch).
// Also filters by diet preferences — see recipeViolatesDiet()'s doc above for the exact
// per-diet semantics and unionDiets() for how multiple people's diets combine.
function candidatesFor(slot, styleKey, avoidList, persons, opts){
  opts = opts || {};
  const dietList = unionDiets(persons);
  return Object.keys(RECIPES_DB).filter(function(id){
    const r = RECIPES_DB[id];
    return !r.occasional
      && (opts.includeThumbsDown || !recipeDownedByAny(id, persons))
      && (typeof recipeAllowedForCurrentSeason !== 'function' || recipeAllowedForCurrentSeason(id))
      && recipeSlotList(r).indexOf(slot) !== -1
      // Fish/meat protein mains (not salads/pasta/eggs) skip LUNCH auto-planning when they can
      // go to dinner instead — see isDinnerOnlyProteinMain (user rule, 2026-07-22).
      && !(slot === 'lunch' && recipeSlotList(r).indexOf('dinner') !== -1 && isDinnerOnlyProteinMain(id))
      && r.styles.indexOf(styleKey) !== -1
      && !recipeHitsAvoid(r, avoidList)
      && !recipeViolatesDiet(id, dietList)
      && recipeOptionsViable(r, avoidList, dietList);
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
// Also filters by diet preferences — same unionDiets()/recipeViolatesDiet() as candidatesFor().
function sidePoolFor(avoidList, persons){
  const dietList = unionDiets(persons);
  return Object.keys(RECIPES_DB).filter(function(id){
    const r = RECIPES_DB[id];
    return r.role === 'side'
      && !r.occasional
      && !recipeDownedByAny(id, persons)
      && (typeof recipeAllowedForCurrentSeason !== 'function' || recipeAllowedForCurrentSeason(id))
      && !recipeHitsAvoid(r, avoidList)
      && !recipeViolatesDiet(id, dietList);
  }).sort();
}

/* Lunch and dinner have a non-negotiable composition contract.  We deliberately
   derive it from the actual ingredient quantities rather than recipe titles/tags:
   protein must contribute at least 12g, the carbohydrate ingredient at least 15g
   carbs, and vegetables/fibre must include at least 80g of Produce.  Option-group
   ingredients are not used here: a full recipe is eligible only when its base recipe
   is complete for every selectable variant. */
function mealStructureForRecipe(recipe){
  const parts = {protein: 0, carbs: 0, vegG: 0};
  (recipe && recipe.ingredients || []).forEach(function(ing){
    const food = FOODS[ing[0]];
    if(!food) return;
    const grams = Number(ing[1]) || 0;
    const m = foodMacros(ing[0], grams);
    if(food.cat === 'Protein' || food.cat === 'Dairy' || m.protein >= 12) parts.protein += m.protein;
    // Plant proteins such as legumes and tofu are Protein-category foods in Mesa;
    // this threshold also prevents oil, seasoning, or a few vegetables from posing
    // as the requested carbohydrate source.
    if(m.carbs >= 10) parts.carbs += m.carbs;
    if(food.cat === 'Produce') parts.vegG += grams;
  });
  return {protein: parts.protein >= 12, carbs: parts.carbs >= 15, veg: parts.vegG >= 80};
}
function isCompleteLunchDinnerRecipe(id){
  const p = mealStructureForRecipe(RECIPES_DB[id]);
  return p.protein && p.carbs && p.veg;
}
function isProteinMain(id){ return mealStructureForRecipe(RECIPES_DB[id]).protein; }
function isAutoLunchDinnerMain(id){
  const r = RECIPES_DB[id];
  return !!r && (r.role === 'full' ? isCompleteLunchDinnerRecipe(id) : (r.role === 'main' && isProteinMain(id)));
}
function isCarbSide(id){ return mealStructureForRecipe(RECIPES_DB[id]).carbs; }
function isVegSide(id){ return mealStructureForRecipe(RECIPES_DB[id]).veg; }

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
  // Explicit allergen list — a hand-authored escape hatch for a custom food whose real
  // ingredients Mesa has no other way to see (e.g. a trace-allergen warning with no
  // `components` behind it). A COMPOSITE (pesto-elena etc) no longer needs this: its
  // allergen membership is DERIVED below by recursing into `components`, which is what
  // lets removing pesto-elena's hand-authored containsAvoid stay correct (task: composite-
  // ingredients engine) — the recursion finds parmesan (Dairy) and almonds (NUT_FOOD_IDS)
  // on its own.
  if(Array.isArray(food.containsAvoid) && food.containsAvoid.some(function(k){ return avoidList.indexOf(k) !== -1; })) return true;
  if(avoidList.indexOf('lactose') !== -1 && food.cat === 'Dairy') return true;
  if(avoidList.indexOf('gluten') !== -1 && typeof GLUTEN_FOOD_IDS !== 'undefined' && GLUTEN_FOOD_IDS.indexOf(foodId) !== -1) return true;
  if(avoidList.indexOf('shellfish') !== -1 && foodId === 'prawns') return true;
  if(avoidList.indexOf('nuts') !== -1 && typeof NUT_FOOD_IDS !== 'undefined' && NUT_FOOD_IDS.indexOf(foodId) !== -1) return true;
  // Composite: recurse into every variant's components (any-variant conservative, same
  // reasoning as compositeReachableFoodIds/foodOrComponentsMatch above the diet helpers) —
  // reusing this same function per component means lactose/gluten/shellfish/nuts are all
  // derived through the identical rules a plain food already gets, recursively through a
  // nested composite too.
  if(Array.isArray(food.components)){
    return compositeReachableFoodIds(foodId).some(function(cId){ return foodHitsAvoid(cId, avoidList); });
  }
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
function choiceMatchesDietKeys(choice, dietList){
  // An untagged choice is generally available; a tagged one is a diet-specific variant.
  return !Array.isArray(choice.dietKeys) || !choice.dietKeys.length || (dietList || []).some(function(k){ return choice.dietKeys.indexOf(k) !== -1; });
}
function choiceViolatesDiet(choice, dietList){
  return ingredientIdsViolateDiet((choice && choice.ingredients || []).map(function(ing){ return ing[0]; }), dietList);
}
function allowedChoicesForGroup(group, avoidList, dietList){
  return (group && Array.isArray(group.choices) ? group.choices : [])
    .filter(function(c){ return c && typeof c.id === 'string' && choiceMatchesDietKeys(c, dietList) && !choiceHitsAvoid(c, avoidList) && !choiceViolatesDiet(c, dietList); })
    .slice()
    .sort(function(a, b){ return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0); });
}

// A recipe with optionGroups can only be planned under `avoidList` if EVERY group still
// has >=1 allowed choice — one empty group makes the whole dish unservable for that
// avoid-list, so the recipe drops from the candidate pool entirely (candidatesFor()
// above calls this for every recipe, options or not — recipes without optionGroups are
// always viable, unaffected). Recipes without optionGroups are always viable (true).
function recipeOptionsViable(recipe, avoidList, dietList){
  if(!recipe || !Array.isArray(recipe.optionGroups) || !recipe.optionGroups.length) return true;
  return recipe.optionGroups.every(function(group){ return allowedChoicesForGroup(group, avoidList, dietList).length > 0; });
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
// NOTE (variant-fit planner task): pickSharedMeal/pickSoloMeal no longer call this to
// choose the FINAL opts for a winning candidate — they now score every viable combo
// (viableRecipeOptionCombos below) and keep whichever one actually fit the slot, so the
// combo on a generated entry is never a rotation re-roll after the fact. This function
// stays: it is still exercised directly by tools/check.js's rotation/avoid-respect tests,
// and remains available as a pure "rotate through the choices" helper for any future
// caller (e.g. a recipe-screen "surprise me" control) that wants variety instead of fit.
function chosenOptsForRecipe(recipe, weekSeed, dayIndex, slotIndex, avoidList, dietList){
  if(!recipe || !Array.isArray(recipe.optionGroups) || !recipe.optionGroups.length) return null;
  const opts = {};
  for(let i = 0; i < recipe.optionGroups.length; i++){
    const group = recipe.optionGroups[i];
    if(!group || typeof group.key !== 'string') continue;
    const allowed = allowedChoicesForGroup(group, avoidList, dietList);
    if(!allowed.length) return null;
    const idx = ((weekSeed || 0) + dayIndex * 7 + slotIndex) % allowed.length;
    opts[group.key] = allowed[idx].id;
  }
  return opts;
}

// task (variant-fit planner): every VIABLE {groupKey: choiceId} combo for a recipe's
// optionGroups — one choice per group, cartesian-producted across groups in AUTHORED
// group order, each group's choices already sorted by id (allowedChoicesForGroup's own
// tie-break) — so the returned array is in a fixed, deterministic order for a given
// (recipeId, avoidList, dietList). Reuses allowedChoicesForGroup rather than re-deriving
// avoid/diet viability — the exact per-choice gate recipeOptionsViable/
// chosenOptsForRecipe already use, so a choice excluded there is excluded here too. A
// recipe without optionGroups (or an empty optionGroups array) has exactly one "combo":
// {} — the same empty-opts shape normalizeRecipeOpts/recipeEffectiveIngredients already
// treat as "use the defaults", so pickSharedMeal/pickSoloMeal need no options-less
// special case to stay byte-identical for the common case. If a group has zero allowed
// choices under this avoid/diet-list (the whole recipe should already have been excluded
// by candidatesFor()'s recipeOptionsViable gate before this is ever reached from there),
// this returns [] — an empty result a caller's .forEach() simply skips, rather than a
// combo silently missing that group.
function viableRecipeOptionCombos(recipeId, avoidList, dietList){
  const r = (typeof RECIPES_DB !== 'undefined') ? RECIPES_DB[recipeId] : undefined;
  if(!r || !Array.isArray(r.optionGroups) || !r.optionGroups.length) return [{}];
  let combos = [{}];
  for(let i = 0; i < r.optionGroups.length; i++){
    const group = r.optionGroups[i];
    if(!group || typeof group.key !== 'string') continue;
    const allowed = allowedChoicesForGroup(group, avoidList, dietList);
    if(!allowed.length) return [];
    const next = [];
    combos.forEach(function(combo){
      allowed.forEach(function(choice){
        const c = Object.assign({}, combo);
        c[group.key] = choice.id;
        next.push(c);
      });
    });
    combos = next;
  }
  return combos;
}

// Deterministic string key for an opts combo — keys sorted so key ORDER never affects the
// signature, '' for {}/null (an options-less recipe's one-and-only "combo"). Used only to
// keep pickSharedMeal/pickSoloMeal's final tie-break (`c.tieId < best.tieId`) meaningful
// now that a single recipe can contribute one candidate PER viable combo instead of
// exactly one — an options-less recipe's tieId is untouched ('' appends nothing), so its
// candidates stay byte-identical to pre-variant-fit output.
function optsComboSignature(opts){
  if(!opts) return '';
  const keys = Object.keys(opts).sort();
  if(!keys.length) return '';
  return keys.map(function(k){ return k + '=' + opts[k]; }).join(',');
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
// on the day right before dayIndex (window = 1 day, `prevDayUsedArrays`) OR already placed
// earlier TODAY (`todayUsedArrays` — VARIETY-plan.md P1, e.g. history.<person>.dayUseRecipe
// / .dayUseFood for dayIndex; this is what stops the same side landing at both lunch and
// dinner) by any of the given persons — both exclusions are merged into one set and applied
// together so there's a single relax step: per the tagging handoff, SKIPS the rule (falls
// back to the fully unfiltered pool) rather than ever emptying an already-tiny pool.
// `todayUsedArrays` is optional so existing callers that only ever cared about yesterday
// keep working unchanged.
function applyLightConsecutiveFilter(pool, prevDayUsedArrays, todayUsedArrays){
  const yesterday = {}, today = {};
  (prevDayUsedArrays || []).forEach(function(arr){ (arr || []).forEach(function(id){ yesterday[id] = true; }); });
  (todayUsedArrays || []).forEach(function(arr){ (arr || []).forEach(function(id){ today[id] = true; }); });
  const strict = pool.filter(function(id){ return !yesterday[id] && !today[id]; });
  if(strict.length) return strict;
  // Relax in STAGES, dropping the YESTERDAY rule before the TODAY one. Collapsing both into
  // a single relax step (the first version of this fix) meant a thin pool — 6 in-season
  // sides feeding ~14 composed slots a week — fell straight back to the fully unfiltered
  // pool and re-allowed the side already served earlier today, which is exactly the repeat
  // P1 exists to stop. A day-apart repeat is barely noticeable; the same side at lunch and
  // dinner is the thing the user actually sees, so today's exclusion is the last to go.
  const todayOnly = pool.filter(function(id){ return !today[id]; });
  if(todayOnly.length) return todayOnly;
  return pool;
}

// Records which side/food id a composed pick used that day, for the light consecutive-day
// rule above (history.<person>.sideUse / .bfPairUse, parallel to the existing per-slot
// history arrays). A no-op when the entry has no extras (full-recipe or standalone picks).
// Legacy/narrow (extras[0] only, yesterday-only consumer) — kept as-is; see recordDayUsage
// below for the day-wide log that also covers the main dish and every extra.
function recordCompositionUsage(history, entry, person, slot, dayIndex){
  if(!entry || !Array.isArray(entry.extras) || !entry.extras.length) return;
  const extra = entry.extras[0];
  const bucket = slot === 'breakfast' ? 'bfPairUse' : 'sideUse';
  if(!history[person][bucket][dayIndex]) history[person][bucket][dayIndex] = [];
  history[person][bucket][dayIndex].push(extra.recipeId || extra.foodId);
}

// VARIETY-plan.md P1 ("day-wide variety"): per-person, per-day usage log of EVERY id placed
// that day — the main dish AND every composed extra (planEntryComponents(), not just
// extras[0] the way the legacy recordCompositionUsage above does) — so a repeat can be
// caught across slots within the same day (e.g. the same main at both lunch and dinner, or
// a side reused as the standalone snack), not just within one slot's own history.
//
// Recipe ids and FOODS ids are separate id spaces that are NOT guaranteed disjoint (at
// least one real collision exists in the catalog today: 'pasta' is both a recipe id and a
// food id), so they're logged into two separate per-day arrays — dayUseRecipe / dayUseFood
// — rather than one combined set. This mirrors the sideUse (recipes) / bfPairUse (foods)
// split already used above, and means a food id can never accidentally shadow-exclude an
// unrelated recipe of the same id (or vice versa).
function recordDayUsage(history, entry, person, dayIndex, slot){
  // VARIETY-plan.md P2: one increment per MEAL unit (not per component) — a chicken main
  // with a veg side is one poultry meal, not one poultry plus one meatless.
  const kind = entryProteinKind(entry);
  if((slot === 'lunch' || slot === 'dinner') && entry.recipeId){
    history[person].lunchDinnerMainUse[entry.recipeId] = true;
    if(kind === 'red' || kind === 'poultry'){
      history[person].meatUse[kind]++;
      history[person].meatUse.total++;
    }
  }
  planEntryComponents(entry).forEach(function(c){
    if(c.recipeId){
      if(!history[person].dayUseRecipe[dayIndex]) history[person].dayUseRecipe[dayIndex] = [];
      history[person].dayUseRecipe[dayIndex].push(c.recipeId);
      // VARIETY-plan.md P2: same walk feeds the whole-week tally the cap reads.
      history[person].weekUse[c.recipeId] = (history[person].weekUse[c.recipeId] || 0) + 1;
    } else if(c.foodId){
      if(!history[person].dayUseFood[dayIndex]) history[person].dayUseFood[dayIndex] = [];
      history[person].dayUseFood[dayIndex].push(c.foodId);
    }
  });
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

// "Save a composed meal as a recipe" (library.js:saveComposedMealAsRecipe, wired from the
// add-meal composer's own 💾 button, render-today.js): flattens planEntryComponents()'s
// LIVE component list — base recipe + every extra — into a single foodId-merged ingredient
// list a NEW custom recipe can be saved from. A recipe component expands via engine.js:
// recipeEffectiveIngredients(r, c.opts) — base ingredients plus whichever opts-selected
// variant this component actually froze — scaled from "one batch" to "c.portion servings of
// it, in a batch that yields r.servings servings" (grams * portion / batchYield), the EXACT
// scaling recipeNutrition/nutritionForRecipeComponents use, so the flattened recipe's own
// nutrition (recipeNutrition(newId, 1)) reproduces the composed meal's totals. Deliberately
// does NOT go through planner.js:foodQuantitiesForComponents — that helper is the shopping
// list's own decomposition (converts `piece`-unit foods to a unit count and explodes
// composite FOODS into their sub-ingredients), neither of which belongs in a recipe's own
// ingredient list: a composite food id here should stay ONE row, just like it does in every
// hand-authored recipe in data/recipes.js. A food component adds its own grams directly.
// The same foodId appearing more than once (the base recipe and an extra both using
// olive-oil, say) is summed into ONE row rather than duplicated — merged rows keep the
// FIRST-seen insertion order, matching how a person would naturally list a recipe's
// ingredients. Grams are rounded to the nearest whole gram (data/recipes.js's own
// convention — every hand-authored ingredient row is an integer) once accumulation is done,
// not per-component, so merging several fractional contributions doesn't compound rounding
// error.
function flattenComponentsToIngredientRows(components){
  const rows = [];
  const indexByFoodId = {};
  function addGrams(foodId, grams){
    if(!(grams > 0)) return;
    if(indexByFoodId.hasOwnProperty(foodId)){
      rows[indexByFoodId[foodId]].grams += grams;
    } else {
      indexByFoodId[foodId] = rows.length;
      rows.push({foodId: foodId, grams: grams});
    }
  }
  (components || []).forEach(function(c){
    if(c && c.recipeId && RECIPES_DB[c.recipeId]){
      const r = RECIPES_DB[c.recipeId];
      const batchYield = (typeof r.servings === 'number' && r.servings > 0) ? r.servings : 1;
      const portion = (typeof c.portion === 'number' && c.portion > 0) ? c.portion : 1;
      recipeEffectiveIngredients(r, c.opts).forEach(function(ing){
        addGrams(ing[0], ing[1] * portion / batchYield);
      });
    } else if(c && c.foodId && FOODS[c.foodId]){
      addGrams(c.foodId, (typeof c.grams === 'number' && c.grams > 0) ? c.grams : 0);
    }
  });
  rows.forEach(function(row){ row.grams = Math.round(row.grams); });
  return rows;
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
    shared: !!shared,
    // Empty-pool guard (task 5): 'no-candidates' when this cell is a genuinely-starved
    // pick (pickSharedMeal/pickSoloMeal found zero legal candidates), undefined otherwise
    // — including for a solo household's intentionally-unused partner cell
    // (emptyPlanEntry()), which never sets this field. Read by render-today.js/
    // render-week.js to show an honest message instead of a blank/broken-looking slot.
    reason: entry && entry.reason
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

// Task B3 (solo households): the shape a meal cell's partner half takes in a one-person
// household — "empty/zeroed, NOT ghost-planned" per PHASE3B-generic-spec.md. Reuses the
// SAME {recipeId:null, portion:1, kcal:0, protein:0} shape the generator already falls back
// to when a candidate pool comes up empty (pickSoloMeal/pickSharedMeal below) — every
// existing reader already tolerates it: planEntryComponents/planEntryNutrition/
// refreshPlanEntryNutrition/planEntryRecipeValid all treat a null recipeId as "nothing
// here" (see their own guards), so it contributes zero to shopping/pantry aggregation,
// nutrition totals and coverage without any of them needing a partner-aware special case.
// A fresh object every call — never a shared reference two different cells could both
// mutate.
function emptyPlanEntry(){
  return {recipeId: null, portion: 1, kcal: 0, protein: 0};
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

// Reads through slotLoggedReadOnly (below) rather than slotLogStatus directly: slotLogStatus
// goes through log.js:getDayLog(), which LAZILY CREATES an empty logHistory record for any
// date it's asked about (see slotLoggedReadOnly's own doc). loggedSlotLocked's callers
// (canAutoMutateUnit, preserveLoggedSlots, canApplyTodayRebalanceUnit) all run during plain
// plan generation/refresh — including autoBalancePlan's enumerateSwapUnits() walk over every
// (day, slot) of a freshly generated week, and computeShoppingList's read-only path — so
// going through slotLogStatus here would leave a stray empty day record behind on every one
// of those, silently growing logHistory (and its sync payload) with no logged data behind
// it. A date with no logHistory record has nothing logged BY DEFINITION, so
// slotLoggedReadOnly's "check logHistory[dateISO] first" is exactly equivalent and
// side-effect-free.
function loggedSlotLocked(dateISO, person, slot){
  return typeof slotLoggedReadOnly === 'function' && slotLoggedReadOnly(dateISO, person, slot);
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
        newPlan.days[d].meals[slot] = deepClone(oldMeal);
        return;
      }
      // Both solo + both locked: whole-cell replace carries cell-level fields the
      // per-person path below doesn't, so prefer it — but only when BOTH sides are
      // still valid. If just one side is dangling (its recipe got tombstoned while the
      // other person's logged meal is still fine), don't drop the whole cell for that;
      // fall through to the per-person restore so the valid person keeps their log.
      if(lockE && lockA && mealRecipesValid(oldMeal)){
        newPlan.days[d].meals[slot] = deepClone(oldMeal);
        return;
      }
      if(lockE && oldMeal.elena && planEntryRecipeValid(oldMeal.elena)) newMeal.elena = deepClone(oldMeal.elena);
      if(lockA && oldMeal.partner && planEntryRecipeValid(oldMeal.partner)) newMeal.partner = deepClone(oldMeal.partner);
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

/* ---------------- per-meal share override ("eat different / eat together") ----------------
   Whether a specific (day, slot) is cooked as one shared dish or two separate ones. Defaults
   to the household SHARED[slot] setting, but a per-cell override in mealShareOverrides
   ('solo' | 'shared') wins — set only when a cell differs from the default, so the map stays
   small and clears back to nothing when a cell returns to the household default. generateWeek
   reads effectiveMealShared, so a split/merge survives regeneration exactly like a pin does. */
function mealShareOverrideKey(weekStartDate, dayIndex, slot){
  return [weekStartDate, dayIndex, slot].join('|');
}
function effectiveMealShared(weekStartDate, dayIndex, slot){
  const o = mealShareOverrides[mealShareOverrideKey(weekStartDate, dayIndex, slot)];
  if(o === 'solo') return false;
  if(o === 'shared') return true;
  return !!SHARED[slot];
}
// Record wantShared for a cell — but only when it DIFFERS from the household default; if it
// matches the default, drop any override so the cell just tracks the household setting again.
function setMealShareOverride(weekStartDate, dayIndex, slot, wantShared){
  const key = mealShareOverrideKey(weekStartDate, dayIndex, slot);
  if(!!wantShared === !!SHARED[slot]) delete mealShareOverrides[key];
  else mealShareOverrides[key] = wantShared ? 'shared' : 'solo';
}

// Live-convert a plan cell to two separate dishes ("eat different tonight"). A shared cell
// already holds independent per-person entries (same recipe, each at their own portion), so
// splitting is just un-linking them — both keep tonight's dish and can now be swapped
// separately (Decision: "keep the shared dish for both, then swap"). Also records the
// per-cell override so a later regeneration keeps this cell solo.
function splitMealCell(plan, dayIndex, slot){
  const m = plan && plan.days[dayIndex] && plan.days[dayIndex].meals[slot];
  if(!m || !m.shared) return false;
  m.shared = false;
  setMealShareOverride(plan.weekStartDate, dayIndex, slot, false);
  return true;
}
// Live-convert a solo cell back to one shared dish ("eat together"). Both people take
// `viewerPerson`'s current dish (the one who chose to eat together), each re-portioned to
// keep their own current calorie level — so nobody's target lurches and there's no surprise
// new meal. Records the override so regeneration keeps this cell shared.
function mergeMealCell(plan, dayIndex, slot, viewerPerson){
  const m = plan && plan.days[dayIndex] && plan.days[dayIndex].meals[slot];
  if(!m || m.shared) return false;
  const src = m[viewerPerson];
  if(!src || !src.recipeId) return false;
  const base = dbBaseNutrition(src.recipeId);
  ['elena', 'partner'].forEach(function(p){
    const curKcal = planEntryNutrition(m[p]).kcal;
    const bp = bestPortion(base.kcal, curKcal, PERSON_ANCHOR[p], SLOT_MAX_PORTION[slot]);
    m[p] = makePlanEntry(src.recipeId, bp.portion, undefined, src.opts);
  });
  m.shared = true;
  m.recipeId = src.recipeId;
  setMealShareOverride(plan.weekStartDate, dayIndex, slot, true);
  return true;
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
        newPlan.days[d].meals[slot] = deepClone(oldMeal);
        return;
      }
      // Both solo + both pinned: whole-cell replace carries cell-level fields the
      // per-person path below doesn't, so prefer it — but only when BOTH sides are
      // still valid. If just one side is dangling (its recipe got tombstoned while the
      // other person's pinned meal is still fine), don't drop the whole cell for that;
      // fall through to the per-person restore so the valid person keeps their pin.
      if(pinE && pinA && mealRecipesValid(oldMeal)){
        newPlan.days[d].meals[slot] = deepClone(oldMeal);
        return;
      }
      if(pinE && oldMeal.elena && planEntryRecipeValid(oldMeal.elena)) newMeal.elena = deepClone(oldMeal.elena);
      if(pinA && oldMeal.partner && planEntryRecipeValid(oldMeal.partner)) newMeal.partner = deepClone(oldMeal.partner);
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

// Forced one-time regeneration for `monday`, on demand (a user action), rebuilding the plan
// from the CURRENT catalog and rules. It applies the SAME preservation an automatic
// (signature-triggered) regen does in ensureWeekPlan's freshen(): pinned meals
// (preservePinnedSlots) and anything already logged or skipped (preserveLoggedSlots) survive
// untouched — only the free, unpinned, un-eaten slots are rebuilt. This is how a catalog
// change (new slot rules, the lunch/dinner nudge, a removed recipe) gets pulled into an
// existing plan without a profile/target change to invalidate its signature. Deterministic
// (same seed), so it produces the same result each time. Does NOT persist or render — the
// caller does that, exactly like applyRebalance.
function regenerateWeekPreservingLocks(monday){
  const sig = computePlanSignature();
  const prev = weekPlans[monday] ? deepClone(weekPlans[monday]) : null;
  const plan = generateWeek({weekStartDate: monday, signature: sig});
  applyMealRulesToPlan(plan);
  preserveLoggedSlots(prev, plan);
  preservePinnedSlots(prev, plan);
  markWeekPlanEdited(plan);
  weekPlans[monday] = plan;
  refreshPlanNutrition(plan);
  return plan;
}

function applyMealRulesToPlan(plan){
  if(!plan || !Array.isArray(plan.days) || !mealRules.length) return false;
  let changed = false;
  // Task B3 (solo households): a mealRule targeting 'partner' can still be sitting in
  // storage (created before switching to solo, or synced from a two-person device) — apply
  // it to elena's units only, never partner's, or it would write a real recipe into the
  // (intentionally empty) partner cell every time the plan regenerates. Two-person
  // households: soloHousehold is always false, so this is byte-identical to before.
  const soloHousehold = isSoloHousehold();
  plan.days.forEach(function(day, dayIndex){
    SLOT_ORDER.forEach(function(slot){
      const meal = day.meals[slot];
      const units = meal.shared ? ['shared'] : (soloHousehold ? ['elena'] : ['elena', 'partner']);
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
//
// VARIETY-plan.md P1: on top of that per-slot gap rule, a candidate already placed
// EARLIER TODAY for this person (any slot, main dish or composed extra —
// history[person].dayUseRecipe[dayIndex], see recordDayUsage) is excluded too — this is
// what stops e.g. the same main landing at both lunch and dinner, or a side reused as the
// snack, none of which the old per-slot-only gap rule above could ever catch (lastUsedGap
// only looks at history[person][slot], so a same-day pick in a DIFFERENT slot always
// reads as gap=Infinity, i.e. maximally "fresh"). Applied AFTER the gap filter/relax
// above, with its own never-empty fallback to that gap-filtered result — so on a thin
// pool (e.g. only one legal candidate for this slot) the day-wide rule relaxes rather
// than ever handing back zero candidates.
// `dayUsePersons` (VARIETY-plan.md P1) — whose day-wide log to honour. Defaults to just
// `person`, which is right for a solo pick. A SHARED slot must pass BOTH people: the
// per-slot gap history is written in sync for shared slots (so Elena's stands for both
// there), but the day-wide log is NOT, because the solo slots earlier the same day can give
// each person a different main and a different side. Filtering a shared snack against
// Elena's day alone let it collide with the side Andrea had already eaten at lunch — the
// real failure this parameter fixes.
function applyVarietyFilter(pool, history, person, slot, dayIndex, dayUsePersons){
  // The day-wide exclusion runs FIRST, against the full pool — not afterwards against the
  // gap-filtered result. Ordering it second (the first version of this fix) left it
  // powerless exactly where it was needed: the snack pool is 4 candidates, two of which
  // double as sides, so the gap rule would narrow it to a set that was entirely used today,
  // the day rule would find nothing left, and its fallback handed back that same set —
  // reinstating the repeat. A same-day repeat is far more visible than a 3-day-gap
  // violation, so day-wide dominates and only relaxes when it would leave literally nothing.
  const usedToday = {};
  (dayUsePersons && dayUsePersons.length ? dayUsePersons : [person]).forEach(function(p){
    (history[p].dayUseRecipe[dayIndex] || []).forEach(function(id){ usedToday[id] = true; });
  });
  const persons = (dayUsePersons && dayUsePersons.length ? dayUsePersons : [person]);
  const proteinBase = applyLunchDinnerMainRules(pool, history, persons, slot);

  const notUsedToday = proteinBase.filter(function(id){ return !usedToday[id]; });
  const dayBase = notUsedToday.length ? notUsedToday : proteinBase;

  // VARIETY-plan.md P2: the weekly cap sits between the day rule and the gap rule — a
  // same-day repeat is the most visible failure, an over-quota week the next, and the
  // 3-day gap the softest of the three. Each stage relaxes to the previous stage's result
  // rather than to the raw pool, so relaxing one constraint never silently discards one
  // that was already satisfied.
  const base = applyWeeklyCapFilter(dayBase, history, persons);

  const gaps = {};
  base.forEach(function(id){ gaps[id] = lastUsedGap(history, person, slot, dayIndex, id); });
  const fresh = base.filter(function(id){
    return gaps[id] > 3 && (slot !== 'dinner' || gaps[id] === Infinity);
  });
  if(fresh.length) return fresh;
  let maxGap = -1;
  base.forEach(function(id){ if(gaps[id] > maxGap) maxGap = gaps[id]; });
  return base.filter(function(id){ return gaps[id] === maxGap; });
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

/* ---------------- FAVORITES-EATENOUT-plan.md item 2: favorite score boost ----------------
   FAVORITE_SCORE_BOOST=90 replaces the old flat +35, which measured (before this change)
   as barely moving a favorite's weekly usage (1->2, 2->2 for three test favorites) — the
   boost was swamped by kcalErr*1000, and the (then-flat) weekly cap ceilinged a favorite at
   the same 2 as everything else. This is an EMPIRICAL choice, found the same way
   TUNING_WEIGHT was (see that doc block below): a throwaway vm-harness script (mirroring
   tools/check.js's loader), NOT checked in, generated a fresh FIXED_MONDAY (2026-07-13)
   week for the default household, favorited ONE real, in-season, avoid-list-clean recipe
   at a time, and counted its weekly usage against the (already-raised, see
   weeklyCapForRecipe above) cap, for boost candidates 35/50/60/70/75/80/90/105/120/150/200:

     recipe (role, 1x kcal)                          | baseline | b=35 | b=60 | b=80 | b=90 | b=200
     chicken-couscous-salad (full, 553kcal)           |   0/3    | 0/3  | 2/3  | 2/3  | 2/3  | 2/3
     lemon-herb-chicken-breast (main/poultry, 358kcal)|   1/3    | 2/3  | 2/3  | 2/3  | 2/3  | 2/3
     seared-tuna-lemon (main/fish, 298kcal)           |   1/3    | 3/3  | 3/3  | 3/3  | 3/3  | 3/3
     carrots-over-hummus (side, base cap 3)           |   1/4    | 1/4  | 1/4  | 3/4  | 3/4  | 3/4

   Two of the four already responded at the OLD 35 (poultry/fish mains — their kcal-fit
   competition was thin enough that even 35 flips them); the other two needed more:
   chicken-couscous-salad plateaus at boost>=60, carrots-over-hummus only moves once
   boost>=80. Every recipe's usage plateaus by 90 and does not climb further even at
   200 — the remaining gap to the raised cap (e.g. carrots-over-hummus never quite reaches
   4/4) is P1's day-wide no-repeat rule and the side pool's own ladder relaxation order,
   not an under-sized boost, so pushing the constant past the point where these four
   plateau buys nothing. 90 is the smallest of the plan's suggested sweep points (35, 60,
   90, 120, 200) at or above every one of those plateaus, so it was chosen over 80 for
   margin against recipes this small sample didn't cover.

   90 sits clearly BELOW kcalErr's scale (kcalErr*1000 typically separates real candidates
   by tens of points and reaches ~1000 for a wildly-off pick, per the tuningBonus doc
   below) — a favorite still can't out-argue a genuinely much-better kcal fit — while
   sitting comfortably ABOVE the old 35, tuningBonus's 15-point cap, and the 0-0.5
   rotation tie-break, so a favorite reliably wins realistic ties the old boost didn't.
   Confirmed with a many-favorites run (4 recipes favorited at once, boost 35/90/200): the
   household's fortnight still used 24-26 DISTINCT recipes and favorited recipes never
   exceeded ~22% of that week's component-slots (9 of 41 at boost=200) — P1's day-wide rule
   and the still-finite raised cap keep a many-favorites week from collapsing to just those
   recipes. Confirmed via `node tools/check.js` that this choice does not break the
   'protein'/'fiber' fortnight tuning tests (testNextWeekTuning) — those stay the guardrail
   that the boost hasn't started distorting the calorie/protein targets. See
   tools/check.js testFavorites for the pinned assertions. */
const FAVORITE_SCORE_BOOST = 90;

// Weighted so priority (c) kcal-fit > (d) protein-fit; variety (e) is the hard filter
// above. The tiny rotation term only breaks ties that survive both (deterministic — a
// stable hash of day/slot/recipe id folded with a stable hash of the WEEK's Monday, no
// randomness). weekSeed shifts those tie-breaks between weeks; it is a SECONDARY
// mechanism only — the primary cross-week variety is applyCrossWeekFilter() above (a
// score-sized nudge can't outvote the kcal term; a hard filter doesn't have to).
// Soft Mediterranean-rhythm nudge (2026-07-22): lunch leans carb-forward (the bigger,
// energy-for-the-day midday meal — salad/pasta/grain/legume), dinner leans protein-forward
// (lighter, more satiating before sleep). DELIBERATELY small: the signal is the recipe's
// own carb-vs-protein kcal balance (portion-invariant, so it's about the DISH not the
// serving), scaled by a weight kept well under the kcal-fit (~1000) and protein-fit (~100)
// terms and under prefBoost (90) — so calorie/protein targets, personal favorites, and the
// variety rules all still win when they conflict; this only tips otherwise-close choices.
// Applies to lunch/dinner only (breakfast/snack return 0).
const LUNCH_DINNER_COMPOSITION_WEIGHT = 14;
function slotCompositionBias(recipeId, slotIndex){
  const slot = SLOT_ORDER[slotIndex];
  if(slot !== 'lunch' && slot !== 'dinner') return 0;
  const b = dbBaseNutrition(recipeId);
  if(!(b.kcal > 0)) return 0;
  const carbShare = (b.carbs * 4) / b.kcal;       // 0..1 of kcal from carbs
  const proteinShare = (b.protein * 4) / b.kcal;  // 0..1 of kcal from protein
  const signal = slot === 'lunch' ? (carbShare - proteinShare) : (proteinShare - carbShare);
  return LUNCH_DINNER_COMPOSITION_WEIGHT * signal;
}

function mealScore(actualKcal, desiredKcal, actualProtein, desiredProtein, dayIndex, slotIndex, recipeId, weekSeed, person){
  const kcalErr = Math.abs(actualKcal - desiredKcal) / Math.max(Math.abs(desiredKcal), 1);
  const proteinShort = desiredProtein > 0 ? Math.max(0, desiredProtein - actualProtein) / desiredProtein : 0;
  const rotation = ((dayIndex * 7 + slotIndex + stableHash(recipeId) + (weekSeed || 0)) % 97) / 97;
  // PERSONAL-PREFS: called once per person for a shared slot (pickSharedMeal), so a shared
  // dish is boosted if EITHER person favorited it — elena's call boosts on elena's own
  // favorite, partner's call on partner's, and the two scores are summed by the caller.
  const prefBoost = recipePref(recipeId, person) === 'favorite' ? FAVORITE_SCORE_BOOST : 0;
  return -(kcalErr * 1000) - (proteinShort * 100) + prefBoost + slotCompositionBias(recipeId, slotIndex) + rotation * 0.5;
}

/* ---------------- task C2 (2026-07-18): next-week tuning bonus ----------------
   tuningBonus(totals, tuningKey) is a small deterministic secondary term ADDED to
   mealScore's result (both pickSharedMeal and pickSoloMeal, below) for the candidate
   whose kcal/protein already went into that mealScore call. Magnitude analysis, read off
   mealScore() above: a candidate's kcal-fit term (kcalErr*1000) typically separates real
   candidates by tens of points whenever their portion search lands at meaningfully
   different kcal residuals, and can reach ~1000 for a wildly-off pick; the protein-fit
   term (proteinShort*100) is 0-100; prefBoost is a flat FAVORITE_SCORE_BOOST (90, see that
   constant's own doc above — raised from the original 35 by FAVORITES-EATENOUT-plan.md
   item 2); the existing rotation tie-break is the smallest term in the system at 0-0.5.
   tuningBonus must sit clearly ABOVE rotation (or it would never survive being a real
   secondary signal) but clearly BELOW kcal/protein-fit (or it would distort the targets
   the old banner promised to keep — "same calories and protein"). 'none' returns exactly
   0 regardless of weight — no
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
   still a fraction of kcalErr's scale and well under FAVORITE_SCORE_BOOST (90, raised from
   35 by FAVORITES-EATENOUT-plan.md item 2 — 15 was already under half of the OLD 35 too),
   so a favorited recipe or a genuinely-better kcal fit still wins — it just needed to be
   bigger than 4 to reliably beat the existing proteinShort/kcalErr terms' OWN budget-driven
   noise floor on this dataset. See tools/check.js testNextWeekTuning for the pinned
   assertions. */
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
  return {kcal: base.kcal * portion, protein: base.protein * portion, fiber: base.fiber * portion, freeSugars: base.freeSugars * portion, fat: base.fat * portion, satFat: base.satFat * portion};
}
function addNutrientTotals(a, b){
  return {kcal: a.kcal + b.kcal, protein: a.protein + b.protein, fiber: a.fiber + b.fiber, freeSugars: a.freeSugars + b.freeSugars, fat: a.fat + b.fat, satFat: a.satFat + b.satFat};
}
function withOmega3(totals, flag){ totals.hasOmega3 = flag; return totals; }

function tuningBonus(totals, tuningKey){
  if(!totals || tuningKey === 'none') return 0;
  if(tuningKey === 'protein') return TUNING_WEIGHT * (totals.protein / TUNING_PROTEIN_NORM);
  if(tuningKey === 'fiber') return TUNING_WEIGHT * (totals.fiber / TUNING_FIBER_NORM);
  if(tuningKey === 'lowSugar') return -TUNING_WEIGHT * (totals.freeSugars / TUNING_SUGAR_NORM);
  if(tuningKey === 'lowSatFat') return -TUNING_WEIGHT * (totals.kcal > 0 ? totals.satFat * 9 / totals.kcal : 0);
  if(tuningKey === 'omega3') return totals.hasOmega3 ? TUNING_WEIGHT : 0;
  return 0; // unknown key (shouldn't happen — state.js validates on load/sync) behaves like 'none'
}

/* ---------------- per-person goal tuning (goal audit, KNOWLEDGE-BASE.md §3) ----------------
   `muscle`/`heart`/`skin` (PROF[person].goals — state.js:GOAL_DEFS_UNION) used to change
   only the goalTag chip and "why this fits you" copy — zero effect on which meals the
   planner actually picks. This wires each one to the SAME tuningBonus() formula
   nextWeekTuning already uses, so the magnitude is proven-in-range (TUNING_WEIGHT/NORM
   constants above, empirically tuned per the comment on tuningBonus) rather than a new
   invented threshold.

   Could a HOUSEHOLD-level term (nextWeekTuning is one shared `let`) express a per-person
   goal instead of adding a second mechanism? No — nextWeekTuning is a single value read
   identically for both scoreE and scoreA below, so it can only ever say "the household
   wants more protein this week," never "Elena wants more protein but Andrea doesn't."
   What DOES already exist per-person is the CALL SITE: pickSharedMeal computes scoreE and
   scoreA separately (each fed that person's own totalsE/totalsA), and pickSoloMeal computes
   one score per person outright. tuningBonus(totals, key) is already invoked once per
   person, just with the same household key both times. Reusing that per-person seam — pass
   a key derived from PROF[person].goals instead of the shared nextWeekTuning — needed no
   new plumbing through generateWeek()/mealScore, only a second call added next to the
   existing tuningBonus() call at each of the three score sites below.

   Per-person goal on a SHARED dish: a dinner both people eat is one recipe choice, but each
   person's own goal bonus is computed from THEIR OWN totalsE/totalsA (already portion-scaled
   per person) and added to only THEIR half of the score before scoreE+scoreA picks the
   winning dish — so Elena's heart goal nudges the shared dinner pick toward more fiber, but
   only by pulling on the shared decision through her own preference, exactly the way
   FAVORITE_SCORE_BOOST/mealScore's per-person rotation term already pulls one shared choice
   toward what suits one person specifically. It can never force a solo split for a goal alone
   (SHARED[slot] / mealShareOverrides still own that), and it can never move a candidate that
   doesn't already meet BOTH people's calorie/protein targets — tuningBonus-family terms are
   pure tie-break-scale nudges among the mealScore-feasible set, same class of change as
   nextWeekTuning, so they cannot "silently fight" the user's own split (kP/kC/kF) or
   calorie target the way editing SPLIT_BOUNDS/targetP directly would.

   Mapping chosen from what tuningBonus can already express, matched to each goal's
   GOAL_DEFS_UNION description (state.js): muscle -> protein-forward picks; heart -> more
   fiber + less saturated fat; skin -> more omega-3 + less free sugar. There is no lowGI or
   sodium tuningBonus key (no such food data — see foods.js's header / KNOWLEDGE-BASE.md §5),
   so skin/heart's copy was reworded to match exactly this, not the other way around. */
const GOAL_TUNING_KEYS = {muscle: ['protein'], heart: ['fiber', 'lowSatFat']};
function goalTuningBonus(totals, person){
  if(!totals) return 0;
  const goals = PROF[person] && PROF[person].goals;
  if(!goals) return 0;
  let bonus = 0;
  Object.keys(GOAL_TUNING_KEYS).forEach(function(goalKey){
    if(!goals[goalKey]) return;
    GOAL_TUNING_KEYS[goalKey].forEach(function(tuningKey){ bonus += tuningBonus(totals, tuningKey); });
  });
  return bonus;
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
  // Task B3 (solo households): computed once per generation, read by the per-slot loop
  // below. Two-person households: always false, so every branch it guards is untouched.
  const soloHousehold = isSoloHousehold();
  const dayTarget = {
    elena: {kcal: PROF.elena.calGoalNum, protein: PROF.elena.targetP},
    partner: {kcal: PROF.partner.calGoalNum, protein: PROF.partner.targetP}
  };
  const avoidList = {
    elena: (PROF.elena.avoid || []).slice(),
    partner: (PROF.partner.avoid || []).slice()
  };

  weeklyCapRelaxations = 0; mainRepeatRelaxations = 0; meatRuleRelaxations = 0; emptyPoolPicks = 0;
  const history = {elena: {}, partner: {}};
  SLOT_ORDER.forEach(function(s){ history.elena[s] = []; history.partner[s] = []; });
  // task B2: parallel "what composed side/breakfast-pair id did this person use on day N"
  // logs, keyed by dayIndex (sparse), for the light consecutive-day variety rule — separate
  // from the main-recipe history arrays above, which main/full ids still join unchanged.
  history.elena.sideUse = {}; history.partner.sideUse = {};
  history.elena.bfPairUse = {}; history.partner.bfPairUse = {};
  // VARIETY-plan.md P1: day-wide usage logs, keyed by dayIndex (sparse) — EVERY recipe/food
  // id placed for this person that day (main dish + every composed extra), split by id
  // space (recordDayUsage doc above explains the recipe/food split). Read by
  // applyVarietyFilter (recipe pools) and applyLightConsecutiveFilter's call sites below
  // (recipe pools for sides, food pools for breakfast pairs).
  history.elena.dayUseRecipe = {}; history.partner.dayUseRecipe = {};
  history.elena.dayUseFood = {}; history.partner.dayUseFood = {};
  // VARIETY-plan.md P2: per-person WEEK totals per recipe id (main dish + every composed
  // extra), read by applyWeeklyCapFilter. Not keyed by day — this is the whole-week count.
  history.elena.weekUse = {}; history.partner.weekUse = {};
  // Per-person tracking for the lunch/dinner main-course rules only.
  history.elena.lunchDinnerMainUse = {}; history.partner.lunchDinnerMainUse = {};
  history.elena.meatUse = {red: 0, poultry: 0, total: 0};
  history.partner.meatUse = {red: 0, poultry: 0, total: 0};

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
      // Per-cell share override (2026-07-22): a specific day's meal can be split/merged
      // against the household SHARED[slot] default and that choice persists through
      // regeneration (mealShareOverrides), so this reads the EFFECTIVE state, not the raw
      // household toggle.
      const shared = !soloHousehold && effectiveMealShared(weekStartDate, d, slot);
      if(soloHousehold){
        // Task B3 (solo households): plan/keep ONLY elena's portion — reuses the exact same
        // pickSoloMeal() call the two-person "else" branch below already makes for elena's
        // half of a non-shared slot (same pools/avoid-list/history/scoring), so a one-person
        // household's picks are computed by the identical, already-battle-tested code path,
        // just never paired with a second pick for 'partner'. The partner cell is the
        // intentionally empty placeholder (emptyPlanEntry(), NOT ghost-planned) — no pool
        // lookup, no history recording, no target deduction happens for 'partner' at all.
        const poolE = candidatesFor(slot, styleKey, avoidList.elena, ['elena']);
        const chE = pickSoloMeal(poolE.length ? poolE : candidatesFor(slot, styleKey, [], ['elena'], {includeThumbsDown: true}), 'elena', slot, d, si, remainingKcal.elena, remainingProtein.elena, remainingWeight, history, weekSeed, prevRecipeId(d, slot, 'elena'));
        dayMeals[slot] = {shared: false, elena: chE, partner: emptyPlanEntry()};
        const soloNutE = planEntryNutrition(chE);
        remainingKcal.elena -= soloNutE.kcal;
        remainingProtein.elena -= soloNutE.protein;
        history.elena[slot][d] = chE.recipeId;
        recordCompositionUsage(history, chE, 'elena', slot, d);
        recordDayUsage(history, chE, 'elena', d, slot);
      } else if(shared){
        const avoidBoth = unionAvoid(avoidList.elena, avoidList.partner);
        const pool = candidatesFor(slot, styleKey, avoidBoth, ['elena', 'partner']);
        // For shared slots both people ate the same dish last week — Elena's entry stands
        // for both (same convention as the variety filter's history handling).
        const chosen = pickSharedMeal(pool.length ? pool : candidatesFor(slot, styleKey, avoidBoth, ['elena', 'partner'], {includeThumbsDown: true}), slot, d, si, remainingKcal, remainingProtein, remainingWeight, history, weekSeed, prevRecipeId(d, slot, 'elena'));
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
        // VARIETY-plan.md P1: a shared dish records into BOTH people's day-wide log — one
        // dish, both ate it (chosen.elena/chosen.partner carry the same recipeId/extra ids,
        // just per-person portions/grams, so this naturally covers both).
        recordDayUsage(history, chosen.elena, 'elena', d, slot);
        recordDayUsage(history, chosen.partner, 'partner', d, slot);
      } else {
        const poolE = candidatesFor(slot, styleKey, avoidList.elena, ['elena']);
        const poolA = candidatesFor(slot, styleKey, avoidList.partner, ['partner']);
        const chE = pickSoloMeal(poolE.length ? poolE : candidatesFor(slot, styleKey, [], ['elena'], {includeThumbsDown: true}), 'elena', slot, d, si, remainingKcal.elena, remainingProtein.elena, remainingWeight, history, weekSeed, prevRecipeId(d, slot, 'elena'));
        const chA = pickSoloMeal(poolA.length ? poolA : candidatesFor(slot, styleKey, [], ['partner'], {includeThumbsDown: true}), 'partner', slot, d, si, remainingKcal.partner, remainingProtein.partner, remainingWeight, history, weekSeed, prevRecipeId(d, slot, 'partner'));
        dayMeals[slot] = {shared: false, elena: chE, partner: chA};
        const soloNutE = planEntryNutrition(chE), soloNutA = planEntryNutrition(chA);
        remainingKcal.elena -= soloNutE.kcal; remainingKcal.partner -= soloNutA.kcal;
        remainingProtein.elena -= soloNutE.protein; remainingProtein.partner -= soloNutA.protein;
        history.elena[slot][d] = chE.recipeId; history.partner[slot][d] = chA.recipeId;
        recordCompositionUsage(history, chE, 'elena', slot, d);
        recordCompositionUsage(history, chA, 'partner', slot, d);
        recordDayUsage(history, chE, 'elena', d, slot);
        recordDayUsage(history, chA, 'partner', d, slot);
      }
      remainingWeight -= w;
    });
    days.push({date: addDaysISO(weekStartDate, d), meals: dayMeals});
  }
  // VARIETY-plan.md P2: one summary per generation, not one per pick. A non-zero count means
  // some pool could not fill a slot within its weekly quota and the cap was relaxed — the
  // plan is still complete and deterministic, but that pool is too thin and is exactly what
  // P3 should widen. Silent truncation would be indistinguishable from the cap not working.
  if(weeklyCapRelaxations > 0 || mainRepeatRelaxations > 0 || meatRuleRelaxations > 0){
    console.warn('Mesa planner: generating ' + weekStartDate + ' relaxed the weekly recipe cap ' +
      weeklyCapRelaxations + 'x, the lunch/dinner main-repeat rule ' + mainRepeatRelaxations +
      'x, and the meat-balance rule ' + meatRuleRelaxations +
      'x — a candidate pool is too thin to fill every slot within target.');
  }
  // Empty-pool guard (task 5): a non-zero count means at least one slot had NO legal
  // candidate at all (typically an exotic diet/avoid combination in a thin season) —
  // exposed on the plan itself so callers/tests can detect a degraded plan without
  // re-scanning every day/slot for reason:'no-candidates' cells.
  if(emptyPoolPicks > 0){
    console.warn('Mesa planner: generating ' + weekStartDate + ' left ' + emptyPoolPicks +
      ' slot(s) with NO candidate at all — likely diet/avoid filters too strict for this catalog/season.');
  }
  const plan = {v: 1, weekStartDate: weekStartDate, signature: signature, days: days, emptyPoolCount: emptyPoolPicks};
  // Post-generation balancing pass (see autoBalancePlan's doc, below) — deterministic and
  // bounded, so this stays a pure function of the same inputs generateWeek already is.
  autoBalancePlan(plan);
  return plan;
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
function pushComposedSideCandidates(push, mainId, mainBase, desired, anchor, maxPortion, carbIds, vegIds){
  carbIds.forEach(function(carbId){ vegIds.forEach(function(vegId){
    if(carbId === vegId) return;
    const carbBase = dbBaseNutrition(carbId), vegBase = dbBaseNutrition(vegId);
    [0.5, 1].forEach(function(carbPortion){ [0.5, 1].forEach(function(vegPortion){
      const extrasKcal = carbBase.kcal * carbPortion + vegBase.kcal * vegPortion;
      const extrasProtein = carbBase.protein * carbPortion + vegBase.protein * vegPortion;
      const bp = bestPortion(mainBase.kcal, desired - extrasKcal, anchor, maxPortion);
      push(mainId + '|carb|' + carbId + '@' + carbPortion + '|veg|' + vegId + '@' + vegPortion,
        bp.kcal + extrasKcal, mainBase.protein * bp.portion + extrasProtein,
        [{recipeId: carbId, portion: carbPortion}, {recipeId: vegId, portion: vegPortion}], bp.portion);
    }); });
  }); });
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
  // Shared slot: gap history via Elena (written in sync for both), but the day-wide
  // exclusion must honour BOTH people — see applyVarietyFilter's doc.
  pool = applyVarietyFilter(pool, history, 'elena', slot, dayIndex, ['elena', 'partner']);
  const maxPortion = SLOT_MAX_PORTION[slot];
  // task D1: hoisted above the slot branches below (breakfast/lunch/dinner already
  // computed this further down for the composed-pair pools) so the final opts-rotation
  // step after `best` is picked can use it regardless of slot, snack included.
  const avoidBoth = unionAvoid(PROF.elena.avoid || [], PROF.partner.avoid || []);
  // task (variant-fit planner): same reasoning as avoidBoth above — hoisted so every
  // combos lookup below (snack included) shares one computation.
  const dietBoth = unionDiets(['elena', 'partner']);

  // candidates: {tieId, mainId, extra: null|{recipeId,portion}|{foodId,grams}, opts,
  //              portionE, portionA, kcalE, kcalA, proteinE, proteinA,
  //              totalsE, totalsA (task C2, 2026-07-18: per-person combined-unit nutrition
  //              fed to tuningBonus() below — {protein,fiber,freeSugars,fat,satFat,hasOmega3})}
  // task (variant-fit planner): `opts` is the combo THIS candidate was scored with
  // (recipeNutrition(id, 1, opts), never always the default) — carried through so the
  // eventual winner's opts is exactly the combo whose numbers won, not a rotation re-roll
  // after the fact (see viableRecipeOptionCombos/optsComboSignature above).
  const candidates = [];
  function pushFull(id, base, bpE, bpA, opts){
    const hasO3 = recipeHasOmega3(id);
    const sig = optsComboSignature(opts);
    candidates.push({tieId: id + (sig ? '|opts:' + sig : ''), mainId: id, extra: null, opts: opts,
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
      // task (variant-fit planner): one candidate per viable combo — [{}] for a recipe
      // without optionGroups, so this loop still runs exactly once per id there, byte-
      // identical to before.
      viableRecipeOptionCombos(id, avoidBoth, dietBoth).forEach(function(opts){
        const base = recipeNutrition(id, 1, opts).totals;
        const bpE = bestPortion(base.kcal, desiredE, PERSON_ANCHOR.elena, maxPortion);
        const bpA = bestPortion(base.kcal, desiredA, PERSON_ANCHOR.partner, maxPortion);
        pushFull(id, base, bpE, bpA, opts);
      });
    });
  } else {
    const fullIds = pool.filter(function(id){ return RECIPES_DB[id].role === 'full' && (slot !== 'lunch' && slot !== 'dinner' || isCompleteLunchDinnerRecipe(id)); });
    const mainIds = pool.filter(function(id){ return RECIPES_DB[id].role === 'main' && (slot !== 'lunch' && slot !== 'dinner' || isProteinMain(id)); });
    fullIds.forEach(function(id){
      viableRecipeOptionCombos(id, avoidBoth, dietBoth).forEach(function(opts){
        const base = recipeNutrition(id, 1, opts).totals;
        const bpE = bestPortion(base.kcal, desiredE, PERSON_ANCHOR.elena, maxPortion);
        const bpA = bestPortion(base.kcal, desiredA, PERSON_ANCHOR.partner, maxPortion);
        pushFull(id, base, bpE, bpA, opts);
      });
    });

    if(slot === 'breakfast'){
      const foodPoolRaw = breakfastPairFoodIds(avoidBoth);
      const foodPool = applyLightConsecutiveFilter(foodPoolRaw, [history.elena.bfPairUse[dayIndex - 1], history.partner.bfPairUse[dayIndex - 1]], [history.elena.dayUseFood[dayIndex], history.partner.dayUseFood[dayIndex]]);
      mainIds.forEach(function(id){
        viableRecipeOptionCombos(id, avoidBoth, dietBoth).forEach(function(opts){
          const base = recipeNutrition(id, 1, opts).totals;
          const sig = optsComboSignature(opts);
          const bpE = bestPortion(base.kcal, desiredE, PERSON_ANCHOR.elena, maxPortion);
          const bpA = bestPortion(base.kcal, desiredA, PERSON_ANCHOR.partner, maxPortion);
          pushFull(id, base, bpE, bpA, opts); // standalone role:'main' breakfast remains legal
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
              tieId: (sig ? tieId + '|opts:' + sig : tieId), mainId: id, extra: {foodId: extraE.foodId, gramsE: extraE.grams, gramsA: bestStepA.grams}, opts: opts,
              portionE: bpE.portion, portionA: bpA.portion,
              kcalE: kcalE, kcalA: bpA.kcal + bestStepA.kcal,
              proteinE: proteinE, proteinA: base.protein * bpA.portion + bestStepA.protein,
              totalsE: withOmega3(addNutrientTotals(scaleNutrientTotals(base, bpE.portion), foodMacrosE), hasO3),
              totalsA: withOmega3(addNutrientTotals(scaleNutrientTotals(base, bpA.portion), foodMacrosA), hasO3)
            });
          }, id, base, bpE, desiredE, foodPool);
        });
      });
    } else if(slot === 'lunch' || slot === 'dinner'){
      const sidePoolRaw = sidePoolFor(avoidBoth, ['elena', 'partner']);
      // VARIETY-plan.md P1+P2 for sides, as one priority ladder (sidePoolLadder's doc
      // explains why nesting the rules ranked them wrong). Shared slot -> both people.
      const sidePool = sidePoolLadder(sidePoolRaw, history, ['elena', 'partner'], dayIndex);
      const carbPool = sidePool.filter(isCarbSide), vegPool = sidePool.filter(isVegSide);
      if(carbPool.length && vegPool.length){
        mainIds.forEach(function(mainId){
          // task (variant-fit planner): topKSideIds is computed PER combo — a variant's
          // own kcal changes which sides fit it best (e.g. baked-fish's leaner sole vs
          // richer salmon choice wants a different-sized carb/veg pairing).
          viableRecipeOptionCombos(mainId, avoidBoth, dietBoth).forEach(function(opts){
            const mainBase = recipeNutrition(mainId, 1, opts).totals;
            const sig = optsComboSignature(opts);
            const carbIds = topKSideIds(mainBase.kcal, carbPool, desiredE / 2, SIDE_TOP_K);
            const vegIds = topKSideIds(mainBase.kcal, vegPool, desiredE / 2, SIDE_TOP_K);
            carbIds.forEach(function(carbId){ vegIds.forEach(function(vegId){
              if(carbId === vegId) return;
              const carbBase = dbBaseNutrition(carbId), vegBase = dbBaseNutrition(vegId);
              [0.5, 1].forEach(function(carbPortion){ [0.5, 1].forEach(function(vegPortion){
                const extrasKcal = carbBase.kcal * carbPortion + vegBase.kcal * vegPortion;
                const extrasProtein = carbBase.protein * carbPortion + vegBase.protein * vegPortion;
                const bpE = bestPortion(mainBase.kcal, desiredE - extrasKcal, PERSON_ANCHOR.elena, maxPortion);
                const bpA = bestPortion(mainBase.kcal, desiredA - extrasKcal, PERSON_ANCHOR.partner, maxPortion);
                const extras = [{recipeId: carbId, portion: carbPortion}, {recipeId: vegId, portion: vegPortion}];
                const extraTotals = addNutrientTotals(scaleNutrientTotals(carbBase, carbPortion), scaleNutrientTotals(vegBase, vegPortion));
                const hasO3 = recipeHasOmega3(mainId) || recipeHasOmega3(carbId) || recipeHasOmega3(vegId);
                const tieId = mainId + '|carb|' + carbId + '@' + carbPortion + '|veg|' + vegId + '@' + vegPortion + (sig ? '|opts:' + sig : '');
                candidates.push({tieId: tieId, mainId: mainId, extras: extras, opts: opts,
                  portionE: bpE.portion, portionA: bpA.portion, kcalE: bpE.kcal + extrasKcal, kcalA: bpA.kcal + extrasKcal,
                  proteinE: mainBase.protein * bpE.portion + extrasProtein, proteinA: mainBase.protein * bpA.portion + extrasProtein,
                  totalsE: withOmega3(addNutrientTotals(scaleNutrientTotals(mainBase, bpE.portion), extraTotals), hasO3), totalsA: withOmega3(addNutrientTotals(scaleNutrientTotals(mainBase, bpA.portion), extraTotals), hasO3)});
              }); });
            }); });
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
    const scoreE = mealScore(c.kcalE, desiredE, c.proteinE, desiredProtE, dayIndex, slotIndex, c.mainId, weekSeed, 'elena') + tuningBonus(c.totalsE, nextWeekTuning) + goalTuningBonus(c.totalsE, 'elena');
    const scoreA = mealScore(c.kcalA, desiredA, c.proteinA, desiredProtA, dayIndex, slotIndex, c.mainId, weekSeed, 'partner') + tuningBonus(c.totalsA, nextWeekTuning) + goalTuningBonus(c.totalsA, 'partner');
    const total = scoreE + scoreA;
    const better = !best || total > best.total + 1e-9 || (Math.abs(total - best.total) <= 1e-9 && c.tieId < best.tieId);
    if(better) best = Object.assign({total: total}, c);
  });
  if(!best){
    console.error('pickSharedMeal: empty candidate pool for slot="' + slot + '" style="' + householdStyle + '" — check RECIPES_DB coverage for this avoid-list/diet combination.');
    emptyPoolPicks++;
    // reason:'no-candidates' (empty-pool guard, distinct from the intentional
    // emptyPlanEntry() a solo household uses for its unused partner cell) lets the render
    // layer show an honest "no meal fits your filters" card instead of silently producing
    // a blank/broken-looking slot — see render-today.js's MISSING_RECIPE_FALLBACK branch
    // and render-week.js's day-meal-row for where this is read.
    return {shared: true, recipeId: null, elena: {recipeId: null, portion: 1, kcal: 0, protein: 0, reason: 'no-candidates'}, partner: {recipeId: null, portion: 1, kcal: 0, protein: 0, reason: 'no-candidates'}};
  }
  // task (variant-fit planner): the SAME variant for both people (one shared dish) — the
  // combo `best` actually WON with (every candidate above was scored under its own combo's
  // real kcal/protein via viableRecipeOptionCombos+recipeNutrition, so this is the combo
  // that best fit both people's targets, not a rotation re-roll after the fact). {} for a
  // recipe without optionGroups; makePlanEntry's own normalizeRecipeOpts no-ops on that.
  const elenaEntry = makePlanEntry(best.mainId, best.portionE, undefined, best.opts);
  const partnerEntry = makePlanEntry(best.mainId, best.portionA, undefined, best.opts);
  if(best.extras){
    elenaEntry.extras = best.extras.slice(); partnerEntry.extras = best.extras.slice();
  } else if(best.extra){
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
  // task (variant-fit planner): hoisted once, same reasoning as pickSharedMeal's dietBoth.
  const dietP = unionDiets([person]);

  // candidates: {tieId, mainId, extra: null|{recipeId,portion}|{foodId,grams}, opts,
  //              portion, kcal, protein, totals (task C2, 2026-07-18: combined-unit
  //              nutrition fed to tuningBonus() below —
  //              {protein,fiber,freeSugars,fat,satFat,hasOmega3})}
  // task (variant-fit planner): `opts` is the combo THIS candidate was scored with — see
  // pickSharedMeal's matching comment above.
  const candidates = [];
  function pushFull(id, base, bp, opts){
    const sig = optsComboSignature(opts);
    candidates.push({tieId: id + (sig ? '|opts:' + sig : ''), mainId: id, extra: null, opts: opts, portion: bp.portion, kcal: bp.kcal, protein: base.protein * bp.portion,
      totals: withOmega3(scaleNutrientTotals(base, bp.portion), recipeHasOmega3(id))});
  }

  if(slot === 'snack'){
    // Snack never composes — every id in the pool (any role) is a standalone pick.
    pool.forEach(function(id){
      // task (variant-fit planner): one candidate per viable combo — [{}] for a recipe
      // without optionGroups, byte-identical to before.
      viableRecipeOptionCombos(id, avoidP, dietP).forEach(function(opts){
        const base = recipeNutrition(id, 1, opts).totals;
        pushFull(id, base, bestPortion(base.kcal, desired, anchor, maxPortion), opts);
      });
    });
  } else {
    const fullIds = pool.filter(function(id){ return RECIPES_DB[id].role === 'full' && (slot !== 'lunch' && slot !== 'dinner' || isCompleteLunchDinnerRecipe(id)); });
    const mainIds = pool.filter(function(id){ return RECIPES_DB[id].role === 'main' && (slot !== 'lunch' && slot !== 'dinner' || isProteinMain(id)); });
    fullIds.forEach(function(id){
      viableRecipeOptionCombos(id, avoidP, dietP).forEach(function(opts){
        const base = recipeNutrition(id, 1, opts).totals;
        pushFull(id, base, bestPortion(base.kcal, desired, anchor, maxPortion), opts);
      });
    });

    if(slot === 'breakfast'){
      const foodPoolRaw = breakfastPairFoodIds(avoidP);
      const foodPool = applyLightConsecutiveFilter(foodPoolRaw, [history[person].bfPairUse[dayIndex - 1]], [history[person].dayUseFood[dayIndex]]);
      mainIds.forEach(function(id){
        viableRecipeOptionCombos(id, avoidP, dietP).forEach(function(opts){
          const base = recipeNutrition(id, 1, opts).totals;
          const sig = optsComboSignature(opts);
          const bp = bestPortion(base.kcal, desired, anchor, maxPortion);
          pushFull(id, base, bp, opts); // standalone role:'main' breakfast remains legal
          const hasO3 = recipeHasOmega3(id); // extra here is a plain FOOD, never counts toward omega3
          pushBreakfastPairCandidates(function(tieId, kcal, protein, extra){
            candidates.push({tieId: (sig ? tieId + '|opts:' + sig : tieId), mainId: id, extra: extra, opts: opts, portion: bp.portion, kcal: kcal, protein: protein,
              totals: withOmega3(addNutrientTotals(scaleNutrientTotals(base, bp.portion), foodMacros(extra.foodId, extra.grams)), hasO3)});
          }, id, base, bp, desired, foodPool);
        });
      });
    } else if(slot === 'lunch' || slot === 'dinner'){
      const sidePoolRaw = sidePoolFor(avoidP, [person]);
      const sidePool = sidePoolLadder(sidePoolRaw, history, [person], dayIndex);
      const carbPool = sidePool.filter(isCarbSide), vegPool = sidePool.filter(isVegSide);
      if(carbPool.length && vegPool.length){
        mainIds.forEach(function(mainId){
          // task (variant-fit planner): see pickSharedMeal's matching comment — sides are
          // re-ranked PER combo since a variant's own kcal changes the best-fitting pair.
          viableRecipeOptionCombos(mainId, avoidP, dietP).forEach(function(opts){
            const mainBase = recipeNutrition(mainId, 1, opts).totals;
            const sig = optsComboSignature(opts);
            const carbIds = topKSideIds(mainBase.kcal, carbPool, desired / 2, SIDE_TOP_K);
            const vegIds = topKSideIds(mainBase.kcal, vegPool, desired / 2, SIDE_TOP_K);
            pushComposedSideCandidates(function(tieId, kcal, protein, extras, portion){
              const extraTotals = addNutrientTotals(scaleNutrientTotals(dbBaseNutrition(extras[0].recipeId), extras[0].portion), scaleNutrientTotals(dbBaseNutrition(extras[1].recipeId), extras[1].portion));
              candidates.push({tieId: (sig ? tieId + '|opts:' + sig : tieId), mainId: mainId, extras: extras, opts: opts, portion: portion, kcal: kcal, protein: protein,
                totals: withOmega3(addNutrientTotals(scaleNutrientTotals(mainBase, portion), extraTotals), recipeHasOmega3(mainId) || recipeHasOmega3(extras[0].recipeId) || recipeHasOmega3(extras[1].recipeId))});
            }, mainId, mainBase, desired, anchor, maxPortion, carbIds, vegIds);
          });
        });
      }
    }
  }

  let best = null;
  candidates.forEach(function(c){
    // Same reasoning as pickSharedMeal: score keyed on the real main id, tie-break on tieId.
    const score = mealScore(c.kcal, desired, c.protein, desiredProt, dayIndex, slotIndex, c.mainId, weekSeed, person) + tuningBonus(c.totals, nextWeekTuning) + goalTuningBonus(c.totals, person);
    const better = !best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && c.tieId < best.tieId);
    if(better) best = Object.assign({score: score}, c);
  });
  if(!best){
    console.error('pickSoloMeal: empty candidate pool for person="' + person + '" slot="' + slot + '" style="' + householdStyle + '"');
    emptyPoolPicks++;
    // See pickSharedMeal's matching branch above for why `reason` is set.
    return {recipeId: null, portion: 1, kcal: 0, protein: 0, reason: 'no-candidates'};
  }
  // task (variant-fit planner): the combo `best` actually WON with — a solo slot can still
  // land on a different variant per person even on the same day/slot, since each person's
  // own avoid/diet list can allow a different set of choices AND each person's own
  // desired kcal/protein can favor a different combo. {} for a recipe without
  // optionGroups.
  const entry = makePlanEntry(best.mainId, best.portion, undefined, best.opts);
  if(best.extras) entry.extras = best.extras.slice();
  else if(best.extra) entry.extras = [best.extra];
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
    // Multi-select diets batch: changing either person's diets must regenerate future
    // (non-logged, non-pinned) plan days exactly like an avoid-list edit does — diets are
    // a hard candidatesFor()/sidePoolFor() filter (recipeViolatesDiet), so a stale plan
    // could otherwise keep serving a now-disallowed recipe until something else happened
    // to trigger a regen.
    (e.diets || []).slice().sort().join(','),
    (a.diets || []).slice().sort().join(','),
    e.calGoalNum, a.calGoalNum, e.targetP, a.targetP,
    SHARED.breakfast ? 1 : 0, SHARED.lunch ? 1 : 0, SHARED.dinner ? 1 : 0, SHARED.snack ? 1 : 0,
    nextWeekTuning, // task C2 (2026-07-18): changing the tuning goal must regenerate future
                    // (non-logged, non-pinned) days exactly like any other signature input —
                    // 'none' is just another value here, no special-cased branch.
    householdSize, // task B3 (solo households): flipping "Just me"/"Me + partner" must
                  // regenerate — going solo needs the partner cells cleared, going back to
                  // two needs them filled in again. Two-person households never see this
                  // field change (it's always 2), so their plans regenerate exactly as
                  // often as they always did.
    // Goal audit: muscle/heart/skin drive goalTuningBonus() per-person (see its doc above
    // tuningBonus) — flipping one of these must regenerate future days the same way
    // nextWeekTuning does. fatLoss/muscleGain need no entry here: they only move
    // calGoalNum, already in this signature above.
    e.goals.muscle ? 1 : 0, e.goals.heart ? 1 : 0,
    a.goals.muscle ? 1 : 0, a.goals.heart ? 1 : 0
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
  // Task B3 (solo households): every meal cell's partner half is INTENTIONALLY the empty
  // {recipeId:null,...} placeholder (emptyPlanEntry()) in a one-person household — that's
  // not a dangling reference to fix, it's the whole point. Checking RECIPES_DB[null] against
  // it would read "missing" forever and force ensureWeekPlan to regenerate on every single
  // call (silently reverting any of elena's un-pinned/un-logged swaps each time) — so the
  // partner half is skipped here whenever solo.
  const soloHousehold = isSoloHousehold();
  for(let d = 0; d < plan.days.length; d++){
    const meals = plan.days[d] && plan.days[d].meals;
    if(!meals) return true;
    for(let s = 0; s < SLOT_ORDER.length; s++){
      const slot = SLOT_ORDER[s];
      const m = meals[slot];
      if(!m || !m.elena || !m.partner) return true;
      if(m.shared && m.recipeId && !RECIPES_DB[m.recipeId]) return true;
      if(!RECIPES_DB[m.elena.recipeId]) return true;
      if(!soloHousehold && !RECIPES_DB[m.partner.recipeId]) return true;
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
    const previousPlan = plan ? deepClone(plan) : null;
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
// Free sugars only has a ceiling (coverageGaps' 10%-of-kcal target, converted to grams for
// the person's calorie goal) — the only out-of-band state is 'over'.
function classifyMaxBand(value, max){
  return (max > 0 && value > max) ? 'over' : 'in';
}

// Directional per-day balance for the Week view (display-only). Covers every tracked daily
// target. States are DESCRIPTORS, never verdicts. Any target whose data is missing (no
// calorie goal yet) resolves to 'ok' so the app never invents a warning. Grams ceilings are
// single-sourced off the person's calorie goal, same derivation as weekNutriSummary.
function perDayBalanceState(dayTotals, person){
  const out = {kcal:'ok', protein:'ok', fiber:'ok', freeSugars:'ok', satFat:'ok'};
  if(!dayTotals) return out;
  const calGoal = (typeof PROF !== 'undefined' && PROF[person] && PROF[person].calGoalNum) || 0;
  const proteinTarget = (typeof PROF !== 'undefined' && PROF[person] && PROF[person].targetP) || 0;
  // kcal: within +/- tol of the daily goal
  if(calGoal > 0){
    if(dayTotals.kcal > calGoal * (1 + PER_DAY_BANDS.kcal.tol)) out.kcal = 'high';
    else if(dayTotals.kcal < calGoal * (1 - PER_DAY_BANDS.kcal.tol)) out.kcal = 'low';
  }
  // protein: floor only
  if(proteinTarget > 0 && classifyMinBand(dayTotals.protein, proteinTarget * PER_DAY_BANDS.protein.floorMult) === 'under') out.protein = 'low';
  // fiber: floor + comfort ceiling
  const fiberFloor = WEEK_SUMMARY_THRESHOLDS.fiberMinPerDay;
  if(classifyMinBand(dayTotals.fiber, fiberFloor) === 'under') out.fiber = 'light';
  else if(classifyMaxBand(dayTotals.fiber, fiberFloor * PER_DAY_BANDS.fiber.ceilMult) === 'over') out.fiber = 'rich';
  // free sugars: ceiling
  if(calGoal > 0){
    const sugarCeil = ((NUTRITION_GUIDANCE.freeSugars.target/100)*calGoal/4) * PER_DAY_BANDS.freeSugars.ceilMult;
    if(classifyMaxBand(dayTotals.freeSugars, sugarCeil) === 'over') out.freeSugars = 'rich';
  }
  // sat fat: ceiling
  if(calGoal > 0 && typeof dayTotals.satFat === 'number'){
    const satCeil = ((NUTRITION_GUIDANCE.satFat.target/100)*calGoal/9) * PER_DAY_BANDS.satFat.ceilMult;
    if(classifyMaxBand(dayTotals.satFat, satCeil) === 'over') out.satFat = 'rich';
  }
  return out;
}
// One holistic per-day state for the collapsed day header: 'balanced' when every tracked
// target is in band, else 'off'. Keeps the overview to a single calm signal per day.
function dayBalanceOverall(dayTotals, person){
  const s = perDayBalanceState(dayTotals, person);
  return (s.kcal==='ok' && s.protein==='ok' && s.fiber==='ok' && s.freeSugars==='ok' && s.satFat==='ok') ? 'balanced' : 'off';
}

// autoBalancePlan (post-generation balancing pass, below): a person's whole-day fiber/
// free-sugars/sat-fat/kcal/protein totals, summed straight off the assembled plan's raw
// entries via planEntryNutrition — NOT the display/log-aware view weekDayNutriViews
// builds, since there's no day log yet on a plan fresh out of generateWeek and this must
// stay pure/deterministic.
function personDayNutriTotals(day, person){
  const totals = {kcal: 0, protein: 0, fiber: 0, freeSugars: 0, satFat: 0};
  SLOT_ORDER.forEach(function(slot){
    const m = day.meals[slot];
    if(!m) return;
    const nut = planEntryNutrition(m[person]);
    totals.kcal += nut.kcal; totals.protein += nut.protein; totals.fiber += nut.fiber;
    totals.freeSugars += nut.freeSugars; totals.satFat += nut.satFat;
  });
  return totals;
}

// Same single-sourced per-day targets perDayBalanceState (above) classifies against —
// this turns those bands into a continuous "how far off" scalar the greedy pass below can
// actually optimize (perDayBalanceState only ever reports a discrete state, never a
// magnitude). Calories/protein are deliberately excluded from the sum: the generator
// already balances those per day, and autoBalancePlan's own calorie-safe guard (reusing
// dailyBandState, same rule sideCandidatesForUnit already applies) protects them from ever
// regressing — this objective is fiber/free-sugars/sat-fat only.
function dayImbalanceForPerson(dayTotals, person){
  if(!dayTotals) return 0;
  const calGoal = (PROF[person] && PROF[person].calGoalNum) || 0;
  const fiberFloor = WEEK_SUMMARY_THRESHOLDS.fiberMinPerDay;
  const fiberCeil = fiberFloor * PER_DAY_BANDS.fiber.ceilMult;
  const sugarCeil = calGoal > 0 ? ((NUTRITION_GUIDANCE.freeSugars.target / 100) * calGoal / 4) * PER_DAY_BANDS.freeSugars.ceilMult : 0;
  const satCeil = calGoal > 0 ? ((NUTRITION_GUIDANCE.satFat.target / 100) * calGoal / 9) * PER_DAY_BANDS.satFat.ceilMult : 0;
  let imb = 0;
  if(fiberFloor > 0 && dayTotals.fiber < fiberFloor){
    imb += (fiberFloor - dayTotals.fiber) / fiberFloor;
  } else if(fiberCeil > 0 && dayTotals.fiber > fiberCeil){
    imb += (dayTotals.fiber - fiberCeil) / fiberCeil;
  }
  if(sugarCeil > 0 && dayTotals.freeSugars > sugarCeil){
    imb += (dayTotals.freeSugars - sugarCeil) / sugarCeil;
  }
  if(satCeil > 0 && dayTotals.satFat > satCeil){
    imb += (dayTotals.satFat - satCeil) / satCeil;
  }
  return imb;
}

// Sum of every tracked person's per-day imbalance across the whole week — the scalar
// autoBalancePlan (below) greedily drives toward 0 (or as low as the calorie-safe/variety-
// guarded candidate pool allows within its move budget).
function planImbalance(plan, people){
  let total = 0;
  plan.days.forEach(function(day){
    people.forEach(function(person){
      total += dayImbalanceForPerson(personDayNutriTotals(day, person), person);
    });
  });
  return total;
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
  // re-typed 10) converted to grams for this person's calorie goal — the SAME derivation
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
  // itself (would risk re-typing 10).
  const bandTargets = {protein: prof.targetP, carbs: prof.targetC, fat: prof.targetF,
    fiber: WEEK_SUMMARY_THRESHOLDS.fiberMinPerDay, freeSugars: Math.round(sugarTargetG)};

  const totalLoggedDays = loggedDayCount(personKey);
  if(totalLoggedDays < 2){
    return {hasEnoughData: false, days: days, inBandCount: 0, daysLoggedCount: 0,
      avgProtein: 0, avgFiber: 0, satFatEnergyPct: 0, targetProtein: PROF[personKey].targetP,
      bandTargets: bandTargets, callouts: []};
  }

  const loggedDays = days.filter(function(d){ return d.logged; });
  const sum = function(key){ return loggedDays.reduce(function(s, d){ return s + d[key]; }, 0); };
  const avgProtein = loggedDays.length ? sum('protein') / loggedDays.length : 0;
  const avgFiber = loggedDays.length ? sum('fiber') / loggedDays.length : 0;
  const totalKcal = sum('kcal'), totalSatFat = sum('satFat');
  const satFatEnergyPct = totalKcal > 0 ? totalSatFat * 9 / totalKcal * 100 : 0;
  const inBandCount = days.filter(function(d){ return d.inBand; }).length;
  const targetProtein = PROF[personKey].targetP;

  return {
    hasEnoughData: true, days: days, inBandCount: inBandCount, daysLoggedCount: loggedDays.length,
    avgProtein: avgProtein, avgFiber: avgFiber, satFatEnergyPct: satFatEnergyPct, targetProtein: targetProtein,
    bandTargets: bandTargets,
    callouts: buildInsightCallouts(avgProtein, targetProtein, avgFiber, satFatEnergyPct, inBandCount)
  };
}

// Task D1 item 4d: exactly 2 call-outs ("what's working / watch this"), picked
// deterministically by which metric sits furthest (relatively) from its target — the most
// notable fact wins; ties broken by this fixed rule order (protein, fiber, satFat,
// adherence). Every clause has fixed phrasing per rule × verdict — no free text.
function buildInsightCallouts(avgProtein, targetProtein, avgFiber, satFatEnergyPct, inBandCount){
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
        ? 'Fibre averages ' + Math.round(avgFiber) + 'g/day, at or above the 25g WHO guide.'
        : 'Fiber is under the 25g guide — averaging ' + Math.round(avgFiber) + 'g/day this week.'; }
    },
    {
      key: 'satFat', magnitude: Math.abs(satFatEnergyPct - NUTRITION_GUIDANCE.satFat.target) / NUTRITION_GUIDANCE.satFat.target,
      good: satFatEnergyPct < NUTRITION_GUIDANCE.satFat.target,
      icon: function(good){ return good ? '❤️' : '📌'; },
      text: function(good){ return good
        ? 'Saturated fat is ' + Math.round(satFatEnergyPct) + '% of energy, within the WHO <10% guidance.'
        : 'Saturated fat is ' + Math.round(satFatEnergyPct) + '% of energy, at or above the WHO <10% guidance.'; }
    },
    {
      key: 'adherence', magnitude: Math.abs(inBandCount / 7 - 0.7),
      good: inBandCount >= 5,
      icon: function(good){ return good ? '🎉' : '📌'; },
      text: function(good){ return good
        ? 'Target consistency: ' + inBandCount + ' of 7 days landed inside Mesa’s ±10% planning band.'
        : 'Target consistency: ' + inBandCount + ' of 7 days landed inside Mesa’s ±10% planning band.'; }
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

// PANTRY-plan.md P1 step 1: the shared meal->food decomposition, extracted out of
// computeShoppingList's old addRecipe/addFood inner functions so pantry consumption (P2)
// can run the IDENTICAL operation over logHistory entries instead of the plan — "the
// leanness win" the plan calls out. `components` is planEntryComponents()'s shape:
// [{recipeId, portion, opts?} | {foodId, grams}]. Returns {foodId: qty}, qty in pieces for
// unit:'piece' foods and grams/ml otherwise — the exact basis computeShoppingList has
// always emitted and the pantry (state.js) stores, so subtraction later needs no
// conversion layer.
//
// Adds `grams` of `foodId` into `out` (foodId -> qty; pieces for unit:'piece' foods,
// grams/ml otherwise) — the ONE place a composite ingredient is decomposed for the shopping
// list AND the pantry (both go through foodQuantitiesForComponents below, per its own doc:
// "so pantry consumption can run the IDENTICAL operation"). Task: composite-ingredients
// engine, item 4 (shopping list + pantry, per-composite declaration):
//   - MADE (data/foods.js: `components` present, `bought` not true — pesto-elena, the
//     dressing, the seed blend, guacamole) explodes into its components instead of adding
//     itself, using the SAME household-diet-resolved variant engine.js:activeCompositeVariant
//     picks for nutrition (so a vegan household's shopping list asks for nutritional yeast,
//     not parmesan, for the exact same jar of pesto their plan is actually built from).
//     Recurses for a nested composite (engine.js's nesting decision applies here too);
//     `seen`/`depth` guard the same authoring-cycle risk.
//   - BOUGHT (mayonnaise, soy sauce — soy sauce isn't even a composite) adds itself, exactly
//     like a plain food, because that's what actually gets bought off a shelf.
// This is the single decomposition path both addFromIngredient and addFromFoodComponent
// below funnel into — there is deliberately no second place a composite gets exploded.
function addFoodQty(out, foodId, grams, seen, depth){
  seen = seen || {};
  depth = depth || 0;
  const food = FOODS[foodId];
  if(!food) return;
  if(Array.isArray(food.components) && !food.bought && !seen[foodId] && depth <= 6){
    const combo = (typeof activeCompositeVariant === 'function') ? activeCompositeVariant(food) : food;
    const yieldG = (typeof combo.yieldG === 'number' && combo.yieldG > 0) ? combo.yieldG
      : (typeof food.yieldG === 'number' && food.yieldG > 0) ? food.yieldG : null;
    if(yieldG){
      const nextSeen = Object.assign({}, seen);
      nextSeen[foodId] = true;
      const scale = grams / yieldG;
      (Array.isArray(combo.components) ? combo.components : food.components).forEach(function(c){
        addFoodQty(out, c[0], c[1] * scale, nextSeen, depth + 1);
      });
      return;
    }
  }
  out[foodId] = (food.unit === 'piece') ? (out[foodId] || 0) + grams / food.avgG : (out[foodId] || 0) + grams;
}

// This is a PURE REFACTOR of the old addRecipe/addFood bodies (tools/check.js's
// decomposition-parity test is the contract) — preserves batch-yield (r.servings),
// optionGroups resolution via recipeEffectiveIngredients(r, opts), and the exact
// piece-vs-gram arithmetic AND guard behaviour of both original inner functions,
// including the pre-existing asymmetry between them: the recipe-ingredient path only ever
// guarded on `!food` (never on the ingredient's own grams sign), while the direct-food
// path (addFood) always required `grams > 0`. Two small internal accumulators mirror that
// asymmetry exactly rather than unifying it, so behaviour cannot drift even in a
// (currently nonexistent, data/validate.js-enforced-positive) zero/negative-qty edge case.
// Both now funnel into addFoodQty above for the actual accumulation, which is also where a
// composite ingredient gets exploded into its components (task: composite-ingredients
// engine, item 4) — so this function's own guards are unchanged, only the final "add it"
// step gained composite-awareness.
function foodQuantitiesForComponents(components){
  const out = {}; // foodId -> qty, in the SAME accumulation order the old inline totals
                   // object used, so the running per-food sums stay float-bit-identical
                   // when callers feed one ordered, whole-traversal components list.
  function addFromIngredient(foodId, grams){ // mirrors old addRecipe's inner guard/branch
    const food = FOODS[foodId];
    if(!food) return;
    addFoodQty(out, foodId, grams);
  }
  function addFromFoodComponent(foodId, grams){ // mirrors old addFood exactly
    const food = FOODS[foodId];
    if(!food || !(grams > 0)) return;
    addFoodQty(out, foodId, grams);
  }
  (components || []).forEach(function(c){
    if(c && c.recipeId){
      const r = RECIPES_DB[c.recipeId];
      if(!r || !(c.portion > 0)) return;
      // `c.portion` is servings eaten; ingredients are the whole batch, which makes
      // r.servings servings — buy batch/servings per serving eaten.
      const batchYield = (typeof r.servings === 'number' && r.servings > 0) ? r.servings : 1;
      // task D1: recipeEffectiveIngredients (engine.js) resolves the CHOSEN variant's
      // ingredients (base + the opts-selected choice per group) — buys what was actually
      // planned/eaten, not always the default combo.
      recipeEffectiveIngredients(r, c.opts).forEach(function(ing){
        addFromIngredient(ing[0], (ing[1] / batchYield) * c.portion);
      });
    } else if(c && c.foodId){
      addFromFoodComponent(c.foodId, c.grams);
    }
  });
  return out;
}

// Builds the ONE flat, ORDER-PRESERVING components list for `plan` (both people, every
// day/slot) — computeShoppingList's original single traversal, factored out so PANTRY-
// plan.md P3's next-week projection (pantry.js:pantryProjectedForNextWeek, via
// currentWeekRemainingFoodQuantities below) can run the EXACT same walk over just the
// current week. day -> slot -> elena -> partner order is preserved either way, so
// foodQuantitiesForComponents' accumulation order (and so its summed float bits) is
// unchanged from the pre-P3 traversal when `excludeLogged` is false.
//
// Q1 (PANTRY-plan.md P3): when `excludeLogged` is true, a (day, slot, person) already
// logged OR skipped (slotLogStatus() truthy — reuses log.js's own source of truth rather
// than re-deriving it) is left out entirely: that food was already bought/eaten, so the
// list shouldn't ask for it again. computeShoppingList only ever passes true for the week
// that IS the current week — a future week is never logged yet, so passing false there
// (or passing true on an empty-logHistory week) is a no-op either way.
// slotLogStatus() reads through getDayLog(), which LAZILY CREATES an empty logHistory
// record for any date it's asked about. Building a shopping list is a pure read, so going
// straight through it would leave 7 empty day records behind on every view — and
// pruneLogHistory() only drops records by AGE, never by emptiness, so they would persist
// and sync for the full 60-day retention window, accumulating in the same scarce iOS quota
// persist() competes for. A date with no logHistory record has nothing logged BY
// DEFINITION, so checking for the record first is exactly equivalent and side-effect-free.
function slotLoggedReadOnly(dateISO, personKey, slot){
  if(!logHistory[dateISO]) return false;
  return !!slotLogStatus(dateISO, personKey, slot);
}

// WEEK-EATENOUT-plan.md: a (day, slot, person) pre-logged as eaten-out is excluded
// UNCONDITIONALLY — not gated on `excludeLogged` like the slotLoggedReadOnly rule above —
// because marking a Week meal eaten-out logs it on ITS OWN date regardless of which week
// (this one or next) is being viewed/shopped-for. The current-week list already drops it
// via the excludeLogged rule (redundant with this one there, harmless); THIS is what makes
// a pre-logged next-week eaten-out meal drop too, since computeShoppingList only passes
// excludeLogged=true for the current week. slotLoggedEatenOut (log.js) is the same
// side-effect-free "check logHistory[dateISO] first" read as slotLoggedReadOnly above, so
// this stays a pure read like the rest of this function.
function weekPlanComponents(plan, excludeLogged){
  const components = [];
  plan.days.forEach(function(day){
    SLOT_ORDER.forEach(function(slot){
      const m = day.meals[slot];
      const elenaDone = (excludeLogged && slotLoggedReadOnly(day.date, 'elena', slot)) || slotLoggedEatenOut(day.date, 'elena', slot);
      const partnerDone = (excludeLogged && slotLoggedReadOnly(day.date, 'partner', slot)) || slotLoggedEatenOut(day.date, 'partner', slot);
      if(!elenaDone) planEntryComponents(m.elena).forEach(function(c){ components.push(c); });
      if(!partnerDone) planEntryComponents(m.partner).forEach(function(c){ components.push(c); });
    });
  });
  return components;
}

// {foodId: qty} for the CURRENT week's plan, counting only what's still OUTSTANDING (not
// yet logged or skipped) — Q1's exact exclusion, exposed standalone. This is "this week's
// remaining, not-yet-logged demand" that PANTRY-plan.md P3 step 3's next-week projection
// needs: the rest of the current week is still going to eat into the pantry between now
// and next Monday, so next week's list must discount the pantry for that first. Lives here
// (not pantry.js) because it only reads the plan/log side — pantry.js's own doc header
// keeps that file to pure pantry-baseline derivation.
function currentWeekRemainingFoodQuantities(){
  const plan = ensureWeekPlan(mondayOfWeek(todayISO()));
  return foodQuantitiesForComponents(weekPlanComponents(plan, true));
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
//
// PANTRY-plan.md P3 additions (kept additive — `totals[name]` keeps its original {qty,
// unit, foodIds} shape, `staples` and `weekStartDate` are unchanged; `covered` and
// `alreadyHome` are new top-level fields):
//   Q1 — for the CURRENT week only, already-logged/skipped slots are excluded from the
//   count in the first place (weekPlanComponents above) — see its doc block.
//   Pantry subtraction — need = planned - available, floored at 0. `available` is
//   pantryRemaining() for the current week, or the PROJECTED leftover for next week
//   (pantryProjectedForNextWeek, js/pantry.js — see its doc block for why next week can't
//   just use pantryRemaining() as-is). A row fully covered drops off `totals` entirely and
//   is recorded as a structured row in `alreadyHome` (not just a name in a sentence — the
//   "Defect C" shopping<->pantry redesign renders this as a real "Already home" section,
//   render-sheets.js:buildShopSheet); a row only partially covered keeps its REDUCED qty
//   and is recorded in `covered[name] = {have, unit}` — never a silent disappearance, per
//   the plan's explicit "indistinguishable from a bug" concern.
function computeShoppingList(weekStartDate){
  const plan = ensureWeekPlan(weekStartDate);
  const totals = {};  // food display name -> {qty, unit, foodIds}
  const staples = {}; // food display name -> true (toTaste garnish, unquantified)

  const isCurrentWeek = plan.weekStartDate === mondayOfWeek(todayISO());
  const isNextWeek = !isCurrentWeek && plan.weekStartDate === nextMondayISO();
  const allComponents = weekPlanComponents(plan, isCurrentWeek);

  // Staples (toTaste) are gathered per recipe component, independent of quantity — same
  // guard (`r` exists, `portion > 0`) the old inline addRecipe used before touching staples.
  // Reads allComponents AFTER Q1's exclusion, same as the totals below: a staple whose only
  // recipe this week was already logged/eaten isn't worth flagging either.
  allComponents.forEach(function(c){
    if(!c || !c.recipeId) return;
    const r = RECIPES_DB[c.recipeId];
    if(!r || !(c.portion > 0)) return;
    (r.toTaste || []).forEach(function(t){ staples[capitalizeFirst(t)] = true; });
  });

  // PANTRY-plan.md P1 step 2: each row also carries the foodId(s) that contributed to it,
  // so P3 can subtract the pantry by stable id without touching the name-keyed
  // checkedShopByWeek (no migration, no risk to existing checked state). foodId -> name is
  // 1:1 in practice (FOODS has no duplicate display names) so this is normally a
  // one-element array; built as an array rather than a single id purely as a defensive
  // hedge against that legacy name-keying wart, never assumed elsewhere.
  const qtyByFood = foodQuantitiesForComponents(allComponents);
  Object.keys(qtyByFood).forEach(function(foodId){
    const food = FOODS[foodId];
    if(!food) return;
    const name = food.name;
    if(!totals[name]) totals[name] = {qty: 0, unit: food.unit === 'piece' ? '' : food.unit, foodIds: []};
    totals[name].qty += qtyByFood[foodId];
    if(totals[name].foodIds.indexOf(foodId) === -1) totals[name].foodIds.push(foodId);
  });

  // PANTRY-plan.md P3 step 2/3: subtract what's already at home (see the function doc
  // above for the exact contract). `have` sums availableByFood across every foodId the row
  // aggregates, in the SAME pieces/grams/ml basis foodQuantitiesForComponents already used
  // to build qty — no conversion layer needed. A tiny epsilon guards both comparisons
  // against float dust turning an exact-cover row into a spurious 1-unit remainder (piece
  // rounding uses Math.ceil in fmtShopQty, so even 1e-9 piece would otherwise display "1").
  const availableByFood = isNextWeek ? pantryProjectedForNextWeek() : pantryRemaining();
  const covered = {};      // name -> {have, unit} for a row that's only PARTIALLY covered
  // Defect C redesign: a row the pantry FULLY covers still drops off `totals` (nothing left
  // to buy), but is never silently dropped — it's handed back as a structured row here
  // instead of just a name in a summary sentence, so the shopping sheet can render a real
  // "Already home" section (foodId, name, have-qty, unit) with its own "need more?" manual
  // adjust, rather than the old one-line "Already at home, not on this list: ...". foodId is
  // the row's primary contributing food (foodIds is normally a 1-element array — see the
  // foodIds doc above); foodIds itself is carried too so a "need more?" tap can step down
  // every contributing food if a row is ever the rare multi-foodId case.
  const alreadyHome = [];
  Object.keys(totals).forEach(function(name){
    const row = totals[name];
    let have = 0;
    row.foodIds.forEach(function(foodId){ have += availableByFood[foodId] || 0; });
    if(have <= 1e-9) return;
    if(have >= row.qty - 1e-9){
      alreadyHome.push({foodId: row.foodIds[0], foodIds: row.foodIds.slice(), name: name, have: have, unit: row.unit});
      delete totals[name];
    } else {
      covered[name] = {have: have, unit: row.unit};
      row.qty -= have;
    }
  });

  return {totals: totals, staples: staples, weekStartDate: plan.weekStartDate, covered: covered, alreadyHome: alreadyHome};
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

// Meal builder (owner spec 2026-08-17) "Use for this meal"/"Log as eaten out": sets a
// slot's base recipe directly at portion 1x — deliberately NOT applySwapToPlan/applySwap,
// which re-portion (bestPortion) to land close to whatever kcal was already in the slot.
// That's exactly right for a like-for-like swap, but wrong here: the builder's rows already
// ARE the exact composed meal the user just reviewed (live totals in the sheet), and scaling
// them by an unrelated "how many kcal was here before" portion would silently multiply (or
// shrink) those very macros. Mirrors applySwapToPlan's own shared-vs-solo cell handling (a
// shared slot's build applies to BOTH people, same as a normal shared swap) but always at
// makePlanEntry(recipeId, 1) — no bestPortion, no extras carried over (the built recipe's
// ingredients already ARE the whole meal, nothing left to layer on top of).
function applyOneTimeMealToSlot(weekStartDate, dayIndex, slot, person, recipeId){
  const plan = editableWeekPlan(weekStartDate);
  const meal = plan.days[dayIndex].meals[slot];
  const now = Date.now();
  if(meal.shared){
    meal.recipeId = recipeId;
    meal.t = now;
    meal.elena = makePlanEntry(recipeId, 1, now);
    meal.partner = makePlanEntry(recipeId, 1, now);
  } else {
    meal[person] = makePlanEntry(recipeId, 1, now);
    delete meal.t;
  }
  markWeekPlanEdited(plan);
  return meal;
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

// "What do you feel like?" swap filter (owner spec, 2026-08-17): does recipeId contain any
// ingredient (from recipeEffectiveIngredients — the recipe's CHOSEN-variant list, engine.js)
// whose food is tagged FOODS[id].sub === sub. FOODS[id].cat alone can't answer "does this
// contain fruit": fruit and veg both live under cat:'Produce' (see foods.js header), which is
// exactly why foods.js now carries `sub:'fruit'` on the actual fruit entries.
function recipeContainsFoodSub(recipeId, sub){
  const r = RECIPES_DB[recipeId];
  if(!r) return false;
  return recipeEffectiveIngredients(r, {}).some(function(ing){
    const food = FOODS[ing[0]];
    return !!(food && food.sub === sub);
  });
}

// "Veg" = any Produce ingredient that is NOT tagged fruit — onions, leafy greens, peppers,
// tomatoes, and every other savory Produce entry. Mirrors recipeContainsFoodSub's ingredient
// walk so the two stay consistent with each other as foods.js grows.
function recipeContainsVeg(recipeId){
  const r = RECIPES_DB[recipeId];
  if(!r) return false;
  return recipeEffectiveIngredients(r, {}).some(function(ing){
    const food = FOODS[ing[0]];
    return !!(food && food.cat === 'Produce' && food.sub !== 'fruit');
  });
}

// Alternatives = same slot, same style, avoid-respecting, excluding the current recipe
// and anything already planned elsewhere today for this person; ranked by closest
// computed kcal to what's currently planned (deterministic tie-break by id).
// weekStartDate (optional, defaults to the current week — same compat contract as
// ensureWeekPlan) lets the Week screen's swap sheet operate on NEXT week's plan too.
// Two swap candidates whose best-fit calories land within this many kcal of the meal being
// swapped are treated as an equally good fit and rotated for variety (see buildSwapAlternatives).
const SWAP_KCAL_TIE_BAND = 120;
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
  // Variety (2026-07-22): also avoid recipes already used ANYWHERE ELSE this week (main dish
  // or composed extra, for this person), so the suggestions aren't just "whatever's closest
  // in calories" — which used to make two similar-calorie meals surface the identical top
  // pick. Falls back gracefully if that would leave nothing.
  const usedThisWeek = {};
  plan.days.forEach(function(dd, di){
    SLOT_ORDER.forEach(function(s){
      if(di === dayIndex && s === slot) return; // the slot being swapped is fair game
      const mm = dd.meals[s];
      const e = mm.shared ? mm[person] : mm[person];
      if(!e) return;
      planEntryComponents(e).forEach(function(c){ if(c.recipeId) usedThisWeek[c.recipeId] = true; });
    });
  });
  // A swap must offer a COMPLETE meal, not a bare side/main dish that happens to be
  // tagged for this slot (Problem 3, 2026-08-11) — restrict the pool to
  // isCompleteLunchDinnerRecipe() ids for lunch/dinner BEFORE the relaxation tiers below,
  // so every tier (today-avoiding, week-avoiding, raw) stays complete-meal-only; breakfast
  // and snack have no completeness contract and are unaffected.
  const completeOnly = slot === 'lunch' || slot === 'dinner';
  let rawPool = candidatesFor(slot, styleKey, avoidL, [person]).filter(function(id){ return id !== currentId; });
  if(completeOnly) rawPool = rawPool.filter(function(id){ return isCompleteLunchDinnerRecipe(id); });
  let pool = rawPool.filter(function(id){ return !plannedToday[id] && !usedThisWeek[id]; });
  if(!pool.length) pool = rawPool.filter(function(id){ return !plannedToday[id]; }); // relax week-wide
  if(!pool.length) pool = rawPool;                                                    // relax today

  // "What do you feel like?" (owner spec, 2026-08-17): swapCtx.craving is the swap sheet's
  // chip filter, read straight off the global — same convention buildSwapSearchOptions above
  // already uses for swapCtx.includeOtherMeals. Fruit/Veg/Quick are hard FILTERS on the pool;
  // Protein/Light are re-RANKS applied in the sort below, on top of the existing kcal-fit
  // band (no pool change for those two). A filter that would empty the pool falls back to the
  // unfiltered pool — same relaxation contract as the tiers immediately above: a swap must
  // always offer something.
  const craving = swapCtx ? swapCtx.craving : null;
  if(craving === 'fruit' || craving === 'veg' || craving === 'quick'){
    const cravingPool = pool.filter(function(id){
      if(craving === 'fruit') return recipeContainsFoodSub(id, 'fruit');
      if(craving === 'veg') return recipeContainsVeg(id);
      const r = RECIPES_DB[id];
      return !!(r && typeof r.time === 'number' && r.time <= 15);
    });
    if(cravingPool.length) pool = cravingPool;
  }

  const anchor = PERSON_ANCHOR[person];
  const slotIndex = SLOT_ORDER.indexOf(slot);
  const scored = pool.map(function(id){
    const base = dbBaseNutrition(id);
    const bp = bestPortion(base.kcal, currentKcal, anchor, SLOT_MAX_PORTION[slot]);
    const protein = base.protein * bp.portion;
    // Group by calorie-fit BAND (not raw delta): every candidate within SWAP_KCAL_TIE_BAND of
    // the target counts as an equally good fit, and within a band we ROTATE by (day, slot,
    // recipe) — deterministic, but different per day — so a given calorie target no longer
    // always surfaces the single closest dish first. Best-fitting band still comes first.
    const band = Math.round(Math.abs(bp.kcal - currentKcal) / SWAP_KCAL_TIE_BAND);
    const rot = (dayIndex * 7 + slotIndex + stableHash(id)) % 997;
    return {id: id, portion: bp.portion, kcal: bp.kcal, protein: protein, kcalDelta: bp.kcal - currentKcal, proteinDelta: protein - currentProtein, band: band, rot: rot};
  });
  scored.sort(function(a, b){
    // Protein/Light craving re-rank takes priority over the kcal-fit band, but still falls
    // through to it (then rot, then id) as a deterministic tie-break.
    if(craving === 'protein' || craving === 'light'){
      const av = craving === 'protein' ? (a.kcal > 0 ? a.protein / a.kcal : 0) : a.kcal;
      const bv = craving === 'protein' ? (b.kcal > 0 ? b.protein / b.kcal : 0) : b.kcal;
      if(av !== bv) return craving === 'protein' ? (bv - av) : (av - bv); // protein: higher first; light: lower kcal first
    }
    if(a.band !== b.band) return a.band - b.band;
    if(a.rot !== b.rot) return a.rot - b.rot;
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

// Small helper for the "usually {slot}" tag (Problem 4): a recipe's own primary slot,
// mirroring RECIPE_SLOT_DB's derivation (recipe.slot), falling back to the first entry of
// recipeSlotList() for the rare recipe missing a primary. Returns '' if neither resolves.
function primarySlotLabel(r){
  const s = (r && r.slot) || recipeSlotList(r)[0];
  return SLOT_LABEL[s] || '';
}

// Searchable swap pool: every recipe in the same meal slot, built-in and custom, across
// all plan styles. Manual search is explicit user intent, so it does not apply the current
// household style filter. Avoid-lists still apply, and the currently planned recipe is
// excluded because selecting it would be a no-op.
// swapCtx.includeOtherMeals (Problem 4 — "I had breakfast for lunch") is the explicit
// opt-in toggle on the swap sheet: OFF (default) keeps this same-slot, and for lunch/dinner
// additionally requires isCompleteLunchDinnerRecipe() so the default search stays
// consistent with buildSwapAlternatives' complete-meal-only contract (Problem 3). ON drops
// the slot filter entirely (any slot, any role, including bare sides/mains) as the explicit
// escape hatch the owner asked for — still excludes the current recipe and occasional dishes.
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
  const includeOtherMeals = !!(swapCtx && swapCtx.includeOtherMeals);
  const completeOnly = !includeOtherMeals && (slot === 'lunch' || slot === 'dinner');
  const pool = Object.keys(RECIPES_DB).filter(function(id){
    const r = RECIPES_DB[id];
    if(id === currentId || swapSearchText(id).indexOf(q) === -1) return false;
    if(r.oneTime) return false; // throwaway one-time built meals never clutter swap search (same intent as filteredRecipeIds hiding them from My recipes)
    if(includeOtherMeals) return !r.occasional;
    if(recipeSlotList(r).indexOf(slot) === -1) return false;
    if(completeOnly && !isCompleteLunchDinnerRecipe(id)) return false;
    return true;
  });
  const scored = pool.map(function(id){
    const r = RECIPES_DB[id];
    const base = dbBaseNutrition(id);
    const bp = bestPortion(base.kcal, currentKcal, anchor, SLOT_MAX_PORTION[slot]);
    const protein = base.protein * bp.portion;
    const otherSlot = recipeSlotList(r).indexOf(slot) === -1;
    return {id: id, title: r.title, custom: id.indexOf('cr-') === 0, avoidHit: recipeHitsAvoid(r, avoidL), portion: bp.portion, kcal: bp.kcal, protein: protein,
      kcalDelta: bp.kcal - currentKcal, proteinDelta: protein - currentProtein,
      otherSlot: otherSlot ? primarySlotLabel(r) : null};
  });
  scored.sort(function(a, b){
    // PERSONAL-PREFS: swap sort favorites the CURRENTLY ACTIVE person's own prefs
    // (currentProf), same convention as the library recipe list/swap sheet elsewhere.
    const aFav = recipePref(a.id, currentProf) === 'favorite';
    const bFav = recipePref(b.id, currentProf) === 'favorite';
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

// swapCtx shape: {dayIndex, slot, person, weekStartDate, targetElId, alts, searchQuery,
// includeOtherMeals, craving}. craving (string|null — 'fruit'|'veg'|'protein'|'light'|'quick')
// is the "What do you feel like?" chip state (owner spec, 2026-08-17); see
// toggleSwapCraving/buildSwapAlternatives below. Reset to null on every fresh sheet open,
// same as includeOtherMeals.
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
  // Problem 4: cross-slot search results (swapCtx.includeOtherMeals) carry the recipe's
  // usual slot so the row doesn't read as an unexplained lunch/dinner-shaped search hit.
  const otherSlotTag = a.otherSlot ? '<div class="sub" style="margin:2px 0 0">usually ' + escapeHtml(a.otherSlot.toLowerCase()) + '</div>' : '';
  return '<div class="altrow" data-recipe-id="' + htmlAttr(a.id) + '">'
    + '<div class="ae">' + r.emoji + '</div>'
    + '<div class="at"><div class="an">' + escapeHtml(r.title) + '</div>'
    + '<div class="ad"><b>' + kd + '</b> · <b>' + pd + '</b></div>'
    + otherSlotTag
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
function swapOtherMealsToggleLabel(slot){
  const slotLabel = (SLOT_LABEL[slot] || slot).toLowerCase();
  return swapCtx && swapCtx.includeOtherMeals
    ? '↩︎ Showing all meals — limit to ' + slotLabel + ' only'
    : '🍽️ Show other meals (e.g. a breakfast for lunch)';
}

// Problem 4 ("I had breakfast for lunch"): flips the same-slot-only search restriction and
// re-renders just the search results + the toggle's own label. Never touches "Best
// matches" (buildSwapAlternatives stays strictly same-slot + complete, per the owner's
// same-slot-first decision) — only the search list beneath it changes.
function toggleSwapOtherMeals(){
  if(!swapCtx) return;
  swapCtx.includeOtherMeals = !swapCtx.includeOtherMeals;
  const btn = document.getElementById('swapOtherMealsToggle');
  if(btn) btn.textContent = swapOtherMealsToggleLabel(swapCtx.slot);
  const el = document.getElementById('swapSearchResults');
  if(el) el.innerHTML = buildSwapSearchResults();
}

// #5b/meal-builder (owner spec 2026-08-17): from the swap sheet, jump straight into the
// MEAL BUILDER (render-today.js:openMealBuilder) for this slot — a separate ingredient-row
// draft that can start from a recipe's ingredients and freely edit/remove them (not just add
// extras on top of a privileged base, which is all the add-meal composer/
// openAddMealSheetForContext ever allowed). Reads the shared swapCtx (set by openWeekSwap et
// al.); mode 'plan' shows the builder's "Use for this meal" footer action, which sets THIS
// slot's base recipe once the user commits (planner.js:applyOneTimeMealToSlot).
function openBuildYourOwnMeal(){
  if(!swapCtx) return;
  const weekStartDate = swapCtx.weekStartDate || mondayOfWeek(todayISO());
  if(typeof openMealBuilder === 'function'){
    openMealBuilder({weekStartDate: weekStartDate, dayIndex: swapCtx.dayIndex, slot: swapCtx.slot, person: swapCtx.person}, 'plan');
  }
}

// "What do you feel like?" chips (owner spec, 2026-08-17): single-select preset chips that
// filter/re-rank "Best matches" in place — instant re-render, no submit, matching the rest of
// the swap sheet's feel. Deliberately NOT "Comforting": no real data signal in FOODS/
// RECIPES_DB backs it (see recipeContainsFoodSub/recipeContainsVeg above buildSwapAlternatives
// for what IS backed). 'protein'/'light' re-rank only; 'fruit'/'veg'/'quick' filter the pool
// too — see buildSwapAlternatives' craving handling.
const SWAP_CRAVING_OPTIONS = [
  {key: 'fruit', label: '🍎 Fruit'},
  {key: 'veg', label: '🥦 Veg'},
  {key: 'protein', label: '🍗 Protein'},
  {key: 'light', label: '🪶 Light'},
  {key: 'quick', label: '⏱️ Quick'}
];

function swapCravingChipsHtml(){
  const craving = swapCtx ? swapCtx.craving : null;
  const chips = SWAP_CRAVING_OPTIONS.map(function(o){
    const on = craving === o.key;
    return '<button type="button" class="pill ghost chip-preset' + (on ? ' chipsel' : '') + '" style="min-height:44px;padding:0 14px" onclick="toggleSwapCraving(\'' + o.key + '\')">' + o.label + '</button>';
  }).join('');
  return '<div class="shop-cat">What do you feel like?</div>'
    + '<div class="chiprow">' + chips + '</div>'
    + '<input class="inp" style="width:100%;box-sizing:border-box;border:1px solid var(--line);margin-top:8px" type="search" id="swapCravingFreeText" placeholder="Or type what you feel like..." autocomplete="off" oninput="onSwapCravingFreeText(this.value)">';
}

// Shared by buildSwapSheet's initial render and toggleSwapCraving's re-render — same
// shared-renderer idea swapAltRowHtml's own doc comment describes for "Best matches"/"All
// options" staying visually identical.
function swapBestMatchesHtml(best){
  if(!best || !best.length) return '<p class="sub">No other option fits this slot today.</p>';
  return '<div class="shop-cat">Best matches</div>' + best.map(function(a, i){ return swapAltRowHtml(a, i); }).join('');
}

// Chip tap: single-select (tapping the already-active chip clears it back to unfiltered),
// instant re-render of just the chip row (selected state) and "Best matches" (re-filtered/
// re-ranked). buildSwapAlternatives reads swapCtx.craving directly (same convention
// buildSwapSearchOptions already uses for swapCtx.includeOtherMeals), so recomputing it here
// is enough — no separate filter function to keep in sync.
function toggleSwapCraving(key){
  if(!swapCtx) return;
  swapCtx.craving = (swapCtx.craving === key) ? null : key;
  const best = buildSwapAlternatives(swapCtx.dayIndex, swapCtx.slot, swapCtx.person, swapCtx.weekStartDate);
  swapCtx.alts = best;
  const chips = document.getElementById('swapCravingChips');
  if(chips) chips.innerHTML = swapCravingChipsHtml();
  const bm = document.getElementById('swapBestMatches');
  if(bm) bm.innerHTML = swapBestMatchesHtml(best);
}

// Free-text escape hatch ("or type what you feel like..."): funnels straight into the
// EXISTING recipe search below (swapCtx.searchQuery + buildSwapSearchResults) instead of
// inventing a second search — typing here pre-fills and auto-triggers that search box. Clears
// any active preset chip (mutually exclusive with typing) and reverts "Best matches" to its
// unfiltered ranking, but does NOT rebuild the chip row's own HTML (that would wipe the field
// the user is actively typing into on every keystroke) — it only clears the .chipsel class
// directly via the DOM.
function onSwapCravingFreeText(value){
  if(!swapCtx) return;
  if(swapCtx.craving){
    swapCtx.craving = null;
    const chips = document.getElementById('swapCravingChips');
    if(chips && chips.querySelectorAll) chips.querySelectorAll('.chip-preset').forEach(function(btn){ btn.classList.remove('chipsel'); });
    const best = buildSwapAlternatives(swapCtx.dayIndex, swapCtx.slot, swapCtx.person, swapCtx.weekStartDate);
    swapCtx.alts = best;
    const bm = document.getElementById('swapBestMatches');
    if(bm) bm.innerHTML = swapBestMatchesHtml(best);
  }
  onSwapRecipeSearch(value);
  const searchInput = document.getElementById('swapRecipeSearchInput');
  if(searchInput) searchInput.value = value;
}

function buildSwapSheet(ctx){
  if(swapCtx){
    // Reset every time the sheet (re)opens for a fresh context — a stale "show other
    // meals" opt-in or craving filter from a previous swap should never leak into the next
    // one. Reset BEFORE computing `best` below so the very first render is always unfiltered.
    swapCtx.includeOtherMeals = false;
    swapCtx.craving = null;
  }
  const best = buildSwapAlternatives(ctx.dayIndex, ctx.slot, ctx.person, ctx.weekStartDate);
  if(swapCtx){
    swapCtx.alts = best;
    swapCtx.searchQuery = swapCtx.searchQuery || '';
  }

  const slotLabel = (SLOT_LABEL[ctx.slot] || ctx.slot).toLowerCase();
  let html = '<h2 style="margin-top:6px">Swap this meal</h2><p class="sub">Best matches keep the plan close. Search can pick any compatible ' + slotLabel + ' recipe, including yours.</p>'
    + '<button class="cta ghostbtn" style="margin-top:4px" onclick="openBuildYourOwnMeal()">🧩 Build your own meal — ingredients &amp; recipes</button>'
    + '<div id="swapCravingChips">' + swapCravingChipsHtml() + '</div>'
    + '<div id="swapBestMatches">' + swapBestMatchesHtml(best) + '</div>';

  html += '<div class="shop-cat">Search ' + slotLabel + ' recipes</div>'
    + '<button type="button" class="backbtn" id="swapOtherMealsToggle" style="margin:8px 0" onclick="toggleSwapOtherMeals()">' + escapeHtml(swapOtherMealsToggleLabel(ctx.slot)) + '</button>'
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
  renderLogScreen();
  renderWeek();
  const recipeScreen = document.getElementById('recipe');
  if(recipeScreen && recipeScreen.classList.contains('active') && isCurrentWeek) renderRecipe(view.recipeId);
  persist();
  closeSheet();
  toast('🔁 Swapped to ' + view.title + ' (' + (alt.kcalDelta >= 0 ? '+' : '') + Math.round(alt.kcalDelta) + ' kcal)');
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

// Real weekly nutrient coverage over a given plan (defaults to the live weekPlan).
// Only measures with a clear, computable public-health comparator are shown here:
// fibre g/day and saturated fat/free sugars as a share of energy.
function computeWeeklyCoverage(plan){
  plan = plan || weekPlan;
  let fiberSumE = 0, fiberSumA = 0;
  let satFatSum = 0, freeSugarKcal = 0, totalKcal = 0;
  plan.days.forEach(function(day){
    SLOT_ORDER.forEach(function(slot){
      const m = day.meals[slot];
      const nutE = planEntryNutrition(m.elena);
      const nutA = planEntryNutrition(m.partner);
      fiberSumE += nutE.fiber; fiberSumA += nutA.fiber;
      satFatSum += nutE.satFat + nutA.satFat;
      freeSugarKcal += (nutE.freeSugars + nutA.freeSugars) * 4;
      totalKcal += nutE.kcal + nutA.kcal;
    });
  });
  return {
    fiberAvgPerDay: {elena: fiberSumE / 7, partner: fiberSumA / 7},
    satFatShareOfKcal: totalKcal > 0 ? satFatSum * 9 / totalKcal : 0,
    freeSugarShareOfKcal: totalKcal > 0 ? freeSugarKcal / totalKcal : 0
  };
}

// Normalizes each metric to a 0..1+ "gap fraction" (0 = target met) so they're
// comparable; the "worst gap" is whichever is largest. Fiber is per-person by spec, so
// this reports whichever of the two people is currently worse off.
function coverageGaps(cov){
  // Task B3 (solo households): cov.fiberAvgPerDay.partner is always 0 there (the empty
  // partner cell contributes nothing) — comparing against a phantom 0g/day "person" would
  // make fiber look like a permanent, maxed-out gap regardless of elena's real intake.
  const worstFiberPerson = isSoloHousehold() ? 'elena'
    : (cov.fiberAvgPerDay.elena <= cov.fiberAvgPerDay.partner ? 'elena' : 'partner');
  const worstFiberVal = cov.fiberAvgPerDay[worstFiberPerson];
  const satPct = cov.satFatShareOfKcal * 100;
  // The displayed guidance is strictly "under 10%". At exactly 10% the bar is at
  // the limit but should still flag as not under it; a tiny positive gap preserves that
  // state in the common rendering path which treats gap > 1e-9 as an alert.
  const satAtOrOverCap = satPct >= NUTRITION_GUIDANCE.satFat.target;
  const sugarPct = cov.freeSugarShareOfKcal * 100;
  return {
    fiber: {key: 'fiber', label: 'Fibre', value: Math.round(worstFiberVal), target: NUTRITION_GUIDANCE.fiber.target, unit: 'g/day', person: worstFiberPerson,
      gap: Math.max(0, (NUTRITION_GUIDANCE.fiber.target - worstFiberVal) / NUTRITION_GUIDANCE.fiber.target), pct: Math.min(100, Math.round(worstFiberVal / NUTRITION_GUIDANCE.fiber.target * 100))},
    satFat: {key: 'satFat', label: 'Saturated fat', value: Math.round(satPct), target: NUTRITION_GUIDANCE.satFat.target, unit: '% of energy', cap: true,
      gap: satAtOrOverCap ? Math.max(0.000001, (satPct - NUTRITION_GUIDANCE.satFat.target) / NUTRITION_GUIDANCE.satFat.target) : 0, pct: Math.min(100, Math.round(satPct / NUTRITION_GUIDANCE.satFat.target * 100))},
    freeSugars: {key: 'freeSugars', label: 'Free sugars', value: Math.round(sugarPct), target: NUTRITION_GUIDANCE.freeSugars.target, unit: '% of energy',
      gap: Math.max(0, (sugarPct - NUTRITION_GUIDANCE.freeSugars.target) / NUTRITION_GUIDANCE.freeSugars.target), pct: Math.min(100, Math.round(sugarPct / NUTRITION_GUIDANCE.freeSugars.target * 100)), cap: true}
  };
}

/* ---------------- T6: week diet-summary line ---------------- */
// Deterministic, single-person read of a given plan: the same 28 meals renderWeek() lists
// for `personKey` (day.meals[slot][personKey] — already the portion-scaled view render.js
// uses), tallying (a) recipe tag frequency for the "what this week leans toward" chips and
// (b) the SAME headline metrics/thresholds as Insights (planner.js:buildInsightCallouts /
// coverageGaps) so the wording never disagrees with the Insights screen:
//   fiber >= 25 g/day · sat fat <10% of energy · protein >= personal goal
// Nothing here is typed in — every number comes from recipeNutrition()/PROF[personKey].targetP.
const WEEK_SUMMARY_THRESHOLDS = {fiberMinPerDay: NUTRITION_GUIDANCE.fiber.target, satFatMaxEnergyShare: NUTRITION_GUIDANCE.satFat.target / 100};

function summarizeWeekPlan(plan, personKey){
  const tagCounts = {};
  const recipeIds = {};
  let fiberSum = 0, proteinSum = 0, kcalSum = 0, satFatSum = 0;
  const mealCount = plan.days.length * SLOT_ORDER.length;

  plan.days.forEach(function(day){
    SLOT_ORDER.forEach(function(slot){
      const entry = day.meals[slot][personKey];
      const r = RECIPES_DB[entry.recipeId];
      if(!r) return;
      recipeIds[entry.recipeId] = true;
      (r.tags || []).forEach(function(t){ tagCounts[t] = (tagCounts[t] || 0) + 1; });
      // Components-aware (base + extras), same reasoning as computeWeeklyCoverage above —
      // this headline must agree with what Today/Log actually counted for the person.
      const nut = planEntryNutrition(entry);
      fiberSum += nut.fiber; proteinSum += nut.protein; kcalSum += nut.kcal; satFatSum += nut.satFat;
    });
  });

  const days = plan.days.length || 7;
  const avgFiberPerDay = fiberSum / days;
  const avgProteinPerDay = proteinSum / days;
  const satFatEnergyShare = kcalSum > 0 ? satFatSum * 9 / kcalSum : 0;
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
      good: satFatEnergyShare < T.satFatMaxEnergyShare,
      text: 'sat. fat ≈' + Math.round(satFatEnergyShare * 100) + '% of energy'
    },
    {
      good: targetProtein > 0 && avgProteinPerDay >= targetProtein,
      text: 'protein on target — ' + Math.round(avgProteinPerDay) + 'g/day'
    },
  ];
  const metric = metricCandidates.find(function(m){ return m.good; })
    || {good: false, text: Math.round(avgFiberPerDay) + 'g fiber/day (goal ' + T.fiberMinPerDay + 'g)'};

  return {
    tags: topTags,
    metricText: metric.text,
    metricGood: metric.good,
    mealCount: mealCount,
    uniqueRecipeCount: Object.keys(recipeIds).length,
    avgFiberPerDay: avgFiberPerDay,
    avgProteinPerDay: avgProteinPerDay,
    satFatEnergyShare: satFatEnergyShare,
    targetProtein: targetProtein
  };
}

function enumerateSwapUnits(plan){
  const units = [];
  // Task B3 (solo households): canAutoMutateUnit only checks logged/pinned status, not
  // whether the unit's entry is a real recipe — without this guard, the weekly re-balance
  // solver (proposeRebalanceSuggestions) would happily swap a REAL recipe into the
  // (intentionally empty) partner cell of every non-shared slot, i.e. ghost-plan the
  // partner via re-balance. Two-person households: soloHousehold is always false, so this
  // is byte-identical to the pre-B3 behavior.
  const soloHousehold = isSoloHousehold();
  for(let d = 0; d < 7; d++){
    SLOT_ORDER.forEach(function(slot){
      const m = plan.days[d].meals[slot];
      if(m.shared){
        const sharedUnit = {dayIndex: d, slot: slot, shared: true};
        if(canAutoMutateUnit(plan, sharedUnit)) units.push(sharedUnit);
      }
      else {
        const elenaUnit = {dayIndex: d, slot: slot, shared: false, person: 'elena'};
        if(canAutoMutateUnit(plan, elenaUnit)) units.push(elenaUnit);
        if(!soloHousehold){
          const partnerUnit = {dayIndex: d, slot: slot, shared: false, person: 'partner'};
          if(canAutoMutateUnit(plan, partnerUnit)) units.push(partnerUnit);
        }
      }
    });
  }
  return units;
}

// The scalar the greedy search maximizes for a given worst-metric key (higher = better;
// sat-fat is negated since lower is better there).
function objectiveFor(metricKey, plan, fixedPerson){
  const cov = computeWeeklyCoverage(plan);
  if(metricKey === 'fiber') return cov.fiberAvgPerDay[fixedPerson];
  if(metricKey === 'satFat') return -cov.satFatShareOfKcal;
  if(metricKey === 'freeSugars') return -cov.freeSugarShareOfKcal;
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
  // PERSONAL-PREFS: this is a per-current-person re-balance action — a shared unit has no
  // unit.person, so fall back to currentProf (same "unit.person || currentProf" convention
  // already used elsewhere for a shared unit's active person, e.g. render.js/planner.js).
  const sidePool = sidePoolFor(avoidL, [unit.person || currentProf]).filter(function(id){
    return id !== currentEntry.recipeId && currentExtras.every(function(extra){ return !extra || extra.recipeId !== id; });
  });
  const results = [];
  sidePool.forEach(function(sideId){
    const trial = deepClone(plan);
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

// Same "never push a day out of its calorie band, and never leave it stuck out" rule
// sideCandidatesForUnit (above) already applies to its own single-metric what-if search —
// factored out so autoBalancePlan's fiber/free-sugars/sat-fat pass protects calories the
// identical way.
function calorieSafeForPeople(beforeDaily, afterDaily, people){
  return people.every(function(person){
    const beforeInBand = beforeDaily[person].inBand;
    const afterInBand = afterDaily[person].inBand;
    if(beforeInBand && !afterInBand) return false;
    if(!beforeInBand && !afterInBand) return false;
    return true;
  });
}

// Variety guard for autoBalancePlan's SWAP candidates: every main recipeId already planned
// for any of `unitPeople` on any OTHER (day, slot) this week — swapping in an id already
// used elsewhere would trade a fiber/sugar/sat-fat fix for a repeat the generator itself
// would never have produced.
function autoBalanceUsedMainIds(plan, unit, unitPeople){
  const used = {};
  plan.days.forEach(function(day, di){
    SLOT_ORDER.forEach(function(slot){
      if(di === unit.dayIndex && slot === unit.slot) return;
      const m = day.meals[slot];
      if(!m) return;
      unitPeople.forEach(function(person){
        const id = m.shared ? m.recipeId : (m[person] && m[person].recipeId);
        if(id) used[id] = true;
      });
    });
  });
  return used;
}

// applySwapToPlan/addSideToPlan stamp Date.now() onto the entry/cell they touch (the real
// swap-sheet's sync.js:mergePlansSection conflict marker) — exactly what a freshly
// generated plan must never carry. generateWeek is otherwise zero-Date.now/zero-
// Math.random by design (two independent calls with the same inputs must stay byte-
// identical regardless of wall-clock time — see testRecipeOptions' D2 determinism check),
// and autoBalancePlan runs entirely inside generation, before the plan is ever handed to a
// user, so it scrubs every stamp its own moves introduce right back off.
function autoBalanceStripStamps(plan, unit){
  const m = plan.days[unit.dayIndex].meals[unit.slot];
  delete m.t;
  if(m.elena) delete m.elena.t;
  if(m.partner) delete m.partner.t;
}

// Deterministic tie-break for autoBalancePlan's greedy step: the strictly-most-improving
// move wins outright; ties break by lowest unit index in enumerateSwapUnits() order, then
// 'addSide' before 'swap', then lowest candidate recipe id (string compare) — fixed order,
// no Math.random/Date.now, so the same plan always resolves the same way.
function autoBalanceCandidateBetter(a, b){
  if(a.improvement > b.improvement + 1e-9) return true;
  if(b.improvement > a.improvement + 1e-9) return false;
  if(a.unitIndex !== b.unitIndex) return a.unitIndex < b.unitIndex;
  if(a.kind !== b.kind) return a.kind === 'addSide';
  return a.candId < b.candId;
}

// dailyBandState()[dayIndex]'s exact per-day computation (dailyTotalsForPlan + calBand),
// scoped to a single day object instead of the whole plan — autoBalancePlan evaluates one
// day per candidate move, so recomputing all 7 days' band state (and, via dailyBandState's
// dailyTotalsForPlan, re-walking every OTHER day's nutrition) for every candidate would be
// wasted work. Numerically identical to dailyBandState(plan)[dayIndex] for that same day.
function autoBalanceDayBand(day){
  const totals = {
    elena: SLOT_ORDER.reduce(function(sum, slot){ return sum + planEntryNutrition(day.meals[slot].elena).kcal; }, 0),
    partner: SLOT_ORDER.reduce(function(sum, slot){ return sum + planEntryNutrition(day.meals[slot].partner).kcal; }, 0)
  };
  const state = {};
  ['elena', 'partner'].forEach(function(person){
    const band = calBand(PROF[person]);
    state[person] = {total: totals[person], min: band[0], max: band[1], inBand: totals[person] >= band[0] && totals[person] <= band[1]};
  });
  return state;
}

// data/validate.js's own per-slot kcal band, at the SAME +/-20% tolerance
// testComposedMeals (tools/check.js) holds every full AND composed pick to — reused here so
// autoBalancePlan can never accept a move that lands a unit outside the same tolerance the
// generator's own picks are already held to (applySwapToPlan re-portions to roughly track
// the old kcal, but addSideToPlan just appends a side's calories on top with no
// re-portioning, so this has to be checked explicitly rather than assumed).
const AUTO_BALANCE_KCAL_TOLERANCE = 0.20;
function autoBalanceSlotKcalSafe(unit, trialDay){
  const band = KCAL_BAND[unit.slot];
  if(!band) return true;
  const m = trialDay.meals[unit.slot];
  const entries = unit.shared ? [m.elena, m.partner] : [m[unit.person]];
  return entries.every(function(entry){
    if(!entry || !entry.recipeId) return true;
    const kcal = planEntryNutrition(entry).kcal;
    return kcal >= band[0] * (1 - AUTO_BALANCE_KCAL_TOLERANCE) && kcal <= band[1] * (1 + AUTO_BALANCE_KCAL_TOLERANCE);
  });
}

// Lunch/dinner's composition contract (mealStructureForRecipe's doc, above) only holds for
// the whole unit, not any candidate that merely fits the slot — candidatesFor()'s raw pool
// includes role:'side' ids (valid as an EXTRA, never as the main dish) alongside role:'main'/
// 'full' ids, and applySwapToPlan always carries the unit's existing extras over onto
// whatever id it swaps in. So a lunch/dinner SWAP has to stay within whichever shape the
// unit already is: a composed unit (extras present) may only swap its role:'main' dish
// (keeping the carb/veg extras that make it complete — mirrors pickSharedMeal/pickSoloMeal's
// own mainIds filter, above); a standalone unit (no extras) may only swap to another
// role:'full' complete recipe (mirrors their fullIds filter) — never to a bare main or side,
// which would leave the slot without its required protein/carb/veg composition.
function autoBalanceSwapCandidateIds(unit, rawIds, hasExtras){
  if(unit.slot !== 'lunch' && unit.slot !== 'dinner') return rawIds;
  return rawIds.filter(function(id){
    const r = RECIPES_DB[id];
    if(!r) return false;
    return hasExtras ? (r.role === 'main' && isProteinMain(id)) : (r.role === 'full' && isCompleteLunchDinnerRecipe(id));
  });
}

// Whole-week red/poultry/total lunch-dinner meat counts for one person, straight off the
// assembled plan — the generation-time equivalent (history[person].meatUse, built
// incrementally by recordDayUsage as picks are made) no longer exists once generateWeek has
// returned its picks, so autoBalancePlan re-derives the same counts from the finished plan.
function autoBalanceMeatCounts(plan, person){
  const counts = {red: 0, poultry: 0, total: 0};
  plan.days.forEach(function(day){
    ['lunch', 'dinner'].forEach(function(slot){
      const m = day.meals[slot];
      const entry = m && m[person];
      if(!entry || !entry.recipeId) return;
      const kind = entryProteinKind(entry);
      if(kind === 'red' || kind === 'poultry'){ counts[kind]++; counts.total++; }
    });
  });
  return counts;
}

// MEAT_WEEK_LIMITS (above) is a GENERATION-time rule (applyLunchDinnerMainRules), invisible
// to autoBalancePlan's post-generation moves unless re-checked explicitly — never REGRESS
// it: a move that would push any category from at-or-under its weekly cap to over, or push
// an already-over category even further over, is rejected; a move that holds steady or
// improves an already-over category is fine (never blocks the pass from making things
// better, only from making them worse). `meatBefore` is the per-person counts on the
// UNMUTATED plan at the start of this step (computed once, reused by every candidate).
function autoBalanceMeatSafe(unit, unitPeople, oldEntry, newEntry, meatBefore){
  if(unit.slot !== 'lunch' && unit.slot !== 'dinner') return true;
  const oldKind = entryProteinKind(oldEntry);
  const newKind = entryProteinKind(newEntry);
  if(oldKind === newKind) return true;
  return unitPeople.every(function(person){
    const before = meatBefore[person];
    let red = before.red, poultry = before.poultry, total = before.total;
    if(oldKind === 'red') red--; else if(oldKind === 'poultry') poultry--;
    if(oldKind === 'red' || oldKind === 'poultry') total--;
    if(newKind === 'red') red++; else if(newKind === 'poultry') poultry++;
    if(newKind === 'red' || newKind === 'poultry') total++;
    if(red > MEAT_WEEK_LIMITS.red && red > before.red) return false;
    if(poultry > MEAT_WEEK_LIMITS.poultry && poultry > before.poultry) return false;
    if(total > MEAT_WEEK_LIMITS.total && total > before.total) return false;
    return true;
  });
}

// Post-generation balancing pass — called once at the end of generateWeek, right before it
// returns. The generator already balances calories and protein per day, but fiber/free-
// sugars/sat-fat are only weekly-averaged, so an individual day can still land light or
// rich on them. This bounded, deterministic greedy search nudges those days back toward
// their bands using the exact same feasibility-checked swap/side machinery the manual
// re-balance features (proposeRebalanceSuggestions/proposeTodayRebalanceSuggestions, above)
// already use — just optimizing planImbalance (every tracked day x person) instead of a
// single worst weekly metric, and guarded so it can only ever help:
//   - every accepted move strictly lowers planImbalance (MAX_MOVES bounds the loop, so it
//     always terminates even if it never reaches exactly 0)
//   - every accepted move is calorie-safe (calorieSafeForPeople — never pushes a day's
//     calories out of band, never leaves one stuck out)
//   - every accepted move keeps the unit's combined kcal within the same slot-band
//     tolerance the generator's own picks are held to (autoBalanceSlotKcalSafe — addSideToPlan
//     in particular just appends a side's calories with no re-portioning of its own)
//   - a lunch/dinner unit's composition contract is preserved (autoBalanceSwapCandidateIds —
//     a composed unit only swaps its role:'main' dish, a standalone unit only swaps to
//     another role:'full' complete recipe; candidatesFor()'s raw pool includes role:'side'
//     ids that are only ever valid as an extra, never as the main dish)
//   - the household's weekly red/poultry/total meat caps never regress (autoBalanceMeatSafe —
//     MEAT_WEEK_LIMITS is otherwise a generation-time-only rule, invisible to a post-
//     generation swap)
//   - swap candidates respect a variety guard (autoBalanceUsedMainIds — never swap in an id
//     already used elsewhere this week for the affected person(s)) on top of the existing
//     avoid-list/diet filtering candidatesFor()/sidePoolFor() already do
// Fixed iteration order (enumerateSwapUnits' day-then-slot order, candidatesFor/sidePoolFor's
// sorted-id order) plus the deterministic tie-break above — no Math.random, no Date.now
// (autoBalanceStripStamps scrubs the stamps applySwapToPlan/addSideToPlan leave behind) — so
// calling generateWeek() twice with the same inputs stays byte-identical, same as before
// this pass existed.
function autoBalancePlan(plan){
  // Test-only escape hatch (MESA_TEST_TODAY, state.js, is the same convention): lets
  // tools/check.js capture the pre-pass plan generateWeek would otherwise have produced, to
  // compare against the real (pass-enabled) output — never set outside a test sandbox, so
  // production generation always runs the pass.
  if(typeof MESA_TEST_DISABLE_AUTO_BALANCE !== 'undefined' && MESA_TEST_DISABLE_AUTO_BALANCE) return plan;
  const people = isSoloHousehold() ? ['elena'] : ['elena', 'partner'];
  const styleKey = STYLE_DB_KEY[householdStyle] || 'balanced';
  const MAX_MOVES = 24;
  for(let step = 0; step < MAX_MOVES; step++){
    // Per-day imbalance, computed once per step — both the prune ("only consider units in
    // days currently contributing imbalance") and the O(1 day) delta every candidate below
    // is scored against (base - dayImb[unit.dayIndex] + <that day's trial imbalance>,
    // instead of re-walking all 7 days' nutrition per candidate).
    const dayImb = plan.days.map(function(day){
      return people.reduce(function(sum, person){ return sum + dayImbalanceForPerson(personDayNutriTotals(day, person), person); }, 0);
    });
    const base = dayImb.reduce(function(a, b){ return a + b; }, 0);
    if(base <= 1e-9) break;
    const dailyBefore = dailyBandState(plan);
    // Meat-cap counts, once per step (not per candidate) — same non-regression baseline
    // autoBalanceMeatSafe compares every lunch/dinner candidate's kind-delta against.
    const meatBefore = {elena: autoBalanceMeatCounts(plan, 'elena'), partner: autoBalanceMeatCounts(plan, 'partner')};
    const units = enumerateSwapUnits(plan);
    let best = null;
    units.forEach(function(unit, unitIndex){
      if(dayImb[unit.dayIndex] <= 1e-9) return;
      const unitPeople = unit.shared ? ['elena', 'partner'] : [unit.person];
      const avoidL = unit.shared ? unionAvoid(PROF.elena.avoid || [], PROF.partner.avoid || []) : (PROF[unit.person].avoid || []);
      const m = plan.days[unit.dayIndex].meals[unit.slot];
      const currentEntry = unit.shared ? m.elena : m[unit.person];
      const currentExtras = Array.isArray(currentEntry.extras) ? currentEntry.extras : [];
      const currentId = unit.shared ? m.recipeId : m[unit.person].recipeId;

      // Structural-sharing trial: clone only the ONE day this unit's move touches (every
      // other index keeps its original day reference) instead of deep-cloning the whole
      // 7-day plan per candidate — applySwapToPlan/addSideToPlan only ever mutate
      // trial.days[unit.dayIndex].meals[unit.slot], so this is exactly as isolated as a
      // full deepClone(plan) would be, just far cheaper across the many candidates tried
      // per unit.
      function consider(kind, candId, apply){
        const trialDay = deepClone(plan.days[unit.dayIndex]);
        const trial = {weekStartDate: plan.weekStartDate, days: plan.days.slice()};
        trial.days[unit.dayIndex] = trialDay;
        apply(trial);
        autoBalanceStripStamps(trial, unit);
        const newDayImb = people.reduce(function(sum, person){ return sum + dayImbalanceForPerson(personDayNutriTotals(trialDay, person), person); }, 0);
        const trialImbalance = base - dayImb[unit.dayIndex] + newDayImb;
        if(!(trialImbalance < base - 1e-9)) return;
        const dailyAfter = autoBalanceDayBand(trialDay);
        if(!calorieSafeForPeople(dailyBefore[unit.dayIndex], dailyAfter, unitPeople)) return;
        if(!autoBalanceSlotKcalSafe(unit, trialDay)) return;
        const newEntry = unit.shared ? trialDay.meals[unit.slot].elena : trialDay.meals[unit.slot][unit.person];
        if(!autoBalanceMeatSafe(unit, unitPeople, currentEntry, newEntry, meatBefore)) return;
        const candidate = {unitIndex: unitIndex, kind: kind, candId: candId, improvement: base - trialImbalance, trial: trial};
        if(!best || autoBalanceCandidateBetter(candidate, best)) best = candidate;
      }

      // (a) ADD SIDE — the same avoid/season-filtered role:'side' pool sideCandidatesForUnit
      // draws from, excluding whatever's already the main or an extra in this unit. ONLY on
      // lunch/dinner: those are the slots that compose a main with a role:'side' (the
      // generator's own contract). Breakfast composes only from the breakfastPair whitelist
      // and snack never composes, so adding a bare side there would produce an
      // ill-formed composed unit (the "composed meals" invariant in tools/check.js).
      if(unit.slot === 'lunch' || unit.slot === 'dinner'){
        sidePoolFor(avoidL, unitPeople).filter(function(id){
          return id !== currentEntry.recipeId && currentExtras.every(function(extra){ return !extra || extra.recipeId !== id; });
        }).forEach(function(sideId){
          consider('addSide', sideId, function(trial){ addSideToPlan(trial, unit, sideId); });
        });
      }

      // (b) SWAP — the same avoid/diet-filtered style pool candidatesFor() draws from,
      // narrowed to the unit's composition contract (autoBalanceSwapCandidateIds) and the
      // variety guard, excluding the current main.
      const usedElsewhere = autoBalanceUsedMainIds(plan, unit, unitPeople);
      const rawSwapIds = candidatesFor(unit.slot, styleKey, avoidL, unitPeople);
      autoBalanceSwapCandidateIds(unit, rawSwapIds, currentExtras.length > 0).filter(function(id){
        return id !== currentId && !usedElsewhere[id];
      }).forEach(function(candId){
        consider('swap', candId, function(trial){ applySwapToPlan(trial, unit, candId); });
      });
    });
    if(!best) break;
    plan.days = best.trial.days;
  }
  return plan;
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
  // PERSONAL-PREFS: per-current-person re-balance action (see sideCandidatesForUnit above
  // for the same unit.person||currentProf fallback a shared unit needs).
  const persons = [unit.person || currentProf];
  let pool = candidatesFor(unit.slot, styleKey, avoidL, persons).filter(function(id){ return id !== currentId && !plannedToday[id]; });
  if(!pool.length) pool = candidatesFor(unit.slot, styleKey, avoidL, persons).filter(function(id){ return id !== currentId; });
  return pool;
}

function todayRebalanceSideCandidateIds(plan, unit){
  const meal = plan.days[unit.dayIndex].meals[unit.slot];
  const currentEntry = unit.shared ? meal.elena : meal[unit.person];
  const currentExtras = Array.isArray(currentEntry.extras) ? currentEntry.extras : [];
  const avoidL = unit.shared ? unionAvoid(PROF.elena.avoid || [], PROF.partner.avoid || []) : (PROF[unit.person].avoid || []);
  return sidePoolFor(avoidL, [unit.person || currentProf]).filter(function(sideId){
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
  let planCopy = deepClone(plan);
  const applied = [];
  for(let round = 0; round < 2; round++){
    const baseTotals = todayRebalanceTotals(planCopy, dateISO);
    const candidates = [];
    enumerateTodayRebalanceUnits(planCopy, dateISO, personKey).forEach(function(unit){
      const people = todayRebalancePeopleForUnit(unit, personKey);
      const baseScore = todayRebalanceCombinedScore(baseTotals, people);
      todayRebalanceCandidateIds(planCopy, unit, dateISO).forEach(function(candId){
        const trial = deepClone(planCopy);
        applySwapToPlan(trial, unit, candId);
        const trialTotals = todayRebalanceTotals(trial, dateISO);
        if(!todayRebalancePeopleProtected(baseTotals, trialTotals, people)) return;
        const score = todayRebalanceCombinedScore(trialTotals, people);
        const improvement = baseScore - score;
        if(improvement <= 1e-9) return;
        candidates.push({kind: 'swap', unit: unit, candId: candId, fromRecipeId: todayRebalanceCurrentRecipeId(planCopy, unit), improvement: improvement, trial: trial});
      });
      todayRebalanceSideCandidateIds(planCopy, unit).forEach(function(sideId){
        const trial = deepClone(planCopy);
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
  const resultPlan = deepClone(plan);
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
  let planCopy = deepClone(plan);
  const applied = [];
  const fixedPerson = worst.person; // only meaningful for 'fiber'
  for(let round = 0; round < 2; round++){
    const baseObjective = objectiveFor(worstKey, planCopy, fixedPerson);
    const candidates = [];
    enumerateSwapUnits(planCopy).forEach(function(unit){
      const m = planCopy.days[unit.dayIndex].meals[unit.slot];
      const currentId = unit.shared ? m.recipeId : m[unit.person].recipeId;
      const avoidL = unit.shared ? unionAvoid(PROF.elena.avoid || [], PROF.partner.avoid || []) : (PROF[unit.person].avoid || []);
      const cands = candidatesFor(unit.slot, styleKey, avoidL, [unit.person || currentProf]).filter(function(id){ return id !== currentId; });
      cands.forEach(function(candId){
        const trial = deepClone(planCopy);
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
