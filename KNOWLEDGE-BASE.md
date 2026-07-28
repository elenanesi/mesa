# Mesa — Knowledge Base: how we determine a healthy diet

This document consolidates the nutrition logic that is actually **encoded in Mesa's
code** — every number below is computed by, or read out of, a specific file/line in
this repo. Nothing here is invented: where a design doc (`MVP-plan.md`,
`ux-research-notes.md`) describes an *intent* that differs from what's shipped, that
gap is called out explicitly rather than papered over. If you're an agent working on
Mesa, this is the vocabulary and the constants to cite — don't reintroduce new
thresholds elsewhere without adding them here.

---

## 1. Energy & macros

### 1.1 Daily calorie target — Mifflin–St Jeor × activity + goal

Computed in `app/js/engine.js`, never typed in per person.

- **BMR** (`bmrOf`, `app/js/engine.js:26-29`): Mifflin–St Jeor —
  `10 × weightKg + 6.25 × heightCm − 5 × age`, `+5` for male / `−161` for female
  (comment at `engine.js:25`).
- **Maintenance / TDEE** (`maintenanceOf`, `engine.js:30`): `BMR × activity factor`.
- **Activity factors** (`ACTIVITY_LEVELS`, `engine.js:11-16`):

  | Level | Factor | Description |
  |---|---|---|
  | Sedentary | ×1.2 | Mostly sitting |
  | Lightly active | ×1.375 | Walks or 1–2 workouts/week |
  | Moderately active | ×1.55 | Training 3–5 days/week |
  | Very active | ×1.725 | Hard training most days |

- **Recommended calories** (`recommendedCal`, `engine.js:31`): `round10(maintenance + goalAdj)`, rounded to the nearest 10 kcal.
- **Manual-override safety band** (`calBand`, `engine.js:33`): never below `1.1 × BMR`, never above `maintenance + 600` kcal.
- **`goalAdj`** — derived, not user-editable directly (`deriveGoalAdj`, `engine.js:56-60`; goal-audit fix, 2026-07-28 — see §3): `-325` kcal while `PROF[key].goals.fatLoss` is on ("gentle fat loss"), `+60` while `PROF[key].goals.muscleGain` is on ("small muscle-gain surplus"), `0` at maintenance while neither is on. **Both offsets are available on EITHER profile now** — earlier this doc (and the shipped code, pre-audit) described these as fixed per-person constants ("Elena: −325", "Andrea: +60"); that was a real slot-pinning bug (`CALORIE_GOAL_KEY`, since deleted from `engine.js`), not an intentional design choice, and is fixed. The two goals are mutually exclusive (`toggleGoal()`, `render-profile.js:362-375`). The magnitudes themselves are unchanged: chosen (`state.js:486-489`) so the demo profiles still land on the familiar 1,820 / 2,480 kcal defaults when Elena has `fatLoss` on and Andrea has `muscleGain` on, matching the Health-goals copy "~325 kcal below maintenance" / "~60 kcal above maintenance — calorie target only" (`GOAL_DEFS_UNION`, `state.js:550-557`).

### 1.2 Macro-gram targets from the calorie split

`recomputeProf()` (`engine.js:38-65`) turns each person's `%`-split (`kP`/`kC`/`kF`) and daily kcal target into gram targets:

- `targetP = round(kcal × kP / 100 / 4)` — protein at 4 kcal/g (`engine.js:49`)
- `targetC = round(kcal × kC / 100 / 4)` — carbs at 4 kcal/g (`engine.js:50`)
- `targetF = round(kcal × kF / 100 / 9)` — fat at 9 kcal/g (`engine.js:51`)

**Split guardrails** (`SPLIT_BOUNDS`, `engine.js:129`): Protein 10–40% · Carbs 20–60% · Fat 20–45% of daily calories. User-facing rationale strings live in `splitGuardNote()` (`engine.js:133-140`).

Default splits actually shipped (`state.js:349, 361`): Elena `26/41/33` (P/C/F), Andrea `26/43/31`.

**Good-fat / sat-fat split for "today"** (`recomputeProf`, `engine.js:59-64`): the consumed sat-fat number is summed directly from logged entries' `satFat` (itself from `recipeNutrition`/`foodMacros`) — not a fixed ratio approximation. Comment at `engine.js:59-62` is explicit that this replaced an old 75/25 target-based guess; that older 75/25 approximation is still used only for the *profile-level target* split shown in the ring, never for what's actually logged.

