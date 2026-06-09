function objectValue(value){
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value){
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function uniqueStrings(values){
  return [...new Set(values.map(stringValue).filter(Boolean))];
}

function extractSessionIds(payload, explicitSessionId){
  const body = objectValue(payload);
  const ids = [
    explicitSessionId,
    body.session_id,
    body.sessionId,
    body.session?.id,
    body.session?.session_id,
    body.metadata?.session_id,
    body.platform_attachment?.session_id,
    body.platformAttachment?.session_id
  ];

  if(Array.isArray(body.sessions)){
    for(const session of body.sessions){
      const sessionBody = objectValue(session);
      ids.push(sessionBody.id, sessionBody.session_id);
    }
  }

  return uniqueStrings(ids);
}

function extractAccountIds(payload){
  const body = objectValue(payload);
  return uniqueStrings([
    body.account_id,
    body.accountId,
    body.account?.id,
    body.account?.account_id,
    body.metadata?.account_id,
    body.platform_attachment?.account_id,
    body.platformAttachment?.account_id
  ]);
}

function accountMismatch(accountIds, accountId){
  return accountIds.some(id => id !== accountId);
}

function allSessionsOwnedByAccount(db, sessionIds, accountId){
  if(sessionIds.length === 0) return { matched: false };

  const sessions = sessionIds.map(id => db.prepare("SELECT id, account_id FROM sessions WHERE id=?").get(id));
  if(sessions.some(session => !session)){
    return { matched: false, missingSessionIds: sessionIds.filter((id, index) => !sessions[index]) };
  }

  const forbiddenSession = sessions.find(session => session.account_id !== accountId);
  if(forbiddenSession){
    return { matched: false, forbiddenSessionId: forbiddenSession.id };
  }

  const usageEventCount = sessionIds.reduce((count, id) => {
    const row = db.prepare("SELECT COUNT(*) AS count FROM usage_events WHERE session_id=?").get(id);
    return count + Number(row?.count || 0);
  }, 0);

  return {
    matched: true,
    sessionIds,
    usageEventCount
  };
}

export function verifyInvoiceForAccount(db, { accountId, sessionId = null, payload = {} }){
  const accountIds = extractAccountIds(payload);
  if(accountMismatch(accountIds, accountId)){
    return {
      accepted: false,
      status: "rejected",
      reason: "invoice_account_mismatch",
      checked: { accountIds }
    };
  }

  const sessionIds = extractSessionIds(payload, sessionId);
  const sessionMatch = allSessionsOwnedByAccount(db, sessionIds, accountId);
  if(sessionMatch.forbiddenSessionId){
    return {
      accepted: false,
      status: "rejected",
      reason: "session_account_mismatch",
      checked: { accountIds, sessionIds, forbiddenSessionId: sessionMatch.forbiddenSessionId }
    };
  }

  if(sessionMatch.matched){
    return {
      accepted: true,
      status: "accepted",
      verificationMethod: "account_history",
      reason: "matched_account_session_history",
      checked: {
        accountIds,
        sessionIds: sessionMatch.sessionIds,
        usageEventCount: sessionMatch.usageEventCount
      }
    };
  }

  return {
    accepted: false,
    status: "pending",
    reason: "no_account_history_match",
    checked: { accountIds, sessionIds, missingSessionIds: sessionMatch.missingSessionIds || [] }
  };
}
