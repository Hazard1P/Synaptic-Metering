import { createCipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { nanoid } from "nanoid";
import { openDb } from "../db/db.js";
import { upsertAccountIntelligenceRoot } from "./accountIntelligence.js";

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "syn_meter_session";
const OAUTH_STATE_COOKIE_NAME = "syn_meter_oauth_state";
const AUTH_SESSION_TTL_DAYS = Number(process.env.AUTH_SESSION_TTL_DAYS || 30);


function parseEmailList(value){
  return (value || "")
    .split(",")
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
}

function verifiedGoogleEmail(claims){
  const email = String(claims.email || "").trim().toLowerCase();
  const emailVerified = claims.email_verified === true || claims.email_verified === "true";
  return email && emailVerified ? email : "";
}

function parseJsonScopes(value){
  if(Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  try{
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map(String).map(s => s.trim()).filter(Boolean) : [];
  }catch{
    return String(value || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
  }
}

let apiKeyDb;

function getApiKeyDb(){
  if(apiKeyDb) return apiKeyDb;
  apiKeyDb = openDb();
  return apiKeyDb;
}

export function configureApiKeyAuth(db){
  apiKeyDb = db;
}

function sha256Hex(value){
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isHexSha256Digest(value){
  return /^[a-f0-9]{64}$/.test(value);
}

function digestMatches(providedDigest, expectedDigest){
  if(!isHexSha256Digest(expectedDigest)) return false;

  const provided = Buffer.from(providedDigest, "hex");
  const expected = Buffer.from(expectedDigest, "hex");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function requireEnv(name){
  const value = process.env[name];
  if(!value) throw new Error(`${name} is required`);
  return value;
}

function cookieSecureEnabled(req){
  if(process.env.COOKIE_SECURE) return process.env.COOKIE_SECURE !== "false";
  return process.env.NODE_ENV === "production" || req?.secure || req?.headers?.["x-forwarded-proto"] === "https";
}

function parseCookies(req){
  const header = req.headers?.cookie || "";
  return header.split(";").reduce((cookies, part) => {
    const index = part.indexOf("=");
    if(index === -1) return cookies;
    const name = part.slice(0, index).trim();
    if(!name) return cookies;
    const rawValue = part.slice(index + 1).trim();
    try{
      cookies[name] = decodeURIComponent(rawValue);
    }catch{
      cookies[name] = rawValue;
    }
    return cookies;
  }, {});
}

function appendCookie(res, name, value, maxAgeSeconds, req){
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Number(maxAgeSeconds || 0))}`
  ];
  if(cookieSecureEnabled(req)) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

function setCookie(res, name, value, maxAgeSeconds, req){
  appendCookie(res, name, value, maxAgeSeconds, req);
}

function clearCookie(res, name, req){
  appendCookie(res, name, "", 0, req);
}

function stateSecret(){
  return process.env.OAUTH_STATE_SECRET || process.env.TOKEN_ENCRYPTION_KEY || process.env.GOOGLE_CLIENT_SECRET || "dev-state-secret";
}

function signState(nonce){
  const signature = createHmac("sha256", stateSecret()).update(nonce).digest("base64url");
  return `${nonce}.${signature}`;
}

function verifyState(state){
  const [nonce, signature] = String(state || "").split(".");
  if(!nonce || !signature) return false;
  const expected = signState(nonce).split(".")[1];
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

function googleRedirectUri(req){
  if(process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  return `${base.replace(/\/+$/, "")}/auth/google/callback`;
}

async function exchangeGoogleCode(req, code){
  const params = new URLSearchParams({
    code,
    client_id: requireEnv("GOOGLE_CLIENT_ID"),
    client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
    redirect_uri: googleRedirectUri(req),
    grant_type: "authorization_code"
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });
  const body = await response.json().catch(() => ({}));
  if(!response.ok) throw new Error(body.error_description || body.error || "google_token_exchange_failed");
  return body;
}

async function verifyGoogleIdToken(idToken, audience){
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  const claims = await response.json().catch(() => ({}));
  if(!response.ok) throw new Error(claims.error_description || claims.error || "google_id_token_invalid");
  if(claims.aud !== audience) throw new Error("google_id_token_audience_mismatch");
  if(claims.exp && Number(claims.exp) * 1000 < Date.now()) throw new Error("google_id_token_expired");
  return claims;
}

function assertAllowedEmail(claims){
  const allowed = parseEmailList(process.env.GOOGLE_ALLOWED_EMAILS);
  if(allowed.length === 0) return;

  const email = verifiedGoogleEmail(claims);
  if(!email || !allowed.includes(email)){
    const err = new Error("google_email_not_allowed");
    err.status = 403;
    throw err;
  }
}

function googleAccountPolicy(claims){
  const email = verifiedGoogleEmail(claims);
  return {
    email,
    isAdmin: Boolean(email && parseEmailList(process.env.ADMIN_GOOGLE_EMAILS).includes(email)),
    isBusinessAssociated: Boolean(email && parseEmailList(process.env.BUSINESS_GOOGLE_EMAILS).includes(email))
  };
}

function assertAllowedDomain(claims){
  const allowed = (process.env.GOOGLE_ALLOWED_DOMAINS || "")
    .split(",")
    .map(domain => domain.trim().toLowerCase())
    .filter(Boolean);
  if(allowed.length === 0) return;

  const hostedDomain = String(claims.hd || "").toLowerCase();
  const emailDomain = String(claims.email || "").split("@").pop()?.toLowerCase() || "";
  if(!allowed.includes(hostedDomain) && !allowed.includes(emailDomain)){
    const err = new Error("google_domain_not_allowed");
    err.status = 403;
    throw err;
  }
}

function tokenRetentionEnabled(){
  return process.env.GOOGLE_OAUTH_RETAIN_TOKENS === "true";
}

function tokenEncryptionKey(){
  const raw = requireEnv("TOKEN_ENCRYPTION_KEY");
  if(/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  const decoded = Buffer.from(raw, "base64");
  if(decoded.length === 32) return decoded;
  const utf8 = Buffer.from(raw, "utf8");
  if(utf8.length === 32) return utf8;
  throw new Error("TOKEN_ENCRYPTION_KEY must resolve to 32 bytes");
}

function encryptToken(value){
  const key = tokenEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

export function requireApiKey(req, res, next){
  try{
    const provided = req.header("x-api-key") || "";
    if(!provided){
      return res.status(401).json({ error: "Unauthorized" });
    }

    const providedDigest = sha256Hex(provided);
    const row = getApiKeyDb().prepare(`
      SELECT id, key_digest, label, scopes, created_at, expires_at, revoked_at, last_used_at
      FROM api_keys
      WHERE key_digest=?
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > datetime('now'))
    `).get(providedDigest);

    if(!row || !digestMatches(providedDigest, row.key_digest)){
      return res.status(401).json({ error: "Unauthorized" });
    }

    const scopes = parseJsonScopes(row.scopes);
    getApiKeyDb().prepare("UPDATE api_keys SET last_used_at=datetime('now') WHERE id=?").run(row.id);

    req.apiKeyAuthenticated = true;
    req.apiKey = {
      id: row.id,
      label: row.label,
      scopes,
      created_at: row.created_at,
      expires_at: row.expires_at,
      revoked_at: row.revoked_at,
      last_used_at: row.last_used_at
    };
    req.auth = { accountId: `api-key:${row.id}`, scopes };
    next();
  }catch(e){ next(e); }
}

export function requireApiKeyOrAccount(req, res, next){
  if(req.authAccount) return next();
  return requireApiKey(req, res, next);
}

export function loadAuthenticatedAccount(db){
  return (req, res, next) => {
    try{
      const sessionId = parseCookies(req)[SESSION_COOKIE_NAME];
      if(!sessionId) return next();
      const row = db.prepare(`
        SELECT s.id AS session_id, s.expires_at, a.id, a.display_name, a.role, a.created_at, a.updated_at
        FROM auth_sessions s
        JOIN accounts a ON a.id = s.account_id
        WHERE s.id=? AND s.expires_at > datetime('now')
      `).get(sessionId);
      if(row){
        req.authSessionId = row.session_id;
        req.authAccount = {
          id: row.id,
          display_name: row.display_name,
          role: row.role || "user",
          created_at: row.created_at,
          updated_at: row.updated_at
        };
        req.auth = { accountId: row.id, scopes: ["*"] };
      }
      next();
    }catch(e){ next(e); }
  };
}

export function requireAccount(req, res, next){
  if(req.authAccount) return next();
  return res.status(401).json({ error: "authentication_required" });
}

export function startGoogleOAuth(req, res, next){
  try{
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if(!clientId){
      return res.status(503).json({
        error: "google_oauth_not_configured",
        message: "Google sign-in is not configured for this deployment. Please contact the site administrator."
      });
    }

    const redirectUri = googleRedirectUri(req);
    const nonce = randomBytes(24).toString("base64url");
    const signedState = signState(nonce);
    setCookie(res, OAUTH_STATE_COOKIE_NAME, signedState, 600, req);

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state: signedState,
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: process.env.GOOGLE_OAUTH_PROMPT || "select_account"
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  }catch(e){ next(e); }
}

export function createAuthSession(db, req, res, accountId){
  const authSessionId = "authsess_" + nanoid(32);
  db.prepare(`
    INSERT INTO auth_sessions (id, account_id, expires_at)
    VALUES (?, ?, datetime('now', ?))
  `).run(authSessionId, accountId, `+${AUTH_SESSION_TTL_DAYS} days`);
  appendCookie(res, SESSION_COOKIE_NAME, authSessionId, AUTH_SESSION_TTL_DAYS * 24 * 60 * 60, req);
  return authSessionId;
}

export function googleOAuthCallback(db){
  return async (req, res, next) => {
    try{
      const cookies = parseCookies(req);
      const state = String(req.query.state || "");
      if(!state || state !== cookies[OAUTH_STATE_COOKIE_NAME] || !verifyState(state)){
        return res.status(400).json({ error: "invalid_oauth_state" });
      }
      clearCookie(res, OAUTH_STATE_COOKIE_NAME, req);

      const code = String(req.query.code || "");
      if(!code) return res.status(400).json({ error: "missing_oauth_code" });

      const tokenSet = await exchangeGoogleCode(req, code);
      if(!tokenSet.id_token) return res.status(401).json({ error: "missing_id_token" });
      const claims = await verifyGoogleIdToken(tokenSet.id_token, requireEnv("GOOGLE_CLIENT_ID"));
      assertAllowedEmail(claims);
      assertAllowedDomain(claims);

      const account = linkGoogleIdentity(db, claims, tokenSet, googleAccountPolicy(claims));
      createAuthSession(db, req, res, account.id);

      const returnTo = process.env.OAUTH_SUCCESS_REDIRECT || "/me";
      res.redirect(returnTo);
    }catch(e){ next(e); }
  };
}

function linkGoogleIdentity(db, claims, tokenSet, accountPolicy = {}){
  const now = new Date().toISOString();
  const email = claims.email || null;
  const emailVerified = claims.email_verified === true || claims.email_verified === "true" ? 1 : 0;
  const displayName = claims.name || email || "Google account";
  const role = accountPolicy.isAdmin ? "admin" : "user";

  const existing = db.prepare(`
    SELECT a.*
    FROM account_identities i
    JOIN accounts a ON a.id = i.account_id
    WHERE i.provider_name='google' AND i.provider_subject=?
  `).get(claims.sub);

  const tx = db.transaction(() => {
    let account = existing;
    if(!account){
      const accountId = "acct_" + nanoid(18);
      db.prepare(`
        INSERT INTO accounts (id, display_name, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(accountId, displayName, role, now, now);
      db.prepare(`
        INSERT INTO account_identities (id, account_id, provider_name, provider_subject, email, email_verified, created_at, updated_at)
        VALUES (?, ?, 'google', ?, ?, ?, ?, ?)
      `).run("ident_" + nanoid(18), accountId, claims.sub, email, emailVerified, now, now);
      account = db.prepare("SELECT * FROM accounts WHERE id=?").get(accountId);
    }else{
      db.prepare("UPDATE accounts SET display_name=?, role=CASE WHEN ? = 'admin' THEN 'admin' ELSE role END, updated_at=? WHERE id=?").run(displayName, role, now, existing.id);
      db.prepare(`
        UPDATE account_identities
        SET email=?, email_verified=?, updated_at=?
        WHERE provider_name='google' AND provider_subject=?
      `).run(email, emailVerified, now, claims.sub);
      account = db.prepare("SELECT * FROM accounts WHERE id=?").get(existing.id);
    }

    if(accountPolicy.isBusinessAssociated){
      db.prepare(`
        INSERT INTO account_business_associations (id, account_id, provider_name, association_kind, source, created_at, updated_at)
        VALUES (?, ?, 'google', 'business_email_allowlist', 'BUSINESS_GOOGLE_EMAILS', ?, ?)
        ON CONFLICT(account_id, provider_name, association_kind) DO UPDATE SET
          source=excluded.source,
          updated_at=excluded.updated_at
      `).run("bizassoc_" + nanoid(18), account.id, now, now);
    }

    if(tokenRetentionEnabled()){
      const accessToken = tokenSet.access_token ? encryptToken(tokenSet.access_token) : null;
      const refreshToken = tokenSet.refresh_token ? encryptToken(tokenSet.refresh_token) : null;
      if(accessToken || refreshToken){
        db.prepare(`
          INSERT INTO oauth_tokens (id, account_id, provider_name, access_token_ciphertext, refresh_token_ciphertext, scope, token_type, expires_at, created_at, updated_at)
          VALUES (?, ?, 'google', ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(account_id, provider_name) DO UPDATE SET
            access_token_ciphertext=COALESCE(excluded.access_token_ciphertext, oauth_tokens.access_token_ciphertext),
            refresh_token_ciphertext=COALESCE(excluded.refresh_token_ciphertext, oauth_tokens.refresh_token_ciphertext),
            scope=excluded.scope,
            token_type=excluded.token_type,
            expires_at=excluded.expires_at,
            updated_at=excluded.updated_at
        `).run(
          "tok_" + nanoid(18),
          account.id,
          accessToken,
          refreshToken,
          tokenSet.scope || null,
          tokenSet.token_type || null,
          tokenSet.expires_in ? new Date(Date.now() + Number(tokenSet.expires_in) * 1000).toISOString() : null,
          now,
          now
        );
      }
    }

    upsertAccountIntelligenceRoot(db, {
      accountId: account.id,
      stringSource: "google_account",
      datablock: {
        provider: "google",
        provider_subject_digest: sha256Hex(String(claims.sub || "")),
        email_digest: email ? sha256Hex(String(email).toLowerCase()) : null,
        email_verified: Boolean(emailVerified),
        initialized_at: now
      }
    });

    return account;
  });

  return tx();
}

export function logout(db){
  return (req, res) => {
    const sessionId = parseCookies(req)[SESSION_COOKIE_NAME];
    if(sessionId){
      db.prepare("DELETE FROM auth_sessions WHERE id=?").run(sessionId);
    }
    clearCookie(res, SESSION_COOKIE_NAME, req);
    res.json({ ok: true });
  };
}
