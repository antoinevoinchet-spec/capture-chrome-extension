// Aides partagées par les suites de test (e2e.mjs, annotate.mjs) : lancement du Chromium de Playwright
// avec l'extension, serveur de pages, capture, lecture du presse-papiers et fabrication de captures synthétiques.

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

export const EXTENSION = path.resolve(import.meta.dirname, '../extension');

// Contenu connu d'une capture synthétique (en points) : une ligne « Ligne n » tous les `lineStep` points
// (boîte de texte de `lineTop` à `lineTop + lineHeight`), une bande magenta de `bandHeight` points
// à partir de chaque multiple de `bandStep` (sauf 0), sans ligne de texte dessus.
export const SEED_LAYOUT = {
  lineStep: 60,
  lineTop: 16,
  lineHeight: 28,
  bandStep: 1000,
  bandHeight: 40,
  magenta: [255, 0, 170],
};

// Hauteur d'une tranche synthétique, en pixels réels.
const SEED_SLICE_PX = 1800;

export const results = [];
export function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'OK  ' : 'ÉCHEC'} ${name}${detail ? `  [${detail}]` : ''}`);
}

// Ce que le vrai manifeste doit dire à ce lot. Mis à jour en même temps que lui : les suites de tous les lots le lisent.
export const MANIFEST_EXPECTED = {
  version: '0.2.0',
  permissions: ['activeTab', 'scripting', 'downloads', 'storage', 'contextMenus', 'offscreen'],
  optional_host_permissions: ['http://*/*', 'https://*/*'],
};

// Copie de test : ajoute <all_urls> pour lancer la capture sans cliquer sur l'icône,
// et la lecture du presse-papiers pour vérifier « Copier ».
// `allHosts: false` : copie sans ces deux ajouts, qui masqueraient une permission manquante.
export async function prepareExtension(work, { allHosts = true } = {}) {
  const dir = path.join(work, allHosts ? 'extension' : 'extension-sans-hotes');
  await fs.cp(EXTENSION, dir, { recursive: true });
  if (!allHosts) return dir;
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  manifest.permissions.push('clipboardRead');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

export function serve(root) {
  const server = http.createServer(async (req, res) => {
    try {
      const body = await fs.readFile(path.join(root, path.basename(new URL(req.url, 'http://x').pathname)));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

export function launch(extension, profile, work) {
  return chromium.launchPersistentContext(path.join(work, profile), {
    channel: 'chromium',
    headless: true,
    viewport: null,
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--window-size=1280,900',
      '--force-device-scale-factor=2',
    ],
  });
}

export async function openTab(context, sw, url) {
  const before = await sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.id));
  const page = await context.newPage();
  await page.goto(url);
  await page.bringToFront();
  const tabId = await sw.evaluate(
    async (known) => (await chrome.tabs.query({})).find((t) => !known.includes(t.id))?.id,
    before,
  );
  return { page, tabId };
}

export async function capture(context, sw, tabId, mode) {
  const viewerOpened = context
    .waitForEvent('page', { predicate: (p) => p.url().includes('/viewer/viewer.html'), timeout: 180_000 })
    .catch(() => null);
  const started = Date.now();
  const id = await sw.evaluate(({ tabId, mode }) => self.captureTab(tabId, mode), { tabId, mode });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (!id) {
    const title = await sw.evaluate((tabId) => chrome.action.getTitle({ tabId }).catch(() => null), tabId);
    return { id: null, error: title, seconds };
  }
  const viewer = await viewerOpened;
  await viewer.waitForSelector('body[data-ready="true"]', { timeout: 180_000 });
  return { id, viewer, seconds };
}

// Clique sur un bouton de copie, attend la notification, puis relit l'image du presse-papiers.
export async function copyAndRead(viewer, trigger) {
  await viewer.evaluate(() => (document.getElementById('toast').hidden = true));
  await trigger.click();
  await viewer.waitForFunction(
    () => {
      const toast = document.getElementById('toast');
      return !toast.hidden && /presse-papiers|impossible/.test(toast.textContent);
    },
    null,
    { timeout: 60_000 },
  );
  const message = (await viewer.locator('#toast').innerText()).trim();
  const size = await viewer.evaluate(async () => {
    try {
      const [item] = await navigator.clipboard.read();
      const bmp = await createImageBitmap(await item.getType('image/png'));
      return `${bmp.width} × ${bmp.height}`;
    } catch (err) {
      return `lecture impossible : ${err.message}`;
    }
  });
  return { message, size };
}

// Ouvre une page de l'extension (chemin relatif à sa racine) dans un nouvel onglet.
export async function extensionPage(context, pagePath) {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(sw.url()).host}/${pagePath}`);
  return page;
}

