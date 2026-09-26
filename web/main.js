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
const folds = { now: true, agent: false, attention: false };
let screen = null;
let focusPoint = null;
let focusedStation = null;
let focusedMetro = null;
let stageStarted = 0;
let stageRadius = 0.05;
let stageSpan = { x: 0.05, z: 0.05 };
let stageT = 1;
let fillHold = false;
let cityStarted = 0;
let cityT = 1;
let cityHold = false;

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
const placed = new Float32Array(UNIT_CAP * 3);
const shown = new Uint8Array(UNIT_CAP);
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

function easeOut(value) {
  const t = Math.min(1, Math.max(0, value));
  return 1 - (1 - t) ** 3;
}

function arcCurve(from, to) {
  const mid = from.clone().add(to).multiplyScalar(0.5);
  mid.y += from.distanceTo(to) * 0.7 + 0.04;
  return new THREE.QuadraticBezierCurve3(from, mid, to);
}

const TINT = new THREE.Color();

function stationSpread(stations) {
  const spread = new Map();
  if (!focusedMetro || focusedStation) return spread;
  const group = (stations || []).filter((station) => station.metro === focusedMetro);
  group.forEach((station, index) => {
    const delay = (index / Math.max(group.length, 1)) * 0.55;
    spread.set(station.id, {
      homes: cityT >= 1 ? 1 : easeOut((cityT - delay) / 0.45),
      mark: cityT >= 1 ? 1 : easeOut((cityT - delay) / 0.22),
    });
  });
  return spread;
}

function stationOrigin(stationId, data, centers) {
  let origin = centers.get(stationId);
  if (origin) return origin;
  const station = (data.stations || []).find((item) => item.id === stationId);
  origin = station ? project(station.lat, station.lon, NODE_Y) : null;
  if (origin) centers.set(stationId, origin);
  return origin;
}

