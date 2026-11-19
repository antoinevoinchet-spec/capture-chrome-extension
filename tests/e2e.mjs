// Test de bout en bout : charge l'extension dans le Chromium de Playwright (écran ×2 comme un Retina),
// capture des pages piégeuses et vérifie les images produites pixel par pixel.
// Usage : node e2e.mjs <dossier de sortie> [fidelite]
// « fidelite » ne lance que les vérifications de fidélité à la page (référence, barres, liste virtuelle, styles rendus).

import fs from 'node:fs/promises';
import path from 'node:path';
import { EXTENSION, capture, check, copyAndRead, launch, openTab, partAction, prepareExtension, results, serve } from './lib.mjs';

const HERE = import.meta.dirname;
const WORK = path.resolve(process.argv[2] ?? path.join(HERE, 'out'));
const ONLY = process.argv[3];

const MAGENTA = [255, 0, 170];
const CYAN = [0, 204, 255];
const GRAY = [204, 204, 204];
const GREEN = [34, 170, 68];
const PANEL_YELLOW = [255, 216, 77];
// Hauteur d'un morceau de l'image de référence, en points.
const REFERENCE_TILE = 4000;

// Analyse dans la page des captures : couleurs le long de colonnes de pixels, parties et coupes.
async function analyze(viewer, { splitPoints, columns, colors, exportDir }) {
  const data = await viewer.evaluate(
    async ({ splitPoints, columns, colors }) => {
      const { getCapture } = await import(chrome.runtime.getURL('lib/db.js'));
      const { Stitcher } = await import(chrome.runtime.getURL('viewer/stitcher.js'));
      const rec = await getCapture(new URLSearchParams(location.search).get('id'));
      const st = new Stitcher(rec);

      const runs = {};
      for (const col of Object.keys(columns)) for (const c of Object.keys(colors)) runs[`${col}:${c}`] = [];
      const open = {};
      const BAND = 4000;
      for (let top = 0; top < rec.height; top += BAND) {
        const h = Math.min(BAND, rec.height - top);
        const canvas = new OffscreenCanvas(rec.width, h);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        await st.enqueue(() => st.draw(ctx, top, h));
        for (const [col, x] of Object.entries(columns)) {
          const px = ctx.getImageData(Math.round(x * rec.scale), 0, 1, h).data;
          for (let i = 0; i < h; i++) {
            for (const [c, rgb] of Object.entries(colors)) {
              const key = `${col}:${c}`;
              const hit =
                Math.abs(px[i * 4] - rgb[0]) < 14 && Math.abs(px[i * 4 + 1] - rgb[1]) < 14 && Math.abs(px[i * 4 + 2] - rgb[2]) < 14;
              if (hit && open[key] === undefined) open[key] = top + i;
              if (!hit && open[key] !== undefined) {
                runs[key].push([open[key], top + i]);
                delete open[key];
              }
            }
          }
        }
      }
      for (const [key, start] of Object.entries(open)) runs[key].push([start, rec.height]);

      const parts = await st.planParts(splitPoints * rec.scale);
      // Netteté d'une coupe : nombre de transitions de couleur sur les deux lignes qui la bordent.
      const cutScores = [];
      for (const part of parts.slice(1)) {
        const canvas = new OffscreenCanvas(rec.width, 2);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        await st.enqueue(() => st.draw(ctx, part.top - 1, 2));
        const px = ctx.getImageData(0, 0, rec.width, 2).data;
        let edges = 0;
        for (let row = 0; row < 2; row++) {
          for (let x = 1; x < rec.width; x++) {
            const i = (row * rec.width + x) * 4;
            const d = Math.abs(px[i] - px[i - 4]) + Math.abs(px[i + 1] - px[i - 3]) + Math.abs(px[i + 2] - px[i - 2]);
            if (d > 30) edges++;
          }
        }
        cutScores.push(edges);
      }

      const images = [];
      for (const part of parts) {
        const blob = await st.renderPart(part, 'image/png');
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        images.push(btoa(bin));
      }
      st.dispose();
      const { slices, ...meta } = rec;
      return { meta: { ...meta, sliceCount: slices.length }, runs, parts, cutScores, images };
    },
    { splitPoints, columns, colors },
  );
  await fs.mkdir(exportDir, { recursive: true });
  for (const [i, b64] of data.images.entries()) {
    await fs.writeFile(path.join(exportDir, `image-${String(i + 1).padStart(2, '0')}.png`), Buffer.from(b64, 'base64'));
  }
  delete data.images;
  return data;
}

