# Mesa — next tasks handoff

Two owner-requested tasks, ready for a fresh agent to pick up cold. Read
**AGENT-HANDOVER.md** first (develop/preview/test/deploy + gotchas), and
**EXPERT-PANEL.md** for how to convene the design panel (task 6 wants it).

Ground rules that bite here: deterministic numbers; no framework; straight ASCII
quotes as JS delimiters (`node --check` every edited JS file); `node tools/check.js`
green before any deploy; verify in a real browser at
`http://localhost:<port>/app/?preview=1` before reporting done. Mesa's design language
is **calm/premium, anti-guilt — never clinical or gamified**, and it has deliberately
**never colored eating red as a "failure"**. Both tasks below live right on that line,
so hold it consciously.

---

## Task 8 — "Make it obvious what needs correction in the diet"

### Owner ask (verbatim intent)
> "In 8 — make it clear what needs correction. Like a bold + color on sat fats or a
> comparison vs guideline. Right now it's not so obvious what needs correction in the diet."

The free-sugar / saturated-fat concern feature (#8) already ships, but the *signal is
too quiet*: a user glancing at Today can't tell that saturated fat is the thing to fix.

### What exists today (the starting point — don't rebuild it)
- **`macroConcernForDay(day, person)`** — `app/js/planner.js:3522`. Pure read of the
  plan. Returns `{freeSugars:{high,pct,grams,contributors[]}, satFat:{…}}`. `high` is set
  only at the **amber/outlier WHO line** (reuses `perDayBalanceState`; free sugars >10% of
  energy, sat fat at the outlier line — see `NUTRITION_GUIDANCE` in `state.js:101`:
  sat fat target **10% of energy**, free sugars **10% of energy**, fibre 25 g/day).
  `contributors` = per-meal grams of the component, ranked desc, floored at
  `MACRO_CONCERN_MIN_CONTRIB_G` (2 g).
- **Amber dots on the Today macros** — `renderTodayMacroConcerns()` `app/js/render.js:609`
  toggles `#carbsWarnDot` / `#fatWarnDot` (class `.macro-warn-dot`, amber `--balance-off`,
  `mesa.css:134`) next to the Carbs / Fat rows *only when `high`*. These are the current
  "something's off" cue, and they're easy to miss.
- **The popover** — `showArcPopover(macro, event)` `app/js/render-today.js:3223`. Tapping
  the Carbs / Fat bar (or a donut segment / ring centre) opens it. It **always** shows the
  sub-nutrient line (so you can see sat fat / free sugars even when fine), e.g.
  `Saturated fat 22g · 18% of energy`, plus the top-2 contributing meals. When `high` it
  wraps that line in `<strong>…· above the WHO line</strong>` — **but in the same muted ink,
  no color, and no number to compare against.** That is exactly what the owner finds
  un-obvious.
- Colors available as CSS vars (`mesa.css:22`): `--balance-good #5f8a4f`,
  `--balance-minor #94991f`, `--balance-off #cf8a30` (amber). There is also an unused-ish
  `.macro-detail-chip` (amber bg, white text, `mesa.css:137`) that could be reused.

### What to change (direction, not a spec — use judgement)
Make an over-the-line component **unmissable at a glance and explicit in the popover**,
without turning Mesa into a red-alert diet app. Concretely, consider:
1. **Color + weight on the over-line sub-nutrient** in the popover — amber
   (`--balance-off`), not red — so "Saturated fat" visibly stands out from the calm muted
   detail text when it's the thing to fix. (Wrap it in a span with an inline
   `color:var(--balance-off)` or a small class.)
2. **An explicit comparison vs the guideline**, not just "above the WHO line". e.g.
   `Saturated fat 22 g · 18% of energy — WHO suggests under 10%`. Pull the target from
   `NUTRITION_GUIDANCE` so it stays single-sourced; don't hardcode 10.
3. Optionally make the **Today dot** read as more than a dot when high — a tiny amber
   "Sat fat high" chip/label rather than a 7px dot — so the correction is legible on Today
   without a tap. `.macro-detail-chip` already exists for this look.
