// Lecture d'une transcription dans un onglet temporaire (service worker).
// L'onglet YouTube de l'utilisateur n'est jamais touché : on ouvre la vidéo dans un onglet non actif, muet avant toute navigation vers YouTube,
// et toutes les sorties passent par un seul `finally` qui le ferme. Aucun sélecteur de page ici : tout ce qui touche à la page
// YouTube vit dans youtube-page.js.
// Voie principale 2b (fichier de sous-titres du lecteur), secours 1 (panneau « Transcription ») ; un changement de langue ne passe que par 2b.

import { cleanCueText, isComplete, trackKey, withEnds } from './format.js';
import { TranscriptError, watchUrl } from './youtube-url.js';
import { pageCaptureTimedtext, pageConsent, pagePlayerData, pagePreventPlayback, pageReadPanel } from './youtube-page.js';

export class TranscriptCancelled extends Error {
  name = 'TranscriptCancelled';
}

// Délais fixés par des mesures sur le vrai YouTube.
export const LIMITS = { pageMs: 30_000, timedtextMs: 25_000, panelMs: 30_000, totalMs: 60_000 };

export const MESSAGES = {
  noCaptions: 'Cette vidéo n’a pas de sous-titres : il n’y a pas de transcription à lire. (L’extension ne transcrit pas le son.)',
  privateOrGone: 'Cette vidéo est privée ou a été supprimée : YouTube ne la montre pas.',
  live: 'Cette vidéo est en direct : sa transcription n’existe qu’une fois le direct terminé. Réessaie plus tard.',
  premiere: 'Cette vidéo n’est pas encore diffusée (première programmée) : réessaie après sa diffusion.',
  age: 'Cette vidéo a une restriction d’âge : ouvre-la une fois sur YouTube en étant connecté à ton compte, puis relance la transcription.',
  members: 'Cette vidéo est réservée aux membres de la chaîne : YouTube ne la montre pas sans cet abonnement.',
  country: 'Cette vidéo est bloquée dans ton pays : YouTube ne la montre pas.',
  refused: (reason) => `YouTube refuse de montrer cette vidéo${reason ? ` (« ${reason} »)` : ''}. Vérifie qu’elle s’ouvre sur youtube.com.`,
  timeout: 'YouTube ne répond pas dans le délai prévu : la transcription n’est pas arrivée. Vérifie ta connexion, puis relance.',
  robot: 'YouTube demande de confirmer que tu n’es pas un robot : ouvre une vidéo sur youtube.com, connecte-toi si besoin, puis relance la transcription.',
  changed: (code) => `YouTube a changé sa page : la lecture ne marche plus, il faut mettre l’extension à jour. (étape : ${code})`,
  language: 'Cette langue n’a pas pu être lue. Réessaie, ou choisis une autre langue.',
  tempClosed: 'L’onglet de lecture a été fermé avant la fin. Relance la transcription.',
  access: 'L’extension n’a pas accès à youtube.com : elle en a besoin pour ouvrir la vidéo dans un onglet caché et lire ses sous-titres. Autorise l’accès, puis relance.',
  failed: 'La lecture de la transcription a échoué. Relance-la ; si cela recommence, recharge l’extension sur chrome://extensions.',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Piste par défaut : la langue du navigateur si elle existe (manuelle d'abord) ; sinon la langue parlée dans la vidéo, que révèle la piste
// automatique (YouTube n'en génère que dans cette langue), manuelle d'abord ; sinon la première manuelle, sinon la première.
export function defaultTrack(tracks, language = globalThis.navigator?.language ?? 'fr') {
  const lang = language.slice(0, 2);
  const spoken = tracks.find((t) => t.auto)?.code.slice(0, 2);
  const inLang = (code) => tracks.find((t) => !t.auto && t.code.startsWith(code)) ?? tracks.find((t) => t.auto && t.code.startsWith(code));
  return inLang(lang) ?? (spoken && inLang(spoken)) ?? tracks.find((t) => !t.auto) ?? tracks[0];
}

// Refus de YouTube, lus dans `playabilityStatus` (sa raison est écrite dans la langue de l'interface).
export function refusal({ status, reason, live, upcoming }) {
  if (status === 'OK') {
    if (live) return MESSAGES.live;
    if (upcoming) return MESSAGES.premiere;
    return null;
  }
  const why = reason ?? '';
  if (status === 'LIVE_STREAM_OFFLINE' || upcoming) return MESSAGES.premiere;
  if (/robot|\bbot\b/i.test(why)) return MESSAGES.robot;
  if (/membre|member/i.test(why)) return MESSAGES.members;
  if (/pays|country/i.test(why)) return MESSAGES.country;
  if (/âge|age|inappropri/i.test(why)) return MESSAGES.age;
  if (/privée|private|supprimée|removed|deleted|n.existe pas|unavailable|indisponible|plus disponible/i.test(why)) return MESSAGES.privateOrGone;
  if (status === 'LOGIN_REQUIRED') return MESSAGES.age;
  if (status === 'ERROR') return MESSAGES.privateOrGone;
  return MESSAGES.refused(why);
}

// Tout ce qui peut arrêter la lecture : annulation, page de transcription fermée, onglet temporaire fermé, délai.
function stopper() {
  let stop = null;
  const rejecters = new Set();
  return {
    halt: (err) => {
      stop ??= err;
      for (const reject of rejecters) reject(stop);
    },
    check: () => {
      if (stop) throw stop;
    },
    race: (promise) =>
      new Promise((resolve, reject) => {
        if (stop) return reject(stop);
        rejecters.add(reject);
        promise.then(resolve, reject).finally(() => rejecters.delete(reject));
      }),
  };
}

// Lit la transcription de `videoId`. `lang` : clé de piste (« en », « a.fr ») ; sans elle, la langue que choisit l'extension.
// `onStart({ tempId, halt })` reçoit l'onglet temporaire dès sa création ; `onProgress(seconds)` chaque seconde.
export async function readTranscript(videoId, { lang = null, onStart, onProgress, windowId } = {}) {
  const started = Date.now();
  const stop = stopper();
  let tempId = null;
  const timer = setTimeout(() => stop.halt(new TranscriptError(MESSAGES.timeout, 'timeout')), LIMITS.totalMs);
  const ticker = setInterval(() => onProgress?.(Math.round((Date.now() - started) / 1000)), 1000);
  const onRemoved = (tabId) => {
    if (tabId === tempId) stop.halt(new TranscriptError(MESSAGES.tempClosed, 'temp-closed'));
  };
  // L'onglet temporaire ne doit jamais s'afficher : s'il devient actif malgré tout, la lecture s'arrête et il est fermé aussitôt.
  const onActivated = ({ tabId }) => {
    if (tabId === tempId) stop.halt(new TranscriptCancelled());
  };
  chrome.tabs.onRemoved.addListener(onRemoved);
  chrome.tabs.onActivated.addListener(onActivated);

  const within = (promise, ms, code) => stop.race(Promise.race([promise, sleep(ms).then(() => { throw new TranscriptError(MESSAGES.timeout, code); })]));

  // YouTube recharge parfois sa page juste après l'arrivée (`&themeRefresh=1`) : le script est perdu, on attend la nouvelle page et on recommence une fois.
  const exec = async (func, args = []) => {
    for (let attempt = 0; ; attempt++) {
      stop.check();
      try {
        const [answer] = await stop.race(chrome.scripting.executeScript({ target: { tabId: tempId }, world: 'MAIN', func, args }));
        return answer?.result;
      } catch (err) {
        if (attempt || err instanceof TranscriptError || err instanceof TranscriptCancelled || !/frame|removed|navigat/i.test(String(err?.message))) throw err;
        await settle();
      }
    }
  };

  // La page est chargée et son adresse ne bouge plus depuis 1 s.
  const settle = () =>
    within(
      (async () => {
        let last = '';
        let since = Date.now();
        for (;;) {
          await sleep(250);
          const tab = await chrome.tabs.get(tempId);
          const key = `${tab.status} ${tab.url}`;
          if (key !== last) {
            last = key;
            since = Date.now();
          } else if (tab.status === 'complete' && Date.now() - since > 1000) return;
        }
      })(),
      LIMITS.pageMs,
      'load',
    );

  try {
    // Tout à gauche (après les onglets épinglés), loin de la page de transcription : quand on ferme celle-ci, Chrome active sa voisine,
    // qui ne doit pas être l'onglet temporaire.
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false, index: 0, ...(windowId ? { windowId } : {}) });
    tempId = tab.id;
    await onStart?.({ tempId, halt: stop.halt });
    // L'onglet vide finit de charger avant qu'on y touche : une navigation lancée pendant ce chargement peut être perdue,
    // et l'onglet reste « déchargé » (vu le 2026-11-18, onglet ouvert pendant le chargement de la page de transcription).
    await within(
      (async () => {
        while ((await chrome.tabs.get(tempId)).status !== 'complete') await sleep(50);
      })(),
      5000,
      'blank',
    );
    // Muet avant toute navigation vers YouTube : seul chrome.tabs coupe le son, jamais le lecteur.
    await chrome.tabs.update(tempId, { muted: true });
    stop.check();
    await chrome.tabs.update(tempId, { url: watchUrl(videoId) });
    await within(
      (async () => {
        let consented = false;
        let renavigated = false;
        for (;;) {
          await sleep(250);
          const now = await chrome.tabs.get(tempId);
          // Onglet déchargé par Chrome avant d'avoir chargé la vidéo : on renvoie l'adresse, une fois.
          if (now.status === 'unloaded' && !renavigated) {
            renavigated = true;
            await chrome.tabs.update(tempId, { url: watchUrl(videoId) });
            continue;
          }
          if (now.status !== 'complete') continue;
          // Page de consentement aux cookies (Europe, sans connexion) : « Tout refuser », une fois.
          if (/^https:\/\/consent\.youtube\.com\//.test(now.url ?? '') && !consented) {
            consented = Boolean(await exec(pageConsent));
            continue;
          }
          if (/^https:\/\/(www|m)\.youtube\.com\//.test(now.url ?? '')) return;
        }
      })(),
      LIMITS.pageMs,
      'load',
    );
    await settle();

    const data = await exec(pagePlayerData);
    if (!data || data.code) throw new TranscriptError(MESSAGES.changed(data?.code ?? 'player-data'), data?.code ?? 'player-data');
    await exec(pagePreventPlayback);
    const refused = refusal(data);
    if (refused) throw new TranscriptError(refused, `status-${data.status}`);
    // Signal positif : vidéo lisible, ni en direct ni à venir, aucune piste annoncée.
    if (!data.tracks.length) throw new TranscriptError(MESSAGES.noCaptions, 'no-tracks');

    const wanted = lang ? data.tracks.find((t) => trackKey(t) === lang) : defaultTrack(data.tracks);
    if (!wanted) throw new TranscriptError(MESSAGES.language, 'no-language');
    let route = 'timedtext';
    let track = wanted;
    let read = await within(exec(pageCaptureTimedtext, [videoId, wanted.code, wanted.auto, LIMITS.timedtextMs]), LIMITS.timedtextMs + 2000, 'timedtext');
    if (!read?.cues?.length) {
      // Une langue choisie ne se lit que par 2b : le panneau donne la langue de l'interface.
      if (lang) throw new TranscriptError(MESSAGES.language, read?.code ?? 'timedtext-empty');
      route = 'panel';
      track = null;
      // La page rend sa réponse avant le délai extérieur : un panneau vide donne « YouTube a changé sa page », pas « ne répond pas ».
      read = await within(exec(pageReadPanel, [null, LIMITS.panelMs - 5000]), LIMITS.panelMs, 'panel');
      if (!read?.cues?.length) throw new TranscriptError(MESSAGES.changed(read?.code ?? 'panel-empty'), read?.code ?? 'panel-empty');
    }

    const cleaned = read.cues.map((cue) => ({ ...cue, text: cleanCueText(cue.text) })).filter((cue) => cue.text);
    if (!cleaned.length) throw new TranscriptError(MESSAGES.changed(`${route}-text`), `${route}-text`);
    const cues = withEnds(cleaned, data.durationS);
    return {
      videoId,
      url: watchUrl(videoId),
      title: data.title,
      channel: data.channel,
      publishedAt: data.publishedAt,
      durationS: data.durationS,
      lang: track?.code ?? '',
      langLabel: track?.label ?? 'langue choisie par YouTube',
      auto: Boolean(track?.auto),
      languages: data.tracks.map(({ code, label, auto }) => ({ code, label, auto })),
      chapters: data.chapters,
      chaptersAuto: data.chaptersAuto,
      cues,
      complete: isComplete(cues, data.durationS),
      stopsAtS: cues.at(-1).start,
      route,
      createdAt: Date.now(),
    };
  } finally {
    clearTimeout(timer);
    clearInterval(ticker);
    chrome.tabs.onRemoved.removeListener(onRemoved);
    chrome.tabs.onActivated.removeListener(onActivated);
    if (tempId !== null) await chrome.tabs.remove(tempId).catch(() => {});
  }
}

// Toute autre panne (injection refusée, erreur de Chrome) devient un message en français ; le texte brut va seulement dans la console.
export function explainTranscriptError(err) {
  if (err instanceof TranscriptError) return err.message;
  console.error('Transcription impossible :', err);
  if (/cannot access|permission|host/i.test(String(err?.message))) return MESSAGES.access;
  if (/no tab with id|tab was closed/i.test(String(err?.message))) return MESSAGES.tempClosed;
  return MESSAGES.failed;
}
