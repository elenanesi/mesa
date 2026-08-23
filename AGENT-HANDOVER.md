# Mesa — agent handover

How to develop, preview, verify, and deploy Mesa. Read this before touching the app.
Companions: [STATUS.md](STATUS.md) (what's shipped / what's next), [EXPERT-PANEL.md](EXPERT-PANEL.md)
(summon the design panel), and the deep architecture notes in `README.md` + `KNOWLEDGE-BASE.md`.

## What Mesa is

A **plan-first** meal-planning PWA for a (usually solo, sometimes two-person) household.
Vanilla JS, **no framework**. Design language: calm/premium, **not** clinical/gamified.
Nutrition follows WHO guidance (fibre 25 g/day, free sugars <10% energy, sat fat <10%
energy) + per-person Mifflin–St Jeor calories. **Deterministic verified macros are the
trust anchor** — recipe nutrition is strictly `sum(ingredients)`, kcal = 4·protein +
4·carbs + 9·fat.

## Repo map

```
app/
  index.html            # app shell + static markup (login gate, sheets, screens)
  css/mesa.css          # single stylesheet
  data/foods.js         # FOODS DB (per-100g / per-piece macros)
  data/recipes.js       # RECIPES_DB (recipe = ingredients [[foodId, grams]], nutrition computed)
  data/validate.js      # validateData() catalog checks
  js/state.js           # NUTRITION_GUIDANCE, PER_DAY_BANDS, PROF, persistence, escapers
  js/engine.js          # foodMacros / recipeNutrition / optionGroups resolution
  js/planner.js         # generateWeek, candidatesFor, swap, rebalance, autoBalancePlan, shopping list
  js/library.js         # foods/recipes library UI + editors + pantry mutator (setPantryRemaining)
  js/render-*.js        # today / week / sheets / recipe / profile screens
  js/log.js             # logHistory API (logFoodEntry, logPlanEntry, setLogEntryEatenOut, markSlotSkipped)
  js/pantry.js          # derived pantryRemaining (never mutates; derives from logHistory)
  js/auth.js            # Google sign-in gate (Phase 3A) + isLocalPreviewMode()
  js/sync.js            # couple sync (KV sections) + D1 library mirror
  sw.js                 # MACHINE-GENERATED service worker (never hand-edit)
worker/                 # Cloudflare Worker (sync + auth) + wrangler.toml + D1 migrations
tools/check.js          # zero-dep regression harness (loads app files in a vm)
tools/build-sw.js       # regenerates sw.js (SHELL_FILES + content-hash CACHE) + auth.js AUTH_BUILD
tools/seed-d1.js        # emits SQL to seed the D1 global (builtin) catalog
```

## Preview locally WITHOUT Google sign-in (IMPORTANT)

Prod is behind Google sign-in + Cloudflare Access. For local UI work there's a safe
demo bypass: `isLocalPreviewMode()` (auth.js) enables demo mode **only** when hostname is
`localhost`/`127.0.0.1` **and** the URL has `?preview=1`. It can never bypass auth in prod.

macOS TCC blocks tool-spawned servers from reading `~/Desktop`, so serve a **copy**:

```bash
PREV=<your scratchpad>/mesa-preview
rsync -a --delete /Users/elena/Desktop/Workspace/health_app/app "$PREV/"
cp /Users/elena/Desktop/Workspace/health_app/index.html "$PREV/"
(cd "$PREV" && python3 -m http.server 8323 >/tmp/mesa-preview.log 2>&1 &)
```

Then open `http://localhost:8323/app/?preview=1` and click **Skip** on onboarding to land
on a fully-populated demo plan. Console helpers: `go('week')` / `go('today')` to switch
screens; `openWeekSwap(mondayOfWeek(todayISO()),0,'lunch',currentProf)` to open a swap;
`MESA_TEST_DISABLE_AUTO_BALANCE = true/false` to compare generation with/without the
balancing pass.

**Service-worker cache trap:** the app registers a SW (cache-first for JS/CSS), so after
re-rsyncing, a plain reload serves the OLD bundle. Clear it in the page, then reload with a
cache-buster:
```js
navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()));
caches.keys().then(ks => ks.forEach(k => caches.delete(k)));
// then navigate to ...?preview=1&cb=<new-number>
```
Symptom of forgetting: your edit's new strings don't appear / `openAteOutSheet` is undefined.

Note: probes that reassign a top-level `let` global (e.g. `swapCtx`) via `window.x = ...`
do NOT rebind the lexical binding the functions read — drive the real code path instead
(open the sheet, call the real toggle), or mutate the existing object's properties.

