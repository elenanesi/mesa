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
     POST /bootstrap -> body {email, existingCode?}. For the two Access
                       allow-listed emails, returns/stores the household
                       code associated with this Cloudflare Access login.
                       This lets an iOS reinstall recover the same sync
                       household even after localStorage was wiped.
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

// ~1MB cap (plan: "Payload cap ~1 MB") — measured on the raw request body text, before
// JSON.parse, so an oversized payload is rejected without ever paying to parse it.
const MAX_PAYLOAD_BYTES = 1024 * 1024;

function corsHeaders(origin){
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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

async function handleBootstrap(request, env, origin){
  let parsed;
  try{
    parsed = JSON.parse(await request.text());
  }catch(e){
    return json({error: 'invalid_json'}, 400, origin);
  }
  if(!isPlainObject(parsed) || !isAllowedAccessEmail(parsed.email)){
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

export default {
  async fetch(request, env){
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if(request.method === 'OPTIONS'){
      return new Response(null, {status: 204, headers: corsHeaders(origin)});
    }

    if(url.pathname === '/bootstrap' && request.method === 'POST'){
      return handleBootstrap(request, env, origin);
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
