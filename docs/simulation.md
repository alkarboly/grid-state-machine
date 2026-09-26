# Simulation

Homes are synthetic. ERCOT demand, storage, and prices are not.

## Fleet

`FLEET_SIZE` batteries, **3000** by default, spread across the 21 ERCOT metros in `data/anchors.json`.

Every battery draws its own `load_scale`, temperature center and sigma, voltage center and sigma, one-way efficiency, customer reserve, and dispatch duty. Those values are the `sites` row and they do not change when a fault is applied. The draw is seeded on the site id, so a restart puts every battery back on the same roof with the same personality.

Each cabinet uses the published Base Core energy, **39.2 kWh**. Continuous power defaults to **11.5 kW**. That power rating is an assumption, not a published Core figure. Override it with `BASE_POWER_KW`. State of charge starts spread between 22% and 92%, so some units begin with no room to discharge and some with none to charge.

### How many per metro

Each anchor carries `households_k` and an `adoption` multiplier. The weight is their product, and `apportion` splits `FLEET_SIZE` by largest remainder so the counts sum exactly. Adoption is where the assumption lives: Base Power started in Central Texas, so Austin is weighted well above its household share and the small metros well below. At 3000 units this lands about 820 in Austin, 630 in Houston, 500 in Dallas, 410 in San Antonio, 270 in Fort Worth, and a long tail down to 5 in Victoria.

The metro list is ERCOT only. El Paso is in WECC, Amarillo is in SPP, and Beaumont is Entergy Texas in MISO, so none of them appear. Lubbock does, because Lubbock Power & Light moved most of its load into ERCOT in 2021.

### Where inside a metro

A metro is a handful of neighborhoods, not a smooth ellipse. Big metros get up to eight centres; a small town gets one. Each centre is a Rayleigh draw at about 0.85 of `radius_km`, stretched by `stretch` along `axis_deg` east of north, so the clumps follow the built-up area: the Valley runs east-west, Austin runs up and down I-35. The homes around a centre sit on a hex lattice turned to that same axis, a few kilometres across, so the station's service area reads as a grid rather than a pile. A cell that would fall in the water is pulled back onto land.

Each centre is also the distribution substation those houses supply. The id looks like `aus-s03` and the name looks like `Austin 3`. A home keeps that station for the life of the process. These stations are modeled. They are not ERCOT station codes, they are not electrical buses, and they are not rows in `data/station_geo.json`.

Any draw that falls outside the Texas outline in `web/geo.js` is rejected. That outline is the same one the map draws, so a battery cannot sit in the Gulf or past the border. Coastal metros lose the samples that would have landed in the water, and the rest stay on the land side.

These are modelled addresses. They are not customer locations.

### Faults

Four named batteries carry scripted faults, one per maintenance kind, listed in [control-charts.md](control-charts.md). Two further cabinets of each of the five kinds (`temp_c`, `voltage_v`, `soc_bias_kwh`, `response_scale`, `disco_bias_kw`) are spaced through the rest of the fleet. That is 14 cabinets in total. Everyone else is healthy, so the map can show each failure mode without turning into a field of alarms.

## Home load

The panel is the house load. Its daily energy is a late-summer assumption of about 54 kWh times that battery's `load_scale` (a draw from 0.72 to 1.28). Each home then draws its own hour weights: a peak hour anywhere in the day, a width, and an overnight floor, normalized so the 24 hours sum to that daily energy. The result is `hour_kw`, seeded on the site id with the rest of the personality. Two homes with the same daily total do not peak in the same hour. This is still not a metered load shape.

The live target is `hour_kw` for the clock hour, times `0.85 + 0.30 * demand_percentile`, so the owner's shape stays put and every home sits a bit higher when ERCOT demand is in the top of today's range.

Each tick adds panel kilowatts times elapsed hours to an open bucket. When the clock hour changes, that bucket closes as one `usage_hours` row. `load_kwh` on that row is the panel, not grid import.

Load, service voltage, and cabinet temperature are states. Each tick moves them part of the way toward the new target instead of drawing a fresh number. Load remembers about twelve minutes, voltage about three, and the cabinet about fifteen. A small gaussian is the sensor noise on top of that move. Frequency is drawn once for the whole interconnection, and each disco adds a much smaller local error. The meter and the disco power readings stay independent measurement noise, because those sensors do not have memory of their own.

## Interchange

True net kilowatts = panel load + car-charger kilowatts − solar used on site + battery charge − battery discharge.

Solar and the car charger are optional add-ons. With neither installed, that is panel load + battery charge − battery discharge.

Positive net is grid/meter in. Negative net is grid/meter out. The grid component records that true split. The meter adds a tight error (standard deviation 0.02 kW on the net). The disco adds a wider error (standard deviation 0.06 kW) because it is the Pi measurement, not the billing meter.

