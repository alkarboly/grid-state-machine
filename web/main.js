import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { API_BASE } from "/config.js";
import { LON_SCALE, ORIGIN, TEXAS } from "/geo.js";

function api(path) {
  return `${API_BASE}${path}`;
}

const COLOR = {
  pull: 0x4c9be8,
  push: 0xf0a03a,
  hold: 0x9dbe92,
  alarm: 0xe15b4c,
  offline: 0x8d8794,
  hub: 0x7b7568,
  land: 0x181a20,
  border: 0x515762,
  constraint: 0xc4b59a,
};

const NODE_Y = 0.02;
const UNIT_CAP = 20000;
const LABEL_SHARE = 0.03;
const LAND = new THREE.Color(COLOR.land);

const canvas = document.getElementById("map");
const tip = document.getElementById("tip");
const panel = document.getElementById("panel");
const panelBody = document.getElementById("panel-body");
const panelToggle = document.getElementById("panel-toggle");
let panelOpen = true;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x101114);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 400);
camera.position.set(0, 16, 11.5);

const controls = new OrbitControls(camera, canvas);
// Right-drag moves the orbit target. Left-drag still orbits, the wheel still zooms.
controls.enablePan = true;
controls.screenSpacePanning = true;
controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;
controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
canvas.addEventListener("contextmenu", (event) => event.preventDefault());
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 1.2;
controls.maxDistance = 34;
controls.minPolarAngle = 0.12;
controls.maxPolarAngle = 1.12;
controls.target.set(0, 0, 0.4);

let payload = null;
let selected = null;
let unitDetail = null;
let actionsOpen = false;
let screen = null;
let focusPoint = null;
let focusedStation = null;

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
  const label = text.toUpperCase();
  const element = document.createElement("canvas");
  const ctx = element.getContext("2d");
  const font = "600 44px 'Segoe UI', sans-serif";
  ctx.font = font;
  const padX = 28;
  const width = Math.ceil(ctx.measureText(label).width) + padX * 2;
  const height = 80;
  element.width = width;
  element.height = height;
  ctx.font = font;
  ctx.fillStyle = "#8d887f";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, width / 2, height / 2);
  const texture = new THREE.CanvasTexture(element);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }),
  );
  sprite.userData.aspect = width / height;
  return sprite;
}

function fitLabel(sprite, height) {
  const aspect = sprite.userData.aspect || 4;
  sprite.scale.set(height * aspect, height, 1);
}

function flatRing(inner, outer, color, opacity) {
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(inner, outer, 48),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide }),
  );
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

buildMap();

// One particle draw for the whole fleet. Screen-space size, so a zoom opens
// the gaps in the station grid instead of enlarging every dot into its neighbour.
const particlePositions = new Float32Array(UNIT_CAP * 3);
const particleColors = new Float32Array(UNIT_CAP * 3);
const particleGeo = new THREE.BufferGeometry();
particleGeo.setAttribute("position", new THREE.BufferAttribute(particlePositions, 3));
particleGeo.setAttribute("color", new THREE.BufferAttribute(particleColors, 3));
function particleTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  const fill = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  fill.addColorStop(0, "rgba(255,255,255,1)");
  fill.addColorStop(0.65, "rgba(255,255,255,0.95)");
  fill.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(32, 32, 30, 0, Math.PI * 2);
  ctx.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const particles = new THREE.Points(
  particleGeo,
  new THREE.PointsMaterial({
    size: 6,
    sizeAttenuation: false,
    map: particleTexture(),
    vertexColors: true,
    transparent: true,
    depthWrite: false,
  }),
);
particles.frustumCulled = false;
particles.renderOrder = 3;
scene.add(particles);

const stationMarks = new Map();

const pick = flatRing(0.05, 0.062, 0xe7e1d6, 0.9);
pick.renderOrder = 5;
pick.visible = false;
scene.add(pick);

const constraintArcs = new THREE.LineSegments(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: COLOR.constraint, transparent: true, opacity: 0.5 }),
);
scene.add(constraintArcs);

// Direction the name grows, away from the homes. The anchor is the edge of the
// sprite that stays next to the city, so the letters are not covered by dots.
const LABEL_OFFSET = {
  n: [0, -1],
  s: [0, 1],
  e: [1, 0],
  w: [-1, 0],
  ne: [0.7, -0.7],
  nw: [-0.7, -0.7],
  sw: [-0.7, 0.7],
  se: [0.7, 0.7],
};
const LABEL_ANCHOR = {
  n: [0.5, 0],
  s: [0.5, 1],
  e: [0, 0.5],
  w: [1, 0.5],
  ne: [0, 0],
  nw: [1, 0],
  se: [0, 1],
  sw: [1, 1],
};

const hubs = new Map();

