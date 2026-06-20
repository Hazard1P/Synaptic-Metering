# Synaptics.Systems — Seconds Metering API (Branded)

This service does 3 things:

1) **Catalog API**: reads your invoice template and exposes a normalized list of billable items (the “Quantity boxes” rows in the invoice).
2) **Seconds Metering**: creates sessions and tracks per-second usage against a catalog item.
3) **NDSP Compatibility**: implements the endpoints that your NDPS/NDSP Genesis Core HTML expects:
   - `GET /ndsp/state`
   - `POST /ndsp/telemetry`
4) **Anchored Intelligence Governance**: exposes the permanent non-extractive intelligence anchors used by the 1 Hz Seconds Of Intelligence metering model, including Major Ursa, Cassiopeia, and isolated blackhole mesh references.

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

### Admin database
All `/admin/*` routes require an admin account session or a trusted API key. Account sessions must belong to an account whose `accounts.role` is `admin`; API-key callers are treated as trusted administrative/integration clients.

- `GET /admin/accounts` — list internal accounts and roles.
- `PATCH /admin/accounts/:id/role` — promote or demote an account by setting `role` in the JSON body to one of the existing `accounts.role` values: `user` or `admin`.
- `GET /admin/accounts/:id/identities` — view the OAuth identities linked to one account for support/admin workflows. The response includes identity metadata such as provider, provider subject, email, verification status, and timestamps, but excludes OAuth access and refresh token data.
- `GET /admin/account-identities` — view linked OAuth identity metadata across all accounts for support/admin workflows, also excluding OAuth access and refresh token data.
- `GET /admin/reports/quarterly?year=YYYY&quarter=1-4` — generate a private quarterly admin report. Requires an admin account session or trusted API key plus the `reports:read` scope when scopes are enforced. The report aggregates `usage_events`, `sessions`, `catalog_items`, and `invoices` for the requested UTC quarter and returns metered seconds, invoice quantity, subtotal/total cents, sessions by account, invoice counts by status, and map/intelligence anchor IDs or network keys present in invoice payloads. Do not expose this response through public routes because it can include account and internal business metadata.
- `GET /admin/project-search?q=<term>` — search repository-owned source and documentation files from the operator console or API. Requires an admin account session or trusted API key plus the `project:read` scope when scopes are enforced. Queries are Unicode-normalized, trimmed, whitespace-collapsed, matched literally/case-insensitively, and must be at least 2 characters. Responses include `query`, `count`, `truncated`, `limits`, `stats`, and `results[]` objects with `path`, `line`, and a short matched `excerpt`. Results are capped at 50 matches and files over 512 KiB are skipped. The searcher excludes dependency/generated/private locations and file types, including `node_modules`, `.git`, `.cache`, `coverage`, `dist`, `build`, `tmp`, `logs`, SQLite/database files, logs, archives, binary images/PDFs, keys/certificates, lockfiles, and secret environment files such as `.env*`.

Example quarterly report:

```bash
curl -H "x-api-key: $API_KEY" \
  "http://localhost:8080/admin/reports/quarterly?year=2026&quarter=2"
```


Example project search:

```bash
curl -H "x-api-key: $API_KEY" \
  "http://localhost:8080/admin/project-search?q=catalog"
```

Browser operators can also open `/console`, sign in with an admin Google account, and use the **Admin Project Search** panel. Non-admin account sessions receive `admin_required`; unauthenticated or invalid API-key requests are rejected by the same `/admin/*` authentication pattern as the other admin endpoints.

Example role update:

```bash
curl -X PATCH -H "x-api-key: $API_KEY" -H "content-type: application/json" \
  -d '{"role":"admin"}' http://localhost:8080/admin/accounts/acct_123/role
```

Seed or promote a local admin account during migration with:

```bash
ADMIN_ACCOUNT_ID=acct_admin ADMIN_DISPLAY_NAME="Synaptics Admin" npm run migrate
```

