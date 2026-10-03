-- Initial Cloudflare D1 schema for the single-user flight tracker.
CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY NOT NULL,
  duplicate_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL CHECK (json_valid(payload))
);

CREATE INDEX IF NOT EXISTS trips_created_at_idx ON trips (created_at, id);

-- Small singleton documents such as app configuration.
CREATE TABLE IF NOT EXISTS app_json (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value))
);

-- Per-entry rows prevent concurrent airport or aircraft-cache updates from
-- replacing one another with stale read-modify-write snapshots.
CREATE TABLE IF NOT EXISTS app_json_entries (
  name TEXT NOT NULL CHECK (name IN ('places.json', 'aircraft-cache.json')),
  item_key TEXT NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value)),
  PRIMARY KEY (name, item_key)
);

-- One restorable daily snapshot; old rows are pruned to the newest seven.
CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_date TEXT PRIMARY KEY NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload))
);
