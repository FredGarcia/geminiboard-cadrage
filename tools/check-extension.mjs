#!/usr/bin/env node
// check-extension.mjs : contrôle l'extension du dépôt (gemini-extension.json à la racine) sur le vrai
// Gemini CLI, sans compte, dans un GEMINI_CLI_HOME temporaire : la configuration de l'utilisateur n'est
// pas touchée.
//   1. gemini extensions validate, puis link, avec l'accord donné sur stdin ;
//   2. gemini extensions list -o json : extension active, fichier de contexte, skills et sous-agents du
//      dépôt chargés, aucune erreur de chargement ;
//   3. chaque commande qui contient une injection !{…}, en headless avec une clé d'API invalide :
//      - sans politique, Gemini CLI la refuse (« Blocked by policy ») : la commande est donc chargée et
//        son injection reconnue ;
//      - avec skills/geminiboard/assets/politique-headless.toml, l'injection passe et l'appel au modèle
//        échoue ensuite en 400 : la politique couvre bien la commande ;
//      - la sortie des scripts lancés (etat.mjs, verifier.mjs) figure dans le prompt envoyé, lu dans la
//        session que Gemini CLI écrit : les scripts tournent sous le shell de Gemini CLI (PowerShell sous Windows) ;
//   4. aucun TOML illisible ni aucune commande écartée, dans aucune sortie.
// Node.js 20 ou plus, sans dépendance. Usage : node tools/check-extension.mjs [--entry <gemini.js>] [--keep]
// Code de sortie : 0 conforme, 1 écart, 2 Gemini CLI introuvable.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveGeminiEntry } from '../packages/server/src/run-gemini.mjs';
import { parseToml } from './check-components.mjs';

const { values: opt } = parseArgs({ options: { entry: { type: 'string' }, keep: { type: 'boolean', default: false } } });
const entry = opt.entry ? resolve(opt.entry) : resolveGeminiEntry();
if (!entry) {
  console.error('Gemini CLI introuvable : « npm install -g @google/gemini-cli », ou --entry <chemin de gemini.js>.');
  process.exit(2);
}

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const manifest = JSON.parse(readFileSync(join(root, 'gemini-extension.json'), 'utf8'));
const POLICY = join(root, 'skills', 'geminiboard', 'assets', 'politique-headless.toml');
// Arguments passés aux commandes : verifier sans les tests, pour rester court
const ARGS = { '/board:verifier': '--sans-tests' };
const base = mkdtempSync(join(tmpdir(), 'geminiboard-ext-'));
const home = join(base, 'home');
mkdirSync(home, { recursive: true });

// Aucune connexion réelle : dossier personnel temporaire, variables d'authentification retirées
const env = { ...process.env, GEMINI_CLI_HOME: home, GEMINI_CLI_NO_RELAUNCH: 'true', NO_BROWSER: 'true' };
for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_GCA', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GEMINI_BASE_URL',
  'GOOGLE_CLOUD_PROJECT', 'GOOGLE_APPLICATION_CREDENTIALS']) delete env[k];
