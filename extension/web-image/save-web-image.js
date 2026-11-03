// Clic droit sur une image d'un site : la récupère en PNG ou JPG dans Téléchargements/Captures/Web.
// Le service worker peut s'endormir à tout moment : il n'attend pas l'utilisateur en mémoire. La demande en cours est notée dans storage.session,
// et l'accord la relance (permissions.onAdded), même après un réveil.

import { cleanBase } from '../lib/file-name.js';

const ORIGINS = ['http://*/*', 'https://*/*'];
const FOLDER = 'Captures/Web';
const OFFSCREEN = 'web-image/offscreen.html';
const OK_BADGE_MS = 3000;
const PENDING = 'pendingWebImage';
const FORBIDDEN_PAGE = /^(chrome|chrome-extension|edge|about|devtools):|^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)(\/|$)/i;

export const MENUS = [
  { id: 'save-image-png', title: 'Enregistrer en PNG', contexts: ['image'] },
  { id: 'save-image-jpg', title: 'Enregistrer en JPG', contexts: ['image'] },
];
const FORMAT_OF_MENU = { 'save-image-png': 'png', 'save-image-jpg': 'jpg' };

const PREFIX = 'Image non enregistrée : ';
export const NOT_ALLOWED = 'tu n’as pas autorisé l’accès aux sites. Refais le clic droit et accepte la demande de Chrome.';
export const refusalMessage = (reason) => `${PREFIX}${reason}`;
export const PENDING_KEY = PENDING;

// Demandes qui attendent la réponse de Chrome dans ce réveil du service worker : c'est elles qui concluent, pas onAdded.
let waitingHere = 0;
let activeSaves = 0;
let opening = null;

// Nom du fichier : le dernier morceau de l'adresse, nettoyé comme ceux du convertisseur, avec l'extension du format.
export function webImageName(srcUrl, format) {
  let last = '';
  try {
    const url = new URL(srcUrl);
    if (url.protocol !== 'data:') last = decodeURIComponent(url.pathname.split('/').pop());
  } catch {
    // Adresse mal écrite : le nom par défaut convient.
  }
  return `${cleanBase(last || 'image')}.${format}`;
}

// Refus connus sans rien lire. Le SVG se repère aussi dans la réponse du site (offscreen.js).
function earlyRefusal({ srcUrl, pageUrl }) {
  if (FORBIDDEN_PAGE.test(pageUrl ?? '')) return 'Chrome interdit aux extensions d’agir sur cette page (pages internes de Chrome, Chrome Web Store).';
  let url;
  try {
    url = new URL(srcUrl);
  } catch {
    return 'l’adresse de cette image est illisible.';
  }
  if (url.protocol === 'blob:') return 'c’est une image de type blob, sans adresse à lire. Fais plutôt une capture de la partie visible.';
  if (!['http:', 'https:', 'data:'].includes(url.protocol)) return 'cette adresse n’est pas celle d’un site web (seuls http, https et data sont lus).';
  if (/^data:image\/svg/i.test(srcUrl) || /\.svg$/i.test(url.pathname)) return 'c’est une image SVG, que ce clic droit ne prend pas en charge. Enregistre-la avec le menu de Chrome.';
  return '';
}

// Aucune attente avant la demande d'accès : Chrome la refuse si le geste de l'utilisateur est perdu. Fonction volontairement non `async`, et un refus
// connu d'avance (contrôle immédiat, sans attente) ne dérange pas l'utilisateur avec une demande inutile.
export function saveWebImage(request) {
  const refusal = earlyRefusal(request);
  if (refusal) return refuse(request, refusal);
  // Une image en data: est déjà dans l'adresse : aucun site à lire, donc aucun accès à demander.
  const asked = request.srcUrl.startsWith('data:') ? Promise.resolve(true) : chrome.permissions.request({ origins: ORIGINS });
  return afterAsking(request, asked);
}

async function afterAsking(request, asked) {
  waitingHere++;
  const [answer] = await Promise.allSettled([asked, chrome.storage.session.set({ [PENDING]: { ...request, at: Date.now() } })]);
  waitingHere--;
  await chrome.storage.session.remove(PENDING);
  if (answer.status === 'rejected') return refuse(request, 'Chrome n’a pas pu ouvrir sa demande d’accès. Refais le clic droit.');
  return answer.value ? fetchAndSave(request) : refuse(request, NOT_ALLOWED);
}

