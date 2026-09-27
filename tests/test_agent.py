import json
import random
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch
from zoneinfo import ZoneInfo

from gridsim import config
from gridsim.fleet.actions import market_rate, service_wait_minutes
from gridsim.llm import decide_maintenance
from gridsim.fleet.agent import (
    RESOLUTION,
    audit,
    choose_unit_signal,
    close_model_ticket,
    open_model_tickets,
    day_shape,
    expected_kw,
    record_toggle,
    typical_kw,
)
from gridsim.fleet.charts import CHARTS
from gridsim.fleet.simulate import build_sites, tick_sites
from gridsim.timeutil import iso

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
    def test_resolution_depends_on_the_fault(self):
        self.assertTrue(RESOLUTION["disco_voltage"]["clears"])
        self.assertTrue(RESOLUTION["disco_meter_delta"]["clears"])
        self.assertFalse(RESOLUTION["soc_tracking"]["clears"])
        self.assertFalse(RESOLUTION["dispatch_response"]["clears"])
        self.assertIsNone(RESOLUTION["base_temp"]["reset_min"])
        self.assertNotIn("frequency", RESOLUTION)
        self.assertNotIn("service_min", RESOLUTION["base_temp"])

    def test_an_alarm_opens_one_ticket(self):
        now = datetime(2026, 9, 25, 10, 0, tzinfo=CENTRAL)
        site = _bare({"base_temp", "frequency", "disco_voltage"})
        site["metrics"] = {"base": {"soc_pct": 40, "temp_c": 49.0}, "panel": {"load_kw": 1.2}}
        rows = audit([site], [], _grid(0.5), {}, now)
        by_code = {row["payload"]["chart_id"]: row for row in rows}
        self.assertEqual(set(by_code), {"base_temp", "disco_voltage"})
        voltage = by_code["disco_voltage"]
        self.assertEqual(voltage["kind"], "scheduled_service")
        self.assertEqual(voltage["actor"], "maintenance")
        self.assertEqual(voltage["payload"]["stage"], "reset")
        self.assertEqual(voltage["payload"]["estimate_min"], RESOLUTION["disco_voltage"]["reset_min"])
        thermal = by_code["base_temp"]
        wait = service_wait_minutes(f"{site['id']}:base_temp:{iso(now)}")
        self.assertEqual(thermal["actor"], "llm")
        self.assertEqual(thermal["payload"]["stage"], "ticket")
        self.assertEqual(thermal["payload"]["estimate_min"], wait)
        self.assertGreaterEqual(wait, 45)
        self.assertLessEqual(wait, 240)
        self.assertIn("temp 49.0", thermal["note"])
        self.assertEqual(thermal["payload"]["escalation"][-1]["result"], "reset skipped")
        again = audit([site], rows, _grid(0.5), {}, now)
        self.assertEqual(again, [])

    def test_a_reset_that_clears_closes_the_ticket(self):
        now = datetime(2026, 9, 25, 10, 0, tzinfo=CENTRAL)
        site = _bare({"disco_voltage"})
        site["armed"] = ["disco_voltage"]
        rows = audit([site], [], _grid(0.5), {}, now)
        later = now + timedelta(seconds=15)
        closed = audit([site], rows, _grid(0.5), {}, later)
        self.assertEqual(rows[0]["status"], "done")
        self.assertEqual(
            [item["result"] for item in rows[0]["payload"]["escalation"]],
            ["trying", "cleared"],
        )
        self.assertEqual(rows[0]["payload"]["escalation"][0]["actor"], "maintenance")
        self.assertEqual(site["armed"], [])
        self.assertEqual(closed[0]["kind"], "return_online")

    def test_a_failed_reset_escalates_the_same_ticket(self):
        now = datetime(2026, 9, 25, 10, 0, tzinfo=CENTRAL)
        site = _bare({"soc_tracking"})
        site["metrics"] = {"base": {"soc_pct": 55, "temp_c": 32.0}, "panel": {"load_kw": 0.8}}
        rows = audit([site], [], _grid(0.5), {}, now)
        ticket = rows[0]
        later = now + timedelta(seconds=15)
        extra = audit([site], rows, _grid(0.5), {}, later)
        self.assertEqual(extra, [])
        self.assertEqual(ticket["id"], rows[0]["id"])
        self.assertEqual(ticket["actor"], "llm")
        self.assertEqual(ticket["payload"]["stage"], "ticket")
        wait = service_wait_minutes(f"{site['id']}:soc_tracking:{iso(later)}")
        self.assertEqual(ticket["payload"]["estimate_min"], wait)
        self.assertGreaterEqual(wait, 45)
        self.assertLessEqual(wait, 240)
        self.assertEqual(
            [item["result"] for item in ticket["payload"]["escalation"]],
            ["trying", "did not clear", "reset 15s did not clear"],
        )
        self.assertEqual(ticket["payload"]["escalation"][-1]["actor"], "llm")
        self.assertIn("soc 55", ticket["note"])

    def test_a_model_pull_closes_the_ticket_as_done(self):
        now = datetime(2026, 9, 25, 10, 0, tzinfo=CENTRAL)
        site = _bare({"base_temp"})
        site["armed"] = ["base_temp"]
        site["metrics"] = {"base": {"soc_pct": 40, "temp_c": 49.0}, "panel": {"load_kw": 1.2}}
        rows = audit([site], [], _grid(0.5), {}, now)
        ticket = rows[0]
        spec = next(item for item in CHARTS if item["chart_id"] == "base_temp")
        detail = {
            "id": site["id"],
            "metrics": site["metrics"],
            "charts": [{
                "chart_id": "base_temp",
                "z": 11.286,
                "measured": 49.0,
                "expected": 33.2,
                "action": spec["action"],
            }],
        }
        with patch("gridsim.fleet.agent.decide_maintenance", return_value=None):
            online = close_model_ticket(site, ticket, detail, now)
        self.assertEqual(ticket["status"], "done")
        self.assertEqual(ticket["payload"]["decision"]["result"], "done")
        self.assertEqual(ticket["payload"]["decision"]["action"], spec["action"])
        self.assertNotIn("model", ticket["payload"]["decision"])
        self.assertEqual(ticket["payload"]["pull"]["method"], "GET")
        self.assertEqual(ticket["payload"]["pull"]["path"], "/api/site/aus-0099")
        self.assertEqual(ticket["payload"]["pull"]["evidence"]["z"], 11.286)
        self.assertEqual(ticket["payload"]["escalation"][-1]["result"], "done")
        self.assertEqual(ticket["payload"]["escalation"][-1]["actor"], "llm")
        self.assertEqual(site["armed"], [])
        self.assertEqual(online["kind"], "return_online")
        self.assertIsNone(close_model_ticket(site, ticket, detail, now))

    def test_the_pull_waits_until_ends_at(self):
        now = datetime(2026, 9, 25, 10, 0, tzinfo=CENTRAL)
        site = _bare({"base_temp"})
        site["armed"] = ["base_temp"]
        rows = audit([site], [], _grid(0.5), {}, now)
        self.assertTrue(site["offline"])
        self.assertEqual(open_model_tickets(rows, now), [])
        self.assertEqual(open_model_tickets(rows, now + timedelta(seconds=10)), [])
        end = datetime.fromisoformat(rows[0]["ends_at"])
        self.assertEqual(open_model_tickets(rows, end - timedelta(seconds=1)), [])
        later = open_model_tickets(rows, end)
        self.assertEqual(later[0]["id"], rows[0]["id"])

    def test_service_wait_is_a_clipped_normal(self):
        draws = [service_wait_minutes(str(seed)) for seed in range(80)]
        self.assertTrue(all(45 <= minutes <= 240 for minutes in draws))
        self.assertGreater(sum(draws) / len(draws), 90)
        self.assertLess(sum(draws) / len(draws), 150)

    def test_a_model_reply_is_the_decision(self):
        now = datetime(2026, 9, 25, 10, 0, tzinfo=CENTRAL)
        site = _bare({"base_temp"})
        site["armed"] = ["base_temp"]
        site["metrics"] = {"base": {"soc_pct": 40, "temp_c": 49.0}, "panel": {"load_kw": 1.2}}
        ticket = audit([site], [], _grid(0.5), {}, now)[0]
        spec = next(item for item in CHARTS if item["chart_id"] == "base_temp")
        detail = {
            "id": site["id"],
            "metrics": site["metrics"],
            "charts": [{
                "chart_id": "base_temp",
                "z": 11.286,
                "measured": 49.0,
                "expected": 33.2,
                "action": spec["action"],
            }],
        }
        reply = {
            "result": "done",
            "action": "The cabinet is hot against the expected temperature. Heat does not clear by reboot, so the visit stands.",
            "model": "gpt-4o-mini",
        }
        with patch("gridsim.fleet.agent.decide_maintenance", return_value=reply):
            close_model_ticket(site, ticket, detail, now)
        self.assertEqual(ticket["payload"]["decision"], reply)
        self.assertEqual(ticket["note"], reply["action"])
        self.assertEqual(ticket["payload"]["pull"]["evidence"]["action"], spec["action"])

    def test_decide_maintenance_reads_the_chat_json(self):
        body = {
            "choices": [{
                "message": {
                    "content": json.dumps({
                        "result": "done",
                        "action": "Load is high for this hour. The procedure is a cabinet visit.",
                    }),
                },
            }],
        }

        class _Response:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return json.dumps(body).encode("utf-8")

        with patch.object(config, "OPENAI_API_KEY", "test-key"), patch.object(config, "OPENAI_MODEL", "gpt-4o-mini"), patch(
            "gridsim.llm.urllib.request.urlopen", return_value=_Response()
        ):
            decision = decide_maintenance({"method": "GET", "path": "/api/site/aus-0099", "evidence": {}})
        self.assertEqual(decision["model"], "gpt-4o-mini")
        self.assertEqual(decision["result"], "done")
        self.assertIn("cabinet visit", decision["action"])

        with patch.object(config, "OPENAI_API_KEY", ""):
            self.assertIsNone(decide_maintenance({"method": "GET"}))

    def test_a_warning_posts_nothing(self):
        now = datetime(2026, 9, 25, 10, 0, tzinfo=CENTRAL)
        site = _bare(set(), {"base_temp", "soc_tracking"})
        self.assertEqual(audit([site], [], _grid(0.5), {}, now), [])

    def test_a_toggle_updates_the_ticket_and_keeps_the_steps(self):
        now = datetime(2026, 9, 25, 10, 0, tzinfo=CENTRAL)
        site = _bare(set())
        site["metrics"] = {"base": {"soc_pct": 40, "temp_c": 31.0}, "panel": {"load_kw": 1.1}}
        actions: list[dict] = []
        opened = record_toggle(site, actions, "disco_voltage", True, now)
        self.assertEqual(opened[0]["kind"], "scheduled_service")
        self.assertEqual(
            [item["result"] for item in opened[0]["payload"]["escalation"]],
            ["triggered", "trying"],
        )
        self.assertEqual(opened[0]["payload"]["escalation"][0]["actor"], "api")
        self.assertEqual(record_toggle(site, actions, "frequency", True, now), [])
        self.assertEqual(len(actions), 1)

        again = record_toggle(site, actions, "disco_voltage", True, now)
        self.assertEqual(len([row for row in actions if row["kind"] == "scheduled_service"]), 1)
        self.assertEqual(again[0]["payload"]["escalation"][-1]["result"], "triggered")

        closed = record_toggle(site, actions, "disco_voltage", False, now + timedelta(minutes=1))
        ticket = next(row for row in actions if row["kind"] == "scheduled_service")
        self.assertEqual(ticket["status"], "done")
        self.assertEqual(
            [item["result"] for item in ticket["payload"]["escalation"]],
            ["triggered", "trying", "triggered", "cleared"],
        )
        self.assertEqual(closed[-1]["kind"], "return_online")
        self.assertEqual(ticket["id"], opened[0]["id"])

        later = record_toggle(site, actions, "disco_voltage", True, now + timedelta(minutes=2))
        tickets = [row for row in actions if row["kind"] == "scheduled_service"]
        self.assertEqual(len(tickets), 2)
        self.assertEqual(tickets[0]["payload"]["escalation"][-1]["result"], "cleared")
        self.assertEqual(later[0]["payload"]["escalation"][0]["result"], "triggered")

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
        self.assertEqual(day_shape([
            {"kind": "actual", "ts": "a", "demand_mw": 40},
            {"kind": "actual", "ts": "b", "demand_mw": 70},
            {"kind": "actual", "ts": "c", "demand_mw": 50},
        ], "b")["shape"], "peak")

        now = datetime(2026, 9, 25, 3, 0, tzinfo=CENTRAL)
        site = _bare(set())
        site["agent_dispatch"] = True
        pulled = audit([site], [], _grid(0.1), {}, now)
        self.assertEqual(pulled[0]["actor"], "fleet")
        self.assertEqual(pulled[0]["payload"]["signal"], "pull")
        self.assertEqual(pulled[0]["payload"]["reason"], "price")
        self.assertIn("from profile", pulled[0]["note"])
        self.assertTrue(any(item["threshold"] == "40 $/MWh" for item in pulled[0]["payload"]["because"]))
        self.assertEqual(audit([site], pulled, _grid(0.1), {}, now), [])

        used = expected_kw(site, 3, [{"hour": 3, "load_kwh": 5.0}])
        self.assertEqual(used, (5.0, "usage"))
        pushed = audit([site], [], _grid(0.5), {"aus-0099": [{"hour": 3, "load_kwh": 5.0}]}, now)
        self.assertEqual(pushed[0]["payload"]["signal"], "push")
        self.assertIn("from usage", pushed[0]["note"])
        self.assertTrue(any("1.25" in item["threshold"] for item in pushed[0]["payload"]["because"]))

        quiet = _bare(set())
        quiet["agent_dispatch"] = True
        noon = datetime(2026, 9, 25, 10, 0, tzinfo=CENTRAL)
        self.assertEqual(audit([quiet], [], _grid(0.5), {}, noon), [])
        self.assertEqual(quiet["agent_call"]["signal"], "hold")
        self.assertEqual(quiet["agent_call"]["source"], "profile")

    def test_each_owner_spends_the_day_on_a_different_hour(self):
        from gridsim.fleet.simulate import DAILY_KWH, build_sites

        sites = build_sites(fleet_size=12)
        peaks = set()
        for site in sites:
            self.assertEqual(len(site["hour_kw"]), 24)
            self.assertAlmostEqual(sum(site["hour_kw"]), DAILY_KWH * site["load_scale"], delta=0.05)
            peaks.add(max(range(24), key=lambda hour: site["hour_kw"][hour]))
        self.assertGreater(len(peaks), 1)

        owner = _bare(set())
        owner["agent_dispatch"] = True
        owner["hour_kw"] = [1.0] * 24
        owner["hour_kw"][3] = 4.0
        morning = datetime(2026, 9, 25, 3, 0, tzinfo=CENTRAL)
        pushed = audit([owner], [], _grid(0.5), {}, morning)
        self.assertEqual(pushed[0]["payload"]["signal"], "push")
        self.assertEqual(pushed[0]["payload"].get("reason"), "price")
        self.assertIn("owner average", pushed[0]["note"])
        self.assertEqual(owner["agent_call"]["source"], "profile")

    def test_a_code_response_outranks_dispatch(self):
        now = datetime(2026, 9, 25, 3, 0, tzinfo=CENTRAL)
        site = _bare({"disco_meter_delta"})
        site["agent_dispatch"] = True
        rows = audit([site], [], _grid(0.1), {}, now)
        self.assertEqual([row["kind"] for row in rows], ["scheduled_service"])
        self.assertEqual(rows[0]["payload"]["stage"], "reset")
        self.assertEqual(rows[0]["payload"]["because"][0]["threshold"], "±3σ")
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
