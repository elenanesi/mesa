# Mesa admin tool

A small local page for the app owner to manage Mesa seats and invites. It is
**not** part of the PWA — not under `app/`, not in the service worker's
shell, never deployed anywhere. It only exists on your machine.

## Run it

```
python3 tools/admin/serve.py
```

Then open **http://127.0.0.1:8322/** in a browser.

## Why the port is fixed

The Mesa sync worker only redirects a sign-in back to an origin it already
trusts (`ALLOWED_ORIGINS` in `worker/sync.js`), and that list already
contains `http://127.0.0.1:8322` and `http://localhost:8322` for exactly
this purpose. The server is pinned to that host/port so "Sign in with
Google" works without any worker change. Opening `index.html` directly via
`file://` will not work — that origin is `null` and the worker rejects it.

## Who can use it

Anyone can load the page and click "Sign in with Google," but only a Mesa
account with `is_admin` set in D1 sees anything past the sign-in screen.
Every other signed-in account gets a plain "this account isn't a Mesa
admin" message and a sign-out button — no seats, no roster, no invite form.

## What it talks to

Directly to the deployed sync worker
(`https://mesa-sync.elenanesi55.workers.dev`) — the same backend the app
uses:

- `GET /auth/me` — confirm the session and check `isAdmin`.
- `GET /auth/admin/users` — the roster table (seats, invited/signed-up
  status, slot, household, live sessions, last seen, admin flag).
- `POST /auth/invite-user` — invite a new person by email.
- `POST /auth/admin/revoke` — remove someone's access. This deletes their
  invite and signs out all of their devices, but does **not** delete their
  account row or their household's meal data — re-inviting the same email
  undoes it.
- `POST /auth/logout` — best-effort on sign-out.

The session token is stored in this page's own `localStorage` under
`mesaAdminAuth` (a different key than the app's `mesaAuth` — they're
already on different origins, but the distinct name avoids any confusion
if you ever look at both in devtools).
