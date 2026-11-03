// Page du convertisseur : la liste des images, les réglages et les téléchargements.
// Le travail se fait à part (convert-worker.js), une image à la fois. Rien n'est gardé après la fermeture de l'onglet.

import { FORMATS } from '../lib/settings.js';
import { buildPdf } from './pdf.js';

const FOLDER = 'Captures/Conversions';
const WHERE = 'Téléchargements › Captures › Conversions';

const OUTPUTS = {
  jpg: FORMATS.jpg,
  png: FORMATS.png,
  webp: FORMATS.webp,
  pdf: { label: 'PDF', ext: 'pdf', hint: 'Toutes les images réunies en un seul fichier.' },
};
const QUALITIES = {
  high: { label: 'Haute', hint: 'Très proche de l’original, fichier plus lourd.', pdfHint: 'PNG, BMP et GIF gardent tous leurs pixels, fichier plus lourd.' },
  medium: { label: 'Moyenne', hint: 'Bon compromis entre netteté et poids.' },
  light: { label: 'Légère', hint: 'Le plus léger, détails moins nets.' },
};
const RESIZES = {
  none: { label: 'Origine' },
  width: { label: 'Largeur', unit: 'px', initial: 1920, max: 100000, name: 'Largeur en pixels', error: 'Indique une largeur en nombre entier, entre 1 et 100 000 px.' },
  height: { label: 'Hauteur', unit: 'px', initial: 1080, max: 100000, name: 'Hauteur en pixels', error: 'Indique une hauteur en nombre entier, entre 1 et 100 000 px.' },
  percent: { label: '%', unit: '%', initial: 50, max: 100, name: 'Pourcentage de la taille d’origine', error: 'Indique un pourcentage entier, entre 1 et 100.' },
};
// Délai pendant lequel « Annuler », arrivé sous la souris, ignore le second clic d'un double clic sur « Convertir ».
const CANCEL_GRACE_MS = 500;
// Chrome refuse ces noms hérités de Windows, quel que soit le système, quelle que soit la suite du nom.
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|clock\$)(\.|$)/i;
const SAVE_PROBLEMS = {
  FILE_NO_SPACE: 'disque plein',
  FILE_ACCESS_DENIED: 'accès refusé',
  FILE_NAME_TOO_LONG: 'nom trop long',
  FILE_TOO_LARGE: 'fichier trop gros',
  USER_CANCELED: 'annulé',
};
const REFUSED = 'refusée par Chrome';

const CHECK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>';

const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });
const decimal = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });

const els = Object.fromEntries(
  ['summary', 'cancel', 'convert', 'download-all', 'format', 'format-hint', 'quality', 'quality-section', 'quality-hint', 'resize', 'resize-field', 'resize-name', 'resize-value', 'resize-unit', 'resize-error', 'drop', 'files', 'list-head', 'list-count', 'clear', 'list', 'toast'].map((id) => [id.replace(/-(\w)/g, (_, letter) => letter.toUpperCase()), document.getElementById(id)]),
);

const state = {
  items: [],
  format: 'jpg',
  quality: 'high',
  resizeMode: 'none',
  running: false,
  saving: false,
  startedAt: 0,
  pdf: null,
  run: 0,
  nextId: 1,
};

let worker = null;
let answer = null;
let toastTimer;

const isPdf = () => state.format === 'pdf';
const withStatus = (status) => state.items.filter((item) => item.status === status);
const plural = (count, one, many) => (count > 1 ? many : one);
const images = (count) => `${count} ${plural(count, 'image', 'images')}`;

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
  return `${decimal.format(bytes / (1024 * 1024))} Mo`;
}

// --- Réglages ---

function resizeValue() {
  return Number(els.resizeValue.value);
}

