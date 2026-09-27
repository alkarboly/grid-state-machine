# Public API

JSON over HTTPS. No login. The live origin is https://gridstatemachine.com/. The same catalog is the **API** tab (https://gridstatemachine.com/#api). OpenAPI is `/openapi.json`; Swagger is `/docs`. Locally the origin is `http://127.0.0.1:8000`. The code is `gridsim/api.py`.

Official ERCOT credentials, the Supabase service-role key, and the OpenAI key stay in the environment. They are never in a response.

CORS is same-origin unless `WEB_ORIGIN` lists extra browser origins. `Content-Type` on posts is `application/json`.

This origin is the live prototype. A post changes that fleet until the next restart. A restart rebuilds homes in memory.

## Tick

A tick is 10 seconds (`tick_seconds` on the scene). `GET` is the current memory. `POST /api/dispatch` and `POST /api/actions` land as `pending` and apply on the **next** tick. `POST /api/agent` updates flags in memory immediately; an armed chart, grid off, demand pin, and reverse demand show on the next scene poll, and chart residuals move on the next tick.

## Reads

| Method | Path | What you get |
| --- | --- | --- |
| `GET` | `/api/scene` | The map. One small row per home, plus metros, substations, the fleet rollup, the live call, `calls`, `actions`, ERCOT context, the 24h `day` trace, `shape`, `gateway`, `supabase`, `openai`, `demand_reverse`, `demand_pin`, `demand_now_ts`, `tick_seconds`. About 330 KB for 3000 homes. The map polls it every 5 seconds. |
| `GET` | `/api/site/{id}` | One home in full: component `metrics`, charts with the 30-hour residual, `usage`, `state_log`, `snapshot`, `actions`, `armed`, `dispatch`, `agent_call`, `duty`, `reserve_frac`, `intensity`. A few kilobytes. `404` if the id is unknown. |
| `GET` | `/api/dispatch` | `applied` (the call this tick), `pending` (the order waiting, or `null`), `snapshot` (demand, storage, frequency, fleet totals), `supabase`. |
| `GET` | `/api/agent` | `{sites, demand_reverse, demand_pin}`. `sites` is only homes that are armed, set to dispatch, or grid-off. |

Each `GET /api/scene` home row is `{id, metro, station, lat, lon, state, signal, source, soc_pct, alarm, offline, grid}`. `state` is what the cabinet did. `signal` is the call. `source` is `rules`, `external`, or `action`. `grid` is `on` or `off`. When a chart is past limits, the row also has `flagged` (chart ids) and `families`.

`snapshot` and each `state_log` row are the log state in [contracts.md](contracts.md). Site fields `duty`, `reserve_frac`, and `intensity` are [simulation.md](simulation.md). Chart ids are [control-charts.md](control-charts.md).

```
curl https://gridstatemachine.com/api/scene
curl https://gridstatemachine.com/api/dispatch
curl https://gridstatemachine.com/api/site/aus-0004
```

## Writes

### `POST /api/dispatch`

One call for every home, applied on the next tick. While it stands, the ladder is off.

```json
{"signal": "push", "intensity": 0.8}
```

`signal` is `push`, `pull`, `hold`, or `auto`. `auto` clears the order and the ladder takes over. `intensity` is optional, 0 to 1. Omit it to use the ladder's own depth for that signal. Hold is always 0. When Supabase keys are set, the post also inserts `dispatch_orders`.

Returns the same object as `GET /api/dispatch`. `400` if `signal` or `intensity` is bad.

```
curl -X POST https://gridstatemachine.com/api/dispatch -H "Content-Type: application/json" -d "{\"signal\":\"auto\"}"
```

### `POST /api/actions`

One `unit_actions` row. The bot assigns `id`, `status` `pending`, and `actor` `api`. The next tick applies it. Do not post `return_online`.

```json
{"site_id": "aus-0004", "kind": "set_signal", "note": "", "payload": {"signal": "hold"}}
```

| `kind` | `payload` |
| --- | --- |
| `scheduled_service` | `{}`, or the ticket fields in [llm.md](llm.md) |
| `set_signal` | `{"signal": "push"}` or `pull` or `hold`. Optional `intensity` 0 to 1. Default window one hour. |
| `install_addon` | `{"addon_id": "solar"}` or `ev_charger` |
| `remove_addon` | `{"addon_id": "solar"}` or `ev_charger` |

`404` unknown site. `400` if `kind` or `payload` is bad. Returns the new row.

### `POST /api/agent`

Flags in this process. A restart clears them.

`demand_reverse` and `demand_pin` are their own body. When either key is present, the rest of the body is ignored except the other of those two keys.

```json
{"demand_pin": "peak"}
```

Uses today's highest actual as the live operating point. The 24h series is unchanged. `live` restores the newest actual. Default is `peak`. A restart returns to peak. Returns `{demand_pin, demand_reverse}`.

```json
{"demand_reverse": true}
```

Inverts today's demand on the 24h card and on the next tick's ladder, and clears a posted order so that ladder can run. `false` restores the live series. Returns `{demand_reverse, demand_pin}`. Pin is applied first, so peak then reverse is a charging window.

Otherwise `site_id` is required. You can set more than one flag in the same post.

```json
{"site_id": "aus-0004", "chart_id": "base_temp", "armed": true, "dispatch": true, "grid": true}
```

| Field | Meaning |
| --- | --- |
| `chart_id` | One code, or `all`. Requires `armed`. Codes: `disco_meter_delta`, `base_temp`, `disco_voltage`, `frequency`, `soc_tracking`, `dispatch_response`. Arming forces the next residual to +4 full-bucket chart sigmas. |
| `armed` | `true` or `false`. Required with `chart_id`. |
| `dispatch` | `true` lets the fleet manager choose push or pull for that home from the rate and expected load. |
| `grid` | `false` opens the contactor. `true` closes it. |

Returns `{site_id, armed, dispatch, grid}` with `grid` as `on` or `off`. `404` unknown site. `400` if a field is the wrong type, `chart_id` is unknown, or `armed` is missing next to `chart_id`.

## Errors

Failed posts return `{detail: "..."}`. `400` is a bad body. `404` is an unknown `site_id`.

## Who outranks whom

The ladder, a posted order, a per-home `set_signal`, reverse demand, demand pin, and an open ticket are [protocols.md](protocols.md).
