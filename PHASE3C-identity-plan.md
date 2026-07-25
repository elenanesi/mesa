# Phase 3C — Real identities: names and Google avatars

Two defects, one root cause. Reported: on Andrea's phone HE is labelled
"Partner" and Elena is "You"; and now that Google sign-in exists, the app should
show real names and Google profile photos rather than pronouns.

## Why it's still wrong

The viewer-relative fallback shipped and works, but it depends on
`myMemberSlot()`, which is only written by `/auth/me` — and that call lives in
`initAuth()`, which runs at the END of the app's boot chain. On a device where
boot fails (Elena's Safari does), the slot is never cached, so every unnamed
slot falls back to "slot 1 = You" and the second member sees themselves as
"Partner". The same skipped call is why names were never seeded from Google.

So: the identity data must arrive on a path that cannot be blocked by app boot,
and it should come from the SERVER for BOTH members rather than relying on the
couple-sync of a locally-seeded name.

## Ground rules (unchanged)

- `'elena'` / `'partner'` are OPAQUE slot ids meaning slot 1 / slot 2. Never
  renamed, never shown.
- Real names are shared household data (both phones show "Andrea" for slot 2).
  Only the FALLBACK for an unnamed slot is viewer-relative.
- A name the user typed themselves always wins over anything from Google.

---

## C1 — Worker: `/auth/me` returns the household roster (small)

`GET /auth/me` gains a `members` array — every non-deleted user sharing the
caller's `household_code`:

```json
"members": [
  {"slot":"elena","displayName":"Elena Nesi","firstName":"Elena",
   "picture":"https://lh3.googleusercontent.com/...","isSelf":true},
  {"slot":"partner","displayName":"Andrea Angelucci","firstName":"Andrea",
   "picture":"https://...","isSelf":false}
]
```

- `firstName` = first whitespace-delimited word of `display_name`, capped at 24
  chars (matches the client's DISPLAY_NAME_MAX_LEN) — computed server-side so
  both devices agree.
- Only `slot`, names and picture. No emails: a household roster does not need
  to leak the partner's address, and nothing in the UI shows it.
- Rows with a null/unknown `member_slot` are omitted.
- Every existing field of the response stays byte-identical.
- `householdMembers` (the count) stays — B3's solo logic reads it.

## C2 — Client: identity directory, boot-independent

- Cache the roster device-locally (`mesaAuthMembers`) alongside the other auth
  keys; expose `memberDirectory()` and `memberInfo(slot)`.
- **Move the `/auth/me` call and its slot/roster caching into
  `initAuthEarly()`** so a failing app boot can no longer prevent identity from
  resolving. Everything it triggers is already typeof-guarded; the parts that
  need loaded state (`applyOwnMemberSlot`, name seeding into PROF) must stay
  deferred until state exists — re-run them from `initAuth()` using the cached
  roster.
- `resolveDisplayName(slot)` precedence becomes:
  1. a real name stored in `PROF[slot].displayName` (someone typed it),
  2. the roster's `firstName` for that slot,
  3. viewer-relative fallback: own slot → "You", other → "Partner".
- Keep seeding `PROF[slot].displayName` from the roster (so the name persists,
  syncs, and survives sign-out), but never overwrite a user-typed name.
- Verify the mirror case explicitly: slot-2 viewer sees "Andrea"/"Elena", never
  himself as "Partner".

## C3 — Client: Google profile photos as avatars

- `memberInfo(slot).picture` drives a round avatar wherever an initial letter is
  shown today: the Today header avatar, the Profile screen avatar, and the
  serve cards. The Account section already shows the signed-in user's photo —
  reuse its markup conventions.
- Strict URL handling: render an `<img>` only for an `https://` URL; anything
  else falls back to the initial-letter circle. Add `referrerpolicy="no-referrer"`
  and an `onerror` that swaps back to the initial circle, so a broken/expired
  Google URL degrades instead of showing a blank hole.
- `alt=""` (decorative — the name is always adjacent), `loading="lazy"`.
- No CSP in index.html, so `lh3.googleusercontent.com` loads fine; do not add
  one in this batch.

## Sequencing

C1 and C2 in parallel (the contract above is fixed). C3 after C2, since it
consumes `memberInfo()`. Each batch: `node --check`, `node tools/check.js`
(998 must stay green), and browser verification of BOTH viewers.

## Still open (not this batch)

Elena's Safari boot failure — `boot.fail` logging is live; diagnose from her
next log. Identity no longer depends on it, but the app itself still might.
