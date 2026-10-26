#!/usr/bin/env node
// verifier.mjs : contrôles du dépôt GeminiBoard avant une PR. Ne modifie rien.
//   1. espaces en fin de ligne et marqueurs de conflit (git diff --check)
//   2. migrations présentes sur la base inchangées, noms reconnus, numérotation continue
//   3. projecteur modifié sans changement de PROJECTOR_VERSION (avertissement)
//   4. composants portables (tools/check-components.mjs)
//   5. bibliothèques compatibles avec Node.js 20 (champ engines de package-lock.json)
//   6. fichiers interdits : base SQLite, .env, identifiants de Gemini CLI
//   7. données sensibles dans les lignes ajoutées : clés et jetons (échec) ; adresses et chemins
//      personnels (avertissement) ; motifs locaux, comme les noms de clients (échec)
//   8. suite de tests (node tools/run-tests.mjs), sauf --sans-tests
// Usage, depuis la racine du dépôt :
//   node skills/geminiboard/scripts/verifier.mjs [--sans-tests] [--base <ref>] [--node <version>] [--json]
// Motifs locaux : un motif par ligne (texte, ou /expression/), dans le fichier désigné par la variable
// GEMINIBOARD_MOTIFS, à défaut ~/.geminiboard/motifs-interdits.txt. Ce fichier ne va jamais dans le dépôt.
// Code de sortie : 0 sans échec (avertissements possibles), 1 en cas d'échec, 2 pour une option inconnue.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  MIGRATION_NAME, ROOT, baseRef, changedFiles, fileAt, git, listMigrations, migrationChecksum, splitArgs,
} from './depot.mjs';

/** Version de Node.js 20 que toute bibliothèque doit accepter (D10) : plancher d'Angular 20 et 21. */
export const NODE_TARGET = '20.19.0';

// ---------------------------------------------------------------------------------------------
// Compatibilité Node.js : évaluation d'un champ engines.node (sous-ensemble de semver suffisant
// pour les plages publiées sur npm : ||, plages à tiret, ^, ~, >=, >, <=, <, =, x et *).
// ---------------------------------------------------------------------------------------------
const parseVersion = (v) => {
  const parts = String(v).replace(/^v/, '').split('-')[0].split('.');
  const nums = [];
  for (const p of parts.slice(0, 3)) {
    if (p === '' || /^[xX*]$/.test(p)) break;
    if (!/^\d+$/.test(p)) return null;
    nums.push(Number(p));
  }
  return nums; // [] : n'importe quelle version ; [20] : 20.x ; [20, 1] : 20.1.x
};
const cmp = (a, b) => {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
};
const bump = (nums) => { // borne haute exclusive d'une version partielle : 20 → 21.0.0 ; 20.1 → 20.2.0
  const n = [...nums];
  n[n.length - 1] += 1;
  return [...n, 0, 0].slice(0, 3);
};
const full = (nums) => [...nums, 0, 0, 0].slice(0, 3);

