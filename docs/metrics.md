# Metrics and control charts

What is measured, how the samples are combined, and which control chart judges the result. Component fields are [contracts.md](contracts.md). Limits and rules are [control-charts.md](control-charts.md).

A tick is 10 seconds. Every home is sampled on every tick. Two later grains are used:

| Grain | Rule |
| --- | --- |
| Minute | The arithmetic mean of every sample in that clock minute. A missed minute is null. |
| Hour | Every sample whose timestamp falls in that clock hour. Energy fields are integrals. Cabinet temperature is the arithmetic mean. |

The unit diagram and the state log show the latest tick. They are not averages. `unit_latest.temp_c` is that same latest tick, replaced in place.

## Tracked metrics

| Component | Field | What one sample is | Bucket |
| --- | --- | --- | --- |
| `grid` | `in_kw`, `out_kw` | Kilowatts at the service this tick. In is toward the home. | Tick. The hour integrals are `usage_hours.import_kwh` and `export_kwh`. |
| `grid` | `demand_mw`, `storage_gen_mw`, `lmp_usd_mwh`, `signal`, `source` | The ERCOT context and the call for this tick. | Tick. `market_ticks` keeps the fleet row. |
| `meter` | `in_kw`, `out_kw`, `voltage_v` | Billing-meter power and voltage. | Tick on the diagram. The minute charts that use them average every tick in that clock minute. |
| `meter` | `energy_in_kwh`, `energy_out_kwh` | Cumulative energy since the home started. | Running total, not an hour mean. |
| `disco` | `in_kw`, `out_kw`, `voltage_v`, `frequency_hz` | The Pi at the disconnect. | Tick. |
| `disco` | `addons[].kw` | Kilowatts the disco metered for `solar` or `ev_charger`. | Tick. The hour integrals are `solar_kwh` and `ev_kwh`. |
| `panel` | `load_kw` | House load. | Tick. The hour integral is `load_kwh`. |
| `base` | `soc_kwh`, `soc_pct`, `charge_kw`, `discharge_kw`, `availability` | Reported charge, what the battery did, and whether it is in service. | Tick. |
| `base` | `temp_c` | Cabinet temperature this tick. | Tick on the diagram, the state log, and `unit_latest`. The hour mean is `usage_hours.temp_c` and the `base_temp` chart. |
| `maintenance` | `alarm`, `alarming`, `warning` | Which charts need a person. | Derived from the chart point for this tick. |

`usage_hours` closes when the clock hour changes. `ts` is the first tick of that hour. `load_kwh`, `import_kwh`, `export_kwh`, `solar_kwh`, and `ev_kwh` are sums of kilowatts times elapsed hours. `temp_c` is the mean of every cabinet-temperature sample in that hour. A published home gets the row. The other homes keep the same hour in memory until it closes.

## Control charts

Each chart plots the mean residual `measured − expected` for its bucket. The center line is 0. The limits are `±3 * σ / √n`. `n` is the number of ticks in the point. `alarm` is only a point outside those limits. Run rules are in [control-charts.md](control-charts.md).

| `chart_id` | Residual | Samples in one point | `series_seconds` | What the run rules remember |
| --- | --- | --- | --- | --- |
| `disco_meter_delta` | Disco net minus meter net. Expected is 0. This is the chart behind meter in and meter out. | Every tick in the clock minute, averaged. | 60 | The last 24 completed minute means. |
| `base_temp` | Mean cabinet temperature minus the mean temperature the thermal model expected. | Every tick in the clock hour, averaged. | 3600 | The last 24 completed hour means. The open hour is the point being judged, so seven on one side is seven hours. |
| `disco_voltage` | Disco voltage minus this service's center. | Every tick in the clock minute, averaged. | 60 | The last 24 completed minute means. |
| `frequency` | Disco frequency minus 60 Hz. | Every tick in the clock minute, averaged. | 60 | The last 24 completed minute means. |
| `soc_tracking` | Reported charge minus the coulomb count. | Every tick in the clock minute, averaged. | 60 | The last 24 completed minute means. |
| `dispatch_response` | Achieved kilowatts minus the command. The residual is 0 while the command is 0. | Every tick in the clock minute, averaged. | 60 | The last 24 completed minute means. |

`sigma` in the chart catalog is the given standard for one tick. The point uses `σ / √n`. A minute point divides by `√6`. A temperature hour divides by `√360`. The standard is not refit from the samples. A mean held off-center still crosses the tightened limit. A single spike is diluted by the other samples in the open bucket, and the alarm follows that mean against `σ / √n` for the samples so far. Arming the chart skips the average and places the point at +4 full-bucket sigmas.

The drawn series is the last 30 hours. Five charts are about 1800 minute means. `base_temp` is about 30 hour means, one per clock hour, oldest first. A missed bucket is null. Startup fills that window with simulated tick samples and then applies the same mean: samples that share a clock minute are averaged, and temperature samples that share a clock hour are averaged, including a partial bucket at either end of the window. The first live tick replaces the open bucket. It does not mix with the simulated samples already counted in that bucket.

`control_points` still stores a row on the ticks that are persisted. `measured` and `expected` are the running means. `value` is their difference. `sigma` is the one-tick standard divided by the square root of the samples in that point. The closed bucket is the chart point that remains after the clock minute, or the clock hour for temperature, changes.
