/* ===================================================================
   foods.js — Mesa food database (task B1)

   Global `const FOODS = {...}` keyed by stable kebab-case id. Values
   are per 100g/100ml edible portion unless unit:'piece' (see 'eggs'),
   in which case `per`, `kcal`, `protein`, `carbs`, `fat`, `satFat`,
   `fiber`, `sugars` and `freeSugars` are all PER PIECE (avgG documents
   the assumed piece weight).

   Sourcing: standard published tables — mostly USDA FoodData Central
   (FDC id noted per entry where a specific match exists; "-style"
   means a representative FDC entry for that food class was used, not
   an exact id lookup) plus a couple of CREA-style Italian references
   for farro/bresaola where USDA doesn't have a close match. Rounded
   to 1 decimal (kcal to whole numbers).

   kcal policy: kcal is computed as round(4*protein + 4*carbs + 9*fat)
   from the published protein/carb/fat grams (EU-style labeling: fiber
   is counted WITHIN carbs, not subtracted as "net carbs"). This is
   the standard Atwater general-factor approach and keeps every entry
   trivially consistent with the 4/4/9 self-check below. It can read
   a little higher than some published "kcal" columns for very fibrous
   low-calorie vegetables (USDA sometimes uses refined, food-specific
   energy factors that discount fiber further) — that's a known,
   deliberate simplification, not a typo; the macro grams themselves
   are the sourced values.

   Composite ingredients (mockup shorthand like 'Roasted mixed veg')
   get ONE pragmatic blended entry — a weighted average of their
   components, documented in `src` — so recipes keep working, PLUS
   the individual components as their own separate foods.

   Categories (shopping list): Produce | Protein | Dairy | Pantry |
   Bakery | Frozen. Seasons (planning/filter tags): evergreen |
   winter/autumn | spring/summer; omitted means evergreen. Flags
   (nutrition tags): lowGI, omega3, selenium, highIodine, glutenFree,
   highFiber, fermented.

   FOOD_ALIASES maps every ingredient-name STRING used in RECIPES
   (app/js/state.js) to a food id here, since recipe ingredient names
   are free-text mockup copy ("Salmon fillet") and don't always match
   a food's display `name` ("Salmon fillet, raw (Atlantic)") exactly.

   NOT wired into index.html yet — that happens in task C1.
   =================================================================== */

