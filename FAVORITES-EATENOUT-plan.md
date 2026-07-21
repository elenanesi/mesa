# Stronger favorites + Eaten-out logging — build plan

**Status:** BUILT and deployed 2026-07-21 (item 2 ae08648, item 3 d5ed180; sw CACHE mesa-42d1767cb7fa). Item 1 needed no code (already occasional). Decisions in §4.

Two independent features from a three-item request. **Item 1 (block junk food from planning)
needs no work** — Chinese dinner (`cena-cinese`), McDonald's (`mcdonald-menu`), Burger King
(`burger-king-menu`), French fries (`fast-food-fries`) and Chinese spring rolls
(`spring-rolls`) are all already `occasional: true`, which `candidatesFor()` (planner.js)
excludes from automatic planning. Verified no unflagged junk leaks through. Not built.

---

## Item 2 — favorites the planner actually prefers

**Problem (measured, not assumed).** A ❤️ favorite already gets a flat `+35` in `mealScore`
(planner.js), but favoriting a recipe barely changes its usage: measured 1→2 and 2→2 per
week for three test favorites. Two causes:
1. `mealScore`'s kcal-fit term is `-(kcalErr * 1000)`, so a modestly better-fitting rival
   outscores the +35 boost.
2. VARIETY-plan.md P2's weekly cap (`WEEKLY_RECIPE_CAP`, full/main 2) caps a favorite at the
   **same** ceiling as everything else — so even when it wins, it can only appear twice.

**Decision Q1: higher cap + bigger boost.** A favorite should show up noticeably more, while
still bounded by P1's no-same-day rule and a sane weekly limit.

- **Raise the cap for favorites by +1**, in `weeklyCapForRecipe(id)` (the one place caps are
  read). A favorited full/main goes 2→3, a favorited side 3→4. Implement by adding 1 when
  `recipePref(id) === 'favorite'`, not by duplicating the cap table.
- **Raise the boost** enough to reliably win realistic ties but stay clearly BELOW the
  kcal-fit scale, so it never distorts the calorie/protein targets the plan promises. The
  existing `+35` sits between `tuningBonus` (15) and the kcal term (up to ~1000). The right
  value is an EMPIRICAL question, exactly like TUNING_WEIGHT was — do not guess it. Sweep
  candidate values, measure favorite usage across a fortnight, and pick the smallest value
  that makes a favorite reliably reach its (raised) cap without a favorited recipe with a
  poor kcal fit crowding out a much better-fitting non-favorite. Record the chosen value and
  the sweep, as the TUNING_WEIGHT doc block already does.
- **Do NOT let favorites break the caps that keep variety sane.** The point of the +1 cap is
  "a bit more", not "every slot". Confirm a week where several recipes are favorited does not
  collapse to just those — the day-wide rule (P1) and the raised-but-finite cap must still
  bound it. A `side` favorite at cap 4 against a ~13-recipe in-season side pool is fine; a
  `full` favorite at cap 3 against a 24-recipe pool is fine.

**Determinism.** The planner is deterministic and load-bearing. Same inputs → same week; the
harness's determinism tests are the contract even as output changes.

**Tests:** favoriting a recipe measurably raises its planned count vs unfavorited (same seed);
a favorited full/main can reach 3/week where an unfavorited one caps at 2; favorites still
never repeat same-day (P1) and a many-favorites week does not collapse to only favorites;
the boost value is a named constant, documented; determinism preserved.

---

## Item 3 — "eaten out" (delivery / restaurant)

**The key realisation:** most of this already works. A LOGGED meal is already excluded from
the shopping list (`weekPlanComponents(plan, /*excludeLogged*/ true)` in
`computeShoppingList`). It is only still counted against the **pantry**
(`pantryConsumedSince` in pantry.js walks every logged `kind:'plan'` and `kind:'food'`
entry). So "eaten out" is: a flag on a log entry that (a) keeps its kcal/macros in the day's
totals but (b) stops it depleting the pantry. The shopping-list exclusion it gets for free by
being logged.

**Decision Q2: applies to planned meals AND quick-adds** — any logged item.

**Model.**
- A log entry (both `kind:'plan'` and `kind:'food'`) may carry `eatenOut: true`. Absent/false
  = eaten from home stock, today's behaviour, byte-identical.
- Nutrition is UNCHANGED: `logEntryNutrition` still counts it, so Today/Log/Insights totals
  and the day's kcal are exactly as now. Eaten-out is about provisioning, not calories.

**pantry.js — the one behavioural change.** `pantryConsumedSince` skips entries with
`eatenOut === true`. That is the whole depletion fix: an eaten-out meal no longer reduces
`pantryRemaining()`, so the food you didn't cook stays "in stock".

**Shopping list — verify, likely no change.** Marking a *planned* meal eaten-out means logging
it, which already drops it from the current-week list. Confirm this holds and add a test;
do not add a second exclusion path.

**Toggle path (state + sync).** Toggling `eatenOut` must go through a mutator that re-stamps
the entry's `u` (like every other log edit), so `mergeLogSection` treats the change as newer
and it converges across the couple's phones. Do NOT hand-edit the entry without bumping `u`.
A no-op-safe helper, e.g. `setLogEntryEatenOut(dateISO, personKey, index, value)`.

**UI.** The "Today so far" (`renderTodaySoFar`) and "Today records" (`renderTodayRecords`)
lists already render every logged entry with per-row controls and are derived from
logHistory on every call. Add a small per-row toggle there — a 🏠/🍴 (home vs eaten-out)
control, or an entry in the existing edit sheet (`openEditTodayRecord`). An eaten-out row
should read as such at a glance (e.g. a "🍴 out" pill), since its absence from the shopping
list is otherwise invisible. Follow the delegated-listener / `data-*` conventions, not
inline-onclick interpolation of user content. ≥44px targets.

**Tests:** an eaten-out logged meal keeps its kcal in the day total but is absent from
`pantryConsumedSince`, so `pantryRemaining()` does not drop for its ingredients; an eaten-out
quick-add likewise does not deplete the pantry; a planned meal marked eaten-out is absent from
the current-week shopping list (already true by being logged — asserted, not newly coded);
toggling eaten-out bumps `u` and survives a `mergeLogSection` round-trip; toggling it off
restores depletion.

---

## 4. Decisions

- **Q1 — favorite strength:** higher weekly cap (+1 for favorites) AND a bigger, empirically
  chosen score boost. Still bounded by no-same-day and the raised-but-finite cap.
- **Q2 — eaten-out scope:** any logged item — a confirmed planned meal or a quick-added
  food/snack. Keeps nutrition, drops from shopping list and pantry depletion.
- **Item 1:** already handled by `occasional`; not built.

## 5. Sequencing

Item 2 (planner.js only) then item 3 (log.js / pantry.js / render.js), each with its own
tests, pushed and deployed separately. Neither needs a Worker/D1 change: item 2 is pure
scoring, item 3 rides the existing `log:*` sync section (the new field travels inside the
entry object the section already syncs).

## 6. Risks

- **Item 2 distorting targets.** A boost above the kcal-fit scale would start choosing
  worse-fitting favorites and break the "same calories and protein" promise. The empirical
  cap keeps it below that scale — the sweep must confirm the calorie/protein fortnight tests
  still pass, not just that favorites appear more.
- **Item 3 double-exclusion.** The shopping-list drop already comes from being logged; adding
  a second, `eatenOut`-driven exclusion there would risk removing an unlogged planned meal
  from the list, which is wrong. Keep the shopping-list path as-is and only change the pantry.
- **Determinism / existing plans.** Item 2 changes newly generated weeks, not pinned/logged
  meals already in place.
