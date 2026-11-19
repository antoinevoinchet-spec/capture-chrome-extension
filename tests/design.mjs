// Tests du design system « Papier, terre cuite ».
// Usage : node design.mjs <dossier de sortie> [groupe] [motif]
// Groupes : tokens, demo, icone, panneau, appareils, captures, editeur, convert, transcription, gabarit, axe, photos.
// `photos` ne fait que des captures d'écran (dans <dossier>/photos/), sans contrôle ; il ne tourne que si on le nomme.

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  capture,
  check,
  colorDistance,
  contrast,
  extensionPage,
  launch,
  luminance,
  openTab,
  prepareExtension,
  resolveColor,
  results,
  seedCapture,
  serve,
  setPhotoDir,
  shoot,
} from './lib.mjs';

const HERE = import.meta.dirname;
const WORK = path.resolve(process.argv[2] ?? path.join(HERE, 'out-design'));
const ONLY = process.argv[3];
const NAMED = process.argv[4] ? new RegExp(process.argv[4], 'i') : null;
// Un profil neuf à chaque lancement : un profil réutilisé garde en cache l'ancien service worker.
const RUN = Date.now().toString(36);
const EXTENSION_DIR = path.resolve(HERE, '../extension');

const testOnce = (name, body) => test(name, body);

async function test(name, body) {
  if (NAMED && !NAMED.test(name)) return;
  try {
    const { ok, detail } = await body();
    check(name, ok, detail);
  } catch (err) {
    check(name, false, String(err.message ?? err).split('\n')[0].slice(0, 240));
  }
}

const short = (value) => JSON.stringify(value)?.slice(0, 700);
const MODES = ['light', 'dark'];
const YOUTUBE_URL = 'https://www.youtube.com/watch?v=manuel00001';

// ---- Ouverture des écrans ----

// Le panneau de l'icône, ouvert dans un onglet. `url` : adresse simulée de l'onglet actif (chrome.tabs.query).
export async function openPanel(context, env, { url = `${env.base}/design-sample.html`, init } = {}) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 340, height: 600 });
  await page.addInitScript(
    ({ url }) => {
      const query = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async (info) => (info?.active ? [{ id: 999999, index: 0, windowId: -1, url, active: true }] : query(info));
    },
    { url },
  );
  if (init) await page.addInitScript(init);
  await page.goto(`chrome-extension://${env.extensionId}/popup/popup.html`);
  await page.waitForTimeout(300);
  return page;
}

// Ouvre l'éditeur sur l'image `index` de la page des captures, par le bouton de la barre de l'image ou par son menu « ⋯ ».
export async function openEditor(viewer, index = 0) {
  const part = viewer.locator('figure.part').nth(index);
  const direct = part.getByRole('button', { name: 'Annoter', exact: true });
  if (await direct.count()) await direct.click();
  else {
    await part.locator('[aria-haspopup="menu"]').click();
    await viewer.locator('#image-menu [data-action="annotate"]').click();
  }
  await viewer.waitForSelector('#editor[data-ready="true"]', { timeout: 30_000 });
}

// Une capture réelle de la page type, faite une fois par lancement et réutilisée.
async function sampleCapture(context, env) {
  if (env.sample) return env.sample;
  const { page, tabId } = await openTab(context, env.sw, `${env.base}/design-sample.html`);
  const { id, viewer, error } = await capture(context, env.sw, tabId, 'full');
  await page.close();
  if (!id) throw new Error(`capture impossible : ${error}`);
  await viewer.close();
  env.sample = { id, url: `chrome-extension://${env.extensionId}/viewer/viewer.html?id=${id}` };
  return env.sample;
}

// Les écrans dans un état type. Chacun est { page, ready() } ; ready() attend que l'écran soit prêt à être jugé.
export async function screens(context, env) {
  const sample = await sampleCapture(context, env);
  const panneau = await openPanel(context, env);
  const captures = await context.newPage();
  await captures.goto(sample.url);
  const editeur = await context.newPage();
  await editeur.goto(sample.url);
  const convert = await extensionPage(context, 'convert/convert.html');
  const transcription = await extensionPage(context, 'transcript/transcript.html');
  const target = await openTab(context, env.sw, `${env.base}/design-sample.html`);
  const appareils = await extensionPage(context, `devices/confirm.html?tab=${target.tabId}`);
  const viewerReady = (page) => page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
  const all = {
    panneau: { page: panneau, ready: () => panneau.waitForLoadState('load') },
    captures: { page: captures, ready: () => viewerReady(captures) },
    editeur: {
      page: editeur,
      ready: async () => {
        await viewerReady(editeur);
        if (!(await editeur.locator('#editor[data-ready="true"]').count())) await openEditor(editeur, 0);
      },
    },
    convert: { page: convert, ready: () => convert.waitForLoadState('load') },
    transcription: { page: transcription, ready: () => transcription.waitForLoadState('load') },
    appareils: { page: appareils, ready: () => appareils.waitForSelector('body[data-ready="true"]') },
  };
  for (const screen of Object.values(all)) await screen.ready();
  return all;
}

async function closeScreens(all) {
  for (const { page } of Object.values(all)) await page.close().catch(() => {});
}

// ---- Groupes ----

