# Mesa — UX review backlog (opened 2026-07-29)

Working doc from the UX review of 2026-07-29 and the five fixes shipped off the back of
it. Everything below is either **deferred on purpose** or **found while fixing something
else**. Each item says what's wrong, why it matters, and what "done" looks like, so it can
be picked up cold.

Convention note: items are ordered by user impact, not by effort. `file:line` citations
were accurate at commit `302f776`; verify before acting (this repo's docs have drifted
before — see KNOWLEDGE-BASE.md §5).

---

## Shipped in this batch (for context)

| Commit | What |
|---|---|
| `c6b6f93` | Reconnected the orphaned `#log` screen, unified meal-action buttons, deleted 4 toast-only fake controls |
| `cc1adb4` | Onboarding writes every answer to the signed-in member's own profile slot |
| `eba0edf` | Every health goal moves a real number; un-pinned calorie goals from slots |
| `609710f` | Dietary preferences are real, multi-select, editable; catalog widened; D1 re-seeded |
| `302f776` | Log screen became a search-and-add picker instead of a second copy of the plan |

Harness went 998 → 1229 tests.

---

## P1 — Worth doing next

### 1. The person switcher is trapped on Today
`#profSeg` lives only in the Today topbar (`app/index.html:33`); `#profWhoSeg` only on
Profile. But Week, Insights and the Log picker are ALL scoped to `currentProf` and render
that person's data with no visible control and no label saying whose it is. In a
two-person household this is the highest-frequency source of "wait, whose numbers am I
looking at."

**Done looks like:** the active person is visible and switchable from every screen that
shows per-person data. Either promote the switcher into a persistent position, or put an
explicit "showing: <name>" affordance on Week/Insights/Log that opens the switcher.

### 2. Today ⇄ Log consolidation was explicitly deferred
The reconnect was shipped as "reconnect now, decide later." The Log screen is still not in
the tab bar — it is reachable only via the centre ＋ FAB → "Log food" — and because
`go('log')` finds no `.tab[data-tab="log"]`, **no tab highlights while you are on it**
(`app/js/app.js:26-29`). That reads as "I don't know where I am."

**Options, unchanged from the original review:** (a) give Log a real tab, (b) fold the
picker into Today as a sheet and delete the screen, (c) leave it on the FAB but fix the
tab-highlight state. Now that Log is a small picker rather than a plan mirror, (b) is more
attractive than it was.

### 3. Onboarding still doesn't ask the things that matter
Untouched by this batch. It asks name, body stats and diets — but never:
- **household size** (solo vs couple), though slide 1 pitches both and `I cook for` is
  buried in Profile → Basics;
- **goals**, so a fresh user finishes at maintenance with every goal off and is never told
  the toggles exist (now that goals actually move numbers, this matters more than it did);
- **allergies / foods to avoid**, the one input with real consequences.

**Also:** `Skip` (`app/index.html:641`) drops the user straight into a fully-computed plan
built on the demo defaults (female, 1997, 168 cm, 64 kg) with no signal that the numbers
are fiction. And it is 5 slides to first value where `ux-research-notes.md` §4 says ≤3.

**Done looks like:** ≤3 screens to a real plan; "Skip" becomes "Fill in later" and leaves a
persistent, dismissible banner on the Today ring until the targets are real.

---

## P2 — Real, smaller

