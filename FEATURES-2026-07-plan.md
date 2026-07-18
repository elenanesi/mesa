# Features batch plan — 2026-07 (goal fix, meal roles, week-level sides/summaries/logging)

Owner: Elena. Execution follows the Mesa agent workflow (Sonnet agents, one batch per
agent, `node tools/check.js` green + real-browser verification before "done", sw.js via
`node tools/build-sw.js`). Ground rules in `PWA-MVP-plan.md` apply to every task —
especially: deterministic numbers, no frameworks/build step, visual parity, ≥44px targets.

Recommended batch order (small/isolated → large): **B1 → B5 → B4 → B3 → B2.**
B2 (meal roles) is last because it touches data + planner scoring; everything else is
independent of it. B3 is sensibiy done after B2 (sides UI gets richer once roles exist)
but works standalone against today's `'side'`-slot recipes if reordered.

---

## B1 — Profile goal toggles become real (fix: removing "lose weight" doesn't update calories)

**Bug root cause.** The Profile "goals" checklist (index.html ~510-514) calls `tog(this)`
(render.js) which only toggles a ✓ class — no state, no persistence, no recompute. The
calorie deficit lives in `PROF[key].goalAdj` (elena −325, partner +60), a constant that
`PERSIST_PROFILE_FIELDS` deliberately excludes. So unchecking "Gentle fat loss" changes
nothing: `recommendedCal = round10(maintenance + goalAdj)` still applies −325.

**Design.** Make all five toggles real, not just the calorie one (half-wired toggles are
how this bug happened):
- New persisted per-profile field `goals` (object of booleans):
  elena: `{fatLoss, muscle, heart, skin, hashi}` defaults all true;
  partner: `{muscleGain, heart}` defaults true. Add to `PERSIST_PROFILE_FIELDS`
  (array-of-fields loop already handles non-scalar via the `avoid` precedent) — additive
  with defaults matching today's behavior, so **no store-version bump** (repo convention),
  and it rides the existing per-person `profile:*` LWW sync section for free.
- `goalAdj` becomes DERIVED in engine.js: `deriveGoalAdj(p)` = (elena) `goals.fatLoss ? -325 : 0`;
  (partner) `goals.muscleGain ? +60 : 0`. `recomputeProf()` calls it; delete the constant.
  `goalName`/`goalTag` and the calories-explainer line (render.js ~2056) derive from the
  same booleans ("at maintenance" when the calorie goal is off).
- Downstream consumers switch from hardcoded checks to the booleans:
  `PROF.elena.hashi` stays as a mirrored convenience but is set from `goals.hashi`;
  whyText's skin rule (`profKey === 'elena'`) reads `goals.skin`; Insights' selenium
  tracking already reads `.hashi` (works once mirrored).