function gemini(args, { cwd = root, input = '', extra = {} } = {}) {
  const r = spawnSync(process.execPath, [entry, ...args], {
    cwd, input, encoding: 'utf8', timeout: 180000, windowsHide: true, env: { ...env, ...extra }, maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const steps = [];
const step = (label, ok, detail = '') => { steps.push({ label, ok: Boolean(ok), detail }); };
const outputs = [];
const keep = (r) => { outputs.push(r.out); return r; };
const lastLine = (s) => s.trim().split('\n').at(-1) ?? '';

const version = gemini(['--version']).out.trim();

// 1. Validation et liaison
const validate = keep(gemini(['extensions', 'validate', root]));
step('extension validée (gemini extensions validate)', validate.code === 0 && /validated/i.test(validate.out), lastLine(validate.out));
const link = keep(gemini(['extensions', 'link', root], { input: 'y\n', extra: { GEMINI_CLI_TRUST_WORKSPACE: 'true' } }));
step('extension liée (gemini extensions link)', link.code === 0 && /linked successfully/i.test(link.out), lastLine(link.out));

// 2. Ce que Gemini CLI charge depuis le dépôt
const list = keep(gemini(['extensions', 'list', '-o', 'json']));
let info = null;
try {
  const start = list.stderr.search(/^\[\s*$/m); // JSON sur stderr, après d'éventuelles erreurs « [ExtensionManager] … »
  const all = JSON.parse(list.stderr.slice(start, list.stderr.lastIndexOf(']') + 1));
  info = all.find((e) => e.name === manifest.name) ?? null;
} catch { /* info reste null */ }
step(`extension ${manifest.name} active dans le dépôt`, info?.isActive === true, info ? `version ${info.version}` : 'absente de gemini extensions list -o json');
const contexts = (info?.contextFiles ?? []).map((f) => f.split(/[\\/]/).at(-1));
step(`fichier de contexte ${manifest.contextFileName} chargé`, contexts.includes(manifest.contextFileName), contexts.join(', ') || 'aucun');

const repoSkills = existsSync(join(root, 'skills'))
  ? readdirSync(join(root, 'skills')).filter((d) => existsSync(join(root, 'skills', d, 'SKILL.md'))) : [];
const loadedSkills = (info?.skills ?? []).map((s) => s.name);
for (const s of repoSkills) step(`skill ${s} chargée`, loadedSkills.includes(s), loadedSkills.join(', ') || 'aucune skill');
const repoAgents = existsSync(join(root, 'agents'))
  ? readdirSync(join(root, 'agents')).filter((f) => f.endsWith('.md') && !f.startsWith('_')).map((f) => f.slice(0, -3)) : [];
const loadedAgents = (info?.agents ?? []).map((a) => a.name);
for (const a of repoAgents) step(`sous-agent ${a} chargé`, loadedAgents.includes(a), loadedAgents.join(', ') || 'aucun sous-agent');
const agentErrors = list.stderr.split('\n').filter((l) => /Error loading agent|Failed to load agent/.test(l));
step('aucune erreur de chargement de sous-agent', agentErrors.length === 0, agentErrors.join(' | '));

// 3. Commandes à injection, en headless
const listFiles = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  (e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)])) : []);
const commands = listFiles(join(root, 'commands')).filter((f) => f.endsWith('.toml')).sort().map((file) => ({
  name: `/${relative(join(root, 'commands'), file).replace(/\.toml$/, '').split(sep).join(':')}`,
  prompt: parseToml(readFileSync(file, 'utf8')).root.prompt ?? '',
})).filter((c) => c.prompt.includes('!{'));

