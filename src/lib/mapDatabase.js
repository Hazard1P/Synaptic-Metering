import crypto from "crypto";
import fs from "fs";
import path from "path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

export const CANONICAL_DYSON_MAP_ID = "dyson-sphere-ring-1";
export const CANONICAL_DYSON_MAP = Object.freeze({
  map_id: CANONICAL_DYSON_MAP_ID,
  asset_path: "public/maps/dyson-sphere-ring-1.map.json",
  metadata_path: "public/maps/dyson-sphere-ring-1.metadata.json",
  anchor_asset_id: CANONICAL_DYSON_MAP_ID,
  star_systems: Object.freeze([
    {
      system_id: "dyson-ring-primary",
      name: "Dyson Sphere Ring Primary",
      role: "anchor_star",
      sector: "ring-core",
      ordinal: 1,
      coordinates_json: JSON.stringify({ x: 0, y: 0, z: 0 })
    },
    {
      system_id: "dyson-ring-north-relay",
      name: "Dyson Ring North Relay",
      role: "metering_relay",
      sector: "ring-north",
      ordinal: 2,
      coordinates_json: JSON.stringify({ x: 0, y: 1, z: 0 })
    },
    {
      system_id: "dyson-ring-south-relay",
      name: "Dyson Ring South Relay",
      role: "metering_relay",
      sector: "ring-south",
      ordinal: 3,
      coordinates_json: JSON.stringify({ x: 0, y: -1, z: 0 })
    }
  ])
});

export function mapRecordSchema(){
  return {
    map_id: "TEXT PRIMARY KEY",
    asset_path: "TEXT NOT NULL",
    metadata_path: "TEXT NOT NULL",
    sha256_digest: "TEXT NOT NULL",
    anchor_asset_id: "TEXT NOT NULL",
    star_systems: "map_star_systems[]",
    created_at: "TEXT NOT NULL DEFAULT (datetime('now'))"
  };
}

export function sha256ForRelativePath(relativePath){
  const absolutePath = path.join(repoRoot, relativePath);
  if(fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()){
    return crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
  }
  return crypto.createHash("sha256").update(relativePath).digest("hex");
}

function parseCoordinates(value){
  if(!value) return null;
  try{
    return JSON.parse(value);
  }catch(_e){
    return null;
  }
}

export function mapAssetToRecord(asset, starSystems = []){
  if(!asset) return null;
  return {
    map_id: asset.map_id,
    asset_path: asset.asset_path,
    metadata_path: asset.metadata_path,
    sha256_digest: asset.sha256_digest,
    anchor_asset_id: asset.anchor_asset_id,
    created_at: asset.created_at,
    star_systems: starSystems.map(row => ({
      system_id: row.system_id,
      name: row.name,
      role: row.role,
      sector: row.sector,
      ordinal: row.ordinal,
      coordinates: parseCoordinates(row.coordinates_json),
      created_at: row.created_at
    }))
  };
}

export function loadMapDatabase(db, mapId = CANONICAL_DYSON_MAP_ID){
  const asset = db.prepare(`
    SELECT map_id, asset_path, metadata_path, sha256_digest, anchor_asset_id, created_at
    FROM map_assets
    WHERE map_id = ?
  `).get(mapId);
  if(!asset) return null;
  const starSystems = db.prepare(`
    SELECT system_id, name, role, sector, ordinal, coordinates_json, created_at
    FROM map_star_systems
    WHERE map_id = ?
    ORDER BY ordinal, system_id
  `).all(mapId);
  return mapAssetToRecord(asset, starSystems);
}

export function loadMapDatabaseByAnchorId(db, anchorAssetId = CANONICAL_DYSON_MAP_ID){
  const asset = db.prepare(`
    SELECT map_id, asset_path, metadata_path, sha256_digest, anchor_asset_id, created_at
    FROM map_assets
    WHERE anchor_asset_id = ?
    ORDER BY created_at DESC, map_id
    LIMIT 1
  `).get(anchorAssetId);
  if(!asset) return null;
  return loadMapDatabase(db, asset.map_id);
}
