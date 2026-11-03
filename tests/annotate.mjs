// Test de l'éditeur d'annotation : stockage des annotations, rendu dans les exports et les aperçus, ouverture de l'éditeur, outils de dessin, retouche, historique, finitions (clavier, fluidité, clair et sombre, hors ligne).
// Même Chromium et même extension que e2e.mjs (écran ×2), mais bien plus rapide.
// Usage : node annotate.mjs <dossier de sortie> [storage|rendering|editor|tools|retouch|history|finish] [motif]
// Le motif (expression régulière) ne garde que les vérifications dont le nom y correspond.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EXTENSION, capture, check, copyAndRead, extensionPage, launch, openTab, prepareExtension, results, seedCapture, serve } from './lib.mjs';

const WORK = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, 'out-annotate'));
// Troisième argument facultatif : ne lancer qu'un groupe de vérifications (storage, rendering, editor, tools, retouch, history ou finish).
const ONLY = process.argv[3];
// Quatrième argument facultatif : ne lancer que les vérifications dont le nom correspond à ce motif.
const NAMED = process.argv[4] ? new RegExp(process.argv[4], 'i') : null;

// Couleurs d'annotation (voir annotate/shapes.js).
const RED = [224, 49, 49];
const BLUE = [25, 113, 194];
const GREEN = [47, 158, 68];
const YELLOW = [244, 197, 66];
// Encre (la couleur « noir » des annotations) : liseré du texte jaune.
const INK = [21, 33, 29];
// Bande de la capture synthétique (voir SEED_LAYOUT dans lib.mjs).
const MAGENTA = [255, 0, 170];
// Fond de masque utilisé par les tests : gris moyen, que le blanc de la capture ne peut pas imiter.
const MASK_FILL = '#606060';

// Une couleur à `alpha` d'opacité sur le blanc (le surligneur).
const onWhite = (rgb, alpha) => rgb.map((c) => Math.round(c * alpha + 255 * (1 - alpha)));

const RECT = { id: 'a1', type: 'rect', color: 'red', size: 'm', x: 10, y: 20, width: 300, height: 80 };
const ARROW = { id: 'a2', type: 'arrow', color: 'blue', size: 's', points: [1, 2, 3.5, 4] };

// Un test qui plante (fonction absente, erreur dans la page) compte comme un échec sans arrêter la suite.
async function test(name, run) {
  if (NAMED && !NAMED.test(name)) return;
  try {
    const { ok, detail } = await run();
    check(name, ok, detail);
  } catch (err) {
    check(name, false, err.message.split('\n')[0]);
  }
}

// Repart d'une base vide : db.js ferme sa connexion après chaque appel, rien ne doit la retenir.
function resetDb(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.deleteDatabase('capture');
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('base retenue par une connexion ouverte'));
      }),
  );
}

async function testStorage(context) {
  console.log('\n— Stockage des annotations (IndexedDB, version 2)');
  const page = await extensionPage(context, 'popup/popup.html');
  try {
    await test('base migrée sans perte', async () => {
      await resetDb(page);
      const got = await page.evaluate(async () => {
        // Base telle que l'extension l'avait avant les annotations : version 1, un seul magasin.
        const old = await new Promise((resolve, reject) => {
          const req = indexedDB.open('capture', 1);
          req.onupgradeneeded = () => req.result.createObjectStore('captures', { keyPath: 'id' });
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        await new Promise((resolve, reject) => {
          const tx = old.transaction('captures', 'readwrite');
          tx.objectStore('captures').put({ id: 'ancienne', title: 'Avant', createdAt: 1, slices: [{ y: 0, blob: new Blob(['pixels']) }] });
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
        old.close();

        // Le premier appel de db.js (version 2) migre la base.
        const db = await import(chrome.runtime.getURL('lib/db.js'));
        const record = await db.getCapture('ancienne');
        const annotations = await db.getAnnotations('ancienne');
        const upgraded = await new Promise((resolve, reject) => {
          const req = indexedDB.open('capture');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        const state = { version: upgraded.version, stores: [...upgraded.objectStoreNames].sort() };
        upgraded.close();
        return {
          title: record?.title,
          pixels: await record?.slices[0].blob.text(),
          count: (await db.listCaptures()).length,
          annotations,
          ...state,
        };
      });
      const ok =
        got.title === 'Avant' &&
        got.pixels === 'pixels' &&
        got.count === 1 &&
        got.annotations.length === 0 &&
        got.version === 2 &&
        got.stores.join() === 'annotations,captures';
      return { ok, detail: JSON.stringify(got) };
    });

    await test('annotations relues à l’identique', async () => {
      await resetDb(page);
      const id = await seedCapture(page, { heightPoints: 900 });
      const got = await page.evaluate(
        async ({ id, rect, arrow }) => {
          const { getAnnotations, saveAnnotations } = await import(chrome.runtime.getURL('lib/db.js'));
          await saveAnnotations(id, [rect, arrow]);
          const both = await getAnnotations(id);
          // Enregistrer remplace la liste entière, sans la fusionner avec l'ancienne.
          await saveAnnotations(id, [arrow]);
          return { both, replaced: await getAnnotations(id), unknown: await getAnnotations('inconnue') };
        },
        { id, rect: RECT, arrow: ARROW },
      );
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const ok = same(got.both, [RECT, ARROW]) && same(got.replaced, [ARROW]) && same(got.unknown, []);
      return { ok, detail: JSON.stringify(got).slice(0, 200) };
    });

    await test('liste vide = capture ordinaire', async () => {
      await resetDb(page);
      const id = await seedCapture(page, { heightPoints: 900 });
      const got = await page.evaluate(async ({ id, rect }) => {
        const { getAnnotations, listAnnotatedIds, saveAnnotations } = await import(chrome.runtime.getURL('lib/db.js'));
        await saveAnnotations(id, [rect]);
        const before = (await listAnnotatedIds()).has(id);
        await saveAnnotations(id, []);
        return { before, after: (await listAnnotatedIds()).has(id), items: await getAnnotations(id) };
      }, { id, rect: RECT });
      return { ok: got.before && !got.after && got.items.length === 0, detail: JSON.stringify(got) };
    });

    await test('suppression en cascade', async () => {
      await resetDb(page);
      const first = await seedCapture(page, { heightPoints: 900 });
      const second = await seedCapture(page, { heightPoints: 900 });
      const got = await page.evaluate(
        async ({ first, second, rect, arrow }) => {
          const db = await import(chrome.runtime.getURL('lib/db.js'));
          await db.saveAnnotations(first, [rect]);
          await db.saveAnnotations(second, [arrow]);
          await db.deleteCapture(first);
          return {
            capture: (await db.getCapture(first)) ?? null,
            annotations: await db.getAnnotations(first),
            annotated: [...(await db.listAnnotatedIds())],
            otherKept: JSON.stringify(await db.getAnnotations(second)) === JSON.stringify([arrow]),
          };
        },
        { first, second, rect: RECT, arrow: ARROW },
      );
      const ok = got.capture === null && got.annotations.length === 0 && got.annotated.join() === second && got.otherKept;
      return { ok, detail: JSON.stringify(got) };
    });

    await test('nettoyage : captures annotées épargnées', async () => {
      await resetDb(page);
      const base = Date.now() - 100_000;
      const ids = [];
      for (let i = 0; i < 17; i++) ids.push(await seedCapture(page, { heightPoints: 900, createdAt: base + i }));
      const left = await page.evaluate(
        async ({ oldest, rect }) => {
          const { listCaptures, pruneCaptures, saveAnnotations } = await import(chrome.runtime.getURL('lib/db.js'));
          await saveAnnotations(oldest, [rect]);
          await pruneCaptures(15);
          return (await listCaptures()).map((c) => c.id);
        },
        { oldest: ids[0], rect: RECT },
      );
      // Reste : l'annotée (la plus ancienne) et les 15 non annotées les plus récentes ; la 2e plus ancienne est partie.
      const expected = [...ids.slice(2), ids[0]].sort();
      return { ok: left.length === 16 && [...left].sort().join() === expected.join(), detail: `${left.length} captures gardées` };
    });

    await test('enregistrement refusé : les annotations précédentes restent', async () => {
      await resetDb(page);
      const id = await seedCapture(page, { heightPoints: 900 });
      const got = await page.evaluate(async ({ id, rect }) => {
        const { getAnnotations, saveAnnotations } = await import(chrome.runtime.getURL('lib/db.js'));
        await saveAnnotations(id, [rect]);
        // Une fonction ne peut pas être stockée : l'écriture échoue, sans toucher à ce qui existe.
        const error = await saveAnnotations(id, [{ id: 'x', run() {} }]).then(
          () => null,
          (err) => err.name,
        );
        return { error, kept: await getAnnotations(id) };
      }, { id, rect: RECT });
      return { ok: got.error === 'DataCloneError' && JSON.stringify(got.kept) === JSON.stringify([RECT]), detail: JSON.stringify(got).slice(0, 200) };
    });

    await test('capture disparue : aucune annotation écrite, l’erreur le dit', async () => {
      await resetDb(page);
      const got = await page.evaluate(async (rect) => {
        const { getCapture, listAnnotatedIds, saveAnnotations } = await import(chrome.runtime.getURL('lib/db.js'));
        const error = await saveAnnotations('disparue', [rect]).then(
          () => null,
          (err) => err.name,
        );
        // Vider la liste d'une capture disparue n'a rien à signaler.
        const emptied = await saveAnnotations('disparue', []).then(
          () => null,
          (err) => err.name,
        );
        return { error, emptied, annotated: [...(await listAnnotatedIds())], capture: (await getCapture('disparue')) ?? null };
      }, RECT);
      return { ok: got.error === 'CaptureGone' && got.emptied === null && got.annotated.length === 0 && got.capture === null, detail: JSON.stringify(got) };
    });

    await test('nettoyage : les captures affichées sont épargnées', async () => {
      await resetDb(page);
      const base = Date.now() - 100_000;
      const ids = [];
      for (let i = 0; i < 4; i++) ids.push(await seedCapture(page, { heightPoints: 900, createdAt: base + i }));
      const left = await page.evaluate(async (spared) => {
        const { listCaptures, pruneCaptures } = await import(chrome.runtime.getURL('lib/db.js'));
        await pruneCaptures(1, spared);
        return (await listCaptures()).map((c) => c.id);
      }, [ids[0]]);
      // Garde la plus récente et l'épargnée ; les deux autres partent.
      return { ok: left.join() === [ids[3], ids[0]].join(), detail: `${left.length} captures gardées` };
    });
  } finally {
    await page.close();
  }
}

// ---- Rendu des annotations (tâche 2) ----

// Fonctions exécutées dans la page : recopiées en texte par inImage, donc sans variable extérieure.
// Chacune reçoit le contexte 2D de l'image lue, sa taille et un argument.

// Pour chaque sonde { x, y, w, h, rgb, tol } : un pixel du rectangle est-il de cette couleur ?
function colorProbes(ctx, size, probes) {
  return probes.map(({ x, y, w = 1, h = 1, rgb, tol = 40 }) => {
    const { data } = ctx.getImageData(x, y, w, h);
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i] - rgb[0]) <= tol && Math.abs(data[i + 1] - rgb[1]) <= tol && Math.abs(data[i + 2] - rgb[2]) <= tol) return true;
    }
    return false;
  });
}

// Nombre de pixels « jaunes » (de l'emoji 🙂) dans chaque rectangle { x, y, w, h } : rouge et vert élevés, et bien plus de vert que de bleu.
// Le texte rouge et ses bords adoucis, où le vert et le bleu vont de pair, n'en font pas partie.
function yellowPixels(ctx, size, rects) {
  return rects.map(({ x, y, w, h }) => {
    const { data } = ctx.getImageData(x, y, w, h);
    let yellow = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i + 1] > 140 && data[i + 1] - data[i + 2] > 60) yellow++;
    return yellow;
  });
}

// Rectangles de masques : chaque bloc de `block` px (compté depuis le haut gauche) est-il d'une seule couleur,
// combien de couleurs en tout, et les rectangles sont-ils identiques entre eux, pixel à pixel ?
function blockReport(ctx, size, { rects, block }) {
  const regions = rects.map(({ x, y, w, h }) => ctx.getImageData(x, y, w, h));
  const colors = new Set();
  let uniform = true;
  rects.forEach(({ w, h }, n) => {
    const { data } = regions[n];
    for (let by = 0; by < h; by += block) {
      for (let bx = 0; bx < w; bx += block) {
        const first = (by * w + bx) * 4;
        colors.add(`${data[first]},${data[first + 1]},${data[first + 2]}`);
        for (let y = by; y < Math.min(h, by + block); y++) {
          for (let x = bx; x < Math.min(w, bx + block); x++) {
            const i = (y * w + x) * 4;
            if (data[i] !== data[first] || data[i + 1] !== data[first + 1] || data[i + 2] !== data[first + 2]) uniform = false;
          }
        }
      }
    }
  });
  const [model] = regions;
  const same = regions.every((region) => region.data.every((value, i) => value === model.data[i]));
  return { uniform, colors: colors.size, same };
}

// Bords nets d'un masque : tout le rectangle est peint (rien de blanc dedans) et le liseré de 1 px autour reste blanc.
function sharpEdges(ctx, size, { x, y, w, h }) {
  const inside = ctx.getImageData(x, y, w, h).data;
  let unpainted = 0;
  for (let i = 0; i < inside.length; i += 4) if (inside[i] > 200) unpainted++;
  const outer = ctx.getImageData(x - 1, y - 1, w + 2, h + 2).data;
  let leaked = 0;
  for (let row = 0; row < h + 2; row++) {
    for (let col = 0; col < w + 2; col++) {
      if (row > 0 && row < h + 1 && col > 0 && col < w + 1) continue;
      const i = (row * (w + 2) + col) * 4;
      if (outer[i] !== 255 || outer[i + 1] !== 255 || outer[i + 2] !== 255) leaked++;
    }
  }
  const first = ctx.getImageData(x, y, 1, 1).data;
  return { unpainted, leaked, corner: [first[0], first[1], first[2]] };
}

// Longueurs des suites de pixels de même couleur le long d'une ligne (h = 1) ou d'une colonne (w = 1).
function runLengths(ctx, size, { x, y, w, h }) {
  const { data } = ctx.getImageData(x, y, w, h);
  const lengths = [];
  let run = 1;
  for (let i = 1; i < w * h; i++) {
    const same = data[i * 4] === data[i * 4 - 4] && data[i * 4 + 1] === data[i * 4 - 3] && data[i * 4 + 2] === data[i * 4 - 2];
    if (same) run++;
    else {
      lengths.push(run);
      run = 1;
    }
  }
  lengths.push(run);
  return lengths;
}

// Nombre de lignes de la colonne x, hors 2 px de chaque bord, qui ne sont pas de la couleur `rgb`.
function columnGaps(ctx, size, { x, rgb, tol = 40 }) {
  const { data } = ctx.getImageData(x, 0, 1, size.height);
  let gaps = 0;
  for (let row = 2; row < size.height - 2; row++) {
    const i = row * 4;
    if (Math.abs(data[i] - rgb[0]) > tol || Math.abs(data[i + 1] - rgb[1]) > tol || Math.abs(data[i + 2] - rgb[2]) > tol) gaps++;
  }
  return gaps;
}

// Nombre de pixels sombres (les trois canaux sous 100) dans chaque rectangle { x, y, w, h }.
function darkPixels(ctx, size, rects) {
  return rects.map(({ x, y, w, h }) => {
    const { data } = ctx.getImageData(x, y, w, h);
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] < 100 && data[i + 1] < 100 && data[i + 2] < 100) dark++;
    return dark;
  });
}

// Exécutée dans la page (via viewer.evaluate), sur l'aperçu réduit de l'image 1 : pour des rectangles { x, y, w, h }
// en pixels de la capture, valeurs minimale et maximale à l'intérieur (hors 3 px de bord, où l'aperçu se fond avec la page)
// et écart maximal avec le premier rectangle, pixel à pixel, bords compris.
function previewReport({ rects, width }) {
  const canvas = document.querySelector('figure.part canvas');
  const ratio = canvas.width / width;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const regions = rects.map(({ x, y, w, h }) => {
    const cols = Math.ceil(w * ratio) + 1;
    const rows = Math.ceil(h * ratio) + 1;
    return { cols, rows, data: ctx.getImageData(Math.floor(x * ratio), Math.floor(y * ratio), cols, rows).data };
  });
  let low = 255;
  let high = 0;
  let spread = 0;
  for (const { cols, rows, data } of regions) {
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        for (let channel = 0; channel < 3; channel++) {
          const i = (row * cols + col) * 4 + channel;
          if (row >= 3 && row < rows - 3 && col >= 3 && col < cols - 3) {
            low = Math.min(low, data[i]);
            high = Math.max(high, data[i]);
          }
          spread = Math.max(spread, Math.abs(data[i] - regions[0].data[i]));
        }
      }
    }
  }
  return { low, high, spread };
}

// Lit l'image `source` (le presse-papiers ou un fichier) dans la page du viewer et y exécute fn(ctx, size, arg).
async function inImage(viewer, source, fn, arg) {
  const bytes = source === 'clipboard' ? null : (await fs.readFile(source)).toString('base64');
  return viewer.evaluate(`(async (bytes, arg) => {
    const blob = bytes === null
      ? await (await navigator.clipboard.read())[0].getType('image/png')
      : new Blob([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))]);
    const bitmap = await createImageBitmap(blob);
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    return (${fn})(ctx, { width: bitmap.width, height: bitmap.height }, arg);
  })(${JSON.stringify(bytes)}, ${JSON.stringify(arg)})`);
}

// Copie par `trigger`, puis analyse de l'image copiée.
async function copyAndAnalyze(viewer, trigger, fn, arg) {
  const copied = await copyAndRead(viewer, trigger);
  return { ...copied, result: await inImage(viewer, 'clipboard', fn, arg) };
}

const copyButton = (viewer, index) => viewer.locator('figure.part').nth(index).getByRole('button', { name: 'Copier', exact: true });

// Hauteur et haut de chaque image, lus dans les légendes de la page.
async function partLayout(viewer) {
  const sizes = await viewer.locator('figure.part .part-size').allInnerTexts();
  const heights = sizes.map((size) => Number(size.split('×')[1].replace(/\D/g, '')));
  const tops = heights.map((_, i) => heights.slice(0, i).reduce((sum, h) => sum + h, 0));
  return { heights, tops };
}

async function saveItems(page, id, items) {
  await page.evaluate(
    async ({ id, items }) => {
      const { saveAnnotations } = await import(chrome.runtime.getURL('lib/db.js'));
      await saveAnnotations(id, items);
    },
    { id, items },
  );
}

// Ouvre la page de résultats sur la capture `id` et attend la fin de la mise en page ; toute erreur de page fait échouer.
async function withViewer(context, id, run) {
  const viewer = await extensionPage(context, `viewer/viewer.html?id=${id}`);
  const errors = [];
  viewer.on('pageerror', (err) => errors.push(err.message));
  try {
    await viewer.bringToFront();
    await viewer.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
    const outcome = await run(viewer);
    if (errors.length) throw new Error(`erreur dans la page : ${errors[0]}`);
    return outcome;
  } finally {
    await viewer.close();
  }
}

// Annote la capture, ouvre la page de résultats et exécute `run`.
async function annotated(context, home, id, items, run) {
  await saveItems(home, id, items);
  return withViewer(context, id, run);
}

