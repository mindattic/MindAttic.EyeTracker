#!/usr/bin/env node
// The Webcam bridge: one small local server that
//   1. serves the tracker page (the page that owns the camera) and the demo, with MediaPipe's
//      files and the face model served locally so it works with no internet connection,
//   2. relays gaze from trackers to displays over WebSocket (docs/PROTOCOL.md).
//
// A display is whatever consumes gaze: a browser game, a Unity game, an Unreal game.
// Plain http/ws is served for this machine (browsers allow the camera on localhost); https/wss
// with a self-signed certificate is served for phones on the same network, because a browser
// only allows the camera on a secure page.
//
//   node bridge/server.mjs [--port 8787] [--tls-port 8788] [--no-tls] [--open] [--open-path /play/]
//                          [--mount /play=path/to/folder]   serve another folder (a game build)

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const PROTOCOL_VERSION = 1;

// ---- arguments ----
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const port = Number(value('--port', process.env.EYETRACKER_PORT ?? 8787));
const tlsPort = Number(value('--tls-port', process.env.EYETRACKER_TLS_PORT ?? 8788));
const useTls = !flag('--no-tls');
if (flag('--help') || flag('-h')) {
  console.log('eyetracker-bridge [--port 8787] [--tls-port 8788] [--no-tls] [--open] [--open-path /path/] [--mount /url=folder]');
  process.exit(0);
}

// ---- static files ----
const packageDir = (name) => {
  let dir = path.dirname(require.resolve(name));
  while (!fs.existsSync(path.join(dir, 'package.json'))) dir = path.dirname(dir);
  return dir;
};
const mounts = [
  ['/dist/', path.join(root, 'dist')],
  ['/demo/', path.join(root, 'demo')],
  ['/tracker/', path.join(root, 'tracker')],
  ['/models/', path.join(root, 'models')],
  ['/vendor/mediapipe/wasm/', path.join(packageDir('@mediapipe/tasks-vision'), 'wasm')],
];
try {
  mounts.push(['/vendor/three/', path.join(packageDir('three'), 'build')]);
} catch {
  // three is only needed by the demo page; a production install may not have it.
}
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--mount' || !args[i + 1]) continue;
  const eq = args[i + 1].indexOf('=');
  if (eq < 1) continue;
  let prefix = args[i + 1].slice(0, eq);
  if (!prefix.startsWith('/')) prefix = '/' + prefix;
  if (!prefix.endsWith('/')) prefix += '/';
  mounts.unshift([prefix, path.resolve(args[i + 1].slice(eq + 1))]);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const modelPath = path.join(root, 'models', 'face_landmarker.task');

function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  if (pathname === '/') {
    res.writeHead(302, { Location: '/demo/' }).end();
    return;
  }
  if (pathname === '/config.json') {
    // Pages ask where to load MediaPipe from: always this server, so they work offline.
    const body = JSON.stringify({
      protocol: PROTOCOL_VERSION,
      wasmBaseUrl: '/vendor/mediapipe/wasm',
      modelUrl: fs.existsSync(modelPath) ? '/models/face_landmarker.task' : MODEL_URL,
      port,
      tlsPort: useTls ? tlsPort : null,
      addresses: lanAddresses(),
    });
    res.writeHead(200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' }).end(body);
    return;
  }
  for (const [prefix, dir] of mounts) {
    if (pathname + '/' === prefix) {
      res.writeHead(302, { Location: prefix }).end();
      return;
    }
    if (!pathname.startsWith(prefix)) continue;
    let rel = pathname.slice(prefix.length);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(dir, rel);
    // Never serve anything outside the mounted folder.
    if (file !== dir && !file.startsWith(dir + path.sep)) break;
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      if (req.method === 'HEAD') res.end();
      else fs.createReadStream(file).pipe(res);
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
}

// ---- gaze relay ----
/** room name -> set of sockets; each socket carries { role, id }. */
const rooms = new Map();
let nextId = 1;

function count(room, role) {
  let n = 0;
  for (const s of rooms.get(room) ?? []) if (s.role === role) n++;
  return n;
}

function announce(room) {
  const message = JSON.stringify({ type: 'peers', trackers: count(room, 'tracker'), displays: count(room, 'display') });
  for (const s of rooms.get(room) ?? []) if (s.readyState === 1) s.send(message);
}

function attach(server) {
  const wss = new WebSocketServer({ server, path: '/gaze', maxPayload: 64 * 1024 });
  // The socket server repeats the http server's errors (a port already in use, for one). They are
  // reported where the port is opened, so here they only need to not crash the process.
  wss.on('error', () => {});
  wss.on('connection', (socket) => {
    socket.role = null;
    socket.room = null;
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString();
      if (!socket.role) {
        let hello;
        try {
          hello = JSON.parse(text);
        } catch {
          return;
        }
        if (hello?.type !== 'hello' || (hello.role !== 'tracker' && hello.role !== 'display')) return;
        socket.role = hello.role;
        socket.room = typeof hello.room === 'string' && hello.room ? hello.room.slice(0, 64) : 'default';
        socket.id = String(nextId++);
        if (!rooms.has(socket.room)) rooms.set(socket.room, new Set());
        rooms.get(socket.room).add(socket);
        socket.send(
          JSON.stringify({
            type: 'welcome',
            v: PROTOCOL_VERSION,
            id: socket.id,
            room: socket.room,
            trackers: count(socket.room, 'tracker'),
            displays: count(socket.room, 'display'),
          }),
        );
        announce(socket.room);
        log(`${socket.role} ${hello.name ? `"${String(hello.name).slice(0, 40)}" ` : ''}joined room ${socket.room}`);
        return;
      }
      // Everything after the hello goes to the other side of the room, untouched.
      const other = socket.role === 'tracker' ? 'display' : 'tracker';
      for (const peer of rooms.get(socket.room) ?? []) {
        if (peer.role === other && peer.readyState === 1 && peer.bufferedAmount < 256 * 1024) peer.send(text);
      }
    });
    socket.on('close', () => {
      if (!socket.room) return;
      rooms.get(socket.room)?.delete(socket);
      if (rooms.get(socket.room)?.size === 0) rooms.delete(socket.room);
      else announce(socket.room);
      log(`${socket.role} left room ${socket.room}`);
    });
    socket.on('error', () => socket.close());
  });
}

