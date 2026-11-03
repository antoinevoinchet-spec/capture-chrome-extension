// Tests du lot 1 : version affichée, ⌘V dans le convertisseur, zip, export PDF et zip, clic droit sur une image.
// Même Chromium et même extension que les autres suites (écran ×2). Le PDF est contrôlé avec pdfinfo et pdftoppm, le zip avec unzip et python3.
// Usage : node lot1.mjs <dossier de sortie> [base|paste|zip|export|export-long|webimage] [motif]

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { EXTENSION, MANIFEST_EXPECTED, check, extensionPage, launch, prepareExtension, results } from './lib.mjs';

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
      const { createHash } = await import('node:crypto');
      const sha = (data) => createHash('sha256').update(data).digest('hex');
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

async function main() {
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(WORK, { recursive: true });
  const extension = await prepareExtension(WORK);
  const context = await launch(extension, 'profile', WORK);
  try {
    context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const groups = { base: groupBase, paste: groupPaste, zip: groupZip };
    for (const [name, group] of Object.entries(groups)) {
      if (ONLY && ONLY !== name) continue;
      await group(context);
    }
  } finally {
    await context.close();
  }
  const failed = results.filter((result) => !result.ok).length;
  console.log(`\n${results.length - failed}/${results.length} vérifications réussies`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
