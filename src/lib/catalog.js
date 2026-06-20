import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseInvoiceCatalog } from "./invoiceParser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CATALOG_PATH = path.resolve(__dirname, "../catalog.json");

function normalizeCatalogItem(item, catalog){
  return {
    id: item.id,
    label: item.label,
    unit_price_cents: item.unit_price_cents,
    currency: item.currency || catalog.currency || "CAD",
    source: catalog.source || "catalog_json",
    default_qty: item.default_qty ?? 0,
    unit_name: item.unit_name || "second",
    quantity_mode: item.quantity_mode || "seconds",
    auto_increment_by: item.auto_increment_by ?? 1,
    effective_from: item.effective_from || catalog.effective_from || null,
    effective_to: item.effective_to || catalog.effective_to || null,
    version: item.version || catalog.catalog_version || catalog.version,
    active: item.active === false ? 0 : 1
  };
}

export function loadStructuredCatalog(catalogPath = process.env.CATALOG_PATH || DEFAULT_CATALOG_PATH){
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
  const items = Array.isArray(catalog.items) ? catalog.items : [];
  return items.map(item => normalizeCatalogItem(item, catalog));
}

/**
 * Migration helper for importing prices from the legacy invoice template.
 * Production catalog refreshes should use loadStructuredCatalog/refreshCatalog.
 */
export function loadInvoiceTemplateCatalog(invoicePath = process.env.INVOICE_TEMPLATE_PATH || "./templates/Invoice.html"){
  return parseInvoiceCatalog(invoicePath).map(item => normalizeCatalogItem(item, {
    source: "invoice_migration",
    catalog_version: "invoice-template-import",
    effective_from: null,
    effective_to: null,
    currency: "CAD"
  }));
}

/**
 * Upserts structured catalog items into DB. invoiceParser remains available only
 * through loadInvoiceTemplateCatalog for one-off migrations/imports.
 */
export function refreshCatalog(db, items = loadStructuredCatalog()){
  const upsert = db.prepare(`
    INSERT INTO catalog_items (
      id, label, unit_price_cents, currency, source,
      default_qty, unit_name, quantity_mode, auto_increment_by,
      effective_from, effective_to, version, active
    )
    VALUES (
      @id, @label, @unit_price_cents, @currency, @source,
      @default_qty, @unit_name, @quantity_mode, @auto_increment_by,
      @effective_from, @effective_to, @version, @active
    )
    ON CONFLICT(id) DO UPDATE SET
      label=excluded.label,
      unit_price_cents=excluded.unit_price_cents,
      currency=excluded.currency,
      source=excluded.source,
      default_qty=excluded.default_qty,
      unit_name=excluded.unit_name,
      quantity_mode=excluded.quantity_mode,
      auto_increment_by=excluded.auto_increment_by,
      effective_from=excluded.effective_from,
      effective_to=excluded.effective_to,
      version=excluded.version,
      active=excluded.active
  `);

  const tx = db.transaction((rows) => {
    for(const it of rows) upsert.run(it);
  });

  tx(items);

  return db.prepare(`
    SELECT id, label, unit_price_cents, currency, source, created_at,
           default_qty, unit_name, quantity_mode, auto_increment_by,
           effective_from, effective_to, version, active
    FROM catalog_items
    ORDER BY id
  `).all();
}
