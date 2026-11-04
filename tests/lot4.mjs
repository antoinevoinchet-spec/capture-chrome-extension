// Tests du lot 4 : téléphone, tablette, ordinateur.
// Usage : node lot4.mjs <dossier de sortie> [essai|scenarios|reelle|appareils|groupe|site|long|visible|direct] [motif]
// `site` (un vrai site, dont l'adresse est obligatoire dans SITE_URL), `long` (100 000 points), `visible` et `direct` (une vraie fenêtre) ne tournent que si on les nomme.

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { EXTENSION, MANIFEST_EXPECTED, capture, check, extensionPage, launch, openTab, prepareExtension, results, seedCapture } from './lib.mjs';

const run = promisify(execFile);
const HERE = import.meta.dirname;
const WORK = path.resolve(process.argv[2] ?? path.join(HERE, 'out-lot4'));
const ONLY = process.argv[3];
const NAMED = process.argv[4] ? new RegExp(process.argv[4], 'i') : null;
const SITE_URL = process.env.SITE_URL;
const LAZY_COLOR = [20, 90, 60];

async function test(name, body) {
  if (NAMED && !NAMED.test(name)) return;
  try {
    const { ok, detail } = await body();
    check(name, ok, detail);
  } catch (err) {
    check(name, false, String(err.message ?? err).split('\n')[0].slice(0, 240));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const near = (a, b, tolerance = 12) => a?.length && a.every((value, i) => Math.abs(value - b[i]) <= tolerance);

// Un petit PNG d'une seule couleur, écrit à la main : la page témoin n'a besoin de rien d'autre.
function solidPng(rgb) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(4, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.from([0, ...rgb, ...rgb, ...rgb, ...rgb]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat([row, row, row, row]))), chunk('IEND', Buffer.alloc(0))]);
}

// Deux serveurs (deux origines) : l'image paresseuse, et une redirection qui n'envoie que les mobiles vers l'autre origine (m.site.fr).
async function servers() {
  const stats = { lazy: 0, measures: [], fragile: 0 };
  const lazy = solidPng(LAZY_COLOR);
  const pages = path.join(HERE, 'pages');
  let other = '';
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/lazy.png') {
      stats.lazy++;
      return res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }).end(lazy);
    }
    if (url.pathname === '/measure') {
      let body = '';
      for await (const chunk of req) body += chunk;
      stats.measures.push(JSON.parse(body));
      return res.writeHead(204).end();
    }
    // Une page qui répond une fois, puis plus du tout : la capture rencontre une vraie erreur de chargement.
    if (url.pathname === '/fragile') {
      if (stats.fragile-- <= 0) return res.destroy();
      url.pathname = '/device-probe.html';
    }
    if (url.pathname === '/redirect' && /iPhone|iPad/.test(req.headers['user-agent'] ?? '')) {
      return res.writeHead(302, { location: `${other}/device-probe.html?from=redirect` }).end();
    }
    if (url.pathname === '/redirect') url.pathname = '/device-probe.html';
    try {
      const body = await fs.readFile(path.join(pages, path.basename(url.pathname)));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  const listen = (s) => new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`)));
  const second = http.createServer(server.listeners('request')[0]);
  const base = await listen(server);
  other = await listen(second);
  return { base, other, stats, close: () => (server.close(), second.close()) };
}

// Installé dans le service worker de la copie de test : lance une capture et rend ce qu'il faut pour la juger.
function installHelpers() {
  // Les onglets temporaires, lus dans l'état que la capture publie.
  self.tempIds = new Set();
  chrome.storage.onChanged.addListener((changes) => {
    const tempId = changes.capturing?.newValue?.tempId;
    if (tempId) self.tempIds.add(tempId);
  });
  self.leftovers = async () => {
    const tabs = (await chrome.tabs.query({})).filter(({ id }) => self.tempIds.has(id));
    const targets = (await chrome.debugger.getTargets()).filter(({ tabId }) => self.tempIds.has(tabId));
    return { seen: self.tempIds.size, tabs: tabs.length, targets: targets.length };
  };
  // Le groupe d'une capture enregistrée, relu en base.
  self.groupSummary = async (id) => {
    const order = ['telephone', 'tablette', 'ordinateur'];
    const all = await self.listCapturesForTest();
    const first = all.find((capture) => capture.id === id);
    const members = all.filter((capture) => first?.group && capture.group?.id === first.group.id).sort((a, b) => order.indexOf(a.group.device) - order.indexOf(b.group.device));
    return { firstDevice: first?.group?.device ?? null, count: members.length, devices: await Promise.all(members.map((record) => self.summaryOf({ record, measure: null }))) };
  };
  self.measureAfterLoad = async (send) => {
    const expression = `(async () => {
      const raf = await new Promise((resolve) => {
        requestAnimationFrame(() => resolve(true));
        setTimeout(() => resolve(false), 1500);
      });
      return {
        href: location.href,
        innerWidth,
        innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        maxTouchPoints: navigator.maxTouchPoints,
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        dpr: devicePixelRatio,
        coarse: matchMedia('(pointer: coarse)').matches,
        narrow: matchMedia('(max-width: 600px)').matches,
        visibility: document.visibilityState,
        hasFocus: document.hasFocus(),
        raf,
      };
    })()`;
    const { result } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return result.value;
  };
  const pixel = async (blob, x, y) => {
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(1, 1);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, x, y, 1, 1, 0, 0, 1, 1);
    bmp.close();
    return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
  };
  const summary = async ({ record, measure }) => {
    const { slices, scale, crop } = record;
    const first = await createImageBitmap(slices[0].blob);
    const size = { width: first.width, height: first.height };
    first.close();
    const x = Math.round(crop.w / 2);
    const lastY = Math.max(0, record.height - slices.at(-1).y - Math.round(100 * scale));
    return {
      device: record.group.device,
      ...size,
      recordWidth: record.width,
      recordHeight: record.height,
      scale,
      sliceCount: slices.length,
      title: record.title,
      url: record.url,
      truncated: record.truncated,
      measure,
      marker: await pixel(slices[0].blob, x, Math.round(100 * scale)),
      headerFirst: await pixel(slices[0].blob, x, Math.round(10 * scale)),
      headerNext: slices.length > 1 ? await pixel(slices[1].blob, x, Math.round(10 * scale)) : null,
      bottom: await pixel(slices.at(-1).blob, x, lastY),
      bytes: slices.reduce((sum, slice) => sum + slice.blob.size, 0),
    };
  };
  self.summaryOf = summary;
  self.runEssai = async (tabId, opts = {}) => {
    const real = await chrome.tabs.get(tabId);
    const origin = 'url' in opts ? { ...real, url: opts.url } : real;
    const started = Date.now();
    let tempId = null;
    let halt = null;
    let fired = false;
    const onProgress = async ({ done }) => {
      if (fired || !opts.scenario || !done) return;
      fired = true;
      if (opts.scenario === 'cancel') halt(new self.DevicesCancelled('user'));
      if (opts.scenario === 'close-temp') await chrome.tabs.remove(tempId);
      if (opts.scenario === 'close-origin') await chrome.tabs.remove(tabId);
      if (opts.scenario === 'detach') await chrome.debugger.detach({ tabId: tempId });
    };
    const finish = async (out) => {
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      const leftTab = tempId ? await chrome.tabs.get(tempId).catch(() => null) : null;
      const targets = await chrome.debugger.getTargets();
      return { ...out, seconds, tempId, tempLeft: Boolean(leftTab), targetLeft: targets.some((target) => target.tabId === tempId) };
    };
    try {
      const out = await self.captureDevicesForTest(origin, {
        ...opts.capture,
        ...(opts.only ? { devices: self.DevicesForTest.filter(({ key }) => key === opts.only) } : {}),
        afterLoad: self.measureAfterLoad,
        onStart: (info) => {
          tempId = info.tempId;
          halt = info.halt;
        },
        onProgress,
      });
      if (opts.keep) self.lastRecords = out.map(({ record }) => record);
      const devices = opts.light ? out.map(({ record }) => ({ device: record.group.device, sliceCount: record.slices.length, bytes: record.slices.reduce((sum, slice) => sum + slice.blob.size, 0), recordHeight: record.height, truncated: record.truncated })) : await Promise.all(out.map(summary));
      return await finish({ ok: true, devices });
    } catch (err) {
      return await finish({ ok: false, error: String(err?.message ?? err), kind: err?.constructor?.name });
    }
  };
  // L'image assemblée d'un appareil, pour pouvoir la regarder.
  self.composeRecord = async (index) => {
    const record = self.lastRecords[index];
    const canvas = new OffscreenCanvas(record.width, Math.min(record.height, 16000));
    const ctx = canvas.getContext('2d');
    for (const slice of record.slices) {
      if (slice.y >= canvas.height) break;
      const bmp = await createImageBitmap(slice.blob);
      const { x, y, w, h } = record.crop;
      ctx.drawImage(bmp, x, y, w, h, 0, slice.y, w, h);
      bmp.close();
    }
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = '';
    for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return { device: record.group.device, base64: btoa(text) };
  };
}

const runEssai = (sw, tabId, opts) => sw.evaluate(({ tabId, opts }) => self.runEssai(tabId, opts), { tabId, opts });
const originState = (page) => page.evaluate(() => ({ href: location.href, ua: navigator.userAgent, innerWidth, value: document.getElementById('saisie')?.value ?? null }));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function originPage(context, sw, base, address = '/device-probe.html?origin=1') {
  const opened = await openTab(context, sw, `${base}${address}`);
  await opened.page.evaluate(() => document.body.insertAdjacentHTML('afterbegin', '<input id="saisie" />'));
  await opened.page.fill('#saisie', 'texte saisi');
  return opened;
}

const report = async (name, value) => {
  await fs.appendFile(path.join(WORK, 'mesures.jsonl'), `${JSON.stringify({ name, value })}\n`);
};

// --- Essai : la page témoin, 3 fois ---

async function groupEssai(context, sw, env) {
  console.log('\n— Essai sur la page témoin');
  const { base, other, stats } = env;
  for (let trial = 1; trial <= 3; trial++) {
    const { page, tabId } = await originPage(context, sw, base);
    const before = await originState(page);
    stats.lazy = 0;
    const out = await runEssai(sw, tabId, {});
    await report(`temoin-${trial}`, out);
    const [telephone, tablette, ordinateur] = out.devices ?? [];
    await test(`essai ${trial} : la capture aboutit en 45 s au plus sur 5 000 points`, async () => ({ ok: out.ok && out.seconds <= 45, detail: `${out.seconds} s ${out.error ?? ''}` }));
    await test(`essai ${trial} : largeurs 780 et 1 640 px à 2 px près, ordinateur à la taille réelle`, async () => ({
      ok: Math.abs(telephone.width - 780) <= 2 && Math.abs(tablette.width - 1640) <= 2 && ordinateur.width === 2560,
      detail: `${telephone.width} ${tablette.width} ${ordinateur.width}`,
    }));
    await test(`essai ${trial} : bon marqueur CSS par appareil, lu sur l'image`, async () => ({
      ok: near(telephone.marker, [255, 0, 0]) && near(tablette.marker, [0, 255, 0]) && near(ordinateur.marker, [0, 0, 255]),
      detail: `${telephone.marker} / ${tablette.marker} / ${ordinateur.marker}`,
    }));
    await test(`essai ${trial} : tactile et identité sous émulation, puis identité réelle sur l'ordinateur`, async () => ({
      ok: telephone.measure.maxTouchPoints > 0 && tablette.measure.maxTouchPoints > 0 && /iPhone/.test(telephone.measure.userAgent) && /iPad/.test(tablette.measure.userAgent) && before.ua === ordinateur.measure.userAgent && ordinateur.measure.maxTouchPoints === 0,
      detail: `${telephone.measure.maxTouchPoints} ${tablette.measure.maxTouchPoints} ${ordinateur.measure.maxTouchPoints} ; ${ordinateur.measure.userAgent === before.ua}`,
    }));
    await test(`essai ${trial} : pas de débordement horizontal`, async () => ({
      ok: out.devices.every(({ measure }) => measure.scrollWidth <= measure.innerWidth),
      detail: out.devices.map(({ measure }) => `${measure.scrollWidth}/${measure.innerWidth}`).join(' '),
    }));
    await test(`essai ${trial} : image paresseuse du bas présente sur l'image`, async () => ({
      ok: out.devices.every(({ bottom }) => near(bottom, LAZY_COLOR)) && stats.lazy >= 1,
      detail: `${out.devices.map(({ bottom }) => bottom).join(' / ')} ; ${stats.lazy} chargements`,
    }));
    await test(`essai ${trial} : en-tête fixe présent une seule fois`, async () => ({
      ok: out.devices.every(({ headerFirst, headerNext }) => near(headerFirst, [255, 0, 170]) && headerNext && !near(headerNext, [255, 0, 170])),
      detail: out.devices.map(({ headerFirst, headerNext }) => `${headerFirst}→${headerNext}`).join(' / '),
    }));
    await test(`essai ${trial} : onglet d'origine intact, plus d'onglet temporaire`, async () => {
      const after = await originState(page);
      return { ok: same(before, after) && !out.tempLeft && !out.targetLeft, detail: JSON.stringify(after).slice(0, 120) };
    });
    await page.close();
  }

  const { page, tabId } = await openTab(context, sw, `${base}/redirect`);
  const out = await runEssai(sw, tabId, {});
  await report('redirection', out);
  await test('essai : redirection vers une autre origine, mobile seulement', async () => {
    const [telephone, tablette, ordinateur] = out.devices;
    return { ok: out.ok && telephone.url.startsWith(other) && tablette.url.startsWith(other) && ordinateur.url.startsWith(base) && near(telephone.marker, [255, 0, 0]), detail: `${telephone.url} ${ordinateur.url}` };
  });
  await page.close();
}

