// Page de transcription : lien collé ou vidéo passée par `?v=<id>`, attente avec « Annuler »,
// aperçu, options, copie et téléchargements. La lecture elle-même se fait dans le service worker (reader.js).
// `?v=<id>&from=history` : affichée depuis l'historique, sans relire YouTube.

import { getTranscript } from '../lib/db.js';
import { downloadEnd } from '../lib/download-end.js';
import { DEFAULTS, TRANSCRIPT_FORMATS, TRANSCRIPT_TIMES, loadSettings, saveSettings } from '../lib/settings.js';
import { clock, fileBase, render, toSrt, trackKey } from './format.js';
import { ACCESS_MESSAGE, TranscriptError, YOUTUBE_ACCESS as YOUTUBE, parseVideoUrl } from './youtube-url.js';

const ACCESS_REFUSED = ACCESS_MESSAGE;
const INTERRUPTED = 'La lecture s’est interrompue : Chrome a arrêté l’extension en route. Relance la transcription.';
const FOLDER = 'Captures';
const WHERE = 'Téléchargements › Captures';

const CHECK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>';

const els = Object.fromEntries(
  ['title', 'summary', 'copy', 'save-md', 'save-txt', 'save-srt', 'lang', 'times', 'format', 'link-form', 'link', 'loading', 'loading-text', 'cancel', 'problem', 'problem-text', 'allow', 'incomplete', 'preview', 'toast'].map((id) => [
    id.replace(/-(\w)/g, (_, letter) => letter.toUpperCase()),
    document.getElementById(id),
  ]),
);

const state = {
  transcript: null,
  times: DEFAULTS.transcriptTimes,
  format: DEFAULTS.transcriptFormat,
  // La lecture en cours : { videoId, lang, port }.
  reading: null,
  // La vidéo à relire après l'accord d'accès (bouton « Autoriser »).
  pending: null,
};
let toastTimer;

// --- Affichage ---

function setState(name) {
  document.body.dataset.state = name;
  const ready = name === 'ready' && Boolean(state.transcript);
  for (const button of [els.copy, els.saveMd, els.saveTxt, els.saveSrt]) button.disabled = !ready;
  els.lang.disabled = !ready || !state.transcript.languages.length;
  els.loading.hidden = name !== 'loading';
  els.problem.hidden = name !== 'error';
  els.preview.hidden = !ready;
  els.incomplete.hidden = !ready || state.transcript.complete !== false;
}

function showProblem(message, { allow = false } = {}) {
  els.problemText.textContent = message;
  els.allow.hidden = !allow;
  setState('error');
  if (allow) els.allow.focus();
}

function buildSegmented(host, choices, onPick) {
  host.replaceChildren(
    ...Object.entries(choices).map(([key, { label }]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.key = key;
      button.textContent = label;
      button.addEventListener('click', () => onPick(key));
      return button;
    }),
  );
}

function setPressed(host, current) {
  for (const button of host.children) button.setAttribute('aria-pressed', String(button.dataset.key === current));
}

const shownText = () => render(state.transcript, { format: state.format, times: state.times });

function renderPreview() {
  setPressed(els.times, state.times);
  setPressed(els.format, state.format);
  if (!state.transcript) return;
  els.preview.textContent = shownText();
}

function showTranscript(transcript) {
  state.transcript = transcript;
  const { title, channel, durationS, complete, stopsAtS, languages } = transcript;
  els.title.textContent = title || 'Transcription';
  document.title = `${title || 'Vidéo'} – Transcription`;
  els.summary.replaceChildren(...[channel, durationS > 0 ? clock(durationS) : '', `${transcript.cues.length} passages`].filter(Boolean).map((text) => Object.assign(document.createElement('span'), { textContent: text })));
  // Langues : celles de la vidéo ; le panneau (secours) donne la langue choisie par YouTube, sans piste connue.
  const current = transcript.lang ? trackKey({ code: transcript.lang, auto: transcript.auto }) : '';
  const options = languages.map((item) => new Option(`${item.label || item.code}${item.auto && !/automati/i.test(item.label) ? ' (automatique)' : ''}`, trackKey(item)));
  if (!current) options.unshift(new Option('Choisie par YouTube', ''));
  els.lang.replaceChildren(...options);
  els.lang.value = current;
  els.incomplete.textContent = complete === false ? `Transcription peut-être incomplète : elle s’arrête à ${clock(stopsAtS)}, avant la fin de la vidéo.` : '';
  setState('ready');
  renderPreview();
}

// --- Lecture ---

// La connexion reste ouverte pendant la lecture : page fermée, le service worker arrête tout ; service worker arrêté, on le dit.
function startRead(videoId, lang = null) {
  if (state.reading) return;
  const port = chrome.runtime.connect({ name: 'transcript' });
  state.reading = { videoId, lang, port };
  port.onDisconnect.addListener(() => {
    if (state.reading?.port !== port) return;
    // Le service worker s'est arrêté pendant la lecture : ce message le réveille, il ferme l'onglet temporaire.
    chrome.runtime.sendMessage({ type: 'transcript-cancel', videoId }).catch(() => {});
    endRead();
    showProblem(INTERRUPTED);
  });
  history.replaceState(null, '', `?v=${videoId}`);
  els.loadingText.textContent = 'Lecture de la transcription…';
  setState('loading');
  els.cancel.focus();
  chrome.runtime.sendMessage({ type: 'transcript-read', videoId, ...(lang ? { lang } : {}) }).then(
    (answer) => {
      if (answer?.ok) return;
      endRead();
      // Refus pendant un changement de langue (« déjà en cours ») : le texte affiché reste là.
      if (state.transcript?.videoId === videoId) {
        showTranscript(state.transcript);
        toast(answer?.error ?? INTERRUPTED);
      } else showProblem(answer?.error ?? INTERRUPTED);
    },
    () => {
      endRead();
      showProblem(INTERRUPTED);
    },
  );
}

