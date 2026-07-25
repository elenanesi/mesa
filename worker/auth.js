/* ===================================================================
   worker/auth.js — Mesa user accounts (Phase 3A, Google sign-in)

   New module, routed from sync.js for any pathname starting with
   "/auth/". Plain JS, module syntax, zero dependencies — same style as
   sync.js. Shares its CORS/JSON helpers (corsHeaders/json/isPlainObject)
   and ALLOWED_ORIGINS list by import, rather than duplicating them, so
   there is exactly one place that decides which origins are trusted.

   Scope of THIS batch (see PHASE3A-auth-spec.md): real accounts via
   Google OAuth, an invite-only allow-list, and a hard user cap. Nothing
   here gates sync or library access yet — /sync/:code and /library/:code
   keep working exactly as before, unauthenticated, on the household
   code. Sessions become the sync auth in Phase 3B.

   Phase 3A.2 addendum: every user is automatically attached to a
   household on first login — copied from their allowed_emails row
   (invited partners land in the household they were invited into) or,
   if unset, a freshly generated code (solo signups get an empty one).
   Existing users missing a household_code get backfilled the same way
   on their next login. /auth/me exposes householdCode/memberSlot so the
   client can auto-join without prompting.

   Endpoints:
     GET  /auth/google/start?return_to=<origin>
       -> 503 if GOOGLE_CLIENT_ID isn't configured (no GCP client yet).
       -> 400 if return_to isn't one of ALLOWED_ORIGINS (open-redirect
          guard: we will eventually 302 a browser to that origin with a
          token in the fragment, so it must be an origin we already
          trust, not whatever a caller passes).
       -> otherwise stores a one-time state nonce in KV (nonce -> the
          verified return origin) and 302s to Google's consent screen.
     GET  /auth/google/callback?code&state
       -> always exits via redirect to the ORIGIN THAT INITIATED THE
          FLOW (recovered from the state nonce), with #auth=<token> on
          success or #auth_error=<reason> on any failure. Never returns
          JSON — the caller is a top-level browser navigation coming
          back from Google, not a fetch(), so there's nothing to parse
          a JSON body. If the state nonce itself can't be resolved (so
          we don't know which origin to trust) we fall back to the
          first ALLOWED_ORIGINS entry rather than failing with no
          response at all.
     GET  /auth/me            (Authorization: Bearer <token>)
     POST /auth/logout        (Authorization: Bearer <token>)
       -> these two DO return JSON (they're called via fetch() from the
          already-loaded app, not via top-level navigation).
     POST /auth/invite-partner (Authorization: Bearer <token>, body {email})
       -> Phase 3B/B4: lets a signed-in user invite their partner by email,
          replacing the earlier manual-D1-row-per-person admin flow. Writes
          an allowed_emails row so the invitee's NEXT Google sign-in attaches
          them straight into the inviter's household, on the other member
          slot from the inviter's own. Failure modes, in the order checked:
            401 {error:'unauthorized'}   no/dead session.
            429 {error:'rate_limited'}   more than 5 calls/day for this user
                                          id (checked early/cheaply, right
                                          after auth, before touching D1).
            400 {error:'invalid_email'}  not a string, empty after trim, over
                                          254 chars, or fails a conservative
                                          shape check (NOT full RFC 5322).
            409 {error:'no_household'}   caller has no household_code (or an
                                          unrecognized member_slot) — normally
                                          impossible post-3A.2 attach, guarded
                                          defensively anyway.
            400 {error:'self_invite'}    email is the caller's own.
            200 {ok:true, already:true}  email already belongs to a USER who
                                          is already in the caller's
                                          household — idempotent no-op.
            409 {error:'taken'}          email belongs to a user in a
                                          DIFFERENT household, OR to an
                                          existing allowed_emails row already
                                          pointed at a different household
                                          (never steals someone else's
                                          pending invite).
            409 {error:'household_full'} caller's household already has 2
                                          members (counted the same way
                                          handleMe's householdMembers is).
            200 {ok:true, email,
                 memberSlot}             success — an allowed_emails row is
                                          INSERT OR REPLACEd for the target
                                          email: {note:'partner-invite',
                                          household_code: caller's,
                                          member_slot: the OTHER slot from
                                          the caller's own ('elena'<->
                                          'partner')}. A row already pointing
                                          at the SAME household (or with no
                                          household yet) is fine to update in
                                          place — same idempotent contract as
                                          re-running the whole call.

   Session tokens: 32 random bytes, hex-encoded, handed to the browser
   once (in the callback redirect fragment — fragments never reach the
   server in subsequent requests/logs). We store only the SHA-256 hash
   of the token in D1 (sessions.token_hash), so a leaked database row
   can't be replayed as a bearer token, mirroring how the token itself
   never touches server logs (query strings) or POST bodies at issuance
   time either.
   =================================================================== */

