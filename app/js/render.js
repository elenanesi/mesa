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
  document.getElementById('recipeWhy').innerHTML = '<b>Why this fits you</b><br>' + r.why;
  document.getElementById('recipeNutri').innerHTML = r.nutrition.map(function(n){ return '<div class="n"><div class="nt"><span>'+n[0]+'</span><b>'+n[1]+'</b></div></div>'; }).join('');
  document.getElementById('recipeKcalSplit').textContent = 'kcal from: ' + r.kcalSplit;
  document.getElementById('recipeMethod').innerHTML = r.method.map(function(s){ return '<li>'+s+'</li>'; }).join('');
  updateServings();
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
    const slot = RECIPE_SLOT[currentRecipeKey] || 'meal';
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
  syncServeHighlight();
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
function renderWeek(){
  // Regenerate every day's meal row to match the active style — simplest deterministic
  // approach; a fuller version would vary specific dishes per day, but this keeps the
  // whole week visibly consistent with the current split at a fraction of the data.
  if(activeMenu){
    const bf = RECIPES[activeMenu.breakfastKey], lu = RECIPES[activeMenu.lunchKey], di = RECIPES[activeMenu.dinnerKey];
    WEEK.forEach(function(day){
      day.meals[0] = {slot:'Breakfast', emoji:bf.emoji, name:bf.title, kcal:bf.kcal, key:activeMenu.breakfastKey};
      day.meals[1] = {slot:'Lunch', emoji:lu.emoji, name:lu.title, kcal:lu.kcal, key:activeMenu.lunchKey};
      day.meals[2] = {slot:'Dinner', emoji:di.emoji, name:di.title, kcal:di.kcal, key:activeMenu.dinnerKey};
    });
  }
  const el = document.getElementById('weekList');
  el.innerHTML = WEEK.map(function(day, di){
    const rows = day.meals.map(function(m){
      const slotKey = m.slot.toLowerCase();
      const together = SHARED[slotKey] ? ' <span class="pill together mini">👥 Together</span>' : '';
      return '<div class="day-meal-row" onclick="event.stopPropagation();openRecipe(\''+m.key+'\',\'week\')">'
        + '<div class="dm-e">'+m.emoji+'</div>'
        + '<div class="dm-t">'+m.name+'<small>'+m.slot+together+'</small></div>'
        + '<div class="dm-k">'+m.kcal+'</div></div>';
    }).join('');
    return '<div class="day'+(day.today?' today':'')+'" id="wd'+di+'" onclick="toggleDay('+di+')">'
      + '<div class="dh"><span class="dn">'+day.d+'</span><span class="dk">~'+day.kcal+' kcal <span class="chev">⌄</span></span></div>'
      + '<div class="dmeals">'+day.meals.map(function(m){return m.name;}).join(' · ')+'</div>'
      + '<div class="day-meals">'+rows+'</div></div>';
  }).join('');
}

function toggleDay(i){
  document.getElementById('wd'+i).classList.toggle('expanded');
}

