#!/usr/bin/env node
// geminiboard.mjs : client en ligne de commande du board. Il parle au serveur par son API (HTTP et
// WebSocket, sur 127.0.0.1) et ne touche jamais la base lui-même : le serveur reste le seul écrivain.
// Node.js 20 ou plus ; mêmes commandes sous PowerShell et sous bash. Adresse du serveur : GEMINIBOARD_URL.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { CAPTURE_POLICIES } from '@geminiboard/server/capture.mjs';
import { inside } from '@geminiboard/server/projector.mjs';

export const USAGE = `Usage : geminiboard <commande> [options]

  serveur [--port <n>]               lance le serveur du board, sur 127.0.0.1 (port 3210 par défaut)
  sante                              état du serveur : Gemini CLI, tours en cours, base
  projets                            liste les projets
  projet ajouter <dossier> [--nom <nom>] [--capture full|metadata|off]
  projet approuver <projet>          approuve le dossier : Gemini CLI y tournera avec --skip-trust
  projet retirer <projet>            retire l'approbation du dossier
  projet capture <projet> full|metadata|off
                                     change la politique de capture, pour les tours suivants
  discuter [--projet <projet>] [--discussion <id>] [--mode default|auto_edit|yolo|plan] [--modele <nom>] [texte…]
                                     envoie un prompt (texte en argument, sinon sur l'entrée standard) et
                                     affiche la réponse au fil de l'eau ; Ctrl+C arrête le tour
  discussions [--projet <projet>] [--nombre <n>]
  fil <discussion>                   affiche une discussion, depuis la base, en Markdown

<projet> : identifiant court (slug) ou UUID ; sans --projet ni --discussion, discuter prend le projet
dont le dossier contient le dossier courant.
Serveur : GEMINIBOARD_URL (défaut http://127.0.0.1:3210).
Codes de sortie : 0 succès, 1 échec du tour ou de la requête, 2 usage, 3 serveur injoignable.`;

export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

const STATUS = { completed: 'terminé', cancelled: 'annulé', error: 'erreur', limit: 'limite de tours atteinte', refused: 'refusé', running: 'en cours' };
const TOOL_STATUS = { completed: 'terminé', failed: 'échec', cancelled: 'annulé', denied: 'refusé', in_progress: 'en cours', pending: 'en attente' };
const fmt = new Intl.NumberFormat('fr-FR');
const duration = (ms) => (ms < 1000 ? `${fmt.format(ms)} ms` : `${(ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s`);

/**
 * Message d'erreur lisible : Gemini CLI renvoie les erreurs d'API sous forme de JSON imbriqué et échappé ;
 * on en garde le message le plus profond, avec le statut HTTP. Le message complet reste dans la base.
 */
