# Planner variety + protein balance — build plan

**Status:** BUILT and deployed 2026-07-20 (P1 c89ef26, P2a a71faec, P2b 5cd52e3, P3 e5b69f4; sw CACHE mesa-07ca32abd3a2; D1 re-seeded to 114 recipes). Decisions Q1–Q2 in §5. Outcome: 0 same-day repeats, 0 cap relaxations, red 0/wk, poultry 3/wk, fish 7–9/wk, 2–3 meatless days — every target met.

**Problem.** The generated week repeats recipes far too often, and puts meat in almost every
meal. Measured on two freshly generated weeks (Elena's side, default profile):

| Symptom | Measured |
|---|---|
| `Snack: Hummus & veg sticks` | **6× in 7 days**, twice on one day |
| `Carrots over hummus` | 4× |
| Meals containing meat/fish/poultry | **15/28**, on **7/7 days** |

Reported from the real app with the same shape: a Monday carrying hummus as the lunch side,
the dinner side AND the standalone snack; a Tuesday with `Pork loin, farro & greens` at both
lunch and dinner.

**Ground rules.** `PWA-MVP-plan.md` → "Ground rules for every agent task" apply unchanged.
The planner is deterministic: same inputs must always produce the same week. `node
tools/check.js` stays at 0 failed; `node tools/build-sw.js` before every deploy.

---

## 1. Root causes (all confirmed in code, not inferred)

1. **Variety history is per-slot.** `lastUsedGap()` (planner.js) reads
   `history[person][slot]`, so lunch and dinner keep separate arrays. **16 recipes are legal
   at both lunch and dinner**; a lunch pick therefore scores with `gap = Infinity` when
   dinner is chosen the same day. → same recipe twice in one day.
2. **Sides only look at yesterday.** `applyLightConsecutiveFilter` is passed
   `sideUse[dayIndex - 1]` only. Nothing consults what is already on *today's* plate, so the
   same side lands at lunch and dinner.
3. **Side pool and snack pool overlap, with no cross-check.** `hummus-veg-sticks` is
   `role:'side'` with `slots:['snack','side']`, so it sits in `sidePoolFor()` AND the snack
   candidate pool. The standalone snack pick never consults side usage. Two recipes are in
   this overlap, both hummus-based.
4. **No weekly repeat cap.** The 3-day gap rule is the only limit, so 6×/week passes.
5. **Protein scoring biases toward meat.** `mealScore` rewards hitting the protein target and
   meat recipes score best on it. The catalog is **60 meatless / 21 poultry / 10 fish / 5 red
   meat** — 63% meatless — yet meat appears in 15/28 meals. **This is a scoring problem, not
   a catalog gap: adding vegetarian recipes will not fix it.** Only an explicit frequency
   constraint will.

### Where the catalog genuinely is too thin

- **Sides: 6 survive the season filter**, feeding ~14 composed slots a week, and
  `SIDE_TOP_K = 4` then prunes by calorie fit so the same best-fitting side keeps winning.
- **Lunch mains: 4** (vs 17 full-meal lunches).

**Dependency that governs the whole plan:** with 6 in-season sides and 14 side slots, a
strict "max 2 per week" is unsatisfiable — the existing relax-to-longest-gap fallback would
fire constantly and nothing would visibly improve. So logic first, caps tuned to what the
catalog supports, catalog last to make the caps real.

---

## 2. P1 — day-wide variety (no new recipes needed)

Fixes causes 1–3. This alone stops hummus×3 and lunch=dinner.

- Add a per-person, per-day usage log: `history[person].dayUse[dayIndex]` holding every
  recipe id placed that day — **mains AND every composed extra**, not just `extras[0]` the
  way `recordCompositionUsage` records today.
- `applyVarietyFilter` excludes ids already in `dayUse[dayIndex]`.
- `applyLightConsecutiveFilter` (sides / breakfast-pairs) additionally excludes today's
  `dayUse`, not just yesterday's `sideUse`/`bfPairUse`.
- Cause 3 then falls out for free: the snack is picked last (`SLOT_ORDER` is
  `[breakfast, lunch, dinner, snack]`), so by then the lunch and dinner sides are recorded.
- **Preserve the never-empty-a-tiny-pool fallback.** Every one of these exclusions must
  degrade to the unfiltered pool rather than returning nothing, exactly as
  `applyLightConsecutiveFilter` already does. A thin pool must still produce a plan.
- Shared meals record into BOTH people's `dayUse` (one dish, both ate it).

**Tests:** no recipe id appears twice in one day across a generated fortnight (mains and
extras counted together); the specific hummus case (side at lunch + side at dinner + snack)
cannot recur; a deliberately tiny pool still generates a full week rather than erroring;
determinism preserved (same seed → identical plan).

## 3. P2 — repeat caps + Mediterranean protein balance

- **Weekly cap per recipe**, as named constants in one place alongside the existing tag
  thresholds. Proposed starting values: mains/fulls ≤2×/week, sides ≤3×/week — tuned to what
  the catalog can satisfy, not to an ideal.
- **Protein-kind frequency (decision Q1, Mediterranean-standard):** red meat ≤1×/week,
  poultry ≤3×/week, fish ≥2×/week, and ≥2 fully meatless days.
  - Classify a recipe by its effective ingredients (including `optionGroups` choices) against
    the existing `ANIMAL_FOOD_IDS` vocabulary in library.js — do NOT hand-tag recipes with a
    new field, and do not re-type the id lists.
  - Implement as a **scoring term plus a hard ceiling**, not a pure filter: a pure filter on
    a thin day would fail to fill a slot. Fish being a *floor* rather than a ceiling means it
    needs a bonus as the week runs out of fish slots, not an exclusion.
- Constants live in ONE documented block, so Elena can retune without hunting through the
  scorer.

**Tests:** a generated fortnight satisfies each limit; the limits are expressed as constants
and not duplicated; a catalog too thin to satisfy a limit still produces a full week
(degrade, never fail); determinism preserved.

## 4. P3 — catalog

- **~10–12 more side recipes**, spread across seasons so the in-season pool is never ~6.
- **More lunch mains** (currently 4) to widen composition.
- Bias additions toward meatless/fish so P2's limits bind comfortably rather than at the edge.
- Every addition keeps `validateData()` at `ok:true`, zero errors/warnings.

---

## 5. Decisions

- **Q1 — protein balance:** Mediterranean-standard — red meat ≤1×/week, poultry ≤3×/week,
  fish ≥2×/week, ≥2 fully meatless days.
- **Q2 — sequencing:** P1 → P2 → P3, each pushed and deployed separately.

## 6. Risks

- **The planner is deterministic and load-bearing.** Every change here alters generated plans
  by design, so the harness's determinism tests are the contract: same inputs → same output,
  even as the output itself changes.
- **Over-constraining a thin catalog** silently degrades to the fallback and looks like "the
  fix did nothing". P2's constants must be chosen against measured pool sizes, and the
  fallback firing should be observable rather than silent.
- **Existing plans are not regenerated.** Pinned and logged meals are preserved by design, so
  improvements appear on newly generated weeks, not retroactively.