// --- Les 5 sorties ---

async function groupScenarios(context, sw, env) {
  console.log('\n— Les 5 sorties');
  const { base } = env;
  for (const [label, opts] of [
    ['annulation', { scenario: 'cancel' }],
    ['onglet temporaire fermé', { scenario: 'close-temp' }],
    ['détachement forcé', { scenario: 'detach' }],
    ['erreur', { url: 'http://127.0.0.1:9/mort' }],
  ]) {
    for (let trial = 1; trial <= 3; trial++) {
      const { page, tabId } = await originPage(context, sw, base);
      const before = await originState(page);
      const out = await runEssai(sw, tabId, opts);
      await report(`${label}-${trial}`, out);
      const after = await originState(page);
      await test(`sortie ${label} ${trial} : origine intacte, rien ne reste`, async () => ({
        ok: !out.ok && same(before, after) && !out.tempLeft && !out.targetLeft,
        detail: `${out.kind} : ${out.error} (${out.seconds} s)`,
      }));
      await page.close();
    }
  }
  await test('sortie onglet d’origine fermé : rien ne reste', async () => {
    const { tabId } = await originPage(context, sw, base);
    const out = await runEssai(sw, tabId, { scenario: 'close-origin' });
    await report('origine-fermee', out);
    return { ok: !out.ok && out.kind === 'DevicesCancelled' && !out.tempLeft && !out.targetLeft, detail: `${out.kind} : ${out.error}` };
  });
  await test('refus : page interdite', async () => {
    const { page, tabId } = await originPage(context, sw, base);
    const out = await runEssai(sw, tabId, { url: 'chrome://settings/' });
    await page.close();
    return { ok: !out.ok && /interdit/.test(out.error) && !out.tempId, detail: out.error };
  });
}

// --- La vraie extension, sans accès aux sites ---

