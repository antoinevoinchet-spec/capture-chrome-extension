import { NOT_ALLOWED, PENDING_KEY, refusalMessage } from '../web-image/save-web-image.js';
import { parseVideoUrl } from '../transcript/youtube-url.js';
import { fillIcons, logo } from '../ui/icons.js';
import { countCaptures } from '../lib/db.js';

// Sécurité : si une lecture ci-dessous échoue, le panneau s'affiche quand même.
setTimeout(() => document.body.classList.remove('is-loading'), 150);
fillIcons();
document.querySelector('[data-logo]').replaceWith(logo(20));

const els = {
  full: document.getElementById('full'),
  visible: document.getElementById('visible'),
  pickBlock: document.getElementById('pick-block'),
  pickZone: document.getElementById('pick-zone'),
  devices: document.getElementById('devices'),
  status: document.getElementById('status'),
  statusText: document.getElementById('status-text'),
  barFill: document.getElementById('bar-fill'),
  cancel: document.getElementById('cancel'),
  error: document.getElementById('error'),
  errorText: document.getElementById('error-text'),
  recent: document.getElementById('recent'),
  convert: document.getElementById('convert'),
  transcript: document.getElementById('transcript'),
  transcribe: document.getElementById('transcribe'),
  shortcutHint: document.getElementById('shortcut-hint'),
  shortcutHintText: document.getElementById('shortcut-hint-text'),
  setShortcut: document.getElementById('set-shortcut'),
  version: document.getElementById('version'),
  shortcuts: document.getElementById('shortcuts'),
  tip: document.getElementById('tip'),
  tipClose: document.getElementById('tip-close'),
  recentCount: document.getElementById('recent-count'),
};

