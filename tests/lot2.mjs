// Tests du lot 2 : le recadrage. Stockage du cadrage, rendu de l'image recadrée, bouton « Recadrer », tous les chemins d'export.
// Même Chromium et même extension que les autres suites (écran ×2).
// Usage : node lot2.mjs <dossier de sortie> [stockage|rendu|bouton|chemins] [motif]

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { EXTENSION, MANIFEST_EXPECTED, check, extensionPage, launch, prepareExtension, results, seedCapture } from './lib.mjs';

const run = promisify(execFile);
const WORK = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, 'out-lot2'));
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

const RECT = { id: 'a1', type: 'rect', color: 'red', size: 'm', x: 100, y: 200, width: 300, height: 80 };
const TRIM = { x: 40, y: 60, w: 800, h: 500 };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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

// Empreinte de chaque tranche d'une capture, lue en base : elle prouve que le recadrage ne réécrit rien.
const sliceHashes = (page, id) =>
  page.evaluate(async (id) => {
    const { getCapture } = await import(chrome.runtime.getURL('lib/db.js'));
    const { slices } = await getCapture(id);
    const hashes = [];
    for (const { blob } of slices) {
      const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
      hashes.push([...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''));
    }
    return hashes;
  }, id);

// --- Stockage du cadrage ---

async function groupStockage(context) {
  console.log('\n— Stockage du cadrage');
  const page = await extensionPage(context, 'viewer/viewer.html');
  // Sans capture, la page rend la main une fois sa lecture de la base finie : resetDb ne la trouve plus ouverte.
  await page.waitForSelector('body[data-ready="true"]');
  try {
    await test('version : le manifeste vaut MANIFEST_EXPECTED (0.3.0 ou plus)', async () => {
      const { version } = JSON.parse(await fs.readFile(path.join(EXTENSION, 'manifest.json'), 'utf8'));
      return { ok: version === MANIFEST_EXPECTED.version && version >= '0.3.0', detail: version };
    });

    await test('cadrage : enregistré sans toucher aux tranches', async () => {
      await resetDb(page);
      const id = await seedCapture(page, { heightPoints: 1500 });
      const before = await sliceHashes(page, id);
      const got = await page.evaluate(
        async ({ id, trim }) => {
          const { getEdits, saveEdits } = await import(chrome.runtime.getURL('lib/db.js'));
          await saveEdits(id, { items: [], trim });
          return getEdits(id);
        },
        { id, trim: TRIM },
      );
      const after = await sliceHashes(page, id);
      return { ok: same(got, { items: [], trim: TRIM }) && same(before, after) && before.length > 1, detail: `${JSON.stringify(got)}, ${before.length} tranches` };
    });

    await test('cadrage : gardé quand la dernière annotation est supprimée', async () => {
      await resetDb(page);
      const id = await seedCapture(page, { heightPoints: 900 });
      const got = await page.evaluate(
        async ({ id, trim, rect }) => {
          const { getAnnotations, getEdits, listAnnotatedIds, saveAnnotations, saveEdits } = await import(chrome.runtime.getURL('lib/db.js'));
          await saveEdits(id, { items: [rect], trim });
          await saveAnnotations(id, []);
          return { edits: await getEdits(id), items: await getAnnotations(id), kept: (await listAnnotatedIds()).has(id) };
        },
        { id, trim: TRIM, rect: RECT },
      );
      return { ok: same(got.edits, { items: [], trim: TRIM }) && got.items.length === 0 && got.kept, detail: JSON.stringify(got) };
    });

    await test('cadrage : une annotation ajoutée le garde (une seule écriture pour les deux)', async () => {
      await resetDb(page);
      const id = await seedCapture(page, { heightPoints: 900 });
      const got = await page.evaluate(
        async ({ id, trim, rect }) => {
          const { getEdits, saveAnnotations, saveEdits } = await import(chrome.runtime.getURL('lib/db.js'));
          await saveEdits(id, { items: [], trim });
          await saveAnnotations(id, [rect]);
          return getEdits(id);
        },
        { id, trim: TRIM, rect: RECT },
      );
      return { ok: same(got, { items: [RECT], trim: TRIM }), detail: JSON.stringify(got) };
    });

    await test('cadrage : items et cadrage vides, l’entrée disparaît', async () => {
      await resetDb(page);
      const id = await seedCapture(page, { heightPoints: 900 });
      const got = await page.evaluate(
        async ({ id, trim, rect }) => {
          const { getEdits, listAnnotatedIds, saveEdits } = await import(chrome.runtime.getURL('lib/db.js'));
          await saveEdits(id, { items: [rect], trim });
          await saveEdits(id, { items: [], trim: null });
          return { edits: await getEdits(id), kept: (await listAnnotatedIds()).has(id) };
        },
        { id, trim: TRIM, rect: RECT },
      );
      return { ok: same(got.edits, { items: [], trim: null }) && !got.kept, detail: JSON.stringify(got) };
    });

    await test('cadrage : base toujours en version 2 avec 2 magasins', async () => {
      await resetDb(page);
      const id = await seedCapture(page, { heightPoints: 900 });
      const got = await page.evaluate(
        async ({ id, trim }) => {
          const { saveEdits } = await import(chrome.runtime.getURL('lib/db.js'));
          await saveEdits(id, { items: [], trim });
          const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open('capture');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          const seen = { version: db.version, stores: [...db.objectStoreNames].sort() };
          db.close();
          return seen;
        },
        { id, trim: TRIM },
      );
      return { ok: got.version === 2 && same(got.stores, ['annotations', 'captures']), detail: JSON.stringify(got) };
    });

    await test('cadrage : capture absente, CaptureGone', async () => {
      await resetDb(page);
      const got = await page.evaluate(async (trim) => {
        const { getEdits, saveEdits } = await import(chrome.runtime.getURL('lib/db.js'));
        const name = await saveEdits('inconnue', { items: [], trim }).then(
          () => 'aucune erreur',
          (err) => err.name,
        );
        return { name, edits: await getEdits('inconnue') };
      }, TRIM);
      return { ok: got.name === 'CaptureGone' && same(got.edits, { items: [], trim: null }), detail: JSON.stringify(got) };
    });

    await test('ancienne entrée sans trim : trim vaut null', async () => {
      await resetDb(page);
      const id = await seedCapture(page, { heightPoints: 900 });
      const got = await page.evaluate(
        async ({ id, rect }) => {
          const { getEdits, saveAnnotations } = await import(chrome.runtime.getURL('lib/db.js'));
          await saveAnnotations(id, []);
          // Écrite telle que la version 0.2.0 l'écrivait : ni champ `trim`, ni passage par saveEdits.
          const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open('capture');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          await new Promise((resolve, reject) => {
            const tx = db.transaction('annotations', 'readwrite');
            tx.objectStore('annotations').put({ captureId: id, items: [rect], updatedAt: 1 });
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
          });
          db.close();
          return getEdits(id);
        },
        { id, rect: RECT },
      );
      return { ok: same(got, { items: [RECT], trim: null }), detail: JSON.stringify(got) };
    });

    await test('capture recadrée gardée après 16 captures', async () => {
      await resetDb(page);
      const start = Date.now() - 100_000;
      const trimmed = await seedCapture(page, { heightPoints: 100, createdAt: start });
      const plain = await seedCapture(page, { heightPoints: 100, createdAt: start + 1 });
      await page.evaluate(
        async ({ id, trim }) => {
          const { saveEdits } = await import(chrome.runtime.getURL('lib/db.js'));
          await saveEdits(id, { items: [], trim });
        },
        { id: trimmed, trim: { x: 0, y: 0, w: 100, h: 100 } },
      );
      for (let i = 0; i < 16; i++) await seedCapture(page, { heightPoints: 100, createdAt: start + 10 + i });
      const got = await page.evaluate(
        async ({ trimmed, plain }) => {
          const { getCapture, pruneCaptures } = await import(chrome.runtime.getURL('lib/db.js'));
          await pruneCaptures(15);
          return { trimmed: Boolean(await getCapture(trimmed)), plain: Boolean(await getCapture(plain)) };
        },
        { trimmed, plain },
      );
      return { ok: got.trimmed && !got.plain, detail: JSON.stringify(got) };
    });
  } finally {
    await page.close();
  }
}

// --- Rendu de l'image recadrée ---

// Dessiné sur chaque tranche (recopié en texte dans la page) : tout est vert « sentinelle », sauf le cadre, blanc, avec une marque bleue
// dans son coin haut gauche et une rouge dans son coin bas droit.
function sentinelDraw(ctx, { scale, width, height }) {
  const frame = { x: 100 * scale, y: 150 * scale, w: 600 * scale, h: 1200 * scale };
  ctx.fillStyle = 'rgb(0,255,0)';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#fff';
  ctx.fillRect(frame.x, frame.y, frame.w, frame.h);
  ctx.fillStyle = 'rgb(0,0,255)';
  ctx.fillRect(frame.x, frame.y, 10, 10);
  ctx.fillStyle = 'rgb(255,0,0)';
  ctx.fillRect(frame.x + frame.w - 10, frame.y + frame.h - 10, 10, 10);
}