async function groupReelle(context, sw, env) {
  console.log('\n— La vraie extension, sans accès aux sites');
  const { base } = env;
  const { page, tabId } = await openTab(context, sw, `${base}/device-probe.html?origin=1`);
  const hosts = await sw.evaluate(() => chrome.permissions.contains({ origins: ['http://*/*'] }));
  const out = await runEssai(sw, tabId, { url: `${base}/device-probe.html` });
  await report('reelle', out);
  await test('vraie extension : le débogueur suffit, sans accès aux sites', async () => ({
    ok: hosts === false && out.ok && out.devices[0].width === 780 && out.devices[1].width === 1640 && near(out.devices[0].marker, [255, 0, 0]) && near(out.devices.at(-1).bottom, LAZY_COLOR),
    detail: `hôtes ${hosts} ; ${out.error ?? out.devices.map(({ width }) => width).join(' ')}`,
  }));
  await test("vraie extension : hors du clic sur l'icône, l'adresse est illisible et le message le dit", async () => {
    const stored = await sw.evaluate(async (tabId) => (await chrome.tabs.get(tabId)).url ?? null, tabId);
    const id = await sw.evaluate((tabId) => self.captureTab(tabId, 'devices'), tabId);
    const error = (await sw.evaluate(() => chrome.storage.session.get('lastError'))).lastError?.message ?? '';
    return { ok: stored === null && !id && /icône/.test(error), detail: `adresse ${stored} ; ${error}` };
  });
  await page.close();
}

// --- Trois appareils en une action ---

const capturing = (sw) => sw.evaluate(async () => (await chrome.storage.session.get('capturing')).capturing ?? null);

async function waitCapturing(sw, wanted, timeout = 60_000) {
  const limit = Date.now() + timeout;
  while (Date.now() < limit) {
    const state = await capturing(sw);
    if (wanted(state)) return state;
    await sleep(100);
  }
  throw new Error(`état de capture attendu non atteint : ${JSON.stringify(await capturing(sw))}`);
}

const firstImage = (state) => state?.done >= 1;
const startDevices = (sw, tabId) =>
  sw.evaluate((tabId) => {
    self.devicesRun = self.captureTab(tabId, 'devices');
  }, tabId);
const endDevices = (sw) => sw.evaluate(() => self.devicesRun);
const storedCount = (sw) => sw.evaluate(async () => (await self.listCapturesForTest()).length);
const closeExtras = async (context) => {
  for (const page of context.pages()) if (/popup\/popup\.html|viewer\/viewer\.html/.test(page.url())) await page.close();
};
// Ce qu'une sortie a dit à la personne. La fenêtre ouverte pour afficher un refus efface `lastError` en le lisant : le titre de l'icône le garde.
const silence = (sw, tabId) =>
  sw.evaluate(async (tabId) => {
    const title = await chrome.action.getTitle({ tabId }).catch(() => '');
    return {
      badge: await chrome.action.getBadgeText({ tabId }).catch(() => ''),
      error: (await chrome.storage.session.get('lastError')).lastError?.message ?? (title.startsWith('Capture impossible') ? title : null),
    };
  }, tabId);

// La fenêtre de l'icône, dans sa propre fenêtre de navigateur. L'onglet « actif » qu'elle lit est remplacé par l'onglet à capturer.
async function openPopup(context, sw, tabId) {
  const opening = context.waitForEvent('page', { predicate: (page) => page.url().includes('/popup/popup.html') });
  await sw.evaluate(() => chrome.windows.create({ url: chrome.runtime.getURL('popup/popup.html'), type: 'popup', width: 320, height: 620, focused: false }));
  const popup = await opening;
  await popup.addInitScript((tabId) => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (info) => (info.active ? [await chrome.tabs.get(tabId)] : query(info));
  }, tabId);
  await popup.reload();
  await popup.waitForSelector('#devices');
  return popup;
}

