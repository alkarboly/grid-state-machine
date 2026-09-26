import json
import sqlite3
from typing import Any

from gridsim.config import DB_PATH

_SCHEMA = """
CREATE TABLE IF NOT EXISTS raw_records (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS metric_logs (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  site_id TEXT NOT NULL,
  component TEXT NOT NULL,
  metrics_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS metric_logs_site ON metric_logs (site_id, id);
CREATE TABLE IF NOT EXISTS sites (
  site_id TEXT PRIMARY KEY,
  city TEXT NOT NULL,
  load_zone TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  capacity_kwh REAL NOT NULL,
  power_limit_kw REAL NOT NULL,
  load_scale REAL NOT NULL,
  temp_center_c REAL NOT NULL,
  temp_sigma_c REAL NOT NULL,
  voltage_center_v REAL NOT NULL,
  voltage_sigma_v REAL NOT NULL,
  eta REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS grid_snapshots (
  ts TEXT PRIMARY KEY,
  demand_mw REAL,
  capacity_mw REAL,
  available_mw REAL,
  forecast_demand_mw REAL,
  demand_percentile REAL,
  storage_gen_mw REAL,
  wind_mw REAL,
  solar_mw REAL,
  gas_mw REAL,
  source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  site_id TEXT NOT NULL,
  hour INTEGER NOT NULL,
  demand_mw REAL,
  demand_percentile REAL,
  storage_gen_mw REAL,
  lmp_usd_mwh REAL,
  signal TEXT NOT NULL,
  grid_in_kw REAL NOT NULL,
  grid_out_kw REAL NOT NULL,
  meter_in_kw REAL NOT NULL,
  meter_out_kw REAL NOT NULL,
  meter_voltage_v REAL NOT NULL,
  energy_in_kwh REAL NOT NULL,
  energy_out_kwh REAL NOT NULL,
  disco_in_kw REAL NOT NULL,
  disco_out_kw REAL NOT NULL,
  disco_voltage_v REAL NOT NULL,
  frequency_hz REAL NOT NULL,
  contactor TEXT NOT NULL,
  islanded INTEGER NOT NULL,
  load_kw REAL NOT NULL,
  panel_voltage_v REAL NOT NULL,
  physical_soc_kwh REAL NOT NULL,
  soc_kwh REAL NOT NULL,
  soc_pct REAL NOT NULL,
  commanded_charge_kw REAL NOT NULL,
  commanded_discharge_kw REAL NOT NULL,
  charge_kw REAL NOT NULL,
  discharge_kw REAL NOT NULL,
  temp_c REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS observations_site ON observations (site_id, ts);
CREATE TABLE IF NOT EXISTS control_points (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  site_id TEXT NOT NULL,
  chart_id TEXT NOT NULL,
  component TEXT NOT NULL,
  family TEXT NOT NULL,
  measured REAL NOT NULL,
  expected REAL NOT NULL,
  value REAL NOT NULL,
  sigma REAL NOT NULL,
  ucl REAL NOT NULL,
  lcl REAL NOT NULL,
  z REAL NOT NULL,
  rules_json TEXT NOT NULL,
  in_control INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS control_points_site ON control_points (site_id, chart_id, ts);
CREATE TABLE IF NOT EXISTS fleet_rollups (
  ts TEXT PRIMARY KEY,
  units INTEGER NOT NULL,
  pushing INTEGER NOT NULL,
  pulling INTEGER NOT NULL,
  holding INTEGER NOT NULL,
  alarms INTEGER NOT NULL,
  warnings INTEGER NOT NULL,
  discharge_kw REAL NOT NULL,
  charge_kw REAL NOT NULL,
  load_kw REAL NOT NULL,
  stored_kwh REAL NOT NULL,
  capacity_kwh REAL NOT NULL,
  mean_soc_pct REAL NOT NULL,
  offline INTEGER NOT NULL DEFAULT 0,
  solar_charge_kw REAL NOT NULL DEFAULT 0,
  solar_kw REAL NOT NULL DEFAULT 0,
  ev_kw REAL NOT NULL DEFAULT 0,
  grid_in_kw REAL NOT NULL DEFAULT 0,
  grid_out_kw REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS dispatch_ticks (
  ts TEXT PRIMARY KEY,
  demand_mw REAL,
  demand_percentile REAL,
  storage_gen_mw REAL,
  frequency_hz REAL NOT NULL,
  signal TEXT NOT NULL,
  intensity REAL NOT NULL,
  source TEXT NOT NULL,
  zones_json TEXT NOT NULL,
  pushing INTEGER NOT NULL,
  pulling INTEGER NOT NULL,
  holding INTEGER NOT NULL,
  discharge_kw REAL NOT NULL,
  charge_kw REAL NOT NULL,
  load_kw REAL NOT NULL,
  mean_soc_pct REAL NOT NULL,
  stored_kwh REAL NOT NULL,
  alarms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS market_ticks (
  ts TEXT PRIMARY KEY,
  demand_mw REAL,
  demand_percentile REAL,
  storage_gen_mw REAL,
  rate_usd_mwh REAL NOT NULL,
  rate_basis TEXT NOT NULL,
  frequency_hz REAL NOT NULL,
  signal TEXT NOT NULL,
  intensity REAL NOT NULL,
  source TEXT NOT NULL,
  mean_soc_pct REAL NOT NULL,
  offline INTEGER NOT NULL,
  units INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS unit_latest (
  site_id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  soc_kwh REAL NOT NULL,
  soc_pct REAL NOT NULL,
  availability TEXT NOT NULL,
  signal TEXT NOT NULL,
  charge_kw REAL NOT NULL,
  discharge_kw REAL NOT NULL,
  load_kw REAL NOT NULL,
  temp_c REAL NOT NULL,
  addons_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_hours (
  ts TEXT NOT NULL,
  site_id TEXT NOT NULL,
  hour INTEGER NOT NULL,
  load_kwh REAL NOT NULL,
  import_kwh REAL NOT NULL,
  export_kwh REAL NOT NULL,
  solar_kwh REAL NOT NULL,
  ev_kwh REAL NOT NULL,
  PRIMARY KEY (ts, site_id)
);
CREATE TABLE IF NOT EXISTS unit_actions (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  site_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  starts_at TEXT,
  ends_at TEXT,
  note TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  actor TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS site_addons (
  site_id TEXT NOT NULL,
  addon_id TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  PRIMARY KEY (site_id, addon_id)
);
"""