const FOODS = {

  /* ---------------- Produce ---------------- */

  'mixed-berries': {
    name: 'Mixed berries (strawberry, blueberry, raspberry)', per: 100, unit: 'g',
    kcal: 51, protein: 0.8, carbs: 11.0, fat: 0.4, satFat: 0.1, fiber: 3.5, sugars: 7.0, freeSugars: 0, sugarQuality: 'intrinsic',
    flags: ['lowGI'], cat: 'Produce', season: 'spring/summer', breakfastPair: true, iconKey: 'mixed-berries', src: 'USDA FDC 173946-style avg of strawberry/blueberry/raspberry'
  },
  'bell-pepper': {
    name: 'Bell pepper, red, raw', per: 100, unit: 'g',
    kcal: 31, protein: 1.0, carbs: 6.0, fat: 0.3, satFat: 0.0, fiber: 2.1,
    flags: [], cat: 'Produce', season: 'spring/summer', iconKey: 'bell-pepper', src: 'USDA FDC 170108 (pepper, sweet, red, raw)'
  },
  'spinach': {
    name: 'Spinach, baby leaf, raw', per: 100, unit: 'g',
    kcal: 30, protein: 2.9, carbs: 3.6, fat: 0.4, satFat: 0.1, fiber: 2.2,
    flags: [], cat: 'Produce', iconKey: 'spinach', src: 'USDA FDC 168462 (spinach, raw); kcal per 4/4/9'
  },
  'courgette': {
    name: 'Courgette / zucchini, raw', per: 100, unit: 'g',
    kcal: 20, protein: 1.2, carbs: 3.1, fat: 0.3, satFat: 0.1, fiber: 1.0,
    flags: [], cat: 'Produce', season: 'spring/summer', iconKey: 'courgette', src: 'USDA FDC 169291 (zucchini, raw)'
  },
  'aubergine': {
    name: 'Aubergine / eggplant, raw', per: 100, unit: 'g',
    kcal: 29, protein: 1.0, carbs: 5.9, fat: 0.2, satFat: 0.0, fiber: 3.0,
    flags: ['highFiber'], cat: 'Produce', season: 'spring/summer', iconKey: 'aubergine', src: 'USDA FDC 169228 (eggplant, raw)'
  },
  'red-onion': {
    name: 'Onion, red, raw', per: 100, unit: 'g',
    kcal: 43, protein: 1.1, carbs: 9.3, fat: 0.1, satFat: 0.0, fiber: 1.7,
    flags: [], cat: 'Produce', iconKey: 'red-onion', src: 'USDA FDC 170000-style (onion, red, raw)'
  },
  'lemon-juice': {
    name: 'Lemon juice, raw', per: 100, unit: 'ml',
    kcal: 31, protein: 0.4, carbs: 6.9, fat: 0.2, satFat: 0.0, fiber: 0.3,
    flags: [], cat: 'Produce', iconKey: 'lemon-juice', src: 'USDA FDC 167747 (lemon juice, raw); kcal per 4/4/9'
  },
  'cherry-tomatoes': {
    name: 'Cherry tomatoes, raw', per: 100, unit: 'g',
    kcal: 21, protein: 0.9, carbs: 3.9, fat: 0.2, satFat: 0.0, fiber: 1.2,
    flags: [], cat: 'Produce', season: 'spring/summer', iconKey: 'cherry-tomatoes', src: 'USDA FDC 170457 (tomatoes, cherry, raw)'
  },
  'cucumber': {
    name: 'Cucumber, raw, with peel', per: 100, unit: 'g',
    kcal: 18, protein: 0.7, carbs: 3.6, fat: 0.1, satFat: 0.0, fiber: 0.5,
    flags: [], cat: 'Produce', season: 'spring/summer', iconKey: 'cucumber', src: 'USDA FDC 168409 (cucumber, raw, with peel)'
  },
  'broccoli': {
    name: 'Broccoli, raw', per: 100, unit: 'g',
    kcal: 41, protein: 2.8, carbs: 6.6, fat: 0.4, satFat: 0.1, fiber: 2.6,
    flags: ['highFiber'], cat: 'Produce', season: 'winter/autumn', iconKey: 'broccoli', src: 'USDA FDC 170379 (broccoli, raw)'
  },
  'cauliflower': {
    name: 'Cauliflower, raw', per: 100, unit: 'g',
    kcal: 29, protein: 1.9, carbs: 5.0, fat: 0.3, satFat: 0.1, fiber: 2.0,
    flags: ['glutenFree'], cat: 'Produce', season: 'winter/autumn', iconKey: 'cauliflower', src: 'USDA FDC 169986 (cauliflower, raw); kcal per 4/4/9'
  },
  'cavolo-nero': {
    name: 'Cavolo nero / kale, raw', per: 100, unit: 'g',
    kcal: 61, protein: 4.3, carbs: 8.8, fat: 0.9, satFat: 0.1, fiber: 3.6,
    flags: ['highFiber', 'glutenFree'], cat: 'Produce', season: 'winter/autumn', iconKey: 'cavolo-nero', src: 'USDA FDC 168421-style (kale, raw); kcal per 4/4/9'
  },
  'green-beans': {
    name: 'Green beans, cooked', per: 100, unit: 'g',
    kcal: 42, protein: 1.9, carbs: 7.9, fat: 0.3, satFat: 0.1, fiber: 3.2,
    flags: ['highFiber', 'glutenFree'], cat: 'Produce', season: 'spring/summer', iconKey: 'green-beans', src: 'USDA FDC 169961-style (green beans, cooked, boiled); kcal per 4/4/9'
  },
  'carrots': {
    name: 'Carrots, raw', per: 100, unit: 'g',
    kcal: 43, protein: 0.9, carbs: 9.6, fat: 0.2, satFat: 0.0, fiber: 2.8,
    flags: ['glutenFree'], cat: 'Produce', iconKey: 'carrots', src: 'USDA FDC 170393 (carrots, raw); kcal per 4/4/9'
  },
  'peaches': {
    name: 'Peaches, raw', per: 100, unit: 'g',
    kcal: 44, protein: 0.9, carbs: 10.1, fat: 0.3, satFat: 0.0, fiber: 1.5, sugars: 8.4, freeSugars: 0, sugarQuality: 'intrinsic',
    flags: [], cat: 'Produce', season: 'spring/summer', breakfastPair: true, iconKey: 'peaches', src: 'USDA FDC 169928 (peaches, raw); kcal per 4/4/9'
  },
  'pears': {
    name: 'Pears, raw', per: 100, unit: 'g',
    kcal: 59, protein: 0.4, carbs: 15.2, fat: 0.1, satFat: 0.0, fiber: 3.1, sugars: 9.8, freeSugars: 0, sugarQuality: 'intrinsic',
    flags: ['highFiber'], cat: 'Produce', season: 'winter/autumn', breakfastPair: true, iconKey: 'pears', src: 'USDA FDC 169118 (pears, raw)'
  },
  'mushrooms': {
    name: 'Mushrooms, raw', per: 100, unit: 'g',
    kcal: 26, protein: 3.1, carbs: 3.3, fat: 0.3, satFat: 0.1, fiber: 1.0,
    flags: [], cat: 'Produce', iconKey: 'mushrooms', src: 'USDA FDC 169251 (mushrooms, white, raw); kcal per 4/4/9'
  },
  'pak-choy': {
    name: 'Pak choy / bok choy, raw', per: 100, unit: 'g',
    kcal: 17, protein: 1.5, carbs: 2.2, fat: 0.2, satFat: 0.0, fiber: 1.0, sugars: 1.2, freeSugars: 0, sugarQuality: 'intrinsic',
    flags: ['glutenFree'], cat: 'Produce', season: 'winter/autumn', iconKey: 'pak-choy', iconAsset: 'assets/ingredients/pak-choy.png', src: 'USDA FDC-style (bok choy / pak choy, raw); kcal per 4/4/9'
  },
  'pumpkin': {
    name: 'Pumpkin / squash, raw', per: 100, unit: 'g',
    kcal: 30, protein: 1.0, carbs: 6.5, fat: 0.1, satFat: 0.0, fiber: 0.5,
    flags: ['glutenFree'], cat: 'Produce', season: 'winter/autumn', iconKey: 'pumpkin', src: 'USDA FDC 168448-style (pumpkin, raw); kcal per 4/4/9'
  },
  'asparagus': {
    name: 'Asparagus, raw', per: 100, unit: 'g',
    kcal: 25, protein: 2.2, carbs: 3.9, fat: 0.1, satFat: 0.0, fiber: 2.1,
    flags: ['glutenFree'], cat: 'Produce', season: 'spring/summer', iconKey: 'asparagus', src: 'USDA FDC 168389 (asparagus, raw); kcal per 4/4/9'
  },
  'cabbage': {
    name: 'Cabbage, raw', per: 100, unit: 'g',
    kcal: 29, protein: 1.3, carbs: 5.8, fat: 0.1, satFat: 0.0, fiber: 2.5,
    flags: ['glutenFree'], cat: 'Produce', season: 'winter/autumn', iconKey: 'cabbage', src: 'USDA FDC 169975 (cabbage, raw); kcal per 4/4/9'
  },
  'escarole': {
    name: 'Escarole / endive, raw', per: 100, unit: 'g',
    kcal: 21, protein: 1.3, carbs: 3.4, fat: 0.2, satFat: 0.0, fiber: 3.1,
    flags: ['highFiber', 'glutenFree'], cat: 'Produce', season: 'winter/autumn', iconKey: 'escarole', src: 'USDA FDC 169992-style (endive/escarole, raw); kcal per 4/4/9'
  },
  'lettuce': {
    name: 'Lettuce, romaine, raw', per: 100, unit: 'g',
    kcal: 20, protein: 1.2, carbs: 3.3, fat: 0.3, satFat: 0.0, fiber: 2.1,
    flags: ['glutenFree'], cat: 'Produce', iconKey: 'lettuce', src: 'USDA FDC 169247 (lettuce, romaine, raw); kcal per 4/4/9'
  },
  'garlic': {
    name: 'Garlic, raw', per: 100, unit: 'g',
    kcal: 163, protein: 6.4, carbs: 33.1, fat: 0.5, satFat: 0.1, fiber: 2.1,
    flags: [], cat: 'Produce', iconKey: 'garlic', src: 'USDA FDC 169230 (garlic, raw); kcal per 4/4/9'
  },
  'avocado': {
    name: 'Avocado, raw', per: 100, unit: 'g',
    kcal: 174, protein: 2.0, carbs: 8.5, fat: 14.7, satFat: 2.1, fiber: 6.7,
    flags: ['highFiber'], cat: 'Produce', iconKey: 'avocado', src: 'USDA FDC 171705 (avocado, raw)'
  },
  'tomatoes': {
    name: 'Tomatoes, raw', per: 100, unit: 'g',
    kcal: 21, protein: 0.9, carbs: 3.9, fat: 0.2, satFat: 0.0, fiber: 1.2,
    flags: [], cat: 'Produce', season: 'spring/summer', iconKey: 'cherry-tomatoes', src: 'USDA FDC 170457-style (tomatoes, red, raw)'
  },
  'potatoes': {
    name: 'Potatoes, raw', per: 100, unit: 'g',
    kcal: 77, protein: 2.0, carbs: 17.0, fat: 0.1, satFat: 0.0, fiber: 2.2,
    flags: ['glutenFree'], cat: 'Produce', iconKey: 'potatoes', src: 'USDA FDC 170026 (potato, flesh and skin, raw)'
  },
  'oranges': {
    name: 'Oranges, raw', per: 100, unit: 'g',
    kcal: 52, protein: 0.9, carbs: 11.8, fat: 0.1, satFat: 0.0, fiber: 2.4, sugars: 9.4, freeSugars: 0, sugarQuality: 'intrinsic',
    flags: ['highFiber'], cat: 'Produce', season: 'winter/autumn', breakfastPair: true, iconKey: 'oranges', src: 'USDA FDC 169918 (orange, raw)'
  },
  'apples': {
    name: 'Apples, raw, with skin', per: 100, unit: 'g',
    kcal: 58, protein: 0.3, carbs: 13.8, fat: 0.2, satFat: 0.0, fiber: 2.4, sugars: 10.4, freeSugars: 0, sugarQuality: 'intrinsic',
    flags: ['highFiber'], cat: 'Produce', season: 'winter/autumn', breakfastPair: true, iconKey: 'apples', src: 'USDA FDC 171688 (apple, raw, with skin)'
  },
  'bananas': {
    name: 'Bananas, raw', per: 100, unit: 'g',
    kcal: 98, protein: 1.1, carbs: 22.8, fat: 0.3, satFat: 0.1, fiber: 2.6, sugars: 12.2, freeSugars: 0, sugarQuality: 'intrinsic',
    flags: [], cat: 'Produce', breakfastPair: true, iconKey: 'bananas', src: 'USDA FDC 173944 (banana, raw)'
  },
  'rocket-arugula': {
    name: 'Rocket / arugula, raw', per: 100, unit: 'g',
    kcal: 32, protein: 2.6, carbs: 3.7, fat: 0.7, satFat: 0.1, fiber: 1.6,
    flags: [], cat: 'Produce', iconKey: 'rocket-arugula', src: 'USDA FDC 168435 (arugula, raw); kcal per 4/4/9'
  },
  'basil': {
    name: 'Basil, fresh', per: 100, unit: 'g',
    kcal: 29, protein: 3.2, carbs: 2.7, fat: 0.6, satFat: 0.0, fiber: 1.6,
    flags: [], cat: 'Produce', season: 'spring/summer', iconKey: 'basil', src: 'USDA FDC 172232 (basil, fresh); kcal per 4/4/9'
  },
  'mixed-peppers-spinach': {
    name: 'Mixed peppers & spinach (blend)', per: 100, unit: 'g',
    kcal: 30, protein: 1.8, carbs: 5.0, fat: 0.3, satFat: 0.0, fiber: 2.1,
    flags: [], cat: 'Produce',
    iconKey: 'bell-pepper', src: 'Composite: 60% red bell pepper + 40% spinach, weighted avg of USDA raw values'
  },
  'roasted-mixed-veg': {
    name: 'Roasted mixed veg (courgette, pepper, aubergine, onion)', per: 100, unit: 'g',
    kcal: 58, protein: 1.1, carbs: 6.1, fat: 3.2, satFat: 0.4, fiber: 2.0,
    flags: ['highFiber'], cat: 'Produce', season: 'spring/summer',
    iconKey: 'courgette', src: 'Composite: equal-weight courgette + red bell pepper + aubergine + red onion (USDA raw) + ~3g/100g roasting oil'
  },
  'broccoli-courgette': {
    name: 'Broccoli & courgette (blend)', per: 100, unit: 'g',
    kcal: 31, protein: 2.0, carbs: 4.9, fat: 0.4, satFat: 0.1, fiber: 1.8,
    flags: ['highFiber'], cat: 'Produce',
    iconKey: 'broccoli-courgette', src: 'Composite: 50/50 broccoli + courgette, USDA raw values'
  },
  'cherry-tomatoes-cucumber': {
    name: 'Cherry tomatoes & cucumber (blend)', per: 100, unit: 'g',
    kcal: 20, protein: 0.8, carbs: 3.8, fat: 0.2, satFat: 0.0, fiber: 0.9,
    flags: [], cat: 'Produce', season: 'spring/summer',
    iconKey: 'cherry-tomatoes-cucumber', src: 'Composite: 50/50 cherry tomatoes + cucumber, USDA raw values'
  },

  /* ---------------- Protein ---------------- */

  'eggs': {
    name: 'Eggs, whole', per: 1, unit: 'piece', avgG: 50,
    kcal: 70, protein: 6.3, carbs: 0.4, fat: 4.8, satFat: 1.6, fiber: 0,
    flags: ['selenium'], cat: 'Protein', iconKey: 'eggs', src: 'USDA FDC 748967 (egg, whole, raw), per ~50g large egg'
  },
  'salmon-fillet': {
    name: 'Salmon fillet, raw (Atlantic)', per: 100, unit: 'g',
    kcal: 202, protein: 20.4, carbs: 0, fat: 13.4, satFat: 3.1, fiber: 0,
    flags: ['omega3', 'selenium'], cat: 'Protein', src: 'USDA FDC 175167 (salmon, Atlantic, raw)'
  },
  'turkey-breast': {
    name: 'Turkey breast, sliced, cooked (deli-style)', per: 100, unit: 'g',
    kcal: 100, protein: 17.1, carbs: 1.9, fat: 2.7, satFat: 0.7, fiber: 0,
    flags: ['selenium'], cat: 'Protein', src: 'USDA FDC 171506-style (turkey breast, sliced, cooked)'
  },
  'chicken-breast': {
    name: 'Chicken breast, grilled, skinless', per: 100, unit: 'g',
    kcal: 156, protein: 31.0, carbs: 0, fat: 3.6, satFat: 1.0, fiber: 0,
    flags: ['selenium'], cat: 'Protein', iconKey: 'chicken-breast', src: 'USDA FDC 171077 (chicken, breast, grilled, skinless)'
  },
  'tuna-in-olive-oil': {
    name: 'Tuna, canned in olive oil, drained', per: 100, unit: 'g',
    kcal: 187, protein: 26.5, carbs: 0, fat: 9.0, satFat: 1.6, fiber: 0,
    flags: ['omega3', 'selenium'], cat: 'Protein', src: 'USDA FDC 175159 (tuna, canned in oil, drained)'
  },
  'tuna': {
    name: 'Tuna, canned in water, drained', per: 100, unit: 'g',
    kcal: 112, protein: 26.2, carbs: 0, fat: 0.8, satFat: 0.2, fiber: 0,
    flags: ['selenium', 'omega3'], cat: 'Protein', src: 'USDA FDC 175160-style (tuna, canned in water, drained)'
  },
  'sardines': {
    name: 'Sardines, canned in olive oil, drained', per: 100, unit: 'g',
    kcal: 202, protein: 24.6, carbs: 0, fat: 11.5, satFat: 1.5, fiber: 0,
    flags: ['omega3', 'selenium', 'highIodine'], cat: 'Protein', src: 'USDA FDC 175139 (sardines, canned in oil, drained)'
  },
  'cod': {
    name: 'Cod / white fish, raw', per: 100, unit: 'g',
    kcal: 78, protein: 17.8, carbs: 0, fat: 0.7, satFat: 0.1, fiber: 0,
    flags: ['selenium', 'highIodine'], cat: 'Protein', iconKey: 'cod', src: 'USDA FDC 175167-style (cod, Atlantic, raw)'
  },
  'prawns': {
    name: 'Prawns / shrimp, raw', per: 100, unit: 'g',
    kcal: 100, protein: 24.0, carbs: 0.2, fat: 0.3, satFat: 0.1, fiber: 0,
    flags: ['selenium', 'highIodine'], cat: 'Protein', src: 'USDA FDC 171998 (shrimp, raw)'
  },
  'chicken-thigh': {
    name: 'Chicken thigh, skinless, raw', per: 100, unit: 'g',
    kcal: 141, protein: 17.0, carbs: 0, fat: 8.1, satFat: 2.3, fiber: 0,
    flags: ['selenium'], cat: 'Protein', iconKey: 'chicken-thigh', src: 'USDA FDC 171476 (chicken, thigh, skinless, raw)'
  },
  'beef-mince-lean': {
    name: 'Beef mince, lean (95/5), raw', per: 100, unit: 'g',
    kcal: 129, protein: 21.0, carbs: 0, fat: 5.0, satFat: 2.1, fiber: 0,
    flags: ['selenium'], cat: 'Protein', iconKey: 'beef-mince-lean', src: 'USDA FDC 174036-style (beef, ground, 95% lean, raw)'
  },
  'pork-loin': {
    name: 'Pork loin, lean, raw', per: 100, unit: 'g',
    kcal: 127, protein: 21.5, carbs: 0, fat: 4.5, satFat: 1.6, fiber: 0,
    flags: ['selenium'], cat: 'Protein', src: 'USDA FDC 167907-style (pork loin, lean, raw)'
  },
  'bresaola': {
    name: 'Bresaola (cured beef), sliced', per: 100, unit: 'g',
    kcal: 148, protein: 32.0, carbs: 0.5, fat: 2.0, satFat: 0.8, fiber: 0,
    flags: ['selenium'], cat: 'Protein', iconKey: 'bresaola', src: 'CREA-style Italian food table (bresaola)'
  },
  'bacon': {
    name: 'Bacon / pancetta, cooked', per: 100, unit: 'g',
    kcal: 460, protein: 34.0, carbs: 1.7, fat: 35.0, satFat: 12.0, fiber: 0,
    flags: ['selenium'], cat: 'Protein', iconKey: 'bacon', src: 'USDA FDC 167914-style (bacon, cooked); kcal per 4/4/9'
  },
  'prosciutto-cotto': {
    name: 'Prosciutto cotto / cooked ham', per: 100, unit: 'g',
    kcal: 145, protein: 20.0, carbs: 1.5, fat: 6.5, satFat: 2.1, fiber: 0,
    flags: ['selenium'], cat: 'Protein', src: 'CREA-style Italian food table / deli ham average'
  },
  'tofu': {
    name: 'Tofu, firm', per: 100, unit: 'g',
    kcal: 128, protein: 17.3, carbs: 2.8, fat: 5.3, satFat: 0.8, fiber: 2.3,
    flags: ['glutenFree'], cat: 'Protein', src: 'USDA FDC 172475-style (tofu, firm); kcal per 4/4/9'
  },
  'chickpeas': {
    name: 'Chickpeas, cooked', per: 100, unit: 'g',
    kcal: 169, protein: 8.9, carbs: 27.4, fat: 2.6, satFat: 0.3, fiber: 7.6,
    flags: ['highFiber', 'lowGI', 'glutenFree'], cat: 'Protein', iconKey: 'chickpeas', src: 'USDA FDC 173757 (chickpeas, cooked, boiled)'
  },
  'cannellini-beans': {
    name: 'Cannellini / white beans, cooked', per: 100, unit: 'g',
    kcal: 131, protein: 8.7, carbs: 22.8, fat: 0.5, satFat: 0.1, fiber: 6.3,
    flags: ['highFiber', 'lowGI', 'glutenFree'], cat: 'Protein', iconKey: 'cannellini-beans', src: 'USDA FDC 173743-style (white/cannellini beans, cooked)'
  },

  /* ---------------- Dairy ---------------- */

  'greek-yogurt': {
    name: 'Greek yogurt, plain (2%)', per: 100, unit: 'g',
    kcal: 72, protein: 9.9, carbs: 3.9, fat: 1.9, satFat: 1.2, fiber: 0, sugars: 3.5, freeSugars: 0, sugarQuality: 'intrinsic',
    flags: ['lowGI', 'fermented'], cat: 'Dairy', src: 'USDA FDC 171304 (yogurt, Greek, plain, 2% fat)'
  },
  'skyr': {
    name: 'Skyr, plain', per: 100, unit: 'g',
    kcal: 62, protein: 11.0, carbs: 4.0, fat: 0.2, satFat: 0.1, fiber: 0, sugars: 4.0, freeSugars: 0, sugarQuality: 'intrinsic',
    flags: ['lowGI', 'fermented'], cat: 'Dairy', src: 'Icelandic dairy standard table (skyr, plain)'
  },
  'feta-cheese': {
    name: 'Feta cheese', per: 100, unit: 'g',
    kcal: 265, protein: 14.2, carbs: 4.1, fat: 21.3, satFat: 14.9, fiber: 0,
    flags: ['fermented'], cat: 'Dairy', src: 'USDA FDC 173417 (cheese, feta)'
  },
  'parmesan': {
    name: 'Parmesan, grated', per: 100, unit: 'g',
    kcal: 388, protein: 35.8, carbs: 3.2, fat: 25.8, satFat: 16.4, fiber: 0,
    flags: ['fermented'], cat: 'Dairy', src: 'USDA FDC 173419-style (cheese, parmesan, grated)'
  },
  'pecorino': {
    name: 'Pecorino romano, grated', per: 100, unit: 'g',
    kcal: 371, protein: 28.6, carbs: 3.6, fat: 26.9, satFat: 17.1, fiber: 0,
    flags: ['fermented'], cat: 'Dairy', src: 'USDA FDC-style (cheese, pecorino romano); kcal per 4/4/9'
  },
  'mozzarella': {
    name: 'Mozzarella, fresh (whole milk)', per: 100, unit: 'g',
    kcal: 283, protein: 18.1, carbs: 2.2, fat: 22.4, satFat: 13.2, fiber: 0,
    flags: ['fermented'], cat: 'Dairy', src: 'USDA FDC 173441-style (cheese, mozzarella, whole milk)'
  },
  'robiola': {
    name: 'Robiola cheese', per: 100, unit: 'g',
    kcal: 326, protein: 8.8, carbs: 2.0, fat: 31.4, satFat: 20.0, fiber: 0,
    flags: ['fermented'], cat: 'Dairy', src: 'CREA-style Italian food table / manufacturer label average (robiola)'
  },
  'provola': {
    name: 'Provola cheese', per: 100, unit: 'g',
    kcal: 351, protein: 25.0, carbs: 2.0, fat: 27.0, satFat: 17.0, fiber: 0,
    flags: ['fermented'], cat: 'Dairy', src: 'CREA-style Italian food table / manufacturer label average (provola)'
  },
  'scamorza': {
    name: 'Scamorza cheese', per: 100, unit: 'g',
    kcal: 333, protein: 25.0, carbs: 2.0, fat: 25.0, satFat: 16.0, fiber: 0,
    flags: ['fermented'], cat: 'Dairy', src: 'CREA-style Italian food table / manufacturer label average (scamorza)'
  },
  'ricotta': {
    name: 'Ricotta, whole milk', per: 100, unit: 'g',
    kcal: 166, protein: 8.8, carbs: 3.5, fat: 13.0, satFat: 8.3, fiber: 0,
    flags: [], cat: 'Dairy', src: 'USDA FDC 173439 (cheese, ricotta, whole milk)'
  },
  'butter': {
    name: 'Butter, salted', per: 100, unit: 'g',
    kcal: 717, protein: 0.9, carbs: 0.1, fat: 81.0, satFat: 51.4, fiber: 0, sugars: 0.1, freeSugars: 0, sugarQuality: 'intrinsic',
    flags: [], cat: 'Dairy', iconKey: 'butter', iconAsset: 'assets/ingredients/butter.png', src: 'USDA FDC 173410-style (butter, salted)'
  },
  'gorgonzola': {
    name: 'Gorgonzola / blue cheese', per: 100, unit: 'g',
    kcal: 351, protein: 21.4, carbs: 2.3, fat: 28.7, satFat: 18.7, fiber: 0,
    flags: ['fermented'], cat: 'Dairy', src: 'USDA FDC 170895-style (blue cheese); kcal per 4/4/9'
  },
  'milk': {
    name: 'Milk, whole (3.5% fat)', per: 100, unit: 'ml',
    kcal: 65, protein: 3.3, carbs: 4.8, fat: 3.6, satFat: 2.3, fiber: 0, sugars: 4.8, freeSugars: 0, sugarQuality: 'intrinsic',
    flags: [], cat: 'Dairy', iconKey: 'milk', src: 'USDA FDC 746782 (milk, whole, 3.25-3.5% fat)'
  },
  'oat-milk': {
    name: 'Oat milk, unsweetened', per: 100, unit: 'ml',
    kcal: 43, protein: 0.6, carbs: 6.7, fat: 1.5, satFat: 0.2, fiber: 0.8, sugars: 3.3, freeSugars: 0, sugarQuality: 'intrinsic',
    flags: [], cat: 'Dairy', iconKey: 'milk', src: 'Generic oat milk, unsweetened, manufacturer label average'
  },
  'espresso-unsweetened': {
    name: 'Coffee / espresso, no sugar', per: 1, unit: 'piece', avgG: 1,
    kcal: 0, protein: 0, carbs: 0, fat: 0, satFat: 0, fiber: 0,
    flags: [], cat: 'Pantry', iconKey: 'espresso-unsweetened', src: 'USDA FDC 171891-style (coffee, brewed) rounded per espresso; no sugar'
  },
  'cappuccino-unsweetened': {
    name: 'Cappuccino, no sugar', per: 1, unit: 'piece', avgG: 1,
    kcal: 65, protein: 3.4, carbs: 4.8, fat: 3.6, satFat: 2.3, fiber: 0, sugars: 4.8, freeSugars: 0, sugarQuality: 'intrinsic',
    flags: [], cat: 'Dairy', iconKey: 'cappuccino-unsweetened', src: 'Composite: espresso + ~100ml whole milk, no sugar'
  },

  /* ---------------- Bakery ---------------- */

  'rye-bread': {
    name: 'Rye bread', per: 100, unit: 'g',
    kcal: 257, protein: 8.5, carbs: 48.3, fat: 3.3, satFat: 0.5, fiber: 5.8,
    flags: ['highFiber'], cat: 'Bakery', breakfastPair: true, iconKey: 'rye-bread', src: 'USDA FDC 172686 (bread, rye)'
  },
  'wholewheat-bread': {
    name: 'Whole-wheat bread', per: 100, unit: 'g',
    kcal: 232, protein: 9.0, carbs: 41.3, fat: 3.4, satFat: 0.7, fiber: 7.0,
    flags: ['highFiber'], cat: 'Bakery', breakfastPair: true, iconKey: 'wholewheat-bread', src: 'USDA FDC 172687-style (bread, whole wheat)'
  },
  'white-bread': {
    name: 'White bread / toast bread', per: 100, unit: 'g',
    kcal: 274, protein: 8.9, carbs: 49.0, fat: 3.5, satFat: 0.8, fiber: 2.7,
    flags: [], cat: 'Bakery', breakfastPair: true, iconKey: 'white-bread', src: 'USDA FDC 169230-style (white bread); kcal per 4/4/9'
  },
  'pizza-bianca': {
    name: 'Pizza bianca / focaccia romana', per: 100, unit: 'g',
    kcal: 319, protein: 8.0, carbs: 52.0, fat: 9.0, satFat: 1.4, fiber: 2.2,
    flags: [], cat: 'Bakery', iconKey: 'pizza-bianca', src: 'Italian bakery label average for pizza bianca/focaccia; kcal per 4/4/9'
  },
  'pasta-filo': {
    name: 'Pasta filo', per: 100, unit: 'g',
    kcal: 315, protein: 9.0, carbs: 59.0, fat: 4.0, satFat: 0.8, fiber: 2.0,
    flags: [], cat: 'Bakery', iconKey: 'pasta-filo', src: 'USDA FDC-style phyllo dough average; kcal per 4/4/9'
  },

  /* ---------------- Pantry ---------------- */

  'granola': {
    name: 'Granola, plain', per: 100, unit: 'g',
    kcal: 476, protein: 10.0, carbs: 64.0, fat: 20.0, satFat: 3.5, fiber: 7.0, sugars: 20.0, freeSugars: 10.0, sugarQuality: 'mixed',
    flags: ['highFiber'], cat: 'Pantry', src: 'USDA FDC 173977-style (granola, plain)'
  },
  'honey': {
    name: 'Honey', per: 100, unit: 'g',
    kcal: 331, protein: 0.3, carbs: 82.4, fat: 0, satFat: 0, fiber: 0.2, sugars: 82.1, freeSugars: 82.1, sugarQuality: 'added/free',
    flags: [], cat: 'Pantry', src: 'USDA FDC 169640 (honey)'
  },
  'maple-syrup': {
    name: 'Maple syrup', per: 100, unit: 'ml',
    kcal: 276, protein: 0.0, carbs: 67.0, fat: 0.1, satFat: 0.0, fiber: 0, sugars: 60.5, freeSugars: 60.5, sugarQuality: 'added/free',
    flags: [], cat: 'Pantry', src: 'USDA FDC 169661-style (maple syrup); kcal per 4/4/9'
  },
  'chia-seeds': {
    name: 'Chia seeds', per: 100, unit: 'g',
    kcal: 511, protein: 16.5, carbs: 42.1, fat: 30.7, satFat: 3.3, fiber: 34.4,
    flags: ['omega3', 'highFiber', 'glutenFree'], cat: 'Pantry', iconKey: 'chia-seeds', src: 'USDA FDC 170554 (chia seeds, dried)'
  },
  'quinoa-dry': {
    name: 'Quinoa, dry (uncooked)', per: 100, unit: 'g',
    kcal: 368, protein: 14.1, carbs: 64.2, fat: 6.1, satFat: 0.7, fiber: 7.0,
    flags: ['lowGI', 'glutenFree', 'highFiber'], cat: 'Pantry', src: 'USDA FDC 168917 (quinoa, uncooked)'
  },
  'cooked-lentils': {
    name: 'Lentils, cooked', per: 100, unit: 'g',
    kcal: 120, protein: 9.0, carbs: 20.1, fat: 0.4, satFat: 0.1, fiber: 7.9,
    flags: ['highFiber', 'lowGI', 'glutenFree'], cat: 'Pantry', src: 'USDA FDC 172420 (lentils, cooked, boiled)'
  },
  'farro-cooked': {
    name: 'Farro, cooked', per: 100, unit: 'g',
    kcal: 133, protein: 5.0, carbs: 26.0, fat: 1.0, satFat: 0.2, fiber: 3.5,
    flags: ['highFiber', 'lowGI'], cat: 'Pantry', src: 'CREA-style Italian food table (farro, cooked)'
  },
  'pasta': {
    name: 'Pasta, dry (durum wheat)', per: 100, unit: 'g',
    kcal: 364, protein: 13.0, carbs: 74.7, fat: 1.5, satFat: 0.3, fiber: 3.2,
    flags: [], cat: 'Pantry', iconKey: 'pasta', src: 'USDA FDC 168927-style (pasta, dry, unenriched)'
  },
  'spaghetti': {
    name: 'Spaghetti, dry', per: 100, unit: 'g',
    kcal: 364, protein: 13.0, carbs: 74.7, fat: 1.5, satFat: 0.3, fiber: 3.2, sugars: 2.7, freeSugars: 0, sugarQuality: 'intrinsic',
    flags: [], cat: 'Pantry', iconKey: 'pasta', src: 'USDA FDC-style (spaghetti, dry); matched to dry pasta average'
  },
  'wholegrain-pasta': {
    name: 'Wholegrain pasta, dry', per: 100, unit: 'g',
    kcal: 328, protein: 13.4, carbs: 63.0, fat: 2.5, satFat: 0.5, fiber: 8.0,
    flags: ['highFiber', 'lowGI'], cat: 'Pantry', iconKey: 'pasta', src: 'USDA FDC 168928-style (pasta, whole wheat, dry)'
  },
  'lasagna-sheets': {
    name: 'Lasagna sheets, dry', per: 100, unit: 'g',
    kcal: 364, protein: 13.0, carbs: 74.7, fat: 1.5, satFat: 0.3, fiber: 3.2, sugars: 2.7, freeSugars: 0, sugarQuality: 'intrinsic',
    flags: [], cat: 'Pantry', iconKey: 'pasta', src: 'USDA FDC-style (lasagna sheets, dry); matched to dry pasta average'
  },
  'ravioli': {
    name: 'Ravioli, egg pasta with filling, fresh', per: 100, unit: 'g',
    kcal: 263, protein: 11.0, carbs: 36.0, fat: 8.0, satFat: 3.0, fiber: 2.0, sugars: 2.0, freeSugars: 0.5, sugarQuality: 'mixed',
    flags: [], cat: 'Pantry', iconKey: 'pasta', src: 'USDA FDC-style (ravioli, cheese-filled, fresh); representative filled-pasta average'
  },
  'spring-rolls': {
    name: 'Spring rolls, vegetable, baked', per: 100, unit: 'g',
    kcal: 218, protein: 4.0, carbs: 30.0, fat: 9.0, satFat: 1.4, fiber: 3.0, sugars: 3.5, freeSugars: 1.5, sugarQuality: 'mixed',
    flags: [], cat: 'Frozen', iconKey: 'pasta-filo', src: 'USDA FDC-style (vegetable spring rolls, baked/frozen); representative appetizer average'
  },
  'tomato-passata': {
    name: 'Tomato passata', per: 100, unit: 'g',
    kcal: 29, protein: 1.4, carbs: 5.0, fat: 0.2, satFat: 0.0, fiber: 1.4, sugars: 3.0, freeSugars: 0, sugarQuality: 'intrinsic',
    flags: [], cat: 'Pantry', iconKey: 'cherry-tomatoes', src: 'USDA FDC-style (tomato puree / passata, unsalted)'
  },
  'rice': {
    name: 'Rice, white, dry', per: 100, unit: 'g',
    kcal: 355, protein: 7.1, carbs: 80.0, fat: 0.7, satFat: 0.2, fiber: 1.3,
    flags: ['glutenFree'], cat: 'Pantry', iconKey: 'rice', src: 'USDA FDC 169756 (rice, white, long-grain, dry)'
  },
  'couscous': {
    name: 'Couscous, dry', per: 100, unit: 'g',
    kcal: 346, protein: 12.8, carbs: 72.4, fat: 0.6, satFat: 0.1, fiber: 5.0,
    flags: [], cat: 'Pantry', iconKey: 'couscous', src: 'USDA FDC 169736 (couscous, dry)'
  },
  'barley': {
    name: 'Barley, pearled, dry', per: 100, unit: 'g',
    kcal: 361, protein: 9.9, carbs: 77.7, fat: 1.2, satFat: 0.3, fiber: 15.6,
    flags: ['highFiber', 'lowGI'], cat: 'Pantry', iconKey: 'barley', src: 'USDA FDC 170287 (barley, pearled, raw)'
  },
  'egg-noodles': {
    name: 'Egg noodles, dry', per: 100, unit: 'g',
    kcal: 371, protein: 14.2, carbs: 71.3, fat: 4.4, satFat: 1.2, fiber: 3.3,
    flags: [], cat: 'Pantry', iconKey: 'pasta', src: 'USDA FDC 169740-style (egg noodles, dry); kcal per 4/4/9'
  },
  'ramen-noodles': {
    name: 'Ramen noodles, dry', per: 100, unit: 'g',
    kcal: 438, protein: 10.0, carbs: 62.0, fat: 16.0, satFat: 7.0, fiber: 2.8,
    flags: [], cat: 'Pantry', iconKey: 'pasta', src: 'USDA FDC-style ramen noodles, dry; kcal per 4/4/9'
  },
  'olive-oil': {
    name: 'Olive oil, extra virgin', per: 100, unit: 'ml',
    kcal: 900, protein: 0, carbs: 0, fat: 100, satFat: 13.8, fiber: 0,
    flags: [], cat: 'Pantry', src: 'USDA FDC 171413 (oil, olive)'
  },
  'balsamic-vinegar': {
    name: 'Balsamic vinegar', per: 100, unit: 'ml',
    kcal: 90, protein: 0.5, carbs: 22.0, fat: 0, satFat: 0, fiber: 0, sugars: 15.0, freeSugars: 15.0, sugarQuality: 'added/free',
    flags: [], cat: 'Pantry', iconKey: 'balsamic-vinegar', src: 'USDA FDC 172387-style (vinegar, balsamic); kcal per 4/4/9'
  },
  'soy-sauce': {
    name: 'Soy sauce', per: 100, unit: 'ml',
    kcal: 57, protein: 8.1, carbs: 4.9, fat: 0.1, satFat: 0.0, fiber: 0.8,
    flags: [], cat: 'Pantry', src: 'USDA FDC 174277-style (soy sauce); kcal per 4/4/9'
  },
  'ginger': {
    name: 'Ginger, fresh', per: 100, unit: 'g',
    kcal: 84, protein: 1.8, carbs: 17.8, fat: 0.8, satFat: 0.2, fiber: 2.0,
    flags: [], cat: 'Produce', iconKey: 'ginger', src: 'USDA FDC 169231 (ginger root, raw); kcal per 4/4/9'
  },
  'mustard': {
    name: 'Mustard', per: 100, unit: 'g',
    kcal: 76, protein: 4.4, carbs: 5.8, fat: 4.0, satFat: 0.2, fiber: 4.0,
    flags: [], cat: 'Pantry', src: 'USDA FDC 172234-style (mustard, prepared); kcal per 4/4/9'
  },
  'dark-chocolate-85': {
    name: 'Dark chocolate, 85% cocoa', per: 100, unit: 'g',
    kcal: 591, protein: 7.8, carbs: 23.0, fat: 52.0, satFat: 31.0, fiber: 11.0, sugars: 7.0, freeSugars: 7.0, sugarQuality: 'mixed',
    flags: ['highFiber'], cat: 'Pantry', src: 'USDA FDC 170272-style (chocolate, dark, 85% cacao)'
  },
  'chocolate-hazelnut-spread': {
    name: 'Chocolate hazelnut spread', per: 100, unit: 'g',
    kcal: 533, protein: 6.3, carbs: 57.5, fat: 30.9, satFat: 10.6, fiber: 3.4, sugars: 56.0, freeSugars: 50.0, sugarQuality: 'mixed',
    flags: [], cat: 'Pantry', src: 'Generic Nutella-style chocolate hazelnut spread label average; kcal per 4/4/9'
  },
  'whey-protein-powder': {
    name: 'Protein powder, whey', per: 100, unit: 'g',
    kcal: 402, protein: 80.0, carbs: 7.0, fat: 6.0, satFat: 3.0, fiber: 0,
    flags: [], cat: 'Pantry', src: 'Generic whey protein powder label average; kcal per 4/4/9'
  },
  'gelato-chocolate': {
    name: 'Gelato, chocolate', per: 100, unit: 'g',
    kcal: 206, protein: 4.0, carbs: 25.0, fat: 10.0, satFat: 6.5, fiber: 1.5, sugars: 22.0, freeSugars: 18.0, sugarQuality: 'mixed',
    flags: [], cat: 'Frozen', src: 'Italian gelato manufacturer label average (chocolate)'
  },
  'gelato-stracciatella': {
    name: 'Gelato, stracciatella', per: 100, unit: 'g',
    kcal: 209, protein: 3.5, carbs: 24.0, fat: 11.0, satFat: 7.0, fiber: 0.5, sugars: 21.0, freeSugars: 17.0, sugarQuality: 'mixed',
    flags: [], cat: 'Frozen', src: 'Italian gelato manufacturer label average (stracciatella)'
  },
  'gelato-yogurt': {
    name: 'Gelato, yogurt', per: 100, unit: 'g',
    kcal: 173, protein: 4.0, carbs: 28.0, fat: 5.0, satFat: 3.2, fiber: 0, sugars: 25.0, freeSugars: 19.0, sugarQuality: 'mixed',
    flags: [], cat: 'Frozen', src: 'Italian gelato manufacturer label average (yogurt)'
  },
  'gelato-crema': {
    name: 'Gelato, crema', per: 100, unit: 'g',
    kcal: 192, protein: 4.0, carbs: 26.0, fat: 8.0, satFat: 5.0, fiber: 0, sugars: 23.0, freeSugars: 18.0, sugarQuality: 'mixed',
    flags: [], cat: 'Frozen', src: 'Italian gelato manufacturer label average (crema)'
  },
  'fast-food-beef-burger': {
    name: 'Fast-food beef burger', per: 100, unit: 'g',
    kcal: 255, protein: 12.0, carbs: 27.0, fat: 11.0, satFat: 4.0, fiber: 1.5,
    flags: [], cat: 'Bakery', iconKey: 'fast-food-beef-burger', src: 'USDA FDC-style branded fast-food cheeseburger average'
  },
  'fast-food-fries': {
    name: 'Fast-food fries', per: 100, unit: 'g',
    kcal: 313, protein: 3.4, carbs: 41.0, fat: 15.0, satFat: 2.3, fiber: 3.8,
    flags: [], cat: 'Frozen', src: 'USDA FDC 170698-style fast-food french fries average'
  },
  'cola': {
    name: 'Cola', per: 100, unit: 'ml',
    kcal: 42, protein: 0, carbs: 10.6, fat: 0, satFat: 0, fiber: 0, sugars: 10.6, freeSugars: 10.6, sugarQuality: 'added/free',
    flags: [], cat: 'Pantry', iconKey: 'cola', src: 'USDA FDC 174819-style cola soft drink'
  },
  'brownie': {
    name: 'Brownie', per: 100, unit: 'g',
    kcal: 417, protein: 5.0, carbs: 52.0, fat: 21.0, satFat: 8.0, fiber: 2.2, sugars: 37.0, freeSugars: 30.0, sugarQuality: 'mixed',
    flags: [], cat: 'Bakery', iconKey: 'brownie', src: 'USDA FDC 167982-style brownie, commercial'
  },
  'capers': {
    name: 'Capers, brined, drained', per: 100, unit: 'g',
    kcal: 37, protein: 2.4, carbs: 4.9, fat: 0.9, satFat: 0.1, fiber: 3.2,
    flags: [], cat: 'Pantry', iconKey: 'capers', src: 'USDA FDC 170915 (capers, canned); kcal per 4/4/9'
  },
  'olives': {
    name: 'Olives, green, in brine', per: 100, unit: 'g',
    kcal: 157, protein: 1.0, carbs: 3.8, fat: 15.3, satFat: 2.0, fiber: 3.3,
    flags: [], cat: 'Pantry', src: 'USDA FDC 171899-style (olives, green, canned/pickled)'
  },
  'sweet-potato': {
    name: 'Sweet potato', per: 100, unit: 'g',
    kcal: 88, protein: 1.6, carbs: 20.1, fat: 0.1, satFat: 0, fiber: 3.0,
    flags: ['highFiber', 'glutenFree'], cat: 'Produce', iconKey: 'sweet-potato', src: 'USDA FDC 168482 (sweet potato, raw); kcal via 4/4/9 policy'
  },
  'brazil-nuts': {
    name: 'Brazil nuts', per: 100, unit: 'g',
    kcal: 704, protein: 14.3, carbs: 12.3, fat: 66.4, satFat: 15.1, fiber: 7.5,
    flags: ['selenium'], cat: 'Pantry', iconKey: 'brazil-nuts', src: 'USDA FDC 170569 (nuts, brazil, dried)'
  },
  'walnuts': {
    name: 'Walnuts', per: 100, unit: 'g',
    kcal: 702, protein: 15.2, carbs: 13.7, fat: 65.2, satFat: 6.1, fiber: 6.7,
    flags: ['omega3', 'highFiber'], cat: 'Pantry', src: 'USDA FDC 170187 (nuts, walnuts, English)'
  },
  'almonds': {
    name: 'Almonds', per: 100, unit: 'g',
    kcal: 620, protein: 21.2, carbs: 21.6, fat: 49.9, satFat: 3.8, fiber: 12.5,
    flags: ['highFiber'], cat: 'Pantry', iconKey: 'almonds', src: 'USDA FDC 170567 (nuts, almonds)'
  },
  'pesto-elena': {
    name: 'Pesto Elena (basil, parmesan, pecorino, almonds)', per: 100, unit: 'g',
    kcal: 362, protein: 20.8, carbs: 4.3, fat: 29.1, satFat: 10.8, fiber: 1.4,
    flags: ['fermented'], cat: 'Pantry', season: 'spring/summer',
    iconKey: 'basil', src: 'Composite Elena recipe: 50g fresh basil + 70g parmesan + 30g pecorino romano + 15g almonds + assumed 20ml olive oil ("a sentimento"); per 100g of ~185g batch, kcal per 4/4/9'
  },
  'oats': {
    name: 'Oats, rolled, dry', per: 100, unit: 'g',
    kcal: 395, protein: 16.9, carbs: 66.3, fat: 6.9, satFat: 1.2, fiber: 10.6,
    flags: ['highFiber'], cat: 'Pantry', src: 'USDA FDC 173904 (oats, rolled, dry)'
  },
  'pumpkin-seeds': {
    name: 'Pumpkin seeds, hulled, raw', per: 100, unit: 'g',
    kcal: 605, protein: 30.2, carbs: 10.7, fat: 49.0, satFat: 8.7, fiber: 6.0,
    flags: ['omega3'], cat: 'Pantry', src: 'USDA FDC 170556 (seeds, pumpkin, hulled, raw)'
  },
  'hummus': {
    name: 'Hummus', per: 100, unit: 'g',
    kcal: 175, protein: 7.9, carbs: 14.3, fat: 9.6, satFat: 1.3, fiber: 6.0,
    flags: ['highFiber', 'glutenFree'], cat: 'Pantry', iconKey: 'chickpeas', src: 'USDA FDC 172420-style (hummus, commercial)'
  },
  'coconut-milk': {
    name: 'Coconut milk, canned (regular)', per: 100, unit: 'ml',
    kcal: 245, protein: 2.3, carbs: 5.5, fat: 23.8, satFat: 21.1, fiber: 2.2,
    flags: [], cat: 'Pantry', iconKey: 'coconut-milk', src: 'USDA FDC 170173 (coconut milk, canned)'
  },
  'olive-oil-lemon-dressing': {
    name: 'Olive oil & lemon dressing (blend)', per: 100, unit: 'ml',
    kcal: 726, protein: 0.1, carbs: 1.4, fat: 80.0, satFat: 11.0, fiber: 0.1,
    flags: [], cat: 'Pantry', src: 'Composite: 80% olive oil + 20% lemon juice by weight'
  },
  'pumpkin-chia-seeds': {
    name: 'Pumpkin & chia seeds (blend)', per: 100, unit: 'g',
    kcal: 558, protein: 23.4, carbs: 26.4, fat: 39.9, satFat: 6.0, fiber: 20.2,
    flags: ['omega3', 'highFiber'], cat: 'Pantry', src: 'Composite: 50/50 pumpkin seeds + chia seeds by weight'
  },
  'herbs-black-pepper': {
    name: 'Herbs & black pepper (mixed, to taste)', per: 100, unit: 'g',
    kcal: 332, protein: 10.0, carbs: 65.0, fat: 3.5, satFat: 1.5, fiber: 30.0,
    flags: [], cat: 'Pantry',
    src: 'Composite: generic dried mixed herbs + ground black pepper, USDA spice-table averages (used in "to taste" amounts, negligible actual contribution)'
  },
  'vanilla-cinnamon': {
    name: 'Vanilla or cinnamon (to taste)', per: 100, unit: 'g',
    kcal: 202, protein: 2.0, carbs: 47.0, fat: 0.7, satFat: 0.2, fiber: 27.0,
    flags: [], cat: 'Pantry',
    src: 'Composite: 50/50 vanilla extract + ground cinnamon, USDA spice-table averages (used in "to taste" amounts, negligible actual contribution)'
  }

};

