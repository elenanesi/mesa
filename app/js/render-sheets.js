/* render-sheets.js — shopping sheet, food search, quick add, export/import */

// Two-week horizon: which week the shopping sheet currently shows ('current'|'next').
// Reset every time the sheet is opened fresh (openShopping()) to whichever week the Week
// screen was showing at that moment (task: "default: the week currently shown on the Week
// screen when opened from there") — setShopWeek() then lets the sheet's own segmented
// control switch it without closing/reopening. currentShopWeekStartDate is the resolved
// Monday for whichever mode is active right now — toggleShopInCart() writes into that
// week's in-cart set, so it's always kept in sync with buildShopSheet()'s own resolution.
let shopWeekMode = 'current';
let currentShopWeekStartDate = null;

function openShopping(){
  shopWeekMode = weekScreenShowsNext ? 'next' : 'current';
  document.getElementById('sheetBody').innerHTML = buildShopSheet();
  document.getElementById('sheet').classList.add('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
  attachShopListClickHandler();
}

// Switches the shopping sheet's own "This week | Next week" control without closing the
// sheet — same pattern as setWeekScreenMode() on the Week screen, just scoped to the sheet.
function setShopWeek(mode){
  shopWeekMode = mode;
  document.getElementById('sheetBody').innerHTML = buildShopSheet();
  attachShopListClickHandler();
}

// Shopping-list ids (sh-0, sh-1…) are positional and change whenever the list recomputes
// (different week, different servings), so the "in cart" tick is tracked by FOODID, PER
// WEEK (inCartShopByWeek/inCartSetForWeek, state.js) — Defect C redesign. Tapping a "To
// buy" row means "I put this in my cart" — the row dims but STAYS on the list (never the
// old ambiguous crossed-off "done" that silently read as "I have it"). The pantry itself
// is never touched here; "Put cart away" (putCartAway below) is the ONE write path from a
// ticked row into the pantry.
function shopRowIsInCart(row, inCart){
  return !!(row && inCart && (row.foodIds || []).some(function(foodId){ return !!inCart[foodId]; }));
}

function toggleShopInCart(id, foodIdsJson){
  const el = document.getElementById(id);
  if(!el || !currentShopWeekStartDate) return;
  let foodIds;
  try{ foodIds = JSON.parse(foodIdsJson || '[]'); }catch(e){ foodIds = []; }
  if(!Array.isArray(foodIds) || !foodIds.length) return;
  const inCart = inCartSetForWeek(currentShopWeekStartDate);
  const nowInCart = !el.classList.contains('in-cart');
  el.classList.toggle('in-cart', nowInCart);
  foodIds.forEach(function(foodId){
    if(nowInCart) inCart[foodId] = true;
    else delete inCart[foodId];
  });
  persist();
}

// Drops any per-week in-cart foodId whose row is no longer on the "To buy" list — a row
// the pantry now fully covers (computeShoppingList's alreadyHome) is deleted from
// list.totals, but its foodId-keyed tick used to linger and re-mark the item in-cart when
// it returned. Reconciles the in-cart set against the foodIds actually on the Need list.
// Returns the number of stale ticks removed. Pure: no DOM, no persist.
function reconcileInCartShopSet(inCart, list){
  if(!inCart || !list) return 0;
  const visible = {};
  Object.keys(list.totals || {}).forEach(function(name){
    (list.totals[name].foodIds || []).forEach(function(foodId){ visible[foodId] = true; });
  });
  let removed = 0;
  Object.keys(inCart).forEach(function(foodId){
    if(!visible[foodId]){ delete inCart[foodId]; removed++; }
  });
  return removed;
}

// Delegated click handler for the shopping sheet — a "To buy" row (carries data-food-ids)
// toggles in-cart; an "Already home" row's "need more?" button steps that food's assumed
// pantry stock down instead (requestShopNeedMore below), the sanctioned manual adjust for
// "actually I need more of this". foodIds travel as a JSON array in a data-* attribute
// (htmlAttr-escaped once by the HTML-attribute parser, never re-parsed as JS) instead of
// being interpolated into an onclick="..." JS string — same re-attach-after-innerHTML-
// rebuild pattern as attachSwapSearchHandler (planner.js).
function attachShopListClickHandler(){
  const el = document.getElementById('sheetBody');
  if(!el) return;
  el.onclick = function(e){
    const needMoreBtn = e.target.closest('[data-act="need-more"]');
    if(needMoreBtn && el.contains(needMoreBtn)){
      requestShopNeedMore(needMoreBtn.getAttribute('data-food-ids') || '[]');
      return;
    }
    const row = e.target.closest('.shop-item[data-food-ids]');
    if(!row || !el.contains(row)) return;
    toggleShopInCart(row.id, row.getAttribute('data-food-ids') || '[]');
  };
}

function buildShopSheet(){
  const weekStartDate = shopWeekMode === 'next' ? nextMondayISO() : mondayOfWeek(todayISO());
  currentShopWeekStartDate = weekStartDate; // toggleShopInCart()/putCartAway() write into this week's in-cart set
  const list = computeShoppingList(weekStartDate);
  const inCart = inCartSetForWeek(weekStartDate);
  if(reconcileInCartShopSet(inCart, list)) persist();
  const byCat = {};
  Object.keys(list.totals).forEach(function(name){
    const cat = foodCategoryForName(name); // real FOODS[..].cat, no hand-typed map (task C2)
    (byCat[cat] = byCat[cat] || []).push(name);
  });
  // Task C3 item 4 (generalized for the two-week horizon): the week date range, computed
  // from the week actually being shown, never the current week by default.
  const weekRange = fmtShopWeekRange(list.weekStartDate);
  const weekLabel = shopWeekMode === 'next' ? 'next week\'s' : 'this week\'s';
  let html = '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Shopping list <span class="chip-computed">✓ computed</span></h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
    + '<div class="seg" style="width:100%;margin-top:10px">'
    + '<button style="flex:1" class="'+(shopWeekMode === 'current' ? 'on' : '')+'" onclick="setShopWeek(\'current\')">This week</button>'
    + '<button style="flex:1" class="'+(shopWeekMode === 'next' ? 'on' : '')+'" onclick="setShopWeek(\'next\')">Next week</button>'
    + '</div>'
    + '<p class="sub" style="margin-top:10px"><b>' + weekRange + '</b> · ' + (isSoloHousehold() ? 'For you' : 'For both of you') + ' · 7 days · totals summed from ' + weekLabel + ' plan at each meal\'s planned portions. Shared meals are cooked once and counted once.</p>';
  // Defect C redesign: "Put cart away" is the ONE write path from the shopping sheet into
  // the pantry — it moves every currently in-cart row into the pantry at its listed
  // (already pantry-net) quantity, then clears their in-cart state.
  html += '<button class="cta" onclick="putCartAway()">Put cart away</button>';
  let idx = 0;
  html += '<div class="shop-cat" style="margin-top:6px">To buy</div>';
  let anyToBuy = false;
  SHOP_CAT_ORDER.forEach(function(cat){
    const names = byCat[cat];
    if(!names || !names.length) return;
    anyToBuy = true;
    names.sort();
    html += '<div class="shop-cat">'+cat+'</div>';
    names.forEach(function(name){
      const t = list.totals[name];
      const id = 'sh-' + (idx++);
      const inCartClass = shopRowIsInCart(t, inCart) ? ' in-cart' : '';
      const foodIdsAttr = htmlAttr(JSON.stringify(t.foodIds || []));
      // PANTRY-plan.md P3: a PARTIALLY covered row keeps the reduced qty (t.qty, already
      // net of the pantry) but annotates what pantry already contributed — never silent.
      // Mirrors the existing .dm-t/.li-t small-under-title pattern (mesa.css) inline rather
      // than adding a new selector, since this file's scope doesn't include the stylesheet.
      const haveNote = list.covered[name]
        ? '<small style="display:block;font-size:12px;color:var(--muted);font-weight:400">have ' + fmtShopQty(list.covered[name].have, list.covered[name].unit) + '</small>'
        : '';
      html += '<div class="shop-item'+inCartClass+'" id="'+id+'" data-food-ids="'+foodIdsAttr+'"><div class="sck">✓</div><div class="sname">'+escapeHtml(name)+haveNote+'</div><div class="sqty">'+fmtShopQty(t.qty, t.unit)+'</div></div>';
    });
  });
  if(!anyToBuy){
    html += '<p class="sub" style="margin-top:0">Nothing left to buy this week.</p>';
  }
  const stapleNames = Object.keys(list.staples).sort();
  if(stapleNames.length){
    html += '<div class="shop-cat">Pantry staples — check you have these</div>';
    stapleNames.forEach(function(name){
      html += '<div class="shop-item shop-item-static"><div class="sck">•</div><div class="sname">'+escapeHtml(name)+'</div></div>';
    });
  }
  // Defect C redesign: a row the pantry FULLY covers is no longer silently dropped (nor
  // just named in a one-line sentence) — it gets its own visible, greyed section, with a
  // "need more?" stepper for the sanctioned manual adjust.
  if(list.alreadyHome && list.alreadyHome.length){
    const homeByCat = {};
    list.alreadyHome.forEach(function(row){
      const cat = foodCategoryForName(row.name);
      (homeByCat[cat] = homeByCat[cat] || []).push(row);
    });
    html += '<div class="shop-cat" style="margin-top:22px">Already home</div>'
      + '<p class="sub" style="margin-top:0">Already in your pantry — not counted in what\'s left to buy.</p>';
    SHOP_CAT_ORDER.forEach(function(cat){
      const rows = homeByCat[cat];
      if(!rows || !rows.length) return;
      rows.sort(function(a, b){ return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });
      html += '<div class="shop-cat">'+cat+'</div>';
      rows.forEach(function(row){
        const foodIdsAttr = htmlAttr(JSON.stringify(row.foodIds || []));
        html += '<div class="shop-item already-home"><div class="sck">✓</div><div class="sname">'+escapeHtml(row.name)
          + '<small style="display:block;font-size:12px;color:var(--muted);font-weight:400">have ' + fmtShopQty(row.have, row.unit) + '</small></div>'
          + '<button class="backbtn" style="margin:0;min-height:36px;padding:4px 8px;font-size:12px" data-act="need-more" data-food-ids="'+foodIdsAttr+'">Need more?</button></div>';
      });
    });
  }
  return html;
}

// Steps every foodId in `foodIdsJson` down by the standard pantry step (10g/ml or 1 piece —
// library.js:stepPantryRemainingDown, the SAME mutator the Pantry page's own row-decrease
// button uses) and re-renders the sheet. This is the "Already home" row's "need more?"
// affordance — the sanctioned manual adjust when the assumed pantry stock is wrong, so the
// row reappears (fully or partially) on "To buy" instead of the user having to go find it
// on the separate Pantry page. Almost always a single foodId (foodId:name is 1:1 in
// practice — see computeShoppingList's own doc note on the foodIds array); stepping every
// contributing foodId keeps the rare aggregated-row case correct too.
function requestShopNeedMore(foodIdsJson){
  let foodIds;
  try{ foodIds = JSON.parse(foodIdsJson || '[]'); }catch(e){ foodIds = []; }
  if(!Array.isArray(foodIds) || !foodIds.length) return;
  foodIds.forEach(function(foodId){ stepPantryRemainingDown(foodId); });
  document.getElementById('sheetBody').innerHTML = buildShopSheet();
  attachShopListClickHandler();
}

function restockShopItemName(weekStartDate, name){
  const list = computeShoppingList(weekStartDate);
  const row = list.totals[name];
  if(!row) return 0;
  const remaining = pantryRemaining();
  let count = 0;
  (row.foodIds || []).forEach(function(foodId){
    if(!FOODS[foodId]) return;
    const have = (typeof remaining[foodId] === 'number') ? remaining[foodId] : 0;
    const newQty = have + row.qty;
    setPantryRemaining(foodId, newQty);
    remaining[foodId] = newQty;
    count++;
  });
  return count;
}

// Stocks every currently IN-CART row of `weekStartDate`'s shopping list into the pantry at
// its LISTED quantity (computeShoppingList's already pantry-reduced `qty` — exactly what's
// still missing), adding it ON TOP of whatever's already in stock, then clears those rows'
// in-cart state. This is the ONE write path from the shopping sheet into the pantry (Defect
// C redesign) — called only by the sheet's "Put cart away" action. A row counts as in-cart
// if ANY of its contributing foodIds is ticked (foodId:name is 1:1 in practice — see
// computeShoppingList's doc note), matching how toggleShopInCart ticks a row's foodIds
// together as one unit. Idempotent: once a row's foodIds are cleared from the in-cart set,
// a repeat call finds nothing in-cart to stock and writes nothing (same guarantee the old
// restockTickedShopItems gave).
function putShopCartAway(weekStartDate){
  const list = computeShoppingList(weekStartDate);
  const inCart = inCartSetForWeek(weekStartDate);
  let count = 0;
  const stockedFoodIds = {};
  Object.keys(list.totals).forEach(function(name){
    const row = list.totals[name];
    if(!shopRowIsInCart(row, inCart)) return;
    const stocked = restockShopItemName(weekStartDate, name);
    if(stocked){
      (row.foodIds || []).forEach(function(foodId){ stockedFoodIds[foodId] = true; });
      count += stocked;
    }
  });
  if(count){
    Object.keys(stockedFoodIds).forEach(function(foodId){ delete inCart[foodId]; });
    persist();
  }
  return count;
}

function putCartAway(){
  const weekStartDate = currentShopWeekStartDate || (shopWeekMode === 'next' ? nextMondayISO() : mondayOfWeek(todayISO()));
  const count = putShopCartAway(weekStartDate);
  if(!count){ toast('Add items to your cart first, then put them away'); return; }
  document.getElementById('sheetBody').innerHTML = buildShopSheet();
  attachShopListClickHandler();
  toast('✓ Pantry updated');
}

/* ---------------- re-balance week (task C2 item 4 — real solver) ---------------- */
// buildRebalanceSheet asks planner.js:proposeRebalanceSuggestions() for the real worst
// coverage gap and a small deterministic set of swap/side suggestions that improve it;
// applyRebalance() commits only the accepted suggestions, persists, and re-renders
// every surface that shows the plan (chips included).
let rebalanceProposal = null;
let todayRebalanceProposal = null;

function rebalanceProposalLabel(){
  return rebalanceProposal && rebalanceProposal.weekStartDate === nextMondayISO() ? 'next week' : 'this week';
}

function rebalanceSuggestionLabel(s){
  if(s.kind === 'swap'){
    const to = RECIPES_DB[s.toRecipeId];
    return DAY_NAMES[s.unit.dayIndex] + ' ' + SLOT_LABEL[s.unit.slot].toLowerCase() + ' → ' + escapeHtml(to.title);
  }
  const side = RECIPES_DB[s.sideRecipeId];
  return DAY_NAMES[s.unit.dayIndex] + ' ' + SLOT_LABEL[s.unit.slot].toLowerCase() + ' + side ' + escapeHtml(side.title);
}

function rebalanceAcceptedPlan(prop){
  if(!prop) return null;
  const basePlan = ensureWeekPlan(prop.weekStartDate);
  const resultPlan = deepClone(basePlan);
  prop.suggestions.forEach(function(s){
    if(s.accepted === false) return;
    if(typeof canAutoMutateUnit === 'function' && !canAutoMutateUnit(resultPlan, s.unit)) return;
    if(s.kind === 'swap') applySwapToPlan(resultPlan, s.unit, s.toRecipeId);
    else addSideToPlan(resultPlan, s.unit, s.sideRecipeId);
  });
  return resultPlan;
}

function setRebalanceSuggestionChoice(index, accepted){
  if(!rebalanceProposal || !rebalanceProposal.suggestions || !rebalanceProposal.suggestions[index]) return;
  rebalanceProposal.suggestions[index].accepted = !!accepted;
  document.getElementById('sheetBody').innerHTML = renderRebalanceSheet();
}

function buildRebalanceSheet(){
  const weekStartDate = weekScreenShowsNext ? nextMondayISO() : mondayOfWeek(todayISO());
  rebalanceProposal = proposeRebalanceSuggestions(weekStartDate);
  return renderRebalanceSheet();
}

function renderRebalanceSheet(){
  if(!rebalanceProposal) return '';
  const g = rebalanceProposal.gapInfo;
  // 'gap' = a weekly target is missed (close it); 'spread' = weekly targets all met but the
  // days are uneven (even them out); 'none' = fully balanced. Default defensively for any
  // proposal shape that predates the mode field.
  const mode = rebalanceProposal.mode || (g && g.gap <= 1e-9 ? 'none' : 'gap');
  const spread = mode === 'spread';
  const acceptedPlan = rebalanceAcceptedPlan(rebalanceProposal);
  let html = '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Re-balance ' + rebalanceProposalLabel() + '</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>';
  if(!rebalanceProposal.suggestions.length){
    html += '<p class="sub">' + (mode === 'none'
      ? 'This week is already a good fit — every weekly coverage target is met and your days are already even.'
      : spread
        ? 'Every weekly target is already met; a day or two runs a little rich or light, but no small swap evens them out further right now.'
        : 'The biggest gap right now is <b>' + g.label + '</b> (' + coverageValueText(g) + ' vs ' + coverageTargetText(g) + '), but no legal suggestion improves it for this week.')
      + '</p>'
      + '<button class="cta ghostbtn" onclick="closeSheet()">Close</button>';
    return html;
  }
  html += '<p class="sub">Keeps fixed: pinned meals, logged or skipped slots, foods you avoid, and past dates. '
    + (spread
      ? 'Every weekly target is already met — these small swaps just even out a day that runs rich or light.'
      : 'Biggest computed gap: <b>' + g.label + '</b> at ' + coverageValueText(g) + ' (target ' + coverageTargetText(g) + '). Suggestions stay conservative and week-aware.')
    + '</p>'
    + '<div class="card" style="padding:14px">'
    + '<b style="font-size:13px">Suggestions</b>';
  rebalanceProposal.suggestions.forEach(function(s, i){
    const accepted = s.accepted !== false;
    // Task B2 (generic identity): displayName instead of a hardcoded person name — this
    // whole suggestion line is built into `html` and painted via innerHTML further down, so
    // (unlike the plain-textContent viewerName above) it must go through escapeHtml.
    const who = s.unit.shared ? '' : (' (' + escapeHtml(resolveDisplayName(s.unit.person === 'elena' ? 'elena' : 'partner')) + ')');
    const last = i === rebalanceProposal.suggestions.length - 1;
    const kind = s.kind === 'swap' ? 'swap' : 'side';
    const icon = s.kind === 'swap' ? RECIPES_DB[s.toRecipeId].emoji : RECIPES_DB[s.sideRecipeId].emoji;
    const note = (kind === 'swap' ? 'Swap' : 'Add side') + ' · ' + (spread ? 'evens the days' : '+' + g.label);
    html += '<div class="logitem"' + (last ? ' style="border-bottom:0"' : '') + '><div class="li-i" style="background:var(--sage-tint)">' + icon + '</div>'
      + '<div class="li-t">' + rebalanceSuggestionLabel(s) + who
      + '<small>' + note + '</small></div>'
      + '<div class="row" style="gap:8px">'
      + '<button class="backbtn' + (accepted ? ' on' : '') + '" onclick="setRebalanceSuggestionChoice(' + i + ',true)">Accept</button>'
      + '<button class="backbtn' + (!accepted ? ' on' : '') + '" onclick="setRebalanceSuggestionChoice(' + i + ',false)">Refuse</button>'
      + '</div></div>';
  });
  html += '</div>';
  if(spread){
    // Directional, never pass/fail (panel guardrail): report how many day-by-person slots read
    // "balanced" after the accepted evening, framed as a contribution not a score.
    const before = rebalanceBalancedDayCount(ensureWeekPlan(rebalanceProposal.weekStartDate));
    const after = rebalanceBalancedDayCount(acceptedPlan);
    html += '<p class="sub">Balanced days: <b>' + before.n + ' → ' + after.n + ' of ' + after.total + '</b> after accepted swaps. Every weekly target stays met.</p>';
  } else {
    const acceptedGap = coverageGaps(computeWeeklyCoverage(acceptedPlan))[rebalanceProposal.metricKey];
    html += '<p class="sub">' + g.label + ' after accepted suggestions: <b>' + coverageValueText(acceptedGap) + '</b> (now ' + coverageValueText(g) + ').</p>';
  }
  html += '<button class="cta" onclick="applyRebalance()">Apply re-balance</button>'
    + '<button class="cta ghostbtn" onclick="closeSheet()">Cancel</button>';
  return html;
}

// Count of (day, person) slots reading dayBalanceOverall === 'balanced' across a plan — the
// same holistic per-day signal the Week view's day dots use, reused here so the spread-mode
// re-balance summary speaks in the app's existing "N of 7 balanced" vocabulary.
function rebalanceBalancedDayCount(plan){
  const people = (typeof isSoloHousehold === 'function' && isSoloHousehold()) ? ['elena'] : ['elena', 'partner'];
  let n = 0;
  const total = (plan && plan.days ? plan.days.length : 0) * people.length;
  if(plan && plan.days){
    plan.days.forEach(function(day){
      people.forEach(function(person){
        if(dayBalanceOverall(personDayNutriTotals(day, person), person) === 'balanced') n++;
      });
    });
  }
  return {n: n, total: total};
}

function openRebalanceSheet(){
  document.getElementById('sheetBody').innerHTML = buildRebalanceSheet();
  document.getElementById('sheet').classList.remove('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

function applyRebalance(){
  if(!rebalanceProposal || !rebalanceProposal.suggestions.length){ closeSheet(); return; }
  const g = rebalanceProposal.gapInfo;
  const accepted = rebalanceProposal.suggestions.filter(function(s){ return s.accepted !== false; });
  if(!accepted.length){ closeSheet(); return; }
  const basePlan = ensureWeekPlan(rebalanceProposal.weekStartDate);
  const resultPlan = rebalanceAcceptedPlan(rebalanceProposal);
  const afterText = coverageValueText(coverageGaps(computeWeeklyCoverage(resultPlan))[rebalanceProposal.metricKey]);
  preserveLoggedSlots(basePlan, resultPlan);
  // Belt-and-braces pin guard (2026-07-19 pin-leak report): every suggestion is already
  // filtered per-unit by canAutoMutateUnit (enumeration AND apply time), but regeneration
  // (ensureWeekPlan) already gets a preservePinnedSlots final pass, and this apply path is
  // the same kind of AUTO mutation — so any pinned cell is restored from basePlan
  // wholesale here regardless of what the accepted suggestions did. Explicit user
  // corrections (manual swap, routine set, extras edit) never route through this
  // function, so v56's "explicit user corrections remain allowed" is untouched.
  preservePinnedSlots(basePlan, resultPlan);
  markWeekPlanEdited(resultPlan);
  weekPlans[rebalanceProposal.weekStartDate] = resultPlan;
  if(rebalanceProposal.weekStartDate === mondayOfWeek(todayISO())) weekPlan = resultPlan;
  rebalanceProposal = null;
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderTodayMeals();
  renderLogScreen();
  renderWeek();
  persist();
  closeSheet();
  toast('✓ Plan re-balanced — ' + g.label + ' now ' + afterText);
}

/* ---------------- re-balance today (UI slice) ---------------- */
function todayRebalanceProposalDate(){
  return (todayRebalanceProposal && todayRebalanceProposal.dateISO) || todayISO();
}

function todayRebalanceSuggestionLabel(s){
  const unit = s.unit || {};
  const slot = unit.slot || s.slot || '';
  const label = SLOT_LABEL[slot] || slot || 'Meal';
  if(s.kind === 'swap'){
    const to = RECIPES_DB[s.toRecipeId] || {};
    return label + ' → ' + escapeHtml(to.title || 'suggested meal');
  }
  const side = RECIPES_DB[s.sideRecipeId] || {};
  return label + ' + side ' + escapeHtml(side.title || 'suggested side');
}

function todayRebalanceSuggestionIcon(s){
  if(s.kind === 'swap'){
    const to = RECIPES_DB[s.toRecipeId] || {};
    return to.emoji || '↔';
  }
  const side = RECIPES_DB[s.sideRecipeId] || {};
  return side.emoji || '+';
}

function todayRebalanceChangedSuggestions(beforePlan, afterPlan, suggestions){
  if(!beforePlan || !afterPlan || !Array.isArray(suggestions)) return [];
  return suggestions.filter(function(s){
    return s && s.accepted !== false && s.unit
      && todayRebalanceUnitSnapshot(beforePlan, s.unit) !== todayRebalanceUnitSnapshot(afterPlan, s.unit);
  });
}

function todayRebalanceAcceptedCount(prop){
  return prop && prop.suggestions ? prop.suggestions.filter(function(s){ return s.accepted !== false && todayRebalanceUnitCanApply(prop, s); }).length : 0;
}

function todayRebalanceUnitCanApply(prop, s){
  if(typeof canApplyTodayRebalanceUnit !== 'function') return true;
  const dateISO = (prop && prop.dateISO) || todayISO();
  const plan = ensureWeekPlan(mondayOfWeek(dateISO));
  return canApplyTodayRebalanceUnit(plan, (s && s.unit) || {}, dateISO);
}

function setTodayRebalanceSuggestionChoice(index, accepted){
  if(!todayRebalanceProposal || !todayRebalanceProposal.suggestions || !todayRebalanceProposal.suggestions[index]) return;
  todayRebalanceProposal.suggestions[index].accepted = !!accepted;
  document.getElementById('sheetBody').innerHTML = renderTodayRebalanceSheet();
}

function buildTodayRebalanceSheet(){
  const dateISO = todayISO();
  todayRebalanceProposal = proposeTodayRebalanceSuggestions(dateISO, currentProf);
  if(todayRebalanceProposal){
    todayRebalanceProposal.dateISO = todayRebalanceProposal.dateISO || dateISO;
    todayRebalanceProposal.personKey = todayRebalanceProposal.personKey || currentProf;
  }
  return renderTodayRebalanceSheet();
}

function renderTodayRebalanceSheet(){
  if(!todayRebalanceProposal) return '';
  const suggestions = todayRebalanceProposal.suggestions || [];
  let html = '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Re-balance today</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>';
  if(!suggestions.length){
    html += '<p class="sub">Today’s plan is already a good fit — Mesa doesn’t see a nudge worth making.</p>'
      + '<button class="cta ghostbtn" onclick="closeSheet()">Close</button>';
    return html;
  }

  html += '<p class="sub">Keeps fixed: logged or skipped slots, pinned meals, foods you avoid, and the rest of the week. Accept the swaps you want, then apply them to today only.</p>'
    + '<div class="card" style="padding:14px">'
    + '<b style="font-size:13px">Suggestions</b>';
  suggestions.forEach(function(s, i){
    const accepted = s.accepted !== false;
    const canApply = todayRebalanceUnitCanApply(todayRebalanceProposal, s);
    const disabled = canApply ? '' : ' disabled';
    const last = i === suggestions.length - 1;
    const kind = s.kind === 'swap' ? 'Swap' : 'Add side';
    const lockedNote = canApply ? '' : ' · Locked';
    html += '<div class="logitem"' + (last ? ' style="border-bottom:0"' : '') + '><div class="li-i" style="background:var(--sage-tint)">' + todayRebalanceSuggestionIcon(s) + '</div>'
      + '<div class="li-t">' + todayRebalanceSuggestionLabel(s)
      + '<small>' + kind + lockedNote + '</small></div>'
      + '<div class="row" style="gap:8px">'
      + '<button class="backbtn' + (accepted && canApply ? ' on' : '') + '"' + disabled + ' onclick="setTodayRebalanceSuggestionChoice(' + i + ',true)">Accept</button>'
      + '<button class="backbtn' + (!accepted || !canApply ? ' on' : '') + '" onclick="setTodayRebalanceSuggestionChoice(' + i + ',false)">Refuse</button>'
      + '</div></div>';
  });
  html += '</div>'
    + '<p class="sub">Accepted suggestions: <b>' + todayRebalanceAcceptedCount(todayRebalanceProposal) + '</b>.</p>'
    + '<button class="cta" onclick="applyTodayRebalance()">Apply ' + todayRebalanceAcceptedCount(todayRebalanceProposal) + ' ' + (todayRebalanceAcceptedCount(todayRebalanceProposal) === 1 ? 'change' : 'changes') + '</button>'
    + '<button class="cta ghostbtn" onclick="closeSheet()">Cancel</button>';
  return html;
}

function renderTodayRebalanceAppliedSheet(changedSuggestions){
  const changed = Array.isArray(changedSuggestions) ? changedSuggestions : [];
  let html = '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Applied changes</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
    + '<p class="sub">Today was updated. Logged and skipped meals stayed fixed.</p>';
  html += '<div class="card" style="padding:14px"><b style="font-size:13px">Changed today</b>';
  changed.forEach(function(s, i){
    html += '<div class="logitem"' + (i === changed.length - 1 ? ' style="border-bottom:0"' : '') + '>'
      + '<div class="li-i" style="background:var(--sage-tint)">' + todayRebalanceSuggestionIcon(s) + '</div>'
      + '<div class="li-t">' + todayRebalanceSuggestionLabel(s)
      + '<small>Updated in Today, Log, Planner, and saved offline</small></div></div>';
  });
  html += '</div><button class="cta" onclick="closeSheet()">Done</button>';
  return html;
}

function openTodayRebalanceSheet(){
  document.getElementById('sheetBody').innerHTML = buildTodayRebalanceSheet();
  document.getElementById('sheet').classList.remove('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

function applyTodayRebalance(){
  if(!todayRebalanceProposal || !todayRebalanceProposal.suggestions || !todayRebalanceProposal.suggestions.length){ closeSheet(); return; }
  todayRebalanceProposal.suggestions.forEach(function(s){
    if(!todayRebalanceUnitCanApply(todayRebalanceProposal, s)) s.accepted = false;
  });
  const accepted = todayRebalanceProposal.suggestions.filter(function(s){ return s.accepted !== false; });
  if(!accepted.length){ closeSheet(); return; }
  const basePlan = ensureWeekPlan(mondayOfWeek(todayRebalanceProposalDate()));
  const resultPlan = todayRebalanceAcceptedPlan(todayRebalanceProposal);
  if(!resultPlan){ closeSheet(); return; }
  const changedSuggestions = todayRebalanceChangedSuggestions(basePlan, resultPlan, accepted);
  if(!changedSuggestions.length){
    document.getElementById('sheetBody').innerHTML =
      '<div class="row between" style="margin-top:6px"><h2 style="margin:0">No open meals changed</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
      + '<p class="sub">Those suggestions are no longer applicable. A meal may have been logged, skipped, pinned, or updated since the sheet opened.</p>'
      + '<button class="cta" onclick="document.getElementById(\'sheetBody\').innerHTML=buildTodayRebalanceSheet()">Refresh suggestions</button>'
      + '<button class="cta ghostbtn" onclick="closeSheet()">Close</button>';
    toast('No open meals changed — re-open re-balance for fresh suggestions');
    return;
  }
  const weekStartDate = resultPlan.weekStartDate || mondayOfWeek(todayRebalanceProposalDate());
  preserveLoggedSlots(basePlan, resultPlan);
  // Same belt-and-braces pin guard as applyRebalance above: today-rebalance is AUTO
  // mutation too, so pinned cells are restored from basePlan after the logged-slot pass.
  preservePinnedSlots(basePlan, resultPlan);
  markWeekPlanEdited(resultPlan);
  weekPlans[weekStartDate] = resultPlan;
  if(weekStartDate === mondayOfWeek(todayISO())) weekPlan = resultPlan;
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderTodayMeals();
  renderLogScreen();
  renderWeek();
  persist();
  todayRebalanceProposal = null;
  document.getElementById('sheetBody').innerHTML = renderTodayRebalanceAppliedSheet(changedSuggestions);
  document.getElementById('sheet').classList.add('show');
  document.getElementById('sheetBackdrop').classList.add('show');
  toast('✓ Today re-balanced — ' + changedSuggestions.length + (changedSuggestions.length === 1 ? ' change' : ' changes'));
}

// Client-side substring match on food display names, case-insensitive, capped to keep the
// list scannable. Requires >=2 characters (task D1 item 2) — shorter queries show a hint
// instead of the whole food DB. Shared by the add-meal sheet's ingredient search
// (render-today.js:renderMealFoodResults), the Log screen's picker
// (render-today.js:searchRecipesForLog's food half) and the Library ingredient list.
function searchFoods(query){
  const q = query.trim().toLowerCase();
  if(q.length < 2) return [];
  return Object.keys(FOODS)
    .filter(function(id){ return FOODS[id].name.toLowerCase().indexOf(q) !== -1; })
    .sort(function(a, b){ return FOODS[a].name < FOODS[b].name ? -1 : (FOODS[a].name > FOODS[b].name ? 1 : 0); })
    .slice(0, 20);
}

function logBeverage(foodId, anchorEl){
  const food = FOODS[foodId];
  if(!food) return;
  const grams = (food.unit === 'piece' && food.avgG) ? food.avgG : 1;
  const dateISO = currentLogDateISO();
  const anchorRect = typeof captureRewardAnchor === 'function' ? captureRewardAnchor(anchorEl) : null;
  const logged = logFoodEntry(dateISO, currentProf, foodId, grams);
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  updateLogTotalPill();
  renderTodaySoFar();
  renderTodayRecords();
  renderBeverageCounts();
  renderWeek(); // C3: this writes a kind:'food' logHistory entry, same as any other quick-add — keep Week in sync.
  persist();
  if(typeof playLogReward === 'function'){
    playLogReward({
      anchorEl: anchorEl,
      anchorRect: anchorRect,
      title: food.name,
      kcal: Math.round(logEntryNutrition(logged).kcal || 0),
      dateISO: dateISO,
      person: currentProf,
      type: 'food'
    });
  }
}

/* ===================================================================
   export / import (task F2) — Profile → "Your data"

   Poor-man's Elena⇄Andrea sync until Phase 2's real backend: export
   downloads (iOS Safari: share-sheets) the EXACT mesa.v1 value as a
   dated JSON file; import reads a file, validates its shape, shows a
   confirm sheet naming the backup's date, and on confirm overwrites
   localStorage and reloads. Nothing is written to localStorage until
   the user confirms — an invalid file never touches existing state.
   =================================================================== */

// exportData() calls persist() first so the exact bytes exported are what's actually in
// localStorage right now (not a re-serialization that could drift from it), then reads
// STORE_KEY back verbatim and downloads it — no transformation of the stored value.
function exportData(){
  persist();
  let raw = null;
  try{ raw = localStorage.getItem(STORE_KEY); }catch(e){ raw = null; }
  if(!raw){ toast('Nothing to export yet'); return; }
  const filename = 'mesa-backup-' + todayISO() + '.json';
  const blob = new Blob([raw], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on a delay: iOS Safari's share sheet reads the blob URL asynchronously after
  // the click handler returns, so revoking immediately can race it.
  setTimeout(function(){ URL.revokeObjectURL(url); }, 2000);
  toast('✓ Backup downloaded');
}

// The same structural checks loadState() trusts before touching any field: a version
// number no newer than this app understands, and a profiles object with both known
// people. Deliberately shallow — loadState()'s own per-field type checks (already run
// against whatever we write to localStorage, on the reload that follows a confirmed
// import) are the real guard against a malformed-but-structurally-OK file.
function validateBackupStructure(obj){
  if(!obj || typeof obj !== 'object') return false;
  if(typeof obj.v !== 'number' || obj.v > CURRENT_STORE_VERSION) return false;
  if(!obj.profiles || typeof obj.profiles !== 'object') return false;
  if(!obj.profiles.elena || typeof obj.profiles.elena !== 'object') return false;
  if(!obj.profiles.partner || typeof obj.profiles.partner !== 'object') return false;
  // pantry (PANTRY-plan.md P1): additive/optional like every other post-v4 field this
  // function doesn't otherwise enumerate — absent entirely on any pre-pantry backup. Only
  // checked shallowly (must be an object when present); loadState()'s isValidPantryEntry()
  // per-entry check (state.js) is the real guard against a malformed entry, same
  // shallow-here/deep-there split this function's doc above already describes.
  if(obj.pantry !== undefined && (obj.pantry === null || typeof obj.pantry !== 'object')) return false;
  return true;
}

// Pulls a human date out of the mesa-backup-YYYY-MM-DD.json filename Mesa itself writes
// (exportData() above) so the confirm sheet can name the backup without needing an
// export timestamp inside the store itself; falls back to the file's mtime for a
// renamed file, and finally to a neutral phrase if neither is available.
function importDateLabel(filename, lastModified){
  const m = /mesa-backup-(\d{4}-\d{2}-\d{2})/.exec(filename || '');
  if(m) return m[1];
  if(typeof lastModified === 'number' && isFinite(lastModified)){
    try{ return new Date(lastModified).toISOString().slice(0, 10); }catch(e){ /* fall through */ }
  }
  return 'this file';
}

// Holds the exact raw JSON text of a file that passed validateBackupStructure() and is
// awaiting the confirm sheet's decision — never written to localStorage until
// confirmImport(). null whenever no import is pending (cancelled, completed, or never
// started).
let pendingImportRaw = null;

function handleImportFile(input){
  const file = input.files && input.files[0];
  input.value = ''; // reset so re-picking the same filename still fires 'change'
  if(!file) return;
  const reader = new FileReader();
  reader.onerror = function(){ toast("Couldn't read that file"); };
  reader.onload = function(){
    let parsed;
    try{ parsed = JSON.parse(String(reader.result)); }
    catch(e){ toast("That file isn't a valid Mesa backup"); return; }
    if(!validateBackupStructure(parsed)){ toast("That file isn't a valid Mesa backup"); return; }
    pendingImportRaw = String(reader.result);
    openImportConfirm(importDateLabel(file.name, file.lastModified));
  };
  reader.readAsText(file);
}

// FEATURE (owner feedback): two import modes, not one. "Merge food library only" (new —
// js/library.js:mergeImportedLibrary()) is the safe default action for the common case
// ("share just a recipe with each other") — it merges custom foods/recipes plus recipe
// edits/deletes, while leaving profiles, plans, logs, and shopping checks alone. "Replace everything" is the
// original F2 behavior, unchanged (confirmImport() below), for the rarer full-phone-sync
// case — kept as the ghost/secondary button precisely because it's destructive.
function buildImportConfirmSheet(dateLabel){
  return '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Import backup</h2><button class="backbtn" style="margin:0" onclick="cancelImport()">✕ Close</button></div>'
    + '<p class="sub">Backup from <b>' + dateLabel + '</b>. Choose how to bring it in.</p>'
    + '<button class="cta" onclick="confirmMergeImport()">🔀 Merge food library only</button>'
    + '<button class="cta ghostbtn" style="margin-top:10px" onclick="confirmImport()">⚠️ Replace everything</button>'
    + '<p class="sub" style="margin-top:10px">Merge adds this backup\'s custom ingredients &amp; recipes to what\'s already on this phone — nothing else changes, and it\'s safe to run more than once. Replace everything overwrites ALL data on this phone (profiles, plans, log history, library) with the backup — your current data here will be lost.</p>'
    + '<button class="cta ghostbtn" style="margin-top:14px" onclick="cancelImport()">Cancel</button>';
}

function openImportConfirm(dateLabel){
  document.getElementById('sheetBody').innerHTML = buildImportConfirmSheet(dateLabel);
  document.getElementById('sheet').classList.remove('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

function cancelImport(){
  pendingImportRaw = null;
  closeSheet();
}

// Overwrites STORE_KEY with the pending backup's exact bytes, then reloads: a full
// reload (rather than re-running loadState() in place) guarantees every already-rendered
// screen and in-memory global (PROF, weekPlan, logHistory, currentProf, RECIPES_DB…)
// rebuild from scratch against the new store, with zero risk of stale in-memory state
// bleeding through.
function confirmImport(){
  if(!pendingImportRaw){ closeSheet(); return; }
  try{
    localStorage.setItem(STORE_KEY, pendingImportRaw);
  }catch(e){
    toast("Couldn't save that backup on this phone");
    return;
  }
  pendingImportRaw = null;
  location.reload();
}

// Merge-only import (FEATURE, owner feedback): parses the SAME pending backup
// validateBackupStructure() already accepted for structural soundness, hands it to
// js/library.js:mergeImportedLibrary() (library content only — see that
// function's doc for the full merge-rule spec: identical-content skip, '-2' conflict
// copies with ingredient remap, " (imported)" on name collisions), then persists +
// re-renders via applyProf() — the exact same pattern saveNewFood()/saveNewRecipe()/
// deleteCustomFood()/deleteRecipe() (js/library.js) already use for every other
// library mutation. Unlike confirmImport() above (full replace + hard reload), this
// never reloads: it's a pure in-place library merge, so everything else already on this
// phone (profile edits, plans, log history) is completely undisturbed.
function confirmMergeImport(){
  if(!pendingImportRaw){ closeSheet(); return; }
  let parsed;
  try{ parsed = JSON.parse(pendingImportRaw); }
  catch(e){ toast("That file isn't a valid Mesa backup"); pendingImportRaw = null; closeSheet(); return; }
  const result = mergeImportedLibrary(parsed);
  pendingImportRaw = null;
  applyProf(currentProf); // refreshes library-derived UI without resetting the existing plan
  closeSheet();
  const parts = [];
  if(result.addedRecipes) parts.push(result.addedRecipes + ' recipe' + (result.addedRecipes === 1 ? '' : 's'));
  if(result.addedFoods) parts.push(result.addedFoods + ' ingredient' + (result.addedFoods === 1 ? '' : 's'));
  toast(parts.length ? '✓ Added ' + parts.join(' and ') + ' from the backup' : 'Nothing new in that backup — already on this phone');
}