// Message d'erreur du champ de taille, ou chaîne vide si la valeur convient.
function resizeProblem() {
  const choice = RESIZES[state.resizeMode];
  if (state.resizeMode === 'none') return '';
  const value = resizeValue();
  const valid = els.resizeValue.value.trim() !== '' && Number.isInteger(value) && value >= 1 && value <= choice.max;
  return valid ? '' : choice.error;
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
  for (const button of host.children) {
    button.setAttribute('aria-pressed', String(button.dataset.key === current));
    button.disabled = state.running;
  }
}

// Un réglage change : les fichiers déjà faits n'y correspondent plus. On les efface pour ne jamais en télécharger un qui serait faux.
function settingsChanged() {
  for (const item of state.items) {
    item.status = 'waiting';
    item.result = null;
    item.error = null;
    item.saveProblem = null;
  }
  state.pdf = null;
  render();
}

function pickFormat(key) {
  if (key === state.format) return;
  state.format = key;
  chrome.storage.sync.set({ convertFormat: key });
  settingsChanged();
}

function pickQuality(key) {
  if (key === state.quality) return;
  state.quality = key;
  chrome.storage.sync.set({ convertQuality: key });
  settingsChanged();
}

function pickResize(key) {
  if (key === state.resizeMode) return;
  state.resizeMode = key;
  if (key !== 'none') els.resizeValue.value = RESIZES[key].initial;
  settingsChanged();
}

function options() {
  return {
    format: state.format,
    quality: state.quality,
    resize: { mode: state.resizeMode, value: resizeValue() },
  };
}

// --- La liste ---

function addFiles(files) {
  if (!files.length) return;
  if (state.running) {
    toast('Une conversion est en cours : attends la fin ou annule-la pour ajouter des images.');
    return;
  }
  const added = [...files].sort((a, b) => collator.compare(a.name, b.name)).map(createItem);
  state.items.push(...added);
  listChanged();
}

function createItem(file) {
  const item = { id: state.nextId++, file, status: 'waiting', result: null, error: null, saveProblem: null };
  item.row = createRow(item);
  return item;
}

function removeItem(item) {
  const index = state.items.indexOf(item);
  state.items.splice(index, 1);
  releasePreview(item);
  listChanged();
  const next = state.items[Math.min(index, state.items.length - 1)];
  (next ? next.row.querySelector('.item-remove') : els.files).focus();
}

function moveItem(item, delta, button) {
  const index = state.items.indexOf(item);
  state.items.splice(index, 1);
  state.items.splice(index + delta, 0, item);
  listChanged();
  if (!button.disabled) button.focus();
  else item.row.querySelector(delta < 0 ? '.item-down' : '.item-up').focus();
}

// La liste change : les fichiers des images restantes sont toujours justes, seul le PDF est à refaire.
function listChanged() {
  state.pdf = null;
  render();
  refreshPdf();
}

function iconButton(symbol, label, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `item-icon ${className}`;
  button.textContent = symbol;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.addEventListener('click', onClick);
  return button;
}

function createRow(item) {
  const row = document.createElement('li');
  row.className = 'item';
  const thumb = document.createElement('div');
  thumb.className = 'item-thumb';
  const text = document.createElement('div');
  text.className = 'item-text';
  const name = document.createElement('span');
  name.className = 'item-name';
  name.textContent = item.file.name;
  name.title = item.file.name;
  const detail = document.createElement('span');
  detail.className = 'item-detail';
  text.append(name, detail);
  const actions = document.createElement('div');
  actions.className = 'item-actions';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn-secondary item-save';
  save.textContent = 'Télécharger';
  // event.detail > 1 : second clic d'un double clic, qui enregistrerait une copie de plus ou retirerait la ligne suivante.
  save.addEventListener('click', (event) => {
    if (event.detail <= 1) downloadOne(item);
  });
  const up = iconButton('↑', 'Monter cette page', 'item-up', (event) => moveItem(item, -1, event.currentTarget));
  const down = iconButton('↓', 'Descendre cette page', 'item-down', (event) => moveItem(item, 1, event.currentTarget));
  const remove = iconButton('×', `Retirer ${item.file.name}`, 'item-remove', (event) => {
    if (event.detail <= 1) removeItem(item);
  });
  actions.append(save, up, down, remove);
  row.append(thumb, text, actions);
  showPreview(item, thumb);
  return row;
}

