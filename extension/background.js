import { pagePrepare, pageScrollTo, pageRestore } from './capture/page.js';
import { pickerStart, pickerStop } from './capture/picker.js';
import { saveCapture, pruneCaptures } from './lib/db.js';
import { setupWebImage } from './web-image/save-web-image.js';

// Chrome refuse plus de 2 appels par seconde à captureVisibleTab.
const CAPTURE_INTERVAL_MS = 550;
const KEEP_CAPTURES = 15;
// La sélection en cours, dans storage.session : le service worker peut s'endormir pendant qu'on choisit.
const PICK_KEY = 'picking';
// La capture d'un bloc en cours, relue par la fenêtre de l'icône à sa réouverture pour proposer « Annuler ».
const CAPTURING_KEY = 'capturing';
const PAGE_OPTIONS = {
  preload: true,
  preloadStepMs: 120,
  preloadMaxMs: 8000,
  settleMs: 150,
  maxHeight: 100000,
};

class CaptureError extends Error {}
class CaptureCancelled extends Error {}

let running = false;
let cancelled = false;
let lastGrabAt = 0;

// Un service worker qui démarre n'a aucune capture en cours : un état resté d'une panne ne doit pas bloquer la fenêtre.
chrome.storage.session.remove(CAPTURING_KEY);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'capture') return false;
  if (running) {
    sendResponse({ ok: false, error: 'Une capture est déjà en cours.' });
    return false;
  }
  chrome.tabs.get(msg.tabId).then((tab) => runCapture(tab, msg.mode));
  sendResponse({ ok: true });
  return false;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'pick-start') {
    chrome.tabs.get(msg.tabId).then((tab) => startPick(tab, msg.mode)).then(
      () => sendResponse({ ok: true }),
      async (err) => sendResponse({ ok: false, error: (await explain(err)).message }),
    );
    return true;
  }
  if (msg?.type === 'capture-cancel') {
    cancelled = true;
    return false;
  }
  if (msg?.type === 'pick-cancel') {
    chrome.storage.session.remove(PICK_KEY);
    return false;
  }
  // Vient du calque : le service worker a pu s'endormir pendant le choix, ce message le réveille.
  if (msg?.type === 'pick-result' && sender.tab) {
    chrome.storage.session.remove(PICK_KEY);
    runCapture(sender.tab, 'region', msg);
  }
  return false;
});

function onCommand(command, tab) {
  if (command === 'capture-full') runCapture(tab, 'full');
  if (command === 'capture-visible') runCapture(tab, 'visible');
  if (command === 'capture-pick') startPick(tab, 'block').catch((err) => reportFailure(tab, err));
}
chrome.commands.onCommand.addListener(onCommand);

// Le calque ne reste pas sur un onglet qu'on a quitté.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const { [PICK_KEY]: picking } = await chrome.storage.session.get(PICK_KEY);
  if (picking && picking.tabId !== tabId) await removePicker(picking.tabId);
});

setupWebImage();

// Point d'entrée utilisé par les tests automatisés (ils ne peuvent pas cliquer sur l'icône).
self.captureTab = (tabId, mode) => chrome.tabs.get(tabId).then((tab) => runCapture(tab, mode));
self.startPick = (tabId, mode) => chrome.tabs.get(tabId).then((tab) => startPick(tab, mode));
self.onCommandForTest = onCommand;
self.explainForTest = (err) => explain(err);
self.cancelCaptureForTest = () => {
  cancelled = true;
};
self.captureRunningForTest = () => running;

async function startPick(tab, mode) {
  if (running) throw new CaptureError('Une capture est déjà en cours.');
  await assertNotOwnPage(tab);
  await inTab(tab.id, pickerStart, [mode]);
  await chrome.storage.session.set({ [PICK_KEY]: { tabId: tab.id, mode, at: Date.now() } });
}

// Sur une page interdite ou un onglet fermé, il n'y a de toute façon aucun calque à retirer.
async function removePicker(tabId) {
  await chrome.storage.session.remove(PICK_KEY);
  await inTab(tabId, pickerStop, []).catch(() => {});
}

