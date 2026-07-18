# Phase 3 — Generic multi-user Mesa (plan)

Goal: turn Mesa from a two-person private app (Elena + Andrea, Cloudflare Access
allow-list, secret household code) into an app any user can sign up for — solo or
with a partner — with a light social layer (friends, favorite meals, goal streaks).
Stack stays 100% Cloudflare: Pages (app) + Worker (API) + D1 (relational data) +
KV (optional cache). No servers, likely still free-tier.

Status: PLAN — nothing implemented yet.

---

## What is hardcoded today (audit)

1. **Auth**: Cloudflare Pages sits behind Cloudflare Access with a 2-email
   allow-list; `worker/sync.js /bootstrap` verifies the Access JWT and only
   honors those two emails. Access is per-seat and allow-listed — it cannot be
   the login for a public app.
2. **Household model**: a household *is* a random secret code (the code is the
   auth). KV stores section blobs per code. D1 `recipe_prefs` /
   `library_tombstones` are keyed by `household_code`.
3. **Two named people**: sync sections are hardcoded
   `profile:elena`, `profile:partner`, `log:elena`, `log:partner`
   (`app/js/sync.js:60`), and `state.js` `PROF` has `elena` / `andrea`-specific
   goal logic (hashi/skin vs muscle) baked in.
4. **Public copy**: GitHub Pages mirror (elenanesi.github.io/mesa) has no backend.

---

## Target model

```
user (1) ──── member_of ────> household (1..2+ members)
user (N) <─── friendship ───> user (N)        [independent of household]
```

- **Every user gets a household at signup** — a solo user is simply a household
  of one. No special-casing "single mode" anywhere: plan/shopping/library are
  always household-scoped, profile/log are always member-scoped.
