# Mesa — Wishlist batch plan (for Sonnet agents)

Elena's wishlist, broken into agent-executable tasks. Ends with a single deploy to
**https://mesa-9y5.pages.dev/app/**.

## Read first (hard constraints — every task)

From [PWA-MVP-plan.md](PWA-MVP-plan.md) "Ground rules for every agent task" and [README.md](README.md):

1. **Deterministic numbers** — nutrition is always summed from ingredients (`engine.js:recipeNutrition`); never type kcal/macros into data.
2. **No frameworks, no build step** — plain HTML/CSS/JS, globals, no modules. The app lives in `app/`.
3. **Visual parity with the locked design.** `mesa-prototype.html` is the frozen reference — **never edit it**. New UI must match the existing sage/terra/gold palette and card/pill/`.seg` idioms already in `app/css/mesa.css`.
4. **iPhone Safari** — tap targets ≥ 44px; inputs ≥ 16px so iOS doesn't zoom.
5. **localStorage-only** state (`mesa.v1`, `js/state.js`). If you add persisted state, bump the store version + add a migration.
6. **Validators must stay `ok:true`** — run `data/validate.js` mentally / in-browser after any data change.
7. **Verify in a real browser before reporting done** (use the preview/browser tools; iPhone viewport 375px). No "should work."

File map: `js/state.js` (store + migrations) · `js/engine.js` (targets + recipeNutrition) · `js/planner.js` (deterministic planner, swaps, coverage, shopping) · `js/render.js` (all DOM paint) · `js/library.js` (custom foods/recipes, ingredient/recipe sheets, icon mapping) · `js/app.js` (boot/nav) · `data/foods.js` + `data/recipes.js` + `data/validate.js`.

---

## Sequencing

```
Parallel wave A (independent, no conflicts):
  T1 Profile menu bar        (index.html + render.js + mesa.css)
  T5 Filter recipes/ingredients (library.js + mesa.css)
  T7 KNOWLEDGE-BASE.md       (new doc only)
  T4 App bookmark icon       (icon assets + manifest + worker asset)  ← image-gen, long-running

Wave B (depends on T7 for its vocabulary):
  T6 Week diet-summary line  (planner.js + render.js + mesa.css) — needs T7's target constants

Wave C (icon content — long-running image-gen, can start any time but merge last):
  T2 Complete ingredient icons (assets/ingredients + library.js mapping)
  T3 More icons across pages   (mesa.css + section markup)

Final (serial, after all merged + verified):
  T8 Deploy to mesa-9y5.pages.dev
```

T2/T3/T4 use the **`watercolor-ingredient-icons` skill** and an image-generation tool — assign these to an agent that has both. Keep them off the critical path.

---

## T1 — Profile section menu bar (jump-to-section)

**Goal:** A sticky horizontal chip bar at the top of the Profile screen that jumps to any section.

**Files:** `app/index.html` (`#profile` section), `app/js/render.js`, `app/css/mesa.css`.

**Approach:**
- The Profile `<section id="profile">` is a long scroll with these `<h2>` headers (in order): *Whose plan · Basics · Macro split · Health goals · Meals we share · Foods to avoid · Connections · Food library · Couple sync · Your data · About*. Give each of those `<h2>` (or its wrapping block) a stable `id` (e.g. `id="sec-basics"`).
- Insert a nav bar immediately after the Profile `<h1>`/intro: a horizontally-scrollable row of `.seg`-style chips (reuse existing `.seg` / `.pill ghost` look, add `overflow-x:auto`, hide scrollbar). One chip per section. Make it `position:sticky; top:0; z-index` above cards, with the app's background so content scrolls under it.
- On chip tap: `document.getElementById('sec-...').scrollIntoView({behavior:'smooth', block:'start'})`. Account for the sticky bar height with `scroll-margin-top` on the target sections.
- Optional polish: highlight the active chip on scroll via an `IntersectionObserver` over the section ids (nice-to-have; skip if it risks jank).

**Acceptance:**
- Every section reachable in one tap; nothing scrolls under the sticky bar and gets hidden.
- Bar itself scrolls horizontally on 375px; chips ≥ 44px tall.
- Switching profile (Elena/Andrea) and re-rendering doesn't duplicate or break the bar.

**Verify:** 375px viewport, tap each chip, confirm the right `<h2>` lands at the top edge.

---

## T5 — Filter recipes & ingredients by category and/or tag

**Goal:** Filter chips in both the **Ingredients** sheet and the **Recipes** sheet. Data already exists; only UI + filter logic is new.

**Files:** `app/js/library.js`, `app/css/mesa.css`.

