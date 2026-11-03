// Recolle les tranches capturées et découpe l'image finale en plusieurs parties,
// sans jamais réduire la résolution.

// Plafond d'une partie : sous la limite du format WebP (16 383 px) et du compositeur de Chrome (16 384 px).
export const MAX_PART_PX = 16000;

// Fenêtre de recherche d'une coupe autour de la hauteur idéale (fraction de la hauteur d'une partie).
const SEARCH_ABOVE = 0.15;
const SEARCH_BELOW = 0.1;
const BITMAP_CACHE = 4;
// Épaisseur du liseré dont on moyenne la couleur autour d'un masque, et teinte de repli s'il est vide.
const RING_PX = 2;
const RING_FALLBACK = '#808080';
// Hauteur lue d'un coup quand on moyenne une bande très haute.
const RING_CHUNK = 4096;
// Score donné aux lignes interdites : plus haut que celui de n'importe quelle ligne réelle.
const BLOCKED = 0xffffffff;

// Rend inutilisables les lignes situées dans une zone à éviter ([haut, bas] en pixels de la capture),
// sauf si toutes les lignes de la fenêtre le sont : la coupe se fait alors comme sans zone.
function blockRows(scores, from, avoid) {
  const blocked = new Uint8Array(scores.length);
  let free = scores.length;
  for (const [top, bottom] of avoid) {
    const first = Math.max(0, Math.floor(top - from) + 1);
    const last = Math.min(scores.length - 1, Math.ceil(bottom - from) - 1);
    for (let row = first; row <= last; row++) {
      if (!blocked[row]) free--;
      blocked[row] = 1;
    }
  }
  if (!free) return;
  for (let row = 0; row < scores.length; row++) if (blocked[row]) scores[row] = BLOCKED;
}

const hex = (channels) => `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`;

// Le cadre utilisé, en pixels entiers de la capture : le cadrage ramené dans ses bords, ou la capture entière (sans cadrage, ou cadrage illisible).
function frameOf({ width, height }, trim) {
  const whole = { x: 0, y: 0, w: width, h: height };
  if (!trim || ![trim.x, trim.y, trim.w, trim.h].every(Number.isFinite)) return whole;
  const x = Math.max(0, Math.round(trim.x));
  const y = Math.max(0, Math.round(trim.y));
  const w = Math.min(Math.round(trim.w), width - x);
  const h = Math.min(Math.round(trim.h), height - y);
  return w >= 1 && h >= 1 ? { x, y, w, h } : whole;
}

export class Stitcher {
  // overlay(ctx, top, height, ratio, left) dessine la surimpression (les annotations) après la capture ;
  // ctx est positionné en (0, 0) = point (`left`, `top`) de la capture, à l'échelle `ratio`.
  // `trim` { x, y, w, h } : le cadrage. Les parties restent en coordonnées de la capture, comprises dans le cadre ; `draw` et `averageRing`
  // lisent toujours la capture entière (l'éditeur montre l'extérieur, et la teinte d'un masque ne dépend pas du cadrage).
  constructor(record, { overlay, trim = null } = {}) {
    this.record = record;
    this.overlay = overlay;
    this.trim = trim;
    this.cache = new Map();
    this.queue = Promise.resolve();
  }

  setTrim(trim) {
    this.trim = trim ?? null;
  }

  frame() {
    return frameOf(this.record, this.trim);
  }

  // Taille de l'image qui sort d'ici, cadrage compris.
  outputSize() {
    const { w, h } = this.frame();
    return { width: w, height: h };
  }

  // Une seule opération à la fois : évite de fermer une tranche encore en cours de dessin.
  enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  async bitmap(index) {
    if (this.cache.has(index)) return this.cache.get(index);
    const bmp = await createImageBitmap(this.record.slices[index].blob);
    this.cache.set(index, bmp);
    if (this.cache.size > BITMAP_CACHE) {
      const [oldest] = this.cache.keys();
      this.cache.get(oldest).close();
      this.cache.delete(oldest);
    }
    return bmp;
  }

  // Dessine la bande [top, top + height) de l'image complète dans ctx, à partir de (0, 0).
  // La dernière tranche, calée sur le bas de la page, chevauche la précédente : la plus ancienne reste au-dessus. Seule la première
  // montre les éléments fixes (un panneau latéral, par exemple), masqués ensuite pour ne pas se répéter : une tranche suivante les effacerait.
  // Réduit, le bord d'une tranche tombe entre deux pixels et laisserait passer le fond : sa première ligne, étirée, passe sous la jonction.
  async draw(ctx, top, height) {
    const { crop, slices } = this.record;
    const zoom = ctx.getTransform().d;
    const hem = zoom < 1 ? Math.ceil(1 / zoom) : 0;
    for (let i = slices.length - 1; i >= 0; i--) {
      const y = slices[i].y;
      if (y + crop.h <= top || y >= top + height) continue;
      const bmp = await this.bitmap(i);
      if (hem && i > 0) ctx.drawImage(bmp, crop.x, crop.y, crop.w, hem, 0, y - top - hem, crop.w, 2 * hem);
      ctx.drawImage(bmp, crop.x, crop.y, crop.w, crop.h, 0, y - top, crop.w, crop.h);
    }
  }

