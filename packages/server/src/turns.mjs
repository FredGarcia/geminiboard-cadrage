// turns.mjs : conduite des tours. Un tour = un prompt = un processus Gemini CLI (D9) :
// discussion et projet retrouvés, dossier approuvé exigé, limites de simultanéité, journal (selon la
// politique de capture, secrets masqués), instantanés des fichiers écrits, projection en fin de tour.
//
// Discussion du board et session de Gemini CLI sont deux identifiants distincts. Une discussion reprend
// (--resume) sa dernière session qui a abouti ; sinon elle en ouvre une nouvelle (--session-id), avec un
// UUID aléatoire : Gemini CLI 0.65 nomme le fichier d'une session d'après la minute et les 8 premiers
// caractères de son identifiant, et deux UUIDv7 de la même minute s'écraseraient l'un l'autre. Une session
// dont le premier tour a échoué ne se reprend pas (« No previous sessions found ») ni ne se recrée
// (« Session ID already exists ») : Gemini CLI sort avec 42 dans les deux cas.
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { metadataOnly, promptPayload } from './capture.mjs';
import { APPROVAL_MODES, runGemini } from './run-gemini.mjs';
import { uuidv7 } from './uuidv7.mjs';

/** Taille maximale d'un prompt : Gemini CLI lit au plus 8 Mo sur son entrée standard. */
export const MAX_PROMPT_BYTES = 8 * 1024 * 1024;
/** Taille maximale d'un instantané de fichier écrit par un outil. */
export const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const EDIT_TOOLS = new Set(['write_file', 'replace']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Refus d'un tour, avec un code stable pour l'interface et un message en français. */
export class TurnError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Contenu d'un fichier écrit par un outil, s'il est lisible, textuel et de taille raisonnable. */
export function readSnapshot(params, cwd, readFile = readFileSync, stat = statSync) {
  const p = params?.file_path ?? params?.absolute_path ?? params?.path;
  if (typeof p !== 'string' || !p) return null;
  const file = isAbsolute(p) ? p : resolve(cwd, p);
  try {
    const st = stat(file);
    if (!st.isFile() || st.size > MAX_SNAPSHOT_BYTES) return null;
    const buf = readFile(file);
    if (buf.includes(0)) return null; // binaire
    return { path: file, content: buf.toString('utf8') };
  } catch {
    return null;
  }
}

/**
 * @param {object} o
 * @param {import('better-sqlite3').Database} o.db
 * @param {ReturnType<import('./recorder.mjs').createRecorder>} o.rec
 * @param {ReturnType<import('./projector.mjs').createProjector>} o.proj
 * @param {ReturnType<import('./queries.mjs').createQueries>} o.queries
 * @param {string|null} o.entry          point d'entrée gemini.js (null : Gemini CLI introuvable)
 * @param {string|null} [o.engineVersion] version de Gemini CLI, journalisée avec chaque événement
 * @param {(v: unknown) => {value: unknown, count: number}} o.redact  masquage des secrets
 * @param {number} [o.maxConcurrent]     tours simultanés, tous projets confondus
 * @param {number} [o.maxHeapMb]         plafond du tas de Gemini CLI
 * @param {Function} [o.run]             lanceur (runGemini ; remplaçable dans les tests)
 */
export function createTurnManager({ rec, proj, queries, entry, engineVersion = null, redact, maxConcurrent = 1, maxHeapMb,
  run = runGemini }) {
  const running = new Map();   // conversationId -> tour en cours
  const ephemeral = new Map(); // conversationId -> { projectId, cwd, sessionId } : projets en capture « off »

  function resolveTarget({ conversationId, projectId }) {
    if (conversationId) {
      if (typeof conversationId !== 'string' || !UUID.test(conversationId)) throw new TurnError('invalid', 'conversationId invalide');
      if (running.has(conversationId)) throw new TurnError('busy', 'un tour est déjà en cours dans cette discussion');
      const off = ephemeral.get(conversationId);
      if (off) return { conversationId, project: queries.getProject(off.projectId), cwd: off.cwd, isNew: false };
      const conv = queries.getConversation(conversationId);
      if (!conv) {
        throw new TurnError('unknown_conversation', queries.conversationDeleted(conversationId)
          ? 'discussion supprimée' : 'discussion inconnue');
      }
      const project = conv.project_id ? queries.getProject(conv.project_id) : null;
      if (!project) throw new TurnError('unknown_project', 'la discussion n\'est rattachée à aucun projet du board');
      return { conversationId, project, cwd: conv.cwd ?? project.root_path, isNew: false };
    }
    if (!projectId) throw new TurnError('invalid', 'projectId requis pour une nouvelle discussion');
    const project = typeof projectId === 'string' ? queries.getProject(projectId) : null;
    if (!project) throw new TurnError('unknown_project', 'projet inconnu');
    return { conversationId: uuidv7(), project, cwd: project.root_path, isNew: true };
  }

  /**
   * Lance un tour. `listener` reçoit, dans l'ordre : les événements ({ type: 'event' }), puis
   * { type: 'turn.end' } ou { type: 'turn.error' }. Rend { conversationId, projectId, runId, resume, finished }
   * ou lève TurnError, sans rien avoir lancé ni journalisé.
   */
  function start({ conversationId, projectId, text, approvalMode = 'default', model } = {}, onMessage = () => {}) {
    // Un client parti (onglet fermé) ne doit pas interrompre le journal ni la projection du tour
    const listener = (msg) => { try { onMessage(msg); } catch { /* client injoignable */ } };
    if (typeof text !== 'string' || !text.trim()) throw new TurnError('invalid', 'texte du prompt vide');
    if (Buffer.byteLength(text) > MAX_PROMPT_BYTES) throw new TurnError('invalid', 'prompt de plus de 8 Mo : Gemini CLI ne le lirait pas en entier');
    if (!APPROVAL_MODES.includes(approvalMode)) throw new TurnError('invalid', `mode d'approbation inconnu : ${approvalMode}`);
    if (model !== undefined && model !== null && !(typeof model === 'string' && /^[\w.:\/-]{1,100}$/.test(model))) {
      throw new TurnError('invalid', 'nom de modèle invalide');
    }
    if (!entry) throw new TurnError('no_gemini', 'Gemini CLI introuvable : « npm install -g @google/gemini-cli », ou GEMINI_CLI_ENTRY');

    const target = resolveTarget({ conversationId, projectId });
    const { project, cwd } = target;
    if (!project.trusted) {
      throw new TurnError('untrusted', `dossier du projet « ${project.name} » non approuvé : l'approuver avant d'y lancer Gemini CLI`);
    }
    try {
      if (!statSync(cwd).isDirectory()) throw new Error();
    } catch {
      throw new TurnError('missing_dir', `dossier introuvable : ${cwd}`);
    }
    if (running.size >= maxConcurrent) {
      throw new TurnError('limit', `le board fait déjà tourner ${running.size} tour${running.size > 1 ? 's' : ''} (limite : ${maxConcurrent}) : réessayer à la fin`);
    }

    const id = target.conversationId;
    const capture = project.capture ?? 'full';
    const journaled = capture !== 'off';
    if (!journaled && target.isNew) ephemeral.set(id, { projectId: project.id, cwd, sessionId: null });
    // Session de Gemini CLI : la dernière qui a abouti, sinon une nouvelle (voir l'en-tête du fichier)
    const resumable = journaled ? queries.resumableSession(id) : (ephemeral.get(id)?.sessionId ?? null);
    const sessionId = resumable ?? randomUUID();
    const resume = Boolean(resumable);
    const runId = uuidv7();
    const pendingEdits = new Map(); // tool_id -> paramètres de write_file ou replace
    let resultSuccess = false;

    const onEvent = (event) => {
      const masked = redact(event);
      if (journaled) {
        const stored = capture === 'metadata' ? metadataOnly(masked.value) : masked.value;
        rec.event({ runId, sessionId, event: stored, engineVersion, redacted: masked.count > 0 });
      }
      if (event?.type === 'tool_use' && EDIT_TOOLS.has(event.tool_name) && event.tool_id) {
        pendingEdits.set(event.tool_id, event.parameters ?? {});
      } else if (event?.type === 'tool_result' && pendingEdits.has(event.tool_id)) {
        const params = pendingEdits.get(event.tool_id);
        pendingEdits.delete(event.tool_id);
        if (event.status === 'success' && capture === 'full') {
          const snap = readSnapshot(params, cwd);
          if (snap) {
            const content = redact(snap.content);
            rec.snapshot({ runId, sessionId, toolId: event.tool_id, path: snap.path, content: content.value, redacted: content.count > 0 });
          }
        }
      } else if (event?.type === 'result' && event.status === 'success') {
        resultSuccess = true;
      }
      listener({ type: 'event', conversationId: id, event: masked.value });
    };

    let handle;
    try {
      handle = run({ prompt: text, cwd, sessionId, resume, approvalMode, model: model ?? undefined, skipTrust: true, entry, maxHeapMb, onEvent });
    } catch (e) {
      if (!journaled && target.isNew) ephemeral.delete(id);
      throw new TurnError('spawn', `Gemini CLI n'a pas pu être lancé : ${e.message}`);
    }
    if (journaled) {
      // Synchrone : écrit avant le premier événement, qui n'arrive qu'au tour suivant de la boucle
      const masked = redact(text);
      try {
        rec.start({ runId, sessionId, conversationId: id, cwd, args: handle.args, pid: handle.pid ?? null, approvalMode, resume,
          engineVersion, payload: promptPayload(capture, { text: masked.value, approvalMode, resume }), redacted: masked.count > 0 });
      } catch (e) {
        handle.cancel(); // pas de tour hors du journal
        throw new TurnError('journal', `journal indisponible : ${e.message}`);
      }
    }

    const current = { runId, sessionId, handle, capture, journaled, cancelled: false };
    running.set(id, current);
    current.finished = handle.done.then(
      (r) => ({ code: r.code, signal: r.signal ?? null, meaning: r.meaning, stderr: r.stderr ?? '' }),
      (e) => ({ code: null, signal: null, meaning: null, stderr: e.message, failed: e.message }),
    ).then((r) => {
      if (journaled) {
        rec.end({ runId, code: r.code, stderr: redact(r.stderr).value });
        try { proj.projectPending(); } catch { /* la projection se refera au prochain démarrage */ }
      } else if (resultSuccess) {
        ephemeral.get(id).sessionId = sessionId; // désormais reprenable
      }
      running.delete(id);
      const turn = journaled ? queries.turnOfRun(runId) : null;
      const status = turn?.status ?? (resultSuccess ? 'completed' : current.cancelled ? 'cancelled' : 'error');
      const message = r.failed ? { type: 'turn.error', conversationId: id, runId, code: 'spawn', message: `Gemini CLI : ${r.failed}` }
        : { type: 'turn.end', conversationId: id, runId, code: r.code, meaning: r.meaning, status,
          errorMessage: turn?.error_message ?? null, inputTokens: turn?.input_tokens ?? null,
          outputTokens: turn?.output_tokens ?? null, durationMs: turn?.duration_ms ?? null };
      listener(message);
      return message;
    });

    return { conversationId: id, projectId: project.id, runId, sessionId, resume, capture, finished: current.finished };
  }

  /** Arrêt demandé par l'humain : journalisé (turn.cancel), puis processus arrêté. */
  function cancel(conversationId) {
    const current = running.get(conversationId);
    if (!current || current.cancelled) return false;
    current.cancelled = true;
    if (current.journaled) rec.cancel({ runId: current.runId, sessionId: current.sessionId });
    current.handle.cancel();
    return true;
  }

  /** Arrêt du serveur : chaque tour en cours est annulé, puis attendu (10 s au plus par tour). */
  async function closeAll() {
    const all = [...running.entries()];
    for (const [id] of all) cancel(id);
    await Promise.all(all.map(([, t]) => Promise.race([t.finished, new Promise((r) => setTimeout(r, 10000).unref())])));
  }

  return {
    start,
    cancel,
    closeAll,
    running: () => [...running.keys()],
    isRunning: (id) => running.has(id),
    limit: maxConcurrent,
  };
}
