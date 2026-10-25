#!/usr/bin/env node
// capture.mjs : spike de l'étape 1. Lance Gemini CLI en headless sur des scénarios synthétiques
// et enregistre le flux stream-json dans fixtures/spike-<date>/ (points S1 à S4 du cadrage).
// Node.js 20 ou plus, sans dépendance. Mode d'emploi : spike/README.md
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGeminiEntry, runGemini } from '../packages/server/src/run-gemini.mjs';
import { uuidv7 } from '../packages/server/src/uuidv7.mjs';
import { MEMORY_SCOPE, sampleMemory } from './memory.mjs';
import { createRedactor } from './redact.mjs';
import { assistantText, buildScenarios, toolCalls, WORKSPACE_FILES } from './scenarios.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const { values: opt } = parseArgs({
  options: {
    entry: { type: 'string' },
    bin: { type: 'string' },
    'max-heap': { type: 'string' },
    relaunch: { type: 'boolean', default: false },
    model: { type: 'string' },
    only: { type: 'string' },
    'with-yolo': { type: 'boolean', default: false },
    timeout: { type: 'string', default: '180' },
    out: { type: 'string', default: join(repoRoot, 'fixtures') },
    'keep-workspace': { type: 'boolean', default: false },
  },
});

const fail = (code, message) => { console.error(message); process.exit(code); };
if (Number(process.versions.node.split('.')[0]) < 20) fail(2, `Node.js 20 ou plus requis (actuel : ${process.version}).`);
const timeoutMs = Number(opt.timeout) * 1000;
if (!(timeoutMs > 0)) fail(2, `--timeout invalide : ${opt.timeout}`);
const only = opt.only ? opt.only.split(',').map((s) => s.trim().toUpperCase()) : null;
const maxHeapMb = opt['max-heap'] ? Number(opt['max-heap']) : undefined;
if (maxHeapMb !== undefined && !(Number.isInteger(maxHeapMb) && maxHeapMb >= 64)) fail(2, `--max-heap invalide : ${opt['max-heap']}`);

// Lancement comme le board : node + gemini.js (sans shell) ; à défaut, la commande gemini
const entry = opt.entry ? resolve(opt.entry) : (opt.bin ? null : resolveGeminiEntry());
const bin = opt.bin ?? 'gemini';
const launchEnv = opt.relaunch ? {} : { GEMINI_CLI_NO_RELAUNCH: 'true' };

// --- Prérequis : Gemini CLI présent ----------------------------------------------
function geminiVersion() {
  return new Promise((done) => {
    const [cmd, args] = entry ? [process.execPath, [entry, '--version']] : [bin, ['--version']];
    const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: !entry && process.platform === 'win32',
      windowsHide: true, env: { ...process.env, ...launchEnv } });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    const t = setTimeout(() => c.kill('SIGKILL'), 60000);
    c.once('error', (e) => { clearTimeout(t); done({ ok: false, error: e.code ?? e.message }); });
    c.once('close', (code) => { clearTimeout(t); done(code === 0 ? { ok: true, version: out.trim() } : { ok: false, error: `code ${code}` }); });
  });
}
const version = await geminiVersion();
if (!version.ok) {
  fail(2, `Gemini CLI introuvable (${version.error}). Installe-le avec « npm install -g @google/gemini-cli », `
    + 'ou indique --entry <chemin de gemini.js> ou --bin <commande>.');
}

// --- Dossier de travail synthétique, approuvé pour la session -------------------
const workspace = mkdtempSync(join(tmpdir(), 'geminiboard-spike-'));
for (const [file, content] of Object.entries(WORKSPACE_FILES)) {
  mkdirSync(dirname(join(workspace, file)), { recursive: true });
  writeFileSync(join(workspace, file), content);
}

