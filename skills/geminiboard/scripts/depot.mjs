// depot.mjs : lecture de l'état du dépôt GeminiBoard (git, README, migrations, environnement), sans
// rien modifier. Module commun à etat.mjs et verifier.mjs.
// Node.js 20 ou plus, sans dépendance ; Linux, WSL2 et Windows natif (git est lancé sans shell).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Racine du dépôt qui contient ce script : skills/geminiboard/scripts/ → racine. */
export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Version de Gemini CLI sur laquelle les comportements décrits par la skill ont été relevés. */
export const GEMINI_CLI_REFERENCE = '0.65.0';

/** Nom de fichier accepté par le lanceur de migrations (packages/server/src/journal.mjs). */
export const MIGRATION_NAME = /^(\d{3})_[\w-]+\.sql$/;

/**
 * Arguments reçus d'une commande /board:* : Gemini CLI passe {{args}} en un seul argument échappé
 * (« --sans-tests --base main » arrive en un bloc). On les redécoupe aux espaces.
 */
export const splitArgs = (argv) => argv.flatMap((a) => a.split(/\s+/)).filter(Boolean);

/** git sans shell, chemins non échappés ; out sans les blancs de fin. */
export function git(args, { cwd = ROOT } = {}) {
  const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024,
  });
  return {
    ok: r.status === 0, code: r.status, missing: r.error?.code === 'ENOENT',
    out: (r.stdout ?? '').replace(/\s+$/, ''), err: (r.stderr ?? '').trim(),
  };
}

/** Référence de base : celle demandée, sinon origin/main, sinon main ; null si aucune n'existe. */
export function baseRef(wanted, { cwd = ROOT } = {}) {
  const candidates = wanted ? [wanted] : ['origin/main', 'main'];
  return candidates.find((ref) => git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd }).ok) ?? null;
}

/** Nom de la branche courante ; 'HEAD' si la tête est détachée ; null hors d'un dépôt git. */
export function currentBranch({ cwd = ROOT } = {}) {
  const r = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  return r.ok ? r.out : null;
}

/** Commits d'avance et de retard de HEAD sur la base. */
export function aheadBehind(base, { cwd = ROOT } = {}) {
  const r = git(['rev-list', '--left-right', '--count', `${base}...HEAD`], { cwd });
  if (!r.ok) return null;
  const [behind, ahead] = r.out.split(/\s+/).map(Number);
  return { ahead, behind };
}

/** Commits de la branche absents de la base, du plus récent au plus ancien. */
export function branchCommits(base, { cwd = ROOT, max = 20 } = {}) {
  const r = git(['log', '--format=%h %s', `-${max}`, `${base}..HEAD`], { cwd });
  return r.ok && r.out ? r.out.split('\n') : [];
}

export const STATUS_LABELS = {
  A: 'ajouté', M: 'modifié', D: 'supprimé', R: 'renommé', C: 'copié', T: 'type changé', U: 'en conflit', '?': 'non suivi',
};

/**
 * Fichiers de l'arbre de travail qui diffèrent de la base (commits de la branche, index et
 * modifications en cours), puis fichiers non suivis hors .gitignore.
 */
export function changedFiles(base, { cwd = ROOT } = {}) {
  const files = [];
  const ref = base ?? (git(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd }).ok ? 'HEAD' : null);
  if (ref) {
    const r = git(['diff', '--name-status', '--find-renames', ref], { cwd });
    if (r.ok && r.out) {
      for (const line of r.out.split('\n')) {
        const [status, ...paths] = line.split('\t');
        files.push({ status: status[0], path: paths.at(-1), ...(paths.length > 1 ? { from: paths[0] } : {}) });
      }
    }
  }
  const u = git(['ls-files', '--others', '--exclude-standard'], { cwd });
  if (u.ok && u.out) for (const path of u.out.split('\n')) files.push({ status: '?', path });
  return files;
}