// L'image de départ, visible dès l'ajout. Chrome ne sait pas afficher le HEIC : son aperçu arrive avec sa conversion.
// `lazy` : une longue liste ne charge que ce qui est à l'écran.
function showPreview(item, thumb) {
  const preview = document.createElement('img');
  preview.alt = '';
  preview.decoding = 'async';
  preview.loading = 'lazy';
  item.previewUrl = URL.createObjectURL(item.file);
  preview.addEventListener('error', () => {
    releasePreview(item);
    const note = document.createElement('span');
    note.className = 'item-thumb-note';
    note.textContent = 'Aperçu à la conversion';
    thumb.replaceChildren(note);
  });
  preview.src = item.previewUrl;
  thumb.append(preview);
}

function releasePreview(item) {
  if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  item.previewUrl = null;
}

function showThumb(item, bitmap) {
  const thumb = item.row.querySelector('.item-thumb');
  const preview = thumb.querySelector('img');
  if (preview?.complete && preview.naturalWidth > 0) {
    bitmap.close();
    return;
  }
  releasePreview(item);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  thumb.replaceChildren(canvas);
}

function detailText(item) {
  const { file, status, result, error } = item;
  if (status === 'waiting') return `En attente, ${formatSize(file.size)}`;
  if (status === 'working') return 'Conversion…';
  if (status === 'error') return error;
  const { width, height, sourceWidth, sourceHeight, blob } = result;
  if (isPdf()) return `Page ${withStatus('done').indexOf(item) + 1}, ${width} × ${height}`;
  return `${sourceWidth} × ${sourceHeight}, ${formatSize(file.size)} → ${width} × ${height}, ${formatSize(blob.size)}`;
}

function renderItem(item) {
  const { row, status, result } = item;
  row.dataset.status = status;
  const detail = row.querySelector('.item-detail');
  detail.textContent = detailText(item);
  for (const message of [result?.notice, item.saveProblem && `Non enregistrée : ${item.saveProblem}`]) {
    if (!message) continue;
    const notice = document.createElement('span');
    notice.className = 'item-notice';
    notice.textContent = ` ${message}.`;
    detail.append(notice);
  }
  const save = row.querySelector('.item-save');
  save.hidden = isPdf() || status !== 'done';
  // Pas désactivé pendant un enregistrement : le bouton perdrait le clavier. saveAll ignore les clics en trop.
  save.disabled = state.running;
  const index = state.items.indexOf(item);
  const up = row.querySelector('.item-up');
  const down = row.querySelector('.item-down');
  up.hidden = down.hidden = !isPdf();
  up.disabled = state.running || index === 0;
  down.disabled = state.running || index === state.items.length - 1;
  row.querySelector('.item-remove').disabled = state.running;
}

function summaryText() {
  const total = state.items.length;
  const done = withStatus('done');
  const errors = withStatus('error').length;
  const waiting = withStatus('waiting').length;
  if (!total) return 'Aucune image pour l’instant.';
  if (state.running) return `Conversion ${done.length + errors + 1} sur ${total}…`;
  if (!done.length && !errors) return `${images(total)} à convertir.`;
  if (waiting) return `${images(waiting)} à convertir, ${done.length} ${plural(done.length, 'prête', 'prêtes')}.`;
  if (!done.length) return `${errors} ${plural(errors, 'erreur', 'erreurs')} : rien à télécharger.`;
  const errorText = errors ? `, ${errors} ${plural(errors, 'erreur', 'erreurs')}` : '';
  if (isPdf()) {
    const missing = errors ? ` ${images(errors)} ${plural(errors, 'n’a pas pu être ajoutée', 'n’ont pas pu être ajoutées')}.` : '';
    return `PDF de ${done.length} ${plural(done.length, 'page', 'pages')}${state.pdf ? `, ${formatSize(state.pdf.size)}` : ''}.${missing}`;
  }
  const before = done.reduce((sum, item) => sum + item.file.size, 0);
  const after = done.reduce((sum, item) => sum + item.result.blob.size, 0);
  return `${images(done.length)} ${plural(done.length, 'prête', 'prêtes')}${errorText}. ${formatSize(after)} pour ${formatSize(before)} au départ.`;
}

