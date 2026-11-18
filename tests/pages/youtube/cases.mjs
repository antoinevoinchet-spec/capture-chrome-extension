// Vidéos imitées pour les tests de transcription : une par cas à vérifier. Servies par `youtubeRoute`.
// Les identifiants ont 11 caractères, comme les vrais.

import fs from 'node:fs/promises';
import path from 'node:path';

const HERE = import.meta.dirname;

const FR = ['Bonjour et bienvenue.', 'Aujourd’hui on parle de café &amp; de thé.', 'Premier point : la mouture.', 'Ensuite, l’eau chaude.', 'Deuxième partie : le goût.', 'Merci d’avoir regardé.'];
const EN = ['Hello and welcome.', 'Today we talk about coffee &amp; tea.', 'First point: the grind.', 'Then, hot water.', 'Part two: the taste.', 'Thanks for watching.'];
const STARTS = [0.5, 4.2, 9.0, 30.0, 70.0, 120.0];

export const cuesOf = (texts, starts = STARTS) => texts.map((text, i) => ({ start: starts[i], end: starts[i] + 3.5, text }));
// Ce que la page de transcription doit lire, entités décodées.
export const FR_TEXTS = FR.map((text) => text.replace('&amp;', '&'));
export const EN_TEXTS = EN.map((text) => text.replace('&amp;', '&'));

const base = {
  title: 'Le café expliqué',
  channel: 'Chaîne imitée',
  publishedAt: '2024-03-05',
  durationS: 130,
  status: 'OK',
  tracks: [
    { code: 'fr', label: 'Français', auto: false },
    { code: 'en', label: 'Anglais', auto: false },
  ],
  captions: { fr: cuesOf(FR), en: cuesOf(EN) },
  panelCues: cuesOf(FR).map(({ start, text }) => ({ start: Math.floor(start), text: text.replace('&amp;', '&') })),
  chapters: [
    { start: 0, title: 'Introduction' },
    { start: 60, title: 'Le goût' },
  ],
  chaptersAuto: false,
};

const long = Array.from({ length: 2500 }, (_, i) => ({ start: i * 4.3, end: i * 4.3 + 4, text: `Passage numéro ${i + 1} de la longue vidéo.` }));

export const CASES = {
  manuel00001: { ...base },
  autoseul001: { ...base, tracks: [{ code: 'fr', label: 'Français (générés automatiquement)', auto: true }], captions: { 'a.fr': cuesOf(FR) } },
  chapauto001: { ...base, chaptersAuto: true },
  sanschap001: { ...base, chapters: [] },
  sanssous001: { ...base, tracks: [], captions: {}, panel: 'missing' },
  change00001: { ...base, timedtext: 'empty', panel: 'empty' },
  secours0001: { ...base, timedtext: 'empty' },
  privee00001: { ...base, status: 'ERROR', reason: 'Vidéo privée', tracks: [], durationS: 0 },
  direct00001: { ...base, live: true, durationS: 0, tracks: [] },
  premiere001: { ...base, status: 'LIVE_STREAM_OFFLINE', upcoming: true, reason: 'La première aura lieu dans 3 heures', tracks: [] },
  age00000001: { ...base, status: 'LOGIN_REQUIRED', reason: 'Confirmez votre âge', tracks: [] },
  membres0001: { ...base, status: 'UNPLAYABLE', reason: 'Rejoignez cette chaîne pour devenir membre et accéder à ce contenu', tracks: [] },
  pays0000001: { ...base, status: 'UNPLAYABLE', reason: 'Le propriétaire de cette vidéo ne l’a pas rendue disponible dans votre pays', tracks: [] },
  jamais00001: { ...base, document: 'never' },
  lent0000001: { ...base, timedtext: 'never', panel: 'missing' },
  incomplet01: { ...base, durationS: 600 },
  troisheures: { ...base, durationS: 10800, captions: { fr: long, en: long }, chapters: [{ start: 0, title: 'Début' }, { start: 5400, title: 'Milieu' }] },
  pub00000001: { ...base, ad: 'annonce0001' },
  recharge001: { ...base, refresh: true },
  langlent001: { ...base, neverLang: 'en' },
  robot000001: { ...base, status: 'LOGIN_REQUIRED', reason: 'Connectez-vous pour confirmer que vous n’êtes pas un robot', tracks: [] },
  secourslen1: { ...base, timedtext: 'empty', panel: 'empty' },
};

const AD_CUES = [{ start: 0, end: 5, text: 'Publicité : achetez maintenant !' }];

const json3 = (cues) => JSON.stringify({ events: cues.map((cue) => ({ tStartMs: Math.round(cue.start * 1000), dDurationMs: Math.round((cue.end - cue.start) * 1000), segs: [{ utf8: cue.text }] })) });

function pageFor(id, config) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${config.title} - YouTube</title></head>
<body><div id="movie_player"><video></video></div><div id="description"></div><div id="panel"></div>
<script>window.__case = ${JSON.stringify({ id, ...config })};</script><script src="/mock-player.js"></script></body></html>`;
}

// Branche le faux YouTube sur un contexte Playwright. `log` reçoit les gestes signalés par les pages ({ v, event, detail, at }).
export async function youtubeRoute(context, log = []) {
  const player = await fs.readFile(path.join(HERE, 'mock-player.js'), 'utf8');
  await context.route('https://www.youtube.com/**', async (route) => {
    const url = new URL(route.request().url());
    const v = url.searchParams.get('v') ?? '';
    if (url.pathname === '/mock-player.js') return route.fulfill({ contentType: 'text/javascript', body: player });
    if (url.pathname === '/__mock-log') {
      log.push({ v, event: url.searchParams.get('event'), detail: url.searchParams.get('detail'), at: Date.now() });
      return route.fulfill({ status: 204 });
    }
    if (url.pathname === '/api/timedtext') {
      const owner = Object.entries(CASES).find(([, config]) => config.ad === v);
      if (owner) return route.fulfill({ contentType: 'application/json', body: json3(AD_CUES) });
      const config = CASES[v];
      if (!config) return route.fulfill({ status: 404, body: '' });
      if (config.timedtext === 'never') return; // ne répond jamais
      if (config.timedtext === 'empty') return route.fulfill({ contentType: 'application/json', body: '' });
      const key = `${url.searchParams.get('kind') === 'asr' ? 'a.' : ''}${url.searchParams.get('lang')}`;
      if (config.neverLang === key) return; // cette langue ne répond jamais
      return route.fulfill({ contentType: 'application/json', body: config.captions[key] ? json3(config.captions[key]) : '' });
    }
    if (url.pathname === '/watch') {
      const config = CASES[v];
      if (!config) return route.fulfill({ status: 404, contentType: 'text/html', body: '<!doctype html><title>404</title>' });
      if (config.document === 'never') return; // la page ne répond jamais
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: pageFor(v, config) });
    }
    return route.fulfill({ status: 204 });
  });
}
