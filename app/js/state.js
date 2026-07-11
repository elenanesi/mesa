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
   pills, ingredients as legacy [name,qty,unit] rows, steps, why) — from
   RECIPES_DB so render.js/planner.js/app.js need no broader rewrite.

   Only the 10 original mockup recipes get a compatibility entry (their
   ids are unchanged in RECIPES_DB, see data/recipes.js). Task C2 swaps
   these call sites over to the full RECIPES_DB.

   RECIPES itself starts empty; buildLegacyRecipesCompat() (called once
   from app.js, after data/foods.js + data/recipes.js + engine.js have
   all loaded) fills it in. Every number inside is computed — nothing
   here is typed in.
   =================================================================== */
const RECIPES = {};
const LEGACY_RECIPE_IDS = ['yogurt', 'omelette', 'lentil', 'salmon', 'skyrbowl', 'eggsturkey', 'chickenfarro', 'chiapudding', 'tunasalad', 'salmongreens'];

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
// computed, never typed in (ground rule #1) — the one exception is LEGACY_WHY (display
// copy, not a number) and TAG_PILL_MAP (a label lookup, not a number either).
function buildLegacyRecipesCompat(){
  LEGACY_RECIPE_IDS.forEach(function(id){
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
      why: LEGACY_WHY[id] || 'General guidance, not medical advice.',
      ingredients: ingredients,
      method: src.steps
    };
  });
}

/* meal-slot lookup for shared-meals logic */
const RECIPE_SLOT = {
  yogurt:'breakfast', omelette:'breakfast', lentil:'lunch', salmon:'dinner',
  skyrbowl:'breakfast', eggsturkey:'breakfast', chickenfarro:'lunch',
  chiapudding:'breakfast', tunasalad:'lunch', salmongreens:'dinner'
};
function isShared(key){ return !!SHARED[RECIPE_SLOT[key]]; }

/* ---------------- macro-split-driven meal plans ---------------- */
const MEALPLANS = {
  balanced: {
    breakfast:{elena:'yogurt', partner:'omelette'},
    lunch:'lentil', dinner:'salmon',
    snack:{title:'Snack · 2 Brazil nuts + apple', emoji:'🌰', kcal:130, desc:'Covers your daily selenium target', tags:[]}
  },
  protein: {
    breakfast:{elena:'skyrbowl', partner:'eggsturkey'},
    lunch:'chickenfarro', dinner:'salmon',
    snack:{title:'Snack · Cottage cheese & walnuts', emoji:'🧀', kcal:190, desc:'Extra protein between meals', tags:[['terra','High protein']]}
  },
  lowcarb: {
    breakfast:{elena:'chiapudding', partner:'omelette'},
    lunch:'tunasalad', dinner:'salmongreens',
    snack:{title:'Snack · Almonds & cheese cubes', emoji:'🥜', kcal:170, desc:'Low-carb, keeps protein steady', tags:[['','Low-carb']]}
  }
};
let householdStyle = 'balanced';
let activeMenu = null;

let recipeOrigin = 'today';
let currentRecipeKey = 'salmon';
let svE = 1, svM = 1.5, svS = 1;