async function testLongPage(context, sw, url) {
  console.log('\n— Page longue (défilement de la fenêtre, ×2)');
  const { page, tabId } = await openTab(context, sw, url);
  await page.evaluate(() => window.scrollTo(0, 1234));
  const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const lazyCount = await page.evaluate(() => document.querySelectorAll('.lazy').length);
  const { viewer, seconds, error } = await capture(context, sw, tabId, 'full');
  check('capture terminée', !error, error ?? `${seconds} s`);
  if (error) return;

  const a = await analyze(viewer, {
    splitPoints: 4000,
    columns: { edge: 10, center: 640 },
    colors: { magenta: MAGENTA, cyan: CYAN, gray: GRAY, green: GREEN },
    exportDir: path.join(WORK, 'long'),
  });
  const { meta, runs, parts, cutScores } = a;
  check('pleine résolution (×2, aucune réduction)', meta.scale === 2, `échelle ${meta.scale}`);
  check('largeur = 1280 points × 2', meta.width === 2560, `${meta.width} px`);
  check('hauteur = page entière × 2', Math.abs(meta.height - pageHeight * 2) <= 2, `${meta.height} px pour ${pageHeight} points`);
  check('en-tête collant présent une seule fois', runs['edge:magenta'].length === 1 && runs['edge:magenta'][0][0] === 0, JSON.stringify(runs['edge:magenta']));
  check('bandeau fixé en bas masqué (ne cache pas le texte)', runs['edge:cyan'].length === 0, JSON.stringify(runs['edge:cyan']));
  // Seules les grandes zones grises comptent : le lissage du texte produit aussi des pixels gris isolés.
  const placeholders = runs['center:gray'].filter(([start, end]) => end - start > 50);
  check('images différées toutes chargées', placeholders.length === 0 && runs['center:green'].length === lazyCount, `${runs['center:green'].length} vertes / ${lazyCount}, ${placeholders.length} blocs gris`);
  const heights = parts.map((p) => p.height);
  check('découpe en plusieurs images ≤ 8 000 px', parts.length > 1 && heights.every((h) => h <= 8000), heights.join(', '));
  check('les images se suivent sans trou ni doublon', parts.every((p, i) => i === 0 || p.top === parts[i - 1].top + parts[i - 1].height) && parts.at(-1).top + parts.at(-1).height === meta.height);
  check('coupes dans des interlignes vides', cutScores.every((s) => s <= 4), cutScores.join(', '));

  const after = await page.evaluate(() => ({
    y: window.scrollY,
    header: getComputedStyle(document.querySelector('header')).opacity,
    leftover: [...document.querySelectorAll('style')].some((s) => s.textContent.includes('scrollbar-width: none')),
  }));
  check('page remise en état après la capture', after.y === 1234 && after.header === '1' && !after.leftover, JSON.stringify(after));

  await viewer.screenshot({ path: path.join(WORK, 'viewer-long.png') });

  // Interface : changer le découpage recalcule les images sans nouvelle capture.
  await viewer.getByRole('button', { name: 'Long', exact: true }).click();
  await viewer.waitForSelector('body[data-ready="true"]');
  const longCount = await viewer.locator('figure.part').count();
  await viewer.getByRole('button', { name: '1 écran', exact: true }).click();
  await viewer.waitForSelector('body[data-ready="true"]');
  const screenCount = await viewer.locator('figure.part').count();
  check('changer le découpage recalcule les images', longCount < parts.length && screenCount > parts.length, `long ${longCount}, moyen ${parts.length}, 1 écran ${screenCount}`);

  await viewer.getByRole('button', { name: 'Moyen', exact: true }).click();
  await viewer.waitForSelector('body[data-ready="true"]');

  await viewer.bringToFront();
  const header = viewer.locator('#copy-current');
  const label1 = (await header.innerText()).trim();
  const first = await copyAndRead(viewer, header);
  check(
    'bouton « Copier l’image » de l’en-tête : image 1 copiée et annoncée',
    /image 1$/.test(label1) && first.size === `2560 × ${parts[0].height}` && /copiée dans le presse-papiers/.test(first.message),
    `${label1} → « ${first.message} » / ${first.size}`,
  );
  await viewer.screenshot({ path: path.join(WORK, 'viewer-copy.png') });

  await viewer.evaluate(() => document.querySelectorAll('figure.part')[2].scrollIntoView({ block: 'start' }));
  await viewer
    .waitForFunction(() => /image 3$/.test(document.getElementById('copy-current').textContent.trim()), null, { timeout: 5000 })
    .catch(() => {});
  const label3 = (await header.innerText()).trim();
  const third = await copyAndRead(viewer, header);
  check('le bouton suit le défilement : image 3 copiée', /image 3$/.test(label3) && third.size === `2560 × ${parts[2].height}`, `${label3} → ${third.size}`);

  const second = await copyAndRead(viewer, partAction(viewer, 1, 'copy'));
  check('bouton « Copier » posé sur une image (image 2)', second.size === `2560 × ${parts[1].height}`, `« ${second.message} » / ${second.size}`);

  await viewer.locator('figure.part').nth(3).locator('canvas').click({ button: 'right' });
  await viewer.screenshot({ path: path.join(WORK, 'viewer-menu.png') });
  const viaMenu = await copyAndRead(viewer, viewer.getByRole('menuitem', { name: 'Copier l’image en pleine résolution' }));
  check(
    'clic droit sur l’image 4 : copie en pleine résolution annoncée',
    viaMenu.size === `2560 × ${parts[3].height}` && /Image 4 copiée dans le presse-papiers/.test(viaMenu.message),
    `« ${viaMenu.message} » / ${viaMenu.size}`,
  );

  await viewer.evaluate(() => document.querySelectorAll('figure.part')[4].scrollIntoView({ block: 'start' }));
  await viewer
    .waitForFunction(() => /image 5$/.test(document.getElementById('copy-current').textContent.trim()), null, { timeout: 5000 })
    .catch(() => {});
  const viaKeys = await copyAndRead(viewer, { click: () => viewer.keyboard.press('Meta+c') });
  check(
    '⌘C copie l’image affichée (image 5) et l’annonce',
    viaKeys.size === `2560 × ${parts[4].height}` && /Image 5 copiée dans le presse-papiers/.test(viaKeys.message),
    `« ${viaKeys.message} » / ${viaKeys.size}`,
  );

  await viewer.getByRole('button', { name: 'JPG', exact: true }).click();
  await viewer.locator('#download-all').click();
  await viewer.waitForFunction(() => /enregistr|impossible/.test(document.getElementById('toast').textContent), null, {
    timeout: 120_000,
  });
  const toastText = await viewer.locator('#toast').innerText();
  const downloads = await sw.evaluate(async () =>
    (await chrome.downloads.search({ orderBy: ['-startTime'] })).map((d) => ({ name: d.filename, state: d.state, mime: d.mime })),
  );
  check('« Tout télécharger » lance un téléchargement par image', downloads.length === parts.length, `${downloads.length} téléchargements, message : ${toastText.split('\n')[0]}`);
  await page.close();
  await viewer.close();
}

async function testTabSwitch(context, sw, url, otherUrl) {
  console.log('\n— Changement d’onglet pendant la capture (cas d’erreur)');
  const other = await context.newPage();
  await other.goto(otherUrl);
  const { page, tabId } = await openTab(context, sw, url);
  const running = capture(context, sw, tabId, 'full');
  await page.waitForTimeout(6000);
  await other.bringToFront();
  const { id, error } = await running;
  check('capture arrêtée avec un message clair', !id && /onglet a changé/.test(error ?? ''), error);
  const after = await page.evaluate(() => ({
    leftover: [...document.querySelectorAll('style')].some((s) => s.textContent.includes('scrollbar-width: none')),
    header: getComputedStyle(document.querySelector('header')).opacity,
  }));
  check('page remise en état malgré l’arrêt', !after.leftover && after.header === '1', JSON.stringify(after));
  await other.close();
  await page.close();
}

