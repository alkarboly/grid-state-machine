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
    → maintenance manager opens or escalates a ticket, then the fleet manager posts a price call, and both append unit_actions
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

The header tabs are **fleet** and **architecture**. Architecture draws this path as the same kind of diagram as a home, with one band per environment. ERCOT is outside. The API server is one process: the simulation, the contracts in memory, and the HTTP routes. Deployed, that process is the Render web service `gridsim`. That service has not been created, so the machine running the map is it. SQLite is `data/gridsim.db` on that service's disk, which is ephemeral on Render. It keeps identity, raw ERCOT payloads, component logs, observations, control points, fleet rollups, and a copy of `dispatch_ticks`. Supabase is a separate hosted Postgres project, also not created yet. It keeps the controller tables: `market_ticks`, `unit_latest`, `usage_hours`, `dispatch_orders`, `dispatch_ticks`, `unit_actions`, `addon_catalog`, and `site_addons`. The browser polls this origin only and cannot read either database. The data contract in [contracts.md](contracts.md) is the component metrics, the snapshot, and the log state. The log state stays in process memory. The controller contract in [llm.md](llm.md) is what a remote model reads from Supabase and which `unit_actions` it may write. That model is outside the tick. An escalated maintenance ticket is closed by pulling `GET /api/site/{id}` on this API server. `LLM_URL` is unset, so the fleet read-model POST is not called. Clicking a box states that step. The notes follow each scene poll. `/#architecture` opens it.

There is no login. The map and `/api/scene` are the entry points. Official ERCOT credentials stay in the environment and are never returned by the API.

## Two API shapes

At 3000 batteries the old single payload would have been tens of megabytes, because it carried every component's metrics and every chart's history for every unit. So the API is split by what each view needs:

- `GET /api/scene` is the map. One small row per battery — id, metro, the distribution substation it supplies, position, what it did (`state`), the call and owner on that home (`signal`, `source`), state of charge, whether the contactor is `on` or `off` (`grid`), and the flagged chart codes when there are any — plus the metro list, the substation list, the fleet rollup, the error-code key, ERCOT grid context, the 24-hour `day` trace, `shape` (the fleet manager's reading of that trace), `tick_seconds`, prices, constraints, and edges. `supabase` and `llm` are each `live`, `disabled`, or `error`. About 330 KB for 3000 units, cheap to poll every 5 seconds.
- `GET /api/site/{id}` is one battery in full: every component's metrics, every chart with its 30-hour residual trace, the unit's own profile, the `state_log`, the `snapshot` that can rebuild the home, which charts are armed, `agent_call` when dispatch is on, and recent actions with service tickets kept so a closed visit stays visible. It also returns `duty`, `reserve_frac`, and `intensity` (the depth of the call on this home this tick, after a `set_signal` replaces it or service zeros it). A few kilobytes, fetched when the modal opens and refreshed while it stays open.
- `GET /api/dispatch` is the real-time control row: the call that was just applied, the order waiting for the next tick, and the snapshot a controller reads (demand, storage, frequency, fleet totals). `POST /api/dispatch` with `{"signal": "push", "intensity": 0.8}` sets that waiting order. `{"signal": "auto"}` returns the decision to the ladder. The next tick applies it. The tick does not wait on a model.
- `POST /api/actions` with `{"site_id", "kind", "note", "payload"}` queues one unit action. Kinds and payloads are in [llm.md](llm.md). The scene payload includes `market`, `shape`, `calls`, and the latest `actions` (`actor` `fleet`, `maintenance`, `llm`, `api`, or a leftover `sim`) so the side panel can show the price, the day, and each manager's cases with status and the clause that fired.
- `POST /api/agent` with `{"site_id", "chart_id", "armed"}` arms or clears a chart code on one home and appends that step on the code's ticket. `chart_id` of `all` covers every code. `{"site_id", "dispatch": true}` lets the fleet manager choose push or pull for that home. `{"site_id", "grid": false}` opens the contactor. `GET /api/agent` lists homes with any of those flags set. The rules are in [simulation.md](simulation.md).

## Map

The state is a filled outline from `web/geo.js`, with longitude compressed by `cos(31°)` so Texas is not stretched.

Every battery is one particle, coloured by what it actually did this tick: green pushing to the grid, orange pulling from it, gray holding, red when a control chart is out of limits or the grid is off, dim slate while a scheduled service has the base offline. A flagged home, and a home with the grid off, stays red even when that service has taken the base offline, and it is drawn at the top of its group so the red dot stays visible. The colour and the flagged counts follow each scene poll, so a contactor change shows up on the next tick without a reload. The fleet is a single particle draw, position and colour on the point, so 3000 units cost about as much as one. The particles keep a fixed size on screen. Zooming in opens the gaps between them, and each station's homes are a hex patch, so the service area stays readable instead of collapsing into one speck. The selected unit gets a pale ring. The ring stays a small mark as the camera moves, and it is hidden while a substation fills the frame. A click uses the position the dot is drawn at.

Left-drag orbits the camera, the wheel zooms, and right-drag pans the orbit target. The target stays inside a box around the state, so a long drag cannot lose Texas.

The homes in a neighborhood sit on a hex around one modeled distribution substation. That substation, not the downtown dot, is the center of the patch. Hovering the city dot names the metro and how many substations it holds. Clicking it flies into the city. In city view, each substation is stacked as its own row: pull homes gather on the left, push homes on the right, and hold homes stay in the middle while the rows animate into place. The side lanes start outside the widest hold column, so however the fleet splits, the three groups never run together. There are no lane lines; the colours carry the split. The camera is framed from the layout it is about to draw and sits far enough back that the whole stack fits with room around it, clear of the cards on the left. The row label names the substation and the homes around it keep that row clickable. Clicking the row, or any home in it, opens that service area. That view uses the same three groups, and the homes ease from their places on the ground into the block. A click lands on the home you see. The lower-left card follows the active filter scope (state, metro, service area, or selected home). Its key reads left to right with the lanes: pulling, holding, pushing, then flagged. `/#metro/austin` and `/#station/aus-s03` open those same views. Once the camera is inside a city, a **back** button sits on the map. From a substation it returns to that city. From a city, or from a wheel zoom with no substation chosen, it returns to the whole state.

Metro hubs are separate dots, sized by how many batteries they hold. Only metros holding at least 3% of the fleet are labelled, which keeps five or six names on the map instead of twenty-one.

A constraint arc connects two stations named by a live ERCOT binding constraint. It is drawn only when the subscription key is set and both station codes appear in `data/station_geo.json`. The pale ring marks the selected unit, and it stays off the frame while a substation is open.

A card in the top left of the map draws the last 24 hours of system demand and the price, with the next 6 hours of forecast dashed. Demand and price are the two series in [ercot-sources.md](ercot-sources.md). The back button sits to the right of that card. The header's right side is the sim time of the latest tick, the same clock as the state log. The header's center is the live operating strip: export or import (the fleet's net megawatts at the grid), mean state of charge, and how many homes are past ±3σ or have the grid off. Demand and price stay on the 24h card. The ERCOT feed is named there only when it is not live.

A decisions log sits at the bottom of the side panel. Each line is one state-machine decision: a fleet call when its signal or clause changes (`calls`), or a manager, user, or model step (`actions`). Each escalation step on a ticket is its own line. The line is the sim time, who decided, the home when there is one, and the step. A ladder call (`rules`) and a manager step (`fleet`, `maintenance`, or a leftover `sim`) are labeled `[state machine]`. A user post is `user`. A model step is `model`. A model close also names the evidence pulled for that home. The first clause is the reason when the step does not already name it. The log keeps the latest twelve. Newest is at the top, and a new poll appends only decisions that were not already shown. A home id opens that unit.

The side panel starts open. It is Now (price, day shape, the fleet call, and the clause that fired), Fleet manager, Maintenance manager, and Maintenance alerts. Fleet manager lists price calls and other posted push, pull, hold, and add-on rows. Maintenance manager lists code responses and service tickets for the homes in this view, including closed tickets, so the escalation history stays visible. Each of those rows is a button, the same kind of control as a maintenance alert: the status, the home, and the step. Choosing one opens that home on the chart named in the case. A user post or a remote-model row is filed by that job, and the case names who acted (user or model). Open cases (pending or active) sit above closed ones. Each maintenance ticket lists every escalation step, with the time, who acted, and the result. A model close also shows the evidence and the pull payload (`pull` and `decision` from [llm.md](llm.md)) on that done case. A maintenance or fleet step is labeled `[state machine]`. A toggle is `user`. An agent visit is `model`. A status pill and a timer to `ends_at` sit on an open case. The same history sits on the open unit, on the box that owns that chart. Maintenance alerts are the homes in this view whose chart is past ±3σ, and homes whose grid is off. Each row is marked maintenance and names the chart code, or `grid off`. Choosing one opens that home. The view is the open unit, otherwise the open substation, otherwise the open city, otherwise the state. Fleet manager stays the fleet. Now starts open. The two manager lists and Maintenance alerts start collapsed. An open list scrolls inside itself. `actions` on the scene keep recent service tickets ahead of other rows, at most 40. `calls` is the fleet ladder when its clause changes, and the panel shows the current call in Now. The full power split stays on `fleet` in the scene payload. Binding constraints stay on the scene payload for the map, and the panel does not list them.

Hit testing projects the drawn positions to screen space once per camera move and caches them, so hovering stays smooth. Homes that are not on the map are not clickable.

## Unit view

Clicking a node on the map or a row in the exception queue opens one unit.

Opening a home puts the contract schema at the top of the detail column, as JSON, plus a dictionary of the same fields. Log state, the extra snapshot flags, the site ranges (`duty`, `intensity`, `reserve_frac`), and the dictionary each start collapsed. The names, allowed values, and meanings are the ones in [contracts.md](contracts.md). `duty`, `intensity`, and `reserve_frac` take their meanings from [simulation.md](simulation.md). These are the shapes, not this home's readings. The unit view is a one-line diagram: grid, disco, panel, base. The meter is not its own box. Its reading is the grid box, and `disco_meter_delta` opens from that box. The data contract in [contracts.md](contracts.md) still records `meter` separately. The connectors carry the measured flow, so the arrow direction is import or export and the dash speed and line weight follow the kilowatts. The panel branch leaves the disco sideways because house load is the one leg that never reverses.

Every box is a control. Clicking one shows that box's metrics and the simulation actions for that hardware. A box is red when one of its charts is out of control, or when the grid is off. It is amber only for a warning that is still in control. A metric tied to an out-of-control chart is red too.

Grid can turn the grid off, flag a meter disagreement, or force push, pull, or hold on this home for one hour. A meter disagreement compares the disco to the billing meter, and if they still disagree the agent posts scheduled service. Disco can flag voltage or frequency. Frequency is left on the cabinet; the line says so. Base can flag state of charge or temperature, or open a maintenance visit. It does not flag dispatch, and no box offers every code at once. Flagging a code that has a response opens or updates that ticket and appends a step. Clearing it appends a cleared step and closes the ticket. The steps stay listed on that box. Each control sits as a labeled row on the open box: the name, what it does, and the button.

A metric that a chart watches opens that one chart. The chart draws the center line and the 1σ, 2σ, and 3σ lines, and its x-axis is the last 30 hours. The trace is red when that chart is out of control. Other charts on the unit stay closed. The grid box shows the price and the day shape, the inputs to a push or pull call.

The state log sits under the metrics. Each line is one log-state row: the time, what the battery did, the call and its source, state of charge, house load, the kilowatts it moved, grid off when the contactor was open, and any chart codes out of control. Newest is first. While new ticks arrive, the log keeps its scroll position so reading older rows does not jump. The shape is the log state in [contracts.md](contracts.md).

The open unit lives in the URL fragment, so `/#hou-0002` is a link straight to one cabinet. Append a block, as in `/#hou-0002/disco`, to open on that block. `/#hou-0002/meter` opens Grid. `/#hou-0002/panel` opens the electrical panel.

## Persistence

`data/gridsim.db` holds the tables in [database.md](database.md): raw ERCOT payloads, one utility snapshot per interval, one identity row per battery, component logs, a flat observation row for machine learning, and one control-chart point per battery per chart per tick.

The database file is local and gitignored. The controller tables are also created in Supabase by the migrations in [deploy.md](deploy.md). Restarting the process creates a new fleet state; rows already on disk remain until the cap drops the oldest. Open actions, the latest closed service tickets, and installed add-ons are reloaded from SQLite, then from Supabase when those credentials are set. Supabase still supplies open actions for a controller. The closed ticket history reloaded at startup is the local log.

## Run

From the repo root, with Python 3.11+:

```
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn gridsim.api:app --port 8000
```

Open `http://127.0.0.1:8000`.
