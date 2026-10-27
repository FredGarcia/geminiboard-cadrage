// jira-capture-core.mjs : capture en MHTML des tickets d'un sprint Jira protégé par un SSO. Le navigateur s'ouvre
// sur un profil dédié ; l'utilisateur s'y connecte lui-même (SSO, MFA) : aucun identifiant ne passe par ce module.
// Sur la page du sprint, chaque lien /browse/<CLÉ> retenu par le filtre (préfixe, numéros) est ouvert ; la page
// du ticket est enregistrée en MHTML dans le dossier de sa catégorie, reconnue au terme clé qu'elle contient.
// Module commun à jira-capture-app.mjs (interface) et à jira-capture-mhtml.mjs (ligne de commande).
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

/** Dossier utils/ : base des chemins relatifs saisis dans l'interface. */
export const UTILS_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Dossier des captures par défaut (ignoré par git). */
export const DEFAULT_OUT_DIR = join(UTILS_DIR, 'mhtml');

/** Catégories par défaut : termes clés cherchés dans la page de chaque ticket, et noms de leurs dossiers. */
export const DEFAULT_CATEGORIES = ['ticket avec ia', 'ticket sans ia'];

/** Dossier des tickets dont la page ne contient aucun terme clé, ou en contient plusieurs. */
export const UNCLASSIFIED = 'à classer';

/** Arrêt de la capture après ce nombre d'échecs consécutifs : le plus souvent, la session SSO a expiré. */
export const MAX_FAILURES_IN_ROW = 3;

/** Profil du navigateur dédié à Jira, qui garde la session SSO (ignoré par git) ; JIRA_CAPTURE_PROFILE pour un autre. */
export const profileDir = (env = process.env) => resolve(UTILS_DIR, env.JIRA_CAPTURE_PROFILE || '.jira-profile');

/** Délai d'affichage d'une page de ticket, 20 s par défaut ; JIRA_CAPTURE_PAGE_TIMEOUT_MS pour un Jira lent. */
export const pageTimeoutMs = (env = process.env) => Number(env.JIRA_CAPTURE_PAGE_TIMEOUT_MS) || 20_000;

export const firstLine = (err) => String(err?.message ?? err).split('\n')[0];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------------------------------
// Navigateur
// ---------------------------------------------------------------------------------------------

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
  return chromium.launchPersistentContext(profileDir(), {
    channel: browserChannel(),
    headless: false,
    viewport: null, // la page prend la taille de la fenêtre
  });
}

/** Dossier de sortie saisi : relatif à utils/ s'il n'est pas absolu, utils/mhtml/ s'il est vide. */
export const outputFolder = (raw, base = UTILS_DIR) => resolve(base, String(raw ?? '').trim() || 'mhtml');

/** Sous-dossier d'une capture, à l'heure locale : capture-2026-10-27_21-30-05. */
export function runFolderName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `capture-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}_${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`;
}

// ---------------------------------------------------------------------------------------------
// Filtre et catégories
// ---------------------------------------------------------------------------------------------

/** Lit le filtre { prefix, min, max } ; vides, ils ne filtrent rien. Lève une erreur si une valeur est invalide. */
export function parseFilter({ prefix, min, max } = {}) {
  const p = String(prefix ?? '').trim().toUpperCase();
  if (p && !/^[A-Z][A-Z0-9_]*$/.test(p)) throw new Error(`Préfixe invalide : « ${prefix} » (lettres, chiffres et _, en commençant par une lettre)`);
  const number = (value, label) => {
    const s = String(value ?? '').trim();
    if (!s) return null;
    if (!/^\d{1,9}$/.test(s)) throw new Error(`${label} invalide : « ${value} »`);
    return Number(s);
  };
  const lo = number(min, 'Numéro minimal');
  const hi = number(max, 'Numéro maximal');
  if (lo !== null && hi !== null && lo > hi) throw new Error(`Numéros : ${lo} est plus grand que ${hi}`);
  return { prefix: p, min: lo, max: hi };
}

/** Le ticket `key` (PROJET-NUMÉRO) passe-t-il le filtre ? Le préfixe porte sur la partie PROJET. */
export function matchesFilter(key, { prefix = '', min = null, max = null } = {}) {
  const m = String(key).toUpperCase().match(/^([A-Z][A-Z0-9_]*)-(\d+)$/);
  if (!m) return false;
  const n = Number(m[2]);
  return m[1].startsWith(prefix) && (min === null || n >= min) && (max === null || n <= max);
}

