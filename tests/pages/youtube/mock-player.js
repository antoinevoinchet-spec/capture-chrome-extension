// Lecteur YouTube imité, servi à https://www.youtube.com/watch?v=<id> par context.route (tests/transcription.mjs).
// Il reproduit ce qui a été relevé sur le vrai YouTube : #movie_player et son interface, ytInitialData et ses
// chapitres, le fichier timedtext demandé en XMLHttpRequest quand on allume une piste, l'écriture de la langue retenue dans le
// localStorage, le panneau « Transcription ». Chaque geste notable est signalé au test par /__mock-log (le test le relit même
// après la fermeture de l'onglet temporaire).
(() => {
  const config = window.__case;
  const log = (event, detail = '') => fetch(`/__mock-log?v=${config.id}&event=${encodeURIComponent(event)}&detail=${encodeURIComponent(detail)}`).catch(() => {});
  const params = new URLSearchParams(location.search);

  // Rechargement juste après l'arrivée, comme le vrai (`&themeRefresh=1`).
  if (config.refresh && !params.has('themeRefresh')) {
    setTimeout(() => location.replace(`${location.href}&themeRefresh=1`), 200);
  }

  window.__playStarted = false;
  window.__calls = [];
  // État de la vidéo, pour l'onglet d'origine (« vidéo de l'utilisateur ») : position, lecture, piste, panneau.
  window.__state = { time: Number(params.get('at') ?? 0), playing: params.get('playing') === '1', track: params.get('track') ?? '', panelOpen: false };

  const text = (value) => ({ simpleText: value });
  const response = {
    playabilityStatus: { status: config.status ?? 'OK', ...(config.reason ? { reason: config.reason } : {}) },
    videoDetails: {
      videoId: config.id,
      title: config.title ?? 'Vidéo imitée',
      author: config.channel ?? 'Chaîne imitée',
      lengthSeconds: String(config.durationS ?? 0),
      isLive: Boolean(config.live),
      isUpcoming: Boolean(config.upcoming),
    },
    microformat: { playerMicroformatRenderer: { publishDate: config.publishedAt ?? '2024-03-05' } },
    captions: config.tracks?.length
      ? {
          playerCaptionsTracklistRenderer: {
            captionTracks: config.tracks.map((track) => ({
              languageCode: track.code,
              name: text(track.label),
              ...(track.auto ? { kind: 'asr' } : {}),
              vssId: `${track.auto ? 'a' : ''}.${track.code}`,
            })),
          },
        }
      : undefined,
  };
  window.ytInitialPlayerResponse = response;
  const chapters = (config.chapters ?? []).map((chapter) => ({ chapterRenderer: { title: text(chapter.title), timeRangeStartMillis: chapter.start * 1000 } }));
  window.ytInitialData = {
    playerOverlays: {
      playerOverlayRenderer: {
        decoratedPlayerBarRenderer: {
          decoratedPlayerBarRenderer: {
            playerBar: {
              multiMarkersPlayerBarRenderer: {
                markersMap: chapters.length ? [{ key: config.chaptersAuto ? 'AUTO_CHAPTERS' : 'DESCRIPTION_CHAPTERS', value: { chapters } }] : [],
              },
            },
          },
        },
      },
    },
  };

  const requestCaptions = (videoId, code, auto) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `/api/timedtext?v=${videoId}&lang=${code}${auto ? '&kind=asr' : ''}&fmt=json3&pot=mock`);
    xhr.send();
  };

  const player = document.getElementById('movie_player');
  let adDone = false;
  Object.assign(player, {
    getPlayerResponse: () => response,
    getPlayerState: () => (window.__state.playing ? 1 : -1),
    getCurrentTime: () => window.__state.time,
    // Lecteur pas encore démarré : liste de pistes vide, comme le vrai dans un onglet jamais affiché.
    getOption: (module, option) => (module === 'captions' && option === 'tracklist' ? [] : undefined),
    loadModule: () => {},
    setOption: (module, option, track) => {
      if (module !== 'captions' || option !== 'track') return;
      window.__calls.push(['setOption', track]);
      log('setOption', track?.languageCode ?? '');
      if (!track?.languageCode) return;
      window.__state.track = track.languageCode;
      // Comme le vrai lecteur : la langue retenue va dans le localStorage partagé de youtube.com.
      localStorage.setItem('yt-player-caption-sticky-language', JSON.stringify({ data: track.languageCode, creation: Date.now() }));
      if (config.ad && !adDone) {
        adDone = true;
        requestCaptions(config.ad, track.languageCode, track.kind === 'asr');
      }
      requestCaptions(config.id, track.languageCode, track.kind === 'asr');
    },
    pauseVideo: () => {
      window.__state.playing = false;
      log('pause');
    },
    playVideo: () => {
      window.__playStarted = true;
      window.__state.playing = true;
      log('play');
    },
    mute: () => {
      window.__calls.push(['mute']);
      log('mute');
      localStorage.setItem('yt-player-muted', 'true');
    },
    setVolume: (volume) => {
      window.__calls.push(['setVolume', volume]);
      log('setVolume', String(volume));
      localStorage.setItem('yt-player-volume', JSON.stringify({ data: { volume, muted: false } }));
    },
  });
  if (config.autoplay) player.playVideo();

  // Panneau « Transcription » : un bouton dans la description, des lignes `transcript-segment-view-model` à l'ouverture.
  if (config.panel !== 'missing') {
    const section = document.createElement('ytd-video-description-transcript-section-renderer');
    const button = document.createElement('button');
    button.textContent = 'Afficher la transcription';
    button.addEventListener('click', () => {
      window.__state.panelOpen = true;
      log('panel');
      if (config.panel === 'empty') return;
      setTimeout(() => {
        const list = document.getElementById('panel');
        const clock = (s) => {
          const total = Math.floor(s);
          const h = Math.floor(total / 3600);
          const m = Math.floor((total % 3600) / 60);
          const sec = String(total % 60).padStart(2, '0');
          return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
        };
        for (const cue of config.panelCues ?? []) {
          const row = document.createElement('transcript-segment-view-model');
          const stamp = document.createElement('span');
          stamp.setAttribute('aria-hidden', 'true');
          stamp.textContent = clock(cue.start);
          const words = document.createElement('span');
          words.setAttribute('role', 'text');
          words.textContent = cue.text;
          row.append(stamp, words);
          list.append(row);
        }
      }, 300);
    });
    section.append(button);
    document.getElementById('description').append(section);
  }
  log('load', location.search);
})();