// Fichiers enregistrés par l'extension, dans l'ordre des téléchargements, une fois terminés.
async function savedFiles(context, count) {
  const sw = context.serviceWorkers()[0];
  for (let attempt = 0; attempt < 150; attempt++) {
    const downloads = await sw.evaluate(async () =>
      (await chrome.downloads.search({ orderBy: ['startTime'] })).map((d) => ({ file: d.filename, done: d.state === 'complete' })),
    );
    if (downloads.length >= count && downloads.every((d) => d.done)) return downloads.map((d) => d.file);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('téléchargements incomplets');
}

// Clique sur un bouton de téléchargement et rend les `count` fichiers enregistrés.
async function download(context, viewer, trigger, count) {
  await context.serviceWorkers()[0].evaluate(() => chrome.downloads.erase({}));
  await viewer.evaluate(() => (document.getElementById('toast').hidden = true));
  await trigger.click();
  await viewer.waitForFunction(() => /enregistr|impossible/.test(document.getElementById('toast').textContent), null, { timeout: 120_000 });
  return savedFiles(context, count);
}

const sha256 = async (file) => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');

// Une annotation de chaque type (hors masque) à des endroits connus de l'image 1, et une sonde par tracé.
const EACH_TYPE = {
  items: [
    { id: 't1', type: 'arrow', color: 'blue', size: 'm', points: [400, 400, 1000, 400] },
    { id: 't2', type: 'rect', color: 'red', size: 'm', x: 300, y: 600, width: 700, height: 300 },
    { id: 't3', type: 'highlight', color: 'yellow', size: 'm', x: 300, y: 1000, width: 700, height: 200 },
    { id: 't4', type: 'text', color: 'green', size: 'l', x: 400, y: 1300, text: 'Bonjour' },
    { id: 't5', type: 'badge', color: 'blue', size: 'l', x: 1400, y: 1500 },
    { id: 't6', type: 'pen', color: 'red', size: 'm', points: [1500, 700, 1700, 800, 1900, 700, 2100, 800] },
  ],
  probes: [
    { name: 'flèche', x: 690, y: 396, w: 20, h: 8, rgb: BLUE },
    { name: 'rectangle', x: 296, y: 700, w: 8, h: 20, rgb: RED },
    { name: 'surligneur', x: 700, y: 1100, w: 10, h: 10, rgb: onWhite(YELLOW, 0.4) },
    { name: 'texte', x: 400, y: 1300, w: 300, h: 120, rgb: GREEN },
    { name: 'pastille', x: 1367, y: 1497, w: 6, h: 6, rgb: BLUE },
    { name: 'crayon', x: 1696, y: 796, w: 8, h: 8, rgb: RED },
  ],
};

async function testRendering(context) {
  console.log('\n— Rendu des annotations (exports, aperçus, coupes)');
  const home = await extensionPage(context, 'popup/popup.html');
  try {
    await resetDb(home);
    // 12 000 points à ×2 = 24 000 px : trois images de 8 000 px avec le découpage « Moyen ».
    const big = await seedCapture(home, { heightPoints: 12000 });
    // 11 000 points = 22 000 px : trois images dont les coupes peuvent bouger (avec 24 000 px, elles seraient imposées à 8 000 et 16 000).
    const loose = await seedCapture(home, { heightPoints: 11000 });

    await test('chaque type apparaît à l’export', () =>
      annotated(context, home, big, EACH_TYPE.items, async (viewer) => {
        const { result } = await copyAndAnalyze(viewer, copyButton(viewer, 0), colorProbes, EACH_TYPE.probes);
        const missing = EACH_TYPE.probes.filter((_, i) => !result[i]).map((probe) => probe.name);
        return { ok: missing.length === 0, detail: missing.length ? `absents : ${missing.join(', ')}` : '6 types présents' };
      }));

    await test('masque : blocs unis et contenu caché sans influence', () => {
      // Deux lignes de texte différentes (« Ligne 5 » et « Ligne 6 »), entourées de blanc, masquées par deux rectangles de même taille.
      const rects = [
        { x: 60, y: 620, w: 360, h: 80 },
        { x: 60, y: 740, w: 360, h: 80 },
      ];
      const masks = rects.map((r, i) => ({ id: `m${i}`, type: 'mask', color: 'red', size: 'm', x: r.x, y: r.y, width: r.w, height: r.h, fill: '#ffffff' }));
      return annotated(context, home, big, masks, async (viewer) => {
        const { result } = await copyAndAnalyze(viewer, copyButton(viewer, 0), blockReport, { rects, block: 20 });
        // Fond blanc : les cinq nuances du motif doivent rester distinctes (une teinte blanche ne s'éclaircit pas).
        return { ok: result.uniform && result.same && result.colors === 5, detail: JSON.stringify(result) };
      });
    });

    await test('export en pleine résolution', async () => {
      const sizes = {};
      for (const [label, items] of [['sans annotations', []], ['avec annotations', EACH_TYPE.items]]) {
        sizes[label] = await annotated(context, home, big, items, async (viewer) => {
          const found = [];
          for (let i = 0; i < 3; i++) found.push((await copyAndRead(viewer, copyButton(viewer, i))).size);
          return found.map((size) => size.split(' × ').map(Number));
        });
      }
      const good = Object.values(sizes).every((found) => found.length === 3 && found.every(([w]) => w === 2560) && found.reduce((sum, [, h]) => sum + h, 0) === 24000);
      return { ok: good, detail: JSON.stringify(sizes) };
    });

    await test('tous les chemins d’export sont annotés', async () => {
      // Un rectangle sur l'image 2 ; chaque chemin d'export doit en porter la couleur.
      const rect = { id: 'p1', type: 'rect', color: 'red', size: 'l', x: 1200, y: 11000, width: 800, height: 300 };
      return annotated(context, home, big, [rect], async (viewer) => {
        const { tops } = await partLayout(viewer);
        const probe = [{ x: 1196, y: rect.y + 150 - tops[1] - 4, w: 8, h: 8, rgb: RED }];
        const found = {};
        const second = viewer.locator('figure.part').nth(1);

        found['Copier de l’image'] = (await copyAndAnalyze(viewer, copyButton(viewer, 1), colorProbes, probe)).result[0];

        await viewer.evaluate(() => document.querySelectorAll('figure.part')[1].scrollIntoView({ block: 'start' }));
        await viewer.waitForFunction(() => /image 2$/.test(document.getElementById('copy-current').textContent.trim()), null, { timeout: 5000 });
        found['Copier l’image 2 (en-tête)'] = (await copyAndAnalyze(viewer, viewer.locator('#copy-current'), colorProbes, probe)).result[0];
        found['⌘C'] = (await copyAndAnalyze(viewer, { click: () => viewer.keyboard.press('Meta+c') }, colorProbes, probe)).result[0];

        await second.locator('canvas').click({ button: 'right' });
        const viaMenu = viewer.getByRole('menuitem', { name: 'Copier l’image en pleine résolution' });
        found['clic droit'] = (await copyAndAnalyze(viewer, viaMenu, colorProbes, probe)).result[0];

        const [single] = await download(context, viewer, second.getByRole('button', { name: 'Télécharger' }), 1);
        found['Télécharger'] = (await inImage(viewer, single, colorProbes, probe))[0];

        const files = await download(context, viewer, viewer.locator('#download-all'), 3);
        found['Tout télécharger'] = (await inImage(viewer, files[1], colorProbes, probe))[0];

        const missing = Object.entries(found).filter(([, ok]) => !ok).map(([name]) => name);
        return { ok: missing.length === 0, detail: missing.length ? `sans annotation : ${missing.join(', ')}` : `${Object.keys(found).length} chemins` };
      });
    });

    await test('aperçu annoté', () => {
      const note = { id: 'v1', type: 'highlight', color: 'red', size: 'm', x: 1000, y: 1000, width: 600, height: 400 };
      return annotated(context, home, big, [note], async (viewer) => {
        // Centre du surligneur (1300, 1200) dans l'aperçu de l'image 1, réduit à la largeur du canvas.
        const pixel = await viewer.evaluate(([cx, cy]) => {
          const canvas = document.querySelector('figure.part canvas');
          const ratio = canvas.width / 2560;
          return [...canvas.getContext('2d').getImageData(Math.round(cx * ratio), Math.round(cy * ratio), 1, 1).data];
        }, [1300, 1200]);
        return { ok: pixel[0] - pixel[1] > 50 && pixel[0] - pixel[2] > 50, detail: `pixel ${pixel.slice(0, 3)}` };
      });
    });

    await test('coupe qui évite une annotation', async () => {
      const plain = await annotated(context, home, loose, [], partLayout);
      const cut = plain.tops[1];
      // Un rectangle de 300 px de haut centré sur la première coupe.
      const rect = { id: 'c1', type: 'rect', color: 'red', size: 'm', x: 1200, y: cut - 150, width: 800, height: 300 };
      const layout = await annotated(context, home, loose, [rect], partLayout);
      const cuts = layout.tops.slice(1);
      // Le trait de 8 px déborde de 4 px de chaque côté.
      const crossing = cuts.filter((c) => c > rect.y - 4 && c < rect.y + rect.height + 4);
      const ok = crossing.length === 0 && cuts.length === plain.tops.length - 1 && layout.heights.every((h) => h <= 8000) && cuts[0] !== cut;
      return { ok, detail: `coupe ${cut} → ${cuts.join(', ')} (rectangle ${rect.y}–${rect.y + rect.height})` };
    });

    await test('annotation à cheval sur trois parties', async () => {
      // Un tracé vertical de la première à la dernière ligne de la capture : aucune ligne libre, les coupes restent celles de l'original.
      const points = [];
      for (let y = 0; y <= 22000; y += 2000) points.push(600, y);
      const pen = { id: 'l1', type: 'pen', color: 'red', size: 'm', points };
      const plain = await annotated(context, home, loose, [], partLayout);
      return annotated(context, home, loose, [pen], async (viewer) => {
        const layout = await partLayout(viewer);
        const gaps = [];
        for (let i = 0; i < layout.heights.length; i++) {
          gaps.push((await copyAndAnalyze(viewer, copyButton(viewer, i), columnGaps, { x: 600, rgb: RED })).result);
        }
        const sameCuts = JSON.stringify(layout.tops) === JSON.stringify(plain.tops);
        return { ok: gaps.length === 3 && gaps.every((g) => g === 0) && sameCuts, detail: `lignes sans rouge par image : ${gaps.join(', ')} ; coupes ${layout.tops.join(', ')}` };
      });
    });

    await test('liste vide = parties identiques à l’original', async () => {
      // A n'a jamais été annotée ; B a reçu une liste vide. Les fichiers doivent être identiques entre eux
      // et à ceux du découpeur sans aucune surimpression.
      const never = await seedCapture(home, { heightPoints: 6000 });
      const emptied = await seedCapture(home, { heightPoints: 6000 });
      await saveItems(home, emptied, []);
      const exportHashes = (id) =>
        withViewer(context, id, async (viewer) => {
          const files = await download(context, viewer, viewer.locator('#download-all'), 2);
          const plain = await viewer.evaluate(async (id) => {
            const { getCapture } = await import(chrome.runtime.getURL('lib/db.js'));
            const { Stitcher } = await import(chrome.runtime.getURL('viewer/stitcher.js'));
            const stitcher = new Stitcher(await getCapture(id));
            const hashes = [];
            for (const part of await stitcher.planParts(8000)) {
              const bytes = await (await stitcher.renderPart(part, 'image/png')).arrayBuffer();
              hashes.push([...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join(''));
            }
            return hashes;
          }, id);
          return { files: await Promise.all(files.map(sha256)), plain };
        });
      const a = await exportHashes(never);
      const b = await exportHashes(emptied);
      const ok = a.files.length === 2 && a.files.join() === b.files.join() && a.files.join() === a.plain.join();
      return { ok, detail: `${a.files.length} parties` };
    });

    await test('découpage changé : annotation au même endroit de la page', async () => {
      const rect = { id: 'd1', type: 'rect', color: 'red', size: 'l', x: 1200, y: 5000, width: 800, height: 300 };
      const pageY = rect.y + 150;
      return annotated(context, home, big, [rect], async (viewer) => {
        const found = {};
        try {
          for (const label of ['Moyen', 'Court']) {
            await viewer.getByRole('button', { name: label, exact: true }).click();
            await viewer.waitForSelector('body[data-ready="true"]');
            const { tops, heights } = await partLayout(viewer);
            const index = tops.findIndex((top, i) => pageY >= top && pageY < top + heights[i]);
            const probe = [{ x: 1196, y: pageY - tops[index] - 4, w: 8, h: 8, rgb: RED }];
            found[`${label} (${tops.length} images, image ${index + 1})`] = (await copyAndAnalyze(viewer, copyButton(viewer, index), colorProbes, probe)).result[0];
          }
        } finally {
          // Le choix de découpage est mémorisé par l'extension : les tests suivants repartent du découpage « Moyen ».
          await viewer.getByRole('button', { name: 'Moyen', exact: true }).click();
          await viewer.waitForSelector('body[data-ready="true"]');
        }
        return { ok: Object.values(found).every(Boolean), detail: JSON.stringify(found) };
      });
    });

    await test('aucun script distant, Konva 10.3.0 avec sa licence', async () => {
      const remote = [];
      for (const entry of await fs.readdir(EXTENSION, { recursive: true })) {
        if (!entry.endsWith('.html')) continue;
        if (/<script\b[^>]*https?:/i.test(await fs.readFile(path.join(EXTENSION, entry), 'utf8'))) remote.push(entry);
      }
      const license = await fs.stat(path.join(EXTENSION, 'vendor/konva-LICENSE.txt')).then(() => true, () => false);
      const konva = await fs.readFile(path.join(EXTENSION, 'vendor/konva.min.js'), 'utf8');
      return { ok: remote.length === 0 && license && konva.includes('v10.3.0'), detail: `scripts distants : ${remote.join(', ') || 'aucun'}` };
    });

    await test('masque au pixel près, même à coordonnées fractionnaires', () => {
      const mask = { id: 'f1', type: 'mask', color: 'red', size: 'm', x: 1000.4, y: 200.6, width: 301.3, height: 80.7, fill: MASK_FILL };
      // Arrondi vers l'extérieur : de (1000, 200) à (1302, 282) exclus.
      const region = { x: 1000, y: 200, w: 302, h: 82 };
      return annotated(context, home, big, [mask], async (viewer) => {
        const blocks = await copyAndAnalyze(viewer, copyButton(viewer, 0), blockReport, { rects: [region], block: 20 });
        const edges = await inImage(viewer, 'clipboard', sharpEdges, region);
        // Premier bloc : la teinte de base elle-même (96).
        const corner = edges.corner.every((c) => Math.abs(c - 96) <= 2);
        const ok = blocks.result.uniform && edges.unpainted === 0 && edges.leaked === 0 && corner;
        return { ok, detail: `${JSON.stringify(blocks.result)} ; hors bord ${edges.leaked}, non peints ${edges.unpainted}, coin ${edges.corner}` };
      });
    });

    await test('capture en ×1 : blocs d’au moins 16 px', async () => {
      const small = await seedCapture(home, { heightPoints: 3000, scale: 1 });
      const mask = { id: 'x1', type: 'mask', color: 'red', size: 'm', x: 600, y: 300, width: 200, height: 100, fill: MASK_FILL };
      return annotated(context, home, small, [mask], async (viewer) => {
        const { result: row } = await copyAndAnalyze(viewer, copyButton(viewer, 0), runLengths, { x: 600, y: 310, w: 200, h: 1 });
        const column = await inImage(viewer, 'clipboard', runLengths, { x: 610, y: 300, w: 1, h: 100 });
        const ok = JSON.stringify(row) === JSON.stringify([...Array(12).fill(16), 8]) && JSON.stringify(column) === JSON.stringify([...Array(6).fill(16), 4]);
        return { ok, detail: `ligne ${row.join(',')} ; colonne ${column.join(',')}` };
      });
    });

    await test('petit masque = un seul bloc', () => {
      const mask = { id: 's1', type: 'mask', color: 'red', size: 'm', x: 1000, y: 300, width: 10, height: 10, fill: MASK_FILL };
      const region = { x: 1000, y: 300, w: 10, h: 10 };
      return annotated(context, home, big, [mask], async (viewer) => {
        const { result } = await copyAndAnalyze(viewer, copyButton(viewer, 0), blockReport, { rects: [region], block: 10 });
        const edges = await inImage(viewer, 'clipboard', sharpEdges, region);
        return { ok: result.uniform && result.colors === 1 && edges.unpainted === 0 && edges.leaked === 0, detail: JSON.stringify({ ...result, leaked: edges.leaked }) };
      });
    });

    await test('flèche sur un masque reste visible', () => {
      // La flèche est créée avant le masque qui la recouvre : le masque ne doit pas la cacher.
      const items = [
        { id: 'w1', type: 'arrow', color: 'blue', size: 'm', points: [1000, 400, 1600, 400] },
        { id: 'w2', type: 'mask', color: 'red', size: 'm', x: 900, y: 300, width: 900, height: 200, fill: MASK_FILL },
      ];
      const probes = [
        { x: 1290, y: 396, w: 20, h: 8, rgb: BLUE },
        { x: 950, y: 450, w: 6, h: 6, rgb: [96, 96, 96], tol: 20 },
      ];
      return annotated(context, home, big, items, async (viewer) => {
        const { result } = await copyAndAnalyze(viewer, copyButton(viewer, 0), colorProbes, probes);
        return { ok: result.every(Boolean), detail: `flèche ${result[0]}, masque ${result[1]}` };
      });
    });

    await test('export JPG annoté', () => {
      const rect = { id: 'j1', type: 'rect', color: 'red', size: 'l', x: 1200, y: 600, width: 800, height: 300 };
      return annotated(context, home, big, [rect], async (viewer) => {
        await viewer.getByRole('button', { name: 'JPG', exact: true }).click();
        try {
          const [file] = await download(context, viewer, viewer.locator('figure.part').nth(0).getByRole('button', { name: 'Télécharger' }), 1);
          // Un JPG commence par FF D8 FF : sans cela, un PNG passerait aussi (la page relit n'importe quel format).
          const signature = (await fs.readFile(file)).subarray(0, 3).toString('hex');
          const [found] = await inImage(viewer, file, colorProbes, [{ x: 1196, y: 746, w: 8, h: 8, rgb: RED }]);
          return { ok: signature === 'ffd8ff' && found, detail: `signature ${signature}, couleur ${found ? 'présente' : 'absente'}` };
        } finally {
          await viewer.getByRole('button', { name: 'PNG', exact: true }).click();
        }
      });
    });

    await test('masque : cinq nuances sur fond clair comme sur fond sombre', () => {
      // Une teinte blanche ne peut que s'assombrir, une teinte noire que s'éclaircir : dans les deux cas, cinq blocs différents.
      const rects = [
        { x: 60, y: 620, w: 360, h: 80 },
        { x: 60, y: 1100, w: 360, h: 80 },
      ];
      const fills = ['#ffffff', '#000000'];
      const masks = rects.map((r, i) => ({ id: `n${i}`, type: 'mask', color: 'red', size: 'm', x: r.x, y: r.y, width: r.w, height: r.h, fill: fills[i] }));
      return annotated(context, home, big, masks, async (viewer) => {
        const { result: light } = await copyAndAnalyze(viewer, copyButton(viewer, 0), blockReport, { rects: [rects[0]], block: 20 });
        const dark = await inImage(viewer, 'clipboard', blockReport, { rects: [rects[1]], block: 20 });
        return { ok: light.uniform && dark.uniform && light.colors === 5 && dark.colors === 5, detail: `fond blanc ${light.colors} nuances, fond noir ${dark.colors}` };
      });
    });

    await test('aperçu d’un masque indépendant du contenu caché', () => {
      // « Ligne 5 » et « Ligne 6 » sous deux masques identiques, 128 px plus bas : 128 × 41/64 = 82 px d'aperçu exactement,
      // donc le même réglage au sous-pixel. Un masque réduit doit rester opaque, sans jointure claire ni trace de texte.
      const rects = [
        { x: 60, y: 620, w: 360, h: 80 },
        { x: 60, y: 748, w: 360, h: 80 },
      ];
      const masks = rects.map((r, i) => ({ id: `q${i}`, type: 'mask', color: 'red', size: 'm', x: r.x, y: r.y, width: r.w, height: r.h, fill: MASK_FILL }));
      return annotated(context, home, big, masks, async (viewer) => {
        const { low, high, spread } = await viewer.evaluate(previewReport, { rects, width: 2560 });
        // Les nuances vont de 96 à 121 ; blanc de la page ou texte noir sous le masque sortiraient de cette plage.
        return { ok: low >= 80 && high <= 130 && spread <= 3, detail: `valeurs ${low}–${high}, écart entre les deux masques ${spread}` };
      });
    });

    await test('aperçu : pas de joint à la limite des bandes de 4 096 px', async () => {
      // Capture large de 1440 points (2880 px) : la bande de 4 096 px réduite tombe sur un pixel d'aperçu fractionnaire.
      const wide = await seedCapture(home, { heightPoints: 3000, widthPoints: 1440 });
      const mask = { id: 'z1', type: 'mask', color: 'red', size: 'm', x: 100, y: 3500, width: 900, height: 1500, fill: MASK_FILL };
      return annotated(context, home, wide, [mask], async (viewer) => {
        const { low, high } = await viewer.evaluate(previewReport, { rects: [{ x: 100, y: 3500, w: 900, h: 1500 }], width: 2880 });
        return { ok: low >= 80 && high <= 130, detail: `valeurs ${low}–${high} sur tout le masque, dont la ligne 4 096` };
      });
    });

    await test('copie en cours puis autre capture ouverte : l’image copiée garde ses masques', async () => {
      const other = await seedCapture(home, { heightPoints: 3000 });
      const mask = { id: 'r1', type: 'mask', color: 'red', size: 'm', x: 60, y: 620, width: 360, height: 80, fill: '#ffffff' };
      return annotated(context, home, big, [mask], async (viewer) => {
        // Le rendu de la copie démarre 1,5 s après le clic : l'autre capture est alors déjà ouverte, quelle que soit la vitesse de la machine.
        // La classe Stitcher de la page est la même que celle du viewer : changer son prototype suffit.
        await viewer.evaluate(async () => {
          const { Stitcher } = await import(chrome.runtime.getURL('viewer/stitcher.js'));
          const original = Stitcher.prototype.renderPart;
          Stitcher.prototype.renderPart = async function (...args) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
            return original.apply(this, args);
          };
        });
        // On clique « Copier » sur la capture annotée, puis on ouvre aussitôt une autre capture dans l'historique.
        const trigger = {
          click: async () => {
            await copyButton(viewer, 0).click();
            await viewer.locator(`button.history-item[data-id="${other}"]`).click();
          },
        };
        // Zone masquée (contenait « Ligne 5 ») et, au-dessus, une ligne de texte restée visible (témoin : l'image n'est pas vide).
        const zones = [{ x: 60, y: 620, w: 360, h: 80 }, { x: 60, y: 380, w: 360, h: 80 }];
        const { size, result } = await copyAndAnalyze(viewer, trigger, darkPixels, zones);
        return { ok: size.startsWith('2560 × ') && result[0] === 0 && result[1] > 0, detail: `image ${size}, pixels sombres : masque ${result[0]}, témoin ${result[1]}` };
      });
    });

    await test('annotation abîmée sautée, la capture reste ouverte et exportable', () => {
      // Un enregistrement invalide (type inconnu, champ manquant, valeur nulle) ne doit pas empêcher d'ouvrir ni d'exporter.
      const items = [
        { id: 'b1', type: 'inconnu', color: 'red', size: 'm' },
        { id: 'b2', type: 'rect', color: 'red', x: 0, y: 0, width: 10, height: 10 },
        { id: 'b3', type: 'arrow', color: 'blue', size: 'm' },
        { id: 'b4', type: 'highlight', color: 'rose', size: 'm', x: 0, y: 0, width: 10, height: 10 },
        { id: 'b5', type: 'mask', color: 'red', size: 'm', x: 0, y: 0, width: 10, height: 10 },
        null,
        { id: 'b6', type: 'rect', color: 'red', size: 'l', x: 1200, y: 600, width: 800, height: 300 },
      ];
      return annotated(context, home, big, items, async (viewer) => {
        const { heights } = await partLayout(viewer);
        const { result } = await copyAndAnalyze(viewer, copyButton(viewer, 0), colorProbes, [{ x: 1196, y: 746, w: 8, h: 8, rgb: RED }]);
        const total = heights.reduce((sum, h) => sum + h, 0);
        return { ok: heights.length === 3 && total === 24000 && result[0], detail: `${heights.length} images, ${total} px, rectangle valide ${result[0] ? 'présent' : 'absent'}` };
      });
    });

    // L'écran peut se rafraîchir entre deux tranches : rien ne doit se dessiner sur un canvas affiché avant que les masques soient posés.
    await test('aperçu dessiné hors écran, puis copié d’un seul coup', () => {
      const mask = { id: 'o1', type: 'mask', x: 60, y: 620, width: 360, height: 80, fill: MASK_FILL };
      return annotated(context, home, big, [mask], async (viewer) => {
        await viewer.evaluate(async () => {
          const { Stitcher } = await import(chrome.runtime.getURL('viewer/stitcher.js'));
          const draw = Stitcher.prototype.draw;
          window.drawnOn = new Set();
          Stitcher.prototype.draw = function drawWatched(ctx, ...args) {
            window.drawnOn.add(ctx.canvas.constructor.name);
            return draw.call(this, ctx, ...args);
          };
        });
        await viewer.locator('#split').getByRole('button', { name: 'Long', exact: true }).click();
        await viewer.waitForFunction(() => document.body.dataset.ready === 'true' && window.drawnOn.size > 0, null, { timeout: 60_000 });
        const surfaces = await viewer.evaluate(() => [...window.drawnOn]);
        await viewer.locator('#split').getByRole('button', { name: 'Moyen', exact: true }).click();
        await viewer.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 60_000 });
        const { low, high } = await viewer.evaluate(previewReport, { rects: [{ x: 60, y: 620, w: 360, h: 80 }], width: 2560 });
        const ok = surfaces.length === 1 && surfaces[0] === 'OffscreenCanvas' && low >= 80 && high <= 130;
        return { ok, detail: `dessiné sur ${surfaces.join(', ')} ; masque à l’aperçu ${low}–${high}` };
      });
    });

    await test('masque abîmé : peint quand même', () => {
      // Teinte absente, ou largeur et hauteur négatives : la zone est couverte quand même (teinte grise de repli), jamais sautée.
      const masks = [
        { id: 'd1', type: 'mask', x: 60, y: 620, width: 360, height: 80 },
        { id: 'd2', type: 'mask', x: 420, y: 940, width: -360, height: -80, fill: '#ffffff' },
      ];
      // « Ligne 5 » et « Ligne 7 » sous les deux masques, « Ligne 3 » au-dessus comme témoin.
      const zones = [{ x: 60, y: 620, w: 360, h: 80 }, { x: 60, y: 860, w: 360, h: 80 }, { x: 60, y: 380, w: 360, h: 80 }];
      return annotated(context, home, big, masks, async (viewer) => {
        const { result } = await copyAndAnalyze(viewer, copyButton(viewer, 0), darkPixels, zones);
        return { ok: result[0] === 0 && result[1] === 0 && result[2] > 0, detail: `pixels sombres : sans teinte ${result[0]}, à l’envers ${result[1]}, témoin ${result[2]}` };
      });
    });

    await test('liseré d’un masque : moyenne, bords de la capture exclus', async () => {
      // Capture de 1280 × 900 px : cadre de 2 px orange autour d'un carré bleu, plus un L orange le long du coin haut gauche.
      const draw = (ctx) => {
        ctx.fillStyle = 'rgb(200,100,50)';
        ctx.fillRect(98, 98, 204, 104);
        ctx.fillRect(50, 0, 2, 52);
        ctx.fillRect(0, 50, 52, 2);
        ctx.fillStyle = 'rgb(0,0,255)';
        ctx.fillRect(100, 100, 200, 100);
      };
      const small = await seedCapture(home, { heightPoints: 900, scale: 1, draw });
      const got = await home.evaluate(async (id) => {
        const { getCapture } = await import(chrome.runtime.getURL('lib/db.js'));
        const { Stitcher } = await import(chrome.runtime.getURL('viewer/stitcher.js'));
        const record = await getCapture(id);
        const stitcher = new Stitcher(record);
        return {
          frame: await stitcher.averageRing({ x: 100, y: 100, width: 200, height: 100 }),
          corner: await stitcher.averageRing({ x: 0, y: 0, width: 50, height: 50 }),
          whole: await stitcher.averageRing({ x: 0, y: 0, width: record.width, height: record.height }),
        };
      }, small);
      return { ok: got.frame === '#c86432' && got.corner === '#c86432' && got.whole === '#808080', detail: JSON.stringify(got) };
    });

    await test('liseré d’un masque plus haut qu’un morceau de lecture (4 096 lignes)', async () => {
      // Capture de 2560 × 6000 px, rectangle de 5000 lignes (x 100–400, y 200–5200) : ses côtés gauche et droit sont lus en deux morceaux.
      // Les 4 096 premières lignes du liseré sont orange (comme le côté haut), les 904 suivantes (comme le côté bas) bleu-vert ;
      // un décalage faux du second morceau relirait de l'orange et donnerait une autre moyenne.
      const draw = (ctx) => {
        ctx.fillStyle = 'rgb(200,100,50)';
        ctx.fillRect(98, 198, 304, 2);
        ctx.fillRect(98, 200, 2, 4096);
        ctx.fillRect(400, 200, 2, 4096);
        ctx.fillStyle = 'rgb(40,180,220)';
        ctx.fillRect(98, 4296, 2, 904);
        ctx.fillRect(400, 4296, 2, 904);
        ctx.fillRect(98, 5200, 304, 2);
      };
      const tall = await seedCapture(home, { heightPoints: 3000, draw });
      const got = await home.evaluate(async (id) => {
        const { getCapture } = await import(chrome.runtime.getURL('lib/db.js'));
        const { Stitcher } = await import(chrome.runtime.getURL('viewer/stitcher.js'));
        return new Stitcher(await getCapture(id)).averageRing({ x: 100, y: 200, width: 300, height: 5000 });
      }, tall);
      // Orange : haut (608 px) + 2 × 2 × 4096 ; bleu-vert : bas (608 px) + 2 × 2 × 904 ; 21 216 px en tout.
      const orange = [200, 100, 50];
      const cyan = [40, 180, 220];
      const expected = `#${orange.map((c, i) => Math.round((c * 16992 + cyan[i] * 4224) / 21216).toString(16).padStart(2, '0')).join('')}`;
      return { ok: got === expected, detail: `moyenne ${got}, attendue ${expected}` };
    });
  } finally {
    await home.close();
  }
}

// ---- Éditeur : ouverture, fermeture, affichage fluide (tâche 3) ----

const annotateButton = (viewer, index) => viewer.locator('figure.part').nth(index).getByRole('button', { name: 'Annoter', exact: true });
const editorReady = (viewer) => viewer.waitForSelector('#editor[data-ready="true"]', { timeout: 30_000 });

// Ouvre l'éditeur par le bouton « Annoter » de l'image `index`, puis attend que la zone visible soit dessinée.
async function openEditorOn(viewer, index) {
  await annotateButton(viewer, index).click();
  await editorReady(viewer);
}

// Les fonctions suivantes s'exécutent dans la page (viewer.evaluate) : elles lisent l'éditeur tel qu'on le voit.

// Position, depuis le haut de la zone de défilement et en pixels d'écran, du haut de l'image qui commence à `top` (pixels de la capture).
function imageTopInEditor(top) {
  const area = document.getElementById('editor-scroll');
  const scale = Number(document.getElementById('editor').dataset.scale);
  return { y: top * scale - area.scrollTop, height: area.clientHeight };
}

const inUpperHalf = ({ y, height }) => y >= -1 && y < height / 2;

// Échelle d'affichage, largeur affichée du fond et de la zone de défilement.
function editorLayout() {
  const root = document.getElementById('editor');
  const area = document.getElementById('editor-scroll');
  return {
    scale: Number(root.dataset.scale),
    tileWidth: document.querySelector('.editor-tile').getBoundingClientRect().width,
    clientWidth: area.clientWidth,
    scrollWidth: area.scrollWidth,
  };
}

// Pixel [r, v, b, opacité] du calque d'annotations de l'éditeur au point (x, y) de la capture, tel qu'il est affiché.
function stageColorAt({ x, y }) {
  const area = document.getElementById('editor-scroll');
  const canvas = document.querySelector('#editor-stage canvas');
  const scale = Number(document.getElementById('editor').dataset.scale);
  const left = document.getElementById('editor-page').getBoundingClientRect().left - area.getBoundingClientRect().left;
  const ratio = canvas.width / area.clientWidth;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return [...ctx.getImageData(Math.round((left + x * scale) * ratio), Math.round((y * scale - area.scrollTop) * ratio), 1, 1).data];
}

// Un masque tel que le calque d'annotations l'affiche, sans 2 pixels d'écran de bord (où il se fond avec la capture) :
// combien de pixels ne sont pas opaques, et la valeur la plus sombre et la plus claire des canaux.
// Un pixel moins sombre que la nuance la plus sombre du masque laisse voir ce qu'il cache.
function maskOnStage({ x, y, width, height }) {
  const area = document.getElementById('editor-scroll');
  const canvas = document.querySelector('#editor-stage canvas');
  const scale = Number(document.getElementById('editor').dataset.scale);
  const left = document.getElementById('editor-page').getBoundingClientRect().left - area.getBoundingClientRect().left;
  const ratio = canvas.width / area.clientWidth;
  const edge = 2;
  const w = Math.round(width * scale * ratio) - 2 * edge;
  const h = Math.round(height * scale * ratio) - 2 * edge;
  const { data } = canvas
    .getContext('2d', { willReadFrequently: true })
    .getImageData(Math.round((left + x * scale) * ratio) + edge, Math.round((y * scale - area.scrollTop) * ratio) + edge, w, h);
  let translucent = 0;
  let darkest = 255;
  let lightest = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] !== 255) translucent++;
    for (let channel = 0; channel < 3; channel++) {
      darkest = Math.min(darkest, data[i + channel]);
      lightest = Math.max(lightest, data[i + channel]);
    }
  }
  return { translucent, darkest, lightest, pixels: w * h, scale, ratio: ratio * scale };
}

// Pixel [r, v, b] du fond de l'éditeur au point (x, y) de la capture (largeur `width`), lu dans le canvas de la tuile
// qui contient ce point, ou dans la tuile `tile` pour sonder le recouvrement entre deux tuiles. null si cette tuile n'est pas dessinée.
function tileColorAt({ x, y, width, tile }) {
  const TILE_PX = 2048;
  const index = tile ?? Math.floor(y / TILE_PX);
  const canvas = document.querySelectorAll('.editor-tile')[index]?.querySelector('canvas');
  if (!canvas || canvas.width === 0) return null;
  const ratio = canvas.width / width;
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(Math.round(x * ratio), Math.round((y - index * TILE_PX) * ratio), 1, 1);
  return [data[0], data[1], data[2]];
}

