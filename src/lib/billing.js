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

  const items = db.prepare("SELECT * FROM catalog_items").all();
  const itemMap = new Map(items.map(i=>[i.id,i]));

  const usage = db.prepare(`
    SELECT item_id, SUM(seconds) AS seconds
    FROM usage_events
    WHERE session_id=?
    GROUP BY item_id
  `).all(sessionId);

  let totalCents = 0;
  let totalSeconds = 0;
  let totalQuantity = 0;

  const lines = usage.map(u => {
    const item = itemMap.get(u.item_id);
    const unit = item?.unit_price_cents ?? 0;
    const seconds = u.seconds || 0;
    const quantity = normalizeQuantity(item, seconds);
    const costCents = unit * quantity;
    totalCents += costCents;
    totalSeconds += seconds;
    totalQuantity += quantity;
    return {
      item_id: u.item_id,
      label: item?.label ?? "(unknown item)",
      seconds,
      quantity,
      default_qty: item?.default_qty ?? 0,
      quantity_unit: item?.unit_name ?? "second",
      quantity_mode: item?.quantity_mode ?? "seconds",
      auto_increment_by: item?.auto_increment_by ?? 1,
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
      tracked_quantity: totalQuantity,
      quantity_unit: "second"
    },
    lines,
    total: centsToMoney(totalCents, "CAD")
  };
}
