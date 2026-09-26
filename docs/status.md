# Status

Handoff for the next session. Names and shapes stay in the other pages. This page says what already runs, what is only on this machine, and the slice to build next.

Do not commit `.env` or `data/gridsim.db`.

## Built and on `main`

Live ERCOT demand, the short forecast, and fuel mix, including storage megawatts, with no key. Binding constraints, settlement-point LMPs, and a capped page of bus LMPs turn on when `ERCOT_USERNAME`, `ERCOT_PASSWORD`, and `ERCOT_SUBSCRIPTION_KEY` are set. Raw payloads land in SQLite first. Sources are [ercot-sources.md](ercot-sources.md).

A simulated fleet of 3000 Base-style homes. Default energy is the published 39.2 kWh. Continuous power defaults to 11.5 kW, which is an assumption. Each home is grid → meter → disco → panel → base. Every home starts healthy. Arming a chart is the only fault. The maintenance manager opens one ticket, tries a system reset when that fault allows it, and escalates the same row to an agent visit when the reset does not clear it. Physics and the dispatch ladder are [simulation.md](simulation.md). Six chart families and the machine-learning row are [control-charts.md](control-charts.md) and [database.md](database.md).

The map is one particle draw. Homes sit on a hex around a modeled distribution substation, not around the downtown dot and not on an ERCOT station code. Clicking a city unfolds each neighborhood from its substation. Clicking a neighborhood opens only that substation, and the homes ease out to fill the frame. Clicks land on the drawn dots. `/#metro/austin` and `/#station/aus-s03` open those views. City labels are sized to the measured name. Only metros holding at least 3% of the fleet are labelled. San Antonio’s label grows west so the name stays on the map.

One fleet call per tick. `POST /api/dispatch` or the newest Supabase `dispatch_orders` row is applied on the next tick. The tick does not wait on a model.

Per-unit control is a `unit_actions` row: `scheduled_service`, `set_signal`, `install_addon`, `remove_addon`. The bot writes `return_online` when a service window ends. The disco tracks `solar` (5 kW source) and `ev_charger` (7.2 kW load). The read model is `market_ticks`, `unit_latest`, and `usage_hours`. The contract is [llm.md](llm.md). The SQL files and the Render web service are [deploy.md](deploy.md).

Feeder lines from homes to substations are gone. The pale ring marks the selected unit. The right panel collapses, and its ledger sums every unit. Inside a city or a substation, **back** sits on the map. Opening a battery draws no line back to its city.

The sim agent runs after each tick's charts. An alarming code opens one ticket. A reset uses `actor` `maintenance`. An escalated visit uses `actor` `llm`. Frequency is left alone. A warning is left alone. `POST /api/agent` arms any chart, or all of them, so the residual is forced to +4 sigma. The same route sets dispatch on one home: push or pull from the simulated (or ERCOT) rate and that home's expected load, using closed usage hours when they exist. A decision from the ladder, the sim agent, the remote model, or a user post carries the clause that fired. The sidebar marks the threshold. A maintenance row then quotes the procedure for that code. A card in the top left draws 24 hours of ERCOT demand and the price, including a 6-hour forecast. The sim agent reads that same trace when it chooses push or pull. Each home keeps a state log of recent ticks, and each control chart draws the last 30 hours. Startup fills both with simulated rows. The header shows export or import, mean state of charge, and flagged homes, with the sim time on the right.

`GET /api/site/{id}` returns a state `snapshot`, and each `state_log` row is the log state in [contracts.md](contracts.md). Together they are the physics and the call for one home. The unit view is grid, disco, panel, and base. House load is on the electrical panel. From Grid you can turn the grid off, trigger a meter agreement, or force push, pull, or hold. Disco triggers voltage or frequency. Base posts a maintenance ticket and does not trigger dispatch. No box offers trigger-all. A box, a metric, or a chart that is out of control is red. The side panel lists Agent cases, each with a status pill, and Maintenance alerts for homes past ±3σ. Agent cases and Maintenance alerts start collapsed.

## In the working tree

An agent case and the unit's agent row show the latest step and a timer to `ends_at`.

The in-tick writer is two managers. The maintenance manager opens one ticket per alarming code, tries a system reset when that fault allows it, and escalates that same row when the reset does not clear it. The fleet manager posts the price call with `actor` `fleet` on a home set to dispatch. An open code response still outranks that call. Each home draws its own `hour_kw` from the shared daily energy, and the fleet manager compares this hour with that owner's average. Closed panel usage replaces the prior for that clock hour. The side panel lists them as Fleet manager and Maintenance manager. A maintenance manager row selects that home and opens the chart on the case, the same way a maintenance alert selects a home. Maintenance manager and Maintenance alerts follow the drill-down: the open unit, otherwise the open substation, otherwise the open city, otherwise the state. A decisions log at the bottom of the side panel appends fleet call changes and manager steps as they arrive. A user post and a remote-model row are filed by the job. `sim` remains a valid actor for a row written before the split. `return_online` keeps the actor of the service it closes.

## Not standing yet

The web service is described in `render.yaml` and [deploy.md](deploy.md). It serves the map and the API from one process. The Supabase project and that Render service have not been created from this repo. Until they are, the map people open is the local process, and a model has nowhere to write except `POST /api/actions` on that process.

`LLM_URL` is unset, so no remote model is called. The maintenance manager still resolves alarming codes, and the fleet manager still resolves a home set to dispatch. The remote request and response shapes are in [llm.md](llm.md).

`rate_basis` on the local map is `simulated` until the official price reports return rows. The public dashboard is already live.

Facts the code is not allowed to invent are [gaps.md](gaps.md): the ERCOT subscription key, real neighborhood positions, station coordinates, the settlement-point to bus join, disco hardware, and a metered load shape.

A `scheduled_service` on `aus-0004` was inserted only to check the Agent list. It lives in the running process and in local SQLite. It is not a fixture to recreate.

## Next

1. Create the Supabase project and run the three SQL files in [deploy.md](deploy.md), in filename order. Create `gridsim` from `render.yaml`. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on that service only. Leave `API_BASE` empty. Do not paste those keys, or the ERCOT password, into chat. Leave `.env` and `data/gridsim.db` out of git.
2. Confirm the deploy check in [deploy.md](deploy.md): the fleet appears, the Now block has a rate, and a `scheduled_service` row takes `aus-0004` offline and the bot writes `return_online` when the window ends.
3. Point a model at that bus. Either set `LLM_URL` or let the model insert `unit_actions`. The tick still applies rows on the next pass. It does not call the model inline.
4. When the ERCOT subscription key is available, set the three credentials on the bot so `rate_basis` can be `ercot`.
5. Add a station pair to `data/station_geo.json` only for codes a live constraint actually names, with a source note. That is what draws a constraint arc.

After the bus is up, the open joins in [gaps.md](gaps.md) are the settlement-point to electrical-bus report, then replacing the assumed kilowatts, load shape, and neighborhood positions with real territory data. Leave those numbers alone until the data exists.
