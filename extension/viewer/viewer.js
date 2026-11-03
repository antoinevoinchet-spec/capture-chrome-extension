import { openEditor } from '../annotate/editor.js';
import { avoidRanges, drawAnnotations } from '../annotate/render.js';
import { CaptureGone, deleteCapture, getCapture, getEdits, listCaptures, listEditKinds, saveEdits } from '../lib/db.js';
import { downloadEnd } from '../lib/download-end.js';
import { FORMATS, SPLITS, loadSettings, saveSettings } from '../lib/settings.js';
import { exportPdf, exportZip } from './export.js';
import { Stitcher } from './stitcher.js';
import { ZipTooBig } from './zip.js';

// Largeur d'affichage maximale d'un aperçu, en points.
const PREVIEW_WIDTH = 820;
// Sous-dossier de Téléchargements où arrivent les images.
const DOWNLOAD_FOLDER = 'Captures';
// Taille d'une vignette de l'historique, en points (voir .history-thumb dans viewer.css).
const THUMB = { width: 40, height: 52 };

// Avec un cadrage, ce qui n'est pas écrit n'est pas seulement une annotation.
const changesOf = ({ trim }) => (trim ? 'modifications' : 'annotations');
const SAVE_FAILED = (edits) => `L’enregistrement a échoué : tes dernières ${changesOf(edits)} ne sont pas sauvegardées. Elles le seront à la prochaine modification.`;
const SAVE_GONE = (edits) => `Cette capture a été supprimée dans un autre onglet : tes ${changesOf(edits)} ne sont plus enregistrées. Copie ou télécharge l’image maintenant.`;
const TRIM_MOVED = 'le cadrage a changé dans un autre onglet';
const EDITOR_TAKEN = 'Cette capture est déjà en cours d’annotation dans un autre onglet. Ferme son éditeur, puis réessaie.';

const CHECK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

const CROSS =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

const SCISSORS =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88"/><path d="M14.47 14.48 20 20"/><path d="M8.12 8.12 12 12"/></svg>';

const els = {
  title: document.getElementById('title'),
  meta: document.getElementById('meta'),
  saveAlert: document.getElementById('save-alert'),
  editorAlert: document.getElementById('editor-alert'),
  copyCurrent: document.getElementById('copy-current'),
  downloadAll: document.getElementById('download-all'),
  export: document.getElementById('export'),
  exportMenu: document.getElementById('export-menu'),
  exportCancel: document.getElementById('export-cancel'),
  exportProgress: document.getElementById('export-progress'),
  split: document.getElementById('split'),
  splitHint: document.getElementById('split-hint'),
  format: document.getElementById('format'),
  formatHint: document.getElementById('format-hint'),
  history: document.getElementById('history'),
  notice: document.getElementById('notice'),
  mat: document.getElementById('mat'),
  parts: document.getElementById('parts'),
  menu: document.getElementById('image-menu'),
  toast: document.getElementById('toast'),
};

const numbers = new Intl.NumberFormat('fr-FR');
const dates = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const px = (n) => numbers.format(Math.round(n));

let settings;
let record = null;
let stitcher = null;
// Annotations et cadrage de la capture ouverte, rangés dans un objet propre à chaque capture : le rendu d'une capture quittée
// (copie ou export encore en file) lit le sien, jamais celui de la capture qui vient de s'ouvrir.
let annotationState = { items: [], trim: null };
// Ce que porte chaque capture retouchée : l'historique le dit, et elle échappe au nettoyage automatique.
let editKinds = new Map();
let parts = [];
let layoutToken = 0;
let busy = false;
let copying = false;
// Les images sont en train d'être recalculées : `parts` et les boutons « Annoter » affichés ne se correspondent plus encore.
let planning = false;
// L'éditeur est ouvert, et les annotations ont changé depuis son ouverture (coupes et aperçus à refaire à la fermeture).
let editing = false;
let edited = false;
// « Annoter » vient d'être cliqué, le verrou de l'éditeur est demandé.
let locking = false;
// Verrou de l'éditeur détenu par cette page : { captureId, free }. Voir annotate et releaseEditorLock.
let editorLock = null;
// Écritures des annotations, l'une après l'autre, et leur nombre en attente (en file ou en cours).
let saveQueue = Promise.resolve();
let pendingSaves = 0;
// Dernière écriture qui a échoué (capture, liste complète et cadrage), tant qu'aucune écriture de cette capture n'a réussi depuis.
let failedSave = null;
// Nombre de changements de capture en cours (ouverture d'une autre, suppression) : tant qu'il y en a, « Annoter » est refusé.
let leaving = 0;
// Un export est en cours : son AbortController, et le dernier message d'un autre onglet, appliqué seulement à la fin (l'export reste figé).
let exportControl = null;
let followLater = null;
// Pendant cet export, le cadrage a changé ailleurs : son fichier garderait ce qui vient d'être retiré.
let exportStale = false;
// Vignettes de l'historique, dessinées l'une après l'autre.
let thumbQueue = Promise.resolve();
// Prévient les autres pages de résultats ouvertes quand des annotations sont enregistrées.
const annotationsChannel = new BroadcastChannel('capture-annotations');
let toastTimer;
// Image visée par le menu du clic droit.
let menuIndex = 0;
// Image affichée à l'écran, celle que copie le bouton de l'en-tête.
let currentIndex = 0;
let currentFrame = 0;

init().catch((err) => showEmpty('Impossible d’ouvrir la capture', err.message));

