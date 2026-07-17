/* ===================================================================
   log.js — log history (task D1), split out of state.js (was ~1,200
   lines and doing double duty as "data & mutable state" plus the whole
   log-history API). Loaded immediately after js/state.js (app/index.html)
   so it shares the same global scope; everything below was moved
   VERBATIM out of state.js — no logic changes, see git history for the
   original file if you need the pre-split diff.

   logHistory is the day-by-day record of what was actually eaten/
   skipped (see the LogEntry shape doc below); persist()/loadState()
   (state.js) read/write it directly since cross-file globals resolve at
   call time in this shared, no-modules scope — state.js's persist()
   calls pruneLogHistory() (defined here) exactly as if both functions
   still lived in one file.
   =================================================================== */

/* ===================================================================
   log history (task D1) — replaces the old v1 single-day `todayLog`.

   logHistory['YYYY-MM-DD'] = {
     elena:   [LogEntry, ...],
     partner: [LogEntry, ...],
     targets: {elena: kcalNum|null, partner: kcalNum|null},  // each person's daily kcal
       TARGET, frozen the first time THAT PERSON logs anything on this date (item 4a: a
       later calorie-target change must never move a past day's 7-day bar). null until
       then; computeInsights() (planner.js) falls back to the live target only for the
       rare pre-D1 migrated day that has no snapshot (see migrateV1TodayLog() below).
     skipped: {elena: {slot: true}, partner: {slot: true}}   // UI memory only — "you
       tapped Skip for this slot today" — never summed into nutrition, just lets the Log
       screen restore the skipped-tag across a reload (state, not a fact about food).
   }

   LogEntry = {kind:'plan'|'food', ref: recipeId|foodId, portion?, grams?, kcal, protein,
     carbs, fat, satFat, fiber, sugars, freeSugars, slot?, t:'HH:MM'|null, u: epochMs}. Every macro number is computed
   ONCE, at log time, via recipeNutrition()/foodMacros() (engine.js) and stored verbatim —
   never re-derived from the live recipe/food DB on a later read, so editing a recipe or
   swapping a plan meal never rewrites a past day's history (ground rule 1 + task D1's
   explicit "history stability" requirement). kind:'plan' entries are keyed by `slot`
   (breakfast/lunch/dinner/snack) — upsertLogEntry() replaces-in-place on that key, so a
   swap on an already-logged slot corrects it rather than appending a duplicate. kind:'food'
   (quick-add) entries always append.

   Capped at LOG_HISTORY_RETENTION_DAYS days (pruned on every persist()) so the store
   never grows unbounded.
   =================================================================== */
const LOG_HISTORY_RETENTION_DAYS = 60;
let logHistory = {};

function nowHHMM(){
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function emptyDayLog(){
  return {elena: [], partner: [], targets: {elena: null, partner: null}, skipped: {elena: {}, partner: {}}, tomb: {elena: [], partner: []}};
}

// Returns logHistory[dateISO], creating (and back-filling any missing sub-keys on) an
// empty day record on first touch — every caller can read/push without a null-check dance.
function getDayLog(dateISO){
  if(!logHistory[dateISO]) logHistory[dateISO] = emptyDayLog();
  const day = logHistory[dateISO];
  if(!day.targets) day.targets = {elena: null, partner: null};
  if(!day.skipped) day.skipped = {elena: {}, partner: {}};
  if(!day.tomb) day.tomb = {elena: [], partner: []}; // task S1: back-fill on records logged before couple sync existed
  if(!Array.isArray(day.elena)) day.elena = [];
  if(!Array.isArray(day.partner)) day.partner = [];
  return day;
}

/* ---------------- couple sync (task S1): entry identity + tombstones ----------------
   Two devices append LogEntrys to the same logHistory independently; merging (js/sync.js)
   needs a stable identity per entry so the SAME confirm/quick-add isn't duplicated when
   both sides' copies are unioned, and a per-day "tombstone" list so a DELETE on one phone
   (undo a confirm, remove a "Today so far" row) propagates as a delete on the other
   instead of the removed entry silently reappearing next merge.

   kind:'plan' entries are naturally singleton-per-slot (upsertLogEntry replaces in place),
   so their identity is just the slot name. kind:'food' (quick-add) entries can repeat
   (logging the same food twice today is normal), so they get a random `id` at creation
   (genId(), assigned in logFoodEntry below) and identity is keyed on that; entries logged
   before this existed have no `id` — entryIdentity() falls back to a composite of their
   fields, good enough to dedupe/tombstone without being a perfect UUID. */
function genId(){
  if(typeof crypto !== 'undefined' && crypto.getRandomValues){
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function(b){ return b.toString(16).padStart(2, '0'); }).join('');
  }
  return Math.random().toString(16).slice(2, 14); // fallback for a non-secure-context or old browser
}

