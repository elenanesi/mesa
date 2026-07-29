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
  // sync tabbar highlight. Screens that aren't themselves a tab map onto the tab that OWNS
  // them, otherwise every tab clears and nothing lights up — the user is somewhere with no
  // "you are here" at all. The four library sub-screens map to the Library tab; #log maps to
  // the centre ＋ (data-tab="add"), which is the only way to reach it (Add sheet -> Log food).
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));
  var tabId = id.indexOf('library') === 0 ? 'library' : (id === 'log' ? 'add' : id);
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
// UX-REVIEW-plan.md item 4: unlike breakfast/lunch/dinner, the snack slot legitimately has
// no recipe some days (planner.js's B2 notes — snack is excluded from main+side composition
// and can come up empty), so this guards on an actual id rather than assuming one the way
// the three above do. renderTodayMeals() (render-today.js) only wires this up as the card's
// onclick when todaySlotView('snack').recipe exists, so in practice the guard here is
// belt-and-suspenders, not the only thing standing between a tap and a crash.
function openSnackRecipe(){
  const id = displayedTodayRecipeId('snack') || (activeMenu.snack && activeMenu.snack.recipeId);
  if(!id) return;
  openRecipe(id, 'today', todayRecipeCtx('snack'));
}

/* ---------------- shared person-switcher click handling ----------------
   ONE delegated listener for every "whose plan" mount (render.js:personSwitcherHtml()/
   renderPersonSwitchers() — Today topbar #profSeg, Profile #profWhoSeg, and the
   Week/Insights/Log per-person screens #weekProfSeg/#insightsProfSeg/#logProfSeg).
   Delegation means a NEW mount needs zero JS wiring — just the markup plus the
   data-person-switcher/data-prof attributes render.js already stamps on it — and it's
   attached once here at parse time rather than needing DOMContentLoaded, since delegated
   listeners don't care whether the matched descendants exist yet.

   Replaces two things that had quietly drifted apart: this file used to wire #profSeg
   alone via a per-button addEventListener loop, while render-profile.js's now-deleted
   setProf() handled #profWhoSeg alone via onclick="setProf(...)" — only THAT path used to
   set profileSwitchedByUser, so switching person from the Today topbar (but not Profile)
   could get silently overridden a moment later by auth.js:applyOwnMemberSlot() opening the
   device back on its own owner's slot. One handler for every mount means every switch
   behaves identically. Routes through applyProf() (render.js) — the single funnel that
   updates currentProf, recomputes, and repaints every screen — and deliberately never
   calls go(): switching person must never navigate away from whatever screen the user is
   currently on (Week/Insights/Log each keep their own view state — This/Next week,
   Today/Yesterday, in-progress search — untouched by applyProf()'s repaint). */
document.addEventListener('click', function(e){
  var btn = e.target.closest('[data-person-switcher] [data-prof]');
  if(!btn) return;
  profileSwitchedByUser = true;
  applyProf(btn.dataset.prof);
});

/* ---------------- onboarding ---------------- */
// obProfile — which PROF slot ('elena' | 'partner') the wizard currently writes to.
// Defaults to 'elena' (the pre-accounts single-device assumption, and what a genuinely
// solo/no-auth install must still onboard into — see obTargetSlot()'s doc below and the
// hard requirement that this keeps working with auth.js entirely absent, e.g.
// tools/check.js's harness).
let obIndex = 0;
let obProfile = 'elena';

// obIsReplay — true only inside a replayOnboarding() run (Profile -> About -> "Replay
// intro"). Disables both obTargetSlot()'s auto-retarget (replay must keep editing whatever
// profile is already on screen, even if that's the OTHER member's, e.g. viewed via the
// segmented control) and obEnsureWritable()'s populated-slot guard (replaying your OWN
// already-answered intro is expected to find real data there — that's the whole point).
let obIsReplay = false;

