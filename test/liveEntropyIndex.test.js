import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ANCHORED_ASSET_MAP } from "../src/lib/anchoredIntelligence.js";
import { buildEntropyAnchor, buildLiveEntropyIndex } from "../src/lib/liveEntropyIndex.js";

function fakeDb(){
  return {
    prepare(sql){
      if(sql.includes("FROM anchored_assets")) return { get: () => null, all: () => [] };
      if(sql.includes("FROM map_assets")) return { get: () => null, all: () => [] };
      return { get: () => null, all: () => [] };
    }
  };
}

describe("live entropy index", () => {
  it("registers its own build anchor", () => {
    assert.equal(ANCHORED_ASSET_MAP["live-entropy-index"].role, "live_string_intelligence_entropy_reference");
    assert.equal(ANCHORED_ASSET_MAP["live-entropy-index"].tick_rate_hz, 1);
  });

  it("builds deterministic entropy components for a string of intelligence", () => {
    const now = new Date("2026-07-12T00:00:00Z");
    const first = buildLiveEntropyIndex({
      db: fakeDb(),
      strings: ["  Alpha    Intelligence ", "Beta"],
      now
    });
    const second = buildLiveEntropyIndex({
      db: fakeDb(),
      strings: ["Alpha Intelligence", "Beta"],
      now
    });

    assert.equal(first.schema, "synaptics.intelligence.live-entropy-index.v1");
    assert.equal(first.anchor_id, "live-entropy-index");
    assert.equal(first.build_anchor.operation, "Live_Entropy_Index_Build_Anchor");
    assert.equal(first.live_entropy_index, second.live_entropy_index);
    assert.equal(first.build_anchor.id, second.build_anchor.id);
    assert.deepEqual(first.strings_of_intelligence, ["Alpha Intelligence", "Beta"]);
    assert.equal(first.components.entropy_model, "shannon_bits_per_symbol");
    assert.ok(first.live_entropy_index > 0);
  });

  it("builds a standalone anchor from an existing tick context", () => {
    const anchor = buildEntropyAnchor({ strings: ["signal"], now: new Date("2026-07-12T00:00:00Z") });
    assert.equal(anchor.anchor_id, "live-entropy-index");
    assert.equal(anchor.strings_digest.length, 64);
    assert.equal(anchor.id.length, 64);
  });
});
