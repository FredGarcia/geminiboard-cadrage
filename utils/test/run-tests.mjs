#!/usr/bin/env node
// run-tests.mjs : contrôles des utilitaires Jira contre un faux Jira local (test/fake-jira.mjs), sans réseau ni compte.
// Le navigateur s'ouvre, visible, sur un profil temporaire : le profil et les captures de utils/ ne sont pas touchés.
//   Navigateur : celui de JIRA_CAPTURE_CHANNEL (chrome par défaut ; chromium après npx playwright install chromium).
//   Linux sans écran : xvfb-run -a npm test.
//   Python : variable PYTHON, à défaut py sous Windows et python3 ailleurs ; s'il manque, ses contrôles sont sautés.
// Usage, depuis utils/ : npm test ; sortie 0 si tout passe, 1 sinon (dossier temporaire gardé pour l'examen).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import {
  DEFAULT_CATEGORIES, UNCLASSIFIED, browserChannel, classify, matchesFilter, outputFolder, parseCategories,
  parseFilter, profileDir, runFolderName,
} from '../jira-capture-core.mjs';
import { BOARD_42, TICKETS, startFakeJira } from './fake-jira.mjs';

const UTILS = fileURLToPath(new URL('..', import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), 'jira-utils-'));
const ENV = { ...process.env, JIRA_CAPTURE_PROFILE: join(TMP, 'profil'), JIRA_CAPTURE_PAGE_TIMEOUT_MS: '3000' };
const results = [];
const children = [];

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'OK  ' : 'KO  '} ${name}${detail ? ` : ${detail}` : ''}`);
}
function skip(name, reason) {
  results.push({ name, ok: true, skipped: true });
  console.log(`SAUT ${name} : ${reason}`);
}
const section = (title) => console.log(`\n# ${title}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
// Texte d'un MHTML : lignes douces du quoted-printable recollées (les accents restent encodés)
const mhtml = (file) => readFileSync(file, 'latin1').replace(/=\r?\n/g, '');

function startApp(script, env = {}) {
  const child = spawn(process.execPath, [join(UTILS, script)], { env: { ...ENV, PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${script} ne démarre pas :\n${log}`)), 15_000);
    const poll = setInterval(() => {
      const m = log.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (!m) return;
      clearTimeout(timer);
      clearInterval(poll);
      resolve({ child, port: Number(m[1]), log: () => log });
    }, 50);
    child.on('exit', (code) => {
      clearTimeout(timer);
      clearInterval(poll);
      reject(new Error(`${script} arrêté (code ${code}) :\n${log}`));
    });
  });
}

/** Lance une commande sans bloquer ce processus, qui sert le faux Jira ; rend { status, stdout, stderr }. */
function run(cmd, args, { env = ENV, input = '', timeout = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('error', (err) => { clearTimeout(timer); resolve({ status: null, stdout, stderr: stderr + err.message }); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.stdin.end(input);
  });
}

function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* page HTML */ }
        resolve({ status: res.statusCode, text: data, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const post = (port, path, obj, headers = {}) => request(port, {
  method: 'POST', path, body: JSON.stringify(obj),
  headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}`, ...headers },
});

/** Contrôles d'hôte, d'origine et de type de contenu, communs aux deux interfaces. */
async function guards(port, label) {
  const page = await request(port, { path: '/' });
  check(`${label} : la page s'affiche`, page.status === 200 && /<html/.test(page.text), `HTTP ${page.status}`);
  const host = await request(port, { path: '/', headers: { Host: `evil.example.com:${port}` } });
  check(`${label} : hôte étranger refusé (rebond DNS)`, host.status === 403, `HTTP ${host.status}`);
  const origin = await post(port, '/api/close', {}, { Origin: 'https://evil.example.com' });
  check(`${label} : origine étrangère refusée`, origin.status === 403, `HTTP ${origin.status}`);
  const plain = await request(port, { method: 'POST', path: '/api/close', body: '{}', headers: { 'Content-Type': 'text/plain' } });
  check(`${label} : corps text/plain refusé`, plain.status === 415, `HTTP ${plain.status}`);
  const unknown = await request(port, { path: '/inconnu' });
  check(`${label} : route inconnue`, unknown.status === 404 && Boolean(unknown.json?.error), `HTTP ${unknown.status}`);
}

/** Attend la fin de la capture en cours ; rend le dernier état. */
async function waitForJob(port, timeoutMs = 240_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const { json } = await request(port, { path: '/api/status' });
    if (json.job.state !== 'running' || Date.now() > end) return json;
    await sleep(500);
  }
}

