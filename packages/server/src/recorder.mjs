// recorder.mjs : écrit les tours dans le journal brut (engine_run, event), sans rien projeter.
// Seul le serveur du board écrit : ce module est son unique point d'écriture du journal.

const now = () => new Date().toISOString();

export function createRecorder(db) {
  const insertRun = db.prepare(`INSERT INTO engine_run
      (id, engine_id, engine_version, channel, argv_json, cwd, pid, started_at)
    VALUES (@id, @engineId, @engineVersion, 'headless', @argv, @cwd, @pid, @startedAt)`);
  const endRun = db.prepare(`UPDATE engine_run SET ended_at = @endedAt, exit_code = @code, stderr_tail = @stderr
    WHERE id = @id`);
  const insertEvent = db.prepare(`INSERT INTO event
      (received_at, source, direction, type, engine_id, engine_version, engine_run_id, engine_session_id, payload_json, redacted)
    VALUES (@at, @source, @direction, @type, @engineId, @engineVersion, @runId, @sessionId, @payload, @redacted)`);
  const openRuns = db.prepare('SELECT id FROM engine_run WHERE ended_at IS NULL');
  const flag = (redacted) => (redacted ? 1 : 0); // masquage appliqué avant écriture (colonne event.redacted)

  return {
    /**
     * Début d'un tour : exécution et prompt envoyé (le prompt n'est jamais dans argv).
     * `sessionId` : session de Gemini CLI ; `conversationId` : discussion du board, qui peut changer de session
     * (sans lui, la discussion porte l'identifiant de la session, comme dans les journaux plus anciens).
     * `payload` remplace la charge par défaut ({ text, approvalMode, resume, conversation_id }) : capture metadata.
     */
    start({ runId, sessionId, conversationId, cwd, args = [], pid = null, prompt, approvalMode = 'default', resume = false,
      engineId = 'gemini-cli', engineVersion = null, startedAt = now(), payload, redacted = false }) {
      const body = payload ?? { text: prompt, approvalMode, resume };
      db.transaction(() => {
        insertRun.run({ id: runId, engineId, engineVersion, argv: JSON.stringify(['gemini', ...args]), cwd, pid, startedAt });
        insertEvent.run({ at: startedAt, source: 'headless', direction: 'out', type: 'prompt', engineId, engineVersion,
          runId, sessionId, payload: JSON.stringify(conversationId ? { ...body, conversation_id: conversationId } : body),
          redacted: flag(redacted) });
      })();
    },

    /** Un événement stream-json reçu, tel quel (ou masqué, ou réduit à sa forme : voir capture.mjs). */
    event({ runId, sessionId, event, engineId = 'gemini-cli', engineVersion = null, at = now(), redacted = false }) {
      insertEvent.run({ at, source: 'headless', direction: 'in', type: String(event?.type ?? 'raw'), engineId, engineVersion,
        runId, sessionId, payload: JSON.stringify(event), redacted: flag(redacted) });
    },

    /** Contenu d'un fichier relu après write_file ou replace : rend les artefacts rejouables. */
    snapshot({ runId, sessionId, toolId, path, content, at = now(), redacted = false }) {
      insertEvent.run({ at, source: 'board', direction: 'internal', type: 'artifact.snapshot', engineId: null,
        engineVersion: null, runId, sessionId, payload: JSON.stringify({ tool_id: toolId, path, content }), redacted: flag(redacted) });
    },

    /** Arrêt demandé par l'humain : fait foi même sans code 130 (Windows n'a pas de SIGINT). */
    cancel({ runId, sessionId, at = now() }) {
      insertEvent.run({ at, source: 'board', direction: 'internal', type: 'turn.cancel', engineId: null,
        engineVersion: null, runId, sessionId, payload: JSON.stringify({ by: 'human' }), redacted: 0 });
    },

    /** Fin du processus. */
    end({ runId, code, stderr = '', endedAt = now() }) {
      endRun.run({ id: runId, code, stderr: String(stderr).slice(-4096), endedAt });
    },

    /** Action de gestion (project.upsert, conversation.delete…). */
    board({ type, sessionId = null, payload = {}, at = now() }) {
      insertEvent.run({ at, source: 'board', direction: 'internal', type, engineId: null, engineVersion: null,
        runId: null, sessionId, payload: JSON.stringify(payload), redacted: 0 });
    },

    /** Au démarrage du serveur : clôt les tours restés ouverts après un arrêt brutal. */
    recoverOpenRuns({ at = now() } = {}) {
      const ids = openRuns.all().map((r) => r.id);
      for (const id of ids) endRun.run({ id, code: null, stderr: '[tour interrompu : arrêt du serveur]', endedAt: at });
      return ids;
    },
  };
}
