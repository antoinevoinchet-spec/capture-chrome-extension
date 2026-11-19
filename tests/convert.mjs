// Test du convertisseur d'images : liste, formats, tailles, HEIC, PDF, lots et téléchargements.
// Même Chromium et même extension que e2e.mjs (écran ×2). Le PDF est contrôlé avec pdfinfo et pdftoppm (poppler).
// Usage : node convert.mjs <dossier de sortie> [page|convert|heic|pdf|batch|preview|finish] [motif]

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { EXTENSION, check, extensionPage, launch, prepareExtension, results, serve } from './lib.mjs';

const run = promisify(execFile);
const WORK = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, 'out-convert'));
const ONLY = process.argv[3];
const NAMED = process.argv[4] ? new RegExp(process.argv[4], 'i') : null;
const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const HEIC_SHA256 = 'e0a515585872c319c601';
const BIG_SCREEN = { width: 1280, height: 900 };

async function test(name, body) {
  if (NAMED && !NAMED.test(name)) return;
  try {
    const { ok, detail } = await body();
    check(name, ok, detail);
  } catch (err) {
    check(name, false, String(err.message ?? err).split('\n')[0].slice(0, 240));
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openConverter(context) {
  const page = await extensionPage(context, 'convert/convert.html');
  await page.waitForFunction(() => document.body.dataset.state === 'idle');
  return page;
}

// Une image fabriquée dans la page : `solid`, `half` (moitié droite transparente), `stripes` (lignes d'un pixel) ou `noise`.
async function image(page, name, { width = 1200, height = 800, paint = 'solid', color = '#336699', type = 'image/png', quality } = {}) {
  const base64 = await page.evaluate(
    async ({ width, height, paint, color, type, quality }) => {
      const ctx = new OffscreenCanvas(width, height).getContext('2d');
      if (paint === 'solid') {
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, width, height);
      } else if (paint === 'half') {
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, width / 2, height);
      } else if (paint === 'stripes') {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#000';
        for (let y = 0; y < height; y += 2) ctx.fillRect(0, y, width, 1);
      } else {
        const pixels = ctx.createImageData(width, height);
        let seed = 12345;
        for (let i = 0; i < pixels.data.length; i += 4) {
          for (let c = 0; c < 3; c++) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            pixels.data[i + c] = (seed >> 16) & 255;
          }
          pixels.data[i + 3] = 255;
        }
        ctx.putImageData(pixels, 0, 0);
      }
      const bytes = new Uint8Array(await (await ctx.canvas.convertToBlob({ type, quality })).arrayBuffer());
      let text = '';
      for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
      return btoa(text);
    },
    { width, height, paint, color, type, quality },
  );
  return { name, mimeType: type, buffer: Buffer.from(base64, 'base64') };
}

const MIME = { heic: 'image/heic', png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif' };
const fixture = async (name, as = name) => ({ name: as, mimeType: MIME[name.split('.').pop()], buffer: await fs.readFile(path.join(FIXTURES, name)) });
const textFile = (name, content = 'pas une image') => ({ name, mimeType: 'text/plain', buffer: Buffer.from(content) });

const add = (page, files) => page.setInputFiles('#files', files);

// Dépose des fichiers comme le ferait le Finder : `new File` garde les noms que le champ de fichiers nettoierait.
async function dropFiles(page, files) {
  await page.evaluate((list) => {
    const transfer = new DataTransfer();
    for (const { name, type, base64 } of list) {
      transfer.items.add(new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], name, { type }));
    }
    document.getElementById('drop').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, files.map(({ name, mimeType, buffer }) => ({ name, type: mimeType, base64: buffer.toString('base64') })));
}

const pick = (page, group, label) => page.locator(`#${group} button`, { hasText: new RegExp(`^${label}$`) }).click();
const setFormat = (page, label) => pick(page, 'format', label);
const setQuality = (page, label) => pick(page, 'quality', label);

async function setResize(page, label, value) {
  await pick(page, 'resize', label);
  if (value !== undefined) await page.locator('#resize-value').fill(String(value));
}

// la conversion part dès l'ajout. On attend sa fin ; si des fichiers restent à refaire (un réglage a changé),
// on clique « Reconvertir », puis on attend de nouveau.
async function convert(page) {
  const idle = () =>
    page.waitForFunction(() => document.body.dataset.state === 'idle' && !document.querySelector('.item[data-status="working"]'), undefined, { timeout: 180_000 });
  await idle();
  const again = page.locator('#convert');
  if ((await again.isVisible()) && !(await again.isDisabled())) {
    await again.click();
    await idle();
  }
}

const rows = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.item')].map((row) => ({
      name: row.querySelector('.item-name').textContent,
      status: row.dataset.status,
      detail: row.querySelector('.item-detail').textContent,
    })),
  );

// Remplace le téléchargement par un relevé des fichiers. `pass` le laisse aussi se faire pour de vrai.
async function spyDownloads(page, { pass = false } = {}) {
  await page.evaluate((pass) => {
    const real = chrome.downloads.download.bind(chrome.downloads);
    window.saved = [];
    chrome.downloads.download = async (options) => {
      window.saved.push(options);
      return pass ? real(options) : window.saved.length;
    };
  }, pass);
}

const savedNames = (page) => page.evaluate(() => window.saved.map((entry) => entry.filename));

async function savedBytes(page, index) {
  const base64 = await page.evaluate(async (index) => {
    const bytes = new Uint8Array(await (await fetch(window.saved[index].url)).arrayBuffer());
    let text = '';
    for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(text);
  }, index);
  return Buffer.from(base64, 'base64');
}

function fileKind(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  if (bytes.subarray(1, 4).toString() === 'PNG') return 'png';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'webp';
  if (bytes.subarray(0, 4).toString() === '%PDF') return 'pdf';
  return 'autre';
}

// Dimensions et pixels d'une image, lue par Chrome : `points` en pixels, rend [r, g, b, a].
const readImage = (page, bytes, points = []) =>
  page.evaluate(
    async ({ base64, points }) => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))]));
      const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      return { width: bitmap.width, height: bitmap.height, pixels: points.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]) };
    },
    { base64: bytes.toString('base64'), points },
  );

// Le plus grand écart, canal par canal, entre deux séries de pixels.
const maxGap = (a, b) => Math.max(...a.flatMap((pixel, i) => pixel.slice(0, 3).map((value, c) => Math.abs(value - b[i][c]))));

const BANDS = 8;
const bandPoints = (width, height) => Array.from({ length: BANDS }, (_, k) => [Math.round(((k + 0.5) * width) / BANDS), Math.round(height * 0.3)]);

// Compare une sortie à sa référence macOS, au milieu de chaque bande de couleur.
async function gapToReference(page, bytes, referenceName) {
  const reference = await fs.readFile(path.join(FIXTURES, referenceName));
  const size = await readImage(page, bytes);
  const points = bandPoints(size.width, size.height);
  const mine = await readImage(page, bytes, points);
  const theirs = await readImage(page, reference, points);
  return { gap: maxGap(mine.pixels, theirs.pixels), mine: mine.pixels, theirs: theirs.pixels };
}

// Le plus long blocage de la page pendant `work`.
async function longestFreeze(page, work) {
  await page.evaluate(() => {
    window.freeze = 0;
    let last = performance.now();
    window.freezeTimer = setInterval(() => {
      const now = performance.now();
      window.freeze = Math.max(window.freeze, now - last);
      last = now;
    }, 50);
  });
  await work();
  return page.evaluate(() => {
    clearInterval(window.freezeTimer);
    return Math.round(window.freeze);
  });
}

