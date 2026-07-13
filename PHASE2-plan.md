# Mesa — Phase 2 plan (couple sync, then LLM)

Date: 13 July 2026 · Owner: Elena · Executor: Claude orchestrating Sonnet agents · Status: **S1 done, S2 next**

Read `README.md` first, then `PWA-MVP-plan.md` → "Ground rules" (still binding). Phase 2 adds the first network features. New ground rule: **the app must remain fully functional offline and with sync disabled** — sync is an enhancement layered on the existing local-first store, never a dependency.

## Part S — Couple sync (Cloudflare Worker + KV)

**Architecture.** One Worker (`worker/sync.js`, plain JS, no deps) + one KV namespace. A household is identified by a random secret code (crypto-random, ~26 chars, generated on Elena's phone, shared once with Andrea — it IS the auth; no accounts). Endpoints:
- `GET /sync/:code` → `{sections: {name: {rev, updatedAt, data}}}`
- `POST /sync/:code` → body `{sections: {...}}`; server keeps, per section, the copy with the higher rev (rev = client-incremented counter; ties → higher updatedAt). Returns the merged full state.
- 404 unknown code only on GET with no prior POST; any POST creates the household. Payload cap ~1 MB. CORS: allow the app origins (mesa-9y5.pages.dev + localhost dev).

**Section model & merge rules** (client-side merge, server is dumb storage per section):
- `library` (customFoods, customRecipes, customRev): merge by id, identical skip, conflict re-id — REUSE library.js's existing mergeImportedLibrary machinery.
- `plans` (weekPlans + SHARED + householdStyle + servings): LWW per section (whole blob) — swaps and toggles are rare and discussed at home; rev counter decides.
- `shopping` (checkedByWeek): union-merge of checked names per week.
- `profile:elena`, `profile:partner`: LWW each — a phone only bumps the rev of profiles it actually edited.
- `log:elena`, `log:partner`: append-merge by (date, entry identity); deletions propagate via a per-day tombstone list. Frozen macros ensure merged entries stay historically stable.

**Client** (`app/js/sync.js`): on boot and debounced (~2s) after every `persist()`, if a household code is configured: POST dirty sections (track per-section rev + dirty flags in the store), apply what comes back through the merge rules, re-render via the existing funnels. Network failure = silent no-op (retry on next trigger). Profile → new "Couple sync" section: create household (shows the code to share), join household (paste code), leave household, "last synced" line, all in the existing design language.

**Tasks:**
- **S1 — Worker + client, verified locally.** Build worker/sync.js + app/js/sync.js + Profile UI. Verify with `wrangler dev --local` (miniflare, no CF auth needed) on port 8787 + two browser profiles simulating the two phones: create household on A, join on B, verify: recipe created on A appears on B; shopping check on A appears on B; A's profile edit doesn't clobber B's; log entries merge; offline phone catches up on reopen; leaving household stops syncing. sw.js: network calls to the sync endpoint must BYPASS the cache-first fetch handler (it's cross-origin → already passes through; verify).
- **S2 — Deploy worker + KV to Cloudflare, point the app at it, ship.** Done 2026-07-13: KV namespace `MESA_KV` bound in `worker/wrangler.toml`, Worker deployed at `https://mesa-sync.elenanesi55.workers.dev`, `app/js/sync.js` points at production, `app/sw.js` bumped to `mesa-v9`, and Worker CORS verified for `https://mesa-9y5.pages.dev`. Follow-up added: Cloudflare Access bootstrap registers/restores the household code for the two allowed login emails so reinstalling the iOS PWA can pull profile/plan/library data before pushing defaults.

## Part L — LLM at the edges (after S2)

Worker endpoint proxying the Anthropic API (key stays in a Worker secret, never in the app; requires an API key from Elena — console.anthropic.com). Uses: menu *ideas* beyond the recipe DB ("5 thyroid-friendly dinners under 600 kcal") returned as structured JSON validated against the food DB (AI proposes, math disposes — deterministic core untouched); friendlier weekly-review text. Design details deferred until S2 ships.

## STATUS (maintained)

- S1: **done** (2026-07-13) — `worker/sync.js` + `worker/wrangler.toml`, `app/js/sync.js`, Profile "Couple sync" UI built and verified end-to-end with `wrangler dev --local` (no CF auth needed) across two simulated phones (127.0.0.1:8322 / localhost:8322 origins): create/join, library merge, shopping union, concurrent per-person profile edits (no clobber), log append-merge + tombstoned undo, offline resilience (silent retry, backlog syncs on the next mutation once the worker's back), leave-household, and zero network calls with sync never configured — all confirmed.
- S2: blocked on token permissions (Elena).
- L: not started; needs Anthropic API key decision.
