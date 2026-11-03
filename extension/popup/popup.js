const els = {
  full: document.getElementById('full'),
  visible: document.getElementById('visible'),
  status: document.getElementById('status'),
  statusText: document.getElementById('status-text'),
  barFill: document.getElementById('bar-fill'),
  error: document.getElementById('error'),
  recent: document.getElementById('recent'),
  convert: document.getElementById('convert'),
  shortcutHint: document.getElementById('shortcut-hint'),
  shortcutHintText: document.getElementById('shortcut-hint-text'),
  setShortcut: document.getElementById('set-shortcut'),
  version: document.getElementById('version'),
};

const COMMAND_LABELS = { 'capture-full': '« Page entière »', 'capture-visible': '« Partie visible »' };

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
els.recent.addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('viewer/viewer.html') });
  window.close();
});
els.convert.addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('convert/convert.html') });
  window.close();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'capture-progress') {
    els.barFill.style.width = `${Math.round((msg.done / msg.total) * 100)}%`;
    els.statusText.textContent = `Capture de la page : ${msg.done} sur ${msg.total}`;
  }
  if (msg.type === 'capture-error') {
    showError(msg.message);
    chrome.storage.session.remove('lastError');
  }
  if (msg.type === 'capture-done') window.close();
});

// Refus survenu pendant une capture lancée au clavier : la fenêtre s'ouvre pour l'afficher.
const { lastError } = await chrome.storage.session.get('lastError');
if (lastError && Date.now() - lastError.at < 5 * 60_000) {
  showError(lastError.message);
  chrome.storage.session.remove('lastError');
}

async function start(mode) {
  els.error.hidden = true;
  setBusy(true);
  els.barFill.style.width = '0';
  els.statusText.textContent = mode === 'full' ? 'Préparation de la page…' : 'Capture…';
  const response = await chrome.runtime.sendMessage({ type: 'capture', mode, tabId: tab.id });
  if (!response?.ok) showError(response?.error ?? 'Capture impossible.');
}

function setBusy(busy) {
  els.full.disabled = busy;
  els.visible.disabled = busy;
  els.status.hidden = !busy;
}

function showError(message) {
  setBusy(false);
  els.error.textContent = message;
  els.error.hidden = false;
}
