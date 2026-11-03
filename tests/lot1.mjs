// Tests du lot 1 : version affichée, ⌘V dans le convertisseur, zip, export PDF et zip, clic droit sur une image.
// Même Chromium et même extension que les autres suites (écran ×2). Le PDF est contrôlé avec pdfinfo et pdftoppm, le zip avec unzip et python3.
// Usage : node lot1.mjs <dossier de sortie> [base|paste|zip|export|export-long|webimage] [motif]

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { EXTENSION, MANIFEST_EXPECTED, check, extensionPage, launch, openTab, prepareExtension, results, seedCapture } from './lib.mjs';

const run = promisify(execFile);
const WORK = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, 'out-lot1'));
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

const realManifest = async () => JSON.parse(await fs.readFile(path.join(EXTENSION, 'manifest.json'), 'utf8'));
const sameList = (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());

// --- Version et permissions ---

async function groupBase(context) {
  console.log('\n— Version et permissions');
  await test('version : la fenêtre de l’icône affiche la version du manifeste', async () => {
    const page = await extensionPage(context, 'popup/popup.html');
    try {
      const shown = await page.locator('#version').textContent({ timeout: 5000 });
      const { version } = await realManifest();
      return { ok: shown.includes(version), detail: `affiché « ${shown} », manifeste ${version}` };
    } finally {
      await page.close();
    }
  });
  await test('version : le manifeste vaut MANIFEST_EXPECTED', async () => {
    const { version } = await realManifest();
    return { ok: version === MANIFEST_EXPECTED.version, detail: `${version}, attendu ${MANIFEST_EXPECTED.version}` };
  });
  await test('permissions : le vrai manifeste vaut exactement MANIFEST_EXPECTED, sans host_permissions, <all_urls> ni clipboardRead', async () => {
    const manifest = await realManifest();
    const text = JSON.stringify(manifest);
    const ok =
      sameList(manifest.permissions, MANIFEST_EXPECTED.permissions) &&
      sameList(manifest.optional_host_permissions, MANIFEST_EXPECTED.optional_host_permissions) &&
      !manifest.host_permissions &&
      !text.includes('<all_urls>') &&
      !text.includes('clipboardRead');
    return { ok, detail: `${manifest.permissions.join()} ; facultatifs : ${manifest.optional_host_permissions?.join() ?? 'aucun'}` };
  });
}

// --- Coller avec ⌘V ---

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openConverter(context) {
  const page = await extensionPage(context, 'convert/convert.html');
  await page.waitForFunction(() => document.body.dataset.state === 'idle');
  return page;
}

// Une petite image fabriquée dans la page, rendue en base64 pour fabriquer ensuite un faux collage.
const tinyImage = (page, { type = 'image/png', color = '#336699', width = 40, height = 30 } = {}) =>
  page.evaluate(
    async ({ type, color, width, height }) => {
      const ctx = new OffscreenCanvas(width, height).getContext('2d');
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, width, height);
      const bytes = new Uint8Array(await (await ctx.canvas.convertToBlob({ type })).arrayBuffer());
      let text = '';
      for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
      return btoa(text);
    },
    { type, color, width, height },
  );

// Faux événement `paste`, envoyé à `target` (sélecteur CSS, sinon l'élément qui a le focus). `data` : { files: [{ name, type, base64 }], text, html }.
// `filesEmpty` : `files` reste vide et seuls les `items` portent les fichiers, comme le font certaines applications.
// Rend vrai si la page a empêché le collage normal.
function paste(page, { files = [], text, html, filesEmpty = false, target } = {}) {
  return page.evaluate(
    ({ files, text, html, filesEmpty, target }) => {
      const made = files.map(({ name, type, base64 }) => new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], name, { type }));
      const types = [];
      if (text !== undefined) types.push('text/plain');
      if (html !== undefined) types.push('text/html');
      if (made.length) types.push('Files');
      const items = [];
      if (text !== undefined) items.push({ kind: 'string', type: 'text/plain', getAsFile: () => null });
      if (html !== undefined) items.push({ kind: 'string', type: 'text/html', getAsFile: () => null });
      for (const file of made) items.push({ kind: 'file', type: file.type, getAsFile: () => file });
      const clipboardData = {
        types,
        items,
        files: filesEmpty ? [] : made,
        getData: (type) => (type === 'text/plain' ? (text ?? '') : type === 'text/html' ? (html ?? '') : ''),
      };
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: clipboardData });
      const node = target ? document.querySelector(target) : document.activeElement ?? document.body;
      node.dispatchEvent(event);
      return event.defaultPrevented;
    },
    { files, text, html, filesEmpty, target },
  );
}

const itemNames = (page) => page.evaluate(() => [...document.querySelectorAll('.item-name')].map((el) => el.textContent));
const toastText = (page) => page.evaluate(() => {
  const toast = document.getElementById('toast');
  return toast.hidden ? '' : toast.textContent;
});
const COLLAGE = /^Collage \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}(-\d+)?\.(png|jpg)$/;

async function groupPaste(context) {
  console.log('\n— Coller avec ⌘V');
  const session = async (body) => {
    const page = await openConverter(context);
    try {
      return await body(page);
    } finally {
      await page.close();
    }
  };
  await test('collage : un PNG devient une ligne nommée Collage…', () =>
    session(async (page) => {
      const prevented = await paste(page, { files: [{ name: 'image.png', type: 'image/png', base64: await tinyImage(page) }] });
      const [name] = await itemNames(page);
      return { ok: COLLAGE.test(name ?? '') && name.endsWith('.png') && prevented, detail: `${name}, collage normal empêché : ${prevented}` };
    }));
  await test('collage : un JPG garde son extension', () =>
    session(async (page) => {
      await paste(page, { files: [{ name: 'image.jpeg', type: 'image/jpeg', base64: await tinyImage(page, { type: 'image/jpeg' }) }] });
      const [name] = await itemNames(page);
      return { ok: COLLAGE.test(name ?? '') && name.endsWith('.jpg'), detail: name };
    }));
  await test('collage : deux images gardent l’ordre du presse-papiers', () =>
    session(async (page) => {
      const red = await tinyImage(page, { color: '#ff0000' });
      const green = await tinyImage(page, { color: '#00ff00' });
      await paste(page, { files: [{ name: 'image.png', type: 'image/png', base64: red }, { name: 'image.png', type: 'image/png', base64: green }] });
      const names = await itemNames(page);
      const first = names[0]?.replace(/\.png$/, '');
      const ok = names.length === 2 && COLLAGE.test(names[0]) && names[1] === `${first}-2.png`;
      return { ok, detail: names.join(' | ') };
    }));
  await test('collage : les fichiers restent bien ceux du presse-papiers, dans l’ordre', () =>
    session(async (page) => {
      const a = await tinyImage(page, { width: 11, height: 11 });
      const b = await tinyImage(page, { width: 22, height: 22 });
      await paste(page, { files: [{ name: 'image.png', type: 'image/png', base64: a }, { name: 'image.png', type: 'image/png', base64: b }] });
      await page.locator('#convert').click();
      await page.waitForFunction(() => document.querySelectorAll('.item[data-status="done"]').length === 2, undefined, { timeout: 30_000 });
      const details = await page.evaluate(() => [...document.querySelectorAll('.item-detail')].map((el) => el.textContent));
      return { ok: details[0].startsWith('11 × 11') && details[1].startsWith('22 × 22'), detail: details.join(' | ') };
    }));
  await test('collage : files vide et items rempli', () =>
    session(async (page) => {
      await paste(page, { filesEmpty: true, files: [{ name: 'image.png', type: 'image/png', base64: await tinyImage(page) }] });
      const names = await itemNames(page);
      return { ok: names.length === 1 && COLLAGE.test(names[0]), detail: names.join() };
    }));
  await test('collage : un fichier copié garde son nom', () =>
    session(async (page) => {
      await paste(page, { files: [{ name: 'vacances été.jpg', type: 'image/jpeg', base64: await tinyImage(page, { type: 'image/jpeg' }) }] });
      const names = await itemNames(page);
      return { ok: names.join() === 'vacances été.jpg', detail: names.join() };
    }));
  await test('collage : après Tout retirer, le focus sur le sélecteur de fichiers n’empêche rien', () =>
    session(async (page) => {
      const base64 = await tinyImage(page);
      await paste(page, { files: [{ name: 'image.png', type: 'image/png', base64 }] });
      await page.locator('#clear').click();
      const focused = await page.evaluate(() => document.activeElement?.id);
      await paste(page, { files: [{ name: 'image.png', type: 'image/png', base64 }] });
      const names = await itemNames(page);
      return { ok: focused === 'files' && names.length === 1, detail: `focus ${focused}, ${names.length} ligne` };
    }));
  await test('collage : le champ Largeur garde son collage', () =>
    session(async (page) => {
      await page.locator('#resize button', { hasText: /^Largeur$/ }).click();
      await page.locator('#resize-value').focus();
      const prevented = await paste(page, { files: [{ name: 'image.png', type: 'image/png', base64: await tinyImage(page) }], text: '640' });
      const names = await itemNames(page);
      return { ok: !prevented && names.length === 0 && !(await toastText(page)), detail: `empêché : ${prevented}, ${names.length} ligne` };
    }));
  await test('collage : texte seul, message', () =>
    session(async (page) => {
      await paste(page, { text: 'juste du texte' });
      const message = await toastText(page);
      const names = await itemNames(page);
      return { ok: names.length === 0 && /Pas d’image dans le presse-papiers/.test(message) && /glisse-le ici/.test(message), detail: message };
    }));
  await test('collage : presse-papiers vide, message', () =>
    session(async (page) => {
      await paste(page, {});
      const message = await toastText(page);
      return { ok: /Pas d’image dans le presse-papiers/.test(message), detail: message };
    }));
  await test('collage : texte seul dans un champ, aucun bruit', () =>
    session(async (page) => {
      await page.locator('#resize button', { hasText: /^Largeur$/ }).click();
      await page.locator('#resize-value').focus();
      const prevented = await paste(page, { text: '640' });
      return { ok: !prevented && !(await toastText(page)), detail: `empêché : ${prevented}` };
    }));
  await test('collage : nom puis image', () =>
    session(async (page) => {
      await paste(page, { text: 'vacances.jpg', files: [{ name: 'image.png', type: 'image/png', base64: await tinyImage(page) }] });
      const message = await toastText(page);
      const names = await itemNames(page);
      return { ok: names.length === 0 && /glisse-le ici/.test(message), detail: `${names.length} ligne, ${message}` };
    }));
  await test('collage : HTML et image, la ligne est ajoutée', () =>
    session(async (page) => {
      await paste(page, { html: '<img src="a.png">', text: 'a', files: [{ name: 'image.png', type: 'image/png', base64: await tinyImage(page) }] });
      const names = await itemNames(page);
      return { ok: names.length === 1 && COLLAGE.test(names[0]), detail: names.join() };
    }));
  await test('collage : refusé pendant une conversion', () =>
    session(async (page) => {
      const base64 = await tinyImage(page, { width: 3000, height: 3000 });
      await paste(page, { files: [{ name: 'image.png', type: 'image/png', base64 }] });
      await page.locator('#convert').click();
      await page.waitForFunction(() => document.body.dataset.state === 'running');
      await paste(page, { files: [{ name: 'image.png', type: 'image/png', base64 }] });
      const message = await toastText(page);
      const names = await itemNames(page);
      return { ok: names.length === 1 && /conversion est en cours/.test(message), detail: `${names.length} ligne, ${message}` };
    }));
  await test('collage : la zone de dépôt dit … ou colle avec ⌘V', () =>
    session(async (page) => {
      const label = await page.locator('#drop').textContent();
      return { ok: /ou colle avec ⌘V/.test(label), detail: label.replace(/\s+/g, ' ').trim() };
    }));
  await test('collage : pastedName numérote et suit le type', () =>
    session(async (page) => {
      const names = await page.evaluate(async () => {
        const { pastedName } = await import(chrome.runtime.getURL('convert/paste.js'));
        const date = new Date(2026, 10, 3, 15, 22, 1);
        return [pastedName(date, 0, 'image/png'), pastedName(date, 1, 'image/png'), pastedName(date, 2, 'image/jpeg'), pastedName(date, 0, 'image/webp'), pastedName(date, 0, '')];
      });
      const expected = ['Collage 2026-11-03 15.22.01.png', 'Collage 2026-11-03 15.22.01-2.png', 'Collage 2026-11-03 15.22.01-3.jpg', 'Collage 2026-11-03 15.22.01.webp', 'Collage 2026-11-03 15.22.01.png'];
      return { ok: JSON.stringify(names) === JSON.stringify(expected), detail: names.join(' | ') };
    }));
}

