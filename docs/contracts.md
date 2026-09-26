# Component contracts

Each tick writes one log row per component. The row shape is fixed:

```json
{
  "ts": "2026-09-25T19:46:00-05:00",
  "site_id": "aus-01",
  "component": "meter",
  "metrics": {}
}
```

`component` is one of `grid`, `meter`, `disco`, `panel`, `base`, `maintenance`.

`ts` is the wall-clock time of the tick, US Central, with an offset. The ERCOT snapshot time stays on the grid metrics as `grid_as_of`.

Power is split into in and out. In is kilowatts flowing from the utility toward the home. Out is kilowatts flowing from the home toward the utility. A healthy site has only one of the two above zero at a time.

The chain is grid → meter → disco → panel → base.

| Component | Role | Metrics |
| --- | --- | --- |
| `grid` | Utility interchange at the site, plus the ERCOT context that drove dispatch | `in_kw`, `out_kw`, `demand_mw`, `demand_percentile`, `storage_gen_mw`, `lmp_usd_mwh`, `signal`, `source`, `grid_as_of` |
| `meter` | Service meter | `in_kw`, `out_kw`, `voltage_v`, `energy_in_kwh`, `energy_out_kwh` |
| `disco` | Raspberry Pi at the disconnect. Measures the same flow as the meter, with more noise, and meters modular add-ons | `in_kw`, `out_kw`, `voltage_v`, `frequency_hz`, `contactor`, `islanded`, `addons` |
| `panel` | House load downstream of the battery interconnect | `load_kw`, `voltage_v` |
| `base` | Battery cabinet. `charge_kw` and `discharge_kw` are what the battery did. The commanded pair is what dispatch asked for. `soc_kwh` is the reported state of charge. `availability` is `offline` while a scheduled service has the cabinet out. | `capacity_kwh`, `power_limit_kw`, `soc_kwh`, `soc_pct`, `commanded_charge_kw`, `commanded_discharge_kw`, `charge_kw`, `discharge_kw`, `solar_charge_kw`, `availability`, `temp_c` |
| `maintenance` | Which control charts need attention. The point shape and the severity rules are in [control-charts.md](control-charts.md). | `alarm`, `alarming`, `out_of_control`, `warning` |

`signal` is `pull`, `push`, or `hold`. Pull charges the battery from the grid. Push discharges toward the grid. Hold does neither.

`source` on the grid component is `rules`, `external`, or `action`. `rules` means the ladder in [simulation.md](simulation.md) chose the call. `external` means a fleet-wide order, posted to `/api/dispatch` or written to Supabase `dispatch_orders`, chose it. The order replaces the ladder for every home until it is cleared with `auto`. `action` means a `set_signal` row in `unit_actions` is in force for this home and outranks the fleet call.

`contactor` is `closed` or `open`. `islanded` is a boolean. The contactor stays closed and the home stays grid-tied unless the grid is turned off. Scheduled service takes the base offline without opening the contactor: the house stays grid-tied and the cabinet does not charge or discharge. Grid off is separate: the contactor opens, interchange is zero, and the cabinet covers the house. That path is in [simulation.md](simulation.md).

`addons` on the disco is a list of `{addon_id, role, kw}`. `role` is `source` or `load`. An empty list means the home has no add-on. `solar_charge_kw` on the base is surplus solar that went into the cabinet. It is not part of `charge_kw`, so the dispatch-response chart does not treat it as a missed command.

`availability` is `online` or `offline`.

`lmp_usd_mwh` is JSON `null` until a settlement-point price exists for that home's load zone.

`alarming`, `out_of_control`, and `warning` are arrays of `chart_id`. `chart_id` is the error code. `alarm` is true when `alarming` is not empty, which means at least one chart is outside its limits. `out_of_control` is wider: it also holds charts where only a run rule fired. The action for each code is in [control-charts.md](control-charts.md). Take it when the code alarms. The maintenance manager posts that action on the following tick.

Every control chart names the component it belongs to. The mapping is in [control-charts.md](control-charts.md) and it is what lets the unit view hang each chart off its box in the chain.

The flat machine-learning row for the same tick is the `observations` table in [database.md](database.md). It carries the same measurements in columns, plus `physical_soc_kwh`, which is the coulomb count rather than the reported state of charge.

## State snapshot

`GET /api/site/{id}` returns `snapshot`. This is the carried state of one home: the physics the next tick continues from, the call it is on, and the run-rule memory. The site field `state` stays the verb `push`, `pull`, or `hold`. That verb is also a field inside the snapshot.

These fields are the log state as well. A log row and the snapshot use the same names.

| Field | Meaning |
| --- | --- |
| `ts` | Tick time, US Central, with an offset. Null before any row exists. |
| `state` | What the battery did: `push`, `pull`, or `hold`. |
| `signal` | The call: `push`, `pull`, or `hold`. |
| `source` | `rules`, `external`, or `action`. |
| `availability` | `online` or `offline`. |
| `grid` | `on` or `off`. `off` means the contactor is open. |
| `soc_pct` | Reported state of charge, percent. |
| `physical_soc_kwh` | Coulomb count. |
| `load_kw` | House load this tick. |
| `load_kw_state` | Lagged load the next tick starts from. |
| `charge_kw` | Kilowatts into the battery. |
| `discharge_kw` | Kilowatts out of the battery. |
| `in_kw` | Meter import. |
| `out_kw` | Meter export. |
| `voltage_v` | Disco voltage. |
| `voltage_state` | Lagged service voltage the next tick starts from. |
| `frequency_hz` | Disco frequency. |
| `temp_c` | Cabinet temperature. |
| `temp_c_state` | Lagged temperature the next tick starts from. |
| `energy_in_kwh` | Cumulative meter import. |
| `energy_out_kwh` | Cumulative meter export. |
| `alarming` | Chart ids past ±3σ. |
| `out_of_control` | Chart ids where a rule fired. This is what the unit view paints red. |

The snapshot also carries the live control flags. They are not copied onto every log row.

| Field | Meaning |
| --- | --- |
| `offline` | True while a scheduled service has the cabinet out. |
| `signal_override` | `null`, or `{"signal", "intensity"}` while a `set_signal` is in force. |
| `armed` | Chart ids the next tick will drive to +4σ. |
| `addons` | Add-on ids on the disco. |
| `chart_history` | Residuals the run rules just used, one list per `chart_id`, oldest first, at most 24. |

Identity does not move with the tick. Capacity, power limit, centers, fault, and place stay on the site row. Restoring a home is that identity, plus this snapshot, plus open `unit_actions`. The actions put `offline` and `signal_override` back on the next tick. `chart_history` puts the run rules back. The 30-hour chart trace is the drawing, not this snapshot.

## Log state

Each `state_log` entry is one tick of the shared fields above, and only those fields. `GET /api/site/{id}` returns the log newest first. The process keeps the last 180 ticks. It is not a table. A restart clears it, and startup writes a simulated 180 rows before the first live tick.

`grid` on a log row is `off` for every tick the contactor was open. `out_of_control` lists the charts that were out of control on that tick, which includes `alarming`.