  // Cherche, entre from et to, la ligne la plus « vide » (sans texte ni contour) pour y couper,
  // en évitant les zones `avoid` tant qu'il reste des lignes libres.
  async findCut(from, to, avoid = []) {
    const { x, w: width } = this.frame();
    const height = to - from;
    if (height <= 1) return to;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.translate(-x, 0);
    await this.draw(ctx, from, height);
    const { data } = ctx.getImageData(0, 0, width, height);

    // Score d'une ligne = nombre de changements de couleur nets entre pixels voisins.
    const scores = new Uint32Array(height);
    for (let row = 0; row < height; row++) {
      const base = row * width * 4;
      let edges = 0;
      for (let px = 1; px < width; px += 2) {
        const i = base + px * 4;
        const diff =
          Math.abs(data[i] - data[i - 4]) + Math.abs(data[i + 1] - data[i - 3]) + Math.abs(data[i + 2] - data[i - 2]);
        if (diff > 30) edges++;
      }
      scores[row] = edges;
    }
    blockRows(scores, from, avoid);
    let best = Infinity;
    for (const score of scores) if (score < best) best = score;

    // Parmi les lignes les plus vides, prend la bande la plus haute (un espace entre paragraphes
    // plutôt qu'un interligne) ; à égalité, la plus basse. Coupe en son milieu.
    let cutStart = 0;
    let cutLength = 0;
    for (let row = 0; row < height; ) {
      if (scores[row] > best) {
        row++;
        continue;
      }
      const start = row;
      while (row < height && scores[row] <= best) row++;
      if (row - start >= cutLength) {
        cutStart = start;
        cutLength = row - start;
      }
    }
    return from + cutStart + Math.floor(cutLength / 2);
  }

  // Parties de hauteurs proches, chacune ≤ maxHeight, coupées dans les interlignes
  // et, quand c'est possible, hors des zones `avoid`.
  planParts(maxHeight, avoid = []) {
    return this.enqueue(async () => {
      const { y: origin, h: height } = this.frame();
      const limit = Math.max(200, Math.min(Math.round(maxHeight), MAX_PART_PX));
      const count = Math.ceil(height / limit);
      const ideal = height / count;
      const parts = [];
      let top = 0;
      for (let k = 1; k < count; k++) {
        const upper = Math.min(Math.round(k * ideal + SEARCH_BELOW * ideal), top + limit);
        let lower = Math.max(Math.round(k * ideal - SEARCH_ABOVE * ideal), height - (count - k) * limit, top + 1);
        if (lower >= upper) lower = upper - 1;
        const cut = (await this.findCut(origin + lower, origin + upper, avoid)) - origin;
        parts.push({ top: origin + top, height: cut - top });
        top = cut;
      }
      parts.push({ top: origin + top, height: height - top });
      return parts;
    });
  }

