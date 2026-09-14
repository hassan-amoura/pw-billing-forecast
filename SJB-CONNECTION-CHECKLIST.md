# SJB connection and go-live checklist

The application code is deliberately shipped with no tenant credentials. Complete
these steps after creating the dedicated SJB API account. Do not paste secrets into
Git, Slack, Confluence, or an issue.

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
