// Éditeur d'annotation plein écran : la capture entière d'un seul tenant, et ses annotations par-dessus.
// Seule la zone visible est dessinée en pleine définition : le fond est découpé en tuiles créées et libérées au fil du
// défilement, et le calque d'annotations (Konva) n'a que la taille de la zone visible et suit le défilement.
// Les sept outils tracent à la souris ; chaque modification validée est aussitôt transmise à la page (`onChange`) qui l'enregistre.
// Un clic sélectionne une annotation : on la déplace, on la redimensionne par ses coins (une flèche, par ses extrémités), on change
// sa couleur ou sa taille, on la supprime. Annuler, rétablir et « Tout effacer » agissent sur toute la liste.
// Konva est chargé par la page (balise <script>) : on y accède par le global `Konva`.

import { COLORS, SIZES, TOOLS, badgeNumbers, createNode, itemBounds, maskRect, measureItems } from './shapes.js';

// Hauteur d'une tuile de fond, en pixels de la capture, et recouvrement avec la suivante : pas de filet clair entre deux tuiles.
const TILE_PX = 2048;
const TILE_OVERLAP_PX = 4;
// Marge entre la capture et les bords de la zone de défilement, en points.
const GUTTER = 16;
// Espace laissé au-dessus de l'image visée à l'ouverture, en points : on voit la coupe qui la précède.
const TOP_GAP = 24;
// Après un redimensionnement de la fenêtre, attente avant de refaire la mise en page, en millisecondes.
const RESIZE_DELAY = 120;
// Un glisser de moins de MIN_DRAG points d'écran n'est qu'un clic ; le crayon note un point tous les PEN_STEP points d'écran.
const MIN_DRAG = 4;
const PEN_STEP = 2;
// Outils qui se posent d'un clic (les autres se tracent en glissant), et annotations pleines sur lesquelles ils se posent.
const CLICK_TOOLS = ['text', 'badge'];
const FILLED = ['highlight', 'mask'];
// Couleur de départ de chaque outil : jaune pour le surligneur, rouge pour les autres.
const START_COLORS = Object.fromEntries(TOOLS.map(({ key }) => [key, key === 'highlight' ? 'yellow' : 'red']));
// Teinte d'un masque pendant qu'on le tire, et s'il est impossible de lire son liseré.
const NEUTRAL_FILL = '#808080';
// Nombre de modifications que « Annuler » peut défaire.
const HISTORY_LIMIT = 100;
// Cadre de sélection : couleur du liseré et des poignées, coins offerts, rayon des poignées de flèche (en points d'écran),
// types d'annotation qu'on redimensionne par leurs coins (les autres ne font que se déplacer).
const SELECT_COLOR = '#0a84ff';
const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const HANDLE_RADIUS = 7;
const RESIZABLE = ['rect', 'highlight', 'mask'];
const CLEAR_QUESTION = 'Effacer toutes les annotations de cette capture ?';

const els = {
  root: document.getElementById('editor'),
  close: document.getElementById('editor-close'),
  copy: document.getElementById('editor-copy'),
  tools: document.getElementById('editor-tools'),
  scroll: document.getElementById('editor-scroll'),
  stage: document.getElementById('editor-stage'),
  page: document.getElementById('editor-page'),
  // Annuler et Rétablir sont dans la page ; « Tout effacer » est créé par buildHistory.
  undo: document.querySelector('.editor-history [aria-label="Annuler"]'),
  redo: document.querySelector('.editor-history [aria-label="Rétablir"]'),
  clear: null,
};

const svgIcon = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const TOOL_ICONS = {
  arrow: svgIcon('<path d="M6 18 18 6"/><path d="M9 6h9v9"/>'),
  rect: svgIcon('<rect x="4" y="6" width="16" height="12" rx="1.5"/>'),
  highlight: svgIcon('<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>'),
  text: svgIcon('<path d="M5 7V5h14v2"/><path d="M12 5v14"/><path d="M9 19h6"/>'),
  badge: svgIcon('<circle cx="12" cy="12" r="8.5"/><path d="m10.5 10 2-1.5V16"/>'),
  mask: svgIcon(
    '<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M4 12h16M12 4v16"/><rect x="4" y="4" width="8" height="8" fill="currentColor"/><rect x="12" y="12" width="8" height="8" fill="currentColor"/>',
  ),
  pen: svgIcon('<path d="m4 20 1-4L16 5a2.1 2.1 0 0 1 3 3L8 19z"/><path d="m14 7 3 3"/>'),
};

const CLEAR_ICON = svgIcon('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>');

// Rayon (dans une boîte de 24) du point qui figure chaque taille.
const SIZE_DOTS = { s: 3.5, m: 6, l: 9 };

// Séance en cours (null quand l'éditeur est fermé). Champs : record, stitcher, parts, onChange, onCopy, onClose,
// items (les annotations, remplacées par une nouvelle liste à chaque modification), undoStack et redoStack (les listes
// précédentes et suivantes, jamais modifiées sur place), selection (l'id de l'annotation sélectionnée), tool, colors (la couleur
// de chaque outil), size, gesture (le geste de souris en cours), textEdit (le texte en cours de saisie), queue (les modifications en
// attente, l'une après l'autre) et pending (leur nombre), closing, view (points d'écran par pixel de capture), offset (marge gauche de
// la page), tiles, stage, layer, masks et shapes (les deux groupes d'annotations), nodes (le nœud de chaque annotation, par id),
// frame (le cadre de sélection), handles (les poignées d'extrémité d'une flèche), pumping (une tuile se dessine), resizeTimer,
// abort (retire les écouteurs de saisie à la fermeture).
let session = null;

buildToolbar();
buildHistory();