async function groupTokens(context, env) {
  const page = await extensionPage(context, 'popup/popup.html');
  try {
    await test('aide contrast : noir sur blanc vaut 21', async () => {
      const value = contrast([0, 0, 0], [255, 255, 255]);
      return { ok: Math.abs(value - 21) < 0.01, detail: value.toFixed(3) };
    });
    await test('aide resolveColor : oklch(0.5 0.1 40) rend trois entiers 0-255', async () => {
      const rgb = await resolveColor(page, 'oklch(0.5 0.1 40)');
      return { ok: rgb.length === 3 && rgb.every((v) => Number.isInteger(v) && v >= 0 && v <= 255), detail: short(rgb) };
    });

    // Rôles, contrastes et règles des tokens, en clair puis en sombre.
    const role = (name) => resolveColor(page, `var(--${name})`);
    for (const mode of MODES) {
      await page.emulateMedia({ colorScheme: mode });
      const pairs = [
        ['text', 'bg', 4.5],
        ['text', 'surface', 4.5],
        ['text-muted', 'bg', 4.5],
        ['text-muted', 'surface', 4.5],
        ['accent-text', 'accent-subtle', 4.5],
        ['primary-fg', 'primary-bg', 4.5],
        ['accent', 'bg', 3],
        ['focus', 'bg', 3],
        ['border-strong', 'bg', 3],
        ['danger', 'bg', 4.5],
      ];
      for (const [fg, bg, min] of pairs) {
        await test(`tokens ${mode} : --${fg} sur --${bg} ≥ ${min}`, async () => {
          const value = contrast(await role(fg), await role(bg));
          return { ok: value >= min, detail: value.toFixed(2) };
        });
      }
      await test(`tokens ${mode} : --accent proche de ${mode === 'light' ? '#b4532f' : '#e08a62'}`, async () => {
        const accent = await role('accent');
        const d = colorDistance(accent, mode === 'light' ? [180, 83, 47] : [224, 138, 98]);
        return { ok: d < (mode === 'light' ? 10 : 14), detail: `${short(accent)} distance ${d.toFixed(1)}` };
      });
      await test(`tokens ${mode} : --danger et --primary-bg loin de --accent (≥ 60)`, async () => {
        const accent = await role('accent');
        const danger = colorDistance(await role('danger'), accent);
        const primary = colorDistance(await role('primary-bg'), accent);
        return { ok: danger >= 60 && primary >= 60, detail: `danger ${danger.toFixed(1)}, primaire ${primary.toFixed(1)}` };
      });
      await test(`tokens ${mode} : --stage distinct de --surface, --image-edge visible dessus`, async () => {
        const stage = await role('stage');
        const gap = Math.abs(luminance(stage) - luminance(await role('surface')));
        const edge = contrast(await role('image-edge'), stage);
        return { ok: gap >= 0.03 && edge >= 1.3, detail: `écart ${gap.toFixed(3)}, contour ${edge.toFixed(2)}` };
      });
      if (mode === 'dark') {
        await test('tokens dark : action principale claire, scène ni noire ni blanche', async () => {
          const primary = luminance(await role('primary-bg'));
          const stage = luminance(await role('stage'));
          return { ok: primary > 0.6 && stage >= 0.02 && stage <= 0.2, detail: `primaire ${primary.toFixed(2)}, scène ${stage.toFixed(3)}` };
        });
      }
    }
    await page.emulateMedia({ colorScheme: 'light' });

    await test('tokens : police du système, interligne 1,4 (1,2 au-dessus de 20 px), .num tabulaire', async () => {
      const got = await page.evaluate(() => {
        const body = getComputedStyle(document.body);
        const make = (html) => {
          const holder = document.createElement('div');
          holder.innerHTML = html;
          document.body.append(holder);
          return holder.firstElementChild;
        };
        const num = make('<span class="num">12</span>');
        const big = make('<h2 class="text-20">Titre</h2>');
        const huge = make('<p class="text-28">Titre</p>');
        const ratio = (el) => parseFloat(getComputedStyle(el).lineHeight) / parseFloat(getComputedStyle(el).fontSize);
        const out = {
          font: body.fontFamily,
          body: parseFloat(body.lineHeight) / parseFloat(body.fontSize),
          num: getComputedStyle(num).fontVariantNumeric,
          big: ratio(big),
          huge: ratio(huge),
          bigSize: getComputedStyle(big).fontSize,
        };
        for (const el of [num, big, huge]) el.parentElement.remove();
        return out;
      });
      const ok =
        /^system-ui/.test(got.font) &&
        Math.abs(got.body - 1.4) < 0.01 &&
        got.num.includes('tabular-nums') &&
        Math.abs(got.big - 1.2) < 0.01 &&
        Math.abs(got.huge - 1.2) < 0.01 &&
        got.bigSize === '20px';
      return { ok, detail: short(got) };
    });
  } finally {
    await page.close();
  }

  await test('tokens : ni Avenir ni @font-face dans extension/', async () => {
    const hits = await grep(/Avenir|@font-face/, EXTENSION_DIR, { skip: /vendor/ });
    return { ok: hits.length === 0, detail: hits.slice(0, 5).join(' | ') };
  });

  // ---- Contrôles statiques ----
  const SCREEN_CSS = /(popup|viewer|editor|convert|transcript|confirm|components)\.css$/;
  const SCREEN_JS = /(popup|viewer|editor|convert|transcript|confirm|demo|icons)\.js$/;
  const exempt = (lines, i) => /hors tokens/.test(lines[i]) || /hors tokens/.test(lines[i - 1] ?? '');
  async function scan(filter, check) {
    const hits = [];
    for (const entry of await fs.readdir(EXTENSION_DIR, { recursive: true, withFileTypes: true })) {
      const full = path.join(entry.parentPath, entry.name);
      if (!entry.isFile() || !filter.test(entry.name) || /vendor/.test(full)) continue;
      const lines = (await fs.readFile(full, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        if (!exempt(lines, i) && check(line, full)) hits.push(`${path.relative(EXTENSION_DIR, full)}:${i + 1}: ${line.trim().slice(0, 90)}`);
      });
    }
    return hits;
  }
  const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\(|oklch\(/;
  await test('tokens : aucune couleur en dur dans les CSS d’écran (hors lignes « hors tokens »)', async () => {
    const hits = await scan(SCREEN_CSS, (line) => COLOR.test(line.replace(/\/\*.*?\*\//g, '')));
    return { ok: hits.length === 0, detail: hits.slice(0, 8).join(' | ') };
  });
  const SCALE = new Set([0, 1, 2, 4, 8, 12, 16, 24, 32, 48, 11, 13, 14, 20, 28, 6, 10, 40, 56, 240]);
  await test('tokens : aucune valeur en px hors des échelles (sauf traits de 0 à 2 px)', async () => {
    const hits = await scan(SCREEN_CSS, (line) => [...line.replace(/\/\*.*?\*\//g, '').matchAll(/(-?\d*\.?\d+)px/g)].some(([, n]) => !SCALE.has(Math.abs(Number(n)))));
    return { ok: hits.length === 0, detail: hits.slice(0, 8).join(' | ') };
  });
  await test('tokens : plus aucun ancien nom (--mat, --cut, --paper, --ink, --line) dans extension/', async () => {
    const hits = await grep(/--(mat|cut|paper|ink|line)\b|--(on-mat|paper-raised|paper-sunk|ink-muted|on-mat-muted)/, EXTENSION_DIR, { skip: /vendor/ });
    return { ok: hits.length === 0, detail: hits.slice(0, 8).join(' | ') };
  });
  await test('tokens : aucune couleur en dur dans les .js d’écran ni dans les style= des .html (sauf annotate/shapes.js)', async () => {
    const js = await scan(SCREEN_JS, (line) => COLOR.test(line));
    const html = await scan(/\.html$/, (line) => /style="[^"]*(#[0-9a-fA-F]{3,8}\b|rgba?\(|oklch\()/.test(line));
    const hits = [...js, ...html];
    return { ok: hits.length === 0, detail: hits.slice(0, 8).join(' | ') };
  });
  await test('tokens : --gray-* et --clay-* seulement dans tokens.css', async () => {
    const hits = (await grep(/--(gray|clay|red)-\d/, EXTENSION_DIR, { skip: /vendor/ })).filter((hit) => !hit.startsWith(`ui${path.sep}tokens.css`));
    return { ok: hits.length === 0, detail: hits.slice(0, 8).join(' | ') };
  });
  await test('tokens : le cadre de « Un bloc » et « Une zone » est en terre cuite, plus en jaune et vert sapin', async () => {
    const picker = await fs.readFile(path.join(EXTENSION_DIR, 'capture', 'picker.js'), 'utf8');
    const edge = picker.match(/--edge:\s*(#[0-9a-f]{6})/i)?.[1];
    const accent = await (async () => {
      const page = await extensionPage(context, 'ui/demo.html');
      await page.emulateMedia({ colorScheme: 'light' });
      const rgb = await resolveColor(page, 'var(--accent)');
      await page.close();
      return rgb;
    })();
    const hex = edge ? [1, 3, 5].map((i) => parseInt(edge.slice(i, i + 2), 16)) : [0, 0, 0];
    const old = /f4c542|23453b/i.test(picker);
    return { ok: !old && colorDistance(hex, accent) < 4, detail: short({ edge, accent, old }) };
  });
  const OLD = /Terminer|Partie visible|Voir les captures récentes|Par paragraphe/;
  await test('tokens : anciens libellés absents de extension/ et des tests comme texte cherché', async () => {
    const ext = await grep(OLD, EXTENSION_DIR, { skip: /vendor/ });
    const tests = (await grep(OLD, HERE, { skip: /node_modules|out-|design\.mjs$/, files: /\.mjs$/ })).filter((hit) => /name: ['‘]|hasText|getByText/.test(hit) && OLD.test(hit.split(/name: |hasText|getByText/).slice(1).join('')));
    const hits = [...ext, ...tests];
    return { ok: hits.length === 0, detail: hits.slice(0, 8).join(' | ') };
  });
}

// Audit axe (WCAG 2 A et AA) de la page. Rend les violations sous forme courte.
async function axeViolations(page, { include } = {}) {
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']);
  if (include) builder = builder.include(include);
  const result = await builder.analyze();
  const describe = (v) => `${v.id} (${v.nodes.length}) ${v.nodes.slice(0, 3).map((n) => `${n.target?.join(' ')} ${n.any?.[0]?.message ?? ''}`.slice(0, 160)).join(' ; ')}`;
  return { violations: result.violations.map(describe), result };
}

// Couleur de fond réellement visible sous un élément : on remonte jusqu'au premier fond non transparent.
function backgroundUnder(page, selector, { outside = false } = {}) {
  return page.evaluate(({ selector, outside }) => {
    const start = document.querySelector(selector);
    for (let el = outside ? start?.parentElement : start; el; el = el.parentElement) {
      const bg = getComputedStyle(el).backgroundColor;
      if (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg) && !/\/ 0\)$/.test(bg)) return bg;
    }
    return getComputedStyle(document.documentElement).backgroundColor;
  }, { selector, outside });
}

async function groupDemo(context) {
  for (const mode of MODES) {
    const page = await context.newPage();
    const errors = [];
    page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
    page.on('pageerror', (err) => errors.push(err.message));
    await page.emulateMedia({ colorScheme: mode });
    try {
      const sw = context.serviceWorkers()[0];
      await page.goto(`chrome-extension://${new URL(sw.url()).host}/ui/demo.html`);
      await page.waitForSelector('body[data-ready="true"]', { timeout: 5000 });

      await test(`demo ${mode} : la page s'ouvre sans erreur console`, async () => ({ ok: errors.length === 0, detail: errors.join(' | ') }));

      await test(`demo ${mode} : chaque pictogramme de icons.js rend un <svg> non vide, trait de 1,5`, async () => {
        const got = await page.evaluate(async () => {
          const { ICON_NAMES, icon } = await import(chrome.runtime.getURL('ui/icons.js'));
          const bad = [];
          for (const name of ICON_NAMES) {
            const svg = icon(name);
            document.body.append(svg);
            const box = svg.getBBox();
            if (svg.tagName !== 'svg' || !svg.childElementCount || !box.width || svg.getAttribute('stroke-width') !== '1.5') bad.push(name);
            svg.remove();
          }
          const expected = 'full visible block zone devices transcript convert history chevron more download copy annotate close error info check keyboard arrow rect highlight text counter mask pen trim undo redo trash back'.split(' ');
          return { bad, missing: expected.filter((name) => !ICON_NAMES.includes(name)), count: ICON_NAMES.length };
        });
        return { ok: got.bad.length === 0 && got.missing.length === 0, detail: short(got) };
      });

      await test(`demo ${mode} : boutons primaire et secondaire de 32 ou 40 px de haut`, async () => {
        const heights = await page.evaluate(() => [...document.querySelectorAll('.btn-primary, .btn-secondary')].map((el) => Math.round(el.getBoundingClientRect().height)));
        return { ok: heights.length > 0 && heights.every((h) => h === 32 || h === 40), detail: short([...new Set(heights)]) };
      });

      await test(`demo ${mode} : focus clavier d'un bouton visible (contour ≥ 3:1 sur le fond)`, async () => {
        await page.locator('body').click({ position: { x: 1, y: 1 } });
        let focused = null;
        for (let i = 0; i < 10 && !focused; i++) {
          await page.keyboard.press('Tab');
          focused = await page.evaluate(() => {
            const el = document.activeElement;
            if (!el?.matches('.btn-primary, .btn-secondary')) return null;
            el.id ||= 'focus-probe';
            const style = getComputedStyle(el);
            return { id: el.id, color: style.outlineColor, width: parseFloat(style.outlineWidth), style: style.outlineStyle };
          });
        }
        if (!focused) return { ok: false, detail: 'aucun bouton atteint par Tab' };
        // Le contour est dessiné à l'extérieur du bouton : on le compare au fond de son parent.
        const ratio = contrast(await resolveColor(page, focused.color), await resolveColor(page, await backgroundUnder(page, `#${focused.id}`, { outside: true })));
        return { ok: focused.width >= 2 && focused.style !== 'none' && ratio >= 3, detail: `${short(focused)} contraste ${ratio.toFixed(2)}` };
      });

      await test(`demo ${mode} : « 1 écran | Court | Moyen | Long » tient sur une ligne, sans coupure, dans la colonne de réglages`, async () => {
        const got = await page.evaluate(() => {
          const group = document.getElementById('seg-long');
          const buttons = [...group.querySelectorAll('button')];
          return {
            width: Math.round(group.getBoundingClientRect().width),
            tops: new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top))).size,
            clipped: buttons.filter((b) => b.scrollWidth > b.clientWidth).length,
            widths: buttons.map((b) => `${b.scrollWidth}/${b.clientWidth}`),
          };
        });
        return { ok: got.width <= 208 && got.tops === 1 && got.clipped === 0, detail: short(got) };
      });

      await test(`demo ${mode} : toast, bandeau et champ en erreur portent l'icône « error » et un texte`, async () => {
        const got = await page.evaluate(() =>
          ['.toast.is-error', '.banner.is-error', '.field.is-error'].map((selector) => {
            const el = document.querySelector(selector);
            return { selector, icon: Boolean(el?.querySelector('svg.icon-error')), text: el?.textContent.trim().length > 3 };
          }),
        );
        return { ok: got.every((x) => x.icon && x.text), detail: short(got) };
      });

      await test(`demo ${mode} : bordure de champ et pictogramme de ligne de liste ≥ 3:1`, async () => {
        const field = await page.evaluate(() => getComputedStyle(document.querySelector('.field:not(.is-error) .input:not(:disabled)')).borderTopColor);
        const rowIcon = await page.evaluate(() => getComputedStyle(document.querySelector('.list-row:not(:disabled):not(.is-hover):not(.is-active) > .icon')).color);
        const fieldRatio = contrast(await resolveColor(page, field), await resolveColor(page, await backgroundUnder(page, '.fields')));
        const iconRatio = contrast(await resolveColor(page, rowIcon), await resolveColor(page, await backgroundUnder(page, '.list-row:not(:disabled)')));
        return { ok: fieldRatio >= 3 && iconRatio >= 3, detail: `champ ${fieldRatio.toFixed(2)}, pictogramme ${iconRatio.toFixed(2)}` };
      });

      await test(`demo ${mode} : aucune violation axe (WCAG 2 A/AA)`, async () => {
        const { violations } = await axeViolations(page);
        return { ok: violations.length === 0, detail: violations.join(' | ') };
      });

      if (ONLY === 'photos' || ONLY === 'demo') await shoot(page, `demo-${mode}`, { fullPage: true });
    } finally {
      await page.close();
    }
  }
}

// Lit un PNG de l'extension dans la page (canvas) : { width, height, data } avec data en tableau RGBA.
function readIcon(page, file) {
  return page.evaluate(async (file) => {
    const img = new Image();
    img.src = chrome.runtime.getURL(`icons/${file}`);
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    return { width: canvas.width, height: canvas.height, data: [...ctx.getImageData(0, 0, canvas.width, canvas.height).data] };
  }, file);
}

// Pose un pixel RGBA sur un fond RGB.
const over = ([r, g, b, a], bg) => [r, g, b].map((v, i) => Math.round((v * a + bg[i] * (255 - a)) / 255));

async function groupIcone(context, env) {
  const page = await extensionPage(context, 'popup/popup.html');
  try {
    const icons = {};
    for (const size of [16, 32, 48, 128]) icons[size] = await readIcon(page, `icon${size}.png`);
    const px = ({ width, data }, x, y) => data.slice((y * width + x) * 4, (y * width + x) * 4 + 4);

    await test('icone : les 4 PNG ont la bonne taille', async () => {
      const got = Object.entries(icons).map(([size, icon]) => `${size}:${icon.width}×${icon.height}`);
      return { ok: Object.entries(icons).every(([size, icon]) => icon.width === Number(size) && icon.height === Number(size)), detail: got.join(' ') };
    });

    await test('icone : la 128 a 16 px de marge transparente et un centre opaque', async () => {
      const icon = icons[128];
      let opaqueInMargin = 0;
      for (let y = 0; y < 128; y++)
        for (let x = 0; x < 128; x++) {
          const inMargin = x < 16 || x >= 112 || y < 16 || y >= 112;
          if (inMargin && px(icon, x, y)[3] !== 0) opaqueInMargin++;
        }
      const center = px(icon, 64, 64)[3];
      return { ok: opaqueInMargin === 0 && center === 255, detail: `${opaqueInMargin} pixels non transparents dans la marge, alpha au centre ${center}` };
    });

    await test('icone : la 16 a un pixel terre cuite et un pixel blanc', async () => {
      const icon = icons[16];
      let clay = 0;
      let white = 0;
      for (let i = 0; i < 256; i++) {
        const p = icon.data.slice(i * 4, i * 4 + 4);
        if (p[3] < 200) continue;
        const rgb = p.slice(0, 3);
        if (colorDistance(rgb, [180, 83, 47]) < 40 || colorDistance(rgb, [224, 138, 98]) < 40) clay++;
        if (rgb.every((v) => v > 240)) white++;
      }
      return { ok: clay > 0 && white > 0, detail: `${clay} terre cuite, ${white} blancs` };
    });

    await test('icone : le bord de la 16 se distingue des barres claire et sombre', async () => {
      const icon = icons[16];
      const results = {};
      for (const [name, bg] of [['claire', [223, 225, 229]], ['sombre', [53, 54, 58]]]) {
        // Le pixel opaque le plus proche du bord, au milieu du côté gauche et du côté haut.
        let best = 0;
        for (const [x, y] of [[0, 8], [1, 8], [8, 0], [8, 1]]) {
          const p = px(icon, x, y);
          if (p[3] === 0) continue;
          best = Math.max(best, contrast(over(p, bg), bg));
        }
        results[name] = best.toFixed(2);
      }
      return { ok: Number(results.claire) >= 1.5 && Number(results.sombre) >= 1.5, detail: short(results) };
    });

    if (ONLY === 'icone' || ONLY === 'photos') await iconBoard(context, env);
  } finally {
    await page.close();
  }
}

// Planche de l'icône : 4 tailles sur barre claire et sombre, la 16 agrandie 8 fois sans lissage, une barre d'outils simulée.
async function iconBoard(context, env) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 900, height: 520 });
  await page.goto(`chrome-extension://${env.extensionId}/ui/demo.html`);
  await page.evaluate(() => {
    const url = (n) => chrome.runtime.getURL(`icons/icon${n}.png`);
    const row = (bg, fg) => `<div style="display:flex;align-items:flex-end;gap:32px;padding:24px;background:${bg};color:${fg}">
      ${[16, 32, 48, 128].map((n) => `<figure style="margin:0;text-align:center"><img src="${url(n)}" width="${n}" height="${n}"><figcaption style="font:12px system-ui">${n}</figcaption></figure>`).join('')}
      <figure style="margin:0;text-align:center"><img src="${url(16)}" width="128" height="128" style="image-rendering:pixelated"><figcaption style="font:12px system-ui">16 × 8</figcaption></figure>
      <div style="display:flex;align-items:center;gap:12px;height:36px;padding:0 12px;border-radius:18px;background:${bg === '#dfe1e5' ? '#ffffff' : '#202124'}">
        <span style="width:16px;height:16px;border-radius:50%;background:#8ab4f8"></span><span style="width:16px;height:16px;border-radius:4px;background:#9aa0a6"></span>
        <img src="${url(16)}" width="16" height="16"><span style="width:16px;height:16px;border-radius:50%;background:#9aa0a6"></span>
      </div></div>`;
    document.body.innerHTML = row('#dfe1e5', '#202124') + row('#35363a', '#e8eaed');
    document.body.style.margin = '0';
  });
  await page.waitForFunction(() => [...document.images].every((img) => img.complete));
  await shoot(page, 'icone', { fullPage: true });
  await page.close();
}

// Identifiants du panneau d’avant la refonte : tous restent.
const PANEL_IDS = ['full', 'transcript', 'visible', 'pick-block', 'pick-zone', 'devices', 'shortcut-hint', 'shortcut-hint-text', 'set-shortcut', 'status', 'bar-fill', 'status-text', 'cancel', 'error', 'recent', 'convert', 'transcribe', 'version'];
// Ordre visuel et ordre de tabulation du panneau (sur une page YouTube, au repos).
const PANEL_TAB_ORDER = ['shortcuts', 'full', 'transcript', 'visible', 'pick-block', 'pick-zone', 'devices', 'convert', 'transcribe', 'recent', 'tip-close'];

// Enregistre la position des éléments au moment où le panneau devient visible (premier rendu).
function recordFirstRender() {
  const ids = ['full', 'visible', 'pick-block', 'pick-zone'];
  const snap = () => Object.fromEntries(ids.map((id) => [id, document.getElementById(id)?.getBoundingClientRect().top]));
  document.addEventListener('DOMContentLoaded', () => {
    const body = document.body;
    if (getComputedStyle(body).visibility !== 'hidden') {
      window.firstRender = snap();
      return;
    }
    new MutationObserver((_, observer) => {
      if (getComputedStyle(body).visibility === 'hidden') return;
      window.firstRender = snap();
      observer.disconnect();
    }).observe(body, { attributes: true });
  });
}

// Toutes les commandes sans raccourci : le conseil de raccourci manquant prend sa forme la plus longue.
function noShortcuts() {
  const getAll = chrome.commands.getAll.bind(chrome.commands);
  chrome.commands.getAll = async () => (await getAll()).map((c) => ({ ...c, shortcut: '' }));
}

// Pire cas du panneau : statut de capture, erreur et astuce affichés en même temps.
function worstCase() {
  document.getElementById('status').hidden = false;
  document.getElementById('status-text').textContent = 'Téléphone (1 sur 3) : image 12 sur 140';
  document.getElementById('bar-fill').style.width = '40%';
  document.getElementById('cancel').hidden = false;
  const error = document.getElementById('error');
  error.hidden = false;
  (document.getElementById('error-text') ?? error).textContent =
    // Le plus long des vrais messages (save-web-image.js), avec son préfixe.
    'Image non enregistrée : le site a refusé de la donner (erreur 403). Elle demande peut-être une connexion, ou son lien a expiré : recharge la page et réessaie.';
}

const panelHeight = (page) => page.evaluate(() => ({
  body: Math.round(document.body.getBoundingClientRect().height),
  scroll: document.documentElement.scrollHeight,
  client: document.documentElement.clientHeight,
}));

async function groupPanneau(context, env) {
  const admin = await extensionPage(context, 'popup/popup.html');
  await admin.evaluate(() => chrome.storage.local.remove(['tipRightClickClosed']));
  try {
    const open = (options) => openPanel(context, env, options);

    await test('panneau : 340 px de large, sans défilement horizontal', async () => {
      const page = await open();
      const got = await page.evaluate(() => ({ width: document.body.offsetWidth, scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      await page.close();
      return { ok: got.width === 340 && got.scroll <= got.client, detail: short(got) };
    });

    await test('panneau : au repos, 420 px de haut au plus', async () => {
      const page = await open();
      const got = await panelHeight(page);
      await page.close();
      return { ok: got.body <= 420, detail: short(got) };
    });

    await test('panneau : libellés attendus, chaque action est un bouton', async () => {
      const page = await open({ url: YOUTUBE_URL });
      const got = await page.evaluate(() => {
        const text = (id) => document.getElementById(id)?.textContent.replace(/\s+/g, ' ').trim() ?? '';
        const expected = { full: 'Page entière', visible: 'Visible', 'pick-block': 'Un bloc', 'pick-zone': 'Une zone', transcript: 'Transcription de cette vidéo', recent: 'Captures récentes', devices: 'Ouvre la page dans un onglet à part' };
        const missing = Object.entries(expected).filter(([id, label]) => !text(id).includes(label)).map(([id]) => `${id}: « ${text(id)} »`);
        const ids = ['full', 'transcript', 'visible', 'pick-block', 'pick-zone', 'devices', 'convert', 'transcribe', 'recent', 'tip-close', 'shortcuts'];
        const notButtons = ids.filter((id) => document.getElementById(id)?.tagName !== 'BUTTON');
        const visibleOld = /Partie visible|Voir les captures récentes/.test(document.body.textContent);
        return { missing, notButtons, visibleOld };
      });
      await page.close();
      return { ok: got.missing.length === 0 && got.notButtons.length === 0 && !got.visibleOld, detail: short(got) };
    });

    await test('panneau : rien ne bouge entre le premier rendu et 1 s après, ni quand le statut apparaît (page YouTube)', async () => {
      const page = await open({ url: YOUTUBE_URL, init: recordFirstRender });
      await page.waitForTimeout(1000);
      const got = await page.evaluate(() => {
        const ids = ['full', 'visible', 'pick-block', 'pick-zone'];
        const now = () => Object.fromEntries(ids.map((id) => [id, document.getElementById(id).getBoundingClientRect().top]));
        const later = now();
        document.getElementById('status').hidden = false;
        const withStatus = now();
        return { first: window.firstRender ?? null, later, withStatus };
      });
      await page.close();
      const same = (a, b) => a && b && Object.keys(b).every((id) => Math.abs(a[id] - b[id]) < 0.5);
      return { ok: same(got.first, got.later) && same(got.later, got.withStatus), detail: short(got) };
    });

    for (const mode of MODES) {
      await test(`panneau ${mode} : pire cas (YouTube, statut, erreur, raccourcis manquants, astuce) sans défilement, 600 px au plus`, async () => {
        const page = await open({ url: YOUTUBE_URL, init: noShortcuts });
        await page.emulateMedia({ colorScheme: mode });
        await page.evaluate(worstCase);
        const got = await panelHeight(page);
        const shown = await page.evaluate(() => ['transcript', 'status', 'error', 'shortcut-hint', 'tip'].filter((id) => !document.getElementById(id)?.hidden));
        if (ONLY === 'panneau' || ONLY === 'photos') await shoot(page, `panneau-pire-${mode}`, { fullPage: true });
        await page.close();
        return { ok: got.body <= 600 && got.scroll <= got.client && shown.length === 5, detail: short({ ...got, shown }) };
      });
    }

    await test('panneau : ordre visuel attendu (pire cas)', async () => {
      const page = await open({ url: YOUTUBE_URL, init: noShortcuts });
      await page.evaluate(worstCase);
      const order = ['shortcuts', 'full', 'transcript', 'visible', 'status', 'devices', 'convert', 'transcribe', 'recent', 'tip', 'version'];
      const tops = await page.evaluate((order) => order.map((id) => [id, Math.round(document.getElementById(id)?.getBoundingClientRect().top ?? -1)]), order);
      const tiles = await page.evaluate(() => ['visible', 'pick-block', 'pick-zone'].map((id) => Math.round(document.getElementById(id).getBoundingClientRect().top)));
      await page.close();
      const increasing = tops.every(([, top], i) => top >= 0 && (i === 0 || top > tops[i - 1][1]));
      return { ok: increasing && new Set(tiles).size === 1, detail: short({ tops, tiles }) };
    });

    await test('panneau : Tab atteint chaque action dans l’ordre attendu, focus visible', async () => {
      const page = await open({ url: YOUTUBE_URL });
      const seen = [];
      const weak = [];
      for (let i = 0; i < PANEL_TAB_ORDER.length; i++) {
        await page.keyboard.press('Tab');
        const focus = await page.evaluate(() => {
          const el = document.activeElement;
          const style = getComputedStyle(el);
          return { id: el.id, color: style.outlineColor, style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
        });
        seen.push(focus.id);
        if (focus.style === 'none' || focus.width < 2) weak.push(`${focus.id} sans contour`);
        else {
          const ratio = contrast(await resolveColor(page, focus.color), await resolveColor(page, await backgroundUnder(page, `#${focus.id}`, { outside: true })));
          if (ratio < 3) weak.push(`${focus.id} ${ratio.toFixed(2)}`);
        }
      }
      await page.close();
      return { ok: seen.join() === PANEL_TAB_ORDER.join() && weak.length === 0, detail: short({ seen, weak }) };
    });

    await test('panneau : aucune tuile sélectionnée, panneau sans coins arrondis ni ombre', async () => {
      const page = await open();
      const got = await page.evaluate(() => ({
        pressed: [...document.querySelectorAll('.tile')].filter((el) => el.hasAttribute('aria-pressed') || /selected|is-active/.test(el.className)).map((el) => el.id),
        tiles: document.querySelectorAll('.tile').length,
        radius: getComputedStyle(document.body).borderRadius,
        shadow: getComputedStyle(document.body).boxShadow,
      }));
      await page.close();
      return { ok: got.tiles === 3 && got.pressed.length === 0 && got.radius === '0px' && got.shadow === 'none', detail: short(got) };
    });

    await test('panneau : l’astuce se ferme et reste fermée à la réouverture', async () => {
      const page = await open();
      const before = await page.evaluate(() => !document.getElementById('tip').hidden);
      await page.locator('#tip-close').click();
      const closed = await page.evaluate(() => document.getElementById('tip').hidden);
      await page.close();
      const again = await open();
      const after = await again.evaluate(() => document.getElementById('tip').hidden);
      await again.close();
      await admin.evaluate(() => chrome.storage.local.remove(['tipRightClickClosed']));
      return { ok: before && closed && after, detail: short({ before, closed, after }) };
    });

    await test('panneau : tous les identifiants d’avant la refonte existent encore', async () => {
      const page = await open();
      const missing = await page.evaluate((ids) => ids.filter((id) => !document.getElementById(id)), PANEL_IDS);
      await page.close();
      return { ok: missing.length === 0, detail: missing.join(', ') };
    });

    await test('panneau : l’erreur porte l’icône « error »', async () => {
      const page = await open();
      await page.evaluate(worstCase);
      const icon = await page.evaluate(() => Boolean(document.querySelector('#error svg.icon-error')));
      await page.close();
      return { ok: icon, detail: String(icon) };
    });

    for (const mode of MODES) {
      await test(`panneau ${mode} : aucune violation axe, au repos et dans le pire cas`, async () => {
        const page = await open({ url: YOUTUBE_URL, init: noShortcuts });
        await page.emulateMedia({ colorScheme: mode });
        const rest = (await axeViolations(page)).violations;
        await page.evaluate(worstCase);
        const worst = (await axeViolations(page)).violations;
        await page.close();
        return { ok: rest.length === 0 && worst.length === 0, detail: [...rest, ...worst].join(' | ') };
      });
    }
  } finally {
    await admin.close();
  }
}

// ---- Confirmation « Téléphone, tablette, ordinateur » ----

// Note dans le service worker chaque demande « capture-devices » reçue.
function recordDeviceRequests() {
  if (self.deviceRequests) return;
  self.deviceRequests = [];
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'capture-devices') self.deviceRequests.push(msg.tabId);
  });
}

async function stopDevicesCapture(sw, admin) {
  await admin.evaluate(() => chrome.runtime.sendMessage({ type: 'capture-cancel' }).catch(() => {}));
  for (let i = 0; i < 120; i++) {
    const busy = await sw.evaluate(async () => Boolean((await chrome.storage.session.get('capturing')).capturing));
    if (!busy) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function groupAppareils(context, env) {
  const { sw } = env;
  await sw.evaluate(recordDeviceRequests);
  const requests = () => sw.evaluate(() => self.deviceRequests.length);
  const admin = await extensionPage(context, 'popup/popup.html');
  await admin.evaluate(() => chrome.storage.local.remove('devicesConfirmed'));
  const { page: target, tabId } = await openTab(context, sw, `${env.base}/design-sample.html`);
  const confirmUrl = `chrome-extension://${env.extensionId}/devices/confirm.html?tab=${tabId}`;
  const isConfirm = (p) => p.url().includes('/devices/confirm.html');
  try {
    const panelOn = async () => openPanel(context, env, { url: `${env.base}/design-sample.html`, init: `{ const q = chrome.tabs.query.bind(chrome.tabs); chrome.tabs.query = async (info) => (info?.active ? [await chrome.tabs.get(${tabId})] : q(info)); }` });

    await test('appareils : premier clic → page de confirmation ?tab=, aucune capture lancée', async () => {
      const panel = await panelOn();
      const before = await requests();
      const [opened] = await Promise.all([context.waitForEvent('page', { predicate: isConfirm, timeout: 5000 }), panel.locator('#devices').click()]);
      await opened.waitForLoadState();
      await opened.waitForTimeout(800);
      const after = await requests();
      const url = opened.url();
      await opened.close();
      await panel.close().catch(() => {});
      return { ok: url.endsWith(`confirm.html?tab=${tabId}`) && after === before, detail: short({ url, before, after }) };
    });

    await test('appareils : la page dit le bandeau, l’état initial et l’onglet à part, sans parler de couleur', async () => {
      const page = await context.newPage();
      await page.goto(confirmUrl);
      const text = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
      await page.close();
      return { ok: /bandeau/.test(text) && /état initial/.test(text) && /onglet à part/.test(text) && !/jaune/.test(text), detail: text.slice(0, 200) };
    });

    await test('appareils : « Continuer » lance la capture, mémorise, rend l’onglet actif et ferme la page', async () => {
      const page = await context.newPage();
      await page.goto(confirmUrl);
      await page.waitForSelector('body[data-ready="true"]');
      const before = await requests();
      const closed = page.waitForEvent('close', { timeout: 10_000 }).then(() => true, () => false);
      await page.locator('#continue').click();
      const gone = await closed;
      const after = await requests();
      const confirmed = await admin.evaluate(async () => (await chrome.storage.local.get('devicesConfirmed')).devicesConfirmed);
      const active = await sw.evaluate(async (id) => (await chrome.tabs.get(id)).active, tabId);
      await stopDevicesCapture(sw, admin);
      return { ok: after === before + 1 && confirmed === true && gone && active, detail: short({ before, after, confirmed, gone, active }) };
    });

    await test('appareils : second clic → capture lancée sans page de confirmation', async () => {
      const panel = await panelOn();
      const before = await requests();
      let confirmOpened = false;
      const watch = (p) => {
        if (isConfirm(p)) confirmOpened = true;
      };
      context.on('page', watch);
      await panel.locator('#devices').click();
      await panel.waitForTimeout(1000);
      context.off('page', watch);
      const after = await requests();
      await panel.close().catch(() => {});
      await stopDevicesCapture(sw, admin);
      return { ok: after === before + 1 && !confirmOpened, detail: short({ before, after, confirmOpened }) };
    });

    await test('appareils : onglet à capturer fermé → message, « Continuer » caché, rien ne démarre', async () => {
      const { page: doomed, tabId: doomedId } = await openTab(context, sw, `${env.base}/design-sample.html`);
      await doomed.close();
      const page = await context.newPage();
      await page.goto(`chrome-extension://${env.extensionId}/devices/confirm.html?tab=${doomedId}`);
      await page.waitForSelector('body[data-ready="true"]');
      const before = await requests();
      const got = await page.evaluate(() => ({ gone: !document.getElementById('gone').hidden, text: document.getElementById('gone').textContent, hidden: document.getElementById('continue').hidden }));
      await page.close();
      return { ok: got.gone && /fermé/.test(got.text) && got.hidden && (await requests()) === before, detail: short(got) };
    });

    await test('appareils : « Annuler » ferme la page, rien ne démarre', async () => {
      const page = await context.newPage();
      await page.goto(confirmUrl);
      await page.waitForSelector('body[data-ready="true"]');
      const before = await requests();
      const closed = page.waitForEvent('close', { timeout: 5000 }).then(() => true, () => false);
      await page.locator('#cancel').click();
      const gone = await closed;
      return { ok: gone && (await requests()) === before, detail: short({ gone }) };
    });

    for (const mode of MODES) {
      await test(`appareils ${mode} : en-tête de 56 px, aucune violation axe`, async () => {
        const page = await context.newPage();
        await page.emulateMedia({ colorScheme: mode });
        await page.goto(confirmUrl);
        await page.waitForSelector('body[data-ready="true"]');
        const header = await page.evaluate(() => Math.round(document.querySelector('.app-header')?.getBoundingClientRect().height ?? 0));
        const { violations } = await axeViolations(page);
        if (ONLY === 'appareils') await shoot(page, `appareils-${mode}`);
        await page.close();
        return { ok: header === 56 && violations.length === 0, detail: short({ header, violations }) };
      });
    }
  } finally {
    await target.close().catch(() => {});
    await admin.evaluate(() => chrome.storage.local.remove('devicesConfirmed')).catch(() => {});
    await admin.close();
  }
}

// ---- Page des captures ----

// Couleurs d'une ligne de pixels de l'écran (coordonnées CSS), lues sur une capture d'écran décodée dans la page.
async function pixelRow(page, { x, y, width }) {
  const png = await page.screenshot({ clip: { x, y, width, height: 1 } });
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, 1).data;
    return Array.from({ length: bitmap.width }, (_, i) => [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]);
  }, png.toString('base64'));
}

// Contour d'une image blanche posée sur le fond : contraste entre le pixel le plus marqué du bord et le fond, 12 px plus loin.
async function edgeContrast(page, selector) {
  const box = await page.locator(selector).first().boundingBox();
  const row = await pixelRow(page, { x: Math.floor(box.x) - 12, y: Math.floor(box.y + Math.min(box.height / 2, 200)), width: 16 });
  const stage = row[0];
  // Les 2 points juste à l'extérieur de l'image (le bord est à 12 points du début de la ligne), en pixels réels.
  const scale = row.length / 16;
  const edge = row.slice(10 * scale, 12 * scale).reduce((best, rgb) => (contrast(rgb, stage) > contrast(best, stage) ? rgb : best), stage);
  return { ratio: contrast(edge, stage), stage, edge };
}

const viewerReady = (page) => page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });

async function openViewer(context, env, id) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${env.extensionId}/viewer/viewer.html?id=${id}`);
  await viewerReady(page);
  return page;
}

async function groupCaptures(context, env) {
  const admin = await extensionPage(context, 'popup/popup.html');
  await admin.evaluate(() => chrome.storage.sync.clear());
  const three = await seedCapture(admin, { heightPoints: 10_000 });
  const single = await seedCapture(admin, { heightPoints: 1200 });
  try {
    const viewer = await openViewer(context, env, three);
    const count = await viewer.locator('figure.part').count();

    await test(`captures : ${count} images, la barre de chacune n'a qu'un bouton, ni Copier, ni Télécharger, ni Annoter`, async () => {
      const got = await viewer.evaluate(() =>
        [...document.querySelectorAll('figure.part figcaption')].map((bar) => [...bar.querySelectorAll('button')].map((b) => (b.getAttribute('aria-label') ?? b.textContent).trim())),
      );
      const ok = count === 3 && got.every((names) => names.length === 1 && !names.some((n) => ['Copier', 'Télécharger', 'Annoter'].includes(n)));
      return { ok, detail: short(got) };
    });

    await test('captures : « ⋯ » de l’image 2 ouvre le menu, « Annoter » y ouvre l’éditeur', async () => {
      const more = viewer.locator('figure.part').nth(1).locator('.part-more');
      const label = await more.getAttribute('aria-label');
      const popup = await more.getAttribute('aria-haspopup');
      await more.click();
      const menu = await viewer.evaluate(() => !document.getElementById('image-menu').hidden);
      await viewer.locator('#image-menu [data-action="annotate"]').click();
      await viewer.waitForSelector('#editor[data-ready="true"]', { timeout: 30_000 });
      await viewer.keyboard.press('Escape');
      await viewer.waitForSelector('#editor', { state: 'hidden' });
      return { ok: label === 'Actions sur l’image 2' && popup === 'menu' && menu, detail: short({ label, popup, menu }) };
    });

    await test('captures : « Annoter l’image » de l’en-tête ouvre l’éditeur sur l’image courante', async () => {
      await viewer.locator('#annotate-current').click();
      await viewer.waitForSelector('#editor[data-ready="true"]', { timeout: 30_000 });
      await viewer.keyboard.press('Escape');
      await viewer.waitForSelector('#editor', { state: 'hidden' });
      return { ok: true, detail: 'éditeur ouvert' };
    });

    await test('captures : libellés de l’en-tête selon l’image courante et le nombre d’images', async () => {
      const labels = () => viewer.evaluate(() => ({ all: document.getElementById('download-all').textContent.trim(), copy: document.getElementById('copy-current').textContent.trim(), annotate: document.getElementById('annotate-current')?.textContent.trim() }));
      await viewer.evaluate(() => document.querySelectorAll('figure.part')[1].scrollIntoView({ block: 'start' }));
      await viewer.waitForTimeout(300);
      const second = await labels();
      const one = await openViewer(context, env, single);
      const alone = await one.evaluate(() => document.getElementById('download-all').textContent.trim());
      await one.close();
      const ok = second.all === 'Tout télécharger (3 images)' && second.copy === 'Copier l’image 2' && second.annotate === 'Annoter l’image 2' && alone === 'Télécharger l’image';
      return { ok, detail: short({ second, alone }) };
    });

    await test('captures : l’aide du découpage dit le nombre d’images, qui change de « 1 écran » à « Long »', async () => {
      const hint = async (key) => {
        await viewer.locator(`#split button[data-key="${key}"]`).click();
        await viewerReady(viewer);
        return viewer.evaluate(() => document.getElementById('split-hint').textContent.trim());
      };
      const screen = await hint('screen');
      const long = await hint('long');
      await hint('medium');
      const number = (text) => Number(text.match(/(\d[\d   ]*)\s+images?\b/)?.[1].replace(/\D/g, '') ?? NaN);
      return { ok: number(screen) > 0 && number(long) > 0 && number(screen) !== number(long), detail: short({ screen, long }) };
    });

    await test('captures : colonne de 240 px, fond uni, tailles en chiffres tabulaires', async () => {
      const got = await viewer.evaluate(() => ({
        side: Math.round(document.querySelector('.app-side')?.getBoundingClientRect().width ?? 0),
        image: getComputedStyle(document.getElementById('mat')).backgroundImage,
        numeric: getComputedStyle(document.querySelector('figure.part .part-size')).fontVariantNumeric,
      }));
      return { ok: got.side === 240 && got.image === 'none' && got.numeric.includes('tabular-nums'), detail: short(got) };
    });

    await test('captures : titre de 200 caractères sans espace et 120 images, en-tête de 56 px, boutons sur une ligne', async () => {
      // Textes du pire cas posés directement : une vraie capture de 120 images demanderait plusieurs Go à la machine de test.
      const got = await viewer.evaluate(() => {
        document.getElementById('title').textContent = 'A'.repeat(200);
        document.getElementById('download-all').textContent = 'Tout télécharger (120 images)';
        document.getElementById('copy-current').textContent = 'Copier l’image 120';
        document.getElementById('annotate-current').textContent = 'Annoter l’image 120';
        const header = document.querySelector('.app-header');
        const buttons = [...header.querySelectorAll('button:not([hidden])')].filter((b) => b.offsetParent);
        return {
          header: Math.round(header.getBoundingClientRect().height),
          wrapped: buttons.filter((b) => b.scrollHeight > b.clientHeight + 1 || b.getBoundingClientRect().height > 40).map((b) => b.id),
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          widest: [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1).slice(0, 4).map((el) => `${el.tagName}#${el.id}.${el.className}`),
        };
      });
      await viewer.reload();
      await viewerReady(viewer);
      return { ok: got.header === 56 && got.wrapped.length === 0 && !got.overflow, detail: short(got) };
    });

    for (const mode of MODES) {
      await test(`captures ${mode} : aucune violation axe`, async () => {
        await viewer.emulateMedia({ colorScheme: mode });
        // Les boutons font une transition de couleur de 120 ms : on mesure une fois qu'elle est finie.
        await viewer.waitForTimeout(300);
        const { violations } = await axeViolations(viewer);
        if (ONLY === 'captures') await shoot(viewer, `captures-${mode}`);
        return { ok: violations.length === 0, detail: violations.join(' | ') };
      });
    }
    await viewer.close();

    // Un site entièrement blanc garde ses bords, dans la page des captures et dans l'éditeur.
    const { page: white, tabId } = await openTab(context, env.sw, `${env.base}/design-white.html`);
    const shot = await capture(context, env.sw, tabId, 'full');
    await white.close();
    for (const mode of MODES) {
      await test(`captures ${mode} : capture d’un site blanc, contour visible sur le fond (page et éditeur)`, async () => {
        await shot.viewer.emulateMedia({ colorScheme: mode });
        await shot.viewer.waitForTimeout(200);
        const page = await edgeContrast(shot.viewer, 'figure.part .sheet');
        await openEditor(shot.viewer, 0);
        const editor = await edgeContrast(shot.viewer, '#editor-page');
        if (ONLY === 'captures') await shoot(shot.viewer, `captures-blanc-editeur-${mode}`);
        await shot.viewer.keyboard.press('Escape');
        await shot.viewer.waitForSelector('#editor', { state: 'hidden' });
        return { ok: page.ratio >= 1.3 && editor.ratio >= 1.3, detail: short({ page, editor }) };
      });
    }
    await shot.viewer.close();
  } finally {
    await admin.close();
  }
}

