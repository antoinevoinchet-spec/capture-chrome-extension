// Mise en forme d'une transcription, sans IA : en-tête, chapitres, paragraphes, repères de temps, .srt.
// Fonctions pures, sans DOM ni chrome.* : s'importent aussi sous Node pour les tests.
//
// Modèle `Transcript` (secondes en nombres) :
//   { videoId, url, title, channel, publishedAt, durationS, lang, langLabel, auto, languages: [{ code, label, auto }],
//     chapters: [{ start, title }], chaptersAuto, cues: [{ start, end, text }], complete, stopsAtS, route, createdAt }
// `route` : 'timedtext' (voie 2b, débuts et fins exacts) ou 'panel' (voie 1, heure à la seconde, sans fin).

import { cleanBase } from '../lib/file-name.js';

// Règles fixées par des mesures sur le vrai YouTube.
export const COMPLETE_GAP_S = 60;
export const PARAGRAPH_MAX = 600;
const PAUSE_MIN_S = 1.5;

// Clé d'une piste de sous-titres : « fr » (manuelle) ou « a.fr » (automatique). Une même langue peut avoir les deux.
export const trackKey = ({ code, auto }) => `${auto ? 'a.' : ''}${code}`;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// Texte d'un passage : entités décodées une seule fois, retours à la ligne et espaces multiples ramenés à un espace.
// Les marqueurs comme [Musique] sont gardés tels quels.
export function cleanCueText(text) {
  return String(text ?? '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/[\s ​]+/g, ' ')
    .trim();
}

// Chaque passage reçoit une fin : la sienne si la voie la donne, sinon le début du suivant, la durée de la vidéo pour le dernier.
// Une fin est toujours après le début (deux passages à la même seconde, durée inconnue).
export function withEnds(cues, durationS) {
  return cues.map((cue, i) => {
    let end = Number.isFinite(cue.end) && cue.end > cue.start ? cue.end : i + 1 < cues.length ? cues[i + 1].start : durationS;
    if (!(end > cue.start)) end = cue.start + 1;
    return { ...cue, end };
  });
}

// Règle de complétude : le dernier passage commence à au plus 60 s de la fin. Durée inconnue : on ne peut rien dire.
export function isComplete(cues, durationS) {
  if (!cues.length) return false;
  if (!(durationS > 0)) return true;
  return durationS - cues[cues.length - 1].start <= COMPLETE_GAP_S;
}

const usable = (cues) => cues.map((cue) => ({ ...cue, text: cleanCueText(cue.text) })).filter((cue) => cue.text);

// Paragraphes : coupure à chaque chapitre ; à une pause plus longue que 1,5 s et que deux fois l'écart médian (voie 2b seulement,
// le panneau n'ayant pas de fin) ; au passage qui ferait dépasser 600 caractères.
// Chaque paragraphe garde ses passages (`cues`) pour les repères « à chaque passage ».
export function paragraphs(transcript) {
  const cues = usable(transcript.cues ?? []);
  const chapters = [...(transcript.chapters ?? [])].sort((a, b) => a.start - b.start);
  const exact = transcript.route !== 'panel';
  const gaps = exact ? cues.slice(1).map((cue, i) => Math.max(0, cue.start - (cues[i].end ?? cues[i].start))) : [];
  const median = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0;
  const pause = Math.max(PAUSE_MIN_S, 2 * median);

  const list = [];
  let current = null;
  let nextChapter = 0;
  cues.forEach((cue, i) => {
    let chapter;
    // Un chapitre sans aucun passage n'a pas de titre : celui retenu est le dernier commencé avant ce passage.
    while (nextChapter < chapters.length && chapters[nextChapter].start <= cue.start) chapter = chapters[nextChapter++].title;
    const paused = exact && i > 0 && cue.start - (cues[i - 1].end ?? cues[i - 1].start) > pause;
    const tooLong = current && current.text.length + 1 + cue.text.length > PARAGRAPH_MAX;
    if (!current || chapter !== undefined || paused || tooLong) {
      current = { start: cue.start, text: cue.text, cues: [cue] };
      if (chapter !== undefined) current.chapter = chapter;
      list.push(current);
    } else {
      current.text += ` ${cue.text}`;
      current.cues.push(cue);
    }
  });
  return list;
}

// 75 → « 1:15 », 3723 → « 1:02:03 ».
export function clock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

// « 2024-03-05 » ou « 2024-03-05T07:00:00-08:00 » → « 5 mars 2024 » (date du jour donnée par YouTube, sans fuseau).
function frenchDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? '');
  if (!match) return '';
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${Number(match[3])} ${month} ${match[1]}` : '';
}

// Échappe ce qui changerait le sens d'un titre en Markdown (#, *, _, [, ], `, \, <, >).
const escapeMarkdown = (text) => text.replace(/[\\`*_[\]#<>]/g, '\\$&');

function header(t, markdown) {
  const title = t.title?.trim() || 'Vidéo YouTube';
  const facts = [];
  if (t.channel) facts.push(['Chaîne', t.channel]);
  const date = frenchDate(t.publishedAt);
  if (date) facts.push(['Mise en ligne', date]);
  if (t.durationS > 0) facts.push(['Durée', clock(t.durationS)]);
  facts.push(['Lien', t.url]);
  const lang = t.langLabel || t.lang;
  if (lang) facts.push(['Langue', t.auto ? `${lang} (sous-titres automatiques)` : lang]);
  if (t.chapters?.length && t.chaptersAuto) facts.push(['Chapitres', 'chapitres automatiques (créés par YouTube)']);
  if (t.complete === false) {
    const at = Number.isFinite(t.stopsAtS) ? ` : elle s’arrête à ${clock(t.stopsAtS)}` : '';
    facts.push(['Attention', `transcription peut-être incomplète${at}`]);
  }
  if (markdown) {
    const value = (label, text) => (label === 'Lien' ? text : escapeMarkdown(text));
    return [`# ${escapeMarkdown(title)}`, '', ...facts.map(([label, text]) => `- ${label} : ${value(label, text)}`)].join('\n');
  }
  return [title, '', ...facts.map(([label, text]) => `${label} : ${text}`)].join('\n');
}