### 1.3 Deterministic nutrition core — Atwater 4/4/9 kcal policy

Header comment, `app/data/foods.js:16-25`:

- kcal is **computed**, not published-and-typed: `round(4×protein + 4×carbs + 9×fat)` from the sourced protein/carb/fat grams for every food (the "standard Atwater general-factor approach").
- **EU-style labeling choice**: fiber is counted **within** carbs, not subtracted as "net carbs" (`foods.js:17-18`).
- Consequence, stated as a **deliberate, documented simplification** (`foods.js:20-25`): this can read a little *higher* than some published "kcal" columns for very fibrous, low-calorie vegetables, because USDA sometimes applies refined, food-specific energy factors that discount fiber further than the general 4/4/9 rule does. "That's a known, deliberate simplification, not a typo; the macro grams themselves are the sourced values."

### 1.4 `foodMacros()` and `recipeNutrition()` — the single source of computed nutrition

`app/js/engine.js:78-127`:

- `foodMacros(foodId, grams)` (`engine.js:78-93`) scales one food's stored per-100g (or per-piece) macros to the grams actually used. A missing food id degrades to zeros with a logged error rather than crashing (`engine.js:80-83`).
- `recipeNutrition(recipeId, servings)` (`engine.js:107-127`) sums a recipe's `ingredients` (never `toTaste` garnish items) scaled by `servings / batchYield`, then **recomputes kcal from the summed macros** via 4/4/9 (`engine.js:122`) — so a recipe's kcal always stays internally consistent with its own protein/carb/fat instead of drifting from summing each ingredient's already-rounded kcal field. `goodFat = fat − satFat` is the real ingredient-derived split (`engine.js:123`), distinct from the profile-target 75/25 approximation noted in §1.2.
- Ground rule, restated in `WISHLIST-plan.md:10`: nutrition is always summed from ingredients (`engine.js:recipeNutrition`) — never typed into data directly.

---

## 2. The numeric health targets Mesa enforces

All from `app/js/planner.js`'s Insights call-outs and weekly coverage engine. This is the authoritative, cite-by-reference table:

| Target | Threshold | Source | Notes |
|---|---|---|---|
| Fiber | **≥ 25 g/day** (per person, 7-day average) | `buildInsightCallouts`, `planner.js:522-527`; also `coverageGaps`, `planner.js:1011-1012` (`target: 25`) | Insights call-out compares `avgFiber` to a literal `25`; weekly coverage tracks whichever of Elena/Andrea is lower (`planner.js:1003-1004`). |
| Saturated fat | **≤ 33% of total fat** | `buildInsightCallouts`, `planner.js:530-535` (`satSharePct <= 33`); `coverageGaps`, `planner.js:1013-1014` (`target: 33`, `cap:true`) | Computed over the rolling 7-day logged window as `1 − totalSatFat/totalFat` (`computeInsights`, `planner.js:495`), and over the week plan as `satFatSum/fatSum` (`computeWeeklyCoverage`, `planner.js:995`). |
| Protein | **≥ personal goal** (`targetP`, from the %-split, §1.2) | `buildInsightCallouts`, `planner.js:514-519` (`avgProtein >= targetProtein`) | `targetProtein` is read straight from `PROF[personKey].targetP` (`planner.js:497`) — i.e. the calorie-split-derived gram target from `engine.js:49`, not a separately hard-coded number. |
| Omega-3 coverage | **≥ 3 meals/week** | `coverageGaps`, `planner.js:1007-1008` (`target: 3`) | A meal counts if *either* person's dish in that slot carries the `omega3` flag (`computeWeeklyCoverage`, `planner.js:982`, `969`). |
| Selenium coverage | **≥ 3 sources/week**, tracked **only while the thyroid (Hashimoto's) goal is on for at least one person** | `coverageGaps`, `planner.js:3012` (`target: 3`); gating: `hashiGoalOn()`, `render-week.js:666` (`!!(PROF.elena.hashi \|\| PROF.partner.hashi)`), read by `renderNutrientChips`, `render-week.js:668-673` | Same "either person's dish that slot" rule as omega-3. **Goal-audit fix**: this used to hardcode `PROF.elena.hashi` only, so a slot-2 (partner) thyroid goal never surfaced the target — `hashiGoalOn()` was factored out specifically so the gate (and its regression test, `tools/check.js:testGoalAudit`) follows whichever profile actually has `hashi` on. |
| Adherence band | **±10% of target kcal**, good defined as **≥ 5 of 7 days** in-band | Per-day band: `computeInsights`, `planner.js:479` (`Math.abs(kcal - target) <= target * 0.10`); "good" verdict: `buildInsightCallouts`, `planner.js:539` (`inBandCount >= 5`) | Compared against each day's *frozen* target snapshot, so a later calorie-target change never moves a past day's dot (comment, `planner.js:467-468`). |

Two extra mechanics worth citing alongside the table:

- **Call-out selection is deterministic, not exhaustive**: exactly 2 of the 4 rules above surface on Insights at a time, picked by whichever metric's relative distance from target (`magnitude`) is largest, ties broken by a fixed rule order (protein, fiber, satFat, adherence) — `buildInsightCallouts`, `planner.js:506-547`.
- **Weekly rebalancing** (`proposeRebalanceSwaps`, `planner.js:1049` on) uses the same four metrics/targets via `coverageGaps()` to greedily swap up to 2 meals toward whichever metric has the largest gap (`planner.js:1052-1054`).

### A note on protein for the muscle goal (g/kg)

**No code path computes protein from bodyweight, and toggling a goal never touches the %-split.** `targetP` is purely the %-of-calories split from §1.2 (`targetP = kcal × kP / 100 / 4`, `engine.js:49`), which stays exactly what the user set on the Split editor (`SPLIT_BOUNDS`, `engine.js:342`) regardless of which goals are on — the goal audit (below) deliberately did not wire any goal into `kP`/`kC`/`kF`, precisely so a goal can never silently fight a manually-edited split. Back-calculating from the shipped defaults (both goals off, default splits): Andrea (78 kg, `kP:26`) lands at ~161 g protein/day ≈ **2.06 g/kg**, and Elena (64 kg, `kP:26`) at ~118 g/day ≈ **1.84 g/kg** — a fact about the current default split, not something the `muscle` goal produces.

**What the `muscle` goal (GOAL_DEFS_UNION, `state.js:551`) DOES do**, since the 2026-07-28 goal audit: it's a per-person input to `goalTuningBonus()` (`planner.js:1477`), which adds a `tuningBonus(totals, 'protein')` term (`planner.js:1424`) to that person's own half of the weekly planner's candidate scoring (`pickSharedMeal`/`pickSoloMeal`, `planner.js:1813-1814, 1909`) — the exact same scoring formula the household-level "next week: more protein" tuning dial (`nextWeekTuning`) already used, just keyed off `PROF[person].goals.muscle` instead of the one shared household dial. In practice this nudges which RECIPES get picked toward higher-protein options within the person's existing calorie/protein targets — it does not raise `targetP` itself and is not a g/kg computation. The distinct `muscleGain` goal (also in `GOAL_DEFS_UNION`) is the one that moves a number directly: a fixed `+60` kcal `goalAdj` (§1.1), with zero effect on protein composition.

The Muscle & protein UI copy previously said "1.6 g protein / kg bodyweight," then "Protein-forward macro split · ~1.8–2 g/kg" — both implied a split/gram-target mechanism that never existed. It now reads **"Nudges meal picks toward higher protein — does not change your split or calories"** (`state.js:554`), describing the real `goalTuningBonus` mechanism above. The older planning docs (`WISHLIST-plan.md:123`, `MVP-plan.md:121`) still carry the aspirational "≈1.6 g/kg" language from the original design intent — left as historical records; this KB and the in-app copy are the current source of truth.

---

## 3. Goal profiles & what each tilts

Source: `GOAL_DEFS_UNION`, `app/js/state.js:550-557` — the single copy source for both profiles' "Health goals" editor (`renderGoalsEditor()`, `render-profile.js:337`; `index.html`'s `#goalsList` div is populated from this array, no separate static copy). Both slots offer the identical six goals — a slot is an opaque id, never "the fat-loss person" (`state.js:521-529`).

**Goal audit (2026-07-28)**: every goal below now moves a real, observable number for whichever profile has it on. Before this audit, `fatLoss`/`muscleGain` were silently pinned one-per-slot (checking the "wrong" one for your slot did nothing), and `muscle`/`heart`/`skin` changed only the goalTag chip and "why this fits you" copy — see git history / `KNOWLEDGE-BASE.md`'s prior revision for the exact prior-broken citations if needed.