async function init() {
  settings = await loadSettings();
  buildSegmented(els.split, SPLITS, settings.split, (key) => {
    settings.split = key;
    saveSettings({ split: key });
    layoutParts().catch((err) => toast(`Découpage impossible : ${err.message}`));
  });
  buildSegmented(els.format, FORMATS, settings.format, (key) => {
    settings.format = key;
    saveSettings({ format: key });
    updateFormatHint();
  });
  updateFormatHint();
  els.downloadAll.addEventListener('click', () => downloadParts(parts.map((_, i) => i), els.downloadAll));
  els.copyCurrent.addEventListener('click', () => copyPart(currentIndex, els.copyCurrent));
  setupExport();
  for (const target of [els.mat, window]) target.addEventListener('scroll', scheduleCurrent, { passive: true });
  window.addEventListener('resize', scheduleCurrent);
  setupCopyGestures();
  annotationsChannel.onmessage = ({ data }) => followOtherPage(data).catch((err) => console.error(err));
  // Quitter la page tant que des annotations s'écrivent, ou après une écriture ratée, les perdrait : Chrome demande confirmation,
  // et l'écriture ratée est retentée pendant que la question est posée.
  window.addEventListener('beforeunload', (event) => {
    if (failedSave && !pendingSaves) queueSave(failedSave.captureId, failedSave.edits);
    if (pendingSaves || failedSave) event.preventDefault();
  });

  const captures = await listCaptures();
  editKinds = await listEditKinds();
  const id = new URLSearchParams(location.search).get('id') ?? captures[0]?.id;
  renderHistory(captures);
  if (!id) {
    showNoCapture();
    return;
  }
  await openCapture(id);
}

async function openCapture(id) {
  // Du clic à l'affichage de la nouvelle capture, « Annoter » est refusé : un éditeur ouvert dans l'intervalle écrirait dans la nouvelle capture.
  leaving++;
  setAnnotateEnabled();
  let layout;
  try {
    // Les annotations de la capture quittée finissent d'abord de s'écrire : relues trop tôt, elles reviendraient incomplètes.
    await saveQueue;
    if (!(await confirmLeaving())) return;
    const next = await getCapture(id);
    if (!next) {
      showEmpty('Capture introuvable', 'Elle a été supprimée, ou retirée de l’historique, qui garde les 15 dernières captures non annotées.');
      return;
    }
    const state = await getEdits(id);
    // Filet : « Annoter » étant refusé depuis le début, l'éditeur ne devrait pas être ouvert ; on ne change pas sa capture sous lui.
    if (editing) return;
    stitcher?.dispose();
    record = next;
    annotationState = state;
    // Un bandeau resté de la capture quittée ne la concerne plus (une écriture en échec a été réglée par confirmLeaving).
    showSaveAlert();
    const { scale } = next;
    // Lit `state` à chaque rendu, donc toujours à jour pour les exports et les aperçus de cette capture (copies faites depuis l'éditeur).
    stitcher = new Stitcher(record, {
      trim: state.trim,
      overlay: (ctx, top, height, ratio, left) => drawAnnotations(ctx, state.items, scale, top, height, ratio, left),
    });
    history.replaceState(null, '', `?id=${id}`);

    const host = hostOf(record.url);
    document.title = `${record.title || host || 'Capture'} | Capture`;
    els.title.textContent = record.title || host || 'Capture sans titre';
    els.meta.replaceChildren(
      text(host || 'Page locale'),
      text(dates.format(record.createdAt)),
      text(''),
    );
    els.notice.hidden = !record.truncated;
    markHistory(id);
    // Le calcul des coupes démarre ici même et reprend le refus de « Annoter » (planning) avant que `leaving` ne le rende.
    layout = layoutParts();
  } finally {
    leaving--;
    setAnnotateEnabled();
  }
  await layout;
}

// Avant de quitter une capture dont la dernière écriture a échoué : on la retente une fois ; si elle échoue encore, la personne choisit.
async function confirmLeaving() {
  if (!failedSave) return true;
  const { captureId, edits } = failedSave;
  try {
    await saveEdits(captureId, edits);
    markEdited(captureId, edits);
    // Un autre onglet ouvert sur cette capture montre encore ce que cette écriture remplace.
    annotationsChannel.postMessage({ captureId, items: edits.items, trim: edits.trim });
  } catch (err) {
    console.error(err);
    // Supprimée entre-temps : plus rien à retenter, ni à demander.
    if (!(err instanceof CaptureGone) && !confirm(`L’enregistrement a encore échoué : les dernières ${changesOf(edits)} de cette capture seront perdues si tu la quittes. Quitter quand même ?`)) return false;
  }
  forgetFailedSave();
  return true;
}

function forgetFailedSave() {
  failedSave = null;
  showSaveAlert();
  releaseEditorLock();
}

// Remplace les annotations et le cadrage de la capture ouverte.
function setEdits({ items, trim }) {
  annotationState.items = items;
  annotationState.trim = trim;
  stitcher.setTrim(trim);
}

// Les coupes de la capture ouverte, d'après son découpage, son cadrage et ses annotations.
function planCurrent() {
  const split = SPLITS[settings.split];
  const maxHeight = split.points ? split.points * record.scale : record.crop.h;
  return stitcher.planParts(maxHeight, avoidRanges(annotationState.items, record.scale));
}