async function testAppPage(context, sw, url) {
  console.log('\n— Application (seul un bloc défile, comme une messagerie web)');
  const { page, tabId } = await openTab(context, sw, url);
  const geom = await page.evaluate(() => {
    const s = document.getElementById('scroller');
    return { width: s.clientWidth, height: s.scrollHeight };
  });
  const { viewer, seconds, error } = await capture(context, sw, tabId, 'full');
  check('capture terminée', !error, error ?? `${seconds} s`);
  if (error) return;
  const { meta, runs, parts } = await analyze(viewer, {
    splitPoints: 4000,
    columns: { edge: 250 },
    colors: { magenta: MAGENTA },
    exportDir: path.join(WORK, 'app'),
  });
  check('bloc défilant détecté', meta.scroller === 'element', meta.scroller);
  check('largeur = celle du bloc × 2', meta.width === geom.width * 2, `${meta.width} px pour ${geom.width} points`);
  check('hauteur = tout le contenu du bloc × 2', Math.abs(meta.height - geom.height * 2) <= 2, `${meta.height} px pour ${geom.height} points`);
  check('titre collant du bloc présent une seule fois', runs['edge:magenta'].length === 1, JSON.stringify(runs['edge:magenta']));
  check('découpe en plusieurs images', parts.length > 1, `${parts.length} images`);
  await viewer.screenshot({ path: path.join(WORK, 'viewer-app.png') });
  await page.close();
  await viewer.close();
}

async function testJsHeader(context, sw, url) {
  console.log('\n— En-tête rendu fixe par le site pendant le défilement');
  const { page, tabId } = await openTab(context, sw, url);
  const { viewer, seconds, error } = await capture(context, sw, tabId, 'full');
  check('capture terminée', !error, error ?? `${seconds} s`);
  if (error) return;
  const { runs } = await analyze(viewer, {
    splitPoints: 4000,
    columns: { edge: 10 },
    colors: { magenta: MAGENTA },
    exportDir: path.join(WORK, 'js-header'),
  });
  check('en-tête présent une seule fois, en haut', runs['edge:magenta'].length === 1 && runs['edge:magenta'][0][0] === 0, JSON.stringify(runs['edge:magenta']));
  await page.close();
  await viewer.close();
}

// Le panneau ne défile pas : pris sur la première tranche, il est ensuite masqué pour ne pas se répéter. La dernière tranche, calée sur
// le bas de la page, chevauche la première : elle ne doit pas l'effacer.
async function testSidePanel(context, sw, base) {
  const cases = [
    { label: 'fixe', query: 'mode=fixed' },
    { label: 'collant', query: 'mode=sticky' },
    { label: 'collant, sous un en-tête qui défile', query: 'mode=sticky&head=80', head: 80 },
    { label: 'collant, sous un en-tête qui défile, page longue', query: 'mode=sticky&head=80&form=3400', head: 80, form: 3400 },
    { label: 'fixe, avec un pied lui aussi fixe', query: 'mode=fixed&foot=fixed&form=3400', form: 3400 },
  ];
  for (const [index, { label, query, head = 0, form = 1100 }] of cases.entries()) {
    console.log(`\n— Panneau latéral figé (${label})`);
    const { page, tabId } = await openTab(context, sw, `${base}/side-panel.html?${query}`);
    const screen = (await page.evaluate(() => innerHeight)) * 2;
    const { viewer, seconds, error } = await capture(context, sw, tabId, 'full');
    check('capture terminée', !error, error ?? `${seconds} s`);
    if (error) {
      await page.close();
      continue;
    }
    const { runs, meta } = await analyze(viewer, {
      splitPoints: 4000,
      columns: { form: 100, panel: 1000 },
      colors: { magenta: MAGENTA, yellow: PANEL_YELLOW, green: GREEN, cyan: CYAN },
      exportDir: path.join(WORK, `side-panel-${index}`),
    });
    const top = head * 2;
    const height = (head + form) * 2;
    const whole = [runs['panel:magenta'], runs['panel:yellow'], runs['panel:green']].map((run) => JSON.stringify(run)).join(' ');
    check('panneau entier, tel qu’à l’écran', whole === `[[${top},${top + 120}]] [[${top + 120},${top + screen - 120}]] [[${top + screen - 120},${top + screen}]]`, whole);
    check('fin du formulaire capturée', meta.height === height && JSON.stringify(runs['form:cyan']) === `[[${height - 80},${height}]]`, `${meta.height} px, ${JSON.stringify(runs['form:cyan'])}`);
    await page.close();
    await viewer.close();
  }
}

// Lit l'image entière d'une capture de coded-rows.html : rangées fausses (cachées, répétées, décalées), bandes de couleur de l'en-tête et de la barre.
function codedRowsReport(viewer, { rowsTop, rowsHeight }) {
  return viewer.evaluate(
    async ({ rowsTop, rowsHeight }) => {
      const { getCapture } = await import(chrome.runtime.getURL('lib/db.js'));
      const { Stitcher } = await import(chrome.runtime.getURL('viewer/stitcher.js'));
      const rec = await getCapture(new URLSearchParams(location.search).get('id'));
      const stitcher = new Stitcher(rec);
      const ctx = new OffscreenCanvas(rec.width, rec.height).getContext('2d', { willReadFrequently: true });
      await stitcher.enqueue(() => stitcher.draw(ctx, 0, rec.height));
      stitcher.dispose();
      const px = ctx.getImageData(2000, 0, 1, rec.height).data;
      const near = (y, rgb) => rgb.every((value, channel) => Math.abs(px[y * 4 + channel] - value) < 6);
      let wrong = 0;
      for (let y = rowsTop; y < Math.min(rowsTop + rowsHeight, rec.height); y++) {
        const k = Math.floor((y - rowsTop) / 8);
        if (!near(y, [(k * 37) % 256, (k * 91) % 256, (k * 13 + 128) % 256])) wrong++;
      }
      // Une rangée codée ne fait que 8 pixels : seule une vraie bande de couleur dépasse 20 pixels d'affilée.
      const bands = (rgb) => {
        const found = [];
        let start = null;
        for (let y = 0; y <= rec.height; y++) {
          const hit = y < rec.height && near(y, rgb);
          if (hit && start === null) start = y;
          if (!hit && start !== null) {
            if (y - start >= 20) found.push([start, y]);
            start = null;
          }
        }
        return JSON.stringify(found);
      };
      return { height: rec.height, slices: rec.slices.length, wrong, head: bands([255, 0, 170]), bar: bands([0, 204, 255]) };
    },
    { rowsTop, rowsHeight },
  );
}

