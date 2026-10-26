// Contrôle des composants portables (tools/check-components.mjs) : analyseurs TOML et YAML,
// injections, politiques, renvois, puis chaque règle sur un dépôt synthétique et sur ce dépôt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkComponents, citedPaths, extractInjections, parseFrontmatter, parseToml, prefixCovers,
} from '../check-components.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

test('TOML : chaînes, échappements, chaînes multilignes et littérales', () => {
  const { root, errors } = parseToml([
    'description = "Accents \\u00e9 et \\"guillemets\\"" # commentaire',
    "prompt = '''",
    "L'étape {{args}} : C:\\Users\\jean.dupont, sans échappement",
    "'''",
    'autre = """',
    'ligne 1 \\',
    '    suite\\tfin"""',
  ].join('\n'));
  assert.deepEqual(errors, []);
  assert.equal(root.description, 'Accents é et "guillemets"');
  assert.equal(root.prompt, "L'étape {{args}} : C:\\Users\\jean.dupont, sans échappement\n");
  assert.equal(root.autre, 'ligne 1 suite\tfin');
});

test('TOML : erreurs, avec leur ligne', () => {
  const cases = [
    ['prompt = "chemin C:\\Users\\<USER>"', /échappement \\U invalide/],
    ['prompt = "\\d"', /échappement invalide/],
    ['prompt = "non fermée', /non fermée/],
    ["prompt = '''sans fin", /non fermée/],
    ['a.b = "x"', /clé pointée/],
    ['a = { b = 1 }', /table en ligne/],
    ['a = "x"\na = "y"', /définie deux fois/],
    ['a = "x" b', /fin de ligne attendue/],
    ['a = ', /valeur attendue/],
  ];
  for (const [text, re] of cases) {
    const { errors } = parseToml(text);
    assert.ok(errors.some((e) => re.test(e.message)), `${text} : ${JSON.stringify(errors)}`);
  }
  assert.equal(parseToml('a = "x"\n\nb = "\\q"').errors[0].line, 3);
});

test('TOML : tables de règles, nombres, booléens, tableaux sur plusieurs lignes', () => {
  const { root, tables, errors } = parseToml([
    '# politique', '[[rule]]', 'toolName = "run_shell_command"', 'commandPrefix = [', '  "git status", # lecture', '  "git diff",', ']',
    'decision = "allow"', 'priority = 100', '', '[[rule]]', 'toolName = "web_fetch"', 'decision = "deny"', 'priority = 1_000',
    'actif = true',
  ].join('\n'));
  assert.deepEqual(errors, []);
  assert.deepEqual(root, {});
  assert.equal(tables.length, 2);
  assert.deepEqual(tables[0].values, { toolName: 'run_shell_command', commandPrefix: ['git status', 'git diff'], decision: 'allow', priority: 100 });
  assert.deepEqual(tables[1].values, { toolName: 'web_fetch', decision: 'deny', priority: 1000, actif: true });
  assert.ok(tables.every((t) => t.name === 'rule' && t.array));
});

test('frontmatter : scalaires, guillemets, listes, blocs, et ce qui est refusé', () => {
  const ok = parseFrontmatter([
    '---', 'name: relecteur', "description: L'agent relit, sans rien modifier", 'display_name: "Relecteur : GeminiBoard"',
    'tools:', '  - read_file', '  - glob', 'modes: [lecture, "revue"]', 'max_turns: 25', 'resume: >', '  Première ligne', '  seconde ligne',
    'mcp_servers:', '  docs:', '    command: node', '---', 'Corps.',
  ].join('\n'));
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.data.name, 'relecteur');
  assert.equal(ok.data.description, "L'agent relit, sans rien modifier");
  assert.equal(ok.data.display_name, 'Relecteur : GeminiBoard');
  assert.deepEqual(ok.data.tools, ['read_file', 'glob']);
  assert.deepEqual(ok.data.modes, ['lecture', 'revue']);
  assert.equal(ok.data.max_turns, 25);
  assert.equal(ok.data.resume, 'Première ligne seconde ligne');
  assert.deepEqual(ok.data.mcp_servers, { nonControle: true });
  assert.equal(ok.body, 'Corps.');

  assert.match(parseFrontmatter('Pas de frontmatter').errors[0].message, /absent/);
  const colon = parseFrontmatter('---\nname: x\ndescription: Revue : relecture du code\n---\n');
  assert.match(colon.errors[0].message, /« : » dans une valeur sans guillemets/);
  assert.match(parseFrontmatter('---\nname: x\n\tdescription: y\n---\n').errors[0].message, /tabulation/);
  assert.match(parseFrontmatter('---\nname: x\nname: y\n---\n').errors[0].message, /répétée/);
});

