// Historique local des captures et de leurs annotations (IndexedDB) : partagé entre le service worker et les pages de l'extension.
// Les annotations ont leur propre magasin (clé = id de la capture) : les enregistrer ne réécrit jamais les tranches.

const DB_NAME = 'capture';
const DB_VERSION = 2;
const CAPTURES = 'captures';
const ANNOTATIONS = 'annotations';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // Crée chaque magasin manquant sans toucher aux données déjà là (version 1 : captures seules).
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CAPTURES)) db.createObjectStore(CAPTURES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(ANNOTATIONS)) db.createObjectStore(ANNOTATIONS, { keyPath: 'captureId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Une transaction sur les magasins demandés ; rend le résultat de la requête renvoyée par makeRequest(tx).
async function request(stores, mode, makeRequest) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      const req = makeRequest(tx);
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? req.error);
    });
  } finally {
    db.close();
  }
}

const onStore = (name, mode, makeRequest) => request(name, mode, (tx) => makeRequest(tx.objectStore(name)));

// Les captures d'un groupe ont la même date : elles restent dans l'ordre des appareils, le téléphone d'abord.
const DEVICE_ORDER = ['telephone', 'tablette', 'ordinateur'];
const newestFirst = (a, b) => b.createdAt - a.createdAt || DEVICE_ORDER.indexOf(a.group?.device) - DEVICE_ORDER.indexOf(b.group?.device);

// La capture n'existe plus (supprimée dans un autre onglet) : ses annotations n'ont nulle part où aller.
export class CaptureGone extends Error {
  name = 'CaptureGone';
}

// Supprime la capture et ses annotations dans la même transaction.
function removeCapture(tx, id) {
  tx.objectStore(CAPTURES).delete(id);
  return tx.objectStore(ANNOTATIONS).delete(id);
}

export async function saveCapture(record) {
  const id = crypto.randomUUID();
  await onStore(CAPTURES, 'readwrite', (store) => store.put({ ...record, id }));
  return id;
}

export const getCapture = (id) => onStore(CAPTURES, 'readonly', (store) => store.get(id));

export const deleteCapture = (id) => request([CAPTURES, ANNOTATIONS], 'readwrite', (tx) => removeCapture(tx, id));

export async function listCaptures() {
  const all = await onStore(CAPTURES, 'readonly', (store) => store.getAll());
  return all.sort(newestFirst);
}

// Les captures d'un groupe, dans l'ordre des appareils.
export async function listGroup(groupId) {
  return (await listCaptures()).filter(({ group }) => group?.id === groupId);
}

// Supprime tout le groupe et ses annotations dans la même transaction.
export function deleteGroup(groupId) {
  return request([CAPTURES, ANNOTATIONS], 'readwrite', (tx) => {
    const all = tx.objectStore(CAPTURES).getAll();
    all.onsuccess = () => {
      for (const { id, group } of all.result) if (group?.id === groupId) removeCapture(tx, id);
    };
    return all;
  });
}

// Garde les `keep` captures non annotées les plus récentes ; une capture annotée ou recadrée n'est jamais supprimée ici, ni une capture de la
// liste `spared` (celles affichées à l'écran, qu'on peut encore annoter).
// Un groupe compte pour une capture : il reste entier si l'une des siennes est annotée, recadrée ou affichée, et part entier sinon.
// Lecture et suppressions dans une seule transaction : une annotation enregistrée entre-temps est vue.
export async function pruneCaptures(keep, spared = []) {
  await request([CAPTURES, ANNOTATIONS], 'readwrite', (tx) => {
    const annotated = tx.objectStore(ANNOTATIONS).getAllKeys();
    const all = tx.objectStore(CAPTURES).getAll();
    all.onsuccess = () => {
      const entries = new Map();
      for (const capture of all.result.sort(newestFirst)) {
        const key = capture.group?.id ?? capture.id;
        entries.set(key, [...(entries.get(key) ?? []), capture.id]);
      }
      const plain = [...entries.values()].filter((ids) => !ids.some((id) => annotated.result.includes(id)));
      for (const ids of plain.slice(keep)) {
        if (!ids.some((id) => spared.includes(id))) for (const id of ids) removeCapture(tx, id);
      }
    };
    return all;
  });
}

// Annotations d'une capture, dans l'ordre de création ; [] s'il n'y en a pas.
export async function getAnnotations(captureId) {
  const entry = await onStore(ANNOTATIONS, 'readonly', (store) => store.get(captureId));
  return entry?.items ?? [];
}

// Annotations et cadrage d'une capture. Une entrée d'avant le recadrage n'a pas de `trim` : il vaut null.
export async function getEdits(captureId) {
  const entry = await onStore(ANNOTATIONS, 'readonly', (store) => store.get(captureId));
  return { items: entry?.items ?? [], trim: entry?.trim ?? null };
}

// Une seule écriture pour la liste et le cadrage : `nextOf(entrée actuelle)` rend { items, trim }. Sans annotation ni cadrage, l'entrée
// est supprimée : la capture redevient une capture ordinaire.
// Une capture qui n'existe plus ne reçoit rien et ne revient pas : l'écriture échoue avec CaptureGone.
async function writeEdits(captureId, nextOf) {
  let failure = null;
  const write = request([CAPTURES, ANNOTATIONS], 'readwrite', (tx) => {
    const annotations = tx.objectStore(ANNOTATIONS);
    const stored = annotations.get(captureId);
    stored.onsuccess = () => {
      const { items, trim } = nextOf(stored.result);
      if (!items.length && !trim) {
        annotations.delete(captureId);
        return;
      }
      const found = tx.objectStore(CAPTURES).getKey(captureId);
      found.onsuccess = () => {
        if (found.result === undefined) {
          failure = new CaptureGone();
          return;
        }
        try {
          annotations.put({ captureId, items, ...(trim && { trim }), updatedAt: Date.now() });
        } catch (err) {
          // Levée dans ce rappel, l'erreur serait perdue : la transaction s'annulerait sans dire pourquoi.
          failure = err;
          tx.abort();
        }
      };
    };
    return stored;
  });
  await write.catch((err) => {
    if (!failure) throw err;
  });
  if (failure) throw failure;
}

// Remplace toute la liste et garde le cadrage. Une liste vide, sans cadrage, supprime l'entrée.
export function saveAnnotations(captureId, items) {
  return writeEdits(captureId, (entry) => ({ items, trim: entry?.trim ?? null }));
}

// Remplace la liste et le cadrage ensemble.
export function saveEdits(captureId, { items, trim }) {
  return writeEdits(captureId, () => ({ items, trim: trim ?? null }));
}

// Ce que porte chaque capture retouchée : { annotated, trimmed }, par id de capture.
export async function listEditKinds() {
  const entries = await onStore(ANNOTATIONS, 'readonly', (store) => store.getAll());
  return new Map(entries.map(({ captureId, items, trim }) => [captureId, { annotated: items.length > 0, trimmed: Boolean(trim) }]));
}

// Ids des captures qui portent au moins une annotation ou un cadrage.
export async function listAnnotatedIds() {
  return new Set(await onStore(ANNOTATIONS, 'readonly', (store) => store.getAllKeys()));
}