| Goal | UI description (`state.js:550-557`) | What's actually wired in code |
|---|---|---|
| **Gentle fat loss** (`fatLoss`) | "~325 kcal below maintenance" | `deriveGoalAdj()` (`engine.js:56-60`) returns `-325` while `PROF[key].goals.fatLoss` is true, for **either** profile — feeds `recommendedCal()` (`engine.js:32`). Mutually exclusive with `muscleGain`: `toggleGoal()` (`render-profile.js:362-375`) turns the other off the moment this one turns on. |
| **Muscle gain** (`muscleGain`) | "~60 kcal above maintenance — calorie target only" | Same `deriveGoalAdj()`, `+60` while `goals.muscleGain` is true, for either profile. Deliberately touches nothing else (no protein/split effect) — the description says so explicitly so it's never confused with the `muscle` goal below. |
| **Muscle & protein** (`muscle`) | "Nudges meal picks toward higher protein — does not change your split or calories" | Per-person input to `goalTuningBonus()` (`planner.js:1472-1486`), which adds `tuningBonus(totals, 'protein')` (`planner.js:1424-1432`) to that person's own half of the weekly planner's meal-candidate scoring (`pickSharedMeal`/`pickSoloMeal`, `planner.js:1813-1814, 1909`) — same formula/weights the household-level `nextWeekTuning` dial already used (§1.2's protein-split note explains why this is scoring bias, not a gram-target change). Recipe-level (unrelated, pre-existing): `AUTO_TAG_THRESHOLDS.muscleProteinMinG = 25` g/serving tags a recipe `muscle` (`library.js:172, 230`). |
| **Heart & metabolic** (`heart`) | "Nudges meal picks toward more fiber and less saturated fat" | `goalTuningBonus()` sums `tuningBonus(totals,'fiber')` + `tuningBonus(totals,'lowSatFat')` (`GOAL_TUNING_KEYS.heart`, `planner.js:1472-1476`) into that person's planner scoring — same per-person mechanism as `muscle` above. This is IN ADDITION to the household-wide, goal-independent fiber ≥25g/day and sat-fat ≤33%-of-fat coverage targets in §2, which apply regardless of any goal. Recipe-level (pre-existing): `AUTO_TAG_THRESHOLDS.heartFiberMinG = 5` AND `heartSatFatMaxShare = 0.33` together tag a recipe `heart` (`library.js:173-174, 233`). "Low sodium" was removed from this description — no sodium field exists in `FOODS` at all (see §5). |
| **Beautiful skin** (`skin`) | "Nudges meal picks toward more omega-3 and less free sugar" | `goalTuningBonus()` sums `tuningBonus(totals,'omega3')` + `tuningBonus(totals,'lowSugar')` (`GOAL_TUNING_KEYS.skin`, `planner.js:1472-1476`) into that person's planner scoring. "Low-GI" and "dairy/sugar down" were removed from this description: `tuningBonus()` has no `lowGI` key (no per-candidate low-GI signal is computed in the planner scoring path) and no code path thresholds dairy specifically — see §5. The pre-existing hand-tagged `skin` recipe tag (`data/recipes.js`, display via `TAG_PILL_MAP.skin`, `state.js:245-255`) and the `lowGI`/`omega3` food flags (`foods.js:33-34`) are unchanged by this audit. |
| **Hashimoto's-friendly 🦋** (`hashi`) | "Tracks weekly selenium coverage (≥3 sources) while this is on" | `PROF[key].goals.hashi` (mirrored to `PROF[key].hashi` in `recomputeProf()`, `engine.js:98`) gates the selenium ≥3 sources/wk coverage target via `hashiGoalOn()` (`render-week.js:666`) — **follows whichever profile has it on**, fixed from a hardcoded `PROF.elena.hashi`-only check (§2's selenium row). Recipe-level (pre-existing): `AUTO_TAG_THRESHOLDS.seleniumMinG = 15` g rule tags a recipe `thyroid` (`library.js:168, 218`). "Moderate iodine" and "anti-inflammatory" were removed from this description — no code path caps a person's weekly iodine intake despite the `highIodine` food flag existing (`foods.js:34`); see §5. |

**On keeping `muscleGain` and `muscle` as two separate toggles** (not merged): they are genuinely different levers — `muscleGain` is a calorie-target lever (surplus vs. not), `muscle` is a recipe-selection lever (protein-forward picks vs. not) — and a real use case wants them independently (e.g. a protein-forward cut: `muscle` on, `fatLoss` on, `muscleGain` off). Merging them would force every protein-focused person into a surplus. The two descriptions above were reworded specifically so the mechanism difference ("calorie target" vs. "meal picks") is stated in the copy itself rather than only visible in code.

