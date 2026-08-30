# Mesa — expert panel setup & learnings

How the cross-functional "expert panel" was convened to drive Mesa's product decisions,
its consensus principles, and how to **re-spawn it** for a new problem (e.g. reconciling
"Ate out" vs "Eating out"). The panel is a PM technique: spawn domain-expert subagents,
have them analyse the same grounded facts through different lenses, then synthesize.

## The five personas

1. **Senior UX designer** — interaction design + information architecture.
2. **Doctor / registered nutritionist** — physiology + public-health guidance; honest about
   evidence strength; keeps claims non-clinical.
3. **Senior software engineer** — feasibility, risk, reuse of existing machinery, determinism.
4. **Psychologist — habit formation & app engagement** — behaviour change, anti-guilt framing.
5. **Chef & neuro-food-marketing expert** — culinary craft + the sensory/behavioural science of
   appetite and menu appeal. Makes dishes genuinely *crave-able* and appetising: flavour layering
   (acid/fat/umami/heat/texture contrast), naming and description that trigger appetite
   (sensory/provenance words, the "menu-engineering" effect), colour and plate variety, and the
   "healthy can still be delicious" reframe. Partners with the nutritionist so appeal and balance
   pull the same direction — never adds craveability by quietly loading sugar/salt/fat. Lens to
   append when spawning: *culinary interest + sensory appeal + appetising naming/description;
   which dishes are boring, monotonous, or read as "diet food"; concrete swaps/additions that
   raise desire WITHOUT breaking the nutritionist's numbers; concerns to raise to the nutritionist.*

Research backbone: `ux-research-notes.md` (best-in-class app UX, couples patterns,
behaviour-change evidence, mobile UI patterns) and `KNOWLEDGE-BASE.md` (Mesa's
claim-classification policy).

## Convening pattern (what worked)

1. **Ground first.** Spawn 1–3 `Explore` subagents to map the exact code for the problem
   area (data structures, functions, `file:line`). Don't let experts reason from guesses.
2. **Spawn the 4 personas in parallel** as `general-purpose` Sonnet agents (analysis only,
   no edits). Each gets: (a) a **shared brief** — product context + the code facts from step
   1 + the specific problems; (b) a **role-specific deliverable** — what to analyse through
   their lens + "concerns to raise to the other panelists".
3. **PM (the main agent) synthesizes** — resolve tensions explicitly, pick an approach, and
   ask the owner only the genuine forks.
4. Implement via Sonnet agents; verify in the no-auth preview; ship per deliverable.

Not every problem needs all five — spawn the lenses the problem calls for (e.g. a recipe-content
pass is chef + nutritionist; a flow redesign is UX + psychologist + engineer).

Cost note: the panel is expensive (4+ agents). Convene it for genuine cross-functional
product decisions, not mechanical work. The owner will usually say "involve the experts".

## Shared-brief skeleton (reuse verbatim, fill the brackets)

> Mesa is a plan-first meal-planning PWA for a (solo/two-person) household. Calm/premium,
> NOT clinical. Deterministic verified macros are the trust anchor. Nutrition: WHO fibre
> 25 g/day, free sugars <10% energy, sat fat <10% energy; per-person Mifflin–St Jeor
> calories. [PROBLEM STATEMENT + the code facts: relevant functions with file:line, current
> behaviour, what already exists to reuse.] Produce analysis/recommendations ONLY — no
> edits. Give prioritized recs (P0/P1/P2) with one-line rationale, and concerns to raise to
> the other panelists.

Per-role lens to append:
- **UX:** screens/components/flows; reuse existing patterns (bottom sheets, steppers,
  `chip-computed` badge, band classifiers); keep it calm; how it reads without being punitive.
- **Nutritionist:** physiology + WHO evidence; distinguish Guideline vs Estimate vs Mesa
  rule; give concrete defensible numbers; never overclaim/medicalize.
- **Engineer:** where it hooks in (file:line), reuse vs new, determinism, migration/D1/build
  discipline, risk (esp. "starve-a-slot" if constraining generation).
- **Psychologist:** habit model (cue→routine→reward / Fogg B=MAP), anti-guilt framing,
  where a well-intentioned mechanic could backfire.

## Consensus principles the panel produced (the guardrails)

These constrain all Mesa nutrition/engagement work — honor them:

- **Weekly average is primary; per-day bands are a soft secondary guard.** Nutrient-specific,
  **never a hard generation constraint** (starve-a-slot), and a **Mesa product rule, not a
  clinical threshold** (only the daily WHO figures are "Guideline").
- **Nutrient cadence (nutritionist):** fibre needs a per-day **band (floor + comfort
  ceiling** ~15–43 g — benefits are daily, and sudden loads cause GI distress); free sugars
  and protein are **near-daily** (caries frequency; MPS is meal-by-meal); **sat fat and
  calories legitimately average over a week**. Per-day band multipliers currently in
  `PER_DAY_BANDS` (state.js): kcal ±25%, protein 0.8× floor, fibre 0.6× floor / 1.7× ceiling,
  free sugars 1.5× ceiling, sat fat 1.8× ceiling.
- **Directional, never pass/fail (psychologist).** The week is the unit of judgment, a day is
  a "contribution". Flex band + "quiet reset", **no streaks**, no red-for-eating — avoid the
  all-or-nothing "what-the-hell effect". Reward compensation as agency, never frame the high
  day as wrong.
- **Deterministic-trust boundary (UX + nutritionist).** Estimated macros rounded (5 g / and
  labelled *estimated*) and visibly distinct from computed; **do NOT reuse the `chip-computed`
  "✓ computed" badge on estimates** — that means verified-from-ingredients.
- **Keystone habit = one-tap daily confirm** (evening-anchored, self-suppressing prompt).
  Weekly plan-approval is a secondary ritual.
- **Couple mechanics:** share the plan + shopping list; keep **per-person adherence private**
  (avoid surveillance/reactance). No partner leaderboards.
- **Engineer risk lens:** prefer reusing existing machinery (swap/side solver, band
  classifiers, typed-macro food path) over new; keep generation output deterministic; any
  built-in catalog change needs a D1 re-seed; commit explicit paths.

## How the principles shaped what shipped

- Balance = **directional display + quiet planner** (per-day dots, "N of 7 balanced") + a
  soft, strictly-improving `autoBalancePlan` pass — NOT a hard generation constraint.
- Restaurant quick-add reused the typed-macro food + `occasional` + `eatenOut` rails, with an
  *estimated, not verified* label (not the computed badge).
- Recipe additions were designed by a nutritionist-lens agent to fill fibre/balance gaps
  within the owner's tastes, with moderate per-dish fibre (no bombs) and modest sat fat.

## Re-spawn recipe (for a new problem, e.g. #5a Ate-out vs Eating-out)

1. `Explore` the two flows: `toggleWeekMealEatenOut` + the "Eating out" toggle
   (render-today.js), `openAteOutSheet`/`commitAteOut` (render-today.js),
   `createAteOutFood` (library.js), `eatenOut`/`markSlotSkipped` (log.js), and how the
   shopping list/pantry treat each (pantry.js `pantryConsumedSince` skips `eatenOut`).
2. Spawn UX + nutritionist + engineer + psychologist with the shared brief + the two flows'
   facts, asking for a single 360° model where both "log the planned meal as eaten out
   (keep its macros)" and "log my own estimate for a meal Mesa didn't plan" remain possible
   and un-confusing.
3. Synthesize, confirm the one genuine fork with the owner, implement, verify in preview, ship.