**Available facets (already in the data):**
- Ingredients (`FOODS`): `cat` ∈ {Produce, Protein, Dairy, Pantry, Bakery, Frozen} and `flags` ∈ {lowGI, omega3, selenium, highIodine, glutenFree, highFiber, fermented}.
- Recipes (`RECIPES_DB`): `slot` ∈ {breakfast, lunch, dinner, snack} and `tags` ∈ {thyroid, skin, heart, muscle, lowGI, omega3, highFiber, quick, veggie}.

**Approach — Ingredients** (`buildFoodLibrarySheet` / `libFoodIdsByCategory` / `renderLibFoodListMarkup`, `library.js:292–338`):
- Under the existing search input, add two chip rows: **Category** (the 6 cats) and **Tag** (the flag set, using `FOOD_FLAG_LABELS` for display; add labels for `selenium/highIodine/fermented`). Chips toggle on/off (multi-select). Track state in a module var like `libFoodFilters = {cats:Set, flags:Set}`.
- Extend `libFoodIdsByCategory(query)` to also drop foods failing the active category set (if any) or missing any active flag (AND across flags is fine; document the choice). Keep the existing text search working alongside filters.
- Show an "N ingredients" count and a "Clear" chip when any filter is active. Empty-state text already exists.

**Approach — Recipes** (`buildMyRecipesSheet`, `library.js:490`):
- Add the same pattern: a **Meal** chip row (4 slots) and a **Tag** chip row (9 tags). Filter the `ids` list before rendering. Reuse `TAG_PILL_MAP`/`tagLabelForPreview` for tag labels so wording matches the rest of the app.

**Constraints:**
- Reuse existing `.pill ghost` / active-pill styles — do **not** invent a new visual language.
- Filters are view-only (no persistence needed) — reset each time the sheet opens is acceptable, but keep them live-reactive while open (re-render list on toggle, like `onLibFoodSearchInput` already does).

**Acceptance:** Category+tag combine with search; toggling re-renders instantly; "Clear" resets; counts correct; ≥44px chips.

**Verify:** Open both sheets, filter (e.g. Produce + High-fiber; dinner + thyroid), confirm results match the data.

---

## T6 — Week screen: 1-line "what this week's diet accomplishes" summary

**Goal:** Under the "This week" header (and reflecting the This/Next toggle), one computed line summarizing what the week achieves — a short tag list + one headline metric. **Depends on T7** for the target constants so the wording is consistent with Insights.

**Files:** `app/js/planner.js` (new pure helper), `app/js/render.js` (`renderWeek`, `render.js:188`), `app/css/mesa.css`.

**Approach:**
- Add a deterministic helper in `planner.js`, e.g. `summarizeWeekPlan(plan, personKey)`:
  - Iterate the 28 meals for `personKey` across `plan.days`, resolve each recipe, and (a) tally recipe `tags` frequency, (b) sum computed nutrition via `recipeNutrition` to get avg **fiber/day**, **omega-3 meals/wk**, **avg protein/day**, **sat-fat share** — the same metrics Insights uses.
  - Produce: up to 3 headline **tags** (most-frequent recipe tags mapped to friendly words via `TAG_PILL_MAP`, e.g. "Thyroid-friendly · Omega-3 rich · High-fiber") **plus** one hard number that clears a T7 threshold (e.g. "≈28g fiber/day" when ≥25, or "protein on target"). All phrasing/thresholds pulled from the T7 constants — no free-floating magic numbers.
  - Must be **deterministic** and reflect the plan actually shown (respect `weekScreenShowsNext`).
- In `renderWeek`, paint the summary into a new element right under the `.sub` intro (before the `#weekSeg` toggle, or right under it — match spacing). Recompute on every `renderWeek()` call and when the This/Next toggle flips (it already calls `renderWeek`). Also update on profile switch (already re-renders).
- Style: a single `.why`-style or pill-row line; keep it one visual line that can wrap to two on 375px. No new color language.

**Acceptance:** Line changes correctly between This/Next week and between Elena/Andrea; numbers match what the plan/`recipeNutrition` produce; nothing typed in by hand.

**Verify:** 375px, toggle This/Next and profiles, spot-check one metric by hand against the day meals.

---

## T7 — KNOWLEDGE-BASE.md (the doc Elena asked to examine)

**Goal:** One readable Markdown doc that consolidates Mesa's "how we determine a healthy diet" logic — currently scattered across code + planning docs — into something a human can read and an agent can cite. **This is a prerequisite for T6** (it defines the target vocabulary/constants).