// Ouvre l'éditeur sur la capture `record`, positionné sur le point `startTop` (pixels de la capture).
// `parts` sont les images de la page de résultats (les coupes y sont affichées) ; `items` les annotations de départ.
// `onChange(items)` reçoit la nouvelle liste après chaque modification validée ; `onCopy(index)` copie l'une des images ;
// `onClose()` est appelé quand l'éditeur est refermé.
export function openEditor({ record, stitcher, parts, items, startTop, onChange, onCopy, onClose }) {
  if (session) return;
  session = {
    record,
    stitcher,
    parts,
    items,
    onChange,
    onCopy,
    onClose,
    undoStack: [],
    redoStack: [],
    selection: null,
    tool: TOOLS[0].key,
    colors: { ...START_COLORS },
    size: 'm',
    gesture: null,
    textEdit: null,
    queue: Promise.resolve(),
    pending: 0,
    closing: false,
    view: 1,
    offset: 0,
    tiles: [],
    nodes: new Map(),
    pumping: false,
    resizeTimer: 0,
    abort: new AbortController(),
  };
  const { signal } = session.abort;

  setPageInert(true);
  els.root.dataset.ready = 'false';
  els.root.hidden = false;
  buildStage();
  showChoices();
  showHistory();
  layout(startTop, TOP_GAP);

  els.close.addEventListener('click', closeEditor, { signal });
  els.copy.addEventListener('click', copyReadingPart, { signal });
  els.undo.addEventListener('click', undo, { signal });
  els.redo.addEventListener('click', redo, { signal });
  els.clear.addEventListener('click', clearAll, { signal });
  els.tools.addEventListener('click', onToolbarClick, { signal });
  els.scroll.addEventListener('scroll', syncView, { passive: true, signal });
  els.stage.addEventListener('pointerdown', onPointerDown, { signal });
  els.stage.addEventListener('pointermove', onPointerMove, { signal });
  els.stage.addEventListener('pointerup', onPointerUp, { signal });
  els.stage.addEventListener('pointercancel', cancelGesture, { signal });
  els.stage.addEventListener('dblclick', onDoubleClick, { signal });
  els.stage.addEventListener('contextmenu', onContextMenu, { signal });
  window.addEventListener('resize', onResize, { signal });
  // Ces deux écouteurs restent en place pendant la fermeture, jusqu'à la fin des créations (voir closeEditor).
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('pagehide', commitText);
  document.addEventListener('keydown', onKeydown, { signal });
  els.tools.querySelector('button').focus();
}

// Ferme l'éditeur. Plus aucune entrée n'est prise tout de suite ; on attend les modifications en cours (un masque lit
// son liseré) avant de tout libérer, pour qu'aucune ne soit perdue. Fermer l'onglet pendant ce temps demande confirmation.
async function closeEditor() {
  const ended = session;
  if (!ended || ended.closing) return;
  ended.closing = true;
  ended.abort.abort();
  commitText();
  await ended.queue;
  window.removeEventListener('beforeunload', onBeforeUnload);
  window.removeEventListener('pagehide', commitText);
  session = null;
  clearTimeout(ended.resizeTimer);
  ended.stage.destroy();
  for (const tile of ended.tiles) releaseTile(tile);
  els.page.replaceChildren();
  setPageInert(false);
  els.root.hidden = true;
  ended.onClose();
}

// Le reste de la page ne reçoit ni clic ni focus tant que l'éditeur est ouvert (le message temporaire reste actif).
function setPageInert(inert) {
  for (const el of document.querySelectorAll('.top, .layout, #image-menu')) el.inert = inert;
}

// Pendant la saisie d'un texte, les touches n'arrivent pas jusqu'ici (voir onFieldKeydown).
function onKeydown(event) {
  if (event.key === 'Escape') {
    closeEditor();
    return;
  }
  const key = event.key.toLowerCase();
  const command = (event.metaKey || event.ctrlKey) && !event.altKey;
  if (command && !event.shiftKey && key === 'c') {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    event.preventDefault();
    copyReadingPart();
    return;
  }
  if (command && key === 'z') {
    event.preventDefault();
    if (!session.gesture) (event.shiftKey ? redo : undo)();
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
  if (key === 'backspace' || key === 'delete') {
    event.preventDefault();
    removeSelection();
    return;
  }
  const tool = TOOLS.find(({ shortcut }) => shortcut.toLowerCase() === key);
  if (tool) chooseTool(tool.key);
}

// Le clic droit n'ouvre pas le menu de Chrome sur le calque : son « Copier l'image » ne copierait que les annotations, sur un fond
// vide et à la taille de l'écran. Le champ d'un texte garde le sien (coller, corriger).
function onContextMenu(event) {
  if (event.target !== session.textEdit?.field) event.preventDefault();
}

// ---- Barre d'outils ----

function buildToolbar() {
  const tools = TOOLS.map((tool) => choice(tool.key, tool.label, 'editor-tool', TOOL_ICONS[tool.key], `${tool.label} (${tool.shortcut})`));
  const colors = Object.entries(COLORS).map(([key, color]) => swatch(key, color));
  const sizes = Object.entries(SIZES).map(([key, size]) => choice(key, `Taille : ${size.label}`, 'editor-size', sizeDot(key)));
  els.tools.replaceChildren(group('tool', 'Outils', tools), group('color', 'Couleur', colors), group('size', 'Taille', sizes));
}

function sizeDot(key) {
  return svgIcon(`<circle cx="12" cy="12" r="${SIZE_DOTS[key]}" fill="currentColor"/>`);
}

// « Tout effacer » rejoint Annuler et Rétablir, déjà dans la page.
function buildHistory() {
  els.clear = choice('clear', 'Tout effacer', 'editor-icon editor-clear', CLEAR_ICON);
  els.redo.after(els.clear);
}

// Un groupe de boutons dont un seul est enfoncé à la fois (voir showChoices) ; `kind` dit ce qu'il règle : tool, color ou size.
function group(kind, label, buttons) {
  const box = document.createElement('div');
  box.className = 'editor-group';
  box.dataset.kind = kind;
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', label);
  box.append(...buttons);
  return box;
}

// Un bouton de choix ; `key` est la clé de l'outil, de la couleur ou de la taille qu'il choisit.
function choice(key, label, className, content, hint = label) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = className;
  el.dataset.key = key;
  el.setAttribute('aria-label', label);
  el.title = hint;
  el.innerHTML = content;
  return el;
}

function swatch(key, color) {
  const el = choice(key, color.label, 'editor-color', '');
  el.style.setProperty('--swatch', color.hex);
  return el;
}

