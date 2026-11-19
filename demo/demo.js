// Gaze lab: a three.js scene that reacts to where you look, plus an accuracy check.
// It is both the library's demo and its manual test: every public piece is exercised here
// (local camera, remote tracker through the bridge, mouse stand-in, calibration UI, gaze events).
import * as THREE from '/vendor/three/three.module.js';
import { EyeTracker, MouseGazeSource, RemoteGazeSource, runCalibration, LM } from '/dist/eyetracker.browser.js';

const $ = (id) => document.getElementById(id);
const config = await fetch('/config.json').then((r) => r.json()).catch(() => ({}));

// ---------- scene ----------
const COLS = 32;
const ROWS = 18;
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070d);
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
const DIST = 10;
camera.position.set(0, 0, DIST);
scene.add(new THREE.AmbientLight(0x8fa6d8, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(-3, 5, 8);
scene.add(key);
const glow = new THREE.PointLight(0x7fd4ff, 30, 6, 1.6);
scene.add(glow);

const tiles = new THREE.InstancedMesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.15 }),
  COLS * ROWS,
);
scene.add(tiles);
const heat = new Float32Array(COLS * ROWS);
const orb = new THREE.Mesh(
  new THREE.RingGeometry(0.16, 0.2, 48),
  new THREE.MeshBasicMaterial({ color: 0x7fd4ff, transparent: true, opacity: 0.9 }),
);
scene.add(orb);

let viewW = 1;
let viewH = 1;
function resize() {
  const w = innerWidth;
  const h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  // The tile wall exactly fills the view at z = 0, so a normalized gaze point maps straight onto it.
  viewH = 2 * DIST * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  viewW = viewH * camera.aspect;
}
addEventListener('resize', resize);
resize();

const dummy = new THREE.Object3D();
const cold = new THREE.Color(0x121a2a);
const hot = new THREE.Color(0x7fd4ff);
const tint = new THREE.Color();
let gaze = null;

function frame() {
  const gx = gaze ? (gaze.x - 0.5) * viewW : 0;
  const gy = gaze ? (0.5 - gaze.y) * viewH : 0;
  const cw = viewW / COLS;
  const ch = viewH / ROWS;
  const reach = viewH * 0.11;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c;
      const x = (c + 0.5) * cw - viewW / 2;
      const y = viewH / 2 - (r + 0.5) * ch;
      if (gaze && gaze.confidence > 0) {
        const d = Math.hypot(x - gx, y - gy);
        heat[i] = Math.max(heat[i], Math.exp(-(d * d) / (2 * reach * reach)));
      }
      heat[i] *= 0.955;
      const hgt = 0.15 + heat[i] * 1.6;
      dummy.position.set(x, y, hgt / 2 - 0.6);
      dummy.scale.set(cw * 0.92, ch * 0.92, hgt);
      dummy.updateMatrix();
      tiles.setMatrixAt(i, dummy.matrix);
      tiles.setColorAt(i, tint.copy(cold).lerp(hot, heat[i]));
    }
  }
  tiles.instanceMatrix.needsUpdate = true;
  tiles.instanceColor.needsUpdate = true;
  orb.visible = !!gaze;
  orb.position.set(gx, gy, 1.2);
  orb.material.opacity = gaze && gaze.confidence > 0 ? 0.9 : 0.25;
  glow.position.set(gx, gy, 1.4);
  glow.intensity = gaze && gaze.confidence > 0 ? 30 : 0;
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- sources ----------
let source = null;
let stopSource = () => {};
let offGaze = () => {};

function set(id, text, cls) {
  const el = $(id);
  el.textContent = text;
  el.className = cls || '';
}

function use(next, label, stop) {
  offGaze();
  stopSource();
  source = next;
  stopSource = stop;
  set('s-source', label);
  offGaze = source.on('gaze', (g) => {
    gaze = g;
    set('s-gaze', `${g.x.toFixed(2)}, ${g.y.toFixed(2)}`);
    set('s-conf', g.confidence.toFixed(2), g.confidence > 0.5 ? 'ok' : 'warn');
    set('s-face', g.face ? 'found' : 'not found', g.face ? 'ok' : 'warn');
    set('s-calib', g.calibrated ? 'yes' : 'no', g.calibrated ? 'ok' : 'warn');
  });
  $('calibrate').disabled = false;
  $('check').disabled = false;
}

$('camera').addEventListener('click', async () => {
  $('preview').hidden = false;
  const tracker = new EyeTracker({
    storageKey: 'demo',
    camera: { video: $('video'), wasmBaseUrl: config.wasmBaseUrl, modelUrl: config.modelUrl },
  });
  tracker.on('status', (s) => {
    if (s.state === 'error') $('report').textContent = s.error;
    set('s-fps', s.state === 'running' ? `${s.fps}/s` : s.state, s.fps >= 20 ? 'ok' : 'warn');
  });
  tracker.on('frame', drawPreview);
  $('report').textContent = 'Starting the camera and loading the face model...';
  try {
    await tracker.start();
  } catch {
    return;
  }
  use(tracker, 'this camera', () => {
    tracker.stop();
    $('preview').hidden = true;
  });
  $('report').textContent = tracker.calibrated
    ? 'Using your saved calibration. Calibrate again if the dot is off.'
    : 'Now calibrate: until you do, the gaze point is only a rough guess.';
});

