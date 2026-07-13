/* ===================================================================
   render.js — all DOM-writing functions
   Everything that reads state (state.js) / computed values (engine.js,
   planner.js) and paints it into the DOM: screen renderers, sheet
   builders, the toast helper, and the profile/basics/macro-split
   editor (kept together with applyProf since they're one tightly
   coupled render cycle — see the A1 report for the split rationale).
   =================================================================== */

// toast helper
let tT;
function toast(msg){
  const t=document.getElementById('toast');
  t.textContent=msg; t.classList.add('show');
  clearTimeout(tT); tT=setTimeout(()=>t.classList.remove('show'),1900);
}

// goal toggles
function tog(el){ el.classList.toggle('sel'); el.querySelector('.ck').textContent = el.classList.contains('sel')?'✓':''; }

/* ---------------- recipe detail rendering ---------------- */
function renderRecipe(key){
  const r = RECIPES[key] || RECIPES.salmon;
  currentRecipeKey = RECIPES[key] ? key : 'salmon';
  svE = 1; svM = 1.5; svS = 1;
  document.getElementById('recipeHero').textContent = r.emoji;
  document.getElementById('recipeTitle').textContent = r.title;
  document.getElementById('rsTime').textContent = '⏱️ ' + r.time;
  document.getElementById('rsKcal').textContent = '🔥 ' + r.kcal + ' kcal';
  document.getElementById('rsProt').textContent = '💪 ' + r.protein + 'g protein';
  document.getElementById('recipeTags').innerHTML = r.tags.map(function(t){ return '<span class="pill'+(t[0]?' '+t[0]:'')+'">'+t[1]+'</span>'; }).join('');
  updateRecipeWhy();
  document.getElementById('recipeMethod').innerHTML = r.method.map(function(s){ return '<li>'+s+'</li>'; }).join('');
  updateServings();
}

// Task C3: "why this fits you" is per-PERSON (whyText(recipeId, profKey) — state.js), so
// it can't be baked into RECIPES[id] at boot like the rest of the compat view. Called from
// renderRecipe() (opening a recipe) and from applyProf() (switching profile while the
// recipe screen is already open) so the copy always matches whoever's currently selected.
function updateRecipeWhy(){
  const el = document.getElementById('recipeWhy');
  if(!el || !RECIPES[currentRecipeKey]) return;
  el.innerHTML = '<b>Why this fits you</b><br>' + whyText(currentRecipeKey, currentProf);
}

function adjServe(who, delta){
  if(who === 'elena'){ svE = Math.min(3, Math.max(0.5, +(svE + delta).toFixed(1))); }
  else if(who === 'andrea'){ svM = Math.min(3, Math.max(0.5, +(svM + delta).toFixed(1))); }
  else { svS = Math.min(4, Math.max(0.5, +(svS + delta).toFixed(1))); }
  updateServings();
  persist();
}

function updateServings(){
  const shared = isShared(currentRecipeKey);
  document.getElementById('serveRowShared').style.display = shared ? 'flex' : 'none';
  document.getElementById('sharedCaption').style.display = shared ? 'block' : 'none';
  document.getElementById('serveRowSolo').style.display = shared ? 'none' : 'flex';
  let total;
  if(shared){
    document.getElementById('svElenaVal').textContent = svE + '×';
    document.getElementById('svAndreaVal').textContent = svM + '×';
    total = +(svE + svM).toFixed(1);
    document.getElementById('rsServesMeta').textContent = '👥 ' + total + ' servings';
    document.getElementById('ingHeader').innerHTML = 'Ingredients · scaled for ' + total + ' servings';
    const slot = RECIPE_SLOT_DB[currentRecipeKey] || 'meal';
    document.getElementById('sharedCaption').textContent = 'Shared ' + slot + ' — cooked once, plated per target';
  } else {
    document.getElementById('svSoloVal').textContent = svS + '×';
    total = svS;
    const label = total === 1 ? 'serving' : 'servings';
    document.getElementById('rsServesMeta').textContent = '🍽️ ' + total + ' ' + label;
    document.getElementById('ingHeader').innerHTML = 'Ingredients · scaled for ' + total + ' ' + label;
  }
  const r = RECIPES[currentRecipeKey];
  document.getElementById('ingList').innerHTML = r.ingredients.map(function(ing){
    const name = ing[0], qty = ing[1], unit = ing[2];
    if(qty === null) return '<li><span>'+name+'</span><span>'+unit+'</span></li>';
    const scaled = +(qty * total).toFixed(1);
    return '<li><span>'+name+'</span><span>'+scaled+' '+unit+'</span></li>';
  }).join('');
  updateNutritionGrid(total);
  syncServeHighlight();
}

// Nutrition grid + "kcal from" split, computed fresh from recipeNutrition() at the
// current total serving scale (same scale the ingredient list above uses) — so the
// steppers rescale nutrition exactly as they rescale ingredients (task C1). Replaces
// the old hand-typed r.nutrition/r.kcalSplit fields entirely; nothing here is typed in.
function updateNutritionGrid(total){
  const header = document.getElementById('nutriHeader');
  if(header) header.textContent = (total === 1) ? 'Nutrition (per serving)' : 'Nutrition · scaled for ' + total + ' servings';
  const nut = recipeNutrition(currentRecipeKey, total).totals;
  const rows = [
    ['Calories', fmtKcal(Math.round(nut.kcal))],
    ['Protein', Math.round(nut.protein) + ' g'],
    ['Carbs', Math.round(nut.carbs) + ' g'],
    ['Fat', Math.round(nut.fat) + ' g'],
    ['Good fats (unsat.)', Math.round(nut.goodFat) + ' g'],
    ['Sat. fat', Math.round(nut.satFat) + ' g'],
    ['Fiber', Math.round(nut.fiber) + ' g']
  ];
  document.getElementById('recipeNutri').innerHTML = rows.map(function(n){ return '<div class="n"><div class="nt"><span>'+n[0]+'</span><b>'+n[1]+'</b></div></div>'; }).join('');
  const kcalR = nut.kcal;
  const pPct = kcalR > 0 ? Math.round(nut.protein * 4 / kcalR * 100) : 0;
  const cPct = kcalR > 0 ? Math.round(nut.carbs * 4 / kcalR * 100) : 0;
  const fPct = kcalR > 0 ? Math.round(nut.fat * 9 / kcalR * 100) : 0;
  document.getElementById('recipeKcalSplit').textContent = 'kcal from: protein ' + pPct + '% · carbs ' + cPct + '% · fat ' + fPct + '%';
}

function syncServeHighlight(){
  const se = document.getElementById('serveElena'), sm = document.getElementById('serveAndrea');
  if(!se || !sm) return;
  se.classList.toggle('me', currentProf === 'elena');
  sm.classList.toggle('me', currentProf === 'partner');
}

function markEatenFromRecipe(){
  const k = currentRecipeKey;
  const card = document.getElementById('log-' + k);
  if(card && !card.classList.contains('done') && !card.classList.contains('skipped')){
    logConfirm(k);
  } else {
    toast('✓ Logged to today');
  }
}

