import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { nanoid } from "nanoid";

import { openDb } from "./db/db.js";
import {
  googleOAuthCallback,
  loadAuthenticatedAccount,
  logout,
  requireAccount,
  requireApiKeyOrAccount,
  startGoogleOAuth
} from "./lib/auth.js";
import { refreshCatalog } from "./lib/catalog.js";
import { computeSessionSummary } from "./lib/billing.js";
import { intelligenceTickContext, listAnchoredAssets } from "./lib/anchoredIntelligence.js";
import {
  lookupIntelligenceNetworkKey,
  upsertIntelligenceNetworkKey
} from "./lib/intelligenceNetworkKeys.js";
import { verifyInvoiceForAccount } from "./lib/invoiceVerification.js";
import { CreateSessionBody, StartBody, HeartbeatBody, ImportInvoiceBody, MasterKeyBody, parseBody } from "./lib/validate.js";
import { loadOwnedSession, requireScope } from "./lib/authorization.js";

const app = express();
let dbInstance;

function getDb(){
  if(!dbInstance){
    dbInstance = openDb();
  }
  return dbInstance;
}

const db = new Proxy({}, {
  get(_target, prop){
    const activeDb = getDb();
    const value = activeDb[prop];
    return typeof value === "function" ? value.bind(activeDb) : value;
  }
});

