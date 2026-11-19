// Downloads MediaPipe's face landmark model into models/ so the bridge can serve it locally.
// The bridge does this by itself on first start; this script is for doing it ahead of time.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const url =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'models', 'face_landmarker.task');

if (fs.existsSync(file)) {
  console.log(`already present: ${file}`);
} else {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  console.log(`saved ${file}`);
}
