/* ===================================================================
   worker/sync.js — Mesa couple-sync backend (Phase 2, task S1)

   One Cloudflare Worker, one KV namespace (binding MESA_KV). Plain JS,
   module syntax, zero dependencies. The Worker is deliberately DUMB
   storage: it does not understand Mesa's data model at all — it just
   keeps, per section name, whichever {rev, updatedAt, data} the client
   sends has the higher rev (ties broken by higher updatedAt), and
   returns the resulting merged map. ALL real merging (library
   merge-by-id, shopping union, log append-merge with tombstones) is
   client-side (app/js/sync.js) — see PHASE2-plan.md's "Section model &
   merge rules".

   A household is identified by a random secret code the client
   generates (crypto-random, ~26 chars) — it IS the auth; there are no
   accounts, no per-code secrets beyond the code itself. Anyone who
   knows the code can read/write that household's data, same trust
   model as "share this code with your partner".

   Endpoints:
     POST /bootstrap -> header 'Cf-Access-Jwt-Assertion': <JWT>, body
                       {existingCode?}. The JWT is the Cloudflare Access
                       session token (client reads it out of the
                       CF_Authorization cookie on the Pages origin — see
                       app/js/sync.js:accessJwtFromCookie); this Worker
                       verifies it against the Access team's published
                       JWKs (verifyAccessJWT below) rather than trusting
                       a client-supplied email, since this Worker itself
                       sits on a bare workers.dev hostname and can't be
                       put behind Access. For the two allow-listed
                       emails found in the VERIFIED token, returns/
                       stores the household code associated with this
                       Cloudflare Access login. This lets an iOS
                       reinstall recover the same sync household even
                       after localStorage was wiped. Rate-limited to
                       ~10 attempts/hour per IP (bootstrapRateLimited).
     GET  /sync/:code  -> 200 {sections: {...}} | 404 {error} if the
                          code has never been POSTed to.
     POST /sync/:code  -> body {sections: {name: {rev, updatedAt, data}}}
                          any POST creates the household (first write
                          for a new code just stores it, nothing to
                          compare against yet). Returns the merged full
                          state, same shape as GET. Payload capped at
                          ~1MB -> 413. Malformed JSON -> 400. A
                          malformed INDIVIDUAL section inside an
                          otherwise-valid body is skipped rather than
                          failing the whole request (defensive: a
                          client bug in one section shouldn't wedge
                          every other section's sync).
     OPTIONS *         -> CORS preflight (204, no body).
     anything else     -> 404 {error}.

   CORS: only the app's known origins (mesa-9y5.pages.dev + the two
   local-dev origins used by the verification harness) get the
   Access-Control-Allow-Origin header — everything else is a normal
   response without it, so the browser blocks it client-side.
   =================================================================== */

const ALLOWED_ORIGINS = [
  'https://mesa-9y5.pages.dev',
  'http://127.0.0.1:8322',
  'http://localhost:8322'
];

