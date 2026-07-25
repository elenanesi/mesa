/* ===================================================================
   auth.js — Google sign-in client (Phase 3A)

   Talks to worker/auth.js (imported + routed from worker/sync.js — see
   PHASE3A-auth-spec.md) for real user accounts. This is a Profile-screen
   convenience layer ONLY: per the spec, "No gating and no sync changes
   yet" — signing in/out never changes what the app can do. Nothing here
   is a precondition for anything else in the codebase; every function
   below is defensive about network failure, missing storage, and a
   worker that hasn't been redeployed with the auth routes yet (all of
   which degrade to "acts signed out", never a crash.

   Flow:
     1. Profile -> "Sign in with Google" -> authSignIn() bounces the
        whole page to the worker's /auth/google/start, which redirects to
        Google, which redirects back to the worker's /auth/google/callback,
        which redirects back HERE with the result in the URL fragment
        (never a query string / server log: '#auth=<token>' on success,
        '#auth_error=<reason>' on failure).
     2. On next boot (app.js calls initAuth() alongside initSync(), same
        guarded-optional style), consumeAuthHash() picks that fragment
        off location.hash, stores the token, and strips the hash via
        history.replaceState so it never lingers in the URL bar / history
        / a reload.
     3. The session token lives in localStorage (mesaAuth); the last-known
        user record is cached alongside it (mesaAuthUser) so the Account
        section can render the signed-in state instantly and offline,
        the same "paint from cache first" shape js/sync.js's Couple sync
        section already uses for syncState.
     4. Every boot with a stored token re-confirms it against GET
        /auth/me — this doubles as the server's sliding-renewal trigger
        (worker extends a session past 45 days-left only when /auth/me is
        actually called), so a signed-in user who opens Mesa regularly
        never gets silently logged out at the 90-day mark. A 401 here
        means the session is gone (revoked/expired) and clears local
        state; any OTHER failure (offline, worker briefly down) leaves
        the cached user exactly as-is — the whole point of caching it.
   =================================================================== */

/* ---------------- storage ---------------- */
// Two keys, per the spec: the bearer token itself, and a small cached copy
// of the user record for offline/instant display. Kept separate (not one
// JSON blob) so a corrupt/missing user cache can never take the token down
// with it, or vice versa.
const AUTH_TOKEN_KEY = 'mesaAuth';
const AUTH_USER_KEY = 'mesaAuthUser';

function authToken(){
  try{
    const t = localStorage.getItem(AUTH_TOKEN_KEY);
    return (typeof t === 'string' && t) ? t : null;
  }catch(e){ return null; } // storage unavailable (private mode, quota) — behave signed-out
}

function setAuthToken(token){
  try{
    if(token) localStorage.setItem(AUTH_TOKEN_KEY, token);
    else localStorage.removeItem(AUTH_TOKEN_KEY);
  }catch(e){ console.error('Mesa auth: could not persist session token', e); }
}

// authUser() — the ONE global other files (render.js et al) should read to ask "who's
// signed in, if anyone". Returns null for "signed out" in every failure mode (missing key,
// corrupt JSON, wrong shape) rather than ever throwing — callers never need a try/catch.
function authUser(){
  try{
    const raw = localStorage.getItem(AUTH_USER_KEY);
    if(!raw) return null;
    const u = JSON.parse(raw);
    if(!u || typeof u !== 'object' || typeof u.id !== 'string' || typeof u.email !== 'string') return null;
    return u;
  }catch(e){ return null; }
}

function setAuthUser(user){
  try{
    if(user) localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(AUTH_USER_KEY);
  }catch(e){ console.error('Mesa auth: could not persist cached user', e); }
}

/* myMemberSlot() — WHICH of the household's two profile slots this DEVICE's signed-in
   account occupies ('elena' = slot 1, 'partner' = slot 2; opaque ids, see the spec's
   ground rule). Cached device-locally next to the user record, deliberately OUTSIDE the
   synced profile sections: it is a fact about the viewer, not about the household, and
   syncing it would make each phone claim the other's identity.

   state.js:resolveDisplayName() reads this (through a typeof guard) to decide whose
   unnamed slot renders as "You" and whose as "Partner", which is what stops the
   slot-2 member from being labelled "Partner" on their own phone. Returns null when
   signed out or when talking to a worker too old to send member_slot — callers treat
   that as "assume this device's owner is slot 1", the historical single-device
   assumption. */