function entryIdentity(e){
  if(e.kind === 'plan') return 'plan:' + e.slot;
  return 'food:' + (e.id || (e.ref + '|' + e.grams + '|' + e.t + '|' + e.kcal));
}

function logTombstoneId(t){
  if(typeof t === 'string') return t;
  return (t && typeof t === 'object' && typeof t.id === 'string') ? t.id : '';
}

function logTombstoneTime(t){
  return (t && typeof t === 'object' && typeof t.u === 'number' && isFinite(t.u)) ? t.u : 0;
}

function isValidLogTombstone(t){
  return typeof t === 'string'
    || !!(t && typeof t === 'object' && typeof t.id === 'string' && typeof t.u === 'number' && isFinite(t.u));
}

function removeLogTombstone(dateISO, personKey, identity){
  const day = getDayLog(dateISO);
  day.tomb[personKey] = day.tomb[personKey].filter(function(t){ return logTombstoneId(t) !== identity; });
}

function tombstoneEntry(dateISO, personKey, identity){
  const day = getDayLog(dateISO);
  const now = Date.now();
  let replaced = false;
  day.tomb[personKey] = day.tomb[personKey].map(function(t){
    if(logTombstoneId(t) !== identity) return t;
    replaced = true;
    return {id: identity, u: Math.max(now, logTombstoneTime(t))};
  });
  if(!replaced) day.tomb[personKey].push({id: identity, u: now});
}

// Freezes personKey's kcal TARGET for dateISO the first time they log anything that day
// (task D1 item 4a). Callers must ensure PROF[personKey].calGoalNum is current first —
// every live call site runs after ensureWeekPlan()/recomputeProf() have already refreshed
// it (see planner.js:ensureWeekPlan, applyProf), so this is always the true target at the
// moment of logging, not a stale one.
function ensureTargetSnapshot(dateISO, personKey){
  const day = getDayLog(dateISO);
  if(typeof day.targets[personKey] !== 'number') day.targets[personKey] = PROF[personKey].calGoalNum;
  return day;
}

// Adds one computed LogEntry, freezing the day's target snapshot first. kind:'plan'
// entries replace any existing entry for the same slot (a swap corrects history rather
// than duplicating it); kind:'food' entries always append. persist() is the caller's job
// (same convention as every other mutating action in render.js/planner.js).
function upsertLogEntry(dateISO, personKey, entry){
  ensureTargetSnapshot(dateISO, personKey);
  const day = getDayLog(dateISO);
  const arr = day[personKey];
  if(typeof entry.u !== 'number') entry.u = Date.now();
  if(entry.kind === 'plan' && entry.slot){
    removeLogTombstone(dateISO, personKey, 'plan:' + entry.slot);
    removeLogTombstone(dateISO, personKey, 'skip:' + entry.slot);
    delete day.skipped[personKey][entry.slot];
    const idx = arr.findIndex(function(e){ return e.kind === 'plan' && e.slot === entry.slot; });
    if(idx !== -1){
      entry.t = arr[idx].t || entry.t; // keep the original log time on an edit (e.g. a post-confirm swap)
      entry.u = Date.now(); // but sync conflicts must see this edit as newer than the original confirm
      arr[idx] = entry;
      return entry;
    }
  }
  arr.push(entry);
  return entry;
}

// Builds + upserts a plan-kind LogEntry from a recipe id + portion, computing every macro
// fresh via recipeNutrition() (engine.js). Used by logConfirm (first confirm — breakfast
// included, see FIX 1: breakfast is a normal meal with its own Confirm/Swap/Skip, no more
// auto-log), by chooseSwap (editing an already-logged slot), and by restoreTodayLog's
// replay guard.
function logPlanEntry(dateISO, personKey, slot, recipeId, portion, components){
  const parts = Array.isArray(components) && components.length ? components : [{recipeId: recipeId, portion: portion}];
  const nut = roundedNutritionTotals(nutritionForRecipeComponents(parts));
  return upsertLogEntry(dateISO, personKey, {
    kind: 'plan', ref: recipeId, portion: portion, components: parts,
    kcal: nut.kcal, protein: nut.protein, carbs: nut.carbs,
    fat: nut.fat, satFat: nut.satFat, fiber: nut.fiber,
    sugars: nut.sugars, freeSugars: nut.freeSugars,
    slot: slot, t: nowHHMM()
  });
}

