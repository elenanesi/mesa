# Mesa — meal planner PWA for a household of one or two

A free, installable, offline-first PWA that plans a week of Mediterranean meals for a household — one person, or two with different calorie/macro targets and shared dinners — generates one shopping list, and logs what was actually eaten. **Every number is computed, never typed in** — Mifflin-St Jeor for targets, sums over the food DB for nutrition.

> **Nutrition-claims policy (current as of 2026-07-29):** calorie and recipe values are estimates; fibre (25g/day), free sugars (<10% energy), and saturated fat (<10% energy) are general WHO guidance; macro splits, calorie adjustments, variety and tuning are Mesa product rules. Thyroid/Hashimoto, skin, selenium, iodine, omega-3 coverage, low-GI and fixed animal-protein quota claims were retired. See [KNOWLEDGE-BASE.md](KNOWLEDGE-BASE.md) and Profile → **How Mesa plans** in the app. Historical handoff entries below that describe those retired rules are superseded.

Since Phase 3 it is a multi-user app: invite-only Google sign-in, one household
per user, and no hardcoded people. Elena and Andrea are just the first
household; nothing user-visible names them (see the Auth & accounts section).

**Live:** https://mesa-9y5.pages.dev/app/ (Cloudflare Pages) — publicly reachable, gated
by the app's own Google sign-in.

**Cloudflare Access was REMOVED on 2026-07-26** (app id a9027db1…, team domain
lively-unit-4aa5.cloudflareaccess.com) so invited users other than the first two
could load the app at all. It was deliberately removed only AFTER
`REQUIRE_SESSION="1"` was live and verified, so the API never sat exposed. Four
layers now protect real data, and NONE of them is Access:
1. the app shell is public but contains no user data;
2. the login gate blocks the UI without a session (fails closed);
3. `/sync` + `/library` reject any request without a valid session, and a session
   may only touch ITS OWN household (403 `wrong_household`);
4. sign-up is invite-only (`allowed_emails`) and capped by `MAX_USERS`.
Re-adding Access would be the fastest way to lock everyone out again — if the app
ever needs to be closed off in a hurry, prefer emptying `allowed_emails` and
deleting rows from `sessions`.

Backend: https://mesa-sync.elenanesi55.workers.dev (Cloudflare Worker + KV + D1). Legacy public URL https://elenanesi.github.io/mesa/ (to be retired → then make the GitHub repo private).

## How agents work on this repo

1. **Ground rules (hard constraints):** deterministic numbers; no frameworks/build step; iPhone Safari ≥44px targets; localStorage-only; straight ASCII quotes as JS delimiters (`node --check` every edited JS file); `node tools/check.js` green before any deploy; verify UI in a real browser before reporting done. See **AGENT-HANDOVER.md** for the full develop/preview/test/deploy workflow + gotchas, and **STATUS.md** for what's shipped / what's next.
2. The app is `app/` — plain HTML/CSS/JS, globals, no modules: `js/state.js` (store `mesa.v1`, version 4, migrations, `deepClone()` utility, XSS escape helpers), `js/engine.js` (targets + recipeNutrition), `js/planner.js` (deterministic week planner, swaps, re-balance, shopping list), `js/render.js` (shared render helpers: toast, closeSheet, applyProf, refreshRingAndBars, avatarSlotHtml), `js/render-recipe.js` (recipe detail, options chips, serving context), `js/render-week.js` (week grid, nutri cards, swap, regenerate, routines), `js/render-today.js` (today screen, add-meal sheet, log plan, eaten strip, progress dots), `js/render-profile.js` (basics editor, split/goals/avoid editors, household size, insights, tuning), `js/render-sheets.js` (shopping sheet, food search/quick-add, export/import), `js/library.js` (custom foods/recipes + D1 builtin replacement), `js/sync.js` (couple sync + D1 catalog fetch), `js/app.js` (boot/nav), `data/foods.js` + `data/recipes.js` + `data/validate.js` (offline fallback/seed sources; validators must stay `ok:true`).
3. **Local verification**: the sandbox blocks servers reading this folder — rsync `app/` to the session scratchpad and serve from a **fresh port** with a `Cache-Control: no-store` server, then open `http://localhost:<port>/app/?preview=1` (the `?preview=1` demo bypass skips Google sign-in on localhost only). Full steps + the sub-resource cache trap (after re-rsync, serve from a NEW port) are in **AGENT-HANDOVER.md**. `node --check` every edited JS file; never chain reload+assert in one preview eval.

