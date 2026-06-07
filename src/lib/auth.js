import crypto from "crypto";
import { nanoid } from "nanoid";

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "syn_meter_session";
const OAUTH_STATE_COOKIE_NAME = "syn_meter_oauth_state";
const AUTH_SESSION_TTL_DAYS = Number(process.env.AUTH_SESSION_TTL_DAYS || 30);

let cachedGoogleJwks = null;
let cachedGoogleJwksUntil = 0;

function parseCookies(req){
  const header = req.header("cookie") || "";
  return Object.fromEntries(header.split(";").map(part => {
    const idx = part.indexOf("=");
    if(idx === -1) return null;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if(!key) return null;
    return [key, decodeURIComponent(value)];
  }).filter(Boolean));
}

function cookieOptions(maxAgeSeconds){
  const secure = String(process.env.COOKIE_SECURE || "").toLowerCase() === "true" || process.env.NODE_ENV === "production";
  return [
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    secure ? "Secure" : null,
    Number.isFinite(maxAgeSeconds) ? `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}` : null
  ].filter(Boolean).join("; ");
}

function setCookie(res, name, value, maxAgeSeconds){
  res.setHeader("Set-Cookie", `${name}=${encodeURIComponent(value)}; ${cookieOptions(maxAgeSeconds)}`);
}

function appendCookie(res, name, value, maxAgeSeconds){
  const next = `${name}=${encodeURIComponent(value)}; ${cookieOptions(maxAgeSeconds)}`;
  const current = res.getHeader("Set-Cookie");
  if(!current) return res.setHeader("Set-Cookie", next);
  if(Array.isArray(current)) return res.setHeader("Set-Cookie", [...current, next]);
  return res.setHeader("Set-Cookie", [current, next]);
}

function clearCookie(res, name){
  appendCookie(res, name, "", 0);
}

function stateSecret(){
  return process.env.OAUTH_STATE_SECRET || process.env.TOKEN_ENCRYPTION_KEY || process.env.GOOGLE_CLIENT_SECRET || process.env.API_KEYS || "dev-oauth-state-secret";
}

function signState(nonce){
  const sig = crypto.createHmac("sha256", stateSecret()).update(nonce).digest("base64url");
  return `${nonce}.${sig}`;
}

