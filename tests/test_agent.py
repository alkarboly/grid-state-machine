import random
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from gridsim.fleet.actions import market_rate
from gridsim.fleet.agent import audit, choose_unit_signal, day_shape, expected_kw, typical_kw
from gridsim.fleet.charts import CHARTS
from gridsim.fleet.simulate import build_sites, tick_sites

CENTRAL = ZoneInfo("America/Chicago")


def _grid(percentile: float) -> dict:
    return {
        "demand_mw": 62000,
        "demand_percentile": percentile,
        "storage_gen_mw": 0.0,
        "prices": [],
    }


def _bare(alarms: set[str], warnings: set[str] | None = None) -> dict:
    warnings = warnings or set()
    return {
        "id": "aus-0099",
        "load_scale": 1.0,
        "armed": [],
        "agent_dispatch": False,
        "charts": [
            {
                "chart_id": spec["chart_id"],
                "alarm": spec["chart_id"] in alarms,
                "warning": spec["chart_id"] in warnings,
            }
            for spec in CHARTS
        ],
    }


class AgentTests(unittest.TestCase):
    def test_every_code_has_the_registered_steps(self):
        kinds = {spec["chart_id"]: tuple(step["kind"] for step in spec["steps"]) for spec in CHARTS}
        self.assertEqual(kinds["disco_meter_delta"], ("scheduled_service",))
        self.assertEqual(kinds["base_temp"], ("set_signal", "scheduled_service"))
        self.assertEqual(kinds["disco_voltage"], ("scheduled_service",))
        self.assertEqual(kinds["frequency"], ())
        self.assertEqual(kinds["soc_tracking"], ("scheduled_service",))
        self.assertEqual(kinds["dispatch_response"], ("set_signal", "scheduled_service"))
        for spec in CHARTS:
            for step in spec["steps"]:
                if step["kind"] == "set_signal":
                    self.assertEqual(step["signal"], "hold")

    def test_an_alarm_posts_each_step_once(self):
        now = datetime(2026, 9, 25, 10, 0, tzinfo=CENTRAL)
        site = _bare({"base_temp", "frequency", "disco_voltage"})
        rows = audit([site], [], _grid(0.5), {}, now)
        by_code = {}
        for row in rows:
            by_code.setdefault(row["payload"]["chart_id"], []).append(row["kind"])
            self.assertEqual(row["actor"], "sim")
            self.assertEqual(row["status"], "pending")
        self.assertEqual(by_code["base_temp"], ["set_signal", "scheduled_service"])
        self.assertEqual(by_code["disco_voltage"], ["scheduled_service"])
        self.assertNotIn("frequency", by_code)
        self.assertEqual(rows[0]["payload"]["signal"], "hold")
        again = audit([site], rows, _grid(0.5), {}, now)
        self.assertEqual(again, [])

    def test_a_warning_posts_nothing(self):
        now = datetime(2026, 9, 25, 10, 0, tzinfo=CENTRAL)
        site = _bare(set(), {"base_temp", "soc_tracking"})
        self.assertEqual(audit([site], [], _grid(0.5), {}, now), [])

    def test_arming_a_chart_puts_it_past_the_limits(self):
        now = datetime(2026, 9, 25, 15, 0, tzinfo=CENTRAL)
        site = build_sites(fleet_size=40)[0]
        site["armed"] = [spec["chart_id"] for spec in CHARTS]
        updated, *_ = tick_sites([site], _grid(0.5), now, 0.0, random.Random(1))
        for chart in updated[0]["charts"]:
            self.assertTrue(chart["alarm"], chart["chart_id"])
            self.assertGreaterEqual(chart["z"], 3.9)

    def test_price_and_usage_choose_the_call(self):
        from gridsim.fleet.simulate import HOUR_MEAN_KW

        typical = typical_kw(1.0)
        quiet = HOUR_MEAN_KW[3]
        heavy = HOUR_MEAN_KW[17]
        self.assertEqual(choose_unit_signal(90, quiet, typical), "push")
        self.assertEqual(choose_unit_signal(63, heavy, typical), "push")
        self.assertEqual(choose_unit_signal(27, quiet, typical), "pull")
        self.assertEqual(choose_unit_signal(63, HOUR_MEAN_KW[10], typical), "hold")
        house = typical * 0.8
        self.assertEqual(choose_unit_signal(50, house, typical, {"shape": "peak"}), "push")
        self.assertEqual(choose_unit_signal(50, house, typical, {"shape": "trough"}), "pull")
        self.assertEqual(choose_unit_signal(50, house, typical, {"shape": "ramp"}), "pull")
        self.assertEqual(choose_unit_signal(50, house, typical, {"shape": "mid"}), "hold")
        self.assertEqual(choose_unit_signal(50, typical * 1.3, typical, {"shape": "trough"}), "push")
        self.assertEqual(day_shape([
            {"kind": "actual", "demand_mw": 40},
            {"kind": "actual", "demand_mw": 70},
        ])["shape"], "peak")
        self.assertEqual(day_shape([
            {"kind": "actual", "demand_mw": 70},
            {"kind": "actual", "demand_mw": 60},
            {"kind": "actual", "demand_mw": 40},
        ])["shape"], "trough")
        self.assertEqual(day_shape([
            {"kind": "actual", "demand_mw": 50},
            {"kind": "actual", "demand_mw": 55},
            {"kind": "actual", "demand_mw": 52},
            {"kind": "forecast", "demand_mw": 70},
        ])["shape"], "ramp")

        now = datetime(2026, 9, 25, 3, 0, tzinfo=CENTRAL)
        site = _bare(set())
        site["agent_dispatch"] = True
        pulled = audit([site], [], _grid(0.1), {}, now)
        self.assertEqual(pulled[0]["payload"]["signal"], "pull")
        self.assertEqual(pulled[0]["payload"]["reason"], "price")
        self.assertIn("from profile", pulled[0]["note"])
        self.assertEqual(audit([site], pulled, _grid(0.1), {}, now), [])

        used = expected_kw(site, 3, [{"hour": 3, "load_kwh": 5.0}])
        self.assertEqual(used, (5.0, "usage"))
        pushed = audit([site], [], _grid(0.5), {"aus-0099": [{"hour": 3, "load_kwh": 5.0}]}, now)
        self.assertEqual(pushed[0]["payload"]["signal"], "push")
        self.assertIn("from usage", pushed[0]["note"])

        quiet = _bare(set())
        quiet["agent_dispatch"] = True
        noon = datetime(2026, 9, 25, 10, 0, tzinfo=CENTRAL)
        self.assertEqual(audit([quiet], [], _grid(0.5), {}, noon), [])
        self.assertEqual(quiet["agent_call"]["signal"], "hold")
        self.assertEqual(quiet["agent_call"]["source"], "profile")

    def test_a_code_response_outranks_dispatch(self):
        now = datetime(2026, 9, 25, 3, 0, tzinfo=CENTRAL)
        site = _bare({"disco_meter_delta"})
        site["agent_dispatch"] = True
        rows = audit([site], [], _grid(0.1), {}, now)
        self.assertEqual([row["kind"] for row in rows], ["scheduled_service"])
        self.assertNotIn("price", {row["payload"].get("reason") for row in rows})

    def test_hold_replaces_an_open_price_call(self):
        now = datetime(2026, 9, 25, 10, 0, tzinfo=CENTRAL)
        site = _bare(set())
        site["agent_dispatch"] = True
        rate, _basis = market_rate(_grid(0.5))
        self.assertEqual(rate, 63.0)
        open_push = {
            "id": "push-1",
            "site_id": site["id"],
            "kind": "set_signal",
            "status": "pending",
            "payload": {"signal": "push", "intensity": 1, "reason": "price"},
        }
        rows = audit([site], [open_push], _grid(0.5), {}, now)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["payload"]["signal"], "hold")
        self.assertEqual(site["agent_call"]["signal"], "hold")
