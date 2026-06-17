import { nanoid } from "nanoid";

const VALID_KEY_KINDS = new Set(["invoice_key", "master_key"]);
const VALID_STATUSES = new Set(["pending", "confirmed", "revoked"]);

function normalizeStatus(status = "confirmed"){
  const normalized = String(status || "confirmed").trim().toLowerCase();
  if(!VALID_STATUSES.has(normalized)){
    const err = new Error("invalid_key_status");
    err.status = 400;
    throw err;
  }
  return normalized;
}

function normalizeKeyKind(keyKind){
  const normalized = String(keyKind || "").trim().toLowerCase();
  if(!VALID_KEY_KINDS.has(normalized)){
    const err = new Error("invalid_key_kind");
    err.status = 400;
    throw err;
  }
  return normalized;
}

function normalizeKeyLabel(keyLabel){
  const label = String(keyLabel || "").trim();
  if(!label){
    const err = new Error("missing_key_label");
    err.status = 400;
    throw err;
  }
  return label;
}

export function createIntelligenceNetworkKey(db, {
  keyKind,
  keyLabel,
  accountId = null,
  invoiceId = null,
  anchorAssetId = "dyson-sphere-ring-1",
  status = "confirmed"
}){
  const row = {
    id: `ink_${nanoid(18)}`,
    key_kind: normalizeKeyKind(keyKind),
    key_label: normalizeKeyLabel(keyLabel),
    account_id: accountId,
    invoice_id: invoiceId,
    anchor_asset_id: anchorAssetId || "dyson-sphere-ring-1",
    status: normalizeStatus(status)
  };

  db.prepare(`
    INSERT INTO intelligence_network_keys (
      id, account_id, invoice_id, key_kind, key_label, anchor_asset_id, status, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    row.id,
    row.account_id,
    row.invoice_id,
    row.key_kind,
    row.key_label,
    row.anchor_asset_id,
    row.status
  );

  return lookupIntelligenceNetworkKey(db, { keyKind: row.key_kind, keyLabel: row.key_label });
}

export function upsertIntelligenceNetworkKey(db, {
  keyKind,
  keyLabel,
  accountId = null,
  invoiceId = null,
  anchorAssetId = "dyson-sphere-ring-1",
  status = "confirmed"
}){
  const key_kind = normalizeKeyKind(keyKind);
  const key_label = normalizeKeyLabel(keyLabel);
  const normalizedStatus = normalizeStatus(status);
  const id = `ink_${nanoid(18)}`;

  db.prepare(`
    INSERT INTO intelligence_network_keys (
      id, account_id, invoice_id, key_kind, key_label, anchor_asset_id, status, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(key_kind, key_label) DO UPDATE SET
      account_id=excluded.account_id,
      invoice_id=excluded.invoice_id,
      anchor_asset_id=excluded.anchor_asset_id,
      status=excluded.status
  `).run(
    id,
    accountId,
    invoiceId,
    key_kind,
    key_label,
    anchorAssetId || "dyson-sphere-ring-1",
    normalizedStatus
  );

  return lookupIntelligenceNetworkKey(db, { keyKind: key_kind, keyLabel: key_label });
}

export function lookupIntelligenceNetworkKey(db, { keyKind, keyLabel }){
  return db.prepare(`
    SELECT id, account_id, invoice_id, key_kind, key_label, anchor_asset_id, status, created_at
    FROM intelligence_network_keys
    WHERE key_kind=? AND key_label=?
  `).get(normalizeKeyKind(keyKind), normalizeKeyLabel(keyLabel)) || null;
}

export function confirmIntelligenceNetworkKey(db, { keyKind, keyLabel }){
  return setIntelligenceNetworkKeyStatus(db, { keyKind, keyLabel, status: "confirmed" });
}

export function revokeIntelligenceNetworkKey(db, { keyKind, keyLabel }){
  return setIntelligenceNetworkKeyStatus(db, { keyKind, keyLabel, status: "revoked" });
}

function setIntelligenceNetworkKeyStatus(db, { keyKind, keyLabel, status }){
  const key_kind = normalizeKeyKind(keyKind);
  const key_label = normalizeKeyLabel(keyLabel);
  const result = db.prepare(`
    UPDATE intelligence_network_keys
    SET status=?
    WHERE key_kind=? AND key_label=?
  `).run(normalizeStatus(status), key_kind, key_label);

  if(result.changes === 0) return null;
  return lookupIntelligenceNetworkKey(db, { keyKind: key_kind, keyLabel: key_label });
}