function ensureHub(metro, share) {
  let hub = hubs.get(metro.id);
  if (hub) return hub;
  const group = new THREE.Group();
  const size = 0.014 + 0.028 * Math.sqrt(share);
  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(size, 18),
    new THREE.MeshBasicMaterial({ color: COLOR.hub }),
  );
  dot.rotation.x = -Math.PI / 2;
  group.add(dot, flatRing(size * 2.1, size * 2.3, COLOR.hub, 0.45));
  if (share >= LABEL_SHARE) {
    const label = labelSprite(metro.name);
    const dir = metro.label || "n";
    const [dx, dz] = LABEL_OFFSET[dir] || LABEL_OFFSET.n;
    const [ax, ay] = LABEL_ANCHOR[dir] || LABEL_ANCHOR.n;
    fitLabel(label, 0.24 + Math.min(0.1, share * 0.35));
    label.center.set(ax, ay);
    const len = Math.hypot(dx, dz) || 1;
    // Sit the near edge just outside the neighborhood, not through the middle of it.
    const reach = 0.28 + (metro.radius_km || 15) / 111 * 0.72;
    label.position.set((dx / len) * reach, 0.05, (dz / len) * reach);
    group.add(label);
  }
  group.position.copy(project(metro.lat, metro.lon, 0.012));
  scene.add(group);
  hub = { group, point: project(metro.lat, metro.lon, 0.012) };
  hubs.set(metro.id, hub);
  return hub;
}

function modeOf(item) {
  if (!item) return "hold";
  const availability = item.metrics?.base?.availability;
  if (item.offline || availability === "offline") return "offline";
  return item.alarm ? "alarm" : item.state || "hold";
}

function viewDistance() {
  return camera.position.distanceTo(controls.target);
}

function arcCurve(from, to) {
  const mid = from.clone().add(to).multiplyScalar(0.5);
  mid.y += from.distanceTo(to) * 0.7 + 0.04;
  return new THREE.QuadraticBezierCurve3(from, mid, to);
}

const TINT = new THREE.Color();

function renderUnits(data) {
  const positions = particles.geometry.attributes.position;
  const colors = particles.geometry.attributes.color;
  let drawn = 0;
  for (const site of data.sites) {
    const point = project(site.lat, site.lon, NODE_Y);
    positions.setXYZ(drawn, point.x, point.y, point.z);
    TINT.setHex(COLOR[modeOf(site)]);
    if (focusedStation && site.station !== focusedStation) TINT.lerp(LAND, 0.9);
    colors.setXYZ(drawn, TINT.r, TINT.g, TINT.b);
    drawn += 1;
    if (site.id === selected) {
      pick.position.copy(point);
      pick.visible = true;
    }
  }
  particles.geometry.setDrawRange(0, drawn);
  positions.needsUpdate = true;
  colors.needsUpdate = true;
  if (!data.sites.some((site) => site.id === selected)) pick.visible = false;
}

function ensureStation(station) {
  let entry = stationMarks.get(station.id);
  if (entry) return entry;
  const group = new THREE.Group();
  const mark = new THREE.Mesh(
    new THREE.CircleGeometry(1, 4),
    new THREE.MeshBasicMaterial({ color: 0xd5dbe2, side: THREE.DoubleSide }),
  );
  mark.rotation.x = -Math.PI / 2;
  mark.rotation.z = Math.PI / 4;
  group.add(mark);
  const label = labelSprite(station.name);
  label.center.set(0.5, 1);
  label.position.set(0, 0.04, 0.045);
  label.visible = false;
  group.add(label);
  group.position.copy(project(station.lat, station.lon, 0.025));
  group.visible = false;
  scene.add(group);
  entry = { group, mark, label };
  stationMarks.set(station.id, entry);
  return entry;
}

