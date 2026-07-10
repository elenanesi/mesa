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

/* ---------------- recipe data ---------------- */
const RECIPES = {
  yogurt: {
    emoji:'🥣', title:'Greek yogurt & berry bowl', time:'8 min', kcal:320, protein:24,
    tags:[['','Low-GI'],['berry','Skin-supporting'],['terra','High protein']],
    why:'Greek yogurt brings casein and whey protein plus gut-friendly probiotics; berries add skin-supporting antioxidants at a low glycemic load. Naturally low in iodine — an easy fit alongside a Hashimoto\'s-aware day. <i>General guidance, not medical advice.</i>',
    nutrition:[['Calories','320'],['Protein','24 g'],['Carbs','34 g'],['Fat','9 g'],['Good fats (unsat.)','6 g'],['Sat. fat','3 g'],['Fiber','5 g'],['Calcium','22% DV']],
    kcalSplit:'protein 31% · carbs 43% · fat 26%',
    ingredients:[['Greek yogurt, plain',150,'g'],['Mixed berries',80,'g'],['Granola',20,'g'],['Honey',8,'g'],['Chia seeds',6,'g']],
    method:['Spoon yogurt into a bowl.','Top with berries, granola and chia seeds.','Finish with a drizzle of honey.']
  },
  omelette: {
    emoji:'🍳', title:'Veggie omelette & rye toast', time:'12 min', kcal:450, protein:32,
    tags:[['terra','High protein'],['','Iron + folate'],['gold','Selenium']],
    why:'Eggs bring complete protein plus choline and selenium; rye toast adds fiber and slow-release carbs to start Andrea\'s day with steady energy for training. <i>General guidance, not medical advice.</i>',
    nutrition:[['Calories','450'],['Protein','32 g'],['Carbs','30 g'],['Fat','22 g'],['Good fats (unsat.)','13 g'],['Sat. fat','9 g'],['Fiber','4 g'],['Iron','15% DV']],
    kcalSplit:'protein 29% · carbs 27% · fat 44%',
    ingredients:[['Eggs',3,''],['Mixed peppers & spinach',80,'g'],['Rye bread',60,'g'],['Olive oil',5,'g'],['Herbs & black pepper',null,'to taste']],
    method:['Whisk eggs; sauté peppers and spinach in olive oil.','Pour eggs over the veg and cook gently until just set.','Toast the rye bread and plate alongside the omelette.']
  },
  lentil: {
    emoji:'🥗', title:'Lentil & roasted veg salad', time:'20 min', kcal:430, protein:19,
    tags:[['','Heart-smart'],['','High fiber'],['gold','Iron + B12']],
    why:'Lentils bring plant-based iron, B-vitamins and slow-release carbs; roasted veg add fiber and polyphenols, while a little feta gives calcium without loading up on dairy. A heart-smart, high-fiber midday reset. <i>General guidance, not medical advice.</i>',
    nutrition:[['Calories','430'],['Protein','19 g'],['Carbs','52 g'],['Fat','14 g'],['Good fats (unsat.)','10 g'],['Sat. fat','4 g'],['Fiber','14 g'],['Iron','35% DV']],
    kcalSplit:'protein 18% · carbs 51% · fat 31%',
    ingredients:[['Cooked lentils',100,'g'],['Roasted mixed veg',150,'g'],['Feta cheese',30,'g'],['Rocket / arugula',20,'g'],['Olive oil & lemon dressing',null,'to taste']],
    method:['Toss the warm roasted veg with the lentils.','Crumble feta over the top.','Add rocket and dress with olive oil & lemon just before serving.']
  },
  salmon: {
    emoji:'🐟', title:'Baked salmon, quinoa & greens', time:'25 min', kcal:520, protein:38,
    tags:[['berry','Thyroid-friendly'],['','Omega-3'],['gold','Selenium'],['','Low-GI'],['terra','High protein']],
    why:'Salmon delivers omega-3 and vitamin D for skin and thyroid; quinoa is a gluten-free, lower-GI carb; leafy greens add iron + folate. Iodine stays moderate — good for Hashimoto\'s balance. <i>General guidance, not medical advice.</i>',
    nutrition:[['Calories','520'],['Protein','38 g'],['Carbs','41 g'],['Fat','21 g'],['Good fats (unsat.)','16 g'],['Sat. fat','5 g'],['Fiber','7 g'],['Selenium','78% DV']],
    kcalSplit:'protein 30% · carbs 33% · fat 37%',
    ingredients:[['Salmon fillet',140,'g'],['Quinoa, dry',60,'g'],['Baby spinach',40,'g'],['Broccoli',100,'g'],['Olive oil, lemon, garlic',null,'to taste']],
    method:['Rinse quinoa, simmer in 2× water for 15 min until fluffy.','Rub salmon with olive oil, lemon, garlic. Bake at 200°C for 12–14 min.','Steam broccoli; wilt spinach in the warm pan.','Plate quinoa, greens, salmon. Finish with lemon and olive oil.']
  },
  skyrbowl: {
    emoji:'🥣', title:'Skyr bowl, berries & seeds', time:'6 min', kcal:340, protein:30,
    tags:[['terra','High protein'],['','Low-GI'],['berry','Skin-supporting']],
    why:'Skyr packs even more protein than Greek yogurt for barely any fat; mixed seeds add omega-3 and a little crunch. Naturally low in iodine — an easy fit for a higher-protein, thyroid-aware morning. <i>General guidance, not medical advice.</i>',
    nutrition:[['Calories','340'],['Protein','30 g'],['Carbs','28 g'],['Fat','9 g'],['Good fats (unsat.)','6 g'],['Sat. fat','3 g'],['Fiber','5 g'],['Calcium','25% DV']],
    kcalSplit:'protein 35% · carbs 33% · fat 24%',
    ingredients:[['Skyr, plain',180,'g'],['Mixed berries',80,'g'],['Pumpkin & chia seeds',15,'g'],['Honey',6,'g']],
    method:['Spoon skyr into a bowl.','Top with berries and seeds.','Finish with a light drizzle of honey.']
  },
  eggsturkey: {
    emoji:'🍳', title:'Eggs, turkey & rye', time:'10 min', kcal:470, protein:38,
    tags:[['terra','High protein'],['gold','Selenium'],['','Iron + B12']],
    why:'Eggs and lean turkey stack complete protein to fuel training; rye brings fiber and slow-release carbs. A higher-protein spin on Andrea\'s usual morning. <i>General guidance, not medical advice.</i>',
    nutrition:[['Calories','470'],['Protein','38 g'],['Carbs','32 g'],['Fat','20 g'],['Good fats (unsat.)','12 g'],['Sat. fat','8 g'],['Fiber','5 g'],['Iron','18% DV']],
    kcalSplit:'protein 32% · carbs 27% · fat 38%',
    ingredients:[['Eggs',2,''],['Sliced turkey breast',80,'g'],['Rye bread',60,'g'],['Olive oil',5,'g'],['Herbs & black pepper',null,'to taste']],
    method:['Scramble or fry the eggs in olive oil.','Warm the turkey slices briefly in the same pan.','Toast the rye and plate everything together.']
  },
  chickenfarro: {
    emoji:'🍲', title:'Chicken & farro bowl', time:'22 min', kcal:480, protein:42,
    tags:[['terra','High protein'],['','High fiber'],['gold','Iron + B12']],
    why:'Grilled chicken breast is a lean, high-protein anchor; farro adds fiber and a nutty bite with a lower glycemic load than white grains. A satisfying, muscle-supporting midday reset. <i>General guidance, not medical advice.</i>',
    nutrition:[['Calories','480'],['Protein','42 g'],['Carbs','44 g'],['Fat','14 g'],['Good fats (unsat.)','10 g'],['Sat. fat','4 g'],['Fiber','8 g'],['Iron','20% DV']],
    kcalSplit:'protein 35% · carbs 37% · fat 26%',
    ingredients:[['Grilled chicken breast',150,'g'],['Cooked farro',120,'g'],['Roasted mixed veg',100,'g'],['Olive oil & lemon dressing',null,'to taste']],
    method:['Grill or pan-sear the chicken until cooked through.','Toss warm farro with roasted veg.','Slice chicken over the bowl and dress with olive oil & lemon.']
  },
  chiapudding: {
    emoji:'🍮', title:'Chia pudding, coconut & berries', time:'5 min + overnight', kcal:300, protein:12,
    tags:[['','Low-carb'],['berry','Skin-supporting'],['','Omega-3']],
    why:'Chia seeds soak up coconut milk into a creamy, low-carb pudding rich in omega-3 and fiber; berries keep it low-GI and skin-supporting. A gentle, thyroid-friendly start with steady energy. <i>General guidance, not medical advice.</i>',
    nutrition:[['Calories','300'],['Protein','12 g'],['Carbs','18 g'],['Fat','20 g'],['Good fats (unsat.)','14 g'],['Sat. fat','6 g'],['Fiber','11 g'],['Calcium','15% DV']],
    kcalSplit:'protein 16% · carbs 24% · fat 60%',
    ingredients:[['Chia seeds',30,'g'],['Coconut milk',150,'ml'],['Mixed berries',60,'g'],['Vanilla or cinnamon',null,'to taste']],
    method:['Stir chia seeds into coconut milk and chill overnight.','Stir again before serving to loosen the texture.','Top with berries and a touch of vanilla or cinnamon.']
  },
  tunasalad: {
    emoji:'🥗', title:'Tuna & avocado chopped salad', time:'12 min', kcal:420, protein:34,
    tags:[['','Low-carb'],['terra','High protein'],['','Omega-3']],
    why:'Tuna is lean, high-protein and rich in omega-3; avocado swaps in healthy fat for starchy carbs, keeping this lunch low-carb without losing staying power. Heart-smart with moderate iodine — Hashimoto\'s-friendly. <i>General guidance, not medical advice.</i>',
    nutrition:[['Calories','420'],['Protein','34 g'],['Carbs','14 g'],['Fat','25 g'],['Good fats (unsat.)','18 g'],['Sat. fat','6 g'],['Fiber','8 g'],['Potassium','18% DV']],
    kcalSplit:'protein 32% · carbs 13% · fat 54%',
    ingredients:[['Tuna in olive oil, drained',120,'g'],['Avocado',80,'g'],['Cherry tomatoes & cucumber',150,'g'],['Olive oil & lemon dressing',null,'to taste']],
    method:['Chop tomatoes, cucumber and avocado.','Flake the tuna over the top.','Dress with olive oil and lemon just before serving.']
  },
  salmongreens: {
    emoji:'🐟', title:'Salmon & greens, no quinoa', time:'20 min', kcal:430, protein:36,
    tags:[['berry','Thyroid-friendly'],['','Omega-3'],['','Low-carb'],['gold','Selenium']],
    why:'Same salmon, same omega-3 and selenium — just without the quinoa, so carbs stay low while protein and healthy fat carry the meal. Iodine stays moderate for Hashimoto\'s balance. <i>General guidance, not medical advice.</i>',
    nutrition:[['Calories','430'],['Protein','36 g'],['Carbs','10 g'],['Fat','27 g'],['Good fats (unsat.)','21 g'],['Sat. fat','6 g'],['Fiber','4 g'],['Selenium','75% DV']],
    kcalSplit:'protein 33% · carbs 9% · fat 57%',
    ingredients:[['Salmon fillet',150,'g'],['Baby spinach',60,'g'],['Broccoli & courgette',150,'g'],['Olive oil, lemon, garlic',null,'to taste']],
    method:['Rub salmon with olive oil, lemon and garlic; bake at 200°C for 12–14 min.','Steam broccoli and courgette; wilt spinach in the warm pan.','Plate the greens with salmon on top, finished with lemon and olive oil.']
  }
};

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