// Ouvre l'éditeur sur l'image `index`. Un seul éditeur à la fois par capture, tous onglets confondus : deux éditeurs s'écraseraient
// l'un l'autre sans prévenir, et un masque pourrait disparaître. Chrome libère de lui-même le verrou d'un onglet qui se ferme.
function annotate(index) {
  if (!parts[index] || editing || locking || planning || leaving || exportControl) return;
  if (busy) {
    toast('Un téléchargement est en cours : attends la fin, puis annote l’image.');
    return;
  }
  const captureId = record.id;
  const top = parts[index].top;
  // Verrou encore détenu (écriture ratée ou en cours) : cette page garde la main sans le redemander.
  if (editorLock?.captureId === captureId) {
    editUnderLock(captureId, top).catch(editorFailed);
    return;
  }
  locking = true;
  navigator.locks
    .request(`capture-editor-${captureId}`, { ifAvailable: true }, (lock) => {
      locking = false;
      if (!lock) {
        toast(EDITOR_TAKEN);
        return null;
      }
      const held = new Promise((free) => {
        editorLock = { captureId, free };
      });
      editUnderLock(captureId, top).catch(editorFailed);
      return held;
    })
    .catch(editorFailed);
}

function editorFailed(err) {
  locking = false;
  editing = false;
  releaseEditorLock();
  toast(`Éditeur indisponible : ${err.message}`);
}

// Le verrou tombe quand plus rien n'est à protéger : éditeur fermé, écritures finies, et aucune écriture ratée à rattraper. Sinon un autre
// onglet partirait d'une liste incomplète, et cette page écraserait ensuite son travail en rattrapant le sien.
function releaseEditorLock() {
  if (!editorLock || editing || pendingSaves || failedSave?.captureId === editorLock.captureId) return;
  editorLock.free();
  editorLock = null;
}

// Le verrou est obtenu. Chaque modification validée est enregistrée au fil de l'eau.
async function editUnderLock(captureId, top) {
  // Pendant la demande du verrou, une autre capture a pu s'ouvrir, ou les coupes se recalculer.
  if (record?.id !== captureId || planning || leaving) {
    releaseEditorLock();
    return;
  }
  editing = true;
  edited = false;
  await adoptStoredEdits(captureId);
  if (planning || leaving) {
    editing = false;
    releaseEditorLock();
    return;
  }
  openEditor({
    record,
    stitcher,
    parts,
    items: annotationState.items,
    trim: annotationState.trim,
    startTop: top,
    onChange: (edits) => {
      const framed = JSON.stringify(edits.trim) === JSON.stringify(annotationState.trim);
      edited = true;
      setEdits(edits);
      queueSave(captureId, edits);
      // Les aperçus, derrière l'éditeur, montrent l'ancien cadre : ils partent, et sont refaits à la fermeture.
      if (!framed) els.parts.replaceChildren();
    },
    onCopy: (partIndex) => copyPart(partIndex, null),
    onClose: () => closeAnnotate(captureId, top),
    onRefuse: (message) => toast(message),
    // Après un changement de cadrage : `parts` suit, pour que la copie faite depuis l'éditeur découpe bien ce qui est affiché.
    replan: async () => {
      try {
        parts = await planCurrent();
      } catch (err) {
        console.error(err);
        toast(`Les coupes n’ont pas pu être recalculées : ${err.message}`);
      }
      return parts;
    },
  });
}

// L'éditeur part de l'état enregistré : le message d'un autre onglet peut être en retard, ou perdu si cet onglet était en pause.
// Une écriture ratée ici garde la main (l'état enregistré est plus ancien). Une base vide ne remplace rien : la capture a pu être
// supprimée ailleurs, et ses images affichées, encore copiables, perdraient leurs masques.
async function adoptStoredEdits(captureId) {
  await saveQueue;
  if (failedSave?.captureId === captureId) return;
  const stored = await getEdits(captureId);
  if (!stored.items.length && !stored.trim) return;
  const sameItems = JSON.stringify(stored.items) === JSON.stringify(annotationState.items);
  const sameTrim = JSON.stringify(stored.trim) === JSON.stringify(annotationState.trim);
  if (sameItems && sameTrim) return;
  setEdits(stored);
  edited = true;
  // L'éditeur reçoit les coupes du cadrage qu'il va montrer.
  if (!sameTrim) parts = await planCurrent();
}

// L'éditeur est fermé. Si les annotations ont changé : nouvelles coupes (elles évitent les annotations) et aperçus à jour.
// Le focus revient au bouton « Annoter » de l'image d'où l'on est parti.
async function closeAnnotate(captureId, top) {
  editing = false;
  releaseEditorLock();
  const waited = edited;
  // La vignette de l'historique montre les annotations telles qu'on les laisse.
  const thumb = historyItem(captureId)?.querySelector('.history-thumb');
  if (waited && thumb) queueThumb(thumb, record, { items: annotationState.items, trim: annotationState.trim });
  if (waited) await layoutParts().catch((err) => toast(`Mise à jour impossible : ${err.message}`));
  // Une autre capture a pu s'ouvrir pendant le recalcul : le focus appartient alors à ce que la personne vient de choisir.
  if (record?.id !== captureId) return;
  // Un cadrage a pu retirer le point de départ : la première image prend le focus.
  const index = Math.max(0, parts.findLastIndex((part) => part.top <= top));
  // Après un recalcul (parfois long), le focus revient sans faire défiler la page là où l'on a pu aller entre-temps.
  els.parts.querySelectorAll('figure.part')[index]?.querySelector('.annotate')?.focus({ preventScroll: waited });
}