// Fait défiler la zone de l'éditeur jusqu'au point `y` de la capture et attend deux images, le temps que le calque suive.
function scrollEditorTo(y) {
  document.getElementById('editor-scroll').scrollTop = y * Number(document.getElementById('editor').dataset.scale);
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

// Parcourt la capture par grands sauts et rend le plus grand nombre de tuiles de fond dessinées en même temps.
async function scrollAround() {
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const drawn = () => [...document.querySelectorAll('.editor-tile canvas')].filter((canvas) => canvas.width > 0).length;
  const area = document.getElementById('editor-scroll');
  let most = drawn();
  for (const fraction of [0.1, 0.5, 0.9, 0.3, 1, 0.7, 0.05, 0.6]) {
    area.scrollTop = fraction * (area.scrollHeight - area.clientHeight);
    for (let i = 0; i < 6; i++) {
      await frame();
      most = Math.max(most, drawn());
    }
  }
  const deadline = performance.now() + 30_000;
  while (document.getElementById('editor').dataset.ready !== 'true' && performance.now() < deadline) await frame();
  return { most, last: drawn(), ready: document.getElementById('editor').dataset.ready === 'true', tiles: document.querySelectorAll('.editor-tile').length };
}

// Chronomètre dans la page : du clic sur « Annoter » à l'éditeur dessiné (data-ready), sans la latence de Playwright.
function startStopwatch() {
  const watch = (window.stopwatch = {});
  const editor = document.getElementById('editor');
  document.addEventListener('click', () => (watch.start = performance.now()), { capture: true, once: true });
  new MutationObserver(() => {
    if (watch.start !== undefined && watch.end === undefined && editor.dataset.ready === 'true') watch.end = performance.now();
  }).observe(editor, { attributes: true, attributeFilter: ['data-ready'] });
}

const readStopwatch = () => window.stopwatch.end - window.stopwatch.start;

async function testEditor(context, base) {
  console.log('\n— Éditeur : ouverture, fermeture, affichage fluide');
  const home = await extensionPage(context, 'popup/popup.html');
  try {
    await resetDb(home);
    // 12 000 points à ×2 : trois images de 8 000 px avec le découpage « Moyen ».
    const medium = await seedCapture(home, { heightPoints: 12000 });

    await test('Annoter ouvre l’éditeur sur l’image 3', () =>
      withViewer(context, medium, async (viewer) => {
        const { tops } = await partLayout(viewer);
        await openEditorOn(viewer, 2);
        const state = await viewer.evaluate(() => {
          const root = document.getElementById('editor');
          return {
            role: root.getAttribute('role'),
            modal: root.getAttribute('aria-modal'),
            focus: document.activeElement?.getAttribute('aria-label'),
            behind: document.querySelector('.layout').inert,
          };
        });
        const visible = await viewer.getByRole('dialog', { name: 'Annoter la capture' }).isVisible();
        const where = await viewer.evaluate(imageTopInEditor, tops[2]);
        const ok = visible && state.role === 'dialog' && state.modal === 'true' && inUpperHalf(where) && state.focus === 'Flèche' && state.behind;
        return { ok, detail: `haut de l’image 3 à ${Math.round(where.y)} px sur ${where.height} ; focus « ${state.focus} », page derrière inactive ${state.behind}` };
      }));

    await test('clic droit → Annoter l’image', () =>
      withViewer(context, medium, async (viewer) => {
        const { tops } = await partLayout(viewer);
        await viewer.locator('figure.part').nth(1).locator('canvas').click({ button: 'right' });
        await viewer.getByRole('menuitem', { name: 'Annoter l’image' }).click();
        await editorReady(viewer);
        const where = await viewer.evaluate(imageTopInEditor, tops[1]);
        return { ok: await viewer.locator('#editor').isVisible() && inUpperHalf(where), detail: `haut de l’image 2 à ${Math.round(where.y)} px sur ${where.height}` };
      }));

    await test('coupes affichées en pointillé', () =>
      withViewer(context, medium, async (viewer) => {
        const { tops } = await partLayout(viewer);
        await openEditorOn(viewer, 0);
        const cuts = await viewer.evaluate(() => {
          const scale = Number(document.getElementById('editor').dataset.scale);
          return [...document.querySelectorAll('.editor-cut')].map((el) => ({ top: el.offsetTop / scale, style: getComputedStyle(el).borderTopStyle }));
        });
        // Chaque trait est posé sur la coupe de la page de résultats, à 4 px de capture près.
        const placed = cuts.length === tops.length - 1 && cuts.every((cut, i) => cut.style === 'dashed' && Math.abs(cut.top - tops[i + 1]) <= 4);
        return { ok: placed, detail: `${cuts.length} coupes pour ${tops.length} images` };
      }));

    await test('Terminer et Échap ferment l’éditeur', () =>
      withViewer(context, medium, async (viewer) => {
        const found = {};
        const closers = {
          Terminer: () => viewer.getByRole('button', { name: 'Terminer', exact: true }).click(),
          Échap: () => viewer.keyboard.press('Escape'),
        };
        for (const [label, close] of Object.entries(closers)) {
          await openEditorOn(viewer, 2);
          await close();
          await viewer.waitForSelector('#editor', { state: 'hidden' });
          // Le focus revient au bouton « Annoter » de l'image d'origine, et plus rien de l'éditeur ne reste en mémoire.
          found[label] = await viewer.evaluate(() => ({
            button: document.activeElement.textContent,
            figure: [...document.querySelectorAll('figure.part')].indexOf(document.activeElement.closest('figure.part')),
            behind: document.querySelector('.layout').inert || document.querySelector('.top').inert,
            leftovers: document.querySelectorAll('#editor-stage canvas, .editor-tile, .editor-cut').length,
          }));
        }
        const ok = Object.values(found).every((got) => got.button === 'Annoter' && got.figure === 2 && !got.behind && got.leftovers === 0);
        return { ok, detail: JSON.stringify(found) };
      }));

    await test('annotations existantes affichées et suivies au défilement', () => {
      const items = [
        { id: 'e1', type: 'rect', color: 'red', size: 'l', x: 1200, y: 600, width: 800, height: 300 },
        { id: 'e2', type: 'highlight', color: 'blue', size: 'm', x: 1200, y: 10_000, width: 800, height: 300 },
      ];
      const near = (pixel, rgb, alpha) => pixel.slice(0, 3).every((c, i) => Math.abs(c - rgb[i]) <= 40) && Math.abs(pixel[3] - alpha) <= 20;
      return annotated(context, home, medium, items, async (viewer) => {
        await openEditorOn(viewer, 0);
        const rect = await viewer.evaluate(stageColorAt, { x: 1200, y: 750 });
        await viewer.evaluate(scrollEditorTo, 10_000 - 200);
        const highlight = await viewer.evaluate(stageColorAt, { x: 1600, y: 10_150 });
        const gone = await viewer.evaluate(stageColorAt, { x: 1200, y: 750 });
        const ok = near(rect, RED, 255) && near(highlight, BLUE, 102) && gone[3] === 0;
        return { ok, detail: `rectangle ${rect}, surligneur après défilement ${highlight}, rectangle sorti de la zone ${gone}` };
      });
    });

    await test('capture affichée sans défilement horizontal', () =>
      withViewer(context, medium, async (viewer) => {
        await openEditorOn(viewer, 0);
        const got = await viewer.evaluate(editorLayout);
        // En ×2, la capture s'affiche au plus à 100 % (une moitié de sa largeur réelle) et ne dépasse jamais la zone.
        const ok = got.scale <= 0.5 + 1e-9 && got.tileWidth <= got.clientWidth && got.scrollWidth === got.clientWidth && Math.abs(got.tileWidth - 2560 * got.scale) < 1;
        return { ok, detail: `échelle ${got.scale.toFixed(3)}, fond ${Math.round(got.tileWidth)} px dans ${got.clientWidth} px (défilement ${got.scrollWidth})` };
      }));

    await test('fenêtre redimensionnée : la capture suit', () =>
      withViewer(context, medium, async (viewer) => {
        const { tops } = await partLayout(viewer);
        await openEditorOn(viewer, 1);
        const before = await viewer.evaluate(editorLayout);
        await viewer.setViewportSize({ width: 900, height: 700 });
        await viewer.waitForFunction(
          (scale) => {
            const root = document.getElementById('editor');
            return Number(root.dataset.scale) !== scale && root.dataset.ready === 'true';
          },
          before.scale,
          { timeout: 15_000 },
        );
        const after = await viewer.evaluate(editorLayout);
        const where = await viewer.evaluate(imageTopInEditor, tops[1]);
        const ok = after.scale < before.scale && after.tileWidth <= after.clientWidth && after.scrollWidth === after.clientWidth && inUpperHalf(where);
        return { ok, detail: `échelle ${before.scale.toFixed(3)} → ${after.scale.toFixed(3)}, haut de l’image 2 à ${Math.round(where.y)} px` };
      }));

    await test('masque affiché : opaque et sans trace du texte caché, à l’échelle d’affichage', () => {
      // Le masque recouvre « Ligne 11 » (noir sur blanc). Fond #c0c0c0 : ses cinq nuances vont de 161 à 192, rien de plus sombre ne doit apparaître.
      const mask = { id: 'k2', type: 'mask', color: 'red', size: 'm', x: 60, y: 1340, width: 300, height: 80, fill: '#c0c0c0' };
      return annotated(context, home, medium, [mask], async (viewer) => {
        await openEditorOn(viewer, 0);
        await viewer.evaluate(scrollEditorTo, 1200);
        const got = await viewer.evaluate(maskOnStage, mask);
        // L'échelle de l'écran n'est pas entière : c'est le cas où les joints entre blocs se lissaient sur le calque transparent.
        const fractional = Math.abs(got.ratio - Math.round(got.ratio)) > 0.01;
        const ok = fractional && got.pixels > 10_000 && got.translucent === 0 && got.darkest >= 160 && got.lightest <= 193;
        return { ok, detail: `échelle ${got.ratio.toFixed(3)} pixels d’écran par pixel de capture, ${got.translucent} pixels translucides sur ${got.pixels}, valeurs de ${got.darkest} à ${got.lightest} (attendu 161 à 192)` };
      });
    });

    await test('fond : les tuiles contiennent la capture au bon endroit, jonction comprise', () =>
      withViewer(context, medium, async (viewer) => {
        await openEditorOn(viewer, 0);
        // La bande magenta du point 1 000 (pixels 2 000 à 2 080) enjambe la jonction des deux premières tuiles (pixel 2 048).
        await viewer.evaluate(scrollEditorTo, 1800);
        await editorReady(viewer);
        const WHITE = [255, 255, 255];
        const probes = [
          { name: 'blanc au-dessus de la bande', x: 1000, y: 1990, rgb: WHITE },
          { name: 'bande, tuile 1', x: 1000, y: 2030, rgb: MAGENTA },
          { name: 'bande, recouvrement lu dans la tuile 1', x: 1000, y: 2050, tile: 0, rgb: MAGENTA },
          { name: 'bande, recouvrement lu dans la tuile 2', x: 1000, y: 2050, tile: 1, rgb: MAGENTA },
          { name: 'bande, tuile 2', x: 1000, y: 2070, rgb: MAGENTA },
          { name: 'blanc sous la bande', x: 1000, y: 2100, rgb: WHITE },
        ];
        const wrong = [];
        for (const { name, rgb, ...point } of probes) {
          const got = await viewer.evaluate(tileColorAt, { ...point, width: 2560 });
          if (!got || got.some((value, i) => Math.abs(value - rgb[i]) > 8)) wrong.push(`${name} : ${got ? got.join(',') : 'tuile absente'}`);
        }
        return { ok: wrong.length === 0, detail: wrong.length ? wrong.join(' ; ') : `${probes.length} points lus dans les canvas des tuiles` };
      }));

    await test('Annoter refusé pendant un nouveau découpage', () =>
      withViewer(context, medium, async (viewer) => {
        const before = await viewer.locator('figure.part').count();
        let during;
        let after;
        try {
          // Dans un même instant : le découpage « Court » démarre, puis on clique sur « Annoter » de l'ancienne image 2.
          during = await viewer.evaluate(() => {
            const old = document.querySelectorAll('figure.part')[1].querySelector('.annotate');
            [...document.querySelectorAll('#split button')].find((button) => button.textContent === 'Court').click();
            old.click();
            return { disabled: old.disabled, menu: document.querySelector('#image-menu [data-action="annotate"]').disabled, opened: !document.getElementById('editor').hidden };
          });
          if (during.opened) await viewer.keyboard.press('Escape');
          await viewer.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
          // Une fois les nouvelles coupes posées, l'éditeur s'ouvre et ses coupes sont celles de la page affichée.
          const count = await viewer.locator('figure.part').count();
          await openEditorOn(viewer, count - 1);
          after = await viewer.evaluate(() => ({
            count: document.querySelectorAll('figure.part').length,
            cuts: document.querySelectorAll('.editor-cut').length,
            label: document.getElementById('editor-copy').textContent,
            enabled: [...document.querySelectorAll('.annotate')].every((button) => !button.disabled),
          }));
          await viewer.keyboard.press('Escape');
          await viewer.waitForSelector('#editor', { state: 'hidden' });
        } finally {
          // Le choix de découpage est mémorisé par l'extension : les tests suivants repartent du découpage « Moyen ».
          await viewer.getByRole('button', { name: 'Moyen', exact: true }).click();
          await viewer.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
        }
        const ok =
          during.disabled && during.menu && !during.opened && after.count > before && after.cuts === after.count - 1 && after.label.endsWith(` ${after.count}`) && after.enabled;
        return { ok, detail: `${before} → ${after.count} images ; pendant le calcul : bouton inactif ${during.disabled}, éditeur ouvert ${during.opened} ; ensuite ${after.cuts} coupes, « ${after.label} »` };
      }));

    // 100 000 points à ×2 : 200 000 px de haut, 25 images avec le découpage « Moyen ».
    const huge = await seedCapture(home, { heightPoints: 100_000 });

    await test('ouverture rapide sur une très longue capture', () =>
      withViewer(context, huge, async (viewer) => {
        const { tops } = await partLayout(viewer);
        await viewer.evaluate(startStopwatch);
        await annotateButton(viewer, tops.length - 1).click();
        await editorReady(viewer);
        const ms = await viewer.evaluate(readStopwatch);
        const where = await viewer.evaluate(imageTopInEditor, tops.at(-1));
        return { ok: ms < 1500 && inUpperHalf(where), detail: `ouverture en ${Math.round(ms)} ms sur ${tops.length} images (limite 1 500 ms)` };
      }));

    await test('défilement : seule la zone visible est dessinée', () =>
      withViewer(context, huge, async (viewer) => {
        await openEditorOn(viewer, 0);
        const got = await viewer.evaluate(scrollAround);
        const ok = got.tiles > 90 && got.most >= 1 && got.most <= 6 && got.last >= 1 && got.ready;
        return { ok, detail: `${got.most} tuiles dessinées au plus, sur ${got.tiles}` };
      }));

    await test('ouverture rapide sur long.html', async () => {
      const sw = context.serviceWorkers()[0];
      const { page, tabId } = await openTab(context, sw, `${base}/long.html`);
      try {
        const { viewer, error } = await capture(context, sw, tabId, 'full');
        if (!viewer) throw new Error(`capture impossible : ${error}`);
        try {
          const { tops } = await partLayout(viewer);
          await viewer.evaluate(startStopwatch);
          await annotateButton(viewer, tops.length - 1).click();
          await editorReady(viewer);
          const ms = await viewer.evaluate(readStopwatch);
          return { ok: ms < 1500, detail: `ouverture en ${Math.round(ms)} ms sur ${tops.length} images (limite 1 500 ms)` };
        } finally {
          await viewer.close();
        }
      } finally {
        await page.close();
      }
    });
  } finally {
    await home.close();
  }
}

// ---- Éditeur : les sept outils, couleurs, tailles et enregistrement (tâche 4) ----

// Point (x, y) de la capture, en coordonnées de la fenêtre : échelle d'affichage et défilement compris. S'exécute dans la page.
function windowPoint({ x, y }) {
  const scale = Number(document.getElementById('editor').dataset.scale);
  const page = document.getElementById('editor-page').getBoundingClientRect();
  return { x: page.left + x * scale, y: page.top + y * scale };
}

// Glisse la souris d'un point de la capture à un autre. `to` peut aussi être donné en coordonnées de la fenêtre ({ window: { x, y } }),
// pour sortir de la capture.
async function drag(viewer, from, to) {
  const start = await viewer.evaluate(windowPoint, from);
  const end = to.window ?? (await viewer.evaluate(windowPoint, to));
  await viewer.mouse.move(start.x, start.y);
  await viewer.mouse.down();
  await viewer.mouse.move(end.x, end.y, { steps: 10 });
  await viewer.mouse.up();
}

async function clickAt(viewer, point) {
  const { x, y } = await viewer.evaluate(windowPoint, point);
  await viewer.mouse.click(x, y);
}

const storedItems = (viewer, id) =>
  viewer.evaluate(async (id) => {
    const { getAnnotations } = await import(chrome.runtime.getURL('lib/db.js'));
    return getAnnotations(id);
  }, id);

// Attend (5 s au plus) que l'enregistrement automatique ait rangé au moins `count` annotations, et les rend.
async function waitForItems(viewer, id, count) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const items = await storedItems(viewer, id);
    if (items.length >= count || Date.now() > deadline) return items;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// Ouvre l'éditeur sur une capture sans annotation, positionné sur l'image `index`, puis exécute `run`.
// `width` fixe la largeur de la fenêtre (l'échelle d'affichage en dépend).
function inEditor(context, home, id, run, { index = 0, width } = {}) {
  return annotated(context, home, id, [], async (viewer) => {
    if (width) await viewer.setViewportSize({ width, height: 900 });
    await openEditorOn(viewer, index);
    return run(viewer);
  });
}

// « Terminer » : l'éditeur se ferme, les coupes et les aperçus sont refaits.
async function finish(viewer) {
  await viewer.getByRole('button', { name: 'Terminer', exact: true }).click();
  await viewer.waitForSelector('#editor', { state: 'hidden' });
  await viewer.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
}

// Quitter la page pendant une écriture ouvre la confirmation de départ : on la laisse ouverte un instant, comme une personne, avant d'accepter.
function acceptLeaving(viewer) {
  viewer.on('dialog', async (dialog) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await dialog.accept();
  });
}

// Dans la page : pixel [r, v, b] de l'aperçu de l'image 1 au point (x, y) de la capture.
function previewPixelAt([x, y]) {
  const canvas = document.querySelector('figure.part canvas');
  const ratio = canvas.width / 2560;
  return [...canvas.getContext('2d', { willReadFrequently: true }).getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data].slice(0, 3);
}

const isReddish = ([r, g, b]) => r - g > 50 && r - b > 50;

// Dans la page : couleur la plus fréquente d'une capture d'écran PNG (octets en base64), et pour chaque couleur de `probes`
// le nombre de pixels qui en sont proches (40 par canal au plus).
async function screenColors({ bytes, probes }) {
  const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))]));
  const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  const counts = new Map();
  const near = probes.map(() => 0);
  for (let i = 0; i < data.length; i += 4) {
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
    probes.forEach((rgb, n) => {
      if (Math.abs(data[i] - rgb[0]) <= 40 && Math.abs(data[i + 1] - rgb[1]) <= 40 && Math.abs(data[i + 2] - rgb[2]) <= 40) near[n]++;
    });
  }
  let top = 0;
  for (const [key, count] of counts) if (count > (counts.get(top) ?? 0)) top = key;
  return { dominant: [top >> 16, (top >> 8) & 255, top & 255], near };
}