function parseCsvEnv(value){
  return (value || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

function corsOptions(){
  const configuredOrigins = new Set(parseCsvEnv(process.env.CORS_ORIGINS));
  const isProduction = process.env.NODE_ENV === "production";
  const devOrigins = new Set([
    "http://localhost:8080",
    "http://127.0.0.1:8080"
  ]);

  return {
    origin(origin, callback){
      // Non-browser callers (curl, server-to-server health checks) do not send Origin.
      if(!origin) return callback(null, true);

      const allowed = configuredOrigins.has(origin) || (!isProduction && configuredOrigins.size === 0 && devOrigins.has(origin));
      if(allowed) return callback(null, true);

      const err = new Error("CORS origin not allowed");
      err.status = 403;
      return callback(err);
    }
  };
}

function trustProxyValue(){
  const value = (process.env.TRUST_PROXY || "").trim().toLowerCase();
  if(["1", "true", "yes"].includes(value)) return true;
  if(["0", "false", "no", ""].includes(value)) return false;
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : value;
}

const trustProxySetting = trustProxyValue();

function enforceHttpsInProduction(req, res, next){
  if(process.env.NODE_ENV !== "production") return next();

  const forwardedProto = String(req.header("x-forwarded-proto") || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const forwardedHttps = Boolean(trustProxySetting) && forwardedProto === "https";
  const isHttps = req.secure || forwardedHttps;

  if(isHttps) return next();

  return res.status(426).json({ error: "https_required" });
}

app.set("trust proxy", trustProxySetting);

// --- middleware
app.use(enforceHttpsInProduction);
app.use(helmet());
app.use(cors(corsOptions()));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("tiny"));
app.use(rateLimit({ windowMs: 60_000, max: 240 })); // 240 req/min default

import path from "path";
import fs from "fs";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

// --- static (branding + landing)
app.use("/public", express.static(path.join(__dirname, "..", "public")));
app.use("/templates", express.static(path.join(__dirname, "..", "templates")));
app.get("/console", (req,res)=>{
  const p = path.join(__dirname, "public", "console.html");
  if(fs.existsSync(p)) return res.type("html").send(fs.readFileSync(p, "utf-8"));
  res.type("text").send("Console not found");
});

app.get("/", (req,res)=>{
  const p = path.join(__dirname, "public", "index.html");
  // if packaged differently, fall back to a minimal text response
  if(fs.existsSync(p)) return res.type("html").send(fs.readFileSync(p, "utf-8"));
  res.type("text").send("Synaptics.Systems Seconds Metering API");
});


app.get("/genesis", (req,res)=>{
  const p = path.join(__dirname, "..", "public", "genesis-integrated.html");
  if(fs.existsSync(p)) return res.type("html").send(fs.readFileSync(p, "utf-8"));
  res.status(404).type("text").send("Genesis page not found");
});

// --- health (public)
app.get("/health", (req,res)=>res.json({ ok:true, service:"synaptics-seconds-api", ts:new Date().toISOString() }));

app.get("/intelligence/anchors", (req,res)=>{
  res.json({
    operation: "Seconds_Of_Intelligence",
    tick_rate_hz: 1,
    assets: listAnchoredAssets(db),
    epoch: intelligenceTickContext({ db }).five_day_epoch
  });
});

// --- Google OAuth + account sessions
app.use(loadAuthenticatedAccount(db));
app.get("/auth/google/start", startGoogleOAuth);
app.get("/auth/google/callback", googleOAuthCallback(db));
app.post("/auth/logout", logout(db));
app.get("/me", requireAccount, (req,res)=>{
  const identities = db.prepare(`
    SELECT provider_name, provider_subject, email, email_verified, created_at, updated_at
    FROM account_identities
    WHERE account_id=?
    ORDER BY provider_name
  `).all(req.authAccount.id);
  res.json({ account: req.authAccount, identities });
});

const ACCOUNT_ROLES = new Set(["user", "admin"]);

app.get("/admin/accounts", requireApiKeyOrAccount, (req,res,next)=>{
  try{
    requireAdmin(req);
    const rows = db.prepare(`
      SELECT id, display_name, role, created_at, updated_at
      FROM accounts
      ORDER BY created_at DESC, id DESC
    `).all();
    res.json({ accounts: rows });
  }catch(e){ next(e); }
});

app.patch("/admin/accounts/:id/role", requireApiKeyOrAccount, (req,res,next)=>{
  try{
    requireAdmin(req);
    const role = typeof req.body?.role === "string" ? req.body.role.trim() : "";
    if(!ACCOUNT_ROLES.has(role)){
      return res.status(400).json({ error: "invalid_role", allowed_roles: [...ACCOUNT_ROLES] });
    }

    const account = db.prepare("SELECT id, display_name, role, created_at, updated_at FROM accounts WHERE id=?").get(req.params.id);
    if(!account) return res.status(404).json({ error: "account_not_found" });

    db.prepare("UPDATE accounts SET role=?, updated_at=datetime('now') WHERE id=?").run(role, req.params.id);
    const updated = db.prepare("SELECT id, display_name, role, created_at, updated_at FROM accounts WHERE id=?").get(req.params.id);
    res.json({ account: updated });
  }catch(e){ next(e); }
});

app.get("/admin/accounts/:id/identities", requireApiKeyOrAccount, (req,res,next)=>{
  try{
    requireAdmin(req);
    const account = db.prepare("SELECT id, display_name, role, created_at, updated_at FROM accounts WHERE id=?").get(req.params.id);
    if(!account) return res.status(404).json({ error: "account_not_found" });

    const identities = db.prepare(`
      SELECT id, account_id, provider_name, provider_subject, email, email_verified, created_at, updated_at
      FROM account_identities
      WHERE account_id=?
      ORDER BY provider_name, created_at DESC, id DESC
    `).all(req.params.id);
    res.json({ account, identities });
  }catch(e){ next(e); }
});

app.get("/admin/account-identities", requireApiKeyOrAccount, (req,res,next)=>{
  try{
    requireAdmin(req);
    const identities = db.prepare(`
      SELECT i.id, i.account_id, a.display_name, a.role, i.provider_name, i.provider_subject,
        i.email, i.email_verified, i.created_at, i.updated_at
      FROM account_identities i
      JOIN accounts a ON a.id = i.account_id
      ORDER BY i.updated_at DESC, i.id DESC
    `).all();
    res.json({ identities });
  }catch(e){ next(e); }
});

// --- auth for everything else
app.use((req,res,next)=>{ res.setHeader('X-Synaptics-Systems','seconds-metering-api'); next(); });
app.use((req,res,next)=>{
  if(req.path === "/health" || req.path === "/" || req.path === "/genesis" || req.path.startsWith("/public")) return next();
  return requireApiKeyOrAccount(req,res,next);
});


function canAccessMeteringSession(req, sess){
  if(req.apiKeyAuthenticated) return true;
  return Boolean(req.authAccount && sess?.account_id === req.authAccount.id);
}

function rejectForbiddenSession(res){
  return res.status(403).json({ error:"session_forbidden" });
}

function requireAdmin(req){
  if(req.apiKeyAuthenticated) return;
  if(req.authAccount?.role === "admin") return;
  const err = new Error("admin_required");
  err.status = 403;
  throw err;
}

// --- catalog
app.get("/catalog", (req,res,next)=>{
  try{
    requireScope(req, "catalog:read");
    const rows = db.prepare("SELECT id, label, unit_price_cents, currency, source, default_qty, unit_name, quantity_mode, auto_increment_by FROM catalog_items ORDER BY id").all();
    res.json({ items: rows });
  }catch(e){ next(e); }
});

app.post("/catalog/refresh", (req,res,next)=>{
  try{
    requireScope(req, "catalog:write");
    const rows = refreshCatalog(db);
    res.json({ ok:true, items: rows });
  }catch(e){ next(e); }
});

app.get("/intelligence/state", (req,res,next)=>{
  try{
    requireScope(req, "intelligence:read");
    const requestedAnchorId = req.query?.anchor_id || "major-ursa";
    const invoiceKey = req.query?.invoice_key || req.query?.a1 || null;
    const masterKey = req.query?.master_key || null;
    const providedKeys = [invoiceKey, masterKey].filter(Boolean);
    if(providedKeys.length > 1) return res.status(400).json({ error: "single_network_key_required" });

    let keyRecord = null;
    if(invoiceKey){
      keyRecord = lookupIntelligenceNetworkKey(db, { keyKind: "invoice_key", keyLabel: invoiceKey });
    }else if(masterKey){
      keyRecord = lookupIntelligenceNetworkKey(db, { keyKind: "master_key", keyLabel: masterKey });
    }

    if((invoiceKey || masterKey) && !keyRecord) return res.status(404).json({ error: "network_key_not_found" });

    const anchorId = keyRecord?.anchor_asset_id || requestedAnchorId;
    res.json({
      context: intelligenceTickContext({ db, anchorId, invoiceKey, masterKey }),
      confirmed_status: masterKey ? "network_confirmed" : (invoiceKey ? "invoice_key_confirmed" : "anchor_confirmed"),
      moderation: "business_regulated_light_intelligence"
    });
  }catch(e){ next(e); }
});

app.post("/admin/intelligence/master-keys", (req,res,next)=>{
  try{
    requireScope(req, "intelligence:write");
    requireAdmin(req);
    const body = parseBody(MasterKeyBody, req.body);
    const key = upsertIntelligenceNetworkKey(db, {
      keyKind: "master_key",
      keyLabel: body.key_label,
      accountId: body.account_id ?? null,
      invoiceId: null,
      anchorAssetId: body.anchor_asset_id,
      status: body.status
    });
    res.status(201).json({ key });
  }catch(e){ next(e); }
});

// --- sessions
app.post("/sessions", (req,res,next)=>{
  try{
    requireScope(req, "sessions:write");
    const body = parseBody(CreateSessionBody, req.body);
    const accountId = req.authAccount?.id ?? null;
    const id = "sess_" + nanoid(16);
    db.prepare(`
      INSERT INTO sessions (id, account_id, seat_id, status)
      VALUES (?, ?, ?, 'open')
    `).run(id, accountId, body.seat_id ?? null);
    res.status(201).json({ id, status:"open", account_id: accountId, intelligence: intelligenceTickContext({ db, anchorId: "major-ursa" }) });
  }catch(e){ next(e); }
});

app.post("/sessions/:id/start", (req,res,next)=>{
  try{
    const sessionId = req.params.id;
    const body = parseBody(StartBody, req.body);

    const sess = db.prepare("SELECT * FROM sessions WHERE id=?").get(sessionId);
    if(!sess) return res.status(404).json({ error:"session_not_found" });
    if(!canAccessMeteringSession(req, sess)) return rejectForbiddenSession(res);
    if(sess.status !== "open") return res.status(409).json({ error:"session_closed" });

    const item = db.prepare("SELECT * FROM catalog_items WHERE id=?").get(body.item_id);
    if(!item) return res.status(404).json({ error:"item_not_found" });

    // stop any current item (idempotent)
    db.prepare(`
      UPDATE sessions
      SET current_item_id=?, current_item_started_at=datetime('now')
      WHERE id=?
    `).run(body.item_id, sessionId);

    res.json({ ok:true, session_id: sessionId, current_item_id: body.item_id });
  }catch(e){ next(e); }
});

app.post("/sessions/:id/heartbeat", (req,res,next)=>{
  try{
    const sessionId = req.params.id;
    const body = parseBody(HeartbeatBody, req.body);

    const sess = db.prepare("SELECT * FROM sessions WHERE id=?").get(sessionId);
    if(!sess) return res.status(404).json({ error:"session_not_found" });
    if(!canAccessMeteringSession(req, sess)) return rejectForbiddenSession(res);
    if(sess.status !== "open") return res.status(409).json({ error:"session_closed" });
    if(!sess.current_item_id) return res.status(409).json({ error:"no_active_item" });

    const evId = "ev_" + nanoid(18);
    db.prepare(`
      INSERT INTO usage_events (id, session_id, item_id, seconds)
      VALUES (?, ?, ?, ?)
    `).run(evId, sessionId, sess.current_item_id, body.seconds);

    res.json({ ok:true, added_seconds: body.seconds, item_id: sess.current_item_id, intelligence: intelligenceTickContext({ db, anchorId: body.anchor_id || "major-ursa" }) });
  }catch(e){ next(e); }
});

app.post("/sessions/:id/stop", (req,res,next)=>{
  try{
    const sessionId = req.params.id;
    const sess = db.prepare("SELECT * FROM sessions WHERE id=?").get(sessionId);
    if(!sess) return res.status(404).json({ error:"session_not_found" });
    if(!canAccessMeteringSession(req, sess)) return rejectForbiddenSession(res);
    if(sess.status !== "open") return res.status(409).json({ error:"session_closed" });

    db.prepare(`
      UPDATE sessions SET current_item_id=NULL, current_item_started_at=NULL
      WHERE id=?
    `).run(sessionId);

    res.json({ ok:true });
  }catch(e){ next(e); }
});

app.post("/sessions/:id/close", (req,res,next)=>{
  try{
    const sessionId = req.params.id;
    const sess = db.prepare("SELECT * FROM sessions WHERE id=?").get(sessionId);
    if(!sess) return res.status(404).json({ error:"session_not_found" });
    if(!canAccessMeteringSession(req, sess)) return rejectForbiddenSession(res);
    if(sess.status !== "open") return res.status(409).json({ error:"already_closed" });

    db.prepare(`
      UPDATE sessions SET status='closed', closed_at=datetime('now'), current_item_id=NULL, current_item_started_at=NULL
      WHERE id=?
    `).run(sessionId);

    res.json({ ok:true, status:"closed" });
  }catch(e){ next(e); }
});

app.get("/sessions/:id/summary", (req,res)=>{
  const summary = computeSessionSummary(db, req.params.id);
  if(!summary) return res.status(404).json({ error:"session_not_found" });
  if(!canAccessMeteringSession(req, summary.session)) return rejectForbiddenSession(res);
  res.json(summary);
});


// --- invoices
app.post("/invoices/from-session", requireAccount, (req,res)=>{
  const { session_id } = req.body || {};
  if(!session_id) return res.status(400).json({ error:"missing_session_id" });
  const summary = computeSessionSummary(db, session_id);
  if(!summary) return res.status(404).json({ error:"session_not_found" });
  if(summary.session.account_id !== req.authAccount.id) return rejectForbiddenSession(res);

  const issued_at = new Date().toISOString();
  const invoice = {
    schema: "synaptics.invoice.v1",
    issued_at,
    session_id,
    account_id: req.authAccount.id,
    seat_id: summary.session.seat_id,
    currency: summary.total.currency || "CAD",
    lines: summary.lines.map(l => ({
      item_id: l.item_id,
      description: l.label,
      seconds: l.seconds,
      quantity: l.quantity,
      quantity_unit: l.quantity_unit,
      auto_increment_by: l.auto_increment_by,
      unit_price_cents: l.unit_price.cents,
      line_total_cents: l.cost.cents
    })),
    intelligence: intelligenceTickContext({ db, anchorId: "major-ursa", invoiceKey: `A1:${session_id}` }),
    network: {
      a1_box_key: `A1:${session_id}`,
      operation: "Seconds_Of_Intelligence",
      master_key_policy: "master_key governs network genesis and is not bound to a single invoice"
    },
    totals: {
      intelligence_seconds: summary.metrics.intelligence_seconds,
      tracked_quantity: summary.metrics.tracked_quantity,
      subtotal_cents: summary.total.cents,
      total_cents: summary.total.cents
    }
  };

  const id = "inv_" + nanoid(18);
  db.prepare(`
    INSERT INTO invoices (
      id, account_id, session_id, source, status, verification_method,
      accepted_at, verified_at, payload_json
    )
    VALUES (?, ?, ?, 'generated', 'accepted', 'generated_from_owned_session', datetime('now'), datetime('now'), ?)
  `).run(id, req.authAccount.id, session_id, JSON.stringify(invoice));

  const key = upsertIntelligenceNetworkKey(db, {
    keyKind: "invoice_key",
    keyLabel: `A1:${session_id}`,
    accountId: req.authAccount.id,
    invoiceId: id,
    anchorAssetId: "major-ursa",
    status: "confirmed"
  });

  res.status(201).json({ id, invoice, key });
});

app.get("/invoices", requireAccount, (req,res)=>{
  const rows = db.prepare(`
    SELECT id, account_id, session_id, source, status, verification_method,
      accepted_at, verified_at, created_at, updated_at, payload_json
    FROM invoices
    WHERE account_id=?
    ORDER BY created_at DESC, id DESC
  `).all(req.authAccount.id);

  res.json({
    invoices: rows.map(row => ({
      id: row.id,
      account_id: row.account_id,
      session_id: row.session_id,
      source: row.source,
      status: row.status,
      verification_method: row.verification_method,
      accepted_at: row.accepted_at,
      verified_at: row.verified_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      invoice: JSON.parse(row.payload_json)
    }))
  });
});


app.post("/invoices/import", requireAccount, (req,res,next)=>{
  try{
    const body = parseBody(ImportInvoiceBody, req.body);
    const payload = body.invoice ?? body.payload;
    const verification = verifyInvoiceForAccount(db, {
      accountId: req.authAccount.id,
      sessionId: body.session_id ?? null,
      payload
    });

    const id = "inv_" + nanoid(18);
    const status = verification.status;
    const verificationMethod = verification.accepted ? verification.verificationMethod : null;
    const invoiceSessionId = verification.accepted
      ? (body.session_id ?? verification.checked?.sessionIds?.[0] ?? null)
      : null;
    const verificationComplete = status !== "pending";

    db.prepare(`
      INSERT INTO invoices (
        id, account_id, source, source_reference, session_id, status, verification_method,
        verified_at, accepted_at, payload_json, created_at, updated_at
      )
      VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        CASE WHEN ? THEN datetime('now') ELSE NULL END,
        CASE WHEN ? THEN datetime('now') ELSE NULL END,
        ?, datetime('now'), datetime('now')
      )
    `).run(
      id,
      req.authAccount.id,
      body.source,
      body.source_reference ?? null,
      invoiceSessionId,
      status,
      verificationMethod,
      verificationComplete ? 1 : 0,
      verification.accepted ? 1 : 0,
      JSON.stringify(payload)
    );

    const invoice = db.prepare("SELECT * FROM invoices WHERE id=? AND account_id=?").get(id, req.authAccount.id);
    res.status(201).json({
      invoice,
      verification: {
        status,
        method: verificationMethod,
        reason: verification.reason,
        checked: verification.checked
      }
    });
  }catch(e){ next(e); }
});

// --- NDSP endpoints (as referenced by the Genesis Core HTML)
app.get("/ndsp/state", (req,res)=>{
  const sessionId = req.query?.session_id || null;
  const summary = sessionId ? computeSessionSummary(db, sessionId) : null;
  if(summary && !canAccessMeteringSession(req, summary.session)) return rejectForbiddenSession(res);
  // A small, stable policy payload. You can extend this later.
  const policy = {
    channelCaps: {
      c_load: [0,1], s_var:[0,1], circ_drift:[0,1], sys_noise:[0,1], env_flux:[0,1]
    },
    tick_rate_hz: 1,
    persistence: "server-db",
    anchored_assets: listAnchoredAssets(db),
    rolling_epoch: intelligenceTickContext({ db }).five_day_epoch
  };

  // Provide a minimal "state" object structure compatible with the UI.
  // (The UI can also run in local mode if this is absent.)
  const state = {
    meta: { tick: 0 },
    inputs: {},
    channels: {},
    derived: { entropyIndex: 0, coherence: 0, trend: 0, anomalies: [] },
    history: []
  };

  res.json({ policy, state, meter: summary ? { session_id: sessionId, intelligence_seconds: summary.metrics.intelligence_seconds, tracked_quantity: summary.metrics.tracked_quantity, total_cents: summary.total.cents, total_amount: summary.total.amount } : null });
});

app.post("/ndsp/telemetry", (req,res,next)=>{
  try{
    requireScope(req, "telemetry:write");
    const id = "t_" + nanoid(18);
    const payload = req.body ?? {};
    const sessionId = payload.session_id || null;
    if(sessionId) loadOwnedSession(db, req, sessionId);
    db.prepare("INSERT INTO ndsp_telemetry (id, account_id, session_id, payload_json) VALUES (?, ?, ?, ?)").run(id, req.auth.accountId, sessionId, JSON.stringify(payload));

    // Echo back a lightweight state acknowledgment
    res.json({ ok:true, id, account_id: req.auth.accountId, session_id: sessionId, state: { meta:{ received:true, at:new Date().toISOString() } } });
  }catch(e){ next(e); }
});

// --- error handler
app.use((err, req, res, next)=>{
  const status = err?.status || 500;
  res.status(status).json({
    error: err?.message || "server_error",
    issues: err?.issues || undefined
  });
});

// --- boot
function boot(){
  // DB schema migrations are executed via `npm run migrate`
  // Keeping runtime boot simple + stable.
  try{
    refreshCatalog(db);
  }catch(e){
    console.warn("Catalog refresh skipped:", e?.message);
  }

  const port = Number(process.env.PORT || 8080);
  app.listen(port, ()=>{
    console.log(`synaptics-seconds-api listening on :${port}`);
    if(process.env.PUBLIC_BASE_URL){
      console.log("PUBLIC_BASE_URL:", process.env.PUBLIC_BASE_URL);
    }
  });
}

if(process.env.SERVERLESS !== "true" && process.env.NODE_ENV !== "test") {
  boot();
}

export { app, db, getDb, boot };
