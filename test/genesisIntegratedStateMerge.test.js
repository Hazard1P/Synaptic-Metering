import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";

function loadMergeHelpers(){
  const html = readFileSync(new URL("../public/genesis-integrated.html", import.meta.url), "utf8");
  const match = html.match(/function hasAuthoritativeBackendState[\s\S]*?if\(typeof window !== "undefined"\)\{[\s\S]*?\n  \}/);
  assert(match, "expected genesis-integrated.html to expose NDSP state merge helpers");

  const sandbox = { window: {} };
  vm.runInNewContext(match[0], sandbox);
  return sandbox.window.__ndspStateMerge;
}

describe("Genesis integrated NDSP state merging", () => {
  it("preserves local telemetry when the pulled backend state is an empty placeholder", () => {
    const { mergeBackendState } = loadMergeHelpers();
    const localState = {
      meta: { tick: 7 },
      inputs: { perf: { latency: 0.2 } },
      channels: { c_load: 0.3 },
      derived: { entropyIndex: 0.42, coherence: 98, trend: 0.01, anomalies: [] },
      history: [{ t: 1000, entropy: 0.42 }]
    };
    const placeholderState = {
      meta: { tick: 0 },
      inputs: {},
      channels: {},
      derived: { entropyIndex: 0, coherence: 0, trend: 0, anomalies: [] },
      history: []
    };

    const merged = mergeBackendState(localState, placeholderState);

    assert.equal(merged.inputs, localState.inputs);
    assert.equal(merged.channels, localState.channels);
    assert.equal(merged.derived, localState.derived);
    assert.equal(merged.history, localState.history);
  });

  it("accepts authoritative backend history while preserving missing local sections", () => {
    const { mergeBackendState } = loadMergeHelpers();
    const localState = {
      meta: { tick: 8 },
      inputs: { perf: { latency: 0.2 } },
      channels: { c_load: 0.3 },
      derived: { entropyIndex: 0.42, coherence: 98, trend: 0.01, anomalies: [] },
      history: [{ t: 1000, entropy: 0.42 }]
    };
    const authoritativeState = {
      meta: { tick: 9 },
      history: [{ t: 2000, entropy: 0.55 }]
    };

    const merged = mergeBackendState(localState, authoritativeState);

    assert.deepEqual(merged.history, authoritativeState.history);
    assert.equal(merged.inputs, localState.inputs);
    assert.equal(merged.channels, localState.channels);
    assert.equal(merged.derived, localState.derived);
    assert.equal(merged.meta.tick, 9);
  });
});