  renderPart(part, type = 'image/png', quality = 0.92) {
    return this.enqueue(async () => {
      const frame = this.frame();
      // Filet : une partie calculée avant un changement de cadrage ne sort jamais du cadre.
      const top = Math.max(part.top, frame.y);
      const height = Math.min(part.top + part.height, frame.y + frame.h) - top;
      if (height < 1) throw new Error('cette image est hors du cadre');
      // Canvas neuf, à la taille du cadre : ce qui est hors cadre n'y entre pas.
      const canvas = new OffscreenCanvas(frame.w, height);
      try {
        const ctx = canvas.getContext('2d');
        if (type !== 'image/png') {
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        ctx.save();
        ctx.translate(-frame.x, 0);
        await this.draw(ctx, top, height);
        ctx.restore();
        await this.overlay?.(ctx, top, height, 1, frame.x);
        const blob = await canvas.convertToBlob({ type, quality });
        if (blob.type !== type) throw new Error(`Chrome ne sait pas produire ce format (${type}).`);
        return blob;
      } finally {
        // Libère tout de suite : une partie haute pèse plus de 100 Mo, et un export en enchaîne des dizaines.
        canvas.width = canvas.height = 0;
      }
    });
  }

  // Aperçu réduit pour l'affichage ; le canvas doit déjà avoir sa largeur en pixels.
  // `{ overlay: false }` dessine la capture seule ; `{ full: true }` ignore le cadrage (les tuiles de l'éditeur montrent l'extérieur).
  // Dessiné hors écran puis copié d'un seul coup : l'écran peut se rafraîchir entre deux tranches, et il montrerait alors, le temps
  // du dessin, ce que les masques vont cacher.
  renderPreview(part, canvas, { overlay = true, full = false } = {}) {
    return this.enqueue(async () => {
      const frame = full ? frameOf(this.record, null) : this.frame();
      const ratio = canvas.width / frame.w;
      const buffer = new OffscreenCanvas(canvas.width, Math.max(1, Math.round(part.height * ratio)));
      const ctx = buffer.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      if (frame.w === this.record.width && frame.h === this.record.height) {
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        await this.draw(ctx, part.top, part.height);
      } else {
        // Réduite directement, la capture mêlerait au bord du cadre un peu de ce qui est à l'extérieur : le cadre passe d'abord par un canvas
        // en pleine définition, où l'extérieur n'existe pas.
        const exact = new OffscreenCanvas(frame.w, part.height);
        const exactCtx = exact.getContext('2d');
        exactCtx.translate(-frame.x, 0);
        await this.draw(exactCtx, part.top, part.height);
        ctx.drawImage(exact, 0, 0, buffer.width, buffer.height);
        exact.width = exact.height = 0;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      }
      if (overlay) await this.overlay?.(ctx, part.top, part.height, ratio, frame.x);
      canvas.height = buffer.height;
      canvas.getContext('2d').drawImage(buffer, 0, 0);
    });
  }

  // Moyenne (#rrggbb) du liseré de 2 px autour de rect, sans les bords de la capture ni les pixels que couvrent les rectangles
  // `hidden` (les autres masques, aux coordonnées entières) ; #808080 si rien ne reste. Ni le contenu de rect ni celui des autres
  // masques n'entrent dans la moyenne.
  averageRing(rect, hidden = []) {
    return this.enqueue(async () => {
      const left = Math.floor(rect.x);
      const top = Math.floor(rect.y);
      const right = Math.ceil(rect.x + rect.width);
      const bottom = Math.ceil(rect.y + rect.height);
      // Quatre bandes autour du rectangle : haut et bas (coins compris), gauche et droite.
      const strips = [
        [left - RING_PX, top - RING_PX, right + RING_PX, top],
        [left - RING_PX, bottom, right + RING_PX, bottom + RING_PX],
        [left - RING_PX, top, left, bottom],
        [right, top, right + RING_PX, bottom],
      ];
      const sum = [0, 0, 0];
      let count = 0;
      for (const strip of strips) {
        const x0 = Math.max(0, strip[0]);
        const y0 = Math.max(0, strip[1]);
        const x1 = Math.min(this.record.width, strip[2]);
        const y1 = Math.min(this.record.height, strip[3]);
        if (x1 <= x0 || y1 <= y0) continue;
        const part = await this.sumPixels(x0, y0, x1 - x0, y1 - y0, hidden);
        part.sum.forEach((channel, i) => (sum[i] += channel));
        count += part.count;
      }
      return count ? hex(sum.map((channel) => Math.round(channel / count))) : RING_FALLBACK;
    });
  }

  // Somme des canaux rouge, vert et bleu des pixels de [x, x + w) × [y, y + h) hors des rectangles `hidden`, et leur nombre ;
  // lus par morceaux.
  async sumPixels(x, y, w, h, hidden = []) {
    const sum = [0, 0, 0];
    let count = 0;
    for (let offset = 0; offset < h; offset += RING_CHUNK) {
      const rows = Math.min(RING_CHUNK, h - offset);
      const ctx = new OffscreenCanvas(w, rows).getContext('2d', { willReadFrequently: true });
      ctx.translate(-x, 0);
      await this.draw(ctx, y + offset, rows);
      const { data } = ctx.getImageData(0, 0, w, rows);
      for (let row = 0; row < rows; row++) {
        const py = y + offset + row;
        const covering = hidden.filter((r) => py >= r.y && py < r.y + r.height);
        for (let col = 0; col < w; col++) {
          const px = x + col;
          if (covering.some((r) => px >= r.x && px < r.x + r.width)) continue;
          const i = (row * w + col) * 4;
          sum[0] += data[i];
          sum[1] += data[i + 1];
          sum[2] += data[i + 2];
          count++;
        }
      }
    }
    return { sum, count };
  }

  dispose() {
    for (const bmp of this.cache.values()) bmp.close();
    this.cache.clear();
  }
}
