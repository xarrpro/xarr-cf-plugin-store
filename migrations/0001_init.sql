CREATE TABLE plugins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  type INTEGER NOT NULL DEFAULT 1,
  author TEXT,
  description TEXT,
  homepage TEXT,
  preview_img_url TEXT,
  repository_url TEXT,
  latest_version TEXT,
  manifest_version INTEGER NOT NULL DEFAULT 1,
  owner TEXT,
  status INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id INTEGER NOT NULL REFERENCES plugins(id),
  version TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'stable',
  min_program_version TEXT,
  changelog TEXT,
  r2_key TEXT NOT NULL,
  package_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  md5 TEXT,
  signature TEXT,
  status INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE(plugin_id, version, channel)
);
CREATE INDEX idx_releases_plugin ON releases(plugin_id);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  target TEXT,
  token_id TEXT,
  ip TEXT,
  ua TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE download_stats (
  plugin_id INTEGER NOT NULL REFERENCES plugins(id),
  version TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (plugin_id, version)
);
