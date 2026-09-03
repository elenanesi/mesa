/* ===================================================================
   recipes.js — Mesa recipe database (task B2)

   `RECIPES_DB` is keyed by kebab-case recipe id. NO kcal/protein/carb/fat
   fields live here — nutrition is always COMPUTED from `ingredients`
   against the food DB (see data/foods.js, task B1, and
   engine.js:recipeNutrition, task C1). Typing nutrition numbers in here
   would violate the ground rule "a recipe's nutrition is ALWAYS the sum
   of its ingredients — never typed in."

   Shape (see PWA-MVP-plan.md B2 for the authoritative contract):
     title   — display name
     emoji   — single emoji shown in menu/plan cards
     slot    — primary 'breakfast' | 'lunch' | 'dinner' | 'snack'
     slots   — optional array of slots this recipe can serve; defaults to [slot]
     occasional — optional true for honest-log treats / fast food that should
               remain searchable/loggable but not enter automatic week planning
     imageKey — optional kebab-case slug for assets/recipes/<imageKey>.png,
               used by the recipe detail hero when a recipe photo exists
     imageUri — optional safe relative URI (assets/recipes/<file>.png);
               preferred over imageKey for ad hoc recipe art such as pizza
     styles  — subset of ['balanced','highprotein','lowcarb']; which
               household plan styles this recipe can serve (can overlap)
     time    — prep+cook minutes
     ingredients — [[foodId, grams], ...] — >=2 entries, real quantities,
               summed for nutrition. Pieces (eggs, etc.) are still given
               in grams; foods.js carries an avgG convention for those.
     toTaste — pantry staples NOT counted in nutrition (herbs, a squeeze
               of lemon, a clove of garlic, oregano...). Convention: if
               an oil/dressing materially contributes calories, it goes
               into `ingredients` with real grams (we use a 5-10g olive
               oil entry for dressed dishes) rather than living here.
     steps   — 3-6 clear steps
     tags    — subset of: thyroid, skin, heart, muscle, lowGI, omega3,
               highFiber, quick, veggie
     avoid   — ingredient-level allergen/dislike keys this dish
               inherently contains, subset of: lactose, gluten,
               shellfish, nuts, spicy, raw-onion
     optionGroups — OPTIONAL (task D1, mains/full meals only), variants of a
               dish: [{key, label, choices: [{id, label, ingredients:
               [[foodId, grams], ...]}, ...]}, ...]. `ingredients` above
               stays the BASE (common) list shared by every choice; a
               recipe's EFFECTIVE ingredients = base + the chosen choice's
               ingredients per group (js/engine.js:recipeEffectiveIngredients,
               the single source nutrition/shopping/display/validation all
               read through). choices[0] (authored order, NOT sorted by id)
               is the deterministic default when no opts are given
               (js/engine.js:normalizeRecipeOpts). The planner rotates the
               choice per pick deterministically — see
               js/planner.js:chosenOptsForRecipe for the exact formula — and
               a choice with zero allowed options after a person's avoid-list
               is filtered out (js/planner.js:allowedChoicesForGroup); a
               group left with zero allowed choices drops the whole recipe
               from that candidate pool (js/planner.js:recipeOptionsViable).
               Display titles for a recipe with optionGroups append the
               chosen choice's label(s) in parens (js/render.js:
               recipeDisplayTitle), e.g. "Baked fish (sea bass)".

   The 10 mockup recipes (see app/js/state.js RECIPES) are migrated below
   under their EXACT original keys (yogurt, omelette, lentil, salmon,
   skyrbowl, eggsturkey, chickenfarro, chiapudding, tunasalad,
   salmongreens) so later wiring is a drop-in. Their ingredient lists are
   converted to [foodId, grams] preserving the original quantities
   (splitting a couple of "mixed X" combo lines into the closest B1
   foodIds — noted in the B2 task report, not here, to keep this file
   lean).
   =================================================================== */

