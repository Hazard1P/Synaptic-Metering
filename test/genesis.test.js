import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeStreamMetrics, genesisEntropticSettings, genesisRingMonitoring, genesisRoadmap, genesisStringIntelligence, genesisTechnicalStructure, generateGenesisInvoiceDraft, relativeDaySchedule } from "../src/lib/genesis.js";

function makeDb(){
  const telemetryRows = [];
  const sessions = new Map([["sess_1", { id: "sess_1", account_id: "acct_1", seat_id: "seat-a", status: "open", created_at: "2026-07-11 00:00:00", closed_at: null, current_item_id: "item_seconds", current_item_started_at: null }]]);
  const catalog = [{ id: "item_seconds", label: "Metered Intelligence", unit_price_cents: 5, currency: "CAD", default_qty: 0, unit_name: "second", quantity_mode: "seconds", auto_increment_by: 1, version: "test", active: 1 }];
  const usage = [{ item_id: "item_seconds", seconds: 3, live_seconds: 2, recovery_adjustment_seconds: 1 }];
  const usageEvents = [
    { id: "u_1", seconds: 1, event_kind: "live_tick", heartbeat_event_timestamp: "2026-07-11T12:00:00Z", heartbeat_tick_sequence: 1, at: "2026-07-11 12:00:00" },
    { id: "u_2", seconds: 1, event_kind: "live_tick", heartbeat_event_timestamp: "2026-07-11T12:00:01Z", heartbeat_tick_sequence: 2, at: "2026-07-11 12:00:01" },
    { id: "u_3", seconds: 1, event_kind: "recovery_adjustment", heartbeat_event_timestamp: null, heartbeat_tick_sequence: null, at: "2026-07-11 12:00:02" }
  ];
  const metricRows = [];
  return {
    addTelemetry(row){ telemetryRows.push(row); },
    setUsageEvents(rows){ usageEvents.splice(0, usageEvents.length, ...rows); },
    metricRows,
    prepare(sql){
      if(sql.includes("FROM ndsp_telemetry")) return { all: () => telemetryRows };
      if(sql.includes("FROM sessions WHERE id=?")) return { get: id => sessions.get(id) || null };
      if(sql.includes("FROM catalog_items WHERE active = 1")) return { all: () => catalog };
      if(sql.includes("FROM usage_events") && sql.includes("GROUP BY item_id")) return { all: () => usage };
      if(sql.includes("FROM usage_events")) return { all: () => usageEvents };
      if(sql.includes("FROM anchored_assets")) return { get: () => null, all: () => [] };
      if(sql.includes("FROM map_assets")) return { get: () => null };
      if(sql.includes("INSERT INTO ndsp_stream_metrics")) return { run: (...args) => metricRows.push(args) };
      throw new Error(`unexpected SQL: ${sql}`);
    }
  };
}

