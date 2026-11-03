// Chrome refuse ces noms hérités de Windows, quel que soit le système, quelle que soit la suite du nom.
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|clock\$)(\.|$)/i;

// Chrome refuse certains noms : caractères réservés, espaces spéciaux (ceux des captures d'écran de macOS), points en tête ou en fin,
// noms hérités de Windows. La coupe se fait entre deux caractères entiers : couper un émoji en deux rend le nom invalide.
export function cleanBase(name) {
  const base = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
  const safe = base
    .normalize('NFC')
    .replace(/\p{Zs}/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/[\\/:*?"<>|~]/g, '-');
  const clean = Array.from(safe).slice(0, 120).join('').replace(/^[.\s]+|[.\s]+$/g, '');
  if (!clean) return 'image';
  return RESERVED_NAMES.test(clean) ? `image-${clean}` : clean;
}