const frameFor = (scale) => ({ x: 100 * scale, y: 150 * scale, w: 600 * scale, h: 1200 * scale });
const seedSentinel = (page, scale) => seedCapture(page, { heightPoints: 1500, widthPoints: 1000, scale, draw: sentinelDraw });

// Rend les parties d'une capture dans la page et décrit chaque fichier : dimensions, pixels « sentinelle » (vert franc ou mêlé, même lissé),
// fin exacte du fichier, blocs PNG, empreinte, couleur aux points demandés. `stitcherFile` et `renderFile` choisissent le code rendu
// (l'ancien, pour la comparaison d'octets).
const renderReport = (page, { id, trim, items = [], type = 'image/png', maxHeight, probes = [], stitcherFile = 'viewer/stitcher.js', renderFile = 'annotate/render.js', forcedParts }) =>
  page.evaluate(
    async ({ id, trim, items, type, maxHeight, probes, stitcherFile, renderFile, forcedParts }) => {
      const { getCapture } = await import(chrome.runtime.getURL('lib/db.js'));
      const { Stitcher } = await import(chrome.runtime.getURL(stitcherFile));
      const { avoidRanges, drawAnnotations } = await import(chrome.runtime.getURL(renderFile));
      const record = await getCapture(id);
      const stitcher = new Stitcher(record, {
        trim,
        overlay: (ctx, top, height, ratio, left) => drawAnnotations(ctx, items, record.scale, top, height, ratio, left),
      });
      const parts = forcedParts ?? (await stitcher.planParts(maxHeight ?? record.crop.h, avoidRanges(items, record.scale)));
      const files = [];
      for (const part of parts) {
        const blob = await stitcher.renderPart(part, type);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const bitmap = await createImageBitmap(blob);
        const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0);
        const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
        let sentinel = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i + 1] > data[i] + 40 && data[i + 1] > data[i + 2] + 40) sentinel++;
        const chunks = [];
        if (type === 'image/png') {
          const view = new DataView(bytes.buffer);
          for (let at = 8; at < bytes.length; at += 12 + view.getUint32(at)) chunks.push(String.fromCharCode(...bytes.subarray(at + 4, at + 8)));
        }
        const tail = [...bytes.subarray(-2)].map((b) => b.toString(16).padStart(2, '0')).join('');
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        files.push({
          width: bitmap.width,
          height: bitmap.height,
          sentinel,
          chunks,
          endsClean: type === 'image/png' ? chunks.at(-1) === 'IEND' && tail === '6082' : tail === 'ffd9',
          hash: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''),
          probes: probes.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3)),
        });
      }
      stitcher.dispose();
      return { parts, files };
    },
    { id, trim, items, type, maxHeight, probes, stitcherFile, renderFile, forcedParts },
  );

const near = (color, wanted, tolerance = 40) => color.every((channel, i) => Math.abs(channel - wanted[i]) <= tolerance);
const WHITE = [255, 255, 255];
const BLUE_MARK = [0, 0, 255];
const RED_MARK = [255, 0, 0];

async function groupRendu(context) {
  console.log('\n— Rendu de l’image recadrée');
  const page = await extensionPage(context, 'viewer/viewer.html');
  await page.waitForSelector('body[data-ready="true"]');
  try {
    await resetDb(page);
    for (const scale of [1, 2]) {
      const id = await seedSentinel(page, scale);
      const trim = frameFor(scale);
      const maxHeight = 500 * scale;
      await test(`rendu : dimensions égales au rectangle (échelle ${scale})`, async () => {
        const { files, parts } = await renderReport(page, { id, trim, maxHeight });
        const total = files.reduce((sum, file) => sum + file.height, 0);
        const contiguous = parts.every((part, i) => part.top === (i ? parts[i - 1].top + parts[i - 1].height : trim.y));
        const ok = files.length > 1 && files.every((file) => file.width === trim.w) && total === trim.h && contiguous;
        return { ok, detail: `${files.length} parties, ${trim.w} × ${total}, attendu ${trim.w} × ${trim.h}` };
      });
      await test(`rendu : sentinelle absente des pixels décodés (échelle ${scale})`, async () => {
        const png = await renderReport(page, { id, trim, maxHeight });
        const jpeg = await renderReport(page, { id, trim, maxHeight, type: 'image/jpeg' });
        const count = [...png.files, ...jpeg.files].reduce((sum, file) => sum + file.sentinel, 0);
        return { ok: count === 0, detail: `${count} pixels` };
      });
      await test(`rendu : le fichier finit par IEND ou FFD9 (échelle ${scale})`, async () => {
        const png = await renderReport(page, { id, trim, maxHeight });
        const jpeg = await renderReport(page, { id, trim, maxHeight, type: 'image/jpeg' });
        return { ok: [...png.files, ...jpeg.files].every((file) => file.endsClean), detail: `${png.files.length + jpeg.files.length} fichiers` };
      });
      await test(`rendu : aucun bloc tEXt ni eXIf (échelle ${scale})`, async () => {
        const { files } = await renderReport(page, { id, trim, maxHeight });
        const seen = [...new Set(files.flatMap((file) => file.chunks))];
        return { ok: !seen.some((name) => /^(tEXt|zTXt|iTXt|eXIf|tIME)$/.test(name)), detail: seen.join(' ') };
      });
      await test(`rendu : cadre à gauche et en haut non nuls (échelle ${scale})`, async () => {
        const { files } = await renderReport(page, { id, trim, maxHeight: trim.h, probes: [[2, 2], [trim.w - 3, trim.h - 3], [40, 40]] });
        const [first] = files;
        const ok = files.length === 1 && near(first.probes[0], BLUE_MARK) && near(first.probes[1], RED_MARK) && near(first.probes[2], WHITE);
        return { ok, detail: JSON.stringify(first.probes) };
      });
      await test(`rendu : annotation à cheval coupée au bord (échelle ${scale})`, async () => {
        // Masque opaque à cheval sur le bord gauche, à 100 px sous le haut du cadre : sa moitié intérieure commence à la colonne 0.
        const mask = { id: 'm1', type: 'mask', fill: '#ff0000', x: trim.x - 50, y: trim.y + 100, width: 100, height: 60 };
        const { files } = await renderReport(page, { id, trim, items: [mask], probes: [[5, 130], [45, 130], [60, 130]] });
        const [inside, edge, beyond] = files[0].probes;
        const reddish = ([r, g, b]) => r > 150 && g < 90 && b < 90;
        return { ok: reddish(inside) && reddish(edge) && near(beyond, WHITE) && files[0].sentinel === 0, detail: JSON.stringify(files[0].probes) };
      });
      await test(`rendu : annotation hors cadre non dessinée (échelle ${scale})`, async () => {
        const items = [
          { id: 'r1', type: 'rect', color: 'red', size: 'l', x: 2, y: trim.y + 100, width: trim.x - 40, height: 100 },
          { id: 'r2', type: 'rect', color: 'blue', size: 'l', x: trim.x + 100, y: 4, width: 100, height: trim.y - 40 },
          { id: 'r3', type: 'badge', color: 'green', size: 'l', x: trim.x + 100, y: trim.y + trim.h + 60 * scale },
        ];
        const bare = await renderReport(page, { id, trim });
        const drawn = await renderReport(page, { id, trim, items });
        return { ok: bare.files[0].hash === drawn.files[0].hash, detail: `${bare.files[0].hash.slice(0, 8)} / ${drawn.files[0].hash.slice(0, 8)}` };
      });
      await test(`rendu : un masque hors cadre n’influence aucun pixel (échelle ${scale})`, async () => {
        const mask = { id: 'm2', type: 'mask', fill: '#000000', x: 0, y: 0, width: trim.x - 1, height: trim.y + trim.h };
        const bare = await renderReport(page, { id, trim });
        const drawn = await renderReport(page, { id, trim, items: [mask] });
        return { ok: bare.files[0].hash === drawn.files[0].hash, detail: `${bare.files[0].hash.slice(0, 8)} / ${drawn.files[0].hash.slice(0, 8)}` };
      });
      await test(`rendu : teinte du masque identique avant et après (échelle ${scale})`, async () => {
        const got = await page.evaluate(
          async ({ id, trim }) => {
            const { getCapture } = await import(chrome.runtime.getURL('lib/db.js'));
            const { Stitcher } = await import(chrome.runtime.getURL('viewer/stitcher.js'));
            const record = await getCapture(id);
            // Masque à cheval sur le bord gauche : son liseré lit le vert de l'extérieur, en coordonnées de capture.
            const rect = { x: trim.x - 20, y: trim.y + 50, width: 60, height: 30 };
            const plain = new Stitcher(record);
            const trimmed = new Stitcher(record, { trim });
            const tints = { plain: await plain.averageRing(rect), trimmed: await trimmed.averageRing(rect) };
            plain.dispose();
            trimmed.dispose();
            return tints;
          },
          { id, trim },
        );
        return { ok: got.plain === got.trimmed && got.plain !== '#ffffff', detail: JSON.stringify(got) };
      });
      await test(`rendu : un aperçu ne montre aucun pixel de l’extérieur, même lissé (échelle ${scale})`, async () => {
        const got = await page.evaluate(
          async ({ id, trim }) => {
            const { getCapture } = await import(chrome.runtime.getURL('lib/db.js'));
            const { Stitcher } = await import(chrome.runtime.getURL('viewer/stitcher.js'));
            const record = await getCapture(id);
            const stitcher = new Stitcher(record, { trim });
            const canvas = document.createElement('canvas');
            canvas.width = 333;
            await stitcher.renderPreview({ top: trim.y, height: 700 }, canvas);
            const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
            let greenish = 0;
            for (let i = 0; i < data.length; i += 4) if (data[i + 1] > data[i] + 12 && data[i + 1] > data[i + 2] + 12) greenish++;
            const full = document.createElement('canvas');
            full.width = 500;
            await stitcher.renderPreview({ top: 0, height: record.height }, full, { overlay: false, full: true });
            const edge = [...full.getContext('2d').getImageData(5, 5, 1, 1).data].slice(0, 3);
            stitcher.dispose();
            return { size: [canvas.width, canvas.height], greenish, edge, fullHeight: full.height, total: Math.round((record.height * 500) / record.width) };
          },
          { id, trim },
        );
        return { ok: got.greenish === 0 && near(got.edge, [0, 255, 0]) && got.fullHeight === got.total, detail: JSON.stringify(got) };
      });
      await test(`rendu : renderPart borne toute partie au cadre (échelle ${scale})`, async () => {
        const wide = await renderReport(page, { id, trim, forcedParts: [{ top: 0, height: 1500 * scale }] });
        const [file] = wide.files;
        const outside = await page.evaluate(
          async ({ id, trim }) => {
            const { getCapture } = await import(chrome.runtime.getURL('lib/db.js'));
            const { Stitcher } = await import(chrome.runtime.getURL('viewer/stitcher.js'));
            const stitcher = new Stitcher(await getCapture(id), { trim });
            const outcome = await stitcher.renderPart({ top: 0, height: trim.y }).then(
              () => 'rendue',
              () => 'refusée',
            );
            stitcher.dispose();
            return outcome;
          },
          { id, trim },
        );
        return { ok: file.width === trim.w && file.height === trim.h && file.sentinel === 0 && outside === 'refusée', detail: `${file.width} × ${file.height}, partie hors cadre ${outside}` };
      });
    }

    await test('rendu : sans cadrage, octets identiques à aujourd’hui (code du lot 1 comparé)', async () => {
      const id = await seedCapture(page, { heightPoints: 2500, scale: 2 });
      const items = [
        { id: 'r1', type: 'rect', color: 'red', size: 'm', x: 100, y: 300, width: 500, height: 200 },
        { id: 'm1', type: 'mask', fill: '#606060', x: 900, y: 1500, width: 300, height: 100 },
        { id: 't1', type: 'text', color: 'blue', size: 'l', x: 400, y: 2600, text: 'Bonjour' },
      ];
      const settings = { id, items, maxHeight: 1400 };
      const old = { stitcherFile: 'viewer/stitcher-lot1.js', renderFile: 'annotate/render-lot1.js' };
      const outcomes = [];
      for (const type of ['image/png', 'image/jpeg']) {
        const before = await renderReport(page, { ...settings, ...old, type });
        const after = await renderReport(page, { ...settings, type });
        const hashes = (report) => report.files.map((file) => file.hash).join();
        outcomes.push(same(before.parts, after.parts) && hashes(before) === hashes(after) && before.files.length > 1);
      }
      return { ok: outcomes.every(Boolean), detail: outcomes.join() };
    });

    await test('rendu : ancienne entrée sans trim, cadre = capture entière', async () => {
      const got = await page.evaluate(async () => {
        const { Stitcher } = await import(chrome.runtime.getURL('viewer/stitcher.js'));
        const stitcher = new Stitcher({ width: 300, height: 200, slices: [], crop: { x: 0, y: 0, w: 300, h: 200 } });
        const before = stitcher.outputSize();
        stitcher.setTrim({ x: 10, y: 20, w: 100, h: 50 });
        const cropped = stitcher.outputSize();
        stitcher.setTrim(null);
        return { before, cropped, after: stitcher.outputSize() };
      });
      const ok = same(got.before, { width: 300, height: 200 }) && same(got.cropped, { width: 100, height: 50 }) && same(got.after, got.before);
      return { ok, detail: JSON.stringify(got) };
    });
  } finally {
    await page.close();
  }
}