const SUGAR_QUALITY_VALUES = {intrinsic: true, 'added/free': true, mixed: true, unknown: true};

function normalizeFoodSugarFields(food){
  if(!food || typeof food !== 'object') return food;
  if(typeof food.sugars !== 'number' || !isFinite(food.sugars)) food.sugars = 0;
  if(typeof food.freeSugars !== 'number' || !isFinite(food.freeSugars)) food.freeSugars = 0;
  if(food.sugars < 0) food.sugars = 0;
  if(food.freeSugars < 0) food.freeSugars = 0;
  if(typeof food.carbs === 'number' && isFinite(food.carbs) && food.sugars > food.carbs) food.sugars = food.carbs;
  if(food.freeSugars > food.sugars) food.freeSugars = food.sugars;
  if(typeof food.sugarQuality !== 'string' || !SUGAR_QUALITY_VALUES[food.sugarQuality]) food.sugarQuality = 'unknown';
  return food;
}

Object.keys(FOODS).forEach(function(id){ normalizeFoodSugarFields(FOODS[id]); });

/* ===================================================================
   FOOD_ALIASES — every ingredient-name string used in RECIPES
   (app/js/state.js) mapped to its food id above. Recipe ingredient
   names are free-text mockup copy and don't always match a food's
   display `name` exactly, so this table is the resolution layer
   recipes.js (task B2) and validateFoods() (below) both rely on.
   =================================================================== */
