# Architecture

gridsim is a hackathon prototype. It joins a live ERCOT snapshot with a simulated fleet of Base Power-style home batteries and draws that fleet on a minimal map.

## Layers

1. **ERCOT grid.** Public dashboard JSON is fetched with no key: system demand, the short demand forecast, and five-minute generation by fuel, including power-storage megawatts. When `ERCOT_USERNAME`, `ERCOT_PASSWORD`, and `ERCOT_SUBSCRIPTION_KEY` are set, the official Public API adds binding transmission constraints, settlement-point LMPs, and a capped page of electrical-bus LMPs. Raw payloads are stored in SQLite before they are normalized.
2. **Geographic network.** Homes are placed around the ERCOT metros in `data/anchors.json`. Those anchors are city coordinates used only to lay out the synthetic fleet. They are not ERCOT buses. Each neighborhood centre is a modeled distribution substation that the homes around it supply. A transmission edge is drawn only when a constraint names both `from_station` and `to_station` and both codes exist in `data/station_geo.json`. The two kinds of station are not the same thing.
3. **Synthetic distribution / VPP.** Each home is the chain grid → meter → disco → panel → base. The disco stands in for a Raspberry Pi at the disconnect, measuring power in and power out. Load, battery dispatch, and sensor noise come from the statistical model in [simulation.md](simulation.md).

## Path

```
ERCOT dashboard JSON
  and, when configured, api.ercot.com public-reports
    → raw_records (SQLite)
    → normalized grid snapshot, constraints, prices
    → fleet tick (one battery at a time: load, dispatch, sensor noise, control charts)
    → sim agent audits alarming charts and armed homes, and appends unit_actions
    → metric_logs, observations, control_points, dispatch_ticks (SQLite)
    → when configured, Supabase receives the dispatch row, the market row,
      unit_latest, closed usage hours, and action status
    → GET /api/scene and GET /api/dispatch
    → Three.js map, the actions list, and the selected battery's charts
    → a controller reads market_ticks, unit_latest, and usage_hours
      and writes the next fleet call (dispatch_orders or POST /api/dispatch)
      or a per-unit row (unit_actions or POST /api/actions)
    → the next tick applies those rows. It does not wait on the model.
```

There is no login. The map and `/api/scene` are the entry points. Official ERCOT credentials stay in the environment and are never returned by the API.

## Two API shapes

At 3000 batteries the old single payload would have been tens of megabytes, because it carried every component's metrics and every chart's history for every unit. So the API is split by what each view needs:

- `GET /api/scene` is the map. One small row per battery — id, metro, the distribution substation it supplies, position, state, state of charge, and the flagged chart codes when there are any — plus the metro list, the substation list, the fleet rollup, the error-code key, ERCOT grid context, the 24-hour `day` trace, prices, constraints, and edges. About 330 KB for 3000 units, cheap to poll every 5 seconds.
- `GET /api/site/{id}` is one battery in full: every component's metrics, every chart with its residual history, the unit's own profile, which charts are armed, and `agent_call` when dispatch is on. A few kilobytes, fetched when the modal opens and refreshed while it stays open.
- `GET /api/dispatch` is the real-time control row: the call that was just applied, the order waiting for the next tick, and the snapshot a controller reads (demand, storage, frequency, fleet totals). `POST /api/dispatch` with `{"signal": "push", "intensity": 0.8}` sets that waiting order. `{"signal": "auto"}` returns the decision to the ladder. The next tick applies it. The tick does not wait on a model.
- `POST /api/actions` with `{"site_id", "kind", "note", "payload"}` queues one unit action. Kinds and payloads are in [llm.md](llm.md). The scene payload includes `market`, the latest `actions`, and the add-on catalog so the side panel can show them.
- `POST /api/agent` with `{"site_id", "chart_id", "armed"}` arms or clears a chart code on one home. `chart_id` of `all` covers every code. `{"site_id", "dispatch": true}` lets the sim agent choose push or pull for that home. `GET /api/agent` lists homes with either flag set. The rules are in [simulation.md](simulation.md).

## Map

The state is a filled outline from `web/geo.js`, with longitude compressed by `cos(31°)` so Texas is not stretched.