- **Partner sharing** = second user joins your household via a short-lived
  invite code (replaces today's permanent secret code).
- **Friends** are user↔user, cross-household, read-only, opt-in per signal.

---

## Phase A — Accounts & sessions (foundation)

**A1. Auth in the Worker, not Access.**
Email OTP ("enter your email → we send a 6-digit code") is the recommendation:
- Works in an iOS installed PWA (no OAuth redirect pain), no app-store review,
  no third-party auth vendor, zero client dependencies — fits Mesa's style.
- Needs one external service: a transactional email API (Resend free tier:
  3k emails/month — fine). Google Sign-In can be added later as a convenience.

**A2. D1 tables** (new migration `0003_users_auth.sql`):
```sql
users(id TEXT PK, email TEXT UNIQUE, display_name TEXT, handle TEXT UNIQUE,
      created_at INTEGER, deleted_at INTEGER)
auth_codes(email TEXT, code_hash TEXT, expires_at INTEGER, attempts INTEGER)
sessions(token_hash TEXT PK, user_id TEXT, created_at INTEGER,
         expires_at INTEGER, last_seen_at INTEGER)
```
Session token = crypto-random 256-bit, stored hashed, sent as `Authorization:
Bearer` header (localStorage, not cookies — avoids cross-origin cookie pain
between Pages and workers.dev; revisit if we put the Worker on a custom domain).
Long-lived sessions (90d, sliding) — it's a PWA, people must stay logged in.

**A3. Endpoints**: `POST /auth/request-code`, `POST /auth/verify` (→ session
token; creates user + solo household on first login), `POST /auth/logout`,
`GET /me`. Rate-limit request-code hard (per-IP + per-email).

**A4. Make the app public**: remove Cloudflare Access from the Pages project;
app boots to a login screen when no session. Keep the GitHub Pages mirror as
a **no-account demo mode** (local-only, no sync) or retire it — decision below.

## Phase B — Generic households & sync migration

**B1. Tables** (`0004_households.sql`):
```sql
households(id TEXT PK, created_at INTEGER)
household_members(household_id TEXT, user_id TEXT, joined_at INTEGER,
                  PRIMARY KEY(household_id, user_id))
household_invites(code TEXT PK, household_id TEXT, created_by TEXT,
                  expires_at INTEGER)   -- 7-day TTL, single-use
household_sections(household_id TEXT, section TEXT, rev INTEGER,
                   updated_at INTEGER, data_json TEXT,
                   PRIMARY KEY(household_id, section))
```
Move section blobs KV → D1 (`household_sections`): enables real account
deletion, per-user quotas, and joins later. The dumb rev/LWW merge protocol is
unchanged — only the storage and the auth in front of it change. KV keeps only
rate-limit counters.

**B2. Sync endpoints**: `/sync/:code` → `GET|POST /sync` (session auth; server
resolves the user's household). The client-side merge code (`app/js/sync.js`)
is untouched except transport.

**B3. Generic member sections**: `profile:elena` → `profile:<userId>`,
`log:<userId>`. Client keeps a `members` list (from `GET /me`) instead of the
hardcoded elena/partner pair. This is the biggest client refactor: `PROF`
in `state.js` becomes data-driven — goals (thyroid/skin/muscle/heart/veggie)
become per-profile toggles chosen in onboarding, not per-person hardcoding.
The goal *rules* engine already reads toggles for skin — extend that pattern
to all goals and delete the elena/andrea special cases.

**B4. Onboarding flow** (new UX): email OTP → name + handle → goals picker →
"cook for just me / me + partner (invite later)" → seeded week plan.

**B5. Migration for us**: one-off script maps the existing household code's KV
sections + D1 `recipe_prefs`/tombstones to two new user rows (Elena, Andrea)
in one household, renaming `profile:elena`→`profile:<elena_id>` etc. Run once,
verify, then remove `/bootstrap` and the Access-JWT code path entirely.

## Phase C — Friends & social layer

**C1. Tables** (`0005_friends.sql`):
```sql
friendships(user_a TEXT, user_b TEXT, status TEXT CHECK(status IN
            ('pending','accepted')), requested_by TEXT, updated_at INTEGER,
            PRIMARY KEY(user_a, user_b))     -- user_a < user_b canonical order
user_highlights(user_id TEXT PK, updated_at INTEGER, data_json TEXT)
```
`user_highlights` is a tiny **published read-model**, not raw data: the client
periodically pushes `{favRecipes:[{id,title,emoji}], goalsWeek:{met:3,of:4},
streakDays:12}` — only fields the user has opted into sharing.

**C2. Privacy defaults**: nothing shared until opted in; per-signal toggles
("share my favorite meals", "share whether I hit my goals"). Never raw logs,
never weights, never per-nutrient numbers — only met/not-met summaries.

**C3. Endpoints**: `POST /friends/request` (by handle or invite link),
`POST /friends/respond`, `GET /friends` (list + each friend's highlights),
`DELETE /friends/:id`.

**C4. UI — Friends tab**: add-friend (handle / share-link), friend cards with
their fav meals + goal badge ("Sofia hit 4/4 goals this week 🔥").
**"Follow a friend's fav meal"** = import that recipe (from the global D1
catalog by id, or a snapshot in highlights for custom recipes) into your own
library with a "via Sofia" provenance tag.

## Phase D — Hardening & ops (before inviting strangers)

- Per-user quotas (sections ≤ 1MB, highlights ≤ 10KB), Worker rate limits.
- Account deletion (GDPR-style): delete sessions, membership, highlights,
  friendships; household data deleted when last member leaves.
- Handle abuse basics: handles are unique + reserved-word filtered; friend
  requests capped/day.
- Custom domain for Worker + Pages (cookies + nicer invite links), Turnstile
  on /auth/request-code if email abuse appears.
- D1 backups: nightly export via scheduled Worker (D1 has time-travel, but an
  export to R2 is cheap insurance).

---

## Decisions made (flag if you disagree)

| Decision | Choice | Why |
|---|---|---|
| Login method | Email OTP first, Google later | PWA-friendly, no vendor, fits zero-dependency style |
| Email sender | Resend free tier | MailChannels' free Workers tier is gone |
| Section storage | Move KV → D1 | deletion, quotas, queries; merge protocol unchanged |
| Household for solo users | Always create one | no dual code paths |
| Partner linking | Short-lived invite code | permanent-secret-as-auth doesn't survive real users |
| Friends data | Published opt-in highlights read-model | privacy by construction; no query-time exposure of raw data |

## Open questions for Elena

1. **GitHub Pages mirror**: keep as an account-free demo mode, or retire it
   once login exists? (Keeping it means maintaining a "no-sync" code path.)
2. **Handle vs email for friend adds**: handles are nicer but add a namespace
   to manage; invite-links only would be simplest for v1.
3. Households of **more than 2** (family)? The schema allows it; the planner UX
   (servings, "both/only me") currently assumes ≤2. Suggest: schema allows N,
   UI supports 2 for now.
4. Do we need Apple/Google sign-in at launch, or is email OTP enough for the
   first external users?

## Suggested build order (each = one PR-sized batch, Sonnet-agent friendly)

A1–A3 (worker auth + D1) → A4 (login screen, de-Access) → B1–B2 (household
storage + sync transport) → B3 (generic profiles refactor — biggest one) →
B4 (onboarding) → B5 (our migration) → C1–C4 (friends) → D (hardening).
Rough sizing: A ≈ 2 sessions, B ≈ 3–4 (B3 is the beast), C ≈ 2, D ≈ 1–2.