// Dans la page : la fermeture de l'onglet serait-elle retenue ? Évènement factice, rien ne se ferme.
function leavingIsBlocked() {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

// Dans la page : textes affichés par l'éditeur (le texte des pastilles est leur numéro).
const konvaTexts = () => Konva.stages.flatMap((stage) => stage.find('Text').map((node) => node.text()));

const toolPressed = (viewer) =>
  viewer.evaluate(() => [...document.querySelectorAll('.editor-tool[aria-pressed="true"]')].map((button) => button.getAttribute('aria-label')));
const colorPressed = (viewer) =>
  viewer.evaluate(() => [...document.querySelectorAll('.editor-color[aria-pressed="true"]')].map((button) => button.getAttribute('aria-label')));

// Une annotation de chaque outil, tracée à la souris dans une zone vide de l'image 1 (la capture synthétique est blanche, avec des lignes
// de texte à gauche) : touche de l'outil, geste, et sonde de couleur dans l'export.
const BY_MOUSE = {
  probes: [
    { name: 'flèche', x: 1000, y: 296, w: 20, h: 8, rgb: RED },
    { name: 'rectangle', x: 996, y: 640, w: 8, h: 20, rgb: RED },
    { name: 'surligneur', x: 1290, y: 1000, w: 10, h: 10, rgb: onWhite(YELLOW, 0.4) },
    { name: 'crayon', x: 395, y: 1395, w: 10, h: 10, rgb: RED },
    { name: 'texte', x: 1000, y: 1300, w: 300, h: 70, rgb: RED },
    { name: 'pastille 1', x: 1790, y: 990, w: 20, h: 20, rgb: RED },
    { name: 'pastille 2', x: 1790, y: 1240, w: 20, h: 20, rgb: RED },
  ],
  // « Ligne 1 » (y 152 à 208) est recouverte ; « Ligne 2 » (y 272 à 328) sert de témoin.
  masked: { x: 60, y: 150, w: 400, h: 60 },
  witness: { x: 80, y: 270, w: 300, h: 60 },
};

async function drawEachTool(viewer) {
  const { keyboard } = viewer;
  await keyboard.press('f');
  await drag(viewer, { x: 800, y: 300 }, { x: 1400, y: 300 });
  await keyboard.press('r');
  await drag(viewer, { x: 1000, y: 500 }, { x: 1600, y: 800 });
  await keyboard.press('s');
  await drag(viewer, { x: 1000, y: 900 }, { x: 1600, y: 1100 });
  await keyboard.press('c');
  await drag(viewer, { x: 200, y: 1300 }, { x: 600, y: 1500 });
  await keyboard.press('t');
  await clickAt(viewer, { x: 1000, y: 1300 });
  await keyboard.type('Bonjour');
  // Un clic ailleurs valide le texte sans rien poser d'autre.
  await clickAt(viewer, { x: 1900, y: 300 });
  await keyboard.press('n');
  await clickAt(viewer, { x: 1800, y: 1000 });
  await clickAt(viewer, { x: 1800, y: 1250 });
  await keyboard.press('m');
  await drag(viewer, { x: 60, y: 140 }, { x: 460, y: 220 });
}

async function testTools(context) {
  console.log('\n— Éditeur : les sept outils, couleurs, tailles et enregistrement');
  const home = await extensionPage(context, 'popup/popup.html');
  try {
    await resetDb(home);
    // 12 000 points à ×2 : trois images de 8 000 px avec le découpage « Moyen ».
    const medium = await seedCapture(home, { heightPoints: 12000 });

    await test('chaque outil dessine', () =>
      inEditor(context, home, medium, async (viewer) => {
        await drawEachTool(viewer);
        const items = await waitForItems(viewer, medium, 8);
        const types = items.map((item) => item.type).join();
        const texts = await viewer.evaluate(konvaTexts);
        await finish(viewer);
        const { result } = await copyAndAnalyze(viewer, copyButton(viewer, 0), colorProbes, BY_MOUSE.probes);
        const dark = await inImage(viewer, 'clipboard', darkPixels, [BY_MOUSE.masked, BY_MOUSE.witness]);
        const missing = BY_MOUSE.probes.filter((_, i) => !result[i]).map((probe) => probe.name);
        const bonjour = items.find((item) => item.type === 'text')?.text;
        const ok =
          types === 'arrow,rect,highlight,pen,text,badge,badge,mask' &&
          bonjour === 'Bonjour' &&
          ['1', '2'].every((number) => texts.includes(number)) &&
          missing.length === 0 &&
          dark[0] === 0 &&
          dark[1] > 0;
        return { ok, detail: `types ${types} ; pastilles ${texts.filter((t) => /^\d+$/.test(t))} ; absents : ${missing.join(', ') || 'aucun'} ; pixels sombres sous le masque ${dark[0]}, témoin ${dark[1]}` };
      }));

    await test('raccourcis d’une lettre', () =>
      inEditor(context, home, medium, async (viewer) => {
        const wrong = [];
        for (const [key, label] of [['f', 'Flèche'], ['r', 'Rectangle'], ['s', 'Surligneur'], ['t', 'Texte'], ['n', 'Pastille numérotée'], ['m', 'Masquer'], ['c', 'Crayon']]) {
          await viewer.keyboard.press(key);
          const pressed = await toolPressed(viewer);
          if (pressed.length !== 1 || pressed[0] !== label) wrong.push(`${key} → ${pressed.join('+') || 'aucun'}`);
        }
        // Avec Maj enfoncé, la lettre est une majuscule : même outil.
        await viewer.keyboard.press('Shift+F');
        if ((await toolPressed(viewer)).join() !== 'Flèche') wrong.push('Maj+F');
        const titles = await viewer.evaluate(() => [...document.querySelectorAll('.editor-tool')].map((button) => button.title));
        const hinted = titles.join() === 'Flèche (F),Rectangle (R),Surligneur (S),Texte (T),Pastille numérotée (N),Masquer (M),Crayon (C)';
        return { ok: wrong.length === 0 && hinted, detail: wrong.length ? wrong.join(' ; ') : titles.join(', ') };
      }));

    await test('masque tiré à la souris : bords nets', () =>
      // Fenêtre de 1 180 points : l'échelle d'affichage n'est pas un rapport entier.
      inEditor(
        context,
        home,
        medium,
        async (viewer) => {
          await viewer.keyboard.press('m');
          // Deux lignes de texte différentes (« Ligne 1 » et « Ligne 2 »), chacune entourée de blanc.
          await drag(viewer, { x: 60, y: 140 }, { x: 460, y: 220 });
          await drag(viewer, { x: 60, y: 260 }, { x: 460, y: 340 });
          const items = await waitForItems(viewer, medium, 2);
          const whole = items.every((mask) => [mask.x, mask.y, mask.width, mask.height].every(Number.isInteger));
          await finish(viewer);
          const [first, second] = items;
          // Les deux zones peuvent différer d'un pixel de taille : on compare leur partie commune, comptée depuis le coin haut gauche.
          const w = Math.min(first.width, second.width);
          const h = Math.min(first.height, second.height);
          const rects = [{ x: first.x, y: first.y, w, h }, { x: second.x, y: second.y, w, h }];
          const { result: blocks } = await copyAndAnalyze(viewer, copyButton(viewer, 0), blockReport, { rects, block: 20 });
          const edges = await inImage(viewer, 'clipboard', sharpEdges, { x: first.x, y: first.y, w: first.width, h: first.height });
          const hidden = await inImage(viewer, 'clipboard', darkPixels, items.map((mask) => ({ x: mask.x, y: mask.y, w: mask.width, h: mask.height })));
          const ok = items.length === 2 && whole && blocks.uniform && blocks.same && edges.leaked === 0 && hidden.every((count) => count === 0);
          return { ok, detail: `${JSON.stringify(items.map((m) => [m.x, m.y, m.width, m.height]))} ; ${JSON.stringify(blocks)} ; hors bord ${edges.leaked} ; pixels sombres ${hidden}` };
        },
        { width: 1180 },
      ));

    await test('masque créé après une flèche', () =>
      inEditor(context, home, medium, async (viewer) => {
        await viewer.keyboard.press('f');
        await drag(viewer, { x: 700, y: 600 }, { x: 1500, y: 600 });
        await viewer.keyboard.press('m');
        await drag(viewer, { x: 1000, y: 500 }, { x: 1300, y: 700 });
        await waitForItems(viewer, medium, 2);
        // Le trait de la flèche passe sur le masque : rouge et opaque dans l'éditeur, le masque seul est un aplat clair.
        const near = (pixel, rgb) => pixel[3] === 255 && pixel.slice(0, 3).every((c, i) => Math.abs(c - rgb[i]) <= 40);
        const arrow = await viewer.evaluate(stageColorAt, { x: 1100, y: 600 });
        const mask = await viewer.evaluate(stageColorAt, { x: 1100, y: 540 });
        await finish(viewer);
        const { result } = await copyAndAnalyze(viewer, copyButton(viewer, 0), colorProbes, [{ x: 1090, y: 596, w: 20, h: 8, rgb: RED }]);
        const ok = near(arrow, RED) && mask[3] === 255 && mask[0] > 200 && result[0];
        return { ok, detail: `éditeur : flèche ${arrow}, masque ${mask} ; export : flèche ${result[0] ? 'visible' : 'cachée'}` };
      }));

    // 11 000 points = 22 000 px : trois images dont les coupes peuvent bouger.
    const loose = await seedCapture(home, { heightPoints: 11000 });

    await test('rectangle à cheval sur une coupe, puis Terminer', () =>
      annotated(context, home, loose, [], async (viewer) => {
        const before = await partLayout(viewer);
        const cut = before.tops[1];
        await openEditorOn(viewer, 1);
        await viewer.evaluate(scrollEditorTo, cut - 400);
        await viewer.keyboard.press('r');
        await drag(viewer, { x: 1200, y: cut - 150 }, { x: 2000, y: cut + 150 });
        const [rect] = await waitForItems(viewer, loose, 1);
        await finish(viewer);
        const after = await partLayout(viewer);
        const cuts = after.tops.slice(1);
        // Le trait déborde de 4 px de chaque côté.
        const crossing = cuts.filter((c) => c > rect.y - 4 && c < rect.y + rect.height + 4);
        const ok = rect !== undefined && crossing.length === 0 && cuts.length === before.tops.length - 1 && cuts[0] !== cut;
        return { ok, detail: `coupe ${cut} → ${cuts.join(', ')} (rectangle ${Math.round(rect?.y)}–${Math.round(rect?.y + rect?.height)})` };
      }));

    await test('couleur et taille', () =>
      inEditor(context, home, medium, async (viewer) => {
        const { keyboard } = viewer;
        const defaults = {};
        for (const [key, tool] of [['s', 'highlight'], ['f', 'arrow'], ['r', 'rect'], ['t', 'text'], ['n', 'badge'], ['m', 'mask'], ['c', 'pen']]) {
          await keyboard.press(key);
          defaults[tool] = (await colorPressed(viewer)).join();
        }
        // Le masque n'a pas de couleur : aucune pastille de couleur n'est enfoncée (voir « masque : ni couleur ni taille »).
        const expected = { highlight: 'Jaune', mask: '' };
        const defaultsOk = Object.entries(defaults).every(([tool, color]) => color === (expected[tool] ?? 'Rouge'));
        await keyboard.press('r');
        await viewer.getByRole('button', { name: 'Bleu', exact: true }).click();
        await viewer.getByRole('button', { name: 'Taille : Grand', exact: true }).click();
        await drag(viewer, { x: 1000, y: 500 }, { x: 1600, y: 800 });
        // Chaque outil garde sa couleur : la flèche reste rouge, le rectangle retrouve le bleu, le surligneur reste jaune.
        await keyboard.press('f');
        const arrowColor = (await colorPressed(viewer)).join();
        await drag(viewer, { x: 800, y: 300 }, { x: 1400, y: 300 });
        await keyboard.press('r');
        const rectColor = (await colorPressed(viewer)).join();
        await keyboard.press('s');
        const highlightColor = (await colorPressed(viewer)).join();
        await drag(viewer, { x: 1000, y: 900 }, { x: 1600, y: 1100 });
        const items = await waitForItems(viewer, medium, 3);
        const [rect, arrow, highlight] = items;
        const ok =
          defaultsOk &&
          rect?.color === 'blue' && rect?.size === 'l' &&
          arrow?.color === 'red' &&
          highlight?.color === 'yellow' &&
          arrowColor === 'Rouge' && rectColor === 'Bleu' && highlightColor === 'Jaune';
        return { ok, detail: `rectangle ${rect?.color}/${rect?.size}, flèche ${arrow?.color}, surligneur ${highlight?.color} ; outils au départ ${JSON.stringify(defaults)}` };
      }));

    await test('masque : teinte du liseré', async () => {
      // Un aplat de couleur connue (100, 150, 200) ; le masque est tiré à l'intérieur, son liseré est donc de cette couleur.
      const draw = (ctx) => {
        ctx.fillStyle = 'rgb(100,150,200)';
        ctx.fillRect(1000, 300, 800, 300);
      };
      const tinted = await seedCapture(home, { heightPoints: 3000, draw });
      return inEditor(context, home, tinted, async (viewer) => {
        await viewer.keyboard.press('m');
        await drag(viewer, { x: 1100, y: 350 }, { x: 1500, y: 500 });
        const [mask] = await waitForItems(viewer, tinted, 1);
        const channels = mask ? [1, 3, 5].map((start) => parseInt(mask.fill.slice(start, start + 2), 16)) : [];
        const ok = channels.length === 3 && channels.every((c, i) => Math.abs(c - [100, 150, 200][i]) <= 8);
        return { ok, detail: `fill ${mask?.fill}` };
      });
    });

    // Le masque ignore couleur et taille : les deux groupes sont inactifs avec lui, et l'annotation n'en garde aucune trace.
    await test('masque : ni couleur ni taille', () =>
      inEditor(context, home, medium, async (viewer) => {
        const state = () =>
          viewer.evaluate(() => {
            const summary = (kind) => {
              const buttons = [...document.querySelectorAll(`.editor-group[data-kind="${kind}"] button`)];
              return { off: buttons.every((b) => b.disabled), on: buttons.every((b) => !b.disabled), pressed: buttons.filter((b) => b.getAttribute('aria-pressed') === 'true').length };
            };
            return { color: summary('color'), size: summary('size') };
          });
        await viewer.keyboard.press('m');
        const masking = await state();
        // Un clic forcé sur « Grand » n'atteint pas le bouton inactif : la taille des autres outils ne change pas.
        await viewer.getByRole('button', { name: 'Taille : Grand', exact: true }).click({ force: true, timeout: 2000 });
        await drag(viewer, { x: 60, y: 140 }, { x: 460, y: 220 });
        const [mask] = await waitForItems(viewer, medium, 1);
        await viewer.keyboard.press('r');
        const back = await state();
        const size = await viewer.evaluate(() => document.querySelector('.editor-size[aria-pressed="true"]')?.getAttribute('aria-label'));
        const inactive = (s) => s.off && s.pressed === 0;
        const active = (s) => s.on && s.pressed === 1;
        const ok =
          inactive(masking.color) && inactive(masking.size) && active(back.color) && active(back.size) && size === 'Taille : Moyen' &&
          mask?.type === 'mask' && /^#[0-9a-f]{6}$/i.test(mask.fill) && !('color' in mask) && !('size' in mask);
        return { ok, detail: `avec le masque ${JSON.stringify(masking)} ; ensuite ${JSON.stringify(back)}, ${size} ; annotation ${JSON.stringify(mask)}` };
      }));

    // Un geste très rapide peut ne produire aucun mouvement entre l'appui et le relâchement : il compte s'il a parcouru assez de distance.
    // L'appui et le relâchement partent directement du protocole du navigateur, sans le mouvement intermédiaire de Playwright.
    await test('glisser rapide sans mouvement intermédiaire', () =>
      inEditor(context, home, medium, async (viewer) => {
        await viewer.keyboard.press('r');
        const from = await viewer.evaluate(windowPoint, { x: 1000, y: 500 });
        const to = await viewer.evaluate(windowPoint, { x: 1600, y: 800 });
        const cdp = await viewer.context().newCDPSession(viewer);
        const mouse = (type, point) => cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
        await viewer.evaluate(() => {
          window.moves = 0;
          document.getElementById('editor-stage').addEventListener('pointermove', () => window.moves++);
        });
        await mouse('mousePressed', from);
        await mouse('mouseReleased', to);
        const moves = await viewer.evaluate(() => window.moves);
        const [rect] = await waitForItems(viewer, medium, 1);
        const near = (value, expected) => Math.abs(value - expected) <= 3;
        // Sans mouvement intermédiaire, le test ne prouverait rien : le navigateur n'en a pas ajouté.
        const ok = moves === 0 && rect?.type === 'rect' && near(rect.x, 1000) && near(rect.y, 500) && near(rect.width, 600) && near(rect.height, 300);
        return { ok, detail: `${moves} mouvement(s) ; ${rect ? JSON.stringify([rect.x, rect.y, rect.width, rect.height].map(Math.round)) : 'aucun rectangle'}` };
      }));

    // Un texte long posé près du bord droit (ou plusieurs lignes près du bas) ne doit pas faire défiler le conteneur de la scène,
    // sinon les annotations déjà posées se décalent du fond pendant la saisie. Le curseur défile dans le champ lui-même.
    await test('texte long près du bord : le calque reste aligné sur le fond', () =>
      inEditor(context, home, medium, async (viewer) => {
        const shift = () =>
          viewer.evaluate(() => {
            const stage = document.getElementById('editor-stage');
            const box = stage.getBoundingClientRect();
            const field = stage.querySelector('.editor-text')?.getBoundingClientRect();
            return {
              scrollLeft: stage.scrollLeft,
              scrollTop: stage.scrollTop,
              offset: stage.querySelector('.konvajs-content').getBoundingClientRect().left - box.left,
              overRight: field ? field.right - box.right : null,
              overBottom: field ? field.bottom - box.bottom : null,
            };
          });
        const { keyboard } = viewer;
        await keyboard.press('t');
        await clickAt(viewer, { x: 2300, y: 700 });
        await keyboard.type('abcdefghij abcdefghij abcdefghij abcdefghij');
        const right = await shift();
        await keyboard.press('Escape');
        // Plusieurs lignes près du bas de la zone visible.
        const low = await viewer.evaluate(() => {
          const scale = Number(document.getElementById('editor').dataset.scale);
          const page = document.getElementById('editor-page').getBoundingClientRect();
          return { x: 1000, y: (document.getElementById('editor-stage').getBoundingClientRect().bottom - 40 - page.top) / scale };
        });
        await clickAt(viewer, low);
        for (const line of ['un', 'deux', 'trois', 'quatre', 'cinq', 'six']) {
          await keyboard.type(line);
          await keyboard.press('Enter');
        }
        const bottom = await shift();
        await keyboard.press('Escape');
        const still = (s) => s.scrollLeft === 0 && s.scrollTop === 0 && Math.abs(s.offset) < 0.5;
        const ok = still(right) && still(bottom) && right.overRight <= 0.5 && bottom.overBottom <= 0.5;
        return { ok, detail: `bord droit ${JSON.stringify(right)} ; bas ${JSON.stringify(bottom)}` };
      }));

    await test('tracé hors capture ramené dans les bords', async () => {
      const short = await seedCapture(home, { heightPoints: 2000 });
      return inEditor(context, home, short, async (viewer) => {
        await viewer.keyboard.press('r');
        // Au-delà du haut et du bord gauche : la souris passe sur l'en-tête et la barre d'outils.
        await drag(viewer, { x: 300, y: 300 }, { window: { x: 5, y: 5 } });
        // Au-delà du bas : tout en bas de la capture, vers un point sous la fenêtre.
        await viewer.evaluate(scrollEditorTo, 1e6);
        const bottom = await viewer.evaluate(windowPoint, { x: 1800, y: 3800 });
        await drag(viewer, { x: 1800, y: 3800 }, { window: { x: bottom.x + 200, y: 1100 } });
        // Au-delà du bord droit : la souris passe dans la marge, à droite de la capture.
        const right = await viewer.evaluate(() => document.getElementById('editor-page').getBoundingClientRect().right);
        await drag(viewer, { x: 1500, y: 3500 }, { window: { x: right + 8, y: bottom.y } });
        const items = await waitForItems(viewer, short, 3);
        const inside = items.every((r) => r.x >= 0 && r.y >= 0 && r.x + r.width <= 2560 && r.y + r.height <= 4000);
        const reaches =
          items[0]?.x === 0 && items[0]?.y === 0 && Math.abs(items[1]?.y + items[1]?.height - 4000) < 1e-6 && Math.abs(items[2]?.x + items[2]?.width - 2560) < 1e-6;
        await finish(viewer);
        const { message, size } = await copyAndRead(viewer, copyButton(viewer, 0));
        const ok = items.length === 3 && inside && reaches && /presse-papiers/.test(message) && size === '2560 × 4000';
        return { ok, detail: `${JSON.stringify(items.map((r) => [r.x, r.y, r.width, r.height].map(Math.round)))} ; export ${size}` };
      });
    });

    await test('texte vide abandonné, multi-ligne conservé', () =>
      inEditor(context, home, medium, async (viewer) => {
        const { keyboard } = viewer;
        await keyboard.press('t');
        await clickAt(viewer, { x: 1000, y: 300 });
        const opened = await viewer.locator('.editor-text').count();
        await clickAt(viewer, { x: 1900, y: 1000 });
        const closed = await viewer.locator('.editor-text').count();
        // Un rectangle sert de repère : quand il est enregistré, un texte vide aurait dû l'être aussi.
        await keyboard.press('r');
        await drag(viewer, { x: 1000, y: 500 }, { x: 1600, y: 800 });
        await keyboard.press('t');
        await clickAt(viewer, { x: 1000, y: 1300 });
        await keyboard.type('Ligne A');
        await keyboard.press('Enter');
        await keyboard.type('Ligne B ');
        await keyboard.insertText('🙂');
        await keyboard.press('Meta+Enter');
        const items = await waitForItems(viewer, medium, 2);
        const note = items.find((item) => item.type === 'text');
        // L'emoji s'exporte : de la couleur de son visage dans la deuxième ligne du texte (48 px de haut, à partir de y 1358), à droite des mots.
        await finish(viewer);
        const { result } = await copyAndAnalyze(viewer, copyButton(viewer, 0), yellowPixels, [{ x: 1000, y: 1358, w: 400, h: 60 }]);
        const ok = opened === 1 && closed === 0 && items.length === 2 && note?.text === 'Ligne A\nLigne B 🙂' && result[0] > 200;
        return { ok, detail: `${items.length} éléments (${items.map((i) => i.type)}) ; texte ${JSON.stringify(note?.text)} ; pixels d'emoji à l'export ${result[0]}` };
      }));

    await test('texte : Échap valide sans fermer l’éditeur', () =>
      inEditor(context, home, medium, async (viewer) => {
        await viewer.keyboard.press('t');
        await clickAt(viewer, { x: 1000, y: 1300 });
        await viewer.keyboard.type('Note');
        await viewer.keyboard.press('Escape');
        const [note] = await waitForItems(viewer, medium, 1);
        const stillOpen = await viewer.locator('#editor').isVisible();
        // Une fois la saisie validée, Échap ferme l'éditeur.
        await viewer.keyboard.press('Escape');
        await viewer.waitForSelector('#editor', { state: 'hidden' });
        return { ok: stillOpen && note?.text === 'Note', detail: `texte ${JSON.stringify(note?.text)}, éditeur resté ouvert ${stillOpen}` };
      }));

    await test('petit glissement ignoré', () =>
      inEditor(context, home, medium, async (viewer) => {
        await viewer.keyboard.press('r');
        const { x, y } = await viewer.evaluate(windowPoint, { x: 1000, y: 500 });
        await viewer.mouse.move(x, y);
        await viewer.mouse.down();
        await viewer.mouse.move(x + 1.5, y + 1.5);
        await viewer.mouse.up();
        // Le vrai rectangle, enregistré le dernier : s'il y avait eu un élément pour le petit glissement, il serait avant lui.
        await drag(viewer, { x: 1500, y: 700 }, { x: 1900, y: 900 });
        const items = await waitForItems(viewer, medium, 1);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const settled = await storedItems(viewer, medium);
        return { ok: settled.length === 1 && settled[0].x > 1400, detail: `${settled.length} élément(s)` };
      }));

    await test('rechargement : annotations retrouvées', () =>
      inEditor(context, home, medium, async (viewer) => {
        acceptLeaving(viewer);
        await viewer.keyboard.press('r');
        await drag(viewer, { x: 1000, y: 500 }, { x: 1600, y: 800 });
        // Rechargé tout de suite après le tracé : même si l'écriture n'est pas finie, la page attend qu'on la laisse partir.
        await viewer.reload();
        await viewer.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
        const items = await storedItems(viewer, medium);
        // Le bord gauche du rectangle (x 1000) dans l'aperçu.
        const pixel = await viewer.evaluate(previewPixelAt, [1000, 650]);
        return { ok: items.length === 1 && items[0].type === 'rect' && isReddish(pixel), detail: `${items.length} élément(s), aperçu ${pixel}` };
      }));

    await test('fermer l’éditeur met à jour l’aperçu', () =>
      inEditor(context, home, medium, async (viewer) => {
        await viewer.keyboard.press('s');
        await viewer.getByRole('button', { name: 'Rouge', exact: true }).click();
        await drag(viewer, { x: 1000, y: 1000 }, { x: 1600, y: 1400 });
        await waitForItems(viewer, medium, 1);
        await finish(viewer);
        const pixel = await viewer.evaluate(previewPixelAt, [1300, 1200]);
        return { ok: isReddish(pixel), detail: `aperçu ${pixel}` };
      }));

    await test('échec d’enregistrement signalé puis rattrapé', () =>
      inEditor(context, home, medium, async (viewer) => {
        await viewer.keyboard.press('r');
        await viewer.evaluate(() => {
          window.realPut = IDBObjectStore.prototype.put;
          IDBObjectStore.prototype.put = () => {
            throw new Error('disque plein');
          };
        });
        await drag(viewer, { x: 1000, y: 500 }, { x: 1600, y: 800 });
        const alert = viewer.locator('#editor-alert');
        await alert.waitFor({ state: 'visible', timeout: 5000 });
        const shown = {
          role: await alert.getAttribute('role'),
          text: (await alert.innerText()).trim(),
          header: await viewer.locator('#save-alert').isVisible(),
        };
        await viewer.evaluate(() => (IDBObjectStore.prototype.put = window.realPut));
        await drag(viewer, { x: 1000, y: 900 }, { x: 1600, y: 1100 });
        await alert.waitFor({ state: 'hidden', timeout: 5000 });
        const items = await waitForItems(viewer, medium, 2);
        const ok =
          shown.role === 'alert' && shown.text.startsWith('L’enregistrement a échoué') && shown.header && items.length === 2 && items.every((item) => item.type === 'rect');
        return { ok, detail: `bandeau « ${shown.text.slice(0, 40)}… » ; après rattrapage ${items.length} rectangle(s)` };
      }));

    await test('recharger pendant la saisie d’un texte', () =>
      inEditor(context, home, medium, async (viewer) => {
        acceptLeaving(viewer);
        await viewer.keyboard.press('t');
        await clickAt(viewer, { x: 1000, y: 1300 });
        await viewer.keyboard.type('Brouillon');
        await viewer.reload();
        await viewer.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
        const items = await waitForItems(viewer, medium, 1);
        return { ok: items.length === 1 && items[0].text === 'Brouillon', detail: JSON.stringify(items.map((item) => item.text)) };
      }));

    // Le test précédent passe par `beforeunload` (la confirmation laisse le temps d'écrire) ; celui-ci lance `pagehide` seul.
    await test('pagehide : le texte en cours de saisie est validé et enregistré', () =>
      inEditor(context, home, medium, async (viewer) => {
        await viewer.keyboard.press('t');
        await clickAt(viewer, { x: 1000, y: 1300 });
        await viewer.keyboard.type('Départ');
        await viewer.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
        const items = await waitForItems(viewer, medium, 1);
        const fields = await viewer.locator('.editor-text').count();
        return { ok: items.length === 1 && items[0].text === 'Départ' && fields === 0, detail: `${JSON.stringify(items.map((item) => item.text))}, champs restants ${fields}` };
      }));

    // Fond transparent et liseré du texte final : l'éditeur sombre ne pose pas un bloc gris sur la capture blanche, et le jaune garde son encre.
    await test('champ de saisie lisible en clair et en sombre', () =>
      inEditor(context, home, medium, async (viewer) => {
        const problems = [];
        const cases = [['dark', 'Noir', INK], ['dark', 'Rouge', RED], ['light', 'Jaune', YELLOW], ['light', 'Rouge', RED], ['dark', 'Jaune', YELLOW]];
        for (const [i, [scheme, name, rgb]] of cases.entries()) {
          await viewer.emulateMedia({ colorScheme: scheme });
          await viewer.keyboard.press('t');
          await viewer.getByRole('button', { name, exact: true }).click();
          // Un champ par cas, à des hauteurs différentes : le texte validé du cas précédent ne gêne pas la lecture du suivant.
          await clickAt(viewer, { x: 1000, y: 700 + 100 * i });
          await viewer.keyboard.type('Texte de test');
          const png = await viewer.locator('.editor-text').screenshot();
          const { dominant, near } = await viewer.evaluate(screenColors, { bytes: png.toString('base64'), probes: [rgb, INK] });
          const label = `${scheme}/${name}`;
          // La capture est blanche : sans fond propre au champ, la couleur dominante reste blanche.
          if (!dominant.every((c) => c >= 240)) problems.push(`${label} : fond ${dominant}`);
          if (near[0] < 20) problems.push(`${label} : texte invisible (${near[0]} pixels)`);
          if (name === 'Jaune' && near[1] < 20) problems.push(`${label} : liseré d’encre absent (${near[1]} pixels)`);
          await viewer.keyboard.press('Escape');
        }
        await viewer.emulateMedia({ colorScheme: null });
        return { ok: problems.length === 0, detail: problems.length ? problems.join(' ; ') : `${cases.length} cas lisibles` };
      }));

    await test('gestes dans la marge grise : aucune annotation vide', () =>
      // Fenêtre large : la capture, affichée à 50 %, laisse une marge grise de chaque côté.
      inEditor(
        context,
        home,
        medium,
        async (viewer) => {
          const { keyboard } = viewer;
          // Tout dans la marge gauche (x négatif dans la capture) : trois tracés à la souris, une pastille, un texte.
          for (const [i, key] of ['f', 'c', 'r', 's', 'm'].entries()) {
            await keyboard.press(key);
            await drag(viewer, { x: -400, y: 900 + 60 * i }, { x: -100, y: 900 + 60 * i });
          }
          await keyboard.press('n');
          await clickAt(viewer, { x: -250, y: 1400 });
          await keyboard.press('t');
          await clickAt(viewer, { x: -250, y: 1500 });
          const fields = await viewer.locator('.editor-text').count();
          // Un geste qui part de la marge et entre dans la capture reste une vraie flèche ; le rectangle ferme la série.
          await keyboard.press('f');
          await drag(viewer, { x: -250, y: 700 }, { x: 600, y: 700 });
          await keyboard.press('r');
          await drag(viewer, { x: 1000, y: 500 }, { x: 1600, y: 800 });
          await waitForItems(viewer, medium, 2);
          await new Promise((resolve) => setTimeout(resolve, 300));
          const items = await storedItems(viewer, medium);
          const arrow = items[0]?.points;
          const length = arrow ? Math.hypot(arrow[2] - arrow[0], arrow[3] - arrow[1]) : 0;
          const ok = fields === 0 && items.map((item) => item.type).join() === 'arrow,rect' && length > 100;
          return { ok, detail: `${items.map((item) => item.type)} ; champ de texte ${fields} ; flèche ${Math.round(length)} px` };
        },
        { width: 1800 },
      ));

    // Un masque lit le liseré de la capture avant d'être enregistré ; on ralentit cette lecture pour le tenir en création.
    await test('annotation en cours de création : quitter la page demande confirmation', () =>
      inEditor(context, home, medium, async (viewer) => {
        await viewer.evaluate(async () => {
          const { Stitcher } = await import(chrome.runtime.getURL('viewer/stitcher.js'));
          const read = Stitcher.prototype.sumPixels;
          Stitcher.prototype.sumPixels = async function slowRead(...args) {
            await new Promise((resolve) => setTimeout(resolve, 400));
            return read.apply(this, args);
          };
        });
        const idle = await viewer.evaluate(leavingIsBlocked);
        await viewer.keyboard.press('m');
        await drag(viewer, { x: 60, y: 140 }, { x: 460, y: 220 });
        const creating = await viewer.evaluate(leavingIsBlocked);
        // « Terminer » attend la fin de la création : l'éditeur est en cours de fermeture, la page reste retenue.
        await viewer.getByRole('button', { name: 'Terminer', exact: true }).click();
        const closing = await viewer.evaluate(leavingIsBlocked);
        const items = await waitForItems(viewer, medium, 1);
        await viewer.waitForSelector('#editor', { state: 'hidden' });
        // Une fois la création faite puis l'écriture finie, plus rien ne retient la page.
        await viewer.waitForFunction(`!(${leavingIsBlocked})()`, null, { timeout: 5000 });
        return { ok: !idle && creating && closing && items.length === 1 && items[0].type === 'mask', detail: `au repos ${idle}, pendant la création ${creating}, pendant la fermeture ${closing}, ${items.length} élément(s)` };
      }));

    await test('Copier dans l’éditeur', () =>
      inEditor(context, home, medium, async (viewer) => {
        await viewer.keyboard.press('r');
        await drag(viewer, { x: 1000, y: 500 }, { x: 1600, y: 800 });
        await waitForItems(viewer, medium, 1);
        const probe = [{ x: 996, y: 640, w: 8, h: 20, rgb: RED }];
        const found = {};
        const button = await copyAndAnalyze(viewer, viewer.locator('#editor-copy'), colorProbes, probe);
        found['bouton « Copier l’image 1 »'] = button.result[0] && button.size.startsWith('2560 × ');
        found['⌘C'] = (await copyAndAnalyze(viewer, { click: () => viewer.keyboard.press('Meta+c') }, colorProbes, probe)).result[0];
        const missing = Object.entries(found).filter(([, ok]) => !ok).map(([name]) => name);
        return { ok: missing.length === 0, detail: missing.length ? `sans annotation : ${missing.join(', ')}` : `bouton : ${button.size}` };
      }));

    // Le second masque, tracé d'abord, a son liseré en partie sous le premier. Deux captures identiques sauf sous le premier masque
    // (un aplat noir dans l'une, la page blanche dans l'autre) doivent donner les mêmes masques, teintes comprises.
    await test('masques qui se touchent : la teinte ne dépend pas de ce qu’ils cachent', async () => {
      const darkUnder = await seedCapture(home, {
        heightPoints: 3000,
        draw: (ctx) => {
          ctx.fillStyle = '#000';
          ctx.fillRect(1000, 300, 400, 100);
        },
      });
      const whiteUnder = await seedCapture(home, { heightPoints: 3000 });
      const masks = [];
      for (const id of [darkUnder, whiteUnder]) {
        masks.push(
          await inEditor(context, home, id, async (viewer) => {
            await viewer.keyboard.press('m');
            await drag(viewer, { x: 1380, y: 300 }, { x: 1780, y: 400 });
            await waitForItems(viewer, id, 1);
            await drag(viewer, { x: 1000, y: 300 }, { x: 1400, y: 400 });
            const items = await waitForItems(viewer, id, 2);
            return items.map(({ x, y, width, height, fill }) => `${x},${y} ${width}×${height} ${fill}`);
          }),
        );
      }
      return { ok: masks[0].length === 2 && masks[0].join() === masks[1].join(), detail: `aplat noir caché : ${masks[0].join(' ; ')} — page blanche : ${masks[1].join(' ; ')}` };
    });

    await test('outil surligneur : tailles inactives', () =>
      inEditor(context, home, medium, async (viewer) => {
        const sizesOff = () => viewer.evaluate(() => [...document.querySelectorAll('.editor-size')].every((button) => button.disabled));
        await viewer.keyboard.press('s');
        const highlight = await sizesOff();
        await viewer.keyboard.press('r');
        const rect = await sizesOff();
        return { ok: highlight && !rect, detail: `tailles inactives : outil surligneur ${highlight}, outil rectangle ${rect}` };
      }));

    // Le champ se place là où sera le texte validé : près du bord droit, il glisse vers l'intérieur pendant la frappe.
    await test('texte près du bord droit : il ne saute pas à la validation', () =>
      inEditor(context, home, medium, async (viewer) => {
        await viewer.keyboard.press('t');
        await clickAt(viewer, { x: 2300, y: 1300 });
        await viewer.keyboard.type('Un texte assez long pour dépasser le bord droit');
        const field = await viewer.evaluate(() => {
          const box = document.querySelector('.editor-text').getBoundingClientRect();
          const page = document.getElementById('editor-page').getBoundingClientRect();
          const scale = Number(document.getElementById('editor').dataset.scale);
          return { x: (box.left - page.left) / scale, y: (box.top - page.top) / scale };
        });
        await viewer.keyboard.press('Escape');
        const [item] = await waitForItems(viewer, medium, 1);
        const ok = Boolean(item) && near(item.x, field.x, 4) && near(item.y, field.y, 4) && item.x < 2000;
        return { ok, detail: `champ à ${Math.round(field.x)},${Math.round(field.y)} ; texte validé à ${Math.round(item?.x)},${Math.round(item?.y)}` };
      }));

    await test('clic droit dans l’éditeur : pas de menu de Chrome, sauf dans un texte', () =>
      inEditor(context, home, medium, async (viewer) => {
        const prevented = (selector) =>
          viewer.evaluate((selector) => {
            const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 600, clientY: 400 });
            document.querySelector(selector).dispatchEvent(event);
            return event.defaultPrevented;
          }, selector);
        const onStage = await prevented('#editor-stage canvas');
        await viewer.keyboard.press('t');
        await clickAt(viewer, { x: 1000, y: 1300 });
        const inField = await prevented('.editor-text');
        await viewer.keyboard.press('Escape');
        return { ok: onStage && !inField, detail: `menu de Chrome bloqué sur le calque ${onStage}, dans le champ de texte ${inField}` };
      }));

    await test('fenêtre basse : toute la barre d’outils est visible', () =>
      inEditor(context, home, medium, async (viewer) => {
        const cut = async (height, banner) => {
          await viewer.setViewportSize({ width: 1280, height });
          await viewer.evaluate((banner) => {
            const alert = document.getElementById('editor-alert');
            alert.textContent = banner ? 'L’enregistrement a échoué : tes dernières annotations ne sont pas sauvegardées. Elles le seront à la prochaine modification.' : '';
            alert.hidden = !banner;
          }, banner);
          await frames(viewer);
          return viewer.evaluate(() => {
            const bar = document.getElementById('editor-tools').getBoundingClientRect();
            return [...document.querySelectorAll('#editor-tools button')]
              .filter((button) => button.getBoundingClientRect().bottom > Math.min(bar.bottom, innerHeight) + 0.5)
              .map((button) => button.getAttribute('aria-label'));
          });
        };
        const seen = { '640 px': await cut(640, false), '640 px avec bandeau': await cut(640, true), '552 px': await cut(552, false) };
        const ok = Object.values(seen).every((hidden) => hidden.length === 0);
        return { ok, detail: Object.entries(seen).map(([name, hidden]) => `${name} : ${hidden.length ? `coupés ${hidden.join(', ')}` : '15 boutons visibles'}`).join(' ; ') };
      }));

    // Après un échec, plus aucune écriture n'est en cours : la fermeture est retenue quand même, et l'écriture est retentée.
    await test('fermer l’onglet après un échec d’enregistrement : confirmation, puis écriture retentée', () =>
      inEditor(context, home, medium, async (viewer) => {
        await viewer.keyboard.press('r');
        await viewer.evaluate(() => {
          window.realPut = IDBObjectStore.prototype.put;
          IDBObjectStore.prototype.put = () => {
            throw new Error('disque plein');
          };
        });
        await drag(viewer, { x: 1000, y: 500 }, { x: 1600, y: 800 });
        await viewer.locator('#editor-alert').waitFor({ state: 'visible', timeout: 5000 });
        await finish(viewer);
        await viewer.evaluate(() => (IDBObjectStore.prototype.put = window.realPut));
        const blocked = await viewer.evaluate(leavingIsBlocked);
        const items = await waitForItems(viewer, medium, 1);
        await viewer.locator('#save-alert').waitFor({ state: 'hidden', timeout: 5000 });
        const after = await viewer.evaluate(leavingIsBlocked);
        return { ok: blocked && items.length === 1 && !after, detail: `fermeture retenue ${blocked} ; ${items.length} annotation(s) après la nouvelle tentative ; ensuite retenue ${after}` };
      }));
  } finally {
    await home.close();
  }
}

