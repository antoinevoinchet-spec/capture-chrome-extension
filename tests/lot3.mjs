// Tests du lot 3 : capturer un bloc ou une zone. Le calque de sélection, le rectangle choisi, les cas limites.
// Même Chromium et même extension que les autres suites (écran ×2).
// Usage : node lot3.mjs <dossier de sortie> [calque|region|barres|limites|relecture] [motif]

import fs from 'node:fs/promises';
import path from 'node:path';
import { EXTENSION, MANIFEST_EXPECTED, check, launch, openTab, prepareExtension, results, serve } from './lib.mjs';

const HERE = import.meta.dirname;
const WORK = path.resolve(process.argv[2] ?? path.join(HERE, 'out-lot3'));
const ONLY = process.argv[3];
const NAMED = process.argv[4] ? new RegExp(process.argv[4], 'i') : null;

async function test(name, body) {
  if (NAMED && !NAMED.test(name)) return;
  try {
    const { ok, detail } = await body();
    check(name, ok, detail);
  } catch (err) {
    check(name, false, String(err.message ?? err).split('\n')[0].slice(0, 240));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Le calque vit dans un shadow DOM fermé, dans le monde isolé de l'extension : on le lit depuis ce monde-là.
async function pickerState(sw, tabId) {
  return sw.evaluate(async (tabId) => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const picker = window.__capturePicker;
        if (!picker) return null;
        const frame = picker.root.querySelector('.frame');
        const help = picker.root.querySelector('.help');
        const box = frame.getBoundingClientRect();
        return {
          mode: picker.mode,
          help: help.textContent,
          helpColor: getComputedStyle(help).color,
          helpBackground: getComputedStyle(help).backgroundColor,
          frameVisible: !frame.hidden,
          frame: { x: box.x, y: box.y, w: box.width, h: box.height },
          current: picker.current?.id || picker.current?.tagName || null,
        };
      },
    });
    return result;
  }, tabId);
}

const hostCount = (page) => page.evaluate(() => document.querySelectorAll('capture-picker').length);
const rectOf = (page, selector) =>
  page.evaluate((selector) => {
    const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
    return { x, y, w: width, h: height };
  }, selector);
const startPick = (sw, tabId, mode) => sw.evaluate(({ tabId, mode }) => self.startPick(tabId, mode), { tabId, mode });
const near = (a, b, tolerance = 1) => ['x', 'y', 'w', 'h'].every((key) => Math.abs(a[key] - b[key]) <= tolerance);

// Une page en cours de sélection, fermée à la fin quoi qu'il arrive.
async function withPick(context, sw, url, mode, body) {
  const { page, tabId } = await openTab(context, sw, url);
  try {
    await startPick(sw, tabId, mode);
    return await body({ page, tabId });
  } finally {
    await page.close();
  }
}

// Attend la page de résultats et lit sa capture.
function nextViewer(context) {
  return context.waitForEvent('page', { predicate: (p) => p.url().includes('/viewer/viewer.html'), timeout: 180_000 });
}
async function viewerRecord(viewer) {
  await viewer.waitForSelector('body[data-ready="true"]', { timeout: 180_000 });
  return viewer.evaluate(async () => {
    const { getCapture } = await import(chrome.runtime.getURL('lib/db.js'));
    const { slices, ...meta } = await getCapture(new URLSearchParams(location.search).get('id'));
    return { ...meta, sliceCount: slices.length };
  });
}

// --- Le calque de sélection ---

