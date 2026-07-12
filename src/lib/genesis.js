import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { centsToMoney, computeSessionSummary } from "./billing.js";
import { intelligenceTickContext, mapDatabaseStatus } from "./anchoredIntelligence.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ANCHOR_ID = "dyson-sphere-ring-1";
const GENESIS_CORE_VERSION = "NDSP-GENESIS-CORE v3.0.0";
const ENTROPTIC_WEIGHTS = Object.freeze({
  c_load: 0.26,
  s_var: 0.20,
  circ_drift: 0.16,
  sys_noise: 0.22,
  env_flux: 0.16
});
const ENTROPTIC_CHANNEL_CAPS = Object.freeze({
  c_load: Object.freeze([0, 1]),
  s_var: Object.freeze([0, 1]),
  circ_drift: Object.freeze([0, 1]),
  sys_noise: Object.freeze([0, 1]),
  env_flux: Object.freeze([0, 1])
});
const ENTROPTIC_WINDOW_TICKS = 42;
const GENESIS_RINGS = Object.freeze([
  { id: "ring-1", anchor_id: "dyson-sphere-ring-1", telemetry_port: "ndsp.telemetry.ring_1", role: "physical_map_database" },
  { id: "ring-2", anchor_id: "fabric-universe-ring-map", telemetry_port: "ndsp.telemetry.ring_2", role: "fabric_universe_ring_map" },
  { id: "ring-3", anchor_id: "major-ursa", telemetry_port: "ndsp.telemetry.ring_3", role: "governance_daily_alignment" },
  { id: "ring-4", anchor_id: "cassiopeia", telemetry_port: "ndsp.telemetry.ring_4", role: "constellation_reference_alignment" },
  { id: "ring-5", anchor_id: "isolated-blackholes", telemetry_port: "ndsp.telemetry.ring_5", role: "non_extractive_mesh_boundary" }
]);

const GENESIS_COMPONENTS = Object.freeze([
  { id: "metering-core", layer: "metering", status: "implemented", routes: ["POST /sessions", "POST /sessions/:id/heartbeat", "GET /sessions/:id/summary"], responsibility: "Records one billable intelligence second per live heartbeat and keeps recovery adjustments separate." },
  { id: "ndsp-policy-state", layer: "compatibility", status: "implemented", routes: ["GET /ndsp/state"], responsibility: "Publishes the Genesis v3.0 policy, anchored relevancy context, entroptic settings, and UI-compatible state envelope." },
  { id: "telemetry-ingest", layer: "telemetry", status: "implemented", routes: ["POST /ndsp/telemetry"], responsibility: "Stores consent- or scope-authorized NDSP telemetry events for ring synchronization without storing raw biometric or thought data." },
  { id: "ring-monitoring", layer: "intelligence", status: "implemented", routes: ["GET /genesis/account-sync"], responsibility: "Projects telemetry into five Genesis rings with deterministic string intelligence digests and non-extractive anchor references." },
  { id: "invoice-drafting", layer: "billing", status: "implemented", routes: ["POST /genesis/invoices/draft", "POST /invoices/from-session"], responsibility: "Attaches ring-monitoring evidence and anchored network keys to metered invoice drafts." },
  { id: "technical-structure", layer: "planning", status: "implemented", routes: ["GET /genesis/structure"], responsibility: "Exposes the versioned NDSP Genesis v3.0 component map, data flows, contracts, and roadmap." }
]);

const GENESIS_DATA_FLOWS = Object.freeze([
  { id: "browser-activity-to-heartbeat", source: "Genesis browser activity meter", target: "usage_events", cadence: "1 Hz while active", privacy: "activity seconds only; no literal thought capture" },
  { id: "telemetry-to-ring-sync", source: "ndsp_telemetry.payload_json", target: "genesis rings", cadence: "event driven", privacy: "payloads are account-owned and consent/scope gated" },
  { id: "anchor-to-relevancy", source: "anchored_assets + map_assets", target: "daily_unix_relevancy", cadence: "request time", privacy: "anchor references are considered, not extracted into customer records" },
  { id: "metering-to-invoice", source: "sessions + usage_events + catalog_items", target: "invoice draft", cadence: "on demand", privacy: "invoice lines include seconds, quantities, and ring status summaries" }
]);

