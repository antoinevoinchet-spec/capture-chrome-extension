// Test de bout en bout : charge l'extension dans le Chromium de Playwright (écran ×2 comme un Retina),
// capture des pages piégeuses et vérifie les images produites pixel par pixel.
// Usage : node e2e.mjs <dossier de sortie>

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const HERE = import.meta.dirname;
const EXTENSION = path.resolve(HERE, '../extension');
const WORK = path.resolve(process.argv[2] ?? path.join(HERE, 'out'));

const MAGENTA = [255, 0, 170];
const CYAN = [0, 204, 255];
const GRAY = [204, 204, 204];
const GREEN = [34, 170, 68];

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'OK  ' : 'ÉCHEC'} ${name}${detail ? `  [${detail}]` : ''}`);
}

// Copie de test : ajoute <all_urls> pour lancer la capture sans cliquer sur l'icône,
// et la lecture du presse-papiers pour vérifier « Copier ».
async function testCopy() {
  const dir = path.join(WORK, 'extension');
  await fs.cp(EXTENSION, dir, { recursive: true });
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  manifest.permissions.push('clipboardRead');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

function serve(root) {
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

async function openTab(context, sw, url) {
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

async function capture(context, sw, tabId, mode) {
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

// Analyse dans la page des captures : couleurs le long de colonnes de pixels, parties et coupes.
async function analyze(viewer, { splitPoints, columns, colors, exportDir }) {
  const data = await viewer.evaluate(
    async ({ splitPoints, columns, colors }) => {
      const { getCapture } = await import(chrome.runtime.getURL('lib/db.js'));
      const { Stitcher } = await import(chrome.runtime.getURL('viewer/stitcher.js'));
      const rec = await getCapture(new URLSearchParams(location.search).get('id'));
      const st = new Stitcher(rec);

      const runs = {};
      for (const col of Object.keys(columns)) for (const c of Object.keys(colors)) runs[`${col}:${c}`] = [];
      const open = {};
      const BAND = 4000;
      for (let top = 0; top < rec.height; top += BAND) {
        const h = Math.min(BAND, rec.height - top);
        const canvas = new OffscreenCanvas(rec.width, h);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        await st.enqueue(() => st.draw(ctx, top, h));
        for (const [col, x] of Object.entries(columns)) {
          const px = ctx.getImageData(Math.round(x * rec.scale), 0, 1, h).data;
          for (let i = 0; i < h; i++) {
            for (const [c, rgb] of Object.entries(colors)) {
              const key = `${col}:${c}`;
              const hit =
                Math.abs(px[i * 4] - rgb[0]) < 14 && Math.abs(px[i * 4 + 1] - rgb[1]) < 14 && Math.abs(px[i * 4 + 2] - rgb[2]) < 14;
              if (hit && open[key] === undefined) open[key] = top + i;
              if (!hit && open[key] !== undefined) {
                runs[key].push([open[key], top + i]);
                delete open[key];
              }
            }
          }
        }
      }
      for (const [key, start] of Object.entries(open)) runs[key].push([start, rec.height]);

      const parts = await st.planParts(splitPoints * rec.scale);
      // Netteté d'une coupe : nombre de transitions de couleur sur les deux lignes qui la bordent.
      const cutScores = [];
      for (const part of parts.slice(1)) {
        const canvas = new OffscreenCanvas(rec.width, 2);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        await st.enqueue(() => st.draw(ctx, part.top - 1, 2));
        const px = ctx.getImageData(0, 0, rec.width, 2).data;
        let edges = 0;
        for (let row = 0; row < 2; row++) {
          for (let x = 1; x < rec.width; x++) {
            const i = (row * rec.width + x) * 4;
            const d = Math.abs(px[i] - px[i - 4]) + Math.abs(px[i + 1] - px[i - 3]) + Math.abs(px[i + 2] - px[i - 2]);
            if (d > 30) edges++;
          }
        }
        cutScores.push(edges);
      }

      const images = [];
      for (const part of parts) {
        const blob = await st.renderPart(part, 'image/png');
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        images.push(btoa(bin));
      }
      st.dispose();
      const { slices, ...meta } = rec;
      return { meta: { ...meta, sliceCount: slices.length }, runs, parts, cutScores, images };
    },
    { splitPoints, columns, colors },
  );
  await fs.mkdir(exportDir, { recursive: true });
  for (const [i, b64] of data.images.entries()) {
    await fs.writeFile(path.join(exportDir, `image-${String(i + 1).padStart(2, '0')}.png`), Buffer.from(b64, 'base64'));
  }
  delete data.images;
  return data;
}

async function testLongPage(context, sw, url) {
  console.log('\n— Page longue (défilement de la fenêtre, ×2)');
  const { page, tabId } = await openTab(context, sw, url);
  await page.evaluate(() => window.scrollTo(0, 1234));
  const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const lazyCount = await page.evaluate(() => document.querySelectorAll('.lazy').length);
  const { viewer, seconds, error } = await capture(context, sw, tabId, 'full');
  check('capture terminée', !error, error ?? `${seconds} s`);
  if (error) return;

  const a = await analyze(viewer, {
    splitPoints: 4000,
    columns: { edge: 10, center: 640 },
    colors: { magenta: MAGENTA, cyan: CYAN, gray: GRAY, green: GREEN },
    exportDir: path.join(WORK, 'long'),
  });
  const { meta, runs, parts, cutScores } = a;
  check('pleine résolution (×2, aucune réduction)', meta.scale === 2, `échelle ${meta.scale}`);
  check('largeur = 1280 points × 2', meta.width === 2560, `${meta.width} px`);
  check('hauteur = page entière × 2', Math.abs(meta.height - pageHeight * 2) <= 2, `${meta.height} px pour ${pageHeight} points`);
  check('en-tête collant présent une seule fois', runs['edge:magenta'].length === 1 && runs['edge:magenta'][0][0] === 0, JSON.stringify(runs['edge:magenta']));
  check('bandeau fixé en bas masqué (ne cache pas le texte)', runs['edge:cyan'].length === 0, JSON.stringify(runs['edge:cyan']));
  // Seules les grandes zones grises comptent : le lissage du texte produit aussi des pixels gris isolés.
  const placeholders = runs['center:gray'].filter(([start, end]) => end - start > 50);
  check('images différées toutes chargées', placeholders.length === 0 && runs['center:green'].length === lazyCount, `${runs['center:green'].length} vertes / ${lazyCount}, ${placeholders.length} blocs gris`);
  const heights = parts.map((p) => p.height);
  check('découpe en plusieurs images ≤ 8 000 px', parts.length > 1 && heights.every((h) => h <= 8000), heights.join(', '));
  check('les images se suivent sans trou ni doublon', parts.every((p, i) => i === 0 || p.top === parts[i - 1].top + parts[i - 1].height) && parts.at(-1).top + parts.at(-1).height === meta.height);
  check('coupes dans des interlignes vides', cutScores.every((s) => s <= 4), cutScores.join(', '));

  const after = await page.evaluate(() => ({
    y: window.scrollY,
    header: getComputedStyle(document.querySelector('header')).opacity,
    leftover: [...document.querySelectorAll('style')].some((s) => s.textContent.includes('scrollbar-width: none')),
  }));
  check('page remise en état après la capture', after.y === 1234 && after.header === '1' && !after.leftover, JSON.stringify(after));

  await viewer.screenshot({ path: path.join(WORK, 'viewer-long.png') });

  // Interface : changer le découpage recalcule les images sans nouvelle capture.
  await viewer.getByRole('button', { name: 'Long', exact: true }).click();
  await viewer.waitForSelector('body[data-ready="true"]');
  const longCount = await viewer.locator('figure.part').count();
  await viewer.getByRole('button', { name: '1 écran', exact: true }).click();
  await viewer.waitForSelector('body[data-ready="true"]');
  const screenCount = await viewer.locator('figure.part').count();
  check('changer le découpage recalcule les images', longCount < parts.length && screenCount > parts.length, `long ${longCount}, moyen ${parts.length}, 1 écran ${screenCount}`);

  await viewer.getByRole('button', { name: 'Moyen', exact: true }).click();
  await viewer.waitForSelector('body[data-ready="true"]');

  await viewer.bringToFront();
  const header = viewer.locator('#copy-current');
  const label1 = (await header.innerText()).trim();
  const first = await copyAndRead(viewer, header);
  check(
    'bouton « Copier l’image » de l’en-tête : image 1 copiée et annoncée',
    /image 1$/.test(label1) && first.size === `2560 × ${parts[0].height}` && /copiée dans le presse-papiers/.test(first.message),
    `${label1} → « ${first.message} » / ${first.size}`,
  );
  await viewer.screenshot({ path: path.join(WORK, 'viewer-copy.png') });

  await viewer.evaluate(() => document.querySelectorAll('figure.part')[2].scrollIntoView({ block: 'start' }));
  await viewer
    .waitForFunction(() => /image 3$/.test(document.getElementById('copy-current').textContent.trim()), null, { timeout: 5000 })
    .catch(() => {});
  const label3 = (await header.innerText()).trim();
  const third = await copyAndRead(viewer, header);
  check('le bouton suit le défilement : image 3 copiée', /image 3$/.test(label3) && third.size === `2560 × ${parts[2].height}`, `${label3} → ${third.size}`);

  const second = await copyAndRead(viewer, viewer.locator('figure.part').nth(1).getByRole('button', { name: 'Copier' }));
  check('bouton « Copier » posé sur une image (image 2)', second.size === `2560 × ${parts[1].height}`, `« ${second.message} » / ${second.size}`);

  await viewer.locator('figure.part').nth(3).locator('canvas').click({ button: 'right' });
  await viewer.screenshot({ path: path.join(WORK, 'viewer-menu.png') });
  const viaMenu = await copyAndRead(viewer, viewer.getByRole('menuitem', { name: 'Copier l’image en pleine résolution' }));
  check(
    'clic droit sur l’image 4 : copie en pleine résolution annoncée',
    viaMenu.size === `2560 × ${parts[3].height}` && /Image 4 copiée dans le presse-papiers/.test(viaMenu.message),
    `« ${viaMenu.message} » / ${viaMenu.size}`,
  );

  await viewer.evaluate(() => document.querySelectorAll('figure.part')[4].scrollIntoView({ block: 'start' }));
  await viewer
    .waitForFunction(() => /image 5$/.test(document.getElementById('copy-current').textContent.trim()), null, { timeout: 5000 })
    .catch(() => {});
  const viaKeys = await copyAndRead(viewer, { click: () => viewer.keyboard.press('Meta+c') });
  check(
    '⌘C copie l’image affichée (image 5) et l’annonce',
    viaKeys.size === `2560 × ${parts[4].height}` && /Image 5 copiée dans le presse-papiers/.test(viaKeys.message),
    `« ${viaKeys.message} » / ${viaKeys.size}`,
  );

  await viewer.getByRole('button', { name: 'JPG', exact: true }).click();
  await viewer.locator('#download-all').click();
  await viewer.waitForFunction(() => /enregistr|impossible/.test(document.getElementById('toast').textContent), null, {
    timeout: 120_000,
  });
  const toastText = await viewer.locator('#toast').innerText();
  const downloads = await sw.evaluate(async () =>
    (await chrome.downloads.search({ orderBy: ['-startTime'] })).map((d) => ({ name: d.filename, state: d.state, mime: d.mime })),
  );
  check('« Tout télécharger » lance un téléchargement par image', downloads.length === parts.length, `${downloads.length} téléchargements, message : ${toastText.split('\n')[0]}`);
  await page.close();
  await viewer.close();
}

// Clique sur un bouton de copie, attend la notification, puis relit l'image du presse-papiers.
async function copyAndRead(viewer, trigger) {
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

async function testTabSwitch(context, sw, url, otherUrl) {
  console.log('\n— Changement d’onglet pendant la capture (cas d’erreur)');
  const other = await context.newPage();
  await other.goto(otherUrl);
  const { page, tabId } = await openTab(context, sw, url);
  const running = capture(context, sw, tabId, 'full');
  await page.waitForTimeout(6000);
  await other.bringToFront();
  const { id, error } = await running;
  check('capture arrêtée avec un message clair', !id && /onglet a changé/.test(error ?? ''), error);
  const after = await page.evaluate(() => ({
    leftover: [...document.querySelectorAll('style')].some((s) => s.textContent.includes('scrollbar-width: none')),
    header: getComputedStyle(document.querySelector('header')).opacity,
  }));
  check('page remise en état malgré l’arrêt', !after.leftover && after.header === '1', JSON.stringify(after));
  await other.close();
  await page.close();
}

async function testAppPage(context, sw, url) {
  console.log('\n— Application (seul un bloc défile, comme une messagerie web)');
  const { page, tabId } = await openTab(context, sw, url);
  const geom = await page.evaluate(() => {
    const s = document.getElementById('scroller');
    return { width: s.clientWidth, height: s.scrollHeight };
  });
  const { viewer, seconds, error } = await capture(context, sw, tabId, 'full');
  check('capture terminée', !error, error ?? `${seconds} s`);
  if (error) return;
  const { meta, runs, parts } = await analyze(viewer, {
    splitPoints: 4000,
    columns: { edge: 250 },
    colors: { magenta: MAGENTA },
    exportDir: path.join(WORK, 'app'),
  });
  check('bloc défilant détecté', meta.scroller === 'element', meta.scroller);
  check('largeur = celle du bloc × 2', meta.width === geom.width * 2, `${meta.width} px pour ${geom.width} points`);
  check('hauteur = tout le contenu du bloc × 2', Math.abs(meta.height - geom.height * 2) <= 2, `${meta.height} px pour ${geom.height} points`);
  check('titre collant du bloc présent une seule fois', runs['edge:magenta'].length === 1, JSON.stringify(runs['edge:magenta']));
  check('découpe en plusieurs images', parts.length > 1, `${parts.length} images`);
  await viewer.screenshot({ path: path.join(WORK, 'viewer-app.png') });
  await page.close();
  await viewer.close();
}

async function testJsHeader(context, sw, url) {
  console.log('\n— En-tête rendu fixe par le site pendant le défilement');
  const { page, tabId } = await openTab(context, sw, url);
  const { viewer, seconds, error } = await capture(context, sw, tabId, 'full');
  check('capture terminée', !error, error ?? `${seconds} s`);
  if (error) return;
  const { runs } = await analyze(viewer, {
    splitPoints: 4000,
    columns: { edge: 10 },
    colors: { magenta: MAGENTA },
    exportDir: path.join(WORK, 'js-header'),
  });
  check('en-tête présent une seule fois, en haut', runs['edge:magenta'].length === 1 && runs['edge:magenta'][0][0] === 0, JSON.stringify(runs['edge:magenta']));
  await page.close();
  await viewer.close();
}

async function testBodyScroll(context, sw, url) {
  console.log('\n— Page dont le <body> est le bloc qui défile');
  const { page, tabId } = await openTab(context, sw, url);
  const geom = await page.evaluate(() => ({ width: document.body.clientWidth, height: document.body.scrollHeight }));
  const { viewer, seconds, error } = await capture(context, sw, tabId, 'full');
  check('capture terminée', !error, error ?? `${seconds} s`);
  if (error) return;
  const { meta, parts } = await analyze(viewer, {
    splitPoints: 4000,
    columns: {},
    colors: {},
    exportDir: path.join(WORK, 'body-scroll'),
  });
  check('tout le contenu est capturé', meta.scroller === 'element' && Math.abs(meta.height - geom.height * 2) <= 2, `${meta.scroller}, ${meta.height} px pour ${geom.height} points`);
  check('découpe en plusieurs images', parts.length > 1, `${parts.length} images`);
  await page.close();
  await viewer.close();
}

// La vraie extension (activeTab seul) sans clic sur l'icône : Chrome refuse l'accès à la page.
async function testRealManifest(base) {
  console.log('\n— Vraie extension, capture lancée sans clic sur l’icône (cas d’erreur)');
  const dir = path.join(WORK, 'extension-real');
  await fs.cp(EXTENSION, dir, { recursive: true });
  const context = await launch(dir, 'profile-real');
  try {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const { page, tabId } = await openTab(context, sw, `${base}/long.html`);
    const { id, error } = await capture(context, sw, tabId, 'full');
    check('autorisation manquante expliquée en clair', !id && /Autorisation manquante/.test(error ?? ''), error);
    await page.close();

    // Le Chromium de test active d'office l'accès aux fichiers : on simule le réglage désactivé.
    await sw.evaluate(() => {
      Object.defineProperty(chrome.extension, 'isAllowedFileSchemeAccess', { value: async () => false, configurable: true });
    });
    const file = await openTab(context, sw, `file://${path.join(HERE, 'pages', 'long.html')}`);
    const local = await capture(context, sw, file.tabId, 'full');
    check(
      'fichier local, accès aux fichiers désactivé (simulé) : le message indique le réglage',
      !local.id && /URL de fichier/.test(local.error ?? ''),
      local.error,
    );
    await file.page.close();
  } finally {
    await context.close();
  }
}