async function groupCalque(context, sw, base) {
  console.log('\n— Le calque de sélection');
  const tall = `${base}/tall-block.html`;

  await test('version : le manifeste vaut MANIFEST_EXPECTED (0.4.0 ou plus), avec le raccourci Alt+Shift+Z', async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(EXTENSION, 'manifest.json'), 'utf8'));
    const key = manifest.commands?.['capture-pick']?.suggested_key?.default;
    return { ok: manifest.version === MANIFEST_EXPECTED.version && manifest.version >= '0.4.0' && key === 'Alt+Shift+Z', detail: `${manifest.version}, ${key}` };
  });

  await test('calque : mode d’emploi affiché', () =>
    withPick(context, sw, tall, 'block', async ({ tabId }) => {
      const state = await pickerState(sw, tabId);
      return { ok: /Échap/.test(state?.help ?? '') && /↑/.test(state?.help ?? '') && /Z/.test(state?.help ?? ''), detail: state?.help };
    }));

  await test('calque : mode clair et sombre', async () => {
    const { page, tabId } = await openTab(context, sw, tall);
    try {
      await page.emulateMedia({ colorScheme: 'light' });
      await startPick(sw, tabId, 'block');
      await page.screenshot({ path: path.join(WORK, 'calque-clair.png') });
      const light = await pickerState(sw, tabId);
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForTimeout(100);
      await page.screenshot({ path: path.join(WORK, 'calque-sombre.png') });
      const dark = await pickerState(sw, tabId);
      return { ok: light.helpBackground !== dark.helpBackground && light.helpColor !== dark.helpColor, detail: `${light.helpBackground} / ${dark.helpBackground}` };
    } finally {
      await page.emulateMedia({ colorScheme: null });
      await page.close();
    }
  });

  await test('calque : les entrées Un bloc et Une zone de la fenêtre l’ouvrent, puis la fenêtre se ferme', async () => {
    const { page, tabId } = await openTab(context, sw, tall);
    try {
      const modes = {};
      for (const [button, mode] of [['#pick-block', 'block'], ['#pick-zone', 'zone']]) {
        const popup = await context.newPage();
        await popup.addInitScript((tabId) => {
          chrome.tabs.query = async () => [{ id: tabId }];
        }, tabId);
        await popup.goto(`chrome-extension://${new URL(sw.url()).host}/popup/popup.html`);
        const closed = popup.waitForEvent('close', { timeout: 5000 }).catch(() => null);
        await popup.click(button, { timeout: 5000 });
        await closed;
        modes[mode] = (await pickerState(sw, tabId))?.mode;
      }
      return { ok: modes.block === 'block' && modes.zone === 'zone', detail: JSON.stringify(modes) };
    } finally {
      await page.close();
    }
  });

  await test('calque : la commande capture-pick ouvre le mode bloc', async () => {
    const { page, tabId } = await openTab(context, sw, tall);
    try {
      await sw.evaluate(async (tabId) => self.onCommandForTest('capture-pick', await chrome.tabs.get(tabId)), tabId);
      const state = await pickerState(sw, tabId);
      return { ok: state?.mode === 'block', detail: state?.mode };
    } finally {
      await page.close();
    }
  });

  await test('calque : la fenêtre affiche le raccourci, jamais « undefined », même si la touche est prise', async () => {
    const url = `chrome-extension://${new URL(sw.url()).host}/popup/popup.html`;
    const normal = await context.newPage();
    await normal.goto(url);
    await normal.waitForTimeout(200);
    const shown = await normal.evaluate(() => document.querySelector('[data-shortcut="capture-pick"]')?.textContent ?? '');
    await normal.close();
    const taken = await context.newPage();
    await taken.addInitScript(() => {
      const getAll = chrome.commands.getAll.bind(chrome.commands);
      chrome.commands.getAll = async () => (await getAll()).map((c) => (c.name === 'capture-pick' ? { ...c, shortcut: '' } : c));
    });
    await taken.goto(url);
    await taken.waitForTimeout(200);
    const hint = await taken.evaluate(() => document.getElementById('shortcut-hint').textContent.replace(/\s+/g, ' ').trim());
    await taken.close();
    return { ok: /Z/.test(shown) && /Un bloc/.test(hint) && !/undefined/.test(hint), detail: `${shown} ; ${hint}` };
  });

  await test('calque : le bloc survolé est entouré', () =>
    withPick(context, sw, tall, 'block', async ({ page, tabId }) => {
      const inner = await rectOf(page, '#inner');
      await page.mouse.move(inner.x + inner.w - 50, 500);
      await page.waitForTimeout(100);
      const state = await pickerState(sw, tabId);
      return { ok: state.current === 'inner' && state.frameVisible && near(state.frame, inner, 3), detail: JSON.stringify({ ...state, help: undefined }) };
    }));

  await test('calque : ↑ et ↓ changent de bloc', () =>
    withPick(context, sw, tall, 'block', async ({ page, tabId }) => {
      const leaf = await rectOf(page, '#leaf');
      await page.mouse.move(leaf.x + 20, leaf.y + 20);
      await page.waitForTimeout(100);
      const seen = [(await pickerState(sw, tabId)).current];
      await page.keyboard.press('ArrowUp');
      seen.push((await pickerState(sw, tabId)).current);
      await page.keyboard.press('ArrowUp');
      seen.push((await pickerState(sw, tabId)).current);
      // Un petit mouvement sur le même élément ne reperd pas le choix fait au clavier.
      await page.mouse.move(leaf.x + 22, leaf.y + 21);
      await page.waitForTimeout(100);
      seen.push((await pickerState(sw, tabId)).current);
      await page.keyboard.press('ArrowDown');
      seen.push((await pickerState(sw, tabId)).current);
      await page.keyboard.press('ArrowDown');
      seen.push((await pickerState(sw, tabId)).current);
      await page.keyboard.press('ArrowDown');
      seen.push((await pickerState(sw, tabId)).current);
      return { ok: seen.join() === 'leaf,inner,outer,outer,inner,leaf,leaf', detail: seen.join() };
    }));

  await test('calque : ↑ s’arrête au corps de la page', () =>
    withPick(context, sw, tall, 'block', async ({ page, tabId }) => {
      const leaf = await rectOf(page, '#leaf');
      await page.mouse.move(leaf.x + 20, leaf.y + 20);
      for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp');
      const state = await pickerState(sw, tabId);
      return { ok: state.current === 'BODY', detail: state.current };
    }));

  for (const [label, act] of [
    ['clic', (page, x, y) => page.mouse.click(x, y)],
    ['Entrée', (page) => page.keyboard.press('Enter')],
  ]) {
    await test(`calque : ${label} valide, le calque disparaît et la capture part`, async () => {
      const { page, tabId } = await openTab(context, sw, tall);
      try {
        await startPick(sw, tabId, 'block');
        const inner = await rectOf(page, '#inner');
        await page.mouse.move(inner.x + 50, 500);
        await page.waitForTimeout(100);
        const opened = nextViewer(context);
        await act(page, inner.x + 50, 500);
        const viewer = await opened;
        const record = await viewerRecord(viewer);
        const gone = (await hostCount(page)) === 0 && !(await pickerState(sw, tabId));
        await viewer.close();
        return { ok: gone && record.origin === 'bloc', detail: `calque retiré : ${gone}, origine ${record.origin}` };
      } finally {
        await page.close();
      }
    });
  }

  await test('calque : un clic ne déclenche rien dans la page', () =>
    withPick(context, sw, `${base}/iframe.html`, 'zone', async ({ page }) => {
      await page.evaluate(() => {
        window.__clicks = 0;
        document.addEventListener('click', () => window.__clicks++);
        document.addEventListener('mousedown', () => window.__clicks++);
      });
      await page.mouse.click(30, 30);
      await page.waitForTimeout(100);
      return { ok: (await page.evaluate(() => window.__clicks)) === 0 && (await hostCount(page)) === 1, detail: 'clic sans tracé' };
    }));

  await test('calque : Échap annule et le calque disparaît', () =>
    withPick(context, sw, tall, 'block', async ({ page, tabId }) => {
      await page.mouse.move(300, 500);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      const stored = await sw.evaluate(async () => (await chrome.storage.session.get('picking')).picking ?? null);
      const left = (await hostCount(page)) + (await pickerState(sw, tabId) ? 1 : 0);
      const viewers = context.pages().filter((p) => p.url().includes('/viewer/viewer.html')).length;
      return { ok: left === 0 && !stored && viewers === 0, detail: `calques ${left}, état ${JSON.stringify(stored)}, résultats ${viewers}` };
    }));

  await test('calque : Z passe en zone, et revient en bloc', () =>
    withPick(context, sw, tall, 'block', async ({ page, tabId }) => {
      const seen = [(await pickerState(sw, tabId)).mode];
      await page.keyboard.press('z');
      const zone = await pickerState(sw, tabId);
      seen.push(zone.mode);
      await page.keyboard.press('z');
      seen.push((await pickerState(sw, tabId)).mode);
      return { ok: seen.join() === 'block,zone,block' && /rectangle/i.test(zone.help), detail: `${seen.join()} ; ${zone.help}` };
    }));

  await test('calque : la zone tracée donne le rectangle, à la souris', async () => {
    const { page, tabId } = await openTab(context, sw, tall);
    try {
      await startPick(sw, tabId, 'zone');
      await page.mouse.move(200, 150);
      await page.mouse.down();
      await page.mouse.move(600, 450, { steps: 4 });
      const during = await pickerState(sw, tabId);
      const opened = nextViewer(context);
      await page.mouse.up();
      const viewer = await opened;
      const record = await viewerRecord(viewer);
      await viewer.close();
      return { ok: near(during.frame, { x: 200, y: 150, w: 400, h: 300 }, 3) && record.origin === 'zone', detail: `${JSON.stringify(during.frame)}, origine ${record.origin}` };
    } finally {
      await page.close();
    }
  });

  await test('calque : un tracé minuscule ne capture rien, le calque reste', () =>
    withPick(context, sw, tall, 'zone', async ({ page, tabId }) => {
      await page.mouse.move(200, 150);
      await page.mouse.down();
      await page.mouse.move(201, 151);
      await page.mouse.up();
      await page.waitForTimeout(200);
      return { ok: (await pickerState(sw, tabId))?.mode === 'zone', detail: 'tracé de 1 × 1' };
    }));

  await test('calque : relancer ne l’empile pas', () =>
    withPick(context, sw, tall, 'block', async ({ page, tabId }) => {
      await startPick(sw, tabId, 'block');
      await startPick(sw, tabId, 'zone');
      const state = await pickerState(sw, tabId);
      const hosts = await hostCount(page);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      return { ok: hosts === 1 && state.mode === 'zone' && (await hostCount(page)) === 0, detail: `${hosts} calque, mode ${state.mode}` };
    }));

  await test('calque : retiré si l’onglet change', async () => {
    const { page, tabId } = await openTab(context, sw, tall);
    const other = await context.newPage();
    try {
      await other.goto(`${base}/iframe.html`);
      await page.bringToFront();
      await startPick(sw, tabId, 'block');
      await other.bringToFront();
      await sleep(600);
      const hosts = await hostCount(page);
      return { ok: hosts === 0, detail: `${hosts} calque` };
    } finally {
      await other.close();
      await page.close();
    }
  });

  await test('calque : retiré à la sortie de la page, et absent après un rechargement', () =>
    withPick(context, sw, tall, 'block', async ({ page, tabId }) => {
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
      const left = await hostCount(page);
      await startPick(sw, tabId, 'block');
      await page.reload();
      await sleep(200);
      return { ok: left === 0 && (await hostCount(page)) === 0, detail: `${left} calque à la sortie` };
    }));

  await test('calque : le clavier répond même si une iframe avait le focus', () =>
    withPick(context, sw, `${base}/iframe.html`, 'block', async ({ page, tabId }) => {
      await page.keyboard.press('Escape');
      await sleep(200);
      await page.frameLocator('#frame').locator('#inside').focus();
      await startPick(sw, tabId, 'block');
      const hosts = await hostCount(page);
      await page.keyboard.press('Escape');
      await sleep(300);
      return { ok: hosts === 1 && (await hostCount(page)) === 0, detail: `${hosts} puis ${await hostCount(page)} calque` };
    }));

  await test('calque : la molette fait défiler la zone sous la souris', async () => {
    const { page, tabId } = await openTab(context, sw, `${base}/app.html`);
    try {
      await startPick(sw, tabId, 'block');
      await page.mouse.move(700, 400);
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(200);
      const top = await page.evaluate(() => document.getElementById('scroller').scrollTop);
      return { ok: top > 100, detail: `défilé de ${top}` };
    } finally {
      await page.close();
    }
  });

  await test('calque : s’affiche sur une page à politique stricte', () =>
    withPick(context, sw, `${base}/restore-csp.html`, 'block', async ({ page, tabId }) => {
      await page.mouse.move(600, 400);
      await page.waitForTimeout(100);
      const state = await pickerState(sw, tabId);
      const styled = state.helpBackground !== 'rgba(0, 0, 0, 0)';
      return { ok: styled && state.frameVisible && state.frame.w > 100, detail: `${state.helpBackground}, ${JSON.stringify(state.frame)}` };
    }));

  await test('calque : Shadow DOM ouvert', async () => {
    const { page, tabId } = await openTab(context, sw, `${base}/shadow.html`);
    try {
      await startPick(sw, tabId, 'block');
      await page.mouse.move(100, 200);
      await page.waitForTimeout(100);
      const seen = [(await pickerState(sw, tabId)).current];
      await page.keyboard.press('ArrowUp');
      const card = await pickerState(sw, tabId);
      seen.push(card.current);
      await page.keyboard.press('ArrowUp');
      seen.push((await pickerState(sw, tabId)).current);
      return { ok: seen.join() === 'leaf,card,host' && near(card.frame, { x: 0, y: 100, w: 700, h: 500 }, 3), detail: `${seen.join()} ${JSON.stringify(card.frame)}` };
    } finally {
      await page.close();
    }
  });

  await test('calque : iframe traitée comme un bloc', () =>
    withPick(context, sw, `${base}/iframe.html`, 'block', async ({ page, tabId }) => {
      const frame = await rectOf(page, '#frame');
      await page.mouse.move(frame.x + 50, frame.y + 50);
      await page.waitForTimeout(100);
      const state = await pickerState(sw, tabId);
      return { ok: state.current === 'frame' && near(state.frame, frame, 3), detail: `${state.current} ${JSON.stringify(state.frame)}` };
    }));

  await test('calque : raccourci de page entière pendant le calque, calque absent de l’image', async () => {
    const { page, tabId } = await openTab(context, sw, `${base}/iframe.html`);
    try {
      await startPick(sw, tabId, 'block');
      await page.mouse.move(200, 200);
      await page.waitForTimeout(100);
      const opened = nextViewer(context);
      await sw.evaluate(async (tabId) => self.onCommandForTest('capture-full', await chrome.tabs.get(tabId)), tabId);
      const viewer = await opened;
      await viewerRecord(viewer);
      // Le coin haut gauche de la page est couleur page : ni le cadre ni le voile du calque ne s'y voient.
      const colors = await viewer.evaluate(async () => {
        const { getCapture } = await import(chrome.runtime.getURL('lib/db.js'));
        const { Stitcher } = await import(chrome.runtime.getURL('viewer/stitcher.js'));
        const record = await getCapture(new URLSearchParams(location.search).get('id'));
        const stitcher = new Stitcher(record);
        const ctx = new OffscreenCanvas(record.width, 200).getContext('2d', { willReadFrequently: true });
        await stitcher.enqueue(() => stitcher.draw(ctx, 0, 200));
        const read = (x, y) => [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)];
        return { wrap: read(20, 20), page: read(record.width - 10, 20) };
      });
      const hosts = await hostCount(page);
      await viewer.close();
      return { ok: hosts === 0 && colors.wrap.join() === '241,239,234' && colors.page.join() === '255,255,255', detail: `${hosts} calque, ${JSON.stringify(colors)}` };
    } finally {
      await page.close();
    }
  });

  await test('calque : page interdite, message et aucun calque', async () => {
    const { page, tabId } = await openTab(context, sw, 'chrome://version');
    try {
      const outcome = await sw.evaluate(async (tabId) => {
        try {
          await self.startPick(tabId, 'block');
          return 'ouvert';
        } catch (err) {
          return (await self.explainForTest(err)).message;
        }
      }, tabId);
      return { ok: /interdit/.test(outcome), detail: outcome };
    } finally {
      await page.close();
    }
  });

  await test('calque : le clic est traité après l’endormissement du service worker', async () => {
    // L'onglet d'administration s'ouvre avant le choix : changer d'onglet pendant le choix retire le calque.
    const admin = await context.newPage();
    await admin.goto(`chrome-extension://${new URL(sw.url()).host}/popup/popup.html`);
    const cdp = await context.newCDPSession(admin);
    const { page, tabId } = await openTab(context, sw, tall);
    try {
      await startPick(sw, tabId, 'block');
      const inner = await rectOf(page, '#inner');
      await page.mouse.move(inner.x + 50, 500);
      await page.waitForTimeout(100);
      // Arrêt forcé, comme l'endormissement que Chrome impose au bout de 30 s sans activité. Chrome dit lui-même quand il est fait.
      const stopped = new Promise((resolve) => {
        cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
          if (versions.some((version) => version.runningStatus === 'stopped')) resolve(true);
        });
      });
      await cdp.send('ServiceWorker.enable');
      await cdp.send('ServiceWorker.stopAllWorkers');
      const asleep = await Promise.race([stopped, sleep(5000).then(() => false)]);
      await cdp.detach();
      const hosts = await hostCount(page);
      const opened = nextViewer(context);
      await page.mouse.click(inner.x + 50, 500);
      const viewer = await opened;
      const record = await viewerRecord(viewer);
      await viewer.close();
      return { ok: asleep && hosts === 1 && record.origin === 'bloc', detail: `worker arrêté : ${asleep}, ${hosts} calque, origine ${record.origin}` };
    } finally {
      await page.close();
      await admin.close();
    }
  });
}

