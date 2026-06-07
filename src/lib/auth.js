function parseScopes(value){
  return String(value || "*")
    .split(/[|+\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function parseApiKeyEntry(entry){
  const parts = entry.split(":").map(s => s.trim());
  if(parts.length >= 4){
    const [keyId, secret, accountId, ...scopeParts] = parts;
    return { keyId, secret, accountId, scopes: parseScopes(scopeParts.join(":")) };
  }

  // Backward-compatible legacy form: API_KEYS=dev-key-1,dev-key-2.
  // Legacy keys are treated as their own single-account principal.
  return {
    keyId: entry,
    secret: entry,
    accountId: entry,
    scopes: ["*"]
  };
}

function configuredPrincipals(){
  return (process.env.API_KEYS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(parseApiKeyEntry);
}

export function requireApiKey(req, res, next){
  const principals = configuredPrincipals();
  if(principals.length === 0){
    // safe default: if not configured, deny
    return res.status(503).json({ error: "API_KEYS not configured" });
  }

  const provided = req.header("x-api-key") || "";
  const principal = provided ? principals.find(p => p.secret === provided) : null;
  if(!principal){
    return res.status(401).json({ error: "Unauthorized" });
  }

  req.auth = {
    accountId: principal.accountId,
    keyId: principal.keyId,
    scopes: principal.scopes
  };

  next();
}
