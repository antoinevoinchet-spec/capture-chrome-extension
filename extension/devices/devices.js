// Capture d'une page sous l'apparence de trois appareils, dans un onglet temporaire piloté par chrome.debugger.
// L'onglet d'origine n'est jamais touché : toutes les sorties se ramènent à fermer l'onglet temporaire et à retirer le débogueur.

import { pagePrepare, pageScrollTo, pageRestore } from '../capture/page.js';
import { deleteCapture, saveCapture } from '../lib/db.js';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

export const DEVICES = [
  { key: 'telephone', label: 'Téléphone', width: 390, height: 844, scale: 2, mobile: true, userAgent: IPHONE_UA, platform: 'iPhone' },
  { key: 'tablette', label: 'Tablette', width: 820, height: 1180, scale: 2, mobile: true, userAgent: IPAD_UA, platform: 'iPad' },
  { key: 'ordinateur', label: 'Ordinateur' },
];

const PAGE_OPTIONS = { preload: true, preloadStepMs: 120, preloadMaxMs: 8000, settleMs: 150, maxHeight: 100000 };
const LOAD_TIMEOUT_MS = 15000;

export class DevicesCancelled extends Error {}
export class DevicesError extends Error {}

const DEBUGGER_STOPPED = "Le débogueur s'est arrêté pendant la capture. Relance la capture, sans ouvrir les outils de développement.";

export function assertCapturable(url) {
  // Sans clic sur l'icône (accès activeTab), Chrome ne donne pas l'adresse de l'onglet : on ne sait donc pas si la page est interdite, et le message le dit.
  if (!url) throw new DevicesError("Chrome ne donne pas l'adresse de cette page. Sur une page interne de Chrome ou le Chrome Web Store, la capture est interdite. Sinon, clique sur l'icône de l'extension depuis la page à capturer, puis relance la capture.");
  if (/^file:/i.test(url)) throw new DevicesError("Cette capture ne marche que sur une page du web. Pour un fichier de ton ordinateur, utilise « Page entière ».");
  if (!/^https?:/i.test(url) || /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url)) {
    throw new DevicesError('Chrome interdit aux extensions de capturer cette page (pages internes de Chrome, Chrome Web Store).');
  }
}

// Tout ce qui peut arrêter le travail en cours passe par ici : annulation, onglet fermé, débogueur coupé.
function watchStop(origin, temp, debuggee) {
  let stop = null;
  const rejecters = new Set();
  const halt = (err) => {
    stop ??= err;
    for (const reject of rejecters) reject(stop);
  };
  const onRemoved = (tabId) => {
    if (tabId === origin.id) halt(new DevicesCancelled('origin-closed'));
    if (tabId === temp.id) halt(new DevicesCancelled('temp-closed'));
  };
  // « Annuler » dans le bandeau de Chrome est un choix, pas une panne.
  const onDetach = (source, reason) => {
    if (source.tabId !== debuggee.tabId) return;
    halt(reason === 'canceled_by_user' ? new DevicesCancelled('banner') : new DevicesError(DEBUGGER_STOPPED));
  };
  chrome.tabs.onRemoved.addListener(onRemoved);
  chrome.debugger.onDetach.addListener(onDetach);
  return {
    halt,
    check: () => {
      if (stop) throw stop;
    },
    reason: () => stop,
    // Une attente qui s'arrête aussitôt si la capture est interrompue.
    race: (promise) =>
      new Promise((resolve, reject) => {
        if (stop) return reject(stop);
        rejecters.add(reject);
        promise.then(resolve, reject).finally(() => rejecters.delete(reject));
      }),
    dispose: () => {
      chrome.tabs.onRemoved.removeListener(onRemoved);
      chrome.debugger.onDetach.removeListener(onDetach);
    },
  };
}