function renderUnits(data) {
  const positions = particles.geometry.attributes.position;
  const colors = particles.geometry.attributes.color;
  const spread = stationSpread(data.stations);
  const centers = new Map();
  shown.fill(0);
  let drawn = 0;
  let marked = false;
  for (let index = 0; index < data.sites.length; index += 1) {
    const site = data.sites[index];
    if (focusedStation && site.station !== focusedStation) continue;
    const point = project(site.lat, site.lon, NODE_Y);
    let x = point.x;
    let y = point.y;
    let z = point.z;
    TINT.setHex(COLOR[modeOf(site)]);
    const opening = spread.get(site.station);
    if (opening && site.metro === focusedMetro && opening.homes < 1) {
      const origin = stationOrigin(site.station, data, centers) || point;
      x = origin.x + (point.x - origin.x) * opening.homes;
      z = origin.z + (point.z - origin.z) * opening.homes;
    } else if (focusedStation) {
      const delay = (drawn % 20) / 20 * 0.28;
      const local = easeOut((stageT - delay) / 0.72);
      const fill = frameFill();
      const sx = 1 + (fill.x - 1) * local;
      const sz = 1 + (fill.z - 1) * local;
      const origin = stationOrigin(site.station, data, centers) || point;
      x = origin.x + (point.x - origin.x) * sx;
      z = origin.z + (point.z - origin.z) * sz;
    }
    placed[index * 3] = x;
    placed[index * 3 + 1] = y;
    placed[index * 3 + 2] = z;
    shown[index] = 1;
    positions.setXYZ(drawn, x, y, z);
    colors.setXYZ(drawn, TINT.r, TINT.g, TINT.b);
    drawn += 1;
    if (site.id === selected) {
      marked = true;
      if (focusedStation) {
        pick.visible = false;
      } else {
        const halfWorld = Math.max(viewDistance(), 0.2) * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
        const halfPx = Math.max(canvas.clientHeight, 1) * 0.5;
        pick.scale.setScalar(Math.max(0.02, (halfWorld * (6 / halfPx)) / 0.056));
        pick.position.set(x, y, z);
        pick.visible = true;
      }
    }
  }
  particles.geometry.setDrawRange(0, drawn);
  positions.needsUpdate = true;
  colors.needsUpdate = true;
  if (!marked) pick.visible = false;
  screen = null;
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
  const show = dist < 8 || Boolean(focusedStation);
  const spread = stationSpread(data.stations);
  for (const hub of hubs.values()) hub.group.visible = !show;
  const target = controls.target;
  const reach = 0.28 + dist * 0.08;
  for (const station of data.stations || []) {
    const entry = ensureStation(station);
    if (focusedStation) {
      entry.group.visible = false;
      continue;
    }
    const near = Math.hypot(entry.group.position.x - target.x, entry.group.position.z - target.z);
    const opening = spread.get(station.id);
    const mark = opening ? opening.mark : 1;
    entry.group.visible = show && near < reach + 0.15 && mark > 0.04;
    const size = Math.max(0.006, Math.min(0.014, 0.004 * dist)) * mark;
    entry.mark.scale.set(size, size, 1);
    entry.mark.material.color.setHex(0xd5dbe2);
    fitLabel(entry.label, Math.min(0.11, 0.028 * dist));
    entry.label.visible = show && dist < 4.5 && near < reach && mark > 0.82;
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

function spark(points, key) {
  const width = 210;
  const height = 32;
  const values = points.map((point) => Number(point[key]));
  const times = points.map((point) => Date.parse(point.ts));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const start = Math.min(...times);
  const end = Math.max(...times);
  const spanT = end - start || 1;
  const xAt = (index) => ((times[index] - start) / spanT) * width;
  const yAt = (value) => height - 2 - ((value - min) / span) * (height - 4);
  const actual = [];
  const forecast = [];
  points.forEach((point, index) => (point.kind === "forecast" ? forecast : actual).push(index));
  const path = (indexes) => indexes
    .map((index, step) => `${step ? "L" : "M"}${xAt(index).toFixed(1)},${yAt(values[index]).toFixed(1)}`)
    .join(" ");
  let forecastPath = "";
  if (forecast.length && actual.length) {
    const start = actual[actual.length - 1];
    forecastPath = `M${xAt(start).toFixed(1)},${yAt(values[start]).toFixed(1)} ${forecast
      .map((index) => `L${xAt(index).toFixed(1)},${yAt(values[index]).toFixed(1)}`)
      .join(" ")}`;
  }
  const nowX = actual.length ? xAt(actual[actual.length - 1]) : null;
  return { actual: path(actual), forecast: forecastPath, nowX, width, height };
}

function renderDay(data) {
  const host = document.getElementById("day");
  const points = (data && data.day) || [];
  const actuals = points.filter((point) => point.kind !== "forecast");
  const latest = actuals[actuals.length - 1];
  if (!latest) {
    host.innerHTML = `<p class="day-kicker">24h</p><p class="day-row"><span>demand</span><b>—</b></p>`;
    return;
  }
  const demand = spark(points, "demand_mw");
  const price = spark(points, "rate_usd_mwh");
  const basis = latest.rate_basis === "ercot" ? `<span class="ercot">ERCOT</span>` : "";
  const line = (drawn, tone) => `<svg class="day-svg" viewBox="0 0 ${drawn.width} ${drawn.height}" aria-hidden="true">
      ${drawn.nowX === null ? "" : `<line class="day-now" x1="${drawn.nowX.toFixed(1)}" y1="0" x2="${drawn.nowX.toFixed(1)}" y2="${drawn.height}" />`}
      <path class="${tone}" d="${drawn.actual}" />
      ${drawn.forecast ? `<path class="day-forecast" d="${drawn.forecast}" />` : ""}
    </svg>`;
  host.innerHTML = `
    <p class="day-kicker">24h</p>
    <p class="day-row"><span>demand</span><b>${fmt(latest.demand_mw)} MW</b></p>
    ${line(demand, "day-demand")}
    <p class="day-row"><span>price</span><b>${fmt(latest.rate_usd_mwh, 0)} $/MWh ${basis}</b></p>
    ${line(price, "day-price")}
  `;
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
  const stamp = fleet.ts || "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[Number(stamp.slice(5, 7)) - 1] || "";
  const clock = stamp.length >= 19 ? `${month} ${Number(stamp.slice(8, 10))} ${stamp.slice(11, 19)}` : "—";
  document.getElementById("clock").innerHTML = `sim <b>${clock}</b>`;
}

function chartClock(ms) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Chicago",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const part = (type) => parts.find((item) => item.type === type)?.value || "";
  return `${part("day")} ${part("hour")}:${part("minute")}`;
}

function chartSvg(chart) {
  const series = chart.series?.length ? chart.series : [chart.value];
  const sigma = Math.abs(chart.sigma) || Math.abs(chart.ucl) / 3 || 1;
  const span = sigma * 3.4;
  const width = 360;
  const plotBottom = 96;
  const height = 114;
  const plot = width - 34;
  const windowMs = 30 * 60 * 60 * 1000;
  const stepMs = (chart.series_seconds || 60) * 1000;
  const end = Date.parse(chart.ts);
  const timed = Number.isFinite(end);
  const start = timed ? end - windowMs : 0;
  const xAt = (index) => {
    if (!timed) return series.length === 1 ? plot / 2 : (index / (series.length - 1)) * plot;
    const t = end - (series.length - 1 - index) * stepMs;
    return Math.max(0, Math.min(plot, ((t - start) / windowMs) * plot));
  };
  const yAt = (value) => {
    const clamped = Math.max(-span, Math.min(span, value));
    return plotBottom / 2 - (clamped / span) * (plotBottom / 2 - 8);
  };
  const stroke = chart.in_control ? (chart.warning ? "#d8b46a" : "#cfc6ba") : "#e15b4c";
  const runs = [];
  let run = [];
  series.forEach((value, index) => {
    if (value == null || Number.isNaN(Number(value))) {
      if (run.length) runs.push(run.join(" "));
      run = [];
      return;
    }
    run.push(`${xAt(index).toFixed(1)},${yAt(Number(value)).toFixed(1)}`);
  });
  if (run.length) runs.push(run.join(" "));
  const lines = runs
    .map((points) => `<polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="1.6" />`)
    .join("");
  let lastIndex = series.length - 1;
  while (lastIndex >= 0 && (series[lastIndex] == null || Number.isNaN(Number(series[lastIndex])))) lastIndex -= 1;
  const dot = lastIndex >= 0
    ? `<circle cx="${xAt(lastIndex).toFixed(1)}" cy="${yAt(Number(series[lastIndex])).toFixed(1)}" r="2.6" fill="${stroke}" />`
    : "";
  const guide = (value, label, color, dash) => {
    const y = yAt(value).toFixed(1);
    const pattern = dash ? ` stroke-dasharray="${dash}"` : "";
    const name = label
      ? `<text x="${width - 2}" y="${y}" text-anchor="end" dominant-baseline="middle" fill="${color}" font-size="9">${label}</text>`
      : "";
    return `<line x1="0" x2="${plot}" y1="${y}" y2="${y}" stroke="${color}"${pattern} />${name}`;
  };
  const axis = (x, text, anchor) =>
    `<text x="${x}" y="${height - 2}" text-anchor="${anchor}" fill="#8d887f" font-size="9">${text}</text>`;
  const left = timed ? chartClock(start) : "−30h";
  const mid = timed ? chartClock(start + windowMs / 2) : "−15h";
  const right = timed ? chartClock(end) : "now";
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="30 hours">
    ${guide(sigma, "1σ", "#4a4e57", "")}
    ${guide(-sigma, "", "#4a4e57", "")}
    ${guide(sigma * 2, "2σ", "#5c616b", "3 3")}
    ${guide(-sigma * 2, "", "#5c616b", "3 3")}
    ${guide(sigma * 3, "3σ", "#7a6258", "5 4")}
    ${guide(-sigma * 3, "", "#7a6258", "5 4")}
    <line x1="0" x2="${plot}" y1="${yAt(0).toFixed(1)}" y2="${yAt(0).toFixed(1)}" stroke="#6d675c" />
    ${lines}
    ${dot}
    ${axis(0, left, "start")}
    ${axis(plot / 2, mid, "middle")}
    ${axis(plot, right, "end")}
  </svg>`;
}

function row(label, text) {
  return `<p><span>${label}</span><b>${text}</b></p>`;
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

function decisionLabel(action) {
  const payload = action.payload || {};
  if (payload.chart_id) return `${actionTitle(action)} · ${payload.chart_id}`;
  if (payload.reason === "price") return `${payload.signal || "hold"} · price`;
  return actionTitle(action);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

function markLine(clause) {
  let line = escapeHtml(clause.line || "");
  const mark = escapeHtml(clause.threshold || "");
  if (mark && line.includes(mark)) line = line.replace(mark, `<mark>${mark}</mark>`);
  return `<p class="because">${line}</p>`;
}

function clausesFor(action) {
  const payload = action.payload || {};
  const stored = payload.because || action.because || [];
  if (stored.length) return stored;
  if (payload.chart_id) return [{ line: "alarm beyond ±3σ. Follow the procedure.", threshold: "±3σ" }];
  if (payload.reason !== "price") return [];
  const note = action.note || "";
  const clauses = [];
  const price = note.match(/Price (\d+)/);
  if (price) {
    const rate = Number(price[1]);
    if (rate >= 70) clauses.push({ line: `price ${rate} $/MWh ≥ 70 $/MWh`, threshold: "70 $/MWh" });
    else if (rate <= 40) clauses.push({ line: `price ${rate} $/MWh ≤ 40 $/MWh`, threshold: "40 $/MWh" });
  }
  if (note.includes("day peak")) clauses.push({ line: "day peak, rank ≥ 0.75", threshold: "0.75" });
  if (note.includes("day trough")) clauses.push({ line: "day trough, rank ≤ 0.35", threshold: "0.35" });
  if (note.includes("day ramp")) clauses.push({ line: "forecast mean ≥ 1.08× now", threshold: "1.08×" });
  return clauses;
}

function reasonHtml(action) {
  const because = clausesFor(action);
  const marked = because.map(markLine).join("");
  const note = action.note || "";
  const joined = because.map((clause) => clause.line).filter(Boolean).join("; ");
  let extra = "";
  if (note && joined && note.startsWith(joined)) {
    const rest = note.slice(joined.length).replace(/^[.\s]+/, "");
    if (rest) extra = `<p class="because">${escapeHtml(rest)}</p>`;
  } else if (note && !because.some((clause) => clause.line && note.includes(clause.line))) {
    extra = `<p class="because procedure">${escapeHtml(note)}</p>`;
  }
  return marked + extra;
}

function nowBlock(data) {
  const market = data.market || {};
  const basis = market.rate_basis === "ercot" ? "ERCOT" : "simulated";
  const shape = data.shape && data.shape.shape ? data.shape.shape : "—";
  const call = data.dispatch
    ? `${data.dispatch.signal} ${fmt(data.dispatch.intensity, 2)} · ${data.dispatch.source}`
    : "—";
  const because = (data.dispatch && data.dispatch.because) || [];
  return `<div class="stack ledger">
      ${row("price", `${fmt(market.rate_usd_mwh, 1)} $/MWh · ${basis}`)}
      ${row("day", shape)}
      ${row("fleet call", call)}
    </div>
    ${because.map(markLine).join("")}`;
}

const WHO = { sim: "agent", api: "user", llm: "model", rules: "fleet" };

function actionEntry(action) {
  return {
    ts: action.ts || "",
    site: action.site_id,
    actor: action.actor,
    title: decisionLabel(action),
    status: action.status || "",
    because: (action.payload || {}).because || [],
    note: action.note || "",
    payload: action.payload || {},
  };
}

function agentCases(data) {
  const open = (status) => status === "pending" || status === "active";
  return (data.actions || [])
    .filter((action) => action.actor === "sim" || action.actor === "llm" || action.actor === "api")
    .map(actionEntry)
    .sort((a, b) => {
      const rank = Number(open(b.status)) - Number(open(a.status));
      if (rank) return rank;
      return b.ts.localeCompare(a.ts);
    });
}

function caseCard(entry, opts = {}) {
  const status = entry.status || "";
  const who = WHO[entry.actor] || entry.actor || "";
  const when = (entry.ts || "").slice(11, 16);
  const meta = [who, when].filter(Boolean).join(" · ");
  const site = opts.site === false
    ? ""
    : `<button type="button" class="case-site" data-site="${escapeHtml(entry.site)}">${escapeHtml(entry.site)}</button>`;
  const pill = status ? `<span class="status ${escapeHtml(status)}">${escapeHtml(status)}</span>` : "";
  const hit = opts.site === false ? "" : ` data-site="${escapeHtml(entry.site)}"`;
  return `<article class="case status-${escapeHtml(status)}"${hit}>
      <div class="case-head"><b class="case-action">${escapeHtml(entry.title)}</b>${pill}</div>
      <p class="case-meta">${site}${site && meta ? "<span> · </span>" : ""}${meta ? `<span>${escapeHtml(meta)}</span>` : ""}</p>
      ${reasonHtml(entry)}
    </article>`;
}

function agentBlock(data) {
  const entries = agentCases(data);
  const rows = entries.length
    ? entries.map((entry) => caseCard(entry)).join("")
    : `<p class="muted">No agent cases. An alarming code, a price call, or a posted action opens one.</p>`;
  return `<div class="cases">${rows}</div>`;
}

function fold(name, title, body) {
  return `<details class="fold" data-fold="${name}"${folds[name] ? " open" : ""}>
    <summary>${title}</summary>
    <div class="fold-body">${body}</div>
  </details>`;
}

let logOpen = true;

function logLine(row) {
  const time = (row.ts || "").slice(11, 19);
  const moved = row.discharge_kw > 0.01
    ? `${fmt(row.discharge_kw, 2)} kW out`
    : row.charge_kw > 0.01
      ? `${fmt(row.charge_kw, 2)} kW in`
      : "idle";
  const codes = (row.out_of_control || row.alarming || []).join(" ");
  const word = row.availability === "offline" ? "offline" : row.state;
  return `<p class="log-line ${word}">
    <span>${time}</span>
    <b>${word}</b>
    <em>${row.signal || "hold"} · ${row.source || "rules"}</em>
    <em>${fmt(row.soc_pct, 0)}%</em>
    <em>${fmt(row.load_kw, 2)} kW load</em>
    <em>${moved}</em>
    ${row.grid === "off" ? `<em class="flag">grid off</em>` : ""}
    ${codes ? `<em class="flag">${codes}</em>` : ""}
  </p>`;
}

function logBlock(site) {
  const rows = site.state_log || [];
  if (!rows.length) return "";
  return `<details class="unit-log" data-log ${logOpen ? "open" : ""}>
    <summary>state log <span>${rows.length}</span></summary>
    <div class="log-body">${rows.map(logLine).join("")}</div>
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
  const queue = [];
  for (const site of sites) {
    if (site.alarm) queue.push(site);
  }

  const queueHtml = queue.length
    ? queue
        .slice(0, 40)
        .map(
          (site) => `<button type="button" class="alert" data-site="${site.id}">
            <span class="status alarm">maintenance</span>
            <span class="alert-id">${site.id}</span>
            <em>${(site.flagged || []).join(" ")}</em>
          </button>`,
        )
        .join("")
    : `<p class="muted">No maintenance alerts.</p>`;

  const openCases = agentCases(data).filter((entry) => entry.status === "pending" || entry.status === "active").length;
  panelBody.innerHTML = `
    ${fold("now", "Now", nowBlock(data))}
    ${fold("agent", `Agent cases${openCases ? `<span class="count">${fmt(openCases)}</span>` : ""}`, agentBlock(data))}
    ${fold(
      "attention",
      `Maintenance alerts${queue.length ? `<span class="flag">${fmt(queue.length)}</span>` : ""}`,
      `<div class="alerts">${queueHtml}</div>${queue.length > 40 ? `<p class="muted note">Showing the first 40.</p>` : ""}`,
    )}
  `;
}

/* ---------- unit modal ---------- */

const COMPONENTS = [
  { id: "grid", name: "Grid", role: "Service entrance. The meter reading and the utility call live on this box." },
  { id: "disco", name: "Disco", role: "Raspberry Pi at the disconnect." },
  { id: "panel", name: "Electrical panel", role: "House load downstream of the battery interconnect." },
  { id: "base", name: "Base", role: "Battery cabinet." },
];

// Rows are [label, metrics object, formatter, chart_id]. A row with a chart opens that chart.
const METRIC_ROWS = {
  grid: [
    ["in", "meter", (m) => `${fmt(m.in_kw, 2)} kW`, "disco_meter_delta"],
    ["out", "meter", (m) => `${fmt(m.out_kw, 2)} kW`, "disco_meter_delta"],
  ],
  disco: [
    ["voltage", "disco", (m) => `${fmt(m.voltage_v, 1)} V`, "disco_voltage"],
    ["frequency", "disco", (m) => `${fmt(m.frequency_hz, 3)} Hz`, "frequency"],
  ],
  panel: [
    ["load", "panel", (m) => `${fmt(m.load_kw, 2)} kW`],
  ],
  base: [
    ["state of charge", "base", (m) => `${fmt(m.soc_pct, 1)}%`, "soc_tracking"],
    ["temperature", "base", (m) => `${fmt(m.temp_c, 1)} °C`, "base_temp"],
    ["charge", "base", (m) => `${fmt(m.charge_kw, 2)} kW`],
    ["discharge", "base", (m) => `${fmt(m.discharge_kw, 2)} kW`],
  ],
};

const RESOLVE = {
  disco_meter_delta: "Compare the disco to the billing meter. If they still disagree, post scheduled service. Past ±3σ the agent posts that and the cabinet stays offline until the window ends.",
  disco_voltage: "Post scheduled service and check the connection at the disconnect. The agent posts it once the chart is past ±3σ.",
  frequency: "Leave the cabinet. Frequency is the grid, not this battery. The chart is marked and nothing is posted.",
  base_temp: "Past ±3σ the agent holds the pack, then posts scheduled service.",
  soc_tracking: "Past ±3σ the agent posts scheduled service. The reported charge has left the coulomb count.",
};

const DIA = { w: 360, h: 460, bx: 36, bw: 152, bh: 58, baseH: 80, px: 248, pw: 102 };
const ROWS = { grid: 56, disco: 210, base: 360 };
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
    if (mine.some((chart) => chart.in_control === false)) return "flagged";
    if (mine.some((chart) => chart.warning)) return "watch";
    return "";
  };
  const gridOff = (site.snapshot && site.snapshot.grid) === "off" || disco.islanded;
  return {
    mode: modeOf(site),
    soc: Math.min(1, Math.max(0, (base.soc_pct ?? 0) / 100)),
    notes: {
      grid: gridOff ? "off" : `${grid.signal || "hold"} · ${fmt(meter.in_kw, 2)} kW in`,
      disco: `${fmt(disco.frequency_hz, 3)} Hz · ${disco.contactor || "closed"}`,
      panel: `${fmt(house.load_kw, 2)} kW`,
      base: `${fmt(base.soc_pct, 1)}% · ${fmt(base.temp_c, 1)} °C`,
    },
    blocks: {
      grid: gridOff ? "flagged" : (stateOf("meter") || stateOf("grid")),
      disco: stateOf("disco"),
      panel: stateOf("panel"),
      base: stateOf("base"),
    },
    flows: {
      grid: flowOf(meter.in_kw, meter.out_kw),
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
    ${vFlow("grid", ROWS.grid + DIA.bh, ROWS.disco, view.flows.grid)}

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

function armButton(site, chartId, label) {
  const on = (site.armed || []).includes(chartId);
  return `<button type="button" class="arm${on ? " on" : ""}" data-arm="${chartId}" data-on="${on ? "1" : "0"}">${on ? "clear" : "trigger"} ${label}</button>`;
}

function resolveNote(site, chartId) {
  const text = RESOLVE[chartId];
  if (!text) return "";
  const chart = (site.charts || []).find((item) => item.chart_id === chartId);
  const hot = chart && chart.in_control === false ? " flag" : "";
  return `<p class="note resolve${hot}">${text}</p>`;
}

function decisionFooter(site) {
  const call = site.agent_call;
  const place = call && call.day && call.day !== "mid" ? ` · ${call.day}` : "";
  const openActions = (site.actions || []).filter((row) => row.status === "pending" || row.status === "active");
  const covered = openActions.some((row) => ((row.payload || {}).because || []).length);
  const callMarks = call && !covered ? (call.because || []).map(markLine).join("") : "";
  const callLine = call
    ? `<p class="muted note">Agent ${call.signal}${place} · ${fmt(call.rate, 0)} $/MWh · ${fmt(call.expected_kw, 2)} kW from ${call.source}</p>
       ${callMarks}`
    : "";
  const openReasons = openActions.map((row) => caseCard(actionEntry(row), { site: false })).join("");
  return `${callLine}${openReasons ? `<div class="cases">${openReasons}</div>` : ""}`;
}

function simControls(site) {
  const gridOff = (site.snapshot && site.snapshot.grid) === "off";
  if (component === "grid") {
    const market = payload && payload.market;
    const shape = payload && payload.shape;
    const basis = market && market.rate_basis === "ercot" ? "ERCOT" : "simulated";
    const day = shape && shape.shape ? ` · ${shape.shape}` : "";
    const context = market
      ? `<p class="muted note">${fmt(market.rate_usd_mwh, 0)} $/MWh ${basis}${day}</p>`
      : "";
    return `<div class="arms">
        <button type="button" class="arm${gridOff ? " hot" : ""}" data-grid="${gridOff ? "1" : "0"}">${gridOff ? "grid on" : "turn off the grid"}</button>
        ${armButton(site, "disco_meter_delta", "meter agreement")}
        <button type="button" class="arm" data-signal="push">push</button>
        <button type="button" class="arm" data-signal="pull">pull</button>
        <button type="button" class="arm" data-signal="hold">hold</button>
      </div>
      ${resolveNote(site, "disco_meter_delta")}
      ${context}
      ${decisionFooter(site)}`;
  }
  if (component === "disco") {
    return `<div class="arms">
        ${armButton(site, "disco_voltage", "voltage")}
        ${armButton(site, "frequency", "frequency")}
      </div>
      ${resolveNote(site, "disco_voltage")}
      ${resolveNote(site, "frequency")}
      ${decisionFooter(site)}`;
  }
  if (component === "panel") return decisionFooter(site);
  return `<div class="arms">
      ${armButton(site, "soc_tracking", "state of charge")}
      ${armButton(site, "base_temp", "temperature")}
      <button type="button" class="arm" data-ticket="1">maintenance ticket</button>
    </div>
    ${resolveNote(site, "soc_tracking")}
    ${resolveNote(site, "base_temp")}
    ${decisionFooter(site)}`;
}

async function postSim(node) {
  if (!unitDetail) return;
  let url = "/api/agent";
  let body = { site_id: unitDetail.id };
  if (node.hasAttribute("data-arm")) {
    body.chart_id = node.dataset.arm;
    body.armed = node.dataset.on !== "1";
  } else if (node.hasAttribute("data-grid")) {
    body.grid = node.dataset.grid !== "0";
  } else if (node.hasAttribute("data-signal")) {
    url = "/api/actions";
    const signal = node.dataset.signal;
    body = {
      site_id: unitDetail.id,
      kind: "set_signal",
      note: `Forced ${signal} on this base for one hour.`,
      payload: {
        signal,
        intensity: signal === "hold" ? 0 : 1,
        because: [{ line: `Forced ${signal} on this base for one hour.`, threshold: signal }],
      },
    };
  } else if (node.hasAttribute("data-ticket")) {
    url = "/api/actions";
    body = {
      site_id: unitDetail.id,
      kind: "scheduled_service",
      note: "Maintenance ticket. Follow scheduled service.",
      payload: {
        because: [{ line: "Maintenance ticket. Follow scheduled service.", threshold: "scheduled service" }],
      },
    };
  }
  try {
    const response = await fetch(api(url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) return;
    const detail = await loadUnit(unitDetail.id);
    if (detail) {
      unitDetail = detail;
      renderUnit();
    }
  } catch (error) {
    /* the next poll retries the view */
  }
}

function metricRow(label, text, chartId, charts) {
  if (!chartId) return row(label, text);
  const chart = (charts || []).find((item) => item.chart_id === chartId);
  const hot = chart && chart.in_control === false ? " hot" : "";
  const on = expanded.has(chartId) ? " on" : "";
  return `<button type="button" class="metric-link${on}${hot}" data-chart="${chartId}" data-scroll="1">
    <span>${label}</span><b>${text}</b>
  </button>`;
}

function chartCard(chart) {
  const status = chart.in_control ? (chart.warning ? "watch" : "in control") : chart.rules.join(", ");
  const tone = chart.in_control === false ? "flag" : chart.warning ? "watch" : "muted";
  const resolution = chart.alarm && chart.action ? `<p class="action">${chart.action}</p>` : "";
  return `<div class="chart open" id="chart-${chart.chart_id}">
    <h3>${chart.title}<span>${fmt(chart.value, 2)} ${chart.unit}</span></h3>
    ${chartSvg(chart)}
    <p class="${tone}">${status}</p>
    ${resolution}
  </div>`;
}

function renderUnit() {
  const site = unitDetail;
  if (!modal.open || !site) return;
  const spec = COMPONENTS.find((item) => item.id === component) || COMPONENTS[0];
  const rows = METRIC_ROWS[component] || [];
  const linked = new Set(rows.map((item) => item[3]).filter(Boolean));
  const charts = (site.charts || []).filter((chart) => linked.has(chart.chart_id) && expanded.has(chart.chart_id));
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
  const metrics = site.metrics || {};

  const detail = document.getElementById("unit-detail");
  const scrolled = detail.scrollTop;
  detail.innerHTML = `
    <div class="chips tabs">${tabs}</div>
    <h3 class="dt-name">${spec.name}</h3>
    <p class="dt-role">${spec.role}</p>
    ${simControls(site)}
    <div class="stack">${rows
      .map(([label, source, format, chartId]) => metricRow(label, format(metrics[source] || {}), chartId, site.charts))
      .join("")}</div>
    ${charts.length ? `<div class="dt-charts">${charts.map(chartCard).join("")}</div>` : ""}
    ${logBlock(site)}
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
  const flagged = (detail.charts || []).find((chart) => chart.in_control === false)
    || (detail.charts || []).find((chart) => chart.alarm)
    || (detail.charts || []).find((chart) => chart.warning);
  if (block === "meter") block = "grid";
  const known = COMPONENTS.some((item) => item.id === block);
  const fromChart = flagged ? flagged.component : "base";
  component = known ? block : fromChart;
  if (component === "meter") component = "grid";
  expanded = new Set(flagged ? [flagged.chart_id] : []);
  if (!modal.open) modal.showModal();
  if (location.hash.slice(1) !== id) history.replaceState(null, "", `#${id}`);
  renderUnit();
  if (payload) renderScene(payload);
}

modal.addEventListener("toggle", (event) => {
  if (event.target.dataset.log !== undefined) logOpen = event.target.open;
}, true);

modal.addEventListener("close", () => {
  history.replaceState(null, "", location.pathname);
});

panelToggle.addEventListener("click", () => {
  panelOpen = !panelOpen;
  document.querySelector("main").classList.toggle("collapsed", !panelOpen);
  panelToggle.setAttribute("aria-expanded", panelOpen ? "true" : "false");
  panelToggle.textContent = panelOpen ? "hide" : "cases";
});

panel.addEventListener("toggle", (event) => {
  const name = event.target.dataset.fold;
  if (name in folds) folds[name] = event.target.open;
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
  const armHit = event.target.closest("[data-arm], [data-grid], [data-signal], [data-ticket]");
  if (armHit) {
    postSim(armHit);
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
    if (jump) component = blockHit.dataset.component === "meter" ? "grid" : blockHit.dataset.component;
    if (expanded.has(id) && !chartHit.dataset.scroll) expanded = new Set();
    else expanded = new Set([id]);
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
    if (!shown[index]) {
      out[index * 2] = -9999;
      out[index * 2 + 1] = -9999;
      continue;
    }
    vector.set(placed[index * 3], placed[index * 3 + 1], placed[index * 3 + 2]).project(camera);
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

function nearestStation(x, y, rect) {
  let best = null;
  let bestDist = 42;
  for (const station of payload.stations || []) {
    const entry = stationMarks.get(station.id);
    if (entry && !entry.group.visible) continue;
    const point = screenPoint(station.lat, station.lon, rect);
    const dist = Math.hypot(point.x - x, point.y - y);
    if (dist < bestDist) {
      bestDist = dist;
      best = station;
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
  const arriving = !focusedStation;
  focusedStation = null;
  if (!metro) {
    focusedMetro = null;
    cityT = 1;
    cityHold = false;
    focusPoint = { x: 0, z: 0.4, distance: 20, pose: "state" };
    if (location.hash.startsWith("#metro/") || location.hash.startsWith("#station/")) placeHash("");
  } else {
    focusedMetro = metro.id;
    if (arriving) {
      cityT = 0;
      cityHold = true;
      cityStarted = 0;
    }
    const point = project(metro.lat, metro.lon, 0);
    focusPoint = { x: point.x, z: point.z, distance: 1.7, pose: "city" };
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

function patchRadius(station) {
  const origin = project(station.lat, station.lon, 0);
  let radius = 0.012;
  for (const site of payload?.sites || []) {
    if (site.station !== station.id) continue;
    const point = project(site.lat, site.lon, 0);
    radius = Math.max(radius, Math.hypot(point.x - origin.x, point.z - origin.z));
  }
  return radius;
}

function frameDistance(radius) {
  const half = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const height = (radius * 1.12) / half;
  return Math.max(0.14, height / 0.983);
}

function frameFill() {
  const pose = poseOffset({ pose: "station" });
  const length = Math.hypot(pose[0], pose[1]) || 1;
  const height = (pose[0] / length) * frameDistance(stageRadius);
  const halfV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const aspect = Math.max(camera.aspect, 0.5);
  const halfH = height * halfV;
  const halfW = halfH * aspect;
  return {
    x: Math.max(1, (halfW * 0.94) / Math.max(stageSpan.x, 0.008)),
    z: Math.max(1, (halfH * 0.92) / Math.max(stageSpan.z, 0.008)),
  };
}

function measureSpan(station) {
  const origin = project(station.lat, station.lon, 0);
  let maxX = 0.008;
  let maxZ = 0.008;
  for (const site of payload?.sites || []) {
    if (site.station !== station.id) continue;
    const point = project(site.lat, site.lon, 0);
    maxX = Math.max(maxX, Math.abs(point.x - origin.x));
    maxZ = Math.max(maxZ, Math.abs(point.z - origin.z));
  }
  return { x: maxX, z: maxZ };
}

function focusStation(station) {
  focusedStation = station.id;
  focusedMetro = station.metro;
  cityT = 1;
  cityHold = false;
  fillHold = true;
  stageStarted = 0;
  stageT = 0;
  const point = project(station.lat, station.lon, 0);
  stageRadius = patchRadius(station);
  stageSpan = measureSpan(station);
  focusPoint = {
    x: point.x,
    z: point.z,
    distance: frameDistance(stageRadius),
    pose: "station",
  };
  if (payload) renderScene(payload);
  placeHash(`#station/${station.id}`);
}

function pointerTarget(event) {
  if (!payload) return null;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  camera.updateMatrixWorld();
  if (focusedStation) {
    const site = nearestSite(x, y);
    return site ? { kind: "site", site } : null;
  }
  if (viewDistance() < 8) {
    const site = nearestSite(x, y);
    const owner = site && (payload.stations || []).find((item) => item.id === site.station);
    if (owner) return { kind: "station", station: owner };
    const station = nearestStation(x, y, rect);
    if (station) return { kind: "station", station };
    return null;
  }
  const metro = nearestOf(payload.metros, x, y, rect, 26);
  if (metro) return { kind: "metro", metro };
  const site = nearestSite(x, y);
  return site ? { kind: "site", site } : null;
}

function nearestSite(x, y) {
  const points = ensureScreen();
  if (!points) return null;
  let best = null;
  let bestDist = 16;
  for (let index = 0; index < payload.sites.length; index += 1) {
    if (!shown[index]) continue;
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
    renderDay(payload);
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
const DESIRED = new THREE.Vector3();
const stageCard = document.getElementById("stage");
const stageTitle = document.getElementById("stage-title");
const stageSub = document.getElementById("stage-sub");
const stageCounts = document.getElementById("stage-counts");

function poseOffset(point) {
  if (point.pose === "station") return [0.983, 0.182];
  if (point.pose === "city") return [0.94, 0.342];
  if (point.pose === "state") return [0.822, 0.57];
  return null;
}

function glide() {
  if (!focusPoint) return;
  GOAL.set(focusPoint.x, 0, focusPoint.z);
  const pace = focusPoint.pose === "station" ? 0.065 : focusPoint.pose === "city" ? 0.08 : 0.1;
  controls.target.lerp(GOAL, pace);
  const pose = poseOffset(focusPoint);
  if (pose) {
    const length = Math.hypot(pose[0], pose[1]) || 1;
    DESIRED.set(0, (pose[0] / length) * focusPoint.distance, (pose[1] / length) * focusPoint.distance);
  } else {
    DESIRED.copy(camera.position).sub(controls.target).setLength(focusPoint.distance);
  }
  camera.position.lerp(controls.target.clone().add(DESIRED), pace);
  screen = null;
  const offset = camera.position.clone().sub(controls.target);
  const posed = !pose || offset.angleTo(DESIRED) < 0.06;
  if (
    controls.target.distanceTo(GOAL) < 0.015
    && Math.abs(offset.length() - focusPoint.distance) < 0.03
    && posed
  ) {
    focusPoint = null;
  }
}

function renderStage(station) {
  if (!station) {
    stageCard.hidden = true;
    return;
  }
  if (stageCard.hidden || stageCard.dataset.id !== station.id) {
    stageCard.dataset.id = station.id;
    stageCard.hidden = false;
    stageCard.classList.remove("in");
    void stageCard.offsetWidth;
    stageCard.classList.add("in");
  }
  const metro = (payload.metros || []).find((item) => item.id === station.metro);
  let pushing = 0;
  let pulling = 0;
  let holding = 0;
  let flagged = 0;
  for (const site of payload.sites) {
    if (site.station !== station.id) continue;
    if (site.alarm) flagged += 1;
    if (site.state === "push") pushing += 1;
    else if (site.state === "pull") pulling += 1;
    else holding += 1;
  }
  stageTitle.textContent = station.name;
  stageSub.textContent = `${metro ? metro.name : "ERCOT"} · ${fmt(station.units)} homes`;
  stageCounts.innerHTML = `
    <span class="key push"><i></i>${fmt(pushing)} pushing</span>
    <span class="key pull"><i></i>${fmt(pulling)} pulling</span>
    <span class="key hold"><i></i>${fmt(holding)} holding</span>
    <span class="key alarm"><i></i>${fmt(flagged)} flagged</span>
  `;
}

function present() {
  const station = focusedStation && payload
    ? (payload.stations || []).find((item) => item.id === focusedStation)
    : null;
  controls.minDistance = station ? 0.12 : 1.2;
  if (!station && focusedMetro) {
    if (cityHold && !focusPoint) {
      cityHold = false;
      cityStarted = performance.now();
      cityT = 0;
    }
    if (!cityHold) {
      const next = Math.min(1, (performance.now() - cityStarted) / 2400);
      if (next !== cityT) {
        cityT = next;
        if (payload) {
          renderUnits(payload);
          renderStations(payload);
        }
      }
    }
    stageT = 1;
    if (!stageCard.hidden || particles.material.size !== 6) {
      stageCard.hidden = true;
      particles.material.size = 6;
    }
    return;
  }
  if (!station) {
    stageT = 1;
    cityT = 1;
    if (!stageCard.hidden || particles.material.size !== 6) {
      stageCard.hidden = true;
      particles.material.size = 6;
      if (payload) renderUnits(payload);
    }
    return;
  }
  if (fillHold && !focusPoint) {
    fillHold = false;
    stageStarted = performance.now();
    stageT = 0;
  }
  if (!fillHold) stageT = Math.min(1, (performance.now() - stageStarted) / 1100);
  particles.material.size = 6 + 4 * easeOut(stageT);
  renderUnits(payload);
  renderStations(payload);
  renderStage(station);
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
  present();
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
