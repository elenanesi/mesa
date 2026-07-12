/* ===================================================================
   state.js — Mesa app state
   Data & mutable state variables only: recipe/meal-plan/week data,
   profile data, shared-meal + logging state. No functions that write
   to the DOM or do the target-engine math live here (see engine.js,
   planner.js, render.js).

   Persistence (task A2): a single versioned localStorage store
   (STORE_KEY, `mesa.v1`) — see the block at the bottom of this file
   for loadState()/persist() and everything they read & write.
   =================================================================== */

/* ===================================================================
   recipe data — COMPATIBILITY VIEW (task C1)

   `RECIPES` used to be a hand-typed object with every nutrition number
   baked in. That violated the deterministic-numbers ground rule, so
   nutrition now lives in data/foods.js + data/recipes.js and is summed
   by engine.js:recipeNutrition(). This block instead builds a thin
   compatibility view — same keys, same shape every renderer already
   expects (title, emoji, kcal, protein, tags as legacy [class,label]
   pills, ingredients as legacy [name,qty,unit] rows, steps) — from
   RECIPES_DB so render.js/planner.js/app.js need no broader rewrite.
   "why" is deliberately NOT part of this compat view (task C3): it's
   per-PERSON (goals differ by profile), not per-recipe, so it can't be
   baked into a single shared RECIPES[id] object — see whyText(recipeId,
   profKey) above, called fresh by render.js wherever the why-box paints.

   Since task C2 the planner draws from the FULL RECIPES_DB, so every
   recipe in the DB gets a compatibility entry (the 10 original mockup
   ids among them, unchanged).

   RECIPES itself starts empty; buildLegacyRecipesCompat() (called once
   from app.js, after data/foods.js + data/recipes.js + engine.js have
   all loaded) fills it in. Every number inside is computed — nothing
   here is typed in.
   =================================================================== */
const RECIPES = {};
const LEGACY_RECIPE_IDS = ['yogurt', 'omelette', 'lentil', 'salmon', 'skyrbowl', 'eggsturkey', 'chickenfarro', 'chiapudding', 'tunasalad', 'salmongreens'];
// Task C2: the planner picks from the FULL RECIPES_DB (32-36 recipes), not just the 10
// legacy ids, so every recipe needs a compat entry — buildLegacyRecipesCompat() below
// now loops over every RECIPES_DB id. LEGACY_RECIPE_IDS + LEGACY_WHY are kept only for
// their special-cased hand-written "why" copy on the 10 original mockup recipes.

// The mockup's hand-written "why this fits you" copy, kept verbatim per recipe id so
// nothing user-visible degrades for the 10 legacy recipes (task C3 replaces this with
// template text generated from tags × goals for the full RECIPES_DB).
const LEGACY_WHY = {
  yogurt: 'Greek yogurt brings casein and whey protein plus gut-friendly probiotics; berries add skin-supporting antioxidants at a low glycemic load. Naturally low in iodine — an easy fit alongside a Hashimoto\'s-aware day. <i>General guidance, not medical advice.</i>',
  omelette: 'Eggs bring complete protein plus choline and selenium; rye toast adds fiber and slow-release carbs to start Andrea\'s day with steady energy for training. <i>General guidance, not medical advice.</i>',
  lentil: 'Lentils bring plant-based iron, B-vitamins and slow-release carbs; roasted veg add fiber and polyphenols, while a little feta gives calcium without loading up on dairy. A heart-smart, high-fiber midday reset. <i>General guidance, not medical advice.</i>',
  salmon: 'Salmon delivers omega-3 and vitamin D for skin and thyroid; quinoa is a gluten-free, lower-GI carb; leafy greens add iron + folate. Iodine stays moderate — good for Hashimoto\'s balance. <i>General guidance, not medical advice.</i>',
  skyrbowl: 'Skyr packs even more protein than Greek yogurt for barely any fat; mixed seeds add omega-3 and a little crunch. Naturally low in iodine — an easy fit for a higher-protein, thyroid-aware morning. <i>General guidance, not medical advice.</i>',
  eggsturkey: 'Eggs and lean turkey stack complete protein to fuel training; rye brings fiber and slow-release carbs. A higher-protein spin on Andrea\'s usual morning. <i>General guidance, not medical advice.</i>',
  chickenfarro: 'Grilled chicken breast is a lean, high-protein anchor; farro adds fiber and a nutty bite with a lower glycemic load than white grains. A satisfying, muscle-supporting midday reset. <i>General guidance, not medical advice.</i>',
  chiapudding: 'Chia seeds soak up coconut milk into a creamy, low-carb pudding rich in omega-3 and fiber; berries keep it low-GI and skin-supporting. A gentle, thyroid-friendly start with steady energy. <i>General guidance, not medical advice.</i>',
  tunasalad: 'Tuna is lean, high-protein and rich in omega-3; avocado swaps in healthy fat for starchy carbs, keeping this lunch low-carb without losing staying power. Heart-smart with moderate iodine — Hashimoto\'s-friendly. <i>General guidance, not medical advice.</i>',
  salmongreens: 'Same salmon, same omega-3 and selenium — just without the quinoa, so carbs stay low while protein and healthy fat carry the meal. Iodine stays moderate for Hashimoto\'s balance. <i>General guidance, not medical advice.</i>'
};

