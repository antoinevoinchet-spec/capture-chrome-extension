// Réunit les parties d'une capture en un seul fichier, une partie à la fois : le canvas de chacune est libéré avant de passer à la suivante,
// et seuls les fichiers déjà encodés restent en mémoire (en Blob). Rien n'est produit tant que tout n'est pas prêt : pas de fichier tronqué.

import { buildPdf } from '../convert/pdf.js';
import { ZipWriter } from './zip.js';

// Rend chaque partie dans l'ordre. `onProgress(n, total)` annonce la partie qui commence ; `signal` arrête entre deux parties.
async function eachPart(parts, render, { signal, onProgress }) {
  for (const [index, part] of parts.entries()) {
    signal?.throwIfAborted();
    onProgress?.(index + 1, parts.length);
    await render(part, index);
  }
  signal?.throwIfAborted();
}

export async function exportPdf({ stitcher, parts, signal, onProgress }) {
  const { width } = stitcher.record;
  const pages = [];
  await eachPart(
    parts,
    async (part) => {
      pages.push({ width, height: part.height, kind: 'jpeg', data: await stitcher.renderPart(part, 'image/jpeg') });
    },
    { signal, onProgress },
  );
  return buildPdf(pages);
}

// `names` : le nom de chaque partie dans le zip, ceux de « Tout télécharger ». `format` : son type (image/png…).
export async function exportZip({ stitcher, parts, format, names, signal, onProgress }) {
  const zip = new ZipWriter();
  await eachPart(
    parts,
    async (part, index) => {
      await zip.add(names[index], await stitcher.renderPart(part, format));
    },
    { signal, onProgress },
  );
  return zip.finish();
}