function launch(extension, profile) {
  return chromium.launchPersistentContext(path.join(WORK, profile), {
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

async function testVisible(context, sw, url) {
  console.log('\n— Partie visible');
  const { page, tabId } = await openTab(context, sw, url);
  const screen = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const { viewer, error } = await capture(context, sw, tabId, 'visible');
  check('capture terminée', !error, error);
  if (error) return;
  const { meta, parts } = await analyze(viewer, {
    splitPoints: 4000,
    columns: {},
    colors: {},
    exportDir: path.join(WORK, 'visible'),
  });
  check(
    'une image de la taille de la zone de page × 2',
    parts.length === 1 && meta.width === screen.w * 2 && meta.height === screen.h * 2,
    `${parts.length} image, ${meta.width} × ${meta.height} pour ${screen.w} × ${screen.h} points`,
  );
  await page.close();
  await viewer.close();
}

async function testForbiddenPage(context, sw) {
  console.log('\n— Page interdite, capture lancée au clavier (cas d’erreur)');
  await watchErrors(sw);
  const { page, tabId } = await openTab(context, sw, 'chrome://version');
  const { id, error } = await capture(context, sw, tabId, 'full');
  check('refus expliqué en clair', !id && /interdit/.test(error ?? ''), error);
  const logged = await readErrors(sw);
  check('refus non inscrit comme « erreur » dans Chrome', logged.length === 0, logged.join(' | '));

  // Le message attend la fenêtre de l'icône (ouverte d'office si Chrome le permet).
  const state = await sw.evaluate(async () => ({
    stored: (await chrome.storage.session.get('lastError')).lastError?.message ?? null,
    popups: (await chrome.runtime.getContexts({ contextTypes: ['POPUP'] })).length,
  }));
  let shown = '';
  if (state.stored) {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${new URL(sw.url()).host}/popup/popup.html`);
    await popup.waitForTimeout(300);
    shown = await popup.locator('#error').innerText();
    await popup.close();
  }
  check(
    'la fenêtre de l’icône affiche le refus',
    /interdit/.test(shown) || state.popups > 0,
    state.popups > 0 ? 'fenêtre ouverte d’office' : `affiché : « ${shown} »`,
  );
  await page.close();
}

// Relève ce que Chrome afficherait dans « Erreurs » : console.error et rejets non interceptés.
async function watchErrors(sw) {
  await sw.evaluate(() => {
    self.__errors = [];
    if (self.__watching) return;
    self.__watching = true;
    const original = console.error.bind(console);
    console.error = (...args) => {
      self.__errors.push(args.map(String).join(' '));
      original(...args);
    };
    self.addEventListener('unhandledrejection', (event) => self.__errors.push(`rejet non intercepté : ${event.reason}`));
  });
}

async function readErrors(sw) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  return sw.evaluate(() => self.__errors);
}

async function testOwnPage(context, sw) {
  console.log('\n— ⌥⇧P sur la page des résultats elle-même (cas d’erreur)');
  const { page, tabId } = await openTab(context, sw, `chrome-extension://${new URL(sw.url()).host}/viewer/viewer.html`);
  const { id, error } = await capture(context, sw, tabId, 'full');
  check('message juste : lancer la capture depuis la page à capturer', !id && /page de résultats/.test(error ?? ''), error);
  await page.close();
}

async function testClosedTab(context, sw, url) {
  console.log('\n— Onglet fermé pendant la capture');
  // Ferme les fenêtres d'icône restées ouvertes par les cas d'erreur précédents.
  for (const p of context.pages()) if (p.url().includes('/popup/popup.html')) await p.close();
  await watchErrors(sw);
  const { page, tabId } = await openTab(context, sw, url);
  const running = capture(context, sw, tabId, 'full');
  await page.waitForTimeout(6000);
  await page.close();
  const { id } = await running;
  const logged = await readErrors(sw);
  const popups = await sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['POPUP'] })).length);
  check('capture abandonnée sans erreur inscrite ni fenêtre ouverte', !id && logged.length === 0 && popups === 0, logged.join(' | ') || `${popups} fenêtre`);
}

