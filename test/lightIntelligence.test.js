import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLightIntelligenceSegment, normalizeGpsPinpoint } from "../src/lib/lightIntelligence.js";

function fakeDb(){
  return {
    prepare(sql){
      if(sql.includes("FROM account_identities")){
        return { get: () => ({ provider_name: "google", provider_subject: "google-sub-1", email: "User@Example.COM", email_verified: 1, updated_at: "2026-07-12 00:00:00" }) };
      }
      if(sql.includes("FROM anchored_assets")) return { get: () => null, all: () => [] };
      if(sql.includes("FROM map_assets")) return { get: () => null, all: () => [] };
      return { get: () => null, all: () => [] };
    }
  };
}

describe("light intelligence segment", () => {
  it("normalizes GPS pinpoint values", () => {
    assert.deepEqual(normalizeGpsPinpoint({ lat: 43.6532259, lng: -79.383186, accuracy: 4.567 }), {
      latitude: 43.653226,
      longitude: -79.383186,
      accuracy_meters: 4.57,
      precision: 6
    });
  });

  it("builds a deterministic Dyson Sphere segment from Google account, session, client, GPS, and strings", () => {
    const segment = buildLightIntelligenceSegment({
      db: fakeDb(),
      account: { id: "acct_1", display_name: "User", role: "user" },
      authSessionId: "authsess_123",
      client: "mobile-web",
      gps: { latitude: 43.653225, longitude: -79.383186, accuracy_meters: 5 },
      strings: ["  Dyson   Light  ", "Ring intelligence"],
      now: new Date("2026-07-12T00:00:00Z")
    });

    assert.equal(segment.operation, "Light_Intelligence");
    assert.equal(segment.anchor_id, "dyson-sphere-ring-1");
    assert.equal(segment.client, "mobile-web");
    assert.equal(segment.account.google_identity.email_domain, "example.com");
    assert.equal(segment.account.google_identity.subject_hash.length, 64);
    assert.equal(segment.session_key_hash.length, 64);
    assert.deepEqual(segment.strings_of_intelligence, ["Dyson Light", "Ring intelligence"]);
    assert.equal(segment.privacy.raw_google_subject, "not_returned");
  });
});
