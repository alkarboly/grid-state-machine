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
| `disco_meter_delta` | Try a system reset. A meter glitch is assumed to clear. The ticket closes when the reset ends. |
| `base_temp` | Heat does not clear by reboot. The agent opens a service ticket from the cabinet readings. |
| `disco_voltage` | Try a system reset. A voltage glitch is assumed to clear. The ticket closes when the reset ends. |
| `frequency` | Leave the cabinet. Frequency is the grid, not this battery. |
| `soc_tracking` | Try a system reset. A charge offset does not clear, so the agent opens a service ticket. |
| `dispatch_response` | Try an inverter reset. If the battery still ignores dispatch, the agent opens a service ticket. |

`action` is catalog text. It is the same on every point of that chart, it rides on `GET /api/scene` as `codes`, and it is not a column in `control_points`. The ticket note is the gathered readings and the escalation, not this sentence.

Each alarming code opens one `scheduled_service` ticket. A warning posts nothing. `frequency` posts nothing. The ticket is the assignment: `payload.stage`, `payload.estimate_min`, and `payload.escalation` are stored on the `unit_actions` row. The minutes are assumptions.

| Code | First response | If the reset does not clear it |
| --- | --- | --- |
| `disco_meter_delta` | System reset, 2 minutes. Assumed to clear a glitch. | — |
| `disco_voltage` | System reset, 2 minutes. Assumed to clear a glitch. | — |
| `soc_tracking` | System reset, 2 minutes. | Agent ticket, 20 minutes. |
| `dispatch_response` | System reset, 2 minutes. | Agent ticket, 20 minutes. |
| `base_temp` | Reset skipped. Heat does not clear by reboot. | Agent ticket, 30 minutes. |
| `frequency` | none | none |

The reset is a short outage: the base is `offline` until the estimate ends. A reset that clears disarms the chart and writes `return_online`. A reset that does not clear keeps the same row, sets `stage` to `ticket`, sets `actor` to `llm`, and extends `ends_at` by the service estimate. The agent note is gathered from that home: z, measured, state of charge, temperature, and load. `payload.escalation` lists each stage with its estimate and result.

`POST /api/agent` with `{"site_id", "chart_id", "armed": true}` arms that chart on one home. `chart_id` of `all` arms every code. The next tick reports that residual at +4 sigma, so the point is past the limits and the maintenance manager opens the ticket for that code. `armed: false` clears it, and the home is healthy again. An armed chart replaces the measured value for that tick. For temperature, that triggered residual is the open hour's point, so the healthy samples already in the hour do not hide it. The unit view arms one code from the box it belongs to. It does not show trigger-all, and it does not arm `dispatch_response`. Meter agreement is armed from Grid, voltage and frequency from Disco, state of charge and temperature from Base.

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

One row per battery per chart per tick. `value` is the residual. `series` is only on the live API, not in the table. It is the last 30 hours, oldest first. Five charts keep one residual per minute: the newest sample in that minute wins, a missed minute is null, and `series_seconds` is 60. `base_temp` keeps one residual per clock hour: the mean of every sample in that hour, including the simulated samples written at startup, a missed hour is null, and `series_seconds` is 3600. The unit view draws that whole window, with the newest point at the right. The run rules for the minute charts still see every tick. `base_temp` run rules see completed hour means, and the open hour is the point being judged. Which metric uses which bucket is [metrics.md](metrics.md).

Startup fills that window before the first tick. The values are simulated, then bucketed the same way as live samples. Every chart starts as noise around zero. Later ticks replace the newest minute, or the open temperature hour, with the live residual. An armed chart replaces that newest point with a residual at +4 sigma.

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
  "action": "Heat does not clear by reboot. The agent opens a service ticket from the cabinet readings."
}
```

## Triggered faults

Every home starts healthy. The only fault is a chart you arm. The maintenance manager opens one ticket for that code. Maintenance manager shows the stage, the estimate, and the escalation on that row. The fleet manager does not post a price call on that home while the ticket is open. A reset that clears, or a finished service visit, ends the fault. See [simulation.md](simulation.md).
