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

Radius from the metro centre is a Rayleigh draw with the anchor's `radius_km` as its scale, capped at 2.8 scales. Density therefore peaks a suburb out rather than downtown, which is where single-family roofs are. The draw is then stretched by `stretch` along an axis `axis_deg` east of north, so the Rio Grande Valley runs east-west and Austin runs up and down I-35.

These are modelled addresses. They are not customer locations and they are not tied to a real feeder.

### Faults

Four named batteries carry scripted faults, one per maintenance kind, listed in [control-charts.md](control-charts.md). Every other unit draws a fault at `FAULT_RATE`, 1.5%, from the same five kinds with a randomised magnitude. At 3000 units that is roughly 50 units in some kind of trouble at any moment.

## Home load

Hour-of-day mean kilowatts are a late-summer central-air profile. The daily total is about 54 kWh. That is a modeling assumption until real meter samples replace it.

The mean is multiplied by that battery's `load_scale`, then by `0.85 + 0.30 * demand_percentile`, so a larger home sits higher and every home sits a bit higher when ERCOT demand is in the top of today's range. A small gaussian draws the tick-to-tick sensor noise.

## Interchange

True net kilowatts = panel load + battery charge − battery discharge.

Positive net is grid/meter in. Negative net is grid/meter out. The grid component records that true split. The meter adds a tight error (standard deviation 0.02 kW on the net). The disco adds a wider error (standard deviation 0.06 kW) because it is the Pi measurement, not the billing meter.

Each battery has its own one-way efficiency `eta`, drawn between 0.94 and 0.975. State of charge moves with wall-clock time unless `SIM_TIME_SCALE` is set above 1. Scale multiplies elapsed time inside the battery integral only. Log timestamps stay on the wall clock.

The coulomb count is `physical_soc_kwh`. The reported `soc_kwh` is that count plus a bias. A healthy battery has bias 0. `sat-0001` reports 2.5 kWh high, which is the energy-chart fault.

## Dispatch

Evaluated in this order:

1. If the home's load-zone LMP is present and outside the middle band, it decides: `push` when LMP is at least the greater of 40 $/MWh and 1.1× the mean LMP of that interval; `pull` when LMP is at most the lesser of 25 $/MWh and 0.9× that mean. The mean is load zones and hubs only (`LZ_*`, `HB_*`).
2. Otherwise `push` when `demand_percentile` ≥ 0.75.
3. Else `pull` when `demand_percentile` ≤ 0.35.
4. Else `push` when storage generation ≥ 200 MW (the ERCOT storage fleet is discharging).
5. Else `pull` when storage generation ≤ −200 MW (the ERCOT storage fleet is charging).
6. Else `hold`.

Steps 1 to 6 pick one signal for the whole fleet. Intensity is 0 on hold, and otherwise at least 0.35, rising as the percentile moves further into the push or pull region.

### Who actually answers

The signal is a call, not a command, and two per-unit values decide whether it lands:

- **`duty`**, a draw in [0, 1], is the unit's place in the dispatch queue. The call reaches it only when intensity is at least its duty, so a mild call moves a third of the fleet and a peak call moves nearly all of it.
- **`reserve_frac`**, between `SOC_RESERVE` and `SOC_RESERVE + 0.25`, is the customer's own backup floor. Discharge stops there, so a unit sitting near its reserve holds through a push no matter how deep the call.

Commanded kilowatts are then `power_limit_kw` × intensity, clipped by the energy actually available above that reserve or below the 95% ceiling. Achieved kilowatts equal the command unless the unit carries a response fault.

This is why `signal` and `state` are different fields. `signal` is what the fleet was told; `state` is what this battery did. The map colours by `state`, so the share of the fleet that could not respond is visible rather than hidden.

This is a prototype policy. It is not an ERCOT market award.

## Maintenance

Limits are per battery and per chart. The rules, the six chart families, and the scripted faults are in [control-charts.md](control-charts.md).