// Résultat attendu de chaque ticket du backlog 42 (test/fake-jira.mjs)
const EXPECTED = {
  'DEMOAB-3500': { category: 'ticket avec ia', where: 'contenu' },
  'DEMOCD-3501': { category: 'ticket sans ia', where: 'contenu' },
  'DEMOAB-3502': { category: 'ticket avec ia', where: 'contenu' },
  'DEMOEF-3600': { category: 'ticket sans ia', where: 'contenu masqué' },
  'DEMOAB-3700': { category: null, found: 0 },
  'DEMOAB-3800': { category: null, found: 2 },
  'DEMOAB-3900': { error: true },
  'DEMOAB-4500': { category: 'ticket avec ia', where: 'contenu' },
};

/** Vérifie le rapport et les fichiers d'une capture du backlog 42 filtrée sur DEMO, 3500 à 4500. */
function verifyRun(report, label) {
  check(`${label} : tickets relevés sur la page`, report.listed === BOARD_42.length + 1, `${report.listed} (dont l'épopée DEMOE-100)`);
  const keys = report.tickets.map((t) => t.key).join(' ');
  check(`${label} : filtre (préfixe, bornes comprises), tri par numéro`, keys === Object.keys(EXPECTED).join(' ') && report.selected === 8, keys);
  for (const [key, exp] of Object.entries(EXPECTED)) {
    const t = report.tickets.find((x) => x.key === key) ?? {};
    let ok;
    let detail;
    if (exp.error) {
      ok = /session SSO expirée/.test(t.error ?? '') && !t.file;
      detail = t.error;
    } else if (exp.category) {
      ok = t.category === exp.category && t.where === exp.where && existsSync(join(report.folder, t.file ?? '-'));
      detail = `${t.file} (${t.where}) ${t.excerpt ?? ''}`;
    } else {
      ok = t.category === null && t.found.length === exp.found && t.file === `${UNCLASSIFIED}/${key}.mhtml` && existsSync(join(report.folder, t.file));
      detail = `${t.file}, trouvé : ${t.found.join(' + ') || 'rien'}`;
    }
    check(`${label} : ${key} ${TICKETS[key].expired ? '(session expirée)' : ''}`.trimEnd(), ok, detail);
  }
  const files = report.tickets.filter((t) => t.file).map((t) => join(report.folder, t.file));
  check(`${label} : chaque fichier est la page MHTML de son ticket`, files.length === 7
    && files.every((f) => { const s = mhtml(f); return /^From: <Saved by Blink>/m.test(s) && s.includes(f.match(/([A-Z]+-\d+)\.mhtml$/)[1]); }));
  const lazy = join(report.folder, 'ticket avec ia', 'DEMOAB-4500.mhtml');
  check(`${label} : commentaire chargé au défilement capturé`, existsSync(lazy) && mhtml(lazy).includes('Commentaire charg'));
  const onDisk = JSON.parse(readFileSync(join(report.folder, 'rapport.json'), 'utf8'));
  check(`${label} : page du sprint et rapport.json écrits`, existsSync(join(report.folder, 'sprint.mhtml'))
    && JSON.stringify(onDisk.counts) === JSON.stringify(report.counts) && onDisk.tickets.length === 8);
  check(`${label} : décompte`, JSON.stringify(report.counts) === JSON.stringify({ 'ticket avec ia': 3, 'ticket sans ia': 2, [UNCLASSIFIED]: 2 })
    && report.errors === 1 && report.aborted === false, `${JSON.stringify(report.counts)}, erreurs : ${report.errors}`);
}