async function evaluate(send, func, args) {
  const expression = `(${func})(${args.map((arg) => JSON.stringify(arg)).join(',')})`;
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

async function emulate(send, device, origin) {
  if (device.mobile) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: device.width,
      height: device.height,
      deviceScaleFactor: device.scale,
      mobile: true,
      screenWidth: device.width,
      screenHeight: device.height,
    });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Emulation.setUserAgentOverride', { userAgent: device.userAgent, platform: device.platform });
    return;
  }
  // L'ordinateur : la fenêtre réelle et sa densité réelle (0 = pas de réglage). L'onglet temporaire peut être en arrière-plan.
  await send('Emulation.setDeviceMetricsOverride', { width: origin.width, height: origin.height, deviceScaleFactor: 0, mobile: false });
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await send('Emulation.setUserAgentOverride', { userAgent: navigator.userAgent });
}

// Attend la fin du chargement, sans dépasser LOAD_TIMEOUT_MS : une page dont une publicité ne finit jamais de charger se capture quand même.
async function navigate(send, debuggee, url, watch) {
  let onEvent;
  const loaded = new Promise((resolve) => {
    onEvent = (source, method) => {
      if (source.tabId === debuggee.tabId && method === 'Page.loadEventFired') resolve();
    };
    chrome.debugger.onEvent.addListener(onEvent);
  });
  try {
    const { errorText } = await watch.race(send('Page.navigate', { url }));
    if (errorText) throw new DevicesError(`La page ne s'est pas chargée (${errorText}). Vérifie l'adresse et relance la capture.`);
    await watch.race(Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, LOAD_TIMEOUT_MS))]));
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
  }
}

// Une boîte de dialogue ouverte par la page bloquerait tout le reste : elle est fermée aussitôt, sans jamais confirmer une question.
function closeDialogs(debuggee, send) {
  const onEvent = (source, method, params) => {
    if (source.tabId !== debuggee.tabId || method !== 'Page.javascriptDialogOpening') return;
    send('Page.handleJavaScriptDialog', { accept: params.type !== 'confirm' && params.type !== 'prompt' }).catch(() => {});
  };
  chrome.debugger.onEvent.addListener(onEvent);
  return () => chrome.debugger.onEvent.removeListener(onEvent);
}

async function shoot(send, device, watch, onProgress) {
  const info = await watch.race(evaluate(send, pagePrepare, [PAGE_OPTIONS]));
  const positions = [];
  for (let y = 0; ; y += info.sliceH) {
    if (y + info.sliceH >= info.totalH) {
      positions.push(Math.max(0, info.totalH - info.sliceH));
      break;
    }
    positions.push(y);
  }

  const slices = [];
  let scale = 0;
  for (let i = 0; i < positions.length; i++) {
    watch.check();
    const actualY = await watch.race(evaluate(send, pageScrollTo, [positions[i], i > 0]));
    const { data } = await watch.race(send('Page.captureScreenshot', { format: 'png', fromSurface: true }));
    const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
    if (!scale) {
      const bmp = await createImageBitmap(blob);
      scale = bmp.width / info.innerW;
      bmp.close();
    }
    slices.push({ y: Math.round(actualY * scale), blob });
    onProgress?.({ done: i + 1, total: positions.length });
  }

  const crop = {
    x: Math.round(info.clip.x * scale),
    y: Math.round(info.clip.y * scale),
    w: Math.round(info.clip.w * scale),
    h: Math.round(info.clip.h * scale),
  };
  await evaluate(send, pageRestore, []).catch(() => {});
  const covered = Math.max(...slices.map((slice) => slice.y + crop.h));
  return {
    mode: 'full',
    url: info.url,
    title: info.title,
    scale,
    width: crop.w,
    height: Math.min(Math.round(info.totalH * scale), covered),
    crop,
    slices,
    scroller: info.scroller,
    truncated: info.truncated,
  };
}