/* ---------------- week screen rendering ---------------- */
// weekPlan.weekStartDate is always a Monday (planner.js:mondayOfWeek), so the day index
// maps straight onto Mon..Sun.
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Two-week horizon (owner feedback: "I need to see both this and next week's menu to shop
// on the weekend"): which week the Week screen's "This week | Next week" segmented control
// (index.html #weekSeg, reusing the existing .seg style) currently shows. Default is
// CURRENT week on every fresh render of the screen (app.js:go() doesn't reset it on
// re-visit, matching how every other screen's local view state — e.g. quickAdd — persists
// across tab switches within a session).
let weekScreenShowsNext = false;

function setWeekScreenMode(mode, el){
  weekScreenShowsNext = (mode === 'next');
  if(el){
    el.parentNode.querySelectorAll('button').forEach(function(b){ b.classList.remove('on'); });
    el.classList.add('on');
  }
  renderWeek();
}

// "Mon 20" — weekday abbreviation + day-of-month, used for next week's day rows (task:
// "show weekday names with dates") since "Today"-relative labels like the current week's
// don't make sense a week out. parseISODate (planner.js) is in the same shared global
// scope (classic <script> tags, no modules).
function dayDateLabel(dateISO){
  const d = parseISODate(dateISO);
  return DAY_NAMES[(d.getDay() + 6) % 7] + ' ' + d.getDate();
}

// Paints the 7-day list for the CURRENT person, for whichever week the segmented control
// currently selects (task C2 origin; two-week horizon adds the week parameter): every
// kcal shown is that person's portion-scaled computed value, day totals are real sums
// over the four slots. "Today" only ever highlights on the CURRENT week's row — next
// week has no "today". Each meal row gets an inline 🔁 swap icon (weekStartDate-aware —
// see openWeekSwap below) so a swap works on whichever week is displayed, not just today.
function renderWeek(){
  const mondayISO = weekScreenShowsNext ? nextMondayISO() : mondayOfWeek(todayISO());
  const plan = ensureWeekPlan(mondayISO);
  const todayIdx = weekScreenShowsNext ? -1 : todayDayIndex();
  const person = currentProf;
  const el = document.getElementById('weekList');
  el.innerHTML = plan.days.map(function(day, di){
    let dayKcal = 0;
    const titles = [];
    const rows = SLOT_ORDER.map(function(slot){
      const m = day.meals[slot];
      const entry = m[person];
      const r = RECIPES[entry.recipeId];
      if(!r) return '';
      dayKcal += entry.kcal;
      titles.push(r.title);
      const together = m.shared ? ' <span class="pill together mini">👥 Together</span>' : '';
      const swapBtn = '<button class="dm-swap" aria-label="Swap this meal" onclick="event.stopPropagation();openWeekSwap(\''+plan.weekStartDate+'\','+di+',\''+slot+'\',\''+person+'\')">🔁</button>';
      return '<div class="day-meal-row" onclick="openRecipe(\''+entry.recipeId+'\',\'week\')">'
        + '<div class="dm-e">'+r.emoji+'</div>'
        + '<div class="dm-t">'+r.title+'<small>'+SLOT_LABEL[slot]+together+'</small></div>'
        + '<div class="dm-k">'+Math.round(entry.kcal)+'</div>'
        + swapBtn + '</div>';
    }).join('');
    const label = weekScreenShowsNext ? dayDateLabel(day.date) : (DAY_NAMES[di] + (di === todayIdx ? ' · Today' : ''));
    return '<div class="day'+(di === todayIdx ? ' today' : '')+'" id="wd'+di+'" onclick="toggleDay('+di+')">'
      + '<div class="dh"><span class="dn">'+label+'</span><span class="dk">~'+fmtKcal(Math.round(dayKcal))+' kcal <span class="chev">⌄</span></span></div>'
      + '<div class="dmeals">'+titles.join(' · ')+'</div>'
      + '<div class="day-meals">'+rows+'</div></div>';
  }).join('');
  // Nutrient coverage chips always reflect the CURRENT week regardless of which week is
  // toggled on-screen (renderNutrientChips reads the `weekPlan` compat getter, which only
  // ever mirrors the current week — planner.js:ensureWeekPlan) — no change needed there.
  renderNutrientChips();
  updateWeekActionsForMode();
}

// Re-balance is defined as CURRENT-week-only (planner.js:proposeRebalanceSwaps always
// operates on the `weekPlan` compat getter): hide the button and show the cap-note instead
// whenever next week is the one on screen, so there's no dead/confusing action to tap.
function updateWeekActionsForMode(){
  const btn = document.getElementById('rebalanceBtn');
  const note = document.getElementById('rebalanceCapNote');
  if(btn) btn.style.display = weekScreenShowsNext ? 'none' : '';
  if(note) note.style.display = weekScreenShowsNext ? 'block' : 'none';
}

// Opens the swap sheet for one meal on a SPECIFIC week (current or next) — the Week
// screen's inline 🔁 per meal row. Unlike openSwap() (Today/Log/recipe-screen entry
// points, which always target today's plan via resolveSwapContext), this carries an
// explicit weekStartDate through swapCtx so chooseSwap (planner.js) applies the swap to
// the right week's plan, and — for next week — skips the "correct today's log entry" step
// entirely (there's nothing logged for a future date).
// 'tall' (not 'remove'): the sheet now has a "Best matches" + "All <slot> options" section
// (FEATURE: swap anything) which can be long — same tall/scrollable treatment as the
// shopping list and library sheets.
function openWeekSwap(weekStartDate, dayIndex, slot, person){
  const ctx = {dayIndex: dayIndex, slot: slot, person: person, weekStartDate: weekStartDate};
  swapCtx = {dayIndex: dayIndex, slot: slot, person: person, weekStartDate: weekStartDate, targetElId: null};
  document.getElementById('sheetBody').innerHTML = buildSwapSheet(ctx);
  document.getElementById('sheet').classList.add('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

// The "Weekly nutrient coverage" card (FIX 3: moved from the Week screen to the TOP of
// Insights — same markup/ids, same live wiring: renderWeek() still calls this after every
// plan change, and renderInsights() also refreshes it on each visit): the 4 REAL computed metrics from
// planner.js:computeWeeklyCoverage (omega-3 meals/wk ≥3, selenium sources/wk ≥3 while
// Elena's thyroid goal is on, fiber g/day avg vs 25g for whoever of the two is lower,
// sat-fat share of fat ≤33%), replacing the hardcoded Vitamin D demo chips. The chip
// markup (.n/.nt/.nbar) is unchanged — same visual design, real numbers.
function coverageValueText(g){
  if(g.key === 'fiber') return g.value + ' g/day';
  if(g.key === 'satFat') return g.value + '% of fat';
  return g.value + '/wk';
}
function coverageTargetText(g){
  if(g.key === 'fiber') return g.target + ' g/day';
  if(g.key === 'satFat') return '≤' + g.target + '%';
  return '≥' + g.target + '/wk';
}
function renderNutrientChips(){
  const wrap = document.getElementById('nutriChips');
  if(!wrap) return;
  const gaps = coverageGaps(computeWeeklyCoverage(weekPlan));
  const order = ['omega3', 'selenium', 'fiber', 'satFat'].filter(function(k){
    return k !== 'selenium' || PROF.elena.hashi; // selenium target tracked only with the thyroid goal on
  });
  wrap.innerHTML = order.map(function(k){
    const g = gaps[k];
    const low = g.gap > 1e-9;
    const capNote = g.cap ? '<div class="cap-note">Keep under ' + g.target + '% — staying below is good</div>' : '';
    return '<div class="n'+(low ? ' low' : '')+'"><div class="nt"><span>'+g.label+'</span><b>'+coverageValueText(g)+'</b></div>'
      + '<div class="nbar"><i style="width:'+g.pct+'%"></i></div>'+capNote+'</div>';
  }).join('');
  const worstKey = order.reduce(function(a, b){ return gaps[b].gap > gaps[a].gap ? b : a; });
  const worst = gaps[worstKey];
  const pill = document.getElementById('coveragePill');
  if(pill) pill.textContent = worst.gap > 1e-9 ? 'Needs a nudge' : 'On track';
  const note = document.getElementById('coverageNote');
  if(note){
    note.innerHTML = worst.gap > 1e-9
      ? '📌 <b>' + worst.label + ' is the biggest gap</b> — at ' + coverageValueText(worst) + ' vs a ' + coverageTargetText(worst) + ' target. “Re-balance my week” proposes the fewest swaps to close it.'
      : '✅ <b>All coverage targets met this week.</b> Omega-3, ' + (PROF.elena.hashi ? 'selenium, ' : '') + 'fiber and saturated fat are all where they should be.';
  }
}

function toggleDay(i){
  document.getElementById('wd'+i).classList.toggle('expanded');
}

/* ---------------- bottom sheet: generic open/close ---------------- */
// mealKey may be a slot name (from Today/Log cards) or a recipe id (from the recipe
// screen) — planner.js:resolveSwapContext maps either to (dayIndex, slot, person) on
// TODAY's plan for the current person. buildSwapSheet stores the computed alternatives
// on swapCtx so chooseSwap (planner.js) applies exactly what was shown.
// 'tall': see openWeekSwap's doc above — the sheet can now be long (FEATURE: swap anything).
function openSwap(mealKey, targetElId){
  const ctx = resolveSwapContext(mealKey);
  swapCtx = {dayIndex: ctx.dayIndex, slot: ctx.slot, person: ctx.person, targetElId: targetElId};
  document.getElementById('sheetBody').innerHTML = buildSwapSheet(ctx);
  document.getElementById('sheet').classList.add('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

function closeSheet(){
  document.getElementById('sheetBackdrop').classList.remove('show');
  document.getElementById('sheet').classList.remove('show');
}

// Two-week horizon: which week the shopping sheet currently shows ('current'|'next').
// Reset every time the sheet is opened fresh (openShopping()) to whichever week the Week
// screen was showing at that moment (task: "default: the week currently shown on the Week
// screen when opened from there") — setShopWeek() then lets the sheet's own segmented
// control switch it without closing/reopening. currentShopWeekStartDate is the resolved
// Monday for whichever mode is active right now — toggleShop() writes into that week's
// checked-set, so it's always kept in sync with buildShopSheet()'s own resolution.
let shopWeekMode = 'current';
let currentShopWeekStartDate = null;

function openShopping(){
  shopWeekMode = weekScreenShowsNext ? 'next' : 'current';
  document.getElementById('sheetBody').innerHTML = buildShopSheet();
  document.getElementById('sheet').classList.add('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

// Switches the shopping sheet's own "This week | Next week" control without closing the
// sheet — same pattern as setWeekScreenMode() on the Week screen, just scoped to the sheet.
function setShopWeek(mode){
  shopWeekMode = mode;
  document.getElementById('sheetBody').innerHTML = buildShopSheet();
}

// Shopping-list ids (sh-0, sh-1…) are positional and change whenever the list
// recomputes (different week, different servings), so checked state is tracked and
// persisted by ingredient NAME, PER WEEK (checkedShopByWeek/checkedSetForWeek, state.js)
// — the DOM class is just this render's presentation of that. Writes into whichever
// week's bucket buildShopSheet() most recently resolved (currentShopWeekStartDate), so
// checking an item on next week's list never touches this week's checks and vice versa.
function toggleShop(id, name){
  const el = document.getElementById(id);
  if(!el) return;
  el.classList.toggle('done');
  if(name && currentShopWeekStartDate){
    const checked = checkedSetForWeek(currentShopWeekStartDate);
    if(el.classList.contains('done')) checked[name] = true;
    else delete checked[name];
    persist();
  }
}

// Escapes a name for safe embedding inside a single-quoted inline-JS attribute.
function jsAttr(s){ return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

function buildShopSheet(){
  const weekStartDate = shopWeekMode === 'next' ? nextMondayISO() : mondayOfWeek(todayISO());
  currentShopWeekStartDate = weekStartDate; // toggleShop() writes into this week's checked-set
  const list = computeShoppingList(weekStartDate);
  const checked = checkedSetForWeek(weekStartDate);
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
    + '<p class="sub" style="margin-top:10px"><b>' + weekRange + '</b> · For both of you · 7 days · totals summed from ' + weekLabel + ' plan at each meal\'s planned portions. Shared meals are cooked once and counted once.</p>';
  let idx = 0;
  SHOP_CAT_ORDER.forEach(function(cat){
    const names = byCat[cat];
    if(!names || !names.length) return;
    names.sort();
    html += '<div class="shop-cat">'+cat+'</div>';
    names.forEach(function(name){
      const t = list.totals[name];
      const id = 'sh-' + (idx++);
      const done = checked[name] ? ' done' : '';
      html += '<div class="shop-item'+done+'" id="'+id+'" onclick="toggleShop(\''+id+'\',\''+jsAttr(name)+'\')"><div class="sck">✓</div><div class="sname">'+name+'</div><div class="sqty">'+fmtShopQty(t.qty, t.unit)+'</div></div>';
    });
  });
  const stapleNames = Object.keys(list.staples).sort();
  if(stapleNames.length){
    html += '<div class="shop-cat">Pantry staples — check you have these</div>';
    stapleNames.forEach(function(name){
      const id = 'sh-' + (idx++);
      const done = checked[name] ? ' done' : '';
      html += '<div class="shop-item'+done+'" id="'+id+'" onclick="toggleShop(\''+id+'\',\''+jsAttr(name)+'\')"><div class="sck">✓</div><div class="sname">'+name+'</div></div>';
    });
  }
  return html;
}

/* ---------------- re-balance week (task C2 item 4 — real solver) ---------------- */
// buildRebalanceSheet asks planner.js:proposeRebalanceSwaps() for the real worst
// coverage gap and the ≤2 swaps (same avoid/style/kcal-fit rules as generation) that
// most improve it; applyRebalance() commits the proposed plan, persists, and re-renders
// every surface that shows the plan (chips included).
let rebalanceProposal = null;

function rebalanceValueAfter(prop){
  // The worst metric's value on the proposed plan, formatted like the chips.
  const gaps = coverageGaps(prop.after);
  return coverageValueText(gaps[prop.metricKey]);
}

function buildRebalanceSheet(){
  rebalanceProposal = proposeRebalanceSwaps();
  const g = rebalanceProposal.gapInfo;
  let html = '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Re-balance this week</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>';
  if(!rebalanceProposal.swaps.length){
    const allMet = g.gap <= 1e-9;
    html += '<p class="sub">' + (allMet
      ? 'Nothing to fix — all four weekly coverage targets are already met. Nicely balanced.'
      : 'The biggest gap right now is <b>' + g.label + '</b> (' + coverageValueText(g) + ' vs ' + coverageTargetText(g) + '), but no legal swap (same slot & style, respecting avoid-lists) improves it this week.')
      + '</p>'
      + '<button class="cta ghostbtn" onclick="closeSheet()">Close</button>';
    return html;
  }
  html += '<p class="sub">Keeps fixed: your daily calories & protein, foods you avoid, shared meals. Biggest computed gap: <b>' + g.label + '</b> at ' + coverageValueText(g) + ' (target ' + coverageTargetText(g) + '). Changes as few meals as possible.</p>'
    + '<div class="card" style="padding:14px">'
    + '<b style="font-size:13px">Would change ' + rebalanceProposal.swaps.length + ' meal' + (rebalanceProposal.swaps.length > 1 ? 's' : '') + '</b>';
  rebalanceProposal.swaps.forEach(function(s, i){
    const to = RECIPES[s.toRecipeId];
    const who = s.unit.shared ? '' : (s.unit.person === 'elena' ? ' (Elena)' : ' (Andrea)');
    const last = i === rebalanceProposal.swaps.length - 1;
    html += '<div class="logitem"' + (last ? ' style="border-bottom:0"' : '') + '><div class="li-i" style="background:var(--sage-tint)">' + to.emoji + '</div>'
      + '<div class="li-t">' + DAY_NAMES[s.unit.dayIndex] + ' ' + SLOT_LABEL[s.unit.slot].toLowerCase() + who + ' → ' + to.title
      + '<small>+ ' + g.label + '</small></div></div>';
  });
  html += '</div>'
    + '<p class="sub">' + g.label + ' after these swaps: <b>' + rebalanceValueAfter(rebalanceProposal) + '</b> (now ' + coverageValueText(g) + ').</p>'
    + '<button class="cta" onclick="applyRebalance()">Apply re-balance</button>'
    + '<button class="cta ghostbtn" onclick="closeSheet()">Cancel</button>';
  return html;
}

function openRebalanceSheet(){
  document.getElementById('sheetBody').innerHTML = buildRebalanceSheet();
  document.getElementById('sheet').classList.remove('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

function applyRebalance(){
  if(!rebalanceProposal || !rebalanceProposal.swaps.length){ closeSheet(); return; }
  const g = rebalanceProposal.gapInfo;
  const afterText = rebalanceValueAfter(rebalanceProposal);
  // Re-balance is CURRENT-week-only (proposeRebalanceSwaps always works from the
  // `weekPlan` compat getter) — write the result into BOTH weekPlans (the real store) and
  // the bare `weekPlan` compat getter it mirrors, so the next ensureWeekPlan() call (e.g.
  // the next renderWeek()) doesn't silently overwrite this with the pre-rebalance plan
  // still sitting in weekPlans[currentMonday]. Same signature either way — ensureWeekPlan
  // won't consider it stale.
  const currentMonday = mondayOfWeek(todayISO());
  weekPlans[currentMonday] = rebalanceProposal.resultPlan;
  weekPlan = weekPlans[currentMonday];
  rebalanceProposal = null;
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderTodayMeals();
  renderLogPlan();
  renderWeek();
  persist();
  closeSheet();
  toast('✓ Week re-balanced — ' + g.label + ' now ' + afterText);
}

/* ---------------- log / plan-first confirm (task D1: writes real LogEntrys) ---------------- */
// Recomputes the "Today so far" kcal pill straight from today's logHistory entries for
// currentProf (task D1 item 3) — replaces the old incrementally-accumulated `logTotal`.
function updateLogTotalPill(){
  const entries = getDayLog(todayISO())[currentProf];
  const total = entries.reduce(function(s, e){ return s + e.kcal; }, 0);
  document.getElementById('logTotalPill').textContent = total + ' kcal';
}

// "Today so far" list (task D1 item 3): every logged entry for currentProf today —
// confirmed plan slots AND quick-added foods — sorted by log time. Fully derived from
// logHistory on every call, so it can never drift from what confirm/skip/quick-add wrote.
// FIX 2c (feedback): every row carries a ✕ that removes that SPECIFIC entry from
// logHistory (removeTodayEntry below). Rows are sorted for display but each ✕ carries the
// entry's ORIGINAL index in the day's array (captured before the sort), so it always
// removes exactly the entry shown.
function renderTodaySoFar(){
  const raw = getDayLog(todayISO())[currentProf];
  const entries = raw.map(function(e, i){ return {e: e, i: i}; }).sort(function(a, b){
    return ((a.e.t || '00:00') < (b.e.t || '00:00')) ? -1 : 1;
  });
  const list = document.getElementById('todaySoFar');
  if(!list) return;
  if(!entries.length){
    list.innerHTML = '<p class="sub" style="margin:8px 0 0">Nothing logged yet today.</p>';
    return;
  }
  list.innerHTML = entries.map(function(row){
    const e = row.e;
    const removeBtn = '<button class="li-x" aria-label="Remove this entry" onclick="removeTodayEntry('+row.i+')">✕</button>';
    if(e.kind === 'plan'){
      const r = RECIPES[e.ref];
      const emoji = r ? r.emoji : '🍽️';
      const title = r ? r.title : 'Meal';
      const label = (e.slot ? SLOT_LABEL[e.slot] : 'Meal') + (e.t ? ' · ' + e.t : ' · earlier today');
      return '<div class="logitem"><div class="li-i">'+emoji+'</div><div class="li-t">'+title+'<small>'+label+'</small></div><div class="li-k">'+e.kcal+'</div>'+removeBtn+'</div>';
    }
    const food = FOODS[e.ref];
    const name = food ? food.name : 'Food';
    const label = 'Quick add · ' + e.grams + 'g' + (e.t ? ' · ' + e.t : '');
    return '<div class="logitem"><div class="li-i">🥄</div><div class="li-t">'+name+'<small>'+label+'</small></div><div class="li-k">'+e.kcal+'</div>'+removeBtn+'</div>';
  }).join('');
}

// FIX 2 (feedback): one refresh funnel for every undo/remove — everything below derives
// from logHistory, so this is all that's needed for full parity across Today (ring/
// macros/fat line), Log (cards, pill, "Today so far") and Insights (which repaints from
// logHistory on next visit via go()).
function refreshAfterLogChange(){
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  renderLogPlan(); // rebuilds cards + replays statuses, then updates pill + "Today so far"
  persist();
}

// FIX 2a/2b (feedback): "Undo" on a confirmed or skipped Log card — clears the slot's
// plan entry / skipped flag (state.js:removeLoggedSlot), which restores the card's
// Confirm/Swap/Skip actions on the renderLogPlan() rebuild.
function undoLogSlot(slot){
  const status = slotLogStatus(todayISO(), currentProf, slot);
  if(!status) return;
  removeLoggedSlot(todayISO(), currentProf, slot);
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
  const removed = removeLogEntryAt(todayISO(), currentProf, index);
  if(!removed) return;
  let name = 'entry';
  if(removed.kind === 'plan'){
    const r = RECIPES[removed.ref];
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
  row.innerHTML = '<span class="'+tagClass+'">'+tagText+'</span>'
    + '<button class="tag-undo" onclick="undoLogSlot(\''+slot+'\')">↺ Undo</button>';
  info.appendChild(row);
}

function logConfirm(key, silent){
  const card = document.getElementById('log-' + key);
  if(!card || card.classList.contains('done') || card.classList.contains('skipped')) return;
  card.classList.add('done');
  appendTagRow(card, key, 'confirmed-tag', silent ? '✓ Logged · earlier today' : '✓ Logged · just now');

  if(!silent){
    const v = activeMenu[key];
    logPlanEntry(todayISO(), currentProf, key, v.recipeId, v.portion);
    toast('✓ Logged to today');
  }

  // Task D1: Today ring/macros/good-sat-fat line and the "Today so far" list all derive
  // from logHistory — refresh them on every confirm (live tap or silent replay alike).
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  updateLogTotalPill();
  renderTodaySoFar();
  persist();
}

function logSkip(key, silent){
  const card = document.getElementById('log-' + key);
  if(!card || card.classList.contains('done') || card.classList.contains('skipped')) return;
  card.classList.add('skipped');
  appendTagRow(card, key, 'skipped-tag', 'Skipped for today');
  if(!silent) toast('Skipped — your plan stays balanced');

  markSlotSkipped(todayISO(), currentProf, key);
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
  if(!activeMenu) return;
  SLOT_ORDER.forEach(function(slot){
    const v = activeMenu[slot], r = RECIPES[v.recipeId];
    buildLogSlotCard(slot, r.emoji, r.title, v.kcal, SLOT_LABEL[slot] + ' · ' + v.protein + 'g protein');
  });

  updateLogTotalPill();
  renderTodaySoFar();

  if(typeof restoreTodayLog === 'function') restoreTodayLog();
}

function buildLogSlotCard(slot, emoji, title, kcal, desc){
  EMOJI[slot] = emoji; TITLES[slot] = title; LOGKCAL[slot] = kcal;
  const card = document.getElementById('log-' + slot);
  card.className = 'card meal';
  card.style.cursor = 'default';
  card.innerHTML = '<div class="thumb">'+emoji+'</div><div class="info">'
    + '<div class="row between"><span class="t">'+title+'</span><span class="kcal">'+kcal+'</span></div>'
    + '<div class="d">'+desc+'</div>'
    + '<div class="logactions">'
    + '<button class="la-confirm" onclick="logConfirm(\''+slot+'\')">Confirm</button>'
    + '<button class="la-swap" onclick="openSwap(\''+slot+'\',\'log-'+slot+'\')">Swap</button>'
    + '<button class="la-skip" onclick="logSkip(\''+slot+'\')">Skip</button>'
    + '</div></div>';
}

/* ---------------- shared-meals toggle + Today rendering ---------------- */
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
function renderTodayMeals(){
  activeMenu = computeActiveMenu();

  function tagsHtml(r, slot, pillId){
    let html = r.tags.map(function(t){ return '<span class="pill'+(t[0]?' '+t[0]:'')+'">'+t[1]+'</span>'; }).join('');
    html += '<span class="pill together mini" id="'+pillId+'" style="display:'+(SHARED[slot]?'inline-flex':'none')+'">👥 Together</span>';
    return html;
  }

  const bfv = activeMenu.breakfast, bf = RECIPES[bfv.recipeId];
  document.getElementById('bfEmoji').textContent = bf.emoji;
  document.getElementById('bfTitle').textContent = bf.title;
  document.getElementById('bfKcal').textContent = bfv.kcal;
  document.getElementById('bfDesc').textContent = 'Breakfast · ' + bfv.protein + 'g protein';
  document.getElementById('bfTags').innerHTML = tagsHtml(bf, 'breakfast', 'pillBreakfast');

  const luv = activeMenu.lunch, lu = RECIPES[luv.recipeId];
  document.getElementById('lunchThumb').textContent = lu.emoji;
  document.getElementById('lunchTitle').textContent = lu.title;
  document.getElementById('lunchKcal').textContent = luv.kcal;
  document.getElementById('lunchDesc').textContent = 'Lunch · ' + luv.protein + 'g protein';
  document.getElementById('lunchTags').innerHTML = tagsHtml(lu, 'lunch', 'pillLunch');

  const div_ = activeMenu.dinner, di = RECIPES[div_.recipeId];
  document.getElementById('dinnerThumb').textContent = di.emoji;
  document.getElementById('dinnerTitle').textContent = di.title;
  document.getElementById('dinnerKcal').textContent = div_.kcal;
  document.getElementById('dinnerDesc').textContent = 'Dinner · ' + div_.protein + 'g protein';
  document.getElementById('dinnerTags').innerHTML = tagsHtml(di, 'dinner', 'pillDinner');

  const snv = activeMenu.snack, sn = RECIPES[snv.recipeId];
  document.getElementById('snackThumbEl').textContent = sn.emoji;
  document.getElementById('snackTitleEl').textContent = sn.title;
  document.getElementById('snackKcalEl').textContent = snv.kcal;
  document.getElementById('snackDescEl').textContent = 'Snack · ' + snv.protein + 'g protein';
  document.getElementById('snackTags').innerHTML = tagsHtml(sn, 'snack', 'pillSnack');
}

/* ---------------- editable basics ---------------- */
// Renders the Basics section for the current profile: sex segments, DOB + computed age,
// height/weight steppers, activity options, and the daily-target row with its
// computed/custom state, restore action and transparent formula line.
function renderBasics(){
  const p = PROF[currentProf];
  document.getElementById('sexBtnF').classList.toggle('on', p.sex === 'female');
  document.getElementById('sexBtnM').classList.toggle('on', p.sex === 'male');
  document.getElementById('pfDob').textContent = 'Born ' + MONTHS[p.dobM-1] + ' ' + p.dobY + ' · ' + ageOf(p);
  document.getElementById('dobMVal').textContent = MONTHS[p.dobM-1];
  document.getElementById('dobYVal').textContent = p.dobY;
  document.getElementById('hVal').textContent = p.heightCm + ' cm';
  document.getElementById('wVal').textContent = p.weightKg + ' kg';
  document.getElementById('actOpts').innerHTML = ACTIVITY_LEVELS.map(function(a, i){
    const sel = p.activity === a.f;
    return '<div class="opt'+(sel ? ' sel' : '')+'" style="margin-top:'+(i===0?'6':'9')+'px" onclick="setActivity('+i+')">'
      + '<div class="ck">'+(sel ? '✓' : '')+'</div>'
      + '<div><div class="ot">'+a.t+'</div><div class="od">'+a.d+'</div></div></div>';
  }).join('');
  // daily target row
  document.getElementById('pfCals').textContent = p.cals;
  const isCustom = p.calCustom !== null;
  const chip = document.getElementById('calChip');
  chip.textContent = isCustom ? 'custom' : '✓ computed';
  chip.className = isCustom ? 'pill gold' : 'chip-computed';
  const btn = document.getElementById('calRestoreBtn');
  btn.style.display = isCustom ? 'inline-flex' : 'none';
  btn.textContent = '↺ Restore recommended (' + fmtKcal(p.recCal) + ')';
  document.getElementById('calFormula').textContent =
    'BMR ' + fmtKcal(Math.round(bmrOf(p))) + ' × ' + p.activity + ' activity '
    + (p.goalAdj >= 0 ? '+ ' : '− ') + Math.abs(p.goalAdj) + ' ' + p.goalName
    + ' = ' + fmtKcal(p.recCal) + ' kcal recommended';
  document.getElementById('calNote').textContent = p.calNote || '';
}

// One funnel for every body-stat edit: refresh the recommendation, keep any manual
// override untouched (non-destructive nudge instead), cascade through applyProf, and
// say exactly what changed.
function afterBasicsChange(label){
  const p = PROF[currentProf];
  const oldGoal = p.calGoalNum;
  const newRec = recommendedCal(p);
  if(p.calCustom !== null && p.calCustom !== newRec){
    p.calNote = 'Mesa now recommends ' + fmtKcal(newRec) + ' kcal — your custom ' + fmtKcal(p.calCustom) + ' stays until you tap restore.';
  } else {
    p.calNote = '';
  }
  applyProf(currentProf);
  if(p.calCustom !== null){
    toast(label + ' — Mesa now recommends ' + fmtKcal(newRec) + ' kcal');
  } else if(p.calGoalNum !== oldGoal){
    toast(label + ' → new target ' + fmtKcal(p.calGoalNum) + ' kcal');
  } else {
    toast(label + ' — target unchanged at ' + fmtKcal(p.calGoalNum) + ' kcal');
  }
}

function setSex(s){
  const p = PROF[currentProf];
  if(p.sex === s) return;
  p.sex = s;
  afterBasicsChange('Sex ' + (s === 'female' ? 'female' : 'male'));
}

function stepDob(part, delta){
  const p = PROF[currentProf];
  if(part === 'm'){
    p.dobM += delta;
    if(p.dobM < 1){ p.dobM = 12; p.dobY--; }
    if(p.dobM > 12){ p.dobM = 1; p.dobY++; }
  } else {
    p.dobY += delta;
  }
  const maxY = new Date().getFullYear() - 16; // Mesa plans for adults
  p.dobY = Math.min(maxY, Math.max(1930, p.dobY));
  afterBasicsChange('Born ' + MONTHS[p.dobM-1] + ' ' + p.dobY + ' (age ' + ageOf(p) + ')');
}

function stepBody(field, delta){
  const p = PROF[currentProf];
  if(field === 'height'){
    p.heightCm = Math.min(220, Math.max(130, p.heightCm + delta));
    afterBasicsChange('Height ' + p.heightCm + ' cm');
  } else {
    p.weightKg = Math.min(200, Math.max(40, +(p.weightKg + delta).toFixed(1)));
    afterBasicsChange('Weight ' + p.weightKg + ' kg');
  }
}

function setActivity(i){
  const p = PROF[currentProf];
  const a = ACTIVITY_LEVELS[i];
  if(p.activity === a.f) return;
  p.activity = a.f;
  afterBasicsChange(a.t + ' (×' + a.f + ')');
}

// Manual calorie override, ±50 per tap, clamped to a sane band with a friendly note.
function stepCal(delta){
  const p = PROF[currentProf];
  const band = calBand(p);
  let next = p.calGoalNum + delta;
  if(next < band[0]){
    next = band[0];
    p.calNote = 'Held at ' + fmtKcal(band[0]) + ' — Mesa won’t plan below ~110% of your BMR. Gentle beats drastic.';
  } else if(next > band[1]){
    next = band[1];
    p.calNote = 'Held at ' + fmtKcal(band[1]) + ' — beyond maintenance + 600 kcal adds fat faster than muscle.';
  } else {
    p.calNote = '';
  }
  p.calCustom = (next === p.recCal) ? null : next;
  applyProf(currentProf);
  if(p.calCustom === null) toast('✓ Back on Mesa’s recommendation');
}

function restoreCal(){
  const p = PROF[currentProf];
  p.calCustom = null;
  p.calNote = '';
  applyProf(currentProf);
  toast('↺ Back to recommended ' + fmtKcal(p.recCal) + ' kcal');
}

// Steps one macro by ±5%, then pulls the compensating amount from whichever of the
// other two is currently larger — so the three always sum to 100 and the effect on a
// second macro is predictable (never split across both).
function stepSplit(macro, delta){
  const p = PROF[currentProf];
  const [lo, hi] = SPLIT_BOUNDS[macro];
  const prop = SPLIT_PROP[macro];
  const old = p[prop];
  let next = old + delta;
  let note = null;
  if(next < lo){ next = lo; note = splitGuardNote(macro, 'min'); }
  else if(next > hi){ next = hi; note = splitGuardNote(macro, 'max'); }
  const actualDelta = next - old;
  if(actualDelta === 0){
    p.splitNote = note || '';
    renderSplitEditor();
    return;
  }
  p[prop] = next;

  const others = ['P','C','F'].filter(function(k){ return k !== macro; });
  const big = p[SPLIT_PROP[others[0]]] >= p[SPLIT_PROP[others[1]]] ? others[0] : others[1];
  const small = big === others[0] ? others[1] : others[0];
  const compDelta = -actualDelta;
  const [bLo, bHi] = SPLIT_BOUNDS[big];
  const bigWanted = p[SPLIT_PROP[big]] + compDelta;
  const bigFinal = Math.max(bLo, Math.min(bHi, bigWanted));
  p[SPLIT_PROP[big]] = bigFinal;
  const leftover = bigWanted - bigFinal;
  if(leftover !== 0){
    const [sLo, sHi] = SPLIT_BOUNDS[small];
    const smallWanted = p[SPLIT_PROP[small]] + leftover;
    const smallFinal = Math.max(sLo, Math.min(sHi, smallWanted));
    p[SPLIT_PROP[small]] = smallFinal;
    if(!note && smallFinal !== smallWanted) note = splitGuardNote(small, leftover > 0 ? 'max' : 'min');
  }
  if(!note && bigFinal !== bigWanted) note = splitGuardNote(big, compDelta > 0 ? 'max' : 'min');
  p.splitNote = note || '';

  applyProf(currentProf);
  scheduleMenuRebuild();
}

function applyPreset(name){
  const p = PROF[currentProf];
  let target;
  if(name === 'default') target = p.defaultSplit;
  else if(name === 'highprotein') target = {P:35, C:35, F:30};
  else if(name === 'lowcarb') target = {P:30, C:30, F:40};
  else return;
  p.kP = target.P; p.kC = target.C; p.kF = target.F;
  p.splitNote = '';
  applyProf(currentProf);
  scheduleMenuRebuild();
}

function renderSplitEditor(){
  const p = PROF[currentProf];
  const kcal = p.calGoalNum;
  const gP = Math.round(kcal * p.kP / 100 / 4);
  const gC = Math.round(kcal * p.kC / 100 / 4);
  const gF = Math.round(kcal * p.kF / 100 / 9);
  document.getElementById('splitPVal').textContent = p.kP + '% · ' + gP + 'g';
  document.getElementById('splitCVal').textContent = p.kC + '% · ' + gC + 'g';
  document.getElementById('splitFVal').textContent = p.kF + '% · ' + gF + 'g';

  const chips = document.querySelectorAll('#macroPresets .chip-preset');
  const matches = function(t){ return p.kP === t.P && p.kC === t.C && p.kF === t.F; };
  if(chips[0]) chips[0].classList.toggle('chipsel', matches(p.defaultSplit));
  if(chips[1]) chips[1].classList.toggle('chipsel', matches({P:35,C:35,F:30}));
  if(chips[2]) chips[2].classList.toggle('chipsel', matches({P:30,C:30,F:40}));

  // Visible custom state: pill by the header + a restore hint, mirroring the calorie row.
  const customSplit = !matches(p.defaultSplit);
  const pill = document.getElementById('splitStatePill');
  if(pill) pill.style.display = customSplit ? 'inline-flex' : 'none';
  document.getElementById('splitNote').textContent = p.splitNote
    || (customSplit ? 'Custom split — “Mesa default” restores ' + p.defaultSplit.P + '/' + p.defaultSplit.C + '/' + p.defaultSplit.F + '.' : '');
}

/* ---------------- "Foods to avoid" editor (task C3 item 2) ---------------- */
// Real editor over PROF[currentProf].avoid (state.js), replacing the three static demo
// pills. Renders removable pills from the persisted array, plus a picker of the
// remaining AVOID_KEYS (state.js) behind the "＋ Add" field — free-text isn't supported
// in MVP (cap-note in index.html says so), so there's nothing to validate/parse here.
function renderAvoidEditor(){
  const p = PROF[currentProf];
  const pillsEl = document.getElementById('avoidPills');
  if(!pillsEl) return; // Profile screen markup not present (shouldn't happen, but don't crash)
  const list = (p.avoid || []).slice().sort();
  pillsEl.innerHTML = list.length
    ? list.map(function(k){ return '<span class="pill ghost" onclick="removeAvoid(\''+k+'\')">'+avoidLabel(k)+' ✕</span>'; }).join('')
    : '<span class="sub" style="margin:0">Nothing avoided right now — tap ＋ Add to pick from lactose, gluten, shellfish, nuts, raw onion or spicy.</span>';

  const chooserEl = document.getElementById('avoidChooser');
  if(chooserEl){
    const remaining = AVOID_KEYS.filter(function(k){ return list.indexOf(k) === -1; });
    chooserEl.innerHTML = remaining.length
      ? remaining.map(function(k){ return '<span class="pill" onclick="addAvoid(\''+k+'\')">＋ '+avoidLabel(k)+'</span>'; }).join('')
      : '<span class="sub" style="margin:0">Every supported item is already avoided.</span>';
  }
}

function toggleAvoidChooser(){
  const el = document.getElementById('avoidChooser');
  if(!el) return;
  el.style.display = (el.style.display === 'flex') ? 'none' : 'flex';
}

// Adds/removes one avoid key on the CURRENT profile, then runs the exact same funnel
// every other profile-mutating action uses: applyProf() re-derives everything (including
// ensureWeekPlan(), since the avoid-list is part of the plan signature — task C2) and
// persists. The toast's recipe count is a simple DB-wide fact (countRecipesWithAvoidKey,
// planner.js) — how many recipes carry this key at all — not a "how many now fit today's
// slot/style" figure, which would need re-deriving the whole candidate pool just to word
// a toast.
function addAvoid(key){
  const p = PROF[currentProf];
  p.avoid = p.avoid || [];
  if(p.avoid.indexOf(key) !== -1) return;
  p.avoid.push(key);
  const n = countRecipesWithAvoidKey(key);
  applyProf(currentProf);
  const chooserEl = document.getElementById('avoidChooser');
  if(chooserEl) chooserEl.style.display = 'none';
  toast(avoidLabel(key) + ' avoided — ' + n + (n === 1 ? ' recipe' : ' recipes') + ' fewer available to you');
}

function removeAvoid(key){
  const p = PROF[currentProf];
  const idx = (p.avoid || []).indexOf(key);
  if(idx === -1) return;
  p.avoid.splice(idx, 1);
  const n = countRecipesWithAvoidKey(key);
  applyProf(currentProf);
  toast(avoidLabel(key) + ' removed — ' + n + (n === 1 ? ' more recipe' : ' more recipes') + ' available to you');
}

// Debounced ~600ms after the last tap: reclassifies the plan style from the active
// profile's split, rebuilds the shared menu, and surfaces a toast + coach note.
let splitRebuildTimer = null;
function scheduleMenuRebuild(){
  clearTimeout(splitRebuildTimer);
  splitRebuildTimer = setTimeout(function(){
    const p = PROF[currentProf];
    householdStyle = styleOf(p);
    const bannerMsgs = {
      protein:{t:'Rebuilt for more protein 💪', d:'Rebuilt for your ' + p.kP + '/' + p.kC + '/' + p.kF + ' split — protein up, carbs trimmed. Same calories, same avoid-list.'},
      lowcarb:{t:'Rebuilt lower-carb 🥑', d:'Rebuilt for your ' + p.kP + '/' + p.kC + '/' + p.kF + ' split — carbs down, healthy fat up. Same calories, same avoid-list.'},
      balanced:{t:'Rebuilt for an even split 🥗', d:'Rebuilt for your ' + p.kP + '/' + p.kC + '/' + p.kF + ' split — an even mix across protein, carbs and fat. Same calories, same avoid-list.'}
    };
    const msg = bannerMsgs[householdStyle];
    p.coachOverrideT = msg.t; p.coachOverrideD = msg.d;
    applyProf(currentProf);
    toast('✓ Menu rebuilt for ' + p.kP + '/' + p.kC + '/' + p.kF);
  }, 600);
}

// The Today screen's ring + macro bars for the current profile — split out of applyProf
// so logConfirm/chooseSwap/applyRebalance can refresh consumed-so-far numbers without
// re-running the whole profile render cycle.
function refreshRingAndBars(){
  const p = PROF[currentProf];
  document.getElementById('calLeft').textContent=p.calLeft;
  document.getElementById('calGoal').textContent=p.calGoal;
  document.getElementById('mp').textContent=p.mp;
  document.getElementById('mc').textContent=p.mc;
  document.getElementById('mf').textContent=p.mf;
  document.getElementById('bp').style.width=p.bp;
  document.getElementById('bc').style.width=p.bc;
  document.getElementById('bff').style.width=p.bff;
  document.getElementById('calRing').style.strokeDashoffset=p.off;
  document.getElementById('fatSplit').textContent = '💚 ' + p.fatGood + 'g good fats · ' + p.fatSat + 'g sat.';
}

function applyProf(key){
  currentProf = key;
  const p=PROF[key];
  ensureWeekPlan();       // regenerate the plan first if its inputs changed (task C2)
  recomputeConsumed(key); // consumed-so-far from today's confirmed slots of the real plan
  recomputeProf(key);
  refreshRingAndBars();
  document.getElementById('goalTag').textContent=p.goalTag;
  document.getElementById('coachT').textContent=p.coachOverrideT || p.coachT;
  document.getElementById('coachD').textContent=p.coachOverrideD || p.coachD;
  document.getElementById('profAv').textContent=p.av;
  renderBasics();
  document.getElementById('hashiOpt').style.display = p.hashi ? 'flex':'none';
  document.getElementById('ksP').style.width = p.kP + '%';
  document.getElementById('ksC').style.width = p.kC + '%';
  document.getElementById('ksF').style.width = p.kF + '%';
  document.getElementById('kcalSplitLegend').textContent = 'Protein ' + p.kP + '% · Carbs ' + p.kC + '% · Fat ' + p.kF + '% of calories';
  renderSplitEditor();
  renderAvoidEditor();  // task C3: "Foods to avoid" pills for whichever profile is now active
  if(typeof renderFoodLibraryCount === 'function') renderFoodLibraryCount(); // js/library.js: "N built-in · M yours"
  renderTodayMeals();
  renderLogPlan();
  renderWeek();
  if(typeof renderInsights === 'function') renderInsights(); // task D1: keep Insights in sync with whoever's now current
  updateRecipeWhy();     // task C3: re-personalize the why-box if the recipe screen is open
  syncServeHighlight();
  syncProfileToggle(key);
  persist();
}

// Keeps both "whose plan" segmented controls (top tabbar and Profile screen) in sync
// with currentProf — needed on top of the click handlers' own toggling because
// loadState() can restore a non-default currentProf before any click ever happens.
function syncProfileToggle(key){
  document.querySelectorAll('#profSeg button').forEach(function(b){ b.classList.toggle('on', b.dataset.prof === key); });
  const whoSeg = document.getElementById('profWhoSeg');
  if(whoSeg){
    const btns = whoSeg.querySelectorAll('button');
    if(btns[0]) btns[0].classList.toggle('on', key === 'elena');
    if(btns[1]) btns[1].classList.toggle('on', key === 'partner');
  }
}

// profile screen switch
function setProf(key, el){
  el.parentNode.querySelectorAll('button').forEach(x=>x.classList.remove('on'));
  el.classList.add('on'); applyProf(key);
  // sync top control
  document.querySelectorAll('#profSeg button').forEach(x=>x.classList.toggle('on', x.dataset.prof===key));
}

/* ===================================================================
   Insights screen (task D1 item 4) — paints planner.js:computeInsights()
   into the 4 sections: stat tiles, weekly band, 7-day bars, and the
   2 deterministic "what's working" call-outs. Below 2 total logged days
   every section instead shows the same friendly empty-state copy,
   styled with the app's existing card/tile classes (no new components).
   =================================================================== */
const INSIGHTS_EMPTY_NOTE = 'Log a few days to unlock this — Mesa needs at least 2 logged days to show real trends here.';

function renderInsights(){
  const statWrap = document.getElementById('insightsStats');
  const bandWrap = document.getElementById('insightsBandCard');
  const barsWrap = document.getElementById('insightsBarsCard');
  const workingWrap = document.getElementById('insightsWorking');
  if(!statWrap || !bandWrap || !barsWrap || !workingWrap) return; // Insights markup not present

  // FIX 3 (feedback): the coverage card lives at the top of Insights now — refresh its
  // chips/pill/note on every visit (plan-derived, so not gated on logged-day count).
  renderNutrientChips();

  const data = computeInsights(currentProf);

  if(!data.hasEnoughData){
    statWrap.innerHTML = '<div class="s" style="grid-column:1/-1"><div class="sl" style="font-size:13px;font-weight:700;color:var(--ink)">Stats</div><p class="sub" style="margin-top:6px">'+INSIGHTS_EMPTY_NOTE+'</p></div>';
    bandWrap.innerHTML = '<div class="row between"><b style="font-size:14px">Your weekly band</b></div><p class="sub" style="margin-top:6px">'+INSIGHTS_EMPTY_NOTE+'</p>';
    barsWrap.innerHTML = '<div class="row between" style="margin-bottom:6px"><b style="font-size:14px">Calories vs target</b></div><p class="sub">'+INSIGHTS_EMPTY_NOTE+'</p>';
    workingWrap.innerHTML = '<p class="sub" style="margin:0">'+INSIGHTS_EMPTY_NOTE+'</p>';
    return;
  }

  // stat tiles
  const tiles = [
    {sv: Math.round(data.avgProtein) + 'g', sl: 'Avg protein/day (7d)', good: data.avgProtein >= data.targetProtein, goodNote: '▲ on target', badNote: '▼ below target'},
    {sv: Math.round(data.avgFiber) + 'g', sl: 'Avg fiber/day (7d)', good: data.avgFiber >= 25, goodNote: '▲ heart-smart', badNote: '▼ below 25g guide'},
    {sv: Math.round(data.pctUnsaturated) + '%', sl: 'Fats unsaturated (7d)', good: data.pctUnsaturated >= 67, goodNote: '▲ heart & skin smart', badNote: '▼ watch saturated fat'},
    {sv: data.daysLoggedCount + '/7', sl: 'Days logged this week', good: data.daysLoggedCount >= 5, goodNote: '▲ steady', badNote: '▼ log a few more days'}
  ];
  statWrap.innerHTML = tiles.map(function(t){
    return '<div class="s"><div class="sv">'+t.sv+'</div><div class="sl">'+t.sl+'</div><div class="sd '+(t.good ? 'up' : 'dn2')+'">'+(t.good ? t.goodNote : t.badNote)+'</div></div>';
  }).join('');

  // weekly band
  bandWrap.innerHTML = '<div class="row between"><b style="font-size:14px">Your weekly band <span class="chip-computed">✓ computed</span></b></div>'
    + '<p class="sub" style="margin-top:6px">'+data.inBandCount+' of 7 days landed inside your target range this week (kcal within ±10% of that day\'s target) — no streak to lose, just a gentle rhythm.</p>'
    + '<div class="band">' + data.days.map(function(d){
        const dotClass = !d.logged ? '' : (d.inBand ? 'filled' : 'soft');
        return '<div class="dwrap"><div class="dot '+dotClass+'"></div><div class="dl">'+d.letter+'</div></div>';
      }).join('') + '</div>';

  // 7-day bars — height is kcal as a % of that day's OWN target (capped 6-100%) so every
  // bar reads against the same "did I hit my target" scale; unlogged days get a distinct
  // pale/empty style (.spark .col.empty, css/mesa.css) so they don't read as "a bad day".
  barsWrap.innerHTML = '<div class="row between" style="margin-bottom:6px"><b style="font-size:14px">Calories vs target</b><span class="pill">last 7 days</span></div>'
    + '<div class="spark">' + data.days.map(function(d){
        if(!d.logged) return '<div class="col empty" style="height:14%" title="Not logged"><b>'+d.letter+'</b></div>';
        const pct = d.target > 0 ? Math.max(6, Math.min(100, Math.round(d.kcal / d.target * 100))) : 100;
        return '<div class="col'+(d.inBand ? ' hi' : '')+'" style="height:'+pct+'%" title="'+d.kcal+' kcal vs '+d.target+' target"><b>'+d.letter+'</b></div>';
      }).join('') + '</div>';

  // what's working / watch this — exactly 2 deterministic call-outs (planner.js)
  workingWrap.innerHTML = data.callouts.map(function(c, i){
    const last = i === data.callouts.length - 1;
    const bg = c.good ? 'var(--sage-tint)' : 'var(--terra-tint)';
    return '<div class="logitem"'+(last ? ' style="border-bottom:0"' : '')+'><div class="li-i" style="background:'+bg+'">'+c.icon+'</div><div class="li-t">'+c.text+'</div></div>';
  }).join('');
}

/* ===================================================================
   Quick-add: food search sheet (task D1 item 2)
   "Search" and "Meal" quick actions (Log screen) both open this sheet
   — Meal is a documented MVP alias, same flow. Two sub-views painted
   into #sheetBody: a live text-filtered food list (>=2 chars, client-
   side substring match on FOODS[..].name), then a grams stepper with a
   live-computed kcal/protein/carbs/fat preview (foodMacros(), engine.js)
   before writing a food-kind LogEntry (state.js:logFoodEntry) for
   currentProf. Barcode/photo stay demo toasts (index.html); water stays
   a toast too (it's not a nutrition entry).
   =================================================================== */
let quickAdd = {query: '', selectedId: null, grams: 100};

function openFoodSearch(){
  quickAdd = {query: '', selectedId: null, grams: 100};
  document.getElementById('sheetBody').innerHTML = buildFoodSearchSheet();
  document.getElementById('sheet').classList.remove('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
  const input = document.getElementById('foodSearchInput');
  if(input) input.focus();
}

// Client-side substring match on food display names, case-insensitive, capped to keep the
// sheet scannable. Requires >=2 characters (task D1 item 2) — shorter queries show a hint
// instead of the whole 60-food DB.
function searchFoods(query){
  const q = query.trim().toLowerCase();
  if(q.length < 2) return [];
  return Object.keys(FOODS)
    .filter(function(id){ return FOODS[id].name.toLowerCase().indexOf(q) !== -1; })
    .sort(function(a, b){ return FOODS[a].name < FOODS[b].name ? -1 : (FOODS[a].name > FOODS[b].name ? 1 : 0); })
    .slice(0, 20);
}

function buildFoodSearchSheet(){
  return '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Add a food</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
    + '<div class="field"><input class="inp" style="width:100%;box-sizing:border-box;border:1px solid var(--line)" type="text" id="foodSearchInput" placeholder="Search foods… (e.g. yogurt)" value="'+jsAttr(quickAdd.query)+'" oninput="onFoodSearchInput(this.value)" autocomplete="off"></div>'
    + '<div id="foodSearchResults">' + renderFoodSearchResults() + '</div>';
}

function renderFoodSearchResults(){
  const q = quickAdd.query.trim();
  if(q.length < 2) return '<p class="sub" style="margin-top:10px">Type at least 2 letters to search.</p>';
  const ids = searchFoods(q);
  if(!ids.length) return '<p class="sub" style="margin-top:10px">No foods match “' + q + '”.</p>';
  return ids.map(function(id){
    const f = FOODS[id];
    const per = f.unit === 'piece' ? 'piece' : '100' + f.unit;
    return '<div class="altrow" onclick="selectQuickAddFood(\''+id+'\')">'
      + '<div class="ae">🥄</div>'
      + '<div class="at"><div class="an">'+f.name+'</div>'
      + '<div class="ad">'+Math.round(f.kcal)+' kcal · '+f.protein+'g protein <b>/ '+per+'</b></div></div>'
      + '</div>';
  }).join('');
}

function onFoodSearchInput(value){
  quickAdd.query = value;
  const el = document.getElementById('foodSearchResults');
  if(el) el.innerHTML = renderFoodSearchResults();
}

function selectQuickAddFood(id){
  if(!FOODS[id]) return;
  quickAdd.selectedId = id;
  quickAdd.grams = 100;
  document.getElementById('sheetBody').innerHTML = buildGramsStepperSheet();
}

function stepQuickAddGrams(delta){
  quickAdd.grams = Math.max(10, Math.min(2000, quickAdd.grams + delta));
  document.getElementById('sheetBody').innerHTML = buildGramsStepperSheet();
}

function buildGramsStepperSheet(){
  const food = FOODS[quickAdd.selectedId];
  if(!food) return buildFoodSearchSheet();
  const nut = foodMacros(quickAdd.selectedId, quickAdd.grams);
  const pieceHint = food.unit === 'piece' ? ' (≈' + (+(quickAdd.grams / food.avgG).toFixed(1)) + ' piece)' : '';
  return '<div class="row between" style="margin-top:6px"><h2 style="margin:0">'+food.name+'</h2><button class="backbtn" style="margin:0" onclick="openFoodSearch()">‹ Back</button></div>'
    + '<div class="serve-row" style="margin-top:14px"><div class="serve-card me" style="flex:1">'
    + '<div class="sv-name">Amount</div>'
    + '<div class="sv-stepper"><button onclick="stepQuickAddGrams(-10)" aria-label="Decrease grams">–</button>'
    + '<span class="sv-val">'+quickAdd.grams+'g'+pieceHint+'</span>'
    + '<button onclick="stepQuickAddGrams(10)" aria-label="Increase grams">+</button></div></div></div>'
    + '<div class="nutri" style="margin-top:16px">'
    + '<div class="n"><div class="nt"><span>Calories</span><b>'+Math.round(nut.kcal)+' kcal</b></div></div>'
    + '<div class="n"><div class="nt"><span>Protein</span><b>'+Math.round(nut.protein)+' g</b></div></div>'
    + '<div class="n"><div class="nt"><span>Carbs</span><b>'+Math.round(nut.carbs)+' g</b></div></div>'
    + '<div class="n"><div class="nt"><span>Fat</span><b>'+Math.round(nut.fat)+' g</b></div></div>'
    + '</div>'
    + '<button class="cta" onclick="confirmQuickAdd()">Add to today</button>'
    + '<button class="cta ghostbtn" onclick="closeSheet()">Cancel</button>';
}

function confirmQuickAdd(){
  if(!quickAdd.selectedId || !FOODS[quickAdd.selectedId]) return;
  const food = FOODS[quickAdd.selectedId];
  const grams = quickAdd.grams;
  logFoodEntry(todayISO(), currentProf, quickAdd.selectedId, grams);
  recomputeConsumed(currentProf);
  recomputeProf(currentProf);
  refreshRingAndBars();
  updateLogTotalPill();
  renderTodaySoFar();
  persist();
  closeSheet();
  toast('✓ Added ' + grams + 'g ' + food.name + ' to today');
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
// ("share just a recipe with each other") — it only ever ADDS to customFoods/
// customRecipes, nothing else on this phone changes. "Replace everything" is the
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
// screen, in-memory global (PROF, weekPlan, logHistory, currentProf…) and the compat
// RECIPES view rebuild from scratch against the new store, with zero risk of stale
// in-memory state bleeding through.
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
// js/library.js:mergeImportedLibrary() (customFoods/customRecipes ONLY — see that
// function's doc for the full merge-rule spec: identical-content skip, '-2' conflict
// copies with ingredient remap, " (imported)" on name collisions), then persists +
// re-renders via applyProf() — the exact same pattern saveNewFood()/saveNewRecipe()/
// deleteCustomFood()/deleteCustomRecipe() (js/library.js) already use for every other
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
  applyProf(currentProf); // bumped customRev (if anything was added) regenerates the week, persists either way
  closeSheet();
  const parts = [];
  if(result.addedRecipes) parts.push(result.addedRecipes + ' recipe' + (result.addedRecipes === 1 ? '' : 's'));
  if(result.addedFoods) parts.push(result.addedFoods + ' ingredient' + (result.addedFoods === 1 ? '' : 's'));
  toast(parts.length ? '✓ Added ' + parts.join(' and ') + ' from the backup' : 'Nothing new in that backup — already on this phone');
}
