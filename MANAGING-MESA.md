# Managing Mesa — owner's guide

A practical guide for running Mesa day to day: editing the food/recipe catalog, inviting
people, understanding how changes reach the app, and deploying. Written for the app owner
(you), not a developer. When something is bigger than this guide covers, hand it to Claude Code.

---

## 1. The pieces (what lives where)

- **The app (PWA)** — what you and Andrea use on your phones. Hosted on **Cloudflare Pages**
  at `https://mesa-9y5.pages.dev/app/`.
- **The catalog (D1 database)** — the master list of built-in ingredients and recipes. The app
  **reads this fresh every time it launches** and uses it in place of the copy baked into the code.
  **D1 is the source of truth** for what ingredients/recipes exist.
- **Household data (KV store)** — your and Andrea's plans, logs, pantry, custom recipes, book.
  Synced between your two phones.
- **The admin tool** — a small page that runs **on your Mac only** (never deployed). It's how you
  edit the global catalog and manage who can use Mesa.

---

## 2. Opening the admin tool

1. In a terminal, from the project folder, run:

   ```bash
   python3 tools/admin/serve.py
   ```

2. Open **http://127.0.0.1:8322/** in your browser. (The port must be `8322` — the login only
   works from that exact address. Don't open the file directly.)
3. **Sign in with Google** using your admin account. Only an account marked admin sees anything
   past sign-in; anyone else just gets "this account isn't a Mesa admin."

The tool has tabs for **Recipes**, **Ingredients**, and **people/seats**.

---

## 3. Editing ingredients & recipes — is it safe? (Yes)

**Yes, it's safe to edit ingredients and recipes in the admin tool and push to D1. Your phone
will not fight it.** Here's why there's no out-of-sync problem:

- The admin tool writes to the **global catalog** in D1.
- Phones only ever **read** the global catalog. They **never push** built-in ingredients/recipes
  back — the app strips those out before syncing, and the server rejects them anyway. (Phones only
  sync *your own* custom recipes/overrides, which are separate.)
- So a phone can't overwrite your admin edits.

**How to make a change:** edit a row (or add one), then press **"Save changes to D1."** Nothing is
live until you press that.

**When it shows up:** on the **next app launch**. The app loads the catalog at startup, so
**close and fully reopen the app** to see your edit. It won't change mid-session.

**One caveat — personal overrides win.** If you or Andrea edited a specific recipe/ingredient
*inside the app* (not the admin tool), that creates a personal override that shadows the global
one for your household. An admin edit to that same recipe won't show for you until the override is
cleared. This is rare; if an admin edit "won't take" for one recipe, that's the likely reason —
ask Claude Code to check.

---

## 4. The rules that bite (read before editing)

These are the gotchas we hit and fixed this autumn — know them so you don't recreate the pain:

- **"Slots" is the field that matters, not "Slot."** A recipe's *Slot* is just its primary/display
  slot. The planner decides where a recipe can appear from the **Slots** list (e.g. `lunch, dinner`).
  To make something lunch-only, set **Slots** to `lunch`. Leaving Slots **empty** now means "just
  the primary Slot." (Clearing Slots used to silently revert — that's fixed.)

- **Slot/diet changes only affect *future* planning.** They don't retroactively move meals already
  placed or pinned in your current week. Regenerate the day/week to apply a restriction.

- **⚠️ Allergen flags for brand-new ingredients need a code change.** Nuts and gluten are decided
  from a hand-curated list in the code, *not* from the ingredient itself. If you add a genuinely
  nutty or gluten-containing ingredient in the admin tool, the planner will **not** automatically
  know it's a nut/gluten unless its id is added to that list. **For any allergen-bearing new
  ingredient, ask Claude Code to add it to the allergen lists** — this is a safety matter (someone
  who sets "avoid nuts" trusts the planner). Lactose/shellfish are category-based and usually fine.