### Anchored Intelligence
- `GET /intelligence/anchors` — public description of the permanent anchored asset map used for 1 tick/second intelligence metering.
- `GET /intelligence/state` — authenticated state payload for `Seconds_Of_Intelligence`, including the five-day rolling Unix epoch, invoice A1 key, optional network `master_key`, and moderation status.
- `GET /map/authenticate/:mapId` — returns the stored SHA-256 digest authentication record for a static map asset. Public callers receive only minimal public metadata; callers with an account session or `x-api-key` receive the full stored metadata, anchor asset id, digest, and verification status. Map digests are stored in SQLite in `map_assets`.
- `GET /map/server` — returns the public map server identity for `dyson-sphere-ring-1`, combining the map database status, public digest authentication, `server_role: "map_database_reference_anchor"`, `operation: "Seconds_Of_Intelligence"`, `tick_rate_hz: 1`, canonical public URLs derived from `PUBLIC_BASE_URL`, and digest/verification fields from `map_assets`. The embedded authentication record uses the same public metadata filtering as `/map/authenticate/:mapId`, so private metadata remains hidden from public callers.
- `GET /map/database?anchor_id=<anchorId>` — returns the active map database status for an anchor. The canonical map asset schema uses `map_assets.map_id`, `anchor_asset_id`, `digest`, `verification_status`, `metadata_json`, `created_at`, and `updated_at`; loaders parse display metadata from `metadata_json` and return `star_systems: []` when the optional `map_star_systems` table is not present.
  - Map status responses preserve the relative `physical_map_image_url` (currently `/public/dyson-sphere-ring-1-map.svg`) for backward compatibility.
  - When `PUBLIC_BASE_URL` is configured, map status responses also include absolute public URL fields: `canonical_map_url`, `map_database_url`, `map_authentication_url`, and `physical_map_image_url_absolute`. The service normalizes `PUBLIC_BASE_URL` by removing trailing slashes before building these URLs for the `dyson-sphere-ring-1` anchor.

The service treats Major Ursa, Cassiopeia, and isolated blackholes as permanent universe-mesh reference assets: they are considered in data/physics and governance calculations, but they are not extracted or “pulled through” into customer records. The A1 invoice key binds a single invoice to `Operation:(Seconds_Of_Intelligence)`. A `master_key` represents the network genesis core and is intentionally not tied to one invoice.

### Catalog
- `GET /catalog` — list billable items parsed from the invoice template

### Sessions & Seconds
- `POST /sessions` — create session
- `POST /sessions/:id/start` — start metering an item (one at a time)
- `POST /sessions/:id/heartbeat` — record one live metered second per call; optional `recovered_seconds` records a separate recovery adjustment for missed ticks
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
- `GET /me` — returns the authenticated internal account and linked identities. Business allowlist metadata is stored internally and is not returned by this public account route.

### Required environment variables

```bash
GOOGLE_CLIENT_ID=your-google-oauth-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-google-oauth-client-secret
GOOGLE_REDIRECT_URI=https://your-domain.example/auth/google/callback
PUBLIC_BASE_URL=https://your-domain.example
TOKEN_ENCRYPTION_KEY=base64-or-hex-32-byte-key-material
DB_AT_REST_ENCRYPTION=managed-encrypted-storage
STORAGE_ENCRYPTION_AT_REST=true
STORAGE_ENCRYPTION_PROVIDER=<provider-and-volume-control>
STORAGE_ENCRYPTION_EVIDENCE=<policy-url-ticket-or-runbook-section>
```

In production, startup validation fails fast with a `StartupConfigError` if any deployment-critical setting is missing. Required production settings are `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, either `PUBLIC_BASE_URL` or `GOOGLE_REDIRECT_URI`, `API_KEY_DIGESTS`, `CORS_ORIGINS`, and the managed encrypted storage attestation variables `DB_AT_REST_ENCRYPTION=managed-encrypted-storage`, `STORAGE_ENCRYPTION_AT_REST=true`, `STORAGE_ENCRYPTION_PROVIDER`, and `STORAGE_ENCRYPTION_EVIDENCE`. `PUBLIC_BASE_URL` must be an absolute `https://` URL in production. Each startup error names the missing or invalid variable and the feature it affects so platform logs point directly to the deployment fix.

The Google OAuth authorized redirect URI must exactly match the callback URL used by the app:

```text
https://<metering-origin-or-host-and-mounted-path>/auth/google/callback
```

Optional OAuth/session configuration:

