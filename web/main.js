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

const FAMILIES = ["all", "measurement", "thermal", "electrical", "energy", "response"];
const NODE_Y = 0.02;
const UNIT_CAP = 20000;
const LABEL_SHARE = 0.03;
const LAND = new THREE.Color(COLOR.land);

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
let family = "all";
let screen = null;
let focusPoint = null;

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

function labelSprite(text, share) {
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
  const scale = 1.5 + Math.min(0.9, share * 4);
  sprite.scale.set(scale, scale * 0.25, 1);
  return sprite;
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

const arcs = new THREE.LineSegments(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75 }),
);
arcs.renderOrder = 2;
scene.add(arcs);

const constraintArcs = new THREE.LineSegments(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: COLOR.constraint, transparent: true, opacity: 0.5 }),
);
scene.add(constraintArcs);

// Direction only. The distance scales with how far the metro's units spread.
const LABEL_OFFSET = {
  n: [0, -1],
  s: [0, 1],
  e: [1, 0],
  w: [-1, 0],
  ne: [0.75, -0.75],
  nw: [-0.75, -0.75],
  sw: [-0.75, 0.75],
  se: [0.75, 0.75],
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
    const label = labelSprite(metro.name, share);
    const [dx, dz] = LABEL_OFFSET[metro.label] || LABEL_OFFSET.n;
    // Clear the cloud: a Rayleigh scale reaches about 1.6 scales for most units.
    const reach = 0.5 + (metro.radius_km || 15) / 110.574 * 1.9;
    label.position.set(dx * reach * 1.1, 0.02, dz * reach);
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

function focused(site) {
  if (family === "all") return true;
  return (site.families || []).includes(family);
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
    if (!focused(site)) TINT.lerp(LAND, 0.78);
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
  const label = labelSprite(station.name, 0.04);
  label.scale.set(0.42, 0.1, 1);
  label.position.set(0, 0.04, 0.06);
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
    entry.group.visible = show && near < reach + 0.15;
    const size = Math.max(0.006, Math.min(0.014, 0.004 * dist));
    entry.mark.scale.set(size, size, 1);
    const labelWidth = Math.min(0.26, 0.06 * dist);
    entry.label.scale.set(labelWidth, labelWidth * 0.24, 1);
    entry.label.visible = show && dist < 4.5 && near < reach;
  }
}

