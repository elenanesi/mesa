# Pantry / Fridge — build plan

**Status:** proposed, awaiting build. Decisions Q1–Q3 recorded below (approved 2026-07-19).

**Goal.** Elena and Andrea can tell Mesa what food they already have at home. As meals are
logged, what's left at home follows automatically. The shopping list then shows only what
they *don't and won't* have — computed from the initial set, the week's plan, and what has
actually been logged.

**Ground rules.** All of `PWA-MVP-plan.md` → "Ground rules for every agent task" apply
unchanged: deterministic numbers (every quantity computed, never typed in), no frameworks or
build step, visual parity with the locked design, iPhone Safari ≥44px targets, offline-first,
and verification in a real browser before reporting done. `node tools/check.js` must stay at
0 failed, and `node tools/build-sw.js` must run before every deploy.

---

## 1. The core design decision: derive, don't mutate

The obvious implementation is "when a meal is logged, subtract its ingredients from the
pantry". **Do not build that.** It breaks in four ways this codebase will hit immediately:

1. **Couple sync double-counts.** Both phones apply the depletion locally and then merge, so
   the item is subtracted twice. `weekPlans`/`logHistory` merges are convergent precisely
   because they merge *state*, not *deltas* — a mutating pantry would be a delta.
2. **Undo/skip/delete** each need a compensating add-back, and must stay consistent with
   `logHistory`'s tombstones and the v55 tombstone-clearing semantics.
3. **Backdated logging** (Week catch-up, task B5) applies out of chronological order.
4. It introduces a **second mutation path** that must be kept in step with the first forever.

Instead, persist only a **baseline** — "as of this instant, I have X of this food" — and
derive the rest:

```
pantryRemaining(foodId) = baseline(foodId).qty − consumedSince(baseline(foodId).setAt, foodId)
```

`consumedSince` is computed from `logHistory`, which is ALREADY the convergent, tombstoned,
sync-merged source of truth for what was eaten. Undo, backdating, cross-device sync and
duplicate suppression therefore all work **for free**, with no new invariants to maintain.
This is the same principle as the rest of Mesa: the stored thing is the input, the displayed
thing is computed.

### The leanness win

`computeShoppingList()` (planner.js) already decomposes meals into `{foodId, grams}`,
correctly handling batch yield (`r.servings`), `optionGroups` variants via
`recipeEffectiveIngredients()`, piece-vs-gram units, and meal extras. Pantry consumption is
**the identical operation** applied to logs instead of the plan.

P1 therefore extracts that decomposition into ONE helper with two callers. The feature makes
planner.js leaner rather than larger, and makes it structurally impossible for the shopping
list and the pantry to disagree about what a meal contains.

---

## 2. Data model

```js
// state.js — household-level, like SHARED/householdStyle (NOT per person)
let pantry = {};   // foodId -> {qty, setAt, u}
```

- **`foodId`**, not display name. `computeShoppingList` keys its output by `food.name` (a
  legacy wart — `checkedShopByWeek` is keyed by name too). Pantry keys by the stable id;
  P3 bridges the two rather than propagating the wart.
- **`qty`** is in the food's own unit basis, matching `computeShoppingList`'s convention
  exactly: pieces for `unit === 'piece'` foods, grams/ml otherwise. Subtraction is then
  direct, with no conversion layer.
- **`setAt`** is epoch-ms. It is both the depletion origin and the age hint (Q3).
- **`u`** is the per-entry sync stamp, same convention as `customFoods`/`customRecipes`
  entries, so the merge is newer-wins per entry (see §3, P1).

**Retention bound.** `LOG_HISTORY_RETENTION_DAYS` is 60 (log.js), so consumption older than
60 days is pruned and a baseline older than that would over-report what's left. In practice
baselines are re-set on every shop. P2's age hint makes a stale baseline visible; a P1 test
must pin this bound so nobody later assumes unlimited history.

---

## 3. Phases

Each phase is independently deployable and must be pushed + deployed before the next starts.

### P1 — Shared decomposition + state + sync (no UI)

**Files:** `app/js/planner.js`, `app/js/state.js`, `app/js/sync.js`, `app/js/render.js`
(backup validator only), `tools/check.js`.

