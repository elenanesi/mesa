# Phase 3D — Inviting friends + a real onboarding

## How inviting works TODAY (and why it isn't enough)

An email in `allowed_emails` may sign in; anything else is refused at the Google
callback. The row optionally carries `household_code` + `member_slot`:

- **With** them → the invitee joins THAT household in that slot. This is the
  partner flow (`POST /auth/invite-partner`, shipped in B4).
- **Without** them → the invitee gets a FRESH household of their own on first
  sign-in, as a one-person household. **This is the friend flow** — and there is
  no UI for it. It currently needs a wrangler D1 command, i.e. Elena's laptop.

Two gaps this batch closes:

1. **No way to invite a friend from the app.** Adding one must not become "any
   user can invite anyone" — the whole point of invite-only + `MAX_USERS` was to
   stop the app spreading. So: an `is_admin` flag, and only admins can invite
   new households.
2. **A new user inherits Elena's body.** `PROF.elena` still defaults to
   `sex:'female', dobY:1997, heightCm:168, weightKg:64, activity:1.55` and
   `avoid:['lactose','raw-onion','spicy']`. A friend signing in today gets
   calorie/macro targets computed from ELENA's Mifflin-St Jeor inputs and her
   dislikes. Every number would be confidently wrong — the exact failure the
   repo's "every number is computed, never typed in" rule exists to prevent.

## D1 — Worker: admin-issued invites

- Migration `0005_admin_flag.sql`: `ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;`
  then set it for Elena's row (ops step, not in the migration).
- `POST /auth/invite-user` — Bearer, **admin only** (403 `not_admin` otherwise).
  Body `{email, note?}`. Inserts an `allowed_emails` row with
  `household_code = NULL`, `member_slot = NULL` so the invitee gets their own
  household. Idempotent for an email already invited-but-not-signed-up; 409
  `taken` if a USER already exists with it. Rate limit 10/day/admin.
  Returns `{ok:true, email, seatsUsed, seatsMax}`.
- `GET /auth/me` gains `isAdmin` (bool), `seatsUsed` (non-deleted users) and
  `seatsMax` (`MAX_USERS`), so the UI can say "3 of 20 seats used" and hide the
  invite box from non-admins. Existing fields unchanged.

## D2 — Client: invite box in Account (admins only)

Account section, below the partner controls: an email field + "Send invite",
inline result copy, and a quiet "N of M seats used" line. Non-admins see
nothing. Error copy for `taken`, `not_admin`, `rate_limited`, `invalid_email`,
network failure. Reuse the B4 invite-partner UI patterns — do not fork them.

## D3 — Onboarding that actually sets up a person

Applies to a genuinely new household only (existing installs untouched — guard
on the same "has stored state" signal B3 used for `householdSize`).

**Neutral defaults first**: a fresh `PROF` must NOT carry a real person's body.
Use `sex:null, dobY:null, dobM:null, heightCm:null, weightKg:null,
activity:1.375 (sedentary-ish, the safest middle), avoid:[]`. Anything that
computes from these must handle "not set yet" without producing a confident
wrong number — audit `engine.js:recommendedCal`/`recomputeProf` and decide
explicitly what a profile with no body data shows (a prompt to finish setup is
fine; a fabricated 2,150 kcal is not).

**Steps** (extend the existing onboarding, keep its structure/styling/step
mechanics — this is new fields, not a redesign):
1. name (already there)
2. sex — required for Mifflin-St Jeor; offer female / male / prefer not to say,
   and if "prefer not to say" is chosen, state what it falls back to
3. date of birth (year + month, matching `dobY`/`dobM`)
4. height (cm) and weight (kg) — reuse the Basics steppers/typeable inputs
5. activity level — reuse `ACTIVITY_LEVELS`
6. dietary needs — the existing `AVOID_KEYS` pills (lactose, gluten, shellfish,
   nuts, raw-onion, spicy) plus the new diet preference from D4

Every value must be written through the SAME commit path Profile → Basics uses
(`commitDisplayName`/`commitHeight`/`commitWeight`/`setActivity`/avoid editor),
never by assigning to `PROF` directly, so persistence, sync stamping and
recompute all behave identically. Skipping onboarding must leave the profile in
the honest "not set up yet" state, with Profile → Basics the place to finish.

## D4 — Vegetarian / vegan as a real planner filter

Today `veggie` is a recipe TAG on 45 recipes used only for "why this meal" copy;
the planner never filters on it. Add a per-person `diet` preference
(`'none' | 'vegetarian' | 'vegan'`), persisted+synced like `avoid`, enforced as a
HARD filter in the planner's candidate enumeration exactly where the `avoid`
list is applied.

**Honesty constraint**: the recipe data marks `veggie` but does NOT mark eggs,
dairy or honey, so vegan cannot be derived reliably from tags alone. Either
derive it from the recipes' ingredient food ids (if the food DB has a dependable
signal — check `category` on FOODS) or implement vegan as vegetarian + lactose
avoidance and SAY SO in the UI copy. Do not silently ship a "vegan" filter that
still plans omelettes. Whatever is chosen, state it in the report and reflect it
in the picker's helper text.

## Sequencing

D1 ∥ D2 (worker/client, no overlap). Then D3, then D4 — both touch state.js and
the planner-adjacent profile fields, so they must not run in parallel.
Each batch: `node --check`, `node tools/check.js` (998 green), browser
verification as a genuinely new user.