// Le contenu reste entier sous ce qui reste à l'écran : une barre collante retrouve sa place, un tiroir ou une barre fixes restent hors de l'image.
async function testCodedRows(context, sw, base) {
  console.log('\n— Barres et tiroirs du bas, rangée par rangée');
  const probe = await openTab(context, sw, `${base}/coded-rows.html?total=500`);
  const H = await probe.page.evaluate(() => innerHeight);
  await probe.page.close();
  const rowsPx = (points) => Math.ceil(points / 4) * 8;
  const cases = [
    { label: 'barre collante, 2 écrans', query: `total=${H + 300}&bar=sticky&barH=50`, rows: rowsPx(H + 300), bar: `[[${rowsPx(H + 300)},${rowsPx(H + 300) + 100}]]` },
    { label: 'barre collante, 3 écrans', query: `total=${2 * H + 300}&bar=sticky&barH=50`, rows: rowsPx(2 * H + 300), bar: `[[${rowsPx(2 * H + 300)},${rowsPx(2 * H + 300) + 100}]]` },
    // Ce que le premier écran montre reste sur l'image : un grand élément fixe y cache ce qu'il cache à l'écran, et pas plus.
    { label: 'grand tiroir fixe, 2 écrans', query: `total=${H + 300}&bar=fixed&barH=500`, rows: rowsPx(H + 300), covered: 1000, bar: `[[${2 * H - 1000},${2 * H}]]` },
    { label: 'barre fixe, 2 écrans', query: `total=${H + 300}&bar=fixed&barH=50`, rows: rowsPx(H + 300), bar: '[]' },
    { label: 'en-tête collant, 2 écrans', query: `total=${H + 300}&head=sticky`, rows: rowsPx(H + 240), top: 120, head: '[[0,120]]', bar: '[]' },
  ];
  for (const { label, query, rows, top = 0, head = '[]', bar, covered = 0 } of cases) {
    const { page, tabId } = await openTab(context, sw, `${base}/coded-rows.html?${query}`);
    const { viewer, error } = await capture(context, sw, tabId, 'full');
    if (error) {
      check(label, false, error);
      await page.close();
      continue;
    }
    const report = await codedRowsReport(viewer, { rowsTop: top, rowsHeight: rows });
    check(label, report.wrong === covered && report.head === head && report.bar === bar, `${report.slices} tranches, ${report.height} px, rangées fausses ${report.wrong}, en-tête ${report.head}, barre ${report.bar}`);
    await page.close();
    await viewer.close();
  }

  // Une page d'un seul écran ne recolle rien : un grand élément fixe y reste, comme à l'écran.
  const { page, tabId } = await openTab(context, sw, `${base}/coded-rows.html?total=500&bar=fixed&barH=500`);
  const { viewer, error } = await capture(context, sw, tabId, 'full');
  if (error) {
    check('un seul écran : le grand élément fixe reste', false, error);
  } else {
    const report = await codedRowsReport(viewer, { rowsTop: 0, rowsHeight: 0 });
    check('un seul écran : le grand élément fixe reste', report.bar === `[[${2 * H - 1000},${2 * H}]]`, `barre ${report.bar}`);
    await viewer.close();
  }
  await page.close();
}

// Des titres de section collants : chacun reste à sa place, aucun ne disparaît.
async function testStickyTitles(context, sw, url) {
  console.log('\n— Titres de section collants');
  const { page, tabId } = await openTab(context, sw, url);
  const { viewer, error } = await capture(context, sw, tabId, 'full');
  if (error) {
    check('capture terminée', false, error);
    await page.close();
    return;
  }
  const { runs } = await analyze(viewer, { splitPoints: 4000, columns: { title: 100 }, colors: { magenta: MAGENTA }, exportDir: path.join(WORK, 'sticky-titles') });
  const expected = Array.from({ length: 10 }, (_, k) => [k * 1200, k * 1200 + 80]);
  check('les 10 titres présents, chacun à sa place', JSON.stringify(runs['title:magenta']) === JSON.stringify(expected), JSON.stringify(runs['title:magenta']));
  await page.close();
  await viewer.close();
}

// Des colonnes figées, comme dans un tableau : elles gardent leur place, et la page retrouve ensuite exactement ses réglages.
async function testFrozenColumns(context, sw, url) {
  console.log('\n— Colonnes figées');
  const { page, tabId } = await openTab(context, sw, url);
  const { viewer, error } = await capture(context, sw, tabId, 'full');
  if (error) {
    check('capture terminée', false, error);
    await page.close();
    return;
  }
  const { runs, meta } = await analyze(viewer, {
    splitPoints: 4000,
    columns: { first: 50, second: 150, rest: 400 },
    colors: { magenta: MAGENTA, cyan: CYAN },
    exportDir: path.join(WORK, 'frozen-columns'),
  });
  const full = JSON.stringify([[0, meta.height]]);
  check(
    'colonnes figées à leur place, sur toute la hauteur',
    JSON.stringify(runs['first:cyan']) === full && JSON.stringify(runs['second:magenta']) === full && JSON.stringify(runs['rest:magenta']) === '[]',
    `1re ${JSON.stringify(runs['first:cyan'])}, 2e ${JSON.stringify(runs['second:magenta'])}, à droite ${JSON.stringify(runs['rest:magenta'])}`,
  );
  const after = await page.evaluate(() => {
    const el = document.querySelector('.second');
    return { computed: getComputedStyle(el).position, attribute: el.getAttribute('style') };
  });
  check('la page retrouve ses réglages après la capture', after.computed === 'sticky' && after.attribute === 'left: 120px; top: 5px;', JSON.stringify(after));
  await page.close();
  await viewer.close();
}