import { ALLOWED_ORIGINS, corsHeaders, json, isPlainObject, generateHouseholdCode } from './sync.js';

const STATE_KV_PREFIX = 'authstate:';
/* Claim tickets (iOS-installed-PWA sign-in).

   An installed PWA on iOS cannot navigate cross-origin in place: tapping "Sign in with
   Google" hands the whole OAuth round trip to Safari, and Safari's storage jar is NOT the
   PWA's. The callback's #auth=<token> redirect therefore lands in the browser, correctly,
   while the PWA that started the flow never sees a token — an unbreakable login loop on
   phones even though everything works on desktop.

   So the token is ALSO parked here under a client-generated one-time id, and the PWA
   claims it directly (GET /auth/claim) when the user comes back to it. The id is 32
   random bytes minted client-side, lives for 5 minutes, and is deleted on first read, so
   it is the same class of bearer secret as the fragment it replaces — just fetched
   instead of redirected. */
const CLAIM_KV_PREFIX = 'authclaim:';
const CLAIM_TTL_SECONDS = 300;
const CLAIM_ID_RE = /^[a-f0-9]{32,128}$/;
const CLAIM_RATE_LIMIT = 120; // generous: the client polls while waiting for the user to switch apps
const CLAIM_RATE_WINDOW_SECONDS = 600;
const STATE_TTL_SECONDS = 600; // 10 minutes — plenty for a consent-screen round trip

const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const SESSION_RENEW_THRESHOLD_MS = 45 * 24 * 60 * 60 * 1000; // sliding renewal once <45d left
const LAST_SEEN_STALE_MS = 60 * 60 * 1000; // only write last_seen_at once per hour of activity

const CALLBACK_RATE_LIMIT = 30; // per IP per window — the callback does a real Google token
const CALLBACK_RATE_WINDOW_SECONDS = 3600; // exchange + D1 writes, worth throttling more than reads

const INVITE_RATE_LIMIT = 5; // per user per day — plenty for real use, cheap to throttle abuse
const INVITE_RATE_WINDOW_SECONDS = 86400; // 24h
const INVITE_EMAIL_MAX_LEN = 254; // RFC 5321 practical mailbox length cap
const INVITE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // conservative shape check — NOT full RFC 5322
const OTHER_MEMBER_SLOT = {elena: 'partner', partner: 'elena'}; // the app's two opaque slot ids (see PHASE3B spec's "ground rule")

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

// --- small local helpers (deliberately NOT imported from sync.js — these are
// generic crypto/encoding utilities, not shared business logic, so duplicating
// the ~10 lines here keeps sync.js's diff to "export a few existing names"
// rather than reshaping it around auth's needs). ---------------------------

