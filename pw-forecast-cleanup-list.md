# Projectworks forecast values written by the subconsultant rollup

Extracted from `data/store.json` audit trail before the consultant write path was
removed. This is the only record of which Projectworks Forecast values this app
overwrote with subconsultant cost totals: `data/` is gitignored and is destroyed on
redeploy, and the audit is capped at 5000 entries.

**No correction has been applied and none should be automated.** Zeroing these
values is itself a write to Projectworks, and it cannot distinguish a rollup value
from a figure a PM has legitimately entered since. Hand this list to a human to
resolve in the Projectworks UI.

Source: `action: "rollup.set"` entries, 3 of 30 total audit entries.

## 1. Every rollup push (chronological)

Each row is one `POST /api/v1/Forecasts/Set` this app made from a supplier-line edit.
`Value written` is the module-level total that replaced whatever was in Projectworks.

| # | Timestamp (UTC) | ModuleID | Month | Value written | Previous value in app | Project | Stage | User | Reached PW |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-07-08T22:25:03.017Z | 214 | 2026-09 | 850 | 750 | Mission To Mars | Expenses | Hassan | yes |
| 2 | 2026-07-08T23:44:18.442Z | 214 | 2026-09 | 1,350 | 850 | Mission To Mars | Expenses | Unnamed | yes |
| 3 | 2026-07-09T00:55:23.990Z | 214 | 2026-09 | 1,850 | 1,350 | Mission To Mars | Expenses | Hassan Amoura | yes |

## 2. Current state per (ModuleID, Month) — what is sitting in Projectworks now

Distinct targets, showing the last value written. This is what a human needs to
review on the Projectworks Forecast screen.

| ModuleID | Month | Last value written | Written at (UTC) | Pushes | Project / Stage |
|---|---|---|---|---|---|
| 214 | 2026-09 | 1,850 | 2026-07-09T00:55:23.990Z | 3 | Mission To Mars / Expenses |

Deep link per module: `{PW_APP_BASE_URL}/Project/Forecasting/{projectID}` — the audit
does not record projectID, so look the project up by name.

## 3. Caveat — case 1b writes are NOT in this list

A consultant-tab module with no supplier lines wrote to Projectworks through
`POST /api/forecast`, which audits as `action: "forecast.set"` — the same action a
legitimate Gross fees edit produces. The audit does not record `IsServices`, so those
two cannot be told apart from `store.json` alone.

Modules touched by `forecast.set` (22 entries). Check each ModuleID against
`GET /api/v1/Modules` → `IsServices`: **false means it was a consultant-tab write** and
belongs in the review above; true means it was a Gross fees edit and is correct.

| ModuleID | Project | Stage | Writes | Months touched | Likely |
|---|---|---|---|---|---|
| 201 | Comment attribution test | Stage A | 1 | 2026-07 | unknown — confirm IsServices |
| 215 | iPhone 27 Prototype | Analysis | 8 | 2026-07, 2026-08, 2026-10 | unknown — confirm IsServices |
| 221 | iPhone 27 Prototype | Expenses | 2 | 2026-08, 2026-09 | **check first** — stage name suggests a cost module |
| 223 | iFridge Website Design | Analysis | 3 | 2026-07, 2026-08, 2026-09 | unknown — confirm IsServices |
| 292 | Ready Player One Realization Prototype | 3D World Design | 8 | 2025-01, 2026-07, 2026-08, 2026-09, 2026-10 | unknown — confirm IsServices |

## 4. Notes

- 1 audit entry recorded `synced: false` (the Projectworks call failed), so
  the app-side value and Projectworks diverged at that point already.
- `supplier.set` entries are app-side only and never reached Projectworks; they are
  not listed here.
- The rollup was lossy: Projectworks only ever received the module-level total, never
  the per-supplier breakdown. The breakdown exists solely in `store.json`.