// --- Écrire un zip ---

// Relit un fichier de la page (Blob) en octets, côté Node.
async function blobToFile(page, handle, file) {
  const base64 = await page.evaluate(async (blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = '';
    for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(text);
  }, handle);
  await fs.writeFile(file, Buffer.from(base64, 'base64'));
  return file;
}

// Lecteur indépendant : noms exacts (décodés selon le bit 11) et empreinte SHA-256 de chaque entrée.
const PY_ZIP = `import hashlib, json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
print(json.dumps([{'name': i.filename, 'size': i.file_size, 'method': i.compress_type, 'flag': i.flag_bits, 'sha': hashlib.sha256(z.read(i)).hexdigest()} for i in z.infolist()]))`;
const readZip = async (file) => JSON.parse((await run('python3', ['-c', PY_ZIP, file])).stdout);

async function groupZip(context) {
  console.log('\n— Écrire un zip');
  const dir = path.join(WORK, 'zip');
  await fs.mkdir(dir, { recursive: true });
  const page = await extensionPage(context, 'convert/convert.html');
  try {
    // Trois entrées, dont une de 3 Mio : le CRC est lu par morceaux, et doit rester juste à travers eux.
    const handle = await page.evaluateHandle(async () => {
      const { ZipWriter } = await import(chrome.runtime.getURL('viewer/zip.js'));
      const big = new Uint8Array(3 * 1024 * 1024);
      for (let i = 0; i < big.length; i++) big[i] = (i * 31 + (i >> 8)) & 255;
      const zip = new ZipWriter();
      await zip.add('image-01.png', new Blob([new Uint8Array([1, 2, 3, 4])]));
      await zip.add('photo été à Noël.jpg', new Blob(['contenu accentué']));
      await zip.add('grande.bin', new Blob([big]));
      return zip.finish();
    });
    const file = await blobToFile(page, handle, path.join(dir, 'essai.zip'));
    await test('zip : unzip -t accepte le fichier', async () => {
      const { stdout } = await run('unzip', ['-t', file]);
      return { ok: /No errors detected/.test(stdout), detail: stdout.trim().split('\n').pop() };
    });
    await test('zip : le lecteur Python relit noms et octets', async () => {
      const entries = await readZip(file);
      const big = Buffer.alloc(3 * 1024 * 1024);
      for (let i = 0; i < big.length; i++) big[i] = (i * 31 + (i >> 8)) & 255;
      const expected = [Buffer.from([1, 2, 3, 4]), Buffer.from('contenu accentué'), big].map(sha);
      const ok = entries.length === 3 && entries.every((entry, i) => entry.sha === expected[i] && entry.method === 0);
      return { ok, detail: entries.map((entry) => `${entry.name} ${entry.size}`).join(' | ') };
    });
    await test('zip : un nom accentué reste juste', async () => {
      const entries = await readZip(file);
      return { ok: entries[1].name === 'photo été à Noël.jpg' && (entries[1].flag & 0x800) !== 0, detail: entries[1].name };
    });
    await test('zip : l’archive vide est valide', async () => {
      const empty = await page.evaluateHandle(async () => {
        const { ZipWriter } = await import(chrome.runtime.getURL('viewer/zip.js'));
        return new ZipWriter().finish();
      });
      const entries = await readZip(await blobToFile(page, empty, path.join(dir, 'vide.zip')));
      return { ok: entries.length === 0, detail: `${entries.length} entrée` };
    });
    await test('zip : ZipTooBig au-delà de la limite d’entrées', async () => {
      const outcome = await page.evaluate(async () => {
        const { ZipWriter, ZipTooBig } = await import(chrome.runtime.getURL('viewer/zip.js'));
        const zip = new ZipWriter({ maxEntries: 2 });
        await zip.add('a', new Blob(['a']));
        await zip.add('b', new Blob(['b']));
        try {
          await zip.add('c', new Blob(['c']));
          return 'accepté';
        } catch (err) {
          return err instanceof ZipTooBig ? 'ZipTooBig' : String(err);
        }
      });
      return { ok: outcome === 'ZipTooBig', detail: outcome };
    });
    await test('zip : ZipTooBig au-delà de la limite d’octets', async () => {
      const outcome = await page.evaluate(async () => {
        const { ZipWriter, ZipTooBig } = await import(chrome.runtime.getURL('viewer/zip.js'));
        const zip = new ZipWriter({ maxBytes: 300 });
        await zip.add('a', new Blob([new Uint8Array(100)]));
        try {
          await zip.add('b', new Blob([new Uint8Array(100)]));
          return 'accepté';
        } catch (err) {
          return err instanceof ZipTooBig ? 'ZipTooBig' : String(err);
        }
      });
      return { ok: outcome === 'ZipTooBig', detail: outcome };
    });
  } finally {
    await page.close();
  }
}

// --- Menu Exporter, PDF et zip ---

const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');

async function openResults(context, id) {
  const page = await extensionPage(context, `viewer/viewer.html?id=${id}`);
  await page.waitForSelector('body[data-ready="true"]', { timeout: 120_000 });
  return page;
}

// Remplace le téléchargement par un relevé (nom et adresse du fichier).
const spyDownloads = (page) =>
  page.evaluate(() => {
    window.saved = [];
    chrome.downloads.download = async (options) => {
      window.saved.push(options);
      return window.saved.length;
    };
  });