- Toggle handler: replace cosmetic `tog(this)` on these five with a real
  `toggleGoal(profKey, goalKey, el)` → mutate → `recomputeProf` → `applyProf` refresh →
  `persist()` → `scheduleMenuRebuild()` (same path a weight change takes, so the week
  plan's future days re-target; past/logged days protected by existing guards).
- Interplay with manual calorie override: unchanged — `calCustom` still wins while set;
  the recommendation line under it updates.

**Tests (tools/check.js).** `deriveGoalAdj` per combination; toggling fatLoss off ⇒
`recommendedCal === round10(maintenance)`; persistence round-trip of `goals`; whyText
skin/hashi clauses follow the booleans.

**Verify in browser.** Profile → uncheck Gentle fat loss ⇒ daily target rises ~325 (1,820
→ ~2,140s rounded to 10) immediately in header/ring/macro rows; recheck ⇒ restores; state
survives reload; Andrea unaffected.

---

## B2 — Recipe roles: full meal / main course / side, and composed planning

**Current behavior.** `generateWeek()` picks exactly ONE recipe per slot; recipes flagged
`'side'` in `slots` (17 today) only enter plans via re-balance suggestions
(`addSideToPlan`) or manual extras. So the plan "prefers full meals only".

**Design decisions.**
1. New recipe field `role: 'full' | 'main' | 'side'` — orthogonal to `slots` (slots say
   WHEN, role says HOW IT COMPOSES). Required on every recipe (validate.js enforces enum +
   presence, forcing a deliberate tagging pass over all built-ins; heuristic first pass:
   current side-slotted recipes → 'side' unless clearly standalone; salads/one-pot bowls →
   'full'; plain-protein dishes → 'main'). Custom recipes: role picker in the builder
   (default 'full'); `deriveRecipeMeta` untouched otherwise. Additive → no store bump;
   role rides library sync + D1 `data_json` automatically (README lesson: built-in changes
   need Pages deploy AND a D1 seed/readback — include in the batch's deploy checklist).
2. Foods gain `breakfastPair: true` on an explicit whitelist (breads/bakery suitable at
   breakfast + fruit — fruit is NOT currently distinguishable from vegetables inside
   `cat:'Produce'`, hence explicit flag rather than category inference; also add it to the
   library ingredient form as a checkbox so custom foods can participate).
3. **Composition emits extras** — no new plan-cell shape. A composed lunch/dinner is
   `{recipeId: <main>, extras: [{recipeId: <side>, portion: p}]}`; a composed breakfast is
   `{recipeId: <light main>, extras: [{foodId, grams}]}`. This reuses ALL existing
   machinery (nutrition, Today/Log titles "X + Y", shopping aggregation, couple-sync
   stamps, logging freeze) — verified live since v29/v38. Swap/pin/routine keep operating
   on the main; removing/editing the side uses the existing extras editors.
4. Planner algorithm (lunch/dinner, shared + solo paths):
   - Candidate units = every `role:'full'` recipe (as today) ∪ (main × side) pairs.
   - Pair pruning for determinism + speed: for each main, consider only the top-K (K=4)
     sides by |main kcal + side kcal − desired| computed at portion 1, iterated in sorted
     id order with the existing `1e-9`/lexicographic tie-breaks. Score the COMBINED
     nutrition through the existing `mealScore`; portion search (`bestPortion`) applies to
     the main, side stays at fixed portion steps {0.5, 1} evaluated both ways.
   - No artificial bias for either shape: the score decides ("attempt to use" ≠ "force").
     If Elena wants combos favored, a small deterministic bonus term is a one-line tune —
     ship neutral first, tune after a week of real plans (open question Q1).
   - Breakfast: mains with `role:'main'` (light) pair with one `breakfastPair` food;
     grams chosen from the food's natural step (piece foods: 1 piece via `avgG`; else 30g
     steps) that best fills the slot target. `role:'full'` breakfasts stay standalone.
   - Variety: main history unchanged; add a parallel light history for sides (avoid the
     SAME side two days running; window 2 vs the mains' stronger rule) and include side
     ids in the cross-week comparison only at the main level (keep it simple).
5. kcal-band validation (validate.js): bands keep applying to `role:'full'` recipes per
   slot; `main`/`side` get a WARNING-level plausibility band only (main 250–650, side
   60–300) so the composed unit, not the bare main, is what must land in the slot band —
   enforced by a new check.js test over generated plans instead.

**Tests.** Generation determinism unchanged (fixed date ⇒ identical plans); every
composed unit's total kcal within slot band ± tolerance; sides come only from
`role:'side'`, breakfast pair foods only from the whitelist; avoid-lists respected for
BOTH components; extras shape round-trips persist/sync merge (reuse existing
extras tests); validate.js still `ok:true` after the tagging pass.

**Verify in browser.** Regenerate next week ⇒ see a mix of full meals and "Main + side"
rows (title shows "X + Y"); shopping list includes side ingredients; swap on a composed
meal swaps the main and keeps/offers sides; logging a composed meal freezes combined
macros; breakfast shows e.g. "Skyr bowl + 1 pear".

**Effort note.** This is the big one: data pass over ~100 recipes + planner surgery.
Isolate the tagging pass (mechanical, reviewable via validate output) from the algorithm
change (its own agent) if run as two agents.

---

## B3 — Sides add/edit at week level

**Current.** The add/edit-extras sheet (`openAddMealRecipeSheet(slot, dateISO)`) is
reachable only from Today/Log card contexts; Week rows offer pin/routine/swap only.

**Design.**
- Refactor the sheet's context to the explicit shape the swap sheet already uses:
  `{weekStartDate, dayIndex, slot, person}` (replacing its internal reliance on
  `currentLogDateISO()`-style ambient date), with `dateISO` derived from the plan day.
  Logged-vs-plan behavior keys off `dateISO <= todayISO()` + `slotLogStatus` exactly as
  now — for future dates it is automatically plan-only.
- Week rows get a fourth action button `＋` (data-act="extras", following the existing
  delegated `#weekList` handler pattern — most-specific-first, data-* only) opening that
  sheet for the row's meal, on BOTH This week and Next week. Rows with extras show the
  same "+ side" affix they already show via `mealTitleWithExtras` (no new display work).
- Re-render on close: `renderWeek()` + `refreshAfterLogChange()` when the date is
  today/past-logged (existing helpers).
- 44px targets: 4 buttons per row is the iPhone limit — reuse the pin button's compact
  style; verify on the 375px viewport.

**Tests.** Context refactor covered by existing extras tests (they call the planner
mutators directly); add one: adding an extra to a NEXT-week meal stamps/mirrors correctly
and survives `ensureWeekPlan` re-validation (no signature reset — v22 guarantee).

**Verify in browser.** Add a side from a next-week row; toggle to This week and back
(persists); add to a past logged day ⇒ updates the eaten record path (v-consistency
behavior); mobile viewport tap targets OK.

---

## B4 — Day + week nutrient/fiber summary (This week AND Next week)

**Current.** Day headers show kcal only; week level has the one-line accomplishment
summary (`summarizeWeekPlan`) and Insights-only coverage chips (`computeWeeklyCoverage`).

**Design.**
- Extend `displayedSlotViewForDate`'s returned view with the macro totals it already
  computes internally (protein/carbs/fat/fiber/sugars via `planEntryNutrition`/frozen log
  values — extras included since the consistency batch), so `renderWeek` can SUM per day
  without recomputing: expanded day shows a compact line under the header —
  `P 142g · C 180g · F 60g · fiber 31g · sugars 38g` (current profile, matching the rest
  of the Week screen's per-person framing; sugar metric/label matches Insights' existing
  sugar-tracking convention).
- Week-level card above the day list (both weeks): per-day averages of kcal/P/C/F +
  fiber vs the 25g/day target + the two headline coverage chips (omega-3 meals, satFat
  share) — all from ONE pass reusing `dailyTotalsForPlan`/`computeWeeklyCoverage` given
  the displayed week's plan. Current week sums the LOGGED overlay view (what the rows
  show); next week sums the plan — same numbers the user sees, no divergence.
- Style: reuse Insights' `renderNutrientChips` chip styling (no new CSS concepts);
  numbers via the existing computed helpers only.

**Tests.** Day summary equals the sum of that day's slot views (harness-computable with
a fixed date + seeded logs, including an extras case and a logged-overlay case); week
averages equal sum/7; fiber target constant single-sourced (reuse
`WEEK_SUMMARY_THRESHOLDS.fiberMinPerDay`, don't re-type 25).

**Verify in browser.** Expand days on both weeks; confirm a meal today ⇒ today's day line
and the week card shift accordingly; numbers cross-check against Insights for the same
day.

---

## B5 — Catch-up logging from the Week view (current week)

**Intent.** "I didn't have time to log on Tuesday; on Thursday I open Week and mark what
I actually ate." Logging is currently reachable only for Today/Yesterday (Log screen
toggle), though the underlying API (`logPlanEntry(dateISO, …)`, `markSlotSkipped`,
`slotLogStatus`) is already fully date-generic and backdated corrections are already
legitimate (v55/v56).

