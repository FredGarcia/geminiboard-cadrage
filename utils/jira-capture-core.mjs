// jira-capture-core.mjs : ouverture du navigateur sur un profil dédié, chargement des tickets d'un
// tableau ou d'un backlog Jira, capture de la page en MHTML. Module commun à jira-capture-app.mjs
// (interface) et à jira-capture-mhtml.mjs (ligne de commande).
// Aucun identifiant ne passe par ce module : l'utilisateur se connecte lui-même dans la fenêtre (SSO, MFA).
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

/** Dossier utils/ : base des chemins relatifs saisis dans l'interface. */
export const UTILS_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Profil du navigateur dédié à Jira : il garde la session SSO d'une fois sur l'autre (ignoré par git). */
export const PROFILE_DIR = join(UTILS_DIR, '.jira-profile');

/** Dossier des captures par défaut (ignoré par git). */
export const DEFAULT_OUT_DIR = join(UTILS_DIR, 'mhtml');

/**
 * Canal du navigateur : Chrome installé sur le poste par défaut ; JIRA_CAPTURE_CHANNEL=msedge pour Edge,
 * ou chromium pour le Chromium de Playwright (npx playwright install chromium).
 */
export function browserChannel(env = process.env) {
  const channel = String(env.JIRA_CAPTURE_CHANNEL ?? '').trim() || 'chrome';
  return channel === 'chromium' ? undefined : channel;
}

/** Ouvre une fenêtre visible sur le profil dédié : la connexion SSO s'y fait à la main. */
export function launchBrowser() {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    channel: browserChannel(),
    headless: false,
    viewport: null, // la page prend la taille de la fenêtre
  });
}

/** Dossier de sortie saisi dans l'interface : relatif à utils/ s'il n'est pas absolu, utils/mhtml/ s'il est vide. */
export const outputFolder = (raw, base = UTILS_DIR) => resolve(base, String(raw ?? '').trim() || 'mhtml');

/** Clés des tickets cités par les liens /browse/<CLÉ> de la page, sans doublon. */
const ticketKeys = (page) => page.evaluate(() => [...new Set([...document.querySelectorAll('a[href*="/browse/"]')]
  .map((a) => (a.getAttribute('href') ?? '').match(/\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)/)?.[1]?.toUpperCase())
  .filter(Boolean))]);

/**
 * Fait défiler la page jusqu'à ce qu'aucun ticket nouveau n'apparaisse pendant `stableSteps` pas, puis
 * revient en haut, là où un backlog affiche ses sprints. Rend { seen, present } : tickets vus pendant le
 * défilement, et tickets présents dans la page au moment de la capture. Un écart signale un affichage
 * virtualisé, qui retire de la page les cartes sorties de l'écran.
 */
export async function loadAllTickets(page, { step = 1200, pauseMs = 700, maxSteps = 80, stableSteps = 4 } = {}) {
  const seen = new Set(await ticketKeys(page));
  const { width, height } = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  await page.mouse.move(Math.round(width / 2), Math.round(height / 2)); // la molette fait défiler le bloc sous le pointeur
  for (let i = 0, stable = 0; i < maxSteps && stable < stableSteps; i++) {
    await page.mouse.wheel(0, step);
    await page.waitForTimeout(pauseMs);
    const before = seen.size;
    for (const key of await ticketKeys(page)) seen.add(key);
    stable = seen.size === before ? stable + 1 : 0;
  }
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    for (const el of document.querySelectorAll('*')) if (el.scrollTop > 0) el.scrollTop = 0;
  });
  await page.waitForTimeout(pauseMs);
  return { seen: seen.size, present: (await ticketKeys(page)).length };
}

/** Instantané MHTML de la page, comme « Enregistrer sous… », format « Page Web, un seul fichier ». */
export async function captureMhtml(context, page) {
  const cdp = await context.newCDPSession(page);
  try {
    const { data } = await cdp.send('Page.captureSnapshot', { format: 'mhtml' });
    return data;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** Écrit la capture dans `folder`, créé au besoin, sous un nom horodaté ; rend son chemin. */
export async function writeCapture(folder, data, now = new Date()) {
  await mkdir(folder, { recursive: true });
  const file = join(folder, `sprint-${now.toISOString().replace(/[:.]/g, '-')}.mhtml`);
  await writeFile(file, data);
  return file;
}