async function savedBytes(page, index) {
  const base64 = await page.evaluate(async (index) => {
    const bytes = new Uint8Array(await (await fetch(window.saved[index].url)).arrayBuffer());
    let text = '';
    for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(text);
  }, index);
  return Buffer.from(base64, 'base64');
}

const savedNames = (page) => page.evaluate(() => window.saved.map((entry) => entry.filename));

// Ralentit le rendu des parties, le temps d'agir en plein export.
const slowRendering = (page, ms = 500) =>
  page.evaluate(async (ms) => {
    const { Stitcher } = await import(chrome.runtime.getURL('viewer/stitcher.js'));
    const real = Stitcher.prototype.renderPart;
    Stitcher.prototype.renderPart = function (...args) {
      return real.apply(this, args).then((blob) => new Promise((resolve) => setTimeout(() => resolve(blob), ms)));
    };
  }, ms);

async function chooseExport(page, kind) {
  await page.locator('#export').click();
  await page.locator(`#export-menu [data-export="${kind}"]`).click();
}

const waitIdle = (page) => page.waitForFunction(() => !document.getElementById('export').hidden && document.getElementById('export-cancel').hidden, undefined, { timeout: 180_000 });

// Lance un export et rend ses octets et son nom.
async function exported(page, kind) {
  await spyDownloads(page);
  await chooseExport(page, kind);
  await waitIdle(page);
  const [filename] = await savedNames(page);
  return { filename, bytes: filename ? await savedBytes(page, 0) : null };
}

async function pdfInfo(file) {
  const { stdout } = await run('pdfinfo', ['-box', '-f', '1', '-l', '999', file]);
  const pages = [...stdout.matchAll(/Page\s+\d+ MediaBox:\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/g)].map((match) => ({ width: Number(match[3]), height: Number(match[4]) }));
  return { text: stdout, pages };
}

// Une page du PDF, rendue à 96 points par pouce : un pixel de la partie vaut un pixel du rendu. Rend le PNG en octets.
async function pdfPagePng(file, number, prefix) {
  await run('pdftoppm', ['-r', '96', '-f', String(number), '-l', String(number), '-singlefile', '-png', file, prefix]);
  return fs.readFile(`${prefix}.png`);
}

const readPixels = (page, bytes, points) =>
  page.evaluate(
    async ({ base64, points }) => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))]));
      const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      return { width: bitmap.width, height: bitmap.height, pixels: points.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]) };
    },
    { base64: bytes.toString('base64'), points },
  );

const isNear = (pixel, rgb, tolerance = 28) => rgb.every((value, channel) => Math.abs(pixel[channel] - value) <= tolerance);

function baseOf(filename) {
  return filename.split('/').pop().replace(/\.\w+$/, '');
}