async function pdfPages(file) {
  const { stdout } = await run('pdfinfo', ['-f', '1', '-l', '999', file]);
  const count = Number(stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
  const sizes = [...stdout.matchAll(/^Page\s+\d+ size:\s+([\d.]+) x ([\d.]+) pts/gm)].map((m) => [Number(m[1]), Number(m[2])]);
  return { count, sizes, text: stdout };
}

async function savePdf(page, index, label) {
  const bytes = await savedBytes(page, index);
  const file = path.join(WORK, `${label}.pdf`);
  await fs.writeFile(file, bytes);
  return { bytes, file };
}

// Rend une page du PDF à 96 points par pouce : 1 pixel de l'image pour 1 pixel du rendu.
async function renderPage(file, number, label) {
  const prefix = path.join(WORK, `${label}-p${number}`);
  await run('pdftoppm', ['-r', '96', '-f', String(number), '-l', String(number), '-png', '-singlefile', file, prefix]);
  return fs.readFile(`${prefix}.png`);
}

async function groupPage(context) {
  console.log('\n— La page et la liste');
  await test('le lien de la fenêtre ouvre le convertisseur', async () => {
    const popup = await extensionPage(context, 'popup/popup.html');
    const [opened] = await Promise.all([context.waitForEvent('page'), popup.locator('#convert').click()]);
    await opened.waitForLoadState();
    const title = await opened.title();
    const url = opened.url();
    await opened.close();
    return { ok: url.endsWith('/convert/convert.html') && title === 'Convertir des images', detail: `${title}, ${url.split('/').slice(-2).join('/')}` };
  });
  const page = await openConverter(context);
  await test('le champ de fichiers ajoute les images en ordre naturel', async () => {
    await add(page, [await image(page, 'IMG_10.png', { width: 20, height: 20 }), await image(page, 'IMG_2.png', { width: 20, height: 20 })]);
    const names = (await rows(page)).map((row) => row.name);
    return { ok: names.join() === 'IMG_2.png,IMG_10.png', detail: names.join() };
  });
  await test('un dépôt simulé ajoute à la suite', async () => {
    await dropFiles(page, [await image(page, 'A_2.png', { width: 20, height: 20 }), await image(page, 'A_1.png', { width: 20, height: 20 })]);
    const names = (await rows(page)).map((row) => row.name);
    return { ok: names.join() === 'IMG_2.png,IMG_10.png,A_1.png,A_2.png', detail: names.join() };
  });
  await test('la croix retire une image', async () => {
    await page.locator('.item').nth(1).locator('.item-remove').click();
    const names = (await rows(page)).map((row) => row.name);
    return { ok: names.join() === 'IMG_2.png,A_1.png,A_2.png', detail: names.join() };
  });
  await test('Tout retirer vide la liste', async () => {
    await page.locator('#clear').click();
    const count = (await rows(page)).length;
    const convertOff = await page.locator('#convert').isDisabled();
    return { ok: count === 0 && convertOff, detail: `${count} ligne, Convertir désactivé : ${convertOff}` };
  });
  await page.close();
  await test('la bibliothèque a la bonne empreinte, avec sa licence', async () => {
    const bytes = await fs.readFile(path.join(EXTENSION, 'vendor/heic-to-csp.js'));
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    const licence = await fs.readFile(path.join(EXTENSION, 'vendor/heic-to-LICENSE.txt'), 'utf8');
    return { ok: sha.startsWith(HEIC_SHA256) && /GNU Lesser General Public License/.test(licence), detail: sha.slice(0, 20) };
  });
}

async function groupConvert(context) {
  console.log('\n— Convertir une image');
  const page = await openConverter(context);
  await spyDownloads(page);
  const clearAll = async () => {
    await page.locator('#clear').click();
    await page.evaluate(() => (window.saved = []));
  };

  for (const [label, kind] of [['JPG', 'jpg'], ['PNG', 'png'], ['WebP', 'webp']]) {
    await test(`PNG transparent vers ${label} : type réel et fond`, async () => {
      await setFormat(page, label);
      await add(page, await image(page, 'half.png', { width: 400, height: 200, paint: 'half', color: '#ff0000' }));
      await convert(page);
      await page.locator('#download-all').click();
      await page.waitForFunction(() => window.saved.length === 1);
      const bytes = await savedBytes(page, 0);
      const { pixels, width, height } = await readImage(page, bytes, [[100, 100], [300, 100]]);
      const [left, right] = pixels;
      const backgroundOk = kind === 'jpg' ? right[0] > 250 && right[1] > 250 && right[2] > 250 : right[3] === 0;
      const name = (await savedNames(page))[0];
      await clearAll();
      return { ok: fileKind(bytes) === kind && width === 400 && height === 200 && left[0] > 240 && backgroundOk && name.endsWith(`half.${kind}`), detail: `${fileKind(bytes)}, ${name}, gauche ${left}, droite ${right}` };
    });
  }

  for (const label of ['JPG', 'WebP']) {
    await test(`la qualité fait rétrécir le fichier en ${label}`, async () => {
      await setFormat(page, label);
      const source = await image(page, 'noise.png', { width: 300, height: 200, paint: 'noise' });
      const sizes = [];
      for (const quality of ['Haute', 'Moyenne', 'Légère']) {
        await setQuality(page, quality);
        await add(page, source);
        await convert(page);
        await page.locator('#download-all').click();
        await page.waitForFunction(() => window.saved.length === 1);
        sizes.push((await savedBytes(page, 0)).length);
        await clearAll();
      }
      await setQuality(page, 'Haute');
      return { ok: sizes[0] > sizes[1] && sizes[1] > sizes[2], detail: sizes.join(' > ') };
    });
  }

  await test('le réglage de qualité disparaît en PNG', async () => {
    await setFormat(page, 'PNG');
    const hidden = !(await page.locator('#quality').isVisible());
    await setFormat(page, 'JPG');
    const back = await page.locator('#quality').isVisible();
    return { ok: hidden && back, detail: `PNG masqué : ${hidden}, JPG visible : ${back}` };
  });

  const sizeCases = [
    ['largeur 600 donne 600×400', 'Largeur', 600, 600, 400],
    ['hauteur 200 donne 300×200', 'Hauteur', 200, 300, 200],
    ['50 % donne 600×400', '%', 50, 600, 400],
    ['largeur 5000 ne fait pas grandir', 'Largeur', 5000, 1200, 800],
  ];
  for (const [name, mode, value, width, height] of sizeCases) {
    await test(name, async () => {
      await setFormat(page, 'JPG');
      await setResize(page, mode, value);
      await add(page, await image(page, 'grand.png'));
      await convert(page);
      await page.locator('#download-all').click();
      await page.waitForFunction(() => window.saved.length === 1);
      const size = await readImage(page, await savedBytes(page, 0));
      await clearAll();
      await setResize(page, 'Origine');
      return { ok: size.width === width && size.height === height, detail: `${size.width}×${size.height}` };
    });
  }

  await test('une valeur vide, nulle, négative ou trop grande bloque Convertir et dit pourquoi', async () => {
    await add(page, await image(page, 'grand.png', { width: 40, height: 40 }));
    const blocked = [];
    for (const [mode, value] of [['Largeur', ''], ['Largeur', 0], ['Hauteur', -5], ['%', 101]]) {
      await setResize(page, mode, value);
      const disabled = await page.locator('#convert').isDisabled();
      const message = await page.locator('#resize-error').textContent();
      blocked.push(disabled && message.trim().length > 0);
    }
    await setResize(page, '%', 100);
    const allowed = !(await page.locator('#convert').isDisabled()) && !(await page.locator('#resize-error').isVisible());
    await setResize(page, 'Origine');
    await clearAll();
    return { ok: blocked.every(Boolean) && allowed, detail: `${blocked.join()}, 100 % accepté : ${allowed}` };
  });

  await test('des rayures réduites donnent un gris presque uni', async () => {
    await setFormat(page, 'PNG');
    await setResize(page, '%', 50);
    await add(page, await image(page, 'rayures.png', { width: 400, height: 400, paint: 'stripes' }));
    await convert(page);
    await page.locator('#download-all').click();
    await page.waitForFunction(() => window.saved.length === 1);
    const points = Array.from({ length: 20 }, (_, k) => [100, 50 + k]);
    const { pixels } = await readImage(page, await savedBytes(page, 0), points);
    const greys = pixels.map((pixel) => pixel[0]);
    await clearAll();
    await setResize(page, 'Origine');
    await setFormat(page, 'JPG');
    return { ok: greys.every((grey) => grey > 100 && grey < 156), detail: `de ${Math.min(...greys)} à ${Math.max(...greys)}` };
  });

  await test('un JPEG marqué tourné garde son sens', async () => {
    await add(page, await fixture('oriented.jpg'));
    await convert(page);
    await page.locator('#download-all').click();
    await page.waitForFunction(() => window.saved.length === 1);
    const size = await readImage(page, await savedBytes(page, 0));
    await clearAll();
    return { ok: size.width === 800 && size.height === 1200, detail: `${size.width}×${size.height}` };
  });

  await test('un PNG en Display P3 sort aux couleurs de macOS', async () => {
    await setFormat(page, 'PNG');
    await add(page, await fixture('p3.png'));
    await convert(page);
    await page.locator('#download-all').click();
    await page.waitForFunction(() => window.saved.length === 1);
    const { gap, mine, theirs } = await gapToReference(page, await savedBytes(page, 0), 'p3-ref.png');
    await clearAll();
    await setFormat(page, 'JPG');
    return { ok: gap < 6, detail: `écart ${gap}, rouge ${mine[0]} contre ${theirs[0]}` };
  });

  await test('sources JPG, WebP, BMP, GIF et AVIF vers chaque sortie', async () => {
    const sources = [await image(page, 'a.jpg', { width: 120, height: 80, type: 'image/jpeg', quality: 0.9 }), await image(page, 'b.webp', { width: 120, height: 80, type: 'image/webp', quality: 0.9 }), await fixture('flat.bmp', 'c.bmp'), await fixture('animated.gif', 'd.gif'), await fixture('flat.avif', 'e.avif')];
    const report = [];
    for (const [label, kind] of [['JPG', 'jpg'], ['PNG', 'png'], ['WebP', 'webp']]) {
      await setFormat(page, label);
      await add(page, sources);
      await convert(page);
      await page.locator('#download-all').click();
      await page.waitForFunction(() => window.saved.length === 5);
      const names = await savedNames(page);
      const kinds = [];
      for (let i = 0; i < 5; i++) kinds.push(fileKind(await savedBytes(page, i)));
      report.push(kinds.every((one) => one === kind) && names.every((name) => name.endsWith(`.${kind}`)));
      await clearAll();
    }
    await setFormat(page, 'JPG');
    return { ok: report.every(Boolean), detail: report.join() };
  });

  await test('un GIF animé donne sa première image', async () => {
    await add(page, await fixture('animated.gif'));
    await convert(page);
    await page.locator('#download-all').click();
    await page.waitForFunction(() => window.saved.length === 1);
    const { pixels } = await readImage(page, await savedBytes(page, 0), [[60, 40]]);
    await clearAll();
    return { ok: pixels[0][0] > 200 && pixels[0][2] < 60, detail: String(pixels[0]) };
  });

  await test('la page annonce l’image animée et les informations non conservées', async () => {
    // la note du pied de colonne tient en deux lignes ; le détail (image animée, date, lieu) est dans la zone de dépôt.
    const text = await page.locator('body').textContent();
    return { ok: /animée/.test(text) && /date/.test(text) && /lieu/.test(text) && /reste sur ton ordinateur/.test(text), detail: text.replace(/\s+/g, ' ').slice(-170) };
  });
  await page.close();
}

async function groupHeic(context) {
  console.log('\n— Photos HEIC');
  const page = await openConverter(context);
  await spyDownloads(page);
  const heicOut = async (file) => {
    await add(page, file);
    await convert(page);
    await page.locator('#download-all').click();
    await page.waitForFunction(() => window.saved.length === 1);
    return savedBytes(page, 0);
  };
  const clearAll = async () => {
    await page.locator('#clear').click();
    await page.evaluate(() => (window.saved = []));
  };

  await test('photo.heic devient photo.jpg, de type JPG', async () => {
    const bytes = await heicOut(await fixture('bands-srgb.heic', 'photo.heic'));
    const names = await savedNames(page);
    await clearAll();
    return { ok: fileKind(bytes) === 'jpg' && names[0].endsWith('/photo.jpg'), detail: `${fileKind(bytes)}, ${names[0]}` };
  });
  await test('HEIC en Display P3 aux couleurs de macOS', async () => {
    await setFormat(page, 'PNG');
    const bytes = await heicOut(await fixture('bands-p3.heic'));
    // Couleurs pures, au bord de ce qu'un écran peut montrer : le plus grand écart mesuré est de 8, sur le bleu d'un jaune pur (5 contre 13 pour macOS, 0 à l'origine).
    const { gap, mine, theirs } = await gapToReference(page, bytes, 'bands-p3-ref.png');
    await clearAll();
    return { ok: gap < 10, detail: `écart ${gap} ; ${mine.map((pixel, i) => `${pixel.slice(0, 3)}/${theirs[i].slice(0, 3)}`).join(' ')}` };
  });
  await test('une vraie image Apple en Display P3 : aux couleurs de macOS', async () => {
    const folder = '/System/Library/Desktop Pictures';
    const name = (await fs.readdir(folder)).filter((file) => file.endsWith('.heic')).sort()[0];
    const source = path.join(folder, name);
    const reference = path.join(WORK, 'apple-ref.png');
    await run('sips', ['-s', 'format', 'png', '-m', '/System/Library/ColorSync/Profiles/sRGB Profile.icc', source, '--out', reference]);
    await add(page, await fixture(path.relative(FIXTURES, source), 'apple.heic'));
    await convert(page);
    await page.locator('#download-all').click();
    await page.waitForFunction(() => window.saved.length === 1);
    // La référence, trop lourde pour le canal de pilotage du navigateur, lui est servie. Les deux images sont réduites de la même façon.
    const server = await serve(WORK);
    const url = `http://127.0.0.1:${server.address().port}/apple-ref.png`;
    const gap = await page.evaluate(async (url) => {
      const read = async (blob) => {
        const bitmap = await createImageBitmap(blob, { resizeWidth: 400, resizeHeight: 400, resizeQuality: 'high' });
        const ctx = new OffscreenCanvas(400, 400).getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        return ctx.getImageData(0, 0, 400, 400).data;
      };
      const x = await read(await (await fetch(window.saved[0].url)).blob());
      const y = await read(await (await fetch(url)).blob());
      let sum = 0;
      let max = 0;
      for (let i = 0; i < x.length; i += 4) {
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(x[i + c] - y[i + c]);
          sum += d;
          if (d > max) max = d;
        }
      }
      return { mean: sum / (400 * 400 * 3), max };
    }, url);
    server.close();
    await clearAll();
    return { ok: gap.mean < 2 && gap.max < 10, detail: `${name}, écart moyen ${gap.mean.toFixed(2)}, maximum ${gap.max}` };
  });
  await test('HEIC en sRGB fidèle', async () => {
    const bytes = await heicOut(await fixture('bands-srgb.heic'));
    const { gap } = await gapToReference(page, bytes, 'bands-srgb-ref.png');
    await clearAll();
    await setFormat(page, 'JPG');
    return { ok: gap < 3, detail: `écart ${gap}` };
  });
  await test('HEIC tourné : 800×1200', async () => {
    const size = await readImage(page, await heicOut(await fixture('rot6.heic')));
    await clearAll();
    return { ok: size.width === 800 && size.height === 1200, detail: `${size.width}×${size.height}` };
  });

  // Une copie de l'échantillon sRGB dont on réécrit la description de couleur.
  const withNclx = async (primaries, transfer) => {
    const buffer = Buffer.from(await fs.readFile(path.join(FIXTURES, 'bands-srgb.heic')));
    const at = buffer.indexOf('colrnclx');
    buffer.writeUInt16BE(primaries, at + 8);
    buffer.writeUInt16BE(transfer, at + 10);
    return buffer;
  };
  const spaceOf = (buffer) =>
    page.evaluate(async (base64) => {
      const { colorSpaceOf } = await import(chrome.runtime.getURL('convert/heic.js'));
      return colorSpaceOf(new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))]));
    }, buffer.toString('base64'));
  await test('profil de couleur lu sous ses deux formes', async () => {
    const icc = await spaceOf(await fs.readFile(path.join(FIXTURES, 'bands-p3.heic')));
    const nclxP3 = await spaceOf(await withNclx(12, 13));
    const nclxSrgb = await spaceOf(await withNclx(1, 13));
    const unspecified = await spaceOf(await fs.readFile(path.join(FIXTURES, 'bands-srgb.heic')));
    const bt2020 = await spaceOf(await withNclx(9, 13));
    const hdr = await spaceOf(await withNclx(12, 16));
    const ok = icc === 'display-p3' && nclxP3 === 'display-p3' && nclxSrgb === 'srgb' && unspecified === 'srgb' && bt2020 === 'autre' && hdr === 'autre';
    return { ok, detail: `ICC ${icc}, nclx P3 ${nclxP3}, nclx sRGB ${nclxSrgb}, non précisé ${unspecified}, BT.2020 ${bt2020}, HDR ${hdr}` };
  });
  await test('profil inconnu : mention « Couleurs à vérifier »', async () => {
    await add(page, { name: 'inconnu.heic', mimeType: 'image/heic', buffer: await withNclx(9, 13) });
    await convert(page);
    const [row] = await rows(page);
    await clearAll();
    return { ok: row.status === 'done' && /Couleurs à vérifier/.test(row.detail), detail: `${row.status}, ${row.detail}` };
  });
  await test('faux HEIC et HEIC tronqué : erreur claire', async () => {
    const real = await fs.readFile(path.join(FIXTURES, 'bands-p3.heic'));
    await add(page, [textFile('faux.heic'), { name: 'tronque.heic', mimeType: 'image/heic', buffer: real.subarray(0, Math.floor(real.length * 0.6)) }]);
    await convert(page);
    const list = await rows(page);
    await clearAll();
    const fake = list.find((row) => row.name === 'faux.heic');
    const cut = list.find((row) => row.name === 'tronque.heic');
    return { ok: fake.status === 'error' && /illisible/.test(fake.detail) && cut.status === 'error' && /illisible/.test(cut.detail), detail: `${fake.detail} ; ${cut.detail}` };
  });
  await test('un HEIC suivi d’octets en plus se convertit', async () => {
    const real = await fs.readFile(path.join(FIXTURES, 'bands-p3.heic'));
    await add(page, { name: 'suite.heic', mimeType: 'image/heic', buffer: Buffer.concat([real, Buffer.from('des octets en plus, sans rapport')]) });
    await convert(page);
    const [row] = await rows(page);
    await clearAll();
    return { ok: row.status === 'done', detail: `${row.status}, ${row.detail}` };
  });
  await test('JPG et PNG tronqués : le résultat le dit ou la sortie reste entière', async () => {
    const jpg = await image(page, 'a.jpg', { width: 300, height: 200, paint: 'noise', type: 'image/jpeg', quality: 0.9 });
    const png = await image(page, 'b.png', { width: 300, height: 200, paint: 'noise' });
    const cut = (file, name) => ({ ...file, name, buffer: file.buffer.subarray(0, Math.floor(file.buffer.length * 0.6)) });
    await add(page, [cut(jpg, 'coupe.jpg'), cut(png, 'coupe.png')]);
    await convert(page);
    const list = await rows(page);
    await clearAll();
    return { ok: list.every((row) => row.status === 'error'), detail: list.map((row) => `${row.name} : ${row.status}, ${row.detail}`).join(' ; ') };
  });
  await page.close();

  await test('un PNG ne charge pas la bibliothèque, un HEIC si', async () => {
    const seen = [];
    const listen = (request) => seen.push(request.url());
    context.on('request', listen);
    const fresh = await openConverter(context);
    await add(fresh, await image(fresh, 'simple.png', { width: 40, height: 40 }));
    await convert(fresh);
    const afterPng = seen.some((url) => url.includes('heic-to-csp'));
    await add(fresh, await fixture('bands-srgb.heic'));
    await convert(fresh);
    const afterHeic = seen.some((url) => url.includes('heic-to-csp'));
    context.off('request', listen);
    await fresh.close();
    return { ok: !afterPng && afterHeic, detail: `après PNG : ${afterPng}, après HEIC : ${afterHeic}` };
  });
  await test('la page reste fluide sur 48 mégapixels', async () => {
    const fresh = await openConverter(context);
    await add(fresh, await fixture('p48.heic'));
    const freeze = await longestFreeze(fresh, () => convert(fresh));
    const [row] = await rows(fresh);
    await fresh.close();
    return { ok: freeze < 1000 && row.status === 'done', detail: `plus long blocage ${freeze} ms, ${row.status}, ${row.detail}` };
  });
  await test('un PNG de 10 000 × 10 000 se convertit', async () => {
    const fresh = await openConverter(context);
    await add(fresh, await image(fresh, 'immense.png', { width: 10000, height: 10000 }));
    await convert(fresh);
    const [row] = await rows(fresh);
    await fresh.close();
    return { ok: row.status === 'done' && /10000 × 10000/.test(row.detail), detail: `${row.status}, ${row.detail}` };
  });
}