// Masquage des chemins locaux (y compris leur forme longue sous Windows : realpath.native
// développe les noms courts comme JEANDU~1), du nom d'utilisateur, des clés et des adresses
const attempt = (f) => { try { return f(); } catch { return null; } };
const redact = createRedactor([
  [workspace, '<WORKSPACE>'], [attempt(() => realpathSync(workspace)), '<WORKSPACE>'],
  [attempt(() => realpathSync.native(workspace)), '<WORKSPACE>'],
  [repoRoot, '<REPO>'], [attempt(() => realpathSync.native(repoRoot)), '<REPO>'],
  // Dossier d'installation de Gemini CLI, cité par les piles d'appels de stderr (file:///…/bundle/chunk-….js)
  [entry && dirname(entry), '<GEMINI_CLI>'], [entry && attempt(() => realpathSync.native(dirname(entry))), '<GEMINI_CLI>'],
  [homedir(), '<HOME>'], [attempt(() => realpathSync.native(homedir())), '<HOME>'],
], { username: attempt(() => userInfo().username) });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = join(resolve(opt.out), `spike-${stamp}`);
mkdirSync(outDir, { recursive: true });
const launchText = `${entry ? 'node + gemini.js' : `commande ${bin}`}, relance ${opt.relaunch ? 'autorisée' : 'désactivée'}, `
  + `plafond du tas : ${maxHeapMb ? `${maxHeapMb} Mo` : 'aucun'}`;
console.log(`Gemini CLI ${version.version} · Node.js ${process.version} · ${launchText}`);
console.log(`Sortie : ${outDir}`);

// --- Exécution d'un tour ----------------------------------------------------------
const active = new Set();
let abort = null;
process.on('SIGINT', () => {
  abort = 'interrompu par l\'utilisateur';
  for (const h of active) h.cancel();
});

async function runOne({ prompt, approvalMode, policies, sessionId, resume }) {
  const events = [];
  const t0 = performance.now();
  let tInit = null;
  let tFirst = null;
  const h = runGemini({
    prompt, cwd: workspace, sessionId, resume, approvalMode, model: opt.model,
    skipTrust: true, policies: policies ?? [], entry: entry ?? undefined, bin, maxHeapMb, relaunch: opt.relaunch,
    onEvent: (e) => {
      const t = performance.now() - t0;
      if (e.type === 'init' && tInit === null) tInit = t;
      if (e.type === 'message' && e.role === 'assistant' && tFirst === null) tFirst = t;
      events.push(e);
    },
  });
  active.add(h);
  const memory = sampleMemory(h.pid);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; h.cancel(); }, timeoutMs);
  let result;
  try {
    result = await h.done;
  } catch (e) {
    result = { code: null, signal: null, meaning: `lancement impossible (${e.code ?? e.message})`, stderr: '', spawnError: true };
  } finally {
    clearTimeout(timer);
    active.delete(h);
  }
  const ms = (v) => (v === null ? null : Math.round(v));
  return { events, result, timedOut, args: h.args, memoryPeakMb: memory.stop(),
    timings: { init_ms: ms(tInit), first_assistant_ms: ms(tFirst), total_ms: ms(performance.now() - t0) } };
}

