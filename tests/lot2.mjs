// Tests du lot 2 : le recadrage. Stockage du cadrage, rendu de l'image recadrée, bouton « Recadrer », tous les chemins d'export.
// Même Chromium et même extension que les autres suites (écran ×2).
// Usage : node lot2.mjs <dossier de sortie> [stockage|rendu|bouton|chemins] [motif]

import fs from 'node:fs/promises';
import path from 'node:path';
import { EXTENSION, MANIFEST_EXPECTED, check, extensionPage, launch, prepareExtension, results, seedCapture } from './lib.mjs';

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

async function main() {
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(WORK, { recursive: true });
  const extension = await prepareExtension(WORK);
  const context = await launch(extension, 'profile', WORK);
  try {
    context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const groups = { stockage: groupStockage };
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