// ---- Éditeur : retoucher, annuler, tout effacer (tâche 5) ----

// Les deux fonctions suivantes s'exécutent dans la page : elles lisent la scène Konva de l'éditeur (la dernière créée).

// Le cadre de sélection : annotations qu'il entoure (une flèche n'a pas de cadre), poignées de coin offertes, échelle des
// annotations entourées (elle doit rester à 1 : un redimensionnement change la largeur et la hauteur) et poignées d'extrémité
// visibles (flèche sélectionnée).
function selectionState() {
  const stage = Konva.stages.at(-1);
  const frame = stage.findOne('Transformer');
  const nodes = frame ? frame.nodes() : [];
  return {
    framed: nodes.map((node) => node.name()),
    corners: nodes.length && frame.resizeEnabled() ? frame.enabledAnchors().length : 0,
    scales: nodes.map((node) => [node.scaleX(), node.scaleY()]),
    ends: stage.find('.handle').filter((node) => node.isVisible()).length,
  };
}

// Annotations dessinées (masques et autres formes) : leur nombre et, parmi `ids`, celles qui le sont.
function drawnAnnotations(ids) {
  const [layer] = Konva.stages.at(-1).getLayers();
  const [masks, shapes] = layer.getChildren();
  return { count: masks.getChildren().length + shapes.getChildren().length, present: ids.filter((id) => layer.findOne((node) => node.name() === id)) };
}

// Centre d'une poignée du cadre de sélection ('top-left', 'bottom-right'…) ou d'une extrémité de flèche ('handle:0' ou 'handle:1'),
// en coordonnées de la fenêtre.
function handlePoint(name) {
  const stage = Konva.stages.at(-1);
  const handle = name.startsWith('handle:') ? stage.find('.handle')[Number(name.slice(-1))] : stage.findOne('Transformer').findOne(`.${name}`);
  const box = stage.container().getBoundingClientRect();
  const { x, y } = handle.getAbsolutePosition();
  return { x: box.left + x, y: box.top + y };
}

// Dans la page : emprise de l'annotation `id` telle que la scène la dessine, en pixels de la capture (trait compris).
function drawnBox(id) {
  const [layer] = Konva.stages.at(-1).getLayers();
  const box = layer.findOne((node) => node.name() === id).getClientRect({ relativeTo: layer });
  return { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height };
}

// Dans la page : écart entre chaque poignée d'extrémité et l'extrémité de la flèche `id` telle qu'elle est dessinée (le nœud
// peut être décalé pendant un déplacement), et décalage du nœud, en pixels de la capture.
function handleGaps(id) {
  const stage = Konva.stages.at(-1);
  const arrow = stage.findOne(`.${id}`);
  const points = arrow.points();
  const gaps = stage.find('.handle').map((handle, i) => Math.hypot(handle.x() - (arrow.x() + points[2 * i]), handle.y() - (arrow.y() + points[2 * i + 1])));
  return { gaps, offset: Math.hypot(arrow.x(), arrow.y()) };
}

const scrollTopOf = (viewer) => viewer.evaluate(() => document.getElementById('editor-scroll').scrollTop);

// Attend que le défilement de la zone de l'éditeur soit arrêté, et rend sa position.
async function settledScroll(viewer) {
  let last = await scrollTopOf(viewer);
  for (let i = 0; i < 50; i++) {
    await viewer.waitForTimeout(150);
    const now = await scrollTopOf(viewer);
    if (now === last) return now;
    last = now;
  }
  return last;
}

const scaleOf = (viewer) => viewer.evaluate(() => Number(document.getElementById('editor').dataset.scale));
// Attend deux images : le calque et sa zone de détection des clics sont redessinés.
const frames = (viewer) => viewer.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const near = (value, wanted, tolerance) => Math.abs(value - wanted) <= tolerance;
const historyButton = (viewer, name) => viewer.locator('.editor-history').getByRole('button', { name, exact: true });
const hasSelection = (state) => state.framed.length + state.ends > 0;

// Clique sur un point de la capture et rend l'état de la sélection.
async function selectAt(viewer, point) {
  await clickAt(viewer, point);
  await frames(viewer);
  return viewer.evaluate(selectionState);
}

// Glisse la souris d'un point de la fenêtre à un autre.
async function dragWindow(viewer, from, to) {
  await viewer.mouse.move(from.x, from.y);
  await viewer.mouse.down();
  await viewer.mouse.move(to.x, to.y, { steps: 10 });
  await viewer.mouse.up();
  await frames(viewer);
}

// Attend (5 s au plus) que les annotations enregistrées remplissent `ready`, et les rend.
async function storedWhen(viewer, id, ready) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const items = await storedItems(viewer, id);
    if (ready(items) || Date.now() > deadline) return items;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// Ouvre l'éditeur sur l'image 1 d'une capture dont les annotations de départ sont `items`, puis exécute `run`.
function editing(context, home, id, items, run) {
  return annotated(context, home, id, items, async (viewer) => {
    await openEditorOn(viewer, 0);
    return run(viewer);
  });
}

const BOX = { id: 'r1', type: 'rect', color: 'red', size: 'm', x: 1000, y: 500, width: 600, height: 300 };

async function testRetouch(context) {
  console.log('\n— Éditeur : retoucher, annuler, tout effacer');
  const home = await extensionPage(context, 'popup/popup.html');
  try {
    await resetDb(home);
    // 12 000 points à ×2 : 2 560 × 24 000 px, trois images ; une bande magenta tous les 2 000 px (de 2 000 à 2 080, 4 000 à 4 080…).
    const medium = await seedCapture(home, { heightPoints: 12000 });

    await test('sélection et déplacement', () =>
      editing(context, home, medium, [BOX], async (viewer) => {
        // L'outil actif n'y change rien : un clic sur une annotation la sélectionne.
        await viewer.keyboard.press('f');
        const selected = await selectAt(viewer, { x: 1000, y: 650 });
        const stored = await storedItems(viewer, medium);
        await drag(viewer, { x: 1000, y: 650 }, { x: 1200, y: 650 });
        const [moved] = await storedWhen(viewer, medium, ([item]) => item.x !== BOX.x);
        // Tirée au-delà du bord droit de la capture, l'annotation s'arrête au bord.
        const edge = await viewer.evaluate(windowPoint, { x: 2560, y: 500 });
        await drag(viewer, { x: 1500, y: 500 }, { window: { x: edge.x + 10, y: edge.y } });
        const [pushed] = await storedWhen(viewer, medium, ([item]) => item.x !== moved.x);
        await finish(viewer);
        const probes = [{ x: 1956, y: 640, w: 8, h: 20, rgb: RED }, { x: 996, y: 640, w: 8, h: 20, rgb: RED }];
        const { result } = await copyAndAnalyze(viewer, copyButton(viewer, 0), colorProbes, probes);
        const ok =
          selected.framed.join() === 'r1' && selected.corners === 4 && stored.length === 1 &&
          near(moved.x, 1200, 3) && near(moved.y, BOX.y, 2) && moved.width === BOX.width && moved.height === BOX.height &&
          near(pushed.x + pushed.width, 2560, 0.01) && near(pushed.y, BOX.y, 2) &&
          result[0] && !result[1];
        return { ok, detail: `sélection ${selected.framed} (${selected.corners} coins) ; déplacé en x ${moved.x}, au bord x ${pushed.x} ; export : nouveau bord ${result[0]}, ancien ${result[1]}` };
      }));

    await test('déplacement : suit la molette pendant le geste', () =>
      editing(context, home, medium, [BOX], async (viewer) => {
        await selectAt(viewer, { x: 1000, y: 650 });
        const view = await scaleOf(viewer);
        const grab = await viewer.evaluate(windowPoint, { x: 1000, y: 650 });
        const before = await scrollTopOf(viewer);
        await viewer.mouse.move(grab.x, grab.y);
        await viewer.mouse.down();
        await viewer.mouse.move(grab.x, grab.y + 20, { steps: 5 });
        // La molette défile la capture sous le pointeur, bouton enfoncé : le rectangle doit suivre le pointeur.
        await viewer.mouse.wheel(0, 300);
        const after = await settledScroll(viewer);
        await viewer.mouse.move(grab.x, grab.y + 40, { steps: 5 });
        await viewer.mouse.up();
        await frames(viewer);
        const [moved] = await storedWhen(viewer, medium, ([item]) => item.y !== BOX.y);
        const wanted = (40 + after - before) / view;
        const ok = after - before > 200 && near(moved.y - BOX.y, wanted, 3) && near(moved.x, BOX.x, 2);
        return { ok, detail: `défilement ${(after - before).toFixed(0)} points ; déplacé de ${(moved.y - BOX.y).toFixed(0)} px de capture (attendu ${wanted.toFixed(0)})` };
      }));

    await test('flèche déplacée : les poignées suivent', () =>
      editing(context, home, medium, [{ id: 'ar', type: 'arrow', color: 'blue', size: 'm', points: [800, 300, 1400, 300] }], async (viewer) => {
        await selectAt(viewer, { x: 1100, y: 300 });
        const from = await viewer.evaluate(windowPoint, { x: 1100, y: 300 });
        const to = await viewer.evaluate(windowPoint, { x: 1100, y: 700 });
        await viewer.mouse.move(from.x, from.y);
        await viewer.mouse.down();
        await viewer.mouse.move(to.x, to.y, { steps: 10 });
        await frames(viewer);
        // Souris encore enfoncée : la flèche a bougé, ses deux poignées sont restées sur ses extrémités.
        const during = await viewer.evaluate(handleGaps, 'ar');
        await viewer.mouse.up();
        const [moved] = await storedWhen(viewer, medium, ([item]) => item.points[1] !== 300);
        await frames(viewer);
        const after = await viewer.evaluate(handleGaps, 'ar');
        const aligned = (state) => state.gaps.length === 2 && state.gaps.every((gap) => gap < 0.5);
        const ok = during.offset > 100 && aligned(during) && aligned(after) && moved.points[1] > 300 && moved.points[0] === 800;
        return { ok, detail: `en cours de déplacement : nœud décalé de ${during.offset.toFixed(0)} px, écarts des poignées ${during.gaps.map((gap) => gap.toFixed(1))} ; après : ${after.gaps.map((gap) => gap.toFixed(1))}` };
      }));

    await test('redimensionnement', () =>
      editing(context, home, medium, [BOX], async (viewer) => {
        await selectAt(viewer, { x: 1000, y: 650 });
        // Le cadre suit le défilement et la largeur de la fenêtre : on tire un coin après avoir fait défiler, puis redimensionné la fenêtre.
        await viewer.evaluate(scrollEditorTo, 200);
        const wide = await scaleOf(viewer);
        await viewer.setViewportSize({ width: 1100, height: 900 });
        await viewer.waitForFunction((was) => Number(document.getElementById('editor').dataset.scale) !== was, wide);
        await editorReady(viewer);
        await frames(viewer);
        const view = await scaleOf(viewer);
        const bottomRight = await viewer.evaluate(handlePoint, 'bottom-right');
        const corner0 = await viewer.evaluate(windowPoint, { x: BOX.x + BOX.width, y: BOX.y + BOX.height });
        const followed = Math.hypot(bottomRight.x - corner0.x, bottomRight.y - corner0.y) < 2;
        await dragWindow(viewer, bottomRight, { x: bottomRight.x + 50, y: bottomRight.y + 30 });
        const [grown] = await storedWhen(viewer, medium, ([item]) => item.width !== BOX.width);
        const topLeft = await viewer.evaluate(handlePoint, 'top-left');
        await dragWindow(viewer, topLeft, { x: topLeft.x + 40, y: topLeft.y + 20 });
        const [cropped] = await storedWhen(viewer, medium, ([item]) => item.x !== grown.x);
        // Tiré au-delà du bord droit de la capture, le coin s'arrête au bord.
        const corner = await viewer.evaluate(handlePoint, 'bottom-right');
        const edge = await viewer.evaluate(windowPoint, { x: 2560, y: 0 });
        await dragWindow(viewer, corner, { x: edge.x + 8, y: corner.y });
        const [pushed] = await storedWhen(viewer, medium, ([item]) => item.width !== cropped.width);
        const state = await viewer.evaluate(selectionState);
        const keys = (item) => Object.keys(item).sort().join();
        const ok =
          followed && near(grown.width, BOX.width + 50 / view, 3) && near(grown.height, BOX.height + 30 / view, 3) && near(grown.x, BOX.x, 2) && near(grown.y, BOX.y, 2) &&
          near(cropped.x, BOX.x + 40 / view, 3) && near(cropped.x + cropped.width, grown.x + grown.width, 2) && near(cropped.y + cropped.height, grown.y + grown.height, 2) &&
          near(pushed.x + pushed.width, 2560, 0.01) &&
          [grown, cropped, pushed].every((item) => keys(item) === keys(BOX)) &&
          state.framed.join() === 'r1' && state.scales.every(([sx, sy]) => sx === 1 && sy === 1);
        return { ok, detail: `coin bas droit → ${grown.width.toFixed(1)} × ${grown.height.toFixed(1)} ; coin haut gauche → x ${cropped.x.toFixed(1)} ; au bord → droite ${(pushed.x + pushed.width).toFixed(1)} ; échelle ${JSON.stringify(state.scales)}` };
      }));

    await test('flèche : poignées aux extrémités', () =>
      editing(context, home, medium, [{ id: 'ar', type: 'arrow', color: 'blue', size: 'm', points: [800, 300, 1400, 300] }], async (viewer) => {
        const view = await scaleOf(viewer);
        await viewer.keyboard.press('r');
        const before = await viewer.evaluate(selectionState);
        const state = await selectAt(viewer, { x: 1100, y: 300 });
        const ends = [await viewer.evaluate(handlePoint, 'handle:0'), await viewer.evaluate(handlePoint, 'handle:1')];
        const wanted = [await viewer.evaluate(windowPoint, { x: 800, y: 300 }), await viewer.evaluate(windowPoint, { x: 1400, y: 300 })];
        const placed = ends.every((end, i) => Math.hypot(end.x - wanted[i].x, end.y - wanted[i].y) < 2);
        await dragWindow(viewer, ends[1], { x: ends[1].x, y: ends[1].y + 80 });
        const [tipMoved] = await storedWhen(viewer, medium, ([item]) => item.points[3] !== 300);
        const tail = await viewer.evaluate(handlePoint, 'handle:0');
        await dragWindow(viewer, tail, { x: tail.x, y: tail.y - 60 });
        const [tailMoved] = await storedWhen(viewer, medium, ([item]) => item.points[1] !== 300);
        const ok =
          before.ends === 0 && state.ends === 2 && state.framed.length === 0 && placed &&
          tipMoved.points.slice(0, 2).join() === '800,300' && near(tipMoved.points[2], 1400, 3) && near(tipMoved.points[3], 300 + 80 / view, 3) &&
          near(tailMoved.points[0], 800, 3) && near(tailMoved.points[1], 300 - 60 / view, 3) && tailMoved.points.slice(2).join() === tipMoved.points.slice(2).join();
        return { ok, detail: `poignées ${state.ends} (aux extrémités : ${placed}) ; pointe → ${tipMoved.points.map((n) => n.toFixed(0))} ; queue → ${tailMoved.points.map((n) => n.toFixed(0))}` };
      }));

    await test('suppression', () =>
      editing(
        context,
        home,
        medium,
        [BOX, { id: 'b1', type: 'badge', color: 'red', size: 'm', x: 600, y: 1000 }, { id: 'b2', type: 'badge', color: 'red', size: 'm', x: 900, y: 1000 }],
        async (viewer) => {
          // Avec l'outil pastille, un clic sur une pastille la sélectionne au lieu d'en poser une troisième.
          await viewer.keyboard.press('n');
          const selected = await selectAt(viewer, { x: 600, y: 1000 });
          const untouched = await storedItems(viewer, medium);
          await viewer.keyboard.press('Backspace');
          const afterBadge = await storedWhen(viewer, medium, (items) => items.length === 2);
          const texts = await viewer.evaluate(konvaTexts);
          await selectAt(viewer, { x: 1000, y: 650 });
          await viewer.keyboard.press('Delete');
          const afterRect = await storedWhen(viewer, medium, (items) => items.length === 1);
          const cleared = await viewer.evaluate(selectionState);
          // Sans sélection, ⌫ ne fait rien.
          await viewer.keyboard.press('Backspace');
          await frames(viewer);
          const last = await storedItems(viewer, medium);
          const ok =
            selected.framed.join() === 'b1' && untouched.length === 3 &&
            afterBadge.map((item) => item.id).join() === 'r1,b2' && texts.join() === '1' &&
            afterRect.map((item) => item.id).join() === 'b2' && !hasSelection(cleared) &&
            last.map((item) => item.id).join() === 'b2';
          return { ok, detail: `après ⌫ : ${afterBadge.map((item) => item.id)}, numéros affichés ${texts} ; après Suppr : ${afterRect.map((item) => item.id)}` };
        },
      ));

    await test('double-clic : modifier un texte', () =>
      editing(context, home, medium, [{ id: 'tx', type: 'text', color: 'red', size: 'l', x: 400, y: 1300, text: 'Avant' }], async (viewer) => {
        const field = viewer.locator('.editor-text');
        const inText = await viewer.evaluate(windowPoint, { x: 450, y: 1340 });
        await viewer.mouse.dblclick(inText.x, inText.y);
        await field.waitFor({ timeout: 5000 });
        const opened = await field.inputValue();
        await viewer.keyboard.press('ControlOrMeta+a');
        await viewer.keyboard.type('Après');
        // Un clic ailleurs valide le texte.
        await clickAt(viewer, { x: 1900, y: 300 });
        const [edited] = await storedWhen(viewer, medium, ([item]) => item.text !== 'Avant');
        const texts = await viewer.evaluate(konvaTexts);
        // Vidé, le texte disparaît ; Échap valide sans fermer l'éditeur.
        await viewer.mouse.dblclick(inText.x, inText.y);
        await field.waitFor({ timeout: 5000 });
        await viewer.keyboard.press('ControlOrMeta+a');
        await viewer.keyboard.press('Backspace');
        await viewer.keyboard.press('Escape');
        const emptied = await storedWhen(viewer, medium, (items) => items.length === 0);
        const open = await viewer.locator('#editor').isVisible();
        const ok = opened === 'Avant' && edited.id === 'tx' && edited.text === 'Après' && texts.join() === 'Après' && emptied.length === 0 && open;
        return { ok, detail: `champ ouvert sur « ${opened} » ; texte → « ${edited.text} » (id ${edited.id}) ; vidé : ${emptied.length} annotation(s), éditeur ${open ? 'ouvert' : 'fermé'}` };
      }));

    await test('couleur appliquée à la sélection', () =>
      editing(context, home, medium, [BOX], async (viewer) => {
        await viewer.keyboard.press('r');
        await selectAt(viewer, { x: 1000, y: 650 });
        const shown = await colorPressed(viewer);
        await viewer.getByRole('button', { name: 'Vert', exact: true }).click();
        const [recolored] = await storedWhen(viewer, medium, ([item]) => item.color !== 'red');
        // Le vert devient aussi la couleur du rectangle suivant.
        await selectAt(viewer, { x: 1900, y: 1500 });
        await drag(viewer, { x: 1000, y: 1000 }, { x: 1600, y: 1200 });
        const items = await waitForItems(viewer, medium, 2);
        await finish(viewer);
        const probes = [{ x: 996, y: 640, w: 8, h: 20, rgb: GREEN }, { x: 996, y: 640, w: 8, h: 20, rgb: RED }];
        const { result } = await copyAndAnalyze(viewer, copyButton(viewer, 0), colorProbes, probes);
        const ok = shown.join() === 'Rouge' && recolored.color === 'green' && items[1]?.color === 'green' && result[0] && !result[1];
        return { ok, detail: `couleur affichée avant : ${shown} ; rectangle ${recolored.color}, suivant ${items[1]?.color} ; export : vert ${result[0]}, rouge ${result[1]}` };
      }));

    await test('taille appliquée à la sélection', () =>
      editing(
        context,
        home,
        medium,
        [
          { id: 'tx', type: 'text', color: 'red', size: 's', x: 400, y: 1300, text: 'Texte' },
          { id: 'pn', type: 'pen', color: 'red', size: 's', points: [1500, 700, 1700, 800, 1900, 700, 2100, 800] },
        ],
        async (viewer) => {
          const widthOfText = () => viewer.evaluate(() => Konva.stages.at(-1).findOne('.tx').width());
          const strokeOfPen = () => viewer.evaluate(() => Konva.stages.at(-1).findOne('.pn').strokeWidth());
          const big = viewer.getByRole('button', { name: 'Taille : Grand', exact: true });
          const smallWidth = await widthOfText();
          await selectAt(viewer, { x: 430, y: 1315 });
          await big.click();
          const [text] = await storedWhen(viewer, medium, (items) => items[0].size !== 's');
          const bigWidth = await widthOfText();
          await selectAt(viewer, { x: 1700, y: 800 });
          const thin = await strokeOfPen();
          await big.click();
          const [, pen] = await storedWhen(viewer, medium, (items) => items[1].size !== 's');
          const thick = await strokeOfPen();
          await viewer.keyboard.press('Meta+z');
          const [, undone] = await storedWhen(viewer, medium, (items) => items[1].size === 's');
          const undoneStroke = await strokeOfPen();
          await viewer.keyboard.press('Meta+Shift+z');
          const [, redone] = await storedWhen(viewer, medium, (items) => items[1].size === 'l');
          const redoneStroke = await strokeOfPen();
          const ok =
            text.size === 'l' && bigWidth > 1.8 * smallWidth &&
            pen.size === 'l' && thin === 4 && thick === 14 &&
            undone.size === 's' && undoneStroke === 4 && redone.size === 'l' && redoneStroke === 14;
          return { ok, detail: `texte ${smallWidth.toFixed(0)} → ${bigWidth.toFixed(0)} px ; trait ${thin} → ${thick} ; annulé ${undoneStroke}, rétabli ${redoneStroke}` };
        },
      ));

    await test('taille agrandie : texte et pastille restent dans la capture', () =>
      editing(
        context,
        home,
        medium,
        [
          { id: 'tx', type: 'text', color: 'red', size: 's', x: 2400, y: 1300, text: 'Texte' },
          { id: 'bd', type: 'badge', color: 'red', size: 's', x: 2530, y: 1000 },
        ],
        async (viewer) => {
          const big = viewer.getByRole('button', { name: 'Taille : Grand', exact: true });
          const small = [await viewer.evaluate(drawnBox, 'tx'), await viewer.evaluate(drawnBox, 'bd')];
          await selectAt(viewer, { x: 2430, y: 1315 });
          await big.click();
          const [text] = await storedWhen(viewer, medium, (items) => items[0].size === 'l');
          await selectAt(viewer, { x: 2530, y: 1000 });
          await big.click();
          const [, badge] = await storedWhen(viewer, medium, (items) => items[1].size === 'l');
          await frames(viewer);
          const large = [await viewer.evaluate(drawnBox, 'tx'), await viewer.evaluate(drawnBox, 'bd')];
          // Départ : tout est dans la capture (2 560 px). Agrandis, le texte et la pastille y restent, décalés vers la gauche.
          const inside = (boxes) => boxes.every((box) => box.right <= 2560.01);
          const ok =
            inside(small) && inside(large) && large[0].right - large[0].left > 1.8 * (small[0].right - small[0].left) &&
            text.x < 2400 && badge.x < 2530 && text.y === 1300 && badge.y === 1000;
          return { ok, detail: `bord droit du texte ${small[0].right.toFixed(0)} → ${large[0].right.toFixed(0)} (x ${text.x.toFixed(0)}), de la pastille ${small[1].right.toFixed(0)} → ${large[1].right.toFixed(0)} (x ${badge.x.toFixed(0)}), capture 2560` };
        },
      ));

    await test('cadre de sélection : coins selon le type, pas de taille pour le surligneur', () =>
      editing(
        context,
        home,
        medium,
        [
          { id: 'tx', type: 'text', color: 'red', size: 'm', x: 400, y: 1300, text: 'Texte' },
          { id: 'bd', type: 'badge', color: 'red', size: 'm', x: 900, y: 1000 },
          { id: 'pn', type: 'pen', color: 'red', size: 'm', points: [1500, 700, 1700, 800, 1900, 700, 2100, 800] },
          { id: 'hl', type: 'highlight', color: 'yellow', size: 'm', x: 1000, y: 1500, width: 600, height: 100 },
        ],
        async (viewer) => {
          const sizesDisabled = () => viewer.evaluate(() => [...document.querySelectorAll('.editor-size')].every((button) => button.disabled));
          const colorsEnabled = () => viewer.evaluate(() => [...document.querySelectorAll('.editor-color')].every((button) => !button.disabled));
          const text = await selectAt(viewer, { x: 430, y: 1315 });
          const badge = await selectAt(viewer, { x: 900, y: 1000 });
          const pen = await selectAt(viewer, { x: 1700, y: 800 });
          const sizeForPen = !(await sizesDisabled());
          const highlight = await selectAt(viewer, { x: 1300, y: 1550 });
          const noSize = await sizesDisabled();
          const colors = await colorsEnabled();
          const ok =
            text.framed.join() === 'tx' && text.corners === 0 && badge.framed.join() === 'bd' && badge.corners === 0 &&
            pen.framed.join() === 'pn' && pen.corners === 0 && sizeForPen &&
            highlight.framed.join() === 'hl' && highlight.corners === 4 && noSize && colors;
          return { ok, detail: `coins : texte ${text.corners}, pastille ${badge.corners}, crayon ${pen.corners}, surligneur ${highlight.corners} ; tailles inactives pour le surligneur : ${noSize} (actives pour le crayon : ${sizeForPen}) ; couleurs actives : ${colors}` };
        },
      ));

    await test('couleur retenue par l’outil du type de l’annotation sélectionnée', () =>
      editing(context, home, medium, [BOX, { id: 'h1', type: 'highlight', color: 'yellow', size: 'm', x: 1000, y: 1000, width: 600, height: 100 }], async (viewer) => {
        // Outil rectangle actif, surligneur sélectionné : le vert est celui du surligneur, pas celui du rectangle.
        await viewer.keyboard.press('r');
        await selectAt(viewer, { x: 1300, y: 1050 });
        await viewer.getByRole('button', { name: 'Vert', exact: true }).click();
        const [, highlight] = await storedWhen(viewer, medium, (items) => items[1].color !== 'yellow');
        await selectAt(viewer, { x: 1900, y: 1500 });
        const rectTool = await colorPressed(viewer);
        await viewer.keyboard.press('s');
        const highlightTool = await colorPressed(viewer);
        await viewer.keyboard.press('f');
        const arrowTool = await colorPressed(viewer);
        const ok = highlight.color === 'green' && rectTool.join() === 'Rouge' && highlightTool.join() === 'Vert' && arrowTool.join() === 'Rouge';
        return { ok, detail: `surligneur ${highlight.color} ; couleur du rectangle ${rectTool}, du surligneur ${highlightTool}, de la flèche ${arrowTool}` };
      }));

    await test('masque déplacé : nouvelle teinte', () =>
      editing(context, home, medium, [{ id: 'mk', type: 'mask', x: 1000, y: 1700, width: 400, height: 50, fill: '#202020' }], async (viewer) => {
        // Le masque (1700 à 1750) est tiré sur la bande magenta (2000 à 2080) : sa teinte se relit sur son nouveau liseré.
        await viewer.evaluate(scrollEditorTo, 1500);
        await editorReady(viewer);
        const selected = await selectAt(viewer, { x: 1200, y: 1725 });
        const unused = await viewer.evaluate(() => [...document.querySelectorAll('.editor-color, .editor-size')].every((button) => button.disabled));
        await drag(viewer, { x: 1200, y: 1725 }, { x: 1200, y: 2040 });
        const [moved] = await storedWhen(viewer, medium, ([item]) => item.y > 1900);
        const corner = await viewer.evaluate(handlePoint, 'bottom-right');
        await dragWindow(viewer, corner, { x: corner.x + 30, y: corner.y });
        const [wider] = await storedWhen(viewer, medium, ([item]) => item.width !== moved.width);
        const channels = [1, 3, 5].map((start) => parseInt(wider.fill.slice(start, start + 2), 16));
        const tinted = channels.every((channel, i) => near(channel, MAGENTA[i], 8));
        await finish(viewer);
        const { result } = await copyAndAnalyze(viewer, copyButton(viewer, 0), darkPixels, [{ x: 1000, y: 1700, w: 400, h: 50 }]);
        const whole = [wider.x, wider.y, wider.width, wider.height].every(Number.isInteger);
        const ok = selected.framed.join() === 'mk' && selected.corners === 4 && unused && near(moved.y, 2015, 3) && whole && tinted && result[0] === 0;
        return { ok, detail: `y ${moved.y}, largeur ${wider.width}, teinte ${wider.fill} (magenta attendu ±8) ; couleur et taille inactives : ${unused} ; pixels sombres à l’ancienne place : ${result[0]}` };
      }));

    // Fenêtre étroite : l'échelle d'affichage n'est plus 1/2, et un glisser déplace le masque d'une distance fractionnaire dans la capture.
    await test('masque déplacé trois fois : même taille', () =>
      annotated(context, home, medium, [{ id: 'mk', type: 'mask', x: 1000, y: 1000, width: 400, height: 50, fill: '#202020' }], async (viewer) => {
        await viewer.setViewportSize({ width: 1100, height: 900 });
        await openEditorOn(viewer, 0);
        const seen = [];
        let mask = { x: 1000, y: 1000, width: 400, height: 50 };
        for (const step of [{ x: 37.3, y: 23.7 }, { x: -51.4, y: 41.2 }, { x: 29.6, y: -17.1 }]) {
          const at = { x: mask.x + 200, y: mask.y + 25 };
          await selectAt(viewer, at);
          await drag(viewer, at, { x: at.x + step.x, y: at.y + step.y });
          const before = mask;
          [mask] = await storedWhen(viewer, medium, ([item]) => item.x !== before.x || item.y !== before.y);
          seen.push(`${mask.x},${mask.y} ${mask.width}×${mask.height}`);
        }
        const ok = seen.length === 3 && mask.width === 400 && mask.height === 50 && Number.isInteger(mask.x) && Number.isInteger(mask.y);
        return { ok, detail: seen.join(' ; ') };
      }));

    await test('texte et pastille se posent sur un surligneur ou un masque', () =>
      editing(
        context,
        home,
        medium,
        [
          { id: 'hl', type: 'highlight', color: 'yellow', size: 'm', x: 1000, y: 1500, width: 600, height: 100 },
          { id: 'mk', type: 'mask', x: 1000, y: 1000, width: 600, height: 100, fill: MASK_FILL },
        ],
        async (viewer) => {
          await viewer.keyboard.press('n');
          const onHighlight = await selectAt(viewer, { x: 1100, y: 1550 });
          const onMask = await selectAt(viewer, { x: 1100, y: 1050 });
          const items = await waitForItems(viewer, medium, 4);
          await viewer.keyboard.press('t');
          await clickAt(viewer, { x: 1300, y: 1530 });
          const fields = await viewer.locator('.editor-text').count();
          // Sans champ ouvert, Échap fermerait l'éditeur.
          if (fields) await viewer.keyboard.press('Escape');
          // Avec un autre outil, un clic sur le surligneur le sélectionne, comme avant.
          await viewer.keyboard.press('f');
          const selected = await selectAt(viewer, { x: 1500, y: 1550 });
          // Le surligneur est maintenant sélectionné : la pastille s'y pose quand même, et un glisser le déplacerait toujours.
          await viewer.keyboard.press('n');
          const onSelected = await selectAt(viewer, { x: 1400, y: 1550 });
          const after = await waitForItems(viewer, medium, 5);
          await viewer.keyboard.press('f');
          await selectAt(viewer, { x: 1500, y: 1550 });
          await viewer.keyboard.press('t');
          await clickAt(viewer, { x: 1300, y: 1530 });
          const fieldOnSelected = await viewer.locator('.editor-text').count();
          if (fieldOnSelected) await viewer.keyboard.press('Escape');
          const badges = items.filter((item) => item.type === 'badge').length;
          const ok =
            !hasSelection(onHighlight) && !hasSelection(onMask) && badges === 2 && fields === 1 && selected.framed.join() === 'hl' &&
            !hasSelection(onSelected) && after.filter((item) => item.type === 'badge').length === 3 && fieldOnSelected === 1;
          return { ok, detail: `pastilles posées ${badges} ; champ de texte ouvert sur le surligneur ${fields} ; sélection avec la flèche ${selected.framed} ; sur le surligneur déjà sélectionné : ${after.filter((item) => item.type === 'badge').length} pastilles, champ de texte ${fieldOnSelected}` };
        },
      ));

    await test('clic sur une forme sélectionne, glisser depuis le vide dessine', () =>
      editing(context, home, medium, [BOX, { ...BOX, id: 'r2', y: 1000 }], async (viewer) => {
        // Outil flèche, celui du départ : un clic sur une forme la sélectionne, il ne pose pas de flèche.
        const clicked = await selectAt(viewer, { x: 1000, y: 650 });
        const afterClick = await storedItems(viewer, medium);
        // Glisser depuis une autre forme, non sélectionnée : trace une flèche, ne déplace pas la forme.
        await drag(viewer, { x: 1000, y: 1150 }, { x: 400, y: 1150 });
        const withArrow = await waitForItems(viewer, medium, 3);
        const afterDraw = await viewer.evaluate(selectionState);
        await drag(viewer, { x: 1800, y: 400 }, { x: 2300, y: 400 });
        const withTwo = await waitForItems(viewer, medium, 4);
        await selectAt(viewer, { x: 1000, y: 650 });
        const emptied = await selectAt(viewer, { x: 1900, y: 1500 });
        // Un rectangle est un cadre : son intérieur est du vide, on y pose une pastille au lieu de le sélectionner.
        await viewer.keyboard.press('n');
        const inside = await selectAt(viewer, { x: 1300, y: 650 });
        const withBadge = await waitForItems(viewer, medium, 5);
        const ok =
          clicked.framed.join() === 'r1' && afterClick.length === 2 &&
          withArrow[2]?.type === 'arrow' && withArrow[1].y === 1000 && withArrow[1].x === 1000 && withArrow[0].x === 1000 && !hasSelection(afterDraw) &&
          withTwo[3]?.type === 'arrow' && !hasSelection(emptied) &&
          !hasSelection(inside) && withBadge.length === 5 && withBadge[4].type === 'badge';
        return { ok, detail: `après le clic ${afterClick.length} annotation(s) ; types ${withBadge.map((item) => item.type)} ; sélection après le tracé ${afterDraw.framed}, après un clic dans le vide ${emptied.framed}, dans un rectangle ${inside.framed}` };
      }));

    await test('annuler / rétablir', () =>
      inEditor(context, home, medium, async (viewer) => {
        const { keyboard } = viewer;
        const states = [[]];
        // Rend la liste enregistrée dès qu'elle diffère de la précédente.
        const recorded = async () => {
          const last = JSON.stringify(states.at(-1));
          states.push(await storedWhen(viewer, medium, (items) => JSON.stringify(items) !== last));
        };
        await keyboard.press('r');
        await drag(viewer, { x: 1000, y: 500 }, { x: 1600, y: 800 });
        await recorded();
        await selectAt(viewer, { x: 1000, y: 650 });
        await drag(viewer, { x: 1000, y: 650 }, { x: 1200, y: 650 });
        await recorded();
        const corner = await viewer.evaluate(handlePoint, 'bottom-right');
        await dragWindow(viewer, corner, { x: corner.x + 40, y: corner.y + 30 });
        await recorded();
        await viewer.getByRole('button', { name: 'Bleu', exact: true }).click();
        await recorded();
        await keyboard.press('n');
        await clickAt(viewer, { x: 500, y: 1000 });
        await recorded();
        await selectAt(viewer, { x: 500, y: 1000 });
        await keyboard.press('Backspace');
        await recorded();
        viewer.once('dialog', (dialog) => dialog.accept());
        await viewer.getByRole('button', { name: 'Tout effacer', exact: true }).click({ timeout: 5000 });
        await recorded();

        const bad = [];
        const matches = async (k) => {
          const wanted = JSON.stringify(states[k]);
          const items = await storedWhen(viewer, medium, (list) => JSON.stringify(list) === wanted);
          const drawn = await viewer.evaluate(drawnAnnotations, states[k].map((item) => item.id));
          if (JSON.stringify(items) !== wanted || drawn.count !== states[k].length || drawn.present.length !== states[k].length) bad.push(`état ${k}`);
        };
        for (let k = states.length - 2; k >= 0; k--) {
          await keyboard.press('Meta+z');
          await matches(k);
        }
        const undoEnded = await historyButton(viewer, 'Annuler').isDisabled();
        const redoReady = !(await historyButton(viewer, 'Rétablir').isDisabled());
        for (let k = 1; k < states.length; k++) {
          await keyboard.press('Meta+Shift+z');
          await matches(k);
        }
        const redoEnded = await historyButton(viewer, 'Rétablir').isDisabled();
        // Les deux boutons font la même chose, et une nouvelle action vide le « rétablir ».
        await historyButton(viewer, 'Annuler').click();
        await matches(states.length - 2);
        await historyButton(viewer, 'Rétablir').click();
        await matches(states.length - 1);
        await historyButton(viewer, 'Annuler').click();
        await matches(states.length - 2);
        await keyboard.press('r');
        await drag(viewer, { x: 1000, y: 1400 }, { x: 1600, y: 1600 });
        await storedWhen(viewer, medium, (items) => items.length === states[states.length - 2].length + 1);
        const redoCleared = await historyButton(viewer, 'Rétablir').isDisabled();
        const ok = states.length === 8 && bad.length === 0 && undoEnded && redoReady && redoEnded && redoCleared;
        return { ok, detail: `${states.length - 1} actions ; écarts : ${bad.join(', ') || 'aucun'} ; Annuler grisé en bas ${undoEnded}, Rétablir actif ${redoReady}, grisé en haut ${redoEnded}, vidé par une action ${redoCleared}` };
      }));

    await test('tout effacer', async () => {
      const long = await seedCapture(home, { heightPoints: 6000 });
      const exportOf = (id) =>
        withViewer(context, id, async (viewer) => {
          const layout = await partLayout(viewer);
          const files = await download(context, viewer, viewer.locator('#download-all'), layout.tops.length);
          return { layout, hashes: await Promise.all(files.map(sha256)) };
        });
      const original = await exportOf(long);
      // Un rectangle à cheval sur la coupe la déplace ; tout effacer la remet à sa place, et les images redeviennent celles d'origine.
      const rect = { id: 'e1', type: 'rect', color: 'red', size: 'm', x: 1200, y: original.layout.tops[1] - 150, width: 800, height: 300 };
      let asked = '';
      const cleared = await annotated(context, home, long, [rect], async (viewer) => {
        const moved = await partLayout(viewer);
        await openEditorOn(viewer, 0);
        viewer.once('dialog', (dialog) => {
          asked = dialog.message();
          dialog.accept();
        });
        await viewer.getByRole('button', { name: 'Tout effacer', exact: true }).click({ timeout: 5000 });
        const items = await storedWhen(viewer, long, (list) => list.length === 0);
        const drawn = await viewer.evaluate(drawnAnnotations, [rect.id]);
        await finish(viewer);
        const files = await download(context, viewer, viewer.locator('#download-all'), original.layout.tops.length);
        return { moved, items, drawn, layout: await partLayout(viewer), hashes: await Promise.all(files.map(sha256)) };
      });
      // Refusé : rien ne change.
      const kept = await annotated(context, home, long, [rect], async (viewer) => {
        await openEditorOn(viewer, 0);
        viewer.once('dialog', (dialog) => dialog.dismiss());
        await viewer.getByRole('button', { name: 'Tout effacer', exact: true }).click({ timeout: 5000 });
        await frames(viewer);
        await viewer.waitForTimeout(500);
        const items = await storedItems(viewer, long);
        const drawn = await viewer.evaluate(drawnAnnotations, [rect.id]);
        return { items, drawn, undoDisabled: await historyButton(viewer, 'Annuler').isDisabled() };
      });
      const ok =
        asked === 'Effacer toutes les annotations de cette capture ?' &&
        cleared.moved.tops[1] !== original.layout.tops[1] &&
        cleared.items.length === 0 && cleared.drawn.count === 0 &&
        JSON.stringify(cleared.layout) === JSON.stringify(original.layout) && cleared.hashes.join() === original.hashes.join() &&
        kept.items.length === 1 && kept.drawn.count === 1 && kept.undoDisabled;
      return { ok, detail: `question « ${asked} » ; coupe ${original.layout.tops[1]} → ${cleared.moved.tops[1]} → ${cleared.layout.tops[1]} ; images identiques : ${cleared.hashes.join() === original.hashes.join()} ; refusé : ${kept.items.length} annotation(s)` };
    });

    await test('raccourcis inactifs pendant la saisie', () =>
      inEditor(context, home, medium, async (viewer) => {
        await viewer.keyboard.press('r');
        await drag(viewer, { x: 1000, y: 500 }, { x: 1600, y: 800 });
        await waitForItems(viewer, medium, 1);
        await viewer.keyboard.press('t');
        await clickAt(viewer, { x: 1000, y: 1300 });
        // Les lettres des outils s'écrivent dans le champ au lieu de changer d'outil.
        await viewer.keyboard.type('Rfnmc');
        const typed = await viewer.locator('.editor-text').inputValue();
        const tool = await toolPressed(viewer);
        // ⌘Z agit sur le champ, pas sur les annotations.
        await viewer.keyboard.press('Meta+z');
        await viewer.waitForTimeout(500);
        const items = await storedItems(viewer, medium);
        const undoReady = !(await historyButton(viewer, 'Annuler').isDisabled());
        const redoReady = !(await historyButton(viewer, 'Rétablir').isDisabled());
        const ok = typed === 'Rfnmc' && tool.join() === 'Texte' && items.length === 1 && items[0].type === 'rect' && undoReady && !redoReady;
        return { ok, detail: `champ « ${typed} », outil ${tool} ; ${items.length} annotation(s) après ⌘Z ; Annuler actif ${undoReady}, Rétablir actif ${redoReady}` };
      }));

    await test('Échap ferme même avec une sélection', () =>
      editing(context, home, medium, [BOX], async (viewer) => {
        const state = await selectAt(viewer, { x: 1000, y: 650 });
        await viewer.keyboard.press('Escape');
        await viewer.waitForSelector('#editor', { state: 'hidden', timeout: 5000 });
        // La scène et le cadre de sélection sont libérés avec l'éditeur.
        const stages = await viewer.evaluate(() => Konva.stages.length);
        return { ok: state.framed.length === 1 && stages === 0, detail: `sélection ${state.framed} ; scènes Konva restantes ${stages}` };
      }));

    await test('pendant une saisie, Échap valide le texte sans fermer', () =>
      inEditor(context, home, medium, async (viewer) => {
        await viewer.keyboard.press('t');
        await clickAt(viewer, { x: 1000, y: 1300 });
        await viewer.keyboard.type('Salut');
        await viewer.keyboard.press('Escape');
        const [text] = await waitForItems(viewer, medium, 1);
        const open = await viewer.locator('#editor').isVisible();
        const fields = await viewer.locator('.editor-text').count();
        // Sans saisie, Échap ferme.
        await viewer.keyboard.press('Escape');
        await viewer.waitForSelector('#editor', { state: 'hidden', timeout: 5000 });
        return { ok: text?.text === 'Salut' && open && fields === 0, detail: `texte « ${text?.text} », éditeur ${open ? 'resté ouvert' : 'fermé'}, champs ${fields}` };
      }));
  } finally {
    await home.close();
  }
}

