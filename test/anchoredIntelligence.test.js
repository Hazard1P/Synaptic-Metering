import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dailyUnixRelevancy,
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

  it("returns a deterministic daily Unix relevancy window for a known timestamp", () => {
    const nowUnix = 1783600496;

    assert.deepEqual(dailyUnixRelevancy(nowUnix), {
      window_seconds: 86400,
      day_index: 20643,
      day_start_unix: 1783555200,
      day_end_unix: 1783641599,
      seconds_into_day: 45296,
      seconds_remaining: 41103,
      aligned_anchors: ["major-ursa", "cassiopeia"],
      discrepancy_basis: "unix_daily_24_hour_alignment"
    });
  });

  it("includes the daily Unix relevancy window in intelligence tick context", () => {
    const context = intelligenceTickContext({
      anchorId: "dyson-sphere-ring-1",
      now: new Date("2026-07-09T12:34:56.000Z")
    });

    assert.deepEqual(context.daily_unix_relevancy, dailyUnixRelevancy(1783600496));
    assert.deepEqual(context.daily_unix_relevancy.aligned_anchors, ["major-ursa", "cassiopeia"]);
    assert.ok(context.five_day_epoch);
  });

});