const FOOD_ALIASES = {
  'Greek yogurt, plain': 'greek-yogurt',
  'Mixed berries': 'mixed-berries',
  'Granola': 'granola',
  'Honey': 'honey',
  'Chia seeds': 'chia-seeds',
  'Eggs': 'eggs',
  'Mixed peppers & spinach': 'mixed-peppers-spinach',
  'Rye bread': 'rye-bread',
  'Olive oil': 'olive-oil',
  'Herbs & black pepper': 'herbs-black-pepper',
  'Cooked lentils': 'cooked-lentils',
  'Roasted mixed veg': 'roasted-mixed-veg',
  'Feta cheese': 'feta-cheese',
  'Rocket / arugula': 'rocket-arugula',
  'Olive oil & lemon dressing': 'olive-oil-lemon-dressing',
  'Salmon fillet': 'salmon-fillet',
  'Quinoa, dry': 'quinoa-dry',
  'Baby spinach': 'spinach',
  'Broccoli': 'broccoli',
  // "to taste" garnish of oil + lemon + garlic — dominated by the oil in any
  // realistic quantity, so it resolves to plain olive oil rather than a new
  // three-way composite (the quantity is null/"to taste" in every recipe
  // that uses it, so this never actually drives a computed number).
  'Olive oil, lemon, garlic': 'olive-oil',
  'Skyr, plain': 'skyr',
  'Pumpkin & chia seeds': 'pumpkin-chia-seeds',
  'Sliced turkey breast': 'turkey-breast',
  'Grilled chicken breast': 'chicken-breast',
  'Cooked farro': 'farro-cooked',
  'Coconut milk': 'coconut-milk',
  'Vanilla or cinnamon': 'vanilla-cinnamon',
  'Tuna in olive oil, drained': 'tuna-in-olive-oil',
  'Avocado': 'avocado',
  'Cherry tomatoes & cucumber': 'cherry-tomatoes-cucumber',
  'Broccoli & courgette': 'broccoli-courgette'
};

