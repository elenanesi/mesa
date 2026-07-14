/* ===================================================================
   sync.js — couple sync client (Phase 2, task S1)

   Talks to worker/sync.js (a dumb per-section higher-rev-wins store) and
   does all the real merging client-side, per PHASE2-plan.md's "Section
   model & merge rules":
     - library            : merge by id (REUSES js/library.js's
                             mergeImportedLibrary — identical-content
                             skip, conflict re-id, ingredient remap).
     - plans               : LWW, whole blob (weekPlans + SHARED +
                             householdStyle + servings).
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
const ACCESS_IDENTITY_URL = '/cdn-cgi/access/get-identity';

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
    customRecipes: clone(customRecipes),
    recipeOverrides: clone(recipeOverrides),
    deletedRecipes: clone(deletedRecipes),
    customRev: customRev
  };
}

function plansSectionData(){
  return {
    weekPlans: clone(weekPlans),
    SHARED: {breakfast: SHARED.breakfast, lunch: SHARED.lunch, dinner: SHARED.dinner, snack: SHARED.snack},
    householdStyle: householdStyle,
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
  if(data.SHARED && typeof data.SHARED === 'object'){
    Object.keys(SHARED).forEach(function(k){ if(typeof data.SHARED[k] === 'boolean') SHARED[k] = data.SHARED[k]; });
  }
  if(typeof data.householdStyle === 'string' && HOUSEHOLD_STYLES.indexOf(data.householdStyle) !== -1) householdStyle = data.householdStyle;
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
    day.tomb[personKey] = (src.tomb || []).filter(function(x){ return typeof x === 'string'; });
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

// log:elena / log:partner: append-merge by entry identity (state.js:entryIdentity — 'plan:'
// slot, or 'food:'+id), per day, with tombstone-aware exclusion. A same-identity conflict
// (rare: both phones touched the exact same slot before either synced) keeps whichever
// side logged LATER that day (t, "HH:MM" — same-day string compare is safe); an exact tie
// keeps local's copy, arbitrarily but deterministically.
function mergeLogSection(local, remote){
  const dates = {};
  Object.keys(local || {}).forEach(function(d){ dates[d] = true; });
  Object.keys(remote || {}).forEach(function(d){ dates[d] = true; });
  const merged = {};
  Object.keys(dates).forEach(function(date){
    const L = (local && local[date]) || {entries: [], tomb: [], target: null, skipped: {}};
    const R = (remote && remote[date]) || {entries: [], tomb: [], target: null, skipped: {}};
    const tomb = {};
    (L.tomb || []).forEach(function(t){ tomb[t] = true; });
    (R.tomb || []).forEach(function(t){ tomb[t] = true; });

    const byIdentity = {};
    function ingest(entries){
      (entries || []).forEach(function(e){
        const id = entryIdentity(e); // state.js
        if(tomb[id]) return; // deleted on one side — never resurrected by the other's copy
        const existing = byIdentity[id];
        if(!existing || (e.t || '') > (existing.t || '')) byIdentity[id] = e;
      });
    }
    ingest(L.entries);
    ingest(R.entries);

    const skipped = {};
    Object.keys(L.skipped || {}).forEach(function(slot){ if(L.skipped[slot] && !tomb['skip:' + slot]) skipped[slot] = true; });
    Object.keys(R.skipped || {}).forEach(function(slot){ if(R.skipped[slot] && !tomb['skip:' + slot]) skipped[slot] = true; });

    merged[date] = {
      entries: Object.keys(byIdentity).map(function(k){ return byIdentity[k]; }),
      tomb: Object.keys(tomb),
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

function seedSyncBookkeeping(rev){
  const now = Date.now();
  SYNC_SECTIONS.forEach(function(sec){
    syncState.sectionRevs[sec] = rev;
    syncState.sectionUpdatedAt[sec] = now;
    lastKnownSectionSignature[sec] = computeSectionSignature(sec);
  });
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
      const beforeRev = customRev;
      // REUSE js/library.js's mergeImportedLibrary — merges remote library data
      // into the LIVE customFoods/customRecipes/recipeOverrides/deletedRecipes (identical-content
      // skip, conflict re-id + ingredient remap, name-collision " (imported)" suffix),
      // exactly the "library... REUSE library.js's existing mergeImportedLibrary
      // machinery" rule in PHASE2-plan.md. It mutates customFoods/customRecipes/customRev
      // directly and already calls applyCustomFoods()/applyCustomRecipes() when it adds
      // anything, so there's no separate "apply" step needed here.
      mergeImportedLibrary({
        customFoods: remote.data.customFoods || {},
        customRecipes: remote.data.customRecipes || {},
        recipeOverrides: remote.data.recipeOverrides || {},
        deletedRecipes: remote.data.deletedRecipes || {}
      });
      syncState.sectionRevs[sec] = (customRev !== beforeRev) ? remote.rev + 1 : remote.rev;
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
      applyPlansSectionData(remote.data);
      syncState.sectionRevs[sec] = remote.rev;
      syncState.sectionUpdatedAt[sec] = remote.updatedAt;
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
//   library/plans -> applyProf(): re-runs ensureWeekPlan() (the plan signature includes
//     customRev and the plan blob itself), renderWeek/renderTodayMeals/renderLogPlan,
//     renderAvoidEditor, the library count line — everything downstream of either.
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

function accessIdentityEmail(){
  if(location.protocol === 'file:') return Promise.resolve(null);
  return fetch(ACCESS_IDENTITY_URL, {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store'
  }).then(function(res){
    if(!res.ok) return null;
    return res.json();
  }).then(function(body){
    return body && typeof body.email === 'string' ? body.email : null;
  }).catch(function(){ return null; });
}

function bootstrapAccessHousehold(){
  return accessIdentityEmail().then(function(email){
    if(!email) return false;
    return fetch(SYNC_URL + '/bootstrap', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({email: email, existingCode: syncState.code || null})
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
        if(restored) toast('✓ Restored your Mesa data from Cloudflare login');
        return restored;
      });
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
}