// --- Le bouton « Recadrer » ---

const annotateButton = (viewer, index = 0) => viewer.locator('figure.part').nth(index).getByRole('button', { name: 'Annoter', exact: true });
const editorReady = (viewer) => viewer.waitForSelector('#editor[data-ready="true"]', { timeout: 30_000 });
const trimButton = (viewer) => viewer.locator('#editor-trim');
const handle = (viewer, edge) => viewer.locator(`#editor-trim-box [data-edge="${edge}"]`);
const asRect = (text) => {
  if (!text) return null;
  const [x, y, w, h] = text.split(',').map(Number);
  return { x, y, w, h };
};
// Le rectangle en cours de réglage, et le cadrage validé.
const rectOf = async (viewer) => asRect(await viewer.locator('#editor-trim-layer').getAttribute('data-rect'));
const trimOf = async (viewer) => asRect(await viewer.locator('#editor-trim-layer').getAttribute('data-trim'));
const waitTrim = (viewer, text) => viewer.waitForFunction((text) => document.getElementById('editor-trim-layer').dataset.trim === text, text, { timeout: 15_000 });
const scaleOf = (viewer) => viewer.evaluate(() => Number(document.getElementById('editor').dataset.scale));

// Ouvre la page de résultats sur la capture `id` ; toute erreur de page fait échouer.
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

async function inEditor(context, id, run) {
  return withViewer(context, id, async (viewer) => {
    await annotateButton(viewer).click();
    await editorReady(viewer);
    return run(viewer);
  });
}

// Entre dans le mode recadrage : le premier arrêt du clavier est la poignée du haut.
async function startTrim(viewer) {
  await trimButton(viewer).click();
  await viewer.waitForSelector('#editor-trim-box [data-edge="n"]');
}

// Tire le centre d'un élément de (dx, dy) points d'écran.
async function dragBy(viewer, locator, dx, dy) {
  // Une poignée peut être sous le bord de la fenêtre, sous l'en-tête ou sous la barre du recadrage : la zone défile pour l'amener à l'écran.
  const first = await locator.boundingBox();
  const { height } = viewer.viewportSize() ?? { height: await viewer.evaluate(() => innerHeight) };
  const middle = first.y + first.height / 2;
  if (middle < 100 || middle > height - 120) await viewer.evaluate((by) => document.getElementById('editor-scroll').scrollBy(0, by), middle - height / 2);
  const box = await locator.boundingBox();
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await viewer.mouse.move(from.x, from.y);
  await viewer.mouse.down();
  await viewer.mouse.move(from.x + dx, from.y + dy, { steps: 6 });
  await viewer.mouse.up();
}