// obPrePopulatedSlots — per-slot snapshot of "did this slot already hold a real, saved
// profile the FIRST moment onboarding targeted it this run", taken once via
// obSnapshotPrePopulated() and never re-derived afterward (see that function's doc for why
// a live re-check would wrongly trip on this wizard's OWN legitimate writes). Reset every
// time onboarding freshly opens (maybeShowOnboarding/replayOnboarding).
let obPrePopulatedSlots = {};

/* ===================================================================
   Slot-targeting fix (2026-07-28) — see README's task brief for the full diagnosis.

   THE BUG: maybeShowOnboarding() used to hardcode obPick('elena') and run during
   bootMesaApp()'s 'onboarding' stage, which is ALWAYS before auth.js's /auth/me round trip
   can possibly resolve (that fetch is kicked off by initAuthEarly(), which runs at auth.js
   PARSE time — before app.js is even parsed, since script tags execute in source order —
   but its .then() can only land on a later tick). So for an invited SECOND household
   member on a fresh device, the wizard's target slot was a guess that was often wrong, and
   nothing ever corrected it: commitSex/commitDob/commitActivity/commitDiet took obProfile
   as an explicit arg (always 'elena'), while commitDisplayName/commitHeight/commitWeight
   silently used the global currentProf (which DID flip to 'partner' once
   auth.js:applyOwnMemberSlot() ran) — two different targets from two halves of the same
   wizard. Worst case: the household's real, already-synced data for slot 'elena' (pulled
   down by auth.js:maybeAdoptHousehold, which runs as soon as the member slot resolves) was
   still in local memory when the wrong-slot writes landed, silently corrupting the
   OWNER'S real profile and propagating it to their phone via LWW couple-sync.

   THE FIX (chosen over deferring the whole boot stage): every onboarding write resolves its
   target FRESH, at the moment of the write, via obTargetSlot() — never once at wizard-open
   time. This was preferred over blocking bootMesaApp()'s 'onboarding' stage on the /auth/me
   network round trip because (a) this app's whole boot-resilience model (bootStage/bootSkip
   above) is built on never letting one stage's network dependency gate another's paint, and
   the "Agent handoff lessons" section is explicit that boot must never gate sign-in-adjacent
   work on a network call; (b) a fresh-per-write check is strictly stronger than a one-time
   deferred check — it keeps correcting itself for as long as the wizard stays open, even if
   the slot resolves unusually late (slow network) or changes again for some other reason.
   Every commit* wrapper below (obSetSex/obSetDob/obSetActivity/obToggleDiet/obCommitName/
   obCommitHeight/obCommitWeight) calls obTargetSlot() as its first step, and finishOnboarding()
   does the same for the final applyProf(). obEnsureWritable() is the defensive backstop for
   the one gap this can't structurally close (see its own doc). Every commitDisplayName/
   commitHeight/commitWeight call now also passes its slot EXPLICITLY (render-profile.js
   gave them an optional profileKey param defaulting to currentProf for every other,
   unchanged, Profile-screen caller) — closing the second half of the original split-write.
   =================================================================== */

// Resolves which profile slot onboarding should write to RIGHT NOW, self-correcting
// `obProfile` in place if the authoritative signed-in member slot (auth.js:myMemberSlot(),
// read through a typeof guard so this file keeps working with auth.js entirely absent) has
// resolved to something other than the wizard's current guess since it opened or was last
// checked. Called at the top of every onboarding write AND at every obShow() slide
// transition (see below) — correctness never depends on catching one specific moment;
// whichever call happens next re-checks fresh.
//
// Skipped during a replay (obIsReplay) — see that flag's doc above.
function obTargetSlot(){
  if(!obIsReplay && typeof myMemberSlot === 'function'){
    const known = myMemberSlot();
    if((known === 'elena' || known === 'partner') && known !== obProfile){
      const prevSlot = obProfile;
      obProfile = known;
      obSnapshotPrePopulated(obProfile);
      console.warn('Mesa onboarding: retargeted from "' + prevSlot + '" to "' + obProfile + '" (member slot resolved)');
      if(typeof authLog === 'function') authLog('onboarding.retarget', prevSlot + '->' + obProfile);
    }
  }
  return obProfile;
}