/** Contenu d'un fichier dans une référence git, ou null s'il n'y existe pas. */
export function fileAt(ref, path, { cwd = ROOT } = {}) {
  const r = spawnSync('git', ['show', `${ref}:${path}`], { cwd, windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/** Empreinte d'une migration telle que la calcule journal.mjs (fins de ligne ignorées). */
export const migrationChecksum = (content) =>
  createHash('sha256').update(String(content).replace(/\r\n/g, '\n')).digest('hex');

/** Fichiers .sql de migrations/, triés, avec leur numéro (NaN si le nom n'est pas reconnu). */
export function listMigrations({ cwd = ROOT } = {}) {
  const dir = join(cwd, 'migrations');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.sql')).sort().map((name) => {
    const m = name.match(MIGRATION_NAME);
    return { name, number: m ? Number(m[1]) : NaN, valid: Boolean(m), checksum: migrationChecksum(readFileSync(join(dir, name), 'utf8')) };
  });
}

/** Prochain numéro de migration, sur trois chiffres. */
export function nextMigrationNumber(migrations) {
  const numbers = migrations.filter((m) => m.valid).map((m) => m.number);
  return String((numbers.length ? Math.max(...numbers) : 0) + 1).padStart(3, '0');
}

/** Section « ## n. Titre » du README, jusqu'à la suivante. */
function section(text, n) {
  const start = text.search(new RegExp(`^## ${n}\\. `, 'm'));
  if (start < 0) return '';
  const rest = text.slice(start + 1);
  const next = rest.search(/^## \d+\. /m);
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
}

/**
 * Ligne de statut, décisions (§2), feuille de route (§12) et questions (§13) du README.
 * Une question est « tranchée » (**Tranchée (Dn)**), « proposée » (se termine par « (proposé) ») ou « ouverte ».
 */
export function readReadme({ cwd = ROOT } = {}) {
  const file = join(cwd, 'README.md');
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const status = text.match(/^> \*\*Statut\*\* : (.+)$/m)?.[1] ?? null;
  const decisions = [...section(text, 2).matchAll(/^\| (D\d+) \| (.+?) \| (\d{4}-\d{2}-\d{2}) \|$/gm)]
    .map(([, id, label, date]) => ({ id, label, date }));
  const steps = [...section(text, 12).matchAll(/^\| (\d+)\. (.+?) \| (.+?) \| (.+?) \|$/gm)]
    .map(([, n, title, deliverable, ratification]) => ({ n: Number(n), title, deliverable, ratification }));
  const questions = [...section(text, 13).matchAll(/^\| (Q\d+) \| (.+?) \| (.+) \|$/gm)].map(([, id, subject, answer]) => {
    const decided = answer.match(/\*\*Tranchée \((D\d+)\)\*\*/);
    const state = decided ? 'tranchée' : /\(proposée?\)\s*$/.test(answer) ? 'proposée' : 'ouverte';
    return { id, subject, answer, state, ...(decided ? { decision: decided[1] } : {}) };
  });
  return { status, decisions, steps, questions };
}

/** Étape de la feuille de route d'après le nom de branche (etape-<n>-<objet>), ou null. */
export const stepOfBranch = (branch) => {
  const m = String(branch ?? '').match(/^etape-(\d+)(?:-|$)/);
  return m ? Number(m[1]) : null;
};

/** Dossiers de corpus du spike (fixtures/spike-<date>). */
export function corpusDirs({ cwd = ROOT } = {}) {
  const dir = join(cwd, 'fixtures');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((d) => d.startsWith('spike-') && statSync(join(dir, d)).isDirectory()).sort();
}

/** better-sqlite3 se charge-t-il avec ce Node.js ? (module natif : npm rebuild après un changement de version). */
export function sqliteStatus({ cwd = ROOT } = {}) {
  try {
    const require = createRequire(join(cwd, 'packages', 'server', 'package.json'));
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    const sqlite = db.prepare('SELECT sqlite_version() AS v').get().v;
    db.close();
    let version = null;
    try { version = require('better-sqlite3/package.json').version; } catch { /* version inconnue */ }
    return { ok: true, version, sqlite };
  } catch (e) {
    // Le message d'erreur contient des chemins locaux : seule la raison est rendue.
    const reason = e.code === 'MODULE_NOT_FOUND' ? 'absent'
      : /NODE_MODULE_VERSION|compiled against a different Node\.js version/.test(e.message) ? 'abi' : 'erreur';
    return { ok: false, reason };
  }
}

/** Version de Gemini CLI installée, trouvée comme le fait le board (GEMINI_CLI_ENTRY, puis npm root -g). */
export async function geminiCliVersion({ cwd = ROOT } = {}) {
  try {
    const { resolveGeminiEntry } = await import(pathToFileURL(join(cwd, 'packages', 'server', 'src', 'run-gemini.mjs')).href);
    const entry = resolveGeminiEntry();
    if (!entry) return { found: false };
    let dir = dirname(entry); // <paquet>/bundle/gemini.js → <paquet>/package.json
    for (let i = 0; i < 3 && !existsSync(join(dir, 'package.json')); i++) dir = dirname(dir);
    const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? null;
    return { found: true, version };
  } catch {
    return { found: false };
  }
}

/** Date et heure locales, en français. */
export const nowFr = () => new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' }).format(new Date());