// --- Le rectangle choisi ---

// Le calque montre ce choix comme après un survol : son cadre et son voile sont bien à l'écran quand on valide.
function chooseElement(sw, tabId, selector) {
  return sw.evaluate(
    async ({ tabId, selector }) => {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (selector) => {
          window.__capturePicker.current = document.querySelector(selector);
          window.__capturePicker.redraw();
        },
        args: [selector],
      });
    },
    { tabId, selector },
  );
}

// Choisit un élément précis, puis valide à la touche Entrée. Le parcours à la souris est vérifié dans le groupe `calque`.
async function captureBlock(context, sw, page, tabId, selector) {
  await startPick(sw, tabId, 'block');
  await chooseElement(sw, tabId, selector);
  const opened = nextViewer(context);
  await page.keyboard.press('Enter');
  const viewer = await opened;
  return { viewer, record: await viewerRecord(viewer) };
}

// Comme `captureBlock`, avec un rectangle tracé à la souris.
async function captureZone(context, sw, page, tabId, { x, y, w, h }) {
  await startPick(sw, tabId, 'zone');
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + w, y + h, { steps: 3 });
  const opened = nextViewer(context);
  await page.mouse.up();
  const viewer = await opened;
  return { viewer, record: await viewerRecord(viewer) };
}

// Ce que contient l'image : couleurs le long de la colonne du milieu (suites [début, fin, couleur]), et nombre de pixels de chaque couleur cherchée.
function readImage(viewer, seek = {}) {
  return viewer.evaluate(
    async (seek) => {
      const { getCapture } = await import(chrome.runtime.getURL('lib/db.js'));
      const { Stitcher } = await import(chrome.runtime.getURL('viewer/stitcher.js'));
      const record = await getCapture(new URLSearchParams(location.search).get('id'));
      const stitcher = new Stitcher(record);
      const counts = Object.fromEntries(Object.keys(seek).map((name) => [name, 0]));
      let holes = 0;
      const holeRows = new Set();
      const runs = [];
      const edges = { left: new Set(), right: new Set() };
      const hit = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) <= 12;
      const BAND = 2000;
      for (let top = 0; top < record.height; top += BAND) {
        const h = Math.min(BAND, record.height - top);
        const ctx = new OffscreenCanvas(record.width, h).getContext('2d', { willReadFrequently: true });
        await stitcher.enqueue(() => stitcher.draw(ctx, top, h));
        const { data } = ctx.getImageData(0, 0, record.width, h);
        const middle = record.width >> 1;
        for (let row = 0; row < h; row++) {
          for (let col = 0; col < record.width; col++) {
            const i = (row * record.width + col) * 4;
            const px = [data[i], data[i + 1], data[i + 2]];
            if (data[i + 3] < 255) {
              holes++;
              holeRows.add(top + row);
            }
            if (col === middle) {
              const last = runs.at(-1);
              if (last && hit(last[2], px)) last[1] = top + row + 1;
              else runs.push([top + row, top + row + 1, px]);
            }
            if (col === 0) edges.left.add(px.join());
            if (col === record.width - 1) edges.right.add(px.join());
            for (const [name, rgb] of Object.entries(seek)) if (hit(rgb, px)) counts[name]++;
          }
        }
      }
      stitcher.dispose();
      return { width: record.width, height: record.height, runs, counts, holes, holeRows: [...holeRows], left: [...edges.left], right: [...edges.right] };
    },
    seek,
  );
}

// Compare l'image à ce que Chrome dessine lui-même au même endroit de la page, sans recollage. `rect` en points, dans le document.
async function compareToPage(context, page, viewer, rect) {
  await page.bringToFront();
  const session = await context.newCDPSession(page);
  let wrong = 0;
  let box = null;
  let size = '';
  const TILE = 1500;
  for (let y = 0; y < rect.h; y += TILE) {
    const clip = { x: rect.x, y: rect.y + y, width: rect.w, height: Math.min(TILE, rect.h - y), scale: 1 };
    const { data } = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true, clip });
    await viewer.bringToFront();
    const one = await viewer.evaluate(
      async ({ data, y }) => {
        const { getCapture } = await import(chrome.runtime.getURL('lib/db.js'));
        const { Stitcher } = await import(chrome.runtime.getURL('viewer/stitcher.js'));
        const record = await getCapture(new URLSearchParams(location.search).get('id'));
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: 'image/png' }));
        const { width, height } = bitmap;
        const stitcher = new Stitcher(record);
        const top = y * record.scale;
        const mine = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
        await stitcher.enqueue(() => stitcher.draw(mine, top, height));
        const theirs = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
        theirs.drawImage(bitmap, 0, 0);
        const a = mine.getImageData(0, 0, width, height).data;
        const b = theirs.getImageData(0, 0, width, height).data;
        let wrong = 0;
        let box = null;
        for (let row = 0; row < height; row++) {
          for (let col = 0; col < width; col++) {
            const i = (row * width + col) * 4;
            if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) <= 24) continue;
            wrong++;
            box = box ? [Math.min(box[0], col), Math.min(box[1], top + row), Math.max(box[2], col), Math.max(box[3], top + row)] : [col, top + row, col, top + row];
          }
        }
        stitcher.dispose();
        bitmap.close();
        return { wrong, box, size: `${record.width}×${record.height}, référence ${width} de large` };
      },
      { data, y },
    );
    await page.bringToFront();
    wrong += one.wrong;
    size = one.size;
    if (one.box) box = box ? [Math.min(box[0], one.box[0]), Math.min(box[1], one.box[1]), Math.max(box[2], one.box[2]), Math.max(box[3], one.box[3])] : one.box;
  }
  await session.detach();
  return { wrong, box, size };
}

const docRect = (page, selector) =>
  page.evaluate((selector) => {
    const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
    return { x: x + scrollX, y: y + scrollY, w: width, h: height };
  }, selector);

// Une page ouverte, une capture de bloc, et tout se referme même si le contrôle lâche.
async function onBlock(context, sw, url, selector, body, { before } = {}) {
  const { page, tabId } = await openTab(context, sw, url);
  let viewer;
  try {
    await before?.(page, tabId);
    const shot = await captureBlock(context, sw, page, tabId, selector);
    viewer = shot.viewer;
    return await body({ page, tabId, viewer, record: shot.record });
  } finally {
    await viewer?.close();
    await page.close();
  }
}