**Design.**
- On the CURRENT week only, for rows whose `day.date <= todayISO()`: add a log-state
  button per meal row — `◯` unlogged / `✓` confirmed / `∅` skipped (data-act="log",
  delegated handler as usual; hidden on next week and future dates).
- Tap opens a mini action sheet for that (date, slot, person=current profile):
  **Eaten as planned** → `logPlanEntry(dateISO, person, slot, recipeId, portion,
  components)` with `t: null` (backdated — unknown eating time; `u` stamp = now so
  couple-sync ordering is correct; follow the migrateV1 precedent for `t: null`),
  **Skipped** → `markSlotSkipped`, **Undo** (shown when already logged/skipped) →
  `removeLoggedSlot`. Shared meals still log per person — same semantics as the Log
  screen.
- Target snapshot caveat (document in-code): `ensureTargetSnapshot` freezes TODAY's
  target for the backdated day if that day had no logs yet — same behavior Yesterday
  logging already has; acceptable, not new.
- Refresh: `refreshAfterLogChange()` + `renderWeek()`; day summary (B4) and Insights
  7-day bars update immediately.
- Row count pressure: this is a FIFTH row button on current-week past rows. Layout
  decision: show the log button in place of pin/routine on PAST rows (pinning/routining
  the past is meaningless — pins on past dates are already ignored by re-balance), so
  rows never exceed 4 buttons. (Open question Q3 if Elena prefers otherwise.)