const AUTH_SLOT_KEY = 'mesaAuthSlot';

function myMemberSlot(){
  try{
    const s = localStorage.getItem(AUTH_SLOT_KEY);
    return (s === 'elena' || s === 'partner') ? s : null;
  }catch(e){ return null; }
}

function setMyMemberSlot(slot){
  try{
    if(slot === 'elena' || slot === 'partner') localStorage.setItem(AUTH_SLOT_KEY, slot);
    else localStorage.removeItem(AUTH_SLOT_KEY);
  }catch(e){ console.error('Mesa auth: could not persist member slot', e); }
}

/* ---------------- hash-fragment token pickup ---------------- */
// '#auth=<token>' / '#auth_error=<reason>' arrive from worker/auth.js's callback redirect
// (see file header). Matched with an anchored regex (not a plain indexOf) so a token that
// happens to contain '&'-adjacent characters can't confuse the split, and so this is a
// no-op (returns null) for every other hash the app already uses (jump-to-section anchors
// etc.) instead of misfiring on them.
function consumeAuthHash(){
  const hash = location.hash || '';
  const authMatch = /^#auth=([^&]*)/.exec(hash);
  const errMatch = /^#auth_error=([^&]*)/.exec(hash);
  if(!authMatch && !errMatch) return null;

  // Strip the fragment immediately either way — a token must never sit in the URL bar /
  // history longer than one tick, and an error fragment shouldn't survive a refresh either.
  try{ history.replaceState(null, '', location.pathname + location.search); }catch(e){ /* non-browser env — ignore */ }

  if(authMatch){
    const token = decodeURIComponent(authMatch[1] || '');
    if(token) setAuthToken(token);
    return 'token';
  }
  const reason = decodeURIComponent(errMatch[1] || '');
  const msg = authErrorMessage(reason);
  toast(msg);
  // With the login gate (Phase 3A.2) enabled, a failed sign-in usually lands the user
  // right back on the gate (never inside the app), so the toast alone would be easy to
  // miss — mirror the same copy into the gate's own error line if it's present.
  const gateErr = document.getElementById('loginGateError');
  if(gateErr) gateErr.textContent = msg;
  return 'error';
}

function authErrorMessage(reason){
  if(reason === 'not_invited') return 'Mesa is invite-only right now — ask the person who runs this Mesa to invite you.';
  if(reason === 'full') return "Mesa is at capacity and can't take new accounts.";
  return 'Sign-in didn’t work — please try again.';
}

/* ---------------- Phase 3B: shared with sync.js ---------------- */
// authHeader() — spread this into any fetch to SYNC_URL: {Authorization:'Bearer <token>'}
// when a session token is stored, else {} (always safe to Object.assign/spread — never
// produces an "Authorization: Bearer null"). sync.js calls this behind a typeof guard since
// it must not hard-depend on auth.js being loaded.
function authHeader(){
  const token = authToken();
  return token ? {Authorization: 'Bearer ' + token} : {};
}

// authSessionExpired() — the one path allowed to conclude "this stored token is dead":
// drops the token + cached user and repaints the Account section + login gate. Factored out
// of refreshAuthMe()'s 401 branch (Phase 3A) so the Phase 3B sync/library 401 checks in
// sync.js (also behind a typeof guard) can reuse it verbatim instead of duplicating it.
// Callers must only invoke this for an actual 401 with a token stored — never for a network
// error or any other status (see refreshAuthMe's doc for why).
function authSessionExpired(){
  setAuthToken(null);
  setAuthUser(null);
  renderAccountSection();
  updateLoginGate();
}

