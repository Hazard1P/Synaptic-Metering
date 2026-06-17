import crypto from "crypto";
import fs from "fs";
import path from "path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

export const CANONICAL_DYSON_MAP_ID = "dyson-sphere-ring-1";
export const CANONICAL_DYSON_MAP = Object.freeze({
  map_id: CANONICAL_DYSON_MAP_ID,
  anchor_asset_id: CANONICAL_DYSON_MAP_ID,
  digest: sha256ForRelativePath("public/maps/dyson-sphere-ring-1.map.json"),
  metadata_json: JSON.stringify({
    id: CANONICAL_DYSON_MAP_ID,
    label: "Dyson-Sphere Ring-1 map database",
    asset_type: "physical_map_database",
    permanence: "permanent_anchor",
    role: "operator_map_database",
    physics_role: "map_database_reference_anchor",
    tick_rate_hz: 1,
    vector: "ring_1_physical_map_reference"
  }),
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
    anchor_asset_id: "TEXT NOT NULL",
    digest: "TEXT NOT NULL CHECK(length(digest) = 64)",
    verification_status: "TEXT NOT NULL DEFAULT 'verified'",
    metadata_json: "TEXT NOT NULL",
    star_systems: "map_star_systems[] (optional)",
    created_at: "TEXT NOT NULL DEFAULT (datetime('now'))",
    updated_at: "TEXT NOT NULL DEFAULT (datetime('now'))"
  };
}

export function sha256ForRelativePath(relativePath){
  const absolutePath = path.join(repoRoot, relativePath);
  if(fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()){
    return crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
  }
  return crypto.createHash("sha256").update(relativePath).digest("hex");
}

function parseJson(value, fallback = null){
  if(value === null || value === undefined || value === "") return fallback;
  try{
    return JSON.parse(value);
  }catch(_e){
    return fallback;
  }
}

function parseCoordinates(value){
  return parseJson(value, null);
}

function tableExists(db, tableName){
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName);
  return Boolean(row);
}

export function mapAssetToRecord(asset, starSystems = []){
  if(!asset) return null;
  const metadata = parseJson(asset.metadata_json, {});
  return {
    map_id: asset.map_id,
    anchor_asset_id: asset.anchor_asset_id,
    digest: asset.digest,
    verification_status: asset.verification_status,
    metadata,
    created_at: asset.created_at,
    updated_at: asset.updated_at,
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

function loadStarSystems(db, mapId){
  if(!tableExists(db, "map_star_systems")) return [];
  return db.prepare(`
    SELECT system_id, name, role, sector, ordinal, coordinates_json, created_at
    FROM map_star_systems
    WHERE map_id = ?
    ORDER BY ordinal, system_id
  `).all(mapId);
}

export function loadMapDatabase(db, mapId = CANONICAL_DYSON_MAP_ID){
  const asset = db.prepare(`
    SELECT map_id, anchor_asset_id, digest, verification_status, metadata_json, created_at, updated_at
    FROM map_assets
    WHERE map_id = ?
  `).get(mapId);
  if(!asset) return null;
  return mapAssetToRecord(asset, loadStarSystems(db, mapId));
}

export function loadMapDatabaseByAnchorId(db, anchorAssetId = CANONICAL_DYSON_MAP_ID){
  const asset = db.prepare(`
    SELECT map_id
    FROM map_assets
    WHERE anchor_asset_id = ?
    ORDER BY created_at DESC, map_id
    LIMIT 1
  `).get(anchorAssetId);
  if(!asset) return null;
  return loadMapDatabase(db, asset.map_id);
}
