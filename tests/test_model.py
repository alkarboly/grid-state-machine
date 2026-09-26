import random
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from gridsim.ercot.normalize import (
    constraints_from_rows,
    edges_from_constraints,
    grid_from_dashboards,
    prices_from_rows,
)
from gridsim.fleet.policy import choose_signal
from gridsim.fleet.simulate import COMPONENTS, build_sites, tick_sites
from gridsim.timeutil import parse_ercot_ts

CENTRAL = ZoneInfo("America/Chicago")


def _grid(percentile: float) -> dict:
    return {
        "as_of": "2026-09-25T19:45:00-05:00",
        "demand_mw": 62000,
        "demand_percentile": percentile,
        "storage_gen_mw": 0,
        "prices": [],
    }


class NormalizeTests(unittest.TestCase):
    def test_parses_ercot_dashboard_stamp(self):
        parsed = parse_ercot_ts("2026-09-25 19:45:00-0500")
        self.assertEqual(parsed.hour, 19)
        self.assertEqual(parsed.utcoffset().total_seconds(), -5 * 3600)

    def test_demand_percentile_uses_actuals_only(self):
        supply = {
            "data": [
                {"demand": 40000, "capacity": 80000, "available": 90000, "forecast": 0, "timestamp": "2026-09-25 01:00:00-0500"},
                {"demand": 60000, "capacity": 80000, "available": 90000, "forecast": 0, "timestamp": "2026-09-25 19:00:00-0500"},
                {"demand": 70000, "capacity": 80000, "available": 90000, "forecast": 1, "timestamp": "2026-09-26 01:00:00-0500"},
            ],
            "forecast": [
                {"forecastedDemand": 58000, "timestamp": "2026-09-25 20:00:00-0500"},
            ],
        }
        fuel = {
            "data": {
                "2026-09-25": {
                    "2026-09-25 19:00:00-0500": {"Power Storage": {"gen": -320}, "Wind": {"gen": 14000}, "Solar": {"gen": 10}, "Natural Gas": {"gen": 33000}},
                }
            }
        }
        grid = grid_from_dashboards(supply, fuel)
        self.assertEqual(grid["demand_mw"], 60000)
        self.assertEqual(grid["demand_percentile"], 1)
        self.assertEqual(grid["storage_gen_mw"], -320)
        self.assertEqual(grid["forecast_demand_mw"], 58000)

    def test_constraint_columns_and_edges(self):
        rows = constraints_from_rows(
            [
                {
                    "SCEDTimeStamp": "2026-09-25T19:40:00-05:00",
                    "ConstraintName": "OLD",
                    "ContingencyName": "BASE CASE",
                    "ShadowPrice": 1,
                    "MaxShadowPrice": 3500,
                    "Limit": 100,
                    "Value": 90,
                    "ViolatedMW": 0,
                    "FromStation": "AAA",
                    "ToStation": "BBB",
                    "FromStationkV": 138,
                    "ToStationkV": 138,
                },
                {
                    "SCEDTimestamp": "2026-09-25T19:45:00-05:00",
                    "ConstraintName": "654T654_1",
                    "ContingencyName": "DFERGRM8",
                    "ShadowPrice": 30.1,
                    "MaxShadowPrice": 3500,
                    "Limit": 241.9,
                    "Value": 241.9,
                    "ViolatedMW": 0,
                    "FromStation": "WIRTZ",
                    "ToStation": "STARCK",
                    "FromStationkV": 138,
                    "ToStationkV": 138,
                },
            ]
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["from_station"], "WIRTZ")
        self.assertEqual(rows[0]["value_mw"], 241.9)
        edges = edges_from_constraints(
            rows,
            {
                "WIRTZ": {"lat": 30.7, "lon": -98.1},
                "STARCK": {"lat": 30.5, "lon": -97.9},
            },
        )
        self.assertEqual(len(edges), 1)
        self.assertEqual(edges_from_constraints(rows, {}), [])

    def test_prices_keep_latest_interval(self):
        prices = prices_from_rows(
            [
                {"SCEDTimestamp": "t1", "SettlementPoint": "LZ_AEN", "LMP": 20},
                {"SCEDTimestamp": "t2", "SettlementPoint": "LZ_AEN", "LMP": 45},
                {"SCEDTimestamp": "t2", "SettlementPoint": "HB_HUBAVG", "LMP": 40},
            ],
            "settlementPoint",
        )
        by_location = {item["location"]: item["lmp"] for item in prices}
        self.assertEqual(by_location, {"LZ_AEN": 45, "HB_HUBAVG": 40})


class FleetTests(unittest.TestCase):
    def test_signal_follows_demand_then_storage(self):
        self.assertEqual(choose_signal(0.9, 0, None, None), "push")
        self.assertEqual(choose_signal(0.1, 0, None, None), "pull")
        self.assertEqual(choose_signal(0.5, -400, None, None), "pull")
        self.assertEqual(choose_signal(0.5, 0, None, None), "hold")
        self.assertEqual(choose_signal(0.5, 0, 80, 40), "push")

    def test_tick_writes_every_component_and_flags_faults(self):
        now = datetime(2026, 9, 25, 19, 45, tzinfo=CENTRAL)
        sites, logs = tick_sites(build_sites(), _grid(0.9), now, 0.0, random.Random(1))
        self.assertEqual(len(sites), 36)
        self.assertEqual({row["component"] for row in logs}, set(COMPONENTS))
        by_id = {site["id"]: site for site in sites}
        self.assertTrue(by_id["aus-03"]["alarm"])
        self.assertGreater(by_id["aus-03"]["metrics"]["base"]["temp_c"], 45)
        self.assertTrue(by_id["hou-02"]["alarm"])
        self.assertEqual(by_id["hou-02"]["metrics"]["disco"]["voltage_v"], 226.0)
        pushed = by_id["aus-01"]
        self.assertEqual(pushed["signal"], "push")
        self.assertGreater(pushed["metrics"]["base"]["discharge_kw"], 0)
        self.assertEqual(pushed["metrics"]["disco"]["contactor"], "closed")
        for component, metrics in pushed["metrics"].items():
            self.assertIsInstance(metrics, dict)
            self.assertTrue(metrics, component)

        charging, _logs = tick_sites(build_sites(), _grid(0.1), now, 0.25, random.Random(2))
        home = {site["id"]: site for site in charging}["aus-01"]
        self.assertEqual(home["signal"], "pull")
        self.assertGreater(home["metrics"]["base"]["charge_kw"], 0)
        self.assertGreater(home["metrics"]["meter"]["energy_in_kwh"], 0)


if __name__ == "__main__":
    unittest.main()
