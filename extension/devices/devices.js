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
// Après load, le temps de laisser arriver ce que la page va chercher : Chrome signale un réseau calme (500 ms sans requête).
const QUIET_TIMEOUT_MS = 5000;
// Le serveur n'a toujours pas répondu : page bloquée, ou mot de passe demandé dans un onglet que personne ne regarde.
const NAVIGATE_TIMEOUT_MS = 30000;

export class DevicesCancelled extends Error {}
export class DevicesError extends Error {}

const DEBUGGER_STOPPED = "Le débogueur s'est arrêté pendant la capture. Les outils de développement ou une autre extension peuvent le couper : ferme-les, relance la capture, et si cela recommence, désactive tes autres extensions le temps de la capture.";
const PAGE_MOVING = "La page change d'adresse pendant la capture et ne se stabilise pas. Relance la capture ; si cela recommence, utilise « Page entière ».";
const PAGE_GONE = /navigated or closed|context was destroyed/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// Suit le document de l'onglet temporaire : son adresse change-t-elle, son réseau est-il calme (500 ms sans requête, signalé par Chrome) ?
function trackPage(debuggee) {
  const calm = new Set();
  let loader = null;
  let wake = null;
  let loaded = null;
  const page = {
    moved: false,
    // Le document attendu : celui de la navigation, ou celui d'une redirection arrivée entre-temps.
    follow: (loaderId) => {
      loader = loaderId;
      if (calm.has(loader)) wake?.();
    },
    quiet: () =>
      new Promise((resolve) => {
        wake = resolve;
        if (calm.has(loader)) resolve();
      }),
    nextLoad: () =>
      new Promise((resolve) => {
        loaded = resolve;
      }),
    dispose: () => chrome.debugger.onEvent.removeListener(onEvent),
  };
  const onEvent = (source, method, params) => {
    if (source.tabId !== debuggee.tabId) return;
    if (method === 'Page.loadEventFired') loaded?.();
    if (method === 'Page.frameNavigated' && !params.frame.parentId) {
      page.moved = true;
      page.follow(params.frame.loaderId);
    }
    if (method === 'Page.lifecycleEvent' && params.name === 'networkIdle') {
      calm.add(params.loaderId);
      if (params.loaderId === loader) wake?.();
    }
  };
  chrome.debugger.onEvent.addListener(onEvent);
  return page;
}

// Attend la fin du chargement puis un réseau calme, sans dépasser leurs limites : une page dont une publicité ne finit jamais de charger se capture quand même.
async function navigate(send, page, url, watch) {
  const noAnswer = sleep(NAVIGATE_TIMEOUT_MS).then(() => {
    throw new DevicesError("La page ne répond pas. Si elle demande un mot de passe, connecte-toi d'abord dans cet onglet, puis relance la capture.");
  });
  const load = page.nextLoad().then(() => true);
  const { errorText, loaderId } = await watch.race(Promise.race([send('Page.navigate', { url }), noAnswer]));
  if (errorText) throw new DevicesError(`La page ne s'est pas chargée (${errorText}). Vérifie l'adresse et relance la capture.`);
  // Déjà suivi si une redirection est arrivée avant cette réponse.
  if (!page.moved) page.follow(loaderId);
  const inTime = await watch.race(Promise.race([load, sleep(LOAD_TIMEOUT_MS).then(() => false)]));
  // Pas de load dans le temps : le réseau ne sera pas calme non plus, inutile d'attendre encore.
  if (inTime) await watch.race(Promise.race([page.quiet(), sleep(QUIET_TIMEOUT_MS)]));
}

// Une page peut encore se charger après une redirection par script. Rend la main dès qu'elle est prête, sans dépasser LOAD_TIMEOUT_MS.
async function waitComplete(send, watch) {
  const limit = Date.now() + LOAD_TIMEOUT_MS;
  while (Date.now() < limit) {
    watch.check();
    const ask = send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }).catch(() => null);
    const answer = await watch.race(Promise.race([ask, sleep(2000)]));
    if (answer?.result?.value === 'complete') return;
    await watch.race(sleep(200));
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

// Une page qui change d'adresse pendant la capture (redirection par script, <meta refresh>) : les images seraient celles de deux pages.
// On recommence une fois sur la page d'arrivée, une fois celle-ci chargée et son réseau calme ; si elle bouge encore, on le dit.
async function shootStable(send, page, device, watch, onProgress) {
  for (let attempt = 0; ; attempt++) {
    if (attempt) {
      await waitComplete(send, watch);
      await watch.race(Promise.race([page.quiet(), sleep(QUIET_TIMEOUT_MS)]));
    }
    page.moved = false;
    let record = null;
    let failure = null;
    try {
      record = await shoot(send, device, watch, onProgress);
    } catch (err) {
      if (err instanceof DevicesCancelled || err instanceof DevicesError) throw err;
      failure = err;
    }
    if (!page.moved && !PAGE_GONE.test(String(failure?.message))) {
      if (failure) throw failure;
      return record;
    }
    if (attempt) throw new DevicesError(PAGE_MOVING);
  }
}