const RECIPES_DB = {

  /* ================= BREAKFAST (11) ================= */

  // Generic "Yogurt bowl" (task: options recipes). Three optionGroups — Yogurt, Cereal, Fruit —
  // let the eater build yogurt+fruit, yogurt+cereal, or yogurt+cereal+fruit. Cereal and Fruit
  // each carry a "None" choice (empty ingredients = an explicit skip, validate.js). The base is
  // just a little maple syrup + chia; maple (not honey) keeps the soy-yogurt choice viable for a
  // vegan (honey trips the vegan filter, planner.js:245). Soy yogurt carries dietKeys
  // ['vegan','lactose-intolerant'] so the planner offers it only to a diet that needs it (keeps
  // generation for omnivores unchanged); the dairy choices are excluded by diet/avoid for those
  // people, leaving soy as the default by elimination. The recipe-screen default (render-recipe.js
  // dietAwareDefaultOpts) also treats a lactose AVOIDER as lactose-intolerant so their default is
  // soy; soy-yogurt is dairyFree so the lactose avoid-key never excludes it. Cereal is a CHOICE (not
  // the base) so recipe.avoid drops 'gluten' — a gluten avoider's cereal group filters down to
  // "None" (granola/muesli are gluten) and they get a cereal-free bowl instead of losing the recipe.
  yogurt: {
    title: 'Yogurt bowl', emoji: '🥣', slot: 'breakfast', role: 'full',
    season: 'evergreen',
    styles: ['balanced', 'highprotein'], time: 8,
    ingredients: [['maple-syrup', 8], ['chia-seeds', 6]],
    toTaste: [],
    steps: ['Spoon the yogurt into a bowl.', 'Add the cereal and fruit if using.', 'Finish with the chia seeds and a drizzle of maple syrup.'],
    tags: ['muscle'],
    avoid: [],
    optionGroups: [
      {
        key: 'yogurt', label: 'Yogurt',
        choices: [
          {id: 'greek', label: 'Greek yogurt', ingredients: [['greek-yogurt', 150]]},
          {id: 'skyr', label: 'Skyr', ingredients: [['skyr', 150]]},
          {id: 'soy', label: 'Soy yogurt', dietKeys: ['vegan', 'lactose-intolerant'], ingredients: [['soy-yogurt', 180]]}
        ]
      },
      {
        key: 'cereal', label: 'Cereal',
        choices: [
          {id: 'granola', label: 'Granola', ingredients: [['granola', 30]]},
          {id: 'muesli', label: 'Muesli', ingredients: [['muesli', 30]]},
          {id: 'none', label: 'No cereal', ingredients: []}
        ]
      },
      {
        key: 'fruit', label: 'Fruit',
        choices: [
          {id: 'berries', label: 'Berries', ingredients: [['mixed-berries', 100]]},
          {id: 'banana', label: 'Banana', ingredients: [['bananas', 80]]},
          {id: 'peach', label: 'Peach', ingredients: [['peaches', 100]]},
          {id: 'none', label: 'No fruit', ingredients: []}
        ]
      }
    ]
  },
  omelette: {
    title: 'Veggie omelette & rye toast', emoji: '🍳', slot: 'breakfast', role: 'full',
    styles: ['balanced', 'lowcarb'], time: 12,
    ingredients: [['eggs', 150], ['bell-pepper', 50], ['spinach', 30], ['rye-bread', 60], ['olive-oil', 5]],
    toTaste: ['herbs', 'black pepper'],
    steps: ['Whisk eggs; saute peppers and spinach in olive oil.', 'Pour eggs over the veg and cook gently until just set.', 'Toast the rye bread and plate alongside the omelette.'],
    tags: ['muscle', 'thyroid'],
    avoid: ['gluten']
  },
  eggsturkey: {
    title: 'Eggs, turkey, cheese & bread', emoji: '🍳', slot: 'breakfast', role: 'full',
    slots: ['breakfast', 'lunch'],
    styles: ['highprotein'], time: 10,
    ingredients: [['eggs', 100], ['turkey-breast', 80], ['scamorza', 30], ['olive-oil', 5]],
    toTaste: ['herbs', 'black pepper'],
    steps: ['Scramble or fry the eggs in olive oil.', 'Warm the turkey slices and scamorza briefly in the same pan until the cheese starts to melt.', 'Toast the bread and plate everything together.'],
    tags: ['muscle', 'thyroid'],
    avoid: ['gluten', 'lactose'],
    optionGroups: [
      {
        key: 'bread', label: 'Bread',
        choices: [
          {id: 'wholegrain', label: 'Wholegrain', ingredients: [['wholewheat-bread', 60]]},
          {id: 'white', label: 'White', ingredients: [['white-bread', 60]]}
        ]
      }
    ]
  },
  chiapudding: {
    // Panel recipe pass (2026-08-30): the old 150g coconut-milk carried ~32g saturated fat
    // (a whole day's WHO budget) in one breakfast and left it protein-thin. Rebased on soy
    // milk + soy yogurt for creaminess and real protein, with a whisper of coconut kept for
    // the name. MUST stay vegan + gluten-free (this is the vegan+GF starter breakfast) — soy,
    // chia, berries and coconut are all vegan/GF. sat fat 33 -> ~5, protein 9 -> ~14.
    title: 'Chia pudding, coconut & berries', emoji: '🍮', slot: 'breakfast', role: 'full',
    styles: ['balanced'], time: 5,
    ingredients: [['chia-seeds', 25], ['soy-milk', 170], ['soy-yogurt', 90], ['mixed-berries', 80], ['coconut-milk', 15]],
    toTaste: ['vanilla or cinnamon'],
    steps: ['Stir the chia seeds into the soy milk and yogurt and chill overnight.', 'Stir again before serving to loosen the texture.', 'Top with berries and a touch of vanilla or cinnamon.'],
    tags: ['lowGI', 'omega3', 'highFiber'],
    avoid: []
  },
  'oats-berries-walnuts': {
    title: 'Overnight oats, walnuts & berries', emoji: '🥣', slot: 'breakfast', role: 'full',
    season: 'winter/autumn',
    styles: ['balanced'], time: 5,
    ingredients: [['oats', 50], ['milk', 150], ['walnuts', 15], ['mixed-berries', 50], ['honey', 8]],
    toTaste: [],
    steps: ['Stir oats and milk together and chill overnight (or at least 20 min).', 'Stir again before serving to loosen the texture.', 'Top with walnuts, berries and a drizzle of honey.'],
    tags: ['heart', 'omega3', 'highFiber'],
    avoid: ['nuts', 'lactose']
  },
  // Two dairy-free balanced breakfasts (added 2026-07-22): the cream-cheese/scamorza edits
  // above plus turkey-spinach-omelette leaving breakfast dropped Elena's lactose-free
  // balanced breakfast pool to ~3 (and one of those is summer-only), which the weekly-cap
  // guard rightly flagged as forced repetition. These two are evergreen, milk/cheese-free,
  // and 'balanced' so they refill that rotation year-round.
  'porridge-banana-almond': {
    title: 'Porridge with banana & almonds', emoji: '🥣', slot: 'breakfast', role: 'full',
    season: 'winter/autumn',
    styles: ['balanced'], time: 8,
    ingredients: [['oats', 50], ['bananas', 100], ['apples', 60], ['almonds', 12], ['honey', 6]],
    toTaste: ['cinnamon'],
    steps: ['Simmer the oats in water until creamy, 5-6 min.', 'Slice the banana and grate or dice the apple.', 'Top the porridge with the fruit, almonds, a drizzle of honey and a pinch of cinnamon.'],
    tags: ['heart', 'highFiber'],
    avoid: ['nuts']
  },
  'scrambled-eggs-tomato-toast': {
    title: 'Scrambled eggs, tomato & toast', emoji: '🍳', slot: 'breakfast', role: 'full',
    season: 'evergreen',
    styles: ['balanced', 'highprotein'], time: 10,
    ingredients: [['eggs', 120], ['cherry-tomatoes', 100], ['wholewheat-bread', 60], ['olive-oil', 6]],
    toTaste: ['herbs', 'black pepper'],
    steps: ['Toast the bread.', 'Soft-scramble the eggs in olive oil.', 'Halve the cherry tomatoes and serve alongside the eggs on toast.'],
    tags: ['muscle', 'quick'],
    avoid: ['gluten']
  },
  'avocado-eggs': {
    title: 'Eggs & avocado', emoji: '🥑', slot: 'breakfast', role: 'main',
    styles: ['lowcarb', 'highprotein'], time: 10,
    ingredients: [['eggs', 100], ['avocado', 70], ['cherry-tomatoes', 60], ['olive-oil', 5]],
    toTaste: ['lemon', 'black pepper'],
    steps: ['Soft-boil or fry the eggs.', 'Slice the avocado and halve the tomatoes.', 'Plate together, finish with olive oil, a squeeze of lemon and black pepper.'],
    tags: ['muscle', 'heart', 'lowGI'],
    avoid: []
  },
  shakshuka: {
    title: 'Shakshuka', emoji: '🍳', slot: 'breakfast', role: 'main',
    imageKey: 'shakshuka',
    styles: ['balanced', 'lowcarb'], time: 20,
    ingredients: [['eggs', 150], ['tomatoes', 150], ['bell-pepper', 80], ['red-onion', 40], ['olive-oil', 10]],
    toTaste: ['garlic', 'paprika', 'herbs'],
    steps: ['Soften onion and peppers in olive oil until fragrant.', 'Add the chopped tomatoes and garlic, simmer 8-10 min to thicken.', 'Make wells in the sauce and crack in the three eggs; cover and cook until just set.', 'Finish with herbs and serve straight from the pan.'],
    tags: ['veggie', 'lowGI', 'heart'],
    avoid: []
  },
  'veg-frittata': {
    title: 'Roast veg frittata', emoji: '🍳', slot: 'breakfast', role: 'main',
    styles: ['balanced', 'highprotein'], time: 18,
    ingredients: [['eggs', 150], ['courgette', 60], ['bell-pepper', 60], ['parmesan', 20], ['olive-oil', 5]],
    toTaste: ['herbs'],
    steps: ['Saute courgette and peppers in olive oil until tender.', 'Whisk eggs with grated parmesan and pour over the veg.', 'Cook gently on low heat until mostly set, then finish under the grill.', 'Rest 2 minutes, slice and serve.'],
    tags: ['muscle', 'veggie', 'heart'],
    avoid: ['lactose']
  },
  'almond-skyr-bowl': {
    title: 'Skyr, almonds & chia', emoji: '🥣', slot: 'breakfast', role: 'main',
    styles: ['lowcarb', 'highprotein'], time: 5,
    ingredients: [['skyr', 200], ['almonds', 25], ['chia-seeds', 10]],
    toTaste: [],
    steps: ['Spoon skyr into a bowl.', 'Scatter almonds and chia seeds on top.', 'Serve straight away.'],
    tags: ['muscle', 'lowGI'],
    avoid: ['lactose', 'nuts']
  },
  'turkey-spinach-omelette': {
    title: 'Turkey & spinach omelette', emoji: '🍳', slot: 'lunch', role: 'main',
    slots: ['lunch'],
    styles: ['balanced', 'highprotein'], time: 12,
    ingredients: [['eggs', 150], ['turkey-breast', 60], ['spinach', 40], ['olive-oil', 5]],
    toTaste: ['herbs', 'black pepper'],
    steps: ['Wilt spinach briefly in olive oil.', 'Whisk eggs and add the turkey and spinach.', 'Pour into the pan and cook gently until just set.', 'Fold and plate.'],
    tags: ['muscle', 'thyroid'],
    avoid: []
  },

  /* ================= VEGAN breakfasts (multi-select diets batch) =================
     Measured gap: with the real vegan filter (planner.js:recipeViolatesDiet — no meat,
     poultry, fish, dairy, eggs OR honey), only 'chiapudding' above qualified for
     breakfast. These six bring the vegan breakfast pool to 7 (target: >=6), all
     'evergreen' season so they count toward every season, Mediterranean-leaning
     ingredients, kcal computed from data/foods.js ingredients per the ground rule. */
  'tofu-scramble-spinach-tomato': {
    title: 'Tofu scramble, spinach & tomatoes', emoji: '🍳', slot: 'breakfast', role: 'full',
    season: 'evergreen',
    styles: ['balanced', 'highprotein'], time: 12,
    ingredients: [['tofu', 150], ['spinach', 60], ['cherry-tomatoes', 80], ['olive-oil', 8], ['rye-bread', 40]],
    toTaste: ['turmeric', 'smoked paprika', 'chilli flakes', 'black pepper'],
    steps: ['Crumble the tofu into a hot pan with olive oil, turmeric and smoked paprika.', 'Add spinach and cherry tomatoes, cook 4-5 min until the spinach wilts.', 'Season with chilli and serve with the rye toast.'],
    tags: ['veggie', 'highFiber'],
    avoid: ['gluten']
  },
  'overnight-oats-banana-peanut-butter': {
    title: 'Overnight oats, banana & peanut butter', emoji: '🥣', slot: 'breakfast', role: 'full',
    season: 'evergreen',
    styles: ['balanced'], time: 5,
    ingredients: [['oats', 45], ['soy-milk', 150], ['bananas', 80], ['peanut-butter', 15], ['chia-seeds', 8]],
    toTaste: ['cinnamon'],
    steps: ['Stir oats, soy milk and chia seeds together and chill overnight (or at least 20 min).', 'Stir again before serving to loosen the texture.', 'Top with sliced banana and a spoon of peanut butter.'],
    tags: ['veggie', 'highFiber'],
    avoid: ['gluten']
  },
  'coconut-chia-pudding-peach': {
    // Panel recipe pass (2026-08-30): same coconut-milk saturated-fat fix as chiapudding
    // (was ~25g sat fat, P7). Soy base adds protein; ripe peach carries the sweetness so the
    // maple syrup becomes an optional drizzle (free sugars -> 0). Kept vegan + gluten-free.
    title: 'Coconut chia pudding, peach', emoji: '🍮', slot: 'breakfast', role: 'full',
    season: 'evergreen',
    styles: ['balanced'], time: 5,
    ingredients: [['chia-seeds', 20], ['soy-milk', 150], ['soy-yogurt', 70], ['peaches', 120], ['coconut-milk', 20]],
    toTaste: ['vanilla', 'a drizzle of maple syrup (optional)'],
    steps: ['Stir the chia seeds into the soy milk and yogurt and chill overnight.', 'Stir again before serving to loosen the texture.', 'Top with sliced peach and a little vanilla.'],
    tags: ['lowGI', 'veggie', 'omega3'],
    avoid: []
  },
  'quinoa-breakfast-bowl-apple-walnut': {
    title: 'Quinoa breakfast bowl, apple & walnuts', emoji: '🥣', slot: 'breakfast', role: 'full',
    season: 'winter/autumn',
    styles: ['balanced'], time: 15,
    ingredients: [['quinoa-dry', 45], ['soy-milk', 150], ['apples', 100], ['walnuts', 15], ['maple-syrup', 8]],
    toTaste: ['cinnamon'],
    steps: ['Simmer the quinoa in the soy milk until soft and creamy, about 12 min.', 'Dice the apple.', 'Top the quinoa with apple, walnuts and a drizzle of maple syrup.'],
    tags: ['veggie', 'highFiber'],
    avoid: ['nuts']
  },
  'avocado-tomato-toast': {
    title: 'Avocado & tomato toast', emoji: '🥑', slot: 'breakfast', role: 'full',
    season: 'evergreen',
    styles: ['balanced', 'lowcarb'], time: 8,
    ingredients: [['white-bread', 70], ['avocado', 80], ['cherry-tomatoes', 60], ['lemon', 5], ['olive-oil', 5]],
    toTaste: ['black pepper', 'chilli flakes'],
    steps: ['Toast the bread.', 'Mash the avocado with lemon juice and olive oil.', 'Spread over the toast and top with halved cherry tomatoes.'],
    tags: ['veggie', 'lowGI'],
    avoid: ['gluten']
  },

  /* ================= LUNCH (10) ================= */

  lentil: {
    title: 'Lentil & roasted veg salad', emoji: '🥗', slot: 'lunch', role: 'full',
    slots: ['lunch', 'dinner'],
    styles: ['balanced'], time: 20,
    ingredients: [['cooked-lentils', 150], ['courgette', 75], ['bell-pepper', 75], ['feta-cheese', 40], ['rocket-arugula', 20], ['olive-oil', 10]],
    toTaste: ['lemon'],
    steps: ['Roast courgette and peppers until tender.', 'Toss the warm roasted veg with the lentils.', 'Crumble feta over the top.', 'Add rocket and dress with olive oil & lemon just before serving.'],
    tags: ['heart', 'highFiber', 'veggie'],
    avoid: ['lactose']
  },
  chickenfarro: {
    title: 'Chicken & farro bowl', emoji: '🍲', slot: 'lunch', role: 'full',
    slots: ['lunch', 'dinner'],
    styles: ['highprotein'], time: 22,
    ingredients: [['chicken-breast', 150], ['farro-cooked', 120], ['courgette', 50], ['bell-pepper', 50], ['olive-oil', 5]],
    toTaste: ['lemon'],
    steps: ['Grill or pan-sear the chicken until cooked through.', 'Toss warm farro with roasted veg.', 'Slice chicken over the bowl and dress with olive oil & lemon.'],
    tags: ['muscle', 'highFiber'],
    avoid: ['gluten']
  },
  tunasalad: {
    title: 'Tuna & avocado chopped salad', emoji: '🥗', slot: 'lunch', role: 'full',
    slots: ['lunch', 'dinner'],
    styles: ['lowcarb', 'highprotein'], time: 12,
    ingredients: [['tuna-in-olive-oil', 120], ['avocado', 80], ['cherry-tomatoes', 100], ['cucumber', 50], ['olive-oil', 5]],
    toTaste: ['lemon'],
    steps: ['Chop tomatoes, cucumber and avocado.', 'Flake the tuna over the top.', 'Dress with olive oil and lemon just before serving.'],
    tags: ['muscle', 'omega3', 'heart'],
    avoid: []
  },
  'chicken-couscous-salad': {
    title: 'Chicken & couscous salad', emoji: '🥗', slot: 'lunch', role: 'full',
    slots: ['lunch', 'dinner'],
    styles: ['balanced', 'highprotein'], time: 20,
    ingredients: [['chicken-breast', 130], ['couscous', 80], ['cherry-tomatoes', 80], ['cucumber', 60], ['olive-oil', 5]],
    toTaste: ['lemon', 'herbs'],
    steps: ['Cook couscous per pack instructions and fluff with a fork.', 'Grill or pan-sear the chicken until cooked through, then slice.', 'Toss couscous with tomatoes and cucumber.', 'Top with chicken, olive oil, lemon and herbs.'],
    tags: ['muscle', 'heart'],
    avoid: ['gluten']
  },
  'prawn-courgette-salad': {
    title: 'Prawn & courgette salad', emoji: '🦐', slot: 'lunch', role: 'full',
    styles: ['lowcarb', 'highprotein'], time: 15,
    ingredients: [['prawns', 180], ['courgette', 150], ['cherry-tomatoes', 60], ['avocado', 80], ['olive-oil', 12]],
    toTaste: ['lemon', 'garlic'],
    steps: ['Ribbon the courgette with a peeler.', 'Pan-sear the prawns with garlic until pink, 2-3 min.', 'Toss courgette ribbons with tomatoes, sliced avocado and olive oil.', 'Top with the warm prawns and a squeeze of lemon.'],
    tags: ['muscle', 'lowGI'],
    avoid: ['shellfish']
  },
  'tuna-white-bean-salad': {
    title: 'Tuna & white bean salad', emoji: '🐟', slot: 'lunch', role: 'full',
    slots: ['lunch', 'dinner'],
    styles: ['balanced', 'highprotein'], time: 10,
    ingredients: [['tuna-in-olive-oil', 120], ['cannellini-beans', 100], ['rocket-arugula', 30], ['cherry-tomatoes', 60], ['olive-oil', 5]],
    toTaste: ['lemon'],
    steps: ['Drain and rinse the white beans.', 'Toss beans with rocket and tomatoes.', 'Flake the tuna over the top.', 'Dress with olive oil and lemon.'],
    tags: ['thyroid', 'omega3', 'heart', 'highFiber'],
    avoid: []
  },
  'greek-salad-big': {
    // Panel recipe pass (2026-08-30): was lopsided (sat 13 from 70g feta, protein 13, fibre 4,
    // no anchor). Feta trimmed to 45g and chickpeas add a protein + fibre spine (Mediterranean-
    // authentic). No longer low-carb, so styles -> balanced only (lunch/dinner low-carb pools
    // still have 23+ options each). sat 13 -> ~9, protein 13 -> ~18, fibre 4 -> ~11.
    title: 'Big Greek salad', emoji: '🥗', slot: 'lunch', role: 'full',
    slots: ['lunch', 'dinner', 'side'],
    styles: ['balanced'], time: 10,
    ingredients: [['cucumber', 100], ['cherry-tomatoes', 100], ['bell-pepper', 60], ['feta-cheese', 45], ['olives', 30], ['chickpeas', 100], ['olive-oil', 10]],
    toTaste: ['oregano', 'lemon'],
    steps: ['Chop the cucumber, tomatoes and peppers into chunks.', 'Add the chickpeas and olives, and crumble the feta over the top.', 'Dress with olive oil, oregano and lemon just before serving.'],
    tags: ['veggie', 'heart', 'highFiber'],
    avoid: ['lactose']
  },
  'chicken-caprese-salad': {
    title: 'Chicken caprese salad', emoji: '🥗', slot: 'lunch', role: 'full',
    slots: ['lunch', 'dinner'],
    styles: ['lowcarb', 'highprotein'], time: 15,
    ingredients: [['chicken-breast', 130], ['mozzarella', 60], ['cherry-tomatoes', 100], ['rocket-arugula', 20], ['olive-oil', 10]],
    toTaste: ['basil'],
    steps: ['Grill or pan-sear the chicken until cooked through, then slice.', 'Slice the mozzarella and halve the tomatoes.', 'Layer chicken, mozzarella, tomatoes and rocket.', 'Finish with olive oil and torn basil.'],
    tags: ['muscle', 'lowGI'],
    avoid: ['lactose']
  },
  'tuna-egg-salad': {
    title: 'Tuna & egg salad', emoji: '🥗', slot: 'lunch', role: 'full',
    slots: ['lunch', 'dinner'],
    styles: ['lowcarb', 'highprotein'], time: 12,
    ingredients: [['tuna-in-olive-oil', 100], ['eggs', 100], ['cucumber', 80], ['cherry-tomatoes', 80], ['olive-oil', 5]],
    toTaste: ['lemon'],
    steps: ['Hard-boil the eggs (8-9 min), cool and quarter.', 'Chop cucumber and tomatoes.', 'Flake the tuna over the veg and top with the eggs.', 'Dress with olive oil and lemon.'],
    tags: ['muscle', 'omega3'],
    avoid: []
  },

  /* ================= DINNER (9) ================= */

  'chicken-sweet-potato-broccoli': {
    title: 'Roast chicken, sweet potato & broccoli', emoji: '🍗', slot: 'dinner', role: 'full',
    slots: ['dinner'],
    styles: ['balanced', 'highprotein'], time: 35,
    ingredients: [['chicken-breast', 180], ['sweet-potato', 200], ['broccoli', 100], ['olive-oil', 10]],
    toTaste: ['herbs', 'lemon'],
    steps: ['Cube sweet potato, toss in olive oil and roast at 200C for 25 min.', 'Season chicken and roast or pan-sear until cooked through.', 'Steam the broccoli in the last 5 minutes.', 'Plate together and finish with herbs and a squeeze of lemon.'],
    tags: ['muscle', 'heart'],
    avoid: []
  },
  'turkey-roasted-veg': {
    title: 'Turkey & roasted veg', emoji: '🍗', slot: 'dinner', role: 'main',
    slots: ['dinner', 'lunch'],
    styles: ['lowcarb', 'highprotein'], time: 30,
    ingredients: [['turkey-breast', 220], ['courgette', 150], ['bell-pepper', 100], ['olive-oil', 15]],
    toTaste: ['herbs', 'lemon'],
    steps: ['Toss courgette and peppers in olive oil and roast at 200C for 20 min.', 'Season the turkey breast and pan-sear or roast until cooked through.', 'Slice the turkey and plate with the roasted veg.', 'Finish with herbs and a squeeze of lemon.'],
    tags: ['muscle', 'lowGI'],
    avoid: []
  },
  'chickpea-veg-stew': {
    title: 'Chickpea & vegetable stew', emoji: '🍲', slot: 'dinner', role: 'full',
    slots: ['dinner', 'lunch', 'side'],
    styles: ['balanced'], time: 30,
    ingredients: [['chickpeas', 200], ['tomatoes', 150], ['courgette', 80], ['bell-pepper', 80], ['olive-oil', 10]],
    toTaste: ['garlic', 'cumin'],
    steps: ['Saute courgette and peppers in olive oil until softened.', 'Add garlic, the chopped tomatoes and chickpeas; simmer 15-20 min.', 'Season with cumin to taste.', 'Serve warm, on its own or with crusty bread.'],
    tags: ['veggie', 'highFiber', 'heart'],
    avoid: []
  },
  'baked-cod-greens': {
    // Panel recipe pass (2026-08-30): chef adds a briny caper hit (~4 kcal, big umami lift) so
    // the lean cod has a savoury hook; rename to sell the lemon-caper greens.
    title: 'Baked cod, lemon-caper greens', emoji: '🐟', slot: 'dinner', role: 'main',
    slots: ['dinner', 'lunch', 'side'],
    styles: ['balanced', 'highprotein', 'lowcarb'], time: 25,
    ingredients: [['cod', 220], ['broccoli', 200], ['spinach', 80], ['capers', 10], ['olive-oil', 15]],
    toTaste: ['lemon', 'garlic', 'chilli flakes', 'parsley'],
    steps: ['Rub the cod with olive oil, lemon and garlic; bake at 200C for 12-15 min.', 'Char the broccoli in a hot pan.', 'Wilt the spinach with the capers and a pinch of chilli.', 'Plate the greens with the cod on top, finished with lemon and parsley.'],
    tags: ['thyroid', 'muscle', 'lowGI'],
    avoid: []
  },
  'pork-loin-farro-veg': {
    title: 'Pork loin, farro & greens', emoji: '🍖', slot: 'dinner', role: 'full',
    slots: ['dinner', 'lunch'],
    styles: ['balanced', 'highprotein'], time: 30,
    ingredients: [['pork-loin', 150], ['farro-cooked', 150], ['spinach', 60], ['olive-oil', 8]],
    toTaste: ['garlic', 'herbs'],
    steps: ['Season the pork loin and pan-sear or roast until cooked through.', 'Warm the farro through.', 'Wilt the spinach with garlic in olive oil.', 'Slice the pork and plate over the farro and greens.'],
    tags: ['muscle'],
    avoid: ['gluten']
  },

  /* ================= ELENA RECIPE WISHLIST — BREAKFAST ================= */

  'french-toast-fruit-maple': {
    title: 'French toast with fruit & maple syrup', emoji: '🍞', slot: 'breakfast', role: 'full',
    imageKey: 'french-toast',
    styles: ['balanced'], time: 15,
    // task D2: mixed-berries moved out of the base list into optionGroups.fruit's default
    // choice (choices[0] = 'berries') so the base stays common to every fruit choice; the
    // no-opts effective ingredient list is base.concat(choices[0].ingredients), same bag of
    // [foodId, grams] pairs as the original array (order differs, sum doesn't) — see
    // tools/check.js's testFrenchToastOptionsPreserveOriginalNutrition for the exact
    // pre-D2 kcal/protein/carbs/fat/fiber/sugars totals asserted unchanged.
    ingredients: [['white-bread', 70], ['eggs', 50], ['milk', 80], ['maple-syrup', 15], ['olive-oil', 4]],
    toTaste: ['cinnamon', 'vanilla'],
    steps: ['Whisk egg, milk, cinnamon and vanilla.', 'Dip the bread and cook in a lightly oiled pan until golden.', 'Top with fruit and maple syrup.'],
    tags: ['quick'],
    avoid: ['gluten', 'lactose'],
    optionGroups: [
      {
        key: 'fruit', label: 'Fruit',
        choices: [
          {id: 'berries', label: 'Mixed berries', ingredients: [['mixed-berries', 80]]},
          {id: 'banana', label: 'Banana', ingredients: [['bananas', 80]]},
          {id: 'peach', label: 'Peach', ingredients: [['peaches', 80]]}
        ]
      }
    ]
  },
  pancakes: {
    title: 'Pancakes', emoji: '🥞', slot: 'breakfast', role: 'full',
    imageKey: 'pancakes',
    styles: ['balanced'], time: 18,
    ingredients: [['oats', 45], ['eggs', 50], ['milk', 100], ['bananas', 60], ['maple-syrup', 15], ['olive-oil', 4]],
    toTaste: ['cinnamon'],
    steps: ['Blend oats, egg, milk and banana into a batter.', 'Cook small pancakes in a lightly oiled pan.', 'Serve with maple syrup.'],
    tags: [],
    avoid: ['gluten', 'lactose']
  },
  'pancakes-proteici': {
    title: 'Protein pancakes', emoji: '🥞', slot: 'breakfast', role: 'full',
    imageKey: 'pancakes',
    styles: ['balanced', 'highprotein'], time: 18,
    ingredients: [['oats', 40], ['whey-protein-powder', 30], ['eggs', 50], ['milk', 90], ['chocolate-hazelnut-spread', 12], ['bananas', 70], ['mixed-berries', 50], ['olive-oil', 3]],
    toTaste: ['cinnamon'],
    steps: ['Blend oat flour, protein powder, egg and milk into a smooth batter.', 'Cook small pancakes in a lightly oiled pan until golden on both sides.', 'Spread a thin veil of Nutella on top.', 'Finish with sliced banana and blueberries or mixed berries.'],
    tags: ['muscle'],
    avoid: ['gluten', 'lactose', 'nuts']
  },
  cereali: {
    title: 'Cereal bowl', emoji: '🥣', slot: 'breakfast', role: 'full',
    styles: ['balanced'], time: 3,
    ingredients: [['granola', 45], ['milk', 180], ['bananas', 70]],
    toTaste: [],
    steps: ['Pour cereal into a bowl.', 'Add milk.', 'Slice banana on top.'],
    tags: ['quick'],
    avoid: ['gluten', 'lactose']
  },
  'uova-bacon': {
    title: 'Eggs, bacon, avocado & beans on toast', emoji: '🍳', slot: 'breakfast', role: 'full',
    slots: ['breakfast', 'lunch'],
    styles: ['highprotein', 'lowcarb'], time: 15,
    ingredients: [['eggs', 100], ['bacon', 35], ['cherry-tomatoes', 80], ['wholewheat-bread', 50], ['avocado', 50], ['cannellini-beans', 80]],
    toTaste: ['black pepper'],
    steps: ['Cook the bacon until crisp.', 'Toast the bread and mash the avocado on top.', 'Fry or scramble the eggs and warm the cannellini beans through.', 'Plate everything together with the cherry tomatoes on the side.'],
    tags: ['muscle', 'quick'],
    avoid: ['gluten']
  },
  'uova-avocado-toast': {
    title: 'Egg & avocado toast', emoji: '🥑', slot: 'breakfast', role: 'full',
    imageKey: 'uova-avocado-toast',
    slots: ['breakfast', 'lunch'],
    styles: ['balanced', 'highprotein'], time: 12,
    ingredients: [['wholewheat-bread', 70], ['eggs', 100], ['avocado', 70], ['cherry-tomatoes', 60], ['cream-cheese', 20]],
    toTaste: ['lemon', 'black pepper', 'lime', 'pink pepper'],
    steps: ['Toast the bread and spread with cream cheese.', 'Mash avocado with lemon and black pepper.', 'Top the toast with mashed avocado, eggs and tomatoes.', 'Finish with a squeeze of lime and a pinch of pink pepper.'],
    tags: ['heart', 'highFiber', 'muscle'],
    avoid: ['gluten', 'lactose']
  },
  'ricotta-pere-noci-toast': {
    title: 'Ricotta, pear & walnut toast', emoji: '🍐', slot: 'breakfast', role: 'full',
    imageKey: 'ricotta-pere-noci-toast',
    styles: ['balanced'], time: 8,
    ingredients: [['wholewheat-bread', 70], ['ricotta', 80], ['pears', 90], ['walnuts', 15], ['honey', 6]],
    toTaste: ['black pepper'],
    steps: ['Toast the bread.', 'Spread ricotta on top.', 'Add sliced pear, walnuts and a little honey.'],
    tags: ['highFiber'],
    avoid: ['gluten', 'lactose', 'nuts']
  },

  /* ================= ELENA RECIPE WISHLIST — LUNCH ================= */

  'insalata-pesche-feta': {
    // Panel recipe pass (2026-08-30): protein 15 / fibre 4 / sat 13 -> chickpeas add the
    // protein+fibre anchor; still a bright summer salad (chickpea + peach + feta is a real
    // combo). No longer low-carb -> styles balanced only.
    title: 'Peach, feta & chickpea salad', emoji: '🥗', slot: 'lunch', role: 'full',
    season: 'spring/summer',
    slots: ['lunch', 'dinner'],
    styles: ['balanced'], time: 10,
    ingredients: [['peaches', 150], ['feta-cheese', 50], ['rocket-arugula', 50], ['walnuts', 15], ['chickpeas', 80], ['olive-oil', 8]],
    toTaste: ['lemon', 'black pepper'],
    steps: ['Slice the peaches and pile over the rocket with the chickpeas.', 'Crumble the feta on top.', 'Add the walnuts and dress with olive oil, lemon and black pepper.'],
    tags: ['veggie', 'highFiber'],
    avoid: ['lactose', 'nuts']
  },
  'insalata-greca-pizza-bianca': {
    title: 'Greek salad with white pizza bread', emoji: '🥗', slot: 'lunch', role: 'full',
    season: 'spring/summer',
    styles: ['balanced'], time: 10,
    ingredients: [['cucumber', 100], ['cherry-tomatoes', 120], ['feta-cheese', 60], ['olives', 30], ['pizza-bianca', 80], ['olive-oil', 8]],
    toTaste: ['oregano'],
    steps: ['Chop cucumber and tomatoes.', 'Add feta and olives.', 'Serve with pizza bianca on the side.'],
    tags: ['veggie', 'quick'],
    avoid: ['gluten', 'lactose']
  },
  'bowl-insalata': {
    title: 'Chicken salad bowl', emoji: '🥗', slot: 'lunch', role: 'full',
    season: 'spring/summer',
    styles: ['balanced', 'highprotein'], time: 12,
    ingredients: [['chicken-breast', 120], ['lettuce', 80], ['chickpeas', 90], ['cucumber', 80], ['cherry-tomatoes', 80], ['olive-oil', 8]],
    toTaste: ['lemon'],
    steps: ['Fill a bowl with lettuce, cucumber and tomatoes.', 'Add chickpeas and sliced chicken.', 'Dress with olive oil and lemon.'],
    tags: ['muscle', 'highFiber'],
    avoid: []
  },
  'toast-eatsmiter': {
    title: 'Turkey, mozzarella & tomato toastie', emoji: '🥪', slot: 'lunch', role: 'full',
    styles: ['balanced'], time: 8,
    ingredients: [['wholewheat-bread', 90], ['turkey-breast', 70], ['mozzarella', 45], ['cherry-tomatoes', 50]],
    toTaste: ['mustard'],
    steps: ['Fill bread with turkey, mozzarella and tomato.', 'Toast until warm and crisp.', 'Add mustard to taste.'],
    tags: ['quick', 'muscle'],
    avoid: ['gluten', 'lactose']
  },
  'club-sandwich': {
    title: 'Club sandwich', emoji: '🥪', slot: 'lunch', role: 'full',
    imageKey: 'club-sandwich',
    styles: ['balanced', 'highprotein'], time: 15,
    ingredients: [['white-bread', 90], ['chicken-breast', 100], ['bacon', 25], ['lettuce', 30], ['cherry-tomatoes', 50]],
    toTaste: ['mustard'],
    steps: ['Toast the bread.', 'Layer chicken, bacon, lettuce and tomato.', 'Slice and serve.'],
    tags: ['muscle', 'quick'],
    avoid: ['gluten']
  },
  'uova-pomodoro': {
    title: 'Eggs in tomato sauce', emoji: '🍳', slot: 'lunch', role: 'full',
    season: 'spring/summer',
    slots: ['lunch', 'breakfast'],
    styles: ['balanced', 'lowcarb'], time: 15,
    ingredients: [['eggs', 150], ['tomatoes', 180], ['olive-oil', 8], ['wholewheat-bread', 50]],
    toTaste: ['basil', 'black pepper'],
    steps: ['Simmer tomatoes with olive oil until saucy.', 'Crack in eggs and cover until set.', 'Serve with toast.'],
    tags: ['veggie'],
    avoid: ['gluten']
  },
  'panino-gorgonzola-prosciutto': {
    title: 'Gorgonzola & ham sandwich', emoji: '🥪', slot: 'lunch', role: 'full',
    styles: ['balanced'], time: 7,
    ingredients: [['white-bread', 90], ['gorgonzola', 45], ['prosciutto-cotto', 60], ['rocket-arugula', 20]],
    toTaste: [],
    steps: ['Slice the bread.', 'Fill with gorgonzola, prosciutto and rocket.', 'Toast if wanted.'],
    tags: ['quick'],
    avoid: ['gluten', 'lactose']
  },
  'insalata-noci-mele-senape': {
    // Panel recipe pass (2026-08-30): protein 10, fat 36 (30g walnuts). Walnuts cut to 20g,
    // chickpeas add the protein+fibre anchor. Also flagged gluten honestly (it contains
    // wholewheat bread croutons). protein 10 -> ~16, fat 36 -> ~26.
    title: 'Apple, walnut & mustard salad', emoji: '🥗', slot: 'lunch', role: 'full',
    season: 'winter/autumn',
    slots: ['lunch', 'side'],
    styles: ['balanced'], time: 10,
    ingredients: [['lettuce', 90], ['apples', 120], ['walnuts', 20], ['mustard', 8], ['chickpeas', 90], ['olive-oil', 10], ['wholewheat-bread', 30]],
    toTaste: ['lemon'],
    steps: ['Slice the apple and toss with the lettuce and chickpeas.', 'Add the walnuts and torn wholewheat croutons.', 'Dress with mustard, olive oil and lemon.'],
    tags: ['veggie', 'highFiber', 'quick'],
    avoid: ['nuts', 'gluten']
  },
  'couscous-legumi-limone': {
    title: 'Chickpea couscous salad with lemon', emoji: '🥗', slot: 'lunch', role: 'full',
    season: 'spring/summer',
    slots: ['lunch', 'dinner'],
    styles: ['balanced'], time: 18,
    ingredients: [['couscous', 70], ['chickpeas', 100], ['cherry-tomatoes', 90], ['cucumber', 80], ['red-onion', 20], ['rocket-arugula', 25], ['olive-oil', 8]],
    toTaste: ['lemon', 'parsley'],
    steps: ['Cook couscous and fluff it.', 'Toss with chickpeas, tomatoes, cucumber, onion and rocket.', 'Dress with olive oil and lemon.'],
    tags: ['veggie', 'highFiber'],
    avoid: ['gluten', 'raw-onion']
  },
  'pomodori-al-riso': {
    title: 'Rice-stuffed tomatoes', emoji: '🍅', slot: 'lunch', role: 'full',
    imageKey: 'pomodori-al-riso',
    season: 'spring/summer',
    slots: ['lunch', 'dinner'],
    styles: ['balanced'], time: 55,
    // Panel recipe pass (2026-08-30): was carb-on-carb (rice + 180g potato) with protein only 11.
    // Redundant potato cut to 120g and pecorino folded into the rice filling (traditional in the
    // Roman version) for a real protein bump. protein 11 -> ~16. Adds lactose (pecorino).
    ingredients: [['tomatoes', 280], ['rice', 55], ['potatoes', 120], ['pecorino', 20], ['olive-oil', 12]],
    toTaste: ['basil', 'garlic', 'oregano'],
    steps: ['Hollow the tomatoes and mix the pulp with the rice, grated pecorino, herbs and oil.', 'Fill the tomatoes and place the potatoes around them.', 'Bake until the rice and potatoes are tender.'],
    tags: ['veggie'],
    avoid: ['lactose']
  },

  /* ================= ELENA RECIPE WISHLIST — DINNER ================= */

  'pollo-bollito-brodo': {
    title: 'Boiled chicken in broth', emoji: '🍗', slot: 'dinner', role: 'main',
    imageKey: 'boiled-chicken-broth',
    styles: ['highprotein', 'lowcarb'], time: 45,
    ingredients: [['chicken-breast', 190], ['carrots', 120], ['escarole', 100], ['olive-oil', 8]],
    toTaste: ['celery', 'onion', 'parsley'],
    steps: ['Simmer chicken with vegetables until tender.', 'Shred the chicken.', 'Serve in broth with greens and a little olive oil.'],
    tags: ['muscle'],
    avoid: []
  },
  'pollo-al-forno': {
    title: 'Roast chicken', emoji: '🍗', slot: 'dinner', role: 'full',
    imageKey: 'meat-main',
    styles: ['balanced', 'highprotein'], time: 40,
    ingredients: [['chicken-thigh', 180], ['potatoes', 220], ['carrots', 120], ['olive-oil', 12]],
    toTaste: ['rosemary', 'garlic', 'lemon'],
    steps: ['Season chicken, potatoes and carrots.', 'Roast at 200C until golden and cooked through.', 'Finish with lemon.'],
    tags: ['muscle'],
    avoid: []
  },
  'chicken-satay': {
    title: 'Chicken satay', emoji: '🍢', slot: 'dinner', role: 'full',
    styles: ['balanced', 'highprotein'], time: 25,
    ingredients: [['chicken-breast', 170], ['almonds', 20], ['soy-sauce', 10], ['rice', 60], ['cucumber', 80]],
    toTaste: ['lime', 'ginger', 'chilli if wanted'],
    steps: ['Marinate chicken with soy sauce and ginger.', 'Cook chicken skewers until done.', 'Serve with rice, cucumber and crushed almonds as a satay-style topping.'],
    tags: ['muscle'],
    avoid: ['nuts']
  },
  'soy-ginger-chicken': {
    title: 'Soy ginger chicken', emoji: '🍗', slot: 'dinner', role: 'full',
    styles: ['balanced', 'highprotein'], time: 25,
    ingredients: [['chicken-breast', 170], ['soy-sauce', 15], ['ginger', 8], ['broccoli', 160], ['rice', 60], ['olive-oil', 6]],
    toTaste: ['garlic'],
    steps: ['Marinate chicken with soy sauce, ginger and garlic.', 'Stir-fry chicken until cooked.', 'Serve with broccoli and rice.'],
    tags: ['muscle'],
    avoid: []
  },
  'butter-chicken': {
    title: 'Butter chicken', emoji: '🍛', slot: 'dinner', role: 'full',
    imageKey: 'butter-chicken',
    season: 'winter/autumn',
    styles: ['balanced', 'highprotein'], time: 30,
    ingredients: [['chicken-breast', 160], ['tomatoes', 180], ['greek-yogurt', 80], ['rice', 60], ['olive-oil', 10]],
    toTaste: ['curry spices', 'garlic', 'ginger'],
    steps: ['Brown chicken with spices.', 'Simmer tomatoes into a sauce.', 'Stir in yogurt off the heat and serve with rice.'],
    tags: ['muscle'],
    avoid: ['lactose']
  },
  'tacchino-arrosto-agrumi': {
    title: 'Citrus roast turkey', emoji: '🦃', slot: 'dinner', role: 'full',
    imageKey: 'citrus-roast-turkey',
    season: 'winter/autumn',
    styles: ['balanced', 'highprotein'], time: 35,
    ingredients: [['turkey-breast', 190], ['oranges', 80], ['sweet-potato', 180], ['green-beans', 140], ['olive-oil', 10]],
    toTaste: ['rosemary', 'black pepper'],
    steps: ['Roast turkey with orange zest and herbs.', 'Roast sweet potato alongside.', 'Serve with green beans.'],
    tags: ['muscle'],
    avoid: []
  },
  'filetto-maiale': {
    title: 'Pork tenderloin', emoji: '🍖', slot: 'dinner', role: 'full',
    styles: ['balanced', 'highprotein'], time: 30,
    ingredients: [['pork-loin', 170], ['mushrooms', 120], ['potatoes', 200], ['olive-oil', 10]],
    toTaste: ['sage', 'garlic'],
    steps: ['Sear pork until golden.', 'Cook mushrooms in the pan juices.', 'Serve with roasted potatoes.'],
    tags: ['muscle'],
    avoid: []
  },
  'filetto-manzo': {
    title: 'Lean beef patty & rocket salad', emoji: '🥩', slot: 'dinner', role: 'main',
    styles: ['highprotein', 'lowcarb'], time: 25,
    ingredients: [['beef-mince-lean', 170], ['rocket-arugula', 50], ['cherry-tomatoes', 100], ['parmesan', 20], ['olive-oil', 10]],
    toTaste: ['lemon', 'black pepper'],
    steps: ['Cook the beef as a steak-style patty or sliced fillet substitute.', 'Toss rocket and tomatoes with olive oil and lemon.', 'Serve with parmesan shavings.'],
    tags: ['muscle'],
    avoid: ['lactose']
  },
  'salmone-o-sogliola': {
    title: 'Salmon with green vegetables', emoji: '🐟', slot: 'dinner', role: 'main',
    season: 'spring/summer',
    styles: ['balanced', 'highprotein', 'lowcarb'], time: 25,
    ingredients: [['salmon-fillet', 150], ['asparagus', 120], ['green-beans', 120], ['olive-oil', 10]],
    toTaste: ['lemon', 'parsley'],
    steps: ['Bake or pan-cook the fish.', 'Steam asparagus and green beans.', 'Finish everything with olive oil and lemon.'],
    tags: ['omega3', 'muscle', 'lowGI'],
    avoid: []
  },
  'pasta-zucca-fagioli-funghi': {
    title: 'Pumpkin, bean & mushroom pasta', emoji: '🍝', slot: 'dinner', role: 'full',
    imageKey: 'pasta',
    season: 'winter/autumn',
    slots: ['dinner', 'lunch'],
    styles: ['balanced'], time: 28,
    ingredients: [['pasta', 70], ['pumpkin', 160], ['cannellini-beans', 100], ['mushrooms', 100], ['olive-oil', 10]],
    toTaste: ['rosemary', 'garlic'],
    steps: ['Cook pasta.', 'Saute pumpkin, mushrooms and garlic until soft.', 'Add beans and toss with pasta.'],
    tags: ['veggie', 'highFiber'],
    avoid: ['gluten']
  },
  ramen: {
    title: 'Ramen', emoji: '🍜', slot: 'dinner', role: 'full',
    imageKey: 'ramen',
    styles: ['balanced'], time: 25,
    ingredients: [['ramen-noodles', 70], ['eggs', 50], ['chicken-breast', 90], ['mushrooms', 80], ['spinach', 60], ['soy-sauce', 15]],
    toTaste: ['ginger', 'garlic'],
    steps: ['Simmer broth with soy sauce, ginger and garlic.', 'Cook noodles and mushrooms.', 'Top with chicken, egg and spinach.'],
    tags: ['muscle'],
    avoid: ['gluten']
  },
  'zuppa-broccolo-nero-lenticchie': {
    title: 'Black kale & lentil soup', emoji: '🍲', slot: 'dinner', role: 'full',
    imageKey: 'soup',
    season: 'winter/autumn',
    slots: ['dinner', 'lunch'],
    styles: ['balanced'], time: 30,
    // Panel recipe pass (2026-08-30): fibre 26 -> ~23 (lentils 190 -> 160), under the
    // single-dish GI-distress line while still a hearty high-fibre soup.
    ingredients: [['cooked-lentils', 160], ['cavolo-nero', 140], ['tomatoes', 100], ['carrots', 80], ['olive-oil', 12], ['wholewheat-bread', 35]],
    toTaste: ['garlic', 'chilli if wanted'],
    steps: ['Simmer lentils with tomatoes and carrots.', 'Add greens until tender.', 'Finish with olive oil.'],
    tags: ['veggie', 'highFiber', 'heart'],
    avoid: []
  },
  'polpette-tacchino-yogurt-menta': {
    title: 'Turkey meatballs with yogurt & mint', emoji: '🦃', slot: 'dinner', role: 'main',
    imageKey: 'polpette-tacchino-yogurt-menta',
    styles: ['balanced', 'highprotein'], time: 28,
    ingredients: [['turkey-breast', 180], ['eggs', 50], ['wholewheat-bread', 35], ['greek-yogurt', 80], ['cucumber', 80], ['olive-oil', 8]],
    toTaste: ['mint', 'lemon'],
    steps: ['Mix minced turkey-style filling with egg and bread crumbs.', 'Shape and cook the meatballs.', 'Serve with cucumber yogurt mint sauce.'],
    tags: ['muscle'],
    avoid: ['gluten', 'lactose']
  },
  'burrito-vegetariano': {
    title: 'Vegetarian burrito', emoji: '🌯', slot: 'dinner', role: 'full',
    imageKey: 'burrito',
    styles: ['balanced'], time: 22,
    ingredients: [['white-bread', 80], ['cannellini-beans', 130], ['rice', 55], ['avocado', 60], ['cherry-tomatoes', 80], ['feta-cheese', 25]],
    toTaste: ['lime', 'cumin'],
    steps: ['Warm the wrap bread.', 'Fill with rice, beans, avocado and tomatoes.', 'Add feta and roll up.'],
    tags: ['veggie', 'highFiber'],
    avoid: ['gluten', 'lactose']
  },
  'tofu-noodles': {
    title: 'Sesame-ginger tofu noodles', emoji: '🍜', slot: 'dinner', role: 'full',
    styles: ['balanced'], time: 22,
    ingredients: [['tofu', 160], ['egg-noodles', 70], ['broccoli', 120], ['carrots', 80], ['soy-sauce', 15], ['olive-oil', 8]],
    toTaste: ['ginger', 'garlic', 'toasted sesame', 'chilli', 'lime'],
    steps: ['Cook the noodles.', 'Crisp the tofu in olive oil until golden, then stir-fry with the broccoli and carrots.', 'Toss with soy sauce, ginger and the noodles; finish with sesame, chilli and lime.'],
    tags: ['veggie', 'muscle'],
    avoid: ['gluten']
  },
  'feta-filo-miele-noodles-verdure': {
    title: 'Honey filo feta with noodles & grilled vegetables', emoji: '🧀', slot: 'dinner', role: 'full',
    imageKey: 'feta-filo-miele-noodles-verdure',
    season: 'spring/summer',
    styles: ['balanced'], time: 30,
    // Panel recipe pass (2026-08-30): behaved like a treat in the everyday pool (sat 14, sugar
    // 8). Trimmed feta 80->60 and honey 10->6, lifted the veg, to keep it in rotation honestly
    // (sat ~10, sugar ~5) rather than reclassifying it occasional.
    ingredients: [['feta-cheese', 60], ['pasta-filo', 45], ['honey', 6], ['egg-noodles', 45], ['courgette', 120], ['bell-pepper', 120], ['olive-oil', 10]],
    toTaste: ['sesame or thyme'],
    steps: ['Wrap the feta in filo and bake until crisp.', 'Drizzle with a little honey.', 'Serve with the noodles and grilled vegetables.'],
    tags: ['veggie'],
    avoid: ['gluten', 'lactose']
  },

  /* ================= ELENA RECIPE WISHLIST — SIDES ================= */

  'carrots-over-hummus': {
    title: 'Carrots over hummus', emoji: '🥕', slot: 'side', role: 'side',
    imageKey: 'carrots-over-hummus',
    slots: ['side', 'snack', 'lunch'],
    styles: ['balanced'], time: 22,
    ingredients: [['carrots', 180], ['chickpeas', 45], ['olive-oil', 12], ['lemon', 8], ['garlic', 2], ['maple-syrup', 5]],
    toTaste: ['paprika', 'lemon'],
    steps: ['Roast or pan-cook carrots with olive oil and maple.', 'Mash chickpeas with olive oil, lemon and garlic into a quick hummus.', 'Spread the hummus on a plate.', 'Pile carrots over the hummus.'],
    tags: ['veggie', 'highFiber'],
    avoid: []
  },
  'roasted-mixed-veg': {
    title: 'Roasted mixed veg', emoji: '🥒', slot: 'side', role: 'side',
    slots: ['side', 'lunch', 'dinner'],
    season: 'spring/summer',
    styles: ['balanced', 'lowcarb'], time: 30,
    ingredients: [['courgette', 90], ['bell-pepper', 90], ['aubergine', 90], ['red-onion', 45], ['olive-oil', 12]],
    toTaste: ['garlic', 'oregano', 'black pepper'],
    steps: ['Cut the vegetables into similar chunks.', 'Toss with olive oil and seasonings.', 'Roast until tender and lightly browned.'],
    tags: ['veggie', 'highFiber'],
    avoid: ['raw-onion']
  },
  scarola: {
    title: 'Escarole with olives & capers', emoji: '🥬', slot: 'side', role: 'side',
    styles: ['lowcarb', 'balanced'], time: 15,
    ingredients: [['escarole', 220], ['olives', 25], ['capers', 10], ['olive-oil', 10]],
    toTaste: ['garlic'],
    steps: ['Wilt scarola in a pan.', 'Add olives, capers and garlic.', 'Finish with olive oil.'],
    tags: ['veggie', 'highFiber', 'quick'],
    avoid: []
  },
  'cavolfiore-arrosto-paprika': {
    title: 'Roasted cauliflower with paprika & spices', emoji: '🥦', slot: 'side', role: 'side',
    season: 'winter/autumn',
    styles: ['lowcarb', 'balanced'], time: 30,
    ingredients: [['cauliflower', 240], ['olive-oil', 12], ['greek-yogurt', 50]],
    toTaste: ['paprika', 'cumin', 'lemon'],
    steps: ['Roast cauliflower-style broccoli florets with oil and spices.', 'Stir yogurt with lemon.', 'Serve with yogurt sauce.'],
    tags: ['veggie', 'lowGI'],
    avoid: ['lactose']
  },
  'roasted-potatoes': {
    title: 'Roasted potatoes', emoji: '🥔', slot: 'side', role: 'side',
    slots: ['side', 'lunch', 'dinner'], styles: ['balanced', 'highprotein'], time: 35,
    ingredients: [['potatoes', 220], ['olive-oil', 10]],
    toTaste: ['rosemary', 'salt', 'black pepper'],
    steps: ['Cut the potatoes into bite-sized pieces.', 'Toss with olive oil, rosemary and seasoning.', 'Roast at 210C until crisp outside and tender inside.'],
    tags: ['veggie'], avoid: []
  },
  'mashed-potatoes': {
    title: 'Mashed potatoes', emoji: '🥔', slot: 'side', role: 'side',
    slots: ['side', 'lunch', 'dinner'], styles: ['balanced', 'highprotein'], time: 25,
    ingredients: [['potatoes', 220], ['olive-oil', 8]],
    toTaste: ['salt', 'black pepper', 'nutmeg'],
    steps: ['Boil the potatoes until very tender.', 'Drain well and mash with olive oil and seasoning.', 'Loosen with a splash of cooking water if needed.'],
    tags: ['veggie'], avoid: []
  },
  'steamed-rice': {
    title: 'Steamed rice', emoji: '🍚', slot: 'side', role: 'side',
    imageKey: 'onigiri',
    slots: ['side', 'lunch', 'dinner'], styles: ['balanced', 'highprotein'], time: 18,
    ingredients: [['rice', 60], ['olive-oil', 3]],
    toTaste: ['salt'],
    steps: ['Rinse the rice until the water runs mostly clear.', 'Simmer covered in water until tender.', 'Rest for 5 minutes, fluff and finish with olive oil.'],
    tags: [], avoid: []
  },
  nachos: {
    title: 'Nachos', emoji: '🌽', slot: 'side', role: 'side', occasional: true,
    imageKey: 'nachos',
    slots: ['side', 'lunch', 'dinner'], styles: ['balanced'], time: 8,
    ingredients: [['tortilla-chips', 45], ['mozzarella', 35]],
    toTaste: ['paprika'],
    steps: ['Spread the tortilla chips on a small oven-safe plate.', 'Scatter mozzarella over the top.', 'Bake or grill briefly until the cheese melts.'],
    tags: [], avoid: ['lactose']
  },
  'steamed-green-beans': {
    title: 'Steamed green beans', emoji: '🫛', slot: 'side', role: 'side',
    slots: ['side', 'lunch', 'dinner'], season: 'spring/summer', styles: ['lowcarb', 'balanced'], time: 12,
    ingredients: [['green-beans', 200], ['olive-oil', 8]],
    toTaste: ['lemon', 'salt', 'black pepper'],
    steps: ['Steam the green beans until bright and just tender.', 'Dress with olive oil, lemon and seasoning.', 'Serve warm.'],
    tags: ['veggie', 'highFiber', 'quick'], avoid: []
  },
  'steamed-broccoli-pumpkin-seeds': {
    title: 'Steamed broccoli with pumpkin seeds', emoji: '🥦', slot: 'side', role: 'side',
    slots: ['side', 'lunch', 'dinner'], season: 'winter/autumn', styles: ['lowcarb', 'balanced'], time: 12,
    ingredients: [['broccoli', 220], ['pumpkin-seeds', 15], ['olive-oil', 6]],
    toTaste: ['lemon', 'salt', 'black pepper'],
    steps: ['Steam the broccoli until tender with a little bite.', 'Dress with olive oil and lemon.', 'Finish with pumpkin seeds and seasoning.'],
    tags: ['veggie', 'highFiber', 'quick'], avoid: []
  },
  'cole-slaw': {
    title: 'Cole slaw', emoji: '🥬', slot: 'side', role: 'side',
    season: 'winter/autumn',
    styles: ['balanced', 'lowcarb'], time: 12,
    ingredients: [['cabbage', 160], ['carrots', 80], ['greek-yogurt', 60], ['mustard', 8]],
    toTaste: ['lemon', 'black pepper'],
    steps: ['Shred cabbage and carrots.', 'Mix yogurt, mustard and lemon.', 'Toss and chill briefly.'],
    tags: ['veggie', 'quick'],
    avoid: ['lactose']
  },
  'verdure-wok': {
    title: 'Wok vegetables', emoji: '🥢', slot: 'side', role: 'side',
    slots: ['side', 'lunch'],
    styles: ['balanced', 'lowcarb'], time: 15,
    ingredients: [['broccoli', 120], ['bell-pepper', 100], ['carrots', 80], ['soy-sauce', 12], ['olive-oil', 8]],
    toTaste: ['ginger', 'garlic'],
    steps: ['Slice vegetables thinly.', 'Stir-fry hot and fast with oil.', 'Finish with soy sauce and ginger.'],
    tags: ['veggie', 'quick'],
    avoid: []
  },
  'insalata-carote-cetrioli-marinate': {
    title: 'Marinated carrot & cucumber salad', emoji: '🥒', slot: 'side', role: 'side',
    season: 'spring/summer',
    styles: ['lowcarb', 'balanced'], time: 10,
    ingredients: [['carrots', 100], ['cucumber', 140], ['balsamic-vinegar', 10], ['olive-oil', 8]],
    toTaste: ['lemon', 'mint'],
    steps: ['Ribbon carrots and cucumber.', 'Dress with vinegar, olive oil and lemon.', 'Let sit a few minutes before serving.'],
    tags: ['veggie', 'quick'],
    avoid: []
  },
  'pak-choy-butter-side': {
    title: 'Pak choy sautéed in butter', emoji: '🥬', slot: 'side', role: 'side',
    slots: ['side', 'lunch', 'dinner'],
    styles: ['balanced', 'lowcarb'], time: 10,
    ingredients: [['pak-choy', 220], ['butter', 12], ['soy-sauce', 8]],
    toTaste: ['garlic', 'black pepper'],
    steps: ['Trim and halve the pak choy.', 'Sauté it in butter until just tender and glossy.', 'Finish with soy sauce, garlic and black pepper.'],
    tags: ['veggie', 'quick'],
    avoid: ['lactose']
  },
  'spring-rolls': {
    title: 'Chinese spring rolls', emoji: '🥢', slot: 'side', role: 'side',
    imageKey: 'spring-rolls',
    slots: ['side', 'snack', 'lunch'],
    occasional: true,
    styles: ['balanced'], time: 25,
    ingredients: [['pasta-filo', 45], ['cabbage', 90], ['carrots', 50], ['pak-choy', 50], ['soy-sauce', 8], ['olive-oil', 10]],
    toTaste: ['ginger', 'garlic'],
    steps: ['Shred the vegetables finely.', 'Stir-fry with soy sauce, ginger and garlic.', 'Roll in filo and bake or pan-crisp until golden.'],
    tags: ['veggie'],
    avoid: ['gluten']
  },
  'fast-food-fries': {
    title: 'French fries', emoji: '🍟', slot: 'side', role: 'side',
    slots: ['side', 'snack', 'lunch', 'dinner'],
    occasional: true,
    styles: ['balanced'], time: 25,
    ingredients: [['potatoes', 220], ['olive-oil', 18]],
    toTaste: ['salt'],
    steps: ['Cut potatoes into fries.', 'Toss with oil and salt.', 'Bake or air-fry until crisp and golden.'],
    tags: ['veggie'],
    avoid: []
  },

  /* ================= VARIETY-plan.md P3 — sides ================= */

  'spinach-garlic-lemon': {
    title: 'Sautéed spinach with garlic & lemon', emoji: '🥬', slot: 'side', role: 'side',
    season: 'evergreen',
    styles: ['balanced', 'lowcarb'], time: 8,
    ingredients: [['spinach', 250], ['olive-oil', 10], ['lemon', 8]],
    toTaste: ['garlic', 'black pepper'],
    steps: ['Warm the olive oil with garlic in a wide pan.', 'Add the spinach in batches and wilt it down.', 'Finish with lemon juice and black pepper.'],
    tags: ['veggie', 'lowGI'],
    avoid: []
  },
  'braised-mushrooms-balsamic': {
    title: 'Braised mushrooms with balsamic', emoji: '🍄', slot: 'side', role: 'side',
    season: 'evergreen',
    styles: ['balanced', 'lowcarb'], time: 12,
    ingredients: [['mushrooms', 260], ['olive-oil', 10], ['balsamic-vinegar', 10]],
    toTaste: ['garlic', 'black pepper'],
    steps: ['Sauté the mushrooms in olive oil until golden.', 'Add the balsamic vinegar and garlic and let it reduce slightly.', 'Season with black pepper and serve warm.'],
    tags: ['veggie', 'quick'],
    avoid: []
  },
  'rocket-parmesan-side': {
    title: 'Rocket & parmesan side salad', emoji: '🥗', slot: 'side', role: 'side',
    season: 'evergreen',
    styles: ['balanced', 'lowcarb'], time: 5,
    ingredients: [['rocket-arugula', 70], ['parmesan', 20], ['olive-oil', 8], ['lemon', 8]],
    toTaste: ['black pepper'],
    steps: ['Pile the rocket onto a plate.', 'Shave the parmesan over the top.', 'Dress with olive oil, lemon juice and black pepper.'],
    tags: ['veggie', 'heart', 'quick'],
    avoid: ['lactose']
  },
  'marinated-cannellini-beans': {
    title: 'Marinated cannellini beans', emoji: '🫘', slot: 'side', role: 'side',
    season: 'evergreen',
    styles: ['balanced'], time: 8,
    ingredients: [['cannellini-beans', 120], ['rocket-arugula', 20], ['olive-oil', 8], ['lemon', 10]],
    toTaste: ['garlic', 'black pepper'],
    steps: ['Drain and rinse the beans.', 'Toss with rocket, olive oil and lemon juice.', 'Season with garlic and black pepper and let sit a few minutes.'],
    tags: ['veggie', 'highFiber', 'heart'],
    avoid: []
  },
  'cumin-roasted-carrots': {
    title: 'Cumin-roasted carrots', emoji: '🥕', slot: 'side', role: 'side',
    season: 'evergreen',
    styles: ['balanced', 'lowcarb'], time: 25,
    ingredients: [['carrots', 260], ['olive-oil', 10]],
    toTaste: ['cumin', 'lemon', 'black pepper'],
    steps: ['Cut the carrots into batons and toss with olive oil and cumin.', 'Roast at 200C for 18-20 min until tender and lightly charred.', 'Finish with a squeeze of lemon.'],
    tags: ['veggie', 'lowGI'],
    avoid: []
  },
  'farro-lemon-herb-side': {
    title: 'Farro with lemon & herbs', emoji: '🌾', slot: 'side', role: 'side',
    season: 'evergreen',
    styles: ['balanced'], time: 12,
    ingredients: [['farro-cooked', 130], ['olive-oil', 8], ['lemon', 8]],
    toTaste: ['parsley', 'black pepper'],
    steps: ['Warm the farro through.', 'Toss with olive oil and lemon juice.', 'Finish with parsley and black pepper.'],
    tags: ['veggie', 'highFiber'],
    avoid: ['gluten']
  },
  'braised-cavolo-nero': {
    title: 'Braised cavolo nero with garlic', emoji: '🥬', slot: 'side', role: 'side',
    season: 'winter/autumn',
    styles: ['balanced', 'lowcarb'], time: 15,
    ingredients: [['cavolo-nero', 220], ['olive-oil', 10]],
    toTaste: ['garlic', 'chilli if wanted'],
    steps: ['Strip the cavolo nero leaves from the stalks and chop roughly.', 'Braise in olive oil with garlic until tender, 8-10 min.', 'Season and serve warm.'],
    tags: ['veggie', 'highFiber', 'heart'],
    avoid: []
  },
  'roasted-pumpkin-sage': {
    title: 'Roasted pumpkin with sage', emoji: '🎃', slot: 'side', role: 'side',
    season: 'winter/autumn',
    styles: ['balanced', 'lowcarb'], time: 30,
    ingredients: [['pumpkin', 260], ['olive-oil', 10]],
    toTaste: ['sage', 'black pepper'],
    steps: ['Cube the pumpkin and toss with olive oil and sage.', 'Roast at 200C for 22-25 min until tender and caramelised.', 'Season with black pepper before serving.'],
    tags: ['veggie', 'lowGI'],
    avoid: []
  },

  lasagna: {
    title: 'Lasagna', emoji: '🍝', slot: 'dinner', role: 'full',
    slots: ['dinner', 'lunch'],
    occasional: true,
    styles: ['balanced'], time: 60,
    ingredients: [['lasagna-sheets', 90], ['beef-mince-lean', 160], ['tomato-passata', 220], ['ricotta', 90], ['mozzarella', 80], ['parmesan', 20], ['olive-oil', 10]],
    toTaste: ['onion', 'garlic', 'nutmeg', 'basil'],
    steps: ['Cook the beef with a little onion and garlic, then add the passata.', 'Layer sauce, sheets, ricotta, mozzarella and parmesan in a baking dish.', 'Bake until bubbling and golden on top.', 'Rest before slicing.'],
    tags: ['muscle'],
    avoid: ['gluten', 'lactose']
  },
  // The household's usual Chinese spread (owner, 2026-08-22), built as an AGGREGATE of five
  // singular sub-recipes (engine.js recipeEffectiveIngredients resolves a recipe's `components`
  // -> the sum of its sub-recipes). Each sub-dish below is a real, browsable recipe on its own;
  // the Chinese dinner is spring-rolls + meat-gyozas + fried-rice + stir-fried-noodles +
  // almond-chicken. All occasional (loggable/searchable, not auto-planned).
  'spring-rolls': {
    title: 'Spring rolls', emoji: '🥢', slot: 'snack', role: 'side',
    slots: ['side', 'snack'], season: 'evergreen', occasional: true,
    styles: ['balanced'], time: 20,
    ingredients: [['wheat-wrapper', 30], ['cabbage', 45], ['carrots', 25], ['olive-oil', 5]],
    toTaste: ['ginger', 'garlic', 'soy sauce'],
    steps: ['Shred the cabbage and carrot and toss with a little soy and ginger.', 'Roll tight in the wheat wrappers.', 'Pan-crisp or bake at 200C until golden, turning once — about 2 rolls per portion.'],
    tags: [], avoid: ['gluten']
  },
  'meat-gyozas': {
    title: 'Meat gyozas', emoji: '🥟', slot: 'snack', role: 'side',
    slots: ['side', 'snack'], season: 'evergreen', occasional: true,
    styles: ['balanced', 'highprotein'], time: 25,
    ingredients: [['wheat-wrapper', 40], ['pork-mince', 45], ['cabbage', 20], ['olive-oil', 3]],
    toTaste: ['ginger', 'garlic', 'soy sauce', 'spring onion'],
    steps: ['Mix the pork mince with finely chopped cabbage, ginger, garlic and a splash of soy.', 'Spoon into the wrappers, pleat and seal.', 'Pan-fry base-down until browned, then add a splash of water and cover to steam through — 3-4 per portion.'],
    tags: ['muscle'], avoid: ['gluten']
  },
  'fried-rice-veg': {
    title: 'Vegetable fried rice', emoji: '🍚', slot: 'side', role: 'side',
    slots: ['side'], season: 'evergreen', occasional: true,
    styles: ['balanced'], time: 15,
    ingredients: [['rice', 70], ['eggs', 25], ['pak-choy', 40], ['carrots', 20], ['soy-sauce', 8], ['olive-oil', 5]],
    toTaste: ['ginger', 'garlic', 'spring onion'],
    steps: ['Cook and cool the rice (day-old is best).', 'Scramble the egg in a hot wok, then push aside.', 'Stir-fry the pak choy and carrot, add the rice and soy and toss until hot through.'],
    tags: [], avoid: ['gluten']
  },
  'stir-fried-noodles': {
    title: 'Stir-fried noodles', emoji: '🍜', slot: 'side', role: 'side',
    slots: ['side'], season: 'evergreen', occasional: true,
    styles: ['balanced'], time: 15,
    ingredients: [['egg-noodles', 70], ['cabbage', 40], ['carrots', 20], ['soy-sauce', 8], ['olive-oil', 5]],
    toTaste: ['ginger', 'garlic', 'sesame oil'],
    steps: ['Cook the egg noodles and drain.', 'Stir-fry the cabbage and carrot in a hot wok.', 'Add the noodles and soy and toss until glossy and hot through.'],
    tags: [], avoid: ['gluten']
  },
  'almond-chicken': {
    title: 'Almond chicken', emoji: '🍗', slot: 'dinner', role: 'main',
    slots: ['dinner', 'lunch'], season: 'evergreen', occasional: true,
    styles: ['balanced', 'highprotein'], time: 18,
    ingredients: [['chicken-breast', 150], ['almonds', 20], ['soy-sauce', 10], ['olive-oil', 5]],
    toTaste: ['ginger', 'garlic'],
    steps: ['Slice the chicken and stir-fry in a hot wok until golden.', 'Add the almonds and toast briefly.', 'Splash in the soy sauce and toss until the chicken is glazed.'],
    tags: ['muscle'], avoid: ['nuts', 'gluten']
  },
  'cena-cinese': {
    title: 'Chinese dinner', emoji: '🥡', slot: 'dinner', role: 'full',
    imageKey: 'chinese-dinner',
    slots: ['dinner', 'lunch'],
    occasional: true,
    styles: ['balanced'], time: 45,
    ingredients: [],
    components: [
      {recipeId: 'spring-rolls', portion: 1},
      {recipeId: 'meat-gyozas', portion: 1},
      {recipeId: 'fried-rice-veg', portion: 0.5},
      {recipeId: 'stir-fried-noodles', portion: 0.5},
      {recipeId: 'almond-chicken', portion: 1}
    ],
    toTaste: ['ginger', 'garlic', 'sesame oil'],
    steps: ['Make the five sub-dishes: spring rolls, meat gyozas, vegetable fried rice, stir-fried noodles and almond chicken.', 'Plate 2 spring rolls and 3-4 gyozas each, with half a portion of fried rice and half of noodles.', 'Add the almond chicken and serve everything together as one shared spread.'],
    tags: ['muscle'],
    avoid: ['gluten', 'nuts']
  },

  /* ================= TASK D2 — recipe options and mains ================= */

  'baked-fish': {
    title: 'Baked fish', emoji: '🐟', slot: 'dinner', role: 'main',
    imageKey: 'fish-main',
    slots: ['dinner'],
    styles: ['balanced', 'highprotein', 'lowcarb'], time: 20,
    ingredients: [['olive-oil', 10], ['lemon', 20]],
    toTaste: ['herbs', 'garlic', 'black pepper'],
    steps: ['Rub the fish fillet with olive oil, lemon juice and herbs.', 'Bake at 200C for 12-15 min until just cooked through.', 'Rest briefly, then finish with an extra squeeze of lemon.'],
    tags: ['muscle', 'thyroid', 'lowGI'],
    avoid: [],
    optionGroups: [
      {
        key: 'fish', label: 'Fish',
        choices: [
          {id: 'salmon', label: 'Salmon', ingredients: [['salmon-fillet', 180]]},
          {id: 'sea-bass', label: 'Sea bass', ingredients: [['sea-bass-fillet', 220]]},
          {id: 'sole', label: 'Sole', ingredients: [['sole-fish', 220]]},
          {id: 'cod', label: 'Cod', ingredients: [['cod', 220]]},
          {id: 'tuna', label: 'Tuna steak', ingredients: [['tuna-steak', 220]]}
        ]
      }
    ]
  },
  pasta: {
    title: 'Pasta', emoji: '🍝', slot: 'lunch', role: 'full',
    imageKey: 'pasta',
    slots: ['lunch', 'dinner'],
    styles: ['balanced'], time: 20,
    ingredients: [['pasta', 100], ['olive-oil', 8]],
    toTaste: ['salt', 'black pepper', 'garlic', 'parsley'],
    steps: ['Bring a pot of salted water to the boil and cook the pasta until al dente.', 'While the pasta cooks, warm the chosen condiment through in a pan with the olive oil.', 'Drain the pasta, reserving a splash of cooking water.', 'Toss the pasta with the condiment, loosening with the reserved water if needed.'],
    tags: [],
    avoid: ['gluten'],
    optionGroups: [
      {
        key: 'condiment', label: 'Condiment',
        choices: [
          {id: 'tomato-basil', label: 'Tomato & basil', ingredients: [['tomato-passata', 150], ['basil', 8]]},
          {id: 'pesto', label: 'Pesto Elena', ingredients: [['pesto-elena', 60]]},
          {id: 'pesto-vegan', label: 'Pesto Elena (vegan)', dietKeys: ['vegan', 'lactose-intolerant'], ingredients: [['pesto-elena', 60]]},
          {id: 'tuna-olives', label: 'Tuna & olives', ingredients: [['tuna-in-olive-oil', 90], ['olives', 30]]},
          {id: 'courgette-ricotta', label: 'Courgette & ricotta', ingredients: [['courgette', 150], ['ricotta', 100]]},
          {id: 'mushroom', label: 'Mushroom', ingredients: [['mushrooms', 130], ['parmesan', 20]]},
          {id: 'mushroom-vegan', label: 'Mushroom (vegan)', dietKeys: ['vegan', 'lactose-intolerant'], ingredients: [['mushrooms', 140]]}
        ]
      }
    ]
  },
  pizza: {
    title: 'Pizza', emoji: '🍕', slot: 'dinner', role: 'full',
    imageKey: 'pizza',
    imageUri: 'assets/recipes/pizza.png',
    slots: ['dinner', 'lunch'],
    styles: ['balanced'], time: 35,
    ingredients: [['00-flour', 110], ['olive-oil', 6]],
    toTaste: ['water', 'yeast', 'salt'],
    steps: ['Mix flour, water, yeast and a pinch of salt into a dough; knead until smooth.', 'Cover and let rise until doubled, about 1-2 hours.', 'Stretch the dough into a round on a floured surface.', 'Top with the chosen topping and olive oil.', 'Bake on a hot stone or tray at the highest oven setting until the crust is blistered and the cheese is bubbling, 8-12 min.'],
    tags: [],
    avoid: ['gluten'],
    optionGroups: [
      {
        key: 'topping', label: 'Topping',
        choices: [
          {id: 'margherita', label: 'Margherita', ingredients: [['tomato-puree', 70], ['mozzarella', 70], ['basil', 5]]},
          {id: 'boscaiola', label: 'Boscaiola', ingredients: [['tomato-puree', 50], ['mozzarella', 50], ['mushrooms', 80], ['pork-sausage', 45]]},
          {id: 'funghi', label: 'Mushroom', ingredients: [['tomato-puree', 70], ['mozzarella', 60], ['mushrooms', 100]]}
        ]
      }
    ]
  },
  'lemon-herb-chicken-breast': {
    title: 'Lemon-herb chicken breast', emoji: '🍗', slot: 'lunch', role: 'main',
    slots: ['lunch', 'dinner'],
    styles: ['balanced', 'highprotein', 'lowcarb'], time: 18,
    ingredients: [['chicken-breast', 180], ['olive-oil', 8], ['lemon', 15]],
    toTaste: ['garlic', 'herbs', 'black pepper'],
    steps: ['Rub the chicken breast with olive oil, lemon juice and herbs.', 'Pan-sear or grill until cooked through, 6-8 min per side.', 'Rest briefly, then slice and finish with an extra squeeze of lemon.'],
    tags: ['muscle', 'thyroid', 'lowGI'],
    avoid: []
  },
  'turkey-cutlets-sage': {
    // Panel recipe pass (2026-08-30): was pure protein (fibre 0, no veg). A simple rocket +
    // cherry-tomato side gives it colour and a little fibre without touching its lean, high-
    // protein character. turkey trimmed 220 -> 200g to make room.
    title: 'Turkey cutlets with sage, rocket & tomato', emoji: '🦃', slot: 'lunch', role: 'main',
    slots: ['lunch', 'dinner'],
    styles: ['balanced', 'highprotein'], time: 18,
    ingredients: [['turkey-breast', 200], ['rocket-arugula', 40], ['cherry-tomatoes', 100], ['olive-oil', 8]],
    toTaste: ['sage', 'garlic', 'black pepper', 'lemon'],
    steps: ['Season the turkey cutlets with sage, garlic and black pepper.', 'Pan-sear in olive oil until golden and cooked through, 3-4 min per side.', 'Rest briefly, slice, and serve over the rocket and cherry tomatoes with a squeeze of lemon.'],
    tags: ['muscle', 'thyroid'],
    avoid: []
  },
  'white-bean-rosemary-mash': {
    // Panel recipe pass (2026-08-30): was an under-built 2-ingredient dish (300g beans + oil),
    // no veg or acid, and fibre pushed to 19. Cavolo nero + burst cherry tomatoes turn it into
    // an actual plate; beans pulled back to 220g (fibre ~18). Now a Tuscan-style beans-and-greens.
    title: 'Tuscan white beans, greens & tomato', emoji: '🫘', slot: 'lunch', role: 'main',
    slots: ['lunch', 'dinner'],
    styles: ['balanced'], time: 15,
    ingredients: [['cannellini-beans', 220], ['cavolo-nero', 80], ['cherry-tomatoes', 100], ['olive-oil', 12]],
    toTaste: ['rosemary', 'garlic', 'lemon', 'black pepper'],
    steps: ['Warm the cannellini beans with olive oil, rosemary and garlic, mashing some for texture.', 'Wilt the cavolo nero and burst the cherry tomatoes in the same pan.', 'Fold together and finish with black pepper and a squeeze of lemon.'],
    tags: ['veggie', 'highFiber', 'lowGI', 'heart'],
    avoid: []
  },

  /* ================= VARIETY-plan.md P3 — lunch mains (meatless/fish) ================= */

  'chickpea-tomato-braise': {
    title: 'Braised chickpeas in tomato sauce', emoji: '🫘', slot: 'lunch', role: 'main',
    season: 'evergreen',
    slots: ['lunch', 'dinner'],
    styles: ['balanced'], time: 20,
    ingredients: [['chickpeas', 200], ['tomato-passata', 100], ['olive-oil', 8]],
    toTaste: ['garlic', 'oregano', 'black pepper'],
    steps: ['Warm the olive oil with garlic in a pan.', 'Add the chickpeas and tomato passata and simmer 12-15 min.', 'Season with oregano and black pepper.'],
    tags: ['veggie', 'highFiber', 'heart'],
    avoid: []
  },
  'lentils-tomato-cumin': {
    title: 'Braised lentils with tomato & cumin', emoji: '🥣', slot: 'lunch', role: 'main',
    season: 'evergreen',
    slots: ['lunch', 'dinner'],
    styles: ['balanced'], time: 20,
    ingredients: [['cooked-lentils', 220], ['tomato-passata', 100], ['red-onion', 30], ['olive-oil', 8]],
    toTaste: ['cumin', 'garlic', 'black pepper'],
    steps: ['Warm the olive oil in a pan and soften the red onion.', 'Add the tomato passata and cumin; simmer a couple of minutes.', 'Stir in the lentils and warm through, 5-6 min.', 'Season with garlic and black pepper before serving.'],
    tags: ['veggie', 'highFiber', 'heart'],
    avoid: []
  },
  'seared-tofu-greens': {
    // Panel recipe pass (2026-08-30): read as pure diet-food. Chef rename + lacquer-the-soy
    // technique + chilli/sesame/lime for crunch and brightness (zero macro change).
    title: 'Crispy sesame-ginger tofu, wilted greens', emoji: '🥢', slot: 'lunch', role: 'main',
    season: 'evergreen',
    slots: ['lunch', 'dinner'],
    styles: ['balanced', 'highprotein', 'lowcarb'], time: 15,
    ingredients: [['tofu', 200], ['spinach', 80], ['olive-oil', 8], ['soy-sauce', 10]],
    toTaste: ['ginger', 'garlic', 'chilli flakes', 'toasted sesame', 'lime'],
    steps: ['Press and cube the tofu, then sear hard in the olive oil until deep golden and crisp on all sides.', 'Glaze with the soy off the heat so it lacquers the tofu; wilt the spinach in the same pan.', 'Finish with ginger, chilli, sesame and a squeeze of lime.'],
    tags: ['veggie', 'muscle'],
    avoid: []
  },

  /* Complete plant-based lunch/dinner fallbacks: these keep the hard meal
     composition contract satisfiable for vegetarian and gluten-free plans. */
  'tofu-rice-broccoli-bowl': {
    title: 'Ginger tofu & sesame broccoli rice', emoji: '🥦', slot: 'lunch', role: 'full',
    slots: ['lunch', 'dinner'], styles: ['balanced', 'highprotein', 'lowcarb'], time: 25,
    ingredients: [['tofu', 180], ['rice', 55], ['broccoli', 180], ['carrots', 80], ['olive-oil', 8]],
    toTaste: ['ginger', 'garlic', 'toasted sesame', 'chilli', 'lemon'],
    steps: ['Cook the rice until tender.', 'Sear the tofu in olive oil until golden and crisp.', 'Char the broccoli and carrots in a hot pan.', 'Serve the tofu and vegetables over rice with ginger, sesame and lemon.'],
    tags: ['veggie', 'highFiber', 'muscle'], avoid: []
  },
  'tofu-quinoa-greens-bowl': {
    // Panel recipe pass (2026-08-30): chef rename + char-not-boil technique (zero macro change) —
    // "the single biggest appeal lever in the catalog" was replacing boiled broccoli with charred.
    title: 'Chilli-lemon tofu & charred broccoli quinoa', emoji: '🥗', slot: 'dinner', role: 'full',
    season: 'evergreen', slots: ['lunch', 'dinner'], styles: ['balanced', 'highprotein', 'lowcarb'], time: 28,
    ingredients: [['tofu', 180], ['quinoa-dry', 65], ['broccoli', 160], ['spinach', 100], ['olive-oil', 8]],
    toTaste: ['lemon', 'garlic', 'chilli flakes', 'black pepper'],
    steps: ['Cook the quinoa until fluffy.', 'Press and cube the tofu, then sear hard in the olive oil until deep golden and crisp on all sides.', 'Roast or griddle the broccoli until charred at the edges; wilt the spinach with garlic.', 'Pile the tofu and greens over the quinoa, finish with chilli and a squeeze of lemon.'],
    tags: ['veggie', 'highFiber', 'muscle'], avoid: []
  },
  'chickpea-quinoa-broccoli-bowl': {
    // Panel recipe pass (2026-08-30): fibre 25 -> ~22 (chickpeas 190->160) and kcal 711 -> ~650,
    // both back into comfortable range; chef rename + charred broccoli.
    title: 'Roasted chickpeas & charred broccoli, cumin-lemon quinoa', emoji: '🥦', slot: 'lunch', role: 'full',
    season: 'evergreen', slots: ['lunch', 'dinner'], styles: ['balanced', 'highprotein', 'lowcarb'], time: 30,
    ingredients: [['chickpeas', 160], ['quinoa-dry', 55], ['broccoli', 180], ['spinach', 80], ['olive-oil', 8]],
    toTaste: ['lemon', 'cumin', 'chilli flakes', 'black pepper'],
    steps: ['Cook the quinoa until tender.', 'Roast the chickpeas with cumin until golden and nutty.', 'Char the broccoli under the grill or in a hot pan; wilt the spinach.', 'Assemble the bowl and finish with olive oil and lemon.'],
    tags: ['veggie', 'highFiber', 'muscle'], avoid: []
  },
  'lentil-quinoa-greens-bowl': {
    // Panel recipe pass (2026-08-30): was a fibre bomb (28g > 25g GI-distress flag) — lentils
    // 220 -> 170 brings it to ~23g, still a robust high-fibre bowl; chef rename + blistered greens.
    title: 'Herby lentil & quinoa, blistered greens', emoji: '🫘', slot: 'dinner', role: 'full',
    season: 'evergreen', slots: ['lunch', 'dinner'], styles: ['balanced', 'highprotein', 'lowcarb'], time: 28,
    ingredients: [['cooked-lentils', 170], ['quinoa-dry', 55], ['broccoli', 160], ['spinach', 100], ['olive-oil', 8]],
    toTaste: ['lemon', 'cumin', 'parsley'],
    steps: ['Cook the quinoa until tender.', 'Warm the lentils with cumin and a splash of water.', 'Blister the broccoli in a hot pan; wilt the spinach.', 'Layer in a bowl and finish with olive oil, lemon and parsley.'],
    tags: ['veggie', 'highFiber', 'muscle'], avoid: []
  },
  'chickpea-potato-veg-tray': {
    title: 'Chickpea, potato & vegetable traybake', emoji: '🥔', slot: 'dinner', role: 'full',
    slots: ['lunch', 'dinner'], styles: ['balanced', 'highprotein', 'lowcarb'], time: 35,
    ingredients: [['chickpeas', 180], ['potatoes', 220], ['courgette', 160], ['bell-pepper', 120], ['olive-oil', 10]],
    toTaste: ['smoked paprika', 'oregano', 'chilli flakes', 'lemon', 'black pepper'],
    steps: ['Heat the oven to 210C.', 'Toss the potatoes and vegetables with olive oil, smoked paprika and oregano.', 'Roast until golden and caramelised at the edges.', 'Add the chickpeas for the final 10 minutes, finish with lemon and serve hot.'],
    tags: ['veggie', 'highFiber'], avoid: []
  },
  'lentil-rice-vegetable-bowl': {
    title: 'Smoky cumin lentils, rice & lemony carrots', emoji: '🫘', slot: 'lunch', role: 'full',
    slots: ['lunch', 'dinner'], styles: ['balanced', 'highprotein', 'lowcarb'], time: 25,
    ingredients: [['cooked-lentils', 220], ['rice', 45], ['spinach', 100], ['carrots', 100], ['olive-oil', 8]],
    toTaste: ['cumin', 'smoked paprika', 'chilli flakes', 'lemon', 'parsley'],
    steps: ['Warm the lentils with cumin and smoked paprika and a splash of water.', 'Cook the rice until tender.', 'Roast or caramelise the carrots and wilt the spinach in olive oil.', 'Layer everything in a bowl and finish with lemon and parsley.'],
    tags: ['veggie', 'highFiber', 'muscle'], avoid: []
  },
  'cannellini-potato-greens': {
    title: 'Tuscan white bean, potato & greens', emoji: '🥬', slot: 'dinner', role: 'full',
    slots: ['lunch', 'dinner'], styles: ['balanced', 'highprotein', 'lowcarb'], time: 30,
    ingredients: [['cannellini-beans', 220], ['potatoes', 200], ['spinach', 140], ['cherry-tomatoes', 120], ['olive-oil', 8]],
    toTaste: ['rosemary', 'garlic', 'chilli flakes', 'lemon'],
    steps: ['Roast the potatoes with rosemary until crisp.', 'Warm cannellini beans with garlic and olive oil.', 'Wilt the spinach and tomatoes in a pan.', 'Serve the beans and greens beside the potatoes with lemon.'],
    tags: ['veggie', 'highFiber', 'muscle'], avoid: []
  },

  /* ================= SNACK (6) ================= */

  'brazil-nuts-apple': {
    title: 'Snack: 2 Brazil nuts + apple', emoji: '🌰', slot: 'snack', role: 'full',
    season: 'winter/autumn',
    styles: ['balanced'], time: 2,
    ingredients: [['brazil-nuts', 10], ['apples', 150]],
    toTaste: [],
    steps: ['Wash and slice the apple.', 'Portion the Brazil nuts.', 'Serve together.'],
    tags: ['thyroid'],
    avoid: ['nuts']
  },
  'ricotta-walnuts': {
    // Panel recipe pass (2026-08-30): 130g ricotta carried ~12g saturated fat (half a day's
    // ceiling) in a snack, with no fibre. Trimmed ricotta and added pear for fibre + natural
    // sweetness — reads as a dessert-y snack. sat 12 -> ~7.
    title: 'Snack: Ricotta, pear & walnuts', emoji: '🍐', slot: 'snack', role: 'full',
    imageKey: 'snack-board',
    styles: ['highprotein'], time: 3,
    ingredients: [['ricotta', 80], ['walnuts', 12], ['pears', 80]],
    toTaste: ['black pepper'],
    steps: ['Spoon the ricotta into a small bowl.', 'Slice the pear and add alongside.', 'Top with walnuts and a twist of black pepper.'],
    tags: ['muscle'],
    avoid: ['lactose', 'nuts']
  },
  'almonds-cheese-cubes': {
    title: 'Snack: Almonds & cheese cubes', emoji: '🥜', slot: 'snack', role: 'full',
    imageKey: 'snack-board',
    styles: ['lowcarb'], time: 3,
    ingredients: [['almonds', 20], ['mozzarella', 40]],
    toTaste: [],
    steps: ['Portion the almonds.', 'Cube the mozzarella.', 'Serve together.'],
    tags: ['muscle'],
    avoid: ['lactose', 'nuts']
  },
  'hummus-veg-sticks': {
    title: 'Snack: Hummus & veg sticks', emoji: '🥕', slot: 'snack', role: 'side',
    slots: ['snack', 'side'],
    styles: ['balanced', 'lowcarb'], time: 5,
    ingredients: [['chickpeas', 45], ['olive-oil', 8], ['lemon', 6], ['garlic', 2], ['cucumber', 80], ['cherry-tomatoes', 60]],
    toTaste: [],
    steps: ['Mash chickpeas with olive oil, lemon and garlic.', 'Slice cucumber and halve the cherry tomatoes.', 'Serve the veg sticks with the hummus for dipping.'],
    tags: ['veggie', 'highFiber'],
    avoid: []
  },
  hummus: {
    title: 'Hummus', emoji: '🥣', slot: 'snack', role: 'side',
    slots: ['snack', 'side'],
    occasional: true,
    styles: ['balanced', 'lowcarb'], time: 8,
    ingredients: [['chickpeas', 80], ['olive-oil', 10], ['lemon', 8], ['garlic', 2]],
    toTaste: ['paprika', 'tahini'],
    steps: ['Mash or blend chickpeas with olive oil, lemon and garlic.', 'Loosen with a splash of water if needed.', 'Serve as a snack or side dip.'],
    tags: ['veggie', 'highFiber'],
    avoid: []
  },
  'boiled-eggs-veg-sticks': {
    title: 'Snack: Boiled eggs & veg sticks', emoji: '🥚', slot: 'snack', role: 'full',
    styles: ['highprotein', 'balanced'], time: 10,
    ingredients: [['eggs', 100], ['cucumber', 80]],
    toTaste: ['black pepper'],
    steps: ['Hard-boil the eggs (8-9 min) and cool.', 'Peel and halve the eggs.', 'Slice the cucumber and serve alongside.'],
    tags: ['muscle', 'quick'],
    avoid: []
  },

  /* ================= VARIETY-plan.md P3 — snacks ================= */

  // Generic "Yogurt & fruit" snack (task: options recipes). Yogurt + a fruit/nut topping via
  // optionGroups; maple base keeps the soy choice viable for a vegan (honey trips the vegan
  // filter). Soy carries dietKeys ['vegan','lactose-intolerant'] (planner offers it only to a
  // diet that needs it, so omnivore generation is unchanged); the recipe-screen default also
  // treats a lactose AVOIDER as lactose-intolerant so soy is their default too. Folds the former
  // Greek-yogurt+banana+honey and Greek-yogurt+honey+walnuts snacks.
  'yogurt-fruit-snack': {
    title: 'Yogurt & fruit', emoji: '🥣', slot: 'snack', role: 'full',
    season: 'evergreen',
    styles: ['balanced', 'highprotein'], time: 3,
    ingredients: [['maple-syrup', 8], ['chia-seeds', 4]],
    toTaste: [],
    steps: ['Spoon the yogurt into a bowl.', 'Add the fruit or topping.', 'Finish with a drizzle of maple syrup.'],
    tags: ['muscle'],
    avoid: [],
    optionGroups: [
      {
        key: 'yogurt', label: 'Yogurt',
        choices: [
          {id: 'greek', label: 'Greek yogurt', ingredients: [['greek-yogurt', 150]]},
          {id: 'skyr', label: 'Skyr', ingredients: [['skyr', 150]]},
          {id: 'soy', label: 'Soy yogurt', dietKeys: ['vegan', 'lactose-intolerant'], ingredients: [['soy-yogurt', 170]]}
        ]
      },
      {
        key: 'topping', label: 'Topping',
        choices: [
          {id: 'banana', label: 'Banana', ingredients: [['bananas', 90]]},
          {id: 'berries', label: 'Berries', ingredients: [['mixed-berries', 100]]},
          {id: 'peach', label: 'Peach', ingredients: [['peaches', 100]]},
          {id: 'walnuts', label: 'Walnuts', ingredients: [['walnuts', 15]]}
        ]
      }
    ]
  },
  'olives-feta-snack': {
    // Panel recipe pass (2026-08-30): 60g feta gave a 200 kcal snack ~10g saturated fat.
    // Trimmed feta to 40g and added cherry tomatoes for volume, colour and freshness. sat -> ~7.
    title: 'Snack: Feta, tomato & olives', emoji: '🫒', slot: 'snack', role: 'full',
    season: 'evergreen',
    styles: ['balanced', 'lowcarb'], time: 3,
    ingredients: [['feta-cheese', 40], ['olives', 30], ['cherry-tomatoes', 80]],
    toTaste: ['oregano', 'olive oil'],
    steps: ['Cube the feta and halve the cherry tomatoes.', 'Toss with the olives and a scatter of oregano.', 'Finish with a little olive oil and serve.'],
    tags: ['quick'],
    avoid: ['lactose']
  },
  'tuna-white-bean-snack': {
    title: 'Snack: Tuna & white bean bowl', emoji: '🐟', slot: 'snack', role: 'full',
    season: 'evergreen',
    styles: ['balanced', 'highprotein', 'lowcarb'], time: 5,
    ingredients: [['tuna-in-olive-oil', 90], ['cannellini-beans', 80], ['lemon', 8]],
    toTaste: ['black pepper'],
    steps: ['Drain and rinse the beans.', 'Flake the tuna over the beans.', 'Dress with lemon juice and black pepper.'],
    tags: ['muscle', 'omega3', 'highFiber'],
    avoid: []
  },
  'carrot-yogurt-dip-snack': {
    title: 'Snack: Carrot batons & lemony herb yogurt', emoji: '🥕', slot: 'snack', role: 'side',
    season: 'evergreen',
    slots: ['snack', 'side'],
    styles: ['balanced', 'lowcarb'], time: 6,
    ingredients: [['carrots', 150], ['greek-yogurt', 100], ['lemon', 8]],
    toTaste: ['dill or mint', 'cumin', 'black pepper', 'garlic'],
    steps: ['Cut the carrots into batons.', 'Stir the yogurt with lemon, garlic, cumin and chopped dill or mint.', 'Serve the carrot batons with the herby dip.'],
    tags: ['veggie', 'lowGI'],
    avoid: ['lactose']
  },
  'tofu-carrot-snack': {
    title: 'Snack: Sesame-soy tofu & carrot sticks', emoji: '🥢', slot: 'snack', role: 'full',
    season: 'evergreen',
    styles: ['balanced', 'lowcarb'], time: 5,
    ingredients: [['tofu', 150], ['carrots', 100]],
    toTaste: ['soy sauce', 'ginger', 'toasted sesame', 'chilli'],
    steps: ['Cube the tofu.', 'Grate or stick-cut the carrots.', 'Toss together with soy sauce, ginger, sesame and a pinch of chilli.'],
    tags: ['veggie', 'muscle'],
    avoid: []
  },

  /* ================= VEGAN snacks (multi-select diets batch) =================
     Measured gap: 4 vegan-viable snacks (carrots-over-hummus, brazil-nuts-apple,
     hummus-veg-sticks, this-file's tofu-carrot-snack above). These three bring the pool
     to 7 (target: >=6). */
  'roasted-chickpeas-snack': {
    title: 'Snack: Roasted chickpeas', emoji: '🫘', slot: 'snack', role: 'side',
    season: 'evergreen',
    slots: ['snack', 'side'],
    styles: ['balanced', 'lowcarb', 'highprotein'], time: 8,
    ingredients: [['chickpeas', 90], ['olive-oil', 8]],
    toTaste: ['paprika', 'black pepper'],
    steps: ['Pat the chickpeas dry.', 'Toss with olive oil, paprika and black pepper.', 'Roast or pan-fry until golden, about 6 min.'],
    tags: ['veggie', 'highFiber'],
    avoid: []
  },
  'apple-almonds-snack': {
    title: 'Snack: Apple & almonds', emoji: '🍎', slot: 'snack', role: 'full',
    season: 'winter/autumn',
    styles: ['balanced', 'lowcarb'], time: 2,
    ingredients: [['apples', 150], ['almonds', 20]],
    toTaste: [],
    steps: ['Wash and slice the apple.', 'Portion the almonds.', 'Serve together.'],
    tags: ['veggie', 'lowGI'],
    avoid: ['nuts']
  },
  'dark-chocolate-walnuts-snack': {
    title: 'Snack: Dark chocolate & walnuts', emoji: '🍫', slot: 'snack', role: 'full',
    season: 'evergreen',
    styles: ['balanced', 'lowcarb'], time: 1,
    ingredients: [['dark-chocolate-85', 20], ['walnuts', 20]],
    toTaste: [],
    steps: ['Break the chocolate into a few squares.', 'Portion the walnuts.', 'Serve together.'],
    tags: ['veggie', 'highFiber', 'omega3'],
    avoid: ['nuts']
  },

  'gelato-cioccolato': {
    title: 'Chocolate ice cream', emoji: '🍨', slot: 'snack', role: 'full',
    imageKey: 'ice-cream',
    occasional: true,
    styles: ['balanced'], time: 1,
    ingredients: [['milk', 90], ['greek-yogurt', 50], ['honey', 18], ['dark-chocolate-85', 24]],
    toTaste: [],
    steps: ['Scoop the chocolate gelato into a small bowl.', 'Shave or crumble the dark chocolate over the top.', 'Eat slowly enough that it still feels like a treat.'],
    tags: [],
    avoid: ['lactose']
  },
  'gelato-stracciatella': {
    title: 'Stracciatella ice cream', emoji: '🍨', slot: 'snack', role: 'full',
    imageKey: 'ice-cream',
    occasional: true,
    styles: ['balanced'], time: 1,
    ingredients: [['milk', 110], ['greek-yogurt', 40], ['honey', 18], ['dark-chocolate-85', 12], ['vanilla', 2]],
    toTaste: [],
    steps: ['Scoop the stracciatella gelato into a bowl.', 'Add a few dark chocolate shavings if wanted.', 'Serve straight away.'],
    tags: [],
    avoid: ['lactose']
  },
  'gelato-yogurt': {
    title: 'Yogurt ice cream', emoji: '🍦', slot: 'snack', role: 'full',
    imageKey: 'ice-cream',
    occasional: true,
    styles: ['balanced'], time: 2,
    ingredients: [['greek-yogurt', 120], ['milk', 40], ['honey', 18], ['strawberries', 30]],
    toTaste: [],
    steps: ['Scoop the yogurt gelato into a bowl.', 'Add the berries on top.', 'Serve immediately.'],
    tags: [],
    avoid: ['lactose']
  },
  'gelato-crema': {
    title: 'Vanilla custard ice cream', emoji: '🍨', slot: 'snack', role: 'full',
    imageKey: 'ice-cream',
    occasional: true,
    styles: ['balanced'], time: 1,
    ingredients: [['milk', 120], ['eggs', 25], ['honey', 18], ['vanilla', 2], ['cinnamon', 1]],
    toTaste: [],
    steps: ['Scoop the crema gelato into a bowl.', 'Dust with a tiny pinch of vanilla or cinnamon if wanted.', 'Serve immediately.'],
    tags: [],
    avoid: ['lactose']
  },
  'brownie-dessert': {
    title: 'Brownie', emoji: '🍫', slot: 'snack', role: 'full',
    imageKey: 'dessert-sweets',
    season: 'evergreen',
    occasional: true,
    styles: ['balanced'], time: 45, servings: 12,
    ingredients: [['dark-chocolate-85', 200], ['butter', 150], ['granulated-sugar', 200], ['eggs', 150], ['00-flour', 120]],
    toTaste: ['vanilla', 'salt'],
    steps: ['Melt the dark chocolate with the butter over a gentle heat, then let it cool slightly.', 'Whisk the eggs with the sugar until pale, then stir in the melted chocolate and butter.', 'Fold in the flour and a pinch of salt until just combined.', 'Pour into a lined tin and bake at 180C for 20-25 min until set with a slight fudgy wobble.', 'Cool, cut into 12 squares, and serve with a small glass of milk if wanted. Log it without making a moral drama out of it.'],
    tags: [],
    avoid: ['gluten', 'lactose']
  },
  // McDonald's / Burger King "menu" MEALS (owner spec 2026-08-31; nutrition from the brands' own
  // sites). Each brand menu is now a Meal — a recipe-of-recipes (`components`) — combining a burger
  // menu (burger + fries + drink) with a 4-piece nuggets, exactly as the owner ordered them. The
  // four component recipes are defined first; the two composites at the end reference them. All
  // OCCASIONAL (searchable/loggable, never auto-planned) and deliberately unhealthy — left as-is
  // nutritionally. Component nutrition uses the fast-food ESTIMATE foods added in foods.js.
  // Big Mac menu, divided into its sub-items (owner spec 2026-08-31) so each can be removed or
  // rescaled independently in the "Made of" list: the burger, the fries and the drink. The drink
  // defaults to Coca-Cola ZERO (no sugar) with full-sugar Coke as an option (its optionGroup).
  'mcd-big-mac': {
    title: 'Big Mac', emoji: '🍔', slot: 'snack', role: 'full',
    slots: ['snack', 'side'], occasional: true,
    styles: ['balanced'], time: 3,
    ingredients: [['big-mac', 215]],
    toTaste: [],
    steps: ['Order a Big Mac.', 'Log it as one item.', 'Adjust with servings for a different burger size.'],
    tags: [], avoid: ['gluten', 'lactose']
  },
  'mcd-fries': {
    title: 'Large fries', emoji: '🍟', slot: 'snack', role: 'full',
    slots: ['snack', 'side'], occasional: true,
    styles: ['balanced'], time: 3,
    ingredients: [['fast-food-fries', 150]],
    toTaste: ['salt'],
    steps: ['Order a large fries.', 'Log it as one item.', 'Adjust with servings for a smaller or larger portion.'],
    tags: [], avoid: []
  },
  'mcd-drink': {
    title: 'Soft drink', emoji: '🥤', slot: 'snack', role: 'full',
    slots: ['snack', 'side'], occasional: true,
    styles: ['balanced'], time: 1,
    ingredients: [],
    optionGroups: [
      {key: 'drink', label: 'Drink', choices: [
        {id: 'coke-zero', label: 'Coca-Cola Zero', ingredients: [['cola-zero', 500]]},
        {id: 'coke', label: 'Coca-Cola', ingredients: [['cola', 500]]}
      ]}
    ],
    toTaste: [],
    steps: ['Choose your drink — Coca-Cola Zero by default, or switch to regular Coca-Cola.', 'Log it as one item.', 'Adjust with servings for a different size.'],
    tags: [], avoid: []
  },
  'mcd-bigmac-menu': {
    title: 'Big Mac menu (large)', emoji: '🍔', slot: 'dinner', role: 'full',
    imageKey: 'fast-food-menu', slots: ['dinner', 'lunch'], occasional: true,
    styles: ['balanced'], time: 5,
    ingredients: [],
    components: [
      {recipeId: 'mcd-big-mac', portion: 1},
      {recipeId: 'mcd-fries', portion: 1},
      {recipeId: 'mcd-drink', portion: 1}
    ],
    toTaste: [],
    steps: ['A Big Mac, large fries and a drink (Coca-Cola Zero by default).', 'Tweak any item — remove it or change its portion — in the list above.', 'Log it as one meal.'],
    tags: [], avoid: ['gluten', 'lactose']
  },
  'mcd-nuggets-4': {
    title: 'Chicken McNuggets (4 pc)', emoji: '🍗', slot: 'snack', role: 'full',
    slots: ['snack', 'side'], occasional: true,
    styles: ['balanced'], time: 5,
    ingredients: [['fast-food-nuggets', 64], ['ketchup', 15]],
    toTaste: [],
    steps: ['Order a 4-piece Chicken McNuggets with a dip.', 'Log it as one item.', 'Adjust with servings if you had more or fewer.'],
    tags: [], avoid: ['gluten']
  },
  // Bacon King menu, divided into its sub-items (owner spec 2026-08-31) — same as the Big Mac menu:
  // the burger, the fries and the drink, each removable/rescalable in the "Made of" list, with the
  // drink defaulting to Coca-Cola Zero (full-sugar Coke as an option).
  'bk-bacon-king': {
    title: 'Bacon King', emoji: '🍔', slot: 'snack', role: 'full',
    slots: ['snack', 'side'], occasional: true,
    styles: ['balanced'], time: 3,
    ingredients: [['bacon-king', 290]],
    toTaste: [],
    steps: ['Order a Bacon King.', 'Log it as one item.', 'Adjust with servings for a different burger size.'],
    tags: [], avoid: ['gluten', 'lactose']
  },
  'bk-fries': {
    title: 'Fries', emoji: '🍟', slot: 'snack', role: 'full',
    slots: ['snack', 'side'], occasional: true,
    styles: ['balanced'], time: 3,
    ingredients: [['fast-food-fries', 91]],
    toTaste: ['salt'],
    steps: ['Order a fries.', 'Log it as one item.', 'Adjust with servings for a smaller or larger portion.'],
    tags: [], avoid: []
  },
  'bk-drink': {
    title: 'Soft drink', emoji: '🥤', slot: 'snack', role: 'full',
    slots: ['snack', 'side'], occasional: true,
    styles: ['balanced'], time: 1,
    ingredients: [],
    optionGroups: [
      {key: 'drink', label: 'Drink', choices: [
        {id: 'coke-zero', label: 'Coca-Cola Zero', ingredients: [['cola-zero', 500]]},
        {id: 'coke', label: 'Coca-Cola', ingredients: [['cola', 500]]}
      ]}
    ],
    toTaste: [],
    steps: ['Choose your drink — Coca-Cola Zero by default, or switch to regular Coca-Cola.', 'Log it as one item.', 'Adjust with servings for a different size.'],
    tags: [], avoid: []
  },
  'bk-baconking-menu': {
    title: 'Bacon King menu', emoji: '🍔', slot: 'dinner', role: 'full',
    imageKey: 'fast-food-menu', slots: ['dinner', 'lunch'], occasional: true,
    styles: ['balanced'], time: 5,
    ingredients: [],
    components: [
      {recipeId: 'bk-bacon-king', portion: 1},
      {recipeId: 'bk-fries', portion: 1},
      {recipeId: 'bk-drink', portion: 1}
    ],
    toTaste: [],
    steps: ['A Bacon King, fries and a drink (Coca-Cola Zero by default).', 'Tweak any item — remove it or change its portion — in the list above.', 'Log it as one meal.'],
    tags: [], avoid: ['gluten', 'lactose']
  },
  'bk-nuggets-4': {
    title: 'Chicken nuggets (4 pc)', emoji: '🍗', slot: 'snack', role: 'full',
    slots: ['snack', 'side'], occasional: true,
    styles: ['balanced'], time: 5,
    ingredients: [['fast-food-nuggets', 69], ['ketchup', 15]],
    toTaste: [],
    steps: ['Order a 4-piece chicken nuggets with a dip.', 'Log it as one item.', 'Adjust with servings if you had more or fewer.'],
    tags: [], avoid: ['gluten']
  },
  'mcdonald-menu': {
    title: "McDonald's menu", emoji: '🍔', slot: 'dinner', role: 'full',
    imageKey: 'fast-food-menu',
    slots: ['dinner', 'lunch'],
    occasional: true,
    styles: ['balanced'], time: 5,
    ingredients: [],
    components: [
      {recipeId: 'mcd-bigmac-menu', portion: 1},
      {recipeId: 'mcd-nuggets-4', portion: 1}
    ],
    toTaste: [],
    steps: ['A Big Mac menu (large) plus a 4-piece McNuggets.', 'Order it, then log the whole menu as one meal.', 'Adjust with servings if your order was larger or smaller.'],
    tags: [],
    avoid: ['gluten', 'lactose']
  },
  'burger-king-menu': {
    title: 'Burger King menu', emoji: '🍔', slot: 'dinner', role: 'full',
    imageKey: 'fast-food-menu',
    slots: ['dinner', 'lunch'],
    occasional: true,
    styles: ['balanced'], time: 5,
    ingredients: [],
    components: [
      {recipeId: 'bk-baconking-menu', portion: 1},
      {recipeId: 'bk-nuggets-4', portion: 1}
    ],
    toTaste: [],
    steps: ['A Bacon King menu plus a 4-piece chicken nuggets.', 'Order it, then log the whole menu as one meal.', 'Adjust with servings if your order was larger or smaller.'],
    tags: [],
    avoid: ['gluten', 'lactose']
  },

  /* ================= MEDITERRANEAN/ITALIAN + EAST-SE ASIAN batch (recipe-pool-balance task) —
     ~half fish/seafood, ~half poultry/eggs, no tofu (legumes/beans carry the fiber lever
     instead). Full lunch/dinner meals sized for isCompleteLunchDinnerRecipe (>=12g protein,
     a carb ingredient contributing >=15g carbs, >=80g Produce); most land ~8-14g fiber, with
     a few naturally higher (bean/lentil/chickpea-based) and a couple lighter for variety, per
     recipeMacros(id) computed against the real food DB — see task report for the numbers. */

  'chicken-lentil-stew-broccoli': {
    title: 'Chicken & lentil stew with broccoli', emoji: '🍲', slot: 'dinner', role: 'full', season: 'evergreen',
    slots: ['lunch', 'dinner'],
    styles: ['balanced', 'highprotein'], time: 28,
    ingredients: [['chicken-breast', 130], ['cooked-lentils', 130], ['tomato-passata', 100], ['broccoli', 130], ['olive-oil', 8]],
    toTaste: ['garlic', 'oregano', 'black pepper'],
    steps: ['Cook the chicken breast until browned and cooked through, then slice.', 'Simmer the cooked lentils with tomato passata, garlic and oregano for 8-10 min.', 'Steam the broccoli until tender.', 'Stir the sliced chicken through the lentil stew.', 'Serve with the broccoli alongside, finished with olive oil.'],
    tags: ['highFiber', 'muscle', 'heart'],
    avoid: []
  },
  'prawn-courgette-wholegrain-linguine': {
    title: 'Prawn & courgette wholegrain linguine', emoji: '🍤', slot: 'dinner', role: 'full', season: 'evergreen',
    slots: ['lunch', 'dinner'],
    styles: ['balanced', 'highprotein'], time: 22,
    ingredients: [['prawns', 180], ['wholegrain-pasta', 80], ['courgette', 150], ['cherry-tomatoes', 100], ['olive-oil', 10], ['garlic', 5]],
    toTaste: ['lemon', 'parsley', 'chilli if wanted'],
    steps: ['Cook the wholegrain linguine according to the packet.', 'Pan-sear the prawns with garlic in olive oil until pink, 2-3 min.', 'Add the courgette ribbons and cherry tomatoes, tossing until just softened.', 'Toss everything with the drained pasta and a squeeze of lemon.'],
    tags: ['muscle', 'highFiber'],
    avoid: ['shellfish']
  },
  'chicken-vegetable-egg-fried-rice': {
    title: 'Chicken & vegetable egg fried rice', emoji: '🍳', slot: 'dinner', role: 'full', season: 'evergreen',
    slots: ['lunch', 'dinner'],
    styles: ['balanced', 'highprotein'], time: 22,
    ingredients: [['chicken-breast', 130], ['rice', 55], ['eggs', 50], ['pak-choy', 180], ['mushrooms', 100], ['carrots', 70], ['soy-sauce', 12], ['olive-oil', 8]],
    toTaste: ['ginger', 'garlic'],
    steps: ['Cook the rice and let it cool slightly.', 'Stir-fry the chicken in olive oil until cooked through.', 'Add the mushrooms, pak choy and carrots, stir-frying until just tender.', 'Push everything aside, scramble the egg in the pan, then mix through.', 'Add the rice and soy sauce with ginger and garlic, tossing well to combine.'],
    tags: ['muscle', 'quick'],
    avoid: []
  },
  'coconut-chicken-chickpea-curry-rice': {
    title: 'Coconut chicken & chickpea curry with rice', emoji: '🍛', slot: 'dinner', role: 'full', season: 'evergreen',
    slots: ['lunch', 'dinner'],
    styles: ['balanced', 'highprotein'], time: 30,
    ingredients: [['chicken-breast', 120], ['chickpeas', 120], ['coconut-milk', 20], ['bell-pepper', 80], ['spinach', 60], ['rice', 45], ['ginger', 8], ['garlic', 5], ['olive-oil', 4]],
    toTaste: ['curry spices', 'lime'],
    steps: ['Cook the rice separately.', 'Cook the chicken with ginger and garlic until browned.', 'Add the chickpeas, bell pepper and coconut milk; simmer 10-12 min with curry spices.', 'Stir in the spinach until just wilted.', 'Serve the curry over the rice.'],
    tags: ['highFiber', 'muscle'],
    avoid: []
  },
  'cod-vegetable-noodle-soup': {
    title: 'Cod & vegetable noodle soup', emoji: '🍜', slot: 'dinner', role: 'full', season: 'evergreen',
    slots: ['lunch', 'dinner'],
    styles: ['balanced', 'highprotein'], time: 25,
    ingredients: [['cod', 180], ['egg-noodles', 70], ['pak-choy', 150], ['carrots', 70], ['mushrooms', 80], ['soy-sauce', 12], ['ginger', 8], ['garlic', 5], ['olive-oil', 5]],
    toTaste: ['lime', 'coriander'],
    steps: ['Simmer a light broth with soy sauce, ginger and garlic.', 'Add the noodles and mushrooms, cooking until the noodles are almost tender.', 'Add the pak choy and carrots, simmering briefly.', 'Slide in the cod pieces and poach gently until just cooked, 4-5 min.', 'Ladle into bowls and finish with lime.'],
    tags: ['muscle', 'quick'],
    avoid: ['gluten']
  },
  'white-beans-tomato-poached-eggs': {
    title: 'White beans, tomato & poached eggs', emoji: '🍳', slot: 'breakfast', role: 'full', season: 'evergreen',
    styles: ['balanced', 'highprotein'], time: 15,
    ingredients: [['cannellini-beans', 120], ['tomatoes', 150], ['eggs', 100], ['spinach', 40], ['olive-oil', 8]],
    toTaste: ['garlic', 'herbs', 'black pepper'],
    steps: ['Warm the cannellini beans with the tomatoes, garlic and a little olive oil.', 'Wilt the spinach into the bean mixture.', 'Poach or fry the eggs.', 'Spoon the bean and tomato mixture into a bowl and top with the eggs.'],
    tags: ['muscle', 'highFiber', 'heart'],
    avoid: []
  },
  'ginger-egg-pak-choy-rice-bowl': {
    title: 'Ginger egg, pak choy & rice bowl', emoji: '🍳', slot: 'breakfast', role: 'full', season: 'evergreen',
    styles: ['balanced'], time: 15,
    ingredients: [['eggs', 100], ['pak-choy', 150], ['rice', 45], ['mushrooms', 60], ['soy-sauce', 10], ['ginger', 6], ['olive-oil', 5]],
    toTaste: ['garlic'],
    steps: ['Cook the rice.', 'Sauté the pak choy and mushrooms in olive oil with ginger and garlic.', 'Push aside and scramble the eggs in the same pan.', 'Combine with the rice and finish with a drizzle of soy sauce.'],
    tags: ['muscle', 'quick'],
    avoid: []
  },
  'ginger-lime-chickpea-carrot-snack': {
    title: 'Snack: Ginger-lime chickpea & carrot salad', emoji: '🥗', slot: 'snack', role: 'full', season: 'evergreen',
    styles: ['balanced'], time: 8,
    ingredients: [['chickpeas', 90], ['carrots', 80], ['cucumber', 60], ['soy-sauce', 8], ['lime', 8], ['olive-oil', 6]],
    toTaste: ['ginger', 'coriander'],
    steps: ['Toss the chickpeas with carrots and cucumber.', 'Whisk together soy sauce, lime juice and olive oil.', 'Dress the salad and toss well.', 'Serve chilled, finished with coriander if wanted.'],
    tags: ['veggie', 'highFiber'],
    avoid: []
  },

  /* ================= PANEL RECIPE PASS — NEW DISHES (2026-08-30) =================
     Added by the chef (neuro-food-marketing) + nutritionist panel to raise culinary
     variety/appeal and fill real gaps: a vegan+GF+nut-free breakfast, lower-calorie
     satisfying dinners, and a low-cal high-fibre snack — all composed from existing
     foods, nutrition = sum(ingredients), each within its slot's KCAL_BAND. */
  'spaghetti-puttanesca-tonno': {
    title: 'Spaghetti puttanesca with tuna', emoji: '🍝', slot: 'dinner', role: 'full',
    season: 'evergreen', styles: ['balanced', 'highprotein'], time: 22,
    ingredients: [['spaghetti', 80], ['tuna-in-olive-oil', 80], ['tomato-passata', 120], ['olives', 25], ['capers', 12], ['olive-oil', 6]],
    toTaste: ['garlic', 'chilli flakes', 'parsley', 'oregano'],
    steps: ['Cook the spaghetti until al dente.', 'Warm the passata with garlic and chilli, then stir in the olives, capers and flaked tuna.', 'Toss the pasta through the sauce and finish with parsley.'],
    tags: ['muscle', 'omega3'],
    avoid: ['gluten']
  },
  'spaghetti-vongole': {
    title: 'Spaghetti alle vongole', emoji: '🍝', slot: 'dinner', role: 'full',
    season: 'evergreen', styles: ['balanced', 'highprotein'], time: 25,
    ingredients: [['spaghetti', 90], ['clams', 150], ['cherry-tomatoes', 80], ['olive-oil', 10]],
    toTaste: ['garlic', 'chilli', 'parsley', 'lemon'],
    steps: ['Cook the spaghetti until al dente.', 'Open the clams in a hot pan with garlic, chilli and a splash of water; add the halved tomatoes.', 'Toss the pasta through the glossy clam sauce with parsley and lemon.'],
    tags: ['muscle'],
    avoid: ['gluten', 'shellfish']
  },
  'bresaola-rucola-parmigiano': {
    title: 'Bresaola, rocket & parmesan crostini salad', emoji: '🥩', slot: 'lunch', role: 'full',
    season: 'evergreen', styles: ['balanced', 'highprotein'], time: 10,
    ingredients: [['bresaola', 70], ['rocket-arugula', 40], ['parmesan', 20], ['cherry-tomatoes', 80], ['wholewheat-bread', 60], ['olive-oil', 8]],
    toTaste: ['lemon', 'black pepper'],
    steps: ['Toast the bread and rub with a little olive oil.', 'Pile the bresaola over the rocket and tomatoes.', 'Shave the parmesan on top and dress with olive oil, lemon and black pepper.'],
    tags: ['muscle', 'quick'],
    avoid: ['gluten', 'lactose']
  },
  'spigola-acqua-pazza': {
    title: 'Sea bass acqua pazza', emoji: '🐟', slot: 'dinner', role: 'full',
    season: 'evergreen', styles: ['balanced', 'highprotein', 'lowcarb'], time: 30,
    ingredients: [['sea-bass-fillet', 200], ['cherry-tomatoes', 120], ['olives', 20], ['capers', 10], ['potatoes', 130], ['olive-oil', 12]],
    toTaste: ['garlic', 'parsley', 'chilli'],
    steps: ['Simmer the potatoes until nearly tender.', 'Poach the sea bass in a light broth of tomatoes, olives, capers and garlic.', 'Serve the fish in its broth with the potatoes and parsley.'],
    tags: ['muscle', 'thyroid', 'lowGI'],
    avoid: []
  },
  'caponata-ceci': {
    title: 'Sicilian aubergine caponata with chickpeas', emoji: '🍆', slot: 'dinner', role: 'full',
    season: 'evergreen', styles: ['balanced'], time: 30,
    ingredients: [['aubergine', 200], ['chickpeas', 150], ['tomato-passata', 120], ['olives', 20], ['capers', 10], ['olive-oil', 12]],
    toTaste: ['garlic', 'oregano', 'basil', 'chilli', 'a splash of balsamic'],
    steps: ['Roast or fry the aubergine until golden and silky.', 'Simmer with the passata, olives, capers and a splash of balsamic for the sweet-sour hit.', 'Fold through the chickpeas, warm and finish with basil.'],
    tags: ['veggie', 'highFiber', 'heart'],
    avoid: []
  },
  'farro-pomodoro-feta': {
    title: 'Farro, tomato, feta & basil salad', emoji: '🥗', slot: 'lunch', role: 'full',
    season: 'evergreen', styles: ['balanced'], time: 15,
    ingredients: [['farro-cooked', 150], ['cherry-tomatoes', 120], ['feta-cheese', 40], ['cucumber', 80], ['olives', 20], ['olive-oil', 8]],
    toTaste: ['basil', 'oregano', 'lemon or balsamic', 'black pepper'],
    steps: ['Toss the cooked farro with the tomatoes, cucumber and olives.', 'Crumble over the feta.', 'Dress with olive oil, lemon or balsamic, basil and black pepper.'],
    tags: ['veggie', 'highFiber'],
    avoid: ['gluten', 'lactose']
  },
  'ricotta-pomodoro-toast': {
    title: 'Whipped ricotta & blistered tomato toast', emoji: '🍅', slot: 'breakfast', role: 'full',
    season: 'evergreen', styles: ['balanced'], time: 8,
    ingredients: [['wholewheat-bread', 70], ['ricotta', 70], ['cherry-tomatoes', 80], ['olive-oil', 5]],
    toTaste: ['basil', 'lemon zest', 'chilli flakes', 'black pepper'],
    steps: ['Toast the bread.', 'Whip the ricotta with lemon zest and spread thickly.', 'Blister the cherry tomatoes in the olive oil and pile on top with basil and chilli.'],
    tags: ['veggie'],
    avoid: ['gluten', 'lactose']
  },
  'salmon-avocado-rice-bowl': {
    title: 'Salmon & avocado rice bowl', emoji: '🍣', slot: 'dinner', role: 'full',
    season: 'evergreen', styles: ['balanced', 'highprotein'], time: 20,
    ingredients: [['salmon-fillet', 130], ['rice', 55], ['avocado', 60], ['cucumber', 60], ['carrots', 40], ['soy-sauce', 12]],
    toTaste: ['toasted sesame', 'lime', 'ginger', 'chilli'],
    steps: ['Cook the rice and let it cool a little.', 'Sear or bake the salmon, then flake it over the rice.', 'Add sliced avocado, cucumber and carrot; finish with soy, sesame, lime and ginger.'],
    tags: ['muscle', 'omega3'],
    avoid: []
  },
  'caprese-skewers-snack': {
    title: 'Snack: Caprese skewers', emoji: '🍅', slot: 'snack', role: 'full',
    season: 'evergreen', styles: ['balanced', 'lowcarb'], time: 5,
    ingredients: [['mozzarella', 50], ['cherry-tomatoes', 80], ['olive-oil', 4]],
    toTaste: ['basil', 'balsamic glaze', 'black pepper'],
    steps: ['Thread the mozzarella and cherry tomatoes onto skewers with basil leaves.', 'Drizzle with olive oil and a little balsamic.', 'Finish with black pepper and serve.'],
    tags: ['veggie', 'quick'],
    avoid: ['lactose']
  },
  'berry-chia-soy-pudding': {
    title: 'Berry chia & soy pudding', emoji: '🫐', slot: 'breakfast', role: 'full',
    season: 'evergreen', styles: ['balanced'], time: 5,
    ingredients: [['chia-seeds', 20], ['soy-milk', 200], ['bananas', 80], ['mixed-berries', 60], ['pumpkin-seeds', 15]],
    toTaste: ['cinnamon'],
    steps: ['Stir the chia seeds into the soy milk and chill overnight.', 'Stir again and mash in half the banana for sweetness.', 'Top with the remaining banana, berries and pumpkin seeds.'],
    tags: ['veggie', 'highFiber', 'omega3', 'heart'],
    avoid: []
  },
  'sea-bass-greens-potato': {
    title: 'Sea bass, green beans & new potatoes', emoji: '🐟', slot: 'dinner', role: 'full',
    season: 'evergreen', styles: ['balanced', 'highprotein', 'lowcarb'], time: 25,
    ingredients: [['sea-bass-fillet', 200], ['green-beans', 150], ['cherry-tomatoes', 120], ['potatoes', 120], ['olive-oil', 10]],
    toTaste: ['lemon', 'garlic', 'parsley'],
    steps: ['Boil the new potatoes until tender.', 'Pan-fry the sea bass skin-side down until crisp.', 'Blanch the green beans and burst the tomatoes; plate with the fish, lemon and parsley.'],
    tags: ['muscle', 'thyroid', 'lowGI', 'heart'],
    avoid: []
  },
  'cannellini-carrot-lemon-dip': {
    title: 'Snack: White bean & carrot dip', emoji: '🥕', slot: 'snack', role: 'full',
    season: 'evergreen', styles: ['balanced', 'lowcarb'], time: 6,
    ingredients: [['cannellini-beans', 80], ['carrots', 100], ['lemon', 8], ['olive-oil', 5]],
    toTaste: ['garlic', 'cumin', 'black pepper'],
    steps: ['Blitz or mash the cannellini beans with lemon, garlic and cumin.', 'Cut the carrots into batons.', 'Serve the batons with the dip and a drizzle of olive oil.'],
    tags: ['veggie', 'highFiber', 'heart'],
    avoid: []
  },

  // ── Instagram-inspired batch #1 (2026-08-31) ──────────────────────────────
  // Built from full-recipe captions Elena saved (see session ig-recipes.md). Chef+nutritionist pass:
  // savoury mains lightened (butter/oil trimmed, veg + protein anchored to keep day-balance green);
  // the dessert stays `occasional`, kept as-is. New foods added to foods.js: rice-paper, nori,
  // almond-flour. Sources credited in each recipe's notes via the originating creator.
  'peanut-tofu-noodles': {
    title: 'Peanut butter tofu noodles', emoji: '🍜', slot: 'dinner', role: 'full',
    season: 'evergreen', styles: ['balanced', 'highprotein'], time: 20,
    ingredients: [['egg-noodles', 85], ['tofu', 130], ['peanut-butter', 26], ['carrots', 60], ['bell-pepper', 60], ['soy-sauce', 15], ['honey', 6], ['olive-oil', 5]],
    toTaste: ['garlic', 'ginger', 'lime', 'chilli', 'sesame', 'coriander'],
    steps: ['Cook the noodles; press and cube the tofu and pan-sear until golden.', 'Whisk peanut butter, soy, honey, grated ginger, garlic, lime and a splash of noodle water into a glossy sauce.', 'Toss noodles, tofu, ribboned carrot and pepper through the sauce; finish with chilli, sesame and coriander.'],
    tags: ['muscle', 'veggie'],
    avoid: ['gluten', 'nuts']
  },
  'turkish-eggs-cilbir': {
    title: 'Turkish eggs (çılbır)', emoji: '🍳', slot: 'breakfast', role: 'full',
    season: 'evergreen', styles: ['balanced', 'highprotein'], time: 15,
    ingredients: [['eggs', 120], ['greek-yogurt', 180], ['butter', 12], ['olive-oil', 3]],
    toTaste: ['garlic', 'dill', 'chilli', 'lemon', 'salt'],
    steps: ['Stir grated garlic and a pinch of salt through the yogurt and spread on a plate.', 'Poach the eggs and set them on the yogurt.', 'Melt the butter with a little oil and chilli flakes until foaming; spoon over and scatter dill.'],
    tags: ['muscle', 'veggie'],
    avoid: ['lactose']
  },
  'confit-cherry-tomatoes': {
    title: 'Confit cherry tomatoes', emoji: '🍅', slot: 'side', role: 'side',
    season: 'evergreen', styles: ['balanced', 'lowcarb'], time: 45,
    ingredients: [['cherry-tomatoes', 200], ['olive-oil', 12], ['granulated-sugar', 3]],
    toTaste: ['garlic', 'thyme', 'lemon', 'salt'],
    steps: ['Nestle the tomatoes in a small dish with garlic, thyme and lemon zest.', 'Barely cover with olive oil and a pinch of sugar and salt.', 'Slow-roast at 150°C for ~40 min until slumped and sweet; serve on toast, yogurt or pasta.'],
    tags: ['veggie', 'heart'],
    avoid: []
  },
  'baked-berry-yogurt': {
    title: 'Baked berry yogurt breakfast', emoji: '🫐', slot: 'breakfast', role: 'full',
    season: 'evergreen', styles: ['balanced', 'highprotein'], time: 30,
    ingredients: [['greek-yogurt', 170], ['eggs', 100], ['almond-flour', 12], ['mixed-berries', 80], ['honey', 6]],
    toTaste: ['vanilla', 'cinnamon'],
    steps: ['Whisk yogurt, eggs, almond flour and vanilla until smooth.', 'Fold in half the berries and pour into a small baking dish.', 'Top with the rest of the berries and bake at 175°C for ~20 min until just set; drizzle with honey.'],
    tags: ['muscle', 'veggie'],
    avoid: ['lactose', 'nuts']
  },
  'crema-di-zucca-ricotta': {
    title: 'Squash soup with ricotta', emoji: '🎃', slot: 'dinner', role: 'full',
    season: 'winter/autumn', styles: ['balanced'], time: 35,
    ingredients: [['pumpkin', 350], ['potatoes', 120], ['carrots', 60], ['red-onion', 40], ['cannellini-beans', 100], ['olive-oil', 10], ['ricotta', 40]],
    toTaste: ['ginger', 'garlic', 'rosemary', 'nutmeg', 'chilli', 'salt'],
    steps: ['Soften onion, carrot, garlic and ginger in the oil; add squash and potato.', 'Cover with water and simmer until tender, then blend smooth with the beans for body and protein.', 'Season with nutmeg and rosemary; swirl ricotta through each bowl.'],
    tags: ['veggie', 'highFiber', 'heart'],
    avoid: ['lactose']
  },
  'sweet-potato-gnocchi-sage': {
    title: 'Sweet-potato gnocchi, sage butter', emoji: '🍠', slot: 'dinner', role: 'full',
    season: 'winter/autumn', styles: ['balanced'], time: 40,
    ingredients: [['sweet-potato', 180], ['potatoes', 130], ['00-flour', 80], ['eggs', 20], ['butter', 16], ['parmesan', 18]],
    toTaste: ['sage', 'garlic', 'nutmeg', 'black pepper', 'salt'],
    steps: ['Bake the sweet potato and potato, then rice them and cool.', 'Work in the egg yolk and just enough flour to form a soft dough; roll, cut and mark the gnocchi.', 'Boil until they float; toss through gently browned butter with sage and a little parmesan.'],
    tags: ['veggie'],
    avoid: ['gluten', 'lactose']
  },
  'ham-egg-in-a-hole': {
    title: 'Ham & egg in a hole', emoji: '🥚', slot: 'breakfast', role: 'full',
    season: 'evergreen', styles: ['balanced', 'highprotein'], time: 20,
    ingredients: [['wholewheat-bread', 60], ['eggs', 60], ['prosciutto-cotto', 30], ['scamorza', 25], ['butter', 6]],
    toTaste: ['chives', 'black pepper', 'salt'],
    steps: ['Press a hollow in the bread, butter the edges and lay ham in the well.', 'Crack an egg into the hollow and scatter grated scamorza on the rim.', 'Bake at 180°C for ~12–15 min until the white is set; finish with chives and pepper.'],
    tags: ['muscle', 'quick'],
    avoid: ['gluten', 'lactose']
  },
  'savoury-breakfast-muffins': {
    title: 'Savoury cheese & herb muffins', emoji: '🧁', slot: 'breakfast', role: 'full',
    season: 'evergreen', styles: ['balanced'], time: 30,
    ingredients: [['00-flour', 55], ['eggs', 55], ['greek-yogurt', 40], ['olive-oil', 12], ['parmesan', 20], ['mozzarella', 15], ['bell-pepper', 25], ['red-onion', 10]],
    toTaste: ['dill', 'basil', 'chilli', 'baking powder', 'garlic', 'salt'],
    steps: ['Whisk eggs, yogurt and oil, then fold in flour with baking powder.', 'Stir through the cheeses, diced pepper, onion and herbs.', 'Spoon into a muffin tin and bake at 200°C for ~18 min until golden.'],
    tags: ['muscle', 'veggie'],
    avoid: ['gluten', 'lactose']
  },
  'crispy-ricepaper-sushi': {
    title: 'Crispy rice-paper sushi rolls', emoji: '🍣', slot: 'dinner', role: 'full',
    season: 'evergreen', styles: ['balanced', 'highprotein'], time: 25,
    ingredients: [['rice-paper', 44], ['nori', 9], ['tofu', 150], ['rice', 55], ['avocado', 50], ['cucumber', 60], ['carrots', 40], ['soy-sauce', 12], ['olive-oil', 6]],
    toTaste: ['ginger', 'sesame', 'chilli', 'lime'],
    steps: ['Cook and season the rice; cut tofu, avocado, cucumber and carrot into batons.', 'Lay a nori sheet on a dampened rice-paper wrapper, add rice and fillings, and roll tightly.', 'Pan-fry in a little oil until crisp all over; slice and serve with soy, ginger and chilli.'],
    tags: ['muscle', 'veggie', 'highFiber'],
    avoid: []
  },
  'choc-yogurt-cheesecake': {
    title: 'Chocolate yogurt cheesecake', emoji: '🍫', slot: 'snack', role: 'full', occasional: true,
    season: 'evergreen', styles: ['balanced'], time: 35,
    ingredients: [['dark-chocolate-85', 25], ['greek-yogurt', 25], ['eggs', 25]],
    toTaste: [],
    steps: ['Melt the chocolate and whisk in the yogurt and eggs until glossy.', 'Pour into a small lined tin.', 'Bake (or air-fry) at 150°C for ~30 min until just set; chill before slicing. A per-slice serving.'],
    tags: ['veggie'],
    avoid: ['lactose']
  },

  // ── Instagram-inspired batch #2 (2026-08-31) ──────────────────────────────
  // Reels 18-25 (see ig-recipes.md). Savoury mains healthy-tweaked (oil trimmed, veg/protein
  // anchored); the galette stays `occasional`. New foods: breadcrumbs, quinoa, pistachios,
  // mascarpone, cornstarch, burrata (diet lists wired in library.js).
  'broccoli-ricotta-patties': {
    title: 'Broccoli & ricotta melty patties', emoji: '🥦', slot: 'dinner', role: 'main',
    season: 'winter/autumn', styles: ['balanced', 'highprotein'], time: 25,
    ingredients: [['broccoli', 200], ['ricotta', 100], ['scamorza', 45], ['breadcrumbs', 15]],
    toTaste: ['black pepper', 'salt', 'garlic'],
    steps: ['Steam or microwave the broccoli until soft, then cool and blitz with the ricotta.', 'Work in enough breadcrumbs to form a shapeable mixture; season.', 'Shape into patties around a cube of scamorza and pan-fry in a lightly oiled pan until golden and molten inside.'],
    tags: ['veggie', 'highFiber'],
    avoid: ['lactose', 'gluten']
  },
  'pumpkin-gnocchi-2ing': {
    title: 'Two-ingredient pumpkin gnocchi', emoji: '🎃', slot: 'dinner', role: 'full',
    season: 'winter/autumn', styles: ['balanced'], time: 40,
    ingredients: [['pumpkin', 250], ['00-flour', 98], ['olive-oil', 8], ['parmesan', 15]],
    toTaste: ['sage', 'nutmeg', 'black pepper', 'salt'],
    steps: ['Roast the pumpkin until soft and dry, then mash to a smooth purée.', 'Mix in just enough flour (about 39 g per 100 g purée) to form a soft, barely-sticky dough; roll and cut into gnocchi.', 'Boil until they float; toss through olive oil warmed with sage, and finish with a little parmesan.'],
    tags: ['veggie'],
    avoid: ['gluten', 'lactose']
  },
  'jennifer-aniston-salad': {
    title: 'Jennifer Aniston quinoa salad', emoji: '🥗', slot: 'lunch', role: 'full',
    season: 'evergreen', styles: ['balanced', 'highprotein'], time: 20,
    ingredients: [['quinoa', 55], ['chickpeas', 70], ['cucumber', 60], ['red-onion', 30], ['pistachios', 20], ['feta-cheese', 40], ['olive-oil', 8], ['lemon', 6]],
    toTaste: ['parsley', 'mint', 'black pepper', 'salt'],
    steps: ['Cook and cool the quinoa.', 'Toss with chickpeas, cucumber, red onion, chopped parsley and mint, and the pistachios.', 'Fold through crumbled feta, dress with olive oil, lemon, salt and pepper.'],
    tags: ['veggie', 'highFiber', 'heart'],
    avoid: ['nuts', 'lactose', 'raw-onion']
  },
  'cherry-tomato-fresh-pasta': {
    title: 'Roasted cherry-tomato spaghetti', emoji: '🍝', slot: 'dinner', role: 'full',
    season: 'spring/summer', styles: ['balanced'], time: 40,
    ingredients: [['00-flour', 90], ['eggs', 30], ['cherry-tomatoes', 160], ['bell-pepper', 40], ['olive-oil', 10], ['parmesan', 15], ['burrata', 50]],
    toTaste: ['garlic', 'basil', 'black pepper', 'salt'],
    steps: ['Make a fresh egg-pasta dough, rest it, and roll and cut into spaghetti.', 'Roast the cherry tomatoes, sweet pepper and garlic in the oil until soft, then mash to a sauce loosened with a little pasta water and parmesan.', 'Toss the cooked pasta through the sauce; top with torn burrata and basil.'],
    tags: ['veggie'],
    avoid: ['gluten', 'lactose']
  },
  'strawberry-galette': {
    title: 'Strawberry cream-cheese galette', emoji: '🍓', slot: 'snack', role: 'full', occasional: true,
    season: 'spring/summer', styles: ['balanced'], time: 70,
    ingredients: [['00-flour', 28], ['almond-flour', 5], ['butter', 22], ['cream-cheese', 7], ['mascarpone', 7], ['eggs', 6], ['strawberries', 55], ['granulated-sugar', 18], ['cornstarch', 3]],
    toTaste: ['vanilla', 'lemon'],
    steps: ['Rub cold butter into the flours, sugar and lemon zest; bring together with a little iced water and chill.', 'Whisk cream cheese, mascarpone, sugar, egg and vanilla; toss strawberries with sugar and cornstarch.', 'Roll the pastry, spread the cream, pile on the berries, fold the edges, egg-wash and bake at ~190°C for 40–50 min. A per-slice serving.'],
    tags: ['veggie'],
    avoid: ['gluten', 'lactose', 'nuts']
  }

};

/* meal-slot lookup, mirroring the old RECIPE_SLOT in state.js for the
   10 migrated recipes plus every new one — used by shared-meals logic
   and the planner (task C2). */
function recipeSlotList(recipe){
  if(!recipe) return [];
  const primary = recipe.slot;
  const raw = Array.isArray(recipe.slots) && recipe.slots.length ? recipe.slots : [primary];
  const seen = {};
  const out = [];
  raw.concat(primary ? [primary] : []).forEach(function(slot){
    if(!slot || seen[slot]) return;
    seen[slot] = true;
    out.push(slot);
  });
  return out;
}

const RECIPE_SLOT_DB = {};
Object.keys(RECIPES_DB).forEach(function (id) { RECIPE_SLOT_DB[id] = RECIPES_DB[id].slot; });