describe("Genesis account sync", () => {
  it("builds relative day windows from today into future corresponding days", () => {
    const days = relativeDaySchedule({ start: new Date("2026-07-11T12:00:00Z"), days: 3 });
    assert.deepEqual(days.map(day => day.service_day), ["2026-07-11", "2026-07-12", "2026-07-13"]);
    assert.equal(days[0].label, "today");
    assert.equal(days[1].label, "today+1");
  });

  it("syncs ring telemetry ports with Genesis string intelligence", () => {
    const db = makeDb();
    db.addTelemetry({ id: "t_1", session_id: "sess_1", at: "2026-07-11 12:00:00", payload_json: JSON.stringify({ ring_id: "ring-1", genesis_string: "Alpha Ring" }) });
    const sync = genesisRingMonitoring({ db, accountId: "acct_1", sessionId: "sess_1", now: new Date("2026-07-11T12:00:00Z"), days: 2 });
    assert.equal(sync.telemetry_ports.length, 5);
    assert.equal(sync.rings[0].status, "telemetry_synced");
    assert.equal(sync.rings[0].string_intelligence.normalized, "Alpha Ring");
    assert.equal(sync.rings[0].string_intelligence.system, "NDSP Genesis v3.0 string intelligence");
    assert.equal(sync.rings[0].entroptic_settings.window_ticks, 42);
    assert.equal(sync.entroptic_settings.mode, "anchored_relevancy_refinement");
    assert.equal(sync.day_schedule[1].service_day, "2026-07-12");
    assert.equal(sync.latest_metrics.stream_id, "sess_1");
    assert.ok(sync.latest_metrics.coherence >= 0);
    assert.equal(sync.segments.schema, "synaptics.ndsp.genesis.segments.v1");
    assert.equal(typeof sync.segments.coherence.score, "number");
  });

  it("scores string intelligence against anchored relevancy without extracting anchors", () => {
    const relevancy = { day_index: 20645, seconds_into_day: 43200, seconds_remaining: 43199, discrepancy_basis: "unix_daily_24_hour_alignment" };
    const settings = genesisEntropticSettings({ relevancy });
    const intelligence = genesisStringIntelligence("  Alpha   Ring  ", { anchorId: "dyson-sphere-ring-1", relevancy });
    assert.equal(settings.schema, "synaptics.ndsp.genesis.entroptic-settings.v1");
    assert.equal(settings.weights.c_load, 0.26);
    assert.equal(settings.relevancy_anchor.day_index, 20645);
    assert.equal(intelligence.normalized, "Alpha   Ring");
    assert.equal(intelligence.anchor_id, "dyson-sphere-ring-1");
    assert.equal(intelligence.relevancy_day_index, 20645);
    assert.ok(intelligence.shannon_entropy_bits_per_symbol > 0);
  });

  it("publishes the v3.0 technical structure and roadmap", () => {
    const structure = genesisTechnicalStructure();
    const roadmap = genesisRoadmap();
    assert.equal(structure.schema, "synaptics.ndsp.genesis.technical-structure.v1");
    assert.equal(structure.rings.length, 5);
    assert.ok(structure.components.some(component => component.id === "technical-structure"));
    assert.ok(structure.components.some(component => component.id === "coherence-segment"));
    assert.ok(structure.components.some(component => component.id === "contingency-segment"));
    assert.ok(structure.components.some(component => component.id === "continuity-segment"));
    assert.ok(structure.data_flows.some(flow => flow.id === "metering-to-invoice"));
    assert.equal(structure.contracts.structure, "GET /genesis/structure");
    assert.equal(roadmap.schema, "synaptics.ndsp.genesis.roadmap.v1");
    assert.equal(roadmap.phases[0].phase, "v3.0-foundation");
  });

  it("generates an invoice draft with ring monitoring attached to line items", () => {
    const db = makeDb();
    const draft = generateGenesisInvoiceDraft({ db, accountId: "acct_1", sessionId: "sess_1", now: new Date("2026-07-11T12:00:00Z") });
    assert.equal(draft.schema, "synaptics.genesis.invoice.draft.v1");
    assert.equal(draft.totals.total_cents, 15);
    assert.equal(draft.lines[0].ring_monitoring.length, 5);
    assert.equal(draft.lines[0].billing_mark.tick_mark, "billed_intelligence_second");
    assert.equal(draft.intelligence_second_ledger.billed_intelligence_seconds, 2);
    assert.equal(draft.genesis.core_version, "NDSP-GENESIS-CORE v3.0.0");
    assert.equal(draft.genesis.account_id, "acct_1");
    assert.equal(draft.genesis.session_id, "sess_1");
    assert.equal(draft.genesis.rings.length, 5);
    assert.equal(draft.genesis.segments.schema, "synaptics.ndsp.genesis.segments.v1");
    assert.equal(draft.genesis.anchor_ids.length, 5);
    assert.equal(typeof draft.genesis.string_intelligence_digests["ring-1"], "string");
    assert.equal(draft.genesis.telemetry_event_counts["ring-1"], 0);
    assert.equal(draft.genesis.latest_telemetry_timestamps["ring-1"], null);
    assert.match(draft.genesis.privacy, /deterministic digests/);
    assert.match(draft.genesis.privacy, /does not store raw thought data/);
  });
});
