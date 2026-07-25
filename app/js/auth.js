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
    maybeSeedDisplayNameFromGoogle(body.user);
    // Phase 3A.2: a signed-in account now carries its household mapping — silently attach
    // this device to it (or note a mismatch) so Elena/Andrea never land on an empty Mesa.
    maybeAdoptHousehold(body.householdCode, body.memberSlot);
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
function maybeSeedDisplayNameFromGoogle(user){
  if(!user || typeof user.displayName !== 'string' || !user.displayName.trim()) return;
  if(typeof PROF === 'undefined' || typeof currentProf === 'undefined' || typeof DISPLAY_NAME_DEFAULTS === 'undefined') return;
  const slot = currentProf;
  const p = PROF[slot];
  if(!p) return;
  const untouchedDefault = DISPLAY_NAME_DEFAULTS[slot];
  if(!untouchedDefault || p.displayName !== untouchedDefault) return; // already renamed locally or via sync — never overwrite

  const cap = (typeof DISPLAY_NAME_MAX_LEN === 'number') ? DISPLAY_NAME_MAX_LEN : 24;
  const firstWord = user.displayName.trim().split(/\s+/)[0].slice(0, cap);
  if(!firstWord) return;

  p.displayName = firstWord;
  if(typeof applyProf === 'function') applyProf(currentProf); // recomputes seg/av, repaints, persists (state.js:persist() drives the couple-sync rev bump)
  else if(typeof persist === 'function') persist();
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

  el.innerHTML = '<div class="row" style="align-items:center">'
    + avatarHtml
    + '<div style="min-width:0"><div style="font-weight:700;overflow:hidden;text-overflow:ellipsis">' + name + '</div>'
    + '<div class="cap-note" style="min-height:0;overflow:hidden;text-overflow:ellipsis">' + email + '</div></div>'
    + '</div>'
    + '<p class="cap-note" style="margin-top:8px">' + householdLine + '</p>'
    + '<button class="cta ghostbtn" style="margin-top:14px" onclick="authSignOut()">Sign out</button>';
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
  if(authToken()) refreshAuthMe();
}