async function assertNotOwnPage(tab) {
  const ownPage = await chrome.runtime.getContexts({ contextTypes: ['TAB'], tabIds: [tab.id] });
  if (ownPage.length) {
    throw new CaptureError("C'est la page de résultats de l'extension : lance la capture depuis la page à capturer.");
  }
}

async function runCapture(tab, mode, pick) {
  if (running) return null;
  running = true;
  cancelled = false;
  badge(tab.id, '…', '#5f6368');
  setTitle(tab.id, 'Capture');
  chrome.storage.session.remove('lastError');
  try {
    // Quel que soit le lancement, le calque de sélection n'apparaît jamais sur l'image.
    await removePicker(tab.id);
    await assertNotOwnPage(tab);
    const record = await (mode === 'region' ? captureRegion(tab, pick) : mode === 'visible' ? captureVisible(tab) : captureFullPage(tab));
    const id = await saveCapture(record);
    await pruneCaptures(KEEP_CAPTURES, await displayedCaptures());
    badge(tab.id, '');
    notify({ type: 'capture-done', id });
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`viewer/viewer.html?id=${id}`),
      index: tab.index + 1,
      openerTabId: tab.id,
    });
    return id;
  } catch (err) {
    // Onglet fermé pendant la capture : c'est le choix de l'utilisateur, rien à signaler.
    if (!(await chrome.tabs.get(tab.id).catch(() => null))) return null;
    if (err instanceof CaptureCancelled) {
      badge(tab.id, '');
      notify({ type: 'capture-cancelled' });
      return null;
    }
    await reportFailure(tab, err);
    return null;
  } finally {
    running = false;
    await chrome.storage.session.remove(CAPTURING_KEY);
  }
}

async function reportFailure(tab, err) {
  const { message, expected } = await explain(err);
  // Un refus prévisible (page interdite, onglet changé…) est expliqué, pas journalisé comme une panne.
  if (!expected) console.error('Capture impossible :', err);
  badge(tab.id, '!', '#d93025');
  setTitle(tab.id, `Capture impossible : ${message}`);
  notify({ type: 'capture-error', message });
  await showErrorPopup(tab, message);
}

// Captures affichées dans une page de résultats : le nettoyage ne les retire pas, on peut encore les annoter.
// Lues sur les onglets : un onglet mis en veille par Chrome n'a plus de page, mais il rouvrira sa capture à son retour.
async function displayedCaptures() {
  const viewer = chrome.runtime.getURL('viewer/viewer.html');
  const tabs = await chrome.tabs.query({});
  return tabs.filter(({ url }) => url?.startsWith(viewer)).map(({ url }) => new URL(url).searchParams.get('id')).filter(Boolean);
}

async function captureFullPage(tab) {
  try {
    const info = await inTab(tab.id, pagePrepare, [PAGE_OPTIONS]);
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
      const actualY = await inTab(tab.id, pageScrollTo, [positions[i], i > 0]);
      const blob = await grab(tab);
      if (!scale) {
        const bmp = await createImageBitmap(blob);
        scale = bmp.width / info.innerW;
        bmp.close();
      }
      slices.push({ y: Math.round(actualY * scale), blob });
      progress(tab.id, i + 1, positions.length);
    }

    const crop = {
      x: Math.round(info.clip.x * scale),
      y: Math.round(info.clip.y * scale),
      w: Math.round(info.clip.w * scale),
      h: Math.round(info.clip.h * scale),
    };
    const covered = Math.max(...slices.map((s) => s.y + crop.h));
    return {
      mode: 'full',
      url: info.url || tab.url,
      title: info.title || tab.title,
      createdAt: Date.now(),
      scale,
      width: crop.w,
      height: Math.min(Math.round(info.totalH * scale), covered),
      crop,
      slices,
      scroller: info.scroller,
      truncated: info.truncated,
    };
  } finally {
    await inTab(tab.id, pageRestore, []).catch(() => {});
  }
}

async function captureVisible(tab) {
  const blob = await grab(tab);
  const bmp = await createImageBitmap(blob);
  const { width, height } = bmp;
  bmp.close();
  return {
    mode: 'visible',
    url: tab.url,
    title: tab.title,
    createdAt: Date.now(),
    scale: tab.width ? width / tab.width : 1,
    width,
    height,
    crop: { x: 0, y: 0, w: width, h: height },
    slices: [{ y: 0, blob }],
    scroller: 'window',
    truncated: false,
  };
}

