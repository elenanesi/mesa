# Mesa — UX & Behaviour-Change Research Notes

## Findings

### 1. Best-in-class nutrition app UX (2025-2026)
- **MacroFactor**: praised for adaptive targets (adjusts calorie/macro goals weekly from actual weight trend, not a fixed static number) and for logging that "did not feel like a burden" because entry is fast. Steep learning curve, no free tier. [Hoot: MacroFactor alternatives](https://www.hootfitness.com/blog/9-best-macrofactor-alternatives-for-smarter-simpler-nutrition-tracking)
- **Cronometer**: best for micronutrient depth and wearable/lab integration, but 2025-2026 reviews show a surge of complaints about intrusive full-screen video ads interrupting the logging flow, and a "technical," time-consuming logging UI. [Hoot: Cronometer alternatives](https://www.hootfitness.com/blog/cronometer-alternatives-find-the-best-fit-for-your-tracking-style)
- **Yazio**: cleanest, most beginner-friendly visual design; good recipe inspiration + fasting timer; smaller food database, key features paywalled. [Fitia: Yazio alternatives](https://fitia.app/learn/article/best-yazio-alternatives-2026/)
- **MyFitnessPal**: April 2026 "Today tab" redesign triggered widespread Reddit backlash for *adding* friction to daily logging — a cautionary example that redesigns must reduce, not increase, taps-to-log. Barcode scan and custom macros are Premium-gated, a common complaint. [Ellim: best nutrition apps 2026](https://www.ellim.app/blog/fitness/best-nutrition-tracking-apps-2026)
- **Cross-app theme**: manual entry is cited as the #1 reason people quit tracking; AI photo/voice logging cuts per-meal logging time from ~28s (manual) to ~3s, which is described as the friction reduction needed to sustain logging past week 3. Apps that make logging "a scavenger hunt through duplicate entries and unclear portions" get punished in reviews. [aqron: top nutrition app features 2026](https://aqron.app/blog/top-nutrition-app-features-smarter-tracking-2026)
- Takeaway for Mesa: since Mesa is plan-first (menus generated ahead) rather than log-first, it should lean into its structural advantage — planning removes most manual entry — but the Log/Add screen still needs near-zero-friction confirmation ("yes I ate this," one tap) rather than a search-and-enter flow.

### 2. Couples / household meal planning
- **KitchenSync** and **Fitia (Partner Meal Syncing)**: let two people cook and eat the *same* recipe while each is served a different, automatically-scaled portion size to hit individual macro targets — explicitly framed as "same dinner, different macros." [Nutrola: best app for couples 2026](https://nutrola.app/en/blog/best-weight-loss-app-for-couples-2026), [PlanEatAI](https://planeatai.com/blog/meal-planning-for-couples-with-different-goals-2026)
- **Nutrola**: shared recipe database with accurate per-serving nutrition; each partner logs their own plate independently.
- **MyFitnessPal Meal Planner**: household setup captures number of people, per-person cuisine preference/dislikes/allergies, and which meals are shared vs individual.
- Consistent pattern across all of these: **one recipe, one shopping list, per-person portion multiplier** — never a fully separate recipe per person unless dietary needs diverge (e.g. allergy). This matches Mesa's "one spine, tilted per person" model well.

### 3. Behaviour-change evidence (academic)
- **Meal planning correlates with diet quality**: in a NutriNet-Santé cohort of 40,554 adults, people who usually/always planned meals and used shopping lists had significantly better diet quality and lower obesity prevalence than non-planners (association, not proven causal). [PMC5288891](https://pmc.ncbi.nlm.nih.gov/articles/PMC5288891/)
- **Self-monitoring frequency and weight loss**: a systematic review of behavioural weight-loss interventions found monitoring frequency correlated with outcomes in several studies (e.g., r = -0.49 to r = 0.71 across different studies), and people completing ≥80% of expected self-monitoring episodes lost ~3.5 kg more than those below that threshold. However, the review also found *low-intensity* monitoring approaches worked about as often (67% of studies) as *high-intensity* ones (61%) — i.e., consistency matters more than exhaustiveness of logging. [PMC8928602](https://pmc.ncbi.nlm.nih.gov/articles/PMC8928602/)
- **Nutrition-app behaviour-change scoping review**: only 24% of studies even measured maintenance; of those, 64% sustained change at 6-12 months and 36% declined/dropped off — long-term adherence is the hard part, and app quality ratings track with the number of behaviour-change techniques embedded (goal-setting, feedback, self-monitoring, prompts/cues). [JMIR mHealth scoping review](https://mhealth.jmir.org/2023/1/e41235)
- **Streaks/guilt framing**: recent UX-ethics writing (Smashing Magazine, Feb 2026; UX Magazine) converges on: streak mechanics reliably drive short-term engagement but also produce guilt, anxiety, and app-avoidance when a streak breaks. The recommended alternative is "ethical" flexible framing — e.g. a weekly adherence band or "flex day" allowance instead of a hard daily streak, and a "quiet reset" with no shame messaging when a day is missed. [Smashing Magazine: designing streak systems](https://www.smashingmagazine.com/2026/02/designing-streak-system-ux-psychology/)

### 4. Mobile UI patterns
- **Bottom sheets**: NN/g and Material Design both treat bottom sheets as the standard pattern for contextual actions/choices that don't need a full navigation change (e.g., picking an alternative, adjusting a setting) — they keep context visible above the sheet, unlike a full-screen modal. [NN/g: Bottom Sheets](https://www.nngroup.com/articles/bottom-sheet/)
- **Steppers**: best used for linear multi-step flows (checkout, onboarding); a simple +/- quantity stepper (not a full wizard stepper) is the standard control for portion/serving adjustment. [Mobbin: Stepper examples](https://mobbin.com/explore/mobile/ui-elements/stepper)
- **Onboarding**: target the "aha moment" within the first 60 seconds and 3 screens or fewer before showing real value; each extra screen before value costs ~10-15% completion. Defer every permission (notifications, camera, health data) until the exact moment it's needed by a specific feature, not up front — 82%+ of users want a stated reason before granting. [Appcues: onboarding guide](https://www.appcues.com/blog/essential-guide-mobile-user-onboarding-ui-ux); [UserOnboard: permission priming](https://www.useronboard.com/onboarding-ux-patterns/permission-priming/)

---

## Concrete recommendations for the Mesa mockup

1. **Make "confirm today's plan" the primary Log interaction, not free-text search.** Since Mesa's meals are pre-planned, Log/Add should default to one-tap "✓ ate this" / "swap" / "skip" on each planned meal card, with manual search as a secondary fallback. *Why:* manual entry is the #1 reason people abandon tracking apps; Mesa's plan-first architecture can almost eliminate it.

2. **Swap should open as a bottom sheet, not a new screen**, showing 2-3 alternative meals with kcal/protein/fat deltas vs. the original ("−80 kcal, +6g protein") plus each swap's health tags. *Why:* bottom sheets preserve the context of the plan underneath and are the established pattern for contextual, short-lived choices (NN/g).

3. **Show per-person portion scaling directly on shared-recipe cards**: e.g. "Elena 1×  ·  Andrea 1.5×" with a small stepper to nudge either portion, on one shared recipe rather than two separate recipes. *Why:* this is exactly the "same dinner, different macros" pattern that the best couples-focused apps (KitchenSync, Fitia Partner Sync) converged on, and it matches Mesa's existing one-spine-tilted-per-person model.

4. **Replace/avoid a hard daily streak; use a flexible weekly adherence band** (e.g., "5/7 days on target" with a built-in flex day) framed positively, and a "quiet reset" with no red/guilt styling when a day is missed. *Why:* 2025-2026 UX-ethics consensus is that hard streaks drive short-term engagement but cause guilt-driven avoidance; a weekly, forgiving framing fits Mesa's "calm/premium not clinical" design language better than a punitive streak counter.

5. **Keep onboarding to ≤3 screens before the first real menu is shown**, collecting only what's required to compute Mifflin-St Jeor targets (sex, age, height, weight, activity, goal, Elena/Andrea profile) — defer notification permissions until the user taps something that needs them (e.g., "remind me to log dinner"). *Why:* every added pre-value screen costs ~10-15% completion; permission grant rates are higher when requested in-context.

6. **Add a lightweight weekly review moment on the Week screen** (e.g., "This week: hit selenium & omega-3 targets 6/7 days, protein on track") rather than only a forward-looking plan. *Why:* self-monitoring/reflection frequency correlates with outcomes, but the evidence also shows low-intensity, consistent check-ins work about as well as exhaustive logging — a once-a-week reflective summary is a good low-friction compromise.

7. **Surface the shopping list as a first-class, always-current artifact**, auto-generated from the accepted week plan and updated live when a meal is swapped. *Why:* the NutriNet-Santé cohort found shopping-list use was independently associated with better diet quality alongside meal planning itself.

8. **On the Recipe detail screen, keep the "why this fits you" box short and tag-based** (e.g., "Low-GI · Selenium-rich · Hashimoto's-friendly" for Elena; "High-protein · Surplus-friendly" for Andrea) rather than paragraph explanations. *Why:* best-reviewed apps (Yazio, MacroFactor) win praise for clean, scannable UI; long nutrition-education text is a common complaint (Cronometer feels "technical").

9. **Use a numeric +/- portion stepper (not a slider or wizard) for adjusting serving size** on any meal or recipe. *Why:* steppers are the established mobile pattern for small, precise quantity adjustments; sliders are imprecise for something like "1.5×" portions.

10. **Gate any AI-generated content visually and textually as "suggestion," with the deterministic numbers always rendered from the verified database**, e.g. a small "AI idea" chip on meal cards vs. plain numeric macro data with no chip. *Why:* Cronometer/MacroFactor's credibility advantage comes from users trusting the numbers are exact; Mesa should make the AI-vs-verified-math boundary visually obvious so trust isn't diluted as AI features are added.

11. **Default the Elena/Andrea switch to remember last-used profile per device** rather than resetting to a default person each open. *Why:* reduces one extra tap on the highest-frequency screen (Today) for a two-person household app — a small but compounding friction cost.

12. **On the calorie ring / macro bars, show a small "adjusted for today" affordance if targets flex** (e.g., after a logged workout or a skipped meal) rather than silently changing the ring. *Why:* MacroFactor's most-praised feature is transparent, adaptive targets; users need to see *why* a number moved to trust it, otherwise adaptive math reads as a bug.

13. **Keep the coach note on Today short (1-2 lines) and specific, not generic encouragement** (e.g., "Dinner is light on omega-3 today — tonight's swap options include salmon" rather than "You're doing great!"). *Why:* behaviour-change literature ties effective apps to concrete, actionable feedback/prompts (a core BCT), not vague praise.

14. **For the Insights screen, prioritize trend-over-time framing (weekly/monthly nutrient coverage) over single-day snapshots.** *Why:* the self-monitoring review found weight/adherence trend tracking outperforms single daily numbers for sustaining motivation, and it also naturally surfaces Hashimoto's-relevant micronutrient coverage (selenium, iodine) which is a slow-moving signal better shown as a trend than a daily gauge.

15. **Avoid full-screen interstitials or ads-style takeovers anywhere in the logging flow** (even for internal messaging like "rate the app" or upsell prompts). *Why:* Cronometer's sharpest 2025-2026 review complaints are specifically about full-screen takeovers interrupting mid-log; this is a direct anti-pattern to avoid as Mesa adds any monetization or engagement prompts later.