function render() {
  document.body.dataset.state = state.running ? 'running' : 'idle';
  setPressed(els.format, state.format);
  setPressed(els.quality, state.quality);
  setPressed(els.resize, state.resizeMode);
  els.qualitySection.hidden = state.format === 'png';
  els.formatHint.textContent = OUTPUTS[state.format].hint;
  const quality = QUALITIES[state.quality];
  els.qualityHint.textContent = (isPdf() && quality.pdfHint) || quality.hint;

  const choice = RESIZES[state.resizeMode];
  els.resizeField.hidden = state.resizeMode === 'none';
  els.resizeValue.disabled = state.running;
  if (state.resizeMode !== 'none') {
    els.resizeName.textContent = choice.name;
    els.resizeUnit.textContent = choice.unit;
    els.resizeValue.max = choice.max;
  }
  const problem = resizeProblem();
  els.resizeError.textContent = problem;
  els.resizeError.hidden = !problem;

  const waiting = withStatus('waiting').length;
  const done = withStatus('done').length;
  els.convert.hidden = state.running;
  els.cancel.hidden = !state.running;
  els.convert.textContent = waiting ? `Convertir (${waiting})` : 'Convertir';
  els.convert.disabled = !waiting || Boolean(problem);
  els.convert.className = waiting ? 'btn-primary' : 'btn-secondary';

  const ready = !state.running && !waiting && done > 0;
  els.downloadAll.textContent = isPdf() ? 'Télécharger le PDF' : done === 1 ? 'Télécharger l’image' : done ? `Tout télécharger (${images(done)})` : 'Tout télécharger';
  els.downloadAll.disabled = !ready || (isPdf() && !state.pdf);
  els.downloadAll.className = ready ? 'btn-primary' : 'btn-secondary';

  els.summary.textContent = summaryText();
  els.listHead.hidden = !state.items.length;
  els.listCount.textContent = images(state.items.length);
  els.clear.disabled = state.running;
  // Seulement si l'ordre a changé : réinsérer une ligne ferait perdre sa place au clavier.
  const ordered = state.items.map((item) => item.row);
  if (ordered.length !== els.list.children.length || ordered.some((row, index) => row !== els.list.children[index])) els.list.replaceChildren(...ordered);
  state.items.forEach(renderItem);
}

// --- La conversion ---

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./convert-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => answer?.(data);
  // Le travailleur a lâché (mémoire, le plus souvent) : l'image en cours est en erreur, un autre prendra la suite.
  worker.onerror = (event) => {
    event.preventDefault();
    worker?.terminate();
    worker = null;
    answer?.({ error: 'Conversion impossible : cette image demande trop de mémoire.' });
  };
  return worker;
}

const ask = (item, settings) =>
  new Promise((resolve) => {
    answer = resolve;
    getWorker().postMessage({ id: item.id, file: item.file, options: settings });
  });