_ROLLUP_COLUMNS = (
    "ts", "units", "pushing", "pulling", "holding", "alarms", "warnings",
    "discharge_kw", "charge_kw", "load_kw", "stored_kwh", "capacity_kwh", "mean_soc_pct",
    "offline", "solar_charge_kw", "solar_kw", "ev_kw", "grid_in_kw", "grid_out_kw",
)

LOG_CAP = 20000
OBSERVATION_CAP = 20000
CONTROL_CAP = 60000

_ADDED_COLUMNS = (
    ("control_points", "component", "TEXT NOT NULL DEFAULT ''"),
    ("fleet_rollups", "offline", "INTEGER NOT NULL DEFAULT 0"),
    ("fleet_rollups", "solar_charge_kw", "REAL NOT NULL DEFAULT 0"),
    ("fleet_rollups", "solar_kw", "REAL NOT NULL DEFAULT 0"),
    ("fleet_rollups", "ev_kw", "REAL NOT NULL DEFAULT 0"),
    ("fleet_rollups", "grid_in_kw", "REAL NOT NULL DEFAULT 0"),
    ("fleet_rollups", "grid_out_kw", "REAL NOT NULL DEFAULT 0"),
)

_OBSERVATION_COLUMNS = (
    "ts", "site_id", "hour", "demand_mw", "demand_percentile", "storage_gen_mw", "lmp_usd_mwh",
    "signal", "grid_in_kw", "grid_out_kw", "meter_in_kw", "meter_out_kw", "meter_voltage_v",
    "energy_in_kwh", "energy_out_kwh", "disco_in_kw", "disco_out_kw", "disco_voltage_v",
    "frequency_hz", "contactor", "islanded", "load_kw", "panel_voltage_v", "physical_soc_kwh",
    "soc_kwh", "soc_pct", "commanded_charge_kw", "commanded_discharge_kw", "charge_kw",
    "discharge_kw", "temp_c",
)


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.executescript(_SCHEMA)
    _add_missing_columns(conn)
    return conn