The fleet ledger adds those same quantities across every unit. Pushing, pulling, and holding add up to the fleet. Grid in minus grid out adds up to house load plus car chargers minus solar plus solar that went into the batteries plus battery charge minus battery discharge. Solar used on site is the solar that did not charge the battery.

Each battery has its own one-way efficiency `eta`, drawn between 0.94 and 0.975. State of charge moves with wall-clock time unless `SIM_TIME_SCALE` is set above 1. Scale multiplies elapsed time inside the battery integral only. Log timestamps stay on the wall clock.

The coulomb count is `physical_soc_kwh`. The reported `soc_kwh` is that count plus a bias. A healthy battery has bias 0. `sat-0001` reports 2.5 kWh high, which is the energy-chart fault.

## Dispatch

The call is what the fleet was asked to do. An external order is one call for every home. With no order, the ladder below runs per home.

An external order is `{signal, intensity}` with `signal` of `push`, `pull`, or `hold`. It arrives on `POST /api/dispatch` and is applied on the next tick, or it is the newest row in Supabase `dispatch_orders`, which the tick reads when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set. `auto` clears the order and the ladder takes over. Intensity is optional: when it is omitted, the ladder's own intensity for that signal is used. Hold always has intensity 0. While an order is in force, every home receives it. Load-zone prices do not split the fleet.

`source` on the grid component is `external` for an order, `rules` for the ladder, and `action` while a `set_signal` row is in force on that home. The values the controller sees are one `dispatch_ticks` row per tick: demand, storage, frequency, the call that was applied, and what the fleet then did. `GET /api/dispatch` returns that row, the order waiting for the next tick, and whether the Supabase write succeeded. The browser does not receive the service-role key.

The ladder, used whenever no order is set, is evaluated in this order:

1. If the home's load-zone LMP is present and outside the middle band, it decides: `push` when LMP is at least the greater of 40 $/MWh and 1.1× the mean LMP of that interval; `pull` when LMP is at most the lesser of 25 $/MWh and 0.9× that mean. The mean is load zones and hubs only (`LZ_*`, `HB_*`).
2. Otherwise `push` when `demand_percentile` ≥ 0.75.
3. Else `pull` when `demand_percentile` ≤ 0.35.
4. Else `push` when storage generation ≥ 200 MW (the ERCOT storage fleet is discharging).
5. Else `pull` when storage generation ≤ −200 MW (the ERCOT storage fleet is charging).
6. Else `hold`.

Steps 1 to 6 run per home, so two load zones can be given different calls when their prices disagree. Intensity is 0 on hold, and otherwise at least 0.35, rising as the percentile moves further into the push or pull region.

The fleet call keeps the clause that fired as `because`: `{line, threshold}`. `line` is the comparison, and `threshold` is the limit in that line (0.75, 0.35, 200 MW, −200 MW, or the load-zone price bar). `GET /api/scene` puts the current clause on `dispatch.because`. `calls` gains a row when the signal or that clause changes, so the sidebar can show why the fleet is pushing or pulling. An external order's clause is that the ladder is not running.

### Who actually answers

The signal is a call, not a command, and two per-unit values decide whether it lands:

- **`duty`**, a draw in [0, 1], is the unit's place in the dispatch queue. The call reaches it only when intensity is at least its duty, so a mild call moves a third of the fleet and a peak call moves nearly all of it.
- **`reserve_frac`**, between `SOC_RESERVE` and `SOC_RESERVE + 0.25`, is the customer's own backup floor. Discharge stops there, so a unit sitting near its reserve holds through a push no matter how deep the call.

Commanded kilowatts are then `power_limit_kw` × intensity, clipped by the energy actually available above that reserve or below the 95% ceiling. Achieved kilowatts equal the command unless the unit carries a response fault.

This is why `signal` and `state` are different fields. `signal` is what the fleet was told; `state` is what this battery did. The map colours by `state`, so the share of the fleet that could not respond is visible rather than hidden.

Every home keeps a `state_log` of the last 180 ticks. Each row is the log state in [contracts.md](contracts.md): the call, what the battery did, the integrators, meter import and export, and the chart ids that were alarming or out of control. `GET /api/site/{id}` returns that log newest first, and `snapshot` is the same physics plus the live flags (`offline`, `signal_override`, `armed`, `addons`, `chart_history`). The log stays in the process. It is not a table, and a restart clears it. Startup writes a simulated 180 rows before the first tick, using the hour-of-day load and push in the evening, pull overnight, hold otherwise. Live ticks replace that from the newest end. The full component rows for the instrumented cohort remain `metric_logs`.

### Grid off

`POST /api/agent` with `{"site_id", "grid": false}` opens the contactor. The same route with `"grid": true` closes it. While it is open, grid, meter, and disco import and export are 0, the disco is `islanded`, and the cabinet discharges to cover house load until the customer's reserve. It does not charge from the utility, and it does not export. The log row's `grid` field is `off`. The flag lives in the process. A restart clears it.

This is a prototype policy. It is not an ERCOT market award.

### Market rate

