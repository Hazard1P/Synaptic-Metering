import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synaptic-invoice-test-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(tempDir, "app.db");
process.env.SQLITE_JOURNAL_MODE = "DELETE";

await import("../src/db/migrate.js");
const { app, getDb } = await import("../src/server.js");
const { computeSessionSummary } = await import("../src/lib/billing.js");

const db = getDb();
const accountId = "acct_test";
const authSessionId = "auth_test";
const otherAccountId = "acct_other";
const sessionId = "sess_test";

db.prepare("INSERT INTO accounts (id, display_name) VALUES (?, ?)").run(accountId, "Test Account");
db.prepare("INSERT INTO accounts (id, display_name) VALUES (?, ?)").run(otherAccountId, "Other Account");
db.prepare("INSERT INTO auth_sessions (id, account_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))").run(authSessionId, accountId);
db.prepare(`
  INSERT INTO catalog_items (id, label, unit_price_cents, currency, unit_name, quantity_mode, auto_increment_by)
  VALUES (?, ?, ?, 'CAD', 'second', 'seconds', 1)
`).run("compute", "Compute Seconds", 3);
db.prepare("INSERT INTO sessions (id, account_id, seat_id, status) VALUES (?, ?, ?, 'closed')").run(sessionId, accountId, "seat-a");
db.prepare("INSERT INTO usage_events (id, session_id, item_id, seconds) VALUES (?, ?, ?, ?)").run("usage_1", sessionId, "compute", 5);

function invoiceFor(session){
  const summary = computeSessionSummary(db, session);
  return {
    schema: "synaptics.invoice.v1",
    session_id: session,
    account_id: summary.session.account_id,
    seat_id: summary.session.seat_id,
    currency: summary.total.currency,
    lines: summary.lines.map(line => ({
      item_id: line.item_id,
      description: line.label,
      seconds: line.seconds,
      quantity: line.quantity,
      unit_price_cents: line.unit_price.cents,
      line_total_cents: line.cost.cents
    })),
    totals: {
      intelligence_seconds: summary.metrics.intelligence_seconds,
      tracked_quantity: summary.metrics.tracked_quantity,
      subtotal_cents: summary.total.cents,
      total_cents: summary.total.cents
    }
  };
}

async function postImport(invoice, overrides = {}){
  const response = await fetch(`${baseUrl}/invoices/import`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `syn_meter_session=${authSessionId}`
    },
    body: JSON.stringify({ invoice, source: "platform_attachment", ...overrides })
  });
  const json = await response.json();
  return { response, json };
}

const server = app.listen(0);
await once(server, "listening");
const baseUrl = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("accepts matching invoices and stores server-computed fields", async () => {
  const { response, json } = await postImport(invoiceFor(sessionId));
  assert.equal(response.status, 201);
  assert.equal(json.verification.status, "accepted");
  assert.equal(json.verification.checked.mismatches.length, 0);

  const stored = db.prepare("SELECT session_id, status, payload_json FROM invoices WHERE id=?").get(json.invoice.id);
  const payload = JSON.parse(stored.payload_json);
  assert.equal(stored.session_id, sessionId);
  assert.equal(stored.status, "accepted");
  assert.equal(payload.server_computed, true);
  assert.equal(payload.totals.total_cents, 15);
  assert.deepEqual(payload.lines.map(line => line.item_id), ["compute"]);
});

test("rejects tampered totals with mismatch details", async () => {
  const invoice = invoiceFor(sessionId);
  invoice.totals.total_cents = 999;
  const { response, json } = await postImport(invoice);
  assert.equal(response.status, 201);
  assert.equal(json.verification.status, "rejected");
  assert.equal(json.verification.reason, "invoice_payload_mismatch");
  assert.deepEqual(json.verification.checked.mismatches, [{ field: "totals.total_cents", expected: 15, actual: 999 }]);
});

test("rejects tampered account ids", async () => {
  const invoice = invoiceFor(sessionId);
  invoice.account_id = otherAccountId;
  const { response, json } = await postImport(invoice);
  assert.equal(response.status, 201);
  assert.equal(json.verification.status, "rejected");
  assert.equal(json.verification.reason, "invoice_account_mismatch");
  assert.deepEqual(json.verification.checked.accountIds, [otherAccountId]);
});

test("marks missing sessions pending", async () => {
  const invoice = invoiceFor(sessionId);
  invoice.session_id = "sess_missing";
  const { response, json } = await postImport(invoice);
  assert.equal(response.status, 201);
  assert.equal(json.verification.status, "pending");
  assert.equal(json.verification.reason, "no_account_history_match");
  assert.deepEqual(json.verification.checked.missingSessionIds, ["sess_missing"]);
});
