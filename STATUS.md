# Mesa — status & what's next

The one "where things stand" doc. Companions: **README.md** (what Mesa is + architecture),
**AGENT-HANDOVER.md** (how to develop / preview / test / deploy + the gotchas that have bitten),
**EXPERT-PANEL.md** (how to summon the cross-functional design panel) with **ux-research-notes.md**
and **KNOWLEDGE-BASE.md** as its backbone. Full history is in `git log`; this is the summary a
next agent needs to pick up cold.

Prod: **https://mesa-9y5.pages.dev/app/** (Google sign-in + Cloudflare Access). Tests: **1795 green**
(`node tools/check.js`, was 1484).

---

## Shipped

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

**Measurement workstream — amounts & units (owner decisions LOCKED 2026-08-21):**
- **Type amounts everywhere.** Done in the log picker; STILL TO DO in the meal/recipe ingredient
  inputs — the remaining stepper-only `<span class="sv-val">` spots (e.g. `stepMealExtraFoodGrams`,
  the meal builder, recipe/composite grams). Convert to the typeable `input.sv-val` + `parseDecimalInput`
  pattern, keeping the +/- buttons.
- **Ingredient UNIT PICKER** (tbsp / tsp / cup / piece / g → grams). Owner chose a **curated
  high-value subset** (~40–80 foods where volume matters — oils, flours, sugar, honey, rice/grains,
  spreads, spices, liquids — get a per-food `measures:{tbsp,tsp,cup}` gram map; every food keeps
  typeable grams + `piece` where `avgG`/`unit:'piece'` is set) and **convert-&-store-grams** (grams
  stay the deterministic anchor; the input shows the live "2 tbsp = 27 g"; the chosen unit is NOT
  stored). Curate the gram-per-unit weights carefully from standard references — a tbsp of oil ≠ a
  tbsp of flour. Built-in FOODS are file-based, so adding food fields is a Pages deploy (no D1 seed).

**UX-review residuals** (from the retired `UX-REVIEW-plan.md`):
- **Log ⇄ tab bar (P1).** Log is reachable only via the centre ＋ FAB and no tab highlights while on
  it (`app/js/app.js`, `go('log')` finds no matching `.tab`). Options: give Log a real tab, fold the
  picker into Today as a sheet, or fix the highlight state.
- **Long display names clip in the `.seg` person switcher (P2).** The `.seg` component has no
  `max-width`/ellipsis; a name near the 24-char cap clips on all five mounts. Fix is a `.seg` CSS pass.
- **Diet + avoid-list combos can starve a slot (P3).** vegetarian + gluten-free + the default avoid
  list starves day-6 lunch (degrades honestly with a "no meal fits your filters" card). Fix = widen
  the lunch pool — needs a **D1 re-seed**.

## Later-phase levers (deferred, not scheduled)
- **Generation rewire** (balance-aware picks) — a soft, deterministic additive score term at the pick
  sites (`planner.js` `pickSoloMeal`/`pickSharedMeal`, sibling to `tuningBonus`), threading per-day
  running totals in. Declined once (the post-pass suffices); revisit only with fresh determinism +
  demo-week test baselines.
- **LLM-estimated macros** — Cloudflare Workers AI (on-platform) if revisited; always label
  *estimated, not verified* — never the `chip-computed` "✓ computed" badge.
