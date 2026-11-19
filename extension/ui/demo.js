import { ICON_NAMES, fillIcons, icon } from './icons.js';

fillIcons();

const grid = document.getElementById('icons');
for (const name of ICON_NAMES) {
  const figure = document.createElement('figure');
  figure.dataset.name = name;
  const caption = document.createElement('figcaption');
  caption.textContent = name;
  figure.append(icon(name, 20), caption);
  grid.append(figure);
}

document.body.dataset.ready = 'true';