const countScrolls = (page) =>
  page.evaluate(() => {
    window.__scrolls = 0;
    window.addEventListener('scroll', () => window.__scrolls++, { capture: true, passive: true });
  });

// Couleur du cadre de sélection (terre cuite : --accent clair du design system).
const CALQUE = { edge: [180, 83, 47] };
const CYAN = [0, 204, 255];
const MAGENTA = [255, 0, 170];
const BLUE = [0, 0, 255];
const PURPLE = [170, 0, 255];
const YELLOW = [255, 216, 77];
const GREEN = [34, 170, 68];
const OUTER = [223, 231, 226];
const ABOVE = [241, 239, 234];

async function groupRegion(context, sw, base) {
  console.log('\n— Le rectangle choisi');
  const tall = `${base}/tall-block.html`;

  await test('region : dimensions égales au rectangle × échelle', () =>
    onBlock(context, sw, tall, '#inner', async ({ page, record }) => {
      const rect = await docRect(page, '#inner');
      return { ok: record.width === rect.w * 2 && record.height === rect.h * 2 && record.scale === 2, detail: `${record.width}×${record.height}, attendu ${rect.w * 2}×${rect.h * 2}` };
    }));

  await test('region : pixels égaux à la page entière rognée', () =>
    onBlock(context, sw, tall, '#outer', async ({ page, viewer }) => {
      const { wrong, box, size } = await compareToPage(context, page, viewer, await docRect(page, '#outer'));
      return { ok: wrong === 0, detail: `${size}, différents ${wrong}${box ? ` dans ${JSON.stringify(box)}` : ''}` };
    }));

  await test('region : aucune couleur du calque', () =>
    onBlock(context, sw, tall, '#inner', async ({ viewer }) => {
      const { counts } = await readImage(viewer, CALQUE);
      return { ok: counts.edge === 0, detail: `${counts.edge} pixels` };
    }));

  await test('region : nom et titre', () =>
    onBlock(context, sw, tall, '#leaf', async ({ viewer, record }) => {
      await viewer.evaluate(() => {
        window.__names = [];
        Object.defineProperty(chrome.downloads, 'download', {
          value: async ({ filename }) => {
            window.__names.push(filename);
            return 1;
          },
          configurable: true,
        });
      });
      await viewer.click('#download-all');
      await viewer.waitForFunction(() => window.__names.length > 0, null, { timeout: 15000 });
      const seen = {
        file: await viewer.evaluate(() => window.__names[0]),
        title: await viewer.locator('#title').innerText(),
        meta: await viewer.locator('#meta').innerText(),
        tab: await viewer.title(),
        row: await viewer.locator('.history-title').first().innerText(),
        url: record.url,
      };
      const ok = /^Captures\/127\.0\.0\.1_[^/]+\.png$/.test(seen.file) && /^Bloc : Bloc très haut$/.test(seen.title) && /127\.0\.0\.1/.test(seen.meta) && /^Bloc : /.test(seen.tab) && /^Bloc : /.test(seen.row) && /tall-block\.html/.test(seen.url) && record.origin === 'bloc';
      return { ok, detail: JSON.stringify(seen) };
    }));

  await test('region : le rectangle est remesuré après une image paresseuse au-dessus', () =>
    onBlock(context, sw, `${tall}?lazy`, '#inner', async ({ page, viewer, record }) => {
      const grown = await page.evaluate(() => document.getElementById('lazy').offsetHeight);
      const { wrong, box, size } = await compareToPage(context, page, viewer, await docRect(page, '#inner'));
      return { ok: grown === 300 && wrong === 0 && record.height === 3040 * 2, detail: `contenu paresseux ${grown}, ${size}, différents ${wrong}${box ? ` dans ${JSON.stringify(box)}` : ''}` };
    }));

  await test('region : modale', () =>
    onBlock(context, sw, `${tall}?modal`, '#modal', async ({ viewer, record }) => {
      const { counts } = await readImage(viewer, { modal: [204, 68, 0] });
      return { ok: record.width === 1000 && record.height === 600 && counts.modal === 600000, detail: `${record.width}×${record.height}, ${counts.modal} pixels de la modale` };
    }));

  await test('region : en-tête fixe choisi', () =>
    onBlock(context, sw, tall, '#head', async ({ viewer, record }) => {
      const { counts } = await readImage(viewer, { blue: BLUE });
      return { ok: record.height === 120 && counts.blue === record.width * 120, detail: `${record.width}×${record.height}, ${counts.blue} pixels bleus` };
    }));

  await test('region : bloc collant, resté collé et sans l’en-tête fixe', () =>
    onBlock(
      context,
      sw,
      tall,
      '#sticky',
      async ({ page, viewer, record }) => {
        const { counts } = await readImage(viewer, { purple: PURPLE, blue: BLUE });
        const y = await page.evaluate(() => scrollY);
        return { ok: record.height === 100 && counts.purple === record.width * 100 && counts.blue === 0 && y === 1000, detail: `${record.width}×${record.height}, violet ${counts.purple}, bleu ${counts.blue}, défilement ${y}` };
      },
      { before: (page) => page.evaluate(() => window.scrollTo(0, 1000)) },
    ));

  await test('region : en-tête de page non répété sur un bloc de 3 000 px', () =>
    onBlock(context, sw, tall, '#inner', async ({ viewer }) => {
      const { runs, counts } = await readImage(viewer, { blue: BLUE, purple: PURPLE });
      const colors = runs.map(([, , rgb]) => rgb.join());
      const alternates = colors.slice(1, -1).every((color, index) => color === (index % 2 ? GREEN : YELLOW).join());
      const ok = counts.blue === 0 && counts.purple === 0 && colors[0] === CYAN.join() && colors.at(-1) === MAGENTA.join() && alternates && runs.length === 32 && runs.slice(1, -1).every(([a, b]) => b - a === 200);
      return { ok, detail: `bleu ${counts.blue}, violet ${counts.purple}, ${runs.length} bandes` };
    }));

  await test('region : un en-tête fixe ne couvre pas le haut d’un bloc à l’écran', () =>
    onBlock(context, sw, tall, '#above', async ({ viewer, record }) => {
      const { counts } = await readImage(viewer, { blue: BLUE, above: ABOVE });
      return { ok: counts.blue === 0 && counts.above === record.width * record.height, detail: `bleu ${counts.blue}, ${counts.above} sur ${record.width * record.height}` };
    }));

  await test('region : un fond fixe derrière le bloc reste visible', () =>
    onBlock(context, sw, `${tall}?back`, '#clear', async ({ viewer, record }) => {
      const { counts } = await readImage(viewer, { back: [160, 208, 255] });
      return { ok: record.width === 600 && counts.back === record.width * record.height, detail: `${counts.back} sur ${record.width * record.height}` };
    }));

  await test('region : bloc dans la zone défilante principale', () =>
    onBlock(context, sw, `${base}/app.html`, '#scroller', async ({ page, viewer, record }) => {
      const { full, wide } = await page.evaluate(() => {
        const el = document.getElementById('scroller');
        return { full: el.scrollHeight, wide: el.clientWidth };
      });
      const { runs, counts, left: edge } = await readImage(viewer, { magenta: MAGENTA });
      const left = await page.evaluate(() => document.getElementById('scroller').scrollTop);
      // Le titre collant apparaît une seule fois, en haut. Le bord de l'image montrerait la barre fixe (#333) ou le panneau (#e6e6e6).
      const once = counts.magenta <= record.width * 100 && runs[0][2].join() === MAGENTA.join() && runs[0][1] === 100;
      const clean = !edge.includes('51,51,51') && !edge.includes('230,230,230');
      return { ok: record.height === full * 2 && record.width === wide * 2 && once && clean && left === 0, detail: `${record.width}×${record.height}, attendu ${wide * 2}×${full * 2}, magenta ${counts.magenta}, bord ${edge.join(' ')}` };
    }));

  await test('region : petit bloc hors de l’écran, dans la zone défilante principale', () =>
    onBlock(context, sw, `${base}/app.html`, '.msg:nth-child(120)', async ({ page, viewer, record }) => {
      const rect = await rectOf(page, '.msg:nth-child(120)');
      const text = await viewer.evaluate(() => document.querySelector('#title').textContent);
      const { counts } = await readImage(viewer, { magenta: MAGENTA });
      return { ok: record.width === rect.w * 2 && record.height === Math.round(rect.h * 2) && counts.magenta === 0, detail: `${record.width}×${record.height}, attendu ${rect.w * 2}×${rect.h * 2}, ${text}` };
    }));

  await test('region : zone tracée', async () => {
    const { page, tabId } = await openTab(context, sw, tall);
    let viewer;
    try {
      const rect = { x: 200, y: 500, w: 400, h: 300 };
      const shot = await captureZone(context, sw, page, tabId, rect);
      viewer = shot.viewer;
      const { record } = shot;
      const { wrong, box, size } = await compareToPage(context, page, viewer, rect);
      const title = await viewer.locator('#title').innerText();
      return { ok: record.width === 800 && record.height === 600 && wrong === 0 && record.origin === 'zone' && /^Zone : /.test(title), detail: `${size}, différents ${wrong}${box ? ` dans ${JSON.stringify(box)}` : ''}, ${title}` };
    } finally {
      await viewer?.close();
      await page.close();
    }
  });

  await test('region : zone tracée, les éléments fixes restent tels qu’à l’écran', async () => {
    const { page, tabId } = await openTab(context, sw, tall);
    let viewer;
    try {
      const shot = await captureZone(context, sw, page, tabId, { x: 200, y: 20, w: 400, h: 100 });
      viewer = shot.viewer;
      const { counts } = await readImage(viewer, { ...CALQUE, blue: BLUE });
      return { ok: counts.blue === 800 * 80 && counts.edge === 0, detail: `bleu ${counts.blue}, calque ${counts.edge}` };
    } finally {
      await viewer?.close();
      await page.close();
    }
  });

  await test('region : bloc entièrement à l’écran, aucun défilement préalable', () =>
    onBlock(
      context,
      sw,
      tall,
      '#leaf',
      async ({ page, viewer, record }) => {
        const scrolls = await page.evaluate(() => window.__scrolls);
        const y = await page.evaluate(() => scrollY);
        const { counts } = await readImage(viewer, { white: [255, 255, 255] });
        return { ok: scrolls === 0 && y === 300 && record.width === 600 && record.height === 160 && counts.white === 600 * 160, detail: `${scrolls} défilements, position ${y}, ${record.width}×${record.height}, blanc ${counts.white}` };
      },
      {
        before: async (page) => {
          await page.evaluate(() => window.scrollTo(0, 300));
          // L'événement du défilement ci-dessus part à l'image suivante : il ne doit pas être compté.
          await page.waitForTimeout(200);
          await countScrolls(page);
        },
      },
    ));

  await test('region : bloc fixe qui tient à l’écran, capturé sans défilement', () =>
    onBlock(
      context,
      sw,
      `${tall}?modal`,
      '#modal',
      async ({ page, record }) => {
        const scrolls = await page.evaluate(() => window.__scrolls);
        const y = await page.evaluate(() => scrollY);
        return { ok: scrolls === 0 && y === 500 && record.height === 600, detail: `${scrolls} défilements, position ${y}` };
      },
      {
        before: async (page) => {
          await page.evaluate(() => window.scrollTo(0, 500));
          await page.waitForTimeout(200);
          await countScrolls(page);
        },
      },
    ));

  await test('region : le style de la page est remis en état', () =>
    onBlock(context, sw, tall, '#inner', async ({ page }) => {
      const after = await page.evaluate(() => ({
        y: scrollY,
        leftover: [...document.querySelectorAll('style')].some((s) => s.textContent.includes('scrollbar-width: none')),
        head: getComputedStyle(document.getElementById('head')).opacity,
        sticky: getComputedStyle(document.getElementById('sticky')).position,
      }));
      return { ok: after.y === 0 && !after.leftover && after.head === '1' && after.sticky === 'sticky', detail: JSON.stringify(after) };
    }));

  await test('region : zoom du navigateur à 125 %', async () => {
    const { page, tabId } = await openTab(context, sw, tall);
    let viewer;
    try {
      await sw.evaluate((tabId) => chrome.tabs.setZoom(tabId, 1.25), tabId);
      await page.waitForFunction(() => window.devicePixelRatio === 2.5);
      const rect = await docRect(page, '#inner');
      const shot = await captureBlock(context, sw, page, tabId, '#inner');
      viewer = shot.viewer;
      const { record } = shot;
      const { runs, counts } = await readImage(viewer, { blue: BLUE });
      const wanted = { w: rect.w * 2.5, h: rect.h * 2.5 };
      const bands = runs.filter(([a, b]) => b - a > 3);
      const even = bands.slice(1, -1).every(([a, b]) => Math.abs(b - a - 250) <= 2);
      const ok = Math.abs(record.width - wanted.w) <= 2 && Math.abs(record.height - wanted.h) <= 2 && record.scale === 2.5 && bands[0][2].join() === CYAN.join() && bands.at(-1)[2].join() === MAGENTA.join() && bands.length === 32 && even && counts.blue === 0;
      return { ok, detail: `${record.width}×${record.height}, attendu ${wanted.w}×${wanted.h}, échelle ${record.scale}, ${bands.length} bandes, bleu ${counts.blue}` };
    } finally {
      await sw.evaluate((tabId) => chrome.tabs.setZoom(tabId, 1), tabId).catch(() => {});
      await viewer?.close();
      await page.close();
    }
  });

  await test('region : zone au zoom du navigateur à 125 %', async () => {
    const { page, tabId } = await openTab(context, sw, tall);
    let viewer;
    try {
      await sw.evaluate((tabId) => chrome.tabs.setZoom(tabId, 1.25), tabId);
      await page.waitForFunction(() => window.devicePixelRatio === 2.5);
      // Le tracé est lu directement : un zoom qui décalerait les coordonnées se verrait sur les dimensions.
      await startPick(sw, tabId, 'zone');
      const opened = nextViewer(context);
      await sw.evaluate(
        async (tabId) => {
          await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
              const fire = (type, x, y) => window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }));
              fire('mousedown', 100, 40);
              fire('mousemove', 300, 180);
              fire('mouseup', 300, 180);
            },
          });
        },
        tabId,
      );
      viewer = await opened;
      const record = await viewerRecord(viewer);
      // L'en-tête bleu finit à 60 points : il occupe les 20 premiers points de la zone, soit 50 pixels à cette échelle.
      const { runs } = await readImage(viewer);
      const blue = runs[0][2].join() === BLUE.join() && Math.abs(runs[0][1] - 50) <= 2;
      return { ok: Math.abs(record.width - 500) <= 2 && Math.abs(record.height - 350) <= 2 && blue, detail: `${record.width}×${record.height}, attendu 500×350, première bande ${JSON.stringify(runs[0])}` };
    } finally {
      await sw.evaluate((tabId) => chrome.tabs.setZoom(tabId, 1), tabId).catch(() => {});
      await viewer?.close();
      await page.close();
    }
  });
}