async function groupPdf(context) {
  console.log('\n— Le PDF');
  const page = await openConverter(context);
  await spyDownloads(page);
  const clearAll = async () => {
    await page.locator('#clear').click();
    await page.evaluate(() => (window.saved = []));
  };
  const buildAndSave = async () => {
    await convert(page);
    const before = await page.evaluate(() => window.saved.length);
    await page.locator('#download-all').click();
    await page.waitForFunction((n) => window.saved.length === n + 1, before);
    return before;
  };
  await setFormat(page, 'PDF');
  const three = [await image(page, 'p1.png', { width: 1200, height: 800, color: '#ff0000' }), await image(page, 'p2.png', { width: 600, height: 900, color: '#00ff00' }), await image(page, 'p3.png', { width: 300, height: 300, color: '#0000ff' })];

  await test('pdfinfo lit 3 pages aux bonnes tailles', async () => {
    await add(page, three);
    const index = await buildAndSave();
    const { file, bytes } = await savePdf(page, index, 'trois');
    const { count, sizes } = await pdfPages(file);
    const name = (await savedNames(page))[index];
    const ok = fileKind(bytes) === 'pdf' && count === 3 && JSON.stringify(sizes) === '[[900,600],[450,675],[225,225]]' && /Captures\/Conversions\/images_.*\.pdf$/.test(name);
    return { ok, detail: `${count} pages, ${JSON.stringify(sizes)}, ${name}` };
  });
  const colorsOf = async (file, label, count) => {
    const colors = [];
    for (let number = 1; number <= count; number++) {
      const { pixels } = await readImage(page, await renderPage(file, number, label), [[20, 20]]);
      colors.push(pixels[0].slice(0, 3).join());
    }
    return colors;
  };
  await test('pdftoppm montre les bonnes couleurs dans le bon ordre', async () => {
    const colors = await colorsOf(path.join(WORK, 'trois.pdf'), 'trois', 3);
    return { ok: colors.join(' ') === '255,0,0 0,255,0 0,0,255', detail: colors.join(' ') };
  });
  await test('la table des positions pointe sur chaque objet', async () => {
    const bytes = await fs.readFile(path.join(WORK, 'trois.pdf'));
    const start = Number(bytes.toString('latin1').match(/startxref\n(\d+)\n%%EOF/)[1]);
    const lines = bytes.subarray(start).toString('latin1').split('\n');
    const count = Number(lines[1].split(' ')[1]);
    const entries = lines.slice(2, 2 + count);
    const widths = entries.every((line) => line.length === 19);
    let right = 0;
    entries.slice(1).forEach((line, index) => {
      if (bytes.subarray(Number(line.slice(0, 10))).subarray(0, 12).toString('latin1').startsWith(`${index + 1} 0 obj`)) right++;
    });
    return { ok: lines[0] === 'xref' && widths && right === count - 1, detail: `${right} objets sur ${count - 1}, lignes de 20 octets : ${widths}` };
  });
  await test('la flèche ↑ change l’ordre des pages', async () => {
    await page.locator('.item').nth(2).locator('.item-up').click();
    await page.waitForFunction(() => !document.getElementById('download-all').disabled);
    const before = await page.evaluate(() => window.saved.length);
    await page.locator('#download-all').click();
    await page.waitForFunction((n) => window.saved.length === n + 1, before);
    const { file } = await savePdf(page, before, 'ordre');
    const colors = await colorsOf(file, 'ordre', 3);
    return { ok: colors.join(' ') === '255,0,0 0,0,255 0,255,0', detail: colors.join(' ') };
  });
  await test('les flèches n’existent qu’en PDF', async () => {
    const inPdf = await page.locator('.item-up').first().isVisible();
    await setFormat(page, 'JPG');
    const inJpg = await page.locator('.item-up').first().isVisible();
    await setFormat(page, 'PDF');
    await clearAll();
    return { ok: inPdf && !inJpg, detail: `PDF ${inPdf}, JPG ${inJpg}` };
  });
  await test('un PNG en Haute est identique pixel à pixel', async () => {
    const source = await image(page, 'bruit.png', { width: 300, height: 200, paint: 'noise' });
    await add(page, source);
    const index = await buildAndSave();
    const { file, bytes } = await savePdf(page, index, 'bruit');
    // Les pixels stockés dans le PDF, lus sans passer par un logiciel de rendu.
    const header = /\/FlateDecode \/Length (\d+) >>\nstream\n/.exec(bytes.toString('latin1'));
    const start = header.index + header[0].length;
    const stored = zlib.inflateSync(bytes.subarray(start, start + Number(header[1])));
    const rendered = await renderPage(file, 1, 'bruit');
    const report = await page.evaluate(
      async ({ sourceBase64, storedBase64, renderedBase64 }) => {
        const decode = (base64) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const read = async (base64) => {
          const bitmap = await createImageBitmap(new Blob([decode(base64)]));
          const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
          ctx.drawImage(bitmap, 0, 0);
          return { w: bitmap.width, h: bitmap.height, data: ctx.getImageData(0, 0, bitmap.width, bitmap.height).data };
        };
        const original = await read(sourceBase64);
        const inFile = decode(storedBase64);
        let storedGaps = inFile.length === (original.data.length / 4) * 3 ? 0 : -1;
        if (storedGaps === 0) {
          for (let i = 0, j = 0; i < original.data.length; i += 4, j += 3) {
            for (let c = 0; c < 3; c++) if (original.data[i + c] !== inFile[j + c]) storedGaps++;
          }
        }
        const shown = await read(renderedBase64);
        let renderGaps = 0;
        let renderMax = 0;
        if (shown.w === original.w && shown.h === original.h) {
          for (let i = 0; i < original.data.length; i++) {
            const d = Math.abs(original.data[i] - shown.data[i]);
            if (d) renderGaps++;
            if (d > renderMax) renderMax = d;
          }
        } else renderGaps = -1;
        return { storedGaps, renderGaps, renderMax, size: `${shown.w}×${shown.h}` };
      },
      { sourceBase64: source.buffer.toString('base64'), storedBase64: stored.toString('base64'), renderedBase64: rendered.toString('base64') },
    );
    await clearAll();
    return { ok: report.storedGaps === 0, detail: JSON.stringify(report) };
  });
  await test('une image transparente a un fond blanc', async () => {
    await add(page, await image(page, 'half.png', { width: 400, height: 200, paint: 'half', color: '#ff0000' }));
    const index = await buildAndSave();
    const { file } = await savePdf(page, index, 'transparent');
    const { pixels } = await readImage(page, await renderPage(file, 1, 'transparent'), [[100, 100], [300, 100]]);
    await clearAll();
    return { ok: pixels[0][0] === 255 && pixels[0][1] === 0 && pixels[1].slice(0, 3).join() === '255,255,255', detail: `${pixels[0]} ; ${pixels[1]}` };
  });
  await test('une très grande image reste sous 14 400 pt', async () => {
    await add(page, await image(page, 'long.png', { width: 100, height: 20000 }));
    const index = await buildAndSave();
    const { file } = await savePdf(page, index, 'long');
    const { sizes } = await pdfPages(file);
    await clearAll();
    return { ok: sizes[0][1] <= 14400 && sizes[0][1] > 14000, detail: JSON.stringify(sizes) };
  });
  await test('le fichier ne contient ni auteur ni lieu', async () => {
    const bytes = (await fs.readFile(path.join(WORK, 'trois.pdf'))).toString('latin1');
    const { text } = await pdfPages(path.join(WORK, 'trois.pdf'));
    const ok = !/\/(Author|Creator|Producer|Info|Title|Metadata)\b/.test(bytes) && !/^(Author|Creator|Producer|Title):/m.test(text);
    return { ok, detail: ok ? 'aucune information' : text.slice(0, 120) };
  });
  const kinds = (bytes) => {
    const text = bytes.toString('latin1');
    return { flate: (text.match(/\/FlateDecode/g) ?? []).length, jpeg: (text.match(/\/DCTDecode/g) ?? []).length };
  };
  await test('PNG, BMP et GIF en Haute : sans perte', async () => {
    await add(page, [await image(page, 'a.png', { width: 40, height: 40 }), await fixture('flat.bmp', 'b.bmp'), await fixture('animated.gif', 'c.gif')]);
    const index = await buildAndSave();
    const found = kinds(await savedBytes(page, index));
    await clearAll();
    return { ok: found.flate === 3 && found.jpeg === 0, detail: JSON.stringify(found) };
  });
  await test('PNG en Moyenne et JPG en Haute : JPEG', async () => {
    await setQuality(page, 'Moyenne');
    await add(page, await image(page, 'a.png', { width: 40, height: 40 }));
    const png = kinds(await savedBytes(page, await buildAndSave()));
    await clearAll();
    await setQuality(page, 'Haute');
    await add(page, await image(page, 'b.jpg', { width: 40, height: 40, type: 'image/jpeg', quality: 0.9 }));
    const jpg = kinds(await savedBytes(page, await buildAndSave()));
    await clearAll();
    return { ok: png.jpeg === 1 && png.flate === 0 && jpg.jpeg === 1 && jpg.flate === 0, detail: `PNG Moyenne ${JSON.stringify(png)}, JPG Haute ${JSON.stringify(jpg)}` };
  });
  await test('la qualité fait rétrécir le PDF', async () => {
    const source = await image(page, 'a.jpg', { width: 300, height: 200, paint: 'noise', type: 'image/jpeg', quality: 1 });
    const sizes = [];
    for (const quality of ['Haute', 'Moyenne', 'Légère']) {
      await setQuality(page, quality);
      await add(page, source);
      sizes.push((await savedBytes(page, await buildAndSave())).length);
      await clearAll();
    }
    await setQuality(page, 'Haute');
    return { ok: sizes[0] > sizes[1] && sizes[1] > sizes[2], detail: sizes.join(' > ') };
  });
  await test('la page reste fluide pendant un PDF sans perte d’une grande image', async () => {
    await add(page, await image(page, 'grand.png', { width: 8000, height: 6000 }));
    const freeze = await longestFreeze(page, () => convert(page));
    const list = await rows(page);
    await clearAll();
    return { ok: freeze < 1000 && list[0].status === 'done', detail: `plus long blocage ${freeze} ms` };
  });
  await page.close();
}