/* ---------------- server round-trips ---------------- */
// GET /auth/me — confirms the stored token is still valid, refreshes the cached user (name/
// picture can change on Google's side), and rides the server's sliding-renewal (see file
// header). Called on every boot that has a token, and once right after a fresh hash pickup.
// Silent by design (like js/sync.js's background performSync(false)) — this runs on every
// page load, so a toast on every transient network hiccup would be noise; a real 401 (session
// actually gone) still needs to flip the UI back to signed-out, which it does via renderAccountSection().
function refreshAuthMe(){
  const token = authToken();
  if(!token || typeof fetch !== 'function') return Promise.resolve(false);
  return fetch(SYNC_URL + '/auth/me', {
    method: 'GET',
    headers: {Authorization: 'Bearer ' + token}
  }).then(function(res){
    if(res.status === 401){
      // Session gone server-side (revoked, expired, or logged out elsewhere) — the local
      // token is now dead weight; drop it so the UI stops claiming to be signed in. This is
      // the ONE definitive signal the login gate (Phase 3A.2) reacts to — a network error a
      // few lines down in .catch() must NOT do this, or an offline PWA with a perfectly
      // valid stored token would get locked out the moment it loses signal. (Phase 3B:
      // sync.js's own 401 checks on /sync and /library reuse this exact same path via
      // authSessionExpired() rather than duplicating it.)
      authSessionExpired();
      return false;
    }
    if(!res.ok) throw new Error('auth/me http ' + res.status);
    return res.json();
  }).then(function(body){
    if(!body || !body.user || typeof body.user !== 'object') return false;
    setAuthUser(body.user);
    renderAccountSection();
    updateLoginGate();
    // Task B2 (generic identity): a Google account carries a real name — seed it onto the
    // active slot's displayName the first time we see it, but ONLY while that slot is
    // still on its untouched neutral default. Runs before maybeAdoptHousehold() below;
    // if that call goes on to pull an existing household's own synced profile data, its
    // LWW apply is free to overwrite this local guess with the real synced value, exactly
    // as it would for any other profile field — no special-casing needed here for that.
    // Which slot THIS device's account occupies — persisted before anything renders, since
    // resolveDisplayName()/applyOwnMemberSlot() below both key off it.
    setMyMemberSlot(body.memberSlot);
    maybeSeedDisplayNameFromGoogle(body.user, body.memberSlot);
    // Phase 3A.2: a signed-in account now carries its household mapping — silently attach
    // this device to it (or note a mismatch) so nobody lands on an empty Mesa.
    maybeAdoptHousehold(body.householdCode, body.memberSlot);
    // Open on the viewer's OWN profile. Previously this only happened inside
    // maybeAdoptHousehold's first-adoption branch, so a phone that ALREADY had the
    // household code (the normal case for a returning device) kept opening on slot 1
    // regardless of who was signed in — the second household member's phone showed them
    // their partner's profile.
    applyOwnMemberSlot(body.memberSlot);
    // Phase 3B (B3, solo households): server-confirmed member count, when the worker sends
    // it — see maybeSetHouseholdSizeFromServer's own doc for the upgrade/downgrade rule.
    maybeSetHouseholdSizeFromServer(body.householdMembers);
    return true;
  }).catch(function(err){
    // Offline, worker briefly unreachable, etc. — keep whatever's cached; nothing to undo.
    console.warn('Mesa auth: /auth/me check failed, keeping cached session', err);
    return false;
  });
}

/* ---------------- globals used by the Account UI ---------------- */
// Full-page redirect (server-side OAuth flow, no popup/JS SDK — see spec). return_to must be
// this exact origin so the worker's ALLOWED_ORIGINS check (server-side) accepts it and the
// callback redirect lands back on the same app instance that started the flow.
function authSignIn(){
  location.href = SYNC_URL + '/auth/google/start?return_to=' + encodeURIComponent(location.origin);
}

