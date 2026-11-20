// Turns the robot 3D model into the landing's particle cloud (web/src/components/landing/robot-cloud.bin).
//
//   node scripts/robot-cloud/convert.mjs <model.fbx> [out.bin] [--points 68000] [--top 6] [--chin 4.45] [--neck 4.15] [--zc 0.1]
//
// The model folder must also hold its base colour texture named like the model ("<name>.png").
// --top / --chin / --neck are heights in the model's own units (top of the head, bottom of the
// helmet, base of the neck) and --zc the depth of the neck axis: they scale the robot so the head
// lands where the landing's camera choreography expects it (chin at y = 1.3, top at y = 2.4).
// Needs Microsoft Edge or Google Chrome (headless, through playwright-core) for WebGL.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const modelPath = positional[0] && path.resolve(positional[0]);
const outPath = path.resolve(positional[1] ?? path.join(root, 'web/src/components/landing/robot-cloud.bin'));
if (!modelPath) {
  console.error('Usage: node scripts/robot-cloud/convert.mjs <model.fbx|glb|obj> [out.bin] [--points 68000]');
  process.exit(1);
}
const modelDir = path.dirname(modelPath);
const modelName = path.basename(modelPath);
const threeDir = path.join(root, 'node_modules', 'three');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = url.startsWith('/three/')
    ? path.join(threeDir, url.slice(7))
    : url.startsWith('/model/')
      ? path.join(modelDir, url.slice(7))
      : path.join(here, url === '/' ? 'page.html' : url.slice(1));
  const base = url.startsWith('/three/') ? threeDir : url.startsWith('/model/') ? modelDir : here;
  try {
    if (!path.resolve(file).startsWith(path.resolve(base)) || !(await stat(file)).isFile()) throw new Error('not found');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let browser;
for (const channel of ['msedge', 'chrome']) {
  try {
    browser = await chromium.launch({ channel, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
    break;
  } catch {
    /* try the next browser */
  }
}
if (!browser) throw new Error('Install Microsoft Edge or Google Chrome to convert the model.');
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.ready && window.latticeReady, null, { timeout: 60_000 });
  const info = await page.evaluate((n) => window.loadModel(n), modelName);
  console.log(`model loaded: ${info.meshes} mesh(es)`);
  const r = await page.evaluate((o) => window.convertLattice(o), {
    N: flag('points', 68000), seed: 7, dirs: 64, mapSize: 1600, eps: 0.04, blur: 3, whiteLum: 110, darkTone: 2,
    topY: flag('top', 6.0), chinY: flag('chin', 4.45), neckLo: flag('neck', 4.15), zc: flag('zc', 0.1),
    base: modelName.replace(/\.[^.]+$/, ''),
  });
  for (const line of r.log) console.log(line);
  writeFileSync(outPath, Buffer.from(r.b64, 'base64'));
  console.log(`wrote ${outPath}`);
} finally {
  await browser.close();
  server.close();
}
