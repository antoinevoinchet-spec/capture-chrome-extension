// Adresses de vidéos YouTube : quels liens on accepte, et l'adresse propre qu'on ouvre dans l'onglet temporaire.
// Sans DOM ni chrome.* : s'importe aussi sous Node pour les tests.

// Erreur montrée telle quelle à l'utilisateur : `message` est toujours en français et dit quoi faire.
export class TranscriptError extends Error {
  constructor(message, code = '') {
    super(message);
    this.name = 'TranscriptError';
    this.code = code;
  }
}

// Accès demandé : la vidéo, et la page de consentement aux cookies que YouTube montre en Europe sans connexion.
// Toutes deux sont couvertes par `https://*/*`, déjà déclaré en accès facultatif : aucune permission nouvelle.
export const YOUTUBE_ACCESS = { origins: ['https://www.youtube.com/*', 'https://consent.youtube.com/*'] };

// Accès à youtube.com refusé ou manquant : dit à quoi il sert.
export const ACCESS_MESSAGE =
  'L’extension a besoin d’accéder à youtube.com pour ouvrir la vidéo dans un onglet caché et lire ses sous-titres. Rien d’autre n’est lu, et ton onglet YouTube n’est pas touché.';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const NOT_A_VIDEO = 'Ce lien n’est pas une vidéo YouTube. Colle l’adresse d’une vidéo, par exemple https://www.youtube.com/watch?v=…';

export function parseVideoUrl(text) {
  const raw = String(text ?? '').trim();
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new TranscriptError(NOT_A_VIDEO, 'not-video');
  }
  const host = url.hostname.toLowerCase();
  if (host === 'music.youtube.com') {
    throw new TranscriptError('Les liens YouTube Music ne sont pas pris en charge : ouvre la vidéo sur youtube.com et copie son adresse.', 'music');
  }
  if (host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) {
    throw new TranscriptError('Ce lien est une vidéo intégrée dans un autre site : ouvre-la sur youtube.com et copie son adresse.', 'embed');
  }

  let id = '';
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1] ?? '';
  } else if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host)) {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'embed') {
      throw new TranscriptError('Ce lien est une vidéo intégrée dans un autre site : ouvre-la sur youtube.com et copie son adresse.', 'embed');
    }
    if (parts[0] === 'watch' && parts.length === 1) id = url.searchParams.get('v') ?? '';
    else if (parts[0] === 'shorts' && parts.length === 2) id = parts[1];
    else if (url.searchParams.has('list')) {
      throw new TranscriptError('Ce lien est une liste de lecture : ouvre une des vidéos et copie son adresse.', 'playlist');
    }
  }
  if (!VIDEO_ID.test(id)) throw new TranscriptError(NOT_A_VIDEO, 'not-video');
  return { videoId: id };
}

// Adresse ouverte dans l'onglet temporaire et écrite dans l'en-tête : sans `t=`, `list=` ni autre paramètre.
export const watchUrl = (videoId) => `https://www.youtube.com/watch?v=${videoId}`;