async function start() {
  if (state.running || resizeProblem() || !withStatus('waiting').length) return;
  const run = ++state.run;
  const settings = options();
  state.running = true;
  state.startedAt = performance.now();
  state.pdf = null;
  const fromButton = document.activeElement === els.convert;
  render();
  if (fromButton) els.cancel.focus();
  for (const item of withStatus('waiting')) {
    item.status = 'working';
    render();
    const reply = await ask(item, settings);
    if (run !== state.run) return;
    if (reply.error) {
      item.status = 'error';
      item.error = reply.error;
    } else {
      item.status = 'done';
      const { thumb, ...result } = reply;
      item.result = result;
      showThumb(item, thumb);
    }
    render();
  }
  state.running = false;
  const handOver = document.activeElement === els.cancel || document.activeElement === document.body;
  render();
  refreshPdf();
  // Le bouton qui avait le clavier vient de disparaître : l'action suivante le reprend.
  if (handOver && !els.downloadAll.disabled) els.downloadAll.focus();
}

function cancel() {
  if (performance.now() - state.startedAt < CANCEL_GRACE_MS) return;
  state.run++;
  worker?.terminate();
  worker = null;
  answer = null;
  for (const item of withStatus('working')) item.status = 'waiting';
  state.running = false;
  render();
  refreshPdf();
  els.convert.focus();
}

// Le PDF s'assemble sans recoder les images : refait à chaque changement de la liste, il reste immédiat.
function refreshPdf() {
  if (!isPdf() || state.running || withStatus('waiting').length) return;
  const pages = withStatus('done').map(({ result: { width, height, kind, blob } }) => ({ width, height, kind, data: blob }));
  state.pdf = pages.length ? buildPdf(pages) : null;
  render();
}

// --- Les téléchargements ---