// Texte affiché, copié et téléchargé (.md, .txt). `times` : un repère par paragraphe, un à chaque passage, ou aucun.
export function render(transcript, { format = 'markdown', times = 'paragraph' } = {}) {
  const markdown = format === 'markdown';
  const blocks = [header(transcript, markdown)];
  for (const paragraph of paragraphs(transcript)) {
    if (paragraph.chapter !== undefined) blocks.push(markdown ? `## ${escapeMarkdown(paragraph.chapter)}` : paragraph.chapter);
    if (times === 'cue') blocks.push(paragraph.cues.map((cue) => `[${clock(cue.start)}] ${cue.text}`).join('\n'));
    else if (times === 'none') blocks.push(paragraph.text);
    else blocks.push(`[${clock(paragraph.start)}] ${paragraph.text}`);
  }
  return `${blocks.join('\n\n')}\n`;
}

// 4.5 → « 00:00:04,500 ».
function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

// Fichier de sous-titres : tous les passages, numérotés à partir de 1, début et fin, une ligne vide entre deux blocs.
export function toSrt(transcript) {
  const cues = withEnds(usable(transcript.cues ?? []), transcript.durationS);
  return cues.map((cue, i) => `${i + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}\n`).join('\n');
}

// Nom des fichiers téléchargés, sans extension. `cleanBase` coupe après le dernier point : on lui donne « titre.x »
// pour garder les points du titre (« Node.js en 100 s »).
export function fileBase(transcript) {
  const title = transcript.title?.trim() ?? '';
  if (!title) return 'transcription';
  const base = cleanBase(`${title}.x`);
  return base === 'image' ? 'transcription' : base;
}
