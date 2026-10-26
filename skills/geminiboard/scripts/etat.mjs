#!/usr/bin/env node
// etat.mjs : état du dépôt GeminiBoard, en lecture seule. Branche et écart avec la base, fichiers
// modifiés, étape de la feuille de route, décisions et questions du README, migrations, corpus du
// spike, Node.js, better-sqlite3 et Gemini CLI. Ne lance ni Gemini CLI ni les tests.
// Usage, depuis la racine du dépôt :
//   node skills/geminiboard/scripts/etat.mjs [--fichiers] [--migrations] [--base <ref>] [--json]
// Code de sortie : 0, ou 2 pour une option inconnue.
import { parseArgs } from 'node:util';
import {
  GEMINI_CLI_REFERENCE, STATUS_LABELS, aheadBehind, baseRef, branchCommits, changedFiles, corpusDirs,
  currentBranch, fileAt, geminiCliVersion, listMigrations, migrationChecksum, nextMigrationNumber, nowFr,
  readReadme, splitArgs, sqliteStatus, stepOfBranch,
} from './depot.mjs';

const USAGE = 'Usage : node skills/geminiboard/scripts/etat.mjs [--fichiers] [--migrations] [--base <ref>] [--json]';
let opt;
try {
  ({ values: opt } = parseArgs({
    args: splitArgs(process.argv.slice(2)),
    options: {
      fichiers: { type: 'boolean', default: false },
      migrations: { type: 'boolean', default: false },
      base: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  }));
} catch (e) {
  console.error(`${e.message}\n${USAGE}`);
  process.exit(2);
}

// --- Relevé -----------------------------------------------------------------------------------
const branch = currentBranch();
const base = baseRef(opt.base);
const files = changedFiles(base);
const readme = readReadme();
const migrations = listMigrations().map((m) => {
  if (!base) return { ...m, inBase: null };
  const before = fileAt(base, `migrations/${m.name}`);
  return { ...m, inBase: before !== null, sameAsBase: before === null ? null : migrationChecksum(before.toString('utf8')) === m.checksum };
});
const step = stepOfBranch(branch);
const state = {
  date: nowFr(),
  branch,
  base,
  aheadBehind: base ? aheadBehind(base) : null,
  commits: base ? branchCommits(base) : [],
  files,
  readme: readme && {
    status: readme.status,
    lastDecision: readme.decisions.at(-1) ?? null,
    decisionCount: readme.decisions.length,
    step: step === null ? null : readme.steps.find((s) => s.n === step) ?? null,
    steps: readme.steps,
    proposed: readme.questions.filter((q) => q.state === 'proposée'),
    open: readme.questions.filter((q) => q.state === 'ouverte'),
  },
  migrations,
  nextMigration: nextMigrationNumber(migrations),
  corpus: corpusDirs(),
  node: process.version,
  platform: process.platform,
  sqlite: sqliteStatus(),
  gemini: await geminiCliVersion(),
};

if (opt.json) {
  console.log(JSON.stringify(state, null, 2));
  process.exit(0);
}

// --- Rendu Markdown -----------------------------------------------------------------------------
const out = [];
const line = (s = '') => out.push(s);
const count = (n, one, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;
const ids = (list) => list.map((q) => q.id).join(', ');

line(`# État du dépôt GeminiBoard (${state.date})`);
line();
line('## Branche');
if (!branch) line('- Pas de dépôt git ici : lancer le script depuis un clone de geminiboard-cadrage.');
else {
  const ab = state.aheadBehind;
  line(`- Branche : \`${branch}\`${branch === 'main' ? ' : créer une branche avant toute modification (etape-<n>-<objet>)' : ''}`);
  line(base
    ? `- Base \`${base}\` : ${count(ab?.ahead ?? 0, "commit d'avance", "commits d'avance")}, ${count(ab?.behind ?? 0, 'de retard', 'de retard')}${ab?.behind ? ' (intégrer la base avant la PR)' : ''}`
    : '- Base introuvable (ni origin/main ni main) : `git fetch origin main`, ou --base <ref>');
  for (const c of state.commits) line(`  - ${c}`);
  const plurals = { A: 'ajoutés', M: 'modifiés', D: 'supprimés', R: 'renommés', C: 'copiés', T: 'types changés', U: 'en conflit', '?': 'non suivis' };
  const byStatus = {};
  for (const f of files) byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
  const detail = Object.entries(byStatus).map(([s, n]) => `${n} ${(n > 1 ? plurals[s] : STATUS_LABELS[s]) ?? s}`).join(', ');
  line(`- Fichiers qui diffèrent de la base : ${files.length}${files.length ? ` (${detail})` : ''}`);
}
line();

line('## Feuille de route');
if (!readme) line('- README.md introuvable.');
else {
  const r = state.readme;
  if (r.status) line(`- Statut du README : ${r.status}`);
  if (r.step) line(`- Étape de la branche : ${r.step.n}. ${r.step.title} · livrable : ${r.step.deliverable} · ratification : ${r.step.ratification}`);
  else if (step !== null) line(`- Étape ${step} : absente de la feuille de route du README (§12)`);
  else line(`- Étapes (§12) : ${r.steps.map((s) => `${s.n}. ${s.title}`).join(' · ')}`);
  if (r.lastDecision) line(`- Décisions : D1 à ${r.lastDecision.id} (dernière le ${r.lastDecision.date})`);
  if (r.proposed.length) {
    line(`- Propositions en attente de ratification : ${ids(r.proposed)}. Si la PR qui les porte est fusionnée, les consigner en décisions (D6) avant toute autre chose.`);
  } else line('- Propositions en attente de ratification : aucune');
  if (r.open.length) line(`- Questions ouvertes : ${r.open.map((q) => `${q.id} (${q.subject})`).join(' ; ')}`);
}
line(state.corpus.length
  ? `- Corpus réel du spike : ${state.corpus.map((d) => `\`fixtures/${d}\``).join(', ')}`
  : "- Corpus réel du spike : aucun dossier `fixtures/spike-*` ; l'étape 1 reste à clore (spike lancé sur le poste avec un vrai compte)");
const applied = migrations.filter((m) => m.valid).map((m) => `\`${m.name}\``).join(', ') || 'aucune';
line(`- Migrations : ${applied} · prochaine : \`${state.nextMigration}_<objet>.sql\``);
line();