// Clears local session state immediately (so the UI feels instant and works even offline),
// then best-effort tells the server to drop the session row too. Order matters: local clear
// first means a flaky network never leaves the user stuck "signed in" on their own device.
function authSignOut(){
  const token = authToken();
  setAuthToken(null);
  setAuthUser(null);
  renderAccountSection();
  updateLoginGate();
  toast('✓ Signed out');
  if(token && typeof fetch === 'function'){
    fetch(SYNC_URL + '/auth/logout', {
      method: 'POST',
      headers: {Authorization: 'Bearer ' + token}
    }).catch(function(err){ console.warn('Mesa auth: logout request failed (already signed out on this device)', err); });
  }
}

/* ===================================================================
   Phase 3A.2 — automatic household attach

   A signed-in Google account now carries the household its /auth/me
   response resolved server-side (worker/auth.js: every user always has
   a household_code after first login — copied from an allowed_emails
   invite row, or freshly generated). This device should silently pick
   that up UNLESS it already has its own household configured, in which
   case the local one wins (Phase 3B reconciles cross-device mismatches;
   this phase never clobbers).

   Reuses js/sync.js's pullHouseholdFirst(code) verbatim — the exact
   same "normalize -> GET the full remote state -> applySyncResponse ->
   persist the code" path js/sync.js's own bootstrapAccessHousehold()
   already uses to restore a household after a Cloudflare Access login,
   so a Google-login restore behaves identically rather than
   reimplementing the join/merge logic here.
   =================================================================== */
/* ===================================================================
   Task B2 — seed the active slot's name from Google on first sign-in

   Guarded like every other cross-file call in this file: state.js/render.js/engine.js
   ship alongside auth.js in every real build, but never assumed at the cost of crashing
   sign-in. "Untouched default" is checked against DISPLAY_NAME_DEFAULTS (state.js) so a
   name the user (or their partner, via couple sync) already set is never clobbered —
   this only ever fires for a slot that's still sitting on 'You'/'Partner'.
   =================================================================== */
function maybeSeedDisplayNameFromGoogle(user, memberSlot){
  if(!user || typeof user.displayName !== 'string' || !user.displayName.trim()) return;
  if(typeof PROF === 'undefined' || typeof isPlaceholderDisplayName !== 'function') return;
  // Seed the slot THIS ACCOUNT occupies, not whichever profile happens to be on screen:
  // seeding the active slot wrote the signed-in person's name onto their PARTNER's profile
  // whenever the device was showing the other profile at sign-in time.
  const slot = (memberSlot === 'elena' || memberSlot === 'partner') ? memberSlot : null;
  if(!slot) return;
  const p = PROF[slot];
  if(!p) return;
  if(!isPlaceholderDisplayName(p.displayName)) return; // a real name is already set (typed here or synced from their phone) — never overwrite

  const cap = (typeof DISPLAY_NAME_MAX_LEN === 'number') ? DISPLAY_NAME_MAX_LEN : 24;
  const firstWord = user.displayName.trim().split(/\s+/)[0].slice(0, cap);
  if(!firstWord || (typeof isPlaceholderDisplayName === 'function' && isPlaceholderDisplayName(firstWord))) return;

  p.displayName = firstWord;
  if(typeof applyProf === 'function' && typeof currentProf !== 'undefined') applyProf(currentProf); // recomputes seg/av, repaints, persists (state.js:persist() drives the couple-sync rev bump)
  else if(typeof persist === 'function') persist();
}

/* Point the device at its OWN owner's profile after sign-in. Deliberately does nothing if
   the person has already switched profiles themselves during this session — being yanked
   back mid-look would be worse than opening on the "wrong" one. B3's one-person rule still
   wins: a solo household has only slot 1 on screen, so there is nothing to switch to. */
let lastAppliedOwnSlot = null;
function applyOwnMemberSlot(memberSlot){
  const slot = (memberSlot === 'elena' || memberSlot === 'partner') ? memberSlot : null;
  // Re-applying the SAME slot is a no-op (initAuth's cached-value call and the later
  // /auth/me call usually agree), but a slot that genuinely CHANGED server-side must still
  // win — hence tracking the last applied value rather than a one-shot boolean.
  if(!slot || slot === lastAppliedOwnSlot) return;
  lastAppliedOwnSlot = slot;
  if(typeof isSoloHousehold === 'function' && isSoloHousehold()) return;
  if(typeof currentProf === 'undefined' || currentProf === slot) return;
  if(typeof profileSwitchedByUser !== 'undefined' && profileSwitchedByUser) return;
  if(typeof applyProf === 'function') applyProf(slot);
}

