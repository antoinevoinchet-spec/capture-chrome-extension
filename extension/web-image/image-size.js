// Largeur et hauteur d'une image, lues dans son en-tête, sans la décoder : un PNG léger peut annoncer 30 000 × 30 000 px, soit environ 3,6 Go une fois décodé.
// Formats : PNG, JPEG, GIF, WebP, AVIF. Rend null si le fichier n'est pas reconnu ou si ses dimensions sont illisibles.

const text = (bytes, at, length) => String.fromCharCode(...bytes.subarray(at, at + length));

function readPng(view, bytes) {
  if (bytes[0] !== 0x89 || text(bytes, 1, 3) !== 'PNG' || text(bytes, 12, 4) !== 'IHDR') return undefined;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

// Un JPEG est une suite de segments : on les saute jusqu'à celui qui décrit l'image. Un aperçu inclus dans ses métadonnées reste dans son segment, donc ignoré.
function readJpeg(view, bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    if (marker === 0xff) {
      at += 1;
    } else if ((marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) {
      at += 2;
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
    } else {
      at += 2 + view.getUint16(at + 2);
    }
  }
  return null;
}

function readGif(view, bytes) {
  if (text(bytes, 0, 3) !== 'GIF') return undefined;
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

function readWebp(view, bytes) {
  if (text(bytes, 0, 4) !== 'RIFF' || text(bytes, 8, 4) !== 'WEBP') return undefined;
  const kind = text(bytes, 12, 4);
  if (kind === 'VP8 ') return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  if (kind === 'VP8L') {
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8X') {
    const three = (at) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
    return { width: three(24) + 1, height: three(27) + 1 };
  }
  return null;
}

// Parcourt les boîtes de [from, to) et appelle visit(type, début du contenu, fin de la boîte).
function eachBox(view, bytes, from, to, visit) {
  let at = from;
  while (at + 8 <= to) {
    let size = view.getUint32(at);
    let body = at + 8;
    if (size === 1) {
      size = Number(view.getBigUint64(at + 8));
      body = at + 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < body - at || at + size > to) return;
    visit(text(bytes, at + 4, 4), body, at + size);
    at += size;
  }
}

// AVIF : les dimensions sont dans les boîtes meta > iprp > ipco > ispe. Plusieurs ispe peuvent exister (tuiles, canal alpha) : on garde la plus grande.
function readAvif(view, bytes) {
  if (text(bytes, 4, 4) !== 'ftyp') return undefined;
  const ftypEnd = view.getUint32(0);
  const brands = [text(bytes, 8, 4)];
  for (let at = 16; at + 4 <= ftypEnd; at += 4) brands.push(text(bytes, at, 4));
  if (!brands.includes('avif') && !brands.includes('avis')) return undefined;
  let found = null;
  const inside = (wanted, next) => (type, body, end) => {
    if (type === wanted) next(body, end);
  };
  eachBox(view, bytes, 0, bytes.length, inside('meta', (metaBody, metaEnd) => {
    // `meta` commence par 4 octets de version.
    eachBox(view, bytes, metaBody + 4, metaEnd, inside('iprp', (iprpBody, iprpEnd) => {
      eachBox(view, bytes, iprpBody, iprpEnd, inside('ipco', (ipcoBody, ipcoEnd) => {
        eachBox(view, bytes, ipcoBody, ipcoEnd, inside('ispe', (body) => {
          const width = view.getUint32(body + 4);
          const height = view.getUint32(body + 8);
          if (!found || width * height > found.width * found.height) found = { width, height };
        }));
      }));
    }));
  }));
  return found;
}

export function readImageSize(bytes) {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const read of [readPng, readJpeg, readGif, readWebp, readAvif]) {
    try {
      const size = read(view, bytes);
      if (size === undefined) continue;
      return size && size.width > 0 && size.height > 0 ? size : null;
    } catch {
      return null; // Fichier coupé : l'en-tête annonce plus que ce qu'il contient.
    }
  }
  return null;
}