const CHOOSERS = { tool: chooseTool, color: chooseColor, size: chooseSize };

function onToolbarClick(event) {
  const button = event.target.closest('button');
  if (button) CHOOSERS[button.closest('.editor-group').dataset.kind](button.dataset.key);
}

function chooseTool(key) {
  session.tool = key;
  showChoices();
}

// Chaque outil retient sa couleur : celle de l'outil de l'annotation sélectionnée (son type), sinon celle de l'outil actif.
// L'annotation sélectionnée la prend aussi.
function chooseColor(key) {
  session.colors[selectedItem()?.type ?? session.tool] = key;
  restyleSelection('color', key);
  showChoices();
}

// La taille est commune à tous les outils.
function chooseSize(key) {
  session.size = key;
  restyleSelection('size', key);
  showChoices();
}

function restyleSelection(field, value) {
  const id = session.selection;
  if (id !== null) queueEdit(() => editItem(id, (item) => restyled(item, field, value)), 'Modification non faite');
}

// L'annotation avec sa nouvelle couleur ou taille. Un texte ou une pastille qui grandit est ramené dans la capture.
function restyled(item, field, value) {
  const next = { ...item, [field]: value };
  return field === 'size' && CLICK_TOOLS.includes(item.type) ? keepInside(next) : next;
}

// Enfonce le bouton de l'outil, de la couleur et de la taille en cours : ceux de l'annotation sélectionnée s'il y en a une, sinon
// la couleur de l'outil et la taille choisie. Le masque n'a ni couleur ni taille : ces deux groupes sont alors inactifs
// (outil masque sans sélection, ou masque sélectionné) et rien n'y est enfoncé. Le surligneur, plein, n'a pas de taille : ce groupe
// est inactif avec lui, outil ou annotation sélectionnée.
function showChoices() {
  const item = selectedItem();
  const chosen = { tool: session.tool, color: item?.color ?? session.colors[session.tool], size: item?.size ?? session.size };
  const kind = item ? item.type : session.tool;
  for (const box of els.tools.children) {
    const unused = (kind === 'mask' && box.dataset.kind !== 'tool') || (kind === 'highlight' && box.dataset.kind === 'size');
    for (const el of box.children) {
      el.disabled = unused;
      el.setAttribute('aria-pressed', String(!unused && el.dataset.key === chosen[box.dataset.kind]));
    }
  }
  els.stage.dataset.tool = session.tool;
}

// Annuler, Rétablir et Tout effacer ne sont actifs que s'il y a quelque chose à défaire, à rétablir ou à effacer.
function showHistory() {
  els.undo.disabled = session.undoStack.length === 0;
  els.redo.disabled = session.redoStack.length === 0;
  els.clear.disabled = session.items.length === 0;
}

// ---- Mise en page : échelle, page, tuiles, coupes, calque ----

// Calque d'annotations : une scène Konva dont les masques sont sous les autres annotations (comme à l'export), puis le cadre de
// sélection et les poignées d'une flèche, par-dessus tout.
function buildStage() {
  const stage = new Konva.Stage({ container: els.stage, width: 1, height: 1 });
  const layer = new Konva.Layer();
  const masks = new Konva.Group();
  const shapes = new Konva.Group();
  const frame = buildFrame();
  const handles = new Konva.Group({ visible: false });
  for (let i = 0; i < 2; i++) {
    handles.add(new Konva.Circle({ name: 'handle', radius: HANDLE_RADIUS, fill: '#ffffff', stroke: SELECT_COLOR, strokeWidth: 2, hitStrokeWidth: 12 }));
  }
  layer.add(masks, shapes, frame, handles);
  stage.add(layer);
  Object.assign(session, { stage, layer, masks, shapes, frame, handles });
  fillGroups();
}

// Cadre de sélection : sans rotation ni retournement, il redimensionne par les quatre coins. Konva ne fait qu'étirer le nœud ; on
// reporte l'étirement sur sa largeur et sa hauteur au fil du tirage (le trait garde ainsi son épaisseur), puis on enregistre au lâcher.
function buildFrame() {
  const frame = new Konva.Transformer({
    rotateEnabled: false,
    flipEnabled: false,
    keepRatio: false,
    ignoreStroke: true,
    enabledAnchors: CORNERS,
    borderStroke: SELECT_COLOR,
    anchorStroke: SELECT_COLOR,
    anchorFill: '#ffffff',
    boundBoxFunc: keepBoxInside,
  });
  frame.on('transform', () => foldScale(frame));
  frame.on('transformend', () => finishResize(frame));
  return frame;
}

// Dessine toutes les annotations de la liste en cours. Une annotation abîmée est sautée par measureItems, comme à l'export.
function fillGroups() {
  const { record, items, masks, shapes, nodes } = session;
  const numbers = badgeNumbers(items);
  nodes.clear();
  for (const { item } of measureItems(items, record.scale)) {
    const node = nodeFor(item, numbers.get(item.id));
    (item.type === 'mask' ? masks : shapes).add(node);
    nodes.set(item.id, node);
  }
}

// Nœud d'une annotation dans l'éditeur. Un rectangle est un cadre : seul son trait se saisit à la souris, pas son intérieur
// (on y clique pour poser un texte ou une pastille).
function nodeFor(item, badgeNumber) {
  const node = createNode(item, session.record.scale, badgeNumber);
  if (item.type === 'rect') node.fillEnabled(false);
  return node;
}

