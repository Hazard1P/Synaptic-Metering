const FIVE_DAY_EPOCH_SECONDS = 5 * 24 * 60 * 60;

export const ANCHORED_ASSET_MAP = Object.freeze({
  "dyson-sphere-ring-1": {
    id: "dyson-sphere-ring-1",
    label: "Dyson-Sphere 3_ring_Dyson-Sphere Ring-1 anchor",
    asset_type: "Dyson-Sphere",
    permanence: "permanent_anchor",
    role: "Business-Association",
    physics_role: "Home-Room/LightBulb-2-Map_Database/Star_Anchor",
    tick_rate_hz: 1,
    vector: "techneqly_central_synaptic_intelligence_systems_ring_1",
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
  },
  "major-ursa": {
    id: "major-ursa",
    label: "Major Ursa anchored star/database",
    asset_type: "constellation_database",
    permanence: "permanent_anchor",
    role: "governance_intelligence_database",
    physics_role: "considered_in_data_and_physics_not_pulled_through",
    tick_rate_hz: 1,
    vector: "tip_to_dipper_epoch_unix_discrepancy"
  },
  cassiopeia: {
    id: "cassiopeia",
    label: "Cassiopeia quantum biometrics anchor",
    asset_type: "constellation_biometrics",
    permanence: "permanent_anchor",
    role: "quantum_biometric_moderation",
    physics_role: "considered_in_data_and_physics_not_pulled_through",
    tick_rate_hz: 1,
    vector: "relative_anchored_star_biometrics"
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

export function resolveAnchoredAsset(db, anchorId = DEFAULT_ANCHOR_ID){
  if(!db) return fallbackAnchor(anchorId);

  return loadAnchoredAsset(db, anchorId)
    || loadAnchoredAsset(db, DEFAULT_ANCHOR_ID)
    || fallbackAnchor(anchorId);
}

export function unixSeconds(date = new Date()){
  return Math.floor(date.getTime() / 1000);
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

export function normalizeAnchorId(anchorId, db = null){
  return resolveAnchoredAsset(db, anchorId).id;
}

export function intelligenceTickContext({ anchorId = DEFAULT_ANCHOR_ID, anchoredAsset = null, db = null, invoiceKey = null, masterKey = null, now = new Date() } = {}){
  const now_unix = unixSeconds(now);
  const asset = anchoredAsset || resolveAnchoredAsset(db, anchorId);
  return {
    operation: "Seconds_Of_Intelligence",
    tick_rate_hz: asset.tick_rate_hz,
    tick_seconds: 1,
    now_unix,
    five_day_epoch: fiveDayRollingEpoch(now_unix),
    anchored_asset: asset,
    invoice_key: invoiceKey,
    master_key: masterKey,
    network_governance: masterKey ? "genesis_core_network" : "invoice_bound",
    extraction_policy: "anchor_reference_only_not_pulled_through"
  };
}
