// Builds dist/webcam.browser.js: the whole library, MediaPipe's JavaScript included, as one
// ES module a page can import with no bundler of its own.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [path.join(root, 'src/index.ts')],
  outfile: path.join(root, 'dist/webcam.browser.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
});

// The old file name keeps working: pages that import dist/eyetracker.browser.js (the library was
// called EyeTracker before it became MindAttic.Webcam) get the same module.
import { writeFileSync } from 'node:fs';
writeFileSync(path.join(root, 'dist/eyetracker.browser.js'), "export * from './webcam.browser.js';\n");
