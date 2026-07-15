ALTER TABLE foods ADD COLUMN season TEXT NOT NULL DEFAULT 'evergreen';
ALTER TABLE recipes ADD COLUMN season TEXT NOT NULL DEFAULT 'evergreen';

CREATE INDEX IF NOT EXISTS idx_foods_season ON foods(season);
CREATE INDEX IF NOT EXISTS idx_recipes_season ON recipes(season);
