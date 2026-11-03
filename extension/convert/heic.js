// Photos HEIC : reconnaissance du fichier, lecture de son profil de couleur, décodage.
// Chrome ne sait pas lire ce format : le décodage passe par heic-to, chargé seulement quand une telle photo se présente.
// heic-to ignore le profil de couleur : une photo en Display P3 sortirait terne si on ne le lisait pas ici.

const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'heif', 'mif1', 'msf1']);
const AV1_BRANDS = new Set(['avif', 'avis']);

// Composante rouge d'un profil ICC (rXYZ), adaptée à D50 comme le veut ce format.
const ICC_RED = {
  'display-p3': [0.5151, 0.2412, -0.0011],
  srgb: [0.436, 0.2225, 0.0139],
};

const fourCC = (view, at) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

// Se fie au contenu du fichier, pas à son nom.
export async function isHeif(blob) {
  const head = new DataView(await blob.slice(0, 256).arrayBuffer());
  if (head.byteLength < 12 || fourCC(head, 4) !== 'ftyp') return false;
  const end = Math.min(head.getUint32(0), head.byteLength);
  const brands = [fourCC(head, 8)];
  for (let at = 16; at + 4 <= end; at += 4) brands.push(fourCC(head, at));
  if (brands.some((brand) => AV1_BRANDS.has(brand))) return false;
  return brands.some((brand) => HEIF_BRANDS.has(brand));
}

// Un fichier coupé (téléchargement interrompu, par exemple) annonce plus d'octets qu'il n'en a. Le décodeur n'y voit rien et
// rendrait une image abîmée sans le dire : on regarde les grandes sections du fichier avant de le lui donner.
// Des octets sans rapport à la fin du fichier ne forment pas une section connue : la photo reste entière.
const FILE_SECTIONS = new Set(['ftyp', 'meta', 'mdat', 'moov', 'free', 'skip', 'uuid']);

export async function isTruncated(blob) {
  for (let at = 0; at < blob.size; ) {
    const head = new DataView(await blob.slice(at, at + 16).arrayBuffer());
    if (head.byteLength < 8) return false;
    let size = head.getUint32(0);
    if (size === 0) return false; // Cette section va jusqu'à la fin du fichier.
    if (size === 1) {
      if (head.byteLength < 16) return false;
      size = Number(head.getBigUint64(8));
    }
    if (size < 8 || at + size > blob.size) return FILE_SECTIONS.has(fourCC(head, 4));
    at += size;
  }
  return false;
}

function* boxes(view, start, end) {
  for (let at = start; at + 8 <= end; ) {
    let size = view.getUint32(at);
    let head = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(at + 8));
      head = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < head || at + size > end) return;
    yield { name: fourCC(view, at + 4), body: at + head, end: at + size };
    at += size;
  }
}

function findBox(view, start, end, name) {
  for (const box of boxes(view, start, end)) if (box.name === name) return box;
  return null;
}

function iccSpace(view, start, end) {
  const count = view.getUint32(start + 128);
  for (let index = 0; index < count; index++) {
    const entry = start + 132 + index * 12;
    if (entry + 12 > end || fourCC(view, entry) !== 'rXYZ') continue;
    const at = start + view.getUint32(entry + 4) + 8;
    const red = [0, 4, 8].map((offset) => view.getInt32(at + offset) / 65536);
    for (const [space, known] of Object.entries(ICC_RED)) {
      if (red.every((value, axis) => Math.abs(value - known[axis]) < 0.01)) return space;
    }
    return 'autre';
  }
  return 'autre';
}

function nclxSpace(view, at) {
  const primaries = view.getUint16(at);
  const transfer = view.getUint16(at + 2);
  // 13 : la courbe du sRGB, celle du Display P3. 2 : non précisée.
  if (transfer !== 13 && transfer !== 2) return 'autre';
  if (primaries === 12) return 'display-p3';
  if (primaries === 1 || primaries === 2) return 'srgb';
  return 'autre';
}

// Profil de l'image principale : un fichier peut en décrire plusieurs (vignette, carte HDR).
// Rend 'display-p3', 'srgb', 'autre' (profil présent mais pas géré) ou 'absent'.
export async function colorSpaceOf(blob) {
  try {
    const buffer = await blob.arrayBuffer();
    const view = new DataView(buffer);
    const meta = findBox(view, 0, buffer.byteLength, 'meta');
    if (!meta) return 'absent';
    const inner = meta.body + 4;
    const pitm = findBox(view, inner, meta.end, 'pitm');
    const iprp = findBox(view, inner, meta.end, 'iprp');
    if (!pitm || !iprp) return 'absent';
    const primary = view.getUint8(pitm.body) === 0 ? view.getUint16(pitm.body + 4) : view.getUint32(pitm.body + 4);
    const ipco = findBox(view, iprp.body, iprp.end, 'ipco');
    const ipma = findBox(view, iprp.body, iprp.end, 'ipma');
    if (!ipco || !ipma) return 'absent';
    const properties = [...boxes(view, ipco.body, ipco.end)];
    const version = view.getUint8(ipma.body);
    const wide = view.getUint8(ipma.body + 3) & 1;
    let at = ipma.body + 4;
    const entries = view.getUint32(at);
    at += 4;
    for (let entry = 0; entry < entries; entry++) {
      const id = version < 1 ? view.getUint16(at) : view.getUint32(at);
      at += version < 1 ? 2 : 4;
      const links = view.getUint8(at++);
      for (let link = 0; link < links; link++) {
        const index = wide ? view.getUint16(at) & 0x7fff : view.getUint8(at) & 0x7f;
        at += wide ? 2 : 1;
        const property = properties[index - 1];
        if (id !== primary || property?.name !== 'colr') continue;
        const kind = fourCC(view, property.body);
        if (kind === 'nclx') return nclxSpace(view, property.body + 4);
        if (kind === 'prof' || kind === 'rICC') return iccSpace(view, property.body + 4, property.end);
      }
    }
    return 'absent';
  } catch {
    return 'absent';
  }
}

// Les valeurs décodées sont du Display P3 lu comme du sRGB. Les déclarer pour ce qu'elles sont fait que Chrome les convertit à l'écriture.
function p3ToSrgb(bitmap) {
  const { width, height } = bitmap;
  const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const raw = ctx.getImageData(0, 0, width, height);
  ctx.putImageData(new ImageData(raw.data, width, height, { colorSpace: 'display-p3' }), 0, 0);
  return ctx.canvas.transferToImageBitmap();
}

export async function decodeHeic(blob) {
  if (await isTruncated(blob)) throw new Error('Fichier incomplet');
  const space = await colorSpaceOf(blob);
  const { heicTo } = await import('../vendor/heic-to-csp.js');
  const bitmap = await heicTo({ blob, type: 'bitmap' });
  if (space === 'display-p3') return { bitmap: p3ToSrgb(bitmap) };
  return { bitmap, notice: space === 'autre' ? 'Couleurs à vérifier' : undefined };
}
