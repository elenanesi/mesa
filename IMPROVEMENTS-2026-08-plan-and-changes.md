# Mesa improvements — plan & changes (Aug 2026)

Single source of truth for the panel-driven improvement initiative: the plan, the
product decisions, everything shipped, and what's still open. Companion docs:
[AGENT-HANDOVER.md](AGENT-HANDOVER.md) (how to develop/preview/deploy/test) and
[EXPERT-PANEL.md](EXPERT-PANEL.md) (how to re-convene the expert panel).

Full plan: `~/.claude/plans/you-are-a-product-misty-wreath.md`.

---

## 1. Why (the problems)

Three owner-reported problems, plus the adoption goal (make Mesa a daily habit that
builds good eating habits):

1. **Weekly-average balance overloads single days** — hitting a weekly average let one
   day carry the whole week's fiber (or run very high on another nutrient). "Healthy
   eating doesn't work like that."
2. **Planning is slow/boring + restaurants force a recipe** — not enough recipes to
   combine; every restaurant visit meant authoring a full recipe.
3. **Pantry ⇄ shopping list disagree** — crossed-off didn't mean "I have it"; duplicate
   re-add risk.

## 2. Product decisions (owner)

- **Scope** = full phased roadmap (fixes + engagement + onboarding + couple), 4 phases.
- **External recipes (near term)** = quick-add + suggested recipe-site links with
  **manually typed** macros (labelled *estimated*). No scraping, no LLM yet (LLM = later phase).
- **Per-day balance** = **directional display + quiet planner** (calm "rich/light day",
  never pass/fail; the week stays the unit of judgment).
- **Swap cross-slot** = same-slot first + a "Show other meals" toggle.
- **Recipe tastes** = Mediterranean/Italian + East/SE Asian; fish/seafood + poultry/eggs;
  **NO tofu**; fibre via legumes/whole grains/veg.

## 3. Guiding principles (panel consensus — see EXPERT-PANEL.md)

- Weekly average stays the **primary** target; per-day bands are a secondary "no single
  day carries the week" guard.
- Per-day bands are **nutrient-specific + soft** (never a hard generation constraint —
  starve-a-slot risk) and are a **Mesa product rule, not a clinical threshold** (only the
  daily WHO figures are "Guideline").
- Daily state is **directional, never pass/fail**. No streaks, no red-for-eating.
- Preserve the **deterministic-trust boundary**: estimated macros are rounded and visibly
  labelled *estimated* — and must **NOT** use the `chip-computed` "✓ computed" badge (that
  badge means verified-from-ingredients).
- Keystone habit = one-tap daily confirm. Couple adherence stays private.

## 4. What shipped (all deployed to prod `mesa-9y5.pages.dev`)

### Phase 1
| Commit | Deliverable | Key code |
|---|---|---|
| `e630e70` | **Pantry stale-tick fix** | `reconcileCheckedShopSet` (render-sheets.js) prunes the checked-set vs the current list each render |
| `28592a8` | **Holistic per-day balance display** | `PER_DAY_BANDS` (state.js), `perDayBalanceState`/`dayBalanceOverall` (planner.js); one calm balance dot per day header (green ok / gold off), "N of 7 days balanced", per-nutrient detail on expand |
| `87d6028` | **Auto-balance-after-generation** | `autoBalancePlan` at the end of `generateWeek` (planner.js) — bounded (24 moves), deterministic, strictly-improving, calorie/slot-kcal/meat-cap-safe greedy swap/side pass |
| `0301786` | **Restaurant "ate out" quick-add** | `createAteOutFood` (library.js) + `openAteOutSheet`/`commitAteOut` (render-today.js); one-off `occasional`/`ateOut` `cf-` food logged eatenOut; entry points on the add-meal sheet + Log screen |