// ---- Historique : captures annotées gardées, suppression à la main (tâche 6) ----

const MINUTE = 60_000;

const entryOf = (viewer, id) => viewer.locator(`.history-item[data-id="${id}"]`);
const crossOf = (viewer, id) =>
  viewer.locator('#history li').filter({ has: entryOf(viewer, id) }).getByRole('button', { name: 'Supprimer cette capture', exact: true });

// Dans la page : une ligne par entrée de l'historique, de haut en bas.
function historyRows() {
  return [...document.querySelectorAll('#history li')].map((li) => {
    const entry = li.querySelector('.history-item');
    return {
      id: entry?.dataset.id ?? null,
      meta: li.querySelector('.history-meta')?.textContent ?? '',
      current: entry?.getAttribute('aria-current') === 'true',
      text: li.textContent,
    };
  });
}

const isMarked = (row) => /, annotée$/.test(row.meta);

// Dans la page : la date et la mention « annotée » de la capture `id` tiennent, chacune sur une ligne, dans la colonne de texte de son entrée.
function metaFits(id) {
  const entry = document.querySelector(`.history-item[data-id="${id}"]`);
  const column = entry.querySelector('.history-text').getBoundingClientRect();
  const rects = [...entry.querySelectorAll('.history-date, .history-mark')].map((el) => el.getBoundingClientRect());
  const inside = rects.every((r) => r.width > 0 && r.left >= column.left - 0.5 && r.right <= column.right + 0.5 && r.height < 20);
  const host = entry.querySelector('.history-host');
  return { inside, count: rects.length, hostCut: host.scrollWidth > host.clientWidth, meta: entry.querySelector('.history-meta').textContent };
}

// Donne une adresse à une capture synthétique (seedCapture n'en fixe qu'une).
function setUrl(page, id, url) {
  return page.evaluate(
    ({ id, url }) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('capture');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('captures', 'readwrite');
          const store = tx.objectStore('captures');
          store.get(id).onsuccess = (event) => store.put({ ...event.target.result, url });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    { id, url },
  );
}

// Attend (5 s au plus) que la ligne grise de la capture `id` porte, ou non, la mention « , annotée ».
const waitMarked = (viewer, id, wanted) =>
  viewer.waitForFunction(
    ({ id, wanted }) => /, annotée$/.test(document.querySelector(`.history-item[data-id="${id}"] .history-meta`)?.textContent ?? '') === wanted,
    { id, wanted },
    { timeout: 5000 },
  );

// Attend que la capture `id` soit celle qui s'affiche, ses images prêtes.
const showing = (viewer, id) =>
  viewer.waitForFunction(
    (id) => document.querySelector('.history-item[aria-current="true"]')?.dataset.id === id && document.body.dataset.ready === 'true',
    id,
    { timeout: 30_000 },
  );

const hasCapture = (viewer, id) =>
  viewer.evaluate(async (id) => {
    const { getCapture } = await import(chrome.runtime.getURL('lib/db.js'));
    return Boolean(await getCapture(id));
  }, id);

const annotatedIds = (viewer) =>
  viewer.evaluate(async () => {
    const { listAnnotatedIds } = await import(chrome.runtime.getURL('lib/db.js'));
    return [...(await listAnnotatedIds())];
  });

// Retient en écriture le magasin des annotations pendant `ms` : toute écriture faite ailleurs attend la fin. Rend la main dès que la prise est faite.
function holdAnnotationStore(page, ms) {
  return page.evaluate(
    (ms) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('capture');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('annotations', 'readwrite');
          const store = tx.objectStore('annotations');
          const until = performance.now() + ms;
          // Une requête après l'autre tient la transaction ouverte.
          const keepOpen = () => {
            if (performance.now() < until) store.get('retenue').onsuccess = keepOpen;
          };
          keepOpen();
          window.released = new Promise((done) => {
            tx.oncomplete = () => {
              db.close();
              done();
            };
          });
          resolve();
        };
      }),
    ms,
  );
}

// Attend la fin de la prise (la base ne peut pas être supprimée avant).
const waitReleased = (page) => page.evaluate(() => window.released);

// Dans la page : numéro d'ordre des captures ouvertes, dans l'ordre, à partir de maintenant.
function watchOpenings() {
  window.opened = [];
  new MutationObserver(() => {
    const id = document.querySelector('.history-item[aria-current="true"]')?.dataset.id;
    if (id && window.opened.at(-1) !== id) window.opened.push(id);
  }).observe(document.getElementById('history'), { attributes: true, subtree: true, attributeFilter: ['aria-current'] });
}

