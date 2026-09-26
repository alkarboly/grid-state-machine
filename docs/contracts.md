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

`contactor` is `closed` or `open`. `islanded` is a boolean. This slice keeps the contactor closed and the home grid-tied. Scheduled service takes the base offline without opening the contactor: the house stays grid-tied and the cabinet does not charge or discharge.

`addons` on the disco is a list of `{addon_id, role, kw}`. `role` is `source` or `load`. An empty list means the home has no add-on. `solar_charge_kw` on the base is surplus solar that went into the cabinet. It is not part of `charge_kw`, so the dispatch-response chart does not treat it as a missed command.

`availability` is `online` or `offline`.

`lmp_usd_mwh` is JSON `null` until a settlement-point price exists for that home's load zone.

`alarming`, `out_of_control`, and `warning` are arrays of `chart_id`. `chart_id` is the error code. `alarm` is true when `alarming` is not empty, which means at least one chart is outside its limits. `out_of_control` is wider: it also holds charts where only a run rule fired. The action for each code is in [control-charts.md](control-charts.md). Take it when the code alarms. The sim agent posts that action on the following tick.

Every control chart names the component it belongs to. The mapping is in [control-charts.md](control-charts.md) and it is what lets the unit view hang each chart off its box in the chain.

The flat machine-learning row for the same tick is the `observations` table in [database.md](database.md). It carries the same measurements in columns, plus `physical_soc_kwh`, which is the coulomb count rather than the reported state of charge.