// Snapshots whether `slot` already held a real, previously-saved profile (a non-placeholder
// displayName — state.js:isPlaceholderDisplayName/DISPLAY_NAME_DEFAULTS) the FIRST moment
// onboarding ever targeted it this run, and freezes that verdict (Object.prototype
// .hasOwnProperty guard: never overwritten by a later call for the same slot). This must be
// a one-time snapshot, not a live re-check: a fresh onboarding legitimately WRITES a real
// name onto its own slot on slide 1 (see index.html's obNameVal), and a live re-check would
// then see that slot as "already populated" on every subsequent slide (body stats, diet)
// and wrongly block its own wizard's own answers.
function obSnapshotPrePopulated(slot){
  if(Object.prototype.hasOwnProperty.call(obPrePopulatedSlots, slot)) return;
  const p = (typeof PROF !== 'undefined' && PROF) ? PROF[slot] : null;
  obPrePopulatedSlots[slot] = !!(p && typeof isPlaceholderDisplayName === 'function' && !isPlaceholderDisplayName(p.displayName));
}

// Defensive backstop (task brief: "defensive rather than clever") for the one gap
// obTargetSlot()'s fresh-per-write re-check can't structurally close: a write that happens
// BEFORE myMemberSlot() has resolved even once (e.g. the name field on slide 1, answered
// unusually fast on a slow network) still goes to the wizard's current best guess. If that
// guess's slot already held a real saved profile before this run touched it
// (obPrePopulatedSlots, snapshotted above) and this isn't a replay of the user's own already-
// answered intro, refuse the write and log it rather than ever overwriting someone else's
// real data — the household owner's profile corrupting itself and propagating to their
// phone via LWW couple-sync is exactly the bug this batch fixes. Every onboarding commit
// wrapper below checks this immediately after resolving its slot.
function obEnsureWritable(slot){
  if(obIsReplay) return true;
  // OWNERSHIP first, emptiness only as a fallback. What makes a write safe is that the slot
  // belongs to the signed-in member — NOT that it happens to be empty. An invited partner
  // whose name the household owner already filled in before sending the invite owns a
  // POPULATED slot, and an emptiness-only guard would silently refuse every answer they
  // typed. Once myMemberSlot() has resolved, it is the authority: write to your own slot,
  // never to the other one (a mismatch here means obTargetSlot() failed to retarget, which
  // is the bug state this guard exists to catch).
  if(typeof myMemberSlot === 'function'){
    const known = myMemberSlot();
    if(known === 'elena' || known === 'partner'){
      if(known === slot) return true;
      console.warn('Mesa onboarding: refusing to write into "' + slot + '" — this device is member slot "' + known + '" (bug guard, see obEnsureWritable).');
      if(typeof authLog === 'function') authLog('onboarding.blocked', 'target=' + slot + ' own=' + known);
      return false;
    }
  }
  // Slot ownership not verifiable yet (auth.js absent, or /auth/me still in flight): fall
  // back to the emptiness snapshot, so a write that beats the member-slot resolution can
  // still never land on top of someone's real saved profile.
  if(obPrePopulatedSlots[slot]){
    console.warn('Mesa onboarding: refusing to write into "' + slot + '" — it already held a real saved profile when onboarding started targeting it, and this device does not yet know its own member slot (bug guard, see obEnsureWritable).');
    if(typeof authLog === 'function') authLog('onboarding.blocked', 'target=' + slot);
    return false;
  }
  return true;
}