const ACCESS_EMAILS = ['elenanesi55@gmail.com', 'angelucci88@gmail.com'];
const ACCESS_BOOTSTRAP_KEY = 'access-bootstrap:v2:mesa-household';
const ACCESS_TEAM_DOMAIN = 'https://lively-unit-4aa5.cloudflareaccess.com';
const ACCESS_CERTS_URL = ACCESS_TEAM_DOMAIN + '/cdn-cgi/access/certs';
const BOOTSTRAP_RATE_LIMIT = 10; // max /bootstrap attempts per IP per window (cheap abuse guard, not precise)
const BOOTSTRAP_RATE_WINDOW_SECONDS = 3600;
const ICON_180_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAYAAAA9zQYyAAADR0lEQVR42u3dQWobQRBA0blnNrlBdiG3yJFtdABBHKRx9a9X8LfC1DyGtka2rmv4/Pr7+0NzugywwAMswCEW3CALbJC1AraLpAxsF0YJ1C6GMrBdAGVQW7wyqC1cGdQWrQxqC1YGtcUqg9pClUFtkUqhtkRlQFugMqgtTinUlqYMaAtTCrVlKQPaopRCbUnKgLag9/UYe7gZteW8HvGzsR+gM5ihvgG0xQCdQm0przvn/us4nwM9/pz71XE+B3r0seC7MW9F7e78BhgT7s7u0u7OL4HxP3PC+RzoEOav4JiEef2xA2aYgQZ63C+CQC8D/a5z7rS7M9Awwwy0o8ZE0OufFjpu3PPe87SfO4sa5nueDMIMNNBAAz0VnaeCQI8H7TE30O7QQAM99fx88t0faHdod2iggQYa6CToaW8JAu0cnXptoIEe+1gd6GWg3aWB9mm7Ba8NtM9Dj/54KtSLQL8bx6mvDbSjh6MH0DtAT3nHA2io3aWB9vTQ43Cg0//brvDaQAMNNNBnoN762kCHcHttoCWgJaAloAW0BLQEtAS0BLSAloCWgJaAloAW0KP68eenbgxokMEGGmigF4EGCmp3aLlDA61nnfJ3i0e9y/EYuO6HfNIf4V4nYTbfO0ADDTTQQAMNtAEaaAM00EADDTXMQAMN9IaPjxqYgTZAA22AhhpmoIEGGmgDdOuvvg3MQBugoYYZaKCBBhpqmIGmD+je/7YzMANtgIYaZqChhhlooIEGGurlmLP/wd/sxJz+SgqzD3P+O1bMLswrvjTI7MG85luwzA7Mq77WzXysuM6rvqcQZqChhhlosEEGGmqYgQYbZKCTsF0/oBOwXS+gE7BdH6ATsF0PoI/Hbe9AHw3cXoE+Ar49AL3qLm2XQCfP03YLdO6XQzsGGmgBDTTQAhpoqGEG2tt2AlpAS0BLA0E/xiKUwQy0gJaAloCWgBbQFiKgpZGgoVYKM9ACWgJaugk01EphBlpAS5NBQ60UZqCVAw21UpiBVg401EphBlo50FArhRlq5TADrRxoqJXCDLVymKFWDjPUymGGWjnMUCuHGWrlMEOtHGawlYMMtZKYwVYOMthKQgZbSchw69o2LjrAwAvYJ/MJTjzqeR+ro3sAAAAASUVORK5CYII=';

// ~1MB cap (plan: "Payload cap ~1 MB") — measured on the raw request body text, before
// JSON.parse, so an oversized payload is rejected without ever paying to parse it.
const MAX_PAYLOAD_BYTES = 1024 * 1024;

function corsHeaders(origin){
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Cf-Access-Jwt-Assertion',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  if(origin && ALLOWED_ORIGINS.indexOf(origin) !== -1){
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function json(data, status, origin){
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({'Content-Type': 'application/json'}, corsHeaders(origin))
  });
}

function isPlainObject(v){ return !!v && typeof v === 'object' && !Array.isArray(v); }

// One stored/incoming section entry: {rev: number, updatedAt: number, data: <anything>}.
// `data` is deliberately unvalidated beyond "present" — the Worker doesn't know or care
// about Mesa's section shapes (library/plans/shopping/profile:*/log:*); that's the
// client's job.
function isValidSectionEntry(v){
  return isPlainObject(v) && typeof v.rev === 'number' && isFinite(v.rev)
    && typeof v.updatedAt === 'number' && isFinite(v.updatedAt)
    && Object.prototype.hasOwnProperty.call(v, 'data');
}

// Per-section higher-rev-wins, ties broken by higher updatedAt (PHASE2-plan.md).
function winner(existing, incoming){
  if(!existing) return incoming;
  if(!incoming) return existing;
  if(incoming.rev !== existing.rev) return incoming.rev > existing.rev ? incoming : existing;
  return incoming.updatedAt >= existing.updatedAt ? incoming : existing;
}

