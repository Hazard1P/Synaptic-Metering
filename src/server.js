import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { nanoid } from "nanoid";

import { openDb } from "./db/db.js";
import {
  configureApiKeyAuth,
  createAuthSession,
  googleOAuthCallback,
  loadAuthenticatedAccount,
  logout,
  requireAccount,
  requireApiKeyOrAccount,
  startGoogleOAuth
} from "./lib/auth.js";
import { refreshCatalog } from "./lib/catalog.js";
import { computeSessionSummary } from "./lib/billing.js";
import { MAP_DATABASE_METADATA, intelligenceTickContext, listAnchoredAssets, mapDatabaseStatus } from "./lib/anchoredIntelligence.js";
import { buildLightIntelligenceSegment } from "./lib/lightIntelligence.js";
import { buildLiveEntropyIndex } from "./lib/liveEntropyIndex.js";
import { normalizedServerInvoicePayload, verifyInvoiceForAccount } from "./lib/invoiceVerification.js";
import { authenticateStoredMapAsset } from "./lib/mapAuthentication.js";
import { lookupIntelligenceNetworkKey, upsertIntelligenceNetworkKey } from "./lib/intelligenceNetworkKeys.js";
import { CreateSessionBody, StartBody, HeartbeatBody, ImportInvoiceBody, MasterKeyBody, parseBody } from "./lib/validate.js";
import { loadOwnedSession, requireScope } from "./lib/authorization.js";
import { validateStartupConfig } from "./lib/configValidation.js";
import { generateGenesisInvoiceDraft, genesisEntropticSettings, genesisInvoiceEvidence, genesisRingMonitoring, genesisRoadmap, genesisTechnicalStructure } from "./lib/genesis.js";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationAssertion,
  verifyRegistrationResponse
} from "./lib/webauthn.js";

let startupConfigStatus = { ok: true, issues: [] };
try{
  startupConfigStatus = validateStartupConfig();
}catch(e){
  startupConfigStatus = { ok: false, issues: e?.issues || [], error: e?.message || "startup_config_invalid" };
  if(process.env.NODE_ENV === "production"){
    console.warn(JSON.stringify({
      ts: new Date().toISOString(),
      level: "warn",
      event: "startup_config_degraded",
      service: "synaptics-seconds-api",
      error: startupConfigStatus.error,
      issues: startupConfigStatus.issues
    }));
  }else{
    throw e;
  }
}

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

configureApiKeyAuth(db);


function logJson(level, event, fields = {}){
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    service: "synaptics-seconds-api",
    ...fields
  };
  const line = JSON.stringify(entry);
  if(level === "error") console.error(line);
  else if(level === "warn") console.warn(line);
  else console.log(line);
}

function auditLog(event, req, fields = {}){
  logJson("info", "audit", {
    audit_event: event,
    request_id: req?.id,
    method: req?.method,
    path: req?.originalUrl || req?.url,
    actor: req?.authAccount?.id || req?.auth?.accountId || (req?.apiKeyAuthenticated ? "api-key" : null),
    auth_type: req?.apiKeyAuthenticated ? "api_key" : (req?.authAccount ? "account_session" : "unknown"),
    ...fields
  });
}

function requestIdMiddleware(req, res, next){
  const inboundRequestId = String(req.header("x-request-id") || req.header("x-correlation-id") || "").trim();
  req.id = inboundRequestId || `req_${nanoid(18)}`;
  res.setHeader("X-Request-ID", req.id);

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if(res.statusCode >= 400 && body && typeof body === "object" && !Array.isArray(body)){
      return originalJson({ request_id: req.id, ...body });
    }
    return originalJson(body);
  };

  const started = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    logJson(res.statusCode >= 500 ? "error" : "info", "http_request", {
      request_id: req.id,
      method: req.method,
      path: req.originalUrl || req.url,
      route: req.route?.path,
      status: res.statusCode,
      duration_ms: Number(durationMs.toFixed(3)),
      remote_addr: req.ip,
      user_agent: req.get("user-agent") || null,
      auth_type: req.apiKeyAuthenticated ? "api_key" : (req.authAccount ? "account_session" : "none")
    });
    if(req.apiKeyAuthenticated || req.header("x-api-key")){
      auditLog("api_key_authentication", req, { status: req.apiKeyAuthenticated && res.statusCode < 400 ? "success" : "failure" });
    }
  });
  next();
}

function dbReady(){
  try{
    db.prepare("SELECT 1 AS ready").get();
    return { ok: true };
  }catch(e){
    return { ok: false, error: e?.message || "database_unavailable" };
  }
}

function publicBaseUrl(req){
  const configured = String(process.env.PUBLIC_BASE_URL || "").trim();
  const fallback = `${req.protocol}://${req.get("host")}`;
  const rawBase = configured || fallback;

  try{
    return new URL(rawBase).toString().replace(/\/$/, "");
  }catch{
    return fallback.replace(/\/$/, "");
  }
}

function canonicalPublicUrls(req, anchorId){
  const baseUrl = publicBaseUrl(req);
  const mapDatabasePath = `/map/database?anchor_id=${encodeURIComponent(anchorId)}`;
  const mapAuthenticationPath = `/map/authenticate/${encodeURIComponent(anchorId)}`;
  const mapServerPath = "/map/server";
  const physicalMapImagePath = MAP_DATABASE_METADATA[anchorId]?.physical_map_image_url
    || MAP_DATABASE_METADATA["dyson-sphere-ring-1"].physical_map_image_url;

  return {
    map_server: new URL(mapServerPath, `${baseUrl}/`).toString(),
    map_database: new URL(mapDatabasePath, `${baseUrl}/`).toString(),
    map_authentication: new URL(mapAuthenticationPath, `${baseUrl}/`).toString(),
    physical_map_image: new URL(physicalMapImagePath, `${baseUrl}/`).toString()
  };
}

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

function isVercelRuntime(){
  return process.env.VERCEL === "1" || process.env.VERCEL === "true";
}

function trustProxyValue(){
  const value = (process.env.TRUST_PROXY || "").trim().toLowerCase();
  if(["true", "yes"].includes(value)) return true;
  if(["false", "no"].includes(value)) return false;
  if(value === "") return isVercelRuntime() ? 1 : false;
  const numeric = Number(value);
  if(Number.isInteger(numeric) && numeric >= 0) return numeric;
  return value;
}

const trustProxySetting = trustProxyValue();