// Référence : Chrome dessine lui-même la page entière d'un seul coup, sans défilement ni recollage. Plus fiable que la capture pour dire
// ce que montre la page : seule manque une méthode utilisable au quotidien (elle demande la permission de débogage et une barre à l'écran).
async function referenceImage(context, page) {
  await page.bringToFront();
  const session = await context.newCDPSession(page);
  const { cssContentSize: { width, height } } = await session.send('Page.getLayoutMetrics');
  // Par morceaux : d'un seul coup, Chrome ne dessine rien au-delà de 16 384 pixels.
  const tiles = [];
  for (let y = 0; y < height; y += REFERENCE_TILE) {
    const clip = { x: 0, y, width, height: Math.min(REFERENCE_TILE, height - y), scale: 1 };
    const { data } = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true, clip });
    tiles.push({ y, data });
  }
  await session.detach();
  return { width: width * 2, height: height * 2, tiles };
}

// Compare l'image recollée à la référence, pixel par pixel. `ignore` et `hidden` : zones écartées, en points, où la capture diffère volontairement ;
// `hidden` doit en plus ne rien montrer de la carte rose.
async function compareWithReference(viewer, { reference, ignore, hidden }) {
  const total = { wrong: 0, card: 0, box: null, size: '' };
  for (const { y, data } of reference.tiles) {
    const one = await viewer.evaluate(
      async ({ y, data, fullWidth, fullHeight, ignore, hidden }) => {
        const { getCapture } = await import(chrome.runtime.getURL('lib/db.js'));
        const { Stitcher } = await import(chrome.runtime.getURL('viewer/stitcher.js'));
        const rec = await getCapture(new URLSearchParams(location.search).get('id'));
        const size = `${rec.width}×${rec.height}, référence ${fullWidth}×${fullHeight}`;
        if (fullWidth !== rec.width || fullHeight !== rec.height) return { size, wrong: -1, box: null, card: 0 };
        const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const toPixels = ({ x = 0, y, w = rec.width / rec.scale, h }) => ({ x0: x * rec.scale, y0: y * rec.scale, x1: (x + w) * rec.scale, y1: (y + h) * rec.scale });
        const skipped = [...ignore, ...hidden].map(toPixels);
        const cards = hidden.map(toPixels);
        const inside = (rects, px, py) => rects.some((r) => px >= r.x0 && px < r.x1 && py >= r.y0 && py < r.y1);
        const stitcher = new Stitcher(rec);
        const top = y * rec.scale;
        const { width, height } = bitmap;
        const mine = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
        await stitcher.enqueue(() => stitcher.draw(mine, top, height));
        const theirs = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
        theirs.drawImage(bitmap, 0, 0);
        const a = mine.getImageData(0, 0, width, height).data;
        const b = theirs.getImageData(0, 0, width, height).data;
        let wrong = 0;
        let card = 0;
        let box = null;
        for (let row = 0; row < height; row++) {
          for (let x = 0; x < width; x++) {
            const i = (row * width + x) * 4;
            const py = top + row;
            if (cards.length && a[i] > 200 && a[i + 1] < 40 && a[i + 2] > 130 && a[i + 2] < 210 && inside(cards, x, py)) card++;
            if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) <= 24) continue;
            if (skipped.length && inside(skipped, x, py)) continue;
            wrong++;
            box = box ? [Math.min(box[0], x), Math.min(box[1], py), Math.max(box[2], x), Math.max(box[3], py)] : [x, py, x, py];
          }
        }
        stitcher.dispose();
        bitmap.close();
        return { size, wrong, box, card };
      },
      { y, data, fullWidth: reference.width, fullHeight: reference.height, ignore, hidden },
    );
    total.size = one.size;
    if (one.wrong < 0) return one;
    total.wrong += one.wrong;
    total.card += one.card;
    if (one.box) total.box = total.box ? [Math.min(total.box[0], one.box[0]), Math.min(total.box[1], one.box[1]), Math.max(total.box[2], one.box[2]), Math.max(total.box[3], one.box[3])] : one.box;
  }
  return total;
}

