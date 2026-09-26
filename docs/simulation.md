# Simulation

Homes are synthetic. ERCOT demand, storage, and prices are not.

## Fleet

`data/anchors.json` places 36 homes around Austin, Houston, Dallas, and San Antonio. Each city is a ring of distinct batteries, not a stacked blob and not a substation. Every battery draws its own `load_scale`, temperature center and sigma, voltage center and sigma, and one-way efficiency. Those values are the `sites` row. They do not change when a fault is applied.

Each cabinet uses the published Base Core energy, **39.2 kWh**. Continuous power defaults to **11.5 kW**. That power rating is an assumption, not a published Core figure. Override it with `BASE_POWER_KW`. State of charge starts spread between about 55% and 90% so the map is not a flat field. Discharge stops at `SOC_RESERVE` (default 20% of capacity) so backup energy stays in the cabinet. Charge stops at 95%.

Four batteries carry scripted faults so four different charts leave their limits. The table is in [control-charts.md](control-charts.md).

## Home load

Hour-of-day mean kilowatts are a late-summer central-air profile. The daily total is about 54 kWh. That is a modeling assumption until real meter samples replace it.

The mean is multiplied by that battery's `load_scale`, then by `0.85 + 0.30 * demand_percentile`, so a larger home sits higher and every home sits a bit higher when ERCOT demand is in the top of today's range. A small gaussian draws the tick-to-tick sensor noise.

## Interchange

True net kilowatts = panel load + battery charge − battery discharge.

Positive net is grid/meter in. Negative net is grid/meter out. The grid component records that true split. The meter adds a tight error (standard deviation 0.02 kW on the net). The disco adds a wider error (standard deviation 0.06 kW) because it is the Pi measurement, not the billing meter.

Each battery has its own one-way efficiency `eta`, drawn between 0.94 and 0.975. State of charge moves with wall-clock time unless `SIM_TIME_SCALE` is set above 1. Scale multiplies elapsed time inside the battery integral only. Log timestamps stay on the wall clock.

The coulomb count is `physical_soc_kwh`. The reported `soc_kwh` is that count plus a bias. A healthy battery has bias 0. `sat-01` reports 2.5 kWh high, which is the energy-chart fault.

## Dispatch

Evaluated in this order:

1. If the home's load-zone LMP is present and outside the middle band, it decides: `push` when LMP is at least the greater of 40 $/MWh and 1.1× the mean LMP of that interval; `pull` when LMP is at most the lesser of 25 $/MWh and 0.9× that mean. The mean is load zones and hubs only (`LZ_*`, `HB_*`).
2. Otherwise `push` when `demand_percentile` ≥ 0.75.
3. Else `pull` when `demand_percentile` ≤ 0.35.
4. Else `push` when storage generation ≥ 200 MW (the ERCOT storage fleet is discharging).
5. Else `pull` when storage generation ≤ −200 MW (the ERCOT storage fleet is charging).
6. Else `hold`.

Commanded kilowatts = `power_limit_kw` × intensity. Intensity is 0 on hold, and otherwise at least 0.35, rising as the percentile moves further into the push or pull region. The command is then clipped by reserve headroom and by the nameplate. Achieved kilowatts equal the command, except `dal-02`, which delivers 55% of it.

This is a prototype policy. It is not an ERCOT market award.

## Maintenance

Limits are per battery and per chart. The rules, the six chart families, and the scripted faults are in [control-charts.md](control-charts.md).
