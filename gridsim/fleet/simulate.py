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

# Named demo faults, one per maintenance kind. The site row keeps the healthy
# baseline; the tick applies these. Every other unit draws a fault at FAULT_RATE.
DEMO_FAULTS = {
    "aus-0003": {"temp_c": 49.0},
    "hou-0002": {"voltage_v": 226.0, "disco_bias_kw": 1.4},
    "sat-0001": {"soc_bias_kwh": 2.5},
    "dal-0002": {"response_scale": 0.55},
}
FAULT_RATE = 0.015

KM_PER_DEG_LAT = 110.574
TAU = 2.0 * math.pi

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


def apportion(total: int, weights: list[float], minimum: int = 2) -> list[int]:
    """Largest remainder, so the metro counts sum to exactly `total`."""
    size = len(weights)
    if size == 0:
        return []
    minimum = min(minimum, max(total // size, 0))
    remaining = total - minimum * size
    if remaining <= 0:
        return [total // size + (1 if index < total % size else 0) for index in range(size)]
    share = sum(weights) or float(size)
    exact = [weight / share * remaining for weight in weights]
    counts = [int(value) for value in exact]
    order = sorted(range(size), key=lambda index: exact[index] - counts[index], reverse=True)
    for index in order[: remaining - sum(counts)]:
        counts[index] += 1
    return [minimum + count for count in counts]


def _place(anchor: dict, rng: random.Random) -> tuple[float, float]:
    """Rayleigh radius, so density peaks in the suburbs rather than downtown."""
    scale = float(anchor.get("radius_km", 15.0))
    radius = min(scale * math.sqrt(-2.0 * math.log(1.0 - rng.random())), scale * 2.8)
    angle = rng.random() * TAU
    axis = math.radians(float(anchor.get("axis_deg", 0.0)))
    major = radius * math.cos(angle) * float(anchor.get("stretch", 1.0))
    minor = radius * math.sin(angle)
    east = major * math.cos(axis) - minor * math.sin(axis)
    north = major * math.sin(axis) + minor * math.cos(axis)
    lat = anchor["lat"] + north / KM_PER_DEG_LAT
    lon = anchor["lon"] + east / (KM_PER_DEG_LAT * math.cos(math.radians(anchor["lat"])))
    return round(lat, 5), round(lon, 5)


def _fault(site_id: str, rng: random.Random, voltage_center: float) -> dict:
    if site_id in DEMO_FAULTS:
        return dict(DEMO_FAULTS[site_id])
    if rng.random() >= FAULT_RATE:
        return {}
    kind = rng.choice(("temp_c", "voltage_v", "soc_bias_kwh", "response_scale", "disco_bias_kw"))
    if kind == "temp_c":
        return {"temp_c": round(44.0 + rng.random() * 9.0, 1)}
    if kind == "voltage_v":
        return {"voltage_v": round(voltage_center - (8.0 + rng.random() * 8.0), 1)}
    if kind == "soc_bias_kwh":
        return {"soc_bias_kwh": round(1.6 + rng.random() * 2.4, 2)}
    if kind == "response_scale":
        return {"response_scale": round(0.35 + rng.random() * 0.35, 2)}
    return {"disco_bias_kw": round(0.8 + rng.random() * 1.2, 2)}


def build_sites(anchors: list[dict] | None = None, fleet_size: int | None = None) -> list[dict]:
    anchors = anchors or load_anchors()
    total = config.FLEET_SIZE if fleet_size is None else fleet_size
    weights = [
        float(anchor.get("households_k", 1)) * float(anchor.get("adoption", 1.0))
        for anchor in anchors
    ]
    counts = apportion(total, weights)
    sites = []
    for anchor, count in zip(anchors, counts):
        for number in range(1, count + 1):
            site_id = f"{anchor['prefix']}-{number:04d}"
            # Seeded per unit, so a restart puts every battery back where it was.
            profile = random.Random(site_id)
            lat, lon = _place(anchor, profile)
            voltage_center = round(237.0 + profile.random() * 6.0, 2)
            sites.append(
                {
                    "id": site_id,
                    "city": anchor["name"],
                    "metro": anchor["id"],
                    "load_zone": anchor["load_zone"],
                    "lat": lat,
                    "lon": lon,
                    "capacity_kwh": config.BASE_CAPACITY_KWH,
                    "power_limit_kw": config.BASE_POWER_KW,
                    "load_scale": round(0.72 + profile.random() * 0.56, 3),
                    "temp_center_c": round(29.0 + profile.random() * 6.0, 2),
                    "temp_sigma_c": round(1.15 + profile.random() * 0.7, 3),
                    "voltage_center_v": voltage_center,
                    "voltage_sigma_v": round(1.1 + profile.random() * 0.6, 3),
                    "eta": round(0.94 + profile.random() * 0.035, 4),
                    # The customer's own backup floor, and where this unit sits in
                    # the dispatch queue. Together they decide who answers a call.
                    "reserve_frac": round(config.SOC_RESERVE + profile.random() * 0.25, 3),
                    "duty": round(profile.random(), 3),
                    "fault": _fault(site_id, profile, voltage_center),
                    "physical_soc_kwh": round(
                        config.BASE_CAPACITY_KWH * (0.22 + profile.random() * 0.70), 3
                    ),
                    "energy_in_kwh": 0.0,
                    "energy_out_kwh": 0.0,
                    "chart_history": {},
                }
            )
    return sites


def metro_summary(anchors: list[dict], sites: list[dict]) -> list[dict]:
    counts: dict[str, int] = {}
    for site in sites:
        counts[site["metro"]] = counts.get(site["metro"], 0) + 1
    return [
        {
            "id": anchor["id"],
            "name": anchor["name"],
            "lat": anchor["lat"],
            "lon": anchor["lon"],
            "load_zone": anchor["load_zone"],
            "label": anchor.get("label", "n"),
            "radius_km": anchor.get("radius_km", 15),
            "units": counts.get(anchor["id"], 0),
        }
        for anchor in anchors
        if counts.get(anchor["id"], 0)
    ]


def _split(net_kw: float) -> tuple[float, float]:
    if net_kw >= 0:
        return net_kw, 0.0
    return 0.0, -net_kw


def _chart(site: dict, spec: dict, measured: float, expected: float, sigma: float | None) -> dict:
    """The recent residuals stay on the site as chart_history; the API attaches them."""
    history = site["chart_history"].setdefault(spec["chart_id"], [])
    point = evaluate(spec, measured, expected, sigma if sigma is not None else spec["sigma"], history)
    history.append(point["value"])
    del history[:-HISTORY]
    return point


def tick_sites(
    sites: list[dict],
    grid: dict,
    now,
    dt_hours: float,
    rng: random.Random | None = None,
    persist: set[str] | None = None,
):
    """Advance every battery. `persist` limits which units emit full-rate rows."""
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
        fault = site["fault"]
        eta = site["eta"]
        lmp = by_location.get(site["load_zone"])
        signal = choose_signal(percentile, storage, lmp, lmp_mean)
        level = intensity(signal, percentile)
        mean_kw = HOUR_MEAN_KW[hour] * site["load_scale"]
        load_kw = max(0.3, mean_kw * scale + rng.gauss(0, mean_kw * 0.04))

        command = site["power_limit_kw"] * level
        floor = site["capacity_kwh"] * site["reserve_frac"]
        ceiling = site["capacity_kwh"] * config.SOC_CEILING
        commanded_charge = 0.0
        commanded_discharge = 0.0
        # A call only reaches units whose place in the queue the call is deep enough to
        # reach, and only as far as the customer's own reserve allows.
        on_call = level >= site["duty"]
        if on_call and signal == "push":
            headroom_kw = (site["physical_soc_kwh"] - floor) * eta
            commanded_discharge = min(command, max(0.0, headroom_kw / dt) if dt else command)
            if site["physical_soc_kwh"] <= floor:
                commanded_discharge = 0.0
        elif on_call and signal == "pull":
            room_kw = ceiling - site["physical_soc_kwh"]
            commanded_charge = min(command, max(0.0, room_kw / (eta * dt)) if dt else command)
            if site["physical_soc_kwh"] >= ceiling:
                commanded_charge = 0.0

        response = float(fault.get("response_scale", 1.0))
        charge_kw = commanded_charge * response
        discharge_kw = commanded_discharge * response

        if dt:
            site["physical_soc_kwh"] = min(
                ceiling,
                max(0.0, site["physical_soc_kwh"] + charge_kw * dt * eta - discharge_kw * dt / eta),
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
        alarm = any(chart["alarm"] for chart in charts)
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
                "alarming": [chart["chart_id"] for chart in charts if chart["alarm"]],
                "out_of_control": [chart["chart_id"] for chart in charts if not chart["in_control"]],
                "warning": [chart["chart_id"] for chart in charts if chart["warning"]],
            },
        }
        site["metrics"] = metrics
        site["charts"] = charts
        site["signal"] = signal
        site["alarm"] = alarm
        # What the battery actually did, which is not always what it was told.
        if discharge_kw > 0.01:
            site["state"] = "push"
        elif charge_kw > 0.01:
            site["state"] = "pull"
        else:
            site["state"] = "hold"
        updated.append(site)

        for chart in charts:
            if chart["in_control"] and persist is not None and site["id"] not in persist:
                continue
            stored = dict(chart)
            stored["ts"] = stamp
            stored["site_id"] = site["id"]
            points.append(stored)

        if persist is not None and site["id"] not in persist:
            continue

        for component in COMPONENTS:
            logs.append(
                {
                    "ts": stamp,
                    "site_id": site["id"],
                    "component": component,
                    "metrics": metrics[component],
                }
            )
        observations.append({
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
        })
    return updated, logs, observations, points