// Une écriture à la fois, dans l'ordre. Une écriture qui échoue n'empêche pas la suivante, qui réécrit tout.
function queueSave(captureId, edits) {
  pendingSaves++;
  saveQueue = saveQueue.then(async () => {
    try {
      await saveEdits(captureId, edits);
      // Le bandeau ne part que pour une écriture réussie de la capture dont l'écriture avait échoué.
      if (failedSave?.captureId === captureId) forgetFailedSave();
      markEdited(captureId, edits);
      annotationsChannel.postMessage({ captureId, items: edits.items, trim: edits.trim });
    } catch (err) {
      console.error(err);
      if (err instanceof CaptureGone) {
        // Plus rien à retenter : on le dit, et les images affichées restent copiables.
        failedSave = null;
        showSaveAlert(SAVE_GONE(edits));
      } else {
        failedSave = { captureId, edits };
        showSaveAlert(SAVE_FAILED(edits));
      }
    } finally {
      pendingSaves--;
      releaseEditorLock();
    }
  });
}

// Bandeau d'alerte dans l'en-tête de la page de résultats et dans celui de l'éditeur ; sans message, il disparaît.
function showSaveAlert(message = '') {
  for (const alert of [els.saveAlert, els.editorAlert]) {
    alert.textContent = message;
    alert.hidden = !message;
  }
}

// Une autre page de résultats a enregistré des annotations. La vignette de cette capture les montre ; si la capture est affichée ici,
// ses aperçus et ses exports aussi, sinon ils laisseraient voir ce qu'on vient de masquer. Un éditeur ouvert ici est déjà parti de
// cette liste : il détient le verrou, aucun autre onglet n'écrit plus (voir annotate).
async function followOtherPage({ captureId, items, trim = null }) {
  if (exportControl && record?.id === captureId) {
    followLater = { captureId, items, trim };
    // L'export reste figé pour les annotations. Pour un cadrage, il s'arrête : son fichier contiendrait ce qui vient d'être retiré.
    if (JSON.stringify(trim) !== JSON.stringify(annotationState.trim)) {
      exportStale = true;
      exportControl.abort();
    }
    return;
  }
  const edits = { items, trim };
  markEdited(captureId, edits);
  const thumb = historyItem(captureId)?.querySelector('.history-thumb');
  const capture = thumb && (await getCapture(captureId));
  if (capture) queueThumb(thumb, capture, edits);
  if (record?.id === captureId && !editing) {
    setEdits(edits);
    await layoutParts();
  }
}

async function layoutParts() {
  if (!record) return;
  const token = ++layoutToken;
  document.body.dataset.ready = 'false';
  els.parts.setAttribute('aria-busy', 'true');
  els.downloadAll.disabled = true;
  els.export.disabled = true;
  els.copyCurrent.disabled = true;

  // Tant que les coupes se recalculent, « Annoter » est refusé : l'éditeur recevrait des coupes qui vont changer.
  planning = true;
  setAnnotateEnabled();
  let planned;
  try {
    planned = await planCurrent();
  } finally {
    // Un calcul remplacé par un plus récent laisse la main à celui-ci ; un calcul en échec la rend, pour ne pas bloquer « Annoter ».
    if (token === layoutToken) {
      planning = false;
      setAnnotateEnabled();
    }
  }
  if (token !== layoutToken) return;
  parts = planned;

  const output = stitcher.outputSize();
  els.meta.lastElementChild.textContent = `${px(output.width)} × ${px(output.height)} px au total`;
  const tallest = Math.max(...parts.map((p) => p.height));
  els.splitHint.textContent =
    parts.length > 1
      ? `${parts.length} images, ${px(tallest)} px de haut au plus.`
      : `Une seule image de ${px(output.height)} px de haut.`;
  els.downloadAll.textContent = parts.length > 1 ? `Tout télécharger (${parts.length} images)` : 'Télécharger l’image';
  els.downloadAll.disabled = false;
  els.export.disabled = false;

  const canvasWidth = Math.min(output.width, Math.round(PREVIEW_WIDTH * devicePixelRatio));
  const canvases = [];
  const nodes = [];
  parts.forEach((part, index) => {
    if (index > 0) nodes.push(cutLine(index));
    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = Math.max(1, Math.round((part.height * canvasWidth) / output.width));
    canvases.push(canvas);
    nodes.push(partCard(index, canvas));
  });
  els.parts.replaceChildren(...nodes);
  // Les boutons neufs naissent actifs : si une autre capture est en train de s'ouvrir, ils sont aussitôt refusés.
  setAnnotateEnabled();
  els.copyCurrent.disabled = false;
  updateCurrent();

  // `planned`, pas `parts` : l'éditeur, ouvert pendant ce dessin, peut remplacer `parts` en changeant le cadrage.
  for (let i = 0; i < planned.length; i++) {
    await stitcher.renderPreview(planned[i], canvases[i]);
    if (token !== layoutToken) return;
  }
  els.parts.removeAttribute('aria-busy');
  document.body.dataset.ready = 'true';
}

// Grise ou rend les boutons « Annoter » des images et l'entrée du menu du clic droit : refusés pendant un recalcul des coupes
// ou un changement de capture.
function setAnnotateEnabled() {
  const enabled = !planning && !leaving && !exportControl;
  for (const el of [...els.parts.querySelectorAll('.annotate'), els.menu.querySelector('[data-action="annotate"]')]) el.disabled = !enabled;
}