```bash
GOOGLE_ALLOWED_DOMAINS=example.com,subsidiary.example
GOOGLE_ALLOWED_EMAILS=allowed-user@example.com,second-user@example.com
ADMIN_GOOGLE_EMAILS=admin-user@example.com
BUSINESS_GOOGLE_EMAILS=business-user@example.com
GOOGLE_OAUTH_RETAIN_TOKENS=false
GOOGLE_OAUTH_PROMPT=select_account
OAUTH_SUCCESS_REDIRECT=/me
OAUTH_STATE_SECRET=separate-hmac-secret-if-not-using-token-key
SESSION_COOKIE_NAME=syn_meter_session
AUTH_SESSION_TTL_DAYS=30
COOKIE_SECURE=true
```

Set `GOOGLE_ALLOWED_DOMAINS` to restrict logins by Google hosted domain or email domain. Set `GOOGLE_ALLOWED_EMAILS` only when login should be limited to a comma-separated list of verified Google identity emails. Set `ADMIN_GOOGLE_EMAILS` to bootstrap matching verified Google identities as internal `admin` accounts on login, and set `BUSINESS_GOOGLE_EMAILS` to record internal business-association metadata for matching verified identities. Keep these lists in the deployment secret manager or environment; do not commit real private emails. Business-association metadata is stored separately from encrypted OAuth token material and is not exposed by public routes such as `/me`. Set `GOOGLE_OAUTH_RETAIN_TOKENS=true` only if the app needs retained Google token material; retained access/refresh tokens are encrypted with `TOKEN_ENCRYPTION_KEY`.

## Production: SynapticSystems.ca web link

Use a dedicated HTTPS deployment URL for this metering app, then link to that URL from SynapticSystems.ca. The URL can be a metering subdomain such as `https://metering.SynapticSystems.ca` or a routed path such as `https://SynapticSystems.ca/metering`, but the value must match the public URL that browsers use to reach the deployed app.

Concrete production environment example:

```bash
PUBLIC_BASE_URL=https://<metering-subdomain-or-path>.SynapticSystems.ca
CORS_ORIGINS=https://SynapticSystems.ca,https://www.SynapticSystems.ca,<metering-origin>
GOOGLE_REDIRECT_URI=https://<metering-origin>/auth/google/callback
COOKIE_SECURE=true
TRUST_PROXY=true
NODE_ENV=production
DB_AT_REST_ENCRYPTION=managed-encrypted-storage
STORAGE_ENCRYPTION_AT_REST=true
STORAGE_ENCRYPTION_PROVIDER=<encrypted-block-volume-and-backup-control>
STORAGE_ENCRYPTION_EVIDENCE=<deployment-runbook-or-compliance-ticket>
GOOGLE_ALLOWED_EMAILS=<allowed-user@example.com>,<second-user@example.com>
ADMIN_GOOGLE_EMAILS=<admin-user@example.com>
BUSINESS_GOOGLE_EMAILS=<business-contact@example.com>
```

Replace `<metering-origin>` with the exact scheme and host that serves the app, for example `https://metering.SynapticSystems.ca`. If the app is mounted under a path, keep the origin in `CORS_ORIGINS` and include the mounted path in `PUBLIC_BASE_URL` and any reverse-proxy routing.

### Search indexing and discovery

The app exposes search-engine discovery files at the deployment root:

- `GET /robots.txt` allows crawling and points crawlers at the sitemap.
- `GET /sitemap.xml` lists the public deployment URLs for `/`, `/console`, `/genesis`, `/map/dyson-sphere-ring-1`, and `/public/dyson-sphere-ring-1-map.svg`.

Set `PUBLIC_BASE_URL` to the exact public `https://` base URL before deployment so generated discovery URLs match the crawlable site. If `PUBLIC_BASE_URL` is not set, the server derives the base URL from the incoming request host and protocol, which is useful for local checks but should not be relied on behind production proxies unless `TRUST_PROXY=true` and forwarded headers are correct. Keep `/console` in the sitemap only while the console is intended to be a public entry point; remove it from `src/server.js` if the console becomes private.

Example verification after deployment:

```bash
curl https://<metering-origin>/robots.txt
curl https://<metering-origin>/sitemap.xml
```

### SynapticSystems.ca navigation setup

- Add a normal HTTPS link on SynapticSystems.ca to the deployed metering app URL, for example a navigation item or button pointing to `PUBLIC_BASE_URL`.
- Include both `https://SynapticSystems.ca` and `https://www.SynapticSystems.ca` in `CORS_ORIGINS` when pages from either host call this API from the browser.
- Include the metering app's own browser origin in `CORS_ORIGINS` so the deployed console and app pages can call same-origin or app-origin API routes.
- Avoid wildcard CORS in production; use exact origins only.

