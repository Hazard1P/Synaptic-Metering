import { DB_AT_REST_SECURITY, openDb } from "./db.js";
import { seedMapAssetDigests } from "../lib/mapAuthentication.js";
import { refreshCatalog } from "../lib/catalog.js";

const SCHEMA_VERSION = 1;

const db = openDb();

function hasColumn(tableName, columnName){
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return cols.some(c => c.name === columnName);
}

db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS catalog_items (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CAD',
  source TEXT NOT NULL DEFAULT 'catalog_json',
  effective_from TEXT,
  effective_to TEXT,
  version TEXT NOT NULL DEFAULT 'legacy',
  active INTEGER NOT NULL DEFAULT 1,
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

CREATE TABLE IF NOT EXISTS account_business_associations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  association_kind TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  UNIQUE(account_id, provider_name, association_kind)
);

CREATE INDEX IF NOT EXISTS idx_account_business_associations_account_id
  ON account_business_associations(account_id);


CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key_digest TEXT NOT NULL CHECK(length(key_digest) = 64),
  label TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_key_digest
  ON api_keys(key_digest);

CREATE INDEX IF NOT EXISTS idx_api_keys_active
  ON api_keys(revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS api_key_audit_logs (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  route TEXT NOT NULL,
  method TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  account_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_api_key_audit_logs_api_key_id_created_at
  ON api_key_audit_logs(api_key_id, created_at);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_account_id
  ON auth_sessions(account_id);

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  UNIQUE(credential_id)
);

CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_account_id
  ON webauthn_credentials(account_id);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('registration', 'authentication')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_lookup
  ON webauthn_challenges(challenge, purpose, expires_at);

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_account_id
  ON webauthn_challenges(account_id);


CREATE TABLE IF NOT EXISTS consents (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  consent_type TEXT NOT NULL,
  version TEXT NOT NULL,
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  source TEXT NOT NULL DEFAULT 'account',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_consents_account_type_active
  ON consents(account_id, consent_type, revoked_at);

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  credential_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  public_key_cose TEXT NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  transports_json TEXT NOT NULL DEFAULT '[]',
  attestation_format TEXT,
  aaguid TEXT,
  user_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  CHECK(public_key_cose <> ''),
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_account_id
  ON webauthn_credentials(account_id, revoked_at);


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
  anchor_asset_id TEXT NOT NULL,
  digest TEXT NOT NULL CHECK(length(digest) = 64),
  verification_status TEXT NOT NULL DEFAULT 'verified' CHECK(verification_status IN ('verified', 'pending', 'digest_mismatch', 'revoked')),
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(anchor_asset_id) REFERENCES anchored_assets(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_map_assets_anchor_asset_id
  ON map_assets(anchor_asset_id);

CREATE TABLE IF NOT EXISTS intelligence_network_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  invoice_id TEXT,
  key_kind TEXT NOT NULL CHECK(key_kind IN ('invoice_key', 'master_key')),
  key_label TEXT NOT NULL,
  anchor_asset_id TEXT NOT NULL DEFAULT 'dyson-sphere-ring-1',
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
  event_kind TEXT NOT NULL DEFAULT 'live_tick' CHECK(event_kind IN ('live_tick', 'recovery_adjustment')),
  heartbeat_idempotency_key TEXT,
  heartbeat_event_timestamp TEXT,
  heartbeat_tick_sequence INTEGER,
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
  catalog_version TEXT,
  catalog_snapshot_json TEXT,
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
  catalog_version TEXT,
  catalog_snapshot_json TEXT,
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


const usageEventColumns = [
  ["event_kind", "TEXT NOT NULL DEFAULT 'live_tick' CHECK(event_kind IN ('live_tick', 'recovery_adjustment'))"],
  ["heartbeat_idempotency_key", "TEXT"],
  ["heartbeat_event_timestamp", "TEXT"],
  ["heartbeat_tick_sequence", "INTEGER"]
];
for (const [name, ddl] of usageEventColumns){
  if(!hasColumn('usage_events', name)){
    db.exec(`ALTER TABLE usage_events ADD COLUMN ${name} ${ddl}`);
  }
}


db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_events_session_idempotency_key
  ON usage_events(session_id, event_kind, heartbeat_idempotency_key)
  WHERE heartbeat_idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_events_session_event_timestamp
  ON usage_events(session_id, event_kind, heartbeat_event_timestamp)
  WHERE heartbeat_event_timestamp IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_events_session_tick_sequence
  ON usage_events(session_id, event_kind, heartbeat_tick_sequence)
  WHERE heartbeat_tick_sequence IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_usage_events_session_identity
  ON usage_events(session_id, heartbeat_idempotency_key, heartbeat_event_timestamp, heartbeat_tick_sequence);
`);

const accountColumns = [
  ["role", "TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin'))"]
];
for (const [name, ddl] of accountColumns){
  if(!hasColumn('accounts', name)){
    db.exec(`ALTER TABLE accounts ADD COLUMN ${name} ${ddl}`);
  }
}


const seedApiKeyDigests = (process.env.API_KEY_DIGESTS || "")
  .split(",")
  .map(digest => digest.trim().toLowerCase())
  .filter(digest => /^[a-f0-9]{64}$/.test(digest));
const seedApiKeyScopes = (process.env.API_KEY_SCOPES || "admin:read,admin:write,reports:read,project:read,catalog:read,catalog:write,intelligence:read,intelligence:write,sessions:write,telemetry:write")
  .split(",")
  .map(scope => scope.trim())
  .filter(Boolean);
seedApiKeyDigests.forEach((digest, index) => {
  db.prepare(`
    INSERT INTO api_keys (id, key_digest, label, scopes, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(key_digest) DO UPDATE SET
      scopes=excluded.scopes,
      label=excluded.label
  `).run(
    `api_key_env_${index + 1}`,
    digest,
    `Environment API key ${index + 1}`,
    JSON.stringify(seedApiKeyScopes)
  );
});

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
    ('dyson-sphere-ring-1', 'Dyson-Sphere Ring-1 map database', 'physical_map_database', 'permanent_anchor', 'operator_map_database', 'map_database_reference_anchor', 1, 'ring_1_physical_map_reference'),
    ('fabric-universe-ring-map', 'Fabric Universe Map Anchor', 'fabric_universe_map', 'permanent_anchor', 'deterministic_metering_anchor', 'map_database_reference_anchor', 1, 'fabric_universe_reference'),
    ('major-ursa', 'Major Ursa anchored star/database', 'constellation_database', 'permanent_anchor', 'governance_intelligence_database', 'considered_in_data_and_physics_not_pulled_through', 1, 'tip_to_dipper_24_hour_unix_daily_alignment'),
    ('cassiopeia', 'Cassiopeia quantum biometrics anchor', 'constellation_biometrics', 'permanent_anchor', 'quantum_biometric_moderation', 'considered_in_data_and_physics_not_pulled_through', 1, 'relative_anchored_star_24_hour_unix_daily_alignment'),
    ('isolated-blackholes', 'Isolated blackholes universe-mesh anchors', 'blackhole_mesh_anchor', 'permanent_anchor', 'universe_mesh_intelligence_reference', 'considered_in_data_and_physics_not_pulled_through', 1, 'non_extractive_gravity_reference'),
    ('fabric-universe-ring-map', 'Fabric Universe Ring deterministic map anchor', 'deterministic_map_anchor', 'permanent_anchor', 'operator_map_database', 'deterministic_ring_map_reference_anchor', 1, 'fabric_universe_ring_map_reference')
`).run();

// Keep the physical map database anchor canonical even when migrating a
// database that was previously seeded with the legacy Dyson Sphere business
// association row for this same id. seedMapAssetDigests(db) below consumes
// anchored_assets directly, so normalize this metadata before digest seeding.
db.prepare(`
  UPDATE anchored_assets
  SET label = ?,
      asset_type = ?,
      permanence = ?,
      role = ?,
      physics_role = ?,
      tick_rate_hz = ?,
      vector = ?
  WHERE id = ?
`).run(
  'Dyson-Sphere Ring-1 map database',
  'physical_map_database',
  'permanent_anchor',
  'operator_map_database',
  'map_database_reference_anchor',
  1,
  'ring_1_physical_map_reference',
  'dyson-sphere-ring-1'
);

// Daily Unix relevancy is exposed through the existing anchor vector metadata;
// keep this backward-compatible by normalizing the seeded rows instead of
// introducing a new required schema element.
db.prepare(`
  UPDATE anchored_assets
  SET vector = ?
  WHERE id = ?
`).run('tip_to_dipper_24_hour_unix_daily_alignment', 'major-ursa');

db.prepare(`
  UPDATE anchored_assets
  SET vector = ?
  WHERE id = ?
`).run('relative_anchored_star_24_hour_unix_daily_alignment', 'cassiopeia');

seedMapAssetDigests(db);
const invoiceColumns = [
  ["catalog_version", "TEXT"],
  ["catalog_snapshot_json", "TEXT"]
];
for (const [name, ddl] of invoiceColumns){
  if(!hasColumn('invoices', name)){
    db.exec(`ALTER TABLE invoices ADD COLUMN ${name} ${ddl}`);
  }
}

const catalogColumns = [
  ["default_qty", "INTEGER NOT NULL DEFAULT 0"],
  ["unit_name", "TEXT NOT NULL DEFAULT 'second'"],
  ["quantity_mode", "TEXT NOT NULL DEFAULT 'seconds'"],
  ["auto_increment_by", "INTEGER NOT NULL DEFAULT 1"],
  ["effective_from", "TEXT"],
  ["effective_to", "TEXT"],
  ["version", "TEXT NOT NULL DEFAULT 'legacy'"],
  ["active", "INTEGER NOT NULL DEFAULT 1"]
];
for (const [name, ddl] of catalogColumns){
  if(!hasColumn('catalog_items', name)){
    db.exec(`ALTER TABLE catalog_items ADD COLUMN ${name} ${ddl}`);
  }
}

refreshCatalog(db);

console.log("Migration complete. SQLite at-rest decision:", DB_AT_REST_SECURITY.approach);
db.close();
