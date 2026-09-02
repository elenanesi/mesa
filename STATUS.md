# Mesa — status & what's next

The one "where things stand" doc. Companions: **README.md** (what Mesa is + architecture),
**AGENT-HANDOVER.md** (how to develop / preview / test / deploy + the gotchas that have bitten),
**EXPERT-PANEL.md** (how to summon the cross-functional design panel) with **ux-research-notes.md**
and **KNOWLEDGE-BASE.md** as its backbone. Full history is in `git log`; this is the summary a
next agent needs to pick up cold.

Prod: **https://mesa-9y5.pages.dev/app/** (invite-only Google sign-in; Cloudflare Access was REMOVED — see README). Tests: **1989 green**
(`node tools/check.js`, was 1484).

---

## Shipped

**Recipe Market + UX batch (2026-08-27–29, all deployed).** Panel-driven; see the memory
`project-recipe-market.md` for the full detail.
- **Recipe Market** — a household starts with a small, diet-appropriate **starter book** (positive
  `recipeBook` include-set in state.js; new households seeded at onboarding from their diet/avoid);
  a browsable **Market** (My book / Market segment on the Recipes screen) to add/remove; removal is
  calm + **reversible** (re-add anytime); **Duplicate → "make it mine"** forks any recipe. Existing
  households are untouched (`recipeBookInit === 0` ⇒ full catalog). Merge via the existing
  `(entryMap, tombstone)` trio; kept OUT of the per-row D1 mirror.
- **Navigation** — the centre ＋ FAB now goes **straight to Log** in one tap (was a 4-item menu;
  authoring lives in the Library hub); **Profile & settings** is now a Library-hub row (was a
  dead-end from every non-Today tab).
- **Meal Builder (capture-only)** — on a plan slot with ≥2 recipe dishes, "Save as a Meal" stores a
  recipe-of-recipes that KEEPS its dishes as `components`; cards show a "Meal" pill + the dish names.
  Captured Meals are `occasional` (reach for them, not auto-inserted). `saveSlotAsMeal` (library.js).
- **Foods** — replaced the `lemon-juice`/`lime-juice` ingredients with whole **lemon** + **lime**
  (lemon reuses the watercolor icon; lime uses the default icon for now); added per-item weights
  (`avgG`) to 16 fruit/veg so they log by "item" (apple 182 g, banana 118 g, …).
- **Sync hardening** — `recipeRowSignature` (sync.js) now hashes real recipe content
  (ingredients/components/…), not just title/season/image (a stale-nutrition-sync hazard the Meal
  Builder would have tripped).

