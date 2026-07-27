/* ===================================================================
   app.js — boot sequence, tab navigation, onboarding flow
   The thin glue layer: switching screens, opening a recipe from a
   tap (delegates to render.js's renderRecipe + its own go()), the
   onboarding wizard, and the final boot calls that kick everything
   off once state.js/engine.js/planner.js/render.js have all loaded.
   =================================================================== */

/* ---------------- navigation ---------------- */
function go(id, el){
  // Resolve the target screen BEFORE touching any classList. Bug fix: this used to
  // blindly remove .active from every screen and then do document.getElementById(id)
  // .classList.add('active') in the same breath — if `id` didn't resolve to an element
  // (or anything upstream threw), every screen had already lost .active with nothing
  // re-added, leaving the whole app showing just the background + tab bar (reproduced:
  // calling go() with a bad id blanks the entire app this way). Bailing out here before
  // any mutation means a bad/late id is a no-op instead of a blank screen.
  var target = document.getElementById(id);
  if(!target){ console.warn('Mesa: go() called with unknown screen id', id); return; }
  if(id !== 'libraryScanner' && typeof stopBarcodeScanner === 'function') stopBarcodeScanner();
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  target.classList.add('active');
  document.querySelector('.app').scrollTop = 0;
  var scr = target; if(scr) scr.scrollTop = 0;
  // sync tabbar highlight
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));
  var tabId = id.indexOf('library') === 0 ? 'library' : id;
  var tab = el && el.dataset.tab ? el : document.querySelector('.tab[data-tab="'+tabId+'"]');
  if(tab) tab.classList.add('on');
  // Task D1: Insights is cheap to recompute (≤7 days of small arrays) and only ever
  // needs to be fresh at the moment it's shown, so it repaints on every visit rather than
  // needing an eager call from every log-mutating action (confirm/skip/quick-add/swap).
  if(id === 'insights' && typeof renderInsights === 'function') renderInsights();
  if(id === 'today' && typeof renderTodayHeader === 'function') renderTodayHeader();
}

/* ---------------- open a recipe from a tap ---------------- */
function openRecipe(key, origin, dayCtx){
  recipeOrigin = origin || 'today';
  recipeDayCtx = dayCtx || null;
  renderRecipe(key);
  go('recipe');
}

function todayRecipeCtx(slot){
  return {weekStartDate: mondayOfWeek(todayISO()), dayIndex: todayDayIndex(), slot: slot, person: currentProf};
}

function openBreakfastRecipe(){
  openRecipe(displayedTodayRecipeId('breakfast') || activeMenu.breakfast.recipeId, 'today', todayRecipeCtx('breakfast'));
}
function openLunchRecipe(){
  openRecipe(displayedTodayRecipeId('lunch') || activeMenu.lunch.recipeId, 'today', todayRecipeCtx('lunch'));
}
function openDinnerRecipe(){
  openRecipe(displayedTodayRecipeId('dinner') || activeMenu.dinner.recipeId, 'today', todayRecipeCtx('dinner'));
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
  document.getElementById('obNext').textContent = i === 4 ? "Let's go →" : 'Continue';
  // Task D3: populate body stats slide (slide 2) on first show
  if(i === 2) obPopulateBodyStats();
  // Task D4: populate diet slide (slide 3) on first show
  if(i === 3) obPopulateDiet();
}

function obNext(){
  if(obIndex < 4){ obShow(obIndex + 1); } else { finishOnboarding(); }
}

function renderObGoals(key){
  // Task D3: for new onboarding users, don't show Elena's hardcoded goals—they should be
  // chosen by the user after completing profile setup. Only show goals when replaying
  // onboarding (non-fresh install), where PROF[key] already has saved preferences.
  const g = PROF[key] && PROF[key].goals;
  const hasAnyGoal = g && (g.fatLoss || g.muscle || g.hashimoto || g.skin || g.heart);
  if(!hadStoredStateOnBoot || !hasAnyGoal){
    document.getElementById('obGoalsPreview').innerHTML = '';
    return;
  }
  const goals = key === 'elena'
    ? ['🎯 Gentle fat loss', '🦋 Hashimoto-friendly', '✨ Skin-supporting']
    : ['💪 Muscle & protein', '❤️ Heart-smart'];
  document.getElementById('obGoalsPreview').innerHTML = goals.map(function(g){ return '<span class="pill">'+g+'</span>'; }).join('');
}

