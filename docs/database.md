# Database

Local development uses SQLite at `data/gridsim.db`. The column names are the contract for a later Supabase Postgres database. Types below are the SQLite types. On Postgres, integer primary keys become `bigint generated always as identity`, `in_control` and `islanded` become `boolean`, `rules_json` becomes `jsonb`, and timestamp text becomes `timestamptz`.

The browser does not connect to the database. The FastAPI process writes it and serves `/api/scene`.

## `sites`

One row per battery. This is the healthy identity used as the control-chart baseline. Scripted faults are not stored here.

`site_id`, `city`, `load_zone`, `lat`, `lon`, `capacity_kwh`, `power_limit_kw`, `load_scale`, `temp_center_c`, `temp_sigma_c`, `voltage_center_v`, `voltage_sigma_v`, `eta`.

## `grid_snapshots`

One row per ERCOT interval, keyed by the demand timestamp `ts`. Utility context, shared by the fleet.

`demand_mw`, `capacity_mw`, `available_mw`, `forecast_demand_mw`, `demand_percentile`, `storage_gen_mw`, `wind_mw`, `solar_mw`, `gas_mw`, `source`.

## `raw_records`

Unmodified ERCOT payload. `source`, `fetched_at`, `body`.

## `metric_logs`

The component contract from [contracts.md](contracts.md). One row per battery per component per tick.

`ts`, `site_id`, `component`, `metrics_json`.

## Write rate at fleet scale

3000 batteries × 6 components × a tick every 10 seconds is about 39,000 rows a tick. Nothing useful comes from storing that, so the pipeline behaves like a real telemetry pipeline instead:

- `PERSIST_SAMPLE` batteries, **60** by default, are the instrumented cohort. They write the full component contract, the flat observation, and every control point on every tick. The cohort always includes the four scripted-fault units and is otherwise an even spread across the fleet, chosen once at startup.
- Every other battery writes a control point **only when that chart is out of limits**. Exceptions are never sampled away.
- The whole fleet is summarised once per tick in `fleet_rollups`.

That is about 830 rows a tick instead of 39,000, and the unit view still reads live values for any battery because the simulation state lives in memory. `instrumented` on `/api/site/{id}` says whether a unit is in the cohort.

## `observations`

The machine-learning row. One row per instrumented battery per tick, already flat. Join to `control_points` on `ts` and `site_id` for the labels.

`physical_soc_kwh` is simulation truth (the coulomb count). `soc_kwh` is the reported state of charge. The difference is the `soc_tracking` residual.

Columns, in order: `ts`, `site_id`, `hour`, `demand_mw`, `demand_percentile`, `storage_gen_mw`, `lmp_usd_mwh`, `signal`, `grid_in_kw`, `grid_out_kw`, `meter_in_kw`, `meter_out_kw`, `meter_voltage_v`, `energy_in_kwh`, `energy_out_kwh`, `disco_in_kw`, `disco_out_kw`, `disco_voltage_v`, `frequency_hz`, `contactor`, `islanded`, `load_kw`, `panel_voltage_v`, `physical_soc_kwh`, `soc_kwh`, `soc_pct`, `commanded_charge_kw`, `commanded_discharge_kw`, `charge_kw`, `discharge_kw`, `temp_c`.

## `control_points`

The chart contract from [control-charts.md](control-charts.md). One row per battery per chart per tick.

`ts`, `site_id`, `chart_id`, `component`, `family`, `measured`, `expected`, `value`, `sigma`, `ucl`, `lcl`, `z`, `rules_json`, `in_control`.

`rules_json` is a JSON array of rule names. An empty array means the point is in control.

`component` is the box in the chain that owns the chart, so labels can be grouped by hardware as well as by family.

## `fleet_rollups`

One row per tick for the whole fleet, so aggregate history survives even though per-unit history is sampled.

`ts`, `units`, `pushing`, `pulling`, `holding`, `alarms`, `warnings`, `discharge_kw`, `charge_kw`, `load_kw`, `stored_kwh`, `capacity_kwh`, `mean_soc_pct`.

`pushing`, `pulling`, and `holding` count what the batteries did, not what they were told. They sum to `units`.

## Caps

`metric_logs` and `observations` keep the latest 20,000 rows. `control_points` keeps the latest 60,000. Older rows are deleted.