/* ===================================================================
   validateFoods() — self-check, runnable in the browser console.
   Returns {ok, errors[]}. Checks:
     - every field present & correctly typed on every food
     - satFat <= fat, fiber <= carbs (small epsilon for rounding)
     - kcal within ±15% of round(4*protein + 4*carbs + 9*fat)
     - cat is one of the allowed shopping categories
     - every flag is one of the allowed flags
     - no two foods share the same display `name`
     - every RECIPES ingredient-name string (hardcoded list below,
       read from app/js/state.js RECIPES at authoring time) resolves
       to a real food, either directly by name or via FOOD_ALIASES
   =================================================================== */
const ALLOWED_CATS = ['Produce', 'Protein', 'Dairy', 'Pantry', 'Bakery', 'Frozen'];
const ALLOWED_FLAGS = ['lowGI', 'omega3', 'selenium', 'highIodine', 'glutenFree', 'highFiber', 'fermented'];

// Every distinct ingredient-name string that appears in RECIPES (state.js),
// as of task B1. Hardcoded per the task brief rather than parsed at runtime
// so this file has no dependency on state.js loading first.
const RECIPE_INGREDIENT_NAMES = [
  'Greek yogurt, plain', 'Mixed berries', 'Granola', 'Honey', 'Chia seeds',
  'Eggs', 'Mixed peppers & spinach', 'Rye bread', 'Olive oil', 'Herbs & black pepper',
  'Cooked lentils', 'Roasted mixed veg', 'Feta cheese', 'Rocket / arugula', 'Olive oil & lemon dressing',
  'Salmon fillet', 'Quinoa, dry', 'Baby spinach', 'Broccoli', 'Olive oil, lemon, garlic',
  'Skyr, plain', 'Pumpkin & chia seeds', 'Sliced turkey breast', 'Grilled chicken breast', 'Cooked farro',
  'Coconut milk', 'Vanilla or cinnamon', 'Tuna in olive oil, drained', 'Avocado', 'Cherry tomatoes & cucumber',
  'Broccoli & courgette'
];