### Follow-up fixes (this initiative)
| Commit | What |
|---|---|
| `41da94a` | **Swap: complete meals + cross-slot** — best matches for lunch/dinner filtered to `isCompleteLunchDinnerRecipe` (no bare rice/fish); `swapCtx.includeOtherMeals` toggle reveals any-slot recipes tagged "usually {slot}" |
| `08d8efc` | **10 taste-matched recipes** (+ D1 re-seed → 143 global recipes) — fish/poultry/egg/legume, Med+Asian, no tofu, moderate fibre, all `season:'evergreen'` |
| `c31c068` | **Auto-balance breakfast-side fix** — ADD-SIDE restricted to lunch/dinner (breakfast/snack don't compose with sides). Latent bug surfaced by the richer catalog |
| `39d73d5` | Removed obsolete planning docs + `mesa-prototype.html` (owner cleanup) |

### Findings worth remembering
- **Pantry "Defect A" (duplicate quantity) was a NON-bug** — restock already converges to
  the gross weekly requirement via an absolute SET (`setPantryRemaining`), so no placebo
  fix was shipped. The real pantry-model issue is **Defect C** (crossed-off means the wrong
  thing; covered items silently dropped) — deferred to Phase 2.
- The per-day balance started **fiber-only** and was **superseded** by the holistic version
  (owner: "not about fiber — ALL nutrients + calories").
- Auto-balance magnitude is **week/season-dependent** (demo week 3→4→5 balanced days; a
  richer test week 5→11). It never worsens a plan (strictly-improving moves only).

## 5. Verification approach

- `node tools/check.js` must stay green before every deploy (grew 1484 → 1580 across this
  work, zero regressions). Every feature added targeted tests.
- UI/behaviour verified in the local no-auth preview (`?preview=1`) — see AGENT-HANDOVER.md.
  For balance, `MESA_TEST_DISABLE_AUTO_BALANCE` toggles the pass for before/after checks.

## 6. Also shipped (follow-up requests)

| Commit | Deliverable |
|---|---|
| `a355cd7` | **#1 — planner considers recipe variants by fit.** `pickSharedMeal`/`pickSoloMeal` enumerate each candidate's viable option-combos (`viableRecipeOptionCombos`) and score each combo's real macros, carrying the winning combo's `opts` into `makePlanEntry` (was: default macros + a variety rotation). Recipes without `optionGroups` stay byte-identical. |
| `1b86318` | **#5a — unified "Ate out / eating out".** One entry (was two competing buttons); the ate-out sheet offers "I ate my planned {meal}" (keeps VERIFIED ✓ computed macros via `toggleWeekMealEatenOut`) or "I ate something different" (typed ESTIMATE). Applied the panel's documented principles from EXPERT-PANEL.md (the live panel agents were cut off by a session limit). |
| `dcbcd8b` | **#5b (part 1) — "Build your own meal" in swap.** Opened the add-meal composer from swap. Superseded by the meal builder below (swap's button now opens the builder). |
| `489f235` | **#5b (part 2) — save a composed meal as a recipe.** `flattenComponentsToIngredientRows` (planner.js) merges a composed meal's components by foodId → `saveComposedMealAsRecipe` (library.js) feeds `saveRecipeBuilder`. "💾 Save to My recipes" on the composer; <2 ingredients aborts. |
| `f28f43d` | **Note 3 — swap "what do you feel like?" filter.** Chip row (Fruit/Veg/Protein/Light/Quick + free text) re-ranks Best matches. Tagged 9 fruit foods `sub:'fruit'` + `recipeContainsFoodSub`/`recipeContainsVeg`; Fruit/Veg/Quick filter (with fallback), Protein/Light re-rank. **Needed a D1 re-seed** (foods.js). |
| `e47766a` | **Notes 1+2 — the meal builder.** A separate ingredient-row draft (no plan-entry schema change): seed from a recipe (explodes its ingredients into editable rows), add ingredients and/or other recipes' ingredients (merged by foodId), edit grams / remove ANY row (no privileged base). Footer: Save to My recipes (`saveRecipeBuilder`) · Use for this meal (a one-time `occasional`+`oneTime` `cr-` set at exact 1x macros via `applyOneTimeMealToSlot`, hidden from My recipes) · Log as eaten out (computed macros — note 2's "typing is too hard" fix). Swap's "Build your own meal" and the ate-out "something different" branch both open it; typed estimate demoted to a fallback. |

## 7. Still open

Everything the owner requested in this initiative is shipped. Remaining are the original
later-phase roadmap items only:

**Roadmap (later phases):**
- Phase 2: pantry **Defect C** (Need→In cart→Stocked / Already home; tick keyed on foodId),
  recipe `macrosOverride` + suggested-sites web quick-add, rebalance-objective spread term.
- Phase 3: engagement layer (daily-confirm keystone, onboarding ≤3 screens, anchored
  self-suppressing notification, weekly review, couple shared-outcome view).
- Phase 4: **generation rewire** (make every pick balance-aware — highest risk), LLM-estimated
  macros.
