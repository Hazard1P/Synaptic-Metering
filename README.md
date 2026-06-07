# Synaptics.Systems — Seconds Metering API (Branded)

This service does 3 things:

1) **Catalog API**: reads your invoice template and exposes a normalized list of billable items (the “Quantity boxes” rows in the invoice).
2) **Seconds Metering**: creates sessions and tracks per-second usage against a catalog item.
3) **NDSP Compatibility**: implements the endpoints that your NDPS/NDSP Genesis Core HTML expects:
   - `GET /ndsp/state`
   - `POST /ndsp/telemetry`

> Works offline-first: the server stores no personal identifiers by default. You can add external IDs as *optional* fields if your compliance program needs them.

---

## Quick Start (local)

```bash
cd synaptics-seconds-api
cp .env.example .env
npm i
npm run migrate
npm run dev
```

Test:

```bash
curl -H "x-api-key: dev-key-1" http://localhost:8080/health
curl -H "x-api-key: dev-key-1" http://localhost:8080/catalog
```

---

## Docker Deploy

```bash
docker compose up -d --build
```

---

## Main Endpoints (API)

### Auth
All non-public endpoints require:

- `x-api-key: <key>` header. Keys are configured with `API_KEYS` in `.env`.
- Legacy entries are still accepted as comma-separated raw keys, for example `API_KEYS=dev-key-1,dev-key-2`. Each legacy key becomes its own authenticated account with full `*` scope and an account id equal to the key value.
- Scoped multi-tenant entries use `key-id:secret:account-id:scope+scope`, separated by commas. Example:

```dotenv
API_KEYS=acct-a-key:secret-a:acct_a:catalog:read+sessions:read+sessions:write+invoices:write+telemetry:read+telemetry:write
```

The server converts the matched API key into `req.auth = { accountId, keyId, scopes }`. Supported scopes are:

- `*` — full access for the authenticated account
- `catalog:read` / `catalog:write`
- `sessions:read` / `sessions:write`
- `invoices:write`
- `telemetry:read` / `telemetry:write`

### Account boundaries

API keys are account-bound. Session creation always stores the authenticated account id on the session; clients cannot create sessions for another account by posting a different `account_id`. All session lifecycle routes, session summaries, invoice generation from sessions, NDSP state lookups with a `session_id`, and NDSP telemetry submissions with a `session_id` first load the session and require `session.account_id === req.auth.accountId`. Cross-account access is rejected with `403`.

NDSP telemetry is account-scoped. New telemetry rows store the authenticated `account_id` and, when supplied, the owned `session_id` alongside the JSON payload.

### Catalog
- `GET /catalog` — list billable items parsed from the invoice template

### Sessions & Seconds
- `POST /sessions` — create session
- `POST /sessions/:id/start` — start metering an item (one at a time)
- `POST /sessions/:id/heartbeat` — add seconds (client calls every second)
- `POST /sessions/:id/stop` — stop current item
- `GET /sessions/:id/summary` — seconds + cost by item

### NDSP Genesis Core compatibility
- `GET /ndsp/state`
- `POST /ndsp/telemetry`

---

## Invoice Template Parsing
Set `INVOICE_TEMPLATE_PATH` to your exported invoice HTML (Google Sheets export style).

The parser:
- finds the row where `Description / Qty / Unit price / Total price` appear
- reads subsequent rows until the subtotal area
- extracts:
  - item label (column B)
  - unit price (column F)
  - default qty (column E)
  - computes a `rate_per_second` (unit price is already shown as per-second in the invoice)

---

## Production Notes
- Put this behind HTTPS (Cloudflare / Nginx / Caddy).
- Rotate API keys, one per client.
- If you need multi-tenant billing, use `account_id` and `seat_id` fields (already supported in schema).


---

## Synaptics Branding
This bundle includes a branded landing page at `/` and a logo asset at `/public/synaptics-logo.svg`.


## Console UI
After starting the server, open:
- `http://localhost:8080/console` (NDSP Genesis Seconds Console)
- `http://localhost:8080/templates/Invoice.html` (invoice auto-fill)


## Server Notes / Fixes Applied
- Removed packaged `node_modules` from the deliverable. Reinstall dependencies on the target machine so native modules like `better-sqlite3` compile for that OS/CPU.
- Docker build now copies `public/`, `templates/`, and `data/`.
- Container startup now runs migrations before starting the API.
- Added `.dockerignore` to keep the image clean.

## Clean Local Server Start
```bash
cp .env.example .env
rm -rf node_modules package-lock.json
npm install
node src/db/migrate.js
node src/server.js
```

## Clean Docker Server Start
```bash
docker compose up -d --build
```

If you see an `invalid ELF header` error, the project was copied with `node_modules` built on a different machine (for example macOS -> Linux). Delete `node_modules` and reinstall on the target server.


## Auto-tracked Quantity
- Heartbeats still add `seconds`, but invoice quantity now auto-increases from the accumulated metered seconds.
- Each invoice line now includes `quantity`, `quantity_unit`, and `auto_increment_by`.
- `GET /sessions/:id/summary` now returns `metrics.intelligence_seconds` and `metrics.tracked_quantity`.
- `POST /invoices/from-session` now emits invoice totals with both total metered seconds and tracked quantity.


## Genesis integration

This build adds `/genesis`, which serves the uploaded **NDPS Genesis Core** page with an integrated **activity-based thinking meter**. It does not attempt to read literal thoughts. Instead, it meters billable seconds while the browser page is actively being used (mouse, keyboard, scroll, focus) and pauses on idle.

### Routes
- `/genesis` — integrated Genesis page with live activity meter
- `/console` — console with seconds, quantity, total, and launch link to Genesis
- `/ndsp/state?session_id=sess_...` — returns NDSP policy/state plus optional meter summary

### Notes
- Enter your API key in the Genesis overlay once. It is stored in localStorage for the browser.
- Start the thinking meter, then interact with the page. Quantity and invoice totals will rise as active seconds are recorded.
- When activity stops for ~5 seconds, the page pauses metering automatically.
