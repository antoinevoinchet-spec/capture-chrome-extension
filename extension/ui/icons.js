// Pictogrammes du design system : un seul jeu, trait de 1,5 sur une grille de 16, couleur du texte (currentColor).
// Dessinés pour le projet à partir de la maquette docs/design-system/2026-11-18-accents-direction-c.html.
// Les formes pleines portent la classe « fill » (remplies, sans trait).

const SVG_NS = 'http://www.w3.org/2000/svg';

const DRAWINGS = {
  // Modes de capture
  full: '<rect x="3.5" y="1.5" width="9" height="13" rx="1.5"/><path d="M6 5h4M6 8h4M6 11h2.5"/>',
  visible: '<rect x="1.5" y="3" width="13" height="10" rx="1.5"/><path d="M1.5 6h13"/>',
  block: '<rect x="2" y="2" width="12" height="12" rx="1.5" stroke-dasharray="2 2"/><rect class="fill" x="5" y="5" width="6" height="6" rx="1"/>',
  zone: '<path d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3M6 8h4M8 6v4"/>',
  devices: '<rect x="1.5" y="3" width="9" height="7" rx="1"/><rect x="10.5" y="6" width="4" height="7.5" rx="1"/><path d="M3.5 12.5h5"/>',
  transcript: '<path d="M2.5 4h11M2.5 8h11M2.5 12h6"/>',
  convert: '<path d="M2.5 5.5h10L10 3M13.5 10.5h-10L6 13"/>',
  history: '<circle cx="8" cy="8" r="6"/><path d="M8 5v3.2l2 1.3"/>',

  // Interface
  chevron: '<path d="M6 3.5 10.5 8 6 12.5"/>',
  more: '<circle class="fill" cx="3.5" cy="8" r="1.25"/><circle class="fill" cx="8" cy="8" r="1.25"/><circle class="fill" cx="12.5" cy="8" r="1.25"/>',
  download: '<path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M2.5 13.5h11"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2"/>',
  annotate: '<path d="M10.5 2.5l3 3-8 8h-3v-3zM9 4l3 3"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  error: '<circle cx="8" cy="8" r="6.25"/><path d="M8 4.75v3.75"/><circle class="fill" cx="8" cy="11" r="1"/>',
  info: '<circle cx="8" cy="8" r="6.25"/><path d="M8 7.25v4"/><circle class="fill" cx="8" cy="5" r="1"/>',
  check: '<path d="M3 8.5l3 3 7-7"/>',
  keyboard: '<rect x="1.5" y="4" width="13" height="8" rx="1.5"/><path d="M4.5 7h0M7 7h0M9.5 7h0M12 7h0M5.5 9.5h5"/>',

  // Outils de l'éditeur
  arrow: '<path d="M3.5 12.5l9-9M6 3.5h6.5V10"/>',
  rect: '<rect x="2.5" y="3.5" width="11" height="9" rx="1"/>',
  highlight: '<path d="M9.5 2.5l4 4-6 6h-4v-4zM2 14.5h6"/>',
  text: '<path d="M3 3.5h10M8 3.5V13"/>',
  counter: '<circle cx="8" cy="8" r="6.25"/><path d="M6.75 6 8.25 5v6"/>',
  mask: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path class="fill" d="M2.5 4A1.5 1.5 0 0 1 4 2.5h4V8H2.5zM8 8h5.5v4a1.5 1.5 0 0 1-1.5 1.5H8z"/>',
  pen: '<path d="M2.5 12.5c2-4 3.5-1.5 5.5-4s3-5 5.5-5.5"/>',
  trim: '<path d="M4.5 1.5v10h10M1.5 4.5h10v10"/>',
  undo: '<path d="M5.5 3.5l-3 3 3 3M2.5 6.5h7a3.5 3.5 0 0 1 0 7H7"/>',
  redo: '<path d="M10.5 3.5l3 3-3 3M13.5 6.5h-7a3.5 3.5 0 0 0 0 7H9"/>',
  trash: '<path d="M2.5 4.5h11M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M4 4.5l.7 8.6a1.5 1.5 0 0 0 1.5 1.4h3.6a1.5 1.5 0 0 0 1.5-1.4l.7-8.6"/>',
  back: '<path d="M13 8H3M7 4 3 8l4 4"/>',

  // Page des captures
  scissors: '<circle cx="4" cy="4" r="2"/><circle cx="4" cy="12" r="2"/><path d="M13.5 2.5 5.5 10.5M10 10l3.5 3.5M5.5 5.5 8 8"/>',
};

export const ICON_NAMES = Object.keys(DRAWINGS);

// Rend un pictogramme prêt à insérer. Décoratif par défaut (aria-hidden) : le nom accessible vient du bouton qui le porte.
export function icon(name, size = 16) {
  const drawing = DRAWINGS[name];
  if (!drawing) throw new Error(`pictogramme inconnu : ${name}`);
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [key, value] of Object.entries({
    class: `icon icon-${name}`,
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.5',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  })) {
    svg.setAttribute(key, String(value));
  }
  svg.innerHTML = drawing;
  for (const shape of svg.querySelectorAll('.fill')) {
    shape.setAttribute('fill', 'currentColor');
    shape.setAttribute('stroke', 'none');
  }
  return svg;
}

// Remplace chaque <span data-icon="nom"> (taille facultative data-size) par son pictogramme.
export function fillIcons(root = document) {
  for (const holder of root.querySelectorAll('[data-icon]')) {
    const svg = icon(holder.dataset.icon, Number(holder.dataset.size) || 16);
    if (holder.className) svg.classList.add(...holder.classList);
    holder.replaceWith(svg);
  }
}

// Le logo des en-têtes : le même dessin que icons/icon.svg, liseré compris (il détache le carré d'un fond sombre).
const LOGO =
  // hors tokens : le logo est une image fixe (couleurs de l'icône de l'extension), pas une couleur d'interface.
  '<rect x="0.375" y="0.375" width="31.25" height="31.25" rx="7.6" fill="#1d1d1f" stroke="#4d4d50" stroke-width="0.75"/>' +
  '<path d="M9 16V9h7M23 16v7h-7" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>' + // hors tokens : logo
  '<circle cx="21.5" cy="10.5" r="2.6" fill="#e08a62"/>'; // hors tokens : logo

export function logo(size = 24) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [key, value] of Object.entries({ class: 'logo', width: size, height: size, viewBox: '0 0 32 32', 'aria-hidden': 'true', focusable: 'false' })) {
    svg.setAttribute(key, String(value));
  }
  svg.innerHTML = LOGO;
  return svg;
}