function verifyState(value){
  if(!value) return false;
  const [nonce, sig] = value.split(".");
  if(!nonce || !sig) return false;
  const expected = signState(nonce).split(".")[1];
  const received = Buffer.from(sig);
  const expectedBuffer = Buffer.from(expected);
  if(received.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(received, expectedBuffer);
}

function requireEnv(name){
  const value = process.env[name];
  if(!value){
    const err = new Error(`${name} not configured`);
    err.status = 503;
    throw err;
  }
  return value;
}

function googleRedirectUri(req){
  if(process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  return `${base.replace(/\/$/, "")}/auth/google/callback`;
}

function parseAllowedDomains(){
  return (process.env.GOOGLE_ALLOWED_DOMAINS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

function assertAllowedDomain(claims){
  const allowed = parseAllowedDomains();
  if(allowed.length === 0) return;
  const hostedDomain = String(claims.hd || "").toLowerCase();
  const emailDomain = String(claims.email || "").split("@").pop()?.toLowerCase() || "";
  if(!allowed.includes(hostedDomain) && !allowed.includes(emailDomain)){
    const err = new Error("google_domain_not_allowed");
    err.status = 403;
    throw err;
  }
}

function base64UrlJson(value){
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

async function fetchGoogleJwks(){
  const now = Date.now();
  if(cachedGoogleJwks && cachedGoogleJwksUntil > now) return cachedGoogleJwks;

  const response = await fetch(GOOGLE_JWKS_URL);
  if(!response.ok){
    const err = new Error("google_jwks_unavailable");
    err.status = 503;
    throw err;
  }

  cachedGoogleJwks = await response.json();
  const cacheControl = response.headers.get("cache-control") || "";
  const maxAge = Number(cacheControl.match(/max-age=(\d+)/)?.[1] || 300);
  cachedGoogleJwksUntil = now + maxAge * 1000;
  return cachedGoogleJwks;
}

async function verifyGoogleIdToken(idToken, audience){
  const [headerPart, payloadPart, signaturePart] = idToken.split(".");
  if(!headerPart || !payloadPart || !signaturePart){
    const err = new Error("invalid_id_token");
    err.status = 401;
    throw err;
  }

  const header = base64UrlJson(headerPart);
  const claims = base64UrlJson(payloadPart);
  if(header.alg !== "RS256"){
    const err = new Error("unsupported_id_token_algorithm");
    err.status = 401;
    throw err;
  }

  const jwks = await fetchGoogleJwks();
  const jwk = jwks.keys?.find(key => key.kid === header.kid);
  if(!jwk){
    cachedGoogleJwksUntil = 0;
    const refreshed = await fetchGoogleJwks();
    const retryJwk = refreshed.keys?.find(key => key.kid === header.kid);
    if(!retryJwk){
      const err = new Error("google_signing_key_not_found");
      err.status = 401;
      throw err;
    }
    return verifyGoogleIdTokenWithJwk(idToken, retryJwk, audience, claims);
  }
  return verifyGoogleIdTokenWithJwk(idToken, jwk, audience, claims);
}

function verifyGoogleIdTokenWithJwk(idToken, jwk, audience, claims){
  const [headerPart, payloadPart, signaturePart] = idToken.split(".");
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(`${headerPart}.${payloadPart}`);
  verifier.end();

  const ok = verifier.verify(crypto.createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(signaturePart, "base64url"));
  const now = Math.floor(Date.now() / 1000);
  const validIssuer = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  if(!ok || !validIssuer || claims.aud !== audience || Number(claims.exp || 0) <= now || !claims.sub){
    const err = new Error("invalid_id_token");
    err.status = 401;
    throw err;
  }
  return claims;
}

async function exchangeGoogleCode(req, code){
  const clientId = requireEnv("GOOGLE_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_CLIENT_SECRET");
  const redirectUri = googleRedirectUri(req);
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const payload = await response.json().catch(() => ({}));
  if(!response.ok){
    const err = new Error(payload.error || "google_token_exchange_failed");
    err.status = 401;
    throw err;
  }
  return payload;
}

function tokenRetentionEnabled(){
  return String(process.env.GOOGLE_OAUTH_RETAIN_TOKENS || "").toLowerCase() === "true";
}

function encryptionKey(){
  const raw = requireEnv("TOKEN_ENCRYPTION_KEY");
  if(/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  try{
    const decoded = Buffer.from(raw, "base64");
    if(decoded.length === 32) return decoded;
  }catch{
    // Fall through to hashed string material.
  }
  return crypto.createHash("sha256").update(raw).digest();
}

function encryptToken(value){
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function requireApiKey(req, res, next){
  const keys = (process.env.API_KEYS || "").split(",").map(s=>s.trim()).filter(Boolean);
  if(keys.length === 0){
    // safe default: if not configured, deny
    return res.status(503).json({ error: "API_KEYS not configured" });
  }
  const provided = req.header("x-api-key") || "";
  if(!provided || !keys.includes(provided)){
    return res.status(401).json({ error: "Unauthorized" });
  }
  req.apiKeyAuthenticated = true;
  next();
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
        SELECT s.id AS session_id, s.expires_at, a.id, a.display_name, a.created_at, a.updated_at
        FROM auth_sessions s
        JOIN accounts a ON a.id = s.account_id
        WHERE s.id=? AND s.expires_at > datetime('now')
      `).get(sessionId);
      if(row){
        req.authSessionId = row.session_id;
        req.authAccount = {
          id: row.id,
          display_name: row.display_name,
          created_at: row.created_at,
          updated_at: row.updated_at
        };
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
    const clientId = requireEnv("GOOGLE_CLIENT_ID");
    const redirectUri = googleRedirectUri(req);
    const nonce = crypto.randomBytes(24).toString("base64url");
    const signedState = signState(nonce);
    setCookie(res, OAUTH_STATE_COOKIE_NAME, signedState, 600);

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

export function googleOAuthCallback(db){
  return async (req, res, next) => {
    try{
      const cookies = parseCookies(req);
      const state = String(req.query.state || "");
      if(!state || state !== cookies[OAUTH_STATE_COOKIE_NAME] || !verifyState(state)){
        return res.status(400).json({ error: "invalid_oauth_state" });
      }
      clearCookie(res, OAUTH_STATE_COOKIE_NAME);

      const code = String(req.query.code || "");
      if(!code) return res.status(400).json({ error: "missing_oauth_code" });

      const tokenSet = await exchangeGoogleCode(req, code);
      if(!tokenSet.id_token) return res.status(401).json({ error: "missing_id_token" });
      const claims = await verifyGoogleIdToken(tokenSet.id_token, requireEnv("GOOGLE_CLIENT_ID"));
      assertAllowedDomain(claims);

      const account = linkGoogleIdentity(db, claims, tokenSet);
      const authSessionId = "authsess_" + nanoid(32);
      db.prepare(`
        INSERT INTO auth_sessions (id, account_id, expires_at)
        VALUES (?, ?, datetime('now', ?))
      `).run(authSessionId, account.id, `+${AUTH_SESSION_TTL_DAYS} days`);
      appendCookie(res, SESSION_COOKIE_NAME, authSessionId, AUTH_SESSION_TTL_DAYS * 24 * 60 * 60);

      const returnTo = process.env.OAUTH_SUCCESS_REDIRECT || "/me";
      res.redirect(returnTo);
    }catch(e){ next(e); }
  };
}

function linkGoogleIdentity(db, claims, tokenSet){
  const now = new Date().toISOString();
  const email = claims.email || null;
  const emailVerified = claims.email_verified === true || claims.email_verified === "true" ? 1 : 0;
  const displayName = claims.name || email || "Google account";

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
        INSERT INTO accounts (id, display_name, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(accountId, displayName, now, now);
      db.prepare(`
        INSERT INTO account_identities (id, account_id, provider_name, provider_subject, email, email_verified, created_at, updated_at)
        VALUES (?, ?, 'google', ?, ?, ?, ?, ?)
      `).run("ident_" + nanoid(18), accountId, claims.sub, email, emailVerified, now, now);
      account = db.prepare("SELECT * FROM accounts WHERE id=?").get(accountId);
    }else{
      db.prepare("UPDATE accounts SET display_name=?, updated_at=? WHERE id=?").run(displayName, now, existing.id);
      db.prepare(`
        UPDATE account_identities
        SET email=?, email_verified=?, updated_at=?
        WHERE provider_name='google' AND provider_subject=?
      `).run(email, emailVerified, now, claims.sub);
      account = db.prepare("SELECT * FROM accounts WHERE id=?").get(existing.id);
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
    clearCookie(res, SESSION_COOKIE_NAME);
    res.json({ ok: true });
  };
}
