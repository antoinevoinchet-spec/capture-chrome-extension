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
    const groups = { stockage: groupStockage, rendu: groupRendu };
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