// « A », « A et B », « A, B et C ».
const listFr = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} et ${items.at(-1)}`);

// Espaces insécables dans les guillemets : un « » » ne se retrouve jamais seul en début de ligne.
const COMMAND_LABELS = { 'capture-full': '«\u00a0Page entière\u00a0»', 'capture-visible': '«\u00a0Visible\u00a0»', 'capture-pick': '«\u00a0Un bloc\u00a0»' };

els.version.textContent = `v${chrome.runtime.getManifest().version}`;
els.version.title = `Version ${chrome.runtime.getManifest().version}`;

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

// Chrome n'attribue pas un raccourci déjà pris par une autre extension, sans prévenir : on le signale.
const unassigned = [];
for (const command of await chrome.commands.getAll()) {
  const kbd = document.querySelector(`[data-shortcut="${command.name}"]`);
  if (!kbd) continue;
  if (command.shortcut) {
    kbd.textContent = command.shortcut;
    kbd.hidden = false;
  } else {
    unassigned.push(COMMAND_LABELS[command.name]);
  }
}
if (unassigned.length) {
  els.shortcutHintText.textContent = `Pas de raccourci pour ${listFr(unassigned)} : une autre extension a peut-être pris la touche.`;
  els.shortcutHint.hidden = false;
}
for (const button of [els.setShortcut, els.shortcuts]) {
  button.addEventListener('click', async () => {
    await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    window.close();
  });
}

// Astuce du clic droit : refermable, et fermée pour de bon.
const { tipRightClickClosed } = await chrome.storage.local.get('tipRightClickClosed');
els.tip.hidden = Boolean(tipRightClickClosed);
els.tipClose.addEventListener('click', () => {
  els.tip.hidden = true;
  chrome.storage.local.set({ tipRightClickClosed: true });
});

els.full.addEventListener('click', () => start('full'));
els.visible.addEventListener('click', () => start('visible'));
els.pickBlock.addEventListener('click', () => pick('block'));
els.pickZone.addEventListener('click', () => pick('zone'));
els.devices.addEventListener('click', startDevices);
els.recent.addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('viewer/viewer.html') });
  window.close();
});
els.convert.addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('convert/convert.html') });
  window.close();
});
els.transcribe.addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('transcript/transcript.html') });
  window.close();
});

// Transcription : seulement sur une page de vidéo YouTube. L'adresse de l'onglet actif est lisible grâce au clic sur l'icône (activeTab).
let videoId = null;
try {
  videoId = tab?.url ? parseVideoUrl(tab.url).videoId : null;
} catch {
  videoId = null;
}
els.transcript.hidden = !videoId;

// Tout ce qui change la hauteur est connu : le panneau s'affiche, et plus rien ne bouge au-dessus de la zone de statut.
document.body.classList.remove('is-loading');

// Le nombre de captures arrive après l'affichage, dans une place déjà réservée.
countCaptures()
  .then((count) => {
    els.recentCount.textContent = count ? String(count) : '';
    els.recent.setAttribute('aria-label', count ? `Captures récentes, ${count}` : 'Captures récentes');
  })
  .catch(() => {});
// La page s'ouvre toujours : avec l'accès à youtube.com, elle lit la vidéo ; sans lui, elle montre « Autoriser l'accès à YouTube ».
// La demande d'accès n'est pas faite ici : sous macOS, la fenêtre peut se fermer pendant la question de Chrome, et rien ne s'ouvrirait.
els.transcript.addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL(`transcript/transcript.html?v=${videoId}`), active: true });
  window.close();
});

els.cancel.addEventListener('click', () => {
  els.cancel.disabled = true;
  els.statusText.textContent = 'Annulation…';
  chrome.runtime.sendMessage({ type: 'capture-cancel' });
});

function showProgress(done, total, what) {
  els.barFill.style.width = `${Math.round((done / total) * 100)}%`;
  els.statusText.textContent = `Capture ${what} : ${done} sur ${total}`;
}

// « Téléphone (1 sur 3) : image 2 sur 7 ». La barre avance sur l'ensemble des appareils.
function showDevice({ label, index, count, done, total }) {
  els.barFill.style.width = `${Math.round(((index + (total ? done / total : 0)) / count) * 100)}%`;
  els.statusText.textContent = `${label} (${index + 1} sur ${count}) : ${total ? `image ${done} sur ${total}` : 'chargement de la page…'}`;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'capture-progress' && !els.cancel.disabled) {
    if (msg.block || msg.label) els.cancel.hidden = false;
    if (msg.label) showDevice(msg);
    else showProgress(msg.done, msg.total, msg.block ? 'du bloc' : 'de la page');
  }
  if (msg.type === 'capture-cancelled') {
    setBusy(false);
    els.cancel.hidden = true;
    els.cancel.disabled = false;
  }
  if (msg.type === 'capture-error') {
    showError(msg.message);
    chrome.storage.session.remove('lastError');
  }
  if (msg.type === 'capture-done') window.close();
});

// Refus survenu pendant une capture lancée au clavier : la fenêtre s'ouvre pour l'afficher.
const { lastError } = await chrome.storage.session.get('lastError');
if (lastError) {
  chrome.storage.session.remove('lastError');
  // La raison est lue, ou trop ancienne : la pastille « ! » de l'onglet concerné n'a plus rien à signaler.
  chrome.action.setBadgeText({ tabId: lastError.tabId ?? tab.id, text: '' }).catch(() => {});
  if (Date.now() - lastError.at < 5 * 60_000) showError(lastError.message);
}

// Une demande d'accès restée sans suite : le service worker s'est endormi pendant le refus et n'a rien pu dire.
const { [PENDING_KEY]: pendingImage } = await chrome.storage.session.get(PENDING_KEY);
if (pendingImage) {
  chrome.storage.session.remove(PENDING_KEY);
  if (Date.now() - pendingImage.at < 5 * 60_000) showError(refusalMessage(NOT_ALLOWED));
}

// Rouverte pendant la capture d'un bloc ou des trois appareils : la fenêtre retrouve la progression et le bouton d'annulation.
const { capturing } = await chrome.storage.session.get('capturing');
if (capturing) {
  setBusy(true);
  els.cancel.hidden = false;
  if (capturing.mode === 'devices') {
    if (capturing.label) showDevice(capturing);
    else els.statusText.textContent = 'Préparation…';
  } else if (capturing.total) showProgress(capturing.done, capturing.total, 'du bloc');
  else els.statusText.textContent = 'Préparation du bloc…';
}

async function start(mode) {
  els.error.hidden = true;
  setBusy(true);
  els.barFill.style.width = '0';
  els.statusText.textContent = mode === 'full' ? 'Préparation de la page…' : 'Capture…';
  const response = await chrome.runtime.sendMessage({ type: 'capture', mode, tabId: tab.id });
  if (!response?.ok) showError(response?.error ?? 'Capture impossible.');
}

async function startDevices() {
  // Première fois : une page de l'extension explique le bandeau de débogage et l'onglet à part, puis lance elle-même.
  const { devicesConfirmed } = await chrome.storage.local.get('devicesConfirmed');
  if (!devicesConfirmed) {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`devices/confirm.html?tab=${tab.id}`), active: true });
    window.close();
    return;
  }
  els.error.hidden = true;
  setBusy(true);
  els.cancel.hidden = false;
  els.cancel.disabled = false;
  els.barFill.style.width = '0';
  els.statusText.textContent = 'Préparation…';
  const response = await chrome.runtime.sendMessage({ type: 'capture-devices', tabId: tab.id });
  if (!response?.ok) showError(response?.error ?? 'Capture impossible.');
}

// Le choix se fait sur la page : la fenêtre se ferme dès que le calque est posé.
async function pick(mode) {
  els.error.hidden = true;
  const response = await chrome.runtime.sendMessage({ type: 'pick-start', mode, tabId: tab.id });
  if (response?.ok) window.close();
  else showError(response?.error ?? 'Capture impossible.');
}

function setBusy(busy) {
  els.full.disabled = busy;
  els.visible.disabled = busy;
  els.pickBlock.disabled = busy;
  els.pickZone.disabled = busy;
  els.devices.disabled = busy;
  els.status.hidden = !busy;
}

function showError(message) {
  setBusy(false);
  els.cancel.hidden = true;
  els.cancel.disabled = false;
  els.errorText.textContent = message;
  els.error.hidden = false;
}
