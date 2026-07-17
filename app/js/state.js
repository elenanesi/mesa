/* ===================================================================
   state.js — Mesa app state
   Data & mutable state variables: recipe-adjacent helpers (whyText(),
   TAG_PILL_MAP), meal-plan/week data, profile data, shared-meal state,
   and the user-content-library field lists. No functions that write to
   the DOM or do the target-engine math live here (see engine.js,
   planner.js, render.js). The day-by-day log-history API (logHistory
   and everything that reads/writes it) moved out to js/log.js, loaded
   right after this file — see that file's header.

   Persistence (task A2): a single versioned localStorage store
   (STORE_KEY, `mesa.v1`) — see the block at the bottom of this file
   for loadState()/persist() and everything they read & write (including
   logHistory, via js/log.js's functions — cross-file globals resolve at
   call time in this shared, no-modules scope).
   =================================================================== */

/* ===================================================================
   Escaping helpers (stored-XSS hardening, 2026-07-16 consolidation)

   The app builds most UI as HTML strings assigned via innerHTML, with
   inline onclick="..." handlers, and user-controlled strings (custom
   food/recipe names, Open Food Facts product fields) flow into both.
   These three helpers are the ONLY escapers in the app — defined once,
   here, in the first-loaded js/*.js file, so every later file can call
   them both at runtime and at parse/load time. Do not redefine any of
   them elsewhere; if you need escaping, call one of these.

   - escapeHtml(s) — use for TEXT NODE content (text between tags, e.g.
     '<div>' + escapeHtml(name) + '</div>'). Never use it for attribute
     values or for JS string literals — it does not escape quotes, so a
     `"` or `'` passed through it is not safe inside value="..." or
     inside a quoted JS string.
   - htmlAttr(s) — use for HTML ATTRIBUTE VALUES (value="...", src="...",
     aria-label="..."). Escapes & " < > so a value cannot close the
     attribute or open a new tag. Never use it for a JS string literal
     embedded inside an event-handler attribute — it does not touch
     backslashes or single quotes, so it does not stop the string from
     breaking out of onclick="foo('...')".
   - jsAttr(s) — use for a STRING LITERAL embedded inside an inline
     event-handler attribute, e.g. onclick="foo('VALUE')". The value
     crosses two parsers at runtime (the HTML attribute parser, then the
     JS parser reading the string literal), so it neutralizes both:
     backslash and single-quote for the JS-string boundary, and
     & " < > plus line terminators (CR/LF/U+2028/U+2029, which an
     unescaped JS string literal cannot contain) for the HTML-attribute/
     JS-source boundary. Never use it for plain text content — its
     output is HTML-entity-encoded and would render literally (e.g.
     "&amp;" instead of "&").
   =================================================================== */