// Calcule l'échelle et pose la page, les tuiles, les coupes et le calque, puis amène le point `top` de la capture
// (moins `gap` points) en haut de la zone de défilement.
// Échelle : points d'écran par pixel de capture, jamais plus grande qu'à 100 % ni plus large que la zone.
function layout(top, gap = 0) {
  const { record, parts } = session;
  for (const tile of session.tiles) releaseTile(tile);
  const view = Math.min(1 / record.scale, (els.scroll.clientWidth - 2 * GUTTER) / record.width);
  const width = record.width * view;
  session.view = view;
  session.offset = Math.round((els.scroll.clientWidth - width) / 2);
  session.tiles = buildTiles();

  els.root.dataset.scale = String(view);
  els.root.dataset.ready = 'false';
  els.page.style.width = `${width}px`;
  els.page.style.height = `${record.height * view}px`;
  els.page.style.marginLeft = `${session.offset}px`;
  els.page.replaceChildren(...session.tiles.map((tile) => tile.el), ...parts.slice(1).map((part) => cutLine(part, view)));

  els.stage.style.width = `${els.scroll.clientWidth}px`;
  els.stage.style.height = `${els.scroll.clientHeight}px`;
  session.stage.size({ width: els.scroll.clientWidth, height: els.scroll.clientHeight });
  session.stage.scale({ x: view, y: view });
  session.stage.x(session.offset);
  // Les poignées d'une flèche gardent la même taille à l'écran, quelle que soit l'échelle.
  for (const handle of session.handles.getChildren()) handle.scale({ x: 1 / view, y: 1 / view });

  els.scroll.scrollTop = Math.max(0, top * view - gap);
  syncView();
}

function buildTiles() {
  const { record, view } = session;
  const tiles = [];
  for (let top = 0; top < record.height; top += TILE_PX) {
    const height = Math.min(TILE_PX + TILE_OVERLAP_PX, record.height - top);
    const el = document.createElement('div');
    el.className = 'editor-tile';
    el.style.top = `${top * view}px`;
    el.style.height = `${height * view}px`;
    tiles.push({ top, height, el, canvas: null, drawn: false });
  }
  return tiles;
}

// Trait en pointillé à l'endroit où la page de résultats coupe la capture.
function cutLine(part, view) {
  const line = document.createElement('div');
  line.className = 'editor-cut';
  line.style.top = `${part.top * view}px`;
  line.setAttribute('aria-hidden', 'true');
  return line;
}

function onResize() {
  clearTimeout(session.resizeTimer);
  session.resizeTimer = setTimeout(() => layout(els.scroll.scrollTop / session.view), RESIZE_DELAY);
}

// Le calque et les tuiles suivent le défilement.
function syncView() {
  const { layer, view } = session;
  layer.y(-els.scroll.scrollTop / view);
  layer.draw();
  for (const tile of session.tiles) if (!inReach(tile, els.scroll.clientHeight)) releaseTile(tile);
  pump();
  updateReady();
  updateCopyLabel();
  placeField();
}

// ---- Tuiles de fond ----

// Une tuile est à portée si elle touche la zone visible élargie de `reach` points au-dessus et en dessous.
function inReach(tile, reach) {
  const { view } = session;
  const { scrollTop, clientHeight } = els.scroll;
  return tile.top * view < scrollTop + clientHeight + reach && (tile.top + tile.height) * view > scrollTop - reach;
}

// Prochaine tuile à dessiner : à portée (une zone d'un écran de chaque côté), la plus proche du centre de la zone visible.
function nextTile() {
  const { view } = session;
  const middle = (els.scroll.scrollTop + els.scroll.clientHeight / 2) / view;
  let best = null;
  let bestDistance = Infinity;
  for (const tile of session.tiles) {
    if (tile.canvas || !inReach(tile, els.scroll.clientHeight)) continue;
    const distance = Math.abs(tile.top + tile.height / 2 - middle);
    if (distance < bestDistance) {
      best = tile;
      bestDistance = distance;
    }
  }
  return best;
}

// Dessine les tuiles à portée une à une : le découpeur ne fait qu'une opération à la fois, et une tuile qu'on a déjà
// quittée n'est jamais mise en file.
async function pump() {
  const current = session;
  if (current.pumping) return;
  current.pumping = true;
  while (session === current) {
    const tile = nextTile();
    if (!tile) break;
    await drawTile(tile);
    if (session === current) updateReady();
  }
  current.pumping = false;
}

async function drawTile(tile) {
  const { record, stitcher, view } = session;
  const canvas = document.createElement('canvas');
  // Un pixel de canvas par pixel d'écran, sans jamais dépasser la définition de la capture.
  canvas.width = Math.min(record.width, Math.round(record.width * view * devicePixelRatio));
  tile.canvas = canvas;
  tile.el.append(canvas);
  try {
    await stitcher.renderPreview({ top: tile.top, height: tile.height }, canvas, { overlay: false });
  } catch (err) {
    console.error(`Tuile de fond non dessinée : ${err.message}`);
  }
  if (tile.canvas === canvas) tile.drawn = true;
}

function releaseTile(tile) {
  if (!tile.canvas) return;
  // Largeur à zéro : la mémoire du canvas est rendue tout de suite, sans attendre le ramasse-miettes.
  tile.canvas.width = 0;
  tile.canvas.remove();
  tile.canvas = null;
  tile.drawn = false;
}

// data-ready : toute la zone visible (sans la marge) est dessinée.
function updateReady() {
  els.root.dataset.ready = String(session.tiles.every((tile) => tile.drawn || !inReach(tile, 0)));
}

// ---- Gestes : tracer, sélectionner, déplacer, tirer ----

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// Distance, en points d'écran, entre un point de départ et la position d'un événement de pointeur.
const travelled = (from, event) => Math.hypot(event.clientX - from.x, event.clientY - from.y);

// Position du pointeur dans la capture (pixels réels), ramenée dans ses bords : un tracé qui sort de la capture s'arrête à son bord.
// `outside` dit que le pointeur était hors de la capture (dans la marge grise) avant d'être ramené ; `free` est alors sa position
// exacte. Elle suit le défilement : le calque se déplace avec lui.
function pointAt(event) {
  const { stage, layer, record } = session;
  stage.setPointersPositions(event);
  const free = layer.getRelativePointerPosition();
  const inside = { x: clamp(free.x, 0, record.width), y: clamp(free.y, 0, record.height) };
  return { ...inside, outside: inside.x !== free.x || inside.y !== free.y, free };
}

// Annotation neuve avec la couleur de l'outil et la taille du moment. Le type d'une annotation est la clé de son outil.
// Un masque n'a ni l'une ni l'autre : sa teinte vient de son liseré (voir tintedMask).
function newItem(type) {
  const base = { id: crypto.randomUUID(), type };
  return type === 'mask' ? base : { ...base, color: session.colors[type], size: session.size };
}

