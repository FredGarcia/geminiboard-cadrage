// Scripts de la skill geminiboard (skills/geminiboard/scripts) : compatibilité Node.js 20, données
// sensibles, lignes ajoutées d'un diff, lecture du README et des migrations, puis etat.mjs et
// verifier.mjs lancés sur ce dépôt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MIGRATION_NAME, ROOT, listMigrations, migrationChecksum, nextMigrationNumber, readReadme, splitArgs, stepOfBranch,
} from '../../skills/geminiboard/scripts/depot.mjs';
import {
  addedLines, admitsNode, incompatiblePackages, isForbiddenFile, parseLocalPatterns, scanLines,
} from '../../skills/geminiboard/scripts/verifier.mjs';

const SCRIPTS = fileURLToPath(new URL('../../skills/geminiboard/scripts/', import.meta.url));

test('engines.node : plages acceptées ou refusées pour Node.js 20.19.0', () => {
  const accepted = ['>=20', '20.x || 22.x || 23.x || 24.x || 25.x', '>= 6', '*', '', '>=0.10.0', '^20.19.0 || ^22.12.0 || >=24.0.0',
    '^18 || ^20', '18 - 20', '>=20.19.0', '~20.19', '20', '>19', '<=20', '^20.0.0-rc.1', 'x'];
  const refused = ['>=22', '^18.0.0', '>=21 <23', '~20.18', '>=20.20.0', '<20', '>20', '18.x', '^22.12.0', '>=22.22.3'];
  for (const r of accepted) assert.ok(admitsNode(r, '20.19.0'), `« ${r} » devrait accepter 20.19.0`);
  for (const r of refused) assert.ok(!admitsNode(r, '20.19.0'), `« ${r} » devrait refuser 20.19.0`);
  assert.ok(admitsNode('>=20.20.0', '20.20.2'));
});

test('verrou npm : paquets qui refusent Node.js 20', () => {
  const lock = { packages: {
    '': { engines: { node: '>=20' } },
    'node_modules/ok': { version: '1.0.0', engines: { node: '>=18' } },
    'node_modules/sans-engines': { version: '1.0.0' },
    'node_modules/light-my-request/node_modules/cookie': { version: '2.0.1', engines: { node: '>=22' } },
  } };
  assert.deepEqual(incompatiblePackages(lock, '20.19.0'), [{ name: 'cookie', version: '2.0.1', node: '>=22' }]);
});

test('données sensibles : clés en échec, adresses et chemins personnels en avertissement, motifs locaux', () => {
  // Valeurs construites par morceaux : verifier.mjs, qui relit aussi ce fichier, ne doit pas le signaler
  const fakeKey = `AI${'za'}${'x'.repeat(35)}`;
  const email = ['prenom.nom', 'entreprise.fr'].join('@');
  const home = ['', 'home', 'prenom', 'projet'].join('/');
  const users = ['C:', 'Users', 'prenom', 'Documents'].join('\\');
  const lines = [
    { path: 'a.mjs', line: 1, text: `const k = '${fakeKey}';` },
    { path: 'a.mjs', line: 2, text: `token gh${'p_'}${'A'.repeat(36)}` },
    { path: 'b.md', line: 3, text: 'Écrire à jean.dupont@example.com ou à noreply@anthropic.com' },
    { path: 'b.md', line: 4, text: `Contact : ${email}` },
    { path: 'c.json', line: 5, text: '"cwd": "C:\\\\Users\\\\jean.dupont\\\\projet", "home": "/home/<USER>/x", "h": "<HOME>/y"' },
    { path: 'c.json', line: 6, text: `"cwd": "${home}"` },
    { path: 'c.json', line: 7, text: users },
    { path: 'd.md', line: 8, text: 'Mission chez ClientSecret, lot 2' },
    { path: 'e.yml', line: 9, text: 'uses: actions/checkout@v7 ; npm install @google/gemini-cli ; git@github.com:x/y.git' },
  ];
  const local = parseLocalPatterns('# noms à ne jamais publier\nclientsecret\n/lot\\s+\\d+/\n\n');
  const found = scanLines(lines, local).map((f) => `${f.level} ${f.path}:${f.line} ${f.what}`);
  assert.ok(found.includes("ko a.mjs:1 clé d'API Google"));
  assert.ok(found.includes('ko a.mjs:2 jeton GitHub'));
  assert.ok(found.includes(`avert b.md:4 adresse électronique ${email}`));
  assert.ok(found.includes('avert c.json:6 chemin personnel (prenom)'));
  assert.ok(found.includes('avert c.json:7 chemin personnel (prenom)'));
  assert.ok(found.includes('ko d.md:8 motif local « clientsecret »'));
  assert.ok(found.includes('ko d.md:8 motif local « /lot\\s+\\d+/ »'));
  assert.ok(!found.some((f) => /b\.md:3|c\.json:5|e\.yml/.test(f)), found.join('\n'));
});

