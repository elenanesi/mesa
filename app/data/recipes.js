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

  yogurt: {
    title: 'Greek yogurt & berry bowl', emoji: '🥣', slot: 'breakfast', role: 'full',
    styles: ['balanced', 'highprotein'], time: 8,
    ingredients: [['greek-yogurt', 150], ['mixed-berries', 80], ['granola', 20], ['honey', 8], ['chia-seeds', 6]],
    toTaste: [],
    steps: ['Spoon yogurt into a bowl.', 'Top with berries, granola and chia seeds.', 'Finish with a drizzle of honey.'],
    tags: ['lowGI', 'skin', 'muscle'],
    avoid: ['lactose']
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
  skyrbowl: {
    title: 'Skyr bowl, berries & seeds', emoji: '🥣', slot: 'breakfast', role: 'full',
    styles: ['highprotein'], time: 6,
    ingredients: [['skyr', 200], ['mixed-berries', 80], ['pumpkin-chia-seeds', 25], ['honey', 8]],
    toTaste: [],
    steps: ['Spoon skyr into a bowl.', 'Top with berries and a generous scatter of pumpkin & chia seeds.', 'Finish with a light drizzle of honey.'],
    tags: ['muscle', 'lowGI', 'skin'],
    avoid: ['lactose']
  },
  eggsturkey: {
    title: 'Eggs, turkey & rye', emoji: '🍳', slot: 'breakfast', role: 'full',
    styles: ['highprotein'], time: 10,
    ingredients: [['eggs', 100], ['turkey-breast', 80], ['rye-bread', 60], ['olive-oil', 5]],
    toTaste: ['herbs', 'black pepper'],
    steps: ['Scramble or fry the eggs in olive oil.', 'Warm the turkey slices briefly in the same pan.', 'Toast the rye and plate everything together.'],
    tags: ['muscle', 'thyroid'],
    avoid: ['gluten']
  },
  chiapudding: {
    title: 'Chia pudding, coconut & berries', emoji: '🍮', slot: 'breakfast', role: 'full',
    styles: ['lowcarb'], time: 5,
    ingredients: [['chia-seeds', 30], ['coconut-milk', 150], ['mixed-berries', 60]],
    toTaste: ['vanilla or cinnamon'],
    steps: ['Stir chia seeds into coconut milk and chill overnight.', 'Stir again before serving to loosen the texture.', 'Top with berries and a touch of vanilla or cinnamon.'],
    tags: ['lowGI', 'skin', 'omega3'],
    avoid: []
  },
  'oats-berries-walnuts': {
    title: 'Overnight oats, walnuts & berries', emoji: '🥣', slot: 'breakfast', role: 'full',
    styles: ['balanced'], time: 5,
    ingredients: [['oats', 50], ['milk', 150], ['walnuts', 15], ['mixed-berries', 50], ['honey', 8]],
    toTaste: [],
    steps: ['Stir oats and milk together and chill overnight (or at least 20 min).', 'Stir again before serving to loosen the texture.', 'Top with walnuts, berries and a drizzle of honey.'],
    tags: ['heart', 'omega3', 'highFiber'],
    avoid: ['nuts', 'lactose']
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
    title: 'Turkey & spinach omelette', emoji: '🍳', slot: 'breakfast', role: 'main',
    styles: ['balanced', 'highprotein'], time: 12,
    ingredients: [['eggs', 150], ['turkey-breast', 60], ['spinach', 40], ['olive-oil', 5]],
    toTaste: ['herbs', 'black pepper'],
    steps: ['Wilt spinach briefly in olive oil.', 'Whisk eggs and add the turkey and spinach.', 'Pour into the pan and cook gently until just set.', 'Fold and plate.'],
    tags: ['muscle', 'thyroid'],
    avoid: []
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
    title: 'Big Greek salad', emoji: '🥗', slot: 'lunch', role: 'full',
    slots: ['lunch', 'dinner', 'side'],
    styles: ['lowcarb', 'balanced'], time: 10,
    ingredients: [['cucumber', 100], ['cherry-tomatoes', 100], ['bell-pepper', 60], ['feta-cheese', 70], ['olives', 40], ['olive-oil', 15]],
    toTaste: ['oregano', 'lemon'],
    steps: ['Chop cucumber, tomatoes and peppers into chunks.', 'Add olives and top with a slab of feta.', 'Dress with olive oil, oregano and lemon just before serving.'],
    tags: ['veggie', 'heart', 'lowGI'],
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

  salmon: {
    title: 'Baked salmon, quinoa & greens', emoji: '🐟', slot: 'dinner', role: 'full',
    slots: ['dinner', 'lunch'],
    styles: ['balanced', 'highprotein'], time: 25,
    ingredients: [['salmon-fillet', 140], ['quinoa-dry', 60], ['spinach', 40], ['broccoli', 100], ['olive-oil', 5]],
    toTaste: ['lemon', 'garlic'],
    steps: ['Rinse quinoa, simmer in 2x water for 15 min until fluffy.', 'Rub salmon with olive oil, lemon, garlic. Bake at 200C for 12-14 min.', 'Steam broccoli; wilt spinach in the warm pan.', 'Plate quinoa, greens, salmon. Finish with lemon and olive oil.'],
    tags: ['thyroid', 'omega3', 'lowGI', 'muscle'],
    avoid: []
  },
  salmongreens: {
    title: 'Salmon & greens, no quinoa', emoji: '🐟', slot: 'dinner', role: 'main',
    slots: ['dinner', 'lunch'],
    styles: ['lowcarb', 'highprotein'], time: 20,
    ingredients: [['salmon-fillet', 150], ['spinach', 60], ['broccoli', 75], ['courgette', 75], ['olive-oil', 5]],
    toTaste: ['lemon', 'garlic'],
    steps: ['Rub salmon with olive oil, lemon and garlic; bake at 200C for 12-14 min.', 'Steam broccoli and courgette; wilt spinach in the warm pan.', 'Plate the greens with salmon on top, finished with lemon and olive oil.'],
    tags: ['thyroid', 'omega3', 'lowGI', 'muscle'],
    avoid: []
  },
  'chicken-sweet-potato-broccoli': {
    title: 'Roast chicken, sweet potato & broccoli', emoji: '🍗', slot: 'dinner', role: 'full',
    slots: ['dinner', 'lunch'],
    styles: ['balanced', 'highprotein'], time: 35,
    ingredients: [['chicken-breast', 180], ['sweet-potato', 200], ['broccoli', 100], ['olive-oil', 10]],
    toTaste: ['herbs', 'lemon'],
    steps: ['Cube sweet potato, toss in olive oil and roast at 200C for 25 min.', 'Season chicken and roast or pan-sear until cooked through.', 'Steam the broccoli in the last 5 minutes.', 'Plate together and finish with herbs and a squeeze of lemon.'],
    tags: ['muscle', 'heart'],
    avoid: []
  },
  'beef-courgette-ragu': {
    title: 'Lean beef & courgette ragu', emoji: '🥩', slot: 'dinner', role: 'main',
    slots: ['dinner', 'lunch'],
    styles: ['lowcarb', 'highprotein', 'balanced'], time: 25,
    ingredients: [['beef-mince-lean', 180], ['tomatoes', 200], ['courgette', 200], ['olive-oil', 10]],
    toTaste: ['garlic', 'herbs'],
    steps: ['Brown the beef mince in olive oil with garlic.', 'Add the chopped tomatoes and simmer 12-15 min.', 'Saute the courgette until just tender.', 'Serve the ragu over the courgette.'],
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
    title: 'Baked cod & greens', emoji: '🐟', slot: 'dinner', role: 'main',
    slots: ['dinner', 'lunch', 'side'],
    styles: ['balanced', 'highprotein', 'lowcarb'], time: 25,
    ingredients: [['cod', 220], ['broccoli', 200], ['spinach', 80], ['olive-oil', 15]],
    toTaste: ['lemon', 'garlic'],
    steps: ['Rub cod with olive oil, lemon and garlic; bake at 200C for 12-15 min.', 'Steam the broccoli.', 'Wilt the spinach in a warm pan.', 'Plate the greens with the cod on top, finished with lemon.'],
    tags: ['thyroid', 'muscle', 'lowGI'],
    avoid: []
  },
  'prawn-courgette-tomato': {
    title: 'Prawn, courgette & tomato saute', emoji: '🦐', slot: 'dinner', role: 'main',
    slots: ['dinner', 'lunch', 'side'],
    styles: ['lowcarb', 'highprotein', 'balanced'], time: 20,
    ingredients: [['prawns', 220], ['courgette', 200], ['cherry-tomatoes', 150], ['olive-oil', 15]],
    toTaste: ['garlic', 'parsley'],
    steps: ['Saute courgette in olive oil until lightly golden.', 'Add tomatoes and garlic, cook 3-4 min until they soften.', 'Add prawns and cook until pink, 2-3 min.', 'Finish with parsley and serve.'],
    tags: ['omega3', 'lowGI'],
    avoid: ['shellfish']
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
  'yogurt-cereali-frutta': {
    title: 'Yogurt, cereal & fruit', emoji: '🥣', slot: 'breakfast', role: 'full',
    styles: ['balanced'], time: 5,
    ingredients: [['greek-yogurt', 170], ['granola', 35], ['bananas', 60], ['mixed-berries', 60], ['honey', 8]],
    toTaste: [],
    steps: ['Spoon yogurt into a bowl.', 'Add cereal, banana and berries.', 'Finish with honey if wanted.'],
    tags: ['quick', 'muscle'],
    avoid: ['gluten', 'lactose']
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
    title: 'Eggs & bacon', emoji: '🍳', slot: 'breakfast', role: 'main',
    styles: ['highprotein', 'lowcarb'], time: 12,
    ingredients: [['eggs', 100], ['bacon', 35], ['cherry-tomatoes', 80]],
    toTaste: ['black pepper'],
    steps: ['Cook bacon until crisp.', 'Fry or scramble the eggs.', 'Serve with tomatoes on the side.'],
    tags: ['muscle', 'quick'],
    avoid: []
  },
  'uova-avocado-toast': {
    title: 'Egg & avocado toast', emoji: '🥑', slot: 'breakfast', role: 'full',
    styles: ['balanced', 'highprotein'], time: 12,
    ingredients: [['wholewheat-bread', 70], ['eggs', 100], ['avocado', 70], ['cherry-tomatoes', 60]],
    toTaste: ['lemon', 'black pepper'],
    steps: ['Toast the bread.', 'Mash avocado with lemon and pepper.', 'Top with eggs and tomatoes.'],
    tags: ['heart', 'highFiber', 'muscle'],
    avoid: ['gluten']
  },
  'ricotta-pere-noci-toast': {
    title: 'Ricotta, pear & walnut toast', emoji: '🍐', slot: 'breakfast', role: 'full',
    styles: ['balanced'], time: 8,
    ingredients: [['wholewheat-bread', 70], ['ricotta', 80], ['pears', 90], ['walnuts', 15], ['honey', 6]],
    toTaste: ['black pepper'],
    steps: ['Toast the bread.', 'Spread ricotta on top.', 'Add sliced pear, walnuts and a little honey.'],
    tags: ['highFiber'],
    avoid: ['gluten', 'lactose', 'nuts']
  },

  /* ================= ELENA RECIPE WISHLIST — LUNCH ================= */

  'insalata-pesche-feta': {
    title: 'Peach & feta salad', emoji: '🥗', slot: 'lunch', role: 'full',
    season: 'spring/summer',
    slots: ['lunch', 'dinner'],
    styles: ['balanced', 'lowcarb'], time: 10,
    ingredients: [['peaches', 150], ['feta-cheese', 70], ['rocket-arugula', 50], ['walnuts', 15], ['olive-oil', 10]],
    toTaste: ['lemon', 'black pepper'],
    steps: ['Slice peaches and pile over rocket.', 'Crumble feta on top.', 'Add walnuts and dress with olive oil and lemon.'],
    tags: ['veggie', 'quick'],
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
    title: 'Apple, walnut & mustard salad', emoji: '🥗', slot: 'lunch', role: 'full',
    slots: ['lunch', 'side'],
    styles: ['balanced'], time: 10,
    ingredients: [['lettuce', 90], ['apples', 140], ['walnuts', 30], ['mustard', 8], ['olive-oil', 14], ['wholewheat-bread', 35]],
    toTaste: ['lemon'],
    steps: ['Slice apple and toss with lettuce.', 'Add walnuts.', 'Dress with mustard, olive oil and lemon.'],
    tags: ['veggie', 'highFiber', 'quick'],
    avoid: ['nuts']
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
    season: 'spring/summer',
    slots: ['lunch', 'dinner'],
    styles: ['balanced'], time: 55,
    ingredients: [['tomatoes', 300], ['rice', 65], ['potatoes', 180], ['olive-oil', 15]],
    toTaste: ['basil', 'garlic', 'oregano'],
    steps: ['Hollow tomatoes and mix the pulp with rice, herbs and oil.', 'Fill the tomatoes and place potatoes around them.', 'Bake until rice and potatoes are tender.'],
    tags: ['veggie'],
    avoid: []
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
  'chicken-tacos-gyros': {
    title: 'Chicken tacos / gyros', emoji: '🌮', slot: 'dinner', role: 'full',
    styles: ['balanced', 'highprotein'], time: 25,
    ingredients: [['chicken-breast', 160], ['white-bread', 80], ['greek-yogurt', 60], ['cucumber', 80], ['cherry-tomatoes', 80], ['olive-oil', 6]],
    toTaste: ['lemon', 'oregano', 'paprika'],
    steps: ['Season and cook chicken strips.', 'Warm bread as a wrap.', 'Fill with chicken, yogurt sauce, cucumber and tomatoes.'],
    tags: ['muscle'],
    avoid: ['gluten', 'lactose']
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
  'polpette-melanzane': {
    title: 'Aubergine fritters with tomato sauce', emoji: '🧆', slot: 'dinner', role: 'full',
    season: 'spring/summer',
    slots: ['dinner', 'lunch'],
    styles: ['balanced'], time: 35,
    ingredients: [['aubergine', 220], ['eggs', 50], ['parmesan', 25], ['wholewheat-bread', 45], ['tomatoes', 150], ['olive-oil', 10]],
    toTaste: ['basil', 'garlic'],
    steps: ['Cook aubergine until soft and chop finely.', 'Mix with egg, parmesan and bread crumbs.', 'Bake or pan-cook the polpette and serve with tomato sauce.'],
    tags: ['veggie'],
    avoid: ['gluten', 'lactose']
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
    ingredients: [['cooked-lentils', 190], ['cavolo-nero', 140], ['tomatoes', 100], ['carrots', 80], ['olive-oil', 12], ['wholewheat-bread', 35]],
    toTaste: ['garlic', 'chilli if wanted'],
    steps: ['Simmer lentils with tomatoes and carrots.', 'Add greens until tender.', 'Finish with olive oil.'],
    tags: ['veggie', 'highFiber', 'heart'],
    avoid: []
  },
  'polpette-tacchino-yogurt-menta': {
    title: 'Turkey meatballs with yogurt & mint', emoji: '🦃', slot: 'dinner', role: 'full',
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
    title: 'Tofu & noodles', emoji: '🍜', slot: 'dinner', role: 'full',
    styles: ['balanced'], time: 22,
    ingredients: [['tofu', 160], ['egg-noodles', 70], ['broccoli', 120], ['carrots', 80], ['soy-sauce', 15], ['olive-oil', 8]],
    toTaste: ['ginger', 'garlic'],
    steps: ['Cook noodles.', 'Stir-fry tofu and vegetables.', 'Toss with soy sauce and noodles.'],
    tags: ['veggie', 'muscle'],
    avoid: ['gluten']
  },
  'feta-filo-miele-noodles-verdure': {
    title: 'Honey filo feta with noodles & grilled vegetables', emoji: '🧀', slot: 'dinner', role: 'full',
    season: 'spring/summer',
    styles: ['balanced'], time: 30,
    ingredients: [['feta-cheese', 80], ['pasta-filo', 45], ['honey', 10], ['egg-noodles', 45], ['courgette', 100], ['bell-pepper', 100], ['olive-oil', 10]],
    toTaste: ['sesame or thyme'],
    steps: ['Wrap feta in filo and bake until crisp.', 'Drizzle with honey.', 'Serve with noodles and grilled vegetables.'],
    tags: ['veggie'],
    avoid: ['gluten', 'lactose']
  },

  /* ================= ELENA RECIPE WISHLIST — SIDES ================= */

  'carrots-over-hummus': {
    title: 'Carrots over hummus', emoji: '🥕', slot: 'side', role: 'side',
    slots: ['side', 'snack', 'lunch'],
    styles: ['balanced'], time: 22,
    ingredients: [['carrots', 180], ['chickpeas', 45], ['olive-oil', 12], ['lemon-juice', 8], ['garlic', 2], ['maple-syrup', 5]],
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
  'asparagi-fagiolini-broccoli': {
    title: 'Asparagus, green beans or broccoli', emoji: '🥦', slot: 'side', role: 'side',
    season: 'spring/summer',
    styles: ['lowcarb', 'balanced'], time: 15,
    ingredients: [['asparagus', 100], ['green-beans', 100], ['broccoli', 100], ['olive-oil', 10]],
    toTaste: ['lemon', 'black pepper'],
    steps: ['Steam or roast the green vegetables.', 'Dress with olive oil and lemon.', 'Serve warm.'],
    tags: ['veggie', 'highFiber', 'quick'],
    avoid: []
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
  'cena-cinese': {
    title: 'Chinese-style dinner', emoji: '🥡', slot: 'dinner', role: 'full',
    imageKey: 'chinese-dinner',
    slots: ['dinner', 'lunch'],
    occasional: true,
    styles: ['balanced'], time: 35,
    ingredients: [['spaghetti', 70], ['chicken-breast', 150], ['almonds', 18], ['soy-sauce', 16], ['pak-choy', 140], ['ravioli', 80], ['pasta-filo', 35], ['cabbage', 60], ['carrots', 35], ['olive-oil', 12]],
    toTaste: ['ginger', 'garlic'],
    steps: ['Cook the spaghetti and toss with a little soy sauce.', 'Stir-fry the chicken with almonds until golden, then add pak choy.', 'Pan-crisp the ravioli and prepare small cabbage-carrot spring rolls.', 'Serve everything together as one mixed dinner.'],
    tags: ['muscle'],
    avoid: ['gluten', 'nuts']
  },

  /* ================= TASK D2 — recipe options, mains, sauces ================= */

  'baked-fish': {
    title: 'Baked fish', emoji: '🐟', slot: 'lunch', role: 'main',
    imageKey: 'fish-main',
    slots: ['lunch', 'dinner'],
    styles: ['balanced', 'highprotein', 'lowcarb'], time: 20,
    ingredients: [['olive-oil', 10], ['lemon-juice', 20]],
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
          {id: 'cod', label: 'Cod', ingredients: [['cod', 220]]}
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
    toTaste: ['salt', 'black pepper', 'garlic'],
    steps: ['Bring a pot of salted water to the boil and cook the pasta until al dente.', 'While the pasta cooks, warm the chosen condiment through in a pan with the olive oil.', 'Drain the pasta, reserving a splash of cooking water.', 'Toss the pasta with the condiment, loosening with the reserved water if needed.'],
    tags: [],
    avoid: ['gluten'],
    optionGroups: [
      {
        key: 'condiment', label: 'Condiment',
        choices: [
          {id: 'tomato-basil', label: 'Tomato & basil', ingredients: [['tomato-passata', 150], ['basil', 8]]},
          {id: 'pesto', label: 'Pesto Elena', ingredients: [['pesto-elena', 60]]},
          {id: 'tuna-olives', label: 'Tuna & olives', ingredients: [['tuna-in-olive-oil', 90], ['olives', 30]]},
          {id: 'courgette-ricotta', label: 'Courgette & ricotta', ingredients: [['courgette', 150], ['ricotta', 100]]}
        ]
      }
    ]
  },
  pizza: {
    title: 'Pizza', emoji: '🍕', slot: 'dinner', role: 'full',
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
    ingredients: [['chicken-breast', 180], ['olive-oil', 8], ['lemon-juice', 15]],
    toTaste: ['garlic', 'herbs', 'black pepper'],
    steps: ['Rub the chicken breast with olive oil, lemon juice and herbs.', 'Pan-sear or grill until cooked through, 6-8 min per side.', 'Rest briefly, then slice and finish with an extra squeeze of lemon.'],
    tags: ['muscle', 'thyroid', 'lowGI'],
    avoid: []
  },
  'turkey-cutlets-sage': {
    title: 'Turkey cutlets with sage', emoji: '🦃', slot: 'lunch', role: 'main',
    slots: ['lunch', 'dinner'],
    styles: ['balanced', 'highprotein'], time: 18,
    ingredients: [['turkey-breast', 220], ['olive-oil', 10]],
    toTaste: ['sage', 'garlic', 'black pepper'],
    steps: ['Season the turkey cutlets with sage, garlic and black pepper.', 'Pan-sear in olive oil until golden and cooked through, 3-4 min per side.', 'Rest briefly, then slice and serve.'],
    tags: ['muscle', 'thyroid'],
    avoid: []
  },
  'white-bean-rosemary-mash': {
    title: 'White bean & rosemary mash', emoji: '🫘', slot: 'lunch', role: 'main',
    slots: ['lunch', 'dinner'],
    styles: ['balanced'], time: 15,
    ingredients: [['cannellini-beans', 300], ['olive-oil', 15]],
    toTaste: ['rosemary', 'garlic', 'lemon', 'black pepper'],
    steps: ['Warm the cannellini beans with olive oil, rosemary and garlic.', 'Mash roughly with a fork, leaving some texture.', 'Season with black pepper and a squeeze of lemon if wanted.'],
    tags: ['veggie', 'highFiber', 'lowGI', 'heart'],
    avoid: []
  },
  'tomato-basil-sauce': {
    title: 'Tomato-basil sauce', emoji: '🍅', slot: 'side', role: 'sauce',
    slots: ['side'],
    styles: ['balanced', 'lowcarb'], time: 15,
    ingredients: [['tomato-passata', 150], ['basil', 15], ['olive-oil', 10]],
    toTaste: ['garlic', 'oregano', 'salt'],
    steps: ['Warm the olive oil in a pan with garlic.', 'Add the tomato passata and simmer 8-10 min until thickened.', 'Stir in torn basil off the heat and season to taste.'],
    tags: ['veggie'],
    avoid: []
  },
  'yogurt-herb-sauce': {
    title: 'Yogurt-herb sauce', emoji: '🥣', slot: 'side', role: 'sauce',
    slots: ['side'],
    styles: ['balanced', 'lowcarb'], time: 5,
    ingredients: [['greek-yogurt', 150], ['lemon-juice', 15], ['olive-oil', 8]],
    toTaste: ['dill or mint', 'garlic', 'black pepper', 'salt'],
    steps: ['Stir the yogurt with lemon juice and olive oil until smooth.', 'Season with herbs, salt and pepper.', 'Chill briefly before serving.'],
    tags: ['veggie', 'lowGI'],
    avoid: ['lactose']
  },

  /* ================= SNACK (6) ================= */

  'brazil-nuts-apple': {
    title: 'Snack: 2 Brazil nuts + apple', emoji: '🌰', slot: 'snack', role: 'full',
    styles: ['balanced'], time: 2,
    ingredients: [['brazil-nuts', 10], ['apples', 150]],
    toTaste: [],
    steps: ['Wash and slice the apple.', 'Portion the Brazil nuts.', 'Serve together.'],
    tags: ['thyroid'],
    avoid: ['nuts']
  },
  'ricotta-walnuts': {
    title: 'Snack: Ricotta & walnuts', emoji: '🧀', slot: 'snack', role: 'full',
    styles: ['highprotein'], time: 3,
    ingredients: [['ricotta', 130], ['walnuts', 12]],
    toTaste: [],
    steps: ['Spoon ricotta into a small bowl.', 'Top with walnuts.', 'Serve chilled.'],
    tags: ['muscle'],
    avoid: ['lactose', 'nuts']
  },
  'almonds-cheese-cubes': {
    title: 'Snack: Almonds & cheese cubes', emoji: '🥜', slot: 'snack', role: 'full',
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
    ingredients: [['chickpeas', 45], ['olive-oil', 8], ['lemon-juice', 6], ['garlic', 2], ['cucumber', 80], ['cherry-tomatoes', 60]],
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
    ingredients: [['chickpeas', 80], ['olive-oil', 10], ['lemon-juice', 8], ['garlic', 2]],
    toTaste: ['paprika', 'tahini'],
    steps: ['Mash or blend chickpeas with olive oil, lemon and garlic.', 'Loosen with a splash of water if needed.', 'Serve as a snack or side dip.'],
    tags: ['veggie', 'highFiber'],
    avoid: []
  },
  'greek-yogurt-honey-walnuts': {
    title: 'Snack: Greek yogurt, honey & walnuts', emoji: '🥣', slot: 'snack', role: 'full',
    styles: ['highprotein', 'balanced'], time: 3,
    ingredients: [['greek-yogurt', 120], ['honey', 10], ['walnuts', 15]],
    toTaste: [],
    steps: ['Spoon yogurt into a bowl.', 'Drizzle with honey.', 'Scatter walnuts on top.'],
    tags: ['muscle', 'omega3'],
    avoid: ['lactose', 'nuts']
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
    occasional: true,
    styles: ['balanced'], time: 2,
    ingredients: [['brownie', 80], ['milk', 80]],
    toTaste: [],
    steps: ['Cut one brownie portion.', 'Serve with a small glass of milk if wanted.', 'Log it without making a moral drama out of it.'],
    tags: [],
    avoid: ['gluten', 'lactose']
  },
  'mcdonald-menu': {
    title: "McDonald's menu", emoji: '🍔', slot: 'dinner', role: 'full',
    imageKey: 'fast-food-menu',
    slots: ['dinner', 'lunch'],
    occasional: true,
    styles: ['balanced'], time: 5,
    ingredients: [['fast-food-beef-burger', 180], ['potatoes', 170], ['olive-oil', 18], ['cola', 400]],
    toTaste: [],
    steps: ['Order the burger, fries and cola.', 'Use the menu as a single loggable meal.', 'Adjust portions later with servings if the actual order was larger or smaller.'],
    tags: [],
    avoid: ['gluten', 'lactose']
  },
  'burger-king-menu': {
    title: 'Burger King menu', emoji: '🍔', slot: 'dinner', role: 'full',
    imageKey: 'fast-food-menu',
    slots: ['dinner', 'lunch'],
    occasional: true,
    styles: ['balanced'], time: 5,
    ingredients: [['fast-food-beef-burger', 220], ['potatoes', 170], ['olive-oil', 18], ['cola', 400]],
    toTaste: [],
    steps: ['Order the burger, fries and cola.', 'Use the menu as a single loggable meal.', 'Adjust portions later with servings if the actual order was larger or smaller.'],
    tags: [],
    avoid: ['gluten', 'lactose']
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