// Chaque page d'essai comparée à la référence : la justesse ne dépend plus de ce que chaque test a pensé à regarder.
async function testAgainstReference(context, sw, base) {
  console.log('\n— Fidélité à la page : comparaison à la référence');
  const probe = await openTab(context, sw, `${base}/coded-rows.html?total=500`);
  const H = await probe.page.evaluate(() => innerHeight);
  await probe.page.close();
  const card = { x: 960, y: H - 140, w: 300, h: 120 };
  const rowsEnd = Math.ceil(1113 / 4) * 4;
  const cases = [
    { label: 'panneau collant', url: 'side-panel.html?mode=sticky' },
    { label: 'panneau fixe', url: 'side-panel.html?mode=fixed' },
    { label: 'panneau collant sous un en-tête', url: 'side-panel.html?mode=sticky&head=80' },
    { label: 'panneau collant sous un en-tête, page longue', url: 'side-panel.html?mode=sticky&head=80&form=3400' },
    { label: 'panneau fixe et son pied fixe', url: 'side-panel.html?mode=fixed&foot=fixed&form=3400' },
    { label: 'panneau à défilement propre, collant', url: 'panel-own-scroll.html' },
    { label: 'panneau à défilement propre, fixe', url: 'panel-own-scroll.html?mode=fixed' },
    { label: 'petit bloc : en-tête et pied collants', url: 'inner-blocks.html?v=0' },
    { label: 'petit bloc déjà défilé', url: 'inner-blocks.html?v=400' },
    { label: 'tableau large : colonnes figées', url: 'inner-blocks.html?h=0' },
    { label: 'tableau large déjà défilé', url: 'inner-blocks.html?h=600' },
    { label: 'titres de section collants', url: 'sticky-titles.html' },
    { label: 'colonnes figées dans la page', url: 'frozen-columns.html' },
    { label: 'en-tête collant', url: 'coded-rows.html?total=1113&head=sticky' },
    { label: 'en-tête fixe', url: 'fixed-cases.html?k=header' },
    { label: 'contenu principal fixe', url: 'fixed-cases.html?k=mainfixed100' },
    { label: 'grande fenêtre fixe', url: 'fixed-cases.html?k=modal15' },
    { label: 'grand tiroir fixe', url: 'fixed-cases.html?k=drawer' },
    { label: 'panneau fixe large', url: 'fixed-cases.html?k=sidewide2' },
    { label: 'pied fixe voisin du panneau', url: 'fixed-cases.html?k=footsib' },
    { label: 'pied fixe dans un panneau collant', url: 'fixed-cases.html?k=stickypanelfixedfoot' },
    { label: 'en-tête rendu fixe par script', url: 'js-header.html' },
    // Différences voulues : la barre retrouve sa place au lieu de cacher le texte au milieu de l'image, et le bandeau du bas reste hors image.
    { label: 'barre collante du bas', url: 'coded-rows.html?total=1113&bar=sticky&barH=50', ignore: [{ y: H - 50, h: 50 }, { y: rowsEnd, h: 50 }] },
    { label: 'page longue', url: 'long.html', ignore: [{ y: H - 40, h: 40 }] },
    // Choix retenu : les petites cartes du bas restent hors image, même dans un conteneur invisible.
    { label: 'bulle de chat', url: 'fixed-cases.html?k=bubble', hidden: [card] },
    { label: 'bulle dans un conteneur sans taille', url: 'fixed-cases.html?k=intercom', hidden: [card] },
    { label: 'bulle dans un calque transparent', url: 'fixed-cases.html?k=overlaywrap', hidden: [card] },
    { label: 'bandeau du bas dans un conteneur sans taille', url: 'fixed-cases.html?k=portalcookie', hidden: [{ y: H - 100, h: 100 }] },
    { label: 'bandeau du bas, menu fermé invisible', url: 'fixed-cases.html?k=closedmenu', hidden: [{ y: H - 100, h: 100 }] },
    { label: 'bandeau du bas, menu fermé transparent', url: 'fixed-cases.html?k=closedmenu2', hidden: [{ y: H - 100, h: 100 }] },
    { label: 'bandeau du bas, grand visuel collant', url: 'fixed-cases.html?k=herocookie', hidden: [{ y: H - 100, h: 100 }] },
    { label: 'bandeau du bas, panneau étroit au-dessus', url: 'fixed-cases.html?k=panelcookie', hidden: [{ y: H - 100, h: 100 }] },
    { label: 'carte alignée sur un tiroir fermé', url: 'fixed-cases.html?k=closeddrawer', hidden: [card] },
    { label: 'carte alignée sur un tiroir au parent transparent', url: 'fixed-cases.html?k=closeddrawer2', hidden: [card] },
    { label: 'bulle à côté d’un panneau', url: 'fixed-cases.html?k=panelbubble', hidden: [card] },
    { label: 'bulle dans un emballage à sa taille', url: 'fixed-cases.html?k=wrapsized', hidden: [card] },
    { label: 'bulle dans un calque presque vide', url: 'fixed-cases.html?k=overlaywrap2', hidden: [card] },
    // Le pied d'un panneau garde le Total : fond porté par un bloc intérieur, ou pied posé juste sous le panneau.
    { label: 'fond du panneau sur un bloc intérieur', url: 'fixed-cases.html?k=childsurface' },
    { label: 'fond du panneau sur deux blocs intérieurs', url: 'fixed-cases.html?k=childsurface2' },
    { label: 'pied posé juste sous le panneau', url: 'fixed-cases.html?k=footbelow' },
    { label: 'en-tête collant, parent sans boîte', url: 'fixed-cases.html?k=contents' },
    { label: 'en-tête collant, parent en ligne', url: 'fixed-cases.html?k=inlinehidden' },
    { label: 'titres de tableau collants, ligne à overflow', url: 'fixed-cases.html?k=rowhidden' },
  ];
  for (const { label, url, ignore = [], hidden = [] } of cases) {
    const { page, tabId } = await openTab(context, sw, `${base}/${url}`);
    const { viewer, error } = await capture(context, sw, tabId, 'full');
    if (error) {
      check(label, false, error);
      await page.close();
      continue;
    }
    // Après la capture : les images différées sont chargées, et la page doit être revenue à son état de départ.
    const reference = await referenceImage(context, page);
    const { size, wrong, box, card: shown } = await compareWithReference(viewer, { reference, ignore, hidden });
    check(label, wrong === 0 && shown === 0, `${size}, pixels différents ${wrong}${box ? ` dans ${JSON.stringify(box)}` : ''}${hidden.length ? `, carte visible ${shown}` : ''}`);
    await viewer.close();
    await page.close();
  }
}

// Une liste qui ne crée ses sections qu'à l'approche de l'écran : ses titres collants, nés pendant la capture, gardent leur place.
async function testVirtualList(context, sw, url) {
  console.log('\n— Liste virtuelle');
  const { page, tabId } = await openTab(context, sw, url);
  const { viewer, error } = await capture(context, sw, tabId, 'full');
  if (error) {
    check('capture terminée', false, error);
    await page.close();
    return;
  }
  const { runs } = await analyze(viewer, { splitPoints: 4000, columns: { title: 100 }, colors: { magenta: MAGENTA }, exportDir: path.join(WORK, 'virtual-list') });
  const expected = Array.from({ length: 10 }, (_, k) => [k * 1200, k * 1200 + 80]);
  check('les 10 titres présents, chacun à sa place', JSON.stringify(runs['title:magenta']) === JSON.stringify(expected), JSON.stringify(runs['title:magenta']));
  await page.close();
  await viewer.close();
}