async function groupExport(context) {
  console.log('\n— Menu Exporter, PDF et zip');
  const dir = path.join(WORK, 'export');
  await fs.mkdir(dir, { recursive: true });
  const setup = await extensionPage(context, 'popup/popup.html');
  await setup.evaluate(() => chrome.storage.sync.set({ split: 'medium', format: 'png' }));
  const tall = await seedCapture(setup, { heightPoints: 12000 });
  const single = await seedCapture(setup, { heightPoints: 1000 });
  const annotated = await seedCapture(setup, { heightPoints: 12000 });
  const MASK = { id: 'm1', type: 'mask', color: 'red', size: 'm', x: 400, y: 10000, width: 900, height: 300, fill: '#606060' };
  await setup.evaluate(
    async ({ id, mask }) => {
      const { saveAnnotations } = await import(chrome.runtime.getURL('lib/db.js'));
      await saveAnnotations(id, [mask]);
    },
    { id: annotated, mask: MASK },
  );
  const session = async (id, body) => {
    const page = await openResults(context, id);
    try {
      return await body(page);
    } finally {
      await page.close();
    }
  };

  const pdfFile = path.join(dir, 'tall.pdf');
  let pdfName = '';
  await session(tall, async (page) => {
    const { filename, bytes } = await exported(page, 'pdf');
    pdfName = filename ?? '';
    if (bytes) await fs.writeFile(pdfFile, bytes);
  });
  const partCount = await session(tall, (page) => page.evaluate(() => document.querySelectorAll('figure.part').length));

  await test('pdf : une page par partie', async () => {
    const { pages } = await pdfInfo(pdfFile);
    return { ok: partCount > 1 && pages.length === partCount, detail: `${pages.length} pages, ${partCount} parties` };
  });
  await test('pdf : MediaBox au plus 14 400', async () => {
    const { pages } = await pdfInfo(pdfFile);
    return { ok: pages.length > 0 && pages.every((box) => box.width <= 14400 && box.height <= 14400), detail: pages.map((box) => `${box.width}×${box.height}`).join(' ') };
  });
  await test('pdf : l’annotation est rendue à sa place', () =>
    session(annotated, async (page) => {
      const { bytes } = await exported(page, 'pdf');
      const file = path.join(dir, 'annotated.pdf');
      await fs.writeFile(file, bytes);
      const { pages } = await pdfInfo(file);
      // Le masque (y = 10 000 px de la capture) tombe dans la deuxième page. Hauteurs en pixels : points / 0,75.
      const firstHeight = Math.round(pages[0].height / 0.75);
      const y = MASK.y + 150 - firstHeight;
      const png = await pdfPagePng(file, 2, path.join(dir, 'annotated-p2'));
      const { width, pixels } = await readPixels(page, png, [[MASK.x + 450, y], [MASK.x - 40, y]]);
      const painted = isNear(pixels[0], [96, 96, 96], 60);
      const beside = isNear(pixels[1], [255, 255, 255], 12);
      return { ok: width === 2560 && painted && beside, detail: `largeur ${width}, masque ${pixels[0]}, à côté ${pixels[1]}` };
    }));
  await test('pdf : pas d’auteur ni de lieu', async () => {
    const { text } = await pdfInfo(pdfFile);
    const bytes = await fs.readFile(pdfFile);
    const found = ['/Author', '/Creator', '/Producer', '/Title', '/Info', 'GPS', 'Exif'].filter((word) => bytes.includes(word));
    const ok = !/^(Author|Creator|Producer|Title):/m.test(text) && found.length === 0;
    return { ok, detail: found.join() || 'aucun champ' };
  });
  await test('pdf : positions de la table des références exactes', async () => {
    const bytes = await fs.readFile(pdfFile);
    const tail = bytes.subarray(bytes.lastIndexOf('startxref')).toString('latin1');
    const table = Number(tail.split('\n')[1]);
    const lines = bytes.subarray(table, bytes.indexOf('trailer', table)).toString('latin1').split('\n');
    const count = Number(lines[1].split(' ')[1]);
    const wrong = [];
    for (let object = 1; object < count; object++) {
      const offset = Number(lines[2 + object].slice(0, 10));
      if (bytes.subarray(offset, offset + 12).toString('latin1').indexOf(`${object} 0 obj`) !== 0) wrong.push(object);
    }
    return { ok: bytes.subarray(table, table + 4).toString() === 'xref' && count > 3 && wrong.length === 0, detail: `${count} objets, faux : ${wrong.join() || 'aucun'}` };
  });
  await test('pdf : JPEG qualité Haute, 0,75 pt par pixel', () =>
    session(tall, async (page) => {
      const { pages } = await pdfInfo(pdfFile);
      const bytes = await fs.readFile(pdfFile);
      const height = Math.round(pages[0].height / 0.75);
      // Premier flux d'image du fichier, comparé à la même partie encodée à 92 %.
      const match = /\/Filter \/DCTDecode \/Length (\d+) >>\nstream\n/.exec(bytes.toString('latin1'));
      const start = match.index + match[0].length;
      const stream = bytes.subarray(start, start + Number(match[1]));
      const expected = await page.evaluate(
        async ({ id, height }) => {
          const { Stitcher } = await import(chrome.runtime.getURL('viewer/stitcher.js'));
          const { getCapture } = await import(chrome.runtime.getURL('lib/db.js'));
          const stitcher = new Stitcher(await getCapture(id));
          const blob = await stitcher.renderPart({ top: 0, height }, 'image/jpeg', 0.92);
          stitcher.dispose();
          return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('');
        },
        { id: tall, height },
      );
      const ok = sha(stream) === expected && pages.every((box) => Math.abs(box.width - 2560 * 0.75) < 0.01) && stream[0] === 0xff && stream[1] === 0xd8;
      return { ok, detail: `largeur ${pages[0].width} pt, flux ${stream.length} octets, identique à 92 % : ${sha(stream) === expected}` };
    }));
  await test('pdf : nom Captures/<hôte_date>/<hôte_date>.pdf', async () => {
    const base = baseOf(pdfName);
    return { ok: pdfName === `Captures/${base}/${base}.pdf` && /^127\.0\.0\.1_\d{4}-\d\d-\d\d_\d\dh\d\d-\d\d$/.test(base), detail: pdfName };
  });

  await test('zip : nom Captures/<hôte_date>/<hôte_date>.zip', () =>
    session(tall, async (page) => {
      const { filename } = await exported(page, 'zip');
      const base = baseOf(filename);
      return { ok: filename === `Captures/${base}/${base}.zip`, detail: filename };
    }));
  await test('zip : mêmes octets que Tout télécharger', () =>
    session(tall, async (page) => {
      const { bytes } = await exported(page, 'zip');
      const file = path.join(dir, 'tall.zip');
      await fs.writeFile(file, bytes);
      await run('unzip', ['-t', file]);
      const entries = await readZip(file);
      await spyDownloads(page);
      await page.locator('#download-all').click();
      await page.waitForFunction((count) => window.saved.length === count, entries.length, { timeout: 120_000 });
      await page.waitForFunction(() => !document.getElementById('download-all').disabled);
      const names = await savedNames(page);
      const hashes = [];
      for (let i = 0; i < names.length; i++) hashes.push(sha(await savedBytes(page, i)));
      const ok = entries.length === partCount && entries.every((entry, i) => entry.name === names[i].split('/').pop() && entry.sha === hashes[i]);
      return { ok, detail: `${entries.map((entry) => entry.name).join(' ')} ; identiques : ${entries.filter((entry, i) => entry.sha === hashes[i]).length}/${entries.length}` };
    }));
  await test('zip : nom avec une seule partie', () =>
    session(single, async (page) => {
      const { bytes, filename } = await exported(page, 'zip');
      const file = path.join(dir, 'single.zip');
      await fs.writeFile(file, bytes);
      const entries = await readZip(file);
      const base = baseOf(filename);
      return { ok: entries.length === 1 && entries[0].name === `${base}.png`, detail: entries.map((entry) => entry.name).join() };
    }));
  await test('zip : trois formats', () =>
    session(tall, async (page) => {
      const signatures = { png: (b) => b.subarray(1, 4).toString() === 'PNG', jpg: (b) => b[0] === 0xff && b[1] === 0xd8, webp: (b) => b.subarray(8, 12).toString() === 'WEBP' };
      const results = [];
      for (const format of ['png', 'jpg', 'webp']) {
        await page.locator(`#format button[data-key="${format}"]`).click();
        const { bytes } = await exported(page, 'zip');
        const file = path.join(dir, `tall-${format}.zip`);
        await fs.writeFile(file, bytes);
        await run('unzip', ['-t', file]);
        await run('unzip', ['-o', '-q', file, '-d', path.join(dir, `tall-${format}`)]);
        const entries = await readZip(file);
        const first = await fs.readFile(path.join(dir, `tall-${format}`, entries[0].name));
        results.push(entries.every((entry) => entry.name.endsWith(`.${format}`)) && signatures[format](first));
      }
      await page.locator('#format button[data-key="png"]').click();
      return { ok: results.every(Boolean), detail: results.join() };
    }));
  await test('zip : au-delà de 4 Gio ou 65 535 entrées, message de refus visible', () =>
    session(tall, async (page) => {
      await spyDownloads(page);
      await page.evaluate(async () => {
        const { ZipWriter } = await import(chrome.runtime.getURL('viewer/zip.js'));
        const real = ZipWriter.prototype.add;
        ZipWriter.prototype.add = function (...args) {
          this.maxEntries = 1;
          return real.apply(this, args);
        };
      });
      await chooseExport(page, 'zip');
      await waitIdle(page);
      const message = await toastText(page);
      const saved = await savedNames(page);
      return { ok: saved.length === 0 && /4 Go/.test(message) && /65 535/.test(message), detail: message };
    }));

  await test('menu : la phrase sur la perte est affichée', () =>
    session(tall, async (page) => {
      await page.locator('#export').click();
      const visible = await page.locator('#export-menu').isVisible();
      const words = await page.locator('#export-menu').textContent();
      const ok = visible && words.includes('PDF : plus léger, texte un peu moins net. Zip en PNG : sans perte.');
      for (const [scheme, shot] of [['light', 'menu-clair.png'], ['dark', 'menu-sombre.png']]) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.screenshot({ path: path.join(dir, shot), clip: { x: 760, y: 0, width: 520, height: 260 } });
      }
      return { ok, detail: words.replace(/\s+/g, ' ').trim() };
    }));
  await test('menu : clavier', () =>
    session(tall, async (page) => {
      await spyDownloads(page);
      const active = () => page.evaluate(() => document.activeElement?.textContent.trim());
      const steps = [];
      await page.locator('#export').focus();
      await page.keyboard.press('Enter');
      steps.push(await active());
      await page.keyboard.press('ArrowDown');
      steps.push(await active());
      await page.keyboard.press('ArrowDown');
      steps.push(await active());
      await page.keyboard.press('ArrowUp');
      steps.push(await active());
      await page.keyboard.press('Escape');
      const closed = await page.locator('#export-menu').isHidden();
      steps.push(await active());
      await page.keyboard.press('Enter');
      await page.keyboard.press('Tab');
      const closedByTab = await page.locator('#export-menu').isHidden();
      await page.locator('#export').focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await waitIdle(page);
      const names = await savedNames(page);
      const expected = ['PDF', 'Zip des images', 'PDF', 'Zip des images', 'Exporter'];
      const ok = JSON.stringify(steps) === JSON.stringify(expected) && closed && closedByTab && names.length === 1 && names[0].endsWith('.zip');
      return { ok, detail: `${steps.join(' → ')}, ${names.join()}` };
    }));
  await test('annuler : aucun fichier', () =>
    session(tall, async (page) => {
      await spyDownloads(page);
      await slowRendering(page);
      await chooseExport(page, 'pdf');
      await page.waitForFunction(() => /Partie 2 sur/.test(document.getElementById('export-progress').textContent), undefined, { timeout: 60_000 });
      const progress = await page.locator('#export-progress').textContent();
      await page.locator('#export-cancel').click();
      await waitIdle(page);
      await pause(1500);
      const saved = await savedNames(page);
      const message = await toastText(page);
      const free = await page.evaluate(() => !document.getElementById('export').disabled && !document.getElementById('download-all').disabled);
      return { ok: saved.length === 0 && /annulé/.test(message) && free && /^Partie 2 sur \d+$/.test(progress), detail: `${progress}, ${saved.length} fichier, ${message}` };
    }));
  await test('erreur sur la partie 2 : message et aucun fichier', () =>
    session(tall, async (page) => {
      await spyDownloads(page);
      await page.evaluate(async () => {
        const { Stitcher } = await import(chrome.runtime.getURL('viewer/stitcher.js'));
        const real = Stitcher.prototype.renderPart;
        let calls = 0;
        Stitcher.prototype.renderPart = function (...args) {
          if (++calls === 2) return Promise.reject(new Error('panne simulée'));
          return real.apply(this, args);
        };
      });
      await chooseExport(page, 'pdf');
      await waitIdle(page);
      await pause(500);
      const message = await toastText(page);
      const saved = await savedNames(page);
      return { ok: saved.length === 0 && /partie 2/.test(message) && /aucun fichier/i.test(message) && !/panne simulée/.test(message), detail: message };
    }));
  await test('export figé : changer de capture, de découpage ou ouvrir l’éditeur est impossible, puis relecture du PDF page par page', () =>
    session(tall, async (page) => {
      await spyDownloads(page);
      await slowRendering(page, 800);
      await chooseExport(page, 'pdf');
      await page.waitForFunction(() => document.getElementById('export-progress').textContent !== '', undefined, { timeout: 60_000 });
      // Tentatives : découpage, autre capture, suppression, éditeur par le bouton et par le menu du clic droit, message d'un autre onglet.
      const frozen = await page.evaluate(
        ({ other, mask, id }) => {
          const disabled = (selector) => [...document.querySelectorAll(selector)].every((el) => el.disabled);
          const state = {
            split: disabled('#split button'),
            history: disabled('.history-item') && disabled('.history-delete'),
            annotate: disabled('.annotate') && document.querySelector('#image-menu [data-action="annotate"]').disabled,
            all: document.getElementById('download-all').disabled,
          };
          document.querySelector('#split button[data-key="short"]').click();
          document.querySelector(`.history-item[data-id="${other}"]`).click();
          document.querySelector('.annotate').click();
          const channel = new BroadcastChannel('capture-annotations');
          channel.postMessage({ captureId: id, items: [mask] });
          channel.close();
          return state;
        },
        { other: single, mask: MASK, id: tall },
      );
      await pause(300);
      const editorOpen = await page.locator('#editor').isVisible();
      await waitIdle(page);
      const [saved] = await savedNames(page);
      const bytes = await savedBytes(page, 0);
      const file = path.join(dir, 'frozen.pdf');
      await fs.writeFile(file, bytes);
      const { pages } = await pdfInfo(file);
      // Le masque arrivé en plein export ne doit pas y figurer, ni une autre capture ni un autre découpage.
      const firstHeight = Math.round(pages[0].height / 0.75);
      const png = await pdfPagePng(file, 2, path.join(dir, 'frozen-p2'));
      const { pixels } = await readPixels(page, png, [[MASK.x + 450, MASK.y + 150 - firstHeight]]);
      const url = await page.evaluate(() => location.search);
      const after = await page.evaluate(() => {
        const disabled = (selector) => [...document.querySelectorAll(selector)].some((el) => el.disabled);
        return { split: disabled('#split button'), history: disabled('.history-item') };
      });
      const ok =
        frozen.split && frozen.history && frozen.annotate && frozen.all && !editorOpen &&
        pages.length === partCount && url.includes(tall) && saved.endsWith('.pdf') &&
        !isNear(pixels[0], [96, 96, 96], 60) && !after.split && !after.history;
      return { ok, detail: `${JSON.stringify(frozen)}, éditeur ${editorOpen}, ${pages.length} pages, pixel ${pixels[0]}, ensuite ${JSON.stringify(after)}` };
    }));
  await test('contrôle : un export mené à son terme compte bien un téléchargement', async () => {
    const sw = context.serviceWorkers()[0];
    const before = await sw.evaluate(async () => (await chrome.downloads.search({})).length);
    const page = await openResults(context, single);
    try {
      await chooseExport(page, 'pdf');
      await waitIdle(page);
      await pause(1000);
      const after = await sw.evaluate(async () => (await chrome.downloads.search({})).length);
      return { ok: after === before + 1, detail: `${before} → ${after} téléchargements` };
    } finally {
      await page.close();
    }
  });
  await test('onglet fermé en plein export : aucun fichier', async () => {
    const sw = context.serviceWorkers()[0];
    const before = await sw.evaluate(async () => (await chrome.downloads.search({})).length);
    const page = await openResults(context, tall);
    await slowRendering(page);
    await chooseExport(page, 'pdf');
    await page.waitForFunction(() => document.getElementById('export-progress').textContent !== '', undefined, { timeout: 60_000 });
    await page.close();
    await pause(2500);
    const after = await sw.evaluate(async () => (await chrome.downloads.search({})).length);
    return { ok: after === before, detail: `${before} → ${after} téléchargements` };
  });
  await test('onglet rechargé en plein export : aucun fichier', async () => {
    const sw = context.serviceWorkers()[0];
    const before = await sw.evaluate(async () => (await chrome.downloads.search({})).length);
    const page = await openResults(context, tall);
    try {
      await slowRendering(page);
      await chooseExport(page, 'pdf');
      await page.waitForFunction(() => document.getElementById('export-progress').textContent !== '', undefined, { timeout: 60_000 });
      await page.reload();
      await page.waitForSelector('body[data-ready="true"]', { timeout: 120_000 });
      await pause(1500);
      const after = await sw.evaluate(async () => (await chrome.downloads.search({})).length);
      const free = await page.evaluate(() => !document.getElementById('export').disabled);
      return { ok: after === before && free, detail: `${before} → ${after} téléchargements, bouton libre : ${free}` };
    } finally {
      await page.close();
    }
  });
  await test('double clic : un seul export', () =>
    session(tall, async (page) => {
      await spyDownloads(page);
      await page.locator('#export').click();
      await page.locator('#export-menu [data-export="pdf"]').dblclick();
      await waitIdle(page);
      await pause(1000);
      const names = await savedNames(page);
      return { ok: names.length === 1, detail: `${names.length} fichier` };
    }));
  await test('Tout télécharger : toujours un téléchargement par image', () =>
    session(tall, async (page) => {
      await spyDownloads(page);
      await page.locator('#download-all').click();
      await page.waitForFunction((count) => window.saved.length === count, partCount, { timeout: 120_000 });
      await pause(500);
      const names = await savedNames(page);
      const formats = await page.evaluate(async () => Object.keys((await import(chrome.runtime.getURL('lib/settings.js'))).FORMATS));
      return { ok: names.length === partCount && names.every((name) => /\/image-\d\d\.png$/.test(name)) && formats.join() === 'png,jpg,webp', detail: `${names.length} fichiers, formats ${formats.join()}` };
    }));
  await setup.close();
}