def _add_missing_columns(conn: sqlite3.Connection) -> None:
    """CREATE TABLE IF NOT EXISTS leaves older files behind when a column is added."""
    for table, column, decl in _ADDED_COLUMNS:
        existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
        if column not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
    conn.commit()


def recent_supply(conn: sqlite3.Connection, cutoffs: list[str]) -> list[dict]:
    """Older supply-demand payloads, newest first within each cutoff, ids unique."""
    bodies = []
    seen: set[int] = set()
    for cutoff in cutoffs:
        row = conn.execute(
            """
            SELECT id, body FROM raw_records
            WHERE source = 'supply-demand' AND fetched_at <= ?
            ORDER BY fetched_at DESC
            LIMIT 1
            """,
            (cutoff,),
        ).fetchone()
        if row is None or row[0] in seen:
            continue
        seen.add(row[0])
        bodies.append(json.loads(row[1]))
    return bodies


def insert_raw(conn: sqlite3.Connection, source: str, fetched_at: str, body: Any) -> None:
    conn.execute(
        "INSERT INTO raw_records (source, fetched_at, body) VALUES (?, ?, ?)",
        (source, fetched_at, json.dumps(body)),
    )
    conn.commit()


def _trim(conn: sqlite3.Connection, table: str, cap: int) -> None:
    count = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    if count > cap:
        extra = count - cap
        conn.execute(
            f"DELETE FROM {table} WHERE id IN (SELECT id FROM {table} ORDER BY id LIMIT ?)",
            (extra,),
        )


def upsert_sites(conn: sqlite3.Connection, sites: list[dict]) -> None:
    conn.executemany(
        """
        INSERT INTO sites (
          site_id, city, load_zone, lat, lon, capacity_kwh, power_limit_kw,
          load_scale, temp_center_c, temp_sigma_c, voltage_center_v, voltage_sigma_v, eta
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(site_id) DO UPDATE SET
          city = excluded.city,
          load_zone = excluded.load_zone,
          lat = excluded.lat,
          lon = excluded.lon,
          capacity_kwh = excluded.capacity_kwh,
          power_limit_kw = excluded.power_limit_kw,
          load_scale = excluded.load_scale,
          temp_center_c = excluded.temp_center_c,
          temp_sigma_c = excluded.temp_sigma_c,
          voltage_center_v = excluded.voltage_center_v,
          voltage_sigma_v = excluded.voltage_sigma_v,
          eta = excluded.eta
        """,
        [
            (
                site["id"], site["city"], site["load_zone"], site["lat"], site["lon"],
                site["capacity_kwh"], site["power_limit_kw"], site["load_scale"],
                site["temp_center_c"], site["temp_sigma_c"], site["voltage_center_v"],
                site["voltage_sigma_v"], site["eta"],
            )
            for site in sites
        ],
    )
    conn.commit()