function validateFoods(){
  const errors = [];
  const EPS = 0.05; // rounding tolerance for satFat<=fat / fiber<=carbs
  const seenNames = {};

  Object.keys(FOODS).forEach(function(id){
    const f = FOODS[id];
    const where = 'FOODS["' + id + '"]';

    if (!f || typeof f !== 'object') { errors.push(where + ': missing or not an object'); return; }

    // required fields present & correctly typed
    if (typeof f.name !== 'string' || !f.name) errors.push(where + ': name missing/invalid');
    if (typeof f.per !== 'number') errors.push(where + ': per missing/not a number');
    if (typeof f.unit !== 'string' || !f.unit) errors.push(where + ': unit missing/invalid');
    ['kcal', 'protein', 'carbs', 'fat', 'satFat', 'fiber', 'sugars', 'freeSugars'].forEach(function(field){
      if (typeof f[field] !== 'number' || Number.isNaN(f[field])) errors.push(where + ': ' + field + ' missing/not a number');
    });
    if (typeof f.sugarQuality !== 'string' || !SUGAR_QUALITY_VALUES[f.sugarQuality]) {
      errors.push(where + ': sugarQuality missing/invalid');
    }
    if (!Array.isArray(f.flags)) errors.push(where + ': flags missing/not an array');
    if (typeof f.cat !== 'string' || !f.cat) errors.push(where + ': cat missing/invalid');
    if (typeof f.src !== 'string' || !f.src) errors.push(where + ': src missing/invalid');
    if (f.unit === 'piece' && typeof f.avgG !== 'number') errors.push(where + ': unit is "piece" but avgG missing/not a number');
    if (f.iconKey !== undefined && (typeof f.iconKey !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(f.iconKey))) {
      errors.push(where + ': iconKey invalid');
    }
    if (f.iconAsset !== undefined && (typeof f.iconAsset !== 'string' || !/^assets\/ingredients\/[a-z0-9][a-z0-9-]*\.png$/.test(f.iconAsset))) {
      errors.push(where + ': iconAsset invalid');
    }

    if (typeof f.satFat === 'number' && typeof f.fat === 'number' && f.satFat > f.fat + EPS) {
      errors.push(where + ': satFat (' + f.satFat + ') > fat (' + f.fat + ')');
    }
    if (typeof f.fiber === 'number' && typeof f.carbs === 'number' && f.fiber > f.carbs + EPS) {
      errors.push(where + ': fiber (' + f.fiber + ') > carbs (' + f.carbs + ')');
    }
    if (typeof f.sugars === 'number' && typeof f.carbs === 'number' && f.sugars > f.carbs + EPS) {
      errors.push(where + ': sugars (' + f.sugars + ') > carbs (' + f.carbs + ')');
    }
    if (typeof f.freeSugars === 'number' && typeof f.sugars === 'number' && f.freeSugars > f.sugars + EPS) {
      errors.push(where + ': freeSugars (' + f.freeSugars + ') > sugars (' + f.sugars + ')');
    }

    if (typeof f.protein === 'number' && typeof f.carbs === 'number' && typeof f.fat === 'number' && typeof f.kcal === 'number') {
      const expected = 4 * f.protein + 4 * f.carbs + 9 * f.fat;
      const denom = Math.max(expected, 1);
      const diffRatio = Math.abs(f.kcal - expected) / denom;
      if (diffRatio > 0.15) {
        errors.push(where + ': kcal (' + f.kcal + ') is more than 15% off 4/4/9 macro math (expected ~' + Math.round(expected) + ')');
      }
    }

    if (typeof f.cat === 'string' && ALLOWED_CATS.indexOf(f.cat) === -1) {
      errors.push(where + ': cat "' + f.cat + '" not in allowed set (' + ALLOWED_CATS.join(', ') + ')');
    }

    if (Array.isArray(f.flags)) {
      f.flags.forEach(function(flag){
        if (ALLOWED_FLAGS.indexOf(flag) === -1) errors.push(where + ': flag "' + flag + '" not in allowed set (' + ALLOWED_FLAGS.join(', ') + ')');
      });
    }

    if (typeof f.name === 'string' && f.name) {
      if (seenNames[f.name]) errors.push('Duplicate food name "' + f.name + '": ' + seenNames[f.name] + ' and ' + where);
      else seenNames[f.name] = where;
    }
  });

  // every RECIPES ingredient name must resolve to a real food, by alias or direct name match
  RECIPE_INGREDIENT_NAMES.forEach(function(ingName){
    const aliasId = FOOD_ALIASES[ingName];
    if (aliasId) {
      if (!FOODS[aliasId]) errors.push('FOOD_ALIASES["' + ingName + '"] points to missing food id "' + aliasId + '"');
      return;
    }
    const directMatch = Object.keys(FOODS).some(function(id){ return FOODS[id].name === ingName; });
    if (!directMatch) errors.push('Recipe ingredient "' + ingName + '" has no FOOD_ALIASES entry and no food with a matching name');
  });

  return { ok: errors.length === 0, errors: errors };
}