/* ===================================================================
   whyText() — task C3: deterministic "why this fits you" generator

   Replaces the LEGACY_WHY-only mechanism for the ~26 non-legacy recipes.
   Where LEGACY_WHY has hand-written copy, whyText() returns it verbatim
   (it's better prose than a template can produce and the plan says to
   keep it). For everything else it assembles 2-3 sentences from the
   recipe's tags (RECIPES_DB) and its ingredients' FOODS flags, crossed
   with the person's ACTIVE goals (hashi/skin/muscle/heart — derived
   from PROF, not typed in per recipe), always ending with the existing
   guidance line. Never invents a number — the one quantity it can cite
   (protein grams for the muscle clause) comes straight from
   recipeNutrition(), same as every other displayed nutrition number.

   Priority order (WHY_RULES below) is chosen so the person's most
   DISTINCTIVE goals surface first: thyroid + skin only ever apply to
   Elena (hashi flag / skin is one of her defaults), so for her they
   out-rank muscle/heart; for Andrea (no hashi, no skin goal) those two
   rules never match, so muscle (his surplus goal) naturally leads.
   =================================================================== */
function recipeFlagSet(recipeId){
  const r = RECIPES_DB[recipeId];
  const set = {};
  if(!r) return set;
  (r.ingredients || []).forEach(function(ing){
    const food = FOODS[ing[0]];
    (food && food.flags || []).forEach(function(f){ set[f] = true; });
  });
  return set;
}
function hasTag(recipe, tag){ return recipe.tags.indexOf(tag) !== -1; }

// Each rule contributes at most one clause, keyed by `goal` so a recipe never mentions
// the same goal twice. `clause` returns a lowercase sentence fragment (no leading capital,
// no trailing period) — whyText() handles capitalization/punctuation so every clause reads
// naturally whether it lands first (after an em dash) or later (as its own sentence).
const WHY_RULES = [
  {
    goal: 'thyroid',
    applies: function(profKey){ return !!PROF[profKey].hashi; },
    matches: function(recipe, flags){ return hasTag(recipe, 'thyroid') || flags.selenium; },
    clause: function(recipe, flags){
      return flags.selenium
        ? 'selenium here supports your thyroid focus'
        : 'this stays gentle on iodine, in line with your Hashimoto’s-aware plan';
    }
  },
  {
    goal: 'skin',
    applies: function(profKey){ return profKey === 'elena'; },
    matches: function(recipe, flags){ return hasTag(recipe, 'skin') || flags.omega3 || hasTag(recipe, 'lowGI'); },
    clause: function(recipe, flags){
      return flags.omega3
        ? 'omega-3 here supports your skin goal'
        : 'the low glycemic load here is kind to your skin goal';
    }
  },
  {
    goal: 'muscle',
    applies: function(){ return true; },
    matches: function(recipe){ return hasTag(recipe, 'muscle'); },
    clause: function(recipe, flags, profKey, proteinG){
      return profKey === 'partner'
        ? proteinG + 'g of protein backs your muscle-gain surplus'
        : proteinG + 'g of protein supports your muscle & protein goal';
    }
  },
  {
    goal: 'heart',
    applies: function(){ return true; },
    matches: function(recipe, flags){ return hasTag(recipe, 'heart') || hasTag(recipe, 'highFiber') || flags.highFiber; },
    clause: function(recipe, flags){
      return (hasTag(recipe, 'highFiber') || flags.highFiber)
        ? 'the fiber here makes it a heart-smart pick'
        : 'this is a heart-smart choice for your Mediterranean base';
    }
  },
  {
    goal: 'veggie',
    applies: function(){ return true; },
    matches: function(recipe){ return hasTag(recipe, 'veggie'); },
    clause: function(){ return 'it’s plant-forward and easy on digestion'; }
  }
];

const WHY_GUIDANCE = '<i>General guidance, not medical advice.</i>';

function whyText(recipeId, profKey){
  if(LEGACY_WHY[recipeId]) return LEGACY_WHY[recipeId];
  const recipe = RECIPES_DB[recipeId];
  if(!recipe){ console.error('whyText: unknown recipe id "' + recipeId + '"'); return WHY_GUIDANCE; }
  if(!PROF[profKey]){ console.error('whyText: unknown profile key "' + profKey + '"'); profKey = 'elena'; }

  const flags = recipeFlagSet(recipeId);
  const proteinG = Math.round(recipeNutrition(recipeId, 1).totals.protein);

  const seenGoals = {};
  const clauses = [];
  WHY_RULES.forEach(function(rule){
    if(clauses.length >= 3 || seenGoals[rule.goal]) return;
    if(!rule.applies(profKey)) return;
    if(!rule.matches(recipe, flags)) return;
    seenGoals[rule.goal] = true;
    clauses.push(rule.clause(recipe, flags, profKey, proteinG));
  });

  let body;
  if(!clauses.length){
    body = capitalizeFirst(recipe.title) + ' is a simple, Mediterranean-style ' + recipe.slot + ' that fits your plan.';
  } else {
    body = capitalizeFirst(recipe.title) + ' — ' + clauses[0] + '.';
    if(clauses.length > 1) body += ' ' + capitalizeFirst(clauses.slice(1).join('; ')) + '.';
  }
  return body + ' ' + WHY_GUIDANCE;
}

// Small tag→pill map: RECIPES_DB.tags (data/recipes.js VALID_TAGS) to the legacy
// [pillClass, label] shape render.js already knows how to paint. Deliberately not a
// 1:1 reproduction of every hand-picked legacy pill (some of those were per-recipe
// micronutrient flourishes like "Iron + B12" or "Selenium" that have no equivalent in
// RECIPES_DB's tag vocabulary) — a systematic, generic mapping instead.
const TAG_PILL_MAP = {
  thyroid: ['berry', 'Thyroid-friendly'],
  skin: ['berry', 'Skin-supporting'],
  heart: ['', 'Heart-smart'],
  muscle: ['terra', 'High protein'],
  lowGI: ['', 'Low-GI'],
  omega3: ['', 'Omega-3'],
  highFiber: ['', 'High fiber'],
  quick: ['', 'Quick'],
  veggie: ['', 'Plant-based']
};