async function groupBatch(context, sw) {
  console.log('\n— Lots, erreurs et téléchargements');
  const small = (page, name, color = '#336699') => image(page, name, { width: 60, height: 40, color });

  await test('Tout télécharger range dans Captures/Conversions, sans erreur de Chrome', async () => {
    const page = await openConverter(context);
    await spyDownloads(page, { pass: true });
    await add(page, [await small(page, 'un.png'), await small(page, 'deux.png')]);
    await convert(page);
    await page.locator('#download-all').click();
    await page.waitForFunction(() => window.saved.length === 2);
    const names = await savedNames(page);
    await page.waitForSelector('#toast:not([hidden])');
    const toastText = await page.locator('#toast').textContent();
    await page.close();
    return { ok: names.sort().join() === 'Captures/Conversions/deux.jpg,Captures/Conversions/un.jpg' && /2 images/.test(toastText), detail: `${names.join()} ; ${toastText}` };
  });
  // Le navigateur de test range les fichiers sous un nom à lui : on vérifie la consigne donnée à Chrome et l'arrivée des deux fichiers.
  // Les noms numérotés sur le disque (photo.jpg, photo (1).jpg) ont été relevés une fois à la relecture du 2026-11-03.
  await test('deux images de même base reçoivent un numéro', async () => {
    const page = await openConverter(context);
    await spyDownloads(page, { pass: true });
    await add(page, [await small(page, 'meme.png'), await image(page, 'meme.webp', { width: 60, height: 40, type: 'image/webp' })]);
    await convert(page);
    await page.locator('#download-all').click();
    await page.waitForSelector('#toast:not([hidden])');
    const rule = await page.evaluate(() => window.saved.map((entry) => entry.conflictAction));
    const found = await sw.evaluate(async () => (await chrome.downloads.search({ orderBy: ['-startTime'], limit: 2 })).map((item) => item.state));
    await page.close();
    return { ok: rule.join() === 'uniquify,uniquify' && found.join() === 'complete,complete', detail: `${rule.join()}, ${found.join()}` };
  });
  await test('le nom de capture macOS garde ses mots, et Chrome l’accepte', async () => {
    const page = await openConverter(context);
    await spyDownloads(page, { pass: true });
    await dropFiles(page, [await small(page, 'Capture d’écran 2026-11-03 à 15.22.01 PM.png')]);
    await convert(page);
    await page.locator('#download-all').click();
    await page.waitForFunction(() => window.saved.length === 1);
    await page.waitForSelector('#toast:not([hidden])');
    const toastText = await page.locator('#toast').textContent();
    const [name] = await savedNames(page);
    await page.close();
    return { ok: name === 'Captures/Conversions/Capture d’écran 2026-11-03 à 15.22.01 PM.jpg' && !/impossible/.test(toastText), detail: `${name} ; ${toastText}` };
  });
  await test('les caractères interdits sont remplacés', async () => {
    const page = await openConverter(context);
    await spyDownloads(page, { pass: true });
    await dropFiles(page, [await small(page, 'a:b*c?d"e<f>g|h~.png'), await small(page, '...cache.png'), await small(page, '.png')]);
    await convert(page);
    await page.locator('#download-all').click();
    await page.waitForFunction(() => window.saved.length === 3);
    const names = await savedNames(page);
    await page.waitForSelector('#toast:not([hidden])');
    const toastText = await page.locator('#toast').textContent();
    await page.close();
    const ok = names.every((name) => !/[:*?"<>|~]/.test(name.split('/').pop()) && !name.split('/').pop().startsWith('.')) && names.some((name) => name.endsWith('/a-b-c-d-e-f-g-h-.jpg')) && names.some((name) => name.endsWith('/image.jpg')) && !/impossible/.test(toastText);
    return { ok, detail: `${names.join(' ; ')} ; ${toastText}` };
  });

  await test('un lot avec fichiers illisibles continue et le résume', async () => {
    const page = await openConverter(context);
    await add(page, [await small(page, 'a.png'), textFile('notes.txt'), textFile('faux.heic'), await small(page, 'b.png')]);
    await convert(page);
    const list = await rows(page);
    const summary = await page.locator('#summary').textContent();
    const label = await page.locator('#download-all').textContent();
    await page.close();
    const status = Object.fromEntries(list.map((row) => [row.name, row.status]));
    const ok = status['a.png'] === 'done' && status['b.png'] === 'done' && status['notes.txt'] === 'error' && status['faux.heic'] === 'error' && /2 images prêtes/.test(summary) && /2 erreurs/.test(summary) && /2 images/.test(label);
    return { ok, detail: `${JSON.stringify(status)} ; ${summary} ; ${label}` };
  });
  await test('le PDF sort sans les pages en erreur et le dit', async () => {
    const page = await openConverter(context);
    await spyDownloads(page);
    await setFormat(page, 'PDF');
    await add(page, [await small(page, 'a.png'), textFile('notes.txt'), await small(page, 'b.png')]);
    await convert(page);
    const summary = await page.locator('#summary').textContent();
    await page.locator('#download-all').click();
    await page.waitForFunction(() => window.saved.length === 1);
    const { file } = await savePdf(page, 0, 'manque');
    const { count } = await pdfPages(file);
    await page.close();
    return { ok: count === 2 && /2 pages/.test(summary) && /1 image n’a pas pu/.test(summary), detail: `${count} pages ; ${summary}` };
  });
  await test('un PDF sans aucune page réussie n’est pas proposé', async () => {
    const page = await openConverter(context);
    await setFormat(page, 'PDF');
    await add(page, textFile('notes.txt'));
    await convert(page);
    const disabled = await page.locator('#download-all').isDisabled();
    await page.close();
    return { ok: disabled, detail: `téléchargement désactivé : ${disabled}` };
  });
  await test('un WebP trop grand propose de réduire', async () => {
    const page = await openConverter(context);
    await setFormat(page, 'WebP');
    await add(page, await image(page, 'large.png', { width: 17000, height: 100 }));
    await convert(page);
    const [row] = await rows(page);
    await setFormat(page, 'JPG');
    await page.close();
    return { ok: row.status === 'error' && /16 383/.test(row.detail) && /réduis la taille/.test(row.detail), detail: row.detail };
  });
  await test('Annuler laisse la suite en attente', async () => {
    const page = await openConverter(context);
    const photo = await fixture('p48.heic');
    await add(page, [{ ...photo, name: 'p1.heic' }, { ...photo, name: 'p2.heic' }, { ...photo, name: 'p3.heic' }]);
    // La conversion part d'elle-même au dépôt.
    await page.waitForSelector('.item[data-status="working"]');
    const cancelVisible = await page.locator('#cancel').isVisible();
    await pause(600); // Au-delà du délai qui protège d'un double clic sur « Convertir ».
    await page.locator('#cancel').click();
    await page.waitForFunction(() => document.body.dataset.state === 'idle');
    const statuses = (await rows(page)).map((row) => row.status);
    const enabled = !(await page.locator('#convert').isDisabled());
    const label = await page.locator('#convert').textContent();
    await page.close();
    return { ok: cancelVisible && statuses.every((status) => status === 'waiting') && enabled && /Convertir \(3\)/.test(label), detail: `${statuses.join()}, ${label}` };
  });
  await test('changer un réglage efface les résultats', async () => {
    const page = await openConverter(context);
    await add(page, [await small(page, 'a.png'), textFile('notes.txt')]);
    await convert(page);
    const ready = !(await page.locator('#download-all').isDisabled());
    await setQuality(page, 'Moyenne');
    const statuses = (await rows(page)).map((row) => row.status);
    const off = await page.locator('#download-all').isDisabled();
    const on = !(await page.locator('#convert').isDisabled());
    await setQuality(page, 'Haute');
    await page.close();
    return { ok: ready && statuses.every((status) => status === 'waiting') && off && on, detail: `${statuses.join()}, téléchargement désactivé ${off}, Convertir actif ${on}` };
  });
  const countPosts = (page) =>
    page.evaluate(() => {
      window.posted = 0;
      const real = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (...args) {
        window.posted++;
        return real.apply(this, args);
      };
    });
  await test('ajouter une image laisse les résultats des autres et n’en convertit qu’une', async () => {
    const page = await openConverter(context);
    await add(page, [await small(page, 'a.png'), await small(page, 'b.png')]);
    await convert(page);
    await countPosts(page);
    await add(page, await small(page, 'c.png'));
    // la nouvelle image part aussitôt ; « Convertir » n'est pas proposé pendant ce temps.
    const before = await rows(page);
    const label = (await page.locator('#convert').isVisible()) ? await page.locator('#convert').textContent() : '(caché)';
    const off = await page.locator('#download-all').isDisabled();
    await convert(page);
    const after = await rows(page);
    const posted = await page.evaluate(() => window.posted);
    const download = await page.locator('#download-all').textContent();
    await page.close();
    return { ok: before[0].status === 'done' && ['working', 'done'].includes(before[2].status) && label === '(caché)' && posted === 1 && after.every((row) => row.status === 'done') && /3 images/.test(download), detail: `${label}, envois ${posted}, ${download}` };
  });
  await test('retirer une image refait le PDF sans reconvertir', async () => {
    const page = await openConverter(context);
    await spyDownloads(page);
    await setFormat(page, 'PDF');
    await add(page, [await small(page, 'a.png'), await small(page, 'b.png'), await small(page, 'c.png')]);
    await convert(page);
    await countPosts(page);
    await page.locator('.item').nth(1).locator('.item-remove').click();
    await page.waitForFunction(() => !document.getElementById('download-all').disabled);
    await page.locator('#download-all').click();
    await page.waitForFunction(() => window.saved.length === 1);
    const { file } = await savePdf(page, 0, 'retrait');
    const { count } = await pdfPages(file);
    const posted = await page.evaluate(() => window.posted);
    await page.close();
    return { ok: count === 2 && posted === 0, detail: `${count} pages, envois ${posted}` };
  });
  await test('les réglages et la liste sont verrouillés pendant une conversion', async () => {
    const page = await openConverter(context);
    await add(page, await fixture('p48.heic'));
    await page.waitForSelector('.item[data-status="working"]');
    const format = await page.locator('#format button').first().isDisabled();
    const quality = await page.locator('#quality button').first().isDisabled();
    const resize = await page.locator('#resize button').first().isDisabled();
    const remove = await page.locator('.item-remove').first().isDisabled();
    const clear = await page.locator('#clear').isDisabled();
    await dropFiles(page, [textFile('pendant.txt')]);
    const count = (await rows(page)).length;
    const toastText = await page.locator('#toast').textContent();
    await pause(600);
    await page.locator('#cancel').click();
    await page.close();
    return { ok: format && quality && resize && remove && clear && count === 1 && /en cours/.test(toastText), detail: `${format},${quality},${resize},${remove},${clear}, ${count} ligne, ${toastText}` };
  });
  await test('les réglages sont retenus sans toucher au format des captures', async () => {
    await sw.evaluate(() => chrome.storage.sync.set({ format: 'png' }));
    const page = await openConverter(context);
    await setFormat(page, 'WebP');
    await setQuality(page, 'Légère');
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.state === 'idle');
    const pressed = await page.evaluate(() => [...document.querySelectorAll('#format [aria-pressed="true"], #quality [aria-pressed="true"]')].map((button) => button.textContent));
    const stored = await sw.evaluate(() => chrome.storage.sync.get(null));
    await setFormat(page, 'JPG');
    await setQuality(page, 'Haute');
    await page.close();
    return { ok: pressed.join() === 'WebP,Légère' && stored.format === 'png' && stored.convertFormat === 'webp' && stored.convertQuality === 'light', detail: `${pressed.join()}, ${JSON.stringify(stored)}` };
  });
  await test('aucune requête réseau pendant une conversion HEIC et PDF', async () => {
    const seen = [];
    const listen = (request) => seen.push(request.url());
    context.on('request', listen);
    const page = await openConverter(context);
    await spyDownloads(page);
    await add(page, await fixture('bands-p3.heic'));
    await convert(page);
    await setFormat(page, 'PDF');
    await add(page, await small(page, 'a.png'));
    await convert(page);
    await page.locator('#download-all').click();
    await page.waitForFunction(() => window.saved.length === 1);
    context.off('request', listen);
    await setFormat(page, 'JPG');
    await page.close();
    const outside = seen.filter((url) => !/^(chrome-extension|blob|data):/.test(url));
    return { ok: outside.length === 0 && seen.length > 0, detail: `${seen.length} demandes, dehors : ${outside.join() || 'aucune'}` };
  });
  await test('aucun script distant dans les pages', async () => {
    const found = [];
    for (const file of ['convert/convert.html', 'convert/convert.js', 'convert/convert-worker.js', 'convert/heic.js', 'convert/pdf.js']) {
      const text = await fs.readFile(path.join(EXTENSION, file), 'utf8');
      if (/https?:\/\/(?!www\.w3\.org)/.test(text)) found.push(file);
    }
    return { ok: found.length === 0, detail: found.join() || 'aucun' };
  });
  await test('le manifeste est inchangé', async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(EXTENSION, 'manifest.json'), 'utf8'));
    const ok = manifest.permissions.join() === 'activeTab,scripting,downloads,storage,contextMenus,offscreen,debugger' && !manifest.host_permissions && !manifest.content_security_policy && !manifest.web_accessible_resources;
    return { ok, detail: manifest.permissions.join() };
  });
  await test('les libellés des boutons suivent le lot', async () => {
    const page = await openConverter(context);
    // pas de bouton « Convertir » au départ, et la conversion part au dépôt sans lui.
    const empty = (await page.locator('#convert').isHidden()) ? 'caché' : await page.locator('#convert').textContent();
    await add(page, await small(page, 'a.png'));
    await convert(page);
    const one = (await rows(page))[0].status;
    const singular = await page.locator('#download-all').textContent();
    await add(page, await small(page, 'b.png'));
    await convert(page);
    const plural = await page.locator('#download-all').textContent();
    await setFormat(page, 'PDF');
    await convert(page);
    const pdf = await page.locator('#download-all').textContent();
    await setFormat(page, 'JPG');
    await page.close();
    return { ok: empty === 'caché' && one === 'done' && /l’image/.test(singular) && /Tout télécharger \(2 images\)/.test(plural) && /Télécharger le PDF/.test(pdf), detail: [empty, one, singular, plural, pdf].join(' ; ') };
  });
  await test('le message propose d’afficher dans le Finder', async () => {
    const page = await openConverter(context);
    await spyDownloads(page, { pass: true });
    await add(page, await small(page, 'a.png'));
    await convert(page);
    await page.locator('.item-save').click();
    await page.waitForSelector('#toast:not([hidden])');
    const text = await page.locator('#toast').textContent();
    const action = await page.locator('.toast-action').textContent();
    await page.close();
    return { ok: /Conversions/.test(text) && /Finder/.test(action), detail: text };
  });
  await test('un téléchargement refusé est signalé en français', async () => {
    const page = await openConverter(context);
    await add(page, await small(page, 'a.png'));
    await convert(page);
    await page.evaluate(() => (chrome.downloads.download = () => Promise.reject(new Error('Invalid filename'))));
    await page.locator('#download-all').click();
    await page.waitForSelector('#toast:not([hidden])');
    const text = await page.locator('#toast').textContent();
    const again = !(await page.locator('#download-all').isDisabled());
    const [row] = await rows(page);
    await page.close();
    return { ok: /a\.jpg/.test(text) && /n’a pas pu être enregistrée/.test(text) && !/Invalid/.test(text) && again && /Non enregistrée/.test(row.detail), detail: `${text} ; ${row.detail}` };
  });
  // Chrome répond avec un numéro, puis annonce la fin (ou la panne) du téléchargement : `report` rend la main au test à ce moment-là.
  const fakeDownloads = (page) =>
    page.evaluate(() => {
      window.listeners = [];
      window.started = [];
      const real = chrome.downloads.onChanged.addListener.bind(chrome.downloads.onChanged);
      chrome.downloads.onChanged.addListener = (listener) => {
        window.listeners.push(listener);
        real(listener);
      };
      chrome.downloads.download = async ({ filename }) => {
        window.started.push(filename);
        return 4000 + window.started.length;
      };
      chrome.downloads.search = async ({ id }) => [{ id, state: 'in_progress' }];
    });
  const report = (page, id, state, error) => page.evaluate(({ id, state, error }) => window.listeners.slice().forEach((listener) => listener({ id, state: { current: state }, ...(error ? { error: { current: error } } : {}) })), { id, state, error });
  await test('un téléchargement interrompu est signalé en français', async () => {
    const page = await openConverter(context);
    await fakeDownloads(page);
    await add(page, await small(page, 'a.png'));
    await convert(page);
    await page.locator('#download-all').click();
    await page.waitForFunction(() => window.listeners.length > 0);
    await report(page, 4001, 'interrupted', 'FILE_NO_SPACE');
    await page.waitForSelector('#toast:not([hidden])');
    const text = await page.locator('#toast').textContent();
    await page.close();
    return { ok: /a\.jpg/.test(text) && /n’a pas pu être enregistrée/.test(text) && /disque plein/.test(text) && !/FILE_NO_SPACE/.test(text), detail: text };
  });
  await test('un échec pendant le lot n’est pas masqué par une réussite', async () => {
    const page = await openConverter(context);
    await fakeDownloads(page);
    await add(page, [await small(page, 'a.png'), await small(page, 'b.png'), await small(page, 'c.png')]);
    await convert(page);
    await page.locator('#download-all').click();
    await page.waitForFunction(() => window.started.length === 1 && window.listeners.length > 0);
    await report(page, 4001, 'interrupted', 'FILE_FAILED');
    await page.waitForFunction(() => window.started.length === 2);
    await report(page, 4002, 'complete');
    await page.waitForFunction(() => window.started.length === 3);
    await report(page, 4003, 'complete');
    await page.waitForSelector('#toast:not([hidden])');
    const text = await page.locator('#toast').textContent();
    const list = await rows(page);
    await page.close();
    const ok = /2 images enregistrées/.test(text) && /a\.jpg/.test(text) && !/^3 images/.test(text) && /Non enregistrée/.test(list[0].detail) && !/Non enregistrée/.test(list[1].detail);
    return { ok, detail: `${text} ; ${list[0].detail}` };
  });
  await test('la réussite ne s’annonce qu’une fois le fichier arrivé', async () => {
    const page = await openConverter(context);
    await fakeDownloads(page);
    await add(page, await small(page, 'a.png'));
    await convert(page);
    await page.locator('#download-all').click();
    await page.waitForFunction(() => window.listeners.length > 0);
    await pause(150);
    const early = await page.locator('#toast').isVisible();
    await report(page, 4001, 'complete');
    await page.waitForSelector('#toast:not([hidden])');
    const text = await page.locator('#toast').textContent();
    await page.close();
    return { ok: !early && /enregistrée/.test(text), detail: `message trop tôt : ${early} ; ${text}` };
  });
  await test('un fichier refusé n’arrête pas les suivants et le bilan le nomme', async () => {
    const page = await openConverter(context);
    await page.evaluate(() => {
      const real = chrome.downloads.download.bind(chrome.downloads);
      window.tried = [];
      chrome.downloads.download = (options) => {
        window.tried.push(options.filename);
        return options.filename.endsWith('/b.jpg') ? Promise.reject(new Error('Invalid filename')) : real(options);
      };
    });
    await add(page, [await small(page, 'a.png'), await small(page, 'b.png'), await small(page, 'c.png')]);
    await convert(page);
    await page.locator('#download-all').click();
    await page.waitForSelector('#toast:not([hidden])');
    const text = await page.locator('#toast').textContent();
    const tried = await page.evaluate(() => window.tried.length);
    const list = await rows(page);
    await page.close();
    return { ok: tried === 3 && /2 images enregistrées/.test(text) && /b\.jpg/.test(text) && /Non enregistrée/.test(list[1].detail) && !/Invalid/.test(text), detail: `${tried} essais ; ${text}` };
  });
  await test('les noms réservés passent et le lot va au bout', async () => {
    const page = await openConverter(context);
    await spyDownloads(page, { pass: true });
    const names = ['a.png', 'aux.png', 'clock$.png', 'con.2.png', 'nul.png', 'prn.v1.png', 'com1.png', 'LPT1.png', 'z.png'];
    const files = [];
    for (const name of names) files.push(await small(page, name));
    await dropFiles(page, files);
    await convert(page);
    await page.locator('#download-all').click();
    await page.waitForSelector('#toast:not([hidden])');
    const text = await page.locator('#toast').textContent();
    const saved = await savedNames(page);
    await page.close();
    return { ok: saved.length === 9 && /^9 images enregistrées/.test(text) && !saved.some((name) => /\/(aux|con|nul|prn|com1|lpt1|clock\$)(\.|$)/i.test(name)), detail: `${text} ; ${saved.map((name) => name.split('/').pop()).join(' ')}` };
  });
  await test('un émoji au 120e caractère ne casse pas le nom', async () => {
    const page = await openConverter(context);
    await spyDownloads(page, { pass: true });
    await dropFiles(page, [await small(page, `${'x'.repeat(119)}😀yyy.png`)]);
    await convert(page);
    await page.locator('#download-all').click();
    await page.waitForSelector('#toast:not([hidden])');
    const text = await page.locator('#toast').textContent();
    await page.close();
    return { ok: /^Image enregistrée/.test(text), detail: text.slice(0, 80) };
  });
  // le seul bouton de conversion qui reste est « Reconvertir », après un changement de réglage.
  await test('un double clic sur Reconvertir lance bien la conversion', async () => {
    const report = [];
    for (const delay of [0, 120, 250]) {
      const page = await openConverter(context);
      await add(page, await fixture('p12.heic'));
      await convert(page);
      await setQuality(page, 'Moyenne');
      const box = await page.locator('#convert').boundingBox();
      const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
      await page.mouse.click(x, y);
      await pause(delay);
      await page.mouse.click(x, y);
      await page.waitForFunction(() => document.body.dataset.state === 'idle', undefined, { timeout: 120_000 });
      const [row] = await rows(page);
      report.push(row.status);
      await setQuality(page, 'Haute');
      await page.close();
    }
    return { ok: report.every((status) => status === 'done'), detail: report.join() };
  });
  await test('Annuler reste possible juste après ce délai', async () => {
    const page = await openConverter(context);
    await add(page, await fixture('p48.heic'));
    await pause(700);
    await page.locator('#cancel').click();
    await page.waitForFunction(() => document.body.dataset.state === 'idle');
    const [row] = await rows(page);
    await page.close();
    return { ok: row.status === 'waiting', detail: row.status };
  });
  await test('un double clic sur la croix ne retire qu’une image', async () => {
    const page = await openConverter(context);
    await add(page, [await small(page, 'a.png'), await small(page, 'b.png'), await small(page, 'c.png')]);
    await page.locator('.item').first().locator('.item-remove').dblclick();
    const left = (await rows(page)).map((row) => row.name);
    await page.close();
    return { ok: left.join() === 'b.png,c.png', detail: left.join() };
  });
  await test('un double clic sur Télécharger n’enregistre qu’une copie', async () => {
    const page = await openConverter(context);
    await spyDownloads(page);
    await add(page, await small(page, 'a.png'));
    await convert(page);
    await page.locator('.item-save').dblclick();
    await page.waitForSelector('#toast:not([hidden])');
    const count = await page.evaluate(() => window.saved.length);
    await page.close();
    return { ok: count === 1, detail: `${count} copie` };
  });
  await test('recliquer l’option déjà choisie ne change rien', async () => {
    const page = await openConverter(context);
    await add(page, await small(page, 'a.png'));
    await setResize(page, 'Largeur', 777);
    await convert(page);
    await setFormat(page, 'JPG');
    await setQuality(page, 'Haute');
    await pick(page, 'resize', 'Largeur');
    const [row] = await rows(page);
    const value = await page.locator('#resize-value').inputValue();
    await page.close();
    return { ok: row.status === 'done' && value === '777', detail: `${row.status}, ${value}` };
  });
  await test('un fichier déplacé après son ajout : message français, la suite continue', async () => {
    const page = await openConverter(context);
    const gone = path.join(WORK, 'parti.png');
    await fs.writeFile(gone, (await small(page, 'parti.png')).buffer);
    // la conversion part au dépôt ; un réglage invalide la retient, le temps de déplacer le fichier.
    await setResize(page, 'Largeur', '');
    await page.setInputFiles('#files', gone);
    await add(page, await small(page, 'reste.png'));
    await fs.rm(gone);
    await setResize(page, 'Origine');
    await convert(page);
    const list = await rows(page);
    await page.close();
    const lost = list.find((row) => row.name === 'parti.png');
    const kept = list.find((row) => row.name === 'reste.png');
    return { ok: lost.status === 'error' && /Fichier illisible/.test(lost.detail) && /déplacé/.test(lost.detail) && !/requested|could not/.test(lost.detail) && kept.status === 'done', detail: lost.detail };
  });
  await test('les messages de taille disent la bonne règle', async () => {
    const page = await openConverter(context);
    await setResize(page, 'Largeur', 1.5);
    const decimal = await page.locator('#resize-error').textContent();
    await setResize(page, 'Largeur', 100001);
    const tooBig = await page.locator('#resize-error').textContent();
    await page.close();
    return { ok: /entre 1 et 100 000/.test(decimal) && /entre 1 et 100 000/.test(tooBig), detail: decimal };
  });
}