$('remote').addEventListener('click', () => {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const remote = new RemoteGazeSource(`${scheme}://${location.host}/gaze`, { name: 'gaze lab' });
  const tell = () => {
    set('s-fps', remote.connected ? `${remote.trackers} tracker(s)` : 'connecting', remote.trackers ? 'ok' : 'warn');
    if (!remote.trackers) {
      const phone = config.tlsPort && config.addresses?.[0] ? `https://${config.addresses[0]}:${config.tlsPort}/tracker/` : null;
      $('report').textContent = `Waiting for a tracker. Open ${phone ? phone + ' on your phone, or ' : ''}${location.origin}/tracker/ in another window, and start its camera.`;
    } else {
      $('report').textContent = 'Tracker connected. Calibrate: the dots show here, the phone watches your eyes.';
    }
  };
  remote.on('peers', tell);
  remote.on('connection', tell);
  use(remote, 'remote tracker', () => remote.close());
  tell();
});

$('mouse').addEventListener('click', () => {
  const mouse = new MouseGazeSource();
  mouse.start();
  use(mouse, 'mouse', () => mouse.stop());
  set('s-fps', 'display rate');
  $('report').textContent = 'The pointer is standing in for your eyes.';
});

$('calibrate').addEventListener('click', async () => {
  const result = await runCalibration(source, { points: 9, fullscreen: true });
  if (result.ok) {
    $('report').textContent = `Calibrated on ${result.targets} points. Expected error: about ${(result.crossError * 100).toFixed(1)}% of the screen. Run the accuracy check to measure it.`;
  } else if (result.reason !== 'cancelled') {
    $('report').textContent = `Calibration failed: ${result.reason}.`;
  }
});

// ---------- accuracy check ----------
// Shows targets the calibration never saw and measures how far the gaze lands from each.
$('check').addEventListener('click', async () => {
  const target = $('target');
  const points = [];
  for (let i = 0; i < 8; i++) points.push({ x: 0.12 + Math.random() * 0.76, y: 0.12 + Math.random() * 0.76 });
  const errors = [];
  $('check').disabled = true;
  target.style.display = 'block';
  for (const p of points) {
    target.style.left = `${p.x * 100}%`;
    target.style.top = `${p.y * 100}%`;
    await new Promise((r) => setTimeout(r, 800));
    const seen = [];
    const off = source.on('gaze', (g) => {
      if (g.confidence > 0) seen.push(g);
    });
    await new Promise((r) => setTimeout(r, 700));
    off();
    if (seen.length) {
      const mx = seen.reduce((s, g) => s + g.x, 0) / seen.length;
      const my = seen.reduce((s, g) => s + g.y, 0) / seen.length;
      errors.push(Math.hypot((mx - p.x) * innerWidth, (my - p.y) * innerHeight));
    }
  }
  target.style.display = 'none';
  $('check').disabled = false;
  if (!errors.length) {
    $('report').textContent = 'No gaze was received during the check.';
    return;
  }
  const mean = errors.reduce((s, e) => s + e, 0) / errors.length;
  const worst = Math.max(...errors);
  const percent = (mean / Math.hypot(innerWidth, innerHeight)) * 100;
  $('report').textContent = `Accuracy over ${errors.length} points: ${Math.round(mean)} px average (${percent.toFixed(1)}% of the screen diagonal), ${Math.round(worst)} px worst.`;
});

// ---------- camera preview ----------
const overlay = $('overlay');
const ctx = overlay.getContext('2d');
function drawPreview({ frame }) {
  const video = $('video');
  if (overlay.width !== video.videoWidth) {
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;
  }
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!frame) return;
  const lm = frame.landmarks;
  const at = (i) => [lm[i].x * overlay.width, lm[i].y * overlay.height];
  ctx.lineWidth = Math.max(2, overlay.width / 320);
  ctx.strokeStyle = '#7fd4ff';
  for (const iris of [LM.rightIris, LM.leftIris]) {
    const [cx, cy] = at(iris[0]);
    const [ex] = at(iris[1]);
    ctx.beginPath();
    ctx.arc(cx, cy, Math.abs(ex - cx), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = '#ffc266';
  for (const i of [LM.rightOuter, LM.rightInner, LM.leftInner, LM.leftOuter]) {
    const [x, y] = at(i);
    ctx.beginPath();
    ctx.arc(x, y, ctx.lineWidth * 1.3, 0, Math.PI * 2);
    ctx.fill();
  }
}