function capitalizeFirst(s){ return s.charAt(0).toUpperCase() + s.slice(1); }

// Builds RECIPES[id] for every id in LEGACY_RECIPE_IDS from RECIPES_DB + FOODS +
// recipeNutrition() (engine.js). Called once from app.js's boot sequence, after
// data/foods.js, data/recipes.js and engine.js have all loaded. Every number here is
// computed, never typed in (ground rule #1) — the one exception is TAG_PILL_MAP (a label
// lookup, not a number). "why" copy is NOT built here — see whyText() above.
function buildLegacyRecipesCompat(){
  Object.keys(RECIPES_DB).forEach(function(id){
    const src = (typeof RECIPES_DB !== 'undefined') ? RECIPES_DB[id] : undefined;
    if(!src){ console.error('buildLegacyRecipesCompat: "' + id + '" not found in RECIPES_DB'); return; }

    const base = recipeNutrition(id, 1).totals; // "the recipe as written" = 1 legacy serving

    const ingredients = src.ingredients.map(function(ing){
      const foodId = ing[0], grams = ing[1];
      const food = FOODS[foodId];
      if(!food){ console.error('buildLegacyRecipesCompat: "' + id + '" ingredient food id "' + foodId + '" not found in FOODS'); return [foodId, grams, 'g']; }
      if(food.unit === 'piece') return [food.name, +(grams / food.avgG).toFixed(2), ''];
      return [food.name, grams, food.unit];
    });
    (src.toTaste || []).forEach(function(t){ ingredients.push([capitalizeFirst(t), null, 'to taste']); });

    RECIPES[id] = {
      emoji: src.emoji,
      title: src.title,
      time: src.time + ' min',
      kcal: Math.round(base.kcal),
      protein: Math.round(base.protein),
      tags: src.tags.map(function(t){ return TAG_PILL_MAP[t] || ['', t]; }),
      ingredients: ingredients,
      method: src.steps
    };
  });
}

/* meal-slot lookup for shared-meals logic — RECIPE_SLOT_DB (data/recipes.js) already
   covers every id in RECIPES_DB (the 10 legacy ids plus everything added in B2), so it
   is the single source of truth here; nothing app-specific needs to be re-listed. */
function isShared(key){ return !!SHARED[RECIPE_SLOT_DB[key]]; }

/* ---------------- household plan style (task C2) ----------------
   householdStyle drives which recipes the planner (js/planner.js) considers: it's
   derived from the current profile's macro split (see planner.js:styleOf) and mapped to
   a RECIPES_DB style tag via planner.js:STYLE_DB_KEY ('protein' -> 'highprotein', the
   other two keys are spelled the same). MEALPLANS (a hand-typed 3-style x 4-slot table)
   and the static WEEK/7-day array are gone: js/planner.js:generateWeek() now picks real
   recipes from RECIPES_DB for every day x slot x person, respecting avoid-lists, style,
   calorie/protein targets and variety — see planner.js for the algorithm. The generated
   result lives in `weekPlan` (below), not in a static table. */
const HOUSEHOLD_STYLES = ['balanced', 'protein', 'lowcarb'];
let householdStyle = 'balanced';
let activeMenu = null;

/* ---------------- the week plan (task C2) ----------------
   Source of truth for every meal both people eat this week. Built by
   js/planner.js:generateWeek(), kept fresh by js/planner.js:ensureWeekPlan() (regenerates
   on style/avoid-list/calorie-target changes or when the stored week is from a previous
   week), and read by renderWeek/renderTodayMeals/renderLogPlan/computeShoppingList
   (rendering) and buildRebalanceSheet/applyRebalance (nutrient-coverage solver).

   Shape: { v:1, weekStartDate:'YYYY-MM-DD' (the Monday this week starts), signature
   (opaque string capturing the inputs that should trigger a regen), days: [ {date,
   meals:{breakfast,lunch,dinner,snack}}, ...7 ] }. Each `meals[slot]` is either
   {shared:true, recipeId, elena:{recipeId,portion,kcal,protein}, partner:{...}} (one
   dish, two portions) or {shared:false, elena:{recipeId,portion,kcal,protein},
   partner:{...}} (two different dishes). portion is the same "servings" unit
   engine.js:recipeNutrition() scales ingredients by (1 = the recipe as written in
   RECIPES_DB); kcal/protein are that recipe at that portion, already computed — never
   re-derived from a static table. null until ensureWeekPlan() first runs (app.js boot). */
let weekPlan = null;

let recipeOrigin = 'today';
let currentRecipeKey = 'salmon';
let svE = 1, svM = 1.5, svS = 1;

/* ---------------- log / plan-first state ---------------- */
// Keyed by slot name (breakfast/lunch/dinner/snack), not recipe key — rebuilt by
// renderLogPlan() each time the active menu (profile or split) changes. Card display
// only (title/emoji/kcal shown before a slot is confirmed) — the source of truth for
// what's actually logged is logHistory (state.js), not these.
const EMOJI = {};
const TITLES = {};
const LOGKCAL = {};

/* ---------------- shared-meals model ---------------- */
const SHARED = {breakfast:false, lunch:false, dinner:true, snack:false};
const SLOT_LABEL = {breakfast:'Breakfast', lunch:'Lunch', dinner:'Dinner', snack:'Snack'};