// Ce que touche le pointeur : une poignée du cadre (`anchor`, que Konva tire lui-même), une extrémité de flèche (`end`, son rang),
// une annotation (`id`), ou rien.
function hitAt(event) {
  const { stage, frame, handles, masks, shapes } = session;
  stage.setPointersPositions(event);
  let node = stage.getIntersection(stage.getPointerPosition());
  if (!node) return {};
  if (node.getParent() === frame) return { anchor: true };
  if (node.getParent() === handles) return { end: handles.getChildren().indexOf(node) };
  while (node.getParent() !== masks && node.getParent() !== shapes) node = node.getParent();
  return { id: node.name() };
}

// Un geste commence à l'appui : s'il devient un glisser, il tire une extrémité de flèche, déplace l'annotation sélectionnée (si on
// la touche) ou trace avec l'outil actif. Sans glisser, c'est un clic (voir clickDraw).
function onPointerDown(event) {
  if (event.button !== 0 || !event.isPrimary) return;
  // Un clic hors du champ de texte le valide, et ne fait rien d'autre.
  if (session.textEdit) {
    commitText();
    return;
  }
  const hit = hitAt(event);
  if (hit.anchor) return;
  const start = pointAt(event);
  const origin = { x: event.clientX, y: event.clientY };
  // Le pointeur reste suivi hors de l'éditeur : un tracé peut sortir de la capture, voire de la fenêtre.
  els.stage.setPointerCapture(event.pointerId);
  session.gesture = { ...gestureFor(hit, start, origin), pointerId: event.pointerId, origin, start, hit, dragged: false };
}

// Le geste est un tracé (`draw`, avec l'annotation de base, son point courant, ses points et son aperçu), le déplacement de
// l'annotation sélectionnée (`move`, avec le point saisi, l'emprise de l'annotation et sa place de départ) ou le tirage d'une de
// ses extrémités (`handle`).
function gestureFor(hit, start, origin) {
  const item = selectedItem();
  const node = item && session.nodes.get(item.id);
  if (hit.end !== undefined) return { kind: 'handle', item, node, index: hit.end, points: item.points };
  if (item && hit.id === item.id) {
    return { kind: 'move', item, node, grab: start.free, extent: extentOf(item), from: node.position(), shift: { dx: 0, dy: 0 } };
  }
  return { kind: 'draw', base: newItem(session.tool), step: origin, end: start, points: [start.x, start.y], node: null };
}

const DRAGS = { draw: dragDraw, move: dragMove, handle: dragHandle };
const DROPS = { draw: dropDraw, move: dropMove, handle: dropHandle };

function onPointerMove(event) {
  const gesture = session.gesture;
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  if (!gesture.dragged && travelled(gesture.origin, event) < MIN_DRAG) return;
  gesture.dragged = true;
  DRAGS[gesture.kind](gesture, event);
}

function onPointerUp(event) {
  const gesture = session.gesture;
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  session.gesture = null;
  // Un geste très rapide peut ne laisser aucun mouvement entre l'appui et le relâchement : la distance parcourue fait foi.
  gesture.dragged ||= travelled(gesture.origin, event) >= MIN_DRAG;
  if (gesture.dragged) DROPS[gesture.kind](gesture, event);
  else if (gesture.kind === 'draw') clickDraw(gesture);
  // L'annotation touchée était déjà sélectionnée : sans glisser, texte et pastille s'y posent quand même si elle est pleine.
  else if (gesture.kind === 'move' && CLICK_TOOLS.includes(session.tool)) clickDraw({ ...gesture, base: newItem(session.tool) });
}

// Un clic sans glisser sélectionne l'annotation touchée, quel que soit l'outil. Ailleurs il retire la sélection, et les outils
// texte et pastille posent leur élément (pas dans la marge grise). Un surligneur ou un masque est une zone pleine sur laquelle on
// écrit et numérote : texte et pastille s'y posent, comme dans un rectangle, au lieu de le sélectionner.
function clickDraw({ hit, base, start }) {
  const target = session.items.find((item) => item.id === hit.id);
  const placing = CLICK_TOOLS.includes(base.type) && !start.outside && (!target || FILLED.includes(target.type));
  select(placing ? null : (hit.id ?? null));
  if (placing) placeAt({ base, start });
}

// Abandonne le geste en cours (le pointeur a été repris par le système) : un tracé disparaît, une annotation retrouve sa place.
function cancelGesture() {
  const gesture = session.gesture;
  session.gesture = null;
  if (!gesture) return;
  if (gesture.kind === 'draw') gesture.node?.destroy();
  else restore(gesture.item);
  session.layer.batchDraw();
}

// Redonne à une annotation sélectionnée l'aspect de ses données, après un geste abandonné.
function restore(item) {
  refreshNode(item);
  showSelection();
}

function dragDraw(draft, event) {
  select(null);
  if (CLICK_TOOLS.includes(draft.base.type)) return;
  draft.end = pointAt(event);
  if (draft.base.type === 'pen' && travelled(draft.step, event) >= PEN_STEP) {
    draft.points.push(draft.end.x, draft.end.y);
    draft.step = { x: event.clientX, y: event.clientY };
  }
  showDraft(draft);
}

function dropDraw(draft, event) {
  select(null);
  // Un glisser ne pose ni texte ni pastille.
  if (CLICK_TOOLS.includes(draft.base.type)) return;
  draft.end = pointAt(event);
  const item = draftItem(draft);
  if (isEmpty(item)) {
    // Sans mouvement intermédiaire, aucun aperçu n'a été dessiné.
    draft.node?.destroy();
    session.layer.batchDraw();
    return;
  }
  // Le nœud du tracé reste affiché jusqu'à ce que l'annotation validée prenne sa place.
  queueCreation(item, draft.node);
}

