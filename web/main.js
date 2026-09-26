import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { LON_SCALE, ORIGIN, TEXAS } from "/geo.js";

const COLOR = {
  pull: 0x8eb6d9,
  push: 0xe0a15a,
  hold: 0x8a9086,
  alarm: 0xe15b4c,
  hub: 0x7b7568,
  land: 0x181a20,
  border: 0x515762,
  constraint: 0xc4b59a,
};

const FAMILIES = ["all", "measurement", "thermal", "electrical", "energy", "response"];
const NODE_Y = 0.035;

const canvas = document.getElementById("map");
const tip = document.getElementById("tip");
const panel = document.getElementById("panel");

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x101114);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 400);
camera.position.set(0, 16, 11.5);

const controls = new OrbitControls(camera, canvas);
controls.enablePan = false;
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 8;
controls.maxDistance = 34;
controls.minPolarAngle = 0.12;
controls.maxPolarAngle = 1.12;
controls.target.set(0, 0, 0.4);

let payload = null;
let selected = null;
let family = "all";

function project(lat, lon, y = 0) {
  return new THREE.Vector3((lon - ORIGIN.lon) * LON_SCALE, y, ORIGIN.lat - lat);
}

function buildMap() {
  const shape = new THREE.Shape(
    TEXAS.map(([lat, lon]) => {
      const point = project(lat, lon);
      return new THREE.Vector2(point.x, -point.z);
    }),
  );
  const land = new THREE.Mesh(
    new THREE.ShapeGeometry(shape),
    new THREE.MeshBasicMaterial({ color: COLOR.land }),
  );
  land.rotation.x = -Math.PI / 2;
  scene.add(land);

  const border = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(TEXAS.map(([lat, lon]) => project(lat, lon, 0.004))),
    new THREE.LineBasicMaterial({ color: COLOR.border }),
  );
  scene.add(border);
}

function labelSprite(text) {
  const size = 256;
  const element = document.createElement("canvas");
  element.width = size;
  element.height = 64;
  const ctx = element.getContext("2d");
  ctx.fillStyle = "#8d887f";
  ctx.font = "600 24px 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.letterSpacing = "5px";
  ctx.fillText(text.toUpperCase(), size / 2, 34);
  const texture = new THREE.CanvasTexture(element);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }),
  );
  sprite.scale.set(1.9, 0.48, 1);
  return sprite;
}

function ring(inner, outer, color, opacity) {
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(inner, outer, 48),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide }),
  );
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

const nodes = new Map();
const hubs = new Map();
const arcs = new THREE.LineSegments(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.8 }),
);
scene.add(arcs);

const constraintArcs = new THREE.LineSegments(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: COLOR.constraint, transparent: true, opacity: 0.5 }),
);
scene.add(constraintArcs);

buildMap();

function ensureNode(site) {
  let node = nodes.get(site.id);
  if (node) return node;
  const group = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.CircleGeometry(0.026, 20),
    new THREE.MeshBasicMaterial({ color: COLOR.hold, transparent: true }),
  );
  core.rotation.x = -Math.PI / 2;
  core.userData.id = site.id;
  const socRing = ring(0.044, 0.062, COLOR.hold, 0.95);
  const alarmRing = ring(0.078, 0.088, COLOR.alarm, 0.9);
  const selectRing = ring(0.104, 0.112, 0xe7e1d6, 0.8);
  group.add(core, socRing, alarmRing, selectRing);
  scene.add(group);
  node = { group, core, socRing, alarmRing, selectRing };
  nodes.set(site.id, node);
  return node;
}

const LABEL_OFFSET = {
  n: [0, -1.0],
  s: [0, 1.0],
  e: [1.35, 0],
  w: [-1.35, 0],
  sw: [-1.0, 0.72],
  se: [1.0, 0.72],
};

