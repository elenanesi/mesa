#!/usr/bin/env node
'use strict';

/* ===================================================================
   tools/seed-d1.js — generates the SQL that seeds/refreshes the D1
   library catalog's GLOBAL (builtin) rows from the current data files,
   and tombstones stale builtin rows that no longer exist locally.

   WHY: built-in food/recipe field changes (roles, icons, flags…) ship
   as code, but existing D1 rows only refresh when a logged-in client
   happens to push the catalog mirror (app/js/sync.js:
   mirrorLibraryCatalogToD1). README lesson ("Ingredient icons…"):
   after changing built-in catalog data, deploy Pages AND seed/readback
   D1 explicitly instead of waiting/hoping.

   RUN:  node tools/seed-d1.js > /tmp/seed.sql
         npx wrangler d1 execute mesa-library --remote --file=/tmp/seed.sql
   then readback-verify (see README deploy notes).

   HOW: loads the app files into a vm context exactly like
   tools/check.js (same stubs, same script order — see that file's
   header for why this mirrors <script> tags), then calls the app's own
   buildLibraryCatalogPayload() in a FRESH context (no custom entries),
   so every emitted row is byte-identical to what a real client push
   would send for builtin data. SQL statements mirror worker/sync.js's
   upsertFoodRow/upsertRecipeRow column-for-column (scope 'global',
   source 'builtin', updated_at 0, deleted_at NULL).
   =================================================================== */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_DIR = path.join(__dirname, '..', 'app');
const APP_SCRIPT_ORDER = [
  'data/foods.js', 'data/recipes.js', 'data/validate.js',
  'js/state.js', 'js/log.js', 'js/engine.js', 'js/planner.js', 'js/render.js',
  'js/library.js', 'js/sync.js'
];

function noop(){}
function fakeEl(){
  return {
    style: {}, children: [], classList: {add: noop, remove: noop, contains: function(){ return false; }},
    addEventListener: noop, removeEventListener: noop, setAttribute: noop, appendChild: noop
  };
}

function createContext(){
  const store = new Map();
  const sandbox = {
    console: {log: noop, warn: noop, error: noop},
    localStorage: {
      getItem: function(k){ return store.has(k) ? store.get(k) : null; },
      setItem: function(k, v){ store.set(String(k), String(v)); },
      removeItem: function(k){ store.delete(k); }
    },
    navigator: {userAgent: 'mesa-seed-d1/node'},
    location: {protocol: 'file:', host: 'localhost', hostname: 'localhost', href: 'http://localhost/'},
    crypto: globalThis.crypto,
    fetch: function(){ return Promise.reject(new Error('seed-d1 must stay offline')); },
    setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval
  };
  sandbox.document = {
    getElementById: function(){ return null; }, querySelector: function(){ return null; }, querySelectorAll: function(){ return []; },
    createElement: fakeEl, addEventListener: noop, removeEventListener: noop,
    cookie: '', body: fakeEl(), documentElement: fakeEl()
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // Same pre-seed as tools/check.js: library.js's top-level icon-cache check
  // must not attempt a fetch just because the app loaded.
  sandbox.localStorage.setItem('mesa.defaultFoodIcon.v1', 'data:image/png;base64,AA==');
  return sandbox;
}

function sq(s){ return "'" + String(s).replace(/'/g, "''") + "'"; }

const ctx = createContext();
APP_SCRIPT_ORDER.forEach(function(rel){
  const full = path.join(APP_DIR, rel);
  vm.runInContext(fs.readFileSync(full, 'utf8'), ctx, {filename: full});
});
const payload = vm.runInContext('buildLibraryCatalogPayload()', ctx);

const lines = [];
payload.foods.forEach(function(row){
  if(row.source !== 'builtin') return; // fresh context should only contain builtins; guard anyway
  lines.push(
    'INSERT INTO foods (scope,id,source,name,category,season,updated_at,deleted_at,data_json) VALUES (' +
    ["'global'", sq(row.id), "'builtin'", sq(row.name), sq(row.category), sq(row.season), '0', 'NULL', sq(JSON.stringify(row.data))].join(',') +
    ') ON CONFLICT(scope,id) DO UPDATE SET source=excluded.source,name=excluded.name,category=excluded.category,season=excluded.season,updated_at=excluded.updated_at,deleted_at=NULL,data_json=excluded.data_json;'
  );
});
payload.recipes.forEach(function(row){
  if(row.source !== 'builtin') return;
  lines.push(
    'INSERT INTO recipes (scope,id,source,title,primary_slot,season,updated_at,deleted_at,data_json) VALUES (' +
    ["'global'", sq(row.id), "'builtin'", sq(row.title), sq(row.primarySlot), sq(row.season), '0', 'NULL', sq(JSON.stringify(row.data))].join(',') +
    ') ON CONFLICT(scope,id) DO UPDATE SET source=excluded.source,title=excluded.title,primary_slot=excluded.primary_slot,season=excluded.season,updated_at=excluded.updated_at,deleted_at=NULL,data_json=excluded.data_json;'
  );
});

function idList(rows){
  return rows.filter(function(row){ return row.source === 'builtin'; }).map(function(row){ return sq(row.id); }).join(',');
}

const foodIdList = idList(payload.foods);
const recipeIdList = idList(payload.recipes);
if(foodIdList){
  lines.push(
    "UPDATE foods SET deleted_at=COALESCE(deleted_at, CAST(strftime('%s','now') AS INTEGER)*1000) " +
    "WHERE scope='global' AND source='builtin' AND id NOT IN (" + foodIdList + ');'
  );
}
if(recipeIdList){
  lines.push(
    "UPDATE recipes SET deleted_at=COALESCE(deleted_at, CAST(strftime('%s','now') AS INTEGER)*1000) " +
    "WHERE scope='global' AND source='builtin' AND id NOT IN (" + recipeIdList + ');'
  );
}

process.stderr.write('seed-d1: ' + payload.foods.length + ' foods, ' + payload.recipes.length + ' recipes -> ' + lines.length + ' statements\n');
process.stdout.write(lines.join('\n') + '\n');
