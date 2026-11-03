// Ce qu'un collage (⌘V) apporte au convertisseur. Tout se lit de façon synchrone : Chrome vide le presse-papiers de l'événement à la première attente.

const EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/heif': 'heif',
};
// Au-delà, ou sur plusieurs lignes, un texte n'est pas le nom d'un fichier copié.
const NAME_MAX = 255;

// Chrome appelle `image.png` une image sans fichier d'origine (capture d'écran, icône). Un fichier copié arrive avec son vrai nom.
export const isGenericName = (name) => !name || /^image\.\w+$/i.test(name);

// { files, finderCopy }. `finderCopy` : un nom de fichier en texte et seulement une image sans nom, c'est-à-dire l'icône du fichier et pas son contenu.
export function pastedFiles(data) {
  let files = [...data.files];
  if (!files.length) files = [...data.items].filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter(Boolean);
  const text = data.getData('text/plain').trim();
  const onlyText = [...data.types].every((type) => type === 'text/plain' || type === 'Files');
  const nameLike = text.length > 0 && text.length <= NAME_MAX && !text.includes('\n');
  return { files, finderCopy: files.length > 0 && onlyText && nameLike && files.every((file) => isGenericName(file.name)) };
}

// Nom d'une image collée sans nom : `Collage 2026-11-03 15.22.01.png`, puis `-2`, `-3`.
export function pastedName(date, index, type) {
  const two = (value) => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}.${two(date.getMinutes())}.${two(date.getSeconds())}`;
  return `Collage ${stamp}${index ? `-${index + 1}` : ''}.${EXTENSIONS[type] ?? 'png'}`;
}

// Les images sans nom reçoivent le leur ; les fichiers copiés gardent le leur.
export function namePasted(files, date = new Date()) {
  let index = 0;
  return files.map((file) => (isGenericName(file.name) ? new File([file], pastedName(date, index++, file.type), { type: file.type, lastModified: file.lastModified }) : file));
}

// Un champ où l'on écrit garde son collage normal. Le sélecteur de fichiers, qui reçoit le focus après « Tout retirer », n'en est pas un.
export function isWritingField(target) {
  if (target?.isContentEditable) return true;
  if (target?.tagName === 'TEXTAREA') return true;
  return target?.tagName === 'INPUT' && target.type !== 'file';
}
