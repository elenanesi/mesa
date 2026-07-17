/* ===================================================================
   validate.js — structural + coverage checks for data/recipes.js,
   plus (when data/foods.js is also loaded) ingredient-id and kcal-band
   checks. Runnable in the browser console or headlessly.

   validateData() -> { ok, errors[], warnings[], coverage }
     - errors:   hard problems (missing field, bad enum value, unresolved
                 ingredient id, slot below its minimum count...)
     - warnings: soft problems (style/slot coverage below the "5 options"
                 target, kcal outside the plausible band, foods.js not
                 loaded yet...)
     - coverage: counts by slot, by style, by slot x style, and by
                 slot x style after Elena's avoid-list is applied.

   recipeMacros(recipeId) -> {kcal, protein, carbs, fat, satFat, fiber, sugars, freeSugars,
   kcalFromMacros, resolved} | null
     Sums FOODS[foodId] * grams/100 over a recipe's `ingredients` (never
     `toTaste`, per the recipe-data convention). `resolved` is false if
     any ingredient id didn't resolve against FOODS (kcal etc. are then
     partial sums, not to be trusted). `kcalFromMacros` is a 4/4/9
     cross-check (protein*4 + carbs*4 + fat*9) against the food DB's own
     kcal field, useful as a sanity check / fallback. Exported so C1
     (engine.js recipeNutrition) can reuse or replace this.
   =================================================================== */

const VALID_SLOTS = ['breakfast', 'lunch', 'dinner', 'snack', 'side'];
const VALID_STYLES = ['balanced', 'highprotein', 'lowcarb'];
const VALID_TAGS = ['thyroid', 'skin', 'heart', 'muscle', 'lowGI', 'omega3', 'highFiber', 'quick', 'veggie'];
const VALID_AVOID = ['lactose', 'gluten', 'shellfish', 'nuts', 'spicy', 'raw-onion'];
const VALID_SEASONS = ['evergreen', 'winter/autumn', 'spring/summer'];

// task B2: role is orthogonal to slot ('slots' says WHEN a recipe can be planned, 'role'
// says HOW it composes) — 'full' one-dish meals, 'main' protein centerpieces that pair
// with a side, 'side' accompaniments. Required + enum-checked (ERROR) so every recipe in
// RECIPES_DB gets a deliberate tag; applyCustomRecipes() (js/library.js) normalizes legacy
// custom recipes without a role to 'full' at read time so validateData() stays green.
const VALID_ROLES = ['full', 'main', 'side'];

// breakfast 300-650, lunch 400-750, dinner 400-800, snack 100-350 (PWA-MVP-plan.md B2 acceptance).
// Applies only to role:'full' recipes — a composed main+side unit is what must land in the
// slot band now, not the bare main/side component (task B2's "attempt to use, don't force").
const KCAL_BAND = {
  breakfast: [300, 650],
  lunch: [400, 750],
  dinner: [400, 800],
  snack: [100, 350]
};

// task B2: plausibility-only (WARNING) bands for the two sub-full roles, computed per
// serving via recipeMacros — a 'main' or 'side' is expected to be smaller than a full meal
// on its own since it's meant to be combined with the other half of the composed unit.
const ROLE_KCAL_BAND = {
  main: [250, 650],
  side: [60, 300]
};

// Elena's current avoid-list in the app (lactose, raw onion, very spicy — per the B2
// task brief / her PROF entry in state.js). Used only for the coverage report below;
// the planner (task C2) should read the live per-person avoid-list, not this constant.
const ELENA_AVOID = ['lactose', 'raw-onion', 'spicy'];

// Minimum recipe count per slot (PWA-MVP-plan.md B2).
const SLOT_MIN = { breakfast: 7, lunch: 8, dinner: 9, snack: 6 };

// Minimum recipe count per (main slot x style) (B2 task brief: "each plan style must
// have >=5 options per main slot"). Snack has no style-coverage requirement.
const STYLE_SLOT_MIN = 5;

