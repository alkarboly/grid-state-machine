# Gaps

These are open on purpose. The code does not invent stand-ins for them beyond the assumptions named in [simulation.md](simulation.md).

1. **ERCOT subscription key.** Constraints, settlement-point LMPs, and electrical-bus LMPs stay empty until `.env` has `ERCOT_USERNAME`, `ERCOT_PASSWORD`, and `ERCOT_SUBSCRIPTION_KEY`. How to get the key is the registration guide linked from [ercot-sources.md](ercot-sources.md).
2. **Base Core continuous kilowatts.** Energy is the published 39.2 kWh. The 11.5 kW nameplate is an assumption (`BASE_POWER_KW`).
3. **Where the real fleet sits.** Anchors are Austin, Houston, Dallas, and San Antonio. Counts are 12, 10, 8, and 6. Replace `data/anchors.json` if the demo should follow a different footprint.
4. **Station coordinates.** `data/station_geo.json` is empty. An edge is drawn only for a code pair you place there, with a source note. ERCOT does not publish station latitude and longitude.
5. **Bus-to-home join.** NP4-160-SG (settlement point ↔ electrical bus, substation, kV) is not ingested yet. Bus LMPs are stored, not mapped onto homes.
6. **Disco hardware.** The Pi is modeled as a noisier in/out power measurement plus voltage and frequency. Sample rate, CT rating, and whether the contactor is controllable are unknown.
7. **Load shape.** The hour-of-day curve is a late-summer assumption of about 54 kWh/day, not Base meter history.
8. **Shift factors.** A binding constraint is not electrically attributed to a home. The map does not pretend that it is.
