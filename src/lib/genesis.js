import { createHash } from "node:crypto";
import { centsToMoney, computeSessionSummary } from "./billing.js";
import { intelligenceTickContext, mapDatabaseStatus } from "./anchoredIntelligence.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ANCHOR_ID = "dyson-sphere-ring-1";
const GENESIS_RINGS = Object.freeze([
  { id: "ring-1", anchor_id: "dyson-sphere-ring-1", telemetry_port: "ndsp.telemetry.ring_1", role: "physical_map_database" },
  { id: "ring-2", anchor_id: "fabric-universe-ring-map", telemetry_port: "ndsp.telemetry.ring_2", role: "fabric_universe_ring_map" },
  { id: "ring-3", anchor_id: "major-ursa", telemetry_port: "ndsp.telemetry.ring_3", role: "governance_daily_alignment" }
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

export function genesisStringIntelligence(value){
  const source = String(value || "");
  const normalized = source.normalize("NFKC").trim();
  const tokens = normalized ? normalized.split(/\s+/) : [];
  return {
    normalized,
    length: normalized.length,
    token_count: tokens.length,
    digest: createHash("sha256").update(normalized).digest("hex"),
    monitoring_basis: "normalized_genesis_string_sha256"
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
    return {
      ...ring,
      ordinal: index + 1,
      status: ringTelemetry.length ? "telemetry_synced" : "awaiting_telemetry",
      telemetry_events: ringTelemetry.length,
      latest_telemetry_at: ringTelemetry[0]?.at || null,
      string_intelligence: genesisStringIntelligence(monitoredString),
      intelligence: intelligenceTickContext({ db, anchorId: ring.anchor_id, now }),
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
    rings
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
