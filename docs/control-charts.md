# Control charts

Each battery keeps six X-bar charts. The charted number is the mean residual in the bucket, the average of `measured − expected` over the ticks in that point. The center line is 0. σ in the table is the given standard for one tick. The limits on a point are `±3 * σ / √n`, where n is how many ticks are in that point. A chart is `in_control` when `beyond_3sigma` and `two_of_three_2sigma` have not fired. `seven_same_side` is recorded and left alone.

The standard is given. It is not estimated from the trace, so a fault cannot widen its own limits. Healthy sensor noise sits inside the standard. The chart reacts when the subgroup mean leaves `±3 σ/√n`.

`expected` is the operating point, not a fleet-wide constant. Cabinet temperature is the lagged temperature the thermal model predicts for this unit at the power it is actually moving. A hot reading during discharge is in control when it matches that lag. A reading that jumps to the steady-state value in one tick is ahead of the model.

## Families

Every chart also names the `component` it belongs to. In the unit view the meter is drawn as part of the grid box, so `disco_meter_delta` opens from Grid. The chart itself draws the center line and the ±1σ, ±2σ, and ±3σ lines of the point on screen. Those lines use `σ / √n` for the samples already in that point.

| `chart_id` | `component` | `family` | What it catches | `sigma` |
| --- | --- | --- | --- | --- |
| `disco_meter_delta` | `meter` | `measurement` | The Pi and the billing meter disagree. CT scale, polarity, or clock skew. | 0.20 kW |
| `base_temp` | `base` | `thermal` | Cabinet temperature leaves the line expected for this unit at this power. Cooling, a hot pack, a stuck sensor. | the unit's `temp_sigma_c` |
| `disco_voltage` | `disco` | `electrical` | Voltage at the disconnect leaves this service's own center. A sag, a loose connection, a stuck reading. | the unit's `voltage_sigma_v` |
| `frequency` | `disco` | `electrical` | Frequency leaves 60 Hz. This is a grid event, not a cabinet fault. It is charted so the two are not mixed. | 0.025 Hz |
| `soc_tracking` | `base` | `energy` | Reported state of charge leaves the coulomb count. Capacity fade or a BMS offset. | 0.45 kWh |
| `dispatch_response` | `base` | `response` | Achieved kilowatts leave the command. Inverter derate or a battery that ignores dispatch. The residual is 0 while the command is 0. | 0.40 kW |

`sigma` in the table is the one-tick standard. A minute chart has 6 ticks. The temperature chart has 360. The limit drawn for a full bucket is `±3 * sigma / √n`.

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

Each alarming code opens one `scheduled_service` ticket. A warning posts nothing. `frequency` posts nothing. The ticket is the assignment: `payload.stage`, `payload.estimate_min`, and `payload.escalation` are stored on the `unit_actions` row. The minutes are assumptions. `escalation` is the history of that ticket. Each step is `{stage, estimate_min, result, actor, ts}`. A new step is appended. Earlier steps stay, including after the row moves from `maintenance` to `llm`.

| Code | First response | If the reset does not clear it |
| --- | --- | --- |
| `disco_meter_delta` | System reset, 15 seconds (0.25 minutes). Assumed to clear a glitch. | — |
| `disco_voltage` | System reset, 15 seconds (0.25 minutes). Assumed to clear a glitch. | — |
| `soc_tracking` | System reset, 15 seconds (0.25 minutes). | Agent ticket, 20 minutes. |
| `dispatch_response` | System reset, 15 seconds (0.25 minutes). | Agent ticket, 20 minutes. |
| `base_temp` | Reset skipped. Heat does not clear by reboot. | Agent ticket, 30 minutes. |
| `frequency` | none | none |

The reset is a short outage: the base is `offline` until the estimate ends. A reset that clears disarms the chart, appends a `cleared` step, and writes `return_online`. A reset that does not clear keeps the same row, appends the failed reset and the agent visit, sets `stage` to `ticket`, sets `actor` to `llm`, and extends `ends_at` by the service estimate. The agent note is gathered from that home: z, measured, state of charge, temperature, and load. The model pulls `GET /api/site/{id}` on the following tick and closes that visit as `done`. Until then the ticket stays active and the base stays offline. With `OPENAI_API_KEY` set, `OPENAI_MODEL` writes the decision from the pull. Otherwise the decision is the chart's `action` sentence. The estimate stays on the payload. The base comes back online on that close.

