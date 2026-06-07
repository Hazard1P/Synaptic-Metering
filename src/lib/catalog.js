import { parseInvoiceCatalog } from "./invoiceParser.js";

/**
 * Upserts invoice-derived catalog items into DB (id, label, price).
 * Returns the current catalog list from DB.
 */
export function refreshCatalog(db){
  const invoicePath = process.env.INVOICE_TEMPLATE_PATH || "./templates/Invoice.html";
  const items = parseInvoiceCatalog(invoicePath);

  const upsert = db.prepare(`
    INSERT INTO catalog_items (
      id, label, unit_price_cents, currency, source,
      default_qty, unit_name, quantity_mode, auto_increment_by
    )
    VALUES (
      @id, @label, @unit_price_cents, @currency, 'invoice',
      @default_qty, @unit_name, @quantity_mode, @auto_increment_by
    )
    ON CONFLICT(id) DO UPDATE SET
      label=excluded.label,
      unit_price_cents=excluded.unit_price_cents,
      currency=excluded.currency,
      default_qty=excluded.default_qty,
      unit_name=excluded.unit_name,
      quantity_mode=excluded.quantity_mode,
      auto_increment_by=excluded.auto_increment_by
  `);

  const tx = db.transaction((rows) => {
    for(const it of rows) upsert.run(it);
  });

  tx(items);

  return db.prepare(`
    SELECT id, label, unit_price_cents, currency, source, created_at,
           default_qty, unit_name, quantity_mode, auto_increment_by
    FROM catalog_items
    ORDER BY id
  `).all();
}