function partCard(index, canvas) {
  const figure = document.createElement('figure');
  figure.className = 'part';
  const { width } = stitcher.outputSize();
  figure.style.maxWidth = `${Math.min(PREVIEW_WIDTH, Math.round(width / record.scale))}px`;

  const caption = document.createElement('figcaption');
  const name = text(parts.length > 1 ? `Image ${index + 1} sur ${parts.length}` : 'Image unique', 'part-name');
  const size = text(`${px(width)} × ${px(parts[index].height)} px`, 'part-size');
  const actions = document.createElement('span');
  actions.className = 'part-actions';
  const copy = button('Copier', 'ghost', () => copyPart(index, copy));
  const save = button('Télécharger', 'ghost part-save', () => downloadParts([index], save));
  const note = button('Annoter', 'ghost annotate', () => annotate(index));
  actions.append(copy, save, note);
  caption.append(name, size, actions);

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.addEventListener('contextmenu', (event) => openMenu(event, index));
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `Aperçu de l’image ${index + 1}`);
  sheet.append(canvas);

  figure.append(caption, sheet);
  return figure;
}

function cutLine(index) {
  const line = document.createElement('div');
  line.className = 'cut';
  line.setAttribute('role', 'separator');
  line.setAttribute('aria-label', `Coupe entre l’image ${index} et l’image ${index + 1}`);
  line.innerHTML = SCISSORS;
  return line;
}

async function downloadParts(indices, trigger) {
  if (busy || !indices.length) return;
  busy = true;
  const format = FORMATS[settings.format];
  const label = trigger?.textContent;
  if (trigger) trigger.disabled = true;
  // Copies locales : les coupes peuvent changer en cours de route, sur un message d'un autre onglet. Avec un autre cadrage, la série s'arrête :
  // ses images ne se raccorderaient plus.
  const painter = stitcher;
  const state = annotationState;
  const startTrim = JSON.stringify(state.trim);
  const chosen = indices.map((index) => ({ part: parts[index], name: fileName(index, format.ext) }));
  let lastId;
  try {
    for (const [n, { part, name }] of chosen.entries()) {
      if (JSON.stringify(state.trim) !== startTrim) throw new Error(`${TRIM_MOVED}. Relance le téléchargement.`);
      if (trigger) trigger.textContent = indices.length > 1 ? `Préparation ${n + 1} sur ${indices.length}…` : 'Préparation…';
      const blob = await painter.renderPart(part, format.type);
      lastId = await saveBlob(blob, name);
    }
    const where = parts.length > 1 ? `Téléchargements › ${DOWNLOAD_FOLDER} › ${baseName()}` : `Téléchargements › ${DOWNLOAD_FOLDER}`;
    toast(indices.length > 1 ? `${indices.length} images enregistrées dans ${where}.` : `Image enregistrée dans ${where}.`, {
      success: true,
      action: { label: 'Afficher dans le Finder', run: () => chrome.downloads.show(lastId) },
    });
  } catch (err) {
    toast(`Téléchargement impossible : ${err.message}`);
  } finally {
    if (trigger) {
      trigger.textContent = label;
      trigger.disabled = false;
    }
    busy = false;
  }
}

function setupExport() {
  els.export.addEventListener('click', () => (els.exportMenu.hidden ? openExportMenu() : closeExportMenu()));
  els.exportCancel.addEventListener('click', () => exportControl?.abort());
  els.exportMenu.addEventListener('click', (event) => {
    const kind = event.target.closest('[data-export]')?.dataset.export;
    if (kind) startExport(kind);
  });
  els.exportMenu.addEventListener('keydown', (event) => {
    const items = [...els.exportMenu.querySelectorAll('button')];
    const at = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    } else if (event.key === 'Escape') {
      closeExportMenu();
      els.export.focus();
    } else if (event.key === 'Tab') {
      closeExportMenu();
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (!els.exportMenu.hidden && !els.exportMenu.contains(event.target) && !els.export.contains(event.target)) closeExportMenu();
  });
  window.addEventListener('blur', closeExportMenu);
}

function openExportMenu() {
  els.exportMenu.hidden = false;
  els.export.setAttribute('aria-expanded', 'true');
  els.exportMenu.querySelector('button').focus();
}

function closeExportMenu() {
  els.exportMenu.hidden = true;
  els.export.setAttribute('aria-expanded', 'false');
}

// Pendant un export, la capture, ses coupes et ses annotations ne bougent plus : tout ce qui les changerait est grisé.
function setExporting(control) {
  exportControl = control;
  busy = Boolean(control);
  const on = Boolean(control);
  for (const el of els.split.querySelectorAll('button')) el.disabled = on;
  for (const el of els.history.querySelectorAll('button')) el.disabled = on;
  for (const el of [...els.parts.querySelectorAll('.part-save'), els.menu.querySelector('[data-action="download"]')]) el.disabled = on;
  els.downloadAll.disabled = on;
  els.export.hidden = on;
  els.exportCancel.hidden = !on;
  els.exportCancel.disabled = false;
  els.exportProgress.hidden = !on;
  els.exportProgress.textContent = '';
  setAnnotateEnabled();
}

