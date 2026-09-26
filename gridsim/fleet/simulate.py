"""One tick of one battery. Field names match docs/contracts.md and docs/control-charts.md."""

from __future__ import annotations

import json
import math
import random
from pathlib import Path

from gridsim import config
from gridsim.fleet.charts import CHARTS, HISTORY, evaluate
from gridsim.fleet.policy import choose_signal, intensity
from gridsim.timeutil import iso

# Late-summer central-air hour means, kW. Daily sum is about 54 kWh before load_scale.
HOUR_MEAN_KW = [
    1.15, 1.05, 0.98, 0.95, 0.95, 1.10,
    1.55, 1.90, 1.70, 1.65, 1.80, 2.20,
    2.70, 3.15, 3.50, 3.75, 3.90, 4.05,
    4.20, 3.70, 2.90, 2.20, 1.70, 1.35,
]

# Measured faults. The site row keeps the healthy baseline; the tick applies these.
FAULTS = {
    "aus-03": {"temp_c": 49.0},
    "hou-02": {"voltage_v": 226.0, "disco_bias_kw": 1.4},
    "sat-01": {"soc_bias_kwh": 2.5},
    "dal-02": {"response_scale": 0.55},
}

COMPONENTS = ("grid", "meter", "disco", "panel", "base", "maintenance")

OBSERVATION_FIELDS = (
    "hour",
    "demand_mw",
    "demand_percentile",
    "storage_gen_mw",
    "lmp_usd_mwh",
    "signal",
    "grid_in_kw",
    "grid_out_kw",
    "meter_in_kw",
    "meter_out_kw",
    "meter_voltage_v",
    "energy_in_kwh",
    "energy_out_kwh",
    "disco_in_kw",
    "disco_out_kw",
    "disco_voltage_v",
    "frequency_hz",
    "contactor",
    "islanded",
    "load_kw",
    "panel_voltage_v",
    "physical_soc_kwh",
    "soc_kwh",
    "soc_pct",
    "commanded_charge_kw",
    "commanded_discharge_kw",
    "charge_kw",
    "discharge_kw",
    "temp_c",
)


def load_anchors(path: Path | None = None) -> list[dict]:
    target = path or (config.DATA / "anchors.json")
    return json.loads(target.read_text(encoding="utf-8"))


def build_sites(anchors: list[dict] | None = None) -> list[dict]:
    profile = random.Random(11)
    sites = []
    for anchor in anchors or load_anchors():
        count = int(anchor["count"])
        # Service-territory rings so each battery reads as its own node and
        # neighbouring cities do not overlap.
        inner = count if count <= 6 else count // 2
        single = count <= 6
        for index in range(count):
            number = index + 1
            site_id = f"{anchor['prefix']}-{number:02d}"
            on_inner = index < inner
            spokes = inner if on_inner else count - inner
            radius = (0.36 if single else 0.30) if on_inner else 0.55
            angle = 2 * math.pi * ((index if on_inner else index - inner) / spokes)
            if not on_inner:
                angle += math.pi / spokes
            sites.append(
                {
                    "id": site_id,
                    "city": anchor["name"],
                    "label": anchor.get("label", "n"),
                    "load_zone": anchor["load_zone"],
                    "lat": anchor["lat"] + radius * math.cos(angle) * 0.8,
                    "lon": anchor["lon"] + radius * math.sin(angle),
                    "capacity_kwh": config.BASE_CAPACITY_KWH,
                    "power_limit_kw": config.BASE_POWER_KW,
                    "load_scale": round(0.72 + profile.random() * 0.56, 3),
                    "temp_center_c": round(29.0 + profile.random() * 6.0, 2),
                    "temp_sigma_c": round(1.15 + profile.random() * 0.7, 3),
                    "voltage_center_v": round(237.0 + profile.random() * 6.0, 2),
                    "voltage_sigma_v": round(1.1 + profile.random() * 0.6, 3),
                    "eta": round(0.94 + profile.random() * 0.035, 4),
                    "physical_soc_kwh": config.BASE_CAPACITY_KWH * (0.55 + ((number * 5 + len(site_id)) % 35) / 100),
                    "energy_in_kwh": 0.0,
                    "energy_out_kwh": 0.0,
                    "chart_history": {},
                }
            )
    return sites


def _split(net_kw: float) -> tuple[float, float]:
    if net_kw >= 0:
        return net_kw, 0.0
    return 0.0, -net_kw