## "The phone shows an old / broken / stale version but the laptop is fine" — TRIAGE IN THIS ORDER

This has burned multiple long debugging sessions. The app is an offline-first PWA that caches aggressively **by design**, so the instinct is always "it's the cache" or "it's the deploy" — and that instinct has repeatedly been wrong. **Do the cheapest checks first, in this exact order, before touching code, caches, or deploys.**

1. **Network interception — CHECK THIS FIRST (15 seconds).** On the phone, toggle **off Wi-Fi onto cellular** (or vice-versa) and reload the exact URL. Two tells: (a) a **"connection is not private" / certificate-mismatch** warning (`il certificato non corrisponde all'indirizzo web`), or (b) it works on one network but not the other. Either means the phone's **network is intercepting TLS** and serving a stale/blocked copy with its own cert — a router "safe browsing"/parental-control filter, an ISP security suite, a **VPN**, a content-blocker (**AdGuard, 1.1.1.1 / Cloudflare WARP**), **iCloud Private Relay**, or a **Wi-Fi HTTP proxy** (Settings → Wi-Fi → ⓘ → HTTP Proxy). This is **NOT a code, deploy, cache, or service-worker problem** — nothing you push or clear can fix it. Fix by removing the interceptor; **never click through the cert warning** (it's a real security warning). *(2026-07-27: this cost ~an afternoon of cache/SW/deploy/`_headers` debugging across several commits; the cellular-vs-Wi-Fi test would have found it in 15 seconds. When laptop=new and phone=old on the **same fully-typed URL** even in a private tab, it is almost always this — not the phone.)*

