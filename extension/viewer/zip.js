// Écrit un zip sans bibliothèque : entrées non compressées (les images ne se compressent plus), assemblé en Blob de blobs, sans recopier les images en mémoire.
// Le format s'arrête à 4 Gio et 65 535 entrées sans ses extensions, qui ne sont pas lues partout : au-delà, on refuse.

export class ZipTooBig extends Error {}

const LOCAL = 30;
const CENTRAL = 46;
const END = 22;
const CHUNK = 1024 * 1024;
const UTF8_NAMES = 0x0800;
const VERSION = 20;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

// Lu par morceaux : une image de 100 Mo n'est jamais entière en mémoire pour ce calcul.
async function crc32(blob) {
  let crc = 0xffffffff;
  for (let at = 0; at < blob.size; at += CHUNK) {
    const bytes = new Uint8Array(await blob.slice(at, at + CHUNK).arrayBuffer());
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

export class ZipWriter {
  constructor({ maxEntries = 65535, maxBytes = 2 ** 32 - 1 } = {}) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.parts = [];
    this.central = [];
    this.count = 0;
    this.position = 0;
    this.centralSize = 0;
  }

  async add(name, blob) {
    const nameBytes = new TextEncoder().encode(name);
    const entrySize = LOCAL + nameBytes.length + blob.size;
    const centralSize = CENTRAL + nameBytes.length;
    if (this.count + 1 > this.maxEntries) throw new ZipTooBig('Trop d’images pour un seul zip.');
    if (this.position + entrySize + this.centralSize + centralSize + END > this.maxBytes) throw new ZipTooBig('Le zip dépasserait la taille maximale de ce format.');

    const crc = await crc32(blob);
    const { time, day } = dosDateTime(new Date());

    const local = new DataView(new ArrayBuffer(LOCAL));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, VERSION, true);
    local.setUint16(6, UTF8_NAMES, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, blob.size, true);
    local.setUint32(22, blob.size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    this.parts.push(local.buffer, nameBytes, blob);

    const header = new DataView(new ArrayBuffer(CENTRAL));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, VERSION, true);
    header.setUint16(6, VERSION, true);
    header.setUint16(8, UTF8_NAMES, true);
    header.setUint16(10, 0, true);
    header.setUint16(12, time, true);
    header.setUint16(14, day, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, blob.size, true);
    header.setUint32(24, blob.size, true);
    header.setUint16(28, nameBytes.length, true);
    header.setUint32(42, this.position, true);
    this.central.push(header.buffer, nameBytes);

    this.position += entrySize;
    this.centralSize += centralSize;
    this.count++;
  }

  finish() {
    const end = new DataView(new ArrayBuffer(END));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.count, true);
    end.setUint16(10, this.count, true);
    end.setUint32(12, this.centralSize, true);
    end.setUint32(16, this.position, true);
    return new Blob([...this.parts, ...this.central, end.buffer], { type: 'application/zip' });
  }
}