function absolutePublicUrl(req, pathname){
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${publicBaseUrl(req)}${normalizedPath}`;
}

function escapeXml(value){
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function sitemapXml(req){
  const paths = [
    "/",
    "/console",
    "/genesis",
    "/map/dyson-sphere-ring-1",
    "/public/dyson-sphere-ring-1-map.svg"
  ];
  const urls = paths.map(pathname => `  <url><loc>${escapeXml(absolutePublicUrl(req, pathname))}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function robotsTxt(req){
  return [
    "User-agent: *",
    "Allow: /",
    `Sitemap: ${absolutePublicUrl(req, "/sitemap.xml")}`,
    ""
  ].join("\n");
}

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
app.use(requestIdMiddleware);
app.use(enforceHttpsInProduction);
app.use(helmet());
app.use(cors(corsOptions()));
app.use(express.json({ limit: "1mb" }));
app.use(rateLimit({ windowMs: 60_000, max: 240 })); // 240 req/min default

import path from "path";
import fs from "fs";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PUBLIC_ROOT = path.join(PROJECT_ROOT, "public");
const TEMPLATES_ROOT = path.join(PROJECT_ROOT, "templates");
const PROJECT_SEARCH_MIN_QUERY_LENGTH = 2;
const PROJECT_SEARCH_MAX_RESULTS = 50;
const PROJECT_SEARCH_MAX_FILE_SIZE_BYTES = 512 * 1024;
const PROJECT_SEARCH_MAX_EXCERPT_LENGTH = 180;
const PROJECT_SEARCH_ALLOWED_EXTENSIONS = new Set([
  ".css", ".html", ".js", ".json", ".md", ".mjs", ".svg", ".txt", ".xml", ".yml", ".yaml"
]);
const PROJECT_SEARCH_EXCLUDED_DIRS = new Set([
  ".git", ".cache", ".next", ".npm", "coverage", "dist", "build", "node_modules", "tmp", "temp", "logs"
]);
const PROJECT_SEARCH_EXCLUDED_FILE_NAMES = new Set([
  ".env", ".env.local", ".env.production", ".env.development", ".env.test", "package-lock.json"
]);
const PROJECT_SEARCH_EXCLUDED_EXTENSIONS = new Set([
  ".db", ".sqlite", ".sqlite3", ".log", ".pem", ".key", ".crt", ".p12", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tgz"
]);

function normalizeProjectSearchQuery(value){
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ");
}

function projectSearchError(status, code, details = {}){
  const err = new Error(code);
  err.status = status;
  err.issues = details;
  return err;
}

function isExcludedProjectEntry(absPath, dirent){
  const name = dirent.name;
  if(name.startsWith(".env")) return true;
  if(dirent.isDirectory()) return PROJECT_SEARCH_EXCLUDED_DIRS.has(name);
  if(!dirent.isFile()) return true;
  if(PROJECT_SEARCH_EXCLUDED_FILE_NAMES.has(name)) return true;
  const ext = path.extname(name).toLowerCase();
  if(PROJECT_SEARCH_EXCLUDED_EXTENSIONS.has(ext)) return true;
  if(!PROJECT_SEARCH_ALLOWED_EXTENSIONS.has(ext)) return true;

  const relativePath = path.relative(PROJECT_ROOT, absPath);
  if(relativePath.startsWith("..") || path.isAbsolute(relativePath)) return true;
  return relativePath.split(path.sep).some(part => PROJECT_SEARCH_EXCLUDED_DIRS.has(part));
}

function searchProjectFiles(query){
  const normalizedQuery = normalizeProjectSearchQuery(query);
  if(normalizedQuery.length < PROJECT_SEARCH_MIN_QUERY_LENGTH){
    throw projectSearchError(400, "query_too_short", { min_query_length: PROJECT_SEARCH_MIN_QUERY_LENGTH });
  }

  const needle = normalizedQuery.toLowerCase();
  const results = [];
  let filesScanned = 0;
  let filesSkippedTooLarge = 0;

  function walk(dir){
    if(results.length >= PROJECT_SEARCH_MAX_RESULTS) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for(const entry of entries){
      if(results.length >= PROJECT_SEARCH_MAX_RESULTS) break;
      const absPath = path.join(dir, entry.name);
      if(isExcludedProjectEntry(absPath, entry)) continue;
      if(entry.isDirectory()){
        walk(absPath);
        continue;
      }

      const stat = fs.statSync(absPath);
      if(stat.size > PROJECT_SEARCH_MAX_FILE_SIZE_BYTES){
        filesSkippedTooLarge += 1;
        continue;
      }

      filesScanned += 1;
      const text = fs.readFileSync(absPath, "utf8");
      const lines = text.split(/\r?\n/);
      for(let index = 0; index < lines.length && results.length < PROJECT_SEARCH_MAX_RESULTS; index += 1){
        const lineText = lines[index];
        const matchIndex = lineText.toLowerCase().indexOf(needle);
        if(matchIndex === -1) continue;
        const contextLength = Math.max(20, Math.floor((PROJECT_SEARCH_MAX_EXCERPT_LENGTH - normalizedQuery.length) / 2));
        const excerptStart = Math.max(0, matchIndex - contextLength);
        const excerptEnd = Math.min(lineText.length, matchIndex + normalizedQuery.length + contextLength);
        const excerpt = `${excerptStart > 0 ? "…" : ""}${lineText.slice(excerptStart, excerptEnd).trim()}${excerptEnd < lineText.length ? "…" : ""}`;
        results.push({
          path: path.relative(PROJECT_ROOT, absPath).split(path.sep).join("/"),
          line: index + 1,
          excerpt
        });
      }
    }
  }

  walk(PROJECT_ROOT);
  return {
    query: normalizedQuery,
    results,
    count: results.length,
    truncated: results.length >= PROJECT_SEARCH_MAX_RESULTS,
    limits: {
      min_query_length: PROJECT_SEARCH_MIN_QUERY_LENGTH,
      max_results: PROJECT_SEARCH_MAX_RESULTS,
      max_file_size_bytes: PROJECT_SEARCH_MAX_FILE_SIZE_BYTES
    },
    stats: { files_scanned: filesScanned, files_skipped_too_large: filesSkippedTooLarge }
  };
}

// --- search discovery + static (branding + landing)
app.get("/robots.txt", (req,res)=>{
  res.type("text/plain").send(robotsTxt(req));
});

app.get("/sitemap.xml", (req,res)=>{
  res.type("application/xml").send(sitemapXml(req));
});

app.use("/public", express.static(PUBLIC_ROOT));
app.use("/templates", express.static(TEMPLATES_ROOT));
app.get("/console", (req,res)=>{
  const p = path.join(PUBLIC_ROOT, "console.html");
  if(fs.existsSync(p)) return res.type("html").send(fs.readFileSync(p, "utf-8"));
  res.type("text").send("Console not found");
});

app.get("/", (req,res)=>{
  const p = path.join(PUBLIC_ROOT, "index.html");
  // if packaged differently, fall back to a minimal text response
  if(fs.existsSync(p)) return res.type("html").send(fs.readFileSync(p, "utf-8"));
  res.type("text").send("Synaptics.Systems Seconds Metering API");
});


app.get("/genesis", (req,res)=>{
  const p = path.join(PUBLIC_ROOT, "genesis-integrated.html");
  if(fs.existsSync(p)) return res.type("html").send(fs.readFileSync(p, "utf-8"));
  res.status(404).type("text").send("Genesis page not found");
});

const REQUIRED_SCHEMA = [
  { table: "schema_migrations", columns: ["version", "description", "applied_at"] },
  { table: "accounts", columns: ["id", "role", "created_at", "updated_at"] },
  { table: "account_identities", columns: ["id", "account_id", "provider_name", "provider_subject"] },
  { table: "auth_sessions", columns: ["id", "account_id", "expires_at"] },
  { table: "consents", columns: ["id", "account_id", "consent_type", "version", "granted_at", "revoked_at", "source"] },
  { table: "webauthn_credentials", columns: ["credential_id", "account_id", "public_key_cose", "metadata_json", "revoked_at"] },
  { table: "catalog_items", columns: ["id", "label", "unit_price_cents", "currency", "default_qty", "unit_name", "quantity_mode", "auto_increment_by"] },
  { table: "sessions", columns: ["id", "account_id", "seat_id", "status"] },
  { table: "usage_events", columns: ["id", "session_id", "item_id", "seconds", "event_kind", "at"] },
  { table: "invoices", columns: ["id", "account_id", "source", "status", "payload_json", "created_at", "updated_at"] },
  { table: "anchored_assets", columns: ["id", "label", "asset_type", "permanence", "role", "physics_role", "tick_rate_hz"] },
  { table: "map_assets", columns: ["map_id", "anchor_asset_id", "digest", "verification_status", "metadata_json"] },
  { table: "intelligence_network_keys", columns: ["id", "key_kind", "key_label", "anchor_asset_id", "status"] }
];

function assertSafeIdentifier(value){
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)){
    throw new Error(`unsafe_schema_identifier:${value}`);
  }
}