// La page retrouve exactement ses réglages, même écrits avec des variables ou en plusieurs morceaux, après une capture réussie comme après une panne.
async function testRestoreStyles(context, sw, base) {
  console.log('\n— Réglages de la page rendus après la capture');
  const snapshot = () => {
    const state = { y: scrollY };
    for (const el of document.querySelectorAll('[data-t]')) {
      const style = getComputedStyle(el);
      state[el.dataset.t] = [el.style.cssText, style.position, style.display, style.top, style.bottom, style.left, style.right, style.opacity, style.transition].join(' | ');
    }
    return state;
  };
  const differences = (before, after) => Object.keys(before).filter((key) => before[key] !== after[key]).map((key) => `${key} : ${before[key]} → ${after[key]}`);
  // La seconde page refuse les styles écrits dans le HTML : à l'écran ils n'existent pas, et la capture ne doit pas les réveiller.
  for (const [file, failing, note] of [['restore-styles.html?y=500', false, ''], ['restore-styles.html?y=500', true, ''], ['restore-csp.html', false, ', politique stricte'], ['restore-csp.html', true, ', politique stricte']]) {
    const { page, tabId } = await openTab(context, sw, `${base}/${file}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const before = await page.evaluate(snapshot);
    if (failing) {
      await sw.evaluate(() => {
        self.realCapture = chrome.tabs.captureVisibleTab;
        let count = 0;
        chrome.tabs.captureVisibleTab = (...args) => (++count >= 2 ? Promise.reject(new Error('panne simulée')) : self.realCapture.apply(chrome.tabs, args));
      });
    }
    const { viewer, error } = await capture(context, sw, tabId, 'full');
    if (failing) await sw.evaluate(() => (chrome.tabs.captureVisibleTab = self.realCapture));
    await page.bringToFront();
    // Un élément de la page a son propre fondu de 2 s : il réapparaît à son rythme, on relit une fois la page au repos.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const changed = differences(before, await page.evaluate(snapshot));
    check(`${failing ? 'après une panne' : 'après une capture'}${note} : réglages intacts`, changed.length === 0 && (failing ? Boolean(error) : !error), changed.slice(0, 3).join(' ; ') || `${Object.keys(before).length - 1} éléments relus`);
    await viewer?.close();
    await page.close();
  }
}

async function testNewerDatabase(extension, base) {
  console.log('\n— Extension mise à jour sans la recharger');
  const context = await launch(extension, 'profile-version', WORK);
  try {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const { page, tabId } = await openTab(context, sw, `${base}/body-scroll.html`);
    await sw.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open('capture', 99);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            open.result.close();
            resolve();
          };
        }),
    );
    const { id, error } = await capture(context, sw, tabId, 'visible');
    check('message en français : recharger l’extension', !id && /clique sur ↻/.test(error ?? '') && !/requested version/.test(error ?? ''), error);
    await page.close();
  } finally {
    await context.close();
  }
}

async function testBodyScroll(context, sw, url) {
  console.log('\n— Page dont le <body> est le bloc qui défile');
  const { page, tabId } = await openTab(context, sw, url);
  const geom = await page.evaluate(() => ({ width: document.body.clientWidth, height: document.body.scrollHeight }));
  const { viewer, seconds, error } = await capture(context, sw, tabId, 'full');
  check('capture terminée', !error, error ?? `${seconds} s`);
  if (error) return;
  const { meta, parts } = await analyze(viewer, {
    splitPoints: 4000,
    columns: {},
    colors: {},
    exportDir: path.join(WORK, 'body-scroll'),
  });
  check('tout le contenu est capturé', meta.scroller === 'element' && Math.abs(meta.height - geom.height * 2) <= 2, `${meta.scroller}, ${meta.height} px pour ${geom.height} points`);
  check('découpe en plusieurs images', parts.length > 1, `${parts.length} images`);
  await page.close();
  await viewer.close();
}

// La vraie extension (activeTab seul) sans clic sur l'icône : Chrome refuse l'accès à la page.
async function testRealManifest(base) {
  console.log('\n— Vraie extension, capture lancée sans clic sur l’icône (cas d’erreur)');
  const dir = path.join(WORK, 'extension-real');
  await fs.cp(EXTENSION, dir, { recursive: true });
  const context = await launch(dir, 'profile-real', WORK);
  try {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const { page, tabId } = await openTab(context, sw, `${base}/long.html`);
    const { id, error } = await capture(context, sw, tabId, 'full');
    check('autorisation manquante expliquée en clair', !id && /Autorisation manquante/.test(error ?? ''), error);
    await page.close();

    // Le Chromium de test active d'office l'accès aux fichiers : on simule le réglage désactivé.
    await sw.evaluate(() => {
      Object.defineProperty(chrome.extension, 'isAllowedFileSchemeAccess', { value: async () => false, configurable: true });
    });
    const file = await openTab(context, sw, `file://${path.join(HERE, 'pages', 'long.html')}`);
    const local = await capture(context, sw, file.tabId, 'full');
    check(
      'fichier local, accès aux fichiers désactivé (simulé) : le message indique le réglage',
      !local.id && /URL de fichier/.test(local.error ?? ''),
      local.error,
    );
    await file.page.close();

    // Le nettoyage repère les captures affichées par l'adresse des onglets : le vrai manifeste doit y avoir accès.
    const resultsPage = await context.newPage();
    await resultsPage.goto(`chrome-extension://${new URL(sw.url()).host}/viewer/viewer.html?id=essai`);
    const seen = await sw.evaluate(async () => (await chrome.tabs.query({})).some(({ url }) => url?.includes('viewer/viewer.html?id=essai')));
    check('vraie extension : elle lit l’adresse de ses pages de résultats', seen);
    await resultsPage.close();
  } finally {
    await context.close();
  }
}

async function testVisible(context, sw, url) {
  console.log('\n— Partie visible');
  const { page, tabId } = await openTab(context, sw, url);
  const screen = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const { viewer, error } = await capture(context, sw, tabId, 'visible');
  check('capture terminée', !error, error);
  if (error) return;
  const { meta, parts } = await analyze(viewer, {
    splitPoints: 4000,
    columns: {},
    colors: {},
    exportDir: path.join(WORK, 'visible'),
  });
  check(
    'une image de la taille de la zone de page × 2',
    parts.length === 1 && meta.width === screen.w * 2 && meta.height === screen.h * 2,
    `${parts.length} image, ${meta.width} × ${meta.height} pour ${screen.w} × ${screen.h} points`,
  );
  await page.close();
  await viewer.close();
}

async function testForbiddenPage(context, sw) {
  console.log('\n— Page interdite, capture lancée au clavier (cas d’erreur)');
  await watchErrors(sw);
  const { page, tabId } = await openTab(context, sw, 'chrome://version');
  const { id, error } = await capture(context, sw, tabId, 'full');
  check('refus expliqué en clair', !id && /interdit/.test(error ?? ''), error);
  const logged = await readErrors(sw);
  check('refus non inscrit comme « erreur » dans Chrome', logged.length === 0, logged.join(' | '));

  // Le message attend la fenêtre de l'icône (ouverte d'office si Chrome le permet).
  const state = await sw.evaluate(async () => ({
    stored: (await chrome.storage.session.get('lastError')).lastError?.message ?? null,
    popups: (await chrome.runtime.getContexts({ contextTypes: ['POPUP'] })).length,
  }));
  let shown = '';
  if (state.stored) {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${new URL(sw.url()).host}/popup/popup.html`);
    await popup.waitForTimeout(300);
    shown = await popup.locator('#error').innerText();
    await popup.close();
  }
  check(
    'la fenêtre de l’icône affiche le refus',
    /interdit/.test(shown) || state.popups > 0,
    state.popups > 0 ? 'fenêtre ouverte d’office' : `affiché : « ${shown} »`,
  );
  await page.close();
}

// Relève ce que Chrome afficherait dans « Erreurs » : console.error et rejets non interceptés.
async function watchErrors(sw) {
  await sw.evaluate(() => {
    self.__errors = [];
    if (self.__watching) return;
    self.__watching = true;
    const original = console.error.bind(console);
    console.error = (...args) => {
      self.__errors.push(args.map(String).join(' '));
      original(...args);
    };
    self.addEventListener('unhandledrejection', (event) => self.__errors.push(`rejet non intercepté : ${event.reason}`));
  });
}

async function readErrors(sw) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  return sw.evaluate(() => self.__errors);
}

async function testOwnPage(context, sw) {
  console.log('\n— ⌥⇧P sur la page des résultats elle-même (cas d’erreur)');
  const { page, tabId } = await openTab(context, sw, `chrome-extension://${new URL(sw.url()).host}/viewer/viewer.html`);
  const { id, error } = await capture(context, sw, tabId, 'full');
  check('message juste : lancer la capture depuis la page à capturer', !id && /page de résultats/.test(error ?? ''), error);
  await page.close();
}

async function testClosedTab(context, sw, url) {
  console.log('\n— Onglet fermé pendant la capture');
  // Ferme les fenêtres d'icône restées ouvertes par les cas d'erreur précédents.
  for (const p of context.pages()) if (p.url().includes('/popup/popup.html')) await p.close();
  await watchErrors(sw);
  const { page, tabId } = await openTab(context, sw, url);
  const running = capture(context, sw, tabId, 'full');
  await page.waitForTimeout(6000);
  await page.close();
  const { id } = await running;
  const logged = await readErrors(sw);
  const popups = await sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['POPUP'] })).length);
  check('capture abandonnée sans erreur inscrite ni fenêtre ouverte', !id && logged.length === 0 && popups === 0, logged.join(' | ') || `${popups} fenêtre`);
}