function recipeMacros(recipeId) {
  if (typeof RECIPES_DB === 'undefined') return null;
  const r = RECIPES_DB[recipeId];
  if (!r) return null;
  if (typeof FOODS === 'undefined') return null;

  const totals = { kcal: 0, protein: 0, carbs: 0, fat: 0, satFat: 0, fiber: 0, sugars: 0, freeSugars: 0 };
  let resolved = true;
  // Ingredients describe the whole batch; r.servings (default 1) is how many
  // servings that batch makes. All checks here are per-serving quantities.
  const batchYield = (typeof r.servings === 'number' && r.servings > 0) ? r.servings : 1;

  (r.ingredients || []).forEach(function (ing) {
    const foodId = ing[0], grams = ing[1] / batchYield;
    const food = FOODS[foodId];
    if (!food) { resolved = false; return; }
    // Recipe quantities are always grams. Foods are per 100g/100ml, except
    // unit:'piece' entries (eggs) whose values are PER PIECE with avgG
    // documenting the assumed piece weight — so grams/avgG pieces.
    const factor = food.unit === 'piece' ? grams / food.avgG : grams / (food.per || 100);
    totals.kcal += (food.kcal || 0) * factor;
    totals.protein += (food.protein || 0) * factor;
    totals.carbs += (food.carbs || 0) * factor;
    totals.fat += (food.fat || 0) * factor;
    totals.satFat += (food.satFat || 0) * factor;
    totals.fiber += (food.fiber || 0) * factor;
    totals.sugars += (food.sugars || 0) * factor;
    totals.freeSugars += (food.freeSugars || 0) * factor;
  });

  totals.resolved = resolved;
  totals.kcalFromMacros = totals.protein * 4 + totals.carbs * 4 + totals.fat * 9;
  return totals;
}