// --- Export d'une page de 100 000 points ---

// Mémoire vive du navigateur de test et de tous ses processus enfants, additionnée, en Mo. La racine porte `--user-data-dir` et pas `--type=`.
async function browserMemoryMb(profile) {
  const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid=,rss=,command='], { maxBuffer: 16 * 1024 * 1024 });
  const rows = stdout.trim().split('\n').map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match && { pid: Number(match[1]), ppid: Number(match[2]), rss: Number(match[3]), command: match[4] };
  }).filter(Boolean);
  const root = rows.find((row) => row.command.includes(`--user-data-dir=${profile}`) && !row.command.includes('--type='));
  if (!root) return 0;
  const family = new Set([root.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows) {
      if (family.has(row.ppid) && !family.has(row.pid)) {
        family.add(row.pid);
        grew = true;
      }
    }
  }
  return rows.filter((row) => family.has(row.pid)).reduce((sum, row) => sum + row.rss, 0) / 1024;
}

// Contenu dense : du grain de type photo sur toute la tranche, puis des blocs de couleur. Le PNG d'une tranche pèse alors plusieurs Mo :
// c'est plus lourd qu'une vraie page. Des blocs plats seuls se compressent presque à rien et fausseraient la mesure (essai du 2026-11-03 : zip de 18 Mo).
function denseDraw(ctx, { width }) {
  const top = -ctx.getTransform().f;
  if (!self.denseGrain) {
    const grain = new OffscreenCanvas(width, 1800);
    const grainCtx = grain.getContext('2d');
    const pixels = grainCtx.createImageData(width, 1800);
    let seed = 12345;
    for (let i = 0; i < pixels.data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        pixels.data[i + c] = 96 + ((seed >> 16) & 63);
      }
      pixels.data[i + 3] = 255;
    }
    grainCtx.putImageData(pixels, 0, 0);
    self.denseGrain = grain;
  }
  // Décalage horizontal différent à chaque tranche : deux tranches ne se ressemblent pas.
  const shift = (top * 7) % width;
  ctx.drawImage(self.denseGrain, -shift, top);
  ctx.drawImage(self.denseGrain, width - shift, top);
  for (let y = Math.floor(top / 480) * 480; y < top + 1800; y += 480) {
    ctx.fillStyle = `hsl(${y % 360} 60% 45%)`;
    ctx.fillRect(100, y, 300, 40);
  }
}

const LONG_LIMIT_MB = 2500;

async function groupExportLong(context, profile) {
  console.log('\n— Export d’une page de 100 000 points');
  const setup = await extensionPage(context, 'popup/popup.html');
  await setup.evaluate(() => chrome.storage.sync.set({ split: 'medium', format: 'png' }));
  const started = Date.now();
  const id = await seedCapture(setup, { heightPoints: 100000, draw: denseDraw });
  console.log(`   capture préparée en ${Math.round((Date.now() - started) / 1000)} s`);
  await setup.close();

  const page = await extensionPage(context, `viewer/viewer.html?id=${id}`);
  page.setDefaultTimeout(600_000);
  await page.waitForFunction(() => document.querySelectorAll('figure.part').length > 1, undefined, { timeout: 600_000 });
  // Compte les canvas de partie (de la largeur de la capture, plus hauts que 1 000 px) vivants, de leur création à leur remise à zéro.
  await page.evaluate(() => {
    const Real = OffscreenCanvas;
    window.liveParts = new Set();
    window.peakParts = 0;
    window.OffscreenCanvas = class extends Real {
      constructor(width, height) {
        super(width, height);
        if (width === 2560 && height > 1000) {
          window.liveParts.add(this);
          window.peakParts = Math.max(window.peakParts, window.liveParts.size);
        }
      }
      get width() {
        return super.width;
      }
      set width(value) {
        super.width = value;
        if (value === 0) window.liveParts.delete(this);
      }
      get height() {
        return super.height;
      }
      set height(value) {
        super.height = value;
        if (value === 0) window.liveParts.delete(this);
      }
    };
  });
  await spyDownloads(page);
  const dir = path.join(WORK, 'export-long');
  await fs.mkdir(dir, { recursive: true });
  const measure = async (kind) => {
    await page.evaluate(() => {
      window.saved = [];
      window.peakParts = 0;
    });
    let peak = 0;
    const timer = setInterval(async () => {
      peak = Math.max(peak, await browserMemoryMb(profile));
    }, 2000);
    const begun = Date.now();
    try {
      await page.waitForFunction(() => document.body.dataset.ready === 'true', undefined, { timeout: 600_000 });
      await chooseExport(page, kind);
      await page.waitForFunction(() => !document.getElementById('export').hidden && document.getElementById('export-cancel').hidden, undefined, { timeout: 600_000 });
    } finally {
      clearInterval(timer);
    }
    const seconds = Math.round((Date.now() - begun) / 1000);
    const size = await page.evaluate(async () => (await (await fetch(window.saved[0].url)).blob()).size);
    const parts = await page.evaluate(() => window.peakParts);
    return { peak: Math.round(peak), seconds, size: Math.round(size / 1024 / 1024), parts, count: await page.evaluate(() => document.querySelectorAll('figure.part').length) };
  };
  const pdf = await measure('pdf');
  const zip = await measure('zip');
  await test('long : jamais plus d’un canvas de partie vivant', async () => ({ ok: pdf.parts === 1 && zip.parts === 1, detail: `PDF ${pdf.parts}, zip ${zip.parts}` }));
  await test('long : moins de 2,5 Go au total, navigateur, processus graphique et rendus additionnés', async () => ({
    ok: pdf.peak > 0 && zip.peak > 0 && pdf.peak < LONG_LIMIT_MB && zip.peak < LONG_LIMIT_MB,
    detail: `${pdf.count} parties, PDF ${pdf.peak} Mo en ${pdf.seconds} s (fichier ${pdf.size} Mo), zip ${zip.peak} Mo en ${zip.seconds} s (fichier ${zip.size} Mo)`,
  }));
  await page.close();
}

