# grid state machine

Live at https://gridstatemachine.com/. ERCOT demand and storage, joined to a simulated fleet of Base-style home batteries. The map is a minimal Three.js view of those homes.

Demand, the short forecast, and fuel mix (including power-storage megawatts) come from ERCOT's public dashboard feeds and need no key. Binding constraints, settlement-point prices, and electrical-bus prices turn on when the official Public API credentials are in `.env`.

Homes are synthetic. They sit near Austin, Houston, Dallas, and San Antonio so the fleet has a footprint, not because those coordinates are substations. A transmission line is drawn only when ERCOT names both ends of a binding constraint and both station codes are in `data/station_geo.json`.

Where the build stands is [docs/status.md](docs/status.md). Contracts, dispatch rules, and open questions are in [docs/README.md](docs/README.md).

## Submission

- [x] **Project title** — grid state machine
- [ ] **2–5 min demo video** (Loom). Show the core loop live.

    Record the running app, not slides. Open the fleet map, wait for a tick, read **Now** (the fleet call in words and why it fired). Open **Architecture**. Click one home, flag a chart, and show the maintenance ticket and the decisions log. Keep it under five minutes.

- [x] **Repo link** (public) — https://github.com/alkarboly/grid-state-machine
    - [x] Quick start
    - [x] Tech stack and architecture diagram
    - [x] How to reproduce the demo (env vars, sample `.env`)
    - [x] Datasets / synthetic data and provenance
    - [x] Known limitations and next steps
- [x] **Deployed URL** — https://gridstatemachine.com/
- [x] **Team roster** (names, roles, contacts)
- [x] **Short write-up** (below)

### Team roster

| Name | Role | Contact |
| --- | --- | --- |
| Ahmed Alkarboly | Data Engineer | |

## Quick start

Python 3.11+.

```
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
uvicorn gridsim.api:app --port 8000
```

On macOS or Linux, use `.venv/bin/activate` and `cp .env.example .env`.

Open http://127.0.0.1:8000. Startup fills 3000 homes and about two minutes of simulated history before the port opens. The page loads Three.js from a CDN. Leave `.env` blank: the public ERCOT dashboard still runs.

```
python -m unittest discover -s tests -t .
```

## Reproduce the demo

1. Copy `.env.example` to `.env`. Empty values are enough for the live dashboard, the map, the ladder, and the architecture tab.
2. Start the server as above and open http://127.0.0.1:8000 (or https://gridstatemachine.com/).
3. Fleet view: 24h demand and price, the Texas map, **Now** (price, day shape, fleet call, why it fired).
4. Click a city, then a home. Flag a chart on Disco or Base. The maintenance manager opens a ticket. The decisions log labels ladder and manager steps `[state machine]`.
5. Open **Architecture** (`/#architecture`).
6. Open **Protocols** (`/#protocols`) for when the state machine pushes, pulls, or holds.
7. Open **API** (`/#api`) for the public JSON routes.

Optional keys (never commit `.env`, never paste secrets into chat):

```
ERCOT_USERNAME=
ERCOT_PASSWORD=
ERCOT_SUBSCRIPTION_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
```

The three `ERCOT_*` values turn on official prices and constraints. `SUPABASE_*` copies controller tables to hosted Postgres. `OPENAI_API_KEY` turns on a two-sentence summary of escalated service tickets. Deploy is [docs/deploy.md](docs/deploy.md). Sample file is `.env.example`.

## Tech stack

- Python 3.11, FastAPI, uvicorn — one process is the API and the map
- SQLite (`data/gridsim.db`, gitignored) — written every tick
- Optional Supabase (hosted Postgres) — copy of dispatch, market, and actions
- Three.js (CDN) — fleet map
- ERCOT public dashboard JSON; optional ERCOT Public API

## Architecture

