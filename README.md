# Referral Copilot

**Evidence-backed healthcare facility referrals for India.**
DAIS Apps & Agents Hackathon for Good 2026 — Track 3.

Given a **location + a care need** (e.g. *"dialysis near Jaipur"*), Referral Copilot returns a
ranked shortlist of healthcare facilities where **every claim is cited from the underlying
dataset** — never invented by an AI. It ranks by real geographic proximity, surfaces honest
uncertainty, and lets a care coordinator save, annotate, and triage candidates.

🔗 **Live app:** https://referral-copilot-2878696955147552.aws.databricksapps.com
*(auth-gated — see [Testing instructions](#testing-instructions-for-judges) below)*
💻 **Source:** https://github.com/batistajldm/referral-copilot

---

## What it does

- **Ask in plain English.** A Foundation Model (Llama 3.3 70B on Databricks Model Serving) parses
  free text into `need + city + state`. **Crucially, the LLM only parses the question — it never
  ranks results and never generates evidence.** All evidence comes straight from the dataset.
- **Real proximity, not just name-matching.** We derive each city's reference point from the
  dataset's own coordinates using the **median** of lat/lon (robust to mis-geocoded rows), then
  rank by great-circle (haversine) distance — surfacing good options in neighbouring towns too.
- **Two independent trust signals per result:**
  1. A **facility-level** evidence score (0–12) for how well-documented the facility is overall.
  2. A **per-need** signal showing whether the searched service is **cited** (capability claim +
     source), **listed** (specialty), or only **mentioned** in free-text — flagged in amber so
     weak evidence is never hidden.
- **Act on it.** Click-to-call, website links, and a personal shortlist with notes, status
  overrides, and review decisions — persisted per user in Lakebase.

---

## Testing instructions (for judges)

> The live app is a **Databricks App** and is **auth-gated by design** — Databricks Apps cannot be
> made public or bypass SSO. To evaluate the running app, use the access below.

> ### 🔑 ACCESS FOR JUDGES — _team to fill in before submission_
>
> ```
> Live app URL: https://referral-copilot-2878696955147552.aws.databricksapps.com
>
> >>> PASTE JUDGE ACCESS HERE <<<
>   Option A — test login:   email: __________   password: __________
>   Option B — access method: __________________________________________
>
> Video walkthrough (no login required): >>> PASTE VIDEO LINK HERE <<<
> ```
>
> *(No real credentials are committed to this repo. The team provides judge access via a dedicated,
> least-privilege account or a video walkthrough.)*

### Try these example queries

In the **"Ask in plain English"** box (or via "Search by field"):

| Query | What it demonstrates |
|---|---|
| `Dialysis near Jaipur` | Proximity ranking + cited vs. *mentioned* evidence (some matches only appear in free-text description) |
| `Cardiology near Mumbai` | Median-centroid proximity surfacing nearby facilities |
| `Maternity in Rajasthan` | State-level search with evidence-first ranking (no city → ranks by evidence) |

### What to look for

1. **Evidence quality, not just a result list.** Each card shows a **per-need trust signal**:
   - 🟢 **cited** — a capability claim backed by a source URL
   - 🔵 **listed** — appears as a facility specialty
   - 🟡 **mentioned** — only found in free-text description (weaker; we surface the snippet and flag it)
2. **The two evidence axes.** The header badge (`Facility: Strong · 12`) measures *facility
   documentation*; the per-need signal measures *evidence for what you searched*. A facility can be
   well-documented **and** have weak evidence for your specific need — we show both. Open
   **"How is confidence calculated?"** to see the exact formula.
3. **Proximity.** Note the `~X km away` chips; neighbouring towns appear, not just exact city matches.
   (Distance is straight-line today; road routing is on the roadmap.)
4. **Act on a result.** Use **Call** / **Website**, then **save a facility to your shortlist**, add a
   note, and set a status (Considering / Reviewed / Follow-up / Rejected). **Reload the page** — your
   shortlist, notes, and status persist (Lakebase).

---

## How it works

```
User query ──▶ /api/parse-query ──▶ Model Serving (Llama 3.3 70B)   [parses text → need/city/state ONLY]
                                          │
        ┌─────────────────────────────────┘
        ▼
  Analytics query (config/queries/facility_search.sql)
   • evidence_score (0–12)         ── transparent, in SQL
   • haversine distance to median city centroid
   • ranking: proximity → evidence
        │
        ▼
  Databricks SQL Warehouse ──▶ Unity Catalog
        (Virtue Foundation DAIS 2026 facilities dataset)
        │
        ▼
  React UI: two-axis evidence, contact actions, filters/sort
        │
        ▼
  Shortlist / notes / status ──▶ Lakebase (Postgres, SP-owned schema)
```

- **Evidence and ranking live entirely in SQL** (`config/queries/facility_search.sql`),
  parameterized — no string interpolation, no AI-generated facts.
- The **service principal** owns the Lakebase schema; user actions are scoped per user.

## Tech stack

- **App framework:** [AppKit](https://www.databricks.com/devhub/docs/appkit/v0/) (React + TypeScript + Express)
- **Data:** Databricks **SQL Warehouse** over **Unity Catalog** (Virtue Foundation DAIS 2026 dataset)
- **NL parsing:** Databricks **Model Serving** — `databricks-meta-llama-3-3-70b-instruct`
- **Persistence:** **Lakebase** (Postgres)
- **Frontend:** Vite, Tailwind CSS, Radix UI / shadcn/ui, lucide-react
- **Quality:** TypeScript, ESLint, Prettier, Vitest, Playwright

---

## Local development

```bash
npm install
cp .env.example .env        # set DATABRICKS_HOST, DATABRICKS_WAREHOUSE_ID, and serving endpoint
npm run dev                 # hot-reload dev server
```

Without Lakebase/serving env vars the app degrades gracefully: structured search still works, and
the shortlist fails soft. See `.env.example` for the variables.

Code quality:

```bash
npm run typecheck
npm run lint        # npm run lint:fix
npm run format      # npm run format:fix
```

## Deployment (Databricks Asset Bundles)

> ⚠️ **Two steps, in order.** `apps deploy` recompiles the copy already in the workspace — it does
> **not** sync local files. Always `bundle deploy` first, then `apps deploy`.

```bash
# 1) sync files to the workspace
databricks bundle deploy -t default --profile DEFAULT

# 2) recompile & roll out the app
databricks apps deploy referral-copilot -t default --profile DEFAULT
```

Resource IDs (warehouse, Lakebase branch/database, serving endpoint) are configured in
`databricks.yml` under `targets.default`.

## Project structure

```
client/                  # React frontend
  src/App.tsx            # main UI (search, two-axis evidence, shortlist, filters)
  src/shortlist.ts       # shortlist hook
server/
  server.ts              # Express app + routes
  parse.ts               # NL → {need, city, state} via Model Serving
  shortlist.ts           # Lakebase CRUD (parameterized, Zod-validated)
config/queries/          # SQL: facility_search, specialties, cities, states
docs/                    # demo script, cold-start runbook, warm-up script
databricks.yml           # bundle / resource configuration
app.yaml                 # app runtime configuration
```

## License

[MIT](./LICENSE) © 2026 Referral Copilot Team