export function shortError(s) {
  const text = String(s ?? '');
  const inner = [...text.matchAll(/\\*"message\\*"\s*:\s*\\*"((?:[^"\\]|\\(?!\\*"))+)/g)].map((m) => m[1]).filter((m) => !m.startsWith('{'));
  const code = text.match(/\\*"code\\*"\s*:\s*(\d{3})/)?.[1];
  if (inner.length) return `${code ? `erreur d'API ${code} : ` : ''}${inner.at(-1)}`;
  return text.split('\n')[0].slice(0, 300);
}
const baseUrl = (env) => (env.GEMINIBOARD_URL || 'http://127.0.0.1:3210').replace(/\/+$/, '');

/** Client de l'API. `io` : { out, err, env, cwd, stdin } (remplaçables pour les tests). */
export function createClient(io) {
  const base = baseUrl(io.env);

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(base + path, {
        method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new CliError(`serveur injoignable (${base}) : le lancer avec « geminiboard serveur », dans un autre terminal`, 3);
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new CliError(data?.error?.message ?? `erreur HTTP ${res.status}`);
    return data;
  }

  async function findProject(ref) {
    const { projects } = await api('GET', '/api/projects');
    const p = projects.find((x) => x.slug === ref || x.id === ref);
    if (!p) throw new CliError(`projet inconnu : ${ref} (geminiboard projets)`, 2);
    return p;
  }

  /** Projet dont le dossier racine contient le dossier courant (le plus profond l'emporte). */
  async function projectOfCwd() {
    const { projects } = await api('GET', '/api/projects');
    let cwd = io.cwd;
    try { cwd = realpathSync.native(cwd); } catch { /* dossier courant tel quel */ }
    const found = projects.filter((p) => p.root_path && inside(p.root_path, cwd) !== null)
      .sort((a, b) => b.root_path.length - a.root_path.length)[0];
    if (!found) throw new CliError('aucun projet ne contient ce dossier : « geminiboard projet ajouter <dossier> », ou --projet <projet>', 2);
    return found;
  }

  const commands = {
    async sante() {
      const h = await api('GET', '/api/health');
      io.out(`Serveur ${base} : ${h.status} · Node.js ${h.node} · ${h.platform}\n`);
      io.out(`Gemini CLI : ${h.gemini.found ? (h.gemini.version ?? 'version inconnue') : 'introuvable (les prompts sont refusés)'}\n`);
      io.out(`Tours en cours : ${h.turns.running.length} sur ${h.turns.limit}\n`);
      io.out(`Base : schéma ${h.db.schema} · ${fmt.format(h.db.events)} événements · ${h.db.projects} projets · ${h.db.conversations} discussions · ${h.db.artifacts} artefacts\n`);
      return 0;
    },

    async projets() {
      const { projects } = await api('GET', '/api/projects');
      if (!projects.length) io.out('Aucun projet : « geminiboard projet ajouter <dossier> »\n');
      for (const p of projects) {
        io.out(`${p.slug.padEnd(24)} ${(p.trusted ? 'approuvé' : 'non approuvé').padEnd(13)} capture ${p.capture.padEnd(9)} ${p.root_path}\n`);
      }
      return 0;
    },

    async projet(args, opts) {
      const [action, target] = args;
      if (action === 'ajouter') {
        if (!target) throw new CliError('dossier attendu : geminiboard projet ajouter <dossier>', 2);
        const root = resolve(io.cwd, target);
        const name = opts.nom ?? root.split(/[\\/]/).filter(Boolean).at(-1);
        const { project: p } = await api('POST', '/api/projects', { name, root_path: root, ...(opts.capture ? { capture: opts.capture } : {}) });
        io.out(`Projet « ${p.name} » ajouté (${p.slug}) : ${p.root_path}\n`);
        io.out(`Capture : ${p.capture}. Dossier non approuvé : « geminiboard projet approuver ${p.slug} » avant d'y discuter.\n`);
        return 0;
      }
      if (action === 'approuver' || action === 'retirer') {
        if (!target) throw new CliError(`projet attendu : geminiboard projet ${action} <projet>`, 2);
        const p = await findProject(target);
        const { project } = await api('PATCH', `/api/projects/${p.id}`, { trusted: action === 'approuver' });
        if (project.trusted) {
          io.out(`Dossier approuvé : ${project.root_path}\n`);
          io.out('Gemini CLI y tournera avec --skip-trust : il y lit les fichiers, et y écrit ou exécute selon le mode d\'approbation de chaque prompt.\n');
        } else io.out(`Approbation retirée : ${project.root_path}\n`);
        return 0;
      }
      if (action === 'capture') {
        const policy = args[2];
        if (!target || !CAPTURE_POLICIES.includes(policy)) {
          throw new CliError(`usage : geminiboard projet capture <projet> ${CAPTURE_POLICIES.join('|')}`, 2);
        }
        const p = await findProject(target);
        const { project } = await api('PATCH', `/api/projects/${p.id}`, { capture: policy });
        io.out(`Capture du projet ${project.slug} : ${project.capture}, pour les tours suivants.\n`);
        return 0;
      }
      throw new CliError('action attendue : ajouter, approuver, retirer ou capture', 2);
    },

    async discussions(args, opts) {
      const project = opts.projet ? await findProject(opts.projet) : null;
      const limit = Number(opts.nombre ?? 20);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new CliError('--nombre : entier entre 1 et 200', 2);
      const qs = new URLSearchParams({ limit: String(limit), ...(project ? { project: project.id } : {}) });
      const { conversations } = await api('GET', `/api/conversations?${qs}`);
      if (!conversations.length) io.out('Aucune discussion.\n');
      for (const c of conversations) {
        const when = String(c.updated_at).slice(0, 16).replace('T', ' ');
        io.out(`${when}  ${c.id}  ${String(c.turn_count).padStart(3)} tour${c.turn_count > 1 ? 's' : ' '}  ${c.title ?? '(sans titre)'}${c.running ? '  [en cours]' : ''}\n`);
      }
      return 0;
    },

    async fil(args) {
      const [id] = args;
      if (!id) throw new CliError('identifiant de discussion attendu : geminiboard fil <discussion>', 2);
      const { conversation: c, items } = await api('GET', `/api/conversations/${encodeURIComponent(id)}/timeline`);
      io.out(`# ${c.title ?? '(sans titre)'}\n\n`);
      io.out(`Projet : ${c.project_name ?? 'aucun'} · ${c.turns.length} tour${c.turns.length > 1 ? 's' : ''} · modèle ${c.model ?? 'inconnu'} · discussion ${c.id}\n`);
      const turns = new Map(c.turns.map((t) => [t.seq, t]));
      let currentTurn = null;
      for (const item of items) {
        if (item.turn !== currentTurn) {
          currentTurn = item.turn;
          const t = turns.get(item.turn);
          const tokens = t && (t.input_tokens ?? 0) + (t.output_tokens ?? 0);
          io.out(`\n## Tour ${item.turn} · ${STATUS[t?.status] ?? t?.status ?? '?'}${tokens ? ` · ${fmt.format(tokens)} jetons` : ''}\n`);
          if (t?.error_message) io.out(`\n> ${shortError(t.error_message)}\n`);
        }
        if (item.kind === 'message') {
          const who = item.role === 'user' ? 'Vous' : item.role === 'assistant' ? 'Gemini' : item.role;
          io.out(`\n**${who}**\n\n${item.content || '*(contenu non capturé)*'}\n`);
        } else {
          io.out(`\n- \`${item.tool_name}\` · ${TOOL_STATUS[item.status] ?? item.status}${item.error_message ? ` : ${shortError(item.error_message)}` : ''}\n`);
        }
      }
      return 0;
    },

    async discuter(args, opts) {
      let text = args.join(' ');
      if (!text) {
        if (io.stdinIsTTY) throw new CliError('texte du prompt attendu, en argument ou sur l\'entrée standard', 2);
        text = await io.readStdin();
      }
      if (!text.trim()) throw new CliError('prompt vide', 2);
      const conversationId = opts.discussion;
      const projectId = conversationId ? undefined : (opts.projet ? await findProject(opts.projet) : await projectOfCwd()).id;
      const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
      await new Promise((ok, ko) => {
        ws.once('open', ok);
        ws.once('error', () => ko(new CliError(`serveur injoignable (${base}) : le lancer avec « geminiboard serveur »`, 3)));
      });

      return new Promise((done) => {
        let ended = false;
        let lastOut = '\n';
        let conv = conversationId ?? null;
        const out = (s) => { if (s) { io.out(s); lastOut = s.at(-1); } };
        const finish = (code) => {
          if (ended) return;
          ended = true;
          io.offInterrupt?.(interrupt);
          ws.close();
          done(code);
        };
        let interrupts = 0;
        const interrupt = () => {
          interrupts++;
          if (interrupts === 1) {
            ws.send(JSON.stringify({ type: 'cancel' }));
            io.err('\n[arrêt demandé : Ctrl+C de nouveau pour quitter sans attendre]\n');
          } else finish(130);
        };
        io.onInterrupt?.(interrupt);

        ws.on('message', (raw) => {
          let m;
          try { m = JSON.parse(raw.toString()); } catch { return; }
          if (m.type === 'turn.start') {
            conv = m.conversationId;
            io.err(`[discussion ${conv}${m.resume ? ' · reprise' : ''}${m.capture !== 'full' ? ` · capture ${m.capture}` : ''}]\n`);
          } else if (m.type === 'event') {
            const e = m.event ?? {};
            if (e.type === 'message' && e.role === 'assistant') out(String(e.content ?? ''));
            else if (e.type === 'tool_use') {
              const p = e.parameters ?? {};
              const detail = p.file_path ?? p.absolute_path ?? p.path ?? p.command ?? p.pattern ?? p.name ?? p.agent_name ?? '';
              io.err(`${lastOut === '\n' ? '' : '\n'}[outil] ${e.tool_name}${detail ? ` ${String(detail).slice(0, 200)}` : ''}\n`);
              lastOut = '\n';
            } else if (e.type === 'tool_result') {
              io.err(e.status === 'success' ? '[ok]\n' : `[échec] ${shortError(e.error?.message ?? '')}\n`);
            } else if (e.type === 'error') {
              io.err(`${lastOut === '\n' ? '' : '\n'}[${e.severity === 'warning' ? 'avertissement' : 'erreur'}] ${e.message ?? ''}\n`);
              lastOut = '\n';
            }
          } else if (m.type === 'turn.end') {
            if (lastOut !== '\n') io.out('\n');
            const tokens = (m.inputTokens ?? 0) + (m.outputTokens ?? 0);
            const secs = Number.isFinite(m.durationMs) ? duration(m.durationMs) : null;
            io.err(`[fin] ${STATUS[m.status] ?? m.status}${tokens ? ` · ${fmt.format(tokens)} jetons` : ''}${secs ? ` · ${secs}` : ''}`
              + `${m.errorMessage ? ` · ${shortError(m.errorMessage)}` : ''}\n`);
            io.err(`[suite] geminiboard discuter --discussion ${conv} "…"\n`);
            finish(m.status === 'completed' ? 0 : 1);
          } else if (m.type === 'turn.error') {
            io.err(`[refusé] ${m.message}\n`);
            finish(m.code === 'invalid' ? 2 : 1);
          }
        });
        ws.on('close', () => finish(1));
        ws.send(JSON.stringify({ type: 'prompt', requestId: 'cli', conversationId, projectId, text,
          ...(opts.mode ? { approvalMode: opts.mode } : {}), ...(opts.modele ? { model: opts.modele } : {}) }));
      });
    },
  };

  return { api, commands };
}

/** Point d'entrée : rend le code de sortie. */
export async function main(argv, io) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv, allowPositionals: true, strict: true,
      options: {
        port: { type: 'string' }, nom: { type: 'string' }, capture: { type: 'string' }, projet: { type: 'string' },
        discussion: { type: 'string' }, mode: { type: 'string' }, modele: { type: 'string' }, nombre: { type: 'string' },
        aide: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    io.err(`${e.message}\n\n${USAGE}\n`);
    return 2;
  }
  const [command, ...rest] = parsed.positionals;
  const opts = parsed.values;
  if (!command || command === 'aide' || opts.aide) {
    io.out(`${USAGE}\n`);
    return command || opts.aide ? 0 : 2;
  }
  if (command === 'serveur') {
    const port = opts.port === undefined ? undefined : Number(opts.port);
    if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) {
      io.err('--port : entier entre 1 et 65535\n');
      return 2;
    }
    const { startServer } = await import('@geminiboard/server');
    await startServer({ port, log: (s) => io.out(`${s}\n`) });
    return null; // le serveur tourne jusqu'à Ctrl+C
  }
  const { commands } = createClient(io);
  const run = commands[command];
  if (!run) {
    io.err(`commande inconnue : ${command}\n\n${USAGE}\n`);
    return 2;
  }
  try {
    return await run(rest, opts);
  } catch (e) {
    io.err(`${e instanceof CliError ? '' : 'erreur : '}${e.message}\n`);
    return e instanceof CliError ? e.exitCode : 1;
  }
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const io = {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    env: process.env,
    cwd: process.cwd(),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    readStdin: async () => {
      const chunks = [];
      for await (const c of process.stdin) chunks.push(c);
      return Buffer.concat(chunks).toString('utf8');
    },
    onInterrupt: (f) => process.on('SIGINT', f),
    offInterrupt: (f) => process.off('SIGINT', f),
  };
  main(process.argv.slice(2), io).then((code) => { if (code !== null) process.exitCode = code; });
}
