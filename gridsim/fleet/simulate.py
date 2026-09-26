"""One tick of the home chain. Field names match docs/contracts.md."""

from __future__ import annotations

import json
import random
from pathlib import Path

from gridsim import config
from gridsim.fleet.policy import choose_signal, intensity
from gridsim.timeutil import iso

# Late-summer central-air hour means, kW. Daily sum is about 54 kWh.
HOUR_MEAN_KW = [
    1.15, 1.05, 0.98, 0.95, 0.95, 1.10,
    1.55, 1.90, 1.70, 1.65, 1.80, 2.20,
    2.70, 3.15, 3.50, 3.75, 3.90, 4.05,
    4.20, 3.70, 2.90, 2.20, 1.70, 1.35,
]

NORMALS = {
    "disco_meter_delta_kw": (0.0, 0.08),
    "base_temp_c": (32.0, 3.0),
    "disco_voltage_v": (240.0, 2.0),
}

FAULTS = {
    "aus-03": {"temp_c": 49.0},
    "hou-02": {"voltage_v": 226.0, "disco_bias_kw": 1.4},
}

COMPONENTS = ("grid", "meter", "disco", "panel", "base", "maintenance")


def load_anchors(path: Path | None = None) -> list[dict]:
    target = path or (config.DATA / "anchors.json")
    return json.loads(target.read_text(encoding="utf-8"))


def build_sites(anchors: list[dict] | None = None) -> list[dict]:
    rng = random.Random(7)
    sites = []
    for anchor in anchors or load_anchors():
        for index in range(int(anchor["count"])):
            number = index + 1
            site_id = f"{anchor['prefix']}-{number:02d}"
            span = 0.04 + (number % 5) * 0.03
            sites.append(
                {
                    "id": site_id,
                    "city": anchor["name"],
                    "load_zone": anchor["load_zone"],
                    "lat": anchor["lat"] + rng.uniform(-span, span),
                    "lon": anchor["lon"] + rng.uniform(-span, span),
                    "capacity_kwh": config.BASE_CAPACITY_KWH,
                    "power_limit_kw": config.BASE_POWER_KW,
                    "soc_kwh": config.BASE_CAPACITY_KWH * (0.55 + ((number * 5 + len(site_id)) % 35) / 100),
                    "energy_in_kwh": 0.0,
                    "energy_out_kwh": 0.0,
                }
            )
    return sites


def _z(metric: str, value: float) -> float:
    mean, std = NORMALS[metric]
    return (value - mean) / std


def _split(net_kw: float) -> tuple[float, float]:
    if net_kw >= 0:
        return net_kw, 0.0
    return 0.0, -net_kw


def tick_sites(sites: list[dict], grid: dict, now, dt_hours: float, rng: random.Random | None = None) -> tuple[list[dict], list[dict]]:
    rng = rng or random.Random()
    prices = grid.get("prices") or []
    lmp_mean = None
    if prices:
        lmp_mean = sum(item["lmp"] for item in prices) / len(prices)
    by_location = {item["location"]: item["lmp"] for item in prices}

    updated = []
    logs = []
    stamp = iso(now)
    hour = now.hour
    percentile = float(grid.get("demand_percentile") or 0.5)
    storage = grid.get("storage_gen_mw")
    scale = 0.85 + 0.30 * percentile
    dt = max(dt_hours, 0.0)

    for site in sites:
        site = dict(site)
        fault = FAULTS.get(site["id"], {})
        lmp = by_location.get(site["load_zone"])
        signal = choose_signal(percentile, storage, lmp, lmp_mean)
        level = intensity(signal, percentile)
        load_kw = max(0.3, HOUR_MEAN_KW[hour] * scale + rng.gauss(0, HOUR_MEAN_KW[hour] * 0.04))

        command = site["power_limit_kw"] * level
        floor = site["capacity_kwh"] * config.SOC_RESERVE
        ceiling = site["capacity_kwh"] * config.SOC_CEILING
        charge_kw = 0.0
        discharge_kw = 0.0
        if signal == "push":
            headroom_kw = max(0.0, (site["soc_kwh"] - floor) * config.ETA / dt) if dt else command
            discharge_kw = min(command, headroom_kw)
        elif signal == "pull":
            room_kw = max(0.0, (ceiling - site["soc_kwh"]) / (config.ETA * dt)) if dt else command
            charge_kw = min(command, room_kw)

        if dt:
            site["soc_kwh"] = min(
                ceiling,
                max(floor, site["soc_kwh"] + charge_kw * dt * config.ETA - discharge_kw * dt / config.ETA),
            )

        true_net = load_kw + charge_kw - discharge_kw
        grid_in, grid_out = _split(true_net)
        meter_in, meter_out = _split(true_net + rng.gauss(0, 0.02))
        disco_bias = float(fault.get("disco_bias_kw", 0.0))
        disco_in, disco_out = _split(true_net + disco_bias + rng.gauss(0, 0.06))
        site["energy_in_kwh"] += meter_in * dt
        site["energy_out_kwh"] += meter_out * dt

        temp_c = float(fault.get("temp_c", 32.0 + 4.0 * level + rng.gauss(0, 0.4)))
        disco_voltage = float(fault.get("voltage_v", 240.0 + rng.gauss(0, 0.6)))
        meter_voltage = 240.0 + rng.gauss(0, 0.4)

        delta = (disco_in - disco_out) - (meter_in - meter_out)
        scores = {
            "disco_meter_delta_z": _z("disco_meter_delta_kw", delta),
            "base_temp_z": _z("base_temp_c", temp_c),
            "disco_voltage_z": _z("disco_voltage_v", disco_voltage),
        }
        alarm = any(abs(value) >= config.ALARM_Z for value in scores.values())

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
                "frequency_hz": round(60.0 + rng.gauss(0, 0.01), 3),
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
                "soc_kwh": round(site["soc_kwh"], 3),
                "soc_pct": round(100.0 * site["soc_kwh"] / site["capacity_kwh"], 1),
                "charge_kw": round(charge_kw, 3),
                "discharge_kw": round(discharge_kw, 3),
                "temp_c": round(temp_c, 2),
            },
            "maintenance": {
                "disco_meter_delta_kw": round(delta, 3),
                "disco_meter_delta_z": round(scores["disco_meter_delta_z"], 2),
                "base_temp_c": round(temp_c, 2),
                "base_temp_z": round(scores["base_temp_z"], 2),
                "disco_voltage_v": round(disco_voltage, 2),
                "disco_voltage_z": round(scores["disco_voltage_z"], 2),
                "alarm": alarm,
            },
        }
        site["metrics"] = metrics
        site["signal"] = signal
        site["alarm"] = alarm
        updated.append(site)
        for component in COMPONENTS:
            logs.append(
                {
                    "ts": stamp,
                    "site_id": site["id"],
                    "component": component,
                    "metrics": metrics[component],
                }
            )
    return updated, logs