// --- Clic droit sur une image ---

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const MB = 1024 * 1024;

// Un PNG qui annonce des dimensions énormes : seul l'en-tête est valide, et il ne doit jamais être décodé.
function hugePng(width, height) {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  head[24] = 8;
  head[25] = 6;
  return Buffer.concat([head, Buffer.alloc(64)]);
}

// Le vrai AVIF de 2 × 2 px, dont la case de dimensions annonce désormais `size` × `size`.
function hugeAvif(bytes, size) {
  const copy = Buffer.from(bytes);
  const at = copy.indexOf('ispe', 0, 'latin1');
  copy.writeUInt32BE(size, at + 8);
  copy.writeUInt32BE(size, at + 12);
  return copy;
}

const madeImage = async (page, { type, half = false, width = 60, height = 40 }) =>
  Buffer.from(
    await page.evaluate(
      async ({ type, half, width, height }) => {
        const ctx = new OffscreenCanvas(width, height).getContext('2d');
        ctx.fillStyle = '#336699';
        ctx.fillRect(0, 0, half ? width / 2 : width, height);
        const bytes = new Uint8Array(await (await ctx.canvas.convertToBlob({ type })).arrayBuffer());
        return btoa(String.fromCharCode(...bytes));
      },
      { type, half, width, height },
    ),
    'base64',
  );

