/* ===================================================================
   planner.js — menu, swap & shopping-list logic
   Deterministic-for-now selection of which recipes make up the active
   menu (from the current macro-split "style"), the swap alternatives
   data + selection logic, and the shopping-list aggregation over the
   week plan. No DOM writes here — render.js turns this into markup.

   NOTE: re-balance is currently hardcoded presentation copy in the
   mockup (buildRebalanceSheet/applyRebalance in render.js) — there is
   no real "re-balance logic" to extract yet. The real solver arrives
   in plan task C2.
   =================================================================== */

function styleOf(p){ return p.kP >= 32 ? 'protein' : (p.kC <= 32 ? 'lowcarb' : 'balanced'); }

function computeActiveMenu(){
  const m = MEALPLANS[householdStyle];
  return {style:householdStyle, breakfastKey:m.breakfast[currentProf], lunchKey:m.lunch, dinnerKey:m.dinner, snack:m.snack};
}

/* ---------------- shopping list (computed from the week plan) ---------------- */
// Fixed ingredient → aisle map. Every quantified ingredient in RECIPES lands in
// exactly one category; anything unmapped falls back to Pantry.
const SHOP_CATEGORY = {
  'Mixed berries':'Produce', 'Mixed peppers & spinach':'Produce', 'Roasted mixed veg':'Produce',
  'Rocket / arugula':'Produce', 'Baby spinach':'Produce', 'Broccoli':'Produce',
  'Broccoli & courgette':'Produce', 'Avocado':'Produce', 'Cherry tomatoes & cucumber':'Produce',
  'Eggs':'Protein', 'Salmon fillet':'Protein', 'Sliced turkey breast':'Protein',
  'Grilled chicken breast':'Protein', 'Tuna in olive oil, drained':'Protein', 'Cooked lentils':'Protein',
  'Greek yogurt, plain':'Dairy', 'Skyr, plain':'Dairy', 'Feta cheese':'Dairy',
  'Granola':'Pantry', 'Honey':'Pantry', 'Chia seeds':'Pantry', 'Pumpkin & chia seeds':'Pantry',
  'Rye bread':'Pantry', 'Olive oil':'Pantry', 'Quinoa, dry':'Pantry', 'Cooked farro':'Pantry',
  'Coconut milk':'Pantry'
};
const SHOP_CAT_ORDER = ['Produce','Protein','Dairy','Pantry'];

// Walks the 7-day plan for BOTH people and aggregates identical ingredient names.
// Shared slots: one recipe at Elena's + Andrea's portions (cooked once, counted once).
// Solo breakfasts: each person's own recipe at their own portion. Lunch/dinner use one
// planned dish either way, so the total is the same sum of both portions.
// Day-meals with no recipe entry (e.g. snacks) are skipped silently.
function computeShoppingList(){
  const m = MEALPLANS[householdStyle];
  const totals = {};   // name -> {qty, unit}
  const staples = {};  // name -> true (qty null / 'to taste')
  function add(recipeKey, servings){
    const r = RECIPES[recipeKey];
    if(!r) return;
    r.ingredients.forEach(function(ing){
      const name = ing[0], qty = ing[1], unit = ing[2];
      if(qty === null){ staples[name] = true; return; }
      if(!totals[name]) totals[name] = {qty:0, unit:unit};
      totals[name].qty += qty * servings;
    });
  }
  WEEK.forEach(function(day){
    day.meals.forEach(function(meal){
      const slot = meal.slot.toLowerCase();
      if(slot === 'breakfast' && !SHARED.breakfast){
        add(m.breakfast.elena, svE);
        add(m.breakfast.partner, svM);
      } else {
        add(meal.key, +(svE + svM).toFixed(1));
      }
    });
  });
  return {totals: totals, staples: staples};
}

// Whole grams/ml, whole items rounded up (you can't buy 31.5 eggs),
// and ≥1000 g/ml promoted to kg/L for readability.
function fmtShopQty(qty, unit){
  if(unit === '') return '' + Math.ceil(qty);
  const g = Math.round(qty);
  if(g >= 1000) return (Math.round(g/10)/100) + (unit === 'ml' ? ' L' : ' kg');
  return g + ' ' + unit;
}

