import fs from "fs";

function decodeEntities(str){
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"');
}

function textBetween(html, startIdx, endIdx){
  const slice = html.slice(startIdx, endIdx);
  return decodeEntities(slice.replace(/<[^>]+>/g, "").trim());
}

function parseMoneyToCents(s){
  const m = (s || "").match(/\$\s*([0-9]+(?:\.[0-9]{1,2})?)/);
  if(!m) return null;
  const v = Number(m[1]);
  if(Number.isNaN(v)) return null;
  return Math.round(v * 100);
}

export function parseInvoiceCatalog(invoiceHtmlPath){
  const html = fs.readFileSync(invoiceHtmlPath, "utf-8");
  const headerIdx = html.search(/>\s*Description\s*</i);
  if(headerIdx === -1) return [];

  const afterHeader = html.slice(headerIdx);
  const rows = afterHeader.split(/<tr/i).slice(1);

  const items = [];
  for(const row of rows){
    if(/>\s*Subtotal\s*</i.test(row) || />\s*Notes:\s*</i.test(row)) break;

    const cells = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let m;
    while((m = tdRe.exec(row)) !== null){
      cells.push(m[1]);
    }
    if(cells.length < 7) continue;

    const label = textBetween(cells[1], 0, cells[1].length);
    const qty = Number(textBetween(cells[4], 0, cells[4].length)) || 0;
    const unitPriceCents = parseMoneyToCents(textBetween(cells[5], 0, cells[5].length));
    if(!label || unitPriceCents === null) continue;

    const id = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 120);

    items.push({
      id,
      label,
      default_qty: qty,
      unit_price_cents: unitPriceCents,
      currency: "CAD",
      unit_name: "second",
      quantity_mode: "seconds",
      auto_increment_by: 1
    });
  }

  const seen = new Set();
  return items.filter(it => (seen.has(it.id) ? false : (seen.add(it.id), true)));
}
