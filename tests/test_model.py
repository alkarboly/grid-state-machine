import math
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
from gridsim.fleet.policy import choose_signal, resolve_order
from gridsim.fleet.simulate import (
    COMPONENTS,
    DEMO_FAULTS,
    EXTRAS_PER_KIND,
    FAULT_KINDS,
    inside_texas,
    OBSERVATION_FIELDS,
    apportion,
    build_sites,
    load_anchors,
    metro_summary,
    station_summary,
    tick_sites,
)
from gridsim.state import persist_sample, rollup
from gridsim.timeutil import parse_ercot_ts

CENTRAL = ZoneInfo("America/Chicago")

# Small enough to stay fast, large enough that every demo fault id exists.
FLEET_SIZE = 600


def FLEET():
    return build_sites(fleet_size=FLEET_SIZE)


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
        self.assertIsNone(resolve_order(None, 0.5))
        self.assertIsNone(resolve_order({"signal": "auto"}, 0.5))
        self.assertEqual(resolve_order({"signal": "hold"}, 0.9), ("hold", 0.0, "external"))
        signal, level, source = resolve_order({"signal": "push", "intensity": 0.4}, 0.2)
        self.assertEqual((signal, source), ("push", "external"))
        self.assertEqual(level, 0.4)

    def test_external_call_overrides_the_ladder(self):
        now = datetime(2026, 9, 25, 19, 45, tzinfo=CENTRAL)
        held, *_ = tick_sites(FLEET(), _grid(0.5), now, 0.0028, random.Random(4))
        pushed, *_ = tick_sites(
            FLEET(),
            _grid(0.5),
            now,
            0.0028,
            random.Random(4),
            order={"signal": "push", "intensity": 1},
        )
        held_push = sum(site["state"] == "push" for site in held)
        pushed_push = sum(site["state"] == "push" for site in pushed)
        self.assertGreater(pushed_push, held_push)
        self.assertTrue(all(site["metrics"]["grid"]["source"] == "external" for site in pushed))
        self.assertTrue(all(site["signal"] == "push" for site in pushed))
        base = pushed[0]["metrics"]["disco"]["frequency_hz"]
        self.assertTrue(
            all(abs(site["metrics"]["disco"]["frequency_hz"] - base) < 0.05 for site in pushed)
        )

    def test_load_and_temperature_carry_across_ticks(self):
        now = datetime(2026, 9, 25, 19, 45, tzinfo=CENTRAL)
        rng = random.Random(8)
        first, *_ = tick_sites(FLEET(), _grid(0.9), now, 0.005, rng)
        second, *_ = tick_sites(first, _grid(0.9), now, 0.005, rng)
        before = first[0]
        after = next(site for site in second if site["id"] == before["id"])
        self.assertLess(abs(before["load_kw_state"] - after["load_kw_state"]), 1.0)
        self.assertLess(abs(before["temp_c_state"] - after["temp_c_state"]), 1.0)
        note = {}
        tick_sites(FLEET(), _grid(0.5), now, 0.0, random.Random(1), order={"signal": "hold"}, note=note)
        self.assertEqual(note["source"], "external")
        self.assertEqual(note["signal"], "hold")
        self.assertEqual(note["intensity"], 0.0)

    def test_tick_writes_every_component_and_flags_faults(self):
        now = datetime(2026, 9, 25, 19, 45, tzinfo=CENTRAL)
        sites, logs, observations, points = tick_sites(FLEET(), _grid(0.9), now, 0.0, random.Random(1))
        self.assertEqual(len(sites), FLEET_SIZE)
        self.assertEqual({row["component"] for row in logs}, set(COMPONENTS))
        by_id = {site["id"]: site for site in sites}
        self.assertTrue(by_id["aus-0003"]["alarm"])
        self.assertGreater(by_id["aus-0003"]["metrics"]["base"]["temp_c"], 45)
        self.assertTrue(by_id["hou-0002"]["alarm"])
        self.assertEqual(by_id["hou-0002"]["metrics"]["disco"]["voltage_v"], 226.0)
        pushed = next(site for site in sites if site["state"] == "push")
        self.assertEqual(pushed["metrics"]["grid"]["signal"], "push")
        self.assertGreater(pushed["metrics"]["base"]["discharge_kw"], 0)
        self.assertEqual(pushed["metrics"]["disco"]["contactor"], "closed")
        for component, metrics in pushed["metrics"].items():
            self.assertIsInstance(metrics, dict)
            self.assertTrue(metrics, component)

        charging, _logs, _obs, _points = tick_sites(FLEET(), _grid(0.1), now, 0.25, random.Random(2))
        home = next(site for site in charging if site["state"] == "pull")
        self.assertEqual(home["metrics"]["grid"]["signal"], "pull")
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
        _sites, _logs, _obs, points = tick_sites(FLEET(), _grid(0.5), now, 0.0, random.Random(4))
        self.assertTrue(all(point["component"] in COMPONENTS for point in points))

    def test_each_battery_has_its_own_baseline(self):
        sites = FLEET()
        self.assertGreater(len({site["load_scale"] for site in sites}), 20)
        self.assertGreater(len({site["temp_center_c"] for site in sites}), 20)
        self.assertGreater(len({site["duty"] for site in sites}), 20)
        self.assertGreater(len({site["reserve_frac"] for site in sites}), 20)

    def test_faults_hit_different_chart_families(self):
        now = datetime(2026, 9, 25, 19, 45, tzinfo=CENTRAL)
        sites, _logs, _obs, _points = tick_sites(FLEET(), _grid(0.9), now, 0.0, random.Random(3))
        by_id = {site["id"]: site for site in sites}

        def rules(site_id, chart_id):
            chart = next(item for item in by_id[site_id]["charts"] if item["chart_id"] == chart_id)
            return chart["rules"]

        self.assertIn("beyond_3sigma", rules("aus-0003", "base_temp"))
        self.assertIn("beyond_3sigma", rules("hou-0002", "disco_voltage"))
        self.assertIn("beyond_3sigma", rules("hou-0002", "disco_meter_delta"))
        self.assertIn("beyond_3sigma", rules("sat-0001", "soc_tracking"))
        self.assertIn("beyond_3sigma", rules("dal-0002", "dispatch_response"))
        healthy = next(site for site in sites if not site["fault"])
        self.assertTrue(all(chart["in_control"] for chart in healthy["charts"]))