Every battery is one particle, coloured by what it actually did this tick: amber pushing to the grid, blue pulling from it, green holding, red when a control chart is out of limits, grey while a scheduled service has the base offline. The fleet is a single particle draw, position and colour on the point, so 3000 units cost about as much as one. The particles keep a fixed size on screen. Zooming in opens the gaps between them, and each station's homes are a hex patch, so the service area stays readable instead of collapsing into one speck. The selected unit gets a pale ring. The ring stays a small mark as the camera moves, and it is hidden while a substation fills the frame. A click uses the position the dot is drawn at.

Left-drag orbits the camera, the wheel zooms, and right-drag pans the orbit target. The target stays inside a box around the state, so a long drag cannot lose Texas.

The homes in a neighborhood sit on a hex around one modeled distribution substation. That substation, not the downtown dot, is the center of the patch. Hovering the city dot names the metro and how many substations it holds. Clicking it flies into the city. On the way in, each neighborhood is gathered on its substation, and once the camera arrives the homes unfold into their hexes, one substation after another. Hovering a substation diamond names it and how many units supply it. Clicking the diamond, or any home in that neighborhood, opens that service area. The camera comes down over the hex, and once it arrives only that substation's homes stay on the map and ease outward until they reach the edges of the frame. A click lands on the home you see. A card names the substation with how many are pushing, pulling, holding, and flagged. `/#metro/austin` and `/#station/aus-s03` open those same views. The side panel lists each substation as a service area, and clicking one opens that same view. Once the camera is inside a city, a **back** button sits on the map. From a substation it returns to that city. From a city, or from a wheel zoom with no substation chosen, it returns to the whole state.

Metro hubs are separate dots, sized by how many batteries they hold. Only metros holding at least 3% of the fleet are labelled, which keeps five or six names on the map instead of twenty-one.

A constraint arc connects two stations named by a live ERCOT binding constraint. It is drawn only when the subscription key is set and both station codes appear in `data/station_geo.json`. The pale ring marks the selected unit, and it stays off the frame while a substation is open.

A card in the top left of the map draws the last 24 hours of system demand and the price, with the next 6 hours of forecast dashed. Demand and price are the two series in [ercot-sources.md](ercot-sources.md). The back button sits to the right of that card.

The side panel starts collapsed. Opened, it is a short stack of headings: Fleet, Market, Actions, Codes, Needs attention, and Service areas. Each heading starts collapsed, and an open list scrolls inside itself, so the headings stay on screen. Fleet counts add up to the fleet, and stored energy is the sum of every unit. Grid interchange stays in the header. The full power split stays on `fleet` in the scene payload. Service areas are the modeled distribution substations; clicking one flies the camera there. Binding constraints stay on the scene payload for the map, and the panel does not list them.

Hit testing projects the drawn positions to screen space once per camera move and caches them, so hovering stays smooth. Homes that are not on the map are not clickable.

## Unit view

Clicking a node on the map or a row in the exception queue opens one unit.

The unit view is a one-line diagram: grid, disco, panel, base. The meter is not its own box. Its reading is the grid box, and `disco_meter_delta` opens from that box. The data contract in [contracts.md](contracts.md) still records `meter` separately. The connectors carry the measured flow, so the arrow direction is import or export and the dash speed and line weight follow the kilowatts. The panel branch leaves the disco sideways because house load is the one leg that never reverses.

Every box is a control. Clicking one shows that box's metrics. A box carries a red mark when one of its charts is out of limits and an amber one when a chart is only in warning, so the fault is visible on the hardware before anything is clicked.

A metric that a chart watches opens that one chart. The chart draws the center line and the 1σ, 2σ, and 3σ lines. Other charts on the unit stay closed. Each code on the open box can be triggered, and the unit can trigger every code or hand its call to the sim agent.

The open unit lives in the URL fragment, so `/#hou-0002` is a link straight to one cabinet. Append a block, as in `/#hou-0002/disco`, to open on that block. `/#hou-0002/meter` opens Grid.

## Persistence

`data/gridsim.db` holds the tables in [database.md](database.md): raw ERCOT payloads, one utility snapshot per interval, one identity row per battery, component logs, a flat observation row for machine learning, and one control-chart point per battery per chart per tick.

The database file is local and gitignored. The controller tables are also created in Supabase by the migrations in [deploy.md](deploy.md). Restarting the process creates a new fleet state; rows already on disk remain until the cap drops the oldest. Open actions and installed add-ons are reloaded from SQLite, then from Supabase when those credentials are set.

## Run

From the repo root, with Python 3.11+:

```
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn gridsim.api:app --port 8000
```

Open `http://127.0.0.1:8000`.
