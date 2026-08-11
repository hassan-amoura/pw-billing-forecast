# Projectworks — Billing Forecast Utility

A self-hosted billing forecast grid built on the Projectworks Open API.
One row per stage (module), with Fee, Fees to Date, Remaining, and editable
monthly forecast columns that write back to Projectworks via
`POST /api/v1/Forecasts/Set`.

This is a standalone third-party utility. It is not part of the
Projectworks product. Whoever runs it owns the deployment, the API
credentials, and the data flow.

## Architecture

```
Browser (grid UI)  ──►  Node/Express server  ──►  Projectworks Open API
                        holds the credentials
```

The browser never sees the API credentials. The server is a thin proxy
with exactly two jobs: serve the static page and forward a fixed set of
API calls.

## Setup

Requires Node 18+.

```bash
cp .env.example .env    # then edit .env
npm install
npm start               # http://localhost:3000
```

## Configuration (.env)

| Variable | Meaning |
|---|---|
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` | Required. HTTP Basic credentials gating **every** route, including the static page. The server refuses to start without them. |
| `AUTH_DISABLED` | Local development only. Exactly `true` removes the gate entirely and logs a boot warning. |
| `PW_BASE_URL` | API base URL. Point at the STAGE tenant for demos. Required. |
| `PW_TENANT_LOCK` | Required. The expected tenant, as its **office name** in Projectworks. On boot the server resolves the office name from `GET /api/v1/Projects` and refuses to start unless it matches — so re-pointing this deployment at a new sandbox is a deliberate act, not something a swapped credential does silently. The default name `My Organisation` is rejected; give each sandbox a unique office name first. |
| `AUTH_MODE` | `basic` or `header` — match how you already call the Open API. Required. |
| `PW_USERNAME` / `PW_PASSWORD` | Required when `AUTH_MODE=basic`. |
| `PW_AUTH_HEADER_NAME` / `PW_AUTH_HEADER_VALUE` | Required when `AUTH_MODE=header`. |
| `ALLOW_WRITES` | Forecast edits are blocked unless this is exactly `true`. |
| `INVOICE_STATUS_CODES` | Comma-separated invoice `statusCode` values counted in Fees to Date. Empty = all statuses, which is wrong for revenue figures — the server warns on boot and the UI shows a banner. |
| `PW_APP_BASE_URL` | Optional tenant web app URL for deep links. Empty renders plain text. Its subdomain is checked against the resolved tenant on boot; a mismatch warns loudly, since it means the links point somewhere other than the data. |
| `PORT` | Optional, default 3000. The server always binds `0.0.0.0`. |

No variable has a fallback value. A missing required one stops the server on
boot with a message naming it.

## Hosted deployment

The server binds `0.0.0.0` on `process.env.PORT`, so it works as-is on a
platform that injects a port. Set every variable above as a platform secret —
`.env` is gitignored and is not deployed.

Redeploys wipe the filesystem, so `data/store.json` (supplier lines + audit)
is rebuilt on boot from the committed `seed.json` whenever it is missing or
has no supplier lines. A store that already holds supplier lines is never
overwritten, and `seed.json` never contributes audit entries.

## Before any demo

1. The tenant is the one you expect. The header chip names the resolved
   tenant (the API host is in its tooltip and in the status bar, because
   that host is the same for every tenant including production). The server
   will not start at all unless the tenant matches `PW_TENANT_LOCK`.
2. `INVOICE_STATUS_CODES` is set to the approved status code(s) for the
   tenant. Load data once, check the server response `invoiceStatusesSeen`
   (visible in the network tab) to see which codes exist, then set the
   filter. Until then the UI shows a warning banner and Fees to Date
   includes draft/unapproved invoices.
3. Validate one project against Projectworks directly: Fee against the
   budget, Fees to Date against approved invoices, one month cell against
   the Forecast page.
4. Test the write path: edit a cell, then open the project's Forecast page
   in Projectworks and refresh — the amount should be there. (This is the
   demo moment; rehearse it.)

## Behaviour notes

- **Gross vs Consultant tabs** split on the module's `isServices` flag.
- **Fees to Date** is all-time invoiced per stage (subject to the status
  filter), matching the "fees to date" convention rather than the forecast
  window.
- **Blanking a cell writes 0.** The API's `Forecasts/Set` takes an amount;
  whether a zero amount clears the entry or stores a zero row is tenant
  behaviour to confirm once against stage.
- **Stage No.** surfaces the module's `externalReference`. For a migrated
  tenant this carries the legacy (e.g. Deltek) stage numbers; on a fresh
  tenant it will be blank.
- **Pagination** is handled automatically (200 per page, hard cap 20,000
  records per collection with a console warning if hit).

## Deliberately not in v1

- Editing the Fee column (would use `PATCH /api/v1/Modules/{id}`)
- Business unit / originator filters (need custom field mapping per tenant)
- Any local database — the API is the single source of truth