**Foundation (2026-07).** PWA MVP (vanilla JS, no build step); deterministic week planner
(recipe nutrition = sum(ingredients), kcal = 4·p+4·c+9·f, byte-identical regeneration); ~900 foods
/ ~140 recipes with the **D1 catalog as the source of truth**; Mifflin–St Jeor targets; couple
sync (KV sections) + invite-only Google accounts; pantry (derive-don't-mutate from `logHistory`);
planner variety + Mediterranean protein balance; eaten-out logging; Profile settings-hub + compact
Week workspace.

**Aug 2026 improvement initiative — 4 phases, panel-driven (see EXPERT-PANEL.md).**
- **Phase 1** — per-day balance display + `autoBalancePlan` post-generation pass + restaurant quick-add.
- **Phase 2** — pantry Defect C (one **Need → In cart → Already home** lifecycle) + rebalance-objective
  per-day **spread term** (a `'spread'` mode that evens days once weekly targets are met).
- **Phase 3 (engagement)** — daily-confirm **keystone** (evening-anchored one-tap "Confirm today as
  planned" + calm botanical closure) · weekly **"Days set"** band · **week-in-review** card ·
  **onboarding → 3 screens** to a real plan + **"Fill in later"** estimate banner · **couple
  shared-outcome** line. (Notifications **descoped** by owner.)
- **Phase 4** — **CLOSED without new code**: generation rewire (the `autoBalancePlan` post-pass
  already evens days deterministically) and LLM-estimated macros were both declined by the owner
  after a scope check.

**Recipe/ingredient corrections + options recipes (2026-08-22).**
- **Ingredient corrections** — added `tuna-steak` (fresh; `seared-tuna-lemon` repointed off canned
  tuna) and `whipped-cream`; removed the `brownie` food.
- **Recipe corrections** — apple recipes → autumn/winter; removed the duplicate "Baked sea bass
  with lemon"; added a Mushroom (+ vegan) pasta condiment; `brownie-dessert` is now a real
  from-scratch recipe (choc/butter/sugar/eggs/flour, 12 servings).
- **Generic "options" recipes (task 1)** — `yogurt` repurposed into a generic **Yogurt & fruit
  bowl** (Yogurt × Fruit optionGroups) and a new **Yogurt & fruit** snack (Yogurt × Topping);
  folded/deleted 5 near-duplicate yogurt recipes. Soy yogurt is a `dietKeys`-gated variant so
  vegan/lactose diets get it by elimination (omnivore generation unchanged).
- **Diet-fit default (part 2a)** — the recipe screen (library open) now defaults each optionGroup
  to the first diet/avoid-allowed choice (`render-recipe.js dietAwareDefaultOpts`), not `choices[0]`;
  a lactose AVOIDER is treated as lactose-intolerant for this DISPLAY default. Dairy-detection fixes:
  `soy-yogurt` flagged `dairyFree`, `whipped-cream` added to `DAIRY_FOOD_IDS`. Tests 1799 green.
- **Implicit favourite (part 2b)** — the recipe-screen default now prefers the choice the person
  most recently **logged** for that recipe/group (`render-recipe.js recentLoggedChoice`, read from
  `logHistory` newest-first), when still diet/avoid-allowed; else the diet-fit default. No ♡ UI, no
  synced state (owner chose implicit over an explicit pinned favourite). DISPLAY-only. Tests 1802
  green. **Task 1 (options recipes) is complete.**
- **Recipe-of-recipes (2026-08-22)** -- new engine capability: a recipe can AGGREGATE sub-recipes via a `components` field (engine.js recipeEffectiveIngredients resolves them to sum-of-sub-recipes). First use: the Chinese dinner = spring-rolls + meat-gyozas + fried-rice + noodles + almond-chicken (5 standalone occasional recipes). See the roadmap memory for the wiring gotchas.
- **Follow-up batch (2026-08-22, tests 1803 green, D1 reseeded).** (1) baked-fish gained a **Tuna
  steak** choice (5 fish now). (2) Deleted 3 standalone fish mains now covered elsewhere:
  baked-salmon-farro-broccoli, seared-tuna-lemon, sea-bass-cannellini-rocket. (3) **Yogurt bowl**
  (renamed) gained a **Cereal** group (Granola / Muesli / No cereal) + a "No fruit" choice → build
  yogurt+fruit / +cereal / +both; new `muesli` food; cereal is a choice not the base so a gluten
  avoider gets a cereal-free bowl; **empty-ingredient "none"/skip choices now allowed** (validate.js).
  (4) **Thumbs-down recipes sort to the bottom** of every recipe list (favourites → normal → down,
  each alphabetical): `filteredRecipeIds`, `mealTitleSort`, swap `scored.sort`.
- **Planner + Profile batch (2026-08-22, tests 1820 green).** (a) **Same-day ingredient variety** —
  a soft, deterministic scoring nudge (`ingredientDiversityPenalty`, −7 per repeated dominant
  Produce/Dairy key, ≥40g; yogurts share `sub:'yogurt'`) that stops e.g. carrots ×3 / skyr ×2 in a
  day. Never a hard filter (can't starve a slot), never outvotes kcal/protein; 7 is the ceiling that
  keeps the `lowSugar` tuning invariant. Panel-designed. (b) **Snacks optional** — household
  `planSnacks` flag + a "Plan a daily snack" toggle (Profile > Food preferences); off = breakfast/
  lunch/dinner only, calories redistributed across the 3 meals. Default on = generation unchanged.
  (c) **Avoid a specific ingredient** — per-person `avoidFoods` (food ids) with an ingredient search
  in "Foods to avoid"; base-ingredient recipes drop entirely, option-choice ingredients filter
  per-choice (recipe stays viable). Note: recipes use the **"Mixed berries"** blend, not standalone
  "Blueberries" — avoid the blend to drop those recipes.

**Post-initiative (2026-08-21).**
- **Recipe DB = source of truth** — D1 GLOBAL fully replaces `data/recipes.js` at runtime (deletions
  honored); the "sanity floor" is now an absolute minimum, so the owner can curate/delete recipes in
  D1 and see it in the app (see AGENT-HANDOVER.md "Recipes: the D1 catalog is the SOURCE OF TRUTH").
- **Diet-aware specific-protein chips** under "What do you feel like?" (Egg/Chicken/Fish/Red meat/
  Cheese/Legumes, gated by the person's diet).
- **Typeable log amount** (type grams/servings; +/- kept).
- **CI fix** — root `wrangler.toml` so Cloudflare "Workers Builds" deploys the real `mesa-sync`
  worker instead of mis-deploying the repo as a static site.

---

## Open / next

**Recipe quality pass (chef + nutritionist panel) — DONE in-code, 1938 green, NOT yet reseeded/deployed (2026-08-30).**
Added a 5th expert persona — **Chef & neuro-food-marketing** (EXPERT-PANEL.md) — and had the chef + nutritionist
review all 122 planned recipes (17 `occasional` treats left untouched). Applied in `app/data/recipes.js`:
- **Nutritional outliers fixed:** the two coconut chia puddings (sat fat 33g/26g → ~5-6g, rebased on soy milk/yogurt,
  kept vegan+GF); `ricotta-walnuts` and `olives-feta-snack` (sat ~10-12g → ~7g); three fibre bombs
  (`lentil-quinoa-greens-bowl` 28→24, `zuppa-broccolo-nero-lenticchie` 26→24, `chickpea-quinoa-broccoli-bowl` 25→22,
  all under the 25g GI-distress line). Highest planned-recipe sat fat is now 12g (was 33); highest fibre 24g (was 28).
- **Balance rebuilds:** `greek-salad-big` (P13/fib4 → P18/fib12 via chickpeas), `insalata-pesche-feta`,
  `white-bean-rosemary-mash` (2-ingredient → greens+tomato plate), `insalata-noci-mele-senape`, `pomodori-al-riso`
  (+pecorino protein), `turkey-cutlets-sage` (+veg side), `feta-filo` trimmed to stay in the everyday pool.
- **Appeal (chef, zero-macro):** renamed the boring "X-bowl" / "diet-food" titles (crispy/charred/smoky/Tuscan…),
  added `toTaste` aromatics (chilli, smoked paprika, sesame, capers, lemon zest) and char-not-boil steps.
- **12 new dishes** filling gaps: `berry-chia-soy-pudding` (vegan+GF+nut-free breakfast), `sea-bass-greens-potato` /
  `spigola-acqua-pazza` (lighter dinners), `cannellini-carrot-lemon-dip` (low-cal snack), plus puttanesca-tonno,
  vongole, caponata-ceci, salmon-avocado-bowl, farro-pomodoro-feta, ricotta-pomodoro-toast, caprese-skewers,
  bresaola-rucola-parmigiano. Now **134 planned + 17 occasional**.
- Two catalog-driven test-fixtures made robust (they depended on the generator producing an *un*balanced week, which
  the healthier catalog no longer does): the re-balance-spread demo now *deliberately* builds an uneven week, and the
  `lowSugar`-tuning fortnight guard now tolerates sparse-sugar feasible-set jitter (both documented in-place).
- **TO DEPLOY:** built-in recipes live in the D1 catalog → this needs `node tools/seed-d1.js` (a reviewed content
  release) + a Pages deploy. Not run yet — awaiting the go-ahead.

**Recipe EDIT behaviour → FORK model (owner-approved 2026-08-30, DONE in-code, 1946 green, deployed with the fork build).**
Editing a MARKET/built-in recipe no longer edits it in place — it **forks** to the user's own new `cr-` recipe and the
untouched original **returns to the market** (removed from book via `removeRecipeFromBook`, re-addable), so the edit and
the original can sit side by side (verified end-to-end: edit → `cr-…` fork, original back in market, re-add → both in
book). `saveRecipeBuilder` (library.js): `editingBuiltin` branch; the dup-name check is now book-aware (a market recipe
out of your book never blocks a name). A fork note replaces the old in-place hint in the edit form. This **deprecates**
the in-place override model for NEW edits — legacy `recipeOverrides` still load/merge and their **reset-to-default**
(↺ button + resetRecipeBuilderOverride) still works for back-compat. The D3 builder test suite (option-variant editing,
occasional flag, reset) was reworked to the fork model (each block snapshots/restores the recipe-book globals).

**Per-day calorie deviation — INVESTIGATED 2026-08-30, generation fix REJECTED (evidence-based).**
Owner report: "1450 kcal planned, some days hit 1900+ (+31%)." The expert panel proposed a generation
"evener" (a re-portion move + a ±15% calorie term in `autoBalancePlan`). Built it, then **measured**
current generation on three configs — normal 2150/2420 (max day deviation **13.7%**), low 1450/1600
(**5.9%**), and the thinnest vegan+GF @1450 pool (**7.0%**): **0/14 days over ±15% in every case.**
Generation does not produce the reported days, and the evener regressed the normal case (the
fibre-ceiling term hijacked its shrink move, cutting good fibre and dragging calories to −15%).
**Reverted; documented in AGENT-HANDOVER.md → "Investigated & rejected."** The real cause is
user-injected: manual **occasional / eaten-out adds go in at portion 1x, bypassing `bestPortion`**
(`applyOneTimeMealToSlot`, `addMealExtra`), and dense custom/favourite recipes. Real leverage, if the
owner wants it, is **UX not generation**: surface the "high day" honestly (the `perDayBalanceState`
cue exists) + a one-tap "trim this day" + a target-aware meal builder + a "Lighter" Market filter —
and honor a deliberately-added treat rather than silently shrinking it. Tests still **1938 green**.

**Measurement workstream — amounts & units (owner decisions LOCKED 2026-08-21):**
- **Type amounts everywhere.** DONE 2026-08-29 — the last stepper-only `sv-val` spots (meal-builder
  rows, edit-today-food, add-meal food extras — render-today.js) are now typeable
  (`input.sv-val` + `parseDecimalInput` + a shared `applyMealExtraFoodGrams`), keeping the +/-. The
  recipe-builder grams were already typeable. **STILL TO DO (smaller):** surface the tbsp/tsp/cup
  unit picker in those recipe/meal-builder inputs (it's only in the log picker) — best folded into
  future Meal Builder work.
- **Ingredient UNIT PICKER** — SHIPPED 2026-08-24 (`b1b24de` log picker, `6d26095` editor).
  engine.js `foodMeasureOptions`/`foodGramsPerUnit`/`foodDefaultLogUnit`/`foodUnitStep` resolve a
  food's loggable units; the log picker (render-today.js) shows a unit selector (item / tbsp / tsp /
  cup / g-ml) with a live "= N g". Grams stay the stored anchor; the chosen unit is NOT stored.
  The ingredient editor's "Amounts & measures" panel (library.js) edits the per-item weight (`avgG`)
  + `measures:{tbsp,tsp,cup}`, saved per-food (per-household, couple-synced) — saveNewFood now
  PRESERVES avgG (was dropped) and item logging is avgG-based (not unit:'piece'), so a per-100g
  food can gain "1 apple = N g". `measures` seeded on ~26 curated foods (oils/honey/syrup/sugar/
  flours/grains/spreads/soy/dairy liquids) — extend toward the full ~40–80 as desired (built-in
  FOODS are file-based → Pages deploy, no D1 seed). **STILL TO DO (smaller):** the meal/recipe
  ingredient grams inputs are still stepper-only (the "type amounts everywhere" remainder — the log
  picker + food editor are done); and the unit picker isn't yet surfaced in those recipe-ingredient
  inputs (only in the log picker).

**D1 mirror sync now writes a per-row diff, not the whole library (FIXED 2026-08-23).**
`mirrorLibraryCatalogToD1()` (`app/js/sync.js`) used to rewrite the household's ENTIRE custom
library (foods + recipes + prefs, ~170 rows) on every couple-sync — not just what changed — and
each deploy forced every open client to reload (new SW → fresh boot → fresh full mirror push).
That blew through the D1 free-tier write budget (100k rows/day) on 2026-08-22 — 144,008 rows
written, triggering a Cloudflare usage-limit warning email (root cause confirmed via Cloudflare
GraphQL Analytics `d1AnalyticsAdaptiveGroups`; Workers requests and D1 reads were far under their
limits, only D1 writes exceeded). **Fix shipped:** `diffLibraryCatalogPayload()` computes a
per-row content signature (foods/recipes/prefs/tombstones) and the mirror POSTs ONLY the rows
whose signature changed since the last successful push; if nothing changed it makes zero network
calls. The signature map (`mirroredRowSignatures`) is now persisted (state.js
`buildSnapshot`/`loadState`, `libraryMirror` field) so a SW-forced reload after a deploy no longer
re-pushes an unchanged library. Signatures commit only on a successful (`res.ok`) push, so a
failed push retries the same rows. Worker (`worker/sync.js handleLibraryPost`) needed no change —
it already does per-row `INSERT...ON CONFLICT`, so fewer rows in = fewer D1 writes. Regression
tests in `tools/check.js` (`diffLibraryCatalogPayload` per-row diffing + `mirrorLibraryCatalogToD1`
sends-only-changed-rows). Merge invariants (`mergeLibrarySection`, tombstones) unchanged.

**UX-review residuals** (from the retired `UX-REVIEW-plan.md`):
- ~~**Log ⇄ tab bar (P1).**~~ RESOLVED 2026-08-29 — the ＋ FAB IS the Log destination now and lights
  correctly there.
- ~~**Long display names clip in the `.seg` switcher (P2).**~~ RESOLVED — `.seg`/`.seg button` already
  carry `max-width`/`text-overflow:ellipsis` in mesa.css.
- **Diet + avoid-list combos can starve a slot (P3).** Honest-degrade + a book-aware "browse the
  Market" card shipped (only points at the Market when it holds a diet-valid recipe; else routes to
  Profile). The starter-sufficiency test now covers gluten-free/lactose/vegan+GF stacks. STILL OPEN:
  widening the GLOBAL pool for very strict combos — a **D1 re-seed**, decoupled as its own reviewed
  content release.

**Keystone/days-set counted a structurally-unfillable slot as unfinished — FIXED + deployed 2026-09-02.**
Day-completion (the "Confirm today as planned" keystone + its wreath reward + the weekly "Days set"
band) required all 4 `SLOT_ORDER` slots accounted, but two slot classes can never be confirmed or
skipped, so the day maxed at 3/4 forever: (1) **snacks-off households** (`planSnacks === false` — a
common setting, broader than the strict-diet case originally logged) whose snack slot is never planned,
and (2) a strict-diet day with a `reason:'no-candidates'` slot. Fix: `requiredSlots()`/`requiredSlotCount()`
(render.js) = `SLOT_ORDER` minus snacks-off (reuses planner `snacksOnFor()`) minus no-candidates (reuses
`computeMenuForDate`/`planEntryView`); all five completion gates — `accountedSlotCount`, `weekDaysSetCount`,
`playDayCompletionReward`, `triggerMealLogReward` (render-today.js), `todayKeystoneState` (render-today.js)
— now compare against the required count with a `>0` guard (a fully-unplannable day never vacuously
completes). +20 honesty tests (`testRequiredSlotCountCompletionFix`). Tests 1989 green. Pure app JS — no
D1 reseed.

**Open follow-ups:**
- **Lime has no bespoke icon** — it uses the default ingredient icon. Drop a green watercolor
  `app/assets/ingredients/lime.png` (via the `watercolor-ingredient-icons` skill + an image tool) and
  set the `lime` food's `iconKey: 'lime'`; `build-sw` picks up the asset.
- **`parseInt` hygiene (minor, not a live bug)** — `obSetDob`/`obSetActivity` (app.js:460–473) call
  `parseInt` without a radix on `<select>` values; guarded by `isNaN` today so harmless. Add radix 10
  when next touching app.js — not worth a standalone deploy (a no-behavior-change ship forces a
  client-wide SW reload).
- ~~**Unmerged fix on `origin/claude/codebase-review-improvements-ictw46`** ("remove duplicate Swap
  button on the Today snack card").~~ DROPPED 2026-09-02 — that branch is gone from origin
  (unrecoverable) and no duplicate Swap button is present in `main`. Nothing to cherry-pick.

## Later-phase levers (deferred, not scheduled)
- **Always-on fibre nudge — TRIED then DROPPED (2026-08-29).** Built a small always-on fibre term in
  the `tuningBonus` class (deterministic, no starvation, tests green) but verification showed the
  default Mediterranean plans already deliver **~51 g fibre/day — 2× the WHO 25 g floor** — so the
  lift was ~+5 g/week, not worth it. The more relevant fibre question is TYPE/variety (a weekly
  distinct-plant count), not quantity — and even that needs checking whether variety is actually low
  before building. Reverted; don't re-attempt fibre-quantity steering.
- **Generation rewire** (balance-aware picks) — a soft, deterministic additive score term at the pick
  sites (`planner.js` `pickSoloMeal`/`pickSharedMeal`, sibling to `tuningBonus`), threading per-day
  running totals in. Declined once (the post-pass suffices); revisit only with fresh determinism +
  demo-week test baselines.
- **LLM-estimated macros** — Cloudflare Workers AI (on-platform) if revisited; always label
  *estimated, not verified* — never the `chip-computed` "✓ computed" badge.
