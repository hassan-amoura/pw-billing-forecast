# Projectworks — Billing Forecast Utility

A self-hosted billing forecast grid built on the Projectworks Open API.
One row per stage (module), with Fee, Fees to Date, Remaining, and monthly
columns.

The two tabs hold two different kinds of number and they do not share a home:

| | Gross fees | Consultant fees |
|---|---|---|
| Modules | `IsServices` true | `IsServices` false |
| Monthly values | What you plan to **invoice** your clients | Subconsultant costs you plan to be **charged** |
| Monthly field of record | Projectworks Forecasts | Postgres in this app |
| Fees to Date | Approved Projectworks invoice lines | Approved Projectworks expense claims before tax, through today |
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
It reads ExpenseClaims for consultant actuals and module custom fields for Stage
Number, Risk Status and Fixed / Hourly; all of those calls are read-only.

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
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` | Required. HTTP Basic credentials gating every user-facing route, including the static page. `/healthz` is the sole non-sensitive exception. The server refuses to start without them. |
| `AUTH_DISABLED` | Local development only. Exactly `true` removes the gate entirely and logs a boot warning. |
| `PW_BASE_URL` | API base URL. Point at the STAGE tenant for demos. Required. |
| `PW_REQUEST_TIMEOUT_MS` | Required bounded timeout for every Projectworks request. Valid range: 1000–120000 ms. |
| `PW_TENANT_LOCK` | Required. The allowed tenant identity, as **office name(s)** on Projectworks project records. Use a comma-separated allow-list for a multi-organisation tenant, for example `SJB MEL,SJB SYD`. On boot the server pages through `GET /api/v1/Projects` and refuses to start if any observed office is outside that list. It does not require an organisation with no returned projects to appear. The default name `My Organisation` is rejected. |
| `AUTH_MODE` | `basic` or `header` — match how you already call the Open API. Required. |
| `PW_USERNAME` / `PW_PASSWORD` | Required when `AUTH_MODE=basic`. |
| `PW_AUTH_HEADER_NAME` / `PW_AUTH_HEADER_VALUE` | Required when `AUTH_MODE=header`. |
| `ALLOW_WRITES` | All edits — Projectworks forecasts and app-side supplier lines alike — are blocked unless this is exactly `true`. |
| `DATABASE_URL` | Required Postgres connection string. The app has no JSON fallback and refuses to boot if the database is unreachable. |
| `DATABASE_SSL_MODE` | Required: `require` for Render's internal Postgres URL (its internal TLS certificate is self-signed), `verify-full` for providers with a trusted certificate, or `disable` only for a trusted local connection. |
| `INSTANCE_ID` | Required stable deployment/tenant identifier. Every app-side read and write is scoped to it. |
| `AUDIT_RETENTION_LIMIT` | Optional positive integer. Unset means unlimited. When set, excess old entries are removed at boot; audit append never truncates. |
| `SEED_DEMO_DATA` | Optional, default off. When exactly `true`, a brand-new, empty app-side dataset for this `INSTANCE_ID` is filled from `seed.json`. Never set it on a customer deployment. |
| `INVOICE_STATUS_CODES` | Required comma-separated invoice statuses counted in Gross Fees to Date, matched against `StatusCode` text case-insensitively (or a numeric `StatusID`). SJB: `Finance Approved`. Empty stops boot. |
| `EXPENSE_STATUS_CODES` | Required comma-separated expense statuses counted in Consultant Fees to Date. Claims carry only a numeric `ExpenseClaimStatusID` and the API has no status lookup, so values are IDs or a known name: `Approved` → ID 4 (SJB's live approved claims all carry 4). An unresolvable name shows a warning naming the IDs seen. The boot log prints the resolution. Empty stops boot. |
| `ARCHIVED_PROJECT_STATUSES` | Optional, default `Archived`. A project is archived when `IsActive=false` **or** its `ProjectStatusName` is in this list. SJB keeps `IsActive=true` on every project and archives through the `Archived` status. |
| `MODULE_CUSTOM_FIELD_LABELS` | Required, exactly three labels in order: stage number, risk status, third column. SJB: `Stage No,Risk Status,Des / Del`. Matched by label (never by field ID) against each module's `CustomFields`; the labels are also the column headers. Unset values display blank; a label no stage carries displays blank and is logged at startup (no UI banner). |
| `MODULE_CUSTOM_FIELD_ENTITY_TYPE_ID` | Optional override; leave empty for SJB. Its module fields carry their label, so no entity type is needed, and setting one enables an ordinal fallback that can misplace values. |
| `DEFAULT_STAGE_SORT` | Required: `stageName` or `stageNumber`. Project name remains the primary default sort. |
| `PW_APP_BASE_URL` | Optional tenant web app URL for deep links. Empty renders plain text. Its subdomain is checked against the resolved tenant on boot; a mismatch warns loudly, since it means the links point somewhere other than the data. |
| `PORT` | Optional, default 3000. The server always binds `0.0.0.0`. |

A missing required variable stops the server on boot with a message naming it.
Only the optional values have the documented defaults above.

## Hosted deployment

The server binds `0.0.0.0` on `process.env.PORT`, so it works as-is on a
platform that injects a port. Set every variable above as a platform secret —
`.env` is gitignored and is not deployed.

`render.yaml` defines an always-on Node service, runs the test suite during the
build, disables automatic deployment and writes by default, and checks Postgres
through the unauthenticated `/healthz` endpoint. Tenant-specific and secret values
use `sync: false`; fill them in the Render dashboard. Existing Blueprint services
do not automatically receive newly added `sync: false` values, so add those
manually when updating an existing deployment.

Follow `SJB-CONNECTION-CHECKLIST.md` for the exact read-only reconciliation and
controlled-write sequence.

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
   will not start at all if an office name falls outside `PW_TENANT_LOCK`.
2. `INVOICE_STATUS_CODES` and `EXPENSE_STATUS_CODES` are set to the tenant's
   approved statuses. The server refuses to start without both. The grid
   reports `invoiceStatusesSeen` and `expenseStatusesSeen` for reconciliation.
3. The three configured module custom fields exist in SJB. If they do not,
   their columns remain blank and a warning names them.
4. Validate one project against Projectworks directly: Fee against the
   budget, Fees to Date against approved invoices, one month cell against
   the Forecast page, and Consultant Fees to Date against approved pre-tax
   expense claims.
5. Test the write path: edit a cell, then open the project's Forecast page
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
- **Consultant Fees to Date is not the plan.** It is the all-time total of
  approved, non-planned ExpenseClaims through today, summed from
  `amountWithoutTax`. Claims with a missing/mismatched project currency are
  excluded and surfaced as a warning rather than silently converted.
- **Consultant GL split.** The Consultant tab shows GL Type and GL Code and has
  a GL Type filter. These values come from the module record.
- **Module custom fields are read-only.** Stage Number, Risk Status and Fixed /
  Hourly appear on all three grids. Net position joins distinct stage values
  with a separator because a project can contain several different stages.
- **Currency follows each project.** The browser formats money using the
  Projectworks project currency, shows its ISO code in a separate column, and
  footers refuse to combine unlike currencies.
- **The audit "Written to" column** distinguishes `Projectworks ✓ / ✗` from
  `app-side`. They are different guarantees and never share a tick.
- **Forecast audit "from" values are server-read.** Immediately before a Gross
  write, the server reads that module/month from Projectworks. It refuses the
  write if the prior value cannot be established rather than trusting the
  browser's copy.
- **Net position** is one row per project (not per stage), aggregated in
  `buildNetRows()` from the rows the grid already built. Net per month is shown
  on the project row; expanding it reveals the two components. A project with
  no forecast and no supplier line in the window is dropped rather than
  rendered as a row of blanks — the same "a month key exists" test the
  no-forecast filter uses. The two fee-based checkboxes are stage concepts with
  no project equivalent and are hidden on that tab. CSV export includes all
  three series per project.
- **Fees to Date** is all-time approved revenue for Gross fees and all-time
  approved pre-tax expense actuals for Consultant fees. Both are independent
  of the visible forecast window.
- **Blanking a cell writes 0.** The API's `Forecasts/Set` takes an amount;
  whether a zero amount clears the entry or stores a zero row is tenant
  behaviour to confirm once against stage.
- **Stage Number** comes from the configured module custom field, not
  `externalReference`.
- **Pagination is verified, never assumed.** The Open API silently caps
  `pageSize` at 1000 and reports `x-total-count` / `x-page-count` computed on
  the size it actually served. `pw-client.js` reads the page count from those
  headers (never stopping on a merely short page), fetches six pages at a
  time, de-duplicates by ID and compares the result with `x-total-count`.
- **Modules are read one project at a time, active projects only.** The API
  sorts modules by `ModuleName` with nothing to break ties, and honours no
  sort or keyset parameter (`OrderBy`, `SortBy`, `Sort`, `$orderby`,
  `AfterModuleID`, … — all tested live, all ignored), so offset pages of the
  bulk `/Modules` read overlap and gap differently on every request. The app
  never reads `/Modules` in bulk. It reads `/Projects` in full, keeps only
  active projects (`IsActive=true` and a status not in
  `ARCHIVED_PROJECT_STATUSES`), and reads each one's modules with
  `/Modules?ProjectID=…&IncludeCustomFields=true`, `MODULE_FETCH_CONCURRENCY`
  (default 10) at a time. A project's modules fit on one page, so paging order
  cannot lose any. Each project is complete only when its read meets its own
  `x-total-count`, every row belongs to it, and every module ID its project
  record lists (`Projects[].Modules`) arrived; otherwise it is re-read (three
  attempts). 429, 500, 502, 503, 504 and timeouts are retried with exponential
  backoff and jitter, honouring `Retry-After`.
- **Archived projects are excluded altogether.** Their modules are never
  requested, they are never stored in a snapshot, and there is no toggle to
  show them. On SJB: 919 active of 3,685 projects, 5,866 stages.
- **Incremental refresh.** After the first full sync, **Load data** reads
  only `/Modules?ModifiedSinceDate=<previous sync − 15 min>` (verified live:
  the filter is honoured to the second) and applies it to the cached stages.
  `/Projects` is still read in full: each record's module list is what reveals
  deleted stages and projects that became active or archived; a project whose
  listed modules no longer match the cache is re-read. A full sync runs again
  when the last one is `FULL_SYNC_INTERVAL_HOURS` (default 24) old, as a
  backstop for any edit that does not bump `ModifiedDateUTC`.
- **Nothing about completeness reaches the UI.** There are no error banners
  or warning notices: SJB staff see the grid, so everything on screen is
  customer-facing. Incomplete reads, retries, per-project failures and
  configuration problems are logged server-side only. A project whose read
  fails keeps its stages from the previous snapshot; a refresh still
  incomplete after that is logged and discarded when a snapshot exists, so
  the last good data stays on screen with only a neutral **Last refreshed
  hh:mm**. A refresh that fails outright does the same. A failed edit says
  "Couldn't save this change" (or the app's own 4xx reason, such as "Select a
  user before editing."), never upstream detail.
- **Organisation filter.** The Organisation select (All / SJB MEL / SJB SYD)
  is built from `GET /api/v1/Offices` and applied server-side by `OfficeID`.
- **Snapshots: the grid opens instantly.** The last good read of every
  source is kept per forecast window, in memory and gzipped in Postgres
  (`grid_snapshots`), so it survives restarts and deploys. Opening the page
  serves it straight away, with **Last refreshed hh:mm** in the status line;
  a window with no snapshot yet starts its first sync on page load. **Load
  data** refreshes in the background (`POST /api/grid/refresh`, `full=1` to
  force a full sync) with a progress bar and "Refreshing… 412 of 919
  projects"; the previous data stays on screen until the new snapshot is
  swapped in. Filters rebuild rows from the snapshot without reading
  Projectworks. A forecast write is patched into every snapshot that shows it
  (and into a refresh in flight); supplier lines are read live from Postgres.
  Offices and custom-field definitions are cached for 10 minutes.
- **Per-phase timings are logged on every refresh**, e.g. `grid refresh
  2026-10..2027-09 (full) in 205.3s: projects 14.1s (919 active of 3,685) ·
  reference 13.5s · modules 205.1s (5,866 stages; 919 project(s) read) ·
  invoices 4.4s · expenses 4.1s · forecasts 4.6s · build 0.2s`, and every grid
  build logs its row counts and build time.
- **Measured against SJB production (2026-10-21, read-only).** First full
  sync 205 s: the API serves about 7–8 requests per second whatever the
  concurrency (latency rises from ~0.65 s alone to ~1.2 s at 10 in flight), so
  919 per-project reads cannot go much faster. Incremental refresh 9 s, most of
  it the four `/Projects` pages. Cached page load: `/api/grid` 120 ms (build
  ~90 ms, 3.5 MB); grid rendered in the browser ~310 ms after opening the
  page; after a restart the snapshot is restored from Postgres in 22 ms.
- **No full read at boot.** Boot reads only `/Projects` (the tenant lock).
  The custom-field and invoice-status diagnostics are logged after the first
  refresh from its data.
- **Supplier-line writes are checked server-side.** A supplier line cannot be
  added to or edited against a services module even if a caller bypasses the UI.
- **Stale edits fail visibly.** Gross writes compare the grid's prior value
  with a fresh Projectworks read; supplier-line writes compare under a Postgres
  row lock. A changed value returns 409 and requires a reload instead of silently
  overwriting another browser's edit.

## Tests

```bash
npm test            # unit tests (node:test), no network
npm run test:e2e    # Playwright end-to-end, mocked Projectworks API only
```

The end-to-end suite never contacts a real tenant. `playwright.config.ts`
starts, in order:

1. a throwaway Postgres (`e2e/support/postgres.js`: `initdb` into a temp dir,
   deleted on exit — needs the Postgres server binaries on `PATH`, or `PG_BIN`
   pointing at their directory);
2. the mock Projectworks API (`e2e/mock-pw/server.js`, port 4310), serving a
   deterministic fixture tenant (`e2e/mock-pw/fixtures.js`): both SJB offices,
   active projects plus projects archived by status and by `IsActive=false`,
   22,000+ modules with and without Stage No, and approved and non-approved
   invoices and expense claims. Pages are capped at 750 so a client that took a
   short page as the last one would truncate. Control endpoints inject
   per-project failures and short reads, an outage, and edits/deletions with
   a bumped `ModifiedDateUTC`, and report every ProjectID requested;
3. the app with the production variable set and `ALLOW_WRITES=true` (port 4311);
4. the app with `ALLOW_WRITES=false` (port 4312).

Both app instances run with `cwd=e2e/`, so `dotenv` cannot load a real `.env`,
and every variable is set explicitly. Browsers: `npx playwright install
chromium` once if Chromium 1179 is not already cached.

| Spec | Covers |
|---|---|
| `auth.spec.ts` | Basic auth gate: 401 without or with wrong credentials, `/healthz` open, app opens with valid credentials |
| `active-only.spec.ts` | A full sync requests modules only for active projects (no bulk read, no archived ProjectID) and no archived project is shown or sent; Load data after it reads only `ModifiedSinceDate` changes and applies an edit and a deletion; a short project read is re-read; 429/500 are retried; an unreadable project keeps its last good stages with no error copy; an incomplete first sync still shows the grid with no error copy |
| `refresh.spec.ts` | A full refresh shows "Refreshing… N of M projects" over the grid already on screen; a failed refresh (Projectworks down) keeps the last good data, with only "Last refreshed hh:mm" and no error copy, also after a reload |
| `snapshot.spec.ts` | Reopening the page shows the last snapshot without Load data, with "Last refreshed"; Load data shows progress while the old grid stays usable; a restarted server serves the snapshot from Postgres |
| `filters.spec.ts` | No truncation (footer count = fixture active total) and no error copy; 500-row cap shown as a neutral status-line note; organisation All / SJB MEL / SJB SYD |
| `stage-no.spec.ts` | Stage No populated from the custom field and blank when unset; headers use the configured labels |
| `status-filters.spec.ts` | Gross Fees to Date counts only Finance Approved invoices; Consultant Fees to Date only Approved (ID 4) claims |
| `writes.spec.ts` | `ALLOW_WRITES=true`: cells editable, an edit sends `{ moduleID, date: "YYYY-MM-01", amount, comment }` to `POST /Forecasts/Set`, is audited, and is patched into the served snapshot; consultant modules are refused |
| `readonly.spec.ts` | `ALLOW_WRITES=false`: cells disabled, `/api/forecast` returns 403, nothing reaches the mock |
| `tenant-lock.spec.ts` | A mismatched `PW_TENANT_LOCK` refuses to start; `SJB SYD` alone refuses a tenant that also has `SJB MEL` projects |

Specs use `data-testid` selectors and web-first assertions only (no fixed
waits). They run on one worker because they share the mock tenant.

## Tenant probe and benchmark (read-only)

```bash
PROBE_ENV=.env.prod npm run probe       # completeness, archived/office tallies, lock coverage, custom fields
PROBE_ENV=.env.prod npm run benchmark   # before/after load time, all-pages vs per-project modules
```

Both send GET requests only and print counts and field shapes, never
credentials or client names.

## Deliberately not in v1

- Editing the Fee column (would use `PATCH /api/v1/Modules/{id}`)
- Business unit / originator filters (need custom field mapping per tenant)