// L'accès vient d'être accordé et le service worker s'était endormi pendant la demande : c'est ici que l'enregistrement reprend.
export async function resumeWebImage() {
  if (waitingHere) return null;
  const { [PENDING]: pending } = await chrome.storage.session.get(PENDING);
  if (!pending) return null;
  await chrome.storage.session.remove(PENDING);
  return fetchAndSave(pending);
}

async function fetchAndSave(request) {
  const { srcUrl, format } = request;
  activeSaves++;
  try {
    await openDocument();
    const answer = await chrome.runtime.sendMessage({ target: 'web-image-offscreen', url: srcUrl, format, ...self.webImageTesting });
    if (!answer) return await refuse(request, 'Chrome n’a pas pu la lire. Réessaie.');
    if (answer.reason) return await refuse(request, answer.reason);
    const filename = `${FOLDER}/${webImageName(srcUrl, format)}`;
    const id = await chrome.downloads.download({ url: answer.blobUrl, filename, conflictAction: 'uniquify', saveAs: false });
    const problem = await downloadEnd(id);
    if (problem) return await refuse(request, problem);
    await saved(request);
    return { ok: true, filename };
  } catch (err) {
    console.warn('Image non enregistrée :', err);
    return refuse(request, 'Chrome n’a pas pu l’enregistrer. Réessaie.');
  } finally {
    // Le fichier est écrit : son adresse ne sert plus, le document peut partir.
    if (--activeSaves === 0) await chrome.offscreen.closeDocument().catch(() => {});
  }
}

// Un seul document à la fois, et deux clics rapprochés ne doivent pas tenter d'en créer deux.
async function openDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  opening ??= chrome.offscreen
    .createDocument({ url: OFFSCREEN, reasons: ['BLOBS', 'WORKERS'], justification: 'Lire l’image choisie au clic droit et préparer le fichier à enregistrer.' })
    .finally(() => {
      opening = null;
    });
  await opening;
}

// Attend que le fichier soit vraiment écrit. Rend le problème rencontré, ou une chaîne vide.
function downloadEnd(id) {
  const problemOf = (error) => (error === 'FILE_NO_SPACE' ? 'ton disque est plein. Libère de la place et réessaie.' : 'Chrome n’a pas pu écrire le fichier. Réessaie.');
  return new Promise((resolve) => {
    const finish = (problem) => {
      chrome.downloads.onChanged.removeListener(listener);
      resolve(problem);
    };
    const listener = (delta) => {
      if (delta.id !== id || !delta.state || delta.state.current === 'in_progress') return;
      finish(delta.state.current === 'complete' ? '' : problemOf(delta.error?.current));
    };
    chrome.downloads.onChanged.addListener(listener);
    chrome.downloads.search({ id }).then(([found]) => {
      if (!found || found.state === 'complete') finish('');
      else if (found.state === 'interrupted') finish(problemOf(found.error));
    });
  });
}

async function refuse({ tabId }, reason) {
  const message = refusalMessage(reason);
  await setBadge(tabId, '!', '#d93025');
  await chrome.action.setTitle({ tabId, title: message }).catch(() => {});
  await chrome.storage.session.set({ lastError: { message, at: Date.now() } });
  return { ok: false, reason };
}

async function saved({ tabId }) {
  await chrome.storage.session.remove('lastError');
  await chrome.action.setTitle({ tabId, title: 'Capture' }).catch(() => {});
  await setBadge(tabId, 'OK', '#1a7f37');
  setTimeout(async () => {
    // Un autre refus a pu arriver entre-temps : on n'efface que ce « OK ».
    const shown = await chrome.action.getBadgeText({ tabId }).catch(() => '');
    if (shown === 'OK') await setBadge(tabId, '');
  }, OK_BADGE_MS);
}

async function setBadge(tabId, text, color) {
  await chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (color) await chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

// À appeler de façon synchrone au chargement du service worker : Chrome ne réveille que les écoutes posées d'emblée.
export function setupWebImage() {
  chrome.runtime.onInstalled.addListener(() => {
    for (const menu of MENUS) chrome.contextMenus.create(menu);
  });
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    const format = FORMAT_OF_MENU[info.menuItemId];
    if (format) saveWebImage({ srcUrl: info.srcUrl, pageUrl: info.pageUrl, format, tabId: tab?.id });
  });
  chrome.permissions.onAdded.addListener(() => resumeWebImage());
  // Points d'entrée des tests automatisés : le vrai menu ne se pilote pas.
  self.saveWebImage = saveWebImage;
  self.resumeWebImage = resumeWebImage;
  self.webImageMenus = MENUS;
}
