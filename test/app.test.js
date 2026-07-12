import assert from "node:assert/strict";
import { before, after, describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { computeSessionSummary } from "../src/lib/billing.js";
import { verifyInvoiceForAccount } from "../src/lib/invoiceVerification.js";
import { validateStartupConfig } from "../src/lib/configValidation.js";
import { ANCHORED_ASSET_MAP, mapDatabaseStatus, resolveAnchoredAsset } from "../src/lib/anchoredIntelligence.js";

const tempDir = mkdtempSync(path.join(tmpdir(), "synaptic-metering-test-"));
const databasePath = path.join(tempDir, "test.sqlite");
const apiKey = "test-api-key";
const apiKeyDigest = createHash("sha256").update(apiKey).digest("hex");

process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = databasePath;
process.env.API_KEY_DIGESTS = apiKeyDigest;
process.env.SQLITE_JOURNAL_MODE = "DELETE";
process.env.FIELD_ENCRYPTION_KEY = "test:" + Buffer.alloc(32, 7).toString("base64");

execFileSync(process.execPath, ["src/db/migrate.js"], {
  cwd: path.resolve(import.meta.dirname, ".."),
  env: process.env,
  stdio: "pipe"
});

const { app, getDb } = await import("../src/server.js");
let server;
let baseUrl;
let db;

function request(pathname, options = {}){
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
}

async function json(response){
  return response.json();
}

function seedAccount(id, role = "user"){
  db.prepare(`
    INSERT INTO accounts (id, display_name, role, created_at, updated_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET role=excluded.role, updated_at=datetime('now')
  `).run(id, id, role);
}

function authCookie(accountId){
  const id = `authsess_${accountId}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  db.prepare("INSERT INTO auth_sessions (id, account_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))")
    .run(id, accountId);
  return `syn_meter_session=${encodeURIComponent(id)}`;
}

function seedCatalogItem(overrides = {}){
  const item = {
    id: "item_seconds",
    label: "Metered Intelligence",
    unit_price_cents: 3,
    currency: "CAD",
    default_qty: 0,
    unit_name: "second",
    quantity_mode: "seconds",
    auto_increment_by: 2,
    ...overrides
  };
  db.prepare(`
    INSERT OR REPLACE INTO catalog_items
      (id, label, unit_price_cents, currency, source, default_qty, unit_name, quantity_mode, auto_increment_by)
    VALUES (?, ?, ?, ?, 'test', ?, ?, ?, ?)
  `).run(item.id, item.label, item.unit_price_cents, item.currency, item.default_qty, item.unit_name, item.quantity_mode, item.auto_increment_by);
  return item;
}

function seedSession({ id = `sess_${Math.random().toString(16).slice(2)}`, accountId = "acct_user", itemId = "item_seconds", live = 2, recovered = 0, status = "open" } = {}){
  db.prepare("INSERT INTO sessions (id, account_id, seat_id, status, current_item_id) VALUES (?, ?, 'seat-a', ?, ?)")
    .run(id, accountId, status, itemId);
  if(live){
    db.prepare("INSERT INTO usage_events (id, session_id, item_id, seconds, event_kind) VALUES (?, ?, ?, ?, 'live_tick')")
      .run(`ev_live_${id}`, id, itemId, live);
  }
  if(recovered){
    db.prepare("INSERT INTO usage_events (id, session_id, item_id, seconds, event_kind) VALUES (?, ?, ?, ?, 'recovery_adjustment')")
      .run(`ev_recovery_${id}`, id, itemId, recovered);
  }
  return id;
}

before(async () => {
  db = getDb();
  seedAccount("acct_user", "user");
  seedAccount("acct_other", "user");
  seedAccount("acct_admin", "admin");
  seedCatalogItem();
  await new Promise(resolve => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});


describe("health route", () => {
  it("keeps JSON liveness responses for API callers", async () => {
    const res = await request("/health", { headers: { accept: "application/json" } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    const body = await json(res);
    assert.equal(body.ok, true);
    assert.equal(body.status, "alive");
  });

  it("renders a browser-friendly health page for the home page action", async () => {
    const res = await request("/health", { headers: { accept: "text/html" } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    const body = await res.text();
    assert.match(body, /Synaptic<\/span> Metering Health/);
    assert.match(body, /Back Home/);
  });
});

describe("computeSessionSummary", () => {
  it("totals live and recovery usage with catalog pricing", () => {
    const sessionId = seedSession({ live: 5, recovered: 3 });
    const summary = computeSessionSummary(db, sessionId);
    assert.equal(summary.metrics.intelligence_seconds, 8);
    assert.equal(summary.metrics.live_tick_seconds, 5);
    assert.equal(summary.metrics.recovery_adjustment_seconds, 3);
    assert.equal(summary.metrics.tracked_quantity, 16);
    assert.equal(summary.total.cents, 48);
    assert.equal(summary.lines[0].quantity, 16);
  });

  it("returns null for a missing session", () => {
    assert.equal(computeSessionSummary(db, "missing"), null);
  });
});

describe("verifyInvoiceForAccount", () => {
  it("accepts invoices tied to account-owned session history", () => {
    const sessionId = seedSession({ accountId: "acct_user", live: 1 });
    const result = verifyInvoiceForAccount(db, {
      accountId: "acct_user",
      payload: { account_id: "acct_user", session_id: sessionId }
    });
    assert.equal(result.accepted, true);
    assert.equal(result.status, "accepted");
    assert.equal(result.verificationMethod, "account_history");
  });

  it("rejects account and session mismatches", () => {
    const otherSessionId = seedSession({ accountId: "acct_other", live: 1 });
    assert.equal(verifyInvoiceForAccount(db, {
      accountId: "acct_user",
      payload: { account_id: "acct_other", session_id: otherSessionId }
    }).reason, "invoice_account_mismatch");
    assert.equal(verifyInvoiceForAccount(db, {
      accountId: "acct_user",
      payload: { account_id: "acct_user", session_id: otherSessionId }
    }).reason, "session_account_mismatch");
  });
});

describe("anchored intelligence defaults", () => {
  it("keeps dyson-sphere-ring-1 as the single default map database anchor", () => {
    const asset = resolveAnchoredAsset(null);

    assert.equal(asset.id, "dyson-sphere-ring-1");
    assert.equal(Object.keys(ANCHORED_ASSET_MAP).filter(id => id === "dyson-sphere-ring-1").length, 1);
    assert.equal(asset.tick_rate_hz, 1);
    assert.equal(asset.permanence, "permanent_anchor");
    assert.equal(asset.physics_role, "map_database_reference_anchor");
    assert.equal(asset.metadata.structure_label, "Dyson-Sphere");
    assert.equal(asset.metadata.anchor_path, "Home-Room/LightBulb-2-Map_Database/Star_Anchor");
    assert.equal(resolveAnchoredAsset(null, "missing-anchor").id, "dyson-sphere-ring-1");
    assert.equal(mapDatabaseStatus().active_anchor_id, "dyson-sphere-ring-1");
    assert.equal(mapDatabaseStatus({ anchorId: "missing-anchor" }).active_anchor_id, "dyson-sphere-ring-1");
  });
});

describe("Google OAuth start", () => {
  it("returns a user-safe configuration message when Google client ID is missing", async () => {
    const originalClientId = process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;

    try{
      const res = await request("/auth/google/start", { redirect: "manual" });
      assert.equal(res.status, 503);
      const body = await json(res);
      assert.equal(body.error, "google_oauth_not_configured");
      assert.equal(body.message, "Google sign-in is not configured for this deployment. Please contact the site administrator.");
      assert(!String(body.message).includes("GOOGLE_CLIENT_ID"));
    }finally{
      if(originalClientId === undefined){
        delete process.env.GOOGLE_CLIENT_ID;
      }else{
        process.env.GOOGLE_CLIENT_ID = originalClientId;
      }
    }
  });
});

describe("validateStartupConfig", () => {
  it("allows non-production configuration without production-only secrets", () => {
    assert.deepEqual(validateStartupConfig({ NODE_ENV: "test" }), { ok: true, issues: [] });
  });

  it("throws detailed production configuration errors", () => {
    assert.throws(() => validateStartupConfig({ NODE_ENV: "production", PUBLIC_BASE_URL: "http://example.test" }), error => {
      assert.equal(error.name, "StartupConfigError");
      assert(error.issues.some(issue => issue.variable === "GOOGLE_CLIENT_ID"));
      assert(error.issues.some(issue => issue.variable === "PUBLIC_BASE_URL"));
      return true;
    });
  });


  it("trusts Vercel forwarded HTTPS in production", () => {
    const script = `
      process.env.NODE_ENV = "production";
      process.env.SERVERLESS = "true";
      process.env.VERCEL = "1";
      process.env.VERCEL_EPHEMERAL_SQLITE_ACK = "true";
      process.env.DATABASE_PATH = "/tmp/synaptic-metering-forwarded-https-test.sqlite";
      const { app } = await import("./src/server.js");
      const server = app.listen(0, async () => {
        try{
          const port = server.address().port;
          const response = await fetch(` + '`http://127.0.0.1:${port}/health`' + `, { headers: { "x-forwarded-proto": "https" } });
          console.log(response.status);
        }finally{
          server.close();
        }
      });
    `;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env },
      encoding: "utf8"
    });
    assert.match(output, /200/);
  });
  it("rejects malformed optional email allowlists", () => {
    assert.throws(() => validateStartupConfig({ NODE_ENV: "test", ADMIN_GOOGLE_EMAILS: "not-an-email" }), /ADMIN_GOOGLE_EMAILS/);
  });
});

describe("map database route", () => {
  it("falls back to the default anchor for a missing requested anchor", async () => {
    const res = await request("/map/database?anchor_id=missing-anchor");
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.map_database.active_anchor_id, "dyson-sphere-ring-1");
    assert.equal(body.map_database.authentication_status, "fallback_anchor_active");
    assert.equal(body.map_database.tick_rate_hz, 1);
  });

  it("returns a degraded map server response when digest seed data is missing", async () => {
    const seededMapAsset = db.prepare("SELECT * FROM map_assets WHERE map_id = ?").get("dyson-sphere-ring-1");
    db.prepare("DELETE FROM map_assets WHERE map_id = ?").run("dyson-sphere-ring-1");

    try{
      const res = await request("/map/server");
      assert.equal(res.status, 200);
      const body = await json(res);
      assert.equal(body.anchor_id, "dyson-sphere-ring-1");
      assert.equal(body.authentication_status, "map_asset_not_seeded");
      assert.match(body.next_step, /npm run migrate/);
      assert.equal(body.map_database.active_anchor_id, "dyson-sphere-ring-1");
      assert.equal(body.canonical_public_urls.map_server, `${baseUrl}/map/server`);
      assert.equal(body.digest, undefined);
      assert.equal(body.authentication, undefined);
    }finally{
      if(seededMapAsset){
        db.prepare(`
          INSERT INTO map_assets (map_id, anchor_asset_id, digest, verification_status, metadata_json, created_at, updated_at)
          VALUES (@map_id, @anchor_asset_id, @digest, @verification_status, @metadata_json, @created_at, @updated_at)
          ON CONFLICT(map_id) DO UPDATE SET
            anchor_asset_id=excluded.anchor_asset_id,
            digest=excluded.digest,
            verification_status=excluded.verification_status,
            metadata_json=excluded.metadata_json,
            created_at=excluded.created_at,
            updated_at=excluded.updated_at
        `).run(seededMapAsset);
      }
    }
  });

  it("preserves digest authentication fields when map server seed data exists", async () => {
    const res = await request("/map/server");
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.match(body.digest, /^[a-f0-9]{64}$/);
    assert.equal(body.verification_status, "verified");
    assert.equal(body.authentication.map_id, "dyson-sphere-ring-1");
    assert.equal(body.authentication.digest, body.digest);
  });
});

describe("session lifecycle routes", () => {
  it("creates, starts, heartbeats, stops, summarizes, and closes a session via API key", async () => {
    const createRes = await request("/sessions", { method: "POST", headers: { "x-api-key": apiKey }, body: JSON.stringify({ seat_id: "seat-route" }) });
    assert.equal(createRes.status, 201);
    const created = await json(createRes);

    assert.equal((await request(`/sessions/${created.id}/start`, { method: "POST", headers: { "x-api-key": apiKey }, body: JSON.stringify({ item_id: "item_seconds" }) })).status, 200);
    const heartbeat = await json(await request(`/sessions/${created.id}/heartbeat`, { method: "POST", headers: { "x-api-key": apiKey }, body: JSON.stringify({ seconds: 1, recovered_seconds: 2 }) }));
    assert.equal(heartbeat.added_seconds, 3);
    assert.equal((await request(`/sessions/${created.id}/stop`, { method: "POST", headers: { "x-api-key": apiKey }, body: "{}" })).status, 200);

    const summary = await json(await request(`/sessions/${created.id}/summary`, { headers: { "x-api-key": apiKey } }));
    assert.equal(summary.metrics.intelligence_seconds, 3);
    assert.equal(summary.metrics.recovery_adjustment_seconds, 2);

    const closeRes = await request(`/sessions/${created.id}/close`, { method: "POST", headers: { "x-api-key": apiKey }, body: "{}" });
    assert.equal(closeRes.status, 200);
    assert.equal((await request(`/sessions/${created.id}/heartbeat`, { method: "POST", headers: { "x-api-key": apiKey }, body: JSON.stringify({ seconds: 1 }) })).status, 409);
  });
});

describe("invoice generation and import", () => {
  it("generates accepted invoices for owned sessions and persists invoice keys", async () => {
    const sessionId = seedSession({ accountId: "acct_user", live: 4 });
    const res = await request("/invoices/from-session", { method: "POST", headers: { cookie: authCookie("acct_user") }, body: JSON.stringify({ session_id: sessionId }) });
    assert.equal(res.status, 201);
    const body = await json(res);
    assert.equal(body.invoice.session_id, sessionId);
    assert.equal(body.invoice.account_id, "acct_user");
    assert.equal(body.invoice.totals.total_cents, 24);
    assert.equal(body.invoice.genesis.core_version, "NDSP-GENESIS-CORE v3.0.0");
    assert.equal(body.invoice.genesis.account_id, "acct_user");
    assert.equal(body.invoice.genesis.session_id, sessionId);
    assert.equal(body.invoice.genesis.rings.length, 5);
    assert.equal(body.invoice.genesis.anchor_ids.includes("dyson-sphere-ring-1"), true);
    assert.equal(typeof body.invoice.genesis.string_intelligence_digests["ring-1"], "string");
    assert.equal(body.invoice.genesis.telemetry_event_counts["ring-1"], 0);
    assert.equal(body.invoice.genesis.latest_telemetry_timestamps["ring-1"], null);
    assert.match(body.invoice.genesis.privacy, /does not store raw thought data/);
    const stored = db.prepare("SELECT payload_json FROM invoices WHERE id=?").get(body.id);
    const storedInvoice = JSON.parse(stored.payload_json);
    assert.deepEqual(storedInvoice.genesis, body.invoice.genesis);
    assert.equal(body.key.key_label, `A1:${sessionId}`);
  });

  it("persists map session keys for invoice history and keeps them unique per invoice", async () => {
    const sessionId = seedSession({ accountId: "acct_user", live: 5 });
    const cookie = authCookie("acct_user");

    const first = await json(await request("/invoices/from-session", { method: "POST", headers: { cookie }, body: JSON.stringify({ session_id: sessionId }) }));
    const second = await json(await request("/invoices/from-session", { method: "POST", headers: { cookie }, body: JSON.stringify({ session_id: sessionId }) }));

    assert.match(first.invoice.map_session_key.session_key_digest, /^[a-f0-9]{64}$/);
    assert.equal(first.invoice.map_session_key.invoice_id, first.id);
    assert.equal(first.invoice.map_session_key.session_id, sessionId);
    assert.equal(first.invoice.map_session_key.anchor_asset_id, "dyson-sphere-ring-1");
    assert.equal(first.invoice.map_session_key.retrieval_route, `/invoices/${first.id}/map-session-key`);
    assert.notEqual(first.invoice.map_session_key.session_key_digest, second.invoice.map_session_key.session_key_digest);

    const keyRes = await request(first.invoice.map_session_key.retrieval_route, { headers: { cookie } });
    assert.equal(keyRes.status, 200);
    const keyBody = await json(keyRes);
    assert.equal(keyBody.map_session_key.session_key_digest, first.invoice.map_session_key.session_key_digest);

    const historyRes = await request(`/sessions/${sessionId}/map-history`, { headers: { cookie } });
    assert.equal(historyRes.status, 200);
    const history = await json(historyRes);
    assert.equal(history.session_id, sessionId);
    assert.equal(history.map_session_keys.length, 2);
    assert.deepEqual(
      new Set(history.map_session_keys.map(key => key.invoice_id)),
      new Set([first.id, second.id])
    );
  });

  it("gates map session key retrieval by account ownership", async () => {
    const sessionId = seedSession({ accountId: "acct_user", live: 1 });
    const ownerCookie = authCookie("acct_user");
    const otherCookie = authCookie("acct_other");
    const created = await json(await request("/invoices/from-session", { method: "POST", headers: { cookie: ownerCookie }, body: JSON.stringify({ session_id: sessionId }) }));

    assert.equal((await request(`/invoices/${created.id}/map-session-key`, { headers: { cookie: otherCookie } })).status, 404);
    assert.equal((await request(`/sessions/${sessionId}/map-history`, { headers: { cookie: otherCookie } })).status, 403);
  });

  it("imports accepted, pending, and rejected invoices according to verification", async () => {
    const sessionId = seedSession({ accountId: "acct_user", live: 1 });
    const cookie = authCookie("acct_user");

    const accepted = await json(await request("/invoices/import", { method: "POST", headers: { cookie }, body: JSON.stringify({ source: "platform_attachment", session_id: sessionId, payload: { account_id: "acct_user", session_id: sessionId } }) }));
    assert.equal(accepted.verification.status, "accepted");
    assert.equal(accepted.invoice.session_id, sessionId);

    const pending = await json(await request("/invoices/import", { method: "POST", headers: { cookie }, body: JSON.stringify({ source: "legacy_upload", payload: { account_id: "acct_user", session_id: "missing-session" } }) }));
    assert.equal(pending.verification.status, "pending");
    assert.equal(pending.invoice.session_id, null);

    const rejected = await json(await request("/invoices/import", { method: "POST", headers: { cookie }, body: JSON.stringify({ source: "legacy_upload", payload: { account_id: "acct_other" } }) }));
    assert.equal(rejected.verification.status, "rejected");
  });
});

describe("admin authorization", () => {
  it("requires admin account or API key for admin-only behavior", async () => {
    const userRes = await request("/admin/intelligence/master-keys", { method: "POST", headers: { cookie: authCookie("acct_user") }, body: JSON.stringify({ key_label: "MK:user-denied" }) });
    assert.equal(userRes.status, 403);

    const adminRes = await request("/admin/intelligence/master-keys", { method: "POST", headers: { cookie: authCookie("acct_admin") }, body: JSON.stringify({ key_label: "MK:admin-allowed" }) });
    assert.equal(adminRes.status, 201);

    const apiKeyRes = await request("/admin/intelligence/master-keys", { method: "POST", headers: { "x-api-key": apiKey }, body: JSON.stringify({ key_label: "MK:api-key-allowed" }) });
    assert.equal(apiKeyRes.status, 201);
  });
});

describe("NDSP intelligence streams", () => {
  function grantTelemetry(accountId){
    db.prepare(`
      INSERT INTO consents (id, account_id, consent_type, version, granted_at, source, created_at, updated_at)
      VALUES (?, ?, 'telemetry', 'test', datetime('now'), 'test', datetime('now'), datetime('now'))
    `).run(`consent_${accountId}_${Date.now()}_${Math.random().toString(16).slice(2)}`, accountId);
  }

  it("persists stream lifecycle state from account sync", async () => {
    const sessionId = seedSession({ id: "sess_stream_persist", accountId: "acct_user", live: 4 });
    const cookie = authCookie("acct_user");
    const res = await request(`/genesis/account-sync?session_id=${encodeURIComponent(sessionId)}`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.stream.account_id, "acct_user");
    assert.equal(body.stream.session_id, sessionId);
    assert.equal(body.stream.status, "active");
    assert.ok(body.stream.events.some(event => event.event_type === "stream_created"));

    const row = db.prepare("SELECT * FROM ndsp_intelligence_streams WHERE account_id=? AND session_id=?").get("acct_user", sessionId);
    assert.equal(row.id, body.stream.id);
  });

  it("rejects cross-account telemetry session misuse", async () => {
    grantTelemetry("acct_user");
    const sessionId = seedSession({ id: "sess_stream_other", accountId: "acct_other", live: 1 });
    const res = await request("/ndsp/telemetry", {
      method: "POST",
      headers: { cookie: authCookie("acct_user") },
      body: JSON.stringify({ session_id: sessionId, ring_id: "ring-1", genesis_string: "wrong account" })
    });
    assert.equal(res.status, 403);
    assert.equal((await json(res)).error, "session_account_forbidden");
  });

  it("links telemetry to the active stream and then binds generated invoices", async () => {
    grantTelemetry("acct_user");
    const sessionId = seedSession({ id: "sess_stream_invoice", accountId: "acct_user", live: 6 });
    const cookie = authCookie("acct_user");

    const telemetryRes = await request("/ndsp/telemetry", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ session_id: sessionId, ring_id: "ring-1", genesis_string: "invoice-linked telemetry", coherence: 92 })
    });
    assert.equal(telemetryRes.status, 200);
    const telemetry = await json(telemetryRes);
    assert.equal(telemetry.stream.status, "monitoring");
    assert.ok(telemetry.stream.events.some(event => event.event_type === "telemetry_ingested" && event.telemetry_id === telemetry.id));

    const invoiceRes = await request("/invoices/from-session", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ session_id: sessionId })
    });
    assert.equal(invoiceRes.status, 201);
    const invoice = await json(invoiceRes);
    assert.equal(invoice.stream.status, "invoice_bound");
    assert.ok(invoice.stream.events.some(event => event.event_type === "invoice_bound" && event.invoice_id === invoice.id));
  });
});
