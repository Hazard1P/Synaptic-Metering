import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { nanoid } from "nanoid";

import { openDb } from "./db/db.js";
import { requireApiKey } from "./lib/auth.js";
import { refreshCatalog } from "./lib/catalog.js";
import { computeSessionSummary } from "./lib/billing.js";
import { CreateSessionBody, StartBody, HeartbeatBody, parseBody } from "./lib/validate.js";
import { loadOwnedSession, requireScope } from "./lib/authorization.js";

const app = express();
const db = openDb();

// --- middleware
app.use(helmet());
app.use(cors({ origin: true }));
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

// --- auth for everything else
app.use((req,res,next)=>{ res.setHeader('X-Synaptics-Systems','seconds-metering-api'); next(); });
app.use((req,res,next)=>{
  if(req.path === "/health" || req.path === "/" || req.path === "/genesis" || req.path.startsWith("/public")) return next();
  return requireApiKey(req,res,next);
});

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

// --- sessions
app.post("/sessions", (req,res,next)=>{
  try{
    requireScope(req, "sessions:write");
    const body = parseBody(CreateSessionBody, req.body);
    if(body.account_id && body.account_id !== req.auth.accountId){
      return res.status(403).json({ error:"session_account_forbidden" });
    }
    const id = "sess_" + nanoid(16);
    db.prepare(`
      INSERT INTO sessions (id, account_id, seat_id, status)
      VALUES (?, ?, ?, 'open')
    `).run(id, req.auth.accountId, body.seat_id ?? null);
    res.status(201).json({ id, account_id: req.auth.accountId, status:"open" });
  }catch(e){ next(e); }
});

app.post("/sessions/:id/start", (req,res,next)=>{
  try{
    const sessionId = req.params.id;
    const body = parseBody(StartBody, req.body);

    requireScope(req, "sessions:write");
    const sess = loadOwnedSession(db, req, sessionId);
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

    requireScope(req, "sessions:write");
    const sess = loadOwnedSession(db, req, sessionId);
    if(sess.status !== "open") return res.status(409).json({ error:"session_closed" });
    if(!sess.current_item_id) return res.status(409).json({ error:"no_active_item" });

    const evId = "ev_" + nanoid(18);
    db.prepare(`
      INSERT INTO usage_events (id, session_id, item_id, seconds)
      VALUES (?, ?, ?, ?)
    `).run(evId, sessionId, sess.current_item_id, body.seconds);

    res.json({ ok:true, added_seconds: body.seconds, item_id: sess.current_item_id });
  }catch(e){ next(e); }
});

app.post("/sessions/:id/stop", (req,res,next)=>{
  try{
    const sessionId = req.params.id;
    requireScope(req, "sessions:write");
    const sess = loadOwnedSession(db, req, sessionId);
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
    requireScope(req, "sessions:write");
    const sess = loadOwnedSession(db, req, sessionId);
    if(sess.status !== "open") return res.status(409).json({ error:"already_closed" });

    db.prepare(`
      UPDATE sessions SET status='closed', closed_at=datetime('now'), current_item_id=NULL, current_item_started_at=NULL
      WHERE id=?
    `).run(sessionId);

    res.json({ ok:true, status:"closed" });
  }catch(e){ next(e); }
});

app.get("/sessions/:id/summary", (req,res,next)=>{
  try{
    requireScope(req, "sessions:read");
    loadOwnedSession(db, req, req.params.id);
    const summary = computeSessionSummary(db, req.params.id);
    res.json(summary);
  }catch(e){ next(e); }
});


// --- invoices
app.post("/invoices/from-session", (req,res,next)=>{
  try{
    requireScope(req, "invoices:write");
    const { session_id } = req.body || {};
    if(!session_id) return res.status(400).json({ error:"missing_session_id" });
    loadOwnedSession(db, req, session_id);
    const summary = computeSessionSummary(db, session_id);

    const issued_at = new Date().toISOString();
    const invoice = {
      schema: "synaptics.invoice.v1",
      issued_at,
      session_id,
      account_id: summary.session.account_id,
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
      totals: {
        intelligence_seconds: summary.metrics.intelligence_seconds,
        tracked_quantity: summary.metrics.tracked_quantity,
        subtotal_cents: summary.total.cents,
        total_cents: summary.total.cents
      }
    };

    res.json({ invoice });
  }catch(e){ next(e); }
});

// --- NDSP endpoints (as referenced by the Genesis Core HTML)
app.get("/ndsp/state", (req,res,next)=>{
  try{
    requireScope(req, "telemetry:read");
    const sessionId = req.query?.session_id || null;
    const summary = sessionId ? (loadOwnedSession(db, req, sessionId), computeSessionSummary(db, sessionId)) : null;
    // A small, stable policy payload. You can extend this later.
    const policy = {
      channelCaps: {
        c_load: [0,1], s_var:[0,1], circ_drift:[0,1], sys_noise:[0,1], env_flux:[0,1]
      },
      tick_rate_hz: 1,
      persistence: "server-db"
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
  }catch(e){ next(e); }
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
boot();
