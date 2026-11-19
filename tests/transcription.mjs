// Tests de la transcription YouTube.
// Usage : node transcription.mjs <dossier de sortie> [format|base|lecture|page|fenetre|historique|reel] [motif]
// `reel` (le vrai YouTube) ne tourne que si on le nomme. `format` tourne sous Node, sans navigateur.

import fs from 'node:fs/promises';
import path from 'node:path';
import { check, extensionPage, launch, prepareExtension, results } from './lib.mjs';

const HERE = import.meta.dirname;
const WORK = path.resolve(process.argv[2] ?? path.join(HERE, 'out-transcription'));
const ONLY = process.argv[3];
const NAMED = process.argv[4] ? new RegExp(process.argv[4], 'i') : null;
// Un profil neuf à chaque lancement : un profil réutilisé garde en cache l'ancien service worker de l'extension (vu le 2026-11-18).
const RUN = Date.now().toString(36);

async function test(name, body) {
  if (NAMED && !NAMED.test(name)) return;
  try {
    const { ok, detail } = await body();
    check(name, ok, detail);
  } catch (err) {
    check(name, false, String(err.message ?? err).split('\n')[0].slice(0, 240));
  }
}

const short = (value) => JSON.stringify(value)?.slice(0, 700);

// Une transcription type, au modèle de format.js : 2 chapitres, des passages avec début et fin (voie 2b).
function sample(patch = {}) {
  const cues = [
    { start: 0.5, end: 3.2, text: 'Bonjour à tous.' },
    { start: 3.4, end: 6.0, text: 'Aujourd’hui on parle de café.' },
    { start: 6.1, end: 9.0, text: 'Premier point : la mouture.' },
    // Pause de 6 s : nouveau paragraphe.
    { start: 15.0, end: 18.0, text: 'Ensuite, l’eau.' },
    { start: 18.1, end: 21.0, text: 'Elle doit être chaude.' },
    { start: 65.0, end: 68.0, text: 'Deuxième partie.' },
    { start: 68.1, end: 3725.0, text: 'Et on finit après une heure.' },
  ];
  return {
    videoId: 'dQw4w9WgXcQ',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    title: 'Le café expliqué',
    channel: 'Chaîne Test',
    publishedAt: '2024-03-05',
    durationS: 3730,
    lang: 'fr',
    langLabel: 'Français',
    auto: false,
    languages: [{ code: 'fr', label: 'Français', auto: false }],
    chapters: [
      { start: 0, title: 'Introduction' },
      { start: 60, title: 'La suite' },
    ],
    chaptersAuto: false,
    cues,
    complete: true,
    stopsAtS: 68.1,
    route: 'timedtext',
    createdAt: Date.now(),
    ...patch,
  };
}

async function groupFormat() {
  let url, fmt;
  try {
    url = await import('../extension/transcript/youtube-url.js');
    fmt = await import('../extension/transcript/format.js');
  } catch (err) {
    return check('modules youtube-url.js et format.js importables sous Node', false, String(err.message).split('\n')[0]);
  }
  const { parseVideoUrl, watchUrl, TranscriptError } = url;
  const ID = 'dQw4w9WgXcQ';

  const accepted = [
    `https://www.youtube.com/watch?v=${ID}&t=42s&list=PL1`,
    `youtu.be/${ID}?si=x`,
    `https://youtube.com/shorts/${ID}`,
    `https://m.youtube.com/watch?v=${ID}`,
    `   https://www.youtube.com/watch?v=${ID}  \n`,
  ];
  for (const text of accepted) {
    await test(`adresse acceptée : ${text.trim()}`, () => {
      const got = parseVideoUrl(text);
      return { ok: got?.videoId === ID, detail: short(got) };
    });
  }

  const refused = [
    `https://music.youtube.com/watch?v=${ID}`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    'https://www.youtube.com/playlist?list=PL1',
    'https://vimeo.com/1',
    'bonjour',
  ];
  for (const text of refused) {
    await test(`adresse refusée avec un message en français : ${text}`, () => {
      try {
        const got = parseVideoUrl(text);
        return { ok: false, detail: `acceptée : ${short(got)}` };
      } catch (err) {
        const ok = err instanceof TranscriptError && /[a-zà-ÿ]/i.test(err.message) && /vidéo|lien|YouTube/.test(err.message);
        return { ok, detail: err.message };
      }
    });
  }

  await test('watchUrl sans t= ni list=', () => {
    const got = watchUrl(ID);
    return { ok: got === `https://www.youtube.com/watch?v=${ID}`, detail: got };
  });

  await test('Markdown : en-tête dans l’ordre titre, chaîne, date, durée, lien, langue', () => {
    const out = fmt.render(sample(), { format: 'markdown', times: 'paragraph' });
    const lines = out.split('\n');
    const order = ['Chaîne Test', '5 mars 2024', '1:02:10', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'Français'].map((part) => out.indexOf(part));
    const ok = lines[0] === '# Le café expliqué' && order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])) && !/automatiques/.test(out);
    return { ok, detail: short(lines.slice(0, 8)) };
  });

  await test('en-tête : « sous-titres automatiques » et « chapitres automatiques »', () => {
    const out = fmt.render(sample({ auto: true, chaptersAuto: true }), { format: 'markdown', times: 'paragraph' });
    const head = out.split('\n## ')[0];
    return { ok: /sous-titres automatiques/.test(head) && /chapitres automatiques/i.test(head), detail: short(head) };
  });

  await test('chapitres : ## avant le premier paragraphe à leur heure ou après', () => {
    const out = fmt.render(sample(), { format: 'markdown', times: 'none' });
    const intro = out.indexOf('## Introduction');
    const suite = out.indexOf('## La suite');
    const ok = intro > 0 && suite > intro && out.indexOf('Bonjour') > intro && out.indexOf('Elle doit être chaude') < suite && out.indexOf('Deuxième partie') > suite;
    return { ok, detail: `${intro} ${suite}` };
  });

  await test('sans chapitres : aucun ##', () => {
    const out = fmt.render(sample({ chapters: [] }), { format: 'markdown', times: 'paragraph' });
    return { ok: !/^##/m.test(out), detail: short(out.slice(0, 120)) };
  });

  await test('repères par paragraphe : un par paragraphe, [1:02:03] au-delà d’une heure', () => {
    const t = sample();
    const out = fmt.render(t, { format: 'markdown', times: 'paragraph' });
    const marks = out.match(/\[\d+:\d{2}(?::\d{2})?\]/g) ?? [];
    const count = fmt.paragraphs(t).length;
    const long = fmt.render(sample({ cues: [{ start: 3723, end: 3725, text: 'Tard.' }], chapters: [] }), { format: 'markdown', times: 'paragraph' });
    return { ok: marks.length === count && marks[0] === '[0:00]' && /\[1:02:03\] Tard\./.test(long), detail: `${marks.length}/${count} ${marks.join(' ')}` };
  });

  await test('repères par passage : un par passage', () => {
    const t = sample();
    const marks = fmt.render(t, { format: 'markdown', times: 'cue' }).match(/\[\d+:\d{2}(?::\d{2})?\]/g) ?? [];
    return { ok: marks.length === t.cues.length, detail: `${marks.length}/${t.cues.length}` };
  });

  await test('sans repères : aucun', () => {
    const out = fmt.render(sample(), { format: 'markdown', times: 'none' });
    return { ok: !/\[\d+:\d{2}/.test(out) && /Bonjour à tous\./.test(out), detail: short(out.slice(-120)) };
  });

  await test('texte simple : ni #, ni **, ni lien Markdown', () => {
    const out = fmt.render(sample({ auto: true, chaptersAuto: true }), { format: 'text', times: 'paragraph' });
    // Un titre qui contient lui-même # ou * reste tel quel en texte simple : rien n'est échappé.
    const raw = fmt.render(sample({ title: 'Test #1 : *gras* [y]' }), { format: 'text', times: 'none' });
    const ok = !out.includes('#') && !out.includes('**') && !/\]\(/.test(out) && /Introduction/.test(out) && /Bonjour/.test(out) && raw.startsWith('Test #1 : *gras* [y]\n') && !raw.includes('\\');
    return { ok, detail: short(out.slice(0, 160)) };
  });

  await test('titre à caractères Markdown : échappés dans l’en-tête', () => {
    const out = fmt.render(sample({ title: 'Test #1 : *gras* _x_ [y] / 🎬' }), { format: 'markdown', times: 'paragraph' });
    const first = out.split('\n')[0];
    return { ok: first === '# Test \\#1 : \\*gras\\* \\_x\\_ \\[y\\] / 🎬', detail: first };
  });

  await test('fileBase : ni / ni : dans le nom', () => {
    const got = fmt.fileBase(sample({ title: 'Test #1 : *gras* _x_ [y] / 🎬' }));
    return { ok: !/[/:]/.test(got) && got.startsWith('Test #1') && got.includes('🎬'), detail: got };
  });

  await test('fileBase : les points du titre sont gardés', () => {
    const a = fmt.fileBase(sample({ title: 'Node.js en 100 s' }));
    const b = fmt.fileBase(sample({ title: 'Vol. 2' }));
    return { ok: a === 'Node.js en 100 s' && b === 'Vol. 2', detail: `${a} | ${b}` };
  });

  await test('fileBase : titre vide → transcription', () => {
    const a = fmt.fileBase(sample({ title: '' }));
    const b = fmt.fileBase(sample({ title: '   ' }));
    const c = fmt.fileBase(sample({ title: '...' }));
    return { ok: a === 'transcription' && b === 'transcription' && c === 'transcription', detail: `${a} | ${b} | ${c}` };
  });

  await test('fileBase : titre de 250 caractères coupé par cleanBase', async () => {
    const { cleanBase } = await import('../extension/lib/file-name.js');
    const title = 'a'.repeat(250);
    const got = fmt.fileBase(sample({ title }));
    return { ok: got === cleanBase(`${title}.x`) && got.length < 250, detail: String(got.length) };
  });

  await test('cleanCueText : entités, retours à la ligne, marqueurs gardés', () => {
    const got = fmt.cleanCueText('Tom &amp; Jerry&#39;s\n[Musique]');
    const more = fmt.cleanCueText('  a&nbsp;b &quot;c&quot; &#x27;d&#x27; &lt;e&gt;\n\n f &amp;amp; ');
    return { ok: got === "Tom & Jerry's [Musique]" && more === 'a b "c" \'d\' <e> f &amp;', detail: `${got} | ${more}` };
  });

  await test('withEnds : fin du suivant, la durée au dernier, fins données gardées', () => {
    const got = fmt.withEnds([{ start: 1, text: 'a' }, { start: 4.5, text: 'b' }, { start: 9, end: 10, text: 'c' }, { start: 12, text: 'd' }], 20);
    const ok = got[0].end === 4.5 && got[1].end === 9 && got[2].end === 10 && got[3].end === 20;
    return { ok, detail: short(got.map((cue) => cue.end)) };
  });

  await test('toSrt : numéros, temps, fins après débuts, ligne vide entre deux blocs', () => {
    const srt = fmt.toSrt(sample({ cues: [{ start: 1, text: 'Un' }, { start: 4.5, text: 'Deux\net trois' }, { start: 4.5, text: 'Même seconde' }], durationS: 10 }));
    const blocks = srt.trim().split('\n\n');
    const parse = (stamp) => {
      const [h, m, rest] = stamp.split(':');
      const [s, ms] = rest.split(',');
      return ((+h * 60 + +m) * 60 + +s) * 1000 + +ms;
    };
    const ok =
      blocks.length === 3 &&
      blocks.every((block, i) => {
        const [num, times, text, extra] = block.split('\n');
        const match = /^(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})$/.exec(times ?? '');
        return num === String(i + 1) && match && parse(match[2]) > parse(match[1]) && text && extra === undefined;
      }) &&
      srt.startsWith('1\n00:00:01,000 --> 00:00:04,500\nUn\n\n2\n');
    return { ok, detail: short(srt) };
  });

  await test('paragraphes : aucun au-delà de la limite', () => {
    const cues = Array.from({ length: 200 }, (_, i) => ({ start: i * 2, end: i * 2 + 1.9, text: `Phrase numéro ${i} qui parle de choses et d’autres.` }));
    const list = fmt.paragraphs(sample({ cues, chapters: [], durationS: 400 }));
    const longest = Math.max(...list.map((p) => p.text.length));
    const all = list.map((p) => p.text).join(' ');
    return { ok: longest <= fmt.PARAGRAPH_MAX && list.length > 5 && all.includes('Phrase numéro 0 ') && all.includes('Phrase numéro 199 '), detail: `${list.length} paragraphes, plus long ${longest}` };
  });

  await test('paragraphes : coupure à chaque chapitre et à une longue pause', () => {
    const list = fmt.paragraphs(sample());
    const texts = list.map((p) => p.text);
    const ok =
      list.length === 3 &&
      list[0].chapter === 'Introduction' &&
      texts[0].endsWith('la mouture.') &&
      texts[1].startsWith('Ensuite') &&
      !list[1].chapter &&
      list[2].chapter === 'La suite' &&
      list[2].start === 65;
    return { ok, detail: short(list.map((p) => [p.chapter, p.start, p.text.slice(0, 20)])) };
  });

  await test('paragraphes : pas de coupure à la pause sans heures de fin (panneau)', () => {
    const t = sample({ route: 'panel', chapters: [] });
    t.cues = t.cues.slice(0, 5).map(({ start, text }) => ({ start: Math.floor(start), text }));
    const list = fmt.paragraphs(t);
    return { ok: list.length === 1, detail: String(list.length) };
  });

  await test('isComplete : dernier passage à au plus 60 s de la fin', () => {
    const cues = [{ start: 0, text: 'a' }, { start: 540, text: 'b' }];
    const yes = fmt.isComplete(cues, 600);
    const no = fmt.isComplete(cues, 601);
    const empty = fmt.isComplete([], 600);
    return { ok: yes === true && no === false && empty === false, detail: `${yes} ${no} ${empty}` };
  });

  await test('texte incomplet : l’en-tête le dit, avec l’heure d’arrêt', () => {
    const out = fmt.render(sample({ complete: false, stopsAtS: 754 }), { format: 'markdown', times: 'paragraph' });
    return { ok: /peut-être incomplète/.test(out.split('\n## ')[0]) && out.includes('12:34'), detail: short(out.slice(0, 300)) };
  });

  await test('langue par défaut : celle du navigateur, sinon la langue parlée (piste automatique), sinon la première', async () => {
    const { defaultTrack } = await import('../extension/transcript/reader.js');
    const t = (key) => ({ code: key.replace('a.', ''), auto: key.startsWith('a.'), label: key });
    const pick = (keys) => {
      const got = defaultTrack(keys.map(t), 'fr-FR');
      return `${got.auto ? 'a.' : ''}${got.code}`;
    };
    const got = [pick(['de-DE', 'ja', 'en', 'a.en']), pick(['en', 'fr']), pick(['a.fr', 'en']), pick(['de', 'es']), pick(['a.en']), pick(['de', 'a.en'])];
    return { ok: got.join() === 'en,fr,a.fr,de,a.en,a.en', detail: got.join() };
  });

  await test('passages vides retirés partout', () => {
    const t = sample({ cues: [{ start: 1, end: 2, text: 'Un' }, { start: 2, end: 3, text: '\n' }, { start: 3, end: 4, text: 'Deux' }], chapters: [] });
    const srt = fmt.toSrt(t);
    const out = fmt.render(t, { format: 'text', times: 'cue' });
    return { ok: srt.trim().split('\n\n').length === 2 && (out.match(/\[0:0\d\]/g) ?? []).length === 2, detail: short(out) };
  });
}