### Google OAuth console setup

In the Google Cloud Console OAuth client used by this app:

1. Configure the OAuth client as a **Web application**.
2. Add the deployed callback URL to **Authorized redirect URIs** exactly as configured in `GOOGLE_REDIRECT_URI`:
   ```text
   https://<metering-origin>/auth/google/callback
   ```
3. If the app is deployed under a path and the proxy preserves that path for auth routes, register the exact path-aware callback URL that Google will see.
4. Confirm `GOOGLE_REDIRECT_URI` in the production environment exactly matches one authorized redirect URI, including scheme, host, path, and trailing slash behavior.

### Cross-site embedding cookie requirement

If SynapticSystems.ca navigates users directly to the metering app URL, the default HTTP-only auth session cookie can remain a first-party cookie. If the app will instead be embedded cross-site, for example in an iframe on `https://SynapticSystems.ca` while the app runs at `https://metering.SynapticSystems.ca`, update the cookie attributes in `src/lib/auth.js` so OAuth state and session cookies are emitted with:

```js
SameSite=None; Secure
```

That embedded mode also requires `COOKIE_SECURE=true`, HTTPS end-to-end from the browser, and a browser-compatible frame policy/CSP from the reverse proxy and application.

## Serverless deployment notes
If the platform reports that a “serverless function has stopped working,” verify these requirements before redeploying:

- Set `SERVERLESS=true` in the serverless environment. This prevents `src/server.js` from calling `listen()` and allows the platform handler to import the exported Express `app`.
- Export or import `app` from `src/server.js` in the platform adapter instead of starting a second HTTP listener. The database is opened lazily, so importing `app` alone should not require writable local storage during module load.
- Set `DATABASE_PATH` to an explicit absolute SQLite file path inside a writable, persistent mounted volume, for example `/mnt/data/app.db`. Do not point `DATABASE_PATH` at the read-only deployment bundle or an ephemeral directory if billing/session data must survive cold starts.
- The map metadata and digest database (`map_assets`) is part of the same SQLite database and must also live on this configured persistent `DATABASE_PATH`; otherwise static map authentication state may be lost between cold starts or redeploys.
- Ensure the parent directory for `DATABASE_PATH` already exists and is readable/writable by the serverless runtime. With `SERVERLESS=true`, startup fails with a clear error if `DATABASE_PATH` is missing, its parent directory is absent, or the parent path is not writable.
- Set `SQLITE_JOURNAL_MODE=DELETE` for platforms that do not support SQLite WAL sidecar files (`.db-wal` and `.db-shm`). `DELETE` is the default when `SERVERLESS=true`; non-serverless deployments default to `WAL`. Override with `SQLITE_JOURNAL_MODE=WAL` only when the mounted volume supports persistent sidecar files and SQLite file locking.

Example serverless environment:

```text
SERVERLESS=true
DATABASE_PATH=/mnt/data/app.db
SQLITE_JOURNAL_MODE=DELETE
DB_AT_REST_ENCRYPTION=managed-encrypted-storage
STORAGE_ENCRYPTION_AT_REST=true
STORAGE_ENCRYPTION_PROVIDER=<serverless-encrypted-volume-control>
STORAGE_ENCRYPTION_EVIDENCE=<provider-doc-runbook-or-ticket>
```

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
- Live heartbeats must use `seconds: 1`; each heartbeat represents exactly one metered second, while optional `recovered_seconds` is recorded as a separate recovery adjustment for missed ticks.
- Each invoice line now includes `quantity`, `quantity_unit`, and `auto_increment_by`.
- `GET /sessions/:id/summary` now returns `metrics.intelligence_seconds` and `metrics.tracked_quantity`.
- `POST /invoices/from-session` now emits invoice totals with total metered seconds, live one-second tick seconds, recovery adjustment seconds, and tracked quantity.


## Genesis integration

This build adds `/genesis`, which serves the uploaded **NDPS Genesis Core** page with an integrated **activity-based thinking meter**. It does not attempt to read literal thoughts. Instead, it meters billable seconds while the browser page is actively being used (mouse, keyboard, scroll, focus) and pauses on idle.

