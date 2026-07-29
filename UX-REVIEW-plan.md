# Mesa — UX review backlog (opened 2026-07-29, updated 2026-07-30)

Working doc from the UX review of 2026-07-29 and the eight batches shipped off the back of
it. What's left below is either **deferred on purpose** or **found while fixing something
else**. Each item says what's wrong, why it matters, and what "done" looks like, so it can
be picked up cold.

Items are ordered by user impact, not effort. `file:line` citations were accurate at
`c0c1f90`; **verify before acting** — two items in the first version of this doc turned out
to be wrong (see "Corrections" below), and this repo's docs have drifted before.

---

## Shipped

| Commit | What |
|---|---|
| `c6b6f93` | Reconnected the orphaned `#log` screen, unified meal-action buttons, deleted 4 toast-only fake controls |
| `cc1adb4` | Onboarding writes every answer to the signed-in member's own profile slot |
| `eba0edf` | Every health goal moves a real number; un-pinned calorie goals from slots |
| `609710f` | Dietary preferences real, multi-select, editable; catalog widened; D1 re-seeded |
| `302f776` | Log screen became a search-and-add picker instead of a second copy of the plan |
| `9a0c008` | Person switcher on every per-person screen (was item 1); build-stamp guard |
| `245bdb0` | Snack opens like any meal; Shopping/Pantry on Today; Profile nav grouped (items 4, 5, 9) |
| `c0c1f90` | WHY_RULES gate on goals; goals editor grouped; diet editor split by kind (items 6, 7, 8) |

Harness 998 → 1344 tests.

---

## Still open

### 1. Today ⇄ Log consolidation was explicitly deferred (P1)
The reconnect shipped as "reconnect now, decide later." Log is still not in the tab bar —
reachable only via the centre ＋ FAB → "Log food" — and because `go('log')` finds no
`.tab[data-tab="log"]`, **no tab highlights while you're on it** (`app/js/app.js:26-29`).
That reads as "I don't know where I am."

**Options:** (a) give Log a real tab, (b) fold the picker into Today as a sheet and delete
the screen, (c) keep it on the FAB but fix the tab-highlight state. Now that Log is a small
picker rather than a plan mirror, (b) is more attractive than it was.

### 2. Onboarding still doesn't ask the things that matter (P1)
Untouched. It asks name, body stats and diets — but never:
- **household size** (solo vs couple), though slide 1 pitches both and `I cook for` is
  buried in Profile → Basics;
- **goals**, so a fresh user finishes at maintenance with every goal off and is never told
  the toggles exist — now that goals genuinely move numbers (`eba0edf`), this matters more;
- **allergies / foods to avoid**, the one input with real consequences.

**Also:** `Skip` drops the user into a fully-computed plan built on demo defaults (female,
1997, 168 cm, 64 kg) with no signal the numbers are fiction. And it's 5 slides to first
value where `ux-research-notes.md` §4 says ≤3.

**Done looks like:** ≤3 screens to a real plan; "Skip" becomes "Fill in later" and leaves a
persistent, dismissible banner on the Today ring until the targets are real.

### 3. Long display names clip in the person switcher (P2)
Found while building the shared switcher (`9a0c008`). The `.seg` CSS component has no
`max-width`/ellipsis, so a display name near the 24-char `DISPLAY_NAME_MAX_LEN` cap clips on
every mount. Pre-existing — the old hardcoded "You"/"Partner" markup just never had a long
enough string to trigger it — but there are five mounts now, so it's more visible. Fix is a
`.seg`-wide CSS pass, deliberately not scope-crept into the switcher batch.

### 4. Diet + avoid-list combinations can still starve a slot (P3)
The default avoid list (`lactose, raw-onion, spicy`) plus vegetarian + gluten-free starves
day-6 lunch. The app degrades correctly (honest "no meal fits your filters" card, no crash),
but the measured pool table in KNOWLEDGE-BASE.md §6 is optimistic: it counts diets alone and
doesn't model per-person avoid lists stacking on top. Widening the lunch pool is the fix —
and it needs a **D1 re-seed**, not just a Pages deploy.

---

## Corrections to earlier versions of this doc

Both found by re-checking rather than re-reading, and both were mine:

- **"`validateData()` emits 5 `baked-fish` warnings" was wrong.** `validate.js` resolves
  `optionGroups` through `engine.js:recipeEffectiveIngredients`, and the throwaway script
  that produced that figure loaded `foods.js`/`recipes.js`/`validate.js` but **not
  `engine.js`** — so it summed olive oil + lemon juice with no fish and got 96 kcal. Loaded
  correctly, `baked-fish` is 460 kcal, inside the `role:'main'` 250–650 band, and
  `validateData()` reports `ok:true` with zero errors and zero warnings — as
  `tools/check.js`'s own test has asserted all along. **Lesson: diagnose catalog numbers with
  `recipeMacros(id)` / `validateData()` in a context with the real file set, never a hand sum
  or a partial vm.**
- **"Library ingredient-count label goes stale while typing" was already fixed** by the
  2026-07-17 code-health batch. I carried it forward from a stale README "known pre-existing"
  note without re-testing.

---

## Process traps (worth institutionalizing)

1. **`build-sw.js` stamps TWO files** — `app/sw.js`'s `CACHE` and `app/js/auth.js`'s
   `AUTH_BUILD`, from one content hash. Commits `c6b6f93` and `cc1adb4` included only
   `sw.js`, shipping a stale build marker and defeating the "which build is actually
   running" diagnostic README calls the first question to ask when sign-in breaks. **Always
   stage both.** Now enforced by `testBuildStampMatch()` in `tools/check.js` (`9a0c008`).

2. **The shell's cwd persists between commands.** A `cd worker` for the D1 seed silently
   changed the directory for every later command. README already warns this once published
   an empty site; it recurred here (harmlessly). Prefer absolute paths over `cd`.

3. **Cloudflare's edge briefly serves the previous copy after a deploy.** Verification curls
   within ~10-20s repeatedly returned stale HTML/JS and looked like failed deploys — twice it
   looked like a real bug, including a spurious `CACHE`/`AUTH_BUILD` mismatch. Wait, and
   re-request with a cache-buster, before concluding anything is wrong.

4. **Catalog changes need a D1 re-seed, not just a Pages deploy.** Built-in recipes load from
   D1 at runtime with `app/data/recipes.js` as offline fallback only, so new recipes are
   invisible until `tools/seed-d1.js` → `wrangler d1 execute` runs. Redirect only stdout
   (`> seed.sql`), never `2>&1`, or the progress line lands in the SQL and breaks it.