// Fabrique une capture synthétique dans l'IndexedDB de l'extension et rend son id.
// `page` doit être une page de l'extension. Contenu : voir SEED_LAYOUT. `draw`, facultatif, est une fonction
// autonome (elle est recopiée en texte dans la page, donc sans variable extérieure) appelée une fois par tranche
// après le contenu standard : draw(ctx, { scale, width, height }), ctx étant en pixels de la capture entière.
export function seedCapture(page, { heightPoints, scale = 2, widthPoints = 1280, draw, createdAt = Date.now() }) {
  const options = { heightPoints, scale, widthPoints, createdAt, layout: SEED_LAYOUT, slicePx: SEED_SLICE_PX };
  return page.evaluate(`(${seedInPage})(${JSON.stringify(options)}, ${draw ?? 'null'})`);
}

// S'exécute dans la page de l'extension (envoyée en texte par seedCapture) : ne rien y référencer d'extérieur.
async function seedInPage({ heightPoints, scale, widthPoints, createdAt, layout, slicePx }, draw) {
  const { saveCapture } = await import(chrome.runtime.getURL('lib/db.js'));
  const width = Math.round(widthPoints * scale);
  const height = Math.round(heightPoints * scale);
  const sliceH = Math.min(slicePx, height);
  // Comme une vraie capture : tranches bout à bout, la dernière calée sur le bas (elle chevauche la précédente).
  const positions = [];
  for (let y = 0; y + sliceH < height; y += sliceH) positions.push(y);
  positions.push(height - sliceH);

  const bandAt = (k) => k * layout.bandStep;
  const lineTop = (n) => n * layout.lineStep + layout.lineTop;
  const hitsBand = (top, bottom) => {
    const k = Math.floor(bottom / layout.bandStep);
    return k >= 1 && bottom > bandAt(k) && top < bandAt(k) + layout.bandHeight;
  };

  const canvas = new OffscreenCanvas(width, sliceH);
  const ctx = canvas.getContext('2d');
  const slices = [];
  for (const y of positions) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, sliceH);
    ctx.translate(0, -y);

    // Contenu standard, dessiné en points puis remis en pixels pour `draw`.
    ctx.save();
    ctx.scale(scale, scale);
    const from = y / scale;
    const to = (y + sliceH) / scale;
    ctx.fillStyle = `rgb(${layout.magenta.join(',')})`;
    for (let k = Math.max(1, Math.floor((from - layout.bandHeight) / layout.bandStep)); bandAt(k) < to; k++) {
      ctx.fillRect(0, bandAt(k), widthPoints, layout.bandHeight);
    }
    ctx.fillStyle = '#000';
    ctx.font = '24px sans-serif';
    ctx.textBaseline = 'top';
    for (let n = Math.max(0, Math.floor((from - layout.lineTop - layout.lineHeight) / layout.lineStep)); lineTop(n) < to; n++) {
      if (!hitsBand(lineTop(n), lineTop(n) + layout.lineHeight)) ctx.fillText(`Ligne ${n}`, 40, lineTop(n));
    }
    ctx.restore();

    draw?.(ctx, { scale, width, height });
    slices.push({ y, blob: await canvas.convertToBlob({ type: 'image/png' }) });
  }

  return saveCapture({
    mode: 'full',
    url: 'http://127.0.0.1/capture-synthetique',
    title: 'Capture synthétique',
    createdAt,
    scale,
    width,
    height,
    crop: { x: 0, y: 0, w: width, h: sliceH },
    slices,
    scroller: 'window',
    truncated: false,
  });
}