/* ---------------- swap-sheet logic ---------------- */
// Swap alternatives are kept generic per slot (breakfast/lunch/dinner/snack) rather than
// per-dish, since the active dish in each slot now depends on the macro-split style.
const SWAPS = {
  breakfast:[
    {title:'Overnight oats & berries', emoji:'🥣', kcalDelta:-40, proteinDelta:6, tags:['Low-GI','High protein']},
    {title:'Cottage cheese & peach', emoji:'🍑', kcalDelta:-60, proteinDelta:10, tags:['High protein','Low-GI']},
    {title:'Skyr & granola cup', emoji:'🥛', kcalDelta:10, proteinDelta:8, tags:['High protein']}
  ],
  lunch:[
    {title:'Chickpea & quinoa tabbouleh', emoji:'🥙', kcalDelta:-20, proteinDelta:2, tags:['High fiber','Heart-smart']},
    {title:'Tuna & white bean salad', emoji:'🥗', kcalDelta:15, proteinDelta:12, tags:['High protein','Omega-3']},
    {title:'Roasted veg & farro bowl', emoji:'🍲', kcalDelta:-35, proteinDelta:-3, tags:['High fiber']}
  ],
  dinner:[
    {title:'Baked cod, quinoa & greens', emoji:'🐠', kcalDelta:-60, proteinDelta:-4, tags:['Low-GI','Selenium']},
    {title:'Sea bass & white beans', emoji:'🐟', kcalDelta:-30, proteinDelta:2, tags:['Omega-3','Heart-smart']},
    {title:'Tofu & greens stir-fry', emoji:'🥘', kcalDelta:-90, proteinDelta:-10, tags:['Plant-based','Low-GI']}
  ],
  snack:[
    {title:'Pumpkin seeds & orange', emoji:'🍊', kcalDelta:-10, proteinDelta:1, tags:['Selenium','Vitamin C']},
    {title:'Walnuts & pear', emoji:'🍐', kcalDelta:5, proteinDelta:0, tags:['Omega-3']}
  ]
};

let swapCtx = null;

function buildSwapSheet(mealKey){
  // mealKey may already be a slot name (breakfast/lunch/dinner/snack, e.g. from the
  // Log screen) or a recipe key (e.g. from a recipe detail page) — resolve to a slot.
  const slot = SWAPS[mealKey] ? mealKey : (RECIPE_SLOT[mealKey] || mealKey);
  const alts = SWAPS[slot] || SWAPS.snack;
  let html = '<h2 style="margin-top:6px">Swap this meal</h2><p class="sub">Same slot, similar targets. Pick an alternative — your plan stays balanced.</p>';
  alts.forEach(function(a, i){
    const kd = (a.kcalDelta > 0 ? '+' : '') + a.kcalDelta + ' kcal';
    const pd = (a.proteinDelta > 0 ? '+' : '') + a.proteinDelta + 'g protein';
    html += '<div class="altrow" onclick="chooseSwap('+i+')">'
      + '<div class="ae">'+a.emoji+'</div>'
      + '<div class="at"><div class="an">'+a.title+'</div>'
      + '<div class="ad"><b>'+kd+'</b> · <b>'+pd+'</b></div>'
      + '<div class="tags">'+a.tags.map(function(t){return '<span class="pill ghost">'+t+'</span>';}).join('')+'</div>'
      + '</div></div>';
  });
  return html;
}

function chooseSwap(i){
  const slot = SWAPS[swapCtx.mealKey] ? swapCtx.mealKey : (RECIPE_SLOT[swapCtx.mealKey] || swapCtx.mealKey);
  const alts = SWAPS[slot] || SWAPS.snack;
  const a = alts[i];
  if(swapCtx.targetElId){
    const el = document.getElementById(swapCtx.targetElId);
    if(el){
      const t = el.querySelector('.t'); if(t) t.textContent = a.title;
      const th = el.querySelector('.thumb'); if(th) th.textContent = a.emoji;
      const tagsEl = el.querySelector('.tags');
      if(tagsEl){
        tagsEl.innerHTML = a.tags.map(function(t){return '<span class="pill">'+t+'</span>';}).join('');
        // preserve the "Together" pill placeholder if this card tracks one (e.g. today's snack)
        if(swapCtx.targetElId === 'todaySnack'){
          tagsEl.insertAdjacentHTML('beforeend', '<span class="pill together mini" id="pillSnack" style="display:'+(SHARED.snack?'inline-flex':'none')+'">👥 Together</span>');
        }
      }
    }
    if(swapCtx.targetElId.indexOf('log-') === 0){
      const k = swapCtx.mealKey;
      TITLES[k] = a.title; EMOJI[k] = a.emoji;
      LOGKCAL[k] = LOGKCAL[k] + a.kcalDelta;
    }
  }
  closeSheet();
  toast('🔁 Swapped to ' + a.title);
}
