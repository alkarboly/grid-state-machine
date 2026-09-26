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
| `base` | Battery cabinet | `capacity_kwh`, `power_limit_kw`, `soc_kwh`, `soc_pct`, `charge_kw`, `discharge_kw`, `temp_c` |
| `maintenance` | Comparison of a live value to the normal band in [simulation.md](simulation.md) | `disco_meter_delta_kw`, `disco_meter_delta_z`, `base_temp_c`, `base_temp_z`, `disco_voltage_v`, `disco_voltage_z`, `alarm` |

`signal` is `pull`, `push`, or `hold`. Pull charges the battery from the grid. Push discharges toward the grid. Hold does neither.

`contactor` is `closed` or `open`. `islanded` is a boolean. This slice keeps the contactor closed and the home grid-tied.

`lmp_usd_mwh` is JSON `null` until a settlement-point price exists for that home's load zone.

`alarm` is true when any absolute z-score is at least `2.5`.