1. **Extract the decomposition.** New helper in planner.js, e.g.

   ```js
   // components: [{recipeId, portion, opts} | {foodId, grams}]  ->  {foodId: qty}
   // qty is pieces for unit:'piece' foods, grams/ml otherwise — the same basis
   // computeShoppingList already emits and the pantry stores.
   function foodQuantitiesForComponents(components){ ... }
   ```

   Refactor `computeShoppingList()`'s `addRecipe`/`addFood` onto it. This must be a **pure
   refactor with zero behaviour change** — the existing shopping-list tests are the contract.
   Per the engineering rules: do not change shape and behaviour in the same step.

2. **Carry ids through the shopping list.** `computeShoppingList` keeps returning
   `totals[name] = {qty, unit}` but each row also gains `foodIds: [...]`, so P3 can subtract
   by id without touching the name-keyed `checkedShopByWeek` (no migration, no risk to
   existing checked state).

3. **State.** Add `pantry` to the module scope, `buildSnapshot()`, `loadState()` and the
   reset path. `loadState` deep-merges known keys over defaults, so a missing `pantry` is
   already safe — but validate on load: drop entries whose `foodId` is not in `FOODS`, or
   whose `qty` is not a finite number > 0. Add `pantry` to `validateBackupStructure()`
   (render.js:3716) and the export/import path.

4. **Sync.** Add `'pantry'` to `SYNC_SECTIONS` **and** to `MERGE_SECTIONS` (it must NOT be
   LWW — a concurrent edit on the other phone would be lost). Add `pantrySectionData()`,
   the `sectionData()` dispatch arm, the apply arm, and `mergePantrySection(local, remote)`:
   per-`foodId` newer-wins on `u`, following `mergeLibrarySection`'s doc block. Deletions
   need to propagate, so removing an item writes a tombstone (`qty: 0` with a fresh `u` is
   sufficient and simpler than a separate tombstone map — prove it converges in tests).

   **No backend work.** `worker/sync.js` treats section names generically
   (`Object.keys(parsed.sections)`), so no Worker deploy and no D1 migration are required.
   Confirm this rather than assuming it.

**Tests:** decomposition parity (the refactor produces byte-identical shopping lists for the
full two-week generated plan), unit handling for piece vs gram foods, `optionGroups` variants
and meal extras flowing through, pantry load-validation rejecting bad entries, and
`mergePantrySection` convergence — including order-independence and a delete that must not be
resurrected by a union merge (the bug class that caused the "×200 (imported)" incident).

### P2 — Derived remaining + Pantry page

**Files:** `app/js/planner.js` (or a new `app/js/pantry.js` if it exceeds ~150 lines — follow
the `log.js` precedent), `app/js/render.js`, `app/index.html`, `tools/check.js`.

1. **`pantryConsumedSince(sinceMs)`** — walk `logHistory` for **both** people, decompose each
   entry through P1's helper (`kind:'plan'` → `components`; `kind:'food'` → `ref` + `grams`),
   and sum per foodId. Both people's logs are summed: each logs their own portion, so a
   shared dish is correctly counted once per eater, matching `computeShoppingList`.
   Entries at or after `sinceMs` count; respect log tombstones.
2. **`pantryRemaining()`** → `{foodId: qty}`, floored at 0, never negative.
3. **Pantry page** at `#libraryPantry`, following the v44 "Library as real pages" pattern
   alongside `#libraryIngredients`/`#libraryRecipes`/`#libraryScanner`: list current items
   with remaining qty, an age hint ("set 9 days ago", Q3), add/adjust/remove via the existing
   stepper conventions (typeable, comma AND dot decimals, ≥16px inputs), and the ingredient
   icon treatment already used on the Ingredients page. **Do not auto-focus the search
   field** — README, iOS keyboard.

