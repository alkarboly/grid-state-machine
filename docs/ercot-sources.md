# ERCOT sources

Timestamps from ERCOT are US Central. Dashboard stamps look like `2026-09-25 19:45:00-0500`.

## Live without a key

These feeds power the ERCOT website dashboards. They are not the versioned EMIL API, and ERCOT can change them.

| Feed | URL | Used fields |
| --- | --- | --- |
| Supply and demand | `https://www.ercot.com/api/1/services/read/dashboards/supply-demand.json` | `lastUpdated`; `data[]` rows with `demand`, `capacity`, `available`, `forecast` (`0` actual, `1` forecast), `timestamp`; `forecast[]` rows with `forecastedDemand` |
| Fuel mix | `https://www.ercot.com/api/1/services/read/dashboards/fuel-mix.json` | `data[day][timestamp][fuel].gen` for Natural Gas, Coal and Lignite, Nuclear, Wind, Solar, Hydro, Other, Power Storage |

Power Storage `gen` is negative when storage is charging and positive when it is discharging. That sign is an input to the fleet signal in [simulation.md](simulation.md).

Normalized grid snapshot fields:

| Field | Meaning |
| --- | --- |
| `as_of` | Timestamp of the demand row used |
| `demand_mw` | Latest actual `demand` |
| `capacity_mw` | `capacity` on that row |
| `available_mw` | `available` on that row |
| `forecast_demand_mw` | Next `forecastedDemand`, if present |
| `demand_percentile` | Share of today's actual demand rows at or below `demand_mw` |
| `storage_gen_mw` | Latest Power Storage `gen` |
| `wind_mw`, `solar_mw`, `gas_mw` | Latest fuel `gen` |
| `source` | `ercot-dashboard`, `cached`, or `unavailable` |

## Day trace

`day` on `GET /api/scene`, and on the model request in [llm.md](llm.md), is the series behind the top-left overlay. The fleet manager reads the same points. `shape` on the scene is that reading: `peak`, `trough`, `ramp`, or `mid`, with `demand_mw` and `rank`. It is null when the trace has no actuals.

Each point is `{ts, demand_mw, rate_usd_mwh, rate_basis, kind}`. `kind` is `actual` or `forecast`.

`GET /api/scene` also has `demand_reverse`. When that flag is on, the `day` series and `grid.demand_mw` are inverted around today's actual min and max, so a peak reads as a trough. `demand_percentile` is the complement of today's rank so the ladder can switch the fleet. The simulated rate follows that percentile. Storage megawatts are left alone; the tick skips them while the flag is on. The live dashboard payloads are unchanged.

Actuals are the dashboard `data[]` rows with `forecast` 0, kept for the 24 hours before the newest actual and bucketed to 15 minutes. The newest sample in a bucket wins. A restart also reads two stored payloads: the latest one at least 30 minutes old, and the latest one from before midnight, so the trace still covers the day those responses published. The forecast is `forecast[]` (`forecastedDemand`), which replaces a `data[]` row with `forecast` 1 at the same time, and only the next 6 hours are kept. The rest of that multi-day forecast is dropped.

`rate_usd_mwh` on every point except the newest actual is `18 + 90 × percentile`, where the percentile is that point's demand against the actuals in the window. `rate_basis` there is `simulated`. The newest actual uses [the market rate](simulation.md): a live mean of `LZ_*` and `HB_*` LMPs when those prices exist (`ercot`), otherwise the same curve (`simulated`). Settlement prices are not a 24-hour history in this feed.

## Official Public API

Base URL: `https://api.ercot.com/api/public-reports`

Every call needs both headers:

- `Ocp-Apim-Subscription-Key`: primary subscription key
- `Authorization: Bearer` ID token

The ID token is minted with a password grant against `https://ercotb2c.b2clogin.com/ercotb2c.onmicrosoft.com/B2C_1_PUBAPI-ROPC-FLOW/oauth2/v2.0/token`, `client_id` `fec253ea-0d06-4272-a5e6-b478baeecd70`, and scope `openid fec253ea-0d06-4272-a5e6-b478baeecd70 offline_access`. It lasts one hour. The app requests a new one when it expires. Registration steps: [ERCOT registration guide](https://developer.ercot.com/applications/pubapi/user-guide/registration-and-authentication/).

| EMIL | Path | What we keep |
| --- | --- | --- |
| NP6-86-CD | `/np6-86-cd/shdw_prices_bnd_trns_const` | Latest SCED interval: constraint name, contingency, shadow price, max shadow price, limit, value (flow), violated MW, from station, to station, from kV, to kV |
| NP6-788-CD | `/np6-788-cd/lmp_node_zone_hub` | Latest interval: settlement point and LMP |
| NP6-787-CD | `/np6-787-cd/lmp_electrical_bus` | One page (1000 rows), stored raw. `bus_lmp_rows` counts how many of those rows sit in the latest SCED interval. This is a sample of the bus set, not every bus. |

Query window parameters are `SCEDTimestampFrom` and `SCEDTimestampTo`, Central time as `yyyy-MM-ddThh:mm:ss` with no offset. An offset is a 400. Pagination uses `size` and `page`. Rows come back as `fields` plus `data` (a list of lists).

Constraint field names are matched after lowercasing and stripping punctuation, so `FromStation`, `fromStation`, and `from_station` all map to `from_station`.

Settlement-point prices are joined to a home by `load_zone` (`LZ_AEN`, `LZ_HOUSTON`, `LZ_NORTH`, `LZ_CPS`). Electrical-bus LMPs stay in the raw table. They are not joined to homes. NP4-160-SG, the weekly settlement-point to electrical-bus workbook, is not downloaded in this slice.

A constraint becomes a map edge only when both station codes are present and both have an entry in `data/station_geo.json`:

```json
{ "station": "WIRTZ", "lat": 30.75, "lon": -98.1, "confidence": "high", "source": "where this coordinate came from" }
```

Blank from/to pairs still appear in the constraint list. They are interface or contingency constraints, not a line we can draw.