function maybeAdoptHousehold(householdCode, memberSlot){
  if(typeof householdCode !== 'string' || !householdCode) return; // older cached /auth/me shape, or a worker not yet on 3A.2 — no-op
  // Guarded like every other cross-file call in this file: sync.js ships alongside auth.js
  // in every real build, but never assume it at the cost of crashing sign-in.
  if(typeof syncState === 'undefined' || typeof normalizeHouseholdCode !== 'function' || typeof pullHouseholdFirst !== 'function') return;

  const serverCode = normalizeHouseholdCode(householdCode);
  if(!serverCode) return;

  if(syncState.code){
    if(syncState.code !== serverCode){
      // Per spec: keep local, never clobber — just leave a breadcrumb for later debugging.
      // Truncated (not the full code) since this can land in a shared/remote console log.
      console.warn('Mesa auth: signed-in account\'s household (' + serverCode.slice(0, 4) + '…) differs from this device\'s local household (' + syncState.code.slice(0, 4) + '…) — keeping local; Phase 3B reconciles this.');
    }
    return;
  }

  pullHouseholdFirst(serverCode).then(function(restored){
    if(!restored) return;
    if((memberSlot === 'elena' || memberSlot === 'partner') && typeof applyProf === 'function'){
      applyProf(memberSlot);
    }
    toast('✓ Signed in — your data is synced');
  });
}

/* ===================================================================
   Phase 3B (B3) — auto-upgrade householdSize from the server's member count

   PHASE3B-generic-spec.md B3: "auto-upgrades to 2 when the partner's account
   attaches; a manual override control in Profile → Basics ... for safety".
   `members` is /auth/me's `householdMembers` (worker/auth.js — a plain
   COUNT of users sharing this household_code), read defensively since an
   older/not-yet-redeployed worker simply omits the field (typeof guard, no
   crash, no-op).

   Rule (deliberately asymmetric):
     - members === 2: ALWAYS set householdSize = 2, even over a manual solo
       override — a real second account attached, so hiding them would be
       actively wrong, not just a stale default.
     - members === 1: set householdSize = 1 ONLY when householdSizeManual is
       false — a household that manually chose "Me + partner" (e.g. before
       the partner's account exists yet) must never be silently demoted to
       solo just because the server currently counts one user.
   Repaints via applyProf(currentProf) (render.js) — the same full-cascade
   used everywhere else in this file after a state change that affects the
   plan/UI — but only when something actually changed, so a routine /auth/me
   poll on an already-correct household size does nothing visible (no toast:
   this runs silently on every boot with a token, like the rest of refreshAuthMe).
   =================================================================== */
function maybeSetHouseholdSizeFromServer(members){
  if(typeof members !== 'number') return; // older worker — field not sent yet
  if(typeof householdSize === 'undefined') return; // state.js not loaded — guard like the rest of this file
  let changed = false;
  if(members === 2){
    if(householdSize !== 2){ householdSize = 2; changed = true; }
  } else if(members === 1){
    if(!householdSizeManual && householdSize !== 1){ householdSize = 1; changed = true; }
  }
  if(!changed) return;
  if(typeof applyProf === 'function') applyProf(currentProf);
  else if(typeof persist === 'function') persist();
}

/* ===================================================================
   Profile -> "Account" UI

   Signed out: one explanatory line + a white-pill "Sign in with Google"
   button carrying the official multicolor G mark (inline SVG — no
   external asset/CDN, matches the app's offline-first constraint).
   Signed in: avatar (or an initial-letter fallback when there's no
   picture) + display name + email + a ghost "Sign out" button. Every
   user-derived string goes through escapeHtml() (state.js) — this data
   ultimately comes from Google's id_token via the worker, so it must be
   treated as untrusted the same as any other stored-XSS-prone field
   (recipe names, avoid-list entries, etc. elsewhere in render.js/sync.js).
   =================================================================== */

