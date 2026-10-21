# SJB connection and go-live checklist

The application code is deliberately shipped with no tenant credentials. Complete
these steps after creating the dedicated SJB API account. Do not paste secrets into
Git, Slack, Confluence, or an issue.

## Production go-live (2026-10-20) — read this first

Verified read-only against the SJB tenant on 2026-10-20 (`npm run probe`):

- **`PW_TENANT_LOCK` must be `SJB MEL,SJB SYD`.** Projects sit in both offices
  (SJB SYD 3,277, SJB MEL 408). `SJB SYD` alone refuses to start with
  "Unexpected office(s): SJB MEL". The lock logic is unchanged.
- **Archived = `ProjectStatusName` "Archived"**, not `IsActive=false`: every
  project returned `IsActive=true`, and 2,766 of 3,685 are status Archived.
  Excluding them leaves ~5,865 of ~27,779 modules. Both signals are honoured.
- **`EXPENSE_STATUS_CODES=Approved`** resolves to status ID 4 (no status lookup
  exists in the API); **`INVOICE_STATUS_CODES=Finance Approved`** matches
  `StatusCode` text directly.
- **`MODULE_CUSTOM_FIELD_LABELS=Stage No,Risk Status,Des / Del`**: `Stage No`
  (FieldID 18) and `Des / Del` (FieldID 3) are on every module; `Risk Status`
  was not on any non-archived module, so that column shows blank (logged
  server-side; nothing is shown in the UI).
- Leave `MODULE_CUSTOM_FIELD_ENTITY_TYPE_ID` empty.

Sections below are the earlier sandbox connection record.

## 1. Set the SJB-specific environment

Start from `.env.example` locally, or fill the `sync: false` values when creating
the Render Blueprint from `render.yaml`.

- `PW_BASE_URL`: exact endpoint issued with the SJB API account.
- `PW_USERNAME` and `PW_PASSWORD`: SJB consumer key and secret.
- `PW_TENANT_LOCK`: comma-separated allow-list of SJB office names returned on
  project records. For the two organisations shown, use `SJB MEL,SJB SYD`.
- `PW_APP_BASE_URL`: exact SJB Projectworks browser URL.
- `DATABASE_URL`: backed-up production Postgres connection string.
- `DATABASE_SSL_MODE`: `require` when using Render's internal Postgres URL.
- `INSTANCE_ID`: a new stable SJB-only value, such as `sjb-production`.
- `INVOICE_STATUS_CODES`: SJB statuses that represent approved invoice actuals.
- `EXPENSE_STATUS_CODES`: SJB status IDs that represent approved expense actuals.
- `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD`: new SJB browser-gate credentials.

Keep `ALLOW_WRITES=false`, `AUTH_DISABLED=false`, and `SEED_DEMO_DATA=false`.

The app attempts to discover the Module custom-field entity type. If the module
custom fields cannot be identified from labels or IDs in the live response, set
`MODULE_CUSTOM_FIELD_ENTITY_TYPE_ID` to its entity-type ID. The grid warns and
leaves fields blank when it cannot prove the mapping.

## 2. Read-only acceptance

The server must boot with only SJB office names. Its header shows the offices
actually present on the returned project records (for example, `SJB SYD`); an
organisation with no returned projects is not required to appear. If the API
uses a name outside the allow-list, startup prints it and stops. Then check all
of the following before enabling writes:

1. Reconcile one Gross stage: budget, approved invoice total, remaining, and a
   monthly forecast.
2. Reconcile one Consultant stage: budget and the sum of approved, non-planned,
   pre-tax ExpenseClaims through today. Confirm excluded-expense warnings are zero.
3. Confirm Stage Number, Risk Status, and Fixed / Hourly against the same modules.
4. Confirm Project Manager, GL Type, GL Code, project currency, default ordering,
   filters, Net position, and CSV export.
5. Expand a Consultant stage, create/edit/delete a supplier planning line, and
   confirm it persists after a restart. This requires temporarily enabling writes,
   but it never writes to Projectworks.
6. Confirm `/healthz` returns 200 while Postgres is available and 503 when it is not.
7. Export a backup with `npm run backup:export` and verify the file is stored away
   from the service filesystem.

## 3. Controlled write acceptance

Only after SJB/Lauren approve live forecast edits:

1. Set `ALLOW_WRITES=true`.
2. Change one agreed Gross stage/month.
3. Verify the amount in Projectworks Forecasting and in the app audit.
4. Attempt the forecast endpoint with a Consultant module and confirm it is refused.
5. Keep the tenant lock, browser gate, Postgres backups, and health check enabled.

## 4. Product rule implemented

Consultant **Fees to Date** is the cumulative approved, non-planned,
`amountWithoutTax` expense total linked to that module, dated through today.
Consultant month cells remain future planning by supplier in this app. They are not
replaced by expense actuals and are never written to Projectworks.

---