def insert_grid(conn: sqlite3.Connection, grid: dict) -> None:
    if not grid.get("as_of"):
        return
    conn.execute(
        """
        INSERT INTO grid_snapshots (
          ts, demand_mw, capacity_mw, available_mw, forecast_demand_mw, demand_percentile,
          storage_gen_mw, wind_mw, solar_mw, gas_mw, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ts) DO UPDATE SET
          demand_mw = excluded.demand_mw,
          capacity_mw = excluded.capacity_mw,
          available_mw = excluded.available_mw,
          forecast_demand_mw = excluded.forecast_demand_mw,
          demand_percentile = excluded.demand_percentile,
          storage_gen_mw = excluded.storage_gen_mw,
          wind_mw = excluded.wind_mw,
          solar_mw = excluded.solar_mw,
          gas_mw = excluded.gas_mw,
          source = excluded.source
        """,
        (
            grid["as_of"], grid.get("demand_mw"), grid.get("capacity_mw"), grid.get("available_mw"),
            grid.get("forecast_demand_mw"), grid.get("demand_percentile"), grid.get("storage_gen_mw"),
            grid.get("wind_mw"), grid.get("solar_mw"), grid.get("gas_mw"), grid.get("source"),
        ),
    )
    conn.commit()


def insert_rollup(conn: sqlite3.Connection, rollup: dict) -> None:
    columns = ", ".join(_ROLLUP_COLUMNS)
    placeholders = ", ".join("?" for _ in _ROLLUP_COLUMNS)
    conn.execute(
        f"INSERT OR REPLACE INTO fleet_rollups ({columns}) VALUES ({placeholders})",
        tuple(rollup[column] for column in _ROLLUP_COLUMNS),
    )
    conn.commit()


_DISPATCH_COLUMNS = (
    "ts",
    "demand_mw",
    "demand_percentile",
    "storage_gen_mw",
    "frequency_hz",
    "signal",
    "intensity",
    "source",
    "zones_json",
    "pushing",
    "pulling",
    "holding",
    "discharge_kw",
    "charge_kw",
    "load_kw",
    "mean_soc_pct",
    "stored_kwh",
    "alarms",
)


def insert_market(conn: sqlite3.Connection, row: dict) -> None:
    columns = (
        "ts", "demand_mw", "demand_percentile", "storage_gen_mw", "rate_usd_mwh", "rate_basis",
        "frequency_hz", "signal", "intensity", "source", "mean_soc_pct", "offline", "units",
    )
    conn.execute(
        f"INSERT OR REPLACE INTO market_ticks ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
        tuple(row[column] for column in columns),
    )
    conn.commit()


def upsert_latest(conn: sqlite3.Connection, rows: list[dict]) -> None:
    if not rows:
        return
    conn.executemany(
        """
        INSERT INTO unit_latest (
          site_id, ts, soc_kwh, soc_pct, availability, signal, charge_kw, discharge_kw,
          load_kw, temp_c, addons_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(site_id) DO UPDATE SET
          ts = excluded.ts,
          soc_kwh = excluded.soc_kwh,
          soc_pct = excluded.soc_pct,
          availability = excluded.availability,
          signal = excluded.signal,
          charge_kw = excluded.charge_kw,
          discharge_kw = excluded.discharge_kw,
          load_kw = excluded.load_kw,
          temp_c = excluded.temp_c,
          addons_json = excluded.addons_json
        """,
        [
            (
                row["site_id"], row["ts"], row["soc_kwh"], row["soc_pct"], row["availability"],
                row["signal"], row["charge_kw"], row["discharge_kw"], row["load_kw"],
                row["temp_c"], json.dumps(row["addons"]),
            )
            for row in rows
        ],
    )
    conn.commit()