`market_ticks.rate_usd_mwh` is what a controller reads. When the tick has settlement-point prices for `LZ_*` or `HB_*` locations, the rate is their mean and `rate_basis` is `ercot`. Otherwise the rate is `18 + 90 × demand_percentile` dollars per megawatt-hour and `rate_basis` is `simulated`.

### Actions on one base

A controller does not edit a battery's kilowatts directly. It inserts a `unit_actions` row, or posts the same object to `POST /api/actions`. The next tick applies it. Kinds:

| Kind | Effect |
| --- | --- |
| `scheduled_service` | The base is `offline` from `starts_at` until `ends_at`. Charge and discharge stay 0. The house stays grid-tied. A missing `ends_at` is filled with a duration between one and two hours. When the window ends, the tick writes a `return_online` row and the base is `online` again. |
| `set_signal` | This home's call becomes the payload `signal` (`push`, `pull`, or `hold`) and optional `intensity` until `ends_at`. A missing end is one hour. `source` on that home is `action`. |
| `install_addon` | Payload `addon_id` is `solar` or `ev_charger`. The disco starts metering it. |
| `remove_addon` | That add-on leaves the disco's list. |

`return_online` is written by the simulator, not by the controller. Its `actor` is the actor of the service it closes.

`POST /api/agent` arms a chart (`chart_id`, or `all`) so the next tick forces its residual to +4 sigma. The same route sets `dispatch` on one home, and `grid` to open or close the contactor. `GET /api/agent` lists homes that are armed, set to dispatch, or grid-off. `GET /api/site/{id}` includes `armed`, `dispatch`, `snapshot`, and `agent_call` (`signal`, `rate`, `expected_kw`, `source` of `usage` or `profile`, `day`, and `because`). The unit view triggers one code from the box it belongs to. It does not offer trigger-all, and it does not trigger `dispatch_response`. Push, pull, and hold are forced from the grid box with `set_signal`. A maintenance ticket is `scheduled_service` from the base box. Those flags live in the process. A restart clears them.

### Maintenance manager

After the charts for a tick are written, the maintenance manager appends `unit_actions` with `actor` `maintenance`. The following tick applies those rows. This is separate from `LLM_URL`, which stays outside the tick.

An alarming chart posts the `steps` in [control-charts.md](control-charts.md). A warning does not. `frequency` posts nothing. A step that is already pending or active for that home and that `chart_id` is not posted again. `payload.chart_id` records which code the row answers. The note starts with the alarm past ±3σ, then the procedure for that code. `payload.because` is `{line, threshold}` with threshold `±3σ`. A code response outranks the fleet manager: while one is open, that home is not given a price signal.

### Fleet manager

The fleet manager runs after the maintenance manager, on a home with `dispatch` set and no open code response. It appends `set_signal` with `actor` `fleet`. It reads the [day trace](ercot-sources.md) and posts:

- `push` when the rate is at least 70 $/MWh, or this hour's expected load is at least 1.25× this owner's average hour, or demand is at the peak of the trace (the newest actual is at or above the 75th percentile of the 24h actuals)
- `pull` when this hour's expected load is at or below this owner's average hour and any of these hold: the rate is at most 40 $/MWh, demand is in the trough (at or below the 35th percentile), or the forecast is a ramp (its mean is at least 8% above the newest actual, and the hour is not already a peak or a trough)
- `hold` only to replace an open price call that no longer matches. The choice is still stored on the home as `agent_call` and shown in the unit view. `agent_call.day` is `peak`, `trough`, `ramp`, `mid`, or null when the trace is empty.

Expected load is the mean of that home's closed `usage_hours` for this hour of the day. With no closed hour yet, it is that home's `hour_kw` for the clock hour. The owner's average is the mean of `hour_kw`. The rate is [the market rate](#market-rate). Intensity is 1 on push and pull, so the call reaches the home, and 0 on hold. `payload.reason` is `price`. `payload.because` lists each clause that fired, `{line, threshold}`, so a push names 70 $/MWh, 1.25× the owner average, or peak rank 0.75, and a pull names 40 $/MWh, a quiet hour at or below the owner average, trough rank 0.35, or a ramp of 1.08×. The note repeats those lines, then the expected kilowatts, `usage` or `profile`, and the day shape when it is a peak, a trough, or a ramp. A closed usage hour replaces `hour_kw` for that clock hour, so the call follows what the panel metered.

### Add-ons

Both are assumptions, tracked by the disco:

- **Solar**, `source`, 5 kW nameplate. Output is that rating times a daylight fraction, zero at night and about 0.9 near noon. It serves the house and the car charger first. Surplus charges the battery up to the power limit and the 95% ceiling, and the rest exports.
- **Car charger**, `load`, 7.2 kW. It draws about 85% of that from 17:00 through 21:00, and nothing otherwise.

## Maintenance

Limits are per battery and per chart. The rules, the six chart families, and the scripted faults are in [control-charts.md](control-charts.md).
