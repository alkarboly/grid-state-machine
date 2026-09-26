# Gaps

These are open on purpose. The code does not invent stand-ins for them beyond the assumptions named in [simulation.md](simulation.md).

1. **ERCOT subscription key.** Constraints, settlement-point LMPs, and electrical-bus LMPs stay empty until `.env` has `ERCOT_USERNAME`, `ERCOT_PASSWORD`, and `ERCOT_SUBSCRIPTION_KEY`. How to get the key is the registration guide linked from [ercot-sources.md](ercot-sources.md).
2. **Base Core continuous kilowatts.** Energy is the published 39.2 kWh. The 11.5 kW nameplate is an assumption (`BASE_POWER_KW`).
3. **Where the real fleet sits.** `data/anchors.json` holds 21 ERCOT metros. Counts come from metro household estimates times an `adoption` multiplier, and that multiplier is the assumption: it weights Central Texas heavily because that is where Base Power started. Real service-territory counts would replace both numbers. Positions inside a metro are a Rayleigh draw around the centre, not customer addresses.
4. **Station coordinates.** `data/station_geo.json` is empty. An edge is drawn only for a code pair you place there, with a source note. ERCOT does not publish station latitude and longitude.
5. **Bus-to-home join.** NP4-160-SG (settlement point ↔ electrical bus, substation, kV) is not ingested yet. Bus LMPs are stored, not mapped onto homes.
6. **Disco hardware.** The Pi is modeled as a noisier in/out power measurement plus voltage and frequency. Sample rate, CT rating, and whether the contactor is controllable are unknown.
7. **Load shape.** The hour-of-day curve is a late-summer assumption of about 54 kWh/day before `load_scale`, not Base meter history. Each battery scales that curve, which spreads the fleet. It does not replace metered homes.
8. **Shift factors.** A binding constraint is not electrically attributed to a home. The map does not pretend that it is.
