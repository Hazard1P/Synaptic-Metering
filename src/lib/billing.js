export function centsToMoney(cents, currency="CAD"){
  return { cents, currency, amount: (cents/100).toFixed(2) };
}

function normalizeQuantity(item, seconds){
  const increment = Number(item?.auto_increment_by ?? 1) || 1;
  const quantityMode = item?.quantity_mode ?? "seconds";
  if(quantityMode === "seconds"){
    return seconds * increment;
  }
  return seconds;
}

export function computeSessionSummary(db, sessionId){
  const session = db.prepare("SELECT * FROM sessions WHERE id=?").get(sessionId);
  if(!session) return null;

  const items = db.prepare("SELECT * FROM catalog_items WHERE active = 1").all();
  const itemMap = new Map(items.map(i=>[i.id,i]));

  const usage = db.prepare(`
    SELECT
      item_id,
      SUM(seconds) AS seconds,
      SUM(CASE WHEN COALESCE(event_kind, 'live_tick') = 'live_tick' THEN seconds ELSE 0 END) AS live_seconds,
      SUM(CASE WHEN event_kind = 'recovery_adjustment' THEN seconds ELSE 0 END) AS recovery_adjustment_seconds
    FROM usage_events
    WHERE session_id=?
    GROUP BY item_id
  `).all(sessionId);

  let totalCents = 0;
  let totalSeconds = 0;
  let totalQuantity = 0;
  let totalLiveSeconds = 0;
  let totalRecoverySeconds = 0;

  const lines = usage.map(u => {
    const item = itemMap.get(u.item_id);
    const unit = item?.unit_price_cents ?? 0;
    const seconds = u.seconds || 0;
    const liveSeconds = u.live_seconds || 0;
    const recoveryAdjustmentSeconds = u.recovery_adjustment_seconds || 0;
    const quantity = normalizeQuantity(item, seconds);
    const costCents = unit * quantity;
    totalCents += costCents;
    totalSeconds += seconds;
    totalLiveSeconds += liveSeconds;
    totalRecoverySeconds += recoveryAdjustmentSeconds;
    totalQuantity += quantity;
    return {
      item_id: u.item_id,
      label: item?.label ?? "(unknown item)",
      seconds,
      live_seconds: liveSeconds,
      recovery_adjustment_seconds: recoveryAdjustmentSeconds,
      quantity,
      default_qty: item?.default_qty ?? 0,
      quantity_unit: item?.unit_name ?? "second",
      quantity_mode: item?.quantity_mode ?? "seconds",
      auto_increment_by: item?.auto_increment_by ?? 1,
      catalog_version: item?.version ?? "legacy",
      catalog_effective_from: item?.effective_from ?? null,
      catalog_effective_to: item?.effective_to ?? null,
      catalog_source: item?.source ?? null,
      price_snapshot: {
        item_id: u.item_id,
        label: item?.label ?? "(unknown item)",
        unit_price_cents: unit,
        currency: item?.currency ?? "CAD",
        version: item?.version ?? "legacy",
        effective_from: item?.effective_from ?? null,
        effective_to: item?.effective_to ?? null,
        source: item?.source ?? null
      },
      unit_price: centsToMoney(unit, item?.currency ?? "CAD"),
      cost: centsToMoney(costCents, item?.currency ?? "CAD"),
    };
  });

  return {
    session: {
      id: session.id,
      account_id: session.account_id,
      seat_id: session.seat_id,
      status: session.status,
      created_at: session.created_at,
      closed_at: session.closed_at,
      current_item_id: session.current_item_id,
      current_item_started_at: session.current_item_started_at
    },
    metrics: {
      intelligence_seconds: totalSeconds,
      live_tick_seconds: totalLiveSeconds,
      recovery_adjustment_seconds: totalRecoverySeconds,
      tracked_quantity: totalQuantity,
      quantity_unit: "second"
    },
    lines,
    catalog_versions: [...new Set(lines.map(l => l.catalog_version).filter(Boolean))],
    catalog_snapshot: lines.map(l => l.price_snapshot),
    total: centsToMoney(totalCents, "CAD")
  };
}
