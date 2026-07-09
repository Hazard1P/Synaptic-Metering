import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MasterKeyBody, parseBody } from "../src/lib/validate.js";

describe("MasterKeyBody validation", () => {
  it("accepts every seeded anchor asset id", () => {
    for(const anchorId of ["major-ursa", "cassiopeia", "isolated-blackholes", "dyson-sphere-ring-1", "fabric-universe-ring-map"]){
      const parsed = parseBody(MasterKeyBody, { key_label: `MK:${anchorId}`, anchor_asset_id: anchorId });
      assert.equal(parsed.anchor_asset_id, anchorId);
    }
  });

  it("rejects unknown anchor asset ids", () => {
    assert.throws(() => parseBody(MasterKeyBody, {
      key_label: "MK:unknown",
      anchor_asset_id: "unknown-anchor"
    }), error => {
      assert.equal(error.message, "validation_error");
      assert.equal(error.status, 400);
      assert(error.issues.some(issue => issue.path === "anchor_asset_id"));
      return true;
    });
  });
});
