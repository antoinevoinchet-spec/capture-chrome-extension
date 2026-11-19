// Formes des annotations : constantes de l'interface et fabrication des nœuds Konva.
// Konva est chargé par la page (balise <script>) : on y accède par le global `Konva`.
// Toutes les coordonnées sont en pixels réels de la capture ; les tailles (en points) sont multipliées par l'échelle.

export const COLORS = {
  red: { label: 'Rouge', hex: '#e03131' },
  yellow: { label: 'Jaune', hex: '#f4c542' },
  green: { label: 'Vert', hex: '#2f9e44' },
  blue: { label: 'Bleu', hex: '#1971c2' },
  black: { label: 'Noir', hex: '#15211d' },
};

// stroke : épaisseur des traits ; font : taille du texte ; badge : diamètre des pastilles.
export const SIZES = {
  s: { label: 'Petit', stroke: 2, font: 16, badge: 22 },
  m: { label: 'Moyen', stroke: 4, font: 24, badge: 30 },
  l: { label: 'Grand', stroke: 7, font: 36, badge: 40 },
};

export const TOOLS = [
  { key: 'arrow', label: 'Flèche', shortcut: 'F' },
  { key: 'rect', label: 'Rectangle', shortcut: 'R' },
  { key: 'highlight', label: 'Surligneur', shortcut: 'S' },
  { key: 'text', label: 'Texte', shortcut: 'T' },
  { key: 'badge', label: 'Pastille numérotée', shortcut: 'N' },
  { key: 'mask', label: 'Masquer', shortcut: 'M' },
  { key: 'pen', label: 'Crayon', shortcut: 'C' },
];

const INK = COLORS.black.hex;
const FONT = 'system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif';
const HIGHLIGHT_OPACITY = 0.4;
// Les tracés se saisissent à l'écran sur une zone au moins aussi large que 12 points.
const HIT_POINTS = 12;
// Écarts (en %) des cinq nuances du motif de masquage par rapport à la teinte de base. Ils vont dans un seul sens :
// vers le noir sur une teinte claire, vers le blanc sur une teinte sombre (le blanc ne s'éclaircit pas).
const MASK_STEPS = [0, 4, 8, 12, 16];

// Côté d'un bloc de masquage, en pixels de la capture.
export const MASK_BLOCK = (scale) => Math.max(16, Math.round(10 * scale));

// Numéro de chaque pastille (1, 2, 3…) dans l'ordre de création ; ne dépend pas de ce qui est affiché.
export function badgeNumbers(items) {
  const numbers = new Map();
  for (const item of items) if (item?.type === 'badge') numbers.set(item.id, numbers.size + 1);
  return numbers;
}

// Nœud Konva d'une annotation, nommé par son id. `badgeNumber` ne sert qu'aux pastilles.
export function createNode(item, scale, badgeNumber = 1) {
  const node = BUILDERS[item.type](item, scale, badgeNumber);
  node.name(item.id);
  return node;
}

// Encombrement réel d'une annotation (trait compris), en pixels de la capture.
export function itemBounds(item, scale) {
  if (item.type === 'arrow') return arrowBounds(item, scale);
  const node = createNode(item, scale);
  const box = node.getClientRect();
  node.destroy();
  return box;
}

// Les annotations exploitables, chacune avec son encombrement. Un enregistrement abîmé (type inconnu, champ manquant,
// valeur nulle) est sauté avec un avertissement : une seule annotation ne doit pas empêcher d'ouvrir ni d'exporter la capture.
export function measureItems(items, scale) {
  const measured = [];
  for (const item of items) {
    try {
      createNode(item, scale).destroy();
      const box = itemBounds(item, scale);
      if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) throw new Error('encombrement non numérique');
      measured.push({ item, box });
    } catch (err) {
      console.warn(`Annotation ignorée (${item?.id ?? 'sans identifiant'}) : ${err.message}`);
    }
  }
  return measured;
}

const strokeOf = (item, scale) => SIZES[item.size].stroke * scale;
const hexOf = (item) => COLORS[item.color].hex;
const hitStrokeOf = (stroke, scale) => Math.max(stroke, HIT_POINTS * scale);
// Liseré du texte et couleur des chiffres : blanc, sauf sur le jaune où l'encre reste lisible.
const contrastOf = (item) => (item.color === 'yellow' ? INK : '#ffffff');

// Longueur et largeur de la pointe d'une flèche.
const headOf = (stroke, scale) => Math.max(4 * stroke, 10 * scale);

function arrow(item, scale) {
  const stroke = strokeOf(item, scale);
  const head = headOf(stroke, scale);
  return new Konva.Arrow({
    points: item.points,
    stroke: hexOf(item),
    fill: hexOf(item),
    strokeWidth: stroke,
    pointerLength: head,
    pointerWidth: head,
    lineCap: 'round',
    lineJoin: 'round',
    hitStrokeWidth: hitStrokeOf(stroke, scale),
  });
}

// Konva sous-estime la pointe d'une flèche qui n'est pas horizontale : on calcule ses deux coins.
function arrowBounds(item, scale) {
  const stroke = strokeOf(item, scale);
  const head = headOf(stroke, scale);
  const [x1, y1, x2, y2] = item.points;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const corners = [-1, 1].map((side) => [
    x2 - head * Math.cos(angle) - (side * head * Math.sin(angle)) / 2,
    y2 - head * Math.sin(angle) + (side * head * Math.cos(angle)) / 2,
  ]);
  const xs = [x1, x2, ...corners.map(([x]) => x)];
  const ys = [y1, y2, ...corners.map(([, y]) => y)];
  const left = Math.min(...xs) - stroke / 2;
  const top = Math.min(...ys) - stroke / 2;
  return { x: left, y: top, width: Math.max(...xs) + stroke / 2 - left, height: Math.max(...ys) + stroke / 2 - top };
}

