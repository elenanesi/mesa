# Eaten-out from the Week plan — build plan

**Status:** approved 2026-07-21. Follows the daily eaten-out feature (commit d5ed180). Decisions below.

**Goal.** Mark any meal in the Week plan — this week or next, past, today or future — as "we're
eating out" (delivery / restaurant). It drops from the shopping list and never depletes the
pantry, but its **estimated calories still count** (from the meal's own recipe — McDonald's
menu, lasagna, etc. are real recipes with computed nutrition; "better than nothing").

## Decisions (from the user, 2026-07-21)

- **Scope:** the Week plan rows (all of them), not just the daily view.
- **Calories:** count them, using the meal's recipe estimate. NOT a calorie blank.
- **Future timing:** log it now, dated to that day. A future eaten-out meal is pre-recorded
  (shown as an estimate, undoable); when the day arrives it's already marked eaten-out.

## The model — reuse, don't invent

This is NOT a new plan-cell flag. Marking a Week meal eaten-out **LOGS the planned meal as
eaten-out** on that row's date, exactly reusing the daily feature's machinery:

- `logPlanEntry(dateISO, person, slot, recipeId, portion, components, opts)` writes the log
  entry (the recipe's computed calories/macros ride along, as they already do). For a date
  that isn't today, pass `{tNull: true}` — the same "unknown eating time / estimate"
  convention `weekLogConfirm` already uses for backdated logging.
- Then `setLogEntryEatenOut(dateISO, person, index, true)` sets the flag (and bumps `u` for
  sync). The entry is a normal logged meal that happens to be flagged eaten-out.
- **Undo** = `removeLoggedSlot(dateISO, person, slot)` (removes the log for that slot).

Consequences, all FREE from existing code:
- **Calories count** — it's a logged meal; `logEntryNutrition` counts it (Today total for
  that date, Insights). ✓
- **Pantry not depleted** — `pantryConsumedSince` (pantry.js) already skips `eatenOut===true`
  entries. ✓
- **Shopping list drops it** — a logged current-week meal already drops (Q1 exclusion). The
  ONE gap: next week's list (`weekPlanComponents(plan, /*excludeLogged*/ false)`) does not
  exclude logged slots, so a pre-logged next-week eaten-out meal would still appear. Fix
  below.

**Shared meals:** a shared dinner eaten out means BOTH people ate out, so the toggle logs
BOTH `elena` and `partner` entries eaten-out (and undo removes both). A solo meal logs only
that person. This matches how the shopping list counts both people's portions for a shared
meal — dropping only one would leave the other's ingredients on the list.

## Changes

1. **`app/js/log.js` — one small read helper.** `slotLoggedEatenOut(dateISO, person, slot)`:
   true iff that slot has a logged `kind:'plan'` entry with `eatenOut === true`. Reads
   `logHistory` directly (log.js owns log access), so both planner.js and render.js can use
   it (log.js loads before both).

2. **`app/js/planner.js` — shopping list exclusion, any week.** In `weekPlanComponents`,
   exclude a `(day, slot, person)` when `slotLoggedEatenOut(day.date, person, slot)` is true,
   IN ADDITION to the existing `excludeLogged && slotLoggedReadOnly(...)` current-week rule.
   This makes a pre-logged eaten-out meal drop from BOTH this week's and next week's list.
   (For the current week it's redundant with the logged-exclusion but harmless.) This also
   flows into `currentWeekRemainingFoodQuantities` / the pantry projection for free.

3. **`app/js/render.js` — the Week UI.**
   - **Entry point:** the meal add/edit sheet (`openAddMealSheetForContext`, reachable via
     the ✎/＋ button on EVERY Week row through `openWeekAddMealSheet`) gains a
     "🍴 Eating out (log as delivery / restaurant)" toggle. It's the one per-meal sheet
     available on every row without adding a fifth inline button (rows already carry up to 4:
     pin/routine/extras/swap). `addMealCtx` already holds `{weekStartDate, dayIndex, slot,
     person}` and the sheet knows `meal.shared`.
     - Toggling ON: for each affected person (both if `meal.shared`, else the viewer), log the
       planned meal as eaten-out on the row's date (`logPlanEntry` + `setLogEntryEatenOut`;
       `{tNull:true}` when the date isn't today). Then `refreshAfterLogChange()` (the shared
       funnel — repaints Week/Today/Insights). Toast.
     - Toggling OFF: `removeLoggedSlot` for each affected person, then
       `refreshAfterLogChange()`.
     - The toggle's on/off state is derived from `slotLoggedEatenOut` for the viewer's slot.
   - **Row indicator:** a "🍴 out" pill on the Week row (renderWeek's row markup, alongside
     the existing "👥 Together" pill) when that slot is logged-eaten-out for the viewer — so a
     flagged meal reads as such at a glance, since its absence from the shopping list is
     otherwise invisible. Reuse the same pill styling the daily list uses.

No new state field, no `buildSnapshot`/`loadState`/`validateBackupStructure` change, and NO
Worker/D1 change — it rides entirely on the existing `log:*` sync section (the eatenOut flag
already syncs inside the log entry). Confirm this rather than assuming.

## Tests (`tools/check.js`)
- Marking a Week meal eaten-out logs it with the recipe's calories AND `eatenOut===true`; the
  date's logged nutrition includes it (calories count), and `pantryConsumedSince` excludes it
  (no depletion).
- A pre-logged eaten-out meal is absent from the shopping list for BOTH the current week and
  next week (the next-week case is the one that needs the new `weekPlanComponents` line —
  assert it fails without it).
- A SHARED meal marked eaten-out logs both people and drops both portions from the list;
  undo removes both.
- Undo (`removeLoggedSlot`) restores the meal to the shopping list and to pantry depletion.
- Determinism / no snapshot-shape change: a round-trip through buildSnapshot/loadState
  preserves the eaten-out log entries (already covered by log persistence, but assert the
  Week path produces a normally-shaped entry).
- Wiring guards (source-text, since the harness DOM stub returns null): the add/edit sheet
  exposes the toggle and routes it to a handler that calls `logPlanEntry` + `setLogEntryEatenOut`
  (on / date-aware) and `removeLoggedSlot` (off); renderWeek emits the "🍴 out" pill from
  `slotLoggedEatenOut`.

## Risks
- **Next-week shopping exclusion is the subtle bit.** The current-week list drops logged meals
  already; next week does not. The new `weekPlanComponents` line is what makes future
  eating-out actually remove ingredients — its test must assert the next-week case, or the
  feature silently half-works.
- **Shared vs solo.** Logging only one person for a shared meal leaves the other's ingredients
  on the list. Log both for shared.
- **Determinism unaffected** — this logs user actions; it does not change plan generation.
