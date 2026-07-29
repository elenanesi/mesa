/* ===================================================================
   render.js — shared rendering helpers and core profile rendering
   Toast, parseDecimalInput, closeSheet, avatarSlotHtml, applyProf,
   refreshRingAndBars, syncProfileToggle, syncPersonLabels.
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
  document.getElementById('sheetBackdrop').classList.remove('show');
  document.getElementById('sheet').classList.remove('show');
}

/* ---------------- shared meal-card action button ----------------
   Single source of markup for the pending-meal action buttons so Today
   (render-today.js:renderTodayCardActions) and Log (render-today.js:
   buildLogSlotCard) can never visually drift again — "same action => same
   component" everywhere a meal card can be confirmed/swapped/skipped/edited.
   kind: 'skip' | 'swap' | 'log' | 'add'.
   opts.onclick is the FULLY BUILT onclick attribute value (including any
   event.stopPropagation() prefix) — callers keep their exact existing
   behaviour, this only standardizes the visual component around it.
   opts.ariaLabel / opts.title are required for the icon-only buttons (they
   are the only accessible name). opts.hasExtras picks the add/edit glyph. */
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
  if(kind === 'add'){
    const glyph = opts.hasExtras ? '✎' : '＋';
    return '<button class="meal-act-btn act-add" aria-label="'+aria+'" onclick="'+onclick+'" title="'+title+'">'+glyph+'</button>';
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
  document.getElementById('fatSplit').textContent = '💚 ' + p.fatGood + 'g good fats · ' + p.fatSat + 'g sat.';

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

  // --- Progress dots ---
  renderProgressDots();

  // --- Eaten chip strip ---
  renderEatenStrip();
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
  // two-person household, etc.). Every caller of applyProf/setProf goes through here, so
  // this is the single funnel — no other call site needs its own guard.
  if(typeof isSoloHousehold === 'function' && isSoloHousehold() && key === 'partner') key = 'elena';
  currentProf = key;
  const p=PROF[key];
  ensureWeekPlan();       // regenerate the plan first if its inputs changed (task C2)
  recomputeConsumed(key); // consumed-so-far from today's confirmed slots of the real plan
  recomputeProf(key);
  refreshRingAndBars();
  document.getElementById('goalTag').textContent=p.goalTag;
  var stripe = document.getElementById('tintStripe');
  if(stripe){
    stripe.className = 'tint-stripe tint-' + key;
  }
  const coachT = document.getElementById('coachT');
  const coachD = document.getElementById('coachD');
  if(coachT) coachT.textContent=p.coachOverrideT || p.coachT;
  if(coachD) coachD.textContent=p.coachOverrideD || p.coachD;
  document.getElementById('profAv').innerHTML=avatarSlotHtml(key);
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
  renderTodayMeals();
  renderLogPlan();
  renderWeek();
  if(typeof renderInsights === 'function') renderInsights(); // task D1: keep Insights in sync with whoever's now current
  updateRecipeWhy();     // task C3: re-personalize the why-box if the recipe screen is open
  renderRecipeEatenState(); // eaten/skipped is per-person (slotLogStatus keyed by currentProf) — re-derive on profile switch too
  renderRecipeMealStrip();
  syncServeHighlight();
  syncProfileToggle(key);
  syncPersonLabels(); // task B2: profSeg/profWhoSeg/serve-card NAMES — see its doc below
  applyHouseholdSizeVisibility(); // task B3: hide/show every partner-facing surface for the current household size
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

// Task B2 (generic identity): the ONLY spots left that show a person's NAME rather than
// just their avatar initial (which applyProf() above already repaints via the derived
// p.av) — the "whose plan" segmented controls (top tabbar #profSeg, Profile screen
// #profWhoSeg) and the shared-dinner serve cards, all of which show BOTH people's names
// at once, not just the currently-active one. That's why this reads PROF.elena/partner.
// displayName directly rather than relying on p.seg (recomputeProf only derives seg/av
// for whichever slot applyProf(key) is currently rendering, i.e. the INACTIVE profile's
// derived p.seg can be stale) — the raw displayName field itself is always a valid,
// already-trimmed/capped string (state.js: PROF defaults + loadState()'s guard,
// render.js:commitDisplayName()'s own trim/cap), so no derivation is needed to read it
// safely here. Every assignment below is .textContent/.setAttribute, never innerHTML, so
// no separate escapeHtml() call is needed (DOM text/attribute assignment can't be
// interpreted as markup the way an innerHTML string built by hand would). Called from
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
  const nameE = resolveDisplayName('elena');
  const nameP = resolveDisplayName('partner');

  document.querySelectorAll('#profSeg button[data-prof="elena"]').forEach(function(b){ b.textContent = nameE; });
  document.querySelectorAll('#profSeg button[data-prof="partner"]').forEach(function(b){ b.textContent = nameP; });

  const whoSeg = document.getElementById('profWhoSeg');
  if(whoSeg){
    const btns = whoSeg.querySelectorAll('button');
    if(btns[0]) btns[0].textContent = nameE;
    if(btns[1]) btns[1].textContent = nameP;
  }

  const svNameE = document.querySelector('#serveElena .sv-name');
  if(svNameE) svNameE.textContent = nameE;
  const svNameP = document.querySelector('#serveAndrea .sv-name');
  if(svNameP) svNameP.textContent = nameP;

  // "You" is the default display name for the slot you're setting up, and a screen reader
  // saying "Decrease You's portion" is nonsense — the default names are pronouns, so they
  // need the pronoun possessive rather than the apostrophe-s a real name takes.
  // Decrease/Increase portion aria-labels on the same two serve cards — positional (index
  // 0/1 within each card's .sv-stepper), same convention syncProfileToggle() above uses
  // for profWhoSeg's two buttons, since these were never given stable per-button ids.
  const serveEBtns = document.querySelectorAll('#serveElena .sv-stepper button');
  if(serveEBtns[0]) serveEBtns[0].setAttribute('aria-label', 'Decrease ' + possessiveName(nameE) + ' portion');
  if(serveEBtns[1]) serveEBtns[1].setAttribute('aria-label', 'Increase ' + possessiveName(nameE) + ' portion');
  const servePBtns = document.querySelectorAll('#serveAndrea .sv-stepper button');
  if(servePBtns[0]) servePBtns[0].setAttribute('aria-label', 'Decrease ' + possessiveName(nameP) + ' portion');
  if(servePBtns[1]) servePBtns[1].setAttribute('aria-label', 'Increase ' + possessiveName(nameP) + ' portion');
}