// Quick-add (task D1 item 2): a food-kind LogEntry from FOODS, computed via foodMacros().
// `id` (task S1): a random identity token so couple sync can merge/dedupe/tombstone this
// specific entry across two devices — see entryIdentity() above.
function logFoodEntry(dateISO, personKey, foodId, grams){
  const nut = roundedNutritionTotals(foodMacros(foodId, grams));
  return upsertLogEntry(dateISO, personKey, {
    kind: 'food', ref: foodId, grams: grams, id: genId(),
    kcal: nut.kcal, protein: nut.protein, carbs: nut.carbs,
    fat: nut.fat, satFat: nut.satFat, fiber: nut.fiber,
    sugars: nut.sugars, freeSugars: nut.freeSugars,
    t: nowHHMM()
  });
}

// Skip = "not eaten", not a nutrition fact — recorded only so the Log screen can restore
// the skipped-tag across a reload. Also drops any plan entry that might exist for that
// slot (shouldn't normally happen, but keeps the two states mutually exclusive).
function markSlotSkipped(dateISO, personKey, slot){
  const day = getDayLog(dateISO);
  removeLogTombstone(dateISO, personKey, 'skip:' + slot);
  tombstoneEntry(dateISO, personKey, 'plan:' + slot);
  day.skipped[personKey][slot] = true;
  day[personKey] = day[personKey].filter(function(e){ return !(e.kind === 'plan' && e.slot === slot); });
}

// FIX 2 (feedback) — undo paths. Removing a slot's plan entry (and clearing any skipped
// flag) sends slotLogStatus() back to null, which is exactly what restores the card's
// Confirm/Swap/Skip actions on the next renderLogPlan(). Pure logHistory mutations:
// every surface (Today ring/macros, Log pill, "Today so far", Insights) re-derives from
// logHistory, so callers just re-render + persist() afterwards (same convention as every
// other mutator in this file).
// Task S1 (couple sync): records a tombstone for whatever this actually undid — a
// confirmed plan entry ('plan:'+slot) and/or a skipped flag ('skip:'+slot) — so the undo
// propagates to the other phone instead of the other side's still-standing copy quietly
// resurrecting the entry/skip on the next merge (js/sync.js:mergeLogSection()).
function removeLoggedSlot(dateISO, personKey, slot){
  const day = getDayLog(dateISO);
  const hadPlan = day[personKey].some(function(e){ return e.kind === 'plan' && e.slot === slot; });
  const hadSkip = !!day.skipped[personKey][slot];
  day[personKey] = day[personKey].filter(function(e){ return !(e.kind === 'plan' && e.slot === slot); });
  delete day.skipped[personKey][slot];
  if(hadPlan) tombstoneEntry(dateISO, personKey, 'plan:' + slot);
  if(hadSkip) tombstoneEntry(dateISO, personKey, 'skip:' + slot);
}

// Removes ONE specific entry by its index in the day's per-person array — the "Today so
// far" ✕ (quick-added foods AND confirmed plan meals alike). Returns the removed entry
// (or null) so the caller can toast and, for a plan entry, restore the matching Log
// card's actions. Task S1: tombstones the removed entry's identity (see entryIdentity()
// above) so this delete propagates on the next couple sync rather than the entry
// reappearing from the other phone's still-standing copy.
function removeLogEntryAt(dateISO, personKey, index){
  const arr = getDayLog(dateISO)[personKey];
  if(!(index >= 0 && index < arr.length)) return null;
  const removed = arr.splice(index, 1)[0];
  tombstoneEntry(dateISO, personKey, entryIdentity(removed));
  return removed;
}

// 'confirmed' | 'skipped' | null — drives the Log screen's per-slot restore (app.js:
// restoreTodayLog) and lets chooseSwap (planner.js) know whether a swapped slot needs its
// log entry corrected in place.
function slotLogStatus(dateISO, personKey, slot){
  const day = getDayLog(dateISO);
  if(day[personKey].some(function(e){ return e.kind === 'plan' && e.slot === slot; })) return 'confirmed';
  if(day.skipped[personKey][slot]) return 'skipped';
  return null;
}

// Drops days older than LOG_HISTORY_RETENTION_DAYS (relative to today) — called from
// persist() so the store never grows unbounded. String comparison is safe: ISO dates
// sort lexicographically.
function pruneLogHistory(){
  const cutoff = addDaysISO(todayISO(), -LOG_HISTORY_RETENTION_DAYS);
  Object.keys(logHistory).forEach(function(date){
    if(date < cutoff) delete logHistory[date];
  });
}