function ensureHub(city, point, side) {
  let hub = hubs.get(city);
  if (hub) return hub;
  const group = new THREE.Group();
  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(0.03, 18),
    new THREE.MeshBasicMaterial({ color: COLOR.hub }),
  );
  dot.rotation.x = -Math.PI / 2;
  const halo = ring(0.062, 0.068, COLOR.hub, 0.5);
  const label = labelSprite(city);
  const [dx, dz] = LABEL_OFFSET[side] || LABEL_OFFSET.n;
  label.position.set(dx, 0.02, dz);
  group.add(dot, halo, label);
  group.position.copy(point);
  scene.add(group);
  hub = { group };
  hubs.set(city, hub);
  return hub;
}

function hubPoints(sites) {
  const sums = new Map();
  for (const site of sites) {
    const entry = sums.get(site.city) || { lat: 0, lon: 0, n: 0, label: site.label };
    entry.lat += site.lat;
    entry.lon += site.lon;
    entry.n += 1;
    sums.set(site.city, entry);
  }
  const points = new Map();
  for (const [city, entry] of sums) {
    points.set(city, {
      point: project(entry.lat / entry.n, entry.lon / entry.n, 0.012),
      label: entry.label,
    });
  }
  return points;
}

function modeOf(site) {
  return site.alarm ? "alarm" : site.signal || "hold";
}

function chartsFor(site) {
  const charts = site.charts || [];
  return family === "all" ? charts : charts.filter((chart) => chart.family === family);
}

function focused(site) {
  if (family === "all") return true;
  return (site.charts || []).some((chart) => chart.family === family && !chart.in_control);
}

function arcCurve(from, to) {
  const mid = from.clone().add(to).multiplyScalar(0.5);
  mid.y += from.distanceTo(to) * 0.7 + 0.04;
  return new THREE.QuadraticBezierCurve3(from, mid, to);
}

function renderArcs(sites, points) {
  const positions = [];
  const colors = [];
  const tint = new THREE.Color();
  const faded = new THREE.Color(COLOR.land);
  for (const site of sites) {
    const hub = points.get(site.city);
    if (!hub) continue;
    const curve = arcCurve(hub.point, project(site.lat, site.lon, NODE_Y));
    const samples = curve.getPoints(16);
    tint.setHex(COLOR[modeOf(site)]);
    const dim = !focused(site);
    const head = dim ? tint.clone().lerp(faded, 0.72) : tint;
    for (let index = 0; index < samples.length - 1; index += 1) {
      for (const step of [index, index + 1]) {
        const point = samples[step];
        const along = step / (samples.length - 1);
        const shade = head.clone().lerp(faded, (1 - along) * 0.55);
        positions.push(point.x, point.y, point.z);
        colors.push(shade.r, shade.g, shade.b);
      }
    }
  }
  const geometry = arcs.geometry;
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
}

function renderConstraints(edges) {
  const positions = [];
  for (const edge of edges || []) {
    const curve = arcCurve(
      project(edge.from_lat, edge.from_lon, 0.02),
      project(edge.to_lat, edge.to_lon, 0.02),
    );
    const samples = curve.getPoints(24);
    for (let index = 0; index < samples.length - 1; index += 1) {
      positions.push(samples[index].x, samples[index].y, samples[index].z);
      positions.push(samples[index + 1].x, samples[index + 1].y, samples[index + 1].z);
    }
  }
  constraintArcs.geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  constraintArcs.geometry.computeBoundingSphere();
}

