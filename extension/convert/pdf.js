// Assemble un PDF d'images, une par page. Sans bibliothèque : ce format-là tient en quelques objets,
// et les grosses bibliothèques apportent des fonctions inutiles ici (formulaires, scripts) et leurs failles.

const POINTS_PER_PIXEL = 0.75; // 96 pixels par pouce.
const MAX_PAGE_POINTS = 14400; // Limite courante des lecteurs de PDF.

const number = (value) => String(Number(value.toFixed(2)));

function pageSize(width, height) {
  const unit = Math.min(POINTS_PER_PIXEL, MAX_PAGE_POINTS / Math.max(width, height));
  return { width: width * unit, height: height * unit };
}

// pages : [{ width, height, kind: 'jpeg' | 'flate', data: Blob }], dimensions en pixels.
export function buildPdf(pages) {
  const parts = [];
  const offsets = [];
  let position = 0;
  const write = (part) => {
    parts.push(part);
    position += part.size ?? part.length;
  };
  const object = (number, ...content) => {
    offsets[number] = position;
    write(`${number} 0 obj\n`);
    content.forEach(write);
    write('\nendobj\n');
  };

  write('%PDF-1.4\n');
  // Marque habituelle : quatre octets non ASCII disent aux outils que le fichier est binaire.
  write(new Blob([new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])]));

  const objectsPerPage = 3;
  const first = 3;
  const kids = pages.map((_, index) => `${first + index * objectsPerPage} 0 R`).join(' ');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Count ${pages.length} /Kids [${kids}] >>`);

  pages.forEach(({ width, height, kind, data }, index) => {
    const pageObject = first + index * objectsPerPage;
    const imageObject = pageObject + 1;
    const contentObject = pageObject + 2;
    const size = pageSize(width, height);
    const box = `0 0 ${number(size.width)} ${number(size.height)}`;
    object(pageObject, `<< /Type /Page /Parent 2 0 R /MediaBox [${box}] /Resources << /XObject << /I ${imageObject} 0 R >> >> /Contents ${contentObject} 0 R >>`);
    const filter = kind === 'jpeg' ? '/DCTDecode' : '/FlateDecode';
    object(imageObject, `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter ${filter} /Length ${data.size} >>\nstream\n`, data, '\nendstream');
    const draw = `q ${number(size.width)} 0 0 ${number(size.height)} 0 0 cm /I Do Q`;
    object(contentObject, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
  });

  const count = first + pages.length * objectsPerPage;
  const table = position;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let index = 1; index < count; index++) xref += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  write(xref);
  write(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${table}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}