/* ---------------- profile data ---------------- */
// Body stats are the source of truth; age, BMR, maintenance and the recommended daily
// target are all derived from them (Mifflin-St Jeor × activity + goalAdj, rounded to 10).
// goalAdj is each person's goal offset from maintenance: Elena −325 (gentle deficit),
// Andrea +60 (small muscle-gain surplus) — chosen so current stats land exactly on the
// familiar 1,820 / 2,480 defaults. calCustom is null while following the recommendation.
// avoid: per-person allergen/dislike keys (subset of AVOID_KEYS below, itself a mirror of
// data/recipes.js's documented avoid vocabulary), read by the planner's hard avoid-list
// filter (task C2 rule (a)) AND now editable from the Profile screen's real "Foods to
// avoid" editor (task C3) — see AVOID_KEYS/avoidLabel() + render.js:renderAvoidEditor().
// Elena's defaults match the pills already in the Profile screen mockup; Andrea has none.
let currentProf = 'elena';

// The supported avoid keys (task C3): free-text isn't in MVP scope, so the editor is a
// closed picker over exactly these — the same keys recipes.js's `avoid` arrays carry.
const AVOID_KEYS = ['lactose', 'gluten', 'shellfish', 'nuts', 'raw-onion', 'spicy'];
const AVOID_LABELS = {lactose: 'Lactose', gluten: 'Gluten', shellfish: 'Shellfish', nuts: 'Nuts', 'raw-onion': 'Raw onion', spicy: 'Spicy'};
function avoidLabel(key){ return AVOID_LABELS[key] || capitalizeFirst(key); }
const PROF = {
  elena:   {seg:'Elena', av:'E',
            sex:'female', dobY:1997, dobM:5, heightCm:168, weightKg:64,
            activity:1.55, goalAdj:-325, goalName:'gentle fat loss',
            calCustom:null, calNote:'',
            goalTag:'🎯 Gentle fat loss · 🦋 Hashimoto',
            coachT:'Today leans thyroid-friendly 🦋', hashi:true,
            coachD:'Brazil nuts + salmon cover your selenium and omega-3. Iodine kept moderate, gluten-light. Tap any meal to see why it fits.',
            kP:26, kC:41, kF:33, avoid:['lactose','raw-onion','spicy'],
            // consumed*/consumedKcal start at zero (task D1): they're overwritten by
            // planner.js:recomputeConsumed() from real logHistory entries before first
            // paint (applyProf() at boot always runs it first) — no demo numbers linger.
            consumedKcal:0, consumed:{p:0,c:0,f:0,satFat:0,fiber:0}, defaultSplit:{P:26,C:41,F:33}, splitNote:'', coachOverrideT:null, coachOverrideD:null},
  partner: {seg:'Andrea', av:'A',
            sex:'male', dobY:1995, dobM:3, heightCm:181, weightKg:78,
            activity:1.375, goalAdj:60, goalName:'small muscle-gain surplus',
            calCustom:null, calNote:'',
            goalTag:'🎯 Muscle gain · ❤️ Heart-smart',
            coachT:'Today is built for muscle 💪', hashi:false,
            coachD:'Higher protein and a small surplus. Same Mediterranean base as Elena, scaled up — shared cooking, two targets.',
            kP:26, kC:43, kF:31, avoid:[],
            consumedKcal:0, consumed:{p:0,c:0,f:0,satFat:0,fiber:0}, defaultSplit:{P:26,C:43,F:31}, splitNote:'', coachOverrideT:null, coachOverrideD:null}
};

/* ===================================================================
   persistence (task A2) — one versioned localStorage store.

   Derived values (age, BMR, recommended calories, macro grams, computed
   menus, shopping totals) are NEVER stored here — they recompute at
   boot from the inputs below (deterministic-numbers rule). Only
   user-editable inputs and selection state are persisted:
     - both PROF entries' editable fields (not goalAdj — that's a fixed
       per-person constant, not user-editable), including each person's
       avoid-list (task C2)
     - SHARED slot toggles, svE/svM/svS servings, householdStyle,
       currentProf
     - the generated weekPlan (task C2) — the plan itself IS persisted
       (unlike other derived values) since regenerating it is a real
       computation, not a formatting step; js/planner.js:ensureWeekPlan()
       re-validates it against the live state on every load and
       regenerates when the inputs that produced it have changed
     - checked shopping-list items, keyed by ingredient NAME (ids are
       positional and change whenever the list recomputes)
     - logHistory (task D1): the rolling log of what was actually eaten,
       keyed by ISO date — see the "log history" block below for the
       full shape. Replaces the old v1 single-day `log` field (migrated
       on load, see loadState()).
     - the onboarding-seen flag (migrated from the old standalone
       `mesaOnboarded` key; that key is still read as a fallback for
       installs that predate this store)

   loadState() runs once at boot, before the first render. persist()
   is the single write-through call, invoked from the end of every
   mutating action (see render.js: applyProf, toggleShared, adjServe,
   toggleShop, logConfirm/logSkip, confirmQuickAdd).
   =================================================================== */
const STORE_KEY = 'mesa.v1';
const LEGACY_ONBOARD_KEY = 'mesaOnboarded';
// Task F2 (export/import): the schema version buildSnapshot() writes and loadState() /
// the import validator (render.js:validateBackupStructure) accept. Bump alongside any
// future schema change (same version this store's `v` field already carried since D1).
// v3 (feedback FIX 1): breakfast is no longer auto-logged — see
// migrateRemoveAutoBreakfast() below for the one-time v2->v3 migration this bump gates.
const CURRENT_STORE_VERSION = 3;

let onboarded = false;
let checkedShopNames = {};   // ingredient name -> true, for shopping-list checks

