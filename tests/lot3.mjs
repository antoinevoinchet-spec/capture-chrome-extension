// Tests du lot 3 : capturer un bloc ou une zone. Le calque de sélection, le rectangle choisi, les cas limites.
// Même Chromium et même extension que les autres suites (écran ×2).
// Usage : node lot3.mjs <dossier de sortie> [calque|region|limites] [motif]

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

  await test('calque : retiré si l’onglet se recharge', () =>
    withPick(context, sw, tall, 'block', async ({ page }) => {
      await page.reload();
      await sleep(200);
      return { ok: (await hostCount(page)) === 0, detail: 'après rechargement' };
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

async function main() {
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(WORK, { recursive: true });
  const extension = await prepareExtension(WORK);
  const server = await serve(path.join(HERE, 'pages'));
  const base = `http://127.0.0.1:${server.address().port}`;
  // Un navigateur par groupe : l'essai d'endormissement remplace le service worker.
  const groups = { calque: groupCalque };
  try {
    for (const [name, group] of Object.entries(groups)) {
      if (ONLY && ONLY !== name) continue;
      const context = await launch(extension, `profile-${name}`, WORK);
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