test('injections !{…} et @{…} : accolades équilibrées, comme Gemini CLI', () => {
  assert.deepEqual(extractInjections('a !{node x.mjs {{args}}} b !{ git status } c', '!{'), ['node x.mjs {{args}}', 'git status']);
  assert.deepEqual(extractInjections('@{README.md} et @{docs}', '@{'), ['README.md', 'docs']);
  assert.deepEqual(extractInjections('rien à injecter {{args}}', '!{'), []);
  assert.throws(() => extractInjections('a !{node x.mjs {{args}} b', '!{'), /sans accolade fermante/);
});

test('politique : commandPrefix suivi d\'un blanc ou de rien, jamais une commande enchaînée', () => {
  const p = 'node skills/geminiboard/scripts/etat.mjs';
  assert.ok(prefixCovers(p, p));
  assert.ok(prefixCovers(p, `${p} --fichiers`));
  assert.ok(prefixCovers(p, `${p} `));
  assert.ok(!prefixCovers(p, `${p}x`));
  assert.ok(!prefixCovers(p, 'node skills/geminiboard/scripts/verifier.mjs'));
  for (const chained of [`${p}; echo x`, `${p} && echo x`, `${p} | more`, `${p} > sortie.txt`, `${p} $(whoami)`, `${p} \`id\``]) {
    assert.ok(!prefixCovers(p, chained), chained);
  }
});

test('renvois : chemins entre accents graves, et chemins prévus marqués « (à venir) »', () => {
  const cited = citedPaths('Voir `references/a.md` et `node x`.\nPlus tard : `packages/ui` (à venir).');
  assert.deepEqual(cited, [
    { path: 'references/a.md', line: 1, planned: false },
    { path: 'packages/ui', line: 2, planned: true },
  ]);
});

// Dépôt synthétique conforme, puis une règle enfreinte à la fois
function fixtureRepo(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'geminiboard-composants-'));
  const files = {
    'gemini-extension.json': JSON.stringify({ name: 'demo', version: '1.0.0', description: 'Démo', contextFileName: 'AGENTS.md' }),
    'AGENTS.md': '# Démo\n\nVoir `skills/demo/SKILL.md`.\n',
    'skills/demo/SKILL.md': '---\nname: demo\ndescription: Skill de démonstration, pour les tests\n---\n\n# Démo\n\n'
      + 'Lire `references/guide.md`, lancer `scripts/outil.mjs`, politique `assets/politique.toml`.\n'
      + 'Plus tard, `packages/ui` (à venir).\n',
    'skills/demo/references/guide.md': '# Guide\n\nCode dans `skills/demo/scripts/outil.mjs`.\n',
    'skills/demo/scripts/outil.mjs': 'console.log("outil");\n',
    'skills/demo/assets/politique.toml': '[[rule]]\ntoolName = "run_shell_command"\ncommandPrefix = "node skills/demo/scripts/outil.mjs"\ndecision = "allow"\npriority = 100\n',
    'commands/ns/cmd.toml': "description = \"Commande de démonstration\"\nprompt = '''\nSortie : !{node skills/demo/scripts/outil.mjs {{args}}}\nFichier : @{AGENTS.md}\n'''\n",
    'agents/demo-agent.md': '---\nname: demo-agent\ndescription: Agent de démonstration\ntools:\n  - read_file\n  - mcp_docs_lire\nmax_turns: 5\n---\nTu relis.\n',
    ...overrides,
  };
  for (const [path, content] of Object.entries(files)) {
    if (content === null) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}