async function groupBouton(context) {
  console.log('\n— Le bouton « Recadrer »');
  const home = await extensionPage(context, 'viewer/viewer.html');
  await home.waitForSelector('body[data-ready="true"]');
  await resetDb(home);
  const id = await seedCapture(home, { heightPoints: 900 });
  const W = 2560;
  const H = 1800;
  try {
    await test('bouton : placé après « Tout effacer » et avant « Copier l’image », hors des outils', () =>
      inEditor(context, id, async (viewer) => {
        const order = await viewer.evaluate(() => [...document.querySelectorAll('.editor-bar button')].map((el) => el.getAttribute('aria-label') ?? el.textContent.trim()));
        const inTools = await viewer.locator('#editor-tools #editor-trim').count();
        const wanted = ['Terminer', 'Annuler', 'Rétablir', 'Tout effacer', 'Recadrer', 'Copier l’image'];
        return { ok: same(order, wanted) && inTools === 0, detail: order.join(', ') };
      }),
    );

    await test('bouton : poignées aux 4 côtés et 4 coins', () =>
      inEditor(context, id, async (viewer) => {
        await startTrim(viewer);
        const view = await scaleOf(viewer);
        const dragged = {};
        // Chaque poignée déplace ce qu'elle doit, et rien d'autre. On part d'un cadre rentré de partout.
        const start = { x: 200, y: 200, w: 2000, h: 1200 };
        for (const key of ['ArrowRight', 'ArrowDown']) {
          await handle(viewer, 'nw').focus();
          for (let i = 0; i < 20; i++) await viewer.keyboard.press(`Shift+${key}`);
        }
        for (const [edge, key, presses] of [['se', 'ArrowLeft', 36], ['se', 'ArrowUp', 40]]) {
          await handle(viewer, edge).focus();
          for (let i = 0; i < presses; i++) await viewer.keyboard.press(`Shift+${key}`);
        }
        const ready = await rectOf(viewer);
        const edges = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
        const count = await viewer.locator('#editor-trim-box [data-edge]').count();
        const problems = [];
        for (const edge of edges) {
          const before = await rectOf(viewer);
          await dragBy(viewer, handle(viewer, edge), edge.includes('e') ? 20 : -20, edge.includes('s') ? 20 : -20);
          const after = await rectOf(viewer);
          const moved = {
            left: after.x !== before.x,
            top: after.y !== before.y,
            right: after.x + after.w !== before.x + before.w,
            bottom: after.y + after.h !== before.y + before.h,
          };
          const wanted = { left: edge.includes('w'), top: edge.includes('n'), right: edge.includes('e'), bottom: edge.includes('s') };
          if (!same(moved, wanted)) problems.push(`${edge} : ${JSON.stringify(moved)}`);
          dragged[edge] = after;
        }
        const whole = [...Object.values(dragged)].every((rect) => Number.isInteger(rect.x) && Number.isInteger(rect.y) && Number.isInteger(rect.w) && Number.isInteger(rect.h));
        return { ok: count === 8 && same(ready, start) && !problems.length && whole, detail: `${count} poignées, départ ${JSON.stringify(ready)}, échelle ${view.toFixed(3)} ; ${problems.join(' ; ') || 'chacune tire ses bords'}` };
      }),
    );

    await test('bouton : Entrée valide, Échap annule', () =>
      inEditor(context, id, async (viewer) => {
        await startTrim(viewer);
        await viewer.keyboard.press('Shift+ArrowDown');
        const pending = await rectOf(viewer);
        await viewer.keyboard.press('Escape');
        const cancelled = await trimOf(viewer);
        const open = await viewer.locator('#editor').isVisible();
        const leftMode = await viewer.locator('#editor-trim-box [data-edge]').first().isVisible().catch(() => false);
        await startTrim(viewer);
        const restarted = await rectOf(viewer);
        await viewer.keyboard.press('Shift+ArrowDown');
        await viewer.keyboard.press('Enter');
        await waitTrim(viewer, `0,10,${W},${H - 10}`);
        const applied = await trimOf(viewer);
        const focus = await viewer.evaluate(() => document.activeElement.id);
        const ok = same(pending, { x: 0, y: 10, w: W, h: H - 10 }) && cancelled === null && open && !leftMode && same(restarted, { x: 0, y: 0, w: W, h: H }) && same(applied, { x: 0, y: 10, w: W, h: H - 10 }) && focus === 'editor-trim';
        return { ok, detail: `en cours ${JSON.stringify(pending)}, annulé ${cancelled}, repris ${JSON.stringify(restarted)}, validé ${JSON.stringify(applied)}, focus ${focus}` };
      }),
    );

    await test('bouton : Rétablir le cadrage', () =>
      inEditor(context, id, async (viewer) => {
        await startTrim(viewer);
        await viewer.keyboard.press('Shift+ArrowDown');
        await viewer.keyboard.press('Enter');
        await waitTrim(viewer, `0,10,${W},${H - 10}`);
        const shownAfter = await viewer.locator('#editor-trim-reset').isVisible();
        // Hors du mode comme dans le mode.
        await viewer.locator('#editor-trim-reset').click();
        await waitTrim(viewer, '');
        const gone = await viewer.locator('#editor-trim-layer').isVisible();
        await startTrim(viewer);
        await viewer.keyboard.press('Shift+ArrowDown');
        await viewer.keyboard.press('Enter');
        await waitTrim(viewer, `0,10,${W},${H - 10}`);
        await startTrim(viewer);
        await viewer.locator('#editor-trim-reset').click();
        await waitTrim(viewer, '');
        const out = await viewer.locator('#editor-trim-box [data-edge]').first().isVisible().catch(() => false);
        return { ok: shownAfter && !gone && !out, detail: `bouton visible ${shownAfter}, voile restant ${gone}, mode restant ${out}` };
      }),
    );

    await test('bouton : minimum 20 × 20', () =>
      inEditor(context, id, async (viewer) => {
        await startTrim(viewer);
        await dragBy(viewer, handle(viewer, 's'), 0, -3000);
        const short = await rectOf(viewer);
        await dragBy(viewer, handle(viewer, 'e'), -3000, 0);
        const narrow = await rectOf(viewer);
        await handle(viewer, 's').focus();
        for (let i = 0; i < 3; i++) await viewer.keyboard.press('Shift+ArrowUp');
        const keyed = await rectOf(viewer);
        return { ok: short.h === 20 && short.y === 0 && narrow.w === 20 && narrow.x === 0 && keyed.h === 20, detail: JSON.stringify({ short, narrow, keyed }) };
      }),
    );

    await test('bouton : hors image refusé', () =>
      inEditor(context, id, async (viewer) => {
        await startTrim(viewer);
        await dragBy(viewer, handle(viewer, 'w'), -500, 0);
        const left = await rectOf(viewer);
        await dragBy(viewer, handle(viewer, 'n'), 0, -500);
        const top = await rectOf(viewer);
        await dragBy(viewer, handle(viewer, 'nw'), 80, 80);
        await dragBy(viewer, handle(viewer, 'se'), -80, -80);
        // Le cadre entier s'arrête aux bords, sans changer de taille.
        const before = await rectOf(viewer);
        await dragBy(viewer, viewer.locator('#editor-trim-box'), 2000, 2000);
        const moved = await rectOf(viewer);
        const ok = same(left, { x: 0, y: 0, w: W, h: H }) && same(top, left) && moved.w === before.w && moved.h === before.h && moved.x + moved.w === W && moved.y + moved.h === H;
        return { ok, detail: JSON.stringify({ left, top, before, moved }) };
      }),
    );

    await test('bouton : flèches 1 px, 10 px avec ⇧', () =>
      inEditor(context, id, async (viewer) => {
        await startTrim(viewer);
        const first = await viewer.evaluate(() => document.activeElement.dataset.edge);
        await viewer.keyboard.press('ArrowDown');
        const one = await rectOf(viewer);
        await viewer.keyboard.press('Shift+ArrowDown');
        const ten = await rectOf(viewer);
        await handle(viewer, 'w').focus();
        await viewer.keyboard.press('ArrowRight');
        const side = await rectOf(viewer);
        await viewer.locator('#editor-trim-box').focus();
        await viewer.keyboard.press('ArrowRight');
        const whole = await rectOf(viewer);
        const ok = first === 'n' && one.y === 1 && one.h === H - 1 && ten.y === 11 && ten.h === H - 11 && side.x === 1 && side.w === W - 1 && whole.x === 1 && whole.w === W - 1;
        await viewer.keyboard.press('ArrowLeft');
        const back = await rectOf(viewer);
        return { ok: ok && back.x === 0 && back.w === W - 1, detail: JSON.stringify({ first, one, ten, side, whole, back }) };
      }),
    );

    await test('bouton : ⌘Z et ⇧⌘Z', () =>
      inEditor(context, id, async (viewer) => {
        // Une annotation, puis un cadrage : chaque annulation défait l'un puis l'autre.
        await viewer.keyboard.press('r');
        const page = await viewer.locator('#editor-page').boundingBox();
        await viewer.mouse.move(page.x + 200, page.y + 200);
        await viewer.mouse.down();
        await viewer.mouse.move(page.x + 400, page.y + 300, { steps: 5 });
        await viewer.mouse.up();
        const count = () => viewer.evaluate(() => Konva.stages.at(-1).find('Rect').filter((node) => !node.hasName('_anchor') && node.getParent().getClassName() === 'Group').length);
        await viewer.waitForFunction(() => !document.querySelector('.editor-history [aria-label="Annuler"]').disabled);
        await startTrim(viewer);
        await viewer.keyboard.press('Shift+ArrowDown');
        await viewer.keyboard.press('Enter');
        await waitTrim(viewer, `0,10,${W},${H - 10}`);
        const withBoth = await count();
        await viewer.keyboard.press('Meta+z');
        await waitTrim(viewer, '');
        const trimUndone = await count();
        await viewer.keyboard.press('Meta+z');
        await viewer.waitForFunction(() => document.querySelector('.editor-history [aria-label="Annuler"]').disabled);
        const itemUndone = await count();
        await viewer.keyboard.press('Meta+Shift+z');
        await viewer.waitForFunction(() => !document.querySelector('.editor-history [aria-label="Annuler"]').disabled);
        const itemBack = await count();
        await viewer.keyboard.press('Meta+Shift+z');
        await waitTrim(viewer, `0,10,${W},${H - 10}`);
        const ok = withBoth === 1 && trimUndone === 1 && itemUndone === 0 && itemBack === 1;
        return { ok, detail: `annotations : ${withBoth}, ${trimUndone}, ${itemUndone}, ${itemBack} ; cadrage rétabli` };
      }),
    );

    await test('bouton : les 7 outils ne bougent pas', () =>
      inEditor(context, id, async (viewer) => {
        const tools = await viewer.evaluate(() => [...document.querySelectorAll('.editor-group[data-kind="tool"] button')].map((el) => el.title));
        const wanted = ['Flèche (F)', 'Rectangle (R)', 'Surligneur (S)', 'Texte (T)', 'Pastille numérotée (N)', 'Masquer (M)', 'Crayon (C)'];
        return { ok: same(tools, wanted), detail: tools.join(', ') };
      }),
    );

    await test('bouton : pendant le réglage, les lettres d’outil et la marge grise n’agissent pas', () =>
      inEditor(context, id, async (viewer) => {
        const pressed = () => viewer.evaluate(() => document.querySelector('.editor-group[data-kind="tool"] [aria-pressed="true"]').title);
        const before = await pressed();
        await startTrim(viewer);
        await viewer.keyboard.press('r');
        const during = await pressed();
        const page = await viewer.locator('#editor-page').boundingBox();
        await viewer.mouse.move(page.x - 6, page.y + 100);
        await viewer.mouse.down();
        await viewer.mouse.move(page.x - 6, page.y + 300, { steps: 4 });
        await viewer.mouse.up();
        await viewer.keyboard.press('Escape');
        await viewer.waitForTimeout(200);
        const undoable = await viewer.locator('.editor-history [aria-label="Annuler"]').isDisabled();
        return { ok: before === during && undoable, detail: `${before} → ${during}, rien à annuler : ${undoable}` };
      }),
    );

    await test('bouton : Terminer pendant le réglage abandonne le cadre en cours', () =>
      withViewer(context, id, async (viewer) => {
        await annotateButton(viewer).click();
        await editorReady(viewer);
        await startTrim(viewer);
        await viewer.keyboard.press('Shift+ArrowDown');
        await viewer.getByRole('button', { name: 'Terminer', exact: true }).click();
        await viewer.waitForSelector('#editor', { state: 'hidden' });
        await annotateButton(viewer).click();
        await editorReady(viewer);
        const trim = await trimOf(viewer);
        const veil = await viewer.locator('#editor-trim-layer').isVisible();
        return { ok: trim === null && !veil, detail: `cadrage ${trim}, voile ${veil}` };
      }),
    );

    await test('bouton : extérieur voilé et phrase sur l’original', () =>
      inEditor(context, id, async (viewer) => {
        await startTrim(viewer);
        const phrase = await viewer.locator('#editor-trim-note').innerText();
        for (const edge of ['nw']) {
          await handle(viewer, edge).focus();
          for (let i = 0; i < 30; i++) await viewer.keyboard.press('Shift+ArrowDown');
          for (let i = 0; i < 30; i++) await viewer.keyboard.press('Shift+ArrowRight');
        }
        await viewer.keyboard.press('Enter');
        await waitTrim(viewer, `300,300,${W - 300},${H - 300}`);
        const view = await scaleOf(viewer);
        const report = await viewer.evaluate(() => {
          const sides = {};
          for (const el of document.querySelectorAll('.editor-trim-veil')) {
            const box = el.getBoundingClientRect();
            sides[el.dataset.side] = { width: box.width, height: box.height, color: getComputedStyle(el).backgroundColor };
          }
          return { sides, phrase: document.getElementById('editor-trim-note').innerText, stageBelow: getComputedStyle(document.getElementById('editor-trim-layer')).pointerEvents };
        });
        const ok =
          /original reste dans l.historique de l.extension, sur ton ordinateur, jusqu.à suppression/i.test(phrase) &&
          /original reste dans l.historique/i.test(report.phrase) &&
          Math.abs(report.sides.top.height - 300 * view) < 2 &&
          Math.abs(report.sides.left.width - 300 * view) < 2 &&
          report.sides.top.color !== 'rgba(0, 0, 0, 0)' &&
          report.stageBelow === 'none';
        return { ok, detail: JSON.stringify(report).slice(0, 220) };
      }),
    );

    await test('bouton : captures d’écran clair et sombre', () =>
      inEditor(context, id, async (viewer) => {
        await startTrim(viewer);
        await handle(viewer, 'nw').focus();
        for (let i = 0; i < 25; i++) await viewer.keyboard.press('Shift+ArrowDown');
        for (let i = 0; i < 25; i++) await viewer.keyboard.press('Shift+ArrowRight');
        const shots = [];
        for (const scheme of ['light', 'dark']) {
          await viewer.emulateMedia({ colorScheme: scheme });
          const file = path.join(WORK, `recadrer-${scheme}.png`);
          await viewer.screenshot({ path: file });
          shots.push((await fs.stat(file)).size);
        }
        await viewer.emulateMedia({ colorScheme: null });
        return { ok: shots.every((size) => size > 5000), detail: shots.join(' et ') };
      }),
    );
  } finally {
    await home.close();
  }
}