4. Keep the **calm principle**: amber (the app's existing "off" color), never red;
   framing stays directional ("worth easing down"), never a guilt/failure verb. The #8 red
   overlay was already proposed and **rejected by the full panel** once (see
   `project-*` memory / git around the `d8fdb8f`→`e880ae2` commits) — don't reintroduce red.

This is a small, self-contained UI change (mostly `showArcPopover` + maybe
`renderTodayMacroConcerns` + a CSS token). It probably does **not** need the full panel —
but if you want a second opinion on the calm-vs-clear tension, a quick UX + nutritionist
2-persona consult is cheap. Owner has explicitly asked for MORE visual salience here, so
resolve the tension toward clarity (amber color + a real comparison), not toward more calm.

### Tests / done-when
- Add/extend the `showArcPopover` + `macroConcernForDay` assertions in `tools/check.js`
  (search `showArcPopover` and `testMacroConcern` — both already registered) so a `high`
  day renders the amber emphasis + the guideline comparison, and a fine day stays neutral.
- Verify live: log a high-sat-fat day in `?preview=1`, tap the **Fat** bar, screenshot the
  popover; confirm sat fat is obviously flagged. Do the same for **Carbs** → free sugars.
- `node tools/check.js` green, then build + deploy (client Pages only — no D1, no worker).

---

## Task 6 — Per-meal ingredient substitution on Today (HELD — hand to the panel)

### Owner ask (verbatim intent)
> "Sometimes on 'today's' view I would like to change the ingredients of the recipe/meal
> directly from the meal view without having to actually change the recipe … sub
> strawberries with other fruit."
> Follow-ups: **hold #6 for now**; and now: **"6: document it to have it picked up by the
> panel."**

### Scope already locked with the owner (do NOT re-litigate these)
- **One-off, this day only.** The edit applies to *this* meal on *this* date. It must
  **not** rewrite the underlying recipe in the Library, and must not change other days or
  the partner's copy unless the meal is shared.
- **Inline on the meal view.** The entry point is the Today meal card / today's-meal detail,
  not the recipe editor. (The owner rejected "edit the recipe" — that already exists and is
  the wrong surface for a one-off tweak.)
- Example flow: today's breakfast has strawberries; the user wants blueberries *just today*
  → tap the ingredient on the meal, pick a replacement, done. Macros for today update; the
  saved recipe is untouched; tomorrow's version (if any) still has strawberries.

### Why the panel
This is the trickiest of the UX batch because it collides with Mesa's data model and its
determinism/trust anchor:
- **Determinism**: recipe nutrition is strictly `sum(ingredients)` and the plan regenerates
  byte-identically. A per-occurrence ingredient override is a new kind of plan-entry state
  (like the existing per-meal *extras*, but a *substitution*, not an addition). The engineer
  persona must design where this lives (a per-`planEntry` override map? reuse the
  `components`/extras machinery in `render-today.js`?) so it survives couple-sync
  (`js/sync.js` per-cell merge), the shopping list (`computeShoppingList`), pantry
  subtraction, logging (`logPlanEntry` snapshots components at confirm time), and re-balance
  without corrupting the "regenerates identically" invariant.
- **UX**: how to make "swap one ingredient, just today" discoverable and quick on a phone
  without it being confused with (a) swapping the whole meal (the existing **Swap** sheet),
  (b) adding an extra (existing **＋ Add**), or (c) editing the real recipe. What does the
  meal card show afterwards — "with blueberries (today)"? A revert affordance?
- **Nutritionist**: constrain replacements sensibly (fruit→fruit, keep portion/macros in a
  sane band) vs. let anything go. Should a substitution respect diet/avoid lists?
- **Chef / psychology**: keep it feeling like effortless personalization, not a data-entry
  chore; anti-guilt framing.

### Grounding the panel should read first
- `EXPERT-PANEL.md` (convening pattern) + `ux-research-notes.md` + `KNOWLEDGE-BASE.md`.
- Existing machinery to reuse / not duplicate, in `app/js/render-today.js`:
  `chooseMealExtraRecipe` / `chooseMealExtraFood` (per-meal **extras** — the closest
  existing pattern: they update BOTH the live plan entry and, if the slot is logged, the log
  snapshot), `addMealCtx`, `openAddMealRecipeSheet`; and the swap path
  (`chooseSwapRecipe`, `applySwapToPlan` in `planner.js`) for the whole-meal case.
- `planEntry` shape + `planEntryComponents` / `planEntryNutrition` (planner.js) — a
  substitution likely rides here.
- Couple-sync per-cell merge (`js/sync.js`) — anything added to a plan entry must merge.

### Deliverable from the panel
A short synthesis (owner-facing): the recommended data model for a per-occurrence
substitution, the exact Today UI, the constraints on valid replacements, and the
edge-cases (shared meal, already-logged slot, shopping list, revert). Then implement behind
the usual gates (check.js test + preview verification + deploy). Owner will likely want to
approve the synthesis before implementation, as with previous panel rounds.

---

## Status snapshot for the next agent
- Prod: **https://mesa-9y5.pages.dev/app/**, build `mesa-f627930b8481`. Tests **2379 green**.
- Just shipped (this session): **#7 "Cook from what I have"** — pantry-based meal
  suggestions (Library hub + Pantry page → bottom sheet; `pantryMakeableRecipes` /
  `pantryScoreRecipe` in `planner.js`, `buildPantryCookSheet` in `render-today.js`).
  Commit `c0aa2d1`, deployed.
- Deploy recipe: `node tools/build-sw.js` → `node tools/check.js` (green) → commit explicit
  paths → `git push` → stage `index.html`+`app/`+`_headers` to a temp dir → `wrangler pages
  deploy` (see `mesa-deploy` memory / README for the exact token env vars). No D1 reseed
  unless you change FOODS/RECIPES *fields*.