function headless(command, policy) {
  const flags = ['--output-format', 'stream-json', '--skip-trust', ...(policy ? ['--policy', policy] : [])];
  const r = keep(gemini(flags, { input: `${command.name} ${ARGS[command.name] ?? 'essai'}`, extra: { GEMINI_API_KEY: 'cle-invalide-pour-la-ci' } }));
  let result = null;
  for (const l of r.stdout.split('\n')) {
    try { const e = JSON.parse(l); if (e.type === 'result') result = e; } catch { /* ligne non JSON */ }
  }
  return { code: r.code, message: String(result?.error?.message ?? result?.status ?? `pas de result (sortie ${r.code})`) };
}
// Prompt réellement envoyé au modèle, sorties des injections comprises : dernier message « user » de la
// session que Gemini CLI vient d'écrire dans le dossier personnel temporaire (format interne de la 0.65,
// qui écrit la session même quand l'appel au modèle échoue)
function lastSentPrompt() {
  const dir = join(home, '.gemini', 'tmp');
  const chats = listFiles(dir).filter((f) => /[\\/]chats[\\/][^\\/]+\.jsonl$/.test(f))
    .map((f) => ({ f, t: statSync(f).mtimeMs })).sort((a, b) => b.t - a.t);
  if (!chats.length) return null;
  let text = null;
  for (const l of readFileSync(chats[0].f, 'utf8').split('\n')) {
    try {
      const e = JSON.parse(l);
      if (e.type === 'user' && Array.isArray(e.content)) text = e.content.map((p) => p.text ?? '').join('');
    } catch { /* ligne non JSON */ }
  }
  return text;
}
// Ce que chaque script écrit en tête de sa sortie
const MARKERS = { 'etat.mjs': '# État du dépôt GeminiBoard', 'verifier.mjs': 'Contrôles du dépôt GeminiBoard' };
const short = (m) => (/API key not valid/.test(m) ? "clé d'API refusée (400), comme attendu" : m.replace(/\s+/g, ' ').slice(0, 160));
for (const c of commands) {
  const denied = headless(c, null);
  step(`${c.name} : chargée, injection refusée sans politique`, /cannot be run\. Blocked command: .*Blocked by policy/s.test(denied.message), short(denied.message));
  const allowed = headless(c, POLICY);
  step(`${c.name} : injection autorisée par politique-headless.toml, puis erreur d'API`,
    !/Blocked by policy|Failed to start shell command/.test(allowed.message) && /API key not valid|API_KEY_INVALID|400/.test(allowed.message),
    short(allowed.message));
  const sent = lastSentPrompt() ?? '';
  const scripts = [...c.prompt.matchAll(/!\{node skills\/geminiboard\/scripts\/([\w-]+\.mjs)/g)].map((m) => m[1]);
  const missing = scripts.filter((s) => MARKERS[s] && !sent.includes(MARKERS[s]));
  // Gemini CLI 0.65 ajoute « terminated by signal 0 » après une commande réussie : seul le reste compte
  const exits = [...sent.matchAll(/\[Shell command '([^']*)' (exited with code \d+|aborted|terminated by signal \w+)\]/g)]
    .filter((m) => m[2] !== 'terminated by signal 0').map((m) => `${m[1]} : ${m[2]}`);
  step(`${c.name} : sortie de ${scripts.join(' et ')} insérée dans le prompt`, sent && !missing.length,
    !sent ? 'session introuvable dans le dossier personnel temporaire' : missing.length ? `absente : ${missing.join(', ')}` : exits.join(' ; '));
}
if (!commands.length) step('commandes à injection trouvées dans commands/', false, 'aucune');

// 4. Erreurs de chargement des commandes et des politiques, dans toutes les sorties
const loaderErrors = outputs.join('\n').split('\n').filter((l) => /Failed to parse TOML|Skipping invalid command file|Unclosed injection/.test(l));
step('aucun TOML illisible ni aucune commande écartée', loaderErrors.length === 0, [...new Set(loaderErrors)].join(' | '));
const policyErrors = outputs.join('\n').split('\n').filter((l) => /Policy file error|Invalid policy rule/.test(l));
step('politique-headless.toml chargée sans erreur', policyErrors.length === 0, [...new Set(policyErrors)].join(' | '));

// Bilan
const ok = steps.every((s) => s.ok);
const mask = (s) => String(s).split(base).join('<TMP>').split(root).join('<REPO>');
const lines = [`Extension du dépôt · Gemini CLI ${version} · Node.js ${process.version} · ${process.platform}`, ''];
for (const s of steps) lines.push(`${s.ok ? 'OK' : 'KO'}  ${s.label}${s.detail ? ` (${s.detail})` : ''}`);
lines.push('', ok ? 'Extension conforme.' : 'Écart constaté : voir les lignes KO.');
console.log(mask(lines.join('\n')));
if (process.env.GITHUB_ACTIONS === 'true') { // bilan en annotations, lisible sans les journaux
  const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const title = `Extension du dépôt%2C Gemini CLI ${version}%2C ${process.platform}`;
  for (const s of steps.filter((x) => !x.ok)) console.log(`::error title=${title}::${esc(mask(`${s.label} : ${s.detail}`))}`);
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
