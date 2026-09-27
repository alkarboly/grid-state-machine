import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { API_BASE } from "/config.js";
import { LON_SCALE, ORIGIN, TEXAS } from "/geo.js";

function api(path) {
  return `${API_BASE}${path}`;
}

const COLOR = {
  pull: 0xff9b3d,
  push: 0x4ed08a,
  hold: 0x8d95a3,
  alarm: 0xff4d5f,
  offline: 0x5f6672,
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
const folds = { now: true, fleet: false, maintenance: false, attention: false };
const seenVisits = new Set();

function revealVisits(data) {
  for (const action of data.actions || []) {
    if (action.kind !== "scheduled_service") continue;
    if (action.status !== "active" && action.status !== "pending") continue;
    if (!action.id || seenVisits.has(action.id)) continue;
    seenVisits.add(action.id);
    folds.maintenance = true;
  }
}
let screen = null;
let focusPoint = null;
let focusedStation = null;
let focusedMetro = null;
let stageStarted = 0;
let stageT = 1;
let fillHold = false;
let cityStarted = 0;
let cityT = 1;
let cityHold = false;
let metroStackSig = "";
let metroStack = null;
let areaStackSig = "";
let areaStack = null;

// City view lays every substation out as one row. The dots keep a fixed screen
// size, so these gaps are what stops a lane from reading as a single smear.
const STACK = {
  laneOffset: 0.062,
  laneGap: 0.026,
  laneStep: 0.0145,
  holdStep: 0.0125,
  rowStep: 0.013,
  rows: 6,
  holdDrift: 0.0022,
  holdLift: 0.0011,
  nameGap: 0.034,
  nameWidth: 0.07,
};

function metroRowGap(count) {
  return Math.max(0.082, Math.min(0.118, 0.8 / Math.max(count, 1)));
}

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

function labelSprite(text, options = {}) {
  const lines = String(text || "").toUpperCase().split(/\n+/).filter(Boolean);
  const size = options.size || 44;
  const weight = options.weight || 600;
  const padX = options.padX ?? 28;
  const padY = options.padY ?? 14;
  const lineHeight = options.lineHeight || 1.04;
  const color = options.color || "#8d887f";
  const element = document.createElement("canvas");
  const ctx = element.getContext("2d");
  const font = `${weight} ${size}px 'Segoe UI', sans-serif`;
  ctx.font = font;
  const widest = lines.reduce((max, line) => Math.max(max, ctx.measureText(line).width), 0);
  const width = Math.ceil(widest) + padX * 2;
  const height = Math.ceil(size * lineHeight * Math.max(lines.length, 1)) + padY * 2;
  element.width = width;
  element.height = height;
  ctx.font = font;
  if (options.backdrop) {
    const backdrop = typeof options.backdrop === "object" ? options.backdrop : {};
    const radius = backdrop.radius ?? 12;
    const line = backdrop.lineWidth ?? 2;
    const left = line * 0.5;
    const top = line * 0.5;
    const right = width - line * 0.5;
    const bottom = height - line * 0.5;
    ctx.beginPath();
    ctx.moveTo(left + radius, top);
    ctx.lineTo(right - radius, top);
    ctx.quadraticCurveTo(right, top, right, top + radius);
    ctx.lineTo(right, bottom - radius);
    ctx.quadraticCurveTo(right, bottom, right - radius, bottom);
    ctx.lineTo(left + radius, bottom);
    ctx.quadraticCurveTo(left, bottom, left, bottom - radius);
    ctx.lineTo(left, top + radius);
    ctx.quadraticCurveTo(left, top, left + radius, top);
    ctx.closePath();
    ctx.fillStyle = backdrop.fill || "rgba(14,16,20,0.9)";
    ctx.fill();
    ctx.lineWidth = line;
    ctx.strokeStyle = backdrop.stroke || "rgba(122,132,149,0.85)";
    ctx.stroke();
  }
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const step = size * lineHeight;
  const start = height / 2 - (step * (lines.length - 1)) / 2;
  lines.forEach((line, index) => {
    ctx.fillText(line, width / 2, start + index * step);
  });
  const texture = new THREE.CanvasTexture(element);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }),
  );
  sprite.userData.aspect = width / height;
  return sprite;
}