/* ---------------- week screen data ---------------- */
const WEEK = [
  {d:'Mon · Today', kcal:1800, today:true, meals:[
    {slot:'Breakfast', emoji:'🥣', name:'Yogurt bowl', kcal:320, key:'yogurt'},
    {slot:'Lunch', emoji:'🥗', name:'Lentil salad', kcal:430, key:'lentil'},
    {slot:'Dinner', emoji:'🐟', name:'Salmon & quinoa', kcal:520, key:'salmon'}
  ]},
  {d:'Tue', kcal:1790, meals:[
    {slot:'Breakfast', emoji:'🍳', name:'Veggie omelette', kcal:310, key:'yogurt'},
    {slot:'Lunch', emoji:'🍲', name:'Chicken & farro bowl', kcal:460, key:'lentil'},
    {slot:'Dinner', emoji:'🐠', name:'Sea bass, white beans', kcal:500, key:'salmon'}
  ]},
  {d:'Wed', kcal:1810, meals:[
    {slot:'Breakfast', emoji:'🍮', name:'Chia pudding', kcal:300, key:'yogurt'},
    {slot:'Lunch', emoji:'🥙', name:'Tuna & chickpea salad', kcal:450, key:'lentil'},
    {slot:'Dinner', emoji:'🍗', name:'Turkey & roasted veg', kcal:520, key:'salmon'}
  ]},
  {d:'Thu', kcal:1800, meals:[
    {slot:'Breakfast', emoji:'🥑', name:'Eggs & avocado toast (GF)', kcal:330, key:'yogurt'},
    {slot:'Lunch', emoji:'🍲', name:'Minestrone + sardines', kcal:420, key:'lentil'},
    {slot:'Dinner', emoji:'🥘', name:'Tofu stir-fry', kcal:490, key:'salmon'}
  ]},
  {d:'Fri', kcal:1830, meals:[
    {slot:'Breakfast', emoji:'🥤', name:'Berry smoothie', kcal:310, key:'yogurt'},
    {slot:'Lunch', emoji:'🍣', name:'Salmon poke bowl', kcal:470, key:'salmon'},
    {slot:'Dinner', emoji:'🥩', name:'Lean beef & greens', kcal:530, key:'lentil'}
  ]},
  {d:'Sat', kcal:1950, meals:[
    {slot:'Breakfast', emoji:'🍳', name:'Shakshuka', kcal:340, key:'yogurt'},
    {slot:'Lunch', emoji:'🥗', name:'Big Greek salad', kcal:480, key:'lentil'},
    {slot:'Dinner', emoji:'🍗', name:'Slow-roast chicken', kcal:560, key:'salmon'}
  ]},
  {d:'Sun', kcal:1880, meals:[
    {slot:'Breakfast', emoji:'🥣', name:'Oats & walnuts', kcal:320, key:'yogurt'},
    {slot:'Lunch', emoji:'🍳', name:'Roast veg frittata', kcal:440, key:'lentil'},
    {slot:'Dinner', emoji:'🦪', name:'Mussels & tomato', kcal:520, key:'salmon'}
  ]}
];

/* ---------------- log / plan-first state ---------------- */
// Keyed by slot name (breakfast/lunch/dinner/snack), not recipe key — rebuilt by
// renderLogPlan() each time the active menu (profile or split) changes.
const EMOJI = {};
const TITLES = {};
const LOGKCAL = {};
let logTotal = 0;

/* ---------------- shared-meals model ---------------- */
const SHARED = {breakfast:false, lunch:false, dinner:true, snack:false};
const SLOT_LABEL = {breakfast:'Breakfast', lunch:'Lunch', dinner:'Dinner', snack:'Snack'};

/* ---------------- profile data ---------------- */
// Body stats are the source of truth; age, BMR, maintenance and the recommended daily
// target are all derived from them (Mifflin-St Jeor × activity + goalAdj, rounded to 10).
// goalAdj is each person's goal offset from maintenance: Elena −325 (gentle deficit),
// Andrea +60 (small muscle-gain surplus) — chosen so current stats land exactly on the
// familiar 1,820 / 2,480 defaults. calCustom is null while following the recommendation.
let currentProf = 'elena';
const PROF = {
  elena:   {seg:'Elena', av:'E',
            sex:'female', dobY:1997, dobM:5, heightCm:168, weightKg:64,
            activity:1.55, goalAdj:-325, goalName:'gentle fat loss',
            calCustom:null, calNote:'', consumedKcal:400,
            goalTag:'🎯 Gentle fat loss · 🦋 Hashimoto',
            coachT:'Today leans thyroid-friendly 🦋', hashi:true,
            coachD:'Brazil nuts + salmon cover your selenium and omega-3. Iodine kept moderate, gluten-light. Tap any meal to see why it fits.',
            kP:26, kC:41, kF:33,
            consumed:{p:28,c:34,f:12}, defaultSplit:{P:26,C:41,F:33}, splitNote:'', coachOverrideT:null, coachOverrideD:null},
  partner: {seg:'Andrea', av:'A',
            sex:'male', dobY:1995, dobM:3, heightCm:181, weightKg:78,
            activity:1.375, goalAdj:60, goalName:'small muscle-gain surplus',
            calCustom:null, calNote:'', consumedKcal:470,
            goalTag:'🎯 Muscle gain · ❤️ Heart-smart',
            coachT:'Today is built for muscle 💪', hashi:false,
            coachD:'Higher protein and a small surplus. Same Mediterranean base as Elena, scaled up — shared cooking, two targets.',
            kP:26, kC:43, kF:31,
            consumed:{p:42,c:58,f:18}, defaultSplit:{P:26,C:43,F:31}, splitNote:'', coachOverrideT:null, coachOverrideD:null}
};