// --- Magasin des transcriptions et réglages ---

// Repart d'une base vide : db.js ferme sa connexion après chaque appel, rien ne doit la retenir.
function resetDb(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.deleteDatabase('capture');
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('base retenue par une connexion ouverte'));
      }),
  );
}

// Base telle que la version 0.5.0 la laisse : version 2, captures et annotations. Rendue fermée.
const OLD_DB = `() => new Promise((resolve, reject) => {
  const req = indexedDB.open('capture', 2);
  req.onupgradeneeded = () => {
    req.result.createObjectStore('captures', { keyPath: 'id' });
    req.result.createObjectStore('annotations', { keyPath: 'captureId' });
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
})`;

async function groupBase() {
  const extension = await prepareExtension(WORK);
  const context = await launch(extension, `profile-base-${RUN}`, WORK);
  try {
    const page = await extensionPage(context, 'popup/popup.html');
    const other = await extensionPage(context, 'popup/popup.html');

    await test('base : une connexion en version 2 qui se ferme sur demande n’empêche pas la version 3', async () => {
      await resetDb(page);
      await other.evaluate(`(${OLD_DB})().then((db) => { db.onversionchange = () => db.close(); window.__old = db; })`);
      const got = await page.evaluate(async () => {
        const db = await import(chrome.runtime.getURL('lib/db.js'));
        const started = Date.now();
        const list = await Promise.race([db.listTranscripts(), new Promise((resolve) => setTimeout(() => resolve('attente'), 5000))]);
        return { list, ms: Date.now() - started };
      });
      return { ok: Array.isArray(got.list) && got.list.length === 0, detail: short(got) };
    });

    await test('base : une connexion ancienne qui reste ouverte donne un message clair, sans attente sans fin', async () => {
      await resetDb(page);
      await other.evaluate(`(${OLD_DB})().then((db) => { window.__stuck = db; })`);
      const got = await page.evaluate(async () => {
        const db = await import(chrome.runtime.getURL('lib/db.js'));
        try {
          const list = await Promise.race([db.listTranscripts(), new Promise((resolve) => setTimeout(() => resolve('attente'), 5000))]);
          return { list };
        } catch (err) {
          return { message: err.message };
        }
      });
      await other.evaluate(() => window.__stuck?.close());
      return { ok: /onglet/.test(got.message ?? '') && /[éè]/.test(got.message), detail: short(got) };
    });

    await test('base : une base de version 2 garde ses 2 captures et son annotation', async () => {
      await resetDb(page);
      const got = await page.evaluate(async (oldDb) => {
        const old = await eval(oldDb)();
        await new Promise((resolve, reject) => {
          const tx = old.transaction(['captures', 'annotations'], 'readwrite');
          tx.objectStore('captures').put({ id: 'c1', title: 'Un', createdAt: 1, slices: [] });
          tx.objectStore('captures').put({ id: 'c2', title: 'Deux', createdAt: 2, slices: [] });
          tx.objectStore('annotations').put({ captureId: 'c1', items: [{ id: 'a1', type: 'rect' }], updatedAt: 3 });
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
        old.close();
        const db = await import(chrome.runtime.getURL('lib/db.js'));
        const captures = (await db.listCaptures()).map((c) => c.id);
        const annotations = await db.getAnnotations('c1');
        await db.saveTranscript({ videoId: 'v1', title: 'T', createdAt: 5, cues: [] });
        const opened = await new Promise((resolve, reject) => {
          const req = indexedDB.open('capture');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        const state = { version: opened.version, stores: [...opened.objectStoreNames].sort() };
        opened.close();
        return { captures, annotations: annotations.length, ...state };
      }, OLD_DB);
      const ok = got.captures.join() === 'c2,c1' && got.annotations === 1 && got.version === 3 && got.stores.join() === 'annotations,captures,transcripts';
      return { ok, detail: short(got) };
    });

    await test('base : 31 transcriptions enregistrées, les 30 plus récentes restent', async () => {
      await resetDb(page);
      const got = await page.evaluate(async () => {
        const db = await import(chrome.runtime.getURL('lib/db.js'));
        for (let i = 0; i < 31; i++) await db.saveTranscript({ videoId: `vid${String(i).padStart(8, '0')}`, title: `T${i}`, createdAt: 1000 + i, cues: [] });
        const list = await db.listTranscripts();
        return { count: list.length, keep: db.KEEP_TRANSCRIPTS, first: list[0]?.title, last: list.at(-1)?.title, oldest: await db.getTranscript('vid00000000') };
      });
      return { ok: got.count === 30 && got.keep === 30 && got.first === 'T30' && got.last === 'T1' && got.oldest === undefined, detail: short(got) };
    });

    await test('base : pruneCaptures(15) laisse 15 captures et ne touche aucune transcription', async () => {
      await resetDb(page);
      const got = await page.evaluate(async () => {
        const db = await import(chrome.runtime.getURL('lib/db.js'));
        for (let i = 0; i < 3; i++) await db.saveTranscript({ videoId: `vid${String(i).padStart(8, '0')}`, title: `T${i}`, createdAt: i, cues: [] });
        for (let i = 0; i < 16; i++) await db.saveCapture({ title: `C${i}`, createdAt: 100 + i, slices: [] });
        await db.pruneCaptures(15);
        return { captures: (await db.listCaptures()).length, transcripts: (await db.listTranscripts()).length };
      });
      return { ok: got.captures === 15 && got.transcripts === 3, detail: short(got) };
    });

    await test('base : même vidéo enregistrée en fr puis en en, une seule entrée, en en', async () => {
      await resetDb(page);
      const got = await page.evaluate(async () => {
        const db = await import(chrome.runtime.getURL('lib/db.js'));
        await db.saveTranscript({ videoId: 'dQw4w9WgXcQ', lang: 'fr', createdAt: 1, cues: [{ start: 0, end: 1, text: 'Bonjour' }] });
        await db.saveTranscript({ videoId: 'dQw4w9WgXcQ', lang: 'en', createdAt: 2, cues: [{ start: 0, end: 1, text: 'Hello' }] });
        const list = await db.listTranscripts();
        const full = await db.getTranscript('dQw4w9WgXcQ');
        return { count: list.length, lang: list[0]?.lang, text: full?.cues?.[0]?.text };
      });
      return { ok: got.count === 1 && got.lang === 'en' && got.text === 'Hello', detail: short(got) };
    });

    await test('base : listTranscripts sans passages, deleteTranscript retire l’entrée', async () => {
      await resetDb(page);
      const got = await page.evaluate(async () => {
        const db = await import(chrome.runtime.getURL('lib/db.js'));
        await db.saveTranscript({ videoId: 'aaaaaaaaaaa', title: 'A', createdAt: 1, cues: [{ start: 0, end: 1, text: 'x' }] });
        await db.saveTranscript({ videoId: 'bbbbbbbbbbb', title: 'B', createdAt: 2, cues: [{ start: 0, end: 1, text: 'y' }] });
        const list = await db.listTranscripts();
        await db.deleteTranscript('aaaaaaaaaaa');
        const after = await db.listTranscripts();
        return { hasCues: list.some((t) => 'cues' in t), titles: list.map((t) => t.title), after: after.map((t) => t.videoId), gone: await db.getTranscript('aaaaaaaaaaa') };
      });
      return { ok: !got.hasCues && got.titles.join() === 'B,A' && got.after.join() === 'bbbbbbbbbbb' && got.gone === undefined, detail: short(got) };
    });

    await test('réglages : paragraph et markdown par défaut, markdown pour une valeur inconnue', async () => {
      const got = await page.evaluate(async () => {
        const { loadSettings, saveSettings } = await import(chrome.runtime.getURL('lib/settings.js'));
        await chrome.storage.sync.clear();
        const fresh = await loadSettings();
        await saveSettings({ transcriptFormat: 'xyz', transcriptTimes: 'cue' });
        const odd = await loadSettings();
        await saveSettings({ transcriptFormat: 'text', transcriptTimes: 'abc' });
        const other = await loadSettings();
        await chrome.storage.sync.clear();
        return { fresh, odd, other };
      });
      const ok =
        got.fresh.transcriptTimes === 'paragraph' &&
        got.fresh.transcriptFormat === 'markdown' &&
        got.fresh.split === 'medium' &&
        got.odd.transcriptFormat === 'markdown' &&
        got.odd.transcriptTimes === 'cue' &&
        got.other.transcriptFormat === 'text' &&
        got.other.transcriptTimes === 'paragraph';
      return { ok, detail: short(got) };
    });
  } finally {
    await context.close();
  }
}

// --- Lecture dans l'onglet temporaire ---

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Relevé des onglets dans le service worker : création, mises à jour (son coupé, adresse), activation, fermeture.
function installRecorder(sw) {
  return sw.evaluate(() => {
    if (self.__rec) return;
    self.__rec = [];
    chrome.tabs.onCreated.addListener((tab) => self.__rec.push({ kind: 'created', id: tab.id, url: tab.pendingUrl || tab.url, active: tab.active }));
    chrome.tabs.onUpdated.addListener((id, info) => self.__rec.push({ kind: 'updated', id, info }));
    chrome.tabs.onActivated.addListener(({ tabId }) => self.__rec.push({ kind: 'activated', id: tabId }));
    chrome.tabs.onRemoved.addListener((id) => self.__rec.push({ kind: 'removed', id }));
  });
}
const tabEvents = (sw, id) => sw.evaluate((id) => self.__rec.filter((event) => event.id === id), id);

// Lance une lecture depuis une page de l'extension (connexion ouverte comme le fera la page de transcription) sans attendre la fin.
function startRead(page, videoId, { lang = null, port = true } = {}) {
  return page.evaluate(
    async ({ videoId, lang, port }) => {
      window.__port = port ? chrome.runtime.connect({ name: 'transcript' }) : null;
      window.__progress = 0;
      window.__started = Date.now();
      window.__final = new Promise((resolve) => {
        chrome.runtime.onMessage.addListener(function listen(msg) {
          if (!msg?.type?.startsWith('transcript-') || (msg.videoId && msg.videoId !== videoId)) return;
          if (msg.type === 'transcript-progress') window.__progress++;
          if (['transcript-done', 'transcript-error', 'transcript-cancelled'].includes(msg.type)) {
            chrome.runtime.onMessage.removeListener(listen);
            resolve(msg);
          }
        });
      });
      return chrome.runtime.sendMessage({ type: 'transcript-read', videoId, ...(lang ? { lang } : {}) });
    },
    { videoId, lang, port },
  );
}
const finishRead = (page, ms = 90_000) =>
  page.evaluate(async (ms) => {
    const final = await Promise.race([window.__final, new Promise((resolve) => setTimeout(() => resolve({ type: 'attente' }), ms))]);
    window.__port?.disconnect();
    return { final, ms: Date.now() - window.__started, progress: window.__progress };
  }, ms);
async function read(page, videoId, options) {
  const answer = await startRead(page, videoId, options);
  if (!answer?.ok) return { answer };
  return { answer, ...(await finishRead(page)) };
}
const stored = (page, videoId) => page.evaluate(async (videoId) => (await import(chrome.runtime.getURL('lib/db.js'))).getTranscript(videoId), videoId);
const clearTranscripts = (page) =>
  page.evaluate(async () => {
    const db = await import(chrome.runtime.getURL('lib/db.js'));
    for (const { videoId } of await db.listTranscripts()) await db.deleteTranscript(videoId);
  });
// L'onglet temporaire de la lecture en cours, dès qu'il existe.
async function waitTemp(page, ms = 15_000) {
  const limit = Date.now() + ms;
  while (Date.now() < limit) {
    const { transcribing } = await page.evaluate(() => chrome.storage.session.get('transcribing'));
    if (transcribing?.tempId) return transcribing.tempId;
    await sleep(100);
  }
  return null;
}
const tabAlive = (sw, id) => sw.evaluate((id) => chrome.tabs.get(id).then(() => true, () => false), id);
const notRunning = async (sw) => {
  for (let i = 0; i < 50 && (await sw.evaluate(() => self.captureRunningForTest())); i++) await sleep(100);
};

async function groupLecture() {
  const { CASES, FR_TEXTS, EN_TEXTS, youtubeRoute } = await import('./pages/youtube/cases.mjs');
  const extension = await prepareExtension(WORK);
  const context = await launch(extension, `profile-lecture-${RUN}`, WORK);
  const log = [];
  await youtubeRoute(context, log);
  try {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await installRecorder(sw);
    const page = await extensionPage(context, 'popup/popup.html');
    await clearTranscripts(page);
    const texts = (t) => t?.cues?.map((cue) => cue.text) ?? [];

    await test('lecture : réussie, en base, voie 2b, onglet temporaire muet avant YouTube, jamais actif, fermé', async () => {
      const before = log.length;
      const out = await read(page, 'manuel00001');
      const t = await stored(page, 'manuel00001');
      const created = (await sw.evaluate(() => self.__rec.filter((event) => event.kind === 'created'))).at(-1);
      const events = await tabEvents(sw, created.id);
      const mutedAt = events.findIndex((event) => event.info?.mutedInfo?.muted);
      const navAt = events.findIndex((event) => /youtube\.com/.test(event.info?.url ?? ''));
      const navUrl = events[navAt]?.info?.url;
      const played = log.slice(before).some((entry) => ['play', 'mute', 'setVolume'].includes(entry.event));
      const ok =
        out.final?.type === 'transcript-done' &&
        t?.route === 'timedtext' &&
        texts(t).join('|') === FR_TEXTS.join('|') &&
        t.lang === 'fr' &&
        t.title === 'Le café expliqué' &&
        t.complete === true &&
        t.cues.every((cue) => cue.end > cue.start) &&
        // Chrome ne donne pas l'adresse d'un onglet about:blank : seule la navigation compte (sans t= ni list=).
        (created.url ?? 'about:blank') === 'about:blank' &&
        !created.active &&
        mutedAt >= 0 &&
        navAt > mutedAt &&
        navUrl === 'https://www.youtube.com/watch?v=manuel00001' &&
        !events.some((event) => event.kind === 'activated') &&
        events.at(-1)?.kind === 'removed' &&
        !played;
      const parts = { texts: texts(t).join('|') === FR_TEXTS.join('|'), lang: t?.lang, title: t?.title, complete: t?.complete, ends: t?.cues?.every((cue) => cue.end > cue.start), created, last: events.at(-1)?.kind, activated: events.some((event) => event.kind === 'activated') };
      return { ok, detail: short({ final: out.final?.type, mutedAt, navAt, played, ...parts }) };
    });

    await test('lecture : chapitres de l’auteur, automatiques, aucun', async () => {
      const got = {};
      for (const id of ['manuel00001', 'chapauto001', 'sanschap001']) {
        await read(page, id);
        const t = await stored(page, id);
        got[id] = { titles: t?.chapters?.map((chapter) => chapter.title), auto: t?.chaptersAuto };
      }
      const ok =
        got.manuel00001.titles?.join() === 'Introduction,Le goût' &&
        got.manuel00001.auto === false &&
        got.chapauto001.titles?.join() === 'Introduction,Le goût' &&
        got.chapauto001.auto === true &&
        got.sanschap001.titles?.length === 0 &&
        got.sanschap001.auto === false;
      return { ok, detail: short(got) };
    });

    await test('lecture : sous-titres automatiques seuls', async () => {
      await read(page, 'autoseul001');
      const t = await stored(page, 'autoseul001');
      return { ok: t?.auto === true && t.lang === 'fr' && texts(t).join('|') === FR_TEXTS.join('|'), detail: short({ auto: t?.auto, lang: t?.lang }) };
    });

    await test('lecture : secours par le panneau quand 2b échoue, même texte', async () => {
      const out = await read(page, 'secours0001');
      const t = await stored(page, 'secours0001');
      const ok = out.final?.type === 'transcript-done' && t?.route === 'panel' && texts(t).join('|') === FR_TEXTS.join('|') && t.cues.every((cue) => cue.end > cue.start);
      return { ok, detail: short({ final: out.final, route: t?.route, texts: texts(t).slice(0, 2) }) };
    });

    await test('lecture : changement de langue (en)', async () => {
      const out = await read(page, 'manuel00001', { lang: 'en' });
      const t = await stored(page, 'manuel00001');
      return { ok: out.final?.type === 'transcript-done' && t?.lang === 'en' && texts(t).join('|') === EN_TEXTS.join('|'), detail: short({ final: out.final, lang: t?.lang }) };
    });

    await test('lecture : langue inconnue → message, rien de remplacé', async () => {
      const out = await read(page, 'manuel00001', { lang: 'de' });
      const t = await stored(page, 'manuel00001');
      return { ok: out.final?.type === 'transcript-error' && /langue/.test(out.final.message) && t?.lang === 'en', detail: short(out.final) };
    });

    await test('lecture : publicité, ses sous-titres (autre v=) ignorés', async () => {
      const before = log.length;
      await read(page, 'pub00000001');
      const t = await stored(page, 'pub00000001');
      const adAsked = log.slice(before).some((entry) => entry.event === 'setOption');
      return { ok: texts(t).join('|') === FR_TEXTS.join('|') && adAsked, detail: short(texts(t).slice(0, 1)) };
    });

    await test('lecture : la page se recharge juste après l’arrivée (themeRefresh)', async () => {
      const out = await read(page, 'recharge001');
      const t = await stored(page, 'recharge001');
      return { ok: out.final?.type === 'transcript-done' && texts(t).length === FR_TEXTS.length, detail: short(out.final) };
    });

    await test('lecture : texte incomplet, complete faux et stopsAtS', async () => {
      await read(page, 'incomplet01');
      const t = await stored(page, 'incomplet01');
      return { ok: t?.complete === false && t.stopsAtS === 120, detail: short({ complete: t?.complete, stopsAtS: t?.stopsAtS }) };
    });

    const messages = [
      ['sanssous001', /pas de sous-titres/],
      ['change00001', /YouTube a changé sa page/],
      ['privee00001', /privée ou a été supprimée/],
      ['direct00001', /en direct/],
      ['premiere001', /pas encore diffusée/],
      ['age00000001', /restriction d’âge/],
      ['membres0001', /réservée aux membres/],
      ['pays0000001', /bloquée dans ton pays/],
      ['robot000001', /pas un robot/],
    ];
    for (const [id, pattern] of messages) {
      await test(`échec : ${id} → ${pattern.source}`, async () => {
        const out = await read(page, id);
        const t = await stored(page, id);
        // « Pas de sous-titres » seulement sur le signal positif : le panneau vide d'une vidéo à pistes dit « YouTube a changé sa page ».
        const ok = out.final?.type === 'transcript-error' && pattern.test(out.final.message) && !t && (id !== 'change00001' || !/pas de sous-titres/.test(out.final.message));
        return { ok, detail: `${short(out.final)} (${out.ms} ms)` };
      });
    }

    await test('échec : injection refusée → message en français, jamais le texte de Chrome', async () => {
      await sw.evaluate(() => {
        self.realExecute = chrome.scripting.executeScript;
        chrome.scripting.executeScript = async () => {
          throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.');
        };
      });
      try {
        const out = await read(page, 'manuel00001');
        return { ok: out.final?.type === 'transcript-error' && /accès à youtube\.com/.test(out.final.message) && !/Cannot|manifest/.test(out.final.message), detail: out.final?.message };
      } finally {
        await sw.evaluate(() => {
          chrome.scripting.executeScript = self.realExecute;
        });
      }
    });

    await test('échec : onglet temporaire fermé de force → message en français', async () => {
      await startRead(page, 'lent0000001');
      const tempId = await waitTemp(page);
      await sleep(1500);
      await sw.evaluate((id) => chrome.tabs.remove(id), tempId);
      const out = await finishRead(page, 20_000);
      return { ok: out.final?.type === 'transcript-error' && /onglet de lecture a été fermé/.test(out.final.message), detail: out.final?.message };
    });

    await test('annuler pendant l’attente : transcript-cancelled, onglet fermé, rien en base', async () => {
      await notRunning(sw);
      await startRead(page, 'lent0000001');
      const tempId = await waitTemp(page);
      await sleep(2000);
      await page.evaluate(() => chrome.runtime.sendMessage({ type: 'transcript-cancel' }));
      const out = await finishRead(page, 10_000);
      await sleep(300);
      const ok = out.final?.type === 'transcript-cancelled' && tempId && !(await tabAlive(sw, tempId)) && !(await stored(page, 'lent0000001'));
      return { ok, detail: short({ final: out.final, ms: out.ms }) };
    });

    await test('déjà en cours : deuxième lecture pendant une lecture → refus avec message', async () => {
      await notRunning(sw);
      await startRead(page, 'lent0000001');
      await waitTemp(page);
      const other = await extensionPage(context, 'popup/popup.html');
      const second = await other.evaluate(() => chrome.runtime.sendMessage({ type: 'transcript-read', videoId: 'manuel00001' }));
      // Une capture demandée pendant la transcription : le refus nomme aussi la transcription.
      const capture = await other.evaluate(async () => chrome.runtime.sendMessage({ type: 'capture', tabId: (await chrome.tabs.getCurrent()).id, mode: 'visible' }));
      await other.close();
      await page.evaluate(() => chrome.runtime.sendMessage({ type: 'transcript-cancel' }));
      await finishRead(page, 10_000);
      return { ok: second?.ok === false && /déjà en cours/.test(second.error) && capture?.ok === false && /transcription est déjà en cours/.test(capture.error), detail: short({ second, capture }) };
    });

    await test('déjà en cours : lecture pendant une capture « appareils » → refus avec message', async () => {
      await notRunning(sw);
      const origin = await context.newPage();
      await origin.goto('https://www.youtube.com/watch?v=manuel00001');
      await origin.bringToFront();
      const originId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id);
      await page.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'capture-devices', tabId }), originId);
      await sleep(300);
      const second = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'transcript-read', videoId: 'manuel00001' }));
      await page.evaluate(() => chrome.runtime.sendMessage({ type: 'capture-cancel' }));
      await notRunning(sw);
      await origin.close();
      return { ok: second?.ok === false && /déjà en cours/.test(second.error), detail: short(second) };
    });

    await test('langue retenue : yt-player-caption-sticky-language inchangée après une lecture 2b', async () => {
      await notRunning(sw);
      const origin = await context.newPage();
      await origin.goto('https://www.youtube.com/watch?v=sanschap001');
      const before = await origin.evaluate(() => {
        localStorage.setItem('yt-player-caption-sticky-language', '{"data":"de"}');
        return localStorage.getItem('yt-player-caption-sticky-language');
      });
      const out = await read(page, 'manuel00001', { lang: 'en' });
      const after = await origin.evaluate(() => localStorage.getItem('yt-player-caption-sticky-language'));
      await origin.close();
      return { ok: out.final?.type === 'transcript-done' && after === before, detail: short({ before, after }) };
    });

    await test('onglet d’origine : adresse, position, lecture, piste, panneau et clés yt-player-* identiques ; ni mute ni setVolume', async () => {
      const origin = await context.newPage();
      await origin.goto('https://www.youtube.com/watch?v=manuel00001&at=42&playing=1&track=fr');
      const snapshot = () =>
        origin.evaluate(() => ({
          url: location.href,
          state: window.__state,
          keys: Object.fromEntries(Object.keys(localStorage).filter((key) => key.startsWith('yt-player')).sort().map((key) => [key, localStorage.getItem(key)])),
          calls: window.__calls,
        }));
      const before = await snapshot();
      const from = log.length;
      const out = await read(page, 'manuel00001');
      const after = await snapshot();
      const temp = (await sw.evaluate(() => self.__rec.filter((event) => event.kind === 'created'))).at(-1);
      const tempEvents = (await tabEvents(sw, temp.id)).map((event) => event.info ?? event.kind);
      await origin.close();
      const forbidden = log.slice(from).filter((entry) => ['mute', 'setVolume', 'play'].includes(entry.event));
      const ok = out.final?.type === 'transcript-done' && JSON.stringify(before) === JSON.stringify(after) && !forbidden.length;
      return { ok, detail: short({ final: out.final ?? out.answer, tempEvents, same: JSON.stringify(before) === JSON.stringify(after), forbidden, after: after.state }) };
    });

    await test('délai : la page qui ne répond jamais → message de délai vers 30 s, onglet fermé', async () => {
      await notRunning(sw);
      const answer = await startRead(page, 'jamais00001');
      const tempId = await waitTemp(page);
      const out = await finishRead(page, 70_000);
      const seconds = out.ms / 1000;
      const ok = answer?.ok && out.final?.type === 'transcript-error' && /ne répond pas/.test(out.final.message) && seconds > 29 && seconds < 34 && !(await tabAlive(sw, tempId)) && out.progress >= 25;
      return { ok, detail: short({ message: out.final?.message, seconds, progress: out.progress }) };
    });

    await test('Review Focus 5 : la page qui a demandé la lecture fermée → lecture arrêtée, onglet temporaire fermé', async () => {
      await notRunning(sw);
      const asker = await extensionPage(context, 'popup/popup.html');
      await startRead(asker, 'lent0000001');
      const tempId = await waitTemp(page);
      await sleep(1500);
      await asker.close();
      await sleep(1500);
      const running = await sw.evaluate(() => self.captureRunningForTest());
      const activated = (await tabEvents(sw, tempId)).some((event) => event.kind === 'activated');
      return { ok: tempId && !(await tabAlive(sw, tempId)) && !running && !activated && !(await stored(page, 'lent0000001')), detail: short({ tempId, running, activated }) };
    });

    // En dernier : le service worker arrêté perd le relevé des onglets.
    await test('Review Focus 4 : service worker arrêté pendant la lecture → au réveil, onglet temporaire fermé et transcript-error', async () => {
      await notRunning(sw);
      await startRead(page, 'lent0000001');
      const tempId = await waitTemp(page);
      await sleep(1500);
      // Comme le fera la page : connexion coupée → « transcript-cancel », qui réveille le service worker.
      await page.evaluate(() => {
        window.__port.onDisconnect.addListener(() => chrome.runtime.sendMessage({ type: 'transcript-cancel', videoId: 'lent0000001' }).catch(() => {}));
      });
      const cdp = await context.newCDPSession(page);
      await cdp.send('ServiceWorker.enable');
      await cdp.send('ServiceWorker.stopAllWorkers');
      await cdp.detach();
      const out = await finishRead(page, 15_000);
      await sleep(800);
      const alive = await page.evaluate((id) => chrome.tabs.get(id).then(() => true, () => false), tempId);
      const left = await page.evaluate(async () => (await chrome.storage.session.get('transcribing')).transcribing ?? null);
      return { ok: out.final?.type === 'transcript-error' && /interrompue/.test(out.final.message) && !alive && !left, detail: short({ final: out.final, alive, left }) };
    });
    void CASES;
  } finally {
    await context.close();
  }
}