async function testHistory(context, base) {
  console.log('\n— Historique : captures annotées gardées, suppression à la main');
  const home = await extensionPage(context, 'popup/popup.html');
  try {
    await test('mention « annotée » dans l’historique', async () => {
      await resetDb(home);
      const now = Date.now();
      const plain = await seedCapture(home, { heightPoints: 800, createdAt: now - 2 * MINUTE });
      const marked = await seedCapture(home, { heightPoints: 800, createdAt: now - MINUTE });
      await saveItems(home, marked, [RECT]);
      return withViewer(context, plain, async (viewer) => {
        const rows = await viewer.evaluate(historyRows);
        const start = Object.fromEntries(rows.map((row) => [row.id, isMarked(row)]));
        // Annoter à la souris : la mention apparaît tout de suite, sans recharger la page.
        await openEditorOn(viewer, 0);
        await viewer.keyboard.press('r');
        await drag(viewer, { x: 1000, y: 500 }, { x: 1600, y: 800 });
        await waitForItems(viewer, plain, 1);
        await finish(viewer);
        await waitMarked(viewer, plain, true);
        // Tout effacer : la capture redevient ordinaire et la mention part.
        await openEditorOn(viewer, 0);
        viewer.once('dialog', (dialog) => dialog.accept());
        await viewer.getByRole('button', { name: 'Tout effacer', exact: true }).click({ timeout: 5000 });
        await waitForItems(viewer, plain, 0);
        await finish(viewer);
        await waitMarked(viewer, plain, false);
        // La mention ne doit pas être coupée par la largeur de la colonne.
        const fits = await viewer.evaluate(metaFits, marked);
        const ok = start[plain] === false && start[marked] === true && rows.length === 2 && fits.inside && fits.count === 2;
        return { ok, detail: `au chargement : annotée ${start[marked]}, ordinaire ${start[plain]} ; mention apparue après un tracé, retirée après « Tout effacer » ; date et mention dans la colonne ${fits.inside}` };
      });
    });

    // Colonne de texte de 140 px environ : un nom de site long ou une date large ne doivent pas faire disparaître la date ni la mention.
    await test('ligne grise : nom de site long et date large, rien n’est coupé', async () => {
      await resetDb(home);
      const hosts = ['subdomain.long-company-name.co.uk', 'developer.mozilla.org', 'learn.microsoft.com', 'localhost'];
      const ids = [];
      for (const [k, host] of hosts.entries()) {
        // « 30 sept., 23:59 » : une des dates les plus larges.
        const id = await seedCapture(home, { heightPoints: 800, createdAt: new Date(2026, 8, 30, 23, 59).getTime() - k * MINUTE });
        await setUrl(home, id, `https://www.${host}/page`);
        await saveItems(home, id, [RECT]);
        ids.push(id);
      }
      return withViewer(context, ids[0], async (viewer) => {
        const reports = [];
        for (const id of ids) reports.push(await viewer.evaluate(metaFits, id));
        await viewer.locator('.panel').screenshot({ path: path.join(WORK, 'history-hosts.png') });
        const ok = reports.every((r) => r.inside && r.count === 2 && /23:5\d, annotée$/.test(r.meta));
        return { ok, detail: reports.map((r, k) => `${hosts[k]} : ${r.inside ? 'date et mention visibles' : 'COUPÉ'}${r.hostCut ? ' (nom abrégé)' : ''}`).join(' ; ') + ' ; capture history-hosts.png' };
      });
    });

    await test('croix « Supprimer »', async () => {
      await resetDb(home);
      const now = Date.now();
      // Quatre captures : après la suppression de l'ouverte, il en reste deux, et seule la plus récente (pas la dernière de la liste) doit s'ouvrir.
      const spare = await seedCapture(home, { heightPoints: 800, createdAt: now - 4 * MINUTE });
      const oldest = await seedCapture(home, { heightPoints: 800, createdAt: now - 3 * MINUTE });
      const middle = await seedCapture(home, { heightPoints: 800, createdAt: now - 2 * MINUTE });
      const newest = await seedCapture(home, { heightPoints: 800, createdAt: now - MINUTE });
      await saveItems(home, middle, [RECT]);
      return withViewer(context, middle, async (viewer) => {
        const asked = [];
        let answer = false;
        viewer.on('dialog', (dialog) => {
          asked.push(dialog.message());
          return answer ? dialog.accept() : dialog.dismiss();
        });
        const ids = async () => (await viewer.evaluate(historyRows)).map((row) => row.id);

        // Confirmation refusée : rien ne change.
        await crossOf(viewer, spare).click();
        const refused = { listed: await ids(), kept: await hasCapture(viewer, spare) };

        // Confirmation acceptée sur une capture qui n'est pas ouverte : elle part, l'ouverte reste.
        answer = true;
        await crossOf(viewer, spare).click();
        await viewer.waitForFunction((id) => !document.querySelector(`.history-item[data-id="${id}"]`), spare);
        const other = { listed: await ids(), gone: !(await hasCapture(viewer, spare)), still: await viewer.evaluate(() => location.search) };

        // Sur la capture ouverte et annotée : elle part avec ses annotations, la plus récente restante s'ouvre (pas la plus ancienne).
        await crossOf(viewer, middle).click();
        await showing(viewer, newest);
        const open = {
          listed: await ids(),
          gone: !(await hasCapture(viewer, middle)),
          notes: await storedItems(viewer, middle),
          annotated: await annotatedIds(viewer),
          search: await viewer.evaluate(() => location.search),
          title: await viewer.locator('#title').innerText(),
        };
        const ok =
          refused.listed.join() === [newest, middle, oldest, spare].join() && refused.kept &&
          other.listed.join() === [newest, middle, oldest].join() && other.gone && other.still === `?id=${middle}` &&
          open.listed.join() === [newest, oldest].join() && open.gone && open.notes.length === 0 && open.annotated.length === 0 && open.search === `?id=${newest}` &&
          asked.length === 3 && !/annotations/.test(asked[0]) && /annotations/.test(asked[2]);
        return { ok, detail: `refus : ${refused.listed.length} entrées ; hors capture ouverte : ${other.listed.length} entrées, ouverte inchangée ${other.still} ; capture ouverte : ${open.listed.length} entrées restantes, ouvre ${open.search === `?id=${newest}` ? 'la plus récente' : open.search}, annotations ${open.notes.length} ; questions ${asked.length}` };
      });
    });

    // Deux clics sur la croix de la même capture avant la fin de la première suppression : la seconde ne fait rien de plus, sans erreur.
    await test('croix « Supprimer » : double clic sur la même capture', async () => {
      await resetDb(home);
      const now = Date.now();
      const older = await seedCapture(home, { heightPoints: 800, createdAt: now - 2 * MINUTE });
      const shown = await seedCapture(home, { heightPoints: 800, createdAt: now - MINUTE });
      return withViewer(context, shown, async (viewer) => {
        viewer.on('dialog', (dialog) => dialog.accept());
        await viewer.evaluate((id) => {
          const cross = document.querySelector(`.history-item[data-id="${id}"]`).closest('li').querySelector('.history-delete');
          cross.click();
          cross.click();
        }, older);
        await viewer.waitForFunction((id) => !document.querySelector(`.history-item[data-id="${id}"]`), older);
        await viewer.waitForTimeout(500);
        const rows = await viewer.evaluate(historyRows);
        const toasts = await viewer.locator('#toast').innerText();
        // Une erreur de la page ferait échouer le test (withViewer).
        const ok = rows.length === 1 && rows[0].id === shown && rows[0].current && !(await hasCapture(viewer, older)) && toasts.includes('Capture supprimée');
        return { ok, detail: `${rows.length} entrée restante, ouverte inchangée ${rows[0]?.current}, message « ${toasts.trim()} »` };
      });
    });

    await test('croix « Supprimer » : dernière capture, écran vide', async () => {
      await resetDb(home);
      const only = await seedCapture(home, { heightPoints: 800 });
      return withViewer(context, only, async (viewer) => {
        viewer.on('dialog', (dialog) => dialog.accept());
        await crossOf(viewer, only).click();
        await viewer.waitForSelector('.empty');
        const state = await viewer.evaluate(() => ({
          heading: document.querySelector('.empty h2')?.textContent,
          list: document.getElementById('history').textContent.trim(),
          title: document.getElementById('title').textContent,
          docTitle: document.title,
          meta: document.getElementById('meta').textContent,
          downloadDisabled: document.getElementById('download-all').disabled,
          search: location.search,
        }));
        const ok =
          state.heading === 'Aucune capture pour l’instant' && state.list === 'Tes captures apparaîtront ici.' &&
          state.title === 'Captures' && state.docTitle === 'Captures' && state.meta === '' && state.downloadDisabled && state.search === '';
        return { ok, detail: `« ${state.heading} », historique « ${state.list} », titre « ${state.title} », adresse « ${state.search} »` };
      });
    });

    await test('capture introuvable : le message explique le nettoyage', async () => {
      await resetDb(home);
      return withViewer(context, 'inconnue', async (viewer) => {
        const heading = await viewer.locator('.empty h2').innerText();
        const message = await viewer.locator('.empty p').innerText();
        const ok = heading === 'Capture introuvable' && message === 'Elle a été supprimée, ou retirée de l’historique, qui garde les 15 dernières captures non annotées.';
        return { ok, detail: `« ${heading} » : « ${message} »` };
      });
    });

    await test('suppression en échec : signalée, capture conservée', async () => {
      await resetDb(home);
      const only = await seedCapture(home, { heightPoints: 800 });
      return withViewer(context, only, async (viewer) => {
        viewer.on('dialog', (dialog) => dialog.accept());
        await viewer.evaluate(() => {
          IDBObjectStore.prototype.delete = () => {
            throw new Error('écriture refusée');
          };
        });
        await crossOf(viewer, only).click();
        await viewer.waitForFunction(() => /Suppression impossible/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
        const message = await viewer.locator('#toast').innerText();
        const kept = await hasCapture(viewer, only);
        const rows = await viewer.evaluate(historyRows);
        const ok = kept && rows.length === 1 && rows[0].current && /écriture refusée/.test(message);
        return { ok, detail: `message « ${message.trim()} », capture conservée ${kept}, ${rows.length} entrée dans l’historique` };
      });
    });

    await test('changer de capture juste après une annotation', async () => {
      await resetDb(home);
      const now = Date.now();
      // A est longue : son recalcul à la fermeture de l'éditeur dure encore quand on clique sur B.
      const a = await seedCapture(home, { heightPoints: 12000, createdAt: now - 2 * MINUTE });
      const b = await seedCapture(home, { heightPoints: 800, createdAt: now - MINUTE });
      return withViewer(context, a, async (viewer) => {
        await openEditorOn(viewer, 0);
        await viewer.keyboard.press('r');
        await drag(viewer, { x: 1000, y: 500 }, { x: 1600, y: 800 });
        // « Terminer », puis aussitôt B dans l'historique (le clic attend que le calque se retire).
        await viewer.getByRole('button', { name: 'Terminer', exact: true }).click();
        await entryOf(viewer, b).click();
        await showing(viewer, b);
        // Laisser arriver tout ce que le recalcul de A pourrait encore faire.
        await viewer.waitForTimeout(1500);
        const focus = await viewer.evaluate(() => document.activeElement?.className ?? '');
        const alert = await viewer.locator('#toast').isVisible();
        const bPreview = await viewer.evaluate(previewPixelAt, [1000, 650]);
        const aItems = await waitForItems(viewer, a, 1);
        const bItems = await storedItems(viewer, b);
        // De retour sur A : son annotation est là.
        await entryOf(viewer, a).click();
        await showing(viewer, a);
        const aPreview = await viewer.evaluate(previewPixelAt, [1000, 650]);
        const ok = aItems.length === 1 && bItems.length === 0 && !isReddish(bPreview) && isReddish(aPreview) && !focus.includes('annotate') && !alert;
        return { ok, detail: `A garde ${aItems.length} annotation, B ${bItems.length} ; aperçu de B ${bPreview}, de A ${aPreview} ; focus « ${focus} » ; message ${alert ? 'affiché' : 'aucun'}` };
      });
    });

    await test('retour sur une capture dont l’enregistrement est en attente', async () => {
      await resetDb(home);
      const now = Date.now();
      const a = await seedCapture(home, { heightPoints: 800, createdAt: now - 2 * MINUTE });
      const b = await seedCapture(home, { heightPoints: 800, createdAt: now - MINUTE });
      try {
        return await withViewer(context, a, async (viewer) => {
          await openEditorOn(viewer, 0);
          await viewer.keyboard.press('r');
          // Les écritures de A restent bloquées le temps de partir sur B puis de revenir sur A.
          await holdAnnotationStore(home, 4000);
          await drag(viewer, { x: 1000, y: 300 }, { x: 1600, y: 600 });
          await drag(viewer, { x: 1000, y: 900 }, { x: 1600, y: 1200 });
          await viewer.getByRole('button', { name: 'Terminer', exact: true }).click();
          await viewer.waitForSelector('#editor', { state: 'hidden' });
          await viewer.evaluate(watchOpenings);
          await entryOf(viewer, b).click();
          await entryOf(viewer, a).click();
          await viewer.waitForFunction(() => window.opened.length >= 2 && document.body.dataset.ready === 'true', null, { timeout: 30_000 });
          const order = await viewer.evaluate(() => window.opened);
          const first = await viewer.evaluate(previewPixelAt, [1000, 450]);
          const second = await viewer.evaluate(previewPixelAt, [1000, 1050]);
          const items = await storedItems(viewer, a);
          const ok = order.join() === [b, a].join() && items.length === 2 && isReddish(first) && isReddish(second);
          return { ok, detail: `ouvertures ${order.length}, ${items.length} annotations enregistrées ; aperçu de A au premier rectangle ${first}, au second ${second}` };
        });
      } finally {
        await waitReleased(home);
      }
    });

    // Dans la page : états des boutons « Annoter » (images et menu du clic droit), puis un clic forcé sur le premier, même grisé :
    // c'est la garde de `annotate()` qui doit refuser, pas seulement l'état du bouton.
    const annotateStates = () => {
      const disabled = [...document.querySelectorAll('.annotate'), document.querySelector('#image-menu [data-action="annotate"]')].map((el) => el.disabled);
      const first = document.querySelector('.annotate');
      first.disabled = false;
      first.click();
      return { disabled, opened: window.opened?.length ?? null };
    };

    await test('Annoter refusé pendant un changement de capture', async () => {
      await resetDb(home);
      const now = Date.now();
      const a = await seedCapture(home, { heightPoints: 800, createdAt: now - 2 * MINUTE });
      const b = await seedCapture(home, { heightPoints: 800, createdAt: now - MINUTE });
      try {
        return await withViewer(context, a, async (viewer) => {
          await openEditorOn(viewer, 0);
          await viewer.keyboard.press('r');
          // Les écritures de A restent bloquées : B ne s'ouvre qu'après, et la page de A reste affichée en attendant.
          await holdAnnotationStore(home, 5000);
          await drag(viewer, { x: 1000, y: 300 }, { x: 1600, y: 600 });
          await drag(viewer, { x: 1000, y: 900 }, { x: 1600, y: 1200 });
          await viewer.getByRole('button', { name: 'Terminer', exact: true }).click();
          await viewer.waitForSelector('#editor', { state: 'hidden' });
          await viewer.evaluate(watchOpenings);
          await entryOf(viewer, b).click();
          const during = await viewer.evaluate(annotateStates);
          await viewer.waitForTimeout(300);
          const editorEarly = await viewer.locator('#editor').isVisible();
          await showing(viewer, b);
          await viewer.waitForTimeout(500);
          const after = {
            editor: await viewer.locator('#editor').isVisible(),
            title: await viewer.locator('#title').innerText(),
            enabled: await annotateButton(viewer, 0).isEnabled(),
            bPreview: await viewer.evaluate(previewPixelAt, [1000, 450]),
          };
          const aItems = await waitForItems(viewer, a, 2);
          const bItems = await storedItems(viewer, b);
          const ok =
            during.opened === 0 && during.disabled.length === 2 && during.disabled.every(Boolean) && !editorEarly && !after.editor &&
            after.enabled && !isReddish(after.bPreview) && aItems.length === 2 && bItems.length === 0;
          return { ok, detail: `pendant l’attente : B pas encore ouverte ${during.opened === 0}, boutons grisés ${during.disabled.every(Boolean)}, éditeur ${editorEarly ? 'ouvert' : 'fermé'} ; ensuite éditeur ${after.editor ? 'ouvert' : 'fermé'}, « Annoter » réactivé ${after.enabled} ; A garde ${aItems.length} annotations, B ${bItems.length}` };
        });
      } finally {
        await waitReleased(home);
      }
    });

    await test('suppression de la capture affichée pendant une écriture : Annoter refusé, aucune annotation orpheline', async () => {
      await resetDb(home);
      const now = Date.now();
      const a = await seedCapture(home, { heightPoints: 800, createdAt: now - 2 * MINUTE });
      const b = await seedCapture(home, { heightPoints: 800, createdAt: now - MINUTE });
      try {
        return await withViewer(context, a, async (viewer) => {
          viewer.on('dialog', (dialog) => dialog.accept());
          await openEditorOn(viewer, 0);
          await viewer.keyboard.press('r');
          await holdAnnotationStore(home, 5000);
          await drag(viewer, { x: 1000, y: 300 }, { x: 1600, y: 600 });
          await drag(viewer, { x: 1000, y: 900 }, { x: 1600, y: 1200 });
          await viewer.getByRole('button', { name: 'Terminer', exact: true }).click();
          await viewer.waitForSelector('#editor', { state: 'hidden' });
          await viewer.evaluate(watchOpenings);
          await crossOf(viewer, a).click();
          const during = await viewer.evaluate(annotateStates);
          await viewer.waitForTimeout(300);
          const editorEarly = await viewer.locator('#editor').isVisible();
          await showing(viewer, b);
          await viewer.waitForTimeout(500);
          const after = {
            editor: await viewer.locator('#editor').isVisible(),
            search: await viewer.evaluate(() => location.search),
            gone: !(await hasCapture(viewer, a)),
            notes: await storedItems(viewer, a),
            annotated: await annotatedIds(viewer),
          };
          const ok =
            during.opened === 0 && during.disabled.length === 2 && during.disabled.every(Boolean) && !editorEarly && !after.editor &&
            after.search === `?id=${b}` && after.gone && after.notes.length === 0 && after.annotated.length === 0;
          return { ok, detail: `pendant l’attente : boutons grisés ${during.disabled.every(Boolean)}, éditeur ${editorEarly ? 'ouvert' : 'fermé'} ; ensuite B affichée ${after.search === `?id=${b}`}, A supprimée ${after.gone}, annotations restantes de A ${after.notes.length}, captures annotées ${after.annotated.length}` };
        });
      } finally {
        await waitReleased(home);
      }
    });

    // Une écriture qui a échoué, puis un changement de capture : on la retente ; si elle échoue encore, la personne choisit.
    await test('échec d’enregistrement puis changement de capture', async () => {
      await resetDb(home);
      const now = Date.now();
      const a = await seedCapture(home, { heightPoints: 800, createdAt: now - 2 * MINUTE });
      const b = await seedCapture(home, { heightPoints: 800, createdAt: now - MINUTE });
      return withViewer(context, a, async (viewer) => {
        const asked = [];
        let answer = false;
        viewer.on('dialog', (dialog) => {
          asked.push(dialog.message());
          return answer ? dialog.accept() : dialog.dismiss();
        });
        const breakWrites = () =>
          viewer.evaluate(() => {
            window.realPut ??= IDBObjectStore.prototype.put;
            IDBObjectStore.prototype.put = () => {
              throw new Error('disque plein');
            };
          });
        const fixWrites = () => viewer.evaluate(() => (IDBObjectStore.prototype.put = window.realPut));
        // Annote A avec une écriture qui échoue, puis ferme l'éditeur : le bandeau reste dans l'en-tête.
        const failOn = async (top) => {
          await openEditorOn(viewer, 0);
          await viewer.keyboard.press('r');
          await breakWrites();
          await drag(viewer, { x: 1000, y: top }, { x: 1600, y: top + 300 });
          await viewer.locator('#editor-alert').waitFor({ state: 'visible', timeout: 5000 });
          await finish(viewer);
        };
        const banner = () => viewer.locator('#save-alert').isVisible();
        const current = () => viewer.evaluate(() => document.querySelector('.history-item[aria-current="true"]')?.dataset.id);

        // 1. L'écriture échoue encore à la sortie, la personne refuse de quitter : A reste affichée, le bandeau aussi.
        await failOn(500);
        await entryOf(viewer, b).click();
        await viewer.waitForTimeout(800);
        const stayed = { current: await current(), banner: await banner(), asked: asked.length, text: asked[0] ?? '' };

        // 2. Elle accepte de perdre les annotations : B s'ouvre, le bandeau part, A n'a rien gardé.
        answer = true;
        await entryOf(viewer, b).click();
        await showing(viewer, b);
        const left = { banner: await banner(), notes: await storedItems(viewer, a), annotated: await annotatedIds(viewer) };

        // 3. De retour sur A, nouvel échec, mais l'écriture marche à nouveau avant la sortie : retentée, rien de perdu, aucune question.
        await entryOf(viewer, a).click();
        await showing(viewer, a);
        await failOn(500);
        await fixWrites();
        const before = asked.length;
        await entryOf(viewer, b).click();
        await showing(viewer, b);
        const retried = { banner: await banner(), notes: await storedItems(viewer, a), asked: asked.length - before, annotated: await annotatedIds(viewer) };

        // 4. Nouvel échec sur A, puis on supprime A elle-même : plus rien à retenter, le bandeau part sans question de départ.
        await entryOf(viewer, a).click();
        await showing(viewer, a);
        await failOn(1000);
        const beforeDelete = asked.length;
        await crossOf(viewer, a).click();
        await showing(viewer, b);
        const deleted = { banner: await banner(), asked: asked.length - beforeDelete, gone: !(await hasCapture(viewer, a)) };

        const ok =
          stayed.current === a && stayed.banner && stayed.asked === 1 && /encore échoué/.test(stayed.text) &&
          !left.banner && left.notes.length === 0 && left.annotated.length === 0 &&
          !retried.banner && retried.notes.length === 1 && retried.asked === 0 && retried.annotated.join() === a &&
          !deleted.banner && deleted.asked === 1 && deleted.gone;
        return { ok, detail: `sortie refusée : reste sur A ${stayed.current === a}, bandeau ${stayed.banner} ; sortie acceptée : bandeau ${left.banner}, A garde ${left.notes.length} ; écriture rétablie : ${retried.notes.length} annotation enregistrée, ${retried.asked} question ; suppression de A : bandeau ${deleted.banner}, ${deleted.asked} question (la suppression elle-même)` };
      });
    });

    await test('historique figé pendant que l’éditeur est ouvert', async () => {
      await resetDb(home);
      const now = Date.now();
      const a = await seedCapture(home, { heightPoints: 800, createdAt: now - 2 * MINUTE });
      const b = await seedCapture(home, { heightPoints: 800, createdAt: now - MINUTE });
      return withViewer(context, a, async (viewer) => {
        const asked = [];
        viewer.on('dialog', (dialog) => {
          asked.push(dialog.message());
          return dialog.accept();
        });
        await openEditorOn(viewer, 0);
        // Clics faits par le script : la page est inerte pour une personne, mais rien ne doit changer de capture non plus.
        await viewer.evaluate((b) => {
          document.querySelector(`.history-item[data-id="${b}"]`).click();
          document.querySelector(`.history-item[data-id="${b}"]`).closest('li').querySelector('.history-delete').click();
        }, b);
        await viewer.waitForTimeout(500);
        const current = await viewer.evaluate(() => document.querySelector('.history-item[aria-current="true"]')?.dataset.id);
        const ok = current === a && asked.length === 0 && (await hasCapture(viewer, b)) && (await viewer.locator('#editor').isVisible());
        return { ok, detail: `capture affichée ${current === a ? 'A (inchangée)' : 'autre'}, questions posées ${asked.length}, éditeur ${ok ? 'ouvert' : 'à vérifier'}` };
      });
    });

    await test('croix visible au survol et au clavier, clair et sombre', async () => {
      await resetDb(home);
      const now = Date.now();
      const first = await seedCapture(home, { heightPoints: 800, createdAt: now - 2 * MINUTE });
      const second = await seedCapture(home, { heightPoints: 800, createdAt: now - MINUTE });
      await saveItems(home, first, [RECT]);
      return withViewer(context, second, async (viewer) => {
        const opacityOf = (id) => crossOf(viewer, id).evaluate((el) => Number(getComputedStyle(el).opacity));
        await viewer.mouse.move(700, 600);
        const idle = await opacityOf(first);
        await entryOf(viewer, first).hover();
        const hovered = await opacityOf(first);
        // Au clavier : Tab depuis l'entrée atteint la croix, qui devient visible, avec un contour de focus.
        await viewer.mouse.move(700, 600);
        await entryOf(viewer, first).focus();
        await viewer.keyboard.press('Tab');
        const focusState = await crossOf(viewer, first).evaluate((el) => ({
          focused: el === document.activeElement,
          opacity: Number(getComputedStyle(el).opacity),
          outline: getComputedStyle(el).outlineStyle,
        }));
        for (const scheme of ['light', 'dark']) {
          await viewer.emulateMedia({ colorScheme: scheme });
          await viewer.locator('.panel').screenshot({ path: path.join(WORK, `history-${scheme}.png`) });
        }
        // Les croix portent toutes le même nom : chacune renvoie par aria-describedby au titre de sa propre entrée (identifiants distincts).
        const describedBy = await viewer.evaluate(() =>
          [...document.querySelectorAll('#history li')].map((li) => {
            const cross = li.querySelector('.history-delete');
            const target = document.getElementById(cross.getAttribute('aria-describedby') ?? '');
            return { name: cross.getAttribute('aria-label'), id: target?.id, own: target ? li.contains(target) && target.classList.contains('history-title') : false };
          }),
        );
        const described = describedBy.length === 2 && describedBy.every((d) => d.name === 'Supprimer cette capture' && d.own) && new Set(describedBy.map((d) => d.id)).size === 2;
        const ok = idle === 0 && hovered === 1 && focusState.focused && focusState.opacity === 1 && focusState.outline !== 'none' && described;
        return { ok, detail: `opacité au repos ${idle}, au survol ${hovered}, au clavier ${focusState.opacity} (contour ${focusState.outline}) ; croix décrites par le titre de leur entrée ${described} ; captures history-light.png et history-dark.png` };
      });
    });

    // Dernier : une vraie capture ferme la fenêtre de l'icône (home), les autres vérifications ne peuvent plus s'en servir.
    // La même capture ouverte dans deux onglets : supprimée dans l'un, elle ne revient pas quand l'autre continue d'écrire.
    const deletedElsewhere = async (id, viewer) => {
      const other = await extensionPage(context, `viewer/viewer.html?id=${id}`);
      await other.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
      other.on('dialog', (dialog) => dialog.accept());
      await crossOf(other, id).click();
      for (let tries = 0; tries < 50 && (await hasCapture(viewer, id)); tries++) await new Promise((resolve) => setTimeout(resolve, 100));
      await other.close();
      await viewer.bringToFront();
    };

    await test('capture supprimée dans un autre onglet : elle ne revient pas, et la page le dit', async () => {
      await resetDb(home);
      const now = Date.now();
      await seedCapture(home, { heightPoints: 800, createdAt: now - MINUTE });
      const id = await seedCapture(home, { heightPoints: 800, createdAt: now });
      return withViewer(context, id, async (viewer) => {
        await deletedElsewhere(id, viewer);
        await openEditorOn(viewer, 0);
        await viewer.keyboard.press('r');
        await drag(viewer, { x: 1000, y: 500 }, { x: 1600, y: 800 });
        const alert = viewer.locator('#editor-alert');
        await alert.waitFor({ state: 'visible', timeout: 5000 });
        const message = await alert.innerText();
        // La copie marche encore : c'est ce que le message conseille.
        const { size } = await copyAndAnalyze(viewer, viewer.locator('#editor-copy'), colorProbes, [{ x: 996, y: 640, w: 8, h: 20, rgb: RED }]);
        const kept = await hasCapture(viewer, id);
        const marked = await annotatedIds(viewer);
        const held = await viewer.evaluate(leavingIsBlocked);
        const ok = /supprimée dans un autre onglet/.test(message) && !kept && marked.length === 0 && !held && size.startsWith('2560 × ');
        return { ok, detail: `« ${message.slice(0, 50)}… » ; capture revenue ${kept} ; annotations orphelines ${marked.length} ; fermeture retenue ${held} ; copie ${size}` };
      });
    });

    await test('écriture en échec, capture supprimée ailleurs : quitter ne la fait pas revenir', async () => {
      await resetDb(home);
      const now = Date.now();
      const next = await seedCapture(home, { heightPoints: 800, createdAt: now - MINUTE });
      const id = await seedCapture(home, { heightPoints: 800, createdAt: now });
      return withViewer(context, id, async (viewer) => {
        await openEditorOn(viewer, 0);
        await viewer.keyboard.press('r');
        await viewer.evaluate(() => {
          window.realPut = IDBObjectStore.prototype.put;
          IDBObjectStore.prototype.put = () => {
            throw new Error('disque plein');
          };
        });
        await drag(viewer, { x: 1000, y: 500 }, { x: 1600, y: 800 });
        await viewer.locator('#editor-alert').waitFor({ state: 'visible', timeout: 5000 });
        await finish(viewer);
        await deletedElsewhere(id, viewer);
        await viewer.evaluate(() => (IDBObjectStore.prototype.put = window.realPut));
        // Aucune question : il n'y a plus rien à sauver. On passe à l'autre capture.
        const asked = [];
        viewer.on('dialog', (dialog) => {
          asked.push(dialog.message());
          dialog.accept();
        });
        await entryOf(viewer, next).click();
        await showing(viewer, next);
        const kept = await hasCapture(viewer, id);
        const marked = await annotatedIds(viewer);
        const alertShown = await viewer.locator('#save-alert').isVisible();
        return { ok: !kept && marked.length === 0 && asked.length === 0 && !alertShown, detail: `capture revenue ${kept} ; annotations orphelines ${marked.length} ; questions ${asked.length} ; bandeau restant ${alertShown}` };
      });
    });

    // Un aplat noir en haut de la capture : visible dans la vignette, puis caché par un masque tracé dans l'éditeur.
    await test('vignette de l’historique : masques compris, jamais l’image d’origine', async () => {
      await resetDb(home);
      const id = await seedCapture(home, {
        heightPoints: 800,
        draw: (ctx) => {
          ctx.fillStyle = '#000';
          ctx.fillRect(200, 100, 1000, 600);
        },
      });
      const block = { x: 300, y: 200, w: 800, h: 400 };
      const darkInThumb = (viewer) =>
        viewer.evaluate(
          ({ id, block }) => {
            const canvas = document.querySelector(`.history-item[data-id="${id}"] canvas.history-thumb`);
            if (!canvas?.width) return -1;
            const ratio = canvas.width / 2560;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            const { data } = ctx.getImageData(Math.round(block.x * ratio), Math.round(block.y * ratio), Math.round(block.w * ratio), Math.round(block.h * ratio));
            let dark = 0;
            for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] < 300) dark++;
            return dark;
          },
          { id, block },
        );
      return withViewer(context, id, async (viewer) => {
        const images = await viewer.locator('#history img').count();
        await viewer.waitForFunction(() => document.querySelector('.history-thumb')?.width > 0, null, { timeout: 5000 });
        const before = await darkInThumb(viewer);
        await openEditorOn(viewer, 0);
        await viewer.keyboard.press('m');
        await drag(viewer, { x: 150, y: 60 }, { x: 1250, y: 760 });
        await waitForItems(viewer, id, 1);
        await finish(viewer);
        let after = before;
        for (let tries = 0; tries < 50 && after !== 0; tries++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          after = await darkInThumb(viewer);
        }
        const ok = images === 0 && before > 0 && after === 0;
        return { ok, detail: `images d’origine dans l’historique ${images} ; pixels sombres de l’aplat dans la vignette : avant ${before}, après le masque ${after}` };
      });
    });

    // Deux onglets sur la même capture : le masque posé dans l'un cache aussi la zone dans l'autre, sans recharger.
    await test('autre page de résultats ouverte : vignette, aperçu et copie suivent les masques', async () => {
      await resetDb(home);
      const id = await seedCapture(home, {
        heightPoints: 800,
        draw: (ctx) => {
          ctx.fillStyle = '#000';
          ctx.fillRect(200, 100, 1000, 600);
        },
      });
      return withViewer(context, id, async (other) => {
        const viewer = await extensionPage(context, `viewer/viewer.html?id=${id}`);
        try {
          await viewer.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
          await openEditorOn(viewer, 0);
          await viewer.keyboard.press('m');
          await drag(viewer, { x: 150, y: 60 }, { x: 1250, y: 760 });
          await waitForItems(viewer, id, 1);
          await finish(viewer);
          await other.bringToFront();
          const zone = { x: 300, y: 200, w: 800, h: 400 };
          const dark = () =>
            other.evaluate((zone) => {
              const count = (canvas) => {
                const ratio = canvas.width / 2560;
                const box = [zone.x, zone.y, zone.w, zone.h].map((v) => Math.round(v * ratio));
                const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(...box);
                let n = 0;
                for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] < 300) n++;
                return n;
              };
              return { thumb: count(document.querySelector('.history-thumb')), preview: count(document.querySelector('figure.part canvas')) };
            }, zone);
          let seen = await dark();
          for (let tries = 0; tries < 50 && (seen.thumb || seen.preview); tries++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            seen = await dark();
          }
          await other.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
          const { result } = await copyAndAnalyze(other, copyButton(other, 0), darkPixels, [zone]);
          const marked = isMarked((await other.evaluate(historyRows)).find((row) => row.id === id));
          return { ok: seen.thumb === 0 && seen.preview === 0 && result[0] === 0 && marked, detail: `pixels sombres : vignette ${seen.thumb}, aperçu ${seen.preview}, copie ${result[0]} ; mention annotée ${marked}` };
        } finally {
          await viewer.close();
        }
      });
    });

    // Le verrou d'un éditeur est partagé entre les onglets, et tombe avec lui : on attend qu'il soit libre, comme Chrome le fait en quelques millisecondes.
    const editorLockFree = async (page) => {
      const deadline = Date.now() + 5000;
      for (;;) {
        const held = await page.evaluate(async () => (await navigator.locks.query()).held.length);
        if (!held || Date.now() > deadline) return !held;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    const secondViewer = async (id) => {
      const page = await extensionPage(context, `viewer/viewer.html?id=${id}`);
      await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
      return page;
    };

    await test('deux onglets : un seul éditeur à la fois par capture', async () => {
      await resetDb(home);
      const id = await seedCapture(home, { heightPoints: 800 });
      return withViewer(context, id, async (first) => {
        const second = await secondViewer(id);
        try {
          await first.bringToFront();
          await openEditorOn(first, 0);
          await second.bringToFront();
          await annotateButton(second, 0).click();
          await second.waitForFunction(() => /autre onglet/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
          const message = await second.locator('#toast').innerText();
          const refused = await second.locator('#editor').isHidden();
          // Refermé là-bas, il s'ouvre ici, et l'échec précédent ne laisse rien de bloqué.
          await first.bringToFront();
          await finish(first);
          const free = await editorLockFree(second);
          await second.bringToFront();
          await openEditorOn(second, 0);
          const opened = await second.locator('#editor').isVisible();
          await finish(second);
          return { ok: refused && opened && free, detail: `refus ${refused} : « ${message} » ; verrou libéré ${free} ; ouvert ensuite ${opened}` };
        } finally {
          await second.close();
        }
      });
    });

    await test('deux onglets : fermer l’onglet qui annote libère la capture', async () => {
      await resetDb(home);
      const id = await seedCapture(home, { heightPoints: 800 });
      return withViewer(context, id, async (viewer) => {
        const leaving = await secondViewer(id);
        await leaving.bringToFront();
        await openEditorOn(leaving, 0);
        await leaving.close();
        const free = await editorLockFree(viewer);
        await viewer.bringToFront();
        await openEditorOn(viewer, 0);
        const opened = await viewer.locator('#editor').isVisible();
        await finish(viewer);
        return { ok: free && opened, detail: `verrou libéré ${free} ; éditeur ouvert ici ${opened}` };
      });
    });

    await test('deux onglets : une autre capture s’annote librement', async () => {
      await resetDb(home);
      const now = Date.now();
      const other = await seedCapture(home, { heightPoints: 800, createdAt: now - MINUTE });
      const id = await seedCapture(home, { heightPoints: 800, createdAt: now });
      return withViewer(context, id, async (first) => {
        const second = await secondViewer(other);
        try {
          await first.bringToFront();
          await openEditorOn(first, 0);
          await second.bringToFront();
          await openEditorOn(second, 0);
          const opened = await second.locator('#editor').isVisible();
          await finish(second);
          await first.bringToFront();
          await finish(first);
          return { ok: opened, detail: `deux éditeurs sur deux captures différentes ${opened}` };
        } finally {
          await second.close();
        }
      });
    });

    // Enregistré sans passer par la page ouverte : comme un autre onglet dont le message n'est pas arrivé (onglet en pause, par exemple).
    const blackBlock = (ctx) => {
      ctx.fillStyle = '#000';
      ctx.fillRect(200, 100, 1000, 600);
    };
    const blockMask = { id: 'venu-d-ailleurs', type: 'mask', color: 'red', size: 'm', x: 150, y: 60, width: 1100, height: 700, fill: '#e0e0e0' };
    const darkInPreview = (viewer) =>
      viewer.evaluate(() => {
        const canvas = document.querySelector('figure.part canvas');
        const ratio = canvas.width / 2560;
        const box = [300, 200, 800, 400].map((v) => Math.round(v * ratio));
        const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(...box);
        let dark = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] < 300) dark++;
        return dark;
      });

    await test('éditeur : il part de la liste enregistrée, et ne l’écrase pas', async () => {
      await resetDb(home);
      const id = await seedCapture(home, { heightPoints: 800, draw: blackBlock });
      return withViewer(context, id, async (viewer) => {
        await saveItems(home, id, [blockMask]);
        await openEditorOn(viewer, 0);
        await viewer.keyboard.press('r');
        await drag(viewer, { x: 1400, y: 500 }, { x: 1800, y: 800 });
        const items = await waitForItems(viewer, id, 2);
        await finish(viewer);
        const dark = await darkInPreview(viewer);
        return { ok: items.length === 2 && items.some((item) => item.id === blockMask.id) && dark === 0, detail: `${items.length} annotation(s), masque gardé ${items.some((item) => item.id === blockMask.id)} ; pixels sombres dans l’aperçu ${dark}` };
      });
    });

    await test('éditeur ouvert puis fermé sans rien changer : l’aperçu suit la liste enregistrée', async () => {
      await resetDb(home);
      const id = await seedCapture(home, { heightPoints: 800, draw: blackBlock });
      return withViewer(context, id, async (viewer) => {
        await saveItems(home, id, [blockMask]);
        await openEditorOn(viewer, 0);
        await finish(viewer);
        const dark = await darkInPreview(viewer);
        const { result } = await copyAndAnalyze(viewer, copyButton(viewer, 0), darkPixels, [{ x: 300, y: 200, w: 800, h: 400 }]);
        return { ok: dark === 0 && result[0] === 0, detail: `pixels sombres : aperçu ${dark}, copie ${result[0]}` };
      });
    });

    // Une écriture ratée laisse un masque non enregistré : tant qu'il n'est pas rattrapé, aucun autre onglet ne peut écrire par-dessus.
    await test('écriture en échec : l’autre onglet attend, et aucun masque n’est écrasé', async () => {
      await resetDb(home);
      const id = await seedCapture(home, { heightPoints: 800, draw: blackBlock });
      return withViewer(context, id, async (first) => {
        const second = await secondViewer(id);
        try {
          await first.bringToFront();
          await openEditorOn(first, 0);
          await first.keyboard.press('m');
          await first.evaluate(() => {
            window.realPut = IDBObjectStore.prototype.put;
            IDBObjectStore.prototype.put = () => {
              throw new Error('disque plein');
            };
          });
          await drag(first, { x: 150, y: 60 }, { x: 1250, y: 760 });
          await first.locator('#editor-alert').waitFor({ state: 'visible', timeout: 5000 });
          await finish(first);
          await second.bringToFront();
          await annotateButton(second, 0).click();
          await second.waitForFunction(() => /autre onglet/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
          const refused = await second.locator('#editor').isHidden();
          // Le même onglet peut rouvrir son éditeur sans attendre : la modification suivante rattrape tout, et libère la capture à la fermeture.
          await first.bringToFront();
          await first.evaluate(() => (IDBObjectStore.prototype.put = window.realPut));
          await openEditorOn(first, 0);
          await first.keyboard.press('r');
          await drag(first, { x: 1400, y: 500 }, { x: 1800, y: 800 });
          const saved = await waitForItems(first, id, 2);
          await finish(first);
          const free = await editorLockFree(second);
          await second.bringToFront();
          await openEditorOn(second, 0);
          await finish(second);
          const dark = [await darkInPreview(first), await darkInPreview(second)];
          return { ok: refused && saved.length === 2 && free && dark.every((n) => n === 0), detail: `refus ${refused} ; ${saved.length} annotation(s) enregistrée(s) ; verrou libéré ${free} ; pixels sombres ${dark.join(' et ')}` };
        } finally {
          await second.close();
        }
      });
    });

    // Réduite, une jonction entre deux tranches tombe entre deux pixels : aucun fond clair ne doit y transparaître.
    await test('jonctions sur fond sombre : aucun trait dans l’aperçu, l’éditeur et la vignette', async () => {
      await resetDb(home);
      const id = await seedCapture(home, {
        heightPoints: 2000,
        draw: (ctx, { width, height }) => {
          ctx.fillStyle = 'rgb(18, 20, 24)';
          ctx.fillRect(0, 0, width, height);
        },
      });
      const lightRows = (viewer, selector) =>
        viewer.evaluate((selector) => {
          let canvases = 0;
          let rows = 0;
          for (const canvas of document.querySelectorAll(selector)) {
            canvases++;
            const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(canvas.width >> 1, 0, 1, canvas.height);
            // La dernière rangée, à la hauteur arrondie, peut n'être couverte qu'en partie : ce n'est pas une jonction.
            for (let y = 0; y < canvas.height - 1; y++) if (data[y * 4 + 3] !== 255 || data[y * 4] > 40) rows++;
          }
          return { canvases, rows };
        }, selector);
      // Les canvas apparaissent avant d'être dessinés : on laisse aux derniers le temps de finir.
      const settled = async (viewer, selector) => {
        const deadline = Date.now() + 3000;
        for (;;) {
          const seen = await lightRows(viewer, selector);
          if ((seen.canvases && !seen.rows) || Date.now() > deadline) return seen;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      };
      return withViewer(context, id, async (viewer) => {
        await viewer.setViewportSize({ width: 1100, height: 900 });
        const preview = await settled(viewer, 'figure.part canvas');
        const thumb = await settled(viewer, '.history-thumb');
        await openEditorOn(viewer, 0);
        const editor = await settled(viewer, '.editor-tile canvas');
        await finish(viewer);
        const ok = [preview, thumb, editor].every(({ canvases, rows }) => canvases > 0 && rows === 0);
        return { ok, detail: `rangées claires : aperçu ${preview.rows} (${preview.canvases} image(s)), vignette ${thumb.rows}, éditeur ${editor.rows} (${editor.canvases} tuile(s))` };
      });
    });

    await test('capture supprimée ailleurs : le bandeau part quand il n’y a plus d’image', async () => {
      await resetDb(home);
      const now = Date.now();
      const next = await seedCapture(home, { heightPoints: 800, createdAt: now - MINUTE });
      const id = await seedCapture(home, { heightPoints: 800, createdAt: now });
      return withViewer(context, id, async (viewer) => {
        viewer.on('dialog', (dialog) => dialog.accept());
        await deletedElsewhere(id, viewer);
        await openEditorOn(viewer, 0);
        await viewer.keyboard.press('r');
        await drag(viewer, { x: 1000, y: 500 }, { x: 1600, y: 800 });
        await viewer.locator('#editor-alert').waitFor({ state: 'visible', timeout: 5000 });
        await finish(viewer);
        const shown = await viewer.locator('#save-alert').isVisible();
        // Son entrée est encore dans la liste de cette page : l'ouvrir mène à l'écran « introuvable ».
        await entryOf(viewer, id).click();
        await viewer.locator('.empty h2').waitFor({ timeout: 5000 });
        const heading = await viewer.locator('.empty h2').innerText();
        const afterMissing = await viewer.locator('#save-alert').isVisible();
        // Dernier cas : plus aucune capture du tout. On revient sur le bandeau en supprimant la dernière depuis un autre onglet.
        await entryOf(viewer, next).click();
        await showing(viewer, next);
        await deletedElsewhere(next, viewer);
        await openEditorOn(viewer, 0);
        await viewer.keyboard.press('r');
        await drag(viewer, { x: 1000, y: 500 }, { x: 1600, y: 800 });
        await viewer.locator('#editor-alert').waitFor({ state: 'visible', timeout: 5000 });
        await finish(viewer);
        await crossOf(viewer, id).click();
        await crossOf(viewer, next).click();
        await viewer.waitForFunction(() => document.querySelector('.empty h2')?.textContent === 'Aucune capture pour l’instant', null, { timeout: 5000 });
        const afterLast = await viewer.locator('#save-alert').isVisible();
        return { ok: shown && heading === 'Capture introuvable' && !afterMissing && !afterLast, detail: `bandeau affiché ${shown} ; sur « ${heading} » ${afterMissing} ; sur l’écran vide ${afterLast}` };
      });
    });

    await test('16 captures : l’annotée survit', async () => {
      await resetDb(home);
      const sw = context.serviceWorkers()[0];
      const { page, tabId } = await openTab(context, sw, `${base}/body-scroll.html`);
      let seeder;
      try {
        const real = await capture(context, sw, tabId, 'full');
        if (!real.viewer) throw new Error(`capture impossible : ${real.error}`);
        await real.viewer.close();
        seeder = await extensionPage(context, 'popup/popup.html');
        await saveItems(seeder, real.id, [RECT]);
        // 16 captures ordinaires plus récentes que la vraie, puis le nettoyage de l'extension (15 captures non annotées gardées).
        const now = Date.now();
        const plain = [];
        for (let k = 1; k <= 16; k++) plain.push(await seedCapture(seeder, { heightPoints: 800, createdAt: now + k * 1000 }));
        await seeder.evaluate(async () => {
          const { pruneCaptures } = await import(chrome.runtime.getURL('lib/db.js'));
          await pruneCaptures(15);
        });
        return await withViewer(context, real.id, async (viewer) => {
          const rows = await viewer.evaluate(historyRows);
          const row = rows.find((r) => r.id === real.id);
          const listed = rows.map((r) => r.id);
          const ok =
            Boolean(row) && isMarked(row) && rows.length === 16 && !listed.includes(plain[0]) && listed.slice(0, 15).join() === plain.slice(1).reverse().join();
          return { ok, detail: `${rows.length} captures listées, annotée présente ${Boolean(row)} (mention ${row ? isMarked(row) : '-'}), la plus ancienne ordinaire retirée ${!listed.includes(plain[0])}` };
        });
      } finally {
        await seeder?.close();
        await page.close();
      }
    });

    // Une page de résultats reste ouverte sur la plus vieille capture, atteinte depuis l'historique. Une vraie capture déclenche le vrai
    // nettoyage (15 captures ordinaires gardées) : la capture affichée n'est pas retirée, et on peut encore l'annoter.
    // Une capture referme la fenêtre de l'icône, donc `home` : ce test, comme le précédent, a sa propre page.
    await test('nettoyage : la capture affichée dans une page de résultats reste, et s’annote', async () => {
      const seeder = await extensionPage(context, 'popup/popup.html');
      await resetDb(seeder);
      const now = Date.now();
      const ids = [];
      for (let k = 0; k < 15; k++) ids.push(await seedCapture(seeder, { heightPoints: 800, createdAt: now - (k + 1) * MINUTE }));
      const oldest = ids.at(-1);
      const sw = context.serviceWorkers()[0];
      return withViewer(context, ids[0], async (viewer) => {
        await entryOf(viewer, oldest).click();
        await showing(viewer, oldest);
        const { page, tabId } = await openTab(context, sw, `${base}/body-scroll.html`);
        const real = await capture(context, sw, tabId, 'full');
        await page.close();
        if (!real.viewer) throw new Error(`capture impossible : ${real.error}`);
        await real.viewer.close();
        const kept = await hasCapture(viewer, oldest);
        await viewer.bringToFront();
        await openEditorOn(viewer, 0);
        await viewer.keyboard.press('r');
        await drag(viewer, { x: 1000, y: 500 }, { x: 1600, y: 800 });
        await waitForItems(viewer, oldest, 1);
        await finish(viewer);
        await viewer.reload();
        await viewer.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
        const items = await storedItems(viewer, oldest);
        const missing = await viewer.locator('.empty').count();
        const row = (await viewer.evaluate(historyRows)).find((r) => r.id === oldest);
        const ok = kept && items.length === 1 && missing === 0 && Boolean(row) && isMarked(row);
        return { ok, detail: `gardée après le nettoyage ${kept} ; après rechargement : ${items.length} annotation(s), écran « introuvable » ${missing}, annotée ${row ? isMarked(row) : '-'}` };
      });
    });

    // Chrome met en veille un onglet inactif pour libérer de la mémoire : sa page n'existe plus, mais son onglet montre encore cette capture.
    await test('nettoyage : un onglet mis en veille garde sa capture', async () => {
      const seeder = await extensionPage(context, 'popup/popup.html');
      await resetDb(seeder);
      const now = Date.now();
      const ids = [];
      for (let k = 0; k < 15; k++) ids.push(await seedCapture(seeder, { heightPoints: 800, createdAt: now - (k + 1) * MINUTE }));
      await seeder.close();
      const oldest = ids.at(-1);
      const sleeping = await extensionPage(context, `viewer/viewer.html?id=${oldest}`);
      await sleeping.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
      const sw = context.serviceWorkers()[0];
      const { page, tabId } = await openTab(context, sw, `${base}/body-scroll.html`);
      const sleepingTab = await sw.evaluate(async (oldest) => (await chrome.tabs.query({})).find(({ url }) => url?.includes(oldest))?.id, oldest);
      // Chrome peut donner un nouveau numéro à l'onglet mis en veille : on garde celui qu'il rend.
      const { id: sleepingId, discarded: asleep } = await sw.evaluate(async (id) => {
        const { id: newId, discarded } = await chrome.tabs.discard(id);
        return { id: newId, discarded };
      }, sleepingTab);
      const real = await capture(context, sw, tabId, 'full');
      await page.close();
      if (!real.viewer) throw new Error(`capture impossible : ${real.error}`);
      const kept = await hasCapture(real.viewer, oldest);
      await real.viewer.close();
      await sw.evaluate((id) => chrome.tabs.remove(id), sleepingId);
      return { ok: asleep && kept, detail: `onglet en veille ${asleep} ; capture gardée après le nettoyage ${kept}` };
    });
  } finally {
    await home.close();
  }
}

// ---- Finitions : clavier, tracé fluide, clair et sombre, hors ligne (tâche 7) ----

// Noms des boutons de l'éditeur, dans l'ordre de la page : outils (voir TOOLS), couleurs (COLORS) puis tailles (SIZES).
const TOOL_NAMES = ['Flèche', 'Rectangle', 'Surligneur', 'Texte', 'Pastille numérotée', 'Masquer', 'Crayon'];
const COLOR_NAMES = ['Rouge', 'Jaune', 'Vert', 'Bleu', 'Noir'];
const SIZE_NAMES = ['Taille : Petit', 'Taille : Moyen', 'Taille : Grand'];

// Dans la page : l'élément qui a le focus, avec son nom, sa présence dans l'éditeur et son contour de focus.
function focusedStop() {
  const el = document.activeElement;
  const style = getComputedStyle(el);
  return {
    id: el.id,
    name: el.getAttribute('aria-label') ?? el.textContent.trim(),
    inEditor: document.getElementById('editor').contains(el),
    outline: style.outlineStyle,
    width: parseFloat(style.outlineWidth),
  };
}

// Dans la page : note la durée de la plus longue tâche qui bloque l'affichage (lue ensuite par longestTask).
function watchLongTasks() {
  window.longest = 0;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.longest = Math.max(window.longest, entry.duration);
  }).observe({ type: 'longtask' });
}

