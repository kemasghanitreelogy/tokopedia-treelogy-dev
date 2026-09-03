# tokopedia-treelogy-dev

TikTok Shop Open API integration for **PT Treelogy Regenerative Moringa** (region `ID`,
shop *Treelogy Moringa*, sold through Tokopedia Seller Center).

The OAuth callback is hosted on Vercel; the CLI is a thin local client over the same
`src/` modules. One runtime dependency (`@vercel/blob`).

## Architecture

```
  seller approves                TikTok redirects              tokens stored
  on Tokopedia      ───────>     to /api/callback     ──────>  in private Blob
                                 (Vercel function)                   │
                                                                     │ polled / pulled
  npm run authorize  <──────────────────────────────────────────────-┘
  writes .env
```

- **`api/callback.js`** — the registered `redirect_url`. Verifies the signed `state`,
  exchanges the `auth_code`, discovers the shop, writes the bundle to Blob.
- **`api/status.js`** — health check. Reports which env vars are present and whether a
  bundle exists. Never returns tokens.
- **Vercel Blob store `tts-tokens`** — private, so the bundle is not reachable by URL.
- **CLI** — starts the flow, polls Blob, mirrors the bundle into `.env` for local work.

## Quick start

One-time: register this as the app's **redirect_url** in Partner Center.

```
https://tokopedia-treelogy-dev.vercel.app/api/callback
```

Then:

```bash
npm run authorize   # opens the approval page, waits, writes .env when the callback lands
npm run doctor      # verify end to end
```

## Commands

| Command | Purpose |
|---|---|
| `npm run authorize` | Open the approval page and wait for the hosted callback to store tokens |
| `npm run pull` | Pull the stored bundle from Blob into `.env` (e.g. on another machine) |
| `npm run url` | Print the authorization URL and the redirect URL to register |
| `npm run refresh` | Refresh the access token and sync it back to Blob |
| `npm run shops` | List authorized shops, persist the first shop's `shop_cipher` |
| `npm run doctor` | Eight-step health check, including the live deployment |
| `npm run api -- <METHOD> <path> [k=v ...]` | Signed call to any endpoint |
| `npm test` | Offline tests |

```bash
npm run api -- GET /seller/202309/shops
npm run api -- GET /product/202312/products/search page_size=10
npm run api -- POST /product/202309/products/search --body '{"status":"ACTIVE"}'
```

## Environment

Set on the Vercel project (Production) and mirrored locally in `.env`:

| Variable | Where from |
|---|---|
| `APP_KEY`, `APP_SECRET` | Partner Center → Manage apps |
| `SERVICE_ID` | `7676046219668670224` |
| `BLOB_READ_WRITE_TOKEN` | Injected by the linked `tts-tokens` Blob store |
| `ACCESS_TOKEN`, `REFRESH_TOKEN`, `SHOP_CIPHER`, … | Written automatically |

Locally, `BLOB_READ_WRITE_TOKEN` lives in `.env.local` (written by
`vercel blob create-store` / `vercel env pull`). Refresh it with:

```bash
vercel env pull .env.local --yes
```

## CSRF without a session

The callback is a stateless function, so it cannot remember the `state` it issued.
Instead the state carries its own proof:

```
payload = <random nonce>.<expiry epoch>
state   = base64url(payload) + "." + HMAC-SHA256(payload, key = APP_SECRET)
```

The callback verifies the signature in constant time and checks the expiry — no storage
needed. The nonce doubles as the key the CLI polls for, so a callback triggered by
someone else's authorize request is never mistaken for yours.

## How requests are signed

```
base = app_secret + path + concat(sorted(key + value)) + body + app_secret
sign = HMAC-SHA256(base, key = app_secret)   ->  lowercase hex
```

`sign` and `access_token` are excluded from the concatenation; empty values are
skipped. Verified against the live API: an unsigned request returns `36009004`
("Missing credentials ... required signature") while a request signed this way
advances to `36009005` ("the 'access_token' header is invalid") — proof the server
accepted the signature.

`app_key` and `timestamp` are injected on every call. `shop_cipher` is injected
automatically once saved, except for `/authorization/202309/shops`, which is the call
that discovers it. Tokens refresh automatically: `src/client.js` renews when the stored
expiry is within 60 seconds, and retries once on `36009005` / `105002` / `105004`.

## Layout

```
api/callback.js          hosted OAuth redirect target
api/status.js            deployment health check
public/index.html        landing page (outputDirectory, keeps source out of the CDN)
vercel.json              output dir, function duration, no-store headers
bin/tts.mjs              CLI entry point
src/config.js            env resolution (process.env > .env.local > .env), hosts
src/env-file.js          comment-preserving .env reader/writer (chmod 600)
src/state.js             signed, stateless CSRF state
src/sign.js              request signature
src/auth.js              authorize URL, token exchange, refresh, persistence
src/client.js            signed transport, auto-refresh, error normalization
src/shops.js             authorized-shop discovery and shop_cipher persistence
src/token-store.js       private Blob bundle read/write
src/page.js              server-rendered callback pages (HTML-escaped)
src/open-browser.js      launch the approval page without a shell
src/format.js            masking and human-readable timestamps
test/                    offline tests
claudedocs/              implementation plan
```

## Secrets

`.env` and `.env.local` are gitignored; `.env` is written `0600`. The `auth_code` is
handled entirely server-side and never reaches a browser page, `argv`, or shell history.
The Blob store is `private`, so the token bundle has no public URL. `/api/status`
reports only presence booleans. All CLI output masks secrets.

## Related tooling

`tts_open_toolkit` (Partner Center OAuth, separate from these app credentials) verified
the app and service metadata:

```bash
tts_open_toolkit devapi call partner-profile --json
tts_open_toolkit devapi call partner-service-detail --query service_id=7676046219668670224 --json
```

On CLI 0.1.7 the `GET /api/v1/{account,app,sandbox}/*` methods return a non-JSON
response; `open-app-list`, `partner-profile`, and `partner-service-detail` work.
