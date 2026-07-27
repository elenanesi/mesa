/* render-today.js — today screen, add-meal sheet, log plan, eaten strip, progress, arc popover */
function openSwap(mealKey, targetElId){
  // Recipe screen reached from a Week row carries that row's day (recipeDayCtx) —
  // swap THAT day/week, not today. Every other entry point still resolves to today.
  const fromWeekRow = recipeDayCtx && SLOT_ORDER.indexOf(mealKey) === -1;
  const ctx = fromWeekRow
    ? {dayIndex: recipeDayCtx.dayIndex, slot: recipeDayCtx.slot, person: recipeDayCtx.person, weekStartDate: recipeDayCtx.weekStartDate}
    : resolveSwapContext(mealKey);
  openSwapSheetForContext(ctx, targetElId);
}

function logDateSwapContext(slot){
  const dateISO = currentLogDateISO();
  const weekStartDate = mondayOfWeek(dateISO);
  return {dayIndex: diffDaysISO(dateISO, weekStartDate), slot: slot, person: currentProf, weekStartDate: weekStartDate};
}

function openLogSwap(slot, targetElId){
  openSwapSheetForContext(logDateSwapContext(slot), targetElId);
}

// B3: explicit context, mirroring swapCtx/openSwapSheetForContext below — the sheet no
// longer resolves its own (weekStartDate, dayIndex) from an ambient "today" or
// currentLogDateISO() dateISO; every opener builds {weekStartDate, dayIndex, slot, person}
// up front (openAddMealRecipeSheet(slot, dateISO) below still exists as a thin adapter for
// the Today/Log/recipe-screen call sites, which only ever know a dateISO) so the Week
// screen's per-row ＋ button can open the sheet for ANY row (this week or next) the same
// way openWeekSwap already does.
let addMealCtx = null;
let addMealFoodQuery = '';

// (b)/(a) fix: the sheet is now sections instead of one undifferentiated, slot-filtered
// pile — "In this meal" (with a remove control per extra), "Sides", "Sauces" (task D2:
// role:'sauce' recipes — condiments meant to be added to a meal, never planned standalone,
// same delegated-row pattern as Sides), and "Full recipes" (every remaining recipe from ANY
// slot, not just this one — owner complaint (a): "I should always be able to add both sides
// specifically or full main course recipes"). `components` is the meal's CURRENT components
// (base + extras) so all three pick lists exclude what's already in — same resolution
// openAddMealRecipeSheet already had.
function mealTitleSort(a, b){
  // PERSONAL-PREFS: sort favorites the CURRENTLY ACTIVE person's own prefs.
  const activePrefs = recipePrefs[currentProf] || {};
  const aFav = activePrefs[a] === 'favorite';
  const bFav = activePrefs[b] === 'favorite';
  if(aFav !== bFav) return aFav ? -1 : 1;
  return RECIPES_DB[a].title < RECIPES_DB[b].title ? -1 : (RECIPES_DB[a].title > RECIPES_DB[b].title ? 1 : 0);
}
function mealRecipeOptions(components){
  const used = {};
  (components || []).forEach(function(c){ if(c.recipeId) used[c.recipeId] = true; });
  const ids = Object.keys(RECIPES_DB).filter(function(id){ return !used[id]; });
  const isSauce = function(id){ return RECIPES_DB[id].role === 'sauce'; };
  const isSide = function(id){ return !isSauce(id) && recipeSlotList(RECIPES_DB[id]).indexOf('side') !== -1; };
  return {
    sides: ids.filter(isSide).sort(mealTitleSort),
    sauces: ids.filter(isSauce).sort(mealTitleSort),
    full: ids.filter(function(id){ return !isSide(id) && !isSauce(id); }).sort(mealTitleSort)
  };
}

function componentTitle(c){
  if(c && c.recipeId && RECIPES_DB[c.recipeId]) return recipeDisplayTitle(c.recipeId, c.opts);
  if(c && c.foodId && FOODS[c.foodId]) return FOODS[c.foodId].name;
  return null;
}

function componentNutrition(c){
  if(c && c.recipeId) return roundedNutritionTotals(recipeNutrition(c.recipeId, c.portion).totals);
  if(c && c.foodId) return roundedNutritionTotals(foodMacros(c.foodId, c.grams));
  return roundedNutritionTotals(null);
}

function defaultMealFoodGrams(foodId){
  const food = FOODS[foodId];
  if(!food) return 100;
  if(food.unit === 'piece') return food.avgG || 50;
  if(food.unit === 'ml') return 200;
  return 100;
}

// Recipe ids can be user-authored ('cr-<slug>' from a typed recipe name), so the id rides
// in a data-* attribute (htmlAttr-escaped once, never re-parsed as JS) and the click is
// handled by attachAddMealSheetHandler's delegation — same pattern as the shopping list
// (attachShopListClickHandler) and swap search (planner.js:attachSwapSearchHandler).
function mealRecipeOptionRowHtml(id){
  const r = RECIPES_DB[id];
  const nut = roundedNutritionTotals(recipeNutrition(id, 1).totals);
  return '<div class="altrow" data-add-recipe-id="' + htmlAttr(id) + '">'
    + '<div class="ae">' + r.emoji + '</div>'
    + '<div class="at"><div class="an">' + escapeHtml(r.title) + '</div>'
    + '<div class="ad">' + nut.kcal + ' kcal · ' + nut.protein + 'g protein</div></div>'
    + '</div>';
}

