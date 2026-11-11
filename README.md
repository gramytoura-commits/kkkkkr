# Demo Ledger backend

Independent Node.js backend for the demo customer app. It includes the HTTP API,
Telegram transaction manager and administration dashboard. It does not connect to
a bank or process real payments. The customer frontend is deployed separately.

## Run

Requires Node.js 20 or later and no third-party runtime dependencies.

Copy `.env.example` to `.env`, configure a strong `API_SECRET`, then run:

```sh
npm start
```

Open `/admin/`, choose **Sign in with Telegram**, and open the private bot chat.
Compare the code on both screens and press **Potvrdit** in Telegram. Return to
the original tab to use the dashboard. Telegram sign-in requires the backend's
bot polling and an allowed private Telegram user. Requests expire after five
minutes. The session lasts up to eight hours in the tab and ends on sign-out
or a backend restart. The backend key is also available as a sign-in option.

`/health` is public. API clients authenticate with `Authorization: Bearer`.
New customer app instances must be configured in the dashboard before showing
account data. The API supports cross-origin requests from the separate frontend.

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
