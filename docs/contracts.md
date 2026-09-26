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
| `grid` | Utility interchange at the site, plus the ERCOT context that drove dispatch | `in_kw`, `out_kw`, `demand_mw`, `demand_percentile`, `storage_gen_mw`, `lmp_usd_mwh`, `signal`, `grid_as_of` |
| `meter` | Service meter | `in_kw`, `out_kw`, `voltage_v`, `energy_in_kwh`, `energy_out_kwh` |
| `disco` | Raspberry Pi at the disconnect. Measures the same flow as the meter, with more noise | `in_kw`, `out_kw`, `voltage_v`, `frequency_hz`, `contactor`, `islanded` |
| `panel` | House load downstream of the battery interconnect | `load_kw`, `voltage_v` |
| `base` | Battery cabinet. `charge_kw` and `discharge_kw` are what the battery did. The commanded pair is what dispatch asked for. `soc_kwh` is the reported state of charge. | `capacity_kwh`, `power_limit_kw`, `soc_kwh`, `soc_pct`, `commanded_charge_kw`, `commanded_discharge_kw`, `charge_kw`, `discharge_kw`, `temp_c` |
| `maintenance` | Which control charts are out of limits. The point shape is in [control-charts.md](control-charts.md). | `alarm`, `out_of_control`, `warning` |

`signal` is `pull`, `push`, or `hold`. Pull charges the battery from the grid. Push discharges toward the grid. Hold does neither.

`contactor` is `closed` or `open`. `islanded` is a boolean. This slice keeps the contactor closed and the home grid-tied.

`lmp_usd_mwh` is JSON `null` until a settlement-point price exists for that home's load zone.

`out_of_control` and `warning` are arrays of `chart_id`. `alarm` is true when `out_of_control` is not empty.

The flat machine-learning row for the same tick is the `observations` table in [database.md](database.md). It carries the same measurements in columns, plus `physical_soc_kwh`, which is the coulomb count rather than the reported state of charge.