// Substation diamonds take over once the camera is inside a city. The metro
// hub is the state-scale mark; up close it sits on empty downtown.
function renderStations(data) {
  const dist = viewDistance();
  const show = dist < 8;
  for (const hub of hubs.values()) hub.group.visible = !show;
  const target = controls.target;
  const reach = 0.28 + dist * 0.08;
  for (const station of data.stations || []) {
    const entry = ensureStation(station);
    const near = Math.hypot(entry.group.position.x - target.x, entry.group.position.z - target.z);
    const chosen = station.id === focusedStation;
    entry.group.visible = show && (chosen || near < reach + 0.15);
    const size = chosen
      ? Math.max(0.012, Math.min(0.028, 0.012 * dist))
      : Math.max(0.006, Math.min(0.014, 0.004 * dist));
    entry.mark.scale.set(size, size, 1);
    entry.mark.material.color.setHex(chosen ? 0xf4f0e8 : 0xd5dbe2);
    fitLabel(entry.label, chosen ? Math.min(0.16, 0.04 * dist) : Math.min(0.11, 0.028 * dist));
    entry.label.visible = show && (chosen || (dist < 4.5 && near < reach));
  }
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

function renderScene(data) {
  const total = data.sites.length || 1;
  for (const metro of data.metros || []) ensureHub(metro, metro.units / total);
  renderUnits(data);
  renderStations(data);
  renderConstraints(data.edges);
  screen = null;
}

function fmt(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return Number(value).toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function mw(kw) {
  return `${fmt((kw || 0) / 1000, 2)} MW`;
}

function renderStats(data) {
  const grid = data.grid || {};
  const ercot = data.ercot || {};
  const fleet = data.fleet || {};
  const interchange = (fleet.grid_in_kw || 0) - (fleet.grid_out_kw || 0);
  document.getElementById("stats").innerHTML = `
    <span>demand <b>${fmt(grid.demand_mw)} MW</b></span>
    <span>storage <b>${fmt(grid.storage_gen_mw)} MW</b></span>
    <span>fleet <b>${fmt(fleet.units)}</b></span>
    <span>grid <b>${interchange >= 0 ? "+" : ""}${fmt(interchange / 1000, 2)} MW</b></span>
    <span>soc <b>${fmt(fleet.mean_soc_pct, 0)}%</b></span>
    <span>flagged <b>${fmt(fleet.alarms)}</b></span>
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

function marketBlock(data) {
  const market = data.market;
  if (!market) return "";
  const basis = market.rate_basis === "ercot" ? "ERCOT" : "simulated";
  return `<div class="group">
    <h3>Market</h3>
    <p class="market">${fmt(market.rate_usd_mwh, 1)} $/MWh <span>${basis}</span></p>
    <p class="muted note">Mean state of charge ${fmt(market.mean_soc_pct, 0)}%. ${fmt(market.offline)} offline.</p>
  </div>`;
}

function actionTitle(action) {
  const payload = action.payload || {};
  if (action.kind === "scheduled_service") return "scheduled service";
  if (action.kind === "return_online") return "back online";
  if (action.kind === "set_signal") return `set ${payload.signal || "signal"}`;
  if (action.kind === "install_addon") return `install ${payload.addon_id || "add-on"}`;
  if (action.kind === "remove_addon") return `remove ${payload.addon_id || "add-on"}`;
  return action.kind || "action";
}

function actionBlock(data) {
  const actions = data.actions || [];
  const catalog = (data.addons || []).map((item) => item.name.toLowerCase()).join(" and ");
  const rows = actions.length
    ? actions
        .map(
          (action) => `<button type="button" class="unit-row" data-site="${action.site_id}">
            <span>${action.site_id}</span><em>${actionTitle(action)} · ${action.status}</em>
          </button>`,
        )
        .join("")
    : `<p class="muted">No actions yet. A scheduled service takes that base offline and brings it back in one to two hours.</p>`;
  const count = actions.length ? `<span class="flag">${fmt(actions.length)}</span>` : "";
  return `<details class="fold" data-fold="actions"${actionsOpen ? " open" : ""}>
    <summary>Actions${count}</summary>
    <div class="roster">${rows}</div>
    <p class="muted note">The disco tracks ${catalog || "add-ons"} on the home.</p>
  </details>`;
}

function usageBlock(site) {
  const rows = site.usage || [];
  if (!rows.length) return "";
  const lines = rows
    .slice(-8)
    .map(
      (row) =>
        `<p><span>hour ${row.hour}</span><b>${fmt(row.load_kwh, 2)} kWh load</b></p>`,
    )
    .join("");
  return `<div class="stack"><h3>Recent usage</h3>${lines}</div>`;
}

function renderPanel(data) {
  const sites = data.sites || [];
  if (!sites.length) {
    panelBody.innerHTML = `<p class="muted">No batteries in this snapshot.</p>`;
    return;
  }
  const fleet = data.fleet || {};

  const flaggedByStation = new Map();
  const queue = [];
  for (const site of sites) {
    if (!site.alarm) continue;
    flaggedByStation.set(site.station, (flaggedByStation.get(site.station) || 0) + 1);
    queue.push(site);
  }

  const queueHtml = queue.length
    ? queue
        .slice(0, 40)
        .map(
          (site) => `<button type="button" class="unit-row alarm" data-site="${site.id}">
            <i></i><span>${site.id}</span><em>${(site.flagged || []).join(" ")}</em>
          </button>`,
        )
        .join("")
    : `<p class="muted">Every chart in this view is inside its limits.</p>`;

  const areaHtml = [...(data.stations || [])]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((station) => {
      const bad = flaggedByStation.get(station.id) || 0;
      return `<button type="button" class="metro-row" data-station="${station.id}">
        <span>${station.name}</span>
        <em>${fmt(station.units)}</em>
        <b class="${bad ? "flag" : "muted"}">${bad || "—"}</b>
      </button>`;
    })
    .join("");

  const gridNet = (fleet.grid_in_kw || 0) - (fleet.grid_out_kw || 0);
  panelBody.innerHTML = `
    <h2>Fleet</h2>
    <div class="sub">${
      data.dispatch
        ? `<span class="key ${data.dispatch.signal}"><i></i>call ${data.dispatch.signal} ${fmt(data.dispatch.intensity, 2)}</span> · ${data.dispatch.source}`
        : ""
    }</div>
    <div class="stack ledger">
      ${row("units", fmt(fleet.units))}
      ${row("pushing", fmt(fleet.pushing))}
      ${row("pulling", fmt(fleet.pulling))}
      ${row("holding", fmt(fleet.holding))}
      ${row("offline", fmt(fleet.offline))}
    </div>
    <p class="muted note">${fmt(fleet.pushing)} + ${fmt(fleet.pulling)} + ${fmt(fleet.holding)} = ${fmt(fleet.units)}. Offline units are holding.</p>
    <div class="stack ledger">
      <h3>Power</h3>
      ${row("grid in", mw(fleet.grid_in_kw))}
      ${row("grid out", mw(fleet.grid_out_kw))}
      ${row("house load", mw(fleet.load_kw))}
      ${row("solar", mw(fleet.solar_kw))}
      ${row("car chargers", mw(fleet.ev_kw))}
      ${row("charge", mw(fleet.charge_kw))}
      ${row("discharge", mw(fleet.discharge_kw))}
      ${row("solar into batteries", mw(fleet.solar_charge_kw))}
      ${row("stored", `${fmt(fleet.stored_kwh, 0)} kWh`)}
    </div>
    <p class="muted note">Grid in − out is ${mw(gridNet)}. That is load + chargers − solar + solar into batteries + charge − discharge.</p>
    ${marketBlock(data)}
    ${actionBlock(data)}
    <div class="group">
      <h3>Codes</h3>
      <div class="code-key">
        ${(data.codes || [])
          .map(
            (code) => `<p class="code"><b>${code.chart_id}</b><span>${code.action}</span></p>`,
          )
          .join("")}
      </div>
    </div>
    <div class="group">
      <h3>Needs attention${queue.length ? `<span class="flag">${fmt(queue.length)}</span>` : ""}</h3>
      <div class="roster">${queueHtml}</div>
      ${queue.length > 40 ? `<p class="muted note">Showing the first 40.</p>` : ""}
    </div>
    <div class="group">
      <h3>Service areas<span>units · flagged</span></h3>
      <div class="metros">
        <button type="button" class="metro-row" data-station="all"><span>Whole state</span><em>${fmt(fleet.units)}</em><b class="muted">—</b></button>
        ${areaHtml}
      </div>
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
    ["add-ons", (m) => (m.addons || []).map((item) => `${item.addon_id} ${fmt(item.kw, 2)} kW`).join(", ") || "none"],
  ],
  panel: [
    ["load", (m) => `${fmt(m.load_kw, 2)} kW`],
    ["voltage", (m) => `${fmt(m.voltage_v, 1)} V`],
  ],
  base: [
    ["state of charge", (m) => `${fmt(m.soc_pct, 1)}%`, "soc_tracking"],
    ["energy stored", (m) => `${fmt(m.soc_kwh, 2)} of ${fmt(m.capacity_kwh, 1)} kWh`, "soc_tracking"],
    ["availability", (m) => m.availability || "online"],
    ["power limit", (m) => `${fmt(m.power_limit_kw, 1)} kW`],
    ["solar into battery", (m) => `${fmt(m.solar_charge_kw, 2)} kW`],
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
let diagramShape = null;

function flowOf(down, up) {
  if (down > 0.005) return { dir: 1, kw: down, tone: "pull" };
  if (up > 0.005) return { dir: -1, kw: up, tone: "push" };
  return { dir: 0, kw: 0, tone: "idle" };
}

function flowWidth(kw) {
  return (1.3 + Math.min(kw, 12) * 0.1).toFixed(2);
}

function flowPace(kw) {
  return `animation-duration:${Math.max(0.5, 2.1 - Math.min(kw, 11) * 0.14).toFixed(2)}s`;
}

function arrowDown(x, y, up, tone) {
  const t = 4.6;
  const base = up ? y + t + 1.5 : y - t - 1.5;
  return `<polygon class="head ${tone}" points="${x - t},${base} ${x + t},${base} ${x},${y}" />`;
}

function vFlow(id, top, bottom, flow) {
  const mid = (top + bottom) / 2;
  const rail = `<line class="rail" x1="${CX}" y1="${top}" x2="${CX}" y2="${bottom}" />`;
  const text = flow.dir ? `${fmt(flow.kw, 2)} kW` : "idle";
  const label = `<text class="flow-kw ${flow.tone}" data-flow="${id}" x="${CX + 14}" y="${mid}" dominant-baseline="middle">${text}</text>`;
  if (!flow.dir) return rail + label;
  const up = flow.dir < 0;
  const [from, to] = up ? [bottom, top] : [top, bottom];
  return `${rail}
    <line class="flow ${flow.tone}" data-line="${id}" x1="${CX}" y1="${from}" x2="${CX}" y2="${to}" stroke-width="${flowWidth(flow.kw)}" style="${flowPace(flow.kw)}" />
    ${arrowDown(CX, to, up, flow.tone)}${label}`;
}

function hFlow(y, left, right, kw) {
  const rail = `<line class="rail" x1="${left}" y1="${y}" x2="${right}" y2="${y}" />`;
  const head = `<polygon class="head hold" points="${right - 6},${y - 4.6} ${right - 6},${y + 4.6} ${right},${y} " />`;
  return `${rail}
    <line class="flow hold" data-line="panel" x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke-width="${flowWidth(kw)}" style="${flowPace(kw)}" />
    ${head}
    <text class="flow-kw hold" data-flow="panel" x="${(left + right) / 2}" y="${y - 11}" text-anchor="middle">${fmt(kw, 2)} kW</text>`;
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
    <text class="blk-note" data-note="${id}" x="${x + 16}" y="${y + 42}">${note}</text>
    ${opts.state ? `<circle class="blk-dot" cx="${x + w - 15}" cy="${y + 19}" r="3.2" />` : ""}
    ${opts.extra || ""}
  </g>`;
}

// Everything the diagram shows, computed once so the build and the in-place
// patch cannot drift apart.
function readUnit(site) {
  const m = site.metrics || {};
  const grid = m.grid || {};
  const meter = m.meter || {};
  const disco = m.disco || {};
  const house = m.panel || {};
  const base = m.base || {};
  const charts = site.charts || [];
  const stateOf = (id) => {
    const mine = charts.filter((chart) => chart.component === id);
    if (mine.some((chart) => chart.alarm)) return "flagged";
    if (mine.some((chart) => chart.warning)) return "watch";
    return "";
  };
  return {
    mode: modeOf(site),
    soc: Math.min(1, Math.max(0, (base.soc_pct ?? 0) / 100)),
    notes: {
      grid:
        grid.lmp_usd_mwh == null
          ? `${grid.signal || "hold"} · LMP pending`
          : `${grid.signal || "hold"} · ${fmt(grid.lmp_usd_mwh, 2)} $/MWh`,
      meter: `${fmt(meter.voltage_v, 1)} V`,
      disco: `${fmt(disco.frequency_hz, 3)} Hz · ${disco.contactor || "closed"}`,
      panel: `${fmt(house.load_kw, 2)} kW`,
      base: `${fmt(base.soc_pct, 1)}% · ${fmt(base.temp_c, 1)} °C`,
    },
    blocks: {
      grid: stateOf("grid"),
      meter: stateOf("meter"),
      disco: stateOf("disco"),
      panel: stateOf("panel"),
      base: stateOf("base"),
    },
    flows: {
      grid: flowOf(grid.in_kw, grid.out_kw),
      meter: flowOf(meter.in_kw, meter.out_kw),
      base: flowOf(base.charge_kw, base.discharge_kw),
      panel: { dir: 1, kw: house.load_kw || 0, tone: "hold" },
    },
  };
}

function diagram(site, view) {
  const barX = DIA.bx + 16;
  const barW = DIA.bw - 32;
  const socBar = `
    <rect class="soc-track" x="${barX}" y="${ROWS.base + 58}" width="${barW}" height="5" rx="2.5" />
    <rect class="soc-fill ${view.mode}" data-soc="1" x="${barX}" y="${ROWS.base + 58}" width="${(barW * view.soc).toFixed(1)}" height="5" rx="2.5" />`;

  return `<svg viewBox="0 0 ${DIA.w} ${DIA.h}" class="diagram">
    <text class="rail-cap" x="${CX}" y="10" text-anchor="middle">substation · transformer · ${site.load_zone}</text>
    <line class="rail dotted" x1="${CX}" y1="18" x2="${CX}" y2="${ROWS.grid}" />

    ${block("grid", ROWS.grid, "Grid", view.notes.grid, { state: view.blocks.grid })}
    ${vFlow("grid", ROWS.grid + DIA.bh, ROWS.meter, view.flows.grid)}

    ${block("meter", ROWS.meter, "Meter", view.notes.meter, { state: view.blocks.meter })}
    ${vFlow("meter", ROWS.meter + DIA.bh, ROWS.disco, view.flows.meter)}

    ${block("disco", ROWS.disco, "Disco", view.notes.disco, { state: view.blocks.disco })}
    ${hFlow(ROWS.disco + DIA.bh / 2, DIA.bx + DIA.bw, DIA.px, view.flows.panel.kw)}
    ${block("panel", ROWS.disco, "Panel", view.notes.panel, { x: DIA.px, w: DIA.pw, state: view.blocks.panel })}
    ${vFlow("base", ROWS.disco + DIA.bh, ROWS.base, view.flows.base)}

    ${block("base", ROWS.base, "Base", view.notes.base, { h: DIA.baseH, extra: socBar, state: view.blocks.base })}
  </svg>`;
}

// Anything that changes the shape of the drawing. Numbers alone are patched in
// place, so the flow animation is not restarted on every poll.
function diagramKey(site, view) {
  return [
    site.id,
    component,
    view.mode,
    ...Object.entries(view.blocks).map(([id, state]) => `${id}:${state}`),
    ...Object.entries(view.flows).map(([id, flow]) => `${id}:${flow.dir}:${flow.tone}`),
  ].join("|");
}

function patchDiagram(holder, view) {
  for (const [id, text] of Object.entries(view.notes)) {
    const node = holder.querySelector(`[data-note="${id}"]`);
    if (node) node.textContent = text;
  }
  for (const [id, flow] of Object.entries(view.flows)) {
    const label = holder.querySelector(`[data-flow="${id}"]`);
    if (label) label.textContent = flow.dir ? `${fmt(flow.kw, 2)} kW` : "idle";
    const line = holder.querySelector(`[data-line="${id}"]`);
    if (line) line.setAttribute("stroke-width", flowWidth(flow.kw));
  }
  const fill = holder.querySelector("[data-soc]");
  if (fill) fill.setAttribute("width", ((DIA.bw - 32) * view.soc).toFixed(1));
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
  const tone = chart.alarm ? "flag" : chart.warning ? "watch" : "muted";
  const detail = open
    ? `<div class="chart-facts">
        ${row("measured", `${fmt(chart.measured, 3)} ${chart.unit}`)}
        ${row("expected", `${fmt(chart.expected, 3)} ${chart.unit}`)}
        ${row("residual", `${fmt(chart.value, 3)} ${chart.unit}`)}
        ${row("sigma", fmt(chart.sigma, 3))}
        ${row("limits", `${fmt(chart.lcl, 3)} to ${fmt(chart.ucl, 3)}`)}
        ${row("code", chart.chart_id)}
        ${row("family", chart.family)}
      </div>`
    : "";
  const resolution = chart.alarm && chart.action ? `<p class="action">${chart.action}</p>` : "";
  return `<div class="chart${open ? " open" : ""}" id="chart-${chart.chart_id}">
    <button type="button" class="chart-head" data-chart="${chart.chart_id}">
      <h3>${chart.title}<span>${fmt(chart.value, 2)} ${chart.unit}</span></h3>
    </button>
    ${chartSvg(chart)}
    <p class="${tone}">${chart.chart_id} · ${status} · z ${fmt(chart.z, 1)}</p>
    ${resolution}
    ${detail}
  </div>`;
}

// The charts hanging off the other blocks, so a sparse tab still tells you
// where the rest of the unit is and gets you there in one click.
function elsewhere(site) {
  const rest = (site.charts || []).filter((chart) => chart.component !== component);
  if (!rest.length) return "";
  const rows = rest
    .map((chart) => {
      const tone = chart.alarm ? "flag" : chart.warning ? "watch" : "muted";
      const status = chart.alarm ? "alarm" : chart.warning ? "watch" : "in control";
      const name = (COMPONENTS.find((item) => item.id === chart.component) || {}).name || chart.component;
      return `<button type="button" class="else-row" data-component="${chart.component}" data-chart="${chart.chart_id}">
        <span>${chart.title}</span>
        <em>${name}</em>
        <i class="${tone}">${status}</i>
        <b>${fmt(chart.value, 2)} ${chart.unit}</b>
      </button>`;
    })
    .join("");
  return `<div class="dt-else">
    <div class="dt-cap">elsewhere on this unit</div>
    ${rows}
  </div>`;
}

function renderUnit() {
  const site = unitDetail;
  if (!modal.open || !site) return;
  const spec = COMPONENTS.find((item) => item.id === component) || COMPONENTS[0];
  const metrics = (site.metrics || {})[component] || {};
  const charts = (site.charts || []).filter((chart) => chart.component === component);
  const mode = modeOf(site);

  document.getElementById("unit-id").textContent = site.id;
  document.getElementById("unit-sub").textContent =
    `${site.city} · ${site.station_name || site.station || site.load_zone} · load ×${fmt(site.load_scale, 2)} · ${fmt(site.temp_center_c, 1)} °C baseline`
    + (site.instrumented ? " · full-rate telemetry" : "");
  document.getElementById("unit-mode").className = `mode ${mode}`;
  document.getElementById("unit-mode").innerHTML = `<i></i>${mode}`;

  const view = readUnit(site);
  const holder = document.getElementById("unit-diagram");
  const key = diagramKey(site, view);
  if (key === diagramShape) {
    patchDiagram(holder, view);
  } else {
    holder.innerHTML = diagram(site, view);
    diagramShape = key;
  }

  const tabs = COMPONENTS.map(
    (item) => `<button type="button" data-component="${item.id}" class="${item.id === component ? "on" : ""}">${item.name}</button>`,
  ).join("");
  const rows = METRIC_ROWS[component];
  const split = rows.length > 4;

  const detail = document.getElementById("unit-detail");
  const scrolled = detail.scrollTop;
  detail.innerHTML = `
    <div class="chips tabs">${tabs}</div>
    <h3 class="dt-name">${spec.name}</h3>
    <p class="dt-role">${spec.role}</p>
    <div class="stack${split ? " split" : ""}"${split ? ` style="--rows:${Math.ceil(rows.length / 2)}"` : ""}>${rows
      .map(([label, format, chartId]) => metricRow(label, format(metrics), chartId))
      .join("")}</div>
    <div class="dt-charts">
      <div class="dt-cap">control charts${charts.length ? "" : " — none on this component"}</div>
      ${charts.length
        ? charts.map(chartCard).join("")
        : `<div class="dt-empty">
            <p>Nothing is charted here.</p>
            <p class="muted">The ${spec.name.toLowerCase()} is a pass-through in this model. Charts hang off the meter, the disco, and the base.</p>
          </div>`}
    </div>
    ${elsewhere(site)}
    ${usageBlock(site)}
  `;
  detail.scrollTop = scrolled;
}

async function loadUnit(id) {
  try {
    const response = await fetch(api(`/api/site/${encodeURIComponent(id)}`));
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    return null;
  }
}

async function openUnit(id, block = null) {
  selected = id;
  const detail = await loadUnit(id);
  if (!detail) return;
  unitDetail = detail;
  const flagged = (detail.charts || []).find((chart) => chart.alarm) || (detail.charts || []).find((chart) => chart.warning);
  const known = COMPONENTS.some((item) => item.id === block);
  component = known ? block : flagged ? flagged.component : "base";
  expanded = new Set(flagged ? [flagged.chart_id] : []);
  if (!modal.open) modal.showModal();
  if (location.hash.slice(1) !== id) history.replaceState(null, "", `#${id}`);
  renderUnit();
  if (payload) renderScene(payload);
}

modal.addEventListener("close", () => {
  history.replaceState(null, "", location.pathname);
});

panelToggle.addEventListener("click", () => {
  panelOpen = !panelOpen;
  document.querySelector("main").classList.toggle("collapsed", !panelOpen);
  panelToggle.setAttribute("aria-expanded", panelOpen ? "true" : "false");
  panelToggle.textContent = panelOpen ? "hide" : "fleet";
});

panel.addEventListener("toggle", (event) => {
  if (event.target.dataset.fold === "actions") actionsOpen = event.target.open;
}, true);

panel.addEventListener("click", (event) => {
  if (!payload || event.target.closest("#panel-toggle") || event.target.closest("summary")) return;
  const unit = event.target.closest("[data-site]");
  if (unit) {
    openUnit(unit.dataset.site);
    return;
  }
  const areaHit = event.target.closest("[data-station]");
  if (areaHit) {
    const id = areaHit.dataset.station;
    if (id === "all") {
      focusMetro(null);
      return;
    }
    const station = (payload.stations || []).find((item) => item.id === id);
    if (station) focusStation(station);
  }
});

modal.addEventListener("click", (event) => {
  if (event.target === modal) {
    modal.close();
    return;
  }
  const blockHit = event.target.closest("[data-component]");
  const chartHit = event.target.closest("[data-chart]");
  if (blockHit && !chartHit) {
    component = blockHit.dataset.component;
    renderUnit();
    return;
  }
  if (chartHit) {
    const id = chartHit.dataset.chart;
    // A jump from another component has to switch tabs before it can scroll.
    const jump = blockHit && blockHit.dataset.component !== component;
    if (jump) component = blockHit.dataset.component;
    if (jump || chartHit.dataset.scroll) expanded.add(id);
    else if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    renderUnit();
    if (jump || chartHit.dataset.scroll) {
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
  renderUnit();
});

document.getElementById("unit-close").addEventListener("click", () => modal.close());

// Screen positions are cached per camera move. At thousands of units, projecting
// on every pointer event is the difference between smooth and not.
function ensureScreen() {
  if (screen || !payload?.sites?.length) return screen;
  const rect = canvas.getBoundingClientRect();
  const out = new Float32Array(payload.sites.length * 2);
  const vector = new THREE.Vector3();
  camera.updateMatrixWorld();
  for (let index = 0; index < payload.sites.length; index += 1) {
    const site = payload.sites[index];
    vector
      .set((site.lon - ORIGIN.lon) * LON_SCALE, NODE_Y, ORIGIN.lat - site.lat)
      .project(camera);
    out[index * 2] = (vector.x * 0.5 + 0.5) * rect.width;
    out[index * 2 + 1] = (-vector.y * 0.5 + 0.5) * rect.height;
  }
  screen = out;
  return screen;
}

const POINTER = new THREE.Vector3();

function screenPoint(lat, lon, rect) {
  POINTER.set((lon - ORIGIN.lon) * LON_SCALE, NODE_Y, ORIGIN.lat - lat).project(camera);
  return {
    x: (POINTER.x * 0.5 + 0.5) * rect.width,
    y: (-POINTER.y * 0.5 + 0.5) * rect.height,
  };
}

function nearestOf(items, x, y, rect, limit) {
  let best = null;
  let bestDist = limit;
  for (const item of items || []) {
    const point = screenPoint(item.lat, item.lon, rect);
    const dist = Math.hypot(point.x - x, point.y - y);
    if (dist < bestDist) {
      bestDist = dist;
      best = item;
    }
  }
  return best;
}

function placeHash(next) {
  if (modal.open) return;
  if ((location.hash || "") === next) return;
  history.replaceState(null, "", next || location.pathname);
}

function focusMetro(metro) {
  focusedStation = null;
  if (!metro) {
    focusPoint = { x: 0, z: 0.4, distance: 20 };
    if (location.hash.startsWith("#metro/") || location.hash.startsWith("#station/")) placeHash("");
  } else {
    const point = project(metro.lat, metro.lon, 0);
    focusPoint = { x: point.x, z: point.z, distance: 1.7 };
    placeHash(`#metro/${metro.id}`);
  }
  if (payload) renderScene(payload);
}

function stepBack() {
  const station = (payload?.stations || []).find((item) => item.id === focusedStation);
  const metro = station && (payload.metros || []).find((item) => item.id === station.metro);
  if (metro) {
    focusMetro(metro);
    return;
  }
  focusMetro(null);
}

function focusStation(station) {
  focusedStation = station.id;
  const point = project(station.lat, station.lon, 0);
  focusPoint = { x: point.x, z: point.z, distance: 0.36 };
  if (payload) renderScene(payload);
  placeHash(`#station/${station.id}`);
}

function pointerTarget(event) {
  if (!payload) return null;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  camera.updateMatrixWorld();
  if (viewDistance() < 8) {
    const station = nearestOf(payload.stations, x, y, rect, 22);
    if (station) return { kind: "station", station };
  } else {
    const metro = nearestOf(payload.metros, x, y, rect, 26);
    if (metro) return { kind: "metro", metro };
  }
  const site = nearestSite(event.clientX, event.clientY);
  return site ? { kind: "site", site } : null;
}

function nearestSite(clientX, clientY) {
  const points = ensureScreen();
  if (!points) return null;
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  let best = null;
  let bestDist = 16;
  for (let index = 0; index < payload.sites.length; index += 1) {
    const dist = Math.hypot(points[index * 2] - x, points[index * 2 + 1] - y);
    if (dist < bestDist) {
      bestDist = dist;
      best = payload.sites[index];
    }
  }
  return best;
}

canvas.addEventListener("pointermove", (event) => {
  const hit = pointerTarget(event);
  if (!hit) {
    tip.hidden = true;
    canvas.style.cursor = "grab";
    return;
  }
  tip.hidden = false;
  if (hit.kind === "metro") {
    const stations = (payload.stations || []).filter((item) => item.metro === hit.metro.id).length;
    tip.innerHTML = `<b>${hit.metro.name}</b><br>${fmt(hit.metro.units)} units · ${fmt(stations)} substations`;
  } else if (hit.kind === "station") {
    tip.innerHTML = `<b>${hit.station.name}</b> distribution substation<br>${fmt(hit.station.units)} units supply it`;
  } else {
    const site = hit.site;
    const station = (payload.stations || []).find((item) => item.id === site.station);
    tip.innerHTML = `<b>${site.id}</b> ${modeOf(site)} · ${fmt(site.soc_pct, 0)}%${
      station ? `<br>supplies ${station.name}` : ""
    }${site.flagged?.length ? `<br>${site.flagged.join(", ")}` : ""}`;
  }
  tip.style.left = `${event.clientX + 14}px`;
  tip.style.top = `${event.clientY + 14}px`;
  canvas.style.cursor = "pointer";
});

canvas.addEventListener("pointerleave", () => {
  tip.hidden = true;
});

canvas.addEventListener("click", (event) => {
  const hit = pointerTarget(event);
  if (!hit) return;
  tip.hidden = true;
  if (hit.kind === "metro") {
    focusMetro(hit.metro);
    return;
  }
  if (hit.kind === "station") {
    focusStation(hit.station);
    return;
  }
  openUnit(hit.site.id);
});

controls.addEventListener("change", () => {
  screen = null;
  if (payload) {
    renderUnits(payload);
    renderStations(payload);
  }
});

function resize() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== width || canvas.height !== height) {
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
    screen = null;
  }
}

async function poll() {
  try {
    const response = await fetch(api("/api/scene"));
    payload = await response.json();
    renderScene(payload);
    renderStats(payload);
    renderPanel(payload);
    if (modal.open && selected) {
      unitDetail = (await loadUnit(selected)) || unitDetail;
      renderUnit();
    }
  } catch (error) {
    panelBody.innerHTML = `<p class="muted">Scene unavailable. ${error.message}</p>`;
  }
}

const GOAL = new THREE.Vector3();

function glide() {
  if (!focusPoint) return;
  GOAL.set(focusPoint.x, 0, focusPoint.z);
  controls.target.lerp(GOAL, 0.1);
  const offset = camera.position.clone().sub(controls.target).setLength(focusPoint.distance);
  camera.position.lerp(controls.target.clone().add(offset), 0.1);
  screen = null;
  if (controls.target.distanceTo(GOAL) < 0.02) focusPoint = null;
}

const backButton = document.getElementById("back");

function renderBack() {
  const zoomed = Boolean(focusedStation) || (focusPoint && focusPoint.distance < 8) || viewDistance() < 8;
  if (!zoomed || !payload) {
    backButton.hidden = true;
    return;
  }
  const station = (payload.stations || []).find((item) => item.id === focusedStation);
  const metro = station && (payload.metros || []).find((item) => item.id === station.metro);
  backButton.hidden = false;
  backButton.textContent = metro ? `back to ${metro.name}` : "back to Texas";
}

backButton.addEventListener("click", stepBack);

function frame() {
  resize();
  glide();
  renderBack();
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// A unit id in the hash opens that battery, so a link points at one cabinet.
// Add a block, as in #hou-0002/disco, and it opens on that block.
// #metro/austin flies the camera to that city, close enough to see the substations.
poll().then(() => {
  const [wanted, block] = decodeURIComponent(location.hash.slice(1)).split("/");
  if (wanted === "metro" && block) {
    const metro = (payload.metros || []).find((item) => item.id === block);
    if (metro) focusMetro(metro);
    return;
  }
  if (wanted === "station" && block) {
    const station = (payload.stations || []).find((item) => item.id === block);
    if (station) focusStation(station);
    return;
  }
  if (wanted) openUnit(wanted, block);
});
setInterval(poll, 5000);
frame();
