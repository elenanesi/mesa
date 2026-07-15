CREATE TABLE IF NOT EXISTS foods (
  scope TEXT NOT NULL,
  id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('builtin', 'custom')),
  name TEXT NOT NULL,
  category TEXT,
  season TEXT NOT NULL DEFAULT 'evergreen',
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  data_json TEXT NOT NULL,
  PRIMARY KEY (scope, id)
);

CREATE INDEX IF NOT EXISTS idx_foods_source ON foods(source);
CREATE INDEX IF NOT EXISTS idx_foods_name ON foods(name);
CREATE INDEX IF NOT EXISTS idx_foods_season ON foods(season);

CREATE TABLE IF NOT EXISTS recipes (
  scope TEXT NOT NULL,
  id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('builtin', 'custom', 'override')),
  title TEXT NOT NULL,
  primary_slot TEXT,
  season TEXT NOT NULL DEFAULT 'evergreen',
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  data_json TEXT NOT NULL,
  PRIMARY KEY (scope, id)
);

CREATE INDEX IF NOT EXISTS idx_recipes_source ON recipes(source);
CREATE INDEX IF NOT EXISTS idx_recipes_title ON recipes(title);
CREATE INDEX IF NOT EXISTS idx_recipes_slot ON recipes(primary_slot);
CREATE INDEX IF NOT EXISTS idx_recipes_season ON recipes(season);

CREATE TABLE IF NOT EXISTS recipe_prefs (
  household_code TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
  pref TEXT NOT NULL CHECK (pref IN ('favorite', 'down')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (household_code, recipe_id)
);

CREATE TABLE IF NOT EXISTS library_tombstones (
  household_code TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('food', 'recipe')),
  item_id TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  PRIMARY KEY (household_code, item_type, item_id)
);