async function shoot(send, device, watch, onProgress) {
  // Contenu plus large que le téléphone : la page est dézoomée pour tenir, comme sans initial-scale. Sinon la prise de vue ne montrerait qu'une partie de ce que la page annonce.
  if (device.mobile) {
    const wide = await watch.race(send('Runtime.evaluate', { expression: 'innerWidth', returnByValue: true }));
    if (wide.result.value > device.width) await watch.race(send('Emulation.setPageScaleFactor', { pageScaleFactor: device.width / wide.result.value }));
  }
  const info = await watch.race(evaluate(send, pagePrepare, [PAGE_OPTIONS]));
  const positions = [];
  // Deux points de recouvrement : à une échelle non entière (page dézoomée, zoom du navigateur), l'arrondi laisserait sinon une ligne vide entre deux tranches.
  for (let y = 0; ; y += Math.max(1, info.sliceH - 2)) {
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

  // Page dézoomée sur un mobile : toute sa largeur est sur l'image, et clip.w ne la voit pas. Une zone défilante garde sa propre coupe.
  const crop = {
    x: Math.round(info.clip.x * scale),
    y: Math.round(info.clip.y * scale),
    w: Math.round((device.mobile && info.scroller === 'window' ? info.innerW : info.clip.w) * scale),
    h: Math.round(info.clip.h * scale),
  };
  await watch.race(evaluate(send, pageRestore, [])).catch(() => {});
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
  if (/not attached|detached|cannot access|chrome-extension/i.test(String(err?.message))) return new DevicesError(DEBUGGER_STOPPED);
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
  const page = trackPage(debuggee);
  let attached = false;
  try {
    await onStart?.({ tempId: temp.id, halt: watch.halt });
    await watch.race(chrome.debugger.attach(debuggee, '1.3')).catch((err) => {
      if (err instanceof DevicesCancelled) throw err;
      console.warn('Débogueur refusé :', err);
      throw new DevicesError("Chrome a refusé le débogueur. Une autre extension s'en sert peut-être : désactive-la sur chrome://extensions, puis relance la capture.");
    });
    attached = true;
    await watch.race(send('Page.enable'));
    await watch.race(send('Runtime.enable'));
    await watch.race(send('Page.setBypassCSP', { enabled: true }));
    await watch.race(send('Page.setLifecycleEventsEnabled', { enabled: true }));
    if (focus) await watch.race(send('Emulation.setFocusEmulationEnabled', { enabled: true }));
    const group = { id: crypto.randomUUID(), url: origin.url };
    const createdAt = Date.now();
    const records = [];
    for (const [index, device] of devices.entries()) {
      watch.check();
      const step = { device: device.key, label: device.label, index, count: devices.length };
      onProgress?.({ ...step, done: 0, total: 0 });
      // Repartir d'une page vide : avec un # dans l'adresse, Chrome ne rechargerait pas la page, et le site ne verrait pas le nouvel appareil.
      if (index) await watch.race(send('Page.navigate', { url: 'about:blank' }));
      await watch.race(emulate(send, device, origin));
      page.moved = false;
      await navigate(send, page, origin.url, watch);
      const measure = afterLoad ? await watch.race(afterLoad(send, device)) : null;
      const record = await shootStable(send, page, device, watch, (slice) => onProgress?.({ ...step, ...slice }));
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
    page.dispose();
    if (attached) await chrome.debugger.detach(debuggee).catch(() => {});
    await chrome.tabs.remove(temp.id).catch(() => {});
  }
}

// Capture et enregistre les trois appareils. Rend `groupId` et les ids dans l'ordre des appareils : la page de résultats s'ouvre sur le premier.
// `options.shouldStop()` : « Annuler » cliqué pendant l'écriture en base.
export async function captureDevices(tab, options = {}) {
  const shots = await shootDevices(tab, options);
  const ids = [];
  try {
    for (const { record } of shots) {
      if (options.shouldStop?.()) throw new DevicesCancelled('user');
      ids.push(await saveCapture(record));
    }
    if (options.shouldStop?.()) throw new DevicesCancelled('user');
  } catch (err) {
    // Un groupe entier ou rien : une annulation ou une base pleine ne laisse pas une capture sur trois.
    await Promise.all(ids.map((id) => deleteCapture(id).catch(() => {})));
    throw err;
  }
  return { groupId: shots[0].record.group.id, ids };
}
