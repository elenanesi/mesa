# Phase 3B — Generic multi-user Mesa (spec)

Goal: any invited user can sign up, gets their own clean household, optionally
pairs with a partner, and the backend only trusts logged-in sessions. Builds on
Phase 3A/3A.2 (Google sign-in, login gate, household attach — see
PHASE3A-auth-spec.md). Friends/social (Phase C) is OUT of scope.

**Ground rule — slot keys stay.** `'elena'` and `'partner'` are the app's two
internal member-slot identifiers (meals[slot].elena/.partner, recipePrefs,
sync section names profile:elena/log:elena, server member_slot). They are
OPAQUE IDs from 3B on — read "elena" as "slot 1", "partner" as "slot 2".
Nothing user-visible may show them; nothing may rename them (a ~10k-line
data-model rename with zero user value). Genericization is display-level +
defaults + copy.

Batches ship independently, in order:

## B1 — Session auth on the sync API (dual-mode)

Worker:
- Reuse auth.js's session lookup (export a `loadSessionUser(request, env)`
  returning {userId, householdCode, memberSlot} or null) — do NOT duplicate.
- `/sync/:code` (GET+POST) and `/library/:code` (GET+POST, EXCEPT
  `/library/GLOBAL` GET which stays public — it's the built-in catalog and is
  fetched pre-login): if a Bearer session is presented and valid, the session
  user's household_code MUST equal `:code`, else 403 `{error:'wrong_household'}`.
  If NO valid session: behavior depends on `env.REQUIRE_SESSION`:
  - `"0"` (initial): allow, exactly today's behavior (legacy code-secret trust).
  - `"1"`: 401 `{error:'session_required'}` (flip AFTER both existing phones
    have signed in — see B5).
- wrangler.toml `[vars]`: `REQUIRE_SESSION = "0"` with a comment about the flip.
- /bootstrap stays untouched (retired in B5).

Client:
- auth.js exposes `authHeader()` → `{Authorization:'Bearer …'}` or `{}`.
- EVERY fetch to SYNC_URL in sync.js/library.js (sync, library, bootstrap)
  spreads authHeader() into its headers.
- A 401 `session_required` on sync while a token is stored means the session
  died server-side → clear token, show login gate (reuse existing 401 path).

## B2 — Generic identity (names, avatars, defaults, copy)

- PROF gains persisted, editable `displayName` per slot (Profile → Basics gets
  a "Name" text input, same input conventions as existing fields, synced
  inside the existing profile:<slot> sections; escapeHtml everywhere).
  `seg`/`av` (segment label, avatar initial) DERIVE from displayName.
- Defaults for a FRESH household (no saved profile data): slot1 "You", slot2
  "Partner"; all goal toggles OFF; neither fatLoss nor muscleGain preset; no
  hashi flag. Existing saved households are untouched (saved data always wins
  over defaults — verify the load path guarantees this).
- On first sign-in attach (auth.js): if the active slot's displayName is still
  the default, seed it from the Google given name (payload name's first word,
  client-side from /auth/me displayName).
- Copy sweep: every user-visible literal "Elena"/"Andrea" in app/ becomes
  either the slot's displayName (template) or neutral copy. Known spots:
  state.js recipe why-texts (omelette/eggsturkey mention Andrea), PROF coach
  copy (coachD mentions Elena), index.html static strings, planner/render
  toasts. Grep-audit ALL of app/ (case-insensitive) — comments may keep names,
  user-visible strings may not. The auth gate copy "ask Elena to add your
  email" → "ask the person who runs this Mesa to invite you".

## B3 — Solo households

- Server: /auth/me additionally returns `householdMembers` (COUNT of users
  with this household_code). 1 member → solo.
- Client: persisted `householdSize` (1|2) in the profile/shared state, set
  from /auth/me at login (auto-upgrades to 2 when the partner's account
  attaches; a manual override control in Profile → Basics "I cook for: just
  me / me + partner" for safety, synced).
- When solo: partner profile hidden everywhere user-visible (profile segment
  toggle, per-meal eat-together/eat-different controls, "both" summaries),
  planner generates/keeps only slot1 portions (partner cells empty/zeroed,
  NOT ghost-planned), shopping list and pantry aggregate slot1 only, Insights
  and week summary single-person. AUDIT the portion/serving pipeline
  (planner.js servings, shopping aggregation, log) so no double quantities
  survive. Couple households see zero change.

## B4 — Partner invite flow (replaces admin D1 mapping)

- Worker: `POST /auth/invite-partner` (Bearer required) body {email}.
  Validations: valid-looking email, lowercased; inviter must have a household;
  target email not already a user in ANOTHER household (409 taken); inserts/
  updates allowed_emails row {email, note:'partner-invite', household_code:
  inviter's, member_slot: the OTHER slot from the inviter's}. Idempotent per
  email. Rate-limit: 5/day per user. MAX_USERS still caps actual signup.
- Client (Account section, signed-in card): if householdMembers === 1, an
  "Invite your partner" input+button → POST, success copy "Invited — when
  they sign in with Google they'll join your meal plan automatically."
  If 2 members: show partner linked state.
- README: manual d1 mapping commands stay documented as admin fallback.

## B5 — Enforcement flip + legacy retirement (manual gate, NOT automated)

Preconditions: Elena confirms both existing phones signed in (Account section
shows Household: linked on both).
- Set REQUIRE_SESSION="1" (wrangler.toml + deploy).
- Remove /bootstrap endpoint + client accessJwtFromCookie path (dead once
  sessions gate sync).
- Rotate the household code (leave/create/join equivalent server-side: new
  code, update both users' rows + KV sections copy + D1 recipe_prefs/
  tombstones rekey) — OPTIONAL, only because the old code predates session
  gating; skip if REQUIRE_SESSION makes code secrecy moot.
- README + KNOWLEDGE-BASE updates.

## Verification bar (every batch)

node --check all touched files; worker batches verified against wrangler dev
--local with curl matrices (session vs no-session vs wrong-household);
client batches served from a scratchpad copy and exercised via the browser
preview (login gate off-path: seed localStorage mesaAuth to bypass); couple
regression: a two-member household must behave byte-identically with
REQUIRE_SESSION="0" and no solo override.
