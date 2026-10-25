// run-gemini.mjs : lance un tour de Gemini CLI en mode headless et relaie ses événements.
// Node.js 20 ou plus, sans dépendance.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export const APPROVAL_MODES = ['default', 'auto_edit', 'yolo', 'plan'];

// Codes de sortie de Gemini CLI 0.65. Une erreur d'API sort avec le statut HTTP modulo 256
// (400 donne 144) : c'est l'événement `result` (status: 'error') qui fait foi.
export const EXIT_CODES = {
  0: 'succès', 1: 'erreur générale', 41: 'authentification', 42: 'entrée invalide',
  52: 'configuration', 53: 'limite de tours', 55: 'dossier non approuvé', 130: 'annulation',
};

// Sous Windows, gemini.cmd impose un shell : on y protège les chemins contenant des espaces.
const forWindowsShell = (arg) => (process.platform === 'win32' && /\s/.test(arg) ? `"${arg}"` : arg);

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
 * @param {string}  [o.bin]          binaire gemini (paquet npm @google/gemini-cli)
 * @param {object}  [o.env]          variables ajoutées à l'environnement du processus
 * @param {(event: object) => void} o.onEvent  appelé pour chaque ligne JSONL
 */
export function runGemini({ prompt, cwd, sessionId, resume, approvalMode = 'default', model, skipTrust = false,
  policies = [], bin = 'gemini', env, onEvent }) {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error(`sessionId invalide : ${sessionId}`);
  if (!APPROVAL_MODES.includes(approvalMode)) throw new Error(`mode d'approbation inconnu : ${approvalMode}`);
  if (model && !/^[\w.-]+$/.test(model)) throw new Error(`modèle invalide : ${model}`);
  for (const p of policies) {
    if (typeof p !== 'string' || !p || p.startsWith('-')) throw new Error(`politique invalide : ${p}`);
  }

  const args = ['--output-format', 'stream-json', '--approval-mode', approvalMode,
    resume ? '--resume' : '--session-id', sessionId];
  if (model) args.push('--model', model);
  if (skipTrust) args.push('--skip-trust'); // sinon, dossier non approuvé : sortie 55
  for (const p of policies) args.push('--policy', forWindowsShell(p));

  const child = spawn(bin, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32', // gemini.cmd sous Windows ; le prompt ne passe pas par le shell
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
      // Arrêt demandé : code 130, ou fin par signal si l'arrêt arrive très tôt
      meaning: cancelled ? EXIT_CODES[130] : (EXIT_CODES[code] ?? null),
      sessionId: observedSessionId, stderr,
    }));
  });

  let killTimer = null;
  done.finally(() => clearTimeout(killTimer)).catch(() => {});
  const cancel = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    cancelled = true;
    child.kill('SIGINT');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
  };

  return { pid: child.pid, args, done, cancel };
}