async function startExport(kind) {
  closeExportMenu();
  if (exportControl) return;
  if (busy) {
    toast('Un téléchargement est en cours : attends la fin, puis relance l’export.');
    return;
  }
  if (!parts.length || planning || leaving || editing || locking) return;
  // Copies locales : quoi qu'il arrive ensuite à la page, le fichier décrit ce qui était affiché au départ.
  const frozen = { stitcher, parts: [...parts], format: FORMATS[settings.format], base: baseName() };
  const names = frozen.parts.map((_, index) => fileName(index, frozen.format.ext).split('/').pop());
  const label = kind === 'pdf' ? 'PDF' : 'Zip';
  const control = new AbortController();
  let reached = 0;
  const onProgress = (done, total) => {
    reached = done;
    els.exportProgress.textContent = `Partie ${done} sur ${total}`;
  };
  // Un refus d'un export précédent, resté à l'écran, ne concerne plus celui-ci.
  els.toast.hidden = true;
  setExporting(control);
  els.exportCancel.focus();
  try {
    const blob =
      kind === 'pdf'
        ? await exportPdf({ stitcher: frozen.stitcher, parts: frozen.parts, signal: control.signal, onProgress })
        : await exportZip({ stitcher: frozen.stitcher, parts: frozen.parts, format: frozen.format.type, names, signal: control.signal, onProgress });
    if (control.signal.aborted) throw control.signal.reason;
    // Le fichier s'écrit encore : plus rien à annuler ici, et le succès ne se dit qu'une fois écrit.
    els.exportCancel.disabled = true;
    els.exportProgress.textContent = 'Enregistrement du fichier…';
    const id = await saveBlob(blob, `${DOWNLOAD_FOLDER}/${frozen.base}/${frozen.base}.${kind}`);
    const problem = await downloadEnd(id);
    if (problem) {
      toast(`${label} non enregistré : ${problem}`, { lasting: true });
      return;
    }
    // Trop tard pour l'arrêter : le fichier s'écrivait déjà.
    if (exportStale) {
      toast(`${label} enregistré avec l’ancien cadrage : ${TRIM_MOVED} pendant l’écriture. Relance l’export.`, { lasting: true });
      return;
    }
    toast(`${label} enregistré dans Téléchargements › ${DOWNLOAD_FOLDER} › ${frozen.base}.`, {
      success: true,
      action: { label: 'Afficher dans le Finder', run: () => chrome.downloads.show(id) },
    });
  } catch (err) {
    if (exportStale) {
      toast(`Export arrêté : ${TRIM_MOVED}. Aucun fichier créé, relance l’export.`, { lasting: true });
    } else if (control.signal.aborted) {
      toast('Export annulé : aucun fichier créé.');
    } else if (err instanceof ZipTooBig) {
      toast('Ce zip dépasserait la limite de 4 Go ou 65 535 images : aucun fichier créé. Choisis le format JPG, ou exporte en PDF.', { lasting: true });
    } else {
      console.error(err);
      toast(`L’export s’est arrêté à la partie ${reached} : aucun fichier créé. Réessaie, ou choisis un découpage plus court.`, { lasting: true });
    }
  } finally {
    const hadFocus = document.activeElement === els.exportCancel || document.activeElement === document.body;
    exportStale = false;
    setExporting(null);
    if (hadFocus) els.export.focus();
    if (followLater) {
      const data = followLater;
      followLater = null;
      followOtherPage(data).catch((err) => console.error(err));
    }
  }
}

// Toutes les façons de copier (boutons, clic droit, ⌘C) passent par ici : pleine résolution et notification.
async function copyPart(index, trigger) {
  if (copying || !parts[index]) return;
  // Un changement venu d'un autre onglet attend la fin de l'export : l'image affichée n'est plus la bonne.
  if (followLater) {
    toast('Cette capture a changé dans un autre onglet : attends la fin de l’export, puis copie l’image.');
    return;
  }
  copying = true;
  const label = trigger?.textContent;
  if (trigger) {
    trigger.disabled = true;
    trigger.textContent = 'Copie…';
  }
  try {
    // Le presse-papiers n'accepte que le PNG ; la promesse garde le clic valide pendant le rendu.
    const png = stitcher.renderPart(parts[index], 'image/png');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    const name = parts.length > 1 ? `Image ${index + 1} copiée` : 'Image copiée';
    toast(`${name} dans le presse-papiers. Colle-la avec ⌘V.`, { success: true });
  } catch (err) {
    toast(`Copie impossible : ${err.message}`);
  } finally {
    if (trigger) {
      trigger.textContent = label;
      trigger.disabled = false;
    }
    copying = false;
    updateCurrent();
  }
}

function setupCopyGestures() {
  // ⌘C sans texte sélectionné : copie l'image affichée (ou celle du menu ouvert).
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
    const copyKey = (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'c';
    if (!copyKey || !parts.length || editing) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    event.preventDefault();
    const index = els.menu.hidden ? currentIndex : menuIndex;
    closeMenu();
    copyPart(index, index === currentIndex ? els.copyCurrent : null);
  });

  els.menu.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    closeMenu();
    if (action === 'copy') copyPart(menuIndex, null);
    if (action === 'download') downloadParts([menuIndex], null);
    if (action === 'annotate') annotate(menuIndex);
  });
  document.addEventListener('pointerdown', (event) => {
    if (!els.menu.hidden && !els.menu.contains(event.target)) closeMenu();
  });
  for (const type of ['wheel', 'blur', 'resize']) window.addEventListener(type, closeMenu, { passive: true });
}

function openMenu(event, index) {
  event.preventDefault();
  menuIndex = index;
  els.menu.hidden = false;
  const { width, height } = els.menu.getBoundingClientRect();
  els.menu.style.left = `${Math.min(event.clientX, window.innerWidth - width - 8)}px`;
  els.menu.style.top = `${Math.min(event.clientY, window.innerHeight - height - 8)}px`;
  els.menu.querySelector('button').focus();
}

function closeMenu() {
  els.menu.hidden = true;
}

function scheduleCurrent() {
  if (currentFrame) return;
  currentFrame = requestAnimationFrame(() => {
    currentFrame = 0;
    updateCurrent();
  });
}

