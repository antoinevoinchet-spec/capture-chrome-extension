// Historique local des captures (IndexedDB) : partagé entre le service worker et les pages de l'extension.

const DB_NAME = 'capture';
const STORE = 'captures';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function request(mode, makeRequest) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = makeRequest(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? req.error);
    });
  } finally {
    db.close();
  }
}

export async function saveCapture(record) {
  const id = crypto.randomUUID();
  await request('readwrite', (store) => store.put({ ...record, id }));
  return id;
}

export const getCapture = (id) => request('readonly', (store) => store.get(id));

export const deleteCapture = (id) => request('readwrite', (store) => store.delete(id));

export async function listCaptures() {
  const all = await request('readonly', (store) => store.getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function pruneCaptures(keep) {
  const all = await listCaptures();
  for (const old of all.slice(keep)) await deleteCapture(old.id);
}
