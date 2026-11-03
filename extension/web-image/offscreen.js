// Page invisible de l'extension : un service worker n'a pas URL.createObjectURL, ni Worker. Première version, pour l'essai de la tâche 2.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'web-image-offscreen') return false;
  fetchAsBlobUrl(msg.url).then(sendResponse, (err) => sendResponse({ error: String(err?.message ?? err) }));
  return true;
});

async function fetchAsBlobUrl(url) {
  const response = await fetch(url, { credentials: 'include' });
  const blob = await response.blob();
  return { status: response.status, type: blob.type, size: blob.size, blobUrl: URL.createObjectURL(blob) };
}
