// run-gemini.mjs : lance un tour de Gemini CLI en mode headless et relaie ses événements.
// Node.js 20 ou plus, sans dépendance ; Linux, WSL2 et Windows natif.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

export const APPROVAL_MODES = ['default', 'auto_edit', 'yolo', 'plan'];

// Codes de sortie de Gemini CLI 0.65. Une erreur d'API sort avec le statut HTTP : 400 sous Windows,
// 144 ailleurs (400 modulo 256). C'est l'événement `result` (status: 'error') qui fait foi.
export const EXIT_CODES = {
  0: 'succès', 1: 'erreur générale', 41: 'authentification', 42: 'entrée invalide',
  52: 'configuration', 53: 'limite de tours', 55: 'dossier non approuvé', 130: 'annulation',
};

const isWindows = process.platform === 'win32';
const isScript = (path) => /\.[cm]?js$/i.test(path);

/**
 * Point d'entrée JavaScript de Gemini CLI installé globalement (bundle/gemini.js).
 * Le lancer avec node évite le raccourci gemini.cmd, donc cmd.exe, sous Windows.
 * Ordre : variable GEMINI_CLI_ENTRY, puis `npm root -g`. Renvoie null si introuvable.
 */
export function resolveGeminiEntry({ env = process.env } = {}) {
  if (env.GEMINI_CLI_ENTRY) return existsSync(env.GEMINI_CLI_ENTRY) ? env.GEMINI_CLI_ENTRY : null;
  const r = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', shell: isWindows, windowsHide: true, timeout: 30000 });
  const root = r.status === 0 ? r.stdout.trim() : '';
  const pkgFile = root ? join(root, '@google', 'gemini-cli', 'package.json') : '';
  if (!pkgFile || !existsSync(pkgFile)) return null;
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.gemini;
  const entry = rel ? join(dirname(pkgFile), rel) : null;
  return entry && existsSync(entry) ? entry : null;
}

/**
 * @param {object}   o
 * @param {string}   o.prompt        texte saisi, transmis par stdin (jamais par la ligne de commande)
 * @param {string}   o.cwd           dossier racine du projet
 * @param {string}   o.sessionId     identifiant de la discussion, choisi par le board (UUID)
 * @param {boolean}  o.resume        false au premier tour (--session-id), true ensuite (--resume)
 * @param {string}  [o.approvalMode] default | auto_edit | yolo | plan
 * @param {string}  [o.model]
 * @param {boolean} [o.skipTrust]    true si l'humain a approuvé le dossier du projet dans le board
 * @param {string[]}[o.policies]     fichiers de politique ajoutés pour ce tour (--policy)
 * @param {string}  [o.entry]        point d'entrée gemini.js, lancé avec le node du board (recommandé)
 * @param {string}  [o.bin]          à défaut, commande gemini (raccourci npm ; gemini.cmd sous Windows)
 * @param {number}  [o.maxHeapMb]    plafond du tas V8 de Gemini CLI, en Mo (avec entry seulement)
 * @param {boolean} [o.relaunch]     true pour laisser Gemini CLI se relancer avec un tas égal à 50 % de la RAM
 * @param {object}  [o.env]          variables ajoutées à l'environnement du processus
 * @param {(event: object) => void} o.onEvent  appelé pour chaque ligne JSONL
 */
export function runGemini({ prompt, cwd, sessionId, resume, approvalMode = 'default', model, skipTrust = false,
  policies = [], entry, bin = 'gemini', maxHeapMb, relaunch = false, env, onEvent }) {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error(`sessionId invalide : ${sessionId}`);
  if (!APPROVAL_MODES.includes(approvalMode)) throw new Error(`mode d'approbation inconnu : ${approvalMode}`);
  if (model && !/^[\w.-]+$/.test(model)) throw new Error(`modèle invalide : ${model}`);
  if (maxHeapMb !== undefined && !(Number.isInteger(maxHeapMb) && maxHeapMb >= 64)) {
    throw new Error(`plafond de tas invalide : ${maxHeapMb}`);
  }
  for (const p of policies) {
    if (typeof p !== 'string' || !p || p.startsWith('-')) throw new Error(`politique invalide : ${p}`);
  }

  // Avec node et gemini.js, aucun shell ; le raccourci gemini.cmd de Windows est le seul cas qui en exige un.
  // Un chemin relatif se lit depuis le dossier du board, pas depuis cwd (le dossier du projet)
  const script = entry ? resolve(entry) : (isScript(bin) ? resolve(bin) : null);
  const useShell = !script && isWindows;
  const quote = (arg) => (useShell && /\s/.test(arg) ? `"${arg}"` : arg);

  const args = ['--output-format', 'stream-json', '--approval-mode', approvalMode,
    resume ? '--resume' : '--session-id', sessionId];
  if (model) args.push('--model', model);
  if (skipTrust) args.push('--skip-trust'); // sinon, dossier non approuvé : sortie 55
  for (const p of policies) args.push('--policy', quote(p));

  const nodeArgs = script && maxHeapMb ? [`--max-old-space-size=${maxHeapMb}`] : [];
  const child = spawn(script ? process.execPath : bin, script ? [...nodeArgs, script, ...args] : args, {
    cwd,
    // GEMINI_CLI_NO_RELAUNCH : un seul processus au lieu de deux (environ 280 Mo au lieu de 460 Mo par tour).
    // NO_BROWSER : sans connexion Google en cache, Gemini CLI sort avec le code 41 ; sinon, sur un poste
    // avec navigateur (Windows), il demanderait sur stdin l'accord de l'ouvrir et prendrait le prompt pour la réponse
    env: { ...process.env, NO_BROWSER: 'true', ...(relaunch ? {} : { GEMINI_CLI_NO_RELAUNCH: 'true' }), ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: useShell,
    windowsHide: true,
  });

  child.stdin.on('error', () => {}); // processus déjà terminé : l'erreur remonte par 'close'
  child.stdin.end(prompt);            // stdin non interactif : Gemini CLI passe en headless

  let observedSessionId = null;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { event = { type: 'raw', line }; }
    if (event.type === 'init') observedSessionId = event.session_id;
    onEvent(event);
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-16384); });

  let cancelled = false;
  const done = new Promise((resolve, reject) => {
    child.once('error', reject); // binaire introuvable, droits...
    child.once('close', (code, signal) => resolve({
      code, signal, cancelled,
      // Arrêt demandé : code 130 sous Linux, fin forcée sous Windows ; le sens reste « annulation »
      meaning: cancelled ? EXIT_CODES[130] : (EXIT_CODES[code] ?? null),
      sessionId: observedSessionId, stderr,
    }));
  });

  let killTimer = null;
  done.finally(() => clearTimeout(killTimer)).catch(() => {});
  const cancel = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    cancelled = true;
    if (isWindows) {
      // Pas de SIGINT sous Windows : arrêt de toute l'arborescence (Gemini CLI et ses commandes)
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        .once('error', () => child.kill());
      return;
    }
    child.kill('SIGINT');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
  };

  return { pid: child.pid, args, done, cancel };
}
