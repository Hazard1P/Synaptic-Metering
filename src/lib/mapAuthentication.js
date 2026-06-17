import { createHash, timingSafeEqual } from "crypto";

import { ANCHORED_ASSET_MAP, listAnchoredAssets } from "./anchoredIntelligence.js";

const MAP_ASSET_COLUMNS = `
  map_id, anchor_asset_id, digest, verification_status, metadata_json, created_at, updated_at
`;

function normalizeMapId(mapId){
  return String(mapId || "").trim().toLowerCase();
}

function sortObject(value){
  if(Array.isArray(value)) return value.map(sortObject);
  if(value && typeof value === "object"){
    return Object.keys(value).sort().reduce((sorted, key) => {
      sorted[key] = sortObject(value[key]);
      return sorted;
    }, {});
  }
  return value;
}

export function canonicalMapAssetMetadata(asset){
  return sortObject({
    id: asset.id,
    label: asset.label,
    asset_type: asset.asset_type,
    permanence: asset.permanence,
    role: asset.role,
    physics_role: asset.physics_role,
    tick_rate_hz: Number(asset.tick_rate_hz || 0),
    vector: asset.vector
  });
}

export function calculateMapAssetDigest(asset){
  const payload = JSON.stringify(canonicalMapAssetMetadata(asset));
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function safeDigestEqual(left, right){
  if(!/^[a-f0-9]{64}$/i.test(String(left || "")) || !/^[a-f0-9]{64}$/i.test(String(right || ""))){
    return false;
  }
  const leftBuffer = Buffer.from(String(left).toLowerCase(), "hex");
  const rightBuffer = Buffer.from(String(right).toLowerCase(), "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function publicMetadata(metadata){
  return {
    id: metadata.id,
    label: metadata.label,
    asset_type: metadata.asset_type,
    permanence: metadata.permanence,
    tick_rate_hz: metadata.tick_rate_hz
  };
}

export function seedMapAssetDigests(db){
  const assets = listAnchoredAssets(db);
  const upsert = db.prepare(`
    INSERT INTO map_assets (map_id, anchor_asset_id, digest, verification_status, metadata_json, updated_at)
    VALUES (?, ?, ?, 'verified', ?, datetime('now'))
    ON CONFLICT(map_id) DO UPDATE SET
      anchor_asset_id=excluded.anchor_asset_id,
      digest=excluded.digest,
      verification_status=excluded.verification_status,
      metadata_json=excluded.metadata_json,
      updated_at=datetime('now')
  `);

  for(const asset of assets){
    const metadata = canonicalMapAssetMetadata(asset);
    upsert.run(asset.id, asset.id, calculateMapAssetDigest(asset), JSON.stringify(metadata));
  }
}

export function authenticateStoredMapAsset(db, mapId, { includePrivateMetadata = false } = {}){
  const normalizedMapId = normalizeMapId(mapId);
  const stored = db.prepare(`
    SELECT ${MAP_ASSET_COLUMNS}
    FROM map_assets
    WHERE map_id = ?
  `).get(normalizedMapId);

  if(!stored) return null;

  let metadata = {};
  try{
    metadata = JSON.parse(stored.metadata_json || "{}");
  }catch{
    metadata = {};
  }

  const expectedDigest = calculateMapAssetDigest(metadata.id ? metadata : (ANCHORED_ASSET_MAP[stored.anchor_asset_id] || metadata));
  const digestMatches = safeDigestEqual(stored.digest, expectedDigest);
  const verificationStatus = digestMatches ? stored.verification_status : "digest_mismatch";

  return {
    map_id: stored.map_id,
    anchor_asset_id: stored.anchor_asset_id,
    digest: stored.digest,
    verification_status: verificationStatus,
    metadata: includePrivateMetadata ? metadata : publicMetadata(metadata),
    ...(includePrivateMetadata ? {
      created_at: stored.created_at,
      updated_at: stored.updated_at
    } : {})
  };
}