function randomHex(byteLen){
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  let out = '';
  for(let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

async function sha256Hex(text){
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const bytes = new Uint8Array(digest);
  let out = '';
  for(let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function base64UrlToBytes(b64url){
  const b64 = String(b64url).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64UrlDecodeJSON(b64url){
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(b64url)));
}

function d1Available(env){ return !!(env && env.MESA_DB); }

// Phase 3C, C1: first whitespace-delimited word of a display_name, capped at
// 24 chars (matches the client's DISPLAY_NAME_MAX_LEN) so both devices agree
// on the same short label without either computing it independently. Null
// in, null out — a user with no name on file (or an all-whitespace one)
// gets no firstName rather than an empty string.
function firstNameOf(displayName){
  if(typeof displayName !== 'string') return null;
  const trimmed = displayName.trim();
  if(!trimmed) return null;
  const first = trimmed.split(/\s+/)[0];
  if(!first) return null;
  return first.length > 24 ? first.slice(0, 24) : first;
}

// Same shape as sync.js's bootstrapRateLimited (cheap KV TTL counter, fails
// OPEN on any KV error) but parameterized by key/limit/window so both the
// bootstrap endpoint and this one can use their own budgets independently.
async function rateLimited(env, key, limit, windowSeconds){
  if(!env || !env.MESA_KV) return false;
  let count = 0;
  try{
    const raw = await env.MESA_KV.get(key);
    count = raw ? (parseInt(raw, 10) || 0) : 0;
  }catch(e){
    return false;
  }
  if(count >= limit) return true;
  try{
    await env.MESA_KV.put(key, String(count + 1), {expirationTtl: windowSeconds});
  }catch(e){
    // best-effort — a failed write just means this tick isn't counted, not fatal
  }
  return false;
}

/* return_to is a full app URL (origin + path), not just an origin.

   It used to be just the origin, and the callback redirected to `<origin>/#auth=<token>`.
   On the real deploy the app does NOT live at the origin root — the root is a
   meta-refresh shim that bounces to /app/ — and a meta refresh DROPS the URL fragment.
   The token was therefore destroyed exactly one hop before the app could read it, so
   sign-in succeeded server-side (a user row and a session were created every time) and
   still landed the user back on the login gate: an infinite loop.

   Both helpers below take the whole return URL. Anti-open-redirect is unchanged in
   spirit: the ORIGIN is still matched against ALLOWED_ORIGINS, and only the path is
   carried along (query and fragment are dropped rather than reflected). */
function safeReturnUrl(raw){
  let u;
  try{ u = new URL(String(raw)); }catch(e){ return null; }
  if(ALLOWED_ORIGINS.indexOf(u.origin) === -1) return null;
  return u.origin + u.pathname; // deliberately without search/hash — we append our own fragment
}

function fragmentRedirect(returnUrl, fragment){
  return new Response(null, {
    status: 302,
    headers: {'Location': returnUrl + '#' + fragment}
  });
}

function errorRedirect(returnUrl, reason){
  console.log('auth.callback fail reason=' + reason + ' return=' + returnUrl);
  return fragmentRedirect(returnUrl, 'auth_error=' + encodeURIComponent(reason));
}

// -----------------------------------------------------------------------

async function handleStart(request, env, origin, url){
  if(!env || !env.GOOGLE_CLIENT_ID){
    // No GCP OAuth client configured yet (placeholder empty string in
    // wrangler.toml until Elena's manual GCP step is done) — fail loudly
    // and structured rather than 302ing into a broken Google request.
    return json({error: 'auth_not_configured'}, 503, origin);
  }

  // Accepts a full app URL now (see safeReturnUrl). A bare origin still works — its
  // pathname is '/' — so an older cached client keeps functioning.
  const returnUrl = safeReturnUrl(url.searchParams.get('return_to') || '');
  if(!returnUrl){
    return json({error: 'invalid_return_to'}, 400, origin);
  }

  // Optional: the caller's claim ticket id (see CLAIM_KV_PREFIX). Carried through the
  // state blob so the callback can park a copy of the token for a PWA that will never
  // receive the redirect itself.
  const rawLink = (url.searchParams.get('link_id') || '').toLowerCase();
  const linkId = CLAIM_ID_RE.test(rawLink) ? rawLink : null;

  const state = randomHex(32);
  try{
    await env.MESA_KV.put(STATE_KV_PREFIX + state, JSON.stringify({returnUrl: returnUrl, linkId: linkId}), {expirationTtl: STATE_TTL_SECONDS});
  }catch(e){
    return json({error: 'storage_failed'}, 500, origin);
  }

  // redirect_uri is derived from THIS request's own origin (not return_to) so
  // local dev (127.0.0.1:8787) and the real deploy each get a redirect_uri
  // matching their own Worker origin, as registered in the GCP console.
  const redirectUri = url.origin + '/auth/google/callback';
  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('prompt', 'select_account');

  return new Response(null, {
    status: 302,
    headers: Object.assign({'Location': authUrl.toString()}, corsHeaders(origin))
  });
}

async function handleCallback(request, env, origin, url){
  // Fallback used only when we can't recover the real return URL from the
  // state nonce (missing/expired/tampered state) — we still have to send the
  // browser SOMEWHERE, and an ALLOWED_ORIGINS member is the only safe choice.
  // Note this lands on the origin ROOT, which on the real deploy meta-refreshes
  // to /app/ and drops the fragment — acceptable ONLY because every path that
  // uses it is already an error path with no token to lose.
  const fallbackOrigin = ALLOWED_ORIGINS[0] + '/';

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if(!state || !env || !env.MESA_KV){
    return errorRedirect(fallbackOrigin, 'state');
  }

  let stateRaw = null;
  try{
    stateRaw = await env.MESA_KV.get(STATE_KV_PREFIX + state);
    if(stateRaw) await env.MESA_KV.delete(STATE_KV_PREFIX + state); // one-time use
  }catch(e){
    stateRaw = null;
  }
  if(!stateRaw){
    return errorRedirect(fallbackOrigin, 'state');
  }

  let stateData = null;
  try{ stateData = JSON.parse(stateRaw); }catch(e){ stateData = null; }
  // Re-validate the stored URL rather than trusting KV blindly, and accept the older
  // {origin} shape so a flow started before this fix still completes.
  const returnOrigin = (stateData && safeReturnUrl(stateData.returnUrl || stateData.origin || '')) || fallbackOrigin;

  // Rate-limit per IP AFTER state is confirmed real — an attacker spraying
  // bogus states already dead-ends above without touching this budget, so it
  // stays reserved for actual (possibly abusive) token-exchange attempts.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if(await rateLimited(env, 'auth-callback-rate:' + ip, CALLBACK_RATE_LIMIT, CALLBACK_RATE_WINDOW_SECONDS)){
    return errorRedirect(returnOrigin, 'rate_limited');
  }

  if(!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET){
    return errorRedirect(returnOrigin, 'auth_not_configured');
  }
  if(!code){
    return errorRedirect(returnOrigin, 'code');
  }
  if(!d1Available(env)){
    return errorRedirect(returnOrigin, 'server');
  }

  // Same redirect_uri derivation as /auth/google/start — Google requires the
  // token-exchange redirect_uri to exactly match the one used to obtain the code.
  const redirectUri = url.origin + '/auth/google/callback';

  let tokenRes;
  try{
    tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri
      }).toString()
    });
  }catch(e){
    return errorRedirect(returnOrigin, 'token_exchange');
  }
  if(!tokenRes.ok){
    return errorRedirect(returnOrigin, 'token_exchange');
  }

  let tokenBody;
  try{ tokenBody = await tokenRes.json(); }catch(e){ return errorRedirect(returnOrigin, 'token_exchange'); }
  const idToken = tokenBody && typeof tokenBody.id_token === 'string' ? tokenBody.id_token : null;
  if(!idToken){
    return errorRedirect(returnOrigin, 'token_exchange');
  }

  // Decode (not verify-by-signature) the id_token payload: it came directly
  // from Google over TLS in the response body above, not from the client, so
  // there's no third party who could have forged it in transit. We still
  // VERIFY every claim that matters (aud/iss/exp/email_verified) rather than
  // trusting the payload blindly.
  const parts = idToken.split('.');
  if(parts.length !== 3){
    return errorRedirect(returnOrigin, 'id_token');
  }
  let payload;
  try{ payload = base64UrlDecodeJSON(parts[1]); }catch(e){ return errorRedirect(returnOrigin, 'id_token'); }
  if(!isPlainObject(payload)){
    return errorRedirect(returnOrigin, 'id_token');
  }
  if(payload.aud !== env.GOOGLE_CLIENT_ID){
    return errorRedirect(returnOrigin, 'id_token');
  }
  if(GOOGLE_ISSUERS.indexOf(payload.iss) === -1){
    return errorRedirect(returnOrigin, 'id_token');
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if(typeof payload.exp !== 'number' || nowSec >= payload.exp){
    return errorRedirect(returnOrigin, 'id_token');
  }
  if(payload.email_verified !== true){
    return errorRedirect(returnOrigin, 'id_token');
  }
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if(!email){
    return errorRedirect(returnOrigin, 'id_token');
  }

  let allowedRow;
  try{
    allowedRow = await env.MESA_DB.prepare('SELECT email, household_code, member_slot FROM allowed_emails WHERE email = ?').bind(email).first();
  }catch(e){
    return errorRedirect(returnOrigin, 'server');
  }
  if(!allowedRow){
    return errorRedirect(returnOrigin, 'not_invited');
  }

  const googleSub = typeof payload.sub === 'string' ? payload.sub : null;
  const displayName = typeof payload.name === 'string' ? payload.name.slice(0, 240) : null;
  const pictureUrl = typeof payload.picture === 'string' ? payload.picture.slice(0, 1024) : null;
  const now = Date.now();

  let userRow;
  try{
    userRow = await env.MESA_DB.prepare('SELECT id, household_code FROM users WHERE email = ? AND deleted_at IS NULL').bind(email).first();
  }catch(e){
    return errorRedirect(returnOrigin, 'server');
  }

  // Household attach (Phase 3A.2): an invited email can carry a household
  // code/slot on its allowed_emails row (how a partner lands directly in an
  // existing household), else everyone still gets SOME household — a fresh
  // one — so there's always exactly one attach path, never a null case.
  const attachHouseholdCode = (allowedRow && allowedRow.household_code) ? allowedRow.household_code : generateHouseholdCode();
  const attachMemberSlot = (allowedRow && allowedRow.member_slot) ? allowedRow.member_slot : 'elena';

  let userId;
  if(userRow && userRow.id){
    userId = userRow.id;
    try{
      await env.MESA_DB.prepare(
        'UPDATE users SET google_sub = ?, display_name = ?, picture_url = ? WHERE id = ?'
      ).bind(googleSub, displayName, pictureUrl, userId).run();
    }catch(e){
      return errorRedirect(returnOrigin, 'server');
    }
    // Backfill: a user created before the 0004 migration (or otherwise
    // missing a household) gets attached on their next login, same logic
    // as a brand-new signup would have used.
    if(!userRow.household_code){
      try{
        await env.MESA_DB.prepare(
          'UPDATE users SET household_code = ?, member_slot = ? WHERE id = ?'
        ).bind(attachHouseholdCode, attachMemberSlot, userId).run();
      }catch(e){
        return errorRedirect(returnOrigin, 'server');
      }
    }
  } else {
    let countRow;
    try{
      countRow = await env.MESA_DB.prepare('SELECT COUNT(*) AS c FROM users WHERE deleted_at IS NULL').first();
    }catch(e){
      return errorRedirect(returnOrigin, 'server');
    }
    const maxUsers = parseInt(env.MAX_USERS, 10) || 20;
    const currentCount = (countRow && typeof countRow.c === 'number') ? countRow.c : 0;
    if(currentCount >= maxUsers){
      return errorRedirect(returnOrigin, 'full');
    }
    userId = crypto.randomUUID();
    try{
      await env.MESA_DB.prepare(
        'INSERT INTO users (id, email, google_sub, display_name, picture_url, created_at, deleted_at, household_code, member_slot) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)'
      ).bind(userId, email, googleSub, displayName, pictureUrl, now, attachHouseholdCode, attachMemberSlot).run();
    }catch(e){
      return errorRedirect(returnOrigin, 'server');
    }
  }

  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  const expiresAt = now + SESSION_TTL_MS;
  try{
    await env.MESA_DB.prepare(
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(tokenHash, userId, now, expiresAt, now).run();
  }catch(e){
    return errorRedirect(returnOrigin, 'server');
  }

  // Opportunistic cleanup of expired sessions — best-effort, never blocks the
  // response over it (a failed sweep just means expired rows linger a bit
  // longer, which is harmless since /auth/me and /auth/logout both re-check
  // expires_at themselves).
  try{
    await env.MESA_DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();
  }catch(e){
    // ignore
  }

  // Token goes in the URL FRAGMENT, not a query string: fragments are never
  // sent to the server by the browser on subsequent navigations and are
  // stripped before appearing in most server access logs / Referer headers.
  // Park a copy for the claim flow when this sign-in was started by a client that can't
  // receive the redirect (installed PWA). Best-effort: the fragment below is still the
  // primary delivery for every browser that CAN follow it, so a KV hiccup here must not
  // fail an otherwise-successful sign-in.
  const claimId = (stateData && typeof stateData.linkId === 'string' && CLAIM_ID_RE.test(stateData.linkId)) ? stateData.linkId : null;
  // Visible via `wrangler tail` — the server half of the sign-in diagnostics the client
  // keeps in localStorage. No token, no email: just enough to see WHERE a flow died.
  console.log('auth.callback ok user=' + userId.slice(0, 8) + ' slot=' + (attachMemberSlot || '?')
    + ' return=' + returnOrigin + ' ticket=' + (claimId ? claimId.slice(0, 8) : 'none'));
  if(claimId){
    try{
      await env.MESA_KV.put(CLAIM_KV_PREFIX + claimId, token, {expirationTtl: CLAIM_TTL_SECONDS});
    }catch(e){ /* fragment delivery still works; the PWA will just keep waiting */ }
  }

  return fragmentRedirect(returnOrigin, 'auth=' + token);
}

// Shared by /auth/me and /auth/logout: pulls the bearer token out of the
// Authorization header, hashes it, and looks up a live (non-expired)
// session row. Returns null for anything wrong with the token — caller
// always turns that into a uniform 401.
async function loadSessionFromRequest(request, env){
  const authHeader = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if(!m) return null;
  const token = m[1].trim();
  if(!token) return null;
  if(!d1Available(env)) return null;

  const tokenHash = await sha256Hex(token);
  let session;
  try{
    session = await env.MESA_DB.prepare(
      'SELECT token_hash, user_id, expires_at, last_seen_at FROM sessions WHERE token_hash = ?'
    ).bind(tokenHash).first();
  }catch(e){
    return null;
  }
  if(!session) return null;

  const now = Date.now();
  if(session.expires_at < now){
    try{ await env.MESA_DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run(); }catch(e){}
    return null;
  }

  // Sliding renewal: once fewer than 45 of the original 90 days remain,
  // push expires_at back out to a fresh 90 days so an actively-used session
  // never suddenly expires mid-use.
  if(session.expires_at - now < SESSION_RENEW_THRESHOLD_MS){
    session.expires_at = now + SESSION_TTL_MS;
    try{ await env.MESA_DB.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').bind(session.expires_at, tokenHash).run(); }catch(e){}
  }

  // last_seen_at is a "presence" signal, not an audit trail — only worth a
  // write once per hour of activity so a chatty client doesn't hammer D1.
  if(!session.last_seen_at || (now - session.last_seen_at) > LAST_SEEN_STALE_MS){
    session.last_seen_at = now;
    try{ await env.MESA_DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').bind(now, tokenHash).run(); }catch(e){}
  }

  return session;
}

// Shared by handleMe and loadSessionUser: the one SELECT that turns a
// sessions.user_id into a live user row. Kept separate from
// loadSessionFromRequest (which resolves the bearer token to that user_id)
// so both callers do exactly one query each, with nothing duplicated.
async function loadUserRow(env, userId){
  try{
    return await env.MESA_DB.prepare(
      'SELECT id, email, display_name, picture_url, household_code, member_slot FROM users WHERE id = ? AND deleted_at IS NULL'
    ).bind(userId).first();
  }catch(e){
    return null;
  }
}

// Resolves a request's "Authorization: Bearer <token>" all the way to
// {userId, householdCode, memberSlot}, or null for anything invalid (no/bad
// header, dead/expired session, deleted user) — same "null for anything
// wrong" contract as loadSessionFromRequest. This is the one code path
// worker/sync.js (Phase 3B session gating on /sync/:code and /library/:code)
// and any other module needing "who is this request's household" should
// use, rather than re-deriving it from loadSessionFromRequest themselves.
export async function loadSessionUser(request, env){
  const session = await loadSessionFromRequest(request, env);
  if(!session) return null;
  const user = await loadUserRow(env, session.user_id);
  if(!user) return null;
  return {
    userId: user.id,
    householdCode: user.household_code || null,
    memberSlot: user.member_slot || null
  };
}

async function handleMe(request, env, origin){
  const session = await loadSessionFromRequest(request, env);
  if(!session){
    return json({error: 'unauthorized'}, 401, origin);
  }

  const user = await loadUserRow(env, session.user_id);
  if(!user){
    return json({error: 'unauthorized'}, 401, origin);
  }

  // householdMembers (Phase 3B, B3) + members (Phase 3C, C1): both come from
  // the same one SELECT of every non-deleted row sharing this user's
  // household_code, so there's exactly one query pattern for "who's in my
  // household" rather than a count query and a roster query duplicating each
  // other. householdMembers is just the row count — 1 means solo, 2 means a
  // couple; the client uses it to decide whether to show partner-facing UI
  // (per-meal eat-together controls, "both" summaries, shopping/pantry
  // aggregation) without guessing from memberSlot alone. No household_code
  // (not yet attached) has nobody to share with, so it's a solo household of
  // 1 with no members rows to fetch.
  //
  // members is the household roster the client needs to show BOTH people's
  // real names and Google photos on EITHER phone, without depending on
  // couple-sync to propagate a name the other person typed locally (see
  // PHASE3C-identity-plan.md, C1/C2) — e.g. so Andrea's phone can label
  // Elena "Elena" instead of falling back to "Partner" if her own device
  // never finished syncing a name. Deliberately slot/name/picture only, no
  // email: a household roster doesn't need to leak the partner's address,
  // and nothing in the UI shows it. Rows with an unrecognized/null
  // member_slot are omitted. The caller's own entry is always first.
  let householdMembers = 1;
  let members = [];
  if(user.household_code){
    let memberRows = null;
    try{
      const res = await env.MESA_DB.prepare(
        'SELECT id, display_name, picture_url, member_slot FROM users WHERE household_code = ? AND deleted_at IS NULL'
      ).bind(user.household_code).all();
      memberRows = (res && Array.isArray(res.results)) ? res.results : [];
    }catch(e){
      memberRows = null;
    }
    if(memberRows){
      householdMembers = memberRows.length || 1;
      const self = [];
      const others = [];
      for(let i = 0; i < memberRows.length; i++){
        const row = memberRows[i];
        if(row.member_slot !== 'elena' && row.member_slot !== 'partner') continue;
        const entry = {
          slot: row.member_slot,
          displayName: row.display_name,
          firstName: firstNameOf(row.display_name),
          picture: row.picture_url,
          isSelf: row.id === user.id
        };
        (entry.isSelf ? self : others).push(entry);
      }
      members = self.concat(others);
    }
  } else if(user.member_slot === 'elena' || user.member_slot === 'partner'){
    // No household yet: the roster is just the caller themselves.
    members = [{
      slot: user.member_slot,
      displayName: user.display_name,
      firstName: firstNameOf(user.display_name),
      picture: user.picture_url,
      isSelf: true
    }];
  }

  return json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      picture: user.picture_url
    },
    householdCode: user.household_code || null,
    memberSlot: user.member_slot || null,
    householdMembers: householdMembers,
    expiresAt: session.expires_at,
    members: members
  }, 200, origin);
}

