# Mesa — MVP Plan
*A daily & weekly diet app for you and Andrea. Eat well, together.*

Date: 29 June 2026 · Updated: 10 July 2026 (mockup v5) · Owner: Elena · Status: MVP design / mockup phase

---

## 1. The one idea that makes this work

You listed five goals — weight management, macros/muscle, heart & metabolic health, beautiful skin, and a Hashimoto's-friendly diet. The temptation is to build five separate rule engines. The research says you don't need to, and shouldn't.

**Every one of your goals points at the same eating pattern.** A Mediterranean-style base — vegetables, legumes, whole grains, fish, olive oil, nuts, lean protein, low added sugar — is the most evidence-backed pattern for heart and metabolic health, is the anti-inflammatory pattern recommended for Hashimoto's, is low-glycemic and omega-3-rich (which is what skin research actually supports), and is easy to hit protein and calorie targets within. So the app has **one nutritional spine** and then *tilts* it per person and per goal, rather than juggling contradictory diets.

That tilt is the product. The differences between you and Andrea aren't different diets — they're different **dials** on the same plan:

- **Calories & protein** scale to each person's body and goal (you: gentle deficit; Andrea: small surplus, higher protein).
- **Hashimoto's tilt (you):** prioritise selenium (Brazil nuts, fish), keep iodine *moderate* not high, keep it anti-inflammatory. Note: the evidence does **not** support blanket gluten-free unless you have celiac or tested gluten sensitivity — so the app treats gluten as a *personal toggle*, not a default rule.
- **Skin tilt (you):** keep glycemic load low, push omega-3, dial dairy and added sugar down — these are the dietary levers with the most support in dermatology research.
- **Avoid-list (both):** anything either of you can't or won't eat is hard-excluded.

This is also why the AI piece can stay accurate (Section 6): the *what to eat* is creative, but the *numbers and the rules* are fixed.

> Mesa gives general nutrition guidance, not medical advice. Because Hashimoto's is a medical condition, the plan should be sanity-checked with your doctor or a dietitian — especially anything touching iodine, selenium supplements, or going gluten-free.

---

## 2. What the MVP is (and isn't)

**Is:** a beautiful, genuinely usable app for two people that (a) generates a daily and weekly menu, (b) shows accurate calories and nutrients, (c) tilts the plan to each person's goals and health needs, (d) lets you swap meals and avoid foods, and (e) tracks how you're doing.

**Isn't (yet):** social features, restaurant/eating-out logic, grocery delivery integration, photo-based food recognition, or a huge recipe marketplace. These are post-MVP.

The mockup you have (`mesa-prototype.html`) covers the full MVP surface so you can feel the layout before any real code is written.

**Mockup v2 (8 July 2026)** upgraded the prototype based on a UX research pass over the best-reviewed nutrition apps (MacroFactor, Yazio, Cronometer, Lifesum) and behaviour-change evidence:

- **Plan-first logging** — the Log screen now leads with today's *planned* meals and one-tap ✓ Confirm / 🔁 Swap / ✕ Skip. Manual search/scan is secondary. (Logging friction is the #1 reason people abandon tracking apps; planning ahead beats tracking after.)
- **Swap is a bottom sheet** with 2–3 alternatives showing kcal/protein *deltas* and matching health tags — not a blind reshuffle.
- **Per-person portion scaling** on shared recipes ("Elena 1× · Andrea 1.5×" with +/− steppers) — one dish, two targets, the core couples insight.
- **Weekly adherence band instead of streaks** — 7 gentle dots, "5 of 7 days in your band". Streaks reliably cause guilt-and-abandon cycles; bands don't.
- **Real shopping list** — categorised (Produce/Protein/Pantry), checkable, generated from the week.
- **3-screen onboarding** (value promise → pick your profile → "your first week is ready"), skippable, no permission prompts — permissions stay at point-of-use in Profile.
- **AI/math separation made visible** — AI-suggested content carries a "✨ Suggestion" chip; computed numbers carry "✓ computed". Trust in the deterministic engine is a UI feature, not just an architecture choice.
- **Navigation fixes** — recipes remember where you came from; each meal opens its own recipe; week days expand inline to their meals.

The full research notes with sources are in `ux-research-notes.md`.

**Mockup v3 (8 July 2026)** — Elena's refinement round:

