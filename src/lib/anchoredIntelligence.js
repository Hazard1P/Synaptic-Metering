const FIVE_DAY_EPOCH_SECONDS = 5 * 24 * 60 * 60;

export const ANCHORED_ASSET_MAP = Object.freeze({
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

export function normalizeAnchorId(anchorId){
  const id = String(anchorId || "major-ursa").trim().toLowerCase();
  return ANCHORED_ASSET_MAP[id] ? id : "major-ursa";
}

export function intelligenceTickContext({ anchorId = "major-ursa", invoiceKey = null, masterKey = null, now = new Date() } = {}){
  const now_unix = unixSeconds(now);
  const normalizedAnchorId = normalizeAnchorId(anchorId);
  return {
    operation: "Seconds_Of_Intelligence",
    tick_rate_hz: ANCHORED_ASSET_MAP[normalizedAnchorId].tick_rate_hz,
    tick_seconds: 1,
    now_unix,
    five_day_epoch: fiveDayRollingEpoch(now_unix),
    anchored_asset: ANCHORED_ASSET_MAP[normalizedAnchorId],
    invoice_key: invoiceKey,
    master_key: masterKey,
    network_governance: masterKey ? "genesis_core_network" : "invoice_bound",
    extraction_policy: "anchor_reference_only_not_pulled_through"
  };
}