function normalizeLogEntry(e){
  if(!e || typeof e !== 'object') return false;
  if(e.kind !== 'plan' && e.kind !== 'food') return false;
  if(typeof e.ref !== 'string') return false;
  if(!['kcal', 'protein', 'carbs', 'fat', 'satFat', 'fiber'].every(function(k){ return typeof e[k] === 'number' && isFinite(e[k]); })) return false;
  const out = Object.assign({}, e);
  ['sugars', 'freeSugars'].forEach(function(k){
    if(typeof out[k] !== 'number' || !isFinite(out[k])) out[k] = 0;
    if(out[k] < 0) out[k] = 0;
  });
  if(out.freeSugars > out.sugars) out.freeSugars = out.sugars;
  return out;
}

function isValidLogEntry(e){
  return !!normalizeLogEntry(e);
}

// v1 -> v2 migration: v1 stored only TODAY's plan-first confirm/skip status, un-keyed by
// person (a known v1 gap — Log actions applied to whichever profile happened to be active
// when tapped). loadState() only ever kept a v1 `log` whose date === today (older ones
// were discarded outright), so there's at most one day to migrate. Rather than trust v1's
// display-only {title, kcal} strings (no recipeId, no full macro breakdown), this recovers
// the real recipeId + portion from the ALSO-persisted v1 weekPlan and recomputes full
// macros via recipeNutrition() — so migrated entries are exactly as trustworthy as any
// entry logged under v2. Attributed to v1's saved currentProf (the best available guess
// for "whose log this was"). No-ops entirely once a v2 `logHistory` is present.
function migrateV1TodayLog(saved){
  if(saved.logHistory && typeof saved.logHistory === 'object') return;
  if(!(saved.log && typeof saved.log === 'object' && saved.log.date === todayISO() && saved.log.slots && typeof saved.log.slots === 'object')) return;
  const person = (typeof saved.currentProf === 'string' && PROF[saved.currentProf]) ? saved.currentProf : 'elena';
  const wp = (saved.weekPlan && typeof saved.weekPlan === 'object' && typeof saved.weekPlan.weekStartDate === 'string' && Array.isArray(saved.weekPlan.days)) ? saved.weekPlan : null;
  Object.keys(saved.log.slots).forEach(function(slot){
    const rec = saved.log.slots[slot];
    if(!rec || slot === 'breakfast') return; // breakfast had no v1 record (it was auto-logged pre-FIX-1, never persisted as a v1 slot)
    if(rec.status === 'confirmed' && wp){
      const dayIdx = Math.max(0, Math.min(6, diffDaysISO(todayISO(), wp.weekStartDate)));
      const day = wp.days[dayIdx];
      const planEntry = day && day.meals && day.meals[slot] && day.meals[slot][person];
      if(planEntry && planEntry.recipeId){
        const nut = recipeNutrition(planEntry.recipeId, planEntry.portion).totals;
        getDayLog(todayISO())[person].push({
          kind: 'plan', ref: planEntry.recipeId, portion: planEntry.portion,
          kcal: Math.round(nut.kcal), protein: Math.round(nut.protein), carbs: Math.round(nut.carbs),
          fat: Math.round(nut.fat), satFat: Math.round(nut.satFat), fiber: Math.round(nut.fiber),
          slot: slot, t: null
        });
      }
    } else if(rec.status === 'skipped'){
      markSlotSkipped(todayISO(), person, slot);
    }
  });
}

// v2 -> v3 migration (feedback FIX 1): breakfast used to be auto-logged the moment its
// plan slot was known (planner.js's now-removed ensureTodayBreakfastLogged()), so a store
// saved by an older build may contain TODAY's breakfast plan-entry even though the user
// never tapped Confirm. LogEntry (see the shape doc above) records no auto-vs-manual flag
// — there's nothing in the stored shape that distinguishes a real confirm from the old
// auto-log — so as a one-time migration (gated on the stored version being < 3, so this
// never re-fires on a later load) we drop TODAY's breakfast plan-entry for both people.
// A genuinely confirmed breakfast today is the rare case (this only matters on the exact
// day the app updates) and is one tap to re-confirm; every other day's history, and every
// other slot, is untouched.
function migrateRemoveAutoBreakfast(saved){
  const fromVersion = (typeof saved.v === 'number' && isFinite(saved.v)) ? saved.v : 0;
  if(fromVersion >= 3) return;
  if(!saved.logHistory || typeof saved.logHistory !== 'object') return;
  const today = todayISO();
  const day = saved.logHistory[today];
  if(!day || typeof day !== 'object') return;
  ['elena', 'partner'].forEach(function(person){
    if(Array.isArray(day[person])){
      day[person] = day[person].filter(function(e){ return !(e && e.kind === 'plan' && e.slot === 'breakfast'); });
    }
  });
}
