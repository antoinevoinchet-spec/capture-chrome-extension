// Attend que le fichier d'un téléchargement soit vraiment écrit. Rend le problème rencontré, écrit pour l'utilisateur, ou une chaîne vide.
// Il est peut-être déjà arrivé au moment de la question.

function problemOf(error) {
  if (error === 'FILE_NO_SPACE') return 'ton disque est plein. Libère de la place et réessaie.';
  if (error === 'USER_CANCELED') return 'le téléchargement a été annulé dans Chrome.';
  return 'Chrome n’a pas pu écrire le fichier. Réessaie.';
}

export function downloadEnd(id) {
  return new Promise((resolve) => {
    const finish = (problem) => {
      chrome.downloads.onChanged.removeListener(listener);
      resolve(problem);
    };
    const listener = (delta) => {
      if (delta.id !== id || !delta.state || delta.state.current === 'in_progress') return;
      finish(delta.state.current === 'complete' ? '' : problemOf(delta.error?.current));
    };
    chrome.downloads.onChanged.addListener(listener);
    chrome.downloads.search({ id }).then(([found]) => {
      if (!found || found.state === 'complete') finish('');
      else if (found.state === 'interrupted') finish(problemOf(found.error));
    });
  });
}
