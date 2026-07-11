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
     slot    — 'breakfast' | 'lunch' | 'dinner' | 'snack'
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
    title: 'Greek yogurt & berry bowl', emoji: '🥣', slot: 'breakfast',
    styles: ['balanced', 'highprotein'], time: 8,
    ingredients: [['greek-yogurt', 150], ['mixed-berries', 80], ['granola', 20], ['honey', 8], ['chia-seeds', 6]],
    toTaste: [],
    steps: ['Spoon yogurt into a bowl.', 'Top with berries, granola and chia seeds.', 'Finish with a drizzle of honey.'],
    tags: ['lowGI', 'skin', 'muscle'],
    avoid: ['lactose']
  },
  omelette: {
    title: 'Veggie omelette & rye toast', emoji: '🍳', slot: 'breakfast',
    styles: ['balanced', 'lowcarb'], time: 12,
    ingredients: [['eggs', 150], ['bell-pepper', 50], ['spinach', 30], ['rye-bread', 60], ['olive-oil', 5]],
    toTaste: ['herbs', 'black pepper'],
    steps: ['Whisk eggs; saute peppers and spinach in olive oil.', 'Pour eggs over the veg and cook gently until just set.', 'Toast the rye bread and plate alongside the omelette.'],
    tags: ['muscle', 'thyroid'],
    avoid: ['gluten']
  },
  skyrbowl: {
    title: 'Skyr bowl, berries & seeds', emoji: '🥣', slot: 'breakfast',
    styles: ['highprotein'], time: 6,
    ingredients: [['skyr', 200], ['mixed-berries', 80], ['pumpkin-chia-seeds', 25], ['honey', 8]],
    toTaste: [],
    steps: ['Spoon skyr into a bowl.', 'Top with berries and a generous scatter of pumpkin & chia seeds.', 'Finish with a light drizzle of honey.'],
    tags: ['muscle', 'lowGI', 'skin'],
    avoid: ['lactose']
  },
  eggsturkey: {
    title: 'Eggs, turkey & rye', emoji: '🍳', slot: 'breakfast',
    styles: ['highprotein'], time: 10,
    ingredients: [['eggs', 100], ['turkey-breast', 80], ['rye-bread', 60], ['olive-oil', 5]],
    toTaste: ['herbs', 'black pepper'],
    steps: ['Scramble or fry the eggs in olive oil.', 'Warm the turkey slices briefly in the same pan.', 'Toast the rye and plate everything together.'],
    tags: ['muscle', 'thyroid'],
    avoid: ['gluten']
  },
  chiapudding: {
    title: 'Chia pudding, coconut & berries', emoji: '🍮', slot: 'breakfast',
    styles: ['lowcarb'], time: 5,
    ingredients: [['chia-seeds', 30], ['coconut-milk', 150], ['mixed-berries', 60]],
    toTaste: ['vanilla or cinnamon'],
    steps: ['Stir chia seeds into coconut milk and chill overnight.', 'Stir again before serving to loosen the texture.', 'Top with berries and a touch of vanilla or cinnamon.'],
    tags: ['lowGI', 'skin', 'omega3'],
    avoid: []
  },
  'oats-berries-walnuts': {
    title: 'Overnight oats, walnuts & berries', emoji: '🥣', slot: 'breakfast',
    styles: ['balanced'], time: 5,
    ingredients: [['oats', 50], ['milk', 150], ['walnuts', 15], ['mixed-berries', 50], ['honey', 8]],
    toTaste: [],
    steps: ['Stir oats and milk together and chill overnight (or at least 20 min).', 'Stir again before serving to loosen the texture.', 'Top with walnuts, berries and a drizzle of honey.'],
    tags: ['heart', 'omega3', 'highFiber'],
    avoid: ['nuts', 'lactose']
  },
  'avocado-eggs': {
    title: 'Eggs & avocado', emoji: '🥑', slot: 'breakfast',
    styles: ['lowcarb', 'highprotein'], time: 10,
    ingredients: [['eggs', 100], ['avocado', 70], ['cherry-tomatoes', 60], ['olive-oil', 5]],
    toTaste: ['lemon', 'black pepper'],
    steps: ['Soft-boil or fry the eggs.', 'Slice the avocado and halve the tomatoes.', 'Plate together, finish with olive oil, a squeeze of lemon and black pepper.'],
    tags: ['muscle', 'heart', 'lowGI'],
    avoid: []
  },
  shakshuka: {
    title: 'Shakshuka', emoji: '🍳', slot: 'breakfast',
    styles: ['balanced', 'lowcarb'], time: 20,
    ingredients: [['eggs', 150], ['tomatoes', 150], ['bell-pepper', 80], ['red-onion', 40], ['olive-oil', 10]],
    toTaste: ['garlic', 'paprika', 'herbs'],
    steps: ['Soften onion and peppers in olive oil until fragrant.', 'Add the chopped tomatoes and garlic, simmer 8-10 min to thicken.', 'Make wells in the sauce and crack in the three eggs; cover and cook until just set.', 'Finish with herbs and serve straight from the pan.'],
    tags: ['veggie', 'lowGI', 'heart'],
    avoid: []
  },
  'veg-frittata': {
    title: 'Roast veg frittata', emoji: '🍳', slot: 'breakfast',
    styles: ['balanced', 'highprotein'], time: 18,
    ingredients: [['eggs', 150], ['courgette', 60], ['bell-pepper', 60], ['parmesan', 20], ['olive-oil', 5]],
    toTaste: ['herbs'],
    steps: ['Saute courgette and peppers in olive oil until tender.', 'Whisk eggs with grated parmesan and pour over the veg.', 'Cook gently on low heat until mostly set, then finish under the grill.', 'Rest 2 minutes, slice and serve.'],
    tags: ['muscle', 'veggie', 'heart'],
    avoid: ['lactose']
  },
  'almond-skyr-bowl': {
    title: 'Skyr, almonds & chia', emoji: '🥣', slot: 'breakfast',
    styles: ['lowcarb', 'highprotein'], time: 5,
    ingredients: [['skyr', 200], ['almonds', 25], ['chia-seeds', 10]],
    toTaste: [],
    steps: ['Spoon skyr into a bowl.', 'Scatter almonds and chia seeds on top.', 'Serve straight away.'],
    tags: ['muscle', 'lowGI'],
    avoid: ['lactose', 'nuts']
  },
  'turkey-spinach-omelette': {
    title: 'Turkey & spinach omelette', emoji: '🍳', slot: 'breakfast',
    styles: ['balanced', 'highprotein'], time: 12,
    ingredients: [['eggs', 150], ['turkey-breast', 60], ['spinach', 40], ['olive-oil', 5]],
    toTaste: ['herbs', 'black pepper'],
    steps: ['Wilt spinach briefly in olive oil.', 'Whisk eggs and add the turkey and spinach.', 'Pour into the pan and cook gently until just set.', 'Fold and plate.'],
    tags: ['muscle', 'thyroid'],
    avoid: []
  },

  /* ================= LUNCH (10) ================= */

  lentil: {
    title: 'Lentil & roasted veg salad', emoji: '🥗', slot: 'lunch',
    styles: ['balanced'], time: 20,
    ingredients: [['cooked-lentils', 150], ['courgette', 75], ['bell-pepper', 75], ['feta-cheese', 40], ['rocket-arugula', 20], ['olive-oil', 10]],
    toTaste: ['lemon'],
    steps: ['Roast courgette and peppers until tender.', 'Toss the warm roasted veg with the lentils.', 'Crumble feta over the top.', 'Add rocket and dress with olive oil & lemon just before serving.'],
    tags: ['heart', 'highFiber', 'veggie'],
    avoid: ['lactose']
  },
  chickenfarro: {
    title: 'Chicken & farro bowl', emoji: '🍲', slot: 'lunch',
    styles: ['highprotein'], time: 22,
    ingredients: [['chicken-breast', 150], ['farro-cooked', 120], ['courgette', 50], ['bell-pepper', 50], ['olive-oil', 5]],
    toTaste: ['lemon'],
    steps: ['Grill or pan-sear the chicken until cooked through.', 'Toss warm farro with roasted veg.', 'Slice chicken over the bowl and dress with olive oil & lemon.'],
    tags: ['muscle', 'highFiber'],
    avoid: ['gluten']
  },
  tunasalad: {
    title: 'Tuna & avocado chopped salad', emoji: '🥗', slot: 'lunch',
    styles: ['lowcarb', 'highprotein'], time: 12,
    ingredients: [['tuna-in-olive-oil', 120], ['avocado', 80], ['cherry-tomatoes', 100], ['cucumber', 50], ['olive-oil', 5]],
    toTaste: ['lemon'],
    steps: ['Chop tomatoes, cucumber and avocado.', 'Flake the tuna over the top.', 'Dress with olive oil and lemon just before serving.'],
    tags: ['muscle', 'omega3', 'heart'],
    avoid: []
  },
  'chicken-couscous-salad': {
    title: 'Chicken & couscous salad', emoji: '🥗', slot: 'lunch',
    styles: ['balanced', 'highprotein'], time: 20,
    ingredients: [['chicken-breast', 130], ['couscous', 80], ['cherry-tomatoes', 80], ['cucumber', 60], ['olive-oil', 5]],
    toTaste: ['lemon', 'herbs'],
    steps: ['Cook couscous per pack instructions and fluff with a fork.', 'Grill or pan-sear the chicken until cooked through, then slice.', 'Toss couscous with tomatoes and cucumber.', 'Top with chicken, olive oil, lemon and herbs.'],
    tags: ['muscle', 'heart'],
    avoid: ['gluten']
  },
  'white-bean-tuna-salad': {
    title: 'White bean & tuna salad', emoji: '🥗', slot: 'lunch',
    styles: ['balanced', 'highprotein'], time: 10,
    ingredients: [['cannellini-beans', 150], ['tuna-in-olive-oil', 100], ['cherry-tomatoes', 60], ['rocket-arugula', 20], ['olive-oil', 5]],
    toTaste: ['lemon'],
    steps: ['Drain and rinse the white beans.', 'Toss beans with tomatoes and rocket.', 'Flake the tuna over the top.', 'Dress with olive oil and lemon.'],
    tags: ['muscle', 'heart', 'highFiber'],
    avoid: []
  },
  'prawn-courgette-salad': {
    title: 'Prawn & courgette salad', emoji: '🦐', slot: 'lunch',
    styles: ['lowcarb', 'highprotein'], time: 15,
    ingredients: [['prawns', 180], ['courgette', 150], ['cherry-tomatoes', 60], ['avocado', 80], ['olive-oil', 12]],
    toTaste: ['lemon', 'garlic'],
    steps: ['Ribbon the courgette with a peeler.', 'Pan-sear the prawns with garlic until pink, 2-3 min.', 'Toss courgette ribbons with tomatoes, sliced avocado and olive oil.', 'Top with the warm prawns and a squeeze of lemon.'],
    tags: ['muscle', 'lowGI'],
    avoid: ['shellfish']
  },
  'sardine-white-bean-salad': {
    title: 'Sardine & white bean salad', emoji: '🐟', slot: 'lunch',
    styles: ['balanced', 'highprotein'], time: 10,
    ingredients: [['sardines', 120], ['cannellini-beans', 100], ['rocket-arugula', 30], ['cherry-tomatoes', 60], ['olive-oil', 5]],
    toTaste: ['lemon'],
    steps: ['Drain and rinse the white beans.', 'Toss beans with rocket and tomatoes.', 'Flake the sardines over the top.', 'Dress with olive oil and lemon.'],
    tags: ['thyroid', 'omega3', 'heart', 'highFiber'],
    avoid: []
  },
  'greek-salad-big': {
    title: 'Big Greek salad', emoji: '🥗', slot: 'lunch',
    styles: ['lowcarb', 'balanced'], time: 10,
    ingredients: [['cucumber', 100], ['cherry-tomatoes', 100], ['bell-pepper', 60], ['feta-cheese', 70], ['olives', 40], ['olive-oil', 15]],
    toTaste: ['oregano', 'lemon'],
    steps: ['Chop cucumber, tomatoes and peppers into chunks.', 'Add olives and top with a slab of feta.', 'Dress with olive oil, oregano and lemon just before serving.'],
    tags: ['veggie', 'heart', 'lowGI'],
    avoid: ['lactose']
  },
  'chicken-caprese-salad': {
    title: 'Chicken caprese salad', emoji: '🥗', slot: 'lunch',
    styles: ['lowcarb', 'highprotein'], time: 15,
    ingredients: [['chicken-breast', 130], ['mozzarella', 60], ['cherry-tomatoes', 100], ['rocket-arugula', 20], ['olive-oil', 10]],
    toTaste: ['basil'],
    steps: ['Grill or pan-sear the chicken until cooked through, then slice.', 'Slice the mozzarella and halve the tomatoes.', 'Layer chicken, mozzarella, tomatoes and rocket.', 'Finish with olive oil and torn basil.'],
    tags: ['muscle', 'lowGI'],
    avoid: ['lactose']
  },
  'tuna-egg-salad': {
    title: 'Tuna & egg salad', emoji: '🥗', slot: 'lunch',
    styles: ['lowcarb', 'highprotein'], time: 12,
    ingredients: [['tuna-in-olive-oil', 100], ['eggs', 100], ['cucumber', 80], ['cherry-tomatoes', 80], ['olive-oil', 5]],
    toTaste: ['lemon'],
    steps: ['Hard-boil the eggs (8-9 min), cool and quarter.', 'Chop cucumber and tomatoes.', 'Flake the tuna over the veg and top with the eggs.', 'Dress with olive oil and lemon.'],
    tags: ['muscle', 'omega3'],
    avoid: []
  },

  /* ================= DINNER (9) ================= */

  salmon: {
    title: 'Baked salmon, quinoa & greens', emoji: '🐟', slot: 'dinner',
    styles: ['balanced', 'highprotein'], time: 25,
    ingredients: [['salmon-fillet', 140], ['quinoa-dry', 60], ['spinach', 40], ['broccoli', 100], ['olive-oil', 5]],
    toTaste: ['lemon', 'garlic'],
    steps: ['Rinse quinoa, simmer in 2x water for 15 min until fluffy.', 'Rub salmon with olive oil, lemon, garlic. Bake at 200C for 12-14 min.', 'Steam broccoli; wilt spinach in the warm pan.', 'Plate quinoa, greens, salmon. Finish with lemon and olive oil.'],
    tags: ['thyroid', 'omega3', 'lowGI', 'muscle'],
    avoid: []
  },
  salmongreens: {
    title: 'Salmon & greens, no quinoa', emoji: '🐟', slot: 'dinner',
    styles: ['lowcarb', 'highprotein'], time: 20,
    ingredients: [['salmon-fillet', 150], ['spinach', 60], ['broccoli', 75], ['courgette', 75], ['olive-oil', 5]],
    toTaste: ['lemon', 'garlic'],
    steps: ['Rub salmon with olive oil, lemon and garlic; bake at 200C for 12-14 min.', 'Steam broccoli and courgette; wilt spinach in the warm pan.', 'Plate the greens with salmon on top, finished with lemon and olive oil.'],
    tags: ['thyroid', 'omega3', 'lowGI', 'muscle'],
    avoid: []
  },
  'chicken-sweet-potato-broccoli': {
    title: 'Roast chicken, sweet potato & broccoli', emoji: '🍗', slot: 'dinner',
    styles: ['balanced', 'highprotein'], time: 35,
    ingredients: [['chicken-breast', 180], ['sweet-potato', 200], ['broccoli', 100], ['olive-oil', 10]],
    toTaste: ['herbs', 'lemon'],
    steps: ['Cube sweet potato, toss in olive oil and roast at 200C for 25 min.', 'Season chicken and roast or pan-sear until cooked through.', 'Steam the broccoli in the last 5 minutes.', 'Plate together and finish with herbs and a squeeze of lemon.'],
    tags: ['muscle', 'heart'],
    avoid: []
  },
  'beef-courgette-ragu': {
    title: 'Lean beef & courgette ragu', emoji: '🥩', slot: 'dinner',
    styles: ['lowcarb', 'highprotein', 'balanced'], time: 25,
    ingredients: [['beef-mince-lean', 180], ['tomatoes', 200], ['courgette', 200], ['olive-oil', 10]],
    toTaste: ['garlic', 'herbs'],
    steps: ['Brown the beef mince in olive oil with garlic.', 'Add the chopped tomatoes and simmer 12-15 min.', 'Saute the courgette until just tender.', 'Serve the ragu over the courgette.'],
    tags: ['muscle', 'heart'],
    avoid: []
  },
  'turkey-roasted-veg': {
    title: 'Turkey & roasted veg', emoji: '🍗', slot: 'dinner',
    styles: ['lowcarb', 'highprotein'], time: 30,
    ingredients: [['turkey-breast', 220], ['courgette', 150], ['bell-pepper', 100], ['olive-oil', 15]],
    toTaste: ['herbs', 'lemon'],
    steps: ['Toss courgette and peppers in olive oil and roast at 200C for 20 min.', 'Season the turkey breast and pan-sear or roast until cooked through.', 'Slice the turkey and plate with the roasted veg.', 'Finish with herbs and a squeeze of lemon.'],
    tags: ['muscle', 'lowGI'],
    avoid: []
  },
  'chickpea-veg-stew': {
    title: 'Chickpea & vegetable stew', emoji: '🍲', slot: 'dinner',
    styles: ['balanced'], time: 30,
    ingredients: [['chickpeas', 200], ['tomatoes', 150], ['courgette', 80], ['bell-pepper', 80], ['olive-oil', 10]],
    toTaste: ['garlic', 'cumin'],
    steps: ['Saute courgette and peppers in olive oil until softened.', 'Add garlic, the chopped tomatoes and chickpeas; simmer 15-20 min.', 'Season with cumin to taste.', 'Serve warm, on its own or with crusty bread.'],
    tags: ['veggie', 'highFiber', 'heart'],
    avoid: []
  },
  'baked-cod-greens': {
    title: 'Baked cod & greens', emoji: '🐟', slot: 'dinner',
    styles: ['balanced', 'highprotein', 'lowcarb'], time: 25,
    ingredients: [['cod', 220], ['broccoli', 200], ['spinach', 80], ['olive-oil', 15]],
    toTaste: ['lemon', 'garlic'],
    steps: ['Rub cod with olive oil, lemon and garlic; bake at 200C for 12-15 min.', 'Steam the broccoli.', 'Wilt the spinach in a warm pan.', 'Plate the greens with the cod on top, finished with lemon.'],
    tags: ['thyroid', 'muscle', 'lowGI'],
    avoid: []
  },
  'prawn-courgette-tomato': {
    title: 'Prawn, courgette & tomato saute', emoji: '🦐', slot: 'dinner',
    styles: ['lowcarb', 'highprotein', 'balanced'], time: 20,
    ingredients: [['prawns', 220], ['courgette', 200], ['cherry-tomatoes', 150], ['olive-oil', 15]],
    toTaste: ['garlic', 'parsley'],
    steps: ['Saute courgette in olive oil until lightly golden.', 'Add tomatoes and garlic, cook 3-4 min until they soften.', 'Add prawns and cook until pink, 2-3 min.', 'Finish with parsley and serve.'],
    tags: ['omega3', 'lowGI'],
    avoid: ['shellfish']
  },
  'pork-loin-farro-veg': {
    title: 'Pork loin, farro & greens', emoji: '🍖', slot: 'dinner',
    styles: ['balanced', 'highprotein'], time: 30,
    ingredients: [['pork-loin', 150], ['farro-cooked', 150], ['spinach', 60], ['olive-oil', 8]],
    toTaste: ['garlic', 'herbs'],
    steps: ['Season the pork loin and pan-sear or roast until cooked through.', 'Warm the farro through.', 'Wilt the spinach with garlic in olive oil.', 'Slice the pork and plate over the farro and greens.'],
    tags: ['muscle'],
    avoid: ['gluten']
  },

  /* ================= SNACK (6) ================= */

  'brazil-nuts-apple': {
    title: 'Snack: 2 Brazil nuts + apple', emoji: '🌰', slot: 'snack',
    styles: ['balanced'], time: 2,
    ingredients: [['brazil-nuts', 10], ['apples', 150]],
    toTaste: [],
    steps: ['Wash and slice the apple.', 'Portion the Brazil nuts.', 'Serve together.'],
    tags: ['thyroid'],
    avoid: ['nuts']
  },
  'ricotta-walnuts': {
    title: 'Snack: Ricotta & walnuts', emoji: '🧀', slot: 'snack',
    styles: ['highprotein'], time: 3,
    ingredients: [['ricotta', 130], ['walnuts', 12]],
    toTaste: [],
    steps: ['Spoon ricotta into a small bowl.', 'Top with walnuts.', 'Serve chilled.'],
    tags: ['muscle'],
    avoid: ['lactose', 'nuts']
  },
  'almonds-cheese-cubes': {
    title: 'Snack: Almonds & cheese cubes', emoji: '🥜', slot: 'snack',
    styles: ['lowcarb'], time: 3,
    ingredients: [['almonds', 20], ['mozzarella', 40]],
    toTaste: [],
    steps: ['Portion the almonds.', 'Cube the mozzarella.', 'Serve together.'],
    tags: ['muscle'],
    avoid: ['lactose', 'nuts']
  },
  'hummus-veg-sticks': {
    title: 'Snack: Hummus & veg sticks', emoji: '🥕', slot: 'snack',
    styles: ['balanced', 'lowcarb'], time: 5,
    ingredients: [['hummus', 60], ['cucumber', 80], ['cherry-tomatoes', 60]],
    toTaste: [],
    steps: ['Slice cucumber and halve the cherry tomatoes.', 'Spoon hummus into a small bowl.', 'Serve the veg sticks with the hummus for dipping.'],
    tags: ['veggie', 'highFiber'],
    avoid: []
  },
  'greek-yogurt-honey-walnuts': {
    title: 'Snack: Greek yogurt, honey & walnuts', emoji: '🥣', slot: 'snack',
    styles: ['highprotein', 'balanced'], time: 3,
    ingredients: [['greek-yogurt', 120], ['honey', 10], ['walnuts', 15]],
    toTaste: [],
    steps: ['Spoon yogurt into a bowl.', 'Drizzle with honey.', 'Scatter walnuts on top.'],
    tags: ['muscle', 'omega3'],
    avoid: ['lactose', 'nuts']
  },
  'boiled-eggs-veg-sticks': {
    title: 'Snack: Boiled eggs & veg sticks', emoji: '🥚', slot: 'snack',
    styles: ['highprotein', 'balanced'], time: 10,
    ingredients: [['eggs', 100], ['cucumber', 80]],
    toTaste: ['black pepper'],
    steps: ['Hard-boil the eggs (8-9 min) and cool.', 'Peel and halve the eggs.', 'Slice the cucumber and serve alongside.'],
    tags: ['muscle', 'quick'],
    avoid: []
  }

};

/* meal-slot lookup, mirroring the old RECIPE_SLOT in state.js for the
   10 migrated recipes plus every new one — used by shared-meals logic
   and the planner (task C2). */
const RECIPE_SLOT_DB = {};
Object.keys(RECIPES_DB).forEach(function (id) { RECIPE_SLOT_DB[id] = RECIPES_DB[id].slot; });
