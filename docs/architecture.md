# Architecture

gridsim is a hackathon prototype. It joins a live ERCOT snapshot with a simulated fleet of Base Power-style home batteries and draws that fleet on a minimal map.

## Layers

1. **ERCOT grid.** Public dashboard JSON is fetched with no key: system demand, the short demand forecast, and five-minute generation by fuel, including power-storage megawatts. When `ERCOT_USERNAME`, `ERCOT_PASSWORD`, and `ERCOT_SUBSCRIPTION_KEY` are set, the official Public API adds binding transmission constraints, settlement-point LMPs, and a capped page of electrical-bus LMPs. Raw payloads are stored in SQLite before they are normalized.
2. **Geographic network.** Homes are placed around four city anchors in `data/anchors.json`. Those anchors are city coordinates used only to lay out the synthetic fleet. They are not ERCOT buses. A transmission edge is drawn only when a constraint names both `from_station` and `to_station` and both codes exist in `data/station_geo.json`.
3. **Synthetic distribution / VPP.** Each home is the chain grid → meter → disco → panel → base. The disco stands in for a Raspberry Pi at the disconnect, measuring power in and power out. Load, battery dispatch, and sensor noise come from the statistical model in [simulation.md](simulation.md).

## Path

```
ERCOT dashboard JSON
  and, when configured, api.ercot.com public-reports
    → raw_records (SQLite)
    → normalized grid snapshot, constraints, prices
    → fleet tick (one battery at a time: load, dispatch, sensor noise, control charts)
    → metric_logs, observations, control_points (SQLite)
    → GET /api/scene
    → Three.js map and the selected battery's charts
```

There is no login. The map and `/api/scene` are the entry points. Official ERCOT credentials stay in the environment and are never returned by the API.

## Two API shapes

At 3000 batteries the old single payload would have been tens of megabytes, because it carried every component's metrics and every chart's history for every unit. So the API is split by what each view needs:

- `GET /api/scene` is the map. One small row per battery — id, metro, position, state, state of charge, and the flagged families when there are any — plus the metro list, the fleet rollup, ERCOT grid context, prices, constraints, and edges. About 330 KB for 3000 units, cheap to poll every 5 seconds.
- `GET /api/site/{id}` is one battery in full: every component's metrics, every chart with its residual history, and the unit's own profile. A few kilobytes, fetched when the modal opens and refreshed while it stays open.

## Map

The state is a filled outline from `web/geo.js`, with longitude compressed by `cos(31°)` so Texas is not stretched.

Every battery is one dot, coloured by what it actually did this tick: amber pushing to the grid, blue pulling from it, grey holding, red when a control chart is out of limits. The whole fleet is a single instanced draw call, with position and colour on the instance, so 3000 units cost about as much as one. A flagged unit gets a red ring; the selected unit gets a pale one.

Metro hubs are separate dots, sized by how many batteries they hold. Only metros holding at least 3% of the fleet are labelled, which keeps five or six names on the map instead of twenty-one.

Two kinds of arc are drawn, and they mean different things:

- **Exception arcs** connect a flagged battery, or the selected one, to its metro hub. One arc per battery would be a hairball at this scale and would say nothing, so arcs are reserved for the units that need a person. The arc takes the unit's colour.
- **Constraint arcs** connect two stations named by a live ERCOT binding constraint. They are drawn only when the subscription key is set and both station codes appear in `data/station_geo.json`. No arc is drawn between metro hubs, because ERCOT data does not support that topology.

Choosing a maintenance family in the side panel dims every battery that is not out of limits in that family, so the map answers one question at a time. The side panel is an exception queue and a metro list rather than a roster of every unit; clicking a metro flies the camera to it.

Hit testing projects all 3000 positions to screen space once per camera move and caches them, so hovering stays smooth.

## Unit view

The side panel is the fleet roster. Clicking a node on the map or a row in the roster opens one unit.

The unit view is a one-line diagram of the chain in [contracts.md](contracts.md): grid, meter, disco, panel, base. The connectors carry the measured flow, so the arrow direction is import or export and the dash speed and line weight follow the kilowatts. The panel branch leaves the disco sideways because house load is the one leg that never reverses.

Every box is a control. Clicking one shows that component's metrics and only the control charts that name it, which is why `component` is part of the chart contract. A box carries a red mark when one of its charts is out of limits and an amber one when a chart is only in warning, so the fault is visible on the hardware before anything is clicked.

Metrics that a chart watches are themselves clickable and open that chart. Clicking a chart header expands it to the measured value, the expected operating point, sigma, and the limits.

The open unit lives in the URL fragment, so `/#hou-0002` is a link straight to one cabinet.

## Persistence

`data/gridsim.db` holds the tables in [database.md](database.md): raw ERCOT payloads, one utility snapshot per interval, one identity row per battery, component logs, a flat observation row for machine learning, and one control-chart point per battery per chart per tick.

The database file is local and gitignored. Column names are the shape intended for Supabase Postgres. Restarting the process creates a new fleet state; rows already on disk remain until the cap drops the oldest.

## Run

From the repo root, with Python 3.11+:

```
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn gridsim.api:app --port 8000
```

Open `http://127.0.0.1:8000`.