// Un bloc ou une zone. Les tranches sont rognées avant d'être enregistrées : la capture ressemble à une page plus petite, et le modèle ne change pas.
async function captureRegion(tab, pick) {
  if (pick.mode === 'zone') return captureZone(tab, pick);
  await chrome.storage.session.set({ [CAPTURING_KEY]: { tabId: tab.id, done: 0, total: 0 } });
  try {
    const info = await inTab(tab.id, pagePrepare, [{ ...PAGE_OPTIONS, region: true }]);
    if (cancelled) throw new CaptureCancelled();
    if (info.gone) throw new CaptureError('Le bloc choisi a disparu de la page. Relance la capture et choisis-le de nouveau.');
    if (info.empty) throw new CaptureError("Ce bloc n'est pas visible : il n'y a rien à capturer. Choisis-en un autre.");
    const { region, clip } = info;
    const offsets = [];
    for (let offset = 0; ; offset += region.band) {
      if (offset + region.band >= region.height) {
        offsets.push(Math.max(0, region.height - region.band));
        break;
      }
      offsets.push(offset);
    }

    const slices = [];
    let scale = 0;
    let size = null;
    for (let i = 0; i < offsets.length; i++) {
      if (cancelled) throw new CaptureCancelled();
      const wanted = region.still ? region.start : region.top + offsets[i];
      const actual = await inTab(tab.id, pageScrollTo, [wanted, true]);
      const bmp = await createImageBitmap(await grab(tab));
      if (!scale) {
        scale = bmp.width / info.innerW;
        const x = Math.round(region.left * scale);
        size = { x, w: Math.min(Math.round((region.left + region.width) * scale), bmp.width) - x, h: Math.round(region.band * scale) };
      }
      // Sa place sur l'écran : tout en bas de la page, le défilement s'arrête avant d'amener le bloc en haut.
      const top = clip.y + region.top + offsets[i] - actual;
      const y = Math.max(0, Math.min(Math.round(top * scale), bmp.height - size.h));
      slices.push({ y: Math.round(offsets[i] * scale), blob: await cutBitmap(bmp, size.x, y, size.w, size.h) });
      progress(tab.id, i + 1, offsets.length, true);
      await chrome.storage.session.set({ [CAPTURING_KEY]: { tabId: tab.id, done: i + 1, total: offsets.length } });
    }
    if (cancelled) throw new CaptureCancelled();
    const crop = { x: 0, y: 0, w: size.w, h: size.h };
    return {
      mode: 'region',
      origin: 'bloc',
      url: info.url || tab.url,
      title: info.title || tab.title,
      createdAt: Date.now(),
      scale,
      width: size.w,
      height: Math.min(Math.round(region.height * scale), slices.at(-1).y + size.h),
      crop,
      slices,
      scroller: info.scroller,
      truncated: region.truncated,
      ...(region.partial ? { partial: region.partial } : {}),
    };
  } finally {
    await inTab(tab.id, pageRestore, []).catch(() => {});
  }
}

// Une zone est ce qu'on voit à l'écran au moment du tracé : ni défilement, ni élément masqué.
async function captureZone(tab, { rect, innerW }) {
  const bmp = await createImageBitmap(await grab(tab));
  const scale = bmp.width / innerW;
  const x = Math.max(0, Math.round(rect.x * scale));
  const y = Math.max(0, Math.round(rect.y * scale));
  const w = Math.min(Math.round((rect.x + rect.w) * scale), bmp.width) - x;
  const h = Math.min(Math.round((rect.y + rect.h) * scale), bmp.height) - y;
  const blob = await cutBitmap(bmp, x, y, w, h);
  return {
    mode: 'region',
    origin: 'zone',
    url: tab.url,
    title: tab.title,
    createdAt: Date.now(),
    scale,
    width: w,
    height: h,
    crop: { x: 0, y: 0, w, h },
    slices: [{ y: 0, blob }],
    scroller: 'window',
    truncated: false,
  };
}

