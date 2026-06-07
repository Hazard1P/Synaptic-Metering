import { createHash, timingSafeEqual } from "crypto";

function parseDigests(value){
  return (value || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
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

export function requireApiKey(req, res, next){
  const digests = parseDigests(process.env.API_KEY_DIGESTS);
  if(digests.length === 0){
    // safe default: if not configured, deny. Raw API_KEYS are intentionally ignored.
    return res.status(503).json({ error: "API_KEY_DIGESTS not configured" });
  }

  const provided = req.header("x-api-key") || "";
  if(!provided){
    return res.status(401).json({ error: "Unauthorized" });
  }

  const providedDigest = sha256Hex(provided);
  const authorized = digests.some(expectedDigest => digestMatches(providedDigest, expectedDigest));
  if(!authorized){
    return res.status(401).json({ error: "Unauthorized" });
  }

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