function obShow(i){
  // Defense in depth (see obTargetSlot's doc): re-resolve on every slide transition too, not
  // only at commit time, so obPopulateBodyStats()/obPopulateDiet() below (which read
  // PROF[obProfile]) already see the correct slot the moment a late-resolving member slot
  // arrives, even before the user touches a field on that slide.
  obTargetSlot();
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
  // Goal-audit fix: was g.hashimoto, a key that never existed on PROF[key].goals (the
  // real key is `hashi` — see GOAL_DEFS_UNION, state.js) — a dead condition that could
  // never be true. Also restored the missing `muscleGain` check (both calorie goals are
  // now available on every profile, not just fatLoss — see engine.js:deriveGoalAdj) so
  // this checks every real key in GOAL_DEFS_UNION, not an ad-hoc subset.
  const hasAnyGoal = g && (g.fatLoss || g.muscleGain || g.muscle || g.hashi || g.skin || g.heart);
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
// "name" slide shows, and (via obSnapshotPrePopulated) freezes this run's populated-slot
// guard for that slot. maybeShowOnboarding() calls obPick(obTargetSlot()) for a first-ever
// run — 'elena' unless this device already knows its own member slot the moment onboarding
// opens (see obTargetSlot's doc; a first-ever run on a genuinely fresh device is always
// 'elena' at this point, matching PHASE3B-generic-spec.md B2's "the person setting up the
// app takes slot 'elena'"). replayOnboarding() (Profile → About → "Replay intro") passes
// `currentProf`, whichever slot that is. The obElena/obAndrea option cards this used to
// toggle are gone (a brand-new user is no longer asked "are you Elena or Andrea" — see
// index.html's onboarding slide 2), so those two lookups are guarded rather than removed
// outright, in case an older cached index.html is still served.
function obPick(key){
  obProfile = key;
  obSnapshotPrePopulated(key); // freeze "was this slot already real before THIS run touched it" — see that function's doc
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
  // Final fresh resolution (see obTargetSlot's doc) — lands the user on THEIR OWN profile
  // rather than whatever obProfile's stale initial guess was, even if the member slot only
  // resolved during the last slide or two.
  const slot = obTargetSlot();
  // A device whose own resolved identity is 'partner' is definitionally not a one-person
  // household (state.js:isSoloHousehold/householdSize) — bump it defensively so the
  // applyProf() call below doesn't get silently forced back to 'elena' by render.js's
  // applyProf() solo guard. auth.js:maybeSetHouseholdSizeFromServer() normally already does this well
  // before onboarding finishes (it runs in the same /auth/me response that resolves the
  // member slot in the first place), but landing on your own profile shouldn't depend on
  // that timing. Never sets householdSizeManual — a real user choice (Profile -> Basics) or
  // a later authoritative server count still fully governs this going forward; this only
  // ever raises 1 -> 2, never the reverse.
  if(slot === 'partner' && typeof householdSize !== 'undefined' && householdSize !== 2){
    householdSize = 2;
  }
  document.getElementById('onboard').classList.add('hidden');
  onboarded = true;               // persisted by applyProf()'s persist() call below
  applyProf(slot); // -> syncPersonLabels() -> renderPersonSwitchers(): every switcher mount (including #profSeg) already repaints its active state from currentProf, no separate sync needed here
  go('today');
}

function replayOnboarding(){
  obIsReplay = true;
  obPrePopulatedSlots = {}; // fresh run — irrelevant while obIsReplay is true, but keeps state tidy for the next maybeShowOnboarding()
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

// Multi-select diet slide: obDiet is now a group of CHECKBOXES (index.html), one per
// DIET_KEYS entry (state.js) plus the NONE_DIET_KEY pseudo-choice, grouped into the two
// <div class="field"> blocks DIET_EDITOR_GROUPS also drives on the Profile screen (see
// that constant's doc in state.js) — 'No restriction' checked means diets is empty,
// every other box checked means that key is in PROF[obProfile].diets. Called on slide
// entry (below) AND after every obToggleDiet() write, so a collapse inside
// normalizeDietsArray (e.g. picking "Vegan" while "Vegetarian" was already checked) is
// always reflected back into the checkboxes, not just the underlying array.
function obPopulateDiet(){
  const diets = (typeof PROF !== 'undefined' && PROF[obProfile] && PROF[obProfile].diets) || [];
  const boxes = document.getElementsByName('obDiet');
  boxes.forEach(function(b){
    b.checked = (b.value === NONE_DIET_KEY) ? diets.length === 0 : diets.indexOf(b.value) !== -1;
  });
}

// Every obSet*/obCommit* wrapper below follows the same shape: resolve the slot FRESH
// (obTargetSlot), refuse if it's a bug state (obEnsureWritable), only then commit. See the
// slot-targeting fix doc above obTargetSlot() for why every write re-resolves independently
// rather than trusting obProfile as set at wizard-open time.
function obSetSex(sex){
  const slot = obTargetSlot();
  if(!obEnsureWritable(slot)) return;
  commitSex(slot, sex);
}

function obSetDob(){
  const y = document.getElementById('obDobY');
  const m = document.getElementById('obDobM');
  if(y && y.value && m && m.value){
    const dobY = parseInt(y.value);
    const dobM = parseInt(m.value);
    if(!isNaN(dobY) && !isNaN(dobM)){
      const slot = obTargetSlot();
      if(!obEnsureWritable(slot)) return;
      commitDob(slot, dobY, dobM);
    }
  }
}

function obSetActivity(){
  const select = document.getElementById('obActivity');
  if(select && select.value !== ''){
    const idx = parseInt(select.value);
    if(!isNaN(idx) && ACTIVITY_LEVELS[idx]){
      const slot = obTargetSlot();
      if(!obEnsureWritable(slot)) return;
      commitActivity(slot, idx);
    }
  }
}

// Checkbox onchange calls this per tap — toggleDiet() (render-profile.js) is the shared
// funnel every diets-array write goes through (Profile screen editor included), so
// onboarding and Profile can never disagree about how a diet combination normalizes.
function obToggleDiet(key){
  const slot = obTargetSlot();
  if(!obEnsureWritable(slot)) return;
  toggleDiet(slot, key);
  obPopulateDiet(); // reflect any DIET_EXCLUSIVE_GROUP collapse back into the checkboxes
}

// Onboarding-only wrappers around render-profile.js's commitDisplayName/commitHeight/
// commitWeight (index.html's obNameVal/obHeightVal/obWeightVal call these instead of the
// bare commit* functions the Profile screen's own inputs still use) — this is the other
// half of the original split-write bug: these three used to take no profile argument at
// all and silently wrote through the global currentProf instead of obProfile. Passing the
// freshly-resolved slot explicitly closes that gap the same way obSetSex/obSetDob/
// obSetActivity/obToggleDiet already do above.
function obCommitName(raw){
  const slot = obTargetSlot();
  if(!obEnsureWritable(slot)) return;
  commitDisplayName(raw, slot);
}
function obCommitHeight(raw){
  const slot = obTargetSlot();
  if(!obEnsureWritable(slot)) return;
  commitHeight(raw, slot);
}
function obCommitWeight(raw){
  const slot = obTargetSlot();
  if(!obEnsureWritable(slot)) return;
  commitWeight(raw, slot);
}

function maybeShowOnboarding(){
  if(!onboarded){
    obIsReplay = false;
    obPrePopulatedSlots = {}; // fresh run
    obProfile = 'elena';
    // obTargetSlot() covers the case where this device's member slot is ALREADY known
    // synchronously here (e.g. cached from an earlier session on this exact device before a
    // state reset) — see its doc above. On a genuinely fresh device/first-ever load this is
    // a no-op: myMemberSlot() returns null until /auth/me resolves, well after this line
    // runs, which is exactly why every write below re-resolves independently instead of
    // trusting this one snapshot.
    obPick(obTargetSlot());
    obShow(0);
    document.getElementById('onboard').classList.remove('hidden');
  }
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
// signature + same week) or regenerates it deterministically, then persists; it also runs
// renderTodayCardActions() (via renderTodayMeals()), which re-derives Today's confirm/skip
// state fresh from logHistory/slotLogStatus every call — no boot-time "replay" step needed.
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
