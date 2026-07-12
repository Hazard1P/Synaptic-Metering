import { createHash } from "node:crypto";
import { loadMapDatabaseByAnchorId } from "./mapDatabase.js";

const FIVE_DAY_EPOCH_SECONDS = 5 * 24 * 60 * 60;
const DAILY_UNIX_WINDOW_SECONDS = 24 * 60 * 60;

export const ANCHORED_ASSET_MAP = Object.freeze({
  "major-ursa": {
    id: "major-ursa",
    label: "Major Ursa anchored star/database",
    asset_type: "constellation_database",
    permanence: "permanent_anchor",
    role: "governance_intelligence_database",
    physics_role: "considered_in_data_and_physics_not_pulled_through",
    tick_rate_hz: 1,
    vector: "tip_to_dipper_24_hour_unix_daily_alignment"
  },
  cassiopeia: {
    id: "cassiopeia",
    label: "Cassiopeia quantum biometrics anchor",
    asset_type: "constellation_biometrics",
    permanence: "permanent_anchor",
    role: "quantum_biometric_moderation",
    physics_role: "considered_in_data_and_physics_not_pulled_through",
    tick_rate_hz: 1,
    vector: "relative_anchored_star_24_hour_unix_daily_alignment"
  },
  "isolated-blackholes": {
    id: "isolated-blackholes",
    label: "Isolated blackholes universe-mesh anchors",
    asset_type: "blackhole_mesh_anchor",
    permanence: "permanent_anchor",
    role: "universe_mesh_intelligence_reference",
    physics_role: "considered_in_data_and_physics_not_pulled_through",
    tick_rate_hz: 1,
    vector: "non_extractive_gravity_reference"
  },
  "fabric-universe-ring-map": {
    id: "fabric-universe-ring-map",
    label: "Fabric Universe Ring deterministic map anchor",
    asset_type: "deterministic_map_anchor",
    permanence: "permanent_anchor",
    role: "operator_map_database",
    physics_role: "deterministic_ring_map_reference_anchor",
    tick_rate_hz: 1,
    vector: "fabric_universe_ring_map_reference"
  },
  "live-entropy-index": {
    id: "live-entropy-index",
    label: "Live Entropy Index build anchor",
    asset_type: "entropy_index_build_anchor",
    permanence: "deterministic_build_anchor",
    role: "live_string_intelligence_entropy_reference",
    physics_role: "non_extractive_entropy_scoring_reference_anchor",
    tick_rate_hz: 1,
    vector: "normalized_string_entropy_sha256_tick_alignment"
  },
  "dyson-sphere-ring-1": {
    id: "dyson-sphere-ring-1",
    label: "Dyson-Sphere Ring-1 map database",
    asset_type: "physical_map_database",
    permanence: "permanent_anchor",
    role: "operator_map_database",
    physics_role: "map_database_reference_anchor",
    tick_rate_hz: 1,
    vector: "ring_1_physical_map_reference",
    metadata: Object.freeze({
      structure_label: "Dyson-Sphere",
      ring_system_label: "3_ring_Dyson-Sphere",
      ring_label: "Ring-1",
      organization: "techneqly",
      association_type: "Business-Association",
      system_label: "Central_Synaptic_Intelligence_Systems",
      owner_executive_director: "Owner/Executive-Director: Michael_Rybaltowicz",
      anchor_path: "Home-Room/LightBulb-2-Map_Database/Star_Anchor"
    })
  }
});

const DEFAULT_ANCHOR_ID = "dyson-sphere-ring-1";
const ANCHORED_ASSET_COLUMNS = `
  id, label, asset_type, permanence, role, physics_role, tick_rate_hz, vector
`;

function normalizeRawAnchorId(anchorId){
  return String(anchorId || DEFAULT_ANCHOR_ID).trim().toLowerCase();
}

function fallbackAnchor(anchorId = DEFAULT_ANCHOR_ID){
  const id = normalizeRawAnchorId(anchorId);
  return ANCHORED_ASSET_MAP[id] || ANCHORED_ASSET_MAP[DEFAULT_ANCHOR_ID];
}

export function loadAnchoredAsset(db, anchorId = DEFAULT_ANCHOR_ID){
  const id = normalizeRawAnchorId(anchorId);
  const asset = db.prepare(`
    SELECT ${ANCHORED_ASSET_COLUMNS}
    FROM anchored_assets
    WHERE id = ?
  `).get(id);
  return asset || null;
}

export function listAnchoredAssets(db){
  const rows = db.prepare(`
    SELECT ${ANCHORED_ASSET_COLUMNS}
    FROM anchored_assets
    ORDER BY id
  `).all();
  return rows.length ? rows : Object.values(ANCHORED_ASSET_MAP);
}

function attachMapDatabase(db, asset){
  if(!db || !asset) return asset;
  const map_database = loadMapDatabaseByAnchorId(db, asset.id);
  return map_database ? { ...asset, map_database } : asset;
}

export function resolveAnchoredAsset(db, anchorId = DEFAULT_ANCHOR_ID){
  if(!db) return fallbackAnchor(anchorId);

  const asset = loadAnchoredAsset(db, anchorId)
    || loadAnchoredAsset(db, DEFAULT_ANCHOR_ID)
    || fallbackAnchor(anchorId);
  return attachMapDatabase(db, asset);
}

export function unixSeconds(date = new Date()){
  return Math.floor(date.getTime() / 1000);
}

