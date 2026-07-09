import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deterministicTickId,
  intelligenceTickContext
} from "../src/lib/anchoredIntelligence.js";

describe("deterministic metering context", () => {
  it("returns repeatable deterministic tick IDs for the same anchor and Unix second", () => {
    const now = new Date("2026-07-09T12:34:56.789Z");

    const first = intelligenceTickContext({ anchorId: "dyson-sphere-ring-1", now });
    const second = intelligenceTickContext({ anchorId: "dyson-sphere-ring-1", now });

    assert.equal(first.deterministic_tick_id, second.deterministic_tick_id);
    assert.equal(first.deterministic_tick_id.length, 64);
    assert.deepEqual(first.deterministic_tick_basis, {
      anchor_id: "dyson-sphere-ring-1",
      now_unix: 1783600496,
      epoch_index: 4128,
      tick_rate_hz: 1
    });
    assert.equal(first.deterministic_tick_id, deterministicTickId({
      anchorId: "dyson-sphere-ring-1",
      nowUnix: 1783600496,
      epochIndex: 4128,
      tickRateHz: 1
    }));
  });

  it("changes deterministic tick IDs when the Unix second or anchor changes", () => {
    const base = intelligenceTickContext({ anchorId: "dyson-sphere-ring-1", now: new Date("2026-07-09T12:34:56.000Z") });
    const nextSecond = intelligenceTickContext({ anchorId: "dyson-sphere-ring-1", now: new Date("2026-07-09T12:34:57.000Z") });
    const differentAnchor = intelligenceTickContext({ anchorId: "major-ursa", now: new Date("2026-07-09T12:34:56.000Z") });

    assert.notEqual(base.deterministic_tick_id, nextSecond.deterministic_tick_id);
    assert.notEqual(base.deterministic_tick_id, differentAnchor.deterministic_tick_id);
  });
});