const previewBox = (page, index = 0) =>
  page.evaluate((index) => {
    const row = document.querySelectorAll('.item')[index];
    const shown = row.querySelector('.item-thumb img, .item-thumb canvas');
    if (!shown) return { kind: 'aucun', note: row.querySelector('.item-thumb-note')?.checkVisibility() ?? false };
    const { width, height } = shown.getBoundingClientRect();
    return { kind: shown.tagName.toLowerCase(), width: Math.round(width), height: Math.round(height), pixels: shown.naturalWidth ?? shown.width, loaded: shown.tagName !== 'IMG' || (shown.complete && shown.naturalWidth > 0) };
  }, index);

async function waitPreview(page, index = 0) {
  await page.waitForFunction((index) => {
    const shown = document.querySelectorAll('.item')[index].querySelector('.item-thumb img');
    return shown?.complete && shown.naturalWidth > 0;
  }, index);
}

async function groupPreview(context) {
  console.log('\n— Aperçus');
  const page = await openConverter(context);
  await page.setViewportSize(BIG_SCREEN);
  const clearAll = () => page.locator('#clear').click();
  // la conversion part au dépôt. Un réglage de taille invalide la retient : on regarde l'aperçu d'avant conversion.
  const hold = () => setResize(page, 'Largeur', '');
  const release = () => setResize(page, 'Origine');
  await hold();
  await test('un screen de téléphone a un grand aperçu dès son ajout', async () => {
    await add(page, await image(page, 'screen.png', { width: 1179, height: 2556 }));
    await waitPreview(page);
    const box = await previewBox(page);
    const status = (await rows(page))[0].status;
    await clearAll();
    return { ok: status === 'waiting' && box.height >= 220 && box.width >= 100 && Math.abs(box.width / box.height - 1179 / 2556) < 0.02, detail: JSON.stringify(box) };
  });
  await test('une image large aussi', async () => {
    await add(page, await image(page, 'large.png', { width: 1200, height: 800 }));
    await waitPreview(page);
    const box = await previewBox(page);
    await clearAll();
    return { ok: box.width >= 220 && Math.abs(box.width / box.height - 1.5) < 0.02, detail: JSON.stringify(box) };
  });
  await test('une petite image garde sa taille', async () => {
    await add(page, await image(page, 'petite.png', { width: 60, height: 40 }));
    await waitPreview(page);
    const box = await previewBox(page);
    await clearAll();
    return { ok: box.width === 60 && box.height === 40, detail: JSON.stringify(box) };
  });
  await test('une photo tournée s’affiche dans le bon sens', async () => {
    await add(page, await fixture('oriented.jpg'));
    await waitPreview(page);
    const box = await previewBox(page);
    await clearAll();
    return { ok: box.height > box.width, detail: JSON.stringify(box) };
  });
  await test('changer un réglage garde l’aperçu', async () => {
    await add(page, await image(page, 'garde.png', { width: 1200, height: 800 }));
    await waitPreview(page);
    await release();
    await convert(page);
    await setQuality(page, 'Moyenne');
    const box = await previewBox(page);
    await setQuality(page, 'Haute');
    await clearAll();
    await hold();
    return { ok: box.kind === 'img' && box.loaded, detail: JSON.stringify(box) };
  });
  await test('une photo HEIC annonce son aperçu, puis le montre, net', async () => {
    await add(page, await fixture('bands-p3.heic'));
    await page.waitForSelector('.item-thumb-note');
    const before = await previewBox(page);
    await release();
    await convert(page);
    const after = await previewBox(page);
    await setQuality(page, 'Moyenne');
    const kept = await previewBox(page);
    await setQuality(page, 'Haute');
    await clearAll();
    await hold();
    return { ok: before.kind === 'aucun' && before.note && after.kind === 'canvas' && after.width >= 220 && after.pixels >= after.width * 2 && kept.kind === 'canvas', detail: `${JSON.stringify(before)} ; ${JSON.stringify(after)} ; ${JSON.stringify(kept)}` };
  });
  await test('un fichier illisible n’affiche pas d’image cassée', async () => {
    await add(page, textFile('notes.txt'));
    await page.waitForSelector('.item-thumb-note');
    await release();
    await convert(page);
    const box = await previewBox(page);
    await clearAll();
    await hold();
    return { ok: box.kind === 'aucun' && !box.note, detail: JSON.stringify(box) };
  });
  await test('retirer une image libère son aperçu', async () => {
    await page.evaluate(() => {
      window.revoked = 0;
      const real = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = (url) => {
        window.revoked++;
        real(url);
      };
    });
    await add(page, [await image(page, 'a.png', { width: 60, height: 40 }), await image(page, 'b.png', { width: 60, height: 40 })]);
    await waitPreview(page);
    await page.locator('.item').first().locator('.item-remove').click();
    const one = await page.evaluate(() => window.revoked);
    await clearAll();
    const two = await page.evaluate(() => window.revoked);
    return { ok: one === 1 && two === 2, detail: `${one} puis ${two}` };
  });
  await page.close();
}