// ---- Éditeur d'annotation ----

// Remplace le téléchargement de Chrome par un relevé : chaque appel garde { url, filename }.
function spyDownloads() {
  window.saved = [];
  chrome.downloads.download = async (options) => {
    window.saved.push(options);
    return 100000 + window.saved.length;
  };
}

// Pixels proches du rouge d'annotation dans un fichier relevé par spyDownloads.
function redPixelsIn(index) {
  return (async () => {
    const { url, filename } = window.saved[index];
    const blob = await (await fetch(url)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let red = 0;
    for (let i = 0; i < data.length; i += 16) {
      if (Math.hypot(data[i] - 224, data[i + 1] - 49, data[i + 2] - 49) < 40) red++;
    }
    return { red, type: blob.type, filename };
  })();
}

// Tire un rectangle sur la zone de dessin, en points d'écran à partir du coin haut gauche de la page affichée.
async function drawRect(viewer, x, y, w, h) {
  await viewer.keyboard.press('r');
  const box = await viewer.locator('#editor-page').boundingBox();
  await viewer.mouse.move(box.x + x, box.y + y);
  await viewer.mouse.down();
  await viewer.mouse.move(box.x + x + w / 2, box.y + y + h / 2, { steps: 4 });
  await viewer.mouse.move(box.x + x + w, box.y + y + h, { steps: 4 });
  await viewer.mouse.up();
}

const savedItems = (viewer, id) =>
  viewer.evaluate(async (id) => (await (await import(chrome.runtime.getURL('lib/db.js'))).getAnnotations(id)).length, id);

async function groupEditeur(context, env) {
  const admin = await extensionPage(context, 'popup/popup.html');
  await admin.evaluate(() => chrome.storage.sync.clear());
  const id = await seedCapture(admin, { heightPoints: 10_000 });
  // Pages ouvertes par un test : fermées après lui, même en échec (un éditeur resté ouvert bloquerait le suivant).
  const opened = [];
  const test = async (name, run) => {
    await testOnce(name, run);
    while (opened.length) await opened.pop().close().catch(() => {});
  };
  const fresh = async () => {
    await admin.evaluate((id) => import(chrome.runtime.getURL('lib/db.js')).then((db) => db.saveAnnotations(id, [])), id);
    const viewer = await openViewer(context, env, id);
    opened.push(viewer);
    await viewer.evaluate(spyDownloads);
    await openEditor(viewer, 0);
    return viewer;
  };
  try {
    await test('editeur : « Retour aux captures » existe, « Terminer » n’existe plus', async () => {
      const viewer = await fresh();
      const got = await viewer.evaluate(() => ({
        back: document.getElementById('editor-close').textContent.replace(/\s+/g, ' ').trim(),
        terminer: [...document.querySelectorAll('button')].some((b) => /Terminer/.test(b.textContent)),
      }));
      await viewer.close();
      return { ok: got.back === 'Retour aux captures' && !got.terminer, detail: short(got) };
    });

    await test('editeur : « Télécharger » enregistre l’image avec son annotation rouge', async () => {
      const viewer = await fresh();
      await drawRect(viewer, 200, 120, 300, 160);
      await viewer.locator('#editor-download').click();
      await viewer.waitForFunction(() => window.saved.length === 1, null, { timeout: 30_000 });
      const got = await viewer.evaluate(redPixelsIn, 0);
      await viewer.close();
      return { ok: got.red > 50 && /\.png$/.test(got.filename), detail: short(got) };
    });

    await test('editeur : réglage JPG de la page, « Télécharger » produit un JPG', async () => {
      const viewer = await openViewer(context, env, id);
      opened.push(viewer);
      await viewer.locator('#format button[data-key="jpg"]').click();
      await viewer.evaluate(spyDownloads);
      await openEditor(viewer, 0);
      await viewer.locator('#editor-download').click();
      await viewer.waitForFunction(() => window.saved.length === 1, null, { timeout: 30_000 });
      const got = await viewer.evaluate(redPixelsIn, 0);
      await viewer.keyboard.press('Escape');
      await viewer.locator('#format button[data-key="png"]').click();
      await viewer.close();
      return { ok: got.type === 'image/jpeg' && /\.jpg$/.test(got.filename), detail: short(got) };
    });

    await test('editeur : deux formes, « Tout effacer » puis Annuler, les deux formes reviennent', async () => {
      const viewer = await fresh();
      viewer.on('dialog', (dialog) => dialog.accept());
      await drawRect(viewer, 100, 100, 200, 100);
      await drawRect(viewer, 400, 100, 200, 100);
      await viewer.waitForFunction(async (id) => (await (await import(chrome.runtime.getURL('lib/db.js'))).getAnnotations(id)).length === 2, id, { timeout: 10_000 });
      await viewer.locator('.editor-clear').click();
      await viewer.waitForFunction(async (id) => (await (await import(chrome.runtime.getURL('lib/db.js'))).getAnnotations(id)).length === 0, id, { timeout: 10_000 });
      await viewer.locator('#editor [aria-label="Annuler"]').click();
      await viewer.waitForFunction(async (id) => (await (await import(chrome.runtime.getURL('lib/db.js'))).getAnnotations(id)).length === 2, id, { timeout: 10_000 }).catch(() => {});
      const count = await savedItems(viewer, id);
      await viewer.close();
      return { ok: count === 2, detail: `${count} formes après Annuler` };
    });

    await test('editeur : « Recadrer » est dans la colonne d’outils, « Tout effacer » loin d’Annuler', async () => {
      const viewer = await fresh();
      const got = await viewer.evaluate(() => {
        const clear = document.querySelector('.editor-clear');
        const undo = document.querySelector('#editor [aria-label="Annuler"]');
        const redo = document.querySelector('#editor [aria-label="Rétablir"]');
        const a = clear.getBoundingClientRect();
        const gap = (b) => {
          const r = b.getBoundingClientRect();
          return Math.hypot(Math.max(0, r.left - a.right, a.left - r.right), Math.max(0, r.top - a.bottom, a.top - r.bottom));
        };
        const near = [clear.previousElementSibling, clear.nextElementSibling].some((el) => el === undo || el === redo);
        return { trimInTools: Boolean(document.querySelector('#editor-tools #editor-trim')), near, gap: Math.round(Math.min(gap(undo), gap(redo))) };
      });
      await viewer.close();
      return { ok: got.trimInTools && !got.near && got.gap >= 48, detail: short(got) };
    });

    await test('editeur : aucun <svg> écrit en dur dans editor.js, les outils prennent icon()', async () => {
      const source = await fs.readFile(path.join(EXTENSION_DIR, 'annotate/editor.js'), 'utf8');
      const viewer = await fresh();
      const icons = await viewer.evaluate(() => [...document.querySelectorAll('#editor-tools .editor-tool')].every((b) => b.querySelector('svg.icon')));
      await viewer.close();
      return { ok: !/<svg/.test(source) && icons, detail: `svg en dur : ${/<svg/.test(source)}, icon() partout : ${icons}` };
    });

    await test('editeur : chaque outil a un nom et un libellé visible au focus', async () => {
      const viewer = await fresh();
      const tools = await viewer.locator('#editor-tools .editor-tool').count();
      const bad = [];
      for (let i = 0; i < tools; i++) {
        const tool = viewer.locator('#editor-tools .editor-tool').nth(i);
        await tool.focus();
        const got = await viewer.evaluate(() => {
          const el = document.activeElement;
          const tip = document.getElementById('editor-tip');
          return { name: el.getAttribute('aria-label'), tip: tip && !tip.hidden && getComputedStyle(tip).visibility !== 'hidden' ? tip.textContent : '' };
        });
        if (!got.name || !got.tip.startsWith(got.name)) bad.push(got);
      }
      await viewer.close();
      return { ok: tools >= 7 && bad.length === 0, detail: short({ tools, bad }) };
    });

    await test('editeur : barre de 56 px, fond autour de l’image = --stage', async () => {
      const viewer = await fresh();
      const got = await viewer.evaluate(() => ({
        bar: Math.round(document.querySelector('.editor-bar').getBoundingClientRect().height),
        bg: getComputedStyle(document.getElementById('editor-scroll')).backgroundColor,
      }));
      const stage = await resolveColor(viewer, 'var(--stage)');
      const bg = await resolveColor(viewer, got.bg);
      await viewer.close();
      return { ok: got.bar === 56 && colorDistance(stage, bg) < 3, detail: short({ ...got, stage, bg }) };
    });

    await test('editeur : Tab atteint chaque bouton actif dans l’ordre visuel, focus visible', async () => {
      const viewer = await fresh();
      const expected = await viewer.evaluate(() =>
        [...document.querySelectorAll('#editor button')].filter((b) => !b.disabled && b.offsetParent && !b.closest('[hidden]')).map((b, i) => (b.id ||= `tab-probe-${i}`)),
      );
      const seen = [];
      const weak = [];
      for (let i = 0; i < expected.length + 2 && seen.length < expected.length; i++) {
        await viewer.keyboard.press('Tab');
        const focus = await viewer.evaluate(() => {
          const el = document.activeElement;
          const style = getComputedStyle(el);
          return { id: el.id, inEditor: Boolean(el.closest('#editor')), color: style.outlineColor, style: style.outlineStyle };
        });
        if (!focus.inEditor || !expected.includes(focus.id)) continue;
        seen.push(focus.id);
        if (focus.style === 'none') weak.push(focus.id);
        else if (contrast(await resolveColor(viewer, focus.color), await resolveColor(viewer, await backgroundUnder(viewer, `#${focus.id}`, { outside: true }))) < 3) weak.push(focus.id);
      }
      await viewer.close();
      // L'éditeur garde le focus en boucle et commence par le premier outil : outils, puis actions du haut.
      const start = expected.indexOf(seen[0]);
      const rotated = [...expected.slice(start), ...expected.slice(0, start)];
      return { ok: seen.join() === rotated.join() && weak.length === 0, detail: short({ missing: expected.filter((x) => !seen.includes(x)), weak, first: seen[0] }) };
    });

    for (const mode of MODES) {
      await test(`editeur ${mode} : aucune violation axe`, async () => {
        const viewer = await fresh();
        await viewer.emulateMedia({ colorScheme: mode });
        await viewer.waitForTimeout(300);
        const { violations } = await axeViolations(viewer, { include: '#editor' });
        if (ONLY === 'editeur') await shoot(viewer, `editeur-${mode}`);
        await viewer.close();
        return { ok: violations.length === 0, detail: violations.join(' | ') };
      });
    }
  } finally {
    await admin.close();
  }
}

// ---- Convertisseur ----

// Dépose de vraies images dans la page, comme un glisser-déposer depuis le Finder (événement drop sur la fenêtre).
function dropImages(names) {
  return (async () => {
    const transfer = new DataTransfer();
    for (const [i, name] of names.entries()) {
      const canvas = new OffscreenCanvas(120, 80);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = ['#c0392b', '#2471a3', '#229954'][i % 3];
      ctx.fillRect(0, 0, 120, 80);
      transfer.items.add(new File([await canvas.convertToBlob({ type: 'image/png' })], name, { type: 'image/png' }));
    }
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  })();
}

// Compte les images envoyées au travailleur de conversion.
function countWorkerPosts() {
  window.posted = 0;
  const real = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (...args) {
    window.posted++;
    return real.apply(this, args);
  };
}

const statuses = (page) => page.evaluate(() => [...document.querySelectorAll('.item')].map((row) => row.dataset.status));
const settled = (page) => page.waitForFunction(() => document.body.dataset.state === 'idle' && !document.querySelector('.item[data-status="working"]'), null, { timeout: 120_000 });

async function openConvert(context) {
  const page = await extensionPage(context, 'convert/convert.html');
  await page.evaluate(() => chrome.storage.sync.remove(['convertFormat', 'convertQuality']));
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.state === 'idle');
  return page;
}