// ---- helpers ----
function log(text) {
  console.log(`[bridge] ${text}`);
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

async function certificate() {
  const dir = path.join(root, 'bridge', '.cert');
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  const hostsFile = path.join(dir, 'hosts.json');
  const hosts = ['localhost', '127.0.0.1', ...lanAddresses()];
  try {
    // Reuse the certificate while it still covers this machine's addresses, so a phone that
    // accepted it once is not asked again.
    const known = JSON.parse(fs.readFileSync(hostsFile, 'utf8'));
    if (hosts.every((h) => known.includes(h))) {
      return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
    }
  } catch {
    // No certificate yet.
  }
  const selfsigned = (await import('selfsigned')).default;
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'MindAttic Webcam bridge' }], {
    keySize: 2048,
    days: 825,
    algorithm: 'sha256',
    extensions: [
      {
        name: 'subjectAltName',
        altNames: hosts.map((h) => (/^\d+\.\d+\.\d+\.\d+$/.test(h) ? { type: 7, ip: h } : { type: 2, value: h })),
      },
    ],
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyFile, pems.private);
  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(hostsFile, JSON.stringify(hosts));
  return { key: pems.private, cert: pems.cert };
}

async function fetchModel() {
  if (fs.existsSync(modelPath)) return;
  try {
    const response = await fetch(MODEL_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath + '.part', bytes);
    fs.renameSync(modelPath + '.part', modelPath);
    log(`saved the face model (${(bytes.length / 1048576).toFixed(1)} MB); it is now served locally`);
  } catch (err) {
    log(`could not download the face model (${err.message}); pages will load it from the internet instead`);
  }
}

function listen(server, p, label) {
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      reject(new Error(err.code === 'EADDRINUSE' ? `port ${p} is already in use (is another bridge running?)` : err.message));
    });
    // No host: Node then listens on IPv6 and IPv4 together, so "localhost" works whichever a client resolves it to.
    server.listen(p, () => {
      log(`${label} on port ${p}`);
      resolve();
    });
  });
}

// ---- start ----
if (!fs.existsSync(path.join(root, 'dist', 'webcam.browser.js'))) {
  console.error('dist/webcam.browser.js is missing. Run "npm run build" first.');
  process.exit(1);
}

try {
  const plain = http.createServer(handle);
  attach(plain);
  await listen(plain, port, 'http + ws');
  if (useTls) {
    const secure = https.createServer(await certificate(), handle);
    attach(secure);
    await listen(secure, tlsPort, 'https + wss');
  }
} catch (err) {
  console.error(`[bridge] ${err.message}`);
  process.exit(1);
}

console.log('');
console.log('  On this computer');
console.log(`    Tracker page (uses this computer's webcam):  http://localhost:${port}/tracker/`);
console.log(`    Demo and accuracy check:                     http://localhost:${port}/demo/`);
console.log(`    Games connect to:                            ws://localhost:${port}/gaze`);
if (useTls) {
  const addresses = lanAddresses();
  console.log('');
  console.log('  On a phone on the same Wi-Fi (accept the certificate warning once)');
  if (addresses.length === 0) console.log('    No network address found.');
  for (const a of addresses) console.log(`    https://${a}:${tlsPort}/tracker/`);
}
console.log('');

fetchModel();

const openPath = value('--open-path', null);
if (flag('--open') || openPath) {
  const target = `http://localhost:${port}${openPath ?? '/demo/'}`;
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const commandArgs = process.platform === 'win32' ? ['/c', 'start', '', target] : [target];
  spawn(command, commandArgs, { stdio: 'ignore', detached: true }).unref();
}