function renderSites(data) {
  const points = hubPoints(data.sites);
  for (const [city, hub] of points) ensureHub(city, hub.point, hub.label);

  const seen = new Set();
  for (const site of data.sites) {
    seen.add(site.id);
    const node = ensureNode(site);
    const dim = !focused(site);
    const color = COLOR[modeOf(site)];
    node.group.position.copy(project(site.lat, site.lon, NODE_Y));

    node.core.material.color.setHex(color);
    node.core.material.opacity = dim ? 0.3 : 1;
    node.core.material.transparent = dim;

    const soc = Math.min(1, Math.max(0.02, (site.soc_pct ?? 60) / 100));
    node.socRing.geometry.dispose();
    node.socRing.geometry = new THREE.RingGeometry(0.044, 0.062, 48, 1, Math.PI / 2, soc * Math.PI * 2);
    node.socRing.material.color.setHex(color);
    node.socRing.material.opacity = dim ? 0.24 : 0.95;

    node.alarmRing.visible = Boolean(site.alarm);
    node.alarmRing.material.opacity = dim ? 0.25 : 0.9;
    node.selectRing.visible = site.id === selected;
  }
  for (const [id, node] of nodes) {
    if (!seen.has(id)) {
      scene.remove(node.group);
      nodes.delete(id);
    }
  }
  renderArcs(data.sites, points);
  renderConstraints(data.edges);
}