function errorsOf(overrides) {
  const dir = fixtureRepo(overrides);
  try {
    return checkComponents(dir).flatMap((r) => r.errors.map((e) => `${r.type} ${r.name} : ${e}`));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

test('dépôt synthétique conforme : aucune erreur', () => {
  assert.deepEqual(errorsOf({}), []);
});

test('chaque règle enfreinte est signalée', () => {
  const skill = (fm, body = 'Lire `references/guide.md`, `scripts/outil.mjs`, `assets/politique.toml`.\n') => `---\n${fm}\n---\n${body}`;
  const agent = (fm) => `---\n${fm}\n---\nTu relis.\n`;
  const cases = [
    [{ 'gemini-extension.json': JSON.stringify({ name: 'Demo_X', version: '1.0', contextFileName: 'ABSENT.md' }) }, [/name : minuscules/, /version : numéro semver/, /ABSENT\.md absent/]],
    [{ 'skills/demo/SKILL.md': skill('name: demo\ndescription: Démo\nversion: 1.0.0') }, [/version en trop/]],
    [{ 'skills/demo/SKILL.md': skill('name: autre\ndescription: Démo') }, [/différent du dossier/]],
    [{ 'skills/demo/SKILL.md': skill('name: demo\ndescription: Démo <balise>') }, [/chevrons/]],
    [{ 'skills/demo/SKILL.md': skill('name: demo\ndescription: Revue : relecture') }, [/« : » dans une valeur/]],
    [{ 'skills/demo/SKILL.md': skill('name: demo\ndescription: Démo', 'Lire `references/guide.md` et `scripts/outil.mjs`.\n') }, [/assets\/politique\.toml` jamais cité/]],
    [{ 'skills/demo/references/guide.md': 'Voir `references/absent.md` et `tools/absent.mjs`.\n' }, [/references\/absent\.md` cité mais absent/, /tools\/absent\.mjs` cité mais absent/]],
    [{ 'skills/demo/scripts/outil.mjs': 'const = ;\n' }, [/erreur de syntaxe/]],
    [{ 'commands/ns/cmd.toml': 'prompt = "C:\\Users\\<USER>"\n' }, [/échappement \\U invalide/]],
    [{ 'commands/ns/cmd.toml': 'prompt = "x"\ndescription = "d"\nmodele = "y"\n' }, [/clés inconnues : modele/]],
    [{ 'commands/ns/cmd.toml': 'description = "d"\nprompt = "!{git status}"\n' }, [/aucune politique du dépôt ne l'autorise/]],
    [{ 'commands/ns/cmd.toml': 'description = "d"\nprompt = "!{node skills/demo/scripts/outil.mjs; rm x}"\n' }, [/aucune politique/]],
    [{ 'commands/ns/cmd.toml': 'description = "d"\nprompt = "!{node skills/demo/scripts/outil.mjs {{args}}"\n' }, [/sans accolade fermante/]],
    [{ 'commands/ns/cmd.toml': 'description = "d"\nprompt = "Voir {{arguments}} et {{ args }}"\n' }, [/\{\{arguments\}\} inconnue/, /\{\{args\}\} sans espaces/]],
    [{ 'commands/ns/cmd.toml': 'description = "d"\nprompt = "@{absent.md} @{tools/absent.mjs}"\n' }, [/@\{tools\/absent\.mjs\} : fichier absent/]],
    [{ 'commands/ns/cmd.toml': 'description = "d"\nprompt = ""\n' }, [/prompt absent ou vide/]],
    [{ 'agents/demo-agent.md': agent('name: demo-agent\ndescription: Démo\ncouleur: bleu') }, [/clés refusées par Gemini CLI : couleur/]],
    [{ 'agents/demo-agent.md': agent('name: demo-agent\ndescription: Démo\ntools:\n  - lire_fichier') }, [/outil inconnu de Gemini CLI 0\.65 : lire_fichier/]],
    [{ 'agents/demo-agent.md': agent('name: autre-agent\ndescription: Démo') }, [/différent du fichier/]],
    [{ 'agents/demo-agent.md': agent('name: demo-agent\ndescription: Démo\nmax_turns: 0\nkind: remote') }, [/max_turns : entier positif/, /kind : local seulement/]],
    [{ 'agents/demo-agent.md': 'Pas de frontmatter.\n' }, [/frontmatter absent/]],
  ];
  for (const [overrides, expected] of cases) {
    const errors = errorsOf(overrides);
    for (const re of expected) assert.ok(errors.some((e) => re.test(e)), `${re} attendu dans ${JSON.stringify(errors)}`);
  }
});

test('avertissements : description de commande trop longue ou absente', () => {
  const dir = fixtureRepo({ 'commands/ns/cmd.toml': `description = "${'x'.repeat(120)}"\nprompt = "texte"\n`, 'commands/ns/sans.toml': 'prompt = "texte"\n' });
  try {
    const warnings = checkComponents(dir).flatMap((r) => r.warnings);
    assert.ok(warnings.some((w) => /Gemini CLI la coupe à 100/.test(w)));
    assert.ok(warnings.some((w) => /description absente/.test(w)));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
});

test('composants du dépôt : conformes', () => {
  const results = checkComponents(ROOT);
  const errors = results.flatMap((r) => r.errors.map((e) => `${r.path} : ${e}`));
  assert.deepEqual(errors, []);
  const names = results.map((r) => `${r.type} ${r.name}`);
  for (const expected of ['extension geminiboard', 'skill geminiboard', 'sous-agent relecteur-board', 'commande /board:etape',
    'commande /board:verifier', 'commande /board:revue', 'commande /board:pr', 'commande /board:migration']) {
    assert.ok(names.includes(expected), `${expected} attendu parmi ${names.join(', ')}`);
  }
});
