# Demo Ledger backend

Independent Node.js backend for the demo customer app. It includes the HTTP API,
Telegram transaction manager and administration dashboard. It does not connect to
a bank or process real payments. The customer frontend is deployed separately.

## Run locally

Requires Node.js 20 or later and **no third-party runtime dependencies** — there
is nothing to `npm install`. From this folder:

```sh
npm run dev
```

That is all. `npm run dev` starts the server on <http://127.0.0.1:8787> with
local-friendly defaults: Telegram polling is off (no bot token needed) and the
dashboard at `/admin/` opens straight away without sign-in. A demo ledger is
seeded on first run and stored in `./data/` (git-ignored).

For a production-style run (Telegram enabled, authentication enforced), copy
`.env.example` to `.env`, set a strong `API_SECRET` and the Telegram variables,
then:

```sh
npm start
```

With Telegram enabled, open `/admin/`, choose **Sign in with Telegram**, and open
the private bot chat. Compare the code on both screens and press **Potvrdit** in
Telegram. Return to the original tab to use the dashboard. Telegram sign-in
requires the backend's bot polling and an allowed private Telegram user. Requests
expire after five minutes. The session lasts up to eight hours in the tab and ends
on sign-out or a backend restart. The backend key is also available as a sign-in
option.

`/health` is public. API clients authenticate with `Authorization: Bearer`.
New customer app instances must be configured in the dashboard before showing
account data. The API supports cross-origin requests from the separate frontend.

## Project structure

`server.js` is a thin entry point; the implementation lives in `src/`, split by
responsibility so each piece can be read, tested or reused on its own:

```
server.js              Entry point: wires modules, runs migrations, starts listening
src/
  config.js            Env loading + all configuration constants
  store.js             The JSON ledger: load/save, migrations, audit log
  util.js              HTTP/text helpers (escapeHtml, sendJson, readBody)
  domain/
    transactions.js    Create/edit/confirm/delete transactions, balances
    groups.js          Linked groups: shared selection, balance, currency
    integrations.js    Revocable tokens for pushed (Klarna) transfers
    apps.js            Connected customer apps and their test profiles
  telegram/
    api.js             Telegram Bot API transport + notification helpers
    bot.js             Update routing, long-polling, deployment notices
  http/
    server.js          The HTTP server and all route handlers
admin/                 Static admin dashboard (served at /admin/)
scripts/               dev.js (npm run dev), check.js (npm run check)
telegram-manager.js    Telegram transaction-manager module (+ its tests)
dashboard-auth.js      Telegram dashboard sign-in module (+ its tests)
```

## Test data only

This backend exists to test app connections. Every `/account` response carries
`demo: true` and `notice: "DEMO – not real money. Test data only."`; the app
should display that notice. Profiles store only a test label: names, email,
phone and IBAN fields are rejected, and any stored by older versions are
removed on startup. Transaction statuses are returned as stored (pending stays
pending). `/app-events` is accepted for compatibility but app opens/resumes are
not stored or sent to Telegram.

## Coolify

Deploy using the root `Dockerfile` (Coolify: New Resource → Dockerfile, from a
Git repository). Expose container port `8787`, use `/health` for health checks
and configure an HTTPS domain. Do not enable multiple replicas: the JSON ledger
has one writer.

Set these as runtime variables in Coolify, not in Git:

- `API_SECRET`: a long random secret.
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ADMIN_CHAT_IDS`: optional.
- `PORT=8787`, `DEMO_MODE=true`, `DATA_DIR=/app/data`.
- `DASHBOARD_URL`: the externally reachable HTTPS `/admin/` address.
- `ALLOW_LOCAL_ADMIN=false`: authentication remains required.
- `DISABLE_TELEGRAM=true` for staging or a secondary instance. Enable polling
  only after the previous primary backend has stopped.

Bind the existing persistent ledger folder to `/app/data`. Never replace it
with a fresh or temporary directory. Do not copy ledger or support records into
this repository or the build context. Keep existing backups and volumes.

The Android APK is an optional runtime artifact, separate from backend source.
To preserve `/apk` and profile APK downloads, mount the existing APK read-only at
`/app/artifacts/app.apk`, or configure `APK_PATH` to another mounted path.
Backend-only deployments do not require rebuilding the customer app or APK.

External clients use the backend's HTTPS address and their existing API key.
Public network access does not bypass API authentication. Coolify administration
can retain its VPN-only access policy.

## Checks

```sh
npm run check
npm test
```

Tests use isolated temporary ledgers and mocked Telegram requests.
