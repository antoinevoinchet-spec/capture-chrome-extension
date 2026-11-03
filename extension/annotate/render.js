// Rendu des annotations sur un canvas 2D (exports et aperçus) et zones que les coupes doivent éviter.
// Même moteur que l'éditeur (Konva), mais hors écran et par bandes : la mémoire reste bornée sur une capture très haute.

import { badgeNumbers, createNode, maskRect, measureItems } from './shapes.js';

// Hauteur maximale d'une bande dessinée d'un coup, en pixels de la capture.
const BAND_PX = 4096;
// Un aperçu réduit se dessine d'une seule bande tant que celle-ci ne dépasse pas la plus grande partie exportée (MAX_PART_PX).
const PREVIEW_BAND_MAX_PX = 16000;
// Marge ajoutée autour des annotations pour la bande d'un aperçu, en pixels : pointes d'angle d'un trait, anticrénelage.
const PREVIEW_MARGIN_PX = 16;
// Marge autour d'une annotation que les coupes évitent, en points.
const AVOID_MARGIN_POINTS = 8;

// Dessine sur ctx les masques, puis les autres annotations dans l'ordre de création.
// ctx est déjà positionné en (0, 0) = point (`left`, `top`) de la capture, à l'échelle `ratio` ; seule la part
// [top, top + height) est dessinée. Avec un cadrage, ce qui dépasse du canvas est coupé à son bord, et une annotation hors cadre n'y touche rien.
export function drawAnnotations(ctx, items, scale, top, height, ratio = 1, left = 0) {
  const bottom = top + height;
  const width = Math.round(ctx.canvas.width / ratio);
  const numbers = badgeNumbers(items);
  // Réduit, un masque déborde de deux pixels d'aperçu de chaque côté : un pixel d'aperçu à cheval sur son bord, ou que le lissage
  // de la réduction fait déborder, mêlerait sinon un peu du contenu caché à la capture autour. Un export (ratio 1) est exact.
  const pad = ratio < 1 ? 2 * Math.ceil(1 / ratio) : 0;
  const drawn = pad ? items.map((item) => (item?.type === 'mask' ? grown(item, pad) : item)) : items;
  const shown = measureItems(drawn, scale).filter(({ box }) => overlaps(box, top, bottom));
  if (!shown.length) return;

  // Un export se dessine par bandes de BAND_PX sur toute la part. Un aperçu réduit (ratio < 1) se dessine d'une seule bande,
  // limitée à la hauteur des annotations : réduite, une bande dont les bords tombent entre deux pixels d'aperçu y laisse une
  // ligne claire, qui ne doit donc traverser aucune annotation.
  const preview = ratio < 1;
  const from = preview ? Math.max(top, Math.floor(Math.min(...shown.map(({ box }) => box.y))) - PREVIEW_MARGIN_PX) : top;
  const to = preview ? Math.min(bottom, Math.ceil(Math.max(...shown.map(({ box }) => box.y + box.height))) + PREVIEW_MARGIN_PX) : bottom;
  const bandPx = preview && to - from <= PREVIEW_BAND_MAX_PX ? to - from : BAND_PX;
  for (let bandTop = from; bandTop < to; bandTop += bandPx) {
    const bandHeight = Math.min(bandPx, to - bandTop);
    const inBand = shown.filter(({ box }) => overlaps(box, bandTop, bandTop + bandHeight)).map(({ item }) => item);
    if (inBand.length) drawBand(ctx, inBand, numbers, scale, { width, left, top, bandTop, bandHeight });
  }
}

// Une bande : les nœuds sont posés sur un groupe décalé de (-left, -bandTop), puis exportés depuis (0, 0) à l'échelle 1.
// Exporter avec un `y` élevé ferait allouer à Konva un tampon de hauteur `y + height`. Exporter à l'échelle d'un aperçu
// peindrait les blocs d'un masque sur des pixels fractionnaires : leurs bords deviendraient translucides et laisseraient
// voir la capture. À l'échelle 1 les bords tombent sur des pixels entiers ; c'est `drawImage` qui réduit ensuite la bande.
function drawBand(ctx, items, numbers, scale, { width, left, top, bandTop, bandHeight }) {
  const masks = new Konva.Group();
  const shapes = new Konva.Group();
  const scene = new Konva.Group({ x: -left, y: -bandTop });
  scene.add(masks, shapes);
  try {
    for (const item of items) (item.type === 'mask' ? masks : shapes).add(createNode(item, scale, numbers.get(item.id)));
    const band = scene.toCanvas({ x: 0, y: 0, width, height: bandHeight, pixelRatio: 1 });
    ctx.drawImage(band, 0, bandTop - top, width, bandHeight);
    band.width = band.height = 0;
  } finally {
    scene.destroy();
  }
}

const overlaps = (box, from, to) => box.y < to && box.y + box.height > from;

function grown(mask, pad) {
  const { x, y, width, height } = maskRect(mask);
  return { ...mask, x: x - pad, y: y - pad, width: width + 2 * pad, height: height + 2 * pad };
}

// Encombrement vertical de chaque annotation, élargi d'une marge : [haut, bas] en pixels de la capture.
export function avoidRanges(items, scale) {
  const margin = AVOID_MARGIN_POINTS * scale;
  return measureItems(items, scale).map(({ box }) => [box.y - margin, box.y + box.height + margin]);
}
