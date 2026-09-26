# Controller contract

A remote model does not sit inside the tick. The bot publishes a read model, the model writes action rows, and the next tick applies them. One fleet call is still `dispatch_orders`. Per-unit changes are `unit_actions`.

Two managers do sit in the tick. After the charts are written, the maintenance manager appends alarm steps with `actor` `maintenance`, then the fleet manager appends a price call with `actor` `fleet` on a home set to dispatch. An open code response blocks that price call. The following tick applies those rows. Arming a chart and the price-and-usage call are in [simulation.md](simulation.md). `LLM_URL` is still optional. A remote model is a third writer, `actor` `llm`, and it is not either manager.

The service-role key stays on the bot. Give the model a key that can read the three read tables and insert `unit_actions`, or let the bot call `LLM_URL`. Do not put that key in the browser.

## Read

Newest row of `market_ticks`:

- `rate_usd_mwh`, `rate_basis` (`ercot` or `simulated`)
- `demand_mw`, `demand_percentile`, `storage_gen_mw`, `frequency_hz`
- `signal`, `intensity`, `source` — the call the fleet just ran
- `mean_soc_pct`, `offline`, `units`

`unit_latest` for the homes the bot is publishing (the instrumented cohort, plus any home with an action or an add-on):

- `site_id`, `soc_kwh`, `soc_pct`, `availability`, `signal`
- `charge_kw`, `discharge_kw`, `load_kw`, `temp_c`, `addons_json`

`usage_hours` for those homes, newest hours first:

- `load_kwh`, `import_kwh`, `export_kwh`, `solar_kwh`, `ev_kwh`

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
| `scheduled_service` | `{}` | Base goes `offline` and returns in 1–2 hours. The bot writes `return_online`. |
| `set_signal` | `{"signal": "hold", "intensity": 0}` | That home's call changes until `ends_at`. Default window is one hour. `signal` is `push`, `pull`, or `hold`. |
| `install_addon` | `{"addon_id": "solar"}` | Disco starts metering `solar` or `ev_charger`. |
| `remove_addon` | `{"addon_id": "solar"}` | Disco stops metering it. |

Do not insert `return_online`. The simulator does that when a service window ends.

`POST /api/actions` takes the same fields without `id`, `status`, or `actor`. The bot assigns those.

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