// --- Page de transcription ---

// Attend que la page sorte de l'attente : « ready » (texte affiché) ou « error » (message).
const settled = (page, ms = 70_000) =>
  page.waitForFunction(() => ['ready', 'error'].includes(document.body.dataset.state), null, { timeout: ms }).then(() => page.evaluate(() => document.body.dataset.state));
const previewText = (page) => page.evaluate(() => document.getElementById('preview').textContent);
const problemText = (page) => page.evaluate(() => (document.getElementById('problem').hidden ? '' : document.getElementById('problem-text').textContent));
const openTranscript = (context, query = '') => extensionPage(context, `transcript/transcript.html${query}`);

// Remplace le téléchargement par un relevé : nom et contenu de chaque fichier (même méthode que convert.mjs).
async function spyDownloads(page) {
  await page.evaluate(() => {
    window.saved = [];
    chrome.downloads.download = async (options) => {
      window.saved.push({ filename: options.filename, text: await (await fetch(options.url)).text() });
      return window.saved.length;
    };
  });
}

async function groupPage() {
  const { FR_TEXTS } = await import('./pages/youtube/cases.mjs');
  const { youtubeRoute } = await import('./pages/youtube/cases.mjs');
  const fmt = await import('../extension/transcript/format.js');
  const extension = await prepareExtension(WORK);
  const context = await launch(extension, `profile-page-${RUN}`, WORK);
  await youtubeRoute(context, []);
  try {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await installRecorder(sw);
    const admin = await extensionPage(context, 'popup/popup.html');
    await admin.evaluate(() => chrome.storage.sync.clear());
    await clearTranscripts(admin);
    const tabCount = () => sw.evaluate(async () => (await chrome.tabs.query({})).length);
    const lastTemp = async () => (await sw.evaluate(() => self.__rec.filter((event) => event.kind === 'created'))).at(-1)?.id;

    await test('page : lien collé (avec Entrée) → texte affiché, en-tête sans t= ni list=', async () => {
      const page = await openTranscript(context);
      await page.locator('#link').fill('https://www.youtube.com/watch?v=manuel00001&t=42s&list=PL1');
      await page.locator('#link').press('Enter');
      const state = await settled(page);
      const text = await previewText(page);
      await page.close();
      const ok = state === 'ready' && text.startsWith('# Le café expliqué') && text.includes('https://www.youtube.com/watch?v=manuel00001\n') && !/t=42|list=/.test(text) && text.includes(FR_TEXTS[0]);
      return { ok, detail: short({ state, head: text.slice(0, 160) }) };
    });

    await test('page : lien refusé → message, aucun onglet ouvert', async () => {
      const page = await openTranscript(context);
      const before = await tabCount();
      await page.locator('#link').fill('https://vimeo.com/1');
      await page.locator('#read').click();
      await sleep(800);
      const message = await problemText(page);
      const after = await tabCount();
      await page.close();
      return { ok: /n’est pas une vidéo YouTube/.test(message) && after === before, detail: short({ message, before, after }) };
    });

    await test('page : chaque option change l’aperçu ; titres ## et chapitres automatiques', async () => {
      const page = await openTranscript(context, '?v=chapauto001');
      await settled(page);
      const seen = { start: await previewText(page) };
      await page.locator('#times button[data-key="cue"]').click();
      seen.cue = await previewText(page);
      await page.locator('#times button[data-key="none"]').click();
      seen.none = await previewText(page);
      await page.locator('#format button[data-key="text"]').click();
      seen.text = await previewText(page);
      await page.locator('#times button[data-key="paragraph"]').click();
      await page.locator('#format button[data-key="markdown"]').click();
      await page.close();
      const marks = (text) => (text.match(/\[\d+:\d{2}\]/g) ?? []).length;
      const ok =
        /^## Introduction$/m.test(seen.start) &&
        /chapitres automatiques/.test(seen.start) &&
        marks(seen.cue) === 6 &&
        marks(seen.start) < 6 &&
        marks(seen.none) === 0 &&
        !seen.text.includes('#') &&
        new Set(Object.values(seen)).size === 4;
      return { ok, detail: short({ start: marks(seen.start), cue: marks(seen.cue), none: marks(seen.none) }) };
    });

    await test('page : repères et format retenus à la réouverture, langue non retenue', async () => {
      let page = await openTranscript(context, '?v=manuel00001');
      await settled(page);
      await page.locator('#times button[data-key="none"]').click();
      await page.locator('#format button[data-key="text"]').click();
      await page.locator('#lang').selectOption('en');
      await settled(page);
      const chosen = await page.evaluate(() => document.getElementById('lang').value);
      await page.close();
      page = await openTranscript(context, '?v=chapauto001');
      await settled(page);
      const got = await page.evaluate(() => ({
        times: document.querySelector('#times [aria-pressed="true"]')?.dataset.key,
        format: document.querySelector('#format [aria-pressed="true"]')?.dataset.key,
        lang: document.getElementById('lang').value,
      }));
      await page.locator('#times button[data-key="paragraph"]').click();
      await page.locator('#format button[data-key="markdown"]').click();
      await page.close();
      return { ok: chosen === 'en' && got.times === 'none' && got.format === 'text' && got.lang === 'fr', detail: short({ chosen, got }) };
    });

    await test('page : « Copier » met exactement l’aperçu dans le presse-papiers, avec confirmation', async () => {
      const page = await openTranscript(context, '?v=manuel00001&from=history');
      await settled(page);
      await page.bringToFront();
      await page.locator('#copy').click();
      await page.waitForFunction(() => !document.getElementById('toast').hidden);
      const got = await page.evaluate(async () => ({ clip: await navigator.clipboard.readText(), shown: document.getElementById('preview').textContent, toast: document.getElementById('toast').textContent }));
      await page.close();
      return { ok: got.clip === got.shown && got.clip.length > 100 && /Copié dans le presse-papiers/.test(got.toast), detail: short({ toast: got.toast, same: got.clip === got.shown }) };
    });

    await test('page : .md, .txt et .srt relus ; le .md reste Markdown en affichage texte, et l’inverse', async () => {
      const page = await openTranscript(context, '?v=chapauto001&from=history');
      await settled(page);
      await spyDownloads(page);
      await page.locator('#times button[data-key="cue"]').click();
      await page.locator('#format button[data-key="text"]').click();
      for (const id of ['#save-md', '#save-txt', '#save-srt']) await page.locator(id).click();
      await page.waitForFunction(() => window.saved.length === 3);
      const saved = await page.evaluate(() => window.saved);
      await page.locator('#times button[data-key="paragraph"]').click();
      await page.locator('#format button[data-key="markdown"]').click();
      await page.close();
      const t = await stored(admin, 'chapauto001');
      const [md, txt, srt] = saved;
      const ok =
        md.filename === 'Captures/Le café expliqué.md' &&
        txt.filename === 'Captures/Le café expliqué.txt' &&
        srt.filename === 'Captures/Le café expliqué.srt' &&
        md.text === fmt.render(t, { format: 'markdown', times: 'cue' }) &&
        txt.text === fmt.render(t, { format: 'text', times: 'cue' }) &&
        srt.text === fmt.toSrt(t) &&
        /^1\n00:00:00,500 --> 00:00:04,000\n/.test(srt.text);
      return { ok, detail: short(saved.map((file) => [file.filename, file.text.slice(0, 40)])) };
    });

    await test('page : texte incomplet, mention avec l’heure d’arrêt', async () => {
      const page = await openTranscript(context, '?v=incomplet01');
      await settled(page);
      const note = await page.evaluate(() => (document.getElementById('incomplete').hidden ? '' : document.getElementById('incomplete').textContent));
      await page.close();
      return { ok: /peut-être incomplète/.test(note) && note.includes('2:00'), detail: note };
    });

    const messages = [
      ['sanssous001', /pas de sous-titres/],
      ['change00001', /YouTube a changé sa page/],
      ['privee00001', /privée ou a été supprimée/],
      ['direct00001', /en direct/],
      ['premiere001', /pas encore diffusée/],
      ['age00000001', /restriction d’âge/],
      ['membres0001', /réservée aux membres/],
      ['pays0000001', /bloquée dans ton pays/],
      ['robot000001', /pas un robot/],
    ];
    await test('page : chaque message d’échec visible', async () => {
      await admin.evaluate(() => {
        window.__errors = [];
        chrome.runtime.onMessage.addListener((msg) => {
          if (msg?.type === 'transcript-error') window.__errors.push([msg.videoId, msg.code, Date.now()]);
        });
      });
      const wrong = [];
      for (const [id, pattern] of messages) {
        const page = await openTranscript(context, `?v=${id}`);
        await settled(page);
        const message = await problemText(page);
        await page.close();
        if (!pattern.test(message)) wrong.push([id, message, (await tabEvents(sw, await lastTemp())).map((event) => event.info ?? event.kind)]);
      }
      return { ok: !wrong.length, detail: short({ wrong: wrong.map(([id, , events]) => [id, events]), codes: await admin.evaluate(() => window.__errors) }) };
    });

    await test('page : « déjà en cours » visible', async () => {
      const first = await openTranscript(context, '?v=lent0000001');
      await waitTemp(admin);
      const second = await openTranscript(context, '?v=manuel00001');
      await settled(second);
      const message = await problemText(second);
      await second.close();
      await first.locator('#cancel').click();
      await settled(first);
      await first.close();
      return { ok: /déjà en cours/.test(message), detail: message };
    });

    const cancelCase = async (query, prepare) => {
      await notRunning(sw);
      const page = await openTranscript(context, query);
      if (prepare) await prepare(page);
      const tempId = await waitTemp(admin);
      await sleep(prepare ? 1500 : 2500);
      await page.locator('#cancel').click();
      const state = await settled(page, 15_000);
      await sleep(300);
      const alive = tempId ? await tabAlive(sw, tempId) : null;
      return { page, state, tempId, alive };
    };

    await test('page : « Annuler » pendant l’attente → onglet fermé, rien en base', async () => {
      const { page, state, tempId, alive } = await cancelCase('?v=lent0000001');
      const message = await problemText(page);
      await page.close();
      return { ok: state === 'error' && /annulée/.test(message) && tempId && !alive && !(await stored(admin, 'lent0000001')), detail: short({ state, message, alive }) };
    });

    await test('page : « Annuler » pendant le secours (panneau) → onglet fermé, rien en base', async () => {
      const { page, state, tempId, alive } = await cancelCase('?v=secourslen1');
      await page.close();
      return { ok: state === 'error' && tempId && !alive && !(await stored(admin, 'secourslen1')), detail: short({ state, alive }) };
    });

    await test('page : « Annuler » pendant un changement de langue → ancien texte gardé, entrée inchangée', async () => {
      await notRunning(sw);
      const page = await openTranscript(context, '?v=langlent001');
      await settled(page);
      await page.locator('#lang').selectOption('en');
      const tempId = await waitTemp(admin);
      await sleep(1500);
      await page.locator('#cancel').click();
      const state = await settled(page, 15_000);
      const got = { state, lang: await page.evaluate(() => document.getElementById('lang').value), text: (await previewText(page)).includes(FR_TEXTS[0]) };
      await page.close();
      await sleep(300);
      const t = await stored(admin, 'langlent001');
      return { ok: got.state === 'ready' && got.lang === 'fr' && got.text && !(await tabAlive(sw, tempId)) && t?.lang === 'fr', detail: short({ ...got, stored: t?.lang }) };
    });

    await test('page : depuis l’historique, autre langue → entrée remplacée', async () => {
      await notRunning(sw);
      const page = await openTranscript(context, '?v=manuel00001&from=history');
      await settled(page);
      const before = await stored(admin, 'manuel00001');
      await page.locator('#lang').selectOption(before?.lang === 'en' ? 'fr' : 'en');
      await page.waitForFunction(() => document.body.dataset.state === 'loading', null, { timeout: 5000 }).catch(() => {});
      await settled(page);
      const after = await stored(admin, 'manuel00001');
      const list = await admin.evaluate(async () => (await (await import(chrome.runtime.getURL('lib/db.js'))).listTranscripts()).filter((t) => t.videoId === 'manuel00001').length);
      await page.close();
      return { ok: before && after && after.lang !== before.lang && list === 1, detail: short({ before: before?.lang, after: after?.lang, list }) };
    });

    await test('page : téléchargement interrompu → pas de faux succès, message en français', async () => {
      const page = await openTranscript(context, '?v=chapauto001&from=history');
      await settled(page);
      // Une adresse de fichier déjà révoquée : Chrome accepte la demande, puis le téléchargement s'interrompt.
      await page.evaluate(() => {
        const real = chrome.downloads.download.bind(chrome.downloads);
        chrome.downloads.download = (options) => {
          URL.revokeObjectURL(options.url);
          return real(options);
        };
      });
      await page.locator('#save-md').click();
      await page.waitForFunction(() => !document.getElementById('toast').hidden, null, { timeout: 15_000 });
      const toastText = await page.evaluate(() => document.getElementById('toast').textContent);
      await page.close();
      return { ok: /n’a pas pu être enregistré/.test(toastText) && !/enregistré dans/.test(toastText), detail: toastText };
    });

    await test('page : « déjà en cours » pendant un changement de langue → le texte reste affiché', async () => {
      await notRunning(sw);
      const page = await openTranscript(context, '?v=manuel00001&from=history');
      await settled(page);
      const other = await openTranscript(context, '?v=lent0000001');
      await waitTemp(admin);
      await page.bringToFront();
      const current = await page.evaluate(() => document.getElementById('lang').value);
      await page.locator('#lang').selectOption(current === 'en' ? 'fr' : 'en');
      await page.waitForFunction(() => !document.getElementById('toast').hidden, null, { timeout: 5000 });
      const got = await page.evaluate(() => ({ state: document.body.dataset.state, toast: document.getElementById('toast').textContent, preview: !document.getElementById('preview').hidden, copy: !document.getElementById('copy').disabled }));
      await other.locator('#cancel').click();
      await settled(other);
      await other.close();
      await page.close();
      return { ok: got.state === 'ready' && /déjà en cours/.test(got.toast) && got.preview && got.copy, detail: short(got) };
    });

    await test('Review Focus 5 : vraie page fermée pendant la lecture → lecture arrêtée, onglet temporaire fermé', async () => {
      await notRunning(sw);
      const page = await openTranscript(context, '?v=lent0000001');
      const tempId = await waitTemp(admin);
      await sleep(1500);
      await page.bringToFront();
      await page.close();
      await sleep(1500);
      const activated = (await tabEvents(sw, tempId)).some((event) => event.kind === 'activated');
      return { ok: tempId && !activated && !(await tabAlive(sw, tempId)) && !(await sw.evaluate(() => self.captureRunningForTest())), detail: short({ tempId, activated }) };
    });

    await test('Review Focus 3 : 3 h (2 500 passages), aperçu et changement d’option en moins d’une seconde, copie complète', async () => {
      await notRunning(sw);
      const page = await openTranscript(context, '?v=troisheures');
      await settled(page);
      const got = await page.evaluate(async () => {
        const started = performance.now();
        document.querySelector('#times button[data-key="cue"]').click();
        await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
        const ms = performance.now() - started;
        const text = document.getElementById('preview').textContent;
        return { ms, marks: (text.match(/\[\d+:\d{2}(?::\d{2})?\]/g) ?? []).length };
      });
      await page.bringToFront();
      await page.locator('#copy').click();
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      await page.locator('#times button[data-key="paragraph"]').click();
      await page.close();
      const ok = got.ms < 1000 && got.marks === 2500 && clip.includes('Passage numéro 1 de') && clip.includes('Passage numéro 2500 de');
      return { ok, detail: short({ ms: Math.round(got.ms), marks: got.marks, clip: clip.length }) };
    });

    await test('captures d’écran de la page en clair et en sombre', async () => {
      const page = await openTranscript(context, '?v=chapauto001&from=history');
      await settled(page);
      await page.setViewportSize({ width: 1280, height: 800 });
      for (const scheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.screenshot({ path: path.join(WORK, `transcription-${scheme}.png`) });
      }
      await page.close();
      return { ok: true, detail: WORK };
    });

    // En dernier : le service worker arrêté perd le relevé des onglets.
    await test('Review Focus 4 : service worker arrêté pendant la lecture → la page sort de l’attente avec un message, onglet fermé', async () => {
      await notRunning(sw);
      const page = await openTranscript(context, '?v=lent0000001');
      const tempId = await waitTemp(admin);
      await sleep(1500);
      const cdp = await context.newCDPSession(admin);
      await cdp.send('ServiceWorker.enable');
      await cdp.send('ServiceWorker.stopAllWorkers');
      await cdp.detach();
      const state = await settled(page, 15_000);
      const message = await problemText(page);
      await sleep(1000);
      const alive = await admin.evaluate((id) => chrome.tabs.get(id).then(() => true, () => false), tempId);
      await page.close();
      return { ok: state === 'error' && /interrompue/.test(message) && !alive, detail: short({ state, message, alive }) };
    });
    void lastTemp;
  } finally {
    await context.close();
  }

  // Copie sans accès aux sites : la page ne lit rien sans l'accord, et un refus donne le message d’accès.
  const bare = await prepareExtension(WORK, { allHosts: false });
  const strict = await launch(bare, `profile-page-sans-${RUN}`, WORK);
  const log = [];
  await youtubeRoute(strict, log);
  try {
    await test('page : ouverte avec ?v= sans accès → message et bouton « Autoriser », rien n’est lu', async () => {
      const page = await openTranscript(strict, '?v=manuel00001');
      await settled(page);
      await sleep(1000);
      const got = await page.evaluate(() => ({ message: document.getElementById('problem-text').textContent, allow: !document.getElementById('allow').hidden }));
      await page.close();
      return { ok: /a besoin d’accéder à youtube\.com/.test(got.message) && got.allow && !log.length, detail: short({ ...got, requests: log.length }) };
    });

    await test('page : accès refusé à la demande → message d’accès, rien n’est lu', async () => {
      const page = await openTranscript(strict);
      await page.evaluate(() => {
        chrome.permissions.request = async () => false;
      });
      await page.locator('#link').fill('https://youtu.be/manuel00001');
      await page.locator('#link').press('Enter');
      await settled(page);
      const message = await problemText(page);
      await page.close();
      return { ok: /a besoin d’accéder à youtube\.com/.test(message) && !log.length, detail: message };
    });
  } finally {
    await strict.close();
  }
}