async function groupFinish(context) {
  console.log('\n— Clavier, clair et sombre');
  await test('parcours au clavier jusqu’au téléchargement', async () => {
    const page = await openConverter(context);
    await spyDownloads(page);
    const reached = [];
    await page.keyboard.press('Tab');
    for (let press = 0; press < 12; press++) {
      reached.push(await page.evaluate(() => document.activeElement.id || document.activeElement.textContent.trim() || document.activeElement.tagName));
      await page.keyboard.press('Tab');
    }
    await add(page, await image(page, 'a.png', { width: 60, height: 40 }));
    await page.waitForFunction(() => document.body.dataset.state === 'idle' && !document.getElementById('download-all').disabled);
    await page.locator('#download-all').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.saved.length === 1);
    const outlined = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
    await page.close();
    const ok = reached.includes('JPG') && reached.includes('Haute') && reached.includes('Origine') && reached.includes('choose');
    return { ok: ok && outlined !== 'none', detail: `${reached.join(' > ')} ; contour ${outlined}` };
  });
  await test('le focus suit la conversion et reste sur une ligne', async () => {
    const page = await openConverter(context);
    await spyDownloads(page);
    await add(page, [await image(page, 'a.png', { width: 60, height: 40 }), await image(page, 'b.png', { width: 60, height: 40 })]);
    await page.waitForFunction(() => document.body.dataset.state === 'idle' && !document.querySelector('.item[data-status="waiting"], .item[data-status="working"]'));
    const afterConvert = await page.evaluate(() => document.activeElement.id);
    await page.locator('.item').first().locator('.item-save').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.saved.length === 1);
    await pause(100);
    const onRow = await page.evaluate(() => document.activeElement.className);
    await page.locator('.item').first().locator('.item-remove').focus();
    await page.keyboard.press('Enter');
    const afterRemove = await page.evaluate(() => document.activeElement.className);
    const left = (await rows(page)).length;
    await page.close();
    return { ok: afterConvert === 'download-all' && /item-save/.test(onRow) && /item-remove/.test(afterRemove) && left === 1, detail: `${afterConvert} ; ${onRow} ; ${afterRemove} ; ${left} ligne` };
  });
  await test('capture d’écran : erreur de taille et fenêtre de l’icône', async () => {
    const page = await openConverter(context);
    await page.setViewportSize(BIG_SCREEN);
    await add(page, await image(page, 'photo.png', { width: 60, height: 40 }));
    await setResize(page, '%', 150);
    await page.screenshot({ path: path.join(WORK, 'convert-resize-error.png') });
    await setResize(page, 'Largeur', 800);
    await page.screenshot({ path: path.join(WORK, 'convert-resize.png') });
    await page.close();
    const popup = await extensionPage(context, 'popup/popup.html');
    await popup.setViewportSize({ width: 360, height: 300 });
    await popup.screenshot({ path: path.join(WORK, 'popup.png') });
    await popup.close();
    return { ok: true, detail: 'enregistrées' };
  });
  for (const scheme of ['light', 'dark']) {
    await test(`captures d’écran en mode ${scheme === 'light' ? 'clair' : 'sombre'}`, async () => {
      const page = await openConverter(context);
      await page.setViewportSize(BIG_SCREEN);
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: path.join(WORK, `convert-empty-${scheme}.png`) });
      await add(page, [await fixture('bands-p3.heic', 'IMG_0012.heic'), await image(page, 'Capture d’écran 2026-11-03 à 15.22.01.png', { paint: 'noise', width: 900, height: 600 }), await image(page, 'Screenshot téléphone.png', { width: 1179, height: 2556, color: '#3f8fc4' }), await image(page, 'photo.png', { width: 1200, height: 800, color: '#f4c542' }), textFile('notes.txt')]);
      await page.screenshot({ path: path.join(WORK, `convert-waiting-${scheme}.png`) });
      await convert(page);
      await page.screenshot({ path: path.join(WORK, `convert-done-${scheme}.png`) });
      await setFormat(page, 'PDF');
      await convert(page);
      await page.screenshot({ path: path.join(WORK, `convert-pdf-${scheme}.png`) });
      await setFormat(page, 'JPG');
      await page.close();
      return { ok: true, detail: `${scheme}` };
    });
  }
}