**Files:** new `KNOWLEDGE-BASE.md` at repo root. **No code changes** — a documentation task (extract, don't invent).

**Must contain, sourced from the existing code/docs (cite file:line):**
- **Energy & macros:** Mifflin–St Jeor × activity + goal (`engine.js`); Atwater 4/4/9 kcal policy and EU fiber-in-carbs choice (`data/foods.js` header).
- **The numeric health targets Mesa actually enforces** (from `planner.js:buildInsightCallouts` & coverage): fiber ≥ 25 g/day; saturated fat ≤ 33% of total fat; protein ≥ personal goal (1.6 g/kg for the muscle goal); omega-3 ≥ 3 meals/wk; selenium ≥ 3 sources/wk when the thyroid goal is on; adherence band ±10% of target, 5/7 days.
- **The goal profiles** and what each tilts (`index.html` Health goals + `ux-research-notes.md`): Gentle fat loss, Muscle & protein, Heart & metabolic, Beautiful skin, Hashimoto's-friendly.
- **Nutrition flags & recipe tags** and the auto-classification thresholds (`library.js:AUTO_TAG_THRESHOLDS` / `AUTO_STYLE_THRESHOLDS`).
- **Data sourcing & honesty** (USDA FoodData Central / CREA; the deliberate fiber-vegetable kcal simplification) from `data/foods.js`.
- A short **"limits / not medical advice"** note mirroring the Profile disclaimer.

**Acceptance:** Every quantitative claim traces to a file:line in the repo; no new nutrition rules invented; T6 can import its numbers by reference. Add a one-line pointer in README's Docs list.

---

## T2 — Complete the ingredient icons (watercolor set)

**Goal:** Extend the 6 existing watercolor icons to cover the high-frequency ingredients so recipe/library/shopping views stop falling back to emoji. **Uses the `watercolor-ingredient-icons` skill.**

**Current state:** `app/assets/ingredients/` has only `carrot, eggs, milk, pasta, rice, sugar`. `FOODS` has ~75 ingredients; `library.js:INGREDIENT_ICON_ASSETS` + `FOOD_ICON_KEYS` + `ingredientIconKeyForFood` map foods→icons with emoji fallback.

**Approach:**
1. Invoke the `watercolor-ingredient-icons` skill and follow its style + workflow exactly (translucent washes, ivory paper, readable at 48px, no outlines/text/shadows). Use the existing 6 as the style reference so the new ones match.
2. Prioritize by usage: the ingredients appearing across the 11 recipes and the most common `FOODS` (salmon, greek-yogurt, spinach, lentils, quinoa, chicken, berries, oats, olive-oil, avocado, broccoli, bell-pepper, walnuts, brazil-nuts, tomato, chickpeas, banana, honey, chia-seeds, tuna, sweet-potato…). Aim for ~25–35 that cover the majority of what's shown; **`log()`/note explicitly which foods still fall back to emoji** — no silent partial coverage.
3. Save project copies to `app/assets/ingredients/<foodId>.png`, ~512px square (skill step 3).
4. Wire them: add entries to `INGREDIENT_ICON_ASSETS` and either exact-id keys in `FOOD_ICON_KEYS` or extend the name-regex fallbacks in `ingredientIconKeyForFood`. **Prefer exact `foodId` keys** for built-ins (most reliable); keep regex only for custom-food fallbacks.

**Acceptance:** Icons render at 48px in the ingredient list, recipe ingredient rows, and shopping list; every wired food resolves to its own icon; the emoji-fallback list is documented. File sizes reasonable (these ship in the PWA cache — keep each PNG lean).

**Verify:** Open the Ingredients sheet + a recipe detail; confirm icons load (no broken images, no console 404s) at iPhone size.

> ⚠️ Cache note for T8: new files under `app/assets/` are served fine, but the service worker (`sw.js`) only precaches the shell — confirm icons load on a fresh install after the CACHE bump.

---

## T3 — More icons across the app pages

**Goal:** Add tasteful iconography to the content screens so they feel less text-heavy — **without** breaking visual parity.

**Files:** `app/index.html` section headers, `app/css/mesa.css`. Optionally small inline SVGs (match the tabbar's stroke style: `viewBox="0 0 24 24" stroke="currentColor" stroke-width:2`).

**Approach (pick the high-value, low-risk spots):**
- Section `<h2>` headers on Profile/Insights get a small leading stroke-icon (reuse the tabbar SVG idiom, `currentColor`, sized ~18px) — consistent set, not random emoji.
- Empty states and the "More ways to log" / Connections rows already use emoji; unify anything that looks ad-hoc.
- Keep it a **coherent icon system** (all line-SVG, or all watercolor, not a mix). Line-SVG for UI chrome; reserve watercolor strictly for food/ingredient art.

**Constraints:** No layout shifts that break existing spacing; icons decorative (`aria-hidden`); don't regress contrast/parity. When in doubt, fewer + consistent beats more + noisy.

**Acceptance:** Screens read as intentionally iconographed; no broken alignment at 375px; a11y labels unaffected.

**Verify:** Screenshot Profile + Insights before/after at 375px; confirm parity with the design language.

---

## T4 — New app bookmark icon: watercolor cornucopia of healthy foods

**Goal:** Replace the current sage bowl-and-steam icon with a **cornucopia of healthy foods, painted in watercolor** — cuter, warmer. **Uses the `watercolor-ingredient-icons` skill** for style direction (but this is the app/home-screen icon, so it must also read as an app icon).

**Files:** `app/icons/` (`icon.svg` source is vector today — the new art is raster/watercolor, so add PNGs), `app/icons/icon-192.png`, `icon-512.png`, `icon-512-maskable.png`, `icon-180.png`; `app/manifest.webmanifest`; `app/index.html` (`apple-touch-icon` links, currently pointing at the **worker**: `https://mesa-sync.elenanesi55.workers.dev/assets/icon-180.png?v=...`); and the worker-served asset if kept.

**Approach:**
1. Generate a watercolor cornucopia (horn of plenty spilling healthy foods — greens, berries, squash, grains, fish/egg accents), warm ivory paper feel, on a soft rounded-square field that works as an iOS home-screen icon. Must read at 60px (home screen) and 120/180px.
2. Export the required sizes: **192, 512, 512-maskable** (maskable needs ~10% safe-zone padding so nothing important is clipped by the circle mask), and **180** for `apple-touch-icon`.
3. Update `manifest.webmanifest` icon entries and bump the `?v=` query on the `apple-touch-icon` links in `index.html`.
4. **Decide the apple-touch-icon host:** it currently loads `icon-180.png` from the **sync worker** (`worker/`), not from Pages. Either (a) also update/redeploy that worker asset, or (b) **repoint `index.html` to a local `icons/icon-180.png`** on Pages (simpler, one less deploy surface — recommended). Document the choice.
5. Keep `icon.svg` only if you also produce a vector version; otherwise remove the stale bowl SVG references so nothing points at the old mark.

**Acceptance:** All manifest sizes present and non-broken; maskable safe-zone correct (test in a maskable previewer mentally — key art inside the safe circle); apple-touch-icon updated and cache-busted; installing to iOS home screen shows the new watercolor icon.

**Verify:** Load manifest, check each icon path 200s; resize check; confirm no reference still points at the retired bowl icon.

> This is a home-screen icon — installed users only see it after removing/re-adding the PWA. Note that in the deploy summary so Elena knows to reinstall to see it.

---

## T8 — Release to https://mesa-9y5.pages.dev/ (serial, last)

**Only after T1–T7 are merged and browser-verified.** Follow [README.md](README.md) "Deploy (both, in this order)":

1. **Bump `app/sw.js` CACHE** — current value is `mesa-v15`; set to `mesa-v16` (installed clients only refresh on a version bump). Any shell/asset change (all of T1–T6 + new icons) requires this.
2. Run `data/validate.js` in-browser and confirm `ok:true` after all data touches.
3. Commit + `git push origin main` (repo `elenanesi/mesa`; git creds in macOS keychain).
4. Cloudflare Pages deploy (stage root `index.html` + `app/` into a temp dir, then):
   ```
   CLOUDFLARE_API_TOKEN=$(security find-generic-password -a mesa -s cloudflare-token -w) \
   CLOUDFLARE_ACCOUNT_ID=84766baa4ad939ee067626830dd2f8dc \
   npx wrangler pages deploy . --project-name=mesa --branch=main --commit-dirty=true
   ```
5. If T4 chose to keep the worker-served apple-touch-icon, redeploy `worker/` too; if it repointed to local, no worker deploy needed.
6. Post-deploy: load https://mesa-9y5.pages.dev/app/ (behind Cloudflare Access — Elena/Andrea only), hard-refresh, confirm the new features render and the new icon assets 200. **Report** the deployed CACHE version + note that home-screen icon changes require reinstalling the PWA.

**Deploy is the only irreversible/outward-facing step — do it once, at the end, after verification.** Do not deploy per-task.

---

## Suggested agent assignment

- **Agent 1 (UI/logic):** T1 → T5 → T6 (T6 after T7 lands).
- **Agent 2 (docs):** T7 (fast; unblocks T6).
- **Agent 3 (image-gen, has the watercolor skill):** T4 → T2 → T3.
- **Any agent, last:** T8 deploy, after the others merge and self-verify.

Each agent: read the ground rules, work in `app/`, verify in-browser at 375px, and report exactly what was and wasn't done (including the emoji-fallback list for T2).