/** Le champ engines.node `range` accepte-t-il la version `version` ? */
export function admitsNode(range, version = NODE_TARGET) {
  const v = full(parseVersion(version) ?? []);
  const text = String(range ?? '').trim();
  if (text === '') return true;
  return text.split('||').some((alt) => {
    let a = alt.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1');
    const hyphen = a.match(/^(\S+)\s+-\s+(\S+)$/);
    if (hyphen) a = `>=${hyphen[1]} <=${hyphen[2]}`;
    return a.split(/\s+/).filter(Boolean).every((comp) => {
      const m = comp.match(/^(>=|<=|>|<|=|\^|~)?(.*)$/);
      const op = m[1] ?? '';
      const nums = parseVersion(m[2]);
      if (nums === null) return false;
      if (nums.length === 0) return op === '' || op === '>=' || op === '=' || op === '^' || op === '~' ? true : op !== '<';
      const lo = full(nums);
      switch (op) {
        case '>=': return cmp(v, lo) >= 0;
        case '>': return nums.length < 3 ? cmp(v, bump(nums)) >= 0 : cmp(v, lo) > 0;
        case '<': return cmp(v, lo) < 0;
        case '<=': return nums.length < 3 ? cmp(v, bump(nums)) < 0 : cmp(v, lo) <= 0;
        case '^': {
          const i = nums.findIndex((x, k) => x !== 0 || k === nums.length - 1);
          return cmp(v, lo) >= 0 && cmp(v, bump(nums.slice(0, i + 1))) < 0;
        }
        case '~': return cmp(v, lo) >= 0 && cmp(v, bump(nums.length > 1 ? nums.slice(0, 2) : nums)) < 0;
        default: return nums.length < 3 ? cmp(v, lo) >= 0 && cmp(v, bump(nums)) < 0 : cmp(v, lo) === 0;
      }
    });
  });
}

