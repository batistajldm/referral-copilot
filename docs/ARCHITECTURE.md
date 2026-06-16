# Architecture & scalability

A short, code-grounded view of how Referral Copilot is built to scale at linear cost and to
accept new features without rewrites. Everything below maps to real files in this repo
(`server/`, `config/queries/`, `client/`, `databricks.yml`, `app.yaml`).

## Data path (what queries what)

```
Reads  (facility search, specialties, cities, states)
   client → useAnalyticsQuery → analytics plugin → Databricks SQL Warehouse → Unity Catalog
            (config/queries/*.sql)                                            (Virtue Foundation dataset)

NL parse
   client → /api/parse-query → Model Serving (Llama 3.3 70B)   [parses text → need/city/state ONLY]

Writes / user state  (shortlist, notes, status)
   client → /api/shortlist → lakebase plugin → Lakebase (Postgres, schema `referral`)
```

The facility dataset is **queried directly in the Lakehouse** via the SQL Warehouse (see
`config/queries/facility_search.sql` and `useAnalyticsQuery('facility_search', …)` in
`client/src/App.tsx`). **Lakebase is used only for per-user state** — the `referral.shortlist`
table in `server/shortlist.ts`. There is no copy of the dataset and no UC→Lakebase sync.

## 1. Reads scale with the dataset, no data movement

Facility queries run against a **Databricks SQL Warehouse over Unity Catalog** — the dataset stays
in the Lakehouse and is queried in place (`config/queries/facility_search.sql`). Evidence scoring,
the haversine proximity ranking (median city centroid), and filtering are all expressed in that one
parameterized SQL file, so the engine handles scaling as the dataset grows — no application-side
data loading or denormalized copies to maintain.

## 2. Serverless compute → linear, demand-based cost

Both heavy components are **serverless and declared as app resources in `databricks.yml`**: the
**SQL Warehouse** (`sql-warehouse`) and **Model Serving** (`serving-default`). They scale to demand
and auto-suspend when idle, so cost tracks usage roughly linearly (pay for queries/inferences run)
rather than for always-on infrastructure. The app itself runs on Databricks Apps compute. User
state lives in **Lakebase Postgres** (`postgres` resource), a low-latency transactional store sized
to small per-user reads/writes — independent of the read-analytics path.

## 3. Add features without rewriting the base

The codebase separates **client / server / shared**, and **all analytics live as SQL files in
`config/queries/`** consumed by name (`useAnalyticsQuery('<name>', params)`). Adding a new
view is additive: drop a new `.sql` file and call it, or add an Express route in
`server/server.ts` (the existing `/api/parse-query` and `/api/shortlist` routes are registered the
same way via `appkit.server.extend`). New evidence signals are computed in SQL or in small helpers
in `App.tsx` — no change to the data layer or persistence schema is required. Plugins
(`analytics`, `lakebase`, `serving`, `server`) are composed in `server/server.ts` and degrade
gracefully when a resource is absent (analytics-only mode without Lakebase; structured search
without Model Serving).
