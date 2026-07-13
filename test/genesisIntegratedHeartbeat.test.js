import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";

function loadHeartbeatHelpers(){
  const html = readFileSync(new URL("../public/genesis-integrated.html", import.meta.url), "utf8");
  const match = html.match(/function heartbeatSequenceStorageKey[\s\S]*?if\(typeof window !== "undefined"\)\{[\s\S]*?\n  \}/);
  assert(match, "expected genesis-integrated.html to expose heartbeat helpers");

  const sandbox = {
    Date,
    Number,
    String,
    encodeURIComponent,
    sessionStorage: memoryStorage(),
    window: {}
  };
  vm.runInNewContext(match[0], sandbox);
  return sandbox.window.__synHeartbeatHelpers;
}

function memoryStorage(){
  const values = new Map();
  return {
    getItem(key){
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value){
      values.set(key, String(value));
    }
  };
}

describe("Genesis integrated heartbeat sequencing", () => {
  it("builds backend-compatible one-second heartbeat identities", () => {
    const { heartbeatPayload } = loadHeartbeatHelpers();
    const payload = heartbeatPayload("sess:abc", 42, new Date("2026-07-13T12:00:00.000Z"));

    assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
      seconds: 1,
      event_timestamp: "2026-07-13T12:00:00.000Z",
      tick_sequence: 42,
      idempotency_key: "sess:abc:42"
    });
  });

  it("does not advance the persisted sequence until a heartbeat is accepted", () => {
    const { markHeartbeatAccepted, nextHeartbeatSequence } = loadHeartbeatHelpers();
    const storage = memoryStorage();
    const sessionId = "session/reload-safe";

    const pendingSequence = nextHeartbeatSequence(sessionId, storage);
    assert.equal(pendingSequence, 1);
    assert.equal(nextHeartbeatSequence(sessionId, storage), 1);

    markHeartbeatAccepted(sessionId, pendingSequence, storage);

    assert.equal(nextHeartbeatSequence(sessionId, storage), 2);
  });
});
