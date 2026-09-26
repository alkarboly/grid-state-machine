# Control charts

Each battery keeps six individuals charts. The charted number is the residual `measured - expected`. The center line is 0. The limits are `±3 * sigma` for that battery and that chart. A chart is `in_control` when no rule has fired.

`expected` is the operating point, not a fleet-wide constant. Cabinet temperature is expected to rise while the battery is working. A hot reading during discharge is in control when it matches that rise.

## Families

Every chart also names the `component` it belongs to, so a chart is always attached to a box in the one-line diagram rather than floating next to the unit.

| `chart_id` | `component` | `family` | What it catches | `sigma` |
| --- | --- | --- | --- | --- |
| `disco_meter_delta` | `meter` | `measurement` | The Pi and the billing meter disagree. CT scale, polarity, or clock skew. | 0.20 kW |
| `base_temp` | `base` | `thermal` | Cabinet temperature leaves the line expected for this unit at this power. Cooling, a hot pack, a stuck sensor. | the unit's `temp_sigma_c` |
| `disco_voltage` | `disco` | `electrical` | Voltage at the disconnect leaves this service's own center. A sag, a loose connection, a stuck reading. | the unit's `voltage_sigma_v` |
| `frequency` | `disco` | `electrical` | Frequency leaves 60 Hz. This is a grid event, not a cabinet fault. It is charted so the two are not mixed. | 0.025 Hz |
| `soc_tracking` | `base` | `energy` | Reported state of charge leaves the coulomb count. Capacity fade or a BMS offset. | 0.45 kWh |
| `dispatch_response` | `base` | `response` | Achieved kilowatts leave the command. Inverter derate or a battery that ignores dispatch. The residual is 0 while the command is 0. | 0.40 kW |

`grid` and `panel` carry no charts. The grid metrics are ERCOT context rather than a measurement of this home, and the panel reports a single load number that the meter and disco already chart between them.

## Rules

Evaluated in this order. More than one may fire on the same point.

| `rules` value | Meaning |
| --- | --- |
| `beyond_3sigma` | This point is outside the 3-sigma limits. |
| `seven_same_side` | This point and the six before it are all on the same side of 0. A sustained shift. |
| `two_of_three_2sigma` | Two of the last three points are beyond 2 sigma on the same side. |

`warning` is true when the absolute z-score is at least 2 and no rule has fired. Warning does not set `alarm`.

`alarm` on the maintenance component is true when any chart has `in_control` false.

## Point contract

One row per battery per chart per tick. `value` is the residual. `series` is the recent residuals and is only on the live API, not in the table.

```json
{
  "ts": "2026-09-25T20:10:00-05:00",
  "site_id": "aus-03",
  "chart_id": "base_temp",
  "component": "base",
  "family": "thermal",
  "measured": 49.0,
  "expected": 33.2,
  "value": 15.8,
  "sigma": 1.4,
  "ucl": 4.2,
  "lcl": -4.2,
  "z": 11.286,
  "rules": ["beyond_3sigma"],
  "in_control": false
}
```

## Scripted faults

These four batteries are the demo of four different maintenance kinds. Their `sites` row stays the healthy baseline.

| Site | Chart | Fault |
| --- | --- | --- |
| `aus-03` | `base_temp` | Measured temperature held at 49°C |
| `hou-02` | `disco_voltage`, `disco_meter_delta` | Voltage held at 226 V and a +1.4 kW disco bias |
| `sat-01` | `soc_tracking` | Reported state of charge is 2.5 kWh above the coulomb count |
| `dal-02` | `dispatch_response` | The battery delivers 55% of the commanded kilowatts |