- **Removing an ingredient is blocked while a recipe still uses it.** Replace/remove it from those
  recipes first.

- **New recipes need at least one ingredient** before they can be saved. Missing fields
  (`avoid`/`tags`/`styles`/`emoji`) are now auto-filled on load, so a bare admin recipe won't crash
  the planner anymore — but giving a recipe real styles/tags makes it plan better.

- **Batch items (pesto, cinnamon rolls) are composite foods.** If something is made/bought as a
  batch and eaten over time, it should be a *composite ingredient* (e.g. "Pesto Elena", "Cinnamon
  roll (baked batch)"), not a plain recipe. Stock it in the pantry and each use draws down the
  batch instead of its raw ingredients. Ask Claude Code to set up new batch items.

---

## 5. Seeing your changes / the pantry & shopping logic

- **Catalog edits** → reopen the app.
- **Shopping "have" vs the Pantry page:** the Pantry page shows current stock; the **Next week**
  shopping list shows what's left for next week *after this week's remaining meals eat their share*,
  so the two numbers can legitimately differ. That's expected, not a bug.
- **Seasons:** recipes tagged `winter/autumn` vs `spring/summer` are filtered by date — autumn/winter
  runs from the Sept 23 equinox to spring. An out-of-season recipe simply won't be auto-planned now;
  it returns in its season.

---

## 6. Managing people

In the admin tool's roster:

- **Invite** someone by email → they can sign in and claim a seat.
- **Revoke** removes their access and signs out their devices, but keeps their account and meal data
  — re-inviting the same email restores them. (Max seats are capped in the worker config.)

---

## 7. Deploying code changes (when Claude Code ships a feature)

You normally won't do this by hand — Claude Code does it. For reference, the flow is:

```bash
node tools/build-sw.js      # refresh the service-worker cache stamp
node tools/check.js         # run the test suite (must be all green)
git add … && git commit     # commit the change
git push origin main
CLOUDFLARE_API_TOKEN="$(security find-generic-password -s cloudflare-token -a mesa -w)" \
  npx wrangler pages deploy app --project-name mesa --commit-dirty=true
```

After a deploy, **close and reopen the app** so the new service worker activates (it may briefly
show old content for a few seconds first — that's normal).

**Adding a built-in ingredient/recipe in CODE (not the admin tool)?** It won't appear in the app
until it's also in D1. Run `node tools/catalog-drift.js` to see anything that's in the code but
missing from the live catalog, then seed it. (Admin-tool additions go straight to D1, so this only
matters for code changes.)

---

## 8. Quick troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Admin edit doesn't show in the app | Reopen the app (catalog loads at launch). If one recipe still won't update, a personal override may be shadowing it — ask Claude Code. |
| A recipe I restricted still appears at the wrong meal | You changed *Slot*, not *Slots*; or an already-placed meal — regenerate the week. |
| A new nutty/gluten ingredient isn't being avoided | Allergen lists are code-curated — ask Claude Code to add it (safety). |
| New built-in (added in code) is invisible | Not seeded to D1 — run `node tools/catalog-drift.js`, then seed. |
| A plan/meal edit "took two tries" | Fixed — the old native confirm dialogs were replaced with reliable in-app ones. |
| Can't delete an ingredient | A recipe still uses it — edit those recipes first. |

---

## 9. When to call Claude Code

Do these yourself in the admin tool: add/edit/remove ingredients & recipes, adjust slots/styles,
invite/revoke people.

Ask Claude Code for: allergen-list updates for new ingredients, setting up batch/composite foods,
seeding code-added built-ins to D1, planner/behaviour changes, bugs, and anything touching the
worker, sync, or deploy.

---

*Backend: Cloudflare (Pages = app, D1 = catalog, KV = household data, Worker = `mesa-sync`).
The admin tool talks to the same worker the app uses. The Cloudflare API token lives in your Mac's
keychain (`cloudflare-token` / account `mesa`).*