function inspectRequiredSchema(){
  const missing = [];

  for(const requirement of REQUIRED_SCHEMA){
    assertSafeIdentifier(requirement.table);
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(requirement.table);
    if(!table){
      missing.push({ table: requirement.table, missing: "table" });
      continue;
    }

    const columns = db.prepare(`PRAGMA table_info(${requirement.table})`).all();
    const existingColumns = new Set(columns.map(column => column.name));
    for(const column of requirement.columns){
      assertSafeIdentifier(column);
      if(!existingColumns.has(column)){
        missing.push({ table: requirement.table, column, missing: "column" });
      }
    }
  }

  const hasMigrationTable = !missing.some(item => item.table === "schema_migrations" && item.missing === "table");
  const latestMigration = hasMigrationTable
    ? db.prepare(`
      SELECT version, description, applied_at
      FROM schema_migrations
      ORDER BY version DESC
      LIMIT 1
    `).get()
    : null;

  if(hasMigrationTable && !latestMigration){
    missing.push({ table: "schema_migrations", missing: "applied_schema_version" });
  }

  return { ok: missing.length === 0, missing, latestMigration };
}

function inspectMapAssetSeed(){
  const expectedMapId = "dyson-sphere-ring-1";
  try{
    const authentication = authenticateStoredMapAsset(db, expectedMapId, {
      includePrivateMetadata: false
    });
    if(!authentication){
      return { ok: false, expected_map_id: expectedMapId, missing: "map_asset_seed" };
    }
    return {
      ok: authentication.verification_status === "verified",
      expected_map_id: expectedMapId,
      verification_status: authentication.verification_status,
      anchor_asset_id: authentication.anchor_asset_id
    };
  }catch(e){
    return { ok: false, expected_map_id: expectedMapId, error: e?.message || "map_asset_seed_unavailable" };
  }
}

function buildReadinessStatus(){
  const database = dbReady();
  if(!database.ok){
    return {
      ok: false,
      service: "synaptics-seconds-api",
      startup_config_ok: startupConfigStatus.ok,
      database,
      schema: { ok: false, missing: [], latestMigration: null },
      map_asset_seed: { ok: false, skipped: "database_unavailable" }
    };
  }

  const schema = inspectRequiredSchema();
  const mapAssetSeed = schema.ok
    ? inspectMapAssetSeed()
    : { ok: false, skipped: "schema_not_ready" };

  return {
    ok: startupConfigStatus.ok && schema.ok && mapAssetSeed.ok,
    service: "synaptics-seconds-api",
    startup_config_ok: startupConfigStatus.ok,
    database,
    schema,
    map_asset_seed: mapAssetSeed
  };
}

function healthPayload(){
  return {
    ok: true,
    service: "synaptics-seconds-api",
    status: "alive",
    description: "Shallow liveness only; the Express process can answer HTTP.",
    ts: new Date().toISOString()
  };
}