export function dailyUnixRelevancy(nowUnix = unixSeconds()){
  const day_index = Math.floor(nowUnix / DAILY_UNIX_WINDOW_SECONDS);
  const day_start_unix = day_index * DAILY_UNIX_WINDOW_SECONDS;
  const day_end_unix = day_start_unix + DAILY_UNIX_WINDOW_SECONDS - 1;
  const seconds_into_day = nowUnix - day_start_unix;
  return {
    window_seconds: DAILY_UNIX_WINDOW_SECONDS,
    day_index,
    day_start_unix,
    day_end_unix,
    seconds_into_day,
    seconds_remaining: day_end_unix - nowUnix,
    aligned_anchors: ["major-ursa", "cassiopeia"],
    discrepancy_basis: "unix_daily_24_hour_alignment"
  };
}

export function fiveDayRollingEpoch(nowUnix = unixSeconds()){
  const epoch_index = Math.floor(nowUnix / FIVE_DAY_EPOCH_SECONDS);
  const epoch_start_unix = epoch_index * FIVE_DAY_EPOCH_SECONDS;
  const epoch_end_unix = epoch_start_unix + FIVE_DAY_EPOCH_SECONDS - 1;
  const seconds_into_epoch = nowUnix - epoch_start_unix;
  return {
    window_seconds: FIVE_DAY_EPOCH_SECONDS,
    epoch_index,
    epoch_start_unix,
    epoch_end_unix,
    seconds_into_epoch,
    seconds_remaining: epoch_end_unix - nowUnix
  };
}

export function deterministicTickId({ anchorId, nowUnix, epochIndex, tickRateHz }){
  return createHash("sha256")
    .update(JSON.stringify({
      anchor_id: String(anchorId || DEFAULT_ANCHOR_ID),
      now_unix: Number(nowUnix),
      epoch_index: Number(epochIndex),
      tick_rate_hz: Number(tickRateHz),
      operation: "Seconds_Of_Intelligence"
    }))
    .digest("hex");
}

export function normalizeAnchorId(anchorId, db = null){
  return resolveAnchoredAsset(db, anchorId).id;
}

export function intelligenceTickContext({ anchorId = DEFAULT_ANCHOR_ID, anchoredAsset = null, db = null, invoiceKey = null, masterKey = null, now = new Date() } = {}){
  const now_unix = unixSeconds(now);
  const asset = anchoredAsset || resolveAnchoredAsset(db, anchorId);
  const five_day_epoch = fiveDayRollingEpoch(now_unix);
  const daily_unix_relevancy = dailyUnixRelevancy(now_unix);
  const deterministic_tick_basis = {
    anchor_id: asset.id,
    now_unix,
    epoch_index: five_day_epoch.epoch_index,
    tick_rate_hz: asset.tick_rate_hz
  };
  return {
    operation: "Seconds_Of_Intelligence",
    tick_rate_hz: asset.tick_rate_hz,
    tick_seconds: 1,
    now_unix,
    five_day_epoch,
    daily_unix_relevancy,
    deterministic_tick_id: deterministicTickId({
      anchorId: deterministic_tick_basis.anchor_id,
      nowUnix: deterministic_tick_basis.now_unix,
      epochIndex: deterministic_tick_basis.epoch_index,
      tickRateHz: deterministic_tick_basis.tick_rate_hz
    }),
    deterministic_tick_basis,
    anchored_asset: asset,
    invoice_key: invoiceKey,
    master_key: masterKey,
    network_governance: masterKey ? "genesis_core_network" : "invoice_bound",
    extraction_policy: "anchor_reference_only_not_pulled_through"
  };
}



function publicBaseUrl(){
  return (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
}

function publicUrl(path){
  const baseUrl = publicBaseUrl();
  if(!baseUrl) return null;
  const normalizedPath = String(path || "").startsWith("/") ? path : `/${path}`;
  return `${baseUrl}${normalizedPath}`;
}

export const MAP_DATABASE_METADATA = Object.freeze({
  "dyson-sphere-ring-1": {
    business_association: "Synaptics.Systems deployment operations",
    owner_executive_director: "Synaptics.Systems Executive Director",
    physical_map_image_url: "/public/dyson-sphere-ring-1-map.svg"
  },
  "fabric-universe-ring-map": {
    business_association: "Synaptics.Systems deployment operations",
    owner_executive_director: "Synaptics.Systems Executive Director",
    physical_map_image_url: "/public/maps/fabric-universe-ring-map.svg"
  }
});

export function mapDatabaseStatus({ db = null, anchorId = "dyson-sphere-ring-1", now = new Date() } = {}){
  const asset = resolveAnchoredAsset(db, anchorId);
  const metadata = MAP_DATABASE_METADATA[asset.id] || MAP_DATABASE_METADATA["dyson-sphere-ring-1"];
  const isRequestedAnchorActive = asset.id === normalizeRawAnchorId(anchorId);

  return {
    active_anchor_id: asset.id,
    tick_rate_hz: asset.tick_rate_hz,
    map_label: asset.label,
    business_association: metadata.business_association,
    owner_executive_director: metadata.owner_executive_director,
    authentication_status: isRequestedAnchorActive ? "authenticated_active" : "fallback_anchor_active",
    canonical_map_url: publicUrl(metadata.physical_map_image_url),
    map_database_url: publicUrl(`/map/database?anchor_id=${asset.id}`),
    map_authentication_url: publicUrl(`/map/authenticate/${asset.id}`),
    physical_map_image_url: metadata.physical_map_image_url,
    physical_map_image_url_absolute: publicUrl(metadata.physical_map_image_url),
    checked_at: now.toISOString()
  };
}