/* ---------------- bottom sheet: generic open/close ---------------- */
function openSwap(mealKey, targetElId){
  swapCtx = {mealKey: mealKey, targetElId: targetElId};
  document.getElementById('sheetBody').innerHTML = buildSwapSheet(mealKey);
  document.getElementById('sheet').classList.remove('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

function closeSheet(){
  document.getElementById('sheetBackdrop').classList.remove('show');
  document.getElementById('sheet').classList.remove('show');
}

function openShopping(){
  document.getElementById('sheetBody').innerHTML = buildShopSheet();
  document.getElementById('sheet').classList.add('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

// Shopping-list ids (sh-0, sh-1…) are positional and change whenever the list
// recomputes (different week, different servings), so checked state is tracked and
// persisted by ingredient NAME (checkedShopNames, state.js) — the DOM class is just
// this render's presentation of that.
function toggleShop(id, name){
  const el = document.getElementById(id);
  if(!el) return;
  el.classList.toggle('done');
  if(name){
    if(el.classList.contains('done')) checkedShopNames[name] = true;
    else delete checkedShopNames[name];
    persist();
  }
}

// Escapes a name for safe embedding inside a single-quoted inline-JS attribute.
function jsAttr(s){ return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

function buildShopSheet(){
  const list = computeShoppingList();
  const byCat = {};
  Object.keys(list.totals).forEach(function(name){
    const cat = SHOP_CATEGORY[name] || 'Pantry';
    (byCat[cat] = byCat[cat] || []).push(name);
  });
  let html = '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Shopping list <span class="chip-computed">✓ computed</span></h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
    + '<p class="sub">For both of you · 7 days · totals summed from this week\'s plan at your portions (Elena '+svE+'× · Andrea '+svM+'×). Shared meals are counted once. Snacks are pantry-level and not listed.</p>';
  let idx = 0;
  SHOP_CAT_ORDER.forEach(function(cat){
    const names = byCat[cat];
    if(!names || !names.length) return;
    names.sort();
    html += '<div class="shop-cat">'+cat+'</div>';
    names.forEach(function(name){
      const t = list.totals[name];
      const id = 'sh-' + (idx++);
      const done = checkedShopNames[name] ? ' done' : '';
      html += '<div class="shop-item'+done+'" id="'+id+'" onclick="toggleShop(\''+id+'\',\''+jsAttr(name)+'\')"><div class="sck">✓</div><div class="sname">'+name+'</div><div class="sqty">'+fmtShopQty(t.qty, t.unit)+'</div></div>';
    });
  });
  const stapleNames = Object.keys(list.staples).sort();
  if(stapleNames.length){
    html += '<div class="shop-cat">Pantry staples — check you have these</div>';
    stapleNames.forEach(function(name){
      const id = 'sh-' + (idx++);
      const done = checkedShopNames[name] ? ' done' : '';
      html += '<div class="shop-item'+done+'" id="'+id+'" onclick="toggleShop(\''+id+'\',\''+jsAttr(name)+'\')"><div class="sck">✓</div><div class="sname">'+name+'</div></div>';
    });
  }
  return html;
}

/* ---------------- re-balance week (presentation only — see planner.js note) ---------------- */
function buildRebalanceSheet(){
  return '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Re-balance this week</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
    + '<p class="sub">Keeps fixed: your daily calories & protein, foods you avoid, shared dinners. Optimises: closes weekly nutrient gaps (right now: Vitamin D 61%), adds variety where meals repeat. Changes as few meals as possible.</p>'
    + '<div class="card" style="padding:14px">'
    + '<b style="font-size:13px">Would change 2 meals</b>'
    + '<div class="logitem"><div class="li-i" style="background:var(--sage-tint)">🐟</div><div class="li-t">Thu lunch → Sardine & white bean salad<small>+ Vitamin D</small></div></div>'
    + '<div class="logitem" style="border-bottom:0"><div class="li-i" style="background:var(--sage-tint)">🍳</div><div class="li-t">Sat breakfast → Shakshuka with fortified feta<small>+ Vitamin D</small></div></div>'
    + '</div>'
    + '<button class="cta" onclick="applyRebalance()">Apply re-balance</button>'
    + '<button class="cta ghostbtn" onclick="closeSheet()">Cancel</button>';
}

function openRebalanceSheet(){
  document.getElementById('sheetBody').innerHTML = buildRebalanceSheet();
  document.getElementById('sheet').classList.remove('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}

function applyRebalance(){
  closeSheet();
  toast('✓ Week re-balanced — Vitamin D now 89%');
  const chip = document.getElementById('vitDChip');
  if(chip){
    chip.classList.remove('low');
    const b = chip.querySelector('.nt b'); if(b) b.textContent = '89%';
    const bar = chip.querySelector('.nbar i'); if(bar) bar.style.width = '89%';
  }
  const note = document.getElementById('vitDNote');
  if(note) note.innerHTML = '✅ <b>Vitamin D re-balanced to 89%.</b> Thu & Sat swaps added fortified options — nicely varied for the rest of the week.';
}

/* ---------------- log / plan-first confirm ---------------- */
// `silent` is used only by restoreTodayLog() (app.js) replaying a persisted
// confirm/skip at boot, so reload doesn't re-fire the toast for something the
// user already actioned in a previous session.
function logConfirm(key, silent){
  const card = document.getElementById('log-' + key);
  if(!card || card.classList.contains('done') || card.classList.contains('skipped')) return;
  card.classList.add('done');
  const actions = card.querySelector('.logactions'); if(actions) actions.remove();
  const info = card.querySelector('.info');
  const tag = document.createElement('div');
  tag.className = 'confirmed-tag';
  tag.textContent = '✓ Logged · just now';
  info.appendChild(tag);

  const list = document.getElementById('todaySoFar');
  const div = document.createElement('div');
  div.className = 'logitem';
  div.innerHTML = '<div class="li-i">'+EMOJI[key]+'</div><div class="li-t">'+TITLES[key]+'<small>'+SLOT_LABEL[key]+' · just now</small></div><div class="li-k">'+LOGKCAL[key]+'</div>';
  list.appendChild(div);

  logTotal += LOGKCAL[key];
  document.getElementById('logTotalPill').textContent = logTotal + ' kcal';
  if(!silent) toast('✓ Logged to today');

  todayLog.slots[key] = {status:'confirmed', title:TITLES[key], emoji:EMOJI[key], kcal:LOGKCAL[key]};
  persist();
}

function logSkip(key, silent){
  const card = document.getElementById('log-' + key);
  if(!card || card.classList.contains('done') || card.classList.contains('skipped')) return;
  card.classList.add('skipped');
  const actions = card.querySelector('.logactions'); if(actions) actions.remove();
  const info = card.querySelector('.info');
  const tag = document.createElement('div');
  tag.className = 'skipped-tag';
  tag.textContent = 'Skipped for today';
  info.appendChild(tag);
  if(!silent) toast('Skipped — your plan stays balanced');

  todayLog.slots[key] = {status:'skipped'};
  persist();
}

// Builds the four "Today's plan" cards on the Log screen from the active menu.
// Re-running this (e.g. after a macro-split rebuild) resets any confirm/skip taps —
// acceptable per spec, since the underlying plan itself just changed.
function renderLogPlan(){
  if(!activeMenu) return;
  const bf = RECIPES[activeMenu.breakfastKey];
  EMOJI.breakfast = bf.emoji; TITLES.breakfast = bf.title; LOGKCAL.breakfast = bf.kcal;
  const bfCard = document.getElementById('log-breakfast');
  bfCard.className = 'card meal done';
  bfCard.style.cursor = 'default';
  bfCard.innerHTML = '<div class="thumb">'+bf.emoji+'</div><div class="info">'
    + '<div class="row between"><span class="t">'+bf.title+'</span><span class="kcal">'+bf.kcal+'</span></div>'
    + '<div class="d">Breakfast · '+bf.protein+'g protein</div>'
    + '<div class="confirmed-tag">✓ Logged · earlier today</div></div>';

  const lu = RECIPES[activeMenu.lunchKey];
  buildLogSlotCard('lunch', lu.emoji, lu.title, lu.kcal, 'Lunch · '+lu.protein+'g protein');

  const di = RECIPES[activeMenu.dinnerKey];
  buildLogSlotCard('dinner', di.emoji, di.title, di.kcal, 'Dinner · '+di.protein+'g protein');

  const sn = activeMenu.snack;
  buildLogSlotCard('snack', sn.emoji, sn.title, sn.kcal, sn.desc);

  logTotal = bf.kcal;
  document.getElementById('logTotalPill').textContent = logTotal + ' kcal';
  document.getElementById('todaySoFar').innerHTML = '<div class="logitem"><div class="li-i">'+bf.emoji+'</div>'
    + '<div class="li-t">'+bf.title+'<small>Breakfast · earlier today</small></div><div class="li-k">'+bf.kcal+'</div></div>';
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
  renderTogetherPills();
  renderWeek();
  if(document.getElementById('recipe').classList.contains('active')) updateServings();
  persist();
}

function renderTogetherPills(){
  renderTodayMeals();
}

// Renders all four Today cards from the active menu (currentProf's breakfast + the
// shared lunch/dinner/snack for the household's current plan style).
function renderTodayMeals(){
  activeMenu = computeActiveMenu();
  const bf = RECIPES[activeMenu.breakfastKey];
  document.getElementById('bfEmoji').textContent = bf.emoji;
  document.getElementById('bfTitle').textContent = bf.title;
  document.getElementById('bfKcal').textContent = bf.kcal;
  document.getElementById('bfDesc').textContent = 'Breakfast · ' + bf.protein + 'g protein';
  let bfTags = bf.tags.map(function(t){ return '<span class="pill'+(t[0]?' '+t[0]:'')+'">'+t[1]+'</span>'; }).join('');
  bfTags += '<span class="pill together mini" id="pillBreakfast" style="display:'+(SHARED.breakfast?'inline-flex':'none')+'">👥 Together</span>';
  document.getElementById('bfTags').innerHTML = bfTags;

  const lu = RECIPES[activeMenu.lunchKey];
  document.getElementById('lunchThumb').textContent = lu.emoji;
  document.getElementById('lunchTitle').textContent = lu.title;
  document.getElementById('lunchKcal').textContent = lu.kcal;
  document.getElementById('lunchDesc').textContent = 'Lunch · ' + lu.protein + 'g protein';
  let luTags = lu.tags.map(function(t){ return '<span class="pill'+(t[0]?' '+t[0]:'')+'">'+t[1]+'</span>'; }).join('');
  luTags += '<span class="pill together mini" id="pillLunch" style="display:'+(SHARED.lunch?'inline-flex':'none')+'">👥 Together</span>';
  document.getElementById('lunchTags').innerHTML = luTags;

  const di = RECIPES[activeMenu.dinnerKey];
  document.getElementById('dinnerThumb').textContent = di.emoji;
  document.getElementById('dinnerTitle').textContent = di.title;
  document.getElementById('dinnerKcal').textContent = di.kcal;
  document.getElementById('dinnerDesc').textContent = 'Dinner · ' + di.protein + 'g protein';
  let diTags = di.tags.map(function(t){ return '<span class="pill'+(t[0]?' '+t[0]:'')+'">'+t[1]+'</span>'; }).join('');
  diTags += '<span class="pill together mini" id="pillDinner" style="display:'+(SHARED.dinner?'inline-flex':'none')+'">👥 Together</span>';
  document.getElementById('dinnerTags').innerHTML = diTags;

  const sn = activeMenu.snack;
  document.getElementById('snackThumbEl').textContent = sn.emoji;
  document.getElementById('snackTitleEl').textContent = sn.title;
  document.getElementById('snackKcalEl').textContent = sn.kcal;
  document.getElementById('snackDescEl').textContent = sn.desc;
  let snTags = (sn.tags||[]).map(function(t){ return '<span class="pill'+(t[0]?' '+t[0]:'')+'">'+t[1]+'</span>'; }).join('');
  snTags += '<span class="pill together mini" id="pillSnack" style="display:'+(SHARED.snack?'inline-flex':'none')+'">👥 Together</span>';
  document.getElementById('snackTags').innerHTML = snTags;
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

function applyProf(key){
  currentProf = key;
  const p=PROF[key];
  recomputeProf(key);
  document.getElementById('calLeft').textContent=p.calLeft;
  document.getElementById('calGoal').textContent=p.calGoal;
  document.getElementById('goalTag').textContent=p.goalTag;
  document.getElementById('coachT').textContent=p.coachOverrideT || p.coachT;
  document.getElementById('coachD').textContent=p.coachOverrideD || p.coachD;
  document.getElementById('mp').textContent=p.mp;
  document.getElementById('mc').textContent=p.mc;
  document.getElementById('mf').textContent=p.mf;
  document.getElementById('bp').style.width=p.bp;
  document.getElementById('bc').style.width=p.bc;
  document.getElementById('bff').style.width=p.bff;
  document.getElementById('calRing').style.strokeDashoffset=p.off;
  document.getElementById('profAv').textContent=p.av;
  renderBasics();
  document.getElementById('hashiOpt').style.display = p.hashi ? 'flex':'none';
  document.getElementById('fatSplit').textContent = '💚 ' + p.fatGood + 'g good fats · ' + p.fatSat + 'g sat.';
  document.getElementById('ksP').style.width = p.kP + '%';
  document.getElementById('ksC').style.width = p.kC + '%';
  document.getElementById('ksF').style.width = p.kF + '%';
  document.getElementById('kcalSplitLegend').textContent = 'Protein ' + p.kP + '% · Carbs ' + p.kC + '% · Fat ' + p.kF + '% of calories';
  renderSplitEditor();
  renderTodayMeals();
  renderLogPlan();
  renderWeek();
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
