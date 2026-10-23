CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  etag TEXT,
  last_started_at TEXT,
  last_finished_at TEXT,
  last_error TEXT
);

CREATE TABLE vulnerabilities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ext_id TEXT NOT NULL UNIQUE,
  feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  title TEXT,
  description TEXT,
  severity TEXT CHECK (severity IN ('Critical', 'High', 'Medium', 'Low', 'None')),
  cvss_score REAL,
  cvss_vector TEXT,
  status TEXT NOT NULL DEFAULT 'New' CHECK (status IN ('New', 'Analyzing', 'Affected', 'In Progress', 'Patched', 'False Positive')),
  is_known_exploited INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,
  modified_at TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_vulnerabilities_severity ON vulnerabilities(severity);
CREATE INDEX idx_vulnerabilities_status ON vulnerabilities(status);
CREATE INDEX idx_vulnerabilities_feed_id ON vulnerabilities(feed_id);

CREATE TABLE vulnerability_cpes (
  vulnerability_id INTEGER NOT NULL REFERENCES vulnerabilities(id) ON DELETE CASCADE,
  cpe23 TEXT NOT NULL,
  PRIMARY KEY (vulnerability_id, cpe23)
);

CREATE INDEX idx_vulnerability_cpes_cpe23 ON vulnerability_cpes(cpe23);

CREATE TABLE stack (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('application', 'system', 'package')),
  name TEXT NOT NULL,
  vendor TEXT,
  product TEXT NOT NULL,
  version TEXT,
  cpe23 TEXT,
  purl TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_stack_vendor_product_version ON stack(vendor, product, version);
CREATE INDEX idx_stack_cpe23 ON stack(cpe23);
CREATE INDEX idx_stack_purl ON stack(purl);

CREATE TABLE matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vulnerability_id INTEGER NOT NULL REFERENCES vulnerabilities(id) ON DELETE CASCADE,
  stack_id INTEGER NOT NULL REFERENCES stack(id) ON DELETE CASCADE,
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (vulnerability_id, stack_id)
);

CREATE INDEX idx_matches_stack_id ON matches(stack_id);

CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vulnerability_id INTEGER NOT NULL REFERENCES vulnerabilities(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sla (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vulnerability_id INTEGER NOT NULL UNIQUE REFERENCES vulnerabilities(id) ON DELETE CASCADE,
  due_at TEXT NOT NULL,
  patched_at TEXT
);