## Test harness

`node tools/check.js` — zero-dep; loads the app files into a `vm` like `<script>` tags
(APP_SCRIPT_ORDER), with a `MESA_TEST_TODAY` date hook and `MESA_TEST_DISABLE_AUTO_BALANCE`
flag. **Must be green (`N passed, 0 failed`) before every deploy.** It runs `validateData()`
over the catalog, planner determinism, escaper hostility, sw drift, and the build-stamp
guard. Add tests for new behaviour; don't weaken assertions to make output changes pass —
update expected values only after confirming the new output is valid.

## Deploy (BOTH steps, in this order)

Keychain token (has Pages + Access + Workers + D1 perms):
`security find-generic-password -a mesa -s cloudflare-token -w`;
account id `84766baa4ad939ee067626830dd2f8dc`; D1 db `mesa-library`.

1. **`node tools/build-sw.js`** — regenerates `app/sw.js` (`SHELL_FILES` from disk +
   content-hash `CACHE`) and stamps `app/js/auth.js` `AUTH_BUILD` from the same hash.
   **Commit BOTH `sw.js` and `auth.js` together** (a partial commit ships a stale marker;
   check.js's build-stamp guard enforces they're equal). Then `node tools/check.js` green.
2. **Commit explicit paths** (never `git add -A`/`-a` — agents have swept each other's WIP
   before). `git push origin main`.
3. **Pages deploy** — stage FROM THE COMMIT, not the working tree:
   ```bash
   STAGE=$(mktemp -d) && git archive HEAD index.html app _headers | tar -x -C "$STAGE"
   find "$STAGE" -type f | wc -l   # guard: an empty stage deploys an empty site silently
   CLOUDFLARE_API_TOKEN=$(security find-generic-password -a mesa -s cloudflare-token -w) \
   CLOUDFLARE_ACCOUNT_ID=84766baa4ad939ee067626830dd2f8dc \
   npx --yes wrangler pages deploy "$STAGE" --project-name=mesa --branch=main --commit-dirty=true
   ```
4. **D1 re-seed — required for ANY built-in food/recipe change.** Built-in recipes load
   from D1 at runtime (`GET /library/GLOBAL`); `data/recipes.js` is only the offline
   fallback + seed source. New recipes are invisible online until seeded:
   ```bash
   node tools/seed-d1.js > /tmp/seed.sql        # redirect ONLY stdout, never 2>&1
   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
   npx --yes wrangler d1 execute mesa-library --remote --config worker/wrangler.toml --file=/tmp/seed.sql
   # readback:
   npx wrangler d1 execute mesa-library --remote --config worker/wrangler.toml \
     --command "SELECT COUNT(*) AS n FROM recipes WHERE scope='global' AND deleted_at IS NULL"
   ```

## Recipes: the D1 catalog is the SOURCE OF TRUTH