4. **Every manual edit RE-BASELINES.** This is the load-bearing rule of the whole page, and
   the one an implementer will get wrong. Any user-initiated change — increase, decrease, or
   set-exact — writes BOTH `qty = <the new remaining amount>` AND `setAt = Date.now()` (plus
   a fresh `u`), atomically.

   Why it must be atomic: `remaining = qty − consumedSince(setAt)`. If a user corrects
   spinach down to 100 g but `setAt` is left at the old value, the consumption that already
   happened since that old origin is subtracted a SECOND time and the page shows less than
   100 g — an obvious-looking bug with a non-obvious cause. Re-basing `setAt` sets consumption
   back to zero for that food, so what the user typed is exactly what they see.

   This is what makes the derived model correctable rather than authoritative: whenever
   reality and the derivation disagree — food went off, some was used without logging, a
   guest ate it, the estimate was simply wrong — the user overrides reality in one action and
   the derivation restarts from there. Deleting an item is the same operation at qty 0
   (written as a `qty: 0` tombstone with a fresh `u` so the delete propagates through sync
   instead of being resurrected by the merge).

   Both actions must be reachable directly from each pantry row — a decrease stepper and a
   remove control — not buried behind an edit sheet. Correcting a wrong quantity is the most
   frequent interaction this page will have.

**Tests:** consumption derived correctly across both people; an undone/deleted log entry
restores the remaining quantity with no compensating write; a backdated entry is counted;
remaining never goes negative; the 60-day retention bound is pinned. **Re-baselining is
explicitly tested:** log consumption against a food, manually correct it downward, and assert
the displayed remaining equals exactly what the user set (proving the pre-edit consumption is
not double-subtracted); assert a delete propagates through `mergePantrySection` and is not
resurrected.

### P3 — Shopping list subtraction

**Files:** `app/js/planner.js`, `app/js/render.js`, `tools/check.js`.

1. **Q1 — stop counting eaten meals.** `computeShoppingList` currently sums the WHOLE week
   including days already logged. For the current week it must count only slots not yet
   logged or skipped (reuse `slotLogStatus()`; do not re-derive). Next week is unaffected.
   This is a visible change to the current-week list and needs its own tests.
2. **Subtract the pantry.** `need = planned − pantryProjected`, floored at 0; rows that reach
   0 drop off the list entirely. Show what was covered (e.g. "have 400 g") rather than
   silently vanishing an item — silent disappearance is indistinguishable from a bug.
3. **Projection for next week.** The pantry will be partly eaten by the *rest of this week*,
   so next week's list must subtract only the projected leftovers: project the current
   pantry forward through this week's remaining plan first, then apply the remainder to next
   week. Name this explicitly in the code; it is the subtlest part of the feature.
4. **Q2 — restock action.** An "Add ticked items to pantry" button on the shopping sheet,
   stocking ticked rows at their listed quantities and stamping `setAt`/`u`. Ticked stays a
   separate concept from in-stock; ticking alone changes nothing.

**Tests:** a fully-covered item disappears; a partially-covered item shows the reduced
quantity; the current-week list ignores already-logged meals while next week does not;
next-week projection subtracts only leftovers; the restock action writes correct quantities
and sync stamps.

---

## 4. Decisions (approved 2026-07-19)

- **Q1 — already-logged meals:** the current-week shopping list counts only meals not yet
  eaten or skipped. Accepted that this changes the current-week list independently of the
  pantry.
- **Q2 — restock:** explicit "Add ticked items to pantry" action. Ticking an item does NOT
  implicitly stock it.
- **Q3 — perishables:** age hint only ("set N days ago"). No expiry dates, and no
  category-inferred shelf life — inventing decay rates would violate the "computed, never
  typed in" rule. The age hint is deliberately paired with direct decrease/remove controls
  on every row (P2 step 4): rather than Mesa guessing when food went off, it shows how old
  the number is and makes correcting it a one-tap action.

## 5. Non-goals (this build)

Expiry/use-by tracking; barcode scanning directly into the pantry (the scanner stays a
library-ingredient flow); quantity units beyond the food's own basis; per-person pantries;
any D1 or Worker change.

## 6. Risks

- **The P1 refactor is the risky step**, not the new feature. `computeShoppingList` is
  load-bearing. It must land as a pure refactor proven byte-identical against the existing
  suite before any pantry logic is layered on.
- **Stale baselines** are the main way this feature misleads in daily use. The age hint is
  the mitigation; if it proves insufficient, revisit expiry rather than inventing decay.
- **Q1's change is visible.** If the current-week list looks "wrong" after P3 ships, suspect
  the logged-meal exclusion before the pantry maths.