**Tests.** Backdated confirm writes `logHistory[pastDate]` with frozen macros +
tombstone clears; skip then undo round-trips; regeneration/re-balance still preserves
the newly-logged past slot (existing guard tests extended with a backdated case);
`t === null`, `u` fresh.

**Verify in browser.** Set up: confirm nothing on a past weekday; from Week, mark its
lunch eaten ⇒ ✓ appears, Insights bar for that day fills, Log screen (if switched to
that date via Yesterday where applicable) agrees; skip its snack; undo both.

---

## Cross-cutting

- **Store/schema:** all additive with safe defaults — no `CURRENT_STORE_VERSION` bump.
  Sync: `goals` rides profile LWW; `role`/`breakfastPair` ride library/catalog paths.
  D1: after B2's built-in tagging, deploy Pages AND seed/readback D1 global rows (README
  lesson from the icon batch).
- **Deploy:** per batch or at the end — `node tools/check.js` green → `node
  tools/build-sw.js` → commit/push → Pages deploy (+ D1 seed for B2).
- **Decisions (Elena, 2026-07-17):**
  - **Q1 (B2):** combos compete on EQUAL scoring with full meals — no bias term.
  - **Q2 (B2):** breakfast pairing whitelist approved as proposed: breads
    (rye/wholewheat/white) + fruit (apples/pears/bananas/oranges/peaches/berries).
  - **Q3 (B5):** confirmed — on past days the log button replaces pin/routine.
  - **Q4 (B4):** day AND week summaries include sugars alongside P/C/F/fiber. Use the
    same sugar metric/label the existing sugar-tracking feature already displays on
    Insights (match its total-vs-free convention; don't invent a second one).

---
---

# Batch C — 2026-07-18 (Insights cleanup, goal tuning, week-count fix)

Same execution rules as Batch B. Order: **C3 → C1 → C2** (bug-fix first, then UI
cleanup, then the planner-touching feature). All three touch render.js — run
sequentially.

## C3 — Week screen must count everything LOGGED, not just planned meals (bug fix)

**Confirmed diagnosis.** `computeInsights` (planner.js) iterates ALL of
`getDayLog(date)[person]` — kind:'plan' AND kind:'food' — so Insights already counts
quick-adds (cappuccinos, gelato, beverages). Today's ring likewise (recomputeConsumed).
But B4's `weekDayNutriViews` (render.js) sums ONLY the four slot views from
`displayedSlotViewForDate`, so kind:'food' quick-add entries never reach the Week
screen's day macro lines or the week average card.

**Fix.** In `weekDayNutriViews`, for CURRENT-week days with `date <= todayISO()`, add
`logEntryNutrition(e)` for every `kind:'food'` entry in that day's log for the current
profile (slot views already handle kind:'plan' overlay + skips — do not touch them; no
double count possible since quick-adds are never slot views). Next week / future days:
unchanged (no logs exist). The day header kcal (`renderWeek`'s dayKcal) must use the SAME
summed totals so the header and the macro line can't diverge — restructure so both read
one source. Show quick-adds' presence honestly: if a day has quick-add entries, append a
small `+ N logged extras` note to the day's macro line (count only, no list — keep the
row compact).

**Tests.** Fixture: log 2 quick-add foods (one via logFoodEntry, one beverage-style) on a
past current-week day ⇒ that day's weekDayNutriViews totals = slot-view sum + the two
entries' logEntryNutrition; week card average shifts by exactly that amount / 7; next
week unaffected; a test asserting Insights' computeInsights day kcal INCLUDES quick-adds
(regression-documenting the already-correct behavior).

**Verify in browser.** Quick-add a cappuccino + a gelato today; Week day line and week
card rise by their kcal; day header matches Today's consumed count for the same date;
next week untouched.

## C1 — Insights page cleanup + per-day nutrient bands

1. **Delete** the static "Last week in one minute" card (index.html — hardcoded mockup
   content: fake wins + a toast-only "Plan next week" button; nothing computes it).
2. **Rename** the "What's working" section header to **"Insights"** (keep the ✓ icon and
   `#insightsWorking` card contents — the computed callouts stay unchanged).
3. **Per-day nutrient bands**: extend `computeInsights` per-day sums with `carbs` and
   `freeSugars` (kind-agnostic, same loop). New card (replacing the deleted one's slot,
   above the stat tiles) showing, for the last 7 days, one row per metric — protein,
   carbs, fat, fiber, free sugars — each as 7 mini-bars vs its ideal band:
   protein/carbs/fat: person's targetP/targetC/targetF ±10% (same tolerance the kcal
   in-band check uses); fiber: ≥ WEEK_SUMMARY_THRESHOLDS.fiberMinPerDay; free sugars:
   ≤ the existing 6%-of-kcal target via `coverageGaps`' constant (never re-type 25 or 6).
   Bars reuse the existing `#insightsBarsCard` 7-day bar pattern/styles; unlogged days
   render empty exactly as the kcal bars do. In-band / over / under states use existing
   colors (sage / terra) — no new palette.

