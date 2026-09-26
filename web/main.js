import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const TEXAS = [
  [36.5, -103.05], [36.5, -100.0], [34.56, -100.0], [33.85, -94.7],
  [33.55, -94.05], [31.95, -94.05], [29.7, -93.85], [29.3, -94.8],
  [28.6, -96.0], [27.5, -97.2], [26.0, -97.15], [25.84, -97.4],
  [27.8, -99.5], [29.35, -100.95], [30.2, -104.7], [31.76, -106.48],
  [32.0, -106.62], [32.0, -103.06],
];

const ORIGIN = { lat: 31.2, lon: -99.2 };
const COLOR = {
  pull: 0x8eb6d9,
  push: 0xe0a15a,
  hold: 0x8a9086,
  alarm: 0xe15b4c,
};

const canvas = document.getElementById("map");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x101114);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
camera.position.set(0.2, 14, 13);
const controls = new OrbitControls(camera, canvas);
controls.enablePan = false;
controls.target.set(0.4, 0, 0.2);
controls.update();

function project(lat, lon, y = 0) {
  return new THREE.Vector3((lon - ORIGIN.lon) * 0.92, y, (ORIGIN.lat - lat) * 1.05);
}

const outline = new THREE.LineLoop(
  new THREE.BufferGeometry().setFromPoints(TEXAS.map(([lat, lon]) => project(lat, lon, 0))),
  new THREE.LineBasicMaterial({ color: 0x3a3d44 }),
);
scene.add(outline);

const bars = new Map();
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let payload = null;
let selected = null;

function resize() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== width || canvas.height !== height) {
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
  }
}

function ensureBar(site) {
  let bar = bars.get(site.id);
  if (bar) return bar;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, 1, 0.1),
    new THREE.MeshBasicMaterial({ color: COLOR.hold }),
  );
  mesh.userData.id = site.id;
  scene.add(mesh);
  bar = { mesh };
  bars.set(site.id, bar);
  return bar;
}

function modeOf(site) {
  return site.alarm ? "alarm" : site.signal || "hold";
}

function renderSites(data) {
  const seen = new Set();
  for (const site of data.sites) {
    seen.add(site.id);
    const bar = ensureBar(site);
    const soc = (site.soc_pct ?? 60) / 100;
    const height = 0.18 + soc * 1.15;
    bar.mesh.scale.y = height;
    const point = project(site.lat, site.lon, height / 2);
    bar.mesh.position.copy(point);
    bar.mesh.material.color.setHex(COLOR[modeOf(site)]);
  }
  for (const [id, bar] of bars) {
    if (!seen.has(id)) {
      scene.remove(bar.mesh);
      bars.delete(id);
    }
  }
  const edgeName = "edges";
  const previous = scene.getObjectByName(edgeName);
  if (previous) scene.remove(previous);
  if (data.edges?.length) {
    const points = [];
    for (const edge of data.edges) {
      points.push(project(edge.from_lat, edge.from_lon, 0.02));
      points.push(project(edge.to_lat, edge.to_lon, 0.02));
    }
    const lines = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: 0xc4b59a }),
    );
    lines.name = edgeName;
    scene.add(lines);
  }
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
  const feed = ercot.dashboard === "live" ? "live" : ercot.dashboard || "offline";
  document.getElementById("stats").innerHTML = `
    <span>demand <b>${fmt(grid.demand_mw)} MW</b></span>
    <span>storage <b>${fmt(grid.storage_gen_mw, 0)} MW</b></span>
    <span>wind <b>${fmt(grid.wind_mw)} MW</b></span>
    <span>solar <b>${fmt(grid.solar_mw)} MW</b></span>
    <span>feed <b>${feed}</b></span>
  `;
}

function row(label, text) {
  return `<p>${label} ${text}</p>`;
}

