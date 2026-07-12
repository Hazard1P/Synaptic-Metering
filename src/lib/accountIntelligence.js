import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { nanoid } from "nanoid";

const DEFAULT_ANCHOR_ASSET_ID = "dyson-sphere-ring-1";
const DEFAULT_PERSISTENCE_SECONDS = 30 * 24 * 60 * 60;

function sha256Hex(value){
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function datablockEncryptionKey(){
  const raw = process.env.ACCOUNT_INTELLIGENCE_ENCRYPTION_KEY || process.env.TOKEN_ENCRYPTION_KEY || "dev-account-intelligence-key";
  if(/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  const decoded = Buffer.from(raw, "base64");
  if(decoded.length === 32) return decoded;
  const utf8 = Buffer.from(raw, "utf8");
  if(utf8.length === 32) return utf8;
  return createHash("sha256").update(raw, "utf8").digest();
}

function encryptDatablock(datablock){
  const plaintext = JSON.stringify(datablock || {});
  const key = datablockEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:aes-256-gcm:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

function decryptDatablock(ciphertextValue){
  const parts = String(ciphertextValue || "").split(":");
  if(parts.length !== 5 || parts[0] !== "v1" || parts[1] !== "aes-256-gcm") return null;
  const [, , iv, tag, ciphertext] = parts;
  const decipher = createDecipheriv("aes-256-gcm", datablockEncryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  return JSON.parse(plaintext);
}

function safeJson(value, fallback = {}){
  try{ return JSON.parse(value || ""); }catch{ return fallback; }
}

function accountRootDigest({ accountId, anchorAssetId = DEFAULT_ANCHOR_ASSET_ID }){
  return sha256Hex(["account_intelligence_root", accountId, anchorAssetId].join(":"));
}

export function upsertAccountIntelligenceRoot(db, { accountId, anchorAssetId = DEFAULT_ANCHOR_ASSET_ID, stringSource = "google_account", persistenceSeconds = DEFAULT_PERSISTENCE_SECONDS, datablock = {} }){
  const digest = accountRootDigest({ accountId, anchorAssetId });
  const existing = db.prepare(`
    SELECT * FROM account_intelligence_strings
    WHERE account_id=? AND session_id IS NULL AND invoice_id IS NULL AND string_source=?
  `).get(accountId, stringSource);
  const encrypted = encryptDatablock({ ...datablock, account_id: accountId, anchor_asset_id: anchorAssetId, root: true });
  if(existing){
    db.prepare(`
      UPDATE account_intelligence_strings
      SET anchor_asset_id=?, string_digest=?, datablock_ciphertext=?, persistence_seconds=?, updated_at=datetime('now')
      WHERE id=?
    `).run(anchorAssetId, digest, encrypted, persistenceSeconds, existing.id);
    return db.prepare("SELECT * FROM account_intelligence_strings WHERE id=?").get(existing.id);
  }
  const id = "ais_" + nanoid(18);
  db.prepare(`
    INSERT INTO account_intelligence_strings (
      id, account_id, anchor_asset_id, string_digest, string_source, datablock_ciphertext, persistence_seconds
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, accountId, anchorAssetId, digest, stringSource, encrypted, persistenceSeconds);
  return db.prepare("SELECT * FROM account_intelligence_strings WHERE id=?").get(id);
}

export function upsertSessionIntelligenceString(db, { accountId, sessionId, anchorAssetId = DEFAULT_ANCHOR_ASSET_ID, persistenceSeconds = DEFAULT_PERSISTENCE_SECONDS }){
  if(!accountId) return null;
  upsertAccountIntelligenceRoot(db, { accountId, anchorAssetId });
  const digest = sha256Hex(["account_intelligence_session", accountId, sessionId, anchorAssetId].join(":"));
  const encrypted = encryptDatablock({ account_id: accountId, session_id: sessionId, anchor_asset_id: anchorAssetId, telemetry_derived: true });
  const existing = db.prepare("SELECT id FROM account_intelligence_strings WHERE account_id=? AND session_id=? AND invoice_id IS NULL AND string_source='session_creation'")
    .get(accountId, sessionId);
  if(existing){
    db.prepare(`
      UPDATE account_intelligence_strings
      SET anchor_asset_id=?, string_digest=?, datablock_ciphertext=?, persistence_seconds=?, updated_at=datetime('now')
      WHERE id=?
    `).run(anchorAssetId, digest, encrypted, persistenceSeconds, existing.id);
  }else{
    db.prepare(`
      INSERT INTO account_intelligence_strings (id, account_id, session_id, anchor_asset_id, string_digest, string_source, datablock_ciphertext, persistence_seconds)
      VALUES (?, ?, ?, ?, ?, 'session_creation', ?, ?)
    `).run("ais_" + nanoid(18), accountId, sessionId, anchorAssetId, digest, encrypted, persistenceSeconds);
  }
  const row = db.prepare("SELECT * FROM account_intelligence_strings WHERE account_id=? AND session_id=? AND string_source='session_creation'").get(accountId, sessionId);
  db.prepare("UPDATE sessions SET intelligence_string_id=? WHERE id=?").run(row.id, sessionId);
  return row;
}

export function linkInvoiceIntelligenceString(db, { accountId, sessionId, invoiceId, anchorAssetId = DEFAULT_ANCHOR_ASSET_ID, persistenceSeconds = DEFAULT_PERSISTENCE_SECONDS, metrics = {} }){
  const digest = sha256Hex(["account_intelligence_invoice", accountId, sessionId, invoiceId, anchorAssetId].join(":"));
  const encrypted = encryptDatablock({ account_id: accountId, session_id: sessionId, invoice_id: invoiceId, anchor_asset_id: anchorAssetId, metrics, telemetry_derived: true });
  db.prepare(`
    INSERT INTO account_intelligence_strings (id, account_id, session_id, invoice_id, anchor_asset_id, string_digest, string_source, datablock_ciphertext, persistence_seconds)
    VALUES (?, ?, ?, ?, ?, ?, 'invoice_generation', ?, ?)
  `).run("ais_" + nanoid(18), accountId, sessionId, invoiceId, anchorAssetId, digest, encrypted, persistenceSeconds);
  const row = db.prepare("SELECT * FROM account_intelligence_strings WHERE invoice_id=?").get(invoiceId);
  db.prepare("UPDATE invoices SET intelligence_string_id=? WHERE id=?").run(row.id, invoiceId);
  return row;
}

export function accountIntelligencePayload(row){
  if(!row) return null;
  return {
    id: row.id,
    digest: row.string_digest,
    session_id: row.session_id,
    persistence_seconds: Number(row.persistence_seconds || 0),
    map_anchor: { anchor_asset_id: row.anchor_asset_id },
    datablock_reference: { table: "account_intelligence_strings", id: row.id, encrypted: Boolean(row.datablock_ciphertext) }
  };
}

export function publicIntelligenceString(row){
  return {
    id: row.id,
    account_id: row.account_id,
    session_id: row.session_id,
    invoice_id: row.invoice_id,
    anchor_asset_id: row.anchor_asset_id,
    string_digest: row.string_digest,
    string_source: row.string_source,
    persistence_seconds: Number(row.persistence_seconds || 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
    datablock_reference: { encrypted: Boolean(row.datablock_ciphertext), id: row.id }
  };
}

export function decryptAccountIntelligenceDatablock(row){
  if(!row) return null;
  if(row.datablock_ciphertext) return decryptDatablock(row.datablock_ciphertext);
  return safeJson(row.datablock_json, null);
}