async function groupConvert(context) {
  const opened = [];
  const open = async () => {
    const page = await openConvert(context);
    opened.push(page);
    return page;
  };
  const test = async (name, run) => {
    await testOnce(name, run);
    while (opened.length) await opened.pop().close().catch(() => {});
  };

  await test('convert : déposer 2 images les convertit sans clic', async () => {
    const page = await open();
    await page.evaluate(countWorkerPosts);
    await page.evaluate(dropImages, ['a.png', 'b.png']);
    await page.waitForFunction(() => document.querySelectorAll('.item[data-status="done"]').length === 2, null, { timeout: 60_000 });
    const got = { statuses: await statuses(page), posted: await page.evaluate(() => window.posted), convert: await page.evaluate(() => document.getElementById('convert').hidden) };
    return { ok: got.posted === 2 && got.convert, detail: short(got) };
  });

  await test('convert : passer de JPG à PNG propose « Reconvertir (2) », qui refait 2 fichiers', async () => {
    const page = await open();
    await page.evaluate(dropImages, ['a.png', 'b.png']);
    await settled(page);
    await page.evaluate(countWorkerPosts);
    await page.locator('#format button[data-key="png"]').click();
    const label = await page.evaluate(() => {
      const button = document.getElementById('convert');
      return button.hidden ? '(caché)' : button.textContent.trim();
    });
    await page.locator('#convert').click();
    await settled(page);
    const got = { label, posted: await page.evaluate(() => window.posted), statuses: await statuses(page), after: await page.evaluate(() => document.getElementById('convert').hidden) };
    return { ok: label === 'Reconvertir (2)' && got.posted === 2 && got.statuses.every((s) => s === 'done') && got.after, detail: short(got) };
  });

  await test('convert : changer le format pendant la conversion ne perd rien, ne convertit rien deux fois, « Reconvertir » seulement après', async () => {
    const page = await open();
    await page.evaluate(countWorkerPosts);
    const photo = await fs.readFile(path.join(HERE, 'fixtures', 'p48.heic'));
    await page.setInputFiles('#files', ['p1', 'p2', 'p3'].map((n) => ({ name: `${n}.heic`, mimeType: 'image/heic', buffer: photo })));
    await page.waitForSelector('.item[data-status="working"]');
    // Essai de changement de format en pleine conversion (les boutons sont verrouillés : le clic ne doit rien casser).
    const during = await page.evaluate(() => {
      document.querySelector('#format button[data-key="png"]').click();
      const button = document.getElementById('convert');
      return { reconvert: !button.hidden, locked: document.querySelector('#format button').disabled };
    });
    await settled(page);
    const got = { during, posted: await page.evaluate(() => window.posted), statuses: await statuses(page) };
    return { ok: !during.reconvert && got.posted === 3 && got.statuses.length === 3 && got.statuses.every((s) => s === 'done'), detail: short(got) };
  });

  await test('convert : à l’ouverture, la zone de dépôt couvre au moins 70 % de la zone principale', async () => {
    const page = await open();
    const got = await page.evaluate(() => {
      const area = (el) => {
        const r = el.getBoundingClientRect();
        return r.width * r.height;
      };
      const main = document.querySelector('.app-main');
      const drop = document.getElementById('drop');
      return { ratio: main && drop ? area(drop) / area(main) : 0, choose: document.getElementById('choose')?.textContent.trim(), download: document.getElementById('download-all').checkVisibility() };
    });
    return { ok: got.ratio >= 0.7 && got.choose === 'Choisir des fichiers' && !got.download, detail: short({ ...got, ratio: got.ratio.toFixed(2) }) };
  });

  await test('convert : la note de confidentialité tient en 2 lignes, la taille d’un fichier en chiffres tabulaires', async () => {
    const page = await open();
    await page.evaluate(dropImages, ['a.png']);
    await settled(page);
    const got = await page.evaluate(() => {
      // Lignes du texte lui-même (sans la marge au-dessus) : une boîte par ligne.
      const note = document.querySelector('.convert-note');
      const range = document.createRange();
      range.selectNodeContents(note);
      const tops = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
      return {
        lines: tops.size,
        numeric: getComputedStyle(document.querySelector('.item-detail')).fontVariantNumeric,
      };
    });
    return { ok: got.lines <= 2 && got.numeric.includes('tabular-nums'), detail: short(got) };
  });

  await test('convert : Tab atteint « Choisir des fichiers » et les réglages, focus visible', async () => {
    const page = await open();
    const seen = [];
    const weak = [];
    for (let i = 0; i < 16; i++) {
      await page.keyboard.press('Tab');
      const focus = await page.evaluate(() => {
        const el = document.activeElement;
        // Après le dernier bouton, Tab sort de la page : le focus revient sur body, qui n'est pas une action.
        if (el === document.body) return null;
        el.id ||= `probe-${Math.random().toString(36).slice(2, 8)}`;
        const style = getComputedStyle(el);
        return { id: el.id, text: el.textContent.trim(), style: style.outlineStyle, color: style.outlineColor };
      });
      if (!focus) continue;
      seen.push(focus.text || focus.id);
      if (focus.style === 'none') weak.push(focus.text || focus.id);
      else if (contrast(await resolveColor(page, focus.color), await resolveColor(page, await backgroundUnder(page, `#${focus.id}`, { outside: true }))) < 3) weak.push(focus.text || focus.id);
    }
    const ok = seen.includes('Choisir des fichiers') && seen.includes('JPG') && seen.includes('Origine') && weak.length === 0;
    return { ok, detail: short({ weak, seen: seen.map((s) => s.slice(0, 24)) }) };
  });

  for (const mode of MODES) {
    await test(`convert ${mode} : aucune violation axe, vide et avec des fichiers`, async () => {
      const page = await open();
      await page.emulateMedia({ colorScheme: mode });
      await page.waitForTimeout(300);
      const empty = (await axeViolations(page)).violations;
      if (ONLY === 'convert') await shoot(page, `convert-vide-${mode}`);
      await page.evaluate(dropImages, ['a.png', 'b.png']);
      await settled(page);
      await page.waitForTimeout(300);
      const full = (await axeViolations(page)).violations;
      if (ONLY === 'convert') await shoot(page, `convert-plein-${mode}`);
      return { ok: empty.length === 0 && full.length === 0, detail: [...empty, ...full].join(' | ') };
    });
  }
}

