// Recolle les tranches capturées et découpe l'image finale en plusieurs parties,
// sans jamais réduire la résolution.

// Plafond d'une partie : sous la limite du format WebP (16 383 px) et du compositeur de Chrome (16 384 px).
export const MAX_PART_PX = 16000;

// Fenêtre de recherche d'une coupe autour de la hauteur idéale (fraction de la hauteur d'une partie).
const SEARCH_ABOVE = 0.15;
const SEARCH_BELOW = 0.1;
const BITMAP_CACHE = 4;

export class Stitcher {
  constructor(record) {
    this.record = record;
    this.cache = new Map();
    this.queue = Promise.resolve();
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
  async draw(ctx, top, height) {
    const { crop, slices } = this.record;
    for (let i = 0; i < slices.length; i++) {
      const y = slices[i].y;
      if (y + crop.h <= top || y >= top + height) continue;
      const bmp = await this.bitmap(i);
      ctx.drawImage(bmp, crop.x, crop.y, crop.w, crop.h, 0, y - top, crop.w, crop.h);
    }
  }

  // Cherche, entre from et to, la ligne la plus « vide » (sans texte ni contour) pour y couper.
  async findCut(from, to) {
    const width = this.record.width;
    const height = to - from;
    if (height <= 1) return to;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    await this.draw(ctx, from, height);
    const { data } = ctx.getImageData(0, 0, width, height);

    // Score d'une ligne = nombre de changements de couleur nets entre pixels voisins.
    const scores = new Uint32Array(height);
    let best = Infinity;
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
      if (edges < best) best = edges;
    }

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

  // Parties de hauteurs proches, chacune ≤ maxHeight, coupées dans les interlignes.
  planParts(maxHeight) {
    return this.enqueue(async () => {
      const { height } = this.record;
      const limit = Math.max(200, Math.min(Math.round(maxHeight), MAX_PART_PX));
      const count = Math.ceil(height / limit);
      const ideal = height / count;
      const parts = [];
      let top = 0;
      for (let k = 1; k < count; k++) {
        const upper = Math.min(Math.round(k * ideal + SEARCH_BELOW * ideal), top + limit);
        let lower = Math.max(Math.round(k * ideal - SEARCH_ABOVE * ideal), height - (count - k) * limit, top + 1);
        if (lower >= upper) lower = upper - 1;
        const cut = await this.findCut(lower, upper);
        parts.push({ top, height: cut - top });
        top = cut;
      }
      parts.push({ top, height: height - top });
      return parts;
    });
  }

  renderPart(part, type = 'image/png', quality = 0.92) {
    return this.enqueue(async () => {
      const canvas = new OffscreenCanvas(this.record.width, part.height);
      const ctx = canvas.getContext('2d');
      if (type !== 'image/png') {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      await this.draw(ctx, part.top, part.height);
      const blob = await canvas.convertToBlob({ type, quality });
      if (blob.type !== type) throw new Error(`Chrome ne sait pas produire ce format (${type}).`);
      return blob;
    });
  }

  // Aperçu réduit pour l'affichage ; le canvas doit déjà avoir sa largeur en pixels.
  renderPreview(part, canvas) {
    return this.enqueue(async () => {
      const ratio = canvas.width / this.record.width;
      canvas.height = Math.max(1, Math.round(part.height * ratio));
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      await this.draw(ctx, part.top, part.height);
    });
  }

  dispose() {
    for (const bmp of this.cache.values()) bmp.close();
    this.cache.clear();
  }
}
