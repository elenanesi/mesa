# Mesa knowledge base

Last reviewed: 29 July 2026

Mesa is a meal-planning and food-logging tool. It makes a clear distinction between general public-health guidance, calculated estimates, and Mesa product rules. None of these is medical advice or a diagnosis.

## Claim classification

| Mesa surface | Classification | What it means |
|---|---|---|
| Fibre: 25g/day | Guideline | General WHO healthy-diet guidance for people over 10. Mesa compares a planned or logged daily average with 25g. |
| Free sugars: under 10% of energy | Guideline | WHO guidance. Mesa calculates free-sugar grams × 4 kcal divided by total planned/logged kcal. |
| Saturated fat: under 10% of energy | Guideline | WHO guidance. Mesa calculates saturated-fat grams × 9 kcal divided by total planned/logged kcal. |
| Daily calorie recommendation | Estimate | Mifflin–St Jeor equation using profile data and selected activity factor. It estimates population energy needs; it does not measure metabolism. |
| Recipe calories and macros | Estimate | Calculated from Mesa ingredient data and recipe portions. Calories use 4 kcal/g for protein and carbohydrate and 9 kcal/g for fat. |
| Calorie goal adjustments, macro splits, variety, favourites, target-consistency, tuning | Mesa rule | Product settings that help select meals. They are not clinical or public-health prescriptions. |

## Current planner behaviour

The planner chooses from recipes that satisfy the selected diet and avoid rules, then balances:

- the person’s estimated or custom calorie target;
- the selected macro split and macro-fit scoring;
- shared versus solo meal choices and portions;
- recipe variety and weekly recipe caps;
- optional Mesa preference nudges: more protein, more fibre, less free sugar, or less saturated fat.

The two calorie-target options are Mesa settings: “Gentle fat loss” applies a −325 kcal adjustment to the estimate and “Muscle gain” applies a +60 kcal adjustment. They are intentionally shown as Mesa rules, not medical recommendations. Macro ranges and the ±10% “target consistency” marker are also Mesa rules.

“Muscle & protein” and “Higher fibre, lower saturated fat” are preferences that add a small planner-score nudge. They do not change a person’s medical risk, diagnose a condition, or guarantee an outcome.

## What Mesa measures in Insights

The weekly guidance card shows only measurements Mesa can calculate with a clear comparator:

- fibre in grams per day (the lower household member’s daily average when there are two people);
- saturated fat as a percentage of total energy;
- free sugars as a percentage of total energy.

The old 33%-of-fat saturated-fat threshold was removed because it is not the WHO metric. The correct comparison is saturated-fat energy share. The old 6%-of-energy free-sugar “target” was removed; Mesa now uses the WHO under-10% guidance. There is only one free-sugar measure, not separate target and warning chips.

## Retired rules and claims

Mesa no longer exposes or plans around the following claims because its data/model cannot substantiate them as authoritative, individual guidance:

- Hashimoto’s, thyroid-friendly, gentle iodine, selenium coverage, or iodine moderation;
- skin-supporting meal claims;
- omega-3 meals per week as a coverage target;
- low-GI eligibility as a health claim;
- “heart-smart,” “good fats,” or “easy on digestion” health language;
- fixed weekly red-meat, poultry, fish, or meatless-day quotas presented as health rules.

Legacy saved `skin` and `hashi` goal booleans may still exist in an old local snapshot, but they are ignored. Ingredient flags that support catalog/editor work may remain internally; they are not displayed as health promises or used as coverage targets.

## Information architecture

The app’s **Profile → How Mesa plans** page is the user-facing version of this policy. It contains the claim legend, calculation explanation, current public guidance, Mesa-only rules, limitations, and source links. Contextual “Why?” links from calories, macro controls, planner balance, guidance coverage, and recipe selection lead to the relevant section.

Recipe detail uses **Why Mesa picked this**. This is a planning explanation based on the active measurable preference, calorie/macro fit and variety—not a claim that a recipe treats or supports a health condition.

## Sources

- [WHO healthy diet guidance](https://www.who.int/health-topics/healthy-diet): dietary fibre and saturated-fat guidance.
- [WHO guideline: sugars intake for adults and children](https://www.who.int/publications-detail-redirect/WHO-NMH-NHD-15.3): free sugars under 10% of total energy; under 5% is described as a possible additional benefit, not Mesa’s target.
- [WHO fats and carbohydrates update](https://www.who.int/news/item/17-07-2023-who-updates-guidelines-on-fats-and-carbohydrates): current context for fat and carbohydrate guidance.
- [Mifflin et al., 1990](https://pubmed.ncbi.nlm.nih.gov/2305711/): resting-energy predictive equation used for Mesa’s calorie estimate.
- [EU Regulation 1169/2011](https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=CELEX%3A32011R1169): energy conversion factors used for food-label calculations.
- [EFSA protein dietary reference values](https://www.efsa.europa.eu/en/press/news/120209): 0.83 g/kg/day adult population reference. Mesa does not present its selected protein split as this reference value.

## Limits and safe use

Mesa does not calculate sodium, iodine, selenium adequacy, omega-3 adequacy, glycaemic index/load, micronutrient sufficiency, medication interactions, medical conditions, pregnancy needs, or therapeutic diets. Its recipe/ingredient data and portion estimates can be incomplete or wrong. A qualified clinician or dietitian should guide individual dietary care, particularly for a diagnosis, medication, pregnancy, eating disorder, or therapeutic diet.

## Development notes

- `app/js/state.js` owns `NUTRITION_GUIDANCE`, user-visible goal definitions, recipe display labels and planner-tuning choices.
- `app/js/planner.js` calculates coverage and applies the energy-share formula. `coverageGaps()` must contain only fibre, saturated fat and free sugars unless a new measure has an authoritative source, sufficient data, and a documented calculation.
- `app/js/render-week.js` renders the coverage explanation without redefining targets.
- `app/index.html` contains the user-facing **How Mesa plans** page; keep source links and limitations aligned with this document.
- `tools/check.js` has a nutrition-claims audit that guards against reintroducing retired condition-specific goals, omega-3 coverage, unsupported recipe tags, or the old fat-share metric.
