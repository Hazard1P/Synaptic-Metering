import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";

function loadBackendResolver(){
  const html = readFileSync(new URL("../public/genesis-integrated.html", import.meta.url), "utf8");
  const match = html.match(/function resolveNdspBackend[\s\S]*?window\.__resolveNdspBackend = resolveNdspBackend;[\s\S]*?\n  \}/);
  assert(match, "expected genesis-integrated.html to expose the NDSP backend resolver");

  const sandbox = {
    location: { origin: "https://app.example", pathname: "/genesis", search: "" },
    URL,
    URLSearchParams,
    window: {}
  };
  vm.runInNewContext(match[0], sandbox);
  return sandbox.window.__resolveNdspBackend;
}

function loc({ origin = "https://app.example", pathname = "/genesis", search = "" } = {}){
  return { origin, pathname, search };
}

describe("Genesis integrated backend resolver", () => {
  it("defaults to offline mode when no backend query parameter is present", () => {
    const resolveNdspBackend = loadBackendResolver();

    assert.equal(resolveNdspBackend(loc()), "");
  });

  it("keeps same-origin backend mode off outside the intended /genesis app route", () => {
    const resolveNdspBackend = loadBackendResolver();

    assert.equal(resolveNdspBackend(loc({ pathname: "/public/genesis-integrated.html", search: "?backend=same-origin" })), "");
  });

  it("enables same-origin backend mode only on the intended /genesis app route", () => {
    const resolveNdspBackend = loadBackendResolver();

    assert.equal(resolveNdspBackend(loc({ search: "?backend=same-origin" })), "https://app.example");
  });

  it("accepts explicit http or https backend URLs and strips path/query/hash", () => {
    const resolveNdspBackend = loadBackendResolver();

    assert.equal(
      resolveNdspBackend(loc({ search: "?backend=https%3A%2F%2Fbackend.example%2Fndsp%3Fx%3D1%23frag" })),
      "https://backend.example"
    );
  });

  it("treats off, invalid URLs, and unsupported URL schemes as offline mode", () => {
    const resolveNdspBackend = loadBackendResolver();

    assert.equal(resolveNdspBackend(loc({ search: "?backend=off" })), "");
    assert.equal(resolveNdspBackend(loc({ search: "?backend=not-a-url" })), "");
    assert.equal(resolveNdspBackend(loc({ search: "?backend=javascript%3Aalert(1)" })), "");
  });
});