// Chrome refuse certains noms : caractères réservés, espaces spéciaux (ceux des captures d'écran de macOS), points en tête ou en fin,
// noms hérités de Windows. La coupe se fait entre deux caractères entiers : couper un émoji en deux rend le nom invalide.
function cleanBase(name) {
  const base = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
  const safe = base
    .normalize('NFC')
    .replace(/\p{Zs}/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/[\\/:*?"<>|~]/g, '-');
  const clean = Array.from(safe).slice(0, 120).join('').replace(/^[.\s]+|[.\s]+$/g, '');
  if (!clean) return 'image';
  return RESERVED_NAMES.test(clean) ? `image-${clean}` : clean;
}

const outputName = (item) => `${FOLDER}/${cleanBase(item.file.name)}.${OUTPUTS[state.format].ext}`;

function pdfName() {
  const now = new Date();
  const two = (value) => String(value).padStart(2, '0');
  return `${FOLDER}/images_${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}_${two(now.getHours())}h${two(now.getMinutes())}-${two(now.getSeconds())}.pdf`;
}

const problemText = (code) => SAVE_PROBLEMS[code] ?? REFUSED;

// Attend que le fichier soit vraiment arrivé. Rend le problème rencontré, ou null. Il est peut-être déjà arrivé au moment de la question.
function downloadEnd(id) {
  return new Promise((resolve) => {
    const finish = (problem) => {
      chrome.downloads.onChanged.removeListener(listener);
      resolve(problem);
    };
    const listener = (delta) => {
      if (delta.id !== id || !delta.state || delta.state.current === 'in_progress') return;
      finish(delta.state.current === 'complete' ? null : problemText(delta.error?.current));
    };
    chrome.downloads.onChanged.addListener(listener);
    chrome.downloads.search({ id }).then(([found]) => {
      if (!found || found.state === 'complete') finish(null);
      else if (found.state === 'interrupted') finish(problemText(found.error));
    });
  });
}

async function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
    return { id, problem: await downloadEnd(id) };
  } catch (err) {
    console.warn('Téléchargement refusé :', filename, err);
    return { problem: REFUSED };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

function failureText(failed) {
  const shown = failed.slice(0, 3).map(({ name }) => `« ${name} »`);
  const rest = failed.length - shown.length;
  const names = rest ? `${shown.join(', ')} et ${rest} ${plural(rest, 'autre', 'autres')}` : shown.join(' et ');
  const verb = failed.length > 1 ? 'n’ont pas pu être enregistrées' : 'n’a pas pu être enregistrée';
  return `${names} ${verb} (${failed[0].problem}).`;
}

// Chaque fichier a sa chance : un refus n'arrête pas les suivants, et le bilan dit lesquels manquent.
async function saveAll(entries, success) {
  if (state.saving) return;
  state.saving = true;
  render();
  const failed = [];
  let lastId;
  for (const { blob, filename, item } of entries) {
    const { id, problem } = await saveBlob(blob, filename);
    if (item) item.saveProblem = problem;
    if (problem) failed.push({ name: filename.split('/').pop(), problem });
    else lastId = id;
  }
  state.saving = false;
  render();
  const action = lastId === undefined ? undefined : { label: 'Afficher dans le Finder', run: () => chrome.downloads.show(lastId) };
  if (!failed.length) toast(success, { success: true, action });
  else {
    const saved = entries.length - failed.length;
    const part = saved ? `${saved > 1 ? `${saved} images enregistrées` : '1 image enregistrée'}. ` : '';
    toast(`${part}${failureText(failed)}`, { action, lasting: true });
  }
}

function downloadOne(item) {
  saveAll([{ blob: item.result.blob, filename: outputName(item), item }], `Image enregistrée dans ${WHERE}.`);
}

function downloadAll(event) {
  if (event.detail > 1) return;
  if (isPdf()) {
    saveAll([{ blob: state.pdf, filename: pdfName() }], `PDF enregistré dans ${WHERE}.`);
    return;
  }
  const done = withStatus('done');
  saveAll(
    done.map((item) => ({ blob: item.result.blob, filename: outputName(item), item })),
    done.length > 1 ? `${images(done.length)} enregistrées dans ${WHERE}.` : `Image enregistrée dans ${WHERE}.`,
  );
}

// --- Le message en bas de page ---

// `lasting` : un échec reste à l'écran jusqu'au message suivant.
function toast(message, { success = false, action, lasting = false } = {}) {
  const nodes = [];
  if (success) {
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.innerHTML = CHECK;
    nodes.push(icon);
  }
  const text = document.createElement('span');
  text.textContent = message;
  nodes.push(text);
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-action';
    button.textContent = action.label;
    button.addEventListener('click', action.run);
    nodes.push(button);
  }
  els.toast.replaceChildren(...nodes);
  els.toast.hidden = true;
  void els.toast.offsetWidth;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  if (!lasting) toastTimer = setTimeout(() => (els.toast.hidden = true), 7000);
}

// --- Mise en route ---

els.files.addEventListener('change', () => {
  addFiles(els.files.files);
  els.files.value = '';
});
// Un fichier lâché à côté de la zone ne doit pas remplacer la page : toute la fenêtre accepte le dépôt.
window.addEventListener('dragover', (event) => {
  event.preventDefault();
  els.drop.classList.add('over');
});
window.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget) els.drop.classList.remove('over');
});
window.addEventListener('drop', (event) => {
  event.preventDefault();
  els.drop.classList.remove('over');
  addFiles(event.dataTransfer.files);
});
els.convert.addEventListener('click', start);
els.cancel.addEventListener('click', cancel);
els.downloadAll.addEventListener('click', downloadAll);
els.clear.addEventListener('click', () => {
  state.items.forEach(releasePreview);
  state.items = [];
  listChanged();
  els.files.focus();
});
els.resizeValue.addEventListener('input', settingsChanged);

const stored = await chrome.storage.sync.get({ convertFormat: 'jpg', convertQuality: 'high' });
state.format = OUTPUTS[stored.convertFormat] ? stored.convertFormat : 'jpg';
state.quality = QUALITIES[stored.convertQuality] ? stored.convertQuality : 'high';
buildSegmented(els.format, OUTPUTS, pickFormat);
buildSegmented(els.quality, QUALITIES, pickQuality);
buildSegmented(els.resize, RESIZES, pickResize);
render();