async function groupAppareils(context, sw, env) {
  console.log('\n— Trois appareils en une action');
  const { base, stats } = env;
  const probe = '/device-probe.html?origin=1&beacon=1';

  await test('manifeste : version 0.5.0 et permissions exactes, sans accès aux sites', async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(EXTENSION, 'manifest.json'), 'utf8'));
    const ok = manifest.version === '0.5.0' && MANIFEST_EXPECTED.version === '0.5.0' && same(manifest.permissions, MANIFEST_EXPECTED.permissions) && manifest.permissions.includes('debugger') && !manifest.host_permissions;
    return { ok, detail: `${manifest.version} ; ${manifest.permissions}` };
  });

  // Une capture réussie, par le même chemin qu'un clic.
  const { page, tabId } = await originPage(context, sw, base, probe);
  await sleep(400);
  const before = await originState(page);
  stats.measures = [];
  stats.lazy = 0;
  const done = await capture(context, sw, tabId, 'devices');
  const group = done.id ? await sw.evaluate((id) => self.groupSummary(id), done.id) : { count: 0, devices: [] };
  await report('appareils', { done: done.id, error: done.error, seconds: done.seconds, group });
  const [telephone, tablette, ordinateur] = group.devices;
  const [mobile, tall, desk] = stats.measures;

  await test("appareils : le groupe est enregistré, et la page de résultats s'ouvre sur le téléphone", async () => ({
    ok: group.count === 3 && group.firstDevice === 'telephone' && Boolean(done.viewer),
    detail: `${done.error ?? ''} ${group.count} captures, ${group.firstDevice}, ${done.seconds} s`,
  }));
  await test('appareils : largeur des images égale à largeur × densité, à 2 px près', async () => ({
    ok: Math.abs(telephone.width - 780) <= 2 && Math.abs(tablette.width - 1640) <= 2,
    detail: `${telephone.width} ${tablette.width}`,
  }));
  await test('appareils : bon marqueur CSS par appareil', async () => ({
    ok: near(telephone.marker, [255, 0, 0]) && near(tablette.marker, [0, 255, 0]) && near(ordinateur.marker, [0, 0, 255]),
    detail: `${telephone.marker} / ${tablette.marker} / ${ordinateur.marker}`,
  }));
  await test('appareils : maxTouchPoints et identité sous émulation', async () => ({
    ok: mobile.maxTouchPoints > 0 && tall.maxTouchPoints > 0 && /iPhone/.test(mobile.userAgent) && /iPad/.test(tall.userAgent) && desk.maxTouchPoints === 0 && desk.userAgent === before.ua,
    detail: `${mobile.maxTouchPoints} ${tall.maxTouchPoints} ${desk.maxTouchPoints}`,
  }));
  await test('appareils : pas de débordement horizontal', async () => ({
    ok: stats.measures.every(({ scrollWidth, innerWidth }) => scrollWidth <= innerWidth) && mobile.innerWidth === 390 && tall.innerWidth === 820,
    detail: stats.measures.map(({ scrollWidth, innerWidth }) => `${scrollWidth}/${innerWidth}`).join(' '),
  }));
  await test('appareils : image paresseuse du bas chargée', async () => ({
    ok: group.devices.every(({ bottom }) => near(bottom, LAZY_COLOR)),
    detail: group.devices.map(({ bottom }) => bottom).join(' / '),
  }));
  await test('appareils : éléments fixes masqués', async () => ({
    ok: group.devices.every(({ headerFirst, headerNext }) => near(headerFirst, [255, 0, 170]) && headerNext && !near(headerNext, [255, 0, 170])),
    detail: group.devices.map(({ headerFirst, headerNext }) => `${headerFirst}→${headerNext}`).join(' / '),
  }));
  await test('appareils : ordinateur à la taille et à la densité réelles de la fenêtre', async () => ({
    ok: desk.innerWidth === before.innerWidth && desk.dpr === 2 && ordinateur.scale === 2 && ordinateur.width === before.innerWidth * 2,
    detail: `${desk.innerWidth}/${before.innerWidth}, densité ${desk.dpr}, ${ordinateur.width} px`,
  }));

  // Les sorties, chacune avec une vraie capture lancée. `act` agit une fois la première image prise.
  const outcomes = [{ label: 'succès', before, after: await originState(page), left: await sw.evaluate(() => self.leftovers()), id: done.id }];
  await closeExtras(context);
  const exit = async (label, address, act) => {
    const opened = await originPage(context, sw, base, address);
    const start = await originState(opened.page);
    const stored = await storedCount(sw);
    await startDevices(sw, opened.tabId);
    if (act) await act(opened);
    const id = await endDevices(sw);
    const left = await sw.evaluate(() => self.leftovers());
    const outcome = { label, before: start, after: await originState(opened.page), left, id, added: (await storedCount(sw)) - stored, noise: await silence(sw, opened.tabId) };
    outcomes.push(outcome);
    await closeExtras(context);
    await opened.page.close();
    return outcome;
  };
  const cancelled = await exit('annulation', probe, async (opened) => {
    await waitCapturing(sw, firstImage);
    const popup = await openPopup(context, sw, opened.tabId);
    await popup.waitForSelector('#cancel:not([hidden])', { timeout: 5000 });
    await popup.click('#cancel');
  });
  const closed = await exit('onglet temporaire fermé', probe, async () => {
    const { tempId } = await waitCapturing(sw, firstImage);
    await sw.evaluate((tempId) => chrome.tabs.remove(tempId), tempId);
  });
  const detached = await exit('détachement forcé', probe, async () => {
    const { tempId } = await waitCapturing(sw, firstImage);
    await sw.evaluate((tempId) => chrome.debugger.detach({ tabId: tempId }), tempId);
  });
  stats.fragile = 1;
  const failed = await exit('erreur', '/fragile?origin=1');

  await test("remise en état : onglet d'origine intact après succès, annulation, onglet fermé, détachement forcé et erreur", async () => ({
    ok: outcomes.every(({ before, after }) => same(before, after)),
    detail: outcomes.filter(({ before, after }) => !same(before, after)).map(({ label, after }) => `${label} ${JSON.stringify(after).slice(0, 80)}`).join(' ; ') || `${outcomes.length} sorties`,
  }));
  await test("remise en état : plus d'onglet temporaire ni d'attachement", async () => {
    const final = await sw.evaluate(() => self.leftovers());
    return { ok: final.seen >= 4 && final.tabs === 0 && final.targets === 0 && outcomes.every(({ left }) => left.tabs === 0 && left.targets === 0), detail: JSON.stringify(final) };
  });
  await test('annuler et onglet temporaire fermé : aucune capture, aucun message parasite', async () => ({
    ok: [cancelled, closed].every(({ id, added, noise }) => !id && added === 0 && !noise.error && noise.badge === ''),
    detail: JSON.stringify([cancelled, closed].map(({ id, added, noise }) => ({ id, added, noise }))),
  }));
  await test('détachement forcé : message en français qui dit quoi faire', async () => ({
    ok: !detached.id && detached.added === 0 && /débogueur/.test(detached.noise.error ?? '') && /Relance/.test(detached.noise.error ?? '') && !/Debugger/.test(detached.noise.error ?? ''),
    detail: detached.noise.error,
  }));
  await test('erreur de chargement : message en français qui dit quoi faire, aucune capture', async () => ({
    ok: !failed.id && failed.added === 0 && /ne s'est pas chargée/.test(failed.noise.error ?? '') && /Relance|relance/.test(failed.noise.error ?? ''),
    detail: failed.noise.error,
  }));

  await test("onglet d'origine fermé : aucune capture, aucun message", async () => {
    const opened = await originPage(context, sw, base);
    const stored = await storedCount(sw);
    await startDevices(sw, opened.tabId);
    await waitCapturing(sw, firstImage);
    await opened.page.close();
    const id = await endDevices(sw);
    const left = await sw.evaluate(() => self.leftovers());
    const error = (await silence(sw, opened.tabId)).error;
    return { ok: !id && (await storedCount(sw)) === stored && left.tabs === 0 && !error, detail: JSON.stringify({ id, left, error }) };
  });

  // La fenêtre de l'icône.
  const held = await originPage(context, sw, base, probe);
  const popup = await openPopup(context, sw, held.tabId);
  await test("fenêtre : le bouton annonce le bandeau et l'état initial, sans parler de sa couleur", async () => {
    const label = (await popup.locator('#devices').innerText()).replace(/\s+/g, ' ');
    await popup.screenshot({ path: path.join(WORK, 'fenetre.png') });
    return { ok: /Téléphone, tablette, ordinateur/.test(label) && /bandeau/.test(label) && /état initial/.test(label) && !/jaune/.test(label), detail: label };
  });
  await test("fenêtre : le clic lance la capture, indique l'appareil, et une capture à la fois", async () => {
    await popup.click('#devices');
    await waitCapturing(sw, firstImage);
    await popup.waitForFunction(() => /Téléphone/.test(document.getElementById('status-text').textContent));
    const shown = await popup.evaluate(() => ({ text: document.getElementById('status-text').textContent, cancel: !document.getElementById('cancel').hidden, off: document.getElementById('devices').disabled }));
    const busy = await popup.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'capture-devices', tabId }), held.tabId);
    return { ok: shown.cancel && shown.off && busy?.ok === false && /déjà en cours/.test(busy.error), detail: `${shown.text} ; ${busy?.error}` };
  });
  await test("fenêtre : rouverte, elle retrouve l'appareil en cours et « Annuler »", async () => {
    await popup.reload();
    await popup.waitForSelector('#cancel:not([hidden])', { timeout: 5000 });
    await popup.screenshot({ path: path.join(WORK, 'fenetre-en-cours.png') });
    const text = await popup.locator('#status-text').innerText();
    await popup.click('#cancel');
    await waitCapturing(sw, (state) => !state);
    const free = await popup.evaluate(() => !document.getElementById('devices').disabled && document.getElementById('status').hidden);
    return { ok: /Téléphone|Tablette|Ordinateur/.test(text) && free, detail: `${text} ; fenêtre libérée : ${free}` };
  });
  await popup.close();
  await held.page.close();

  await test('refus : page interdite', async () => {
    const { page: internal, tabId: internalId } = await openTab(context, sw, 'chrome://version');
    const opened = await sw.evaluate((id) => self.captureTab(id, 'devices'), internalId);
    const noise = await silence(sw, internalId);
    const url = await sw.evaluate(async (id) => (await chrome.tabs.get(id)).url ?? null, internalId);
    await closeExtras(context);
    await internal.close();
    return { ok: !opened && /interdit/.test(noise.error ?? ''), detail: `adresse ${url} ; ${noise.error}` };
  });
  await test('refus : fichier local, message qui oriente vers « Page entière »', async () => {
    const { page: local, tabId: localId } = await openTab(context, sw, `${base}/device-probe.html`);
    const out = await runEssai(sw, localId, { url: 'file:///tmp/page.html' });
    await local.close();
    return { ok: !out.ok && /Page entière/.test(out.error) && !out.tempId, detail: out.error };
  });
  await test('refus : adresse illisible, message qui dit de cliquer sur l’icône', async () => {
    const { page: local, tabId: localId } = await openTab(context, sw, `${base}/device-probe.html`);
    const out = await runEssai(sw, localId, { url: null });
    await local.close();
    return { ok: !out.ok && /icône/.test(out.error) && !out.tempId, detail: out.error };
  });
  await test('refus : débogueur refusé', async () => {
    const opened = await originPage(context, sw, base);
    await sw.evaluate(() => {
      self.realAttach = chrome.debugger.attach;
      chrome.debugger.attach = () => Promise.reject(new Error('Another debugger is already attached to the tab'));
    });
    const stored = await storedCount(sw);
    const id = await sw.evaluate((id) => self.captureTab(id, 'devices'), opened.tabId);
    await sw.evaluate(() => {
      chrome.debugger.attach = self.realAttach;
    });
    const noise = await silence(sw, opened.tabId);
    const left = await sw.evaluate(() => self.leftovers());
    await closeExtras(context);
    await opened.page.close();
    return { ok: !id && (await storedCount(sw)) === stored && /a refusé le débogueur/.test(noise.error ?? '') && left.tabs === 0, detail: noise.error };
  });
  await test('appareils : une boîte de dialogue de la page ne bloque pas la capture', async () => {
    const { page: local, tabId: localId } = await openTab(context, sw, `${base}/device-probe.html?header=0`);
    const out = await Promise.race([runEssai(sw, localId, { url: `${base}/device-probe.html?alert=1&h=1500`, only: 'telephone' }), sleep(40_000).then(() => ({ ok: false, error: 'bloquée au-delà de 40 s' }))]);
    await local.close();
    return { ok: out.ok, detail: out.error ?? `${out.seconds} s` };
  });
  await test('appareils : truncated posé au-delà de 100 000 points', async () => {
    const { page: local, tabId: localId } = await openTab(context, sw, `${base}/device-probe.html?header=0`);
    const out = await runEssai(sw, localId, { url: `${base}/device-probe.html?header=0&h=100600`, only: 'telephone', light: true });
    await local.close();
    const [device] = out.devices ?? [];
    return { ok: out.ok && device.truncated === true && device.recordHeight <= 200_000, detail: out.error ?? `${device.recordHeight} px, ${device.sliceCount} tranches, ${out.seconds} s` };
  });

  await test('endormissement forcé en pleine capture : au réveil, plus d’onglet temporaire ni de fenêtre bloquée', async () => {
    const opened = await originPage(context, sw, base);
    const admin = await context.newPage();
    await admin.goto(`chrome-extension://${new URL(sw.url()).host}/popup/popup.html`);
    await startDevices(sw, opened.tabId);
    const { tempId } = await waitCapturing(sw, firstImage);
    const cdp = await context.newCDPSession(admin);
    const stopped = new Promise((resolve) => {
      cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
        if (versions.some((version) => version.runningStatus === 'stopped')) resolve(true);
      });
    });
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    const asleep = await Promise.race([stopped, sleep(5000).then(() => false)]);
    await cdp.detach();
    await admin.reload();
    await admin.waitForSelector('#cancel:not([hidden])', { timeout: 5000 });
    await admin.click('#cancel');
    await admin.waitForFunction(() => document.getElementById('status').hidden, null, { timeout: 5000 });
    await sleep(800);
    const state = await admin.evaluate(async (tempId) => ({
      temp: Boolean(await chrome.tabs.get(tempId).catch(() => null)),
      capturing: (await chrome.storage.session.get('capturing')).capturing ?? null,
    }), tempId);
    await admin.close();
    await opened.page.close();
    return { ok: asleep && !state.temp && !state.capturing, detail: `worker arrêté : ${asleep} ; ${JSON.stringify(state)}` };
  });
  await page.close();
}