async function groupRealExtension() {
  console.log('\n— Vraie extension, sans permission de test');
  await test('la vraie extension convertit aussi', async () => {
    const context = await launch(EXTENSION, 'profile-real', WORK);
    try {
      const page = await openConverter(context);
      await spyDownloads(page, { pass: true });
      await add(page, await fixture('bands-p3.heic', 'vraie.heic'));
      await convert(page);
      await page.locator('#download-all').click();
      await page.waitForFunction(() => window.saved.length === 1);
      const [row] = await rows(page);
      const name = (await savedNames(page))[0];
      return { ok: row.status === 'done' && name === 'Captures/Conversions/vraie.jpg', detail: `${row.status}, ${name}` };
    } finally {
      await context.close();
    }
  });
}

async function main() {
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(WORK, { recursive: true });
  const extension = await prepareExtension(WORK);
  const context = await launch(extension, 'profile', WORK);
  try {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    // La page retient ses réglages : chaque groupe repart de ceux d'origine.
    const groups = { page: groupPage, convert: groupConvert, heic: groupHeic, pdf: groupPdf, batch: groupBatch, preview: groupPreview, finish: groupFinish };
    for (const [name, group] of Object.entries(groups)) {
      if (ONLY && ONLY !== name) continue;
      await sw.evaluate(() => chrome.storage.sync.remove(['convertFormat', 'convertQuality']));
      await group(context, sw);
    }
  } finally {
    await context.close();
  }
  if (!ONLY || ONLY === 'batch') await groupRealExtension();
  const failed = results.filter((result) => !result.ok).length;
  console.log(`\n${results.length - failed}/${results.length} vérifications réussies`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
