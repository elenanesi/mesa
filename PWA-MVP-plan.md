# Mesa — PWA MVP build plan (agent playbook)

Date: 10 July 2026 · Owner: Elena · Executor: Claude (orchestrating Sonnet agents) · Status: ready to start

**Goal:** turn `mesa-prototype.html` (mockup v5) into a **free, installable PWA** — no Apple Developer account, no Apple Health, no third-party apps. Elena and Andrea add it to their Home Screens from Safari; it works offline and remembers everything.

**Phase 1 (this plan) is 100% deterministic.** No LLM key, no AI calls. Everything AI-flavored in the mockup becomes rule-based code: menu generation is a constrained picker over a hand-checked recipe database, "why this fits you" is template text driven by tags, re-balance is a small solver. **Phase 2 (later, not in this plan):** LLM endpoint behind a serverless function for menu *ideas* and friendlier text; couple-sync backend.

---

## Ground rules for every agent task

These are hard constraints. Include them verbatim in each agent brief.

1. **Deterministic numbers.** Every displayed number is computed from data (Mifflin-St Jeor, sums over the food DB, % splits). A recipe's nutrition is ALWAYS the sum of its ingredients — never typed in. No `Math.random()` in anything user-facing.
2. **No build step, no frameworks, no dependencies.** Vanilla HTML/CSS/JS in plain files. What's in the repo is what ships. (Cheaper models are far more reliable without tooling, and debugging stays trivial.)
3. **Visual parity with the mockup.** `mesa-prototype.html` is the locked design. Same CSS custom properties, classes, copy tone, layout. Do not redesign anything.
4. **iPhone Safari is the target.** Tap targets ≥44px, no hover-only UI, test at 375–430px widths. English app copy.
5. **Local-first.** All state in `localStorage` under a single versioned key (`mesa.v1`). Read once at boot, write through a single `saveState()`. No accounts, no network calls at runtime (except the service worker serving cached files).
6. **Verify before reporting done.** Serve locally, exercise the changed flow in a real browser (the orchestrator has a preview harness), check console for errors. A task that "should work" is not done.

## File layout (target)

```
health_app/
  app/                    ← the PWA (this is what gets deployed)
    index.html            ← shell: markup for all 6 screens (from mockup)
    css/mesa.css          ← extracted styles
    js/
      state.js            ← state object, load/save, migrations
      engine.js           ← targets (Mifflin-St Jeor), macro math, guardrails
      planner.js          ← menu generation, swap, re-balance, shopping list
      render.js           ← all DOM rendering (per screen)
      app.js              ← boot, navigation, event wiring
    data/
      foods.js            ← food DB: per-100g nutrition, tags
      recipes.js          ← recipe DB: ingredient refs + quantities, steps, tags
    manifest.webmanifest
    sw.js                 ← service worker (offline cache)
    icons/                ← app icons (SVG source + PNGs)
  mesa-prototype.html     ← frozen reference mockup (do not edit anymore)
  PWA-MVP-plan.md         ← this file
```

---

## Phase A — Scaffold & persistence (2 tasks)

**A1. Split the mockup into the app skeleton.**
Copy `mesa-prototype.html` into `app/` split as above (markup → `index.html`, styles → `css/mesa.css`, script → the `js/` modules, cut the desktop-only phone frame: the app now fills the viewport). Plain `<script src>` tags in dependency order — no ES modules needed, keep the current global style. *Acceptance:* `app/index.html` served locally is pixel-equivalent to the mockup and every existing interaction still works (tabs, profile switch, steppers, sheets, shopping list, onboarding). Console clean.

**A2. Persistence layer.**
`state.js`: one `STATE` object holding both profiles (body stats, DOB, activity, goalAdj, calCustom, macro split), SHARED slots, servings, week plan, log history, checked shopping items, onboarding-seen flag. `loadState()` at boot with schema version + defaults for missing keys; `saveState()` called from every mutating action. *Acceptance:* change weight, set custom calories, log a lunch, check 3 shopping items, toggle lunch to shared → hard-reload → everything is still there. Clearing site data yields a fresh first-run with onboarding.

## Phase B — Real data (2 tasks, parallelizable)

**B1. Food database.**
`foods.js`: ~60 hand-checked foods (the ones in current recipes + staples a Mediterranean couple in Italy actually buys). Per 100g/100ml (or per piece for eggs etc.): kcal, protein, carbs, fat, satFat, fiber, plus flags (lowGI, omega3, selenium, highIodine, glutenFree, category for the shopping list). Values from standard published nutrition tables, rounded sensibly; add a `source` comment per food. *Acceptance:* an independent check of 10 random foods against public tables is within ±10%; every food has every field; no duplicates.

