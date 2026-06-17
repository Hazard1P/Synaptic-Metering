import { DB_AT_REST_SECURITY, openDb } from "./db.js";
import { CANONICAL_DYSON_MAP, sha256ForRelativePath } from "../lib/mapDatabase.js";

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
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin'))
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


CREATE TABLE IF NOT EXISTS anchored_assets (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  permanence TEXT NOT NULL,
  role TEXT NOT NULL,
  physics_role TEXT NOT NULL,
  tick_rate_hz INTEGER NOT NULL DEFAULT 1,
  vector TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS map_assets (
  map_id TEXT PRIMARY KEY,
  asset_path TEXT NOT NULL,
  metadata_path TEXT NOT NULL,
  sha256_digest TEXT NOT NULL,
  anchor_asset_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(anchor_asset_id) REFERENCES anchored_assets(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_map_assets_anchor_asset_id
  ON map_assets(anchor_asset_id);

CREATE TABLE IF NOT EXISTS map_star_systems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  map_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  sector TEXT,
  ordinal INTEGER NOT NULL DEFAULT 0,
  coordinates_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(map_id) REFERENCES map_assets(map_id) ON DELETE CASCADE,
  UNIQUE(map_id, system_id)
);

CREATE INDEX IF NOT EXISTS idx_map_star_systems_map_id
  ON map_star_systems(map_id, ordinal);

CREATE TABLE IF NOT EXISTS intelligence_network_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  invoice_id TEXT,
  key_kind TEXT NOT NULL CHECK(key_kind IN ('invoice_key', 'master_key')),
  key_label TEXT NOT NULL,
  anchor_asset_id TEXT NOT NULL DEFAULT 'major-ursa',
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('pending', 'confirmed', 'revoked')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE SET NULL,
  FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE SET NULL,
  FOREIGN KEY(anchor_asset_id) REFERENCES anchored_assets(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_intelligence_network_keys_account_id
  ON intelligence_network_keys(account_id);

CREATE INDEX IF NOT EXISTS idx_intelligence_network_keys_invoice_id
  ON intelligence_network_keys(invoice_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_intelligence_network_keys_kind_label
  ON intelligence_network_keys(key_kind, key_label);

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


CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('generated', 'legacy_upload', 'platform_attachment')),
  source_reference TEXT,
  session_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected')),
  verification_method TEXT,
  verified_at TEXT,
  accepted_at TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_invoices_account_id
  ON invoices(account_id);

CREATE INDEX IF NOT EXISTS idx_invoices_session_id
  ON invoices(session_id);

CREATE INDEX IF NOT EXISTS idx_invoices_source_reference
  ON invoices(source, source_reference);

CREATE TABLE IF NOT EXISTS ndsp_telemetry (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  session_id TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  payload_json TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  verification_method TEXT NOT NULL,
  accepted_at TEXT,
  verified_at TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_invoices_account_id
  ON invoices(account_id);

CREATE INDEX IF NOT EXISTS idx_invoices_session_id
  ON invoices(session_id);
`);

const accountColumns = [
  ["role", "TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin'))"]
];
for (const [name, ddl] of accountColumns){
  if(!hasColumn('accounts', name)){
    db.exec(`ALTER TABLE accounts ADD COLUMN ${name} ${ddl}`);
  }
}

if(process.env.ADMIN_ACCOUNT_ID){
  db.prepare(`
    INSERT INTO accounts (id, display_name, role, created_at, updated_at)
    VALUES (?, ?, 'admin', datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET role='admin', updated_at=datetime('now')
  `).run(process.env.ADMIN_ACCOUNT_ID, process.env.ADMIN_DISPLAY_NAME || 'Synaptics Admin');
}

db.prepare(`
  INSERT OR IGNORE INTO anchored_assets (id, label, asset_type, permanence, role, physics_role, tick_rate_hz, vector)
  VALUES
    ('major-ursa', 'Major Ursa anchored star/database', 'constellation_database', 'permanent_anchor', 'governance_intelligence_database', 'considered_in_data_and_physics_not_pulled_through', 1, 'tip_to_dipper_epoch_unix_discrepancy'),
    ('cassiopeia', 'Cassiopeia quantum biometrics anchor', 'constellation_biometrics', 'permanent_anchor', 'quantum_biometric_moderation', 'considered_in_data_and_physics_not_pulled_through', 1, 'relative_anchored_star_biometrics'),
    ('isolated-blackholes', 'Isolated blackholes universe-mesh anchors', 'blackhole_mesh_anchor', 'permanent_anchor', 'universe_mesh_intelligence_reference', 'considered_in_data_and_physics_not_pulled_through', 1, 'non_extractive_gravity_reference'),
    ('dyson-sphere-ring-1', 'Dyson-Sphere Ring 1 map-backed star database', 'map_backed_star_database', 'permanent_anchor', 'dyson_sphere_ring_intelligence_database', 'considered_in_data_and_physics_not_pulled_through', 1, 'map_database_anchor_digest')
`).run();

const dysonMapDigest = sha256ForRelativePath(CANONICAL_DYSON_MAP.asset_path);
db.prepare(`
  INSERT INTO map_assets (map_id, asset_path, metadata_path, sha256_digest, anchor_asset_id)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(map_id) DO UPDATE SET
    asset_path=excluded.asset_path,
    metadata_path=excluded.metadata_path,
    sha256_digest=excluded.sha256_digest,
    anchor_asset_id=excluded.anchor_asset_id
`).run(
  CANONICAL_DYSON_MAP.map_id,
  CANONICAL_DYSON_MAP.asset_path,
  CANONICAL_DYSON_MAP.metadata_path,
  dysonMapDigest,
  CANONICAL_DYSON_MAP.anchor_asset_id
);

const upsertStarSystem = db.prepare(`
  INSERT INTO map_star_systems (map_id, system_id, name, role, sector, ordinal, coordinates_json)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(map_id, system_id) DO UPDATE SET
    name=excluded.name,
    role=excluded.role,
    sector=excluded.sector,
    ordinal=excluded.ordinal,
    coordinates_json=excluded.coordinates_json
`);
for(const system of CANONICAL_DYSON_MAP.star_systems){
  upsertStarSystem.run(
    CANONICAL_DYSON_MAP.map_id,
    system.system_id,
    system.name,
    system.role,
    system.sector,
    system.ordinal,
    system.coordinates_json
  );
}

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