// --- Le groupe dans la page de résultats ---

const DEVICE_KEYS = ['telephone', 'tablette', 'ordinateur'];

// Vide la base : chaque contrôle du nettoyage compte ses captures.
const emptyDb = (page) =>
  page.evaluate(async () => {
    const db = await import(chrome.runtime.getURL('lib/db.js'));
    for (const { id } of await db.listCaptures()) await db.deleteCapture(id);
  });
const remainingIds = (page) =>
  page.evaluate(async () => {
    const db = await import(chrome.runtime.getURL('lib/db.js'));
    return (await db.listCaptures()).map(({ id }) => id);
  });
const prune = (page, keep, spared = []) =>
  page.evaluate(async ({ keep, spared }) => {
    const db = await import(chrome.runtime.getURL('lib/db.js'));
    await db.pruneCaptures(keep, spared);
  }, { keep, spared });

// Un groupe de trois petites captures, sans passer par le débogueur. Rend leurs ids, dans l'ordre des appareils.
async function seedGroup(page, createdAt, url = 'http://127.0.0.1/capture-synthetique') {
  const id = `groupe-${createdAt}`;
  const ids = [];
  for (const device of DEVICE_KEYS) ids.push(await seedCapture(page, { heightPoints: 300, widthPoints: 400, scale: 1, createdAt, group: { id, device, url } }));
  return ids;
}

const tabsState = (viewer) =>
  viewer.evaluate(() => ({
    hidden: document.getElementById('device-tabs').hidden,
    labels: [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent),
    selected: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? null,
    focused: document.activeElement?.getAttribute('role') === 'tab' ? document.activeElement.textContent : null,
    id: new URLSearchParams(location.search).get('id'),
    size: document.querySelector('.part-size')?.textContent ?? '',
  }));
const waitReady = (viewer) => viewer.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });

// Attend que l'onglet demandé soit affiché et ses images dessinées.
async function showTab(viewer, label) {
  await viewer.locator('[role="tab"]', { hasText: label }).click();
  await viewer.waitForFunction((label) => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent === label && document.body.dataset.ready === 'true', label, { timeout: 60_000 });
}

// Les téléchargements nés de `act`, une fois écrits : les noms demandés à Chrome, et les fichiers (Playwright les range sous un autre nom).
async function downloadsDuring(sw, viewer, act) {
  await viewer.evaluate(() => {
    window.askedNames = [];
    if (window.spying) return;
    window.spying = true;
    const download = chrome.downloads.download.bind(chrome.downloads);
    chrome.downloads.download = (options) => {
      window.askedNames.push(options.filename);
      return download(options);
    };
  });
  const before = await sw.evaluate(async () => (await chrome.downloads.search({})).map(({ id }) => id));
  await act();
  for (let i = 0; i < 120; i++) {
    const fresh = await sw.evaluate(async (before) => (await chrome.downloads.search({})).filter(({ id }) => !before.includes(id)).map(({ filename, state }) => ({ filename, state })), before);
    if (fresh.length && fresh.every(({ state }) => state === 'complete')) return { names: await viewer.evaluate(() => window.askedNames), files: fresh.map(({ filename }) => filename) };
    await sleep(250);
  }
  throw new Error('téléchargement non terminé');
}