line('## Environnement');
const major = Number(process.version.slice(1).split('.')[0]);
line(`- Node.js ${process.version}${major === 20 ? '' : major > 20
  ? ' : le dépôt vise Node.js 20 (D10) ; les tests de référence tournent sous Node.js 20'
  : ' : trop ancien, Node.js 20 requis'} · ${process.platform}`);
const sq = state.sqlite;
line(sq.ok ? `- better-sqlite3 ${sq.version ?? ''} chargé (SQLite ${sq.sqlite})`
  : sq.reason === 'absent' ? '- better-sqlite3 absent : lancer `npm install` à la racine'
    : sq.reason === 'abi' ? '- better-sqlite3 compilé pour une autre version de Node.js : lancer `npm rebuild better-sqlite3`'
      : '- better-sqlite3 ne se charge pas : relancer `npm install`');
const g = state.gemini;
line(!g.found ? '- Gemini CLI introuvable (`npm install -g @google/gemini-cli`, ou GEMINI_CLI_ENTRY)'
  : `- Gemini CLI ${g.version}${g.version === GEMINI_CLI_REFERENCE ? ''
    : ` : comportements relevés sur la ${GEMINI_CLI_REFERENCE} ; à revérifier (references/gemini-cli.md)`}`);

if (opt.fichiers) {
  line();
  line('## Fichiers qui diffèrent de la base');
  if (!files.length) line('- aucun');
  for (const f of files) line(`- ${STATUS_LABELS[f.status] ?? f.status} : \`${f.path}\`${f.from ? ` (depuis \`${f.from}\`)` : ''}`);
}

if (opt.migrations) {
  line();
  line('## Migrations');
  for (const m of migrations) {
    const where = m.inBase === null ? 'base inconnue' : m.inBase
      ? (m.sameAsBase ? 'présente dans la base, inchangée' : 'présente dans la base et MODIFIÉE : interdit, restaurer le fichier')
      : 'nouvelle sur cette branche';
    line(`- \`${m.name}\` · sha256 ${m.checksum.slice(0, 12)} · ${m.valid ? where : 'nom non reconnu par journal.mjs (NNN_nom.sql) : ignorée au chargement'}`);
  }
  line(`- Prochaine migration : \`migrations/${state.nextMigration}_<objet>.sql\``);
  line('- Règles : une migration présente sur main ne se modifie plus ; STRICT, json_valid(), horodatages ISO 8601 UTC ; projecteur et vues à mettre à jour (references/invariants.md).');
}

console.log(out.join('\n'));