const keyParts = (key) => {
  const m = key.match(/^(.*)-(\d+)$/);
  return [Number(m[2]), m[1]];
};
/** Tri par numéro, puis par projet. */
const byNumber = (a, b) => {
  const [na, pa] = keyParts(a.key);
  const [nb, pb] = keyParts(b.key);
  return na - nb || (pa < pb ? -1 : pa > pb ? 1 : 0);
};

/** Minuscules, sans accents, séparateurs (blancs, _ et -) réduits à une espace. */
export const normalizeText = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[\s_-]+/g, ' ').trim();

/** Motif d'un terme clé : mots entiers, séparés par une espace, un tiret, un _ ou rien (« TicketAvecIA »). */
export const termPattern = (term) => new RegExp(`(?<![a-z0-9])${normalizeText(term).split(' ').map(escapeRe).join(' ?')}(?![a-z0-9])`);

// Interdit dans un nom de dossier sous Windows ou Linux
const BAD_FOLDER_NAME = /[<>:"/\\|?*\u0000-\u001f]/;

/** Lit les catégories (liste, ou texte à une catégorie par ligne ou séparées par « ; ») ; elles nomment les dossiers. */
export function parseCategories(raw = DEFAULT_CATEGORIES) {
  const list = (Array.isArray(raw) ? raw : String(raw ?? '').split(/\r?\n|;/))
    .map((c) => String(c).trim().replace(/\s+/g, ' ')).filter(Boolean);
  if (!list.length) throw new Error('Indiquez au moins une catégorie');
  if (list.length > 10) throw new Error('10 catégories au plus');
  for (const c of list) {
    if (c.length > 60 || BAD_FOLDER_NAME.test(c) || /^\.|\.$/.test(c)) {
      throw new Error(`Catégorie « ${c} » : 60 caractères au plus, sans < > : " / \\ | ? * ni point au début ou à la fin`);
    }
  }
  const keys = list.map(normalizeText);
  if (new Set(keys).size !== keys.length) throw new Error('Catégories en double');
  if (keys.includes(normalizeText(UNCLASSIFIED))) throw new Error(`« ${UNCLASSIFIED} » est réservé aux tickets sans catégorie`);
  return list;
}

const excerptAround = (hay, m) => {
  const start = Math.max(0, m.index - 40);
  const end = Math.min(hay.length, m.index + m[0].length + 40);
  return `${start > 0 ? '…' : ''}${hay.slice(start, end)}${end < hay.length ? '…' : ''}`;
};

/**
 * Catégorie d'un ticket d'après les textes de sa page, pris dans l'ordre : [[où, texte], …]. Le premier texte
 * qui contient au moins un terme clé décide : une seule catégorie trouvée est retenue ; plusieurs, aucune.
 * Rend { category, where, found, excerpt } ; category vaut null si le ticket est à classer.
 */
export function classify(sources, categories) {
  for (const [where, text] of sources) {
    const hay = normalizeText(text);
    const hits = [];
    for (const c of categories) {
      const m = termPattern(c).exec(hay);
      if (m) hits.push({ c, m });
    }
    if (hits.length === 1) return { category: hits[0].c, where, found: [hits[0].c], excerpt: excerptAround(hay, hits[0].m) };
    if (hits.length > 1) return { category: null, where, found: hits.map((h) => h.c), excerpt: null };
  }
  return { category: null, where: null, found: [], excerpt: null };
}

// ---------------------------------------------------------------------------------------------
// Page du sprint
// ---------------------------------------------------------------------------------------------

async function centerMouse(page) {
  const { width, height } = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  await page.mouse.move(Math.round(width / 2), Math.round(height / 2)); // la molette fait défiler le bloc sous le pointeur
}

async function scrollToTop(page, pauseMs) {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    for (const el of document.querySelectorAll('*')) if (el.scrollTop > 0) el.scrollTop = 0;
  });
  await page.waitForTimeout(pauseMs);
}

/** Liens des tickets de la page : [{ key, url }], une entrée par clé, adresse ramenée à …/browse/<CLÉ>. */
const ticketLinks = (page) => page.evaluate(() => {
  const links = new Map();
  for (const a of document.querySelectorAll('a[href*="/browse/"]')) {
    const m = (a.getAttribute('href') ?? '').match(/^(.*?\/browse\/)([A-Za-z][A-Za-z0-9_]*-\d+)/);
    if (!m) continue;
    const key = m[2].toUpperCase();
    if (!links.has(key)) links.set(key, new URL(m[1] + key, document.baseURI).href);
  }
  return [...links].map(([key, url]) => ({ key, url }));
});

