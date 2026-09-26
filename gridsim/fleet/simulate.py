"""One tick of one battery. Field names match docs/contracts.md and docs/control-charts.md."""

from __future__ import annotations

import json
import math
import random
import re
from pathlib import Path

from gridsim import config
from gridsim.fleet.charts import CHARTS, HISTORY, evaluate
from gridsim.fleet.policy import choose_signal, intensity, resolve_order
from gridsim.timeutil import iso

# Late-summer central-air hour means, kW. Daily sum is about 54 kWh before load_scale.
HOUR_MEAN_KW = [
    1.15, 1.05, 0.98, 0.95, 0.95, 1.10,
    1.55, 1.90, 1.70, 1.65, 1.80, 2.20,
    2.70, 3.15, 3.50, 3.75, 3.90, 4.05,
    4.20, 3.70, 2.90, 2.20, 1.70, 1.35,
]

# Named demo faults, one cabinet per maintenance kind. The site row keeps the
# healthy baseline; the tick applies these. A few more of each kind are placed
# across the fleet so every failure mode is visible without flooding the map.
DEMO_FAULTS = {
    "aus-0003": {"temp_c": 49.0},
    "hou-0002": {"voltage_v": 226.0, "disco_bias_kw": 1.4},
    "sat-0001": {"soc_bias_kwh": 2.5},
    "dal-0002": {"response_scale": 0.55},
}
FAULT_KINDS = ("temp_c", "voltage_v", "soc_bias_kwh", "response_scale", "disco_bias_kw")
EXTRAS_PER_KIND = 2

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


def _texas_ring() -> list[tuple[float, float]]:
    """The same outline the map draws, so a battery cannot sit past the border."""
    text = (config.WEB / "geo.js").read_text(encoding="utf-8")
    block = text.split("export const TEXAS = [", 1)[1].split("];", 1)[0]
    return [(float(lat), float(lon)) for lat, lon in re.findall(r"\[\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*\]", block)]


_TEXAS: list[tuple[float, float]] | None = None


def inside_texas(lat: float, lon: float) -> bool:
    """Even-odd ray cast against the map outline. The Gulf fails this."""
    global _TEXAS
    if _TEXAS is None:
        _TEXAS = _texas_ring()
    inside = False
    previous_lat, previous_lon = _TEXAS[-1]
    for point_lat, point_lon in _TEXAS:
        if (point_lon > lon) != (previous_lon > lon):
            edge = (previous_lat - point_lat) * (lon - point_lon) / (previous_lon - point_lon) + point_lat
            if lat < edge:
                inside = not inside
        previous_lat, previous_lon = point_lat, point_lon
    return inside


def _shift(lat: float, lon: float, north_km: float, east_km: float) -> tuple[float, float]:
    return (
        lat + north_km / KM_PER_DEG_LAT,
        lon + east_km / (KM_PER_DEG_LAT * math.cos(math.radians(lat))),
    )


def _km(lat_a: float, lon_a: float, lat_b: float, lon_b: float) -> float:
    north = (lat_a - lat_b) * KM_PER_DEG_LAT
    east = (lon_a - lon_b) * KM_PER_DEG_LAT * math.cos(math.radians((lat_a + lat_b) / 2.0))
    return math.hypot(north, east)


def _rayleigh(anchor: dict, rng: random.Random, scale_km: float, cap: float) -> tuple[float, float]:
    radius = min(scale_km * math.sqrt(-2.0 * math.log(1.0 - rng.random())), scale_km * cap)
    angle = rng.random() * TAU
    axis = math.radians(float(anchor.get("axis_deg", 0.0)))
    major = radius * math.cos(angle) * float(anchor.get("stretch", 1.0))
    minor = radius * math.sin(angle)
    east = major * math.cos(axis) - minor * math.sin(axis)
    north = major * math.sin(axis) + minor * math.cos(axis)
    return _shift(anchor["lat"], anchor["lon"], north, east)


