// Derniers choix de l'utilisateur, réutilisés à la capture suivante.

export const DEFAULTS = { split: 'medium', format: 'png', transcriptTimes: 'paragraph', transcriptFormat: 'markdown' };

// Options de la page de transcription : repères de temps et format. La langue n'est pas retenue (elle dépend de la vidéo).
export const TRANSCRIPT_TIMES = {
  paragraph: { label: 'Par paragraphe' },
  cue: { label: 'À chaque passage' },
  none: { label: 'Aucun' },
};

export const TRANSCRIPT_FORMATS = {
  markdown: { label: 'Markdown' },
  text: { label: 'Texte simple' },
};

// Hauteur maximale d'une image, en points de page (×2 en pixels sur un écran Retina).
export const SPLITS = {
  screen: { label: '1 écran', points: null },
  short: { label: 'Court', points: 2000 },
  medium: { label: 'Moyen', points: 4000 },
  long: { label: 'Long', points: 8000 },
};

export const FORMATS = {
  png: { label: 'PNG', type: 'image/png', ext: 'png', hint: 'Sans perte, fichiers plus lourds.' },
  jpg: { label: 'JPG', type: 'image/jpeg', ext: 'jpg', hint: 'Léger, idéal pour envoyer ou partager.' },
  webp: { label: 'WebP', type: 'image/webp', ext: 'webp', hint: 'Le plus léger, net pour le web.' },
};

export async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return {
    split: SPLITS[stored.split] ? stored.split : DEFAULTS.split,
    format: FORMATS[stored.format] ? stored.format : DEFAULTS.format,
    transcriptTimes: TRANSCRIPT_TIMES[stored.transcriptTimes] ? stored.transcriptTimes : DEFAULTS.transcriptTimes,
    transcriptFormat: TRANSCRIPT_FORMATS[stored.transcriptFormat] ? stored.transcriptFormat : DEFAULTS.transcriptFormat,
  };
}

export const saveSettings = (patch) => chrome.storage.sync.set(patch);