// --- Fenêtre de l'icône ---

// Ouvre la fenêtre de l'icône dans un onglet, l'onglet actif simulé à l'adresse `url` (comme e2e.mjs).
async function openPopup(context, url, { refuse = false } = {}) {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const page = await context.newPage();
  await page.addInitScript(
    ({ url, refuse }) => {
      const query = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async (info) => (info?.active ? [{ id: 999999, index: 0, windowId: -1, url, active: true }] : query(info));
      if (refuse) chrome.permissions.request = async () => false;
    },
    { url, refuse },
  );
  await page.goto(`chrome-extension://${new URL(sw.url()).host}/popup/popup.html`);
  await page.waitForTimeout(300);
  return page;
}

async function groupFenetre() {
  const { youtubeRoute } = await import('./pages/youtube/cases.mjs');
  const extension = await prepareExtension(WORK);
  const context = await launch(extension, `profile-fenetre-${RUN}`, WORK);
  await youtubeRoute(context, []);
  const visible = (page) => page.evaluate(() => {
    const button = document.getElementById('transcript');
    // la ligne vidéo vient juste sous « Page entière ».
    return { shown: Boolean(button) && !button.hidden, first: document.getElementById('full')?.nextElementSibling?.id ?? null };
  });
  try {
    await test('fenêtre : sur une vidéo watch?v=… → bouton visible, juste sous « Page entière »', async () => {
      const page = await openPopup(context, 'https://www.youtube.com/watch?v=manuel00001&t=42s');
      const got = await visible(page);
      const label = await page.evaluate(() => document.getElementById('transcript')?.textContent.replace(/\s+/g, ' ').trim());
      await page.close();
      return { ok: got.shown && got.first === 'transcript' && /Transcription de cette vidéo/.test(label ?? ''), detail: short({ ...got, label }) };
    });

    await test('fenêtre : sur un Short → bouton visible', async () => {
      const page = await openPopup(context, 'https://www.youtube.com/shorts/manuel00001');
      const got = await visible(page);
      await page.close();
      return { ok: got.shown, detail: short(got) };
    });

    for (const url of ['https://example.com/', 'https://music.youtube.com/watch?v=manuel00001', 'chrome://extensions/']) {
      await test(`fenêtre : pas de bouton sur ${url}`, async () => {
        const page = await openPopup(context, url);
        const got = await visible(page);
        await page.close();
        return { ok: !got.shown, detail: short(got) };
      });
    }

    await test('fenêtre : clic → page de transcription ?v=<id> ouverte, texte affiché', async () => {
      const page = await openPopup(context, 'https://www.youtube.com/watch?v=manuel00001&list=PL1');
      const [opened] = await Promise.all([context.waitForEvent('page', { predicate: (p) => p.url().includes('transcript/transcript.html') }), page.locator('#transcript').click()]);
      const url = opened.url();
      const state = await settled(opened);
      const text = await previewText(opened);
      await opened.close();
      await page.close().catch(() => {});
      return { ok: /transcript\.html\?v=manuel00001$/.test(url) && state === 'ready' && text.includes('Bonjour et bienvenue.'), detail: short({ url, state }) };
    });

    await test('fenêtre : au clavier (Tab, Entrée) → page de transcription ouverte', async () => {
      const page = await openPopup(context, 'https://www.youtube.com/watch?v=manuel00001');
      // Tab : raccourcis de l'en-tête, « Page entière », puis la ligne vidéo.
      for (let i = 0; i < 3; i++) await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => document.activeElement?.id);
      const [opened] = await Promise.all([context.waitForEvent('page', { predicate: (p) => p.url().includes('transcript/transcript.html'), timeout: 5000 }), page.keyboard.press('Enter').catch(() => {})]); // la fenêtre se ferme aussitôt après avoir ouvert la page
      const url = opened.url();
      await opened.close();
      await page.close().catch(() => {});
      return { ok: focused === 'transcript' && url.includes('?v=manuel00001'), detail: short({ focused, url }) };
    });

    await test('fenêtre : lien « Transcrire une vidéo » après « Convertir des images » → page vide avec le champ', async () => {
      const page = await openPopup(context, 'https://example.com/');
      const order = await page.evaluate(() => [...document.querySelectorAll('.list > *')].map((el) => el.id));
      const [opened] = await Promise.all([context.waitForEvent('page', { predicate: (p) => p.url().includes('transcript/transcript.html') }), page.locator('#transcribe').click()]);
      await opened.waitForLoadState();
      const got = await opened.evaluate(() => ({ state: document.body.dataset.state, field: !document.getElementById('link').closest('form').hidden, search: location.search }));
      await opened.close();
      await page.close().catch(() => {});
      return { ok: order.indexOf('transcribe') === order.indexOf('convert') + 1 && got.state === 'empty' && got.field && got.search === '', detail: short({ order, got }) };
    });
  } finally {
    await context.close();
  }

  const bare = await prepareExtension(WORK, { allHosts: false });
  const strict = await launch(bare, `profile-fenetre-sans-${RUN}`, WORK);
  try {
    // La fenêtre ne demande pas l'accès elle-même (sous macOS, elle peut se fermer pendant la question de Chrome) : elle ouvre la page,
    // qui montre « Autoriser l'accès à YouTube ».
    await test('fenêtre : sans accès à youtube.com → page ouverte avec « Autoriser l’accès à YouTube », rien n’est lu', async () => {
      const page = await openPopup(strict, 'https://www.youtube.com/watch?v=manuel00001');
      const [opened] = await Promise.all([strict.waitForEvent('page', { predicate: (p) => p.url().includes('transcript/transcript.html') }), page.locator('#transcript').click()]);
      await settled(opened);
      const got = await opened.evaluate(() => ({ url: location.search, message: document.getElementById('problem-text').textContent, allow: !document.getElementById('allow').hidden }));
      await opened.close();
      await page.close().catch(() => {});
      return { ok: got.url === '?v=manuel00001' && /a besoin d’accéder à youtube\.com/.test(got.message) && got.allow, detail: short(got) };
    });
  } finally {
    await strict.close();
  }
}