function fmt(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return Number(value).toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function renderStats(data) {
  const grid = data.grid || {};
  const ercot = data.ercot || {};
  const alarms = data.sites.filter((site) => site.alarm).length;
  document.getElementById("stats").innerHTML = `
    <span>demand <b>${fmt(grid.demand_mw)} MW</b></span>
    <span>storage <b>${fmt(grid.storage_gen_mw)} MW</b></span>
    <span>wind <b>${fmt(grid.wind_mw)} MW</b></span>
    <span>fleet <b>${data.sites.length}</b></span>
    <span>flagged <b>${alarms}</b></span>
    <span>feed <b>${ercot.dashboard === "live" ? "live" : ercot.dashboard || "offline"}</b></span>
  `;
}

function chartSvg(chart) {
  const series = chart.series?.length ? chart.series : [chart.value];
  const span = Math.max(chart.ucl || 1, ...series.map((value) => Math.abs(value))) * 1.1;
  const width = 360;
  const height = 64;
  const xAt = (index) => (series.length === 1 ? width / 2 : (index / (series.length - 1)) * width);
  const yAt = (value) => height / 2 - (value / span) * (height / 2 - 3);
  const stroke = chart.in_control ? (chart.warning ? "#d8b46a" : "#cfc6ba") : "#e15b4c";
  const band = Math.abs(yAt((chart.ucl / 3) * 2) - yAt(0));
  const poly = series.map((value, index) => `${xAt(index).toFixed(1)},${yAt(value).toFixed(1)}`).join(" ");
  const last = series[series.length - 1];
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img">
    <rect x="0" y="${(yAt(0) - band).toFixed(1)}" width="${width}" height="${(band * 2).toFixed(1)}" fill="#1b1d21" />
    <line x1="0" x2="${width}" y1="${yAt(chart.ucl).toFixed(1)}" y2="${yAt(chart.ucl).toFixed(1)}" stroke="#4d5159" stroke-dasharray="4 4" />
    <line x1="0" x2="${width}" y1="${yAt(chart.lcl).toFixed(1)}" y2="${yAt(chart.lcl).toFixed(1)}" stroke="#4d5159" stroke-dasharray="4 4" />
    <line x1="0" x2="${width}" y1="${yAt(0).toFixed(1)}" y2="${yAt(0).toFixed(1)}" stroke="#6d675c" />
    <polyline points="${poly}" fill="none" stroke="${stroke}" stroke-width="1.6" />
    <circle cx="${xAt(series.length - 1).toFixed(1)}" cy="${yAt(last).toFixed(1)}" r="2.6" fill="${stroke}" />
  </svg>`;
}

function row(label, text) {
  return `<p><span>${label}</span><b>${text}</b></p>`;
}

function renderPanel(data) {
  if (!data.sites?.length) {
    panel.innerHTML = `<p class="muted">No batteries in this snapshot.</p>`;
    return;
  }
  if (!selected || !data.sites.some((site) => site.id === selected)) {
    selected = (data.sites.find((site) => site.alarm) || data.sites[0]).id;
  }
  const chips = FAMILIES.map(
    (name) => `<button type="button" data-family="${name}" class="${name === family ? "on" : ""}">${name}</button>`,
  ).join("");

  const cities = new Map();
  for (const site of data.sites) {
    if (!cities.has(site.city)) cities.set(site.city, []);
    cities.get(site.city).push(site);
  }
  const groups = [...cities]
    .map(([city, sites]) => {
      const flagged = sites.filter((site) => site.alarm).length;
      const rows = sites
        .map((site) => {
          const classes = [modeOf(site)];
          if (!focused(site)) classes.push("dim");
          if (site.id === selected) classes.push("on");
          return `<button type="button" class="unit-row ${classes.join(" ")}" data-site="${site.id}">
            <i></i><span>${site.id}</span><em>${fmt(site.soc_pct, 0)}%</em>
          </button>`;
        })
        .join("");
      return `<div class="group">
        <h3>${city}${flagged ? `<span class="flag">${flagged} flagged</span>` : ""}</h3>
        <div class="roster">${rows}</div>
      </div>`;
    })
    .join("");

  const constraints = (data.constraints || []).slice(0, 4);
  const constraintHtml = constraints.length
    ? `<ul>${constraints
        .map(
          (item) =>
            `<li>${item.constraint_name || "constraint"} · ${item.from_station || "?"} → ${item.to_station || "?"} · ${fmt(item.shadow_price, 1)} $/MW</li>`,
        )
        .join("")}</ul>`
    : `<p class="muted">Arcs between stations appear once the ERCOT key is set and both station codes are in station_geo.json.</p>`;

  panel.innerHTML = `
    <h2>Fleet</h2>
    <div class="sub">${data.sites.length} units · ${data.sites.filter((site) => site.alarm).length} flagged · click a unit for its one-line diagram</div>
    <div class="chips">${chips}</div>
    ${groups}
    <div class="constraints">
      <h3>Binding constraints</h3>
      ${constraintHtml}
    </div>
  `;
}

/* ---------- unit modal ---------- */

const COMPONENTS = [
  { id: "grid", name: "Grid", role: "Utility interchange at the site, plus the ERCOT context that drove dispatch." },
  { id: "meter", name: "Meter", role: "Service meter. Billing-grade measurement of the flow the disco also sees." },
  { id: "disco", name: "Disco", role: "Raspberry Pi at the disconnect. Measures the same flow as the meter, with more noise." },
  { id: "panel", name: "Electrical panel", role: "House load downstream of the battery interconnect." },
  { id: "base", name: "Base", role: "Battery cabinet. Charge and discharge are what the battery did. The commanded pair is what dispatch asked for." },
];

// Rows are [label, formatter, chart_id]. A row with a chart is clickable.
const METRIC_ROWS = {
  grid: [
    ["in", (m) => `${fmt(m.in_kw, 2)} kW`],
    ["out", (m) => `${fmt(m.out_kw, 2)} kW`],
    ["signal", (m) => m.signal || "—"],
    ["LMP", (m) => (m.lmp_usd_mwh == null ? "—" : `${fmt(m.lmp_usd_mwh, 2)} $/MWh`)],
    ["ERCOT demand", (m) => `${fmt(m.demand_mw)} MW`],
    ["demand percentile", (m) => `${fmt((m.demand_percentile ?? 0) * 100, 0)}%`],
    ["storage on the grid", (m) => `${fmt(m.storage_gen_mw)} MW`],
    ["snapshot", (m) => (m.grid_as_of ? m.grid_as_of.slice(11, 19) : "—")],
  ],
  meter: [
    ["in", (m) => `${fmt(m.in_kw, 2)} kW`, "disco_meter_delta"],
    ["out", (m) => `${fmt(m.out_kw, 2)} kW`, "disco_meter_delta"],
    ["voltage", (m) => `${fmt(m.voltage_v, 1)} V`],
    ["energy imported", (m) => `${fmt(m.energy_in_kwh, 2)} kWh`],
    ["energy exported", (m) => `${fmt(m.energy_out_kwh, 2)} kWh`],
  ],
  disco: [
    ["in", (m) => `${fmt(m.in_kw, 2)} kW`],
    ["out", (m) => `${fmt(m.out_kw, 2)} kW`],
    ["voltage", (m) => `${fmt(m.voltage_v, 1)} V`, "disco_voltage"],
    ["frequency", (m) => `${fmt(m.frequency_hz, 3)} Hz`, "frequency"],
    ["contactor", (m) => m.contactor || "—"],
    ["islanded", (m) => (m.islanded ? "yes" : "no")],
  ],
  panel: [
    ["load", (m) => `${fmt(m.load_kw, 2)} kW`],
    ["voltage", (m) => `${fmt(m.voltage_v, 1)} V`],
  ],
  base: [
    ["state of charge", (m) => `${fmt(m.soc_pct, 1)}%`, "soc_tracking"],
    ["energy stored", (m) => `${fmt(m.soc_kwh, 2)} of ${fmt(m.capacity_kwh, 1)} kWh`, "soc_tracking"],
    ["power limit", (m) => `${fmt(m.power_limit_kw, 1)} kW`],
    ["charge", (m) => `${fmt(m.charge_kw, 2)} kW`, "dispatch_response"],
    ["commanded charge", (m) => `${fmt(m.commanded_charge_kw, 2)} kW`, "dispatch_response"],
    ["discharge", (m) => `${fmt(m.discharge_kw, 2)} kW`, "dispatch_response"],
    ["commanded discharge", (m) => `${fmt(m.commanded_discharge_kw, 2)} kW`, "dispatch_response"],
    ["temperature", (m) => `${fmt(m.temp_c, 1)} °C`, "base_temp"],
  ],
};

const DIA = { w: 360, h: 540, bx: 36, bw: 152, bh: 58, baseH: 80, px: 248, pw: 102 };
const ROWS = { grid: 44, meter: 176, disco: 308, base: 440 };
const CX = DIA.bx + DIA.bw / 2;

const modal = document.getElementById("unit");
let component = "base";
let expanded = new Set();

function flowOf(down, up) {
  if (down > 0.005) return { dir: 1, kw: down, tone: "pull" };
  if (up > 0.005) return { dir: -1, kw: up, tone: "push" };
  return { dir: 0, kw: 0, tone: "idle" };
}

function flowStyle(kw) {
  const width = 1.3 + Math.min(kw, 12) * 0.1;
  const duration = Math.max(0.5, 2.1 - Math.min(kw, 11) * 0.14);
  return `stroke-width:${width.toFixed(2)};animation-duration:${duration.toFixed(2)}s`;
}

function arrowDown(x, y, up, tone) {
  const t = 4.6;
  const base = up ? y + t + 1.5 : y - t - 1.5;
  return `<polygon class="head ${tone}" points="${x - t},${base} ${x + t},${base} ${x},${y}" />`;
}

function vFlow(top, bottom, flow) {
  const mid = (top + bottom) / 2;
  const rail = `<line class="rail" x1="${CX}" y1="${top}" x2="${CX}" y2="${bottom}" />`;
  const text = flow.dir ? `${fmt(flow.kw, 2)} kW` : "idle";
  const label = `<text class="flow-kw ${flow.tone}" x="${CX + 14}" y="${mid}" dominant-baseline="middle">${text}</text>`;
  if (!flow.dir) return rail + label;
  const up = flow.dir < 0;
  const [from, to] = up ? [bottom, top] : [top, bottom];
  return `${rail}
    <line class="flow ${flow.tone}" x1="${CX}" y1="${from}" x2="${CX}" y2="${to}" style="${flowStyle(flow.kw)}" />
    ${arrowDown(CX, to, up, flow.tone)}${label}`;
}

function hFlow(y, left, right, kw) {
  const rail = `<line class="rail" x1="${left}" y1="${y}" x2="${right}" y2="${y}" />`;
  const head = `<polygon class="head hold" points="${right - 6},${y - 4.6} ${right - 6},${y + 4.6} ${right},${y} " />`;
  return `${rail}
    <line class="flow hold" x1="${left}" y1="${y}" x2="${right}" y2="${y}" style="${flowStyle(kw)}" />
    ${head}
    <text class="flow-kw hold" x="${(left + right) / 2}" y="${y - 11}" text-anchor="middle">${fmt(kw, 2)} kW</text>`;
}

function block(id, y, name, note, opts = {}) {
  const x = opts.x ?? DIA.bx;
  const w = opts.w ?? DIA.bw;
  const h = opts.h ?? DIA.bh;
  const classes = ["blk"];
  if (component === id) classes.push("on");
  if (opts.state) classes.push(opts.state);
  return `<g class="${classes.join(" ")}" data-component="${id}" tabindex="0" role="button" aria-label="${name}">
    <rect class="blk-bg" x="${x}" y="${y}" width="${w}" height="${h}" rx="3" />
    <rect class="blk-edge" x="${x}" y="${y}" width="2.5" height="${h}" />
    <text class="blk-name" x="${x + 16}" y="${y + 24}">${name}</text>
    <text class="blk-note" x="${x + 16}" y="${y + 42}">${note}</text>
    ${opts.state ? `<circle class="blk-dot" cx="${x + w - 15}" cy="${y + 19}" r="3.2" />` : ""}
    ${opts.extra || ""}
  </g>`;
}

function diagram(site) {
  const m = site.metrics || {};
  const grid = m.grid || {};
  const meter = m.meter || {};
  const disco = m.disco || {};
  const house = m.panel || {};
  const base = m.base || {};
  const charts = site.charts || [];
  const state = (id) => {
    const mine = charts.filter((chart) => chart.component === id);
    if (mine.some((chart) => !chart.in_control)) return "flagged";
    if (mine.some((chart) => chart.warning)) return "watch";
    return null;
  };

  const soc = Math.min(1, Math.max(0, (base.soc_pct ?? 0) / 100));
  const mode = modeOf(site);
  const barX = DIA.bx + 16;
  const barW = DIA.bw - 32;
  const socBar = `
    <rect class="soc-track" x="${barX}" y="${ROWS.base + 58}" width="${barW}" height="5" rx="2.5" />
    <rect class="soc-fill ${mode}" x="${barX}" y="${ROWS.base + 58}" width="${(barW * soc).toFixed(1)}" height="5" rx="2.5" />`;

  return `<svg viewBox="0 0 ${DIA.w} ${DIA.h}" class="diagram">
    <text class="rail-cap" x="${CX}" y="10" text-anchor="middle">substation · transformer · ${site.load_zone}</text>
    <line class="rail dotted" x1="${CX}" y1="18" x2="${CX}" y2="${ROWS.grid}" />

    ${block("grid", ROWS.grid, "Grid", grid.lmp_usd_mwh == null ? `${grid.signal || "hold"} · LMP pending` : `${grid.signal || "hold"} · ${fmt(grid.lmp_usd_mwh, 2)} $/MWh`, { state: state("grid") })}
    ${vFlow(ROWS.grid + DIA.bh, ROWS.meter, flowOf(grid.in_kw, grid.out_kw))}

    ${block("meter", ROWS.meter, "Meter", `${fmt(meter.voltage_v, 1)} V`, { state: state("meter") })}
    ${vFlow(ROWS.meter + DIA.bh, ROWS.disco, flowOf(meter.in_kw, meter.out_kw))}

    ${block("disco", ROWS.disco, "Disco", `${fmt(disco.frequency_hz, 3)} Hz · ${disco.contactor || "closed"}`, { state: state("disco") })}
    ${hFlow(ROWS.disco + DIA.bh / 2, DIA.bx + DIA.bw, DIA.px, house.load_kw || 0)}
    ${block("panel", ROWS.disco, "Panel", `${fmt(house.load_kw, 2)} kW`, { x: DIA.px, w: DIA.pw, state: state("panel") })}
    ${vFlow(ROWS.disco + DIA.bh, ROWS.base, flowOf(base.charge_kw, base.discharge_kw))}

    ${block("base", ROWS.base, "Base", `${fmt(base.soc_pct, 1)}% · ${fmt(base.temp_c, 1)} °C`, { h: DIA.baseH, extra: socBar, state: state("base") })}
  </svg>`;
}

function metricRow(label, text, chartId) {
  if (!chartId) return row(label, text);
  return `<button type="button" class="metric-link" data-chart="${chartId}" data-scroll="1">
    <span>${label}</span><b>${text}</b>
  </button>`;
}

function chartCard(chart) {
  const open = expanded.has(chart.chart_id);
  const status = chart.in_control ? (chart.warning ? "watch" : "in control") : chart.rules.join(", ");
  const tone = chart.in_control ? (chart.warning ? "watch" : "muted") : "flag";
  const detail = open
    ? `<div class="chart-facts">
        ${row("measured", `${fmt(chart.measured, 3)} ${chart.unit}`)}
        ${row("expected", `${fmt(chart.expected, 3)} ${chart.unit}`)}
        ${row("residual", `${fmt(chart.value, 3)} ${chart.unit}`)}
        ${row("sigma", fmt(chart.sigma, 3))}
        ${row("limits", `${fmt(chart.lcl, 3)} to ${fmt(chart.ucl, 3)}`)}
        ${row("family", chart.family)}
      </div>`
    : "";
  return `<div class="chart${open ? " open" : ""}" id="chart-${chart.chart_id}">
    <button type="button" class="chart-head" data-chart="${chart.chart_id}">
      <h3>${chart.title}<span>${fmt(chart.value, 2)} ${chart.unit}</span></h3>
    </button>
    ${chartSvg(chart)}
    <p class="${tone}">${status} · z ${fmt(chart.z, 1)}</p>
    ${detail}
  </div>`;
}

function renderUnit(data) {
  if (!modal.open) return;
  const site = data.sites?.find((item) => item.id === selected);
  if (!site) {
    modal.close();
    return;
  }
  const spec = COMPONENTS.find((item) => item.id === component) || COMPONENTS[0];
  const metrics = (site.metrics || {})[component] || {};
  const charts = (site.charts || []).filter((chart) => chart.component === component);
  const mode = modeOf(site);

  document.getElementById("unit-id").textContent = site.id;
  document.getElementById("unit-sub").textContent =
    `${site.city} · ${site.load_zone} · load ×${fmt(site.load_scale, 2)} · ${fmt(site.temp_center_c, 1)} °C baseline`;
  document.getElementById("unit-mode").className = `mode ${mode}`;
  document.getElementById("unit-mode").innerHTML = `<i></i>${mode}`;
  document.getElementById("unit-diagram").innerHTML = diagram(site);

  const tabs = COMPONENTS.map(
    (item) => `<button type="button" data-component="${item.id}" class="${item.id === component ? "on" : ""}">${item.name}</button>`,
  ).join("");

  document.getElementById("unit-detail").innerHTML = `
    <div class="chips tabs">${tabs}</div>
    <h3 class="dt-name">${spec.name}</h3>
    <p class="dt-role">${spec.role}</p>
    <div class="stack">${METRIC_ROWS[component]
      .map(([label, format, chartId]) => metricRow(label, format(metrics), chartId))
      .join("")}</div>
    <div class="dt-charts">
      <div class="dt-cap">control charts${charts.length ? "" : " — none on this component"}</div>
      ${charts.length ? charts.map(chartCard).join("") : `<p class="muted">Charts live on the meter, disco, and base. Click those blocks.</p>`}
    </div>
  `;
}

function openUnit(id) {
  selected = id;
  const site = payload?.sites?.find((item) => item.id === id);
  const flagged = (site?.charts || []).find((chart) => !chart.in_control);
  component = flagged ? flagged.component : "base";
  expanded = new Set(flagged ? [flagged.chart_id] : []);
  if (!modal.open) modal.showModal();
  renderUnit(payload);
}

function nearestSite(clientX, clientY) {
  if (!payload?.sites?.length) return null;
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  let best = null;
  let bestDist = 30;
  for (const site of payload.sites) {
    const ndc = project(site.lat, site.lon, NODE_Y).project(camera);
    const sx = (ndc.x * 0.5 + 0.5) * rect.width;
    const sy = (-ndc.y * 0.5 + 0.5) * rect.height;
    const dist = Math.hypot(sx - x, sy - y);
    if (dist < bestDist) {
      bestDist = dist;
      best = site.id;
    }
  }
  return best;
}

panel.addEventListener("click", (event) => {
  if (!payload) return;
  const chip = event.target.closest("[data-family]");
  if (chip) {
    family = chip.dataset.family;
    renderSites(payload);
    renderPanel(payload);
    return;
  }
  const unit = event.target.closest("[data-site]");
  if (unit) openUnit(unit.dataset.site);
});

modal.addEventListener("click", (event) => {
  if (event.target === modal) {
    modal.close();
    return;
  }
  const blockHit = event.target.closest("[data-component]");
  if (blockHit) {
    component = blockHit.dataset.component;
    renderUnit(payload);
    return;
  }
  const chartHit = event.target.closest("[data-chart]");
  if (chartHit) {
    const id = chartHit.dataset.chart;
    if (chartHit.dataset.scroll) expanded.add(id);
    else if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    renderUnit(payload);
    if (chartHit.dataset.scroll) {
      document.getElementById(`chart-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }
});

