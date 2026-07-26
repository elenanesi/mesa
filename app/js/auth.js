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

/* ===================================================================
   Sign-in diagnostics

   Sign-in failures here are invisible by construction: the interesting
   half happens in another browser context (or another BROWSER), the URL
   fragment carrying the evidence is stripped on arrival by design, and
   a loop looks identical whether the token never arrived, arrived and
   was rejected, or arrived into a build too old to understand it. So
   every step appends to a small ring buffer in localStorage that the
   gate can show on demand ("Trouble signing in?").

   AUTH_BUILD is stamped by tools/build-sw.js from the same content hash
   as the service-worker cache name, so the log states plainly WHICH
   build produced it — the first question worth answering when a fix
   appears not to work, since an installed PWA or a Safari cache can
   easily still be running last week's JavaScript.
   =================================================================== */
const AUTH_BUILD = 'mesa-9514d72ebade'; // AUTO-STAMPED by tools/build-sw.js — do not edit by hand
const AUTH_LOG_KEY = 'mesaAuthLog';
const AUTH_LOG_MAX = 40;

function authLog(event, detail){
  const line = {
    t: new Date().toISOString().slice(11, 19),
    b: AUTH_BUILD.slice(5, 11),
    e: String(event),
    d: (detail === undefined || detail === null) ? '' : String(detail).slice(0, 160)
  };
  try{ console.log('[mesa-auth]', line.t, line.e, line.d); }catch(e){}
  try{
    const raw = localStorage.getItem(AUTH_LOG_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    arr.push(line);
    while(arr.length > AUTH_LOG_MAX) arr.shift();
    localStorage.setItem(AUTH_LOG_KEY, JSON.stringify(arr));
  }catch(e){ /* storage unavailable — the console line above is still emitted */ }
}

function authLogText(){
  try{
    const raw = localStorage.getItem(AUTH_LOG_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if(!arr.length) return 'No sign-in activity recorded yet.';
    return arr.map(function(l){ return l.t + ' [' + l.b + '] ' + l.e + (l.d ? ' ' + l.d : ''); }).join('\n');
  }catch(e){ return 'Log unavailable.'; }
}

function clearAuthLog(){
  try{ localStorage.removeItem(AUTH_LOG_KEY); }catch(e){}
  renderAuthDiagnostics();
}

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

/* The household roster from /auth/me's `members` (Phase 3C, C1).

   Cached device-locally like the other auth facts, NOT in the synced profile sections:
   it is server-derived truth about who is in this household, so syncing it would just
   create a second, staler copy. It exists because each device used to know only its OWN
   Google name — the partner's name had to arrive by couple-sync, and until it did, the
   second member's phone labelled them "Partner". Now both names (and both Google photos)
   come straight from the server on every /auth/me.

   memberInfo(slot) is read by state.js:resolveDisplayName() through a typeof guard, so
   everything degrades to the old viewer-relative fallback when this file is absent or the
   worker is too old to send `members`. */
const AUTH_MEMBERS_KEY = 'mesaAuthMembers';

function memberDirectory(){
  try{
    const raw = localStorage.getItem(AUTH_MEMBERS_KEY);
    if(!raw) return [];
    const arr = JSON.parse(raw);
    if(!Array.isArray(arr)) return [];
    return arr.filter(function(m){
      return m && typeof m === 'object' && (m.slot === 'elena' || m.slot === 'partner');
    });
  }catch(e){ return []; } // corrupt/unavailable — behave as "no roster known"
}

function memberInfo(slot){
  const dir = memberDirectory();
  for(let i = 0; i < dir.length; i++){
    if(dir[i].slot === slot) return dir[i];
  }
  return null;
}

function setMemberDirectory(members){
  try{
    if(Array.isArray(members)) localStorage.setItem(AUTH_MEMBERS_KEY, JSON.stringify(members));
    else localStorage.removeItem(AUTH_MEMBERS_KEY);
  }catch(e){ /* storage unavailable — names fall back to the viewer-relative default */ }
}

/* ===================================================================
   Claim tickets — the only way an installed iOS PWA can sign in

   In standalone mode iOS refuses to navigate the PWA itself to another
   origin, so "Sign in with Google" hands the entire round trip to
   Safari. Safari completes it perfectly and stores the token in
   SAFARI's localStorage; the PWA has its own, sees nothing, shows the
   gate again, and the user taps sign-in forever. (Desktop is fine —
   there the redirect comes back to the same context that started it.)

   So before leaving, the client mints a random ticket id, hands it to
   the worker, and the callback parks a copy of the token under it. When
   the user switches back to the PWA we redeem the ticket over a normal
   fetch — no navigation involved, so the storage jar problem disappears.
   The ticket is single-use, expires in 5 minutes server-side, and is
   dropped locally as soon as it is redeemed or a session arrives by any
   other route.
   =================================================================== */
const AUTH_PENDING_KEY = 'mesaAuthPending';
const CLAIM_POLL_MS = 2500;
const CLAIM_GIVE_UP_MS = 5 * 60 * 1000; // matches the worker's ticket TTL — after this the ticket is gone anyway

function newClaimId(){
  try{
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let out = '';
    for(let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  }catch(e){ return null; } // no crypto (ancient browser) — fall back to redirect-only delivery
}

function pendingClaim(){
  try{
    const raw = localStorage.getItem(AUTH_PENDING_KEY);
    if(!raw) return null;
    const p = JSON.parse(raw);
    if(!p || typeof p.id !== 'string' || typeof p.at !== 'number') return null;
    if(Date.now() - p.at > CLAIM_GIVE_UP_MS){ setPendingClaim(null); return null; }
    return p;
  }catch(e){ return null; }
}

function setPendingClaim(id){
  try{
    if(id) localStorage.setItem(AUTH_PENDING_KEY, JSON.stringify({id: id, at: Date.now()}));
    else localStorage.removeItem(AUTH_PENDING_KEY);
  }catch(e){ /* storage unavailable — sign-in still works anywhere the redirect lands */ }
}

let claimPollTimer = null;

function stopClaimPolling(){
  if(claimPollTimer){ clearInterval(claimPollTimer); claimPollTimer = null; }
}

/* Redeem the ticket once. Resolves true when a session was obtained. 404 is the normal
   "not finished yet" answer and must stay silent — this runs on a timer. */
function claimPendingSignIn(){
  const pending = pendingClaim();
  if(!pending || authToken()) return Promise.resolve(false);
  if(typeof fetch !== 'function') return Promise.resolve(false);

  return fetch(SYNC_URL + '/auth/claim?link_id=' + encodeURIComponent(pending.id), {
    method: 'GET',
    headers: {'Accept': 'application/json'},
    cache: 'no-store'
  }).then(function(res){
    if(res.status === 404){ authLog('claim.wait', 'ticket=' + pending.id.slice(0, 8)); return false; } // still waiting on the user to finish in the browser
    if(!res.ok){ authLog('claim.http', res.status); return false; }
    return res.json().then(function(body){
      if(!body || typeof body.token !== 'string' || !body.token) return false;
      authLog('claim.ok', 'len=' + body.token.length);
      setAuthToken(body.token);
      setPendingClaim(null);
      stopClaimPolling();
      updateLoginGate();
      renderAccountSection();
      refreshAuthMe();
      toast('✓ Signed in');
      return true;
    });
  }).catch(function(err){ authLog('claim.err', err && err.message); return false; }); // offline/unreachable — the timer tries again
}

/* Poll while a ticket is outstanding. Also fires on visibilitychange, which is the moment
   that actually matters: the user finishes in Safari and switches back to Mesa. */
function startClaimPolling(){
  if(claimPollTimer || !pendingClaim() || authToken()) return;
  claimPollTimer = setInterval(function(){
    if(!pendingClaim() || authToken()){ stopClaimPolling(); updateLoginGate(); return; }
    claimPendingSignIn();
  }, CLAIM_POLL_MS);
}

function initClaimWatch(){
  if(typeof document === 'undefined' || !document.addEventListener) return;
  document.addEventListener('visibilitychange', function(){
    if(document.visibilityState !== 'visible') return;
    if(authToken() || !pendingClaim()) return;
    claimPendingSignIn().then(function(got){ if(!got) startClaimPolling(); });
  });
  // Same trigger for browsers that restore the page without a visibility change.
  window.addEventListener('pageshow', function(){
    if(!authToken() && pendingClaim()) claimPendingSignIn().then(function(got){ if(!got) startClaimPolling(); });
  });
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
    authLog('hash.token', token ? 'len=' + token.length : 'EMPTY');
    if(token){
      setAuthToken(token);
      // The redirect got here, so this context never needs its claim ticket — drop it
      // rather than leaving a live one-time secret sitting in storage.
      setPendingClaim(null);
    }
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
  if(reason === ‘not_invited’) return ‘Your access to Mesa has been revoked or you haven’t been invited yet. Contact the person running this Mesa to restore access.’;
  if(reason === ‘full’) return "Mesa is at capacity and can’t take new accounts.";
  return ‘Sign-in didn’t work — please try again.’;
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
    authLog('me.status', res.status);
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
    // Roster first: everything below that renders a name reads it.
    setMemberDirectory(Array.isArray(body.members) ? body.members : null);
    authLog('me.ok', 'slot=' + (body.memberSlot || '?') + ' members=' + (Array.isArray(body.members) ? body.members.length : 'absent'));
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
    // Phase 3A.2: a signed-in account now carries its household mapping — silently attach
    // this device to it (or note a mismatch) so nobody lands on an empty Mesa.
    maybeAdoptHousehold(body.householdCode, body.memberSlot);
    // Everything that touches PROF/currentProf is deferred: /auth/me can resolve BEFORE
    // the app has loaded its state (that's the whole point of running it early now), and
    // writing profile fields at that moment would be writing into defaults that loadState()
    // is about to replace. applyIdentityToAppState() is idempotent and is called again from
    // initAuth() once state exists, so whichever finishes second does the real work.
    applyIdentityToAppState();
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
  // origin + pathname, NOT origin alone: the deployed app lives at /app/, and the origin
  // root is a meta-refresh shim that bounces there while silently dropping the URL
  // fragment — which is where the worker returns the session token. Sending the real path
  // makes the callback land directly on the app. pathname only (no query/hash) so nothing
  // from the current URL is reflected back through the redirect.
  const returnTo = encodeURIComponent(location.origin + location.pathname);
  // Mint a claim ticket for the same sign-in (see claimPendingSignIn). On an installed
  // iOS PWA the whole OAuth trip happens in Safari and its result never reaches this
  // storage jar, so the redirect alone can never sign the PWA in.
  const linkId = newClaimId();
  if(linkId) setPendingClaim(linkId);
  authLog('signin.start', 'ticket=' + (linkId ? linkId.slice(0, 8) : 'none') + ' return=' + location.pathname);
  location.href = SYNC_URL + '/auth/google/start?return_to=' + returnTo
    + (linkId ? '&link_id=' + encodeURIComponent(linkId) : '');
}

// Clears local session state immediately (so the UI feels instant and works even offline),
// then best-effort tells the server to drop the session row too. Order matters: local clear
// first means a flaky network never leaves the user stuck "signed in" on their own device.
function authSignOut(){
  const token = authToken();
  setAuthToken(null);
  setAuthUser(null);
  setMemberDirectory(null);
  setMyMemberSlot(null);
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
/* applyIdentityToAppState() — the half of identity that needs PROF/currentProf loaded.

   Called from BOTH refreshAuthMe() (which may resolve before the app has booted, since it
   now runs early on purpose) and initAuth() (which runs once state exists). Idempotent, so
   whichever lands second does the real work and the other is a cheap no-op. Never touches
   anything if PROF isn't populated yet.

   Seeds each slot's displayName from the SERVER ROSTER rather than only from the local
   Google account, so a device learns its partner's name too — that is what stops the
   second member's phone showing "Partner" for a person who has a perfectly good name on
   file. A name the user typed themselves always wins and is never overwritten. */
function applyIdentityToAppState(){
  if(typeof PROF === 'undefined' || !PROF || typeof isPlaceholderDisplayName !== 'function') return;

  const dir = memberDirectory();
  let changed = false;
  for(let i = 0; i < dir.length; i++){
    const m = dir[i];
    const p = PROF[m.slot];
    if(!p) continue;
    if(!isPlaceholderDisplayName(p.displayName)) continue; // typed/synced real name wins
    const first = (typeof m.firstName === 'string' && m.firstName.trim()) ? m.firstName.trim() : '';
    if(!first || isPlaceholderDisplayName(first)) continue;
    const cap = (typeof DISPLAY_NAME_MAX_LEN === 'number') ? DISPLAY_NAME_MAX_LEN : 24;
    p.displayName = first.slice(0, cap);
    changed = true;
  }

  // Deliberately silent: commitDisplayName()'s toast belongs to an interactive rename, not
  // to boot. persist() is what makes the name durable AND queues the couple-sync rev bump,
  // exactly as any Basics edit would.
  if(changed){
    authLog('names.seeded', dir.map(function(m){ return m.slot + '=' + (m.firstName || '?'); }).join(' '));
    if(typeof persist === 'function') persist();
  }

  // Open on the viewer's OWN profile (see applyOwnMemberSlot's doc) and repaint whatever
  // shows a name, whether or not a name changed — the roster may have arrived after the
  // first paint.
  applyOwnMemberSlot(myMemberSlot());
  if(changed || dir.length){
    if(typeof applyProf === 'function' && typeof currentProf !== 'undefined') applyProf(currentProf);
    else if(typeof syncPersonLabels === 'function') syncPersonLabels();
  }
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
    authLog('me.status', res.status);
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

  // index.html ships this button as static markup so the gate is usable before/without
  // JS; repainting it here keeps it identical if that markup ever drifts.
  const waiting = !authToken() && !!pendingClaim();
  const btnSlot = document.getElementById('loginGateButton');
  if(btnSlot){
    btnSlot.innerHTML = waiting
      // Mid-flight on a device where the OAuth trip happens outside this app (installed
      // iOS PWA): say so, and offer a manual retry for anyone who beats the poller back.
      ? '<button class="cta ghostbtn" onclick="claimPendingSignIn()">I\u2019ve signed in \u2014 continue</button>'
      : googleSignInButtonHtml('authSignIn()');
  }
  const waitNote = document.getElementById('loginGateError');
  if(waitNote && waiting) waitNote.textContent = 'Finish signing in with Google in your browser, then come back here.';

  renderAuthDiagnostics();

  const show = !authToken();
  gate.hidden = !show;
  try{ document.body.classList.toggle('gate-open', show); }catch(e){ /* non-browser env */ }
  if(!show){
    const err = document.getElementById('loginGateError');
    if(err) err.textContent = '';
  }
}

/* The gate's "Trouble signing in?" disclosure. Collapsed by default — this is a
   debugging aid, not part of the product — but reachable without a desktop, a cable or a
   console, which matters because the failures worth diagnosing here happen on phones. */
function toggleAuthDiagnostics(){
  const box = document.getElementById('loginGateDiag');
  if(!box) return;
  box.hidden = !box.hidden;
  renderAuthDiagnostics();
}

function renderAuthDiagnostics(){
  const box = document.getElementById('loginGateDiag');
  if(!box || box.hidden) return;
  const pre = document.getElementById('loginGateDiagLog');
  if(pre) pre.textContent = 'build ' + AUTH_BUILD + '\n' + authLogText();
}

/* ---------------- boot ---------------- */
// Called once from app.js's boot sequence, alongside initSync() (same "typeof === function"
// guard style — a no-op if this file somehow isn't loaded). Paints from whatever's cached
// immediately (works offline, matches Couple sync's own paint-then-fetch shape), then
// reconciles with the server if there's a token to check.
/* initAuthEarly() — everything needed to GET A USER IN, run as soon as this script
   parses and deliberately NOT waiting for the app to boot.

   This split exists because of a real, user-visible failure: initAuth() used to be the
   last statement of bootMesaApp()'s promise chain, which begins with a network fetch for
   the recipe catalog. Any stall or throw anywhere in that chain meant consumeAuthHash()
   never ran — so a token arriving in the URL fragment was silently discarded, the gate
   stayed up, and sign-in looped forever with no error anywhere. The diagnostics log made
   it obvious: `signin.start` with no `boot` line after it, on a build that logs one on
   every load.

   Reading a returned token, redeeming a claim ticket and lowering the gate must depend on
   NOTHING except this file. Anything that needs loaded app state (the profile display,
   which slot to open on, re-validating the session) stays in initAuth() below, called
   from the boot chain where PROF and friends actually exist. */
function initAuthEarly(){
  authLog('boot', 'hash=' + (location.hash ? location.hash.slice(0, 12) + '…' : 'none')
    + ' token=' + (authToken() ? 'yes' : 'no')
    + ' ticket=' + (pendingClaim() ? 'yes' : 'no')
    + ' standalone=' + (window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ? 'yes' : 'no'));
  consumeAuthHash();
  // A ticket left over from a sign-in started before this launch (the iOS PWA case: the
  // user finished in Safari and reopened Mesa) — redeem it before painting the gate.
  if(!authToken() && pendingClaim()){
    claimPendingSignIn().then(function(got){ if(!got) startClaimPolling(); });
  }
  initClaimWatch();
  updateLoginGate();
  // Re-validate the session (and fetch the roster) HERE rather than from the boot chain:
  // this is what caches memberSlot + members, and a device whose app boot fails must still
  // resolve its identity — otherwise the second household member is labelled "Partner"
  // forever. Everything it triggers that needs loaded state is deferred through
  // applyIdentityToAppState(), which initAuth() calls again once state exists.
  if(authToken()) refreshAuthMe();
}

/* initAuth() — the parts that need loaded app state. Called from bootMesaApp(); if boot
   fails, the user is still signed in and past the gate, they just don't get the Account
   card or the open-on-your-own-profile behaviour until the underlying boot bug is fixed. */
function initAuth(){
  renderAccountSection();
  updateLoginGate();
  // Apply whatever identity is already cached (slot + roster names) the moment app state
  // exists — no network wait, so an offline launch still opens on the right profile with
  // the right names. initAuthEarly()'s /auth/me may land before or after this; both call
  // the same idempotent applier.
  applyIdentityToAppState();
}

// Run the gate-critical half immediately. This file is loaded at the end of <body>, after
// the gate markup, so the DOM it touches already exists.
try{ initAuthEarly(); }catch(e){ try{ authLog('early.err', e && e.message); }catch(_){} }
