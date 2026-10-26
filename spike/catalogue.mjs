#!/usr/bin/env node
// catalogue.mjs : spike S5. Vérifie, sur le vrai Gemini CLI et sans compte, le mécanisme d'activation
// du catalogue (README, §9.4) : une extension par projet, générée par le board, liée
// une fois, désactivée partout puis activée pour le seul dossier du projet.
// Isolé : GEMINI_CLI_HOME pointe vers un dossier temporaire, la configuration de l'utilisateur n'est pas touchée.
// Node.js 20 ou plus, sans dépendance. Usage : node spike/catalogue.mjs [--entry <gemini.js>] [--keep]
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { resolveGeminiEntry } from '../packages/server/src/run-gemini.mjs';

const { values: opt } = parseArgs({ options: { entry: { type: 'string' }, keep: { type: 'boolean', default: false } } });
const entry = opt.entry ? resolve(opt.entry) : resolveGeminiEntry();
if (!entry) {
  console.error('Gemini CLI introuvable : « npm install -g @google/gemini-cli », ou --entry <chemin de gemini.js>.');
  process.exit(2);
}

const NAME = 'geminiboard-projet-a';
const SKILL = 'revue-projet-a';
const base = mkdtempSync(join(tmpdir(), 'geminiboard-s5-'));
const home = join(base, 'home');
const projectA = join(base, 'projet-a');
const projectB = join(base, 'projet-b');
const projectC = join(home, 'projets', 'projet-c'); // sous le dossier personnel de Gemini CLI
const ext = join(base, 'extension');
for (const d of [home, projectA, projectB, projectC]) mkdirSync(d, { recursive: true });

// Extension du projet A, telle que le board la générerait : un composant de chaque type
const files = {
  'gemini-extension.json': JSON.stringify({
    name: NAME, version: '1.0.0', description: 'Composants activés par le board pour le projet A',
    contextFileName: 'CONTEXTE.md',
    mcpServers: { 'docs-projet': { command: 'node', args: ['${extensionPath}/mcp.mjs'] } },
    excludeTools: ['web_fetch'],
  }, null, 2),
  'CONTEXTE.md': '# Projet A\n\nInstructions du projet, injectées à chaque session.\n',
  'mcp.mjs': 'process.exit(0);\n',
  [`skills/${SKILL}/SKILL.md`]: `---\nname: ${SKILL}\ndescription: Revue de code du projet A.\n---\nRelis le code selon les règles du projet A.\n`,
  'agents/relecteur-a.md': '---\nname: relecteur-a\ndescription: Relit le code du projet A.\ntools:\n  - read_file\n---\nTu relis le code.\n',
  'commands/projet-a/plan.toml': 'description = "Plan du projet A"\nprompt = """Établis le plan de {{args}}."""\n',
  'policies/projet-a.toml': '[[rule]]\ntoolName = "web_fetch"\ndecision = "deny"\npriority = 100\n\n'
    + '[[rule]]\ntoolName = "run_shell_command"\ncommandPrefix = "git status"\ndecision = "allow"\npriority = 100\n',
};
for (const [path, content] of Object.entries(files)) {
  mkdirSync(join(ext, parse(path).dir), { recursive: true });
  writeFileSync(join(ext, path), content);
}