/**
 * Fait défiler la page jusqu'à ce qu'aucun ticket nouveau n'apparaisse pendant `stableSteps` pas, puis revient
 * en haut. Les liens sont relevés à chaque pas : un affichage virtualisé, qui retire de la page les cartes
 * sorties de l'écran, ne fait donc perdre aucun ticket. Rend { seen, present, links }.
 */
export async function loadAllTickets(page, { step = 1200, pauseMs = 700, maxSteps = 80, stableSteps = 4 } = {}) {
  const seen = new Map();
  const add = (links) => { for (const l of links) if (!seen.has(l.key)) seen.set(l.key, l.url); };
  add(await ticketLinks(page));
  await centerMouse(page);
  for (let i = 0, stable = 0; i < maxSteps && stable < stableSteps; i++) {
    await page.mouse.wheel(0, step);
    await page.waitForTimeout(pauseMs);
    const before = seen.size;
    add(await ticketLinks(page));
    stable = seen.size === before ? stable + 1 : 0;
  }
  await scrollToTop(page, pauseMs);
  return { seen: seen.size, present: (await ticketLinks(page)).length, links: [...seen].map(([key, url]) => ({ key, url })) };
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

// ---------------------------------------------------------------------------------------------
// Pages des tickets
// ---------------------------------------------------------------------------------------------

/**
 * Attend que la page soit celle du ticket (adresse …/browse/<CLÉ> ou titre qui la contient) et que la clé
 * soit affichée. Les navigations en cours, comme un aller-retour par le SSO, sont tolérées.
 */
async function waitForTicket(page, key, timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const ok = await page.evaluate((k) => {
      const onTicket = new RegExp(`/BROWSE/${k}(?![0-9])`).test(location.href.toUpperCase()) || document.title.toUpperCase().includes(k);
      return onTicket && (document.body?.innerText ?? '').toUpperCase().includes(k);
    }, key).catch(() => false);
    if (ok) return true;
    if (Date.now() >= end) return false;
    await page.waitForTimeout(400);
  }
}