async function testPopup(context, sw) {
  const extensionId = new URL(sw.url()).host;
  const page = await context.newPage();
  await page.setViewportSize({ width: 300, height: 260 });
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(WORK, 'popup.png') });
  const normal = await page.evaluate(() => ({
    full: document.querySelector('[data-shortcut="capture-full"]').textContent,
    hint: !document.getElementById('shortcut-hint').hidden,
  }));
  check('raccourci « Page entière » attribué et affiché, sans avertissement', /F/.test(normal.full) && !normal.hint, JSON.stringify(normal));
  await page.close();

  // Comme quand une autre extension occupe déjà la touche : Chrome laisse la commande sans raccourci.
  const taken = await context.newPage();
  await taken.setViewportSize({ width: 300, height: 320 });
  await taken.addInitScript(() => {
    const getAll = chrome.commands.getAll.bind(chrome.commands);
    chrome.commands.getAll = async () =>
      (await getAll()).map((c) => (c.name === 'capture-full' ? { ...c, shortcut: '' } : c));
  });
  await taken.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await taken.waitForTimeout(300);
  await taken.screenshot({ path: path.join(WORK, 'popup-no-shortcut.png') });
  const hint = await taken.evaluate(() => {
    const el = document.getElementById('shortcut-hint');
    return el.hidden ? '' : el.textContent.replace(/\s+/g, ' ').trim();
  });
  check('raccourci pris ailleurs : la fenêtre le signale avec un lien pour en choisir un', /Page entière/.test(hint) && /Choisir un raccourci/.test(hint), hint);
  await taken.close();
}

async function main() {
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(WORK, { recursive: true });
  const extension = await prepareExtension(WORK);
  const server = await serve(path.join(HERE, 'pages'));
  const base = `http://127.0.0.1:${server.address().port}`;
  const context = await launch(extension, 'profile', WORK);
  try {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    if (!ONLY) {
      await testLongPage(context, sw, `${base}/long.html`);
      await testAppPage(context, sw, `${base}/app.html`);
      await testJsHeader(context, sw, `${base}/js-header.html`);
      await testBodyScroll(context, sw, `${base}/body-scroll.html`);
      await testSidePanel(context, sw, base);
      await testStickyTitles(context, sw, `${base}/sticky-titles.html`);
      await testFrozenColumns(context, sw, `${base}/frozen-columns.html`);
    }
    // `fidelite` : seulement ce bloc. `fin` : seulement ce qui suit, pour finir une série interrompue.
    if (ONLY !== 'fin') {
      await testCodedRows(context, sw, base);
      await testAgainstReference(context, sw, base);
      await testVirtualList(context, sw, `${base}/virtual-list.html`);
      await testRestoreStyles(context, sw, base);
    }
    if (ONLY === 'fidelite') return finish();
    await testVisible(context, sw, `${base}/long.html`);
    await testTabSwitch(context, sw, `${base}/long.html`, `${base}/app.html`);
    await testForbiddenPage(context, sw);
    await testOwnPage(context, sw);
    await testClosedTab(context, sw, `${base}/long.html`);
    await testPopup(context, sw);
  } finally {
    await context.close();
  }
  try {
    await testNewerDatabase(extension, base);
    await testRealManifest(base);
  } finally {
    server.close();
  }
  finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} vérifications réussies`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