`POST /api/agent` with `{"site_id", "chart_id", "armed": true}` arms that chart on one home. `chart_id` of `all` arms every code. The next tick places that residual at +4 times `σ / √n` for a full bucket, so the point is past the completed-subgroup limits. Arming a code that has a response opens that code's ticket immediately and appends `{stage, estimate_min, result: "triggered", actor: "api", ts}` ahead of the first response. If that ticket is already open, the same step is appended and a second ticket is not opened. `armed: false` appends `{result: "cleared", actor: "api"}`, sets the ticket `done`, writes `return_online`, and leaves every earlier step on the row. The chart is no longer armed, so the home is healthy again. Frequency still posts nothing. An armed chart does not average the trigger into the healthy samples already in the bucket. The unit view arms one code from the box it belongs to. It does not show trigger-all, and it does not arm `dispatch_response`. Meter agreement is armed from Grid, voltage and frequency from Disco, state of charge and temperature from Base. The unit shows that code's tickets, open and closed, with every escalation step.

## Rules

Evaluated in this order. More than one may fire on the same point.

| `rules` value | Meaning |
| --- | --- |
| `beyond_3sigma` | This point is outside the 3-sigma limits. |
| `seven_same_side` | This point and the six before it are all on the same side of 0. A sustained shift. Recorded on the point. It does not warn and does not take the chart out of control. |
| `two_of_three_2sigma` | Two of the last three points are beyond 2 sigma on the same side. |

## Severity, and why it is not the same as the rules

`in_control` and `rules` are the statistics. `alarm` and `warning` are what a person should do about them. They are separate fields because at fleet scale they have to be.

Seven points on the same side of centre is what symmetric noise does on roughly 1.6% of healthy charts. Across 3000 batteries with six charts each, that is about 280 shifts that are not a fault. `seven_same_side` stays in `rules` for the training row and does not warn.

So:

- **`alarm`** is true only for `beyond_3sigma`. This is the send-someone signal. It is what turns a unit red on the map and puts it in the attention queue.
- **`warning`** is true when `beyond_3sigma` or `two_of_three_2sigma` fired, or when the absolute z-score is at least 2 and neither of those fired. `seven_same_side` does not warn. This is the watch-it signal, shown in the unit view and counted in the rollup.
- **`in_control`** is false when `beyond_3sigma` or `two_of_three_2sigma` fired. `seven_same_side` does not, by itself, take the chart out of control. The `control_points` table still keeps every rule that fired on every point, including `seven_same_side`.

`alarm` on the maintenance component is true when any chart on that battery alarms. `alarming` lists those chart ids; `out_of_control` lists every chart where a rule fired.

## Point contract

One row per battery per chart per tick. `value` is the subgroup-mean residual. `sigma`, `ucl`, and `lcl` on that row are for the mean: `sigma` is the one-tick standard divided by `√n`, and the limits are `±3` times that. `n` is the number of ticks already in the open bucket, or the full bucket when the chart is armed. `series` is only on the live API, not in the table. It is the last 30 hours, oldest first. Five charts keep one mean per minute: every tick in that minute, including the simulated samples written at startup, a missed minute is null, and `series_seconds` is 60. `base_temp` keeps one mean per clock hour: every tick in that hour, a missed hour is null, and `series_seconds` is 3600. The unit view draws that whole window, with the newest point at the right. Run rules see completed buckets and judge them with that point's `σ / √n`. The open bucket is the point being judged, so seven on one side is seven minutes, or seven hours for temperature. Which metric uses which bucket is [metrics.md](metrics.md).

Startup fills that window before the first tick. The values are simulated tick samples, then averaged the same way as live samples. Every chart starts as noise around zero, inside the given limits. Later ticks replace the open minute, or the open temperature hour, with the live mean. An armed chart replaces that newest point with a residual at +4 times the full-bucket `σ / √n`.

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

Every home starts healthy. The only fault is a chart you arm. Arming the chart opens one ticket for that code, and the maintenance manager continues it. Maintenance manager lists each ticket, open ones first, with every escalation step. The fleet manager does not post a price call on that home while the ticket is open. A reset that clears, a cleared trigger, or a finished service visit ends the fault and keeps the steps. See [simulation.md](simulation.md).