// One arc, for the selected battery, tying it back to its metro. Thousands of
// arcs is a hairball, and even one per flagged unit reads as noise rather than
// information. The red rings already say which units need a person.
function renderArcs(data) {
  const positions = [];
  const colors = [];
  const site = data.sites.find((item) => item.id === selected);
  const hub = site && hubs.get(site.metro);
  if (site && hub) {
    const curve = arcCurve(hub.point, project(site.lat, site.lon, NODE_Y));
    const samples = curve.getPoints(20);
    const tint = new THREE.Color(COLOR[modeOf(site)]);
    for (let index = 0; index < samples.length - 1; index += 1) {
      for (const step of [index, index + 1]) {
        const point = samples[step];
        const along = step / (samples.length - 1);
        const shade = tint.clone().lerp(LAND, (1 - along) * 0.55);
        positions.push(point.x, point.y, point.z);
        colors.push(shade.r, shade.g, shade.b);
      }
    }
  }
  arcs.geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  arcs.geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  arcs.geometry.computeBoundingSphere();
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
  renderArcs(data);
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

function renderStats(data) {
  const grid = data.grid || {};
  const ercot = data.ercot || {};
  const fleet = data.fleet || {};
  const net = (fleet.discharge_kw || 0) - (fleet.charge_kw || 0);
  document.getElementById("stats").innerHTML = `
    <span>demand <b>${fmt(grid.demand_mw)} MW</b></span>
    <span>storage <b>${fmt(grid.storage_gen_mw)} MW</b></span>
    <span>fleet <b>${fmt(fleet.units)}</b></span>
    <span>net <b>${net >= 0 ? "+" : ""}${fmt(net / 1000, 2)} MW</b></span>
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
  return `<div class="group">
    <h3>Actions</h3>
    <div class="roster">${rows}</div>
    <p class="muted note">The disco tracks ${catalog || "add-ons"} on the home.</p>
  </div>`;
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
    panel.innerHTML = `<p class="muted">No batteries in this snapshot.</p>`;
    return;
  }
  const fleet = data.fleet || {};
  const chips = FAMILIES.map(
    (name) => `<button type="button" data-family="${name}" class="${name === family ? "on" : ""}">${name}</button>`,
  ).join("");

  const flaggedByMetro = new Map();
  const queue = [];
  for (const site of sites) {
    if (!site.alarm) continue;
    flaggedByMetro.set(site.metro, (flaggedByMetro.get(site.metro) || 0) + 1);
    if (focused(site)) queue.push(site);
  }
  const metroName = new Map((data.metros || []).map((metro) => [metro.id, metro.name]));

  const queueHtml = queue.length
    ? queue
        .slice(0, 40)
        .map(
          (site) => `<button type="button" class="unit-row alarm" data-site="${site.id}">
            <i></i><span>${site.id}</span><em>${(site.families || []).join(" ")}</em>
          </button>`,
        )
        .join("")
    : `<p class="muted">Every chart in this view is inside its limits.</p>`;

  const metroHtml = (data.metros || [])
    .map((metro) => {
      const bad = flaggedByMetro.get(metro.id) || 0;
      return `<button type="button" class="metro-row" data-metro="${metro.id}">
        <span>${metro.name}</span>
        <em>${fmt(metro.units)}</em>
        <b class="${bad ? "flag" : "muted"}">${bad || "—"}</b>
      </button>`;
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
    <div class="sub">${fmt(fleet.units)} batteries · <span class="key push"><i></i>${fmt(fleet.pushing)} pushing</span> · <span class="key pull"><i></i>${fmt(fleet.pulling)} pulling</span> · <span class="key hold"><i></i>${fmt(fleet.holding)} holding</span>${
      data.dispatch
        ? ` · <span class="key ${data.dispatch.signal}"><i></i>call ${data.dispatch.signal} ${fmt(data.dispatch.intensity, 2)}</span> · ${data.dispatch.source}`
        : ""
    }</div>
    <div class="chips">${chips}</div>
    ${marketBlock(data)}
    ${actionBlock(data)}
    <div class="group">
      <h3>Needs attention${queue.length ? `<span class="flag">${fmt(queue.length)}</span>` : ""}</h3>
      <div class="roster">${queueHtml}</div>
      ${queue.length > 40 ? `<p class="muted note">Showing the first 40.</p>` : ""}
    </div>
    <div class="group">
      <h3>Metros<span>units · flagged</span></h3>
      <div class="metros">
        <button type="button" class="metro-row" data-metro="all"><span>Whole state</span><em>${fmt(fleet.units)}</em><b class="muted">—</b></button>
        ${metroHtml}
      </div>
    </div>
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

panel.addEventListener("click", (event) => {
  if (!payload) return;
  const chip = event.target.closest("[data-family]");
  if (chip) {
    family = chip.dataset.family;
    renderScene(payload);
    renderPanel(payload);
    return;
  }
  const unit = event.target.closest("[data-site]");
  if (unit) {
    openUnit(unit.dataset.site);
    return;
  }
  const metroHit = event.target.closest("[data-metro]");
  if (metroHit) {
    const id = metroHit.dataset.metro;
    if (id === "all") {
      focusPoint = { x: 0, z: 0.4, distance: 20 };
      return;
    }
    const metro = (payload.metros || []).find((item) => item.id === id);
    if (metro) {
      const point = project(metro.lat, metro.lon, 0);
      focusPoint = { x: point.x, z: point.z, distance: 1.7 };
    }
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
  const site = nearestSite(event.clientX, event.clientY);
  if (!site) {
    tip.hidden = true;
    canvas.style.cursor = "grab";
    return;
  }
  tip.hidden = false;
  const station = (payload.stations || []).find((item) => item.id === site.station);
  tip.innerHTML = `<b>${site.id}</b> ${modeOf(site)} · ${fmt(site.soc_pct, 0)}%${
    station ? `<br>supplies ${station.name}` : ""
  }${site.flagged?.length ? `<br>${site.flagged.join(", ")}` : ""}`;
  tip.style.left = `${event.clientX + 14}px`;
  tip.style.top = `${event.clientY + 14}px`;
  canvas.style.cursor = "pointer";
});

canvas.addEventListener("pointerleave", () => {
  tip.hidden = true;
});

canvas.addEventListener("click", (event) => {
  const site = nearestSite(event.clientX, event.clientY);
  if (!site) return;
  tip.hidden = true;
  openUnit(site.id);
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
    panel.innerHTML = `<p class="muted">Scene unavailable. ${error.message}</p>`;
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

function frame() {
  resize();
  glide();
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
    if (metro) {
      const point = project(metro.lat, metro.lon, 0);
      focusPoint = { x: point.x, z: point.z, distance: 1.7 };
    }
    return;
  }
  if (wanted) openUnit(wanted, block);
});
setInterval(poll, 5000);
frame();
