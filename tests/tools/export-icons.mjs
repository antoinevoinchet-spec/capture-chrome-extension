// Régénère les PNG de l'icône (16, 32, 48, 128) avec le Chromium de Playwright.
// Usage : node tests/tools/export-icons.mjs
// La 16 vient de icon-16.svg (retouchée aux pixels), les autres de icon.svg. La 128 suit la règle du Chrome Web Store :
// dessin de 96 px centré, marge transparente de 16 px.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const ICONS = path.resolve(import.meta.dirname, '../../extension/icons');
const SIZES = [
  { size: 16, source: 'icon-16.svg', drawn: 16 },
  { size: 32, source: 'icon.svg', drawn: 32 },
  { size: 48, source: 'icon.svg', drawn: 48 },
  { size: 128, source: 'icon.svg', drawn: 96 },
];

const browser = await chromium.launch({ channel: 'chromium' });
try {
  for (const { size, source, drawn } of SIZES) {
    // Une page neuve par taille : redimensionner une même page laissait parfois une image à moitié peinte.
    const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: size, height: size } });
    const svg = await fs.readFile(path.join(ICONS, source), 'utf8');
    const data = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    const margin = (size - drawn) / 2;
    await page.setContent(
      `<html><body style="margin:0;background:transparent"><img src="${data}" width="${drawn}" height="${drawn}" style="position:absolute;left:${margin}px;top:${margin}px"></body></html>`,
    );
    await page.evaluate(() => document.images[0].decode());
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: path.join(ICONS, `icon${size}.png`), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
    console.log(`icon${size}.png`);
  }
} finally {
  await browser.close();
}
