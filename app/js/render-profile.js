/* render-profile.js — basics, split editor, goals, avoid, household size, insights, tuning */
function renderBasics(){
  const p = PROF[currentProf];
  const nameEl = document.getElementById('displayNameVal');
  // Placeholders ('You'/'Partner'/unset) show as an EMPTY field: they aren't the user's
  // name, and pre-filling them invites someone to "keep" a label that only makes sense
  // relative to whoever is looking (see state.js:resolveDisplayName).
  if(nameEl) nameEl.value = isPlaceholderDisplayName(p.displayName) ? '' : p.displayName;
  document.getElementById('sexBtnF').classList.toggle('on', p.sex === 'female');
  document.getElementById('sexBtnM').classList.toggle('on', p.sex === 'male');
  document.getElementById('pfDob').textContent = 'Born ' + MONTHS[p.dobM-1] + ' ' + p.dobY + ' · ' + ageOf(p);
  document.getElementById('dobMVal').textContent = MONTHS[p.dobM-1];
  document.getElementById('dobYVal').textContent = p.dobY;
  document.getElementById('hVal').value = p.heightCm;
  document.getElementById('wVal').value = p.weightKg;
  document.getElementById('actOpts').innerHTML = ACTIVITY_LEVELS.map(function(a, i){
    const sel = p.activity === a.f;
    return '<div class="opt'+(sel ? ' sel' : '')+'" style="margin-top:'+(i===0?'6':'9')+'px" onclick="setActivity('+i+')">'
      + '<div class="ck">'+(sel ? '✓' : '')+'</div>'
      + '<div><div class="ot">'+a.t+'</div><div class="od">'+a.d+'</div></div></div>';
  }).join('');
  // daily target row
  document.getElementById('pfCals').value = p.calGoalNum;
  const isCustom = p.calCustom !== null;
  const chip = document.getElementById('calChip');
  chip.textContent = isCustom ? 'custom' : '✓ computed';
  chip.className = isCustom ? 'pill gold' : 'chip-computed';
  const btn = document.getElementById('calRestoreBtn');
  btn.style.display = isCustom ? 'inline-flex' : 'none';
  btn.textContent = '↺ Restore recommended (' + fmtKcal(p.recCal) + ')';
  // task B1: p.goalAdj is 0 when the person's calorie-affecting goal (fatLoss/
  // muscleGain) is off — drop the "+/- N <goalName>" clause entirely rather than
  // print "+ 0 maintenance", so the line reads as plain maintenance-based copy.
  document.getElementById('calFormula').textContent =
    'BMR ' + fmtKcal(Math.round(bmrOf(p))) + ' × ' + p.activity + ' activity'
    + (p.goalAdj !== 0 ? ' ' + (p.goalAdj >= 0 ? '+ ' : '− ') + Math.abs(p.goalAdj) + ' ' + p.goalName : ' (at maintenance)')
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

// Bounds widened to match the typed-input clamp (FIX 2 brief: height 120–230, weight
// 30–250) so stepping and typing can never land in a state the other path disagrees with.
function stepBody(field, delta){
  const p = PROF[currentProf];
  if(field === 'height'){
    p.heightCm = Math.min(230, Math.max(120, p.heightCm + delta));
    afterBasicsChange('Height ' + p.heightCm + ' cm');
  } else {
    p.weightKg = Math.min(250, Math.max(30, +(p.weightKg + delta).toFixed(1)));
    afterBasicsChange('Weight ' + p.weightKg + ' kg');
  }
}

// FIX 2 (feedback): height/weight typeable directly. Invalid text (empty, "abc") or a
// negative number reverts to the previous value with a toast; a parseable value clamps to
// the same band stepBody() uses (height integer 120–230cm, weight 1-decimal 30–250kg) —
// so "type 64,5" lands on exactly the same weightKg a stepper run would, and every
// downstream recompute (BMR, target calories, macro grams) fires the same way either way.
// Task B2 (generic identity): commits the Profile → Basics "Name" field the same way
// commitHeight/commitWeight (right below) commit theirs — parse/clamp on blur or Enter,
// then run the SAME afterBasicsChange-less applyProf() cascade every other Basics edit
// uses (recompute -> repaint -> persist). Unlike height/weight there's no numeric parse:
// trim, cap to DISPLAY_NAME_MAX_LEN (state.js), and an empty/whitespace-only input falls
// back to this slot's neutral default (DISPLAY_NAME_DEFAULTS) rather than ever storing a
// blank name. `displayName` already round-trips through localStorage AND the couple-sync
// profile:<slot> section for free (state.js:PERSIST_PROFILE_FIELDS — the same list
// weightKg/calNote use), so there is no separate persist/sync call here: applyProf() ->
// persist() -> sync.js's onMesaBeforePersist hook detects the section changed and bumps
// its rev/timestamp exactly like any other Basics edit does.
function commitDisplayName(raw){
  const p = PROF[currentProf];
  const trimmed = (typeof raw === 'string' ? raw : '').trim().slice(0, DISPLAY_NAME_MAX_LEN);
  // Clearing the field stores '' (a placeholder), NOT a 'You'/'Partner' literal — storing
  // one would sync a viewer-relative word to the other person's phone.
  p.displayName = trimmed;
  applyProf(currentProf); // recomputeProf() re-derives seg/av from the new displayName; applyProf() -> syncPersonLabels() repaints every "shows both names" spot
  toast('✓ Name updated');
}

function commitHeight(raw){
  const p = PROF[currentProf];
  const n = parseDecimalInput(raw);
  if(n === null || n < 0){ toast('Enter a height in cm, e.g. 168'); renderBasics(); return; }
  p.heightCm = Math.round(Math.min(230, Math.max(120, n)));
  afterBasicsChange('Height ' + p.heightCm + ' cm');
}
function commitWeight(raw){
  const p = PROF[currentProf];
  const n = parseDecimalInput(raw);
  if(n === null || n < 0){ toast('Enter a weight in kg, e.g. 64.5'); renderBasics(); return; }
  p.weightKg = +(Math.min(250, Math.max(30, n))).toFixed(1);
  afterBasicsChange('Weight ' + p.weightKg + ' kg');
}

function setActivity(i){
  const p = PROF[currentProf];
  const a = ACTIVITY_LEVELS[i];
  if(p.activity === a.f) return;
  p.activity = a.f;
  afterBasicsChange(a.t + ' (×' + a.f + ')');
}

// Task D3: onboarding commit functions (body metrics & diet)
function commitSex(prof, sex){
  if(!PROF[prof]) return;
  PROF[prof].sex = sex;
  persist();
}

function commitDob(prof, dobY, dobM){
  if(!PROF[prof]) return;
  PROF[prof].dobY = dobY;
  PROF[prof].dobM = dobM;
  applyProf(prof);
}

function commitActivity(prof, i){
  const a = ACTIVITY_LEVELS[i];
  if(!PROF[prof] || !a) return;
  PROF[prof].activity = a.f;
  applyProf(prof);
}

function commitDiet(prof, diet){
  if(!PROF[prof]) return;
  if(DIET_KEYS.indexOf(diet) === -1) return;
  PROF[prof].diet = diet;
  // Lactose-intolerant: add lactose to avoid list if not already there
  if(diet === 'lactose-intolerant'){
    const avoid = PROF[prof].avoid || [];
    if(avoid.indexOf('lactose') === -1){
      avoid.push('lactose');
      PROF[prof].avoid = avoid;
    }
  } else if(diet === 'vegan'){
    // Vegan: no special avoid setup (filter happens in planner.js)
  }
  persist();
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

// FIX 2 (feedback): daily calorie target typeable directly, reusing stepCal's exact
// calBand clamp + cap-note copy (owner brief: "calories keep the calBand clamp + existing
// cap-note") so typing "2000" and stepping to 2000 in ±50 taps land on the identical
// p.calCustom / p.calNote state and produce the identical toast.
function commitCalories(raw){
  const p = PROF[currentProf];
  const n = parseDecimalInput(raw);
  if(n === null || n < 0){ toast('Enter a calorie target, e.g. 2000'); renderBasics(); return; }
  const band = calBand(p);
  let next = Math.round(n);
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

/* ---------------- "Health goals" editor (task B1) ----------------
   Real per-profile checklist, replacing the 5 static checkboxes index.html used to show
   IDENTICALLY for both people (the bug: unchecking "Gentle fat loss" did nothing, and
   Andrea saw a fat-loss goal he doesn't have). Renders GOAL_DEFS[currentProf] (state.js
   — single copy source) against PROF[currentProf].goals; titles/descriptions are fixed
   developer copy (not user input), same trust level as ACTIVITY_LEVELS/renderBasics
   above, so no escapeHtml needed. Mirrors renderAvoidEditor()'s structure: one function,
   called from applyProf(), full re-render on every toggle (cheap — five rows). */
function renderGoalsEditor(){
  const key = currentProf;
  const p = PROF[key];
  const el = document.getElementById('goalsList');
  if(!el) return; // Profile screen markup not present (shouldn't happen, but don't crash)
  const defs = GOAL_DEFS[key] || [];
  el.innerHTML = defs.map(function(g){
    const on = !!p.goals[g.key];
    return '<div class="opt' + (on ? ' sel' : '') + '" onclick="toggleGoal(\'' + key + '\',\'' + g.key + '\',this)">'
      + '<div class="ck">' + (on ? '✓' : '') + '</div>'
      + '<div><div class="ot">' + g.title + '</div><div class="od">' + g.desc + '</div></div></div>';
  }).join('');
}

// Toggles one goal on the given profile (task B1 fix: was cosmetic tog(this), no state,
// no recompute, no persistence). Follows the same funnel as addAvoid/removeAvoid below
// and afterBasicsChange() above: mutate -> recomputeProf -> applyProf (re-derives every
// display number, including recCal/calGoalNum, AND re-persists AND re-runs
// ensureWeekPlan() — future plan days re-target off the new calorie goal exactly like a
// weight edit does, since calGoalNum is part of computePlanSignature(); logged/past
// slots stay protected by planner.js's existing preserveLoggedSlots() guard regardless).
// Deliberately does NOT call scheduleMenuRebuild(): that funnel is specific to macro-
// split changes (it re-derives householdStyle from kP/kC/kF and shows a "menu rebuilt
// for x/y/z%" toast), neither of which applies here — a goal toggle never touches the
// split, and applyProf()'s own ensureWeekPlan() call already re-targets the plan.
function toggleGoal(profKey, goalKey, el){
  const p = PROF[profKey];
  if(!p || !p.goals || !(goalKey in p.goals)) return;
  const before = p.calGoalNum;
  p.goals[goalKey] = !p.goals[goalKey];
  recomputeProf(profKey);
  applyProf(profKey);
  const def = (GOAL_DEFS[profKey] || []).find(function(g){ return g.key === goalKey; });
  const label = def ? def.title : goalKey;
  const on = p.goals[goalKey];
  const calChanged = p.calGoalNum !== before;
  toast(label + (on ? ' is back on' : ' turned off') + (calChanged ? ' — target now ' + p.calGoal + ' kcal' : ''));
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

/* ===================================================================
   Task B3 (solo households) — hide every partner-facing surface

   Called from applyProf() (every profile switch, boot, and Basics edit) and from
   setHouseholdSize() right after a manual toggle, so it's always in sync with the live
   householdSize. Toggles VISIBILITY only — the underlying data-level guarantee ("partner
   is never ghost-planned/double-counted") lives in planner.js (generateWeek/
   enumerateSwapUnits/applyMealRulesToPlan/planReferencesMissingRecipe/coverageGaps, all
   gated on isSoloHousehold()), not here. Two-person households: every branch below is a
   no-op restore to the normal 'flex'/'' display, so nothing changes for them.
   =================================================================== */
function applyHouseholdSizeVisibility(){
  const solo = typeof isSoloHousehold === 'function' && isSoloHousehold();

  // Top tabbar + Profile screen "whose plan" segmented toggles: hide the partner button
  // entirely rather than disable it — there's nothing to switch to.
  document.querySelectorAll('#profSeg button[data-prof="partner"]').forEach(function(b){ b.style.display = solo ? 'none' : ''; });
  const whoSeg = document.getElementById('profWhoSeg');
  if(whoSeg){
    const btns = whoSeg.querySelectorAll('button');
    if(btns[1]) btns[1].style.display = solo ? 'none' : '';
  }

  // Recipe-screen second serve card: driven per-recipe by updateServings() (which itself
  // forces `shared=false` whenever solo — see that function) every time the recipe screen
  // repaints, so nothing to force here.
  if(solo && typeof currentRecipeKey !== 'undefined' && document.getElementById('recipe') && document.getElementById('recipe').classList.contains('active')){
    updateServings();
  }

  // "Meals we share" (Profile section) — a household default for splitting/merging a dish
  // between two people has no meaning for one. Hides the section AND its jump-nav chip.
  const mealsSection = document.getElementById('mealsShareSection');
  if(mealsSection) mealsSection.style.display = solo ? 'none' : '';
  const mealsNavChip = document.getElementById('navChipMeals');
  if(mealsNavChip) mealsNavChip.style.display = solo ? 'none' : '';

  // "I cook for" control itself (Basics) — keep the ON state in sync even though it's
  // always visible (this is the control that SETS householdSize, so it can't hide itself).
  const btnJustMe = document.getElementById('householdSizeBtn1');
  const btnMePlus = document.getElementById('householdSizeBtn2');
  if(btnJustMe) btnJustMe.classList.toggle('on', solo);
  if(btnMePlus) btnMePlus.classList.toggle('on', !solo);
}

// Profile → Basics "I cook for: Just me / Me + partner" — the manual override control (B3
// spec: "a manual override control ... for safety, synced"). Setting it stamps
// householdSizeManual so a later /auth/me poll (auth.js:maybeSetHouseholdSizeFromServer)
// never silently reverts a deliberate "Just me" choice back to 2 just because the server
// still only counts one signed-in account — see that function's doc for the exact rule.
function setHouseholdSize(size){
  size = (size === 1) ? 1 : 2;
  if(householdSize === size && householdSizeManual) return;
  householdSize = size;
  householdSizeManual = true;
  applyProf(currentProf); // recompute plan/UI for the new size (forces currentProf back to 'elena' when solo) + persist()
  toast(size === 1 ? '✓ Planning for one' : '✓ Planning for two');
}

// profile screen switch
function setProf(key, el){
  // Records that the person deliberately chose a profile this session, so auth.js's
  // applyOwnMemberSlot() (which opens the device on its own owner's profile once
  // /auth/me resolves) won't yank them back out of a switch they just made.
  profileSwitchedByUser = true;
  el.parentNode.querySelectorAll('button').forEach(x=>x.classList.remove('on'));
  el.classList.add('on'); applyProf(key);
  // sync top control
  document.querySelectorAll('#profSeg button').forEach(x=>x.classList.toggle('on', x.dataset.prof===key));
}

// T1: Profile jump-to-section chip bar (index.html #profileNav) — scrolls the target
// section's <h2> (class="jump-target", scroll-margin-top in mesa.css) to the top edge of
// the #profile scroll container, clear of the sticky bar. The bar itself is static markup
// (not re-painted per profile switch/render), so this only needs to track which chip is
// visually "on".
function jumpToProfileSection(id, el){
  const target = document.getElementById(id);
  const screen = document.getElementById('profile');
  const bar = document.getElementById('profileNav');
  // scrollIntoView() and scrollTo({behavior:'smooth'}) both no-op inside the absolutely-
  // positioned .screen scroller in iOS WebKit; only a direct scrollTop assignment moves it
  // reliably. target.offsetParent is #profile itself, so offsetTop already IS the scroll
  // offset — subtract the sticky bar height + a small gap so the section lands just under
  // the nav rather than hidden behind it. Instant (not animated): rAF-based tweening is
  // paused whenever the page is backgrounded, so a direct set is the dependable choice.
  if(target && screen){
    const offset = (bar ? bar.offsetHeight : 0) + 12;
    screen.scrollTop = Math.max(0, target.offsetTop - offset);
  }
  if(el && bar){
    bar.querySelectorAll('button').forEach(function(b){ b.classList.remove('on'); });
    el.classList.add('on');
  }
}

/* ===================================================================
   Insights screen (task D1 item 4) — paints planner.js:computeInsights()
   into the 4 sections: stat tiles, weekly band, 7-day bars, and the
   2 deterministic "what's working" call-outs. Below 2 total logged days
   every section instead shows the same friendly empty-state copy,
   styled with the app's existing card/tile classes (no new components).
   =================================================================== */
const INSIGHTS_EMPTY_NOTE = 'Log a few days to unlock this — Mesa needs at least 2 logged days to show real trends here.';

// task C1: the 5 nutrient-band rows, in fixed display order — each reuses the exact
// #insightsBarsCard 7-day .spark/.col bar pattern (empty state included), just at a
// shorter height (.spark.compact, css/mesa.css) so 5 rows fit in one card. Colors reuse
// the existing sage ('hi', in-band)/terra ('over')/terra-tint ('under') palette — no new
// design language, just two new modifier classes on the same .col element.
const NUTRIENT_BAND_ROWS = [
  {key: 'protein', label: 'Protein'},
  {key: 'carbs', label: 'Carbs'},
  {key: 'fat', label: 'Fat'},
  {key: 'fiber', label: 'Fiber'},
  {key: 'freeSugars', label: 'Free sugars'}
];

// Fiber/free-sugars are single-direction targets (floor / ceiling); protein/carbs/fat are
// a symmetric ±10% window — the label prefix communicates which, using the SAME target
// number computeInsights already derived (never re-typed here).
function nutrientBandTargetLabel(key, target){
  const g = Math.round(target);
  if(key === 'fiber') return '≥' + g + 'g/day';
  if(key === 'freeSugars') return '≤' + g + 'g/day';
  return '~' + g + 'g/day';
}

function nutrientBandRowHtml(row, days, target){
  const cols = days.map(function(d){
    if(!d.logged) return '<div class="col empty" style="height:14%" title="Not logged"><b>'+d.letter+'</b></div>';
    const value = d[row.key];
    const pct = target > 0 ? Math.max(6, Math.min(100, Math.round(value / target * 100))) : 100;
    const status = d.bands && d.bands[row.key];
    const cls = status === 'over' ? 'over' : (status === 'under' ? 'under' : 'hi');
    return '<div class="col '+cls+'" style="height:'+pct+'%" title="'+Math.round(value)+'g vs '+nutrientBandTargetLabel(row.key, target)+'"><b>'+d.letter+'</b></div>';
  }).join('');
  return '<div class="row between" style="margin-bottom:4px"><b style="font-size:13px">'+row.label+'</b><span class="pill ghost" style="font-size:10px">'+nutrientBandTargetLabel(row.key, target)+'</span></div>'
    + '<div class="spark compact">' + cols + '</div>';
}

function renderInsights(){
  const statWrap = document.getElementById('insightsStats');
  const bandsWrap = document.getElementById('insightsNutrientBands');
  const bandWrap = document.getElementById('insightsBandCard');
  const barsWrap = document.getElementById('insightsBarsCard');
  const workingWrap = document.getElementById('insightsWorking');
  if(!statWrap || !bandsWrap || !bandWrap || !barsWrap || !workingWrap) return; // Insights markup not present

  // FIX 3 (feedback): the coverage card lives at the top of Insights now — refresh its
  // chips/pill/note on every visit (plan-derived, so not gated on logged-day count).
  renderNutrientChips();
  // task C2 (2026-07-18): the "Tune next week" chip card is likewise plan-derived, not
  // log-derived — paint it unconditionally too, same reasoning as renderNutrientChips().
  renderTuningCard();

  const data = computeInsights(currentProf);

  if(!data.hasEnoughData){
    statWrap.innerHTML = '<div class="s" style="grid-column:1/-1"><div class="sl" style="font-size:13px;font-weight:700;color:var(--ink)">Stats</div><p class="sub" style="margin-top:6px">'+INSIGHTS_EMPTY_NOTE+'</p></div>';
    bandsWrap.innerHTML = '<div class="row between"><b style="font-size:14px">Nutrient bands</b></div><p class="sub" style="margin-top:6px">'+INSIGHTS_EMPTY_NOTE+'</p>';
    bandWrap.innerHTML = '<div class="row between"><b style="font-size:14px">Your weekly band</b></div><p class="sub" style="margin-top:6px">'+INSIGHTS_EMPTY_NOTE+'</p>';
    barsWrap.innerHTML = '<div class="row between" style="margin-bottom:6px"><b style="font-size:14px">Calories vs target</b></div><p class="sub">'+INSIGHTS_EMPTY_NOTE+'</p>';
    workingWrap.innerHTML = '<p class="sub" style="margin:0">'+INSIGHTS_EMPTY_NOTE+'</p>';
    return;
  }

  // task C1: 5-row nutrient bands (protein/carbs/fat/fiber/free sugars vs each metric's
  // own band) — data.bandTargets/data.days[i].bands come straight from computeInsights, so
  // this is pure paint, no re-derivation of any threshold.
  bandsWrap.innerHTML = '<div class="row between" style="margin-bottom:10px"><b style="font-size:14px">Nutrient bands <span class="chip-computed">✓ computed</span></b><span class="pill">last 7 days</span></div>'
    + NUTRIENT_BAND_ROWS.map(function(row){ return nutrientBandRowHtml(row, data.days, data.bandTargets[row.key]); }).join('');

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
   "Tune next week" chip card (task C2, 2026-07-18) — replaces the fake Mesa-coach
   banner + toast-only button. Fixed vocabulary (NEXT_WEEK_TUNING_DEFS, state.js), so the
   chips are built here but every onclick argument is a hardcoded constant — no user
   string ever reaches this markup. Same .pill.chip-preset/.chipsel look #macroPresets
   (index.html) already uses for a single-select chip row.
   =================================================================== */
function renderTuningCard(){
  const chipsEl = document.getElementById('tuningChips');
  const noteEl = document.getElementById('tuningNote');
  if(!chipsEl || !noteEl) return; // Insights markup not present
  chipsEl.innerHTML = NEXT_WEEK_TUNING_DEFS.map(function(d){
    const on = d.key === nextWeekTuning;
    return '<button class="pill ghost chip-preset' + (on ? ' chipsel' : '') + '" onclick="setNextWeekTuning(\'' + d.key + '\')">' + d.title + '</button>';
  }).join('');
  noteEl.textContent = nextWeekTuningDef(nextWeekTuning).note;
}

// Persists the household's tuning goal, regenerates next week (and current week's still-
// unlogged/unpinned future slots — same signature-driven regen every other
// computePlanSignature input already causes), and repaints every plan-derived screen —
// mirrors the refresh scope applyProf() runs after a householdStyle-affecting change,
// minus the profile-specific fields (goal tag, macro editor, avoid pills…) that tuning
// never touches.
function setNextWeekTuning(key){
  if(NEXT_WEEK_TUNING_KEYS.indexOf(key) === -1) return;
  nextWeekTuning = key;
  persist();
  toast('✓ ' + nextWeekTuningDef(key).title + ' — next week regenerating…');
  ensureWeekPlan(nextMondayISO());
  renderInsights();
  renderWeek();
  renderTodayMeals();
  renderLogPlan();
}

