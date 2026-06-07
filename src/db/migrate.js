import { openDb } from "./db.js";

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
  at TEXT NOT NULL DEFAULT (datetime('now')),
  payload_json TEXT NOT NULL
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

console.log("Migration complete.");
db.close();
