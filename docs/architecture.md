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

## Map

The state is a filled outline from `web/geo.js`, with longitude compressed by `cos(31°)` so Texas is not stretched.

Each battery is a node: a dot in the dispatch color, a ring around it filled to state of charge, a red ring when a control chart is out of limits, and a pale ring on the selected one. Nodes sit on two service-territory rings around their city hub, so no two cities overlap and no node hides another. Those rings are layout, not addresses.

Two kinds of arc are drawn, and they mean different things:

- **Feeder arcs** connect a battery to its city hub. This is the modeled distribution relationship, the same grouping as `load_zone`. The arc takes the battery's dispatch color, so a glance shows which part of the fleet is exporting.
- **Constraint arcs** connect two stations named by a live ERCOT binding constraint. They are drawn only when the subscription key is set and both station codes appear in `data/station_geo.json`. No arc is drawn between city hubs, because ERCOT data does not support that topology.

Choosing a maintenance family in the panel dims every battery whose charts in that family are in control, so the map answers one question at a time.

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