function rect(item, scale) {
  const stroke = strokeOf(item, scale);
  return new Konva.Rect({
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height,
    stroke: hexOf(item),
    strokeWidth: stroke,
    hitStrokeWidth: hitStrokeOf(stroke, scale),
  });
}

function highlight(item) {
  return new Konva.Rect({ x: item.x, y: item.y, width: item.width, height: item.height, fill: hexOf(item), opacity: HIGHLIGHT_OPACITY });
}

function text(item, scale) {
  const fontSize = SIZES[item.size].font * scale;
  return new Konva.Text({
    x: item.x,
    y: item.y,
    text: item.text,
    fontSize,
    fontFamily: FONT,
    fontStyle: 'bold',
    lineHeight: 1.2,
    fill: hexOf(item),
    stroke: contrastOf(item),
    strokeWidth: 0.18 * fontSize,
    fillAfterStrokeEnabled: true,
    lineJoin: 'round',
  });
}

// Disque de la couleur choisie avec son numéro centré ; (x, y) est le centre.
function badge(item, scale, number) {
  const radius = (SIZES[item.size].badge * scale) / 2;
  const group = new Konva.Group({ x: item.x, y: item.y });
  group.add(
    new Konva.Circle({ radius, fill: hexOf(item) }),
    new Konva.Text({
      x: -radius,
      y: -radius,
      width: 2 * radius,
      height: 2 * radius,
      text: String(number),
      fontSize: radius * (number > 9 ? 0.9 : 1.1),
      fontFamily: FONT,
      fontStyle: 'bold',
      align: 'center',
      verticalAlign: 'middle',
      fill: contrastOf(item),
    }),
  );
  return group;
}

function pen(item, scale) {
  const stroke = strokeOf(item, scale);
  return new Konva.Line({
    points: item.points,
    stroke: hexOf(item),
    strokeWidth: stroke,
    lineCap: 'round',
    lineJoin: 'round',
    tension: 0.3,
    hitStrokeWidth: hitStrokeOf(stroke, scale),
  });
}

// Rectangle d'un masque arrondi vers l'extérieur : bords nets, quelles que soient les coordonnées enregistrées. Une largeur ou une
// hauteur négative (enregistrement abîmé) couvre la même zone que sa valeur positive.
export function maskRect({ x, y, width, height }) {
  const left = Math.floor(Math.min(x, x + width));
  const top = Math.floor(Math.min(y, y + height));
  return { x: left, y: top, width: Math.ceil(Math.max(x, x + width)) - left, height: Math.ceil(Math.max(y, y + height)) - top };
}

const channelsOf = (hex) => [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
// Teinte de base d'un masque dont la teinte enregistrée manque ou est illisible : il est peint quand même.
const MASK_FALLBACK = '#808080';

// Teinte éclaircie (percent > 0) ou assombrie (percent < 0) de `hex`.
function shade(hex, percent) {
  const mixed = channelsOf(hex).map((c) => Math.round(percent > 0 ? c + ((255 - c) * percent) / 100 : (c * (100 + percent)) / 100));
  return `rgb(${mixed.join(',')})`;
}

// Les cinq nuances d'une teinte de base : assombries si elle est claire, éclaircies si elle est sombre.
function maskTones(fill) {
  const [r, g, b] = channelsOf(fill);
  const direction = 0.2126 * r + 0.7152 * g + 0.0722 * b > 127.5 ? -1 : 1;
  return MASK_STEPS.map((step) => shade(fill, direction * step));
}

// Mosaïque de gros blocs unis : teinte de base (`fill`) et motif de nuances fixe, jamais le contenu caché.
// Les blocs tombent sur des pixels entiers ; ceux du bord droit et du bas sont rognés au bord du masque.
// Un fond uni est peint d'abord : à l'écran, l'éditeur réduit le dessin à une échelle non entière, et les joints entre
// blocs, lissés sur le calque transparent, laisseraient voir la capture. À l'export les blocs recouvrent ce fond exactement.
function mask(item, scale) {
  const block = MASK_BLOCK(scale);
  const tones = maskTones(/^#[0-9a-f]{6}$/i.test(item.fill) ? item.fill : MASK_FALLBACK);
  return new Konva.Shape({
    ...maskRect(item),
    sceneFunc(ctx, shape) {
      const width = shape.width();
      const height = shape.height();
      ctx.fillStyle = tones[0];
      ctx.fillRect(0, 0, width, height);
      for (let j = 0, y = 0; y < height; j++, y += block) {
        for (let i = 0, x = 0; x < width; i++, x += block) {
          ctx.fillStyle = tones[(i * 7 + j * 13) % tones.length];
          ctx.fillRect(x, y, Math.min(block, width - x), Math.min(block, height - y));
        }
      }
    },
    hitFunc(ctx, shape) {
      ctx.beginPath();
      ctx.rect(0, 0, shape.width(), shape.height());
      ctx.closePath();
      ctx.fillStrokeShape(shape);
    },
  });
}

const BUILDERS = { arrow, rect, highlight, text, badge, mask, pen };
