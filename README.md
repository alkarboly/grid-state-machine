# gridsim

Live ERCOT demand and storage, joined to a simulated fleet of Base-style home batteries. The map is a minimal Three.js view of those homes.

Demand, the short forecast, and fuel mix (including power-storage megawatts) come from ERCOT's public dashboard feeds and need no key. Binding constraints, settlement-point prices, and electrical-bus prices turn on when the official Public API credentials are in `.env`.

Homes are synthetic. They sit near Austin, Houston, Dallas, and San Antonio so the fleet has a footprint, not because those coordinates are substations. A transmission line is drawn only when ERCOT names both ends of a binding constraint and both station codes are in `data/station_geo.json`.

## Run

Python 3.11+.

```
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
uvicorn gridsim.api:app --port 8000
```

Open http://127.0.0.1:8000. The page loads Three.js from a CDN.

```
python -m unittest discover -s tests -t .
```

## Credentials

Leave `.env` empty and the map still runs on the live dashboard. Deploy steps for Supabase and the two Render services are in [docs/deploy.md](docs/deploy.md). To add constraints and prices, register at the [ERCOT API Explorer](https://apiexplorer.ercot.com/), subscribe, and copy the primary key:

```
ERCOT_USERNAME=you@email.com
ERCOT_PASSWORD=
ERCOT_SUBSCRIPTION_KEY=
```

Do not commit `.env`.

Where the build stands, and the next slice, is [docs/status.md](docs/status.md). Contracts, the dispatch rules, and the open questions are in [docs/README.md](docs/README.md).
