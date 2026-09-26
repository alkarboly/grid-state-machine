# Database

Local development uses SQLite at `data/gridsim.db`. Types below are the SQLite types. On Postgres, integer primary keys become `bigint generated always as identity`, `in_control` and `islanded` become `boolean`, `rules_json` becomes `jsonb`, and timestamp text becomes `timestamptz`.

`sites`, `grid_snapshots`, `raw_records`, `metric_logs`, `observations`, `control_points`, and `fleet_rollups` stay in this file. `dispatch_ticks` is written here and, when Supabase is configured, copied there. `dispatch_orders`, `market_ticks`, `unit_latest`, `usage_hours`, `unit_actions`, `addon_catalog`, and `site_addons` are the Supabase tables a controller uses. Which slice is next is [status.md](status.md).

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

Every home also keeps a `state_log` in that same memory: one log-state row per tick, last 180. The row shape, and the current `snapshot` that adds the live flags, are in [contracts.md](contracts.md). The unit view shows the log. It is not written to SQLite. The control-chart trace is the same kind of memory: the last 30 hours at one residual per minute, described in [control-charts.md](control-charts.md). Startup fills both with simulated rows. Neither is a table. `chart_history` on the snapshot is the short run-rule memory, not the 30-hour trace.

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

`ts`, `units`, `pushing`, `pulling`, `holding`, `offline`, `alarms`, `warnings`, `discharge_kw`, `charge_kw`, `solar_charge_kw`, `load_kw`, `solar_kw`, `ev_kw`, `grid_in_kw`, `grid_out_kw`, `stored_kwh`, `capacity_kwh`, `mean_soc_pct`.

`pushing`, `pulling`, and `holding` count what the batteries did, not what they were told. They sum to `units`. `offline` is how many of those units are out for service; they sit in `holding`.

Every power column is the sum of that metric across the fleet. They close:

`grid_in_kw − grid_out_kw = load_kw + ev_kw − solar_kw + solar_charge_kw + charge_kw − discharge_kw`.

## `dispatch_ticks`

One row per tick. This is the object a controller reads in order to decide the next call. It is written on every tick, not only for the instrumented cohort.

`ts`, `demand_mw`, `demand_percentile`, `storage_gen_mw`, `frequency_hz`, `signal`, `intensity`, `source`, `zones_json`, `pushing`, `pulling`, `holding`, `discharge_kw`, `charge_kw`, `load_kw`, `mean_soc_pct`, `stored_kwh`, `alarms`.

`signal` and `intensity` are the fleet call applied on this tick. `source` is `rules` or `external`. A home's own grid `source` can be `action` while a `set_signal` row is in force; that override stays on the unit and does not change this row. `zones_json` is a JSON object of load zone to the signal that zone actually ran. Under an external order every zone has the same signal. Under the ladder, a zone with a price can differ.

The Postgres tables the bot and a controller share are created by the SQL files in `supabase/migrations`, in filename order. Local SQLite mirrors the column names. Row level security is enabled and there is no anon policy, so the browser cannot read them. Only the bot's service role can.

`dispatch_orders` is not a local table. It lives in Supabase, and the tick reads the newest row:

```sql
create table dispatch_orders (
  ts timestamptz primary key default now(),
  signal text not null check (signal in ('push', 'pull', 'hold', 'auto')),
  intensity double precision
);

create table dispatch_ticks (
  ts timestamptz primary key,
  demand_mw double precision,
  demand_percentile double precision,
  storage_gen_mw double precision,
  frequency_hz double precision not null,
  signal text not null,
  intensity double precision not null,
  source text not null,
  zones_json text not null,
  pushing integer not null,
  pulling integer not null,
  holding integer not null,
  discharge_kw double precision not null,
  charge_kw double precision not null,
  load_kw double precision not null,
  mean_soc_pct double precision not null,
  stored_kwh double precision not null,
  alarms integer not null
);

alter publication supabase_realtime add table dispatch_ticks;
```

Add `dispatch_ticks` to the realtime publication so a subscriber sees each tick as it is inserted. The service-role key used by this process must not be placed in the browser.

## What the controller reads

These three tables are the read model in [llm.md](llm.md). The bot upserts them. It does not publish all 3000 homes: `unit_latest` and `usage_hours` cover the instrumented cohort plus any home with an action or an add-on, capped at 80 homes a tick.

### `market_ticks`

One row per tick. `rate_usd_mwh` and `rate_basis` (`ercot` or `simulated`) are the market rate. The row also carries demand, storage, frequency, the fleet call, `mean_soc_pct`, how many bases are `offline`, and `units`.

### `unit_latest`

One row per published home, replaced in place. `site_id`, `ts`, `soc_kwh`, `soc_pct`, `availability` (`online` or `offline`), `signal`, `charge_kw`, `discharge_kw`, `load_kw`, `temp_c`, `addons_json`.

### `usage_hours`

One row per home per clock hour, written when that hour closes. `ts` is the first tick of the hour. `hour`, `load_kwh`, `import_kwh`, `export_kwh`, `solar_kwh`, `ev_kwh`.

## What the controller writes

### `unit_actions`

One row per action. `id` is a hex string the writer chooses, or one the bot generates. `kind` is `scheduled_service`, `set_signal`, `install_addon`, `remove_addon`, or `return_online`. `status` is `pending`, `active`, `done`, or `cancelled`. `actor` is `fleet`, `maintenance`, `llm`, `api`, or `sim`. `fleet` is the fleet manager's price call. `maintenance` is a code response. `llm` is a remote model. `api` is a user post. `sim` is a row written before those two managers. `payload` holds `signal` and `intensity` for a set-signal, or `addon_id` for an add-on change. A code response also holds `chart_id`. A price call holds `reason` `price`. Either may hold `because`, a list of `{line, threshold}` for the clause that fired. `starts_at` and `ends_at` bound a service or a signal override. A `return_online` row keeps the `actor` of the service it closes.

### `addon_catalog` and `site_addons`

The catalog has two rows, `solar` and `ev_charger`. `site_addons` is the set currently installed: `site_id`, `addon_id`, `installed_at`. Removing an add-on deletes that row. The action log is the history.

## Caps

`metric_logs` and `observations` keep the latest 20,000 rows. `control_points` keeps the latest 60,000. Older rows are deleted.