---

## 4. Nutrition flags & recipe-tag auto-classification thresholds

### 4.1 Food flags (per-ingredient)

Declared vocabulary, `app/data/foods.js:33-34`: `lowGI, omega3, selenium, highIodine, glutenFree, highFiber, fermented`. Each `FOODS[id].flags` array is hand-assigned per ingredient (e.g. `mixed-berries` → `['lowGI']`, `foods.js:51`).

Display labels currently defined, `app/js/library.js:342`: `FOOD_FLAG_LABELS = {lowGI: 'Low-GI', omega3: 'Omega-3', highFiber: 'High fiber', glutenFree: 'Gluten-free'}` — `selenium`, `highIodine`, `fermented` have no display label yet (flagged as a gap by `WISHLIST-plan.md:78`, out of scope for this doc).

### 4.2 Recipe tags — auto-derived for custom recipes

`deriveRecipeMeta()` (`app/js/library.js:207-264`) computes `{tags, styles, avoid}` for any user-built recipe from its ingredients + computed totals — nothing is typed in. Thresholds, all named constants at `library.js:166-176`:

| Constant | Value | Effect |
|---|---|---|
| `omega3MinG` | 40 g | Any `omega3`-flagged ingredient ≥40g in the dish → tag `omega3` (`library.js:167`) |
| `seleniumMinG` | 15 g | Any `selenium`-flagged ingredient ≥15g → tag `thyroid` (`library.js:168, 218`) |
| `highFiberMinG` | 6 g/serving | Total recipe fiber ≥6g/serving → tag `highFiber` (`library.js:169`) |
| `lowGICarbContributorMinG` | 5 g carbs | An ingredient counts as "carb-contributing" once it supplies ≥5g carbs to the dish (used to decide `lowGI` eligibility) (`library.js:170-171`) |
| — | — | `lowGI` tag requires **every** carb-contributing ingredient to itself be `lowGI`-flagged (vacuous-truth guarded: a dish with zero carb contributors doesn't qualify) |
| `muscleProteinMinG` | 25 g/serving | Total protein ≥25g/serving → tag `muscle` (`library.js:172, 230`) |
| `heartFiberMinG` | 5 g/serving | Combined with `heartSatFatMaxShare` below → tag `heart` (`library.js:173, 233`) |
| `heartSatFatMaxShare` | 0.33 (33%) | `satFat/fat ≤ 0.33` AND fiber ≥5g/serving → tag `heart` (`library.js:174, 233`) |
| `quickMaxMinutes` | 15 min | Prep time ≤15 min → tag `quick` (`library.js:175`) |
| — | — | `veggie` tag: no ingredient is in the hand-picked `ANIMAL_FOOD_IDS` list (fish/meat/poultry; excludes eggs and plant proteins) |

**Style thresholds** (`AUTO_STYLE_THRESHOLDS`, `library.js:177-182`):

| Constant | Value | Effect |
|---|---|---|
| `highProteinKcalShareMin` | 0.28 (28%) | Protein-kcal share of total kcal ≥28% → style `highprotein` (`library.js:178, 245`) |
| `lowCarbMaxG` | 30 g/serving | Total carbs ≤30g/serving → style `lowcarb` (`library.js:179, 246`) |
| `balancedCarbKcalShareMax` | 0.55 (55%) | Carb-kcal share >55% drops the default `balanced` style, unless it's the only style left (never leaves `styles` empty) (`library.js:180, 247`) |

**Avoid-key inference** (`library.js:173-180`): `Dairy` category → `lactose`; ingredient in `GLUTEN_FOOD_IDS` (`library.js:123`) → `gluten`; `prawns` → `shellfish`; ingredient in `NUT_FOOD_IDS` (`library.js:124`) → `nuts`.

---

## 5. Data sourcing & honesty / simplifications

From the `app/data/foods.js` header comment (`foods.js:1-42`):

- **Sourcing**: mostly **USDA FoodData Central** (FDC id noted per entry where an exact match exists; "-style" means a representative FDC entry for that food class was used, not an exact id lookup), plus a couple of **CREA-style Italian references** for farro and bresaola where USDA has no close match (`foods.js:9-14`). Values rounded to 1 decimal (kcal to whole numbers).
- **kcal policy**: Atwater 4/4/9 general-factor computation from sourced protein/carb/fat grams, EU-style (fiber counted within carbs) — see §1.3 for the full quote (`foods.js:16-25`).
- **Deliberate simplification, stated honestly**: computed kcal for very fibrous, low-calorie vegetables can read a little higher than some published USDA "kcal" columns, because USDA sometimes uses refined, food-specific energy factors that discount fiber further than the general 4/4/9 rule. Mesa explicitly keeps the general-factor approach for internal consistency and documents the gap rather than silently deviating per-food (`foods.js:20-25`).
- **Composite ingredients**: mockup shorthand like "Roasted mixed veg" gets one pragmatic blended entry (a weighted average of its components, documented in that entry's `src` field) *plus* the individual components as their own separate foods, so both recipes and precise substitution keep working (`foods.js:27-30`).
- **Still not enforced anywhere in code** (the 2026-07-28 goal audit — §3 — reworded every `GOAL_DEFS_UNION` description to stop claiming these, rather than leaving copy that names a rule the code doesn't apply): no sodium field exists anywhere in `FOODS`, so "low sodium" is not, and cannot yet be, a coded rule — dropped from the Heart & metabolic description. No weekly iodine cap exists despite the `highIodine` food flag (`foods.js:34`) — "moderate iodine" and "anti-inflammatory" were dropped from the Hashimoto's description; only the selenium coverage target (§2, §3) is actually gated on that goal. No `lowGI` key exists in the planner's `tuningBonus()` (`planner.js:1424-1432`) and no dairy threshold exists in `deriveRecipeMeta()` — "low-GI" and "dairy/sugar down" were dropped from the Beautiful skin description, leaving only the two things `goalTuningBonus()` (`planner.js:1477`) actually biases: more omega-3, less free sugar.
- **Design-doc vs. shipped gap, updated**: `MVP-plan.md:120-123` describes calorie-goal offsets as *ranges* ("−300–500 kcal for fat loss, +200–300 for muscle gain") and protein as bodyweight-derived; the shipped code instead uses two **fixed** constants (`goalAdj -325`/`+60`, `engine.js:deriveGoalAdj`, lines 56-60) and a %-of-calorie split (§1.2) — not a live recompute from the selected goal set, and not bodyweight-derived. That part of the gap is unchanged by the goal audit. What the audit DID change: those two fixed constants used to also be **pinned one-per-slot** (`elena` could only ever apply `fatLoss`, `partner` only `muscleGain`, via a since-deleted `CALORIE_GOAL_KEY` slot-dispatch table) — an accident of the original two-named-people prototype that survived the move to opaque per-slot goal lists (`state.js:521-529`). Both goals are now available to, and mutually exclusive on, every profile — see §3.

---

## 6. Limits / not medical advice

Mirrors the Profile screen's live disclaimer, `app/index.html:491`:

> "Mesa offers general nutrition guidance, not medical advice. For Hashimoto's, check changes with your doctor."

The same qualifier is appended to every AI-flavored "why this fits you" coach note in the app — `WHY_GUIDANCE = '<i>General guidance, not medical advice.</i>'` (`app/js/state.js:146`), used verbatim across all per-recipe explanation strings (e.g. `state.js:49-58`).

Practical implications for anyone extending Mesa:

- All targets in §2 are **general population guides** (25g fiber, 33% sat-fat cap, 3/wk omega-3 and selenium coverage, ±10% kcal band) sourced from Mesa's own product decisions — not from a cited clinical guideline in this repo. Treat them as Mesa's house rules, not medical literature citations.
- The Hashimoto's-related logic (selenium coverage, `thyroid` tag) is a food-choice nudge, not a treatment plan; the disclaimer explicitly tells the user to check changes with their doctor.
- Nothing in the deterministic core (§1) claims individualized medical accuracy beyond the standard Mifflin–St Jeor estimate and Atwater-factor food composition — both acknowledged approximations, not lab-measured values for these two people.

---

*Every quantitative claim above cites a specific file:line in this repo (`app/js/engine.js`, `app/js/planner.js`, `app/js/library.js`, `app/data/foods.js`, `app/js/state.js`, `app/index.html`). Where the code diverges from planning-doc language (`MVP-plan.md`, `WISHLIST-plan.md`) or from goal-card UI copy, that divergence is stated rather than smoothed over. See `WISHLIST-plan.md` T7 for the task that produced this doc.*