Built-in recipes are served from D1 (`GET /library/GLOBAL`, fetched `cache:'no-store'` at boot)
and **fully replace** the bundled `data/recipes.js` catalog at runtime — deletions included.
`data/recipes.js` is only the **offline / emergency fallback** (used when the fetch fails) and the
initial seed source; it is NOT the master. So you can inspect/edit/**delete** recipes directly in
D1 and the app reflects it on next open — no file edit or Pages deploy needed for a catalog change.

The client rejects a D1 payload only if it has **fewer than `CATALOG_REPLACE_MIN_ABSOLUTE` (10)**
valid recipes (a broken/near-empty response), so you can curate the catalog down freely above that
floor (the old floor was 50 % of the bundled file's size, which made DB deletes below ~72 silently
fall back to the file — fixed 2026-08-21).

```bash
TOK=$(security find-generic-password -a mesa -s cloudflare-token -w)
D1="wrangler d1 execute mesa-library --remote --config worker/wrangler.toml"
# inspect (id + title):
CLOUDFLARE_API_TOKEN=$TOK CLOUDFLARE_ACCOUNT_ID=84766baa4ad939ee067626830dd2f8dc npx $D1 \
  --command "SELECT id, json_extract(data,'\$.title') AS title FROM recipes WHERE scope='global' AND source='builtin' AND deleted_at IS NULL ORDER BY id"
# soft-delete one recipe (honored by the client):
CLOUDFLARE_API_TOKEN=$TOK CLOUDFLARE_ACCOUNT_ID=... npx $D1 \
  --command "UPDATE recipes SET deleted_at=strftime('%s','now')*1000 WHERE id='<recipe-id>' AND scope='global'"
# edit a field (e.g. title) in the JSON blob:
CLOUDFLARE_API_TOKEN=$TOK CLOUDFLARE_ACCOUNT_ID=... npx $D1 \
  --command "UPDATE recipes SET data=json_set(data,'\$.title','New title') WHERE id='<recipe-id>' AND scope='global'"
```

⚠️ **Once you curate the catalog directly in D1, do NOT re-run `tools/seed-d1.js`** — it
regenerates the whole global catalog from `data/recipes.js` and would overwrite your DB edits/
deletes. Treat the file as the fallback only; update it (and re-seed) solely if you want the
offline fallback to match your curated catalog. `check.js`'s catalog tests validate `recipes.js`
(the fallback), so keeping it a valid superset is fine.

## Gotchas (each has bitten before)

- **Curly/smart quotes as JS string delimiters** silently kill the whole `<script>` block.
  Use straight ASCII `'`/`"` as delimiters (curly apostrophes are fine *inside* a string).
  Run `node --check <file>` on every edited JS file. build-sw.js does NOT catch this.
- **Wrangler content-hash dedup** — if a file's hash matches a prior upload wrangler says
  "already uploaded" and may serve stale; build-sw.js changing the CACHE hash is what forces
  new content each deploy.
- **Cloudflare edge briefly serves the previous copy** after deploy (~10-20s). Can't curl
  the deployed content anyway — Access returns the login page.
- **SW update lifecycle** — after deploy, phones flash new HTML then revert to old cached
  JS until the new SW activates. Tell the user to **close and reopen** the app.
- **Invariants:** recipe nutrition = `sum(ingredients)`, kcal 4/4/9 (`check.js:392` asserts
  it for every recipe). Estimated macros (ate-out) must be rounded and labelled *estimated*,
  never the `chip-computed` "✓ computed" badge.
- Recipe `season` is **derived from ingredients** if not set explicitly — a recipe whose
  ingredients all map to one non-evergreen season becomes season-locked (excluded off-season).
  Set `season:'evergreen'` to keep a recipe always planner-eligible.
- **Git-integration auto-deploys on push.** Pushing to `main` triggers BOTH a Cloudflare Pages
  build (the app) AND a "Workers Builds" build (the `mesa-sync` worker) automatically. So a manual
  `wrangler pages deploy` often reports "0 files uploaded — already uploaded": the push already
  built it. Don't read that as a failed deploy — verify the **staged `sw.js` CACHE hash** is the
  one you built, not the upload count. The Workers Build deploys the worker from the **repo-root
  `wrangler.toml`** (a mirror of `worker/wrangler.toml`); keep them in sync (guarded by
  `check.js:testRootWranglerMirrors`). A worker SECRET (`GOOGLE_CLIENT_SECRET`) persists across
  deploys — `wrangler deploy` never removes it.
- **`tools/check.js` runs every test in ONE shared `vm` context.** A test that mutates global
  state and doesn't restore it corrupts later tests. Especially: calling `loadState()` /
  `localStorage.clear()` mid-suite reloads the WHOLE app state (PROF, catalog merge, …) and has
  broken a dozen downstream tests — snapshot-and-restore (see `testReplaceBuiltinRecipesFromCatalogRows`'s
  `restore()`), or test the pure logic without touching the store. Also: `Date.now()`/`Math.random()`
  are unavailable in the harness (determinism), and `applySwapToPlan` stamps `.t` (a `Date.now`
  sync marker) onto entries — compare suggestion arrays, not whole result plans, for determinism.
- **Preview sub-resource cache trap.** After you re-rsync the app copy, the browser's HTTP disk
  cache keeps serving the OLD `js/*.js` even with a no-store server + SW unregister + hard reload.
  The reliable fix is to serve from a **FRESH PORT** (new origin) each time — see the preview
  section above.
- **D1 free-tier write budget (100k rows/day) — the mirror now writes a per-row diff (fixed
  2026-08-23), but deploys still cost writes.** `mirrorLibraryCatalogToD1()` (`app/js/sync.js`)
  used to push the household's **entire** custom library (~170 rows) on every couple-sync; on
  2026-08-22 a day of ~20 rapid-fire deploys hit **144,008** rows and tripped Cloudflare's
  usage-limit email. It now POSTs only rows whose per-row signature changed
  (`diffLibraryCatalogPayload`), and the signature map is persisted (`mirroredRowSignatures` →
  state.js `libraryMirror`) so a SW-forced reload after a deploy no longer re-pushes an unchanged
  library. A genuinely unchanged library now costs **zero** D1 writes per sync. Real edits still
  write their changed rows, so batching several content changes into one deploy is still the
  polite default, but the old whole-library-every-reload amplification is gone.