function endRead() {
  const port = state.reading?.port;
  state.reading = null;
  port?.disconnect();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!state.reading || !msg?.type?.startsWith('transcript-') || (msg.videoId && msg.videoId !== state.reading.videoId)) return;
  const { videoId } = state.reading;
  if (msg.type === 'transcript-progress') {
    els.loadingText.textContent = `Lecture de la transcription… ${msg.seconds} s`;
    return;
  }
  if (msg.type === 'transcript-done') {
    endRead();
    getTranscript(videoId).then((transcript) => (transcript ? showTranscript(transcript) : showProblem(INTERRUPTED)));
    return;
  }
  if (msg.type === 'transcript-error') {
    endRead();
    // Échec d'un changement de langue : l'ancien texte reste affiché, le message aussi.
    if (state.transcript?.videoId === videoId) {
      showTranscript(state.transcript);
      toast(msg.message);
    } else showProblem(msg.message);
    return;
  }
  if (msg.type === 'transcript-cancelled') {
    endRead();
    // Annulé pendant un changement de langue : l'ancien texte reste affiché.
    if (state.transcript?.videoId === videoId) {
      showTranscript(state.transcript);
      toast('Lecture annulée.');
    } else showProblem('Lecture annulée. Colle un lien pour recommencer.');
  }
});

// L'accès à youtube.com est demandé dans le geste lui-même, sans attente avant : Chrome perd sinon le geste et refuse.
function requestThenRead(videoId, lang = null) {
  chrome.permissions.request(YOUTUBE).then(
    (granted) => (granted ? startRead(videoId, lang) : showProblem(ACCESS_REFUSED, { allow: true })),
    () => showProblem(ACCESS_REFUSED, { allow: true }),
  );
  state.pending = { videoId, lang };
}

els.linkForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (state.reading) return;
  let videoId;
  try {
    ({ videoId } = parseVideoUrl(els.link.value));
  } catch (err) {
    showProblem(err instanceof TranscriptError ? err.message : String(err));
    els.link.focus();
    return;
  }
  state.transcript = null;
  requestThenRead(videoId);
});

els.allow.addEventListener('click', () => {
  if (state.pending) requestThenRead(state.pending.videoId, state.pending.lang);
});

els.cancel.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'transcript-cancel', videoId: state.reading?.videoId }).catch(() => {});
});

// Une autre langue relit la vidéo et remplace l'entrée de l'historique.
els.lang.addEventListener('change', () => {
  const t = state.transcript;
  if (!t || !els.lang.value) return;
  requestThenRead(t.videoId, els.lang.value);
});

// --- Copier, télécharger ---

els.copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(shownText());
    toast('Copié dans le presse-papiers.', { success: true });
  } catch {
    toast('La copie a échoué : clique dans la page, puis réessaie.');
  }
});

async function save(ext, content) {
  const blob = new Blob([content], { type: ext === 'srt' ? 'application/x-subrip' : ext === 'md' ? 'text/markdown' : 'text/plain' });
  const url = URL.createObjectURL(blob);
  const filename = `${FOLDER}/${fileBase(state.transcript)}.${ext}`;
  try {
    const id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
    // Réussi seulement quand le fichier est vraiment écrit (disque plein, téléchargement annulé…).
    const problem = await downloadEnd(id);
    if (problem) toast(`Le fichier .${ext} n’a pas pu être enregistré : ${problem}`);
    else toast(`Fichier .${ext} enregistré dans ${WHERE}.`, { success: true });
  } catch (err) {
    console.warn('Téléchargement refusé :', filename, err);
    toast('Chrome a refusé le téléchargement. Réessaie.');
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

// Le .md est toujours en Markdown et le .txt toujours en texte simple, avec les repères choisis.
els.saveMd.addEventListener('click', () => save('md', render(state.transcript, { format: 'markdown', times: state.times })));
els.saveTxt.addEventListener('click', () => save('txt', render(state.transcript, { format: 'text', times: state.times })));
els.saveSrt.addEventListener('click', () => save('srt', toSrt(state.transcript)));

function toast(message, { success = false } = {}) {
  const nodes = [];
  if (success) {
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.innerHTML = CHECK;
    nodes.push(icon);
  }
  nodes.push(Object.assign(document.createElement('span'), { textContent: message }));
  els.toast.replaceChildren(...nodes);
  els.toast.hidden = true;
  void els.toast.offsetWidth;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 7000);
}

// --- Mise en route ---

buildSegmented(els.times, TRANSCRIPT_TIMES, (key) => {
  state.times = key;
  saveSettings({ transcriptTimes: key });
  renderPreview();
});
buildSegmented(els.format, TRANSCRIPT_FORMATS, (key) => {
  state.format = key;
  saveSettings({ transcriptFormat: key });
  renderPreview();
});

async function start() {
  const settings = await loadSettings();
  state.times = settings.transcriptTimes;
  state.format = settings.transcriptFormat;
  renderPreview();
  const params = new URLSearchParams(location.search);
  const videoId = params.get('v');
  if (!videoId) {
    setState('empty');
    els.link.focus();
    return;
  }
  if (params.get('from') === 'history') {
    const kept = await getTranscript(videoId);
    if (kept) {
      showTranscript(kept);
      return;
    }
  }
  // Ouverte sans geste (fenêtre de l'icône) : l'accès ne peut pas être demandé ici ; s'il manque, le bouton « Autoriser » le demande.
  if (await chrome.permissions.contains(YOUTUBE)) startRead(videoId);
  else {
    state.pending = { videoId, lang: null };
    showProblem(ACCESS_REFUSED, { allow: true });
  }
}

start();