### 4. Snack is a second-class meal
`#todaySnack` (`app/index.html:150`) is the only meal card with `cursor:default` and no
tap-to-recipe, while breakfast/lunch/dinner all open detail. It is also the only slot
excluded from `main + side` composition (by design — see `planner.js`'s B2 notes). The card
looks identical to the others, so the missing affordance reads as a bug rather than a rule.

### 5. Shopping list and Pantry are hard to reach
Shopping: one button, Week screen only. Pantry: two taps deep inside Library. Both are
weekly-cadence, high-intent tasks with no surface on Today at the moment you'd want them
(shopping at the weekend; pantry right after a shop).

### 6. `WHY_RULES` muscle/heart clauses don't gate on the goal
In `app/js/state.js`, the `thyroid` and `skin` "why this fits you" rules gate on the
person's goal toggle, but `muscle` and `heart` are `applies: true` — they show
unconditionally. Pre-existing, and now inconsistent with the goal audit that made those two
goals actually do something. Small fix, deliberately left out of `eba0edf` to keep that
diff scoped.

### 7. Two muscle goals still coexist
`muscleGain` (moves calories) and `muscle` (biases meal picks toward protein) are separate
toggles with adjacent labels. The descriptions now say which is which, but a single
"Muscle" goal with an intensity, or a clearer visual grouping of calorie-goals vs
nudge-goals, would be less confusing.

### 8. Diet combinations are not normalized
Vegan implies vegetarian implies pescatarian, but all three can be ticked at once. Harmless
(the filters are ANDed, and the strictest wins) but it looks careless in the editor.
Decide: normalize on write, or group them as one mutually-exclusive choice plus independent
allergen toggles (gluten-free, lactose-intolerant) — the latter is probably the honest
model, since those two are a different KIND of constraint.

### 9. Profile jump-nav is still long
11 chips after Connections was removed. Chip navs stop being scannable past ~7. Consider
grouping (You / Plan / Data) or collapsing the rarely-used ones.

---

## P3 — Known small stuff

- **Insights contains a nested `<h2>Insights</h2>`** inside the Insights screen.
- ~~`validateData()` emits 5 warnings, all `baked-fish`~~ — **not reproducible (2026-07-29
  re-check).** Ran `validateData()` against the real catalog (current HEAD and, separately, a
  `git archive` of `eba0edf`, the commit this item cited as "pre-existing at"): both report
  `ok:true`, 0 errors, 0 warnings. `recipeMacros('baked-fish')` (no opts, i.e. the default
  combo validateData() actually checks) resolves through `recipeEffectiveIngredients()` —
  base `ingredients` (olive oil + lemon juice) PLUS the default `fish` optionGroups choice
  (salmon, 180g) — giving 459.8 kcal, comfortably inside the `role:'main'` 250–650 band; every
  individual fish choice (salmon 459.8, sea-bass 298.6, sole 285.4, cod 267.8) is in-band too.
  The "96 kcal" this item originally cited is exactly `olive-oil(10g) + lemon-juice(20g)`
  WITHOUT the fish — i.e. what you get by reading `baked-fish.ingredients` directly and
  skipping `optionGroups`, which isn't what `validateData()`/`recipeMacros()` actually do (they
  already went through `recipeEffectiveIngredients()` since the `optionGroups` engine landed,
  well before `eba0edf`). Best guess: whoever wrote this item computed the base-ingredients sum
  by hand rather than calling `recipeMacros()`/`validateData()`. No code or data changed for
  this; `node tools/check.js`'s `data: validateData()` test already asserts `ok:true` and still
  passes. If a real zero-warning regression shows up later, diagnose with `recipeMacros(id)` and
  `recipeMacros(id, {group: choiceId})` directly rather than trusting a hand sum.
- **Library ingredient-count label goes stale while typing a search** (known since the
  2026-07-17 code-health batch).
- **Empty-pool guard fires in a real configuration:** the default avoid list
  (`lactose, raw-onion, spicy`) plus vegetarian + gluten-free starves day-6 lunch. The app
  handles it correctly (honest "no meal fits your filters" card, no crash), but it means the
  measured pool table in KNOWLEDGE-BASE.md §6 is optimistic — it doesn't account for
  per-person avoid lists stacking on top of diets. Widening lunch is the fix.

---

## Process traps hit during this batch (worth institutionalizing)

1. **`build-sw.js` stamps TWO files.** It writes both `app/sw.js`'s `CACHE` and
   `app/js/auth.js`'s `AUTH_BUILD`. Commits `c6b6f93` and `cc1adb4` included only `sw.js`,
   so the deployed build reported a stale build marker — defeating the "which build is
   actually running" diagnostic that README's handoff lessons call the first question to
   ask. **Always `git add app/sw.js app/js/auth.js` together.** Consider a `check.js` guard
   asserting the two hashes match.

2. **The shell's cwd persists between commands.** A `cd worker` for the D1 seed silently
   changed the working directory for every later command. README already warns that this
   once published an empty site; it bit again here (harmlessly, on a grep). Prefer passing
   absolute paths to `wrangler` over `cd`.

3. **Cloudflare's edge briefly serves the previous copy after a deploy.** Two verification
   curls within ~10s of a deploy returned stale HTML and looked like a failed deploy. Wait,
   or re-request with a cache-buster, before concluding anything is wrong.

4. **Catalog changes need a D1 re-seed, not just a Pages deploy.** Built-in recipes load
   from D1 at runtime with `app/data/recipes.js` as offline fallback only, so new recipes
   are invisible until `tools/seed-d1.js` → `wrangler d1 execute` runs. Also: redirect only
   stdout (`> seed.sql`), never `2>&1`, or the progress line lands in the SQL.
