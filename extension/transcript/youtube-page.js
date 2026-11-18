// Fonctions injectées dans la page YouTube de l'onglet temporaire, et seulement là (chrome.scripting.executeScript, world MAIN).
// Chacune est recopiée en texte par Chrome : aucune variable extérieure, aucune aide partagée, tout est défini dedans.
// Règles : ni innerHTML ni DOMParser (Trusted Types de YouTube), aucun nom de classe généré,
// jamais mute() ni setVolume() du lecteur (ils écrivent dans le localStorage partagé de youtube.com).
// Chaque panne rend un code court (`code`) qui dit l'étape qui a échoué.

// Données du lecteur déjà présentes dans la page : état de lecture, en-tête, pistes de sous-titres, chapitres.
export async function pagePlayerData(waitMs = 15000) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const limit = Date.now() + waitMs;
  let response = null;
  while (Date.now() < limit) {
    const player = document.getElementById('movie_player');
    response = player?.getPlayerResponse?.() ?? window.ytInitialPlayerResponse ?? null;
    if (response?.playabilityStatus) break;
    await sleep(200);
  }
  if (!response?.playabilityStatus) return { code: 'player-data' };
  const details = response.videoDetails ?? {};
  const micro = response.microformat?.playerMicroformatRenderer ?? {};
  const text = (value) => value?.simpleText ?? value?.runs?.map((run) => run.text).join('') ?? '';
  const tracks = (response.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []).map((track) => ({
    code: track.languageCode,
    label: text(track.name),
    auto: track.kind === 'asr',
    vss: track.vssId ?? '',
  }));
  // Chapitres affichés sur la barre de progression : ceux de l'auteur d'abord, sinon ceux de YouTube.
  const markers = window.ytInitialData?.playerOverlays?.playerOverlayRenderer?.decoratedPlayerBarRenderer?.decoratedPlayerBarRenderer?.playerBar?.multiMarkersPlayerBarRenderer?.markersMap ?? [];
  const pick = (key) => markers.find((marker) => marker.key === key)?.value?.chapters ?? null;
  const author = pick('DESCRIPTION_CHAPTERS');
  const auto = author ? null : pick('AUTO_CHAPTERS');
  const chapters = (author ?? auto ?? [])
    .map(({ chapterRenderer: chapter }) => ({ start: (chapter?.timeRangeStartMillis ?? 0) / 1000, title: text(chapter?.title) }))
    .filter((chapter) => chapter.title);
  const video = document.querySelector('video');
  return {
    status: response.playabilityStatus.status ?? '',
    reason: text(response.playabilityStatus.reason ? { simpleText: response.playabilityStatus.reason } : response.playabilityStatus.errorScreen?.playerErrorMessageRenderer?.reason),
    videoId: details.videoId ?? '',
    title: details.title ?? '',
    channel: details.author ?? '',
    publishedAt: micro.publishDate ?? micro.uploadDate ?? '',
    durationS: Number(details.lengthSeconds ?? 0),
    live: Boolean(details.isLive),
    upcoming: Boolean(details.isUpcoming),
    tracks,
    chapters,
    chaptersAuto: Boolean(auto && chapters.length),
    // Où en est la vidéo à l'arrivée, relevé sans rien changer.
    playerState: document.getElementById('movie_player')?.getPlayerState?.() ?? null,
    startAtS: video ? video.currentTime : null,
  };
}

// La vidéo ne doit pas tourner. Chrome diffère la lecture dans un onglet jamais affiché ; si elle a démarré quand même, pause.
// Rend l'état relevé avant la pause : `playedMs` est la position atteinte, 0 si rien n'a été lu.
export function pagePreventPlayback() {
  const video = document.querySelector('video');
  const player = document.getElementById('movie_player');
  if (!video) return { paused: true, playedMs: 0, state: player?.getPlayerState?.() ?? null, noVideo: true };
  const before = { paused: video.paused, playedMs: Math.round(video.currentTime * 1000), state: player?.getPlayerState?.() ?? null, ranges: video.played.length };
  if (!video.paused) player?.pauseVideo?.() ?? video.pause();
  return before;
}

// Voie 1 : ouvre le panneau « Transcription » et lit ses lignes. `code` facultatif : la langue demandée au lecteur avant l'ouverture.
export async function pageReadPanel(code = null, waitMs = 30000, buttonMs = 15000) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const seconds = (stamp) => stamp.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  const player = document.getElementById('movie_player');
  if (code) {
    const track = (player?.getOption?.('captions', 'tracklist') ?? []).find((item) => item.languageCode === code) ?? { languageCode: code };
    player?.setOption?.('captions', 'track', track);
  }
  const limit = Date.now() + waitMs;
  const buttonLimit = Date.now() + buttonMs;
  let button = null;
  while (Date.now() < buttonLimit && !button) {
    button = document.querySelector('ytd-video-description-transcript-section-renderer button');
    if (!button) await sleep(250);
  }
  if (!button) return { code: 'panel-button' };
  button.click();
  let count = -1;
  let stableSince = Date.now();
  while (Date.now() < limit) {
    const now = document.querySelectorAll('transcript-segment-view-model').length;
    if (now !== count) {
      count = now;
      stableSince = Date.now();
    } else if (count > 0 && Date.now() - stableSince > 1500) break;
    await sleep(250);
  }
  const rows = [...document.querySelectorAll('transcript-segment-view-model')];
  if (!rows.length) return { code: 'panel-empty', rows: 0 };
  const cues = [];
  for (const row of rows) {
    const stamp = row.querySelector('[aria-hidden="true"]')?.textContent?.trim() ?? '';
    const text = row.querySelector('[role="text"]')?.textContent ?? '';
    if (!/^\d+(:\d{1,2})+$/.test(stamp)) return { code: 'panel-row', rows: rows.length };
    cues.push({ start: seconds(stamp), text: text.replace(/\s+/g, ' ').trim() });
  }
  const chapters = [...document.querySelectorAll('timeline-chapter-view-model')].map((chapter) => chapter.textContent.replace(/\s+/g, ' ').trim());
  return { cues, rows: rows.length, panelChapters: chapters };
}

