import { computeSessionSummary } from "./billing.js";

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

function numberOrNull(value){
  if(value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function centsValue(value){
  if(value && typeof value === "object" && !Array.isArray(value)) return numberOrNull(value.cents);
  return numberOrNull(value);
}

function normalizeComputedInvoice(summary){
  const lines = summary.lines.map(line => ({
    item_id: line.item_id,
    description: line.label,
    seconds: line.seconds,
    live_seconds: line.live_seconds,
    recovery_adjustment_seconds: line.recovery_adjustment_seconds,
    quantity: line.quantity,
    quantity_unit: line.quantity_unit,
    auto_increment_by: line.auto_increment_by,
    unit_price_cents: line.unit_price.cents,
    line_total_cents: line.cost.cents
  }));

  return {
    session_id: summary.session.id,
    account_id: summary.session.account_id,
    seat_id: summary.session.seat_id,
    currency: summary.total.currency || "CAD",
    lines,
    totals: {
      intelligence_seconds: summary.metrics.intelligence_seconds,
      live_tick_seconds: summary.metrics.live_tick_seconds,
      recovery_adjustment_seconds: summary.metrics.recovery_adjustment_seconds,
      tracked_quantity: summary.metrics.tracked_quantity,
      subtotal_cents: summary.total.cents,
      total_cents: summary.total.cents
    }
  };
}

function payloadLines(payload){
  const body = objectValue(payload);
  return Array.isArray(body.lines) ? body.lines.map(objectValue) : [];
}

function compareValues(mismatches, field, expected, actual){
  if(actual !== expected) mismatches.push({ field, expected, actual });
}

function compareInvoicePayload(payload, computedInvoices){
  const mismatches = [];
  const body = objectValue(payload);
  const computedByItem = new Map();
  const expectedItemIds = [];
  let expectedSeconds = 0;
  let expectedQuantity = 0;
  let expectedSubtotal = 0;
  let expectedTotal = 0;

  for(const invoice of computedInvoices){
    expectedSeconds += invoice.totals.intelligence_seconds;
    expectedQuantity += invoice.totals.tracked_quantity;
    expectedSubtotal += invoice.totals.subtotal_cents;
    expectedTotal += invoice.totals.total_cents;
    for(const line of invoice.lines){
      expectedItemIds.push(line.item_id);
      const existing = computedByItem.get(line.item_id) || {
        item_id: line.item_id,
        seconds: 0,
        quantity: 0,
        unit_price_cents: line.unit_price_cents,
        line_total_cents: 0
      };
      existing.seconds += line.seconds;
      existing.quantity += line.quantity;
      existing.line_total_cents += line.line_total_cents;
      computedByItem.set(line.item_id, existing);
    }
  }

  const actualLines = payloadLines(payload);
  const actualItemIds = actualLines.map(line => stringValue(line.item_id)).filter(Boolean).sort();
  const sortedExpected = [...expectedItemIds].sort();
  if(JSON.stringify(actualItemIds) !== JSON.stringify(sortedExpected)){
    mismatches.push({ field: "lines.item_id", expected: sortedExpected, actual: actualItemIds });
  }

  for(const line of actualLines){
    const itemId = stringValue(line.item_id);
    if(!itemId) continue;
    const expected = computedByItem.get(itemId);
    if(!expected) continue;
    compareValues(mismatches, `lines.${itemId}.seconds`, expected.seconds, numberOrNull(line.seconds));
    compareValues(mismatches, `lines.${itemId}.quantity`, expected.quantity, numberOrNull(line.quantity));
    compareValues(mismatches, `lines.${itemId}.unit_price_cents`, expected.unit_price_cents, centsValue(line.unit_price_cents ?? line.unit_price));
    compareValues(mismatches, `lines.${itemId}.line_total_cents`, expected.line_total_cents, centsValue(line.line_total_cents ?? line.total_cents ?? line.cost));
  }

  compareValues(mismatches, "totals.intelligence_seconds", expectedSeconds, numberOrNull(body.totals?.intelligence_seconds ?? body.intelligence_seconds));
  compareValues(mismatches, "totals.tracked_quantity", expectedQuantity, numberOrNull(body.totals?.tracked_quantity ?? body.tracked_quantity));
  compareValues(mismatches, "totals.subtotal_cents", expectedSubtotal, centsValue(body.totals?.subtotal_cents ?? body.subtotal_cents));
  compareValues(mismatches, "totals.total_cents", expectedTotal, centsValue(body.totals?.total_cents ?? body.total_cents));

  return {
    matched: mismatches.length === 0,
    mismatches,
    computed: computedInvoices,
    expected: {
      sessionIds: computedInvoices.map(invoice => invoice.session_id),
      lineItemIds: [...expectedItemIds].sort(),
      intelligence_seconds: expectedSeconds,
      tracked_quantity: expectedQuantity,
      subtotal_cents: expectedSubtotal,
      total_cents: expectedTotal
    }
  };
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

  const summaries = sessionIds.map(id => computeSessionSummary(db, id)).filter(Boolean);
  const usageEventCount = sessionIds.reduce((count, id) => {
    const row = db.prepare("SELECT COUNT(*) AS count FROM usage_events WHERE session_id=?").get(id);
    return count + Number(row?.count || 0);
  }, 0);

  return {
    matched: true,
    sessionIds,
    usageEventCount,
    computedInvoices: summaries.map(normalizeComputedInvoice)
  };
}

export function normalizedServerInvoicePayload(payload, verification){
  const computed = verification?.checked?.computedInvoices;
  if(!Array.isArray(computed) || computed.length === 0) return payload;
  const base = objectValue(payload);
  const normalized = computed.length === 1
    ? { ...base, ...computed[0] }
    : {
        ...base,
        sessions: computed.map(invoice => ({ session_id: invoice.session_id, account_id: invoice.account_id, totals: invoice.totals })),
        lines: computed.flatMap(invoice => invoice.lines),
        totals: verification.checked.computedExpected
      };
  normalized.server_computed = true;
  return normalized;
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
    const comparison = compareInvoicePayload(payload, sessionMatch.computedInvoices);
    const checked = {
      accountIds,
      sessionIds: sessionMatch.sessionIds,
      usageEventCount: sessionMatch.usageEventCount,
      computedInvoices: sessionMatch.computedInvoices,
      computedExpected: comparison.expected,
      mismatches: comparison.mismatches
    };

    if(!comparison.matched){
      return {
        accepted: false,
        status: "rejected",
        reason: "invoice_payload_mismatch",
        checked
      };
    }

    return {
      accepted: true,
      status: "accepted",
      verificationMethod: "account_history_server_computed",
      reason: "matched_account_session_history_and_server_computed_totals",
      checked
    };
  }

  return {
    accepted: false,
    status: "pending",
    reason: "no_account_history_match",
    checked: { accountIds, sessionIds, missingSessionIds: sessionMatch.missingSessionIds || [] }
  };
}
