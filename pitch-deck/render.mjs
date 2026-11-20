// Renders pitch-deck/deck.html to GetCons-Pitch-Deck.pdf (1920x1080 per slide) with a local
// Chromium-based browser (Edge or Chrome) via playwright-core.
// Usage: npm run deck:pdf [-- --png [dir]] [-- --out file.pdf]
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const outFlag = process.argv.indexOf('--out');
const out = outFlag !== -1 && process.argv[outFlag + 1] ? path.resolve(process.argv[outFlag + 1]) : path.join(here, 'GetCons-Pitch-Deck.pdf');
const pngFlag = process.argv.indexOf('--png');
const wantPng = pngFlag !== -1;

async function launch() {
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      /* try the next browser */
    }
  }
  throw new Error('Install Microsoft Edge or Google Chrome to render the deck.');
}

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(pathToFileURL(path.join(here, 'deck.html')).href, { waitUntil: 'load' });
await page.evaluate(async () => {
  await document.fonts.ready;
  await Promise.all([...document.images].map((img) => (img.complete ? null : new Promise((r) => (img.onload = img.onerror = r)))));
});

await page.pdf({ path: out, width: '1920px', height: '1080px', printBackground: true, preferCSSPageSize: true });
console.log(`Saved ${out}`);

if (wantPng) {
  const dir = process.argv[pngFlag + 1] ? path.resolve(process.argv[pngFlag + 1]) : path.join(here, 'preview');
  mkdirSync(dir, { recursive: true });
  const slides = await page.$$('section.slide');
  for (const [i, slide] of slides.entries()) {
    await slide.screenshot({ path: path.join(dir, `slide-${String(i + 1).padStart(2, '0')}.png`) });
  }
  console.log(`Saved ${slides.length} previews to ${dir}`);
}
await browser.close();