const longestTask = () => window.longest;

// Fonction pour inImage : pixel [r, v, b] au point (x, y) de l'image.
const pixelAt = (ctx, size, { x, y }) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3);

async function testFinish(context) {
  console.log('\n— Finitions : clavier, tracé fluide, clair et sombre');
  const home = await extensionPage(context, 'popup/popup.html');
  try {
    await resetDb(home);
    // 12 000 points à ×2 : trois images de 8 000 px avec le découpage « Moyen ».
    const medium = await seedCapture(home, { heightPoints: 12000 });

    await test('parcours au clavier', () =>
      annotated(context, home, medium, [BOX], async (viewer) => {
        await openEditorOn(viewer, 0);
        // Deux tracés puis un retour en arrière : Annuler, Rétablir et « Tout effacer » sont actifs, donc atteignables au clavier.
        await drag(viewer, { x: 800, y: 300 }, { x: 1400, y: 300 });
        await drag(viewer, { x: 800, y: 400 }, { x: 1400, y: 400 });
        await viewer.keyboard.press('Meta+z');
        const press = async (key) => {
          await viewer.keyboard.press(key);
          return viewer.evaluate(focusedStop);
        };
        // Depuis le premier outil, Maj+Tab remonte jusqu'à Terminer ; Tab redescend ensuite jusqu'à la dernière taille.
        await viewer.locator('#editor-tools button').first().focus();
        const head = [];
        for (let i = 0; i < 6; i++) head.unshift(await press('Shift+Tab'));
        for (let i = 0; i < 6; i++) await viewer.keyboard.press('Tab');
        const tail = [await viewer.evaluate(focusedStop)];
        for (let i = 1; i < TOOL_NAMES.length + COLOR_NAMES.length + SIZE_NAMES.length; i++) tail.push(await press('Tab'));
        const stops = [...head, ...tail];
        const expected = ['Terminer', 'Annuler', 'Rétablir', 'Tout effacer', 'Recadrer', 'Copier l’image 1', ...TOOL_NAMES, ...COLOR_NAMES, ...SIZE_NAMES];

        // Après la dernière taille, la zone de la capture a le focus (contour visible) et Page suivante la fait défiler.
        const area = await press('Tab');
        const scrolledFrom = await viewer.evaluate(() => document.getElementById('editor-scroll').scrollTop);
        await viewer.keyboard.press('PageDown');
        const scrolled = await viewer.waitForFunction((top) => document.getElementById('editor-scroll').scrollTop > top, scrolledFrom, { timeout: 5000 }).then(
          () => true,
          () => false,
        );

        // Retour sur le dernier bouton de couleur : son anneau de focus se lit en clair comme en sombre.
        let swatch;
        for (let i = 0; i < 4; i++) swatch = await press('Shift+Tab');
        try {
          for (const scheme of ['light', 'dark']) {
            await viewer.emulateMedia({ colorScheme: scheme });
            await viewer.locator('#editor-tools').screenshot({ path: path.join(WORK, `editor-focus-${scheme}.png`) });
          }
        } finally {
          await viewer.emulateMedia({ colorScheme: null });
        }

        const wrongName = stops.map((stop, i) => (stop.name === expected[i] ? null : `${i + 1}ᵉ arrêt « ${stop.name} » au lieu de « ${expected[i]} »`)).filter(Boolean);
        const noRing = stops.filter((stop) => stop.outline === 'none' || !(stop.width > 0)).map((stop) => stop.name);
        const outside = stops.filter((stop) => !stop.inEditor).map((stop) => stop.name);
        const areaFocused = area.id === 'editor-scroll' && area.outline !== 'none' && area.width > 0;
        const ok = stops.length === expected.length && wrongName.length === 0 && noRing.length === 0 && outside.length === 0 && areaFocused && scrolled && swatch.name === 'Noir';
        const problems = [
          ...wrongName,
          noRing.length ? `sans contour de focus : ${noRing.join(', ')}` : '',
          outside.length ? `hors de l’éditeur : ${outside.join(', ')}` : '',
          areaFocused ? '' : `zone de la capture sans focus visible (focus sur « ${area.id || area.name} »)`,
          scrolled ? '' : 'Page suivante ne fait pas défiler la capture',
        ].filter(Boolean);
        return { ok, detail: problems.length ? problems.join(' ; ') : `${stops.length} boutons au clavier, tous avec un contour de focus ; zone de la capture focalisée et défilée par Page suivante` };
      }));

    // 100 000 points à ×2 : 200 000 px de haut, 25 images avec le découpage « Moyen ».
    const huge = await seedCapture(home, { heightPoints: 100_000 });

    await test('tracé fluide', () =>
      withViewer(context, huge, async (viewer) => {
        const { tops } = await partLayout(viewer);
        await openEditorOn(viewer, tops.length - 1);
        await viewer.keyboard.press('c');
        // Un tracé en vague, au milieu de la zone visible : 60 mouvements de souris, un par point d'écran de 5 de large.
        const start = await viewer.evaluate(() => {
          const page = document.getElementById('editor-page').getBoundingClientRect();
          const area = document.getElementById('editor-scroll').getBoundingClientRect();
          return { x: page.left + page.width / 4, y: area.top + area.height / 2 };
        });
        await viewer.evaluate(watchLongTasks);
        const began = performance.now();
        await viewer.mouse.move(start.x, start.y);
        await viewer.mouse.down();
        for (let i = 1; i <= 60; i++) await viewer.mouse.move(start.x + i * 5, start.y + Math.sin(i / 5) * 40);
        await viewer.mouse.up();
        const ms = performance.now() - began;
        const [pen] = await waitForItems(viewer, huge, 1);
        const points = pen ? pen.points.length / 2 : 0;
        const longest = await viewer.evaluate(longestTask);
        return {
          ok: ms < 2000 && pen?.type === 'pen' && points >= 50,
          detail: `${points} points en ${Math.round(ms)} ms (limite 2 000 ms) sur ${tops.length} images, plus longue tâche bloquante ${Math.round(longest)} ms`,
        };
      }));

    await test('clair et sombre : captures de l’éditeur, d’un tracé en cours et de la page', () => {
      // Une annotation de chaque type, plus un masque sur « Ligne 11 », pour relire le rendu à l'œil dans les deux modes.
      const items = [...EACH_TYPE.items, { id: 'k1', type: 'mask', color: 'red', size: 'm', x: 60, y: 1340, width: 300, height: 80, fill: '#c0c0c0' }];
      return annotated(context, home, medium, items, async (viewer) => {
        await openEditorOn(viewer, 0);
        const files = {};
        const shoot = async (name) => {
          files[name] = path.join(WORK, `${name}.png`);
          return viewer.screenshot({ path: files[name] });
        };
        // Coin haut gauche de la fenêtre, dans l'en-tête de l'éditeur : clair ou sombre selon le mode.
        const corners = {};
        let greenBefore;
        let greenDuring;
        let near;
        try {
          for (const scheme of ['light', 'dark']) {
            await viewer.emulateMedia({ colorScheme: scheme });
            await viewer.evaluate(scrollEditorTo, 0);
            await shoot(`editor-${scheme}`);
            corners[scheme] = await inImage(viewer, files[`editor-${scheme}`], pixelAt, { x: 10, y: 10 });
          }

          // Le tracé en cours et la page de résultats en mode clair (le mode du système n'est pas fixé).
          await viewer.emulateMedia({ colorScheme: 'light' });
          // Tracé au crayon vert dans une zone vide plus bas, souris encore enfoncée : le vert du tracé s'ajoute à celui d'avant.
          await viewer.keyboard.press('c');
          await viewer.getByRole('button', { name: 'Vert', exact: true }).click();
          await viewer.evaluate(scrollEditorTo, 1800);
          const before = await viewer.screenshot();
          const from = await viewer.evaluate(windowPoint, { x: 200, y: 2200 });
          await viewer.mouse.move(from.x, from.y);
          await viewer.mouse.down();
          for (let i = 1; i <= 40; i++) await viewer.mouse.move(from.x + i * 9, from.y + Math.sin(i / 4) * 30);
          const during = await shoot('editor-drawing');
          await viewer.mouse.up();
          const green = async (bytes) => (await viewer.evaluate(screenColors, { bytes: bytes.toString('base64'), probes: [GREEN] })).near[0];
          [greenBefore, greenDuring] = [await green(before), await green(during)];

          // Page de résultats après « Terminer » : les aperçus portent les annotations.
          await viewer.evaluate(scrollEditorTo, 0);
          await finish(viewer);
          const page = await shoot('viewer-annotated');
          ({ near } = await viewer.evaluate(screenColors, { bytes: page.toString('base64'), probes: [RED, BLUE] }));
        } finally {
          await viewer.emulateMedia({ colorScheme: null });
        }

        const sizes = await Promise.all(Object.values(files).map(async (file) => (await fs.stat(file)).size));
        const ok =
          sizes.length === 4 &&
          sizes.every((size) => size > 20_000) &&
          corners.light.every((c) => c > 200) &&
          corners.dark.every((c) => c < 60) &&
          greenDuring - greenBefore > 300 &&
          near.every((count) => count > 50);
        return {
          ok,
          detail: `${Object.keys(files).join(', ')} ; en-tête clair ${corners.light}, sombre ${corners.dark} ; pixels verts ${greenBefore} → ${greenDuring} pendant le tracé ; rouge et bleu dans la page ${near}`,
        };
      });
    });
  } finally {
    await home.close();
  }
}

async function main() {
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(WORK, { recursive: true });
  const extension = await prepareExtension(WORK);
  const server = await serve(path.join(import.meta.dirname, 'pages'));
  const base = `http://127.0.0.1:${server.address().port}`;
  const context = await launch(extension, 'profile', WORK);
  // D14 : toute requête vers un autre hôte que le serveur de test est refusée, et comptée.
  const outside = [];
  await context.route(
    (url) => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1',
    (route) => {
      outside.push(route.request().url());
      return route.abort();
    },
  );
  try {
    if (!ONLY || ONLY === 'storage') await testStorage(context);
    if (!ONLY || ONLY === 'rendering') await testRendering(context);
    if (!ONLY || ONLY === 'editor') await testEditor(context, base);
    if (!ONLY || ONLY === 'tools') await testTools(context);
    if (!ONLY || ONLY === 'retouch') await testRetouch(context);
    if (!ONLY || ONLY === 'history') await testHistory(context, base);
    if (!ONLY || ONLY === 'finish') await testFinish(context);
    await test('aucune requête vers internet', async () => ({ ok: outside.length === 0, detail: outside.length ? outside.slice(0, 3).join(', ') : 'aucune requête hors 127.0.0.1' }));
  } finally {
    await context.close();
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