// Le nœud suit le pointeur ; l'annotation n'est remplacée qu'au lâcher. Le déplacement se mesure dans la capture, pas à l'écran :
// il suit la molette pendant le geste. Les poignées d'une flèche l'accompagnent.
function dragMove(gesture, event) {
  const { item, node, grab, extent, from } = gesture;
  const here = pointAt(event).free;
  let { dx, dy } = boundedShift(extent, here.x - grab.x, here.y - grab.y);
  // Un masque se déplace d'un nombre entier de pixels : arrondi vers l'extérieur ensuite, il grandirait à chaque déplacement.
  if (item.type === 'mask') [dx, dy] = [Math.round(dx), Math.round(dy)];
  gesture.shift = { dx, dy };
  node.position({ x: from.x + dx, y: from.y + dy });
  if (item.type === 'arrow') placeHandles(shifted(item, dx, dy).points);
  session.layer.batchDraw();
}

function dropMove(gesture, event) {
  dragMove(gesture, event);
  const { item, shift } = gesture;
  queueEdit(() => editItem(item.id, (current) => shifted(current, shift.dx, shift.dy)), 'Déplacement non enregistré');
}

function dragHandle(gesture, event) {
  const end = pointAt(event);
  const points = [...gesture.item.points];
  points.splice(gesture.index * 2, 2, end.x, end.y);
  gesture.points = points;
  gesture.node.points(points);
  placeHandles(points);
  session.layer.batchDraw();
}

function dropHandle(gesture, event) {
  dragHandle(gesture, event);
  const { item, points } = gesture;
  // Les deux extrémités confondues ne font plus une flèche.
  if (isEmpty({ points })) {
    restore(item);
    return;
  }
  queueEdit(() => editItem(item.id, (current) => ({ ...current, points })), 'Déplacement non enregistré');
}

// Déplacement (dx, dy) ramené pour que l'annotation, d'emprise `box`, reste entière dans la capture.
function boundedShift(box, dx, dy) {
  const { record } = session;
  return { dx: clamp(dx, -box.x, record.width - box.x - box.width), dy: clamp(dy, -box.y, record.height - box.y - box.height) };
}

// Emprise d'une annotation dans la capture : celle de ses points ou de son rectangle ; pour un texte ou une pastille, son encombrement.
function extentOf(item) {
  if (item.points) return pointsExtent(item.points);
  return 'width' in item ? item : itemBounds(item, session.record.scale);
}