test('lignes ajoutées d\'un diff unifié, avec leur fichier et leur numéro', () => {
  const diff = [
    'diff --git a/x.md b/x.md', '--- a/x.md', '+++ b/x.md', '@@ -1,0 +2,2 @@', '+deux', '+trois', '@@ -9 +11 @@', '-ancien', '+onze',
    'diff --git a/supprime.md b/supprime.md', '--- a/supprime.md', '+++ /dev/null', '@@ -1 +0,0 @@', '-parti',
    'diff --git a/n.md b/n.md', 'new file mode 100644', '--- /dev/null', '+++ b/n.md', '@@ -0,0 +1 @@', '+++ commence par trois plus',
  ].join('\n');
  assert.deepEqual(addedLines(diff), [
    { path: 'x.md', line: 2, text: 'deux' }, { path: 'x.md', line: 3, text: 'trois' }, { path: 'x.md', line: 11, text: 'onze' },
    { path: 'n.md', line: 1, text: '++ commence par trois plus' },
  ]);
});

test('fichiers à ne jamais versionner', () => {
  for (const p of ['geminiboard.db', 'x/geminiboard.db-wal', 'base.sqlite', '.env', 'packages/server/.env.local', 'oauth_creds.json', 'motifs-interdits.txt']) {
    assert.ok(isForbiddenFile(p), p);
  }
  for (const p of ['README.md', '.env.example', 'docs/db.md', 'migrations/001_init.sql', 'environnement.json']) assert.ok(!isForbiddenFile(p), p);
});

test('README : décisions, feuille de route et questions lues', () => {
  const r = readReadme();
  assert.ok(r.status);
  assert.equal(r.decisions[0].id, 'D1');
  assert.ok(r.decisions.every((d, i) => d.id === `D${i + 1}` && /^\d{4}-\d{2}-\d{2}$/.test(d.date)), 'décisions numérotées sans trou');
  assert.deepEqual(r.steps.map((s) => s.n), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const q = Object.fromEntries(r.questions.map((x) => [x.id, x]));
  assert.equal(q.Q1.state, 'tranchée');
  assert.equal(q.Q1.decision, 'D9');
  assert.equal(q.Q3.state, 'ouverte');
  assert.ok(r.questions.every((x, i) => x.id === `Q${i + 1}`), 'questions numérotées sans trou');
});

test('migrations, branches et arguments', () => {
  const migrations = listMigrations();
  assert.ok(migrations.length >= 1 && migrations.every((m) => m.valid));
  assert.equal(nextMigrationNumber(migrations), String(migrations.length + 1).padStart(3, '0'));
  assert.equal(nextMigrationNumber([{ valid: true, number: 1 }, { valid: true, number: 2 }, { valid: false, number: NaN }]), '003');
  assert.ok(MIGRATION_NAME.test('002_catalogue.sql') && !MIGRATION_NAME.test('2_catalogue.sql') && !MIGRATION_NAME.test('002 catalogue.sql'));
  assert.equal(migrationChecksum('a\r\nb\n'), migrationChecksum('a\nb\n'), 'empreinte insensible aux fins de ligne, comme journal.mjs');
  assert.equal(stepOfBranch('etape-3-skill'), 3);
  assert.equal(stepOfBranch('etape-12'), 12);
  assert.equal(stepOfBranch('cadrage-catalogue'), null);
  assert.deepEqual(splitArgs(['--sans-tests --base main', '', '--json']), ['--sans-tests', '--base', 'main', '--json']);
});

test('etat.mjs : rapport Markdown et JSON, option inconnue refusée', () => {
  const run = (args) => spawnSync(process.execPath, [join(SCRIPTS, 'etat.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  const md = run(['--fichiers --migrations']); // en un seul bloc, comme {{args}} d'une commande /board:*
  assert.equal(md.status, 0, md.stderr);
  for (const title of ['# État du dépôt GeminiBoard', '## Branche', '## Feuille de route', '## Environnement', '## Fichiers qui diffèrent de la base', '## Migrations']) {
    assert.ok(md.stdout.includes(title), title);
  }
  const json = run(['--json']);
  assert.equal(json.status, 0, json.stderr);
  const state = JSON.parse(json.stdout);
  assert.equal(state.node, process.version);
  assert.ok(Array.isArray(state.files) && Array.isArray(state.migrations));
  assert.equal(state.nextMigration, nextMigrationNumber(listMigrations()));
  const bad = run(['--inconnue']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Usage/);
});

test('verifier.mjs : contrôles lancés sans les tests, bilan en JSON', () => {
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'verifier.mjs'), '--sans-tests', '--json'], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 300000,
    env: { ...process.env, GEMINIBOARD_MOTIFS: join(ROOT, 'motifs-absents-pour-les-tests.txt') },
  });
  assert.ok([0, 1].includes(r.status), r.stderr);
  const result = JSON.parse(r.stdout);
  const titles = result.checks.map((c) => c.title).join('\n');
  for (const re of [/^Migrations/m, /Composants portables/, /Node\.js 20\.19\.0/, /fichier interdit|Fichiers à ne jamais versionner/,
    /donnée sensible|Données sensibles|chemins personnels/, /Tests non lancés/]) {
    assert.match(titles, re);
  }
  const components = result.checks.find((c) => /Composants portables/.test(c.title));
  assert.equal(components.level, 'ok', components.detail.join('\n'));
  assert.equal(result.checks.find((c) => /Node\.js 20\.19\.0/.test(c.title)).level, 'ok');
  assert.equal(spawnSync(process.execPath, [join(SCRIPTS, 'verifier.mjs'), '--sans-test'], { cwd: ROOT, encoding: 'utf8' }).status, 2);
});
