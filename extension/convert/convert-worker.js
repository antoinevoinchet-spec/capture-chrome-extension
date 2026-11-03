// Convertit une image à la fois, à part de la page : celle-ci reste utilisable pendant une grosse photo.

import { decodeHeic, isHeif } from './heic.js';

const QUALITY = { high: 0.92, medium: 0.8, light: 0.6 };
const TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const WEBP_MAX_PX = 16383;
// Le double de la taille affichée : l'aperçu reste net sur un écran Retina.
const THUMB_PX = 480;

const UNREADABLE = 'Fichier illisible : format non pris en charge, déplacé depuis son ajout, ou abîmé.';
const TOO_BIG = 'Image trop grande pour être convertie : réduis sa taille.';

// Un message écrit pour l'utilisateur. Les textes de Chrome, en anglais, ne doivent pas arriver jusqu'à la page.
class Refusal extends Error {}

async function decode(file) {
  let heif;
  try {
    heif = await isHeif(file);
  } catch {
    throw new Refusal(UNREADABLE);
  }
  if (heif) {
    try {
      return await decodeHeic(file);
    } catch {
      throw new Refusal('Cette photo HEIC est illisible ou abîmée.');
    }
  }
  try {
    return { bitmap: await createImageBitmap(file) };
  } catch {
    throw new Refusal(UNREADABLE);
  }
}

// Jamais d'agrandissement : une image déjà plus petite garde sa taille.
function targetSize(width, height, { mode, value }) {
  const ratio = mode === 'width' ? value / width : mode === 'height' ? value / height : mode === 'percent' ? value / 100 : 1;
  if (ratio >= 1) return { width, height };
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

async function resize(bitmap, resizeOption) {
  const { width, height } = targetSize(bitmap.width, bitmap.height, resizeOption);
  if (width === bitmap.width && height === bitmap.height) return bitmap;
  const smaller = await createImageBitmap(bitmap, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
  bitmap.close();
  return smaller;
}

function paint(bitmap, opaque) {
  const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d', { alpha: !opaque, willReadFrequently: opaque });
  if (opaque) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, bitmap.width, bitmap.height);
  }
  ctx.drawImage(bitmap, 0, 0);
  return ctx;
}

async function encode(ctx, type, quality) {
  let blob;
  try {
    blob = await ctx.canvas.convertToBlob({ type, quality });
  } catch {
    throw new Refusal(TOO_BIG);
  }
  if (blob.type !== type) throw new Refusal(`Chrome ne sait pas produire ce format (${type}).`);
  return blob;
}

// PNG, BMP et GIF ne perdent rien : ce sont souvent des captures d'écran, au texte fin.
async function isLossless(file) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const png = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  const bmp = head[0] === 0x42 && head[1] === 0x4d;
  const gif = head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46;
  return png || bmp || gif;
}

async function compressRgb(ctx) {
  const { width, height } = ctx.canvas;
  const { data } = ctx.getImageData(0, 0, width, height);
  const rgb = new Uint8Array(width * height * 3);
  for (let from = 0, to = 0; from < data.length; from += 4, to += 3) {
    rgb[to] = data[from];
    rgb[to + 1] = data[from + 1];
    rgb[to + 2] = data[from + 2];
  }
  return new Response(new Blob([rgb]).stream().pipeThrough(new CompressionStream('deflate'))).blob();
}

async function pdfPage(ctx, file, quality) {
  if (quality === 'high' && (await isLossless(file))) return { kind: 'flate', blob: await compressRgb(ctx) };
  return { kind: 'jpeg', blob: await encode(ctx, 'image/jpeg', QUALITY[quality]) };
}

function thumbnail(bitmap) {
  const scale = Math.min(1, THUMB_PX / bitmap.width, THUMB_PX / bitmap.height);
  return createImageBitmap(bitmap, {
    resizeWidth: Math.max(1, Math.round(bitmap.width * scale)),
    resizeHeight: Math.max(1, Math.round(bitmap.height * scale)),
    resizeQuality: 'medium',
  });
}

async function convert(file, { format, quality, resize: resizeOption }) {
  const decoded = await decode(file);
  const sourceWidth = decoded.bitmap.width;
  const sourceHeight = decoded.bitmap.height;
  const bitmap = await resize(decoded.bitmap, resizeOption);
  const { width, height } = bitmap;
  if (format === 'webp' && Math.max(width, height) > WEBP_MAX_PX) {
    bitmap.close();
    throw new Refusal('Le WebP est limité à 16 383 px de côté : réduis la taille, ou choisis JPG ou PNG.');
  }
  const thumb = await thumbnail(bitmap);
  const ctx = paint(bitmap, format === 'jpg' || format === 'pdf');
  bitmap.close();
  const output = format === 'pdf' ? await pdfPage(ctx, file, quality) : { blob: await encode(ctx, TYPES[format], format === 'png' ? undefined : QUALITY[quality]) };
  return { ...output, width, height, sourceWidth, sourceHeight, thumb, notice: decoded.notice };
}

self.onmessage = async ({ data: { id, file, options } }) => {
  try {
    const result = await convert(file, options);
    self.postMessage({ id, ...result }, [result.thumb]);
  } catch (err) {
    if (!(err instanceof Refusal)) console.warn('Conversion impossible :', err);
    self.postMessage({ id, error: err instanceof Refusal ? err.message : TOO_BIG });
  }
};