**Tests.** computeInsights days now carry carbs/freeSugars summed over all entry kinds;
band classification per metric (craft one day per state); constants are referenced, not
re-typed (source-grep guard like B4's).

**Verify in browser.** Bands card renders 5 rows × 7 days for both profiles; a logged
high-sugar day shows the sugars bar over-band in terra; deleted card gone; renamed header
shows "Insights"; zero console errors.

## C2 — "Tune next week" toward a user-selected goal (replaces the fake Mesa-coach banner)

**Delete** the static banner ("Weekly review · powered by Mesa coach ✨ … tuned for
skin?") and its toast-only "Tune next week" button. In their place, a real card:

- **State**: household-level `nextWeekTuning: 'none' | 'protein' | 'fiber' | 'lowSugar' |
  'lowSatFat' | 'omega3'` (default 'none'). Persisted in the store; rides the `plans`
  sync section next to householdStyle/SHARED (LWW) — add to plansSectionData/
  applyPlansSectionData; folded into `computePlanSignature` so changing it regenerates
  FUTURE days (existing preserve guards protect past/logged/pinned slots).
- **Planner**: a small deterministic secondary term in unit scoring —
  `tuningBonus(unitTotals, tuningKey)` added into mealScore's comparison with a weight
  low enough that kcal/protein fit still dominates (the old banner's promise — "keeping
  your calories and protein identical" — is the spirit: nudge selection among
  similarly-fitting candidates, don't distort targets). protein: +protein density;
  fiber: +fiber; lowSugar: −freeSugars; lowSatFat: −satFat share; omega3: bonus if the
  unit's recipes carry the omega3 flag/tag (reuse recipeFlagSet/hasTag helpers). 'none':
  zero term — and the scoring path must be BIT-IDENTICAL to today when 'none' (the
  planner determinism tests pin this).
- **UI on Insights**: chip picker (6 chips incl. "No tuning"), one-line computed
  explanation per goal (fixed copy, no free text), current selection highlighted;
  selecting persists + toasts + regenerates next week via the signature path. Copy must
  not promise identity ("nudges next week's picks toward …").

**Tests.** signature changes when tuning changes; 'none' ⇒ generated plan byte-identical
to pre-C2 output (determinism test must NOT need re-fixturing for the default);
'protein' ⇒ generated fortnight's avg protein ≥ the 'none' plan's (weak monotonic
assertion — the nudge must at least not hurt the goal); same weak assertion for fiber
and (≤) freeSugars; tuning survives the plans sync-section round-trip.

**Verify in browser.** Pick "More fiber" ⇒ toast, next week regenerates (visible row
changes), Week card fiber avg ≥ before; pick "No tuning" ⇒ regenerates back; past/logged
days untouched; selection survives reload; zero console errors.

## Decisions taken without asking (flag if wrong)

- Tile rename: "What's working" → **"Insights"** (Elena: "insights or something like
  that").
- Tuning goal set: protein / fiber / less free sugar / less saturated fat / omega-3 /
  none. Skin/thyroid framing intentionally NOT offered as goals — they map to omega-3 /
  lowSugar already, and medical-adjacent copy stays out (ground rule).
- Tuning is household-level (plans are shared), not per-person.

## C4 — Ingredient detail page (added 2026-07-18)

Tapping an ingredient ROW in Library → Ingredients (anywhere except its ✎/↺/✕ action
buttons) opens a detail PAGE on the ingredients screen (same setIngredientsScreenHtml
pattern the edit form uses), with a ← back to the list preserving search/filter state.
Contents: the watercolor image large (~112px vs the 44px list icon; same
foodIconHtml/iconAsset source, default icon fallback included); name + badges (yours /
edited / category / season / breakfast pairing); nutrition per the food's own basis
(per-100g/ml or per-piece with avgG shown) — kcal, protein, carbs, fat (good/sat split),
fiber, sugars + free sugars + sugar-quality label; flags as pills (existing
flagLabel vocabulary); barcode-import metadata when present (brand, quantity, label
kcal, Nutri-Score/NOVA, allergens/traces, ingredient text, source link — all
escapeHtml'd, the URL attr-escaped and https-only); the `src` citation line for
built-ins. Actions on the page: ✎ Edit (existing openEditFoodForm), ↺ Reset override
(if edited), ✕ Delete (if custom) — reusing the existing handlers, then returning to
the list (delete) or edit form. Detail applies ONLY to the Library ingredients list —
quick-add search rows and the recipe-builder picker keep their select-on-tap behavior.
Numbers come from the live merged FOODS record (overrides included) — never re-typed.

Tests: detail markup builder returns escaped name/brand for a hostile-named custom food;
per-piece food shows per-piece basis with avgG; built-in vs custom vs edited action sets;
non-https source URL dropped. Verify in browser incl. hostile-named ingredient, an
edited built-in, a barcode-imported food if present (else create-shaped fixture), and
mobile 375x812.

## C5 — Icon picker for custom ingredients (added 2026-07-18)

The new/edit ingredient form gains an "Icon" section: current selection preview (the
generic default until chosen) + a "Choose icon" control expanding a tappable grid of the
EXISTING watercolor icons. The available set is derived at runtime from built-in FOODS
records' iconKey values (unique, sorted, resolved via the existing
safeIngredientIconKey/ingredientIconAssetForFood helpers — no hardcoded asset list, no
new manifest), plus an explicit "Default" tile. Picking one sets `iconKey` on the custom
food (same field built-ins use), so the list row, detail page, quick-add and shopping
render it with ZERO renderer changes; it rides library sync + D1 data_json automatically
(catalogPayloadSignature already includes iconKey). Works for barcode-imported foods via
the edit form too. Grid tiles ≥44px, delegated handler with data-icon-key (values come
from FOODS but pass through safeIngredientIconKey anyway), form state round-trips
new→save→edit→reset. No auto-matching by name (non-deterministic guesswork — future).

Tests: picker vocabulary = unique built-in iconKeys; save persists iconKey and the list/
detail builders emit the chosen asset; edit round-trip preserves it; clearing back to
Default removes the field; sync section round-trip keeps it.

---
---

# Batch D — 2026-07-19 (recipe options/variants, sauce role, catalog additions)

Executed on branch `claude/recipe-options` (worktree /private/tmp/mesa-recipe-options)
because a codex agent concurrently works recipe images on `codex/ingredient-icons` —
merge to main only after green, rebasing on latest origin/main. Do NOT touch recipe
`imageKey` fields or app/assets/recipes/ (the codex agent's surface); new recipes ship
WITHOUT imageKey (slot defaults cover them).

## D1 — Recipe options (variants) for mains/full meals

**Model.** A built-in recipe may declare:
`optionGroups: [{key, label, choices: [{id, label, ingredients: [[foodId, grams], ...]}, ...]}, ...]`
- `recipe.ingredients` stays the BASE (common) list; the recipe's effective ingredients =
  base + the chosen choice's list per group. FIRST choice = deterministic default.
- One shared helper `recipeEffectiveIngredients(recipe, opts)` is the single source for
  nutrition, shopping, display and validation (`opts` = {groupKey: choiceId}, missing/
  invalid keys fall back to the default choice).
- `recipeNutrition(id, servings, opts?)` gains an optional third param (all existing
  call sites unchanged ⇒ default combo). Plan entries and log components gain an
  additive `opts` field; `planEntryComponents`/`nutritionForRecipeComponents`/
  `computeShoppingList` thread it through. Log freeze already goes through components ⇒
  a confirmed meal freezes the chosen variant's macros.
- Titles: when a recipe has optionGroups, display titles append the chosen labels,
  e.g. "Baked fish (sea bass)" — one helper used by Today/Week/Log title paths.
- **Planner**: per pick, the choice is rotated deterministically (weekSeed + dayIndex +
  slotIndex modulo the ALLOWED choices, sorted by choice id) — variety across the week
  with zero randomness. A choice is allowed only if its ingredients pass the relevant
  avoid-list(s) (both people for shared slots); zero allowed choices ⇒ the recipe drops
  from that pool. Recipes without optionGroups: bit-identical behavior (determinism
  tests must pass without re-fixturing).
- **Recipe screen**: a chip row per group (existing chip styles) under the header;
  changing a chip recomputes the grid/ingredient rows live and writes back to the
  plan/log context exactly like the servings stepper does (markWeekPlanEdited + logged
  entry correction); from library origin it just previews.
- **Scope cut (v1)**: custom-recipe builder does NOT author optionGroups (built-ins
  only); swap sheet shows base titles; re-balance treats recipes at their planned opts.
- validate.js: optionGroups structural checks (unique keys/ids, ≥2 choices, labels,
  resolvable ingredient ids) at ERROR level; kcal band: default combo at the existing
  ERROR/WARN level, each single-choice deviation from default at WARNING.
- Sync/D1: optionGroups ride data_json; plan-cell `opts` rides the existing cell-stamp
  merge. Additive everywhere ⇒ no store bump.

**Tests.** Effective-ingredients resolution incl. bad opts fallback; nutrition differs
correctly between two fish choices; planner rotation is deterministic (two runs
identical) and respects avoid (fixture: person avoiding shellfish never gets the prawn
choice; shared slot uses the intersection); options-less recipes byte-identical plans;
shopping aggregates the CHOSEN variant's ingredients; frozen log entry keeps the variant
macros after the recipe data changes; title helper output.

## D2 — Sauce role + catalog additions + fixes

- **Role `'sauce'`** (label "Sauce & condiment"): VALID_ROLES + library role picker gain
  it. Excluded from standalone slot planning AND from side auto-composition; offered in
  the add-extra sheet as a new "Sauces" section (delegated rows like Sides). Convention:
  sauces carry slots ['side']; validate's side-slot warning extended to accept sauce
  role; kcal plausibility WARNING band 40–250/serving.
- **Fixes**: `butter-chicken` season → 'winter/autumn'. Burrito title: already
  "Vegetarian burrito" on main — verify nothing user-visible still says "Burrito
  vegetariano" (the stale D1 mirror gets rewritten by the post-merge seed).
- **New ingredients** (only those missing; per-100g values with honest src citations in
  the existing foods.js style): sea bass (branzino) fillet, sole fillet, plus anything
  the new recipes need. No invented numbers — cite USDA FDC/CREA like neighbors.
- **New/extended recipes** (all ingredient-derived, styles/tags/avoid/season/role per
  conventions, validate green, NO imageKey):
  - `baked-fish` — main, lunch/dinner, optionGroups fish: salmon / sea bass / sole /
    cod (those with ingredients available); base: olive oil, lemon, herbs toTaste.
  - `pasta` — full, lunch/dinner, optionGroups condiment: tomato & basil / Pesto Elena /
    tuna & olives / courgette & ricotta (use existing ingredients where possible).
  - `french-toast-fruit-maple` — add optionGroups fruit: berries / banana / peach
    (existing fruit ingredients).
  - 2-3 additional `main` recipes to fatten the thin pools (lunch mains balanced ≈ 2):
    e.g. lemon-herb chicken breast, turkey cutlets, plus 1 vegetarian main.
  - 2 `sauce` recipes: tomato-basil sauce, yogurt-herb sauce.
- README STATUS entry for the batch.

Verify (browser, from the WORKTREE copy): fresh plans show rotated variants in titles;
recipe screen chips switch fish/condiment and update numbers live; confirm freezes the
chosen variant; shopping shows the chosen fish; sauces appear in add-extra under Sauces
and never as planned meals; butter chicken filtered out of summer plans.