def _chart(site: dict, spec: dict, measured: float, expected: float, sigma: float | None) -> dict:
    history = site["chart_history"].setdefault(spec["chart_id"], [])
    point = evaluate(spec, measured, expected, sigma if sigma is not None else spec["sigma"], history)
    history.append(point["value"])
    del history[:-HISTORY]
    point["series"] = list(history)
    return point


def tick_sites(sites: list[dict], grid: dict, now, dt_hours: float, rng: random.Random | None = None):
    rng = rng or random.Random()
    prices = grid.get("prices") or []
    lmp_mean = sum(item["lmp"] for item in prices) / len(prices) if prices else None
    by_location = {item["location"]: item["lmp"] for item in prices}

    updated = []
    logs = []
    observations = []
    points = []
    stamp = iso(now)
    hour = now.hour
    percentile = float(grid.get("demand_percentile") or 0.5)
    storage = grid.get("storage_gen_mw")
    scale = 0.85 + 0.30 * percentile
    dt = max(dt_hours, 0.0)

    for raw_site in sites:
        site = dict(raw_site)
        site["chart_history"] = raw_site["chart_history"]
        fault = FAULTS.get(site["id"], {})
        eta = site["eta"]
        lmp = by_location.get(site["load_zone"])
        signal = choose_signal(percentile, storage, lmp, lmp_mean)
        level = intensity(signal, percentile)
        mean_kw = HOUR_MEAN_KW[hour] * site["load_scale"]
        load_kw = max(0.3, mean_kw * scale + rng.gauss(0, mean_kw * 0.04))

        command = site["power_limit_kw"] * level
        floor = site["capacity_kwh"] * config.SOC_RESERVE
        ceiling = site["capacity_kwh"] * config.SOC_CEILING
        commanded_charge = 0.0
        commanded_discharge = 0.0
        if signal == "push":
            headroom_kw = max(0.0, (site["physical_soc_kwh"] - floor) * eta / dt) if dt else command
            commanded_discharge = min(command, headroom_kw)
        elif signal == "pull":
            room_kw = max(0.0, (ceiling - site["physical_soc_kwh"]) / (eta * dt)) if dt else command
            commanded_charge = min(command, room_kw)

        response = float(fault.get("response_scale", 1.0))
        charge_kw = commanded_charge * response
        discharge_kw = commanded_discharge * response

        if dt:
            site["physical_soc_kwh"] = min(
                ceiling,
                max(floor, site["physical_soc_kwh"] + charge_kw * dt * eta - discharge_kw * dt / eta),
            )
        reported_soc = site["physical_soc_kwh"] + float(fault.get("soc_bias_kwh", 0.0)) + rng.gauss(0, 0.04)

        true_net = load_kw + charge_kw - discharge_kw
        grid_in, grid_out = _split(true_net)
        meter_in, meter_out = _split(true_net + rng.gauss(0, 0.02))
        disco_bias = float(fault.get("disco_bias_kw", 0.0))
        disco_in, disco_out = _split(true_net + disco_bias + rng.gauss(0, 0.06))
        site["energy_in_kwh"] += meter_in * dt
        site["energy_out_kwh"] += meter_out * dt

        expected_temp = site["temp_center_c"] + 4.0 * level
        temp_c = float(fault["temp_c"]) if "temp_c" in fault else expected_temp + rng.gauss(0, 0.35)
        expected_voltage = site["voltage_center_v"]
        disco_voltage = float(fault["voltage_v"]) if "voltage_v" in fault else expected_voltage + rng.gauss(0, 0.45)
        meter_voltage = expected_voltage + rng.gauss(0, 0.25)
        frequency = 60.0 + rng.gauss(0, 0.008)

        meter_net = meter_in - meter_out
        disco_net = disco_in - disco_out
        commanded_net = commanded_discharge - commanded_charge
        achieved_net = discharge_kw - charge_kw

        charts = [
            _chart(site, CHARTS[0], disco_net - meter_net, 0.0, None),
            _chart(site, CHARTS[1], temp_c, expected_temp, site["temp_sigma_c"]),
            _chart(site, CHARTS[2], disco_voltage, expected_voltage, site["voltage_sigma_v"]),
            _chart(site, CHARTS[3], frequency, 60.0, None),
            _chart(site, CHARTS[4], reported_soc, site["physical_soc_kwh"], None),
            _chart(site, CHARTS[5], achieved_net, commanded_net, None),
        ]
        alarm = any(not chart["in_control"] for chart in charts)
        shown_soc = min(site["capacity_kwh"], max(0.0, reported_soc))

        metrics = {
            "grid": {
                "in_kw": round(grid_in, 3),
                "out_kw": round(grid_out, 3),
                "demand_mw": grid.get("demand_mw"),
                "demand_percentile": round(percentile, 4),
                "storage_gen_mw": storage,
                "lmp_usd_mwh": lmp,
                "signal": signal,
                "grid_as_of": grid.get("as_of"),
            },
            "meter": {
                "in_kw": round(meter_in, 3),
                "out_kw": round(meter_out, 3),
                "voltage_v": round(meter_voltage, 2),
                "energy_in_kwh": round(site["energy_in_kwh"], 4),
                "energy_out_kwh": round(site["energy_out_kwh"], 4),
            },
            "disco": {
                "in_kw": round(disco_in, 3),
                "out_kw": round(disco_out, 3),
                "voltage_v": round(disco_voltage, 2),
                "frequency_hz": round(frequency, 3),
                "contactor": "closed",
                "islanded": False,
            },
            "panel": {
                "load_kw": round(load_kw, 3),
                "voltage_v": round(meter_voltage, 2),
            },
            "base": {
                "capacity_kwh": site["capacity_kwh"],
                "power_limit_kw": site["power_limit_kw"],
                "soc_kwh": round(shown_soc, 3),
                "soc_pct": round(100.0 * shown_soc / site["capacity_kwh"], 1),
                "commanded_charge_kw": round(commanded_charge, 3),
                "commanded_discharge_kw": round(commanded_discharge, 3),
                "charge_kw": round(charge_kw, 3),
                "discharge_kw": round(discharge_kw, 3),
                "temp_c": round(temp_c, 2),
            },
            "maintenance": {
                "alarm": alarm,
                "out_of_control": [chart["chart_id"] for chart in charts if not chart["in_control"]],
                "warning": [chart["chart_id"] for chart in charts if chart["warning"]],
            },
        }
        observation = {
            "ts": stamp,
            "site_id": site["id"],
            "hour": hour,
            "demand_mw": grid.get("demand_mw"),
            "demand_percentile": round(percentile, 4),
            "storage_gen_mw": storage,
            "lmp_usd_mwh": lmp,
            "signal": signal,
            "grid_in_kw": round(grid_in, 3),
            "grid_out_kw": round(grid_out, 3),
            "meter_in_kw": round(meter_in, 3),
            "meter_out_kw": round(meter_out, 3),
            "meter_voltage_v": round(meter_voltage, 2),
            "energy_in_kwh": round(site["energy_in_kwh"], 4),
            "energy_out_kwh": round(site["energy_out_kwh"], 4),
            "disco_in_kw": round(disco_in, 3),
            "disco_out_kw": round(disco_out, 3),
            "disco_voltage_v": round(disco_voltage, 2),
            "frequency_hz": round(frequency, 3),
            "contactor": "closed",
            "islanded": 0,
            "load_kw": round(load_kw, 3),
            "panel_voltage_v": round(meter_voltage, 2),
            "physical_soc_kwh": round(site["physical_soc_kwh"], 4),
            "soc_kwh": round(shown_soc, 3),
            "soc_pct": round(100.0 * shown_soc / site["capacity_kwh"], 1),
            "commanded_charge_kw": round(commanded_charge, 3),
            "commanded_discharge_kw": round(commanded_discharge, 3),
            "charge_kw": round(charge_kw, 3),
            "discharge_kw": round(discharge_kw, 3),
            "temp_c": round(temp_c, 2),
        }
        site["metrics"] = metrics
        site["charts"] = charts
        site["signal"] = signal
        site["alarm"] = alarm
        updated.append(site)
        observations.append(observation)
        for chart in charts:
            stored = {key: value for key, value in chart.items() if key != "series"}
            stored["ts"] = stamp
            stored["site_id"] = site["id"]
            points.append(stored)
        for component in COMPONENTS:
            logs.append(
                {
                    "ts": stamp,
                    "site_id": site["id"],
                    "component": component,
                    "metrics": metrics[component],
                }
            )
    return updated, logs, observations, points