// Official Google "G" mark, per Google's brand guidelines for "Sign in with Google" buttons
// (four flat paths, no gradients/filters) — inlined so the button renders with zero network
// dependency, consistent with the rest of this offline-first app.
const GOOGLE_G_LOGO_SVG = '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" style="flex:0 0 auto">'
  + '<path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/>'
  + '<path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>'
  + '<path fill="#FBBC05" d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z"/>'
  + '<path fill="#EA4335" d="M9 3.579c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.167 6.656 3.579 9 3.579z"/>'
  + '</svg>';

// Shared by renderAccountSection() (signed-out state) and the login gate (Phase 3A.2) —
// factored out so the two spots that need "Sign in with Google" never drift apart.
function googleSignInButtonHtml(onclick){
  return '<button class="cta" style="background:#fff;color:#3c4043;border:1.5px solid #dadce0;box-shadow:none;display:flex;align-items:center;justify-content:center;gap:10px" onclick="' + onclick + '">'
    + GOOGLE_G_LOGO_SVG + '<span>Sign in with Google</span></button>';
}

function renderAccountSection(){
  const el = document.getElementById('accountSection');
  if(!el) return; // Profile screen markup not present (shouldn't happen, but don't crash)

  const user = authUser();
  if(!user){
    el.innerHTML = '<p class="sub">Sign in to attach an account to your Mesa — this is separate from Couple sync below and doesn’t change how the app works.</p>'
      + googleSignInButtonHtml('authSignIn()');
    return;
  }

  // Untrusted (came from Google via the worker) — escape before it ever touches innerHTML.
  const name = escapeHtml(user.displayName || user.email || 'Signed in');
  const email = escapeHtml(user.email || '');
  // Only ever emit the picture URL if it's actually https:// — anything else (javascript:,
  // data:, a bare string someone jammed into the DB) is dropped in favor of the initial-letter
  // fallback rather than risked in a src attribute.
  const hasPicture = typeof user.picture === 'string' && user.picture.indexOf('https://') === 0;
  const initial = escapeHtml(((user.displayName || user.email || '?').trim().charAt(0) || '?').toUpperCase());
  const avatarHtml = hasPicture
    ? '<img src="' + escapeHtml(user.picture) + '" alt="" style="width:44px;height:44px;border-radius:50%;object-fit:cover;flex:0 0 auto">'
    : '<div style="width:44px;height:44px;border-radius:50%;background:var(--sage-tint);color:var(--sage-deep);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:17px;flex:0 0 auto">' + initial + '</div>';

  // Phase 3A.2: a quick "is this account attached to a shared household" hint — mirrors
  // the same syncState.code check js/sync.js's own renderCoupleSync() uses below it.
  const householdLine = (typeof syncState !== 'undefined' && syncState.code) ? 'Household: linked' : 'Household: not linked yet';

  // Task B4: householdSize is the B3 (state.js) "I cook for" state — the household-level
  // (not per-slot) signal of how many people are in this Mesa. 1 = room for a partner
  // invite; 2 = already a couple, so show the linked state instead of an invite form. The
  // typeof guard matches every other cross-file read in this file (state.js ships
  // alongside auth.js in every real build, but is never hard-depended on here).
  let partnerSectionHtml = '';
  if(typeof householdSize !== 'undefined'){
    if(householdSize === 1) partnerSectionHtml = invitePartnerBlockHtml();
    else if(householdSize === 2) partnerSectionHtml = '<p class="cap-note" style="margin-top:4px">Partner linked</p>';
  }

  el.innerHTML = '<div class="row" style="align-items:center">'
    + avatarHtml
    + '<div style="min-width:0"><div style="font-weight:700;overflow:hidden;text-overflow:ellipsis">' + name + '</div>'
    + '<div class="cap-note" style="min-height:0;overflow:hidden;text-overflow:ellipsis">' + email + '</div></div>'
    + '</div>'
    + '<p class="cap-note" style="margin-top:8px">' + householdLine + '</p>'
    + partnerSectionHtml
    + '<button class="cta ghostbtn" style="margin-top:14px" onclick="authSignOut()">Sign out</button>';
}

