# Mesa — meal planner PWA for two

A free, installable, offline-first PWA that plans a week of Mediterranean meals for Elena and Andrea (couple with different calorie/macro targets, shared dinners), generates one household shopping list, and logs what was actually eaten. **Every number is computed, never typed in** — Mifflin-St Jeor for targets, sums over the food DB for nutrition.

**Live:** https://mesa-9y5.pages.dev (Cloudflare Pages, behind Cloudflare Access — only elenanesi55@gmail.com and angelucci88@gmail.com). Legacy public URL https://elenanesi.github.io/mesa/ (to be retired once Elena confirms Access login works → then make the GitHub repo private).

## How agents work on this repo

1. Read `PWA-MVP-plan.md` → **"Ground rules for every agent task"** — they are hard constraints (deterministic numbers; no frameworks/build step; visual parity with the locked design; iPhone Safari ≥44px targets; localStorage-only; verify in a real browser before reporting done).
2. The app is `app/` — plain HTML/CSS/JS, globals, no modules: `js/state.js` (store `mesa.v1`, version 4, migrations), `js/engine.js` (targets + recipeNutrition), `js/planner.js` (deterministic week planner, swaps, re-balance, shopping list), `js/render.js` (all DOM), `js/library.js` (custom foods/recipes), `js/app.js` (boot/nav), `data/foods.js` + `data/recipes.js` + `data/validate.js` (validators must stay `ok:true`).
3. `mesa-prototype.html` is the frozen design reference — never edit it.
4. **Local verification quirk**: the sandbox blocks servers reading this folder — rsync `app/` to the session scratchpad and serve with the `serve_app.py` there (port 8322; `python3 -m http.server` fails; `.claude/launch.json` has a `mesa-app` preview entry). `node` is installed (syntax-check with `node --check`). Never chain reload+assert in one preview eval.

## Deploy (both, in this order)

1. **Bump `app/sw.js` CACHE** (check the current value in the file) — installed clients only refresh on a version bump.
2. Commit + `git push origin main` (GitHub repo `elenanesi/mesa`; creds in macOS keychain via `git credential fill`).
3. Cloudflare: stage root `index.html` + `app/` into a temp dir, then
   `CLOUDFLARE_API_TOKEN=$(security find-generic-password -a mesa -s cloudflare-token -w) CLOUDFLARE_ACCOUNT_ID=84766baa4ad939ee067626830dd2f8dc npx wrangler pages deploy . --project-name=mesa --branch=main --commit-dirty=true`
   (token perms: Pages Edit + Access Edit only). Access team domain: lively-unit-4aa5.cloudflareaccess.com.

## Docs

- `PWA-MVP-plan.md` — Phase 1 build plan (DONE) + ground rules (living)
- `install-and-test-guide.md` — user-facing install/test guide
- `MVP-plan.md` — product vision, accuracy architecture, research sources
- `ux-research-notes.md` — UX research behind the design

---

## STATUS (maintained — integrate & prune when tasks complete)

**Done through 2026-07-13** (sw CACHE mesa-v6): Phase 1 MVP shipped + post-MVP batches — custom food/recipe library with auto-derived tags; editable log (breakfast normal slot, Undo everywhere, Today/Log/Insights parity from logHistory); Week screen starts with the plan (coverage cards on Insights); two-week horizon (This/Next week toggle, per-week shopping, cross-week variety filter, advance swaps survive rollover); swap-anything sheet (best matches + all slot options); merge-only library import; Cloudflare Pages + Access migration done; UI feedback batch — Confirm/Skip/Undo directly on the Today screen cards (same logHistory funnel as Log, verified both directions) + every numeric stepper field also directly typeable with decimals (comma AND dot accepted, inputmode=decimal, ≥16px inputs).

**In progress / next:**
- Awaiting Elena: Access login test on https://mesa-9y5.pages.dev → then make GitHub repo private + retire legacy URL in docs.
- **Phase 2 next**: couple-sync via Cloudflare Worker + KV (design agreed: household secret code, per-owner data partitions — plan/shopping/library shared, logs/profiles per person, offline-first). Blocked on: CF token needs added perms (Workers Scripts Edit + Workers KV Storage Edit). After sync: LLM endpoint (needs an Anthropic API key from Elena, proxied by a Worker — key never ships in the app).
