CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,              -- crypto.randomUUID()
  email TEXT NOT NULL UNIQUE,       -- lowercased
  google_sub TEXT UNIQUE,
  display_name TEXT,
  picture_url TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,      -- hex SHA-256 of the bearer token
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,      -- epoch ms
  last_seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS allowed_emails (
  email TEXT PRIMARY KEY,           -- lowercased
  note TEXT,
  added_at INTEGER NOT NULL
);