def insert_usage(conn: sqlite3.Connection, rows: list[dict]) -> None:
    if not rows:
        return
    conn.executemany(
        """
        INSERT OR REPLACE INTO usage_hours (
          ts, site_id, hour, load_kwh, import_kwh, export_kwh, solar_kwh, ev_kwh
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                row["ts"], row["site_id"], row["hour"], row["load_kwh"], row["import_kwh"],
                row["export_kwh"], row["solar_kwh"], row["ev_kwh"],
            )
            for row in rows
        ],
    )
    conn.commit()


def upsert_actions(conn: sqlite3.Connection, rows: list[dict]) -> None:
    if not rows:
        return
    conn.executemany(
        """
        INSERT INTO unit_actions (
          id, ts, site_id, kind, status, starts_at, ends_at, note, payload_json, actor
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          starts_at = excluded.starts_at,
          ends_at = excluded.ends_at,
          note = excluded.note
        """,
        [
            (
                row["id"], row["ts"], row["site_id"], row["kind"], row["status"],
                row.get("starts_at"), row.get("ends_at"), row.get("note") or "",
                json.dumps(row.get("payload") or {}), row.get("actor") or "llm",
            )
            for row in rows
        ],
    )
    conn.execute(
        """
        DELETE FROM unit_actions WHERE id NOT IN (
          SELECT id FROM unit_actions ORDER BY ts DESC LIMIT 500
        )
        """
    )
    conn.commit()


def load_actions(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        """
        SELECT id, ts, site_id, kind, status, starts_at, ends_at, note, payload_json, actor
        FROM unit_actions
        WHERE status IN ('pending', 'active')
        ORDER BY ts
        """
    ).fetchall()
    loaded = []
    for row in rows:
        loaded.append(
            {
                "id": row[0],
                "ts": row[1],
                "site_id": row[2],
                "kind": row[3],
                "status": row[4],
                "starts_at": row[5],
                "ends_at": row[6],
                "note": row[7] or "",
                "payload": json.loads(row[8] or "{}"),
                "actor": row[9],
            }
        )
    return loaded


def load_addon_map(conn: sqlite3.Connection) -> dict[str, list[str]]:
    found: dict[str, list[str]] = {}
    for site_id, addon_id in conn.execute("SELECT site_id, addon_id FROM site_addons"):
        found.setdefault(site_id, []).append(addon_id)
    return found


def replace_addons(conn: sqlite3.Connection, site_id: str, addon_ids: list[str], installed_at: str) -> None:
    conn.execute("DELETE FROM site_addons WHERE site_id = ?", (site_id,))
    conn.executemany(
        "INSERT INTO site_addons (site_id, addon_id, installed_at) VALUES (?, ?, ?)",
        [(site_id, addon_id, installed_at) for addon_id in addon_ids],
    )
    conn.commit()


def insert_dispatch(conn: sqlite3.Connection, row: dict) -> None:
    columns = ", ".join(_DISPATCH_COLUMNS)
    placeholders = ", ".join("?" for _ in _DISPATCH_COLUMNS)
    conn.execute(
        f"INSERT OR REPLACE INTO dispatch_ticks ({columns}) VALUES ({placeholders})",
        tuple(row[column] for column in _DISPATCH_COLUMNS),
    )
    conn.commit()


def insert_tick(conn: sqlite3.Connection, logs: list[dict], observations: list[dict], points: list[dict]) -> None:
    conn.executemany(
        "INSERT INTO metric_logs (ts, site_id, component, metrics_json) VALUES (?, ?, ?, ?)",
        [(row["ts"], row["site_id"], row["component"], json.dumps(row["metrics"])) for row in logs],
    )
    placeholders = ", ".join("?" for _ in _OBSERVATION_COLUMNS)
    columns = ", ".join(_OBSERVATION_COLUMNS)
    conn.executemany(
        f"INSERT INTO observations ({columns}) VALUES ({placeholders})",
        [tuple(row[column] for column in _OBSERVATION_COLUMNS) for row in observations],
    )
    conn.executemany(
        """
        INSERT INTO control_points (
          ts, site_id, chart_id, component, family, measured, expected, value, sigma, ucl, lcl, z, rules_json, in_control
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                point["ts"], point["site_id"], point["chart_id"], point["component"],
                point["family"],
                point["measured"], point["expected"], point["value"], point["sigma"],
                point["ucl"], point["lcl"], point["z"], json.dumps(point["rules"]),
                1 if point["in_control"] else 0,
            )
            for point in points
        ],
    )
    _trim(conn, "metric_logs", LOG_CAP)
    _trim(conn, "observations", OBSERVATION_CAP)
    _trim(conn, "control_points", CONTROL_CAP)
    conn.commit()
