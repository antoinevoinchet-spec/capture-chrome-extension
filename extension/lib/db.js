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

const newestFirst = (a, b) => b.createdAt - a.createdAt;

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

// Garde les `keep` captures non annotées les plus récentes ; une capture annotée n'est jamais supprimée ici, ni une capture de la
// liste `spared` (celles affichées à l'écran, qu'on peut encore annoter).
// Lecture et suppressions dans une seule transaction : une annotation enregistrée entre-temps est vue.
export async function pruneCaptures(keep, spared = []) {
  await request([CAPTURES, ANNOTATIONS], 'readwrite', (tx) => {
    const annotated = tx.objectStore(ANNOTATIONS).getAllKeys();
    const all = tx.objectStore(CAPTURES).getAll();
    all.onsuccess = () => {
      const plain = all.result.filter((capture) => !annotated.result.includes(capture.id)).sort(newestFirst);
      for (const old of plain.slice(keep)) if (!spared.includes(old.id)) removeCapture(tx, old.id);
    };
    return all;
  });
}

// Annotations d'une capture, dans l'ordre de création ; [] s'il n'y en a pas.
export async function getAnnotations(captureId) {
  const entry = await onStore(ANNOTATIONS, 'readonly', (store) => store.get(captureId));
  return entry?.items ?? [];
}

// Remplace toute la liste. Une liste vide supprime l'entrée : la capture redevient une capture ordinaire.
// Une capture qui n'existe plus ne reçoit rien et ne revient pas : l'écriture échoue avec CaptureGone.
export async function saveAnnotations(captureId, items) {
  let failure = null;
  const write = request([CAPTURES, ANNOTATIONS], 'readwrite', (tx) => {
    const annotations = tx.objectStore(ANNOTATIONS);
    if (!items.length) return annotations.delete(captureId);
    const found = tx.objectStore(CAPTURES).getKey(captureId);
    found.onsuccess = () => {
      if (found.result === undefined) {
        failure = new CaptureGone();
        return;
      }
      try {
        annotations.put({ captureId, items, updatedAt: Date.now() });
      } catch (err) {
        // Levée dans ce rappel, l'erreur serait perdue : la transaction s'annulerait sans dire pourquoi.
        failure = err;
        tx.abort();
      }
    };
    return found;
  });
  await write.catch((err) => {
    if (!failure) throw err;
  });
  if (failure) throw failure;
}

// Ids des captures qui portent au moins une annotation.
export async function listAnnotatedIds() {
  return new Set(await onStore(ANNOTATIONS, 'readonly', (store) => store.getAllKeys()));
}
