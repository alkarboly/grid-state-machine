import random
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from gridsim.fleet.actions import apply_actions, market_rate, new_action
from gridsim.fleet.simulate import build_sites, tick_sites

CENTRAL = ZoneInfo("America/Chicago")
ROOT = Path(__file__).resolve().parents[1]


def _grid(percentile: float) -> dict:
    return {
        "demand_mw": 70000,
        "demand_percentile": percentile,
        "storage_gen_mw": 0.0,
        "prices": [],
    }


class ActionTests(unittest.TestCase):
    def test_scheduled_service_returns_the_base_online(self):
        now = datetime(2026, 9, 25, 13, 0, tzinfo=CENTRAL)
        site = build_sites(fleet_size=40)[0]
        site["chart_history"] = {}
        action = new_action(site["id"], "scheduled_service", now, actor="api")
        self.assertIsNotNone(action["ends_at"])
        apply_actions([site], [action], now)
        updated, _logs, _obs, _points = tick_sites([site], _grid(0.9), now, 0.25, random.Random(1))
        base = updated[0]["metrics"]["base"]
        self.assertEqual(base["availability"], "offline")
        self.assertEqual(base["charge_kw"], 0.0)
        self.assertEqual(base["discharge_kw"], 0.0)
        self.assertEqual(action["status"], "active")

        later = now + timedelta(hours=3)
        created = apply_actions(updated, [action], later)
        self.assertEqual(action["status"], "done")
        self.assertEqual(created[0]["kind"], "return_online")
        self.assertNotIn("offline", updated[0])

    def test_solar_feeds_the_house_and_the_battery(self):
        now = datetime(2026, 9, 25, 13, 0, tzinfo=CENTRAL)
        raw = build_sites(fleet_size=40)[0]
        bare = dict(raw, chart_history={}, addons=[])
        sunny = dict(raw, chart_history={}, addons=["solar"], physical_soc_kwh=raw["physical_soc_kwh"])
        plain, *_ = tick_sites([bare], _grid(0.5), now, 0.25, random.Random(2))
        fed, *_ = tick_sites([sunny], _grid(0.5), now, 0.25, random.Random(2))
        addon = fed[0]["metrics"]["disco"]["addons"][0]
        self.assertEqual(addon["addon_id"], "solar")
        self.assertGreater(addon["kw"], 1.0)
        self.assertGreaterEqual(fed[0]["physical_soc_kwh"], plain[0]["physical_soc_kwh"] - 0.001)
        self.assertEqual(
            fed[0]["metrics"]["base"]["charge_kw"],
            plain[0]["metrics"]["base"]["charge_kw"],
        )

    def test_car_charger_adds_load_at_the_disco(self):
        now = datetime(2026, 9, 25, 19, 0, tzinfo=CENTRAL)
        raw = build_sites(fleet_size=40)[0]
        bare = dict(raw, chart_history={}, addons=[])
        charging = dict(raw, chart_history={}, addons=["ev_charger"])
        plain, *_ = tick_sites([bare], _grid(0.5), now, 0.0, random.Random(3))
        loaded, *_ = tick_sites([charging], _grid(0.5), now, 0.0, random.Random(3))
        addon = loaded[0]["metrics"]["disco"]["addons"][0]
        self.assertEqual(addon["addon_id"], "ev_charger")
        self.assertGreater(addon["kw"], 5.0)

        def net(site):
            grid = site["metrics"]["grid"]
            return grid["in_kw"] - grid["out_kw"]

        self.assertGreater(net(loaded[0]), net(plain[0]) + 4.0)

    def test_market_rate_is_simulated_without_a_price(self):
        rate, basis = market_rate({"demand_percentile": 0.5, "prices": []})
        self.assertEqual((rate, basis), (63.0, "simulated"))
        rate, basis = market_rate({"prices": [{"location": "LZ_HOUSTON", "lmp": 42.0}]})
        self.assertEqual(basis, "ercot")
        self.assertEqual(rate, 42.0)

    def test_migrations_define_the_controller_tables(self):
        folder = ROOT / "supabase" / "migrations"
        text = "\n".join(path.read_text(encoding="utf-8") for path in sorted(folder.glob("*.sql")))
        for name in (
            "market_ticks",
            "unit_latest",
            "usage_hours",
            "unit_actions",
            "addon_catalog",
            "site_addons",
            "dispatch_orders",
            "dispatch_ticks",
        ):
            self.assertIn(f"create table if not exists {name}", text)