function pointsExtent(points) {
  let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i += 2) {
    left = Math.min(left, points[i]);
    right = Math.max(right, points[i]);
    top = Math.min(top, points[i + 1]);
    bottom = Math.max(bottom, points[i + 1]);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function shifted(item, dx, dy) {
  if (item.points) return { ...item, points: item.points.map((value, i) => value + (i % 2 ? dy : dx)) };
  return { ...item, x: item.x + dx, y: item.y + dy };
}

// Les coins tirés s'arrêtent aux bords de la capture (le cadre travaille en pixels de la scène, d'où la conversion).
function keepBoxInside(before, after) {
  const { record, layer } = session;
  const transform = layer.getAbsoluteTransform();
  const low = transform.point({ x: 0, y: 0 });
  const high = transform.point({ x: record.width, y: record.height });
  const left = Math.max(after.x, low.x);
  const top = Math.max(after.y, low.y);
  const right = Math.min(after.x + after.width, high.x);
  const bottom = Math.min(after.y + after.height, high.y);
  return right - left < 1 || bottom - top < 1 ? before : { ...after, x: left, y: top, width: right - left, height: bottom - top };
}

// Konva étire le nœud (échelle) : on reporte l'étirement sur sa largeur et sa hauteur, le nœud reste à l'échelle 1.
function foldScale(frame) {
  const [node] = frame.nodes();
  node.setAttrs({ width: node.width() * node.scaleX(), height: node.height() * node.scaleY(), scaleX: 1, scaleY: 1 });
}

// Au lâcher d'un coin. Konva le signale aussi quand l'éditeur se ferme en plein tirage : le cadre n'entoure alors plus rien.
function finishResize(frame) {
  const [node] = frame.nodes();
  if (!node) return;
  const box = { x: node.x(), y: node.y(), width: node.width(), height: node.height() };
  const id = session.selection;
  queueEdit(() => editItem(id, (item) => ({ ...item, ...box })), 'Redimensionnement non enregistré');
}

// Un tracé sans étendue n'est rien : rectangle, surligneur ou masque sans épaisseur (glisser tout droit), flèche ou crayon dont
// tous les points sont confondus (un geste fait dans la marge grise, ramené sur un même point du bord).
function isEmpty(item) {
  if ('width' in item) return !(item.width >= 1 && item.height >= 1);
  const { points } = item;
  const [xs, ys] = [0, 1].map((offset) => points.filter((_, i) => i % 2 === offset));
  const spread = (values) => values.reduce((most, v) => Math.max(most, Math.abs(v - values[0])), 0);
  return spread(xs) < 1 && spread(ys) < 1;
}

// L'annotation que dessine le tracé en cours : géométrie selon l'outil, depuis le point de départ jusqu'au pointeur.
function draftItem({ base, start, end, points }) {
  if (base.type === 'arrow') return { ...base, points: [start.x, start.y, end.x, end.y] };
  if (base.type === 'pen') return { ...base, points: [...points, end.x, end.y] };
  const box = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
  return base.type === 'mask' ? { ...base, ...box, fill: NEUTRAL_FILL } : { ...base, ...box };
}

// Remplace l'aperçu du tracé par celui de la position actuelle du pointeur.
function showDraft(draft) {
  const item = draftItem(draft);
  draft.node?.destroy();
  draft.node = createNode(item, session.record.scale);
  (item.type === 'mask' ? session.masks : session.shapes).add(draft.node);
  session.layer.batchDraw();
}

// Pose, d'un clic, une pastille ou le champ de saisie d'un texte.
function placeAt({ base, start }) {
  const item = { ...base, x: start.x, y: start.y };
  if (item.type === 'badge') queueCreation(keepInside(item));
  else openTextField(item);
}

// Ramène dans la capture une annotation posée par un point (texte, pastille) dont l'encombrement déborderait.
function keepInside(item) {
  const { record } = session;
  const box = itemBounds(item, record.scale);
  const shift = (start, size, limit) => Math.max(-start, Math.min(0, limit - start - size));
  return { ...item, x: item.x + shift(box.x, box.width, record.width), y: item.y + shift(box.y, box.height, record.height) };
}

// ---- Sélection ----

// L'annotation sélectionnée, si elle est dessinée.
const selectedItem = () => session.items.find((item) => item.id === session.selection && session.nodes.has(item.id));

function select(id) {
  if (session.selection === id) return;
  session.selection = id;
  showSelection();
}

// Entoure l'annotation sélectionnée : un cadre à quatre coins pour un rectangle, un surligneur ou un masque, un simple liseré pour
// les autres formes, une poignée à chaque extrémité pour une flèche. La barre d'outils montre ses couleur et taille.
function showSelection() {
  const { frame } = session;
  const item = selectedItem();
  if (!item) session.selection = null;
  const arrow = item?.type === 'arrow';
  frame.nodes(item && !arrow ? [session.nodes.get(item.id)] : []);
  frame.resizeEnabled(RESIZABLE.includes(item?.type));
  placeHandles(arrow ? item.points : null);
  showChoices();
  session.layer.batchDraw();
}

// Pose les poignées sur les extrémités d'une flèche (`points`), ou les cache.
function placeHandles(points) {
  const { handles } = session;
  handles.visible(points !== null);
  if (points) handles.getChildren().forEach((handle, i) => handle.position({ x: points[2 * i], y: points[2 * i + 1] }));
}

// ---- Modifications des annotations ----

// Les modifications (création, déplacement, couleur, annulation…) s'exécutent l'une après l'autre, dans l'ordre des gestes :
// un masque attend la lecture de son liseré. `failure` dit ce qui n'a pas été fait si l'une échoue.
function queueEdit(task, failure) {
  const current = session;
  current.pending++;
  current.queue = current.queue
    .then(task)
    .catch((err) => console.error(`${failure} : ${err.message}`))
    .finally(() => current.pending--);
}

// `preview` est le nœud provisoire du tracé, retiré quand l'annotation est en place.
function queueCreation(item, preview) {
  queueEdit(() => addItem(item, preview), 'Annotation non ajoutée');
}

// Remplace la liste des annotations. L'ancienne rejoint l'historique de « Annuler », celui de « Rétablir » est vidé, et la page
// est prévenue pour enregistrer.
function commit(items) {
  const { undoStack, redoStack } = session;
  undoStack.push(session.items);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
  session.items = items;
  session.onChange(items);
  showHistory();
}

async function addItem(draft, preview) {
  const before = session.items;
  const added = [...before, draft];
  const items = draft.type === 'mask' ? await retinted(added) : added;
  commit(items);
  preview?.destroy();
  addNode(items.at(-1));
  refreshChanged(before, items);
  session.layer.batchDraw();
}

// Remplace l'annotation `id` par ce que donne `edit` sur sa version actuelle (un masque relit son liseré, et ses voisins le leur),
// puis la redessine. Rien n'est enregistré si rien ne change.
async function editItem(id, edit) {
  const before = session.items;
  const old = before.find((item) => item.id === id);
  if (!old) return;
  const changed = edit(old);
  const replaced = before.map((current) => (current.id === id ? changed : current));
  const items = changed.type === 'mask' ? await retinted(replaced) : replaced;
  if (JSON.stringify(items) !== JSON.stringify(before)) commit(items);
  refreshNode(items.find((item) => item.id === id));
  refreshChanged(before, items.filter((item) => item.id !== id));
  showSelection();
}

// Redessine les annotations déjà affichées qui ont changé depuis `before` (un masque voisin a pu changer de teinte).
function refreshChanged(before, items) {
  const old = new Map(before.map((item) => [item.id, JSON.stringify(item)]));
  for (const item of items) {
    const was = old.get(item.id);
    if (was !== undefined && was !== JSON.stringify(item) && session.nodes.has(item.id)) refreshNode(item);
  }
}

// Remplace la liste par `items` et redessine tout (retrait, effacement : les pastilles se renumérotent).
function replaceAll(items) {
  commit(items);
  redraw();
}

function removeSelection() {
  const id = session.selection;
  if (id === null) return;
  select(null);
  queueEdit(() => replaceAll(session.items.filter((item) => item.id !== id)), 'Suppression non enregistrée');
}

function clearAll() {
  if (!confirm(CLEAR_QUESTION)) return;
  select(null);
  queueEdit(() => replaceAll([]), 'Effacement non enregistré');
}

const undo = () => travel(session.undoStack, session.redoStack);
const redo = () => travel(session.redoStack, session.undoStack);

// Passe à la liste du dessus de `from` ; la liste en cours est gardée dans `to`.
function travel(from, to) {
  queueEdit(() => {
    if (!from.length) return;
    to.push(session.items);
    session.items = from.pop();
    session.onChange(session.items);
    redraw();
    showHistory();
  }, 'Historique non appliqué');
}

// Un masque est arrondi au pixel et prend la teinte de son liseré. Le contenu caché n'est jamais lu : ni le sien, ni celui des
// autres masques (`others`, déjà arrondis), qui peuvent couvrir une partie de son liseré.
async function tintedMask(mask, others) {
  const box = { ...mask, ...maskRect(mask) };
  try {
    return { ...box, fill: await session.stitcher.averageRing(box, others) };
  } catch (err) {
    console.error(`Liseré du masque illisible : ${err.message}`);
    return { ...box, fill: NEUTRAL_FILL };
  }
}

// Les masques de la liste, arrondis et reteintés chacun d'après les autres : un masque ajouté, déplacé ou agrandi peut couvrir le
// liseré d'un voisin. La teinte d'un masque ne dépend ainsi que des places de tous les masques, jamais de ce qu'ils cachent.
async function retinted(items) {
  const masks = items.filter((item) => item.type === 'mask').map((mask) => ({ ...mask, ...maskRect(mask) }));
  const tinted = new Map();
  for (const mask of masks) tinted.set(mask.id, await tintedMask(mask, masks.filter((other) => other !== mask)));
  return items.map((item) => tinted.get(item.id) ?? item);
}

function addNode(item) {
  const node = nodeFor(item, badgeNumbers(session.items).get(item.id));
  (item.type === 'mask' ? session.masks : session.shapes).add(node);
  session.nodes.set(item.id, node);
}

// Redessine une annotation à la place de son ancien nœud, au même rang (donc au même niveau de superposition).
function refreshNode(item) {
  const { nodes, frame } = session;
  frame.nodes([]);
  const old = nodes.get(item.id);
  const parent = old.getParent();
  const index = old.zIndex();
  old.destroy();
  const node = nodeFor(item, badgeNumbers(session.items).get(item.id));
  parent.add(node);
  node.zIndex(index);
  nodes.set(item.id, node);
}

// Redessine toutes les annotations d'après la liste en cours.
function redraw() {
  session.frame.nodes([]);
  session.masks.destroyChildren();
  session.shapes.destroyChildren();
  fillGroups();
  showSelection();
}

// ---- Saisie d'un texte ----

// Un double-clic sur un texte rouvre sa saisie, à sa place : le texte dessiné s'efface le temps de la modification.
function onDoubleClick(event) {
  if (session.textEdit) return;
  const { id } = hitAt(event);
  const item = session.items.find((current) => current.id === id);
  if (item?.type !== 'text') return;
  select(null);
  session.nodes.get(id).hide();
  session.layer.batchDraw();
  openTextField(item);
}

// Pose un champ de saisie sur le texte à créer (ou à modifier : `item` porte alors déjà son texte), à la même place et à la même
// taille que le texte dessiné.
function openTextField(item) {
  const field = document.createElement('textarea');
  field.className = 'editor-text';
  field.wrap = 'off';
  field.rows = 1;
  field.spellcheck = false;
  field.setAttribute('aria-label', 'Texte de l’annotation');
  field.value = item.text ?? '';
  // Un texte vide fournit la police, la taille, l'interligne et le liseré du texte dessiné : on lit le texte comme il sera exporté,
  // sur la capture (blanche ou non), quel que soit le thème de l'éditeur.
  const sample = createNode({ ...item, text: '' }, session.record.scale);
  field.style.fontFamily = sample.fontFamily();
  field.style.lineHeight = String(sample.lineHeight());
  field.style.color = COLORS[item.color].hex;
  field.style.setProperty('--halo', sample.stroke());
  field.style.setProperty('--halo-width', `${sample.strokeWidth() / sample.fontSize()}em`);
  const edit = { item, field, fontSize: sample.fontSize(), at: item };
  session.textEdit = edit;
  sample.destroy();

  // Le champ se place là où sera le texte validé : un texte qui atteint le bord de la capture est poussé vers l'intérieur pendant
  // la frappe, et ne saute pas à la validation.
  field.addEventListener('input', () => {
    edit.at = keepInside({ ...item, text: field.value.trim() });
    placeField();
  });
  field.addEventListener('keydown', onFieldKeydown);
  field.addEventListener('blur', commitText);
  // Un clic dans le champ place le curseur : il ne doit pas atteindre la scène, qui validerait le texte.
  field.addEventListener('pointerdown', (event) => event.stopPropagation());
  els.stage.append(field);
  placeField();
  field.focus({ preventScroll: true });
}

// Suit le défilement et l'échelle d'affichage.
function placeField() {
  const edit = session.textEdit;
  if (!edit) return;
  const { view, offset } = session;
  const left = offset + edit.at.x * view;
  const top = edit.at.y * view - els.scroll.scrollTop;
  const { style } = edit.field;
  style.left = `${left}px`;
  style.top = `${top}px`;
  style.fontSize = `${edit.fontSize * view}px`;
  // Le champ ne sort pas de la zone visible : un texte long fait défiler le curseur dans le champ, jamais la scène qui le porte.
  style.maxWidth = `${Math.max(0, els.scroll.clientWidth - left)}px`;
  style.maxHeight = `${Math.max(0, els.scroll.clientHeight - top)}px`;
}

// Valide le texte en cours de saisie ; sans effet s'il n'y en a pas. Un texte neuf et vide est abandonné.
function commitText() {
  const edit = session?.textEdit;
  if (!edit) return;
  session.textEdit = null;
  const text = edit.field.value.trim();
  edit.field.remove();
  if ('text' in edit.item) queueEdit(() => rewriteText(edit.item.id, text), 'Texte non modifié');
  else if (text) queueCreation(keepInside({ ...edit.item, text }));
}

// Un texte modifié garde son id et sa place dans l'ordre ; un texte vidé disparaît ; un texte inchangé reparaît tel quel.
function rewriteText(id, text) {
  if (!text) return replaceAll(session.items.filter((item) => item.id !== id));
  return editItem(id, (item) => keepInside({ ...item, text }));
}

// Pendant la saisie, aucune touche ne change d'outil, ne copie l'image ni ne ferme l'éditeur : Échap et ⌘↩ valident le texte.
function onFieldKeydown(event) {
  event.stopPropagation();
  if (event.isComposing) return;
  if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
    event.preventDefault();
    commitText();
  }
}