# SJB sandbox (sjb-sandbox.projectworksapp.com)

Verified against the tenant on 2026-10-13 with a read-only sandbox API account.
This is the copy-of-live environment used for training while the v2 test
migration runs. Everything below was observed, not assumed.

## Values confirmed against the tenant

| Variable | Value |
|---|---|
| `PW_BASE_URL` | `https://api.projectworksapp.com` (unchanged — one host serves every tenant) |
| `PW_APP_BASE_URL` | `https://sjb-sandbox.projectworksapp.com` |
| `PW_TENANT_LOCK` | `SJB MEL,SJB SYD` |
| `INSTANCE_ID` | `sjb-sandbox` (must differ from the production instance — it scopes every Postgres row) |
| `INVOICE_STATUS_CODES` | `Finance Approved` (13,486 of 13,492 invoices; the other 6 are Draft) |
| `EXPENSE_STATUS_CODES` | `4` (all 13,297 claims; all non-planned, all module-linked) |
| `MODULE_CUSTOM_FIELD_LABELS` | `Stage No,Risk Status,Des / Del` — **not** the blueprint default |
| `MODULE_CUSTOM_FIELD_ENTITY_TYPE_ID` | **leave unset** — see below |

## Collection sizes and why PAGE_SIZE changed

| Collection | Records |
|---|---|
| Projects | 3,664 |
| Modules | 29,582 |
| Invoices | 13,492 |
| ExpenseClaims | 13,297 |
| Forecasts (12-month window) | 6 |

Modules overran the previous 200 × 100 = 20,000 ceiling, and `collectPages`
throws rather than truncating, so every grid load failed outright. `PAGE_SIZE`
is now 1000 (the largest page the API honours), lifting the ceiling to 100,000
and cutting round trips fivefold. Invoices and ExpenseClaims are all-time pulls
with no start date, so they only grow — the extra headroom matters for them too.

A full grid load takes 25–45 seconds and returns ~18 MB. Confirm the hosting
platform's request timeout tolerates that before relying on it.

## Row cap in the grid

26,686 Gross stages cannot all be rendered: each row carries a live `<input>`
per month cell, so the full set would mean ~320,000 inputs and a hung tab. The
grid now renders at most `MAX_RENDER_ROWS` (500) and shows a notice naming how
many are hidden. Footer totals and CSV export still cover every filtered row —
verified: the footer reported 26,686 stages and A$537,026,372.80, matching a
direct sum of the API response exactly.

Training sessions should filter by project manager or search before working.

## Custom fields: do not set the entity-type override

Projectworks has no entity type named `Module` in this tenant. Module-level
custom fields live under **`Project Budget` (EntityTypeID 4)**, and only three
exist: `Stage No`, `Risk Status`, `Des / Del`.

Setting `MODULE_CUSTOM_FIELD_ENTITY_TYPE_ID=4` makes it worse, not better: that
switches the resolver to ordinal (positional) mapping, which silently
mis-assigns values — Risk Status is not returned on module records, so the
column picks up whichever field sits in that position. Observed: Stage No values
appearing under Risk Status. **Leave the override unset.** Label matching then
works correctly (`customFieldMapping: identity`).

Resulting state, which is correct and honest:

- **Stage No** — populates, 21,903 of 29,582 rows, 896 distinct legacy values
  (`999`, `1`–`9`, `11.01`–`11.05`, …)
- **Risk Status** — defined on Project Budget but never returned on module
  records; column stays blank and the app names it in `missingCustomFields`
- **Des / Del** — exists (Design/Delivery) but unpopulated on every module
  sampled. It is *not* an equivalent of "Fixed / Hourly", which does not exist
  in this tenant at all

The blueprint default `Stage Number,Risk Status,Fixed / Hourly` matches none of
these. Two of the three labels are wrong.

## Open items

1. **The tenant lock cannot tell this sandbox from production.** It matches on
   office name, and the copy carries the same `SJB MEL` / `SJB SYD` names. A
   production credential pasted into the sandbox service boots clean with no
   warning. Rename the sandbox offices to something unique to restore the
   protection; this also clears the `PW_APP_BASE_URL` subdomain warning, which
   currently fires as a false positive on every boot.
2. **Six forecast entries exist in the next twelve months.** The grid's month
   columns are effectively empty. Confirm whether forecasts were meant to come
   across in the migration, or whether trainees enter them during the session.
3. **20 consultant expense actuals are excluded** for a missing or mismatched
   currency, stage link, date or pre-tax amount. Step 2 of the acceptance list
   requires this to be zero, so it needs investigating before Consultant Fees to
   Date is presented as accurate.
4. **The custom-field labels are likely wrong in production too.** `render.yaml`
   hardcodes the blueprint default, and the sandbox is a copy of live — so the
   live deployment is probably showing blank Stage Number and Fixed / Hourly
   columns for the same reason. Worth checking the production service's
   environment.
