// Page invisible de l'extension : un service worker n'a ni URL.createObjectURL ni Worker. Elle lit l'image, vérifie sa taille avant tout décodage,
// la fait convertir par le travailleur du convertisseur et rend l'adresse du fichier obtenu. Elle répond toujours, même si le travailleur lâche.

import { readImageSize } from './image-size.js';

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_PIXELS = 100_000_000;
const TIMEOUT_MS = 120_000;
const WORKER_PATH = 'convert/convert-worker.js';

const TOO_HEAVY = 'elle pèse plus de 100 Mo. Enregistre-la avec le menu de Chrome, puis passe-la dans le convertisseur.';
const TOO_LONG = 'le traitement a pris trop de temps. Réessaie, ou enregistre-la avec le menu de Chrome.';

// Un refus écrit pour l'utilisateur : il arrive tel quel dans la fenêtre de l'icône.
class Refusal extends Error {}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'web-image-offscreen') return false;
  prepareImage(msg).then(sendResponse, (err) => {
    if (!(err instanceof Refusal)) console.warn('Image non enregistrée :', err);
    sendResponse({ reason: err instanceof Refusal ? err.message : 'Chrome n’a pas pu la lire. Réessaie.' });
  });
  return true;
});

async function prepareImage({ url, format, workerUrl = WORKER_PATH, timeoutMs = TIMEOUT_MS }) {
  const { blob, contentType } = await fetchImage(url, timeoutMs);
  if (/svg/i.test(contentType)) throw new Refusal('c’est une image SVG, que ce clic droit ne prend pas en charge. Enregistre-la avec le menu de Chrome.');
  const size = readImageSize(new Uint8Array(await blob.arrayBuffer()));
  if (!size && !/^image\//i.test(contentType)) throw new Refusal('ce lien ne mène pas à une image. Recharge la page et réessaie.');
  if (!size) throw new Refusal('son format n’est pas reconnu (formats lus : PNG, JPEG, GIF, WebP, AVIF). Enregistre-la avec le menu de Chrome.');
  if (size.width * size.height > MAX_PIXELS) throw new Refusal('elle dépasse 100 mégapixels, ce qui demanderait trop de mémoire à ton ordinateur. Enregistre-la avec le menu de Chrome.');
  const converted = await convert(blob, format, workerUrl, timeoutMs);
  return { blobUrl: URL.createObjectURL(converted.blob), width: converted.width, height: converted.height };
}

async function fetchImage(url, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetch(url, { credentials: 'include', signal });
  } catch {
    if (signal.aborted) throw new Refusal(TOO_LONG);
    throw new Refusal('impossible de la lire : le site ne répond pas, ou l’accès aux sites n’est pas accordé. Refais le clic droit et accepte la demande de Chrome.');
  }
  if (!response.ok) {
    throw new Refusal(`le site a refusé de la donner (erreur ${response.status}). Elle demande peut-être une connexion, ou son lien a expiré : recharge la page et réessaie.`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_BYTES) {
    await response.body?.cancel();
    throw new Refusal(TOO_HEAVY);
  }
  // Lue au fil de l'eau : un site peut ne pas annoncer sa taille, ou mentir.
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new Refusal(TOO_HEAVY);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof Refusal) throw err;
    throw new Refusal(signal.aborted ? TOO_LONG : 'la connexion a été coupée pendant la lecture. Réessaie.');
  }
  const contentType = response.headers.get('content-type') ?? '';
  return { blob: new Blob(chunks, { type: contentType }), contentType };
}

// Même message que convert.js. Un travailleur par image : il ne garde rien en mémoire après.
function convert(blob, format, workerUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(chrome.runtime.getURL(workerUrl), { type: 'module' });
    const finish = (settle, value) => {
      clearTimeout(timer);
      worker.terminate();
      settle(value);
    };
    const timer = setTimeout(() => finish(reject, new Refusal(TOO_LONG)), timeoutMs);
    worker.onerror = (event) => {
      event.preventDefault();
      finish(reject, new Refusal('sa conversion a demandé trop de mémoire. Ferme quelques onglets et réessaie.'));
    };
    worker.onmessage = ({ data }) => {
      data.thumb?.close();
      if (data.error) finish(reject, new Refusal(data.error));
      else finish(resolve, data);
    };
    worker.postMessage({ id: 1, file: blob, options: { format, quality: 'high', resize: { mode: 'none' } } });
  });
}
