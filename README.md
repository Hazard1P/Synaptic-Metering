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
npm i
export API_KEY=dev-key-1
export API_KEY_DIGESTS=$(printf %s "$API_KEY" | sha256sum | awk '{print $1}')
export CORS_ORIGINS=http://localhost:8080
npm run migrate
npm run dev
```

Test:

```bash
curl http://localhost:8080/health
curl -H "x-api-key: $API_KEY" http://localhost:8080/catalog
```

---

## Docker Deploy

```bash
export API_KEY='replace-with-a-generated-secret'
export API_KEY_DIGESTS=$(printf %s "$API_KEY" | sha256sum | awk '{print $1}')
export CORS_ORIGINS=https://metering.example.com
export PUBLIC_BASE_URL=https://metering.example.com
export TRUST_PROXY=true
docker compose up -d --build
```

`docker-compose.yml` intentionally has no production API-key default. Inject `API_KEY_DIGESTS`, `CORS_ORIGINS`, and `PUBLIC_BASE_URL` through your deployment secret manager, CI/CD environment, or an uncommitted `.env` file.

---

## Main Endpoints (API)

### Auth
Non-public API endpoints require one of:

- `x-api-key: <key>` header. Store only comma-separated SHA-256 key digests in `API_KEY_DIGESTS`; do not store raw API keys in environment variables or config files.
- A logged-in account session cookie created through `GET /auth/google/start`. Visitor-facing web pages should prefer this account flow; API keys are for administrative and integration clients.

### Developer API-key examples

The public `/` page is an account entry point for SynapticSystems.ca visitors. Keep API-key and curl examples here in the README for administrators and developers:

```bash
curl http://localhost:8080/health
curl -H "x-api-key: $API_KEY" http://localhost:8080/catalog
```

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

## Google OAuth account linking

This service supports first-class internal accounts linked to Google OAuth identities. The internal `accounts.id` is the stable account used for metering sessions. Google `sub` is stored in `account_identities.provider_subject` as the stable external identity; email is treated as mutable metadata and is refreshed from verified Google ID token claims on each login.

### OAuth routes
- `GET /auth/google/start` — starts the Google OAuth authorization-code flow.
- `GET /auth/google/callback` — exchanges the code, verifies the Google ID token, links or creates the internal account, and creates the HTTP-only account session cookie.
- `POST /auth/logout` — deletes the current web auth session and clears the session cookie.
- `GET /me` — returns the authenticated internal account and linked identities.

### Required environment variables

```bash
GOOGLE_CLIENT_ID=your-google-oauth-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-google-oauth-client-secret
GOOGLE_REDIRECT_URI=https://your-domain.example/auth/google/callback
PUBLIC_BASE_URL=https://your-domain.example
TOKEN_ENCRYPTION_KEY=base64-or-hex-32-byte-key-material
```

Optional OAuth/session configuration:

```bash
GOOGLE_ALLOWED_DOMAINS=example.com,subsidiary.example
GOOGLE_OAUTH_RETAIN_TOKENS=false
GOOGLE_OAUTH_PROMPT=select_account
OAUTH_SUCCESS_REDIRECT=/me
OAUTH_STATE_SECRET=separate-hmac-secret-if-not-using-token-key
SESSION_COOKIE_NAME=syn_meter_session
AUTH_SESSION_TTL_DAYS=30
COOKIE_SECURE=true
```

Set `GOOGLE_ALLOWED_DOMAINS` to restrict logins by Google hosted domain or email domain. Set `GOOGLE_OAUTH_RETAIN_TOKENS=true` only if the app needs retained Google token material; retained access/refresh tokens are encrypted with `TOKEN_ENCRYPTION_KEY`.

## Production Notes
- Put this behind HTTPS (Cloudflare / Nginx / Caddy). The API enforces HTTPS when `NODE_ENV=production`; set `TRUST_PROXY=true` when TLS terminates at a reverse proxy that forwards `X-Forwarded-Proto: https`.
- Set `CORS_ORIGINS` to a comma-separated allowlist of exact browser origins that may call the API. Avoid wildcard origins in production.
- Rotate API keys, one per client, and keep only their SHA-256 digests in `API_KEY_DIGESTS`. Generate digests with `printf %s "$API_KEY" | sha256sum | awk '{print $1}'`.
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
rm -rf node_modules package-lock.json
npm install
export API_KEY=dev-key-1
export API_KEY_DIGESTS=$(printf %s "$API_KEY" | sha256sum | awk '{print $1}')
export CORS_ORIGINS=http://localhost:8080
node src/db/migrate.js
node src/server.js
```

## Clean Docker Server Start
```bash
export API_KEY='replace-with-a-generated-secret'
export API_KEY_DIGESTS=$(printf %s "$API_KEY" | sha256sum | awk '{print $1}')
export CORS_ORIGINS=https://metering.example.com
export PUBLIC_BASE_URL=https://metering.example.com
export TRUST_PROXY=true
docker compose up -d --build
```

`docker-compose.yml` intentionally has no production API-key default. Inject `API_KEY_DIGESTS`, `CORS_ORIGINS`, and `PUBLIC_BASE_URL` through your deployment secret manager, CI/CD environment, or an uncommitted `.env` file.

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
- Enter your API key in the Genesis overlay once per tab/session. It is stored only in sessionStorage and is cleared when the browser session ends.
- Start the thinking meter, then interact with the page. Quantity and invoice totals will rise as active seconds are recorded.
- When activity stops for ~5 seconds, the page pauses metering automatically.

## Security Baseline

### Transport encryption
- TLS is required for production deployments. Run the Node service behind a TLS-terminating proxy or load balancer and set `NODE_ENV=production`.
- Set `TRUST_PROXY=true` only when the proxy is trusted and configured to pass `X-Forwarded-Proto`; production HTTP requests without `https` are rejected with `https_required`.
- Set `PUBLIC_BASE_URL` to the public `https://` origin clients should use.

### API keys and rotation
- Raw API keys must not be committed, baked into Docker images, or stored in environment variables. Store SHA-256 digests in `API_KEY_DIGESTS` and send the raw key only from the client in the `x-api-key` header.
- Use one key per client or integration. To rotate, add the new digest, deploy, move the client to the new key, then remove the old digest and deploy again.
- API-key comparisons are performed against SHA-256 digests using Node's timing-safe comparison.

### Data at rest
- Current SQLite tables store metering/session identifiers and telemetry payloads, not raw API keys, OAuth refresh tokens, payment secrets, or other account secrets. First-pass baseline therefore relies on encrypted host volumes/disks, least-privileged file access, and backups encrypted by the deployment platform.
- Do not add sensitive account/OAuth fields to SQLite until SQLCipher or field-level envelope encryption is integrated. Setting `DB_ENCRYPTION_REQUIRED=true` intentionally fails fast in this build to prevent a false sense of encryption.

### Browser secret handling
- Browser pages must not persist API keys in `localStorage`, IndexedDB, cookies without strict security attributes, or other long-lived client storage.
- The included console and Genesis page use `sessionStorage` only as a temporary compatibility bridge. Prefer a backend-issued short-lived token/session flow before exposing these pages to untrusted users.

### Production assumptions
- Deploy behind a trusted reverse proxy that terminates TLS, forwards `X-Forwarded-Proto`, and restricts administrative access.
- Inject `API_KEY_DIGESTS`, `CORS_ORIGINS`, and `PUBLIC_BASE_URL` through a secret manager or deployment environment.
- Use encrypted persistent volumes and encrypted backups for `DATABASE_PATH`.
