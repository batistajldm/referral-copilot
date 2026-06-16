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

## Design choice: right engine for each job

Reads go to the **Lakehouse** (analytical SQL over the dataset) and user state goes to **Lakebase**
(transactional, low-latency). This is deliberate: for a read-only analytical search the SQL
Warehouse keeps a **single source of truth with no copy and no sync lag**, and cost stays
demand-based (serverless, auto-suspend). Putting the dataset into Postgres would add a second copy
and a staleness problem without a real latency benefit for this workload.

## What's next (evolution path, low rewrite)

If sub-millisecond facility reads ever become a requirement (e.g. very high concurrency), the
natural next step is a **Lakebase synced table**: Databricks continuously replicates the
`facilities` table from Unity Catalog into Lakebase Postgres, and `facility_search` is ported to the
Postgres dialect (`percentile_cont` for the median centroid, `jsonb_array_length` for capability
counts, native trig for haversine). Because all reads already flow through named queries
(`config/queries/`) and the plugin layer, this is an **additive swap of the read source** — the UI,
the evidence model, and the shortlist path stay unchanged. We intentionally did **not** do this for
the hackathon: it trades the current single-source-of-truth simplicity for a sync pipeline whose
latency gain isn't needed for the dataset size and read pattern here.
