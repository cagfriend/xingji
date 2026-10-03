-- Opaque server-side sessions and privacy-preserving fixed-window login limits.
CREATE TABLE IF NOT EXISTS auth_sessions (
  session_hash TEXT PRIMARY KEY NOT NULL,
  password_version TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions (expires_at);

CREATE TABLE IF NOT EXISTS login_rate_limits (
  bucket_key TEXT PRIMARY KEY NOT NULL,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts > 0)
);
