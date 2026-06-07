function authorizationError(status, code){
  const err = new Error(code);
  err.status = status;
  return err;
}

export function requireScope(req, scope){
  const scopes = req.auth?.scopes || [];
  if(scopes.includes("*") || scopes.includes(scope)) return;
  throw authorizationError(403, "insufficient_scope");
}

export function requireAuthenticatedAccount(req){
  const accountId = req.auth?.accountId;
  if(!accountId){
    throw authorizationError(403, "missing_authenticated_account");
  }
  return accountId;
}

export function assertAccountOwnership(req, resource, resourceName = "resource"){
  const accountId = requireAuthenticatedAccount(req);
  if(resource?.account_id !== accountId){
    throw authorizationError(403, `${resourceName}_account_forbidden`);
  }
  return resource;
}

export function loadOwnedSession(db, req, sessionId){
  const session = db.prepare("SELECT * FROM sessions WHERE id=?").get(sessionId);
  if(!session){
    throw authorizationError(404, "session_not_found");
  }
  return assertAccountOwnership(req, session, "session");
}