function healthPage(payload){
  const statusText = payload.ok ? "Online" : "Degraded";
  const statusClass = payload.ok ? "ok" : "degraded";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Synaptic Metering Health</title>
  <style>
    body{font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#08111f;color:#eef6ff}
    main{max-width:760px;padding:48px;border:1px solid rgba(125,211,252,.25);border-radius:24px;background:linear-gradient(145deg,rgba(15,23,42,.92),rgba(14,116,144,.16));box-shadow:0 24px 90px rgba(0,0,0,.35)}
    h1{margin:0 0 16px;font-size:clamp(2rem,6vw,3.5rem);line-height:1}.brand{color:#67e8f9}p{color:#cbd5e1;font-size:1.1rem;line-height:1.65}.badge{display:inline-flex;align-items:center;gap:10px;border-radius:999px;padding:10px 16px;font-weight:800}.badge.ok{color:#052e16;background:#86efac}.badge.degraded{color:#431407;background:#fdba74}.details{margin-top:24px;padding:18px;border-radius:16px;background:rgba(15,23,42,.72);border:1px solid rgba(125,211,252,.2)}dl{display:grid;grid-template-columns:max-content 1fr;gap:10px 18px;margin:0}dt{color:#93c5fd;font-weight:700}dd{margin:0;color:#e0f2fe;word-break:break-word}.links{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px}a{color:#06121f;background:#67e8f9;text-decoration:none;border-radius:999px;padding:12px 18px;font-weight:700}a.secondary{color:#e0f2fe;background:rgba(14,165,233,.18);border:1px solid rgba(125,211,252,.35)}
  </style>
</head>
<body>
  <main>
    <h1><span class="brand">Synaptic</span> Metering Health</h1>
    <p>${payload.description}</p>
    <span class="badge ${statusClass}">${statusText}</span>
    <section class="details" aria-label="Health details">
      <dl>
        <dt>Service</dt><dd>${payload.service}</dd>
        <dt>Status</dt><dd>${payload.status}</dd>
        <dt>Checked</dt><dd>${payload.ts}</dd>
      </dl>
    </section>
    <div class="links">
      <a href="/">Back Home</a>
      <a class="secondary" href="/ready">Readiness JSON</a>
      <a class="secondary" href="/health/full">Full Health JSON</a>
    </div>
  </main>
</body>
</html>`;
}

// --- health/readiness (public)
app.get("/health", (req,res)=>{
  const payload = healthPayload();
  if(req.accepts(["html", "json"]) === "html"){
    return res.type("html").send(healthPage(payload));
  }
  return res.json(payload);
});

app.get("/health/full", (req,res,next)=>{
  try{
    const readiness = buildReadinessStatus();
    res.status(readiness.ok ? 200 : 503).json({
      ...readiness,
      schema_version: readiness.schema.latestMigration?.version ?? null,
      schema_applied_at: readiness.schema.latestMigration?.applied_at ?? null,
      ts: new Date().toISOString()
    });
  }catch(e){ next(e); }
});

app.get("/ready", (req,res,next)=>{
  try{
    const readiness = buildReadinessStatus();
    res.status(readiness.ok ? 200 : 503).json({
      ok: readiness.ok,
      service: readiness.service,
      startup_config_ok: readiness.startup_config_ok,
      database: readiness.database,
      schema_version: readiness.schema.latestMigration?.version ?? null,
      schema_applied_at: readiness.schema.latestMigration?.applied_at ?? null,
      schema_ok: readiness.schema.ok,
      missing: readiness.schema.missing,
      map_asset_seed: readiness.map_asset_seed,
      ts: new Date().toISOString()
    });
  }catch(e){ next(e); }
});

app.get("/metrics", (req,res)=>{
  const readiness = dbReady();
  res.type("text/plain; version=0.0.4").send([
    "# HELP synaptics_metering_ready Database readiness, 1 when ready.",
    "# TYPE synaptics_metering_ready gauge",
    `synaptics_metering_ready ${readiness.ok ? 1 : 0}`,
    ""
  ].join("\n"));
});

app.get("/intelligence/anchors", (req,res)=>{
  res.json({
    operation: "Seconds_Of_Intelligence",
    tick_rate_hz: 1,
    assets: listAnchoredAssets(db),
    epoch: intelligenceTickContext({ db }).five_day_epoch
  });
});


app.get("/map/server", (req,res,next)=>{
  try{
    const anchorId = "dyson-sphere-ring-1";
    const map_database = mapDatabaseStatus({ db, anchorId });
    const authentication = authenticateStoredMapAsset(db, anchorId, {
      includePrivateMetadata: false
    });
    const baseResponse = {
      server_role: "map_database_reference_anchor",
      operation: "Seconds_Of_Intelligence",
      tick_rate_hz: 1,
      anchor_id: anchorId,
      canonical_public_urls: canonicalPublicUrls(req, anchorId),
      map_database
    };

    if(!authentication){
      return res.status(200).json({
        ...baseResponse,
        authentication_status: "map_asset_not_seeded",
        next_step: "Run `npm run migrate` to seed missing map digest data into map_assets."
      });
    }

    res.json({
      ...baseResponse,
      digest: authentication.digest,
      verification_status: authentication.verification_status,
      authentication
    });
  }catch(e){ next(e); }
});

app.get("/map/database", (req,res,next)=>{
  try{
    const anchorId = req.query?.anchor_id || "dyson-sphere-ring-1";
    res.json({ map_database: mapDatabaseStatus({ db, anchorId }) });
  }catch(e){ next(e); }
});

app.get("/map/dyson-sphere-ring-1", (req,res,next)=>{
  try{
    res.json({ map_database: mapDatabaseStatus({ db, anchorId: "dyson-sphere-ring-1" }) });
  }catch(e){ next(e); }
});

// --- Google OAuth + account sessions
app.use(loadAuthenticatedAccount(db));
app.get("/auth/google/start", startGoogleOAuth);
app.get("/auth/google/callback", googleOAuthCallback(db));
app.post("/auth/webauthn/register/options", requireAccount, (req,res,next)=>{
  try{ res.json(generateRegistrationOptions(db, req)); }catch(e){ next(e); }
});
app.post("/auth/webauthn/register/verify", requireAccount, (req,res,next)=>{
  try{ res.json(verifyRegistrationResponse(db, req, req.body || {})); }catch(e){ next(e); }
});
app.post("/auth/webauthn/login/options", (req,res,next)=>{
  try{ res.json(generateAuthenticationOptions(db, req)); }catch(e){ next(e); }
});
app.post("/auth/webauthn/login/verify", (req,res,next)=>{
  try{
    const result = verifyAuthenticationAssertion(db, req, req.body || {});
    createAuthSession(db, req, res, result.account_id);
    res.json({ ok: true });
  }catch(e){ next(e); }
});
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


app.get("/me/consents", requireAccount, (req,res,next)=>{
  try{
    const rows = db.prepare(`
      SELECT id, consent_type, version, granted_at, revoked_at, source, created_at, updated_at
      FROM consents
      WHERE account_id=?
      ORDER BY consent_type, granted_at DESC, created_at DESC
    `).all(req.authAccount.id);
    res.json({ consents: rows });
  }catch(e){ next(e); }
});

app.post("/me/consents", requireAccount, (req,res,next)=>{
  try{
    const consentType = normalizeConsentType(req.body?.consent_type || req.body?.type);
    const version = String(req.body?.version || "v1").trim().slice(0, 80);
    const source = String(req.body?.source || "account").trim().slice(0, 120);
    const granted = req.body?.granted !== false;
    if(!consentType) return res.status(400).json({ error:"missing_consent_type" });
    if(!version) return res.status(400).json({ error:"missing_consent_version" });

    if(!granted){
      db.prepare(`
        UPDATE consents
        SET revoked_at=datetime('now'), updated_at=datetime('now')
        WHERE account_id=? AND consent_type=? AND revoked_at IS NULL
      `).run(req.authAccount.id, consentType);
      return res.json({ ok:true, consent_type: consentType, granted:false });
    }

    db.prepare(`
      UPDATE consents
      SET revoked_at=datetime('now'), updated_at=datetime('now')
      WHERE account_id=? AND consent_type=? AND revoked_at IS NULL
    `).run(req.authAccount.id, consentType);
    const id = "consent_" + nanoid(18);
    const row = db.prepare(`
      INSERT INTO consents (id, account_id, consent_type, version, granted_at, source)
      VALUES (?, ?, ?, ?, datetime('now'), ?)
      RETURNING id, consent_type, version, granted_at, revoked_at, source, created_at, updated_at
    `).get(id, req.authAccount.id, consentType, version, source);
    res.status(201).json({ consent: row });
  }catch(e){ next(e); }
});

app.delete("/me/passkeys/:credentialId", requireAccount, (req,res,next)=>{
  try{
    const credentialId = String(req.params.credentialId || "").trim();
    if(!credentialId) return res.status(400).json({ error:"missing_credential_id" });
    const result = db.prepare(`
      UPDATE webauthn_credentials
      SET revoked_at=datetime('now'), updated_at=datetime('now')
      WHERE account_id=? AND credential_id=? AND revoked_at IS NULL
    `).run(req.authAccount.id, credentialId);
    if(result.changes === 0) return res.status(404).json({ error:"passkey_not_found" });
    res.json({ ok:true, credential_id: credentialId, revoked:true });
  }catch(e){ next(e); }
});

app.get("/map/authenticate/:mapId", (req,res,next)=>{
  try{
    const hasApiKey = Boolean(req.header("x-api-key"));
    const hasAccount = Boolean(req.authAccount);

    const sendAuthentication = () => {
      const result = authenticateStoredMapAsset(db, req.params.mapId, {
        includePrivateMetadata: Boolean(req.apiKeyAuthenticated || req.authAccount)
      });
      if(!result) return res.status(404).json({ error: "map_asset_not_found" });
      return res.json(result);
    };

    if(hasAccount) return sendAuthentication();
    if(hasApiKey){
      return requireApiKeyOrAccount(req, res, (err) => {
        if(err) return next(err);
        return sendAuthentication();
      });
    }

    return sendAuthentication();
  }catch(e){ next(e); }
});

const ACCOUNT_ROLES = new Set(["user", "admin"]);


app.get("/admin/project-search", requireApiKeyOrAccount, (req,res,next)=>{
  try{
    requireScope(req, "project:read");
    requireScope(req, "admin:read");
    requireAdmin(req);
    auditAdminApiKeyUse(req);
    res.json(searchProjectFiles(req.query?.q));
  }catch(e){ next(e); }
});

app.get("/admin/accounts", requireApiKeyOrAccount, (req,res,next)=>{
  try{
    requireScope(req, "admin:read");
    requireAdmin(req);
    auditAdminApiKeyUse(req);
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
    requireScope(req, "admin:write");
    requireAdmin(req);
    auditAdminApiKeyUse(req);
    const role = typeof req.body?.role === "string" ? req.body.role.trim() : "";
    if(!ACCOUNT_ROLES.has(role)){
      return res.status(400).json({ error: "invalid_role", allowed_roles: [...ACCOUNT_ROLES] });
    }

    const account = db.prepare("SELECT id, display_name, role, created_at, updated_at FROM accounts WHERE id=?").get(req.params.id);
    if(!account) return res.status(404).json({ error: "account_not_found" });

    db.prepare("UPDATE accounts SET role=?, updated_at=datetime('now') WHERE id=?").run(role, req.params.id);
    auditLog("admin_role_change", req, { target_account_id: req.params.id, previous_role: account.role, new_role: role });
    const updated = db.prepare("SELECT id, display_name, role, created_at, updated_at FROM accounts WHERE id=?").get(req.params.id);
    res.json({ account: updated });
  }catch(e){ next(e); }
});

app.get("/admin/accounts/:id/identities", requireApiKeyOrAccount, (req,res,next)=>{
  try{
    requireScope(req, "admin:read");
    requireAdmin(req);
    auditAdminApiKeyUse(req);
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
    requireScope(req, "admin:read");
    requireAdmin(req);
    auditAdminApiKeyUse(req);
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


app.get("/admin/reports/quarterly", requireApiKeyOrAccount, (req,res,next)=>{
  try{
    requireScope(req, "reports:read");
    requireScope(req, "admin:read");
    requireAdmin(req);
    auditAdminApiKeyUse(req);
    const window = parseQuarterReportWindow(req.query);

    const usageByItem = db.prepare(`
      SELECT ue.item_id, ci.label, ci.currency, ci.unit_name, ci.quantity_mode,
        SUM(ue.seconds) AS metered_seconds,
        COUNT(*) AS event_count
      FROM usage_events ue
      LEFT JOIN catalog_items ci ON ci.id = ue.item_id
      WHERE ue.at >= ? AND ue.at < ?
      GROUP BY ue.item_id, ci.label, ci.currency, ci.unit_name, ci.quantity_mode
      ORDER BY ue.item_id
    `).all(window.startSql, window.endSql);

    const sessionsByAccount = db.prepare(`
      SELECT s.account_id, a.display_name, a.role,
        COUNT(*) AS session_count,
        SUM(CASE WHEN s.status = 'open' THEN 1 ELSE 0 END) AS open_sessions,
        SUM(CASE WHEN s.status = 'closed' THEN 1 ELSE 0 END) AS closed_sessions,
        MIN(s.created_at) AS first_session_at,
        MAX(COALESCE(s.closed_at, s.created_at)) AS last_session_at,
        COALESCE(SUM(ue.seconds), 0) AS metered_seconds
      FROM sessions s
      LEFT JOIN accounts a ON a.id = s.account_id
      LEFT JOIN usage_events ue ON ue.session_id = s.id AND ue.at >= ? AND ue.at < ?
      WHERE s.created_at >= ? AND s.created_at < ?
      GROUP BY s.account_id, a.display_name, a.role
      ORDER BY session_count DESC, s.account_id
    `).all(window.startSql, window.endSql, window.startSql, window.endSql);

    const invoiceRows = db.prepare(`
      SELECT id, account_id, session_id, source, status, payload_json, created_at, accepted_at, verified_at
      FROM invoices
      WHERE created_at >= ? AND created_at < ?
      ORDER BY created_at DESC, id DESC
    `).all(window.startSql, window.endSql);

    const invoiceCountsByStatus = {};
    const invoiceTotalsByAccount = new Map();
    const anchorIds = new Set();
    const networkKeys = new Set();
    let invoiceQuantityTotal = 0;
    let subtotalCents = 0;
    let totalCents = 0;

    for(const row of invoiceRows){
      invoiceCountsByStatus[row.status] = (invoiceCountsByStatus[row.status] || 0) + 1;
      let invoice = {};
      try{ invoice = JSON.parse(row.payload_json || "{}"); }catch{ invoice = {}; }
      const quantity = invoiceQuantity(invoice);
      const rowSubtotal = cents(invoice?.totals?.subtotal_cents);
      const rowTotal = cents(invoice?.totals?.total_cents ?? invoice?.total_cents);
      invoiceQuantityTotal += quantity;
      subtotalCents += rowSubtotal;
      totalCents += rowTotal;
      for(const anchorId of invoiceAnchorIds(invoice)) anchorIds.add(anchorId);
      for(const key of invoiceNetworkKeys(invoice)) networkKeys.add(key);

      const accountTotals = invoiceTotalsByAccount.get(row.account_id) || {
        account_id: row.account_id,
        invoice_count: 0,
        invoice_quantity: 0,
        subtotal_cents: 0,
        total_cents: 0
      };
      accountTotals.invoice_count += 1;
      accountTotals.invoice_quantity += quantity;
      accountTotals.subtotal_cents += rowSubtotal;
      accountTotals.total_cents += rowTotal;
      invoiceTotalsByAccount.set(row.account_id, accountTotals);
    }

    const meteredSeconds = usageByItem.reduce((sum, row) => sum + Number(row.metered_seconds || 0), 0);
    res.json({
      report: {
        type: "quarterly",
        private: true,
        year: window.year,
        quarter: window.quarter,
        period_start: window.start,
        period_end: window.end
      },
      totals: {
        metered_seconds: meteredSeconds,
        invoice_quantity: invoiceQuantityTotal,
        subtotal_cents: subtotalCents,
        total_cents: totalCents
      },
      usage_by_item: usageByItem.map(row => ({
        item_id: row.item_id,
        label: row.label,
        currency: row.currency,
        unit_name: row.unit_name,
        quantity_mode: row.quantity_mode,
        metered_seconds: Number(row.metered_seconds || 0),
        event_count: Number(row.event_count || 0)
      })),
      sessions_by_account: sessionsByAccount.map(row => ({
        account_id: row.account_id,
        display_name: row.display_name,
        role: row.role,
        session_count: Number(row.session_count || 0),
        open_sessions: Number(row.open_sessions || 0),
        closed_sessions: Number(row.closed_sessions || 0),
        metered_seconds: Number(row.metered_seconds || 0),
        first_session_at: row.first_session_at,
        last_session_at: row.last_session_at
      })),
      invoices: {
        count: invoiceRows.length,
        counts_by_status: invoiceCountsByStatus,
        totals_by_account: [...invoiceTotalsByAccount.values()]
      },
      anchors: {
        anchor_ids: [...anchorIds].sort(),
        network_keys: [...networkKeys].sort()
      }
    });
  }catch(e){ next(e); }
});

// --- auth for everything else
app.use((req,res,next)=>{ res.setHeader('X-Synaptics-Systems','seconds-metering-api'); next(); });
app.use((req,res,next)=>{
  if(req.path === "/health" || req.path === "/ready" || req.path === "/metrics" || req.path === "/" || req.path === "/genesis" || req.path.startsWith("/public")) return next();
  return requireApiKeyOrAccount(req,res,next);
});



function parseQuarterReportWindow(query){
  const year = Number(query?.year);
  const quarter = Number(query?.quarter);
  if(!Number.isInteger(year) || year < 2000 || year > 9999){
    const err = new Error("invalid_year");
    err.status = 400;
    throw err;
  }
  if(!Number.isInteger(quarter) || quarter < 1 || quarter > 4){
    const err = new Error("invalid_quarter");
    err.status = 400;
    throw err;
  }

  const startMonth = (quarter - 1) * 3;
  const start = new Date(Date.UTC(year, startMonth, 1));
  const end = new Date(Date.UTC(quarter === 4 ? year + 1 : year, quarter === 4 ? 0 : startMonth + 3, 1));
  return {
    year,
    quarter,
    start: start.toISOString(),
    end: end.toISOString(),
    startSql: start.toISOString().slice(0, 19).replace("T", " "),
    endSql: end.toISOString().slice(0, 19).replace("T", " ")
  };
}

function cents(value){
  return Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0;
}

function invoiceQuantity(invoice){
  const totalQuantity = invoice?.totals?.tracked_quantity;
  if(Number.isFinite(Number(totalQuantity))) return Number(totalQuantity);
  const lines = Array.isArray(invoice?.lines) ? invoice.lines : [];
  return lines.reduce((sum, line) => sum + (Number.isFinite(Number(line?.quantity)) ? Number(line.quantity) : 0), 0);
}

function invoiceAnchorIds(invoice){
  const ids = new Set();
  const anchoredAssetId = invoice?.intelligence?.anchored_asset?.id;
  if(anchoredAssetId) ids.add(String(anchoredAssetId));
  const activeAnchorId = invoice?.intelligence?.map_database?.active_anchor_id;
  if(activeAnchorId) ids.add(String(activeAnchorId));
  return [...ids];
}

function invoiceNetworkKeys(invoice){
  return [
    invoice?.network?.a1_box_key,
    invoice?.intelligence?.invoice_key,
    invoice?.intelligence?.master_key
  ].filter(Boolean).map(String);
}

function canAccessMeteringSession(req, sess){
  if(req.apiKeyAuthenticated) return true;
  return Boolean(req.authAccount && sess?.account_id === req.authAccount.id);
}

function rejectForbiddenSession(res){
  return res.status(403).json({ error:"session_forbidden" });
}

function auditAdminApiKeyUse(req){
  if(!req.apiKey?.id) return;
  db.prepare(`
    INSERT INTO api_key_audit_logs (id, api_key_id, route, method, scopes, account_id, ip_address, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "aklog_" + nanoid(18),
    req.apiKey.id,
    req.originalUrl || req.url || "",
    req.method || "",
    JSON.stringify(req.auth?.scopes || []),
    req.auth?.accountId || null,
    req.ip || null,
    req.get?.("user-agent") || null
  );
}


function normalizeConsentType(value){
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9:_-]/g, "_").slice(0, 80);
}

