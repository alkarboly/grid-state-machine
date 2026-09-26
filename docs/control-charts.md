# Control charts

Each battery keeps six individuals charts. The charted number is the residual `measured - expected`. The center line is 0. The limits are `±3 * sigma` for that battery and that chart. A chart is `in_control` when no rule has fired.

`expected` is the operating point, not a fleet-wide constant. Cabinet temperature is the lagged temperature the thermal model predicts for this unit at the power it is actually moving. A hot reading during discharge is in control when it matches that lag. A reading that jumps to the steady-state value in one tick is ahead of the model.

## Families

Every chart also names the `component` it belongs to. In the unit view the meter is drawn as part of the grid box, so `disco_meter_delta` opens from Grid. The chart itself draws the center line and the ±1σ, ±2σ, and ±3σ lines. Limits in the table stay `±3 * sigma`.

| `chart_id` | `component` | `family` | What it catches | `sigma` |
| --- | --- | --- | --- | --- |
| `disco_meter_delta` | `meter` | `measurement` | The Pi and the billing meter disagree. CT scale, polarity, or clock skew. | 0.20 kW |
| `base_temp` | `base` | `thermal` | Cabinet temperature leaves the line expected for this unit at this power. Cooling, a hot pack, a stuck sensor. | the unit's `temp_sigma_c` |
| `disco_voltage` | `disco` | `electrical` | Voltage at the disconnect leaves this service's own center. A sag, a loose connection, a stuck reading. | the unit's `voltage_sigma_v` |
| `frequency` | `disco` | `electrical` | Frequency leaves 60 Hz. This is a grid event, not a cabinet fault. It is charted so the two are not mixed. | 0.025 Hz |
| `soc_tracking` | `base` | `energy` | Reported state of charge leaves the coulomb count. Capacity fade or a BMS offset. | 0.45 kWh |
| `dispatch_response` | `base` | `response` | Achieved kilowatts leave the command. Inverter derate or a battery that ignores dispatch. The residual is 0 while the command is 0. | 0.40 kW |

`grid` and `panel` carry no charts. The grid metrics are ERCOT context rather than a measurement of this home, and the panel reports a single load number that the meter and disco already chart between them.

## Codes

`chart_id` is the error code. The map key and the attention queue use that same string. An alarm on the code means take the action. A warning is watch only. It does not call for the action.

| Code | Action |
| --- | --- |
| `disco_meter_delta` | Compare the disco to the billing meter. If they still disagree, post `scheduled_service`. |
| `base_temp` | Post `set_signal` hold so the pack stops working, then `scheduled_service` for cooling or a stuck sensor. |
| `disco_voltage` | Post `scheduled_service` and check the connection at the disconnect. |
| `frequency` | Leave the cabinet. Frequency is the grid, not this battery. |
| `soc_tracking` | Post `scheduled_service`. The reported charge has left the coulomb count. |
| `dispatch_response` | Post `set_signal` hold, then `scheduled_service`. The battery is not doing what it was told. |

`action` is catalog text. It is the same on every point of that chart, it rides on `GET /api/scene` as `codes`, and it is not a column in `control_points`.

Each code also has `steps`, the rows the sim agent posts when that chart's `alarm` is true. A warning does not post them. `frequency` has no steps.

| Code | `steps` |
| --- | --- |
| `disco_meter_delta` | `scheduled_service` |
| `base_temp` | `set_signal` hold, then `scheduled_service` |
| `disco_voltage` | `scheduled_service` |
| `frequency` | none |
| `soc_tracking` | `scheduled_service` |
| `dispatch_response` | `set_signal` hold, then `scheduled_service` |

`POST /api/agent` with `{"site_id", "chart_id", "armed": true}` arms that chart on one home. `chart_id` of `all` arms every code. The next tick reports that residual at +4 sigma, so the point is past the limits and the agent posts `steps`. `armed: false` clears it. The scripted faults on this page stay in place either way. An armed chart replaces the measured value for that tick.

## Rules

Evaluated in this order. More than one may fire on the same point.

| `rules` value | Meaning |
| --- | --- |
| `beyond_3sigma` | This point is outside the 3-sigma limits. |
| `seven_same_side` | This point and the six before it are all on the same side of 0. A sustained shift. |
| `two_of_three_2sigma` | Two of the last three points are beyond 2 sigma on the same side. |

## Severity, and why it is not the same as the rules

`in_control` and `rules` are the statistics. `alarm` and `warning` are what a person should do about them. They are separate fields because at fleet scale they have to be.

A run rule fires on roughly 1.6% of perfectly healthy charts — that is what "seven points on the same side of centre" means when the residual is symmetric noise. On one battery that is a useful nudge. Across 3000 batteries with six charts each, it is about 280 false alarms, which buries the 50 units that are actually broken. Alarming on every rule turned the map solid red.

So:

- **`alarm`** is true only for `beyond_3sigma`. This is the send-someone signal. It is what turns a unit red on the map and puts it in the attention queue.
- **`warning`** is true when a run rule fired without a limit breach, or when the absolute z-score is at least 2 and no rule fired at all. This is the watch-it signal, shown in the unit view and counted in the rollup.
- **`in_control`** stays false whenever any rule fired, so nothing statistical is hidden or thrown away. The `control_points` table keeps every rule that fired on every point, which is what a training label needs.

`alarm` on the maintenance component is true when any chart on that battery alarms. `alarming` lists those chart ids; `out_of_control` lists every chart where a rule fired.

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
  "in_control": false,
  "alarm": true,
  "warning": true,
  "action": "Post set_signal hold so the pack stops working, then scheduled_service for cooling or a stuck sensor."
}
```

## Scripted faults

These four batteries are the demo of four different maintenance kinds, always present at any fleet size. Their `sites` row stays the healthy baseline.

| Site | Chart | Fault |
| --- | --- | --- |
| `aus-0003` | `base_temp` | Measured temperature held at 49°C |
| `hou-0002` | `disco_voltage`, `disco_meter_delta` | Voltage held at 226 V and a +1.4 kW disco bias |
| `sat-0001` | `soc_tracking` | Reported state of charge is 2.5 kWh above the coulomb count |
| `dal-0002` | `dispatch_response` | The battery delivers 55% of the commanded kilowatts |

Two further cabinets of each kind are spaced through the rest of the fleet, 14 faulted cabinets in all. Everyone else is healthy. See [simulation.md](simulation.md).
