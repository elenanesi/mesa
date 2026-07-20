/* ===================================================================
   pantry.js — PANTRY-plan.md P2: derived "what's left at home".

   Pure DERIVATION only — no persist(), no DOM. state.js owns the stored
   baseline (`pantry`: foodId -> {qty, setAt, u}); log.js/logHistory is
   already the convergent, tombstoned, sync-merged record of what was
   actually eaten. This file turns those two into "how much is left"
   without ever mutating either — see PANTRY-plan.md §1 ("derive, don't
   mutate") for why a mutating pantry breaks couple sync, undo, and
   backdated logging. The Pantry PAGE and its ONE re-baselining mutator
   (setPantryRemaining, js/library.js — the load-bearing rule in
   PANTRY-plan.md §3 P2 step 4) live in js/library.js, not here.

   Loaded after js/planner.js (needs foodQuantitiesForComponents) and
   before js/render.js (app/index.html) — see tools/check.js's
   APP_SCRIPT_ORDER for the equivalent load order in the test harness.
   =================================================================== */

// Walks logHistory for BOTH people and sums, per foodId, everything decomposed via
// foodQuantitiesForComponents (planner.js) from entries logged (or corrected —
// upsertLogEntry bumps `u` on a swap-in-place too) at or after `sinceMs`. Both people are
// summed deliberately: each logs their own portion of a shared dish, exactly like
// computeShoppingList counts a shared meal once per eater (planner.js's doc block on
// computeShoppingList explains the same convention).
//
// Filtered on WHEN THE FOOD WAS EATEN (the entry's calendar date + its clock time `t`),
// deliberately NOT on the entry's `u` stamp. `u` is log.js's sync/conflict stamp, and
// upsertLogEntry RE-STAMPS it to Date.now() on every edit — so filtering on `u` would be
// wrong in two everyday cases:
//   1. Catch-up logging (task B5) a meal eaten BEFORE the baseline was set would subtract
//      it, even though the baseline is a PHYSICAL count of the cupboard that already
//      reflected that meal. "When Mesa learned about it" is not "when it left the shelf".
//   2. Correcting or swapping a weeks-old meal bumps its `u` to now, which would subtract
//      that whole meal's ingredients from today's pantry.
// A baseline means "as of setAt I physically had qty", so only food eaten after that
// instant can have reduced it.
//
// No separate tombstone check is needed here: removeLogEntryAt/removeLoggedSlot (log.js)
// splice the undone/deleted entry OUT of day[personKey] and record a tombstone purely for
// sync propagation to the other phone — locally, an undone entry is simply absent from
// this walk already. That is the whole payoff of deriving instead of mutating (PANTRY-
// plan.md §1): undo restores the remaining quantity for free, with no compensating write.
// Epoch-ms for when a log entry's food was actually eaten: its calendar date plus its
// clock time `t` ("HH:MM"). Backdated catch-up entries (task B5) carry t:null, and
// pre-`t` migrated entries have none at all — for those only the date is known, so they
// resolve to the END of that day. That choice is deliberate: on a same-day ambiguity it
// counts the meal rather than skipping it, and of the two possible errors, under-counting
// consumption is the worse one (the pantry would claim food you don't have and you'd fail
// to buy it, instead of merely re-buying something you already had).
function logEntryEatenAtMs(dateISO, entry){
  const day = parseISODate(dateISO); // planner.js — local-midnight Date, no UTC drift
  if(!day || isNaN(day.getTime())) return NaN;
  const t = entry && entry.t;
  if(typeof t === 'string' && /^\d{1,2}:\d{2}$/.test(t)){
    const parts = t.split(':');
    day.setHours(+parts[0], +parts[1], 0, 0);
    return day.getTime();
  }
  day.setHours(23, 59, 59, 999);
  return day.getTime();
}

function pantryConsumedSince(sinceMs){
  const out = {};
  function addQtyMap(map){
    Object.keys(map).forEach(function(foodId){
      out[foodId] = (out[foodId] || 0) + map[foodId];
    });
  }
  Object.keys(logHistory).forEach(function(dateISO){
    const day = logHistory[dateISO];
    if(!day) return;
    ['elena', 'partner'].forEach(function(personKey){
      const arr = Array.isArray(day[personKey]) ? day[personKey] : [];
      arr.forEach(function(e){
        if(!e) return;
        const eatenAt = logEntryEatenAtMs(dateISO, e);
        if(!isFinite(eatenAt) || eatenAt < sinceMs) return;
        if(e.kind === 'plan'){
          // logPlanEntry (log.js) stores the resolved components verbatim; a pre-D1/pre-
          // components entry (e.g. the old migrateV1TodayLog migration) has none, so fall
          // back to a single {recipeId, portion} component — exactly what components would
          // have been for a plain (no-extras, no-optionGroups) confirm.
          const components = (Array.isArray(e.components) && e.components.length) ? e.components : [{recipeId: e.ref, portion: e.portion}];
          addQtyMap(foodQuantitiesForComponents(components));
        } else if(e.kind === 'food'){
          addQtyMap(foodQuantitiesForComponents([{foodId: e.ref, grams: e.grams}]));
        }
      });
    });
  });
  return out;
}

// {foodId: qty} of everything currently in the household pantry — the number the Pantry
// page (js/library.js) shows. Floored at 0 per food (consumption can never out-eat the
// baseline in the derived number, even if the real world ran out first — that's exactly
// what the age hint + direct decrease/remove controls on the Pantry page are for).
//
// Each food subtracts consumption from its OWN baseline's setAt — never a single global
// timestamp. Two foods set on different shopping trips (or one re-baselined today while
// the other wasn't) must not share one consumedSince() window; sharing one would either
// over- or under-count depending on which food's setAt "won".
function pantryRemaining(){
  const out = {};
  Object.keys(pantry).forEach(function(foodId){
    const entry = pantry[foodId];
    if(!entry) return;
    const consumed = pantryConsumedSince(entry.setAt)[foodId] || 0;
    out[foodId] = Math.max(0, entry.qty - consumed);
  });
  return out;
}

// PANTRY-plan.md P3 step 3 — THE SUBTLEST PART of the feature (the plan's own words). What
// next week's shopping list can credit the pantry for is NOT plain pantryRemaining(): the
// rest of THIS week's plan is still going to eat into that stock between now and next
// Monday. Crediting next week with today's raw pantryRemaining() would over-credit it —
// stock that's actually earmarked for tomorrow's dinner would look "available" for a meal
// eight days from now, and the resulting list would under-buy.
//
// So: project the pantry forward through the rest of THIS week's plan first — subtracting
// only what's still OUTSTANDING (not yet logged/skipped, currentWeekRemainingFoodQuantities
// in planner.js — already-logged days don't consume the pantry a second time here; they
// already did, and pantryRemaining() already reflects that via logHistory) — and hand next
// week ONLY what's projected to be left after that. Floored at 0 per food: a pantry item
// fully eaten by this week's remaining plan contributes nothing to next week's projection
// (it must NOT reduce next week's list — that quantity is already spoken for by this week).
//
// projected(foodId) = max(0, pantryRemaining(foodId) - thisWeekOutstandingDemand(foodId))
function pantryProjectedForNextWeek(){
  const remaining = pantryRemaining();
  const thisWeekOutstanding = currentWeekRemainingFoodQuantities(); // planner.js
  const out = {};
  Object.keys(remaining).forEach(function(foodId){
    out[foodId] = Math.max(0, remaining[foodId] - (thisWeekOutstanding[foodId] || 0));
  });
  return out;
}