- **Shared-meals model.** By default you and Andrea share **dinner only**; breakfast, lunch and snack are planned per person. Any meal slot can be toggled shared/solo in Profile → "Meals we share". Shared meals carry a "👥 Together" pill and use *one recipe with a portion per person* (the Elena/Andrea steppers); solo meals get a single servings stepper and can differ entirely between you (e.g. your yogurt bowl vs Andrea's omelette at breakfast).
- **Good vs bad fats.** Fat is now split into "good fats" (unsaturated — olive oil, fish, nuts) and "sat. fat" everywhere it matters: under the fat bar on Today, per-serving in every recipe's nutrition grid, a "% fats unsaturated" tile on Insights, and a weekly **sat-fat cap** (not a target — staying under is the win) in the Week coverage grid.
- **Calories by macro.** Today shows a stacked bar of where your calories come from (protein/carbs/fat at 4/4/9 kcal per gram), and each recipe shows its own kcal split. All "✓ computed", never estimated.
- **"Re-balance my week" now explains itself.** Tapping it opens a sheet stating exactly what it does — *keeps fixed:* daily calories & protein, your avoid-list, shared dinners; *optimises:* closes weekly nutrient gaps and adds variety, changing as few meals as possible — with a preview of which meals would change before you apply.

**Mockup v4 (8 July 2026)** — adjustable macro split:

- **You choose where your calories come from.** Profile gains a "Macro split" editor: protein/carbs/fat as % of daily calories, with 5%-step controls and three presets (Mesa default · Higher protein 35/35/30 · Lower carb 30/30/40). Each person has their own split. Total calories never change — only their composition.
- **Deterministic all the way down.** Gram targets are pure math (kcal × % ÷ 4 for protein & carbs, ÷ 9 for fat) and every downstream number recomputes: Today's macro bars, the calories-by-macro chart, the good/sat fat line.
- **Guardrails, gently enforced.** Protein 10–40%, carbs 20–60%, fat never below 20% ("needed for hormones and vitamin absorption"). The three always sum to 100 — stepping one compensates from the largest other.
- **The menu actually changes.** The split classifies into a plan style (protein ≥ 32% → high-protein; carbs ≤ 32% → lower-carb; else balanced) and the daily & weekly menus rebuild to match — skyr bowls and chicken & farro for high-protein, chia pudding and "salmon & greens, no quinoa" for lower-carb — across Today, the Log plan, and the Week. The coach banner confirms: "Rebuilt for your 35/35/30 split. Same calories, same avoid-list." In the real app this is the same constrained solver as re-balance, with the split as an additional hard constraint.

**Mockup v5 (10 July 2026)** — editable profile engine & the household shopping list:

- **One shopping list for the household, and it's real math.** "Generate shopping list" now walks the 7-day plan for *both* people: shared slots are counted once at the sum of your portions (Elena 1× + Andrea 1.5×), solo slots include each person's own recipe, and identical ingredients are aggregated across recipes and days into one line with the total quantity ("Salmon fillets · 1.02 kg"). Categorised (Produce / Protein / Dairy / Pantry), checkable, with "to taste" items in a separate "Pantry staples — check you have these" section. Carries the "✓ computed" chip and states its own rules in the header.
- **Profile basics are editable, and everything downstream recomputes.** Sex, date of birth, height, weight and activity level are now controls, not text. **Age is derived from date of birth** — it updates itself on birthdays and is never typed in. Any change reruns the target engine: Mifflin-St Jeor BMR × activity factor + goal offset (Elena −325 gentle deficit → 1,820 kcal; Andrea +60 surplus → 2,480 kcal at current stats), then macro grams, Today's ring and bars, the Log totals and the coach note. The formula is shown under the calorie row — "BMR 1,384 × 1.55 activity − 325 gentle fat loss = 1,820 kcal recommended."
- **Calories are adjustable — and restorable.** A ±50 stepper on the daily target. The moment your number differs from the recommendation the chip flips to "custom" and a one-tap "↺ Restore recommended (1,820)" appears. If you change body stats *while* an override is active, the override is kept and a note says what Mesa now recommends — transparent, never destructive. Manual targets are clamped to a sane band (≥ BMR × 1.1, ≤ maintenance + 600) with a friendly explanation. The macro split gets the same visible custom/restore state via the existing "Mesa default" preset.

---

## 3. Core features (MVP scope)

The MVP is six screens. In priority order:

1. **Today** — the home screen. Calorie ring, macro bars, today's 3–4 meals with health tags, a one-line "coach" note explaining the day, and quick swap. Profile switch (Elena ⇄ Andrea) lives here.
2. **Week** — 7-day plan, weekly *nutrient coverage* (the smart part: balance is averaged across the week, not forced into every day), shopping-list generation, and a "re-balance my week" action.
3. **Recipe detail** — ingredients (scaled to servings), full per-serving nutrition, cooking steps, and a "why this fits you" explanation tied to your goals.
4. **Log / Add** — fast logging via search / barcode / quick-add, today's running total. The numbers are computed, never guessed.
5. **Insights** — adherence, average protein/fiber, nutrient gaps trending over time, and a weekly review with one concrete suggestion.
6. **Profile** — the engine room: each person's body stats, goals (multi-select), foods to avoid, and phone connections. Changing anything rebuilds the plan.

---

## 4. Screen-by-screen layout notes

**Today.** The calorie ring is the anchor — one glance tells you where you stand. Macros sit beside it as three thin bars (protein first, since it's the goal that matters most for both of you). Meals are cards with a thumbnail, kcal, protein, and 2–3 *health tags* ("Thyroid-friendly", "Skin-supporting", "Low-GI", "Omega-3") so the *why* is visible without tapping. The "Mesa coach" banner gives one human sentence about the day. The Elena/Andrea segmented switch is top-right so swapping context is instant.

**Week.** Lead with nutrient coverage, not the meal list — that's what makes Mesa smarter than a recipe app. Show a small grid of nutrients with % of weekly target; anything low is flagged in terracotta with a plain-language note ("Vitamin D trending low — added eggs Thu & Sat"). Below it, the 7 days as tappable rows with today highlighted. Two actions at the bottom: shopping list, and re-balance. **Re-balance is precisely defined** (and the UI says so before applying): hold daily calories, protein, the avoid-list and shared dinners fixed; then swap the *fewest possible* meals to close weekly micronutrient gaps and break repetition. It's a constrained solver, not a reshuffle — another job for the deterministic engine, with AI only naming candidate dishes.

**Recipe detail.** Big appetising hero, fast facts line (time / kcal / protein / servings), tags, then the "why this fits you" box — this is the trust-builder. Then nutrition, ingredients (auto-scaled to servings), method, and two actions: mark as eaten (logs it) and swap.

**Log.** Four big quick actions (scan, search, meal, water). A running "today so far" list. A standing reminder that numbers are deterministic — this is a feature, say it out loud.

**Insights.** Four stat tiles, a 7-day calorie-vs-target bar chart, a "what's working / watch this" list, and a weekly-review nudge.

**Profile.** Whose-plan switch, basics (sex/age/height/weight/activity → auto-calculated target), goals as multi-select cards, an avoid-list you can add to freely, and phone connections. Every change ends in "Save & rebuild my plan."

Design language: warm cream background, sage-green primary, terracotta accent, generous rounded cards, big tap targets, one accent action per screen. Calm, premium, not clinical.

---

## 5. Data model (MVP)

Keep it small and local-first. Five core objects:

- **User/Profile** — name, sex, **date of birth** (age is always derived, never stored), height, weight, activity level, goals[], avoid[], an optional **manual calorie override** (null while following the recommendation), connections{}. Two profiles share one household, which also holds **sharedSlots{}** — which meal slots are cooked together (dinner by default). Shared slots get one recipe with per-person portions; solo slots are planned per person.
- **Targets** (derived, never stored as truth) — daily kcal from body stats & goal (Mifflin-St Jeor); protein/carb/fat grams from the user's **macro split** (% of kcal, stored per person on Profile, guardrailed 10–40 / 20–60 / 20–45); key micronutrient targets. Recomputed from Profile.
- **Food** — name, serving size, and per-serving nutrition (kcal, macros, key micros, GI flag, tags). This is the source of truth for all numbers.
- **Recipe** — ingredients[] (food + qty), servings, steps[], derived nutrition (sum of foods), tags.
- **PlanDay / LogEntry** — what's planned vs what was actually eaten, per person per day.

Nutrition for a recipe is **always** the sum of its foods — it's computed, not typed in. That single rule is what keeps the app accurate.

---

## 6. The accuracy architecture — deterministic core, AI at the edges

This is the most important engineering decision, and it's exactly right to insist on it. The pattern is **"AI proposes, math disposes."**

**Deterministic core (always runs, no AI):**
- Calorie targets via the **Mifflin-St Jeor** equation (the current standard) × an activity factor → TDEE, then a goal offset (−300–500 kcal for fat loss, +200–300 for muscle gain).
- Protein target from bodyweight (≈1.6 g/kg when muscle is a goal; ~1.2 g/kg otherwise).
- All calorie & nutrient counts = sum over the food database. Never estimated by a language model.
- Hard rules: avoid-list exclusions, moderate-iodine cap for the Hashimoto's profile, low-GI preference for the skin goal, fiber/sodium guardrails for heart goal. These are code, not prompts.

**AI at the edges (optional, swappable):**
- Generating *menu ideas* and recipe variety ("give me 5 thyroid-friendly, low-GI dinners under 600 kcal using salmon").
- Writing the friendly "why this fits you" and weekly-review text.
- Natural-language logging ("I had a chicken caesar") → mapped to database foods.

**How to keep the AI accurate:** constrain it hard. The model only ever *selects from or fills templates around the food database* — it returns structured output (JSON: which foods, which quantities), and then your deterministic code computes the nutrition and **validates** it against the targets. If the AI's suggestion misses targets or includes an avoided food, the code rejects and re-asks. The user never sees an AI-invented calorie number. Set `temperature` low, give it the food list as context, and require it to cite food IDs. This way you get AI creativity with spreadsheet accuracy.

**Key handling:** the Claude or OpenAI key lives on a tiny backend (or a serverless function), never in the app binary. The app calls *your* endpoint; your endpoint calls the model. This keeps the key secret and lets you swap providers without shipping a new app version. For a two-person personal app, a free-tier serverless function (e.g. Cloudflare Workers / Vercel) is plenty.

---

## 7. Phone integrations (you said access is welcome)

Add these only when they earn their place — each one should visibly improve the plan:

- **Apple Health (HealthKit)** — read weight, steps/active energy, and workouts → keeps calorie targets honest automatically. Highest value; do first.
- **Notifications** — meal-prep and shopping reminders; "log your lunch" nudges.
- **Calendar (read-only)** — lighter prep suggestions on busy days.
- **Camera** — barcode scanning for fast, accurate logging (post-MVP: photo recognition).
- **Siri Shortcuts** — "Hey Siri, log my breakfast."

All are opt-in toggles in Profile, with a one-line reason each — never a wall of permission prompts on day one.

---

## 8. Recommended build path

> **Decision (10 July 2026):** Elena chose the **free PWA path** — no Apple Developer account, no Apple Health in the MVP, LLM features deferred to Phase 2. The step-by-step agent playbook is in `PWA-MVP-plan.md`; the Expo/React Native route below stays as the documented alternative if Apple Health ever becomes a must-have.

You're on iPhone (both of you), the mockup is web, and you want to test on-device quickly. The pragmatic path:

**Now (this phase):** iterate on `mesa-prototype.html` until the layout feels right. It already runs on your iPhone via the install guide — no code, no accounts.

**Build phase:** **React Native via Expo.** Reasons: one codebase, runs on your iPhone through the free **Expo Go** app in seconds (no Apple Developer account needed to test), great HealthKit and camera libraries, and the easiest possible path from "web mockup" to "real app." If you later want it on the App Store or to run untethered, you graduate to a TestFlight build (needs the $99/yr Apple Developer account) — but you can go a very long way before that.

**Why not native Swift:** more powerful, but slower to build and you'd throw away cross-platform optionality for no benefit at your scale.

Rough sequence once design is locked: scaffold Expo app → build the 6 screens from the mockup → wire the deterministic engine (targets + nutrition math) → seed a starter food/recipe database → add Apple Health → add the AI suggestion endpoint last.

---

## 9. Honest risks & how the design handles them

- **Garbage-in food data.** The whole thing is only as accurate as the food database. Start with a small, *hand-verified* set of foods you two actually eat rather than importing a huge messy one.
- **AI hallucinating numbers.** Handled by Section 6 — AI never produces nutrition figures.
- **Medical edge (Hashimoto's).** Handled by keeping medical-adjacent rules conservative (moderate iodine, no default gluten-free) and surfacing "check with your doctor" rather than prescribing.
- **Over-scoping.** The six-screen MVP is deliberately the floor. Resist adding screen #7 until these feel great.

---

## Research sources

Hashimoto's & diet: [Nutritional interventions in Hashimoto's — systematic review (WJG, 2025)](https://www.wjgnet.com/2308-3840/full/v13/i1/100523.htm) · [Gluten-free diet in non-celiac Hashimoto's — meta-analysis (Nutrients, 2025)](https://www.mdpi.com/2072-6643/17/21/3437) · [Doubtful justification of gluten-free diet in Hashimoto's (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC9101474/) · [Micronutrients in autoimmune thyroid disorders (PMC, 2025)](https://pmc.ncbi.nlm.nih.gov/articles/PMC12372124/)

Skin & diet: [Nutritional Dermatology — optimizing dietary choices for skin (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC11723311/) · [Diet and acne — systematic review (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC8971946/) · [Glycemic load, dairy & fatty acids in acne](https://link.springer.com/article/10.1007/s40257-020-00542-y)

Weight, protein & TDEE: [Mifflin-St Jeor calculator & guidance](https://www.inchcalculator.com/mifflin-st-jeor-calculator/) · [Mifflin-St Jeor for coaches](https://www.promealplan.com/en/blog/mifflin-st-jeor-equation-coaches-guide)

Heart & metabolic: [Heart-healthy diets — Mediterranean & DASH favored (Cardiovascular Business, 2025)](https://cardiovascularbusiness.com/topics/clinical/heart-health/heart-healthy-mediterranean-dash-plant-based-keto) · [DASH & Mediterranean ranked best for heart health (Healio, Jan 2025)](https://www.healio.com/news/cardiology/20250123/dash-mediterranean-ranked-among-best-diets-for-heart-health-bp-and-cholesterol-control)