async function handleLogout(request, env, origin){
  const authHeader = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  // No/malformed bearer token: nothing to delete, but logging out of a
  // session you don't hold is a no-op, not an error — stay idempotent.
  if(!m || !m[1].trim()){
    return json({ok: true}, 200, origin);
  }
  const token = m[1].trim();
  if(d1Available(env)){
    const tokenHash = await sha256Hex(token);
    try{
      await env.MESA_DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    }catch(e){
      // best-effort — a failed delete here just means the row (and thus the
      // session) lingers until it naturally expires; the client still clears
      // its own local token either way.
    }
  }
  return json({ok: true}, 200, origin);
}

// Phase 3B/B4: POST /auth/invite-partner — see the doc-comment block in the
// module header for the full list of status codes this can return. Reuses
// loadSessionUser (auth) and loadUserRow (inviter's own email, for the
// self-invite check) rather than re-deriving either.
async function handleInvitePartner(request, env, origin){
  const sessionUser = await loadSessionUser(request, env);
  if(!sessionUser){
    return json({error: 'unauthorized'}, 401, origin);
  }

  // Shape-check the email BEFORE the rate limit. Validation is pure string work —
  // no KV, no D1 — so rejecting a typo costs nothing and must not burn a day's
  // invite budget: five fat-fingered attempts would otherwise lock a legitimate
  // user out of inviting their partner for 24h. The limit below still guards
  // every path that actually touches storage.
  let body;
  try{ body = await request.json(); }catch(e){ body = null; }
  const rawEmail = (isPlainObject(body) && typeof body.email === 'string') ? body.email.trim().toLowerCase() : '';
  if(!rawEmail || rawEmail.length > INVITE_EMAIL_MAX_LEN || !INVITE_EMAIL_RE.test(rawEmail)){
    return json({error: 'invalid_email'}, 400, origin);
  }

  // Rate limit before any D1 work, so a burst of well-formed but abusive
  // requests still only costs one cheap KV read+write per attempt.
  if(await rateLimited(env, 'invite-partner-rate:' + sessionUser.userId, INVITE_RATE_LIMIT, INVITE_RATE_WINDOW_SECONDS)){
    return json({error: 'rate_limited'}, 429, origin);
  }

  // Household + slot are attached together (see handleCallback) so in
  // practice these are null/non-null in lockstep, but guard both — an
  // unrecognized member_slot has nowhere sensible to assign the OTHER slot
  // either, same class of "not really attached yet" as a null household.
  const targetSlot = OTHER_MEMBER_SLOT[sessionUser.memberSlot];
  if(!sessionUser.householdCode || !targetSlot){
    return json({error: 'no_household'}, 409, origin);
  }

  if(!d1Available(env)){
    return json({error: 'server_error'}, 500, origin);
  }

  const inviter = await loadUserRow(env, sessionUser.userId);
  if(!inviter){
    return json({error: 'unauthorized'}, 401, origin);
  }
  if(rawEmail === inviter.email){
    return json({error: 'self_invite'}, 400, origin);
  }

  let existingUser;
  try{
    existingUser = await env.MESA_DB.prepare(
      'SELECT id, household_code FROM users WHERE email = ? AND deleted_at IS NULL'
    ).bind(rawEmail).first();
  }catch(e){
    return json({error: 'server_error'}, 500, origin);
  }
  if(existingUser){
    if(existingUser.household_code === sessionUser.householdCode){
      return json({ok: true, already: true}, 200, origin);
    }
    return json({error: 'taken'}, 409, origin);
  }

  // household_full — counted the same way handleMe's householdMembers is.
  let countRow;
  try{
    countRow = await env.MESA_DB.prepare(
      'SELECT COUNT(*) AS c FROM users WHERE household_code = ? AND deleted_at IS NULL'
    ).bind(sessionUser.householdCode).first();
  }catch(e){
    return json({error: 'server_error'}, 500, origin);
  }
  const householdMembers = (countRow && typeof countRow.c === 'number') ? countRow.c : 1;
  if(householdMembers >= 2){
    return json({error: 'household_full'}, 409, origin);
  }

  // Don't steal an invite: a pending allowed_emails row already pointed at a
  // DIFFERENT household is left alone (409 taken). A row with no household
  // yet, or already pointed at THIS household, is fair game to (re)write.
  let existingAllowed;
  try{
    existingAllowed = await env.MESA_DB.prepare(
      'SELECT email, household_code FROM allowed_emails WHERE email = ?'
    ).bind(rawEmail).first();
  }catch(e){
    return json({error: 'server_error'}, 500, origin);
  }
  if(existingAllowed && existingAllowed.household_code && existingAllowed.household_code !== sessionUser.householdCode){
    return json({error: 'taken'}, 409, origin);
  }

  try{
    await env.MESA_DB.prepare(
      'INSERT OR REPLACE INTO allowed_emails (email, note, added_at, household_code, member_slot) VALUES (?, ?, ?, ?, ?)'
    ).bind(rawEmail, 'partner-invite', Date.now(), sessionUser.householdCode, targetSlot).run();
  }catch(e){
    return json({error: 'server_error'}, 500, origin);
  }

  return json({ok: true, email: rawEmail, memberSlot: targetSlot}, 200, origin);
}