// --- Tous les chemins d'export, les onglets et l'historique ---

const onScreenSplit = (viewer) => viewer.locator('#split [data-key="screen"]').click().then(() => viewer.waitForSelector('body[data-ready="true"]', { timeout: 60_000 }));
const backToMedium = (viewer) => viewer.locator('#split [data-key="medium"]').click().then(() => viewer.waitForSelector('body[data-ready="true"]', { timeout: 60_000 }));

// Décrit une image (octets en base64, ou le presse-papiers si null) : dimensions, pixels « sentinelle », blocs PNG, fin du fichier.
const analyze = (page, base64) =>
  page.evaluate(async (base64) => {
    const blob = base64 === null ? await (await navigator.clipboard.read())[0].getType('image/png') : new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const bitmap = await createImageBitmap(blob);
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    let sentinel = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 1] > data[i] + 40 && data[i + 1] > data[i + 2] + 40) sentinel++;
    const isPng = bytes[0] === 0x89;
    const chunks = [];
    if (isPng) {
      const view = new DataView(bytes.buffer);
      for (let at = 8; at < bytes.length; at += 12 + view.getUint32(at)) chunks.push(String.fromCharCode(...bytes.subarray(at + 4, at + 8)));
    }
    const tail = [...bytes.subarray(-2)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return { width: bitmap.width, height: bitmap.height, sentinel, chunks, clean: (isPng ? chunks.at(-1) === 'IEND' && tail === '6082' : tail === 'ffd9') && !chunks.some((name) => /^(tEXt|zTXt|iTXt|eXIf|tIME)$/.test(name)) };
  }, base64);
const analyzeFile = async (page, file) => analyze(page, (await fs.readFile(file)).toString('base64'));
const fileOk = (info, trim) => info.width === trim.w && info.sentinel === 0 && info.clean;

// Clique ou tape, attend la notification de copie et décrit le presse-papiers.
async function copied(viewer, act) {
  await viewer.evaluate(() => (document.getElementById('toast').hidden = true));
  await act();
  await viewer.waitForFunction(
    () => {
      const toast = document.getElementById('toast');
      return !toast.hidden && /presse-papiers|impossible|recalcule|Valide/.test(toast.textContent);
    },
    null,
    { timeout: 60_000 },
  );
  const message = await viewer.locator('#toast').innerText();
  if (!/presse-papiers/.test(message)) return { refused: message };
  return analyze(viewer, null);
}