def _neighborhoods(anchor: dict, count: int, rng: random.Random) -> list[tuple[float, float]]:
    """A handful of subdivision centres in the built-up area, not one smooth cloud.

    Single-family roofs clump by neighborhood and follow the metro's long axis.
    Centres that fall in the Gulf or past the border are dropped.
    """
    wanted = 1 if count < 25 else min(8, max(2, round(count / 110)))
    scale = float(anchor.get("radius_km", 15.0)) * 0.85
    gap = max(4.0, float(anchor.get("radius_km", 15.0)) * 0.22)
    centers: list[tuple[float, float]] = []
    for _ in range(wanted * 40):
        if len(centers) >= wanted:
            break
        lat, lon = _rayleigh(anchor, rng, scale, 1.35)
        if not inside_texas(lat, lon):
            continue
        if any(_km(lat, lon, other_lat, other_lon) < gap for other_lat, other_lon in centers):
            continue
        centers.append((lat, lon))
    if centers:
        return centers
    lat, lon = float(anchor["lat"]), float(anchor["lon"])
    if inside_texas(lat, lon):
        return [(lat, lon)]
    for step in range(1, 40):
        share = step / 40.0
        pulled_lat = lat + (31.0 - lat) * share
        pulled_lon = lon + (-99.2 - lon) * share
        if inside_texas(pulled_lat, pulled_lon):
            return [(pulled_lat, pulled_lon)]
    return [(31.0, -99.2)]


def _hex_slots(count: int, spacing_km: float) -> list[tuple[float, float]]:
    """Ring order around the station, so the homes fill a hex patch instead of a pile."""
    if count <= 0:
        return []
    axial = [(0, 0)]
    ring = 1
    directions = ((0, -1), (-1, 0), (-1, 1), (0, 1), (1, 0), (1, -1))
    while len(axial) < count:
        q, r = ring, 0
        for dq, dr in directions:
            for _ in range(ring):
                if len(axial) >= count:
                    break
                axial.append((q, r))
                q += dq
                r += dr
        ring += 1
    slots = []
    for q, r in axial[:count]:
        east = spacing_km * (q + r / 2.0)
        north = spacing_km * (math.sqrt(3.0) / 2.0) * r
        slots.append((north, east))
    return slots


def _cell_spacing(count: int, radius_km: float) -> float:
    """Wide enough that the patch reads as an area, short of the next station."""
    rings = max(1.0, math.sqrt(max(count, 1) / 3.0))
    reach = min(7.0, max(2.0, float(radius_km) * 0.28))
    return max(0.45, reach / rings)


def _burn_scatter(rng: random.Random, lat: float, lon: float) -> None:
    """Walk the old house-scatter draws so later numbers on this seed stay put.

    Reserve, queue position, and starting charge are drawn after this. The
    scripted faults were checked against those values.
    """
    for _ in range(16):
        placed_lat, placed_lon = _shift(lat, lon, rng.gauss(0.0, 2.6), rng.gauss(0.0, 2.6))
        if inside_texas(placed_lat, placed_lon):
            return


def _on_land(lat: float, lon: float, north_km: float, east_km: float) -> tuple[float, float]:
    for scale in (1.0, 0.75, 0.5, 0.25, 0.0):
        placed_lat, placed_lon = _shift(lat, lon, north_km * scale, east_km * scale)
        if inside_texas(placed_lat, placed_lon):
            return round(placed_lat, 5), round(placed_lon, 5)
    return round(lat, 5), round(lon, 5)


def _magnitude(kind: str, rng: random.Random, voltage_center: float) -> dict:
    if kind == "temp_c":
        return {"temp_c": round(44.0 + rng.random() * 9.0, 1)}
    if kind == "voltage_v":
        return {"voltage_v": round(voltage_center - (8.0 + rng.random() * 8.0), 1)}
    if kind == "soc_bias_kwh":
        return {"soc_bias_kwh": round(1.6 + rng.random() * 2.4, 2)}
    if kind == "response_scale":
        return {"response_scale": round(0.35 + rng.random() * 0.35, 2)}
    return {"disco_bias_kw": round(0.8 + rng.random() * 1.2, 2)}