function validateData() {
  const errors = [];
  const warnings = [];
  const coverage = { bySlot: {}, byStyle: {}, byStyleSlot: {}, elenaBySlotStyle: {} };

  VALID_SLOTS.forEach(function (s) {
    coverage.bySlot[s] = 0;
    coverage.byStyleSlot[s] = {};
    coverage.elenaBySlotStyle[s] = {};
    VALID_STYLES.forEach(function (st) { coverage.byStyleSlot[s][st] = 0; coverage.elenaBySlotStyle[s][st] = 0; });
  });
  VALID_STYLES.forEach(function (st) { coverage.byStyle[st] = 0; });

  if (typeof RECIPES_DB === 'undefined') {
    errors.push('recipes.js not loaded: RECIPES_DB is undefined');
    return { ok: false, errors: errors, warnings: warnings, coverage: coverage };
  }

  const foodsLoaded = typeof FOODS !== 'undefined';
  if (!foodsLoaded) {
    warnings.push('foods.js not loaded — skipping ingredient-id resolution and kcal-band checks.');
  }
  const sugarQualities = {intrinsic: true, 'added/free': true, mixed: true, unknown: true};

  if(foodsLoaded){
    Object.keys(FOODS).forEach(function(foodId){
      const food = FOODS[foodId];
      const prefix = 'Food "' + foodId + '": ';
      if(typeof food.sugars !== 'number' || !isFinite(food.sugars) || food.sugars < 0) errors.push(prefix + 'sugars must be a valid non-negative number');
      if(typeof food.freeSugars !== 'number' || !isFinite(food.freeSugars) || food.freeSugars < 0) errors.push(prefix + 'freeSugars must be a valid non-negative number');
      if(typeof food.sugarQuality !== 'string' || !sugarQualities[food.sugarQuality]) errors.push(prefix + 'invalid sugarQuality "' + food.sugarQuality + '"');
      if(typeof food.carbs === 'number' && food.sugars > food.carbs + 1e-9) errors.push(prefix + 'sugars must be <= carbs');
      if(food.freeSugars > food.sugars + 1e-9) errors.push(prefix + 'freeSugars must be <= sugars');
    });
  }

  const ids = Object.keys(RECIPES_DB);
  const planningIds = ids.filter(function(id){ return !RECIPES_DB[id].occasional; });
  if (planningIds.length < 32) {
    warnings.push('RECIPES_DB has ' + planningIds.length + ' automatic-planning recipes; target is >=32. Occasional recipes are counted separately.');
  }

  ids.forEach(function (id) {
    const r = RECIPES_DB[id];
    const prefix = 'Recipe "' + id + '": ';

    ['title', 'emoji', 'slot', 'role', 'styles', 'time', 'ingredients', 'toTaste', 'steps', 'tags', 'avoid'].forEach(function (f) {
      if (!(f in r)) errors.push(prefix + 'missing field "' + f + '"');
    });

    if (!('role' in r) || VALID_ROLES.indexOf(r.role) === -1) {
      errors.push(prefix + 'invalid role "' + r.role + '" (must be one of ' + VALID_ROLES.join(', ') + ')');
    }

    if (typeof r.title !== 'string' || !r.title) errors.push(prefix + 'title missing/empty');
    if (typeof r.emoji !== 'string' || !r.emoji) errors.push(prefix + 'emoji missing/empty');
    if (typeof r.time !== 'number' || r.time <= 0) errors.push(prefix + 'time must be a positive number');
    // servings (batch yield) is optional — absent means 1.
    if ('servings' in r && (typeof r.servings !== 'number' || r.servings <= 0)) errors.push(prefix + 'servings must be a positive number');
    if ('season' in r && VALID_SEASONS.indexOf(r.season) === -1) errors.push(prefix + 'invalid season "' + r.season + '"');

    const slotValid = typeof r.slot === 'string' && VALID_SLOTS.indexOf(r.slot) !== -1;
    if (!slotValid) errors.push(prefix + 'invalid slot "' + r.slot + '"');
    if ('slots' in r) {
      if (!Array.isArray(r.slots) || !r.slots.length) {
        errors.push(prefix + 'slots must be a non-empty array when present');
      } else {
        r.slots.forEach(function(slot){
          if (VALID_SLOTS.indexOf(slot) === -1) errors.push(prefix + 'invalid slots entry "' + slot + '"');
        });
      }
    }

    let stylesValid = false;
    if (Array.isArray(r.styles) && r.styles.length > 0) {
      stylesValid = true;
      r.styles.forEach(function (st) {
        if (VALID_STYLES.indexOf(st) === -1) { errors.push(prefix + 'invalid style "' + st + '"'); stylesValid = false; }
      });
    } else {
      errors.push(prefix + 'styles must be a non-empty array');
    }

    if (Array.isArray(r.tags)) {
      r.tags.forEach(function (t) { if (VALID_TAGS.indexOf(t) === -1) errors.push(prefix + 'invalid tag "' + t + '"'); });
    } else {
      errors.push(prefix + 'tags is not an array');
    }

    let avoidValid = Array.isArray(r.avoid);
    if (avoidValid) {
      r.avoid.forEach(function (a) { if (VALID_AVOID.indexOf(a) === -1) { errors.push(prefix + 'invalid avoid key "' + a + '"'); avoidValid = false; } });
    } else {
      errors.push(prefix + 'avoid is not an array');
    }

    if (!Array.isArray(r.ingredients) || r.ingredients.length < 2) {
      errors.push(prefix + 'needs at least 2 ingredients');
    } else {
      r.ingredients.forEach(function (ing) {
        if (!Array.isArray(ing) || ing.length !== 2 || typeof ing[0] !== 'string' || typeof ing[1] !== 'number' || ing[1] <= 0) {
          errors.push(prefix + 'malformed ingredient entry ' + JSON.stringify(ing));
          return;
        }
        if (foodsLoaded && !FOODS[ing[0]]) errors.push(prefix + 'ingredient id "' + ing[0] + '" not found in FOODS');
      });
    }

    if(foodsLoaded){
      const m = recipeMacros(id);
      if(m && m.resolved){
        if(typeof m.sugars !== 'number' || !isFinite(m.sugars) || m.sugars < 0) errors.push(prefix + 'computed sugars must be a valid non-negative number');
        if(typeof m.freeSugars !== 'number' || !isFinite(m.freeSugars) || m.freeSugars < 0) errors.push(prefix + 'computed freeSugars must be a valid non-negative number');
        if(m.sugars > m.carbs + 1e-9) errors.push(prefix + 'computed sugars must be <= carbs');
        if(m.freeSugars > m.sugars + 1e-9) errors.push(prefix + 'computed freeSugars must be <= sugars');
      }
    }

    if (foodsLoaded) {
      Object.keys(FOODS).forEach(function(foodId){
        const f = FOODS[foodId];
        if (f && 'season' in f && VALID_SEASONS.indexOf(f.season) === -1) {
          errors.push('Food "' + foodId + '": invalid season "' + f.season + '"');
        }
      });
    }

    if (!Array.isArray(r.toTaste)) errors.push(prefix + 'toTaste is not an array');

    // User-authored custom recipes (id 'cr-*', js/library.js) default to a single step
    // ("Combine and enjoy.") when the author leaves the steps textarea blank, and can run
    // past 6 lines with no cap — so they get a relaxed 1-N bound; built-in RECIPES_DB
    // recipes (hand-authored, task B2) keep the original 3-6 requirement.
    const isCustomRecipe = id.indexOf('cr-') === 0;
    const minSteps = isCustomRecipe ? 1 : 3;
    const maxSteps = isCustomRecipe ? Infinity : 6;
    if (!Array.isArray(r.steps) || r.steps.length < minSteps || r.steps.length > maxSteps) {
      errors.push(prefix + 'steps must be an array of ' + minSteps + (maxSteps === Infinity ? '+' : ('-' + maxSteps)) + ' entries (has ' + (Array.isArray(r.steps) ? r.steps.length : 0) + ')');
    }

    // coverage tallies (only meaningful once slot/styles are valid)
    if (slotValid && !r.occasional) {
      const slotsForCoverage = recipeSlotList(r);
      slotsForCoverage.forEach(function(slot){ coverage.bySlot[slot]++; });
      const hitsElenaAvoid = avoidValid && r.avoid.some(function (a) { return ELENA_AVOID.indexOf(a) !== -1; });
      if (stylesValid) {
        r.styles.forEach(function (st) {
          coverage.byStyle[st]++;
          slotsForCoverage.forEach(function(slot){
            coverage.byStyleSlot[slot][st]++;
            if (!hitsElenaAvoid) coverage.elenaBySlotStyle[slot][st]++;
          });
        });
      }
    }

    // task B2: a role:'side' recipe whose slots don't include 'side' is likely a tagging
    // slip (a side should be plannable as a side) — soft warning, not an error, since a
    // recipe can legitimately be role:'side' shape-wise while only ever surfaced via a
    // specific meal slot.
    if (r.role === 'side' && recipeSlotList(r).indexOf('side') === -1) {
      warnings.push(prefix + 'role is "side" but its slots ' + JSON.stringify(recipeSlotList(r)) + ' do not include "side" — possible tagging slip.');
    }

    // kcal-band check — only once foods.js is loaded. The strict per-slot band
    // (KCAL_BAND) only applies to role:'full' recipes — a composed main+side unit is what
    // must land in the slot band now, not the bare main or side component. role:'main'/
    // 'side' get their own, looser WARNING-only plausibility bands (ROLE_KCAL_BAND) instead.
    if (foodsLoaded && slotValid && !r.occasional && (r.role === 'full' ? KCAL_BAND[r.slot] : ROLE_KCAL_BAND[r.role])) {
      const m = recipeMacros(id);
      if (!m || !m.resolved) {
        warnings.push(prefix + 'could not compute macros (unresolved ingredient) — skipped kcal-band check.');
      } else if (r.role === 'full') {
        const band = KCAL_BAND[r.slot];
        if (m.kcal < band[0] || m.kcal > band[1]) {
          warnings.push(prefix + 'computed kcal ' + Math.round(m.kcal) + ' is outside the plausible band ' + band[0] + '-' + band[1] + ' for slot "' + r.slot + '".');
        }
      } else {
        const roleBand = ROLE_KCAL_BAND[r.role];
        if (m.kcal < roleBand[0] || m.kcal > roleBand[1]) {
          warnings.push(prefix + 'computed kcal ' + Math.round(m.kcal) + ' is outside the plausible band ' + roleBand[0] + '-' + roleBand[1] + ' for role "' + r.role + '".');
        }
      }
    }
  });

  // Slot minimums are hard requirements.
  VALID_SLOTS.forEach(function (slot) {
    if(slot === 'side') return;
    if (coverage.bySlot[slot] < SLOT_MIN[slot]) {
      errors.push('Slot "' + slot + '" has ' + coverage.bySlot[slot] + ' recipes, needs >= ' + SLOT_MIN[slot] + '.');
    }
  });

  // Per-style-per-main-slot minimum (>=5) is a soft target — flagged as a warning so a
  // slightly short DB isn't treated as broken, but is visible in the report.
  ['breakfast', 'lunch', 'dinner'].forEach(function (slot) {
    VALID_STYLES.forEach(function (st) {
      if (coverage.byStyleSlot[slot][st] < STYLE_SLOT_MIN) {
        warnings.push('Coverage gap: slot=' + slot + ' style=' + st + ' has ' + coverage.byStyleSlot[slot][st] + ' recipes (target >= ' + STYLE_SLOT_MIN + ').');
      }
    });
  });

  // With Elena's avoid-list applied, every main-slot x style combo should still have at
  // least one option, ideally a few.
  ['breakfast', 'lunch', 'dinner'].forEach(function (slot) {
    VALID_STYLES.forEach(function (st) {
      const n = coverage.elenaBySlotStyle[slot][st];
      if (n === 0) {
        errors.push('With Elena\'s avoid-list applied, slot=' + slot + ' style=' + st + ' has NO options left.');
      } else if (n < 2) {
        warnings.push('With Elena\'s avoid-list applied, slot=' + slot + ' style=' + st + ' has only ' + n + ' option(s) left.');
      }
    });
  });

  return { ok: errors.length === 0, errors: errors, warnings: warnings, coverage: coverage };
}