/* GET /auth/claim?link_id=<id> — one-time pickup of a token parked by the callback.
   200 {token} and the ticket is destroyed; 404 {error:'not_ready'} while the user is
   still completing (or abandoned) the Google flow. Deliberately gives the same 404 for
   "never existed", "expired" and "already claimed" so a guesser learns nothing about
   which ids are real. */
async function handleClaim(request, env, origin, url){
  const linkId = (url.searchParams.get('link_id') || '').toLowerCase();
  if(!CLAIM_ID_RE.test(linkId)){
    return json({error: 'invalid_link_id'}, 400, origin);
  }
  if(!env || !env.MESA_KV){
    return json({error: 'not_ready'}, 404, origin);
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if(await rateLimited(env, 'auth-claim-rate:' + ip, CLAIM_RATE_LIMIT, CLAIM_RATE_WINDOW_SECONDS)){
    return json({error: 'rate_limited'}, 429, origin);
  }

  let token = null;
  try{
    token = await env.MESA_KV.get(CLAIM_KV_PREFIX + linkId);
  }catch(e){
    return json({error: 'not_ready'}, 404, origin);
  }
  if(!token){
    console.log('auth.claim miss ticket=' + linkId.slice(0, 8));
    return json({error: 'not_ready'}, 404, origin);
  }
  console.log('auth.claim hit ticket=' + linkId.slice(0, 8));
  // Single use — delete before handing it out so a replayed request can't get it twice.
  try{ await env.MESA_KV.delete(CLAIM_KV_PREFIX + linkId); }catch(e){}

  return json({token: token}, 200, origin);
}

// Single entry point sync.js routes every "/auth/*" pathname to.
export async function handleAuthRoute(request, env, origin, url){
  const pathname = url.pathname;

  if(pathname === '/auth/google/start' && request.method === 'GET'){
    return handleStart(request, env, origin, url);
  }
  if(pathname === '/auth/google/callback' && request.method === 'GET'){
    return handleCallback(request, env, origin, url);
  }
  if(pathname === '/auth/claim' && request.method === 'GET'){
    return handleClaim(request, env, origin, url);
  }
  if(pathname === '/auth/me' && request.method === 'GET'){
    return handleMe(request, env, origin);
  }
  if(pathname === '/auth/logout' && request.method === 'POST'){
    return handleLogout(request, env, origin);
  }
  if(pathname === '/auth/invite-partner' && request.method === 'POST'){
    return handleInvitePartner(request, env, origin);
  }

  return json({error: 'not_found'}, 404, origin);
}
