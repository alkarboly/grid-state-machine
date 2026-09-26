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
"""

LOG_CAP = 20000


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.executescript(_SCHEMA)
    return conn


def insert_raw(conn: sqlite3.Connection, source: str, fetched_at: str, body: Any) -> None:
    conn.execute(
        "INSERT INTO raw_records (source, fetched_at, body) VALUES (?, ?, ?)",
        (source, fetched_at, json.dumps(body)),
    )
    conn.commit()


def insert_logs(conn: sqlite3.Connection, rows: list[dict]) -> None:
    conn.executemany(
        "INSERT INTO metric_logs (ts, site_id, component, metrics_json) VALUES (?, ?, ?, ?)",
        [
            (row["ts"], row["site_id"], row["component"], json.dumps(row["metrics"]))
            for row in rows
        ],
    )
    count = conn.execute("SELECT COUNT(*) FROM metric_logs").fetchone()[0]
    if count > LOG_CAP:
        extra = count - LOG_CAP
        conn.execute(
            "DELETE FROM metric_logs WHERE id IN (SELECT id FROM metric_logs ORDER BY id LIMIT ?)",
            (extra,),
        )
    conn.commit()
