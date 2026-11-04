import { NOT_ALLOWED, PENDING_KEY, refusalMessage } from '../web-image/save-web-image.js';

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
  recent: document.getElementById('recent'),
  convert: document.getElementById('convert'),
  shortcutHint: document.getElementById('shortcut-hint'),
  shortcutHintText: document.getElementById('shortcut-hint-text'),
  setShortcut: document.getElementById('set-shortcut'),
  version: document.getElementById('version'),
};

const COMMAND_LABELS = { 'capture-full': '« Page entière »', 'capture-visible': '« Partie visible »', 'capture-pick': '« Un bloc »' };

els.version.textContent = `Version ${chrome.runtime.getManifest().version}`;

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
  els.shortcutHintText.textContent = `Pas de raccourci clavier pour ${unassigned.join(' et ')} : une autre extension utilise peut-être la même touche.`;
  els.shortcutHint.hidden = false;
}
els.setShortcut.addEventListener('click', async () => {
  await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  window.close();
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
  els.error.textContent = message;
  els.error.hidden = false;
}