/** Paquets du verrou dont engines.node refuse la version cible. */
export function incompatiblePackages(lock, version = NODE_TARGET) {
  return Object.entries(lock?.packages ?? {})
    .filter(([, p]) => p?.engines?.node !== undefined && !admitsNode(p.engines.node, version))
    .map(([path, p]) => ({ name: path.replace(/^.*node_modules\//, '') || '(racine)', version: p.version ?? null, node: p.engines.node }));
}

// ---------------------------------------------------------------------------------------------
// Données sensibles
// ---------------------------------------------------------------------------------------------
// Motifs construits par morceaux : ce fichier ne doit pas se signaler lui-même.
const SECRET_PATTERNS = [
  ['clé d\'API Google', new RegExp(`AI${'za'}[0-9A-Za-z_-]{35}`)],
  ['jeton GitHub', new RegExp(`(?:gh[pousr]${'_'}[A-Za-z0-9]{36,}|github${'_pat_'}[A-Za-z0-9_]{22,})`)],
  ['clé d\'API Anthropic', new RegExp(`sk-${'ant'}-[A-Za-z0-9_-]{20,}`)],
  ['clé AWS', new RegExp(`AK${'IA'}[0-9A-Z]{16}`)],
  ['jeton Slack', new RegExp(`xox${'[baprs]'}-[A-Za-z0-9-]{10,}`)],
  ['clé privée', new RegExp(`-----BEGIN [A-Z ]*PRIVATE ${'KEY'}-----`)],
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const EMAIL_ALLOWED = /@(?:(?:[\w-]+\.)*example\.(?:com|org|net)|users\.noreply\.github\.com|anthropic\.com)$|^git@github\.com$/i;
// Dossier personnel suivi d'un nom réel : /home/<nom>/, /Users/<nom>/, C:\Users\<nom>\ (toutes formes)
const PERSONAL_PATH = /(?:\/home\/|\/Users\/|[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/))([\w.~-]+)/g;
// Noms fictifs ou génériques des exemples et des tests (README, §11) ; un vrai nom reste signalé
const PATH_ALLOWED = /^(?:jean\.dupont|JEANDU~1|runner|runneradmin|Public|Default|USERNAME|user|nom|autre|exemple)$/i;

/** Lit les motifs locaux : texte (insensible à la casse) ou /expression/flags ; # pour commenter. */
export function parseLocalPatterns(text) {
  return String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => {
    const re = l.match(/^\/(.+)\/([a-z]*)$/);
    if (re) return { label: l, re: new RegExp(re[1], re[2].includes('i') ? re[2] : `${re[2]}i`) };
    return { label: l, re: new RegExp(l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') };
  });
}

/**
 * Cherche les données sensibles dans des lignes { path, line, text }.
 * Rend des constats { level: 'ko' | 'avert', path, line, what }.
 */
export function scanLines(lines, localPatterns = []) {
  const found = [];
  for (const { path, line, text } of lines) {
    for (const [what, re] of SECRET_PATTERNS) if (re.test(text)) found.push({ level: 'ko', path, line, what });
    for (const { label, re } of localPatterns) if (re.test(text)) found.push({ level: 'ko', path, line, what: `motif local « ${label} »` });
    for (const [email] of text.matchAll(EMAIL)) {
      if (!EMAIL_ALLOWED.test(email)) found.push({ level: 'avert', path, line, what: `adresse électronique ${email}` });
    }
    for (const [, name] of text.matchAll(PERSONAL_PATH)) {
      if (!PATH_ALLOWED.test(name)) found.push({ level: 'avert', path, line, what: `chemin personnel (${name})` });
    }
  }
  return found;
}

/**
 * Lignes ajoutées d'un diff unifié (git diff -U0), avec leur fichier et leur numéro. L'en-tête d'un
 * fichier va de « diff --git » au premier « @@ » : une ligne ajoutée qui commence par « ++ » n'en est pas un.
 */
export function addedLines(diff) {
  const lines = [];
  let path = null;
  let header = false;
  let n = 0;
  for (const l of String(diff).split('\n')) {
    if (l.startsWith('diff --git ')) { header = true; path = null; continue; }
    if (header && l.startsWith('+++ ')) { path = l === '+++ /dev/null' ? null : l.replace(/^\+\+\+ (?:b\/)?/, ''); continue; }
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) { header = false; n = Number(h[1]); continue; }
    if (!header && path && l.startsWith('+')) lines.push({ path, line: n++, text: l.slice(1) });
  }
  return lines;
}

// Fichiers à ne jamais versionner : la base du board, des secrets, les identifiants de Gemini CLI
const FORBIDDEN = /(?:^|\/)(?:[^/]+\.(?:db|db-wal|db-shm|sqlite|sqlite3)|\.env(?:\.[^/]*)?|oauth_creds\.json|google_accounts\.json|motifs-interdits\.txt|secret)$/;
export const isForbiddenFile = (path) => FORBIDDEN.test(path) && !/\.env\.exemple$|\.env\.example$/.test(path);

// ---------------------------------------------------------------------------------------------
// Contrôles
// ---------------------------------------------------------------------------------------------
function run(opt) {
  const checks = [];
  const add = (level, title, detail = []) => checks.push({ level, title, detail });
  const base = baseRef(opt.base);
  const relevant = (p) => !/(^|\/)package-lock\.json$/.test(p);

  if (!base) add('avert', 'Base introuvable (ni origin/main ni main) : diff et migrations contrôlés sans référence', ['git fetch origin main, ou --base <ref>']);

  // 1. Espaces et marqueurs de conflit
  if (base) {
    const r = git(['diff', '--check', base]);
    if (r.ok) add('ok', `Espaces et marqueurs de conflit (git diff --check ${base})`);
    else add('ko', 'Espaces en fin de ligne ou marqueurs de conflit (git diff --check)', r.out.split('\n').slice(0, 10));
  }

  // 2. Migrations
  const migrations = listMigrations();
  const problems = [];
  for (const m of migrations.filter((x) => !x.valid)) problems.push(`${m.name} : nom non reconnu par journal.mjs (NNN_nom.sql), la migration serait ignorée`);
  const numbers = migrations.filter((x) => x.valid).map((x) => x.number);
  numbers.forEach((num, i) => { if (num !== i + 1) problems.push(`numérotation discontinue : ${String(num).padStart(3, '0')} au lieu de ${String(i + 1).padStart(3, '0')}`); });
  if (base) {
    const before = git(['ls-tree', '--name-only', `${base}:migrations`]);
    for (const name of before.ok && before.out ? before.out.split('\n') : []) {
      if (!MIGRATION_NAME.test(name)) continue;
      const current = migrations.find((m) => m.name === name);
      if (!current) problems.push(`${name} : présente sur ${base}, supprimée ou renommée ici`);
      else if (migrationChecksum(fileAt(base, `migrations/${name}`).toString('utf8')) !== current.checksum) {
        problems.push(`${name} : modifiée depuis ${base} ; une migration appliquée ne se modifie plus, créer une nouvelle migration`);
      }
    }
  }
  if (problems.length) add('ko', 'Migrations', problems);
  else add('ok', `Migrations : ${migrations.map((m) => m.name).join(', ') || 'aucune'}${base ? ` ; migrations de la base ${base} inchangées` : ''}`);

  // 3. Version du projecteur
  if (base) {
    const file = 'packages/server/src/projector.mjs';
    const before = fileAt(base, file)?.toString('utf8');
    const now = existsSync(join(ROOT, file)) ? readFileSync(join(ROOT, file), 'utf8') : null;
    const version = (s) => s?.match(/export const PROJECTOR_VERSION = (\d+)/)?.[1] ?? null;
    if (before && now && before.replace(/\r\n/g, '\n') !== now.replace(/\r\n/g, '\n') && version(before) === version(now)) {
      add('avert', `Projecteur modifié, PROJECTOR_VERSION toujours à ${version(now)} : l'incrémenter si les projections changent (reconstruction, O2)`);
    }
  }

  // 4. Composants portables
  const comp = spawnSync(process.execPath, [join(ROOT, 'tools', 'check-components.mjs')], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  if (comp.status === 0) add('ok', `Composants portables (${comp.stdout.trim().split('\n').at(-1)})`);
  else {
    add('ko', 'Composants portables (tools/check-components.mjs)', `${comp.stdout ?? ''}${comp.stderr ?? ''}`.split('\n')
      .filter((l) => /^KO|^\s+-|Error/.test(l)).map((l) => l.trim().replace(/^- /, '').replace(/^KO\s+/, '')).slice(0, 20));
  }

  // 5. Node.js 20
  const lockFile = join(ROOT, 'package-lock.json');
  if (existsSync(lockFile)) {
    const bad = incompatiblePackages(JSON.parse(readFileSync(lockFile, 'utf8')), opt.node);
    if (bad.length) add('ko', `Bibliothèques qui refusent Node.js ${opt.node} (D10)`, bad.map((b) => `${b.name}${b.version ? ` ${b.version}` : ''} : engines.node = « ${b.node} »`));
    else add('ok', `Bibliothèques compatibles avec Node.js ${opt.node} (engines de package-lock.json)`);
  }

  // 6 et 7. Fichiers interdits, données sensibles
  const files = changedFiles(base);
  const tracked = git(['ls-files']).out.split('\n').filter(Boolean);
  const forbidden = [...new Set([...tracked, ...files.filter((f) => f.status !== 'D').map((f) => f.path)])].filter(isForbiddenFile);
  if (forbidden.length) add('ko', 'Fichiers à ne jamais versionner (base, secrets, identifiants)', forbidden);
  else add('ok', 'Aucun fichier interdit (base SQLite, .env, identifiants)');

  let lines = [];
  if (base) lines = addedLines(git(['diff', '-U0', '--no-color', '--no-ext-diff', base]).out).filter((l) => relevant(l.path));
  else for (const path of tracked.filter(relevant)) lines.push(...fileLines(path));
  for (const f of files.filter((x) => x.status === '?' && relevant(x.path))) lines.push(...fileLines(f.path));
  const patternsFile = process.env.GEMINIBOARD_MOTIFS || join(homedir(), '.geminiboard', 'motifs-interdits.txt');
  const local = existsSync(patternsFile) ? parseLocalPatterns(readFileSync(patternsFile, 'utf8')) : [];
  const found = scanLines(lines, local);
  const where = (f) => `${f.path}:${f.line} : ${f.what}`;
  const scope = `${lines.length} lignes ${base ? `ajoutées depuis ${base}` : 'suivies'}${local.length ? `, ${local.length} motifs locaux` : ', sans motifs locaux (GEMINIBOARD_MOTIFS ou ~/.geminiboard/motifs-interdits.txt)'}`;
  const ko = found.filter((f) => f.level === 'ko');
  const avert = found.filter((f) => f.level === 'avert');
  if (ko.length) add('ko', `Données sensibles (${scope})`, ko.map(where));
  if (avert.length) add('avert', 'Adresses ou chemins personnels à relire (dépôt public)', avert.map(where).slice(0, 30));
  if (!found.length) add('ok', `Aucune donnée sensible repérée (${scope})`);

  // 8. Tests
  if (!opt['sans-tests']) {
    const t = spawnSync(process.execPath, [join(ROOT, 'tools', 'run-tests.mjs'), '--test-reporter=tap'], {
      cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: 15 * 60 * 1000,
    });
    const out = `${t.stdout ?? ''}`;
    const total = (k) => Number(out.match(new RegExp(`^# ${k} (\\d+)$`, 'm'))?.[1] ?? NaN);
    const n = (k, one, many) => `${total(k)} ${total(k) > 1 ? many : one}`;
    const summary = `${n('tests', 'test', 'tests')} : ${n('pass', 'réussi', 'réussis')}, ${total('fail')} en échec, ${n('skipped', 'sauté', 'sautés')}`;
    const failed = [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1]);
    if (t.status === 0) add('ok', `Tests sous Node.js ${process.version} (${summary})`);
    else add('ko', `Tests sous Node.js ${process.version} (${Number.isNaN(total('tests')) ? `sortie ${t.status ?? t.signal}` : summary})`,
      failed.length ? failed.slice(0, 20) : `${t.stderr ?? ''}`.split('\n').slice(-10));
  } else add('avert', 'Tests non lancés (--sans-tests) : les lancer avant la PR');

  return { base, node: process.version, platform: process.platform, checks };
}

/** Lignes d'un fichier texte du dépôt (les binaires et les fichiers de plus de 2 Mo sont ignorés). */
function fileLines(path) {
  const file = join(ROOT, path);
  try {
    if (!statSync(file).isFile() || statSync(file).size > 2 * 1024 * 1024) return [];
    const buf = readFileSync(file);
    if (buf.includes(0)) return [];
    return buf.toString('utf8').split(/\r?\n/).map((text, i) => ({ path, line: i + 1, text }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  let opt;
  try {
    ({ values: opt } = parseArgs({
      args: splitArgs(process.argv.slice(2)),
      options: {
        'sans-tests': { type: 'boolean', default: false },
        base: { type: 'string' },
        node: { type: 'string', default: NODE_TARGET },
        json: { type: 'boolean', default: false },
      },
    }));
  } catch (e) {
    console.error(`${e.message}\nUsage : node skills/geminiboard/scripts/verifier.mjs [--sans-tests] [--base <ref>] [--node <version>] [--json]`);
    process.exit(2);
  }
  const result = run(opt);
  const failures = result.checks.filter((c) => c.level === 'ko').length;
  const warnings = result.checks.filter((c) => c.level === 'avert').length;
  if (opt.json) console.log(JSON.stringify(result, null, 2));
  else {
    const label = { ok: 'OK   ', ko: 'KO   ', avert: 'AVERT' };
    const out = [`Contrôles du dépôt GeminiBoard · base ${result.base ?? 'aucune'} · Node.js ${result.node} · ${result.platform}`, ''];
    for (const c of result.checks) {
      out.push(`${label[c.level]} ${c.title}`);
      for (const d of c.detail) out.push(`        - ${d}`);
    }
    out.push('', `Bilan : ${result.checks.length} contrôles, ${failures} en échec, ${warnings} avertissement${warnings > 1 ? 's' : ''}.`);
    console.log(out.join('\n'));
  }
  process.exit(failures ? 1 : 0);
}