/* ===================================================================
   Task B4 — partner invite flow

   Shown in the Account section only when signed in AND householdSize===1
   (see renderAccountSection above — "room" for a partner per the spec).
   Talks to worker/auth.js's POST /auth/invite-partner (Bearer required,
   body {email}); see PHASE3B-generic-spec.md B4 for the exact request/
   response contract this was built against.

   Deliberately does NOT re-run renderAccountSection() while a request is
   in flight or after it resolves (success/known-error cases) — that
   would wipe the input's in-progress value and steal focus, the same
   reason js/sync.js's joinHousehold() flow manipulates its own form's
   DOM directly rather than repainting Couple sync mid-edit. The one
   exception is a 401: authSessionExpired() (this file) always repaints
   the whole Account section back to signed-out, which is correct here
   too (there is no "invite" affordance for someone no longer signed in).
   =================================================================== */
function invitePartnerBlockHtml(){
  return '<div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--line)">'
    + '<p class="sub" style="margin:0 0 8px">Invite your partner — when they sign in with Google using this email, they’ll join your household and meal plan automatically.</p>'
    // type=email + inputmode=email for the right mobile keyboard; font-size:16px inline
    // per the repo's iOS convention (index.html:438-441 / mesa.css .sv-val — anything
    // under 16px makes iOS Safari auto-zoom the page on focus). Styled to match
    // js/sync.js's joinCodeInput (.inp + inline border/width) plus the .field .inp
    // padding/background/radius so it doesn't look like a bare unstyled input sitting
    // outside a .field wrapper.
    + '<input class="inp" id="invitePartnerEmail" type="email" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false" placeholder="partner@email.com" '
    + 'style="width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:12px;padding:12px 14px;font-size:16px;background:rgba(255,250,240,.95);color:var(--ink)" '
    + 'onkeydown="if(event.key===\'Enter\'){this.blur();sendPartnerInvite();}">'
    + '<button class="cta" id="invitePartnerBtn" style="margin-top:8px" onclick="sendPartnerInvite()">Send invite</button>'
    + '<p class="cap-note" id="invitePartnerMsg" style="margin-top:8px;min-height:0"></p>'
    + '</div>';
}

// Inline feedback lives in its own paragraph (never a toast — the spec calls out that the
// user is already reading this section) and is set via textContent, not innerHTML, so no
// escapeHtml() call is needed here: every string passed in is one of this function's own
// fixed copy literals below, never user-derived (the typed email is never echoed back).
function setInvitePartnerMessage(text, isError){
  const msg = document.getElementById('invitePartnerMsg');
  if(!msg) return;
  msg.textContent = text || '';
  msg.style.color = isError ? 'var(--terra)' : '';
}

function setInvitePartnerBusy(busy){
  const btn = document.getElementById('invitePartnerBtn');
  const input = document.getElementById('invitePartnerEmail');
  if(btn){ btn.disabled = busy; btn.textContent = busy ? 'Sending…' : 'Send invite'; }
  if(input) input.disabled = busy;
}