function imageServer(routes) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const route = routes[`${url.pathname}${url.search}`] ?? routes[url.pathname];
    if (!route) return res.writeHead(404).end();
    if (typeof route === 'function') return route(req, res);
    res.writeHead(route.status ?? 200, { 'content-type': route.type }).end(route.body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Dans le service worker : réponse simulée à la demande d'accès (Playwright ne sait pas répondre à la vraie), et relevé de chaque téléchargement
// avec ses octets, lus avant que le document hors écran ne se ferme.
const armWorker = (sw, granted) =>
  sw.evaluate((granted) => {
    self.askedAccess = [];
    Object.defineProperty(chrome.permissions, 'request', {
      configurable: true,
      value: async (args) => {
        self.askedAccess.push(args);
        return granted;
      },
    });
    self.savedImages = [];
    self.realDownload ??= chrome.downloads.download.bind(chrome.downloads);
    Object.defineProperty(chrome.downloads, 'download', {
      configurable: true,
      value: async (options) => {
        const bytes = new Uint8Array(await (await fetch(options.url)).arrayBuffer());
        let text = '';
        for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
        self.savedImages.push({ filename: options.filename, conflictAction: options.conflictAction, saveAs: options.saveAs, base64: btoa(text) });
        return self.realDownload(options);
      },
    });
  }, granted);

const lastSaved = async (sw) => {
  const saved = await sw.evaluate(() => self.savedImages);
  return saved.map((entry) => ({ ...entry, bytes: Buffer.from(entry.base64, 'base64') }));
};

const clickImage = (sw, request) => sw.evaluate((request) => self.saveWebImage(request), request);

// Ce que voit l'utilisateur après un refus : l'icône, puis la phrase dans la fenêtre de l'icône.
async function afterRefusal(context, sw, tabId) {
  const state = await sw.evaluate(
    async (tabId) => ({
      badge: await chrome.action.getBadgeText({ tabId }),
      lastError: (await chrome.storage.session.get('lastError')).lastError ?? null,
    }),
    tabId,
  );
  const popup = await extensionPage(context, 'popup/popup.html');
  await popup.waitForFunction(() => document.getElementById('version').textContent !== '');
  await pause(150);
  const shown = await popup.evaluate(() => {
    const el = document.getElementById('error');
    return el.hidden ? '' : el.textContent;
  });
  await popup.close();
  return { ...state, shown };
}

async function groupWebImage() {
  console.log('\n— Clic droit sur une image');
  const extension = await prepareExtension(WORK);
  await fs.writeFile(path.join(extension, 'test-worker-silent.js'), 'self.onmessage = () => {};');
  await fs.writeFile(path.join(extension, 'test-worker-crash.js'), "throw new Error('panne simulée');");
  await fs.writeFile(path.join(extension, 'test-worker-marker.js'), "self.onmessage = ({ data }) => self.postMessage({ id: data.id, error: 'TRAVAILLEUR APPELÉ' });");

  const avif = await fs.readFile(path.join(FIXTURES, 'flat.avif'));
  const context = await launch(extension, 'profile-web', WORK);
  let first;
  let second;
  try {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const helper = await extensionPage(context, 'popup/popup.html');
    const png = await madeImage(helper, { type: 'image/png', half: true });
    const jpg = await madeImage(helper, { type: 'image/jpeg' });
    const webp = await madeImage(helper, { type: 'image/webp' });
    const routes = {
      '/page.html': { type: 'text/html; charset=utf-8', body: '<!doctype html><title>Page</title><img src="photo.png">' },
      '/photo.png': { type: 'image/png', body: png },
      '/photo.jpg': { type: 'image/jpeg', body: jpg },
      '/photo.webp': { type: 'image/webp', body: webp },
      '/photo.avif': { type: 'image/avif', body: avif },
      '/transparente.png': { type: 'image/png', body: png },
      '/interdite.png': { status: 403, type: 'text/html', body: 'Forbidden' },
      '/article.html': { type: 'text/html', body: '<html>pas une image</html>' },
      '/enorme.png': { type: 'image/png', body: hugePng(30000, 30000) },
      '/enorme.avif': { type: 'image/avif', body: hugeAvif(avif, 20000) },
      '/illisible.png': { type: 'image/png', body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]) },
      '/logo-dynamique': { type: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
      '/image?id=3': { type: 'image/png', body: png },
      '/a%3Ab%3F%22c%3E.png': { type: 'image/png', body: png },
      '/lourde.png': (_req, res) => {
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': 101 * MB });
        res.write(Buffer.alloc(MB));
      },
      '/lourde-sans-taille.png': async (_req, res) => {
        res.writeHead(200, { 'content-type': 'image/png' });
        const chunk = Buffer.alloc(MB);
        for (let sent = 0; sent < 120 && !res.destroyed; sent++) {
          if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
        }
        res.end();
      },
    };
    first = await imageServer(routes);
    second = await imageServer(routes);
    const base = `http://127.0.0.1:${first.address().port}`;
    const other = `http://127.0.0.1:${second.address().port}`;
    const { page: tabPage, tabId } = await openTab(context, sw, `${base}/page.html`);
    const request = (srcUrl, format = 'png', extra = {}) => ({ srcUrl, pageUrl: `${base}/page.html`, format, tabId, ...extra });

    await armWorker(sw, true);
    await test('clic droit : PNG garde la transparence', async () => {
      const result = await clickImage(sw, request(`${other}/photo.png`));
      const [saved] = await lastSaved(sw);
      const { pixels } = await readPixels(helper, saved.bytes, [[10, 10], [50, 10]]);
      const ok = result.ok && saved.bytes.subarray(1, 4).toString() === 'PNG' && pixels[0][3] === 255 && pixels[1][3] === 0;
      return { ok, detail: `${JSON.stringify(result)}, pixels ${pixels.join(' | ')}` };
    });
    await test('clic droit : dossier Captures/Web', async () => {
      const [saved] = await lastSaved(sw);
      return { ok: saved.filename === 'Captures/Web/photo.png' && saved.saveAs === false, detail: saved.filename };
    });
    await armWorker(sw, true);
    await test('clic droit : JPG sur fond blanc', async () => {
      const result = await clickImage(sw, request(`${other}/transparente.png`, 'jpg'));
      const [saved] = await lastSaved(sw);
      const { pixels } = await readPixels(helper, saved.bytes, [[50, 10], [10, 10]]);
      const ok = result.ok && result.filename === 'Captures/Web/transparente.jpg' && saved.bytes[0] === 0xff && saved.bytes[1] === 0xd8 && isNear(pixels[0], [255, 255, 255], 3) && isNear(pixels[1], [51, 102, 153], 12);
      return { ok, detail: `${result.filename}, pixels ${pixels.join(' | ')}` };
    });
    await test('clic droit : JPG en qualité Haute 92 %', async () => {
      const [saved] = await lastSaved(sw);
      const viaWorker = await helper.evaluate(
        async ({ url }) => {
          const blob = await (await fetch(url)).blob();
          const convert = (quality) =>
            new Promise((resolve, reject) => {
              const worker = new Worker(chrome.runtime.getURL('convert/convert-worker.js'), { type: 'module' });
              worker.onerror = reject;
              worker.onmessage = async ({ data }) => {
                worker.terminate();
                const bytes = new Uint8Array(await data.blob.arrayBuffer());
                resolve(btoa(String.fromCharCode(...bytes)));
              };
              worker.postMessage({ id: 1, file: blob, options: { format: 'jpg', quality, resize: { mode: 'none' } } });
            });
          return { high: await convert('high'), medium: await convert('medium') };
        },
        { url: `${other}/transparente.png` },
      );
      const asHigh = saved.base64 === viaWorker.high;
      return { ok: asHigh && viaWorker.high !== viaWorker.medium, detail: `identique à Haute : ${asHigh}` };
    });
    await armWorker(sw, true);
    await test('clic droit : un WebP est converti', async () => {
      const result = await clickImage(sw, request(`${other}/photo.webp`, 'png'));
      const [saved] = await lastSaved(sw);
      const { width, height } = await readPixels(helper, saved.bytes, []);
      return { ok: result.ok && saved.filename === 'Captures/Web/photo.png' && saved.bytes.subarray(1, 4).toString() === 'PNG' && width === 60 && height === 40, detail: `${saved.filename}, ${width} × ${height}` };
    });
    await armWorker(sw, true);
    await test('clic droit : un AVIF est converti', async () => {
      const result = await clickImage(sw, request(`${other}/photo.avif`, 'jpg'));
      const [saved] = await lastSaved(sw);
      const { width, height } = await readPixels(helper, saved.bytes, []);
      return { ok: result.ok && saved.filename === 'Captures/Web/photo.jpg' && saved.bytes[0] === 0xff && width === 1 && height === 1, detail: `${saved.filename}, ${width} × ${height}` };
    });
    await test('clic droit : une image en data: est enregistrée', async () => {
      await armWorker(sw, true);
      const result = await clickImage(sw, request(`data:image/png;base64,${png.toString('base64')}`, 'png'));
      return { ok: result.ok && result.filename === 'Captures/Web/image.png', detail: JSON.stringify(result) };
    });
    await test('taille : readImageSize lit un PNG, un JPEG, un GIF, un WebP et un AVIF', async () => {
      const files = { png, jpg, webp, avif, gif: await fs.readFile(path.join(FIXTURES, 'animated.gif')), exif: await fs.readFile(path.join(FIXTURES, 'oriented.jpg')) };
      const sizes = await helper.evaluate(async (files) => {
        const { readImageSize } = await import(chrome.runtime.getURL('web-image/image-size.js'));
        const decode = (base64) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const out = {};
        for (const [name, base64] of Object.entries(files)) {
          const bytes = decode(base64);
          const bitmap = await createImageBitmap(new Blob([bytes])).catch(() => null);
          out[name] = { read: readImageSize(bytes), real: bitmap && [bitmap.width, bitmap.height] };
        }
        // WebP sans perte (VP8L, 300 × 200) et étendu (VP8X, 5000 × 4000), en-têtes écrits à la main ; puis un fichier quelconque.
        const riff = (fourcc, body) => Uint8Array.from([...new TextEncoder().encode('RIFF'), 0, 0, 0, 0, ...new TextEncoder().encode('WEBP'), ...new TextEncoder().encode(fourcc), 0, 0, 0, 0, ...body]);
        const bits = (299 & 0x3fff) | ((199 & 0x3fff) << 14);
        out.vp8l = { read: readImageSize(riff('VP8L', [0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255])), real: [300, 200] };
        out.vp8x = { read: readImageSize(riff('VP8X', [0, 0, 0, 0, 0x87, 0x13, 0, 0x9f, 0x0f, 0])), real: [5000, 4000] };
        out.junk = { read: readImageSize(new TextEncoder().encode('<html>pas une image</html>')), real: null };
        return out;
      }, Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, bytes.toString('base64')])));
      const wrong = Object.entries(sizes).filter(([name, { read, real }]) => {
        if (name === 'junk') return read !== null;
        if (!read || !real) return true;
        // Ce petit AVIF porte une consigne de recadrage : 2 × 2 px encodés, 1 × 1 px affiché. La limite de mémoire compte ce qui est encodé.
        if (name === 'avif') return read.width !== 2 || read.height !== 2;
        // L'orientation d'une photo échange ses côtés à l'affichage : le nombre de pixels reste le même.
        return read.width * read.height !== real[0] * real[1];
      });
      return { ok: wrong.length === 0, detail: wrong.map(([name, v]) => `${name} ${JSON.stringify(v)}`).join() || Object.entries(sizes).map(([name, { read }]) => `${name} ${read ? `${read.width}×${read.height}` : 'null'}`).join(', ') };
    });

    await test('clic droit : l’accès demandé vaut exactement http://*/* et https://*/*', async () => {
      await armWorker(sw, true);
      await clickImage(sw, request(`${base}/photo.png`));
      const [asked] = await sw.evaluate(() => self.askedAccess);
      const ok = JSON.stringify(asked) === JSON.stringify({ origins: ['http://*/*', 'https://*/*'] });
      return { ok, detail: JSON.stringify(asked) };
    });
    await test('clic droit : accès accordé, images de deux autres origines enregistrées', async () => {
      await armWorker(sw, true);
      const one = await clickImage(sw, request(`${base}/photo.jpg`, 'jpg'));
      const two = await clickImage(sw, request(`${other}/photo.jpg`, 'jpg'));
      const saved = await lastSaved(sw);
      return { ok: one.ok && two.ok && saved.length === 2, detail: `${saved.length} fichiers` };
    });
    await test('clic droit : l’accès accordé est retenu au deuxième essai', async () => {
      await armWorker(sw, true);
      const asked = await sw.evaluate(async (request) => {
        // Chrome répond tout de suite, sans demande : le code doit quand même repasser par `request`, sans attente avant.
        const started = [];
        const real = chrome.permissions.request;
        Object.defineProperty(chrome.permissions, 'request', { configurable: true, value: (args) => (started.push(args), real(args)) });
        const pending = self.saveWebImage(request);
        // Sans `await` avant la demande, elle est déjà partie quand l'appel rend la main.
        const synchronous = started.length === 1;
        const first = await pending;
        const second = await self.saveWebImage(request);
        return { synchronous, first: first.ok, second: second.ok, calls: started.length };
      }, request(`${base}/photo.jpg`, 'jpg'));
      return { ok: asked.synchronous && asked.first && asked.second && asked.calls === 2, detail: JSON.stringify(asked) };
    });
    await test('clic droit : menus Enregistrer en PNG et Enregistrer en JPG', async () => {
      const menus = await sw.evaluate(async () => {
        const present = {};
        for (const id of ['save-image-png', 'save-image-jpg']) present[id] = await chrome.contextMenus.update(id, {}).then(() => true, () => false);
        return { present, declared: self.webImageMenus };
      });
      const titles = menus.declared?.map((menu) => `${menu.id}=${menu.title}`).join();
      const contexts = menus.declared?.every((menu) => menu.contexts.join() === 'image');
      return { ok: menus.present['save-image-png'] && menus.present['save-image-jpg'] && titles === 'save-image-png=Enregistrer en PNG,save-image-jpg=Enregistrer en JPG' && contexts, detail: titles };
    });
    await test('succès : pastille OK pendant 3 s', async () => {
      await armWorker(sw, true);
      await clickImage(sw, request(`${base}/photo.png`));
      const now = await sw.evaluate((tabId) => chrome.action.getBadgeText({ tabId }), tabId);
      await pause(1500);
      const during = await sw.evaluate((tabId) => chrome.action.getBadgeText({ tabId }), tabId);
      await pause(2200);
      const later = await sw.evaluate((tabId) => chrome.action.getBadgeText({ tabId }), tabId);
      return { ok: now === 'OK' && during === 'OK' && later === '', detail: `« ${now} », « ${during} », « ${later} »` };
    });
    await test('succès : le document hors écran est refermé', async () => {
      const left = await sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length);
      return { ok: left === 0, detail: `${left} document` };
    });
    await test('fenêtre de l’icône : phrase sur l’image animée devenue fixe', async () => {
      const popup = await extensionPage(context, 'popup/popup.html');
      const words = await popup.locator('body').textContent();
      await popup.close();
      return { ok: /image animée devient fixe/.test(words), detail: words.match(/[^.]*image animée[^.]*\./)?.[0]?.trim() ?? 'absente' };
    });

    // Un cas par raison : rien de téléchargé, pastille « ! », phrase en français dans la fenêtre de l'icône.
    const refused = (name, srcUrl, pattern, options = {}) =>
      test(name, async () => {
        await armWorker(sw, true);
        await sw.evaluate((testing) => {
          self.webImageTesting = testing;
        }, options.testing ?? {});
        const result = await clickImage(sw, request(srcUrl, 'png', options.extra));
        await sw.evaluate(() => {
          self.webImageTesting = {};
        });
        const saved = await lastSaved(sw);
        const seen = await afterRefusal(context, sw, tabId);
        const ok = result.ok === false && saved.length === 0 && pattern.test(result.reason) && seen.badge === '!' && seen.lastError?.message.includes(result.reason) && seen.shown.includes(result.reason);
        return { ok, detail: `${result.reason} [pastille ${seen.badge}, ${saved.length} fichier, fenêtre : ${seen.shown ? 'oui' : 'non'}]` };
      });
    await refused('refus : 403', `${other}/interdite.png`, /403/);
    await refused('refus : pas une image', `${other}/article.html`, /ne mène pas à une image/);
    await refused('refus : plus de 100 Mo', `${other}/lourde.png`, /100 Mo/);
    await refused('refus : plus de 100 Mo, sans taille annoncée', `${other}/lourde-sans-taille.png`, /100 Mo/);
    await refused('refus : plus de 100 Mpx sans décodage', `${other}/enorme.png`, /100 mégapixels/, { testing: { workerUrl: 'test-worker-marker.js' } });
    await refused('refus : un AVIF de plus de 100 Mpx sans décodage', `${other}/enorme.avif`, /100 mégapixels/, { testing: { workerUrl: 'test-worker-marker.js' } });
    await refused('refus : dimensions illisibles', `${other}/illisible.png`, /format/i, { testing: { workerUrl: 'test-worker-marker.js' } });
    await refused('refus : travailleur qui ne répond pas, délai maximal et message', `${other}/photo.png`, /trop de temps/, { testing: { workerUrl: 'test-worker-silent.js', timeoutMs: 1200 } });
    await refused('travailleur qui lâche : message visible', `${other}/photo.png`, /mémoire/, { testing: { workerUrl: 'test-worker-crash.js' } });
    await refused('refus : blob, SVG, page interdite', 'blob:http://exemple.fr/abc', /blob/);
    await refused('refus : SVG par son adresse', 'https://exemple.fr/logo.svg', /SVG/);
    await refused('refus : SVG par sa réponse', `${other}/logo-dynamique`, /SVG/);
    await refused('refus : SVG en data:', 'data:image/svg+xml;base64,PHN2Zy8+', /SVG/);
    await refused('refus : page interdite, chrome://', `${other}/photo.png`, /interdit/, { extra: { pageUrl: 'chrome://settings/' } });
    await refused('refus : page interdite, Chrome Web Store', `${other}/photo.png`, /interdit/, { extra: { pageUrl: 'https://chromewebstore.google.com/detail/x' } });
    await refused('refus : schéma non admis', 'ftp://exemple.fr/a.png', /adresse/);
    await refused('refus : chrome-extension', 'chrome-extension://abc/a.png', /adresse/);

    await armWorker(sw, true);
    await test('nom : adresse sans nom de fichier', async () => {
      const result = await clickImage(sw, request(`${other}/image?id=3`));
      const names = await helper.evaluate(async () => {
        const { webImageName } = await import(chrome.runtime.getURL('web-image/save-web-image.js'));
        return [webImageName('https://exemple.fr/', 'jpg'), webImageName('https://exemple.fr/image?id=3', 'png'), webImageName('data:image/png;base64,AAAA', 'jpg')];
      });
      return { ok: result.filename === 'Captures/Web/image.png' && names.join() === 'image.jpg,image.png,image.jpg', detail: `${result.filename}, ${names.join()}` };
    });
    await test('nom : caractères interdits', async () => {
      const result = await clickImage(sw, request(`${other}/a%3Ab%3F%22c%3E.png`));
      const names = await helper.evaluate(async () => {
        const { webImageName } = await import(chrome.runtime.getURL('web-image/save-web-image.js'));
        return [webImageName('https://exemple.fr/photos/été%202026.large.webp', 'jpg'), webImageName('https://exemple.fr/..%2F..%2Fsecret.png', 'png'), webImageName('https://exemple.fr/%E0%A4%A', 'png'), webImageName('https://exemple.fr/con.png', 'png')];
      });
      const ok = result.filename === 'Captures/Web/a-b--c-.png' && names[0] === 'été 2026.large.jpg' && !names[1].includes('/') && names[3] === 'image-con.png' && names.every((name) => !/[\\/:*?"<>|~]/.test(name));
      return { ok, detail: `${result.filename}, ${names.join(' | ')}` };
    });
    await test('nom : numéro si le nom est pris', async () => {
      await armWorker(sw, true);
      await clickImage(sw, request(`${base}/photo.png`));
      await clickImage(sw, request(`${base}/photo.png`));
      const saved = await lastSaved(sw);
      return { ok: saved.length === 2 && saved.every((entry) => entry.conflictAction === 'uniquify'), detail: saved.map((entry) => entry.conflictAction).join() };
    });
    await test('service worker relancé pendant la demande : l’enregistrement reprend à l’accord', async () => {
      await armWorker(sw, true);
      const result = await sw.evaluate(async (request) => {
        await chrome.storage.session.set({ pendingWebImage: { ...request, at: Date.now() } });
        const answer = await self.resumeWebImage();
        return { answer, pending: (await chrome.storage.session.get('pendingWebImage')).pendingWebImage ?? null };
      }, request(`${base}/photo.png`));
      const saved = await lastSaved(sw);
      return { ok: result.answer?.ok && !result.pending && saved.length === 1, detail: JSON.stringify(result) };
    });
    await tabPage.close();
    await helper.close();
  } finally {
    await context.close();
    first?.close();
    second?.close();
  }

  // Sans accès aux sites : la copie sans `<all_urls>`, puis la vraie extension.
  for (const [label, dir, profile] of [['copie allHosts: false', await prepareExtension(WORK, { allHosts: false }), 'profile-sans-hotes'], ['vraie extension', EXTENSION, 'profile-vraie']]) {
    const bare = await launch(dir, profile, WORK);
    const server = await imageServer({ '/page.html': { type: 'text/html', body: '<title>Page</title>' }, '/photo.png': { type: 'image/png', body: await fs.readFile(path.join(FIXTURES, 'p3.png')) } });
    try {
      const sw = bare.serviceWorkers()[0] ?? (await bare.waitForEvent('serviceworker'));
      const base = `http://127.0.0.1:${server.address().port}`;
      const { tabId } = await openTab(bare, sw, `${base}/page.html`);
      const request = { srcUrl: `${base}/photo.png`, pageUrl: `${base}/page.html`, format: 'jpg', tabId };
      const name = label === 'vraie extension' ? 'vraie extension' : 'clic droit';
      await test(`${name} : refus sur la copie allHosts: false, rien n’est téléchargé et le message s’affiche`.replace('sur la copie allHosts: false', label === 'vraie extension' ? 'de l’accès' : 'sur la copie allHosts: false'), async () => {
        await armWorker(sw, false);
        const result = await clickImage(sw, request);
        const saved = await lastSaved(sw);
        const seen = await afterRefusal(bare, sw, tabId);
        const ok = result.ok === false && saved.length === 0 && /autorisé/.test(result.reason) && seen.badge === '!' && seen.shown.includes(result.reason);
        return { ok, detail: `${result.reason} [pastille ${seen.badge}, fenêtre : ${seen.shown ? 'oui' : 'non'}]` };
      });
      await test(`${name} : la permission manque vraiment, la lecture échoue sans fichier`, async () => {
        await armWorker(sw, true);
        const result = await clickImage(sw, request);
        const saved = await lastSaved(sw);
        return { ok: result.ok === false && saved.length === 0 && /lire/.test(result.reason), detail: result.reason };
      });
      await test(`${name} : demande refusée puis service worker relancé, la fenêtre le dit`, async () => {
        await sw.evaluate(
          (request) => chrome.storage.session.set({ pendingWebImage: { ...request, at: Date.now() } }),
          request,
        );
        const seen = await afterRefusal(bare, sw, tabId);
        const left = await sw.evaluate(async () => (await chrome.storage.session.get('pendingWebImage')).pendingWebImage ?? null);
        return { ok: /autorisé/.test(seen.shown) && !left, detail: seen.shown };
      });
    } finally {
      await bare.close();
      server.close();
    }
  }
}

async function main() {
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(WORK, { recursive: true });
  const extension = await prepareExtension(WORK);
  const context = await launch(extension, 'profile', WORK);
  try {
    context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const groups = { base: groupBase, paste: groupPaste, zip: groupZip, export: groupExport };
    for (const [name, group] of Object.entries(groups)) {
      if (ONLY && ONLY !== name) continue;
      await group(context);
    }
    if (!ONLY || ONLY === 'export-long') await groupExportLong(context, path.join(WORK, 'profile'));
  } finally {
    await context.close();
  }
  if (!ONLY || ONLY === 'webimage') await groupWebImage();
  const failed = results.filter((result) => !result.ok).length;
  console.log(`\n${results.length - failed}/${results.length} vérifications réussies`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
