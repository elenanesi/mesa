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
  'white-bean-tuna-salad': {
    title: 'White bean & tuna salad', emoji: '🥗', slot: 'lunch', role: 'full',
    slots: ['lunch', 'dinner'],
    styles: ['balanced', 'highprotein'], time: 10,
    ingredients: [['cannellini-beans', 150], ['tuna-in-olive-oil', 100], ['cherry-tomatoes', 60], ['rocket-arugula', 20], ['olive-oil', 5]],
    toTaste: ['lemon'],
    steps: ['Drain and rinse the white beans.', 'Toss beans with tomatoes and rocket.', 'Flake the tuna over the top.', 'Dress with olive oil and lemon.'],
    tags: ['muscle', 'heart', 'highFiber'],
    avoid: []
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
    styles: ['balanced'], time: 15,
    ingredients: [['white-bread', 70], ['eggs', 50], ['milk', 80], ['mixed-berries', 80], ['maple-syrup', 15], ['olive-oil', 4]],
    toTaste: ['cinnamon', 'vanilla'],
    steps: ['Whisk egg, milk, cinnamon and vanilla.', 'Dip the bread and cook in a lightly oiled pan until golden.', 'Top with fruit and maple syrup.'],
    tags: ['quick'],
    avoid: ['gluten', 'lactose']
  },
  'yogurt-cereali-frutta': {
    title: 'Yogurt, cereali e frutta', emoji: '🥣', slot: 'breakfast', role: 'full',
    styles: ['balanced'], time: 5,
    ingredients: [['greek-yogurt', 170], ['granola', 35], ['bananas', 60], ['mixed-berries', 60], ['honey', 8]],
    toTaste: [],
    steps: ['Spoon yogurt into a bowl.', 'Add cereal, banana and berries.', 'Finish with honey if wanted.'],
    tags: ['quick', 'muscle'],
    avoid: ['gluten', 'lactose']
  },
  pancakes: {
    title: 'Pancakes', emoji: '🥞', slot: 'breakfast', role: 'full',
    styles: ['balanced'], time: 18,
    ingredients: [['oats', 45], ['eggs', 50], ['milk', 100], ['bananas', 60], ['maple-syrup', 15], ['olive-oil', 4]],
    toTaste: ['cinnamon'],
    steps: ['Blend oats, egg, milk and banana into a batter.', 'Cook small pancakes in a lightly oiled pan.', 'Serve with maple syrup.'],
    tags: [],
    avoid: ['gluten', 'lactose']
  },
  'pancakes-proteici': {
    title: 'Pancakes proteici', emoji: '🥞', slot: 'breakfast', role: 'full',
    styles: ['balanced', 'highprotein'], time: 18,
    ingredients: [['oats', 40], ['whey-protein-powder', 30], ['eggs', 50], ['milk', 90], ['chocolate-hazelnut-spread', 12], ['bananas', 70], ['mixed-berries', 50], ['olive-oil', 3]],
    toTaste: ['cinnamon'],
    steps: ['Blend oat flour, protein powder, egg and milk into a smooth batter.', 'Cook small pancakes in a lightly oiled pan until golden on both sides.', 'Spread a thin veil of Nutella on top.', 'Finish with sliced banana and blueberries or mixed berries.'],
    tags: ['muscle'],
    avoid: ['gluten', 'lactose', 'nuts']
  },
  cereali: {
    title: 'Cereali', emoji: '🥣', slot: 'breakfast', role: 'full',
    styles: ['balanced'], time: 3,
    ingredients: [['granola', 45], ['milk', 180], ['bananas', 70]],
    toTaste: [],
    steps: ['Pour cereal into a bowl.', 'Add milk.', 'Slice banana on top.'],
    tags: ['quick'],
    avoid: ['gluten', 'lactose']
  },
  'uova-bacon': {
    title: 'Uova e bacon', emoji: '🍳', slot: 'breakfast', role: 'main',
    styles: ['highprotein', 'lowcarb'], time: 12,
    ingredients: [['eggs', 100], ['bacon', 35], ['cherry-tomatoes', 80]],
    toTaste: ['black pepper'],
    steps: ['Cook bacon until crisp.', 'Fry or scramble the eggs.', 'Serve with tomatoes on the side.'],
    tags: ['muscle', 'quick'],
    avoid: []
  },
  'uova-avocado-toast': {
    title: 'Uova avocado toast', emoji: '🥑', slot: 'breakfast', role: 'full',
    styles: ['balanced', 'highprotein'], time: 12,
    ingredients: [['wholewheat-bread', 70], ['eggs', 100], ['avocado', 70], ['cherry-tomatoes', 60]],
    toTaste: ['lemon', 'black pepper'],
    steps: ['Toast the bread.', 'Mash avocado with lemon and pepper.', 'Top with eggs and tomatoes.'],
    tags: ['heart', 'highFiber', 'muscle'],
    avoid: ['gluten']
  },
  'ricotta-pere-noci-toast': {
    title: 'Ricotta, pere e noci toast', emoji: '🍐', slot: 'breakfast', role: 'full',
    styles: ['balanced'], time: 8,
    ingredients: [['wholewheat-bread', 70], ['ricotta', 80], ['pears', 90], ['walnuts', 15], ['honey', 6]],
    toTaste: ['black pepper'],
    steps: ['Toast the bread.', 'Spread ricotta on top.', 'Add sliced pear, walnuts and a little honey.'],
    tags: ['highFiber'],
    avoid: ['gluten', 'lactose', 'nuts']
  },

  /* ================= ELENA RECIPE WISHLIST — LUNCH ================= */

  'insalata-pesche-feta': {
    title: 'Insalata pesche e feta', emoji: '🥗', slot: 'lunch', role: 'full',
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
    title: 'Insalata greca e pizza bianca', emoji: '🥗', slot: 'lunch', role: 'full',
    season: 'spring/summer',
    styles: ['balanced'], time: 10,
    ingredients: [['cucumber', 100], ['cherry-tomatoes', 120], ['feta-cheese', 60], ['olives', 30], ['pizza-bianca', 80], ['olive-oil', 8]],
    toTaste: ['oregano'],
    steps: ['Chop cucumber and tomatoes.', 'Add feta and olives.', 'Serve with pizza bianca on the side.'],
    tags: ['veggie', 'quick'],
    avoid: ['gluten', 'lactose']
  },
  'bowl-insalata': {
    title: 'Bowl insalata', emoji: '🥗', slot: 'lunch', role: 'full',
    season: 'spring/summer',
    styles: ['balanced', 'highprotein'], time: 12,
    ingredients: [['chicken-breast', 120], ['lettuce', 80], ['chickpeas', 90], ['cucumber', 80], ['cherry-tomatoes', 80], ['olive-oil', 8]],
    toTaste: ['lemon'],
    steps: ['Fill a bowl with lettuce, cucumber and tomatoes.', 'Add chickpeas and sliced chicken.', 'Dress with olive oil and lemon.'],
    tags: ['muscle', 'highFiber'],
    avoid: []
  },
  'toast-eatsmiter': {
    title: 'Toast eatsmiter', emoji: '🥪', slot: 'lunch', role: 'full',
    styles: ['balanced'], time: 8,
    ingredients: [['wholewheat-bread', 90], ['turkey-breast', 70], ['mozzarella', 45], ['cherry-tomatoes', 50]],
    toTaste: ['mustard'],
    steps: ['Fill bread with turkey, mozzarella and tomato.', 'Toast until warm and crisp.', 'Add mustard to taste.'],
    tags: ['quick', 'muscle'],
    avoid: ['gluten', 'lactose']
  },
  'pasta-pomodorini-funghi-broccoli': {
    title: 'Pasta pomodorini, funghi e broccoli', emoji: '🍝', slot: 'lunch', role: 'full',
    season: 'spring/summer',
    slots: ['lunch', 'dinner'],
    styles: ['balanced'], time: 22,
    ingredients: [['pasta', 75], ['cherry-tomatoes', 120], ['mushrooms', 90], ['broccoli', 120], ['parmesan', 12], ['olive-oil', 10]],
    toTaste: ['garlic', 'black pepper'],
    steps: ['Boil pasta and broccoli together in salted water.', 'Saute mushrooms and cherry tomatoes with oil and garlic.', 'Toss pasta with the vegetables and parmesan.'],
    tags: ['veggie', 'highFiber'],
    avoid: ['gluten', 'lactose']
  },
  'club-sandwich': {
    title: 'Club sandwich', emoji: '🥪', slot: 'lunch', role: 'full',
    styles: ['balanced', 'highprotein'], time: 15,
    ingredients: [['white-bread', 90], ['chicken-breast', 100], ['bacon', 25], ['lettuce', 30], ['cherry-tomatoes', 50]],
    toTaste: ['mustard'],
    steps: ['Toast the bread.', 'Layer chicken, bacon, lettuce and tomato.', 'Slice and serve.'],
    tags: ['muscle', 'quick'],
    avoid: ['gluten']
  },
  'uova-pomodoro': {
    title: 'Uova e pomodoro', emoji: '🍳', slot: 'lunch', role: 'full',
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
    title: 'Panino gorgonzola e prosciutto', emoji: '🥪', slot: 'lunch', role: 'full',
    styles: ['balanced'], time: 7,
    ingredients: [['white-bread', 90], ['gorgonzola', 45], ['prosciutto-cotto', 60], ['rocket-arugula', 20]],
    toTaste: [],
    steps: ['Slice the bread.', 'Fill with gorgonzola, prosciutto and rocket.', 'Toast if wanted.'],
    tags: ['quick'],
    avoid: ['gluten', 'lactose']
  },
  'insalata-noci-mele-senape': {
    title: 'Insalata noci, mele e senape', emoji: '🥗', slot: 'lunch', role: 'full',
    slots: ['lunch', 'side'],
    styles: ['balanced'], time: 10,
    ingredients: [['lettuce', 90], ['apples', 140], ['walnuts', 30], ['mustard', 8], ['olive-oil', 14], ['wholewheat-bread', 35]],
    toTaste: ['lemon'],
    steps: ['Slice apple and toss with lettuce.', 'Add walnuts.', 'Dress with mustard, olive oil and lemon.'],
    tags: ['veggie', 'highFiber', 'quick'],
    avoid: ['nuts']
  },
  'couscous-legumi-limone': {
    title: 'Cous cous legumi, pomodorini, cetriolo, cipolla, rucola e limone', emoji: '🥗', slot: 'lunch', role: 'full',
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
    title: 'Pomodori al riso', emoji: '🍅', slot: 'lunch', role: 'full',
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
    title: 'Pollo bollito in brodo', emoji: '🍗', slot: 'dinner', role: 'main',
    styles: ['highprotein', 'lowcarb'], time: 45,
    ingredients: [['chicken-breast', 190], ['carrots', 120], ['escarole', 100], ['olive-oil', 8]],
    toTaste: ['celery', 'onion', 'parsley'],
    steps: ['Simmer chicken with vegetables until tender.', 'Shred the chicken.', 'Serve in broth with greens and a little olive oil.'],
    tags: ['muscle'],
    avoid: []
  },
  'pollo-al-forno': {
    title: 'Pollo al forno', emoji: '🍗', slot: 'dinner', role: 'full',
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
    title: 'Tacchino arrosto agli agrumi', emoji: '🦃', slot: 'dinner', role: 'full',
    season: 'winter/autumn',
    styles: ['balanced', 'highprotein'], time: 35,
    ingredients: [['turkey-breast', 190], ['oranges', 80], ['sweet-potato', 180], ['green-beans', 140], ['olive-oil', 10]],
    toTaste: ['rosemary', 'black pepper'],
    steps: ['Roast turkey with orange zest and herbs.', 'Roast sweet potato alongside.', 'Serve with green beans.'],
    tags: ['muscle'],
    avoid: []
  },
  'filetto-maiale': {
    title: 'Filetto di maiale', emoji: '🍖', slot: 'dinner', role: 'full',
    styles: ['balanced', 'highprotein'], time: 30,
    ingredients: [['pork-loin', 170], ['mushrooms', 120], ['potatoes', 200], ['olive-oil', 10]],
    toTaste: ['sage', 'garlic'],
    steps: ['Sear pork until golden.', 'Cook mushrooms in the pan juices.', 'Serve with roasted potatoes.'],
    tags: ['muscle'],
    avoid: []
  },
  'filetto-manzo': {
    title: 'Filetto di manzo', emoji: '🥩', slot: 'dinner', role: 'main',
    styles: ['highprotein', 'lowcarb'], time: 25,
    ingredients: [['beef-mince-lean', 170], ['rocket-arugula', 50], ['cherry-tomatoes', 100], ['parmesan', 20], ['olive-oil', 10]],
    toTaste: ['lemon', 'black pepper'],
    steps: ['Cook the beef as a steak-style patty or sliced fillet substitute.', 'Toss rocket and tomatoes with olive oil and lemon.', 'Serve with parmesan shavings.'],
    tags: ['muscle'],
    avoid: ['lactose']
  },
  'salmone-o-sogliola': {
    title: 'Salmone o sogliola con verdure', emoji: '🐟', slot: 'dinner', role: 'main',
    season: 'spring/summer',
    styles: ['balanced', 'highprotein', 'lowcarb'], time: 25,
    ingredients: [['salmon-fillet', 150], ['asparagus', 120], ['green-beans', 120], ['olive-oil', 10]],
    toTaste: ['lemon', 'parsley'],
    steps: ['Bake or pan-cook the fish.', 'Steam asparagus and green beans.', 'Finish everything with olive oil and lemon.'],
    tags: ['omega3', 'muscle', 'lowGI'],
    avoid: []
  },
  'pasta-zucca-fagioli-funghi': {
    title: 'Pasta zucca, fagioli e funghi', emoji: '🍝', slot: 'dinner', role: 'full',
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
    title: 'Polpette di melanzane', emoji: '🧆', slot: 'dinner', role: 'full',
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
    styles: ['balanced'], time: 25,
    ingredients: [['ramen-noodles', 70], ['eggs', 50], ['chicken-breast', 90], ['mushrooms', 80], ['spinach', 60], ['soy-sauce', 15]],
    toTaste: ['ginger', 'garlic'],
    steps: ['Simmer broth with soy sauce, ginger and garlic.', 'Cook noodles and mushrooms.', 'Top with chicken, egg and spinach.'],
    tags: ['muscle'],
    avoid: ['gluten']
  },
  'zuppa-broccolo-nero-lenticchie': {
    title: 'Zuppa broccolo nero e lenticchie', emoji: '🍲', slot: 'dinner', role: 'full',
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
    title: 'Polpette di tacchino, yogurt e menta', emoji: '🦃', slot: 'dinner', role: 'full',
    styles: ['balanced', 'highprotein'], time: 28,
    ingredients: [['turkey-breast', 180], ['eggs', 50], ['wholewheat-bread', 35], ['greek-yogurt', 80], ['cucumber', 80], ['olive-oil', 8]],
    toTaste: ['mint', 'lemon'],
    steps: ['Mix minced turkey-style filling with egg and bread crumbs.', 'Shape and cook the meatballs.', 'Serve with cucumber yogurt mint sauce.'],
    tags: ['muscle'],
    avoid: ['gluten', 'lactose']
  },
  'burrito-vegetariano': {
    title: 'Burrito vegetariano', emoji: '🌯', slot: 'dinner', role: 'full',
    styles: ['balanced'], time: 22,
    ingredients: [['white-bread', 80], ['cannellini-beans', 130], ['rice', 55], ['avocado', 60], ['cherry-tomatoes', 80], ['feta-cheese', 25]],
    toTaste: ['lime', 'cumin'],
    steps: ['Warm the wrap bread.', 'Fill with rice, beans, avocado and tomatoes.', 'Add feta and roll up.'],
    tags: ['veggie', 'highFiber'],
    avoid: ['gluten', 'lactose']
  },
  'tofu-noodles': {
    title: 'Tofu e noodles', emoji: '🍜', slot: 'dinner', role: 'full',
    styles: ['balanced'], time: 22,
    ingredients: [['tofu', 160], ['egg-noodles', 70], ['broccoli', 120], ['carrots', 80], ['soy-sauce', 15], ['olive-oil', 8]],
    toTaste: ['ginger', 'garlic'],
    steps: ['Cook noodles.', 'Stir-fry tofu and vegetables.', 'Toss with soy sauce and noodles.'],
    tags: ['veggie', 'muscle'],
    avoid: ['gluten']
  },
  'feta-filo-miele-noodles-verdure': {
    title: 'Feta pasta filo e miele, noodles e verdura grigliata', emoji: '🧀', slot: 'dinner', role: 'full',
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
    ingredients: [['carrots', 180], ['hummus', 70], ['maple-syrup', 5], ['olive-oil', 8]],
    toTaste: ['paprika', 'lemon'],
    steps: ['Roast or pan-cook carrots with olive oil and maple.', 'Spread hummus on a plate.', 'Pile carrots over the hummus.'],
    tags: ['veggie', 'highFiber'],
    avoid: []
  },
  scarola: {
    title: 'Scarola', emoji: '🥬', slot: 'side', role: 'side',
    styles: ['lowcarb', 'balanced'], time: 15,
    ingredients: [['escarole', 220], ['olives', 25], ['capers', 10], ['olive-oil', 10]],
    toTaste: ['garlic'],
    steps: ['Wilt scarola in a pan.', 'Add olives, capers and garlic.', 'Finish with olive oil.'],
    tags: ['veggie', 'highFiber', 'quick'],
    avoid: []
  },
  'cavolfiore-arrosto-paprika': {
    title: 'Cavolfiore arrosto con paprika e spezie', emoji: '🥦', slot: 'side', role: 'side',
    season: 'winter/autumn',
    styles: ['lowcarb', 'balanced'], time: 30,
    ingredients: [['cauliflower', 240], ['olive-oil', 12], ['greek-yogurt', 50]],
    toTaste: ['paprika', 'cumin', 'lemon'],
    steps: ['Roast cauliflower-style broccoli florets with oil and spices.', 'Stir yogurt with lemon.', 'Serve with yogurt sauce.'],
    tags: ['veggie', 'lowGI'],
    avoid: ['lactose']
  },
  'asparagi-fagiolini-broccoli': {
    title: 'Asparagi, fagiolini o broccoli', emoji: '🥦', slot: 'side', role: 'side',
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
    title: 'Verdure wok', emoji: '🥢', slot: 'side', role: 'side',
    slots: ['side', 'lunch'],
    styles: ['balanced', 'lowcarb'], time: 15,
    ingredients: [['broccoli', 120], ['bell-pepper', 100], ['carrots', 80], ['soy-sauce', 12], ['olive-oil', 8]],
    toTaste: ['ginger', 'garlic'],
    steps: ['Slice vegetables thinly.', 'Stir-fry hot and fast with oil.', 'Finish with soy sauce and ginger.'],
    tags: ['veggie', 'quick'],
    avoid: []
  },
  'insalata-carote-cetrioli-marinate': {
    title: 'Insalata carote e cetrioli marinate', emoji: '🥒', slot: 'side', role: 'side',
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
    title: 'Cena cinese', emoji: '🥡', slot: 'dinner', role: 'full',
    slots: ['dinner', 'lunch'],
    occasional: true,
    styles: ['balanced'], time: 35,
    ingredients: [['spaghetti', 70], ['chicken-breast', 150], ['almonds', 18], ['soy-sauce', 16], ['pak-choy', 140], ['ravioli', 80], ['spring-rolls', 90], ['olive-oil', 8]],
    toTaste: ['ginger', 'garlic'],
    steps: ['Cook the spaghetti and toss with a little soy sauce.', 'Stir-fry the chicken with almonds until golden, then add pak choy.', 'Pan-crisp the ravioli and warm the spring rolls.', 'Serve everything together as one mixed dinner.'],
    tags: ['muscle'],
    avoid: ['gluten', 'nuts']
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
    ingredients: [['hummus', 60], ['cucumber', 80], ['cherry-tomatoes', 60]],
    toTaste: [],
    steps: ['Slice cucumber and halve the cherry tomatoes.', 'Spoon hummus into a small bowl.', 'Serve the veg sticks with the hummus for dipping.'],
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
    title: 'Gelato al cioccolato', emoji: '🍨', slot: 'snack', role: 'full',
    occasional: true,
    styles: ['balanced'], time: 1,
    ingredients: [['gelato-chocolate', 120], ['dark-chocolate-85', 10]],
    toTaste: [],
    steps: ['Scoop the chocolate gelato into a small bowl.', 'Shave or crumble the dark chocolate over the top.', 'Eat slowly enough that it still feels like a treat.'],
    tags: [],
    avoid: ['lactose']
  },
  'gelato-stracciatella': {
    title: 'Gelato stracciatella', emoji: '🍨', slot: 'snack', role: 'full',
    occasional: true,
    styles: ['balanced'], time: 1,
    ingredients: [['gelato-stracciatella', 130], ['dark-chocolate-85', 5]],
    toTaste: [],
    steps: ['Scoop the stracciatella gelato into a bowl.', 'Add a few dark chocolate shavings if wanted.', 'Serve straight away.'],
    tags: [],
    avoid: ['lactose']
  },
  'gelato-yogurt': {
    title: 'Gelato allo yogurt', emoji: '🍦', slot: 'snack', role: 'full',
    occasional: true,
    styles: ['balanced'], time: 2,
    ingredients: [['gelato-yogurt', 130], ['mixed-berries', 30]],
    toTaste: [],
    steps: ['Scoop the yogurt gelato into a bowl.', 'Add the berries on top.', 'Serve immediately.'],
    tags: [],
    avoid: ['lactose']
  },
  'gelato-crema': {
    title: 'Gelato alla crema', emoji: '🍨', slot: 'snack', role: 'full',
    occasional: true,
    styles: ['balanced'], time: 1,
    ingredients: [['gelato-crema', 130], ['vanilla-cinnamon', 1]],
    toTaste: [],
    steps: ['Scoop the crema gelato into a bowl.', 'Dust with a tiny pinch of vanilla or cinnamon if wanted.', 'Serve immediately.'],
    tags: [],
    avoid: ['lactose']
  },
  'brownie-dessert': {
    title: 'Brownie', emoji: '🍫', slot: 'snack', role: 'full',
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
    slots: ['dinner', 'lunch'],
    occasional: true,
    styles: ['balanced'], time: 5,
    ingredients: [['fast-food-beef-burger', 180], ['fast-food-fries', 110], ['cola', 400]],
    toTaste: [],
    steps: ['Order the burger, fries and cola.', 'Use the menu as a single loggable meal.', 'Adjust portions later with servings if the actual order was larger or smaller.'],
    tags: [],
    avoid: ['gluten', 'lactose']
  },
  'burger-king-menu': {
    title: 'Burger King menu', emoji: '🍔', slot: 'dinner', role: 'full',
    slots: ['dinner', 'lunch'],
    occasional: true,
    styles: ['balanced'], time: 5,
    ingredients: [['fast-food-beef-burger', 220], ['fast-food-fries', 110], ['cola', 400]],
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
