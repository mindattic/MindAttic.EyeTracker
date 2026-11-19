// Builds dist/eyetracker.browser.js: the whole library, MediaPipe's JavaScript included, as one
// ES module a page can import with no bundler of its own.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [path.join(root, 'src/index.ts')],
  outfile: path.join(root, 'dist/eyetracker.browser.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
});
