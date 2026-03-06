CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_full_name TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('view', 'install')),
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_dedup
  ON events (ip_hash, plugin_full_name, event_type, created_at);

CREATE TABLE IF NOT EXISTS stats (
  plugin_full_name TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('view', 'install')),
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (plugin_full_name, event_type)
);

CREATE TABLE IF NOT EXISTS rate_limits (
  ip_hash TEXT NOT NULL,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, window_start)
);

CREATE TABLE IF NOT EXISTS plugin_names (
  plugin_full_name TEXT NOT NULL,
  PRIMARY KEY (plugin_full_name)
);
