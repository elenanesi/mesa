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
}

/* ---------------- open a recipe from a tap ---------------- */
function openRecipe(key, origin){
  recipeOrigin = origin || 'today';
  renderRecipe(key);
  go('recipe');
}

function openBreakfastRecipe(){
  openRecipe(activeMenu.breakfastKey, 'today');
}
function openLunchRecipe(){
  openRecipe(activeMenu.lunchKey, 'today');
}
function openDinnerRecipe(){
  openRecipe(activeMenu.dinnerKey, 'today');
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

// Replays today's persisted plan-first log status (state.js: todayLog) onto the cards
// renderLogPlan() just built fresh from the active menu. Runs once at boot, after the
// first applyProf() — silent:true suppresses the confirm/skip toast for a replay, not a
// live tap. Breakfast is never replayed: it has no confirm/skip UI, always auto-done.
function restoreTodayLog(){
  Object.keys(todayLog.slots).forEach(function(slot){
    const entry = todayLog.slots[slot];
    if(!entry || slot === 'breakfast') return;
    if(entry.status === 'confirmed'){
      const card = document.getElementById('log-' + slot);
      if(card){
        if(entry.title){ const t = card.querySelector('.t'); if(t) t.textContent = entry.title; }
        if(entry.emoji){ const th = card.querySelector('.thumb'); if(th) th.textContent = entry.emoji; }
      }
      if(entry.title) TITLES[slot] = entry.title;
      if(entry.emoji) EMOJI[slot] = entry.emoji;
      if(typeof entry.kcal === 'number') LOGKCAL[slot] = entry.kcal;
      logConfirm(slot, true);
    } else if(entry.status === 'skipped'){
      logSkip(slot, true);
    }
  });
}

/* ---------------- init ---------------- */
// Must run after data/foods.js, data/recipes.js and engine.js (recipeNutrition) have
// all loaded, and before anything reads RECIPES — see state.js for what this builds.
buildLegacyRecipesCompat();
loadState();
applyProf(currentProf);
renderRecipe('salmon');
recipeOrigin = 'today';
restoreTodayLog();
maybeShowOnboarding();
