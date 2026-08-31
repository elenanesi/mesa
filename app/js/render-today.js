/* render-today.js — today screen, add-meal sheet, log picker, eaten strip, progress, arc popover */
function openSwap(mealKey, targetElId){
  // Recipe screen reached from a Week row carries that row's day (recipeDayCtx) —
  // swap THAT day/week, not today. Every other entry point still resolves to today.
  const fromWeekRow = recipeDayCtx && SLOT_ORDER.indexOf(mealKey) === -1;
  const ctx = fromWeekRow
    ? {dayIndex: recipeDayCtx.dayIndex, slot: recipeDayCtx.slot, person: recipeDayCtx.person, weekStartDate: recipeDayCtx.weekStartDate}
    : resolveSwapContext(mealKey);
  openSwapSheetForContext(ctx, targetElId);
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
// "Save a composed meal as a recipe" (#5b follow-up): draft name text for the composer's
// own 💾 Save to My recipes name-entry step (openSaveComposedMealSheet/
// buildSaveComposedMealSheet/confirmSaveComposedMeal below) — same "one module-level draft
// var, repainted straight into #sheetBody" pattern addMealFoodQuery above already uses.
let saveComposedMealName = '';

// (b)/(a) fix: the sheet is now sections instead of one undifferentiated, slot-filtered
// pile — "In this meal" (with a remove control per extra), "Sides", and "Full recipes" (every remaining recipe from ANY
// slot, not just this one — owner complaint (a): "I should always be able to add both sides
// specifically or full main course recipes"). `components` is the meal's CURRENT components
// (base + extras) so all three pick lists exclude what's already in — same resolution
// openAddMealRecipeSheet already had.
function mealTitleSort(a, b){
  // PERSONAL-PREFS: three tiers by the CURRENTLY ACTIVE person's own prefs — favorites first,
  // thumbs-DOWN last, everything else in between — each tier alphabetical by title.
  const activePrefs = recipePrefs[currentProf] || {};
  const rank = function(id){ const p = activePrefs[id]; return p === 'favorite' ? 0 : (p === 'down' ? 2 : 1); };
  const ra = rank(a), rb = rank(b);
  if(ra !== rb) return ra - rb;
  return RECIPES_DB[a].title < RECIPES_DB[b].title ? -1 : (RECIPES_DB[a].title > RECIPES_DB[b].title ? 1 : 0);
}
function mealRecipeOptions(components){
  const used = {};
  (components || []).forEach(function(c){ if(c.recipeId) used[c.recipeId] = true; });
  const ids = Object.keys(RECIPES_DB).filter(function(id){ return !used[id]; });
  const isSide = function(id){ return recipeSlotList(RECIPES_DB[id]).indexOf('side') !== -1; };
  return {
    sides: ids.filter(isSide).sort(mealTitleSort),
    full: ids.filter(function(id){ return !isSide(id); }).sort(mealTitleSort)
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
  // A per-item weight (avgG) means "one" is the natural default amount — for a unit:'piece'
  // food and for a per-100g food that declares avgG (owner 2026-08-24: editable item weight).
  if(Number(food.avgG) > 0) return Number(food.avgG);
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
  // #5a: ONE unified "ate out / eating out" entry (replaces two confusingly-similar buttons —
  // the old "Eating out" toggle and a separate "Ate out — log an estimate"). It opens the
  // ate-out sheet, which — when this slot has a planned meal — lets the user pick "I ate my
  // planned meal" (keep Mesa's VERIFIED computed macros; the toggleWeekMealEatenOut path) OR
  // "I ate something different" (a typed ESTIMATE). Both capabilities stay reachable in one
  // place. The label reflects current eaten-out state so the Week/Today row's state is still
  // legible at a glance.
  // When there's a planned meal in this slot, the button is a DIRECT one-tap toggle: its label
  // already reads like a toggle ("Ate out / eating out" ↔ "Eaten out — tap to change"), so tapping
  // it marks/unmarks the planned meal eaten out right away (keeping Mesa's computed macros) instead
  // of opening a sheet the user then has to complete — the reported "I tapped it but it stayed
  // un-clicked" confusion. "Log something different" stays as a secondary link for the estimate path.
  const hasPlannedMeal = !!(entry && entry.recipeId) || !!logged;
  if(hasPlannedMeal){
    html += '<button class="cta ghostbtn" onclick="ateOutToggleDirect()">'
      + (isEatenOut ? '🍴 Eaten out — tap to change' : '🍴 Ate out / eating out')
      + '</button>'
      + '<p class="sub" style="margin-top:4px;text-align:center"><button class="week-standalone-link" onclick="openAteOutSheet(addMealCtx)">…or log something different you ate</button></p>';
  } else {
    html += '<button class="cta ghostbtn" onclick="openAteOutSheet(addMealCtx)">'
      + '🍴 Ate out / eating out'
      + '</button>';
  }

  // "Save a composed meal as a recipe" (#5b follow-up): flattens this meal's base recipe +
  // extras into a new custom recipe (library.js:saveComposedMealAsRecipe) — only worth
  // offering once there's actually a meal composed here (allComponents mirrors the "In this
  // meal" section built just below, so this stays in lockstep with what's on screen).
  // A slot with ≥2 recipe DISHES (base + a recipe extra) is a "Meal" you can save with its dishes
  // kept as structure (saveSlotAsMeal). A slot that's just one dish + food extras still saves the old
  // way (flattened into one recipe). Same entry point, wording adapts to what's actually here.
  const recipeDishes = allComponents.filter(function(c){ return c && c.recipeId; }).length;
  if(recipeDishes >= 2){
    html += '<button class="cta ghostbtn" onclick="openSaveComposedMealSheet()">🍽️ Save as a Meal</button>';
  } else if(allComponents.length){
    html += '<button class="cta ghostbtn" onclick="openSaveComposedMealSheet()">💾 Save to My recipes</button>';
  }

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
    // A recipe extra steps by 0.5 servings (kept as a stepper — "Nx" is a different unit); a FOOD
    // extra gets a typeable grams input (anchor) with the +/- kept. The input carries data-act +
    // the row's data-food-id, so the delegated change handler commits without interpolating the
    // user-authored id into inline JS (onfocus/Enter-blur are static, id-free).
    // A food extra's amount is entered in the food's OWN units (item / tbsp / tsp / cup / g — engine.js
    // foodMeasureOptions), with a live "= N g"; grams stay the stored anchor. Same UI the log picker
    // uses. A food with only grams shows just grams (no picker). Recipe extras step by 0.5 servings.
    let valPart, unitPicker = '';
    if(isRecipe){
      valPart = '<span class="sv-val">' + (((typeof c.portion === 'number' && c.portion > 0) ? c.portion : 1) + 'x') + '</span>';
    } else {
      const opts = foodMeasureOptions(c.foodId);
      const unit = mealExtraFoodUnitFor(c.foodId);
      const gpu = foodGramsPerUnit(c.foodId, unit);
      const count = c.grams / gpu;
      valPart = '<input class="sv-val" type="text" inputmode="decimal" data-act="setamount" value="' + formatLogCount(count) + '" onfocus="this.select()" onkeydown="if(event.key===\'Enter\'){this.blur();}" aria-label="Amount of ' + htmlAttr(title) + '"><span class="sv-unit">' + logUnitLabel(unit) + '</span>';
      if(opts.length > 1){
        unitPicker = '<div class="meal-extra-units">'
          + opts.map(function(o){ return '<button data-act="setunit" data-unit="' + o.unit + '" class="' + (o.unit === unit ? 'on' : '') + '">' + logUnitLabel(o.unit) + '</button>'; }).join('')
          + ((unit !== 'g' && unit !== 'ml') ? '<span class="meal-extra-grams">= ' + Math.round(c.grams) + ' g</span>' : '')
          + '</div>';
      }
    }
    const stepperInner = isBase ? '' : ('<span class="sv-stepper">'
      + '<button data-act="minus" aria-label="' + (isRecipe ? 'Fewer servings of ' : 'Less ') + htmlAttr(title) + '">-</button>'
      + valPart
      + '<button data-act="plus" aria-label="' + (isRecipe ? 'More servings of ' : 'More ') + htmlAttr(title) + '">+</button>'
      + '</span>');
    const removeBtn = isBase ? '' : '<button class="tag-undo meal-extra-remove" data-act="remove" aria-label="Remove ' + htmlAttr(title) + '">✕</button>';
    if(isRecipe){
      // Recipe / base component: the portion stepper (or nothing, for the base) sits compactly on
      // the right — no unit picker to make room for, so the single row fits fine.
      html += '<div class="altrow" style="cursor:default" data-recipe-id="' + htmlAttr(c.recipeId) + '">'
        + '<div class="ae">' + emoji + '</div>'
        + '<div class="at"><div class="an">' + escapeHtml(title) + '</div>'
        + '<div class="ad">' + (isBase ? 'Base · ' : '') + nut.kcal + ' kcal · ' + nut.protein + 'g protein</div></div>'
        + (stepperInner ? '<span class="meal-extra-side">' + stepperInner + '</span>' : '')
        + removeBtn
        + '</div>';
    } else {
      // Food extra: the name (+ a compact ✕) goes on top; the amount stepper and unit picker get
      // their OWN full-width line below. Cramming them onto the name's row crushed it into ugly
      // wrapping (owner feedback) — this gives every control room to breathe.
      html += '<div class="altrow meal-extra-row" style="cursor:default" data-food-id="' + htmlAttr(c.foodId) + '">'
        + '<div class="ae">' + emoji + '</div>'
        + '<div class="at">'
        +   '<div class="an-row"><span class="an">' + escapeHtml(title) + '</span>' + removeBtn + '</div>'
        +   '<div class="ad">' + nut.kcal + ' kcal · ' + nut.protein + 'g protein</div>'
        +   '<div class="meal-extra-controls">' + stepperInner + unitPicker + '</div>'
        + '</div>'
        + '</div>';
    }
  });

  html += '<div class="shop-cat">Ingredients</div>'
    + '<input class="inp" style="width:100%;box-sizing:border-box;border:1px solid var(--line);margin-top:8px" type="text" id="mealFoodSearchInput" placeholder="Search ingredients…" value="' + htmlAttr(addMealFoodQuery) + '" oninput="onMealFoodSearch(this.value)" autocomplete="off">'
    + '<div id="mealFoodResults" style="margin-top:4px">' + renderMealFoodResults(addMealFoodQuery) + '</div>';

  html += '<div class="shop-cat">Sides</div>';
  html += opts.sides.length ? opts.sides.map(mealRecipeOptionRowHtml).join('') : '<p class="sub" style="margin-top:6px">No side recipes available.</p>';

  html += '<div class="shop-cat">Full recipes</div>';
  html += opts.full.length ? opts.full.map(mealRecipeOptionRowHtml).join('') : '<p class="sub" style="margin-top:6px">No other recipes available.</p>';

  document.getElementById('sheetBody').innerHTML = html;
  attachAddMealSheetHandler();
  document.getElementById('sheet').classList.add('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

// "Save a composed meal as a recipe" (#5b follow-up): resolves addMealCtx's LIVE plan
// entry, the same {weekStartDate, dayIndex, slot, person} resolution the sheet's own commit
// paths (e.g. toggleMealShareFromSheet) use — not the `logged` snapshot
// openAddMealSheetForContext also handles, since this always saves what's CURRENTLY planned
// for this slot, not a historical logged estimate.
function resolveAddMealCtxEntry(){
  if(!addMealCtx) return null;
  const plan = ensureWeekPlan(addMealCtx.weekStartDate);
  const day = plan.days[addMealCtx.dayIndex];
  const meal = day && day.meals[addMealCtx.slot];
  return meal ? meal[addMealCtx.person] : null;
}

// Opens the composer's own tiny name-entry step in place of the main sheet body (same
// "repaint #sheetBody with a smaller step" pattern as library.js's pantry-add qty sheet) —
// defaults the name to the base recipe's title + " (my version)" as a starting point the
// user can overwrite.
// True when the current slot holds ≥2 recipe dishes — i.e. saving it captures a "Meal" (structure
// kept via saveSlotAsMeal), not just a customised single dish (flattened via saveComposedMealAsRecipe).
function addMealCtxIsMeal(){
  const entry = resolveAddMealCtxEntry();
  return !!entry && typeof slotRecipeDishCount === 'function' && slotRecipeDishCount(entry) >= 2;
}

function openSaveComposedMealSheet(){
  const entry = resolveAddMealCtxEntry();
  if(!entry){ toast('Meal not found'); return; }
  const base = entry.recipeId && RECIPES_DB[entry.recipeId];
  // A Meal defaults to the main dish's name (rename to "our Sunday roast" etc.); a single-dish save
  // keeps the "(my version)" default it always had.
  saveComposedMealName = addMealCtxIsMeal() ? (base ? base.title : '') : (base ? (base.title + ' (my version)') : '');
  document.getElementById('sheetBody').innerHTML = buildSaveComposedMealSheet();
}

function buildSaveComposedMealSheet(){
  const isMeal = addMealCtxIsMeal();
  const title = isMeal ? 'Save as a Meal' : 'Save to My recipes';
  const blurb = isMeal
    ? 'Name this Meal — the dishes you had together — to plan it again as one. Mesa keeps each dish, so the shopping list and numbers stay exact.'
    : 'Give this composed meal a name to save it as a new recipe you can plan again.';
  const cta = isMeal ? '🍽️ Save as a Meal' : '💾 Save to My recipes';
  return '<div class="row between" style="margin-top:6px"><h2 style="margin:0">' + title + '</h2>'
    + '<button class="backbtn" style="margin:0" onclick="openAddMealSheetForContext(addMealCtx)">‹ Back</button></div>'
    + '<p class="sub" style="margin-top:6px">' + blurb + '</p>'
    + '<input class="inp" style="width:100%;box-sizing:border-box;border:1px solid var(--line);margin-top:8px" type="text" id="saveComposedMealNameInput" value="' + htmlAttr(saveComposedMealName) + '" oninput="saveComposedMealName=this.value" placeholder="' + (isMeal ? 'Meal name' : 'Recipe name') + '" autocomplete="off">'
    + '<button class="cta" style="margin-top:14px" onclick="confirmSaveComposedMeal()">' + cta + '</button>'
    + '<button class="cta ghostbtn" onclick="openAddMealSheetForContext(addMealCtx)">Cancel</button>';
}

function confirmSaveComposedMeal(){
  const entry = resolveAddMealCtxEntry();
  if(!entry){ toast('Meal not found'); return; }
  const name = (saveComposedMealName || '').trim();
  const isMeal = addMealCtxIsMeal();
  if(!name){ toast(isMeal ? 'Give this Meal a name' : 'Give this recipe a name'); return; }
  // A Meal keeps its dishes as structure (saveSlotAsMeal); a single-dish save flattens as before.
  const newId = isMeal ? saveSlotAsMeal(entry, name) : saveComposedMealAsRecipe(entry, name);
  if(!newId) return;
  toast(isMeal ? '✓ Saved as a Meal' : '✓ Saved to My recipes');
  openAddMealSheetForContext(addMealCtx);
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
  // Persist the eaten-out mark IMMEDIATELY, before the render chain. refreshAfterLogChange()
  // only persists as its LAST step, so if any render inside it throws (e.g. a DOM state issue on
  // the Week/Today screens while marking a future or shared meal) the save was skipped and the
  // mark silently reverted on the next reload — the reported "eating out doesn't persist" bug.
  persist();
  refreshAfterLogChange();
  openAddMealRecipeSheet(ctx.slot, dateISO);
  toast(turningOn ? '🍴 Marked eating out — logged & dropped from the shopping list' : '🏠 Marked home-cooked again');
}

/* ---------------- ATE-OUT-QUICK-ADD: restaurant/delivery meal with estimated macros ----------------
   The problem: logging a meal eaten out used to force authoring a whole recipe or picking
   the closest built-in food. This is a ~15-second alternative — name + three macro
   steppers, no ingredients, no recipe — for a meal Mesa never built and can't verify.
   Deliberately NOT openNewFoodForm (library.js): that sheet is the full ingredient editor
   (category, season, flags, icon picker...) built for a reusable pantry item; this one
   creates a single-use estimate and logs it in the same action.

   ateOutSheet holds the sheet's draft state while open: {name, protein, carbs, fat, ctx}.
   `ctx` is a SNAPSHOT of addMealCtx ({weekStartDate, dayIndex, slot, person}) taken at open
   time when reached from the add-meal sheet's button above — commitAteOut() below uses it
   to mark that planned slot skipped so the plan drops off the shopping list instead of
   double-counting. `ctx` is null when opened standalone (Log screen's "Ways to log" row),
   where there is no planned slot to reconcile. Snapshotting (rather than reading the
   `addMealCtx` global at commit time) keeps this sheet correct even though addMealCtx can
   keep changing while a sheet is open (e.g. the underlying screen re-renders). */
let ateOutSheet = null;

function openAteOutSheet(slotCtx){
  ateOutSheet = {name: '', protein: 0, carbs: 0, fat: 0, ctx: slotCtx || null};
  document.getElementById('sheetBody').innerHTML = buildAteOutSheet();
  document.getElementById('sheet').classList.remove('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

// 4*protein + 4*carbs + 9*fat (same Atwater convention as library.js's computeNewFoodKcal) —
// exactly what createAteOutFood (library.js) stores, so the number shown here while typing is
// what gets logged, and the food's calories always match its own macros (no rounding drift).
function ateOutKcalPreview(){
  if(!ateOutSheet) return 0;
  return 4 * ateOutSheet.protein + 4 * ateOutSheet.carbs + 9 * ateOutSheet.fat;
}

function buildAteOutSheet(){
  const s = ateOutSheet;
  if(!s) return '';
  const macroStepperRow = function(key, label){
    return '<div class="field"><label>' + label + '</label><div class="inp" style="justify-content:flex-end">'
      + '<span class="sv-stepper" style="margin:0">'
      + '<button onclick="stepAteOutMacro(\'' + key + '\',-5)" aria-label="Decrease ' + label + '">–</button>'
      + '<span class="sv-val">' + s[key] + '</span>'
      + '<button onclick="stepAteOutMacro(\'' + key + '\',5)" aria-label="Increase ' + label + '">+</button>'
      + '</span><span class="sv-unit">g</span></div></div>';
  };
  // #5a: when opened from a planned slot (ctx set from the add-meal sheet), offer the "I ate
  // my planned meal" path — keeps Mesa's VERIFIED computed macros via the same eaten-out
  // toggle — ABOVE the typed ESTIMATE below, so both eating-out actions live in one sheet.
  // ctx is null from the Log screen's standalone entry, where there is no planned meal.
  let plannedBlock = '';
  if(s.ctx){
    const dISO = addDaysISO(s.ctx.weekStartDate, s.ctx.dayIndex);
    const plan = ensureWeekPlan(s.ctx.weekStartDate);
    const meal = plan && plan.days[s.ctx.dayIndex] && plan.days[s.ctx.dayIndex].meals[s.ctx.slot];
    const entry = meal && meal[s.ctx.person];
    const plannedTitle = (entry && entry.recipeId && RECIPES_DB[entry.recipeId]) ? RECIPES_DB[entry.recipeId].title : null;
    if(plannedTitle){
      const eatenOut = slotLoggedEatenOut(dISO, s.ctx.person, s.ctx.slot);
      plannedBlock = eatenOut
        ? '<p class="sub" style="margin-top:6px">✓ Logged as eaten out — <b>' + escapeHtml(plannedTitle) + '</b> <span class="chip-computed">✓ computed</span>. '
            + '<button class="week-standalone-link" onclick="ateOutTogglePlanned()">Mark home-cooked</button></p>'
            + '<div class="shop-cat">Or — log something different you ate instead</div>'
        : '<div class="shop-cat">I ate my planned meal</div>'
            + '<button class="cta ghostbtn" onclick="ateOutTogglePlanned()">✓ ' + escapeHtml(plannedTitle) + ' — log eaten out <span class="chip-computed">✓ computed</span></button>'
            + '<div class="shop-cat">Or — I ate something different</div>';
    }
  }
  // Meal builder (owner spec 2026-08-17): building the meal from its actual ingredients
  // gives COMPUTED macros (✓ — the same deterministic-trust guarantee every other logged
  // meal carries) instead of the typed P/C/F guess below, so it's offered first/prominently
  // regardless of whether there's a planned meal to fall back to. The typed fields become the
  // secondary "or type a rough estimate" path — still fully functional (a real meal Mesa
  // truly can't decompose, e.g. a restaurant dish with no known ingredients), just demoted.
  const buildFromIngredientsBlock = '<button class="cta ghostbtn" style="margin-top:6px" onclick="openMealBuilderFromAteOut()">🧩 Build it from ingredients</button>';
  return '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Ate out</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
    + plannedBlock
    + buildFromIngredientsBlock
    + '<div class="shop-cat" style="margin-top:14px">Or — type a rough estimate</div>'
    + '<p class="sub" style="margin-top:6px">Log a meal Mesa didn’t build — just a name and a rough macro guess.</p>'
    + '<div class="field"><label>Name</label>'
    + '<input class="inp" style="width:100%;box-sizing:border-box;border:1px solid var(--line);margin-top:6px" type="text" value="' + htmlAttr(s.name) + '" oninput="ateOutSheet.name=this.value" placeholder="e.g. Dinner at Luigi’s" autocomplete="off"></div>'
    + macroStepperRow('protein', 'Protein')
    + macroStepperRow('carbs', 'Carbs')
    + macroStepperRow('fat', 'Fat')
    + '<div class="field"><label>Calories <span style="color:var(--muted);font-weight:400;font-size:11px">· estimated, not verified</span></label><div class="inp"><span>Estimated</span><b>≈ ' + ateOutKcalPreview() + ' kcal</b></div></div>'
    + '<div class="cap-note">Estimated — Mesa can’t verify a meal it didn’t build.</div>'
    + '<button class="cta" style="margin-top:14px" onclick="commitAteOut()">🍴 Log this meal</button>'
    + '<button class="cta ghostbtn" onclick="closeSheet()">Cancel</button>';
}

// "🧩 Build it from ingredients" (ate-out sheet secondary-path promotion, owner spec
// 2026-08-17): hands off to the meal builder in mode:'eatenOut', carrying this sheet's own
// ctx snapshot — same snapshot-then-null-then-handoff pattern ateOutTogglePlanned() above
// already uses — so a slot-context open still knows which plan slot to reconcile, while a
// standalone open (ctx null, Log screen's "Ways to log" row) still opens the builder (its
// footer then offers only "Save to My recipes" — "Log as eaten out" needs a slot ctx, per
// mealBuilder's own mode/ctx-gated footer in buildMealBuilderSheet).
function openMealBuilderFromAteOut(){
  if(!ateOutSheet) return;
  const ctx = ateOutSheet.ctx;
  ateOutSheet = null;
  openMealBuilder(ctx, 'eatenOut');
}

function stepAteOutMacro(key, delta){
  if(!ateOutSheet) return;
  ateOutSheet[key] = Math.max(0, ateOutSheet[key] + delta);
  document.getElementById('sheetBody').innerHTML = buildAteOutSheet();
}

// Creates the one-off food (library.js:createAteOutFood), logs it for the slot's own date
// (or the currently-viewed Log date when opened standalone) under that slot's own person
// (or currentProf when standalone — see the ctx doc above), flags it eatenOut so it never
// depletes the pantry, and — only when opened from a planned slot — skips that slot via the
// same markSlotSkipped() the Week screen's ∅ button uses, so the plan drops off the
// shopping list instead of sitting there double-counted alongside this estimate.
function commitAteOut(){
  if(!ateOutSheet) return;
  const name = (ateOutSheet.name || '').trim();
  if(!name){ toast('Give this meal a name'); return; }
  if(!(ateOutSheet.protein > 0 || ateOutSheet.carbs > 0 || ateOutSheet.fat > 0)){ toast('Enter at least one macro above 0'); return; }
  const ctx = ateOutSheet.ctx;
  const person = ctx ? ctx.person : currentProf;
  const dateISO = ctx ? addDaysISO(ctx.weekStartDate, ctx.dayIndex) : currentLogDateISO();
  const foodId = createAteOutFood({name: name, protein: ateOutSheet.protein, carbs: ateOutSheet.carbs, fat: ateOutSheet.fat});
  const entry = logFoodEntry(dateISO, person, foodId, 1);
  const idx = getDayLog(dateISO)[person].indexOf(entry);
  if(idx !== -1) setLogEntryEatenOut(dateISO, person, idx, true);
  if(ctx) markSlotSkipped(dateISO, ctx.person, ctx.slot);
  ateOutSheet = null;
  refreshAfterLogChange();
  closeSheet();
  toast('🍴 Logged ' + name);
}

// #5a: the "I ate my planned meal" / "Mark home-cooked" action inside the ate-out sheet.
// Reuses the existing eaten-out toggle (keeps the planned recipe's VERIFIED macros, drops it
// from the shopping list, skips pantry depletion). toggleWeekMealEatenOut reads the shared
// addMealCtx global, so point it at this sheet's snapshot ctx first, then hand off — it
// re-renders the add-meal sheet in place, showing the meal's new eaten-out state.
function ateOutTogglePlanned(){
  if(!ateOutSheet || !ateOutSheet.ctx) return;
  addMealCtx = ateOutSheet.ctx;
  ateOutSheet = null;
  toggleWeekMealEatenOut();
}

// One-tap "eating out" toggle straight from the add-meal sheet (no intermediate ate-out sheet) —
// used when the slot has a planned meal. addMealCtx is already set by openAddMealSheetForContext.
function ateOutToggleDirect(){
  if(addMealCtx) toggleWeekMealEatenOut();
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
      } else if(act === 'setunit'){
        if(foodId) setMealExtraFoodUnit(foodId, btn.getAttribute('data-unit'));
      } else if(act === 'minus' || act === 'plus'){
        const dir = act === 'plus' ? 1 : -1;
        if(recipeId) stepMealExtraPortion(recipeId, dir * 0.5);
        else if(foodId) stepMealExtraFoodGrams(foodId, dir * mealExtraFoodStepGrams(foodId));
      }
      return;
    }
    const addRecipeRow = e.target.closest('.altrow[data-add-recipe-id]');
    if(addRecipeRow && el.contains(addRecipeRow)){ chooseMealExtraRecipe(addRecipeRow.getAttribute('data-add-recipe-id')); return; }
    const addFoodRow = e.target.closest('.altrow[data-add-food-id]');
    if(addFoodRow && el.contains(addFoodRow)) chooseMealExtraFood(addFoodRow.getAttribute('data-add-food-id'));
  };
  // Typeable amount on a food extra (data-act="setamount") — in the food's chosen unit; commits on
  // blur/change, reading the food id from the row so no user-authored id is interpolated into inline JS.
  el.onchange = function(e){
    const input = e.target.closest('input[data-act="setamount"]');
    if(!input || !el.contains(input)) return;
    const row = input.closest('.altrow[data-food-id]');
    if(!row) return;
    commitMealExtraFoodAmount(row.getAttribute('data-food-id'), input.value);
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
  renderLogScreen();
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
  renderLogScreen();
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
  if(!confirmDeletion()) return;
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
  renderLogScreen();
  renderWeek();
  persist();
  openAddMealRecipeSheet(ctx.slot, dateISO);
  toast('✕ Removed ' + title);
}

function removeMealExtraFood(foodId){
  if(!addMealCtx) return;
  if(!confirmDeletion()) return;
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
  renderLogScreen();
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
  renderLogScreen();
  renderWeek();
  persist();
  openAddMealRecipeSheet(ctx.slot, dateISO);
}

// The current grams of a meal EXTRA food for the active add-meal context (defaults if not present).
function currentMealExtraFoodGrams(foodId){
  if(!addMealCtx || !FOODS[foodId]) return null;
  const ctx = addMealCtx;
  const dateISO = addDaysISO(ctx.weekStartDate, ctx.dayIndex);
  let current = defaultMealFoodGrams(foodId);
  if(ctx.logged){
    const loggedComp = loggedPlanEntryForSlot(dateISO, ctx.person, ctx.slot);
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
  return current;
}

// The one write path for a meal-extra food's grams (absolute). Both the +/- stepper and the
// typeable input funnel through here, so the recompute/re-render/persist is defined once.
function applyMealExtraFoodGrams(foodId, newGrams){
  if(!addMealCtx || !FOODS[foodId]) return;
  const ctx = addMealCtx;
  const dateISO = addDaysISO(ctx.weekStartDate, ctx.dayIndex);
  newGrams = Math.max(1, Math.min(2000, Math.round(newGrams)));
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
  renderLogScreen();
  renderWeek();
  persist();
  openAddMealRecipeSheet(ctx.slot, dateISO);
}

function stepMealExtraFoodGrams(foodId, delta){
  const current = currentMealExtraFoodGrams(foodId);
  if(current === null) return;
  applyMealExtraFoodGrams(foodId, current + delta);
}

// Typeable-amount commit for a meal-extra food (grams anchor). Bad/empty input just re-renders
// (reverts to the current value), same forgiving contract as the other amount inputs.
function commitMealExtraFoodGrams(foodId, raw){
  if(!addMealCtx) return;
  const v = parseDecimalInput(raw);
  if(v !== null && v > 0) applyMealExtraFoodGrams(foodId, v);
  else if(addMealCtx) openAddMealRecipeSheet(addMealCtx.slot, addDaysISO(addMealCtx.weekStartDate, addMealCtx.dayIndex));
}

// UNIT PICKER on the add-meal food extras (owner 2026-08-30): enter the amount in the food's own
// units (item / tbsp / tsp / cup / g), grams stay the anchor. mealExtraFoodUnits holds the chosen
// DISPLAY unit per food (transient, not persisted — only grams are stored on the plan entry).
let mealExtraFoodUnits = {};
function mealExtraFoodUnitFor(foodId){
  const opts = foodMeasureOptions(foodId);
  const chosen = mealExtraFoodUnits[foodId];
  if(chosen && opts.some(function(o){ return o.unit === chosen; })) return chosen;
  return foodDefaultLogUnit(foodId);
}
function setMealExtraFoodUnit(foodId, unit){
  if(!foodMeasureOptions(foodId).some(function(o){ return o.unit === unit; })) return;
  mealExtraFoodUnits[foodId] = unit;
  if(addMealCtx) openAddMealRecipeSheet(addMealCtx.slot, addDaysISO(addMealCtx.weekStartDate, addMealCtx.dayIndex));
}
// One +/- step in the current display unit, expressed in grams (the stored anchor).
function mealExtraFoodStepGrams(foodId){
  const unit = mealExtraFoodUnitFor(foodId);
  return Math.max(1, Math.round(foodUnitStep(unit) * foodGramsPerUnit(foodId, unit)));
}
// Commit a typed amount that's in the chosen unit → convert to grams and store.
function commitMealExtraFoodAmount(foodId, raw){
  if(!addMealCtx) return;
  const v = parseDecimalInput(raw);
  if(v !== null && v > 0) applyMealExtraFoodGrams(foodId, v * foodGramsPerUnit(foodId, mealExtraFoodUnitFor(foodId)));
  else openAddMealRecipeSheet(addMealCtx.slot, addDaysISO(addMealCtx.weekStartDate, addMealCtx.dayIndex));
}

/* ---------------- MEAL BUILDER: compose a one-time meal from ingredients + recipes ----------------
   owner spec (2026-08-17): the add-meal composer above (openAddMealSheetForContext) can add
   extras on top of a meal's base recipe, but can never touch the BASE recipe's OWN
   ingredients — only remove/edit extras. This fills the gap: "start from a recipe, edit its
   ingredients (add/remove), and only optionally save it" — a SEPARATE draft where every row
   is a plain {foodId, grams}, mirroring library.js's recipeBuilder.ingredients shape but with
   NO privileged base at all — every row can be edited or removed the same way.
   Deliberately does NOT touch planEntryComponents' schema (that assumes a non-null base
   recipe — changing it ripples into shopping/pantry/week, per the architecture this feature
   was scoped from); this composes entirely in its own draft and only ever writes a real
   ONE-TIME recipe (library.js:createOneTimeRecipeFromRows) at commit time, through the exact
   same customRecipes path every other custom recipe already uses.

   mealBuilder shape: {rows:[{foodId,grams}], name, ctx:{weekStartDate,dayIndex,slot,person}
   |null, mode:'plan'|'eatenOut', pickerQuery, recipeQuery}. `pickerQuery` mirrors
   recipeBuilder.pickerQuery's naming (the plain-ingredient food search); `recipeQuery` is
   this sheet's OWN addition — its recipe search, shared by BOTH "Seed from a recipe" and
   "Add a recipe's ingredients": they are the exact same explode-and-merge operation
   (addRecipeToMealBuilder below), so one search box that relabels itself by section headline
   (see buildMealBuilderSheet) avoids two redundant, easily-desynced copies of one widget. */
let mealBuilder = null;

function openMealBuilder(ctx, mode){
  mealBuilder = {rows: [], name: '', ctx: ctx || null, mode: mode === 'eatenOut' ? 'eatenOut' : 'plan', pickerQuery: '', recipeQuery: ''};
  document.getElementById('sheetBody').innerHTML = buildMealBuilderSheet();
  attachMealBuilderSheetHandler();
  document.getElementById('sheet').classList.add('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

function closeMealBuilder(){
  mealBuilder = null;
  closeSheet();
}

function repaintMealBuilderSheet(){
  const el = document.getElementById('sheetBody');
  if(el) el.innerHTML = buildMealBuilderSheet();
}

// Sums foodMacros() over every row — the builder's own live total, kept DOM-free (foodMacros
// is the app's single per-food macro source, engine.js) so it's directly testable and reused
// by both the sheet's footer preview and the one-time recipe's own totals.
function mealBuilderTotals(){
  const totals = {kcal: 0, protein: 0, carbs: 0, fat: 0};
  (mealBuilder && mealBuilder.rows ? mealBuilder.rows : []).forEach(function(row){
    const m = foodMacros(row.foodId, row.grams);
    totals.kcal += m.kcal; totals.protein += m.protein; totals.carbs += m.carbs; totals.fat += m.fat;
  });
  return totals;
}

// Merges `newRows` ({foodId,grams}) into mealBuilder.rows BY foodId — the same
// merge-by-foodId convention planner.js:flattenComponentsToIngredientRows already applies
// within a single components list, extended here to merge onto a SECOND, pre-existing list
// (whatever's already in the draft). Grams are rounded once per merged row (not accumulated
// unrounded across calls) so repeated fractional adds never compound rounding error, matching
// flattenComponentsToIngredientRows' own final rounding pass.
function mergeRowsIntoMealBuilder(newRows){
  if(!mealBuilder) return;
  (newRows || []).forEach(function(nr){
    if(!(nr.grams > 0)) return;
    const existing = mealBuilder.rows.filter(function(r){ return r.foodId === nr.foodId; })[0];
    if(existing) existing.grams = Math.round(existing.grams + nr.grams);
    else mealBuilder.rows.push({foodId: nr.foodId, grams: Math.round(nr.grams)});
  });
}

// "Seed from a recipe" AND "Add a recipe's ingredients" are the identical operation: explode
// recipeId's effective ingredients to ONE serving and merge by foodId into whatever rows
// already exist (merging into an empty draft is just "seed"). Reuses
// planner.js:flattenComponentsToIngredientRows([{recipeId,portion:1}]) rather than
// reimplementing its recipeEffectiveIngredients/batchYield scaling — that's the exact "1
// serving" math this needs. Pure/DOM-free so it's directly testable; the sheet's click
// handler (chooseMealBuilderRecipe below) wraps this with the repaint + toast.
function addRecipeToMealBuilder(recipeId){
  if(!mealBuilder || !RECIPES_DB[recipeId]) return false;
  mergeRowsIntoMealBuilder(flattenComponentsToIngredientRows([{recipeId: recipeId, portion: 1}]));
  return true;
}

function addFoodToMealBuilder(foodId, grams){
  if(!mealBuilder || !FOODS[foodId]) return false;
  mergeRowsIntoMealBuilder([{foodId: foodId, grams: (typeof grams === 'number' && grams > 0) ? grams : defaultMealFoodGrams(foodId)}]);
  return true;
}

// Recipe search pool for BOTH "Seed from a recipe" and "Add a recipe's ingredients": every
// recipe (any slot — a meal build isn't restricted to the target slot, matching the swap
// sheet's own "search any compatible recipe" latitude), built-in and custom, EXCLUDING
// oneTime:true throwaways — a meal built from a previous one-time build shouldn't itself be
// seedable, same "hide throwaways" rule as the My-recipes list (library.js:filteredRecipeIds).
function mealBuilderRecipeSearchResults(query){
  const q = String(query || '').trim().toLowerCase();
  if(q.length < 2) return [];
  return Object.keys(RECIPES_DB).filter(function(id){
    const r = RECIPES_DB[id];
    return r && !r.oneTime && swapSearchText(id).indexOf(q) !== -1;
  }).sort(function(a, b){
    return RECIPES_DB[a].title < RECIPES_DB[b].title ? -1 : (RECIPES_DB[a].title > RECIPES_DB[b].title ? 1 : 0);
  }).slice(0, 20);
}

// Recipe ids can be user-authored ('cr-…' slugs), so the id rides in a data-* attribute —
// same reasoning/pattern as mealRecipeOptionRowHtml above.
function mealBuilderRecipeRowHtml(id){
  const r = RECIPES_DB[id];
  const nut = roundedNutritionTotals(recipeNutrition(id, 1).totals);
  return '<div class="altrow" data-mb-recipe-id="' + htmlAttr(id) + '">'
    + '<div class="ae">' + r.emoji + '</div>'
    + '<div class="at"><div class="an">' + escapeHtml(r.title) + '</div>'
    + '<div class="ad">' + nut.kcal + ' kcal · ' + nut.protein + 'g protein</div></div>'
    + '</div>';
}

function mealBuilderRecipeResultsHtml(q){
  q = (q || '').trim();
  if(q.length < 2) return '<p class="sub" style="margin-top:6px">Type at least 2 letters to search recipes.</p>';
  const ids = mealBuilderRecipeSearchResults(q);
  if(!ids.length) return '<p class="sub" style="margin-top:6px">No recipes match “' + escapeHtml(q) + '”.</p>';
  return ids.map(mealBuilderRecipeRowHtml).join('');
}

function onMealBuilderRecipeSearch(value){
  if(!mealBuilder) return;
  mealBuilder.recipeQuery = value;
  const el = document.getElementById('mealBuilderRecipeResults');
  if(el) el.innerHTML = mealBuilderRecipeResultsHtml(value);
}

function chooseMealBuilderRecipe(recipeId){
  if(!addRecipeToMealBuilder(recipeId)) return;
  const title = RECIPES_DB[recipeId].title;
  mealBuilder.recipeQuery = '';
  toast('＋ Added ' + title + '’s ingredients');
  repaintMealBuilderSheet();
}

// Same "reuse render-sheets.js:searchFoods + renderMealFoodResults pattern" the add-meal
// composer's own food search already established.
function mealBuilderFoodResultsHtml(q){
  q = (q || '').trim();
  if(q.length < 2) return '<p class="sub" style="margin-top:6px">Type at least 2 letters to add plain foods.</p>';
  const ids = searchFoods(q).slice(0, 12);
  if(!ids.length) return '<p class="sub" style="margin-top:6px">No ingredients match “' + escapeHtml(q) + '”.</p>';
  return ids.map(function(id){
    const f = FOODS[id];
    const grams = defaultMealFoodGrams(id);
    const nut = roundedNutritionTotals(foodMacros(id, grams));
    return '<div class="altrow" data-mb-food-id="' + htmlAttr(id) + '">'
      + '<div class="ae">' + foodIconHtml(id) + '</div>'
      + '<div class="at"><div class="an">' + escapeHtml(f.name) + '</div>'
      + '<div class="ad">' + foodAmountLabel(f, grams) + ' · ' + nut.kcal + ' kcal · ' + nut.protein + 'g protein</div></div>'
      + '</div>';
  }).join('');
}

function onMealBuilderFoodSearch(value){
  if(!mealBuilder) return;
  mealBuilder.pickerQuery = value;
  const el = document.getElementById('mealBuilderFoodResults');
  if(el) el.innerHTML = mealBuilderFoodResultsHtml(value);
}

function chooseMealBuilderFood(foodId){
  if(!addFoodToMealBuilder(foodId)) return;
  const name = FOODS[foodId].name;
  mealBuilder.pickerQuery = '';
  toast('＋ Added ' + name);
  repaintMealBuilderSheet();
}

function stepMealBuilderRowGrams(i, delta){
  if(!mealBuilder) return;
  const row = mealBuilder.rows[i];
  if(!row) return;
  row.grams = Math.max(1, Math.min(2000, Math.round(row.grams + delta)));
  repaintMealBuilderSheet();
}
// Typeable-amount commit for a meal-builder row (grams anchor). Bad/empty input reverts to the
// current value on repaint (same forgiving contract as commitLogPickerAmount).
function commitMealBuilderRowGrams(i, raw){
  if(!mealBuilder) return;
  const row = mealBuilder.rows[i];
  if(!row) return;
  const v = parseDecimalInput(raw);
  if(v !== null && v > 0) row.grams = Math.max(1, Math.min(2000, Math.round(v)));
  repaintMealBuilderSheet();
}

function removeMealBuilderRow(i){
  if(!mealBuilder) return;
  if(!confirmDeletion()) return;
  mealBuilder.rows.splice(i, 1);
  repaintMealBuilderSheet();
}

// No base privilege (this feature's whole point): every row — whether it started life as
// part of a seeded recipe or was added one-by-one — gets the SAME grams stepper (piece-aware,
// same `isPiece` convention buildEditTodayFoodSheet's own stepper above uses) and the SAME
// ✕ Remove. Row index `i` is a controlled loop counter (not user text), so a plain inline
// onclick is safe here — same convention library.js:stepRecipeIngredientGrams already uses
// for its own by-index ingredient rows.
function mealBuilderRowHtml(row, i){
  const food = FOODS[row.foodId];
  if(!food) return '';
  const nut = roundedNutritionTotals(foodMacros(row.foodId, row.grams));
  const isPiece = food.unit === 'piece' && Number(food.avgG) > 0;
  const step = isPiece ? Number(food.avgG) : 10;
  return '<div class="altrow" style="cursor:default">'
    + '<div class="ae">' + foodIconHtml(row.foodId) + '</div>'
    + '<div class="at"><div class="an">' + escapeHtml(food.name) + '</div>'
    + '<div class="ad">' + nut.kcal + ' kcal · ' + nut.protein + 'g protein</div></div>'
    + '<span class="sv-stepper" style="margin-left:8px;flex:0 0 auto">'
    + '<button onclick="stepMealBuilderRowGrams(' + i + ',-' + step + ')" aria-label="Less ' + htmlAttr(food.name) + '">-</button>'
    // Typeable grams (grams stay the deterministic anchor); +/- kept. Mirrors the recipe-builder
    // ingredient input (library.js) and log picker (parseDecimalInput + a commit handler).
    + '<input class="sv-val" type="text" inputmode="decimal" value="' + row.grams + '" onfocus="this.select()" onkeydown="if(event.key===\'Enter\'){this.blur();}" onblur="commitMealBuilderRowGrams(' + i + ',this.value)" aria-label="Grams of ' + htmlAttr(food.name) + '"><span class="sv-unit">g</span>'
    + '<button onclick="stepMealBuilderRowGrams(' + i + ',' + step + ')" aria-label="More ' + htmlAttr(food.name) + '">+</button>'
    + '</span>'
    + '<button class="tag-undo" style="margin-left:8px;flex:0 0 auto" onclick="removeMealBuilderRow(' + i + ')">✕ Remove</button>'
    + '</div>';
}

function buildMealBuilderSheet(){
  const mb = mealBuilder;
  if(!mb) return '';
  const totals = mealBuilderTotals();
  const seeding = mb.rows.length === 0;
  let html = '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Build a meal</h2><button class="backbtn" style="margin:0" onclick="closeMealBuilder()">✕ Close</button></div>'
    + '<p class="sub" style="margin-top:6px">Combine recipes and plain ingredients into one meal — Mesa computes the calories and nutrients from what’s actually in it.</p>';

  html += '<div class="shop-cat">' + (seeding ? 'Seed from a recipe' : 'Add a recipe’s ingredients') + '</div>'
    + (seeding ? '<p class="sub" style="margin-top:4px">Start from a recipe, then add, remove or adjust anything below.</p>' : '')
    + '<input class="inp" style="width:100%;box-sizing:border-box;border:1px solid var(--line);margin-top:6px" type="search" id="mealBuilderRecipeSearchInput" placeholder="Search recipes…" value="' + htmlAttr(mb.recipeQuery) + '" oninput="onMealBuilderRecipeSearch(this.value)" autocomplete="off">'
    + '<div id="mealBuilderRecipeResults" style="margin-top:4px">' + mealBuilderRecipeResultsHtml(mb.recipeQuery) + '</div>';

  html += '<div class="shop-cat">In this meal</div>';
  html += mb.rows.length
    ? mb.rows.map(mealBuilderRowHtml).join('')
    : '<p class="sub" style="margin-top:6px">Nothing yet — add an ingredient or a recipe below.</p>';

  html += '<div class="nutri" style="margin-top:10px">'
    + '<div class="n"><div class="nt"><span>Calories</span><b>' + Math.round(totals.kcal) + ' kcal</b></div></div>'
    + '<div class="n"><div class="nt"><span>Protein</span><b>' + Math.round(totals.protein) + ' g</b></div></div>'
    + '<div class="n"><div class="nt"><span>Carbs</span><b>' + Math.round(totals.carbs) + ' g</b></div></div>'
    + '<div class="n"><div class="nt"><span>Fat</span><b>' + Math.round(totals.fat) + ' g</b></div></div>'
    + '</div>';

  html += '<div class="shop-cat">Add an ingredient</div>'
    + '<input class="inp" style="width:100%;box-sizing:border-box;border:1px solid var(--line);margin-top:8px" type="text" id="mealBuilderFoodSearchInput" placeholder="Search ingredients…" value="' + htmlAttr(mb.pickerQuery) + '" oninput="onMealBuilderFoodSearch(this.value)" autocomplete="off">'
    + '<div id="mealBuilderFoodResults" style="margin-top:4px">' + mealBuilderFoodResultsHtml(mb.pickerQuery) + '</div>';

  html += '<button class="cta ghostbtn" style="margin-top:14px" onclick="openMealBuilderSaveSheet()">💾 Save to My recipes</button>';
  if(mb.ctx && mb.mode === 'plan'){
    html += '<button class="cta" onclick="confirmMealBuilderUseForThisMeal()">🍽️ Use for this meal</button>';
  }
  if(mb.ctx && mb.mode === 'eatenOut'){
    html += '<button class="cta" onclick="confirmMealBuilderLogEatenOut()">🍴 Log as eaten out</button>';
  }
  return html;
}

// Delegated click handler for the two search-result lists (data-mb-recipe-id/data-mb-food-id
// — ids can be user-authored 'cr-'/'cf-' slugs, same reasoning attachAddMealSheetHandler's
// own doc comment gives). Assigned ONCE per real sheet-open (openMealBuilder) directly onto
// #sheetBody itself; repaintMealBuilderSheet() only ever reassigns #sheetBody's innerHTML
// (its CONTENT), never the element itself, so this delegated onclick — a property of the
// element, not part of its markup — survives every repaint, same non-accumulating pattern
// attachSwapSearchHandler/attachAddMealSheetHandler already document.
function attachMealBuilderSheetHandler(){
  const el = document.getElementById('sheetBody');
  if(!el) return;
  el.onclick = function(e){
    const recipeRow = e.target.closest('.altrow[data-mb-recipe-id]');
    if(recipeRow && el.contains(recipeRow)){ chooseMealBuilderRecipe(recipeRow.getAttribute('data-mb-recipe-id')); return; }
    const foodRow = e.target.closest('.altrow[data-mb-food-id]');
    if(foodRow && el.contains(foodRow)) chooseMealBuilderFood(foodRow.getAttribute('data-mb-food-id'));
  };
}

// "💾 Save to My recipes" footer action: a normal, reusable custom recipe (unlike the
// one-time recipes "Use for this meal"/"Log as eaten out" create below) — its own name-entry
// step, same "repaint #sheetBody with a smaller step" pattern render-today.js's own
// openSaveComposedMealSheet uses. Requires >=2 rows (its own guard, checked again inside
// confirmMealBuilderSave — saveRecipeBuilder()'s generic minimum is meant for the manual
// "New recipe" form's toast, not this sheet's own copy).
function openMealBuilderSaveSheet(){
  if(!mealBuilder) return;
  if(mealBuilder.rows.length < 2){ toast('Add another ingredient to save this as a recipe'); return; }
  document.getElementById('sheetBody').innerHTML = buildMealBuilderSaveSheet();
}

function buildMealBuilderSaveSheet(){
  const mb = mealBuilder;
  return '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Save to My recipes</h2><button class="backbtn" style="margin:0" onclick="repaintMealBuilderSheet()">‹ Back</button></div>'
    + '<p class="sub" style="margin-top:6px">Give this meal a name to save it as a recipe you can plan again.</p>'
    + '<input class="inp" style="width:100%;box-sizing:border-box;border:1px solid var(--line);margin-top:8px" type="text" id="mealBuilderSaveNameInput" value="' + htmlAttr(mb.name) + '" oninput="mealBuilder.name=this.value" placeholder="Recipe name" autocomplete="off">'
    + '<button class="cta" style="margin-top:14px" onclick="confirmMealBuilderSave()">💾 Save to My recipes</button>'
    + '<button class="cta ghostbtn" onclick="repaintMealBuilderSheet()">Cancel</button>';
}

// Reuses the recipe builder's OWN save path (library.js:saveRecipeBuilder) — the exact
// function the manual "New recipe" form AND saveComposedMealAsRecipe both already funnel
// through, so id/dup-name/tags/styles/season derivation and the customRecipes/RECIPES_DB
// write stay the ONE place that gets this right (see saveComposedMealAsRecipe's own doc
// comment for the same reasoning). Builds a fresh recipeBuilder draft straight from
// mealBuilder's OWN rows — no base privilege, exactly the flat ingredient list the user
// edited — and hands off; saveRecipeBuilder's own toast covers every abort case (no name,
// duplicate name, <2 ingredients), recognized here by recipeBuilder staying non-null.
function confirmMealBuilderSave(){
  if(!mealBuilder) return;
  const name = (mealBuilder.name || '').trim();
  if(!name){ toast('Give this recipe a name'); return; }
  if(mealBuilder.rows.length < 2){ toast('Add another ingredient to save this as a recipe'); return; }
  const slots = (mealBuilder.ctx && mealBuilder.ctx.slot) ? [mealBuilder.ctx.slot] : ['dinner'];
  recipeBuilder = {
    name: name, emoji: '🍽️', imageKey: null, imagePickerOpen: false,
    slots: slots, season: 'evergreen', role: 'full', occasional: false, time: 20, servings: 1,
    ingredients: mealBuilder.rows.map(function(r){ return {foodId: r.foodId, grams: r.grams}; }),
    optionGroups: [], stepsText: '', pickerQuery: ''
  };
  saveRecipeBuilder();
  if(recipeBuilder === null){ mealBuilder = null; closeSheet(); }
  else document.getElementById('sheetBody').innerHTML = buildMealBuilderSaveSheet(); // abort (e.g. dup name) — re-show the name step so its own toast has context to fix
}

// "🍽️ Use for this meal" (mode:'plan', shown only when ctx is set): freezes the builder's
// rows into a ONE-TIME custom recipe (library.js:createOneTimeRecipeFromRows —
// occasional:true so it never resurfaces for auto-planning, oneTime:true so it never
// clutters My recipes) and sets it as ctx's own slot via applyOneTimeMealToSlot (planner.js)
// — NOT applySwap/applySwapToPlan, which would re-portion the recipe to match whatever kcal
// was already in the slot and silently distort the exact macros the live totals just showed.
// If that slot is already CONFIRMED (logged) for its own date, corrects the log entry in
// place too — same reasoning planner.js:chooseSwapRecipe already documents for a normal
// swap: this IS a swap, just onto a freshly-minted recipe instead of an existing one, and
// must not leave a stale logged dish behind it. Requires >=1 row.
function confirmMealBuilderUseForThisMeal(){
  if(!mealBuilder || !mealBuilder.ctx) return;
  if(!mealBuilder.rows.length){ toast('Add at least one ingredient'); return; }
  const ctx = mealBuilder.ctx;
  const newId = createOneTimeRecipeFromRows(mealBuilder.rows, mealBuilder.name, [ctx.slot]);
  if(!newId){ toast('Could not build this meal'); return; }
  applyOneTimeMealToSlot(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person, newId);
  const dateISO = addDaysISO(ctx.weekStartDate, ctx.dayIndex);
  if(logHistory[dateISO]){
    const plan = editableWeekPlan(ctx.weekStartDate);
    const meal = plan.days[ctx.dayIndex].meals[ctx.slot];
    const people = meal.shared ? ['elena', 'partner'] : [ctx.person];
    people.forEach(function(person){
      if(slotLogStatus(dateISO, person, ctx.slot) !== 'confirmed') return;
      const planEntry = meal[person];
      logPlanEntry(dateISO, person, ctx.slot, planEntry.recipeId, planEntry.portion, planEntryComponents(planEntry));
    });
  }
  mealBuilder = null;
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderTodayMeals();
  renderLogScreen();
  renderWeek();
  persist();
  closeSheet();
  toast('🍽️ ' + RECIPES_DB[newId].title + ' set for this meal');
}

// "🍴 Log as eaten out" (mode:'eatenOut', shown only when ctx is set): same one-time recipe
// creation as "Use for this meal" above, then logs it eaten out exactly like
// toggleWeekMealEatenOut()'s "turning on" branch does (logPlanEntry + setLogEntryEatenOut) —
// COMPUTED macros from real ingredient sums, not a typed P/C/F estimate, so this stays inside
// the deterministic-trust boundary the ate-out sheet's typed fallback below explicitly steps
// outside of. Requires >=1 row.
function confirmMealBuilderLogEatenOut(){
  if(!mealBuilder || !mealBuilder.ctx) return;
  if(!mealBuilder.rows.length){ toast('Add at least one ingredient'); return; }
  const ctx = mealBuilder.ctx;
  const newId = createOneTimeRecipeFromRows(mealBuilder.rows, mealBuilder.name, [ctx.slot]);
  if(!newId){ toast('Could not build this meal'); return; }
  applyOneTimeMealToSlot(ctx.weekStartDate, ctx.dayIndex, ctx.slot, ctx.person, newId);
  const dateISO = addDaysISO(ctx.weekStartDate, ctx.dayIndex);
  const plan = editableWeekPlan(ctx.weekStartDate);
  const meal = plan.days[ctx.dayIndex].meals[ctx.slot];
  const people = meal.shared ? ['elena', 'partner'] : [ctx.person];
  const opts = dateISO === todayISO() ? undefined : {tNull: true};
  people.forEach(function(person){
    const entry = meal[person];
    if(!entry || !entry.recipeId) return;
    const components = planEntryComponents(entry);
    logPlanEntry(dateISO, person, ctx.slot, entry.recipeId, entry.portion, components, opts);
    const arr = getDayLog(dateISO)[person];
    const idx = arr.findIndex(function(e){ return e.kind === 'plan' && e.slot === ctx.slot; });
    if(idx !== -1) setLogEntryEatenOut(dateISO, person, idx, true);
  });
  mealBuilder = null;
  refreshAfterLogChange();
  closeSheet();
  toast('🍴 Logged ' + RECIPES_DB[newId].title + ' — eaten out');
}

/* ---------------- log / plan-first confirm (task D1: writes real LogEntrys) ---------------- */
let selectedLogDateISO = todayISO();

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
  renderLogScreen();
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
  const hasItem = Number(food.avgG) > 0; // per-item weight (unit:'piece' OR per-100g + avgG)
  const safeGrams = Number.isFinite(Number(grams)) ? Number(grams) : (hasItem ? Number(food.avgG) : 0);
  if(hasItem){
    const count = Math.max(1, Math.round(safeGrams / Number(food.avgG)));
    return count + 'x';
  }
  return Math.round(safeGrams) + (food.unit === 'piece' ? 'g' : (food.unit || 'g'));
}

function foodGroupTitle(food, grams){
  if(!food) return 'Food';
  if(food === FOODS['espresso-unsweetened']){
    const count = Math.max(1, Math.round((Number(grams) || Number(food.avgG) || 1) / (Number(food.avgG) || 1)));
    return count + (count === 1 ? ' coffee' : ' coffees');
  }
  if(food === FOODS['cappuccino-unsweetened']){
    const count = Math.max(1, Math.round((Number(grams) || Number(food.avgG) || 1) / (Number(food.avgG) || 1)));
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
  // Group repeated quick-added foods (e.g. two cappuccinos) into one readable row.
  // Keep the original indexes so the row controls can still mutate the source entries.
  const displayRows = [];
  const foodGroups = {};
  entries.forEach(function(row){
    if(row.e.kind !== 'food') { displayRows.push({e: row.e, indices: [row.i]}); return; }
    const key = 'food:' + row.e.ref;
    if(!foodGroups[key]) { foodGroups[key] = {e: row.e, indices: [], grams: 0, kcal: 0}; displayRows.push(foodGroups[key]); }
    foodGroups[key].indices.push(row.i);
    foodGroups[key].grams += Number(row.e.grams) || 0;
    foodGroups[key].kcal += logEntryNutrition(row.e).kcal;
    foodGroups[key].e.eatenOut = foodGroups[key].e.eatenOut || row.e.eatenOut;
  });
  list.innerHTML = displayRows.map(function(row){
    const e = row.e;
    const removeBtn = '<button class="li-x" aria-label="Remove this entry" onclick="removeTodayEntryGroup('+JSON.stringify(row.indices)+')">✕</button>';
    // FAVORITES-EATENOUT-plan.md item 3: a per-row toggle for the eaten-out flag — kcal
    // stays in the day total either way (logEntryNutrition doesn't look at it), the only
    // effect is on pantryConsumedSince (pantry.js). The pill makes an eaten-out row read as
    // such at a glance, since its absence from pantry depletion is otherwise invisible.
    const outPill = e.eatenOut ? ' <span class="chip-computed">🍴 out</span>' : '';
    const toggleBtn = '<button class="li-x" aria-label="'+(e.eatenOut ? 'Mark eaten at home' : 'Mark eaten out')+'" onclick="toggleTodayEntryEatenOut('+row.indices[0]+')">'+(e.eatenOut ? '🏠' : '🍴')+'</button>';
    if(e.kind === 'plan'){
      const r = RECIPES_DB[e.ref];
      const emoji = r ? r.emoji : '🍽️';
      const title = escapeHtml(logEntryTitleWithComponents(e));
      const label = (e.slot ? SLOT_LABEL[e.slot] : 'Meal') + (e.t ? ' · ' + e.t : ' · earlier today');
      return '<div class="logitem"><div class="li-i">'+emoji+'</div><div class="li-t">'+title+outPill+'<small>'+label+'</small></div><div class="li-k">'+Math.round(logEntryNutrition(e).kcal)+'</div>'+toggleBtn+removeBtn+'</div>';
    }
    const food = FOODS[e.ref];
    const name = escapeHtml(food ? food.name : 'Food');
    const grams = row.grams;
    const amount = foodAmountLabel(food, grams);
    const label = (e.ref === 'espresso-unsweetened' || e.ref === 'cappuccino-unsweetened' ? 'Drink' : 'Quick add') + ' · ' + amount + (row.indices.length > 1 ? ' · ' + row.indices.length + ' logged' : '') + (e.t ? ' · ' + e.t : '');
    return '<div class="logitem"><div class="li-i">🥄</div><div class="li-t">'+name+outPill+'<small>'+label+'</small></div><div class="li-k">'+Math.round(row.kcal || logEntryNutrition(e).kcal)+'</div>'+toggleBtn+removeBtn+'</div>';
  }).join('');
}

function removeTodayEntryGroup(indices){
  if(!Array.isArray(indices) || !indices.length) return;
  if(!confirmDeletion()) return;
  let removed = 0;
  indices.slice().sort(function(a,b){ return b-a; }).forEach(function(index){ if(removeLogEntryAt(currentLogDateISO(), currentProf, index)) removed++; });
  if(!removed) return;
  refreshAfterLogChange();
  toast('✕ Removed ' + removed + (removed === 1 ? ' entry' : ' entries'));
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
  if(!confirmDeletion()) return;
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
  editTodayFoodCtx = {indices: group.indices.slice(), ref: group.ref, grams: Math.max(1, Math.round(group.grams)), eatenOut: groupEatenOut(group), dateISO: todayISO(), person: currentProf};
  document.getElementById('sheetBody').innerHTML = buildEditTodayFoodSheet();
  document.getElementById('sheet').classList.remove('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

function buildEditTodayFoodSheet(){
  const food = FOODS[editTodayFoodCtx.ref];
  if(!food) return '<p class="sub">Food not found.</p>';
  const nut = foodMacros(editTodayFoodCtx.ref, editTodayFoodCtx.grams);
  const isPiece = food.unit === 'piece' && Number(food.avgG) > 0;
  const safeGrams = Number.isFinite(Number(editTodayFoodCtx.grams)) ? Number(editTodayFoodCtx.grams) : defaultMealFoodGrams(editTodayFoodCtx.foodId);
  const amountText = foodAmountLabel(food, safeGrams);
  const step = isPiece ? Number(food.avgG) : 10;
  return '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Edit ' + escapeHtml(food.name) + '</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
    + '<div class="serve-row" style="margin-top:14px"><div class="serve-card me" style="flex:1">'
    + '<div class="sv-name">Amount</div>'
    + '<div class="sv-stepper"><button onclick="stepEditTodayFood(-'+step+')" aria-label="Decrease amount">–</button>'
    // Typeable grams (anchor); +/- kept. amountText (piece-aware label) still shows in .ad above.
    + '<input class="sv-val" type="text" inputmode="decimal" value="' + safeGrams + '" onfocus="this.select()" onkeydown="if(event.key===\'Enter\'){this.blur();}" onblur="commitEditTodayFoodGrams(this.value)" aria-label="Amount in grams"><span class="sv-unit">g</span>'
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
// Typeable-amount commit for the edit-today-food sheet (grams anchor); bad input reverts on repaint.
function commitEditTodayFoodGrams(raw){
  if(!editTodayFoodCtx) return;
  const v = parseDecimalInput(raw);
  if(v !== null && v > 0) editTodayFoodCtx.grams = Math.max(1, Math.min(2000, Math.round(v)));
  document.getElementById('sheetBody').innerHTML = buildEditTodayFoodSheet();
}

function saveEditTodayFood(){
  if(!editTodayFoodCtx) return;
  const dateISO = editTodayFoodCtx.dateISO || todayISO();
  const person = editTodayFoodCtx.person || currentProf;
  const arr = getDayLog(dateISO)[person];
  const keepIndex = editTodayFoodCtx.indices[0];
  const base = arr[keepIndex];
  if(!base) return;
  const nut = roundedNutritionTotals(foodMacros(editTodayFoodCtx.ref, editTodayFoodCtx.grams));
  base.grams = editTodayFoodCtx.grams;
  base.kcal = nut.kcal; base.protein = nut.protein; base.carbs = nut.carbs; base.fat = nut.fat; base.satFat = nut.satFat; base.fiber = nut.fiber; base.sugars = nut.sugars; base.freeSugars = nut.freeSugars; base.u = Date.now();
  // Apply the eaten-out choice from the sheet. The merged group collapses to this one kept
  // entry (the others are removed just below), so only `base` needs the flag; setLogEntryEatenOut
  // re-stamps u exactly as the field-writes above already did.
  setLogEntryEatenOut(dateISO, person, keepIndex, editTodayFoodCtx.eatenOut);
  editTodayFoodCtx.indices.slice(1).sort(function(a, b){ return b - a; }).forEach(function(i){ removeLogEntryAt(todayISO(), currentProf, i); });
  editTodayFoodCtx = null;
  refreshAfterLogChange();
  closeSheet();
  toast('✓ Updated item');
}

function deleteEditingTodayFood(){
  if(!editTodayFoodCtx) return;
  if(!confirmDeletion()) return;
  const dateISO = editTodayFoodCtx.dateISO || todayISO();
  const person = editTodayFoodCtx.person || currentProf;
  editTodayFoodCtx.indices.slice().sort(function(a, b){ return b - a; }).forEach(function(i){ removeLogEntryAt(dateISO, person, i); });
  editTodayFoodCtx = null;
  refreshAfterLogChange();
  closeSheet();
  toast('✕ Removed item');
}

// FIX 2 (feedback): one refresh funnel for every undo/remove — everything below derives
// from logHistory, so this is all that's needed for full parity across Today (ring/
// macros/fat line), Log (search results, pill, "Today so far") and Insights (which repaints
// from logHistory on next visit via go()).
function refreshAfterLogChange(){
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderTodayMeals();
  renderLogScreen(); // updates the Log screen's search box/results, pill and "Today so far"
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
   only opened the recipe before. This paints a compact action row into each card, driven by
   logConfirm/logSkip/undoLogSlot against slotLogStatus (logHistory is the one source of
   truth) — the Log screen is a search-and-add picker now, not a second mirror of these same
   four slots, so this is the only place that paints per-slot confirm/skip state.
   Re-derives all four slots fresh from slotLogStatus() every call (cheap — 4 lookups), so
   it's safe to call after ANY log-affecting action regardless of which surface triggered it
   (Today tap, a picker add, Undo, swap, profile switch, rebalance…) without tracking which
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
      // todayISO() passed EXPLICITLY, not left to logConfirm/logSkip's currentLogDateISO()
      // default — this row renders today's state (slotLogStatus(todayISO()) above), so it
      // must write to today even when the Log screen is still set to Yesterday. See the doc
      // on logConfirm below.
      wrap.innerHTML = '<div class="meal-actions-row">'
        + mealActionButtonHtml('log', {onclick: "event.stopPropagation();logConfirm('"+slot+"',todayISO(),this)", ariaLabel: 'Log '+label, title: 'Mark as eaten'})
        + mealActionButtonHtml('swap', {onclick: "event.stopPropagation();openSwap('"+slot+"',null)", ariaLabel: 'Swap '+label, title: 'Swap'})
        + mealActionButtonHtml('skip', {onclick: "event.stopPropagation();logSkip('"+slot+"',todayISO(),this)", ariaLabel: 'Skip '+label, title: 'Skip'})
        + '</div>';
    }
  });
}

// FIX 2a/2b (feedback): "Undo" on a confirmed or skipped Today card's tag row — clears the
// slot's plan entry / skipped flag (state.js:removeLoggedSlot), which restores the card's
// Confirm/Swap/Skip actions on the next renderTodayCardActions() repaint (part of
// refreshAfterLogChange()'s funnel, called below).
function undoLogSlot(slot){
  const status = slotLogStatus(currentLogDateISO(), currentProf, slot);
  if(!status) return;
  removeLoggedSlot(currentLogDateISO(), currentProf, slot);
  refreshAfterLogChange();
  toast(status === 'confirmed'
    ? '↺ Un-logged ' + SLOT_LABEL[slot] + ' — confirm it again anytime'
    : '↺ ' + SLOT_LABEL[slot] + ' un-skipped');
}

// FIX 2c (feedback): the "Today so far" ✕ — removes one specific entry from today's
// logHistory. For a plan entry this also restores the matching card's actions (the card
// state is re-derived from slotLogStatus on the renderTodayCardActions() rebuild, same
// path as undoLogSlot — the two stay consistent by construction).
function removeTodayEntry(index){
  if(!confirmDeletion()) return;
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

// Confirm/skip a plan slot — the Today screen's pending-card Log/Skip buttons
// (renderTodayCardActions) are the only callers now that the Log screen no longer mirrors
// the daily plan as its own cards. Both re-derive every visible surface fresh from
// logHistory afterward (renderTodayCardActions re-reads slotLogStatus() on its own, so no
// DOM "replay" step is needed here the way the old Log-card mirror required).
// dateISO (optional) — WHICH day this confirm/skip writes to. Defaults to
// currentLogDateISO() for callers that legitimately follow the Log screen's Today/Yesterday
// selection. The Today screen must pass todayISO() EXPLICITLY: selectedLogDateISO is a
// module-level global that survives navigation, so leaving Log set to "Yesterday" and then
// tapping a Today card's log button wrote the entry to yesterday while the card was showing
// (and re-reading) today's status via renderTodayCardActions' slotLogStatus(todayISO()).
// The two disagreed silently. Passing the date explicitly is what keeps the surface a
// button lives on and the day it writes to the same thing.
function logConfirm(key, dateISO, anchorEl, anchorRect){
  const date = dateISO || currentLogDateISO();
  if(slotLogStatus(date, currentProf, key)) return; // already confirmed or skipped
  anchorRect = anchorRect || captureRewardAnchor(anchorEl);
  const accountedBefore = date === todayISO() && typeof accountedSlotCount === 'function'
    ? accountedSlotCount(date, currentProf) : null;
  const v = computeMenuForDate(date, currentProf)[key];
  logPlanEntry(date, currentProf, key, v.recipeId, v.portion, v.components);

  // Task D1: Today ring/macros/good-sat-fat line and the "Today so far" list all derive
  // from logHistory — refresh them on every confirm.
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  updateLogTotalPill();
  renderTodaySoFar();
  renderTodayRecords();
  if(date === todayISO()) renderTodayCardActions(); // mirror the confirm onto Today cards only for today
  persist();
  triggerMealLogReward({
    anchorEl: anchorEl,
    anchorRect: anchorRect,
    title: logEntryTitleWithComponents(loggedPlanEntryForSlot(date, currentProf, key)) || SLOT_LABEL[key] || 'Meal',
    kcal: Math.round(logEntryNutrition(loggedPlanEntryForSlot(date, currentProf, key)).kcal || 0),
    dateISO: date,
    person: currentProf,
    type: 'meal'
  }, accountedBefore);
}

function logSkip(key, dateISO, anchorEl){
  const date = dateISO || currentLogDateISO();
  if(slotLogStatus(date, currentProf, key)) return; // already confirmed or skipped
  const anchorRect = captureRewardAnchor(anchorEl);
  const accountedBefore = date === todayISO() && typeof accountedSlotCount === 'function'
    ? accountedSlotCount(date, currentProf) : null;

  markSlotSkipped(date, currentProf, key);
  if(date === todayISO()) renderTodayCardActions(); // mirror the skip onto Today cards only for today
  persist();
  triggerMealLogReward({
    anchorEl: anchorEl,
    anchorRect: anchorRect,
    title: SLOT_LABEL[key] || 'Meal',
    kcal: 0,
    dateISO: date,
    person: currentProf,
    type: 'meal'
  }, accountedBefore, true);
}

// Reward calls stay at the explicit UI boundary: low-level log writers also service
// corrections, imports, and swaps, which should remain intentionally quiet.
function triggerMealLogReward(payload, accountedBefore, isSkip){
  if(typeof accountedSlotCount !== 'function') return;
  const completedToday = payload.dateISO === todayISO()
    && accountedBefore !== null
    && accountedBefore < SLOT_ORDER.length
    && accountedSlotCount(payload.dateISO, payload.person) === SLOT_ORDER.length;
  if(completedToday){
    if(typeof playDayCompletionReward === 'function') playDayCompletionReward(payload);
    return;
  }
  if(!isSkip && typeof playLogReward === 'function') playLogReward(payload);
}

// Search-and-add picker state: ONE search box across both recipes and plain ingredients
// (owner feedback: the old Log screen mirrored the whole day's plan back at the user,
// which read as confusing/repetitive — "clicking log food should simply let you pick a
// recipe or ingredient to add to the daily plan"). logSearchQuery is preserved across
// renderLogScreen() re-renders (every log-affecting action across the app calls this as
// its generic refresh step, same as the old renderLogPlan() did) so a caller elsewhere in
// the app refreshing state never wipes what the user is mid-typing here; a successful add
// explicitly clears it so the box is ready for the next search.
let logSearchQuery = '';
let logPickerCtx = null; // {kind:'recipe'|'food', id, slot, unassigned, portion, grams} while the picker sheet is open

// Same favorite-first, then-alphabetical order as mealTitleSort (used by the add-meal
// sheet's Sides/Sauces/Full recipes lists) — recipe search results sort the same way
// everywhere in the app.
function searchRecipesForLog(query){
  const q = String(query || '').trim().toLowerCase();
  if(q.length < 2) return [];
  return Object.keys(RECIPES_DB)
    .filter(function(id){ return RECIPES_DB[id].title.toLowerCase().indexOf(q) !== -1; })
    .sort(mealTitleSort)
    .slice(0, 20);
}

// data-log-add-recipe-id/data-log-add-food-id (not inline onclick): recipe/food ids can be
// user-authored 'cr-'/'cf-' slugs, so the click is handled by attachLogSearchHandler's
// delegation — same pattern as the add-meal sheet's own search rows.
function logSearchResultRowHtml(kind, id){
  if(kind === 'recipe'){
    const r = RECIPES_DB[id];
    const nut = roundedNutritionTotals(recipeNutrition(id, 1).totals);
    return '<div class="altrow" data-log-add-recipe-id="' + htmlAttr(id) + '">'
      + '<div class="ae">' + r.emoji + '</div>'
      + '<div class="at"><div class="an">' + escapeHtml(r.title) + ' <span class="pill mini">Recipe</span></div>'
      + '<div class="ad">' + nut.kcal + ' kcal · ' + nut.protein + 'g protein / serving</div></div>'
      + '</div>';
  }
  const f = FOODS[id];
  const grams = defaultMealFoodGrams(id);
  const nut = roundedNutritionTotals(foodMacros(id, grams));
  return '<div class="altrow" data-log-add-food-id="' + htmlAttr(id) + '">'
    + '<div class="ae">' + foodIconHtml(id) + '</div>'
    + '<div class="at"><div class="an">' + escapeHtml(f.name) + ' <span class="pill terra mini">Ingredient</span></div>'
    + '<div class="ad">' + foodAmountLabel(f, grams) + ' · ' + nut.kcal + ' kcal · ' + nut.protein + 'g protein</div></div>'
    + '</div>';
}

// Grouped (not interleaved) so recipes and ingredients stay visually distinguishable even
// without reading the badge on each row — same "shop-cat" section-header convention the
// add-meal sheet's Sides/Sauces/Full recipes groups already use.
function renderLogSearchResults(q){
  q = (q || '').trim();
  if(q.length < 2) return '<p class="sub" style="margin-top:10px">Type at least 2 letters to search recipes and ingredients.</p>';
  const recipeIds = searchRecipesForLog(q);
  const foodIds = searchFoods(q);
  if(!recipeIds.length && !foodIds.length) return '<p class="sub" style="margin-top:10px">Nothing matches “' + escapeHtml(q) + '”.</p>';
  let html = '';
  if(recipeIds.length) html += '<div class="shop-cat">Recipes</div>' + recipeIds.map(function(id){ return logSearchResultRowHtml('recipe', id); }).join('');
  if(foodIds.length) html += '<div class="shop-cat">Ingredients</div>' + foodIds.map(function(id){ return logSearchResultRowHtml('food', id); }).join('');
  return html;
}

function onLogSearchInput(value){
  logSearchQuery = value;
  const el = document.getElementById('logSearchResults');
  if(el) el.innerHTML = renderLogSearchResults(value);
}

// One delegated handler on the results container — re-attached (assignment, not
// addEventListener, so it never accumulates) every renderLogScreen() call, same
// non-accumulating pattern as attachAddMealSheetHandler.
function attachLogSearchHandler(){
  const el = document.getElementById('logSearchResults');
  if(!el) return;
  el.onclick = function(e){
    const recipeRow = e.target.closest('.altrow[data-log-add-recipe-id]');
    if(recipeRow && el.contains(recipeRow)){ openLogPickerSheet('recipe', recipeRow.getAttribute('data-log-add-recipe-id')); return; }
    const foodRow = e.target.closest('.altrow[data-log-add-food-id]');
    if(foodRow && el.contains(foodRow)) openLogPickerSheet('food', foodRow.getAttribute('data-log-add-food-id'));
  };
}

// "Which meal, how much" mini-sheet for a tapped search result — the second half of the
// picker flow. Nothing here writes state; commitLogPickerAdd() below does that, through
// the same addExtraRecipeToMeal()/addExtraFoodToMeal() funnel every other "add to a meal"
// entry point (openAddMealRecipeSheet's chooseMealExtraRecipe/chooseMealExtraFood) uses.
function openLogPickerSheet(kind, id){
  if(kind === 'recipe' && !RECIPES_DB[id]) return;
  if(kind === 'food' && !FOODS[id]) return;
  logPickerCtx = {kind: kind, id: id, slot: null, unassigned: false, portion: 1, grams: kind === 'food' ? defaultMealFoodGrams(id) : null, unit: kind === 'food' ? foodDefaultLogUnit(id) : null};
  document.getElementById('sheetBody').innerHTML = buildLogPickerSheet();
  attachLogPickerSheetHandler();
  document.getElementById('sheet').classList.remove('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

function logPickerNutrition(){
  if(!logPickerCtx) return roundedNutritionTotals(null);
  return logPickerCtx.kind === 'recipe'
    ? roundedNutritionTotals(recipeNutrition(logPickerCtx.id, logPickerCtx.portion).totals)
    : roundedNutritionTotals(foodMacros(logPickerCtx.id, logPickerCtx.grams));
}

// Display label for a measure unit. 'item' reads best as "item"; everything else is its own
// short kitchen word. Kept tiny + pure so both the picker and any caption use one source.
function logUnitLabel(unit){ return unit === 'item' ? 'item' : unit; }
// A measure count for display: whole numbers show plain, fractions show up to 2 decimals with
// trailing zeros trimmed (2, 1.5, 0.25) — never "2.00" or a long float from grams/gpu.
function formatLogCount(n){
  if(!isFinite(n)) return '0';
  const r = Math.round(n * 100) / 100;
  return (Math.abs(r - Math.round(r)) < 1e-9) ? String(Math.round(r)) : String(r);
}
// Clamp a grams value to the loggable range; whole grams for a weight unit, one decimal for a
// converted volume/item amount so e.g. 0.5 tbsp (6.75 g) keeps its count exact on redisplay.
function clampLogGrams(grams, isWeight){
  let g = Math.max(1, Math.min(2000, grams));
  return isWeight ? Math.round(g) : Math.round(g * 10) / 10;
}
function buildLogPickerSheet(){
  if(!logPickerCtx) return '';
  const isRecipe = logPickerCtx.kind === 'recipe';
  const title = isRecipe ? RECIPES_DB[logPickerCtx.id].title : FOODS[logPickerCtx.id].name;
  const emoji = isRecipe ? RECIPES_DB[logPickerCtx.id].emoji : foodIconHtml(logPickerCtx.id);
  const nut = logPickerNutrition();
  const slotButtons = SLOT_ORDER.map(function(slot){
    return '<button class="' + (logPickerCtx.slot === slot ? 'on' : '') + '" data-log-picker-slot="' + slot + '">' + (SLOT_LABEL[slot] || slot) + '</button>';
  }).join('') + '<button class="' + (logPickerCtx.unassigned ? 'on' : '') + '" data-log-picker-unassigned="true">No meal</button>';
  // Amount is TYPEABLE (parseDecimalInput) as well as steppable — the +/- buttons stay for
  // quick nudges, but you can always type the exact amount you want.
  let amountRow, unitRow = '', gramsCaption = '';
  if(isRecipe){
    amountRow = '<div class="sv-stepper"><button data-log-picker-step="-0.5" aria-label="Fewer servings">-</button>'
       + '<input class="sv-val" type="text" inputmode="decimal" value="' + logPickerCtx.portion + '" onfocus="this.select()" onkeydown="if(event.key===\'Enter\'){this.blur();}" onblur="commitLogPickerPortion(this.value)" aria-label="Servings">'
       + '<span class="sv-unit">×</span>'
       + '<button data-log-picker-step="0.5" aria-label="More servings">+</button></div>';
  } else {
    // Per-food unit selector (owner 2026-08-24): log in items / tbsp / tsp / cup / g depending
    // on what the food supports (engine.js:foodMeasureOptions). Grams stay the stored anchor —
    // the amount is entered in the chosen unit and converted; a live "= N g" makes it transparent.
    const opts = foodMeasureOptions(logPickerCtx.id);
    if(!opts.some(function(o){ return o.unit === logPickerCtx.unit; })) logPickerCtx.unit = foodDefaultLogUnit(logPickerCtx.id);
    const unit = logPickerCtx.unit;
    const gpu = foodGramsPerUnit(logPickerCtx.id, unit);
    const count = logPickerCtx.grams / gpu;
    const step = foodUnitStep(unit);
    const isWeight = (unit === 'g' || unit === 'ml');
    if(opts.length > 1){
      unitRow = '<div class="quick log-picker-units" style="margin-top:8px">'
        + opts.map(function(o){ return '<button class="' + (o.unit === unit ? 'on' : '') + '" data-log-picker-unit="' + o.unit + '">' + logUnitLabel(o.unit) + '</button>'; }).join('')
        + '</div>';
    }
    amountRow = '<div class="sv-stepper"><button data-log-picker-step="' + (-step) + '" aria-label="Less">-</button>'
       + '<input class="sv-val" type="text" inputmode="decimal" value="' + formatLogCount(count) + '" onfocus="this.select()" onkeydown="if(event.key===\'Enter\'){this.blur();}" onblur="commitLogPickerAmount(this.value)" aria-label="Amount">'
       + '<span class="sv-unit">' + logUnitLabel(unit) + '</span>'
       + '<button data-log-picker-step="' + step + '" aria-label="More">+</button></div>';
    // Show the gram equivalent whenever the chosen unit isn't already grams, so the conversion
    // Mesa is using (and can be edited on the ingredient) is always visible.
    if(!isWeight) gramsCaption = '<div class="sub" style="margin-top:6px;text-align:center">= ' + Math.round(logPickerCtx.grams) + ' g</div>';
  }
  return '<div class="row between" style="margin-top:6px"><h2 style="margin:0">' + escapeHtml(title) + '</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
    + '<p class="sub" style="margin-top:6px">Choose a meal, or log it without a meal, then set the amount.</p>'
    + '<div class="shop-cat">Meal</div>'
    + '<div class="quick">' + slotButtons + '</div>'
    + '<div class="shop-cat">Amount</div>'
    + unitRow
    + '<div class="serve-row" style="margin-top:8px"><div class="serve-card me" style="flex:1">'
    + '<div class="sv-name">' + emoji + ' ' + escapeHtml(title) + '</div>'
    + amountRow + gramsCaption + '</div></div>'
    + '<div class="nutri" style="margin-top:14px">'
    + '<div class="n"><div class="nt"><span>Calories</span><b>' + nut.kcal + ' kcal</b></div></div>'
    + '<div class="n"><div class="nt"><span>Protein</span><b>' + nut.protein + ' g</b></div></div>'
    + '</div>'
    + '<button class="cta" style="margin-top:14px" onclick="commitLogPickerAdd()">＋ Add' + (logPickerCtx.unassigned ? ' without a meal' : (logPickerCtx.slot ? ' to ' + (SLOT_LABEL[logPickerCtx.slot] || '').toLowerCase() : '')) + '</button>'
    + '<button class="cta ghostbtn" onclick="closeSheet()">Cancel</button>';
}

function attachLogPickerSheetHandler(){
  const el = document.getElementById('sheetBody');
  if(!el) return;
  el.onclick = function(e){
    const unassignedBtn = e.target.closest('button[data-log-picker-unassigned]');
    if(unassignedBtn && el.contains(unassignedBtn)){ selectLogPickerUnassigned(); return; }
    const slotBtn = e.target.closest('button[data-log-picker-slot]');
    if(slotBtn && el.contains(slotBtn)){ selectLogPickerSlot(slotBtn.getAttribute('data-log-picker-slot')); return; }
    const unitBtn = e.target.closest('button[data-log-picker-unit]');
    if(unitBtn && el.contains(unitBtn)){ selectLogPickerUnit(unitBtn.getAttribute('data-log-picker-unit')); return; }
    const stepBtn = e.target.closest('button[data-log-picker-step]');
    if(stepBtn && el.contains(stepBtn)) stepLogPickerAmount(parseFloat(stepBtn.getAttribute('data-log-picker-step')));
  };
}

function selectLogPickerSlot(slot){
  if(!logPickerCtx || SLOT_ORDER.indexOf(slot) === -1) return;
  logPickerCtx.slot = slot;
  logPickerCtx.unassigned = false;
  document.getElementById('sheetBody').innerHTML = buildLogPickerSheet();
  attachLogPickerSheetHandler();
}

function selectLogPickerUnassigned(){
  if(!logPickerCtx) return;
  logPickerCtx.slot = null;
  logPickerCtx.unassigned = true;
  document.getElementById('sheetBody').innerHTML = buildLogPickerSheet();
  attachLogPickerSheetHandler();
}

function stepLogPickerAmount(delta){
  if(!logPickerCtx) return;
  if(logPickerCtx.kind === 'recipe'){
    logPickerCtx.portion = Math.min(4, Math.max(0.5, +(logPickerCtx.portion + delta).toFixed(1)));
  } else {
    // delta is in the CURRENT unit's step; convert to grams (the stored anchor) via gpu.
    const gpu = foodGramsPerUnit(logPickerCtx.id, logPickerCtx.unit);
    const isWeight = logPickerCtx.unit === 'g' || logPickerCtx.unit === 'ml';
    const minCount = isWeight ? 1 : 0.5;
    const count = Math.max(minCount, (logPickerCtx.grams / gpu) + delta);
    logPickerCtx.grams = clampLogGrams(count * gpu, isWeight);
  }
  document.getElementById('sheetBody').innerHTML = buildLogPickerSheet();
  attachLogPickerSheetHandler();
}
// Amount typed in the currently-selected unit → grams (the stored anchor).
function commitLogPickerAmount(raw){
  if(!logPickerCtx) return;
  const n = parseDecimalInput(raw);
  if(n !== null && n > 0){
    const gpu = foodGramsPerUnit(logPickerCtx.id, logPickerCtx.unit);
    const isWeight = logPickerCtx.unit === 'g' || logPickerCtx.unit === 'ml';
    logPickerCtx.grams = clampLogGrams(n * gpu, isWeight);
  }
  rerenderLogPickerSheet();
}
// Switch the logging unit (item/tbsp/tsp/cup/g) — grams (the anchor) is kept, so the shown
// count just re-expresses the same amount in the new unit, with the "= N g" caption to match.
function selectLogPickerUnit(unit){
  if(!logPickerCtx || logPickerCtx.kind !== 'food') return;
  if(!foodMeasureOptions(logPickerCtx.id).some(function(o){ return o.unit === unit; })) return;
  logPickerCtx.unit = unit;
  rerenderLogPickerSheet();
}

// Typed-amount commits for the log picker (parseDecimalInput accepts "150" / "1,5" etc). Same
// clamp/round as the steppers above; an unparseable/empty value just re-renders the last good
// value. Re-render + re-attach mirrors stepLogPickerAmount so nutrition + the CTA label refresh.
function rerenderLogPickerSheet(){
  const body = document.getElementById('sheetBody');
  if(body) body.innerHTML = buildLogPickerSheet();
  attachLogPickerSheetHandler();
}
function commitLogPickerGrams(raw){
  if(!logPickerCtx) return;
  const n = parseDecimalInput(raw);
  if(n !== null && n > 0) logPickerCtx.grams = Math.max(1, Math.min(2000, Math.round(n)));
  rerenderLogPickerSheet();
}
function commitLogPickerPortion(raw){
  if(!logPickerCtx) return;
  const n = parseDecimalInput(raw);
  if(n !== null && n > 0) logPickerCtx.portion = Math.max(0.5, Math.min(4, Math.round(n * 2) / 2));
  rerenderLogPickerSheet();
}

// The picker's one write path: addExtraRecipeToMeal()/addExtraFoodToMeal() (planner.js) —
// the SAME funnel openAddMealRecipeSheet(slot, dateISO)'s chooseMealExtraRecipe/
// chooseMealExtraFood reach, mirrored here for a bare (kind, id) plus the slot/amount
// picked in this sheet rather than a slot chosen up front. `logged` and the dual
// plan+log write when true copy that pair's exact contract (and stepMealExtraPortion's,
// for the portion follow-up) so a meal already confirmed today gets corrected in place
// instead of silently drifting from what was actually logged.
// Pure/DOM-free (same applySwap/chooseSwap split planner.js already uses) — resolves
// (weekStartDate, dayIndex, logged) from a bare (dateISO, slot) and performs the write,
// nothing else, so tools/check.js can exercise the picker's actual write path directly.
// Returns {title, logged} on success, null on failure (unknown id, or no plan cell to add
// to — e.g. an out-of-range dateISO).
function applyLogPickerAdd(dateISO, slot, kind, id, amount, person){
  person = person || currentProf;
  const weekStartDate = mondayOfWeek(dateISO);
  const dayIndex = diffDaysISO(dateISO, weekStartDate);
  const logged = dateISO <= todayISO() && slotLogStatus(dateISO, person, slot) === 'confirmed';
  if(kind === 'recipe'){
    if(!RECIPES_DB[id]) return null;
    if(logged){
      addExtraToLoggedMeal(dateISO, person, slot, id);
      addExtraRecipeToMeal(weekStartDate, dayIndex, slot, person, id);
    } else {
      if(!addExtraRecipeToMeal(weekStartDate, dayIndex, slot, person, id)) return null;
    }
    if(amount !== 1){
      if(logged) setExtraPortionInLoggedMeal(dateISO, person, slot, id, amount);
      setExtraRecipePortion(weekStartDate, dayIndex, slot, person, id, amount);
    }
    return {title: RECIPES_DB[id].title, logged: logged};
  }
  if(kind === 'food'){
    if(!FOODS[id]) return null;
    if(logged){
      addFoodExtraToLoggedMeal(dateISO, person, slot, id, amount);
      addExtraFoodToMeal(weekStartDate, dayIndex, slot, person, id, amount);
    } else {
      if(!addExtraFoodToMeal(weekStartDate, dayIndex, slot, person, id, amount)) return null;
    }
    return {title: FOODS[id].name, logged: logged};
  }
  return null;
}

// A standalone log entry intentionally bypasses the meal-plan extras funnel. This is
// the same model used by the Coffee/Cappuccino quick actions: it contributes to the
// day's nutrition log without changing any planned meal.
function applyUnassignedLogPickerAdd(dateISO, kind, id, amount, person){
  person = person || currentProf;
  if(kind === 'food'){
    if(!FOODS[id]) return null;
    const entry = logFoodEntry(dateISO, person, id, amount);
    return {title: FOODS[id].name, logged: true, entry: entry};
  }
  if(kind === 'recipe'){
    if(!RECIPES_DB[id]) return null;
    const portion = amount;
    const entry = logPlanEntry(dateISO, person, null, id, portion, [{recipeId: id, portion: portion}]);
    return {title: RECIPES_DB[id].title, logged: true, entry: entry};
  }
  return null;
}

function commitLogPickerAdd(){
  if(!logPickerCtx) return;
  const ctx = logPickerCtx;
  const dateISO = currentLogDateISO();
  const amount = ctx.kind === 'recipe' ? ctx.portion : ctx.grams;
  if(!ctx.slot && !ctx.unassigned){ toast('Pick a meal, or choose No meal'); return; }
  const result = ctx.unassigned
    ? applyUnassignedLogPickerAdd(dateISO, ctx.kind, ctx.id, amount, currentProf)
    : applyLogPickerAdd(dateISO, ctx.slot, ctx.kind, ctx.id, amount, currentProf);
  if(!result){ toast('Could not add — try again'); return; }
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderTodayMeals();
  logSearchQuery = ''; // ready for the next search
  renderLogScreen();
  renderWeek();
  persist();
  closeSheet();
  logPickerCtx = null;
  const dest = ctx.unassigned
    ? 'without a meal'
    : 'to ' + logDateLabel().toLowerCase() + '’s ' + (SLOT_LABEL[ctx.slot] || ctx.slot).toLowerCase();
  toast('＋ Added ' + result.title + ' ' + dest);
}

// Repaints the Log screen's search box/results plus the shared "so far"/coffee widgets —
// called from every log-affecting action across the app (swap, extras, rebalance,
// regenerate, profile switch…) as the generic "Log screen is stale" refresh, exactly like
// the old renderLogPlan() it replaces. No longer rebuilds per-slot plan cards (deleted —
// owner feedback: mirroring the whole day's plan back here read as confusing/repetitive)
// so it no longer needs restoreTodayLog()'s replay step either: renderTodayCardActions()
// (called via renderTodayMeals(), itself called by every one of this function's own
// callers already) re-derives Today's confirm/skip state fresh from slotLogStatus() on
// every call, with nothing left here to keep in sync with it.
function renderLogScreen(){
  const soFar = document.getElementById('logSoFarTitle'); if(soFar) soFar.textContent = logDateLabel() + ' so far';
  const coffee = document.getElementById('coffeeCountTitle'); if(coffee) coffee.textContent = 'Coffee ' + logDateLabel().toLowerCase();

  const input = document.getElementById('logSearchInput');
  if(input) input.value = logSearchQuery;
  const results = document.getElementById('logSearchResults');
  if(results) results.innerHTML = renderLogSearchResults(logSearchQuery);
  attachLogSearchHandler();

  updateLogTotalPill();
  renderTodaySoFar();
  renderTodayRecords();
  renderBeverageCounts();
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
    logged: false,
    // Empty-pool guard (task 5) — see planner.js:planEntryView's doc for what this means.
    reason: planned && planned.reason
  };
}

function todaySlotView(slot){
  return displayedSlotViewForDate(todayISO(), currentProf, slot, activeMenu && activeMenu[slot]);
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
  renderLogScreen();
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
// Empty-pool guard (task 5): shown instead of MISSING_RECIPE_FALLBACK when the slot's
// gap is specifically reason:'no-candidates' (the planner found zero legal recipes for
// this person/slot/diet combination) rather than a dangling/deleted recipe reference —
// a different problem with a different fix, so it gets a different, actionable message.
const NO_CANDIDATES_FALLBACK = {emoji: '⚠️', title: 'No meal fits your filters'};
function slotFallback(view){ return view.recipe || (view.reason === 'no-candidates' ? NO_CANDIDATES_FALLBACK : MISSING_RECIPE_FALLBACK); }
function slotDescLine(view, label){
  if(!view.recipe && view.reason === 'no-candidates'){
    return 'Your diet/avoid filters left no ' + label.toLowerCase() + ' option — adjust them in Profile → Diet.';
  }
  return label + ' · ' + macroSummaryFromTotals(view);
}

function renderTodayMeals(){
  activeMenu = computeActiveMenu();

  function tagsHtml(recipeId, slot, pillId, shared){
    // Diet/trait pills (Plant-based, High fiber, etc.) hidden on Today summary cards —
    // they stay visible in the recipe detail view (renderRecipeScreen).
    const showTogetherPill = !!shared && !(typeof isSoloHousehold === 'function' && isSoloHousehold());
    return '<span class="pill together mini" id="'+pillId+'" style="display:'+(showTogetherPill?'inline-flex':'none')+'">👥 Together</span>';
  }

  const bfv = todaySlotView('breakfast'), bf = slotFallback(bfv);
  document.getElementById('bfEmoji').textContent = bf.emoji;
  document.getElementById('bfTitle').textContent = bfv.recipe ? mealTitleWithExtras(bfv) : bf.title;
  document.getElementById('bfKcal').textContent = bfv.kcal;
  document.getElementById('bfDesc').textContent = slotDescLine(bfv, 'Breakfast');
  document.getElementById('bfTags').innerHTML = tagsHtml(bfv.recipeId, 'breakfast', 'pillBreakfast', bfv.shared);

  const luv = todaySlotView('lunch'), lu = slotFallback(luv);
  document.getElementById('lunchThumb').textContent = lu.emoji;
  document.getElementById('lunchTitle').textContent = luv.recipe ? mealTitleWithExtras(luv) : lu.title;
  document.getElementById('lunchKcal').textContent = luv.kcal;
  document.getElementById('lunchDesc').textContent = slotDescLine(luv, 'Lunch');
  document.getElementById('lunchTags').innerHTML = tagsHtml(luv.recipeId, 'lunch', 'pillLunch', luv.shared);

  const div_ = todaySlotView('dinner'), di = slotFallback(div_);
  document.getElementById('dinnerThumb').textContent = di.emoji;
  document.getElementById('dinnerTitle').textContent = div_.recipe ? mealTitleWithExtras(div_) : di.title;
  document.getElementById('dinnerKcal').textContent = div_.kcal;
  document.getElementById('dinnerDesc').textContent = slotDescLine(div_, 'Dinner');
  document.getElementById('dinnerTags').innerHTML = tagsHtml(div_.recipeId, 'dinner', 'pillDinner', div_.shared);

  const snv = todaySlotView('snack'), sn = slotFallback(snv);
  document.getElementById('snackThumbEl').textContent = sn.emoji;
  document.getElementById('snackTitleEl').textContent = snv.recipe ? mealTitleWithExtras(snv) : sn.title;
  document.getElementById('snackKcalEl').textContent = snv.kcal;
  document.getElementById('snackDescEl').textContent = slotDescLine(snv, 'Snack');
  document.getElementById('snackTags').innerHTML = tagsHtml(snv.recipeId, 'snack', 'pillSnack', snv.shared);

  // UX-REVIEW-plan.md item 4: snack only gets the tap-to-recipe affordance breakfast/lunch/
  // dinner have (statically wired via onclick in index.html) when the slot actually holds a
  // recipe today — todaySlotView('snack') can legitimately come back empty (no-candidates or
  // a genuinely unplanned snack), and offering a pointer cursor with nothing behind it would
  // just trade one bug (missing affordance) for another (dead tap). Re-applied every render
  // so it never goes stale after a swap/re-balance changes whether today has a snack.
  // openSnackRecipe lives in app.js (boot/nav layer, deliberately not loaded into
  // tools/check.js's shared harness context — see that file's header doc), so this guards
  // with typeof same as every other cross-file optional-function check in this codebase
  // (e.g. isSoloHousehold/renderInsights above) rather than assuming it's always defined.
  const snackCard = document.getElementById('todaySnack');
  if(snackCard){
    if(snv.recipe && typeof openSnackRecipe === 'function'){
      snackCard.style.cursor = 'pointer';
      snackCard.onclick = openSnackRecipe;
    } else {
      snackCard.style.cursor = 'default';
      snackCard.onclick = null;
    }
  }

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

/* ---------------- Phase 3 D1: daily-confirm keystone ----------------
   The prominent, evening-anchored one-tap "close the day" affordance that lives at the top of
   #todayProgressCard. Design synthesized from the panel (psychologist + UX):
   - ONE calm affordance, folded into the existing status card — never a second competing menu.
     The four per-meal card rows stay the precise tool; this is the coarse "as planned" shortcut.
   - Evening-anchored by PROMINENCE, not visibility: pre-evening it is a quiet ghost button,
     after isEveningHour() it promotes to the filled sage CTA. It is never hidden, never a modal.
   - HONESTY guardrails (hard invariants — do not loosen without re-consulting the panel): the
     one-tap only ever logs slots that are still PENDING (never overrides a skip/swap already
     set), the copy always says "as planned" (never bare "eaten") so provenance stays legible,
     and every meal stays individually undoable via its card row.
   - Directional, never pass/fail: a fully-closed day settles to the same quiet sentence the
     botanical wreath reward uses; a missed prior day is never surfaced here.
   todayKeystoneState() is pure (no DOM) so tools/check.js can pin the state machine directly. */
function todayKeystoneState(dateISO, person, hour){
  var total = SLOT_ORDER.length;
  var accounted = 0;      // confirmed OR skipped — a "handled" slot
  var pending = [];       // slots still open (status null)
  SLOT_ORDER.forEach(function(slot){
    if(slotLogStatus(dateISO, person, slot)) accounted++;
    else pending.push(slot);
  });
  var evening = Number(hour) >= 18;
  if(accounted >= total){
    // Calm closure — reuse the wreath reward's exact sentence so the transient reward and the
    // resting card state speak in one voice.
    return {phase: 'complete', accounted: accounted, total: total, pending: pending, evening: evening,
      prominence: 'settled', settledText: 'Today’s record is complete.'};
  }
  var partial = accounted > 0;
  return {
    phase: partial ? 'partial' : (evening ? 'fresh-pm' : 'fresh-am'),
    accounted: accounted, total: total, pending: pending, evening: evening,
    prominence: evening ? 'cta' : 'ghost',
    label: partial ? 'Confirm the rest as planned' : 'Confirm today as planned',
    sub: partial ? (accounted + ' of ' + total + ' set · the rest whenever you’re ready.')
                 : (evening ? 'Ate today as planned? Close it in one tap.' : total + ' meals lined up today.')
  };
}

function renderTodayKeystone(){
  var wrap = document.getElementById('todayKeystone');
  if(!wrap) return;
  var st = todayKeystoneState(todayISO(), currentProf, currentHour());
  if(st.phase === 'complete'){
    wrap.innerHTML = '<div class="ks-settled"><span class="ks-check" aria-hidden="true">✓</span>' + st.settledText + '</div>';
    return;
  }
  var btnCls = st.prominence === 'cta' ? 'cta' : 'cta ghostbtn';
  wrap.innerHTML = '<button class="' + btnCls + ' ks-btn" onclick="confirmTodayAsPlanned(this)">' + st.label + '</button>'
    + '<div class="ks-sub sub">' + st.sub + '</div>';
}

// The pure logging core (no DOM / no reward) so tools/check.js can pin the HONESTY invariant
// directly: only logs slots with NO status yet (pending) — a slot already confirmed, skipped,
// or eaten-different is left exactly as the user left it — and only where the plan actually has
// a meal. Reuses the same computeMenuForDate + logPlanEntry path a single card confirm uses, so
// the recorded macros are identical to confirming each meal by hand. Returns how many it closed.
function confirmTodayAsPlannedApply(dateISO, person){
  var menu = computeMenuForDate(dateISO, person);
  var logged = 0;
  SLOT_ORDER.forEach(function(slot){
    if(slotLogStatus(dateISO, person, slot)) return;   // pending-only — never override a choice
    var v = menu[slot];
    if(!v || !v.recipeId) return;                      // no planned meal here -> stay honest, leave open
    logPlanEntry(dateISO, person, slot, v.recipeId, v.portion, v.components);
    logged++;
  });
  return logged;
}

// One-tap "close the day as planned". Thin wrapper: apply the pending-only logging, then run the
// shared refresh funnel and fire the calm day-completion wreath (which itself only appears iff
// this actually closed every slot). Every meal stays individually undoable via its card row.
function confirmTodayAsPlanned(anchorEl){
  var date = todayISO();
  var anchorRect = typeof captureRewardAnchor === 'function' ? captureRewardAnchor(anchorEl) : null;
  var logged = confirmTodayAsPlannedApply(date, currentProf);
  if(!logged){ toast('Nothing left to confirm today'); return; }
  refreshAfterLogChange();
  if(typeof playDayCompletionReward === 'function'){
    playDayCompletionReward({dateISO: date, person: currentProf, anchorRect: anchorRect});
  }
  toast(logged === 1 ? 'Set as planned · undo anytime' : logged + ' meals set as planned · undo anytime');
}

/* ---------------- Phase 3 D3b: "these targets are an estimate" banner ----------------
   Shown under the keystone when the user finished onboarding but chose "Fill in later" instead
   of entering real body basics (basicsConfirmed false). Honest and calm (panel guardrail — no
   red, no "incomplete", no countdown): a one-time nudge that a manual ✕ dismisses for good and
   that entering real basics retires automatically. Existing installs are grandfathered
   (loadState), so it only ever reaches a genuinely fresh skipper. shouldShowBasicsBanner() is
   pure so tools/check.js can pin the show-condition + grandfather migration. */
function shouldShowBasicsBanner(){
  return (typeof onboarded !== 'undefined' && !!onboarded)
    && (typeof basicsConfirmed !== 'undefined' && !basicsConfirmed)
    && !(typeof basicsBannerDismissed !== 'undefined' && basicsBannerDismissed);
}
function renderBasicsBanner(){
  var wrap = document.getElementById('basicsBanner');
  if(!wrap) return;
  if(!shouldShowBasicsBanner()){ wrap.innerHTML = ''; return; }
  wrap.innerHTML = '<div class="basics-banner-card">'
    + '<span class="bb-leaf" aria-hidden="true">🌱</span>'
    + '<div class="bb-text">These targets are a general estimate. Add your basics for a plan built around you.</div>'
    + '<button class="bb-add" onclick="openBasicsFromBanner()">Add basics</button>'
    + '<button class="bb-x" aria-label="Dismiss" onclick="dismissBasicsBanner()">✕</button>'
    + '</div>';
}
function openBasicsFromBanner(){ if(typeof go === 'function') go('profileAbout'); }
function dismissBasicsBanner(){
  if(typeof basicsBannerDismissed !== 'undefined') basicsBannerDismissed = true;
  if(typeof persist === 'function') persist();
  renderBasicsBanner();
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
