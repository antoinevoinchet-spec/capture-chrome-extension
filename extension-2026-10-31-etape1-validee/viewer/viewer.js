import { getCapture, listCaptures } from '../lib/db.js';
import { FORMATS, SPLITS, loadSettings, saveSettings } from '../lib/settings.js';
import { Stitcher } from './stitcher.js';

// Largeur d'affichage maximale d'un aperçu, en points.
const PREVIEW_WIDTH = 820;
// Sous-dossier de Téléchargements où arrivent les images.
const DOWNLOAD_FOLDER = 'Captures';

const CHECK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

const SCISSORS =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88"/><path d="M14.47 14.48 20 20"/><path d="M8.12 8.12 12 12"/></svg>';

const els = {
  title: document.getElementById('title'),
  meta: document.getElementById('meta'),
  copyCurrent: document.getElementById('copy-current'),
  downloadAll: document.getElementById('download-all'),
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
let parts = [];
let layoutToken = 0;
let busy = false;
let copying = false;
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
  for (const target of [els.mat, window]) target.addEventListener('scroll', scheduleCurrent, { passive: true });
  window.addEventListener('resize', scheduleCurrent);
  setupCopyGestures();

  const captures = await listCaptures();
  const id = new URLSearchParams(location.search).get('id') ?? captures[0]?.id;
  renderHistory(captures);
  if (!id) {
    showEmpty(
      'Aucune capture pour l’instant',
      'Sur la page à capturer, clique sur l’icône Capture dans la barre de Chrome, ou utilise son raccourci clavier.',
    );
    return;
  }
  await openCapture(id);
}

async function openCapture(id) {
  const next = await getCapture(id);
  if (!next) {
    showEmpty('Capture introuvable', 'Elle a été retirée de l’historique, qui garde les 15 dernières captures.');
    return;
  }
  stitcher?.dispose();
  record = next;
  stitcher = new Stitcher(record);
  history.replaceState(null, '', `?id=${id}`);

  const host = hostOf(record.url);
  document.title = `${record.title || host || 'Capture'} | Capture`;
  els.title.textContent = record.title || host || 'Capture sans titre';
  els.meta.replaceChildren(
    text(host || 'Page locale'),
    text(dates.format(record.createdAt)),
    text(`${px(record.width)} × ${px(record.height)} px au total`),
  );
  els.notice.hidden = !record.truncated;
  markHistory(id);
  await layoutParts();
}

async function layoutParts() {
  if (!record) return;
  const token = ++layoutToken;
  document.body.dataset.ready = 'false';
  els.parts.setAttribute('aria-busy', 'true');
  els.downloadAll.disabled = true;
  els.copyCurrent.disabled = true;

  const split = SPLITS[settings.split];
  const maxHeight = split.points ? split.points * record.scale : record.crop.h;
  const planned = await stitcher.planParts(maxHeight);
  if (token !== layoutToken) return;
  parts = planned;

  const tallest = Math.max(...parts.map((p) => p.height));
  els.splitHint.textContent =
    parts.length > 1
      ? `${parts.length} images, ${px(tallest)} px de haut au plus.`
      : `Une seule image de ${px(record.height)} px de haut.`;
  els.downloadAll.textContent = parts.length > 1 ? `Tout télécharger (${parts.length} images)` : 'Télécharger l’image';
  els.downloadAll.disabled = false;

  const canvasWidth = Math.min(record.width, Math.round(PREVIEW_WIDTH * devicePixelRatio));
  const canvases = [];
  const nodes = [];
  parts.forEach((part, index) => {
    if (index > 0) nodes.push(cutLine(index));
    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = Math.max(1, Math.round((part.height * canvasWidth) / record.width));
    canvases.push(canvas);
    nodes.push(partCard(index, canvas));
  });
  els.parts.replaceChildren(...nodes);
  els.copyCurrent.disabled = false;
  updateCurrent();

  for (let i = 0; i < parts.length; i++) {
    await stitcher.renderPreview(parts[i], canvases[i]);
    if (token !== layoutToken) return;
  }
  els.parts.removeAttribute('aria-busy');
  document.body.dataset.ready = 'true';
}

function partCard(index, canvas) {
  const figure = document.createElement('figure');
  figure.className = 'part';
  figure.style.maxWidth = `${Math.min(PREVIEW_WIDTH, Math.round(record.width / record.scale))}px`;

  const caption = document.createElement('figcaption');
  const name = text(parts.length > 1 ? `Image ${index + 1} sur ${parts.length}` : 'Image unique', 'part-name');
  const size = text(`${px(record.width)} × ${px(parts[index].height)} px`, 'part-size');
  const actions = document.createElement('span');
  actions.className = 'part-actions';
  const copy = button('Copier', 'ghost', () => copyPart(index, copy));
  const save = button('Télécharger', 'ghost', () => downloadParts([index], save));
  actions.append(copy, save);
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
  let lastId;
  try {
    for (const [n, index] of indices.entries()) {
      if (trigger) trigger.textContent = indices.length > 1 ? `Préparation ${n + 1} sur ${indices.length}…` : 'Préparation…';
      const blob = await stitcher.renderPart(parts[index], format.type);
      lastId = await saveBlob(blob, fileName(index, format.ext));
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

// Toutes les façons de copier (boutons, clic droit, ⌘C) passent par ici : pleine résolution et notification.
async function copyPart(index, trigger) {
  if (copying || !parts[index]) return;
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
    if (!copyKey || !parts.length) return;
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
  els.history.replaceChildren(
    ...captures.map((capture) => {
      const item = document.createElement('li');
      const entry = button('', 'history-item', () => openCapture(capture.id));
      entry.dataset.id = capture.id;
      const thumb = document.createElement('img');
      thumb.alt = '';
      thumb.src = URL.createObjectURL(capture.slices[0].blob);
      const label = document.createElement('span');
      label.className = 'history-text';
      label.append(
        text(capture.title || hostOf(capture.url) || 'Sans titre', 'history-title'),
        text(`${hostOf(capture.url) || 'Page locale'}, ${dates.format(capture.createdAt)}`, 'history-meta'),
      );
      entry.append(thumb, label);
      item.append(entry);
      return item;
    }),
  );
}

function markHistory(id) {
  for (const entry of els.history.querySelectorAll('.history-item')) {
    entry.setAttribute('aria-current', String(entry.dataset.id === id));
  }
}

function showEmpty(title, message) {
  record = null;
  parts = [];
  els.downloadAll.disabled = true;
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

function toast(message, { success = false, action } = {}) {
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
  toastTimer = setTimeout(() => (els.toast.hidden = true), 7000);
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
