// Tests du lot 1 : version affichée, ⌘V dans le convertisseur, zip, export PDF et zip, clic droit sur une image.
// Même Chromium et même extension que les autres suites (écran ×2). Le PDF est contrôlé avec pdfinfo et pdftoppm, le zip avec unzip et python3.
// Usage : node lot1.mjs <dossier de sortie> [base|paste|zip|export|export-long|webimage] [motif]

import fs from 'node:fs/promises';
import path from 'node:path';
import { EXTENSION, MANIFEST_EXPECTED, check, extensionPage, launch, prepareExtension, results } from './lib.mjs';

const WORK = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, 'out-lot1'));
const ONLY = process.argv[3];
const NAMED = process.argv[4] ? new RegExp(process.argv[4], 'i') : null;

async function test(name, body) {
  if (NAMED && !NAMED.test(name)) return;
  try {
    const { ok, detail } = await body();
    check(name, ok, detail);
  } catch (err) {
    check(name, false, String(err.message ?? err).split('\n')[0].slice(0, 240));
  }
}

const realManifest = async () => JSON.parse(await fs.readFile(path.join(EXTENSION, 'manifest.json'), 'utf8'));
const sameList = (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());

// --- Version et permissions ---

async function groupBase(context) {
  console.log('\n— Version et permissions');
  await test('version : la fenêtre de l’icône affiche la version du manifeste', async () => {
    const page = await extensionPage(context, 'popup/popup.html');
    try {
      const shown = await page.locator('#version').textContent({ timeout: 5000 });
      const { version } = await realManifest();
      return { ok: shown.includes(version), detail: `affiché « ${shown} », manifeste ${version}` };
    } finally {
      await page.close();
    }
  });
  await test('version : le manifeste vaut MANIFEST_EXPECTED', async () => {
    const { version } = await realManifest();
    return { ok: version === MANIFEST_EXPECTED.version, detail: `${version}, attendu ${MANIFEST_EXPECTED.version}` };
  });
  await test('permissions : le vrai manifeste vaut exactement MANIFEST_EXPECTED, sans host_permissions, <all_urls> ni clipboardRead', async () => {
    const manifest = await realManifest();
    const text = JSON.stringify(manifest);
    const ok =
      sameList(manifest.permissions, MANIFEST_EXPECTED.permissions) &&
      sameList(manifest.optional_host_permissions, MANIFEST_EXPECTED.optional_host_permissions) &&
      !manifest.host_permissions &&
      !text.includes('<all_urls>') &&
      !text.includes('clipboardRead');
    return { ok, detail: `${manifest.permissions.join()} ; facultatifs : ${manifest.optional_host_permissions?.join() ?? 'aucun'}` };
  });
}

async function main() {
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(WORK, { recursive: true });
  const extension = await prepareExtension(WORK);
  const context = await launch(extension, 'profile', WORK);
  try {
    context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const groups = { base: groupBase };
    for (const [name, group] of Object.entries(groups)) {
      if (ONLY && ONLY !== name) continue;
      await group(context);
    }
  } finally {
    await context.close();
  }
  const failed = results.filter((result) => !result.ok).length;
  console.log(`\n${results.length - failed}/${results.length} vérifications réussies`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