**B2. Recipe database.**
`recipes.js`: 30–36 recipes (5–6 per slot per plan style — balanced / high-protein / lower-carb), each: ingredient list as `[foodId, grams]`, steps, tags (thyroid-friendly, skin, heart, low-GI…), emoji, prep time. Include the 10 mockup recipes, migrated so their nutrition is now COMPUTED from B1 foods (their displayed kcal may shift slightly — that's correct behavior, not a bug). Every recipe passes the avoid-list test data (no lactose-heavy items untagged etc.). *Acceptance:* a validation script (include it: `data/validate.js`, runnable in console) asserts every ingredient id resolves, every recipe computes non-zero macros, kcal in a plausible band per slot (breakfast 300–650, lunch 400–750, dinner 400–800, snack 100–350).

## Phase C — Deterministic engine (3 tasks, sequential)

**C1. Nutrition & targets core (`engine.js`).**
Port v5's target engine (BMR, activity, goalAdj, custom override + band clamp, macro split guardrails) unchanged. Add: `recipeNutrition(recipe, servings)` summing over foods; per-serving and per-person portions; good/sat fat split from real ingredient data (no more 75/25 approximation). *Acceptance:* Elena's defaults still land on 1,820 (2,480 Andrea); recipe screens show computed values matching hand-checked sums for 3 recipes.

**C2. Menu planner (`planner.js`).**
Deterministic week generation: for each person/day/slot pick from the recipe DB matching plan style, avoid-list, and shared-slot rules (shared slots: one recipe for both, per-person portions solve each person's kcal share; solo slots: per person), targeting each day within ±5% of daily kcal and ≥ protein target, with a variety rule (no recipe repeats within 3 days). Use a seeded deterministic order (e.g. sorted scoring, tie-break by recipe id) so the same inputs always produce the same week. Swap = same slot, same style, closest kcal, show deltas. Re-balance = the existing "fewest changes to close weekly gaps" behavior, now real: compute weekly nutrient coverage from the DB and greedily swap ≤2 meals that most improve the worst gap. *Acceptance:* generated week for both people hits kcal within ±5%/day and protein ≥ target; changing macro split visibly rebuilds the menu; re-balance provably improves the reported gap; same profile state twice → identical week.
**C2 razor:** if full per-day optimization gets hairy, it's acceptable for MVP to hit weekly averages within ±5% with days within ±12% — say so in the report rather than gold-plating.

**C3. Explanations & shopping list.**
"Why this fits you": template sentences assembled from recipe tags × the person's goals ("Salmon brings omega-3 for your skin goal; selenium supports your thyroid focus"), with the existing "general guidance, not medical advice" line. Weekly shopping list: reuse the v5 aggregation, now over the *generated* week and real food categories from B1; checked items persist (A2). *Acceptance:* every recipe shows a non-generic explanation mentioning at least one active goal; shopping totals for one hand-computed day match exactly.

## Phase D — Logging & insights (1 task)

**D1.** Plan-first logging writes real `LogEntry`s (person, date, recipe/food, portions, computed kcal/macros) to state; manual quick-add from the food DB (search by name); Today's ring/bars read from today's log; Insights computes from history: 7-day kcal-vs-target bars, weekly adherence band ("5 of 7 days in your band" = within ±10% of target), average protein/fiber, sat-fat cap tracking. Empty-history states designed (first week shows "log a few days to unlock insights"). *Acceptance:* log across 3 simulated days (devtools date shift or injected fixtures) → insights numbers hand-verify; band counts days correctly.

## Phase E — PWA shell (1 task)

**E1.** `manifest.webmanifest` (name Mesa, standalone display, portrait, theme `#6f8f76`, icons); icon set generated from a simple SVG mark (sage rounded square, "M" or bowl glyph) exported to 180/192/512 PNG (Apple touch icon link included); `sw.js`: pre-cache the app shell on install, cache-first for same-origin GETs, version-stamped cache name so deploys invalidate cleanly, register from `app.js`. *Acceptance:* Lighthouse (or manual checklist) passes installability; with the local server killed, a previously loaded app still fully works on reload; bumping the SW version serves fresh files.

## Phase F — Ship it (2 tasks)

**F1. Repo & deploy.** `git init` the project (first commit: mockup + plan + app), create a GitHub repo, enable GitHub Pages serving `/app` (or move app to `/docs` if simpler). Result: a public HTTPS URL. *Note for Elena: repo will be public unless you prefer private + Netlify/Cloudflare Pages — say so before this task.* *Acceptance:* the URL loads on iPhone Safari; Add to Home Screen yields a standalone full-screen app with the Mesa icon; offline relaunch works.

**F2. Backup / transfer (poor-man's sync).** Profile gains "Export my data" (downloads/share-sheets a JSON of the full state) and "Import data" (file picker, validates schema version, confirms before overwrite). This is how Elena ⇄ Andrea move a plan between phones until Phase 2 sync. *Acceptance:* export on one browser profile, import on a clean one → identical state.

**Docs task (with F1):** update `install-and-test-guide.md` — the PWA URL becomes the primary path (AirDrop section demoted to "mockup archaeology"); update `MVP-plan.md` §8 build path.

---

## Orchestration notes (for the conductor, i.e. me)

- One Sonnet agent per task above; B1‖B2 can run in parallel, everything else sequential with a verification gate (preview harness: serve `app/`, drive the flow, check console + numbers) before the next phase starts.
- Each brief = the task section above + the 6 ground rules + relevant file paths + "report what you changed, constants chosen, and any deviation with reason".
- After every phase: commit. After C and D: hand-check 3 numbers end-to-end (food → recipe → day → week → shopping list).
- Est. size: 10 agent tasks. The risky ones are A1 (regression surface) and C2 (solver) — review those diffs personally, budget a fix-up round each.

## Explicitly OUT of scope for this MVP

LLM anything (Phase 2) · live Elena⇄Andrea sync (Phase 2, needs backend) · Apple Health / HealthKit (requires native build — revisit only if the PWA feels limiting) · barcode scan & photo logging · notifications (PWA push on iOS needs the installed-app context; park it) · App Store / TestFlight.
