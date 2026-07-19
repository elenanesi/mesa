/* ===================================================================
   sync.js — couple sync client (Phase 2, task S1)

   Talks to worker/sync.js (a dumb per-section higher-rev-wins store) and
   does all the real merging client-side, per PHASE2-plan.md's "Section
   model & merge rules":
     - library            : mergeLibrarySection() below — per-id newer-wins merge using
                             each entry's `u` stamp (js/library.js: saveNewFood/
                             saveRecipeBuilder), with tombstones (deletedRecipes/
                             deletedFoods) so a delete on one phone can't be resurrected
                             by a union-by-id merge. NOT js/library.js's
                             mergeImportedLibrary — that function's clone-on-conflict +
                             " (imported)" rename is right for a one-time manual file
                             import, but reusing it for every sync round created a
                             duplication ratchet (same conflict re-cloned bigger each
                             round) — see mergeLibrarySection's doc block below for the
                             full incident writeup. mergeImportedLibrary stays, unchanged,
                             for the manual-import flow only (render.js's confirmMergeImport).
     - plans               : per-meal-cell merge of weekPlans (each mutated
                             cell carries a `t` stamp; newer cell wins), so
                             two phones swapping DIFFERENT meals both keep
                             their swap. SHARED + householdStyle + servings +
                             nextWeekTuning (task C2, 2026-07-18) stay LWW
                             (remote wins), as do weeks whose signatures
                             differ (a regenerated week replaces wholesale —
                             cell stamps aren't comparable across
                             generations).
     - shopping            : union-merge of checked item names, per week.
     - profile:elena/partner: LWW each, one section per person so an
                             edit to Elena's profile can never clobber a
                             concurrent edit to Andrea's (they're
                             different KV entries).
     - log:elena/partner    : append-merge by entry identity (state.js:
                             entryIdentity()), with per-day tombstones
                             so a delete/undo on one phone propagates as
                             a delete on the other.

   No accounts: a household is just a random secret code (generateHouseholdCode
   below) shared once, out of band (AirDrop/text/say it out loud). Nothing
   here ever runs unless syncState.code (state.js) is set — a fresh
   install, or sync left never-configured, makes ZERO network calls
   (ground rule: "the app must remain fully functional offline and with
   sync disabled").

   Wiring into the rest of the app is two small hooks state.js's
   persist() calls if they exist (see persist()'s doc there):
     onMesaBeforePersist() — detects which sections' live content
       changed since the last persist() and bumps their local rev, so
       the bump is captured in the SAME write that's about to happen.
     onMesaAfterPersist() — schedules a debounced (~2s) sync push, once
       state is safely on disk.
   Both are plain global functions (no event bus / pub-sub — this
   codebase doesn't have one, see render.js/planner.js's direct global-
   function-call style) so state.js needs zero import of this file and
   keeps working standalone if sync.js is ever removed.
   =================================================================== */

/* ---------------- config ---------------- */
const SYNC_URL = 'https://mesa-sync.elenanesi55.workers.dev';

const SYNC_SECTIONS = ['library', 'plans', 'shopping', 'profile:elena', 'profile:partner', 'log:elena', 'log:partner'];
const SYNC_DEBOUNCE_MS = 2000;
const MERGE_SECTIONS = {library: true, shopping: true, 'log:elena': true, 'log:partner': true}; // everything else is LWW

/* ---------------- household code ---------------- */
// Crockford-ish alphabet: 32 symbols, excludes 0/O/1/I/L (easy to misread when a partner
// copies it by hand). 24 symbols * 5 bits = 120 bits of entropy — plenty for "nobody can
// guess it", grouped into 4s for readability (~26 characters once the group dashes are
// counted, per the plan's "~26 chars").
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 24;
const CODE_GROUP_SIZE = 4;

