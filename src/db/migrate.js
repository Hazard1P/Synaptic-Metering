import { DB_AT_REST_SECURITY, openDb } from "./db.js";

if(DB_AT_REST_SECURITY.requiredForCurrentSchema){
  throw new Error("SQLite-at-rest encryption is required before migrations can run.");
}

const db = openDb();

function hasColumn(tableName, columnName){
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return cols.some(c => c.name === columnName);
}

db.exec(`
CREATE TABLE IF NOT EXISTS catalog_items (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CAD',
  source TEXT NOT NULL DEFAULT 'invoice',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS account_identities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  email TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  UNIQUE(provider_name, provider_subject)
);

CREATE INDEX IF NOT EXISTS idx_account_identities_account_id
  ON account_identities(account_id);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  access_token_ciphertext TEXT,
  refresh_token_ciphertext TEXT,
  scope TEXT,
  token_type TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  UNIQUE(account_id, provider_name)
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_account_id
  ON auth_sessions(account_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  seat_id TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open|closed
  current_item_id TEXT,
  current_item_started_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  seconds INTEGER NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ndsp_telemetry (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  session_id TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  payload_json TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE SET NULL
);
`);

const catalogColumns = [
  ["default_qty", "INTEGER NOT NULL DEFAULT 0"],
  ["unit_name", "TEXT NOT NULL DEFAULT 'second'"],
  ["quantity_mode", "TEXT NOT NULL DEFAULT 'seconds'"],
  ["auto_increment_by", "INTEGER NOT NULL DEFAULT 1"]
];
for (const [name, ddl] of catalogColumns){
  if(!hasColumn('catalog_items', name)){
    db.exec(`ALTER TABLE catalog_items ADD COLUMN ${name} ${ddl}`);
  }
}

console.log("Migration complete. SQLite at-rest decision:", DB_AT_REST_SECURITY.approach);
db.close();
