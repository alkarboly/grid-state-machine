# Model

OpenAI uses an incident summary data contract to select which data is shared with the LLM to auto-classify and summarize the incident. It does not sit inside the tick, does not open Supabase, and does not choose discharge or charge. The API server holds the service-role key, reads and writes Supabase, and the next tick applies the rows. One fleet call is still `dispatch_orders`. Per-unit changes are `unit_actions`.

After the maintenance manager sets `stage` to `ticket` and `actor` to `llm`, that visit stays active through `ends_at`. The base is `offline`. The service wait is a normal draw around 2 hours, clipped to 45–240 minutes. Maintenance manager opens on the case. Now does not show a model line. After the window ends, the next tick calls `GET /api/site/{id}` on this process (`GRIDSIM_ORIGIN` if set, otherwise `http://127.0.0.1` and `PORT`, default 8000). On Render, `PORT` is set by the platform. Set `GRIDSIM_ORIGIN` to https://gridstatemachine.com only if that pull must use the public name. OpenAI may use only that home's chart for the ticket and the readings below. When `OPENAI_API_KEY` is set, `OPENAI_MODEL` (default `gpt-4o-mini`) writes `decision.action`: two sentences on what the readings show and how the chart procedure resolves it. A missing key or a failed call keeps the chart's `action` sentence and omits `decision.model`. The state machine then marks the same ticket `done`, disarms the chart, and writes `return_online`. The service estimate stays on the payload. A `ticket` stage is not auto-closed at `ends_at`; the summary runs after that window. A failed pull leaves the ticket open and retries on the next tick.

Two managers do sit in the tick. After the charts are written, the maintenance manager opens or escalates a ticket, then the fleet manager appends a price call with `actor` `fleet` on a home set to dispatch. An open code response blocks that price call. The following tick applies those rows. Arming a chart and the price-and-usage call are in [simulation.md](simulation.md). When a reset does not clear the fault, the in-tick agent writes the visit with `actor` `llm`. The OpenAI text above is the summary of that visit. The close is the state machine. It does not use `LLM_URL`. `LLM_URL` is still optional. A remote writer at that URL remains a third writer and is not either manager.

The service-role key stays on the API server. OpenAI does not receive it. Do not put that key in the browser or on the model. A remote `LLM_URL` writer, when set, reads with `GET /api/site/{id}` and `GET /api/dispatch`, and writes with `POST /api/actions` and `POST /api/dispatch`. Those routes are [api.md](api.md).

## Optional LLM_URL

When `LLM_URL` is set, that writer does not query these tables. The API server does, and the writer sees the result through the API.

Newest row of `market_ticks`:

- `rate_usd_mwh`, `rate_basis` (`ercot` or `simulated`)
- `demand_mw`, `demand_percentile`, `storage_gen_mw`, `frequency_hz`
- `signal`, `intensity`, `source` — the call the fleet just ran
- `mean_soc_pct`, `offline`, `units`

`unit_latest` for the homes the bot is publishing (the instrumented cohort, plus any home with an action or an add-on):

- `site_id`, `soc_kwh`, `soc_pct`, `availability`, `signal`
- `charge_kw`, `discharge_kw`, `load_kw`, `temp_c`, `addons_json`

`usage_hours` for those homes, newest hours first:

- `load_kwh`, `import_kwh`, `export_kwh`, `solar_kwh`, `ev_kwh`, `temp_c`

`site_addons` is the install set the disco is tracking. `addon_catalog` is `solar` (source, 5 kW) and `ev_charger` (load, 7.2 kW).

## Write

Insert into `unit_actions` with a new hex `id`. `POST /api/actions` assigns the id for you.

```json
{
  "id": "generated-hex",
  "site_id": "aus-0004",
  "kind": "scheduled_service",
  "status": "pending",
  "actor": "llm",
  "note": "Cabinet inspection",
  "payload": {}
}
```

| kind | payload | What the next tick does |
| --- | --- | --- |
| `scheduled_service` | `{}`, or `{chart_id, stage, estimate_min, escalation, gathered, pull, decision}` | Base goes `offline` until `ends_at`, or until the state machine sets `decision.result` to `done` after the ticket summary. A missing end is a normal draw around 2 hours (clipped 45–240 minutes). A `reset` stage stays open so the maintenance manager can clear it or escalate the same row. A `ticket` stage stays open past `ends_at` so the model can summarize, then the state machine closes it. `escalation` is `{stage, estimate_min, result, actor, ts}`, oldest first. New steps are appended. A finished `ticket` disarms that chart. The bot writes `return_online`. |
| `set_signal` | `{"signal": "hold", "intensity": 0}` | That home's call changes until `ends_at`. Default window is one hour. `signal` is `push`, `pull`, or `hold`. |
| `install_addon` | `{"addon_id": "solar"}` | Disco starts metering `solar` or `ev_charger`. |
| `remove_addon` | `{"addon_id": "solar"}` | Disco stops metering it. |

Do not insert `return_online`. The simulator does that when a posted service window ends, or when the state machine closes a ticket after the summary.

`POST /api/actions` takes the same fields without `id`, `status`, or `actor`. The bot assigns those.

## Ticket summary

The incident summary data contract is the stored `pull` slice. It selects which data is shared with the LLM to auto-classify and summarize the incident. `GET /api/site/{id}` is the read. The stored payload is the slice the summary is allowed to use:

```json
{
  "pull": {
    "method": "GET",
    "path": "/api/site/aus-0004",
    "evidence": {
      "chart_id": "base_temp",
      "z": 11.286,
      "measured": 49.0,
      "expected": 33.2,
      "soc_pct": 55,
      "temp_c": 32.0,
      "load_kw": 0.8,
      "action": "Heat does not clear by reboot. The agent opens a service ticket from the cabinet readings."
    }
  },
  "decision": {
    "result": "done",
    "action": "The cabinet is at 49 °C against an expected 33.2 °C. Heat does not clear by reboot, so the visit stands.",
    "model": "gpt-4o-mini"
  }
}
```

`evidence.action` is the chart catalog sentence from [control-charts.md](control-charts.md). `decision.result` is `done`. `decision.action` is the two-sentence ticket summary from `OPENAI_MODEL` when `OPENAI_API_KEY` is set. `decision.model` is that model name. A missing key or a failed call sets `decision.action` to `evidence.action` and leaves `model` off. The state machine writes the close. The escalation step is `{stage: "ticket", result: "done", actor: "llm"}`. Maintenance manager shows the row as a done case, with the evidence, the summary, and this payload. The decisions log shows that step, the evidence, the summary, and `model`.

## Optional HTTP call

When `LLM_URL` is set, the bot POSTs this body at most once per `LLM_EVERY_S` seconds (default 600). A failure does not stop the tick.

```json
{
  "market": {},
  "units": [],
  "usage": [],
  "day": []
}
```

`day` is the same 24-hour demand and price trace the map draws. Each point is `{ts, demand_mw, rate_usd_mwh, rate_basis, kind}`. See [ercot-sources.md](ercot-sources.md).

Respond with `{ "actions": [ { "site_id", "kind", "note", "payload" } ] }`. The bot turns each object into a pending `unit_actions` row.