// Rogne une image dans un canvas à part, libéré aussitôt : une seule partie à la fois en mémoire.
async function cutBitmap(bmp, x, y, w, h) {
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bmp, x, y, w, h, 0, 0, w, h);
  bmp.close();
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  canvas.width = canvas.height = 0;
  return blob;
}

async function grab(tab) {
  for (let attempt = 1; ; attempt++) {
    const wait = lastGrabAt + CAPTURE_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    await assertStillActive(tab);
    lastGrabAt = Date.now();
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      // Vérifié aussi après coup : prise juste après un changement d'onglet, l'image serait celle d'un autre onglet.
      await assertStillActive(tab);
      return (await fetch(dataUrl)).blob();
    } catch (err) {
      if (err instanceof CaptureError) throw err;
      await assertStillActive(tab);
      // Échecs passagers : page pas encore affichée, quota de captures par seconde atteint.
      const transient = /readback|MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(String(err?.message));
      if (!transient || attempt >= 3) throw err;
      await sleep(400);
    }
  }
}

async function assertStillActive(tab) {
  const current = await chrome.tabs.get(tab.id).catch(() => null);
  if (!current?.active || current.windowId !== tab.windowId) {
    throw new CaptureError(
      "La capture s'est arrêtée : l'onglet a changé ou a été fermé. Reste sur la page jusqu'à la fin de la capture.",
    );
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function inTab(tabId, func, args) {
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  if (!injection) throw new CaptureError("Impossible d'accéder à la page.");
  return injection.result;
}

// Avec le raccourci clavier, aucune fenêtre n'est ouverte : on ouvre celle de l'icône pour afficher le message.
async function showErrorPopup(tab, message) {
  await chrome.storage.session.set({ lastError: { message, at: Date.now() } });
  const popups = await chrome.runtime.getContexts({ contextTypes: ['POPUP'] });
  if (popups.length) return;
  await chrome.action.openPopup({ windowId: tab.windowId }).catch(() => {});
}

async function explain(err) {
  if (err instanceof CaptureError) return { message: err.message, expected: true };
  const message = String(err?.message ?? err);
  // Fichiers remplacés sans recharger l'extension : cette partie tourne encore avec l'ancien code, la base est déjà plus récente.
  if (/requested version .* less than the existing version/i.test(message)) {
    return {
      message: "L'extension vient de changer : sur chrome://extensions, clique sur ↻ dans la carte « Capture », puis relance la capture. Tes captures ne sont pas perdues.",
      expected: true,
    };
  }
  if (/chrome:\/\/|extensions gallery|cannot be scripted/i.test(message)) {
    return {
      message: 'Chrome interdit aux extensions de capturer cette page (pages internes de Chrome, Chrome Web Store).',
      expected: true,
    };
  }
  if (/frame with id|was removed/i.test(message)) {
    return { message: 'La page a changé pendant la capture (rechargement ou nouvelle adresse). Relance la capture.', expected: true };
  }
  if (/permission|activeTab|cannot access/i.test(message)) {
    // Chrome ne dit pas si la page refusée est un fichier local : on vérifie le réglage d'accès aux fichiers.
    const fileAccess = await chrome.extension.isAllowedFileSchemeAccess();
    const hint = fileAccess
      ? ''
      : " Pour un fichier ouvert depuis ton ordinateur, active aussi « Autoriser l'accès aux URL de fichier » dans les détails de l'extension (chrome://extensions).";
    return {
      message: `Autorisation manquante : clique sur l'icône de l'extension (ou son raccourci clavier) depuis la page à capturer.${hint}`,
      expected: true,
    };
  }
  return { message, expected: false };
}

function progress(tabId, done, total, block = false) {
  badge(tabId, `${Math.round((done / total) * 100)}%`, '#1a73e8');
  notify({ type: 'capture-progress', done, total, block });
}

// L'onglet peut avoir été fermé entre-temps : ces retouches de l'icône échouent alors sans conséquence.
function badge(tabId, text, color) {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (color) chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

function setTitle(tabId, title) {
  chrome.action.setTitle({ tabId, title }).catch(() => {});
}

function notify(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}
