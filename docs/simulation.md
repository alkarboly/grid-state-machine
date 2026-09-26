# Simulation

Homes are synthetic. ERCOT demand, storage, and prices are not.

## Fleet

`data/anchors.json` places 36 homes around Austin, Houston, Dallas, and San Antonio. Positions are a stable jitter around the city coordinate, not street addresses and not substations.

Each cabinet uses the published Base Core energy, **39.2 kWh**. Continuous power defaults to **11.5 kW**. That power rating is an assumption, not a published Core figure. Override it with `BASE_POWER_KW`. State of charge starts spread between about 55% and 90% so the map is not a flat field. Discharge stops at `SOC_RESERVE` (default 20% of capacity) so backup energy stays in the cabinet. Charge stops at 95%.

Two homes are scripted faults, so maintenance has something to see:

| Site | Fault |
| --- | --- |
| `aus-03` | Battery temperature held at 49°C |
| `hou-02` | Disco voltage held at 226 V and a +1.4 kW disco measurement bias |

## Home load

Hour-of-day mean kilowatts are a late-summer central-air profile. The daily total is about 54 kWh. That is a modeling assumption until real meter samples replace it.

The mean is scaled by `0.85 + 0.30 * demand_percentile`, so homes sit a bit higher when ERCOT demand is in the top of today's range. A small gaussian draws the tick-to-tick sensor noise.

## Interchange

True net kilowatts = panel load + battery charge − battery discharge.

Positive net is grid/meter in. Negative net is grid/meter out. The grid component records that true split. The meter adds a tight error (standard deviation 0.02 kW on the net). The disco adds a wider error (standard deviation 0.06 kW) because it is the Pi measurement, not the billing meter.

Charge and discharge efficiency are each 0.96. State of charge moves with wall-clock time unless `SIM_TIME_SCALE` is set above 1. Scale multiplies elapsed time inside the battery integral only. Log timestamps stay on the wall clock.

## Dispatch

Evaluated in this order:

1. If the home's load-zone LMP is present and outside the middle band, it decides: `push` when LMP is at least the greater of 40 $/MWh and 1.1× the mean LMP of that interval; `pull` when LMP is at most the lesser of 25 $/MWh and 0.9× that mean. The mean is load zones and hubs only (`LZ_*`, `HB_*`).
2. Otherwise `push` when `demand_percentile` ≥ 0.75.
3. Else `pull` when `demand_percentile` ≤ 0.35.
4. Else `push` when storage generation ≥ 200 MW (the ERCOT storage fleet is discharging).
5. Else `pull` when storage generation ≤ −200 MW (the ERCOT storage fleet is charging).
6. Else `hold`.

Commanded kilowatts = `power_limit_kw` × intensity. Intensity is 0 on hold, and otherwise at least 0.35, rising as the percentile moves further into the push or pull region. The command is then clipped by reserve headroom and by the nameplate.

This is a prototype policy. It is not an ERCOT market award.

## Normal bands

A z-score is `(value - mean) / std`. `alarm` is true when any absolute z-score is ≥ 2.5.

| Metric | Mean | Std | Why it is worth watching |
| --- | --- | --- | --- |
| `disco_meter_delta_kw` | 0 | 0.08 | Pi and billing meter should agree. A growing gap is sensor drift or a bad CT. |
| `base_temp_c` | 32 | 3 | Cabinet temperature. A hot pack is a maintenance call before it is a thermal fault. |
| `disco_voltage_v` | 240 | 2 | Voltage at the disconnect. A sag is a service or inverter problem. |

Frequency is logged on the disco (nominal 60 Hz) and is not part of the alarm rule yet.