/** Fait défiler la page tant que son texte s'allonge (commentaires chargés à l'affichage), puis revient en haut. */
async function scrollThrough(page, { step = 1200, pauseMs = 500, maxSteps = 15, stableSteps = 2 } = {}) {
  const length = () => page.evaluate(() => document.body?.innerText.length ?? 0);
  await centerMouse(page);
  let last = await length();
  for (let i = 0, stable = 0; i < maxSteps && stable < stableSteps; i++) {
    await page.mouse.wheel(0, step);
    await page.waitForTimeout(pauseMs);
    const now = await length();
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
  await scrollToTop(page, pauseMs);
}

/** Attend que le texte de la page ne change plus (deux relevés identiques), 10 s au plus. */
async function waitForStableText(page, { pauseMs = 500, maxMs = 10_000 } = {}) {
  const end = Date.now() + maxMs;
  let last = -1;
  for (let stable = 0; stable < 2 && Date.now() < end;) {
    const now = await page.evaluate(() => document.body?.innerText.length ?? 0).catch(() => -1);
    stable = now === last ? stable + 1 : 0;
    last = now;
    await page.waitForTimeout(pauseMs);
  }
}

/**
 * Textes où chercher la catégorie, du plus sûr au moins sûr : le contenu principal (main), visible ; le même,
 * panneaux repliés compris ; la page visible, hors navigation, si elle n'a pas de contenu principal. La
 * navigation (filtres enregistrés, éléments récents) peut citer un terme clé sans rapport avec le ticket.
 */
const pageTexts = (page) => page.evaluate(() => {
  const SKIP = /^(?:SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/;
  const NAV = 'nav, header, aside, [role="navigation"], [role="banner"]';
  const collect = (root, { visibleOnly, skipNav }) => {
    const parts = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const el = walker.currentNode.parentElement;
      if (!el || SKIP.test(el.tagName)) continue;
      if (skipNav && el.closest(NAV)) continue;
      if (visibleOnly && !(el.checkVisibility ? el.checkVisibility() : el.offsetParent !== null)) continue;
      parts.push(walker.currentNode.nodeValue);
    }
    return parts.join(' ');
  };
  const main = document.querySelector('main, [role="main"]');
  return [
    ['contenu', main ? collect(main, { visibleOnly: true }) : ''],
    ['contenu masqué', main ? collect(main, { visibleOnly: false }) : ''],
    ['page', collect(document.body, { visibleOnly: true, skipNav: true })],
  ];
});

/** Ouvre la page du ticket, la charge en entier et la capture : rend { data, texts }. */
export async function captureTicket(context, page, { key, url }, { timeoutMs = pageTimeoutMs() } = {}) {
  let navError = null;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch((err) => { navError = err; });
  if (!(await waitForTicket(page, key, timeoutMs))) {
    throw new Error(navError
      ? `ouverture impossible (${firstLine(navError)})`
      : `page du ticket non affichée après ${timeoutMs / 1000} s (session SSO expirée ?)`);
  }
  await scrollThrough(page);
  await waitForStableText(page);
  const texts = await pageTexts(page);
  return { data: await captureMhtml(context, page), texts };
}

// ---------------------------------------------------------------------------------------------
// Capture d'un sprint
// ---------------------------------------------------------------------------------------------

/**
 * Capture les tickets de la page du sprint affichée dans `page`, dans un sous-dossier daté de `folder` :
 *   sprint.mhtml         la page du sprint, d'où viennent les liens
 *   <catégorie>/<CLÉ>.mhtml   un fichier par ticket retenu, dans le dossier de sa catégorie
 *   à classer/<CLÉ>.mhtml     aucun terme clé trouvé, ou plusieurs
 *   rapport.json         filtre, catégories, et pour chaque ticket : catégorie, extrait trouvé ou erreur
 * onProgress({ step, done, total, key }) suit l'avancement. Rend le rapport.
 */
export async function captureSprintTickets(context, page, {
  folder = DEFAULT_OUT_DIR, filter = {}, categories = DEFAULT_CATEGORIES, now = new Date(),
  onProgress = () => {}, timeoutMs = pageTimeoutMs(),
} = {}) {
  onProgress({ step: 'liste', done: 0, total: 0, key: null });
  const sprintUrl = page.url();
  const list = await loadAllTickets(page);
  const runDir = join(folder, runFolderName(now));
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'sprint.mhtml'), await captureMhtml(context, page));

  const selected = list.links.filter((l) => matchesFilter(l.key, filter)).sort(byNumber);
  const ignored = list.links.filter((l) => !matchesFilter(l.key, filter)).map((l) => l.key);
  const tickets = [];
  let failuresInRow = 0;
  let aborted = false;
  for (const [i, ticket] of selected.entries()) {
    onProgress({ step: 'tickets', done: i, total: selected.length, key: ticket.key });
    try {
      const { data, texts } = await captureTicket(context, page, ticket, { timeoutMs });
      const c = classify(texts, categories);
      const dir = c.category ?? UNCLASSIFIED;
      await mkdir(join(runDir, dir), { recursive: true });
      await writeFile(join(runDir, dir, `${ticket.key}.mhtml`), data);
      tickets.push({ ...ticket, category: c.category, found: c.found, where: c.where, excerpt: c.excerpt, file: `${dir}/${ticket.key}.mhtml` });
      failuresInRow = 0;
    } catch (err) {
      tickets.push({ ...ticket, category: null, error: firstLine(err) });
      failuresInRow++;
      if (page.isClosed() || failuresInRow >= MAX_FAILURES_IN_ROW) {
        aborted = i + 1 < selected.length;
        break;
      }
    }
  }

  const counts = Object.fromEntries([...categories, UNCLASSIFIED].map((c) => [c, 0]));
  let errors = 0;
  for (const t of tickets) {
    if (t.error) errors++;
    else counts[t.category ?? UNCLASSIFIED]++;
  }
  const report = {
    date: now.toISOString(), sprintUrl, folder: runDir, filter, categories,
    listed: list.links.length, selected: selected.length, ignored: ignored.length, ignoredSample: ignored.slice(0, 20),
    counts, errors, aborted, tickets,
  };
  await writeFile(join(runDir, 'rapport.json'), `${JSON.stringify(report, null, 2)}\n`);
  onProgress({ step: 'fin', done: tickets.length, total: selected.length, key: null });
  return report;
}