// Playwright masque d'office les barres de défilement : ce groupe garde un navigateur qui les montre, et une barre qui prend de la place.
async function groupBarres(context, sw, base) {
  console.log('\n— Barres de défilement classiques');
  await test('region : barres de défilement classiques', () =>
    onBlock(context, sw, `${base}/tall-block.html?bars`, '#outer', async ({ page, viewer }) => {
      const withBar = await rectOf(page, '#outer');
      const image = await readImage(viewer);
      // Sans la barre, masquée pendant la capture, la page reprend toute sa largeur : le bloc aussi. Les deux bords sont ceux du bloc, sans bande de page ni de barre.
      const clean = image.left.join() === OUTER.join() && image.right.join() === OUTER.join();
      const inner = await page.evaluate(() => [innerWidth, document.documentElement.clientWidth]);
      return { ok: inner[0] - inner[1] === 15 && clean && image.width === (withBar.w + 15) * 2, detail: `barre de ${inner[0] - inner[1]}, bloc ${withBar.w} avec barre, image de ${image.width}, bords ${image.left.join(' ')} / ${image.right.join(' ')}` };
    }));
}

// --- Cas limites et annulation ---

// Le refus se montre à l'icône un instant avant que la capture ne soit finie : le contrôle suivant doit attendre cette fin.
async function untilIdle(sw) {
  for (let i = 0; i < 100 && (await sw.evaluate(() => self.captureRunningForTest())); i++) await sleep(100);
}

// Le titre de l'icône après un refus, et l'absence de page de résultats. La fenêtre de l'icône, ouverte d'office, consomme le message gardé.
async function refused(context, sw, tabId, startIt) {
  await untilIdle(sw);
  await startIt();
  // Le refus est prêt dès que le titre le dit.
  let title = '';
  for (let i = 0; i < 150 && !/Capture impossible/.test(title); i++) {
    await sleep(200);
    title = await sw.evaluate((tabId) => chrome.action.getTitle({ tabId }).catch(() => ''), tabId);
  }
  await untilIdle(sw);
  const viewers = context.pages().filter((p) => p.url().includes('/viewer/viewer.html')).length;
  for (const p of context.pages()) if (p.url().includes('/popup/popup.html')) await p.close();
  return { title, viewers };
}

// Choisit l'élément et valide, sans attendre de page de résultats.
async function chooseAndValidate(sw, page, tabId, selector) {
  await untilIdle(sw);
  await startPick(sw, tabId, 'block');
  await chooseElement(sw, tabId, selector);
  await page.keyboard.press('Enter');
}

