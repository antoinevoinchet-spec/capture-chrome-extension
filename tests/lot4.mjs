// Tests du lot 4 : téléphone, tablette, ordinateur.
// Usage : node lot4.mjs <dossier de sortie> [essai|scenarios|reelle|site|long|visible|direct] [motif]
// `site` (un vrai site, dont l'adresse est obligatoire dans SITE_URL), `long` (100 000 points), `visible` et `direct` (une vraie fenêtre) ne tournent que si on les nomme.

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { check, launch, openTab, prepareExtension, results } from './lib.mjs';

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
  const stats = { lazy: 0 };
  const lazy = solidPng(LAZY_COLOR);
  const pages = path.join(HERE, 'pages');
  let other = '';
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/lazy.png') {
      stats.lazy++;
      return res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }).end(lazy);
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
  self.runEssai = async (tabId, opts = {}) => {
    const real = await chrome.tabs.get(tabId);
    const origin = opts.url ? { ...real, url: opts.url } : real;
    const started = Date.now();
    let tempId = null;
    let halt = null;
    let fired = false;
    const onProgress = async () => {
      if (fired || !opts.scenario) return;
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

async function originPage(context, sw, base) {
  const opened = await openTab(context, sw, `${base}/device-probe.html?origin=1`);
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
  await page.close();
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
  const out = await runEssai(sw, tabId, { light: true });
  done = true;
  await sampler;
  await report('long', { ...out, peak });
  await test('long : moins de 2,5 Go au total sur 100 000 points', async () => ({
    ok: out.ok && peak > 0 && peak < 2500,
    detail: `${Math.round(peak)} Mo, ${out.seconds} s ; ${(out.devices ?? []).map(({ device, sliceCount, bytes }) => `${device} ${sliceCount} tranches ${Math.round(bytes / 1024 / 1024)} Mo`).join(', ')} ${out.error ?? ''}`,
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
  // Le point d'entrée de l'essai n'existe que dans les copies de test : la vraie extension n'a ni bouton ni appel.
  for (const copy of [extension, sansHotes]) {
    await fs.appendFile(path.join(copy, 'background.js'), `\nimport { captureDevices as captureDevicesForTest, DevicesCancelled } from './devices/devices.js';\nself.captureDevicesForTest = captureDevicesForTest;\nself.DevicesCancelled = DevicesCancelled;\n`);
  }
  const env = await servers();
  if (ONLY === 'direct') {
    await groupSansPlaywright(extension, env);
    env.close();
    const failed = results.filter((result) => !result.ok).length;
    console.log(`\n${results.length - failed}/${results.length} vérifications réussies`);
    process.exit(failed ? 1 : 0);
  }
  const groups = { essai: groupEssai, scenarios: groupScenarios, reelle: groupReelle, site: groupSite, long: groupLong, visible: groupVisible };
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