// ---- Transcription ----

const ACTIONS = ['copy', 'save-md', 'save-txt', 'save-srt', 'format'];
const actionsState = (page) =>
  page.evaluate((ids) => Object.fromEntries(ids.map((id) => {
    const el = document.getElementById(id);
    return [id, { hidden: el.hidden || !el.offsetParent, disabled: Boolean(el.disabled) }];
  })), ACTIONS);
const transcriptSettled = (page) =>
  page.waitForFunction(() => ['ready', 'error'].includes(document.body.dataset.state), null, { timeout: 70_000 }).then(() => page.evaluate(() => document.body.dataset.state));

async function groupTranscription(context, env) {
  const { youtubeRoute } = await import('./pages/youtube/cases.mjs');
  await youtubeRoute(context, []);
  const opened = [];
  const open = async (query = '') => {
    const page = await extensionPage(context, `transcript/transcript.html${query}`);
    opened.push(page);
    return page;
  };
  const test = async (name, run) => {
    await testOnce(name, run);
    while (opened.length) await opened.pop().close().catch(() => {});
  };

  await test('transcription : avant le résultat, Copier, .md, .txt, .srt, le format et leur aide sont cachés', async () => {
    const page = await open();
    const got = await actionsState(page);
    const hint = await page.evaluate(() => document.getElementById('files-hint').checkVisibility());
    return { ok: Object.values(got).every((x) => x.hidden) && !hint, detail: short({ got, hint }) };
  });

  await test('transcription : après le résultat, ils sont visibles et actifs ; plus de « Format » dans la colonne', async () => {
    const page = await open('?v=manuel00001');
    const state = await transcriptSettled(page);
    const got = await actionsState(page);
    const side = await page.evaluate(() => ({
      format: [...document.querySelectorAll('.app-side h2')].some((h) => /Format/.test(h.textContent)),
      inSide: Boolean(document.querySelector('.app-side #format')),
      times: [...document.querySelectorAll('#times button')].map((b) => b.textContent.trim()),
      numeric: getComputedStyle(document.getElementById('summary')).fontVariantNumeric,
    }));
    const ok = state === 'ready' && Object.values(got).every((x) => !x.hidden && !x.disabled) && !side.format && !side.inSide && side.times.join() === 'Paragraphes,Passages,Aucun' && side.numeric.includes('tabular-nums');
    return { ok, detail: short({ state, got, side }) };
  });

  await test('transcription : le choix de langue n’est jamais vide', async () => {
    const page = await open();
    const empty = await page.evaluate(() => document.getElementById('lang').selectedOptions[0]?.textContent.trim() ?? '');
    await page.goto(page.url().replace(/\?.*$/, '') + '?v=manuel00001');
    await transcriptSettled(page);
    const ready = await page.evaluate(() => document.getElementById('lang').selectedOptions[0]?.textContent.trim() ?? '');
    return { ok: empty === 'Langue de la vidéo' && ready.length > 0, detail: short({ empty, ready }) };
  });

  await test('transcription : « Transcrire » lisible, actif comme désactivé ; un seul anneau de focus sur le champ', async () => {
    const page = await open();
    await page.locator('#link').fill('https://www.youtube.com/watch?v=manuel00001');
    const colors = await page.evaluate(() => {
      const read = getComputedStyle(document.getElementById('read'));
      return { fg: read.color, bg: read.backgroundColor };
    });
    const active = contrast(await resolveColor(page, colors.fg), await resolveColor(page, colors.bg));
    const disabledBg = await page.evaluate(() => {
      const button = document.getElementById('read');
      button.disabled = true;
      const bg = getComputedStyle(button).backgroundColor;
      const opacity = getComputedStyle(button).opacity;
      button.disabled = false;
      return { bg, opacity };
    });
    const page_bg = await resolveColor(page, await backgroundUnder(page, '#read', { outside: true }));
    const mixed = (await resolveColor(page, disabledBg.bg)).map((v, i) => Math.round(v * disabledBg.opacity + page_bg[i] * (1 - disabledBg.opacity)));
    const disabled = contrast(mixed, page_bg);
    await page.locator('#link').focus();
    await page.keyboard.press('End');
    const rings = await page.evaluate(() => {
      const field = document.getElementById('link');
      const row = field.closest('.link-row');
      const own = getComputedStyle(field).outlineStyle !== 'none';
      const parent = row ? getComputedStyle(row).outlineStyle !== 'none' || /\d+px/.test(getComputedStyle(row).boxShadow) : false;
      return { own, parent };
    });
    const single = (rings.own ? 1 : 0) + (rings.parent ? 1 : 0) === 1;
    return { ok: active >= 4.5 && disabled >= 1.5 && single, detail: short({ active: active.toFixed(2), disabled: disabled.toFixed(2), rings }) };
  });

  await test('transcription : coller un nouveau lien recache les actions pendant la lecture', async () => {
    const page = await open('?v=manuel00001');
    await transcriptSettled(page);
    await page.evaluate(() => {
      // Ralentit la lecture suivante pour voir l'état intermédiaire.
      const real = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = async (msg, ...rest) => {
        if (msg?.type === 'transcript-read') await new Promise((r) => setTimeout(r, 1500));
        return real(msg, ...rest);
      };
    });
    await page.locator('#link').fill('https://www.youtube.com/watch?v=chapauto001');
    await page.locator('#read').click();
    await page.waitForFunction(() => document.body.dataset.state === 'loading', null, { timeout: 5000 });
    const during = await actionsState(page);
    return { ok: Object.values(during).every((x) => x.hidden), detail: short(during) };
  });

  await test('transcription : aucun libellé de segmenté coupé, et la page remplit la fenêtre', async () => {
    const page = await open('?v=manuel00001');
    await transcriptSettled(page);
    const got = await page.evaluate(() => ({
      cut: [...document.querySelectorAll('.segmented button')].filter((b) => b.scrollWidth > b.clientWidth).map((b) => `${b.textContent} ${b.scrollWidth}/${b.clientWidth}`),
      side: Math.round(document.querySelector('.segmented').getBoundingClientRect().width),
      gap: Math.round(window.innerHeight - document.querySelector('.app-body').getBoundingClientRect().bottom),
    }));
    return { ok: got.cut.length === 0 && got.gap <= 0, detail: short(got) };
  });

  await test('transcription : titre de vidéo de 200 caractères, en-tête de 56 px', async () => {
    const page = await open('?v=manuel00001');
    await transcriptSettled(page);
    const got = await page.evaluate(() => {
      document.getElementById('title').textContent = 'A'.repeat(200);
      const header = document.querySelector('.app-header');
      return { header: Math.round(header.getBoundingClientRect().height), overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    });
    return { ok: got.header === 56 && !got.overflow, detail: short(got) };
  });

  for (const mode of MODES) {
    await test(`transcription ${mode} : aucune violation axe, avant et après le résultat`, async () => {
      const page = await open();
      await page.emulateMedia({ colorScheme: mode });
      await page.waitForTimeout(300);
      const before = (await axeViolations(page)).violations;
      if (ONLY === 'transcription') await shoot(page, `transcription-avant-${mode}`);
      await page.goto(page.url().replace(/\?.*$/, '') + '?v=manuel00001');
      await transcriptSettled(page);
      await page.waitForTimeout(300);
      const after = (await axeViolations(page)).violations;
      if (ONLY === 'transcription') await shoot(page, `transcription-apres-${mode}`);
      return { ok: before.length === 0 && after.length === 0, detail: [...before, ...after].join(' | ') };
    });
  }
}

// ---- Gabarit commun et audit complet  ----

async function groupGabarit(context, env) {
  const all = await screens(context, env);
  try {
    await test('gabarit : en-tête de 56 px sur captures, convertisseur, transcription, confirmation, et barre de l’éditeur', async () => {
      const got = {};
      for (const name of ['captures', 'convert', 'transcription', 'appareils']) got[name] = await all[name].page.evaluate(() => Math.round(document.querySelector('.app-header')?.getBoundingClientRect().height ?? 0));
      got.editeur = await all.editeur.page.evaluate(() => Math.round(document.querySelector('#editor .editor-bar')?.getBoundingClientRect().height ?? 0));
      return { ok: Object.values(got).every((h) => h === 56), detail: short(got) };
    });
    await test('gabarit : colonne de 240 px sur captures, convertisseur, transcription', async () => {
      const got = {};
      for (const name of ['captures', 'convert', 'transcription']) got[name] = await all[name].page.evaluate(() => Math.round(document.querySelector('.app-side')?.getBoundingClientRect().width ?? 0));
      return { ok: Object.values(got).every((w) => w === 240), detail: short(got) };
    });
    await test('gabarit : aucun dégradé ni quadrillage sur body, .app-main, .mat et le fond de l’éditeur', async () => {
      const found = [];
      for (const [name, { page }] of Object.entries(all)) {
        const images = await page.evaluate(() => [...document.querySelectorAll('body, .app-main, .mat, #editor, #editor-scroll')].map((el) => getComputedStyle(el).backgroundImage).filter((v) => v && v !== 'none'));
        if (images.length) found.push(`${name}: ${images.join(',').slice(0, 80)}`);
      }
      return { ok: found.length === 0, detail: found.join(' | ') || 'aucun' };
    });
    await test('gabarit : le message d’erreur du panneau porte le pictogramme error', async () => {
      const ok = await all.panneau.page.evaluate(() => Boolean(document.querySelector('#error svg.icon-error')));
      return { ok, detail: String(ok) };
    });
    for (const mode of MODES) {
      await test(`gabarit ${mode} : premier Tab de chaque écran entouré de --focus`, async () => {
        const got = {};
        for (const [name, { page, ready }] of Object.entries(all)) {
          await page.emulateMedia({ colorScheme: mode });
          await ready();
          await page.evaluate(() => {
            document.activeElement?.blur();
            window.getSelection()?.removeAllRanges();
          });
          if (name === 'editeur') {
            // L'éditeur garde le focus en boucle et le pose lui-même sur son premier outil.
            await page.locator('#editor .editor-tool').first().focus();
            await page.keyboard.press('Tab');
            await page.keyboard.press('Shift+Tab');
          } else {
            await page.locator('body').click({ position: { x: 1, y: 1 } }).catch(() => {});
            await page.evaluate(() => document.activeElement?.blur());
            await page.keyboard.press('Tab');
          }
          const outline = await page.evaluate(() => (document.activeElement === document.body ? '' : getComputedStyle(document.activeElement).outlineColor));
          const focus = await resolveColor(page, 'var(--focus)');
          got[name] = outline ? colorDistance(await resolveColor(page, outline), focus).toFixed(1) : 'aucun focus';
        }
        return { ok: Object.values(got).every((d) => Number(d) < 3), detail: short(got) };
      });
      await test(`gabarit ${mode} : l’élément choisi porte l’accent (segmenté, outil actif)`, async () => {
        const got = {};
        const where = { captures: '.app-side .segmented [aria-pressed="true"]', convert: '#format [aria-pressed="true"]', transcription: '#times [aria-pressed="true"]', editeur: '#editor-tools [aria-pressed="true"]' };
        for (const [name, selector] of Object.entries(where)) {
          const { page } = all[name];
          await page.emulateMedia({ colorScheme: mode });
          const colors = await page.evaluate((selector) => {
            const el = document.querySelector(selector);
            if (!el) return null;
            const s = getComputedStyle(el);
            return [s.color, s.backgroundColor, s.borderTopColor];
          }, selector);
          if (!colors) {
            got[name] = 'absent';
            continue;
          }
          const accents = [await resolveColor(page, 'var(--accent)'), await resolveColor(page, 'var(--accent-text)')];
          let best = Infinity;
          for (const c of colors) if (!/rgba\(0, 0, 0, 0\)/.test(c)) for (const a of accents) best = Math.min(best, colorDistance(await resolveColor(page, c), a));
          got[name] = best.toFixed(1);
        }
        return { ok: Object.values(got).every((d) => Number(d) < 3), detail: short(got) };
      });
    }
  } finally {
    await closeScreens(all);
  }
}

async function groupAxe(context, env) {
  const all = await screens(context, env);
  try {
    for (const mode of MODES) {
      for (const [name, { page, ready }] of Object.entries(all)) {
        await test(`axe ${mode} : ${name} sans violation ni contraste illisible par axe`, async () => {
          await page.emulateMedia({ colorScheme: mode });
          await ready();
          await page.waitForTimeout(300);
          const { violations, result } = await axeViolations(page);
          const unsure = result.incomplete.filter((r) => r.id === 'color-contrast').flatMap((r) => r.nodes.map((n) => `${n.target.join(' ')} ${n.any?.[0]?.message ?? ''}`.slice(0, 140)));
          return { ok: violations.length === 0 && unsure.length === 0, detail: [...violations, ...unsure.slice(0, 4)].join(' | ') };
        });
      }
    }
  } finally {
    await closeScreens(all);
  }
}

// Lignes de `dir` (récursif) qui correspondent à `pattern`, sous la forme « fichier:ligne: texte ».
async function grep(pattern, dir, { skip, files = /\.(css|js|html|json)$/ } = {}) {
  const hits = [];
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !files.test(entry.name)) continue;
    const full = path.join(entry.parentPath, entry.name);
    if (skip?.test(full)) continue;
    (await fs.readFile(full, 'utf8')).split('\n').forEach((line, i) => {
      if (pattern.test(line)) hits.push(`${path.relative(dir, full)}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  return hits;
}

async function groupPhotos(context, env) {
  const all = await screens(context, env);
  try {
    for (const mode of MODES) {
      for (const [name, { page, ready }] of Object.entries(all)) {
        await page.emulateMedia({ colorScheme: mode });
        await ready();
        await page.waitForTimeout(200);
        await shoot(page, `${name}-${mode}`, { fullPage: name === 'panneau' });
      }
    }
    const youtube = await openPanel(context, env, { url: YOUTUBE_URL });
    for (const mode of MODES) {
      await youtube.emulateMedia({ colorScheme: mode });
      await youtube.waitForTimeout(200);
      await shoot(youtube, `panneau-youtube-${mode}`, { fullPage: true });
    }
    await youtube.close();
    // la transcription aussi après résultat (vidéo imitée).
    const { youtubeRoute } = await import('./pages/youtube/cases.mjs');
    await youtubeRoute(context, []);
    const read = await extensionPage(context, 'transcript/transcript.html?v=manuel00001');
    await transcriptSettled(read);
    for (const mode of MODES) {
      await read.emulateMedia({ colorScheme: mode });
      await read.waitForTimeout(200);
      await shoot(read, `transcription-resultat-${mode}`);
    }
    await read.close();
  } finally {
    await closeScreens(all);
  }
  const files = await fs.readdir(path.join(WORK, 'photos'));
  console.log(`${files.length} captures dans ${path.join(WORK, 'photos')}`);
}

const GROUPS = { tokens: groupTokens, demo: groupDemo, icone: groupIcone, panneau: groupPanneau, appareils: groupAppareils, captures: groupCaptures, editeur: groupEditeur, convert: groupConvert, transcription: groupTranscription, gabarit: groupGabarit, axe: groupAxe, photos: groupPhotos };
const ON_DEMAND = new Set(['photos']);

async function main() {
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(WORK, { recursive: true });
  setPhotoDir(path.join(WORK, 'photos'));
  if (ONLY && !GROUPS[ONLY]) throw new Error(`groupe inconnu : ${ONLY}`);
  const extension = await prepareExtension(WORK);
  const server = await serve(path.join(HERE, 'pages'));
  const base = `http://127.0.0.1:${server.address().port}`;
  const context = await launch(extension, `profile-${RUN}`, WORK);
  try {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const env = { base, sw, extensionId: new URL(sw.url()).host, work: WORK };
    for (const [name, group] of Object.entries(GROUPS)) {
      if (ONLY ? ONLY !== name : ON_DEMAND.has(name)) continue;
      console.log(`\n— ${name}`);
      await group(context, env);
    }
  } finally {
    await context.close();
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
