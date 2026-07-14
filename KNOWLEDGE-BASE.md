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
- **Per-person `goalAdj`** — fixed, not user-editable (`app/js/state.js:326-328, 344, 356`):
  - Elena: `−325` kcal ("gentle fat loss") — matches the Health-goals copy "~325 kcal below maintenance" (`app/index.html:448`).
  - Andrea: `+60` kcal ("small muscle-gain surplus").
  - Comment (`state.js:327-328`): these two offsets were chosen so the demo profiles land exactly on the familiar 1,820 / 2,480 kcal defaults.

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
| Selenium coverage | **≥ 3 sources/week**, tracked **only while the thyroid (Hashimoto's) goal is on** | `coverageGaps`, `planner.js:1009-1010` (`target: 3`); gating: `render.js:274-275` (`k !== 'selenium' || PROF.elena.hashi`) | Same "either person's dish that slot" rule as omega-3 (`planner.js:983`). Comment at `render.js:256-257` states the gate explicitly. |
| Adherence band | **±10% of target kcal**, good defined as **≥ 5 of 7 days** in-band | Per-day band: `computeInsights`, `planner.js:479` (`Math.abs(kcal - target) <= target * 0.10`); "good" verdict: `buildInsightCallouts`, `planner.js:539` (`inBandCount >= 5`) | Compared against each day's *frozen* target snapshot, so a later calorie-target change never moves a past day's dot (comment, `planner.js:467-468`). |

Two extra mechanics worth citing alongside the table:

- **Call-out selection is deterministic, not exhaustive**: exactly 2 of the 4 rules above surface on Insights at a time, picked by whichever metric's relative distance from target (`magnitude`) is largest, ties broken by a fixed rule order (protein, fiber, satFat, adherence) — `buildInsightCallouts`, `planner.js:506-547`.
- **Weekly rebalancing** (`proposeRebalanceSwaps`, `planner.js:1049` on) uses the same four metrics/targets via `coverageGaps()` to greedily swap up to 2 meals toward whichever metric has the largest gap (`planner.js:1052-1054`).

### A note on "1.6 g/kg protein"

`WISHLIST-plan.md:123` and `MVP-plan.md:121` both describe the muscle goal as "≈1.6 g/kg protein," and the Health-goals UI literally says **"1.6 g protein / kg bodyweight"** for the Muscle & protein option (`app/index.html:449`). However, **no code path computes protein from bodyweight directly.** The actual mechanism is the %-of-calories split in §1.2 (`targetP = kcal × kP / 100 / 4`, `engine.js:49`). Back-calculating from the shipped defaults: Andrea (78 kg, `kP:26`, `engine.js:49` + `state.js:361`) lands at roughly 161 g protein/day ≈ **2.06 g/kg**, and Elena (64 kg, `kP:26`) lands at roughly 118 g/day ≈ **1.84 g/kg** — both higher than the "1.6 g/kg" the UI copy and planning docs describe. This is a real discrepancy between the marketing/UI copy and the enforced mechanism, not a hidden target — flagging it here rather than inventing a g/kg formula that isn't in the code.

---

## 3. Goal profiles & what each tilts

Source: `app/index.html:447-452` (Health goals section) and each profile's fixed fields in `app/js/state.js:341-363`.

| Goal | UI description (`index.html`) | What's actually wired in code |
|---|---|---|
| **Gentle fat loss** | "~325 kcal below maintenance" (`index.html:448`) | Elena's `goalAdj: -325` (`state.js:344`) feeds directly into `recommendedCal()` (`engine.js:31`). |
| **Muscle & protein** | "1.6 g protein / kg bodyweight" (`index.html:449`) | Andrea's `goalAdj: +60` ("small muscle-gain surplus", `state.js:356`) plus a higher `kP` split (26% for both profiles, `state.js:349, 361`) and a higher absolute-calorie base; see the §2 note above on the g/kg gap. Recipe-level: `AUTO_TAG_THRESHOLDS.muscleProteinMinG = 25` g/serving tags a recipe `muscle` (`library.js:102`). |
| **Heart & metabolic** | "High fiber, low sodium, Mediterranean base" (`index.html:450`) | Enforced via the fiber ≥25g/day and sat-fat ≤33%-of-fat targets in §2. Recipe-level: `AUTO_TAG_THRESHOLDS.heartFiberMinG = 5` AND `heartSatFatMaxShare = 0.33` together tag a recipe `heart` (`library.js:103-104, 155`). (Low-sodium is UI copy only — no sodium field exists in `FOODS`, so it is not code-enforced; see §5.) |
| **Beautiful skin** | "Low-GI, omega-3 up, dairy/sugar down" (`index.html:451`) | Maps to the `lowGI`/`omega3` food flags (`foods.js:33-34`) and the `skin` recipe tag (hand-tagged in `data/recipes.js`, mapped for display via `TAG_PILL_MAP.skin`, `state.js:184`). No automatic "dairy/sugar down" threshold exists in `deriveRecipeMeta()` — that clause is UI copy, not an enforced rule (see §5). |
| **Hashimoto's-friendly 🦋** | "Selenium, moderate iodine, anti-inflammatory" (`index.html:452`) | Elena's `hashi:true` (`state.js:347`) gates the selenium ≥3 sources/wk coverage target (§2, `render.js:275`) and the `AUTO_TAG_THRESHOLDS.seleniumMinG = 15` g rule that tags a recipe `thyroid` (`library.js:98, 140`). "Moderate iodine" and "anti-inflammatory" are UI copy without a matching numeric guardrail in the code found (see §5) — `foods.js:33-34` does carry a `highIodine` flag on individual foods, but no code path caps a person's weekly iodine intake. |

---

## 4. Nutrition flags & recipe-tag auto-classification thresholds

### 4.1 Food flags (per-ingredient)

Declared vocabulary, `app/data/foods.js:33-34`: `lowGI, omega3, selenium, highIodine, glutenFree, highFiber, fermented`. Each `FOODS[id].flags` array is hand-assigned per ingredient (e.g. `mixed-berries` → `['lowGI']`, `foods.js:51`).

Display labels currently defined, `app/js/library.js:342`: `FOOD_FLAG_LABELS = {lowGI: 'Low-GI', omega3: 'Omega-3', highFiber: 'High fiber', glutenFree: 'Gluten-free'}` — `selenium`, `highIodine`, `fermented` have no display label yet (flagged as a gap by `WISHLIST-plan.md:78`, out of scope for this doc).

### 4.2 Recipe tags — auto-derived for custom recipes

`deriveRecipeMeta()` (`app/js/library.js:129-183`) computes `{tags, styles, avoid}` for any user-built recipe from its ingredients + computed totals — nothing is typed in. Thresholds, all named constants at `library.js:96-112`:

| Constant | Value | Effect |
|---|---|---|
| `omega3MinG` | 40 g | Any `omega3`-flagged ingredient ≥40g in the dish → tag `omega3` (`library.js:97, 139`) |
| `seleniumMinG` | 15 g | Any `selenium`-flagged ingredient ≥15g → tag `thyroid` (`library.js:98, 140`) |
| `highFiberMinG` | 6 g/serving | Total recipe fiber ≥6g/serving → tag `highFiber` (`library.js:99, 141`) |
| `lowGICarbContributorMinG` | 5 g carbs | An ingredient counts as "carb-contributing" once it supplies ≥5g carbs to the dish (used to decide `lowGI` eligibility) (`library.js:100-101, 145-150`) |
| — | — | `lowGI` tag requires **every** carb-contributing ingredient to itself be `lowGI`-flagged (vacuous-truth guarded: a dish with zero carb contributors doesn't qualify) (`library.js:143-150`) |
| `muscleProteinMinG` | 25 g/serving | Total protein ≥25g/serving → tag `muscle` (`library.js:102, 152`) |
| `heartFiberMinG` | 5 g/serving | Combined with `heartSatFatMaxShare` below → tag `heart` (`library.js:103, 155`) |
| `heartSatFatMaxShare` | 0.33 (33%) | `satFat/fat ≤ 0.33` AND fiber ≥5g/serving → tag `heart` (`library.js:104, 154-155`) |
| `quickMaxMinutes` | 15 min | Prep time ≤15 min → tag `quick` (`library.js:105, 160`) |
| — | — | `veggie` tag: no ingredient is in the hand-picked `ANIMAL_FOOD_IDS` list (fish/meat/poultry; excludes eggs and plant proteins) (`library.js:113-121, 157-158`) |

**Style thresholds** (`AUTO_STYLE_THRESHOLDS`, `library.js:107-112`):

| Constant | Value | Effect |
|---|---|---|
| `highProteinKcalShareMin` | 0.28 (28%) | Protein-kcal share of total kcal ≥28% → style `highprotein` (`library.js:108, 165-167`) |
| `lowCarbMaxG` | 30 g/serving | Total carbs ≤30g/serving → style `lowcarb` (`library.js:109, 168`) |
| `balancedCarbKcalShareMax` | 0.55 (55%) | Carb-kcal share >55% drops the default `balanced` style, unless it's the only style left (never leaves `styles` empty) (`library.js:110-111, 169-171`) |

**Avoid-key inference** (`library.js:173-180`): `Dairy` category → `lactose`; ingredient in `GLUTEN_FOOD_IDS` (`library.js:123`) → `gluten`; `prawns` → `shellfish`; ingredient in `NUT_FOOD_IDS` (`library.js:124`) → `nuts`.

---

## 5. Data sourcing & honesty / simplifications

From the `app/data/foods.js` header comment (`foods.js:1-42`):

- **Sourcing**: mostly **USDA FoodData Central** (FDC id noted per entry where an exact match exists; "-style" means a representative FDC entry for that food class was used, not an exact id lookup), plus a couple of **CREA-style Italian references** for farro and bresaola where USDA has no close match (`foods.js:9-14`). Values rounded to 1 decimal (kcal to whole numbers).
- **kcal policy**: Atwater 4/4/9 general-factor computation from sourced protein/carb/fat grams, EU-style (fiber counted within carbs) — see §1.3 for the full quote (`foods.js:16-25`).
- **Deliberate simplification, stated honestly**: computed kcal for very fibrous, low-calorie vegetables can read a little higher than some published USDA "kcal" columns, because USDA sometimes uses refined, food-specific energy factors that discount fiber further than the general 4/4/9 rule. Mesa explicitly keeps the general-factor approach for internal consistency and documents the gap rather than silently deviating per-food (`foods.js:20-25`).
- **Composite ingredients**: mockup shorthand like "Roasted mixed veg" gets one pragmatic blended entry (a weighted average of its components, documented in that entry's `src` field) *plus* the individual components as their own separate foods, so both recipes and precise substitution keep working (`foods.js:27-30`).
- **Not yet enforced despite being named in goal copy**: no sodium field exists anywhere in `FOODS`, so "low sodium" (Heart & metabolic, `index.html:450`) is not a coded rule. No weekly iodine cap exists despite the `highIodine` food flag (`foods.js:34`) and "moderate iodine" copy (Hashimoto's, `index.html:452`) — only the selenium coverage target (§2) is actually gated on the thyroid goal.
- **Design-doc vs. shipped gap**: `MVP-plan.md:120-123` describes calorie-goal offsets as *ranges* ("−300–500 kcal for fat loss, +200–300 for muscle gain") and protein as bodyweight-derived; the shipped code instead uses two **fixed** per-person constants (`goalAdj -325`/`+60`, `state.js:344, 356`) and a %-of-calorie split (§1.2, §2 note) — not a live recompute from the selected goal set. Both are real numbers in the app; they just aren't the same mechanism the earlier planning doc sketched.

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