// Une exception levée par Chrome pendant une sortie : la vraie raison passe avant, et rien de technique n'arrive à l'écran.
async function explainFailure(err, watch, origin, temp) {
  if (watch.reason()) return watch.reason();
  if (err instanceof DevicesError || err instanceof DevicesCancelled) return err;
  if (!(await chrome.tabs.get(origin.id).catch(() => null))) return new DevicesCancelled('origin-closed');
  if (!(await chrome.tabs.get(temp.id).catch(() => null))) return new DevicesCancelled('temp-closed');
  if (/not attached|detached/i.test(String(err?.message))) return new DevicesError(DEBUGGER_STOPPED);
  return err;
}

// `options.active` montre l'onglet temporaire ; `options.focus` fait croire à la page qu'elle est affichée, même en arrière-plan.
// `options.afterLoad(send, device)` : crochet de l'essai, pour lire la page sous émulation avant toute retouche.
// `onStart({ tempId, halt })` donne de quoi annuler ; `onProgress({ device, label, index, count, done, total })` : done vaut 0 pendant le chargement.
export async function shootDevices(origin, options = {}) {
  const { devices = DEVICES, active = false, focus = true, afterLoad, onProgress, onStart } = options;
  assertCapturable(origin.url);
  const temp = await chrome.tabs.create({ url: 'about:blank', active, windowId: origin.windowId, index: origin.index + 1 });
  const debuggee = { tabId: temp.id };
  const watch = watchStop(origin, temp, debuggee);
  const send = (method, params = {}) => chrome.debugger.sendCommand(debuggee, method, params);
  const stopClosingDialogs = closeDialogs(debuggee, send);
  let attached = false;
  try {
    await onStart?.({ tempId: temp.id, halt: watch.halt });
    await watch.race(chrome.debugger.attach(debuggee, '1.3')).catch((err) => {
      if (err instanceof DevicesCancelled) throw err;
      throw new DevicesError(`Chrome a refusé le débogueur (${err.message}). Ferme les outils de développement de cette page et relance la capture.`);
    });
    attached = true;
    await watch.race(send('Page.enable'));
    await watch.race(send('Runtime.enable'));
    await watch.race(send('Page.setBypassCSP', { enabled: true }));
    if (focus) await watch.race(send('Emulation.setFocusEmulationEnabled', { enabled: true }));
    const group = { id: crypto.randomUUID(), url: origin.url };
    const createdAt = Date.now();
    const records = [];
    for (const [index, device] of devices.entries()) {
      watch.check();
      const step = { device: device.key, label: device.label, index, count: devices.length };
      onProgress?.({ ...step, done: 0, total: 0 });
      await watch.race(emulate(send, device, origin));
      await navigate(send, debuggee, origin.url, watch);
      const measure = afterLoad ? await watch.race(afterLoad(send, device)) : null;
      const record = await shoot(send, device, watch, (slice) => onProgress?.({ ...step, ...slice }));
      // Une seule date par groupe : ses fichiers vont dans un seul dossier.
      record.createdAt = createdAt;
      record.group = { ...group, device: device.key };
      records.push({ record, measure });
    }
    return records;
  } catch (err) {
    throw await explainFailure(err, watch, origin, temp);
  } finally {
    watch.dispose();
    stopClosingDialogs();
    if (attached) await chrome.debugger.detach(debuggee).catch(() => {});
    await chrome.tabs.remove(temp.id).catch(() => {});
  }
}

// Capture et enregistre les trois appareils. Rend `groupId` et les ids dans l'ordre des appareils : la page de résultats s'ouvre sur le premier.
export async function captureDevices(tab, options = {}) {
  const shots = await shootDevices(tab, options);
  const ids = [];
  try {
    for (const { record } of shots) ids.push(await saveCapture(record));
  } catch (err) {
    // Un groupe entier ou rien : la base pleine ne laisse pas une capture sur trois.
    await Promise.all(ids.map((id) => deleteCapture(id).catch(() => {})));
    throw err;
  }
  return { groupId: shots[0].record.group.id, ids };
}