async function groupGroupe(context, sw, env) {
  console.log('\n— Le groupe dans la page de résultats');
  const { base } = env;
  // Pas la fenêtre de l'icône : elle se ferme à la fin d'une capture.
  const admin = await extensionPage(context, 'convert/convert.html');
  const { page, tabId } = await originPage(context, sw, base);
  const done = await capture(context, sw, tabId, 'devices');
  const viewer = done.viewer;
  await viewer.setViewportSize({ width: 1280, height: 900 });
  const firstId = done.id;

  await test('groupe : trois onglets au clavier', async () => {
    const start = await tabsState(viewer);
    await viewer.locator('[role="tab"][aria-selected="true"]').focus();
    await viewer.keyboard.press('ArrowRight');
    await viewer.waitForFunction(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent === 'Tablette' && document.body.dataset.ready === 'true', null, { timeout: 60_000 });
    const second = await tabsState(viewer);
    await viewer.keyboard.press('End');
    await viewer.waitForFunction(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent === 'Ordinateur' && document.body.dataset.ready === 'true', null, { timeout: 60_000 });
    const third = await tabsState(viewer);
    await viewer.keyboard.press('ArrowRight');
    await viewer.waitForFunction(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent === 'Téléphone' && document.body.dataset.ready === 'true', null, { timeout: 60_000 });
    const wrapped = await tabsState(viewer);
    const roving = await viewer.evaluate(() => [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.tabIndex).join());
    const ok = same(start.labels, ['Téléphone', 'Tablette', 'Ordinateur']) && start.selected === 'Téléphone' && /^780 ×/.test(start.size) && second.focused === 'Tablette' && /^1[\s ]?640 ×/.test(second.size) && third.focused === 'Ordinateur' && /^2[\s ]?560 ×/.test(third.size) && wrapped.focused === 'Téléphone' && wrapped.id === firstId && roving === '0,-1,-1';
    return { ok, detail: `${start.size} / ${second.size} / ${third.size} / ${wrapped.selected} ; ${roving}` };
  });

  await test('groupe : onglets lisibles en clair et en sombre', async () => {
    const colors = async (scheme) => {
      await viewer.emulateMedia({ colorScheme: scheme });
      await viewer.screenshot({ path: path.join(WORK, `onglets-${scheme}.png`) });
      return viewer.evaluate(() => {
        const luminance = (text) => {
          const [r, g, b] = text.match(/[\d.]+/g).map(Number).map((value) => {
            const c = value / 255;
            return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
        const mat = getComputedStyle(document.getElementById('mat')).backgroundColor;
        const selected = getComputedStyle(document.querySelector('[role="tab"][aria-selected="true"]'));
        const other = getComputedStyle(document.querySelector('[role="tab"][aria-selected="false"]'));
        return { selected: ratio(selected.color, selected.backgroundColor), other: ratio(other.color, mat) };
      });
    };
    const light = await colors('light');
    const dark = await colors('dark');
    await viewer.emulateMedia({ colorScheme: null });
    return { ok: [light, dark].every(({ selected, other }) => selected >= 4.5 && other >= 4.5), detail: JSON.stringify({ light, dark }) };
  });

  await test('groupe : une ligne d’historique', async () => {
    const rows = await viewer.evaluate(() => [...document.querySelectorAll('.history-item')].map((row) => ({ title: row.querySelector('.history-title').textContent, current: row.getAttribute('aria-current') })));
    await showTab(viewer, 'Tablette');
    const current = await viewer.evaluate(() => document.querySelector('.history-item').getAttribute('aria-current'));
    return { ok: rows.length === 1 && /appareils/.test(rows[0].title) && rows[0].current === 'true' && current === 'true', detail: JSON.stringify(rows) };
  });

  await test('groupe : chaque onglet a ses boutons et son annotation', async () => {
    await viewer.locator('figure.part .annotate').first().click();
    await viewer.waitForSelector('#editor:not([hidden])');
    const width = await viewer.evaluate(() => document.querySelector('figure.part .part-size').textContent);
    await viewer.click('#editor-close');
    await viewer.waitForSelector('#editor', { state: 'hidden' });
    const ids = await admin.evaluate(async (firstId) => {
      const db = await import(chrome.runtime.getURL('lib/db.js'));
      const first = await db.getCapture(firstId);
      const members = await db.listGroup(first.group.id);
      await db.saveAnnotations(members[1].id, [{ id: 'a1', type: 'rect', color: 'red', size: 'm', x: 10, y: 20, width: 300, height: 80 }]);
      return members.map(({ id }) => id);
    }, firstId);
    const kinds = await admin.evaluate(async (ids) => {
      const db = await import(chrome.runtime.getURL('lib/db.js'));
      return Promise.all(ids.map(async (id) => (await db.getAnnotations(id)).length));
    }, ids);
    await viewer.reload();
    await waitReady(viewer);
    await viewer.waitForFunction(() => document.querySelector('.history-mark'));
    const mark = await viewer.locator('.history-mark').innerText();
    const buttons = [];
    for (const label of ['Téléphone', 'Tablette', 'Ordinateur']) {
      await showTab(viewer, label);
      buttons.push(await viewer.evaluate(() => [...document.querySelector('figure.part .part-actions').querySelectorAll('button')].map((el) => el.textContent).join()));
    }
    await viewer.evaluate(() => null);
    await admin.evaluate(async (id) => {
      const db = await import(chrome.runtime.getURL('lib/db.js'));
      await db.saveAnnotations(id, []);
    }, ids[1]);
    return { ok: same(kinds, [0, 1, 0]) && mark === 'annotée' && buttons.every((row) => row === 'Copier,Télécharger,Annoter') && /^1[\s ]?640/.test(width), detail: `${kinds} ; ${mark} ; ${buttons[0]} ; éditeur ${width}` };
  });

  await test('groupe : noms de fichiers et dossier', async () => {
    const names = [];
    for (const label of ['Téléphone', 'Tablette', 'Ordinateur']) {
      await showTab(viewer, label);
      names.push((await downloadsDuring(sw, viewer, () => viewer.locator('figure.part .part-save').first().click())).names[0]);
    }
    const rows = names.map((name) => name.split('/'));
    const folder = rows[0][1];
    const ok = rows.every(([root, dir]) => root === 'Captures' && dir === folder) && /^127\.0\.0\.1_\d{4}-/.test(folder) && DEVICE_KEYS.every((key, i) => rows[i][2] === `${folder}-${key}-01.png`);
    return { ok, detail: rows.map((row) => row.join('/')).join(' ; ') };
  });

  await test('groupe : Exporter et Tout télécharger portent sur l’onglet courant', async () => {
    await showTab(viewer, 'Tablette');
    const count = await viewer.locator('figure.part').count();
    const { names: all } = await downloadsDuring(sw, viewer, () => viewer.click('#download-all'));
    await viewer.waitForFunction(() => !document.getElementById('download-all').disabled);
    const zip = await downloadsDuring(sw, viewer, async () => {
      await viewer.click('#export');
      await viewer.click('[data-export="zip"]');
      await viewer.waitForFunction(() => document.querySelector('[role="tab"]').disabled);
    });
    await viewer.waitForFunction(() => !document.getElementById('export').hidden && !document.querySelector('[role="tab"]').disabled, null, { timeout: 60_000 });
    const pdf = await downloadsDuring(sw, viewer, async () => {
      await viewer.click('#export');
      await viewer.click('[data-export="pdf"]');
    });
    await viewer.waitForFunction(() => !document.getElementById('export').hidden, null, { timeout: 60_000 });
    const { stdout } = await run('unzip', ['-Z1', zip.files[0]]);
    const entries = stdout.trim().split('\n');
    const pages = /Pages:\s+(\d+)/.exec((await run('pdfinfo', [pdf.files[0]])).stdout)?.[1];
    const ok = all.length === count && all.every((name) => /-tablette-\d\d\.png$/.test(name)) && /-tablette\.zip$/.test(zip.names[0]) && entries.length === count && entries.every((name) => /-tablette-\d\d\.png$/.test(name)) && /-tablette\.pdf$/.test(pdf.names[0]) && Number(pages) === count;
    return { ok, detail: `${count} images ; ${path.basename(zip.names[0])} (${entries.length}) ; ${path.basename(pdf.names[0])} (${pages} p.) ; onglets grisés pendant l'export` };
  });

  await test('groupe : la croix supprime les trois après confirmation', async () => {
    const before = await remainingIds(admin);
    let question = '';
    let answer = false;
    const onDialog = async (dialog) => {
      question = dialog.message();
      await (answer ? dialog.accept() : dialog.dismiss());
    };
    viewer.on('dialog', onDialog);
    await viewer.locator('.history-delete').first().click();
    await sleep(300);
    const refused = await remainingIds(admin);
    answer = true;
    await viewer.locator('.history-delete').first().click();
    await viewer.waitForFunction(() => /supprimées/.test(document.getElementById('toast').textContent));
    viewer.off('dialog', onDialog);
    const after = await remainingIds(admin);
    const empty = await tabsState(viewer);
    return { ok: before.length === 3 && refused.length === 3 && after.length === 0 && /3 captures/.test(question) && empty.hidden && !(await viewer.locator('.history-item').count()), detail: `${question} ; ${before.length}→${refused.length}→${after.length}` };
  });
  await viewer.close();
  await page.close();

  await test('groupe : compte pour une capture dans le nettoyage', async () => {
    await emptyDb(admin);
    const now = Date.now();
    const old = await seedCapture(admin, { heightPoints: 300, widthPoints: 400, scale: 1, createdAt: now - 100_000 });
    const group = await seedGroup(admin, now - 50_000);
    for (let i = 0; i < 14; i++) await seedCapture(admin, { heightPoints: 300, widthPoints: 400, scale: 1, createdAt: now - i });
    await prune(admin, 15);
    const left = await remainingIds(admin);
    return { ok: !left.includes(old) && group.every((id) => left.includes(id)) && left.length === 17, detail: `${left.length} restantes : 14 captures + 1 groupe de 3, la plus ancienne retirée` };
  });

  await test('groupe : survit si un seul onglet est annoté, recadré ou affiché', async () => {
    await emptyDb(admin);
    const now = Date.now();
    const annotated = await seedGroup(admin, now - 400_000);
    const framed = await seedGroup(admin, now - 300_000);
    const shown = await seedGroup(admin, now - 200_000);
    const plain = await seedGroup(admin, now - 100_000);
    for (let i = 0; i < 3; i++) await seedCapture(admin, { heightPoints: 300, widthPoints: 400, scale: 1, createdAt: now - i });
    await admin.evaluate(async ({ annotated, framed }) => {
      const db = await import(chrome.runtime.getURL('lib/db.js'));
      await db.saveAnnotations(annotated[1], [{ id: 'a1', type: 'rect', color: 'red', size: 'm', x: 1, y: 2, width: 30, height: 8 }]);
      await db.saveEdits(framed[2], { items: [], trim: { x: 0, y: 10, w: 400, h: 200 } });
    }, { annotated, framed });
    await prune(admin, 3, [shown[1]]);
    const left = await remainingIds(admin);
    const whole = (ids) => ids.every((id) => left.includes(id));
    return { ok: whole(annotated) && whole(framed) && whole(shown) && plain.every((id) => !left.includes(id)), detail: `annoté ${whole(annotated)}, recadré ${whole(framed)}, affiché ${whole(shown)}, ordinaire retiré ${plain.every((id) => !left.includes(id))}` };
  });

  await test('groupe : un téléphone redirigé reste dans le dossier du groupe', async () => {
    await emptyDb(admin);
    const ids = await seedGroup(admin, Date.now(), 'http://site.fr/page');
    const opened = await extensionPage(context, `viewer/viewer.html?id=${ids[0]}`);
    await waitReady(opened);
    const { names: [name] } = await downloadsDuring(sw, opened, () => opened.locator('figure.part .part-save').first().click());
    await opened.close();
    return { ok: /^Captures\/site\.fr_[^/]+\/site\.fr_[^/]+-telephone-01\.png$/.test(name), detail: name };
  });

  await test('ancienne capture sans group : s’ouvre comme avant', async () => {
    await emptyDb(admin);
    const id = await seedCapture(admin, { heightPoints: 300, widthPoints: 400, scale: 1 });
    const opened = await extensionPage(context, `viewer/viewer.html?id=${id}`);
    await waitReady(opened);
    const state = await tabsState(opened);
    const title = await opened.locator('.history-title').innerText();
    const { names: [name] } = await downloadsDuring(sw, opened, () => opened.locator('figure.part .part-save').first().click());
    let question = '';
    opened.once('dialog', async (dialog) => {
      question = dialog.message();
      await dialog.accept();
    });
    await opened.locator('.history-delete').first().click();
    await opened.waitForFunction(() => /Capture supprimée/.test(document.getElementById('toast').textContent));
    await opened.close();
    return { ok: state.hidden && !state.labels.length && !/appareils/.test(title) && /^Captures\/127\.0\.0\.1_[^/]+\.png$/.test(name) && /^Supprimer cette capture/.test(question), detail: `${title} ; ${name} ; ${question}` };
  });

  await admin.close();
}

// --- Un vrai site ---

async function groupSite(context, sw) {
  if (!SITE_URL) {
    check('site : adresse à fournir (SITE_URL=https://… node lot4.mjs <dossier> site)', false, 'variable SITE_URL absente, groupe non lancé');
    return;
  }
  console.log(`\n— Le site ${SITE_URL}`);
  for (let trial = 1; trial <= 3; trial++) {
    const { page, tabId } = await openTab(context, sw, SITE_URL);
    const before = await page.evaluate(() => ({ href: location.href, ua: navigator.userAgent, innerWidth }));
    const out = await runEssai(sw, tabId, { keep: trial === 3 });
    await report(`site-${trial}`, out);
    await test(`site ${trial} : largeurs, tactile, pas de débordement`, async () => ({
      ok: out.ok && Math.abs(out.devices[0].width - 780) <= 2 && Math.abs(out.devices[1].width - 1640) <= 2 && out.devices.slice(0, 2).every(({ measure }) => measure.maxTouchPoints > 0) && out.devices.every(({ measure }) => measure.scrollWidth <= measure.innerWidth) && out.devices[0].measure.narrow,
      detail: out.ok ? `${out.seconds} s ; ${out.devices.map(({ width, recordHeight, sliceCount, measure }) => `${width}×${recordHeight} en ${sliceCount}, ${measure.scrollWidth}/${measure.innerWidth}`).join(' ; ')}` : out.error,
    }));
    await test(`site ${trial} : onglet d'origine intact`, async () => {
      const after = await page.evaluate(() => ({ href: location.href, ua: navigator.userAgent, innerWidth }));
      return { ok: same(before, after) && !out.tempLeft && !out.targetLeft, detail: after.href };
    });
    await page.close();
  }
  // Les sorties anormales, sur le vrai site.
  for (const [label, opts] of [
    ['annulation', { scenario: 'cancel' }],
    ['onglet temporaire fermé', { scenario: 'close-temp' }],
    ['détachement forcé', { scenario: 'detach' }],
    ['erreur', { url: 'http://127.0.0.1:9/mort' }],
  ]) {
    for (let trial = 1; trial <= 3; trial++) {
      const { page, tabId } = await openTab(context, sw, SITE_URL);
      await page.evaluate(() => document.body.insertAdjacentHTML('afterbegin', '<input id="saisie" />'));
      await page.fill('#saisie', 'texte saisi');
      const before = await originState(page);
      const out = await runEssai(sw, tabId, opts);
      await report(`site ${label}-${trial}`, out);
      const after = await originState(page);
      await test(`site, sortie ${label} ${trial} : origine intacte, rien ne reste`, async () => ({
        ok: !out.ok && same(before, after) && !out.tempLeft && !out.targetLeft,
        detail: `${out.kind} (${out.seconds} s)`,
      }));
      await page.close();
    }
  }
  for (let index = 0; index < 3; index++) {
    const { device, base64 } = await sw.evaluate((index) => self.composeRecord(index), index);
    await fs.writeFile(path.join(WORK, `site-${device}.png`), Buffer.from(base64, 'base64'));
  }
}

// --- 100 000 points ---

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

async function groupLong(context, sw, env) {
  console.log('\n— 100 000 points');
  const { page, tabId } = await openTab(context, sw, `${env.base}/device-probe.html?h=100000&dense=1`);
  const profile = path.join(WORK, 'profile-long');
  let peak = 0;
  let done = false;
  const sampler = (async () => {
    while (!done) {
      peak = Math.max(peak, await browserMemoryMb(profile));
      await sleep(2000);
    }
  })();
  // Par le vrai chemin : les trois images s'écrivent en base, puis la page de résultats s'ouvre.
  const started = Date.now();
  const id = await sw.evaluate((tabId) => self.captureTab(tabId, 'devices'), tabId);
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  await sleep(5000);
  done = true;
  await sampler;
  const group = id ? await sw.evaluate(async (id) => {
    const all = await self.listCapturesForTest();
    const groupId = all.find((capture) => capture.id === id).group.id;
    return all.filter((capture) => capture.group?.id === groupId).map(({ group, slices }) => ({ device: group.device, sliceCount: slices.length, bytes: slices.reduce((sum, slice) => sum + slice.blob.size, 0) }));
  }, id) : [];
  await report('long', { id, seconds, peak, group });
  await test('long : moins de 2,5 Go au total sur 100 000 points, écriture en base comprise', async () => ({
    ok: Boolean(id) && peak > 0 && peak < 2500,
    detail: `${Math.round(peak)} Mo, ${seconds} s ; ${group.map(({ device, sliceCount, bytes }) => `${device} ${sliceCount} tranches ${Math.round(bytes / 1024 / 1024)} Mo`).join(', ')}`,
  }));
  await page.close();
}

// --- Vraie fenêtre : un onglet en arrière-plan se dessine-t-il ? ---

async function groupVisible(context, sw, env) {
  console.log('\n— Vraie fenêtre, onglet temporaire en arrière-plan');
  const { base, stats } = env;
  const { page, tabId } = await originPage(context, sw, base);
  await sleep(500);
  for (const [label, capture] of [
    ['arrière-plan, sans réglage', { focus: false }],
    ['arrière-plan, avec focus', { focus: true }],
    ['au premier plan', { active: true, focus: true }],
  ]) {
    stats.lazy = 0;
    const before = await originState(page);
    const shot = sleep(4000).then(() => run('screencapture', ['-x', path.join(WORK, `fenetre-${label.replaceAll(' ', '-')}.png`)]).catch((err) => console.log(`   capture d'écran impossible : ${err.message}`)));
    const out = await runEssai(sw, tabId, { capture });
    await shot;
    await report(`visible ${label}`, out);
    await page.bringToFront();
    await sleep(300);
    const after = await originState(page);
    const rows = (out.devices ?? []).map(({ device, width, recordHeight, marker, bottom, headerFirst, headerNext, measure }) => `${device} ${width}×${recordHeight} vis=${measure.visibility} raf=${measure.raf} focus=${measure.hasFocus} marq=${marker} bas=${bottom} tête=${headerFirst}→${headerNext}`);
    console.log(`   ${label} : ${out.seconds} s, ${stats.lazy} chargements paresseux, ${out.error ?? ''}\n     ${rows.join('\n     ')}`);
    await test(`fenêtre ${label} : image paresseuse et marqueurs`, async () => ({
      ok: out.ok && out.devices.every(({ bottom }) => near(bottom, LAZY_COLOR)) && near(out.devices[0].marker, [255, 0, 0]) && near(out.devices[1].marker, [0, 255, 0]),
      detail: `${out.seconds} s`,
    }));
    await test(`fenêtre ${label} : origine intacte`, async () => ({ ok: before.href === after.href && before.value === after.value && before.innerWidth === after.innerWidth && before.ua === after.ua, detail: JSON.stringify(after).slice(0, 100) }));
  }
  await page.close();
}

// --- Vraie fenêtre, sans Playwright ---

// Playwright règle lui-même l'imitation du focus sur chaque onglet : son résultat ne dit rien d'un onglet caché dans un vrai Chrome.
// Ici, Chromium est lancé directement et seul le service worker est piloté.
async function groupSansPlaywright(extension, env) {
  console.log('\n— Chromium sans Playwright, onglet temporaire caché');
  const profile = path.join(WORK, 'profile-direct');
  const browser = spawn(chromium.executablePath(), [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-allow-origins=*', '--no-first-run', '--no-default-browser-check', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  try {
    let port = null;
    let socket = null;
    const waiting = new Map();
    let id = 0;
    const evaluate = async (expression) => {
      const reply = await new Promise((resolve) => {
        waiting.set(++id, resolve);
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      });
      if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails).slice(0, 300));
      return reply.result?.result?.value;
    };
    // Chromium fait aussi tourner ses propres extensions : on garde celle qui a le point d'entrée de l'essai.
    for (let attempt = 0; attempt < 40 && !socket; attempt++) {
      await sleep(500);
      port ??= await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').then((text) => text.split('\n')[0]).catch(() => null);
      if (!port) continue;
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((res) => res.json()).catch(() => []);
      for (const target of targets.filter(({ type }) => type === 'service_worker')) {
        socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          socket.onopen = resolve;
          socket.onerror = reject;
        });
        socket.onmessage = ({ data }) => {
          const message = JSON.parse(data);
          waiting.get(message.id)?.(message);
        };
        if (await evaluate("typeof self.captureDevicesForTest === 'function'")) break;
        socket.close();
        socket = null;
      }
    }
    if (!socket) throw new Error('service worker de Capture introuvable');
    await evaluate(`(${installHelpers})()`);
    const tabId = await evaluate(`chrome.tabs.create({ url: ${JSON.stringify(`${env.base}/device-probe.html?origin=1`)}, active: true }).then((tab) => tab.id)`);
    await sleep(1500);
    for (const [label, capture] of [
      ['caché, sans réglage', { focus: false }],
      ['caché, avec imitation du focus', { focus: true }],
    ]) {
      env.stats.lazy = 0;
      const out = await evaluate(`self.runEssai(${tabId}, ${JSON.stringify({ capture })})`);
      await report(`direct ${label}`, out);
      const rows = (out.devices ?? []).map(({ device, width, recordHeight, marker, bottom, headerFirst, headerNext, measure }) => `${device} ${width}×${recordHeight} vis=${measure.visibility} raf=${measure.raf} focus=${measure.hasFocus} marq=${marker} bas=${bottom} tête=${headerFirst}→${headerNext}`);
      console.log(`   ${label} : ${out.seconds} s, ${env.stats.lazy} chargements paresseux, ${out.error ?? ''}\n     ${rows.join('\n     ')}`);
      await test(`direct ${label} : image paresseuse et marqueurs`, async () => ({
        ok: out.ok && out.devices.every(({ bottom }) => near(bottom, LAZY_COLOR)) && near(out.devices[0].marker, [255, 0, 0]) && near(out.devices[1].marker, [0, 255, 0]),
        detail: `${out.seconds} s`,
      }));
    }
    socket.close();
  } finally {
    browser.kill();
  }
}