/* ---------------- user content library (post-MVP: ingredients + recipes) ----------------
   customFoods: id 'cf-<slug>' -> food object, same shape as a data/foods.js FOODS entry
   (per, unit, kcal, protein, carbs, fat, satFat, fiber, flags, cat, src). Merged into the
   global FOODS object at boot and after every add/delete via js/library.js:applyCustomFoods().
   customRecipes: id 'cr-<slug>' -> recipe object, same shape as a data/recipes.js
   RECIPES_DB entry (title, emoji, slot, styles, time, ingredients, toTaste, steps, tags,
   avoid) — nutrition is NEVER stored (ground rule 1); tags/styles/avoid are AUTO-DERIVED
   from ingredients at save time (js/library.js:deriveRecipeMeta()). Merged into RECIPES_DB
   the same way via applyCustomRecipes(), which also rebuilds the RECIPES compat view.
   customRev: monotonic counter, bumped on every library mutation (add/delete a food or
   recipe) — folded into the week-plan signature (planner.js:computePlanSignature()) so a
   library change deterministically regenerates the week. */
let customFoods = {};
let customRecipes = {};
let customRev = 0;

function todayISO(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* ===================================================================
   log history (task D1) — replaces the old v1 single-day `todayLog`.

   logHistory['YYYY-MM-DD'] = {
     elena:   [LogEntry, ...],
     partner: [LogEntry, ...],
     targets: {elena: kcalNum|null, partner: kcalNum|null},  // each person's daily kcal
       TARGET, frozen the first time THAT PERSON logs anything on this date (item 4a: a
       later calorie-target change must never move a past day's 7-day bar). null until
       then; computeInsights() (planner.js) falls back to the live target only for the
       rare pre-D1 migrated day that has no snapshot (see migrateV1TodayLog() below).
     skipped: {elena: {slot: true}, partner: {slot: true}}   // UI memory only — "you
       tapped Skip for this slot today" — never summed into nutrition, just lets the Log
       screen restore the skipped-tag across a reload (state, not a fact about food).
   }

   LogEntry = {kind:'plan'|'food', ref: recipeId|foodId, portion?, grams?, kcal, protein,
     carbs, fat, satFat, fiber, slot?, t:'HH:MM'|null}. Every macro number is computed
   ONCE, at log time, via recipeNutrition()/foodMacros() (engine.js) and stored verbatim —
   never re-derived from the live recipe/food DB on a later read, so editing a recipe or
   swapping a plan meal never rewrites a past day's history (ground rule 1 + task D1's
   explicit "history stability" requirement). kind:'plan' entries are keyed by `slot`
   (breakfast/lunch/dinner/snack) — upsertLogEntry() replaces-in-place on that key, so a
   swap on an already-logged slot corrects it rather than appending a duplicate. kind:'food'
   (quick-add) entries always append.

   Capped at LOG_HISTORY_RETENTION_DAYS days (pruned on every persist()) so the store
   never grows unbounded.
   =================================================================== */
const LOG_HISTORY_RETENTION_DAYS = 60;
let logHistory = {};

function nowHHMM(){
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function emptyDayLog(){
  return {elena: [], partner: [], targets: {elena: null, partner: null}, skipped: {elena: {}, partner: {}}};
}

// Returns logHistory[dateISO], creating (and back-filling any missing sub-keys on) an
// empty day record on first touch — every caller can read/push without a null-check dance.
function getDayLog(dateISO){
  if(!logHistory[dateISO]) logHistory[dateISO] = emptyDayLog();
  const day = logHistory[dateISO];
  if(!day.targets) day.targets = {elena: null, partner: null};
  if(!day.skipped) day.skipped = {elena: {}, partner: {}};
  if(!Array.isArray(day.elena)) day.elena = [];
  if(!Array.isArray(day.partner)) day.partner = [];
  return day;
}

// Freezes personKey's kcal TARGET for dateISO the first time they log anything that day
// (task D1 item 4a). Callers must ensure PROF[personKey].calGoalNum is current first —
// every live call site runs after ensureWeekPlan()/recomputeProf() have already refreshed
// it (see planner.js:ensureWeekPlan, applyProf), so this is always the true target at the
// moment of logging, not a stale one.
function ensureTargetSnapshot(dateISO, personKey){
  const day = getDayLog(dateISO);
  if(typeof day.targets[personKey] !== 'number') day.targets[personKey] = PROF[personKey].calGoalNum;
  return day;
}

// Adds one computed LogEntry, freezing the day's target snapshot first. kind:'plan'
// entries replace any existing entry for the same slot (a swap corrects history rather
// than duplicating it); kind:'food' entries always append. persist() is the caller's job
// (same convention as every other mutating action in render.js/planner.js).
function upsertLogEntry(dateISO, personKey, entry){
  ensureTargetSnapshot(dateISO, personKey);
  const arr = getDayLog(dateISO)[personKey];
  if(entry.kind === 'plan' && entry.slot){
    const idx = arr.findIndex(function(e){ return e.kind === 'plan' && e.slot === entry.slot; });
    if(idx !== -1){
      entry.t = arr[idx].t || entry.t; // keep the original log time on an edit (e.g. a post-confirm swap)
      arr[idx] = entry;
      return entry;
    }
  }
  arr.push(entry);
  return entry;
}

// Builds + upserts a plan-kind LogEntry from a recipe id + portion, computing every macro
// fresh via recipeNutrition() (engine.js). Used by logConfirm (first confirm — breakfast
// included, see FIX 1: breakfast is a normal meal with its own Confirm/Swap/Skip, no more
// auto-log), by chooseSwap (editing an already-logged slot), and by restoreTodayLog's
// replay guard.
function logPlanEntry(dateISO, personKey, slot, recipeId, portion){
  const nut = recipeNutrition(recipeId, portion).totals;
  return upsertLogEntry(dateISO, personKey, {
    kind: 'plan', ref: recipeId, portion: portion,
    kcal: Math.round(nut.kcal), protein: Math.round(nut.protein), carbs: Math.round(nut.carbs),
    fat: Math.round(nut.fat), satFat: Math.round(nut.satFat), fiber: Math.round(nut.fiber),
    slot: slot, t: nowHHMM()
  });
}

// Quick-add (task D1 item 2): a food-kind LogEntry from FOODS, computed via foodMacros().
function logFoodEntry(dateISO, personKey, foodId, grams){
  const nut = foodMacros(foodId, grams);
  return upsertLogEntry(dateISO, personKey, {
    kind: 'food', ref: foodId, grams: grams,
    kcal: Math.round(nut.kcal), protein: Math.round(nut.protein), carbs: Math.round(nut.carbs),
    fat: Math.round(nut.fat), satFat: Math.round(nut.satFat), fiber: Math.round(nut.fiber),
    t: nowHHMM()
  });
}

// Skip = "not eaten", not a nutrition fact — recorded only so the Log screen can restore
// the skipped-tag across a reload. Also drops any plan entry that might exist for that
// slot (shouldn't normally happen, but keeps the two states mutually exclusive).
function markSlotSkipped(dateISO, personKey, slot){
  const day = getDayLog(dateISO);
  day.skipped[personKey][slot] = true;
  day[personKey] = day[personKey].filter(function(e){ return !(e.kind === 'plan' && e.slot === slot); });
}

// FIX 2 (feedback) — undo paths. Removing a slot's plan entry (and clearing any skipped
// flag) sends slotLogStatus() back to null, which is exactly what restores the card's
// Confirm/Swap/Skip actions on the next renderLogPlan(). Pure logHistory mutations:
// every surface (Today ring/macros, Log pill, "Today so far", Insights) re-derives from
// logHistory, so callers just re-render + persist() afterwards (same convention as every
// other mutator in this file).
function removeLoggedSlot(dateISO, personKey, slot){
  const day = getDayLog(dateISO);
  day[personKey] = day[personKey].filter(function(e){ return !(e.kind === 'plan' && e.slot === slot); });
  delete day.skipped[personKey][slot];
}

// Removes ONE specific entry by its index in the day's per-person array — the "Today so
// far" ✕ (quick-added foods AND confirmed plan meals alike). Returns the removed entry
// (or null) so the caller can toast and, for a plan entry, restore the matching Log
// card's actions.
function removeLogEntryAt(dateISO, personKey, index){
  const arr = getDayLog(dateISO)[personKey];
  if(!(index >= 0 && index < arr.length)) return null;
  return arr.splice(index, 1)[0];
}

// 'confirmed' | 'skipped' | null — drives the Log screen's per-slot restore (app.js:
// restoreTodayLog) and lets chooseSwap (planner.js) know whether a swapped slot needs its
// log entry corrected in place.
function slotLogStatus(dateISO, personKey, slot){
  const day = getDayLog(dateISO);
  if(day[personKey].some(function(e){ return e.kind === 'plan' && e.slot === slot; })) return 'confirmed';
  if(day.skipped[personKey][slot]) return 'skipped';
  return null;
}

// Drops days older than LOG_HISTORY_RETENTION_DAYS (relative to today) — called from
// persist() so the store never grows unbounded. String comparison is safe: ISO dates
// sort lexicographically.
function pruneLogHistory(){
  const cutoff = addDaysISO(todayISO(), -LOG_HISTORY_RETENTION_DAYS);
  Object.keys(logHistory).forEach(function(date){
    if(date < cutoff) delete logHistory[date];
  });
}

function isValidLogEntry(e){
  if(!e || typeof e !== 'object') return false;
  if(e.kind !== 'plan' && e.kind !== 'food') return false;
  if(typeof e.ref !== 'string') return false;
  return ['kcal', 'protein', 'carbs', 'fat', 'satFat', 'fiber'].every(function(k){ return typeof e[k] === 'number' && isFinite(e[k]); });
}

// v1 -> v2 migration: v1 stored only TODAY's plan-first confirm/skip status, un-keyed by
// person (a known v1 gap — Log actions applied to whichever profile happened to be active
// when tapped). loadState() only ever kept a v1 `log` whose date === today (older ones
// were discarded outright), so there's at most one day to migrate. Rather than trust v1's
// display-only {title, kcal} strings (no recipeId, no full macro breakdown), this recovers
// the real recipeId + portion from the ALSO-persisted v1 weekPlan and recomputes full
// macros via recipeNutrition() — so migrated entries are exactly as trustworthy as any
// entry logged under v2. Attributed to v1's saved currentProf (the best available guess
// for "whose log this was"). No-ops entirely once a v2 `logHistory` is present.
function migrateV1TodayLog(saved){
  if(saved.logHistory && typeof saved.logHistory === 'object') return;
  if(!(saved.log && typeof saved.log === 'object' && saved.log.date === todayISO() && saved.log.slots && typeof saved.log.slots === 'object')) return;
  const person = (typeof saved.currentProf === 'string' && PROF[saved.currentProf]) ? saved.currentProf : 'elena';
  const wp = (saved.weekPlan && typeof saved.weekPlan === 'object' && typeof saved.weekPlan.weekStartDate === 'string' && Array.isArray(saved.weekPlan.days)) ? saved.weekPlan : null;
  Object.keys(saved.log.slots).forEach(function(slot){
    const rec = saved.log.slots[slot];
    if(!rec || slot === 'breakfast') return; // breakfast had no v1 record (it was auto-logged pre-FIX-1, never persisted as a v1 slot)
    if(rec.status === 'confirmed' && wp){
      const dayIdx = Math.max(0, Math.min(6, diffDaysISO(todayISO(), wp.weekStartDate)));
      const day = wp.days[dayIdx];
      const planEntry = day && day.meals && day.meals[slot] && day.meals[slot][person];
      if(planEntry && planEntry.recipeId){
        const nut = recipeNutrition(planEntry.recipeId, planEntry.portion).totals;
        getDayLog(todayISO())[person].push({
          kind: 'plan', ref: planEntry.recipeId, portion: planEntry.portion,
          kcal: Math.round(nut.kcal), protein: Math.round(nut.protein), carbs: Math.round(nut.carbs),
          fat: Math.round(nut.fat), satFat: Math.round(nut.satFat), fiber: Math.round(nut.fiber),
          slot: slot, t: null
        });
      }
    } else if(rec.status === 'skipped'){
      markSlotSkipped(todayISO(), person, slot);
    }
  });
}

// v2 -> v3 migration (feedback FIX 1): breakfast used to be auto-logged the moment its
// plan slot was known (planner.js's now-removed ensureTodayBreakfastLogged()), so a store
// saved by an older build may contain TODAY's breakfast plan-entry even though the user
// never tapped Confirm. LogEntry (see the shape doc above) records no auto-vs-manual flag
// — there's nothing in the stored shape that distinguishes a real confirm from the old
// auto-log — so as a one-time migration (gated on the stored version being < 3, so this
// never re-fires on a later load) we drop TODAY's breakfast plan-entry for both people.
// A genuinely confirmed breakfast today is the rare case (this only matters on the exact
// day the app updates) and is one tap to re-confirm; every other day's history, and every
// other slot, is untouched.
function migrateRemoveAutoBreakfast(saved){
  const fromVersion = (typeof saved.v === 'number' && isFinite(saved.v)) ? saved.v : 0;
  if(fromVersion >= 3) return;
  if(!saved.logHistory || typeof saved.logHistory !== 'object') return;
  const today = todayISO();
  const day = saved.logHistory[today];
  if(!day || typeof day !== 'object') return;
  ['elena', 'partner'].forEach(function(person){
    if(Array.isArray(day[person])){
      day[person] = day[person].filter(function(e){ return !(e && e.kind === 'plan' && e.slot === 'breakfast'); });
    }
  });
}

// Fields copied verbatim between PROF[key] and the store. Deliberately
// excludes goalAdj (fixed, not user-editable) and everything else on PROF
// (consumed, targets, ring/bar strings, coach text…) which is recomputed
// by recomputeProf()/applyProf() every render, never stored. `avoid` (task C2) is an
// array field, handled specially below (PROFILE_FIELD_TYPE / the load loop) since every
// other persisted profile field is a plain string/number.
const PERSIST_PROFILE_FIELDS = ['sex', 'dobY', 'dobM', 'heightCm', 'weightKg', 'activity', 'calCustom', 'calNote', 'kP', 'kC', 'kF', 'avoid'];

function buildSnapshot(){
  const profiles = {};
  Object.keys(PROF).forEach(function(key){
    const p = PROF[key], out = {};
    PERSIST_PROFILE_FIELDS.forEach(function(f){ out[f] = (f === 'avoid') ? (p.avoid || []).slice() : p[f]; });
    profiles[key] = out;
  });
  return {
    v: CURRENT_STORE_VERSION, // task D1: bumped from 1 — `log` (single-day) replaced by `logHistory` (rolling)
    currentProf: currentProf,
    onboarded: onboarded,
    householdStyle: householdStyle,
    shared: { breakfast: SHARED.breakfast, lunch: SHARED.lunch, dinner: SHARED.dinner, snack: SHARED.snack },
    servings: { svE: svE, svM: svM, svS: svS },
    profiles: profiles,
    shopping: { checked: Object.keys(checkedShopNames).filter(function(n){ return checkedShopNames[n]; }) },
    // user content library (post-MVP): plain JSON data, stored verbatim — see the block
    // above for the shape. Exported/imported for free as part of the whole store (task F2).
    customFoods: customFoods,
    customRecipes: customRecipes,
    customRev: customRev,
    // logHistory (task D1): plain JSON data (no functions) — stored verbatim, capped at
    // LOG_HISTORY_RETENTION_DAYS by pruneLogHistory() (called from persist() below) before
    // every write.
    logHistory: logHistory,
    // weekPlan (task C2): the generated week is plain JSON data (no functions), so it's
    // stored verbatim; ensureWeekPlan() (js/planner.js) re-validates its signature and
    // weekStartDate against the live profile/style/avoid/SHARED state on every load and
    // regenerates when stale — this is just the last-known plan, not a cache that's
    // trusted blindly.
    weekPlan: weekPlan
  };
}

// Single write-through: gathers current values and writes once. Prunes old log-history
// days first (task D1) so the store never grows unbounded.
function persist(){
  pruneLogHistory();
  try{
    localStorage.setItem(STORE_KEY, JSON.stringify(buildSnapshot()));
  }catch(e){
    // Storage unavailable or full (iOS PWA localStorage quota, private mode, etc.) —
    // degrade to in-memory only rather than crashing the app.
    console.warn('Mesa: could not persist state to localStorage', e);
  }
}

// Deep-merges saved values over the in-code defaults above: only known,
// well-typed fields are copied, so missing keys keep their in-code default
// (forward-compatible with fields added in later versions) and unexpected/
// corrupt values are ignored rather than crashing.
function loadState(){
  let saved = null;
  try{
    const raw = localStorage.getItem(STORE_KEY);
    if(raw) saved = JSON.parse(raw);
  }catch(e){ saved = null; }
  if(!saved || typeof saved !== 'object') saved = {};

  if(typeof saved.currentProf === 'string' && PROF[saved.currentProf]) currentProf = saved.currentProf;
  if(typeof saved.householdStyle === 'string' && HOUSEHOLD_STYLES.indexOf(saved.householdStyle) !== -1) householdStyle = saved.householdStyle;

  if(saved.shared && typeof saved.shared === 'object'){
    Object.keys(SHARED).forEach(function(slot){
      if(typeof saved.shared[slot] === 'boolean') SHARED[slot] = saved.shared[slot];
    });
  }

  if(saved.servings && typeof saved.servings === 'object'){
    if(typeof saved.servings.svE === 'number') svE = saved.servings.svE;
    if(typeof saved.servings.svM === 'number') svM = saved.servings.svM;
    if(typeof saved.servings.svS === 'number') svS = saved.servings.svS;
  }

  // Per-field type check: 'string' fields must be a string, 'number' fields must be a
  // number, calCustom is special-cased since null is its valid "no override" value, and
  // avoid (task C2) must be an array of strings.
  const PROFILE_FIELD_TYPE = {
    sex: 'string', dobY: 'number', dobM: 'number', heightCm: 'number', weightKg: 'number',
    activity: 'number', calCustom: 'number|null', calNote: 'string', kP: 'number', kC: 'number', kF: 'number',
    avoid: 'string[]'
  };
  if(saved.profiles && typeof saved.profiles === 'object'){
    Object.keys(PROF).forEach(function(key){
      const sp = saved.profiles[key];
      if(!sp || typeof sp !== 'object') return;
      const p = PROF[key];
      PERSIST_PROFILE_FIELDS.forEach(function(f){
        if(!Object.prototype.hasOwnProperty.call(sp, f)) return;
        const v = sp[f], want = PROFILE_FIELD_TYPE[f];
        const ok = want === 'number|null' ? (v === null || typeof v === 'number')
          : want === 'string[]' ? (Array.isArray(v) && v.every(function(x){ return typeof x === 'string'; }))
          : (typeof v === want);
        if(ok) p[f] = want === 'string[]' ? v.slice() : v;
      });
    });
  }

  if(saved.shopping && Array.isArray(saved.shopping.checked)){
    checkedShopNames = {};
    saved.shopping.checked.forEach(function(name){ if(typeof name === 'string') checkedShopNames[name] = true; });
  }

  // user content library: structurally-wrong ids/entries are dropped rather than trusted
  // (same defensive posture as logHistory below), so a corrupt store can't crash rendering
  // or js/library.js's applyCustomFoods()/applyCustomRecipes() (called right after loadState()
  // in app.js's boot sequence).
  customFoods = {};
  if(saved.customFoods && typeof saved.customFoods === 'object'){
    Object.keys(saved.customFoods).forEach(function(id){
      if(typeof id === 'string' && id.indexOf('cf-') === 0 && saved.customFoods[id] && typeof saved.customFoods[id] === 'object'){
        customFoods[id] = saved.customFoods[id];
      }
    });
  }
  customRecipes = {};
  if(saved.customRecipes && typeof saved.customRecipes === 'object'){
    Object.keys(saved.customRecipes).forEach(function(id){
      if(typeof id === 'string' && id.indexOf('cr-') === 0 && saved.customRecipes[id] && typeof saved.customRecipes[id] === 'object'){
        customRecipes[id] = saved.customRecipes[id];
      }
    });
  }
  customRev = (typeof saved.customRev === 'number' && isFinite(saved.customRev)) ? saved.customRev : 0;

  // weekPlan (task C2) is resolved BEFORE the log-history block below since v1->v2
  // migration needs it (recovers recipeId+portion for today's confirmed slots).
  if(saved.weekPlan && typeof saved.weekPlan === 'object'
     && typeof saved.weekPlan.weekStartDate === 'string'
     && typeof saved.weekPlan.signature === 'string'
     && Array.isArray(saved.weekPlan.days) && saved.weekPlan.days.length === 7){
    weekPlan = saved.weekPlan;
  } else {
    weekPlan = null;
  }

  // log history (task D1): migrate a v1 single-day `log` first (no-ops if `logHistory`
  // is already present), then load whatever `logHistory` ended up in `saved` (empty {}
  // for a brand-new v2 store, or the migrated-in-place result). Structurally-wrong dates/
  // entries are dropped rather than trusted, so a corrupt store can't crash rendering.
  logHistory = {};
  migrateV1TodayLog(saved);
  migrateRemoveAutoBreakfast(saved); // v2->v3, one-time (see function doc above)
  if(saved.logHistory && typeof saved.logHistory === 'object'){
    Object.keys(saved.logHistory).forEach(function(date){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
      const d = saved.logHistory[date];
      if(!d || typeof d !== 'object') return;
      const clean = emptyDayLog();
      ['elena', 'partner'].forEach(function(person){
        if(Array.isArray(d[person])) clean[person] = d[person].filter(isValidLogEntry);
      });
      if(d.targets && typeof d.targets === 'object'){
        ['elena', 'partner'].forEach(function(person){
          if(typeof d.targets[person] === 'number') clean.targets[person] = d.targets[person];
        });
      }
      if(d.skipped && typeof d.skipped === 'object'){
        ['elena', 'partner'].forEach(function(person){
          if(d.skipped[person] && typeof d.skipped[person] === 'object'){
            Object.keys(d.skipped[person]).forEach(function(slot){ if(d.skipped[person][slot]) clean.skipped[person][slot] = true; });
          }
        });
      }
      logHistory[date] = clean;
    });
  }
  pruneLogHistory();

  if(typeof saved.onboarded === 'boolean'){
    onboarded = saved.onboarded;
  } else {
    try{ onboarded = !!localStorage.getItem(LEGACY_ONBOARD_KEY); }catch(e){ onboarded = false; }
  }
}