const env = { ...process.env, GEMINI_CLI_HOME: home, GEMINI_CLI_NO_RELAUNCH: 'true', NO_BROWSER: 'true' };
delete env.GEMINI_API_KEY; // aucune requête au modèle : seules les commandes de gestion sont lancées
function gemini(args, { cwd = projectA, input = '', trust = true } = {}) {
  const r = spawnSync(process.execPath, [entry, ...args], {
    cwd, input, encoding: 'utf8', timeout: 120000, windowsHide: true,
    env: trust ? { ...env, GEMINI_CLI_TRUST_WORKSPACE: 'true' } : env,
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const steps = [];
const step = (label, ok, detail = '') => { steps.push({ label, ok, detail }); };

const version = gemini(['--version']).out.trim();
const validate = gemini(['extensions', 'validate', ext]);
step('extension validée (gemini extensions validate)', validate.code === 0 && /validated/i.test(validate.out), validate.out.trim().split('\n').at(-1));
const link = gemini(['extensions', 'link', ext], { input: 'y\n' });
step('extension liée, après accord sur stdin (gemini extensions link)', link.code === 0 && /linked successfully/i.test(link.out), link.out.trim().split('\n').at(-1));
step('règle allow d\'une extension ignorée par Gemini CLI', /attempted to contribute an ALLOW rule/.test(link.out));

// Désactivée partout : une règle à la racine de chaque lecteur concerné ; puis activée pour le projet A
const roots = [...new Set([projectA, projectB, projectC].map((p) => parse(p).root))];
for (const root of roots) {
  const r = gemini(['extensions', 'disable', '--scope', 'workspace', NAME], { cwd: root, trust: false });
  step(`désactivée depuis la racine ${root}`, r.code === 0, r.out.trim().split('\n').at(-1));
}
const enable = gemini(['extensions', 'enable', '--scope', 'workspace', NAME], { cwd: projectA, trust: false });
step('activée pour le dossier du projet A', enable.code === 0, enable.out.trim().split('\n').at(-1));

// Ce que voit Gemini CLI depuis chaque dossier
const expected = { 'projet-a': true, 'projet-b': false, 'projet-c': false };
const seen = {};
for (const [label, dir] of [['projet-a', projectA], ['projet-b', projectB], ['projet-c', projectC]]) {
  const list = gemini(['extensions', 'list'], { cwd: dir });
  const enabled = /Enabled \(Workspace\):\s*true/.test(list.out);
  const skills = gemini(['skills', 'list'], { cwd: dir });
  const skill = new RegExp(`${SKILL} \\[Enabled\\]`).test(skills.out);
  seen[label] = { enabled, skill, mcp: /docs-projet/.test(list.out), excluded: /web_fetch/.test(list.out) };
  step(`${label} : extension ${expected[label] ? 'active' : 'inactive'}, skill ${expected[label] ? 'visible' : 'absent'}`,
    enabled === expected[label] && skill === expected[label], `extension ${enabled ? 'active' : 'inactive'}, skill ${skill ? 'visible' : 'absent'}`);
}
step('manifeste : serveur MCP et outil exclu listés', seen['projet-a'].mcp && seen['projet-a'].excluded);

const ok = steps.every((s) => s.ok);
const lines = [`Spike S5 · Gemini CLI ${version} · Node.js ${process.version} · ${process.platform}`, ''];
for (const s of steps) lines.push(`${s.ok ? 'OK' : 'KO'}  ${s.label}${s.detail ? ` (${s.detail})` : ''}`);
lines.push('', ok ? 'Mécanisme vérifié.' : 'Écart constaté : voir les lignes KO.');
console.log(lines.join('\n').split(base).join('<TMP>'));
if (process.env.GITHUB_ACTIONS === 'true') { // bilan en annotations, lisible sans les journaux
  const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const title = `Spike S5%2C Gemini CLI ${version}%2C ${process.platform}`;
  for (const s of steps.filter((x) => !x.ok)) console.log(`::error title=${title}::${esc(`${s.label} : ${s.detail}`.split(base).join('<TMP>'))}`);
  console.log(`::notice title=${title}::${esc(`${steps.filter((x) => x.ok).length} contrôles sur ${steps.length} réussis`)}`);
}
if (opt.keep) console.log(`Dossier conservé : ${base}`);
else {
  try { // sous Windows, un dossier peut rester verrouillé un moment (EBUSY constaté en CI)
    rmSync(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  } catch (e) {
    console.warn(`Dossier temporaire non supprimé (${e.code ?? e.message}) : ${base}`);
  }
}
process.exit(ok ? 0 : 1);
