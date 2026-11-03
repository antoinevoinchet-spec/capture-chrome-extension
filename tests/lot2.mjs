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
    const groups = { stockage: groupStockage, rendu: groupRendu, bouton: groupBouton };
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