function stackStationName(name) {
  const text = String(name || "");
  const match = text.match(/^(.+?)\s+(\d+)$/);
  if (!match) return text;
  return `${match[1]}\n${match[2]}`;
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

function flowState(item, preferAction = false, forcedSignal = null) {
  if (!item) return "hold";
  if (forcedSignal === "push" || forcedSignal === "pull" || forcedSignal === "hold") return forcedSignal;
  const signal = item.signal;
  if (preferAction && item.source === "action" && (signal === "push" || signal === "pull" || signal === "hold")) {
    return signal;
  }
  return item.state || signal || "hold";
}

function gridOff(item) {
  return Boolean(item) && (item.grid === "off" || item.snapshot?.grid === "off");
}

function gridStamp(sites) {
  let stamp = "";
  for (const site of sites || []) if (site.grid === "off") stamp += `${site.id},`;
  return stamp;
}

function modeOf(item, preferAction = false, forcedSignal = null) {
  if (!item) return "hold";
  // A flagged chart, or an open contactor, stays red even while service has
  // the base offline, or it vanishes into the gray hold column.
  if (item.alarm || gridOff(item)) return "alarm";
  const availability = item.metrics?.base?.availability;
  if (item.offline || availability === "offline") return "offline";
  return flowState(item, preferAction, forcedSignal);
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

// A manual call that is still standing, newest first, so the latest one wins.
function signalOverrides(data) {
  const rows = (data.actions || [])
    .filter((action) => {
      if (action.kind !== "set_signal") return false;
      if (action.status !== "active" && action.status !== "pending") return false;
      const signal = action.payload?.signal;
      return signal === "push" || signal === "pull" || signal === "hold";
    })
    .sort((a, b) => (b.ts || "").localeCompare(a.ts || "") || (b.id || "").localeCompare(a.id || ""));
  const bySite = new Map();
  for (const action of rows) {
    if (action.site_id && !bySite.has(action.site_id)) bySite.set(action.site_id, action.payload.signal);
  }
  const stamp = rows
    .map((action) => `${action.site_id}:${action.status}:${action.payload?.signal || ""}:${action.ts || ""}`)
    .join("|");
  return { bySite, stamp };
}

// Where the three groups land for a block this tall. The side lanes start
// outside the widest hold column, which is what keeps them from running
// together however the fleet splits.
function laneShape(counts, rows) {
  const holdCols = counts.hold ? Math.ceil(counts.hold / rows) : 0;
  const holdReach = holdCols ? Math.ceil((holdCols - 1) / 2) * STACK.holdStep : 0;
  const laneOffset = Math.max(STACK.laneOffset, holdReach + STACK.laneGap);
  const reach = (count) => (count ? laneOffset + (Math.ceil(count / rows) - 1) * STACK.laneStep : 0);
  const pull = reach(counts.pull);
  const push = reach(counts.push);
  return {
    rows,
    laneOffset,
    holdReach,
    pull,
    push,
    left: Math.max(pull, holdReach),
    right: Math.max(push, holdReach),
    height: rows * STACK.rowStep,
  };
}

// Lays one group into a column block. `side` is -1 for pull and +1 for push;
// the hold column takes 0 and grows out from the middle.
function packBlock(indices, base, side, shape, targetX, targetZ) {
  for (let spot = 0; spot < indices.length; spot += 1) {
    const unit = indices[spot];
    const col = Math.floor(spot / shape.rows);
    const row = spot % shape.rows;
    const rowsHere = Math.min(shape.rows, indices.length - col * shape.rows);
    let x = base.x;
    if (side) x += side * (shape.laneOffset + col * STACK.laneStep);
    else if (col > 0) x += (col % 2 ? -1 : 1) * Math.ceil(col / 2) * STACK.holdStep;
    targetX[unit] = x;
    targetZ[unit] = base.z + (row - (rowsHere - 1) * 0.5) * STACK.rowStep;
  }
}

function sortLane(indices, sites) {
  indices.sort((a, b) => {
    const marked = (site) => Boolean(site.alarm) || site.grid === "off";
    const flagged = Number(marked(sites[b])) - Number(marked(sites[a]));
    if (flagged) return flagged;
    return sites[a].id.localeCompare(sites[b].id);
  });
}

function stackYard(data) {
  if (!focusedMetro || focusedStation) {
    metroStackSig = "";
    metroStack = null;
    return null;
  }
  const { bySite: overrides, stamp: overrideStamp } = signalOverrides(data);
  const stamp = (data.fleet || {}).ts || "";
  const signature = `${focusedMetro}|${stamp}|${data.sites.length}|${overrideStamp}|${gridStamp(data.sites)}`;
  if (signature === metroStackSig && metroStack) return metroStack;
  const stations = (data.stations || [])
    .filter((station) => station.metro === focusedMetro)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!stations.length) {
    metroStackSig = signature;
    metroStack = null;
    return null;
  }
  const metro = (data.metros || []).find((item) => item.id === focusedMetro);
  const center = metro
    ? project(metro.lat, metro.lon, NODE_Y)
    : stations.reduce((sum, station) => sum.add(project(station.lat, station.lon, NODE_Y)), new THREE.Vector3())
      .multiplyScalar(1 / stations.length);
  const rowGap = metroRowGap(stations.length);
  const span = rowGap * Math.max(stations.length - 1, 0);
  const stationRows = new Map();
  stations.forEach((station, index) => {
    const row = new THREE.Vector3(
      center.x,
      NODE_Y,
      center.z + (index * rowGap - span * 0.5),
    );
    const delay = (index / Math.max(stations.length, 1)) * 0.56;
    stationRows.set(station.id, { row, delay });
  });
  const lanes = new Map(stations.map((station) => [station.id, { pull: [], push: [], hold: [] }]));
  const targetX = new Float32Array(data.sites.length);
  const targetZ = new Float32Array(data.sites.length);
  const visible = new Uint8Array(data.sites.length);
  for (let index = 0; index < data.sites.length; index += 1) {
    const site = data.sites[index];
    if (site.metro !== focusedMetro) continue;
    const bucket = lanes.get(site.station);
    if (!bucket) continue;
    visible[index] = 1;
    const flow = flowState(site, true, overrides.get(site.id) || null);
    if (flow === "push") bucket.push.push(index);
    else if (flow === "pull") bucket.pull.push(index);
    else bucket.hold.push(index);
  }
  // Every row keeps the same lane positions, so the columns line up down the
  // whole city even when one substation is busier than the rest.
  const peak = { pull: 0, hold: 0, push: 0 };
  for (const bucket of lanes.values()) {
    peak.pull = Math.max(peak.pull, bucket.pull.length);
    peak.hold = Math.max(peak.hold, bucket.hold.length);
    peak.push = Math.max(peak.push, bucket.push.length);
  }
  const shape = laneShape(peak, STACK.rows);
  for (const [stationId, bucket] of lanes.entries()) {
    const row = stationRows.get(stationId);
    if (!row) continue;
    sortLane(bucket.pull, data.sites);
    sortLane(bucket.push, data.sites);
    sortLane(bucket.hold, data.sites);
    packBlock(bucket.pull, row.row, -1, shape, targetX, targetZ);
    packBlock(bucket.push, row.row, 1, shape, targetX, targetZ);
    packBlock(bucket.hold, row.row, 0, shape, targetX, targetZ);
  }
  const left = shape.left + STACK.nameGap + STACK.nameWidth;
  metroStack = {
    stationRows,
    targetX,
    targetZ,
    visible,
    overrides,
    nameX: -(shape.left + STACK.nameGap),
    // Where the whole block sits relative to the metro centre, so the camera
    // can frame what is actually drawn instead of guessing.
    center: new THREE.Vector3(center.x + (shape.right - left) * 0.5, NODE_Y, center.z),
    spanX: left + shape.right,
    spanZ: span + shape.height,
  };
  metroStackSig = signature;
  return metroStack;
}

// The open substation gets the same three groups, given the whole frame
// instead of one lane. The block is shaped to the window so it fills it.
function areaYard(data) {
  if (!focusedStation) {
    areaStackSig = "";
    areaStack = null;
    return null;
  }
  const { bySite: overrides, stamp: overrideStamp } = signalOverrides(data);
  const stamp = (data.fleet || {}).ts || "";
  const aspect = Math.max(camera.aspect, 0.5);
  const signature = `${focusedStation}|${stamp}|${data.sites.length}|${overrideStamp}|${aspect.toFixed(2)}|${gridStamp(data.sites)}`;
  if (signature === areaStackSig && areaStack) return areaStack;
  const station = (data.stations || []).find((item) => item.id === focusedStation);
  if (!station) {
    areaStackSig = signature;
    areaStack = null;
    return null;
  }
  const center = project(station.lat, station.lon, NODE_Y);
  const targetX = new Float32Array(data.sites.length);
  const targetZ = new Float32Array(data.sites.length);
  const bucket = { pull: [], push: [], hold: [] };
  for (let index = 0; index < data.sites.length; index += 1) {
    const site = data.sites[index];
    if (site.station !== focusedStation) continue;
    const flow = flowState(site, true, overrides.get(site.id) || null);
    if (flow === "push") bucket.push.push(index);
    else if (flow === "pull") bucket.pull.push(index);
    else bucket.hold.push(index);
  }
  const counts = { pull: bucket.pull.length, hold: bucket.hold.length, push: bucket.push.length };
  // Pick the block height whose proportions sit closest to the window, so the
  // homes use the frame instead of running off one edge of it.
  let shape = laneShape(counts, STACK.rows);
  let bestGap = Infinity;
  for (let rows = 4; rows <= 24; rows += 1) {
    const option = laneShape(counts, rows);
    const width = option.left + option.right;
    const gap = Math.abs(Math.log((width / option.height) / aspect));
    if (gap < bestGap) {
      bestGap = gap;
      shape = option;
    }
  }
  sortLane(bucket.pull, data.sites);
  sortLane(bucket.push, data.sites);
  sortLane(bucket.hold, data.sites);
  packBlock(bucket.pull, center, -1, shape, targetX, targetZ);
  packBlock(bucket.push, center, 1, shape, targetX, targetZ);
  packBlock(bucket.hold, center, 0, shape, targetX, targetZ);
  const pad = STACK.rowStep * 1.5;
  areaStack = {
    targetX,
    targetZ,
    overrides,
    center: new THREE.Vector3(center.x + (shape.right - shape.left) * 0.5, NODE_Y, center.z),
    spanX: shape.left + shape.right,
    spanZ: shape.height + pad * 2,
  };
  areaStackSig = signature;
  return areaStack;
}

function stationSpread(data) {
  const spread = new Map();
  if (!focusedMetro || focusedStation || stackYard(data)) return spread;
  const group = (data.stations || []).filter((station) => station.metro === focusedMetro);
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
  const yard = stackYard(data);
  const row = yard?.stationRows.get(stationId);
  if (row) {
    centers.set(stationId, row.row);
    return row.row;
  }
  const station = (data.stations || []).find((item) => item.id === stationId);
  origin = station ? project(station.lat, station.lon, NODE_Y) : null;
  if (origin) centers.set(stationId, origin);
  return origin;
}

const DRIFT = { x: 0, y: 0, z: 0 };

// Push and pull dots lean the way the power is going, hold dots breathe in
// place. The drift stays in world units, so it keeps the same proportion to
// the gaps whether the camera is over a city or over one substation.
function laneDrift(flow, index, now, progress, forced) {
  const wave = now + index * 0.61;
  DRIFT.x = 0;
  DRIFT.y = 0;
  DRIFT.z = 0;
  if (flow === "pull" || flow === "push") {
    const pulse = Math.abs(Math.sin(wave)) * (forced ? 0.0078 : 0.0034) * progress;
    DRIFT.x = flow === "push" ? pulse : -pulse;
    return DRIFT;
  }
  DRIFT.y = (0.0004 + Math.abs(Math.sin(wave * 0.5)) * STACK.holdLift) * progress;
  DRIFT.z = Math.sin(wave * 0.65) * STACK.holdDrift * progress;
  return DRIFT;
}

function renderUnits(data) {
  const positions = particles.geometry.attributes.position;
  const colors = particles.geometry.attributes.color;
  const yard = stackYard(data);
  const area = areaYard(data);
  const spread = stationSpread(data);
  const centers = new Map();
  const now = performance.now() * 0.0043;
  shown.fill(0);
  let drawn = 0;
  let marked = false;
  for (let index = 0; index < data.sites.length; index += 1) {
    const site = data.sites[index];
    if (focusedStation && site.station !== focusedStation) continue;
    if (yard && !yard.visible[index]) continue;
    const point = project(site.lat, site.lon, NODE_Y);
    let x = point.x;
    let y = point.y;
    let z = point.z;
    const lanes = yard || area;
    const forcedSignal = lanes ? (lanes.overrides?.get(site.id) || null) : null;
    const flow = flowState(site, Boolean(lanes), forcedSignal);
    TINT.setHex(COLOR[modeOf(site, Boolean(lanes), forcedSignal)]);
    if (yard) {
      const row = yard.stationRows.get(site.station);
      const delay = row ? row.delay : 0;
      const unfold = cityT >= 1 ? 1 : easeOut((cityT - delay) / 0.46);
      const targetX = yard.targetX[index];
      const targetZ = yard.targetZ[index];
      x = point.x + (targetX - point.x) * unfold;
      z = point.z + (targetZ - point.z) * unfold;
      if (unfold > 0.75) {
        const drift = laneDrift(flow, index, now, unfold, forcedSignal);
        x += drift.x;
        y += drift.y;
        z += drift.z;
      }
    } else if (area) {
      const delay = ((drawn % 24) / 24) * 0.3;
      const local = easeOut((stageT - delay) / 0.7);
      x = point.x + (area.targetX[index] - point.x) * local;
      z = point.z + (area.targetZ[index] - point.z) * local;
      if (local > 0.75) {
        const drift = laneDrift(flow, index, now, local, forcedSignal);
        x += drift.x;
        y += drift.y;
        z += drift.z;
      }
    } else {
      const opening = spread.get(site.station);
      if (opening && site.metro === focusedMetro && opening.homes < 1) {
        const origin = stationOrigin(site.station, data, centers) || point;
        x = origin.x + (point.x - origin.x) * opening.homes;
        z = origin.z + (point.z - origin.z) * opening.homes;
      }
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
      if (focusedStation || yard) {
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
  const label = labelSprite(stackStationName(station.name), {
    size: 38,
    padX: 22,
    padY: 13,
    lineHeight: 1.2,
    color: "#e7e1d6",
    backdrop: {
      fill: "rgba(16,17,20,0.82)",
      stroke: "rgba(103,113,132,0.42)",
      radius: 10,
      lineWidth: 1.2,
    },
  });
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
  const yard = stackYard(data);
  if (yard) {
    for (const hub of hubs.values()) hub.group.visible = false;
    const dist = viewDistance();
    const labelsOn = dist < 6 || cityT > 0.78;
    for (const station of data.stations || []) {
      const entry = ensureStation(station);
      const row = yard.stationRows.get(station.id);
      if (!row || station.metro !== focusedMetro) {
        entry.group.visible = false;
        continue;
      }
      const unfold = cityT >= 1 ? 1 : easeOut((cityT - row.delay) / 0.46);
      const geo = project(station.lat, station.lon, 0.025);
      entry.group.position.set(
        geo.x + (row.row.x - geo.x) * unfold,
        0.025,
        geo.z + (row.row.z - geo.z) * unfold,
      );
      entry.group.visible = unfold > 0.08;
      const size = (0.009 + Math.min(0.007, station.units / 16000)) * unfold;
      entry.mark.scale.set(size, size, 1);
      entry.mark.visible = false;
      entry.mark.material.color.setHex(0xe4e8ef);
      // Names line up in one column outside the widest pull lane, so no name
      // ever lands on a dot.
      entry.label.center.set(1, 0.5);
      entry.label.position.set(yard.nameX, 0.026, 0);
      fitLabel(entry.label, Math.min(0.08, 0.026 + dist * 0.008));
      entry.label.visible = labelsOn && unfold > 0.5;
    }
    return;
  }
  const dist = viewDistance();
  const show = dist < 8 || Boolean(focusedStation);
  const spread = stationSpread(data);
  for (const hub of hubs.values()) hub.group.visible = !show;
  const target = controls.target;
  const reach = 0.28 + dist * 0.08;
  for (const station of data.stations || []) {
    const entry = ensureStation(station);
    entry.group.position.copy(project(station.lat, station.lon, 0.025));
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
    entry.mark.visible = true;
    entry.mark.material.color.setHex(0xd5dbe2);
    entry.label.center.set(0.5, 1);
    entry.label.position.set(0, 0.04, 0.045);
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
  const basis = latest.rate_basis === "ercot" ? "" : `<span class="ercot">simulated</span>`;
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
  const ercot = data.ercot || {};
  const fleet = data.fleet || {};
  const netKw = (fleet.grid_in_kw || 0) - (fleet.grid_out_kw || 0);
  const mw = Math.abs(netKw) / 1000;
  const flow = mw < 0.005 ? "grid" : netKw < 0 ? "export" : "import";
  const feedDown = ercot.dashboard && ercot.dashboard !== "live";
  const feed = feedDown ? `<span>feed <b>${ercot.dashboard}</b></span>` : "";
  const flaggedN = (data.sites || []).reduce(
    (count, site) => count + (site.alarm || site.grid === "off" ? 1 : 0),
    0,
  );
  const flagged = flaggedN
    ? `<span class="flagged">flagged <b>${fmt(flaggedN)}</b></span>`
    : `<span>flagged <b>0</b></span>`;
  document.getElementById("stats").innerHTML = `
    <span>${flow} <b>${fmt(mw, 2)} MW</b></span>
    <span>soc <b>${fmt(fleet.mean_soc_pct, 0)}%</b></span>
    ${flagged}
    ${feed}
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
  const stroke = chart.in_control ? (chart.warning ? "#d8b46a" : "#cfc6ba") : "#ff4d5f";
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
  if (action.kind === "scheduled_service") {
    return payload.stage === "reset" ? "system reset" : "scheduled service";
  }
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

function callVerb(signal) {
  if (signal === "push") return "Base batteries discharge";
  if (signal === "pull") return "Base batteries charge";
  return "Base batteries hold";
}

function callDepth(signal, intensity) {
  if (signal === "hold") return "";
  const n = Number(intensity);
  if (!(n > 0) || n <= 0.4) return "light";
  if (n <= 0.7) return "medium";
  return "strong";
}

function callWho(source) {
  if (source === "external") return "posted order";
  if (source === "action") return "this home";
  return "ladder";
}

function describeCall(dispatch) {
  if (!dispatch || !dispatch.signal) return "—";
  const verb = callVerb(dispatch.signal);
  const who = callWho(dispatch.source);
  const depth = callDepth(dispatch.signal, dispatch.intensity);
  if (!depth) return `${verb} · ${who}`;
  return `${verb} · ${depth} · ${who}`;
}

function describeBecause(clause) {
  const line = clause.line || "";
  const storage = line.match(/storage (-?\d+) MW/);
  const demand = line.match(/demand percentile ([\d.]+)/);
  if (line.includes("ladder is not running")) return "A posted order is running. The ladder is off.";
  if (storage && line.includes("≥")) {
    return `Grid storage is discharging ${fmt(Number(storage[1]), 0)} MW, so Base batteries discharge too (above 200 MW)`;
  }
  if (storage && line.includes("≤") && !line.includes("inside")) {
    return `Grid storage is charging ${fmt(Math.abs(Number(storage[1])), 0)} MW, so Base batteries charge too (past −200 MW)`;
  }
  if (line.includes("inside ±")) {
    const pct = demand ? demand[1] : "";
    return `Texas demand is mid-range${pct ? ` (${pct} of today)` : ""}, and grid storage is quiet, so Base batteries hold`;
  }
  if (demand && line.includes("≥")) {
    return `Texas demand is high (${demand[1]} of today), so Base batteries discharge (above 0.75)`;
  }
  if (demand && line.includes("≤")) {
    return `Texas demand is low (${demand[1]} of today), so Base batteries charge (below 0.35)`;
  }
  if (line.includes("load-zone price") && line.includes("≥")) {
    return "This zone's price is high enough for Base batteries to discharge";
  }
  if (line.includes("load-zone price") && line.includes("≤")) {
    return "This zone's price is low enough for Base batteries to charge";
  }
  return line;
}

function markLine(clause) {
  const text = describeBecause(clause);
  let line = escapeHtml(text);
  const mark = escapeHtml(clause.threshold || "");
  if (mark && line.includes(mark)) line = line.replace(mark, `<mark>${mark}</mark>`);
  return `<p class="because">${line}</p>`;
}

function nowBlock(data) {
  const market = data.market || {};
  const basis = market.rate_basis === "ercot" ? "live" : "simulated";
  const shape = data.shape && data.shape.shape ? data.shape.shape : "—";
  const call = describeCall(data.dispatch);
  const because = (data.dispatch && data.dispatch.because) || [];
  return `<div class="stack ledger">
      ${row("price", `${fmt(market.rate_usd_mwh, 1)} $/MWh · ${basis}`)}
      ${row("day", shape)}
      ${row("fleet call", call)}
    </div>
    ${because.map(markLine).join("")}`;
}

const WHO = { fleet: "fleet", maintenance: "maintenance", sim: "agent", api: "user", llm: "model" };
const MACHINE = new Set(["fleet", "maintenance", "sim", "rules"]);

function whoLabel(actor) {
  if (!actor) return "";
  if (MACHINE.has(actor)) return "[state machine]";
  return WHO[actor] || actor;
}
const CASE_ACTORS = new Set(["fleet", "maintenance", "llm", "api", "sim"]);

function actionEntry(action) {
  return {
    id: action.id || "",
    ts: action.ts || "",
    starts_at: action.starts_at || "",
    ends_at: action.ends_at || "",
    site: action.site_id,
    actor: action.actor,
    title: decisionLabel(action),
    status: action.status || "",
    because: (action.payload || {}).because || [],
    note: action.note || "",
    payload: action.payload || {},
  };
}

function caseKey(entry) {
  const payload = entry.payload || {};
  if (payload.chart_id) return `${entry.site}:${payload.chart_id}`;
  if (payload.reason === "price") return `${entry.site}:price`;
  return entry.id || `${entry.site}:${entry.ts}`;
}

function latestSteps(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    const key = caseKey(entry);
    const prev = grouped.get(key);
    if (!prev || entry.ts > prev.ts) grouped.set(key, entry);
  }
  return [...grouped.values()];
}

function caseDesk(action) {
  if (action.actor === "fleet" || action.actor === "maintenance") return action.actor;
  const payload = action.payload || {};
  if (payload.chart_id || action.kind === "scheduled_service" || action.kind === "return_online") {
    return "maintenance";
  }
  return "fleet";
}

function homesInView(data) {
  const sites = data.sites || [];
  if (modal.open && selected) return sites.filter((site) => site.id === selected);
  if (focusedStation) return sites.filter((site) => site.station === focusedStation);
  if (focusedMetro) return sites.filter((site) => site.metro === focusedMetro);
  return sites;
}

function agentCases(data, desk, ids) {
  const open = (status) => status === "pending" || status === "active";
  const rows = (data.actions || [])
    .filter((action) => CASE_ACTORS.has(action.actor) && caseDesk(action) === desk)
    .filter((action) => !ids || ids.has(action.site_id))
    .map(actionEntry);
  const entries = desk === "maintenance" ? rows : latestSteps(rows);
  return entries.sort((a, b) => {
    const rank = Number(open(b.status)) - Number(open(a.status));
    if (rank) return rank;
    return b.ts.localeCompare(a.ts);
  });
}

function spanLabel(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function timerLabel(start, end, now = Date.now()) {
  const endMs = Date.parse(end);
  const startMs = Date.parse(start);
  if (!Number.isFinite(endMs)) return "";
  if (Number.isFinite(startMs) && startMs - now > 30000) return `in ${spanLabel(startMs - now)}`;
  const left = endMs - now;
  return left <= 0 ? "0s" : spanLabel(left);
}

function paintTimers() {
  const now = Date.now();
  for (const node of document.querySelectorAll("time.timer")) {
    node.textContent = timerLabel(node.dataset.start, node.dataset.ends, now);
  }
}

setInterval(paintTimers, 1000);

function estimateLabel(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 1) return `${Math.round(value * 60)}s`;
  return Number.isInteger(value) ? `${value}m` : `${value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}m`;
}

function stepText(item) {
  const estimate = estimateLabel(item.estimate_min);
  const bit = estimate ? `${estimate} ` : "";
  return `${item.stage || "step"} ${bit}${item.result || ""}`.trim();
}

function evidenceText(evidence) {
  if (!evidence) return "";
  const bits = [];
  const fields = [
    ["z", "z", ""],
    ["measured", "measured", ""],
    ["expected", "expected", ""],
    ["soc_pct", "soc", "%"],
    ["temp_c", "temp", " °C"],
    ["load_kw", "load", " kW"],
  ];
  for (const [key, label, suffix] of fields) {
    if (evidence[key] == null || evidence[key] === "") continue;
    bits.push(`${label} ${evidence[key]}${suffix}`);
  }
  return bits.join(" · ");
}

function payloadBlock(payload) {
  if (!payload || !payload.pull) return "";
  const body = { pull: payload.pull, decision: payload.decision || null };
  return `<pre class="case-payload">${escapeHtml(JSON.stringify(body, null, 2))}</pre>`;
}

function stepList(payload) {
  const steps = (payload || {}).escalation || [];
  if (!steps.length) return "";
  return `<ol class="steps">${steps.map((item) => {
    const when = escapeHtml((item.ts || "").slice(11, 19));
    const who = escapeHtml(whoLabel(item.actor));
    return `<li class="step"><span>${when}</span><span>${who}</span><b>${escapeHtml(stepText(item))}</b></li>`;
  }).join("")}</ol>`;
}

function caseCard(entry, opts = {}) {
  const status = entry.status || "";
  const named = whoLabel(entry.actor);
  const who = opts.desk && (entry.actor === opts.desk || entry.actor === "sim") ? "" : named;
  const open = status === "pending" || status === "active";
  const clock = open && entry.ends_at
    ? timerLabel(entry.starts_at, entry.ends_at)
    : "";
  const timer = clock
    ? `<time class="timer" data-start="${escapeHtml(entry.starts_at)}" data-ends="${escapeHtml(entry.ends_at)}">${clock}</time>`
    : "";
  const pill = status ? `<span class="status ${escapeHtml(status)}">${escapeHtml(status)}</span>` : "";
  if (opts.select && opts.site !== false) {
    const payload = entry.payload || {};
    const chart = escapeHtml(payload.chart_id || "");
    const estimateText = estimateLabel(payload.estimate_min);
    const estimate = estimateText ? `<span class="case-est">est ${escapeHtml(estimateText)}</span>` : "";
    const steps = stepList(payload);
    const evidence = evidenceText((payload.pull && payload.pull.evidence) || payload.evidence);
    const evidenceLine = evidence ? `<span class="case-evidence">${escapeHtml(evidence)}</span>` : "";
    const pulling = !payload.decision && payload.stage === "ticket" && entry.actor === "llm"
      ? `<span class="case-evidence">pulling GET /api/site/${escapeHtml(entry.site)}</span>`
      : "";
    const decided = (payload.decision && payload.decision.action) || "";
    const modelName = (payload.decision && payload.decision.model) || "";
    const decisionLine = decided
      ? `<span class="case-decision">${modelName ? `<b>${escapeHtml(modelName)}</b> ` : ""}${escapeHtml(decided)}</span>`
      : "";
    const whoLine = !steps && named ? `<span class="escalation">${escapeHtml(named)}</span>` : "";
    return `<button type="button" class="alert case-row status-${escapeHtml(status)}" data-site="${escapeHtml(entry.site)}" data-chart="${chart}">
      ${pill || `<span class="status">case</span>`}
      <span class="alert-id">${escapeHtml(entry.site)}</span>
      ${timer}
      <span class="case-step">${escapeHtml(entry.title)}</span>
      ${estimate}
      ${whoLine}
      ${steps}
      ${pulling}
      ${evidenceLine}
      ${decisionLine}
      ${payloadBlock(payload)}
    </button>`;
  }
  const site = opts.site === false
    ? ""
    : `<button type="button" class="case-site" data-site="${escapeHtml(entry.site)}">${escapeHtml(entry.site)}</button>`;
  const whoHtml = who ? `<span>${escapeHtml(who)}</span>` : "";
  const bits = [site, whoHtml, timer].filter(Boolean);
  const meta = bits.join(`<span> · </span>`);
  const hit = opts.site === false ? "" : ` data-site="${escapeHtml(entry.site)}"`;
  const steps = stepList(entry.payload);
  return `<article class="case status-${escapeHtml(status)}"${hit}>
      <div class="case-head"><b class="case-action">${escapeHtml(entry.title)}</b>${pill}</div>
      ${meta ? `<p class="case-meta">${meta}</p>` : ""}
      ${steps}
    </article>`;
}

function agentBlock(data, desk, ids) {
  const entries = agentCases(data, desk, ids);
  const empty = desk === "fleet"
    ? "No fleet calls. A home set to dispatch, or a posted push, pull, or hold, opens one."
    : "No maintenance cases in this view.";
  const rows = entries.length
    ? entries.map((entry) => caseCard(entry, { desk, select: desk === "maintenance" })).join("")
    : `<p class="muted">${empty}</p>`;
  return `<div class="cases">${rows}</div>`;
}

function fold(name, title, body) {
  return `<details class="fold" data-fold="${name}"${folds[name] ? " open" : ""}>
    <summary>${title}</summary>
    <div class="fold-body">${body}</div>
  </details>`;
}

let logOpen = true;

function snapState(node) {
  if (!node) return null;
  const top = node.scrollTop;
  const height = node.scrollHeight;
  const view = node.clientHeight;
  const bodyTop = node.getBoundingClientRect().top;
  let anchorKey = "";
  let anchorOffset = 0;
  for (const row of node.querySelectorAll(".log-line")) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= bodyTop + 2) continue;
    anchorKey = row.dataset.logKey || "";
    anchorOffset = rect.top - bodyTop;
    break;
  }
  return {
    top,
    height,
    nearTop: top < 6,
    nearBottom: top + view >= height - 6,
    anchorKey,
    anchorOffset,
  };
}

function restoreState(node, snap) {
  if (!node || !snap) return;
  if (snap.nearTop) {
    node.scrollTop = 0;
    return;
  }
  if (snap.nearBottom) {
    node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
    return;
  }
  if (snap.anchorKey) {
    const bodyTop = node.getBoundingClientRect().top;
    for (const row of node.querySelectorAll(".log-line")) {
      if ((row.dataset.logKey || "") !== snap.anchorKey) continue;
      const offset = row.getBoundingClientRect().top - bodyTop;
      node.scrollTop += offset - snap.anchorOffset;
      return;
    }
  }
  const shift = node.scrollHeight - snap.height;
  node.scrollTop = Math.max(0, snap.top + shift);
}

function logLine(row) {
  const time = (row.ts || "").slice(11, 19);
  const key = `${row.ts || ""}:${row.state || ""}:${row.signal || ""}`;
  const moved = row.discharge_kw > 0.01
    ? `${fmt(row.discharge_kw, 2)} kW out`
    : row.charge_kw > 0.01
      ? `${fmt(row.charge_kw, 2)} kW in`
      : "idle";
  const codes = (row.out_of_control || row.alarming || []).join(" ");
  const word = row.availability === "offline" ? "offline" : row.state;
  return `<p class="log-line ${word}" data-log-key="${escapeHtml(key)}">
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

const LOG_STATE_SCHEMA = [
  ["ts", "string"],
  ["state", "push | pull | hold"],
  ["signal", "push | pull | hold"],
  ["source", "rules | external | action"],
  ["availability", "online | offline"],
  ["grid", "on | off"],
  ["soc_pct", "number"],
  ["physical_soc_kwh", "number"],
  ["load_kw", "number"],
  ["load_kw_state", "number"],
  ["charge_kw", "number"],
  ["discharge_kw", "number"],
  ["in_kw", "number"],
  ["out_kw", "number"],
  ["voltage_v", "number"],
  ["voltage_state", "number"],
  ["frequency_hz", "number"],
  ["temp_c", "number"],
  ["temp_c_state", "number"],
  ["energy_in_kwh", "number"],
  ["energy_out_kwh", "number"],
  ["alarming", ["chart_id"]],
  ["out_of_control", ["chart_id"]],
];

const SNAPSHOT_SCHEMA = [
  ["offline", "boolean"],
  ["signal_override", "null | {signal, intensity}"],
  ["armed", ["chart_id"]],
  ["addons", ["addon_id"]],
  ["chart_history", "chart_id -> number[]"],
];

const SITE_SCHEMA = [
  ["duty", "0..1"],
  ["intensity", "0..1"],
  ["reserve_frac", "SOC_RESERVE .. SOC_RESERVE + 0.25"],
];

function schemaJson(rows) {
  const lines = rows.map(([key, value], index) => {
    const shown = Array.isArray(value)
      ? `[${value.map((item) => `"${item}"`).join(", ")}]`
      : `"${value}"`;
    const comma = index === rows.length - 1 ? "" : ",";
    const meaning = DEFINITIONS[key];
    const term = meaning
      ? `<span class="k term" tabindex="0" data-def="${escapeHtml(meaning)}">"${escapeHtml(key)}"</span>`
      : `<span class="k">"${escapeHtml(key)}"</span>`;
    return `  ${term}: <span class="v">${escapeHtml(shown)}</span>${comma}`;
  });
  return `<pre class="contract-json">{
${lines.join("\n")}
}</pre>`;
}

const DICTIONARY = [
  ["log state", [
    ["ts", "Tick time, US Central, with an offset. Null before any row exists."],
    ["state", "What the battery did: push, pull, or hold."],
    ["signal", "The call: push, pull, or hold. Pull charges the battery from the grid. Push discharges toward the grid. Hold does neither."],
    ["source", "rules, external, or action. rules means the ladder chose the call. external means a fleet-wide order chose it and replaces the ladder until it is cleared with auto. action means a set_signal on this home outranks the fleet call."],
    ["availability", "online or offline."],
    ["grid", "on or off. off means the contactor is open."],
    ["soc_pct", "Reported state of charge, percent."],
    ["physical_soc_kwh", "Coulomb count."],
    ["load_kw", "House load this tick."],
    ["load_kw_state", "Lagged load the next tick starts from."],
    ["charge_kw", "Kilowatts into the battery."],
    ["discharge_kw", "Kilowatts out of the battery."],
    ["in_kw", "Meter import."],
    ["out_kw", "Meter export."],
    ["voltage_v", "Disco voltage."],
    ["voltage_state", "Lagged service voltage the next tick starts from."],
    ["frequency_hz", "Disco frequency."],
    ["temp_c", "Cabinet temperature this tick. The hour mean is usage_hours.temp_c and the base_temp chart."],
    ["temp_c_state", "Lagged temperature the next tick starts from."],
    ["energy_in_kwh", "Cumulative meter import."],
    ["energy_out_kwh", "Cumulative meter export."],
    ["alarming", "Chart ids past ±3σ."],
    ["out_of_control", "Chart ids where a rule fired. This is what the unit view paints red."],
  ]],
  ["snapshot", [
    ["offline", "True while a scheduled service has the cabinet out."],
    ["signal_override", "null, or {signal, intensity} while a set_signal is in force."],
    ["armed", "Chart ids the next tick will drive to +4σ."],
    ["addons", "Add-on ids on the disco."],
    ["chart_history", "Completed bucket residuals the run rules just used, one list per chart_id, oldest first, at most 24."],
  ]],
  ["site", [
    ["duty", "A draw in [0, 1]. The call reaches this home only when intensity is at least its duty."],
    ["intensity", "Depth of the call on this home this tick, from 0 to 1. A set_signal replaces it. Service zeros it."],
    ["reserve_frac", "Between SOC_RESERVE and SOC_RESERVE + 0.25. The customer's backup floor. Discharge stops there."],
  ]],
];

const DEFINITIONS = Object.fromEntries(DICTIONARY.flatMap(([, rows]) => rows));
const contractOpen = { "log state": false, snapshot: false, site: false, dictionary: false };

function contractSchema(name, rows) {
  return `<details class="fold contract-fold" data-contract="${name}"${contractOpen[name] ? " open" : ""}>
    <summary>${name}</summary>
    ${schemaJson(rows)}
  </details>`;
}

function dictionaryBlock() {
  const groups = DICTIONARY.map(([name, rows]) => `<p class="dict-group">${name}</p><dl class="dict">${
    rows.map(([field, meaning]) => `<dt>${escapeHtml(field)}</dt><dd>${escapeHtml(meaning)}</dd>`).join("")
  }</dl>`).join("");
  return `<details class="fold contract-fold" data-contract="dictionary"${contractOpen.dictionary ? " open" : ""}>
    <summary>dictionary</summary>
    <div class="dict-body">${groups}</div>
  </details>`;
}

function contractBlock() {
  return `<section class="contract" aria-label="Data contract">
    <p class="unit-chain-cap">contract</p>
    ${contractSchema("log state", LOG_STATE_SCHEMA)}
    ${contractSchema("snapshot", SNAPSHOT_SCHEMA)}
    ${contractSchema("site", SITE_SCHEMA)}
    ${dictionaryBlock()}
  </section>`;
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
        `<p><span>hour ${row.hour}</span><b>${fmt(row.load_kwh, 2)} kWh load${row.temp_c == null ? "" : ` · ${fmt(row.temp_c, 1)} °C`}</b></p>`,
    )
    .join("");
  return `<div class="stack"><h3>Recent usage</h3>${lines}</div>`;
}

function renderPanel(data) {
  const fleetSites = data.sites || [];
  if (!fleetSites.length) {
    panelBody.innerHTML = `<p class="muted">No batteries in this snapshot.</p>`;
    return;
  }
  const sites = homesInView(data);
  const ids = sites === fleetSites ? null : new Set(sites.map((site) => site.id));
  const queue = [];
  for (const site of sites) {
    if (site.alarm || site.grid === "off") queue.push(site);
  }

  const queueHtml = queue.length
    ? queue
        .slice(0, 40)
        .map((site) => {
          const codes = [...(site.flagged || [])];
          if (site.grid === "off") codes.push("grid off");
          const block = (site.flagged || [])[0] || "grid";
          return `<button type="button" class="alert" data-site="${site.id}" data-chart="${block}">
            <span class="status alarm">maintenance</span>
            <span class="alert-id">${site.id}</span>
            <em>${codes.join(" ")}</em>
          </button>`;
        })
        .join("")
    : `<p class="muted">No maintenance alerts in this view.</p>`;

  const openCount = (desk, scope) => agentCases(data, desk, scope).filter((entry) => entry.status === "pending" || entry.status === "active").length;
  revealVisits(data);
  const fleetOpen = openCount("fleet");
  const careOpen = openCount("maintenance", ids);
  panelBody.innerHTML = `
    ${fold("now", "Now", nowBlock(data))}
    ${fold("fleet", `Fleet manager${fleetOpen ? `<span class="count">${fmt(fleetOpen)}</span>` : ""}`, agentBlock(data, "fleet"))}
    ${fold("maintenance", `Maintenance manager${careOpen ? `<span class="count">${fmt(careOpen)}</span>` : ""}`, agentBlock(data, "maintenance", ids))}
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
  { id: "disco", name: "Disco", role: "Measures power, voltage, and frequency. Meters add-ons." },
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

function chartHot(site, chartId) {
  const chart = (site.charts || []).find((item) => item.chart_id === chartId);
  return Boolean(chart && chart.in_control === false);
}

function actRow(title, text, control, hot) {
  return `<div class="act${hot ? " hot" : ""}">
    <div>
      <b>${title}</b>
      <span>${text}</span>
    </div>
    ${control}
  </div>`;
}

function armControl(site, chartId) {
  const on = (site.armed || []).includes(chartId);
  return `<button type="button" class="act-btn${on ? " on" : ""}" data-arm="${chartId}" data-on="${on ? "1" : "0"}">${on ? "Clear" : "Flag"}</button>`;
}

function signalChoice(site) {
  const forced = site.snapshot && site.snapshot.signal_override && site.snapshot.signal_override.signal;
  const one = (signal, label) => {
    const on = forced === signal ? ` on ${signal}` : "";
    return `<button type="button" class="act-btn${on}" data-signal="${signal}">${label}</button>`;
  };
  return `<div class="act-choice">${one("push", "Push")}${one("pull", "Pull")}${one("hold", "Hold")}</div>`;
}

function simControls(site) {
  const gridOff = (site.snapshot && site.snapshot.grid) === "off";
  const rows = [];
  if (component === "grid") {
    const forced = site.snapshot && site.snapshot.signal_override && site.snapshot.signal_override.signal;
    const market = payload && payload.market;
    const shape = payload && payload.shape;
    const basis = market && market.rate_basis === "ercot" ? "live" : "simulated";
    const day = shape && shape.shape ? ` · ${shape.shape}` : "";
    const context = market
      ? `<p class="muted note">${fmt(market.rate_usd_mwh, 0)} $/MWh ${basis}${day}</p>`
      : "";
    rows.push(actRow(
      "This home",
      forced
        ? `Forced to ${forced} for one hour. It outranks the fleet call.`
        : "Force push, pull, or hold for one hour. It outranks the fleet call.",
      signalChoice(site),
    ));
    rows.push(actRow(
      "Contactor",
      "Open it and this home stops importing and exporting. The battery covers the house.",
      `<button type="button" class="act-btn${gridOff ? " hot" : ""}" data-grid="${gridOff ? "1" : "0"}">${gridOff ? "Turn on" : "Turn off"}</button>`,
      gridOff,
    ));
    rows.push(actRow(
      "Meter agreement",
      "Compare the disco with the billing meter. A disagreement opens service.",
      armControl(site, "disco_meter_delta"),
      chartHot(site, "disco_meter_delta"),
    ));
    return `<div class="acts"><p class="unit-chain-cap">actions</p>${rows.join("")}</div>${context}${decisionFooter(site)}`;
  }
  if (component === "disco") {
    rows.push(actRow(
      "Voltage",
      "Past limits, maintenance tries a 15 second reset.",
      armControl(site, "disco_voltage"),
      chartHot(site, "disco_voltage"),
    ));
    rows.push(actRow(
      "Frequency",
      "Left on the cabinet. The chart is marked and nothing is posted.",
      armControl(site, "frequency"),
      chartHot(site, "frequency"),
    ));
    return `<div class="acts"><p class="unit-chain-cap">actions</p>${rows.join("")}</div>${decisionFooter(site)}`;
  }
  if (component === "panel") return decisionFooter(site);
  rows.push(actRow(
    "State of charge",
    "A reset does not clear a charge offset, so service opens.",
    armControl(site, "soc_tracking"),
    chartHot(site, "soc_tracking"),
  ));
  rows.push(actRow(
    "Temperature",
    "Heat does not clear by reboot, so service opens.",
    armControl(site, "base_temp"),
    chartHot(site, "base_temp"),
  ));
  rows.push(actRow(
    "Service",
    "Open a maintenance visit on this cabinet.",
    `<button type="button" class="act-btn" data-ticket="1">Open ticket</button>`,
  ));
  return `<div class="acts"><p class="unit-chain-cap">actions</p>${rows.join("")}</div>${decisionFooter(site)}`;
}

const BOX_CHARTS = {
  grid: ["disco_meter_delta"],
  disco: ["disco_voltage", "frequency"],
  panel: [],
  base: ["soc_tracking", "base_temp"],
};

function decisionFooter(site) {
  const charts = BOX_CHARTS[component] || [];
  const actions = site.actions || [];
  const tickets = actions
    .filter((action) => action.kind === "scheduled_service")
    .filter((action) => {
      const chart = (action.payload || {}).chart_id || "";
      if (charts.includes(chart)) return true;
      return component === "base" && !chart;
    })
    .map(actionEntry);
  const ticketIds = new Set(tickets.map((entry) => entry.id));
  const openOther = latestSteps(
    actions
      .filter((action) => (action.status === "pending" || action.status === "active") && !ticketIds.has(action.id))
      .filter((action) => {
        const chart = (action.payload || {}).chart_id;
        if (chart) return false;
        return action.kind !== "scheduled_service" || component === "base";
      })
      .map(actionEntry),
  );
  const open = (status) => status === "pending" || status === "active";
  const entries = [...tickets, ...openOther].sort((a, b) => {
    const rank = Number(open(b.status)) - Number(open(a.status));
    if (rank) return rank;
    return b.ts.localeCompare(a.ts);
  });
  if (!entries.length) return "";
  return `<div class="cases">${entries.map((entry) => caseCard(entry, { site: false })).join("")}</div>`;
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
  const shown = (chart.rules || []).filter((rule) => rule !== "seven_same_side");
  const status = chart.in_control ? (chart.warning ? "watch" : "in control") : shown.join(", ");
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
  const modeLabel = gridOff(site) ? "grid off" : site.offline ? "service" : mode;

  document.getElementById("unit-id").textContent = site.id;
  document.getElementById("unit-sub").textContent =
    `${site.city} · ${site.station_name || site.station || site.load_zone} · load ×${fmt(site.load_scale, 2)} · ${fmt(site.temp_center_c, 1)} °C baseline`
    + (site.instrumented ? " · full-rate telemetry" : "");
  document.getElementById("unit-mode").className = `mode ${mode}`;
  document.getElementById("unit-mode").innerHTML = `<i></i>${modeLabel}`;

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
  const logSnap = snapState(detail.querySelector(".log-body"));
  detail.innerHTML = `
    ${contractBlock()}
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
  restoreState(detail.querySelector(".log-body"), logSnap);
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
  const named = (detail.charts || []).find((chart) => chart.chart_id === block);
  const flagged = named
    || (detail.charts || []).find((chart) => chart.in_control === false)
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
  if (payload) {
    renderScene(payload);
    renderPanel(payload);
  }
}

modal.addEventListener("toggle", (event) => {
  if (event.target.dataset.log !== undefined) logOpen = event.target.open;
  if (event.target.dataset.contract) contractOpen[event.target.dataset.contract] = event.target.open;
}, true);

const contractTip = document.getElementById("contract-tip");

function placeContractTip(event) {
  const pad = 14;
  contractTip.style.left = "0px";
  contractTip.style.top = "0px";
  const width = contractTip.offsetWidth;
  const height = contractTip.offsetHeight;
  const left = Math.min(event.clientX + pad, window.innerWidth - width - 8);
  const top = Math.min(event.clientY + pad, window.innerHeight - height - 8);
  contractTip.style.left = `${Math.max(8, left)}px`;
  contractTip.style.top = `${Math.max(8, top)}px`;
}

function showContractTip(term, event) {
  const meaning = term && term.dataset.def;
  if (!meaning) {
    contractTip.hidden = true;
    return;
  }
  contractTip.hidden = false;
  contractTip.textContent = meaning;
  placeContractTip(event);
}

modal.addEventListener("pointerover", (event) => {
  showContractTip(event.target.closest(".term"), event);
});
modal.addEventListener("pointermove", (event) => {
  if (contractTip.hidden) return;
  const term = event.target.closest(".term");
  if (!term) return;
  placeContractTip(event);
});
modal.addEventListener("pointerout", (event) => {
  const term = event.target.closest(".term");
  if (!term) return;
  const next = event.relatedTarget && event.relatedTarget.closest && event.relatedTarget.closest(".term");
  if (next === term) return;
  contractTip.hidden = true;
});
modal.addEventListener("focusin", (event) => {
  showContractTip(event.target.closest(".term"), {
    clientX: event.target.getBoundingClientRect().left,
    clientY: event.target.getBoundingClientRect().bottom,
  });
});
modal.addEventListener("focusout", () => {
  contractTip.hidden = true;
});
document.getElementById("unit-detail").addEventListener("scroll", () => {
  contractTip.hidden = true;
});

modal.addEventListener("close", () => {
  history.replaceState(null, "", location.pathname);
  if (payload) renderPanel(payload);
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
    openUnit(unit.dataset.site, unit.dataset.chart || null);
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

function screenFromWorld(point, rect) {
  POINTER.copy(point).project(camera);
  return {
    x: (POINTER.x * 0.5 + 0.5) * rect.width,
    y: (-POINTER.y * 0.5 + 0.5) * rect.height,
  };
}

function screenPoint(lat, lon, rect) {
  return screenFromWorld(project(lat, lon, NODE_Y), rect);
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
    const point = entry
      ? screenFromWorld(entry.group.position, rect)
      : screenPoint(station.lat, station.lon, rect);
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

// How much ground a pose takes in per unit of distance. The tilt is fixed, so
// the frame is trig on the pose vector and the lens.
function poseFrame(name) {
  const pose = poseOffset({ pose: name });
  const length = Math.hypot(pose[0], pose[1]) || 1;
  const height = pose[0] / length;
  const elevation = Math.atan2(pose[0], pose[1]);
  const half = THREE.MathUtils.degToRad(camera.fov) / 2;
  return {
    depth: height / Math.tan(elevation - half) - height / Math.tan(elevation + half),
    width: 2 * Math.tan(half) * Math.max(camera.aspect, 0.5),
  };
}

// Pull back far enough to hold the whole block, then slide it right and up,
// clear of the chart card and the summary card on the left. Both the city
// stack and one open substation are framed this way.
function frameYard(yard, point, name) {
  const limit = name === "station" ? { near: 0.16, far: 1.1 } : { near: 1.6, far: 4.4 };
  if (!yard) return { x: point.x, z: point.z, distance: limit.near };
  const frame = poseFrame(name);
  // The city stack wants air around it, so the rows stay clear of the cards.
  // A service area can sit closer.
  const fit = name === "station" ? 0.84 : 0.68;
  const distance = Math.min(limit.far, Math.max(limit.near, Math.max(
    yard.spanZ / (frame.depth * fit),
    yard.spanX / (frame.width * fit),
  )));
  return {
    x: yard.center.x - frame.width * distance * 0.09,
    z: yard.center.z + frame.depth * distance * 0.05,
    distance,
  };
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
    focusPoint = { ...frameYard(payload ? stackYard(payload) : null, point, "city"), pose: "city" };
    placeHash(`#metro/${metro.id}`);
  }
  if (payload) {
    renderScene(payload);
    renderPanel(payload);
  }
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
  focusedMetro = station.metro;
  cityT = 1;
  cityHold = false;
  fillHold = true;
  stageStarted = 0;
  stageT = 0;
  const point = project(station.lat, station.lon, 0);
  focusPoint = { ...frameYard(payload ? areaYard(payload) : null, point, "station"), pose: "station" };
  if (payload) {
    renderScene(payload);
    renderPanel(payload);
  }
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
    const word = gridOff(site) ? "grid off" : site.offline ? "service" : modeOf(site);
    tip.innerHTML = `<b>${site.id}</b> ${word} · ${fmt(site.soc_pct, 0)}%${
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

const decisionBox = document.getElementById("decision-log");
const seenDecisions = new Set();
let decisionRows = [];
const DECISION_KEEP = 12;

function decisionTone(text) {
  const parts = String(text).split(/\s+/);
  const word = parts[0] === "set" ? parts[1] : parts[0];
  if (word === "push" || word === "pull" || word === "hold") return word;
  if (text.includes("scheduled service") || text.includes("back online")) return "alarm";
  return "";
}

function paintDecisions() {
  if (!decisionRows.length) {
    decisionBox.innerHTML = `<p class="decision">Waiting for a decision.</p>`;
    return;
  }
  const stick = decisionBox.scrollTop < 28;
  const ordered = decisionRows.slice().reverse();
  decisionBox.innerHTML = ordered.map((row) => {
    const tone = decisionTone(row.text);
    const site = row.site
      ? `<button type="button" data-site="${escapeHtml(row.site)}">${escapeHtml(row.site)}</button>`
      : `<span></span>`;
    const body = tone
      ? `<b class="decision-step ${tone}">${escapeHtml(row.text)}</b>`
      : `<b class="decision-step">${escapeHtml(row.text)}</b>`;
    return `<p class="decision" title="${escapeHtml(row.text)}"><span class="decision-time">${escapeHtml(row.time)}</span><span>${escapeHtml(row.who)}</span>${site}${body}</p>`;
  }).join("");
  if (stick) decisionBox.scrollTop = 0;
}

function ingestDecisions(data) {
  const incoming = [];
  for (const call of data.calls || []) {
    const why = (call.because || []).map((item) => describeBecause(item)).filter(Boolean).join(" · ");
    const text = why ? `${callVerb(call.signal || "hold")} · ${why}` : callVerb(call.signal || "hold");
    incoming.push({
      key: `call:${call.ts}:${call.who}:${call.signal}:${why}`,
      ts: call.ts || "",
      time: (call.ts || "").slice(11, 19),
      who: whoLabel(call.who || "rules"),
      site: "",
      text,
    });
  }
  for (const action of data.actions || []) {
    if (!CASE_ACTORS.has(action.actor)) continue;
    const steps = (action.payload || {}).escalation || [];
    const title = decisionLabel(action);
    if (steps.length) {
      steps.forEach((step, index) => {
        const actor = step.actor || action.actor;
        const evidence = step.result === "done"
          ? evidenceText(((action.payload || {}).pull || {}).evidence || (action.payload || {}).evidence)
          : "";
        const decided = step.result === "done" ? (((action.payload || {}).decision || {}).action || "") : "";
        const text = [title, stepText(step), evidence, decided].filter(Boolean).join(" · ");
        incoming.push({
          key: `act:${action.id}:step:${index}:${step.result}:${actor}`,
          ts: step.ts || action.ts || "",
          time: (step.ts || action.ts || "").slice(11, 19),
          who: whoLabel(actor),
          site: action.site_id || "",
          text,
        });
      });
      continue;
    }
    const why = (((action.payload || {}).because || []).map((item) => item.line).filter(Boolean))[0] || "";
    incoming.push({
      key: `act:${action.id || `${action.site_id}:${action.ts}:${action.kind}`}:${action.status}`,
      ts: action.ts || "",
      time: (action.ts || "").slice(11, 19),
      who: whoLabel(action.actor),
      site: action.site_id || "",
      text: why && !title.includes(why) ? `${title} · ${why}` : title,
    });
  }
  incoming.sort((a, b) => a.ts.localeCompare(b.ts) || a.key.localeCompare(b.key));
  const novel = incoming.filter((row) => !seenDecisions.has(row.key));
  for (const row of incoming) seenDecisions.add(row.key);
  if (!decisionRows.length) decisionRows = incoming.slice(-DECISION_KEEP);
  else if (novel.length) decisionRows = decisionRows.concat(novel).slice(-DECISION_KEEP);
  else return;
  paintDecisions();
}

const ARCH_W = 200;
const ARCH_H = 74;
const ARCH_BOX = {
  ercot: [20, 48],
  tick: [264, 48],
  machine: [508, 48],
  map: [752, 48],
  gateway: [20, 214],
  sqlite: [264, 214],
  supabase: [264, 372],
};
const ARCH_ROLE = {
  ercot: "Live system demand and the short forecast. Official prices and constraints turn on only when the ERCOT subscription key is set. Until then the price is simulated.",
  gateway: "On-premises gateway, simulated telemetry collection.",
  tick: "Data contract governed ingestion. Ensures data quality by data contract adherence.",
  machine: "The state machine runs on the API server. It tells Base batteries to discharge to the grid, charge from the grid, or hold. A light call reaches about a third of the homes; a strong call reaches almost all of them. The ladder picks that from ERCOT demand and grid storage. Those steps show up in the decisions log as [state machine].",
  map: "The map in the browser. It asks the server for an update every five seconds and draws one dot per home.",
  sqlite: "The API writes this file every tick. It is data/gridsim.db on the service disk. Identity, ERCOT payloads, logs, dispatch, and the controller tables live here. There is no sites table in Supabase.",
  supabase: "Hosted Postgres. Only the API talks to it. When the Supabase keys are set, the API copies dispatch, market, and actions here. Until then this box reads disabled.",
};
let viewName = "fleet";
let archFocus = "machine";
let archKey = "";

function archRight(id) {
  const [x, y] = ARCH_BOX[id];
  return [x + ARCH_W, y + ARCH_H / 2];
}
function archLeft(id) {
  const [x, y] = ARCH_BOX[id];
  return [x, y + ARCH_H / 2];
}
function archTop(id) {
  const [x, y] = ARCH_BOX[id];
  return [x + ARCH_W / 2, y];
}
function archBottom(id) {
  const [x, y] = ARCH_BOX[id];
  return [x + ARCH_W / 2, y + ARCH_H];
}

function archArrow(x1, y1, x2, y2, tone) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const size = 5;
  const bx = x2 - ux * (size + 1);
  const by = y2 - uy * (size + 1);
  return `<polygon class="head ${tone}" points="${x2},${y2} ${bx + -uy * size},${by + ux * size} ${bx + uy * size},${by + -ux * size}" />`;
}

function archLink(points, tone) {
  const path = points.map((point, index) => `${index ? "L" : "M"}${point[0]} ${point[1]}`).join(" ");
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  return `<path class="rail" d="${path}" fill="none" />
    <path class="flow ${tone}" d="${path}" fill="none" stroke-width="1.6" style="animation-duration:1.35s" />
    ${archArrow(prev[0], prev[1], last[0], last[1], tone)}`;
}

function archJoin(from, to) {
  const start = archRight(from);
  const end = archLeft(to);
  const x = (start[0] + end[0]) / 2;
  return [start, [x, start[1]], [x, end[1]], end];
}

function archLive(data) {
  const ercot = data.ercot || {};
  const grid = data.grid || {};
  const fleet = data.fleet || {};
  const dispatch = data.dispatch || {};
  const signal = dispatch.signal || "hold";
  const netKw = (fleet.grid_in_kw || 0) - (fleet.grid_out_kw || 0);
  const mw = Math.abs(netKw) / 1000;
  const flow = mw < 0.005 ? "grid" : netKw < 0 ? "export" : "import";
  const demand = grid.demand_mw == null ? "—" : `${fmt(grid.demand_mw, 0)} MW`;
  const gate = data.gateway || {};
  const gateWhen = (gate.ts || "").slice(11, 19);
  const gateLine = gate.homes ? `${fmt(gate.homes, 0)} homes · ${gateWhen}` : "generating";
  const priceWord = (data.market || {}).rate_basis === "ercot" ? "live price" : "price simulated";
  return {
    signal,
    notes: {
      ercot: ["Demand and short forecast", `${demand} · ${priceWord}`],
      gateway: ["Simulated telemetry collection", gateLine],
      tick: ["Contract-governed ingestion", "Contract adherence"],
      machine: [callVerb(signal), `${callDepth(signal, dispatch.intensity) || "idle"} · ${callWho(dispatch.source || "rules")}`],
      map: ["Map in the browser", `${flow} ${fmt(mw, 2)} MW`],
      sqlite: ["Written every tick", "gridsim.db"],
      supabase: ["Dispatch, market, actions", data.supabase || "—"],
    },
    tone: {
      in: ercot.dashboard === "live" ? "push" : "hold",
      call: signal === "pull" || signal === "push" ? signal : "hold",
      store: data.supabase === "live" ? "push" : "hold",
    },
    state: {
      ercot: ercot.dashboard === "unavailable" ? "flagged" : ercot.dashboard === "cached" ? "watch" : "",
      supabase: data.supabase === "error" ? "flagged" : data.supabase === "live" ? "" : "watch",
    },
  };
}

function archBox(id, name, note, state) {
  const [x, y] = ARCH_BOX[id];
  const lines = Array.isArray(note) ? note : [note];
  const classes = ["blk"];
  if (archFocus === id) classes.push("on");
  if (state) classes.push(state);
  const text = lines.map((line, index) => (
    `<text class="blk-note" data-note="${id}:${index}" x="${x + 14}" y="${y + 40 + index * 14}">${escapeHtml(line)}</text>`
  )).join("");
  return `<g class="${classes.join(" ")}" data-arch="${id}" tabindex="0" role="button" aria-label="${name}">
    <rect class="blk-bg" x="${x}" y="${y}" width="${ARCH_W}" height="${ARCH_H}" rx="3" />
    <rect class="blk-edge" x="${x}" y="${y}" width="2.5" height="${ARCH_H}" />
    <text class="blk-name" x="${x + 14}" y="${y + 22}">${name}</text>
    ${text}
  </g>`;
}

function archRegion(x, y, w, h, label) {
  const name = label
    ? `<text class="arch-label" x="${x + 12}" y="${y + 18}">${label}</text>`
    : "";
  return `<rect class="arch-region" x="${x}" y="${y}" width="${w}" height="${h}" />${name}`;
}

function archSvg(live) {
  const call = live.tone.call;
  const store = live.tone.store;
  const gateEdge = archRight("gateway");
  const tickEdge = archLeft("tick");
  const streamX = (gateEdge[0] + tickEdge[0]) / 2;
  const streamY = tickEdge[1] + 20;
  const regions = [
    archRegion(8, 20, 224, 122, "ERCOT"),
    archRegion(8, 186, 224, 122, "on premises"),
    archRegion(248, 20, 476, 122, "Render · gridsim"),
    archRegion(248, 186, 232, 122, ""),
    archRegion(736, 20, 232, 122, "browser"),
    archRegion(248, 344, 232, 122, "Supabase"),
  ].join("");
  const links = [
    archLink(archJoin("ercot", "tick"), live.tone.in),
    archLink([gateEdge, [streamX, gateEdge[1]], [streamX, streamY], [tickEdge[0], streamY]], "hold"),
    archLink(archJoin("tick", "machine"), call),
    archLink(archJoin("machine", "map"), call),
    archLink([archBottom("tick"), archTop("sqlite")], "hold"),
    archLink([archBottom("sqlite"), archTop("supabase")], store),
  ].join("");
  const boxes = [
    ["ercot", "ERCOT"],
    ["gateway", "gateway"],
    ["tick", "data ingest protocol"],
    ["machine", "state machine"],
    ["map", "map"],
    ["sqlite", "SQLite"],
    ["supabase", "Supabase"],
  ].map(([id, name]) => archBox(id, name, live.notes[id], live.state[id] || "")).join("");
  const dumped = archBottom("tick");
  const copied = archBottom("sqlite");
  return `<svg viewBox="0 0 980 490" class="diagram arch-svg">
    ${regions}
    ${links}
    <text class="flow-kw hold" x="150" y="176">stream</text>
    <text class="flow-kw hold" x="${dumped[0] + 10}" y="${dumped[1] + 32}">writes</text>
    <text class="flow-kw ${store}" x="${copied[0] + 10}" y="${copied[1] + 32}">copy</text>
    ${boxes}
  </svg>`;
}

function renderArch(data) {
  if (!data || viewName !== "architecture") return;
  const live = archLive(data);
  const key = [
    archFocus,
    live.signal,
    live.tone.in,
    live.tone.store,
    live.state.ercot || "",
    live.state.supabase || "",
  ].join("|");
  const holder = document.getElementById("arch-diagram");
  const role = document.getElementById("arch-role");
  if (role) role.textContent = ARCH_ROLE[archFocus] || "";
  if (key !== archKey || !holder.querySelector("svg")) {
    archKey = key;
    holder.innerHTML = archSvg(live);
    return;
  }
  for (const [id, text] of Object.entries(live.notes)) {
    const lines = Array.isArray(text) ? text : [text];
    lines.forEach((line, index) => {
      const node = holder.querySelector(`[data-note="${id}:${index}"]`);
      if (node) node.textContent = line;
    });
  }
}

function fleetHash() {
  if (focusedStation) return `#station/${focusedStation}`;
  if (focusedMetro) return `#metro/${focusedMetro}`;
  return "";
}

function showView(name) {
  viewName = name === "architecture" ? "architecture" : "fleet";
  document.body.dataset.view = viewName;
  document.getElementById("tab-fleet").classList.toggle("on", viewName === "fleet");
  document.getElementById("tab-arch").classList.toggle("on", viewName === "architecture");
  if (viewName === "architecture") {
    if (modal.open) modal.close();
    placeHash("#architecture");
    renderArch(payload);
    return;
  }
  if (location.hash === "#architecture") placeHash(fleetHash());
}

async function poll() {
  try {
    const response = await fetch(api("/api/scene"));
    payload = await response.json();
    renderScene(payload);
    renderStats(payload);
    renderDay(payload);
    renderPanel(payload);
    ingestDecisions(payload);
    renderArch(payload);
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
let stageSignature = "";

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

function stageView(data) {
  const fleetSites = data?.sites || [];
  if (!fleetSites.length) return null;
  if (modal.open && selected) {
    const site = fleetSites.find((item) => item.id === selected);
    if (!site) return null;
    const station = (data.stations || []).find((item) => item.id === site.station);
    const metro = (data.metros || []).find((item) => item.id === site.metro);
    return {
      key: `site:${site.id}`,
      kicker: "home",
      title: site.id,
      sub: `${metro ? metro.name : site.metro} · ${station ? station.name : site.station} · 1 home`,
      sites: [site],
    };
  }
  if (focusedStation) {
    const station = (data.stations || []).find((item) => item.id === focusedStation);
    if (!station) return null;
    const metro = (data.metros || []).find((item) => item.id === station.metro);
    return {
      key: `station:${station.id}`,
      kicker: "service area",
      title: station.name,
      sub: `${metro ? metro.name : "Texas"} · ${fmt(station.units)} homes`,
      sites: fleetSites.filter((site) => site.station === station.id),
    };
  }
  if (focusedMetro) {
    const metro = (data.metros || []).find((item) => item.id === focusedMetro);
    const sites = fleetSites.filter((site) => site.metro === focusedMetro);
    const stations = (data.stations || []).filter((item) => item.metro === focusedMetro);
    return {
      key: `metro:${focusedMetro}`,
      kicker: "metro",
      title: metro ? metro.name : focusedMetro,
      sub: `${fmt(sites.length)} homes · ${fmt(stations.length)} substations`,
      sites,
    };
  }
  return {
    key: "state:ercot",
    kicker: "state",
    title: "Texas",
    sub: `Texas · ${fmt(fleetSites.length)} homes`,
    sites: fleetSites,
  };
}

function renderStage(data) {
  const view = stageView(data);
  if (!view) {
    stageCard.hidden = true;
    stageSignature = "";
    return;
  }
  if (stageCard.hidden || stageCard.dataset.key !== view.key) {
    stageCard.dataset.key = view.key;
    stageCard.hidden = false;
    stageCard.classList.remove("in");
    void stageCard.offsetWidth;
    stageCard.classList.add("in");
  }
  const stamp = (data.fleet || {}).ts || "";
  const signature = `${view.key}|${stamp}|${gridStamp(view.sites)}`;
  if (signature === stageSignature) return;
  stageSignature = signature;

  const kicker = stageCard.querySelector(".stage-kicker");
  if (kicker) kicker.textContent = view.kicker;
  let pushing = 0;
  let pulling = 0;
  let holding = 0;
  let flagged = 0;
  for (const site of view.sites) {
    if (site.alarm || site.grid === "off") flagged += 1;
    if (site.state === "push") pushing += 1;
    else if (site.state === "pull") pulling += 1;
    else holding += 1;
  }
  stageTitle.textContent = view.title;
  stageSub.textContent = view.sub;
  // Same left-to-right order as the lanes: pull, hold, push. Flagged is a
  // colour on a home, not a lane, so it stays last.
  stageCounts.innerHTML = `
    <span class="key pull"><i></i>${fmt(pulling)} pulling</span>
    <span class="key hold"><i></i>${fmt(holding)} holding</span>
    <span class="key push"><i></i>${fmt(pushing)} pushing</span>
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
    if (particles.material.size !== 6) particles.material.size = 6;
    if (payload) renderStage(payload);
    return;
  }
  if (!station) {
    stageT = 1;
    cityT = 1;
    const changed = particles.material.size !== 6;
    if (changed) particles.material.size = 6;
    if (changed && payload) renderUnits(payload);
    if (payload) renderStage(payload);
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
  renderStage(payload);
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
document.querySelector(".nav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-view]");
  if (button) showView(button.dataset.view);
});

document.getElementById("arch").addEventListener("click", (event) => {
  const node = event.target.closest("[data-arch]");
  if (!node || node.dataset.arch === archFocus) return;
  archFocus = node.dataset.arch;
  document.querySelectorAll("#arch-diagram [data-arch]").forEach((item) => {
    item.classList.toggle("on", item.dataset.arch === archFocus);
  });
  document.getElementById("arch-role").textContent = ARCH_ROLE[archFocus] || "";
});

poll().then(() => {
  const [wanted, block] = decodeURIComponent(location.hash.slice(1)).split("/");
  if (wanted === "architecture") {
    showView("architecture");
    return;
  }
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