### Routes
- `/genesis` — integrated Genesis page with live activity meter
- `/console` — console with seconds, quantity, total, and launch link to Genesis
- `/ndsp/state?session_id=sess_...` — returns NDSP policy/state plus optional meter summary

### Notes
- Enter your API key in the Genesis overlay once per tab/session. It is stored only in sessionStorage and is cleared when the browser session ends.
- Start the thinking meter, then interact with the page. Each heartbeat represents one metered second; quantity and invoice totals will rise as active seconds are recorded.
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
- Approved posture for this build: **managed encrypted storage**. The app uses standard `better-sqlite3`, not SQLCipher, so production SQLite protection must come from the deployment platform's encrypted persistent volume or disk plus encrypted snapshots/backups. The guarantee must cover the main `DATABASE_PATH` file and any SQLite sidecars such as `.db-wal` and `.db-shm`.
- Production startup and migrations fail fast unless the deployment attests to that posture with `DB_AT_REST_ENCRYPTION=managed-encrypted-storage`, `STORAGE_ENCRYPTION_AT_REST=true`, `STORAGE_ENCRYPTION_PROVIDER`, and `STORAGE_ENCRYPTION_EVIDENCE`. Use `STORAGE_ENCRYPTION_PROVIDER` for the concrete provider/control name and `STORAGE_ENCRYPTION_EVIDENCE` for a policy URL, control ID, runbook section, or compliance ticket showing that the volume and backups are encrypted at rest.
- Keep SQLite file permissions least-privileged to the application user, keep `DATABASE_PATH` off ephemeral or unencrypted local disks, and confirm backup/export jobs inherit encryption. If WAL mode is enabled, treat `app.db-wal` and `app.db-shm` as protected database material.
- Do not add new sensitive columns unless they are covered by the managed encrypted storage control or a future SQLCipher/field-level envelope encryption implementation. Raw API keys must remain outside SQLite; retained Google OAuth access/refresh tokens are stored only as application ciphertext fields.

#### Existing SQLite migration to encrypted managed storage
1. Stop application writers and run a final backup of the current database directory, including `app.db`, `app.db-wal`, and `app.db-shm` when WAL mode is active. Protect this temporary backup as sensitive data.
2. Provision the approved encrypted persistent volume/disk and encrypted backup policy in the target platform. Record the provider/control in `STORAGE_ENCRYPTION_PROVIDER` and the evidence link or ticket in `STORAGE_ENCRYPTION_EVIDENCE`.
3. Copy the SQLite database and sidecar files onto the encrypted volume, then point `DATABASE_PATH` at that location. For serverless deployments, use an absolute path inside the mounted volume.
4. Start the app or run `npm run migrate` with `NODE_ENV=production`, `DB_AT_REST_ENCRYPTION=managed-encrypted-storage`, `STORAGE_ENCRYPTION_AT_REST=true`, `STORAGE_ENCRYPTION_PROVIDER`, and `STORAGE_ENCRYPTION_EVIDENCE` set. Startup should fail if any attestation is missing.
5. Verify application reads/writes, then securely delete unencrypted source copies and rotate any backups that were created before storage encryption was enabled.

### Browser secret handling
- Browser pages must not persist API keys in `localStorage`, IndexedDB, cookies without strict security attributes, or other long-lived client storage.
- The included console and Genesis page use `sessionStorage` only as a temporary compatibility bridge. Prefer a backend-issued short-lived token/session flow before exposing these pages to untrusted users.

### Production assumptions
- Deploy behind a trusted reverse proxy that terminates TLS, forwards `X-Forwarded-Proto`, and restricts administrative access.
- Inject `API_KEY_DIGESTS`, `CORS_ORIGINS`, and `PUBLIC_BASE_URL` through a secret manager or deployment environment.
- Use encrypted persistent volumes and encrypted backups for `DATABASE_PATH`.

## User-provided Dyson sphere map asset

The physical map image provided in the admin metering request is represented in Git as a text-based SVG transcription instead of a binary raster upload:

- `public/maps/dyson-sphere-request-asset.svg` — Git-safe visual transcription of the provided Dyson sphere/star-map asset.
- `public/maps/dyson-sphere-request-asset.metadata.json` — private admin/business association metadata for the asset, including the one-second metering interval.

Use this SVG path anywhere a browser-readable static map asset is required without relying on unsupported binary pushes.