// Voie 2b : écoute les réponses timedtext de la page, puis allume la piste `code` par l'interface du lecteur pour déclencher le téléchargement.
// `auto` : piste générée automatiquement ; `videoId` écarte les sous-titres d'une publicité. Rend les passages lus dans la réponse json3, ou un code de panne.
export async function pageCaptureTimedtext(videoId, code, auto = false, waitMs = 20000) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const player = document.getElementById('movie_player');
  if (!player?.setOption) return { code: 'player-api' };
  const answers = [];
  const wanted = (url) => {
    try {
      const parsed = new URL(url, location.href);
      // Une publicité a ses propres sous-titres : seule la réponse de la vidéo demandée compte.
      return parsed.pathname === '/api/timedtext' && parsed.searchParams.get('v') === videoId && parsed.searchParams.get('lang') === code;
    } catch {
      return false;
    }
  };
  // Allumer une piste fait écrire au lecteur la langue retenue (`yt-player-caption-*`) dans le localStorage partagé avec l'onglet YouTube de l'utilisateur.
  // Dans cet onglet temporaire seulement, et jusqu'à sa fermeture, ces écritures sont ignorées.
  if (!Storage.prototype.setItem.captureGuard) {
    const setItem = Storage.prototype.setItem;
    const removeItem = Storage.prototype.removeItem;
    const blocked = (key) => String(key).startsWith('yt-player');
    Storage.prototype.setItem = function (key, value) {
      if (this === window.localStorage && blocked(key)) return;
      return setItem.call(this, key, value);
    };
    Storage.prototype.removeItem = function (key) {
      if (this === window.localStorage && blocked(key)) return;
      return removeItem.call(this, key);
    };
    Storage.prototype.setItem.captureGuard = true;
  }
  const xhrOpen = XMLHttpRequest.prototype.open;
  const pageFetch = window.fetch;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (wanted(url)) this.addEventListener('load', () => answers.push({ url: String(url), body: typeof this.response === 'string' ? this.response : this.responseText ?? '' }));
    return xhrOpen.apply(this, arguments);
  };
  window.fetch = async function (input) {
    const response = await pageFetch.apply(this, arguments);
    const url = typeof input === 'string' ? input : input?.url ?? '';
    if (wanted(url)) response.clone().text().then((body) => answers.push({ url, body }), () => {});
    return response;
  };
  let attempts = 0;
  try {
    player.loadModule?.('captions');
    const limit = Date.now() + waitMs;
    // Une réponse vide arrive parfois tout de suite après le chargement : on relance la piste, au plus trois fois.
    while (Date.now() < limit && attempts < 3) {
      attempts++;
      const seen = answers.length;
      // Lecteur pas encore démarré (onglet jamais affiché) : sa liste de pistes est vide, la piste se demande par sa langue.
      const track = (player.getOption('captions', 'tracklist') ?? []).find((item) => item.languageCode === code && (item.kind === 'asr') === auto) ?? { languageCode: code, ...(auto ? { kind: 'asr' } : {}) };
      if (attempts > 1) player.setOption('captions', 'track', {});
      player.setOption('captions', 'track', track);
      const wait = Math.min(limit, Date.now() + 8000);
      while (Date.now() < wait && answers.length === seen) await sleep(150);
      const answer = answers.slice(seen).find((item) => item.body.length > 0);
      if (answer) {
        let data;
        try {
          data = JSON.parse(answer.body);
        } catch {
          return { code: 'timedtext-format', attempts, bytes: answer.body.length, sample: answer.body.slice(0, 80) };
        }
        const cues = (data.events ?? [])
          .filter((event) => event.segs)
          .map((event) => ({
            start: event.tStartMs / 1000,
            end: (event.tStartMs + (event.dDurationMs ?? 0)) / 1000,
            text: event.segs.map((seg) => seg.utf8 ?? '').join('').replace(/\s+/g, ' ').trim(),
          }))
          .filter((cue) => cue.text);
        const fmt = new URL(answer.url, location.href).searchParams.get('fmt') ?? '';
        return { cues, attempts, bytes: answer.body.length, fmt, pot: /[?&]pot=/.test(answer.url) };
      }
    }
    return { code: answers.length ? 'timedtext-empty' : 'timedtext-none', attempts };
  } finally {
    XMLHttpRequest.prototype.open = xhrOpen;
    window.fetch = pageFetch;
  }
}

// Page de consentement aux cookies (Europe, sans connexion) : premier formulaire de consentement, « Tout refuser ».
export function pageConsent() {
  const form = [...document.querySelectorAll('form')].find((item) => /consent/.test(item.action));
  const button = form?.querySelector('button');
  button?.click();
  return Boolean(button);
}
