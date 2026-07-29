/* ===================================================================
   render.js — shared rendering helpers and core profile rendering
   Toast, parseDecimalInput, closeSheet, avatarSlotHtml, applyProf,
   refreshRingAndBars, personSwitcherHtml/renderPersonSwitchers, syncPersonLabels.
   Screen-specific renderers live in render-recipe.js, render-week.js,
   render-today.js, render-profile.js, render-sheets.js.
   =================================================================== */

// toast helper
let tT;
function toast(msg){
  const t=document.getElementById('toast');
  t.textContent=msg; t.classList.add('show');
  clearTimeout(tT); tT=setTimeout(()=>t.classList.remove('show'),1900);
}

/* ---------------- Botanical log rewards ----------------
   These are deliberately presentation-only: call sites mutate and refresh first, then
   hand the successful action to this controller. Keeping completion reads directly on
   logHistory avoids getDayLog() creating records while merely checking status. */
let logRewardTimer = null;
const logRewardCompletionKeys = new Set();

function rewardMotionReduced(){
  return typeof window !== 'undefined' && window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function accountedSlotCount(dateISO, person){
  const day = logHistory && logHistory[dateISO];
  if(!day || !Array.isArray(day[person])) return 0;
  const skipped = day.skipped && day.skipped[person] ? day.skipped[person] : {};
  return SLOT_ORDER.reduce(function(total, slot){
    const confirmed = day[person].some(function(entry){
      return entry && entry.kind === 'plan' && entry.slot === slot;
    });
    return total + (confirmed || skipped[slot] ? 1 : 0);
  }, 0);
}

function clearLogReward(){
  clearTimeout(logRewardTimer);
  logRewardTimer = null;
  const layer = document.getElementById('logRewardLayer');
  const live = document.getElementById('logRewardLive');
  if(layer) layer.replaceChildren();
  if(live) live.textContent = '';
}

function rewardLeafHtml(index){
  const values = [
    ['-42px','-48px','-48deg','-24deg','.04s','#70875a','.94','18px','29px'],
    ['0px','-62px','-10deg','18deg','.1s','#9eb176','1.08','19px','31px'],
    ['45px','-40px','38deg','25deg','.15s','#c69a48','.86','17px','27px'],
    ['50px','15px','77deg','19deg','.07s','#71895b','1.02','18px','30px'],
    ['-7px','51px','151deg','-19deg','.17s','#aebd85','.9','17px','28px'],
    ['-49px','24px','-111deg','-26deg','.12s','#bd874f','1.04','19px','31px'],
    ['-37px','-24px','-71deg','20deg','.2s','#91a56f','.86','17px','27px'],
    ['38px','31px','112deg','-21deg','.23s','#aaba82','1.06','19px','31px']
  ][index % 8];
  const leafPath = index % 2
    ? '<path class="leaf-body" d="M8 22C4 18 1.5 14 2.1 9.4 2.7 4.8 6.2 1.7 11.5 1c2.2 5 1.8 9.7-.8 13.9C9.5 17 8.6 19.4 8 22Z"/><path class="leaf-vein" d="M8.2 21C8.4 14.3 9.2 8.7 11 3.2M8.8 13.4l-3.5-3.1M9.4 9.4l2.8-2.8"/>'
    : '<path class="leaf-body" d="M8.1 22C3.7 18.7 1.2 14.2 1.8 9.2 2.4 4.6 5.5 1.7 9.8.9c3.5 4.1 4.6 8.5 2.5 13-1.2 2.7-2.8 5.4-4.2 8.1Z"/><path class="leaf-vein" d="M8.1 21C7.7 14.9 8.1 9 9.5 3.1M8 14.2l-3.4-3M8.2 10.1l3-3.1"/>';
  return '<svg class="log-reward-leaf" viewBox="0 0 16 23" aria-hidden="true" style="--leaf-x:'+values[0]+';--leaf-y:'+values[1]+';--leaf-rotate:'+values[2]+';--leaf-turn:'+values[3]+';--leaf-delay:'+values[4]+';--leaf-color:'+values[5]+';--leaf-scale:'+values[6]+';--leaf-width:'+values[7]+';--leaf-height:'+values[8]+'">'+leafPath+'</svg>';
}

function rewardPoint(anchorEl){
  const phone = document.querySelector('.phone');
  const phoneRect = phone && phone.getBoundingClientRect();
  const rect = anchorEl && typeof anchorEl.left === 'number'
    ? anchorEl
    : (anchorEl && anchorEl.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null);
  if(!phoneRect || !rect) return {x: phoneRect ? phoneRect.width / 2 : 160, y: phoneRect ? phoneRect.height / 2 : 280, width: phoneRect ? phoneRect.width : 320};
  return {
    x: Math.max(38, Math.min(phoneRect.width - 38, rect.left - phoneRect.left + rect.width / 2)),
    y: Math.max(38, Math.min(phoneRect.height - 78, rect.top - phoneRect.top + rect.height / 2)),
    width: phoneRect.width
  };
}

function captureRewardAnchor(anchorEl){
  if(!anchorEl || !anchorEl.getBoundingClientRect) return null;
  const rect = anchorEl.getBoundingClientRect();
  return {left: rect.left, top: rect.top, width: rect.width, height: rect.height};
}

function startLogReward(node, message, duration){
  const layer = document.getElementById('logRewardLayer');
  const live = document.getElementById('logRewardLive');
  if(!layer || !live) return false;
  clearLogReward();
  layer.appendChild(node);
  live.textContent = message;
  if(!rewardMotionReduced() && typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(12);
  logRewardTimer = setTimeout(clearLogReward, rewardMotionReduced() ? 1200 : duration);
  return true;
}

function playLogReward(payload){
  payload = payload || {};
  const point = rewardPoint(payload.anchorRect || payload.anchorEl);
  const title = String(payload.title || 'Meal');
  const kcal = Math.round(Number(payload.kcal) || 0);
  const message = title + ' recorded · ' + kcal + ' kcal.';
  const node = document.createElement('div');
  node.className = 'log-reward';
  node.style.setProperty('--reward-x', point.x + 'px');
  node.style.setProperty('--reward-y', point.y + 'px');
  node.style.setProperty('--reward-message-x', (Math.max(122, Math.min(point.width - 122, point.x)) - point.x) + 'px');
  node.innerHTML = '<div class="log-reward-stamp" aria-hidden="true"><svg viewBox="0 0 36 36"><path class="seal-branch" d="m8.5 18.3 5.4 5.2L27.2 9.8M14 23.1c3.2-3.1 6.5-6.2 10.5-8.9"/><path class="seal-leaf" d="M17 20.3c-3.9.3-6.2-1.1-7.2-4.2 3.6-.7 6.1.7 7.2 4.2ZM21 16.8c-.2-3.7 1.3-6 4.5-6.9.5 3.5-1 5.8-4.5 6.9ZM17.7 19.8c3.5.5 5.4 2.2 5.8 5.1-3.4.1-5.3-1.6-5.8-5.1Z"/></svg></div>'
    + rewardLeafHtml(0) + rewardLeafHtml(1) + rewardLeafHtml(2) + rewardLeafHtml(3) + rewardLeafHtml(4) + rewardLeafHtml(5)
    + '<div class="log-reward-message"></div>';
  node.querySelector('.log-reward-message').textContent = message;
  return startLogReward(node, message, 1550);
}

function playDayCompletionReward(payload){
  payload = payload || {};
  const key = String(payload.dateISO || '') + '|' + String(payload.person || '');
  if(!payload.dateISO || !payload.person || typeof todayISO !== 'function' || payload.dateISO !== todayISO() || accountedSlotCount(payload.dateISO, payload.person) < SLOT_ORDER.length || logRewardCompletionKeys.has(key)) return false;
  logRewardCompletionKeys.add(key);
  const message = 'Today’s record is complete.';
  const node = document.createElement('div');
  node.className = 'log-reward log-reward--complete';
  const wreath = document.createElement('div');
  wreath.className = 'log-reward-wreath';
  wreath.innerHTML = '<div class="log-reward-wreath-seal" aria-hidden="true"><svg viewBox="0 0 56 56"><path class="seal-branch" d="m12 29 9 8.5L44 16M21.2 37c5.6-5.2 11.1-10.4 18-15.2"/><path class="seal-leaf" d="M26 32c-6.7.4-10.7-2-12.3-7.3 6.2-1.1 10.3 1.4 12.3 7.3ZM33 26c-.3-6.3 2.3-10.2 7.8-11.8.8 6-1.8 9.9-7.8 11.8ZM27.3 31.2c5.9.8 9.2 3.7 9.8 8.7-5.8.1-9-2.8-9.8-8.7Z"/></svg></div>'
    + rewardLeafHtml(0) + rewardLeafHtml(1) + rewardLeafHtml(2) + rewardLeafHtml(3) + rewardLeafHtml(4) + rewardLeafHtml(5) + rewardLeafHtml(6) + rewardLeafHtml(7)
    + '<div class="log-reward-message"></div>';
  wreath.querySelector('.log-reward-message').textContent = message;
  node.appendChild(wreath);
  return startLogReward(node, message, 2200);
}

// Implements the optional onMesaPersistFailed(err) hook state.js calls (see persist() in
// state.js) on the healthy->unhealthy transition of a localStorage write — i.e. once when
// storage first fails, not again on every subsequent failed write while it stays broken.
// The user can't see console.error on a phone, so this is the only signal they get that
// their data stopped saving.
function onMesaPersistFailed(err){
  toast('Could not save — device storage is full, recent changes may be lost');
}

/* ---------------- FIX 2 (feedback): typeable numeric fields ----------------
   Every field that used to be stepper-only (+/- only) now also accepts direct
   typing, with BOTH comma and dot as the decimal separator ("7,4" -> 7.4, the
   Italian keyboard's native decimal key). One parser shared by every commit
   function below (ingredient macros in library.js, recipe-builder/quick-add
   grams, profile height/weight/calories) so "what counts as a valid number"
   never drifts between fields. Returns null for anything that isn't a finite
   number (blank, "abc", "-", "7,4,2"…) — callers treat null (and, per field,
   negative numbers) as invalid and revert with a toast rather than guessing. */
function parseDecimalInput(str){
  if(typeof str !== 'string') return null;
  const cleaned = str.trim().replace(/\s+/g, '').replace(',', '.');
  if(cleaned === '' || cleaned === '-' || cleaned === '.' || cleaned === '-.') return null;
  const n = Number(cleaned);
  return isFinite(n) ? n : null;
}

function closeSheet(){
  if(typeof stopBarcodeScanner === 'function') stopBarcodeScanner();
  const sheet = document.getElementById('sheet');
  const wasRecipeFilterSheet = sheet.classList.contains('recipe-filter-sheet');
  document.getElementById('sheetBackdrop').classList.remove('show');
  sheet.classList.remove('show');
  sheet.classList.remove('recipe-filter-sheet');
  if(wasRecipeFilterSheet && typeof libRecipeFiltersOpen !== 'undefined'){
    libRecipeFiltersOpen = false;
    if(typeof rerenderLibRecipeFilteredView === 'function') rerenderLibRecipeFilteredView();
  }
}

/* ---------------- shared meal-card action button ----------------
   Single source of markup for the Today screen's pending-meal action buttons
   (render-today.js:renderTodayCardActions) — "same action => same component"
   for skip/swap/log wherever a meal card can be confirmed/swapped/skipped.
   kind: 'skip' | 'swap' | 'log'.
   opts.onclick is the FULLY BUILT onclick attribute value (including any
   event.stopPropagation() prefix) — callers keep their exact existing
   behaviour, this only standardizes the visual component around it.
   opts.ariaLabel / opts.title are required for the icon-only buttons (they
   are the only accessible name). */
function mealActionButtonHtml(kind, opts){
  opts = opts || {};
  const onclick = opts.onclick || '';
  const aria = opts.ariaLabel || '';
  const title = opts.title || '';
  if(kind === 'log'){
    return '<button class="meal-log-btn" aria-label="'+aria+'" onclick="'+onclick+'" title="'+title+'"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11.35 3.836c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-2.25-2.25h-1.5a2.25 2.25 0 0 0-2.15 1.586z"/><path d="M9.298 3H7.5A2.25 2.25 0 0 0 5.25 5.25v13.5A2.25 2.25 0 0 0 7.5 21h9a2.25 2.25 0 0 0 2.25-2.25V5.25A2.25 2.25 0 0 0 16.5 3h-.298"/><path d="m9 14 2 2 4-4"/></svg></button>';
  }
  if(kind === 'skip'){
    return '<button class="meal-act-btn act-skip" aria-label="'+aria+'" onclick="'+onclick+'" title="'+title+'"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5l14 14"/><path d="M19 5L5 19"/></svg></button>';
  }
  if(kind === 'swap'){
    return '<button class="meal-act-btn act-swap" aria-label="'+aria+'" onclick="'+onclick+'" title="'+title+'"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3l4 4-4 4"/><path d="M20 7H4"/><path d="M8 21l-4-4 4-4"/><path d="M4 17h16"/></svg></button>';
  }
  return '';
}

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
  var p = PROF[currentProf];
  document.getElementById('calLeft').textContent = p.calLeft;
  document.getElementById('calGoal').textContent = p.calGoal;
  document.getElementById('mp').textContent = p.mp;
  document.getElementById('mc').textContent = p.mc;
  document.getElementById('mf').textContent = p.mf;
  document.getElementById('bp').style.width = p.bp;
  document.getElementById('bc').style.width = p.bc;
  document.getElementById('bff').style.width = p.bff;
  // fat split line is hidden; fatSplit still set for recipe detail etc.
  document.getElementById('fatSplit').textContent = '◌ ' + p.fatGood + 'g non-saturated fat (estimate) · ' + p.fatSat + 'g sat.';

  // --- Segmented donut ---
  var C = 351.8; // 2 * PI * 56
  var kcal = p.calGoalNum || 0;
  var pPct = p.kP || 0, cPct = p.kC || 0, fPct = p.kF || 0;
  // Compute remaining kcal per macro
  var pTarget = p.targetP || 0, cTarget = p.targetC || 0, fTarget = p.targetF || 0;
  var pEaten = p.consumed ? p.consumed.p : 0;
  var cEaten = p.consumed ? p.consumed.c : 0;
  var fEaten = p.consumed ? p.consumed.f : 0;
  var pLeft = Math.max(0, pTarget - pEaten);
  var cLeft = Math.max(0, cTarget - cEaten);
  var fLeft = Math.max(0, fTarget - fEaten);
  var totalLeft = pLeft * 4 + cLeft * 4 + fLeft * 9;
  // Arc lengths proportional to remaining kcal
  var pArc, cArc, fArc;
  if(totalLeft > 0){
    pArc = (pLeft * 4 / totalLeft) * C;
    cArc = (cLeft * 4 / totalLeft) * C;
    fArc = (fLeft * 9 / totalLeft) * C;
  } else {
    pArc = 0; cArc = 0; fArc = 0;
  }
  // Scale arcs by how much of total kcal is remaining
  var consumedFraction = kcal > 0 ? Math.min(1, p.consumedKcal / kcal) : 0;
  var remainFraction = 1 - consumedFraction;
  pArc *= remainFraction; cArc *= remainFraction; fArc *= remainFraction;
  // Tiny gap between arcs
  var gap = (pArc > 0 && cArc > 0 || cArc > 0 && fArc > 0 || pArc > 0 && fArc > 0) ? 3 : 0;
  // Paint arcs: protein starts at top, then carbs, then fat
  var pEl = document.getElementById('arcProtein');
  var cEl = document.getElementById('arcCarbs');
  var fEl = document.getElementById('arcFat');
  if(pEl){
    var pLen = Math.max(0, pArc - gap);
    pEl.setAttribute('stroke-dasharray', pLen + ' ' + (C - pLen));
    pEl.setAttribute('stroke-dashoffset', '0');
  }
  if(cEl){
    var cLen = Math.max(0, cArc - gap);
    var cOffset = -(pArc);
    cEl.setAttribute('stroke-dasharray', cLen + ' ' + (C - cLen));
    cEl.setAttribute('stroke-dashoffset', cOffset);
  }
  if(fEl){
    var fLen = Math.max(0, fArc - gap);
    var fOffset = -(pArc + cArc);
    fEl.setAttribute('stroke-dasharray', fLen + ' ' + (C - fLen));
    fEl.setAttribute('stroke-dashoffset', fOffset);
  }

  // Overeating indicator: center text turns terra when over
  var calLeftEl = document.getElementById('calLeft');
  var remaining = kcal - p.consumedKcal;
  if(remaining < 0){
    calLeftEl.classList.add('ring-over');
  } else {
    calLeftEl.classList.remove('ring-over');
  }

  // Over-eaten macro: bar turns full + add overflow indicator
  // (handled by existing clamping in engine.js — bar stops at 100%)

  // Inline percentages
  var pctP = document.getElementById('pctP');
  var pctC = document.getElementById('pctC');
  var pctF = document.getElementById('pctF');
  if(pctP) pctP.textContent = pPct + '%';
  if(pctC) pctC.textContent = cPct + '%';
  if(pctF) pctF.textContent = fPct + '%';

  // The compact Today glance is intentionally a status cue, not a second dashboard.
  // It keeps some colour and immediate feedback near the greeting while the full ring
  // and target bars remain after the meal actions.
  var glanceKcal = document.getElementById('todayGlanceKcal');
  var glanceP = document.getElementById('todayGlanceP');
  var glanceC = document.getElementById('todayGlanceC');
  var glanceF = document.getElementById('todayGlanceF');
  // calLeft is deliberately display-formatted by recomputeProf() (e.g. "2,150"),
  // so never feed it to Math.round(): parsing that localized string produces NaN.
  var rawLeft = Number.isFinite(p.calGoalNum) ? p.calGoalNum - (p.consumedKcal || 0) : null;
  if(glanceKcal) glanceKcal.textContent = rawLeft === null ? 'Set a calorie target' : fmtKcal(Math.round(rawLeft)) + ' kcal left';
  if(glanceP) glanceP.textContent = Math.round(pEaten) + 'g';
  if(glanceC) glanceC.textContent = Math.round(cEaten) + 'g';
  if(glanceF) glanceF.textContent = Math.round(fEaten) + 'g';

  // --- Progress dots ---
  renderProgressDots();

}

// The fuller calorie and nutrient view deliberately stays after the meal cards. This
// glance is a shortcut to it, keeping Today action-first without hiding the information.
function showTodayProgress(){
  var detail = document.getElementById('todayProgressCard');
  if(!detail) return;
  detail.scrollIntoView({behavior:'smooth', block:'start'});
}

/* ===================================================================
   Phase 3C (C3) — avatar photo-or-initial helper

   The ONE place that decides what goes INSIDE an avatar slot: a member's Google photo
   when memberInfo(slot) (js/auth.js, typeof-guarded — degrades cleanly to the initial
   letter when auth.js is absent or the roster has no entry for this slot) has an
   https:// picture URL, else the initial-letter text this app has always shown
   (state.js:avatarInitial via PROF[slot].av, recomputed every applyProf by
   engine.js:recomputeProf). Every avatar call site assigns the RETURNED STRING via
   .innerHTML to an existing, already-sized/round CONTAINER (mesa.css .avatar,
   .profile-icon-btn span) — this only ever changes what's inside that container, never
   its size or shape, so it stays a drop-in replacement for the old `.textContent = p.av`.

   Picture URL is validated (must start with 'https://') and escaped for the src
   attribute with htmlAttr() (state.js) before it ever touches innerHTML — same
   stored-XSS discipline renderAccountSection() (js/auth.js) already applies to this
   exact field. The onerror handler swaps the <img> back to the initial letter via
   outerHTML — jsAttr() (state.js) is the right escaper here because the string crosses
   two parsers: it's a JS string literal (the outerHTML assignment) sitting inside an
   HTML attribute (onerror="..."), which is exactly what jsAttr's doc says it's for —
   so an expired/blocked/offline Google URL degrades to the same initial circle rather
   than leaving a blank hole. */
function avatarSlotHtml(slot){
  const p = (typeof PROF !== 'undefined' && PROF) ? PROF[slot] : null;
  const rawInitial = (p && typeof p.av === 'string' && p.av)
    ? p.av
    : avatarInitial(typeof resolveDisplayName === 'function' ? resolveDisplayName(slot) : '');
  const info = (typeof memberInfo === 'function') ? memberInfo(slot) : null;
  const picture = (info && typeof info.picture === 'string' && info.picture.indexOf('https://') === 0) ? info.picture : null;
  if(!picture) return escapeHtml(rawInitial);
  // Deliberately NOT loading="lazy": these two avatars are always on screen (Today header
  // and Profile), so deferring a ~40px image buys nothing, and lazy loading measurably
  // hurts here — the request can be postponed indefinitely when the element is written by
  // script rather than scrolled into view, which also postpones the onerror fallback and
  // leaves an empty circle instead of the initial letter.
  return '<img src="' + htmlAttr(picture) + '" alt="" referrerpolicy="no-referrer" '
    + 'style="width:100%;height:100%;border-radius:50%;object-fit:cover;display:block" '
    + "onerror=\"this.outerHTML='" + jsAttr(rawInitial) + "'\">";
}

function applyProf(key){
  // Task B3 (solo households): the partner slot is hidden everywhere user-visible, so a
  // one-person household can never be VIEWING it — force back to 'elena' regardless of what
  // was asked for (a stale currentProf from before "Just me" was set, a synced value from a
  // two-person household, etc.). Every caller (the person-switcher delegated click listener
  // in app.js, auth.js, onboarding, ...) goes through here, so this is the single funnel —
  // no other call site needs its own guard.
  if(typeof isSoloHousehold === 'function' && isSoloHousehold() && key === 'partner') key = 'elena';
  currentProf = key;
  const p=PROF[key];
  ensureWeekPlan();       // regenerate the plan first if its inputs changed (task C2)
  recomputeConsumed(key); // consumed-so-far from today's confirmed slots of the real plan
  recomputeProf(key);
  refreshRingAndBars();
  var goalTag = document.getElementById('goalTag');
  if(goalTag) goalTag.textContent=p.goalTag;
  var stripe = document.getElementById('tintStripe');
  if(stripe){
    stripe.className = 'tint-stripe tint-' + key;
  }
  const coachT = document.getElementById('coachT');
  const coachD = document.getElementById('coachD');
  if(coachT) coachT.textContent=p.coachOverrideT || p.coachT;
  if(coachD) coachD.textContent=p.coachOverrideD || p.coachD;
  document.getElementById('profAv').innerHTML=avatarSlotHtml(key);
  ['profileAboutAv', 'profileNutritionAv', 'profilePreferencesAv', 'profileAccountAv'].forEach(function(id){
    const el = document.getElementById(id);
    if(el) el.innerHTML = avatarSlotHtml(key);
  });
  const topAv = document.getElementById('topProfAv');
  if(topAv) topAv.innerHTML = avatarSlotHtml(key);
  renderBasics();
  const pKcal = Math.round(p.calGoalNum * p.kP / 100);
  const cKcal = Math.round(p.calGoalNum * p.kC / 100);
  const fKcal = p.calGoalNum - pKcal - cKcal;
  document.getElementById('kcalProteinText').textContent = fmtKcal(pKcal) + ' kcal';
  document.getElementById('kcalCarbsText').textContent = fmtKcal(cKcal) + ' kcal';
  document.getElementById('kcalFatText').textContent = fmtKcal(fKcal) + ' kcal';
  document.getElementById('kcalProteinMeta').textContent = p.targetP + 'g · ' + p.kP + '%';
  document.getElementById('kcalCarbsMeta').textContent = p.targetC + 'g · ' + p.kC + '%';
  document.getElementById('kcalFatMeta').textContent = p.targetF + 'g · ' + p.kF + '%';
  document.getElementById('kcalSplitLegend').textContent = 'Target split for ' + p.calGoal + ' today';
  renderSplitEditor();
  renderGoalsEditor();  // task B1: real per-profile "Health goals" checklist
  renderAvoidEditor();  // task C3: "Foods to avoid" pills for whichever profile is now active
  if(typeof renderDietEditor === 'function') renderDietEditor(); // multi-select "Diet" section for whichever profile is now active
  if(typeof renderFoodLibraryCount === 'function') renderFoodLibraryCount(); // js/library.js: "N built-in · M yours"
  if(typeof renderAccountSection === 'function') renderAccountSection(); // js/auth.js (Phase 3A): "Account" section
  if(typeof renderCoupleSync === 'function') renderCoupleSync(); // js/sync.js (task S1): "Couple sync" section
  if(typeof renderProfileHubSummaries === 'function') renderProfileHubSummaries();
  renderTodayMeals();
  renderLogScreen();
  renderWeek();
  if(typeof renderInsights === 'function') renderInsights(); // task D1: keep Insights in sync with whoever's now current
  updateRecipeWhy();     // task C3: re-personalize the why-box if the recipe screen is open
  renderRecipeEatenState(); // eaten/skipped is per-person (slotLogStatus keyed by currentProf) — re-derive on profile switch too
  renderRecipeMealStrip();
  syncServeHighlight();
  syncPersonLabels(); // task B2 (+ person-switcher unification): repaints every "shows a name" spot, including every person-switcher mount via renderPersonSwitchers() — see its doc below
  applyHouseholdSizeVisibility(); // task B3: hide/show every partner-facing surface for the current household size
  persist();
}

/* ===================================================================
   Shared "whose plan" person-switcher component

   Every per-person screen needs a visible control saying whose numbers are on
   screen and letting the user change it: Today's topbar (#profSeg), Profile
   (#profWhoSeg), and — as of this batch — Week/Insights/Log (#weekProfSeg/
   #insightsProfSeg/#logProfSeg). Before this, #profSeg and #profWhoSeg were
   two hand-authored, independently-wired copies (a static markup pair in
   index.html each, one driven by an addEventListener loop in app.js, the
   other by onclick="setProf(...)"), and Week/Insights/Log had no switcher at
   all. That's exactly the copy-paste drift mealActionButtonHtml() (above)
   already fixed once for meal-action buttons — same fix, same shape, applied
   here: ONE render helper feeds every mount, and ONE delegated click listener
   (app.js) handles every mount, so active-state/names/solo-hiding can never
   disagree between screens.

   personSwitcherHtml() returns the two <button> elements (data-prof keyed
   "elena"/"partner") for whichever slot is currently active (currentProf), or '' for a
   solo household — a control with one option is noise (Task B3's existing
   rule, now applied to the switcher itself rather than just its partner
   button). Names go through escapeHtml() because — unlike the old
   .textContent-based label paint below — this builds an innerHTML string
   that a caller assigns wholesale, so a hostile displayName must be
   neutralized here, not just left to the DOM API to keep safe. */
function personSwitcherHtml(){
  if(typeof isSoloHousehold === 'function' && isSoloHousehold()) return '';
  const nameE = escapeHtml(resolveDisplayName('elena'));
  const nameP = escapeHtml(resolveDisplayName('partner'));
  const clsE = currentProf === 'elena' ? ' class="on"' : '';
  const clsP = currentProf === 'partner' ? ' class="on"' : '';
  // 'flex:1 1 auto', not the bare 'flex:1' the fixed-label .seg controls use: 'flex:1' is
  // basis 0, which leaves the pill's own content-based width a hair narrower than the two
  // names actually need. That used to be invisible (the text simply spilled), but .seg
  // button now ellipsizes overflow (mesa.css) to survive long names, so a basis of 0 turns
  // into a clipped 'Andre…' on names that fit perfectly well. Basis auto sizes the pill to
  // the real text, so the two halves now differ by the length of the names rather than
  // being forced to identical widths — the trade for never truncating a name that fits.
  return '<button' + clsE + ' style="flex:1 1 auto" data-prof="elena">' + nameE + '</button>'
       + '<button' + clsP + ' style="flex:1 1 auto" data-prof="partner">' + nameP + '</button>';
}

// Paints personSwitcherHtml() into every mount marked data-person-switcher (index.html:
// #profSeg, #profWhoSeg, #weekProfSeg, #insightsProfSeg, #logProfSeg — new mounts need
// nothing beyond that attribute + the app.js delegated listener already handling
// [data-person-switcher] generically). Hides the mount itself in a solo household (rather
// than leaving an empty '.seg' bar) since personSwitcherHtml() returns '' in that case.
// Called from syncPersonLabels() (i.e. every applyProf()), so it's always current.
function renderPersonSwitchers(){
  const solo = typeof isSoloHousehold === 'function' && isSoloHousehold();
  const html = personSwitcherHtml();
  document.querySelectorAll('[data-person-switcher]').forEach(function(mount){
    mount.style.display = solo ? 'none' : '';
    mount.innerHTML = html;
  });
}

// Task B2 (generic identity): the ONLY spots left that show a person's NAME rather than
// just their avatar initial (which applyProf() above already repaints via the derived
// p.av) — every person-switcher mount (renderPersonSwitchers() above) and the
// shared-dinner serve cards, all of which show BOTH people's names at once, not just the
// currently-active one. That's why this reads PROF.elena/partner.displayName directly
// rather than relying on p.seg (recomputeProf only derives seg/av for whichever slot
// applyProf(key) is currently rendering, i.e. the INACTIVE profile's derived p.seg can be
// stale) — the raw displayName field itself is always a valid, already-trimmed/capped
// string (state.js: PROF defaults + loadState()'s guard, render.js:commitDisplayName()'s
// own trim/cap), so no derivation is needed to read it safely here. Called from
// applyProf() (covers boot, profile switch, every Basics edit) and directly from
// commitDisplayName()'s cascade and auth.js's Google-name seed.
// 'You' -> 'your', 'Partner' -> 'your partner’s', a real name -> "Sofia’s". Used for the
// serve-card aria-labels, which read as a sentence to a screen reader.
function possessiveName(name){
  const n = (name || '').trim();
  if(n.toLowerCase() === 'you') return 'your';
  if(n.toLowerCase() === 'partner') return 'your partner’s';
  return n + '’s';
}

function syncPersonLabels(){
  renderPersonSwitchers(); // every "whose plan" mount — names + active state + solo-hiding, all from one place now

  const nameE = resolveDisplayName('elena');
  const nameP = resolveDisplayName('partner');

  const svNameE = document.querySelector('#serveElena .sv-name');
  if(svNameE) svNameE.textContent = nameE;
  const svNameP = document.querySelector('#serveAndrea .sv-name');
  if(svNameP) svNameP.textContent = nameP;

  // "You" is the default display name for the slot you're setting up, and a screen reader
  // saying "Decrease You's portion" is nonsense — the default names are pronouns, so they
  // need the pronoun possessive rather than the apostrophe-s a real name takes.
  // Decrease/Increase portion aria-labels on the same two serve cards — positional (index
  // 0/1 within each card's .sv-stepper), since these were never given stable per-button ids.
  const serveEBtns = document.querySelectorAll('#serveElena .sv-stepper button');
  if(serveEBtns[0]) serveEBtns[0].setAttribute('aria-label', 'Decrease ' + possessiveName(nameE) + ' portion');
  if(serveEBtns[1]) serveEBtns[1].setAttribute('aria-label', 'Increase ' + possessiveName(nameE) + ' portion');
  const servePBtns = document.querySelectorAll('#serveAndrea .sv-stepper button');
  if(servePBtns[0]) servePBtns[0].setAttribute('aria-label', 'Decrease ' + possessiveName(nameP) + ' portion');
  if(servePBtns[1]) servePBtns[1].setAttribute('aria-label', 'Increase ' + possessiveName(nameP) + ' portion');
}
