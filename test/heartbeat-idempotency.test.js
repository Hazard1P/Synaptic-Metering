import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const apiKey = "test-api-key";
const dbDir = mkdtempSync(path.join(tmpdir(), "syn-meter-heartbeat-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(dbDir, "app.db");
process.env.API_KEY_DIGESTS = createHash("sha256").update(apiKey).digest("hex");

const migration = spawnSync(process.execPath, ["src/db/migrate.js"], {
  cwd: process.cwd(),
  env: process.env,
  encoding: "utf8"
});
assert.equal(migration.status, 0, migration.stderr || migration.stdout);

const { app, db } = await import("../src/server.js");

function request(server, path, body){
  return fetch(`${server.url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey
    },
    body: JSON.stringify(body)
  }).then(async res => ({ status: res.status, body: await res.json() }));
}

async function withServer(fn){
  const listener = app.listen(0);
  const port = listener.address().port;
  try{
    await fn({ url: `http://127.0.0.1:${port}` });
  }finally{
    await new Promise(resolve => listener.close(resolve));
  }
}

async function createStartedSession(server, itemId = "test-item"){
  db.prepare(`
    INSERT OR IGNORE INTO catalog_items (id, label, unit_price_cents, currency, source)
    VALUES (?, 'Test Item', 100, 'CAD', 'test')
  `).run(itemId);
  const create = await request(server, "/sessions", { seat_id: `seat-${Date.now()}-${Math.random()}` });
  assert.equal(create.status, 201);
  const start = await request(server, `/sessions/${create.body.id}/start`, { item_id: itemId });
  assert.equal(start.status, 200);
  return create.body.id;
}

test("retrying a heartbeat with the same idempotency key returns the original result", async () => {
  await withServer(async server => {
    const sessionId = await createStartedSession(server);
    const first = await request(server, `/sessions/${sessionId}/heartbeat`, {
      idempotency_key: "retry-key-1",
      recovered_seconds: 4
    });
    const retry = await request(server, `/sessions/${sessionId}/heartbeat`, {
      idempotency_key: "retry-key-1",
      recovered_seconds: 4
    });

    assert.equal(first.status, 200);
    assert.equal(retry.status, 200);
    assert.equal(first.body.duplicate, false);
    assert.equal(retry.body.duplicate, true);
    assert.equal(retry.body.added_seconds, first.body.added_seconds);
    assert.deepEqual(retry.body.event_ids, first.body.event_ids);
  });
});

test("duplicate heartbeat identity prevents extra billable seconds", async () => {
  await withServer(async server => {
    const sessionId = await createStartedSession(server);
    await request(server, `/sessions/${sessionId}/heartbeat`, { tick_sequence: 7 });
    await request(server, `/sessions/${sessionId}/heartbeat`, { tick_sequence: 7 });
    await request(server, `/sessions/${sessionId}/heartbeat`, { tick_sequence: 8 });

    const total = db.prepare("SELECT SUM(seconds) AS seconds, COUNT(*) AS count FROM usage_events WHERE session_id=?").get(sessionId);
    assert.equal(Number(total.seconds), 2);
    assert.equal(Number(total.count), 2);
  });
});

test("recovered seconds are accounted once for duplicate event timestamps", async () => {
  await withServer(async server => {
    const sessionId = await createStartedSession(server);
    const payload = { event_timestamp: "2026-06-20T12:00:00.000Z", recovered_seconds: 9 };
    const first = await request(server, `/sessions/${sessionId}/heartbeat`, payload);
    const retry = await request(server, `/sessions/${sessionId}/heartbeat`, payload);

    assert.equal(first.body.added_seconds, 10);
    assert.equal(retry.body.added_seconds, 10);
    assert.equal(retry.body.recovered_seconds, 9);

    const totals = db.prepare(`
      SELECT event_kind, SUM(seconds) AS seconds, COUNT(*) AS count
      FROM usage_events
      WHERE session_id=?
      GROUP BY event_kind
    `).all(sessionId);
    assert.deepEqual(
      totals.map(row => [row.event_kind, Number(row.seconds), Number(row.count)]).sort(),
      [["live_tick", 1, 1], ["recovery_adjustment", 9, 1]]
    );
  });
});