async function groupLimites(context, sw, base) {
  console.log('\n— Cas limites');
  const tall = `${base}/tall-block.html`;
  const notice = async (viewer) => {
    const el = viewer.locator('#partial-notice');
    return (await el.isVisible()) ? (await el.innerText()).trim() : '';
  };

  await test('limite : autre zone qui défile, le résultat le dit', () =>
    onBlock(context, sw, `${tall}?inside`, '#boxed', async ({ viewer, record, page }) => {
      const text = await notice(viewer);
      const top = await page.evaluate(() => document.getElementById('box').scrollTop);
      return { ok: record.partial === 'scroller' && /partie visible/.test(text) && record.height === 600 && top === 0, detail: `${record.partial}, ${record.width}×${record.height}, « ${text} »` };
    }));

  await test('limite : bloc qui défile lui-même, hors zone principale, le résultat le dit', () =>
    onBlock(context, sw, `${tall}?inside`, '#box', async ({ viewer, record }) => {
      const text = await notice(viewer);
      return { ok: record.partial === 'scroller' && /partie visible/.test(text) && record.height === 600, detail: `${record.partial}, ${record.width}×${record.height}, « ${text} »` };
    }));

  await test('limite : fixe plus haut que l’écran, le résultat le dit', () =>
    onBlock(context, sw, `${tall}?tallfixed`, '#tallfixed', async ({ viewer, record, page }) => {
      const text = await notice(viewer);
      const innerH = await page.evaluate(() => innerHeight);
      return { ok: record.partial === 'fixed' && /partie visible/.test(text) && record.height === (innerH - 100) * 2 && record.width === 400, detail: `${record.partial}, ${record.width}×${record.height}, « ${text} »` };
    }));

  await test('limite : plus large que la fenêtre, le résultat le dit', () =>
    onBlock(context, sw, `${tall}?wide`, '#wide', async ({ viewer, record, page }) => {
      const text = await notice(viewer);
      const innerW = await page.evaluate(() => innerWidth);
      return { ok: record.partial === 'wide' && /coupé/.test(text) && record.width === innerW * 2 && record.height === 400, detail: `${record.partial}, ${record.width}×${record.height}, « ${text} »` };
    }));

  await test('limite : un bloc entier n’a aucune mention', () =>
    onBlock(context, sw, tall, '#inner', async ({ viewer, record }) => ({ ok: !record.partial && !(await notice(viewer)), detail: String(record.partial) })));

  await test('limite : onglet changé', async () => {
    const other = await context.newPage();
    await other.goto(`${base}/iframe.html`);
    const { page, tabId } = await openTab(context, sw, tall);
    try {
      const out = await refused(context, sw, tabId, async () => {
        await chooseAndValidate(sw, page, tabId, '#inner');
        await sleep(3000);
        await other.bringToFront();
      });
      await page.bringToFront();
      const after = await page.evaluate(() => ({ leftover: [...document.querySelectorAll('style')].some((s) => s.textContent.includes('scrollbar-width: none')), head: getComputedStyle(document.getElementById('head')).opacity }));
      return { ok: /onglet a changé/.test(out.title) && out.viewers === 0 && !after.leftover && after.head === '1', detail: `${out.title} ; ${JSON.stringify(after)}` };
    } finally {
      await other.close();
      await page.close();
    }
  });

  await test('limite : onglet fermé', async () => {
    for (const p of context.pages()) if (p.url().includes('/popup/popup.html')) await p.close();
    await sw.evaluate(() => {
      self.__logged = [];
      if (!self.__original) self.__original = console.error;
      console.error = (...args) => self.__logged.push(args.join(' '));
      self.addEventListener('unhandledrejection', (event) => self.__logged.push(`rejet non intercepté : ${event.reason}`));
    });
    await untilIdle(sw);
    const { page, tabId } = await openTab(context, sw, tall);
    await chooseAndValidate(sw, page, tabId, '#inner');
    await sleep(3000);
    await page.close();
    await sleep(2500);
    const state = await sw.evaluate(async () => ({
      logged: self.__logged,
      popups: (await chrome.runtime.getContexts({ contextTypes: ['POPUP'] })).length,
      capturing: (await chrome.storage.session.get('capturing')).capturing ?? null,
      lastError: (await chrome.storage.session.get('lastError')).lastError ?? null,
    }));
    await sw.evaluate(() => {
      console.error = self.__original;
    });
    const viewers = context.pages().filter((p) => p.url().includes('/viewer/viewer.html')).length;
    return { ok: state.logged.length === 0 && state.popups === 0 && !state.capturing && !state.lastError && viewers === 0, detail: JSON.stringify({ ...state, viewers }) };
  });

  await test('limite : page interdite', async () => {
    const { page, tabId } = await openTab(context, sw, 'chrome://version');
    try {
      const out = await refused(context, sw, tabId, () => sw.evaluate(async (tabId) => self.onCommandForTest('capture-pick', await chrome.tabs.get(tabId)), tabId));
      return { ok: /interdit/.test(out.title) && out.viewers === 0, detail: out.title };
    } finally {
      await page.close();
    }
  });

  await test('limite : page de résultats de l’extension', async () => {
    const { page, tabId } = await openTab(context, sw, `chrome-extension://${new URL(sw.url()).host}/viewer/viewer.html`);
    try {
      const out = await refused(context, sw, tabId, () => sw.evaluate(async (tabId) => self.onCommandForTest('capture-pick', await chrome.tabs.get(tabId)), tabId));
      return { ok: /page de résultats/.test(out.title), detail: out.title };
    } finally {
      await page.close();
    }
  });

  for (const [label, url, selector] of [
    ['bloc de hauteur nulle', `${tall}?zero`, '#zero'],
    ['bloc invisible (visibility: hidden)', `${tall}?invisible`, '#unseen'],
    ['bloc invisible (display: none)', `${tall}?invisible`, '#gone'],
  ]) {
    await test(`limite : ${label}`, async () => {
      const { page, tabId } = await openTab(context, sw, url);
      try {
        const out = await refused(context, sw, tabId, () => chooseAndValidate(sw, page, tabId, selector));
        return { ok: /pas visible/.test(out.title) && out.viewers === 0, detail: out.title };
      } finally {
        await page.close();
      }
    });
  }

  await test('limite : bloc disparu après préparation', async () => {
    const { page, tabId } = await openTab(context, sw, `${tall}?vanish`);
    try {
      const out = await refused(context, sw, tabId, () => chooseAndValidate(sw, page, tabId, '#below'));
      return { ok: /disparu/.test(out.title) && out.viewers === 0, detail: out.title };
    } finally {
      await page.close();
    }
  });

  await test('limite : la capture refusée pendant une autre', async () => {
    await untilIdle(sw);
    const { page, tabId } = await openTab(context, sw, tall);
    try {
      const opened = nextViewer(context);
      await chooseAndValidate(sw, page, tabId, '#inner');
      await sleep(1500);
      const answer = await sw.evaluate(async (tabId) => {
        try {
          await self.startPick(tabId, 'block');
          return 'ouvert';
        } catch (err) {
          return err.message;
        }
      }, tabId);
      const viewer = await opened;
      await viewer.close();
      return { ok: /déjà en cours/.test(answer), detail: answer };
    } finally {
      await page.close();
    }
  });

  await test('annuler : long bloc, aucun fichier, page remise en état', async () => {
    // La fenêtre de l'icône dans sa propre fenêtre de navigateur : dans un onglet voisin, elle rendrait la page inactive et arrêterait la capture.
    const opening = context.waitForEvent('page', { predicate: (p) => p.url().includes('/popup/popup.html') });
    await sw.evaluate(() => chrome.windows.create({ url: chrome.runtime.getURL('popup/popup.html'), type: 'popup', width: 320, height: 500, focused: false }));
    const popup = await opening;
    const count = () =>
      popup.evaluate(async () => {
        const { listCaptures } = await import(chrome.runtime.getURL('lib/db.js'));
        return (await listCaptures()).length;
      });
    const { page, tabId } = await openTab(context, sw, tall);
    try {
      const before = await count();
      await chooseAndValidate(sw, page, tabId, '#inner');
      await sleep(2500);
      // Rouverte, la fenêtre retrouve la capture en cours et son bouton.
      await popup.reload();
      await popup.waitForSelector('#cancel:not([hidden])', { timeout: 5000 });
      const during = await popup.evaluate(() => ({ text: document.getElementById('status-text').textContent, disabled: document.getElementById('full').disabled }));
      await popup.screenshot({ path: path.join(WORK, 'annuler.png') });
      await popup.click('#cancel');
      let state = 'capturing';
      for (let i = 0; i < 40 && state; i++) {
        await sleep(250);
        state = await sw.evaluate(async () => (await chrome.storage.session.get('capturing')).capturing ?? null);
      }
      const after = await page.evaluate(() => ({ y: scrollY, leftover: [...document.querySelectorAll('style')].some((s) => s.textContent.includes('scrollbar-width: none')), head: getComputedStyle(document.getElementById('head')).opacity }));
      const stored = await count();
      const viewers = context.pages().filter((p) => p.url().includes('/viewer/viewer.html')).length;
      const silent = await sw.evaluate(async (tabId) => ({ badge: await chrome.action.getBadgeText({ tabId }), error: (await chrome.storage.session.get('lastError')).lastError ?? null }), tabId);
      const ok = during.disabled && /bloc/.test(during.text) && !state && stored === before && viewers === 0 && after.y === 0 && !after.leftover && after.head === '1' && silent.badge === '' && !silent.error;
      return { ok, detail: JSON.stringify({ during, state, before, stored, viewers, after, silent }) };
    } finally {
      await popup.close();
      await page.close();
    }
  });

  await test('annuler : relancer juste après fonctionne', async () => {
    const { page, tabId } = await openTab(context, sw, tall);
    try {
      await chooseAndValidate(sw, page, tabId, '#inner');
      await sleep(2000);
      await sw.evaluate(() => self.cancelCaptureForTest());
      for (let i = 0; i < 40; i++) {
        await sleep(250);
        if (!(await sw.evaluate(async () => (await chrome.storage.session.get('capturing')).capturing ?? null))) break;
      }
      const opened = nextViewer(context);
      await chooseAndValidate(sw, page, tabId, '#leaf');
      const viewer = await opened;
      const record = await viewerRecord(viewer);
      await viewer.close();
      return { ok: record.width === 600, detail: `${record.width}×${record.height}` };
    } finally {
      await page.close();
    }
  });

  await test('limite : 100 000 points', () =>
    onBlock(context, sw, `${tall}?huge`, '#inner', async ({ viewer, record }) => {
      const shown = await viewer.locator('#notice').isVisible();
      return { ok: record.truncated === true && record.height === 200000 && shown, detail: `${record.width}×${record.height}, ${record.sliceCount} tranches, mention ${shown}` };
    }));
}