2. **Service worker / cache — only after the network is proven clean.** Clear website data for the **correct origin**: `mesa-9y5.pages.dev` (search **"pages"** or **"mesa"** in Settings → Safari → Advanced → Website Data — **not "cloudflare"**, that's a different, unrelated domain). If Mesa was **Added to Home Screen**, that standalone PWA has its **own** service worker + cache, separate from Safari — delete the home-screen icon too. Then **restart the phone** (evicts the SW suspended in memory; a plain app-close does not). `node tools/build-sw.js` must have stamped a fresh `CACHE` hash for the deploy, and `_headers` sets `no-store` on `sw.js` so the browser's update check always reaches the newest worker.

3. **Deploy actually happened — last, not first.** Confirm the live `CACHE` in `app/sw.js` on `main` matches what the phone should get, and that the Cloudflare Pages build published. A fresh laptop reload is the reference for "what the live site really serves." Cloudflare Pages purges its edge cache on every deploy, so a stale edge is rarely the cause once a deploy has run.

## Agent handoff lessons from 2026-07-15

- **Deploy is not GitHub.** Several batches were deployed to Cloudflare Pages/Workers before being committed. Always check `git status --short --branch` and `git log --oneline --decorate -5 --all`; if `main...origin/main` shows no commit ahead but files are modified, GitHub does not contain the deployed state yet.
- **Do not silently deploy a partial dirty tree.** This repo may contain expected uncommitted work from other agents. If asked to deploy/push, clarify whether the user wants the whole current local state or only your staged subset. A Pages deploy from a staged copy of `index.html` + `app/` publishes whatever is in the local tree, regardless of Git.
- **D1 changes require three steps.** For schema changes: add a migration under `worker/migrations/`, apply it remotely with Wrangler, then deploy `worker/sync.js`. Afterward, verify with a direct D1 schema/readback command. Client-only Pages deploy is not enough.
- **Installed PWA cache matters.** Run `node tools/build-sw.js` before every deploy — it regenerates `app/sw.js`'s `SHELL_FILES` from disk and stamps a content-hash `CACHE`, so shell/data changes always invalidate old installs. If a phone looks stale after deploy, suspect the service worker/cache before changing logic again.
- **Ingredient edits now use `foodOverrides`.** Built-in ingredient edits should not mutate `data/foods.js` at runtime or be forced into `customFoods`. Use synced household overrides (`foodOverrides`) and keep `applyCustomFoods()`, `librarySectionData()`, merge logic, backup/import, and D1 mirror in sync.
- **Ingredient icons are food data, not renderer logic.** Icon mapping lives on food records (`iconKey`/`iconAsset`) and is mirrored to D1 in `foods.data_json`; do not reintroduce hardcoded ID/name maps in `library.js`. For built-in/global icon metadata changes, deploy Pages AND seed/read back D1 global rows (e.g. verify `oat-milk -> milk`) because a client deploy alone does not rewrite existing D1 catalog rows.
- **Built-in catalog changes: D1 is authoritative at runtime.** `app/data/foods.js` and `app/data/recipes.js` are the bundled offline fallback and seed source; on startup the PWA fetches `GET /library/GLOBAL` from the sync Worker, replaces builtin recipe rows from Cloudflare D1, and falls back to bundled recipes only if the fetch fails/offline times out. Any change to built-in food/recipe fields needs: `node tools/seed-d1.js > /tmp/seed.sql`, then from `worker/`: `npx wrangler d1 execute mesa-library --remote --file=/tmp/seed.sql` (same keychain token env vars as the Pages deploy), then a readback verify (e.g. `SELECT COUNT(json_extract(data_json,'$.role')) FROM recipes WHERE scope='global'`). The script calls the app's own `buildLibraryCatalogPayload()` in a vm context, so seeded rows are byte-identical to a real client push; it also tombstones stale global builtin rows that no longer exist locally. Deploy Pages too for any bundled fallback or static asset change.
- **Composite ingredients are real formulas now.** Built-in and custom foods may carry `components` + `yieldG` instead of static macro fields. `foodMacros()` computes nutrition live; made composites (`bought:false`) decompose into their components for shopping/pantry, while bought composites (`bought:true`) remain pantry-baselineable as one item. The Library ingredient form can author/edit formulas, diet variants, batch yield, and bought/made mode; the Ingredients list/detail show component breakdowns and intentionally hide direct pantry add for made composites.
- **Recipe/ingredient image wiring is data-first.** Ingredient art is still `food.iconKey`/`iconAsset`; recipe art is `recipe.imageKey` or safe relative `imageUri`. Adding PNGs to `app/assets/**` is not enough: wire the relevant data rows, regenerate `app/sw.js`, seed D1 global rows, deploy Pages, then read back D1 because runtime built-ins load from Cloudflare D1 when online.
- **Re-balance must not touch the past.** When changing planner candidate enumeration, compare each plan day to `todayISO()` and exclude dates before today. Logged/skipped locks are not enough because unlogged Monday/Tuesday meals can still be historical.
- **Do not auto-focus top-level mobile page searches.** iOS/Safari opens the keyboard immediately. Keep auto-focus for explicit picker/search flows where typing is the next action, but not for landing pages such as Library → Ingredients.
- **Barcode/Open Food Facts in Italy:** prefer the localized Italian OFF endpoint before global endpoints; some products visible on the website return richer nutriments from `it.openfoodfacts.org`.
- **Icons: do not repeat the weak generated-icon batch.** Codex produced a poor first pass for ingredient watercolor icons; another agent later fixed/replaced them. Future icon work should preserve the repaired assets, inspect contact sheets visually, and use the `watercolor-ingredient-icons` skill only with actual visual QA before wiring/deploying.
- **Detail hero layout on mobile:** keep the ingredient/recipe detail image slot on the left and tags/meta on the right, even under the narrow mobile media query. Do not stack image-over-tags unless Elena explicitly asks for that layout; it wastes vertical space and made the screenshot look unchanged.
- **Recipe images are separate from ingredient icons.** Shared recipe art lives under `app/assets/recipes/*.png`; `tools/build-sw.js` must include that directory, and `app/sw.js` must be regenerated before deploy. Recipe rows may carry a safe relative `imageUri` such as `assets/recipes/pizza.png`; `render-recipe.js` prefers that over `imageKey`. `imageKey` remains the picker/fallback vocabulary, while `recipeImageAssetForRecipe()` and `recipeHeroHtml()` enforce safe paths with default fallback to `assets/recipes/default-recipe.png`. Auto mode checks specific recipe art first, then soup/pasta/salad presentation, then fish/shellfish ingredients, then meal-slot defaults (`breakfast` bowl, `lunch` salad, `dinner` default), so tuna salad stays salad while non-salad fish dishes stay fish. Recipe detail must expose a clear `Change image` action; it opens the recipe editor with the Lead image picker expanded.
- **Library recipe rows should open detail.** The recipe Library row body opens `openRecipe(id, 'libraryRecipes')`; only the small action buttons should favorite/thumbs-down/edit/delete. If a screenshot shows "Edit recipe" after tapping a row, the row tap handler regressed.

## Agent handoff lessons from 2026-07-25/26 (accounts & sign-in)

Sign-in cost far more debugging than the feature deserved, in four separate
loops that all LOOKED identical from the outside ("tap sign in, land back on the
login screen"). Each had a different cause. The lessons, in rough order of how
much time they cost:

- **Sign-in must not depend on the app booting.** The worst one. `initAuth()`
  used to be the last statement of `bootMesaApp()`'s promise chain, which opens
  with a network fetch for the D1 catalog. When anything in that chain stalled
  or threw (it does on some Safari installs), the code that reads the returned
  token off the URL never ran — the token was discarded unread and sign-in
  looped forever with no error anywhere. Now `initAuthEarly()` (js/auth.js) runs
  the moment the script parses and owns everything needed to GET A USER IN:
  fragment pickup, claim-ticket redemption, the login gate. `initAuth()` keeps
  only what needs loaded app state. **Never move token handling back behind
  boot, a promise chain, or a network call.**
- **URL fragments are fragile; anything that matters can't ride only in one.**
  The root `index.html` is a redirect shim to `/app/`, and it used a
  meta-refresh — which DROPS the `#fragment`. The callback returned
  `<origin>/#auth=<token>`, so the token died one hop from the app. `return_to`
  now carries origin + path so the callback lands on `/app/` directly, and the
  shim forwards the fragment via `location.replace()`.
- **An installed iOS PWA cannot complete an OAuth redirect.** Standalone mode
  refuses cross-origin navigation, so the whole trip happens in Safari and the
  token lands in SAFARI's storage — a different jar from the PWA's, which never
  sees it. Fixed with claim tickets: the client mints a one-time id, the
  callback parks a copy of the token under it in KV, and the PWA redeems it over
  a plain fetch (`GET /auth/claim`) on visibilitychange/pageshow. Single-use,
  5-minute TTL, identical 404 for unknown/expired/claimed.
- **The login gate must fail closed AND be static.** It renders visible by
  default with an inline script hiding it when a token exists, so a slow or
  broken boot can never leave the app briefly usable. Consequence learned the
  hard way: anything JS-generated inside the gate is missing exactly when it is
  needed most — the "Sign in with Google" button is static markup in
  `index.html` (kept byte-identical to `googleSignInButtonHtml()`), because a
  phone can run new HTML against an older cached `js/auth.js`.
- **Diagnose from the device, not from theory.** Three wrong hypotheses died the
  moment real logs existed. `js/auth.js` keeps a ring buffer in localStorage,
  surfaced by "Trouble signing in?" on the gate; every line carries `AUTH_BUILD`,
  stamped by `tools/build-sw.js` from the same content hash as the sw `CACHE`
  (neutralised before hashing so it can't feed its own hash). **"Which build is
  actually running" is the first question** — an installed PWA or Safari cache
  routinely serves week-old JavaScript. Worker side logs to `wrangler tail`
  (`auth.callback ok/fail`, `auth.claim hit/miss`) with no tokens or emails.
- **Viewer-relative words must never be stored in synced data.** `displayName`
  defaulted to the literals 'You'/'Partner' and syncs between phones, so the
  slot-2 member saw HIMSELF labelled "Partner". Real names are shared data;
  only the FALLBACK for an unnamed slot is resolved per-viewer
  (`state.js:resolveDisplayName`, against `auth.js:myMemberSlot()`, cached
  device-locally and deliberately never synced). Legacy 'You'/'Partner' values
  are treated as unset for migration.
- **`wrangler secret put` takes the NAME, not the value.** Running
  `wrangler secret put GOCSPX-…` reports success and creates a secret whose NAME
  is your client secret — and names are listable in the dashboard and terminal
  output. Rotate the credential if this happens. The correct form is
  `npx wrangler secret put GOOGLE_CLIENT_SECRET`, pasting the value at the
  prompt.
- **Stage Pages deploys with `git archive HEAD`, from the repo root.** Deploying
  the working tree publishes whatever another agent has half-finished. Two traps
  hit in one session: the shell's cwd persists between commands (a `cd worker`
  earlier made `git archive` produce nothing, and an EMPTY directory was
  published to production for ~1 minute), and `--commit-dirty=true` hides both.
  Always `find <stage> -type f | wc -l` before deploying.
- **Wrangler Pages deduplicates by content hash.** `wrangler pages deploy`
  hashes each file and skips uploading files whose hash matches a prior upload.
  If a file changed and then changed back (or was touched without a content
  change), wrangler reports "already uploaded" and the CDN may serve a stale
  version. Symptom: `Uploaded 0 files (180 already uploaded)` yet the deployed
  site has old content. Fix: add a trivial content change (comment bump) to
  force a new hash, then `build-sw.js` + redeploy. Always verify the deployed
  content after deploy — `curl` won't work behind Cloudflare Access (returns
  the login page HTML), so verify from an authenticated browser or the preview
  deployment URL.
- **SW update lifecycle causes a brief stale flash on phones.** After a deploy,
  a phone with the old SW active will: (1) load index.html from the network
  (network-first), briefly showing the new HTML, (2) serve old JS/CSS from the
  old SW cache (cache-first for sub-resources), reverting the UI. The new SW
  installs in the background, then `skipWaiting` → `activate` → `clients.claim`
  → `controllerchange` → `location.reload()` serves fresh content. This can
  take several seconds. If the user reports "I see the new version then it
  flips back," the fix is: close and reopen the app (or hard-refresh) to let
  the new SW take over. This is normal SW lifecycle, not a deploy bug.

## Deploy (both, in this order)

1. **Run `node tools/build-sw.js`** — regenerates `app/sw.js`'s `SHELL_FILES` list from disk and stamps a content-hash `CACHE`, so a forgotten manual bump can no longer ship a stale shell. Commit the regenerated `sw.js`.
2. Commit + `git push origin main` (GitHub repo `elenanesi/mesa`; creds in macOS keychain via `git credential fill`).
3. Cloudflare: stage from the COMMIT, not the working tree, and always from the repo
   root (the shell's cwd persists between commands — see the handoff lessons):
   `STAGE=$(mktemp -d) && git archive HEAD index.html app _headers | tar -x -C "$STAGE" && find "$STAGE" -type f | wc -l`
   then from `$STAGE`:
   `CLOUDFLARE_API_TOKEN=$(security find-generic-password -a mesa -s cloudflare-token -w) CLOUDFLARE_ACCOUNT_ID=84766baa4ad939ee067626830dd2f8dc npx wrangler pages deploy . --project-name=mesa --branch=main --commit-dirty=true`
   (token perms: Pages Edit + Access Edit only). Access team domain: lively-unit-4aa5.cloudflareaccess.com.
   The file count guard is not optional: an empty stage deploys an empty site without error.

### Auth & accounts (Phase 3A/3B — invite-only Google sign-in)

**Model.** A `users` row is one Google account. Every user belongs to exactly one
household (`users.household_code`) in one of two slots (`users.member_slot`,
values `elena` | `partner` — OPAQUE legacy ids meaning "slot 1" / "slot 2", never
shown to users, never rename them). A one-person household is just a household
with a single member; there is no separate solo code path. Household DATA still
lives under the household code (KV sections + D1 library rows) exactly as before
accounts existed — accounts are a layer of identity and access on top of it, not
a new storage model.

**Sign-in flow.** PWA → `GET /auth/google/start` → Google consent →
`GET /auth/google/callback` (verifies aud/iss/exp/email_verified, checks
`allowed_emails`, enforces `MAX_USERS`) → redirects back with `#auth=<token>`.
The token is a 90-day sliding session; only its SHA-256 hash is stored in D1.
`GET /auth/me` returns the user, `householdCode`, `memberSlot`,
`householdMembers` (1 = solo, 2 = couple — drives partner-UI visibility) and
`members` (the household roster: slot, displayName, firstName, Google picture,
isSelf — so either phone can show BOTH real names/photos without waiting for
couple-sync to propagate a locally-typed name; no emails).

**Two delivery paths for the token, both required.** The callback redirects to
`<return_to>#auth=<token>` — `return_to` carries origin AND path, because the
site root is a redirect shim that would drop the fragment. That covers desktop
browsers. An installed iOS PWA can never receive that redirect (the OAuth trip
happens in Safari, a different storage jar), so the same sign-in also parks a
copy of the token in KV under a client-minted one-time ticket, redeemed by
`GET /auth/claim?link_id=…` when the user returns to the app. Removing either
path breaks a whole class of device — see the handoff lessons above.

**Access control.** `/sync/:code` and `/library/:code` run through
`requireHouseholdAccess()`: a presented session must match the household being
accessed (403 `wrong_household` otherwise). `REQUIRE_SESSION` (wrangler.toml
vars) decides what happens with NO session — `"0"` allows it (legacy
household-code trust, the pre-accounts behavior), `"1"` rejects it with 401
`session_required`. `GET /library/GLOBAL` is always public (the built-in catalog
is fetched before login). Flip to `"1"` only once every existing device has
signed in, or those devices lose sync.

**Migrations.** Apply once, from `worker/`:
`npx wrangler d1 migrations apply mesa-library --remote`
(`0003_users_auth.sql` = users/sessions/allowed_emails,
`0004_household_attach.sql` = household_code/member_slot columns).

**Config.** `GOOGLE_CLIENT_ID` + `MAX_USERS` + `REQUIRE_SESSION` are vars in
`worker/wrangler.toml`; `GOOGLE_CLIENT_SECRET` is a secret — from `worker/`:
`npx wrangler secret put GOOGLE_CLIENT_SECRET`. The OAuth client lives in Google
Cloud Console with redirect URI
`https://mesa-sync.elenanesi55.workers.dev/auth/google/callback`.

**Invites.** Mesa is invite-only: a Google account can only sign in once its
email is in `allowed_emails`. An invite row may carry a household_code +
member_slot, which is how an invited partner lands in an existing household in
the right slot on first login (users invited without one get a fresh household
of their own). From `worker/` — plain invite:
`npx wrangler d1 execute mesa-library --remote --command "INSERT OR IGNORE INTO allowed_emails (email, note, added_at) VALUES ('x@y.z','friend',strftime('%s','now')*1000)"`
Invite into an existing household as the second member:
`npx wrangler d1 execute mesa-library --remote --command "UPDATE allowed_emails SET household_code='<CODE>', member_slot='partner' WHERE email='x@y.z'"`

## Docs (the whole set — kept deliberately small)

- **README.md** (this file) — what Mesa is + architecture + repo map + auth model.
- **AGENT-HANDOVER.md** — how to develop / preview (no-auth) / test / deploy, and the gotchas that have bitten.
- **STATUS.md** — what's shipped and what's next (the single "where things stand" doc).
- **EXPERT-PANEL.md** — how to summon the cross-functional design panel (UX / nutritionist / engineer / psychologist) for a genuine product decision.
- **ux-research-notes.md** — the behaviour-change + UX research backing the panel's recommendations.
- **KNOWLEDGE-BASE.md** — how Mesa determines a healthy diet: targets, goal profiles, tag thresholds, sourcing (every number cited to file:line); the "Guideline vs Mesa-rule vs Estimate" claim policy `tools/check.js` audits.

Older per-feature plan docs (PWA-MVP / MVP / PANTRY / VARIETY / WEEK-EATENOUT / WISHLIST /
UX-REVIEW / install-and-test-guide) were retired 2026-08-21 — all shipped; their history is in
`git log`, their still-open items live in STATUS.md.

---

## Status & changelog

See **STATUS.md** for what's shipped and what's next, and `git log` for the full per-change
history (every deploy is a commit; the long historical changelog that used to live here was
retired 2026-08-21).