let fake;
try {
  // ------------------------------------------------------------------ fonctions pures
  section('Filtre, catégories, chemins');
  const f = parseFilter({ prefix: 'demo', min: '3500', max: '4500' });
  check('filtre : préfixe en majuscules, bornes en nombres', f.prefix === 'DEMO' && f.min === 3500 && f.max === 4500);
  check('filtre : vide, il retient tout', matchesFilter('XYZ-1', parseFilter({})));
  check('filtre : bornes comprises', matchesFilter('DEMOAB-3500', f) && matchesFilter('DEMOAB-4500', f)
    && !matchesFilter('DEMOAB-3499', f) && !matchesFilter('DEMOAB-4501', f));
  check('filtre : le préfixe porte sur le début du projet', matchesFilter('demoab-3600', f) && !matchesFilter('AUTRE-3600', f) && !matchesFilter('XDEMO-3600', f));
  check('filtre : valeurs invalides refusées', ['1AB', 'A-B', 'é'].every((p) => throws(() => parseFilter({ prefix: p })))
    && throws(() => parseFilter({ min: 'abc' })) && throws(() => parseFilter({ min: '10', max: '5' })));
  check('catégories : par défaut', parseCategories().join('|') === DEFAULT_CATEGORIES.join('|'));
  check('catégories : texte, une par ligne ou séparées par « ; »', parseCategories('a\r\n b ;c').join('|') === 'a|b|c');
  check('catégories : nom de dossier invalide, doublon, « à classer » ou liste vide refusés',
    [['a/b'], ['x:'], ['.cache'], ['ticket avec ia', 'Ticket-avec-IA'], [UNCLASSIFIED], []].every((c) => throws(() => parseCategories(c))));
  const cls = (text) => classify([['contenu', text]], DEFAULT_CATEGORIES);
  check('classement : graphies reconnues', ['ticket avec ia', 'Ticket-avec-IA', 'TICKET_AVEC_IA', 'TicketAvecIA', 'tîcket avec ïa']
    .every((s) => cls(s).category === 'ticket avec ia'));
  check('classement : mots entiers seulement', ['tickets avec ia', 'ticket avec iam', 'unticket avec ia'].every((s) => cls(s).category === null));
  check('classement : deux catégories, aucune retenue', cls('ticket avec ia, ticket sans ia').category === null
    && cls('ticket avec ia, ticket sans ia').found.length === 2);
  const ordered = classify([['contenu', 'rien'], ['contenu masqué', 'ticket sans ia'], ['page', 'ticket avec ia']], DEFAULT_CATEGORIES);
  check('classement : le premier texte qui contient un terme décide', ordered.category === 'ticket sans ia' && ordered.where === 'contenu masqué');
  check('classement : extrait autour du terme', /ticket avec ia/.test(cls('Étiquettes : ticket-avec-ia').excerpt ?? ''));
  check('dossier de sortie : relatif à utils/, utils/mhtml/ si vide', outputFolder('') === resolve(UTILS, 'mhtml')
    && outputFolder('x') === resolve(UTILS, 'x') && outputFolder(TMP) === TMP);
  check('profil : utils/.jira-profile, ou JIRA_CAPTURE_PROFILE', profileDir({}) === resolve(UTILS, '.jira-profile')
    && profileDir({ JIRA_CAPTURE_PROFILE: TMP }) === TMP);
  check('navigateur : chrome par défaut, msedge, chromium de Playwright', browserChannel({}) === 'chrome'
    && browserChannel({ JIRA_CAPTURE_CHANNEL: 'msedge' }) === 'msedge' && browserChannel({ JIRA_CAPTURE_CHANNEL: 'chromium' }) === undefined);
  check("sous-dossier daté, à l'heure locale", runFolderName(new Date(2026, 9, 27, 21, 5, 9)) === 'capture-2026-10-27_21-05-09');

  section('Dépôt public');
  const ignored = spawnSync('git', ['check-ignore', '--no-index', 'utils/.jira-profile/Default/Cookies',
    'utils/mhtml/capture-x/sprint.mhtml', 'ailleurs/page.mhtml', 'utils/exports/x.csv'], { cwd: join(UTILS, '..'), encoding: 'utf8' });
  if (ignored.error || ignored.status === 128) skip('git ignore profil, captures et exports', "hors d'un dépôt git");
  else check('git ignore profil, captures et exports', ignored.stdout.trim().split('\n').length === 4, ignored.stdout.trim().replace(/\n/g, ' ; '));

  fake = await startFakeJira();
  const backlog = `${fake.url}/jira/software/c/projects/DEMO/boards/42/backlog`;

  // ------------------------------------------------------------------ export par l'API (Node.js)
  section("jira-sprint-app.mjs : export par l'API");
  const api = await startApp('jira-sprint-app.mjs');
  await guards(api.port, 'export');
  const creds = { url: `${fake.url}/`, login: 'jean.dupont@example.com', password: 'motdepasse' };
  let r = await post(api.port, '/api/export', { ...creds, board: 'Équipe démo' });
  check('export : prochain sprint = date de début la plus proche', r.json?.sprint?.name === 'Sprint 7', r.json?.sprint?.name ?? r.json?.error);
  check('export : 120 tickets sur trois pages', r.json?.tickets?.length === 120, `${r.json?.tickets?.length}`);
  const t1 = r.json?.tickets?.[0] ?? {};
  check('export : description ADF mise à plat, estimation, parent', t1.description === 'Critère : export 1' && t1.estimation === 2 && t1.parent === 'EPIC-1');
  check('export : ticket non assigné', r.json?.tickets?.[3]?.assigne === 'Non assigné');
  r = await post(api.port, '/api/export', { ...creds, board: '42', sprint: 'Sprint 8' });
  check('export : tableau par identifiant, sprint par nom', r.json?.sprint?.id === 7 && r.json?.tickets?.length === 3);
  r = await post(api.port, '/api/export', { ...creds, board: 'Équipe' });
  check('export : tableau ambigu signalé', r.status === 400 && /Plusieurs tableaux/.test(r.json?.error ?? ''));
  r = await post(api.port, '/api/export', { ...creds, password: 'faux', board: 'Équipe démo' });
  check('export : mauvais mot de passe', r.status === 401);
  check('export : aucun mot de passe dans le journal', !/motdepasse|faux/.test(api.log()));
  api.child.kill();

  // ------------------------------------------------------------------ export par l'API (Python)
  section("jira_sprint_export.py : export par l'API");
  const PY = process.env.PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
  if (spawnSync(PY, ['--version']).status !== 0) {
    skip('export Python', `${PY} introuvable`);
  } else {
    const py = (args, env) => run(PY, [join(UTILS, 'jira_sprint_export.py'), ...args], { env: { ...process.env, JIRA_URL: fake.url, ...env } });
    let p = await py(['--board', 'Équipe démo', '--out', join(TMP, 'py')], { JIRA_EMAIL: 'jean.dupont@example.com', JIRA_TOKEN: 'jeton-demo' });
    const csv = existsSync(join(TMP, 'py')) ? readdirSync(join(TMP, 'py')).find((x) => x.endsWith('.csv')) : null;
    const rows = csv ? readFileSync(join(TMP, 'py', csv), 'utf8').trimEnd().split('\n') : []; // trim() ôterait le BOM
    check('python, e-mail et jeton : 120 tickets en CSV', p.status === 0 && rows.length === 121, `${p.status} ${p.stderr.trim()}`);
    check('python : CSV pour Excel (BOM, séparateur « ; »)', rows[0]?.startsWith('﻿cle;type;resume'));
    p = await py(['--board', '42', '--sprint', 'Sprint 8', '--out', join(TMP, 'py2')], { JIRA_EMAIL: '', JIRA_TOKEN: 'pat-demo' });
    check('python, jeton personnel (Bearer)', p.status === 0 && /3 tickets exportés/.test(p.stdout), p.stdout.trim().split('\n')[2]);
    p = await py(['--board', '42', '--out', join(TMP, 'py3')], { JIRA_EMAIL: 'jean.dupont@example.com', JIRA_TOKEN: 'faux' });
    check('python : jeton refusé', p.status === 1 && /authentification refusée/.test(p.stderr));
  }

  // ------------------------------------------------------------------ capture, interface
  section('jira-capture-app.mjs : capture des tickets');
  const app = await startApp('jira-capture-app.mjs');
  const port = app.port;
  await guards(port, 'capture');
  r = await post(port, '/api/capture', {});
  check('capture : refusée sans sprint ouvert', r.status === 409, r.json?.error);
  r = await post(port, '/api/open', { url: 'file:///etc/passwd' });
  check('capture : adresse non http refusée', r.status === 400, r.json?.error);

  r = await post(port, '/api/open', { url: backlog });
  check('capture : navigateur ouvert, après le SSO', r.status === 200 && /ouvert sur le sprint/.test(r.json?.message ?? ''), r.json?.message ?? r.json?.error);
  check('capture : un passage par le SSO', fake.stats.ssoLogins === 1, `${fake.stats.ssoLogins}`);
  r = await post(port, '/api/capture', { prefix: '1AB' });
  check('capture : préfixe invalide refusé', r.status === 400, r.json?.error);
  r = await post(port, '/api/capture', { categories: 'ticket avec ia\nà classer' });
  check('capture : catégorie réservée refusée', r.status === 400, r.json?.error);

  const filter = { prefix: 'demo', min: '3500', max: '4500', categories: 'ticket avec ia\nticket sans ia' };
  let started = Date.now();
  r = await post(port, '/api/capture', { ...filter, folder: join(TMP, 'sortie') });
  check('capture : lancée en tâche de fond', r.status === 202, r.json?.message);
  r = await post(port, '/api/capture', { ...filter, folder: join(TMP, 'sortie') });
  check('capture : une seule à la fois', r.status === 409, r.json?.error);
  let status = await waitForJob(port);
  check('capture (liste chargée au défilement) : terminée', status.job.state === 'done', `${status.job.state} en ${((Date.now() - started) / 1000).toFixed(1)} s ${status.job.error ?? ''}`);
  if (status.job.report) {
    verifyRun(status.job.report, 'défilement');
    check('défilement : sous-dossier daté dans le dossier de sortie', status.job.report.folder.startsWith(join(TMP, 'sortie', 'capture-')), status.job.report.folder);
  }
  check('capture : avec une erreur, le navigateur reste ouvert', status.browser === true);

  r = await post(port, '/api/open', { url: `${backlog}?mode=virtual` });
  check('capture : session SSO gardée dans le profil', r.status === 200 && fake.stats.ssoLogins === 1, `${fake.stats.ssoLogins}`);
  started = Date.now();
  await post(port, '/api/capture', { ...filter, folder: join(TMP, 'sortie-virtuelle') });
  status = await waitForJob(port);
  check('capture (liste virtualisée) : terminée', status.job.state === 'done', `${((Date.now() - started) / 1000).toFixed(1)} s ${status.job.error ?? ''}`);
  if (status.job.report) verifyRun(status.job.report, 'virtualisée');

  r = await post(port, '/api/open', { url: `${fake.url}/jira/software/c/projects/DEMO/boards/43/backlog` });
  await post(port, '/api/capture', { prefix: 'DEMOXP', folder: join(TMP, 'sortie-expiree') });
  status = await waitForJob(port);
  const expired = status.job.report ?? {};
  check('capture : arrêt après trois échecs de suite', expired.aborted === true && expired.errors === 3 && expired.selected === 5
    && expired.tickets.length === 3, `${expired.errors} erreurs sur ${expired.selected}, arrêt : ${expired.aborted}`);

  r = await post(port, '/api/open', { url: backlog });
  await post(port, '/api/capture', { ...filter, folder: join(TMP, 'sortie-arretee') });
  for (let i = 0; i < 120; i++) { // attend le deuxième ticket
    const { json } = await request(port, { path: '/api/status' });
    if (json.job.step === 'tickets' && json.job.done >= 1) break;
    await sleep(250);
  }
  r = await post(port, '/api/close', {});
  check('capture : « Fermer le navigateur » arrête la capture', r.status === 200 && /arrêtée/.test(r.json?.message ?? ''), r.json?.message);
  status = await waitForJob(port);
  check('capture arrêtée : rapport partiel', status.job.state === 'done' && status.job.report?.aborted === true
    && status.job.report.tickets.length < 8 && status.browser === false, `${status.job.report?.tickets.length} tickets`);

  // ------------------------------------------------------------------ page de l'interface, pilotée comme par l'utilisateur
  section('capture.html : page de l\'interface');
  const ui = await chromium.launch({ channel: browserChannel(), headless: true });
  try {
    const page = await ui.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.fill('#url', backlog);
    await page.fill('#prefix', 'demo');
    await page.fill('#min', '3500');
    await page.fill('#max', '4500');
    await page.fill('#folder', join(TMP, 'interface'));
    await page.click('#open');
    await page.waitForFunction(() => /ouvert sur le sprint/.test(document.getElementById('status').textContent), null, { timeout: 30_000 });
    check("interface : « Capturer les tickets » activé après l'ouverture", await page.isEnabled('#capture'));
    await page.click('#capture');
    await page.waitForFunction(() => /^Ticket \d+ sur 8 : DEMO/.test(document.getElementById('status').textContent), null, { timeout: 60_000 });
    check('interface : avancement affiché, boutons bloqués', await page.isVisible('#progress') && await page.isDisabled('#open') && await page.isDisabled('#capture'));
    await page.waitForFunction(() => !document.getElementById('report').hidden, null, { timeout: 180_000 });
    const statusText = await page.textContent('#status');
    check('interface : bilan de fin', /Capture terminée : 7 tickets enregistrés sur 8, 1 en erreur/.test(statusText), statusText);
    const summary = (await page.textContent('#report-summary')).replace(/\s+/g, ' ');
    check('interface : résumé du rapport', /retenus par le filtre : 8/.test(summary) && /ticket avec ia : 3/.test(summary) && /à classer : 2/.test(summary), summary);
    const rows = await page.$$eval('#report-rows tr', (trs) => trs.map((tr) => [...tr.cells].map((td) => td.textContent)));
    check('interface : une ligne par ticket, erreur signalée', rows.length === 8
      && rows.find((x) => x[0] === 'DEMOAB-3900')?.[3].includes('session SSO') && rows.find((x) => x[0] === 'DEMOAB-3700')?.[1] === UNCLASSIFIED, `${rows.length} lignes`);
    check('interface : avertissement après une erreur', await page.isVisible('#report-warning'));
    await page.screenshot({ path: join(TMP, 'interface.png'), fullPage: true });
    await page.reload();
    check('interface : valeurs gardées dans le navigateur', await page.inputValue('#prefix') === 'demo'
      && await page.inputValue('#max') === '4500' && await page.inputValue('#url') === backlog);
  } finally {
    await ui.close();
  }
  await post(port, '/api/close', {});
  app.child.kill('SIGINT');
  await sleep(1000);

  // ------------------------------------------------------------------ capture, ligne de commande
  section('jira-capture-mhtml.mjs : ligne de commande');
  const cli = (args) => run(process.execPath, [join(UTILS, 'jira-capture-mhtml.mjs'), ...args], { input: '\n' });
  let c = await cli([]);
  check('ligne de commande : adresse manquante', c.status === 2 && /Usage/.test(c.stderr));
  c = await cli([backlog, '--min', 'abc']);
  check('ligne de commande : numéro invalide', c.status === 2 && /Numéro minimal invalide/.test(c.stderr));
  c = await cli([backlog, '--prefixe', 'demoab', '--min', '4500', '--max', '4500', '--sortie', join(TMP, 'cli')]);
  const cliRun = existsSync(join(TMP, 'cli')) ? readdirSync(join(TMP, 'cli'), { withFileTypes: true }).find((d) => d.isDirectory())?.name ?? '-' : '-';
  check('ligne de commande : un ticket capturé et classé', c.status === 0 && /retenus par le filtre : 1 /.test(c.stdout)
    && existsSync(join(TMP, 'cli', cliRun, 'ticket avec ia', 'DEMOAB-4500.mhtml')), `${c.status} ${c.stderr.trim().split('\n')[0] ?? ''}`);
} catch (err) {
  check('exécution', false, err.stack);
} finally {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  await fake?.close();
  const failed = results.filter((x) => !x.ok);
  const skipped = results.filter((x) => x.skipped).length;
  if (failed.length || process.env.KEEP_TMP) console.log(`\nDossier temporaire gardé pour l'examen : ${TMP}`);
  else rmSync(TMP, { recursive: true, force: true });
  console.log(`\nBilan : ${results.length} contrôles, ${results.length - failed.length - skipped} réussis, ${failed.length} en échec, ${skipped} sautés · Node.js ${process.version}`);
  process.exit(failed.length ? 1 : 0);
}