function activeConsent(db, accountId, consentType){
  return db.prepare(`
    SELECT id, account_id, consent_type, version, granted_at, revoked_at, source, created_at, updated_at
    FROM consents
    WHERE account_id=? AND consent_type=? AND revoked_at IS NULL
    ORDER BY granted_at DESC, created_at DESC
    LIMIT 1
  `).get(accountId, consentType);
}

function requireActiveConsent(db, accountId, consentType){
  const row = activeConsent(db, accountId, consentType);
  if(row) return row;
  const err = new Error(`${consentType}_consent_required`);
  err.status = 403;
  throw err;
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
    const rows = db.prepare("SELECT id, label, unit_price_cents, currency, source, default_qty, unit_name, quantity_mode, auto_increment_by, effective_from, effective_to, version, active FROM catalog_items WHERE active = 1 ORDER BY id").all();
    res.json({ items: rows });
  }catch(e){ next(e); }
});

app.post("/catalog/refresh", (req,res,next)=>{
  try{
    requireScope(req, "catalog:write");
    const rows = refreshCatalog(db);
    auditLog("catalog_refresh", req, { item_count: rows.length });
    res.json({ ok:true, items: rows });
  }catch(e){ next(e); }
});


app.post("/intelligence/light", requireAccount, (req,res,next)=>{
  try{
    requireActiveConsent(db, req.authAccount.id, "location");
    const body = req.body || {};
    const segment = buildLightIntelligenceSegment({
      db,
      account: req.authAccount,
      authSessionId: req.authSessionId,
      client: body.client || req.header("x-client-id") || req.get("user-agent") || "web",
      gps: body.gps || body.gps_pinpoint || body.location || {},
      strings: body.strings_of_intelligence || body.strings || body.string || [],
      anchorId: body.anchor_id || "dyson-sphere-ring-1"
    });

    if(body.persist === true){
      requireActiveConsent(db, req.authAccount.id, "telemetry");
      const id = "t_" + nanoid(18);
      const sessionId = body.session_id || null;
      if(sessionId) loadOwnedSession(db, req, sessionId);
      db.prepare("INSERT INTO ndsp_telemetry (id, account_id, session_id, payload_json) VALUES (?, ?, ?, ?)")
        .run(id, req.authAccount.id, sessionId, JSON.stringify({ type: "light_intelligence_segment", segment }));
      return res.status(201).json({ segment, persisted: { ok: true, telemetry_id: id, session_id: sessionId } });
    }

    res.json({ segment, persisted: { ok: false, reason: "persist_false" } });
  }catch(e){ next(e); }
});