Ingest takes the ERCOT snapshot and a simulated on-premises gateway stream and runs every home under the data contract. The state machine then chooses discharge, charge, or hold from Texas demand and ERCOT storage. OpenAI summarizes an escalated service ticket. The API copies controller tables to Supabase when the keys are set. The browser only talks to this origin. Full path: [docs/architecture.md](docs/architecture.md).

```mermaid
flowchart LR
  ERCOT --> ingest[data ingest protocol]
  gateway[on-premises gateway] --> ingest
  ingest --> machine[state machine]
  ingest -->|copy| supabase[Supabase]
  machine --> map[browser map]
  machine --> openai[OpenAI]
```

## Datasets and synthetic data

| Source | What | Provenance |
| --- | --- | --- |
| ERCOT supply-demand and fuel-mix JSON | Live system demand, short forecast, power-storage megawatts | Public dashboard feeds, no key. URLs in [docs/ercot-sources.md](docs/ercot-sources.md). |
| ERCOT Public API (optional) | Binding constraints, settlement-point and bus LMPs | Official reports when `ERCOT_USERNAME`, `ERCOT_PASSWORD`, and `ERCOT_SUBSCRIPTION_KEY` are set. |
| `data/anchors.json` | 21 ERCOT metro points and household counts | Layout only. Counts are household estimates times an `adoption` multiplier (Central Texas weighted). Not customer addresses. [docs/simulation.md](docs/simulation.md). |
| Simulated fleet | 3000 Base-style homes: load, dispatch, sensor noise, charts | Generated in this process each tick. Gateway samples are generated here too; there is no field device. Disco hardware is unknown. |
| `web/geo.js` | Texas outline | Same outline the map draws. Homes that would land in water are rejected. |
| `data/station_geo.json` | Constraint endpoints | Empty unless you add a code pair ERCOT actually named. |

Do not commit `.env` or `data/gridsim.db`.

## Known limitations and next steps

Prototype policy, not an ERCOT market award. Gaps in [docs/gaps.md](docs/gaps.md): official prices need the subscription key; neighborhood positions and load shape are not metered; 11.5 kW is an assumption; disco hardware is unknown; station coordinates are unpublished; bus-to-home join is not ingested. Data collection is simulated — sample content, rate, and what a PLC-style app could collect are assumptions. Charts are not statistically accurate; sample size was not verified for the hackathon. Architecture is a hackathon setup and needs a production refactor.

Next: keep Render and Supabase healthy; set ERCOT credentials when the key exists; replace assumed kW, load, and territory counts only with real data. [docs/status.md](docs/status.md).

## Short write-up

Texas already has home batteries that can charge and discharge against ERCOT. What is missing is a live picture: what the interconnection is doing, what the fleet was asked to do, which cabinets answered, and which ones are in trouble.

gridsim is for a VPP operator and the person who has to visit a cabinet. It is a hackathon prototype, not a market award and not a real service territory.

Each tick pulls ERCOT's public dashboard (demand, the short forecast, and whether Texas-wide storage is charging or discharging). A simulated on-premises gateway contributes one sample per home. Data-contract ingest runs load, dispatch, noise, and control charts, then writes SQLite. Adherence to that contract is how ingest keeps data quality. A state machine on the API server chooses discharge, charge, or hold from those ERCOT numbers. A light call reaches about a third of each service area, emptiest first on charge and fullest first on discharge. A chart past its limits opens a maintenance visit. The browser is a Three.js map of 3,000 Base-style homes. Official prices and hosted Postgres turn on only when those keys are set.

Once those rows are stored — SQLite every tick, and hosted Postgres when the keys are set — the same telemetry feeds control charts for automated anomaly detection. Chart flags and posted fleet calls are built in to stress the state machine's rules. When a visit is escalated, an LLM writes a two-sentence summary from that home's contract readings. Without the key, that text is the chart sentence.

The impact is that loop in one place: live Texas context, a readable fleet call, a cabinet you can open, and a ticket when something is out of control. The homes are synthetic. The ERCOT snapshot is not.