// B3: the sheet's single entry point. ctx is the explicit {weekStartDate, dayIndex, slot,
// person} shape (same shape swapCtx/openSwapSheetForContext use) — dateISO is DERIVED from
// the plan day, never passed in ambiently. Logged-vs-plan branch keys off
// `dateISO <= todayISO() && slotLogStatus(...) === 'confirmed'`: for any future date (next
// week, or a not-yet-elapsed day of this week) that's automatically false, so the sheet is
// plan-only there — no new special-casing needed for the Week row entry point below.
function openAddMealSheetForContext(ctx){
  const plan = editableWeekPlan(ctx.weekStartDate);
  const day = plan.days[ctx.dayIndex];
  const dateISO = day && day.date;
  const meal = day && day.meals[ctx.slot];
  const logged = (dateISO && dateISO <= todayISO() && slotLogStatus(dateISO, ctx.person, ctx.slot) === 'confirmed')
    ? loggedPlanEntryForSlot(dateISO, ctx.person, ctx.slot) : null;
  const entry = meal && meal[ctx.person];
  if(!entry && !logged){ toast('Meal not found'); return; }
  const loggedComponents = logged
    ? (Array.isArray(logged.components) && logged.components.length ? logged.components : [{recipeId: logged.ref, portion: logged.portion || 1}])
    : null;
  // Guardrail: filter gracefully if RECIPES_DB is ever missing an id a stored component
  // still points to (e.g. a since-removed recipe) rather than rendering a broken row.
  const components = (loggedComponents || planEntryComponents(entry)).filter(function(c){ return c && RECIPES_DB[c.recipeId]; });
  const allComponents = (loggedComponents || planEntryComponents(entry)).filter(function(c){
    return c && ((c.recipeId && RECIPES_DB[c.recipeId]) || (c.foodId && FOODS[c.foodId]));
  });
  const slot = ctx.slot;
  addMealCtx = {weekStartDate: plan.weekStartDate, dayIndex: ctx.dayIndex, slot: slot, person: ctx.person, logged: !!logged};
  const opts = mealRecipeOptions(allComponents);
  // USER FEEDBACK item 3: retitle "Edit X" once the meal already has extras — "Add to X"
  // undersells that this is also where you remove what you added earlier.
  const sheetHasExtras = allComponents.length > 1;
  const sheetTitle = (sheetHasExtras ? 'Edit ' : 'Add to ') + (SLOT_LABEL[slot] || slot);
  let html = '<div class="row between" style="margin-top:6px"><h2 style="margin:0">' + sheetTitle + '</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
    + '<p class="sub" style="margin-top:6px">See what’s in this meal, add plain ingredients, a side or a full recipe, or remove something you added earlier. Mesa recalculates the meal’s calories and nutrients either way.</p>';

  // WEEK-EATENOUT-plan.md: "eating out" toggle, near the top of the sheet — this is the
  // one per-meal sheet reachable from EVERY Week row's ✎/＋ button (no 5th inline row
  // button needed). Marking it ON logs (or, for a future date, PRE-logs) this row's planned
  // meal as eaten-out on ITS OWN date via toggleWeekMealEatenOut() below — a normal logged
  // meal (calories still count) that pantryConsumedSince (pantry.js) and weekPlanComponents
  // (planner.js) both skip. Current state reads addMealCtx's own (dateISO, person, slot) —
  // NOT the `logged` var above, which only reflects a today-or-past CONFIRMED slot — so a
  // future date's not-yet-elapsed row still shows the right state right after a pre-log.
  const isEatenOut = slotLoggedEatenOut(dateISO, addMealCtx.person, addMealCtx.slot);
  html += '<button class="cta ghostbtn" onclick="toggleWeekMealEatenOut()">'
    + (isEatenOut ? '🏠 Eaten out — tap for home-cooked' : '🍴 Eating out (log as delivery / restaurant)')
    + '</button>';

  // Per-meal share toggle (2026-07-22): split a shared meal into two separate dishes ("eat
  // different tonight") or merge two back into one ("eat together"), for THIS occurrence only
  // — the household default (Profile → Meal sharing) is untouched, and the choice persists
  // through regeneration via mealShareOverrides. Same sheet, so it's reachable from every
  // Week row AND every Today card. Splitting keeps tonight's dish for both, then each is
  // swappable on its own; merging gives both the current viewer's dish at each own portion.
  // Task B3: this control (and mergeMealCell, which it can trigger) only makes sense with a
  // real second person — a one-person household never sees it, so mergeMealCell can never
  // be reached to write a real recipe into the (intentionally empty) partner cell.
  if(!(typeof isSoloHousehold === 'function' && isSoloHousehold())){
    const cellShared = (function(){
      const pl = ensureWeekPlan(addMealCtx.weekStartDate);
      const mm = pl.days[addMealCtx.dayIndex] && pl.days[addMealCtx.dayIndex].meals[addMealCtx.slot];
      return !!(mm && mm.shared);
    })();
    const slotWord = (SLOT_LABEL[addMealCtx.slot] || addMealCtx.slot).toLowerCase();
    html += '<button class="cta ghostbtn" onclick="toggleMealShareFromSheet()">'
      + (cellShared ? '🍽️ Eat different — split into two ' + slotWord + 's'
                    : '👥 Eat together — one ' + slotWord + ' for both')
      + '</button>';
  }

  html += '<div class="shop-cat">In this meal</div>';
  allComponents.forEach(function(c, i){
    const isRecipe = !!c.recipeId;
    const r = isRecipe ? RECIPES_DB[c.recipeId] : null;
    const food = c.foodId ? FOODS[c.foodId] : null;
    const title = isRecipe ? r.title : food.name;
    const emoji = isRecipe ? r.emoji : foodIconHtml(c.foodId);
    const nut = componentNutrition(c);
    const isBase = i === 0;
    // Extras get a 0.5-step portion stepper (base has its own steppers elsewhere on the
    // serving screen, so it's left at its plain "Base ·" label here).
    // Component ids can be user-authored ('cr-'/'cf-' slugs), so rows carry them in
    // data-* attributes and the buttons carry a data-act verb; the single delegated
    // handler (attachAddMealSheetHandler below) maps act+id back to the step/remove
    // functions. No inline onclick, so nothing user-influenced is ever parsed as JS.
    const stepper = isBase ? '' : ('<span class="sv-stepper" style="margin-left:8px;flex:0 0 auto">'
      + '<button data-act="minus" aria-label="' + (isRecipe ? 'Fewer servings of ' : 'Less ') + htmlAttr(title) + '">-</button>'
      + '<span class="sv-val">' + (isRecipe ? (((typeof c.portion === 'number' && c.portion > 0) ? c.portion : 1) + 'x') : foodAmountLabel(food, c.grams)) + '</span>'
      + '<button data-act="plus" aria-label="' + (isRecipe ? 'More servings of ' : 'More ') + htmlAttr(title) + '">+</button>'
      + '</span>');
    html += '<div class="altrow" style="cursor:default" ' + (isRecipe ? 'data-recipe-id="' + htmlAttr(c.recipeId) + '"' : 'data-food-id="' + htmlAttr(c.foodId) + '"') + '>'
      + '<div class="ae">' + emoji + '</div>'
      + '<div class="at"><div class="an">' + escapeHtml(title) + '</div>'
      + '<div class="ad">' + (isBase ? 'Base · ' : '') + nut.kcal + ' kcal · ' + nut.protein + 'g protein</div></div>'
      + stepper
      + (isBase ? '' : '<button class="tag-undo" style="margin-left:8px;flex:0 0 auto" data-act="remove">✕ Remove</button>')
      + '</div>';
  });

  html += '<div class="shop-cat">Ingredients</div>'
    + '<input class="inp" style="width:100%;box-sizing:border-box;border:1px solid var(--line);margin-top:8px" type="text" id="mealFoodSearchInput" placeholder="Search ingredients…" value="' + htmlAttr(addMealFoodQuery) + '" oninput="onMealFoodSearch(this.value)" autocomplete="off">'
    + '<div id="mealFoodResults" style="margin-top:4px">' + renderMealFoodResults(addMealFoodQuery) + '</div>';

  html += '<div class="shop-cat">Sides</div>';
  html += opts.sides.length ? opts.sides.map(mealRecipeOptionRowHtml).join('') : '<p class="sub" style="margin-top:6px">No side recipes available.</p>';

  html += '<div class="shop-cat">Sauces</div>';
  html += opts.sauces.length ? opts.sauces.map(mealRecipeOptionRowHtml).join('') : '<p class="sub" style="margin-top:6px">No sauces available.</p>';

  html += '<div class="shop-cat">Full recipes</div>';
  html += opts.full.length ? opts.full.map(mealRecipeOptionRowHtml).join('') : '<p class="sub" style="margin-top:6px">No other recipes available.</p>';

  document.getElementById('sheetBody').innerHTML = html;
  attachAddMealSheetHandler();
  document.getElementById('sheet').classList.add('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

// Today card ✎/＋, the recipe screen's "Manage" strip, and the Log screen's Add/Edit
// button only ever know a slot + (optionally) a dateISO — never a week/day index — so this
// stays the entry point for all three, unchanged behavior: no dateISO means today, and any
// dateISO resolves to its own week/day via the same mondayOfWeek/diffDaysISO math the sheet
// used internally before this refactor (moved here, not removed).
function openAddMealRecipeSheet(slot, dateISO){
  dateISO = dateISO || todayISO();
  const weekStartDate = mondayOfWeek(dateISO);
  const dayIndex = diffDaysISO(dateISO, weekStartDate);
  openAddMealSheetForContext({weekStartDate: weekStartDate, dayIndex: dayIndex, slot: slot, person: currentProf});
}

// Week row ＋ entry point (task B3) — mirrors openWeekSwap's shape exactly, so a row on
// EITHER This week or Next week can open the sheet directly from its own
// (weekStartDate, dayIndex), without first converting back to a dateISO.
function openWeekAddMealSheet(weekStartDate, dayIndex, slot, person){
  openAddMealSheetForContext({weekStartDate: weekStartDate, dayIndex: dayIndex, slot: slot, person: person});
}

// WEEK-EATENOUT-plan.md: the add/edit meal sheet's "eating out" toggle handler (see the
// button built in openAddMealSheetForContext above). Reuses the SAME log-history funnel
// weekLogConfirm/weekLogUndo (above) use for catch-up logging — logPlanEntry +
// setLogEntryEatenOut on, removeLoggedSlot off, `{tNull:true}` for any date that isn't
// today — just reachable for ANY row's sheet (this week or next, any date) via addMealCtx
// rather than weekLogCtx's current-week-only ◯/✓/∅ button. A SHARED meal (meal.shared)
// means BOTH people ate out, so this logs/drops BOTH `elena` and `partner`; a solo meal
// logs only addMealCtx.person — dropping only one side of a shared meal would leave the
// other person's ingredients still on the shopping list (weekPlanComponents excludes per
// person, not per slot). Re-renders the sheet in place afterward via openAddMealRecipeSheet
// (not closeSheet()) — same pattern removeMealExtraRecipe/stepMealExtraPortion already use
// — so the toggle's new label shows immediately and can be flipped back without reopening.
function toggleWeekMealEatenOut(){
  if(!addMealCtx) return;
  const ctx = addMealCtx;
  const dateISO = addDaysISO(ctx.weekStartDate, ctx.dayIndex);
  const plan = editableWeekPlan(ctx.weekStartDate);
  const meal = plan && plan.days[ctx.dayIndex] && plan.days[ctx.dayIndex].meals[ctx.slot];
  if(!meal) return;
  const people = meal.shared ? ['elena', 'partner'] : [ctx.person];
  const turningOn = !slotLoggedEatenOut(dateISO, ctx.person, ctx.slot);
  const opts = dateISO === todayISO() ? undefined : {tNull: true};
  if(turningOn){
    people.forEach(function(p){
      const entry = meal[p];
      if(!entry || !entry.recipeId) return;
      const components = planEntryComponents(entry);
      logPlanEntry(dateISO, p, ctx.slot, entry.recipeId, entry.portion, components, opts);
      const arr = getDayLog(dateISO)[p];
      const idx = arr.findIndex(function(e){ return e.kind === 'plan' && e.slot === ctx.slot; });
      if(idx !== -1) setLogEntryEatenOut(dateISO, p, idx, true);
    });
  } else {
    people.forEach(function(p){ removeLoggedSlot(dateISO, p, ctx.slot); });
  }
  refreshAfterLogChange();
  openAddMealRecipeSheet(ctx.slot, dateISO);
  toast(turningOn ? '🍴 Marked eating out — logged & dropped from the shopping list' : '🏠 Marked home-cooked again');
}

// Split this occurrence into two separate dishes, or merge two back into one — see the
// mealShareOverrides doc in planner.js and the sheet button above. Re-renders the sheet in
// place (openAddMealRecipeSheet) like toggleWeekMealEatenOut, so the button label flips and
// the split/merged cell shows immediately; the household default is never touched.
function toggleMealShareFromSheet(){
  if(!addMealCtx) return;
  const ctx = addMealCtx;
  const dateISO = addDaysISO(ctx.weekStartDate, ctx.dayIndex);
  const plan = editableWeekPlan(ctx.weekStartDate);
  const m = plan && plan.days[ctx.dayIndex] && plan.days[ctx.dayIndex].meals[ctx.slot];
  if(!m) return;
  const slotWord = (SLOT_LABEL[ctx.slot] || ctx.slot).toLowerCase();
  let ok, msg;
  if(m.shared){
    ok = splitMealCell(plan, ctx.dayIndex, ctx.slot);
    msg = '🍽️ Split — you can now swap each ' + slotWord + ' on its own';
  } else {
    ok = mergeMealCell(plan, ctx.dayIndex, ctx.slot, ctx.person || currentProf);
    msg = '👥 Eating together again';
  }
  if(!ok) return;
  markWeekPlanEdited(plan);
  refreshAfterLogChange();
  openAddMealRecipeSheet(ctx.slot, dateISO);
  toast(msg);
}

// Delegated click handler for the whole add-meal sheet: composition-row steppers/remove
// (button[data-act] inside a row carrying data-recipe-id / data-food-id), "Sides"/"Full
// recipes" option rows (data-add-recipe-id) and ingredient search results
// (data-add-food-id). One sheetBody.onclick assignment per sheet-open — the same
// non-accumulating pattern as attachShopListClickHandler above; #mealFoodResults keeps
// only its CHILDREN replaced on each keystroke (onMealFoodSearch), so delegation from
// sheetBody survives searches, and every re-render of the sheet re-runs this attach.
function attachAddMealSheetHandler(){
  const el = document.getElementById('sheetBody');
  if(!el) return;
  el.onclick = function(e){
    const btn = e.target.closest('button[data-act]');
    if(btn && el.contains(btn)){
      const row = btn.closest('.altrow');
      if(!row) return;
      const act = btn.getAttribute('data-act');
      const recipeId = row.getAttribute('data-recipe-id');
      const foodId = row.getAttribute('data-food-id');
      if(act === 'remove'){
        if(recipeId) removeMealExtraRecipe(recipeId);
        else if(foodId) removeMealExtraFood(foodId);
      } else if(act === 'minus' || act === 'plus'){
        const dir = act === 'plus' ? 1 : -1;
        if(recipeId) stepMealExtraPortion(recipeId, dir * 0.5);
        else if(foodId) stepMealExtraFoodGrams(foodId, dir * 10);
      }
      return;
    }
    const addRecipeRow = e.target.closest('.altrow[data-add-recipe-id]');
    if(addRecipeRow && el.contains(addRecipeRow)){ chooseMealExtraRecipe(addRecipeRow.getAttribute('data-add-recipe-id')); return; }
    const addFoodRow = e.target.closest('.altrow[data-add-food-id]');
    if(addFoodRow && el.contains(addFoodRow)) chooseMealExtraFood(addFoodRow.getAttribute('data-add-food-id'));
  };
}

function renderMealFoodResults(q){
  q = (q || '').trim();
  if(q.length < 2) return '<p class="sub" style="margin-top:6px">Type at least 2 letters to add plain foods.</p>';
  const ids = searchFoods(q).slice(0, 12);
  if(!ids.length) return '<p class="sub" style="margin-top:6px">No ingredients match “' + escapeHtml(q) + '”.</p>';
  return ids.map(function(id){
    const f = FOODS[id];
    const grams = defaultMealFoodGrams(id);
    const nut = roundedNutritionTotals(foodMacros(id, grams));
    // data-add-food-id instead of onclick: food ids can be user-authored 'cf-' slugs.
    return '<div class="altrow" data-add-food-id="' + htmlAttr(id) + '">'
      + '<div class="ae">' + foodIconHtml(id) + '</div>'
      + '<div class="at"><div class="an">' + escapeHtml(f.name) + '</div>'
      + '<div class="ad">' + foodAmountLabel(f, grams) + ' · ' + nut.kcal + ' kcal · ' + nut.protein + 'g protein</div></div>'
      + '</div>';
  }).join('');
}

function onMealFoodSearch(value){
  addMealFoodQuery = value;
  const el = document.getElementById('mealFoodResults');
  if(el) el.innerHTML = renderMealFoodResults(value);
}

function chooseMealExtraRecipe(recipeId){
  if(!addMealCtx || !RECIPES_DB[recipeId]) return;
  const ctx = addMealCtx;
  const dateISO = addDaysISO(ctx.weekStartDate, ctx.dayIndex);
  if(ctx.logged){
    // Symmetric with removeMealExtraRecipe below: update BOTH the log entry AND the plan
    // entry, else a later swap-correction or undo+reconfirm rebuilds the log from the plan
    // and silently drops this extra, and computeShoppingList (plan-based) never counts it.
    addExtraToLoggedMeal(dateISO, ctx.person, ctx.slot, recipeId);
    addExtraRecipeToMeal(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person, recipeId);
  } else {
    if(!addExtraRecipeToMeal(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person, recipeId)) return;
  }
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderTodayMeals();
  renderLogPlan();
  renderWeek();
  persist();
  closeSheet();
  toast('＋ Added ' + RECIPES_DB[recipeId].title);
}

function chooseMealExtraFood(foodId){
  if(!addMealCtx || !FOODS[foodId]) return;
  const ctx = addMealCtx;
  const grams = defaultMealFoodGrams(foodId);
  const dateISO = addDaysISO(ctx.weekStartDate, ctx.dayIndex);
  if(ctx.logged){
    addFoodExtraToLoggedMeal(dateISO, ctx.person, ctx.slot, foodId, grams);
    addExtraFoodToMeal(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person, foodId, grams);
  } else {
    if(!addExtraFoodToMeal(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person, foodId, grams)) return;
  }
  addMealFoodQuery = '';
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderTodayMeals();
  renderLogPlan();
  renderWeek();
  persist();
  openAddMealRecipeSheet(ctx.slot, dateISO);
  toast('＋ Added ' + FOODS[foodId].name);
}

// (b) fix: owner complaint — once an extra (e.g. Greek salad + cucumber salad alongside
// shakshuka) was added there was no way to take it back off. Symmetric to
// chooseMealExtraRecipe above, with one extra step for an already-logged meal: the logged
// entry is a components snapshot taken at confirm time (state.js:logPlanEntry), separate
// from the still-live plan entry's own extras — removing only from the log would leave a
// matching extra sitting in today's plan entry, which the Week view AND
// computeShoppingList (planner.js) both still read via planEntryComponents, so it would
// keep counting phantom ingredients on the shopping list. We remove from both, treating
// the plan-side removal as best-effort (a no-op, via removeExtraRecipeFromMeal's own
// false return, if that extra was never mirrored into the plan — e.g. one added to an
// already-logged meal via addExtraToLoggedMeal, which never touches the plan).
// Re-renders the sheet in place afterward (not closeSheet()) so several extras can be
// removed back-to-back without reopening.
function removeMealExtraRecipe(recipeId){
  if(!addMealCtx) return;
  const ctx = addMealCtx;
  const dateISO = addDaysISO(ctx.weekStartDate, ctx.dayIndex);
  const title = RECIPES_DB[recipeId] ? RECIPES_DB[recipeId].title : 'item';
  if(ctx.logged){
    if(!removeExtraFromLoggedMeal(dateISO, ctx.person, ctx.slot, recipeId)) return;
    removeExtraRecipeFromMeal(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person, recipeId);
  } else {
    if(!removeExtraRecipeFromMeal(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person, recipeId)) return;
  }
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderTodayMeals();
  renderLogPlan();
  renderWeek();
  persist();
  openAddMealRecipeSheet(ctx.slot, dateISO);
  toast('✕ Removed ' + title);
}

function removeMealExtraFood(foodId){
  if(!addMealCtx) return;
  const ctx = addMealCtx;
  const dateISO = addDaysISO(ctx.weekStartDate, ctx.dayIndex);
  const title = FOODS[foodId] ? FOODS[foodId].name : 'item';
  if(ctx.logged){
    if(!removeFoodExtraFromLoggedMeal(dateISO, ctx.person, ctx.slot, foodId)) return;
    removeExtraFoodFromMeal(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person, foodId);
  } else {
    if(!removeExtraFoodFromMeal(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person, foodId)) return;
  }
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderTodayMeals();
  renderLogPlan();
  renderWeek();
  persist();
  openAddMealRecipeSheet(ctx.slot, dateISO);
  toast('✕ Removed ' + title);
}

// A logged entry's components is a snapshot taken at confirm time (state.js:logPlanEntry),
// separate from the still-live plan entry -- falls back to a single-item [base] array when
// nothing was ever snapshotted (pre-extras logged meals, or logged.components empty).
function loggedMealComponents(logged){
  return Array.isArray(logged.components) && logged.components.length
    ? logged.components.slice()
    : [{recipeId: logged.ref, portion: (typeof logged.portion === 'number' ? logged.portion : 1)}];
}

// Finds the LAST component matching {recipeId} or {foodId} -- duplicates are allowed on
// add, so remove/set take back the most-recently-added match. Index 0 is always the base
// recipe/food from loggedMealComponents, never itself a removable/adjustable extra, so
// (unlike planner.js's findLastExtraIndex, whose entry.extras never carries a base) the
// scan starts at index 1.
function findLastLoggedComponentIndex(components, match){
  for(let i = components.length - 1; i >= 1; i--){
    const c = components[i];
    if(!c) continue;
    if(match.recipeId !== undefined && c.recipeId === match.recipeId) return i;
    if(match.foodId !== undefined && c.foodId === match.foodId) return i;
  }
  return -1;
}

// Commits a mutated components array back onto a logged entry: recomputes frozen totals the
// deterministic way (nutritionForRecipeComponents), never hand-set, and stamps logged.u for
// sync. Logged entries are per-person (the log has no shared-meal concept the way plan
// cells do), so -- unlike planner.js's mutateMealExtras -- there is no partner mirroring.
function commitLoggedMealComponents(logged, components){
  const nut = roundedNutritionTotals(nutritionForRecipeComponents(components));
  logged.components = components;
  logged.kcal = nut.kcal; logged.protein = nut.protein; logged.carbs = nut.carbs;
  logged.fat = nut.fat; logged.satFat = nut.satFat; logged.fiber = nut.fiber;
  logged.sugars = nut.sugars; logged.freeSugars = nut.freeSugars;
  logged.u = Date.now();
  return true;
}

function addExtraToLoggedMeal(dateISO, person, slot, recipeId){
  const logged = loggedPlanEntryForSlot(dateISO, person, slot);
  if(!logged) return false;
  const components = loggedMealComponents(logged);
  components.push({recipeId: recipeId, portion: 1});
  return commitLoggedMealComponents(logged, components);
}

function addFoodExtraToLoggedMeal(dateISO, person, slot, foodId, grams){
  const logged = loggedPlanEntryForSlot(dateISO, person, slot);
  if(!logged) return false;
  const components = loggedMealComponents(logged);
  components.push({foodId: foodId, grams: grams});
  return commitLoggedMealComponents(logged, components);
}

function removeExtraFromLoggedMeal(dateISO, person, slot, recipeId){
  const logged = loggedPlanEntryForSlot(dateISO, person, slot);
  if(!logged) return false;
  const components = loggedMealComponents(logged);
  const idx = findLastLoggedComponentIndex(components, {recipeId: recipeId});
  if(idx === -1) return false;
  components.splice(idx, 1);
  return commitLoggedMealComponents(logged, components);
}

function removeFoodExtraFromLoggedMeal(dateISO, person, slot, foodId){
  const logged = loggedPlanEntryForSlot(dateISO, person, slot);
  if(!logged) return false;
  const components = loggedMealComponents(logged);
  const idx = findLastLoggedComponentIndex(components, {foodId: foodId});
  if(idx === -1) return false;
  components.splice(idx, 1);
  return commitLoggedMealComponents(logged, components);
}

function setExtraPortionInLoggedMeal(dateISO, person, slot, recipeId, newPortion){
  const logged = loggedPlanEntryForSlot(dateISO, person, slot);
  if(!logged) return false;
  const components = loggedMealComponents(logged);
  const idx = findLastLoggedComponentIndex(components, {recipeId: recipeId});
  if(idx === -1) return false;
  components[idx] = {recipeId: recipeId, portion: newPortion};
  return commitLoggedMealComponents(logged, components);
}

function setFoodExtraGramsInLoggedMeal(dateISO, person, slot, foodId, grams){
  const logged = loggedPlanEntryForSlot(dateISO, person, slot);
  if(!logged) return false;
  const components = loggedMealComponents(logged);
  const idx = findLastLoggedComponentIndex(components, {foodId: foodId});
  if(idx === -1) return false;
  components[idx] = {foodId: foodId, grams: Math.max(1, Math.min(2000, Math.round(grams)))};
  return commitLoggedMealComponents(logged, components);
}

// USER FEEDBACK item 1: per-extra portion stepper in the "In this meal" sheet rows.
// Follows chooseMealExtraRecipe/removeMealExtraRecipe's exact pattern: update the logged
// entry (when ctx.logged) AND the plan extra, run the standard refresh funnel, then
// re-render the sheet in place so the stepper's new value shows without closing.
function stepMealExtraPortion(recipeId, delta){
  if(!addMealCtx) return;
  const ctx = addMealCtx;
  const dateISO = addDaysISO(ctx.weekStartDate, ctx.dayIndex);
  const loggedComp = ctx.logged ? loggedPlanEntryForSlot(dateISO, ctx.person, ctx.slot) : null;
  let current = 1;
  if(loggedComp){
    const comps = Array.isArray(loggedComp.components) ? loggedComp.components : [];
    for(let i = comps.length - 1; i >= 1; i--){
      if(comps[i] && comps[i].recipeId === recipeId){ current = (typeof comps[i].portion === 'number' && comps[i].portion > 0) ? comps[i].portion : 1; break; }
    }
  } else {
    const plan = editableWeekPlan(ctx.weekStartDate);
    const meal = plan && plan.days[ctx.dayIndex] && plan.days[ctx.dayIndex].meals[ctx.slot];
    const entry = meal && meal[ctx.person];
    const extras = entry && Array.isArray(entry.extras) ? entry.extras : [];
    for(let i = extras.length - 1; i >= 0; i--){
      if(extras[i] && extras[i].recipeId === recipeId){ current = (typeof extras[i].portion === 'number' && extras[i].portion > 0) ? extras[i].portion : 1; break; }
    }
  }
  const newPortion = Math.min(4, Math.max(0.5, +(current + delta).toFixed(1)));
  if(ctx.logged){
    setExtraPortionInLoggedMeal(dateISO, ctx.person, ctx.slot, recipeId, newPortion);
    setExtraRecipePortion(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person, recipeId, newPortion);
  } else {
    if(!setExtraRecipePortion(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person, recipeId, newPortion)) return;
  }
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderTodayMeals();
  renderLogPlan();
  renderWeek();
  persist();
  openAddMealRecipeSheet(ctx.slot, dateISO);
}

function stepMealExtraFoodGrams(foodId, delta){
  if(!addMealCtx || !FOODS[foodId]) return;
  const ctx = addMealCtx;
  const dateISO = addDaysISO(ctx.weekStartDate, ctx.dayIndex);
  let current = defaultMealFoodGrams(foodId);
  if(ctx.logged){
    const loggedComp = ctx.logged ? loggedPlanEntryForSlot(dateISO, ctx.person, ctx.slot) : null;
    const comps = loggedComp && Array.isArray(loggedComp.components) ? loggedComp.components : [];
    for(let i = comps.length - 1; i >= 1; i--){
      if(comps[i] && comps[i].foodId === foodId){ current = (typeof comps[i].grams === 'number' && comps[i].grams > 0) ? comps[i].grams : current; break; }
    }
  } else {
    const plan = editableWeekPlan(ctx.weekStartDate);
    const meal = plan && plan.days[ctx.dayIndex] && plan.days[ctx.dayIndex].meals[ctx.slot];
    const entry = meal && meal[ctx.person];
    const extras = entry && Array.isArray(entry.extras) ? entry.extras : [];
    for(let i = extras.length - 1; i >= 0; i--){
      if(extras[i] && extras[i].foodId === foodId){ current = (typeof extras[i].grams === 'number' && extras[i].grams > 0) ? extras[i].grams : current; break; }
    }
  }
  const newGrams = Math.max(1, Math.min(2000, Math.round(current + delta)));
  if(ctx.logged){
    setFoodExtraGramsInLoggedMeal(dateISO, ctx.person, ctx.slot, foodId, newGrams);
    setExtraFoodGrams(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person, foodId, newGrams);
  } else {
    if(!setExtraFoodGrams(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person, foodId, newGrams)) return;
  }
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderTodayMeals();
  renderLogPlan();
  renderWeek();
  persist();
  openAddMealRecipeSheet(ctx.slot, dateISO);
}

/* ---------------- log / plan-first confirm (task D1: writes real LogEntrys) ---------------- */
let selectedLogDateISO = todayISO();
let logMenu = null;

function currentLogDateISO(){
  return selectedLogDateISO || todayISO();
}

function logDateLabel(){
  return currentLogDateISO() === todayISO() ? 'Today' : 'Yesterday';
}

function setLogDateMode(mode, el){
  selectedLogDateISO = mode === 'yesterday' ? addDaysISO(todayISO(), -1) : todayISO();
  const seg = document.getElementById('logDateSeg');
  if(seg) seg.querySelectorAll('button').forEach(function(b){ b.classList.remove('on'); });
  if(el) el.classList.add('on');
  renderLogPlan();
}

// Recomputes the "Today so far" kcal pill straight from today's logHistory entries for
// currentProf (task D1 item 3) — replaces the old incrementally-accumulated `logTotal`.
function updateLogTotalPill(){
  const entries = getDayLog(currentLogDateISO())[currentProf];
  const total = entries.reduce(function(s, e){ return s + logEntryNutrition(e).kcal; }, 0);
  document.getElementById('logTotalPill').textContent = Math.round(total) + ' kcal';
}

function macroSummaryFromTotals(nut){
  nut = roundedNutritionTotals(nut || {});
  return nut.protein + 'g protein · ' + nut.carbs + 'g carbs · ' + nut.sugars + 'g sugars · ' + nut.fat + 'g fat';
}

function beverageCountsForToday(){
  const entries = getDayLog(currentLogDateISO())[currentProf];
  return entries.reduce(function(acc, e){
    if(e.kind !== 'food' || (e.ref !== 'espresso-unsweetened' && e.ref !== 'cappuccino-unsweetened')) return acc;
    const food = FOODS[e.ref];
    const count = food && food.unit === 'piece' ? Math.round(e.grams / food.avgG) : 1;
    if(e.ref === 'espresso-unsweetened') acc.coffee += count;
    if(e.ref === 'cappuccino-unsweetened') acc.cappuccino += count;
    return acc;
  }, {coffee: 0, cappuccino: 0});
}

function renderBeverageCounts(){
  const el = document.getElementById('coffeeCountPill');
  if(!el) return;
  const counts = beverageCountsForToday();
  el.textContent = counts.coffee + ' coffee · ' + counts.cappuccino + ' cappuccino';
}

function foodAmountLabel(food, grams){
  if(!food) return grams + 'g';
  if(food.unit === 'piece' && food.avgG){
    const count = Math.max(1, Math.round(grams / food.avgG));
    return count + 'x';
  }
  return Math.round(grams) + (food.unit || 'g');
}

function foodGroupTitle(food, grams){
  if(!food) return 'Food';
  if(food === FOODS['espresso-unsweetened']){
    const count = Math.max(1, Math.round(grams / food.avgG));
    return count + (count === 1 ? ' coffee' : ' coffees');
  }
  if(food === FOODS['cappuccino-unsweetened']){
    const count = Math.max(1, Math.round(grams / food.avgG));
    return count + (count === 1 ? ' cappuccino' : ' cappuccinos');
  }
  if(food.unit === 'piece' && food.avgG){
    const count = Math.max(1, Math.round(grams / food.avgG));
    const plural = count === 1 ? food.name : (food.name + 's');
    return count + ' ' + plural;
  }
  return food.name;
}

let todayRecordGroups = [];
let editTodayFoodCtx = null;

function groupedTodayRecords(){
  const raw = getDayLog(todayISO())[currentProf];
  const groups = [];
  const foodByRef = {};
  raw.forEach(function(e, i){
    if(e.kind === 'food'){
      const key = 'food:' + e.ref;
      if(!foodByRef[key]){
        foodByRef[key] = {kind: 'food', ref: e.ref, indices: [], grams: 0, kcal: 0, t: e.t || ''};
        groups.push(foodByRef[key]);
      }
      foodByRef[key].indices.push(i);
      foodByRef[key].grams += e.grams || 0;
      foodByRef[key].kcal += logEntryNutrition(e).kcal;
      if((e.t || '') < (foodByRef[key].t || '99:99')) foodByRef[key].t = e.t || '';
    } else {
      groups.push({kind: 'plan', entry: e, indices: [i], t: e.t || ''});
    }
  });
  return groups.sort(function(a, b){ return ((a.t || '00:00') < (b.t || '00:00')) ? -1 : 1; });
}

// "Today so far" list (task D1 item 3): every logged entry for currentProf today —
// confirmed plan slots AND quick-added foods — sorted by log time. Fully derived from
// logHistory on every call, so it can never drift from what confirm/skip/quick-add wrote.
// FIX 2c (feedback): every row carries a ✕ that removes that SPECIFIC entry from
// logHistory (removeTodayEntry below). Rows are sorted for display but each ✕ carries the
// entry's ORIGINAL index in the day's array (captured before the sort), so it always
// removes exactly the entry shown.
function renderTodaySoFar(){
  const raw = getDayLog(currentLogDateISO())[currentProf];
  const entries = raw.map(function(e, i){ return {e: e, i: i}; }).sort(function(a, b){
    return ((a.e.t || '00:00') < (b.e.t || '00:00')) ? -1 : 1;
  });
  const list = document.getElementById('todaySoFar');
  if(!list) return;
  if(!entries.length){
    list.innerHTML = '<p class="sub" style="margin:8px 0 0">Nothing logged yet for ' + logDateLabel().toLowerCase() + '.</p>';
    return;
  }
  list.innerHTML = entries.map(function(row){
    const e = row.e;
    const removeBtn = '<button class="li-x" aria-label="Remove this entry" onclick="removeTodayEntry('+row.i+')">✕</button>';
    // FAVORITES-EATENOUT-plan.md item 3: a per-row toggle for the eaten-out flag — kcal
    // stays in the day total either way (logEntryNutrition doesn't look at it), the only
    // effect is on pantryConsumedSince (pantry.js). The pill makes an eaten-out row read as
    // such at a glance, since its absence from pantry depletion is otherwise invisible.
    const outPill = e.eatenOut ? ' <span class="chip-computed">🍴 out</span>' : '';
    const toggleBtn = '<button class="li-x" aria-label="'+(e.eatenOut ? 'Mark eaten at home' : 'Mark eaten out')+'" onclick="toggleTodayEntryEatenOut('+row.i+')">'+(e.eatenOut ? '🏠' : '🍴')+'</button>';
    if(e.kind === 'plan'){
      const r = RECIPES_DB[e.ref];
      const emoji = r ? r.emoji : '🍽️';
      const title = escapeHtml(logEntryTitleWithComponents(e));
      const label = (e.slot ? SLOT_LABEL[e.slot] : 'Meal') + (e.t ? ' · ' + e.t : ' · earlier today');
      return '<div class="logitem"><div class="li-i">'+emoji+'</div><div class="li-t">'+title+outPill+'<small>'+label+'</small></div><div class="li-k">'+Math.round(logEntryNutrition(e).kcal)+'</div>'+toggleBtn+removeBtn+'</div>';
    }
    const food = FOODS[e.ref];
    const name = escapeHtml(food ? food.name : 'Food');
    let amount = e.grams + 'g';
    if(food && food.unit === 'piece'){
      const count = Math.max(1, Math.round(e.grams / food.avgG));
      amount = count + 'x';
    }
    const label = (e.ref === 'espresso-unsweetened' || e.ref === 'cappuccino-unsweetened' ? 'Drink' : 'Quick add') + ' · ' + amount + (e.t ? ' · ' + e.t : '');
    return '<div class="logitem"><div class="li-i">🥄</div><div class="li-t">'+name+outPill+'<small>'+label+'</small></div><div class="li-k">'+Math.round(logEntryNutrition(e).kcal)+'</div>'+toggleBtn+removeBtn+'</div>';
  }).join('');
}

// FAVORITES-EATENOUT-plan.md item 3: toggles ONE "Today so far" row's eaten-out flag by its
// ORIGINAL logHistory index (row.i above — the same identity removeTodayEntry uses), then
// goes through the same refreshAfterLogChange() funnel as every other log mutation in this
// file so Today/Log/Insights/Week (and, on the next Pantry-page view, pantryRemaining())
// all repaint consistently from the one logHistory source of truth.
function toggleTodayEntryEatenOut(index){
  const entry = getDayLog(currentLogDateISO())[currentProf][index];
  if(!entry) return;
  const next = !entry.eatenOut;
  if(!setLogEntryEatenOut(currentLogDateISO(), currentProf, index, next)) return;
  refreshAfterLogChange();
  toast(next ? '🍴 Marked eaten out — pantry stays untouched' : '🏠 Marked home-cooked');
}

function renderTodayRecords(){
  const raw = getDayLog(todayISO())[currentProf];
  const list = document.getElementById('todayRecordsList');
  const pill = document.getElementById('todayRecordsPill');
  if(!list) return;
  const total = raw.reduce(function(s, e){ return s + logEntryNutrition(e).kcal; }, 0);
  if(pill) pill.textContent = Math.round(total) + ' kcal';
  todayRecordGroups = groupedTodayRecords();
  if(!todayRecordGroups.length){
    list.innerHTML = '<p class="sub" style="margin:8px 0 0">Nothing logged yet today.</p>';
    return;
  }
  list.innerHTML = todayRecordGroups.map(function(group, gi){
    const editBtn = '<button class="li-x" aria-label="Edit this item" onclick="openEditTodayRecord('+gi+')">✎</button>';
    const deleteBtn = '<button class="li-x" aria-label="Delete this item" onclick="deleteTodayRecordGroup('+gi+')">✕</button>';
    // FAVORITES-EATENOUT-plan.md item 3: same toggle as "Today so far", but at the GROUP
    // level (groupedTodayRecords merges repeat quick-adds of the same food into one row) —
    // see groupEatenOut()/toggleTodayRecordGroupEatenOut() below.
    const isOut = groupEatenOut(group);
    const outPill = isOut ? ' <span class="chip-computed">🍴 out</span>' : '';
    const toggleBtn = '<button class="li-x" aria-label="'+(isOut ? 'Mark eaten at home' : 'Mark eaten out')+'" onclick="toggleTodayRecordGroupEatenOut('+gi+')">'+(isOut ? '🏠' : '🍴')+'</button>';
    if(group.kind === 'plan'){
      const e = group.entry;
      const r = RECIPES_DB[e.ref];
      const emoji = r ? r.emoji : '🍽️';
      const title = escapeHtml(logEntryTitleWithComponents(e));
      const label = (e.slot ? SLOT_LABEL[e.slot] : 'Meal') + ' · ' + macroSummaryFromTotals(logEntryNutrition(e)) + (e.t ? ' · ' + e.t : '');
      return '<div class="logitem"><div class="li-i">'+emoji+'</div><div class="li-t">'+title+outPill+'<small>'+label+'</small></div><div class="li-k">'+Math.round(logEntryNutrition(e).kcal)+'</div>'+toggleBtn+deleteBtn+'</div>';
    }
    const food = FOODS[group.ref];
    const title = escapeHtml(foodGroupTitle(food, group.grams));
    const nut = foodMacros(group.ref, group.grams);
    const label = (group.ref === 'espresso-unsweetened' || group.ref === 'cappuccino-unsweetened' ? 'Drink' : 'Quick add') + ' · ' + foodAmountLabel(food, group.grams) + ' · ' + macroSummaryFromTotals(nut);
    // A quick-add food row already carries edit + delete; a third inline button crowds the
    // text on a phone, so eaten-out moves INTO the edit sheet (buildEditTodayFoodSheet) for
    // food rows. The pill still shows the state on the row at a glance. Plan rows above keep
    // the inline toggle — they have only delete (2 buttons, uncrowded) and no edit sheet.
    return '<div class="logitem"><div class="li-i">🥄</div><div class="li-t">'+title+outPill+'<small>'+label+'</small></div><div class="li-k">'+Math.round(group.kcal)+'</div>'+editBtn+deleteBtn+'</div>';
  }).join('');
}

// True iff every logHistory index this "Today records" group represents is currently
// marked eaten-out — a group can span >1 index (groupedTodayRecords merges repeat
// quick-adds of the same food today), so the row's single pill/toggle needs a single
// summary truth rather than just peeking at the first index.
function groupEatenOut(group){
  const day = getDayLog(todayISO())[currentProf];
  return group.indices.length > 0 && group.indices.every(function(i){ return day[i] && day[i].eatenOut === true; });
}

// Flips the eaten-out flag for every logHistory index a "Today records" group represents,
// together, so the row's merged pill/button stays a true summary rather than drifting
// index-by-index. Uses todayISO() (not currentLogDateISO()) to match every other
// renderTodayRecords mutator (deleteTodayRecordGroup, saveEditTodayFood, openEditTodayRecord)
// — this list is always "today", unlike "Today so far" which can view a past date.
function toggleTodayRecordGroupEatenOut(groupIndex){
  const group = todayRecordGroups[groupIndex];
  if(!group) return;
  const next = !groupEatenOut(group);
  group.indices.forEach(function(i){ setLogEntryEatenOut(todayISO(), currentProf, i, next); });
  refreshAfterLogChange();
  toast(next ? '🍴 Marked eaten out — pantry stays untouched' : '🏠 Marked home-cooked');
}

function deleteTodayRecordGroup(groupIndex){
  const group = todayRecordGroups[groupIndex];
  if(!group) return;
  group.indices.slice().sort(function(a, b){ return b - a; }).forEach(function(i){ removeLogEntryAt(todayISO(), currentProf, i); });
  refreshAfterLogChange();
  toast('✕ Removed item');
}

function openEditTodayRecord(groupIndex){
  const group = todayRecordGroups[groupIndex];
  if(!group) return;
  if(group.kind === 'plan'){
    deleteTodayRecordGroup(groupIndex);
    return;
  }
  editTodayFoodCtx = {indices: group.indices.slice(), ref: group.ref, grams: Math.max(1, Math.round(group.grams)), eatenOut: groupEatenOut(group)};
  document.getElementById('sheetBody').innerHTML = buildEditTodayFoodSheet();
  document.getElementById('sheet').classList.remove('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

function buildEditTodayFoodSheet(){
  const food = FOODS[editTodayFoodCtx.ref];
  if(!food) return '<p class="sub">Food not found.</p>';
  const nut = foodMacros(editTodayFoodCtx.ref, editTodayFoodCtx.grams);
  const isPiece = food.unit === 'piece' && food.avgG;
  const amountText = isPiece ? Math.max(1, Math.round(editTodayFoodCtx.grams / food.avgG)) + 'x' : editTodayFoodCtx.grams + 'g';
  const step = isPiece ? food.avgG : 10;
  return '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Edit ' + escapeHtml(food.name) + '</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
    + '<div class="serve-row" style="margin-top:14px"><div class="serve-card me" style="flex:1">'
    + '<div class="sv-name">Amount</div>'
    + '<div class="sv-stepper"><button onclick="stepEditTodayFood(-'+step+')" aria-label="Decrease amount">–</button>'
    + '<span class="sv-val">' + amountText + '</span>'
    + '<button onclick="stepEditTodayFood('+step+')" aria-label="Increase amount">+</button></div></div></div>'
    + '<div class="nutri" style="margin-top:16px">'
    + '<div class="n"><div class="nt"><span>Calories</span><b>'+Math.round(nut.kcal)+' kcal</b></div></div>'
    + '<div class="n"><div class="nt"><span>Protein</span><b>'+Math.round(nut.protein)+' g</b></div></div>'
    + '<div class="n"><div class="nt"><span>Carbs</span><b>'+Math.round(nut.carbs)+' g</b></div></div>'
    + '<div class="n"><div class="nt"><span>Sugars</span><b>'+Math.round(nut.sugars)+' g</b></div></div>'
    + '<div class="n"><div class="nt"><span>Fat</span><b>'+Math.round(nut.fat)+' g</b></div></div>'
    + '</div>'
    // FAVORITES-EATENOUT-plan.md item 3: the eaten-out toggle lives here (not as a third
    // inline row button) — kcal still counts in the day, it only stops this item depleting
    // the pantry. Reflected on Save via editTodayFoodCtx.eatenOut.
    + '<button class="cta ghostbtn" onclick="toggleEditTodayFoodEatenOut()">' + (editTodayFoodCtx.eatenOut ? '🏠 Eaten out — tap for home-cooked' : '🍴 Mark as eaten out (delivery / restaurant)') + '</button>'
    + '<button class="cta" onclick="saveEditTodayFood()">Save</button>'
    + '<button class="cta ghostbtn" onclick="deleteEditingTodayFood()">Delete</button>';
}

function toggleEditTodayFoodEatenOut(){
  if(!editTodayFoodCtx) return;
  editTodayFoodCtx.eatenOut = !editTodayFoodCtx.eatenOut;
  document.getElementById('sheetBody').innerHTML = buildEditTodayFoodSheet();
}

function stepEditTodayFood(delta){
  if(!editTodayFoodCtx) return;
  editTodayFoodCtx.grams = Math.max(1, Math.min(2000, Math.round(editTodayFoodCtx.grams + delta)));
  document.getElementById('sheetBody').innerHTML = buildEditTodayFoodSheet();
}

function saveEditTodayFood(){
  if(!editTodayFoodCtx) return;
  const arr = getDayLog(todayISO())[currentProf];
  const keepIndex = editTodayFoodCtx.indices[0];
  const base = arr[keepIndex];
  if(!base) return;
  const nut = roundedNutritionTotals(foodMacros(editTodayFoodCtx.ref, editTodayFoodCtx.grams));
  base.grams = editTodayFoodCtx.grams;
  base.kcal = nut.kcal; base.protein = nut.protein; base.carbs = nut.carbs; base.fat = nut.fat; base.satFat = nut.satFat; base.fiber = nut.fiber; base.sugars = nut.sugars; base.freeSugars = nut.freeSugars; base.u = Date.now();
  // Apply the eaten-out choice from the sheet. The merged group collapses to this one kept
  // entry (the others are removed just below), so only `base` needs the flag; setLogEntryEatenOut
  // re-stamps u exactly as the field-writes above already did.
  setLogEntryEatenOut(todayISO(), currentProf, keepIndex, editTodayFoodCtx.eatenOut);
  editTodayFoodCtx.indices.slice(1).sort(function(a, b){ return b - a; }).forEach(function(i){ removeLogEntryAt(todayISO(), currentProf, i); });
  editTodayFoodCtx = null;
  refreshAfterLogChange();
  closeSheet();
  toast('✓ Updated item');
}

function deleteEditingTodayFood(){
  if(!editTodayFoodCtx) return;
  editTodayFoodCtx.indices.slice().sort(function(a, b){ return b - a; }).forEach(function(i){ removeLogEntryAt(todayISO(), currentProf, i); });
  editTodayFoodCtx = null;
  refreshAfterLogChange();
  closeSheet();
  toast('✕ Removed item');
}

// FIX 2 (feedback): one refresh funnel for every undo/remove — everything below derives
// from logHistory, so this is all that's needed for full parity across Today (ring/
// macros/fat line), Log (cards, pill, "Today so far") and Insights (which repaints from
// logHistory on next visit via go()).
function refreshAfterLogChange(){
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderTodayMeals();
  renderLogPlan(); // rebuilds cards + replays statuses, then updates pill + "Today so far"
  renderTodayRecords();
  renderBeverageCounts();
  if(currentLogDateISO() === todayISO()) renderTodayCardActions(); // keep Today cards in sync only when editing today
  // task C1 fix: the Week screen's day rows/totals also derive from logHistory (same as
  // everything above), but previously only weekLogConfirm/weekLogSkip/weekLogUndo re-painted
  // Week themselves after this funnel — every OTHER caller (quick-add edit/delete:
  // saveEditTodayFood/deleteTodayRecordGroup/removeTodayEntry/deleteEditingTodayFood, plus
  // undoLogSlot/undoRecipeEatenSlot) left Week stale until the next unrelated repaint.
  // Centralizing the repaint here is the single funnel this function's own doc comment
  // promises — those three callers' now-redundant explicit repaint calls were removed.
  renderWeek();
  persist();
}

/* ---------------- FIX 1 (feedback): Confirm/Skip directly on the Today cards ----------------
   Owner: "lo skip si vede solo se clicco su '+', ma non in 'today'" — the four Today cards
   only opened the recipe before. This paints a compact action row into each card, driven
   by the EXACT SAME funnel the Log screen uses (logConfirm/logSkip/undoLogSlot,
   slotLogStatus — logHistory is the one source of truth), so Today and Log can never
   disagree: whichever screen you tap on, both re-derive from the same state.
   Re-derives all four slots fresh from slotLogStatus() every call (cheap — 4 lookups), so
   it's safe to call after ANY log-affecting action regardless of which surface triggered
   it (Today tap, Log tap, Undo, swap, profile switch, rebalance…) without tracking which
   slot changed. */
const TODAY_CARD_ACTION_EL = {breakfast: 'taBreakfast', lunch: 'taLunch', dinner: 'taDinner', snack: 'taSnack'};

function renderTodayCardActions(){
  SLOT_ORDER.forEach(function(slot){
    var wrap = document.getElementById(TODAY_CARD_ACTION_EL[slot]);
    if(!wrap) return;
    var status = slotLogStatus(todayISO(), currentProf, slot);
    var label = SLOT_LABEL[slot] || slot;
    var hasExtras = todaySlotView(slot).extras.length > 0;
    var addLabel = hasExtras ? '✎ Edit' : '＋ Add';
    var addAria = (hasExtras ? 'Edit ' : 'Add to ') + label;
    if(status === 'confirmed'){
      // Card state: done — show tag, undo, and swap/edit controls
      var card = wrap.closest('.meal');
      if(card){ card.classList.add('state-done'); card.classList.remove('state-skipped'); }
      // Add badge to thumb
      var thumb = card ? card.querySelector('.thumb') : null;
      if(thumb && !thumb.querySelector('.done-badge')){
        thumb.style.position = 'relative';
        var badge = document.createElement('span');
        badge.className = 'done-badge';
        badge.textContent = '✓';
        thumb.appendChild(badge);
      }
      wrap.innerHTML = '<div class="tag-row"><span class="state-tag tag-done">✓ Eaten</span>'
        + '<span class="tag-controls"><button class="tag-undo" onclick="event.stopPropagation();openSwap(\''+slot+'\',null)">↔</button>'
        + '<button class="tag-undo" aria-label="'+addAria+'" onclick="event.stopPropagation();openAddMealRecipeSheet(\''+slot+'\')">'+addLabel+'</button>'
        + '<button class="tag-undo" onclick="event.stopPropagation();undoLogSlot(\''+slot+'\')">↺</button></span></div>';
    } else if(status === 'skipped'){
      var card2 = wrap.closest('.meal');
      if(card2){ card2.classList.add('state-skipped'); card2.classList.remove('state-done'); }
      // Remove any done badge
      var thumb2 = card2 ? card2.querySelector('.done-badge') : null;
      if(thumb2) thumb2.remove();
      wrap.innerHTML = '<div class="tag-row"><span class="state-tag tag-skipped">— Skipped</span>'
        + '<button class="tag-undo" onclick="event.stopPropagation();undoLogSlot(\''+slot+'\')">↺ Undo</button></div>';
    } else {
      // Pending: cute single log button — swap/skip/extras live in recipe detail
      var card3 = wrap.closest('.meal');
      if(card3){ card3.classList.remove('state-done', 'state-skipped'); }
      // Remove any done badge
      var oldBadge = card3 ? card3.querySelector('.done-badge') : null;
      if(oldBadge) oldBadge.remove();
      wrap.innerHTML = '<div class="meal-actions-row">'
        + '<button class="meal-act-btn act-skip" aria-label="Skip '+label+'" onclick="event.stopPropagation();logSkip(\''+slot+'\')" title="Skip"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5l14 14"/><path d="M19 5L5 19"/></svg></button>'
        + '<button class="meal-act-btn act-swap" aria-label="Swap '+label+'" onclick="event.stopPropagation();openSwap(\''+slot+'\',null)" title="Swap"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3l4 4-4 4"/><path d="M20 7H4"/><path d="M8 21l-4-4 4-4"/><path d="M4 17h16"/></svg></button>'
        + '<button class="meal-log-btn" aria-label="Log '+label+'" onclick="event.stopPropagation();logConfirm(\''+slot+'\')" title="Mark as eaten"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11.35 3.836c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-2.25-2.25h-1.5a2.25 2.25 0 0 0-2.15 1.586z"/><path d="M9.298 3H7.5A2.25 2.25 0 0 0 5.25 5.25v13.5A2.25 2.25 0 0 0 7.5 21h9a2.25 2.25 0 0 0 2.25-2.25V5.25A2.25 2.25 0 0 0 16.5 3h-.298"/><path d="m9 14 2 2 4-4"/></svg></button>'
        + '</div>';
    }
  });
}

// FIX 2a/2b (feedback): "Undo" on a confirmed or skipped Log card — clears the slot's
// plan entry / skipped flag (state.js:removeLoggedSlot), which restores the card's
// Confirm/Swap/Skip actions on the renderLogPlan() rebuild.
function undoLogSlot(slot){
  const status = slotLogStatus(currentLogDateISO(), currentProf, slot);
  if(!status) return;
  removeLoggedSlot(currentLogDateISO(), currentProf, slot);
  refreshAfterLogChange();
  toast(status === 'confirmed'
    ? '↺ Un-logged ' + (TITLES[slot] || SLOT_LABEL[slot]) + ' — confirm it again anytime'
    : '↺ ' + SLOT_LABEL[slot] + ' un-skipped');
}

// FIX 2c (feedback): the "Today so far" ✕ — removes one specific entry from today's
// logHistory. For a plan entry this also restores the matching card's actions (the card
// state is re-derived from slotLogStatus on the renderLogPlan() rebuild, same path as
// undoLogSlot — the two stay consistent by construction).
function removeTodayEntry(index){
  const removed = removeLogEntryAt(currentLogDateISO(), currentProf, index);
  if(!removed) return;
  let name = 'entry';
  if(removed.kind === 'plan'){
    const r = RECIPES_DB[removed.ref];
    name = r ? r.title : 'meal';
  } else {
    const f = FOODS[removed.ref];
    name = f ? f.name : 'food';
  }
  refreshAfterLogChange();
  toast('✕ Removed ' + name + ' (−' + removed.kcal + ' kcal)');
}

// `silent` is used only by restoreTodayLog() (app.js) replaying a persisted
// confirm/skip at boot, so reload doesn't re-fire the toast or re-log the entry (it's
// already in logHistory) for something the user already actioned in a previous session.
// FIX 2a/2b (feedback): the confirmed/skipped tag is now a ROW — the status text plus an
// "Undo" ghost button (44px tap target, css .tag-undo) that reverses the action via
// undoLogSlot(). Shared by logConfirm and logSkip below.
function appendTagRow(card, slot, tagClass, tagText){
  const actions = card.querySelector('.logactions'); if(actions) actions.remove();
  const info = card.querySelector('.info');
  const row = document.createElement('div');
  row.className = 'tag-row';
  const dateISO = currentLogDateISO();
  const correctionBtns = tagClass === 'confirmed-tag'
    ? '<button class="tag-undo" onclick="openLogSwap(\''+slot+'\',\'log-'+slot+'\')">↔ Swap</button>'
      + '<button class="tag-undo" onclick="openAddMealRecipeSheet(\''+slot+'\',\''+jsAttr(dateISO)+'\')">✎ Edit</button>'
    : '';
  row.innerHTML = '<span class="'+tagClass+'">'+tagText+'</span>'
    + '<span class="tag-controls">' + correctionBtns + '<button class="tag-undo" onclick="undoLogSlot(\''+slot+'\')">↺ Undo</button></span>';
  info.appendChild(row);
}

function logConfirm(key, silent){
  const card = document.getElementById('log-' + key);
  if(!card || card.classList.contains('done') || card.classList.contains('skipped')) return;
  card.classList.add('done');
  appendTagRow(card, key, 'confirmed-tag', silent ? '✓ Logged · earlier today' : '✓ Logged · just now');

  if(!silent){
    const v = (logMenu || computeMenuForDate(currentLogDateISO(), currentProf))[key];
    logPlanEntry(currentLogDateISO(), currentProf, key, v.recipeId, v.portion, v.components);
    toast('✓ Logged to ' + logDateLabel().toLowerCase());
  }

  // Task D1: Today ring/macros/good-sat-fat line and the "Today so far" list all derive
  // from logHistory — refresh them on every confirm (live tap or silent replay alike).
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  updateLogTotalPill();
  renderTodaySoFar();
  renderTodayRecords();
  if(currentLogDateISO() === todayISO()) renderTodayCardActions(); // mirror the confirm onto Today cards only for today
  persist();
}

function logSkip(key, silent){
  const card = document.getElementById('log-' + key);
  if(!card || card.classList.contains('done') || card.classList.contains('skipped')) return;
  card.classList.add('skipped');
  appendTagRow(card, key, 'skipped-tag', 'Skipped for ' + logDateLabel().toLowerCase());
  if(!silent) toast('Skipped — your plan stays balanced');

  markSlotSkipped(currentLogDateISO(), currentProf, key);
  if(currentLogDateISO() === todayISO()) renderTodayCardActions(); // mirror the skip onto Today cards only for today
  persist();
}

// Builds the four "Today's plan" cards on the Log screen from the active menu (today's
// row of weekPlan for the current person — kcal/protein are portion-scaled computed
// values). Re-running this rebuilds the cards fresh, then replays today's persisted
// confirm/skip status back onto them (restoreTodayLog, app.js) so confirms survive
// profile switches and plan re-renders within the same day.
// FIX 1 (feedback): breakfast is a normal meal now — same Confirm/Swap/Skip actions as
// lunch/dinner/snack, nothing pre-logged. All four slots go through the same
// buildLogSlotCard() path (the old breakfast-only "always done" branch is gone).
function renderLogPlan(){
  logMenu = computeMenuForDate(currentLogDateISO(), currentProf);
  const title = document.getElementById('logPlanTitle'); if(title) title.textContent = logDateLabel() + "'s plan";
  const soFar = document.getElementById('logSoFarTitle'); if(soFar) soFar.textContent = logDateLabel() + ' so far';
  const coffee = document.getElementById('coffeeCountTitle'); if(coffee) coffee.textContent = 'Coffee ' + logDateLabel().toLowerCase();
  SLOT_ORDER.forEach(function(slot){
    const v = logSlotView(slot);
    buildLogSlotCard(slot, v.recipe.emoji, mealTitleWithExtras(v), v.kcal, SLOT_LABEL[slot] + ' · ' + macroSummaryFromTotals(v), v.portion);
  });

  updateLogTotalPill();
  renderTodaySoFar();
  renderTodayRecords();
  renderBeverageCounts();

  if(typeof restoreTodayLog === 'function') restoreTodayLog();
}

function buildLogSlotCard(slot, emoji, title, kcal, desc, portionOverride){
  EMOJI[slot] = emoji; TITLES[slot] = title; LOGKCAL[slot] = kcal;
  const card = document.getElementById('log-' + slot);
  card.className = 'card meal';
  card.style.cursor = 'default';
  // Servings-eaten stepper (FEATURE: recipe servings) — the plan entry's portion is
  // "servings of the recipe", user-adjustable before confirming.
  const portion = (typeof portionOverride === 'number') ? portionOverride : ((activeMenu && activeMenu[slot]) ? activeMenu[slot].portion : 1);
  const dateISO = currentLogDateISO();
  const canEditSelectedDate = dateISO <= todayISO();
  const swapAction = canEditSelectedDate ? '<button class="la-swap" onclick="openLogSwap(\''+slot+'\',\'log-'+slot+'\')">Swap</button>' : '';
  // USER FEEDBACK item 3: relabel to "Edit" once the meal has extras, same as the Today
  // card's add button — the only path to removing an extra, so it shouldn't read as "add".
  const hasExtras = logSlotView(slot).extras.length > 0;
  const addAction = canEditSelectedDate ? ('<button class="la-swap" aria-label="'+(hasExtras ? 'Edit ' : 'Add to ')+(SLOT_LABEL[slot] || slot)+'" onclick="openAddMealRecipeSheet(\''+slot+'\',\''+jsAttr(dateISO)+'\')">'+(hasExtras ? '✎ Edit' : '+ Add')+'</button>') : '';
  const servingStepper = canEditSelectedDate ? '<span class="sv-stepper" style="margin-left:auto">'
    + '<button onclick="stepMealServings(\''+slot+'\',-0.5,\''+jsAttr(dateISO)+'\')" aria-label="Fewer servings">-</button>'
    + '<span class="sv-val">'+portion+'x</span>'
    + '<button onclick="stepMealServings(\''+slot+'\',0.5,\''+jsAttr(dateISO)+'\')" aria-label="More servings">+</button>'
    + '</span>' : '';
  card.innerHTML = '<div class="thumb">'+emoji+'</div><div class="info">'
    + '<div class="row between"><span class="t">'+escapeHtml(title)+'</span><span class="kcal">'+kcal+'</span></div>'
    + '<div class="d">'+desc+'</div>'
    + '<div class="logactions">'
    + '<button class="la-confirm" onclick="logConfirm(\''+slot+'\')">Confirm</button>'
    + swapAction
    + addAction
    + '<button class="la-skip" onclick="logSkip(\''+slot+'\')">Skip</button>'
    + servingStepper
    + '</div></div>';
}

/* ---------------- shared-meals toggle + Today rendering ---------------- */
function loggedPlanEntryForSlot(dateISO, personKey, slot){
  const day = logHistory[dateISO];
  if(!day) return null;
  const arr = Array.isArray(day[personKey]) ? day[personKey] : [];
  for(let i = arr.length - 1; i >= 0; i--){
    const e = arr[i];
    if(e && e.kind === 'plan' && e.slot === slot) return e;
  }
  return null;
}

function displayedSlotViewForDate(dateISO, personKey, slot, planned){
  const logged = loggedPlanEntryForSlot(dateISO, personKey, slot);
  if(logged && RECIPES_DB[logged.ref]){
    const nut = roundedNutritionTotals(logEntryNutrition(logged));
    const loggedComponents = Array.isArray(logged.components) && logged.components.length ? logged.components : [{recipeId: logged.ref, portion: logged.portion}];
    return {
      recipeId: logged.ref,
      recipe: RECIPES_DB[logged.ref],
      opts: loggedComponents[0] && loggedComponents[0].opts,
      components: loggedComponents,
      extras: loggedComponents.slice(1),
      kcal: nut.kcal,
      protein: nut.protein,
      carbs: nut.carbs,
      fat: nut.fat,
      satFat: nut.satFat,
      fiber: nut.fiber,
      sugars: nut.sugars,
      freeSugars: nut.freeSugars,
      portion: (typeof logged.portion === 'number') ? logged.portion : 1,
      shared: planned ? !!planned.shared : false,
      logged: true
    };
  }
  const recipe = planned && RECIPES_DB[planned.recipeId];
  const nut = planned ? roundedNutritionTotals(planEntryNutrition(planned)) : null;
  const plannedComponents = planned ? planEntryComponents(planned) : [];
  return {
    recipeId: planned ? planned.recipeId : null,
    recipe: recipe,
    opts: plannedComponents[0] && plannedComponents[0].opts,
    components: plannedComponents,
    extras: plannedComponents.slice(1),
    kcal: nut ? nut.kcal : 0,
    protein: nut ? nut.protein : 0,
    carbs: nut ? nut.carbs : 0,
    fat: nut ? nut.fat : 0,
    satFat: nut ? nut.satFat : 0,
    fiber: nut ? nut.fiber : 0,
    sugars: nut ? nut.sugars : 0,
    freeSugars: nut ? nut.freeSugars : 0,
    portion: planned ? planned.portion : 1,
    shared: planned ? !!planned.shared : false,
    logged: false
  };
}

function todaySlotView(slot){
  return displayedSlotViewForDate(todayISO(), currentProf, slot, activeMenu && activeMenu[slot]);
}

function logSlotView(slot){
  const dateISO = currentLogDateISO();
  const menu = logMenu || computeMenuForDate(dateISO, currentProf);
  return displayedSlotViewForDate(dateISO, currentProf, slot, menu && menu[slot]);
}

function displayedTodayRecipeId(slot){
  const view = todaySlotView(slot);
  return view.recipeId;
}

// task D1: base title runs through recipeDisplayTitle(view.recipeId, view.opts) — appends
// the chosen variant's label(s) in parens for a recipe with optionGroups, unchanged for
// one without — so every Today/Week/pinned-routine card reading this (see call sites)
// shows the actual planned/logged variant, never just the bare recipe title.
function mealTitleWithExtras(view){
  if(!view || !view.recipe) return '';
  const extras = (view.extras || []).map(function(c){
    return componentTitle(c);
  }).filter(Boolean);
  return recipeDisplayTitle(view.recipeId, view.opts) + (extras.length ? ' + ' + extras.join(' + ') : '');
}

function logEntryTitleWithComponents(entry){
  if(!entry || entry.kind !== 'plan') return '';
  const parts = Array.isArray(entry.components) ? entry.components : [];
  const baseOpts = parts[0] && parts[0].opts;
  const base = RECIPES_DB[entry.ref] ? recipeDisplayTitle(entry.ref, baseOpts) : 'Meal';
  const extras = parts.slice(1).map(componentTitle).filter(Boolean);
  return base + (extras.length ? ' + ' + extras.join(' + ') : '');
}

function toggleShared(slot, el){
  SHARED[slot] = !SHARED[slot];
  el.classList.toggle('sel', SHARED[slot]);
  el.querySelector('.ck').textContent = SHARED[slot] ? '✓' : '';
  const sub = el.querySelector('.od');
  if(sub) sub.textContent = SHARED[slot] ? 'Shared' : 'Solo';
  toast(SHARED[slot]
    ? SLOT_LABEL[slot] + ' is now shared — one recipe, two portions'
    : SLOT_LABEL[slot] + ' is now solo — planned per person');
  // Shared-toggles are part of the plan signature, so the next ensureWeekPlan() (inside
  // renderTodayMeals -> computeActiveMenu) regenerates the week; refresh every surface.
  renderTogetherPills();
  renderLogPlan();
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderWeek();
  if(document.getElementById('recipe').classList.contains('active')) updateServings();
  persist();
}

function renderTogetherPills(){
  renderTodayMeals();
}

// Renders all four Today cards from the active menu — today's row of weekPlan for the
// current person (task C2). Kcal shown are the person's portion-scaled computed values.
// Belt-and-suspenders fallback for a slot whose planned/logged recipeId doesn't resolve
// in RECIPES_DB (a dangling reference should already be caught upstream by
// planner.js:planReferencesMissingRecipe + the mealRecipesValid guards in
// preserveLoggedSlots/preservePinnedSlots, but this keeps one bad slot from blanking the
// whole Today screen — renderWeek() already has the equivalent `if(!r) return ''` guard).
const MISSING_RECIPE_FALLBACK = {emoji: '❓', title: 'Meal unavailable'};

function renderTodayMeals(){
  activeMenu = computeActiveMenu();

  function tagsHtml(recipeId, slot, pillId, shared){
    // Diet/trait pills (Plant-based, High fiber, etc.) hidden on Today summary cards —
    // they stay visible in the recipe detail view (renderRecipeScreen).
    const showTogetherPill = !!shared && !(typeof isSoloHousehold === 'function' && isSoloHousehold());
    return '<span class="pill together mini" id="'+pillId+'" style="display:'+(showTogetherPill?'inline-flex':'none')+'">👥 Together</span>';
  }

  const bfv = todaySlotView('breakfast'), bf = bfv.recipe || MISSING_RECIPE_FALLBACK;
  document.getElementById('bfEmoji').textContent = bf.emoji;
  document.getElementById('bfTitle').textContent = bfv.recipe ? mealTitleWithExtras(bfv) : bf.title;
  document.getElementById('bfKcal').textContent = bfv.kcal;
  document.getElementById('bfDesc').textContent = 'Breakfast · ' + macroSummaryFromTotals(bfv);
  document.getElementById('bfTags').innerHTML = tagsHtml(bfv.recipeId, 'breakfast', 'pillBreakfast', bfv.shared);

  const luv = todaySlotView('lunch'), lu = luv.recipe || MISSING_RECIPE_FALLBACK;
  document.getElementById('lunchThumb').textContent = lu.emoji;
  document.getElementById('lunchTitle').textContent = luv.recipe ? mealTitleWithExtras(luv) : lu.title;
  document.getElementById('lunchKcal').textContent = luv.kcal;
  document.getElementById('lunchDesc').textContent = 'Lunch · ' + macroSummaryFromTotals(luv);
  document.getElementById('lunchTags').innerHTML = tagsHtml(luv.recipeId, 'lunch', 'pillLunch', luv.shared);

  const div_ = todaySlotView('dinner'), di = div_.recipe || MISSING_RECIPE_FALLBACK;
  document.getElementById('dinnerThumb').textContent = di.emoji;
  document.getElementById('dinnerTitle').textContent = div_.recipe ? mealTitleWithExtras(div_) : di.title;
  document.getElementById('dinnerKcal').textContent = div_.kcal;
  document.getElementById('dinnerDesc').textContent = 'Dinner · ' + macroSummaryFromTotals(div_);
  document.getElementById('dinnerTags').innerHTML = tagsHtml(div_.recipeId, 'dinner', 'pillDinner', div_.shared);

  const snv = todaySlotView('snack'), sn = snv.recipe || MISSING_RECIPE_FALLBACK;
  document.getElementById('snackThumbEl').textContent = sn.emoji;
  document.getElementById('snackTitleEl').textContent = snv.recipe ? mealTitleWithExtras(snv) : sn.title;
  document.getElementById('snackKcalEl').textContent = snv.kcal;
  document.getElementById('snackDescEl').textContent = 'Snack · ' + macroSummaryFromTotals(snv);
  document.getElementById('snackTags').innerHTML = tagsHtml(snv.recipeId, 'snack', 'pillSnack', snv.shared);

  renderTodayCardActions(); // FIX 1: paint each card's Confirm/Skip or Logged/Skipped+Undo row
  renderTodayRecords();
}

/* ---------------- editable basics ---------------- */
// Renders the Basics section for the current profile: sex segments, DOB + computed age,
// height/weight steppers, activity options, and the daily-target row with its
// computed/custom state, restore action and transparent formula line.

function renderProgressDots(){
  var wrap = document.getElementById('progressDots');
  if(!wrap) return;
  var slots = ['breakfast', 'lunch', 'dinner', 'snack'];
  var emojis = {};
  var bfv = todaySlotView('breakfast');
  var luv = todaySlotView('lunch');
  var div_ = todaySlotView('dinner');
  var snv = todaySlotView('snack');
  emojis.breakfast = (bfv.recipe || {}).emoji || '🥣';
  emojis.lunch = (luv.recipe || {}).emoji || '🥗';
  emojis.dinner = (div_.recipe || {}).emoji || '🍽️';
  emojis.snack = (snv.recipe || {}).emoji || '🌰';
  var doneCount = 0;
  var html = '';
  slots.forEach(function(slot){
    var status = slotLogStatus(todayISO(), currentProf, slot);
    var cls = 'pdot';
    if(status === 'confirmed'){ cls += ' pdot-done'; doneCount++; }
    else if(status === 'skipped'){ cls += ' pdot-skipped'; doneCount++; }
    html += '<div class="' + cls + '" onclick="scrollToMealCard(\'' + slot + '\')" title="' + slot + '">' + emojis[slot] + '</div>';
  });
  html += '<span class="pdot-label">' + doneCount + ' of 4 logged</span>';
  wrap.innerHTML = html;
}

function scrollToMealCard(slot){
  var ids = {breakfast:'todayBreakfastCard', lunch:'todayLunchCard', dinner:'todayDinnerCard', snack:'todaySnack'};
  var el = document.getElementById(ids[slot]);
  if(el) el.scrollIntoView({behavior:'smooth', block:'center'});
}

function renderEatenStrip(){
  var wrap = document.getElementById('eatenStripWrap');
  var strip = document.getElementById('eatenStrip');
  var label = document.getElementById('eatenStripLabel');
  if(!wrap || !strip) return;
  var raw = getDayLog(todayISO())[currentProf];
  if(!raw || !raw.length){
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  var total = raw.reduce(function(s, e){ return s + logEntryNutrition(e).kcal; }, 0);
  if(label) label.textContent = 'Eaten so far · ' + Math.round(total) + ' kcal';
  var html = '';
  // Group by slot/food for compact display (reuse grouped records)
  var groups = groupedTodayRecords();
  groups.forEach(function(g){
    var emoji, name;
    if(g.kind === 'plan'){
      var r = RECIPES_DB[g.entry.ref];
      emoji = r ? r.emoji : '🍽️';
      name = r ? r.title : 'Meal';
      if(name.length > 14) name = name.slice(0, 13) + '…';
    } else {
      emoji = '🥄';
      var food = FOODS[g.ref];
      name = food ? food.name : 'Food';
      if(name.length > 14) name = name.slice(0, 13) + '…';
    }
    var kcal = g.kind === 'plan' ? Math.round(logEntryNutrition(g.entry).kcal) : Math.round(g.kcal);
    html += '<div class="eaten-chip"><span class="ec-icon">' + emoji + '</span>' + escapeHtml(name) + ' <span class="ec-kcal">' + kcal + '</span></div>';
  });
  html += '<div class="eaten-chip eaten-chip-add" onclick="go(\'log\')"><span class="ec-icon">+</span>Log</div>';
  strip.innerHTML = html;
}

function showArcPopover(macro, event){
  event.stopPropagation();
  var pop = document.getElementById('arcPopover');
  var dot = document.getElementById('apDot');
  var nameEl = document.getElementById('apName');
  var detailEl = document.getElementById('apDetail');
  if(!pop) return;
  var p = PROF[currentProf];
  var kcal = p.calGoalNum || 0;
  var colors = {protein: '#7f9364', carbs: '#c79a48', fat: '#be6c45'};
  var names = {protein: 'Protein', carbs: 'Carbs', fat: 'Fat'};
  var pcts = {protein: p.kP, carbs: p.kC, fat: p.kF};
  var targets = {protein: p.targetP, carbs: p.targetC, fat: p.targetF};
  var eaten = {protein: p.consumed.p, carbs: p.consumed.c, fat: p.consumed.f};
  var multiplier = {protein: 4, carbs: 4, fat: 9};
  var targetKcal = Math.round(kcal * pcts[macro] / 100);
  var eatenKcal = Math.round(eaten[macro] * multiplier[macro]);
  var leftKcal = targetKcal - eatenKcal;

  dot.style.background = colors[macro];
  nameEl.textContent = names[macro] + ' · ' + pcts[macro] + '%';
  var detail = fmtKcal(targetKcal) + ' kcal target · ' + targets[macro] + 'g';
  if(p.consumedKcal > 0){
    detail += '\n' + eaten[macro] + 'g eaten (' + fmtKcal(eatenKcal) + ' kcal)';
    if(leftKcal < 0){
      detail += '\n⚠ ' + fmtKcal(Math.abs(leftKcal)) + ' kcal over target';
    } else {
      detail += '\n' + fmtKcal(leftKcal) + ' kcal remaining';
    }
  }
  detailEl.textContent = detail;
  // Use white-space pre-line for multiline
  detailEl.style.whiteSpace = 'pre-line';

  var ringEl = document.querySelector('.ring');
  if(ringEl){
    var ringRect = ringEl.getBoundingClientRect();
    pop.style.left = (ringRect.left + ringRect.width / 2) + 'px';
    pop.style.top = (ringRect.bottom + 8) + 'px';
    pop.style.transform = 'translateX(-50%)';
  }
  pop.classList.add('show');

  // Auto-dismiss after 4s or on next tap outside ring
  clearTimeout(window._arcPopTimer);
  window._arcPopTimer = setTimeout(function(){ pop.classList.remove('show'); }, 4000);
  if(window._arcDismiss) document.removeEventListener('click', window._arcDismiss);
  window._arcDismiss = function(e){
    if(e.target.closest && e.target.closest('.center, .ring-arc')) return;
    pop.classList.remove('show');
    document.removeEventListener('click', window._arcDismiss);
    window._arcDismiss = null;
  };
  setTimeout(function(){ document.addEventListener('click', window._arcDismiss); }, 50);
}
