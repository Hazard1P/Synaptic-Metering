import { createHash } from "node:crypto";
import { intelligenceTickContext, mapDatabaseStatus } from "./anchoredIntelligence.js";

const DEFAULT_ANCHOR_ID = "dyson-sphere-ring-1";

function sha256Hex(value){
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function finiteNumber(value){
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeGpsPinpoint(input = {}){
  const latitude = finiteNumber(input.latitude ?? input.lat);
  const longitude = finiteNumber(input.longitude ?? input.lng ?? input.lon);
  const accuracyMeters = finiteNumber(input.accuracy_meters ?? input.accuracyMeters ?? input.accuracy);

  if(latitude === null || longitude === null){
    const err = new Error("gps_pinpoint_required");
    err.status = 400;
    throw err;
  }
  if(latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180){
    const err = new Error("gps_pinpoint_out_of_range");
    err.status = 400;
    throw err;
  }

  const precision = Math.max(0, Math.min(6, Number.isInteger(input.precision) ? input.precision : 6));
  return {
    latitude: Number(latitude.toFixed(precision)),
    longitude: Number(longitude.toFixed(precision)),
    accuracy_meters: accuracyMeters === null ? null : Math.max(0, Number(accuracyMeters.toFixed(2))),
    precision
  };
}

function normalizeClient(value){
  return String(value || "web").trim().replace(/[^a-zA-Z0-9:._-]/g, "_").slice(0, 120) || "web";
}

function normalizeString(value){
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 240);
}

export function loadGoogleIdentity(db, accountId){
  if(!db || !accountId) return null;
  const row = db.prepare(`
    SELECT provider_name, provider_subject, email, email_verified, created_at, updated_at
    FROM account_identities
    WHERE account_id=? AND provider_name='google'
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
  `).get(accountId);
  if(!row) return null;
  return {
    provider_name: row.provider_name,
    subject_hash: sha256Hex(`google:${row.provider_subject}`),
    email_domain: row.email ? String(row.email).split("@").pop()?.toLowerCase() || null : null,
    email_verified: Boolean(row.email_verified),
    updated_at: row.updated_at
  };
}

export function buildLightIntelligenceSegment({ db, account, authSessionId, client, gps, strings = [], anchorId = DEFAULT_ANCHOR_ID, now = new Date() } = {}){
  if(!account?.id){
    const err = new Error("authentication_required");
    err.status = 401;
    throw err;
  }

  const pinpoint = normalizeGpsPinpoint(gps);
  const normalizedClient = normalizeClient(client);
  const googleIdentity = loadGoogleIdentity(db, account.id);
  if(!googleIdentity){
    const err = new Error("google_identity_required");
    err.status = 403;
    throw err;
  }

  const normalizedStrings = (Array.isArray(strings) ? strings : [strings])
    .map(normalizeString)
    .filter(Boolean)
    .slice(0, 24);
  const context = intelligenceTickContext({ db, anchorId, now });
  const sessionKeyHash = sha256Hex(authSessionId || account.id);
  const pinpointHash = sha256Hex(`${pinpoint.latitude}:${pinpoint.longitude}:${pinpoint.accuracy_meters ?? ""}`);
  const stringHash = sha256Hex(JSON.stringify(normalizedStrings));
  const segmentId = sha256Hex(JSON.stringify({
    operation: "Light_Intelligence",
    anchor_id: context.anchored_asset.id,
    account_id: account.id,
    session_key_hash: sessionKeyHash,
    client: normalizedClient,
    pinpoint_hash: pinpointHash,
    string_hash: stringHash,
    tick_id: context.deterministic_tick_id
  }));

  return {
    id: segmentId,
    operation: "Light_Intelligence",
    source: "authenticated_google_account_session_client_gps",
    anchor_id: context.anchored_asset.id,
    association: "strings_of_intelligence_associated_with_dyson_sphere",
    account: {
      id: account.id,
      display_name: account.display_name || null,
      role: account.role || "user",
      google_identity: googleIdentity
    },
    session_key_hash: sessionKeyHash,
    client: normalizedClient,
    gps_pinpoint: pinpoint,
    gps_pinpoint_hash: pinpointHash,
    strings_of_intelligence: normalizedStrings,
    strings_hash: stringHash,
    context,
    map_database: mapDatabaseStatus({ db, anchorId: context.anchored_asset.id, now }),
    privacy: {
      requires_account_session: true,
      requires_location_consent: true,
      requires_telemetry_consent_for_persistence: true,
      raw_google_subject: "not_returned",
      oauth_tokens: "not_used"
    }
  };
}