// --- Écarts trouvés par le relecteur neuf ---

const ONLY_MODAL = { modal: [204, 68, 0] };

async function groupRelecture(context, sw, base) {
  console.log('\n— Relecture');
  const tall = `${base}/tall-block.html`;
  const scrolled = (y) => ({
    before: async (page) => {
      await page.evaluate((y) => window.scrollTo(0, y), y);
      await page.waitForTimeout(200);
      await countScrolls(page);
    },
  });

  for (const [label, query] of [['html { overflow-y: scroll }', 'modal&htmlscroll'], ['body { overflow-x: hidden } et hauteur 100 %', 'modal&bodyhidden']]) {
    await test(`relecture : ${label}, page défilée, une modale fixe sort entière`, () =>
      onBlock(
        context,
        sw,
        `${tall}?${query}`,
        '#modal',
        async ({ page, viewer, record }) => {
          const { counts } = await readImage(viewer, ONLY_MODAL);
          const scrolls = await page.evaluate(() => window.__scrolls);
          return { ok: record.width === 1000 && record.height === 600 && counts.modal === 600000 && !record.partial && scrolls === 0, detail: `${record.width}×${record.height}, ${record.partial}, ${scrolls} défilements` };
        },
        scrolled(1000),
      ));
    await test(`relecture : ${label}, un bloc à l’écran ne fait défiler personne`, () =>
      onBlock(
        context,
        sw,
        `${tall}?${query}`,
        '#leaf',
        async ({ page, record }) => {
          const scrolls = await page.evaluate(() => window.__scrolls);
          return { ok: record.width === 600 && record.height === 160 && scrolls === 0, detail: `${record.width}×${record.height}, ${scrolls} défilements` };
        },
        scrolled(300),
      ));
    await test(`relecture : ${label}, un long bloc reste assemblé`, () =>
      onBlock(context, sw, `${tall}?${query.replace('modal&', '')}`, '#inner', async ({ page, viewer, record }) => {
        const { wrong } = await compareToPage(context, page, viewer, await docRect(page, '#inner'));
        return { ok: record.height === 6080 && wrong === 0 && !record.partial, detail: `${record.width}×${record.height}, différents ${wrong}` };
      }));
  }

  await test('relecture : un en-tête fixe dans le bloc choisi ne se répète pas', () =>
    onBlock(context, sw, `${tall}?childhead`, '#outer', async ({ page, viewer, record }) => {
      const { counts } = await readImage(viewer, { blue: BLUE });
      const { wrong, box } = await compareToPage(context, page, viewer, await docRect(page, '#outer'));
      return { ok: counts.blue === 0 && wrong === 0 && record.height === 6240, detail: `bleu ${counts.blue}, différents ${wrong} ${JSON.stringify(box)}` };
    }));

  await test('relecture : un bloc qui tient à l’écran garde ses enfants fixes', () =>
    onBlock(context, sw, `${tall}?childhead`, '#head', async ({ record }) => ({ ok: record.height === 120, detail: `${record.width}×${record.height}` })));

  for (const [label, selector] of [['la zone principale elle-même', '#main'], ['un bloc qui la remplit', '#tall']]) {
    await test(`relecture : coque fixe, ${label} est assemblé`, () =>
      onBlock(context, sw, `${base}/shell.html`, selector, async ({ viewer, record }) => {
        const { runs } = await readImage(viewer);
        const first = runs[0][2].join() === CYAN.join();
        const last = runs.at(-1)[2].join() === MAGENTA.join();
        return { ok: record.height === 5040 * 2 && !record.partial && first && last, detail: `${record.width}×${record.height}, ${record.partial}, ${runs.length} bandes` };
      }));
  }

  await test('relecture : zone principale bordée, aucune mention de largeur', () =>
    onBlock(context, sw, `${base}/shell.html?border`, '#main', async ({ viewer, record }) => {
      const shown = await viewer.locator('#partial-notice').isVisible();
      return { ok: !record.partial && !shown, detail: `${record.partial}, mention ${shown}` };
    }));

  await test('relecture : fixe, trop haut et trop large, le résultat dit les deux', () =>
    onBlock(context, sw, `${tall}?tallwide`, '#tallwide', async ({ viewer }) => {
      const text = (await viewer.locator('#partial-notice').innerText()).trim();
      return { ok: /partie visible/.test(text) && /coupé/.test(text), detail: text };
    }));

  await test('relecture : page à défilement aligné, le bloc reste juste', () =>
    onBlock(context, sw, `${tall}?snap`, '#inner', async ({ page, viewer, record }) => {
      const { wrong, box } = await compareToPage(context, page, viewer, await docRect(page, '#inner'));
      const kept = await page.evaluate(() => getComputedStyle(document.documentElement).scrollSnapType);
      return { ok: wrong === 0 && record.height === 6080 && /mandatory/.test(kept), detail: `différents ${wrong} ${JSON.stringify(box)}, page ${kept}` };
    }));

  await test('relecture : petites sections à défilement aligné, le bloc reste juste', () =>
    // La page démarre alignée sur sa première section : la référence y montrerait l'en-tête. Les bandes du bloc, elles, se lisent directement.
    onBlock(context, sw, `${tall}?snapsmall`, '#inner', async ({ viewer, record }) => {
      const { runs, counts } = await readImage(viewer, { blue: BLUE });
      const even = runs.slice(1, -1).every(([a, b]) => b - a === 200);
      return { ok: record.height === 6080 && runs.length === 32 && even && counts.blue === 0, detail: `${record.width}×${record.height}, ${runs.length} bandes, bleu ${counts.blue}` };
    }));

  await test('relecture : le bloc seul raccourcit pendant la capture, refus', async () => {
    const { page, tabId } = await openTab(context, sw, tall);
    try {
      const out = await refused(context, sw, tabId, async () => {
        await chooseAndValidate(sw, page, tabId, '#inner');
        await sleep(2600);
        await page.evaluate(() => (document.getElementById('inner').style.height = '100px'));
      });
      return { ok: /page a bougé/.test(out.title) && out.viewers === 0, detail: out.title };
    } finally {
      await page.close();
    }
  });

  await test('relecture : du contenu s’ajoute au-dessus pendant la capture, le bloc reste juste', async () => {
    const { page, tabId } = await openTab(context, sw, tall);
    let viewer;
    try {
      const opened = nextViewer(context);
      await chooseAndValidate(sw, page, tabId, '#inner');
      await sleep(2600);
      await page.evaluate(() => (document.getElementById('above').style.height = '430px'));
      viewer = await opened;
      await viewerRecord(viewer);
      const { wrong, box } = await compareToPage(context, page, viewer, await docRect(page, '#inner'));
      return { ok: wrong === 0, detail: `différents ${wrong} ${JSON.stringify(box)}` };
    } finally {
      await viewer?.close();
      await page.close();
    }
  });

  await test('relecture : en-tête du bloc rendu fixe par script, il ne se répète pas', () =>
    onBlock(context, sw, `${base}/js-header.html`, 'body', async ({ page, viewer, record }) => {
      const { counts, runs } = await readImage(viewer, { magenta: MAGENTA });
      const leftover = await page.evaluate(() => getComputedStyle(document.getElementById('header')).opacity);
      const first = runs[0][2].join() === MAGENTA.join();
      return { ok: first && counts.magenta <= record.width * 120 && counts.magenta > record.width * 100 && leftover === '1', detail: `${record.width}×${record.height}, magenta ${counts.magenta} (${record.width * 120} au plus), en-tête rendu ${leftover}` };
    }));

  await test('relecture : bouton affiché après le défilement, il ne se répète pas', () =>
    onBlock(context, sw, `${tall}?backtop`, '#outer', async ({ viewer }) => {
      const { counts } = await readImage(viewer, { button: [18, 52, 86] });
      return { ok: counts.button === 0, detail: `${counts.button} pixels du bouton` };
    }));

  await test('relecture : le fond fixe derrière un long bloc reste sur toutes les tranches', () =>
    onBlock(context, sw, `${tall}?back`, 'body', async ({ viewer, record }) => {
      const { counts, holes } = await readImage(viewer, { back: [160, 208, 255] });
      return { ok: holes === 0 && counts.back > record.width * 300, detail: `${counts.back} pixels du fond, ${holes} vides, ${record.width}×${record.height}` };
    }));

  await test('relecture : zone principale dont le bas sort de l’écran, comme une page entière', async () => {
    const { page, tabId } = await openTab(context, sw, `${base}/shell.html?overflow`);
    let viewer;
    try {
      const shot = await captureBlock(context, sw, page, tabId, '#main');
      viewer = shot.viewer;
      const size = await page.evaluate(() => {
        const el = document.getElementById('main');
        return { reach: el.scrollHeight - el.clientHeight + (innerHeight - el.getBoundingClientRect().top) };
      });
      return { ok: shot.record.height === size.reach * 2, detail: `${shot.record.width}×${shot.record.height}, attendu ${size.reach * 2} de haut` };
    } finally {
      await viewer?.close();
      await page.close();
    }
  });

  // Fait bouger la page juste avant la prise de vue numéro `nth`, sans dépendre d'un délai.
  const shiftBeforeShot = (tabId, nth) =>
    sw.evaluate(
      ({ tabId, nth }) => {
        if (!self.__realShot) self.__realShot = chrome.tabs.captureVisibleTab.bind(chrome.tabs);
        let calls = 0;
        Object.defineProperty(chrome.tabs, 'captureVisibleTab', {
          configurable: true,
          value: async (...args) => {
            if (++calls === nth) {
              await chrome.scripting.executeScript({ target: { tabId }, func: () => (document.getElementById('above').style.height = '430px') });
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            return self.__realShot(...args);
          },
        });
      },
      { tabId, nth },
    );
  const realShot = () => sw.evaluate(() => Object.defineProperty(chrome.tabs, 'captureVisibleTab', { configurable: true, value: self.__realShot }));

  for (const [label, selector, nth] of [['long bloc', '#inner', 2], ['bloc à l’écran', '#leaf', 1]]) {
    await test(`relecture : ${label}, la page bouge juste avant la prise de vue, la tranche est reprise`, async () => {
      const { page, tabId } = await openTab(context, sw, `${tall}?noanchor`);
      let viewer;
      try {
        await shiftBeforeShot(tabId, nth);
        const shot = await captureBlock(context, sw, page, tabId, selector);
        viewer = shot.viewer;
        const { wrong, box } = await compareToPage(context, page, viewer, await docRect(page, selector));
        return { ok: wrong === 0, detail: `${shot.record.width}×${shot.record.height}, différents ${wrong} ${JSON.stringify(box)}` };
      } finally {
        await realShot();
        await viewer?.close();
        await page.close();
      }
    });
  }

  await test('relecture : la page raccourcit pendant la capture, refus plutôt qu’une image fausse', async () => {
    const { page, tabId } = await openTab(context, sw, tall);
    try {
      const out = await refused(context, sw, tabId, async () => {
        await chooseAndValidate(sw, page, tabId, '#inner');
        await sleep(2600);
        await page.evaluate(() => {
          document.getElementById('inner').style.height = '100px';
          document.getElementById('below').remove();
        });
      });
      return { ok: /page a bougé/.test(out.title) && out.viewers === 0, detail: out.title };
    } finally {
      await page.close();
    }
  });

  await test('relecture : zoom à 110 %, aucune ligne vide entre les tranches', async () => {
    const { page, tabId } = await openTab(context, sw, tall);
    let viewer;
    try {
      await sw.evaluate((tabId) => chrome.tabs.setZoom(tabId, 1.1), tabId);
      await page.waitForFunction(() => Math.abs(window.devicePixelRatio - 2.2) < 0.01);
      const shot = await captureBlock(context, sw, page, tabId, '#inner');
      viewer = shot.viewer;
      const { holes, holeRows, width, height } = await readImage(viewer);
      return { ok: holes === 0 && height > 6000, detail: `${width}×${height}, ${holes} pixels vides aux lignes ${holeRows.join()}, ${shot.record.sliceCount} tranches, découpe ${JSON.stringify(shot.record.crop)}, échelle ${shot.record.scale}` };
    } finally {
      await sw.evaluate((tabId) => chrome.tabs.setZoom(tabId, 1), tabId).catch(() => {});
      await viewer?.close();
      await page.close();
    }
  });

  const watchPage = (page) =>
    page.evaluate(() => {
      window.__events = [];
      for (const type of ['mousedown', 'mouseup', 'click', 'dblclick']) document.addEventListener(type, (event) => window.__events.push(type), true);
    });

  await test('relecture : double clic, le second clic n’atteint pas la page', async () => {
    const { page, tabId } = await openTab(context, sw, tall);
    let viewer;
    try {
      await watchPage(page);
      await startPick(sw, tabId, 'block');
      await page.mouse.move(300, 700);
      await page.waitForTimeout(100);
      const opened = nextViewer(context);
      await page.mouse.dblclick(300, 700);
      viewer = await opened;
      await viewerRecord(viewer);
      const events = await page.evaluate(() => window.__events);
      return { ok: events.length === 0, detail: events.join() || 'aucun' };
    } finally {
      await viewer?.close();
      await page.close();
    }
  });

  await test('relecture : après un tracé de zone, aucun clic n’atteint la page', async () => {
    const { page, tabId } = await openTab(context, sw, tall);
    let viewer;
    try {
      await watchPage(page);
      const shot = await captureZone(context, sw, page, tabId, { x: 200, y: 500, w: 200, h: 100 });
      viewer = shot.viewer;
      const events = await page.evaluate(() => window.__events);
      return { ok: events.length === 0, detail: events.join() || 'aucun' };
    } finally {
      await viewer?.close();
      await page.close();
    }
  });

  await test('relecture : calque et page entière lancés ensemble, le calque ne reste pas', async () => {
    const { page, tabId } = await openTab(context, sw, `${base}/iframe.html`);
    let viewer;
    try {
      const opened = nextViewer(context);
      await sw.evaluate(async (tabId) => {
        await Promise.allSettled([self.startPick(tabId, 'block'), self.captureTab(tabId, 'visible')]);
      }, tabId);
      viewer = await opened;
      await viewerRecord(viewer);
      await sleep(300);
      const hosts = await hostCount(page);
      return { ok: hosts === 0, detail: `${hosts} calque` };
    } finally {
      await viewer?.close();
      await page.close();
    }
  });

  await test('relecture : choix validé dans une autre fenêtre pendant une capture, le refus se voit', async () => {
    await untilIdle(sw);
    const opening = context.waitForEvent('page', { predicate: (p) => p.url().includes('iframe.html') });
    const secondTab = await sw.evaluate(async (url) => (await chrome.windows.create({ url, focused: false })).tabs[0].id, `${base}/iframe.html`);
    const second = await opening;
    await second.waitForLoadState();
    const { page, tabId } = await openTab(context, sw, tall);
    try {
      await startPick(sw, secondTab, 'block');
      await second.mouse.move(100, 100);
      await sleep(100);
      const running = sw.evaluate((tabId) => self.captureTab(tabId, 'full'), tabId);
      await sleep(1500);
      await second.mouse.click(100, 100);
      await sleep(500);
      const title = await sw.evaluate((tabId) => chrome.action.getTitle({ tabId }), secondTab);
      const viewerOpened = context.waitForEvent('page', { predicate: (p) => p.url().includes('/viewer/viewer.html'), timeout: 60_000 }).catch(() => null);
      await running;
      const viewer = await viewerOpened;
      await viewer?.close();
      return { ok: /déjà en cours/.test(title), detail: title };
    } finally {
      for (const p of context.pages()) if (p.url().includes('/popup/popup.html')) await p.close();
      await second.close();
      await page.close();
    }
  });

  await test('relecture : Annuler après la mort du service worker, la fenêtre ne reste pas figée', async () => {
    await untilIdle(sw);
    await sw.evaluate(() => chrome.storage.session.set({ capturing: { tabId: 1, done: 1, total: 4 } }));
    const popup = await context.newPage();
    try {
      await popup.goto(`chrome-extension://${new URL(sw.url()).host}/popup/popup.html`);
      await popup.waitForSelector('#cancel:not([hidden])', { timeout: 5000 });
      await popup.click('#cancel');
      await popup.waitForFunction(() => document.getElementById('status').hidden, null, { timeout: 5000 });
      const state = await popup.evaluate(() => ({ cancel: document.getElementById('cancel').hidden, enabled: !document.getElementById('full').disabled }));
      return { ok: state.cancel && state.enabled, detail: JSON.stringify(state) };
    } finally {
      await sw.evaluate(() => chrome.storage.session.remove('capturing'));
      await popup.close();
    }
  });

  await test('relecture : une panne inconnue dit quoi faire', async () => {
    const message = await sw.evaluate(async () => (await self.explainForTest(new Error('Image readback failed'))).message);
    return { ok: /Image readback failed/.test(message) && /Relance/.test(message), detail: message };
  });
}

async function main() {
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(WORK, { recursive: true });
  const extension = await prepareExtension(WORK);
  const server = await serve(path.join(HERE, 'pages'));
  const base = `http://127.0.0.1:${server.address().port}`;
  // Un navigateur par groupe : l'essai d'endormissement remplace le service worker.
  const groups = { calque: groupCalque, region: groupRegion, barres: groupBarres, limites: groupLimites, relecture: groupRelecture };
  try {
    for (const [name, group] of Object.entries(groups)) {
      if (ONLY && ONLY !== name) continue;
      const context = await launch(extension, `profile-${name}`, WORK, name === 'barres' ? { ignoreDefaultArgs: ['--hide-scrollbars'] } : {});
      try {
        const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
        await group(context, sw, base);
      } finally {
        await context.close();
      }
    }
  } finally {
    server.close();
  }
  const failed = results.filter((result) => !result.ok).length;
  console.log(`\n${results.length - failed}/${results.length} vérifications réussies`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