function generateHouseholdCode(){
  let out = '';
  if(typeof crypto !== 'undefined' && crypto.getRandomValues){
    const bytes = new Uint8Array(CODE_LENGTH);
    crypto.getRandomValues(bytes);
    for(let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  } else {
    // Fallback for a non-secure context (shouldn't happen — the app requires HTTPS/
    // localhost to run at all as an installed PWA) — Math.random is fine here since this
    // path is unreachable in the app's actual deployment target.
    for(let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

function formatHouseholdCode(code){
  const groups = [];
  for(let i = 0; i < code.length; i += CODE_GROUP_SIZE) groups.push(code.slice(i, i + CODE_GROUP_SIZE));
  return groups.join('-');
}

// Accepts whatever a person pastes/types (dashes, spaces, lowercase) and normalizes it to
// the raw form the code was generated in — uppercase, alphabet-only.
function normalizeHouseholdCode(raw){
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function maskHouseholdCode(code){
  return code.replace(/[A-Z0-9]/gi, '•');
}

/* ---------------- per-section data: live state -> wire shape ---------------- */
// Deep-cloned plain JSON — never a live reference — so nothing here can be mutated by a
// later local edit after it's already been queued into a fetch() body.
function clone(v){ return JSON.parse(JSON.stringify(v)); }

function librarySectionData(){
  return {
    customFoods: clone(customFoods),
    foodOverrides: clone(foodOverrides),
    customRecipes: clone(customRecipes),
    recipeOverrides: clone(recipeOverrides),
    deletedRecipes: clone(deletedRecipes),
    deletedFoods: clone(deletedFoods),
    recipePrefs: clone(recipePrefs),
    customRev: customRev
  };
}

function plansSectionData(){
  return {
    weekPlans: clone(weekPlans),
    mealPins: clone(mealPins),
    mealRules: clone(mealRules),
    SHARED: {breakfast: SHARED.breakfast, lunch: SHARED.lunch, dinner: SHARED.dinner, snack: SHARED.snack},
    householdStyle: householdStyle,
    nextWeekTuning: nextWeekTuning, // task C2 (2026-07-18): household-level, LWW like householdStyle
    servings: {svE: svE, svM: svM, svS: svS}
  };
}

// checkedShopByWeek (state.js) is {week: {name: true}} — the wire shape uses arrays of
// names (JSON-friendlier, and what mergeShoppingSection below unions over).
function cloneCheckedByWeek(){
  const out = {};
  Object.keys(checkedShopByWeek).forEach(function(wk){
    out[wk] = Object.keys(checkedShopByWeek[wk]).filter(function(n){ return checkedShopByWeek[wk][n]; });
  });
  return out;
}
function expandCheckedByWeek(byWeekArrays){
  const out = {};
  Object.keys(byWeekArrays || {}).forEach(function(wk){
    const set = {};
    (byWeekArrays[wk] || []).forEach(function(n){ if(typeof n === 'string') set[n] = true; });
    out[wk] = set;
  });
  return out;
}
function shoppingSectionData(){ return {checkedByWeek: cloneCheckedByWeek()}; }

// Reuses PERSIST_PROFILE_FIELDS (state.js) — the exact fields that already round-trip
// through localStorage — so this section's shape never drifts from what's actually
// user-editable.
function profileSectionData(personKey){
  const p = PROF[personKey], out = {};
  PERSIST_PROFILE_FIELDS.forEach(function(f){ out[f] = (f === 'avoid') ? (p.avoid || []).slice() : p[f]; });
  return out;
}
function applyProfileSectionData(personKey, data){
  const p = PROF[personKey];
  PERSIST_PROFILE_FIELDS.forEach(function(f){
    if(!Object.prototype.hasOwnProperty.call(data, f)) return;
    p[f] = (f === 'avoid' && Array.isArray(data[f])) ? data[f].slice() : data[f];
  });
}

function applyPlansSectionData(data){
  if(data.weekPlans && typeof data.weekPlans === 'object'){
    const clean = {};
    Object.keys(data.weekPlans).forEach(function(k){
      const p = data.weekPlans[k];
      if(isValidWeekPlanShape(p) && p.weekStartDate === k) clean[k] = p;
    });
    weekPlans = clean;
  }
  if(data.mealPins && typeof data.mealPins === 'object'){
    mealPins = {};
    Object.keys(data.mealPins).forEach(function(k){ if(typeof k === 'string' && data.mealPins[k]) mealPins[k] = true; });
  }
  if(Array.isArray(data.mealRules)){
    mealRules = [];
    data.mealRules.forEach(function(rule){
      if(!rule || typeof rule !== 'object') return;
      if(typeof rule.recipeId !== 'string' || typeof rule.slot !== 'string') return;
      if(['daily', 'alternate', 'weekly'].indexOf(rule.cadence) === -1) return;
      if(['shared', 'elena', 'partner'].indexOf(rule.person) === -1) return;
      mealRules.push({
        recipeId: rule.recipeId,
        slot: rule.slot,
        cadence: rule.cadence,
        person: rule.person,
        anchorDate: typeof rule.anchorDate === 'string' ? rule.anchorDate : todayISO(),
        dayIndex: typeof rule.dayIndex === 'number' ? Math.max(0, Math.min(6, rule.dayIndex)) : 0,
        pinFromDate: (typeof rule.pinFromDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rule.pinFromDate)) ? rule.pinFromDate : undefined
      });
    });
  }
  if(data.SHARED && typeof data.SHARED === 'object'){
    Object.keys(SHARED).forEach(function(k){ if(typeof data.SHARED[k] === 'boolean') SHARED[k] = data.SHARED[k]; });
  }
  if(typeof data.householdStyle === 'string' && HOUSEHOLD_STYLES.indexOf(data.householdStyle) !== -1) householdStyle = data.householdStyle;
  // task C2 (2026-07-18): same LWW rule as householdStyle above (merged.* already carries
  // remote's value via mergePlansSection's `clone(remote || {})` base for non-weekPlans
  // fields — this just validates + applies it, same as every other plans-section field).
  if(typeof data.nextWeekTuning === 'string' && NEXT_WEEK_TUNING_KEYS.indexOf(data.nextWeekTuning) !== -1) nextWeekTuning = data.nextWeekTuning;
  if(data.servings && typeof data.servings === 'object'){
    if(typeof data.servings.svE === 'number') svE = data.servings.svE;
    if(typeof data.servings.svM === 'number') svM = data.servings.svM;
    if(typeof data.servings.svS === 'number') svS = data.servings.svS;
  }
  weekPlan = weekPlans[mondayOfWeek(todayISO())] || null; // keep the compat getter (state.js) in sync
}

// One date's log, for one person: {entries: [...LogEntry], tomb: [...identity strings],
// target: kcalNum|null, skipped: {slot: true}} — a compact, person-scoped slice of
// logHistory[date] (state.js), which is itself keyed {elena, partner, targets, skipped, tomb}.
function logSectionData(personKey){
  const out = {};
  Object.keys(logHistory).forEach(function(date){
    const day = logHistory[date];
    out[date] = {
      entries: clone(day[personKey] || []),
      tomb: clone((day.tomb && day.tomb[personKey]) || []),
      target: (day.targets && typeof day.targets[personKey] === 'number') ? day.targets[personKey] : null,
      skipped: clone((day.skipped && day.skipped[personKey]) || {})
    };
  });
  return out;
}
function applyLogSectionData(personKey, mergedByDate){
  Object.keys(mergedByDate).forEach(function(date){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const src = mergedByDate[date];
    const day = getDayLog(date); // state.js — creates + back-fills tomb/targets/skipped on first touch
    day[personKey] = (src.entries || []).filter(isValidLogEntry);
    day.tomb[personKey] = (src.tomb || []).filter(isValidLogTombstone);
    if(typeof src.target === 'number') day.targets[personKey] = src.target;
    day.skipped[personKey] = {};
    Object.keys(src.skipped || {}).forEach(function(slot){ if(src.skipped[slot]) day.skipped[personKey][slot] = true; });
  });
}

function sectionData(sec){
  if(sec === 'library') return librarySectionData();
  if(sec === 'plans') return plansSectionData();
  if(sec === 'shopping') return shoppingSectionData();
  if(sec === 'profile:elena') return profileSectionData('elena');
  if(sec === 'profile:partner') return profileSectionData('partner');
  if(sec === 'log:elena') return logSectionData('elena');
  if(sec === 'log:partner') return logSectionData('partner');
  return {};
}

/* ---------------- merge rules for the non-LWW sections ---------------- */
// shopping: union of checked names, per week — a name checked on EITHER phone stays
// checked (no tombstone: the plan doesn't call for one here, and shopping lists are
// short-lived/regenerated weekly, so an occasional stuck-checked item is a non-issue).
function mergeShoppingSection(local, remote){
  const weeks = {};
  Object.keys((local && local.checkedByWeek) || {}).forEach(function(w){ weeks[w] = true; });
  Object.keys((remote && remote.checkedByWeek) || {}).forEach(function(w){ weeks[w] = true; });
  const merged = {};
  Object.keys(weeks).forEach(function(w){
    const names = {};
    ((local && local.checkedByWeek && local.checkedByWeek[w]) || []).forEach(function(n){ names[n] = true; });
    ((remote && remote.checkedByWeek && remote.checkedByWeek[w]) || []).forEach(function(n){ names[n] = true; });
    merged[w] = Object.keys(names);
  });
  return {checkedByWeek: merged};
}

// plans (FIX: cross-device swap consistency): two phones can swap DIFFERENT meals in
// the same week between syncs — the old whole-blob LWW silently discarded the losing
// phone's swap. Each mutated meal cell carries a `t` stamp (planner.js:applySwapToPlan/
// stepMealServings); per (week, day, slot) the later-touched cell wins. Weeks whose
// signatures differ were REGENERATED (targets/library/shared toggles changed) — their
// cells aren't comparable, so the newer SECTION wins that week whole (old LWW
// behavior). SHARED/householdStyle/servings/nextWeekTuning sub-fields also keep the old
// LWW rule (remote wins) — merged starts as a clone of remote.
function mergePlansSection(local, remote, remoteIsNewer){
  const merged = clone(remote || {});
  merged.weekPlans = merged.weekPlans || {};
  const localPlans = (local && local.weekPlans) || {};
  Object.keys(localPlans).forEach(function(wk){
    const L = localPlans[wk], R = merged.weekPlans[wk];
    if(!isValidWeekPlanShape(L)) return;
    if(!R){ merged.weekPlans[wk] = clone(L); return; }
    if(L.signature !== R.signature){
      if(!remoteIsNewer) merged.weekPlans[wk] = clone(L);
      return;
    }
    (R.days || []).forEach(function(dayR, di){
      const dayL = L.days && L.days[di];
      if(!dayL || !dayL.meals || !dayR.meals) return;
      Object.keys(dayR.meals).forEach(function(slot){
        const cL = dayL.meals[slot], cR = dayR.meals[slot];
        if(!cL || !cR) return;
        if(cR.shared){
          // Shared dish: both eat the same recipe and a swap changes it for both, so the
          // whole cell moves together — keep the newer cell by its stamp (legacy behavior).
          if((cL.t || 0) > (cR.t || 0)) dayR.meals[slot] = clone(cL);
          return;
        }
        // Solo meal: each person has their OWN dish in this slot. Merge the two halves
        // independently so one person's swap/re-portion never overwrites the other's (the
        // couple-sync revert bug). Prefer the per-person stamp; fall back to the legacy
        // cell-level t for halves that predate per-person stamps.
        ['elena', 'partner'].forEach(function(P){
          const lp = cL[P], rp = cR[P];
          if(!lp || !rp) return;
          const tl = (typeof lp.t === 'number') ? lp.t : (cL.t || 0);
          const tr = (typeof rp.t === 'number') ? rp.t : (cR.t || 0);
          if(tl > tr) dayR.meals[slot][P] = clone(lp);
        });
        const cM = dayR.meals[slot];
        const newest = Math.max(cL.t || 0, cR.t || 0, (cM.elena && cM.elena.t) || 0, (cM.partner && cM.partner.t) || 0);
        if(newest) cM.t = newest;
      });
    });
  });
  return merged;
}

// log:elena / log:partner: append-merge by entry identity (state.js:entryIdentity — 'plan:'
// slot, or 'food:'+id), per day, with tombstone-aware exclusion. A same-identity conflict
// keeps whichever side was UPDATED later (`u`, ms timestamp). Older records that predate
// `u` fall back to log time (`t`, "HH:MM" — same-day string compare is safe); an exact tie
// keeps local's copy, arbitrarily but deterministically.
function logEntryIsNewer(candidate, existing){
  const candidateHasUpdate = typeof candidate.u === 'number';
  const existingHasUpdate = existing && typeof existing.u === 'number';
  if(candidateHasUpdate || existingHasUpdate){
    if(candidateHasUpdate && existingHasUpdate) return candidate.u > existing.u;
    return candidateHasUpdate;
  }
  return (candidate.t || '') > (existing.t || '');
}

function mergeLogSection(local, remote){
  const dates = {};
  Object.keys(local || {}).forEach(function(d){ dates[d] = true; });
  Object.keys(remote || {}).forEach(function(d){ dates[d] = true; });
  const merged = {};
  Object.keys(dates).forEach(function(date){
    const L = (local && local[date]) || {entries: [], tomb: [], target: null, skipped: {}};
    const R = (remote && remote[date]) || {entries: [], tomb: [], target: null, skipped: {}};
    const tomb = {};
    function ingestTombs(tombs){
      (tombs || []).forEach(function(t){
        const id = logTombstoneId(t);
        if(!id) return;
        const u = logTombstoneTime(t);
        if(!tomb[id] || u > tomb[id].u) tomb[id] = {id: id, u: u};
      });
    }
    ingestTombs(L.tomb);
    ingestTombs(R.tomb);

    const byIdentity = {};
    function ingest(entries){
      (entries || []).forEach(function(e){
        const id = entryIdentity(e); // state.js
        const deletedAt = tomb[id] ? tomb[id].u : 0;
        const updatedAt = typeof e.u === 'number' ? e.u : 0;
        if(tomb[id] && deletedAt >= updatedAt) return; // deleted after this copy — do not resurrect it
        if(tomb[id] && updatedAt > deletedAt) delete tomb[id]; // re-logged after a delete/undo — the new fact wins
        const existing = byIdentity[id];
        if(!existing || logEntryIsNewer(e, existing)) byIdentity[id] = e;
      });
    }
    ingest(L.entries);
    ingest(R.entries);

    const skipped = {};
    Object.keys(L.skipped || {}).forEach(function(slot){ if(L.skipped[slot] && !tomb['skip:' + slot]) skipped[slot] = true; });
    Object.keys(R.skipped || {}).forEach(function(slot){ if(R.skipped[slot] && !tomb['skip:' + slot]) skipped[slot] = true; });
    Object.keys(skipped).forEach(function(slot){ if(byIdentity['plan:' + slot]) delete skipped[slot]; });

    merged[date] = {
      entries: Object.keys(byIdentity).map(function(k){ return byIdentity[k]; }),
      tomb: Object.keys(tomb).map(function(k){ return tomb[k]; }),
      target: (typeof L.target === 'number') ? L.target : R.target,
      skipped: skipped
    };
  });
  return merged;
}

/* ---------------- dirty detection ---------------- */
// In-memory only (reset each page load) — "has this section's live content changed since
// the last time we looked (persist() or a prior sync round-trip)". The FIRST time a
// section is seen (undefined baseline — happens once per boot, whichever comes first: the
// boot sequence's own applyProf()->persist(), or initSync() below) just records the
// current signature with no rev bump: on a fresh boot the loaded content already reflects
// whatever rev was last persisted, so there's nothing new to report yet.
let lastKnownSectionSignature = {};

function computeSectionSignature(sec){ return JSON.stringify(sectionData(sec)); }

function detectDirtySections(){
  SYNC_SECTIONS.forEach(function(sec){
    const sig = computeSectionSignature(sec);
    if(lastKnownSectionSignature[sec] === undefined){
      lastKnownSectionSignature[sec] = sig;
      return;
    }
    if(sig !== lastKnownSectionSignature[sec]){
      lastKnownSectionSignature[sec] = sig;
      syncState.sectionRevs[sec] = (syncState.sectionRevs[sec] || 0) + 1;
      syncState.sectionUpdatedAt[sec] = Date.now();
    }
  });
}

// Per-section rev the server last CONFIRMED it received from us (set in performSync's
// success handler, to whatever rev we sent — see there for why it's the sent rev, not
// necessarily the post-merge local rev). In-memory only; starts empty each page load, so
// the first persist() after a fresh boot (or after create/join) always looks dirty and
// gets synced once — correct, since we haven't confirmed anything with THIS server
// connection yet, and a fresh boot needs to catch up on whatever the other phone did while
// this one was closed.
let lastSyncedRev = {};
let lastMirroredCatalogSignature = null;

// state.js:persist() hooks — see that function's doc for why before/after matters.
function onMesaBeforePersist(){ detectDirtySections(); }

// Gated on "does any section's local rev not match what the server last confirmed" —
// WITHOUT this gate, performSync()'s own internal persist() call (to save
// lastSyncedAt/merged data) would unconditionally reschedule another sync 2s later,
// forever, even when nothing changed: a perpetual heartbeat instead of "debounced push-
// pull after a real mutation" (the actual spec). create/joinHousehold()/initSync() call
// scheduleSync(0) directly (bypassing this gate) for their one unconditional "just
// configured / just booted" sync.
function onMesaAfterPersist(){
  if(!syncState.code) return;
  const dirty = SYNC_SECTIONS.some(function(sec){ return (syncState.sectionRevs[sec] || 0) !== (lastSyncedRev[sec] || 0); });
  if(dirty) scheduleSync();
}

/* ---------------- push / pull ---------------- */
let syncDebounceTimer = null;
function scheduleSync(delayMs){
  if(!syncState.code) return;
  clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(function(){ performSync(false); }, (typeof delayMs === 'number') ? delayMs : SYNC_DEBOUNCE_MS);
}

function buildSyncPayload(){
  const payload = {};
  SYNC_SECTIONS.forEach(function(sec){
    payload[sec] = {
      rev: syncState.sectionRevs[sec] || 0,
      updatedAt: syncState.sectionUpdatedAt[sec] || Date.now(),
      data: sectionData(sec)
    };
  });
  return payload;
}

function buildLibraryCatalogPayload(){
  const foods = Object.keys(FOODS).map(function(id){
    const f = FOODS[id];
    const isCustom = !!customFoods[id];
    const isOverride = !isCustom && !!foodOverrides[id];
    return {
      id: id,
      source: (isCustom || isOverride) ? 'custom' : 'builtin',
      name: f.name || id,
      category: f.cat || '',
      season: typeof foodSeason === 'function' ? foodSeason(f) : (f.season || 'evergreen'),
      updatedAt: (isCustom || isOverride) && typeof f.u === 'number' ? f.u : 0,
      data: clone(f)
    };
  });
  const recipes = Object.keys(RECIPES_DB).map(function(id){
    const r = RECIPES_DB[id];
    const source = customRecipes[id] ? 'custom' : (recipeOverrides[id] ? 'override' : 'builtin');
    return {
      id: id,
      source: source,
      title: r.title || id,
      primarySlot: r.slot || '',
      season: typeof recipeSeason === 'function' ? recipeSeason(r) : (r.season || 'evergreen'),
      updatedAt: (source !== 'builtin' && typeof r.u === 'number') ? r.u : 0,
      data: clone(r)
    };
  });
  return {
    foods: foods,
    recipes: recipes,
    recipePrefs: clone(recipePrefs),
    deletedFoods: clone(deletedFoods),
    deletedRecipes: clone(deletedRecipes)
  };
}

function catalogPayloadSignature(payload){
  return JSON.stringify({
    foods: payload.foods.map(function(f){ return [f.id, f.source, f.updatedAt, f.season, f.data && f.data.name, f.data && f.data.iconKey, f.data && f.data.iconAsset]; }),
    recipes: payload.recipes.map(function(r){ return [r.id, r.source, r.updatedAt, r.season, r.data && r.data.title, r.data && r.data.imageKey, r.data && r.data.imageUri]; }),
    recipePrefs: payload.recipePrefs,
    deletedFoods: payload.deletedFoods,
    deletedRecipes: payload.deletedRecipes
  });
}

function mirrorLibraryCatalogToD1(){
  if(!syncState.code) return;
  const payload = buildLibraryCatalogPayload();
  const sig = catalogPayloadSignature(payload);
  if(sig === lastMirroredCatalogSignature) return;
  lastMirroredCatalogSignature = sig;
  fetch(SYNC_URL + '/library/' + encodeURIComponent(syncState.code), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload)
  }).catch(function(err){
    lastMirroredCatalogSignature = null;
    console.warn('Mesa sync: D1 library mirror failed, will retry later', err);
  });
}

function fetchBuiltinRecipeCatalogFromD1(){
  if(typeof fetch !== 'function') return Promise.resolve(false);
  const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const timer = controller ? setTimeout(function(){ controller.abort(); }, 4500) : null;
  return fetch(SYNC_URL + '/library/GLOBAL', {
    method: 'GET',
    headers: {'Accept': 'application/json'},
    cache: 'no-store',
    signal: controller ? controller.signal : undefined
  }).then(function(res){
    if(!res.ok) throw new Error('catalog http ' + res.status);
    return res.json();
  }).then(function(payload){
    if(!payload || !Array.isArray(payload.recipes)) return false;
    if(typeof replaceBuiltinRecipesFromCatalogRows !== 'function') return false;
    return replaceBuiltinRecipesFromCatalogRows(payload.recipes);
  }).catch(function(err){
    console.warn('Mesa catalog: using bundled recipes fallback', err);
    return false;
  }).then(function(ok){
    if(timer) clearTimeout(timer);
    return ok;
  });
}

function seedSyncBookkeeping(rev){
  const now = Date.now();
  SYNC_SECTIONS.forEach(function(sec){
    syncState.sectionRevs[sec] = rev;
    syncState.sectionUpdatedAt[sec] = now;
    lastKnownSectionSignature[sec] = computeSectionSignature(sec);
  });
}

/* ===================================================================
   LIBRARY SECTION MERGE (2026-07 fix — replaces reusing js/library.js's
   mergeImportedLibrary for sync, see the file-header doc above).

   INCIDENT: a custom recipe re-created a few times while sync "looked
   flaky" ballooned into ~200 copies within days. Root cause: the old
   applySyncResponse library branch called mergeImportedLibrary — which
   intentionally CLONES a same-id/different-content conflict under a new
   freeConflictId + " (imported)" name suffix, correct for a one-time
   manual file import. Reused every sync round, that clone differs from
   what the server had -> local rev bumps -> pushed -> the partner's
   phone merges THAT and clones AGAIN. Every sync round compounds it.
   Custom recipes/foods carried no per-entry timestamp, so "which side is
   actually newer" was undecidable — mergeImportedLibrary's only option
   was "keep both, renamed".

   FIX: js/library.js now stamps every save with `u` (epoch ms). This
   merge picks the higher `u` per id instead of cloning, so both phones
   converge to the SAME winning entry (not two divergent copies) — see
   mergeEntryMap() below for the tie-break that makes that convergence
   deterministic. Deletes are tombstoned (deletedRecipes/deletedFoods,
   state.js) so a plain union-by-id can't resurrect one phone's delete
   from the other's still-present copy.
   =================================================================== */

// Legacy tombstones were a bare `true` (pre-timestamp); new ones are Date.now(). Treated
// as epoch 1 so any real (epoch-ms) entry `u`/tombstone from after 1970 outranks it, while
// still comparing >0 (truthy "is a delete") against an entry that has no `u` at all (0).
function libraryTombstoneTime(v){
  if(v === true) return 1;
  if(typeof v === 'number' && isFinite(v)) return v;
  return 0;
}

// Per-id newer-wins merge for one map (customFoods, foodOverrides, customRecipes, or recipeOverrides).
// missing `u` -> 0, so an old un-stamped local entry loses to any stamped remote entry
// (and vice versa) UNLESS the content is actually identical, in which case local is kept
// untouched rather than needlessly overwritten by a byte-identical remote copy.
function mergeEntryMap(localMap, remoteMap){
  const out = {};
  const ids = {};
  Object.keys(localMap || {}).forEach(function(id){ ids[id] = true; });
  Object.keys(remoteMap || {}).forEach(function(id){ ids[id] = true; });
  Object.keys(ids).forEach(function(id){
    const L = (localMap || {})[id], R = (remoteMap || {})[id];
    if(L && !R){ out[id] = L; return; }
    if(R && !L){ out[id] = R; return; }
    if(contentEqualJSON(L, R)){ out[id] = L; return; } // identical (ignoring `u`) — no-op
    const lu = (L && typeof L.u === 'number') ? L.u : 0;
    const ru = (R && typeof R.u === 'number') ? R.u : 0;
    if(lu !== ru){ out[id] = (lu > ru) ? L : R; return; }
    // Exact tie (including both missing `u`, e.g. pre-this-fix data) — tie-break by
    // comparing JSON.stringify(entry), lexicographically SMALLER wins. Deterministic and
    // symmetric (both phones compare the same two entries the same way), so A merging B's
    // copy and B merging A's copy land on the identical winner — the convergence property
    // that stops the rev-bump ratchet (see mergeLibrarySection's doc block).
    const ls = JSON.stringify(L), rs = JSON.stringify(R);
    out[id] = (ls <= rs) ? L : R;
  });
  return out;
}

// Unions two tombstone maps (deletedRecipes or deletedFoods), keeping the LATER timestamp
// per id when both sides deleted it (harmless — a delete is a delete) — legacy `true`
// entries collapse to epoch 1 via libraryTombstoneTime().
function mergeTombstones(localTomb, remoteTomb){
  const out = {};
  const ids = {};
  Object.keys(localTomb || {}).forEach(function(id){ ids[id] = true; });
  Object.keys(remoteTomb || {}).forEach(function(id){ ids[id] = true; });
  Object.keys(ids).forEach(function(id){
    const t = Math.max(libraryTombstoneTime((localTomb || {})[id]), libraryTombstoneTime((remoteTomb || {})[id]));
    if(t) out[id] = t;
  });
  return out;
}

// Drops any entry whose id is tombstoned UNLESS the entry's own `u` is newer than the
// tombstone — that's the "recreate after delete" case (saveNewFood/saveRecipeBuilder
// clear the LOCAL tombstone on save, but the OTHER phone's older tombstone can still be
// sitting in remoteTomb until this merge sees the newer `u` and lets the recreate win).
function pruneTombstoned(map, tombstones){
  const out = {};
  Object.keys(map || {}).forEach(function(id){
    const entry = map[id];
    const eu = (entry && typeof entry.u === 'number') ? entry.u : 0;
    const t = tombstones[id] || 0;
    if(t && t >= eu) return;
    out[id] = entry;
  });
  return out;
}

// recipePrefs has no per-entry `u` (just a 'favorite'|'down' string) — union by id, and on
// a genuine conflict (both sides set a DIFFERENT pref for the same id) tie-break by
// comparing the two value strings directly (lexicographically smaller wins). Symmetric and
// deterministic like mergeEntryMap's tie-break, so both phones converge on the same value.
function mergeSimpleMap(localMap, remoteMap){
  const out = {};
  const ids = {};
  Object.keys(localMap || {}).forEach(function(id){ ids[id] = true; });
  Object.keys(remoteMap || {}).forEach(function(id){ ids[id] = true; });
  Object.keys(ids).forEach(function(id){
    const L = (localMap || {})[id], R = (remoteMap || {})[id];
    if(L === undefined){ out[id] = R; return; }
    if(R === undefined){ out[id] = L; return; }
    out[id] = (L === R) ? L : (L < R ? L : R);
  });
  return out;
}

// Top-level library section merge — see the doc block above. `local`/`remote` are the wire
// shapes librarySectionData() produces (customFoods/foodOverrides/customRecipes/recipeOverrides/
// deletedRecipes/deletedFoods/recipePrefs, plus a `customRev` counter that ISN'T part of
// the merge — the caller compares content only, see applySyncResponse's library branch).
function mergeLibrarySection(local, remote){
  const mergedDeletedRecipes = mergeTombstones(local.deletedRecipes, remote.deletedRecipes);
  const mergedDeletedFoods = mergeTombstones(local.deletedFoods, remote.deletedFoods);
  return {
    customFoods: pruneTombstoned(mergeEntryMap(local.customFoods, remote.customFoods), mergedDeletedFoods),
    foodOverrides: pruneTombstoned(mergeEntryMap(local.foodOverrides, remote.foodOverrides), mergedDeletedFoods),
    customRecipes: pruneTombstoned(mergeEntryMap(local.customRecipes, remote.customRecipes), mergedDeletedRecipes),
    recipeOverrides: pruneTombstoned(mergeEntryMap(local.recipeOverrides, remote.recipeOverrides), mergedDeletedRecipes),
    deletedRecipes: mergedDeletedRecipes,
    deletedFoods: mergedDeletedFoods,
    recipePrefs: mergeSimpleMap(local.recipePrefs, remote.recipePrefs)
  };
}

// After a merge (library/shopping/log:*) produces content that's a strict superset of
// what the server had, bump our rev past remote's so the NEXT sync tick's push outranks
// it and the merged result actually propagates — otherwise it'd sit forever as "ours,
// unsynced" every tick without ever winning the server's rev comparison.
function applyMergedRevBookkeeping(sec, mergedData, remote){
  if(deepEqualJSON(mergedData, remote.data)){
    syncState.sectionRevs[sec] = remote.rev;
  } else {
    syncState.sectionRevs[sec] = remote.rev + 1;
  }
  syncState.sectionUpdatedAt[sec] = Date.now();
}

// Applies whatever the server returned after a push. Returns a {sectionName: true, ...}
// map of sections that actually changed local live state, so the caller knows which
// render funnels need to run (js/sync.js:postSyncRerender).
function applySyncResponse(sent, remoteSections){
  const changed = {};
  Object.keys(remoteSections).forEach(function(sec){
    const remote = remoteSections[sec];
    const sentEntry = sent[sec];
    if(!remote || !sentEntry) return;

    if(deepEqualJSON(remote.data, sentEntry.data)){
      // Our push was the winning (or only) copy — nothing to merge, just record we're caught up.
      syncState.sectionRevs[sec] = remote.rev;
      syncState.sectionUpdatedAt[sec] = remote.updatedAt;
      lastKnownSectionSignature[sec] = JSON.stringify(sentEntry.data);
      return;
    }

    if(sec === 'library'){
      // mergeLibrarySection() — per-id newer-wins merge (see its doc block above), NOT
      // mergeImportedLibrary (that's the manual-file-import merge; reusing it here was
      // the root cause of the "Frittata di pasta" duplication ratchet).
      const merged = mergeLibrarySection(sentEntry.data, remote.data);
      customFoods = merged.customFoods;
      foodOverrides = merged.foodOverrides;
      customRecipes = merged.customRecipes;
      recipeOverrides = merged.recipeOverrides;
      deletedRecipes = merged.deletedRecipes;
      deletedFoods = merged.deletedFoods;
      recipePrefs = merged.recipePrefs;
      applyCustomFoods();
      applyCustomRecipes();

      // Content-only comparison: remote.data/sentEntry.data both carry an extra `customRev`
      // counter (librarySectionData()) that isn't part of the merge and needn't match
      // bit-for-bit across devices — strip it before the "did anything actually change"
      // checks below (applyMergedRevBookkeeping assumes mergedData's shape IS remote.data's
      // shape 1:1, which isn't true here because of that counter field, hence the inline
      // version instead of reusing it for this section).
      const LIB_KEYS = ['customFoods', 'foodOverrides', 'customRecipes', 'recipeOverrides', 'deletedRecipes', 'deletedFoods', 'recipePrefs'];
      function libContentOnly(data){
        const out = {};
        LIB_KEYS.forEach(function(k){ out[k] = data[k] || {}; });
        return out;
      }
      if(!deepEqualJSON(merged, libContentOnly(sentEntry.data))) customRev++; // local content actually changed by the merge
      syncState.sectionRevs[sec] = deepEqualJSON(merged, libContentOnly(remote.data)) ? remote.rev : remote.rev + 1;
      syncState.sectionUpdatedAt[sec] = Date.now();
    } else if(sec === 'shopping'){
      const merged = mergeShoppingSection(sentEntry.data, remote.data);
      checkedShopByWeek = expandCheckedByWeek(merged.checkedByWeek);
      applyMergedRevBookkeeping(sec, merged, remote);
    } else if(sec === 'log:elena' || sec === 'log:partner'){
      const personKey = sec === 'log:elena' ? 'elena' : 'partner';
      const merged = mergeLogSection(sentEntry.data, remote.data);
      applyLogSectionData(personKey, merged);
      applyMergedRevBookkeeping(sec, merged, remote);
    } else if(sec === 'plans'){
      const remoteIsNewer = (remote.updatedAt || 0) >= (syncState.sectionUpdatedAt[sec] || 0);
      const merged = mergePlansSection(sentEntry.data, remote.data, remoteIsNewer);
      applyPlansSectionData(merged);
      applyMergedRevBookkeeping(sec, merged, remote);
    } else if(sec === 'profile:elena' || sec === 'profile:partner'){
      const personKey = sec === 'profile:elena' ? 'elena' : 'partner';
      applyProfileSectionData(personKey, remote.data);
      syncState.sectionRevs[sec] = remote.rev;
      syncState.sectionUpdatedAt[sec] = remote.updatedAt;
    } else {
      return; // unknown section name (future server, older client) — ignore rather than guess
    }

    lastKnownSectionSignature[sec] = computeSectionSignature(sec);
    changed[sec] = true;
  });
  return changed;
}

// Re-renders through the existing, already-correct funnels — never a bespoke repaint path
// of its own, so a synced change is indistinguishable on screen from a local one made the
// same way. Picking the minimal correct set per section:
//   library/plans -> applyProf(): re-runs ensureWeekPlan() for missing/stale plans without
//     treating library additions as a reason to reset an existing week, then repaints Week/
//     Today/Log, renderAvoidEditor, the library count line — everything downstream.
//   log:* -> refreshAfterLogChange(): Today ring/macros, Log cards+pill, "Today so far".
//     Cheap even when it was the OTHER profile's log that changed (a pure recompute from
//     logHistory, not a mutation) — correctness matters more than skipping a redundant call.
//   profile:* -> applyProf(): recomputes targets/macros/avoid-list from the (possibly
//     just-changed) PERSIST_PROFILE_FIELDS.
function postSyncRerender(changed){
  if(changed.library || changed.plans || changed['profile:elena'] || changed['profile:partner']){
    applyProf(currentProf);
  }
  if(changed['log:elena'] || changed['log:partner']){
    if(typeof refreshAfterLogChange === 'function') refreshAfterLogChange();
  }
  if(typeof renderInsights === 'function' && document.getElementById('insights') && document.getElementById('insights').classList.contains('active')){
    renderInsights();
  }
  renderCoupleSync();
}

let syncInFlight = false, syncQueuedAfter = false;

// manual=true (the Profile "Sync now" button) surfaces a toast either way; the automatic
// background path (every debounced tick, task S1: "silent failure + 'last synced'
// timestamp") never does — a failed background sync just retries on the next trigger,
// logged to console only, exactly per the ground rule.
function performSync(manual){
  if(!syncState.code) return;
  if(syncInFlight){ syncQueuedAfter = true; return; }
  syncInFlight = true;

  const sent = buildSyncPayload();
  fetch(SYNC_URL + '/sync/' + encodeURIComponent(syncState.code), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({sections: sent})
  }).then(function(res){
    if(!res.ok) throw new Error('sync http ' + res.status);
    return res.json();
  }).then(function(body){
    // Record what the server just confirmed BEFORE applying the response — applySyncResponse
    // may bump a merge-type section's local rev past this (when our merge produced content
    // beyond what remote had), which correctly leaves it "dirty" for one more round trip;
    // see onMesaAfterPersist's doc for why this ordering matters.
    SYNC_SECTIONS.forEach(function(sec){ lastSyncedRev[sec] = sent[sec].rev; });
    const changed = applySyncResponse(sent, (body && body.sections) || {});
    syncState.lastSyncedAt = Date.now();
    persist(); // writes the updated syncState + any merged section data
    postSyncRerender(changed);
    mirrorLibraryCatalogToD1();
    if(manual) toast('✓ Synced with your household');
  }).catch(function(err){
    console.warn('Mesa sync: request failed, will retry automatically', err);
    if(manual) toast('Could not sync right now — will retry automatically');
  }).finally(function(){
    syncInFlight = false;
    if(syncQueuedAfter){ syncQueuedAfter = false; scheduleSync(0); }
  });
}

function pullHouseholdFirst(code){
  const normalized = normalizeHouseholdCode(code);
  if(!normalized) return Promise.resolve(false);
  syncState.code = normalized;
  syncState.lastSyncedAt = null;
  const sent = buildSyncPayload();

  return fetch(SYNC_URL + '/sync/' + encodeURIComponent(normalized), {
    method: 'GET'
  }).then(function(res){
    if(res.status === 404){
      seedSyncBookkeeping(1);
      persist();
      renderCoupleSync();
      scheduleSync(0);
      return true;
    }
    if(!res.ok) throw new Error('sync pull http ' + res.status);
    return res.json().then(function(body){
      const remoteSections = (body && body.sections) || {};
      const changed = applySyncResponse(sent, remoteSections);
      SYNC_SECTIONS.forEach(function(sec){ lastSyncedRev[sec] = syncState.sectionRevs[sec] || 0; });
      syncState.lastSyncedAt = Date.now();
      persist();
      postSyncRerender(changed);
      return true;
    });
  }).catch(function(err){
    syncState.code = null;
    console.warn('Mesa sync: could not restore household from cloud login', err);
    return false;
  });
}

function syncNow(){
  if(!syncState.code) return;
  toast('Syncing…');
  performSync(true);
}

/* ===================================================================
   Profile → "Couple sync" UI
   =================================================================== */
let codeRevealed = false;

function relativeSyncTime(ms){
  if(typeof ms !== 'number') return 'Not synced yet';
  const deltaS = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if(deltaS < 45) return 'Last synced just now';
  if(deltaS < 90) return 'Last synced 1 min ago';
  if(deltaS < 3600) return 'Last synced ' + Math.round(deltaS / 60) + ' min ago';
  if(deltaS < 7200) return 'Last synced 1 hr ago';
  if(deltaS < 86400) return 'Last synced ' + Math.round(deltaS / 3600) + ' hr ago';
  return 'Last synced ' + Math.round(deltaS / 86400) + ' d ago';
}

function renderCoupleSync(){
  const el = document.getElementById('coupleSyncSection');
  if(!el) return; // Profile screen markup not present (shouldn't happen, but don't crash)

  // Until S2 deploys the production worker, SYNC_URL is the local-dev placeholder: hide
  // the whole section (heading included) in that case so shipped builds never show a
  // feature that can't work yet. S2 flips SYNC_URL and this guard turns itself off.
  const syncBackendReady = SYNC_URL.indexOf('127.0.0.1') === -1 && SYNC_URL.indexOf('localhost') === -1;
  if(!syncBackendReady && location.hostname !== '127.0.0.1' && location.hostname !== 'localhost'){
    el.innerHTML = '';
    const h = document.getElementById('coupleSyncHeading');
    if(h) h.style.display = 'none';
    return;
  }
  const hShow = document.getElementById('coupleSyncHeading');
  if(hShow) hShow.style.display = '';

  if(!syncState.code){
    el.innerHTML = '<p class="sub">Share one code between your two phones and Mesa keeps your plan, shopping list and log in sync — still works fully offline, and catches up the moment you\'re both back online.</p>'
      + '<button class="cta ghostbtn" onclick="createHousehold()">✨ Create household code</button>'
      + '<button class="cta ghostbtn" style="margin-top:10px" onclick="openJoinHousehold()">🔗 Join with a code</button>'
      + '<div id="joinHouseholdForm" style="display:none;margin-top:10px">'
      + '<input class="inp" style="width:100%;box-sizing:border-box;border:1px solid var(--line)" type="text" id="joinCodeInput" placeholder="Paste the code your partner shared" autocomplete="off" autocapitalize="characters" spellcheck="false">'
      + '<button class="cta" style="margin-top:8px" onclick="joinHousehold()">Join</button>'
      + '<button class="cta ghostbtn" style="margin-top:8px" onclick="closeJoinHousehold()">Cancel</button>'
      + '</div>';
    return;
  }

  const formatted = formatHouseholdCode(syncState.code);
  const shown = codeRevealed ? formatted : maskHouseholdCode(formatted);
  el.innerHTML = '<p class="sub">Synced with your household — this plan, shopping list and log are shared with whoever else has this code.</p>'
    + '<div class="field"><label>Household code</label>'
    + '<div class="inp"><span id="householdCodeText" style="letter-spacing:.5px;font-family:ui-monospace,Menlo,monospace">' + shown + '</span>'
    + '<span class="row" style="gap:6px"><button class="pill ghost" onclick="toggleRevealCode()">' + (codeRevealed ? 'Hide' : 'Reveal') + '</button>'
    + '<button class="pill ghost" onclick="copyHouseholdCode()">Copy</button></span></div></div>'
    + '<p class="cap-note" id="lastSyncedLine">' + relativeSyncTime(syncState.lastSyncedAt) + '</p>'
    + '<button class="cta ghostbtn" onclick="syncNow()">🔄 Sync now</button>'
    + '<button class="cta ghostbtn" style="margin-top:10px;color:#b25e35;border-color:#b25e35" onclick="openLeaveHouseholdConfirm()">Leave household</button>';
}

function toggleRevealCode(){ codeRevealed = !codeRevealed; renderCoupleSync(); }

function copyHouseholdCode(){
  const formatted = formatHouseholdCode(syncState.code || '');
  function fallbackCopy(){
    const span = document.getElementById('householdCodeText');
    if(!span) return;
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(formatted).then(function(){
      toast('✓ Code copied — share it with your partner');
    }).catch(function(){
      fallbackCopy();
      toast('Couldn’t copy automatically — code selected, copy it manually');
    });
  } else {
    fallbackCopy();
    toast('Couldn’t copy automatically — code selected, copy it manually');
  }
}

function createHousehold(){
  const code = generateHouseholdCode();
  syncState.code = code;
  syncState.lastSyncedAt = null;
  const now = Date.now();
  SYNC_SECTIONS.forEach(function(sec){
    syncState.sectionRevs[sec] = 1;
    syncState.sectionUpdatedAt[sec] = now;
    lastKnownSectionSignature[sec] = computeSectionSignature(sec);
  });
  codeRevealed = true;
  persist();
  renderCoupleSync();
  scheduleSync(0);
  toast('✓ Household created — share the code with your partner');
}

function openJoinHousehold(){
  const form = document.getElementById('joinHouseholdForm');
  if(!form) return;
  form.style.display = 'block';
  const input = document.getElementById('joinCodeInput');
  if(input) input.focus();
}
function closeJoinHousehold(){
  const form = document.getElementById('joinHouseholdForm');
  if(form) form.style.display = 'none';
}

function joinHousehold(){
  const input = document.getElementById('joinCodeInput');
  const code = normalizeHouseholdCode(input ? input.value : '');
  if(code.length < 8){ toast('Enter the code your partner shared'); return; }
  syncState.code = code;
  syncState.lastSyncedAt = null;
  // Start every section's rev at 1 with "now" — this device's current local content
  // (whatever it is: fresh-install defaults, or its own prior solo use) becomes what it
  // offers into the merge. For LWW sections it will almost always lose to an
  // already-established household's higher rev (adopted via applySyncResponse); for the
  // merge-type sections it's unioned/appended in, never discarded.
  seedSyncBookkeeping(1);
  codeRevealed = false;
  closeJoinHousehold();
  persist();
  renderCoupleSync();
  scheduleSync(0);
  toast('✓ Joined — syncing now');
}

// Reads the Cloudflare Access session JWT straight out of the CF_Authorization cookie
// Access sets on this origin after a successful login — it's readable JS-side (not
// HttpOnly). The Worker (worker/sync.js) is NOT itself behind Access — bare workers.dev
// hostnames can't be — so it has no other way to see proof of the Access login; it has to
// be handed the JWT explicitly and verifies it itself (worker/sync.js:verifyAccessJWT)
// rather than trusting a bare email like this used to. Returns '' when the cookie is
// absent (localhost dev, the legacy GitHub Pages origin, or simply no Access session yet)
// so callers fail bootstrap gracefully, same as a missing accessIdentityEmail() used to.
function accessJwtFromCookie(){
  if(location.protocol === 'file:' || typeof document === 'undefined' || !document.cookie) return '';
  const m = document.cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

function bootstrapAccessHousehold(){
  const jwt = accessJwtFromCookie();
  if(!jwt) return Promise.resolve(false);
  return fetch(SYNC_URL + '/bootstrap', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': jwt},
    body: JSON.stringify({existingCode: syncState.code || null})
  }).then(function(res){
    if(!res.ok) throw new Error('bootstrap http ' + res.status);
    return res.json();
  }).then(function(body){
    const code = body && typeof body.code === 'string' ? normalizeHouseholdCode(body.code) : '';
    if(!code) return false;
    if(syncState.code){
      if(syncState.code !== code) syncState.code = code;
      persist();
      return false;
    }
    return pullHouseholdFirst(code).then(function(restored){
      if(restored) toast(hadStoredStateOnBoot ? '✓ Cloud backup connected' : '✓ Restored your Mesa data from Cloudflare login');
      return restored;
    });
  }).catch(function(err){
    console.warn('Mesa sync: Cloudflare Access bootstrap skipped', err);
    return false;
  });
}

function buildLeaveHouseholdConfirmSheet(){
  return '<div class="row between" style="margin-top:6px"><h2 style="margin:0">Leave household?</h2><button class="backbtn" style="margin:0" onclick="closeSheet()">✕ Close</button></div>'
    + '<p class="sub">This phone stops syncing with your household. Everything already here — your plan, shopping list, log and library — stays exactly as it is. You can rejoin any time with the same code.</p>'
    + '<button class="cta ghostbtn" style="margin-top:10px;color:#b25e35;border-color:#b25e35" onclick="confirmLeaveHousehold()">Leave household</button>'
    + '<button class="cta ghostbtn" style="margin-top:10px" onclick="closeSheet()">Cancel</button>';
}
function openLeaveHouseholdConfirm(){
  document.getElementById('sheetBody').innerHTML = buildLeaveHouseholdConfirmSheet();
  document.getElementById('sheet').classList.remove('tall');
  document.getElementById('sheetBackdrop').classList.add('show');
  document.getElementById('sheet').classList.add('show');
}
function confirmLeaveHousehold(){
  syncState.code = null;
  syncState.lastSyncedAt = null;
  clearTimeout(syncDebounceTimer);
  closeSheet();
  persist();
  renderCoupleSync();
  toast('✓ Left the household — your data stays on this phone');
}

/* ---------------- boot ---------------- */
// Called once from app.js's boot sequence, after loadState()/applyCustomFoods()/
// applyCustomRecipes()/applyProf() have all already run — establishes the in-memory
// "last known" signatures fresh against the just-loaded state (harmless if the boot
// sequence's own applyProf()->persist() already did this via detectDirtySections'
// undefined-baseline branch; re-assigning the same values is a no-op), paints the Couple
// sync section, and fires the one on-boot sync (task S1) if a household is configured.
function initSync(){
  SYNC_SECTIONS.forEach(function(sec){ lastKnownSectionSignature[sec] = computeSectionSignature(sec); });
  renderCoupleSync();
  bootstrapAccessHousehold().then(function(restored){
    if(!restored && syncState.code) scheduleSync(0);
  });

  // Proactive pull (FIX: cross-device swap consistency). Without these, an open-but-
  // idle phone only syncs after its OWN next local edit — the partner's swap never
  // arrives until this phone is reloaded. Every sync is a push-pull round trip, so a
  // pull with nothing dirty is a cheap no-op merge.
  document.addEventListener('visibilitychange', function(){
    if(document.visibilityState === 'visible' && syncState.code) scheduleSync(0);
  });
  window.addEventListener('online', function(){
    if(syncState.code) scheduleSync(0);
  });
  setInterval(function(){
    if(syncState.code && document.visibilityState === 'visible') performSync(false);
  }, 120 * 1000);
}