/* ===================================================================
   persistence (task A2) — one versioned localStorage store.

   Derived values (age, BMR, recommended calories, macro grams, computed
   menus, shopping totals) are NEVER stored here — they recompute at
   boot from the inputs below (deterministic-numbers rule). Only
   user-editable inputs and selection state are persisted:
     - both PROF entries' editable fields (not goalAdj — that's a fixed
       per-person constant, not user-editable)
     - SHARED slot toggles, svE/svM/svS servings, householdStyle,
       currentProf
     - checked shopping-list items, keyed by ingredient NAME (ids are
       positional and change whenever the list recomputes)
     - today's plan-first log status (confirmed/skipped + what was
       actually logged for lunch/dinner/snack — breakfast is always
       auto-confirmed by design, see renderLogPlan), keyed by ISO date
       so a new day always starts fresh
     - the onboarding-seen flag (migrated from the old standalone
       `mesaOnboarded` key; that key is still read as a fallback for
       installs that predate this store)

   loadState() runs once at boot, before the first render. persist()
   is the single write-through call, invoked from the end of every
   mutating action (see render.js: applyProf, toggleShared, adjServe,
   toggleShop, logConfirm/logSkip).
   =================================================================== */
const STORE_KEY = 'mesa.v1';
const LEGACY_ONBOARD_KEY = 'mesaOnboarded';

let onboarded = false;
let checkedShopNames = {};   // ingredient name -> true, for shopping-list checks

function todayISO(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Today's plan-first log status, keyed by slot (lunch/dinner/snack only —
// breakfast has no confirm/skip/swap actions, see buildLogSlotCard). Reset
// whenever the stored date isn't today.
let todayLog = { date: todayISO(), slots: {} };

// Fields copied verbatim between PROF[key] and the store. Deliberately
// excludes goalAdj (fixed, not user-editable) and everything else on PROF
// (consumed, targets, ring/bar strings, coach text…) which is recomputed
// by recomputeProf()/applyProf() every render, never stored.
const PERSIST_PROFILE_FIELDS = ['sex', 'dobY', 'dobM', 'heightCm', 'weightKg', 'activity', 'calCustom', 'calNote', 'kP', 'kC', 'kF'];

function buildSnapshot(){
  const profiles = {};
  Object.keys(PROF).forEach(function(key){
    const p = PROF[key], out = {};
    PERSIST_PROFILE_FIELDS.forEach(function(f){ out[f] = p[f]; });
    profiles[key] = out;
  });
  return {
    v: 1,
    currentProf: currentProf,
    onboarded: onboarded,
    householdStyle: householdStyle,
    shared: { breakfast: SHARED.breakfast, lunch: SHARED.lunch, dinner: SHARED.dinner, snack: SHARED.snack },
    servings: { svE: svE, svM: svM, svS: svS },
    profiles: profiles,
    shopping: { checked: Object.keys(checkedShopNames).filter(function(n){ return checkedShopNames[n]; }) },
    log: todayLog
  };
}

// Single write-through: gathers current values and writes once.
function persist(){
  try{ localStorage.setItem(STORE_KEY, JSON.stringify(buildSnapshot())); }catch(e){ /* storage unavailable/full — no-op */ }
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
  if(typeof saved.householdStyle === 'string' && MEALPLANS[saved.householdStyle]) householdStyle = saved.householdStyle;

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
  // number, and calCustom is special-cased since null is its valid "no override" value.
  const PROFILE_FIELD_TYPE = {
    sex: 'string', dobY: 'number', dobM: 'number', heightCm: 'number', weightKg: 'number',
    activity: 'number', calCustom: 'number|null', calNote: 'string', kP: 'number', kC: 'number', kF: 'number'
  };
  if(saved.profiles && typeof saved.profiles === 'object'){
    Object.keys(PROF).forEach(function(key){
      const sp = saved.profiles[key];
      if(!sp || typeof sp !== 'object') return;
      const p = PROF[key];
      PERSIST_PROFILE_FIELDS.forEach(function(f){
        if(!Object.prototype.hasOwnProperty.call(sp, f)) return;
        const v = sp[f], want = PROFILE_FIELD_TYPE[f];
        const ok = want === 'number|null' ? (v === null || typeof v === 'number') : (typeof v === want);
        if(ok) p[f] = v;
      });
    });
  }

  if(saved.shopping && Array.isArray(saved.shopping.checked)){
    checkedShopNames = {};
    saved.shopping.checked.forEach(function(name){ if(typeof name === 'string') checkedShopNames[name] = true; });
  }

  if(saved.log && typeof saved.log === 'object' && saved.log.date === todayISO() && saved.log.slots && typeof saved.log.slots === 'object'){
    todayLog = { date: saved.log.date, slots: saved.log.slots };
  } else {
    todayLog = { date: todayISO(), slots: {} };
  }

  if(typeof saved.onboarded === 'boolean'){
    onboarded = saved.onboarded;
  } else {
    try{ onboarded = !!localStorage.getItem(LEGACY_ONBOARD_KEY); }catch(e){ onboarded = false; }
  }
}
