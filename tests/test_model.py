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
from gridsim.fleet.charts import CHARTS, evaluate
from gridsim.fleet.policy import choose_signal
from gridsim.fleet.simulate import COMPONENTS, OBSERVATION_FIELDS, build_sites, tick_sites
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
        sites, logs, observations, points = tick_sites(build_sites(), _grid(0.9), now, 0.0, random.Random(1))
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

        charging, _logs, _obs, _points = tick_sites(build_sites(), _grid(0.1), now, 0.25, random.Random(2))
        home = {site["id"]: site for site in charging}["aus-01"]
        self.assertEqual(home["signal"], "pull")
        self.assertGreater(home["metrics"]["base"]["charge_kw"], 0)
        self.assertGreater(home["metrics"]["meter"]["energy_in_kwh"], 0)
        net = home["metrics"]["grid"]["in_kw"] - home["metrics"]["grid"]["out_kw"]
        base = home["metrics"]["base"]
        expected_net = home["metrics"]["panel"]["load_kw"] + base["charge_kw"] - base["discharge_kw"]
        self.assertAlmostEqual(net, expected_net, places=2)
        self.assertEqual(set(observations[0]), {"ts", "site_id", *OBSERVATION_FIELDS})
        self.assertEqual({point["chart_id"] for point in points}, {spec["chart_id"] for spec in CHARTS})

    def test_every_chart_names_a_real_component(self):
        components = {spec["component"] for spec in CHARTS}
        self.assertTrue(components <= set(COMPONENTS), components - set(COMPONENTS))
        now = datetime(2026, 9, 25, 19, 45, tzinfo=CENTRAL)
        _sites, _logs, _obs, points = tick_sites(build_sites(), _grid(0.5), now, 0.0, random.Random(4))
        self.assertTrue(all(point["component"] in COMPONENTS for point in points))

    def test_each_battery_has_its_own_baseline(self):
        scales = {site["load_scale"] for site in build_sites()}
        temps = {site["temp_center_c"] for site in build_sites()}
        self.assertGreater(len(scales), 20)
        self.assertGreater(len(temps), 20)

    def test_faults_hit_different_chart_families(self):
        now = datetime(2026, 9, 25, 19, 45, tzinfo=CENTRAL)
        sites, _logs, _obs, _points = tick_sites(build_sites(), _grid(0.9), now, 0.0, random.Random(3))
        by_id = {site["id"]: site for site in sites}

        def rules(site_id, chart_id):
            chart = next(item for item in by_id[site_id]["charts"] if item["chart_id"] == chart_id)
            return chart["rules"]

        self.assertIn("beyond_3sigma", rules("aus-03", "base_temp"))
        self.assertIn("beyond_3sigma", rules("hou-02", "disco_voltage"))
        self.assertIn("beyond_3sigma", rules("hou-02", "disco_meter_delta"))
        self.assertIn("beyond_3sigma", rules("sat-01", "soc_tracking"))
        self.assertIn("beyond_3sigma", rules("dal-02", "dispatch_response"))
        self.assertTrue(by_id["aus-01"]["charts"][1]["in_control"])

    def test_control_rules(self):
        spec = CHARTS[0]
        shift = evaluate(spec, 1.0, 0.0, 1.0, [1, 1, 1, 1, 1, 1])
        self.assertIn("seven_same_side", shift["rules"])
        spike = evaluate(spec, 4.0, 0.0, 1.0, [])
        self.assertIn("beyond_3sigma", spike["rules"])
        self.assertEqual(spike["ucl"], 3.0)
        self.assertEqual(spike["lcl"], -3.0)
        pair = evaluate(spec, 2.5, 0.0, 1.0, [2.5, 0.0])
        self.assertIn("two_of_three_2sigma", pair["rules"])


if __name__ == "__main__":
    unittest.main()