function escapeHtml(s){ return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function htmlAttr(s){ return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function jsAttr(s){
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/* ===================================================================
   recipe data — RECIPES_DB is read directly (task C-compat removed)

   Every renderer used to read a second, hand-synchronized compat object
   (built by the now-deleted buildLegacyRecipesCompat(), rebuilt on every
   library change by applyCustomRecipes()), keyed the same as RECIPES_DB
   but reshaped for old render paths. That's gone: render.js reads
   RECIPES_DB[id] directly for title/emoji/
   time/steps, calls recipeNutrition(id, 1).totals (engine.js) for kcal/
   protein, and uses two small render.js helpers — recipeDisplayIngredients(id)
   and recipeDisplayPills(id) — for the two fields whose display shape
   differs from RECIPES_DB's storage shape (per-serving ingredient rows
   with piece-unit/to-taste conversion, and tag strings mapped through
   TAG_PILL_MAP to legacy [pillClass, label] pairs). TAG_PILL_MAP stays
   here since library.js's tagLabelForPreview also reads it.

   "why" is per-PERSON (goals differ by profile), so it was never part of
   the old compat view either — see whyText(recipeId, profKey) below,
   called fresh by render.js wherever the why-box paints.
   =================================================================== */
const LEGACY_RECIPE_IDS = ['yogurt', 'omelette', 'lentil', 'salmon', 'skyrbowl', 'eggsturkey', 'chickenfarro', 'chiapudding', 'tunasalad', 'salmongreens'];
// Task C2: the planner picks from the FULL RECIPES_DB (32-36 recipes), not just these 10.
// LEGACY_RECIPE_IDS + LEGACY_WHY are kept only for their special-cased hand-written "why"
// copy on the 10 original mockup recipes (see whyText() below).

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

  // recipe.title is user-controlled for custom/edited recipes and this body is painted via
  // innerHTML (render.js:updateRecipeWhy) alongside the static <i> WHY_GUIDANCE markup, so
  // the title has to be escaped here at the source rather than at the render call site.
  const safeTitle = escapeHtml(capitalizeFirst(recipe.title));
  let body;
  if(!clauses.length){
    body = safeTitle + ' is a simple, Mediterranean-style ' + recipe.slot + ' that fits your plan.';
  } else {
    body = safeTitle + ' — ' + clauses[0] + '.';
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

/* ---------------- the week plan(s) (task C2, generalized for the two-week horizon) ----------------
   weekPlans is the source of truth for every meal both people eat, keyed by the Monday
   ('YYYY-MM-DD') that week starts — currently holds at most two entries: the CURRENT week
   and NEXT week (owner feedback: "I need to see both this and next week's menu to shop on
   the weekend"). Built by js/planner.js:generateWeek(), kept fresh per-week by
   js/planner.js:ensureWeekPlan(mondayISO) (regenerates a given week when style/avoid-list/
   calorie-target/library changes, or when nothing's been generated for that Monday yet).
   Weeks older than the current Monday are pruned on load/save (pruneOldWeekPlans(), below)
   so the store never accumulates past weeks.

   Each entry's shape (unchanged from the single-weekPlan era): { v:1,
   weekStartDate:'YYYY-MM-DD', signature (opaque string capturing the inputs that should
   trigger a regen), days: [ {date, meals:{breakfast,lunch,dinner,snack}}, ...7 ] }. Each
   `meals[slot]` is either {shared:true, recipeId, elena:{recipeId,portion,kcal,protein},
   partner:{...}} (one dish, two portions) or {shared:false, elena:{...}, partner:{...}}
   (two different dishes). portion is the "servings" unit engine.js:recipeNutrition()
   scales ingredients by; kcal/protein are that recipe at that portion, already computed.

   COMPATIBILITY GETTER: `weekPlan` is kept as a bare variable that always mirrors
   weekPlans[the CURRENT week's Monday] — see js/planner.js:ensureWeekPlan() for exactly
   how it's kept in sync. Every pre-two-week-horizon code path (Today, Log, recipe screen,
   re-balance, todayDayIndex, computeActiveMenu…) reads/writes this bare name and needed
   ZERO changes for this feature; only the Week screen (both weeks) and the shopping sheet
   (both weeks) read weekPlans directly / pass an explicit mondayISO through
   ensureWeekPlan()/computeShoppingList()/buildSwapAlternatives()/applySwap(). null until
   ensureWeekPlan() first runs (app.js boot). */
let weekPlans = {};
let weekPlan = null;
let mealPins = {};
let mealRules = [];

// Drops any weekPlans entry (and its per-week shopping-checked state, checkedShopByWeek)
// older than the CURRENT week's Monday — called from loadState() (right after weekPlans is
// populated, so a stale "current" week from a previous visit never survives a rollover)
// and from persist() (mirrors pruneLogHistory()'s pattern), so the store never accumulates
// past weeks. String comparison is safe: ISO Mondays sort lexicographically.
function pruneOldWeekPlans(){
  const cutoff = mondayOfWeek(addDaysISO(todayISO(), -1));
  Object.keys(weekPlans).forEach(function(k){
    if(k < cutoff){
      delete weekPlans[k];
      delete checkedShopByWeek[k];
    }
  });
}

function isValidWeekPlanShape(p){
  return !!p && typeof p === 'object'
    && typeof p.weekStartDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.weekStartDate)
    && typeof p.signature === 'string'
    && Array.isArray(p.days) && p.days.length === 7;
}

let recipeOrigin = 'today';
// Day context for a recipe opened from a Week row ({weekStartDate, dayIndex, slot,
// person}), so the recipe screen's swap button targets THAT day, not today. null for
// every other origin (Today/Log/library) — those really do mean today.
let recipeDayCtx = null;
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
const SLOT_LABEL = {breakfast:'Breakfast', lunch:'Lunch', dinner:'Dinner', snack:'Snack', side:'Side'};

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
let hadStoredStateOnBoot = false;
// Task F2 (export/import): the schema version buildSnapshot() writes and loadState() /
// the import validator (render.js:validateBackupStructure) accept. Bump alongside any
// future schema change (same version this store's `v` field already carried since D1).
// v3 (feedback FIX 1): breakfast is no longer auto-logged — see
// migrateRemoveAutoBreakfast() below for the one-time v2->v3 migration this bump gates.
// v4 (two-week horizon): single `weekPlan` -> keyed `weekPlans`, single flat
// `shopping.checked` -> per-week `shopping.checkedByWeek` — see loadState() below for
// both one-time v3->v4 migrations this bump gates.
// v5 (Phase 2 task S1, couple sync): adds `sync` (syncState above) and, inside each
// logHistory day, a per-person `tomb` (tombstone) list + an `id` on quick-add LogEntrys —
// see entryIdentity()/tombstoneEntry()/genId() below. All additive with safe defaults
// (getDayLog() back-fills `tomb` on old records, entryIdentity() falls back to a composite
// key for entries logged before `id` existed), so there is no gated one-time migration
// function for v4->v5 — "migration trivial" per the task brief.
// Additive library fields (`recipeOverrides`, `deletedRecipes`) also load with safe
// defaults, so older stores remain valid without a version-gated migration.
// v6 (recipe servings + plan-cell merge): adds `recipe.servings` (batch yield, absent
// = 1 — every read site defaults, engine.js:recipeNutrition divides by it) and a `t`
// mutation stamp on weekPlan meal cells (sync.js:mergePlansSection). Both additive
// with safe defaults — no gated migration, old local/synced data loads unchanged.
// v6 also gains (no version bump needed, additive/safe-default like the rest of this
// list): a `u` (updatedAt) stamp on customFoods/customRecipes/recipeOverrides entries,
// and `deletedFoods` (new, cf-id -> tombstone, parallel to deletedRecipes) — both added
// to fix the couple-sync duplication ratchet (js/sync.js:mergeLibrarySection) where the
// old library merge had no way to decide which of two conflicting edits was newer.
const CURRENT_STORE_VERSION = 6;

let onboarded = false;
// Shopping-list checked state, keyed PER WEEK (task: "shopping list per week" — checked
// items for next week's list are independent of this week's, and are pruned along with
// their week by pruneOldWeekPlans()): weekStartDate ('YYYY-MM-DD') -> {ingredientName:
// true}. Ids in the shopping sheet are positional and change whenever the list recomputes,
// so checked state is tracked by ingredient NAME within each week's bucket, same
// convention the single-week version used.
let checkedShopByWeek = {};
// Returns (creating on first touch) the checked-name set for one week's shopping list —
// every reader/writer of shopping-check state goes through this so a week with no checks
// yet doesn't need a null-check dance.
function checkedSetForWeek(weekStartDate){
  if(!checkedShopByWeek[weekStartDate]) checkedShopByWeek[weekStartDate] = {};
  return checkedShopByWeek[weekStartDate];
}

/* ---------------- user content library (post-MVP: ingredients + recipes) ----------------
   customFoods: id 'cf-<slug>' -> food object, same shape as a data/foods.js FOODS entry
   (per, unit, kcal, protein, carbs, fat, satFat, fiber, sugars, freeSugars, sugarQuality,
   flags, cat, src). Merged into the
   global FOODS object at boot and after every add/delete via js/library.js:applyCustomFoods().
   customRecipes: id 'cr-<slug>' -> recipe object, same shape as a data/recipes.js
   RECIPES_DB entry (title, emoji, slot, styles, time, ingredients, toTaste, steps, tags,
   avoid) — nutrition is NEVER stored (ground rule 1); tags/styles/avoid are AUTO-DERIVED
   from ingredients at save time (js/library.js:deriveRecipeMeta()). Merged into RECIPES_DB
   the same way via applyCustomRecipes().
   foodOverrides: built-in food id -> edited food object. recipeOverrides:
   built-in recipe id -> edited recipe object. deletedRecipes:
   recipe id -> tombstone for recipes the user removed from their library (built-in
   overrides AND custom cr- recipes alike — js/library.js:deleteRecipe()). deletedFoods:
   same idea for custom cf- foods (js/library.js:deleteCustomFood()) — new in this
   version, so always numeric (no legacy `true` values can exist for it). Tombstone
   values are either the legacy `true` (pre-couple-sync deletes — treated as epoch 1,
   js/sync.js:libraryTombstoneTime()) or a Date.now() epoch ms, so couple sync's per-id merge
   (js/sync.js:mergeLibrarySection) can tell a delete from one phone apart from a
   recreate-after-delete from the other by comparing timestamps, instead of a plain
   boolean that a union-by-id merge would otherwise just resurrect.
   customFoods/foodOverrides/customRecipes/recipeOverrides entries also carry a `u` (updatedAt, epoch
   ms) field stamped at save time (js/library.js: saveNewFood/saveRecipeBuilder) — the
   couple-sync per-entry newer-wins comparison sync.js:mergeEntryMap() needs, since
   without it two phones editing the SAME id with different content had no way to agree
   on a winner (the bug this whole tombstone/stamp scheme exists to fix — see PHASE2-plan
   notes / the 2026-07 "Frittata di pasta (imported)(imported)…" duplication-ratchet fix).
   customRev: monotonic counter, bumped on every library mutation (add/delete a food or
   recipe) — used for persistence/sync change detection. It is intentionally NOT folded
   into the week-plan signature: adding a recipe must not reset today's customized plan. */
let customFoods = {};
let foodOverrides = {};
let customRecipes = {};
let recipeOverrides = {};
let deletedRecipes = {};
let deletedFoods = {};
let recipePrefs = {};
let customRev = 0;

function normalizeFood(food){
  if(!food || typeof food !== 'object') return food;
  const out = Object.assign({}, food);
  ['kcal', 'protein', 'carbs', 'fat', 'satFat', 'fiber', 'sugars', 'freeSugars'].forEach(function(k){
    if(typeof out[k] !== 'number' || !isFinite(out[k])) out[k] = 0;
  });
  if(out.sugars < 0) out.sugars = 0;
  if(out.freeSugars < 0) out.freeSugars = 0;
  if(out.sugars > out.carbs) out.sugars = out.carbs;
  if(out.freeSugars > out.sugars) out.freeSugars = out.sugars;
  if(typeof out.sugarQuality !== 'string' || ['intrinsic', 'added/free', 'mixed', 'unknown'].indexOf(out.sugarQuality) === -1) out.sugarQuality = 'unknown';
  return out;
}

/* ---------------- couple sync (Phase 2, task S1) ----------------
   Client-side sync bookkeeping — the household code plus, per SECTION name
   (see js/sync.js: SYNC_SECTIONS — 'library'/'plans'/'shopping'/
   'profile:elena'/'profile:partner'/'log:elena'/'log:partner'), the local
   content revision and its last-changed timestamp. state.js only declares
   and persists this (same split as customFoods/customRecipes above,
   mutated by library.js): all sync BEHAVIOR — bumping revs when content
   actually changes, pushing/pulling, per-section merge rules — lives in
   js/sync.js. sectionRevs/sectionUpdatedAt are opaque string-keyed maps
   here deliberately, so state.js never needs to know the section-name
   list (js/sync.js owns that). code is null (and nothing syncs) until the
   user creates or joins a household from Profile → "Couple sync". */
let syncState = {code: null, lastSyncedAt: null, sectionRevs: {}, sectionUpdatedAt: {}};

function todayISO(){
  // Test hook for tools/check.js only — never set in the running app.
  if(typeof MESA_TEST_TODAY !== 'undefined' && MESA_TEST_TODAY) return MESA_TEST_TODAY;
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
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
  const checkedByWeek = {};
  Object.keys(checkedShopByWeek).forEach(function(wk){
    const names = Object.keys(checkedShopByWeek[wk]).filter(function(n){ return checkedShopByWeek[wk][n]; });
    if(names.length) checkedByWeek[wk] = names;
  });
  return {
    v: CURRENT_STORE_VERSION, // v4: weekPlans (keyed) + shopping.checkedByWeek (keyed) — see loadState() migrations
    currentProf: currentProf,
    onboarded: onboarded,
    householdStyle: householdStyle,
    shared: { breakfast: SHARED.breakfast, lunch: SHARED.lunch, dinner: SHARED.dinner, snack: SHARED.snack },
    servings: { svE: svE, svM: svM, svS: svS },
    profiles: profiles,
    // Per-week checked-item state (task: "shopping list per week") — see checkedShopByWeek
    // above for the shape; keyed the same way weekPlans is, by that week's Monday.
    shopping: { checkedByWeek: checkedByWeek },
    // user content library (post-MVP): plain JSON data, stored verbatim — see the block
    // above for the shape. Exported/imported for free as part of the whole store (task F2).
    customFoods: customFoods,
    foodOverrides: foodOverrides,
    customRecipes: customRecipes,
    recipeOverrides: recipeOverrides,
    deletedRecipes: deletedRecipes,
    deletedFoods: deletedFoods,
    recipePrefs: recipePrefs,
    mealPins: mealPins,
    mealRules: mealRules,
    customRev: customRev,
    // logHistory (task D1): plain JSON data (no functions) — stored verbatim, capped at
    // LOG_HISTORY_RETENTION_DAYS by pruneLogHistory() (called from persist() below) before
    // every write.
    logHistory: logHistory,
    // weekPlans (two-week horizon): keyed by weekStartDate — see the block above for the
    // shape and the `weekPlan` compat getter. Plain JSON data (no functions), stored
    // verbatim; ensureWeekPlan(mondayISO) (js/planner.js) re-validates each entry's
    // signature and weekStartDate against the live profile/style/avoid/SHARED state on
    // every load and regenerates when stale — this is just the last-known plans, not a
    // cache that's trusted blindly. Pruned to the current + future weeks before every
    // write (pruneOldWeekPlans(), called from persist() below).
    weekPlans: weekPlans,
    // couple sync (task S1) — see syncState's doc above. Opaque per-section rev/updatedAt
    // maps; js/sync.js owns what the keys mean and bumps them (via the onMesaBeforePersist
    // hook below) whenever it detects a section's live content actually changed.
    sync: {
      code: syncState.code,
      lastSyncedAt: syncState.lastSyncedAt,
      sectionRevs: syncState.sectionRevs,
      sectionUpdatedAt: syncState.sectionUpdatedAt
    }
  };
}

// Single write-through: gathers current values and writes once. Prunes old log-history
// days (task D1) and past week-plans (two-week horizon) first so the store never grows
// unbounded.
//
// Two optional hooks (task S1, couple sync — both defined in js/sync.js when that file is
// loaded, no-ops otherwise so state.js has zero hard dependency on sync.js):
//   onMesaBeforePersist() runs first so any per-section rev bump it makes (because it
//     noticed live content differs from what it last saw) is captured in THIS SAME write —
//     bumping revs after the localStorage write would risk losing the bump entirely if the
//     app closes before the next persist() ever fires.
//   onMesaAfterPersist() runs last, once state is safely on disk, to schedule a debounced
//     sync push.
function persist(){
  pruneLogHistory();
  pruneOldWeekPlans();
  if(typeof onMesaBeforePersist === 'function') onMesaBeforePersist();
  try{
    localStorage.setItem(STORE_KEY, JSON.stringify(buildSnapshot()));
  }catch(e){
    // Storage unavailable or full (iOS PWA localStorage quota, private mode, etc.) —
    // degrade to in-memory only rather than crashing the app.
    console.warn('Mesa: could not persist state to localStorage', e);
  }
  if(typeof onMesaAfterPersist === 'function') onMesaAfterPersist();
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
  hadStoredStateOnBoot = !!(saved && typeof saved === 'object');
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

  // Shopping-checked state (two-week horizon: keyed per week, shopping.checkedByWeek).
  // v3->v4 migration: an old flat `shopping.checked` array belonged to whatever week the
  // old single `weekPlan` pointed at — recover that week's Monday from `saved.weekPlan`
  // (still present raw on an un-migrated v3 store) so those checks land on the right
  // week's list instead of being silently dropped; falls back to the current Monday if
  // that's missing/invalid. No-ops once `shopping.checkedByWeek` is already present.
  checkedShopByWeek = {};
  if(saved.shopping && typeof saved.shopping === 'object' && saved.shopping.checkedByWeek && typeof saved.shopping.checkedByWeek === 'object'){
    Object.keys(saved.shopping.checkedByWeek).forEach(function(wk){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(wk)) return;
      const arr = saved.shopping.checkedByWeek[wk];
      if(!Array.isArray(arr)) return;
      const set = {};
      arr.forEach(function(name){ if(typeof name === 'string') set[name] = true; });
      checkedShopByWeek[wk] = set;
    });
  } else if(saved.shopping && Array.isArray(saved.shopping.checked)){
    const legacyWeek = (saved.weekPlan && typeof saved.weekPlan === 'object' && typeof saved.weekPlan.weekStartDate === 'string')
      ? saved.weekPlan.weekStartDate : mondayOfWeek(todayISO());
    const set = {};
    saved.shopping.checked.forEach(function(name){ if(typeof name === 'string') set[name] = true; });
    checkedShopByWeek[legacyWeek] = set;
  }

  // user content library: structurally-wrong ids/entries are dropped rather than trusted
  // (same defensive posture as logHistory below), so a corrupt store can't crash rendering
  // or js/library.js's applyCustomFoods()/applyCustomRecipes() (called right after loadState()
  // in app.js's boot sequence).
  customFoods = {};
  if(saved.customFoods && typeof saved.customFoods === 'object'){
    Object.keys(saved.customFoods).forEach(function(id){
      if(typeof id === 'string' && id.indexOf('cf-') === 0 && saved.customFoods[id] && typeof saved.customFoods[id] === 'object'){
        customFoods[id] = normalizeFood(saved.customFoods[id]);
      }
    });
  }
  foodOverrides = {};
  if(saved.foodOverrides && typeof saved.foodOverrides === 'object'){
    Object.keys(saved.foodOverrides).forEach(function(id){
      if(typeof id === 'string' && saved.foodOverrides[id] && typeof saved.foodOverrides[id] === 'object'){
        foodOverrides[id] = normalizeFood(saved.foodOverrides[id]);
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
  recipeOverrides = {};
  if(saved.recipeOverrides && typeof saved.recipeOverrides === 'object'){
    Object.keys(saved.recipeOverrides).forEach(function(id){
      if(typeof id === 'string' && saved.recipeOverrides[id] && typeof saved.recipeOverrides[id] === 'object'){
        recipeOverrides[id] = saved.recipeOverrides[id];
      }
    });
  }
  // Tombstone values can be the legacy plain `true` or a Date.now() epoch ms (couple-sync
  // stamps new deletes with a timestamp so mergeLibrarySection can compare a delete against
  // a recreate-after-delete's own `u` — see the doc block above) — both are kept verbatim
  // rather than coerced to `true`, which used to silently discard the timestamp here.
  deletedRecipes = {};
  if(saved.deletedRecipes && typeof saved.deletedRecipes === 'object'){
    Object.keys(saved.deletedRecipes).forEach(function(id){
      if(typeof id !== 'string') return;
      const v = saved.deletedRecipes[id];
      if(v === true) deletedRecipes[id] = true;
      else if(typeof v === 'number' && isFinite(v)) deletedRecipes[id] = v;
    });
  }
  deletedFoods = {};
  if(saved.deletedFoods && typeof saved.deletedFoods === 'object'){
    Object.keys(saved.deletedFoods).forEach(function(id){
      if(typeof id !== 'string') return;
      const v = saved.deletedFoods[id];
      if(v === true) deletedFoods[id] = true;
      else if(typeof v === 'number' && isFinite(v)) deletedFoods[id] = v;
    });
  }
  recipePrefs = {};
  if(saved.recipePrefs && typeof saved.recipePrefs === 'object'){
    Object.keys(saved.recipePrefs).forEach(function(id){
      const v = saved.recipePrefs[id];
      if(typeof id === 'string' && (v === 'favorite' || v === 'down')) recipePrefs[id] = v;
    });
  }
  mealPins = {};
  if(saved.mealPins && typeof saved.mealPins === 'object'){
    Object.keys(saved.mealPins).forEach(function(k){
      if(typeof k === 'string' && saved.mealPins[k]) mealPins[k] = true;
    });
  }
  mealRules = [];
  if(Array.isArray(saved.mealRules)){
    saved.mealRules.forEach(function(rule){
      if(!rule || typeof rule !== 'object') return;
      if(typeof rule.recipeId !== 'string' || typeof rule.slot !== 'string') return;
      if(['daily', 'alternate', 'weekly'].indexOf(rule.cadence) === -1) return;
      if(['shared', 'elena', 'partner'].indexOf(rule.person) === -1) return;
      if(SLOT_ORDER.indexOf(rule.slot) === -1) return;
      mealRules.push({
        recipeId: rule.recipeId,
        slot: rule.slot,
        cadence: rule.cadence,
        person: rule.person,
        anchorDate: typeof rule.anchorDate === 'string' ? rule.anchorDate : todayISO(),
        dayIndex: typeof rule.dayIndex === 'number' ? Math.max(0, Math.min(6, rule.dayIndex)) : 0
      });
    });
  }
  customRev = (typeof saved.customRev === 'number' && isFinite(saved.customRev)) ? saved.customRev : 0;

  // weekPlans (two-week horizon) is resolved BEFORE the log-history block below since
  // v1->v2 migration needs the raw saved.weekPlan (recovers recipeId+portion for today's
  // confirmed slots) — untouched by this block, which reads saved.weekPlan/saved.weekPlans
  // but never mutates `saved` itself.
  //
  // v3->v4 migration: a pre-two-week-horizon store has a single `weekPlan`, not a keyed
  // `weekPlans` — that single plan becomes weekPlans[its own weekStartDate] (exactly what
  // ensureWeekPlan(mondayISO) would have produced had this feature always existed, since
  // the plan's own weekStartDate field is authoritative). No-ops once `weekPlans` is
  // already present (a v4+ store). Anything structurally wrong (wrong shape, wrong day
  // count, mismatched key) is dropped rather than trusted, same defensive posture as
  // logHistory below — a corrupt store can't crash rendering; ensureWeekPlan() just
  // regenerates whatever's missing on first read.
  weekPlans = {};
  if(saved.weekPlans && typeof saved.weekPlans === 'object'){
    Object.keys(saved.weekPlans).forEach(function(k){
      const p = saved.weekPlans[k];
      if(isValidWeekPlanShape(p) && p.weekStartDate === k) weekPlans[k] = p;
    });
  } else if(isValidWeekPlanShape(saved.weekPlan)){
    weekPlans[saved.weekPlan.weekStartDate] = saved.weekPlan;
  }
  pruneOldWeekPlans(); // drop anything older than the current week (also prunes its checkedShopByWeek entry)
  weekPlan = weekPlans[mondayOfWeek(todayISO())] || null; // compat getter's initial value; ensureWeekPlan() (app.js boot, via applyProf()) validates/refreshes it against live state right after

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
        if(Array.isArray(d[person])) clean[person] = d[person].map(normalizeLogEntry).filter(Boolean);
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
      // Task S1 (couple sync): per-person tombstone list — absent on any pre-v5 record
      // (getDayLog()'s back-fill already covers that at read time, but load it here too so
      // a v5+ store's tombstones survive a reload rather than being silently dropped).
      if(d.tomb && typeof d.tomb === 'object'){
        ['elena', 'partner'].forEach(function(person){
          if(Array.isArray(d.tomb[person])) clean.tomb[person] = d.tomb[person].filter(isValidLogTombstone);
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

  // couple sync (task S1) — see syncState's doc above. Absent entirely on any pre-v5
  // store (fresh install or an app that's never configured sync), in which case it stays
  // the in-code default (code: null) — js/sync.js's initSync() then never schedules a
  // push, so "never configured" behaves exactly like today, no network calls.
  syncState = {code: null, lastSyncedAt: null, sectionRevs: {}, sectionUpdatedAt: {}};
  if(saved.sync && typeof saved.sync === 'object'){
    if(typeof saved.sync.code === 'string' && saved.sync.code) syncState.code = saved.sync.code;
    if(typeof saved.sync.lastSyncedAt === 'number' && isFinite(saved.sync.lastSyncedAt)) syncState.lastSyncedAt = saved.sync.lastSyncedAt;
    if(saved.sync.sectionRevs && typeof saved.sync.sectionRevs === 'object'){
      Object.keys(saved.sync.sectionRevs).forEach(function(k){
        const v = saved.sync.sectionRevs[k];
        if(typeof v === 'number' && isFinite(v)) syncState.sectionRevs[k] = v;
      });
    }
    if(saved.sync.sectionUpdatedAt && typeof saved.sync.sectionUpdatedAt === 'object'){
      Object.keys(saved.sync.sectionUpdatedAt).forEach(function(k){
        const v = saved.sync.sectionUpdatedAt[k];
        if(typeof v === 'number' && isFinite(v)) syncState.sectionUpdatedAt[k] = v;
      });
    }
  }
}