async function testPopup(context, sw) {
  const extensionId = new URL(sw.url()).host;
  const page = await context.newPage();
  await page.setViewportSize({ width: 300, height: 260 });
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(WORK, 'popup.png') });
  const normal = await page.evaluate(() => ({
    full: document.querySelector('[data-shortcut="capture-full"]').textContent,
    hint: !document.getElementById('shortcut-hint').hidden,
  }));
  check('raccourci « Page entière » attribué et affiché, sans avertissement', /F/.test(normal.full) && !normal.hint, JSON.stringify(normal));
  await page.close();

  // Comme quand une autre extension occupe déjà la touche : Chrome laisse la commande sans raccourci.
  const taken = await context.newPage();
  await taken.setViewportSize({ width: 300, height: 320 });
  await taken.addInitScript(() => {
    const getAll = chrome.commands.getAll.bind(chrome.commands);
    chrome.commands.getAll = async () =>
      (await getAll()).map((c) => (c.name === 'capture-full' ? { ...c, shortcut: '' } : c));
  });
  await taken.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await taken.waitForTimeout(300);
  await taken.screenshot({ path: path.join(WORK, 'popup-no-shortcut.png') });
  const hint = await taken.evaluate(() => {
    const el = document.getElementById('shortcut-hint');
    return el.hidden ? '' : el.textContent.replace(/\s+/g, ' ').trim();
  });
  check('raccourci pris ailleurs : la fenêtre le signale avec un lien pour en choisir un', /Page entière/.test(hint) && /Choisir un raccourci/.test(hint), hint);
  await taken.close();
}

async function main() {
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(WORK, { recursive: true });
  const extension = await testCopy();
  const server = await serve(path.join(HERE, 'pages'));
  const base = `http://127.0.0.1:${server.address().port}`;
  const context = await launch(extension, 'profile');
  try {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await testLongPage(context, sw, `${base}/long.html`);
    await testAppPage(context, sw, `${base}/app.html`);
    await testJsHeader(context, sw, `${base}/js-header.html`);
    await testBodyScroll(context, sw, `${base}/body-scroll.html`);
    await testVisible(context, sw, `${base}/long.html`);
    await testTabSwitch(context, sw, `${base}/long.html`, `${base}/app.html`);
    await testForbiddenPage(context, sw);
    await testOwnPage(context, sw);
    await testClosedTab(context, sw, `${base}/long.html`);
    await testPopup(context, sw);
  } finally {
    await context.close();
  }
  try {
    await testRealManifest(base);
  } finally {
    server.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} vérifications réussies`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