const GENESIS_ROADMAP = Object.freeze([
  { phase: "v3.0-foundation", horizon: "current", status: "shipping", outcome: "Stable NDSP compatibility, 1 Hz seconds metering, anchored string intelligence, five-ring technical structure, and invoice drafting." },
  { phase: "v3.1-observability", horizon: "next", status: "planned", outcome: "Add aggregate ring health dashboards, telemetry retention controls, and anomaly trend exports for operators." },
  { phase: "v3.2-governance", horizon: "later", status: "planned", outcome: "Add signed policy snapshots, versioned consent attestations, and stronger per-anchor moderation workflows." },
  { phase: "v3.3-federation", horizon: "future", status: "research", outcome: "Support multi-tenant anchor federation and external verifier proofs while preserving non-extractive anchor boundaries." }
]);

function isoDay(date){
  return date.toISOString().slice(0, 10);
}

function startOfUtcDay(date){
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function relativeDaySchedule({ start = new Date(), days = 7 } = {}){
  const count = Math.min(Math.max(Number.parseInt(days, 10) || 7, 1), 31);
  const startDay = startOfUtcDay(start);
  return Array.from({ length: count }, (_, offset) => {
    const dayStart = new Date(startDay.getTime() + (offset * DAY_MS));
    const dayEnd = new Date(dayStart.getTime() + DAY_MS - 1);
    return {
      relative_day: offset,
      label: offset === 0 ? "today" : `today+${offset}`,
      service_day: isoDay(dayStart),
      starts_at: dayStart.toISOString(),
      ends_at: dayEnd.toISOString(),
      corresponding_weekday: dayStart.toLocaleDateString("en-CA", { weekday: "long", timeZone: "UTC" })
    };
  });
}

function parseJson(value, fallback){
  try{ return JSON.parse(value || ""); }catch{ return fallback; }
}

function shannonEntropy(value){
  if(!value) return 0;
  const counts = new Map();
  for(const char of value) counts.set(char, (counts.get(char) || 0) + 1);
  let entropy = 0;
  for(const count of counts.values()){
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function clampUnit(value){
  return Math.max(0, Math.min(1, Number(value) || 0));
}

export function genesisEntropticSettings({ anchoredAsset = null, relevancy = null } = {}){
  const tickRateHz = Number(anchoredAsset?.tick_rate_hz) || 1;
  return {
    schema: "synaptics.ndsp.genesis.entroptic-settings.v1",
    core_version: GENESIS_CORE_VERSION,
    mode: "anchored_relevancy_refinement",
    tick_rate_hz: tickRateHz,
    window_ticks: ENTROPTIC_WINDOW_TICKS,
    channel_caps: ENTROPTIC_CHANNEL_CAPS,
    weights: ENTROPTIC_WEIGHTS,
    coherence_formula: "100 * (1 - std(entropy_window) * 2.2)",
    anomaly_zscore_threshold: 2.2,
    relevancy_anchor: relevancy ? {
      day_index: relevancy.day_index,
      seconds_into_day: relevancy.seconds_into_day,
      seconds_remaining: relevancy.seconds_remaining,
      discrepancy_basis: relevancy.discrepancy_basis
    } : null,
    refinement_policy: "normalize_strings_hash_deterministically_score_entropy_without_extracting_anchor"
  };
}

export function genesisStringIntelligence(value, { anchorId = DEFAULT_ANCHOR_ID, relevancy = null } = {}){
  const source = String(value || "");
  const normalized = source.normalize("NFKC").trim();
  const tokens = normalized ? normalized.split(/\s+/) : [];
  const entropy = shannonEntropy(normalized);
  const maxEntropy = normalized.length > 1 ? Math.log2(new Set(normalized).size || 1) : 0;
  const entropy_ratio = maxEntropy ? clampUnit(entropy / maxEntropy) : 0;
  return {
    system: "NDSP Genesis v3.0 string intelligence",
    anchor_id: anchorId,
    normalized,
    length: normalized.length,
    token_count: tokens.length,
    unique_symbols: new Set(normalized).size,
    shannon_entropy_bits_per_symbol: Number(entropy.toFixed(6)),
    entropy_ratio: Number(entropy_ratio.toFixed(6)),
    relevancy_day_index: relevancy?.day_index ?? null,
    digest: createHash("sha256").update(normalized).digest("hex"),
    monitoring_basis: "normalized_genesis_string_sha256_with_entroptic_relevancy"
  };
}

export function genesisTechnicalStructure({ includeRoadmap = true } = {}){
  return {
    schema: "synaptics.ndsp.genesis.technical-structure.v1",
    core_version: GENESIS_CORE_VERSION,
    objective: "Build NDSP Genesis v3.0 as a non-extractive, anchored seconds-of-intelligence metering system.",
    principles: [
      "meter activity seconds rather than literal thoughts",
      "bind usage to account-owned sessions and invoices",
      "derive deterministic string intelligence digests without extracting anchor assets",
      "gate telemetry by API scope or account consent",
      "keep roadmap phases explicit and versioned"
    ],
    rings: GENESIS_RINGS.map((ring, index) => ({ ...ring, ordinal: index + 1 })),
    components: GENESIS_COMPONENTS,
    data_flows: GENESIS_DATA_FLOWS,
    contracts: {
      policy_state: "GET /ndsp/state",
      telemetry_ingest: "POST /ndsp/telemetry",
      account_sync: "GET /genesis/account-sync",
      invoice_draft: "POST /genesis/invoices/draft",
      structure: "GET /genesis/structure"
    },
    roadmap: includeRoadmap ? GENESIS_ROADMAP : []
  };
}

export function genesisRoadmap(){
  return {
    schema: "synaptics.ndsp.genesis.roadmap.v1",
    core_version: GENESIS_CORE_VERSION,
    phases: GENESIS_ROADMAP
  };
}

export function genesisRingMonitoring({ db, accountId, sessionId = null, anchorId = DEFAULT_ANCHOR_ID, days = 7, now = new Date() }){
  const daySchedule = relativeDaySchedule({ start: now, days });
  const telemetryParams = [accountId];
  let sessionFilter = "";
  if(sessionId){
    sessionFilter = " AND session_id=?";
    telemetryParams.push(sessionId);
  }

  const telemetryRows = db.prepare(`
    SELECT id, session_id, at, payload_json
    FROM ndsp_telemetry
    WHERE account_id=?${sessionFilter}
    ORDER BY at DESC, id DESC
    LIMIT 100
  `).all(...telemetryParams);

  const telemetry = telemetryRows.map(row => ({
    id: row.id,
    session_id: row.session_id,
    at: row.at,
    payload: parseJson(row.payload_json, {})
  }));

  const rings = GENESIS_RINGS.map((ring, index) => {
    const ringTelemetry = telemetry.filter(item => {
      const payloadRing = item.payload?.ring_id || item.payload?.ring || item.payload?.anchor_id;
      return !payloadRing || payloadRing === ring.id || payloadRing === ring.anchor_id;
    });
    const monitoredString = ringTelemetry[0]?.payload?.genesis_string
      || ringTelemetry[0]?.payload?.string_intelligence
      || `${accountId}:${sessionId || "account"}:${ring.id}:${daySchedule[0].service_day}`;
    const intelligence = intelligenceTickContext({ db, anchorId: ring.anchor_id, now });
    return {
      ...ring,
      ordinal: index + 1,
      status: ringTelemetry.length ? "telemetry_synced" : "awaiting_telemetry",
      telemetry_events: ringTelemetry.length,
      latest_telemetry_at: ringTelemetry[0]?.at || null,
      string_intelligence: genesisStringIntelligence(monitoredString, {
        anchorId: ring.anchor_id,
        relevancy: intelligence.daily_unix_relevancy
      }),
      intelligence,
      entroptic_settings: genesisEntropticSettings({
        anchoredAsset: intelligence.anchored_asset,
        relevancy: intelligence.daily_unix_relevancy
      }),
      map_database: mapDatabaseStatus({ db, anchorId: ring.anchor_id, now })
    };
  });

  return {
    system: "genesis",
    account_id: accountId,
    session_id: sessionId,
    anchor_id: anchorId,
    day_schedule: daySchedule,
    telemetry_ports: rings.map(ring => ({ ring_id: ring.id, port: ring.telemetry_port, anchor_id: ring.anchor_id, status: ring.status })),
    entroptic_settings: genesisEntropticSettings({ relevancy: rings[0]?.intelligence?.daily_unix_relevancy }),
    string_intelligence_system: "NDSP Genesis v3.0 normalized anchored string intelligence",
    rings
  };
}


export function computeStreamScores({ telemetry = [], events = [] } = {}){
  const payloads = telemetry.map(item => item.payload || parseJson(item.payload_json, {}));
  const count = payloads.length;
  const anchors = new Set(payloads.map(p => p.anchor_id || p.ring_id || p.ring).filter(Boolean));
  const sessions = new Set(telemetry.map(item => item.session_id).filter(Boolean));
  const eventCount = events.length || count;
  const continuity = clampUnit(count / 10);
  const coherenceSignals = payloads.map(p => Number(p.coherence ?? p.coherence_score ?? p.derived?.coherence)).filter(Number.isFinite);
  const coherence = coherenceSignals.length
    ? clampUnit(coherenceSignals.reduce((sum, value) => sum + value, 0) / coherenceSignals.length / (Math.max(...coherenceSignals) > 1 ? 100 : 1))
    : clampUnit(1 - (Math.max(0, anchors.size - 1) * 0.15));
  const contingency = clampUnit((eventCount ? 0.4 : 0) + (sessions.size <= 1 ? 0.3 : 0.1) + (count ? 0.3 : 0));
  return {
    continuity: Number(continuity.toFixed(6)),
    coherence: Number(coherence.toFixed(6)),
    contingency: Number(contingency.toFixed(6)),
    telemetry_events: count,
    anchor_variants: anchors.size,
    session_variants: sessions.size
  };
}

export function resolveIntelligenceStream({ db, accountId, sessionId = null }){
  if(!accountId) return null;
  if(sessionId){
    return db.prepare(`
      SELECT * FROM ndsp_intelligence_streams
      WHERE account_id=? AND session_id=?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(accountId, sessionId) || null;
  }
  return db.prepare(`
    SELECT * FROM ndsp_intelligence_streams
    WHERE account_id=? AND session_id IS NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(accountId) || null;
}

export function createIntelligenceStream({ db, accountId, sessionId = null, anchorAssetId = DEFAULT_ANCHOR_ID, monitoringPolicy = {}, encryptedStateJson = null, status = "active" }){
  const existing = resolveIntelligenceStream({ db, accountId, sessionId });
  if(existing) return { stream: existing, created: false };
  const id = `str_${nanoid(18)}`;
  db.prepare(`
    INSERT INTO ndsp_intelligence_streams (id, account_id, session_id, anchor_asset_id, status, core_version, monitoring_policy_json, encrypted_state_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, accountId, sessionId, anchorAssetId, status, GENESIS_CORE_VERSION, JSON.stringify(monitoringPolicy || {}), encryptedStateJson);
  const stream = db.prepare("SELECT * FROM ndsp_intelligence_streams WHERE id=?").get(id);
  appendStreamEvent({ db, stream, eventType: "stream_created", payload: { anchor_asset_id: anchorAssetId, status } });
  return { stream, created: true };
}

export function appendStreamEvent({ db, stream, eventType, telemetryId = null, invoiceId = null, scores = null, payload = {} }){
  const id = `stre_${nanoid(18)}`;
  db.prepare(`
    INSERT INTO ndsp_intelligence_stream_events (id, stream_id, account_id, session_id, event_type, telemetry_id, invoice_id, scores_json, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, stream.id, stream.account_id, stream.session_id || null, eventType, telemetryId, invoiceId, scores ? JSON.stringify(scores) : null, JSON.stringify(payload || {}));
  return db.prepare("SELECT * FROM ndsp_intelligence_stream_events WHERE id=?").get(id);
}

export function appendTelemetryMonitoringEvent({ db, stream, telemetryId, payload = {} }){
  const telemetryRows = db.prepare(`
    SELECT id, session_id, at, payload_json
    FROM ndsp_telemetry
    WHERE account_id=? AND (? IS NULL OR session_id=?)
    ORDER BY at DESC, id DESC
    LIMIT 100
  `).all(stream.account_id, stream.session_id || null, stream.session_id || null);
  const scores = computeStreamScores({ telemetry: telemetryRows });
  db.prepare("UPDATE ndsp_intelligence_streams SET status='monitoring', last_monitored_at=datetime('now') WHERE id=?").run(stream.id);
  return appendStreamEvent({ db, stream, eventType: "telemetry_ingested", telemetryId, scores, payload });
}

export function bindStreamInvoice({ db, stream, invoiceId, payload = {} }){
  db.prepare("UPDATE ndsp_intelligence_streams SET status='invoice_bound', last_monitored_at=datetime('now') WHERE id=?").run(stream.id);
  appendStreamEvent({ db, stream, eventType: "status_changed", invoiceId, payload: { status: "invoice_bound" } });
  return appendStreamEvent({ db, stream, eventType: "invoice_bound", invoiceId, payload });
}

export function streamLifecycleState({ db, accountId, sessionId = null, anchorAssetId = DEFAULT_ANCHOR_ID, create = true }){
  let result = { stream: resolveIntelligenceStream({ db, accountId, sessionId }), created: false };
  if(!result.stream && create) result = createIntelligenceStream({ db, accountId, sessionId, anchorAssetId });
  if(!result.stream) return null;
  const events = db.prepare(`
    SELECT id, event_type, telemetry_id, invoice_id, scores_json, payload_json, created_at
    FROM ndsp_intelligence_stream_events
    WHERE stream_id=?
    ORDER BY created_at DESC, id DESC
    LIMIT 50
  `).all(result.stream.id);
  return {
    ...result.stream,
    monitoring_policy: parseJson(result.stream.monitoring_policy_json, {}),
    encrypted_state_present: Boolean(result.stream.encrypted_state_json),
    scores: computeStreamScores({ events }),
    events: events.map(event => ({ ...event, scores: parseJson(event.scores_json, null), payload: parseJson(event.payload_json, {}) }))
  };
}

export function generateGenesisInvoiceDraft({ db, accountId, sessionId, days = 7, now = new Date() }){
  const summary = computeSessionSummary(db, sessionId);
  if(!summary) return null;
  if(summary.session.account_id !== accountId) return { forbidden: true };

  const monitoring = genesisRingMonitoring({ db, accountId, sessionId, days, now });
  return {
    schema: "synaptics.genesis.invoice.draft.v1",
    status: "draft",
    generated_at: now.toISOString(),
    account_id: accountId,
    session_id: sessionId,
    seat_id: summary.session.seat_id,
    currency: summary.total.currency || "CAD",
    lines: summary.lines.map(line => ({
      item_id: line.item_id,
      description: line.label,
      seconds: line.seconds,
      live_seconds: line.live_seconds,
      recovery_adjustment_seconds: line.recovery_adjustment_seconds,
      quantity: line.quantity,
      quantity_unit: line.quantity_unit,
      unit_price_cents: line.unit_price.cents,
      line_total_cents: line.cost.cents,
      ring_monitoring: monitoring.rings.map(ring => ({ ring_id: ring.id, anchor_id: ring.anchor_id, status: ring.status }))
    })),
    totals: {
      intelligence_seconds: summary.metrics.intelligence_seconds,
      tracked_quantity: summary.metrics.tracked_quantity,
      subtotal_cents: summary.total.cents,
      total_cents: summary.total.cents,
      total: centsToMoney(summary.total.cents, summary.total.currency || "CAD")
    },
    genesis: monitoring
  };
}
