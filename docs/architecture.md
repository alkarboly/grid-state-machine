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
    → fleet tick (load, dispatch, sensor noise, z-scores)
    → metric_logs (SQLite)
    → GET /api/scene
    → Three.js map
```

There is no login. The map and `/api/scene` are the entry points. Official ERCOT credentials stay in the environment and are never returned by the API.

## Persistence

`data/gridsim.db` holds:

- `raw_records` — unmodified ERCOT payloads
- `metric_logs` — one row per component per site per tick

The database file is local and gitignored. Restarting the process creates a new fleet state; logs already on disk remain until the row cap drops the oldest.

## Run

From the repo root, with Python 3.11+:

```
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn gridsim.api:app --port 8000
```

Open `http://127.0.0.1:8000`.
