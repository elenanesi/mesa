# Phase 3A — Google auth + user structure (spec)

Scope of this batch: real user accounts (Google sign-in) in the mesa-sync Worker
+ D1, invite-only allow-list, hard user cap, and a Profile → Account section in
the PWA. **No gating and no sync changes yet** — couple-sync keeps working on the
household code exactly as today; sessions become the sync auth in Phase 3B.

## D1 migration `worker/migrations/0003_users_auth.sql`

```sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,              -- crypto.randomUUID()
  email TEXT NOT NULL UNIQUE,       -- lowercased
  google_sub TEXT UNIQUE,
  display_name TEXT,
  picture_url TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,      -- hex SHA-256 of the bearer token
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,      -- epoch ms
  last_seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS allowed_emails (
  email TEXT PRIMARY KEY,           -- lowercased
  note TEXT,
  added_at INTEGER NOT NULL
);
```

## Worker endpoints (new module `worker/auth.js`, imported + routed from sync.js)

Style: plain JS, module syntax, zero dependencies, same json()/corsHeaders()
helpers (export what's needed or pass them in). `corsHeaders` must start
allowing the `Authorization` request header.

- `GET /auth/google/start?return_to=<origin>`
  - 503 `{error:'auth_not_configured'}` if `env.GOOGLE_CLIENT_ID` unset/empty.
  - `return_to` must be an ALLOWED_ORIGINS member, else 400.
  - state = 32 hex random bytes; `MESA_KV.put('authstate:'+state, JSON({origin}),
    {expirationTtl: 600})`.
  - 302 to `https://accounts.google.com/o/oauth2/v2/auth` with client_id,
    `redirect_uri = <request url origin> + '/auth/google/callback'`,
    response_type=code, scope=`openid email profile`, state, prompt=select_account.
- `GET /auth/google/callback?code&state`
  - state must exist in KV (get then delete), else redirect `<fallback first
    allowed origin>/#auth_error=state`. All error exits below redirect to the
    stored origin with `#auth_error=<reason>` (browser navigation, not JSON).
  - Rate-limit per IP ~30/hour (reuse the KV counter pattern from
    bootstrapRateLimited).
  - Exchange code: POST `https://oauth2.googleapis.com/token`
    (client_id, client_secret=env.GOOGLE_CLIENT_SECRET, code,
    grant_type=authorization_code, same redirect_uri derivation).
  - Decode id_token payload (base64url middle segment; came directly from
    Google over TLS so no signature check, but VERIFY: aud === GOOGLE_CLIENT_ID,
    iss ∈ {https://accounts.google.com, accounts.google.com}, exp in future,
    email_verified === true). email lowercased.
  - Not in allowed_emails → `#auth_error=not_invited`.
  - User lookup by email. New user: if `COUNT(users WHERE deleted_at IS NULL)`
    >= int(env.MAX_USERS || 20) → `#auth_error=full`; else INSERT. Existing:
    refresh google_sub/display_name/picture_url.
  - Session: 32 random bytes → hex token; store SHA-256 hex; expires_at =
    now + 90d. Opportunistically `DELETE FROM sessions WHERE expires_at < now`.
  - Redirect `<origin>/#auth=<token>` (fragment: stays out of server logs).
- `GET /auth/me` — `Authorization: Bearer <token>`. 401 `{error:'unauthorized'}`
  if missing/unknown/expired. Sliding renewal: if < 45d left, extend to 90d.
  Update last_seen_at (only if > 1h stale). Returns
  `{user:{id,email,displayName,picture}, expiresAt}`.
- `POST /auth/logout` — Bearer; delete the session row; `{ok:true}`.

## Config
- `worker/wrangler.toml` `[vars]`: `GOOGLE_CLIENT_ID = ""` (placeholder — real
  value pasted when the GCP client exists), `MAX_USERS = "20"`.
- Secret (manual, at deploy): `npx wrangler secret put GOOGLE_CLIENT_SECRET`.
- Local dev: `worker/.dev.vars` (gitignored) for GOOGLE_CLIENT_SECRET; local
  verification without real Google via curl-level checks only.
- Allow-list admin (documented in README, run per invitee):
  `npx wrangler d1 execute mesa-library --remote --command "INSERT OR IGNORE INTO allowed_emails (email, note, added_at) VALUES ('x@y.z','friend',strftime('%s','now')*1000)"`

## Client (PWA)
- New `app/js/auth.js` (plain JS, same style as sync.js; no modules).
  - Boot: parse `location.hash` — `#auth=<token>` → save to localStorage
    `mesaAuth`, strip hash via history.replaceState, then GET /auth/me and
    cache `{user}` in localStorage `mesaAuthUser` (offline display).
    `#auth_error=<reason>` → toast + strip hash.
  - Globals: `authUser()`, `authSignIn()` (location.href =
    SYNC_URL + '/auth/google/start?return_to=' + encodeURIComponent(location.origin)),
    `authSignOut()` (POST /auth/logout, clear storage, re-render).
- `app/index.html`: "Account" section on the Profile screen ABOVE Couple sync
  (`<h2 id="accountHeading">` + `<div id="accountSection">`), chip-nav button
  `jumpToProfileSection('accountHeading',this)`, script tag for js/auth.js
  after js/sync.js.
- `renderAccountSection()` called next to renderCoupleSync() (render.js:~3600).
  Signed out: one-line explanation + "Sign in with Google" button (white pill,
  inline G logo SVG, existing .cta styling conventions). Signed in: picture +
  name + email + Sign out (ghost button). auth_error copy: not_invited → "Mesa
  is invite-only right now — ask Elena to add your email."; full → "Mesa is at
  capacity and can't take new accounts."
- The app must not gate anything on being signed in (Phase 3B does that).

## Elena's manual GCP step (blocking real login, not deploy)
1. GCP Console → APIs & Services → OAuth consent screen → External, app "Mesa",
   scopes: openid/email/profile. (Testing mode is fine; add testers.)
2. Credentials → Create credentials → OAuth client ID → Web application.
   Authorized redirect URI: `https://mesa-sync.elenanesi55.workers.dev/auth/google/callback`
   (optionally also `http://127.0.0.1:8787/auth/google/callback` for local dev).
   No JS origins needed (server-side flow).
3. Paste client ID into wrangler.toml GOOGLE_CLIENT_ID; run
   `npx wrangler secret put GOOGLE_CLIENT_SECRET`; redeploy worker.

---

# Phase 3A.2 — Login gate + automatic household attach (spec addendum)

Two requirements on top of 3A: (1) the app is inaccessible until signed in;
(2) a signing-in user is automatically attached to their existing household
data (Elena/Andrea must not start from scratch). Sync itself stays on the
household code (server-side session-gating of /sync is Phase 3B) — so the
gate is client-side; the attach mapping is server-side and authoritative.

## D1 migration `worker/migrations/0004_household_attach.sql`

```sql
ALTER TABLE users ADD COLUMN household_code TEXT;
ALTER TABLE users ADD COLUMN member_slot TEXT;
ALTER TABLE allowed_emails ADD COLUMN household_code TEXT;
ALTER TABLE allowed_emails ADD COLUMN member_slot TEXT;
```

`allowed_emails.household_code/member_slot` are OPTIONAL signup defaults: when
an invited email signs in for the first time, its user row copies them — this
is how an invited partner lands in an existing household with the right
profile slot. member_slot vocabulary is the app's current PROF keys:
`'elena'` (primary) | `'partner'` (second member). Yes, legacy naming — the
generic member model renames these in Phase 3B; do not rename anything now.

## Worker (auth.js) changes

- On user CREATION in the callback: copy household_code + member_slot from the
  matching allowed_emails row; where NULL, generate a fresh household code
  (export generateHouseholdCode from sync.js — do not duplicate it) and slot
  'elena'. Every user therefore always has a household after first login
  (solo users get a fresh empty one).
- BACKFILL on every login (callback) for an EXISTING user whose
  household_code IS NULL: same copy-from-allowed_emails-else-generate logic.
  (Covers a user created before this migration.)
- `GET /auth/me` response gains top-level `householdCode` and `memberSlot`.

## Client changes

- **Login gate**: a full-viewport fixed overlay (id `loginGate`, z-index above
  everything, app-styled: Mesa wordmark/emoji, one welcoming line, the same
  white-pill Google button, and an error line fed by #auth_error). Shown when
  NO token is stored in localStorage `mesaAuth`, or when /auth/me returns a
  definitive 401 (network errors do NOT gate — an offline PWA with a stored
  token must keep working). Hidden immediately after a token is stored /
  auth confirmed. Sign-out clears the token and shows the gate again.
  Implement in js/auth.js + a static div in index.html; block scroll behind.
- **Auto-attach** after a successful /auth/me that carries householdCode:
  - If NO local household is configured (syncState.code null): silently adopt
    householdCode through the exact same code path joinHousehold() uses
    (normalize, fetch full state, applySyncResponse, persist code), WITHOUT
    prompting, then if memberSlot is 'elena'/'partner' switch the active
    profile to it, and toast that their data is restored.
  - If a local household code exists and DIFFERS from the server's: keep
    local, console.warn both (Phase 3B reconciles) — do not clobber.
- Account section signed-in card additionally shows "Household: linked" state.

## Ops at deploy (main session, not agents)

1. Apply 0004 remotely; deploy worker; Pages deploy with new sw build.
2. Read the current household code from KV `access-bootstrap:v2:mesa-household`
   and UPDATE allowed_emails (elena → slot 'elena') + Andrea's row when his
   email is known (slot 'partner'); also backfill users rows if they exist.