// Quitter la page pendant une saisie ou pendant la création d'une annotation (un masque lit son liseré) : le texte est validé,
// et la confirmation de départ laisse le temps de créer puis d'écrire l'annotation. Ensuite, la page de résultats prend le relais
// tant que l'écriture n'est pas finie.
function onBeforeUnload(event) {
  commitText();
  if (session.pending > 0) event.preventDefault();
}

// ---- Copie de l'image en cours de lecture ----

// Même règle que `updateCurrent` de la page de résultats : la dernière image dont le haut a passé le premier tiers
// de la zone visible, et la dernière image quand on est tout en bas.
function readingPart() {
  const { parts, view } = session;
  const { scrollTop, clientHeight, scrollHeight } = els.scroll;
  const probe = (scrollTop + clientHeight / 3) / view;
  let index = 0;
  parts.forEach((part, i) => {
    if (part.top <= probe) index = i;
  });
  const atBottom = scrollHeight > clientHeight && scrollHeight - scrollTop - clientHeight < 2;
  return atBottom ? parts.length - 1 : index;
}

function updateCopyLabel() {
  const label = session.parts.length > 1 ? `Copier l’image ${readingPart() + 1}` : 'Copier l’image';
  if (els.copy.textContent !== label) els.copy.textContent = label;
}

function copyReadingPart() {
  session.onCopy(readingPart());
}
