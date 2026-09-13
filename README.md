# Projectworks — Billing Forecast Utility

A self-hosted billing forecast grid built on the Projectworks Open API.
One row per stage (module), with Fee, Fees to Date, Remaining, and monthly
columns.

The two tabs hold two different kinds of number and they do not share a home:

| | Gross fees | Consultant fees |
|---|---|---|
| Modules | `IsServices` true | `IsServices` false |
| Means | What you plan to **invoice** your clients | Subconsultant fees you expect to be **charged** |
| Field of record | Projectworks Forecasts | Postgres in this app |
| Written to Projectworks | Yes, `POST /api/v1/Forecasts/Set` | **Never** |

A third grid tab, **Net position**, puts the two together: one row per project,
planned invoicing minus subconsultant fees, per month. It is read-only and
computed server-side from the same stage rows the other two tabs display, so it
cannot disagree with them.

Subconsultant amounts are planning numbers only. The Projectworks Forecast
screen represents money coming in, so a cost posted there misstates it — the
server refuses any `Forecasts/Set` for a non-services module, and the
Consultant fees tab reads its month values back from Postgres, never from
Projectworks.

This is a standalone third-party utility. It is not part of the
Projectworks product. Whoever runs it owns the deployment, the API
credentials, and the data flow.

## Architecture

```
Browser (grid UI)  ──►  Node/Express server  ──►  Projectworks Open API
                        │ holds the credentials
                        └──────────────────────►  Postgres app-side store
```

The browser never sees the API credentials. The server serves the static page,
forwards a fixed set of Projectworks calls, and owns the Postgres storage layer.

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
| `ALLOW_WRITES` | All edits — Projectworks forecasts and app-side supplier lines alike — are blocked unless this is exactly `true`. |
| `DATABASE_URL` | Required Postgres connection string. The app has no JSON fallback and refuses to boot if the database is unreachable. |
| `DATABASE_SSL_MODE` | Required: `disable` for a trusted local connection or `require` for hosted TLS. |
| `INSTANCE_ID` | Required stable deployment/tenant identifier. Every app-side read and write is scoped to it. |
| `AUDIT_RETENTION_LIMIT` | Optional positive integer. Unset means unlimited. When set, excess old entries are removed at boot; audit append never truncates. |
| `SEED_DEMO_DATA` | Optional, default off. When exactly `true`, a brand-new, empty app-side dataset for this `INSTANCE_ID` is filled from `seed.json`. Never set it on a customer deployment. |
| `INVOICE_STATUS_CODES` | Comma-separated invoice `statusCode` values counted in Fees to Date. Empty = all statuses, which is wrong for revenue figures — the server warns on boot and the UI shows a banner. |
| `PW_APP_BASE_URL` | Optional tenant web app URL for deep links. Empty renders plain text. Its subdomain is checked against the resolved tenant on boot; a mismatch warns loudly, since it means the links point somewhere other than the data. |
| `PORT` | Optional, default 3000. The server always binds `0.0.0.0`. |

No variable has a fallback value. A missing required one stops the server on
boot with a message naming it.

## Hosted deployment

The server binds `0.0.0.0` on `process.env.PORT`, so it works as-is on a
platform that injects a port. Set every variable above as a platform secret —
`.env` is gitignored and is not deployed.

### Postgres is the app-side system of record

Postgres holds the supplier lines, consultant-fee planning numbers and audit
trail. None of it is written to Projectworks, so **nothing upstream can rebuild
it**. Use a managed database with provider backups and run an application-level
backup when needed:

```bash
npm run backup:export
```

The command writes an exclusive, mode-0600 JSON file under `backups/` by default;
pass a path after `--` or use `--stdout`. The server creates/validates the schema
at boot and refuses to listen if the database cannot be reached.

### One-time migration from `data/store.json`

Run the rollback-only dry run first, then the real import. The target
`INSTANCE_ID` must be empty; the import is one transaction and validates the
supplier-line, expanded-month and audit counts before commit.

```bash
npm run migrate:store -- --dry-run data/store.json
npm run migrate:store -- data/store.json
```

The JSON source is read-only and retained after migration. Existing supplier
line IDs are preserved. Unmapped audit properties are stored in `audit_log.extra`.

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

- **Gross vs Consultant tabs** split on the module's `isServices` flag — the
  same field the server guard uses to refuse a Projectworks write, so the UI
  and the guard cannot disagree about which modules are which.
- **Consultant month cells are derived, not typed.** A module row shows the
  app-side total of the supplier lines beneath it (expand the stage to edit
  them), whether or not any lines exist yet. Nothing on that tab is editable at
  module level, because such a cell would be a way to reach Projectworks.
- **The audit "Written to" column** distinguishes `Projectworks ✓ / ✗` from
  `app-side`. They are different guarantees and never share a tick.
- **Net position** is one row per project (not per stage), aggregated in
  `buildNetRows()` from the rows the grid already built. Net per month is shown
  on the project row; expanding it reveals the two components. A project with
  no forecast and no supplier line in the window is dropped rather than
  rendered as a row of blanks — the same "a month key exists" test the
  no-forecast filter uses. The two fee-based checkboxes are stage concepts with
  no project equivalent and are hidden on that tab. CSV export includes all
  three series per project.
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

## Deferred (known, deliberately not built)

- Edit-conflict detection between two browsers