app.post("/intelligence/live-entropy", requireApiKeyOrAccount, (req,res,next)=>{
  try{
    requireScope(req, "intelligence:read");
    const body = req.body || {};
    const live_entropy = buildLiveEntropyIndex({
      db,
      strings: body.strings_of_intelligence || body.strings || body.string || [],
      anchorId: body.anchor_id || "live-entropy-index"
    });

    if(body.persist === true){
      requireScope(req, "telemetry:write");
      const id = "t_" + nanoid(18);
      const sessionId = body.session_id || null;
      if(sessionId) loadOwnedSession(db, req, sessionId);
      db.prepare("INSERT INTO ndsp_telemetry (id, account_id, session_id, payload_json) VALUES (?, ?, ?, ?)")
        .run(id, req.auth?.accountId || req.authAccount?.id || null, sessionId, JSON.stringify({ type: "live_entropy_index", live_entropy }));
      return res.status(201).json({ live_entropy, persisted: { ok: true, telemetry_id: id, session_id: sessionId } });
    }

    res.json({ live_entropy, persisted: { ok: false, reason: "persist_false" } });
  }catch(e){ next(e); }
});

app.get("/intelligence/state", (req,res,next)=>{
  try{
    requireScope(req, "intelligence:read");
    const requestedAnchorId = req.query?.anchor_id || "dyson-sphere-ring-1";
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
      moderation: "business_regulated_light_intelligence",
      map_database: mapDatabaseStatus({ db, anchorId })
    });
  }catch(e){ next(e); }
});