function kvKey(code){ return 'household:' + code; }
function normalizeEmail(email){ return String(email || '').trim().toLowerCase(); }
function isAllowedAccessEmail(email){ return ACCESS_EMAILS.indexOf(normalizeEmail(email)) !== -1; }

function normalizeHouseholdCode(raw){
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function iconResponse(){
  const bin = atob(ICON_180_PNG_BASE64);
  const bytes = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable'
    }
  });
}

/* ---------------- Cloudflare Access JWT verification (bootstrap only) ----------------
   The Worker can't sit behind Access itself (bare workers.dev hostname), so /bootstrap
   can't rely on Access to have already gated the request the way the Pages origin is
   gated. Instead the client hands over its Access session JWT (read client-side from the
   CF_Authorization cookie — app/js/sync.js:accessJwtFromCookie) and this Worker verifies
   the signature itself against the team's published JWKs before trusting anything in it —
   in particular, the 'email' claim, which is the ONLY source of truth for
   isAllowedAccessEmail from here on; a client-supplied JSON email field is never trusted
   again (that was the vulnerability this fixes). */

// Per-isolate cache of the Access team's JWK set — fetched at most once per isolate
// lifetime. A transient fetch failure clears the cache rather than caching the failure, so
// the next request gets a fresh attempt instead of being stuck failing for the isolate's
// whole lifetime.
let cachedCertsPromise = null;
function fetchAccessCerts(){
  if(!cachedCertsPromise){
    cachedCertsPromise = fetch(ACCESS_CERTS_URL).then(function(res){
      if(!res.ok) throw new Error('access certs http ' + res.status);
      return res.json();
    }).catch(function(err){
      cachedCertsPromise = null;
      throw err;
    });
  }
  return cachedCertsPromise;
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

// Verifies a Cloudflare Access JWT (RS256) end-to-end: structure, issuer, expiry, audience
// (when env.ACCESS_AUD is configured), and signature against the team's live JWKs. Returns
// the verified payload object on success, or null on ANY failure — callers must treat null
// as "reject the request" and never fall back to trusting an unverified claim out of it.
async function verifyAccessJWT(token, env){
  if(!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if(parts.length !== 3) return null;

  let header, payload;
  try{
    header = base64UrlDecodeJSON(parts[0]);
    payload = base64UrlDecodeJSON(parts[1]);
  }catch(e){
    return null; // malformed base64/JSON — not a real JWT
  }
  if(!isPlainObject(header) || header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
  if(!isPlainObject(payload) || payload.iss !== ACCESS_TEAM_DOMAIN) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  if(typeof payload.exp !== 'number' || nowSec >= payload.exp) return null;
  if(typeof payload.iat === 'number' && nowSec < payload.iat - 60) return null; // 60s clock-skew allowance

  // aud check: enforced whenever ACCESS_AUD is configured (log-and-reject on mismatch).
  // When unset, this branch is structurally present but doesn't run — see module doc /
  // task notes: ACCESS_AUD MUST be set at deploy time for this check to actually protect
  // anything; until then every other check (signature/issuer/expiry/allow-listed email)
  // still applies.
  if(env && env.ACCESS_AUD){
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if(aud.indexOf(env.ACCESS_AUD) === -1){
      console.log('Mesa sync: bootstrap rejected — aud mismatch');
      return null;
    }
  }

  let certs;
  try{
    certs = await fetchAccessCerts();
  }catch(e){
    console.log('Mesa sync: bootstrap rejected — could not fetch Access certs', e);
    return null;
  }
  const keys = (certs && Array.isArray(certs.keys)) ? certs.keys : [];
  let jwk = null;
  for(let i = 0; i < keys.length; i++){ if(keys[i] && keys[i].kid === header.kid){ jwk = keys[i]; break; } }
  if(!jwk) return null; // signed by a key this team doesn't currently publish

  let cryptoKey;
  try{
    cryptoKey = await crypto.subtle.importKey('jwk', jwk, {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['verify']);
  }catch(e){
    return null;
  }

  const signedData = new TextEncoder().encode(parts[0] + '.' + parts[1]);
  let valid = false;
  try{
    valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, base64UrlToBytes(parts[2]), signedData);
  }catch(e){
    return null;
  }
  return valid ? payload : null;
}

// Cheap KV-backed TTL counter: max BOOTSTRAP_RATE_LIMIT attempts per CF-Connecting-IP per
// BOOTSTRAP_RATE_WINDOW_SECONDS. Not a precise sliding/fixed window (each hit renews the
// key's TTL, so a steady trickle of requests can keep the window open indefinitely) — fine
// for a low-traffic bootstrap endpoint whose real job is blocking a curl-in-a-loop, not
// exact quota enforcement. Fails OPEN (returns false = not limited) on any KV error so a
// transient KV blip never blocks legitimate bootstrap.
async function bootstrapRateLimited(env, ip){
  if(!env || !env.MESA_KV) return false;
  const key = 'bootstrap-rate:' + ip;
  let count = 0;
  try{
    const raw = await env.MESA_KV.get(key);
    count = raw ? (parseInt(raw, 10) || 0) : 0;
  }catch(e){
    return false;
  }
  if(count >= BOOTSTRAP_RATE_LIMIT) return true;
  try{
    await env.MESA_KV.put(key, String(count + 1), {expirationTtl: BOOTSTRAP_RATE_WINDOW_SECONDS});
  }catch(e){
    // best-effort — a failed write just means this one tick isn't counted, not fatal
  }
  return false;
}

async function readStored(env, code){
  try{
    const raw = await env.MESA_KV.get(kvKey(code));
    if(!raw) return null;
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  }catch(e){
    return null; // corrupt KV value (shouldn't happen — we only ever write our own JSON) — treat as absent
  }
}

async function handleGet(env, code, origin){
  const stored = await readStored(env, code);
  if(!stored) return json({error: 'not_found'}, 404, origin);
  return json({sections: stored}, 200, origin);
}

async function handlePost(request, env, code, origin){
  let bodyText;
  try{
    bodyText = await request.text();
  }catch(e){
    return json({error: 'bad_request'}, 400, origin);
  }
  // Byte length, not character length — String.length under-counts multi-byte UTF-8.
  if(new TextEncoder().encode(bodyText).length > MAX_PAYLOAD_BYTES){
    return json({error: 'payload_too_large'}, 413, origin);
  }

  let parsed;
  try{
    parsed = JSON.parse(bodyText);
  }catch(e){
    return json({error: 'invalid_json'}, 400, origin);
  }
  if(!isPlainObject(parsed) || !isPlainObject(parsed.sections)){
    return json({error: 'invalid_body'}, 400, origin);
  }

  const existing = (await readStored(env, code)) || {}; // absent = new household, first POST creates it
  const merged = Object.assign({}, existing);
  Object.keys(parsed.sections).forEach(function(sectionName){
    const incoming = parsed.sections[sectionName];
    if(!isValidSectionEntry(incoming)) return; // skip one malformed section, don't fail the whole request
    merged[sectionName] = winner(existing[sectionName], incoming);
  });

  try{
    await env.MESA_KV.put(kvKey(code), JSON.stringify(merged));
  }catch(e){
    return json({error: 'storage_failed'}, 500, origin);
  }

  return json({sections: merged}, 200, origin);
}

function d1Available(env){ return !!(env && env.MESA_DB); }

function safeJSONStringify(v){
  try{ return JSON.stringify(v == null ? null : v); }
  catch(e){ return 'null'; }
}

function cleanCatalogId(v){ return String(v || '').trim(); }
function normalizeSeason(v){
  return v === 'winter/autumn' || v === 'spring/summer' ? v : 'evergreen';
}
function validCatalogScope(scope){ return scope === 'global' || /^[A-Z0-9]{8,}$/.test(scope); }
function catalogScopeForRow(row, fallbackCode){
  const source = row && row.source;
  if(source === 'builtin') return 'global';
  return fallbackCode;
}

async function upsertFoodRow(env, code, row){
  if(!row || !isPlainObject(row)) return;
  const id = cleanCatalogId(row.id);
  const source = row.source === 'custom' ? 'custom' : (row.source === 'builtin' ? 'builtin' : null);
  const data = isPlainObject(row.data) ? row.data : null;
  if(!id || !source || !data) return;
  const scope = catalogScopeForRow(row, code);
  if(!validCatalogScope(scope)) return;
  const name = String(row.name || data.name || id).slice(0, 240);
  const category = row.category || data.cat || null;
  const season = normalizeSeason(row.season || data.season);
  const updatedAt = typeof row.updatedAt === 'number' && isFinite(row.updatedAt) ? row.updatedAt : Date.now();
  await env.MESA_DB.prepare(
    'INSERT INTO foods (scope,id,source,name,category,season,updated_at,deleted_at,data_json) VALUES (?,?,?,?,?,?,?,NULL,?) ' +
    'ON CONFLICT(scope,id) DO UPDATE SET source=excluded.source,name=excluded.name,category=excluded.category,season=excluded.season,updated_at=excluded.updated_at,deleted_at=NULL,data_json=excluded.data_json'
  ).bind(scope, id, source, name, category, season, updatedAt, safeJSONStringify(data)).run();
}

async function upsertRecipeRow(env, code, row){
  if(!row || !isPlainObject(row)) return;
  const id = cleanCatalogId(row.id);
  const source = row.source === 'custom' || row.source === 'override' ? row.source : (row.source === 'builtin' ? 'builtin' : null);
  const data = isPlainObject(row.data) ? row.data : null;
  if(!id || !source || !data) return;
  const scope = catalogScopeForRow(row, code);
  if(!validCatalogScope(scope)) return;
  const title = String(row.title || data.title || id).slice(0, 240);
  const primarySlot = row.primarySlot || data.slot || null;
  const season = normalizeSeason(row.season || data.season);
  const updatedAt = typeof row.updatedAt === 'number' && isFinite(row.updatedAt) ? row.updatedAt : Date.now();
  await env.MESA_DB.prepare(
    'INSERT INTO recipes (scope,id,source,title,primary_slot,season,updated_at,deleted_at,data_json) VALUES (?,?,?,?,?,?,?,NULL,?) ' +
    'ON CONFLICT(scope,id) DO UPDATE SET source=excluded.source,title=excluded.title,primary_slot=excluded.primary_slot,season=excluded.season,updated_at=excluded.updated_at,deleted_at=NULL,data_json=excluded.data_json'
  ).bind(scope, id, source, title, primarySlot, season, updatedAt, safeJSONStringify(data)).run();
}

async function upsertRecipePref(env, code, recipeId, pref){
  if(pref !== 'favorite' && pref !== 'down') return;
  recipeId = cleanCatalogId(recipeId);
  if(!recipeId) return;
  await env.MESA_DB.prepare(
    'INSERT INTO recipe_prefs (household_code,recipe_id,pref,updated_at) VALUES (?,?,?,?) ' +
    'ON CONFLICT(household_code,recipe_id) DO UPDATE SET pref=excluded.pref,updated_at=excluded.updated_at'
  ).bind(code, recipeId, pref, Date.now()).run();
}

async function upsertTombstone(env, code, itemType, itemId, deletedAt){
  itemId = cleanCatalogId(itemId);
  if(!itemId || (itemType !== 'food' && itemType !== 'recipe')) return;
  const t = typeof deletedAt === 'number' && isFinite(deletedAt) ? deletedAt : Date.now();
  await env.MESA_DB.prepare(
    'INSERT INTO library_tombstones (household_code,item_type,item_id,deleted_at) VALUES (?,?,?,?) ' +
    'ON CONFLICT(household_code,item_type,item_id) DO UPDATE SET deleted_at=max(library_tombstones.deleted_at, excluded.deleted_at)'
  ).bind(code, itemType, itemId, t).run();
  const table = itemType === 'food' ? 'foods' : 'recipes';
  await env.MESA_DB.prepare('UPDATE ' + table + ' SET deleted_at=? WHERE scope=? AND id=?')
    .bind(t, code, itemId).run();
}

async function handleLibraryPost(request, env, code, origin){
  if(!d1Available(env)) return json({error: 'd1_not_configured'}, 503, origin);
  let bodyText;
  try{ bodyText = await request.text(); }catch(e){ return json({error: 'bad_request'}, 400, origin); }
  if(new TextEncoder().encode(bodyText).length > MAX_PAYLOAD_BYTES){
    return json({error: 'payload_too_large'}, 413, origin);
  }
  let parsed;
  try{ parsed = JSON.parse(bodyText); }catch(e){ return json({error: 'invalid_json'}, 400, origin); }
  if(!isPlainObject(parsed)) return json({error: 'invalid_body'}, 400, origin);

  const foods = Array.isArray(parsed.foods) ? parsed.foods : [];
  const recipes = Array.isArray(parsed.recipes) ? parsed.recipes : [];
  for(let i = 0; i < foods.length; i++) await upsertFoodRow(env, code, foods[i]);
  for(let i = 0; i < recipes.length; i++) await upsertRecipeRow(env, code, recipes[i]);

  const prefs = isPlainObject(parsed.recipePrefs) ? parsed.recipePrefs : {};
  for(const recipeId of Object.keys(prefs)) await upsertRecipePref(env, code, recipeId, prefs[recipeId]);

  const deletedFoods = isPlainObject(parsed.deletedFoods) ? parsed.deletedFoods : {};
  for(const id of Object.keys(deletedFoods)) await upsertTombstone(env, code, 'food', id, deletedFoods[id]);
  const deletedRecipes = isPlainObject(parsed.deletedRecipes) ? parsed.deletedRecipes : {};
  for(const id of Object.keys(deletedRecipes)) await upsertTombstone(env, code, 'recipe', id, deletedRecipes[id]);

  return json({ok: true, foods: foods.length, recipes: recipes.length}, 200, origin);
}

function parseD1JSONRow(row){
  try{ row.data = JSON.parse(row.data_json); }
  catch(e){ row.data = null; }
  delete row.data_json;
  return row;
}

async function handleLibraryGet(env, code, origin, includeDeleted){
  if(!d1Available(env)) return json({error: 'd1_not_configured'}, 503, origin);
  const foodRows = await env.MESA_DB.prepare(
    'SELECT scope,id,source,name,category,season,updated_at,deleted_at,data_json FROM foods ' +
    'WHERE scope IN (?,?)' + (includeDeleted ? '' : ' AND deleted_at IS NULL') + ' ORDER BY name COLLATE NOCASE'
  ).bind('global', code).all();
  const recipeRows = await env.MESA_DB.prepare(
    'SELECT scope,id,source,title,primary_slot,season,updated_at,deleted_at,data_json FROM recipes ' +
    'WHERE scope IN (?,?)' + (includeDeleted ? '' : ' AND deleted_at IS NULL') + ' ORDER BY title COLLATE NOCASE'
  ).bind('global', code).all();
  const prefs = await env.MESA_DB.prepare(
    'SELECT recipe_id,pref,updated_at FROM recipe_prefs WHERE household_code=? ORDER BY recipe_id'
  ).bind(code).all();
  const tombstones = await env.MESA_DB.prepare(
    'SELECT item_type,item_id,deleted_at FROM library_tombstones WHERE household_code=? ORDER BY item_type,item_id'
  ).bind(code).all();
  return json({
    foods: ((foodRows && foodRows.results) || []).map(parseD1JSONRow),
    recipes: ((recipeRows && recipeRows.results) || []).map(parseD1JSONRow),
    recipePrefs: (prefs && prefs.results) || [],
    tombstones: (tombstones && tombstones.results) || []
  }, 200, origin);
}

async function handleBootstrap(request, env, origin){
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if(await bootstrapRateLimited(env, ip)){
    return json({error: 'rate_limited'}, 429, origin);
  }

  let parsed;
  try{
    parsed = JSON.parse(await request.text());
  }catch(e){
    return json({error: 'invalid_json'}, 400, origin);
  }
  if(!isPlainObject(parsed)) return json({error: 'invalid_body'}, 400, origin);

  // Local-dev-only escape hatch (see module doc / worker/wrangler.toml): wrangler dev
  // --local has no real Access session to hand us a genuine JWT. Honored ONLY when
  // explicitly set — absent (always true for the real deploy unless someone
  // misconfigures it) this branch never runs and email comes from the verified JWT below.
  // Deliberately insecure when active: trusts a client-supplied body.email exactly like
  // the pre-fix behavior.
  let email = null;
  if(env && env.DEV_ALLOW_INSECURE_BOOTSTRAP){
    email = typeof parsed.email === 'string' ? parsed.email : null;
  } else {
    const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
    const payload = await verifyAccessJWT(jwt, env);
    email = payload && typeof payload.email === 'string' ? payload.email : null;
  }

  if(!isAllowedAccessEmail(email)){
    return json({error: 'not_allowed'}, 403, origin);
  }

  let code = null;
  try{
    const stored = await env.MESA_KV.get(ACCESS_BOOTSTRAP_KEY);
    if(stored) code = normalizeHouseholdCode(stored);
  }catch(e){
    code = null;
  }

  const existingCode = normalizeHouseholdCode(parsed.existingCode);
  if(existingCode.length >= 8 && existingCode !== code){
    code = existingCode;
    try{
      await env.MESA_KV.put(ACCESS_BOOTSTRAP_KEY, code);
    }catch(e){
      return json({error: 'storage_failed'}, 500, origin);
    }
  } else if(!code){
    return json({error: 'not_linked'}, 404, origin);
  }

  return json({code: code}, 200, origin);
}

// Matches exactly "/sync/<code>" (an optional trailing slash), <code> being one non-empty
// path segment (no further slashes) — anything else 404s.
function matchSyncRoute(pathname){
  const m = /^\/sync\/([^/]+)\/?$/.exec(pathname);
  return m ? decodeURIComponent(m[1]) : null;
}

function matchLibraryRoute(pathname){
  const m = /^\/library\/([^/]+)\/?$/.exec(pathname);
  return m ? decodeURIComponent(m[1]) : null;
}

export default {
  async fetch(request, env){
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if(request.method === 'OPTIONS'){
      return new Response(null, {status: 204, headers: corsHeaders(origin)});
    }

    if(url.pathname === '/assets/icon-180.png' && (request.method === 'GET' || request.method === 'HEAD')){
      return iconResponse();
    }

    if(url.pathname === '/bootstrap' && request.method === 'POST'){
      return handleBootstrap(request, env, origin);
    }

    const libraryCode = matchLibraryRoute(url.pathname);
    if(libraryCode && libraryCode.trim()){
      const code = normalizeHouseholdCode(libraryCode);
      if(request.method === 'GET') return handleLibraryGet(env, code, origin, url.searchParams.get('includeDeleted') === '1');
      if(request.method === 'POST') return handleLibraryPost(request, env, code, origin);
      return json({error: 'method_not_allowed'}, 405, origin);
    }

    const code = matchSyncRoute(url.pathname);
    if(!code || !code.trim()){
      return json({error: 'not_found'}, 404, origin);
    }

    if(request.method === 'GET') return handleGet(env, code, origin);
    if(request.method === 'POST') return handlePost(request, env, code, origin);

    return json({error: 'method_not_allowed'}, 405, origin);
  }
};