modal.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const blockHit = event.target.closest("g[data-component]");
  if (!blockHit) return;
  event.preventDefault();
  component = blockHit.dataset.component;
  renderUnit(payload);
});

modal.addEventListener("close", () => {
  if (payload) renderPanel(payload);
});

document.getElementById("unit-close").addEventListener("click", () => modal.close());

canvas.addEventListener("pointermove", (event) => {
  const site = payload?.sites?.find((item) => item.id === nearestSite(event.clientX, event.clientY));
  if (!site) {
    tip.hidden = true;
    canvas.style.cursor = "grab";
    return;
  }
  const flagged = site.metrics?.maintenance?.out_of_control || [];
  tip.hidden = false;
  tip.innerHTML = `<b>${site.id}</b> ${site.signal} · ${fmt(site.soc_pct, 0)}%${flagged.length ? `<br>${flagged.join(", ")}` : ""}`;
  tip.style.left = `${event.clientX + 14}px`;
  tip.style.top = `${event.clientY + 14}px`;
  canvas.style.cursor = "pointer";
});

canvas.addEventListener("pointerleave", () => {
  tip.hidden = true;
});

canvas.addEventListener("click", (event) => {
  const hit = nearestSite(event.clientX, event.clientY);
  if (!hit || !payload) return;
  tip.hidden = true;
  openUnit(hit);
  renderSites(payload);
  renderPanel(payload);
});

function resize() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== width || canvas.height !== height) {
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
  }
}

async function poll() {
  try {
    const response = await fetch("/api/scene");
    payload = await response.json();
    renderSites(payload);
    renderStats(payload);
    renderPanel(payload);
    renderUnit(payload);
  } catch (error) {
    panel.innerHTML = `<p class="muted">Scene unavailable. ${error.message}</p>`;
  }
}

function frame() {
  resize();
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

poll();
setInterval(poll, 5000);
frame();
