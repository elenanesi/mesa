/* ===================================================================
   app.js — boot sequence, tab navigation, onboarding flow
   The thin glue layer: switching screens, opening a recipe from a
   tap (delegates to render.js's renderRecipe + its own go()), the
   onboarding wizard, and the final boot calls that kick everything
   off once state.js/engine.js/planner.js/render.js have all loaded.
   =================================================================== */

/* ---------------- navigation ---------------- */
function go(id, el){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  document.querySelector('.app').scrollTop = 0;
  var scr = document.getElementById(id); if(scr) scr.scrollTop = 0;
  // sync tabbar highlight
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));
  var tab = el && el.dataset.tab ? el : document.querySelector('.tab[data-tab="'+id+'"]');
  if(tab) tab.classList.add('on');
  // Task D1: Insights is cheap to recompute (≤7 days of small arrays) and only ever
  // needs to be fresh at the moment it's shown, so it repaints on every visit rather than
  // needing an eager call from every log-mutating action (confirm/skip/quick-add/swap).
  if(id === 'insights' && typeof renderInsights === 'function') renderInsights();
  if(id === 'today' && typeof renderTodayHeader === 'function') renderTodayHeader();
}

/* ---------------- open a recipe from a tap ---------------- */
function openRecipe(key, origin){
  recipeOrigin = origin || 'today';
  renderRecipe(key);
  go('recipe');
}

function openBreakfastRecipe(){
  openRecipe(activeMenu.breakfast.recipeId, 'today');
}
function openLunchRecipe(){
  openRecipe(activeMenu.lunch.recipeId, 'today');
}
function openDinnerRecipe(){
  openRecipe(activeMenu.dinner.recipeId, 'today');
}

// top segmented control (Today screen profile switch)
document.querySelectorAll('#profSeg button').forEach(b=>{
  b.addEventListener('click',()=>{
    document.querySelectorAll('#profSeg button').forEach(x=>x.classList.remove('on'));
    b.classList.add('on'); applyProf(b.dataset.prof);
  });
});

/* ---------------- onboarding ---------------- */
let obIndex = 0;
let obProfile = 'elena';

function obShow(i){
  obIndex = i;
  document.querySelectorAll('.ob-slide').forEach(function(s, idx){ s.classList.toggle('active', idx === i); });
  document.querySelectorAll('.ob-dots .d').forEach(function(d, idx){ d.classList.toggle('on', idx === i); });
  document.getElementById('obNext').textContent = i === 2 ? "Let's go →" : 'Continue';
}

function obNext(){
  if(obIndex < 2){ obShow(obIndex + 1); } else { finishOnboarding(); }
}

function renderObGoals(key){
  const goals = key === 'elena'
    ? ['🎯 Gentle fat loss', '🦋 Hashimoto-friendly', '✨ Skin-supporting']
    : ['💪 Muscle & protein', '❤️ Heart-smart'];
  document.getElementById('obGoalsPreview').innerHTML = goals.map(function(g){ return '<span class="pill">'+g+'</span>'; }).join('');
}

function obPick(key){
  obProfile = key;
  document.getElementById('obElena').classList.toggle('sel', key === 'elena');
  document.getElementById('obElena').querySelector('.ck').textContent = key === 'elena' ? '✓' : '';
  document.getElementById('obAndrea').classList.toggle('sel', key === 'partner');
  document.getElementById('obAndrea').querySelector('.ck').textContent = key === 'partner' ? '✓' : '';
  renderObGoals(key);
}

function finishOnboarding(){
  document.getElementById('onboard').classList.add('hidden');
  onboarded = true;               // persisted by applyProf()'s persist() call below
  applyProf(obProfile);
  document.querySelectorAll('#profSeg button').forEach(function(x){ x.classList.toggle('on', x.dataset.prof === obProfile); });
  go('today');
}

function replayOnboarding(){
  obProfile = currentProf;
  obPick(obProfile);
  obShow(0);
  document.getElementById('onboard').classList.remove('hidden');
}

function maybeShowOnboarding(){
  if(!onboarded){
    obPick('elena');
    obShow(0);
    document.getElementById('onboard').classList.remove('hidden');
  }
}

