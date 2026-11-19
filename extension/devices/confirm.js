// Confirmation avant la première capture sur trois appareils.
// L'onglet à capturer arrive dans l'adresse (?tab=<id>). « Continuer » mémorise la confirmation, lance la capture
// comme le faisait le panneau, rend l'onglet capturé actif et ferme cette page.
import { fillIcons, logo } from '../ui/icons.js';

fillIcons();
document.querySelector('[data-logo]').replaceWith(logo(24));

const tabId = Number(new URLSearchParams(location.search).get('tab'));
const els = {
  continue: document.getElementById('continue'),
  cancel: document.getElementById('cancel'),
  gone: document.getElementById('gone'),
};

async function closeSelf() {
  const self = await chrome.tabs.getCurrent();
  if (self) await chrome.tabs.remove(self.id);
  else window.close();
}

async function targetTab() {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

function showGone() {
  els.gone.hidden = false;
  els.continue.hidden = true;
  els.cancel.textContent = 'Fermer';
}

if (!tabId || !(await targetTab())) showGone();

els.cancel.addEventListener('click', closeSelf);

els.continue.addEventListener('click', async () => {
  const tab = await targetTab();
  if (!tab) return showGone();
  els.continue.setAttribute('aria-busy', 'true');
  await chrome.storage.local.set({ devicesConfirmed: true });
  const response = await chrome.runtime.sendMessage({ type: 'capture-devices', tabId });
  if (!response?.ok) {
    els.continue.removeAttribute('aria-busy');
    els.gone.querySelector('span:last-child').textContent = response?.error ?? 'Capture impossible.';
    els.gone.hidden = false;
    return;
  }
  // On revient sur la page capturée, comme avant cette confirmation ; la progression se suit depuis l'icône.
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  await closeSelf();
});

document.body.dataset.ready = 'true';