// Task B2 (generic identity): obPick(key) picks which slot's goals preview the onboarding
// "name" slide shows and, via finishOnboarding()'s applyProf(obProfile), which profile the
// app lands on. maybeShowOnboarding() always calls obPick('elena') for a first-ever run (the
// person setting up the app takes slot 'elena' — see PHASE3B-generic-spec.md B2); only
// replayOnboarding() (Profile → About → "Replay intro") can pass 'partner', when the second
// household member replays the intro from their own already-active profile. The obElena/
// obAndrea option cards this used to toggle are gone (a brand-new user is no longer asked
// "are you Elena or Andrea" — see index.html's onboarding slide 2), so those two lookups are
// guarded rather than removed outright, in case an older cached index.html is still served.
function obPick(key){
  obProfile = key;
  const obElenaEl = document.getElementById('obElena');
  if(obElenaEl){ obElenaEl.classList.toggle('sel', key === 'elena'); const ck = obElenaEl.querySelector('.ck'); if(ck) ck.textContent = key === 'elena' ? '✓' : ''; }
  const obAndreaEl = document.getElementById('obAndrea');
  if(obAndreaEl){ obAndreaEl.classList.toggle('sel', key === 'partner'); const ck2 = obAndreaEl.querySelector('.ck'); if(ck2) ck2.textContent = key === 'partner' ? '✓' : ''; }
  // Prefill the name field from this slot's current displayName (state.js PERSIST_PROFILE_
  // FIELDS) — 'You' for a genuinely fresh install, or the real saved name when replaying.
  const nameInput = document.getElementById('obNameVal');
  if(nameInput && typeof PROF !== 'undefined' && PROF[key]) nameInput.value = PROF[key].displayName || '';
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

function obPopulateBodyStats(){
  // Task D3: populate year dropdown with sensible range (18-90 years old from today)
  const select = document.getElementById('obDobY');
  if(select){
    const now = new Date().getFullYear();
    for(let y = now - 18; y >= now - 90; y--){
      const opt = document.createElement('option');
      opt.value = y;
      opt.textContent = y;
      select.appendChild(opt);
    }
    if(typeof PROF !== 'undefined' && PROF[obProfile] && PROF[obProfile].dobY){
      select.value = PROF[obProfile].dobY;
    }
  }
  // Populate month dropdown
  const monthSelect = document.getElementById('obDobM');
  if(monthSelect){
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    months.forEach(function(m, i){
      const opt = document.createElement('option');
      opt.value = i + 1;
      opt.textContent = m;
      monthSelect.appendChild(opt);
    });
    if(typeof PROF !== 'undefined' && PROF[obProfile] && PROF[obProfile].dobM){
      monthSelect.value = PROF[obProfile].dobM;
    }
  }
  // Populate activity level dropdown
  const actSelect = document.getElementById('obActivity');
  if(actSelect){
    ACTIVITY_LEVELS.forEach(function(a, i){
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = a.t + ' (' + a.d + ')';
      actSelect.appendChild(opt);
    });
    if(typeof PROF !== 'undefined' && PROF[obProfile] && PROF[obProfile].activity){
      actSelect.value = ACTIVITY_LEVELS.findIndex(function(a){ return a.f === PROF[obProfile].activity; });
    }
  }
  // Populate height and weight fields
  if(typeof PROF !== 'undefined' && PROF[obProfile]){
    const hField = document.getElementById('obHeightVal');
    if(hField && PROF[obProfile].heightCm) hField.value = PROF[obProfile].heightCm;
    const wField = document.getElementById('obWeightVal');
    if(wField && PROF[obProfile].weightKg) wField.value = PROF[obProfile].weightKg;
  }
  // Populate sex radio buttons
  if(typeof PROF !== 'undefined' && PROF[obProfile] && PROF[obProfile].sex){
    const radios = document.getElementsByName('obSex');
    radios.forEach(function(r){ r.checked = r.value === PROF[obProfile].sex; });
  }
}

function obPopulateDiet(){
  // Task D4: populate diet radio buttons
  if(typeof PROF !== 'undefined' && PROF[obProfile] && PROF[obProfile].diet){
    const radios = document.getElementsByName('obDiet');
    radios.forEach(function(r){ r.checked = r.value === PROF[obProfile].diet; });
  } else {
    // Default to 'none' if not set
    const radios = document.getElementsByName('obDiet');
    radios.forEach(function(r){ r.checked = r.value === 'none'; });
  }
}

function obSetSex(sex){
  commitSex(obProfile, sex);
}

function obSetDob(){
  const y = document.getElementById('obDobY');
  const m = document.getElementById('obDobM');
  if(y && y.value && m && m.value){
    const dobY = parseInt(y.value);
    const dobM = parseInt(m.value);
    if(!isNaN(dobY) && !isNaN(dobM)){
      commitDob(obProfile, dobY, dobM);
    }
  }
}

function obSetActivity(){
  const select = document.getElementById('obActivity');
  if(select && select.value !== ''){
    const idx = parseInt(select.value);
    if(!isNaN(idx) && ACTIVITY_LEVELS[idx]){
      commitActivity(obProfile, idx);
    }
  }
}

function obSetDiet(diet){
  commitDiet(obProfile, diet);
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
  const dateISO = (typeof currentLogDateISO === 'function') ? currentLogDateISO() : todayISO();
  SLOT_ORDER.forEach(function(slot){
    const status = slotLogStatus(dateISO, currentProf, slot);
    if(status === 'confirmed'){
      const entry = getDayLog(dateISO)[currentProf].find(function(e){ return e.kind === 'plan' && e.slot === slot; });
      const r = entry && RECIPES_DB[entry.ref];
      const card = document.getElementById('log-' + slot);
      if(card && r){
        const t = card.querySelector('.t'); if(t) t.textContent = r.title;
        const th = card.querySelector('.thumb'); if(th) th.textContent = r.emoji;
      }
      if(r){ TITLES[slot] = r.title; EMOJI[slot] = r.emoji; }
      if(entry) LOGKCAL[slot] = Math.round(logEntryNutrition(entry).kcal);
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
// Boot resilience (bug-hardening pass): bootMesaApp() used to be one long chain sharing a
// single catch — a throw in ANY step (even a cosmetic one like renderTodayHeader) killed
// every step after it, with nothing recorded anywhere a phone owner could see. auth used to
// be the LAST link in that chain, so a boot failure silently took sign-in down with it; auth
// now runs independently via initAuthEarly() (js/auth.js), but the rest of boot was still
// all-or-nothing. bootStage()/bootSkip() below give each step its own blast radius: a throw
// in one is caught, logged (console + authLog, so it lands in "Trouble signing in?"'s
// on-device log — see js/auth.js authLogText()), and every OTHER step still runs.
//
// bootStage(name, fn): runs fn(), returns true on success. On throw: console.error (as
// before) + authLog('boot.fail', '<name>: <message>') and returns false so a caller with a
// genuine dependency on this step's result can skip its own dependent step instead of running
// on broken state (see bootSkip below and the 'recipe' stage's use of profOk).
function bootStage(name, fn){
  try{
    fn();
    return true;
  }catch(err){
    console.error('Mesa boot failed (' + name + ')', err);
    if(typeof authLog === 'function') authLog('boot.fail', name + ': ' + ((err && err.message) || String(err)));
    return false;
  }
}

// Records a step that was deliberately NOT run because a real upstream dependency failed
// (as opposed to a step that ran and threw — that's bootStage above). Kept distinct from
// boot.fail so the diagnostics log reads "X failed, so Y was skipped" rather than two
// unexplained failures.
function bootSkip(name, reason){
  console.warn('Mesa boot: skipped ' + name + ' (' + reason + ')');
  if(typeof authLog === 'function') authLog('boot.skip', name + ': ' + reason);
}

// Must run after data/foods.js, data/recipes.js and engine.js (recipeNutrition) have
// all loaded, and before anything reads RECIPES_DB — see render.js's recipeDisplay*
// helpers for how the recipe screen/Today cards read it directly (no compat view).
// applyProf() -> ensureWeekPlan() (planner.js) either keeps the persisted weekPlan (same
// signature + same week) or regenerates it deterministically, then persists; it also
// runs renderLogPlan(), which replays today's persisted confirms via restoreTodayLog().
function bootMesaApp(){
  try{
    loadState();
  }catch(err){
    // Runs before every other stage, so a throw here escaped bootMesaApp entirely and left
    // no trace at all. Record it, then re-throw: every stage below reads state.js globals
    // (PROF, customRecipes, currentProf, ...), so the app genuinely cannot continue without
    // it — this is the one stage that stays fatal by design (see task brief: "leave as is").
    console.error('Mesa boot failed (state load)', err);
    if(typeof authLog === 'function') authLog('boot.fail', 'state: ' + ((err && err.message) || String(err)));
    throw err;
  }

  // applyCustomFoods() used to share loadState()'s try/catch above — a throw here (e.g. a
  // corrupted customFoods entry) took the WHOLE boot down with it, even though every stage
  // below can still run on the bundled FOODS alone. It's a merge into FOODS before recipes
  // need them (js/library.js), not a hard prerequisite for anything past this point.
  bootStage('foods', applyCustomFoods);

  // Render immediately with bundled recipes so the user never sees the static
  // mockup HTML. The D1 catalog fetch runs in parallel and refreshes afterward.
  bootStage('recipes', applyCustomRecipes);

  bootStage('cleanup', function(){
    if(typeof cleanupDuplicateLibraryEntries === 'function') cleanupDuplicateLibraryEntries();
  });

  bootStage('today-header', renderTodayHeader);

  const profOk = bootStage('prof', function(){ applyProf(currentProf); });
  if(profOk){
    bootStage('recipe', function(){
      renderRecipe('salmon');
      recipeOrigin = 'today';
    });
  } else {
    bootSkip('recipe', 'applyProf failed');
  }

  bootStage('onboarding', maybeShowOnboarding);

  bootStage('sync', function(){ if(typeof initSync === 'function') initSync(); });

  bootStage('auth', function(){ if(typeof initAuth === 'function') initAuth(); });

  // Hide the boot loading overlay now that the real Today content is painted.
  // Runs regardless of whether earlier stages threw (bootStage isolates it),
  // and does not wait on the D1 catalog fetch below, which is network-bound.
  bootStage('boot-loader-hide', function(){
    const bootLoader = document.getElementById('bootLoader');
    if(bootLoader) bootLoader.classList.add('gone');
  });

  if(typeof authLog === 'function') authLog('boot.ok', 'reached end of boot');

  // D1 catalog fetch: replaces bundled built-in recipes with the authoritative
  // server copy, then re-renders so any catalog changes take effect. Runs after
  // the first paint is already on screen — a timeout or offline just keeps the
  // bundled catalog that's already rendering.
  if(typeof fetchBuiltinRecipeCatalogFromD1 === 'function'){
    fetchBuiltinRecipeCatalogFromD1().catch(function(err){
      console.warn('Mesa boot: catalog fetch rejected, keeping bundled fallback', err);
      if(typeof authLog === 'function') authLog('boot.fail', 'catalog: ' + ((err && err.message) || String(err)));
      return false;
    }).then(function(updated){
      if(updated){
        bootStage('recipes-refresh', applyCustomRecipes);
        bootStage('prof-refresh', function(){ applyProf(currentProf); });
      }
    });
  }
}

bootMesaApp();

/* ---------------- service worker registration (task E1) ---------------- */
// Offline shell + installability. Guarded so it's a silent no-op wherever it
// can't work: browsers without SW support, and file:// (not a secure context —
// registration throws there, e.g. opening index.html directly on a phone).
if('serviceWorker' in navigator && location.protocol !== 'file:'){
  window.addEventListener('load', function(){
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', function(){
      if(refreshing) return;
      refreshing = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js', {updateViaCache: 'none'}).then(function(reg){
      // A worker can already be parked in "waiting" from a previous session
      // (installed while the app was closing) — release it immediately.
      if(reg.waiting && navigator.serviceWorker.controller){
        reg.waiting.postMessage({type: 'SKIP_WAITING'});
      }
      reg.addEventListener('updatefound', function(){
        const worker = reg.installing;
        if(!worker) return;
        worker.addEventListener('statechange', function(){
          if(worker.state === 'installed' && navigator.serviceWorker.controller){
            worker.postMessage({type: 'SKIP_WAITING'});
          }
        });
      });
      reg.update();
      // iOS standalone PWAs often resume a suspended WebView without firing
      // 'load' again, so 'next open' isn't 'next update check' — re-check on
      // every re-foreground and hourly while foregrounded.
      document.addEventListener('visibilitychange', function(){
        if(document.visibilityState === 'visible') reg.update();
      });
      setInterval(function(){
        if(document.visibilityState === 'visible') reg.update();
      }, 60 * 60 * 1000);
    }).catch(function(err){
      console.warn('Mesa: service worker registration failed', err);
    });
  });
}