class ScaleTests(unittest.TestCase):
    def test_counts_follow_metro_weight_and_sum_to_the_fleet(self):
        self.assertEqual(sum(apportion(3000, [10, 5, 1])), 3000)
        self.assertEqual(apportion(300, [1, 1, 1]), [100, 100, 100])
        sites = build_sites(fleet_size=3000)
        self.assertEqual(len(sites), 3000)
        summary = {item["name"]: item["units"] for item in metro_summary(load_anchors(), sites)}
        self.assertGreater(summary["Austin"], summary["Houston"])
        self.assertGreater(summary["Houston"], summary["Dallas"])
        self.assertGreater(summary["Dallas"], summary["Victoria"])
        self.assertGreater(len(summary), 15)

    def test_units_land_inside_texas_and_cluster_by_neighborhood(self):
        sites = build_sites(fleet_size=3000)
        for site in sites:
            self.assertTrue(inside_texas(site["lat"], site["lon"]), site)
        austin = [site for site in sites if site["metro"] == "austin"]
        centre = sum(1 for site in austin if abs(site["lat"] - 30.2672) < 0.05)
        # Neighborhoods sit in the suburbs. Downtown is not where the roofs are.
        self.assertLess(centre / len(austin), 0.2)
        span = max(site["lat"] for site in austin) - min(site["lat"] for site in austin)
        self.assertGreater(span, 0.12)
        self.assertLess(span, 0.9)
        # Houses in a subdivision are neighbours, not scattered across the metro.
        sample = austin[::25]
        nearest = []
        for site in sample:
            nearest.append(
                min(
                    math.hypot(site["lat"] - other["lat"], (site["lon"] - other["lon"]) * 0.86)
                    for other in austin
                    if other is not site
                )
            )
        nearest.sort()
        self.assertGreater(nearest[0], 0.002)
        self.assertLess(nearest[len(nearest) // 2], 0.03)

    def test_each_unit_supplies_a_nearby_station_on_land(self):
        sites = build_sites(fleet_size=3000)
        stations = station_summary(sites)
        self.assertGreater(len(stations), 20)
        self.assertLess(len(stations), 160)
        by_id = {station["id"]: station for station in stations}
        self.assertEqual(len(by_id), len(stations))
        stray = 0
        for site in sites:
            station = by_id[site["station"]]
            self.assertEqual(station["metro"], site["metro"])
            self.assertTrue(inside_texas(station["lat"], station["lon"]), station["id"])
            km = math.hypot(
                (site["lat"] - station["lat"]) * 110.574,
                (site["lon"] - station["lon"]) * 110.574 * 0.86,
            )
            if km > 14:
                stray += 1
        self.assertLess(stray / len(sites), 0.02)

    def test_only_a_few_faults_of_each_kind(self):
        sites = build_sites(fleet_size=3000)
        faulted = [site for site in sites if site["fault"]]
        self.assertEqual(len(faulted), len(DEMO_FAULTS) + EXTRAS_PER_KIND * len(FAULT_KINDS))
        counts = {kind: 0 for kind in FAULT_KINDS}
        for site in faulted:
            for kind in site["fault"]:
                counts[kind] += 1
        for kind in FAULT_KINDS:
            self.assertEqual(counts[kind], EXTRAS_PER_KIND + 1)

    def test_placement_is_stable_across_rebuilds(self):
        first = {site["id"]: (site["lat"], site["lon"]) for site in build_sites(fleet_size=800)}
        second = {site["id"]: (site["lat"], site["lon"]) for site in build_sites(fleet_size=800)}
        self.assertEqual(first, second)

    def test_persist_sample_holds_the_demo_faults_and_caps_the_write_rate(self):
        sites = build_sites(fleet_size=3000)
        sample = persist_sample(sites, 60)
        self.assertTrue(set(DEMO_FAULTS) <= sample)
        self.assertLessEqual(len(sample), 64)
        now = datetime(2026, 9, 25, 19, 45, tzinfo=CENTRAL)
        _sites, logs, observations, points = tick_sites(
            sites, _grid(0.9), now, 0.0, random.Random(5), persist=sample
        )
        self.assertEqual(len(observations), len(sample))
        self.assertEqual(len(logs), len(sample) * len(COMPONENTS))
        # Sampled units write every chart; everyone else writes only exceptions.
        extra = [point for point in points if point["site_id"] not in sample]
        self.assertTrue(extra)
        self.assertTrue(all(not point["in_control"] for point in extra))

    def test_dispatch_reaches_more_of_the_fleet_as_the_grid_tightens(self):
        now = datetime(2026, 9, 25, 19, 45, tzinfo=CENTRAL)

        def pushing(percentile):
            sites, _l, _o, _p = tick_sites(
                build_sites(fleet_size=1200), _grid(percentile), now, 0.0028, random.Random(6)
            )
            return sum(1 for site in sites if site["state"] == "push")

        self.assertGreater(pushing(0.95), pushing(0.78))
        self.assertGreater(pushing(0.78), 0)

    def test_rollup_totals_match_the_fleet(self):
        now = datetime(2026, 9, 25, 19, 45, tzinfo=CENTRAL)
        sites, _l, _o, _p = tick_sites(
            build_sites(fleet_size=1200), _grid(0.9), now, 0.0028, random.Random(7)
        )
        totals = rollup(sites, "2026-09-25T19:45:00-05:00")
        self.assertEqual(totals["units"], 1200)
        self.assertEqual(totals["pushing"] + totals["pulling"] + totals["holding"], 1200)
        self.assertEqual(
            totals["alarms"], sum(1 for site in sites if site["metrics"]["maintenance"]["alarm"])
        )
        self.assertAlmostEqual(
            totals["discharge_kw"],
            round(sum(site["metrics"]["base"]["discharge_kw"] for site in sites), 2),
            places=1,
        )

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

    def test_only_a_point_past_the_limits_alarms(self):
        spec = CHARTS[0]
        spike = evaluate(spec, 4.0, 0.0, 1.0, [])
        self.assertTrue(spike["alarm"])
        # A run rule is a warning, not an alarm. It fires on healthy charts often
        # enough that alarming on it would flood a fleet-sized map.
        shift = evaluate(spec, 0.4, 0.0, 1.0, [0.4] * 6)
        self.assertIn("seven_same_side", shift["rules"])
        self.assertFalse(shift["in_control"])
        self.assertFalse(shift["alarm"])
        self.assertTrue(shift["warning"])
        calm = evaluate(spec, 0.2, 0.0, 1.0, [])
        self.assertTrue(calm["in_control"])
        self.assertFalse(calm["alarm"])
        self.assertFalse(calm["warning"])

    def test_alarm_rate_stays_near_the_fault_rate(self):
        now = datetime(2026, 9, 25, 19, 45, tzinfo=CENTRAL)
        sites = build_sites(fleet_size=2000)
        for seed in (11, 12, 13):
            sites, _l, _o, _p = tick_sites(sites, _grid(0.9), now, 0.0028, random.Random(seed))
        totals = rollup(sites, "2026-09-25T19:45:00-05:00")
        faulted = sum(1 for site in sites if site["fault"])
        self.assertLessEqual(totals["alarms"], faulted)
        self.assertLess(totals["alarms"] / len(sites), 0.02)
        self.assertLessEqual(faulted, len(DEMO_FAULTS) + EXTRAS_PER_KIND * len(FAULT_KINDS))


if __name__ == "__main__":
    unittest.main()