function sendPartnerInvite(){
  const input = document.getElementById('invitePartnerEmail');
  if(!input) return; // block not in the DOM (signed out / two-person household) — nothing to do
  const email = input.value.trim();

  if(typeof fetch !== 'function'){
    setInvitePartnerMessage('Couldn’t reach Mesa — check your connection and try again.', true);
    return;
  }

  setInvitePartnerBusy(true);
  setInvitePartnerMessage('', false);

  fetch(SYNC_URL + '/auth/invite-partner', {
    method: 'POST',
    headers: Object.assign({'Content-Type': 'application/json'}, authHeader()),
    body: JSON.stringify({email: email})
  }).then(function(res){
    if(res.status === 401){
      // The one path allowed to conclude the session is dead (see authSessionExpired's own
      // doc) — repaints the Account section back to signed-out, which removes this whole
      // block, so there's nothing left here to re-enable/report into.
      authSessionExpired();
      return {handled: true};
    }
    return res.json().catch(function(){ return {}; }).then(function(body){
      return {handled: false, body: (body && typeof body === 'object') ? body : {}};
    });
  }).then(function(result){
    setInvitePartnerBusy(false);
    if(result.handled) return;
    const body = result.body;
    if(body.ok){
      if(body.already){
        setInvitePartnerMessage('They’re already part of your Mesa.', false);
      } else {
        setInvitePartnerMessage('Invited — when they sign in with Google they’ll join your meal plan automatically.', false);
        input.value = '';
      }
      return;
    }
    const code = body.error;
    if(code === 'invalid_email') setInvitePartnerMessage('That doesn’t look like an email address.', true);
    else if(code === 'self_invite') setInvitePartnerMessage('That’s your own account.', true);
    else if(code === 'taken') setInvitePartnerMessage('That email already belongs to another Mesa household.', true);
    else if(code === 'household_full') setInvitePartnerMessage('Your Mesa already has two people.', true);
    else if(code === 'rate_limited') setInvitePartnerMessage('Too many invites today — try again tomorrow.', true);
    // Anything else (no_household, an unrecognized/future error code, a malformed body) —
    // the spec's copy list doesn't cover these explicitly; fall back to the same "couldn't
    // reach it" family of copy used for actual network failures below rather than surface
    // a code the user can't act on.
    else setInvitePartnerMessage('Couldn’t reach Mesa — check your connection and try again.', true);
  }).catch(function(err){
    console.warn('Mesa auth: invite-partner request failed', err);
    setInvitePartnerBusy(false);
    setInvitePartnerMessage('Couldn’t reach Mesa — check your connection and try again.', true);
  });
}

/* ===================================================================
   Phase 3A.2 — login gate

   A full-viewport overlay (static markup: index.html #loginGate) that
   blocks the app until a token is present in localStorage. Deliberately
   dumb: the ONLY signal it reacts to is "is there a stored token", never
   "did /auth/me confirm it" — a stored token has to hide the gate the
   instant it's saved (spec: "hidden immediately after a token is
   stored"), and a network hiccup while re-checking that token must NOT
   re-show it (spec: "network errors do NOT gate" — this is an
   offline-first PWA; refreshAuthMe()'s own 401 branch is the only path
   that clears a token, and it always calls this right after).
   =================================================================== */
function updateLoginGate(){
  const gate = document.getElementById('loginGate');
  if(!gate) return; // markup not present (older cached index.html) — never let this throw

  // The button is generated (not duplicated as static markup — see googleSignInButtonHtml's
  // doc) into its own slot every call; cheap and keeps it byte-for-byte identical to the
  // Account section's signed-out button.
  const btnSlot = document.getElementById('loginGateButton');
  if(btnSlot) btnSlot.innerHTML = googleSignInButtonHtml('authSignIn()');

  const show = !authToken();
  gate.hidden = !show;
  try{ document.body.classList.toggle('gate-open', show); }catch(e){ /* non-browser env */ }
  if(!show){
    const err = document.getElementById('loginGateError');
    if(err) err.textContent = '';
  }
}

/* ---------------- boot ---------------- */
// Called once from app.js's boot sequence, alongside initSync() (same "typeof === function"
// guard style — a no-op if this file somehow isn't loaded). Paints from whatever's cached
// immediately (works offline, matches Couple sync's own paint-then-fetch shape), then
// reconciles with the server if there's a token to check.
function initAuth(){
  consumeAuthHash();
  renderAccountSection();
  updateLoginGate();
  // Open on this device's own profile using the CACHED slot, before /auth/me is asked
  // anything. Waiting for the network would mean an offline launch (or just a slow one)
  // shows the second member their partner's profile first and then swaps under them.
  applyOwnMemberSlot(myMemberSlot());
  if(authToken()) refreshAuthMe();
}