async function main() {
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(WORK, { recursive: true });
  const extension = await prepareExtension(WORK);
  const sansHotes = await prepareExtension(WORK, { allHosts: false });
  // Ces points d'entrée n'existent que dans les copies de test.
  for (const copy of [extension, sansHotes]) {
    await fs.appendFile(path.join(copy, 'background.js'), `\nimport * as devicesForTest from './devices/devices.js';\nimport { listCaptures as listCapturesForTest } from './lib/db.js';\nself.captureDevicesForTest = devicesForTest.shootDevices;\nself.DevicesForTest = devicesForTest.DEVICES;\nself.DevicesCancelled = devicesForTest.DevicesCancelled;\nself.listCapturesForTest = listCapturesForTest;\n`);
  }
  const env = await servers();
  if (ONLY === 'direct') {
    await groupSansPlaywright(extension, env);
    env.close();
    const failed = results.filter((result) => !result.ok).length;
    console.log(`\n${results.length - failed}/${results.length} vérifications réussies`);
    process.exit(failed ? 1 : 0);
  }
  const groups = { essai: groupEssai, scenarios: groupScenarios, reelle: groupReelle, appareils: groupAppareils, groupe: groupGroupe, site: groupSite, long: groupLong, visible: groupVisible };
  const onDemand = new Set(['site', 'long', 'visible']);
  try {
    for (const [name, group] of Object.entries(groups)) {
      if (ONLY ? ONLY !== name : onDemand.has(name)) continue;
      const context = name === 'visible'
        ? await chromium.launchPersistentContext(path.join(WORK, 'profile-visible'), {
            channel: 'chromium',
            headless: false,
            viewport: null,
            args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-size=1280,900'],
          })
        : await launch(name === 'reelle' ? sansHotes : extension, `profile-${name}`, WORK);
      try {
        const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
        await sw.evaluate(installHelpers);
        await group(context, sw, env);
      } finally {
        await context.close();
      }
    }
  } finally {
    env.close();
  }
  const failed = results.filter((result) => !result.ok).length;
  console.log(`\n${results.length - failed}/${results.length} vérifications réussies`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