// Replays today's persisted plan-first log status (state.js: logHistory/slotLogStatus)
// onto the cards renderLogPlan() just built fresh from the active menu. Called from the
// END of every renderLogPlan() run (task C2 — confirms survive plan re-renders within the
// same day, not just boot) — silent:true suppresses the confirm/skip toast AND the
// re-log (state.js:logConfirm skips logPlanEntry when silent, since the entry is already
// in logHistory — replaying must never rewrite it with whatever's in activeMenu right
// now). FIX 1 (feedback): breakfast is a normal meal now — replayed here exactly like
// every other slot (the old auto-log path, ensureTodayBreakfastLogged, is gone).
function restoreTodayLog(){
  SLOT_ORDER.forEach(function(slot){
    const status = slotLogStatus(todayISO(), currentProf, slot);
    if(status === 'confirmed'){
      const entry = getDayLog(todayISO())[currentProf].find(function(e){ return e.kind === 'plan' && e.slot === slot; });
      const r = entry && RECIPES[entry.ref];
      const card = document.getElementById('log-' + slot);
      if(card && r){
        const t = card.querySelector('.t'); if(t) t.textContent = r.title;
        const th = card.querySelector('.thumb'); if(th) th.textContent = r.emoji;
      }
      if(r){ TITLES[slot] = r.title; EMOJI[slot] = r.emoji; }
      if(entry) LOGKCAL[slot] = entry.kcal;
      logConfirm(slot, true);
    } else if(status === 'skipped'){
      logSkip(slot, true);
    }
  });
}

/* ---------------- today header (real date + time-aware greeting) ---------------- */
// The mockup shipped a hardcoded "Monday · 29 Jun". Both lines derive from the device
// clock at render time; refreshed on every applyProf() (cheap) so a day rollover while
// the app stays open in the app switcher corrects itself on next interaction.
const WEEKDAY_FULL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
function renderTodayHeader(){
  const now = new Date();
  const el = document.getElementById('todayEyebrow');
  if(el) el.textContent = WEEKDAY_FULL[now.getDay()] + ' · ' + now.getDate() + ' ' + MONTHS[now.getMonth()];
  const g = document.getElementById('todayGreeting');
  const h = now.getHours();
  if(g) g.textContent = h < 5 ? 'Up late?' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/* ---------------- init ---------------- */
// Must run after data/foods.js, data/recipes.js and engine.js (recipeNutrition) have
// all loaded, and before anything reads RECIPES — see state.js for what this builds.
// applyProf() -> ensureWeekPlan() (planner.js) either keeps the persisted weekPlan (same
// signature + same week) or regenerates it deterministically, then persists; it also
// runs renderLogPlan(), which replays today's persisted confirms via restoreTodayLog().
loadState();
applyCustomFoods();     // js/library.js — merge customFoods into FOODS before recipes/compat view need them
applyCustomRecipes();   // js/library.js — merge customRecipes into RECIPES_DB + RECIPE_SLOT_DB, rebuild the
                         // RECIPES compat view (calls buildLegacyRecipesCompat() internally, for every id —
                         // built-in and custom alike — so nothing below needs a separate compat-view call)
renderTodayHeader();
applyProf(currentProf);
renderRecipe('salmon');
recipeOrigin = 'today';
maybeShowOnboarding();

// Task S1 (couple sync): a no-op wherever js/sync.js isn't loaded or a household was
// never configured (syncState.code stays null — see state.js) — no network calls happen
// in that case, per the ground rule that sync is an enhancement, never a dependency.
if(typeof initSync === 'function') initSync();

/* ---------------- service worker registration (task E1) ---------------- */
// Offline shell + installability. Guarded so it's a silent no-op wherever it
// can't work: browsers without SW support, and file:// (not a secure context —
// registration throws there, e.g. opening index.html directly on a phone).
if('serviceWorker' in navigator && location.protocol !== 'file:'){
  window.addEventListener('load', function(){
    navigator.serviceWorker.register('sw.js').catch(function(err){
      console.warn('Mesa: service worker registration failed', err);
    });
  });
}