function save(scenario, turn, run, ctx) {
  const dir = join(outDir, scenario);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${turn}.jsonl`), run.events.map((e) => `${redact(JSON.stringify(e))}\n`).join(''));
  const counts = {};
  for (const e of run.events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  const last = [...run.events].reverse().find((e) => e.type === 'result');
  const result = last ? { status: last.status, error: last.error ? redact(last.error.message).slice(0, 300) : null } : null;
  const meta = {
    scenario, turn,
    prompt: redact(ctx.prompt),
    approvalMode: ctx.approvalMode,
    policies: (ctx.policies ?? []).map((p) => relative(repoRoot, p)),
    session: { key: ctx.sessionKey, id: ctx.sessionId, resume: ctx.resume },
    argv: ['gemini', ...run.args.map(redact)],
    exit: { code: run.result.code, signal: run.result.signal, meaning: run.result.meaning, timedOut: run.timedOut, result },
    timings: run.timings,
    memoryPeakMb: run.memoryPeakMb,
    counts,
    tools: toolCalls(run.events),
    assistantText: redact(assistantText(run.events)).slice(0, 2000),
    stderrTail: redact(run.result.stderr).slice(-2000),
    check: ctx.check,
  };
  writeFileSync(join(dir, `${turn}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

const safeCheck = (check, input) => {
  try { return check(input) ?? { ok: null, label: '' }; } catch (e) { return { ok: false, label: `contrôle en erreur : ${e.message}` }; }
};

// --- Scénarios -----------------------------------------------------------------
const scenarios = buildScenarios({ withYolo: opt['with-yolo'], policyFile: join(here, 'policy-ls.toml') })
  .filter((s) => !only || only.includes(s.id));
const sessions = new Map();
const sessionFor = (key) => {
  if (key === 'new') return { id: uuidv7(), resume: false };
  if (sessions.has(key)) return { id: sessions.get(key), resume: true };
  const id = uuidv7();
  sessions.set(key, id);
  return { id, resume: false };
};

const metas = [];
const fmtSec = (ms) => (ms === null ? '—' : `${(ms / 1000).toFixed(1).replace('.', ',')} s`);
const fmtMb = (mb) => (mb === null || mb === undefined ? '—' : `${mb} Mo`);

try {
  for (const sc of scenarios) {
    for (const t of sc.turns) {
      if (abort) break;
      const prompts = t.prompts ?? [t.prompt];
      const { id: sessionId, resume } = sessionFor(t.session);
      const runs = await Promise.all(prompts.map((prompt) =>
        runOne({ prompt, approvalMode: t.approvalMode, policies: t.policies, sessionId, resume })));
      runs.forEach((run, i) => {
        const turn = prompts.length > 1 ? `${t.id}${'abcdefgh'[i]}` : t.id;
        const check = safeCheck(t.check, { events: run.events, workspace, result: run.result });
        const meta = save(sc.id, turn, run, {
          prompt: prompts[i], approvalMode: t.approvalMode, policies: t.policies,
          sessionKey: t.session, sessionId, resume, check,
        });
        metas.push(meta);
        const mark = check.ok === true ? 'OK' : check.ok === false ? 'KO' : '··';
        const resultStatus = meta.exit.result ? `result : ${meta.exit.result.status}` : 'sans result';
        console.log(`${sc.id} ${turn.padEnd(4)} ${t.approvalMode.padEnd(9)} code ${String(run.result.code)} (${run.result.meaning ?? resultStatus})`
          + ` ${fmtSec(run.timings.total_ms)} ${fmtMb(run.memoryPeakMb)}${run.timedOut ? ' délai dépassé' : ''}  ${mark} ${check.label}`);
        if (run.result.spawnError) abort ??= `Gemini CLI n'a pas pu être lancé (${run.result.meaning}).`;
        if (run.result.code === 41) abort ??= 'authentification absente : lance « gemini » une fois en interactif pour te connecter, ou définis GEMINI_API_KEY.';
        if (run.result.code === 55) abort ??= 'dossier non approuvé malgré --skip-trust : vérifie la version de Gemini CLI.';
      });
    }
    if (abort) break;
  }
} finally {
  const env = {
    date: new Date().toISOString(),
    gemini: version.version,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    model: opt.model ?? 'par défaut',
    launch: { mode: entry ? 'node + gemini.js' : 'commande', relaunch: opt.relaunch, maxHeapMb: maxHeapMb ?? null,
      text: launchText, memoryScope: MEMORY_SCOPE },
    options: { only, withYolo: opt['with-yolo'], timeoutSeconds: timeoutMs / 1000 },
    turns: metas.length,
    abort,
  };
  writeFileSync(join(outDir, 'environnement.json'), `${JSON.stringify(env, null, 2)}\n`);
  writeFileSync(join(outDir, 'rapport.md'), renderReport(env));
  if (opt['keep-workspace']) console.log(`Dossier de travail conservé : ${workspace}`);
  // Reprises : sous Windows, un fichier peut rester verrouillé un instant (antivirus, indexation)
  else rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

console.log(abort ? `Arrêt anticipé : ${abort}` : 'Spike terminé.');
console.log(`Rapport : ${join(outDir, 'rapport.md')}`);
process.exit(abort ? 3 : 0);

// --- Rapport ---------------------------------------------------------------------
function renderReport(env) {
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
  const codeText = (m) => `${m.exit.code ?? '—'}`
    + `${m.exit.meaning ? ` (${m.exit.meaning})` : m.exit.result ? ` (result : ${m.exit.result.status})` : ''}`
    + `${m.exit.timedOut ? ', délai dépassé' : ''}`;
  const countsText = (c) => Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ') || '—';
  const toolsText = (tools) => tools.map((t) => `${t.name} : ${t.status}`).join(', ') || '—';
  const checkText = (c) => `${c.ok === true ? 'OK' : c.ok === false ? 'KO' : '·'} ${c.label}`;
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

  const L = ['# Spike de capture : rapport', ''];
  L.push(`- Date : ${env.date}`);
  L.push(`- Gemini CLI : ${env.gemini} · Node.js : ${env.node} · Plateforme : ${env.platform}`);
  L.push(`- Modèle : ${env.model} · Délai maximal par tour : ${env.options.timeoutSeconds} s`);
  L.push(`- Lancement : ${env.launch.text}`);
  L.push('- Dossier de travail : synthétique, approuvé pour la session (`--skip-trust`) ; chemins et nom d\'utilisateur masqués (`<WORKSPACE>`, `<REPO>`, `<GEMINI_CLI>`, `<HOME>`, `<USER>`)');
  L.push('');
  if (env.abort) L.push(`> **Arrêt anticipé** : ${env.abort}`, '');

  for (const sc of scenarios) {
    const ms = metas.filter((m) => m.scenario === sc.id);
    if (!ms.length) continue;
    L.push(`## ${sc.id}. ${sc.title}`, '', sc.expectation, '');
    L.push('| Tour | Mode | Code | Durée | Mémoire | Événements | Outils | Contrôle |', '|---|---|---|---|---|---|---|---|');
    for (const m of ms) {
      L.push(`| ${m.turn} | ${m.approvalMode} | ${cell(codeText(m))} | ${fmtSec(m.timings.total_ms)} | ${fmtMb(m.memoryPeakMb)} | ${cell(countsText(m.counts))} | ${cell(toolsText(m.tools))} | ${cell(checkText(m.check))} |`);
    }
    L.push('');
  }

  const s4 = metas.filter((m) => m.scenario === 'S4' && m.exit.code === 0);
  if (s4.length) {
    L.push('### Délais mesurés (S4)', '', '| Mesure | min | médiane | max |', '|---|---|---|---|');
    for (const [key, label] of [['init_ms', 'jusqu\'à `init`'], ['first_assistant_ms', 'jusqu\'au premier fragment de réponse'], ['total_ms', 'tour complet']]) {
      const xs = s4.map((m) => m.timings[key]).filter((v) => v !== null);
      if (xs.length) L.push(`| ${label} | ${fmtSec(Math.min(...xs))} | ${fmtSec(median(xs))} | ${fmtSec(Math.max(...xs))} |`);
    }
    L.push('');
  }

  const mem = metas.map((m) => m.memoryPeakMb).filter((v) => typeof v === 'number');
  const memoryLine = mem.length
    ? `- Pic de mémoire de Gemini CLI par tour : médiane ${fmtMb(median(mem))}, maximum ${fmtMb(Math.max(...mem))} (${env.launch.text} ; mesure : ${env.launch.memoryScope})`
    : '- Pic de mémoire de Gemini CLI par tour : non mesuré sur cette plateforme';

  const types = [...new Set(metas.flatMap((m) => Object.keys(m.counts)))].sort();
  const verdicts = metas.filter((m) => m.check.ok !== null);
  L.push('## Synthèse', '');
  L.push(`- Tours exécutés : ${metas.length} ; contrôles réussis : ${verdicts.filter((m) => m.check.ok).length} sur ${verdicts.length}`);
  L.push(`- Types d'événements observés : ${types.join(', ') || 'aucun'}`);
  L.push(`- Codes de sortie : ${[...new Set(metas.map((m) => m.exit.code))].join(', ')}`);
  L.push(memoryLine);
  const errors = metas.filter((m) => m.exit.result?.status === 'error');
  const tidy = (s) => String(s ?? '—').replace(/\\[nrt]/g, ' ').replace(/\\+"/g, '"').replace(/\s+/g, ' ').trim();
  if (errors.length) L.push(`- Tours terminés par un \`result\` en erreur : ${errors.map((m) => `${m.scenario} ${m.turn}`).join(', ')} (premier message : ${cell(tidy(errors[0].exit.result.error)).slice(0, 160)})`);
  L.push('');
  L.push('## Avant de committer', '');
  L.push('- Relire ce rapport et quelques fichiers `.jsonl` : les prompts sont synthétiques, mais vérifier qu\'aucune donnée personnelle ou de travail n\'apparaît.');
  L.push('- Puis ajouter ce dossier dans une branche et ouvrir une PR : ce corpus sert aux tests du projecteur (étape 2).');
  return `${L.join('\n')}\n`;
}