// L'image « affichée » est la dernière dont le haut a passé le premier tiers de la zone visible.
function updateCurrent() {
  const figures = els.parts.querySelectorAll('figure.part');
  if (!figures.length) return;
  const view = els.mat.getBoundingClientRect();
  const top = Math.max(view.top, 0);
  const bottom = Math.min(view.bottom, window.innerHeight);
  const probe = top + (bottom - top) / 3;
  let index = 0;
  figures.forEach((figure, i) => {
    if (figure.getBoundingClientRect().top <= probe) index = i;
  });
  // Tout en bas, la dernière image est celle qu'on regarde, même si son haut n'a pas passé le repère.
  const matAtBottom = els.mat.scrollHeight > els.mat.clientHeight && els.mat.scrollHeight - els.mat.scrollTop - els.mat.clientHeight < 2;
  const pageAtBottom = document.documentElement.scrollHeight > window.innerHeight && document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 2;
  if (matAtBottom || pageAtBottom) index = figures.length - 1;
  currentIndex = index;
  if (!els.copyCurrent.disabled) {
    els.copyCurrent.textContent = parts.length > 1 ? `Copier l’image ${index + 1}` : 'Copier l’image';
  }
}

async function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    return await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

function baseName() {
  const host = (hostOf(record.url) || 'capture').replace(/[^a-z0-9.-]+/gi, '-');
  const d = new Date(record.createdAt);
  const two = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}_${two(d.getHours())}h${two(d.getMinutes())}-${two(d.getSeconds())}`;
  return `${host}_${stamp}`;
}

function fileName(index, ext) {
  if (parts.length === 1) return `${DOWNLOAD_FOLDER}/${baseName()}.${ext}`;
  return `${DOWNLOAD_FOLDER}/${baseName()}/image-${String(index + 1).padStart(2, '0')}.${ext}`;
}

function renderHistory(captures) {
  if (!captures.length) {
    const empty = document.createElement('li');
    empty.className = 'history-empty';
    empty.textContent = 'Tes captures apparaîtront ici.';
    els.history.replaceChildren(empty);
    return;
  }
  els.history.replaceChildren(...captures.map(historyEntry));
}

// Une entrée de l'historique : la capture à ouvrir, et la croix qui la supprime.
function historyEntry(capture) {
  const item = document.createElement('li');
  const entry = button('', 'history-item', () => openFromHistory(capture.id));
  entry.dataset.id = capture.id;
  const thumb = document.createElement('canvas');
  thumb.className = 'history-thumb';
  thumb.setAttribute('aria-hidden', 'true');
  queueThumb(thumb, capture);
  const title = text(capture.title || hostOf(capture.url) || 'Sans titre', 'history-title');
  title.id = `history-title-${capture.id}`;
  const meta = text('', 'history-meta');
  meta.dataset.host = hostOf(capture.url) || 'Page locale';
  meta.dataset.date = dates.format(capture.createdAt);
  const label = document.createElement('span');
  label.className = 'history-text';
  label.append(title, meta);
  entry.append(thumb, label);

  // Le nom reste celui du plan ; la description dit de quelle capture il s'agit (les croix portent toutes le même nom).
  const remove = button('', 'history-delete', () => removeFromHistory(capture.id));
  remove.setAttribute('aria-label', 'Supprimer cette capture');
  remove.setAttribute('aria-describedby', title.id);
  remove.title = 'Supprimer cette capture';
  remove.innerHTML = CROSS;

  item.append(entry, remove);
  showMeta(meta, editKinds.get(capture.id));
  return item;
}

// La ligne grise : l'hôte seul sur sa ligne (abrégé s'il est long), puis la date. Une capture annotée ou recadrée le dit : c'est ce qui
// explique qu'elle reste quand l'historique se nettoie. La date et la mention ne se coupent pas en deux ; si elles ne tiennent pas côte à
// côte, la mention passe à la ligne.
function showMeta(meta, kind) {
  const { host, date } = meta.dataset;
  const mark = kind?.annotated ? 'annotée' : kind?.trimmed ? 'recadrée' : '';
  meta.replaceChildren(text(`${host}, `, 'history-host'), text(mark ? `${date},` : date, 'history-date'));
  if (mark) meta.append(' ', text(mark, 'history-mark'));
}

// Vignette : le haut de l'image recadrée et ses annotations (`edits`, lus en base si absents), dessinés comme un aperçu. Un masque y cache
// ce qu'il cache dans les images, et l'image d'origine n'est jamais exposée dans la liste : rien à glisser ni à enregistrer.
function queueThumb(canvas, capture, edits) {
  thumbQueue = thumbQueue.then(() => drawThumb(canvas, capture, edits)).catch((err) => console.error(`Vignette non dessinée : ${err.message}`));
}

async function drawThumb(canvas, capture, known) {
  const { items, trim } = known ?? (editKinds.has(capture.id) ? await getEdits(capture.id) : { items: [], trim: null });
  const painter = new Stitcher(capture, {
    trim,
    overlay: (ctx, top, height, ratio, left) => drawAnnotations(ctx, items, capture.scale, top, height, ratio, left),
  });
  canvas.width = Math.round(THUMB.width * devicePixelRatio);
  try {
    const frame = painter.frame();
    await painter.renderPreview({ top: frame.y, height: Math.min(frame.h, Math.round((frame.w * THUMB.height) / THUMB.width)) }, canvas);
  } finally {
    painter.dispose();
  }
}

function historyItem(id) {
  return els.history.querySelector(`.history-item[data-id="${id}"]`)?.closest('li');
}

// Une capture devient annotée à sa première annotation, recadrée à son premier cadrage, et redevient ordinaire quand on a tout effacé.
function markEdited(id, { items, trim }) {
  const kind = { annotated: items.length > 0, trimmed: Boolean(trim) };
  if (kind.annotated || kind.trimmed) editKinds.set(id, kind);
  else editKinds.delete(id);
  const meta = historyItem(id)?.querySelector('.history-meta');
  if (meta) showMeta(meta, editKinds.get(id));
}

function markHistory(id) {
  for (const entry of els.history.querySelectorAll('.history-item')) {
    entry.setAttribute('aria-current', String(entry.dataset.id === id));
  }
}

// L'éditeur est un calque modal : tant qu'il est ouvert, ni la capture affichée ni l'historique ne changent.
function openFromHistory(id) {
  if (editing) return;
  openCapture(id).catch((err) => showEmpty('Impossible d’ouvrir la capture', err.message));
}

// Croix « Supprimer » : retire la capture et ses annotations, après confirmation.
async function removeFromHistory(id) {
  if (editing) return;
  const warning = editKinds.get(id)?.annotated ? ' et ses annotations' : '';
  if (!confirm(`Supprimer cette capture${warning} ? Cette action est définitive.`)) return;
  // Pendant la suppression, « Annoter » est refusé : l'éditeur rouvert sur la capture qui disparaît recréerait ses annotations.
  leaving++;
  setAnnotateEnabled();
  try {
    // Une annotation encore en train de s'écrire recréerait une entrée orpheline juste après la suppression.
    await saveQueue;
    await deleteCapture(id);
  } catch (err) {
    toast(`Suppression impossible : ${err.message}`);
    return;
  } finally {
    leaving--;
    setAnnotateEnabled();
  }
  // Une suppression simultanée de la même capture l'a déjà retirée de la liste, et a fait le reste.
  if (!historyItem(id)) return;
  // Ses annotations non enregistrées disparaissent avec elle : plus rien à retenter.
  if (failedSave?.captureId === id) forgetFailedSave();
  dropFromHistory(id);
  if (record?.id === id) {
    // La capture affichée disparaît : la plus récente restante la remplace, ou l'écran vide.
    const latest = els.history.querySelector('.history-item')?.dataset.id;
    if (latest) {
      openFromHistory(latest);
    } else {
      history.replaceState(null, '', location.pathname);
      showNoCapture();
    }
  }
  toast('Capture supprimée.', { success: true });
}

// Retire l'entrée de la liste ; le focus passe à sa voisine pour que la navigation au clavier continue.
function dropFromHistory(id) {
  const item = historyItem(id);
  const neighbour = item.nextElementSibling ?? item.previousElementSibling;
  item.querySelector('.history-thumb').width = 0;
  item.remove();
  editKinds.delete(id);
  if (!els.history.children.length) renderHistory([]);
  neighbour?.querySelector('.history-item')?.focus();
}

function showNoCapture() {
  showEmpty(
    'Aucune capture pour l’instant',
    'Sur la page à capturer, clique sur l’icône Capture dans la barre de Chrome, ou utilise son raccourci clavier.',
  );
}

// Écran sans capture ouverte : tout ce qui décrivait la précédente est remis à zéro.
function showEmpty(title, message) {
  // Un recalcul en cours n'a plus de capture où s'afficher.
  layoutToken++;
  planning = false;
  stitcher?.dispose();
  stitcher = null;
  record = null;
  annotationState = { items: [], trim: null };
  // Un bandeau qui parle des images affichées n'a plus d'objet sur un écran sans image.
  showSaveAlert();
  parts = [];
  document.title = 'Captures';
  els.title.textContent = 'Captures';
  els.meta.replaceChildren();
  els.notice.hidden = true;
  els.splitHint.textContent = '';
  els.parts.removeAttribute('aria-busy');
  els.downloadAll.textContent = 'Tout télécharger';
  els.downloadAll.disabled = true;
  els.export.disabled = true;
  els.copyCurrent.textContent = 'Copier l’image';
  els.copyCurrent.disabled = true;
  const box = document.createElement('div');
  box.className = 'empty';
  const heading = document.createElement('h2');
  heading.textContent = title;
  const body = document.createElement('p');
  body.textContent = message;
  box.append(heading, body);
  els.parts.replaceChildren(box);
  document.body.dataset.ready = 'true';
}

function updateFormatHint() {
  els.formatHint.textContent = FORMATS[settings.format].hint;
}

function buildSegmented(container, options, selected, onChange) {
  const buttons = Object.entries(options).map(([key, option]) => {
    const choice = button(option.label, '', () => {
      if (choice.getAttribute('aria-pressed') === 'true') return;
      for (const other of buttons) other.setAttribute('aria-pressed', String(other === choice));
      onChange(key);
    });
    choice.dataset.key = key;
    choice.setAttribute('aria-pressed', String(key === selected));
    return choice;
  });
  container.replaceChildren(...buttons);
}

// `lasting` : un échec d'export reste à l'écran jusqu'au message suivant, car un long export se laisse tourner dans un autre onglet.
function toast(message, { success = false, action, lasting = false } = {}) {
  const nodes = [text(message)];
  if (success) {
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.innerHTML = CHECK;
    nodes.unshift(icon);
  }
  if (action) nodes.push(button(action.label, 'toast-action', action.run));
  els.toast.replaceChildren(...nodes);
  // Masquer puis réafficher relance l'animation d'apparition, même si une notification était déjà visible.
  els.toast.hidden = true;
  void els.toast.offsetWidth;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  if (!lasting) toastTimer = setTimeout(() => (els.toast.hidden = true), 7000);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function text(content, className) {
  const span = document.createElement('span');
  span.textContent = content;
  if (className) span.className = className;
  return span;
}

function button(label, className, onClick) {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = label;
  if (className) el.className = className;
  el.addEventListener('click', onClick);
  return el;
}