// --- Historique ---

async function groupHistorique() {
  const { seedCapture } = await import('./lib.mjs');
  const { youtubeRoute } = await import('./pages/youtube/cases.mjs');
  const extension = await prepareExtension(WORK);
  const context = await launch(extension, `profile-historique-${RUN}`, WORK);
  await youtubeRoute(context, []);
  const toYoutube = [];
  context.on('request', (request) => {
    if (/^https:\/\/www\.youtube\.com\//.test(request.url())) toYoutube.push(request.url());
  });
  const transcript = (videoId, title, createdAt) => ({
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title,
    channel: 'Chaîne imitée',
    publishedAt: '2024-03-05',
    durationS: 130,
    lang: 'fr',
    langLabel: 'Français',
    auto: false,
    languages: [{ code: 'fr', label: 'Français', auto: false }],
    chapters: [],
    chaptersAuto: false,
    cues: [{ start: 0.5, end: 4, text: `Texte de ${title}.` }],
    complete: true,
    stopsAtS: 0.5,
    route: 'timedtext',
    createdAt,
  });
  // Repart d'une base qui contient exactement ces captures (dates) et ces transcriptions.
  const seed = async (page, captureDates, transcripts) => {
    await resetDb(page);
    const ids = [];
    for (const createdAt of captureDates) ids.push(await seedCapture(page, { heightPoints: 600, createdAt }));
    await page.evaluate(async (list) => {
      const db = await import(chrome.runtime.getURL('lib/db.js'));
      for (const item of list) await db.saveTranscript(item);
    }, transcripts);
    return ids;
  };
  const rowsOf = (viewer) =>
    viewer.evaluate(() =>
      [...document.querySelectorAll('#history > li')].map((li) => ({
        empty: li.classList.contains('history-empty'),
        text: li.textContent.replace(/\s+/g, ' ').trim(),
        transcript: Boolean(li.querySelector('.history-transcript')),
      })),
    );
  const errors = [];
  const dialogs = [];
  try {
    const admin = await extensionPage(context, 'popup/popup.html');
    const openViewer = async () => {
      const viewer = await extensionPage(context, 'viewer/viewer.html');
      viewer.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
      viewer.on('pageerror', (err) => errors.push(err.message));
      // Les suppressions demandent confirmation (« Cette action est définitive ») : on accepte, et on garde la question.
      viewer.on('dialog', (dialog) => {
        dialogs.push(dialog.message());
        dialog.accept();
      });
      await viewer.waitForFunction(() => document.querySelectorAll('#history > li').length > 0);
      await sleep(300);
      return viewer;
    };
    const now = Date.now();

    await test('historique : 2 captures et 2 transcriptions mêlées par date, étiquette « Transcription »', async () => {
      await seed(admin, [now - 4000, now - 2000], [transcript('aaaaaaaaaaa', 'Vidéo A', now - 3000), transcript('bbbbbbbbbbb', 'Vidéo B', now - 1000)]);
      const viewer = await openViewer();
      const rows = await rowsOf(viewer);
      await viewer.close();
      const kinds = rows.map((row) => (row.transcript ? 'T' : 'C')).join('');
      const labelled = rows.filter((row) => row.transcript).every((row) => /Transcription/.test(row.text) && /Chaîne imitée/.test(row.text));
      return { ok: rows.length === 4 && kinds === 'TCTC' && rows[0].text.includes('Vidéo B') && rows[2].text.includes('Vidéo A') && labelled, detail: short({ kinds, rows: rows.map((row) => row.text.slice(0, 60)) }) };
    });

    await test('historique : clic sur une transcription → page de transcription avec le texte, sans requête vers YouTube', async () => {
      const viewer = await openViewer();
      const before = toYoutube.length;
      await viewer.locator('.history-transcript').first().click();
      await viewer.waitForURL(/transcript\/transcript\.html\?v=bbbbbbbbbbb&from=history/);
      const state = await settled(viewer);
      const text = await previewText(viewer);
      await viewer.close();
      return { ok: state === 'ready' && text.includes('Texte de Vidéo B.') && toYoutube.length === before, detail: short({ state, requests: toYoutube.slice(before) }) };
    });

    await test('historique : les captures s’ouvrent toujours comme avant', async () => {
      const ids = await seed(admin, [now - 4000, now - 2000], [transcript('bbbbbbbbbbb', 'Vidéo B', now - 1000)]);
      const viewer = await openViewer();
      await viewer.locator(`.history-item[data-id="${ids[0]}"]`).click();
      await viewer.waitForFunction((id) => location.search.includes(id), ids[0], { timeout: 5000 });
      const current = await viewer.evaluate(() => document.querySelector('.history-item[aria-current="true"]')?.dataset.id);
      await viewer.close();
      return { ok: current === ids[0], detail: short({ current, ids }) };
    });

    await test('historique : la croix retire la ligne et l’entrée en base, sans erreur dans la console', async () => {
      await seed(admin, [now - 4000], [transcript('aaaaaaaaaaa', 'Vidéo A', now - 3000), transcript('bbbbbbbbbbb', 'Vidéo B', now - 1000)]);
      const viewer = await openViewer();
      const before = errors.length;
      await viewer.locator('.history-transcript').first().locator('xpath=..').locator('.history-delete').click();
      await sleep(500);
      const rows = await rowsOf(viewer);
      await viewer.close();
      const gone = await stored(admin, 'bbbbbbbbbbb');
      return { ok: rows.length === 2 && !rows.some((row) => row.text.includes('Vidéo B')) && !gone && errors.length === before && /transcription \? Cette action est définitive/.test(dialogs.at(-1) ?? ''), detail: short({ rows: rows.map((row) => row.text.slice(0, 40)), errors: errors.slice(before) }) };
    });

    await test('historique : sans capture, avec une transcription → pas d’état vide', async () => {
      await seed(admin, [], [transcript('aaaaaaaaaaa', 'Vidéo A', now)]);
      const viewer = await openViewer();
      const rows = await rowsOf(viewer);
      await viewer.close();
      return { ok: rows.length === 1 && rows[0].transcript && !rows.some((row) => row.empty), detail: short(rows) };
    });

    await test('historique : supprimer la dernière capture quand des transcriptions restent → elles restent, pas d’état vide', async () => {
      const [id] = await seed(admin, [now - 2000], [transcript('aaaaaaaaaaa', 'Vidéo A', now)]);
      const viewer = await openViewer();
      const before = errors.length;
      await viewer.locator(`.history-item[data-id="${id}"]`).locator('xpath=..').locator('.history-delete').click();
      await sleep(800);
      const rows = await rowsOf(viewer);
      await viewer.close();
      return { ok: rows.length === 1 && rows[0].transcript && !rows.some((row) => row.empty) && errors.length === before, detail: short({ rows, errors: errors.slice(before) }) };
    });

    await test('historique : supprimer la dernière transcription → état vide', async () => {
      await seed(admin, [], [transcript('aaaaaaaaaaa', 'Vidéo A', now)]);
      const viewer = await openViewer();
      await viewer.locator('.history-transcript').locator('xpath=..').locator('.history-delete').click();
      await sleep(500);
      const rows = await rowsOf(viewer);
      await viewer.close();
      return { ok: rows.length === 1 && rows[0].empty, detail: short(rows) };
    });
  } finally {
    await context.close();
  }
}

// --- Vrai YouTube, sur demande seulement ---
// Sous Playwright (ou avec un port de débogage), `navigator.webdriver` vaut vrai et YouTube rend des sous-titres vides.
// Méthode : Chromium lancé sans pilotage, la copie de test lit elle-même les vidéos à son installation, par le vrai
// readTranscript du service worker, et envoie son rapport à un petit serveur local.
const REAL_VIDEOS = (process.env.REAL_VIDEOS ?? 'dQw4w9WgXcQ,MJuo7lu0xfU,xkhdFTw4K5o').split(',');

async function groupReel() {
  const { chromium } = await import('playwright');
  const { spawn } = await import('node:child_process');
  const http = await import('node:http');
  let resolve;
  const done = new Promise((r) => (resolve = r));
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.writeHead(200, { 'access-control-allow-origin': '*' }).end('ok');
    if (req.method === 'POST') resolve(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // Copie sans `<all_urls>` : seul l'accès que la page demande à l'utilisateur (www.youtube.com et consent.youtube.com), posé d'avance
  // puisque personne ne peut cliquer « Autoriser » dans ce Chromium sans pilotage.
  const extension = await prepareExtension(WORK, { allHosts: false });
  const { YOUTUBE_ACCESS } = await import('../extension/transcript/youtube-url.js');
  const manifestPath = path.join(extension, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.host_permissions = YOUTUBE_ACCESS.origins;
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  const report = `http://127.0.0.1:${server.address().port}/report`;
  // Point d'entrée de la copie de test seulement (le vrai background.js n'en a pas).
  await fs.appendFile(
    path.join(extension, 'background.js'),
    `\nchrome.runtime.onInstalled.addListener(async () => {
  const rows = [];
  for (const videoId of ${JSON.stringify(REAL_VIDEOS)}) {
    const started = Date.now();
    try {
      const t = await readTranscript(videoId, {});
      rows.push({ videoId, ok: t.cues.length > 0, route: t.route, cues: t.cues.length, complete: t.complete, lastS: t.stopsAtS, durationS: t.durationS, lang: t.lang, title: t.title, chapters: t.chapters.length, ms: Date.now() - started });
    } catch (err) {
      rows.push({ videoId, ok: false, error: explainTranscriptError(err), code: err?.code ?? '', ms: Date.now() - started });
    }
  }
  const tabs = (await chrome.tabs.query({})).map((tab) => tab.url ?? '');
  await fetch(${JSON.stringify(report)}, { method: 'POST', body: JSON.stringify({ rows, tabs, webdriver: navigator.webdriver ?? null }) });
});\n`,
  );
  const profile = path.join(WORK, `profile-reel-${RUN}`);
  const browser = spawn(chromium.executablePath(), [
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--lang=fr-FR',
    `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });
  try {
    const body = await Promise.race([done, sleep(REAL_VIDEOS.length * 75_000).then(() => null)]);
    if (!body) return check('réel : rapport reçu', false, 'aucun rapport dans le temps imparti');
    const { rows, tabs } = JSON.parse(body);
    await fs.writeFile(path.join(WORK, 'reel.json'), JSON.stringify(rows, null, 2));
    for (const row of rows) {
      console.log(`   ${JSON.stringify(row)}`);
      check(`réel : ${row.videoId} lu (${row.route ?? row.code}, ${row.cues ?? 0} passages, ${(row.ms / 1000).toFixed(1)} s)`, row.ok, row.error ?? `complète : ${row.complete}`);
    }
    check('réel : aucun onglet YouTube resté ouvert', !tabs.some((url) => /youtube\.com/.test(url)), tabs.join(' | '));
  } finally {
    browser.kill();
    server.close();
  }
}

const GROUPS = { format: groupFormat, base: groupBase, lecture: groupLecture, page: groupPage, fenetre: groupFenetre, historique: groupHistorique, reel: groupReel };
const ON_DEMAND = new Set(['reel']);

async function main() {
  await fs.mkdir(WORK, { recursive: true });
  const names = ONLY ? [ONLY] : Object.keys(GROUPS).filter((name) => !ON_DEMAND.has(name));
  for (const name of names) {
    if (!GROUPS[name]) throw new Error(`groupe inconnu : ${name}`);
    console.log(`\n— ${name}`);
    await GROUPS[name]();
  }
  const failed = results.filter((result) => !result.ok).length;
  console.log(`\n${results.length - failed}/${results.length} vérifications réussies`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