async function savedFiles(context, count) {
  const sw = context.serviceWorkers()[0];
  for (let attempt = 0; attempt < 300; attempt++) {
    const downloads = await sw.evaluate(async () => (await chrome.downloads.search({ orderBy: ['startTime'] })).map((d) => ({ file: d.filename, done: d.state === 'complete' })));
    if (downloads.length >= count && downloads.every((d) => d.done)) return downloads.map((d) => d.file);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('téléchargements incomplets');
}

async function downloaded(context, viewer, trigger, count) {
  await context.serviceWorkers()[0].evaluate(() => chrome.downloads.erase({}));
  await viewer.evaluate(() => (document.getElementById('toast').hidden = true));
  await trigger();
  await viewer.waitForFunction(() => /enregistr|impossible|arrêté/.test(document.getElementById('toast').textContent) && !document.getElementById('toast').hidden, null, { timeout: 120_000 });
  return savedFiles(context, count);
}

const partSizes = async (viewer) => (await viewer.locator('figure.part .part-size').allInnerTexts()).map((size) => size.split('×').map((side) => Number(side.replace(/\D/g, ''))));

const editsOf = (page, id) =>
  page.evaluate(async (id) => {
    const { getEdits } = await import(chrome.runtime.getURL('lib/db.js'));
    return getEdits(id);
  }, id);
const putEdits = (page, id, edits) =>
  page.evaluate(
    async ({ id, edits }) => {
      const { saveEdits } = await import(chrome.runtime.getURL('lib/db.js'));
      await saveEdits(id, edits);
    },
    { id, edits },
  );

async function storedWhen(page, id, ready) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const edits = await editsOf(page, id);
    if (ready(edits) || Date.now() > deadline) return edits;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// Règle au clavier le cadre de la capture « sentinelle » (échelle 2) sur son rectangle exact.
async function setSentinelFrame(viewer) {
  await startTrim(viewer);
  const presses = async (edge, key, count) => {
    await handle(viewer, edge).focus();
    for (let i = 0; i < count; i++) await viewer.keyboard.press(`Shift+${key}`);
  };
  await presses('nw', 'ArrowRight', 20);
  await presses('nw', 'ArrowDown', 30);
  await presses('se', 'ArrowLeft', 60);
  await presses('se', 'ArrowUp', 30);
}

// Trace une flèche horizontale, en points d'écran depuis le coin haut gauche de l'image.
async function drawArrow(viewer) {
  await viewer.evaluate(() => {
    document.getElementById('editor-scroll').scrollTop = 0;
  });
  const page = await viewer.locator('#editor-page').boundingBox();
  await viewer.mouse.move(page.x + 200, page.y + 300);
  await viewer.mouse.down();
  await viewer.mouse.move(page.x + 500, page.y + 300, { steps: 5 });
  await viewer.mouse.up();
  return { x: page.x + 350, y: page.y + 300 };
}

const quickTrim = async (viewer, text) => {
  await startTrim(viewer);
  await viewer.keyboard.press('Shift+ArrowDown');
  await viewer.keyboard.press('Enter');
  await waitTrim(viewer, text);
};
const finishEditor = async (viewer) => {
  await viewer.getByRole('button', { name: 'Terminer', exact: true }).click();
  await viewer.waitForSelector('#editor', { state: 'hidden' });
  await viewer.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
};

async function groupChemins(context) {
  console.log('\n— Tous les chemins, les onglets et l’historique');
  const home = await extensionPage(context, 'viewer/viewer.html');
  await home.waitForSelector('body[data-ready="true"]');
  await resetDb(home);
  const scale = 2;
  const trim = frameFor(scale);
  const id = await seedSentinel(home, scale);
  await putEdits(home, id, { items: [], trim });
  const opened = (run) => withViewer(context, id, run);
  try {
    await test('chemin 1 : bouton « Copier l’image » de l’en-tête', () =>
      opened(async (viewer) => {
        const info = await copied(viewer, () => viewer.locator('#copy-current').click());
        return { ok: info.width === trim.w && info.height === trim.h && info.sentinel === 0, detail: JSON.stringify(info) };
      }),
    );
    await test('chemin 2 : ⌘C de la page', () =>
      opened(async (viewer) => {
        const info = await copied(viewer, () => viewer.keyboard.press('Meta+c'));
        return { ok: info.width === trim.w && info.height === trim.h && info.sentinel === 0, detail: JSON.stringify(info) };
      }),
    );
    await test('chemin 3 : clic droit sur l’image affichée', () =>
      opened(async (viewer) => {
        const info = await copied(viewer, async () => {
          await viewer.locator('.sheet').first().click({ button: 'right' });
          await viewer.locator('#image-menu [data-action="copy"]').click();
        });
        const [file] = await downloaded(context, viewer, async () => {
          await viewer.locator('.sheet').first().click({ button: 'right' });
          await viewer.locator('#image-menu [data-action="download"]').click();
        }, 1);
        const saved = await analyzeFile(viewer, file);
        return { ok: info.width === trim.w && info.sentinel === 0 && fileOk(saved, trim), detail: `${JSON.stringify(info)} ; fichier ${JSON.stringify(saved)}` };
      }),
    );
    await test('chemin 4 : téléchargement d’une image', () =>
      opened(async (viewer) => {
        const [file] = await downloaded(context, viewer, () => viewer.locator('.part-save').first().click(), 1);
        const info = await analyzeFile(viewer, file);
        return { ok: fileOk(info, trim) && info.height === trim.h, detail: JSON.stringify(info) };
      }),
    );
    await test('chemin 5 : Tout télécharger', () =>
      opened(async (viewer) => {
        await onScreenSplit(viewer);
        const files = await downloaded(context, viewer, () => viewer.locator('#download-all').click(), 2);
        const infos = [];
        for (const file of files) infos.push(await analyzeFile(viewer, file));
        await backToMedium(viewer);
        const total = infos.reduce((sum, info) => sum + info.height, 0);
        return { ok: infos.length === 2 && infos.every((info) => fileOk(info, trim)) && total === trim.h, detail: JSON.stringify(infos).slice(0, 220) };
      }),
    );
    await test('chemin 6 : PDF', () =>
      opened(async (viewer) => {
        await onScreenSplit(viewer);
        const [file] = await downloaded(context, viewer, async () => {
          await viewer.locator('#export').click();
          await viewer.locator('#export-menu [data-export="pdf"]').click();
        }, 1);
        await backToMedium(viewer);
        const { stdout } = await run('pdfinfo', ['-box', '-f', '1', '-l', '99', file]);
        const pages = [...stdout.matchAll(/Page\s+\d+ MediaBox:\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/g)].map((m) => [Number(m[3]), Number(m[4])]);
        const infos = [];
        for (const [index] of pages.entries()) {
          const prefix = path.join(WORK, `chemin-pdf-${index}`);
          await run('pdftoppm', ['-r', '96', '-f', String(index + 1), '-l', String(index + 1), '-singlefile', '-png', file, prefix]);
          infos.push(await analyzeFile(viewer, `${prefix}.png`));
        }
        const total = pages.reduce((sum, [, height]) => sum + height, 0);
        const ok = pages.length === 2 && pages.every(([width]) => width === trim.w * 0.75) && total === trim.h * 0.75 && infos.every((info) => info.sentinel === 0 && info.width === trim.w);
        return { ok, detail: `${JSON.stringify(pages)} ; sentinelle ${infos.map((info) => info.sentinel).join(',')}` };
      }),
    );
    await test('chemin 7 : zip', () =>
      opened(async (viewer) => {
        await onScreenSplit(viewer);
        const [file] = await downloaded(context, viewer, async () => {
          await viewer.locator('#export').click();
          await viewer.locator('#export-menu [data-export="zip"]').click();
        }, 1);
        await backToMedium(viewer);
        const dir = path.join(WORK, 'chemin-zip');
        await run('unzip', ['-o', '-q', file, '-d', dir]);
        const names = (await fs.readdir(dir)).sort();
        const infos = [];
        for (const name of names) infos.push(await analyzeFile(viewer, path.join(dir, name)));
        const total = infos.reduce((sum, info) => sum + info.height, 0);
        return { ok: names.length === 2 && infos.every((info) => fileOk(info, trim)) && total === trim.h, detail: `${names.join()} ; ${JSON.stringify(infos).slice(0, 180)}` };
      }),
    );
    await test('chemin 8 : aperçus de la page', () =>
      opened(async (viewer) => {
        const got = await viewer.evaluate(() =>
          [...document.querySelectorAll('.sheet canvas')].map((canvas) => {
            const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
            let greenish = 0;
            for (let i = 0; i < data.length; i += 4) if (data[i + 1] > data[i] + 12 && data[i + 1] > data[i + 2] + 12) greenish++;
            return { ratio: canvas.height / canvas.width, greenish };
          }),
        );
        const ok = got.length === 1 && got[0].greenish === 0 && Math.abs(got[0].ratio - trim.h / trim.w) < 0.01;
        return { ok, detail: JSON.stringify(got) };
      }),
    );
    await test('chemin 9 : vignette de l’historique', () =>
      opened(async (viewer) => {
        const selector = `.history-item[data-id="${id}"] .history-thumb`;
        await viewer.waitForFunction((selector) => document.querySelector(selector)?.width > 0 && document.querySelector(selector).getContext('2d').getImageData(10, 10, 1, 1).data[3] > 0, selector, { timeout: 15_000 });
        const got = await viewer.evaluate((selector) => {
          const canvas = document.querySelector(selector);
          const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
          let greenish = 0;
          for (let i = 0; i < data.length; i += 4) if (data[i + 1] > data[i] + 12 && data[i + 1] > data[i + 2] + 12) greenish++;
          return { size: [canvas.width, canvas.height], greenish };
        }, selector);
        return { ok: got.greenish === 0, detail: JSON.stringify(got) };
      }),
    );
    await test('chemin 10 : #editor-copy, cadrage déjà enregistré', () =>
      opened(async (viewer) => {
        await annotateButton(viewer).click();
        await editorReady(viewer);
        const info = await copied(viewer, () => viewer.locator('#editor-copy').click());
        return { ok: info.width === trim.w && info.height === trim.h && info.sentinel === 0, detail: JSON.stringify(info) };
      }),
    );
    await test('chemin 11 : ⌘C dans l’éditeur, cadrage déjà enregistré', () =>
      opened(async (viewer) => {
        await annotateButton(viewer).click();
        await editorReady(viewer);
        const info = await copied(viewer, () => viewer.keyboard.press('Meta+c'));
        return { ok: info.width === trim.w && info.height === trim.h && info.sentinel === 0, detail: JSON.stringify(info) };
      }),
    );

    // Une capture neuve, recadrée à la main dans l'éditeur, sans « Terminer ».
    const fresh = await seedSentinel(home, scale);
    const untilCopied = async (viewer, act) => {
      for (let attempt = 0; attempt < 40; attempt++) {
        const info = await copied(viewer, act);
        if (!info.refused) return info;
        await viewer.waitForTimeout(100);
      }
      throw new Error('copie toujours refusée');
    };
    await test('chemin 10 bis : #editor-copy juste après Entrée, sans Terminer', () =>
      withViewer(context, fresh, async (viewer) => {
        await annotateButton(viewer).click();
        await editorReady(viewer);
        await setSentinelFrame(viewer);
        await viewer.keyboard.press('Enter');
        const info = await untilCopied(viewer, () => viewer.locator('#editor-copy').click());
        await viewer.keyboard.press('Meta+z');
        await waitTrim(viewer, '');
        await storedWhen(home, fresh, (edits) => edits.trim === null);
        return { ok: info.width === trim.w && info.height === trim.h && info.sentinel === 0, detail: JSON.stringify(info) };
      }),
    );
    await test('chemin 11 bis : ⌘C juste après Entrée, sans Terminer', () =>
      withViewer(context, fresh, async (viewer) => {
        await annotateButton(viewer).click();
        await editorReady(viewer);
        await setSentinelFrame(viewer);
        await viewer.keyboard.press('Enter');
        const info = await untilCopied(viewer, () => viewer.keyboard.press('Meta+c'));
        await viewer.keyboard.press('Meta+z');
        await waitTrim(viewer, '');
        await storedWhen(home, fresh, (edits) => edits.trim === null);
        return { ok: info.width === trim.w && info.height === trim.h && info.sentinel === 0, detail: JSON.stringify(info) };
      }),
    );
    await test('copie refusée tant que le calcul des coupes n’est pas fini, puis annulation et rétablissement justes', () =>
      withViewer(context, fresh, async (viewer) => {
        await viewer.evaluate(async () => {
          const { Stitcher } = await import(chrome.runtime.getURL('viewer/stitcher.js'));
          const real = Stitcher.prototype.planParts;
          Stitcher.prototype.planParts = function (...args) {
            return new Promise((resolve) => setTimeout(resolve, 900)).then(() => real.apply(this, args));
          };
        });
        await annotateButton(viewer).click();
        await editorReady(viewer);
        await setSentinelFrame(viewer);
        await viewer.keyboard.press('Enter');
        const refusedKey = await copied(viewer, () => viewer.keyboard.press('Meta+c'));
        const refusedButton = await copied(viewer, () => viewer.locator('#editor-copy').click());
        const framed = await untilCopied(viewer, () => viewer.locator('#editor-copy').click());
        await viewer.keyboard.press('Meta+z');
        const refusedUndo = await copied(viewer, () => viewer.keyboard.press('Meta+c'));
        const whole = await untilCopied(viewer, () => viewer.keyboard.press('Meta+c'));
        await viewer.keyboard.press('Meta+Shift+z');
        const again = await untilCopied(viewer, () => viewer.keyboard.press('Meta+c'));
        await viewer.keyboard.press('Meta+z');
        await waitTrim(viewer, '');
        await storedWhen(home, fresh, (edits) => edits.trim === null);
        const ok =
          /recalcule/.test(refusedKey.refused ?? '') && /recalcule/.test(refusedButton.refused ?? '') && /recalcule/.test(refusedUndo.refused ?? '') &&
          framed.width === trim.w && framed.sentinel === 0 && whole.width === 2000 && whole.sentinel > 0 && again.width === trim.w && again.sentinel === 0;
        return { ok, detail: JSON.stringify({ refusedKey, framed: framed.width, whole: whole.width, again: again.width }) };
      }),
    );
    await test('coupes : recalculées sur la zone recadrée, et transmises à l’éditeur', () =>
      withViewer(context, fresh, async (viewer) => {
        await onScreenSplit(viewer);
        await annotateButton(viewer).click();
        await editorReady(viewer);
        const tops = () => viewer.evaluate(() => [...document.querySelectorAll('.editor-cut')].map((line) => parseFloat(line.style.top)));
        const view = await scaleOf(viewer);
        const before = await tops();
        await setSentinelFrame(viewer);
        await viewer.keyboard.press('Enter');
        await waitTrim(viewer, `${trim.x},${trim.y},${trim.w},${trim.h}`);
        await viewer.waitForFunction((before) => JSON.stringify([...document.querySelectorAll('.editor-cut')].map((line) => parseFloat(line.style.top))) !== JSON.stringify(before), before, { timeout: 10_000 });
        const after = await tops();
        const inside = after.every((top) => top / view > trim.y && top / view < trim.y + trim.h);
        await viewer.keyboard.press('Meta+z');
        await waitTrim(viewer, '');
        await storedWhen(home, fresh, (edits) => edits.trim === null);
        await finishEditor(viewer);
        await backToMedium(viewer);
        return { ok: after.length === 1 && inside, detail: `${before.join()} → ${after.join()} (échelle ${view.toFixed(3)})` };
      }),
    );

    const W = 2560;
    const H = 1800;
    const framed = `0,10,${W},${H - 10}`;
    const TRIMMED = { x: 0, y: 10, w: W, h: H - 10 };

    await test('onglets : export recadré dans un deuxième onglet', async () => {
      const other = await seedSentinel(home, scale);
      return withViewer(context, other, async (first) => {
        const second = await extensionPage(context, `viewer/viewer.html?id=${other}`);
        try {
          await second.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
          await first.bringToFront();
          await annotateButton(first).click();
          await editorReady(first);
          await setSentinelFrame(first);
          await first.keyboard.press('Enter');
          await waitTrim(first, `${trim.x},${trim.y},${trim.w},${trim.h}`);
          await second.bringToFront();
          await second.waitForFunction((w) => document.querySelector('figure.part .part-size')?.textContent.replace(/\D/g, '').startsWith(String(w)), trim.w, { timeout: 15_000 });
          await second.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
          const [file] = await downloaded(context, second, () => second.locator('.part-save').first().click(), 1);
          const info = await analyzeFile(second, file);
          const [[width, height]] = await partSizes(second);
          return { ok: fileOk(info, trim) && width === trim.w && height === trim.h, detail: `${JSON.stringify(info)} ; légende ${width} × ${height}` };
        } finally {
          await second.close();
        }
      });
    });

    await test('recharger : le cadrage revient', async () => {
      const other = await seedCapture(home, { heightPoints: 900 });
      return withViewer(context, other, async (viewer) => {
        await annotateButton(viewer).click();
        await editorReady(viewer);
        await quickTrim(viewer, framed);
        await storedWhen(home, other, (edits) => edits.trim);
        await viewer.reload();
        await viewer.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
        const [[width, height]] = await partSizes(viewer);
        await annotateButton(viewer).click();
        await editorReady(viewer);
        const back = await trimOf(viewer);
        return { ok: width === W && height === H - 10 && same(back, TRIMMED), detail: `${width} × ${height}, ${JSON.stringify(back)}` };
      });
    });

    await test('historique : recadrée, et non annotée', async () => {
      const other = await seedCapture(home, { heightPoints: 900 });
      return withViewer(context, other, async (viewer) => {
        const mention = () => viewer.locator(`.history-item[data-id="${other}"] .history-meta`).innerText();
        const plain = await mention();
        await annotateButton(viewer).click();
        await editorReady(viewer);
        await quickTrim(viewer, framed);
        await viewer.waitForFunction((id) => /recadrée/.test(document.querySelector(`.history-item[data-id="${id}"] .history-meta`).textContent), other, { timeout: 8000 });
        const trimmed = await mention();
        const arrow = await drawArrow(viewer);
        await viewer.waitForFunction((id) => /annotée/.test(document.querySelector(`.history-item[data-id="${id}"] .history-meta`).textContent), other, { timeout: 8000 });
        const annotated = await mention();
        void arrow;
        await viewer.reload();
        await viewer.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
        const reloaded = await mention();
        const ok = !/recadrée|annotée/.test(plain) && /recadrée/.test(trimmed) && !/annotée/.test(trimmed) && /annotée/.test(annotated) && /annotée/.test(reloaded);
        return { ok, detail: JSON.stringify({ plain, trimmed, annotated, reloaded }) };
      });
    });

    await test('suppression : n’annonce ses annotations que s’il y en a', async () => {
      const onlyTrim = await seedCapture(home, { heightPoints: 300 });
      const both = await seedCapture(home, { heightPoints: 300 });
      await putEdits(home, onlyTrim, { items: [], trim: { x: 0, y: 0, w: 100, h: 100 } });
      await putEdits(home, both, { items: [RECT], trim: { x: 0, y: 0, w: 500, h: 500 } });
      return withViewer(context, both, async (viewer) => {
        const asked = async (target) => {
          const dialog = viewer.waitForEvent('dialog');
          const clicking = viewer.locator('#history li').filter({ has: viewer.locator(`.history-item[data-id="${target}"]`) }).getByRole('button', { name: 'Supprimer cette capture', exact: true }).click();
          const shown = await dialog;
          const message = shown.message();
          await shown.dismiss();
          await clicking;
          return message;
        };
        const first = await asked(onlyTrim);
        const second = await asked(both);
        return { ok: !/annotations/.test(first) && /et ses annotations/.test(second), detail: `${first} / ${second}` };
      });
    });

    await test('Tout effacer : actif avec un cadrage seul', async () => {
      const other = await seedCapture(home, { heightPoints: 900 });
      return withViewer(context, other, async (viewer) => {
        await annotateButton(viewer).click();
        await editorReady(viewer);
        const clear = viewer.getByRole('button', { name: 'Tout effacer', exact: true });
        const before = await clear.isDisabled();
        await quickTrim(viewer, framed);
        const after = await clear.isDisabled();
        return { ok: before && !after, detail: `inactif avant : ${before}, inactif après : ${after}` };
      });
    });

    await test('Tout effacer : la question sans cadrage est inchangée', async () => {
      const other = await seedCapture(home, { heightPoints: 900 });
      await putEdits(home, other, { items: [{ ...RECT, x: 500, y: 300 }], trim: null });
      return withViewer(context, other, async (viewer) => {
        await annotateButton(viewer).click();
        await editorReady(viewer);
        const dialog = viewer.waitForEvent('dialog');
        const clicking = viewer.getByRole('button', { name: 'Tout effacer', exact: true }).click();
        const shown = await dialog;
        const message = shown.message();
        await shown.dismiss();
        await clicking;
        return { ok: message === 'Effacer toutes les annotations de cette capture ?', detail: message };
      });
    });

    await test('Tout effacer avec cadrage : question « …annotations et cadrage… », et la capture redevient brute', async () => {
      const other = await seedCapture(home, { heightPoints: 900 });
      const before = await sliceHashes(home, other);
      return withViewer(context, other, async (viewer) => {
        await annotateButton(viewer).click();
        await editorReady(viewer);
        await quickTrim(viewer, framed);
        await drawArrow(viewer);
        await storedWhen(home, other, (edits) => edits.items.length === 1 && edits.trim);
        let message = '';
        viewer.once('dialog', (dialog) => {
          message = dialog.message();
          dialog.accept();
        });
        await viewer.getByRole('button', { name: 'Tout effacer', exact: true }).click();
        await waitTrim(viewer, '');
        const stored = await storedWhen(home, other, (edits) => !edits.items.length && !edits.trim);
        await finishEditor(viewer);
        const [[width, height]] = await partSizes(viewer);
        const after = await sliceHashes(home, other);
        const ok = /annotations et (le )?cadrage/.test(message) && same(stored, { items: [], trim: null }) && width === W && height === H && same(before, after);
        return { ok, detail: `${message} ; ${JSON.stringify(stored)} ; ${width} × ${height} ; tranches identiques ${same(before, after)}` };
      });
    });

    await test('Tout effacer et Rétablir : tranches identiques par hachage', async () => {
      const other = await seedCapture(home, { heightPoints: 900 });
      const before = await sliceHashes(home, other);
      return withViewer(context, other, async (viewer) => {
        await annotateButton(viewer).click();
        await editorReady(viewer);
        await quickTrim(viewer, framed);
        await storedWhen(home, other, (edits) => edits.trim);
        const whileTrimmed = await sliceHashes(home, other);
        await viewer.locator('#editor-trim-reset').click();
        await waitTrim(viewer, '');
        await storedWhen(home, other, (edits) => !edits.trim);
        const afterReset = await sliceHashes(home, other);
        await quickTrim(viewer, framed);
        viewer.once('dialog', (dialog) => dialog.accept());
        await viewer.getByRole('button', { name: 'Tout effacer', exact: true }).click();
        await waitTrim(viewer, '');
        await storedWhen(home, other, (edits) => !edits.trim);
        const afterClear = await sliceHashes(home, other);
        return { ok: same(before, whileTrimmed) && same(before, afterReset) && same(before, afterClear), detail: `${before.length} tranches` };
      });
    });

    await test('réouverture depuis l’historique : le cadrage revient', async () => {
      const a = await seedCapture(home, { heightPoints: 900 });
      const b = await seedCapture(home, { heightPoints: 500 });
      await putEdits(home, a, { items: [], trim: TRIMMED });
      return withViewer(context, b, async (viewer) => {
        const before = await partSizes(viewer);
        await viewer.locator(`.history-item[data-id="${a}"]`).click();
        await viewer.waitForFunction((h) => document.querySelector('figure.part .part-size')?.textContent.replace(/\D/g, '').endsWith(String(h)), H - 10, { timeout: 15_000 });
        await viewer.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
        const after = await partSizes(viewer);
        await annotateButton(viewer).click();
        await editorReady(viewer);
        const back = await trimOf(viewer);
        return { ok: after[0][1] === H - 10 && same(back, TRIMMED), detail: `${JSON.stringify(before)} → ${JSON.stringify(after)}, ${JSON.stringify(back)}` };
      });
    });

    await test('cadrage : recadrer puis annoter le garde après rechargement', async () => {
      const other = await seedCapture(home, { heightPoints: 900 });
      const before = await sliceHashes(home, other);
      return withViewer(context, other, async (viewer) => {
        await annotateButton(viewer).click();
        await editorReady(viewer);
        await quickTrim(viewer, framed);
        await drawArrow(viewer);
        await storedWhen(home, other, (edits) => edits.items.length === 1 && edits.trim);
        await viewer.reload();
        await viewer.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
        const stored = await editsOf(home, other);
        const [[, height]] = await partSizes(viewer);
        const after = await sliceHashes(home, other);
        return { ok: stored.items.length === 1 && same(stored.trim, TRIMMED) && height === H - 10 && same(before, after), detail: `${stored.items.length} annotation, ${JSON.stringify(stored.trim)}, hauteur ${height}` };
      });
    });

    await test('cadrage : recadrer, annoter, annuler l’annotation le garde', async () => {
      const other = await seedCapture(home, { heightPoints: 900 });
      const before = await sliceHashes(home, other);
      return withViewer(context, other, async (viewer) => {
        await annotateButton(viewer).click();
        await editorReady(viewer);
        await quickTrim(viewer, framed);
        await drawArrow(viewer);
        await storedWhen(home, other, (edits) => edits.items.length === 1);
        await viewer.keyboard.press('Meta+z');
        const stored = await storedWhen(home, other, (edits) => !edits.items.length);
        const shown = await trimOf(viewer);
        const after = await sliceHashes(home, other);
        return { ok: !stored.items.length && same(stored.trim, TRIMMED) && same(shown, TRIMMED) && same(before, after), detail: JSON.stringify(stored) };
      });
    });

    await test('cadrage : recadrer, annoter, supprimer la dernière annotation, recharger le garde', async () => {
      const other = await seedCapture(home, { heightPoints: 900 });
      const before = await sliceHashes(home, other);
      return withViewer(context, other, async (viewer) => {
        await annotateButton(viewer).click();
        await editorReady(viewer);
        await quickTrim(viewer, framed);
        const middle = await drawArrow(viewer);
        await storedWhen(home, other, (edits) => edits.items.length === 1);
        await viewer.mouse.click(middle.x, middle.y);
        await viewer.keyboard.press('Backspace');
        const stored = await storedWhen(home, other, (edits) => !edits.items.length);
        await viewer.reload();
        await viewer.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
        const [[, height]] = await partSizes(viewer);
        const mention = await viewer.locator(`.history-item[data-id="${other}"] .history-meta`).innerText();
        const after = await sliceHashes(home, other);
        return { ok: !stored.items.length && same(stored.trim, TRIMMED) && height === H - 10 && /recadrée/.test(mention) && same(before, after), detail: `${JSON.stringify(stored)}, hauteur ${height}, « ${mention} »` };
      });
    });

    await test('ancienne capture : une entrée sans cadrage s’ouvre, s’annote et s’exporte comme avant', async () => {
      const other = await seedCapture(home, { heightPoints: 900 });
      await home.evaluate(
        async ({ id, rect }) => {
          const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open('capture');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          await new Promise((resolve, reject) => {
            const tx = db.transaction('annotations', 'readwrite');
            tx.objectStore('annotations').put({ captureId: id, items: [rect], updatedAt: 1 });
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
          });
          db.close();
        },
        { id: other, rect: RECT },
      );
      return withViewer(context, other, async (viewer) => {
        const [[width, height]] = await partSizes(viewer);
        const mention = await viewer.locator(`.history-item[data-id="${other}"] .history-meta`).innerText();
        await annotateButton(viewer).click();
        await editorReady(viewer);
        const shown = await trimOf(viewer);
        await drawArrow(viewer);
        const stored = await storedWhen(home, other, (edits) => edits.items.length === 2);
        const hasTrimField = await home.evaluate(async (id) => {
          const db = await new Promise((resolve) => {
            const req = indexedDB.open('capture');
            req.onsuccess = () => resolve(req.result);
          });
          const entry = await new Promise((resolve) => {
            const req = db.transaction('annotations').objectStore('annotations').get(id);
            req.onsuccess = () => resolve(req.result);
          });
          db.close();
          return 'trim' in entry;
        }, other);
        return { ok: width === W && height === H && /annotée/.test(mention) && shown === null && stored.items.length === 2 && stored.trim === null && !hasTrimField, detail: `${width} × ${height}, « ${mention} », ${stored.items.length} annotations, champ trim : ${hasTrimField}` };
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
  // Le code de rendu du lot 1, pour vérifier que sans cadrage les fichiers n'ont pas bougé d'un octet.
  for (const [source, copy] of [['viewer/stitcher.js', 'viewer/stitcher-lot1.js'], ['annotate/render.js', 'annotate/render-lot1.js']]) {
    const { stdout } = await run('git', ['show', `lot1-valide:extension/${source}`], { cwd: EXTENSION, maxBuffer: 2 ** 24 });
    await fs.writeFile(path.join(extension, copy), stdout);
  }
  const context = await launch(extension, 'profile', WORK);
  try {
    context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const groups = { stockage: groupStockage, rendu: groupRendu, bouton: groupBouton, chemins: groupChemins };
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