app.post("/admin/intelligence/master-keys", (req,res,next)=>{
  try{
    requireScope(req, "intelligence:write");
    requireScope(req, "admin:write");
    requireAdmin(req);
    auditAdminApiKeyUse(req);
    const body = parseBody(MasterKeyBody, req.body);
    const key = upsertIntelligenceNetworkKey(db, {
      keyKind: "master_key",
      keyLabel: body.key_label,
      accountId: body.account_id ?? null,
      invoiceId: null,
      anchorAssetId: body.anchor_asset_id,
      status: body.status
    });
    auditLog("master_key_change", req, { key_label: key.key_label, key_kind: key.key_kind, status: key.status, anchor_asset_id: key.anchor_asset_id, account_id: key.account_id });
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
    res.status(201).json({ id, status:"open", account_id: accountId, intelligence: intelligenceTickContext({ db, anchorId: "dyson-sphere-ring-1" }) });
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

    const item = db.prepare("SELECT * FROM catalog_items WHERE id=? AND active = 1").get(body.item_id);
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

function heartbeatIdentityClause(body){
  const clauses = [];
  const params = [];
  if(body.idempotency_key){
    clauses.push("heartbeat_idempotency_key=?");
    params.push(body.idempotency_key);
  }
  if(body.event_timestamp){
    clauses.push("heartbeat_event_timestamp=?");
    params.push(body.event_timestamp);
  }
  if(body.tick_sequence !== undefined){
    clauses.push("heartbeat_tick_sequence=?");
    params.push(body.tick_sequence);
  }
  if(clauses.length === 0) return null;
  return { sql: clauses.map(c => `(${c})`).join(" OR "), params };
}

function existingHeartbeatResult(sessionId, body){
  const identity = heartbeatIdentityClause(body);
  if(!identity) return null;

  const rows = db.prepare(`
    SELECT id, item_id, seconds, event_kind, heartbeat_idempotency_key, heartbeat_event_timestamp, heartbeat_tick_sequence
    FROM usage_events
    WHERE session_id=? AND (${identity.sql})
    ORDER BY CASE event_kind WHEN 'live_tick' THEN 0 ELSE 1 END, at, id
  `).all(sessionId, ...identity.params);

  if(rows.length === 0) return null;
  const liveSeconds = rows.filter(row => row.event_kind === "live_tick").reduce((sum, row) => sum + Number(row.seconds || 0), 0);
  const recoveredSeconds = rows.filter(row => row.event_kind === "recovery_adjustment").reduce((sum, row) => sum + Number(row.seconds || 0), 0);
  return {
    ok:true,
    duplicate:true,
    added_seconds: liveSeconds + recoveredSeconds,
    live_seconds: liveSeconds,
    recovered_seconds: recoveredSeconds,
    item_id: rows[0]?.item_id || null,
    event_ids: rows.map(row => row.id),
    identity: {
      idempotency_key: rows.find(row => row.heartbeat_idempotency_key)?.heartbeat_idempotency_key || null,
      event_timestamp: rows.find(row => row.heartbeat_event_timestamp)?.heartbeat_event_timestamp || null,
      tick_sequence: rows.find(row => row.heartbeat_tick_sequence !== null && row.heartbeat_tick_sequence !== undefined)?.heartbeat_tick_sequence ?? null
    },
    intelligence: intelligenceTickContext({ db, anchorId: body.anchor_id || "dyson-sphere-ring-1" })
  };
}

app.post("/sessions/:id/heartbeat", (req,res,next)=>{
  try{
    const sessionId = req.params.id;
    const body = parseBody(HeartbeatBody, req.body);

    const sess = db.prepare("SELECT * FROM sessions WHERE id=?").get(sessionId);
    if(!sess) return res.status(404).json({ error:"session_not_found" });
    if(!canAccessMeteringSession(req, sess)) return rejectForbiddenSession(res);
    if(sess.status !== "open") return res.status(409).json({ error:"session_closed" });
    if(!sess.current_item_id) return res.status(409).json({ error:"no_active_item" });

    const duplicate = existingHeartbeatResult(sessionId, body);
    if(duplicate) return res.json(duplicate);

    const recoveredSeconds = body.recovered_seconds || 0;
    const eventIds = [];
    const insertEvent = db.prepare(`
      INSERT INTO usage_events (
        id, session_id, item_id, seconds, event_kind,
        heartbeat_idempotency_key, heartbeat_event_timestamp, heartbeat_tick_sequence
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const liveEventId = "ev_" + nanoid(18);
    insertEvent.run(
      liveEventId,
      sessionId,
      sess.current_item_id,
      body.seconds,
      "live_tick",
      body.idempotency_key ?? null,
      body.event_timestamp ?? null,
      body.tick_sequence ?? null
    );
    eventIds.push(liveEventId);

    if(recoveredSeconds > 0){
      const recoveryEventId = "ev_" + nanoid(18);
      insertEvent.run(
        recoveryEventId,
        sessionId,
        sess.current_item_id,
        recoveredSeconds,
        "recovery_adjustment",
        body.idempotency_key ?? null,
        body.event_timestamp ?? null,
        body.tick_sequence ?? null
      );
      eventIds.push(recoveryEventId);
    }

    res.json({
      ok:true,
      duplicate:false,
      added_seconds: body.seconds + recoveredSeconds,
      live_seconds: body.seconds,
      recovered_seconds: recoveredSeconds,
      item_id: sess.current_item_id,
      event_ids: eventIds,
      identity: {
        idempotency_key: body.idempotency_key ?? null,
        event_timestamp: body.event_timestamp ?? null,
        tick_sequence: body.tick_sequence ?? null
      },
      intelligence: intelligenceTickContext({ db, anchorId: body.anchor_id || "dyson-sphere-ring-1" })
    });
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

    auditLog("session_close", req, { session_id: sessionId, account_id: sess.account_id, seat_id: sess.seat_id });
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
  const genesisMonitoring = genesisRingMonitoring({ db, accountId: req.authAccount.id, sessionId: session_id });
  const genesisEvidence = genesisInvoiceEvidence({ monitoring: genesisMonitoring, accountId: req.authAccount.id, sessionId: session_id });
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
      live_seconds: l.live_seconds,
      recovery_adjustment_seconds: l.recovery_adjustment_seconds,
      quantity: l.quantity,
      quantity_unit: l.quantity_unit,
      auto_increment_by: l.auto_increment_by,
      catalog_version: l.catalog_version,
      catalog_effective_from: l.catalog_effective_from,
      catalog_effective_to: l.catalog_effective_to,
      price_snapshot: l.price_snapshot,
      unit_price_cents: l.unit_price.cents,
      line_total_cents: l.cost.cents
    })),
    catalog: {
      versions: summary.catalog_versions,
      price_snapshot: summary.catalog_snapshot
    },
    intelligence: intelligenceTickContext({ db, anchorId: "dyson-sphere-ring-1", invoiceKey: `A1:${session_id}` }),
    network: {
      a1_box_key: `A1:${session_id}`,
      operation: "Seconds_Of_Intelligence",
      master_key_policy: "master_key governs network genesis and is not bound to a single invoice"
    },
    genesis: genesisEvidence,
    totals: {
      intelligence_seconds: summary.metrics.intelligence_seconds,
      live_tick_seconds: summary.metrics.live_tick_seconds,
      recovery_adjustment_seconds: summary.metrics.recovery_adjustment_seconds,
      tracked_quantity: summary.metrics.tracked_quantity,
      subtotal_cents: summary.total.cents,
      total_cents: summary.total.cents
    }
  };

  const id = "inv_" + nanoid(18);
  const catalogVersion = summary.catalog_versions.join(",") || null;
  const catalogSnapshotJson = JSON.stringify(summary.catalog_snapshot);

  db.prepare(`
    INSERT INTO invoices (
      id, account_id, session_id, source, status, verification_method,
      accepted_at, verified_at, payload_json, catalog_version, catalog_snapshot_json
    )
    VALUES (?, ?, ?, 'generated', 'accepted', 'generated_from_owned_session', datetime('now'), datetime('now'), ?, ?, ?)
  `).run(id, req.authAccount.id, session_id, JSON.stringify(invoice), catalogVersion, catalogSnapshotJson);

  const key = upsertIntelligenceNetworkKey(db, {
    keyKind: "invoice_key",
    keyLabel: `A1:${session_id}`,
    accountId: req.authAccount.id,
    invoiceId: id,
    anchorAssetId: "dyson-sphere-ring-1",
    status: "confirmed"
  });

  auditLog("invoice_creation", req, { invoice_id: id, session_id, account_id: req.authAccount.id, source: "generated", status: "accepted" });
  res.status(201).json({ id, invoice, key });
});

app.get("/invoices", requireAccount, (req,res)=>{
  const rows = db.prepare(`
    SELECT id, account_id, session_id, source, status, verification_method,
      accepted_at, verified_at, created_at, updated_at, catalog_version, catalog_snapshot_json, payload_json
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
      catalog_version: row.catalog_version,
      catalog_snapshot: row.catalog_snapshot_json ? JSON.parse(row.catalog_snapshot_json) : null,
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
    const storedPayload = normalizedServerInvoicePayload(payload, verification);

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
      JSON.stringify(storedPayload)
    );

    const invoice = db.prepare("SELECT * FROM invoices WHERE id=? AND account_id=?").get(id, req.authAccount.id);
    auditLog("invoice_import", req, { invoice_id: id, account_id: req.authAccount.id, source: body.source, status, verification_reason: verification.reason });
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

// --- Genesis account synchronization + invoice drafting
app.get("/genesis/structure", (_req,res)=>{
  res.json(genesisTechnicalStructure());
});

app.get("/genesis/roadmap", (_req,res)=>{
  res.json(genesisRoadmap());
});

app.get("/genesis/account-sync", requireAccount, (req,res,next)=>{
  try{
    const sessionId = req.query?.session_id || null;
    if(sessionId) loadOwnedSession(db, req, sessionId);
    const days = req.query?.days || 7;
    const anchorId = req.query?.anchor_id || "dyson-sphere-ring-1";
    res.json(genesisRingMonitoring({
      db,
      accountId: req.authAccount.id,
      sessionId,
      anchorId,
      days
    }));
  }catch(e){ next(e); }
});

app.post("/genesis/invoices/draft", requireAccount, (req,res,next)=>{
  try{
    const sessionId = req.body?.session_id;
    if(!sessionId) return res.status(400).json({ error:"missing_session_id" });
    loadOwnedSession(db, req, sessionId);
    const invoice = generateGenesisInvoiceDraft({
      db,
      accountId: req.authAccount.id,
      sessionId,
      days: req.body?.days || 7
    });
    if(!invoice) return res.status(404).json({ error:"session_not_found" });
    if(invoice.forbidden) return rejectForbiddenSession(res);
    res.status(201).json({ invoice });
  }catch(e){ next(e); }
});

// --- NDSP endpoints (as referenced by the Genesis Core HTML)
app.get("/ndsp/state", (req,res)=>{
  const sessionId = req.query?.session_id || null;
  const summary = sessionId ? computeSessionSummary(db, sessionId) : null;
  if(summary && !canAccessMeteringSession(req, summary.session)) return rejectForbiddenSession(res);
  // A small, stable policy payload. You can extend this later.
  const tickContext = intelligenceTickContext({ db });
  const entropticSettings = genesisEntropticSettings({
    anchoredAsset: tickContext.anchored_asset,
    relevancy: tickContext.daily_unix_relevancy
  });
  const policy = {
    channelCaps: entropticSettings.channel_caps,
    weights: entropticSettings.weights,
    tick_rate_hz: entropticSettings.tick_rate_hz,
    window_ticks: entropticSettings.window_ticks,
    persistence: "server-db",
    anchored_assets: listAnchoredAssets(db),
    rolling_epoch: tickContext.five_day_epoch,
    daily_unix_relevancy: tickContext.daily_unix_relevancy,
    entroptic_settings: entropticSettings,
    string_intelligence_system: "NDSP Genesis v3.0 normalized anchored string intelligence",
    technical_structure: genesisTechnicalStructure({ includeRoadmap: false }),
    roadmap: genesisRoadmap()
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

app.post("/ndsp/telemetry", requireApiKeyOrAccount, (req,res,next)=>{
  try{
    requireScope(req, "telemetry:write");
    const id = "t_" + nanoid(18);
    const payload = req.body ?? {};
    const sessionId = payload.session_id || null;
    if(req.authAccount) requireActiveConsent(db, req.authAccount.id, "telemetry");
    if(sessionId) loadOwnedSession(db, req, sessionId);
    db.prepare("INSERT INTO ndsp_telemetry (id, account_id, session_id, payload_json) VALUES (?, ?, ?, ?)").run(id, req.auth.accountId, sessionId, JSON.stringify(payload));

    // Echo back a lightweight state acknowledgment
    res.json({ ok:true, id, account_id: req.auth.accountId, session_id: sessionId, state: { meta:{ received:true, at:new Date().toISOString() } } });
  }catch(e){ next(e); }
});

// --- error handler
app.use((err, req, res, next)=>{
  const status = err?.status || 500;
  logJson(status >= 500 ? "error" : "warn", "http_error", { request_id: req.id, method: req.method, path: req.originalUrl || req.url, status, error: err?.message || "server_error" });
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