function renderPanel(data) {
  const panel = document.getElementById("panel");
  if (!data.sites?.length) {
    panel.innerHTML = `<p class="muted">No homes in this snapshot.</p>`;
    return;
  }
  if (!selected || !data.sites.some((site) => site.id === selected)) {
    selected = (data.sites.find((site) => site.alarm) || data.sites[0]).id;
  }
  const site = data.sites.find((item) => item.id === selected);
  const metrics = site.metrics || {};
  const grid = metrics.grid || {};
  const meter = metrics.meter || {};
  const disco = metrics.disco || {};
  const house = metrics.panel || {};
  const base = metrics.base || {};
  const care = metrics.maintenance || {};
  const mode = modeOf(site);
  const constraints = (data.constraints || []).slice(0, 6);
  const constraintHtml = constraints.length
    ? `<ul class="constraints">${constraints.map((item) => `<li>${item.constraint_name || "constraint"} · ${item.from_station || "?"} → ${item.to_station || "?"} · ${fmt(item.shadow_price, 1)} $/MW</li>`).join("")}</ul>`
    : `<p class="muted">Binding constraints appear after the ERCOT subscription key is set. Lines are drawn only for station codes listed in station_geo.json.</p>`;
  const alarm = site.alarm
    ? `<p class="alarm-note">Outside the normal band. Temp z ${fmt(care.base_temp_z, 1)}, voltage z ${fmt(care.disco_voltage_z, 1)}, meter gap z ${fmt(care.disco_meter_delta_z, 1)}.</p>`
    : "";

  panel.innerHTML = `
    <h2>${site.id}</h2>
    <div class="sub">${site.city} · ${site.load_zone}</div>
    <div class="mode ${mode}"><i></i>${mode}</div>
    <div class="stack">
      <h3>Grid</h3>
      ${row("in", `${fmt(grid.in_kw, 2)} kW`)}
      ${row("out", `${fmt(grid.out_kw, 2)} kW`)}
      ${row("LMP", grid.lmp_usd_mwh == null ? "—" : `${fmt(grid.lmp_usd_mwh, 2)} $/MWh`)}
      <h3>Meter</h3>
      ${row("in", `${fmt(meter.in_kw, 2)} kW`)}
      ${row("out", `${fmt(meter.out_kw, 2)} kW`)}
      ${row("voltage", `${fmt(meter.voltage_v, 1)} V`)}
      <h3>Disco</h3>
      ${row("in", `${fmt(disco.in_kw, 2)} kW`)}
      ${row("out", `${fmt(disco.out_kw, 2)} kW`)}
      ${row("voltage", `${fmt(disco.voltage_v, 1)} V`)}
      ${row("frequency", `${fmt(disco.frequency_hz, 3)} Hz`)}
      <h3>Panel</h3>
      ${row("load", `${fmt(house.load_kw, 2)} kW`)}
      <h3>Base</h3>
      ${row("state of charge", `${fmt(base.soc_pct, 1)}%`)}
      ${row("charge", `${fmt(base.charge_kw, 2)} kW`)}
      ${row("discharge", `${fmt(base.discharge_kw, 2)} kW`)}
      ${row("temperature", `${fmt(base.temp_c, 1)} °C`)}
    </div>
    ${alarm}
    <div class="constraints">
      <h3>Binding constraints</h3>
      ${constraintHtml}
    </div>
  `;
}

function nearestSite(clientX, clientY) {
  if (!payload?.sites?.length) return null;
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  let best = null;
  let bestDist = 48;
  for (const site of payload.sites) {
    const ndc = project(site.lat, site.lon, 0.4).project(camera);
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

canvas.addEventListener("pointerdown", (event) => {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects([...bars.values()].map((bar) => bar.mesh));
  const hit = hits[0]?.object.userData.id || nearestSite(event.clientX, event.clientY);
  if (hit) {
    selected = hit;
    if (payload) renderPanel(payload);
  }
});

async function poll() {
  try {
    const response = await fetch("/api/scene");
    payload = await response.json();
    renderSites(payload);
    renderStats(payload);
    renderPanel(payload);
  } catch (error) {
    document.getElementById("panel").innerHTML = `<p class="muted">Scene unavailable. ${error.message}</p>`;
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