def _scatter_faults(sites: list[dict]) -> None:
    """Two further cabinets of each kind, spaced through the fleet."""
    pool = [site for site in sites if not site["fault"]]
    if not pool:
        return
    slots = EXTRAS_PER_KIND * len(FAULT_KINDS)
    stride = max(1, len(pool) // (slots + 1))
    index = stride // 2
    used: set[str] = set()
    for kind in FAULT_KINDS:
        for _ in range(EXTRAS_PER_KIND):
            for _attempt in range(len(pool)):
                site = pool[index % len(pool)]
                index += stride
                if site["id"] in used:
                    continue
                used.add(site["id"])
                site["fault"] = _magnitude(kind, random.Random(site["id"]), site["voltage_center_v"])
                break


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
        centers = _neighborhoods(anchor, count, random.Random("nbh:" + anchor["id"]))
        # One modeled distribution substation per neighborhood. These are not
        # ERCOT station codes and they are not rows in station_geo.json.
        station_rows = [
            {
                "id": f"{anchor['prefix']}-s{index:02d}",
                "name": f"{anchor['name']} {index}",
                "lat": round(lat, 5),
                "lon": round(lon, 5),
            }
            for index, (lat, lon) in enumerate(centers, start=1)
        ]
        buckets: list[list[tuple[str, random.Random]]] = [[] for _ in centers]
        for number in range(1, count + 1):
            site_id = f"{anchor['prefix']}-{number:04d}"
            # Seeded per unit, so a restart puts every battery back where it was.
            profile = random.Random(site_id)
            served = int(profile.random() * len(centers))
            _burn_scatter(profile, *centers[served])
            buckets[served].append((site_id, profile))
        axis = math.radians(float(anchor.get("axis_deg", 0.0)))
        cos_axis = math.cos(axis)
        sin_axis = math.sin(axis)
        for served, bucket in enumerate(buckets):
            if not bucket:
                continue
            station = station_rows[served]
            centre_lat, centre_lon = centers[served]
            slots = _hex_slots(len(bucket), _cell_spacing(len(bucket), anchor.get("radius_km", 15)))
            for (site_id, profile), (north, east) in zip(bucket, slots):
                # Turn the patch so it follows the metro's long axis, the way a street grid does.
                east_rot = east * cos_axis - north * sin_axis
                north_rot = east * sin_axis + north * cos_axis
                lat, lon = _on_land(centre_lat, centre_lon, north_rot, east_rot)
                voltage_center = round(237.0 + profile.random() * 6.0, 2)
                sites.append(
                {
                    "id": site_id,
                    "city": anchor["name"],
                    "metro": anchor["id"],
                    "load_zone": anchor["load_zone"],
                    "lat": lat,
                    "lon": lon,
                    "station": station["id"],
                    "station_name": station["name"],
                    "station_lat": station["lat"],
                    "station_lon": station["lon"],
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
                    "fault": dict(DEMO_FAULTS[site_id]) if site_id in DEMO_FAULTS else {},
                    "physical_soc_kwh": round(
                        config.BASE_CAPACITY_KWH * (0.22 + profile.random() * 0.70), 3
                    ),
                    "energy_in_kwh": 0.0,
                    "energy_out_kwh": 0.0,
                    "chart_history": {},
                }
            )
    _scatter_faults(sites)
    return sites


def station_summary(sites: list[dict]) -> list[dict]:
    """One row per modeled distribution substation, with the homes that supply it."""
    found: dict[str, dict] = {}
    for site in sites:
        row = found.get(site["station"])
        if row is None:
            row = {
                "id": site["station"],
                "name": site["station_name"],
                "metro": site["metro"],
                "lat": site["station_lat"],
                "lon": site["station_lon"],
                "units": 0,
            }
            found[site["station"]] = row
        row["units"] += 1
    return list(found.values())


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


def _approach(previous: float, target: float, dt_hours: float, tau_hours: float, noise: float) -> float:
    """Move part of the way to `target`. The lag is what makes the next tick depend on this one."""
    if dt_hours <= 0:
        alpha = min(1.0, 0.15)
    else:
        alpha = min(1.0, dt_hours / tau_hours)
    return previous + alpha * (target - previous) + noise


def tick_sites(
    sites: list[dict],
    grid: dict,
    now,
    dt_hours: float,
    rng: random.Random | None = None,
    persist: set[str] | None = None,
    order: dict | None = None,
    note: dict | None = None,
):
    """Advance every battery. `persist` limits which units emit full-rate rows.

    `order` is a fleet-wide call, `{signal, intensity}`. When it is set, every
    home is given that call and the ladder does not run. `note` receives the
    call that was actually applied and the interconnection frequency, for the
    dispatch row written after the tick.
    """
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
    fleet_call = resolve_order(order, percentile)
    # One frequency for the interconnection. Homes only add a local measurement error.
    frequency_hz = 60.0 + rng.gauss(0, 0.006)
    zone_signals: dict[str, str] = {}

    for raw_site in sites:
        site = dict(raw_site)
        site["chart_history"] = raw_site["chart_history"]
        fault = site["fault"]
        eta = site["eta"]
        lmp = by_location.get(site["load_zone"])
        if fleet_call:
            signal, level, source = fleet_call
        else:
            signal = choose_signal(percentile, storage, lmp, lmp_mean)
            level = intensity(signal, percentile)
            source = "rules"
        zone_signals[site["load_zone"]] = signal
        target_kw = max(0.3, HOUR_MEAN_KW[hour] * site["load_scale"] * scale)
        load_kw = max(
            0.3,
            _approach(
                site.get("load_kw_state", target_kw),
                target_kw,
                dt,
                0.20,
                rng.gauss(0, target_kw * 0.025),
            ),
        )
        site["load_kw_state"] = load_kw

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

        # Cabinet temperature lags the power it is actually moving, on a
        # quarter-hour time constant. The chart expected value is that lag,
        # so a healthy cabinet is not punished for being slow.
        power_frac = (charge_kw + discharge_kw) / site["power_limit_kw"] if site["power_limit_kw"] else 0.0
        target_temp = site["temp_center_c"] + 4.0 * min(1.0, power_frac)
        expected_temp = _approach(
            site.get("temp_c_state", site["temp_center_c"]),
            target_temp,
            dt,
            0.25,
            0.0,
        )
        if "temp_c" in fault:
            temp_c = float(fault["temp_c"])
            site["temp_c_state"] = expected_temp
        else:
            temp_c = expected_temp + rng.gauss(0, 0.08)
            site["temp_c_state"] = temp_c
        service_voltage = _approach(
            site.get("voltage_state", site["voltage_center_v"]),
            site["voltage_center_v"],
            dt,
            0.05,
            rng.gauss(0, 0.08),
        )
        site["voltage_state"] = service_voltage
        expected_voltage = site["voltage_center_v"]
        disco_voltage = float(fault["voltage_v"]) if "voltage_v" in fault else service_voltage + rng.gauss(0, 0.12)
        meter_voltage = service_voltage + rng.gauss(0, 0.08)
        frequency = frequency_hz + rng.gauss(0, 0.002)

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
                "source": source,
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
    if note is not None:
        if fleet_call:
            applied_signal, applied_level, applied_source = fleet_call
        else:
            applied_signal = choose_signal(percentile, storage, None, None)
            applied_level = intensity(applied_signal, percentile)
            applied_source = "rules"
        note["frequency_hz"] = round(frequency_hz, 4)
        note["signal"] = applied_signal
        note["intensity"] = round(applied_level, 3)
        note["source"] = applied_source
        note["zones"] = zone_signals
    return updated, logs, observations, points
